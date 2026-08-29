import * as THREE from 'three';
import { GLSL_HASH, GLSL_NOISE, GLSL_COLOR, GLSL_DEPTH } from './shaderlib.js';

// ---------------------------------------------------------------- утилиты

class FullScreenQuad {
  constructor(material) {
    this._cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._geo = new THREE.BufferGeometry();
    this._geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, 3, 0, -1, -1, 0, 3, -1, 0], 3));
    this._geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 2, 0, 0, 2, 0], 2));
    this._mesh = new THREE.Mesh(this._geo, material);
    this._mesh.frustumCulled = false;
    this._scene = new THREE.Scene();
    this._scene.add(this._mesh);
  }
  set material(m) { this._mesh.material = m; }
  get material() { return this._mesh.material; }
  render(renderer) { renderer.render(this._scene, this._cam); }
  dispose() { this._geo.dispose(); }
}

const VERT = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

let HDR_TYPE = THREE.HalfFloatType;      // переопределяется движком при старте

function makeRT(w, h, opts = {}) {
  return new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {
    type: HDR_TYPE,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    generateMipmaps: false,
    ...opts
  });
}

// ---------------------------------------------------------------- шейдеры

const VOLUMETRIC_FRAG = (STEPS) => /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tDiffuse;
uniform sampler2D tDepth;
uniform sampler2D tShadow;
uniform mat4 uInvViewProj;
uniform mat4 uShadowMatrix;
uniform vec3 uCamPos;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uTint;
uniform float uNear, uFar;
uniform float uIntensity;
uniform float uDensity;
uniform float uFogBase;
uniform float uFogFalloff;
uniform float uMaxDist;
uniform float uTime;
uniform float uFrame;
uniform float uHasShadow;
uniform float uWaterY;
uniform float uUnderwater;

${GLSL_HASH}
${GLSL_NOISE}
${GLSL_DEPTH}
#include <packing>

vec3 worldFromDepth(vec2 uv, float rawD){
  vec4 ndc = vec4(uv * 2.0 - 1.0, rawD * 2.0 - 1.0, 1.0);
  vec4 p = uInvViewProj * ndc;
  return p.xyz / p.w;
}

float hg(float cosT, float g){
  float g2 = g * g;
  return (1.0 - g2) / (12.566370614 * pow(1.0 + g2 - 2.0 * g * cosT, 1.5));
}

// Считает ТОЛЬКО рассеянный свет; смешивание с кадром — отдельным дешёвым проходом,
// поэтому этот тяжёлый рейтрейсинг можно гнать в половинном разрешении.
void main(){
  float rawD = texture2D(tDepth, vUv).x;
  vec3 world = worldFromDepth(vUv, rawD);

  vec3 ro = uCamPos;
  vec3 rd = world - ro;
  float len = length(rd);
  if (len < 1e-4) { gl_FragColor = vec4(0.0); return; }
  rd /= len;
  len = min(len, uMaxDist);

  float stepLen = len / float(${STEPS});
  float jitter = hash12(gl_FragCoord.xy + vec2(uFrame * 1.618, uFrame * 0.7));
  float t = jitter * stepLen;

  float accum = 0.0;
  for (int i = 0; i < ${STEPS}; i++){
    vec3 p = ro + rd * t;

    float lit = 1.0;
    if (uHasShadow > 0.5){
      vec4 sc = uShadowMatrix * vec4(p, 1.0);
      vec3 sp = sc.xyz / sc.w;
      if (sp.x > 0.0 && sp.x < 1.0 && sp.y > 0.0 && sp.y < 1.0 && sp.z > 0.0 && sp.z < 1.0){
        float d = unpackRGBAToDepth(texture2D(tShadow, sp.xy));
        lit = step(sp.z - 0.0012, d);
      }
    }

    // плотность: гуще у пола и над водой, плюс медленный шум
    float above = p.y - uFogBase;
    float dens = exp(-max(above, 0.0) * uFogFalloff);
    dens *= 0.65 + 0.7 * vnoise(p.xz * 0.11 + vec2(uTime * 0.02, -uTime * 0.015));
    dens *= 0.85 + 0.3 * vnoise(vec2(p.y * 0.6, p.x * 0.2 + uTime * 0.03));
    // испарения над самой водой
    dens *= 1.0 + 0.9 * exp(-abs(p.y - uWaterY) * 1.8);

    accum += lit * dens * stepLen;
    t += stepLen;
  }

  // нормируем на длину луча: получаем среднюю освещённую плотность 0..~2
  float avg = accum / max(len, 0.001);
  float phase = hg(dot(rd, -uSunDir), 0.72);
  // лучи заметны только вблизи направления на солнце, слабый общий подсвет
  vec3 shafts = avg * uDensity * (phase * 26.0 + 0.55) * uSunColor * uTint * uIntensity;
  // затухание вклада с расстоянием, чтобы дальний план не выцветал
  shafts *= smoothstep(0.0, 6.0, len);

  gl_FragColor = vec4(shafts, 1.0);
}`;

const ADD_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tDiffuse;
uniform sampler2D tAdd;
void main(){
  gl_FragColor = vec4(texture2D(tDiffuse, vUv).rgb + texture2D(tAdd, vUv).rgb, 1.0);
}`;

const UNDERWATER_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tDiffuse;
uniform sampler2D tDepth;
uniform sampler2D tCaustic;
uniform float uNear, uFar, uTime, uAmount;
uniform vec3 uExtinction;
uniform vec3 uWaterColor;
uniform vec2 uResolution;
${GLSL_HASH}
${GLSL_NOISE}
${GLSL_DEPTH}

void main(){
  vec2 uv = vUv;
  // колебание толщи воды
  float w1 = sin(uv.y * 26.0 + uTime * 1.7) * 0.0016;
  float w2 = cos(uv.x * 21.0 - uTime * 1.35) * 0.0016;
  vec2 wob = vec2(w1, w2) * uAmount;

  // хроматическая дисперсия в воде
  vec3 col;
  col.r = texture2D(tDiffuse, uv + wob * 1.25).r;
  col.g = texture2D(tDiffuse, uv + wob).g;
  col.b = texture2D(tDiffuse, uv + wob * 0.75).b;

  float d = linearizeDepth(texture2D(tDepth, uv).x, uNear, uFar);
  d = min(d, 60.0);
  vec3 trans = exp(-d * uExtinction * 0.55);
  col = col * trans + uWaterColor * (1.0 - trans);

  // взвесь: медленно плывущие частицы
  vec2 pp = uv * uResolution / 220.0;
  float par = 0.0;
  for (int i = 0; i < 3; i++){
    float fi = float(i);
    vec2 q = pp * (1.0 + fi * 0.7) + vec2(uTime * (0.02 + fi * 0.01), -uTime * (0.035 + fi * 0.012));
    float n = vnoise(q * 9.0);
    par += smoothstep(0.93, 1.0, n) * (0.5 - fi * 0.13);
  }
  col += vec3(0.55, 0.85, 0.9) * par * 0.20;

  // мерцание каустик в объёме
  float c = texture2D(tCaustic, uv * 2.2 + vec2(uTime * 0.012, uTime * 0.008)).r;
  col += uWaterColor * c * 0.06 * smoothstep(4.0, 25.0, d);

  // виньетирование маски
  float r = distance(uv, vec2(0.5));
  col *= 1.0 - smoothstep(0.35, 0.95, r) * 0.45;

  gl_FragColor = vec4(col, 1.0);
}`;

const BRIGHT_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tDiffuse;
uniform float uThreshold;
uniform float uSoftKnee;
${GLSL_COLOR}
void main(){
  vec3 c = texture2D(tDiffuse, vUv).rgb;
  float l = luma(c);
  float knee = uThreshold * uSoftKnee + 1e-5;
  float soft = clamp(l - uThreshold + knee, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee);
  float w = max(soft, l - uThreshold) / max(l, 1e-5);
  gl_FragColor = vec4(c * w, 1.0);
}`;

const DOWN_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tDiffuse;
uniform vec2 uTexel;
void main(){
  vec4 s = texture2D(tDiffuse, vUv) * 4.0;
  s += texture2D(tDiffuse, vUv + vec2(-uTexel.x, -uTexel.y));
  s += texture2D(tDiffuse, vUv + vec2( uTexel.x, -uTexel.y));
  s += texture2D(tDiffuse, vUv + vec2(-uTexel.x,  uTexel.y));
  s += texture2D(tDiffuse, vUv + vec2( uTexel.x,  uTexel.y));
  s += texture2D(tDiffuse, vUv + vec2(-uTexel.x * 2.0, 0.0)) * 2.0;
  s += texture2D(tDiffuse, vUv + vec2( uTexel.x * 2.0, 0.0)) * 2.0;
  s += texture2D(tDiffuse, vUv + vec2(0.0, -uTexel.y * 2.0)) * 2.0;
  s += texture2D(tDiffuse, vUv + vec2(0.0,  uTexel.y * 2.0)) * 2.0;
  gl_FragColor = s / 16.0;
}`;

const UP_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tDiffuse;
uniform sampler2D tPrev;
uniform vec2 uTexel;
uniform float uRadius;
void main(){
  vec2 t = uTexel * uRadius;
  vec4 s = texture2D(tDiffuse, vUv + vec2(-t.x,  t.y));
  s += texture2D(tDiffuse, vUv + vec2( 0.0,  t.y)) * 2.0;
  s += texture2D(tDiffuse, vUv + vec2( t.x,  t.y));
  s += texture2D(tDiffuse, vUv + vec2(-t.x,  0.0)) * 2.0;
  s += texture2D(tDiffuse, vUv) * 4.0;
  s += texture2D(tDiffuse, vUv + vec2( t.x,  0.0)) * 2.0;
  s += texture2D(tDiffuse, vUv + vec2(-t.x, -t.y));
  s += texture2D(tDiffuse, vUv + vec2( 0.0, -t.y)) * 2.0;
  s += texture2D(tDiffuse, vUv + vec2( t.x, -t.y));
  gl_FragColor = s / 16.0 + texture2D(tPrev, vUv);
}`;

const FINAL_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tDiffuse;
uniform sampler2D tBloom;
uniform float uExposure;
uniform float uBloom;
uniform float uVignette;
uniform float uGrain;
uniform float uChroma;
uniform float uTime;
uniform float uContrast;
uniform float uSaturation;
uniform vec3 uLift;
uniform vec3 uGain;
uniform float uFade;
${GLSL_HASH}
${GLSL_COLOR}

void main(){
  vec2 uv = vUv;
  vec2 d = uv - 0.5;
  float r2 = dot(d, d);

  // радиальная хроматическая аберрация
  vec2 off = d * r2 * uChroma * 12.0;
  vec3 col;
  col.r = texture2D(tDiffuse, uv + off).r;
  col.g = texture2D(tDiffuse, uv).g;
  col.b = texture2D(tDiffuse, uv - off).b;

  col += texture2D(tBloom, uv).rgb * uBloom;

  col *= uExposure;
  col = acesFilm(col);

  // грейдинг: lift / gain / контраст / насыщенность
  col = col * uGain + uLift;
  col = (col - 0.5) * uContrast + 0.5;
  float l = luma(col);
  col = mix(vec3(l), col, uSaturation);

  // виньетка
  float vig = 1.0 - smoothstep(0.22, 0.85, r2 * 1.9) * uVignette;
  col *= vig;

  // зерно
  float g = hash12(gl_FragCoord.xy + vec2(uTime * 137.13, uTime * 71.7)) - 0.5;
  col += g * uGrain * (1.0 - l * 0.55);

  col = max(col, 0.0);
  col *= uFade;

  // sRGB + дизеринг против бандинга
  col = pow(col, vec3(1.0 / 2.2));
  col += (hash12(gl_FragCoord.xy * 1.37) - 0.5) / 255.0;

  gl_FragColor = vec4(col, 1.0);
}`;

const FXAA_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tDiffuse;
uniform vec2 uTexel;
${GLSL_COLOR}
void main(){
  vec3 rgbNW = texture2D(tDiffuse, vUv + vec2(-1.0, -1.0) * uTexel).rgb;
  vec3 rgbNE = texture2D(tDiffuse, vUv + vec2( 1.0, -1.0) * uTexel).rgb;
  vec3 rgbSW = texture2D(tDiffuse, vUv + vec2(-1.0,  1.0) * uTexel).rgb;
  vec3 rgbSE = texture2D(tDiffuse, vUv + vec2( 1.0,  1.0) * uTexel).rgb;
  vec3 rgbM  = texture2D(tDiffuse, vUv).rgb;

  float lNW = luma(rgbNW), lNE = luma(rgbNE), lSW = luma(rgbSW), lSE = luma(rgbSE), lM = luma(rgbM);
  float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
  float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));

  vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), ((lNW + lSW) - (lNE + lSE)));
  float reduce = max((lNW + lNE + lSW + lSE) * 0.03125, 0.0078125);
  float rcpDir = 1.0 / (min(abs(dir.x), abs(dir.y)) + reduce);
  dir = clamp(dir * rcpDir, -8.0, 8.0) * uTexel;

  vec3 rgbA = 0.5 * (texture2D(tDiffuse, vUv + dir * (1.0/3.0 - 0.5)).rgb +
                     texture2D(tDiffuse, vUv + dir * (2.0/3.0 - 0.5)).rgb);
  vec3 rgbB = rgbA * 0.5 + 0.25 * (texture2D(tDiffuse, vUv - dir * 0.5).rgb +
                                   texture2D(tDiffuse, vUv + dir * 0.5).rgb);
  float lB = luma(rgbB);
  gl_FragColor = vec4((lB < lMin || lB > lMax) ? rgbA : rgbB, 1.0);
}`;

// ---------------------------------------------------------------- пайплайн

export class PostPipeline {
  constructor(renderer, quality, hdrType = THREE.HalfFloatType) {
    HDR_TYPE = hdrType;
    this.renderer = renderer;
    this.quality = quality;
    this.frame = 0;
    this.width = 1; this.height = 1;

    const depthTex = new THREE.DepthTexture(1, 1);
    depthTex.type = THREE.UnsignedIntType;
    depthTex.minFilter = THREE.NearestFilter;
    depthTex.magFilter = THREE.NearestFilter;
    this.depthTexture = depthTex;

    this.sceneRT = new THREE.WebGLRenderTarget(1, 1, {
      type: hdrType,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      depthTexture: depthTex, depthBuffer: true, generateMipmaps: false
    });

    this.rtA = makeRT(1, 1);
    this.rtB = makeRT(1, 1);

    this.mipCount = quality.bloomMips;
    this.mipsDown = [];
    this.mipsUp = [];
    for (let i = 0; i < this.mipCount; i++) { this.mipsDown.push(makeRT(1, 1)); this.mipsUp.push(makeRT(1, 1)); }
    this.brightRT = makeRT(1, 1);

    this.quad = new FullScreenQuad(null);

    this.volMat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: VOLUMETRIC_FRAG(Math.max(4, quality.volumetricSteps || 24)),
      uniforms: {
        tDiffuse: { value: null }, tDepth: { value: depthTex }, tShadow: { value: null },
        uInvViewProj: { value: new THREE.Matrix4() }, uShadowMatrix: { value: new THREE.Matrix4() },
        uCamPos: { value: new THREE.Vector3() }, uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uSunColor: { value: new THREE.Color(1, 1, 1) }, uTint: { value: new THREE.Color(1, 1, 1) },
        uNear: { value: 0.1 }, uFar: { value: 300 },
        uIntensity: { value: 0.6 }, uDensity: { value: 0.020 },
        uFogBase: { value: 0 }, uFogFalloff: { value: 0.12 },
        uMaxDist: { value: 65 }, uTime: { value: 0 }, uFrame: { value: 0 },
        uHasShadow: { value: 0 }, uWaterY: { value: -999 }, uUnderwater: { value: 0 }
      },
      depthTest: false, depthWrite: false
    });

    // объёмный свет считается в пониженном разрешении и добавляется отдельно
    this.volScale = quality.volumetricScale ?? 0.5;
    this.volRT = makeRT(1, 1);
    this.addMat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: ADD_FRAG,
      uniforms: { tDiffuse: { value: null }, tAdd: { value: null } },
      depthTest: false, depthWrite: false
    });

    this.underMat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: UNDERWATER_FRAG,
      uniforms: {
        tDiffuse: { value: null }, tDepth: { value: depthTex }, tCaustic: { value: null },
        uNear: { value: 0.1 }, uFar: { value: 300 }, uTime: { value: 0 }, uAmount: { value: 1 },
        uExtinction: { value: new THREE.Vector3(0.42, 0.10, 0.13) },
        uWaterColor: { value: new THREE.Color(0.06, 0.34, 0.36) },
        uResolution: { value: new THREE.Vector2(1, 1) }
      },
      depthTest: false, depthWrite: false
    });

    this.brightMat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: BRIGHT_FRAG,
      uniforms: { tDiffuse: { value: null }, uThreshold: { value: 1.0 }, uSoftKnee: { value: 0.6 } },
      depthTest: false, depthWrite: false
    });
    this.downMat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: DOWN_FRAG,
      uniforms: { tDiffuse: { value: null }, uTexel: { value: new THREE.Vector2() } },
      depthTest: false, depthWrite: false
    });
    this.upMat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: UP_FRAG,
      uniforms: { tDiffuse: { value: null }, tPrev: { value: null }, uTexel: { value: new THREE.Vector2() }, uRadius: { value: 1.0 } },
      depthTest: false, depthWrite: false
    });

    this.finalMat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FINAL_FRAG,
      uniforms: {
        tDiffuse: { value: null }, tBloom: { value: null },
        uExposure: { value: 1.0 }, uBloom: { value: 0.5 }, uVignette: { value: 0.35 },
        uGrain: { value: 0.025 }, uChroma: { value: 0.0018 }, uTime: { value: 0 },
        uContrast: { value: 1.04 }, uSaturation: { value: 1.02 },
        uLift: { value: new THREE.Vector3() }, uGain: { value: new THREE.Vector3(1, 1, 1) },
        uFade: { value: 1 }
      },
      depthTest: false, depthWrite: false
    });

    this.fxaaMat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FXAA_FRAG,
      uniforms: { tDiffuse: { value: null }, uTexel: { value: new THREE.Vector2() } },
      depthTest: false, depthWrite: false
    });

    this.ldrRT = makeRT(1, 1, { type: THREE.UnsignedByteType });
  }

  setSize(w, h) {
    this.width = w; this.height = h;
    this.sceneRT.setSize(w, h);
    this.depthTexture.image.width = w;
    this.depthTexture.image.height = h;
    // rtA/rtB — промежуточные HDR-буферы: первый нужен только при объёмном свете,
    // второй вдобавок под водой. Полноэкранный half-float стоит 8 байт на пиксель,
    // в 1080p это 16 МБ каждый, поэтому размер им даём по факту обращения (_ensure).
    this.ldrRT.setSize(w, h);
    this.volRT.setSize(
      this.quality.volumetric ? Math.max(1, Math.round(w * this.volScale)) : 1,
      this.quality.volumetric ? Math.max(1, Math.round(h * this.volScale)) : 1);
    this.brightRT.setSize(Math.max(1, w >> 1), Math.max(1, h >> 1));
    for (let i = 0; i < this.mipCount; i++) {
      const s = 2 << i;
      this.mipsDown[i].setSize(Math.max(1, Math.floor(w / s)), Math.max(1, Math.floor(h / s)));
      this.mipsUp[i].setSize(Math.max(1, Math.floor(w / s)), Math.max(1, Math.floor(h / s)));
    }
    this.underMat.uniforms.uResolution.value.set(w, h);
    this.fxaaMat.uniforms.uTexel.value.set(1 / w, 1 / h);
  }

  /** Довести буфер до текущего размера кадра — вызывается прямо перед использованием. */
  _ensure(rt) {
    if (rt.width !== this.width || rt.height !== this.height) rt.setSize(this.width, this.height);
    return rt;
  }

  _blit(material, target) {
    this.quad.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.clear(true, false, false);
    this.quad.render(this.renderer);
  }

  _bloom(sourceTex, threshold) {
    const r = this.renderer;
    this.brightMat.uniforms.tDiffuse.value = sourceTex;
    this.brightMat.uniforms.uThreshold.value = threshold;
    this._blit(this.brightMat, this.brightRT);

    let src = this.brightRT;
    for (let i = 0; i < this.mipCount; i++) {
      this.downMat.uniforms.tDiffuse.value = src.texture;
      this.downMat.uniforms.uTexel.value.set(1 / src.width, 1 / src.height);
      this._blit(this.downMat, this.mipsDown[i]);
      src = this.mipsDown[i];
    }

    // апсемплинг снизу вверх с накоплением
    let prev = null;
    for (let i = this.mipCount - 1; i >= 0; i--) {
      const cur = this.mipsDown[i];
      const dst = this.mipsUp[i];
      this.upMat.uniforms.tDiffuse.value = cur.texture;
      this.upMat.uniforms.tPrev.value = prev ? prev.texture : this._blackTex();
      this.upMat.uniforms.uTexel.value.set(1 / cur.width, 1 / cur.height);
      this.upMat.uniforms.uRadius.value = 1.0 + i * 0.35;
      this._blit(this.upMat, dst);
      prev = dst;
    }
    return prev ? prev.texture : null;
  }

  _blackTex() {
    if (!this._black) {
      this._black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
      this._black.needsUpdate = true;
    }
    return this._black;
  }

  /**
   * @param {object} ctx { scene, camera, sun, preset, time, underwater, causticTex, waterY, fadeOut }
   */
  render(ctx) {
    const r = this.renderer;
    const { scene, camera, time } = ctx;
    this.frame++;

    // 1) сцена -> HDR буфер с глубиной
    r.setRenderTarget(this.sceneRT);
    r.clear(true, true, true);
    r.render(scene, camera);

    let current = this.sceneRT;

    // 2) объёмный свет
    if (this.quality.volumetric && ctx.volumetricIntensity > 0.001) {
      const u = this.volMat.uniforms;
      u.tDiffuse.value = current.texture;
      u.uInvViewProj.value.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).invert();
      u.uCamPos.value.copy(camera.position);
      u.uSunDir.value.copy(ctx.sunDir);
      u.uSunColor.value.copy(ctx.sunColor);
      u.uTint.value.setRGB(ctx.volTint[0], ctx.volTint[1], ctx.volTint[2]);
      u.uNear.value = camera.near; u.uFar.value = camera.far;
      u.uIntensity.value = ctx.volumetricIntensity;
      u.uDensity.value = Math.min(ctx.fogDensity, 0.014) * 1.4;
      u.uFogBase.value = ctx.waterY;
      u.uTime.value = time;
      u.uFrame.value = this.frame % 64;
      u.uWaterY.value = ctx.waterY;
      u.uUnderwater.value = ctx.underwater ? 1 : 0;
      if (ctx.sun && ctx.sun.shadow && ctx.sun.shadow.map) {
        u.tShadow.value = ctx.sun.shadow.map.texture;
        u.uShadowMatrix.value.copy(ctx.sun.shadow.matrix);
        u.uHasShadow.value = 1;
      } else {
        u.uHasShadow.value = 0;
      }
      this._blit(this.volMat, this.volRT);
      this.addMat.uniforms.tDiffuse.value = current.texture;
      this.addMat.uniforms.tAdd.value = this.volRT.texture;
      this._blit(this.addMat, this._ensure(this.rtA));
      current = this.rtA;
    }

    // 3) подводный слой
    if (ctx.underwater) {
      const u = this.underMat.uniforms;
      u.tDiffuse.value = current.texture;
      u.tCaustic.value = ctx.causticTex;
      u.uNear.value = camera.near; u.uFar.value = camera.far;
      u.uTime.value = time;
      u.uAmount.value = 1;
      u.uExtinction.value.copy(ctx.waterExtinction);
      u.uWaterColor.value.copy(ctx.waterFogColor);
      const dst = this._ensure((current === this.rtA) ? this.rtB : this.rtA);
      this._blit(this.underMat, dst);
      current = dst;
    }

    // 4) bloom — при нулевой силе весь каскад (1 + 2×mipCount блитов) впустую
    const bloomTex = ctx.bloom > 0.001 ? this._bloom(current.texture, ctx.bloomThreshold) : null;

    // 5) финальный грейдинг
    const f = this.finalMat.uniforms;
    f.tDiffuse.value = current.texture;
    f.tBloom.value = bloomTex || this._blackTex();
    f.uExposure.value = ctx.exposure;
    f.uBloom.value = ctx.bloom;
    f.uVignette.value = ctx.vignette;
    f.uGrain.value = ctx.grain;
    f.uChroma.value = ctx.chroma + (ctx.underwater ? 0.0012 : 0);
    f.uTime.value = time;
    f.uContrast.value = ctx.contrast;
    f.uSaturation.value = ctx.saturation;
    f.uLift.value.set(ctx.lift[0], ctx.lift[1], ctx.lift[2]);
    f.uGain.value.set(ctx.gain[0], ctx.gain[1], ctx.gain[2]);
    f.uFade.value = ctx.fade ?? 1;

    if (this.quality.fxaa) {
      this._blit(this.finalMat, this.ldrRT);
      this.fxaaMat.uniforms.tDiffuse.value = this.ldrRT.texture;
      r.setRenderTarget(null);
      this.quad.material = this.fxaaMat;
      this.quad.render(r);
    } else {
      r.setRenderTarget(null);
      this.quad.material = this.finalMat;
      this.quad.render(r);
    }
  }

  dispose() {
    this.sceneRT.dispose(); this.rtA.dispose(); this.rtB.dispose(); this.ldrRT.dispose();
    this.brightRT.dispose(); this.volRT.dispose();
    for (const m of this.mipsDown) m.dispose();
    for (const m of this.mipsUp) m.dispose();
    this.quad.dispose();
  }
}
