import * as THREE from 'three';

/**
 * Пресеты атмосферы. Каждый задаёт солнце, туман, цвет/поглощение воды,
 * цветокоррекцию и градиент неба для IBL-отражений.
 */
export const ENV_PRESETS = {
  clinic: {
    label: 'Стерильный день',
    sky: { zenith: [0.44, 0.58, 0.68], horizon: [0.92, 0.96, 0.98], ground: [0.30, 0.34, 0.36], sunColor: [1.0, 0.97, 0.92], sunSize: 0.035, sunPower: 26 },
    sun: { color: 0xfff6e8, intensity: 2.7, azimuth: 128, elevation: 34 },
    ambient: { sky: 0xbfe4ee, ground: 0x2a3336, intensity: 0.42 },
    fog: { color: 0x9fc4cb, density: 0.0075 },
    water: { shallow: [0.55, 0.93, 0.88], deep: [0.015, 0.16, 0.20], extinction: [0.42, 0.10, 0.13], turbidity: 0.35, foam: 1.0 },
    post: { exposure: 0.74, bloom: 0.38, bloomThreshold: 1.10, vignette: 0.34, grain: 0.020, chroma: 0.0004, lift: [0.002, 0.006, 0.011], gain: [1.02, 1.0, 0.99], saturation: 1.04, contrast: 1.12 },
    volumetric: { intensity: 0.55, color: [0.85, 0.95, 1.0] }
  },
  amber: {
    label: 'Золотой закат',
    sky: { zenith: [0.52, 0.42, 0.34], horizon: [1.0, 0.80, 0.50], ground: [0.34, 0.26, 0.19], sunColor: [1.0, 0.78, 0.45], sunSize: 0.055, sunPower: 18 },
    sun: { color: 0xffcf8a, intensity: 3.2, azimuth: 250, elevation: 11 },
    ambient: { sky: 0xffd9a8, ground: 0x40301f, intensity: 0.50 },
    fog: { color: 0xe8c79a, density: 0.011 },
    water: { shallow: [0.72, 0.66, 0.48], deep: [0.10, 0.09, 0.07], extinction: [0.20, 0.24, 0.34], turbidity: 0.55, foam: 0.7 },
    post: { exposure: 0.85, bloom: 0.72, bloomThreshold: 0.9, vignette: 0.40, grain: 0.030, chroma: 0.0013, lift: [0.020, 0.010, 0.004], gain: [1.05, 0.99, 0.92], saturation: 1.05, contrast: 1.12 },
    volumetric: { intensity: 1.25, color: [1.0, 0.82, 0.55] }
  },
  sage: {
    label: 'Мшистая тишина',
    sky: { zenith: [0.36, 0.44, 0.38], horizon: [0.78, 0.84, 0.74], ground: [0.24, 0.28, 0.24], sunColor: [0.94, 0.98, 0.86], sunSize: 0.09, sunPower: 10 },
    sun: { color: 0xdfeacb, intensity: 2.0, azimuth: 65, elevation: 22 },
    ambient: { sky: 0xa8c0a4, ground: 0x242c26, intensity: 0.52 },
    fog: { color: 0xa9bdae, density: 0.016 },
    water: { shallow: [0.50, 0.80, 0.68], deep: [0.03, 0.11, 0.10], extinction: [0.40, 0.14, 0.20], turbidity: 0.70, foam: 0.55 },
    post: { exposure: 0.82, bloom: 0.50, bloomThreshold: 1.0, vignette: 0.44, grain: 0.036, chroma: 0.0010, lift: [0.006, 0.014, 0.010], gain: [0.98, 1.02, 0.97], saturation: 0.94, contrast: 1.11 },
    volumetric: { intensity: 0.85, color: [0.82, 0.92, 0.80] }
  },
  fluoro: {
    label: 'Подвал / лампы',
    sky: { zenith: [0.05, 0.06, 0.07], horizon: [0.12, 0.13, 0.13], ground: [0.03, 0.03, 0.03], sunColor: [0.3, 0.3, 0.3], sunSize: 0.2, sunPower: 4 },
    sun: { color: 0x9fb4b8, intensity: 0.25, azimuth: 190, elevation: 60 },
    ambient: { sky: 0x2b3336, ground: 0x0d1011, intensity: 0.32 },
    fog: { color: 0x6a6b52, density: 0.030 },
    water: { shallow: [0.42, 0.72, 0.66], deep: [0.02, 0.09, 0.09], extinction: [0.45, 0.16, 0.20], turbidity: 0.85, foam: 0.5 },
    post: { exposure: 1.05, bloom: 0.70, bloomThreshold: 0.95, vignette: 0.55, grain: 0.048, chroma: 0.0016, lift: [0.010, 0.012, 0.006], gain: [1.04, 1.02, 0.88], saturation: 0.92, contrast: 1.10 },
    volumetric: { intensity: 0.35, color: [0.95, 0.92, 0.62] }
  },
  cyan: {
    label: 'Ночная бирюза',
    sky: { zenith: [0.04, 0.14, 0.17], horizon: [0.10, 0.36, 0.40], ground: [0.02, 0.07, 0.08], sunColor: [0.35, 0.85, 0.90], sunSize: 0.18, sunPower: 5 },
    sun: { color: 0x7fe6ea, intensity: 0.55, azimuth: 300, elevation: 48 },
    ambient: { sky: 0x2ba8b4, ground: 0x061418, intensity: 0.45 },
    fog: { color: 0x2f9aa6, density: 0.020 },
    water: { shallow: [0.35, 0.92, 0.95], deep: [0.02, 0.22, 0.26], extinction: [0.50, 0.09, 0.08], turbidity: 0.30, foam: 0.8 },
    post: { exposure: 1.02, bloom: 0.70, bloomThreshold: 0.95, vignette: 0.50, grain: 0.034, chroma: 0.0015, lift: [0.0, 0.012, 0.020], gain: [0.92, 1.03, 1.06], saturation: 1.10, contrast: 1.08 },
    volumetric: { intensity: 0.70, color: [0.55, 0.95, 1.0] }
  },
  deep: {
    label: 'Затопленный неон',
    sky: { zenith: [0.02, 0.09, 0.12], horizon: [0.04, 0.22, 0.26], ground: [0.01, 0.05, 0.06], sunColor: [0.20, 0.70, 0.78], sunSize: 0.25, sunPower: 3 },
    sun: { color: 0x63d8e4, intensity: 0.30, azimuth: 20, elevation: 70 },
    ambient: { sky: 0x1f7f8e, ground: 0x03191d, intensity: 0.58 },
    fog: { color: 0x11616e, density: 0.024 },
    water: { shallow: [0.24, 0.86, 0.90], deep: [0.01, 0.14, 0.18], extinction: [0.58, 0.11, 0.09], turbidity: 0.45, foam: 0.65 },
    post: { exposure: 1.05, bloom: 0.80, bloomThreshold: 0.95, vignette: 0.58, grain: 0.038, chroma: 0.0018, lift: [0.0, 0.010, 0.018], gain: [0.86, 1.04, 1.10], saturation: 1.16, contrast: 1.10 },
    volumetric: { intensity: 0.45, color: [0.40, 0.95, 1.0] }
  },
  midnight: {
    label: 'Тёмный кафель',
    sky: { zenith: [0.02, 0.04, 0.05], horizon: [0.05, 0.10, 0.12], ground: [0.01, 0.02, 0.02], sunColor: [0.25, 0.45, 0.5], sunSize: 0.3, sunPower: 3 },
    sun: { color: 0x5c8f9c, intensity: 0.14, azimuth: 140, elevation: 65 },
    ambient: { sky: 0x1a3d47, ground: 0x040a0c, intensity: 0.44 },
    fog: { color: 0x0d2a33, density: 0.030 },
    water: { shallow: [0.30, 0.88, 0.94], deep: [0.01, 0.10, 0.14], extinction: [0.55, 0.12, 0.10], turbidity: 0.35, foam: 0.75 },
    post: { exposure: 1.15, bloom: 0.85, bloomThreshold: 0.90, vignette: 0.66, grain: 0.045, chroma: 0.0017, lift: [0.0, 0.008, 0.014], gain: [0.88, 1.02, 1.08], saturation: 1.12, contrast: 1.14 },
    volumetric: { intensity: 0.22, color: [0.45, 0.90, 1.0] }
  },
  greenhouse: {
    label: 'Оранжерея',
    sky: { zenith: [0.50, 0.66, 0.62], horizon: [0.95, 0.99, 0.94], ground: [0.28, 0.34, 0.28], sunColor: [1.0, 0.99, 0.92], sunSize: 0.045, sunPower: 20 },
    sun: { color: 0xfffaf0, intensity: 2.5, azimuth: 210, elevation: 44 },
    ambient: { sky: 0xd6f0e4, ground: 0x2e3a30, intensity: 0.55 },
    fog: { color: 0xd8ece4, density: 0.009 },
    water: { shallow: [0.62, 0.95, 0.92], deep: [0.02, 0.20, 0.24], extinction: [0.38, 0.09, 0.11], turbidity: 0.25, foam: 0.9 },
    post: { exposure: 0.84, bloom: 0.55, bloomThreshold: 1.0, vignette: 0.30, grain: 0.020, chroma: 0.0004, lift: [0.004, 0.010, 0.010], gain: [1.0, 1.02, 1.0], saturation: 1.05, contrast: 1.10 },
    volumetric: { intensity: 0.65, color: [0.92, 1.0, 0.95] }
  }
};

export function sunDirection(azimuthDeg, elevationDeg) {
  const az = THREE.MathUtils.degToRad(azimuthDeg);
  const el = THREE.MathUtils.degToRad(elevationDeg);
  return new THREE.Vector3(
    Math.cos(el) * Math.sin(az),
    Math.sin(el),
    Math.cos(el) * Math.cos(az)
  ).normalize();
}

/** Процедурная equirect-панорама (Float16) для IBL-отражений. */
export function buildSkyTexture(preset, sunDir) {
  const W = 256, H = 128;
  const data = new Float32Array(W * H * 4);
  const s = preset.sky;
  for (let y = 0; y < H; y++) {
    const theta = (y + 0.5) / H * Math.PI;      // 0 = зенит
    const cy = Math.cos(theta), sy = Math.sin(theta);
    for (let x = 0; x < W; x++) {
      const phi = (x + 0.5) / W * Math.PI * 2 - Math.PI;
      const dx = sy * Math.sin(phi), dy = cy, dz = sy * Math.cos(phi);

      const up = Math.max(dy, 0);
      const t = Math.pow(up, 0.45);
      let r, g, b;
      if (dy >= 0) {
        r = s.horizon[0] * (1 - t) + s.zenith[0] * t;
        g = s.horizon[1] * (1 - t) + s.zenith[1] * t;
        b = s.horizon[2] * (1 - t) + s.zenith[2] * t;
      } else {
        const d = Math.pow(-dy, 0.6);
        r = s.horizon[0] * (1 - d) + s.ground[0] * d;
        g = s.horizon[1] * (1 - d) + s.ground[1] * d;
        b = s.horizon[2] * (1 - d) + s.ground[2] * d;
      }
      // диск солнца + ореол
      const cosA = dx * sunDir.x + dy * sunDir.y + dz * sunDir.z;
      const disc = Math.pow(Math.max(cosA, 0), s.sunPower) * 6.0;
      const halo = Math.pow(Math.max(cosA, 0), 3.0) * 0.35;
      r += (disc + halo) * s.sunColor[0];
      g += (disc + halo) * s.sunColor[1];
      b += (disc + halo) * s.sunColor[2];

      const i = (y * W + x) * 4;
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 1;
    }
  }
  const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.FloatType);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.LinearSRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}
