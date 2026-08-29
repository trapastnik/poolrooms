// Общая GLSL-библиотека: хэши, шум, вороной, каустики, процедурная плитка.
// Всё аналитическое — никаких внешних текстур, поэтому чёткость на любой дистанции.

export const GLSL_HASH = /* glsl */ `
float hash11(float p){ p = fract(p*0.1031); p *= p+33.33; p *= p+p; return fract(p); }
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx)*0.1031); p3 += dot(p3, p3.yzx+33.33); return fract((p3.x+p3.y)*p3.z); }
vec2  hash22(vec2 p){ vec3 p3 = fract(vec3(p.xyx)*vec3(0.1031,0.1030,0.0973)); p3 += dot(p3, p3.yzx+33.33); return fract((p3.xx+p3.yz)*p3.zy); }
vec3  hash32(vec2 p){ vec3 p3 = fract(vec3(p.xyx)*vec3(0.1031,0.1030,0.0973)); p3 += dot(p3, p3.yxz+33.33); return fract((p3.xxy+p3.yzz)*p3.zyx); }
`;

export const GLSL_NOISE = /* glsl */ `
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f*f*(3.0-2.0*f);
  float a = hash12(i), b = hash12(i+vec2(1,0)), c = hash12(i+vec2(0,1)), d = hash12(i+vec2(1,1));
  return mix(mix(a,b,u.x), mix(c,d,u.x), u.y);
}
float fbm(vec2 p){
  float v = 0.0, a = 0.5;
  mat2 m = mat2(1.6,1.2,-1.2,1.6);
  for(int i=0;i<5;i++){ v += a*vnoise(p); p = m*p; a *= 0.5; }
  return v;
}
float fbm3(vec2 p){
  float v = 0.0, a = 0.5;
  mat2 m = mat2(1.6,1.2,-1.2,1.6);
  for(int i=0;i<3;i++){ v += a*vnoise(p); p = m*p; a *= 0.5; }
  return v;
}
`;

// Периодический вороной — даёт бесшовно тайлящуюся текстуру каустик.
export const GLSL_CAUSTIC = /* glsl */ `
vec2 hashP(vec2 c, float period){
  c = mod(c, vec2(period));
  return hash22(c);
}
// Каустики = яркие рёбра деформированной диаграммы Вороного (сетка фокусировки света)
float causticLayer(vec2 p, float t, float period, float sharp){
  vec2 ip = floor(p), fp = fract(p);
  float d1 = 8.0, d2 = 8.0;
  for(int y=-1;y<=1;y++){
    for(int x=-1;x<=1;x++){
      vec2 g = vec2(float(x), float(y));
      vec2 o = hashP(ip+g, period);
      o = 0.5 + 0.45*sin(t*0.9 + 6.2831*o);
      float d = length(g + o - fp);
      if(d < d1){ d2 = d1; d1 = d; } else if(d < d2){ d2 = d; }
    }
  }
  float edge = d2 - d1;                       // 0 на границах ячеек
  return pow(1.0 - smoothstep(0.0, sharp, edge), 3.0);
}
`;

/**
 * Процедурная плитка с аналитическим сглаживанием (fwidth), фаской по краям,
 * вариацией цвета/шероховатости и грязью в швах.
 * Возвращает:  tileShade (множитель альбедо), tileRough, tileNormalTilt (в плоскости)
 */
export const GLSL_TILE = /* glsl */ `
struct TileInfo { float shade; float rough; vec2 tilt; float grout; float ao; float detail; };

TileInfo tilePattern(vec2 uv, float size, float groutW, float bevelW, float seed){
  TileInfo o;
  vec2 t = uv / size;
  vec2 cellId = floor(t);
  vec2 f = fract(t);
  vec2 d = min(f, 1.0 - f) * size;            // расстояние до края плитки в метрах

  float md = min(d.x, d.y);
  float aa = max(fwidth(md), 1e-5);

  // --- фильтрация по LOD: вдали деталь сходится к среднему, иначе муар ---
  vec2 duv = fwidth(uv);
  float lod = max(duv.x, duv.y) / size;        // плиток на пиксель
  float detail = 1.0 - smoothstep(0.22, 0.85, lod);
  float groutAvg = clamp(2.0 * groutW / size, 0.0, 1.0);

  // шов
  float groutSharp = 1.0 - smoothstep(groutW - aa, groutW + aa, md);
  o.grout = mix(groutAvg, groutSharp, detail);

  // фаска: наклон нормали наружу у краёв
  float bx = 1.0 - smoothstep(groutW, groutW + bevelW, d.x);
  float by = 1.0 - smoothstep(groutW, groutW + bevelW, d.y);
  o.tilt = vec2(bx * (f.x < 0.5 ? -1.0 : 1.0), by * (f.y < 0.5 ? -1.0 : 1.0)) * 0.55 * detail;

  // индивидуальная вариация каждой плитки
  vec3 h = hash32(cellId + seed);
  float variation = mix(1.0, 0.90 + h.x * 0.16, detail);
  float glaze     = 0.82 + h.y * 0.28;

  // мелкая «неровность обжига» внутри плитки
  float micro = (fbm3(uv * 7.0 + cellId * 3.7) * 0.10 - 0.05) * detail;

  // затемнение к краю плитки (грязь скапливается в швах)
  float edgeDirt = (1.0 - smoothstep(0.0, groutW * 3.2, md)) * detail;

  o.shade = variation + micro;
  o.shade *= mix(1.0, 0.86, edgeDirt * 0.7);
  o.rough  = mix(0.055 / glaze, 0.72, o.grout); // глазурь гладкая, затирка матовая
  o.rough  = clamp(o.rough + micro * 0.35, 0.02, 0.95);
  o.ao     = mix(1.0, 0.72, o.grout);
  o.detail = detail;
  return o;
}
`;

// ACES + вспомогательное
export const GLSL_COLOR = /* glsl */ `
vec3 acesFilm(vec3 x){
  const mat3 m1 = mat3(0.59719,0.07600,0.02840, 0.35458,0.90834,0.13383, 0.04823,0.01566,0.83777);
  const mat3 m2 = mat3( 1.60475,-0.10208,-0.00327, -0.53108,1.10813,-0.07276, -0.07367,-0.00605,1.07602);
  vec3 v = m1 * x;
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return clamp(m2 * (a / b), 0.0, 1.0);
}
float luma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
`;

export const GLSL_DEPTH = /* glsl */ `
float linearizeDepth(float z, float n, float f){
  float ndc = z * 2.0 - 1.0;
  return (2.0 * n * f) / (f + n - ndc * (f - n));
}
`;
