'use strict';
/**
 * ИИ монстров на сервере — headless-порт `src/game/monsters.js` без three.js
 * и без mesh. Считает только то, что видят игроки: позиции и состояния тварей,
 * приманки, артефакта и снарядов, плюс урон игрокам. Рендер остаётся на клиенте.
 *
 * Логику держим один-в-один с клиентом (её удобно сверять глазами по строкам).
 * Расхождение здесь — это твари, которые на сервере ведут себя иначе, чем
 * выглядят у игрока. Детерминизм не нужен: сервер — единственный источник,
 * он шлёт снимки, клиент их только рисует, поэтому Math.random допустим.
 *
 * Мультиплеер: сами классы ИИ написаны под ОДНОГО наблюдателя (view) — точный
 * порт клиента. Оркестратор World перед каждым тиком выбирает монстру
 * релевантного игрока (ближайшего), а «под взглядом» считает по всем.
 *
 * Пока НЕ портировано (отдельным шагом): растения и подбираемое (roe/snake/
 * plant — лечение и воздух). Они не двигают монстров, только меняют здоровье;
 * _kill поэтому лишь помечает труп, без выпадения.
 */

const { LevelGrid, collectDeepCells } = require('./level');

const EYE = 1.68;                 // высота глаз игрока над «ногами» (player.js)
const WADE_MAX = 1.1;             // глубже наземный не заходит
const ANNIHILATE_DIST = 2.6;     // ближе — наземный и подводный гасят друг друга
const SPIT_MAX = 24;

// Подбираемое: лечение и воздух. Значения один-в-один с клиентским PICKUP.
// r — радиус подбора. Цвет/меш — забота клиента, серверу не нужны.
const PICKUP = {
  plant: { heal: 0.20, air: 0.40, r: 1.1 },
  roe: { heal: 0.30, air: 0.18, r: 1.1 },
  snake: { heal: 0.18, air: 0.00, r: 1.1 }
};
const PICKUP_MAX = 48;

const DIFFICULTY = {
  calm: {
    name: 'Спокойно', air: 12, drown: 0.06, spitEvery: 5.0, spitDamage: 0.06, bite: 0.10,
    walkers: 2, stalkers: 2, speed: 0.85, regen: 0.085, lureCooldown: 5, respawn: 45,
    artifactDelay: 5, plantRegrow: 12, senseNear: 5, senseFar: 14, stalkMax: 8,
    retreatTime: 5, boredTime: 14
  },
  normal: {
    name: 'Обычно', air: 8, drown: 0.13, spitEvery: 3.0, spitDamage: 0.10, bite: 0.20,
    walkers: 3, stalkers: 3, speed: 1.0, regen: 0.045, lureCooldown: 8, respawn: 30,
    artifactDelay: 8, plantRegrow: 20, senseNear: 6, senseFar: 18, stalkMax: 11,
    retreatTime: 4, boredTime: 9
  },
  nightmare: {
    name: 'Кошмар', air: 5, drown: 0.24, spitEvery: 1.7, spitDamage: 0.15, bite: 0.34,
    walkers: 5, stalkers: 4, speed: 1.22, regen: 0.018, lureCooldown: 12, respawn: 16,
    artifactDelay: 12, plantRegrow: 32, senseNear: 8, senseFar: 24, stalkMax: 15,
    retreatTime: 3, boredTime: 5
  }
};

// --- векторная мелочь вместо THREE.Vector3/MathUtils ---
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp = (a, b, t) => a + (b - a) * t;
const dist3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/** Наблюдатель — серверная модель игрока для ИИ: ноги, глаза, взгляд, скорость. */
function eyeOf(view) { return { x: view.pos.x, y: view.pos.y + view.eye, z: view.pos.z }; }

// ---------------------------------------------------------------- существа

class Creature {
  constructor() {
    this.pos = { x: 0, y: 0, z: 0 };
    this.yaw = 0;
    this.target = { x: 0, y: 0, z: 0 };
    this.speed = 1;
    this.think = 0;
    this.dead = false;
    this.hp = 1;
  }
  hit(dmg) { this.hp -= dmg; return this.hp <= 0; }
  _turnTo(tx, tz, dt, rate) {
    const want = Math.atan2(tx - this.pos.x, tz - this.pos.z);
    let d = want - this.yaw;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    this.yaw += Math.max(-rate * dt, Math.min(rate * dt, d));
  }
}

/** Придонный: живёт в чаше, кусает только того, кто ушёл под воду. */
class Stalker extends Creature {
  constructor(grid, deep, waterY, cfg) {
    super();
    this.grid = grid; this.deep = deep; this.waterY = waterY; this.cfg = cfg;
    this.kind = 'stalker';
    this.hunting = false;
    this.hp = 2;
    this.state = 'patrol';
    this.stateT = 0;
    this.boredT = 0;
    this.orbit = Math.random() * 6.28;
    const s = deep[(Math.random() * deep.length) | 0];
    this.pos.x = s.x; this.pos.y = waterY - 1.0; this.pos.z = s.z;
    this._pick();
  }
  _nearestDeep(x, z) {
    let best = this.deep[0], bd = Infinity;
    for (const p of this.deep) {
      const d = (p.x - x) ** 2 + (p.z - z) ** 2;
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  }
  _depthAt(x, z) { return this.waterY - this.grid.floorAt(x, z); }
  _pick() {
    const p = this.deep[(Math.random() * this.deep.length) | 0];
    const floor = this.waterY - p.depth;
    this.target.x = p.x;
    this.target.y = lerp(floor + 0.5, this.waterY - 0.7, Math.random());
    this.target.z = p.z;
    this.think = 3 + Math.random() * 4;
  }
  _noticeRadius(view) {
    const v = Math.hypot(view.vel.x, view.vel.y, view.vel.z);
    const c = this.cfg;
    return c.senseNear + (c.senseFar - c.senseNear) * Math.min(1, v / 3);
  }
  _setState(st) { this.state = st; this.stateT = 0; }
  _pickAwayFrom(view) {
    let best = this.deep[0], bd = -1;
    for (let k = 0; k < 12; k++) {
      const p = this.deep[(Math.random() * this.deep.length) | 0];
      const d = (p.x - view.pos.x) ** 2 + (p.z - view.pos.z) ** 2;
      if (d > bd) { bd = d; best = p; }
    }
    this.target.x = best.x;
    this.target.y = this.waterY - Math.min(1.2, best.depth * 0.5);
    this.target.z = best.z;
  }
  _think(dt, view, submerged, d, hooks) {
    const c = this.cfg;
    switch (this.state) {
      case 'stalk': {
        this.orbit += dt * 0.9;
        const r = 4.5;
        this.target.x = view.pos.x + Math.cos(this.orbit) * r;
        this.target.y = Math.min(view.pos.y + 0.3, this.waterY - 0.4);
        this.target.z = view.pos.z + Math.sin(this.orbit) * r;
        this.speed = 2.0 * c.speed;
        if (!submerged) {
          this._setState('patrol');
        } else if (d > this._noticeRadius(view) * 1.5 || this.stateT > c.stalkMax) {
          this.boredT = c.boredTime;
          this._setState('patrol');
        } else if (d < 6 && this.stateT > 1.5) {
          this._setState('strike');
          hooks.growl(0.8);
        }
        break;
      }
      case 'strike': {
        this.target.x = view.pos.x;
        this.target.y = Math.min(view.pos.y + 0.2, this.waterY - 0.4);
        this.target.z = view.pos.z;
        this.speed = 3.6 * c.speed;
        if (this.stateT > 1.7) this._setState('retreat');
        break;
      }
      case 'retreat': {
        if (this.stateT <= dt * 1.5) this._pickAwayFrom(view);
        this.speed = 2.4 * c.speed;
        if (this.stateT > c.retreatTime) { this.boredT = c.boredTime; this._setState('patrol'); }
        break;
      }
      default: {
        this.think -= dt;
        if (this.think <= 0 || dist3(this.pos, this.target) < 1.0) this._pick();
        this.speed = 1.15 * c.speed;
        if (submerged && this.boredT <= 0 && d < this._noticeRadius(view)) {
          this._setState('stalk');
          hooks.growl(0.5);
        }
      }
    }
  }
  update(dt, view, hooks, lure) {
    const submerged = (view.pos.y + view.eye) < this.waterY;
    const dToPlayer = dist3(this.pos, view.pos);
    const lureHere = lure.active && this._depthAt(lure.pos.x, lure.pos.z) > 1.0;

    this.stateT += dt;
    this.boredT = Math.max(0, this.boredT - dt);

    if (lureHere) {
      if (this.state !== 'lure') this._setState('lure');
      this.target.x = lure.pos.x;
      this.target.y = Math.min(lure.pos.y, this.waterY - 0.5);
      this.target.z = lure.pos.z;
      this.speed = 2.5 * this.cfg.speed;
    } else {
      if (this.state === 'lure') this._setState('patrol');
      this._think(dt, view, submerged, dToPlayer, hooks);
    }
    this.hunting = this.state === 'stalk' || this.state === 'strike';

    const turn = this.state === 'strike' ? 2.6 : this.hunting ? 1.8 : 1.1;
    this._turnTo(this.target.x, this.target.z, dt, turn);

    const dx = Math.sin(this.yaw), dz = Math.cos(this.yaw);
    let nx = this.pos.x + dx * this.speed * dt;
    let nz = this.pos.z + dz * this.speed * dt;
    if (this._depthAt(nx, nz) < 0.9) {
      const n = this._nearestDeep(this.pos.x, this.pos.z);
      this._turnTo(n.x, n.z, dt, 3.0);
      nx = this.pos.x; nz = this.pos.z;
    }
    this.pos.x = nx; this.pos.z = nz;
    this.pos.y += (this.target.y - this.pos.y) * Math.min(1, 1.4 * dt);
    const floor = this.grid.floorAt(this.pos.x, this.pos.z);
    this.pos.y = clamp(this.pos.y, floor + 0.35, this.waterY - 0.35);

    if (submerged && this.state === 'strike' && dToPlayer < 1.6) {
      hooks.hurt(view, this.cfg.bite);
      hooks.oxy(view, -0.12);
      const px = view.pos.x - this.pos.x, pz = view.pos.z - this.pos.z;
      const l = Math.hypot(px, pz) || 1;
      hooks.knock(view, px / l * 6, 0, pz / l * 6);
      hooks.growl(1);
      this._setState('retreat');
    }
  }
}

/** Долговязый: под взглядом стоит, плюётся только в того, кто на воздухе. */
class Walker extends Creature {
  constructor(grid, level, waterY, cfg) {
    super();
    this.grid = grid; this.lv = level; this.waterY = waterY; this.cfg = cfg;
    this.kind = 'walker';
    this.frozen = false;
    this.hp = 3;
    this.spitTimer = 1.5 + Math.random() * 2;
    this._wanderTo();
  }
  _depthAt(x, z) { return this.waterY - this.grid.floorAt(x, z); }
  _walkable(x, z) {
    const i = Math.floor(x / this.grid.cs), j = Math.floor(z / this.grid.cs);
    return this.grid.isOpen(i, j) && this._depthAt(x, z) <= WADE_MAX;
  }
  _randomOpenCell() {
    for (let n = 0; n < 60; n++) {
      const i = 1 + Math.floor(Math.random() * (this.lv.w - 2));
      const j = 1 + Math.floor(Math.random() * (this.lv.h - 2));
      const x = (i + 0.5) * this.grid.cs, z = (j + 0.5) * this.grid.cs;
      if (this.grid.isOpen(i, j) && this._depthAt(x, z) <= WADE_MAX) return { x, z };
    }
    return null;
  }
  placeAwayFrom(x, z, minDist) {
    for (let n = 0; n < 80; n++) {
      const c = this._randomOpenCell();
      if (!c) continue;
      if (Math.hypot(c.x - x, c.z - z) < minDist) continue;
      this.pos.x = c.x; this.pos.y = this.grid.floorAt(c.x, c.z); this.pos.z = c.z;
      return true;
    }
    return false;
  }
  _wanderTo() {
    const c = this._randomOpenCell();
    if (c) { this.target.x = c.x; this.target.y = 0; this.target.z = c.z; }
    this.think = 6 + Math.random() * 6;
  }
  _lineOfSight(to) {
    const dx = to.x - this.pos.x, dz = to.z - this.pos.z;
    const d = Math.hypot(dx, dz);
    const steps = Math.ceil(d / (this.grid.cs * 0.5));
    for (let s = 1; s < steps; s++) {
      const t = s / steps;
      const x = this.pos.x + dx * t, z = this.pos.z + dz * t;
      if (!this.grid.isOpen(Math.floor(x / this.grid.cs), Math.floor(z / this.grid.cs))) return false;
    }
    return true;
  }
  update(dt, view, hooks, lure, spits) {
    const eye = eyeOf(view);                  // клиентская camera.position
    const dx = this.pos.x - eye.x, dz = this.pos.z - eye.z;
    const dist = Math.hypot(dx, dz);
    const fwdX = -Math.sin(view.yaw), fwdZ = -Math.cos(view.yaw);
    const dot = dist > 0.01 ? (dx / dist) * fwdX + (dz / dist) * fwdZ : 1;
    const los = this._lineOfSight(eye);
    const watched = dot > 0.52 && los && dist < 40;

    const lureHere = lure.active;
    this.frozen = watched && !lureHere;

    if (!this.frozen) {
      if (lureHere) {
        this.target.x = lure.pos.x; this.target.y = 0; this.target.z = lure.pos.z;
        this.speed = 2.2;
      } else if (los && dist < 34) {
        this.target.x = eye.x; this.target.y = 0; this.target.z = eye.z;
        this.speed = 2.0;
      } else {
        this.think -= dt;
        if (this.think <= 0 || Math.hypot(this.target.x - this.pos.x, this.target.z - this.pos.z) < 1.2) this._wanderTo();
        this.speed = 0.85;
      }
      this.speed *= this.cfg.speed;
      this._turnTo(this.target.x, this.target.z, dt, 2.4);
      const step = this.grid.move(
        this.pos.x, this.pos.z,
        Math.sin(this.yaw) * this.speed * dt, Math.cos(this.yaw) * this.speed * dt,
        0.34, this.pos.y, 0.7);
      const dNew = this._depthAt(step.x, step.z);
      if (dNew <= WADE_MAX || dNew < this._depthAt(this.pos.x, this.pos.z)) {
        this.pos.x = step.x; this.pos.z = step.z;
      } else if (this.think > 0.4) {
        this._wanderTo();
      }
    } else {
      this._turnTo(eye.x, eye.z, dt, 1.2);
    }
    this.pos.y = this.grid.floorAt(this.pos.x, this.pos.z);

    const playerAbove = (view.pos.y + view.eye) >= this.waterY;
    this.spitTimer -= dt;
    if (this.cfg.spitEvery > 0 && playerAbove && !lureHere && los && dist < 26 && this.spitTimer <= 0) {
      this.spitTimer = this.cfg.spitEvery * (0.75 + Math.random() * 0.5);
      const from = { x: this.pos.x, y: this.pos.y + 2.3, z: this.pos.z };
      const to = { x: eye.x, y: eye.y - 0.1, z: eye.z };
      spits.fire(from, to, 15, this.cfg.spitDamage);
      hooks.growl(0.4);
    }

    if (dist < 1.7) {
      const l = dist || 1;
      hooks.knock(view, (-dx / l) * 26 * dt, 0, (-dz / l) * 26 * dt);
      hooks.growl(0.85);
    }
  }
}

/** Снаряды долговязых: летят по дуге и бьют игрока, если попали. */
class Spits {
  constructor() { this.items = []; }
  fire(from, to, speed, damage) {
    if (this.items.length >= SPIT_MAX) return;
    let vx = to.x - from.x, vy = to.y - from.y, vz = to.z - from.z;
    const dist = Math.hypot(vx, vy, vz) || 1;
    vx = vx / dist * speed; vy = vy / dist * speed; vz = vz / dist * speed;
    vy += dist * 0.055;
    this.items.push({ p: { x: from.x, y: from.y, z: from.z }, v: { x: vx, y: vy, z: vz }, life: 4, dmg: damage });
  }
  update(dt, views, grid, onHit) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const s = this.items[i];
      s.v.y -= 7.5 * dt;
      s.p.x += s.v.x * dt; s.p.y += s.v.y * dt; s.p.z += s.v.z * dt;
      s.life -= dt;

      let hitPlayer = false;
      for (const view of views) {
        const dx = s.p.x - view.pos.x, dz = s.p.z - view.pos.z;
        const dy = s.p.y - (view.pos.y + view.eye * 0.6);
        if ((dx * dx + dz * dz) < 0.36 && Math.abs(dy) < 1.0) { onHit(view, s.dmg); hitPlayer = true; break; }
      }
      const hitWorld = s.p.y < grid.floorAt(s.p.x, s.p.z)
        || !grid.isOpen(Math.floor(s.p.x / grid.cs), Math.floor(s.p.z / grid.cs));
      if (hitPlayer || hitWorld || s.life <= 0) this.items.splice(i, 1);
    }
  }
  clear() { this.items.length = 0; }
}

/** Брошенная приманка: шумит на месте и тянет к себе всех, кто её слышит. */
class Lure {
  constructor() {
    this.pos = { x: 0, y: 0, z: 0 };
    this.vel = { x: 0, y: 0, z: 0 };
    this.active = false;
    this.armed = false;
    this.life = 0;
  }
  /** eyePos — откуда бросок, dir — единичный вектор взгляда (yaw/pitch). */
  throwFrom(eyePos, dir, power = 11) {
    this.pos.x = eyePos.x; this.pos.y = eyePos.y; this.pos.z = eyePos.z;
    this.vel.x = dir.x * power; this.vel.y = dir.y * power + 2.2; this.vel.z = dir.z * power;
    this.active = true;
    this.armed = true;
    this.life = 14;
  }
  update(dt, grid, waterY) {
    if (!this.active) return;
    this.life -= dt;
    if (this.life <= 0) { this.active = false; return; }

    const inWater = this.pos.y < waterY;
    this.vel.y -= (inWater ? 2.6 : 17) * dt;
    if (inWater) { const k = Math.pow(0.06, dt); this.vel.x *= k; this.vel.y *= k; this.vel.z *= k; }
    const step = grid.move(this.pos.x, this.pos.z, this.vel.x * dt, this.vel.z * dt, 0.16, this.pos.y, 5);
    if (step.x === this.pos.x && this.vel.x !== 0) this.vel.x *= -0.35;
    if (step.z === this.pos.z && this.vel.z !== 0) this.vel.z *= -0.35;
    this.pos.x = step.x; this.pos.z = step.z;
    this.pos.y += this.vel.y * dt;

    if ((this.vel.x ** 2 + this.vel.y ** 2 + this.vel.z ** 2) < 4) this.armed = false;
    const floor = grid.floorAt(this.pos.x, this.pos.z);
    if (this.pos.y <= floor + 0.16) {
      this.pos.y = floor + 0.16;
      this.armed = false;
      this.vel.y = -this.vel.y * 0.25;
      this.vel.x *= 0.6; this.vel.z *= 0.6;
      if (Math.abs(this.vel.y) < 0.4) this.vel.y = 0;
    }
  }
}

/** Артефакт: светящийся предмет вглубине; один заряд обнаружения и переезд. */
class Artifact {
  constructor() {
    this.pos = { x: 0, y: 0, z: 0 };
    this.active = false;
    this.delay = 0;
  }
  place(grid, level, fromX, fromZ, minDist = 24) {
    for (let n = 0; n < 120; n++) {
      const i = 1 + Math.floor(Math.random() * (level.w - 2));
      const j = 1 + Math.floor(Math.random() * (level.h - 2));
      if (!grid.isOpen(i, j)) continue;
      const x = (i + 0.5) * grid.cs, z = (j + 0.5) * grid.cs;
      if (Math.hypot(x - fromX, z - fromZ) < minDist) continue;
      this.pos.x = x; this.pos.y = grid.floorAt(x, z) + 0.9; this.pos.z = z;
      this.active = true;
      return true;
    }
    return false;
  }
  /** Возвращает игрока, который его подобрал, либо null. */
  update(views) {
    if (!this.active) return null;
    for (const view of views) {
      const dx = this.pos.x - view.pos.x, dz = this.pos.z - view.pos.z;
      const dy = this.pos.y - (view.pos.y + view.eye * 0.5);
      if (dx * dx + dz * dz > 1.6 || Math.abs(dy) > 2) continue;
      this.active = false;
      return view;
    }
    return null;
  }
}

// ---------------------------------------------------------------- мир комнаты

/**
 * Оркестратор одной комнаты: держит уровень, тварей, приманку и артефакт,
 * тикает их и собирает воздействия на игроков. Аналог класса Monsters, но
 * серверный: игроков много, поэтому каждому монстру перед тиком выбираем
 * релевантного (ближайшего), а урон адресуем конкретному игроку.
 */
class World {
  constructor(level, difficulty = 'normal') {
    this.level = level;
    this.grid = new LevelGrid(level);
    this.cfg = DIFFICULTY[difficulty] || DIFFICULTY.normal;
    this.difficulty = DIFFICULTY[difficulty] ? difficulty : 'normal';
    this.waterY = level.waterY;
    this.list = [];
    this.spits = new Spits();
    this.lure = new Lure();
    this.artifact = new Artifact();
    this.kills = 0;
    this.lureCooldown = 0;
    this._respawn = this.cfg.respawn;
    this._growlCool = 0;
    this._nextId = 1;                 // стабильный id монстра — чтобы клиент
                                      // сопоставлял снимки и плавно двигал меши

    // Подбираемое: растения на дне и выпавшее из убитых. Как у клиента.
    this.pickups = { plant: [], roe: [], snake: [] };
    this._plantTarget = 0;
    this._plantTimer = this.cfg.plantRegrow;

    this.deep = collectDeepCells(level, this.grid, this.waterY);
    if (this.deep.length < 4) this.deep = null;

    this.artifact.place(this.grid, level, level.spawn.x, level.spawn.z, 24);
    for (let n = 0; n < this.cfg.walkers; n++) this._spawnWalker(level.spawn.x, level.spawn.z, 18);
    if (this.deep) {
      for (let n = 0; n < this.cfg.stalkers; n++) this._spawnStalker();
      this._plantTarget = Math.min(14, Math.max(5, (this.deep.length / 9) | 0));
      for (let k = 0; k < this._plantTarget; k++) this._growPlant();
    }
  }

  _spawnWalker(awayX, awayZ, minDist) {
    const wk = new Walker(this.grid, this.level, this.waterY, this.cfg);
    if (!wk.placeAwayFrom(awayX, awayZ, minDist)) return null;
    wk.id = this._nextId++;
    this.list.push(wk);
    return wk;
  }
  _spawnStalker() {
    if (!this.deep) return null;
    const st = new Stalker(this.grid, this.deep, this.waterY, this.cfg);
    st.id = this._nextId++;
    this.list.push(st);
    return st;
  }

  /** Монстру — ближайший игрок: одиночный ИИ так получает свою «камеру». */
  _nearest(views, mon) {
    let best = null, bd = Infinity;
    for (const v of views) {
      const d = (v.pos.x - mon.pos.x) ** 2 + (v.pos.z - mon.pos.z) ** 2;
      if (d < bd) { bd = d; best = v; }
    }
    return best;
  }

  _addPickup(kind, x, y, z) {
    const arr = this.pickups[kind];
    if (arr.length < PICKUP_MAX) arr.push({ x, y, z });
  }

  /** Растение на дно чаши в случайном месте — ради него и стоит нырять. */
  _growPlant() {
    if (!this.deep) return;
    const cs = this.grid.cs;
    const c = this.deep[(Math.random() * this.deep.length) | 0];
    this._addPickup('plant',
      c.x + (Math.random() - 0.5) * cs * 0.7,
      this.waterY - c.depth + 0.02,
      c.z + (Math.random() - 0.5) * cs * 0.7);
  }

  _plantTick(dt) {
    if (!this.deep || !this._plantTarget) return;
    if (this.pickups.plant.length >= this._plantTarget) { this._plantTimer = this.cfg.plantRegrow; return; }
    this._plantTimer -= dt;
    if (this._plantTimer > 0) return;
    this._plantTimer = this.cfg.plantRegrow;
    this._growPlant();
  }

  /** Подбор игроком: собираем близкое, отдаём суммарный эффект тому, кто собрал. */
  _collectPickups(views, hooks) {
    for (const kind of ['plant', 'roe', 'snake']) {
      const arr = this.pickups[kind], c = PICKUP[kind];
      for (const view of views) {
        let n = 0;
        for (let i = arr.length - 1; i >= 0; i--) {
          const it = arr[i];
          const dx = it.x - view.pos.x, dz = it.z - view.pos.z;
          const dy = it.y - (view.pos.y + view.eye * 0.5);
          if (dx * dx + dz * dz > c.r * c.r || Math.abs(dy) > 1.5) continue;
          arr.splice(i, 1); n++;
        }
        if (n) hooks.heal(view, c.heal * n, c.air * n);
      }
    }
  }

  _kill(c) {
    if (c.dead) return;
    c.dead = true;
    this.kills++;
    // Высыпаем добычу: из подводного — икра (roe), из наземного — змейки (snake).
    const kind = c.kind === 'stalker' ? 'roe' : 'snake';
    for (let k = 0; k < 3; k++) {
      this._addPickup(kind,
        c.pos.x + (Math.random() - 0.5) * 1.2,
        c.pos.y + (c.kind === 'stalker' ? (Math.random() - 0.5) * 0.5 : 0.15),
        c.pos.z + (Math.random() - 0.5) * 1.2);
    }
  }

  _checkAnnihilation(hooks) {
    for (const a of this.list) {
      if (a.dead || a.kind !== 'walker') continue;
      for (const b of this.list) {
        if (b.dead || b.kind !== 'stalker') continue;
        if (dist3(a.pos, b.pos) > ANNIHILATE_DIST) continue;
        this._kill(a);
        this._kill(b);
        hooks.annihilate(b.pos);
      }
    }
    if (this.list.some(c => c.dead)) this.list = this.list.filter(c => !c.dead);
  }

  _checkThrownHits(hooks) {
    const l = this.lure;
    if (!l.active || !l.armed) return;
    for (const c of this.list) {
      if (c.dead) continue;
      if (dist3(l.pos, c.pos) > 1.5) continue;
      l.armed = false;
      l.vel.x *= -0.3; l.vel.y *= -0.3; l.vel.z *= -0.3;
      if (c.hit(1)) this._kill(c);
      break;
    }
  }

  _respawnTick(dt, views) {
    const cfg = this.cfg;
    const walkers = this.list.reduce((n, c) => n + (c.kind === 'walker' ? 1 : 0), 0);
    const stalkers = this.list.length - walkers;
    const needW = walkers < cfg.walkers, needS = stalkers < (this.deep ? cfg.stalkers : 0);
    if (!needW && !needS) { this._respawn = cfg.respawn; return; }
    this._respawn -= dt;
    if (this._respawn > 0) return;
    this._respawn = cfg.respawn;
    const anchor = views[0] || { pos: this.level.spawn };
    if (needW) this._spawnWalker(anchor.pos.x, anchor.pos.z, 26);
    else this._spawnStalker();
  }

  /**
   * Один тик мира. views — массив игроков {pos,eye,yaw,vel,mode}. Возвращает
   * собранные события (урон, толчки, подбор артефакта, рык) — их применяет и
   * рассылает вызывающий (server.js).
   */
  step(dt, views) {
    const out = { hurt: [], knock: [], oxy: [], heal: [], growl: null, artifact: null, annihilate: [] };
    const hooks = {
      hurt: (view, dmg) => out.hurt.push({ view, dmg }),
      oxy: (view, d) => out.oxy.push({ view, d }),
      heal: (view, hp, air) => out.heal.push({ view, hp, air }),
      knock: (view, ix, iy, iz) => out.knock.push({ view, ix, iy, iz }),
      growl: (p) => { if (this._growlCool <= 0) { this._growlCool = 1.4 + Math.random(); out.growl = Math.max(out.growl || 0, p); } },
      annihilate: (p) => out.annihilate.push({ x: p.x, y: p.y, z: p.z })
    };

    this.lureCooldown = Math.max(0, this.lureCooldown - dt);
    this._growlCool -= dt;
    this.lure.update(dt, this.grid, this.waterY);

    if (views.length) {
      for (const c of this.list) {
        const view = this._nearest(views, c);
        if (c.kind === 'stalker') c.update(dt, view, hooks, this.lure);
        else c.update(dt, view, hooks, this.lure, this.spits);
      }
    }
    this.spits.update(dt, views, this.grid, (view, dmg) => out.hurt.push({ view, dmg }));

    const taker = this.artifact.update(views);
    if (taker) {
      out.artifact = taker;
      this.artifact.delay = this.cfg.artifactDelay;
    } else if (!this.artifact.active) {
      this.artifact.delay -= dt;
      if (this.artifact.delay <= 0) {
        const anchor = views[0] || { pos: this.level.spawn };
        this.artifact.place(this.grid, this.level, anchor.pos.x, anchor.pos.z, 30);
      }
    }

    if (views.length) this._collectPickups(views, hooks);
    this._plantTick(dt);
    this._checkThrownHits(hooks);
    this._checkAnnihilation(hooks);
    this._respawnTick(dt, views);
    return out;
  }

  /** Бросок приманки игроком. eyePos/dir считает вызывающий из yaw/pitch. */
  throwLure(eyePos, dir) {
    if (this.lureCooldown > 0) return false;
    this.lure.throwFrom(eyePos, dir);
    this.lureCooldown = this.cfg.lureCooldown;
    return true;
  }

  /** Снимок для клиентов: только то, что нужно нарисовать. */
  snapshot() {
    return {
      m: this.list.map(c => ({
        id: c.id,
        k: c.kind === 'stalker' ? 1 : 0,
        p: [r2(c.pos.x), r2(c.pos.y), r2(c.pos.z)],
        y: r2(c.yaw),
        s: c.kind === 'stalker' ? (c.hunting ? 1 : 0) : (c.frozen ? 1 : 0)
      })),
      sp: this.spits.items.map(s => [r2(s.p.x), r2(s.p.y), r2(s.p.z)]),
      lu: this.lure.active ? [r2(this.lure.pos.x), r2(this.lure.pos.y), r2(this.lure.pos.z)] : null,
      ar: this.artifact.active ? [r2(this.artifact.pos.x), r2(this.artifact.pos.y), r2(this.artifact.pos.z)] : null,
      pk: {
        plant: this.pickups.plant.map(i => [r2(i.x), r2(i.y), r2(i.z)]),
        roe: this.pickups.roe.map(i => [r2(i.x), r2(i.y), r2(i.z)]),
        snake: this.pickups.snake.map(i => [r2(i.x), r2(i.y), r2(i.z)])
      }
    };
  }
}

const r2 = (v) => Math.round(v * 100) / 100;

module.exports = { World, DIFFICULTY, Stalker, Walker, Lure, Artifact, Spits, EYE, WADE_MAX, ANNIHILATE_DIST };
