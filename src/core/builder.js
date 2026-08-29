import * as THREE from 'three';
import { CELL, FEAT, MATS, isRoom, inside } from './level.js';
import { ensureAO } from './materials.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const smoothstep = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };

// ---------------------------------------------------------------- меш-аккумулятор

class Mesher {
  constructor(withUV = false) {
    this.pos = []; this.nrm = []; this.ao = []; this.uv = []; this.tuv = [];
    this.index = []; this.count = 0;
    this.withUV = withUV;
  }
  vertex(p, n, ao, tu, tv) {
    this.pos.push(p.x, p.y, p.z);
    this.nrm.push(n.x, n.y, n.z);
    this.ao.push(ao);
    this.uv.push(0, 0);
    if (this.withUV) this.tuv.push(tu || 0, tv || 0);
    return this.count++;
  }
  /**
   * Квад: P(u,v) = O + U*u + V*v, нормаль = normalize(U × V).
   * aoFn(x,y,z,nx,ny,nz) -> 0..1;  uvFn(u,v) -> [tu,tv] (метры) для режима UV.
   */
  quad(O, U, Vv, subU, subV, aoFn, uvFn, flip = false) {
    const n = new THREE.Vector3().crossVectors(U, Vv).normalize();
    if (flip) n.negate();
    const base = this.count;
    const p = new THREE.Vector3();
    for (let j = 0; j <= subV; j++) {
      const v = j / subV;
      for (let i = 0; i <= subU; i++) {
        const u = i / subU;
        p.copy(O).addScaledVector(U, u).addScaledVector(Vv, v);
        const ao = aoFn ? aoFn(p.x, p.y, p.z, n.x, n.y, n.z) : 1;
        let tu = 0, tv = 0;
        if (this.withUV && uvFn) { const r = uvFn(u, v); tu = r[0]; tv = r[1]; }
        this.vertex(p, n, ao, tu, tv);
      }
    }
    const w = subU + 1;
    for (let j = 0; j < subV; j++) {
      for (let i = 0; i < subU; i++) {
        const a = base + j * w + i, b = a + 1, c = a + w + 1, d = a + w;
        // при flip разворачиваем обход треугольников, чтобы совпадал с нормалью
        if (flip) this.index.push(a, c, b, a, d, c);
        else this.index.push(a, b, c, a, c, d);
      }
    }
  }
  /** Ящик, все 6 граней наружу. */
  box(cx, cy, cz, sx, sy, sz, aoFn, subd = 1) {
    const x0 = cx - sx / 2, x1 = cx + sx / 2;
    const y0 = cy - sy / 2, y1 = cy + sy / 2;
    const z0 = cz - sz / 2, z1 = cz + sz / 2;
    const su = Math.max(1, Math.round(sx * subd)), sv = Math.max(1, Math.round(sz * subd)), sh = Math.max(1, Math.round(sy * subd));
    this.quad(V(x0, y1, z0), V(sx, 0, 0), V(0, 0, sz), su, sv, aoFn, (u, v) => [u * sx, v * sz], true);   // верх
    this.quad(V(x0, y0, z1), V(sx, 0, 0), V(0, 0, -sz), su, sv, aoFn, (u, v) => [u * sx, v * sz], true);  // низ
    this.quad(V(x0, y0, z1), V(0, sy, 0), V(sx, 0, 0), sh, su, aoFn, (u, v) => [u * sy, v * sx], true);   // +z
    this.quad(V(x1, y0, z0), V(0, sy, 0), V(-sx, 0, 0), sh, su, aoFn, (u, v) => [u * sy, v * sx], true);  // -z
    this.quad(V(x1, y0, z1), V(0, sy, 0), V(0, 0, -sz), sh, sv, aoFn, (u, v) => [u * sy, v * sz], true);  // +x
    this.quad(V(x0, y0, z0), V(0, sy, 0), V(0, 0, sz), sh, sv, aoFn, (u, v) => [u * sy, v * sz], true);   // -x
  }
  isEmpty() { return this.count === 0; }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('aAO', new THREE.Float32BufferAttribute(this.ao, 1));
    if (this.withUV) g.setAttribute('aTileUV', new THREE.Float32BufferAttribute(this.tuv, 2));
    g.setIndex(this.index);
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

// ---------------------------------------------------------------- окклюзия

function makeAOSampler(lv) {
  const cs = lv.cell;
  const solidAt = (i, j) => {
    if (!inside(lv, i, j)) return true;
    const k = j * lv.w + i;
    if (lv.t[k] === CELL.ROOM) return false;
    const o = lv.o[k];
    return !(o === FEAT.ARCH || o === FEAT.DOOR);
  };

  /** Насколько точка (x,z) зажата стенами/уступами на высоте y. */
  function horiz(x, z, y) {
    const ci = Math.floor(x / cs), cj = Math.floor(z / cs);
    let occ = 0;
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        const i = ci + di, j = cj + dj;
        let blocking = solidAt(i, j);
        if (!blocking && inside(lv, i, j)) {
          const k = j * lv.w + i;
          if (lv.f[k] > y + 0.35) blocking = true;      // уступ вверх тоже затеняет
        }
        if (!blocking) continue;
        const x0 = i * cs, x1 = x0 + cs, z0 = j * cs, z1 = z0 + cs;
        const dx = Math.max(x0 - x, 0, x - x1);
        const dz = Math.max(z0 - z, 0, z - z1);
        const d = Math.hypot(dx, dz);
        occ = Math.max(occ, 1 - smoothstep(0, 1.7, d));
      }
    }
    return occ;
  }

  return {
    floor: (x, y, z) => clamp(1 - horiz(x, z, y) * 0.72, 0.12, 1),
    ceil: (x, y, z) => clamp(0.90 - horiz(x, z, y - 2.2) * 0.55, 0.12, 1),
    wall: (x, y, z, nx, nz, fy, cy) => {
      const fromFloor = 1 - smoothstep(0, 1.35, y - fy);
      const fromCeil = 1 - smoothstep(0, 1.05, cy - y);
      const h = horiz(x + nx * 0.55, z + nz * 0.55, y);
      return clamp(1 - (fromFloor * 0.58 + fromCeil * 0.34 + h * 0.50), 0.08, 1);
    },
    generic: (x, y, z) => clamp(1 - horiz(x, z, y) * 0.45, 0.25, 1)
  };
}

// ---------------------------------------------------------------- фичи-примитивы

function tubeAlong(mesher, curve, radius, radialSeg, tubularSeg, aoFn) {
  const frames = curve.computeFrenetFrames(tubularSeg, false);
  const pts = [];
  for (let i = 0; i <= tubularSeg; i++) pts.push(curve.getPointAt(i / tubularSeg));
  const base = mesher.count;
  for (let i = 0; i <= tubularSeg; i++) {
    const P = pts[i], N = frames.normals[i], B = frames.binormals[i];
    for (let j = 0; j <= radialSeg; j++) {
      const a = (j / radialSeg) * Math.PI * 2;
      const nrm = new THREE.Vector3().addScaledVector(N, Math.cos(a)).addScaledVector(B, Math.sin(a)).normalize();
      const p = new THREE.Vector3().copy(P).addScaledVector(nrm, radius);
      mesher.vertex(p, nrm, aoFn ? aoFn(p.x, p.y, p.z) : 1, (j / radialSeg) * radius * Math.PI * 2, (i / tubularSeg) * curve.getLength());
    }
  }
  const w = radialSeg + 1;
  for (let i = 0; i < tubularSeg; i++) {
    for (let j = 0; j < radialSeg; j++) {
      const a = base + i * w + j, b = a + 1, c = a + w + 1, d = a + w;
      mesher.index.push(a, b, c, a, c, d);
    }
  }
}

function cylinderMesher(mesher, cx, cz, y0, y1, radius, seg, aoFn) {
  const base = mesher.count;
  const h = y1 - y0;
  for (let i = 0; i <= 1; i++) {
    const y = i === 0 ? y0 : y1;
    for (let j = 0; j <= seg; j++) {
      const a = (j / seg) * Math.PI * 2;
      const nx = Math.cos(a), nz = Math.sin(a);
      const p = V(cx + nx * radius, y, cz + nz * radius);
      const ao = aoFn ? aoFn(p.x, p.y, p.z, nx, 0, nz) : 1;
      mesher.vertex(p, V(nx, 0, nz), ao, (j / seg) * radius * Math.PI * 2, y);
    }
  }
  const w = seg + 1;
  for (let j = 0; j < seg; j++) {
    const a = base + j, b = a + 1, c = base + w + j + 1, d = base + w + j;
    // обход по часовой, чтобы лицевая сторона совпадала с внешней нормалью
    mesher.index.push(a, c, b, a, d, c);
  }
}

function sphereMesher(mesher, cx, cy, cz, r, segU, segV, aoFn) {
  const base = mesher.count;
  for (let v = 0; v <= segV; v++) {
    const phi = (v / segV) * Math.PI;
    const sp = Math.sin(phi), cp = Math.cos(phi);
    for (let u = 0; u <= segU; u++) {
      const th = (u / segU) * Math.PI * 2;
      const nx = sp * Math.cos(th), ny = cp, nz = sp * Math.sin(th);
      const p = V(cx + nx * r, cy + ny * r, cz + nz * r);
      // развёртка в метрах: длина дуги по параллели и по меридиану
      mesher.vertex(p, V(nx, ny, nz), aoFn ? aoFn(p.x, p.y, p.z) : 1, th * r * Math.max(sp, 0.08), phi * r);
    }
  }
  const w = segU + 1;
  for (let v = 0; v < segV; v++) {
    for (let u = 0; u < segU; u++) {
      const A = base + v * w + u, B = A + 1, C = A + w + 1, D = A + w;
      mesher.index.push(A, B, C, A, C, D);
    }
  }
}

const NEON_WORDS = ['dreams', 'no diving', 'quiet', 'deep end', 'closed'];

function makeNeonTexture(word) {
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 356;
  const g = c.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, c.width, c.height);
  g.font = 'italic 190px "Brush Script MT", "Segoe Script", cursive, serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  // мягкий ореол + яркая сердцевина трубки
  g.shadowColor = '#ffffff';
  for (const [blur, alpha, lw] of [[70, 0.30, 20], [34, 0.55, 13], [14, 0.85, 7]]) {
    g.shadowBlur = blur;
    g.strokeStyle = `rgba(255,255,255,${alpha})`;
    g.lineWidth = lw; g.lineJoin = 'round';
    g.strokeText(word, c.width / 2, c.height / 2);
  }
  g.shadowBlur = 8;
  g.fillStyle = '#ffffff';
  g.fillText(word, c.width / 2, c.height / 2);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

// ---------------------------------------------------------------- главный сборщик

export function buildLevel(level, matlib, quality, opts = {}) {
  const lv = level;
  const cs = lv.cell;
  const AO = makeAOSampler(lv);
  const group = new THREE.Group();
  group.name = 'level';

  const wY = lv.waterY;
  const lightSpecs = [];
  const emissiveSpecs = [];

  // мешеры: планарные (по вариантам материала) и UV-развёрнутые
  const planar = new Map();
  const uvm = new Map();
  const getPlanar = (m) => { if (!planar.has(m)) planar.set(m, new Mesher(false)); return planar.get(m); };
  const getUV = (m) => { if (!uvm.has(m)) uvm.set(m, new Mesher(true)); return uvm.get(m); };

  const metalM = new Mesher(false);
  const darkM = new Mesher(false);
  const showerSpecs = [];
  const neonTexts = [];

  const subFloor = 3, subWallH = 2;
  const wallSeg = (h) => Math.max(2, Math.min(14, Math.round(h / 0.55)));

  const cellF = (i, j) => lv.f[j * lv.w + i];
  const cellC = (i, j) => lv.c[j * lv.w + i];
  const cellM = (i, j) => lv.m[j * lv.w + i] % MATS.length;
  const featOf = (i, j) => lv.o[j * lv.w + i];

  const isPassage = (i, j) => {
    if (!inside(lv, i, j)) return false;
    const k = j * lv.w + i;
    if (lv.t[k] === CELL.ROOM) return false;
    const o = lv.o[k];
    return o === FEAT.ARCH || o === FEAT.DOOR;
  };
  const isOpenCell = (i, j) => isRoom(lv, i, j) || isPassage(i, j);

  // ------------------------------------------------------------ полы и потолки
  for (let j = 0; j < lv.h; j++) {
    for (let i = 0; i < lv.w; i++) {
      const k = j * lv.w + i;
      if (!isOpenCell(i, j)) continue;
      const m = getPlanar(cellM(i, j));
      const x0 = i * cs, z0 = j * cs;
      const f = lv.f[k], c = lv.c[k];

      // пол (нормаль вверх: U=+x, V=-z -> x×(-z) = +y)
      m.quad(V(x0, f, z0 + cs), V(cs, 0, 0), V(0, 0, -cs), subFloor, subFloor, AO.floor);
      // потолок (нормаль вниз)
      m.quad(V(x0, c, z0), V(cs, 0, 0), V(0, 0, cs), subFloor, subFloor, AO.ceil);
    }
  }

  // ------------------------------------------------------------ стены
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (let j = 0; j < lv.h; j++) {
    for (let i = 0; i < lv.w; i++) {
      const k = j * lv.w + i;
      if (!isOpenCell(i, j)) continue;
      const f = lv.f[k], c = lv.c[k];
      const m = getPlanar(cellM(i, j));
      const x0 = i * cs, z0 = j * cs;

      for (const [dx, dz] of DIRS) {
        const ni = i + dx, nj = j + dz;
        const neighborOpen = isOpenCell(ni, nj);
        // фича-стена (арка/дверь/окно) строит собственную геометрию
        if (inside(lv, ni, nj) && !isRoom(lv, ni, nj)) {
          const nf = featOf(ni, nj);
          if (nf === FEAT.ARCH || nf === FEAT.DOOR || nf === FEAT.WINDOW) continue;
        }

        const spans = [];
        if (!neighborOpen) {
          spans.push([f, c]);
        } else {
          const nk = nj * lv.w + ni;
          const nff = lv.f[nk], ncc = lv.c[nk];
          if (nff > f + 0.02) spans.push([f, Math.min(nff, c)]);
          if (ncc < c - 0.02) spans.push([Math.max(ncc, f), c]);
        }

        for (const [y0, y1] of spans) {
          const hgt = y1 - y0;
          if (hgt < 0.02) continue;
          // плоскость на границе, нормаль внутрь клетки (-dx, 0, -dz)
          let O, U, W;
          if (dx === 1) { O = V(x0 + cs, y0, z0 + cs); U = V(0, hgt, 0); W = V(0, 0, -cs); }
          else if (dx === -1) { O = V(x0, y0, z0); U = V(0, hgt, 0); W = V(0, 0, cs); }
          else if (dz === 1) { O = V(x0, y0, z0 + cs); U = V(0, hgt, 0); W = V(cs, 0, 0); }
          else { O = V(x0 + cs, y0, z0); U = V(0, hgt, 0); W = V(-cs, 0, 0); }
          m.quad(O, U, W, wallSeg(hgt), subWallH,
            (x, y, z, nx, ny, nz) => AO.wall(x, y, z, nx, nz, f, c));
        }
      }
    }
  }

  // ------------------------------------------------------------ фичи
  const bob = [];

  for (let j = 0; j < lv.h; j++) {
    for (let i = 0; i < lv.w; i++) {
      const k = j * lv.w + i;
      const feat = lv.o[k];
      if (feat === FEAT.NONE) continue;
      const rot = lv.r[k] % 4;
      const cx = (i + 0.5) * cs, cz = (j + 0.5) * cs;
      const f = lv.f[k], c = lv.c[k];
      const mi = cellM(i, j);

      switch (feat) {
        case FEAT.COLUMN_SQ: {
          if (!isRoom(lv, i, j)) break;
          const m = getPlanar(mi);
          const s = 1.35;
          m.box(cx, (f + c) / 2, cz, s, c - f, s,
            (x, y, z) => clamp(1 - (1 - smoothstep(0, 1.2, y - f)) * 0.5 - (1 - smoothstep(0, 1.0, c - y)) * 0.3, 0.2, 1), 2);
          break;
        }
        case FEAT.COLUMN_ROUND: {
          if (!isRoom(lv, i, j)) break;
          const m = getUV(mi);
          cylinderMesher(m, cx, cz, f, c, 0.62, 28,
            (x, y) => clamp(1 - (1 - smoothstep(0, 1.2, y - f)) * 0.5 - (1 - smoothstep(0, 1.0, c - y)) * 0.3, 0.2, 1));
          break;
        }
        case FEAT.ARCH: buildArch(lv, i, j, getPlanar(mi), getUV(mi), AO, false); break;
        case FEAT.DOOR: buildArch(lv, i, j, getPlanar(mi), getUV(mi), AO, true, darkM); break;
        case FEAT.WINDOW: buildWindow(lv, i, j, getPlanar(mi), AO, emissiveSpecs); break;
        case FEAT.STAIRS: buildStairs(lv, i, j, getPlanar(mi), AO); break;
        case FEAT.RAILING: buildRailing(lv, i, j, metalM, rot); break;
        case FEAT.LADDER: buildLadder(cx, cz, Math.max(f, wY) + 0.02, rot, metalM); break;
        case FEAT.GRATE:
          metalM.box(cx, f + 0.02, cz, 0.9, 0.05, 0.9, () => 0.55, 2);
          break;
        case FEAT.LAMP: {
          const y = c - 0.10;
          emissiveSpecs.push({
            x: cx, y, z: cz,
            sx: rot % 2 === 0 ? cs * 0.62 : 0.42, sy: 0.10, sz: rot % 2 === 0 ? 0.42 : cs * 0.62,
            color: 0xfff6df, intensity: 3.5, shape: 'box'
          });
          lightSpecs.push({ x: cx, y: y - 0.25, z: cz, color: 0xfff0cf, intensity: 30, distance: 18 });
          break;
        }
        case FEAT.LIGHT:
          lightSpecs.push({ x: cx, y: (f + c) * 0.5, z: cz, color: 0xd8f2ff, intensity: 20, distance: 18 });
          break;

        // --- неоновая полоса вдоль стены под потолком ---
        case FEAT.NEON: {
          if (!isRoom(lv, i, j)) break;
          const d = [[0, -1], [1, 0], [0, 1], [-1, 0]][rot];
          const y = c - 0.55;
          const off = 0.10;
          const ex = cx + d[0] * (cs / 2 - off), ez = cz + d[1] * (cs / 2 - off);
          const horiz = Math.abs(d[0]) > 0.5;
          emissiveSpecs.push({
            x: ex, y, z: ez,
            sx: horiz ? 0.09 : cs * 0.98, sy: 0.10, sz: horiz ? cs * 0.98 : 0.09,
            color: 0x8ff2ff, intensity: 3.4, shape: 'box'
          });
          lightSpecs.push({ x: ex - d[0] * 0.4, y, z: ez - d[1] * 0.4, color: 0x8ff2ff, intensity: 20, distance: 17 });
          break;
        }

        // --- светящаяся плита, утопленная в пол ---
        case FEAT.FLOORLIGHT: {
          if (!isRoom(lv, i, j)) break;
          const horiz = rot % 2 === 0;
          emissiveSpecs.push({
            x: cx, y: f + 0.035, z: cz,
            sx: horiz ? cs * 0.72 : 0.55, sy: 0.07, sz: horiz ? 0.55 : cs * 0.72,
            color: 0xc8f8ff, intensity: 3.4, shape: 'box'
          });
          lightSpecs.push({ x: cx, y: f + 0.6, z: cz, color: 0xbdf2ff, intensity: 20, distance: 16 });
          break;
        }

        // --- потолочные споты 2×2 ---
        case FEAT.CEILSPOT: {
          if (!isRoom(lv, i, j)) break;
          for (const [ox, oz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
            emissiveSpecs.push({
              x: cx + ox * cs * 0.24, y: c - 0.045, z: cz + oz * cs * 0.24,
              sx: 0.22, sy: 0.05, sz: 0.22, color: 0xeafdff, intensity: 5.0, shape: 'disc'
            });
          }
          lightSpecs.push({ x: cx, y: c - 0.4, z: cz, color: 0xdff8ff, intensity: 34, distance: 21 });
          break;
        }

        // --- крупная кафельная сфера ---
        case FEAT.SPHERE: {
          if (!isRoom(lv, i, j)) break;
          const m = getUV(mi);
          const R = 1.15;
          const d = [[0, -1], [1, 0], [0, 1], [-1, 0]][rot];
          const embedded = rot < 4;
          const sx = cx + d[0] * (cs / 2 - R * 0.35);
          const sz = cz + d[1] * (cs / 2 - R * 0.35);
          const sy = f + (c - f) * 0.62;
          sphereMesher(m, sx, sy, sz, R, 36, 24, () => 0.9);
          break;
        }

        // --- душ: лейка + падающая струя ---
        case FEAT.SHOWER: {
          if (!isRoom(lv, i, j)) break;
          const d = [[0, -1], [1, 0], [0, 1], [-1, 0]][rot];
          const hx = cx + d[0] * (cs / 2 - 0.16), hz = cz + d[1] * (cs / 2 - 0.16);
          const hy = f + Math.min(2.35, (c - f) * 0.75);
          metalM.box(hx, hy, hz, 0.22, 0.08, 0.22, () => 0.7, 4);
          metalM.box(hx + d[0] * 0.07, hy + 0.22, hz + d[1] * 0.07, 0.05, 0.42, 0.05, () => 0.7, 4);
          showerSpecs.push({ x: hx, yTop: hy - 0.05, yBottom: Math.max(f, wY), r: 0.16 });
          break;
        }

        // --- неоновая надпись на стене ---
        case FEAT.NEONTEXT: {
          if (!isRoom(lv, i, j)) break;
          neonTexts.push({ i, j, rot, cx, cz, f, c });
          const d = [[0, -1], [1, 0], [0, 1], [-1, 0]][rot];
          lightSpecs.push({
            x: cx + d[0] * (cs / 2 - 0.6), y: f + (c - f) * 0.55, z: cz + d[1] * (cs / 2 - 0.6),
            color: 0x7ceaff, intensity: 12, distance: 12
          });
          break;
        }

        default: break;
      }
    }
  }

  // ------------------------------------------------------------ вода
  let waterGeom = null;
  {
    const wm = new Mesher(false);
    const sub = quality.waterSubdiv;
    let any = false;
    for (let j = 0; j < lv.h; j++) {
      for (let i = 0; i < lv.w; i++) {
        const k = j * lv.w + i;
        if (!isOpenCell(i, j)) continue;
        if (lv.f[k] >= wY - 0.02) continue;
        if (lv.c[k] <= wY) continue;
        any = true;
        const x0 = i * cs, z0 = j * cs;
        wm.quad(V(x0, wY, z0 + cs), V(cs, 0, 0), V(0, 0, -cs), sub, sub, null);
      }
    }
    if (any) waterGeom = wm.build();
  }

  // ------------------------------------------------------------ сборка мешей
  const addMesh = (geom, mat, name) => {
    ensureAO(geom);
    const mesh = new THREE.Mesh(geom, mat);
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
  };

  const tileMats = [];
  for (const [mIdx, mesher] of planar) {
    if (mesher.isEmpty()) continue;
    const def = MATS[mIdx];
    const mat = matlib.tile({ color: def.color, grout: def.grout, size: def.size, seed: mIdx * 7.3, mapMode: 0 });
    tileMats.push(mat);
    addMesh(mesher.build(), mat, 'tiles' + mIdx);
  }
  for (const [mIdx, mesher] of uvm) {
    if (mesher.isEmpty()) continue;
    const def = MATS[mIdx];
    const mat = matlib.tile({ color: def.color, grout: def.grout, size: def.size, seed: mIdx * 7.3 + 3, mapMode: 1 });
    tileMats.push(mat);
    addMesh(mesher.build(), mat, 'tilesUV' + mIdx);
  }
  if (!metalM.isEmpty()) addMesh(metalM.build(), matlib.metal(), 'metal');
  if (!darkM.isEmpty()) {
    const g = darkM.build(); ensureAO(g);
    const mesh = new THREE.Mesh(g, matlib.voidDark());
    mesh.name = 'voids'; group.add(mesh);
  }

  // ------------------------------------------------------------ пропы
  const props = new THREE.Group();
  props.name = 'props';
  group.add(props);
  buildProps(lv, matlib, props, bob, lightSpecs, AO);

  // светящиеся панели — группируем по цвету/яркости и сливаем в один меш
  if (emissiveSpecs.length) {
    const byKey = new Map();
    for (const e of emissiveSpecs) {
      const key = `${e.color}_${e.intensity}`;
      if (!byKey.has(key)) byKey.set(key, { color: e.color, intensity: e.intensity, geos: [] });
      let g;
      if (e.shape === 'disc') g = new THREE.CylinderGeometry(e.sx / 2, e.sx / 2, e.sy, 18);
      else if (e.shape === 'sphere') g = new THREE.SphereGeometry(e.sx / 2, 20, 14);
      else g = new THREE.BoxGeometry(e.sx, e.sy, e.sz);
      g.translate(e.x, e.y, e.z);
      byKey.get(key).geos.push(g);
    }
    for (const [key, grp] of byKey) {
      const merged = mergeGeometries(grp.geos);
      if (!merged) continue;
      const mesh = new THREE.Mesh(merged, matlib.lamp(grp.color, grp.intensity));
      mesh.name = 'emissive_' + key;
      group.add(mesh);
    }
  }

  // струи душа — сливаем в один меш
  if (showerSpecs.length) {
    const geos = [];
    for (const s of showerSpecs) {
      const h = Math.max(0.4, s.yTop - s.yBottom);
      const g = new THREE.CylinderGeometry(s.r * 0.65, s.r * 1.5, h, 14, 1, true);
      g.translate(s.x, s.yTop - h / 2, s.z);
      geos.push(g);
    }
    const merged = mergeGeometries(geos);
    for (const g of geos) g.dispose();
    if (merged) {
      const mesh = new THREE.Mesh(merged, matlib.waterCurtain());
      mesh.name = 'showers';
      mesh.renderOrder = 3;
      group.add(mesh);
    }
  }

  // неоновые вывески — одна текстура на слово, один меш на слово
  if (neonTexts.length) {
    const byWord = new Map();
    for (const nt of neonTexts) {
      const word = NEON_WORDS[(nt.i + nt.j) % NEON_WORDS.length];
      const d = [[0, -1], [1, 0], [0, 1], [-1, 0]][nt.rot];
      const g = new THREE.PlaneGeometry(2.6, 0.9);
      g.rotateY(Math.atan2(-d[0], -d[1]) + Math.PI);
      g.translate(nt.cx - d[0] * (cs / 2 - 0.06), nt.f + (nt.c - nt.f) * 0.58, nt.cz - d[1] * (cs / 2 - 0.06));
      if (!byWord.has(word)) byWord.set(word, []);
      byWord.get(word).push(g);
    }
    for (const [word, geos] of byWord) {
      const merged = mergeGeometries(geos);
      for (const g of geos) g.dispose();
      if (!merged) continue;
      const tex = makeNeonTexture(word);
      const mat = new THREE.MeshStandardMaterial({
        map: tex, emissiveMap: tex, emissive: new THREE.Color(0x8ef0ff), emissiveIntensity: 5.5,
        color: 0x000000, transparent: true, alphaMap: tex, depthWrite: false, side: THREE.DoubleSide
      });
      matlib._register(mat);
      const plane = new THREE.Mesh(merged, mat);
      plane.name = 'neon_' + word;
      plane.renderOrder = 2;
      group.add(plane);
    }
  }

  const bounds = new THREE.Box3(V(0, -20, 0), V(lv.w * cs, 30, lv.h * cs));

  return { group, waterGeom, lightSpecs, bounds, tileMats, bob };
}

// ---------------------------------------------------------------- слияние геометрий

function mergeGeometries(geos) {
  if (!geos.length) return null;
  let posCount = 0, idxCount = 0;
  for (const g of geos) {
    posCount += g.attributes.position.count;
    idxCount += g.index ? g.index.count : g.attributes.position.count;
  }
  const pos = new Float32Array(posCount * 3);
  const nrm = new Float32Array(posCount * 3);
  const uv = new Float32Array(posCount * 2);
  const idx = new Uint32Array(idxCount);
  let po = 0, io = 0, vo = 0;
  for (const g of geos) {
    const p = g.attributes.position.array, n = g.attributes.normal.array, u = g.attributes.uv?.array;
    pos.set(p, po * 3); nrm.set(n, po * 3);
    if (u) uv.set(u, po * 2);
    const gi = g.index ? g.index.array : null;
    const cnt = g.attributes.position.count;
    if (gi) { for (let i = 0; i < gi.length; i++) idx[io++] = gi[i] + po; }
    else { for (let i = 0; i < cnt; i++) idx[io++] = i + po; }
    po += cnt;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeBoundingSphere();
  return out;
}

// ---------------------------------------------------------------- арки и двери

// ---------------------------------------------------------------- арки, двери, окна

/**
 * Общая система координат проёма:
 *   along — направление прохода, side = along × up, P(s,y,t) = center + side*s + along*t.
 * При таком выборе normal(quad(O, +y, +side)) = +along, что даёт правильную
 * ориентацию граней для обеих осей поворота.
 */
function openingFrame(lv, i, j) {
  const cs = lv.cell;
  const k = j * lv.w + i;
  const rot = lv.r[k] % 2;
  const along = rot === 1 ? V(1, 0, 0) : V(0, 0, 1);
  const side = new THREE.Vector3().crossVectors(along, V(0, 1, 0));
  const cx = (i + 0.5) * cs, cz = (j + 0.5) * cs;
  return {
    cs, k, along, side, cx, cz, half: cs / 2,
    f: lv.f[k], c: lv.c[k],
    P: (s, y, t) => V(cx + side.x * s + along.x * t, y, cz + side.z * s + along.z * t)
  };
}

/** Прямоугольная панель на грани t = face*half, нормалью наружу. */
function facePanel(mesher, fr, s0, s1, y0, y1, face, aoFn) {
  const w = s1 - s0, h = y1 - y0;
  if (w < 0.005 || h < 0.005) return;
  const t = face * fr.half;
  const O = fr.P(face > 0 ? s0 : s1, y0, t);
  const W = fr.side.clone().multiplyScalar(w * face);
  mesher.quad(O, V(0, h, 0), W, Math.max(1, Math.round(h / 0.6)), Math.max(1, Math.round(w / 0.6)), aoFn);
}

function buildArch(lv, i, j, planarM, uvM, AO, isDoor, darkM) {
  const fr = openingFrame(lv, i, j);
  const { cs, f, c, half, P, side, along } = fr;
  const x0 = i * cs, z0 = j * cs;

  // пол и потолок проёма
  planarM.quad(V(x0, f, z0 + cs), V(cs, 0, 0), V(0, 0, -cs), 3, 3, AO.floor);
  planarM.quad(V(x0, c, z0), V(cs, 0, 0), V(0, 0, cs), 3, 3, AO.ceil);

  const H = c - f;
  const openW = isDoor ? Math.min(1.7, cs * 0.44) : Math.min(2.7, cs * 0.66);
  const radius = openW / 2;
  const springY = isDoor ? f + H * 0.88 : f + Math.min(H * 0.50, H - radius - 0.25);
  const topY = isDoor ? springY : springY + radius;

  // верхняя граница проёма как функция от s
  const holeTop = (s) => {
    if (Math.abs(s) >= radius - 1e-4) return f;              // нет проёма — стена от пола
    if (isDoor) return topY;
    const dy = Math.sqrt(Math.max(radius * radius - s * s, 0));
    return springY + dy;
  };

  const wallAO = (x, y, z, nx, ny, nz) => AO.wall(x, y, z, nx, nz, f, c);

  // лицевые грани: вертикальные полосы, нижняя кромка идёт по контуру проёма
  const N = isDoor ? 8 : 40, M = 4;
  for (const face of [-1, 1]) {
    const t = face * half;
    const base = planarM.count;
    const nrm = along.clone().multiplyScalar(face);
    for (let a = 0; a <= N; a++) {
      const s = -half + (a / N) * cs;
      const bot = holeTop(s);
      for (let m = 0; m <= M; m++) {
        const y = bot + (c - bot) * (m / M);
        const p = P(s, y, t);
        planarM.vertex(p, nrm, wallAO(p.x, p.y, p.z, nrm.x, nrm.y, nrm.z));
      }
    }
    const W = M + 1;
    for (let a = 0; a < N; a++) {
      for (let m = 0; m < M; m++) {
        const A = base + a * W + m, B = A + 1, C = A + W + 1, D = A + W;
        if (face > 0) planarM.index.push(A, B, C, A, C, D);
        else planarM.index.push(A, C, B, A, D, C);
      }
    }
  }

  // софит (внутренняя поверхность проёма) — с UV-развёрткой в метрах
  {
    const SEG = isDoor ? 1 : 26;
    const profile = [];
    if (isDoor) {
      profile.push([-radius, f, 1, 0], [-radius, topY, 1, 0], [radius, topY, -1, 0], [radius, f, -1, 0]);
      // нормали для горизонтальной перемычки
      profile[1] = [-radius, topY, 0, -1];
      profile[2] = [radius, topY, 0, -1];
      profile.splice(1, 0, [-radius, topY, 1, 0]);
      profile.splice(4, 0, [radius, topY, -1, 0]);
    } else {
      profile.push([-radius, f, 1, 0]);
      for (let a = 0; a <= SEG; a++) {
        const ang = Math.PI - (a / SEG) * Math.PI;
        profile.push([Math.cos(ang) * radius, springY + Math.sin(ang) * radius, -Math.cos(ang), -Math.sin(ang)]);
      }
      profile.push([radius, f, -1, 0]);
    }

    const base = uvM.count;
    let arc = 0;
    for (let a = 0; a < profile.length; a++) {
      const [s, y, ns, ny] = profile[a];
      if (a > 0) arc += Math.hypot(s - profile[a - 1][0], y - profile[a - 1][1]);
      const nrm = new THREE.Vector3(side.x * ns, ny, side.z * ns).normalize();
      for (let e = 0; e <= 1; e++) {
        const p = P(s, y, (e === 0 ? -1 : 1) * half);
        uvM.vertex(p, nrm, AO.wall(p.x, p.y, p.z, nrm.x, nrm.z, f, c), arc, e * cs);
      }
    }
    // winding: normal = cross(along, dProfile) — направлена внутрь проёма
    for (let a = 0; a < profile.length - 1; a++) {
      const a0 = base + a * 2, a1 = a0 + 1, b0 = a0 + 2, b1 = a0 + 3;
      uvM.index.push(a0, a1, b1, a0, b1, b0);
    }
  }

  // за дверью — непроглядная чернота
  if (isDoor && darkM) {
    const O = P(-radius + 0.03, f + 0.01, 0);
    const U = V(0, topY - f - 0.02, 0);
    const W = side.clone().multiplyScalar(openW - 0.06);
    darkM.quad(O, U, W, 1, 1, () => 1);
    darkM.quad(O.clone().add(W), U, W.clone().negate(), 1, 1, () => 1);
  }
}

function buildWindow(lv, i, j, planarM, AO, emissiveSpecs) {
  const fr = openingFrame(lv, i, j);
  const { cs, f, c, half, P, side, along, cx, cz } = fr;
  const H = c - f;
  const wallAO = (x, y, z, nx, ny, nz) => AO.wall(x, y, z, nx, nz, f, c);

  const SLOTS = 3;
  const slotW = 0.32;
  const slotBottom = f + H * 0.10;
  const slotTop = f + H * 0.86;
  const pitch = cs / SLOTS;
  const centers = [];
  for (let s = 0; s < SLOTS; s++) centers.push(-half + pitch * (s + 0.5));

  // сплошные участки стены между щелями
  const gaps = [];
  let cursor = -half;
  for (const ctr of centers) { gaps.push([cursor, ctr - slotW / 2]); cursor = ctr + slotW / 2; }
  gaps.push([cursor, half]);

  for (const face of [-1, 1]) {
    for (const [s0, s1] of gaps) facePanel(planarM, fr, s0, s1, f, c, face, wallAO);
    for (const ctr of centers) {
      facePanel(planarM, fr, ctr - slotW / 2, ctr + slotW / 2, f, slotBottom, face, wallAO);
      facePanel(planarM, fr, ctr - slotW / 2, ctr + slotW / 2, slotTop, c, face, wallAO);
    }
  }

  // откосы щелей (плоскости, параллельные проходу)
  const sh = slotTop - slotBottom;
  for (const ctr of centers) {
    for (const sgn of [-1, 1]) {
      const sPos = ctr + sgn * slotW / 2;
      // нормаль внутрь щели = -sgn * side  =>  quad(O, +y, W) с W = along * (-sgn) * cs
      const O = P(sPos, slotBottom, sgn > 0 ? half : -half);
      const W = along.clone().multiplyScalar(cs * -sgn);
      planarM.quad(O, V(0, sh, 0), W, 3, 3, () => 0.62);
    }
    // светящаяся вставка в глубине щели — читается как дневной свет снаружи
    emissiveSpecs.push({
      x: cx + side.x * ctr, y: (slotBottom + slotTop) / 2, z: cz + side.z * ctr,
      sx: Math.abs(side.x) > 0.5 ? slotW * 0.86 : 0.10,
      sy: sh * 0.98,
      sz: Math.abs(side.z) > 0.5 ? slotW * 0.86 : 0.10,
      color: 0xffffff, intensity: 3.0, shape: 'box'
    });
  }
}

// ---------------------------------------------------------------- лестницы

function buildStairs(lv, i, j, planarM, AO) {
  const cs = lv.cell;
  const k = j * lv.w + i;
  const rot = lv.r[k] % 4;
  const f = lv.f[k];
  const dirs = [[0, -1], [1, 0], [0, 1], [-1, 0]];
  const [dx, dz] = dirs[rot];
  const ni = i + dx, nj = j + dz;
  if (!isRoom(lv, ni, nj)) return;
  const target = lv.f[nj * lv.w + ni];
  if (Math.abs(target - f) < 0.05) return;

  const steps = Math.max(2, Math.round(Math.abs(target - f) / 0.19));
  const stepDepth = cs / steps;
  const x0 = i * cs, z0 = j * cs;

  for (let s = 0; s < steps; s++) {
    const y = f + (target - f) * ((s + 1) / steps);
    const t0 = s * stepDepth;
    // прямоугольная площадка ступени
    let O, U, W;
    if (dx === 1) { O = V(x0 + t0, y, z0 + cs); U = V(stepDepth, 0, 0); W = V(0, 0, -cs); }
    else if (dx === -1) { O = V(x0 + cs - t0 - stepDepth, y, z0 + cs); U = V(stepDepth, 0, 0); W = V(0, 0, -cs); }
    else if (dz === 1) { O = V(x0, y, z0 + t0 + stepDepth); U = V(cs, 0, 0); W = V(0, 0, -stepDepth); }
    else { O = V(x0, y, z0 + cs - t0); U = V(cs, 0, 0); W = V(0, 0, -stepDepth); }
    planarM.quad(O, U, W, 3, 2, AO.floor);

    // подступёнок
    const rise = (target - f) / steps;
    let RO, RU, RW;
    const yb = y - Math.abs(rise);
    if (dx === 1) { RO = V(x0 + t0, yb, z0); RU = V(0, Math.abs(rise), 0); RW = V(0, 0, cs); }
    else if (dx === -1) { RO = V(x0 + cs - t0, yb, z0 + cs); RU = V(0, Math.abs(rise), 0); RW = V(0, 0, -cs); }
    else if (dz === 1) { RO = V(x0 + cs, yb, z0 + t0); RU = V(0, Math.abs(rise), 0); RW = V(-cs, 0, 0); }
    else { RO = V(x0, yb, z0 + cs - t0); RU = V(0, Math.abs(rise), 0); RW = V(cs, 0, 0); }
    if (Math.abs(rise) > 0.02) planarM.quad(RO, RU, RW, 1, 3, () => 0.7);
  }
}

// ---------------------------------------------------------------- металл

function buildRailing(lv, i, j, metalM, rot) {
  const cs = lv.cell;
  const k = j * lv.w + i;
  const f = lv.f[k];
  const cx = (i + 0.5) * cs, cz = (j + 0.5) * cs;
  const along = rot % 2 === 0 ? V(1, 0, 0) : V(0, 0, 1);
  const h = 1.05;
  for (let p = -1; p <= 1; p++) {
    const x = cx + along.x * p * (cs / 2 - 0.2);
    const z = cz + along.z * p * (cs / 2 - 0.2);
    metalM.box(x, f + h / 2, z, 0.06, h, 0.06, () => 0.8, 2);
  }
  metalM.box(cx, f + h, cz, along.x ? cs : 0.05, 0.05, along.z ? cs : 0.05, () => 0.9, 2);
  metalM.box(cx, f + h * 0.55, cz, along.x ? cs : 0.04, 0.04, along.z ? cs : 0.04, () => 0.9, 2);
}

function buildLadder(cx, cz, topY, rot, metalM) {
  const dirs = [V(0, 0, -1), V(1, 0, 0), V(0, 0, 1), V(-1, 0, 0)];
  const d = dirs[rot % 4];
  const side = V(-d.z, 0, d.x);
  for (const s of [-1, 1]) {
    const ox = cx + side.x * s * 0.28, oz = cz + side.z * s * 0.28;
    const pts = [
      new THREE.Vector3(ox + d.x * 0.30, topY + 0.85, oz + d.z * 0.30),
      new THREE.Vector3(ox + d.x * 0.42, topY + 0.55, oz + d.z * 0.42),
      new THREE.Vector3(ox + d.x * 0.18, topY + 0.10, oz + d.z * 0.18),
      new THREE.Vector3(ox - d.x * 0.10, topY - 0.55, oz - d.z * 0.10),
      new THREE.Vector3(ox - d.x * 0.10, topY - 1.60, oz - d.z * 0.10)
    ];
    const curve = new THREE.CatmullRomCurve3(pts);
    tubeAlong(metalM, curve, 0.035, 8, 22, () => 0.85);
  }
  for (let r = 0; r < 3; r++) {
    const y = topY - 0.25 - r * 0.45;
    metalM.box(cx - d.x * 0.10, y, cz - d.z * 0.10,
      Math.abs(side.x) > 0.5 ? 0.60 : 0.05, 0.045,
      Math.abs(side.z) > 0.5 ? 0.60 : 0.05, () => 0.8, 4);
  }
}

// ---------------------------------------------------------------- пропы (отдельные меши)

function leafGeometry(len = 1.0, wid = 0.15, bend = 0.85, segs = 14, ribs = 5) {
  const pos = [], nrm = [], idx = [], uvs = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const y = len * t - bend * t * t * len * 0.38;
    const z = bend * t * t * len * 0.42;
    const w = wid * Math.pow(Math.sin(Math.pow(t, 0.42) * Math.PI), 0.62);
    for (let r = 0; r <= ribs; r++) {
      const u = r / ribs * 2 - 1;
      const x = u * w;
      const fold = -Math.abs(u) * w * 0.35;          // V-образный залом по центральной жилке
      pos.push(x, y + fold, z + Math.abs(u) * w * 0.12);
      nrm.push(0, 0, 1);
      uvs.push((u + 1) / 2, t);
    }
  }
  const W = ribs + 1;
  for (let i = 0; i < segs; i++) {
    for (let r = 0; r < ribs; r++) {
      const a = i * W + r, b = a + 1, c = a + W + 1, d = a + W;
      idx.push(a, b, c, a, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function makeSignTexture() {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 384;
  const g = c.getContext('2d');
  g.fillStyle = '#f4f5f2'; g.fillRect(0, 0, 512, 384);
  g.strokeStyle = '#2b3a44'; g.lineWidth = 8; g.strokeRect(10, 10, 492, 364);
  g.fillStyle = '#2b3a44';
  g.font = 'bold 54px Helvetica, Arial, sans-serif';
  g.textAlign = 'center';
  g.fillText('NOTICE', 256, 76);
  g.fillRect(120, 96, 272, 5);
  g.font = 'bold 34px Helvetica, Arial, sans-serif';
  const lines = ['NO SMOKING', 'NO DIVING', 'NO RUNNING'];
  lines.forEach((t, i) => {
    const y = 160 + i * 62;
    g.beginPath(); g.arc(120, y - 11, 22, 0, Math.PI * 2);
    g.strokeStyle = '#c0392b'; g.lineWidth = 7; g.stroke();
    g.beginPath(); g.moveTo(105, y - 26); g.lineTo(135, y + 4); g.stroke();
    g.fillStyle = '#2b3a44'; g.textAlign = 'left';
    g.fillText(t, 160, y);
  });
  g.textAlign = 'center';
  g.fillStyle = '#6c7a80';
  g.font = '22px Helvetica, Arial, sans-serif';
  g.fillText('IN THIS AREA', 256, 352);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/**
 * Пропы собираются в вёдра по материалам и сливаются в один меш на материал.
 * Раньше каждое растение давало ~15 отдельных мешей — сцена упиралась в draw call'ы.
 */
class PropBatcher {
  constructor(parent) {
    this.parent = parent;
    this.buckets = new Map();
    this._o = new THREE.Object3D();
  }
  /** matrix — мировая матрица размещения (или null для геометрии уже в мире) */
  add(geo, mat, matrix) {
    const g = matrix ? geo.clone().applyMatrix4(matrix) : geo.clone();
    let b = this.buckets.get(mat);
    if (!b) { b = []; this.buckets.set(mat, b); }
    b.push(g);
  }
  /** Быстрая сборка матрицы без создания Object3D на каждый вызов. */
  mat4(px, py, pz, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
    const o = this._o;
    o.position.set(px, py, pz);
    o.rotation.set(rx, ry, rz);
    o.scale.set(sx, sy, sz);
    o.updateMatrix();
    return o.matrix.clone();
  }
  flush(castShadow = true) {
    for (const [mat, geos] of this.buckets) {
      const merged = mergeGeometries(geos);
      for (const g of geos) g.dispose();
      if (!merged) continue;
      const mesh = new THREE.Mesh(merged, mat);
      mesh.castShadow = castShadow;
      mesh.receiveShadow = true;
      mesh.name = 'props_' + (mat.name || mat.type);
      this.parent.add(mesh);
    }
    this.buckets.clear();
  }
}

function buildProps(lv, matlib, parent, bob, lightSpecs, AO) {
  const cs = lv.cell;
  const wY = lv.waterY;
  const batch = new PropBatcher(parent);

  // --- общие материалы и геометрии, создаются по одному разу ---
  const leafGeos = [
    leafGeometry(1.05, 0.15, 0.90),
    leafGeometry(0.75, 0.11, 1.15, 12, 4),
    leafGeometry(1.35, 0.18, 0.70, 16, 6),
    leafGeometry(0.55, 0.055, 1.35, 10, 3)
  ];
  const foliageDark = matlib.foliage({ color: 0x27512c });
  const foliageMid = matlib.foliage({ color: 0x357a3a });
  const potMat = matlib.plastic(0xe6e7e2, 0.55);
  const soilMat = matlib.plastic(0x2a231c, 0.9);
  const plasticWhite = matlib.plastic(0xf3f4f0, 0.35);
  const woodMat = matlib.plastic(0xd8cbb0, 0.7);
  const ballMats = [matlib.plastic(0x2f4a3c, 0.25), matlib.plastic(0xe8eef0, 0.2), matlib.plastic(0xd8c96a, 0.3)];

  const POT_H = 0.5, POT_R = 0.42;
  const potGeo = new THREE.CylinderGeometry(POT_R, POT_R * 0.82, POT_H, 18);
  potGeo.translate(0, POT_H / 2, 0);
  const soilGeo = new THREE.CircleGeometry(POT_R * 0.92, 18);
  soilGeo.rotateX(-Math.PI / 2);
  soilGeo.translate(0, POT_H - 0.03, 0);

  const seatGeo = new THREE.BoxGeometry(0.46, 0.05, 0.44); seatGeo.translate(0, 0.44, 0);
  const backGeo = new THREE.BoxGeometry(0.46, 0.48, 0.05);
  backGeo.rotateX(-0.12); backGeo.translate(0, 0.68, -0.20);
  const legGeo = new THREE.BoxGeometry(0.04, 0.44, 0.04); legGeo.translate(0, 0.22, 0);
  const benchTopGeo = new THREE.BoxGeometry(1.8, 0.09, 0.45); benchTopGeo.translate(0, 0.45, 0);
  const benchLegGeo = new THREE.BoxGeometry(0.09, 0.45, 0.42); benchLegGeo.translate(0, 0.225, 0);

  let signMat = null;
  const signGeo = new THREE.BoxGeometry(0.9, 0.68, 0.04);

  const M = batch.mat4.bind(batch);
  const tmp = new THREE.Matrix4();

  for (let j = 0; j < lv.h; j++) {
    for (let i = 0; i < lv.w; i++) {
      const k = j * lv.w + i;
      const feat = lv.o[k];
      if (feat === FEAT.NONE) continue;
      if (lv.t[k] !== CELL.ROOM) continue;
      const cx = (i + 0.5) * cs, cz = (j + 0.5) * cs;
      const f = lv.f[k], c = lv.c[k];
      const rnd = ((i * 73856093) ^ (j * 19349663)) >>> 0;
      const rf = (n) => (((rnd >> (n * 3)) & 255) / 255);

      if (feat === FEAT.PLANT) {
        const px = cx + (rf(1) - 0.5) * 0.8, pz = cz + (rf(2) - 0.5) * 0.8;
        batch.add(potGeo, potMat, M(px, f, pz));
        batch.add(soilGeo, soilMat, M(px, f, pz));
        const n = 13 + Math.floor(rf(0) * 8);
        for (let l = 0; l < n; l++) {
          const sc = 0.65 + rf(l % 8) * 0.85;
          tmp.copy(M(
            px, f + POT_H - 0.05, pz,
            -0.10 - rf((l + 2) % 7) * 0.95,
            (l / n) * Math.PI * 2 + rf(l % 7) * 0.9,
            (rf((l + 3) % 7) - 0.5) * 0.5,
            sc, sc, sc
          ));
          batch.add(leafGeos[l % leafGeos.length], l % 2 ? foliageMid : foliageDark, tmp);
        }
      }

      else if (feat === FEAT.CHAIR) {
        const px = cx + (rf(1) - 0.5) * 1.4, pz = cz + (rf(2) - 0.5) * 1.4;
        const tipped = rf(4) > 0.75;
        const base = M(px, f + (tipped ? 0.42 : 0), pz, 0, rf(3) * Math.PI * 2, tipped ? Math.PI * 0.52 : 0);
        batch.add(seatGeo, plasticWhite, base);
        batch.add(backGeo, plasticWhite, base);
        for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
          tmp.copy(base).multiply(new THREE.Matrix4().makeTranslation(sx * 0.19, 0, sz * 0.18));
          batch.add(legGeo, plasticWhite, tmp);
        }
      }

      else if (feat === FEAT.BENCH) {
        const base = M(cx, f, cz, 0, (lv.r[k] % 4) * Math.PI / 2, 0);
        batch.add(benchTopGeo, woodMat, base);
        for (const s of [-1, 1]) {
          tmp.copy(base).multiply(new THREE.Matrix4().makeTranslation(s * 0.75, 0, 0));
          batch.add(benchLegGeo, plasticWhite, tmp);
        }
      }

      else if (feat === FEAT.SIGN) {
        if (!signMat) {
          signMat = new THREE.MeshStandardMaterial({ map: makeSignTexture(), roughness: 0.45, metalness: 0 });
          matlib._register(signMat);
        }
        batch.add(signGeo, signMat, M(cx, f + 1.85, cz, 0, (lv.r[k] % 4) * Math.PI / 2, 0));
      }

      else if (feat === FEAT.BALL) {
        // мячи покачиваются на воде — остаются отдельными объектами
        const r = 0.20 + rf(0) * 0.16;
        const ball = new THREE.Mesh(new THREE.SphereGeometry(r, 20, 14), ballMats[Math.floor(rf(1) * 3) % 3]);
        const y = (f < wY) ? wY - r * 0.35 : f + r;
        ball.position.set(cx + (rf(2) - 0.5) * 2.2, y, cz + (rf(3) - 0.5) * 2.2);
        ball.castShadow = true; ball.receiveShadow = true;
        parent.add(ball);
        if (f < wY) bob.push({ obj: ball, baseY: y, amp: 0.045, speed: 0.7 + rf(4) * 0.6, phase: rf(5) * 6.28, r });
      }

      else if (feat === FEAT.SLIDE) {
        const y0 = f + 3.4, y1 = Math.max(wY, f) + 0.2;
        const curve = new THREE.CatmullRomCurve3([
          new THREE.Vector3(cx - 1.4, y0, cz - 1.2),
          new THREE.Vector3(cx - 0.2, y0 - 0.9, cz + 0.6),
          new THREE.Vector3(cx + 1.3, y0 - 2.1, cz - 0.4),
          new THREE.Vector3(cx + 1.9, y1 + 0.5, cz + 1.4),
          new THREE.Vector3(cx + 1.2, y1, cz + 2.6)
        ]);
        batch.add(new THREE.TubeGeometry(curve, 48, 0.62, 14, false), matlib.slideTube(), null);
      }
    }
  }

  batch.flush();
  for (const g of [potGeo, soilGeo, seatGeo, backGeo, legGeo, benchTopGeo, benchLegGeo, signGeo, ...leafGeos]) g.dispose();
}
