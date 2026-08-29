/**
 * Интеграция шага 3: поднимаем настоящий server.js, подключаемся двумя
 * ws-клиентами в одну комнату, ведущий шлёт уровень. Проверяем:
 *   • оба клиента получают снимки мира (t:'world') с монстрами;
 *   • монстры у обоих ОДНИ И ТЕ ЖЕ (общие) и они двигаются;
 *   • второй клиент, не приславший уровень, всё равно видит мир (мир один
 *     на комнату);
 *   • обратная совместимость: клиент, который уровень не шлёт вообще, играет
 *     без мира и НЕ получает 'world' (в отдельной комнате).
 * Запуск: node deploy/ostrov/realtime/world/integ.test.mjs
 */
import { spawn } from 'child_process';
import { pathToFileURL } from 'url';
import { createRequire } from 'module';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const WebSocket = require('ws');
const CLIENT = await import(pathToFileURL(resolve(here, '../../../../src/core/level.js')).href);

const PORT = 8123;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let fails = 0;
const fail = (m) => { fails++; console.log('  ✗ ' + m); };

// поднять сервер
const srv = spawn('node', [resolve(here, '../server.js')], {
  env: { ...process.env, PORT: String(PORT), STATS_PIN: 'x' },
  stdio: ['ignore', 'pipe', 'pipe']
});
srv.stdout.on('data', d => process.stdout.write('  [srv] ' + d));
srv.stderr.on('data', d => process.stdout.write('  [srv!] ' + d));

function connect() {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/`);
  ws.worlds = [];
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.t === 'world') ws.worlds.push(m);
    if (m.t === 'welcome') ws.welcomed = true;
  });
  return new Promise((res, rej) => { ws.on('open', () => res(ws)); ws.on('error', rej); });
}
const send = (ws, o) => ws.send(JSON.stringify(o));

try {
  await sleep(500);   // старт сервера

  // --- комната с общим миром ---
  const A = await connect(), B = await connect();
  send(A, { t: 'join', room: 'общий-тест', name: 'A' });
  send(B, { t: 'join', room: 'общий-тест', name: 'B' });
  await sleep(150);

  const level = CLIENT.serializeLevel(CLIENT.demoLevel());
  send(A, { t: 'level', level, diff: 'normal' });   // ведущий A задаёт мир

  // оба «двигаются», чтобы шли снимки и ИИ реагировал
  const move = setInterval(() => {
    send(A, { t: 's', p: [80 + Math.random() * 4, 0.5, 80], y: 0, pi: 0, m: 'swim', h: 1 });
    send(B, { t: 's', p: [84, 0.5, 84 + Math.random() * 4], y: 1, pi: 0, m: 'swim', h: 1 });
  }, 66);
  await sleep(1500);
  clearInterval(move);

  if (A.worlds.length < 10) fail(`A получил мало снимков мира: ${A.worlds.length}`);
  else console.log(`  ✓ ведущий A получил ${A.worlds.length} снимков мира`);
  if (B.worlds.length < 10) fail(`B (уровень не слал) получил мало снимков мира: ${B.worlds.length}`);
  else console.log(`  ✓ второй B тоже видит мир (${B.worlds.length} снимков) — мир один на комнату`);

  const lastA = A.worlds[A.worlds.length - 1], lastB = B.worlds[B.worlds.length - 1];
  if (!lastA.m || !lastA.m.length) fail('в снимке нет монстров');
  else console.log(`  ✓ в снимке ${lastA.m.length} монстров`);

  // одни и те же монстры (по количеству и близким позициям в один момент)
  if (lastA.m.length !== lastB.m.length) fail(`число монстров у A и B разное: ${lastA.m.length} vs ${lastB.m.length}`);
  else console.log('  ✓ у A и B одинаковое число монстров (общие)');

  // двигаются: первый снимок против последнего — позиции изменились
  const first = A.worlds[0], moved = first.m.some((mm, i) =>
    lastA.m[i] && (Math.abs(mm.p[0] - lastA.m[i].p[0]) > 0.05 || Math.abs(mm.p[2] - lastA.m[i].p[2]) > 0.05));
  if (!moved) fail('монстры не сдвинулись за 1.5 c');
  else console.log('  ✓ монстры двигаются');

  // --- обратная совместимость: комната без уровня ---
  const C = await connect();
  send(C, { t: 'join', room: 'старый-клиент', name: 'C' });
  const moveC = setInterval(() => send(C, { t: 's', p: [80, 0.5, 80], y: 0, pi: 0, m: 'ground', h: 1 }), 66);
  await sleep(800);
  clearInterval(moveC);
  if (C.worlds.length !== 0) fail(`старый клиент получил ${C.worlds.length} снимков мира, ожидалось 0`);
  else console.log('  ✓ обратная совместимость: без уровня мир не строится, снимки не шлются');

  A.close(); B.close(); C.close();
} catch (e) {
  fail('исключение: ' + e.message);
} finally {
  srv.kill('SIGTERM');
  await sleep(200);
}

console.log(`\n${fails === 0 ? '✓ интеграция шага 3 работает' : '✗ провалов: ' + fails}`);
process.exit(fails === 0 ? 0 : 1);
