import * as THREE from 'three';
import { addSky } from './sky.js';

/* ------------------------------------------------------------------ *
 *  Renderer / scene / lights
 * ------------------------------------------------------------------ */
export const container = document.getElementById('app');
export const renderer  = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
container.appendChild(renderer.domElement);

export const scene = new THREE.Scene();
scene.background = new THREE.Color(0x180f0a);
scene.fog = new THREE.Fog(0x180f0a, 130, 320);

// far must exceed dome radius (450) + max camera distance from center (~250),
// otherwise the far wall of the sky dome gets clipped and shows scene.background
export const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 1200);

export const hemi = new THREE.HemisphereLight(0xfff2dd, 0x2a1a10, 0.85);
scene.add(hemi);

export const sun = new THREE.DirectionalLight(0xfff0d8, 1.6);
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

export const fill = new THREE.DirectionalLight(0xbfd4ff, 0.35);
fill.position.set(-40, 30, 50);
scene.add(fill);

// dusk sky dome + sun glow (procedural, see sky.js)
addSky(scene, sun.position.clone());

/* ------------------------------------------------------------------ *
 *  Off-road dust — small particle pool puffed behind karts when they
 *  churn through the tabletop "terrain" (feels the off-road penalty).
 * ------------------------------------------------------------------ */
const DUST_N = 90;
const dustGeo = new THREE.BufferGeometry();
const dustPos = new Float32Array(DUST_N * 3);
const dustVel = new Float32Array(DUST_N * 3);
const dustAge = new Float32Array(DUST_N).fill(10); // age > life = dead
const dustLife = new Float32Array(DUST_N);
dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
const dustMat = new THREE.PointsMaterial({
  color: 0xcdb489, size: 0.42, transparent: true, opacity: 0.55,
  depthWrite: false, sizeAttenuation: true,
});
const dust = new THREE.Points(dustGeo, dustMat);
dust.frustumCulled = false;
scene.add(dust);
let dustCursor = 0;

export function emitDust(x, z, vx, vz, amount) {
  for (let i = 0; i < amount; i++) {
    const j = dustCursor = (dustCursor + 1) % DUST_N;
    dustPos[j * 3] = x + (Math.random() - 0.5) * 0.9;
    dustPos[j * 3 + 1] = 0.25 + Math.random() * 0.2;
    dustPos[j * 3 + 2] = z + (Math.random() - 0.5) * 0.9;
    dustVel[j * 3] = vx + (Math.random() - 0.5) * 1.2;
    dustVel[j * 3 + 1] = 0.7 + Math.random() * 1.1;
    dustVel[j * 3 + 2] = vz + (Math.random() - 0.5) * 1.2;
    dustAge[j] = 0;
    dustLife[j] = 0.4 + Math.random() * 0.35;
  }
}

export function updateDust(dt) {
  let live = false;
  for (let i = 0; i < DUST_N; i++) {
    if (dustAge[i] >= dustLife[i]) continue;
    live = true;
    dustAge[i] += dt;
    const t = dustAge[i] / dustLife[i];
    if (t >= 1) { dustPos[i * 3 + 1] = -100; continue; } // park dead puffs below the table
    dustPos[i * 3] += dustVel[i * 3] * dt;
    dustPos[i * 3 + 1] += dustVel[i * 3 + 1] * dt;
    dustPos[i * 3 + 2] += dustVel[i * 3 + 2] * dt;
    dustVel[i * 3 + 1] *= 1 - 1.5 * dt; // slow rise
  }
  if (live) dustGeo.attributes.position.needsUpdate = true;
}

// per-frame emitter: dust behind a kart that's off-road and moving
export function dustForKart(k, dt) {
  if (!k.offRoad || Math.abs(k.speed) < 3) return;
  const rate = Math.min(3, Math.abs(k.speed) / 8 + 1); // puffs/sec
  if (Math.random() > rate * dt) return;
  const fx = Math.sin(k.heading), fz = Math.cos(k.heading);
  const bx = k.pos.x - fx * 1.1, bz = k.pos.z - fz * 1.1; // behind the kart
  emitDust(bx, bz, -fx * Math.abs(k.speed) * 0.25, -fz * Math.abs(k.speed) * 0.25, 2);
}
