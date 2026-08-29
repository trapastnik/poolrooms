// Оверлей поверх игры: слева — живая телеметрия рендера, справа — параметры
// картинки, которые можно крутить прямо во время игры. Открывается по F3.
//
// Все правки идут в структуры, которые движок читает каждый кадр
// (engine.preset.post/volumetric, engine.fogDensity, engine.sun.intensity,
//  water.uniforms.*), поэтому эффект виден мгновенно, без пересборки.

const NUM = (v, d = 2) => (v == null ? '—' : (+v).toFixed(d));

export class DevPanel {
  constructor(state) {
    this.state = state;
    this.open = false;
    this.controls = [];
    this._acc = 0;
    this._buildDom();
  }

  get engine() { return this.state.engine; }

  toggle(force) {
    this.open = force == null ? !this.open : force;
    this.root.classList.toggle('hidden', !this.open);
    this.state.devOpen = this.open;
    document.getElementById('c').style.cursor = this.open ? 'default' : 'none';
    if (this.open) {
      // мышь нужна для ползунков — отпускаем захват, но игру НЕ ставим на паузу
      document.exitPointerLock?.();
      this.syncFromEngine();
    } else if (this.state.running) {
      // вернём управление
      const canvas = document.getElementById('c');
      try { canvas.requestPointerLock?.(); } catch (_) { }
    }
  }

  // ---- построение интерфейса ----
  _buildDom() {
    const root = document.createElement('div');
    root.id = 'dev';
    root.className = 'hidden';
    root.innerHTML = `
      <div id="devHead">
        <span>РЕНДЕР · ТЕЛЕМЕТРИЯ</span>
        <button id="devClose" title="Закрыть (F3)">✕</button>
      </div>
      <div id="devBody">
        <div id="devStats"></div>
        <div id="devCtl"></div>
      </div>
      <div id="devFoot">F3 — скрыть · правки применяются сразу · не влияют на сохранённый уровень</div>`;
    document.body.appendChild(root);
    this.root = root;
    this.statsEl = root.querySelector('#devStats');
    this.ctlEl = root.querySelector('#devCtl');
    root.querySelector('#devClose').addEventListener('click', () => this.toggle(false));
    // не даём кликам/колесу по панели уходить в игру
    for (const ev of ['mousedown', 'mouseup', 'click', 'wheel', 'contextmenu', 'keydown']) {
      root.addEventListener(ev, (e) => e.stopPropagation());
    }
    this._buildControls();
  }

  _group(title) {
    const h = document.createElement('div');
    h.className = 'devGroup';
    h.textContent = title;
    this.ctlEl.appendChild(h);
  }

  /** Ползунок: get/set читают/пишут «живое» значение в движке. */
  _slider(label, min, max, step, get, set, fmt = 2) {
    const row = document.createElement('label');
    row.className = 'devRow';
    const name = document.createElement('span');
    name.className = 'devLbl';
    name.textContent = label;
    const val = document.createElement('span');
    val.className = 'devVal';
    const input = document.createElement('input');
    input.type = 'range';
    input.min = min; input.max = max; input.step = step;
    input.addEventListener('input', () => {
      set(parseFloat(input.value));
      val.textContent = NUM(parseFloat(input.value), fmt);
    });
    row.appendChild(name);
    row.appendChild(input);
    row.appendChild(val);
    this.ctlEl.appendChild(row);
    const ctl = { input, val, get, fmt, kind: 'slider' };
    this.controls.push(ctl);
    return ctl;
  }

  _toggle(label, get, set) {
    const row = document.createElement('label');
    row.className = 'devRow devToggle';
    const name = document.createElement('span');
    name.className = 'devLbl';
    name.textContent = label;
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.addEventListener('change', () => set(input.checked));
    row.appendChild(name);
    row.appendChild(input);
    this.ctlEl.appendChild(row);
    this.controls.push({ input, get, kind: 'toggle' });
  }

  _buildControls() {
    const S = this.state;
    const post = () => this.engine.preset.post;
    const vol = () => this.engine.preset.volumetric;

    this._group('Камера');
    this._slider('Поле зрения', 55, 100, 1, () => this.engine.camera.fov, (v) => {
      this.engine.camera.fov = v; this.engine.camera.updateProjectionMatrix();
    }, 0);
    this._slider('Чувств. мыши', 0.5, 6, 0.1,
      () => S.player.sensitivity * 1000, (v) => { S.player.sensitivity = v / 1000; }, 1);

    this._group('Экспозиция и тон');
    this._slider('Экспозиция', 0.4, 2.0, 0.01,
      () => this.engine.level?.exposure ?? post().exposure,
      (v) => { post().exposure = v; if (this.engine.level) this.engine.level.exposure = v; });
    this._slider('Контраст', 0.7, 1.5, 0.01, () => post().contrast, (v) => post().contrast = v);
    this._slider('Насыщенность', 0.5, 1.6, 0.01, () => post().saturation, (v) => post().saturation = v);

    this._group('Свечение (bloom)');
    this._slider('Сила', 0, 2, 0.01, () => post().bloom, (v) => post().bloom = v);
    this._slider('Порог', 0.4, 1.6, 0.01, () => post().bloomThreshold, (v) => post().bloomThreshold = v);

    this._group('Атмосфера');
    this._slider('Плотность тумана', 0, 0.06, 0.001,
      () => this.engine.fogDensity,
      (v) => { this.engine.fogDensity = v; if (this.engine.scene.fog) this.engine.scene.fog.density = v; }, 3);
    this._slider('Объёмные лучи', 0, 2.5, 0.01, () => vol().intensity, (v) => vol().intensity = v);

    this._group('Свет');
    this._slider('Солнце', 0, 6, 0.05, () => this.engine.sun.intensity, (v) => this.engine.sun.intensity = v);
    this._slider('Заполняющий', 0, 2, 0.02, () => this.engine.hemi.intensity, (v) => this.engine.hemi.intensity = v);
    this._slider('Каустики', 0, 3, 0.02,
      () => this.engine.matlib.shared.uCausticStrength.value,
      (v) => this.engine.matlib.setCausticStrength(v));

    this._group('Вода');
    this._slider('Мутность', 0, 1.5, 0.01,
      () => this.engine.water ? this.engine.water.uniforms.uTurbidity.value : 0,
      (v) => { if (this.engine.water) this.engine.water.uniforms.uTurbidity.value = v; });
    this._slider('Пена', 0, 2, 0.02,
      () => this.engine.water ? this.engine.water.uniforms.uFoam.value : 0,
      (v) => { if (this.engine.water) this.engine.water.uniforms.uFoam.value = v; });

    this._group('Пост-эффекты');
    this._slider('Виньетка', 0, 1, 0.01, () => post().vignette, (v) => post().vignette = v);
    this._slider('Зерно', 0, 0.12, 0.002, () => post().grain, (v) => post().grain = v, 3);
    this._slider('Хром. аберрация', 0, 0.006, 0.0002, () => post().chroma, (v) => post().chroma = v, 4);

    this._group('Производительность');
    this._slider('Масштаб рендера', 0.5, 1, 0.02,
      () => this.engine.dynamicScale,
      (v) => { S.adaptive = false; const a = document.getElementById('adaptChk'); if (a) a.checked = false; S.adaptScale = v; this.engine.setDynamicScale(v); });
    this._toggle('Адаптивное разрешение', () => S.adaptive, (on) => {
      S.adaptive = on; const a = document.getElementById('adaptChk'); if (a) a.checked = on;
      if (!on) { S.adaptScale = 1; this.engine.setDynamicScale(1); }
    });
    this._toggle('Вода', () => this.engine.water ? this.engine.water.enabled : false, (on) => {
      if (this.engine.water) { this.engine.water.enabled = on; this.engine.water.mesh.visible = on; }
    });

    // Кнопка сброса к пресету окружения
    const btn = document.createElement('button');
    btn.id = 'devReset';
    btn.textContent = 'Сбросить к пресету';
    btn.addEventListener('click', () => {
      if (!this.engine.level) return;
      if (this.engine.level.exposure != null) this.engine.level.exposure = null;
      this.engine.camera.fov = 72; this.engine.camera.updateProjectionMatrix();
      this.engine.applyEnvironment(this.engine.level);   // переклонирует пресет и вернёт туман/солнце/воду
      this.syncFromEngine();
    });
    this.ctlEl.appendChild(btn);
  }

  /** Подтянуть позиции ползунков из текущего состояния движка. */
  syncFromEngine() {
    if (!this.engine) return;
    for (const c of this.controls) {
      if (c.kind === 'slider') {
        const v = c.get();
        c.input.value = String(v);
        c.val.textContent = NUM(v, c.fmt);
      } else if (c.kind === 'toggle') {
        c.input.checked = !!c.get();
      }
    }
  }

  // ---- телеметрия, вызывается из игрового цикла ----
  update(dt, fps) {
    if (!this.open) return;
    this._acc += dt;
    if (this._acc < 0.2) return;
    this._acc = 0;

    const e = this.engine;
    const info = e.renderer.info;
    const p = this.state.player;
    const q = e.quality;
    const water = e.water;
    const waterState = !water ? 'нет' : (water.skipped ? 'пропуск' : 'активна ×2 RT');
    const buf = e._size;
    let lamps = 0;
    for (const l of e.pointLights) if (l.intensity > 0.01) lamps++;
    const ms = fps > 0 ? (1000 / fps) : 0;

    const rows = [
      ['FPS', `${fps}  ·  ${NUM(ms, 1)} мс`],
      ['Разрешение', `${buf.x}×${buf.y}  (${Math.round(e.dynamicScale * 100)}%)`],
      ['Вызовы отрисовки', info.render.calls],
      ['Треугольники', (info.render.triangles / 1000).toFixed(0) + 'k'],
      ['Геометрий / текстур', `${info.memory.geometries} / ${info.memory.textures}`],
      ['Программ (шейдеров)', info.programs ? info.programs.length : '—'],
      ['Вода (RT)', waterState],
      ['Отражение', water ? `каждые ${q.reflectInterval} к.` : '—'],
      ['Тени', e.renderer.shadowMap.needsUpdate ? 'обновление' : 'кэш'],
      ['Источников света', lamps + ' / ' + e.pointLights.length],
      ['Объёмн. лучи', `${q.volumetricSteps} шаг · ×${NUM(e.preset.volumetric.intensity)}`],
      ['Качество', `${q.name}`],
      ['Окружение', e.preset.label || e.level?.env || '—'],
      ['Камера XYZ', `${NUM(p.pos.x, 1)}, ${NUM(p.pos.y + p.eye, 1)}, ${NUM(p.pos.z, 1)}`],
      ['Состояние', p.noclip ? 'полёт' : (p.mode === 'swim' ? 'плавание' : p.mode === 'wade' ? 'брод' : 'ходьба')]
    ];

    this.statsEl.innerHTML = rows.map(([k, v]) =>
      `<div class="devStatRow"><span>${k}</span><b>${v}</b></div>`).join('');
  }
}
