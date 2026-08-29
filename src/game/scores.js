/**
 * Имя игрока, PIN и таблица результатов.
 *
 * Таблица общая и живёт на сервере (`/api/scores`). Если сервера нет — игра
 * открыта файлом с диска или запущена без API — всё сваливается на localStorage,
 * и таблица становится своей на устройстве. Игра от этого не ломается.
 *
 * PIN на четыре цифры закрепляет имя за игроком: сервер хранит только его хеш.
 * Это защита от того, чтобы чужим именем не подписались случайно, — не более:
 * счёт присылает клиент, и по HTTP без TLS PIN идёт открытым текстом.
 */

const LS_NAME = 'poolrooms.player';
const LS_PIN = 'poolrooms.pin';
const LS_TABLE = 'poolrooms.scores';
const API = '/api/scores';
const API_PING = '/api/ping';
const API_STATS = '/api/stats';
const API_PLAYERS = '/api/players';
const API_AUTH = '/api/auth';
const LS_STATS_PIN = 'poolrooms.statsPin';
const KEEP = 12;

export function playerName() { return (localStorage.getItem(LS_NAME) || '').trim(); }
export function playerPin() { return (localStorage.getItem(LS_PIN) || '').trim(); }

export function setPlayerName(v) {
  const name = String(v || '').trim().slice(0, 18);
  localStorage.setItem(LS_NAME, name);
  return name;
}

export function setPlayerPin(v) {
  const pin = String(v || '').replace(/\D/g, '').slice(0, 4);
  localStorage.setItem(LS_PIN, pin);
  return pin;
}

export function pinValid(pin = playerPin()) { return /^\d{4}$/.test(pin); }

function localTable() {
  try {
    const a = JSON.parse(localStorage.getItem(LS_TABLE) || '[]');
    return Array.isArray(a) ? a : [];
  } catch { return []; }
}

/**
 * Очки: за убитых больше всего, артефакты вдвое меньше, прожитые секунды —
 * мелкой добавкой, чтобы просто отсиживаться в углу было невыгодно.
 */
export function scoreOf(run) {
  return run.kills * 100 + run.artifacts * 50 + Math.floor(run.time);
}

/** Таблица с сервера; при неудаче — местная. Второе значение говорит, откуда. */
export async function fetchTable() {
  try {
    const r = await fetch(API, { cache: 'no-store' });
    if (!r.ok) throw new Error(r.status);
    const data = await r.json();
    if (Array.isArray(data.rows)) return { rows: data.rows, online: true };
  } catch (_) { /* сервера нет — не беда */ }
  return { rows: localTable(), online: false };
}

/**
 * Записать забег. Возвращает { score, place, rows, online, error }.
 * error === 'taken' — имя занято чужим PIN.
 */
export async function submit(run) {
  const name = playerName() || 'без имени';
  const score = scoreOf(run);
  const row = {
    name, score, kills: run.kills, artifacts: run.artifacts,
    time: Math.floor(run.time), diff: run.diff
  };

  try {
    const r = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...row, pin: playerPin() })
    });
    if (r.status === 403) return { score, place: 0, rows: localTable(), online: true, error: 'taken' };
    if (r.ok) {
      const data = await r.json();
      return { score, place: data.place || 0, rows: data.rows || [], online: true };
    }
  } catch (_) { /* уходим в местную таблицу */ }

  const rows = localTable();
  rows.push({ ...row, ts: Math.floor(Date.now() / 1000) });
  rows.sort((a, b) => b.score - a.score);
  const place = rows.findIndex(r => r.score === score && r.name === name) + 1;
  localStorage.setItem(LS_TABLE, JSON.stringify(rows.slice(0, KEEP)));
  return { score, place, rows: rows.slice(0, KEEP), online: false };
}

export function clearLocalTable() { localStorage.removeItem(LS_TABLE); }

const LS_ADMIN = 'poolrooms.admin';

/**
 * Очистка общей таблицы. Доступна только владельцу: сервер проверяет токен,
 * который задан у него в окружении контейнера. Токен запоминаем на устройстве,
 * чтобы не вводить каждый раз.
 */
export async function clearServerTable(token) {
  const t = String(token || localStorage.getItem(LS_ADMIN) || '').trim();
  if (!t) return { ok: false, error: 'no-token' };
  try {
    const r = await fetch(API, { method: 'DELETE', headers: { 'X-Admin-Token': t } });
    if (r.status === 403) { localStorage.removeItem(LS_ADMIN); return { ok: false, error: 'forbidden' }; }
    if (!r.ok) return { ok: false, error: 'http-' + r.status };
    localStorage.setItem(LS_ADMIN, t);
    return { ok: true };
  } catch (_) {
    return { ok: false, error: 'offline' };
  }
}

export function hasAdminToken() { return !!localStorage.getItem(LS_ADMIN); }

/** Случайный идентификатор вкладки — только чтобы считать одновременных игроков. */
function sessionId() {
  let sid = sessionStorage.getItem('poolrooms.sid');
  if (!sid) {
    sid = Math.random().toString(36).slice(2) + Date.now().toString(36);
    sessionStorage.setItem('poolrooms.sid', sid);
  }
  return sid;
}

/** Сигнал «я в игре». Сервер держит его в памяти около минуты. */
export async function ping() {
  try {
    await fetch(API_PING, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sid: sessionId(), name: playerName() || 'без имени' })
    });
  } catch (_) { /* без сервера просто молчим */ }
}

/** Кто уже зарегистрирован — чтобы человек выбрал себя, а не набирал заново. */
export async function fetchPlayers() {
  try {
    const r = await fetch(API_PLAYERS, { cache: 'no-store' });
    if (!r.ok) return [];
    const d = await r.json();
    return Array.isArray(d.players) ? d.players : [];
  } catch (_) { return []; }
}

/**
 * Вход. Свободное имя закрепляется за этим PIN, занятое — сверяется.
 * Возвращает { ok, registered, error }.
 */
export async function authenticate(name, pin) {
  const n = String(name || '').trim().slice(0, 18);
  const p = String(pin || '').replace(/\D/g, '');
  if (!n) return { ok: false, error: 'no-name' };
  if (!/^\d{4}$/.test(p)) return { ok: false, error: 'bad-pin' };
  try {
    const r = await fetch(API_AUTH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: n, pin: p })
    });
    if (r.status === 403) return { ok: false, error: 'wrong-pin' };
    if (r.status === 429) return { ok: false, error: 'too-many' };
    if (!r.ok) return { ok: false, error: 'http-' + r.status };
    const d = await r.json();
    setPlayerName(n);
    setPlayerPin(p);
    return { ok: true, registered: !!d.registered };
  } catch (_) {
    // Сервера нет — пускаем играть в одиночку: имя останется местным.
    setPlayerName(n);
    setPlayerPin(p);
    return { ok: true, offline: true };
  }
}

export function statsPin() { return localStorage.getItem(LS_STATS_PIN) || ''; }

/** Кто сейчас играет. Требует PIN — иначе список имён был бы публичным. */
export async function fetchStats(pin) {
  const p = String(pin || statsPin() || '').trim();
  if (!p) return { ok: false, error: 'no-pin' };
  try {
    const r = await fetch(API_STATS, { cache: 'no-store', headers: { 'X-Stats-Pin': p } });
    if (r.status === 403) { localStorage.removeItem(LS_STATS_PIN); return { ok: false, error: 'forbidden' }; }
    if (!r.ok) return { ok: false, error: 'http-' + r.status };
    localStorage.setItem(LS_STATS_PIN, p);
    return { ok: true, data: await r.json() };
  } catch (_) {
    return { ok: false, error: 'offline' };
  }
}

/** Разметка таблицы для меню и экрана смерти. */
export function renderTable(el, rows, { highlight = null, online = true } = {}) {
  if (!rows || !rows.length) {
    el.innerHTML = `<div class="empty">${online ? 'пока пусто — сыграйте забег'
      : 'сервер недоступен, таблица только на этом устройстве'}</div>`;
    return;
  }
  const mmss = (s) => `${(s / 60) | 0}:${String(s % 60).padStart(2, '0')}`;
  const head = online ? '' : '<div class="empty">сервер недоступен — показана местная таблица</div>';
  el.innerHTML = head + rows.map((r, i) => `
    <div class="srow${highlight != null && r.score === highlight ? ' me' : ''}">
      <span class="sn">${i + 1}</span>
      <span class="snm">${escapeHtml(r.name)}</span>
      <span class="ss">${r.score}</span>
      <span class="sd">${r.kills} уб · ${r.artifacts} арт · ${mmss(r.time)}</span>
    </div>`).join('');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
