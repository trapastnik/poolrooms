/**
 * Обитатели и борьба с ними.
 *
 * Два вида. «Долговязый» ходит по залам, замирает под взглядом и плюётся — но
 * только в того, кто стоит на воздухе. «Придонный» живёт в чаше и кусает — но
 * только того, кто ушёл под воду. Условия взаимоисключающие: на суше опасен
 * первый, под водой второй, и спасение от одного всегда ведёт к другому.
 *
 * Оружия нет. Есть приманка: брошенный предмет шумит и тянет к себе обоих.
 * Если наземный и подводный сойдутся вплотную — они уничтожают друг друга.
 * Это и есть инструмент борьбы: не стрелять, а сводить.
 *
 * Стоимость держим низкой намеренно: у каждого монстра одна слитая геометрия
 * (один вызов отрисовки), плевки — общий InstancedMesh (ещё один вызов),
 * анимация целиком в вершинном шейдере, тени никто не отбрасывает.
 */
import * as THREE from 'three';

// слои для режима обнаружения: обитатели и еда подсвечиваются отдельно
export const REVEAL_MONSTER = 1;
export const REVEAL_FOOD = 2;

// ---------------------------------------------------------------- сложность

export const DIFFICULTY = {
  calm: {
    name: 'Спокойно',
    air: 12,            // секунд под водой до нуля кислорода
    drown: 0.06,        // здоровья в секунду, когда воздух кончился
    spitEvery: 5.0,     // секунд между плевками (0 — не плюются)
    spitDamage: 0.06,
    bite: 0.10,         // здоровья в секунду в зубах
    walkers: 2, stalkers: 2,
    speed: 0.85,
    regen: 0.085,       // здоровья в секунду в покое
    lureCooldown: 5,
    respawn: 45,        // секунд до замены выбывшего обитателя
    artifactDelay: 5,   // секунд до появления нового артефакта
    plantRegrow: 12,    // секунд на отрастание одного растения
    // повадки подводного: замечает вблизи, дальше — только если шуметь
    senseNear: 5, senseFar: 14,
    stalkMax: 8,        // секунд преследования, потом бросает
    retreatTime: 5,     // секунд уходит прочь после броска
    boredTime: 14       // секунд не интересуется вообще
  },
  normal: {
    name: 'Обычно',
    air: 8, drown: 0.13, spitEvery: 3.0, spitDamage: 0.10, bite: 0.20,
    walkers: 3, stalkers: 3, speed: 1.0, regen: 0.045, lureCooldown: 8, respawn: 30,
    artifactDelay: 8, plantRegrow: 20,
    senseNear: 6, senseFar: 18, stalkMax: 11, retreatTime: 4, boredTime: 9
  },
  nightmare: {
    name: 'Кошмар',
    air: 5, drown: 0.24, spitEvery: 1.7, spitDamage: 0.15, bite: 0.34,
    walkers: 5, stalkers: 4, speed: 1.22, regen: 0.018, lureCooldown: 12, respawn: 16,
    artifactDelay: 12, plantRegrow: 32,
    senseNear: 8, senseFar: 24, stalkMax: 15, retreatTime: 3, boredTime: 5
  }
};

// ---------------------------------------------------------------- геометрия

/** Слить части в одну геометрию: один монстр — один вызов отрисовки. */
function mergeParts(parts) {
  let total = 0;
  const prepped = [];
  for (const { geo, matrix } of parts) {
    const g = geo.index ? geo.toNonIndexed() : geo.clone();
    if (matrix) g.applyMatrix4(matrix);
    g.computeVertexNormals();          // без индексов нормали выходят плоскими — так и надо
    total += g.attributes.position.count;
    prepped.push(g);
  }
  const pos = new Float32Array(total * 3);
  const nrm = new Float32Array(total * 3);
  let o = 0;
  for (const g of prepped) {
    pos.set(g.attributes.position.array, o * 3);
    nrm.set(g.attributes.normal.array, o * 3);
    o += g.attributes.position.count;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  out.computeBoundingSphere();
  out.computeBoundingBox();
  return out;
}

/** Веретено вдоль оси Z: кольца переменного радиуса, концы сходятся в точку. */
function spindle(len, maxR, rings = 14, radial = 7) {
  const v = [];
  const ring = (t) => {
    const s = Math.sin(Math.PI * Math.pow(t, 0.75));
    return { r: maxR * Math.pow(s, 0.65) * (1 - 0.35 * t), z: (t - 0.5) * len };
  };
  for (let i = 0; i < rings; i++) {
    const a = ring(i / rings), b = ring((i + 1) / rings);
    for (let k = 0; k < radial; k++) {
      const t0 = k / radial * Math.PI * 2, t1 = (k + 1) / radial * Math.PI * 2;
      const p = (c, ang) => [Math.cos(ang) * c.r, Math.sin(ang) * c.r * 0.72, c.z];
      const A = p(a, t0), B = p(a, t1), C = p(b, t1), D = p(b, t0);
      v.push(...A, ...B, ...C, ...A, ...C, ...D);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(v), 3));
  return g;
}

/** Плоский плавник в плоскости YZ. */
function fin(h, z0, z1, thick = 0.02) {
  const v = [];
  const side = (x) => v.push(x, 0, z0, x, h, (z0 + z1) / 2, x, 0, z1);
  side(-thick); side(thick);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(v), 3));
  return g;
}

function buildStalkerGeo() {
  const m = (x, y, z) => new THREE.Matrix4().setPosition(x, y, z);
  return mergeParts([
    { geo: spindle(3.4, 0.34) },
    { geo: fin(0.42, -0.6, 0.9), matrix: m(0, 0.16, 0) },
    { geo: fin(0.30, 1.15, 1.72), matrix: m(0, 0.10, 0) },
    { geo: fin(0.26, 1.15, 1.72), matrix: m(0, -0.36, 0) },
    { geo: new THREE.BoxGeometry(0.30, 0.16, 0.42), matrix: m(0, 0, -1.62) }
  ]);
}

function buildWalkerGeo() {
  const at = (x, y, z) => new THREE.Matrix4().setPosition(x, y, z);
  const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
  return mergeParts([
    { geo: box(0.30, 0.34, 0.26), matrix: at(0, 2.42, 0) },      // голова
    { geo: box(0.11, 0.22, 0.11), matrix: at(0, 2.16, 0) },      // шея
    { geo: box(0.42, 0.92, 0.22), matrix: at(0, 1.62, 0) },      // торс
    { geo: box(0.10, 1.16, 0.10), matrix: at(-0.32, 1.58, 0) },  // руки — длинные
    { geo: box(0.10, 1.16, 0.10), matrix: at(0.32, 1.58, 0) },
    { geo: box(0.13, 1.16, 0.13), matrix: at(-0.13, 0.58, 0) },  // ноги
    { geo: box(0.13, 1.16, 0.13), matrix: at(0.13, 0.58, 0) }
  ]);
}

// ---------------------------------------------------------------- материалы

/** Standard-материал с колебанием, вшитым в вершинный шейдер. */
function animatedMaterial(opts, axis, wave) {
  const mat = new THREE.MeshStandardMaterial(opts);
  const uniforms = { uTime: { value: 0 }, uWave: { value: 1 } };
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uniforms.uTime;
    shader.uniforms.uWave = uniforms.uWave;
    shader.vertexShader = `uniform float uTime;\nuniform float uWave;\n` + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>\n  { float s = transformed.${axis}; ${wave} }`
    );
  };
  mat.userData.uniforms = uniforms;
  return mat;
}

// ---------------------------------------------------------------- плевки

const SPIT_MAX = 24;

/** Пул плевков одним InstancedMesh: сколько бы их ни летело, это один вызов. */
class Spits {
  constructor(scene) {
    const geo = new THREE.IcosahedronGeometry(0.11, 0);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x223034, roughness: 0.35, metalness: 0, emissive: 0x0d1a1c, emissiveIntensity: 1.4
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, SPIT_MAX);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    scene.add(this.mesh);
    this.items = [];
    this._m = new THREE.Matrix4();
    this._hidden = new THREE.Matrix4().makeScale(0, 0, 0);
    this._sync();
  }
  fire(from, to, speed, damage) {
    if (this.items.length >= SPIT_MAX) return;
    const v = to.clone().sub(from);
    const dist = v.length() || 1;
    v.divideScalar(dist).multiplyScalar(speed);
    v.y += dist * 0.055;                       // навесом, чтобы долетало
    this.items.push({ p: from.clone(), v, life: 4, dmg: damage });
  }
  update(dt, player, grid, onHit) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const s = this.items[i];
      s.v.y -= 7.5 * dt;
      s.p.addScaledVector(s.v, dt);
      s.life -= dt;

      const dx = s.p.x - player.pos.x, dz = s.p.z - player.pos.z;
      const dy = s.p.y - (player.pos.y + player.eye * 0.6);
      const hitPlayer = (dx * dx + dz * dz) < 0.36 && Math.abs(dy) < 1.0;
      const hitWorld = s.p.y < grid.floorAt(s.p.x, s.p.z)
        || !grid.isOpen(Math.floor(s.p.x / grid.cs), Math.floor(s.p.z / grid.cs));

      if (hitPlayer) onHit(s.dmg);
      if (hitPlayer || hitWorld || s.life <= 0) this.items.splice(i, 1);
    }
    this._sync();
  }
  _sync() {
    for (let i = 0; i < SPIT_MAX; i++) {
      if (i < this.items.length) {
        this._m.makeTranslation(this.items[i].p.x, this.items[i].p.y, this.items[i].p.z);
        this.mesh.setMatrixAt(i, this._m);
      } else {
        this.mesh.setMatrixAt(i, this._hidden);
      }
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
  clear() { this.items.length = 0; this._sync(); }
  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.mesh.parent?.remove(this.mesh);
  }
}

/** Брошенная приманка: шумит на месте и тянет к себе всех, кто её слышит. */
class Lure {
  constructor(scene) {
    const geo = new THREE.IcosahedronGeometry(0.16, 1);
    this.mat = new THREE.MeshStandardMaterial({
      color: 0xffd98a, roughness: 0.4, metalness: 0.1, emissive: 0xffb02e, emissiveIntensity: 2.2
    });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.castShadow = false;
    this.mesh.visible = false;
    scene.add(this.mesh);
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.active = false;
    this.life = 0;
  }
  throwFrom(camera, power = 11) {
    this.pos.copy(camera.position);
    camera.getWorldDirection(this.vel);
    this.vel.multiplyScalar(power);
    this.vel.y += 2.2;
    this.active = true;
    this.armed = true;          // пока летит — бьёт того, в кого попала
    this.life = 14;
    this.mesh.visible = true;
  }
  update(dt, grid, waterY) {
    if (!this.active) return;
    this.life -= dt;
    if (this.life <= 0) { this.active = false; this.mesh.visible = false; return; }

    const inWater = this.pos.y < waterY;
    this.vel.y -= (inWater ? 2.6 : 17) * dt;         // в воде тонет медленно
    if (inWater) this.vel.multiplyScalar(Math.pow(0.06, dt));
    const step = grid.move(this.pos.x, this.pos.z, this.vel.x * dt, this.vel.z * dt, 0.16, this.pos.y, 5);
    if (step.x === this.pos.x && this.vel.x !== 0) this.vel.x *= -0.35;
    if (step.z === this.pos.z && this.vel.z !== 0) this.vel.z *= -0.35;
    this.pos.x = step.x; this.pos.z = step.z;
    this.pos.y += this.vel.y * dt;

    if (this.vel.lengthSq() < 4) this.armed = false;   // выдохся — больше не снаряд
    const floor = grid.floorAt(this.pos.x, this.pos.z);
    if (this.pos.y <= floor + 0.16) {
      this.pos.y = floor + 0.16;
      this.armed = false;
      this.vel.y = -this.vel.y * 0.25;
      this.vel.x *= 0.6; this.vel.z *= 0.6;
      if (Math.abs(this.vel.y) < 0.4) this.vel.y = 0;
    }
    this.mesh.position.copy(this.pos);
    // пульсация, чтобы было видно, что предмет ещё «звучит»
    this.mat.emissiveIntensity = 1.4 + Math.sin(this.life * 9) * 0.9;
  }
  dispose() {
    this.mesh.geometry.dispose();
    this.mat.dispose();
    this.mesh.parent?.remove(this.mesh);
  }
}

/**
 * Артефакт: ярко светящийся предмет, ради которого и стоит уходить вглубь.
 * Даёт один заряд обнаружения и тут же появляется в новом месте — так способность
 * не висит на кнопке, а каждый раз оплачивается вылазкой.
 */
class Artifact {
  constructor(parent) {
    this.mat = new THREE.MeshStandardMaterial({
      color: 0xfff0c0, roughness: 0.25, metalness: 0.1,
      emissive: 0xffd23a, emissiveIntensity: 6
    });
    this.mesh = new THREE.Mesh(new THREE.OctahedronGeometry(0.26, 0), this.mat);
    this.mesh.castShadow = false;
    this.mesh.visible = false;
    parent.add(this.mesh);
    this.pos = new THREE.Vector3();
    this.active = false;
    this.delay = 0;
  }
  /** Случайная проходимая клетка не ближе minDist от игрока. */
  place(grid, level, fromX, fromZ, minDist = 24) {
    for (let n = 0; n < 120; n++) {
      const i = 1 + Math.floor(Math.random() * (level.w - 2));
      const j = 1 + Math.floor(Math.random() * (level.h - 2));
      if (!grid.isOpen(i, j)) continue;
      const x = (i + 0.5) * grid.cs, z = (j + 0.5) * grid.cs;
      if (Math.hypot(x - fromX, z - fromZ) < minDist) continue;
      this.pos.set(x, grid.floorAt(x, z) + 0.9, z);
      this.mesh.position.copy(this.pos);
      this.active = true;
      this.mesh.visible = true;
      return true;
    }
    return false;
  }
  /** true, если игрок его подобрал. */
  update(dt, time, player) {
    if (!this.active) return false;
    this.mesh.rotation.y = time * 0.8;
    this.mesh.rotation.x = Math.sin(time * 0.6) * 0.3;
    this.mesh.position.y = this.pos.y + Math.sin(time * 1.4) * 0.12;
    this.mat.emissiveIntensity = 5 + Math.sin(time * 3.1) * 2;
    const dx = this.pos.x - player.pos.x, dz = this.pos.z - player.pos.z;
    const dy = this.pos.y - (player.pos.y + player.eye * 0.5);
    if (dx * dx + dz * dz > 1.6 || Math.abs(dy) > 2) return false;
    this.active = false;
    this.mesh.visible = false;
    return true;
  }
  dispose() {
    this.mesh.geometry.dispose();
    this.mat.dispose();
    this.mesh.parent?.remove(this.mesh);
  }
}

// ---------------------------------------------------------------- подбираемое

/**
 * Что можно подобрать. Растения растут на дне сами, икра и змейки остаются
 * после аннигиляции. Растения дают ещё и воздух: за ними надо нырять, и без
 * этого нырок был бы чистым риском без выгоды.
 */
const PICKUP = {
  plant: { heal: 0.20, air: 0.40, color: 0x54c98a, emissive: 0x123f2a, r: 1.1 },
  roe: { heal: 0.30, air: 0.18, color: 0xe8d9a8, emissive: 0x6a5a2a, r: 1.1 },
  snake: { heal: 0.18, air: 0.00, color: 0xc9d6c2, emissive: 0x2a3a2c, r: 1.1 }
};
const PICKUP_MAX = 48;

function plantGeo() {
  const v = [];
  for (let b = 0; b < 3; b++) {
    const a = b / 3 * Math.PI * 2, cx = Math.cos(a) * 0.06, cz = Math.sin(a) * 0.06;
    const tx = Math.cos(a) * 0.20, tz = Math.sin(a) * 0.20;
    v.push(cx - 0.05, 0, cz, cx + 0.05, 0, cz, tx, 0.52, tz);
    v.push(cx + 0.05, 0, cz, cx - 0.05, 0, cz, tx, 0.52, tz);   // вторая сторона
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(v), 3));
  g.computeVertexNormals();
  return g;
}

/** Все подбираемые одного вида — один InstancedMesh, то есть один вызов. */
class PickupPool {
  constructor(parent, kind) {
    this.kind = kind;
    const c = PICKUP[kind];
    const geo = kind === 'plant' ? plantGeo()
      : kind === 'roe' ? new THREE.IcosahedronGeometry(0.14, 0)
        : new THREE.CapsuleGeometry(0.055, 0.34, 2, 5);
    const mat = new THREE.MeshStandardMaterial({
      color: c.color, roughness: 0.55, metalness: 0,
      emissive: c.emissive, emissiveIntensity: 1.5
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, PICKUP_MAX);
    this.mesh.layers.enable(REVEAL_FOOD);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    parent.add(this.mesh);
    this.items = [];
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._s = new THREE.Vector3(1, 1, 1);
    this._hidden = new THREE.Matrix4().makeScale(0, 0, 0);
    this._sync(0);
  }
  add(x, y, z) {
    if (this.items.length >= PICKUP_MAX) return;
    this.items.push({ p: new THREE.Vector3(x, y, z), phase: Math.random() * 6.28 });
  }
  /** Собрать всё, до чего дотянулся игрок. Возвращает суммарный эффект. */
  collect(player) {
    const c = PICKUP[this.kind];
    let n = 0;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      const dx = it.p.x - player.pos.x, dz = it.p.z - player.pos.z;
      const dy = it.p.y - (player.pos.y + player.eye * 0.5);
      if (dx * dx + dz * dz > c.r * c.r || Math.abs(dy) > 1.5) continue;
      this.items.splice(i, 1);
      n++;
    }
    return n;
  }
  _sync(time) {
    for (let i = 0; i < PICKUP_MAX; i++) {
      if (i < this.items.length) {
        const it = this.items[i];
        const bob = this.kind === 'plant' ? 0 : Math.sin(time * 1.6 + it.phase) * 0.07;
        this._q.setFromAxisAngle(UP_AXIS, time * (this.kind === 'plant' ? 0.12 : 0.8) + it.phase);
        this._m.compose(this._tmpPos(it, bob), this._q, this._s);
        this.mesh.setMatrixAt(i, this._m);
      } else this.mesh.setMatrixAt(i, this._hidden);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
  _tmpPos(it, bob) {
    _P.set(it.p.x, it.p.y + bob, it.p.z);
    return _P;
  }
  update(time) { this._sync(time); }
  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.mesh.parent?.remove(this.mesh);
  }
}

const UP_AXIS = new THREE.Vector3(0, 1, 0);
const _P = new THREE.Vector3();

// ---------------------------------------------------------------- поведение

/** Проходимые клетки, залитые глубже minDepth, — настоящая чаша, а не лужа. */
function collectDeepCells(level, grid, waterY, minDepth = 1.4) {
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

class Creature {
  constructor(mesh) {
    this.mesh = mesh;
    this.pos = new THREE.Vector3();
    this.yaw = 0;
    this.target = new THREE.Vector3();
    this.speed = 1;
    this.think = 0;
    this.dead = false;
    this.hp = 1;
    this.hitFlash = 0;
  }
  /** Урон от брошенного предмета. true — если добили. */
  hit(dmg) {
    this.hp -= dmg;
    this.hitFlash = 1;
    return this.hp <= 0;
  }
  _turnTo(tx, tz, dt, rate) {
    const want = Math.atan2(tx - this.pos.x, tz - this.pos.z);
    let d = want - this.yaw;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    this.yaw += Math.max(-rate * dt, Math.min(rate * dt, d));
  }
  apply() {
    this.mesh.position.copy(this.pos);
    this.mesh.rotation.y = this.yaw;
  }
}

/** Придонный: живёт в чаше, кусает только того, кто ушёл под воду. */
class Stalker extends Creature {
  constructor(mesh, grid, deep, waterY, cfg) {
    super(mesh);
    this.grid = grid; this.deep = deep; this.waterY = waterY; this.cfg = cfg;
    this.hunting = false;
    this.hp = 2;               // мягче наземного — тело держится на воде
    this.state = 'patrol';     // patrol | stalk | strike | retreat
    this.stateT = 0;
    this.boredT = 0;
    this.orbit = Math.random() * 6.28;
    const s = deep[(Math.random() * deep.length) | 0];
    this.pos.set(s.x, waterY - 1.0, s.z);
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
    this.target.set(p.x, THREE.MathUtils.lerp(floor + 0.5, this.waterY - 0.7, Math.random()), p.z);
    this.think = 3 + Math.random() * 4;
  }
  /**
   * Насколько далеко он вас чует. Неподвижного в мутной воде почти не видно,
   * так что замереть — рабочая тактика; чем быстрее гребёте, тем дальше слышно.
   */
  _noticeRadius(player) {
    const v = Math.hypot(player.vel.x, player.vel.y, player.vel.z);
    const c = this.cfg;
    return c.senseNear + (c.senseFar - c.senseNear) * Math.min(1, v / 3);
  }

  _setState(st) { this.state = st; this.stateT = 0; }

  /** Уйти в дальний угол чаши — подальше от того, кого только что кусал. */
  _pickAwayFrom(player) {
    let best = this.deep[0], bd = -1;
    for (let k = 0; k < 12; k++) {
      const p = this.deep[(Math.random() * this.deep.length) | 0];
      const d = (p.x - player.pos.x) ** 2 + (p.z - player.pos.z) ** 2;
      if (d > bd) { bd = d; best = p; }
    }
    this.target.set(best.x, this.waterY - Math.min(1.2, best.depth * 0.5), best.z);
  }

  /**
   * Повадки. Раньше здесь стояло простое «под водой и ближе 22 м — преследую»,
   * и оторваться было нельзя: условие не выключалось, а скорость превышала
   * скорость пловца. Теперь это хищник со своей жизнью — он присматривается,
   * кружит поодаль, бьёт коротким броском и уходит, а потом какое-то время
   * вообще не интересуется. Убегать имеет смысл, замирать — тоже.
   */
  _think(dt, player, submerged, d, ev) {
    const c = this.cfg;
    switch (this.state) {
      case 'stalk': {
        // кружит рядом, а не таранит в лоб
        this.orbit += dt * 0.9;
        const r = 4.5;
        this.target.set(
          player.pos.x + Math.cos(this.orbit) * r,
          Math.min(player.pos.y + 0.3, this.waterY - 0.4),
          player.pos.z + Math.sin(this.orbit) * r);
        this.speed = 2.0 * c.speed;
        if (!submerged) {
          // вышел на воздух — просто отпускаем. Штрафа забвения тут быть не
          // должно: иначе достаточно на миг вынырнуть, и тварь теряет к вам
          // интерес на девять секунд, а нырять становится безнаказанно.
          this._setState('patrol');
        } else if (d > this._noticeRadius(player) * 1.5 || this.stateT > c.stalkMax) {
          this.boredT = c.boredTime;          // выдохся или потерял след — забыл
          this._setState('patrol');
        } else if (d < 6 && this.stateT > 1.5) {
          this._setState('strike');
          if (ev.growl) ev.growl(0.8);
        }
        break;
      }
      case 'strike': {
        this.target.set(player.pos.x,
          Math.min(player.pos.y + 0.2, this.waterY - 0.4), player.pos.z);
        this.speed = 3.6 * c.speed;
        if (this.stateT > 1.7) this._setState('retreat');   // промахнулся — прочь
        break;
      }
      case 'retreat': {
        if (this.stateT <= dt * 1.5) this._pickAwayFrom(player);
        this.speed = 2.4 * c.speed;
        if (this.stateT > c.retreatTime) { this.boredT = c.boredTime; this._setState('patrol'); }
        break;
      }
      default: {                                // patrol
        this.think -= dt;
        if (this.think <= 0 || this.pos.distanceTo(this.target) < 1.0) this._pick();
        this.speed = 1.15 * c.speed;
        if (submerged && this.boredT <= 0 && d < this._noticeRadius(player)) {
          this._setState('stalk');
          if (ev.growl) ev.growl(0.5);
        }
      }
    }
  }

  update(dt, player, ev, camera, lure) {
    // Кусает только того, у кого голова под водой. Считать по ногам нельзя:
    // залитый по колено зал — это ещё воздух, там опасны наземные, а не эти.
    const submerged = (player.pos.y + player.eye) < this.waterY;
    const dToPlayer = this.pos.distanceTo(player.pos);
    const lureHere = lure.active && this._depthAt(lure.pos.x, lure.pos.z) > 1.0;

    this.stateT += dt;
    this.boredT = Math.max(0, this.boredT - dt);

    if (lureHere) {
      // приманка перебивает всё: на неё идут и сытые, и потерявшие интерес
      if (this.state !== 'lure') this._setState('lure');
      this.target.set(lure.pos.x, Math.min(lure.pos.y, this.waterY - 0.5), lure.pos.z);
      this.speed = 2.5 * this.cfg.speed;
    } else {
      if (this.state === 'lure') this._setState('patrol');
      this._think(dt, player, submerged, dToPlayer, ev);
    }
    this.hunting = this.state === 'stalk' || this.state === 'strike';

    const turn = this.state === 'strike' ? 2.6 : this.hunting ? 1.8 : 1.1;
    this._turnTo(this.target.x, this.target.z, dt, turn);

    const dx = Math.sin(this.yaw), dz = Math.cos(this.yaw);
    let nx = this.pos.x + dx * this.speed * dt;
    let nz = this.pos.z + dz * this.speed * dt;
    if (this._depthAt(nx, nz) < 0.9) {              // на мель не выходим
      const n = this._nearestDeep(this.pos.x, this.pos.z);
      this._turnTo(n.x, n.z, dt, 3.0);
      nx = this.pos.x; nz = this.pos.z;
    }
    this.pos.x = nx; this.pos.z = nz;
    this.pos.y += (this.target.y - this.pos.y) * Math.min(1, 1.4 * dt);
    const floor = this.grid.floorAt(this.pos.x, this.pos.z);
    this.pos.y = THREE.MathUtils.clamp(this.pos.y, floor + 0.35, this.waterY - 0.35);

    // Укус засчитывается только в броске и один раз: после него тварь уходит.
    // Раньше урон шёл всё время, пока игрок был рядом, — отсюда и ощущение,
    // что от неё нельзя отцепиться.
    if (submerged && this.state === 'strike' && dToPlayer < 1.6) {
      player.hurt(this.cfg.bite);
      player.oxygen = Math.max(0, player.oxygen - 0.12);
      const px = player.pos.x - this.pos.x, pz = player.pos.z - this.pos.z;
      const l = Math.hypot(px, pz) || 1;
      player.vel.x += px / l * 6;
      player.vel.z += pz / l * 6;
      if (ev.growl) ev.growl(1);
      this._setState('retreat');
    }
    this.apply();
  }
}

/** Долговязый: под взглядом стоит, плюётся только в того, кто на воздухе. */
class Walker extends Creature {
  constructor(mesh, grid, level, waterY, cfg) {
    super(mesh);
    this.grid = grid; this.lv = level; this.waterY = waterY; this.cfg = cfg;
    this.frozen = false;
    this.hp = 3;
    this.spitTimer = 1.5 + Math.random() * 2;
    this._wanderTo();
  }
  /** Сколько воды над полом в этой точке. */
  _depthAt(x, z) { return this.waterY - this.grid.floorAt(x, z); }

  /** Годится ли точка наземному: открыта и не глубже брода. */
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
      this.pos.set(c.x, this.grid.floorAt(c.x, c.z), c.z);
      return true;
    }
    return false;
  }
  _wanderTo() {
    const c = this._randomOpenCell();
    if (c) this.target.set(c.x, 0, c.z);
    this.think = 6 + Math.random() * 6;
  }
  /** Грубая видимость по клеткам: шагаем по прямой и смотрим, открыты ли они. */
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
  update(dt, player, ev, camera, lure, spits) {
    const dx = this.pos.x - camera.position.x, dz = this.pos.z - camera.position.z;
    const dist = Math.hypot(dx, dz);
    const fwdX = -Math.sin(camera.rotation.y), fwdZ = -Math.cos(camera.rotation.y);
    const dot = dist > 0.01 ? (dx / dist) * fwdX + (dz / dist) * fwdZ : 1;
    const los = this._lineOfSight(camera.position);
    const watched = dot > 0.52 && los && dist < 40;

    // приманка перебивает интерес к игроку
    const lureHere = lure.active;
    this.frozen = watched && !lureHere;

    if (!this.frozen) {
      if (lureHere) {
        this.target.set(lure.pos.x, 0, lure.pos.z);
        this.speed = 2.2;
      } else if (los && dist < 34) {
        this.target.set(camera.position.x, 0, camera.position.z);
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
      // grid.move ограничивает только подъём по ступеньке, спуск — нет, поэтому
      // без этой проверки наземный сходил с бортика и оказывался на дне чаши.
      // Шаг к берегу разрешаем всегда — иначе занесённый в воду там и застрянет.
      const dNew = this._depthAt(step.x, step.z);
      if (dNew <= WADE_MAX || dNew < this._depthAt(this.pos.x, this.pos.z)) {
        this.pos.x = step.x; this.pos.z = step.z;
      } else if (this.think > 0.4) {
        this._wanderTo();            // упёрся в воду — выбирает другую цель
      }
    } else {
      this._turnTo(camera.position.x, camera.position.z, dt, 1.2);
    }
    this.pos.y = this.grid.floorAt(this.pos.x, this.pos.z);

    // Плевок — только если игрок дышит воздухом. Под водой плевать бесполезно,
    // и это единственная передышка от наземных. Условие ровно обратное укусу,
    // так что безопасного положения не существует: есть только выбор, от кого.
    const playerAbove = (player.pos.y + player.eye) >= this.waterY;
    this.spitTimer -= dt;
    if (this.cfg.spitEvery > 0 && playerAbove && !lureHere && los && dist < 26 && this.spitTimer <= 0) {
      this.spitTimer = this.cfg.spitEvery * (0.75 + Math.random() * 0.5);
      const from = new THREE.Vector3(this.pos.x, this.pos.y + 2.3, this.pos.z);
      const to = new THREE.Vector3(camera.position.x, camera.position.y - 0.1, camera.position.z);
      spits.fire(from, to, 15, this.cfg.spitDamage);
      if (ev.growl) ev.growl(0.4);
    }

    if (dist < 1.7) {
      const l = dist || 1;
      player.vel.x += (-dx / l) * 26 * dt;
      player.vel.z += (-dz / l) * 26 * dt;
      if (ev.growl) ev.growl(0.85);
    }
    this.apply();
    this.mesh.material.userData.uniforms.uWave.value = this.frozen ? 0.15 : 1;
  }
}

// ---------------------------------------------------------------- менеджер

const ANNIHILATE_DIST = 2.6;
// Глубже наземный не заходит: бродит по щиколотку и по колено, но не ныряет.
// Свести его с подводным всё ещё можно — они сходятся на урезе воды.
const WADE_MAX = 1.1;

export class Monsters {
  constructor(engine) {
    this.engine = engine;
    this.enabled = true;
    this.difficulty = 'normal';
    this.list = [];
    this.group = null;
    this.spits = null;
    this.lure = null;
    this.pickups = null;
    this.artifact = null;
    this.charges = 0;
    this.events = { growl: null, splash: null, annihilate: null, pickup: null, hit: null, artifact: null };
    this._growlCool = 0;
    this.lureCooldown = 0;
    this.kills = 0;
  }

  get cfg() { return DIFFICULTY[this.difficulty] || DIFFICULTY.normal; }

  build(level) {
    this.dispose();
    if (!this.enabled) return;
    const e = this.engine, cfg = this.cfg;
    this.group = new THREE.Group();
    this.spits = new Spits(this.group);
    this.lure = new Lure(this.group);
    this.pickups = {
      plant: new PickupPool(this.group, 'plant'),
      roe: new PickupPool(this.group, 'roe'),
      snake: new PickupPool(this.group, 'snake')
    };
    this.artifact = new Artifact(this.group);
    this.artifact.place(e.grid, level, level.spawn.x, level.spawn.z, 24);
    this.kills = 0;
    this.charges = 0;
    this.lureCooldown = 0;
    const waterY = e.water ? e.water.waterY : -1e9;

    this._level = level;
    this._waterY = waterY;
    this._deep = null;
    this._respawn = cfg.respawn;
    this._plantTarget = 0;
    this._plantTimer = cfg.plantRegrow;

    for (let n = 0; n < cfg.walkers; n++) this._spawnWalker(level.spawn.x, level.spawn.z, 18);

    // --- подводные, только если в уровне есть настоящая чаша ---
    if (e.water) {
      const deep = collectDeepCells(level, e.grid, waterY);
      if (deep.length >= 4) {
        this._deep = deep;
        for (let n = 0; n < cfg.stalkers; n++) this._spawnStalker();
        // растения по дну — ради них и стоит нырять
        this._plantTarget = Math.min(14, Math.max(5, (deep.length / 9) | 0));
        for (let k = 0; k < this._plantTarget; k++) this._growPlant();
        this._plantTimer = cfg.plantRegrow;
        // под водой шевелится живое — держим преломление посвежее,
        // иначе в покое силуэт замирал бы до восьми кадров
        e.water.idleRefresh = 3;
      }
    }

    e.scene.add(this.group);
  }

  /** Посадить одно растение на дно чаши в случайном месте. */
  _growPlant() {
    if (!this._deep || !this.pickups) return;
    const cs = this.engine.grid.cs;
    const c = this._deep[(Math.random() * this._deep.length) | 0];
    this.pickups.plant.add(
      c.x + (Math.random() - 0.5) * cs * 0.7,
      this._waterY - c.depth + 0.02,
      c.z + (Math.random() - 0.5) * cs * 0.7);
  }

  /**
   * Растения отрастают по одному. Без этого забег упирался в потолок: собрал
   * всё на дне — и лечиться до конца нечем, кроме выпавшего из убитых.
   */
  _plantTick(dt) {
    if (!this._deep || !this._plantTarget) return;
    if (this.pickups.plant.items.length >= this._plantTarget) {
      this._plantTimer = this.cfg.plantRegrow;
      return;
    }
    this._plantTimer -= dt;
    if (this._plantTimer > 0) return;
    this._plantTimer = this.cfg.plantRegrow;
    this._growPlant();
  }

  _spawnWalker(awayX, awayZ, minDist) {
    const e = this.engine, cfg = this.cfg;
    const mat = animatedMaterial(
      { color: 0xb9c6c4, roughness: 0.86, metalness: 0.0, emissive: 0x0a1416, emissiveIntensity: 0.6 },
      'y',
      'transformed.x += sin(uTime * 1.6 + s * 1.1) * 0.035 * uWave * s;'
      + ' transformed.z += cos(uTime * 1.3 + s * 0.9) * 0.025 * uWave * s;');
    const mesh = new THREE.Mesh(buildWalkerGeo(), mat);
    mesh.castShadow = false; mesh.receiveShadow = false;
    mesh.layers.enable(REVEAL_MONSTER);
    const wk = new Walker(mesh, e.grid, this._level, this._waterY, cfg);
    if (!wk.placeAwayFrom(awayX, awayZ, minDist)) { mesh.geometry.dispose(); mat.dispose(); return null; }
    this.group.add(mesh);
    this.list.push(wk);
    return wk;
  }

  _spawnStalker() {
    if (!this._deep) return null;
    const e = this.engine;
    const mat = animatedMaterial(
      { color: 0x1b2b2e, roughness: 0.55, metalness: 0.0, emissive: 0x040c0e, emissiveIntensity: 1.0 },
      'z',
      'transformed.x += sin(uTime * 3.1 + s * 2.4) * 0.16 * uWave * (s * 0.5 + 0.6);');
    const mesh = new THREE.Mesh(buildStalkerGeo(), mat);
    mesh.castShadow = false; mesh.receiveShadow = false;
    mesh.layers.enable(REVEAL_MONSTER);
    this.group.add(mesh);
    const st = new Stalker(mesh, e.grid, this._deep, this._waterY, this.cfg);
    this.list.push(st);
    return st;
  }

  /**
   * Сведённая пара исчезает навсегда — уровень бы опустел после первой удачи.
   * Поэтому взамен через respawn секунд приходит новый, но всегда поодаль.
   */
  _respawnTick(dt, player) {
    const cfg = this.cfg;
    const walkers = this.list.reduce((n, c) => n + (c instanceof Walker ? 1 : 0), 0);
    const stalkers = this.list.length - walkers;
    const needW = walkers < cfg.walkers, needS = stalkers < (this._deep ? cfg.stalkers : 0);
    if (!needW && !needS) { this._respawn = cfg.respawn; return; }

    this._respawn -= dt;
    if (this._respawn > 0) return;
    this._respawn = cfg.respawn;
    if (needW) this._spawnWalker(player.pos.x, player.pos.z, 26);
    else this._spawnStalker();
  }

  setEnabled(v) {
    this.enabled = v;
    if (this.group) this.group.visible = v;
    if (v && !this.group && this.engine.level) this.build(this.engine.level);
  }

  setDifficulty(key) {
    if (!DIFFICULTY[key]) return;
    this.difficulty = key;
    if (this.engine.level) this.build(this.engine.level);
  }

  /** Бросок приманки. Возвращает false, если ещё не перезарядилась. */
  throwLure() {
    if (!this.lure || this.lureCooldown > 0) return false;
    this.lure.throwFrom(this.engine.camera);
    this.lureCooldown = this.cfg.lureCooldown;
    return true;
  }

  /** Убрать существо и высыпать из него то, что в нём было. */
  _kill(c) {
    if (c.dead) return;
    c.dead = true;
    c.mesh.visible = false;
    this.kills++;
    const pool = (c instanceof Stalker) ? this.pickups.roe : this.pickups.snake;
    for (let k = 0; k < 3; k++) {
      pool.add(c.pos.x + (Math.random() - 0.5) * 1.2,
               c.pos.y + (c instanceof Stalker ? (Math.random() - 0.5) * 0.5 : 0.15),
               c.pos.z + (Math.random() - 0.5) * 1.2);
    }
  }

  /** Прямое попадание брошенным предметом. */
  _checkThrownHits() {
    const l = this.lure;
    if (!l.active || !l.armed) return;
    for (const c of this.list) {
      if (c.dead) continue;
      if (l.pos.distanceTo(c.pos) > 1.5) continue;
      l.armed = false;
      l.vel.multiplyScalar(-0.3);
      this.events.hit?.(c.hp);
      if (c.hit(1)) this._kill(c);
      break;
    }
  }

  /**
   * Наземный и подводный, сошедшиеся вплотную, уничтожают друг друга —
   * самый быстрый способ убрать обоих разом, ради него приманка и нужна.
   */
  _checkAnnihilation() {
    for (const a of this.list) {
      if (a.dead || !(a instanceof Walker)) continue;
      for (const b of this.list) {
        if (b.dead || !(b instanceof Stalker)) continue;
        if (a.pos.distanceTo(b.pos) > ANNIHILATE_DIST) continue;
        this._kill(a);
        this._kill(b);
        this.events.splash?.(2.5);
        this.events.annihilate?.(b.pos.clone());
      }
    }
    if (this.list.some(c => c.dead)) this.list = this.list.filter(c => !c.dead);
  }

  update(dt, player) {
    if (!this.enabled || !this.group) return;
    const e = this.engine, t = e.time;
    const waterY = e.water ? e.water.waterY : -1e9;

    this.lureCooldown = Math.max(0, this.lureCooldown - dt);
    this.lure.update(dt, e.grid, waterY);

    this._growlCool -= dt;
    const ev = {
      growl: (p) => {
        if (this._growlCool > 0) return;
        this._growlCool = 1.4 + Math.random();
        this.events.growl?.(p);
      }
    };
    for (const c of this.list) {
      c.mesh.material.userData.uniforms.uTime.value = t;
      c.update(dt, player, ev, e.camera, this.lure, this.spits);
    }
    this.spits.update(dt, player, e.grid, (dmg) => player.hurt(dmg));

    for (const kind of ['plant', 'roe', 'snake']) {
      const pool = this.pickups[kind];
      pool.update(t);
      const n = pool.collect(player);
      if (!n) continue;
      const c = PICKUP[kind];
      player.heal(c.heal * n);
      if (c.air) player.oxygen = Math.min(1, player.oxygen + c.air * n);
      this.events.pickup?.(kind, n);
    }
    // артефакт: подобрали — заряд обнаружения, и он уходит в новое место
    if (this.artifact.update(dt, t, player)) {
      this.charges++;
      this.events.artifact?.(this.charges);
      this.artifact.delay = this.cfg.artifactDelay;
    } else if (!this.artifact.active) {
      this.artifact.delay -= dt;
      if (this.artifact.delay <= 0) {
        this.artifact.place(e.grid, this._level, player.pos.x, player.pos.z, 30);
      }
    }
    this._plantTick(dt);
    this._checkThrownHits();
    this._checkAnnihilation();
    this._respawnTick(dt, player);
  }

  dispose() {
    if (!this.group) return;
    this.spits?.dispose();
    this.lure?.dispose();
    this.artifact?.dispose();
    if (this.pickups) for (const k of Object.keys(this.pickups)) this.pickups[k].dispose();
    this.engine.scene.remove(this.group);
    this.group.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
    this.group = null; this.spits = null; this.lure = null; this.pickups = null; this.artifact = null;
    this.list.length = 0;
  }
}
