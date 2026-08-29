'use strict';
/**
 * Геометрия уровня на сервере — порт `src/core/level.js` без three.js.
 *
 * Нужен, чтобы realtime сам считал, где пол, где стена и где глубоко: под
 * общих монстров сервер должен «понимать» карту так же, как клиент. Логику
 * копируем один-в-один — расхождение здесь означало бы, что монстры на сервере
 * ходят по другой карте, чем видит игрок. Есть юнит-тест, который сверяет
 * floorAt/isOpen серверной и клиентской версии на демо-уровнях.
 *
 * Матрицы уровня приходят с клиента сжатыми (RLE) — тот же формат, что в игре.
 */

const CELL = { VOID: 0, ROOM: 1 };
const FEAT = {
  NONE: 0, COLUMN_SQ: 1, COLUMN_ROUND: 2, ARCH: 3, DOOR: 4, WINDOW: 5,
  STAIRS: 6, LADDER: 7, RAILING: 8, PLANT: 9, LAMP: 10, SIGN: 11, CHAIR: 12,
  BALL: 13, GRATE: 14, SLIDE: 15, BENCH: 16, LIGHT: 17, NEON: 18,
  FLOORLIGHT: 19, CEILSPOT: 20, SPHERE: 21, SHOWER: 22, NEONTEXT: 23
};
const LEVEL_VERSION = 3;

function idx(level, i, j) { return j * level.w + i; }
function inside(level, i, j) { return i >= 0 && j >= 0 && i < level.w && j < level.h; }
function isRoom(level, i, j) { return inside(level, i, j) && level.t[j * level.w + i] === CELL.ROOM; }

function rleDecode(enc, Type, length) {
  const arr = new Type(length);
  let p = 0;
  for (const e of enc) {
    if (Array.isArray(e)) { for (let k = 0; k < e[1] && p < length; k++) arr[p++] = e[0]; }
    else arr[p++] = e;
  }
  return arr;
}

function createLevel(w = 40, h = 40, cell = 4) {
  const n = w * h;
  return {
    version: LEVEL_VERSION, name: 'Новый уровень', w, h, cell,
    waterY: 0.9, env: 'clinic', ceilingDefault: 5.0, floorDefault: 0.0,
    spawn: { x: w * cell * 0.5, z: h * cell * 0.5, yaw: 0 },
    t: new Uint8Array(n), f: new Float32Array(n), c: new Float32Array(n).fill(5),
    o: new Uint8Array(n), r: new Uint8Array(n), m: new Uint8Array(n)
  };
}

/** Разжать присланный уровень. Берём только то, что нужно серверу для геометрии. */
function deserializeLevel(json) {
  const d = typeof json === 'string' ? JSON.parse(json) : json;
  if (!d || !(d.w > 0) || !(d.h > 0)) return null;
  const n = d.w * d.h;
  const lv = createLevel(d.w, d.h, d.cell);
  lv.name = d.name != null ? d.name : 'Уровень';
  lv.waterY = d.waterY != null ? d.waterY : 0.9;
  lv.env = d.env != null ? d.env : 'clinic';
  lv.ceilingDefault = d.ceilingDefault != null ? d.ceilingDefault : 5;
  lv.floorDefault = d.floorDefault != null ? d.floorDefault : 0;
  lv.spawn = d.spawn || lv.spawn;
  lv.t = rleDecode(d.t, Uint8Array, n);
  lv.f = rleDecode(d.f, Float32Array, n);
  lv.c = rleDecode(d.c, Float32Array, n);
  lv.o = rleDecode(d.o, Uint8Array, n);
  lv.r = rleDecode(d.r, Uint8Array, n);
  lv.m = rleDecode(d.m, Uint8Array, n);
  return lv;
}

/** Порт `LevelGrid` из src/core/level.js. Держать в точности как там. */
class LevelGrid {
  constructor(level) {
    this.lv = level;
    this.cs = level.cell;
    this.blockers = [];
    for (let j = 0; j < level.h; j++) {
      for (let i = 0; i < level.w; i++) {
        const k = j * level.w + i;
        const o = level.o[k];
        if (level.t[k] === CELL.ROOM && (o === FEAT.COLUMN_SQ || o === FEAT.COLUMN_ROUND)) {
          this.blockers.push({
            x: (i + 0.5) * this.cs, z: (j + 0.5) * this.cs,
            r: o === FEAT.COLUMN_ROUND ? 0.60 : 0.72,
            round: o === FEAT.COLUMN_ROUND
          });
        }
      }
    }
  }

  cellAt(x, z) {
    const i = Math.floor(x / this.cs), j = Math.floor(z / this.cs);
    if (!inside(this.lv, i, j)) return null;
    return { i, j, k: j * this.lv.w + i };
  }

  isOpen(i, j) {
    if (!inside(this.lv, i, j)) return false;
    const k = j * this.lv.w + i;
    if (this.lv.t[k] !== CELL.ROOM) {
      const o = this.lv.o[k];
      return o === FEAT.ARCH || o === FEAT.DOOR;
    }
    return true;
  }

  floorAt(x, z) {
    const c = this.cellAt(x, z);
    if (!c) return 0;
    if (this.lv.t[c.k] !== CELL.ROOM) {
      const n = this._nearestRoom(c.i, c.j);
      return n ? this.lv.f[n] : 0;
    }
    return this.lv.f[c.k];
  }

  ceilAt(x, z) {
    const c = this.cellAt(x, z);
    if (!c) return 5;
    if (this.lv.t[c.k] !== CELL.ROOM) {
      const n = this._nearestRoom(c.i, c.j);
      return n ? this.lv.c[n] : 5;
    }
    return this.lv.c[c.k];
  }

  _nearestRoom(i, j) {
    const d = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (const [dx, dz] of d) {
      if (isRoom(this.lv, i + dx, j + dz)) return (j + dz) * this.lv.w + (i + dx);
    }
    return null;
  }

  move(x, z, dx, dz, r, y, maxStep = 0.65) {
    let nx = x + dx, nz = z + dz;
    nx = this._resolveAxis(nx, z, r, y, maxStep, x, 0);
    nz = this._resolveAxis(nx, nz, r, y, maxStep, z, 1);
    for (const b of this.blockers) {
      const ddx = nx - b.x, ddz = nz - b.z;
      const rr = b.r + r;
      if (b.round) {
        const d = Math.hypot(ddx, ddz);
        if (d < rr && d > 1e-5) { nx = b.x + ddx / d * rr; nz = b.z + ddz / d * rr; }
      } else {
        if (Math.abs(ddx) < rr && Math.abs(ddz) < rr) {
          if (Math.abs(ddx) / rr > Math.abs(ddz) / rr) nx = b.x + Math.sign(ddx || 1) * rr;
          else nz = b.z + Math.sign(ddz || 1) * rr;
        }
      }
    }
    return { x: nx, z: nz };
  }

  _resolveAxis(px, pz, r, y, maxStep, orig, axis) {
    const cs = this.cs;
    const samples = axis === 0
      ? [[px + r, pz], [px - r, pz], [px + r, pz + r * 0.7], [px + r, pz - r * 0.7], [px - r, pz + r * 0.7], [px - r, pz - r * 0.7]]
      : [[px, pz + r], [px, pz - r], [px + r * 0.7, pz + r], [px - r * 0.7, pz + r], [px + r * 0.7, pz - r], [px - r * 0.7, pz - r]];
    for (const [sx, sz] of samples) {
      const i = Math.floor(sx / cs), j = Math.floor(sz / cs);
      if (!this.isOpen(i, j)) return orig;
      const k = j * this.lv.w + i;
      if (this.lv.t[k] === CELL.ROOM) {
        if (this.lv.f[k] - y > maxStep) return orig;
        if (this.lv.c[k] - Math.max(y, this.lv.f[k]) < 1.2) return orig;
      }
    }
    return axis === 0 ? px : pz;
  }
}

/** «Глубокие» клетки — где вода глубже порога; там держатся сталкеры. */
function deepCells(level, grid, minDepth = 0.9) {
  const out = [];
  const cs = level.cell;
  for (let j = 0; j < level.h; j++) {
    for (let i = 0; i < level.w; i++) {
      const k = j * level.w + i;
      if (level.t[k] !== CELL.ROOM) continue;
      const x = (i + 0.5) * cs, z = (j + 0.5) * cs;
      if (level.waterY - level.f[k] >= minDepth) out.push({ x, z });
    }
  }
  return out;
}

module.exports = {
  CELL, FEAT, LEVEL_VERSION,
  idx, inside, isRoom, createLevel, deserializeLevel,
  LevelGrid, deepCells
};
