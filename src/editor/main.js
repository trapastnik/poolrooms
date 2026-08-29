import * as THREE from 'three';
import { Engine } from '../core/engine.js';
import {
  CELL, FEAT, FEAT_INFO, MATS, createLevel, demoLevel, demoLevelDeep,
  serializeLevel, deserializeLevel, cloneLevel, inside, isRoom
} from '../core/level.js';
import { ENV_PRESETS } from '../core/env.js';
import { QUALITY_PRESETS } from '../core/quality.js';

const $ = (id) => document.getElementById(id);
const LS_SLOTS = 'poolrooms.levels';
const LS_AUTOSAVE = 'poolrooms.editor.autosave';
const LS_PLAY = 'poolrooms.playLevel';

// ---------------------------------------------------------------- состояние

const TOOL = {
  ROOM: 'room', VOID: 'void', FLOOR: 'floor', CEIL: 'ceil',
  MAT: 'mat', FEAT: 'feat', SPAWN: 'spawn', PICK: 'pick', FILL: 'fill'
};

const ed = {
  level: null,
  tool: TOOL.ROOM,
  brush: 1,
  rectMode: false,
  floorValue: 0,
  ceilValue: 5.5,
  matValue: 0,
  featValue: FEAT.COLUMN_SQ,
  rotValue: 0,
  view: { x: 0, y: 0, scale: 16 },
  hover: null,
  drag: null,
  rectStart: null,
  undo: [], redo: [],
  dirty: false,
  autoPreview: true,
  previewTimer: null,
  engine: null,
  orbit: { yaw: 0.9, pitch: -0.45, dist: 26, target: new THREE.Vector3() },
  pvMode: 'fly',                 // fly = изнутри, orbit = сверху со срезом
  pvBig: false,
  sectionPlane: new THREE.Plane(new THREE.Vector3(0, -1, 0), 3),
  layerDirty: true,
  pvAccum: 0,
  pvDrag: false,
  lastInteract: 0,
  keys: new Set()
};

// ---------------------------------------------------------------- утилиты

function pushUndo() {
  ed.undo.push(serializeLevel(ed.level));
  if (ed.undo.length > 60) ed.undo.shift();
  ed.redo.length = 0;
  ed.dirty = true;
  updateStatus();
}

function doUndo() {
  if (!ed.undo.length) return;
  ed.redo.push(serializeLevel(ed.level));
  ed.level = deserializeLevel(ed.undo.pop());
  afterEdit(true);
}

function doRedo() {
  if (!ed.redo.length) return;
  ed.undo.push(serializeLevel(ed.level));
  ed.level = deserializeLevel(ed.redo.pop());
  afterEdit(true);
}

function afterEdit(full = false) {
  ed.layerDirty = true;
  drawGrid();
  syncProps();
  schedulePreview(full ? 0 : 350);
  updateStatus(true);
  autosave();
}

let autosaveTimer = null;
function autosave() {
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    try { localStorage.setItem(LS_AUTOSAVE, serializeLevel(ed.level)); } catch (_) { }
  }, 900);
}

function updateStatus(recount = false) {
  const lv = ed.level;
  // проход по всем клеткам дорогой — считаем только после правок, не на каждое движение мыши
  if (recount || !ed._stats || ed._statsFor !== lv) {
    let r = 0, f = 0;
    for (let i = 0; i < lv.t.length; i++) { if (lv.t[i] === CELL.ROOM) r++; if (lv.o[i]) f++; }
    ed._stats = { rooms: r, feats: f }; ed._statsFor = lv;
  }
  const rooms = ed._stats.rooms, feats = ed._stats.feats;
  $('stat').textContent =
    `${lv.w}×${lv.h} · клетка ${lv.cell} м · комнат ${rooms} · объектов ${feats} · отмен ${ed.undo.length}`;
  $('hoverInfo').textContent = ed.hover
    ? `[${ed.hover.i}, ${ed.hover.j}]  пол ${lv.f[ed.hover.k].toFixed(2)}  потолок ${lv.c[ed.hover.k].toFixed(2)}`
    : '';
}

// ---------------------------------------------------------------- 2D-сетка

const cv = () => $('grid');
let ctx2d = null;

function worldToScreen(i, j) {
  return [(i - ed.view.x) * ed.view.scale, (j - ed.view.y) * ed.view.scale];
}
function screenToCell(px, py) {
  const i = Math.floor(px / ed.view.scale + ed.view.x);
  const j = Math.floor(py / ed.view.scale + ed.view.y);
  return { i, j };
}

const FLOOR_COLORS = (h) => {
  // от глубокого синего (низко) через нейтральный к тёплому (высоко)
  const t = Math.max(-1, Math.min(1, h / 6));
  if (t < 0) {
    const k = -t;
    return `rgb(${Math.round(40 + 30 * (1 - k))},${Math.round(70 + 60 * (1 - k))},${Math.round(95 + 55 * (1 - k))})`;
  }
  return `rgb(${Math.round(70 + 110 * t)},${Math.round(130 + 70 * t)},${Math.round(150 - 30 * t)})`;
};

// План рисуется в два слоя: тяжёлый статический (клетки, сетка, объекты)
// кэшируется в offscreen-канвас и перерисовывается только при правках/панораме,
// а поверх него каждый кадр рисуется лишь курсор и камера превью.
let layerCv = null, layerCtx = null;

function markLayerDirty() { ed.layerDirty = true; }

function drawStatic() {
  const c = cv();
  const W = c.width, H = c.height;
  if (!layerCv) { layerCv = document.createElement('canvas'); layerCtx = layerCv.getContext('2d'); }
  if (layerCv.width !== W || layerCv.height !== H) { layerCv.width = W; layerCv.height = H; }
  const g = layerCtx;
  const lv = ed.level, s = ed.view.scale;

  g.fillStyle = '#080d10';
  g.fillRect(0, 0, W, H);

  const i0 = Math.max(0, Math.floor(ed.view.x));
  const j0 = Math.max(0, Math.floor(ed.view.y));
  const i1 = Math.min(lv.w - 1, Math.ceil(ed.view.x + W / s));
  const j1 = Math.min(lv.h - 1, Math.ceil(ed.view.y + H / s));

  // клетки
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const k = j * lv.w + i;
      const [x, y] = worldToScreen(i, j);
      if (lv.t[k] === CELL.ROOM) {
        g.fillStyle = FLOOR_COLORS(lv.f[k]);
        g.fillRect(x, y, s, s);
        if (lv.f[k] < lv.waterY - 0.02 && lv.c[k] > lv.waterY) {
          g.fillStyle = 'rgba(90,220,225,0.30)';
          g.fillRect(x, y, s, s);
        }
        if (lv.c[k] - lv.f[k] < 2.6) {
          g.strokeStyle = 'rgba(255,120,120,0.35)';
          g.lineWidth = 1;
          g.beginPath(); g.moveTo(x, y + s); g.lineTo(x + s, y); g.stroke();
        }
      } else if (lv.o[k]) {
        g.fillStyle = '#1d2c33';
        g.fillRect(x, y, s, s);
      }
    }
  }

  // сетка
  if (s >= 7) {
    g.strokeStyle = 'rgba(255,255,255,0.055)';
    g.lineWidth = 1;
    g.beginPath();
    for (let i = i0; i <= i1 + 1; i++) { const [x] = worldToScreen(i, 0); g.moveTo(x + .5, 0); g.lineTo(x + .5, H); }
    for (let j = j0; j <= j1 + 1; j++) { const [, y] = worldToScreen(0, j); g.moveTo(0, y + .5); g.lineTo(W, y + .5); }
    g.stroke();
    g.strokeStyle = 'rgba(255,255,255,0.13)';
    g.beginPath();
    for (let i = i0; i <= i1 + 1; i++) if (i % 5 === 0) { const [x] = worldToScreen(i, 0); g.moveTo(x + .5, 0); g.lineTo(x + .5, H); }
    for (let j = j0; j <= j1 + 1; j++) if (j % 5 === 0) { const [, y] = worldToScreen(0, j); g.moveTo(0, y + .5); g.lineTo(W, y + .5); }
    g.stroke();
  }

  // объекты
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = `${Math.max(9, Math.floor(s * 0.62))}px "Segoe UI Symbol",sans-serif`;
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const k = j * lv.w + i;
      const o = lv.o[k];
      if (!o) continue;
      const [x, y] = worldToScreen(i, j);
      const info = FEAT_INFO[o];
      g.fillStyle = lv.t[k] === CELL.ROOM ? '#0c1418' : '#8fe8f0';
      g.fillText(info ? info.icon : '?', x + s / 2, y + s / 2 + 1);
      if (s >= 12) {
        const d = [[0, -1], [1, 0], [0, 1], [-1, 0]][lv.r[k] % 4];
        g.strokeStyle = 'rgba(255,190,90,0.85)';
        g.lineWidth = 1.6;
        g.beginPath();
        g.moveTo(x + s / 2, y + s / 2);
        g.lineTo(x + s / 2 + d[0] * s * 0.42, y + s / 2 + d[1] * s * 0.42);
        g.stroke();
      }
    }
  }

  // высоты пола цифрами
  if (s >= 26) {
    g.font = `${Math.floor(s * 0.26)}px ui-monospace,monospace`;
    g.fillStyle = 'rgba(0,0,0,0.55)';
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = j * lv.w + i;
        if (lv.t[k] !== CELL.ROOM) continue;
        const [x, y] = worldToScreen(i, j);
        g.fillText(lv.f[k].toFixed(1), x + s / 2, y + s - s * 0.16);
      }
    }
  }

  // граница уровня
  const [bx, by] = worldToScreen(0, 0);
  g.strokeStyle = 'rgba(111,227,232,0.4)';
  g.lineWidth = 2;
  g.strokeRect(bx, by, lv.w * s, lv.h * s);

  // точка спавна
  const sx = (lv.spawn.x / lv.cell - ed.view.x) * s;
  const sy = (lv.spawn.z / lv.cell - ed.view.y) * s;
  g.fillStyle = '#ffd76a';
  g.beginPath(); g.arc(sx, sy, Math.max(4, s * 0.24), 0, Math.PI * 2); g.fill();
  g.strokeStyle = '#ffd76a'; g.lineWidth = 2;
  g.beginPath(); g.moveTo(sx, sy);
  g.lineTo(sx - Math.sin(lv.spawn.yaw) * s * 0.85, sy - Math.cos(lv.spawn.yaw) * s * 0.85);
  g.stroke();
}

function drawGrid() {
  const c = cv();
  // холст может быть нулевого размера (скрытая вкладка, ещё не сложившийся layout) —
  // drawImage с пустым источником бросает исключение
  if (!c.width || !c.height) return;
  if (!ctx2d) ctx2d = c.getContext('2d');
  const g = ctx2d;
  if (ed.layerDirty || !layerCv || layerCv.width !== c.width || layerCv.height !== c.height) {
    drawStatic();
    ed.layerDirty = false;
  }
  g.drawImage(layerCv, 0, 0);

  const s = ed.view.scale;

  // камера предпросмотра
  if (ed.engine) {
    const lv = ed.level;
    const cx = (ed.engine.camera.position.x / lv.cell - ed.view.x) * s;
    const cz = (ed.engine.camera.position.z / lv.cell - ed.view.y) * s;
    const dir = ed.engine.camera.getWorldDirection(_dirTmp);
    g.strokeStyle = 'rgba(140,255,200,0.9)'; g.lineWidth = 2;
    g.beginPath(); g.arc(cx, cz, 4, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.moveTo(cx, cz); g.lineTo(cx + dir.x * s * 1.2, cz + dir.z * s * 1.2); g.stroke();
  }

  // курсор кисти / рамка прямоугольника
  if (ed.hover) {
    const r = Math.floor(ed.brush / 2);
    let a = ed.hover.i - r, b = ed.hover.j - r, w = ed.brush, h = ed.brush;
    if (ed.rectStart) {
      a = Math.min(ed.rectStart.i, ed.hover.i); b = Math.min(ed.rectStart.j, ed.hover.j);
      w = Math.abs(ed.hover.i - ed.rectStart.i) + 1; h = Math.abs(ed.hover.j - ed.rectStart.j) + 1;
    }
    const [hx, hy] = worldToScreen(a, b);
    g.strokeStyle = '#8fe8f0'; g.lineWidth = 2;
    g.strokeRect(hx + 1, hy + 1, w * s - 2, h * s - 2);
    g.fillStyle = 'rgba(143,232,240,0.12)';
    g.fillRect(hx + 1, hy + 1, w * s - 2, h * s - 2);
  }
}

const _dirTmp = new THREE.Vector3();

// ---------------------------------------------------------------- редактирование

function applyCell(i, j, erase) {
  const lv = ed.level;
  if (!inside(lv, i, j)) return;
  const k = j * lv.w + i;
  switch (ed.tool) {
    case TOOL.ROOM:
      if (erase) { lv.t[k] = CELL.VOID; lv.o[k] = FEAT.NONE; }
      else {
        lv.t[k] = CELL.ROOM; lv.o[k] = lv.o[k] && FEAT_INFO[lv.o[k]]?.on === 'void' ? FEAT.NONE : lv.o[k];
        lv.f[k] = ed.floorValue; lv.c[k] = ed.ceilValue; lv.m[k] = ed.matValue;
      }
      break;
    case TOOL.VOID:
      if (erase) { lv.t[k] = CELL.ROOM; lv.f[k] = ed.floorValue; lv.c[k] = ed.ceilValue; }
      else { lv.t[k] = CELL.VOID; if (FEAT_INFO[lv.o[k]]?.on === 'room') lv.o[k] = FEAT.NONE; }
      break;
    case TOOL.FLOOR:
      if (lv.t[k] === CELL.ROOM || lv.o[k]) lv.f[k] = erase ? 0 : ed.floorValue;
      break;
    case TOOL.CEIL:
      if (lv.t[k] === CELL.ROOM || lv.o[k]) lv.c[k] = erase ? 5.5 : ed.ceilValue;
      break;
    case TOOL.MAT:
      lv.m[k] = erase ? 0 : ed.matValue;
      break;
    case TOOL.FEAT: {
      if (erase) { lv.o[k] = FEAT.NONE; break; }
      const info = FEAT_INFO[ed.featValue];
      if (!info) break;
      if (info.on === 'void') {
        lv.t[k] = CELL.VOID;
        // проёму нужны высоты — берём у соседней комнаты
        const n = neighborRoom(lv, i, j);
        lv.f[k] = n ? lv.f[n] : ed.floorValue;
        lv.c[k] = n ? lv.c[n] : ed.ceilValue;
      } else if (lv.t[k] !== CELL.ROOM) {
        lv.t[k] = CELL.ROOM; lv.f[k] = ed.floorValue; lv.c[k] = ed.ceilValue; lv.m[k] = ed.matValue;
      }
      lv.o[k] = ed.featValue;
      lv.r[k] = ed.rotValue;
      break;
    }
    case TOOL.PICK:
      ed.floorValue = lv.f[k]; ed.ceilValue = lv.c[k]; ed.matValue = lv.m[k];
      if (lv.o[k]) { ed.featValue = lv.o[k]; ed.rotValue = lv.r[k]; }
      syncProps();
      break;
    default: break;
  }
}

function neighborRoom(lv, i, j) {
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    if (isRoom(lv, i + dx, j + dz)) return (j + dz) * lv.w + (i + dx);
  }
  return null;
}

function paintBrush(i, j, erase) {
  const r = Math.floor(ed.brush / 2);
  for (let dj = 0; dj < ed.brush; dj++)
    for (let di = 0; di < ed.brush; di++)
      applyCell(i - r + di, j - r + dj, erase);
}

function paintRect(a, b, erase) {
  const i0 = Math.min(a.i, b.i), i1 = Math.max(a.i, b.i);
  const j0 = Math.min(a.j, b.j), j1 = Math.max(a.j, b.j);
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) applyCell(i, j, erase);
}

function floodFill(i, j, erase) {
  const lv = ed.level;
  if (!inside(lv, i, j)) return;
  const k0 = j * lv.w + i;
  const targetT = lv.t[k0], targetF = lv.f[k0], targetM = lv.m[k0];
  const seen = new Uint8Array(lv.w * lv.h);
  const stack = [[i, j]];
  let count = 0;
  while (stack.length && count < 40000) {
    const [x, y] = stack.pop();
    if (!inside(lv, x, y)) continue;
    const k = y * lv.w + x;
    if (seen[k]) continue;
    if (lv.t[k] !== targetT) continue;
    if (ed.tool === TOOL.MAT && lv.m[k] !== targetM) continue;
    if ((ed.tool === TOOL.FLOOR || ed.tool === TOOL.CEIL) && Math.abs(lv.f[k] - targetF) > 0.01) continue;
    seen[k] = 1; count++;
    applyCell(x, y, erase);
    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }
}

// ---------------------------------------------------------------- 3D-предпросмотр

function schedulePreview(delay = 350) {
  if (!ed.autoPreview && delay !== 0) return;
  clearTimeout(ed.previewTimer);
  ed.previewTimer = setTimeout(rebuildPreview, delay);
}

let building = false;
function rebuildPreview() {
  if (!ed.engine || building) return;
  building = true;
  $('pvStatus').textContent = 'сборка…';
  setTimeout(() => {
    try {
      ed.engine.loadLevel(ed.level);
      $('pvStatus').textContent = '';
    } catch (e) {
      $('pvStatus').textContent = 'ошибка: ' + e.message;
      console.error(e);
    }
    building = false;
  }, 10);
}

function initPreview() {
  const canvas = $('pv');
  try {
    ed.engine = new Engine(canvas, 'medium');
  } catch (e) {
    $('pvStatus').textContent = 'WebGL недоступен';
    return;
  }
  ed.engine.loadLevel(ed.level);
  resizePreview();
  focusPreviewOnSpawn();

  let dragging = false, lastX = 0, lastY = 0, button = 0;
  canvas.addEventListener('mousedown', e => {
    dragging = true; ed.pvDrag = true; ed.lastInteract = performance.now();
    lastX = e.clientX; lastY = e.clientY; button = e.button;
    canvas.style.cursor = 'grabbing';
    e.preventDefault();
  });
  window.addEventListener('mouseup', () => { dragging = false; ed.pvDrag = false; ed.lastInteract = performance.now(); canvas.style.cursor = 'grab'; });
  window.addEventListener('mousemove', e => {
    if (!dragging) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    if (button === 0) {
      ed.orbit.yaw -= dx * 0.006;
      ed.orbit.pitch = Math.max(-1.4, Math.min(1.4, ed.orbit.pitch - dy * 0.006));
    } else {
      const right = new THREE.Vector3(Math.cos(ed.orbit.yaw), 0, -Math.sin(ed.orbit.yaw));
      const fwd = new THREE.Vector3(Math.sin(ed.orbit.yaw), 0, Math.cos(ed.orbit.yaw));
      const k = ed.orbit.dist * 0.0022;
      ed.orbit.target.addScaledVector(right, -dx * k).addScaledVector(fwd, -dy * k);
    }
  });
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    ed.lastInteract = performance.now();
    ed.orbit.dist = Math.max(1.5, Math.min(160, ed.orbit.dist * (1 + Math.sign(e.deltaY) * 0.12)));
  }, { passive: false });
}

function setPvMode(m) {
  ed.pvMode = m;
  $('btnFly').classList.toggle('pri', m === 'fly');
  $('btnOrbit').classList.toggle('pri', m === 'orbit');
  $('pvHint').textContent = m === 'fly'
    ? 'ЛКМ обзор · ПКМ сдвиг · WASD/QE полёт'
    : 'ЛКМ вращать · колесо приблизить · QE высота среза';
}

function focusPreviewOnSpawn() {
  const lv = ed.level;
  if (!ed.engine) return;
  ed.orbit.target.set(lv.spawn.x, ed.engine.grid.floorAt(lv.spawn.x, lv.spawn.z) + 1.68, lv.spawn.z);
  ed.orbit.yaw = lv.spawn.yaw || 0;
  ed.orbit.pitch = 0;
  ed.orbit.dist = 22;
}

function resizePreview() {
  if (!ed.engine) return;
  const box = $('pvWrap').getBoundingClientRect();
  ed.engine.resize(Math.max(120, box.width), Math.max(120, box.height));
}

function previewLoop(t) {
  requestAnimationFrame(previewLoop);
  if (!ed.engine) return;
  const now = t || performance.now();
  const raw = Math.min(0.2, (now - (previewLoop.last || now)) / 1000);
  previewLoop.last = now;
  if (document.hidden) return;

  // Пока пользователь не крутит камеру и не правит уровень, 3D можно
  // обновлять реже — редактор перестаёт греть видеокарту вхолостую.
  const active = ed.keys.size > 0 || ed.pvDrag || (now - ed.lastInteract) < 800;
  ed.pvAccum += raw;
  if (!active && ed.pvAccum < 1 / 15) return;
  const dt = Math.min(0.05, ed.pvAccum);
  ed.pvAccum = 0;

  const o = ed.orbit;
  const k = ed.keys;
  const typing = ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName);
  if (!typing) {
    const sp = (k.has('ShiftLeft') ? 24 : 7) * dt;
    const cp0 = Math.cos(o.pitch);
    const fwd = new THREE.Vector3(-Math.sin(o.yaw) * cp0, Math.sin(o.pitch), -Math.cos(o.yaw) * cp0);
    const right = new THREE.Vector3(Math.cos(o.yaw), 0, -Math.sin(o.yaw));
    if (k.has('KeyW')) o.target.addScaledVector(fwd, sp);
    if (k.has('KeyS')) o.target.addScaledVector(fwd, -sp);
    if (k.has('KeyA')) o.target.addScaledVector(right, -sp);
    if (k.has('KeyD')) o.target.addScaledVector(right, sp);
    if (k.has('KeyE')) o.target.y += sp;
    if (k.has('KeyQ')) o.target.y -= sp;
  }

  const cam = ed.engine.camera;
  const renderer = ed.engine.renderer;

  if (ed.pvMode === 'orbit') {
    // вид сверху: камера снаружи + горизонтальный срез, как на архитектурном плане
    const cp = Math.cos(o.pitch);
    cam.position.set(
      o.target.x + Math.sin(o.yaw) * cp * o.dist,
      o.target.y - Math.sin(o.pitch) * o.dist,
      o.target.z + Math.cos(o.yaw) * cp * o.dist
    );
    cam.lookAt(o.target);
    ed.sectionPlane.constant = o.target.y + 2.6;      // держим всё ниже среза
    renderer.clippingPlanes = [ed.sectionPlane];
  } else {
    // изнутри: камера стоит в точке фокуса и смотрит по yaw/pitch
    cam.position.copy(o.target);
    cam.rotation.order = 'YXZ';
    cam.rotation.set(o.pitch, o.yaw, 0);
    renderer.clippingPlanes = [];
  }

  ed.engine.update(dt);
  ed.engine.render();
  renderer.clippingPlanes = [];

  // указатель камеры на плане — только когда камера реально движется
  if (active) drawGrid();
}

// ---------------------------------------------------------------- UI

function buildUI() {
  // инструменты
  // WASD/QE отданы камере превью, поэтому инструменты — на цифрах
  const tools = [
    [TOOL.ROOM, 'Комната', '1'], [TOOL.VOID, 'Стена', '2'],
    [TOOL.FLOOR, 'Пол', '3'], [TOOL.CEIL, 'Потолок', '4'],
    [TOOL.MAT, 'Материал', '5'], [TOOL.FEAT, 'Объект', '6'],
    [TOOL.SPAWN, 'Спавн', '7'], [TOOL.PICK, 'Пипетка', '8']
  ];
  const tb = $('tools');
  for (const [id, name, key] of tools) {
    const b = document.createElement('button');
    b.className = 'tool'; b.dataset.tool = id;
    b.innerHTML = `${name}<kbd>${key}</kbd>`;
    b.addEventListener('click', () => setTool(id));
    tb.appendChild(b);
  }
  setTool(TOOL.ROOM);

  // палитра материалов
  const mp = $('matPalette');
  MATS.forEach((m, i) => {
    const b = document.createElement('button');
    b.className = 'swatch'; b.dataset.mat = i;
    b.title = m.name;
    b.style.background = '#' + m.color.toString(16).padStart(6, '0');
    b.innerHTML = `<span style="background:#${m.grout.toString(16).padStart(6, '0')}"></span>`;
    b.addEventListener('click', () => { ed.matValue = i; syncProps(); });
    mp.appendChild(b);
  });

  // палитра объектов
  const fp = $('featPalette');
  for (const [id, info] of Object.entries(FEAT_INFO)) {
    const n = Number(id);
    if (n === FEAT.NONE) continue;
    const b = document.createElement('button');
    b.className = 'feat'; b.dataset.feat = n;
    b.title = info.name + (info.on === 'void' ? ' (в стене)' : '');
    b.innerHTML = `<i>${info.icon}</i><span>${info.name}</span>`;
    b.addEventListener('click', () => { ed.featValue = n; setTool(TOOL.FEAT); syncProps(); });
    fp.appendChild(b);
  }

  // пресеты окружения
  const es = $('envSel');
  for (const [k, v] of Object.entries(ENV_PRESETS)) {
    const o = document.createElement('option'); o.value = k; o.textContent = v.label; es.appendChild(o);
  }

  // качество предпросмотра
  const qs = $('pvQuality');
  for (const [k, v] of Object.entries(QUALITY_PRESETS)) {
    const o = document.createElement('option'); o.value = k; o.textContent = v.name; qs.appendChild(o);
  }
  qs.value = 'medium';
  qs.addEventListener('change', () => { if (ed.engine) { ed.engine.setQuality(qs.value); resizePreview(); } });

  // связывание полей
  bindNum('floorVal', v => { ed.floorValue = v; });
  bindNum('ceilVal', v => { ed.ceilValue = v; });
  bindNum('brushVal', v => { ed.brush = Math.max(1, Math.min(11, Math.round(v))); drawGrid(); });

  $('rotVal').addEventListener('change', () => { ed.rotValue = Number($('rotVal').value); });

  bindLevel('lvName', 'name', String);
  bindLevel('lvWater', 'waterY', Number);
  bindLevel('lvCell', 'cell', Number, true);
  bindLevel('lvCaustic', 'causticStrength', Number);
  bindLevel('lvExposure', 'exposure', v => v === '' ? null : Number(v));
  bindLevel('lvFog', 'fogDensity', v => v === '' ? null : Number(v));
  bindLevel('lvAz', 'sunAzimuth', v => v === '' ? null : Number(v));
  bindLevel('lvEl', 'sunElevation', v => v === '' ? null : Number(v));
  $('envSel').addEventListener('change', () => { pushUndo(); ed.level.env = $('envSel').value; afterEdit(true); });

  $('autoPv').addEventListener('change', e => { ed.autoPreview = e.target.checked; });
  $('btnRebuild').addEventListener('click', () => rebuildPreview());
  $('btnFocus').addEventListener('click', () => focusPreviewOnSpawn());
  $('btnFly').addEventListener('click', () => setPvMode('fly'));
  $('btnOrbit').addEventListener('click', () => setPvMode('orbit'));
  $('btnBig').addEventListener('click', () => {
    ed.pvBig = !ed.pvBig;
    document.body.classList.toggle('pvBig', ed.pvBig);
    $('btnBig').textContent = ed.pvBig ? '▢ Свернуть' : '▣ Развернуть';
    requestAnimationFrame(() => { resizePreview(); const c = cv(); const b = $('gridWrap').getBoundingClientRect(); c.width = Math.floor(b.width); c.height = Math.floor(b.height); drawGrid(); });
  });
  setPvMode('fly');

  $('btnNew').addEventListener('click', () => {
    const w = Number(prompt('Ширина сетки (клеток):', '40'));
    if (!w) return;
    const h = Number(prompt('Высота сетки (клеток):', '40'));
    if (!h) return;
    pushUndo();
    ed.level = createLevel(Math.max(6, Math.min(180, w)), Math.max(6, Math.min(180, h)), ed.level.cell);
    centerView();
    afterEdit(true);
  });
  $('btnDemo1').addEventListener('click', () => { pushUndo(); ed.level = demoLevel(); centerView(); afterEdit(true); });
  $('btnDemo2').addEventListener('click', () => { pushUndo(); ed.level = demoLevelDeep(); centerView(); afterEdit(true); });

  $('btnSaveFile').addEventListener('click', () => {
    const blob = new Blob([serializeLevel(ed.level)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (ed.level.name || 'level').replace(/[^\wа-яА-Я\- ]/g, '') + '.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    ed.dirty = false;
  });
  $('btnOpenFile').addEventListener('click', () => $('fileIn').click());
  $('fileIn').addEventListener('change', async e => {
    const f = e.target.files[0]; if (!f) return;
    try { pushUndo(); ed.level = deserializeLevel(await f.text()); centerView(); afterEdit(true); }
    catch (err) { alert('Не удалось прочитать файл: ' + err.message); }
    e.target.value = '';
  });
  $('btnSaveSlot').addEventListener('click', () => {
    const name = prompt('Имя для списка уровней в игре:', ed.level.name);
    if (!name) return;
    const slots = readSlots();
    slots[name] = serializeLevel(ed.level);
    localStorage.setItem(LS_SLOTS, JSON.stringify(slots));
    refreshSlots();
    ed.dirty = false;
  });
  $('btnPlay').addEventListener('click', () => {
    sessionStorage.setItem(LS_PLAY, serializeLevel(ed.level));
    window.location.href = 'game.html';
  });
  $('btnUndo').addEventListener('click', doUndo);
  $('btnRedo').addEventListener('click', doRedo);

  refreshSlots();
}

function readSlots() {
  try { return JSON.parse(localStorage.getItem(LS_SLOTS) || '{}'); } catch { return {}; }
}

function refreshSlots() {
  const box = $('slots');
  box.innerHTML = '';
  const slots = readSlots();
  const names = Object.keys(slots);
  if (!names.length) { box.innerHTML = '<div class="muted">пусто</div>'; return; }
  for (const n of names) {
    const row = document.createElement('div');
    row.className = 'slotRow';
    const b = document.createElement('button');
    b.textContent = n;
    b.addEventListener('click', () => { pushUndo(); ed.level = deserializeLevel(slots[n]); centerView(); afterEdit(true); });
    const d = document.createElement('button');
    d.className = 'del'; d.textContent = '×'; d.title = 'Удалить';
    d.addEventListener('click', () => {
      const s = readSlots(); delete s[n];
      localStorage.setItem(LS_SLOTS, JSON.stringify(s));
      refreshSlots();
    });
    row.append(b, d);
    box.appendChild(row);
  }
}

function bindNum(id, fn) {
  const el = $(id);
  el.addEventListener('input', () => { const v = parseFloat(el.value); if (!isNaN(v)) fn(v); });
}

function bindLevel(id, key, conv, rebuild) {
  const el = $(id);
  el.addEventListener('change', () => {
    pushUndo();
    ed.level[key] = conv(el.value);
    if (key === 'cell') {
      ed.level.spawn.x = ed.level.w * ed.level.cell * 0.5;
      ed.level.spawn.z = ed.level.h * ed.level.cell * 0.5;
    }
    afterEdit(true);
  });
}

function setTool(t) {
  ed.tool = t;
  for (const b of document.querySelectorAll('.tool')) b.classList.toggle('on', b.dataset.tool === t);
  $('featSection').classList.toggle('dim', t !== TOOL.FEAT);
  $('matSection').classList.toggle('dim', t !== TOOL.MAT && t !== TOOL.ROOM);
}

function syncProps() {
  const lv = ed.level;
  $('floorVal').value = ed.floorValue.toFixed(2);
  $('ceilVal').value = ed.ceilValue.toFixed(2);
  $('brushVal').value = ed.brush;
  $('rotVal').value = String(ed.rotValue);
  $('lvName').value = lv.name;
  $('lvWater').value = lv.waterY;
  $('lvCell').value = lv.cell;
  $('lvCaustic').value = lv.causticStrength;
  $('lvExposure').value = lv.exposure ?? '';
  $('lvFog').value = lv.fogDensity ?? '';
  $('lvAz').value = lv.sunAzimuth ?? '';
  $('lvEl').value = lv.sunElevation ?? '';
  $('envSel').value = lv.env;
  for (const b of document.querySelectorAll('.swatch')) b.classList.toggle('on', Number(b.dataset.mat) === ed.matValue);
  for (const b of document.querySelectorAll('.feat')) b.classList.toggle('on', Number(b.dataset.feat) === ed.featValue);
}

function centerView() {
  ed.layerDirty = true;
  const c = cv();
  ed.view.scale = Math.max(6, Math.min(30, Math.min(c.width / (ed.level.w + 2), c.height / (ed.level.h + 2))));
  ed.view.x = ed.level.w / 2 - c.width / ed.view.scale / 2;
  ed.view.y = ed.level.h / 2 - c.height / ed.view.scale / 2;
}

// ---------------------------------------------------------------- события canvas

function initCanvas() {
  const c = cv();
  const resize = () => {
    const box = $('gridWrap').getBoundingClientRect();
    c.width = Math.max(1, Math.floor(box.width));
    c.height = Math.max(1, Math.floor(box.height));
    ed.layerDirty = true;
    drawGrid();
  };
  window.addEventListener('resize', () => { resize(); resizePreview(); });
  resize();
  centerView();
  drawGrid();

  c.addEventListener('contextmenu', e => e.preventDefault());

  c.addEventListener('mousedown', e => {
    const r = c.getBoundingClientRect();
    const cell = screenToCell(e.clientX - r.left, e.clientY - r.top);
    if (e.button === 1 || e.altKey) { ed.drag = { pan: true, x: e.clientX, y: e.clientY }; return; }
    const erase = e.button === 2;

    if (ed.tool === TOOL.SPAWN) {
      pushUndo();
      ed.level.spawn.x = (cell.i + 0.5) * ed.level.cell;
      ed.level.spawn.z = (cell.j + 0.5) * ed.level.cell;
      afterEdit();
      return;
    }
    if (e.shiftKey) { ed.rectStart = cell; ed.drag = { rect: true, erase }; drawGrid(); return; }
    if (ed.tool === TOOL.FILL || e.ctrlKey) { pushUndo(); floodFill(cell.i, cell.j, erase); afterEdit(); return; }

    pushUndo();
    paintBrush(cell.i, cell.j, erase);
    ed.drag = { paint: true, erase, last: cell };
    afterEdit();
  });

  c.addEventListener('mousemove', e => {
    const r = c.getBoundingClientRect();
    const px = e.clientX - r.left, py = e.clientY - r.top;
    const cell = screenToCell(px, py);
    const changed = !ed.hover || ed.hover.i !== cell.i || ed.hover.j !== cell.j;
    ed.hover = inside(ed.level, cell.i, cell.j)
      ? { i: cell.i, j: cell.j, k: cell.j * ed.level.w + cell.i } : null;

    if (ed.drag?.pan) {
      ed.view.x -= (e.clientX - ed.drag.x) / ed.view.scale;
      ed.view.y -= (e.clientY - ed.drag.y) / ed.view.scale;
      ed.drag.x = e.clientX; ed.drag.y = e.clientY;
      ed.layerDirty = true;
      drawGrid();
      return;
    }
    if (ed.drag?.paint && changed) {
      // линия между клетками, чтобы не было разрывов при быстром движении
      const a = ed.drag.last, b = cell;
      const steps = Math.max(Math.abs(b.i - a.i), Math.abs(b.j - a.j));
      for (let s = 1; s <= steps; s++) {
        paintBrush(Math.round(a.i + (b.i - a.i) * s / steps), Math.round(a.j + (b.j - a.j) * s / steps), ed.drag.erase);
      }
      ed.drag.last = cell;
      ed.layerDirty = true;
      drawGrid(); schedulePreview(); updateStatus(true);
      return;
    }
    if (changed) { drawGrid(); updateStatus(); }
  });

  window.addEventListener('mouseup', e => {
    if (ed.drag?.rect && ed.rectStart && ed.hover) {
      pushUndo();
      paintRect(ed.rectStart, ed.hover, ed.drag.erase);
      afterEdit();
    } else if (ed.drag?.paint) {
      afterEdit();
    }
    ed.drag = null; ed.rectStart = null;
    drawGrid();
  });

  c.addEventListener('mouseleave', () => { ed.hover = null; drawGrid(); });

  c.addEventListener('wheel', e => {
    e.preventDefault();
    const r = c.getBoundingClientRect();
    const px = e.clientX - r.left, py = e.clientY - r.top;
    const before = screenToCell(px, py);
    const f = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    ed.view.scale = Math.max(3, Math.min(72, ed.view.scale * f));
    const after = screenToCell(px, py);
    ed.view.x += before.i - after.i;
    ed.view.y += before.j - after.j;
    ed.layerDirty = true;
    drawGrid();
  }, { passive: false });

  // двойной клик — телепорт превью
  c.addEventListener('dblclick', e => {
    const r = c.getBoundingClientRect();
    const cell = screenToCell(e.clientX - r.left, e.clientY - r.top);
    if (!inside(ed.level, cell.i, cell.j) || !ed.engine) return;
    const k = cell.j * ed.level.w + cell.i;
    ed.orbit.target.set((cell.i + 0.5) * ed.level.cell, ed.level.f[k] + 1.6, (cell.j + 0.5) * ed.level.cell);
    ed.orbit.dist = 12;
  });
}

function initKeys() {
  window.addEventListener('keydown', e => {
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    ed.keys.add(e.code);
    ed.lastInteract = performance.now();

    if (e.ctrlKey && e.code === 'KeyZ') { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); return; }
    if (e.ctrlKey && e.code === 'KeyY') { e.preventDefault(); doRedo(); return; }
    if (e.ctrlKey && e.code === 'KeyS') { e.preventDefault(); $('btnSaveFile').click(); return; }

    const map = {
      Digit1: TOOL.ROOM, Digit2: TOOL.VOID, Digit3: TOOL.FLOOR, Digit4: TOOL.CEIL,
      Digit5: TOOL.MAT, Digit6: TOOL.FEAT, Digit7: TOOL.SPAWN, Digit8: TOOL.PICK
    };
    if (map[e.code]) setTool(map[e.code]);
    if (e.code === 'BracketLeft') { ed.brush = Math.max(1, ed.brush - 1); syncProps(); drawGrid(); }
    if (e.code === 'BracketRight') { ed.brush = Math.min(11, ed.brush + 1); syncProps(); drawGrid(); }
    if (e.code === 'KeyX') { ed.rotValue = (ed.rotValue + 1) % 4; syncProps(); }
    if (e.code === 'KeyR') { e.preventDefault(); rebuildPreview(); }
    if (e.code === 'Tab') { e.preventDefault(); setPvMode(ed.pvMode === 'fly' ? 'orbit' : 'fly'); }
  });
  window.addEventListener('keyup', e => ed.keys.delete(e.code));
  window.addEventListener('blur', () => ed.keys.clear());
  window.addEventListener('beforeunload', e => {
    if (ed.dirty) { e.preventDefault(); e.returnValue = ''; }
  });
}

// ---------------------------------------------------------------- старт

function boot() {
  try { bootInner(); }
  catch (e) {
    console.error(e);
    const s = $('stat'); if (s) s.textContent = 'Ошибка запуска: ' + e.message;
  }
}

function bootInner() {
  const saved = localStorage.getItem(LS_AUTOSAVE);
  if (saved) {
    try { ed.level = deserializeLevel(saved); } catch { ed.level = demoLevel(); }
  } else ed.level = demoLevel();

  ed.floorValue = 0;
  ed.ceilValue = ed.level.ceilingDefault ?? 5.5;

  buildUI();
  initCanvas();
  initKeys();
  syncProps();
  updateStatus();
  window.__ed = ed;
  initPreview();
  requestAnimationFrame(previewLoop);

  // если контейнер ещё не получил размер (скрытая вкладка), досчитаем позже
  if (!cv().width || cv().height < 2) {
    const retry = () => {
      window.dispatchEvent(new Event('resize'));
      if (!cv().width || cv().height < 2) setTimeout(retry, 250);
    };
    setTimeout(retry, 120);
  }
}

boot();
