/**
 * Сетевая игра POOLROOMS: комнаты ожидания и ретранслятор состояний.
 *
 * Сервер не решает про мир — он раздаёт, где кто находится, и держит лобби.
 * Монстры пока считаются у каждого свои. Это первый уровень из трёх: когда
 * понадобятся общие твари и общий артефакт, владение ими переедет сюда,
 * и транспорт менять не придётся.
 *
 * Комната — это название уровня. Ведущий — тот, кто вошёл первым; он может
 * начать, не дожидаясь всех шестерых. Ушёл ведущий — роль переходит следующему.
 * В уже начатую игру входят сразу, без ожидания.
 */
'use strict';
const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || 8000);
const MAX_PLAYERS = Number(process.env.MAX_PLAYERS || 6);
const TICK_MS = 66;          // ~15 рассылок в секунду, этого хватает с интерполяцией
const STALE_MS = 12000;      // молчит дольше — считаем, что отвалился
const NAME_MAX = 18;
const MAX_ROOMS = Number(process.env.MAX_ROOMS || 8);
// Простаивать вечно ни к чему: пусто дольше этого — выходим с кодом 0.
// Политика перезапуска on-failure тогда не поднимет обратно, и сервис лежит
// до ручного старта. Ноль — не гаснуть никогда.
// Гашение процесса по умолчанию выключено: без комнат он и так не тратит
// процессор, а поднимать его руками после выхода — лишняя морока.
const IDLE_EXIT_MIN = Number(process.env.IDLE_EXIT_MIN || 0);
// Пусто — выключатель заблокирован совсем (fail-safe): без пароля в окружении
// переключать сеть нельзя. Значение в .env на сервере, в коде его нет.
const STATS_PIN = process.env.STATS_PIN || '';
// Сколько доверенных прокси перед нами: реальный клиент — это TRUSTED_HOPS-й
// элемент X-Forwarded-For с конца. Нужен, чтобы лимит попыток пароля нельзя
// было обойти подставным заголовком.
const TRUSTED_HOPS = Math.max(1, Number(process.env.TRUSTED_HOPS || 2));

// Ограничение перебора пароля на /control: пароль короткий, поэтому без лимита
// его подобрали бы за минуты. Держим неудачные попытки по адресу за час.
const CONTROL_MAX_BAD = 20;
const controlBad = new Map();          // ip -> [timestamps]
function controlAttemptsOk(ip) {
  const now = Date.now();
  const q = (controlBad.get(ip) || []).filter((t) => now - t < 3600e3);
  if (q.length) controlBad.set(ip, q); else controlBad.delete(ip);
  return q.length < CONTROL_MAX_BAD;
}
function controlNoteBad(ip) {
  const q = (controlBad.get(ip) || []).filter((t) => Date.now() - t < 3600e3);
  q.push(Date.now());
  controlBad.set(ip, q);
}
function clientIp(req) {
  const parts = String(req.headers['x-forwarded-for'] || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length >= TRUSTED_HOPS) return parts[parts.length - TRUSTED_HOPS];
  return (req.socket && req.socket.remoteAddress) || '?';
}

// Логический выключатель из панели. Гасит не процесс, а саму возможность
// играть по сети: комнаты закрываются, новых не пускаем. Управлять Docker
// из веба намеренно не даём — для этого пришлось бы отдать контейнеру сокет
// демона, а это фактически root на машине.
let netOn = true;

/** @type {Map<string, {players: Map<number, object>, host: number, started: boolean}>} */
const rooms = new Map();
let nextId = 1;

/** Имя от клиента: выкидываем управляющие символы, режем длину. */
function clean(value, max) {
  const str = String(value == null ? '' : value);
  let out = '';
  for (const ch of str) if (ch.codePointAt(0) >= 32) out += ch;
  return out.trim().slice(0, max);
}

function num(v, lo, hi) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : 0;
}

/** Комната по имени. null — если новых заводить уже некуда. */
function roomOf(name) {
  if (!rooms.has(name)) {
    if (rooms.size >= MAX_ROOMS) return null;
    rooms.set(name, { players: new Map(), host: 0, started: false });
  }
  return rooms.get(name);
}

/** Что видят остальные в игре. Здоровье шлём, чтобы рисовать чужое состояние. */
function publicState(p) {
  return { id: p.id, name: p.name, p: p.pos, y: p.yaw, pi: p.pitch, m: p.mode, h: p.health };
}

function send(ws, obj) {
  if (ws.readyState === 1) {
    try { ws.send(JSON.stringify(obj)); } catch (_) { /* сокет уже закрыт */ }
  }
}

function lobbyState(room) {
  return {
    t: 'lobby',
    host: room.host,
    started: room.started,
    max: MAX_PLAYERS,
    players: [...room.players.values()].map(p => ({ id: p.id, name: p.name }))
  };
}

function broadcastLobby(room) {
  const msg = lobbyState(room);
  for (const p of room.players.values()) send(p.ws, msg);
}

const server = http.createServer((req, res) => {
  // маленький healthcheck: видно живость, заполненность и стадию комнат
  if (req.url === '/health') {
    const stat = {};
    for (const [name, r] of rooms) {
      stat[name] = { players: r.players.size, started: r.started };
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({
      ok: true, on: netOn, max: MAX_PLAYERS, maxRooms: MAX_ROOMS,
      idleExitMin: IDLE_EXIT_MIN, rooms: stat
    }));
  }
  if (req.url === '/control' && req.method === 'POST') {
    const ip = clientIp(req);
    if (!controlAttemptsOk(ip)) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      return res.end('{"error":"too many"}');
    }
    if (!STATS_PIN || req.headers['x-stats-pin'] !== STATS_PIN) {
      controlNoteBad(ip);
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end('{"error":"forbidden"}');
    }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 512) req.destroy(); });
    req.on('end', () => {
      let want = true;
      try { want = !!JSON.parse(body).on; } catch (_) { want = !netOn; }
      netOn = want;
      if (!netOn) {                       // выключили — распускаем всех
        for (const room of [...rooms.values()]) {
          for (const p of [...room.players.values()]) {
            send(p.ws, { t: 'off' });
            try { p.ws.close(); } catch (_) { /* уже закрыт */ }
          }
        }
        rooms.clear();
        stopTickIfEmpty();
      }
      console.log('сетевая игра ' + (netOn ? 'включена' : 'выключена') + ' из панели');
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, on: netOn }));
    });
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server, maxPayload: 4096 });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.player = null;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (_) { return; }
    if (!msg || typeof msg !== 'object') return;

    if (msg.t === 'join') {
      if (ws.player) return;
      if (!netOn) {
        send(ws, { t: 'off' });
        ws.close();
        return;
      }
      const roomName = clean(msg.room, 40) || 'общий';
      const room = roomOf(roomName);
      if (!room) {
        send(ws, { t: 'noroom', maxRooms: MAX_ROOMS });
        ws.close();
        return;
      }
      if (room.players.size >= MAX_PLAYERS) {
        send(ws, { t: 'full', max: MAX_PLAYERS });
        ws.close();
        return;
      }
      const p = {
        id: nextId++,
        name: clean(msg.name, NAME_MAX) || 'без имени',
        room: roomName,
        pos: [0, 0, 0], yaw: 0, pitch: 0, mode: 'ground', health: 1,
        seen: Date.now(), ws
      };
      ws.player = p;
      room.players.set(p.id, p);
      if (!room.host) room.host = p.id;          // первый вошедший ведёт
      send(ws, {
        t: 'welcome', id: p.id, max: MAX_PLAYERS,
        host: room.host, started: room.started,
        players: [...room.players.values()].filter(o => o.id !== p.id).map(publicState)
      });
      broadcastLobby(room);
      ensureTick();
      return;
    }

    if (!ws.player) return;
    const room = rooms.get(ws.player.room);
    if (!room) return;

    if (msg.t === 'start') {
      // начать может только ведущий, и только один раз
      if (ws.player.id !== room.host || room.started) return;
      room.started = true;
      broadcastLobby(room);
      return;
    }

    if (msg.t === 's') {                          // состояние игрока
      const p = ws.player;
      const a = Array.isArray(msg.p) ? msg.p : [0, 0, 0];
      p.pos = [num(a[0], -1e4, 1e4), num(a[1], -1e4, 1e4), num(a[2], -1e4, 1e4)];
      p.yaw = num(msg.y, -1e4, 1e4);
      p.pitch = num(msg.pi, -3.2, 3.2);
      p.mode = clean(msg.m, 8);
      p.health = num(msg.h, 0, 1);
      p.seen = Date.now();
    }
  });

  ws.on('close', () => drop(ws));
  ws.on('error', () => drop(ws));
});

function drop(ws) {
  const p = ws.player;
  if (!p) return;
  ws.player = null;
  const room = rooms.get(p.room);
  if (!room) return;
  room.players.delete(p.id);
  if (!room.players.size) {
    rooms.delete(p.room);                        // пустая комната забывается целиком
    stopTickIfEmpty();
    return;
  }
  if (room.host === p.id) {
    // ведущий ушёл — роль достаётся тому, кто вошёл следующим
    room.host = room.players.keys().next().value;
  }
  for (const o of room.players.values()) send(o.ws, { t: 'left', id: p.id });
  broadcastLobby(room);
}

let tickTimer = null;
let lastActive = Date.now();

/** Пока комнат нет, таймер рассылки не заводим: вхолостую он будил процесс
 *  пятнадцать раз в секунду и давал заметные доли процента на пустом сервере. */
function ensureTick() {
  lastActive = Date.now();
  if (!tickTimer && rooms.size) tickTimer = setInterval(tick, TICK_MS);
}
function stopTickIfEmpty() {
  if (tickTimer && !rooms.size) { clearInterval(tickTimer); tickTimer = null; }
}

// рассылка: каждому — все остальные в его комнате
function tick() {
  const now = Date.now();
  for (const room of [...rooms.values()]) {
    for (const p of [...room.players.values()]) {
      if (now - p.seen > STALE_MS) {
        try { p.ws.close(); } catch (_) { /* уже закрыт */ }
        drop(p.ws);
      }
    }
    const all = [...room.players.values()];
    for (const p of all) {
      send(p.ws, { t: 'w', players: all.filter(o => o.id !== p.id).map(publicState) });
    }
  }
  stopTickIfEmpty();
}

// пинг: без него мёртвые сокеты висят в комнате и занимают место
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { drop(ws); ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch (_) { /* закрывается */ }
  }
}, 15000);

// Самогашение: пусто дольше IDLE_EXIT_MIN — выходим начисто.
if (IDLE_EXIT_MIN > 0) {
  setInterval(() => {
    if (rooms.size) { lastActive = Date.now(); return; }
    if (Date.now() - lastActive > IDLE_EXIT_MIN * 60000) {
      console.log(`простой ${IDLE_EXIT_MIN} мин — гашусь`);
      process.exit(0);
    }
    // Проверяем чаще самого порога: при шаге в минуту гашение опаздывало
    // почти вдвое — попадало только на вторую проверку.
  }, 20000).unref();
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`realtime на :${PORT}, до ${MAX_PLAYERS} игроков в комнате, `
    + `комнат не больше ${MAX_ROOMS}, гашение по простою: `
    + (IDLE_EXIT_MIN ? IDLE_EXIT_MIN + ' мин' : 'выключено'));
});
