/** Полностью процедурная звуковая среда на WebAudio — ни одного внешнего файла. */
export class Ambience {
  constructor() {
    this.ctx = null;
    this.started = false;
    this.volume = 0.7;
    this.musicVolume = 0.22;   // фон намеренно тихий: он подложка, а не номер
    this.music = null;
    this.musicGain = null;
    this.musicSource = null;
    this.musicStatus = 'off';
    this._depth = 0;
    this._fallbackTried = false;
    this._retryArmed = false;
    this._underwater = 0;
  }

  _noiseBuffer(seconds = 3, pink = true) {
    const ctx = this.ctx;
    const n = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < n; i++) {
      const white = Math.random() * 2 - 1;
      if (!pink) { d[i] = white; continue; }
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.96900 * b2 + white * 0.1538520;
      b3 = 0.86650 * b3 + white * 0.3104856;
      b4 = 0.55000 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.0168980;
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
      b6 = white * 0.115926;
    }
    return buf;
  }

  _reverb(seconds = 2.6, decay = 2.6) {
    const ctx = this.ctx;
    const n = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < n; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, decay);
      }
    }
    return buf;
  }

  start() {
    if (this.started) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    const ctx = this.ctx;
    this.started = true;

    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(ctx.destination);

    // общий «мокрый» тракт: большой кафельный зал = длинная реверберация
    this.conv = ctx.createConvolver();
    this.conv.buffer = this._reverb(3.4, 2.2);
    this.wet = ctx.createGain(); this.wet.gain.value = 0.55;
    this.conv.connect(this.wet); this.wet.connect(this.master);

    this.dry = ctx.createGain(); this.dry.gain.value = 0.8;
    this.dry.connect(this.master);

    this._startMusic();

    // фильтр «под водой»
    this.uwFilter = ctx.createBiquadFilter();
    this.uwFilter.type = 'lowpass';
    this.uwFilter.frequency.value = 20000;
    this.uwFilter.Q.value = 0.4;
    this.uwFilter.connect(this.dry);
    this.uwFilter.connect(this.conv);

    const pink = this._noiseBuffer(4, true);

    // 1) гул помещения
    const hum = ctx.createBufferSource();
    hum.buffer = pink; hum.loop = true;
    const humF = ctx.createBiquadFilter();
    humF.type = 'lowpass'; humF.frequency.value = 190; humF.Q.value = 0.7;
    const humG = ctx.createGain(); humG.gain.value = 0.55;
    hum.connect(humF); humF.connect(humG); humG.connect(this.uwFilter);
    hum.start();

    // 2) плеск воды — шум с медленно гуляющей полосой
    const lap = ctx.createBufferSource();
    lap.buffer = pink; lap.loop = true;
    const lapF = ctx.createBiquadFilter();
    lapF.type = 'bandpass'; lapF.frequency.value = 900; lapF.Q.value = 1.1;
    this.lapGain = ctx.createGain(); this.lapGain.gain.value = 0.16;
    lap.connect(lapF); lapF.connect(this.lapGain); this.lapGain.connect(this.uwFilter);
    lap.start();

    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.13;
    const lfoG = ctx.createGain(); lfoG.gain.value = 420;
    lfo.connect(lfoG); lfoG.connect(lapF.frequency);
    lfo.start();

    const lfo2 = ctx.createOscillator();
    lfo2.frequency.value = 0.071;
    const lfo2G = ctx.createGain(); lfo2G.gain.value = 0.07;
    lfo2.connect(lfo2G); lfo2G.connect(this.lapGain.gain);
    lfo2.start();

    // 3) далёкое гудение ламп
    this.buzz = ctx.createOscillator();
    this.buzz.type = 'sawtooth';
    this.buzz.frequency.value = 100;
    const buzzF = ctx.createBiquadFilter();
    buzzF.type = 'bandpass'; buzzF.frequency.value = 1200; buzzF.Q.value = 6;
    this.buzzG = ctx.createGain(); this.buzzG.gain.value = 0.0;
    this.buzz.connect(buzzF); buzzF.connect(this.buzzG); this.buzzG.connect(this.uwFilter);
    this.buzz.start();

    this._scheduleDrip();
  }

  _scheduleDrip() {
    if (!this.ctx) return;
    const delay = 2500 + Math.random() * 7000;
    this._dripTimer = setTimeout(() => { this.drip(); this._scheduleDrip(); }, delay);
  }

  drip() {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    const f0 = 900 + Math.random() * 1400;
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(f0 * 0.35, t + 0.09);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.16, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    osc.connect(g); g.connect(this.conv); g.connect(this.dry);
    osc.start(t); osc.stop(t + 0.2);
  }

  /**
   * Фоновая музыка. Отдельным файлом рядом со страницей, а не внутри неё:
   * три мегабайта в base64 раздули бы game.html вчетверо, а gzip на уже сжатом
   * звуке ничего не даёт. Нет файла — просто нет музыки, игра не ломается.
   *
   * Основной путь — MediaElementSource: элемент стримит, и две минуты стерео не
   * висят в памяти распакованными. Но на телефонах у media-элементов хватает
   * своих причуд (политика автозапуска, придирки к типу, на iPhone — переключатель
   * «без звука», который глушит медиа, но не синтезированный звук). Поэтому если
   * элемент за секунду с небольшим так и не поехал, уходим на чистый WebAudio:
   * он звучит там же, где звучит вся остальная озвучка игры.
   */
  _startMusic() {
    const ctx = this.ctx;
    this.musicStatus = 'loading';
    try {
      const el = new Audio();
      el.loop = true;
      el.preload = 'auto';
      const sources = [['assets/music.webm', 'audio/webm; codecs=opus'],
                       ['assets/music.mp3', 'audio/mpeg']];
      const playable = sources.find(([, type]) => el.canPlayType(type));
      if (!playable) { this._musicFallback(); return; }
      this._musicUrl = playable[0];
      el.src = this._musicUrl;

      const src = ctx.createMediaElementSource(el);
      this._buildMusicChain(src);
      this.music = el;

      el.addEventListener('error', () => { this.music = null; this._musicFallback(); });
      el.play().then(() => { this.musicStatus = 'element'; })
        .catch(() => { this._armMusicRetry(); });

      // не поехало за 1.2 с — значит не поедет: пробуем другой путь
      setTimeout(() => {
        if (this.musicStatus !== 'element' || !this.music || this.music.currentTime < 0.05) {
          this._musicFallback();
        }
      }, 1200);
    } catch (_) {
      this._musicFallback();
    }
  }

  /**
   * Общий хвост тракта: «подводный» фильтр → компрессор → громкость.
   *
   * Компрессор здесь не для красоты. На телефонном динамике низа почти нет, и
   * ровный электронный трек на нём звучит заметно тише, чем на компьютере,
   * хотя цифра громкости та же. Компрессор подтягивает тихие места, а лёгкий
   * подъём верхней середины возвращает то, что маленький динамик не отдаёт.
   */
  _buildMusicChain(node) {
    if (this.musicGain) return node.connect(this.musicIn);
    const ctx = this.ctx;
    // Компрессор с подъёмом верхов задуман для телефонного динамика, у которого
    // нет низа. На компьютере он не помогает, а наоборот сплющивает динамику:
    // трек звучит навязчиво громко и почти не реагирует на ползунок.
    const phone = matchMedia('(pointer: coarse)').matches
      && !matchMedia('(any-pointer: fine)').matches;

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 20000;

    const shelf = ctx.createBiquadFilter();
    shelf.type = 'highshelf';
    shelf.frequency.value = 1800;
    shelf.gain.value = 3.5;

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -26;
    comp.knee.value = 22;
    comp.ratio.value = 4;
    comp.attack.value = 0.01;
    comp.release.value = 0.28;

    const g = ctx.createGain();
    g.gain.value = this.musicVolume;

    // Порядок важен: сперва «телефонная» коррекция, потом подводный срез.
    // Когда подъём верхов стоял ПОСЛЕ фильтра, он возвращал ровно то, что
    // фильтр убирал, и погружение переставало быть слышно.
    if (phone) {
      shelf.connect(lp); lp.connect(comp); comp.connect(g);
      this.musicIn = shelf;
    } else {
      lp.connect(g);                 // на компьютере — только подводный фильтр
      this.musicIn = lp;
    }
    g.connect(this.master);
    this.musicGain = g;
    this.musicFilter = lp;
    node.connect(this.musicIn);
  }

  /** Запасной путь: скачать, раскодировать и играть буфером. */
  async _musicFallback() {
    if (this._fallbackTried) return;
    this._fallbackTried = true;
    if (this.music) { try { this.music.pause(); } catch (_) { } this.music = null; }
    try {
      const res = await fetch(this._musicUrl || 'assets/music.mp3');
      if (!res.ok) throw new Error(res.status);
      const buf = await this.ctx.decodeAudioData(await res.arrayBuffer());
      const node = this.ctx.createBufferSource();
      node.buffer = buf;
      node.loop = true;
      this._buildMusicChain(node);
      node.start();
      this.musicSource = node;
      this.musicStatus = 'buffer';
    } catch (_) {
      this.musicStatus = 'нет звука: файл не читается';
      this._armMusicRetry();
    }
  }

  /** Браузер не дал играть без жеста — повторим на первое касание. */
  _armMusicRetry() {
    if (this._retryArmed) return;
    this._retryArmed = true;
    this.musicStatus = 'ждёт касания';
    const retry = () => {
      this.ctx?.resume();
      if (this.music) this.music.play().then(() => { this.musicStatus = 'element'; }).catch(() => { });
      else { this._fallbackTried = false; this._musicFallback(); }
      window.removeEventListener('pointerdown', retry);
      window.removeEventListener('touchstart', retry);
    };
    window.addEventListener('pointerdown', retry, { once: true });
    window.addEventListener('touchstart', retry, { once: true });
  }

  setMusicVolume(v) {
    this.musicVolume = Math.max(0, Math.min(1, v));
    if (this.musicGain) this.musicGain.gain.value = this.musicVolume;
  }

  _burst({ freq = 600, q = 1, dur = 0.14, gain = 0.1, sweep = 0.4 }) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this._noiseBuffer(0.35, false);
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass'; f.Q.value = q;
    f.frequency.setValueAtTime(freq, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(60, freq * sweep), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f); f.connect(g); g.connect(this.uwFilter);
    src.start(t); src.stop(t + dur + 0.05);
  }

  step(mode, sprint) {
    if (mode === 'ground') this._burst({ freq: 1500 + Math.random() * 500, q: 0.9, dur: 0.07, gain: sprint ? 0.075 : 0.05, sweep: 0.25 });
    else this._burst({ freq: 700 + Math.random() * 400, q: 0.6, dur: 0.24, gain: 0.10, sweep: 0.35 });
  }

  splash(power) {
    this._burst({ freq: 1100, q: 0.4, dur: 0.5, gain: Math.min(0.28, 0.07 + power * 0.05), sweep: 0.15 });
  }

  /** Кто-то вошёл в комнату ожидания: короткая восходящая двузвучка. */
  join(up = true) {
    if (!this.started) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const notes = up ? [660, 990] : [520, 350];
    notes.forEach((f, i) => {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = f;
      const at = t + i * 0.09;
      g.gain.setValueAtTime(0, at);
      g.gain.linearRampToValueAtTime(0.12, at + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.22);
      osc.connect(g); g.connect(this.dry); g.connect(this.conv);
      osc.start(at); osc.stop(at + 0.25);
    });
  }

  /** Низкий рык обитателя: два наложенных всплеска шума с уходом вниз. */
  growl(power = 1) {
    if (!this.started) return;
    this._burst({ freq: 90 + Math.random() * 40, q: 3.5, dur: 0.55 + power * 0.35,
                  gain: 0.05 + power * 0.10, sweep: 0.35 });
    this._burst({ freq: 210 + Math.random() * 60, q: 6, dur: 0.30 + power * 0.2,
                  gain: 0.02 + power * 0.05, sweep: 0.5 });
  }

  dive() {
    this._burst({ freq: 420, q: 0.5, dur: 0.75, gain: 0.20, sweep: 0.12 });
  }

  surface() {
    this._burst({ freq: 1800, q: 0.5, dur: 0.4, gain: 0.16, sweep: 0.2 });
  }

  /** underwater: 0..1, lamps: 0..1 — сколько рядом гудящих ламп */
  /**
   * @param underwater 0/1 — голова под водой
   * @param lamps      близость ламп для гудения
   * @param depth      метров над головой; глушит музыку тем сильнее, чем глубже
   */
  update(underwater, lamps = 0, depth = 0) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this._underwater += (underwater - this._underwater) * 0.08;
    // толща воды над головой: 8 метров считаем полной глубиной
    this._depth += (Math.min(1, Math.max(0, depth) / 8) - this._depth) * 0.05;
    const f = 20000 * Math.pow(0.018, this._underwater);
    this.uwFilter.frequency.setTargetAtTime(f, t, 0.12);
    this.wet.gain.setTargetAtTime(0.55 + this._underwater * 0.35, t, 0.3);
    if (this.musicFilter) {
      // под водой музыку глушим так же, как остальной звук
      // Слух воспринимает частоту логарифмически, поэтому и уводим её так же:
      // при линейном спуске первая половина погружения была почти не слышна.
      // Первый множитель — сам факт погружения (как было), второй — толща воды:
      // у поверхности звучит по-прежнему, на глубине уходит ещё ниже.
      this.musicFilter.frequency.setTargetAtTime(
        20000 * Math.pow(0.025, this._underwater) * Math.pow(0.35, this._depth), t, 0.25);
    }
    if (this.musicGain) {
      this.musicGain.gain.setTargetAtTime(
        this.musicVolume * (1 - this._underwater * 0.35) * (1 - this._depth * 0.35), t, 0.3);
    }
    this.lapGain.gain.setTargetAtTime(0.16 * (1 - this._underwater * 0.75), t, 0.3);
    this.buzzG.gain.setTargetAtTime(0.012 * lamps * (1 - this._underwater * 0.9), t, 0.4);
  }

  setVolume(v) {
    this.volume = v;
    if (this.master) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
    this.music?.play().catch(() => { });   // буферный источник живёт вместе с ctx
  }
  suspend() {
    if (this.ctx && this.ctx.state === 'running') this.ctx.suspend();
    this.music?.pause();
  }
}
