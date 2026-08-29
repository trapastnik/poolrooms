/**
 * Праздничный мод: включается кнопкой и наряжает всё вокруг — колпаки на
 * монстрах и чужих игроках, тортики вместо кустов на дне, надписи «С ДНЁМ
 * РОЖДЕНИЯ, МИРОН!» по залу и мелодия Happy Birthday фоном.
 *
 * Держится в стороне от игрового кода: ничего не ломает, при выключении снимает
 * все украшения и глушит музыку. Мелодия играет в СВОЁМ AudioContext, чтобы не
 * лезть в звуковой тракт игры с его подводным фильтром и порядком узлов.
 */
import * as THREE from 'three';

const SIGN_TEXT = 'С ДНЁМ РОЖДЕНИЯ, МИРОН!';

// ---- колпак: полосатый конус с помпоном ----
function makeHat() {
  const g = new THREE.Group();
  const cone = new THREE.Mesh(
    new THREE.ConeGeometry(0.17, 0.36, 12),
    new THREE.MeshStandardMaterial({ color: 0xff4fa3, roughness: 0.5, emissive: 0x5a1030, emissiveIntensity: 0.6 }));
  cone.position.y = 0.18;
  g.add(cone);
  const band = new THREE.Mesh(
    new THREE.TorusGeometry(0.16, 0.03, 6, 16),
    new THREE.MeshStandardMaterial({ color: 0x4cc9ff, roughness: 0.4, emissive: 0x0a3550, emissiveIntensity: 0.7 }));
  band.rotation.x = Math.PI / 2; band.position.y = 0.03;
  g.add(band);
  const pom = new THREE.Mesh(
    new THREE.SphereGeometry(0.05, 8, 6),
    new THREE.MeshStandardMaterial({ color: 0xffe74c, roughness: 0.4, emissive: 0x6a5a10, emissiveIntensity: 0.8 }));
  pom.position.y = 0.38;
  g.add(pom);
  g.rotation.z = 0.18;              // чуть набекрень — так веселее
  g.traverse(o => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
  return g;
}

// ---- тортик: корж, глазурь, свечка с огоньком ----
function makeCake() {
  const g = new THREE.Group();
  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(0.26, 0.28, 0.22, 16),
    new THREE.MeshStandardMaterial({ color: 0xf6d7a0, roughness: 0.7 }));
  base.position.y = 0.11; g.add(base);
  const cream = new THREE.Mesh(
    new THREE.CylinderGeometry(0.28, 0.26, 0.06, 16),
    new THREE.MeshStandardMaterial({ color: 0xff8fc7, roughness: 0.5, emissive: 0x40142c, emissiveIntensity: 0.4 }));
  cream.position.y = 0.24; g.add(cream);
  const candle = new THREE.Mesh(
    new THREE.CylinderGeometry(0.02, 0.02, 0.16, 6),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4 }));
  candle.position.y = 0.35; g.add(candle);
  const flame = new THREE.Mesh(
    new THREE.ConeGeometry(0.04, 0.1, 6),
    new THREE.MeshStandardMaterial({ color: 0xffd23a, emissive: 0xffa000, emissiveIntensity: 2.4, roughness: 0.3 }));
  flame.position.y = 0.47; g.add(flame);
  g.userData.flame = flame;
  g.traverse(o => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
  return g;
}

// ---- надпись на «плакате» ----
function makeSign() {
  const c = document.createElement('canvas');
  c.width = 1280; c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(10,6,20,0.82)';
  roundRect(g, 8, 8, c.width - 16, c.height - 16, 28); g.fill();
  g.lineWidth = 8; g.strokeStyle = '#ff4fa3';
  roundRect(g, 8, 8, c.width - 16, c.height - 16, 28); g.stroke();
  // Подбираем размер шрифта, чтобы вся надпись влезла с полями, — иначе длинный
  // текст обрезался краями холста.
  const maxW = c.width - 120;
  let size = 108;
  do {
    g.font = `700 ${size}px Inter, "Segoe UI", system-ui, sans-serif`;
    if (g.measureText(SIGN_TEXT).width <= maxW) break;
    size -= 4;
  } while (size > 40);
  g.textAlign = 'center'; g.textBaseline = 'middle';
  const grad = g.createLinearGradient(0, 0, c.width, 0);
  grad.addColorStop(0, '#ffe74c'); grad.addColorStop(0.5, '#4cc9ff'); grad.addColorStop(1, '#ff8fc7');
  g.fillStyle = grad;
  g.fillText(SIGN_TEXT, c.width / 2, c.height / 2 + 6);
  const tex = new THREE.CanvasTexture(c);
  tex.minFilter = THREE.LinearFilter; tex.magFilter = THREE.LinearFilter;
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false }));
  spr.scale.set(5.25, 1.05, 1);      // держим пропорцию холста 1280×256 (5:1)
  spr.renderOrder = 25;
  return spr;
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}

export class Birthday {
  constructor(engine) {
    this.engine = engine;
    this.active = false;
    this.decorated = new Set();     // меши, на которые повесили колпак
    this.cakes = new THREE.Group();
    this.signs = new THREE.Group();
    this._t = 0;
    this._audio = null;
    this._musicTimer = null;
  }

  toggle(on, state) {
    if (on === this.active) return;
    if (on) this.enable(state); else this.disable(state);
  }

  enable(state) {
    this.active = true;
    const scene = this.engine.scene;
    if (!this.cakes.parent) scene.add(this.cakes);
    if (!this.signs.parent) scene.add(this.signs);
    this._placeSigns(state);
    if (state?.monsters?.pickups?.plant) state.monsters.pickups.plant.mesh.visible = false;   // кусты прячем — вместо них тортики
    this._startMusic();
  }

  disable(state) {
    this.active = false;
    for (const mesh of this.decorated) {
      const hat = mesh.userData._bhat;
      if (hat) { mesh.remove(hat); disposeTree(hat); mesh.userData._bhat = null; }
    }
    this.decorated.clear();
    clearGroup(this.cakes);
    clearGroup(this.signs);
    if (state?.monsters?.pickups?.plant) state.monsters.pickups.plant.mesh.visible = true;
    this._stopMusic();
  }

  /** Плакаты по всем залам уровня, вразброс. Спрайт сам смотрит на игрока,
   *  поэтому надпись читается из любого зала. */
  _placeSigns() {
    clearGroup(this.signs);
    const lv = this.engine.level, grid = this.engine.grid;
    if (!lv || !grid) return;

    const cells = [];
    for (let j = 1; j < lv.h - 1; j++) {
      for (let i = 1; i < lv.w - 1; i++) {
        if (grid.isOpen(i, j)) cells.push({ x: (i + 0.5) * grid.cs, z: (j + 0.5) * grid.cs });
      }
    }
    // перемешиваем и берём точки не ближе minDist друг к другу — чтобы плакаты
    // не толпились, а расходились по всей карте.
    for (let k = cells.length - 1; k > 0; k--) { const r = (Math.random() * (k + 1)) | 0; [cells[k], cells[r]] = [cells[r], cells[k]]; }
    const minDist = 9, picked = [];
    for (const c of cells) {
      if (picked.length >= 18) break;
      if (picked.some(p => Math.hypot(p.x - c.x, p.z - c.z) < minDist)) continue;
      picked.push(c);
    }
    for (const c of picked) {
      const s = makeSign();
      const y = Math.min(2.6, Math.max(1.8, grid.ceilAt(c.x, c.z) - 0.6));   // не втыкаем в потолок
      s.position.set(c.x, y, c.z);
      s.userData.baseY = y;
      this.signs.add(s);
    }
  }

  /** Повесить колпак на макушку меша (по верху его геометрии), если ещё нет. */
  _hat(mesh) {
    if (!mesh || mesh.userData._bhat) return;
    const geo = mesh.geometry;
    if (geo && !geo.boundingBox) geo.computeBoundingBox();
    const topY = geo?.boundingBox ? geo.boundingBox.max.y : 1.8;
    const hat = makeHat();
    hat.position.set(0, topY + 0.12, 0);
    mesh.add(hat);
    mesh.userData._bhat = hat;
    this.decorated.add(mesh);
  }

  update(dt, state) {
    if (!this.active) return;
    this._t += dt;

    // колпаки на всех, у кого есть меш: локальные монстры, серверные, чужие игроки
    const m = state.monsters;
    if (m) {
      for (const c of m.list) this._hat(c.mesh);
      if (m.server) for (const s of m.server.values()) this._hat(s.mesh);
    }
    if (state.net?.peers) for (const p of state.net.peers.values()) this._hat(p.mesh);
    // если меш исчез (монстр умер) — забываем про него, дочерний колпак ушёл вместе с ним
    for (const mesh of this.decorated) if (!mesh.parent) this.decorated.delete(mesh);

    // тортики на местах кустов (растений)
    const plants = m?.pickups?.plant?.items || [];
    while (this.cakes.children.length < plants.length) this.cakes.add(makeCake());
    for (let i = 0; i < this.cakes.children.length; i++) {
      const cake = this.cakes.children[i];
      if (i < plants.length) {
        cake.visible = true;
        cake.position.copy(plants[i].p);
        cake.rotation.y = this._t * 0.6;
        const fl = cake.userData.flame;
        if (fl) { fl.material.emissiveIntensity = 2.0 + Math.sin(this._t * 12 + i) * 0.8; fl.scale.setScalar(0.9 + Math.sin(this._t * 9 + i) * 0.15); }
      } else cake.visible = false;
    }

    // плакаты слегка покачиваются вокруг своей высоты
    for (let i = 0; i < this.signs.children.length; i++) {
      const s = this.signs.children[i];
      s.position.y = (s.userData.baseY || 2.6) + Math.sin(this._t * 1.5 + i) * 0.12;
    }
  }

  // ---- мелодия Happy Birthday в отдельном контексте ----
  _startMusic() {
    if (this._audio) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this._audio = ctx;
    const master = ctx.createGain();
    master.gain.value = 0.18;
    master.connect(ctx.destination);
    this._master = master;

    // Happy Birthday: [частота Гц, длительность долей]. 0 — пауза.
    const G4 = 392, A4 = 440, B4 = 493.88, C5 = 523.25, D5 = 587.33, E5 = 659.25, F5 = 698.46, G5 = 783.99;
    const mel = [
      [G4, 0.75], [G4, 0.25], [A4, 1], [G4, 1], [C5, 1], [B4, 2],
      [G4, 0.75], [G4, 0.25], [A4, 1], [G4, 1], [D5, 1], [C5, 2],
      [G4, 0.75], [G4, 0.25], [G5, 1], [E5, 1], [C5, 1], [B4, 1], [A4, 2],
      [F5, 0.75], [F5, 0.25], [E5, 1], [C5, 1], [D5, 1], [C5, 2.5]
    ];
    const beat = 0.42;
    const play = () => {
      if (!this._audio) return;
      let t = ctx.currentTime + 0.08;
      for (const [f, d] of mel) {
        const dur = d * beat;
        if (f) {
          const osc = ctx.createOscillator(); osc.type = 'triangle'; osc.frequency.value = f;
          const g = ctx.createGain();
          g.gain.setValueAtTime(0.0001, t);
          g.gain.exponentialRampToValueAtTime(1, t + 0.03);
          g.gain.exponentialRampToValueAtTime(0.0001, t + dur * 0.92);
          osc.connect(g); g.connect(master);
          osc.start(t); osc.stop(t + dur);
        }
        t += dur;
      }
      // повтор после проигрыша плюс небольшая пауза
      const total = (mel.reduce((s, n) => s + n[1], 0) * beat + 0.9) * 1000;
      this._musicTimer = setTimeout(play, total);
    };
    ctx.resume?.();
    play();
  }

  _stopMusic() {
    if (this._musicTimer) { clearTimeout(this._musicTimer); this._musicTimer = null; }
    if (this._audio) { try { this._audio.close(); } catch (_) { /* уже закрыт */ } this._audio = null; }
  }

  dispose() { this.disable(); }
}

function clearGroup(group) {
  for (let i = group.children.length - 1; i >= 0; i--) {
    const ch = group.children[i];
    group.remove(ch);
    disposeTree(ch);
  }
}

function disposeTree(obj) {
  obj.traverse?.(o => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) { o.material.map?.dispose?.(); o.material.dispose?.(); }
  });
  if (obj.material) { obj.material.map?.dispose?.(); obj.material.dispose?.(); }
}
