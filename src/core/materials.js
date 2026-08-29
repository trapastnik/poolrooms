import * as THREE from 'three';
import { GLSL_HASH, GLSL_NOISE, GLSL_TILE } from './shaderlib.js';

const COMMON_PARS = /* glsl */ `
varying vec3 vWPos;
varying vec3 vWNrm;
varying float vAOv;
uniform sampler2D uCaustic;
uniform float uTime;
uniform float uWaterY;
uniform float uHasWater;
uniform vec3  uSunColor;
uniform float uCausticScale;
uniform float uCausticStrength;
uniform float uGrime;
`;

const VERT_PARS = /* glsl */ `
varying vec3 vWPos;
varying vec3 vWNrm;
varying float vAOv;
attribute float aAO;
`;

const VERT_BODY = /* glsl */ `
vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
vWNrm = normalize(mat3(modelMatrix) * objectNormal);
vAOv  = aAO;
`;

// Режим 1: развёртка берётся из атрибута (в метрах) — для цилиндров и арок,
// где мировая планарная проекция даёт искажения.
const UV_PARS_V = `attribute vec2 aTileUV;\nvarying vec2 vTileUV;\n`;
const UV_BODY_V = `vTileUV = aTileUV;\n`;
const UV_PARS_F = `varying vec2 vTileUV;\n`;

/** Каустики: подводные + отражённые «зайчики» на стенах над водой. */
const CAUSTIC_CODE = /* glsl */ `
vec3 sampleCaustics(vec3 wp, vec3 wn){
  if (uHasWater < 0.5 || uCausticStrength <= 0.0) return vec3(0.0);
  vec2 cuv = wp.xz / uCausticScale;
  float below = uWaterY - wp.y;

  // хроматическая дисперсия — каустики слегка разноцветные по краям
  float cr = texture2D(uCaustic, cuv + vec2( 0.0012, 0.0005)).r;
  float cg = texture2D(uCaustic, cuv).r;
  float cb = texture2D(uCaustic, cuv + vec2(-0.0012,-0.0005)).r;
  vec3 c = vec3(cr, cg, cb);

  float upFacing = clamp(dot(wn, vec3(0.0, 1.0, 0.0)), 0.0, 1.0);

  if (below > 0.0) {
    // под водой: свет фокусируется на дне, слабеет с глубиной
    float atten = exp(-below * 0.20);
    float face = mix(0.35, 1.0, upFacing);
    return c * atten * face * uCausticStrength * 0.75;
  } else {
    // над водой: блики, отражённые от поверхности, на стенах и потолке
    float above = -below;
    float atten = exp(-above * 0.42) * (1.0 - smoothstep(0.0, 6.0, above));
    vec2 wuv = wp.xz / (uCausticScale * 1.7) + vec2(uTime * 0.004, -uTime * 0.003);
    float w = texture2D(uCaustic, wuv, 1.5).r;
    float face = mix(1.0, 0.30, upFacing);       // потолок ловит больше, пол — меньше
    return vec3(w) * uSunColor * atten * face * uCausticStrength * 0.30;
  }
}
`;

function injectCommon(shader, uniforms, useTileUV = false) {
  Object.assign(shader.uniforms, uniforms);
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\n' + VERT_PARS + (useTileUV ? UV_PARS_V : ''))
    .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\n' + VERT_BODY + (useTileUV ? UV_BODY_V : ''));
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\n' + (useTileUV ? UV_PARS_F : '') + COMMON_PARS + GLSL_HASH + GLSL_NOISE + GLSL_TILE + CAUSTIC_CODE);
}

/** Гарантирует наличие атрибута aAO (1.0 = нет затенения). */
export function ensureAO(geometry) {
  if (!geometry.getAttribute('aAO')) {
    const n = geometry.getAttribute('position').count;
    const arr = new Float32Array(n).fill(1);
    geometry.setAttribute('aAO', new THREE.BufferAttribute(arr, 1));
  }
  return geometry;
}

export class MaterialLibrary {
  constructor() {
    this.shared = {
      uCaustic: { value: null },
      uTime: { value: 0 },
      uWaterY: { value: -999 },
      uHasWater: { value: 0 },
      uSunColor: { value: new THREE.Color(1, 1, 1) },
      uCausticScale: { value: 7.0 },
      uCausticStrength: { value: 1.6 },
      uGrime: { value: 1.0 }
    };
    this.materials = [];
  }

  setCaustics(tex) { this.shared.uCaustic.value = tex; }
  setWater(y, has) { this.shared.uWaterY.value = y; this.shared.uHasWater.value = has ? 1 : 0; }
  setTime(t) { this.shared.uTime.value = t; }
  setSunColor(c) { this.shared.uSunColor.value.copy(c); }
  setCausticStrength(v) { this.shared.uCausticStrength.value = v; }
  /** Профиль качества влияет на clearcoat и наличие процедурной грязи. */
  setQuality(q) { this.q = q; this.shared.uGrime.value = q.tileDetail ? 1 : 0; }

  _register(m) { this.materials.push(m); return m; }

  /**
   * Кафель: процедурная сетка с фаской, вариацией плиток, затиркой,
   * подтёками, налётом по ватерлинии и мокрым блеском у воды.
   */
  tile(opts = {}) {
    const {
      color = 0xf2f4f2,
      grout = 0x8d9a97,
      size = 0.16,
      groutWidth = 0.009,
      seed = 0,
      roughness = 0.12,
      grimeAmount = 1.0,
      wet = 1.0,
      tideStain = 1.0,
      mapMode = 0
    } = opts;
    const useUV = mapMode === 1;

    const mat = new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      roughness,
      metalness: 0.0,
      clearcoat: this.q ? this.q.clearcoat : 0.35,
      clearcoatRoughness: 0.06,
      envMapIntensity: 1.0,
      dithering: true
    });

    const local = {
      uTileColor: { value: new THREE.Color(color) },
      uGroutColor: { value: new THREE.Color(grout) },
      uTileSize: { value: new THREE.Vector2(size, groutWidth) },
      uTileSeed: { value: seed },
      uGrimeAmount: { value: grimeAmount },
      uWetAmount: { value: wet },
      uTideStain: { value: tideStain }
    };
    mat.userData.uniforms = local;

    mat.onBeforeCompile = (shader) => {
      injectCommon(shader, { ...this.shared, ...local }, useUV);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
uniform vec3 uTileColor; uniform vec3 uGroutColor; uniform vec2 uTileSize;
uniform float uTileSeed; uniform float uGrimeAmount; uniform float uWetAmount; uniform float uTideStain;
vec3 gTint = vec3(1.0); float gRough = 0.1; vec3 gCaus = vec3(0.0); vec2 gTilt = vec2(0.0);`)

        .replace('#include <map_fragment>', /* glsl */ `
{
  vec3 wn = normalize(vWNrm);
  vec3 upv = abs(wn.y) > 0.85 ? vec3(0.0, 0.0, 1.0) : vec3(0.0, 1.0, 0.0);
  vec3 Tv = normalize(cross(upv, wn));
  vec3 Bv = cross(wn, Tv);
  vec2 tuv = ${useUV ? 'vTileUV' : 'vec2(dot(vWPos, Tv), dot(vWPos, Bv))'};

  TileInfo ti = tilePattern(tuv, uTileSize.x, uTileSize.y, uTileSize.x * 0.11, uTileSeed);
  vec3 base = mix(uTileColor, uGroutColor, ti.grout) * ti.shade;

  // ---- износ ----
  // Шум дорогой, поэтому считаем его только там, где он виден:
  // плесень — лишь в затенённых углах, подтёки — лишь на вертикальных гранях.
  float ao = clamp(vAOv, 0.0, 1.0);
  float mold = 0.0;
  if (uGrime > 0.01) {
    float corner = 1.0 - ao;
    if (corner > 0.02) {
      mold = corner * fbm3(vWPos.xz * 2.6 + vWPos.y * 1.7) * uGrimeAmount * uGrime;
      base = mix(base, base * vec3(0.62, 0.70, 0.60), clamp(mold * 1.4, 0.0, 0.75));
    }
    float vertical = 1.0 - abs(wn.y);
    if (vertical > 0.05) {
      float streak = smoothstep(0.52, 0.86, fbm3(vec2(tuv.x * 5.0, tuv.y * 0.30)));
      base *= mix(1.0, 0.80, streak * vertical * uGrimeAmount * uGrime * 0.6);
    }
  }

  // тёмная полоса точно по ватерлинии
  float tide = 0.0;
  if (uHasWater > 0.5) {
    float dy = vWPos.y - uWaterY;
    tide = (1.0 - smoothstep(0.0, 0.075, abs(dy + 0.02))) * uTideStain;
    tide += (1.0 - smoothstep(0.0, 0.22, abs(dy + 0.11))) * 0.35 * uTideStain;
    base *= mix(1.0, 0.66, clamp(tide, 0.0, 1.0));
  }

  // мокрая зона: темнее и намного глянцевее
  float wet = 0.0;
  if (uHasWater > 0.5) {
    float band = 1.0 - smoothstep(uWaterY - 0.25, uWaterY + 1.30, vWPos.y);
    wet = clamp(band, 0.0, 1.0) * uWetAmount;
  }
  base *= mix(1.0, 0.78, wet);

  gTint  = base;
  gRough = mix(ti.rough, 0.105, wet);
  gRough = mix(gRough, min(gRough + 0.28, 0.95), mold);
  gTilt  = ti.tilt * (1.0 - wet * 0.55);
  gCaus  = sampleCaustics(vWPos, wn);

  diffuseColor.rgb *= gTint * mix(0.34, 1.0, ao);
}
#include <map_fragment>`)

        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
roughnessFactor = gRough;`)

        .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
{
  vec3 wn0 = normalize(vWNrm);
  vec3 upv = abs(wn0.y) > 0.85 ? vec3(0.0, 0.0, 1.0) : vec3(0.0, 1.0, 0.0);
  vec3 Tv = normalize(cross(upv, wn0));
  vec3 Bv = cross(wn0, Tv);
  vec3 wn2 = normalize(wn0 + Tv * gTilt.x * 0.22 + Bv * gTilt.y * 0.22);
  normal = normalize((viewMatrix * vec4(wn2, 0.0)).xyz);
}`)

        .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
reflectedLight.indirectDiffuse += gCaus * diffuseColor.rgb * 1.1;`);
    };
    mat.customProgramCacheKey = () => 'tile' + seed + '_' + mapMode;
    return this._register(mat);
  }

  /** Бетон/штукатурка — потолки, откосы. */
  concrete(opts = {}) {
    const { color = 0xdcdcd6, roughness = 0.85, grimeAmount = 1.0 } = opts;
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness, metalness: 0.0, dithering: true });
    const local = {
      uBaseColor: { value: new THREE.Color(color) },
      uGrimeAmount: { value: grimeAmount }
    };
    mat.userData.uniforms = local;
    mat.onBeforeCompile = (shader) => {
      injectCommon(shader, { ...this.shared, ...local });
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
uniform vec3 uBaseColor; uniform float uGrimeAmount; vec3 gCaus = vec3(0.0);`)
        .replace('#include <map_fragment>', /* glsl */ `
{
  vec3 wn = normalize(vWNrm);
  float ao = clamp(vAOv, 0.0, 1.0);
  float n = fbm3(vWPos.xz * 3.0 + vWPos.y * 2.0);
  vec3 base = uBaseColor * (0.90 + n * 0.22);
  float mold = (1.0 - ao) * fbm3(vWPos.xz * 2.0) * uGrimeAmount * uGrime;
  base = mix(base, base * vec3(0.55, 0.58, 0.52), clamp(mold * 1.6, 0.0, 0.8));
  float stain = smoothstep(0.55, 0.95, fbm3(vec2(vWPos.x * 2.2, vWPos.z * 2.2)));
  base *= mix(1.0, 0.84, stain * uGrimeAmount * uGrime);
  gCaus = sampleCaustics(vWPos, wn) * 0.6;
  diffuseColor.rgb *= base * mix(0.32, 1.0, ao);
}
#include <map_fragment>`)
        .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
reflectedLight.indirectDiffuse += gCaus * diffuseColor.rgb * 1.1;`);
    };
    mat.customProgramCacheKey = () => 'concrete';
    return this._register(mat);
  }

  /** Металл — поручни, лестницы, решётки. */
  metal(opts = {}) {
    const { color = 0xb9c2c6, roughness = 0.24, metalness = 1.0 } = opts;
    const mat = new THREE.MeshPhysicalMaterial({
      color, roughness, metalness, envMapIntensity: 1.4, dithering: true
    });
    return this._register(mat);
  }

  /** Чернота дверных проёмов — куда не проникает свет. */
  voidDark() {
    const mat = new THREE.MeshBasicMaterial({ color: 0x05070a });
    return this._register(mat);
  }

  /** Листва — двусторонняя, с подповерхностным просветом. */
  foliage(opts = {}) {
    const { color = 0x2f5c33 } = opts;
    const mat = new THREE.MeshPhysicalMaterial({
      color, roughness: 0.55, metalness: 0.0, side: THREE.DoubleSide,
      sheen: 0.5, sheenColor: new THREE.Color(0x9ad17f), clearcoat: 0.25,
      transmission: 0.16, thickness: 0.05, ior: 1.35
    });
    return this._register(mat);
  }

  /** Люминесцентная лампа. */
  lamp(color = 0xfff4d0, intensity = 6) {
    const c = new THREE.Color(color);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x111111, emissive: c, emissiveIntensity: intensity, roughness: 0.4
    });
    return this._register(mat);
  }

  /** Труба водной горки. Кэшируется — горок может быть много. */
  slideTube() {
    if (this._slide) return this._slide;
    this._slide = this._register(new THREE.MeshPhysicalMaterial({
      color: 0xd8e05a, roughness: 0.25, metalness: 0, side: THREE.DoubleSide,
      transmission: 0.45, thickness: 0.4, ior: 1.45, clearcoat: 0.6
    }));
    return this._slide;
  }

  /** Падающая вода душа — прозрачная плёнка со стекающими прожилками. */
  waterCurtain() {
    if (this._curtain) return this._curtain;
    const mat = new THREE.MeshPhysicalMaterial({
      color: 0xdff4f7, roughness: 0.06, metalness: 0.0,
      transmission: 0.92, thickness: 0.12, ior: 1.333,
      transparent: true, opacity: 0.55, side: THREE.DoubleSide,
      depthWrite: false
    });
    const local = { uCurtainSeed: { value: Math.random() * 10 } };
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.shared.uTime;
      Object.assign(shader.uniforms, local);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vLocalP;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLocalP = position;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
varying vec3 vLocalP; uniform float uTime; uniform float uCurtainSeed;
${GLSL_HASH}
${GLSL_NOISE}`)
        .replace('#include <map_fragment>', `#include <map_fragment>
{
  float streak = fbm3(vec2(atan(vLocalP.z, vLocalP.x) * 3.4 + uCurtainSeed, vLocalP.y * 1.6 - uTime * 5.5));
  float a = 0.22 + streak * 0.85;
  diffuseColor.a *= clamp(a, 0.10, 1.0);
  diffuseColor.rgb *= 0.85 + streak * 0.5;
}`);
    };
    mat.customProgramCacheKey = () => 'curtain';
    this._curtain = mat;
    return this._register(mat);
  }

  /** Матовое стекло / стеклоблок. */
  glassBlock() {
    const mat = new THREE.MeshPhysicalMaterial({
      color: 0xeaf6f6, roughness: 0.35, metalness: 0.0, transmission: 0.85,
      thickness: 0.3, ior: 1.5, transparent: true, opacity: 1.0
    });
    return this._register(mat);
  }

  /** Пластик — стулья, буйки, сигналки. */
  plastic(color = 0xf0f0ee, roughness = 0.4) {
    return this._register(new THREE.MeshPhysicalMaterial({
      color, roughness, metalness: 0.0, clearcoat: 0.5, clearcoatRoughness: 0.25
    }));
  }

  /** scene.environment уже раздаёт IBL — здесь только сила отражений. */
  setEnvIntensity(intensity = 1.0) {
    for (const m of this.materials) {
      if ('envMapIntensity' in m) m.envMapIntensity = intensity * (m.metalness > 0.5 ? 1.5 : 1.0);
    }
  }

  dispose() {
    for (const m of this.materials) {
      // процедурные canvas-текстуры тоже надо освобождать, иначе течёт при перезагрузке уровня
      for (const key of ['map', 'emissiveMap', 'alphaMap', 'normalMap', 'roughnessMap']) {
        const t = m[key];
        if (t && t.isTexture && t.dispose) t.dispose();
      }
      m.dispose();
    }
    this.materials.length = 0;
    this._slide = null;
    this._curtain = null;
  }
}
