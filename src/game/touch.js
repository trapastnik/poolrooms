/**
 * Сенсорное управление.
 *
 * Раскладка обычная для шутера с телефона: левый бок экрана — виртуальный стик
 * (движение), правый — обзор перетаскиванием, кнопки справа снизу — вверх/вниз.
 * Пальцы разводятся по identifier, поэтому идти и одновременно вертеть камерой
 * можно, и стик не перехватывает жест обзора.
 *
 * Стик «плавающий»: база появляется там, где палец коснулся, а не в заранее
 * нарисованном круге — не нужно целиться, и работает при любом хвате.
 */

const STICK_R = 62;        // px до полного отклонения
const DEAD = 0.16;         // мёртвая зона стика
const SPRINT_AT = 0.9;     // за этим отклонением включается бег
const LOOK_GAIN = 2.6;     // палец «тяжелее» мыши — во столько раз крупнее шаг

// Управление живёт в нижней полосе, а не по всему экрану: выше неё палец
// ничего не двигает, и вид остаётся чистым для разглядывания.
const BAND_MIN = 130;
const BAND_MAX = 220;
const BAND_PART = 0.30;    // доля высоты экрана под полосу

// Полоса узкая, пальцу быстро некуда двигаться. Поэтому у её краёв обзор
// доворачивается сам, пока палец там держат, — как в шутерах на приставке.
const EDGE = 46;           // px от края зоны, где начинается доворот
const EDGE_YAW = 2.1;      // рад/с по горизонтали на полном заходе в край
const EDGE_PITCH = 1.1;    // по вертикали медленнее — там и так упор в зенит

// Короткое касание без ведения — это тап, у него своё действие.
// Обнаружение на тап намеренно не вешаем: оно тратит найденный артефакт,
// и случайное срабатывание стоило бы слишком дорого.
const TAP_MS = 240;
const TAP_SLOP = 12;       // px, дальше это уже ведение, а не тап

export class TouchControls {
  constructor(state) {
    this.state = state;
    this.enabled = false;
    this.moveId = null;
    this.lookId = null;
    this.bx = 0; this.by = 0;   // база стика
    this.lx = 0; this.ly = 0;   // прошлая точка пальца обзора
    this.splitAt = 0.5;         // полоса делится пополам: слева ход, справа обзор

    this.el = document.getElementById('touch');
    this.stick = document.getElementById('tStick');
    this.knob = document.getElementById('tKnob');
    this.bUp = document.getElementById('tUp');
    this.bDown = document.getElementById('tDown');
    this.bPause = document.getElementById('tPause');
    this.bThrow = document.getElementById('tThrow');
    this.bReveal = document.getElementById('tReveal');
    this._mode = null;

    const canvas = document.getElementById('c');
    canvas.addEventListener('touchstart', (e) => this._start(e), { passive: false });
    canvas.addEventListener('touchmove', (e) => this._move(e), { passive: false });
    canvas.addEventListener('touchend', (e) => this._end(e), { passive: false });
    canvas.addEventListener('touchcancel', (e) => this._end(e), { passive: false });

    this._hold(this.bUp, 'jump');
    this._hold(this.bDown, 'crouch');
    // адресная строка на Android то появляется, то прячется — пересчитываем
    this.syncBand();
    const sync = () => this.syncBand();
    window.addEventListener('resize', sync);
    window.addEventListener('orientationchange', sync);
    window.visualViewport?.addEventListener('resize', sync);

    this.bThrow.addEventListener('touchstart', (e) => {
      e.preventDefault();
      state.onThrow?.();
    }, { passive: false });
    this.bReveal.addEventListener('touchstart', (e) => {
      e.preventDefault();
      state.onReveal?.();
    }, { passive: false });
    this.bPause.addEventListener('touchstart', (e) => {
      e.preventDefault();
      this.release();
      state.onPause?.();
    }, { passive: false });
  }

  /**
   * Включить сенсорный режим — по первому касанию либо сразу при coarse-указателе.
   * Сам слой при этом не показывается: он нужен только пока идёт игра,
   * показом управляют show()/hide() из startGame()/pauseGame().
   */
  enable() {
    if (this.enabled) return;
    this.enabled = true;
    document.body.classList.add('touch');
  }

  /** Выключить — если человек взялся за настоящую мышь. */
  disable() {
    if (!this.enabled) return;
    this.enabled = false;
    this.hide();
    document.body.classList.remove('touch');
  }

  show() { if (this.enabled) this.el.classList.remove('hidden'); }
  hide() { this.el.classList.add('hidden'); this.release(); }

  /** Отпустить всё: пауза, потеря фокуса, уход в меню. */
  release() {
    const p = this.state.player;
    this.moveId = this.lookId = null;
    p.analog.x = p.analog.y = p.analog.mag = 0;
    p.btn.jump = p.btn.crouch = p.btn.sprint = false;
    this.stick.classList.add('hidden');
    this.bUp.classList.remove('on');
    this.bDown.classList.remove('on');
  }

  _hold(el, key) {
    const on = (e) => { e.preventDefault(); this.state.player.btn[key] = true; el.classList.add('on'); };
    const off = (e) => { e.preventDefault(); this.state.player.btn[key] = false; el.classList.remove('on'); };
    el.addEventListener('touchstart', on, { passive: false });
    el.addEventListener('touchend', off, { passive: false });
    el.addEventListener('touchcancel', off, { passive: false });
  }

  /**
   * Высота полосы. Единственный источник правды: CSS берёт её отсюда через
   * переменную, а не считает свои vh. На Android Chrome vh — это высота с
   * убранной адресной строкой, а innerHeight — текущая; когда они расходятся,
   * нарисованная полоса и та, что ловит нажатия, оказываются на разных местах,
   * и верх видимой полосы просто не работает.
   */
  get bandHeight() {
    const h = window.visualViewport?.height || window.innerHeight;
    return Math.round(Math.max(BAND_MIN, Math.min(BAND_MAX, h * BAND_PART)));
  }

  /** Верхняя граница полосы управления в клиентских координатах. */
  get bandTop() {
    return (window.visualViewport?.height || window.innerHeight) - this.bandHeight;
  }

  /**
   * Прокинуть в CSS размеры визуального вьюпорта и высоту полосы.
   *
   * Это ключевое место для Android. Слой управления — position:fixed, то есть
   * его коробка равна layout-вьюпорту, а координаты касаний (clientX/clientY)
   * приходят в visual-вьюпорте. Пока видна адресная строка, это разные системы:
   * полоса рисуется по одной, а нажатия считаются по другой, и часть видимой
   * полосы просто не отзывается. Поэтому высоту слоя задаём числом из
   * visualViewport — тогда обе системы совпадают.
   */
  syncBand() {
    const vv = window.visualViewport;
    const h = vv ? vv.height : window.innerHeight;
    const w = vv ? vv.width : window.innerWidth;
    const st = document.documentElement.style;
    st.setProperty('--vh', h + 'px');
    st.setProperty('--vw', w + 'px');
    st.setProperty('--band', this.bandHeight + 'px');
  }

  _start(e) {
    if (!this.enabled) { this.enable(); this.show(); }
    if (!this.state.running) return;
    e.preventDefault();
    // захвата указателя на телефоне нет, обзор включаем напрямую
    this.state.player.enabled = true;
    const split = (window.visualViewport?.width || window.innerWidth) * this.splitAt;
    const top = this.bandTop;
    for (const t of e.changedTouches) {
      if (t.clientY < top) continue;          // выше полосы — просто смотрим
      if (t.clientX < split && this.moveId === null) {
        this.moveId = t.identifier;
        this.bx = t.clientX; this.by = t.clientY;
        this._tapStart(t, 'move');
        this._drawStick(0, 0);
        this.stick.classList.remove('hidden');
      } else if (t.clientX >= split && this.lookId === null) {
        this.lookId = t.identifier;
        this.lx = t.clientX; this.ly = t.clientY;
        this._tapStart(t, 'look');
      }
    }
  }

  _move(e) {
    if (!this.state.running) return;
    e.preventDefault();
    const p = this.state.player;
    for (const t of e.changedTouches) {
      if (t.identifier === this.moveId) {
        let dx = t.clientX - this.bx, dy = t.clientY - this.by;
        const d = Math.hypot(dx, dy);
        // палец ушёл за радиус — база едет следом, чтобы шарик не отставал
        if (d > STICK_R) {
          const k = 1 - STICK_R / d;
          this.bx += dx * k; this.by += dy * k;
          dx = t.clientX - this.bx; dy = t.clientY - this.by;
        }
        this._drawStick(dx, dy);
        this._tapMove('move', t);

        let m = Math.min(1, Math.hypot(dx, dy) / STICK_R);
        if (m < DEAD) { p.analog.x = p.analog.y = p.analog.mag = 0; p.btn.sprint = false; continue; }
        const scaled = (m - DEAD) / (1 - DEAD);
        const inv = scaled / m;
        p.analog.x = (dx / STICK_R) * inv;      // стрейф
        p.analog.y = (-dy / STICK_R) * inv;     // вверх по экрану — вперёд
        p.analog.mag = scaled;
        p.btn.sprint = m >= SPRINT_AT;
        this.stick.classList.toggle('run', p.btn.sprint);
      } else if (t.identifier === this.lookId) {
        p.onMouseMove((t.clientX - this.lx) * LOOK_GAIN, (t.clientY - this.ly) * LOOK_GAIN);
        this.lx = t.clientX; this.ly = t.clientY;
        this._tapMove('look', t);
      }
    }
  }

  _tapStart(t, kind) {
    this._tap = this._tap || {};
    this._tap[kind] = { x: t.clientX, y: t.clientY, at: performance.now(), moved: false };
  }

  _tapMove(kind, t) {
    const r = this._tap && this._tap[kind];
    if (!r || r.moved) return;
    if (Math.hypot(t.clientX - r.x, t.clientY - r.y) > TAP_SLOP) r.moved = true;
  }

  /** Тап засчитан — короткое касание, за которое палец почти не сдвинулся. */
  _tapEnd(kind) {
    const r = this._tap && this._tap[kind];
    if (!r) return false;
    this._tap[kind] = null;
    return !r.moved && (performance.now() - r.at) < TAP_MS;
  }

  _end(e) {
    const p = this.state.player;
    for (const t of e.changedTouches) {
      if (t.identifier === this.moveId) {
        // тап слева — прыжок / всплытие: промахнуться им не страшно
        if (this._tapEnd('move')) this.state.onTapJump?.();
        this.moveId = null;
        p.analog.x = p.analog.y = p.analog.mag = 0;
        p.btn.sprint = false;
        this.stick.classList.add('hidden');
        this.stick.classList.remove('run');
      } else if (t.identifier === this.lookId) {
        // тап справа — бросок приманки
        if (this._tapEnd('look')) this.state.onThrow?.();
        this.lookId = null;
      }
    }
  }

  _drawStick(dx, dy) {
    this.stick.style.transform = `translate(${this.bx}px,${this.by}px)`;
    this.knob.style.transform = `translate(${dx}px,${dy}px)`;
  }

  /** Гасим кнопку броска, пока приманка не перезарядилась. */
  setThrowReady(ready) {
    if (this.enabled) this.bThrow.classList.toggle('cool', !ready);
  }

  setRevealReady(ready) {
    if (this.enabled) this.bReveal.classList.toggle('cool', !ready);
  }

  /**
   * Доворот, пока палец удерживают у края зоны обзора. Считаем, насколько
   * глубоко он зашёл в краевую полосу; если ушёл за пределы зоны — считаем
   * заход полным, чтобы вращение не обрывалось.
   */
  _edgeTurn(dt) {
    if (this.lookId === null || !dt || !this.state.running) return;
    const p = this.state.player;
    const vw = window.visualViewport?.width || window.innerWidth;
    const left = vw * this.splitAt;
    const right = vw;
    const top = this.bandTop;
    const bottom = window.visualViewport?.height || window.innerHeight;
    const cl = (v) => Math.max(-1, Math.min(1, v));

    let rx = 0, ry = 0;
    if (this.lx > right - EDGE) rx = (this.lx - (right - EDGE)) / EDGE;
    else if (this.lx < left + EDGE) rx = -((left + EDGE) - this.lx) / EDGE;
    if (this.ly > bottom - EDGE) ry = (this.ly - (bottom - EDGE)) / EDGE;
    else if (this.ly < top + EDGE) ry = -((top + EDGE) - this.ly) / EDGE;
    if (!rx && !ry) return;

    // onMouseMove сам умножает на чувствительность — делим, чтобы скорость
    // доворота была в радианах в секунду и не зависела от ползунка
    const k = dt / (p.sensitivity || 0.0022);
    p.onMouseMove(cl(rx) * EDGE_YAW * k, cl(ry) * EDGE_PITCH * k);
  }

  /** Подписи кнопок зависят от того, идём мы или плывём. */
  update(dt = 0) {
    if (!this.enabled) return;
    this._edgeTurn(dt);
    const m = this.state.player.mode;
    if (m === this._mode) return;
    this._mode = m;
    const wet = m === 'swim' || m === 'wade';
    this.bUp.textContent = wet ? 'ВСПЛЫТЬ' : 'ПРЫЖОК';
    this.bDown.textContent = wet ? 'НЫРНУТЬ' : 'ПРИСЕСТЬ';
  }
}

/** Указатель грубый и мыши нет — значит телефон/планшет, показываем слой сразу. */
export function coarsePointer() {
  return matchMedia('(pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches;
}
