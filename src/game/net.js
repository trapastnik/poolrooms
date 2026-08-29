/**
 * Сетевая игра: свои координаты — наверх, чужие — вниз, и рисуем остальных.
 *
 * Своим движением по-прежнему управляет клиент, сервер только раздаёт снимки.
 * Поэтому чужие игроки приходят пачками ~15 раз в секунду, а рисовать надо
 * каждый кадр: между снимками интерполируем и намеренно отстаём на INTERP_MS,
 * иначе на любой сетевой заминке чужие будут дёргаться.
 *
 * Комната — название уровня: кто в «Затопленном вестибюле», видит таких же.
 */
import * as THREE from 'three';

const SEND_HZ = 15;
const INTERP_MS = 120;       // на столько отстаём от последнего снимка
const GONE_MS = 5000;        // не приходил дольше — убираем из сцены
const RETRY_MS = 4000;

/**
 * Палитра на шесть мест: цвета подобраны яркими и заведомо различимыми между
 * собой. Вычисляемый оттенок по номеру давал соседние тона, которые в мутной
 * воде и полумраке сливались, — здесь такого не будет.
 */
// Восемь заведомо различимых оттенков — по числу мест в комнате. Хью раскиданы
// по кругу без соседних тонов, чтобы в мутной воде и полумраке цвета не сливались.
const PALETTE = ['#ff5a5a', '#ffb02e', '#ffe74c', '#5ce65c', '#4cc9ff', '#c77dff', '#2ee6c0', '#ff5ecb'];
const colorHex = (id) => PALETTE[(Math.max(1, id) - 1) % PALETTE.length];
const colorFor = (id) => new THREE.Color(colorHex(id));

/** Табличка с ником: рисуем в канву и вешаем спрайтом над головой. */
function makeNameTexture(name, hex) {
  const FONT = '600 44px Inter, "Segoe UI", system-ui, sans-serif';
  const measure = document.createElement('canvas').getContext('2d');
  measure.font = FONT;
  const w = Math.ceil(measure.measureText(name).width);

  const c = document.createElement('canvas');
  c.width = Math.min(512, Math.max(96, w + 44));
  c.height = 76;
  const g = c.getContext('2d');
  g.font = FONT;                       // шрифт задаём после размера: смена размера сбрасывает контекст
  g.textAlign = 'center';
  g.textBaseline = 'middle';

  const r = 16, W = c.width, H = c.height;
  g.beginPath();
  g.moveTo(r, 0); g.lineTo(W - r, 0); g.quadraticCurveTo(W, 0, W, r);
  g.lineTo(W, H - r); g.quadraticCurveTo(W, H, W - r, H);
  g.lineTo(r, H); g.quadraticCurveTo(0, H, 0, H - r);
  g.lineTo(0, r); g.quadraticCurveTo(0, 0, r, 0);
  g.closePath();
  g.fillStyle = 'rgba(6,14,17,0.74)';
  g.fill();
  g.strokeStyle = hex;
  g.lineWidth = 4;
  g.stroke();

  g.fillStyle = '#eafeff';
  g.fillText(name, W / 2, H / 2 + 2);

  const tex = new THREE.CanvasTexture(c);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.aspect = W / H;
  return tex;
}

/** Аватар: намеренно не похож на долговязого, чтобы не путать с тварью. */
function buildAvatarGeo() {
  const parts = [];
  const add = (geo, x, y, z) => {
    geo.translate(x, y, z);
    parts.push(geo.toNonIndexed());
  };
  add(new THREE.CapsuleGeometry(0.26, 0.72, 3, 8), 0, 1.0, 0);   // корпус
  add(new THREE.SphereGeometry(0.21, 10, 8), 0, 1.68, 0);        // голова
  add(new THREE.BoxGeometry(0.1, 0.1, 0.22), 0, 1.68, -0.2);     // «взгляд»

  let n = 0;
  for (const g of parts) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3);
  let o = 0;
  for (const g of parts) {
    g.computeVertexNormals();
    pos.set(g.attributes.position.array, o * 3);
    nrm.set(g.attributes.normal.array, o * 3);
    o += g.attributes.position.count;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  out.computeBoundingSphere();
  return out;
}

export { colorHex };

export class Net {
  constructor(engine) {
    this.engine = engine;
    this.enabled = false;
    this.status = 'выключена';
    this.selfId = 0;
    this.max = 8;
    this.count = 0;
    this.ws = null;
    this.room = '';
    this.name = '';
    this.peers = new Map();          // id → { mesh, from, to, at, name, health }
    this.host = 0;                   // id ведущего: он решает, когда начинать
    this.started = false;
    this.lobby = [];                 // [{id, name}] — кто уже в комнате
    this.group = new THREE.Group();
    this.geo = null;
    this._sendAcc = 0;
    this._retryAt = 0;
    this.levelJson = null;           // уровень для сервера (общие монстры)
    this.diff = 'normal';
    this.events = {
      joined: null, left: null, full: null, lobby: null,
      // общие монстры: снимок мира и адресные события от сервера
      world: null, hurt: null, oxy: null, heal: null, knock: null, artifactPick: null,
      growl: null, annihilate: null
    };
  }

  /** Ведём ли мы: только ведущий может начать игру. */
  get isHost() { return this.selfId && this.selfId === this.host; }

  /** Начать, не дожидаясь остальных. Сервер проверит, что просит ведущий. */
  start() {
    if (this.ws && this.ws.readyState === 1 && this.isHost && !this.started) {
      this.ws.send(JSON.stringify({ t: 'start' }));
    }
  }

  url() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${location.host}/ws/`;
  }

  connect(room, name) {
    this.room = room || 'общий';
    this.name = name || 'без имени';
    this.enabled = true;
    this._open();
  }

  /** Бросок приманки в сети: сервер владеет ею, шлём точку и направление. */
  sendLure(eyePos, dir) {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify({
        t: 'lure', p: [eyePos.x, eyePos.y, eyePos.z], d: [dir.x, dir.y, dir.z]
      }));
    }
  }

  _open() {
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return;
    this.status = 'подключаюсь';
    let ws;
    try { ws = new WebSocket(this.url()); } catch (_) { this.status = 'нет связи'; return; }
    this.ws = ws;

    ws.onopen = () => {
      this.status = 'вхожу';
      ws.send(JSON.stringify({ t: 'join', room: this.room, name: this.name }));
    };
    ws.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch (_) { return; }
      if (m.t === 'welcome') {
        this.selfId = m.id;
        this.max = m.max || 6;
        this.host = m.host || 0;
        this.started = !!m.started;
        this.status = 'в сети';
        if (!this.group.parent) this.engine.scene.add(this.group);
        (m.players || []).forEach(p => this._upsert(p));
        // отдаём серверу уровень — с него он строит общих монстров
        if (this.levelJson) ws.send(JSON.stringify({ t: 'level', level: this.levelJson, diff: this.diff }));
        this.events.joined?.();
      } else if (m.t === 'w') {
        const seen = new Set();
        for (const p of m.players || []) { this._upsert(p); seen.add(p.id); }
        for (const [id, peer] of this.peers) {
          if (!seen.has(id) && performance.now() - peer.at > GONE_MS) this._remove(id);
        }
        this.count = this.peers.size + 1;
      } else if (m.t === 'lobby') {
        this.host = m.host || 0;
        this.started = !!m.started;
        this.max = m.max || this.max;
        this.lobby = m.players || [];
        this.count = this.lobby.length;
        this.events.lobby?.(this);
      } else if (m.t === 'left') {
        this._remove(m.id);
        this.count = this.peers.size + 1;
        this.events.left?.();
      } else if (m.t === 'off') {
        this.status = 'сетевая игра выключена на сервере';
        this.enabled = false;
        this.events.full?.(this.max, 'off');
      } else if (m.t === 'noroom') {
        this.status = `нет свободных комнат (предел ${m.maxRooms})`;
        this.enabled = false;
        this.events.full?.(this.max, 'noroom');
      } else if (m.t === 'full') {
        this.status = `мест нет (максимум ${m.max})`;
        this.enabled = false;
        this.events.full?.(m.max);
      } else if (m.t === 'world') {
        this.events.world?.(m);                 // снимок общих монстров
      } else if (m.t === 'hurt') {
        this.events.hurt?.(m.dmg);
      } else if (m.t === 'oxy') {
        this.events.oxy?.(m.d);
      } else if (m.t === 'heal') {
        this.events.heal?.(m.hp, m.air);
      } else if (m.t === 'knock') {
        this.events.knock?.(m.v);
      } else if (m.t === 'artifact') {
        this.events.artifactPick?.();
      } else if (m.t === 'growl') {
        this.events.growl?.(m.p);
      } else if (m.t === 'annihilate') {
        this.events.annihilate?.(m.p);
      }
    };
    ws.onclose = () => {
      this.ws = null;
      this._clear();
      if (this.enabled) {
        this.status = 'переподключаюсь';
        this._retryAt = performance.now() + RETRY_MS;
      } else this.status = 'выключена';
    };
    ws.onerror = () => { this.status = 'ошибка связи'; };
  }

  disconnect() {
    this.enabled = false;
    this.status = 'выключена';
    if (this.ws) { try { this.ws.close(); } catch (_) { /* уже закрыт */ } }
    this.ws = null;
    this._clear();
    this.count = 0;
  }

  _clear() {
    for (const id of [...this.peers.keys()]) this._remove(id);
    this.host = 0;
    this.started = false;
    this.lobby = [];
  }

  _remove(id) {
    const peer = this.peers.get(id);
    if (!peer) return;
    const tag = peer.mesh.children[0];
    if (tag) { tag.material.map?.dispose(); tag.material.dispose(); }
    this.group.remove(peer.mesh);
    peer.mesh.material.dispose();
    this.peers.delete(id);
  }

  /** Новый снимок чужого игрока: прошлую позицию помним, к новой поедем плавно. */
  _upsert(p) {
    let peer = this.peers.get(p.id);
    if (!peer) {
      if (!this.geo) this.geo = buildAvatarGeo();
      const col = colorFor(p.id);
      const mat = new THREE.MeshStandardMaterial({
        color: col, roughness: 0.55, metalness: 0.0,
        // подсвечиваем сами себя: в тёмных залах силуэт иначе теряется
        emissive: col.clone().multiplyScalar(0.55), emissiveIntensity: 1
      });
      const mesh = new THREE.Mesh(this.geo, mat);
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      this.group.add(mesh);

      // Ник над головой. depthTest выключен намеренно: в лабиринте главное —
      // понимать, где свои, поэтому таблички видны и сквозь стены.
      const tex = makeNameTexture(p.name || 'без имени', colorHex(p.id));
      const tag = new THREE.Sprite(new THREE.SpriteMaterial({
        map: tex, transparent: true, depthTest: false, depthWrite: false
      }));
      tag.scale.set(0.34 * tex.aspect, 0.34, 1);
      tag.position.set(0, 2.15, 0);
      tag.renderOrder = 20;
      mesh.add(tag);
      peer = {
        mesh, name: p.name, health: p.health,
        from: { x: p.p[0], y: p.p[1], z: p.p[2], yaw: p.y },
        to: { x: p.p[0], y: p.p[1], z: p.p[2], yaw: p.y },
        at: performance.now(), prevAt: performance.now()
      };
      this.peers.set(p.id, peer);
    } else {
      peer.from = { ...peer.to };
      peer.to = { x: p.p[0], y: p.p[1], z: p.p[2], yaw: p.y };
      peer.prevAt = peer.at;
      peer.at = performance.now();
      if (p.name !== peer.name) {
        peer.name = p.name;
        const tag = peer.mesh.children[0];
        if (tag) {
          tag.material.map.dispose();
          const tex = makeNameTexture(p.name || 'без имени', colorHex(p.id));
          tag.material.map = tex;
          tag.scale.set(0.34 * tex.aspect, 0.34, 1);
        }
      }
      peer.health = p.health;
    }
  }

  /** Отправить своё состояние и подвинуть чужих. Зовётся каждый кадр. */
  update(dt, player) {
    if (!this.enabled) return;
    if (!this.ws && performance.now() > this._retryAt) this._open();

    this._sendAcc += dt;
    if (this.ws && this.ws.readyState === 1 && this._sendAcc >= 1 / SEND_HZ) {
      this._sendAcc = 0;
      const r = (v) => Math.round(v * 100) / 100;    // сотые доли метра хватает
      this.ws.send(JSON.stringify({
        t: 's',
        p: [r(player.pos.x), r(player.pos.y), r(player.pos.z)],
        y: r(player.yaw), pi: r(player.pitch),
        m: player.mode, h: r(player.health)
      }));
    }

    // рисуем чужих с отставанием: между снимками интерполируем
    const now = performance.now() - INTERP_MS;
    for (const peer of this.peers.values()) {
      const span = Math.max(1, peer.at - peer.prevAt);
      const k = Math.max(0, Math.min(1, (now - peer.prevAt) / span));
      const m = peer.mesh;
      m.position.set(
        peer.from.x + (peer.to.x - peer.from.x) * k,
        peer.from.y + (peer.to.y - peer.from.y) * k,
        peer.from.z + (peer.to.z - peer.from.z) * k);
      let d = peer.to.yaw - peer.from.yaw;
      while (d > Math.PI) d -= Math.PI * 2;          // через ±180° не крутим кругом
      while (d < -Math.PI) d += Math.PI * 2;
      m.rotation.y = peer.from.yaw + d * k;
    }
  }

  dispose() {
    this.disconnect();
    if (this.group.parent) this.group.parent.remove(this.group);
    this.geo?.dispose();
    this.geo = null;
  }
}
