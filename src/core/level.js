// Схема уровня, сериализация (RLE), сетка коллизий, генератор демо-уровня.

export const CELL = { VOID: 0, ROOM: 1 };

export const FEAT = {
  NONE: 0,
  COLUMN_SQ: 1,
  COLUMN_ROUND: 2,
  ARCH: 3,
  DOOR: 4,
  WINDOW: 5,
  STAIRS: 6,
  LADDER: 7,
  RAILING: 8,
  PLANT: 9,
  LAMP: 10,
  SIGN: 11,
  CHAIR: 12,
  BALL: 13,
  GRATE: 14,
  SLIDE: 15,
  BENCH: 16,
  LIGHT: 17,
  NEON: 18,
  FLOORLIGHT: 19,
  CEILSPOT: 20,
  SPHERE: 21,
  SHOWER: 22,
  NEONTEXT: 23
};

export const FEAT_INFO = {
  [FEAT.NONE]:         { name: 'Ничего',            on: 'any',  icon: '·' },
  [FEAT.COLUMN_SQ]:    { name: 'Колонна кв.',       on: 'room', icon: '▣' },
  [FEAT.COLUMN_ROUND]: { name: 'Колонна кругл.',    on: 'room', icon: '◉' },
  [FEAT.ARCH]:         { name: 'Арка',              on: 'void', icon: '∩' },
  [FEAT.DOOR]:         { name: 'Дверной проём',     on: 'void', icon: '⌷' },
  [FEAT.WINDOW]:       { name: 'Окно-щель',         on: 'void', icon: '▤' },
  [FEAT.STAIRS]:       { name: 'Лестница',          on: 'room', icon: '⩙' },
  [FEAT.LADDER]:       { name: 'Лестница в воду',   on: 'room', icon: '⌸' },
  [FEAT.RAILING]:      { name: 'Ограждение',        on: 'room', icon: '⊥' },
  [FEAT.PLANT]:        { name: 'Растение',          on: 'room', icon: '❦' },
  [FEAT.LAMP]:         { name: 'Лампа',             on: 'room', icon: '☀' },
  [FEAT.SIGN]:         { name: 'Табличка',          on: 'room', icon: '⚑' },
  [FEAT.CHAIR]:        { name: 'Стул',              on: 'room', icon: '⑃' },
  [FEAT.BALL]:         { name: 'Мяч',               on: 'room', icon: '●' },
  [FEAT.GRATE]:        { name: 'Слив',              on: 'room', icon: '⌗' },
  [FEAT.SLIDE]:        { name: 'Горка',             on: 'room', icon: '⌇' },
  [FEAT.BENCH]:        { name: 'Скамья',            on: 'room', icon: '▬' },
  [FEAT.LIGHT]:        { name: 'Источник света',    on: 'room', icon: '✦' },
  [FEAT.NEON]:         { name: 'Неоновая полоса',   on: 'room', icon: '━' },
  [FEAT.FLOORLIGHT]:   { name: 'Свет в полу',       on: 'room', icon: '▭' },
  [FEAT.CEILSPOT]:     { name: 'Потолочные споты',  on: 'room', icon: '⁙' },
  [FEAT.SPHERE]:       { name: 'Сфера',             on: 'room', icon: '⬤' },
  [FEAT.SHOWER]:       { name: 'Душ',               on: 'room', icon: '⇊' },
  [FEAT.NEONTEXT]:     { name: 'Неон-вывеска',      on: 'room', icon: '≈' }
};

export const MATS = [
  { name: 'Белый мелкий кафель', color: 0xf2f4f2, grout: 0x8e9b98, size: 0.16 },
  { name: 'Тёплый кремовый',     color: 0xf0e8d8, grout: 0xa08f76, size: 0.16 },
  { name: 'Бирюзовый',           color: 0xcfe8e2, grout: 0x6e8f8a, size: 0.16 },
  { name: 'Крупная плитка',      color: 0xe8ebe9, grout: 0x93a09d, size: 0.42 },
  { name: 'Серый бетон',         color: 0xc8c9c4, grout: 0x8a8b86, size: 1.20 },
  { name: 'Тёмный кафель',       color: 0x5d6b6a, grout: 0x39433f, size: 0.16 }
];

export const LEVEL_VERSION = 3;

export function createLevel(w = 40, h = 40, cell = 4) {
  const n = w * h;
  return {
    version: LEVEL_VERSION,
    name: 'Новый уровень',
    w, h, cell,
    waterY: 0.9,
    env: 'clinic',
    sunAzimuth: null,          // null = взять из пресета
    sunElevation: null,
    fogDensity: null,
    exposure: null,
    causticStrength: 1.6,
    ceilingDefault: 5.0,
    floorDefault: 0.0,
    spawn: { x: w * cell * 0.5, z: h * cell * 0.5, yaw: 0 },
    t: new Uint8Array(n),
    f: new Float32Array(n),
    c: new Float32Array(n).fill(5),
    o: new Uint8Array(n),
    r: new Uint8Array(n),
    m: new Uint8Array(n)
  };
}

export function idx(level, i, j) { return j * level.w + i; }
export function inside(level, i, j) { return i >= 0 && j >= 0 && i < level.w && j < level.h; }
export function isRoom(level, i, j) { return inside(level, i, j) && level.t[j * level.w + i] === CELL.ROOM; }

// ---------------------------------------------------------------- сериализация

function rleEncode(arr, round) {
  const out = [];
  let prev = null, count = 0;
  for (let i = 0; i < arr.length; i++) {
    let v = arr[i];
    if (round != null) v = Math.round(v * round) / round;
    if (v === prev) count++;
    else { if (prev !== null) out.push(count === 1 ? prev : [prev, count]); prev = v; count = 1; }
  }
  if (prev !== null) out.push(count === 1 ? prev : [prev, count]);
  return out;
}

function rleDecode(enc, Type, length) {
  const arr = new Type(length);
  let p = 0;
  for (const e of enc) {
    if (Array.isArray(e)) { for (let k = 0; k < e[1] && p < length; k++) arr[p++] = e[0]; }
    else arr[p++] = e;
  }
  return arr;
}

export function serializeLevel(level) {
  return JSON.stringify({
    version: LEVEL_VERSION,
    name: level.name,
    w: level.w, h: level.h, cell: level.cell,
    waterY: level.waterY,
    env: level.env,
    sunAzimuth: level.sunAzimuth,
    sunElevation: level.sunElevation,
    fogDensity: level.fogDensity,
    exposure: level.exposure,
    causticStrength: level.causticStrength,
    ceilingDefault: level.ceilingDefault,
    floorDefault: level.floorDefault,
    spawn: level.spawn,
    t: rleEncode(level.t),
    f: rleEncode(level.f, 100),
    c: rleEncode(level.c, 100),
    o: rleEncode(level.o),
    r: rleEncode(level.r),
    m: rleEncode(level.m)
  });
}

export function deserializeLevel(json) {
  const d = typeof json === 'string' ? JSON.parse(json) : json;
  const n = d.w * d.h;
  const lv = createLevel(d.w, d.h, d.cell);
  Object.assign(lv, {
    name: d.name ?? 'Уровень',
    waterY: d.waterY ?? 0.9,
    env: d.env ?? 'clinic',
    sunAzimuth: d.sunAzimuth ?? null,
    sunElevation: d.sunElevation ?? null,
    fogDensity: d.fogDensity ?? null,
    exposure: d.exposure ?? null,
    causticStrength: d.causticStrength ?? 1.6,
    ceilingDefault: d.ceilingDefault ?? 5,
    floorDefault: d.floorDefault ?? 0,
    spawn: d.spawn ?? lv.spawn
  });
  lv.t = rleDecode(d.t, Uint8Array, n);
  lv.f = rleDecode(d.f, Float32Array, n);
  lv.c = rleDecode(d.c, Float32Array, n);
  lv.o = rleDecode(d.o, Uint8Array, n);
  lv.r = rleDecode(d.r, Uint8Array, n);
  lv.m = rleDecode(d.m, Uint8Array, n);
  return lv;
}

export function cloneLevel(level) { return deserializeLevel(serializeLevel(level)); }

// ---------------------------------------------------------------- коллизии

/** Сетка столкновений: пол/потолок по клеткам + скольжение вдоль стен. */
export class LevelGrid {
  constructor(level) {
    this.lv = level;
    this.cs = level.cell;
    // клетки с непроходимыми фичами (колонны)
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
      // арки и проёмы проходимы
      const o = this.lv.o[k];
      return o === FEAT.ARCH || o === FEAT.DOOR;
    }
    return true;
  }

  floorAt(x, z) {
    const c = this.cellAt(x, z);
    if (!c) return 0;
    if (this.lv.t[c.k] !== CELL.ROOM) {
      // в проёме — берём высоту соседней комнаты
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

  /**
   * Перемещение точки радиуса r из (x,z) на (x+dx, z+dz) со скольжением.
   * maxStep — максимальная высота ступеньки, на которую можно взойти.
   */
  move(x, z, dx, dz, r, y, maxStep = 0.65) {
    let nx = x + dx, nz = z + dz;
    nx = this._resolveAxis(nx, z, r, y, maxStep, x, 0);
    nz = this._resolveAxis(nx, nz, r, y, maxStep, z, 1);
    // колонны
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
        if (this.lv.f[k] - y > maxStep) return orig;                 // слишком высокая ступень
        if (this.lv.c[k] - Math.max(y, this.lv.f[k]) < 1.2) return orig; // низкий потолок
      }
    }
    return axis === 0 ? px : pz;
  }
}

// ---------------------------------------------------------------- демо-уровень

function rect(lv, x0, z0, x1, z1, fn) {
  for (let j = Math.max(0, z0); j <= Math.min(lv.h - 1, z1); j++)
    for (let i = Math.max(0, x0); i <= Math.min(lv.w - 1, x1); i++)
      fn(j * lv.w + i, i, j);
}

/**
 * Стартовый уровень: дневной затопленный вестибюль.
 * Клетка 3 м — пропорции ближе к реальным бассейнам, чем к площади.
 */
export function demoLevel() {
  const lv = createLevel(40, 46, 3);
  lv.name = 'Затопленный вестибюль';
  lv.env = 'clinic';
  lv.waterY = 0.75;
  lv.ceilingDefault = 5.5;
  lv.causticStrength = 1.5;

  const room = (x0, z0, x1, z1, floor = 0, ceil = 5.5, mat = 0) => {
    rect(lv, x0, z0, x1, z1, (k) => {
      lv.t[k] = CELL.ROOM; lv.f[k] = floor; lv.c[k] = ceil; lv.m[k] = mat;
    });
  };
  const put = (i, j, o, r = 0) => { const k = j * lv.w + i; lv.o[k] = o; lv.r[k] = r; };

  // ---- 1. главный зал 8×8 клеток (24×24 м), свод 7 м ----
  room(8, 8, 15, 15, 0.0, 7.0, 0);
  rect(lv, 10, 10, 13, 13, (k) => { lv.f[k] = -1.8; });   // чаша
  rect(lv, 11, 11, 12, 12, (k) => { lv.f[k] = -2.6; });   // глубокая часть

  for (const [i, j] of [[9, 9], [14, 9], [9, 14], [14, 14]]) put(i, j, FEAT.COLUMN_SQ);
  for (const [i, j] of [[8, 11], [15, 11], [8, 12], [15, 12]]) put(i, j, FEAT.COLUMN_ROUND);

  put(10, 9, FEAT.LADDER, 2);
  put(13, 14, FEAT.LADDER, 0);
  put(8, 8, FEAT.PLANT);
  put(15, 15, FEAT.PLANT);
  put(9, 15, FEAT.CHAIR);
  put(10, 15, FEAT.CHAIR);
  put(15, 8, FEAT.SIGN, 1);
  put(11, 12, FEAT.BALL);
  put(12, 10, FEAT.BALL);
  put(13, 8, FEAT.GRATE);

  // окна-щели в северной стене зала
  for (let i = 9; i <= 14; i += 2) {
    const k = 7 * lv.w + i;
    lv.o[k] = FEAT.WINDOW; lv.r[k] = 0; lv.f[k] = 0; lv.c[k] = 7.0;
  }

  // ---- 2. аркада на восток ----
  room(16, 10, 24, 13, 0.0, 4.6, 2);
  rect(lv, 18, 11, 23, 12, (k) => { lv.f[k] = -1.1; });
  for (const i of [17, 20, 23]) { put(i, 10, FEAT.COLUMN_ROUND); put(i, 13, FEAT.COLUMN_ROUND); }
  put(24, 11, FEAT.PLANT);
  // арки между залом и аркадой
  for (const j of [11, 12]) {
    const k = j * lv.w + 15;
    lv.t[k] = CELL.VOID; lv.o[k] = FEAT.ARCH; lv.r[k] = 1; lv.f[k] = 0; lv.c[k] = 4.6;
  }
  room(15, 11, 15, 12, 0.0, 7.0, 0);   // вернём клетки зала (арка левее)
  for (const j of [11, 12]) {
    const k = j * lv.w + 16;
    lv.t[k] = CELL.VOID; lv.o[k] = FEAT.ARCH; lv.r[k] = 1; lv.f[k] = 0; lv.c[k] = 4.6;
  }

  // ---- 3. низкий коридор на юг ----
  room(11, 16, 12, 26, -0.35, 2.8, 0);
  for (let j = 17; j <= 25; j += 3) { put(11, j, FEAT.LAMP, 0); }
  put(12, 20, FEAT.SIGN, 3);

  // ---- 4. дальний грот: глубокая вода, высокий свод ----
  room(6, 27, 18, 36, -3.2, 8.5, 5);
  rect(lv, 8, 29, 16, 34, (k) => { lv.f[k] = -5.0; });
  for (const i of [8, 11, 14, 17]) put(i, 31, FEAT.COLUMN_ROUND);
  put(7, 28, FEAT.BALL);
  put(17, 35, FEAT.BALL);
  // переход коридор -> грот
  room(11, 26, 12, 27, -1.6, 4.0, 5);

  // ---- 5. сухая терраса на западе ----
  room(2, 9, 6, 18, 1.2, 4.8, 1);
  for (const j of [10, 13, 16]) put(3, j, FEAT.PLANT);
  put(5, 11, FEAT.BENCH, 1);
  put(5, 16, FEAT.BENCH, 1);
  // ступени с террасы в зал
  for (const j of [11, 12]) put(7, j, FEAT.STAIRS, 1);
  room(7, 11, 7, 12, 0.0, 5.5, 0);
  for (const j of [11, 12]) put(7, j, FEAT.STAIRS, 3);
  // дверные проёмы в стене террасы
  for (const j of [14, 15]) {
    const k = j * lv.w + 7;
    lv.t[k] = CELL.VOID; lv.o[k] = FEAT.DOOR; lv.r[k] = 1; lv.f[k] = 0.6; lv.c[k] = 4.8;
  }
  room(8, 14, 8, 15, 0.6, 5.5, 0);
  for (let j = 10; j <= 17; j += 3) {
    const k = j * lv.w + 1;
    lv.o[k] = FEAT.WINDOW; lv.r[k] = 1; lv.f[k] = 1.2; lv.c[k] = 4.8;
  }

  lv.spawn = { x: 4.5 * 3, z: 13.5 * 3, yaw: Math.PI * 0.5 };
  return lv;
}

/** Второй уровень: полностью затопленные залы с неоном (тёмная тема). */
export function demoLevelDeep() {
  const lv = createLevel(36, 44, 3);
  lv.name = 'Глубокий конец';
  lv.env = 'deep';
  lv.waterY = 9.0;                  // выше всех потолков — залы затоплены целиком
  lv.causticStrength = 2.4;

  const room = (x0, z0, x1, z1, floor, ceil, mat = 0) => {
    rect(lv, x0, z0, x1, z1, (k) => {
      lv.t[k] = CELL.ROOM; lv.f[k] = floor; lv.c[k] = ceil; lv.m[k] = mat;
    });
  };
  const put = (i, j, o, r = 0) => { const k = j * lv.w + i; lv.o[k] = o; lv.r[k] = r; };

  // ---- 1. длинный сводчатый коридор ----
  room(15, 4, 20, 24, 0.0, 5.6, 0);
  for (let j = 5; j <= 23; j += 2) { put(15, j, FEAT.NEON, 3); put(20, j, FEAT.NEON, 1); }
  for (let j = 6; j <= 22; j += 3) { put(16, j, FEAT.FLOORLIGHT, 1); put(19, j, FEAT.FLOORLIGHT, 1); }
  for (const j of [8, 14, 20]) { put(20, j, FEAT.SPHERE, 1); put(15, j + 3, FEAT.SPHERE, 3); }
  put(17, 5, FEAT.NEONTEXT, 0);
  put(18, 12, FEAT.BALL);

  // ---- 2. зал с круглой чашей ----
  room(8, 25, 27, 39, 0.0, 8.0, 0);
  const ccx = 17.5, ccz = 32.0;
  rect(lv, 10, 26, 25, 38, (k, i, j) => {
    const d = Math.hypot(i - ccx, j - ccz);
    if (d < 4.0) lv.f[k] = -3.0;
    else if (d < 5.0) lv.f[k] = -1.1;
  });
  for (let a = 0; a < 14; a++) {
    const ang = (a / 14) * Math.PI * 2;
    const i = Math.round(ccx + Math.cos(ang) * 5.6);
    const j = Math.round(ccz + Math.sin(ang) * 5.6);
    if (isRoom(lv, i, j)) put(i, j, FEAT.FLOORLIGHT, a % 2);
  }
  for (let j = 26; j <= 38; j += 4) for (let i = 9; i <= 26; i += 4) if (isRoom(lv, i, j)) put(i, j, FEAT.CEILSPOT);
  for (let i = 9; i <= 26; i += 3) { put(i, 25, FEAT.NEON, 0); put(i, 39, FEAT.NEON, 2); }
  put(8, 28, FEAT.SPHERE, 3);
  put(27, 36, FEAT.SPHERE, 1);
  put(12, 34, FEAT.BALL);
  put(22, 29, FEAT.BALL);
  put(10, 31, FEAT.CHAIR);

  // арки коридор -> зал
  for (const i of [16, 17, 18, 19]) {
    const k = 24 * lv.w + i;
    lv.t[k] = CELL.VOID; lv.o[k] = FEAT.ARCH; lv.r[k] = 0; lv.f[k] = 0; lv.c[k] = 5.6;
  }

  // ---- 3. душевая ----
  room(4, 11, 8, 18, 0.4, 3.6, 5);
  for (let j = 12; j <= 17; j += 2) { put(4, j, FEAT.SHOWER, 3); put(8, j, FEAT.SHOWER, 1); }
  for (let j = 11; j <= 18; j += 2) { put(5, j, FEAT.CEILSPOT); put(7, j, FEAT.CEILSPOT); }
  for (let j = 12; j <= 17; j += 2) put(6, j, FEAT.FLOORLIGHT, 0);
  put(6, 18, FEAT.GRATE);
  put(6, 11, FEAT.NEONTEXT, 0);
  // переход душевая -> коридор
  room(9, 14, 14, 15, 0.2, 3.8, 0);
  for (const j of [14, 15]) {
    const k = j * lv.w + 14;
    lv.t[k] = CELL.VOID; lv.o[k] = FEAT.ARCH; lv.r[k] = 1; lv.f[k] = 0.1; lv.c[k] = 3.8;
  }

  // ---- 4. тупик в конце коридора ----
  room(16, 2, 19, 3, 0.0, 3.6, 5);
  put(17, 2, FEAT.NEON, 0);

  lv.spawn = { x: 17.5 * 3, z: 22.5 * 3, yaw: Math.PI };
  return lv;
}
