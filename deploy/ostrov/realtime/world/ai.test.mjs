/**
 * Инварианты серверного ИИ монстров. Точные значения не проверяем (в ИИ есть
 * Math.random) — проверяем СВОЙСТВА, которые обязаны держаться всегда:
 *   • позиции конечны (не NaN/Infinity);
 *   • монстры не оказываются в стене (клетка проходима);
 *   • сталкеры держатся воды (глубина в их клетке не мельче порога);
 *   • ходоки стоят на полу своей клетки;
 *   • сведение walker+stalker убивает обоих и растит счётчик;
 *   • подбор артефакта возвращает игрока и уводит артефакт;
 *   • респавн восстанавливает поголовье.
 * Запуск: node deploy/ostrov/realtime/world/ai.test.mjs
 */
import { pathToFileURL } from 'url';
import { createRequire } from 'module';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const CLIENT = await import(pathToFileURL(resolve(here, '../../../../src/core/level.js')).href);
const SRV = require('./level.js');
const { World, EYE } = require('./monsters.js');

let fails = 0;
const fail = (m) => { fails++; console.log('  ✗ ' + m); };
const finite = (p) => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z);

// Игрок-заглушка: плавает по «восьмёрке» в пределах уровня, иногда ныряет.
function makeView(level) {
  const W = level.w * level.cell, H = level.h * level.cell;
  const v = { pos: { x: W * 0.5, y: level.waterY - 0.5, z: H * 0.5 }, eye: EYE, yaw: 0, vel: { x: 0, y: 0, z: 0 }, mode: 'swim' };
  let t = 0;
  v.tick = (dt) => {
    t += dt;
    const nx = W * 0.5 + Math.sin(t * 0.7) * W * 0.3;
    const nz = H * 0.5 + Math.sin(t * 0.9) * Math.cos(t * 0.5) * H * 0.3;
    v.vel.x = (nx - v.pos.x) / dt; v.vel.z = (nz - v.pos.z) / dt;
    v.pos.x = nx; v.pos.z = nz;
    v.pos.y = level.waterY - 0.5 - Math.sin(t) * 0.8;   // то под водой, то у поверхности
    v.yaw = Math.atan2(v.vel.x, v.vel.z);
  };
  return v;
}

for (const [name, mk] of [['demoLevel', CLIENT.demoLevel], ['demoLevelDeep', CLIENT.demoLevelDeep]]) {
  const lv = SRV.deserializeLevel(CLIENT.serializeLevel(mk()));
  const world = new World(lv, 'nightmare');       // максимум монстров
  const grid = world.grid;
  const view = makeView(lv);
  const startCount = world.list.length;
  console.log(`\n[${name}] монстров на старте: ${startCount} (walkers+stalkers), чаша: ${world.deep ? world.deep.length : 0}`);
  if (startCount === 0) fail(`${name}: не появилось ни одного монстра`);

  const dt = 1 / 15;
  // Инварианты РАЗНЫЕ по типу — ровно как в клиентском ИИ:
  //  ходок ходит через grid.move (проверяет isOpen) и стоит на полу клетки;
  //  сталкер движется напрямую с проверкой только глубины (isOpen не проверяет),
  //  поэтому его правило — «не мельче 0.9 и по высоте между дном и поверхностью».
  let posErrors = 0, walkerWall = 0, walkerFloor = 0, stalkerShallow = 0, stalkerY = 0;
  for (let step = 0; step < 900; step++) {          // 60 секунд
    view.tick(dt);
    world.step(dt, [view]);
    for (const c of world.list) {
      if (!finite(c.pos)) { posErrors++; continue; }
      if (c.kind === 'walker') {
        const i = Math.floor(c.pos.x / grid.cs), j = Math.floor(c.pos.z / grid.cs);
        if (!grid.isOpen(i, j)) walkerWall++;
        if (Math.abs(c.pos.y - grid.floorAt(c.pos.x, c.pos.z)) > 1e-6) walkerFloor++;
      } else {
        const floor = grid.floorAt(c.pos.x, c.pos.z);
        if (lv.waterY - floor < 0.9 - 1e-6) stalkerShallow++;
        if (c.pos.y < floor + 0.35 - 1e-4 || c.pos.y > lv.waterY - 0.35 + 1e-4) stalkerY++;
      }
    }
  }
  if (posErrors) fail(`${name}: ${posErrors} нечисловых позиций`);
  if (walkerWall) fail(`${name}: ходок ${walkerWall} раз в непроходимой клетке (move должен это исключать)`);
  if (walkerFloor) fail(`${name}: ходок ${walkerFloor} раз оторвался от пола`);
  if (stalkerShallow) fail(`${name}: сталкер ${stalkerShallow} раз зашёл на мель (<0.9)`);
  if (stalkerY) fail(`${name}: сталкер ${stalkerY} раз вышел за диапазон глубины по высоте`);
  if (!posErrors && !walkerWall && !walkerFloor && !stalkerShallow && !stalkerY)
    console.log(`  ✓ 900 тиков: позиции конечны; ходоки в проходах и на полу; сталкеры в воде и по глубине`);
}

// --- сведение walker+stalker ---
{
  const lv = SRV.deserializeLevel(CLIENT.serializeLevel(CLIENT.demoLevel()));
  const world = new World(lv, 'normal');
  const w = world.list.find(c => c.kind === 'walker');
  const s = world.list.find(c => c.kind === 'stalker');
  if (w && s) {
    s.pos.x = w.pos.x + 0.5; s.pos.z = w.pos.z; s.pos.y = w.pos.y;   // впритык
    const before = world.list.length, kbefore = world.kills;
    const view = { pos: { x: w.pos.x + 40, y: lv.waterY, z: w.pos.z }, eye: EYE, yaw: 0, vel: { x: 0, y: 0, z: 0 }, mode: 'swim' };
    const out = world.step(1 / 15, [view]);
    if (world.kills !== kbefore + 2) fail(`сведение: kills ${kbefore}→${world.kills}, ожидалось +2`);
    else if (world.list.length !== before - 2) fail(`сведение: список ${before}→${world.list.length}, ожидалось -2`);
    else if (!out.annihilate.length) fail('сведение: не было события annihilate');
    else console.log('\n[сведение] walker+stalker впритык → оба погибли, kills +2, событие есть ✓');
  } else fail('сведение: не нашлось пары walker+stalker');
}

// --- артефакт: подбор возвращает игрока и уводит артефакт ---
{
  const lv = SRV.deserializeLevel(CLIENT.serializeLevel(CLIENT.demoLevel()));
  const world = new World(lv, 'normal');
  if (!world.artifact.active) fail('артефакт: не разместился на старте');
  else {
    const a = world.artifact.pos;
    const view = { pos: { x: a.x, y: a.y - EYE * 0.5, z: a.z }, eye: EYE, yaw: 0, vel: { x: 0, y: 0, z: 0 }, mode: 'ground' };
    const out = world.step(1 / 15, [view]);
    if (out.artifact !== view) fail('артефакт: подбор не вернул игрока');
    else if (world.artifact.active) fail('артефакт: остался активным после подбора');
    else console.log('[артефакт] подход игрока → подбор вернул игрока, артефакт ушёл ✓');
  }
}

// --- респавн: убить всех, за respawn секунд поголовье восстанавливается ---
{
  const lv = SRV.deserializeLevel(CLIENT.serializeLevel(CLIENT.demoLevel()));
  const world = new World(lv, 'normal');
  const want = world.list.length;
  for (const c of world.list) world._kill(c);
  world.list = world.list.filter(c => !c.dead);
  if (world.list.length !== 0) fail('респавн: не удалось обнулить список');
  const view = { pos: { x: lv.spawn.x, y: lv.waterY, z: lv.spawn.z }, eye: EYE, yaw: 0, vel: { x: 0, y: 0, z: 0 }, mode: 'swim' };
  // респавн возвращает по одному раз в respawn секунд, а размещение ходока
  // (в стороне от игрока) иногда промахивается и тратит цикл — берём щедрый
  // запас времени, чтобы тест не зависел от случайных промахов.
  const secs = world.cfg.respawn * want * 4;
  for (let step = 0; step < 15 * secs; step++) world.step(1 / 15, [view]);
  if (world.list.length < want) fail(`респавн: восстановилось ${world.list.length} из ${want}`);
  else console.log(`[респавн] после гибели всех поголовье вернулось к ${world.list.length} (было ${want}) ✓`);
}

console.log(`\n${fails === 0 ? '✓ все инварианты держатся' : '✗ провалов: ' + fails}`);
process.exit(fails === 0 ? 0 : 1);
