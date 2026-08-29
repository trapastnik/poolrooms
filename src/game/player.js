import * as THREE from 'three';

const EYE = 1.68;
const CROUCH_EYE = 1.02;
const RADIUS = 0.34;

const sprintKey = (k) => k.has('ShiftLeft') || k.has('ShiftRight');

export class Player {
  constructor(engine) {
    this.engine = engine;
    this.pos = new THREE.Vector3(0, 0, 0);
    this.vel = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;
    this.eye = EYE;
    this.mode = 'ground';           // ground | wade | swim
    this.onGround = false;
    this.bobPhase = 0;
    this.bobAmount = 0;
    this.roll = 0;
    this.oxygen = 1;
    this.health = 1;
    this.airSeconds = 45;      // за сколько секунд кончается воздух
    this.drownRate = 0.13;     // здоровья в секунду без воздуха
    this.regen = 0.045;        // здоровья в секунду, если не трогали
    this.hurtCool = 0;         // после урона регенерация ждёт
    this.hurtFlash = 0;        // для красной вспышки на экране
    this.dead = false;
    this.swimDepth = 0;        // на сколько метров ниже уровня всплытия держимся
    this.lookSwim = false;     // плыть по направлению взгляда (режим гироскопа)
    this.depthRate = 1.7;      // м/с набора глубины при удержании
    this.noclip = false;
    this.sensitivity = 0.0022;
    this.keyTurnSpeed = 2.1;        // рад/с при обзоре со стрелок
    this.fovBase = 72;
    this.fov = 72;

    this.keys = new Set();
    this.enabled = false;
    this._jumpWas = false;

    // аналоговый ввод с сенсорного стика: x — стрейф, y — вперёд, оба −1..1
    this.analog = { x: 0, y: 0, mag: 0 };
    // экранные кнопки, работают наравне с клавишами
    this.btn = { sprint: false, jump: false, crouch: false };

    this.events = { splash: null, step: null, dive: null, surface: null };
    this._wasUnderwater = false;
    this._wasInWater = false;
    this._stepDist = 0;
  }

  spawnFrom(level) {
    this.pos.set(level.spawn.x, 0, level.spawn.z);
    this.pos.y = this.engine.grid.floorAt(this.pos.x, this.pos.z);
    this.yaw = level.spawn.yaw || 0;
    this.pitch = 0;
    this.vel.set(0, 0, 0);
    this.oxygen = 1;
    this.health = 1;
    this.dead = false;
    this.hurtCool = 0;
    this.hurtFlash = 0;
    this.swimDepth = 0;
  }

  hurt(amount) {
    if (amount <= 0 || this.dead) return;
    this.health = Math.max(0, this.health - amount);
    this.hurtCool = 3.5;
    this.hurtFlash = Math.min(1, this.hurtFlash + amount * 3.5);
    if (this.health <= 0) this.dead = true;
  }

  heal(amount) {
    this.health = Math.min(1, this.health + amount);
  }

  onMouseMove(dx, dy) {
    if (!this.enabled) return;
    this.yaw -= dx * this.sensitivity;
    this.pitch -= dy * this.sensitivity;
    this.pitch = Math.max(-Math.PI / 2 + 0.02, Math.min(Math.PI / 2 - 0.02, this.pitch));
  }

  key(code, down) {
    if (down) this.keys.add(code); else this.keys.delete(code);
    if (down && code === 'KeyV') this.noclip = !this.noclip;
  }

  get waterY() { return this.engine.water ? this.engine.water.waterY : -Infinity; }

  update(dt) {
    dt = Math.min(dt, 0.05);
    const grid = this.engine.grid;
    if (!grid) return;

    const k = this.keys;
    let fwd = (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0);
    let str = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0);
    if (this.analog.mag > 0) { fwd += this.analog.y; str += this.analog.x; }

    // обзор со стрелок — работает и без захвата мыши
    const turn = (k.has('ArrowRight') ? 1 : 0) - (k.has('ArrowLeft') ? 1 : 0);
    const look = (k.has('ArrowDown') ? 1 : 0) - (k.has('ArrowUp') ? 1 : 0);
    if (turn || look) {
      const rate = this.keyTurnSpeed * (sprintKey(k) ? 1.8 : 1);
      this.yaw -= turn * rate * dt;
      this.pitch -= look * rate * dt;
      this.pitch = Math.max(-Math.PI / 2 + 0.02, Math.min(Math.PI / 2 - 0.02, this.pitch));
    }
    const sprint = k.has('ShiftLeft') || k.has('ShiftRight') || this.btn.sprint;
    const crouch = k.has('KeyC') || k.has('ControlLeft') || this.btn.crouch;
    // Удержание и нажатие — разные вещи. В воде пробел держат, чтобы всплывать,
    // а на земле он должен срабатывать по фронту: иначе на мелководье, где
    // вертикаль демпфируется и onGround возвращается каждый кадр, удержание
    // переприменяло прыжок и получался бесконечный подъём.
    const jumpHeld = k.has('Space') || this.btn.jump;
    const jumpEdge = jumpHeld && !this._jumpWas;
    this._jumpWas = jumpHeld;

    const wY = this.waterY;
    const floorY = grid.floorAt(this.pos.x, this.pos.z);
    const ceilY = grid.ceilAt(this.pos.x, this.pos.z);
    const waterDepth = wY - floorY;

    if (this.noclip) {
      this._noclip(dt, fwd, str, sprint, jumpHeld, crouch);
      this._applyCamera(dt);
      return;
    }

    // --- определяем режим ---
    const headY = this.pos.y + this.eye;
    const submerged = headY < wY;
    if (waterDepth > 1.35 && this.pos.y + 0.9 < wY) this.mode = 'swim';
    else if (waterDepth > 0.12 && this.pos.y < wY - 0.02) this.mode = 'wade';
    else this.mode = 'ground';

    // --- направление движения ---
    const cosY = Math.cos(this.yaw), sinY = Math.sin(this.yaw);
    let dirX = -sinY * fwd + cosY * str;
    let dirZ = -cosY * fwd - sinY * str;
    const len = Math.hypot(dirX, dirZ);
    if (len > 1e-4) { dirX /= len; dirZ /= len; }
    // отклонение стика задаёт долю скорости; заодно диагональ с клавиатуры
    // перестаёт давать лишние √2 — раньше W+D бежало быстрее, чем W
    const mag = Math.min(1, len);

    let speed;
    if (this.mode === 'swim') speed = sprint ? 3.4 : 2.3;
    else if (this.mode === 'wade') {
      const submersion = Math.min(1, (wY - this.pos.y) / 1.4);
      speed = (sprint ? 5.0 : 3.1) * (1 - submersion * 0.55);
    } else speed = crouch ? 1.7 : (sprint ? 5.6 : 3.3);

    // ускорение / трение
    const accel = this.mode === 'swim' ? 7 : (this.onGround ? 26 : 8);
    const targetVX = dirX * speed * mag, targetVZ = dirZ * speed * mag;
    this.vel.x += (targetVX - this.vel.x) * Math.min(1, accel * dt);
    this.vel.z += (targetVZ - this.vel.z) * Math.min(1, accel * dt);

    // --- вертикаль ---
    if (this.mode === 'swim') {
      // Глубина задаётся удержанием, а не рывком: зажал присед — уходишь ниже и
      // там и держишься, зажал прыжок — поднимаешься. Отпустил — медленно
      // выносит наверх, потому что тело легче воды.
      const maxDepth = Math.max(0, wY - floorY - 0.55);
      if (crouch) this.swimDepth = Math.min(maxDepth, this.swimDepth + this.depthRate * dt);
      else if (jumpHeld) this.swimDepth = Math.max(0, this.swimDepth - this.depthRate * 1.35 * dt);
      else this.swimDepth = Math.max(0, this.swimDepth - 0.3 * dt);

      const floatY = wY - 0.42 - this.swimDepth;
      const diff = floatY - this.pos.y;
      let buoy = diff * 5.5;
      // небольшой прямой толчок — чтобы отклик был сразу, а не через доводку
      if (jumpHeld) buoy += 2.4;
      if (crouch) buoy -= 3.0;
      // Плывём туда, куда смотрим. С гироскопом это основной способ менять
      // глубину, поэтому там нет мёртвой зоны по наклону и тяга сильнее:
      // наклонил телефон вниз, погрёб — пошёл вниз.
      const lookMin = this.lookSwim ? 0.02 : 0.35;
      const lookGain = this.lookSwim ? 3.4 : 2.2;
      const looking = Math.abs(this.pitch) > lookMin && mag > 0.1;
      if (looking) buoy += Math.sin(this.pitch) * speed * lookGain;
      // Иначе плавучесть утянет обратно к уровню всплытия и грести вниз
      // будет бесполезно: держим набранную глубину как новую точку покоя.
      if (this.lookSwim && looking) {
        this.swimDepth = Math.max(0, Math.min(maxDepth, wY - 0.42 - this.pos.y));
      }
      this.vel.y += buoy * dt * 3.0;
      this.vel.y *= Math.pow(0.02, dt);          // сильное демпфирование в воде
      this.vel.y = THREE.MathUtils.clamp(this.vel.y, -4.5, 4.5);
      this.onGround = false;
    } else {
      this.swimDepth = 0;
      this.vel.y -= 22 * dt;
      if (this.onGround && jumpEdge) { this.vel.y = 5.4; this.onGround = false; }
      if (this.mode === 'wade') this.vel.y *= Math.pow(0.35, dt);
    }

    // --- перемещение с коллизиями ---
    const step = grid.move(this.pos.x, this.pos.z, this.vel.x * dt, this.vel.z * dt, RADIUS, this.pos.y, 0.62);
    const moved = Math.hypot(step.x - this.pos.x, step.z - this.pos.z);
    this.pos.x = step.x; this.pos.z = step.z;

    this.pos.y += this.vel.y * dt;

    const newFloor = grid.floorAt(this.pos.x, this.pos.z);
    if (this.pos.y <= newFloor + 1e-3) {
      this.pos.y = newFloor;
      if (this.vel.y < 0) this.vel.y = 0;
      this.onGround = true;
    } else if (this.mode !== 'swim') {
      this.onGround = false;
    }
    const newCeil = grid.ceilAt(this.pos.x, this.pos.z);
    const targetEye = crouch && this.mode === 'ground' ? CROUCH_EYE : EYE;
    this.eye += (targetEye - this.eye) * Math.min(1, 12 * dt);
    if (this.pos.y + this.eye > newCeil - 0.12) {
      this.pos.y = Math.min(this.pos.y, newCeil - 0.12 - this.eye);
      if (this.vel.y > 0) this.vel.y = 0;
    }

    // --- покачивание при ходьбе ---
    this._stepDist += moved;
    const targetBob = (this.mode === 'ground' && this.onGround ? 1 : 0.35) * Math.min(1, moved / (dt * 4));
    this.bobAmount += (targetBob - this.bobAmount) * Math.min(1, 8 * dt);
    this.bobPhase += moved * (sprint ? 3.6 : 4.6);
    if (this._stepDist > (sprint ? 1.9 : 1.5)) {
      this._stepDist = 0;
      if (this.events.step) this.events.step(this.mode, sprint);
    }

    // крен при стрейфе
    const targetRoll = -str * 0.028 * (sprint ? 1.4 : 1);
    this.roll += (targetRoll - this.roll) * Math.min(1, 6 * dt);

    // --- кислород ---
    const nowUnder = (this.pos.y + this.eye) < wY;
    if (nowUnder) {
      this.oxygen = Math.max(0, this.oxygen - dt / this.airSeconds);
      if (this.oxygen <= 0) {
        this.vel.y += 9 * dt;                 // выталкивает наверх
        this.hurt(this.drownRate * dt);       // и топит
      }
    } else {
      // Воздуха теперь мало, поэтому и набирается он быстро: нырок — вдох —
      // снова нырок. При медленном наборе игра превратилась бы в ожидание.
      this.oxygen = Math.min(1, this.oxygen + dt / 2.5);
    }

    // здоровье само возвращается, но только если давно не били
    this.hurtCool = Math.max(0, this.hurtCool - dt);
    if (this.hurtCool <= 0 && !this.dead) this.heal(this.regen * dt);
    this.hurtFlash = Math.max(0, this.hurtFlash - dt * 1.6);
    if (nowUnder && !this._wasUnderwater && this.events.dive) this.events.dive();
    if (!nowUnder && this._wasUnderwater && this.events.surface) this.events.surface();
    this._wasUnderwater = nowUnder;

    const inWater = this.pos.y < wY;
    if (inWater !== this._wasInWater) {
      if (this.events.splash) this.events.splash(Math.abs(this.vel.y));
      this._wasInWater = inWater;
    }

    // --- FOV: слегка расширяется на спринте ---
    const targetFov = this.fovBase + (sprint && this.mode !== 'swim' && moved > 0.01 ? 5 : 0) + (nowUnder ? -6 : 0);
    this.fov += (targetFov - this.fov) * Math.min(1, 5 * dt);

    this._applyCamera(dt);
  }

  _noclip(dt, fwd, str, sprint, up, down) {
    const speed = sprint ? 26 : 9;
    const cam = this.engine.camera;
    const dir = new THREE.Vector3();
    cam.getWorldDirection(dir);
    const right = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0)).normalize();
    this.pos.addScaledVector(dir, fwd * speed * dt);
    this.pos.addScaledVector(right, str * speed * dt);
    this.pos.y += ((up ? 1 : 0) - (down ? 1 : 0)) * speed * dt;
    this.vel.set(0, 0, 0);
    this.bobAmount = 0;
  }

  _applyCamera(dt) {
    const cam = this.engine.camera;
    const bobY = Math.sin(this.bobPhase) * 0.045 * this.bobAmount;
    const bobX = Math.cos(this.bobPhase * 0.5) * 0.035 * this.bobAmount;
    const breathe = Math.sin(this.engine.time * 1.1) * 0.008;

    const eyeY = this.noclip ? 0 : this.eye;
    cam.position.set(this.pos.x, this.pos.y + eyeY + bobY + breathe, this.pos.z);

    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    cam.position.addScaledVector(right, bobX);

    cam.rotation.order = 'YXZ';
    cam.rotation.y = this.yaw;
    cam.rotation.x = this.pitch;
    cam.rotation.z = this.roll + Math.sin(this.bobPhase * 0.5) * 0.012 * this.bobAmount;

    if (Math.abs(cam.fov - this.fov) > 0.01) {
      cam.fov = this.fov;
      cam.updateProjectionMatrix();
    }
  }
}
