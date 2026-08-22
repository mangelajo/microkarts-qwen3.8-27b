import * as THREE from 'three';

/*
 * Procedural dusk sky: a large gradient dome (stars + sunset band) plus a
 * soft sun glow sprite placed along the main light direction.
 * All generated on a canvas, so no external assets.
 */

function makeSkyTexture() {
  // Upper-hemisphere equirect band: canvas TOP = zenith, BOTTOM = horizon.
  // (The dome is a half-sphere, so this entire texture is used.)
  const W = 1024, H = 512;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d');

  // vertical gradient: zenith (top) -> horizon (bottom, brightest)
  const grad = g.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0.00, '#04060f');
  grad.addColorStop(0.40, '#0a1226');
  grad.addColorStop(0.68, '#1d2a48');
  grad.addColorStop(0.84, '#4a3240');
  grad.addColorStop(0.93, '#7a4a26');
  grad.addColorStop(1.00, '#8f5a2e'); // brightest right at the horizon
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);

  // helper: draw at x and its wrapped copies so nothing clips at the texture seam
  const wrap = (x, fn) => { for (const ox of [-W, 0, W]) fn(x + ox); };

  // stars, mostly near the zenith, fading out toward the horizon
  for (let i = 0; i < 260; i++) {
    const x = Math.random() * W;
    const y = Math.pow(Math.random(), 1.6) * H * 0.8;      // biased toward zenith
    const r = 0.4 + Math.random() * 1.0;
    const fade = 1 - y / (H * 0.9);                        // softer near horizon
    g.globalAlpha = (0.25 + Math.random() * 0.65) * Math.max(0.15, fade);
    g.fillStyle = Math.random() < 0.2 ? '#cfe0ff' : '#ffffff';
    wrap(x, xx => { g.beginPath(); g.arc(xx, y, r, 0, Math.PI * 2); g.fill(); });
  }
  g.globalAlpha = 1;

  // faint dark cloud streaks near the horizon
  g.fillStyle = '#1a1024';
  for (let i = 0; i < 9; i++) {
    const x = Math.random() * W;
    const y = H * (0.78 + Math.random() * 0.18);
    const rx = 90 + Math.random() * 160;
    const ry = 5 + Math.random() * 8;
    const a = 0.05 + Math.random() * 0.07;
    wrap(x, xx => { g.globalAlpha = a; g.beginPath(); g.ellipse(xx, y, rx, ry, 0, 0, Math.PI * 2); g.fill(); });
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
    new THREE.SphereGeometry(450, 48, 32, 0, Math.PI * 2, 0, Math.PI / 2), // upper hemisphere only
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
