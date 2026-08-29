/**
 * Регрессия геометрии: серверный world/level.js обязан считать пол, потолок,
 * проходимость и коллизии в точности как клиентский src/core/level.js. Если
 * этот тест краснеет — общие монстры на сервере пойдут по другой карте, чем
 * видит игрок. Запуск: node deploy/ostrov/realtime/world/geo.test.mjs
 */
import { pathToFileURL } from 'url';
import { createRequire } from 'module';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const CLIENT = await import(pathToFileURL(resolve(here, '../../../../src/core/level.js')).href);
const SRV = require('./level.js');

let fails = 0, checks = 0;
const approx = (a, b) => Math.abs(a - b) < 1e-6;

// Эталон — копия клиентского collectDeepCells (monsters.js), он там не
// экспортируется и тянет three.js. Считаем на клиентском LevelGrid.
function refDeep(level, grid, waterY, minDepth = 1.4) {
  const out = [], cs = grid.cs;
  for (let j = 0; j < level.h; j++) {
    for (let i = 0; i < level.w; i++) {
      if (!grid.isOpen(i, j)) continue;
      const x = (i + 0.5) * cs, z = (j + 0.5) * cs;
      const depth = waterY - grid.floorAt(x, z);
      if (depth > minDepth) out.push({ x, z, depth });
    }
  }
  return out;
}

for (const [name, mk] of [['demoLevel', CLIENT.demoLevel], ['demoLevelDeep', CLIENT.demoLevelDeep]]) {
  const lv = mk();
  const slv = SRV.deserializeLevel(CLIENT.serializeLevel(lv));
  const cg = new CLIENT.LevelGrid(lv), sg = new SRV.LevelGrid(slv);

  for (const f of ['t', 'f', 'c', 'o']) {
    for (let k = 0; k < lv[f].length; k++) { checks++; if (!approx(lv[f][k], slv[f][k])) fails++; }
  }
  const W = lv.w * lv.cell, H = lv.h * lv.cell;
  for (let n = 0; n < 4000; n++) {
    const x = (n * 97.13) % W, z = (n * 57.31) % H;
    checks += 2;
    if (!approx(cg.floorAt(x, z), sg.floorAt(x, z))) fails++;
    if (!approx(cg.ceilAt(x, z), sg.ceilAt(x, z))) fails++;
  }
  for (let j = 0; j < lv.h; j++) for (let i = 0; i < lv.w; i++) { checks++; if (cg.isOpen(i, j) !== sg.isOpen(i, j)) fails++; }
  for (let n = 0; n < 2000; n++) {
    const x = (n * 13.7) % W, z = (n * 29.3) % H, dx = ((n * 7) % 20 - 10) * 0.1, dz = ((n * 11) % 20 - 10) * 0.1;
    const a = cg.move(x, z, dx, dz, 0.4, 0), b = sg.move(x, z, dx, dz, 0.4, 0);
    checks++; if (!approx(a.x, b.x) || !approx(a.z, b.z)) fails++;
  }

  // глубокие клетки («чаша» сталкеров) — количество и содержимое
  const rd = refDeep(lv, cg, lv.waterY), sd = SRV.collectDeepCells(slv, sg, slv.waterY);
  checks++;
  if (rd.length !== sd.length) { fails++; console.log(`  [${name}] deep: ${rd.length} (клиент) != ${sd.length} (сервер)`); }
  else for (let k = 0; k < rd.length; k++) {
    checks++;
    if (!approx(rd[k].x, sd[k].x) || !approx(rd[k].z, sd[k].z) || !approx(rd[k].depth, sd[k].depth)) fails++;
  }
  console.log(`  [${name}] глубоких клеток: ${sd.length}, blockers: ${sg.blockers.length}`);
}
console.log(`Проверок: ${checks}, расхождений: ${fails}`);
console.log(fails === 0 ? '✓ серверная геометрия идентична клиентской' : '✗ расхождения');
process.exit(fails === 0 ? 0 : 1);
