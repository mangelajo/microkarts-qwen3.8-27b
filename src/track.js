import * as THREE from 'three';
import { N_SAMPLES, ROAD_HW, CURB_W } from './config.js';
import { scene, sun, hemi, fill } from './scene.js';
import { woodTexture, checkerTexture, curbTexture } from './textures.js';
import { TRACKS, trackTheme } from './tracks.js';
import { retintSky } from './sky.js';
import { buildObstacles, obstacleList, getObstaclesOn, HAZ_COLOR } from './obstacles.js';
import { buildPads, padList, CELL_LEN, CELL_W, GAP, CELLS } from './pads.js';

/* ------------------------------------------------------------------ *
 *  Track data — filled IN PLACE by buildTrack().
 *  kart.js / ai-sim hold live bindings to these, so rebuilding a track
 *  keeps every consumer working without re-importing anything.
 * ------------------------------------------------------------------ */
export const samples = [];
for (let i = 0; i < N_SAMPLES; i++) samples.push(new THREE.Vector3());
export let trackLen = 0;
export const sampleHead = new Float32Array(N_SAMPLES);

export const headingAt = t => sampleHead[Math.floor((((t % 1) + 1) % 1) * N_SAMPLES) % N_SAMPLES];
export const angDiff = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
export function curvatureAt(t) { // signed 1/u: rate of heading change per unit arc-length
  const w = 8 / trackLen; // half-window: ±8 u of arc
  return angDiff(headingAt(t + w), headingAt(t - w)) / 16;
}

/* ------------------------------------------------------------------ *
 *  The table — built once; its wood is re-painted per track theme
 * ------------------------------------------------------------------ */
let table = null;
function setTableWood(base) {
  const tex = woodTexture(base);
  if (!table) {
    table = new THREE.Mesh(
      new THREE.PlaneGeometry(420, 420),
      new THREE.MeshStandardMaterial({ map: tex, roughness: 0.92, metalness: 0 }),
    );
    table.rotation.x = -Math.PI / 2;
    table.position.y = -0.05;
    table.receiveShadow = true;
    scene.add(table);
  } else {
    table.material.map.dispose();
    table.material.map = tex;
    table.material.needsUpdate = true;
  }
}

/* ------------------------------------------------------------------ *
 *  buildTrack(def) — (re)build curve data + visible meshes + palette.
 *  def = { name, points, theme } from tracks.js
 * ------------------------------------------------------------------ */
const group = new THREE.Group(); // swappable: road, curbs, start line, props
scene.add(group);
let curve = null;
let prevMats = [];
let propMats = [];

// live "current track" record — mutate the fields, keep the reference stable
export const current = { name: '', theme: '' };

const stickMat = new THREE.MeshStandardMaterial({ color: 0xf5f0e8, roughness: 0.8 });
const pencilMat = new THREE.MeshStandardMaterial({ color: 0xff8f00, roughness: 0.5 });

function buildRibbon(parent, c, inner, outer, y, material) {
  const pos = [], uv = [], idx = [];
  for (let i = 0; i <= N_SAMPLES; i++) {
    const t = (i % N_SAMPLES) / N_SAMPLES;
    const p = c.getPointAt(t);
    const tan = c.getTangentAt(t);
    const nx = -tan.z, nz = tan.x; // perpendicular in XZ
    const il = (i % N_SAMPLES) / N_SAMPLES, iu = i / N_SAMPLES;
    pos.push(p.x + nx * inner, y, p.z + nz * inner);
    pos.push(p.x + nx * outer, y, p.z + nz * outer);
    uv.push(il, 0);
    uv.push(iu, 1);
  }
  for (let i = 0; i < N_SAMPLES; i++) {
    const a = i * 2, b = a + 1, c2 = a + 2, d = a + 3;
    idx.push(a, b, c2, b, d, c2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, material);
  m.receiveShadow = true;
  parent.add(m);
  return m;
}

function scatterProps(parent) {
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
    parent.add(obj);
  }
}

/* ------------------------------------------------------------------ *
 *  Sugar hazards — candy that karts must swerve around. The collision
 *  field is built deterministically per track in obstacles.js; this only
 *  draws the meshes, which live on the track group so they swap + dispose
 *  with every rebuild. No-op when hazards are off.
 * ------------------------------------------------------------------ */
let hazardMats = null; // persistent: ring + base + per-kind body, like propMats
function ensureHazardMats() {
  if (hazardMats) return hazardMats;
  const ring = new THREE.MeshStandardMaterial({ color: 0x241008, emissive: 0xff5a1e, emissiveIntensity: 0.85, roughness: 0.6 });
  const base = new THREE.MeshStandardMaterial({ color: 0x140f0a, roughness: 0.95 });
  const body = {};
  for (const [kind, c] of Object.entries(HAZ_COLOR)) {
    body[kind] = new THREE.MeshStandardMaterial({ color: c, roughness: 0.32, metalness: 0.15 });
  }
  hazardMats = { ring, base, body };
  return hazardMats;
}

function hazardGeo(kind) {
  return ({
    gumdrop:    new THREE.ConeGeometry(0.9, 1.8, 14),
    lolly:      new THREE.SphereGeometry(0.42, 14, 12),
    gumball:    new THREE.SphereGeometry(0.6, 16, 14),
    jawbreaker: new THREE.IcosahedronGeometry(0.9, 0),
    dice:       new THREE.BoxGeometry(1.5, 1.5, 1.5),
    bean:       new THREE.CapsuleGeometry(0.55, 1.0, 6, 12),
  })[kind] ?? new THREE.SphereGeometry(0.7, 14, 12); // fresh each build: group dispose handles it
}

function scatterHazardMeshes(parent) {
  const m = ensureHazardMats();
  for (const o of obstacleList) {
    const body = new THREE.Group();
    body.position.set(o.x, 0, o.z);
    body.rotation.y = o.rot;

    const geo = hazardGeo(o.kind);
    const mesh = new THREE.Mesh(geo, m.body[o.kind]);
    const s = o.r / (o.kind === 'gumdrop' ? 0.9 : o.kind === 'dice' ? 0.75 : 0.62);
    mesh.scale.setScalar(s);
    if (o.kind === 'gumdrop') mesh.position.y = o.r * 0.9;             // tip up, base on the table
    else if (o.kind === 'lolly') mesh.position.y = o.r * 1.6;         // candy head (stick below)
    else if (o.kind === 'bean') { mesh.rotation.z = Math.PI / 2; mesh.position.y = o.r * 0.6; }
    else mesh.position.y = o.r * 0.9;
    mesh.castShadow = mesh.receiveShadow = true;
    body.add(mesh);
    if (o.kind === 'lolly') {
      const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, o.r * 1.6, 8), m.base);
      stick.position.y = o.r * 0.8; stick.castShadow = true;
      body.add(stick);
    }
    // a dark base disc + a glowing ring telegraph the hazard (reads as "careful")
    const ring = new THREE.Mesh(new THREE.TorusGeometry(o.r + 0.35, 0.08, 8, 28), m.ring);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.02; ring.receiveShadow = true;
    body.add(ring);
    const baseM = new THREE.Mesh(new THREE.CylinderGeometry(o.r * 0.55, o.r * 0.7, 0.12, 16), m.base);
    baseM.position.y = 0.06; baseM.receiveShadow = true;
    body.add(baseM);

    parent.add(body);
  }
}

/* ------------------------------------------------------------------ *
 *  Boost pads — glowing chevron strips on the straights. The field
 *  (cells + chain hits) lives in pads.js; this only draws it. One plane
 *  per strip, canvas chevrons pointing along the direction of travel.
 * ------------------------------------------------------------------ */
let padMat = null;   // persistent across rebuilds, like hazardMats
function ensurePadMat() {
  if (padMat) return padMat;
  if (typeof document === 'undefined') return null;   // headless (ai-sim)
  const c = document.createElement('canvas'); c.width = 64; c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(255, 200, 60, 0.14)';           // soft underlay
  g.fillRect(9, 10, 46, 236);
  g.strokeStyle = 'rgba(255, 216, 80, 0.95)';
  g.lineWidth = 7; g.lineJoin = 'round'; g.lineCap = 'round';
  g.shadowColor = 'rgba(255, 170, 40, 0.9)'; g.shadowBlur = 10;
  for (let i = 0; i < CELLS; i++) {                   // chevrons point "up" = forward
    const yc = 46 + i * 82;
    g.beginPath(); g.moveTo(14, yc + 24); g.lineTo(32, yc); g.lineTo(50, yc + 24); g.stroke();
  }
  padMat = new THREE.MeshBasicMaterial({
    map: new THREE.CanvasTexture(c),
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
  });
  return padMat;
}

function scatterPads(parent) {
  const mat = ensurePadMat();
  if (!mat || !padList.length) return;
  const stripLen = CELLS * CELL_LEN + (CELLS - 1) * GAP;
  for (const p of padList) {
    if (p.cell !== 1) continue;      // middle cell of each strip = its centre
    const gNode = new THREE.Group();
    gNode.position.set(p.x, 0.018, p.z);
    gNode.rotation.y = p.h;
    const pl = new THREE.Mesh(new THREE.PlaneGeometry(CELL_W + 0.4, stripLen), mat);
    pl.rotation.x = Math.PI / 2;     // canvas "up" -> local +z = travel direction
    pl.renderOrder = 1;
    gNode.add(pl);
    parent.add(gNode);
  }
}

export function buildTrack(def, index = 0) {
  const pts = def.points.map(([x, z]) => new THREE.Vector3(x, 0, z));
  curve = new THREE.CatmullRomCurve3(pts, true, 'catmullrom', 0.5);

  // --- data: refill in place so live bindings stay valid ---
  trackLen = 0;
  for (let i = 0; i < N_SAMPLES; i++) samples[i].copy(curve.getPointAt(i / N_SAMPLES));
  for (let i = 1; i < N_SAMPLES; i++) trackLen += samples[i].distanceTo(samples[i - 1]);
  for (let i = 0; i < N_SAMPLES; i++) {
    const A = samples[(i + N_SAMPLES - 1) % N_SAMPLES], B = samples[(i + 1) % N_SAMPLES];
    sampleHead[i] = Math.atan2(B.x - A.x, B.z - A.z);
  }

  // --- visible: swap the track group's contents (dispose old) ---
  while (group.children.length) {
    const c = group.children.pop();
    c.traverse(n => { if (n.isMesh) n.geometry.dispose(); });
  }
  if (!propMats.length) {
    propMats = [0xf48fb1, 0xffcc80, 0x80d8ff, 0xc5e1a5, 0xfff176, 0xce93d8]
      .map(c => new THREE.MeshStandardMaterial({ color: c, roughness: 0.6 }));
  }

  const th = trackTheme(def);
  const builtMats = [];
  const trackMat = m => { builtMats.push(m); return m; };

  const roadMat = trackMat(new THREE.MeshStandardMaterial({ color: th.road, roughness: 0.95, metalness: 0, side: THREE.DoubleSide }));
  buildRibbon(group, curve, -ROAD_HW, ROAD_HW, 0.01, roadMat);

  const curbMat = trackMat(new THREE.MeshStandardMaterial({ map: curbTexture(), roughness: 0.85, side: THREE.DoubleSide }));
  curbMat.map.repeat.set(Math.round(trackLen / 6), 1);
  buildRibbon(group, curve, ROAD_HW, ROAD_HW + CURB_W, 0.005, curbMat);
  buildRibbon(group, curve, -ROAD_HW, -(ROAD_HW + CURB_W), 0.005, curbMat);

  // start / finish line
  const startP = samples[0];
  const startT = samples[1].clone().sub(samples[0]).normalize();
  const startHeading = Math.atan2(startT.x, startT.z);
  const line = new THREE.Mesh(
    new THREE.PlaneGeometry(ROAD_HW * 2, 2.4),
    trackMat(new THREE.MeshStandardMaterial({ map: checkerTexture(), roughness: 0.9 }))
  );
  line.rotation.x = -Math.PI / 2;
  line.rotation.z = startHeading;
  line.position.set(startP.x, 0.02, startP.z);
  line.receiveShadow = true;
  group.add(line);

  scatterProps(group);
  buildObstacles(index);          // deterministic hazard field for sim + AI (per track)
  if (getObstaclesOn()) scatterHazardMeshes(group);   // visuals only when hazards are on
  buildPads(index);               // boost-pad strips (deterministic; pads.js holds the hits)
  scatterPads(group);

  // dispose the previous build's per-track materials (shared prop mats persist)
  for (const m of prevMats) m.dispose();
  prevMats = builtMats;

  // --- palette: fog/sky, lights, table wood ---
  scene.fog?.color.set(th.fog);
  scene.background?.set(th.fog);
  retintSky(scene, th.sky);
  if (sun) sun.intensity = th.light.sun;
  if (hemi) hemi.intensity = th.light.hemi;
  if (fill) fill.intensity = th.light.fill;
  setTableWood(th.wood);

  // --- remember the current track ---
  current.name = def.name;
  current.theme = def.theme;

  return { trackLen, name: def.name, points: def.points.length };
}

// eager build of the first track so imported data (samples etc.) is valid
// the moment track.js loads (browser AND ai-sim); main.js re-builds the
// user's persisted choice at boot.
buildTrack(TRACKS[0], 0);
export function selectTrack(idx) {
  const def = TRACKS[((idx % TRACKS.length) + TRACKS.length) % TRACKS.length];
  return buildTrack(def, idx);
}
