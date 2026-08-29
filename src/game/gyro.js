/**
 * Управление взглядом по положению телефона.
 *
 * На iOS 13+ датчик молчит, пока страница не попросит доступ, причём просить
 * можно только из обработчика реального нажатия и только по https. Поэтому
 * включение висит на кнопке с обработчиком click: на галочке (change) Safari
 * местами не считает это жестом и молча отказывает.
 *
 * Рыскание берём приращением, а не абсолютным азимутом: так не нужна калибровка
 * «где перёд», компас не тянет картинку при магнитных помехах, и палец в зоне
 * обзора по-прежнему доворачивает камеру — два способа складываются, а не
 * спорят. Наклон, наоборот, берём как есть: телефон вертикально — взгляд к
 * горизонту, и это само себя выправляет.
 */
import * as THREE from 'three';

const ZEE = new THREE.Vector3(0, 0, 1);
// экран смотрит на человека, а не в потолок — отсюда доворот на -90° вокруг X
const Q1 = new THREE.Quaternion(-Math.SQRT1_2, 0, 0, Math.SQRT1_2);
const DEG = Math.PI / 180;

export class Gyro {
  constructor() {
    this.active = false;
    this.status = 'выключен';
    this._q = new THREE.Quaternion();
    this._q0 = new THREE.Quaternion();
    this._e = new THREE.Euler();
    this._raw = null;
    this._prevYaw = null;
    this._events = 0;          // сколько показаний пришло — для диагностики
    this._since = 0;
    this._onOrient = (e) => {
      if (e.alpha == null && e.beta == null && e.gamma == null) return;
      this._raw = e;
      this._events++;
    };
  }

  static supported() {
    return typeof window !== 'undefined' && 'DeviceOrientationEvent' in window;
  }

  /** iOS требует явного разрешения; на Android его спрашивать не надо. */
  static needsPermission() {
    return typeof DeviceOrientationEvent !== 'undefined'
        && typeof DeviceOrientationEvent.requestPermission === 'function';
  }

  async enable() {
    if (!Gyro.supported()) { this.status = 'датчика нет'; return false; }
    if (Gyro.needsPermission()) {
      try {
        const r = await DeviceOrientationEvent.requestPermission();
        if (r !== 'granted') { this.status = 'доступ не дали'; return false; }
      } catch (_) {
        this.status = 'нужно нажать самому';
        return false;
      }
    }
    // iOS отдаёт показания в deviceorientation; на части Android абсолютные
    // углы приходят только в deviceorientationabsolute — слушаем оба.
    window.addEventListener('deviceorientation', this._onOrient);
    window.addEventListener('deviceorientationabsolute', this._onOrient);
    this.active = true;
    this._prevYaw = null;
    this._raw = null;
    this._events = 0;
    this._since = Date.now();
    this.status = 'ждёт показаний';
    return true;
  }

  disable() {
    window.removeEventListener('deviceorientation', this._onOrient);
    window.removeEventListener('deviceorientationabsolute', this._onOrient);
    this.active = false;
    this._raw = null;
    this._prevYaw = null;
    this.status = 'выключен';
  }

  /** Показания датчика → направление взгляда. */
  _angles() {
    const e = this._raw;
    if (!e) return null;
    const alpha = (e.alpha || 0) * DEG;
    const beta = (e.beta || 0) * DEG;
    const gamma = (e.gamma || 0) * DEG;
    const orient = ((screen.orientation && screen.orientation.angle)
      || window.orientation || 0) * DEG;

    this._e.set(beta, alpha, -gamma, 'YXZ');
    this._q.setFromEuler(this._e);
    this._q.multiply(Q1);                                   // экран → взгляд
    this._q.multiply(this._q0.setFromAxisAngle(ZEE, -orient)); // поворот экрана
    this._e.setFromQuaternion(this._q, 'YXZ');
    return { yaw: this._e.y, pitch: this._e.x };
  }

  /** Строка для показа в настройках: либо живые углы, либо где встало. */
  report() {
    if (!this.active) return this.status;
    if (!this._raw) {
      const waited = (Date.now() - this._since) / 1000;
      return waited > 2.5 ? 'датчик молчит — проверьте Настройки → Safari → Движение' : this.status;
    }
    const e = this._raw;
    const f = (v) => (v == null ? '—' : v.toFixed(0));
    return `идёт: α${f(e.alpha)} β${f(e.beta)} γ${f(e.gamma)} · ${this._events} шт`;
  }

  /** Довернуть камеру игрока по положению телефона. */
  apply(player) {
    if (!this.active) return;
    const a = this._angles();
    if (!a) return;
    this.status = 'работает';

    if (this._prevYaw !== null) {
      let d = a.yaw - this._prevYaw;
      while (d > Math.PI) d -= Math.PI * 2;      // через ±180° не должно рвать
      while (d < -Math.PI) d += Math.PI * 2;
      // Отбрасываем только заведомый мусор. Порог был 1 рад (57°), и на нём
      // терялся быстрый поворот головы: пропущенный кадр — и движение исчезло.
      // Переход через 0/360° сюда не попадает, он снят нормализацией выше.
      if (Math.abs(d) < 2.0) player.yaw += d;
    }
    this._prevYaw = a.yaw;

    const lim = Math.PI / 2 - 0.02;
    player.pitch = Math.max(-lim, Math.min(lim, a.pitch));
  }
}
