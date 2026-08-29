import * as THREE from 'three';
import { getQuality } from './quality.js';
import { ENV_PRESETS, sunDirection, buildSkyTexture } from './env.js';
import { MaterialLibrary } from './materials.js';
import { Caustics } from './caustics.js';
import { Water } from './water.js';
import { PostPipeline } from './post.js';
import { buildLevel } from './builder.js';
import { LevelGrid } from './level.js';

const MAX_POINT_LIGHTS = 8;

export class Engine {
  constructor(canvas, qualityKey = 'high') {
    this.canvas = canvas;
    this.qualityKey = qualityKey;
    this.quality = getQuality(qualityKey);

    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: false, alpha: false, powerPreference: 'high-performance',
      stencil: false, depth: true
    });
    this.renderer.setPixelRatio(1);
    this.renderer.shadowMap.enabled = true;
    // карта теней перерисовывается только когда камера заметно сместилась
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.shadowMap.needsUpdate = true;
    this.renderer.shadowMap.type = this.quality.softShadows ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.info.autoReset = false;   // считаем статистику за весь кадр вручную

    // Рисовать в буферы половинной точности умеют не все мобильные GPU: часть
    // Mali и старых Adreno не даёт renderable RGBA16F, и тогда весь пост-проход
    // молча уходит в чёрный экран. Проверяем и при отказе честно падаем в 8 бит:
    // диапазон беднее и bloom клиппится, но игра идёт.
    const gl = this.renderer.getContext();
    this.hdrOK = !!(gl.getExtension('EXT_color_buffer_half_float')
                 || gl.getExtension('EXT_color_buffer_float'));
    this.hdrType = this.hdrOK ? THREE.HalfFloatType : THREE.UnsignedByteType;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(72, 1, 0.06, 400);

    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    this.pmrem.compileEquirectangularShader();

    this.matlib = new MaterialLibrary();
    this.matlib.setQuality(this.quality);
    this.caustics = new Caustics(this.quality.causticSize);
    this.matlib.setCaustics(this.caustics.texture);

    this.post = new PostPipeline(this.renderer, this.quality, this.hdrType);

    // --- свет ---
    this.sun = new THREE.DirectionalLight(0xffffff, 3);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(this.quality.shadowMapSize, this.quality.shadowMapSize);
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.045;
    this.sun.shadow.camera.near = 0.5;
    this.sun.shadow.camera.far = 220;
    this.shadowExtent = 46;
    this._setShadowExtent(this.shadowExtent);
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    this.hemi = new THREE.HemisphereLight(0xbfe4ee, 0x2a3336, 0.8);
    this.scene.add(this.hemi);

    this.pointLights = [];
    for (let i = 0; i < MAX_POINT_LIGHTS; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 20, 2);
      l.castShadow = false;
      this.scene.add(l);
      this.pointLights.push(l);
    }

    this.levelGroup = null;
    this.water = null;
    this.grid = null;
    this.level = null;
    this.lightSpecs = [];
    this.bobbers = [];
    this.time = 0;
    this.frame = 0;
    this.fade = 1;
    this._size = new THREE.Vector2(1, 1);
    this._tmp = new THREE.Vector3();

    // адаптивное разрешение: множитель поверх renderScale качества
    this._dynScale = 1;
    // предвыделенные буферы для выбора ближайших источников (без аллокаций в кадре)
    this._bestD = new Float64Array(MAX_POINT_LIGHTS);
    this._bestI = new Int32Array(MAX_POINT_LIGHTS);
    this._lightsInit = false;
    this._shadowAnchor = new THREE.Vector3(1e9, 1e9, 1e9);
    this._shadowDirty = true;

    // Переиспользуемые объекты для render(): раньше каждый кадр рождались
    // два Color, Vector3 и объект аргументов на два десятка полей — на 60 fps
    // это лишние сотни объектов в секунду и работа сборщику мусора.
    this._defaultExt = new THREE.Vector3(0.3, 0.1, 0.12);
    this._waterFog = new THREE.Color();
    this._waterShallow = new THREE.Color();
    this._sunScaled = new THREE.Color();
    this._ctx = {};

    // Режим обнаружения: мир обесцвечивается в грейдинге, а обитатели и еда
    // дорисовываются поверх кадра по своим слоям — в цвете и сквозь стены.
    // Отдельный буфер для этого не нужен, хватает двух вызовов после поста.
    this.reveal = 0;
    this._revealMats = [
      new THREE.MeshBasicMaterial({ color: 0xff5a4a, fog: false, depthTest: false,
        depthWrite: false, blending: THREE.AdditiveBlending, transparent: true }),
      new THREE.MeshBasicMaterial({ color: 0x8fffc4, fog: false, depthTest: false,
        depthWrite: false, blending: THREE.AdditiveBlending, transparent: true })
    ];
  }

  /** Множитель разрешения 0.5…1 для динамической подстройки под FPS. */
  setDynamicScale(s) {
    const v = Math.max(0.5, Math.min(1, s));
    if (Math.abs(v - this._dynScale) < 0.001) return false;
    this._dynScale = v;
    if (this._cssW) this.resize(this._cssW, this._cssH);
    return true;
  }
  get dynamicScale() { return this._dynScale; }

  _setShadowExtent(e) {
    const c = this.sun.shadow.camera;
    c.left = -e; c.right = e; c.top = e; c.bottom = -e;
    c.near = 0.5; c.far = e * 4.2;
    c.updateProjectionMatrix();
  }

  setQuality(key) {
    this.qualityKey = key;
    this.quality = getQuality(key);
    this.renderer.shadowMap.type = this.quality.softShadows ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    this.sun.shadow.mapSize.set(this.quality.shadowMapSize, this.quality.shadowMapSize);
    if (this.sun.shadow.map) { this.sun.shadow.map.dispose(); this.sun.shadow.map = null; }
    this.caustics.dispose();
    this.caustics = new Caustics(this.quality.causticSize);
    this.matlib.setQuality(this.quality);
    this.matlib.setCaustics(this.caustics.texture);
    this.post.dispose();
    this.post = new PostPipeline(this.renderer, this.quality, this.hdrType);
    if (this.water) this.water.uniforms.tCaustic.value = this.caustics.texture;
    if (this.level) this.loadLevel(this.level);
    if (this._cssW) this.resize(this._cssW, this._cssH);
  }

  applyEnvironment(level) {
    const src = ENV_PRESETS[level.env] || ENV_PRESETS.clinic;
    // Клонируем: движок правит preset «на лету» (панель настроек), а ENV_PRESETS —
    // общий словарь, его нельзя портить, иначе другие уровни унаследуют правки.
    const preset = (typeof structuredClone === 'function')
      ? structuredClone(src)
      : JSON.parse(JSON.stringify(src));
    this.preset = preset;

    const az = level.sunAzimuth ?? preset.sun.azimuth;
    const el = level.sunElevation ?? preset.sun.elevation;
    this.sunDir = sunDirection(az, el);

    this.sun.color.setHex(preset.sun.color);
    this.sun.intensity = preset.sun.intensity;
    this.hemi.color.setHex(preset.ambient.sky);
    this.hemi.groundColor.setHex(preset.ambient.ground);
    this.hemi.intensity = preset.ambient.intensity;

    const fogDensity = level.fogDensity ?? preset.fog.density;
    this.scene.fog = new THREE.FogExp2(preset.fog.color, fogDensity);
    this.fogDensity = fogDensity;

    if (this.skyTex) this.skyTex.dispose();
    this.skyTex = buildSkyTexture(preset, this.sunDir);
    if (this.envRT) this.envRT.dispose();
    this.envRT = this.pmrem.fromEquirectangular(this.skyTex);
    this.scene.environment = this.envRT.texture;
    this.scene.background = this.skyTex;
    this.scene.backgroundIntensity = 1.0;
    this.scene.environmentIntensity = 1.0;

    this.matlib.setSunColor(this.sun.color);
    this.matlib.setCausticStrength(level.causticStrength ?? 1.6);
    this.matlib.setEnvIntensity(1.0);

    if (this.water) {
      this.water.applyPreset(preset.water, new THREE.Color(preset.ambient.sky).multiplyScalar(preset.ambient.intensity * 0.5));
      this.water.uniforms.uSunDir.value.copy(this.sunDir);
      this.water.uniforms.uSunColor.value.copy(this.sun.color).multiplyScalar(this.sun.intensity * 0.55);
      this.water.uniforms.tSky.value = this.skyTex;
    }
  }

  loadLevel(level) {
    this.disposeLevel();
    this.level = level;
    this.grid = new LevelGrid(level);

    const built = buildLevel(level, this.matlib, this.quality);
    this.levelGroup = built.group;
    this.scene.add(this.levelGroup);
    this.lightSpecs = built.lightSpecs;
    this.bobbers = built.bob;
    this.bounds = built.bounds;

    if (built.waterGeom) {
      this.water = new Water(built.waterGeom, {
        waterY: level.waterY, quality: this.quality,
        hdrType: this.hdrType,
        reflectInterval: this.quality.reflectInterval ?? 1,
        refractInterval: this.quality.refractInterval ?? 1,
        size: new THREE.Vector2(this._size.x || 1280, this._size.y || 720)
      });
      this.water.uniforms.tCaustic.value = this.caustics.texture;
      this.scene.add(this.water.mesh);
      this.matlib.setWater(level.waterY, true);
    } else {
      this.water = null;
      this.matlib.setWater(-999, false);
    }

    // масштаб теневой карты под размер уровня
    const span = Math.max(level.w, level.h) * level.cell;
    this.shadowExtent = Math.min(60, Math.max(28, span * 0.32));
    this._setShadowExtent(this.shadowExtent);
    this._shadowDirty = true;
    this._lightsInit = false;
    this.renderer.shadowMap.needsUpdate = true;

    this.applyEnvironment(level);
    if (this._size.x > 1) this.resize(this._cssW, this._cssH);
  }

  disposeLevel() {
    if (this.levelGroup) {
      this.scene.remove(this.levelGroup);
      this.levelGroup.traverse(o => { if (o.geometry) o.geometry.dispose(); });
      this.levelGroup = null;
    }
    if (this.water) { this.scene.remove(this.water.mesh); this.water.dispose(); this.water = null; }
    this.matlib.dispose();
    this.matlib = new MaterialLibrary();
    this.matlib.setQuality(this.quality);
    this.matlib.setCaustics(this.caustics.texture);
  }

  resize(cssW, cssH) {
    this._cssW = cssW; this._cssH = cssH;
    const scale = this.quality.renderScale * this._dynScale;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const w = Math.max(2, Math.floor(cssW * dpr * scale));
    const h = Math.max(2, Math.floor(cssH * dpr * scale));
    this._size.set(w, h);
    this.renderer.setSize(w, h, false);
    this.canvas.style.width = cssW + 'px';
    this.canvas.style.height = cssH + 'px';
    this.camera.aspect = cssW / cssH;
    this.camera.updateProjectionMatrix();
    this.post.setSize(w, h);
    if (this.water) this.water.setSize(w, h);
  }

  /**
   * Выбор восьми ближайших источников без аллокаций: частичная вставка
   * вместо сортировки всего списка (их бывает под сотню).
   */
  _updateLights(camPos) {
    if (this._lightsInit && (this.frame % 3) !== 0) return;
    this._lightsInit = true;
    const specs = this.lightSpecs;
    const n = MAX_POINT_LIGHTS;
    if (!specs.length) { for (let i = 0; i < n; i++) this.pointLights[i].intensity = 0; return; }

    const bestD = this._bestD, bestI = this._bestI;
    bestD.fill(Infinity); bestI.fill(-1);
    const maxD2 = 60 * 60;
    for (let s = 0; s < specs.length; s++) {
      const sp = specs[s];
      const dx = sp.x - camPos.x, dy = sp.y - camPos.y, dz = sp.z - camPos.z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d >= bestD[n - 1] || d > maxD2) continue;
      let k = n - 1;
      while (k > 0 && bestD[k - 1] > d) { bestD[k] = bestD[k - 1]; bestI[k] = bestI[k - 1]; k--; }
      bestD[k] = d; bestI[k] = s;
    }
    for (let i = 0; i < n; i++) {
      const l = this.pointLights[i];
      const si = bestI[i];
      if (si < 0) { l.intensity = 0; continue; }
      const sp = specs[si];
      l.position.set(sp.x, sp.y, sp.z);
      l.color.setHex(sp.color);
      l.distance = sp.distance;
      const fade = 1 - Math.min(1, Math.sqrt(bestD[i]) / 60);
      l.intensity = sp.intensity * (0.25 + 0.75 * fade);
    }
  }

  /**
   * Теневая камера едет за игроком, но перерисовывается только когда он
   * ушёл дальше порога. Позиция привязана к сетке текселей — иначе тени «ползут».
   */
  _updateSun(camPos) {
    const a = this._shadowAnchor;
    const thr = this.quality.shadowUpdateDist ?? 3;
    const dx = camPos.x - a.x, dy = camPos.y - a.y, dz = camPos.z - a.z;
    if (!this._shadowDirty && dx * dx + dy * dy + dz * dz < thr * thr) return;

    const texel = (2 * this.shadowExtent) / this.quality.shadowMapSize;
    const grid = texel * 4;
    a.set(Math.round(camPos.x / grid) * grid, Math.round(camPos.y / grid) * grid, Math.round(camPos.z / grid) * grid);
    this._shadowDirty = false;

    const d = this.sunDir;
    const dist = this.shadowExtent * 2.1;
    this.sun.position.set(a.x + d.x * dist, a.y + d.y * dist, a.z + d.z * dist);
    this.sun.target.position.copy(a);
    this.sun.target.updateMatrixWorld();
    this.sun.updateMatrixWorld();
    this.renderer.shadowMap.needsUpdate = true;
  }

  update(dt) {
    this.time += dt;
    this.matlib.setTime(this.time);
    if (this.water) this.water.uniforms.uTime.value = this.time;
    for (const b of this.bobbers) {
      b.obj.position.y = b.baseY + Math.sin(this.time * b.speed + b.phase) * b.amp;
      b.obj.rotation.z = Math.sin(this.time * b.speed * 0.7 + b.phase) * 0.12;
      b.obj.rotation.x = Math.cos(this.time * b.speed * 0.53 + b.phase) * 0.1;
    }
  }

  render() {
    const cam = this.camera;
    this.frame++;
    this.renderer.info.reset();
    this._updateSun(cam.position);
    this._updateLights(cam.position);

    this.caustics.render(this.renderer, this.time);
    if (this.water) this.water.update(this.renderer, this.scene, cam, this.frame);

    const p = this.preset;
    const underwater = !!(this.water && cam.position.y < this.water.waterY - 0.06);

    const waterExt = this.water ? this.water.uniforms.uExtinction.value : this._defaultExt;
    const wd = p.water.deep, ws = p.water.shallow;
    this._waterFog.setRGB(wd[0], wd[1], wd[2]);
    this._waterShallow.setRGB(ws[0], ws[1], ws[2]);
    this._waterFog.lerp(this._waterShallow, 0.35);
    this._sunScaled.copy(this.sun.color).multiplyScalar(this.sun.intensity * 0.30);

    const c = this._ctx;
    c.scene = this.scene;
    c.camera = cam;
    c.sun = this.sun;
    c.sunDir = this.sunDir;
    c.sunColor = this._sunScaled;
    c.volTint = p.volumetric.color;
    c.volumetricIntensity = p.volumetric.intensity * (underwater ? 0.35 : 1);
    c.fogDensity = this.fogDensity;
    c.time = this.time;
    c.underwater = underwater;
    c.causticTex = this.caustics.texture;
    c.waterY = this.water ? this.water.waterY : 0;
    c.waterExtinction = waterExt;
    c.waterFogColor = this._waterFog;
    c.exposure = (this.level?.exposure ?? p.post.exposure);
    c.bloom = p.post.bloom;
    c.bloomThreshold = p.post.bloomThreshold;
    c.vignette = p.post.vignette;
    c.grain = p.post.grain;
    c.chroma = p.post.chroma;
    // на время вспышки уводим цвет мира в ноль — обитатели останутся цветными
    c.saturation = p.post.saturation * (1 - this.reveal * 0.95);
    c.contrast = p.post.contrast * (1 + this.reveal * 0.18);
    c.lift = p.post.lift;
    c.gain = p.post.gain;
    c.fade = this.fade;
    this.post.render(c);
    if (this.reveal > 0.002) this._renderReveal(cam);
  }

  /** Подсветка обитателей и еды поверх готового кадра, по слоям 1 и 2. */
  _renderReveal(cam) {
    const r = this.renderer;
    const prevAuto = r.autoClear;
    const prevOverride = this.scene.overrideMaterial;
    const prevMask = cam.layers.mask;
    r.autoClear = false;
    r.setRenderTarget(null);
    for (let i = 0; i < 2; i++) {
      this._revealMats[i].opacity = this.reveal;
      this.scene.overrideMaterial = this._revealMats[i];
      cam.layers.set(i + 1);
      r.render(this.scene, cam);
    }
    this.scene.overrideMaterial = prevOverride;
    cam.layers.mask = prevMask;
    r.autoClear = prevAuto;
  }

  dispose() {
    this.disposeLevel();
    this.post.dispose();
    this.caustics.dispose();
    this.pmrem.dispose();
    if (this.envRT) this.envRT.dispose();
    if (this.skyTex) this.skyTex.dispose();
    this.renderer.dispose();
  }
}
