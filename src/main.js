import * as THREE from 'three';

/* ------------------------------------------------------------------ *
 *  TUNING — tweak these to taste
 * ------------------------------------------------------------------ */
const ACCEL      = 15;      // engine accel (u/s^2)
const BRAKE      = 26;      // braking decel
const MAX_SPEED  = 30;      // top speed (u/s)
const MAX_REV    = 8;       // max reverse speed
const DRAG       = 0.55;    // per-second exponential drag
const OFF_DRAG   = 4.5;     // extra drag when off the asphalt
const OFF_GRIP   = 0.45;    // acceleration multiplier off track
const STEER_RATE = 2.7;     // base steering rate (rad/s @ full grip)
const MAX_VISUAL_STEER = 0.5; // max front-wheel yaw (rad) at full steer
const ROAD_HW    = 4.2;     // road half-width (u)
const CURB_W     = 0.9;     // curb strip width
const LAPS       = 3;
const WHEEL_R    = 0.34;
const CAM_DIST   = 7.5;
const CAM_HEIGHT = 3.3;
const N_SAMPLES  = 1000;    // track sampling resolution

// AI opponents: N_AI total, skill in [0..1] drives their pace/cornering
const N_AI         = 3;
const AI_SKILL     = [0.94, 0.90, 0.86];

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const P2D = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

/* ------------------------------------------------------------------ *
 *  Renderer / scene / lights
 * ------------------------------------------------------------------ */
const container = document.getElementById('app');
const renderer  = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x180f0a);
scene.fog = new THREE.Fog(0x180f0a, 130, 320);

const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 500);

scene.add(new THREE.HemisphereLight(0xfff2dd, 0x2a1a10, 0.85));

const sun = new THREE.DirectionalLight(0xfff0d8, 1.6);
sun.position.set(60, 90, -35);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -110;
sun.shadow.camera.right = 110;
sun.shadow.camera.top = 110;
sun.shadow.camera.bottom = -110;
sun.shadow.camera.near = 10;
sun.shadow.camera.far = 300;
sun.shadow.bias = -0.0008;
scene.add(sun, sun.target);

const fill = new THREE.DirectionalLight(0xbfd4ff, 0.35);
fill.position.set(-40, 30, 50);
scene.add(fill);

/* ------------------------------------------------------------------ *
 *  Procedural textures
 * ------------------------------------------------------------------ */
function woodTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 512;
  const g = c.getContext('2d');
  g.fillStyle = '#8a5a33'; g.fillRect(0, 0, 512, 512);
  for (let y = 0; y < 512; y += 64) {
    g.fillStyle = `rgba(30,15,5,${0.25 + Math.random() * 0.15})`;
    g.fillRect(0, y, 512, 3);
    for (let i = 0; i < 7; i++) {
      g.strokeStyle = `rgba(55,28,10,${0.06 + Math.random() * 0.14})`;
      g.lineWidth = 1 + Math.random() * 2;
      const yy = y + 4 + Math.random() * 56;
      g.beginPath();
      g.moveTo(0, yy);
      g.bezierCurveTo(128, yy + Math.random() * 10 - 5, 384, yy + Math.random() * 10 - 5, 512, yy);
      g.stroke();
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(12, 12);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function checkerTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  for (let x = 0; x < 8; x++)
    for (let y = 0; y < 8; y++) {
      g.fillStyle = (x + y) % 2 ? '#151515' : '#efefef';
      g.fillRect(x * 16, y * 16, 16, 16);
    }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function curbTexture() {
  const c = document.createElement('canvas'); c.width = 64; c.height = 8;
  const g = c.getContext('2d');
  g.fillStyle = '#d93a30'; g.fillRect(0, 0, 32, 8);
  g.fillStyle = '#f4f0ec'; g.fillRect(32, 0, 32, 8);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/* ------------------------------------------------------------------ *
 *  The table + track
 * ------------------------------------------------------------------ */
const table = new THREE.Mesh(
  new THREE.PlaneGeometry(420, 420),
  new THREE.MeshStandardMaterial({ map: woodTexture(), roughness: 0.92, metalness: 0 })
);
table.rotation.x = -Math.PI / 2;
table.position.y = -0.05;
table.receiveShadow = true;
scene.add(table);

const curve = new THREE.CatmullRomCurve3([
  [   0,    0],
  [  38,   -4],
  [  66,    8],
  [  74,   38],
  [  54,   60],
  [  30,   48],
  [  12,   64],
  [ -12,   48],
  [ -34,   60],
  [ -62,   46],
  [ -74,   18],
  [ -56,   -6],
  [ -28,  -14],
].map(([x, z]) => new THREE.Vector3(x, 0, z)), true, 'catmullrom', 0.5);

// even arc-length samples
const samples = [];
for (let i = 0; i < N_SAMPLES; i++) samples.push(curve.getPointAt(i / N_SAMPLES));
let trackLen = 0;
for (let i = 1; i < N_SAMPLES; i++) trackLen += samples[i].distanceTo(samples[i - 1]);

// sweep a ribbon along the curve
function buildRibbon(inner, outer, y, material) {
  const pos = [], uv = [], idx = [];
  for (let i = 0; i <= N_SAMPLES; i++) {
    const t = (i % N_SAMPLES) / N_SAMPLES;
    const p = curve.getPointAt(t);
    const tan = curve.getTangentAt(t);
    const nx = -tan.z, nz = tan.x; // perpendicular in XZ
    const il = (i % N_SAMPLES) / N_SAMPLES, iu = i / N_SAMPLES;
    pos.push(p.x + nx * inner, y, p.z + nz * inner);
    pos.push(p.x + nx * outer, y, p.z + nz * outer);
    uv.push(il, 0);
    uv.push(iu, 1);
  }
  for (let i = 0; i < N_SAMPLES; i++) {
    const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
    idx.push(a, b, c, b, d, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, material);
  m.receiveShadow = true;
  scene.add(m);
  return m;
}

const roadMat = new THREE.MeshStandardMaterial({ color: 0x2e2e33, roughness: 0.95, metalness: 0, side: THREE.DoubleSide });
buildRibbon(-ROAD_HW, ROAD_HW, 0.01, roadMat);

const curbMat = new THREE.MeshStandardMaterial({ map: curbTexture(), roughness: 0.85, side: THREE.DoubleSide });
curbMat.map.repeat.set(Math.round(trackLen / 6), 1);
buildRibbon(ROAD_HW, ROAD_HW + CURB_W, 0.005, curbMat);
buildRibbon(-ROAD_HW, -(ROAD_HW + CURB_W), 0.005, curbMat);

// start / finish line
const startP = samples[0];
const startT = samples[1].clone().sub(samples[0]).normalize();
const startHeading = Math.atan2(startT.x, startT.z);
const line = new THREE.Mesh(
  new THREE.PlaneGeometry(ROAD_HW * 2, 2.4),
  new THREE.MeshStandardMaterial({ map: checkerTexture(), roughness: 0.9 })
);
line.rotation.x = -Math.PI / 2;
line.rotation.z = startHeading;
line.position.set(startP.x, 0.02, startP.z);
line.receiveShadow = true;
scene.add(line);

/* ------------------------------------------------------------------ *
 *  Scattered "tabletop" props (decor only)
 * ------------------------------------------------------------------ */
const propMats = [0xf48fb1, 0xffcc80, 0x80d8ff, 0xc5e1a5, 0xfff176, 0xce93d8]
  .map(c => new THREE.MeshStandardMaterial({ color: c, roughness: 0.6 }));
const stickMat = new THREE.MeshStandardMaterial({ color: 0xf5f0e8, roughness: 0.8 });
const pencilMat = new THREE.MeshStandardMaterial({ color: 0xff8f00, roughness: 0.5 });

function scatterProps() {
  for (let attempt = 0; attempt < 20; attempt++) {
    const x = (Math.random() * 2 - 1) * 95;
    const z = (Math.random() * 2 - 1) * 85;
    let d = Infinity;
    for (let j = 0; j < N_SAMPLES; j += 3) {
      const dx = samples[j].x - x, dz = samples[j].z - z;
      const dd = dx * dx + dz * dz;
      if (dd < d) d = dd;
    }
    if (Math.sqrt(d) < ROAD_HW + 5) continue;

    const kind = Math.floor(Math.random() * 5);
    let obj;
    if (kind === 0) { // donut
      obj = new THREE.Mesh(new THREE.TorusGeometry(0.7, 0.28, 10, 24), propMats[attempt % propMats.length]);
      obj.rotation.x = Math.PI / 2;
      obj.position.set(x, 0.3, z);
    } else if (kind === 1) { // lollipop
      obj = new THREE.Group();
      const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 1.5, 8), stickMat);
      stick.position.y = 0.75;
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.55, 14, 12), propMats[(attempt + 2) % propMats.length]);
      head.position.y = 1.55;
      head.castShadow = stick.castShadow = true;
      obj.add(stick, head);
      obj.position.set(x, 0, z);
    } else if (kind === 2) { // block
      obj = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.6, 1.6), propMats[(attempt + 1) % propMats.length]);
      obj.position.set(x, 0.8, z);
      obj.rotation.y = Math.random() * Math.PI;
    } else if (kind === 3) { // gumdrop
      obj = new THREE.Mesh(new THREE.SphereGeometry(0.75, 14, 10), propMats[(attempt + 3) % propMats.length]);
      obj.scale.y = 0.68;
      obj.position.set(x, 0.5, z);
    } else { // pencil
      obj = new THREE.Group();
      const body = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 2.4, 10), pencilMat);
      const tip = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.5, 10), stickMat);
      tip.position.y = 1.45;
      body.castShadow = tip.castShadow = true;
      obj.add(body, tip);
      obj.rotation.z = Math.PI / 2;
      obj.rotation.x = Math.random() * Math.PI;
      obj.position.set(x, 0.25, z);
    }
    obj.traverse(n => { if (n.isMesh) { n.castShadow = true; n.receiveShadow = true; } });
    scene.add(obj);
  }
}
scatterProps();

/* ------------------------------------------------------------------ *
 *  The kart
 * ------------------------------------------------------------------ */
function makeKart(bodyColor, accentColor) {
  const root = new THREE.Group();
  const bodyGroup = new THREE.Group();
  root.add(bodyGroup);
  const bodyMat  = new THREE.MeshStandardMaterial({ color: bodyColor, roughness: 0.35, metalness: 0.15 });
  const accMat   = new THREE.MeshStandardMaterial({ color: accentColor, roughness: 0.4 });
  const darkMat  = new THREE.MeshStandardMaterial({ color: 0x23262b, roughness: 0.6 });
  const tireMat  = new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.9 });
  const addBox = (parent, w, h, d, x, y, z, mat) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    parent.add(m);
    return m;
  };
  addBox(bodyGroup, 1.7, 0.5, 1.6, 0, 0.78, -0.15, bodyMat);   // body
  addBox(bodyGroup, 1.2, 0.35, 0.9, 0, 0.72, 1.35, accMat);    // nose
  addBox(bodyGroup, 1.0, 0.5, 0.6, 0, 1.18, -0.55, darkMat);   // seat
  {
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 1.1, 8), darkMat);
    bar.geometry.rotateZ(Math.PI / 2);
    bar.position.set(0, 1.38, 0.5);
    bar.castShadow = true;
    bodyGroup.add(bar);
  }
  const wheels = [];
  const frontPivots = [];
  const wheelGeo = new THREE.CylinderGeometry(WHEEL_R, WHEEL_R, 0.32, 18);
  wheelGeo.rotateZ(Math.PI / 2); // axle along local X
  const addWheel = (x, z, front) => {
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(WHEEL_R * 0.5, WHEEL_R * 0.5, 0.34, 12), accMat);
    hub.geometry.rotateZ(Math.PI / 2);
    const wheel = new THREE.Mesh(wheelGeo, tireMat);
    wheel.castShadow = true;
    wheel.add(hub);
    if (front) {
      const g = new THREE.Group(); // steering pivot at wheel center
      g.position.set(x, WHEEL_R, z);
      wheel.position.set(0, 0, 0);
      g.add(wheel);
      root.add(g);
      frontPivots.push(g);
    } else {
      wheel.position.set(x, WHEEL_R, z);
      root.add(wheel);
    }
    wheels.push(wheel);
  };
  addWheel( 0.85,  1.05, true);
  addWheel(-0.85,  1.05, true);
  addWheel( 0.85, -1.05, false);
  addWheel(-0.85, -1.05, false);
  scene.add(root);
  return { root, bodyGroup, wheels, frontPivots };
}

/* ------------------------------------------------------------------ *
 *  Kart entity: integrates arcade driving physics along the track
 * ------------------------------------------------------------------ */
class Kart {
  constructor(opts) {
    this.isPlayer = !!opts.isPlayer;
    this.name = opts.name || (this.isPlayer ? 'YOU' : 'RIVALE');
    const color = opts.color || 0xe0392b;
    const accent = opts.accent ?? (((color >> 8) & 255) | 0x808080);
    this.mesh = makeKart(color, accent);
    this.pos = new THREE.Vector3();
    this.heading = 0;
    this.speed = 0;
    this.offRoad = false;
    this.lapDone = 0;
    this.lapStart = 0;
    this.lapTimes = [];
    this.hasMid = false;
    this.prevU = 0;
    this.raceDone = false;
    this.finalLapTime = 0;
    this.trackIdx = 0;
    this.steerVel = 0;
    this.wheelSpin = 0;
    this.posIdx = 0;
  }

  placeAt(t, offset) {
    const n = N_SAMPLES;
    const tt = ((t % 1) + 1) % 1;
    const i = Math.floor(tt * n) % n;
    const f = tt * n - i;
    const i1 = (i + 1) % n;
    const P = samples[i].clone().lerp(samples[i1], f);
    const T = samples[i1].clone().sub(samples[i]);
    const Nn = new THREE.Vector3(-T.z, 0, T.x).normalize();
    this.pos.copy(P).addScaledVector(Nn, offset);
    this.heading = Math.atan2(T.x, T.z);
    this.speed = 0;
    this.lapDone = 0;              // grid sits behind the line
    this.hasMid = false;
    this.prevU = tt;
    this.trackIdx = Math.floor(tt * n) % n;
    this.lapTimes = [];
    this.raceDone = false;
    this.steerVel = 0;
    this.posIdx = 0;
    this.lane = offset * 0.9;      // keep the grid side as a racing lane
    this.mesh.root.position.copy(this.pos);
    this.mesh.root.rotation.y = this.heading;
  }

  nearestTrack() {
    let best = -1, bd = Infinity;
    for (let o = -60; o <= 60; o++) {
      const i = (this.trackIdx + o + N_SAMPLES) % N_SAMPLES;
      const p = samples[i];
      const dx = p.x - this.pos.x, dz = p.z - this.pos.z;
      const d = dx * dx + dz * dz;
      if (d < bd) { bd = d; best = i; }
    }
    if (bd > 144) { // lost it — full search
      bd = Infinity;
      for (let i = 0; i < N_SAMPLES; i++) {
        const p = samples[i];
        const dx = p.x - this.pos.x, dz = p.z - this.pos.z;
        const d = dx * dx + dz * dz;
        if (d < bd) { bd = d; best = i; }
      }
    }
    this.trackIdx = best;
    this.offRoad = Math.sqrt(bd) > ROAD_HW - 0.5;
    return { u: best / N_SAMPLES, lat: Math.sqrt(bd) };
  }

  updateLapLogic(now) {
    const { u } = this.nearestTrack();
    if (u > 0.4 && u < 0.6) this.hasMid = true;
    if (this.prevU > 0.85 && u < 0.15) {
      if (this.hasMid) {
        const t = (now - this.lapStart) / 1000;
        this.lapDone++;
        if (this.lapDone >= LAPS) this.raceDone = true;
        this.lapTimes.push(t);
        this.finalLapTime = t;
        this.lapStart = now;
      }
      this.hasMid = false;
    } else if (this.prevU < 0.15 && u > 0.85) {
      this.hasMid = false; // crossed backwards
    }
    this.prevU = u;
  }

  step(dt, throttle, steerIn, now) {
    this.steerVel += (steerIn - this.steerVel) * Math.min(1, 12 * dt);
    const th = this.raceDone ? 0 : throttle;
    if (th > 0) this.speed += ACCEL * (this.offRoad ? OFF_GRIP : 1) * dt;
    else if (th < 0) this.speed -= (this.speed > 0 ? BRAKE : ACCEL * 0.7) * dt;
    this.speed -= this.speed * DRAG * dt;
    if (this.offRoad) this.speed -= Math.sign(this.speed) * Math.min(Math.abs(this.speed), OFF_DRAG * dt);
    this.speed = clamp(this.speed, -MAX_REV, MAX_SPEED);
    if (th === 0 && Math.abs(this.speed) < 0.03) this.speed = 0;
    this.heading += this.steerVel * STEER_RATE * turnFactor(this.speed) * (this.speed < 0 ? -1 : 1) * dt;
    this.pos.x += Math.sin(this.heading) * this.speed * dt;
    this.pos.z += Math.cos(this.heading) * this.speed * dt;
    if (!this.raceDone) this.updateLapLogic(now);
  }

  sync(dt) {
    this.mesh.root.position.copy(this.pos);
    this.mesh.root.rotation.y = this.heading;
    this.wheelSpin += this.speed * dt / WHEEL_R;
    for (const w of this.mesh.wheels) w.rotation.x = this.wheelSpin;
    for (const p of this.mesh.frontPivots) p.rotation.y = this.steerVel * MAX_VISUAL_STEER;
    const sp = Math.min(Math.abs(this.speed) / MAX_SPEED, 1);
    const rollT = this.steerVel * 0.22 * sp;
    const pitchT = (Math.abs(this.speed) > 0.5 ? -0.03 : 0) * (sp + 0.3);
    this.mesh.bodyGroup.rotation.z += (rollT - this.mesh.bodyGroup.rotation.z) * Math.min(1, 8 * dt);
    this.mesh.bodyGroup.rotation.x += (pitchT - this.mesh.bodyGroup.rotation.x) * Math.min(1, 6 * dt);
  }
}

/* ------------------------------------------------------------------ *
 *  Karts: the player + computer opponents
 * ------------------------------------------------------------------ */
const karts = [];
const player = new Kart({ isPlayer: true, color: 0xe0392b, accent: 0xf6c445 });
const ROSTER = [
  { color: 0x2e7dd1, name: 'AZURE' },
  { color: 0x39b17c, name: 'MATCHA' },
  { color: 0xd153f1, name: 'PLUMP' },
];
for (let i = 0; i < N_AI; i++) {
  karts.push(new Kart({ ...ROSTER[i], isPlayer: false, skill: AI_SKILL[i] }));
}
karts.push(player);

function resetKarts() {
  // 2x2 grid just behind the start/finish line
  const cells = [
    { u: 0.9925, o: -1.75 }, { u: 0.9925, o: +1.75 },
    { u: 0.985,  o: -1.75 }, { u: 0.985,  o: +1.75 },
  ];
  // grid order: strongest AI, player, then the rest
  const order = [karts[0], player, karts[1], karts[2]];
  order.forEach((k, i) => k.placeAt(cells[i].u, cells[i].o));
}

/* ------------------------------------------------------------------ *
 *  AI driver — follows the racing line, brakes for corners
 * ------------------------------------------------------------------ */
const _aiPt = new THREE.Vector3();
// precompute per-sample heading so the AI can read local curvature
const sampleHead = new Float32Array(N_SAMPLES);
for (let i = 0; i < N_SAMPLES; i++) {
  const A = samples[(i + N_SAMPLES - 1) % N_SAMPLES], B = samples[(i + 1) % N_SAMPLES];
  sampleHead[i] = Math.atan2(B.x - A.x, B.z - A.z);
}
const headingAt = t => sampleHead[Math.floor((((t % 1) + 1) % 1) * N_SAMPLES) % N_SAMPLES];
const angDiff = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
function curvatureAt(t) { // signed 1/u: rate of heading change per unit arc-length
  const w = 8 / trackLen; // half-window: ±8 u of arc
  return angDiff(headingAt(t + w), headingAt(t - w)) / 16;
}

function aiControl(k) {
  const skill = k.skill ?? 0.9;
  // rivals pace up over the race, but stay below top speed
  const maxSp = k.offRoad ? 8
    : Math.min(MAX_SPEED, 7 + 9.5 * skill + 2.6 * skill * k.lapDone); // u/s
  const grip = 6 + 7 * skill;                        // corner aptitude; v_corner = sqrt(grip/|K|)
  const margin = 1 + 1.1 * (1 - skill);              // weak drivers brake earlier

  // preferred lane, nudge away from whoever is right in front of us
  let lane = clamp(k.lane || 0, -(ROAD_HW - 1.6), ROAD_HW - 1.6);
  const myIdx = k.trackIdx;
  const hx = -Math.cos(sampleHead[myIdx]), hz = Math.sin(sampleHead[myIdx]); // "left of travel"
  for (const o of karts) {
    if (o === k) continue;
    const rel = angDiff(o.prevU, k.prevU);         // in-track progress of them vs us
    if (rel <= 0.002 || rel > 0.05) continue;      // only cars just AHEAD of us matter
    const relPos = _aiPt.copy(o.pos).sub(k.pos);
    const along = relPos.x * Math.sin(sampleHead[myIdx]) + relPos.z * Math.cos(sampleHead[myIdx]);
    if (along < 0.5 || along > 18) continue;
    const side = relPos.x * hx + relPos.z * hz;    // + = they're to our left
    if (Math.abs(side) < 3) lane -= Math.sign(side || 1) * Math.max(0, 4 - Math.abs(side)) * 0.6;
  }
  lane = clamp(lane, -(ROAD_HW - 1.6), ROAD_HW - 1.6);

  // 1) scan ahead for the fastest corner entry speed we can manage
  const horizon = (3 + 0.55 * k.speed) * (0.6 + 0.4 * skill); // u of track to look at
  let vNeed = Infinity;
  for (let s = 1; s <= 40; s++) {
    const K = curvatureAt(k.prevU + s * horizon / (trackLen * 40));
    if (K > 0.0004) {
      vNeed = Math.min(vNeed, Math.sqrt(grip / K) * margin);
      if (vNeed < maxSp * 0.3) break;
    }
  }
  vNeed = Math.min(vNeed, maxSp);
  const throttle = k.speed > vNeed + 0.5 ? -1 : k.speed < vNeed ? 1 : 0;

  // 2) aim down the racing line at the apex of the next corner
  const Kcur = Math.abs(curvatureAt(k.prevU + 0.01));
  const aAhead = 0.25 + 0.75 * Math.min(1, Kcur / 0.0022);
  const lt = k.prevU + (0.015 + 0.05 * aAhead);
  const it = Math.floor(((lt % 1) + 1) % 1 * N_SAMPLES) % N_SAMPLES;
  const P = _aiPt.copy(samples[it]);
  const Nx = -Math.cos(sampleHead[it]), Nz = Math.sin(sampleHead[it]); // "left of travel"
  P.x += Nx * lane; P.z += Nz * lane;
  const dTgt = Math.atan2(P.x - k.pos.x, P.z - k.pos.z);
  const err = Math.atan2(Math.sin(dTgt - k.heading), Math.cos(dTgt - k.heading));

  // lost the track? back up, then steer into the line
  const dp = P2D(k.pos, samples[k.trackIdx]);
  if (dp > ROAD_HW * 2.2) {
    if (Math.abs(err) > 0.6) return { throttle: -0.7, steer: Math.sign(err) }; // wrong way — reverse
    const ahead = samples[(k.trackIdx + 3) % N_SAMPLES];
    const da = Math.atan2(ahead.x - k.pos.x, ahead.z - k.pos.z);
    return { throttle: 0.9, steer: clamp(angDiff(da, k.heading) * 2.2, -1, 1) };
  }
  return { throttle, steer: clamp(err * 2.6, -1.5, 1.5) };
}

/* ------------------------------------------------------------------ *
 *  Input
 * ------------------------------------------------------------------ */
const keys = { up: false, down: false, left: false, right: false };
const KEYMAP = {
  KeyW: 'up', ArrowUp: 'up',
  KeyS: 'down', ArrowDown: 'down',
  KeyA: 'left', ArrowLeft: 'left',
  KeyD: 'right', ArrowRight: 'right',
};
addEventListener('keydown', e => {
  const k = KEYMAP[e.code];
  if (k) { keys[k] = true; e.preventDefault(); }
  if (e.code === 'Enter' || e.code === 'KeyR') primaryAction();
  if (e.code === 'Space') e.preventDefault();
});
addEventListener('keyup', e => {
  const k = KEYMAP[e.code];
  if (k) { keys[k] = false; e.preventDefault(); }
});
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

/* ------------------------------------------------------------------ *
 *  HUD
 * ------------------------------------------------------------------ */
const el = id => document.getElementById(id);
const overlay  = el('overlay');
const startBtn = el('startBtn');
const titleEl  = el('title');
const subEl    = el('subtitle');
const keysEl   = el('keys');
const footEl   = el('footnote');
const resultsEl = el('results');

function fmt(t) {
  if (t == null) return '--';
  const d = Math.floor(t * 10); // tenths, floored once
  const m = Math.floor(d / 600);
  const ss = String(Math.floor((d % 600) / 10)).padStart(2, '0');
  return m + ':' + ss + '.' + (d % 10);
}

/* ------------------------------------------------------------------ *
 *  Game state
 * ------------------------------------------------------------------ */
let state = 'menu';        // menu | countdown | racing | finished
const COUNTDOWN_MS = 3000;
let raceStart = 0, raceTime = 0, cdText = -1;
let raceOverAt = 0;
const camPos = new THREE.Vector3();
const camLook = new THREE.Vector3();
const _cdVec = new THREE.Vector3();

el('nCars').textContent = String(karts.length);

function showOverlay(title, subtitle, btn, keysVisible, footnote) {
  titleEl.textContent = title;
  subEl.textContent = subtitle;
  keysEl.style.display = keysVisible ? '' : 'none';
  footEl.textContent = footnote;
  startBtn.textContent = btn;
  overlay.classList.remove('hidden');
}
function hideOverlay() { overlay.classList.add('hidden'); }
function hideCountdown() {
  el('countdown').classList.remove('on', 'go');
  cdText = -1;
}

function startRace() {
  resetKarts();
  raceTime = 0;
  raceOverAt = 0;
  const now = performance.now();
  raceStart = now + COUNTDOWN_MS;
  for (const k of karts) k.lapStart = raceStart;
  state = 'countdown';
  cdText = -1;
  hideOverlay();
  hideCountdown();
  startBtn.blur();
  // snap camera behind the player kart
  const p = player, f = new THREE.Vector3(Math.sin(p.heading), 0, Math.cos(p.heading));
  camPos.copy(p.pos).addScaledVector(f, -CAM_DIST);
  camPos.y = CAM_HEIGHT;
  camLook.copy(p.pos);
  camera.position.copy(camPos);
  camera.lookAt(camLook);
  updateHud(0, 0);
}

function finishRace() {
  state = 'finished';
  hideCountdown();
  const best = player.lapDone > 0 ? Math.min(...player.lapTimes) : null;
  el('best').innerHTML = 'BEST <span class="val">' + fmt(best) + '</span>';
  const order = raceOrder();
  const rows = [];
  order.forEach((k, i) => {
    const nm = k.isPlayer ? 'YOU' : k.name;
    const lap = k.lapDone > 0 ? ' ' + fmt(k.lapTimes[k.lapTimes.length - 1]) : '';
    rows.push((i + 1) + '. ' + (k.isPlayer ? '<b>' + nm + '</b>' + lap : nm + lap));
  });
  const place = karts.indexOf(player) + 1;
  const placeMsg =
    place === 1 ? 'YOU WRECKED EVERYONE AROUND THE TABLE' :
    place === karts.length ? 'LAST PLACE ON THE DINNER TABLE' :
    'YOU FINISHED ' + place + ' OF ' + karts.length;
  showOverlay('RACE COMPLETE', placeMsg, 'RACE AGAIN', false, 'OR PRESS R');
  resultsEl.innerHTML = '<b>TOTAL ' + fmt(raceTime) + '</b> &nbsp;·&nbsp; BEST LAP <b>' +
    fmt(best) + '</b><div style="font-size:13px;letter-spacing:1px;margin-top:10px">' +
    rows.join(' &nbsp;&nbsp; ') + '</div>';
  resultsEl.style.display = '';
}

function primaryAction() {
  if (state === 'menu' || state === 'finished') startRace();
}

startBtn.addEventListener('click', () => { primaryAction(); startBtn.blur(); });

function updateHud(r, l) {
  const p = player;
  el('lap').textContent = 'LAP ' + Math.min(p.lapDone + 1, LAPS) + '/' + LAPS;
  el('time').textContent = fmt(r);
  el('laptime').textContent = fmt(l);
  el('speed').textContent = Math.round(Math.abs(p.speed) * 7);
  const best = p.lapDone ? Math.min(...p.lapTimes) : null;
  el('best').innerHTML = 'BEST <span class="val">' + (best == null ? '--' : fmt(best)) + '</span>';
  el('pos').textContent = String(p.posIdx || 1);
  el('pos').parentElement.classList.toggle('lead', p.posIdx === 1);
  el('warn').classList.toggle('on', p.offRoad && state === 'racing');
}

/* ------------------------------------------------------------------ *
 *  Race progress, positions & collisions
 * ------------------------------------------------------------------ */
function progress(k) {
  return k.lapDone + k.prevU;
}
function raceOrder() {
  return karts.slice().sort((a, b) => progress(b) - progress(a));
}
function refreshPositions() {
  const order = raceOrder();
  order.forEach((k, i) => { k.posIdx = i + 1; });
  return order;
}
function collideKarts() {
  for (let i = 0; i < karts.length; i++) {
    for (let j = i + 1; j < karts.length; j++) {
      const a = karts[i], b = karts[j];
      const dx = b.pos.x - a.pos.x, dz = b.pos.z - a.pos.z;
      const d2 = dx * dx + dz * dz;
      const min = 2.15;
      if (d2 < min * min && d2 > 1e-6) {
        const d = Math.sqrt(d2);
        const nx = dx / d, nz = dz / d;
        const push = (min - d) / 2 + 0.01;
        a.pos.x -= nx * push; a.pos.z -= nz * push;
        b.pos.x += nx * push; b.pos.z += nz * push;
        const va = Math.sin(a.heading) * a.speed * nx + Math.cos(a.heading) * a.speed * nz;
        const vb = Math.sin(b.heading) * b.speed * nx + Math.cos(b.heading) * b.speed * nz;
        const dv = vb - va;
        if (dv < 0) {
          const jimp = -0.58 * dv;
          a.speed -= Math.sin(a.heading) * jimp * 0.5 + Math.cos(a.heading) * jimp * 0.5;
          b.speed += Math.sin(b.heading) * jimp * 0.5 + Math.cos(b.heading) * jimp * 0.5;
          a.speed = clamp(a.speed, -MAX_REV, MAX_SPEED + 3);
          b.speed = clamp(b.speed, -MAX_REV, MAX_SPEED + 3);
        }
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 *  Driving
 * ------------------------------------------------------------------ */
function turnFactor(s) {
  const a = Math.abs(s);
  const grip = Math.min(a / 6, 1);                            // no turning while (nearly) still
  const calm = 1 - 0.3 * Math.min(a / MAX_SPEED, 1);          // less twitchy at speed
  return grip * calm;
}

/* ------------------------------------------------------------------ *
 *  Cameras
 * ------------------------------------------------------------------ */
function snapChaseCam(dt) {
  const p = player;
  const fx = Math.sin(p.heading), fz = Math.cos(p.heading);
  const target = _cdVec.set(p.pos.x - fx * CAM_DIST, CAM_HEIGHT, p.pos.z - fz * CAM_DIST);
  camPos.lerp(target, 1 - Math.exp(-7 * dt));
  camera.position.copy(camPos);
  camLook.lerp(_cdVec.set(p.pos.x + fx * 3.5, 0.9, p.pos.z + fz * 3.5), 1 - Math.exp(-7 * dt));
  camera.lookAt(camLook);
}

/* ------------------------------------------------------------------ *
 *  Main loop
 * ------------------------------------------------------------------ */
const clock = new THREE.Clock();
const menuLook = new THREE.Vector3(0, 0, 5);
let dt = 1 / 60;

function animate() {
  requestAnimationFrame(animate);
  dt = Math.min(clock.getDelta(), 0.05);
  const now = performance.now();

  if (state === 'menu') {
    const a = now * 0.00009;
    camera.position.set(Math.cos(a) * 105, 62, Math.sin(a) * 105 + 5);
    camera.lookAt(menuLook);
  } else if (state === 'countdown') {
    const remain = (raceStart - now) / 1000;
    const txt = remain <= 0 ? 'GO' : String(remain > 3 ? 3 : Math.ceil(remain - 1e-6));
    if (txt !== cdText) {
      cdText = txt;
      const c = el('countdown');
      c.textContent = txt;
      c.classList.add('on');
      c.classList.toggle('go', txt === 'GO');
    }
    if (now >= raceStart + 700) {
      state = 'racing';
      hideCountdown();
    }
  } else {
    // control + integrate every kart
    for (const k of karts) {
      let throttle, steerIn;
      if (k.isPlayer) {
        const racing = state === 'racing';
        throttle = racing ? (keys.up ? 1 : 0) - (keys.down ? 1 : 0) : 0;
        steerIn  = racing ? (keys.left ? 1 : 0) - (keys.right ? 1 : 0) : 0;
      } else if (state === 'racing') {
        const c = aiControl(k);
        throttle = c.throttle; steerIn = c.steer;
      } else {
        throttle = 0; steerIn = 0;
      }
      k.step(dt, throttle, steerIn, now);
    }
    collideKarts();
    if (state === 'racing') {
      refreshPositions();
      const finishedKarts = karts.filter(k => k.raceDone).length;
      if (player.raceDone === false && finishedKarts >= karts.length - 1 && raceOverAt === 0) {
        raceOverAt = now + 5000; // player still racing, rivals done — give it a moment
      }
      if (finishedKarts >= karts.length && raceOverAt === 0) raceOverAt = now + 1200;
    }
    for (const k of karts) k.sync(dt);
    raceTime = Math.max(0, (now - raceStart) / 1000);
    if (state !== 'finished') {
      updateHud(raceTime, Math.max(0, (now - player.lapStart) / 1000));
      snapChaseCam(dt);
    }
    if (state === 'racing' && (player.raceDone || (raceOverAt && now >= raceOverAt))) finishRace();
  }
  renderer.render(scene, camera);
}

animate();
