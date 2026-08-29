import * as THREE from 'three';
import { GLSL_HASH, GLSL_NOISE, GLSL_DEPTH } from './shaderlib.js';

// Пороги «камера считается неподвижной». Смещение — чуть выше амплитуды дыхания
// камеры (±8 мм). Поворот 0.0025 рад при поле зрения 72° — это около двух пикселей
// на экране 1080p, то есть заведомо ниже заметности.
const MOVE_EPS = 0.02;
const ROT_EPS = 0.0025;
const IDLE_REFRESH = 8;      // кадров, через которые обновляем даже в покое
                             // (в сцене с живностью менеджер монстров снижает — см. water.idleRefresh)

const VERT = /* glsl */ `
precision highp float;
varying vec3 vWPos;
uniform float uTime;
uniform float uWaveAmp;
${GLSL_HASH}
${GLSL_NOISE}

float waveH(vec2 p, float t){
  float h = 0.0;
  h += sin(dot(p, vec2( 0.92, 0.39)) *  1.7 + t * 1.35) * 0.055;
  h += sin(dot(p, vec2(-0.44, 0.90)) *  2.6 + t * 1.75) * 0.034;
  h += sin(dot(p, vec2( 0.70,-0.71)) *  4.3 + t * 2.35) * 0.019;
  h += sin(dot(p, vec2(-0.98,-0.20)) *  7.1 + t * 3.10) * 0.011;
  return h;
}

void main(){
  vec3 p = position;
  p.y += waveH(p.xz, uTime) * uWaveAmp;
  vec4 wp = modelMatrix * vec4(p, 1.0);
  vWPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const FRAG = /* glsl */ `
precision highp float;
varying vec3 vWPos;

uniform sampler2D tReflect;
uniform sampler2D tRefract;
uniform sampler2D tDepth;
uniform sampler2D tCaustic;
uniform sampler2D tSky;

uniform float uTime;
uniform float uNear, uFar;
uniform vec3  uSunDir;
uniform vec3  uSunColor;
uniform vec3  uShallow;
uniform vec3  uDeep;
uniform vec3  uExtinction;
uniform vec3  uFoamColor;
uniform float uTurbidity;
uniform float uFoam;
uniform float uDistort;
uniform float uReflectivity;
uniform float uUnderwater;
uniform float uHasReflection;
uniform float uCausticScale;
uniform vec3  uAmbient;
uniform float uRipple;
uniform mat4  uReflVP;
uniform mat4  uRefrVP;

${GLSL_HASH}
${GLSL_NOISE}
${GLSL_DEPTH}

const float PI = 3.14159265359;

/**
 * Градиент гладкой части волны — аналитически.
 * У суммы синусов производная известна точно, поэтому конечные разности здесь
 * не нужны: раньше нормаль стоила три вызова waveH (18 синусов на фрагмент),
 * теперь — шесть косинусов. Заодно склон на высоких частотах перестал
 * занижаться: шаг e=0.03 составлял почти десятую длины самой мелкой волны.
 */
vec2 waveGrad(vec2 p, float t){
  vec2 g = vec2(0.0);
  g += cos(dot(p, vec2( 0.92, 0.39)) *  1.7 + t * 1.35) * (0.0550 *  1.7) * vec2( 0.92, 0.39);
  g += cos(dot(p, vec2(-0.44, 0.90)) *  2.6 + t * 1.75) * (0.0340 *  2.6) * vec2(-0.44, 0.90);
  g += cos(dot(p, vec2( 0.70,-0.71)) *  4.3 + t * 2.35) * (0.0190 *  4.3) * vec2( 0.70,-0.71);
  g += cos(dot(p, vec2(-0.98,-0.20)) *  7.1 + t * 3.10) * (0.0110 *  7.1) * vec2(-0.98,-0.20);
  g += cos(dot(p, vec2( 0.20, 0.98)) * 11.0 + t * 4.10) * (0.0055 * 11.0) * vec2( 0.20, 0.98);
  g += cos(dot(p, vec2( 0.62, 0.78)) * 17.0 + t * 5.20) * (0.0030 * 17.0) * vec2( 0.62, 0.78);
  return g;
}

// капиллярная рябь: у шума аналитической производной нет, берём разностями
float capH(vec2 p, float t){
  return (vnoise(p *  6.0 + vec2(t * 0.35, -t * 0.28)) - 0.5) * 0.018
       + (vnoise(p * 14.0 - vec2(t * 0.60,  t * 0.44)) - 0.5) * 0.008;
}

vec3 waveNormal(vec2 p, float t, float strength, float detail){
  vec2 g = waveGrad(p, t);
  // вдали рябь всё равно погашена множителем detail — не тратим на неё шум
  if (detail > 0.02) {
    const float e = 0.030;
    float h0 = capH(p, t);
    g += vec2(capH(p + vec2(e, 0.0), t) - h0, capH(p + vec2(0.0, e), t) - h0) / e * detail;
  }
  return normalize(vec3(-g.x * strength, 1.0, -g.y * strength));
}

/**
 * Спроецировать мировую точку матрицей момента захвата.
 * Возвращает экранные uv и глубину в пространстве той же камеры (clip.w = -z_view),
 * чтобы и выборка, и сравнение глубин шли в одной системе отсчёта.
 */
vec3 projUVW(mat4 vp, vec3 wpos){
  vec4 c = vp * vec4(wpos, 1.0);
  return vec3(c.xy / c.w * 0.5 + 0.5, c.w);
}

vec3 sampleSky(vec3 d){
  vec2 uv = vec2(atan(d.x, d.z) / (2.0 * PI) + 0.5, acos(clamp(d.y, -1.0, 1.0)) / PI);
  return texture2D(tSky, uv).rgb;
}

float ggx(float NdH, float rough){
  float a = rough * rough;
  float a2 = a * a;
  float d = NdH * NdH * (a2 - 1.0) + 1.0;
  return a2 / (PI * d * d);
}

void main(){
  vec3 V = normalize(cameraPosition - vWPos);
  // Буферы сняты своими камерами и, возможно, кадром раньше. Проецируем точку
  // матрицами момента съёмки — иначе при повороте головы отражение и
  // преломление ползут относительно геометрии.
  vec3 pr = projUVW(uRefrVP, vWPos);
  vec2 suv = pr.xy;
  float viewZ = pr.z;

  // LOD: чем крупнее пиксель в метрах, тем слабее рябь и тем шире блик.
  // Без этого вдали рябь превращается в белый шум из бликов.
  float px = max(fwidth(vWPos.x), fwidth(vWPos.z));
  float detail = 1.0 - smoothstep(0.015, 0.30, px);
  vec3 N = waveNormal(vWPos.xz, uTime, uRipple * (0.18 + 0.82 * detail), detail);
  float specRough = mix(0.30, 0.055, detail);

  // ------------------------------------------------------------------
  // Взгляд снизу: полное внутреннее отражение + окно Снелла
  // ------------------------------------------------------------------
  if (uUnderwater > 0.5) {
    vec3 I = -V;                                   // луч идёт вверх, к поверхности
    vec3 R = refract(I, N, 1.0 / 1.333);
    float caus = texture2D(tCaustic, vWPos.xz / uCausticScale + vec2(uTime * 0.01, 0.0)).r;
    vec3 col;
    if (dot(R, R) > 0.0001) {
      // окно Снелла — размытый круг неба над головой
      col = sampleSky(R) * 0.9 + uSunColor * pow(max(dot(R, uSunDir), 0.0), 220.0) * 8.0;
    } else {
      // полное внутреннее отражение — вода снизу похожа на тёмное зеркало
      col = uDeep * 1.6 + uShallow * 0.10;
    }
    col += uShallow * caus * 0.25;
    float edge = pow(1.0 - abs(dot(V, N)), 3.0);
    col = mix(col, uShallow * 0.6, edge * 0.5);
    gl_FragColor = vec4(col, 1.0);
    return;
  }

  // ------------------------------------------------------------------
  // Взгляд сверху
  // ------------------------------------------------------------------
  float NdV = clamp(dot(N, V), 0.0, 1.0);
  float F = 0.02 + 0.98 * pow(1.0 - NdV, 5.0);

  // --- преломление с учётом глубины ---
  vec2 offs = N.xz * uDistort;
  float rawZ0 = texture2D(tDepth, suv).x;
  float sceneZ0 = linearizeDepth(rawZ0, uNear, uFar);
  float d0 = max(sceneZ0 - viewZ, 0.0);

  vec2 ruv = suv + offs * clamp(d0 * 0.55, 0.0, 1.2);
  ruv = clamp(ruv, vec2(0.0015), vec2(0.9985));
  float sceneZ = linearizeDepth(texture2D(tDepth, ruv).x, uNear, uFar);
  if (sceneZ < viewZ) { ruv = suv; sceneZ = sceneZ0; }   // не «затягивать» передний план
  float depth = max(sceneZ - viewZ, 0.0);

  vec3 refr = texture2D(tRefract, ruv).rgb;

  // --- закон Бугера-Ламберта-Бера + однократное рассеяние ---
  vec3 ext = uExtinction * (1.0 + uTurbidity * 1.6);
  vec3 trans = exp(-depth * ext);
  vec3 inscatter = mix(uShallow, uDeep, clamp(depth / 6.0, 0.0, 1.0));
  inscatter *= (uSunColor * 0.55 + uAmbient * 0.85);
  vec3 body = refr * trans + inscatter * (1.0 - trans) * (0.55 + uTurbidity * 0.9);

  // --- отражение ---
  vec3 refl;
  if (uHasReflection > 0.5) {
    vec2 rf = projUVW(uReflVP, vWPos).xy + offs * 0.55;
    rf = clamp(rf, vec2(0.002), vec2(0.998));
    refl = texture2D(tReflect, rf).rgb;
  } else {
    refl = sampleSky(reflect(-V, N));
  }

  vec3 col = mix(body, refl, F * uReflectivity);

  // --- солнечный блик ---
  vec3 H = normalize(uSunDir + V);
  float NdH = clamp(dot(N, H), 0.0, 1.0);
  vec3 spec = uSunColor * ggx(NdH, specRough) * F * 1.4;
  spec = min(spec, vec3(70.0));
  col += spec;

  // --- пена и урез воды ---
  // fbm3 — это три октавы шума, а пена живёт только у самого берега.
  // На основной глади shore уже ноль, поэтому туда шум не гоняем.
  float shore = 1.0 - smoothstep(0.0, 0.45, depth);
  if (shore > 0.001 && uFoam > 0.001) {
    float fn = fbm3(vWPos.xz * 3.4 + vec2(uTime * 0.11, -uTime * 0.08)) * detail;
    float foam = smoothstep(0.45, 0.95, shore * 0.9 + fn * 0.40) * uFoam;
    col = mix(col, uFoamColor * (uSunColor * 0.5 + uAmbient), clamp(foam, 0.0, 1.0));
  }

  // --- мерцание каустик, «просвечивающее» сквозь тонкий слой ---
  float thin = 1.0 - smoothstep(0.0, 1.4, depth);
  float caus = texture2D(tCaustic, vWPos.xz / uCausticScale).r;
  col += uShallow * caus * thin * 0.20 * detail;

  gl_FragColor = vec4(col, 1.0);
}`;

export class Water {
  /**
   * @param {THREE.BufferGeometry} geometry - плоскость на уровне waterY (мировые координаты)
   */
  constructor(geometry, opts = {}) {
    this.waterY = opts.waterY ?? 0;
    this.quality = opts.quality;

    const size = opts.size || new THREE.Vector2(1024, 1024);
    const reflW = Math.max(64, Math.floor(size.x * this.quality.reflectionScale));
    const reflH = Math.max(64, Math.floor(size.y * this.quality.reflectionScale));
    const refrW = Math.max(64, Math.floor(size.x * this.quality.refractionScale));
    const refrH = Math.max(64, Math.floor(size.y * this.quality.refractionScale));

    const rtOpts = { type: opts.hdrType || THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false };
    this.reflectRT = new THREE.WebGLRenderTarget(reflW, reflH, rtOpts);

    const depthTex = new THREE.DepthTexture(refrW, refrH);
    depthTex.type = THREE.UnsignedIntType;
    depthTex.minFilter = THREE.NearestFilter;
    depthTex.magFilter = THREE.NearestFilter;
    this.refractRT = new THREE.WebGLRenderTarget(refrW, refrH, { ...rtOpts, depthTexture: depthTex });

    this.uniforms = {
      tReflect: { value: this.reflectRT.texture },
      tRefract: { value: this.refractRT.texture },
      tDepth: { value: depthTex },
      tCaustic: { value: null },
      tSky: { value: null },
      uTime: { value: 0 },
      uNear: { value: 0.1 },
      uFar: { value: 300 },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color(1, 1, 1) },
      uAmbient: { value: new THREE.Color(0.3, 0.4, 0.45) },
      uReflVP: { value: new THREE.Matrix4() },
      uRefrVP: { value: new THREE.Matrix4() },
      uShallow: { value: new THREE.Color(0.55, 0.93, 0.88) },
      uDeep: { value: new THREE.Color(0.015, 0.16, 0.20) },
      uExtinction: { value: new THREE.Vector3(0.42, 0.10, 0.13) },
      uFoamColor: { value: new THREE.Color(0.96, 0.99, 1.0) },
      uTurbidity: { value: 0.35 },
      uFoam: { value: 1.0 },
      uDistort: { value: 0.055 },
      uReflectivity: { value: 1.0 },
      uUnderwater: { value: 0 },
      uHasReflection: { value: 1 },
      uCausticScale: { value: 7.0 },
      uWaveAmp: { value: 1.0 },
      uRipple: { value: 1.0 }
    };

    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: THREE.DoubleSide,
      transparent: false,
      depthWrite: true,
      fog: false
    });

    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.name = 'water-surface';
    this.mesh.renderOrder = 1;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.updateMatrix();
    // геометрия уже в мировых координатах — обычное отсечение работает,
    // запас в сфере покрывает вертикальное смещение волн
    this.mesh.frustumCulled = true;
    if (geometry.boundingSphere) geometry.boundingSphere.radius += 0.3;

    // вспомогательное для планарного отражения
    this.virtualCam = new THREE.PerspectiveCamera();
    this._normal = new THREE.Vector3(0, 1, 0);
    this._planePos = new THREE.Vector3(0, this.waterY, 0);
    this._view = new THREE.Vector3();
    this._target = new THREE.Vector3();
    this._lookAt = new THREE.Vector3();
    this._camPos = new THREE.Vector3();
    this._rot = new THREE.Matrix4();
    this.clipAbove = new THREE.Plane(new THREE.Vector3(0, 1, 0), -this.waterY + 0.015);
    this.clipBelow = new THREE.Plane(new THREE.Vector3(0, -1, 0), this.waterY + 0.030);

    this._frustum = new THREE.Frustum();
    this._projScreen = new THREE.Matrix4();
    this._box = new THREE.Box3();
    this._reflectValid = false;
    this.reflectInterval = opts.reflectInterval ?? 1;   // 2 = отражение через кадр
    this.refractInterval = opts.refractInterval ?? 1;  // 2 = преломление через кадр
    this._refractValid = false;
    this.idleRefresh = IDLE_REFRESH;

    // состояние захватов: у отражения и преломления свои якоря и свои часы
    const slot = () => ({ pos: new THREE.Vector3(1e9, 1e9, 1e9), quat: new THREE.Quaternion(), frame: -1e9 });
    this._refl = slot();
    this._refr = slot();
    this._d = { dist: 0, ang: 0 };
    this.skipped = false;

    this.enabled = true;
  }

  setWaterY(y) {
    this.waterY = y;
    this._planePos.set(0, y, 0);
    this.clipAbove.constant = -y + 0.015;
    this.clipBelow.constant = y + 0.030;
  }

  applyPreset(w, ambient) {
    this.uniforms.uShallow.value.setRGB(w.shallow[0], w.shallow[1], w.shallow[2]);
    this.uniforms.uDeep.value.setRGB(w.deep[0], w.deep[1], w.deep[2]);
    this.uniforms.uExtinction.value.set(w.extinction[0], w.extinction[1], w.extinction[2]);
    this.uniforms.uTurbidity.value = w.turbidity;
    this.uniforms.uFoam.value = w.foam;
    if (ambient) this.uniforms.uAmbient.value.copy(ambient);
  }

  _updateVirtualCamera(camera) {
    this._camPos.setFromMatrixPosition(camera.matrixWorld);

    this._view.subVectors(this._planePos, this._camPos);
    this._view.reflect(this._normal).negate().add(this._planePos);

    this._rot.extractRotation(camera.matrixWorld);
    this._lookAt.set(0, 0, -1).applyMatrix4(this._rot).add(this._camPos);

    this._target.subVectors(this._planePos, this._lookAt);
    this._target.reflect(this._normal).negate().add(this._planePos);

    const vc = this.virtualCam;
    vc.position.copy(this._view);
    vc.up.set(0, 1, 0).applyMatrix4(this._rot).reflect(this._normal);
    vc.lookAt(this._target);
    vc.near = camera.near;
    vc.far = camera.far;
    vc.fov = camera.fov;
    vc.aspect = camera.aspect;
    vc.updateMatrixWorld();
    vc.projectionMatrix.copy(camera.projectionMatrix);
  }

  /** Попадает ли поверхность воды в пирамиду видимости. */
  isVisible(camera) {
    const box = this.mesh.geometry.boundingBox;
    if (!box) return true;
    this._projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this._frustum.setFromProjectionMatrix(this._projScreen);
    // запас по вертикали под смещение волн
    this._box.copy(box);
    this._box.min.y -= 0.2; this._box.max.y += 0.2;
    return this._frustum.intersectsBox(this._box);
  }

  /**
   * Рендер RT отражения/преломления. Вызывать до основного прохода.
   * Самая дорогая часть кадра — сцена рисуется ещё дважды, поэтому здесь три отсечки:
   *  1) воды нет в кадре — пропускаем оба прохода целиком;
   *  2) камера под водой — шейдер использует только небо и каустики, RT не нужны;
   *  3) отражение обновляется через кадр (искажение волнами скрывает задержку).
   */
  /**
   * Пора ли обновлять захват: камера заметно сместилась, либо буфер провисел
   * дольше idleRefresh кадров (в сцене что-то шевелится само).
   */
  _staleness(slot, camera, frame) {
    this._d.dist = camera.position.distanceTo(slot.pos);
    this._d.ang = camera.quaternion.angleTo(slot.quat);
    return this._d.dist >= MOVE_EPS || this._d.ang >= ROT_EPS
        || (frame - slot.frame) >= this.idleRefresh;
  }

  _mark(slot, camera, frame) {
    slot.pos.copy(camera.position);
    slot.quat.copy(camera.quaternion);
    slot.frame = frame;
  }

  update(renderer, scene, camera, frame = 0) {
    this.skipped = true;
    if (!this.enabled || !this.mesh.visible) return;

    const underwater = camera.position.y < this.waterY;
    this.uniforms.uUnderwater.value = underwater ? 1 : 0;
    this.uniforms.uNear.value = camera.near;
    this.uniforms.uFar.value = camera.far;

    if (underwater) { this.uniforms.uHasReflection.value = 0; return; }
    if (!this.isVisible(camera)) return;

    const canReflect = this.quality.reflectionScale > 0;
    this.uniforms.uHasReflection.value = canReflect ? 1 : 0;

    // Каждый захват живёт по своим часам и со своим якорем. Общий якорь был
    // ошибкой: он обновлялся и в тех кадрах, где съёмка не делалась, — после
    // остановки камеры буфер оставался снятым из старой точки и уезжал.
    const rInt = Math.max(1, this.reflectInterval | 0);
    const fInt = Math.max(1, this.refractInterval | 0);
    const rStale = this._staleness(this._refl, camera, frame);
    const fStale = this._staleness(this._refr, camera, frame);
    let doReflect = canReflect && rStale && (frame - this._refl.frame) >= rInt;
    let doRefract = fStale && (frame - this._refr.frame) >= fInt;

    // Оба назрели — снимаем тот, что ждёт дольше; второй подождёт кадр.
    // Так два полных прохода сцены не попадают в один и тот же кадр.
    if (doReflect && doRefract && rInt > 1 && fInt > 1) {
      if ((frame - this._refl.frame) >= (frame - this._refr.frame)) doRefract = false;
      else doReflect = false;
    }
    if (!doReflect && !doRefract) return;

    this.skipped = false;
    const wasVisible = this.mesh.visible;
    this.mesh.visible = false;

    const prevRT = renderer.getRenderTarget();
    const prevClip = renderer.clippingPlanes;
    const prevShadowAuto = renderer.shadowMap.autoUpdate;
    const prevShadowNeeds = renderer.shadowMap.needsUpdate;
    renderer.shadowMap.autoUpdate = false;
    renderer.shadowMap.needsUpdate = false;

    if (doReflect) {
      this._updateVirtualCamera(camera);
      renderer.clippingPlanes = [this.clipAbove];
      renderer.setRenderTarget(this.reflectRT);
      renderer.clear(true, true, false);
      renderer.render(scene, this.virtualCam);
      this._reflectValid = true;
      this._mark(this._refl, camera, frame);
      // матрица момента съёмки — по ней шейдер и будет выбирать из буфера
      this.uniforms.uReflVP.value.multiplyMatrices(
        this.virtualCam.projectionMatrix, this.virtualCam.matrixWorldInverse);
    }

    if (doRefract) {
      renderer.clippingPlanes = [this.clipBelow];
      renderer.setRenderTarget(this.refractRT);
      renderer.clear(true, true, false);
      renderer.render(scene, camera);
      this._refractValid = true;
      this._mark(this._refr, camera, frame);
      this.uniforms.uRefrVP.value.multiplyMatrices(
        camera.projectionMatrix, camera.matrixWorldInverse);
    }

    renderer.clippingPlanes = prevClip;
    renderer.setRenderTarget(prevRT);
    renderer.shadowMap.autoUpdate = prevShadowAuto;
    renderer.shadowMap.needsUpdate = prevShadowNeeds;
    this.mesh.visible = wasVisible;
  }

  setSize(w, h) {
    const q = this.quality;
    this.reflectRT.setSize(Math.max(64, Math.floor(w * q.reflectionScale)), Math.max(64, Math.floor(h * q.reflectionScale)));
    this.refractRT.setSize(Math.max(64, Math.floor(w * q.refractionScale)), Math.max(64, Math.floor(h * q.refractionScale)));
  }

  dispose() {
    this.reflectRT.dispose();
    this.refractRT.dispose();
    this.material.dispose();
    this.mesh.geometry.dispose();
  }
}
