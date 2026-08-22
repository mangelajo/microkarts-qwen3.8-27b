import * as THREE from 'three';

/*
 * Procedural dusk sky: a large gradient dome (stars + sunset band) plus a
 * soft sun glow sprite placed along the main light direction.
 * All generated on a canvas, so no external assets.
 */
const GROUND = '#180f0a'; // must match scene.background / fog in scene.js

function makeSkyTexture() {
  const W = 1024, H = 512;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d');

  // vertical gradient: zenith (top) -> horizon (middle) -> ground (bottom)
  const grad = g.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0.000, '#04060f');
  grad.addColorStop(0.280, '#0a1226');
  grad.addColorStop(0.430, '#1d2a48');
  grad.addColorStop(0.478, '#4a3240');
  grad.addColorStop(0.497, '#7a4a26'); // brightest right at the horizon
  grad.addColorStop(0.512, '#553619');
  grad.addColorStop(0.560, '#2c1c11');
  grad.addColorStop(0.620, GROUND);
  grad.addColorStop(1.000, GROUND);
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);

  // stars in the upper part only
  for (let i = 0; i < 260; i++) {
    const x = Math.random() * W;
    const y = Math.random() * H * 0.42 * (0.5 + Math.random() * 0.5);
    const r = 0.4 + Math.random() * 1.0;
    g.globalAlpha = 0.25 + Math.random() * 0.65;
    g.fillStyle = Math.random() < 0.2 ? '#cfe0ff' : '#ffffff';
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  }
  g.globalAlpha = 1;

  // faint dark cloud streaks near the horizon
  g.fillStyle = '#1a1024';
  for (let i = 0; i < 9; i++) {
    g.globalAlpha = 0.05 + Math.random() * 0.07;
    const x = Math.random() * W;
    const y = H * 0.44 + Math.random() * H * 0.05;
    g.beginPath();
    g.ellipse(x, y, 90 + Math.random() * 160, 5 + Math.random() * 8, 0, 0, Math.PI * 2);
    g.fill();
  }
  g.globalAlpha = 1;

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeSunTexture() {
  const S = 256;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d');
  const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  grad.addColorStop(0.00, 'rgba(255,244,220,0.95)');
  grad.addColorStop(0.18, 'rgba(255,214,150,0.75)');
  grad.addColorStop(0.45, 'rgba(255,150,80,0.28)');
  grad.addColorStop(1.00, 'rgba(255,120,50,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, S, S);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** attach the sky dome to the scene; sunDir should match the directional light direction */
export function addSky(scene, sunDir = new THREE.Vector3(60, 90, -35)) {
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(450, 48, 24),
    new THREE.MeshBasicMaterial({ map: makeSkyTexture(), side: THREE.BackSide, fog: false, toneMapped: false }),
  );
  scene.add(dome);

  const sun = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: makeSunTexture(), blending: THREE.AdditiveBlending, depthWrite: false, fog: false, toneMapped: false }),
  );
  sun.position.copy(sunDir).normalize().multiplyScalar(380);
  sun.scale.setScalar(170);
  scene.add(sun);
}
