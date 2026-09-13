// Per-theme scenery (built per track, seeded so host + every client get the
// identical field). Purely cosmetic: zero physics, nothing rides the wire,
// headless-safe (all scene work is on the faked scene).
//   cavern — a low dark ceiling + neon crystal clusters + hanging candy
//   storm  — a sea-painted table (see setTableWood in track.js), floating
//            buoys and a lighthouse with a rotating beacon
import * as THREE from 'three';
import { scene } from './scene.js';
import { samples } from './track.js';
import { N_SAMPLES } from './config.js';
import { mulberry32 } from './obstacles.js';

let crystals = [];   // { mat, ph } — emissive pulse
let beacon = null;   // the rotating lighthouse light cone
let buoys = [];      // { obj, ph } — bobbing
let added = [];      // scenery objects added to the scene (for cleanup)

export function buildScenery(theme, index) {
  clearScenery();
  if (theme === 'cavern') buildCavern(index);
  else if (theme === 'storm') buildStorm(index);
}

function clearScenery() {
  for (const o of added) {
    o.traverse(n => { if (n.isMesh) n.geometry.dispose(); });
    scene.remove(o);
  }
  added = [];
  crystals = [];
  beacon = null;
  buoys = [];
}

const tag = obj => { obj.userData = { scenery: true }; added.push(obj); return obj; };

/* ---------------- CANDY CAVERN ------------------------------------------ */
const NEON = [0x00e5ff, 0xff3df5, 0xa3ff42, 0xffd21e, 0x426bff];

function buildCavern(index) {
  const rng = mulberry32((0x9e7c15a3 ^ Math.imul(index + 11, 3405733215)) >>> 0);
  // the low ceiling
  const ceil = new THREE.Mesh(
    new THREE.PlaneGeometry(420, 420),
    new THREE.MeshStandardMaterial({ color: 0x12101e, roughness: 0.95, side: THREE.DoubleSide }),
  );
  ceil.rotation.x = Math.PI / 2;
  ceil.position.y = 11;
  scene.add(tag(ceil));
  // neon crystal clusters + hanging candy, seeded along the racing line
  for (let i = 0; i < N_SAMPLES; i += 60) {
    if (rng() > 0.6) continue;
    const s = samples[i];
    const side = rng() > 0.5 ? 1 : -1;
    const off = 6.5 + rng() * 4;
    const h = Math.atan2(
      samples[(i + 1) % N_SAMPLES].x - s.x,
      samples[(i + 1) % N_SAMPLES].z - s.z,
    );
    const p = new THREE.Vector3(-Math.cos(h), 0, Math.sin(h)).multiplyScalar(off * side).add(s);
    const kind = rng();
    if (kind < 0.5) {
      // crystal cluster: 3–5 glowing icosahedra
      const n = 3 + Math.floor(rng() * 3);
      const c = NEON[Math.floor(rng() * NEON.length)];
      for (let k = 0; k < n; k++) {
        const m = new THREE.MeshStandardMaterial({
          color: c, emissive: c, emissiveIntensity: 0.9, roughness: 0.3,
        });
        const mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(0.5 + rng() * 0.6, 0), m);
        mesh.position.set(p.x + (rng() - 0.5) * 2.4, 2 + rng() * 3, p.z + (rng() - 0.5) * 2.4);
        mesh.rotation.set(rng() * 3, rng() * 3, rng() * 3);
        scene.add(tag(mesh));
        crystals.push({ mat: m, ph: rng() * 6.28 });
      }
    } else {
      // hanging candy: a stick from the ceiling + a glowing ball
      const stick = new THREE.Mesh(
        new THREE.CylinderGeometry(0.08, 0.08, 11 - 5.2),
        new THREE.MeshStandardMaterial({ color: 0xd8d0e8, roughness: 0.6 }),
      );
      stick.position.set(p.x, (11 + 5.2) / 2, p.z);
      scene.add(tag(stick));
      const c = NEON[Math.floor(rng() * NEON.length)];
      const m = new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: 0.8, roughness: 0.3 });
      const ball = new THREE.Mesh(new THREE.SphereGeometry(0.9, 16, 12), m);
      ball.position.set(p.x, 4.3, p.z);
      scene.add(tag(ball));
      crystals.push({ mat: m, ph: rng() * 6.28 });
    }
  }
}

/* ---------------- STORM HARBOUR ---------------------------------------- */
function buildStorm(index) {
  const rng = mulberry32((0x5c1a79b3 ^ Math.imul(index + 13, 3405733215)) >>> 0);
  // floating buoys around the racing line
  for (let i = 0; i < N_SAMPLES; i += 72) {
    if (rng() > 0.75) continue;
    const s = samples[i];
    const side = rng() > 0.5 ? 1 : -1;
    const off = 8 + rng() * 6;
    const h = Math.atan2(
      samples[(i + 1) % N_SAMPLES].x - s.x,
      samples[(i + 1) % N_SAMPLES].z - s.z,
    );
    const p = new THREE.Vector3(-Math.cos(h), 0, Math.sin(h)).multiplyScalar(off * side).add(s);
    const buoy = new THREE.Group();
    const cone = new THREE.Mesh(
      new THREE.ConeGeometry(0.55, 1.3, 12),
      new THREE.MeshStandardMaterial({ color: 0xd94f3a, roughness: 0.5 }),
    );
    cone.position.y = 0.75;
    const band = new THREE.Mesh(
      new THREE.CylinderGeometry(0.57, 0.57, 0.3, 12),
      new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.5 }),
    );
    band.position.y = 0.5;
    buoy.add(cone, band);
    buoy.position.set(p.x, 0.05, p.z);
    scene.add(tag(buoy));
    buoys.push({ obj: buoy, ph: rng() * 6.28 });
  }
  // the lighthouse, on a rock at the harbour's edge
  const lh = new THREE.Group();
  const rock = new THREE.Mesh(
    new THREE.CylinderGeometry(4.5, 5.5, 2.4, 14),
    new THREE.MeshStandardMaterial({ color: 0x3a4750, roughness: 0.95 }),
  );
  rock.position.y = 1.2;
  const tower = new THREE.Mesh(
    new THREE.CylinderGeometry(1.4, 2.0, 9, 14),
    new THREE.MeshStandardMaterial({ color: 0xe8e4da, roughness: 0.6 }),
  );
  tower.position.y = 6.9;
  const cap = new THREE.Mesh(
    new THREE.ConeGeometry(2.0, 2.2, 14),
    new THREE.MeshStandardMaterial({ color: 0xb8402e, roughness: 0.5 }),
  );
  cap.position.y = 12.6;
  // the rotating beacon: a glowing cone + a small light sphere
  beacon = new THREE.Group();
  const beam = new THREE.Mesh(
    new THREE.ConeGeometry(0.55, 7, 10, 1, true),
    new THREE.MeshBasicMaterial({ color: 0xfff2b0, transparent: true, opacity: 0.5, side: THREE.DoubleSide }),
  );
  beam.rotation.x = Math.PI / 2;
  beam.position.x = 3.5;
  const bulb = new THREE.Mesh(
    new THREE.SphereGeometry(0.7, 12, 10),
    new THREE.MeshStandardMaterial({ color: 0xfff6c8, emissive: 0xfff2b0, emissiveIntensity: 1.4 }),
  );
  beacon.add(beam, bulb);
  beacon.position.y = 10.8;
  lh.add(rock, tower, cap, beacon);
  // outside the racing line, on the harbour's edge
  let bd = 1e9, best = 0;
  for (let i = 0; i < N_SAMPLES; i++) {
    const s = samples[i];
    if (s.x > 90 && s.z < -5) {
      const d = (s.x - 125) * (s.x - 125) + (s.z + 95) * (s.z + 95);
      if (d < bd) { bd = d; best = i; }
    }
  }
  const s = samples[best];
  lh.position.set(Math.min(125, s.x + 22), 0, Math.max(-120, s.z - 22));
  scene.add(tag(lh));
}

/* ---------------- animation --------------------------------------------- */
export function tickScenery(t) {
  for (const c of crystals) c.mat.emissiveIntensity = 0.7 + 0.45 * Math.sin(t * 2 + c.ph);
  if (beacon) beacon.rotation.y = t * 1.4;
  for (const b of buoys) b.obj.position.y = 0.05 + 0.16 * Math.sin(t * 1.7 + b.ph);
}
