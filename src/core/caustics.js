import * as THREE from 'three';
import { GLSL_HASH, GLSL_NOISE, GLSL_CAUSTIC } from './shaderlib.js';

/**
 * Рендерит бесшовно тайлящуюся текстуру каустик один раз за кадр.
 * Все материалы сцены потом просто дёшево семплят её по мировым XZ.
 */
export class Caustics {
  constructor(size = 512) {
    this.period = 8.0;                 // ячеек вороного на тайл -> бесшовность
    this.worldScale = 7.0;             // метров на тайл текстуры

    this.rt = new THREE.WebGLRenderTarget(size, size, {
      format: THREE.RedFormat,
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: true,
      wrapS: THREE.RepeatWrapping,
      wrapT: THREE.RepeatWrapping,
      depthBuffer: false,
      stencilBuffer: false
    });
    this.rt.texture.wrapS = THREE.RepeatWrapping;
    this.rt.texture.wrapT = THREE.RepeatWrapping;

    this.uniforms = { uTime: { value: 0 }, uPeriod: { value: this.period } };

    this.mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: /* glsl */ `
        precision highp float;
        varying vec2 vUv;
        uniform float uTime, uPeriod;
        ${GLSL_HASH}
        ${GLSL_NOISE}
        ${GLSL_CAUSTIC}
        void main(){
          vec2 p = vUv * uPeriod;
          // две частоты + лёгкая дисперсия -> живая, не «мультяшная» сетка
          float a = causticLayer(p,               uTime * 1.00, uPeriod, 0.42);
          float b = causticLayer(p * 2.0 + 13.7,  uTime * 1.45, uPeriod * 2.0, 0.30);
          float c = causticLayer(p * 0.5 - 4.1,   uTime * 0.62, uPeriod * 0.5, 0.55);
          float v = a * 0.85 + b * 0.55 + c * 0.70;
          v = pow(max(v, 0.0), 1.25) * 1.35;
          gl_FragColor = vec4(v, 0.0, 0.0, 1.0);
        }`,
      depthTest: false,
      depthWrite: false
    });

    this.scene = new THREE.Scene();
    this.cam = new THREE.Camera();
    const geo = new THREE.PlaneGeometry(2, 2);
    this.quad = new THREE.Mesh(geo, this.mat);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
  }

  get texture() { return this.rt.texture; }

  render(renderer, time) {
    this.uniforms.uTime.value = time;
    const prevTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(this.rt);
    renderer.render(this.scene, this.cam);
    renderer.setRenderTarget(prevTarget);
  }

  dispose() {
    this.rt.dispose();
    this.mat.dispose();
    this.quad.geometry.dispose();
  }
}
