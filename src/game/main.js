import { Engine } from '../core/engine.js';
import { Player } from './player.js';
import { Ambience } from './audio.js';
import { DevPanel } from './devpanel.js';
import { TouchControls, coarsePointer } from './touch.js';
import { Monsters, DIFFICULTY } from './monsters.js';
import { Gyro } from './gyro.js';
import { Net, colorHex } from './net.js';
import { playerName, playerPin, setPlayerName, setPlayerPin, pinValid,
         submit, fetchTable, renderTable, clearLocalTable,
         clearServerTable, hasAdminToken, ping, fetchStats, statsPin,
         fetchPlayers, authenticate } from './scores.js';
import { demoLevel, demoLevelDeep, deserializeLevel } from '../core/level.js';
import { QUALITY_PRESETS } from '../core/quality.js';
import { ENV_PRESETS } from '../core/env.js';

const $ = (id) => document.getElementById(id);
const LS_QUALITY = 'poolrooms.quality';
const LS_SENS = 'poolrooms.sens';
const LS_VOL = 'poolrooms.volume';
const LS_MUSIC = 'poolrooms.music';
const LS_SLOTS = 'poolrooms.levels';
const LS_PLAY = 'poolrooms.playLevel';
const LS_MONSTERS = 'poolrooms.monsters';
const LS_DIFF = 'poolrooms.difficulty';
const LS_GYRO = 'poolrooms.gyro';
const LS_NET = 'poolrooms.net';

let syncRanges = () => { };

const state = {
  engine: null,
  player: null,
  audio: new Ambience(),
  running: false,
  paused: true,
  locked: false,
  dragLook: false,
  lockFailed: false,
  devOpen: false,
  dev: null,
  lastT: 0,
  fpsAccum: 0, fpsFrames: 0, fps: 0,
  fade: 0,
  // адаптивное разрешение
  adaptive: true,
  adaptAccum: 0, adaptFrames: 0, adaptCooldown: 0, adaptScale: 1,
  // режим обнаружения
  revealLeft: 0,
  // текущий забег
  runTime: 0, runArtifacts: 0
};

// целевое время кадра: держим ~60 fps, реагируем только на устойчивое отклонение
const FRAME_TARGET = 1 / 58;
const FRAME_GOOD = 1 / 75;
const SCALE_STEPS = [1, 0.9, 0.8, 0.72, 0.64, 0.56, 0.5];

function detectQuality() {
  const saved = localStorage.getItem(LS_QUALITY);
  if (saved && QUALITY_PRESETS[saved]) return saved;
  // телефон: планарные отражения и объёмный свет там не вытягиваются,
  // а deviceMemory в Safari не отдаётся и эвристика ниже промахивается на «среднее»
  if (coarsePointer()) return 'low';
  const mem = navigator.deviceMemory || 4;
  const cores = navigator.hardwareConcurrency || 4;
  if (mem >= 8 && cores >= 8) return 'high';
  if (mem >= 4 && cores >= 4) return 'medium';
  return 'low';
}

function savedSlots() {
  try { return JSON.parse(localStorage.getItem(LS_SLOTS) || '{}'); } catch { return {}; }
}

// ---------------------------------------------------------------- запуск

async function boot() {
  const canvas = $('c');
  const qualityKey = detectQuality();

  let engine;
  try {
    engine = new Engine(canvas, qualityKey);
  } catch (e) {
    $('loading').innerHTML = `<div class="err"><h2>Не удалось запустить WebGL</h2><p>${e.message}</p>
      <p>Проверьте, что в браузере включено аппаратное ускорение.</p></div>`;
    return;
  }
  state.engine = engine;
  state.player = new Player(engine);
  state.player.sensitivity = parseFloat(localStorage.getItem(LS_SENS) || '0.0022');
  state.audio.setVolume(parseFloat(localStorage.getItem(LS_VOL) || '0.7'));
  // На телефоне динамик слабее и трек тонет — стартовая громкость там выше.
  // Сохранённое значение, если оно есть, всегда важнее.
  const musicDefault = coarsePointer() ? 0.55 : 0.22;
  state.audio.musicVolume = parseFloat(localStorage.getItem(LS_MUSIC) || String(musicDefault));

  state.player.events.step = (m, s) => state.audio.step(m, s);
  state.player.events.splash = (p) => state.audio.splash(p);
  state.player.events.dive = () => state.audio.dive();
  state.player.events.surface = () => state.audio.surface();

  state.dev = new DevPanel(state);
  state.monsters = new Monsters(engine);
  state.monsters.enabled = localStorage.getItem(LS_MONSTERS) !== '0';
  state.monsters.difficulty = localStorage.getItem(LS_DIFF) || 'normal';
  state.monsters.events.growl = (p) => state.audio.growl(p);
  state.monsters.events.splash = (p) => state.audio.splash(p);
  state.monsters.events.pickup = () => state.audio.drip();
  state.monsters.events.hit = () => state.audio.step('ground', true);
  state.monsters.events.artifact = (n) => { state.runArtifacts++; state.audio.surface(); flashHint(`артефакт найден · зарядов ${n}`); };
  applyDifficulty();
  state.gyro = new Gyro();
  state.net = new Net(engine);
  state.touch = new TouchControls(state);
  state.onPause = () => pauseGame();
  state.onThrow = () => throwLure();
  state.onReveal = () => pulseReveal();
  // тап по левой зоне — прыжок/всплытие: короткий импульс, как нажатие клавиши
  state.onTapJump = () => {
    if (!state.running) return;
    state.player.btn.jump = true;
    setTimeout(() => { state.player.btn.jump = false; }, 90);
  };
  if (coarsePointer()) state.touch.enable();

  buildMenu();
  resize();
  window.addEventListener('resize', resize);
  window.visualViewport?.addEventListener('resize', resize);
  window.addEventListener('orientationchange', () => setTimeout(resize, 120));
  watchContextLoss(canvas);

  // уровень: из редактора («играть») либо демо
  let level = null;
  const handoff = sessionStorage.getItem(LS_PLAY);
  if (handoff) {
    sessionStorage.removeItem(LS_PLAY);
    try { level = deserializeLevel(handoff); } catch { level = null; }
  }
  await loadLevel(level || demoLevel());

  $('loading').classList.add('hidden');
  if (playerName() && pinValid()) openMenu();
  else openIdent();
  requestAnimationFrame(loop);
}

async function loadLevel(level) {
  const e = state.engine;
  $('loading').classList.remove('hidden');
  $('loadingText').textContent = 'Сборка геометрии…';
  await new Promise(r => setTimeout(r, 16));
  e.loadLevel(level);
  state.player.spawnFrom(level);
  state.monsters.build(level);
  if (state.net?.enabled) state.net.connect(level.name, playerName() || 'без имени');
  $('levelName').textContent = level.name;
  // прогрев шейдеров, чтобы не было фризов на первых кадрах
  $('loadingText').textContent = 'Компиляция шейдеров…';
  await new Promise(r => setTimeout(r, 16));
  try { e.renderer.compile(e.scene, e.camera); } catch (_) { }
  e.render();
  $('loading').classList.add('hidden');
}

/**
 * Android любит забрать контекст WebGL, когда приложение уходит в фон или
 * системе не хватает памяти. three.js сам сцену не восстанавливает — без этого
 * человек возвращается в игру и видит чёрный экран. Показываем понятное
 * сообщение и перезагружаем страницу, а не оставляем в недоумении.
 */
function watchContextLoss(canvas) {
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    state.running = false;
    state.paused = true;
    state.touch?.hide();
    $('loading').classList.remove('hidden');
    $('loadingText').textContent = 'Графика перезапускается…';
  });
  canvas.addEventListener('webglcontextrestored', () => {
    // Полное восстановление сцены здесь ненадёжно: проще перезагрузить страницу,
    // уровень и настройки всё равно лежат в хранилище.
    location.reload();
  });
}

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  state.engine.resize(w, h);
}

// ---------------------------------------------------------------- меню

function buildMenu() {
  const qs = $('qualitySel');
  for (const [k, v] of Object.entries(QUALITY_PRESETS)) {
    const o = document.createElement('option');
    o.value = k; o.textContent = v.name;
    qs.appendChild(o);
  }
  qs.value = state.engine.qualityKey;
  qs.addEventListener('change', () => {
    localStorage.setItem(LS_QUALITY, qs.value);
    $('loading').classList.remove('hidden');
    $('loadingText').textContent = 'Пересборка рендера…';
    setTimeout(() => {
      state.engine.setQuality(qs.value);
      resize();
      state.engine.render();
      $('loading').classList.add('hidden');
    }, 30);
  });

  const sens = $('sensRange');
  sens.value = String(state.player.sensitivity * 1000);
  $('sensVal').textContent = (state.player.sensitivity * 1000).toFixed(1);
  sens.addEventListener('input', () => {
    state.player.sensitivity = parseFloat(sens.value) / 1000;
    $('sensVal').textContent = parseFloat(sens.value).toFixed(1);
    localStorage.setItem(LS_SENS, String(state.player.sensitivity));
  });

  const adapt = $('adaptChk');
  adapt.checked = localStorage.getItem('poolrooms.adaptive') !== '0';
  state.adaptive = adapt.checked;
  adapt.addEventListener('change', () => {
    state.adaptive = adapt.checked;
    localStorage.setItem('poolrooms.adaptive', adapt.checked ? '1' : '0');
    if (!adapt.checked) { state.adaptScale = 1; state.engine.setDynamicScale(1); }
  });

  const net = $('netChk');
  net.checked = localStorage.getItem(LS_NET) === '1';
  const netApply = () => {
    localStorage.setItem(LS_NET, net.checked ? '1' : '0');
    if (net.checked) {
      // комната — это уровень: в разных уровнях друг друга не видно
      state.net.connect(state.engine.level?.name || 'общий', playerName() || 'без имени');
    } else state.net.disconnect();
  };
  net.addEventListener('change', netApply);
  state.net.events.full = (max, why) => {
    net.checked = false;
    flashHint(why === 'off' ? 'сетевая игра выключена на сервере'
      : why === 'noroom' ? 'все комнаты заняты' : `мест нет, максимум ${max}`);
  };
  if (net.checked) netApply();
  setInterval(() => {
    const el = $('netState');
    if (el) el.textContent = state.net.enabled
      ? `${state.net.status} · ${state.net.count || 1} из ${state.net.max}`
      : 'выключена';
  }, 700);

  const mon = $('monsterChk');
  mon.checked = state.monsters.enabled;
  mon.addEventListener('change', () => {
    localStorage.setItem(LS_MONSTERS, mon.checked ? '1' : '0');
    state.monsters.setEnabled(mon.checked);   // сам соберёт, если ещё не собирал
  });

  const nameInput = $('nameInput'), pinInput = $('pinInput');
  nameInput.value = playerName();
  pinInput.value = playerPin();
  nameInput.addEventListener('change', () => { nameInput.value = setPlayerName(nameInput.value); });
  pinInput.addEventListener('input', () => { pinInput.value = setPlayerPin(pinInput.value); });

  // Предупреждение про открытый PIN уместно только без TLS. На https оно врёт,
  // поэтому текст выбирается по фактическому протоколу страницы.
  $('pinNote').innerHTML = location.protocol === 'https:'
    ? 'Пароль закрепляет имя за вами. Соединение защищено, но это всё же не пароль от чего-то важного.'
    : 'Пароль закрепляет имя за вами. Он идёт по обычному HTTP — <b>не используйте цифры,'
      + ' которыми что-то открываете в жизни</b>.';

  refreshScoreTable();

  const sp = $('statsPin');
  sp.value = statsPin();
  sp.addEventListener('input', () => {
    sp.value = sp.value.replace(/\D/g, '').slice(0, 6);
    if (sp.value.length >= 4) refreshStats(sp.value);
  });
  if (statsPin()) refreshStats();
  // пока меню открыто, обновляем список играющих
  setInterval(() => {
    if (!$('menu').classList.contains('hidden') && statsPin()) refreshStats();
  }, 15000);

  $('btnClearScores').addEventListener('click', async () => {
    const token = hasAdminToken() ? null : prompt('Токен владельца для очистки общей таблицы:');
    if (!hasAdminToken() && !token) return;
    const res = await clearServerTable(token);
    if (res.ok) { clearLocalTable(); flashHint('таблица очищена'); }
    else if (res.error === 'forbidden') flashHint('токен не подошёл');
    else if (res.error === 'offline') { clearLocalTable(); flashHint('сервер недоступен — очищена местная'); }
    else flashHint('не вышло: ' + res.error);
    refreshScoreTable();
  });

  const diff = $('diffSel');
  for (const [k, v] of Object.entries(DIFFICULTY)) {
    const o = document.createElement('option');
    o.value = k; o.textContent = v.name;
    diff.appendChild(o);
  }
  diff.value = state.monsters.difficulty;
  diff.addEventListener('change', () => {
    localStorage.setItem(LS_DIFF, diff.value);
    state.monsters.setDifficulty(diff.value);
    applyDifficulty();
    state.player.health = 1; state.player.oxygen = 1;
  });

  const vol = $('volRange');
  vol.value = String(state.audio.volume * 100);
  vol.addEventListener('input', () => {
    const v = parseFloat(vol.value) / 100;
    state.audio.setVolume(v);
    localStorage.setItem(LS_VOL, String(v));
  });

  // Что с музыкой прямо сейчас — чтобы с телефона было видно, где она встала
  const MUSIC_STATE = {
    off: 'не запущена', loading: 'загружается',
    element: 'играет', buffer: 'играет (запасной путь)',
    'ждёт касания': 'нажмите на экран'
  };
  setInterval(() => {
    const el = $('musicState');
    if (!el) return;
    const st = state.audio.musicStatus;
    el.textContent = MUSIC_STATE[st] || st || '—';
  }, 1000);

  const mus = $('musicRange');
  mus.value = String(state.audio.musicVolume * 100);
  mus.addEventListener('input', () => {
    const v = parseFloat(mus.value) / 100;
    state.audio.setMusicVolume(v);
    localStorage.setItem(LS_MUSIC, String(v));
  });

  // Те же настройки продублированы на экране паузы: до них один тап кнопкой
  // сверху справа, не выходя в меню. Ползунок паузы не заводит свою логику,
  // а передаёт значение «главному» — так поведение остаётся ровно одно.
  const mirror = (aId, bId) => {
    const a = $(aId), b = $(bId);
    if (!a || !b) return null;
    b.min = a.min; b.max = a.max; b.step = a.step; b.value = a.value;
    b.addEventListener('input', () => {
      a.value = b.value;
      a.dispatchEvent(new Event('input'));
    });
    a.addEventListener('input', () => { b.value = a.value; });
    return () => { b.value = a.value; };
  };
  // Гироскоп показываем на телефоне и планшете. Если браузер не отдал датчик —
  // строку всё равно показываем, но с объяснением: по обычному http интерфейса
  // DeviceOrientation попросту нет, и молчаливо спрятанная строка сбивает с толку.
  const gyroOK = Gyro.supported();
  if (coarsePointer()) document.body.classList.add('hasgyro');
  const gyroBtns = ['gyroBtn', 'gyroBtn2'].map(id => $(id)).filter(Boolean);
  const paintGyro = () => {
    const on = state.gyro.active;
    gyroBtns.forEach(b => { b.textContent = on ? 'Выключить' : 'Включить'; });
  };
  // Именно click, а не change: iOS отдаёт датчик только по настоящему нажатию,
  // и запрос должен уйти синхронно, до первого await.
  let gyroBusy = false;
  const toggleGyro = async () => {
    // Восстановление из прошлой сессии асинхронное; без этого замка нажатие
    // могло разойтись с ним и оставить кнопку в одном состоянии, а датчик в другом.
    if (gyroBusy) return;
    gyroBusy = true;
    // Немедленный отклик: без него отказ iOS выглядит как мёртвая кнопка.
    const stEl = $('gyroState');
    if (stEl && !state.gyro.active) stEl.textContent = 'запрашиваю доступ…';
    try {
    if (state.gyro.active) {
      state.gyro.disable();
      localStorage.setItem(LS_GYRO, '0');
    } else {
      const ok = await state.gyro.enable();
      localStorage.setItem(LS_GYRO, ok ? '1' : '0');
      if (!ok) {
        flashHint(state.gyro.status);
        if (stEl) stEl.textContent = state.gyro.status;
      }
    }
    } finally { gyroBusy = false; }
    paintGyro();
  };
  gyroBtns.forEach(b => b.addEventListener('click', toggleGyro));
  paintGyro();
  if (!gyroOK) {
    gyroBtns.forEach(b => { b.disabled = true; b.style.opacity = '0.45'; });
    const why = window.isSecureContext
      ? 'браузер не даёт датчик положения'
      : 'нужен защищённый адрес: откройте https://poolrooms.ostrov-vezeniya.ru';
    const el = $('gyroState');
    if (el) el.textContent = why;
  }
  // Сами не включаем: iOS отдаёт датчик только по живому нажатию, а не при
  // загрузке страницы. На Android разрешение не нужно — там можно вернуть.
  if (localStorage.getItem(LS_GYRO) === '1' && !Gyro.needsPermission()) {
    gyroBusy = true;
    state.gyro.enable().finally(() => { gyroBusy = false; paintGyro(); });
  }
  if (gyroOK) setInterval(() => {
    const el = $('gyroState');
    if (!el) return;
    el.textContent = state.gyro.report();
    el.classList.toggle('on', state.gyro.status === 'работает');
  }, 400);

  const mirrors = [
    mirror('volRange', 'volRange2'),
    mirror('musicRange', 'musicRange2'),
    mirror('sensRange', 'sensRange2')
  ].filter(Boolean);
  syncRanges = () => mirrors.forEach(f => f());

  refreshLevelList();

  $('btnPlay').addEventListener('click', () => playPressed());
  $('btnResume').addEventListener('click', () => startGame());
  $('btnStart').addEventListener('click', () => state.net.start());
  $('btnLeaveLobby').addEventListener('click', () => {
    $('lobby').classList.add('hidden');
    $('menu').classList.remove('hidden');
    net.checked = false;
    netApply();
  });
  state.net.events.lobby = () => drawLobby();
  $('btnMenu').addEventListener('click', () => {
    document.exitPointerLock?.();
    $('pause').classList.add('hidden');
    $('lobby').classList.add('hidden');
    $('more').classList.add('hidden');
    $('menu').classList.remove('hidden');
  });
  $('btnEditor').addEventListener('click', () => { window.location.href = 'editor.html'; });
  $('btnServer').addEventListener('click', () => { window.open('server.html', '_blank'); });
  $('btnMore').addEventListener('click', () => {
    $('menu').classList.add('hidden');
    $('more').classList.remove('hidden');
    syncRanges();
  });
  $('btnMoreBack').addEventListener('click', () => {
    $('more').classList.add('hidden');
    $('menu').classList.remove('hidden');
  });
  $('identGo').addEventListener('click', identSubmit);
  $('tabKnown').addEventListener('click', () => setIdentTab('known'));
  $('tabNew').addEventListener('click', () => setIdentTab('new'));
  $('tabPlayers').addEventListener('click', () => setRosterTab('players'));
  $('tabScores').addEventListener('click', () => setRosterTab('scores'));
  $('identPin').addEventListener('keydown', (e) => { if (e.key === 'Enter') identSubmit(); });
  $('identPin').addEventListener('input', () => {
    $('identPin').value = $('identPin').value.replace(/\D/g, '').slice(0, 4);
  });
  // Выход с экрана знакомства есть только у того, кто уже вошёл: он пришёл сюда
  // сменить игрока и вправе передумать. Новичку уходить некуда — играть без
  // имени больше нельзя, иначе он не попадёт ни в таблицу, ни в сетевую игру.
  $('identCancel').addEventListener('click', () => {
    if (playerName() && pinValid()) openMenu();
  });
  $('btnChangeUser').addEventListener('click', () => openIdent());
  $('btnEditor2').addEventListener('click', () => { window.location.href = 'editor.html'; });
  // клик по фону паузы тоже возвращает в игру
  $('pause').addEventListener('mousedown', (e) => { if (e.target === $('pause')) startGame(); });
  const wake = (e) => { e.preventDefault(); respawn(); startGame(); };
  $('dead').addEventListener('mousedown', wake);
  $('dead').addEventListener('touchstart', wake, { passive: false });

  $('fileInput').addEventListener('change', async (ev) => {
    const f = ev.target.files[0];
    if (!f) return;
    try {
      const lv = deserializeLevel(await f.text());
      await loadLevel(lv);
    } catch (e) { alert('Не удалось прочитать уровень: ' + e.message); }
    ev.target.value = '';
  });

  // ---- обзор мышью ----
  // Основной способ — захват указателя. Он может не сработать (отказ браузера,
  // повторный запрос сразу после выхода), поэтому есть запасной: тянуть ЛКМ.
  const canvas = $('c');

  document.addEventListener('pointerlockchange', () => {
    const locked = document.pointerLockElement === canvas || document.pointerLockElement === document.body;
    state.locked = locked;
    state.player.enabled = locked || state.dragLook;
    if (locked) $('lockHint').classList.add('hidden');
    // панель настроек намеренно отпускает захват — тогда паузу не ставим
    if (!locked && state.running && !state.dragLook && !state.devOpen) pauseGame();
  });

  document.addEventListener('pointerlockerror', () => {
    // захват не дали — играем в режиме перетаскивания
    state.lockFailed = true;
    $('lockHint').classList.remove('hidden');
  });

  const startDrag = (e) => {
    if (!state.running || e.button !== 0) return;
    if (state.locked) return;
    state.dragLook = true;
    state.player.enabled = true;
    requestLock();                       // ещё одна попытка — уже по клику
  };
  const endDrag = () => {
    if (!state.dragLook) return;
    state.dragLook = false;
    state.player.enabled = state.locked;
  };
  canvas.addEventListener('mousedown', (e) => {
    // при захвате указателя левая кнопка свободна — она и бросает
    if (e.button === 0 && state.running && state.locked) throwLure();
  });
  canvas.addEventListener('mousedown', startDrag);
  window.addEventListener('mouseup', endDrag);
  canvas.addEventListener('mouseleave', endDrag);

  document.addEventListener('mousemove', (e) => {
    if (!state.player.enabled) return;
    // при захвате движение приходит в movementX/Y; при перетаскивании — тоже
    state.player.onMouseMove(e.movementX || 0, e.movementY || 0);
  });

  // сенсорный ввод живёт в touch.js; здесь только обратный переход:
  // взялись за настоящую мышь — убираем экранные кнопки
  window.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'mouse' && state.touch.enabled) state.touch.disable();
  });

  window.addEventListener('keydown', (e) => {
    if (e.code === 'Escape') { if (state.running) pauseGame(); return; }
    if (e.code === 'F1') { e.preventDefault(); $('hud').classList.toggle('minimal'); return; }
    if (e.code === 'F2') { e.preventDefault(); takeScreenshot(); return; }
    if (e.code === 'F3') { e.preventDefault(); state.dev?.toggle(); return; }
    if (e.code === 'KeyE') { e.preventDefault(); throwLure(); return; }
    if (e.code === 'KeyQ') { e.preventDefault(); pulseReveal(); return; }
    if (e.code === 'Tab' || e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
    state.player.key(e.code, true);
  });
  window.addEventListener('keyup', (e) => state.player.key(e.code, false));
  // возврат из фона на телефоне: размеры вьюпорта могли уехать
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { resize(); state.touch?.syncBand(); }
  });
  window.addEventListener('blur', () => state.player.keys.clear());
}

async function refreshStats(pin) {
  const box = $('statsBox');
  const res = await fetchStats(pin);
  if (!res.ok) {
    box.textContent = res.error === 'forbidden' ? 'пароль не подошёл'
      : res.error === 'offline' ? 'сервер недоступен'
      : res.error === 'no-pin' ? 'введите пароль панели, чтобы увидеть'
      : 'не вышло: ' + res.error;
    $('statsHost')?.classList.add('hidden');
    $('statsChart')?.classList.add('hidden');
    return;
  }
  const d = res.data;
  const who = d.players.length
    ? d.players.map(p => escapeName(p.name) + (p.idle > 25 ? ` <span style="opacity:.5">(${(p.idle | 0)} с назад)</span>` : '')).join(', ')
    : '— никого';
  box.innerHTML = `Сейчас в игре: <b>${d.online}</b><div class="who">${who}</div>`
    + `Всего забегов: <b>${d.total ?? d.runs}</b> · в таблице: <b>${d.runs}</b>`
    + ` · игроков: <b>${d.registered}</b> · лучший счёт: <b>${d.best}</b>`;
  renderHost(d.host);
  renderRunsChart(d.days);
}

/** Русские окончания по числу: 1 ядро, 2 ядра, 5 ядер. */
function plural(n, one, few, many) {
  const m = n % 10, h = n % 100;
  if (h >= 11 && h <= 14) return many;
  if (m === 1) return one;
  if (m >= 2 && m <= 4) return few;
  return many;
}

/** Нагрузка машины: полоски вместо голых чисел — так видно с одного взгляда. */
function renderHost(h) {
  const el = $('statsHost');
  if (!el) return;
  if (!h) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  const bar = (frac) => {
    const pct = Math.max(0, Math.min(1, frac)) * 100;
    const cls = pct > 85 ? 'hot' : pct > 60 ? 'warn' : '';
    return `<span class="bar"><i class="${cls}" style="width:${pct.toFixed(0)}%"></i></span>`;
  };
  const row = (name, val) => `<div class="hrow"><span class="hname">${name}</span>${val}</div>`;
  const parts = [];
  if (h.load) {
    // среднюю загрузку делим на число ядер — иначе цифра ни о чём не говорит
    const per = h.load[0] / (h.cpus || 1);
    parts.push(row('Процессор', `${bar(per)}<b>${(per * 100).toFixed(0)}%</b>`
      + `<span class="hval dim">${h.load.map(v => v.toFixed(2)).join(' / ')}`
      + ` на ${h.cpus} ${plural(h.cpus, 'ядро', 'ядра', 'ядер')}</span>`));
  }
  if (h.memTotalMb) {
    parts.push(row('Память', `${bar(h.memUsedMb / h.memTotalMb)}`
      + `<span class="hval"><b>${(h.memUsedMb / 1024).toFixed(1)}</b>`
      + ` из ${(h.memTotalMb / 1024).toFixed(1)} ГБ</span>`));
  }
  if (h.diskTotalGb) {
    parts.push(row('Диск', `${bar(1 - h.diskFreeGb / h.diskTotalGb)}`
      + `<span class="hval">свободно <b>${h.diskFreeGb}</b> из ${h.diskTotalGb} ГБ</span>`));
  }
  if (h.uptimeH != null) {
    const d2 = Math.floor(h.uptimeH / 24);
    parts.push(row('Аптайм', `<span class="hval"><b>${d2 ? d2 + ' сут ' : ''}`
      + `${Math.round(h.uptimeH % 24)} ч</b></span>`));
  }
  el.innerHTML = parts.join('') || 'нет данных';
}

/** Столбики забегов по дням. Рисуем сами: библиотека ради этого не нужна. */
function renderRunsChart(days) {
  const el = $('statsChart');
  if (!el) return;
  const keys = Object.keys(days || {}).sort().slice(-14);
  if (!keys.length) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');

  const vals = keys.map(k => days[k]);
  const max = Math.max(...vals, 1);
  // при одном-двух днях столбик иначе растягивается во весь блок и выглядит
  // как заливка, а не как график — ширину ограничиваем
  const H = 84, pad = 14, bw = Math.min(26, (320 - pad * 2) / keys.length);
  const W = Math.max(120, pad * 2 + bw * keys.length);
  const bars = keys.map((k, i) => {
    const h = Math.max(2, (vals[i] / max) * (H - 30));
    const x = pad + i * bw, y = H - 16 - h;
    const day = k.slice(8);
    const label = (i === 0 || i === keys.length - 1 || vals[i] === max)
      ? `<text x="${(x + bw / 2).toFixed(1)}" y="${H - 4}" class="d">${day}</text>` : '';
    const num = vals[i] > 0
      ? `<text x="${(x + bw / 2).toFixed(1)}" y="${(y - 3).toFixed(1)}" class="v">${vals[i]}</text>` : '';
    return `<rect x="${(x + 1.5).toFixed(1)}" y="${y.toFixed(1)}" width="${(bw - 3).toFixed(1)}"`
      + ` height="${h.toFixed(1)}" rx="2" class="b"/>${num}${label}`;
  }).join('');

  const total = vals.reduce((a, b) => a + b, 0);
  el.innerHTML = `<div class="cap">Забегов за ${keys.length} ${plural(keys.length, 'день', 'дня', 'дней')} — ${total}</div>`
    + `<svg viewBox="0 0 ${W} ${H}" style="max-width:${W}px" role="img" aria-label="Забеги по дням">`
    + `<style>
        .b{fill:rgba(111,227,232,.55)}
        .v{fill:#dfeef0;font-size:8px;text-anchor:middle;font-family:inherit}
        .d{fill:#7f9498;font-size:8px;text-anchor:middle;font-family:inherit}
       </style>${bars}</svg>`;
}

async function refreshScoreTable() {
  const { rows, online } = await fetchTable();
  renderTable($('scoreTable'), rows, { online });
}

function openMenu() {
  $('ident').classList.add('hidden');
  $('more').classList.add('hidden');
  $('menu').classList.remove('hidden');
  setRosterTab('players');
  refreshPlayersRoster();
}

/** Правая колонка меню: вкладка «Игроки» или «Лучшие забеги». */
function setRosterTab(t) {
  $('tabPlayers').classList.toggle('on', t === 'players');
  $('tabScores').classList.toggle('on', t === 'scores');
  $('panePlayers').classList.toggle('hidden', t !== 'players');
  $('paneScores').classList.toggle('hidden', t !== 'scores');
  if (t === 'scores') refreshScoreTable();
}

/** Зарегистрированные имена — карточками, как список на экране входа. */
async function refreshPlayersRoster() {
  const box = $('playersGrid');
  if (!box) return;
  box.innerHTML = '<div class="empty">загрузка…</div>';
  const names = await fetchPlayers();
  box.innerHTML = names.length
    ? names.map(n => `<div class="pchip">${escapeName(n)}</div>`).join('')
    : '<div class="empty">пока никто не зарегистрирован</div>';
}

/**
 * Экран знакомства, две вкладки. «Уже играл» — узнать себя в списке и
 * подтвердить пароль; «Первый раз» — представиться новым именем. Раньше список
 * и поле имени висели вместе, и было неясно, что из этого твой случай.
 */
let identTab = 'known';
let identPicked = '';

function setIdentTab(tab) {
  identTab = tab;
  $('tabKnown').classList.toggle('on', tab === 'known');
  $('tabNew').classList.toggle('on', tab === 'new');
  $('paneKnown').classList.toggle('hidden', tab !== 'known');
  $('paneNew').classList.toggle('hidden', tab !== 'new');
  $('identErr').textContent = '';
}

async function openIdent() {
  $('menu').classList.add('hidden');
  $('ident').classList.remove('hidden');
  $('identErr').textContent = '';
  $('identName').value = playerName();
  $('identPin').value = '';
  identPicked = '';
  $('identCancel').classList.toggle('hidden', !(playerName() && pinValid()));

  const box = $('identKnown');
  box.innerHTML = '<div class="empty">загружаю список…</div>';
  const known = await fetchPlayers();

  // Некому себя узнавать — вкладки только мешают, сразу знакомимся.
  $('identTabs').classList.toggle('hidden', !known.length);
  setIdentTab(known.length ? 'known' : 'new');
  if (!known.length) { box.innerHTML = ''; return; }

  box.innerHTML = known
    .map(n => `<button class="who" data-name="${escapeName(n)}">${escapeName(n)}</button>`).join('');
  box.querySelectorAll('.who').forEach(b => b.addEventListener('click', () => {
    box.querySelectorAll('.who').forEach(o => o.classList.remove('sel'));
    b.classList.add('sel');
    identPicked = b.dataset.name;
    $('identPin').focus();
  }));
}

async function identSubmit() {
  const name = identTab === 'known' ? identPicked : $('identName').value.trim();
  const pin = $('identPin').value.replace(/\D/g, '');
  const err = $('identErr');
  if (!name) {
    err.textContent = identTab === 'known'
      ? 'выберите себя в списке или откройте «Первый раз»'
      : 'впишите имя';
    return;
  }
  if (!/^\d{4}$/.test(pin)) { err.textContent = 'пароль — ровно четыре цифры'; return; }

  err.textContent = 'проверяю…';
  const res = await authenticate(name, pin);
  if (!res.ok) {
    err.textContent = res.error === 'wrong-pin' ? 'это имя занято, пароль не подошёл'
      : res.error === 'too-many' ? 'слишком много попыток, подождите'
      : 'не вышло войти: ' + res.error;
    return;
  }
  err.textContent = '';
  $('nameInput').value = name;
  $('pinInput').value = pin;
  if (res.registered) flashHint('имя закреплено за вами');
  else if (res.offline) flashHint('сервер недоступен — имя сохранено локально');
  openMenu();
  refreshScoreTable();
}

/** Параметры сложности живут в одном месте; игрок берёт из них свои. */
function applyDifficulty() {
  const c = DIFFICULTY[state.monsters.difficulty] || DIFFICULTY.normal;
  state.player.airSeconds = c.air;
  state.player.drownRate = c.drown;
  state.player.regen = c.regen;
  const note = $('diffNote');
  if (note) {
    note.innerHTML = `Воздуха <b>${c.air} с</b> · обитателей <b>${c.walkers}+${c.stalkers}</b>,`
      + ` замена выбывшего через <b>${c.respawn} с</b><br>`
      + `Артефакт возвращается через <b>${c.artifactDelay} с</b> ·`
      + ` растение отрастает раз в <b>${c.plantRegrow} с</b> ·`
      + ` приманка раз в <b>${c.lureCooldown} с</b>`;
  }
}

function refreshLevelList() {
  const list = $('levelList');
  list.innerHTML = '';
  const add = (name, sub, fn) => {
    const b = document.createElement('button');
    b.className = 'lvl';
    b.innerHTML = `<span class="ln">${name}</span><span class="ls">${sub}</span>`;
    b.addEventListener('click', async () => { await loadLevel(fn()); startGame(); });
    list.appendChild(b);
  };
  add('Затопленный вестибюль', 'дневной свет · аркада · бассейн', demoLevel);
  add('Глубокий конец', 'неон · залы под водой · души', demoLevelDeep);
  const slots = savedSlots();
  for (const [name, json] of Object.entries(slots)) {
    add(name, 'сохранённый в редакторе', () => deserializeLevel(json));
  }
}

/** Запрос захвата указателя. Браузер может отказать — тогда работает перетаскивание. */
function requestLock() {
  const canvas = $('c');
  if (document.pointerLockElement === canvas) return;
  try {
    const p = canvas.requestPointerLock?.({ unadjustedMovement: true });
    if (p && typeof p.catch === 'function') p.catch(() => { try { canvas.requestPointerLock(); } catch (_) { } });
  } catch (_) {
    try { canvas.requestPointerLock(); } catch (__) { }
  }
}

const REVEAL_TIME = 5;      // секунд свечения на один заряд

/**
 * Вспышка обнаружения. Не кнопка «всегда доступно»: каждый запуск тратит заряд,
 * а заряды берутся только с найденных артефактов.
 */
function pulseReveal() {
  if (!state.running || state.revealLeft > 0) return;
  if (state.monsters.charges <= 0) { flashHint('нужен артефакт'); return; }
  state.monsters.charges--;
  state.revealLeft = REVEAL_TIME;
  state.audio.drip();
}

let hintTimer = 0;
function flashHint(text) {
  const el = $('lockHint');
  el.textContent = text;
  el.classList.remove('hidden');
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => el.classList.add('hidden'), 1600);
}

/** Записать забег в таблицу и показать итог. */
async function recordRun() {
  const kills = state.monsters.kills, arts = state.runArtifacts, t = state.runTime;
  const mm = Math.floor(t / 60), ss = Math.floor(t % 60);
  const base = `${kills} уб · ${arts} арт · ${mm}:${String(ss).padStart(2, '0')}`;
  $('deadScore').textContent = base + ' · считаем…';
  $('deadTable').innerHTML = '';

  if (!playerName() || !pinValid()) {
    $('deadScore').textContent = base + ' · впишите имя и пароль в меню, чтобы попасть в таблицу';
    return;
  }
  const res = await submit({ kills, artifacts: arts, time: t, diff: state.monsters.difficulty });
  if (res.error === 'taken') {
    $('deadScore').textContent = base + ' · имя занято другим паролем — смените имя в меню';
    return;
  }
  $('deadScore').textContent = `${res.score} очков · ${base}` + (res.place ? ` · место ${res.place}` : '');
  renderTable($('deadTable'), res.rows, { highlight: res.score, online: res.online });
  renderTable($('scoreTable'), res.rows, { online: res.online });
}

function throwLure() {
  if (!state.running || state.player.dead) return;
  if (state.monsters.throwLure()) state.audio.drip();
}

/** Смерть не наказывает потерей уровня — просто возвращает к точке входа. */
function respawn() {
  const lv = state.engine.level;
  if (lv) state.player.spawnFrom(lv);
  state.monsters.build(lv);
  $('dead').classList.add('hidden');
  state.runTime = 0;
  state.runArtifacts = 0;
  state.revealLeft = 0;
  state.fade = 0;
}

let pingTimer = 0;
function startPings() {
  if (pingTimer) return;
  ping();
  pingTimer = setInterval(() => { if (state.running) ping(); }, 20000);
}

/**
 * Нажали «Играть». В одиночку начинаем сразу; в сетевой игре сперва комната
 * ожидания — но ведущий может стартовать хоть один, никого не дожидаясь.
 */
function playPressed() {
  if (state.net.enabled && !state.net.started) {
    $('menu').classList.add('hidden');
    $('lobby').classList.remove('hidden');
    state.audio.start();          // нажатие «Играть» — тот самый жест для звука
    state.audio.resume();
    lobbyWas = 0;
    drawLobby();
    return;
  }
  startGame();
}

/** Список пришедших: занятые места и свободные, чтобы видеть, сколько ждать. */
let lobbyWas = 0;
function drawLobby() {
  const n = state.net;
  if (!n.enabled) return;
  // состав изменился — отзываемся звуком, чтобы не пялиться в список
  if (n.lobby.length !== lobbyWas) {
    if (lobbyWas) state.audio.join(n.lobby.length > lobbyWas);
    lobbyWas = n.lobby.length;
  }
  $('lobbyRoom').textContent = n.room || '—';

  const rows = n.lobby.map(p => `
    <div class="lp">
      <span class="dot" style="background:${colorHex(p.id)}"></span>
      <span>${escapeName(p.name)}</span>
      ${p.id === n.host ? '<span class="crown">ВЕДУЩИЙ</span>'
        : p.id === n.selfId ? '<span class="me">ВЫ</span>' : ''}
    </div>`).join('');
  const free = Math.max(0, n.max - n.lobby.length);
  const empty = Array.from({ length: free }, () =>
    '<div class="lp free"><span class="dot" style="background:currentColor"></span>свободно</div>').join('');
  $('lobbyList').innerHTML = rows + empty;

  $('btnStart').style.display = n.isHost ? '' : 'none';
  $('lobbyHint').textContent = n.isHost
    ? 'Можно начинать, не дожидаясь остальных — кто придёт позже, войдёт в идущую игру.'
    : 'Ждём, когда ведущий начнёт. Присоединиться позже тоже можно.';

  // сервер объявил старт — заходим все разом
  if (n.started && !$('lobby').classList.contains('hidden')) {
    $('lobby').classList.add('hidden');
    startGame();
  }
}

function escapeName(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function startGame() {
  $('menu').classList.add('hidden');
  $('pause').classList.add('hidden');
  state.running = true;
  state.paused = false;
  state.audio.start();
  state.audio.resume();
  startPings();

  if (state.touch.enabled) {
    // на телефоне захвата указателя нет — обзор включаем сразу
    state.player.enabled = true;
    state.touch.show();
    // полноэкранный режим прячет адресную строку; Safari откажет — не страшно
    document.documentElement.requestFullscreen?.().catch(() => { });
    return;
  }
  requestLock();
  // Chrome не отдаёт захват сразу после выхода из него — повторяем чуть позже
  setTimeout(() => { if (state.running && !state.locked) requestLock(); }, 300);
}

function pauseGame() {
  if (state.paused && !state.running) return;
  state.paused = true;
  state.running = false;
  state.locked = false;
  state.dragLook = false;
  state.player.enabled = false;
  state.player.keys.clear();
  state.touch.hide();
  syncRanges();
  $('pause').classList.remove('hidden');
  state.audio.suspend();
  document.exitPointerLock?.();
}

/**
 * Динамическое разрешение: если кадр устойчиво не укладывается в бюджет,
 * снижаем внутренний буфер ступенями. Меняем не чаще раза в секунду —
 * пересоздание render target'ов само по себе не бесплатно.
 */
function adaptResolution(dt) {
  const e = state.engine;
  if (!state.adaptive || state.paused) return;
  state.adaptCooldown -= dt;
  state.adaptAccum += dt; state.adaptFrames++;
  if (state.adaptFrames < 30 || state.adaptCooldown > 0) return;

  const avg = state.adaptAccum / state.adaptFrames;
  state.adaptAccum = 0; state.adaptFrames = 0;

  let i = SCALE_STEPS.indexOf(state.adaptScale);
  if (i < 0) i = 0;
  if (avg > FRAME_TARGET && i < SCALE_STEPS.length - 1) i++;
  else if (avg < FRAME_GOOD && i > 0) i--;
  else return;

  state.adaptScale = SCALE_STEPS[i];
  if (e.setDynamicScale(state.adaptScale)) state.adaptCooldown = 1.2;
}

/** Фото-режим: рендерим кадр без HUD и сохраняем PNG. */
function takeScreenshot() {
  const e = state.engine;
  e.render();                       // свежий кадр в буфере прямо сейчас
  const url = $('c').toDataURL('image/png');
  const a = document.createElement('a');
  a.href = url;
  a.download = `poolrooms_${Date.now()}.png`;
  a.click();
  const flash = document.createElement('div');
  flash.style.cssText = 'position:fixed;inset:0;background:#fff;opacity:.5;z-index:99;pointer-events:none;transition:opacity .35s';
  document.body.appendChild(flash);
  requestAnimationFrame(() => { flash.style.opacity = '0'; setTimeout(() => flash.remove(), 400); });
}

// ---------------------------------------------------------------- цикл

function loop(t) {
  requestAnimationFrame(loop);
  const dt = Math.min(0.1, (t - state.lastT) / 1000 || 0.016);
  state.lastT = t;

  const e = state.engine;
  if (!e) return;

  if (!state.paused) {
    state.gyro.apply(state.player);      // до update: тот применит углы к камере
    // с гироскопом глубина задаётся наклоном телефона, а не кнопками
    state.player.lookSwim = state.gyro.active;
    state.player.update(dt);
    state.monsters.update(dt, state.player);
  }
  e.update(dt);

  // плавное появление после загрузки
  state.fade += ((state.paused && !state.running ? 0.55 : 1) - state.fade) * Math.min(1, dt * 6);
  e.fade = state.fade;

  e.render();

  adaptResolution(dt);

  // HUD
  state.fpsAccum += dt; state.fpsFrames++;
  if (state.fpsAccum > 0.4) {
    state.fps = Math.round(state.fpsFrames / state.fpsAccum);
    state.fpsAccum = 0; state.fpsFrames = 0;
    $('fps').textContent = state.fps + ' FPS';
    const s = e.dynamicScale;
    $('tris').textContent = (e.renderer.info.render.triangles / 1000).toFixed(0) + 'k тр. · '
      + e.renderer.info.render.calls + ' выз.' + (s < 0.999 ? ' · ' + Math.round(s * 100) + '%' : '');
  }

  if (state.devOpen) state.dev.update(dt, state.fps);

  const p = state.player;
  const under = e.water ? (p.pos.y + p.eye) < e.water.waterY : false;
  const oxy = $('oxygen');
  if (under) {
    oxy.classList.remove('hidden');
    $('oxygenFill').style.width = (p.oxygen * 100).toFixed(1) + '%';
    $('oxygenFill').style.background = p.oxygen < 0.25 ? '#e8604c' : '#8fe8f0';
  } else oxy.classList.add('hidden');

  let lampNear = 0;
  for (const l of e.pointLights) if (l.intensity > 1) lampNear += 0.14;
  // глубина по голове: сколько воды над макушкой
  const headDepth = e.water ? (e.water.waterY - (p.pos.y + p.eye)) : 0;
  state.audio.update(under ? 1 : 0, Math.min(1, lampNear), headDepth);

  const depth = e.water ? e.water.waterY - (p.pos.y + p.eye) : 0;
  $('mode').textContent = p.noclip ? 'полёт'
    : p.mode === 'swim' ? (depth > 0.15 ? `глубина ${depth.toFixed(1)} м` : 'плывёт')
    : p.mode === 'wade' ? 'по воде' : '';
  state.touch.update(state.paused ? 0 : dt);
  state.net.update(dt, p);
  const nt = $('netTag');
  nt.classList.toggle('hidden', !state.net.enabled);
  if (state.net.enabled) nt.innerHTML = `<b>${state.net.count || 1}</b>/${state.net.max}`;
  $('vrTag').classList.toggle('hidden', !state.gyro.active);

  // --- здоровье, урон, приманка ---
  $('healthFill').style.width = (p.health * 100).toFixed(1) + '%';
  $('healthFill').style.background = p.health < 0.3 ? '#e8604c' : '#8fe8b4';
  $('hurt').style.opacity = Math.min(0.85, p.hurtFlash).toFixed(3);

  const cool = state.monsters.lureCooldown;
  $('lureReady').textContent = cool > 0 ? Math.ceil(cool) + ' с' : 'готова';
  state.touch.setThrowReady?.(cool <= 0);

  // вспышка обнаружения: плавно гаснет к концу, чтобы не мигало резко
  if (!state.paused) state.revealLeft = Math.max(0, state.revealLeft - dt);
  e.reveal = Math.min(1, state.revealLeft * 1.6);
  const ch = state.monsters.charges;
  const rr = $('revealReady');
  rr.textContent = state.revealLeft > 0 ? 'видно' : (ch > 0 ? ch + '×' : 'нет');
  rr.classList.toggle('on', ch > 0);
  state.touch.setRevealReady?.(ch > 0);

  // Стрелка на артефакт. Показываем только вблизи: иначе находка перестала бы
  // быть находкой, а так она подсказывает лишь когда вы уже рядом.
  const art = state.monsters.artifact;
  const box = $('arti');
  if (art && art.active) {
    const dx = art.pos.x - p.pos.x, dz = art.pos.z - p.pos.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 45) {
      box.classList.remove('hidden');
      box.classList.toggle('near', dist < 12);
      // угол между направлением взгляда и направлением на артефакт
      const bearing = Math.atan2(dx, dz) - Math.PI - p.yaw;
      $('artiArrow').style.transform = `rotate(${(-bearing * 180 / Math.PI).toFixed(1)}deg)`;
      $('artiDist').textContent = dist.toFixed(0) + ' м';
    } else box.classList.add('hidden');
  } else box.classList.add('hidden');

  if (!state.paused && state.running) state.runTime += dt;

  if (p.dead && state.running) {
    state.running = false;
    state.player.enabled = false;
    state.touch.hide();
    document.exitPointerLock?.();
    recordRun();
    $('dead').classList.remove('hidden');
  }
}

// отладочный доступ из консоли: __game.engine / __game.player
window.__game = state;

boot();
