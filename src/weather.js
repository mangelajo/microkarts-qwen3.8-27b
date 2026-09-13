// Weather: a procedural rain toggle — falling streaks (a points field with a
// generated streak texture), a wet-road retint, seeded puddle discs on flat
// road sections (host + every client build the identical field from the track
// index), a ripple when a kart passes over, and dimmed lights while it rains.
// Purely cosmetic: zero physics effect, nothing rides the wire, headless-safe
// (all scene work is on the faked scene / no-ops in the sims).
import * as THREE from 'three';
import { scene, sun, hemi } from './scene.js';
import { samples, sampleHead } from './track.js';
import { N_SAMPLES } from './config.js';
import { mulberry32 } from './obstacles.js';

let rainOn = false;
export function getWeatherRain() { return rainOn; }
export function setWeatherRain(on) { rainOn = !!on; setPuddlesVisible(rainOn); }

/* ---------------- rain streaks ------------------------------------------ */
const N_RAIN = 320;
let rainPts = null;

export function buildWeather() {
  if (rainPts) return;
  let tex = null;
  if (typeof document !== 'undefined') {
    const cv = document.createElement('canvas');
    cv.width = 4; cv.height = 32;
    const g = cv.getContext('2d');
    const gr = g.createLinearGradient(0, 0, 0, 32);
    gr.addColorStop(0, 'rgba(200,220,255,0)');
    gr.addColorStop(1, 'rgba(200,220,255,0.85)');
    g.fillStyle = gr;
    g.fillRect(0, 0, 4, 32);
    tex = new THREE.CanvasTexture(cv);
  }
  const pos = new Float32Array(N_RAIN * 3);
  for (let i = 0; i < N_RAIN; i++) {
    pos[i * 3] = (Math.random() - 0.5) * 80;
    pos[i * 3 + 1] = Math.random() * 30;
    pos[i * 3 + 2] = (Math.random() - 0.5) * 80;
  }
  rainPts = new THREE.Points(
    new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(pos, 3)),
    new THREE.PointsMaterial({ size: 0.9, transparent: true, opacity: 0.5, map: tex, depthWrite: false }),
  );
  rainPts.visible = false;
  scene.add(rainPts);
}

// cam = a Vector3 (or {x,z}); rain wraps around the camera
export function tickWeather(dt, cam = { x: 0, z: 0 }) {
  if (!rainPts) return;
  rainPts.visible = rainOn;
  if (!rainOn) return;
  const pos = rainPts.geometry.attributes.position.array;
  for (let i = 0; i < N_RAIN; i++) {
    pos[i * 3 + 1] -= 38 * dt;
    if (pos[i * 3 + 1] < -2) {
      pos[i * 3] = cam.x + (Math.random() - 0.5) * 80;
      pos[i * 3 + 1] = 28;
      pos[i * 3 + 2] = cam.z + (Math.random() - 0.5) * 80;
    }
  }
  rainPts.geometry.attributes.position.needsUpdate = true;
}

// dim the lights after daynight (which sets absolute values every frame)
export function applyWeatherLights() {
  if (!rainOn) return;
  sun.intensity *= 0.45;
  hemi.intensity *= 0.5;
}

/* ---------------- puddles (seeded, flat sections only) ------------------- */
export const puddleList = [];

export function buildPuddles(idx, parent = null) {
  puddleList.length = 0;
  const host = parent || scene;
  const rng = mulberry32((0x51ab7c15 ^ Math.imul(idx + 7, 3405733215)) >>> 0);
  const mat = new THREE.MeshStandardMaterial({
    color: 0x3a4a5a, roughness: 0.15, metalness: 0.4, transparent: true, opacity: 0.55,
  });
  for (let i = 0; i < N_SAMPLES; i += 24) {
    if (rng() > 0.14) continue;
    const a = samples[i];
    const y0 = samples[(i + N_SAMPLES - 12) % N_SAMPLES].y;
    const y2 = samples[(i + 12) % N_SAMPLES].y;
    if (Math.abs(y0 - a.y) > 0.25 || Math.abs(y2 - a.y) > 0.25) continue;   // flat only
    const h = sampleHead[i];
    const o = (rng() * 2 - 1) * 2.6;   // lateral offset inside the road
    const p = new THREE.Vector3(-Math.cos(h), 0, Math.sin(h)).multiplyScalar(o).add(a);
    const mesh = new THREE.Mesh(new THREE.CircleGeometry(0.9, 20), mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(p.x, a.y + 0.03, p.z);
    host.add(mesh);
    puddleList.push({ x: p.x, y: a.y, z: p.z, obj: mesh, pulse: 0 });
  }
}

export function setPuddlesVisible(on) {
  for (const p of puddleList) p.obj.visible = !!on;
}

export function tickPuddles(dt) {
  for (const p of puddleList) {
    if (p.pulse > 0) {
      p.pulse *= Math.exp(-3 * dt);
      if (p.pulse < 0.01) p.pulse = 0;
      const s = 1 + p.pulse * 0.3;
      p.obj.scale.set(s, s, 1);
    }
  }
}

// a kart passing over ripples the puddle (cosmetic)
export function puddleRipple(x, z, y) {
  for (const p of puddleList) {
    const dx = p.x - x, dz = p.z - z;
    if (dx * dx + dz * dz < 2.6 && Math.abs(p.y - y) < 1.5) p.pulse = 1;
  }
}
