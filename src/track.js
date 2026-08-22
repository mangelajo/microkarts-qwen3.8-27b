import * as THREE from 'three';
import { N_SAMPLES, ROAD_HW, CURB_W } from './config.js';
import { scene } from './scene.js';
import { woodTexture, checkerTexture, curbTexture } from './textures.js';

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

export const curve = new THREE.CatmullRomCurve3([
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
export const samples = [];
for (let i = 0; i < N_SAMPLES; i++) samples.push(curve.getPointAt(i / N_SAMPLES));
export let trackLen = 0;
for (let i = 1; i < N_SAMPLES; i++) trackLen += samples[i].distanceTo(samples[i - 1]);

// per-sample heading so the AI can read local curvature
export const sampleHead = new Float32Array(N_SAMPLES);
for (let i = 0; i < N_SAMPLES; i++) {
  const A = samples[(i + N_SAMPLES - 1) % N_SAMPLES], B = samples[(i + 1) % N_SAMPLES];
  sampleHead[i] = Math.atan2(B.x - A.x, B.z - A.z);
}
export const headingAt = t => sampleHead[Math.floor((((t % 1) + 1) % 1) * N_SAMPLES) % N_SAMPLES];
export const angDiff = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
export function curvatureAt(t) { // signed 1/u: rate of heading change per unit arc-length
  const w = 8 / trackLen; // half-window: ±8 u of arc
  return angDiff(headingAt(t + w), headingAt(t - w)) / 16;
}

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
