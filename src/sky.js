import * as THREE from 'three';

/*
 * Procedural dusk sky: a large gradient dome (stars + sunset band) plus a
 * soft sun glow sprite placed along the main light direction.
 * All generated on a canvas, so no external assets.
 */

// default dusk band (zenith -> horizon); stops are [offset, hex] pairs
const DEFAULT_SKY = [
  [0.00, 0x35598f], [0.35, 0x4f7cb4], [0.62, 0x7ba2cf],
  [0.82, 0xa7a99f], [0.93, 0xc99b5e], [1.00, 0xd9a25c],
];

function makeSkyTexture(stops = DEFAULT_SKY) {
  // Upper-hemisphere equirect band: canvas TOP = zenith, BOTTOM = horizon.
  // (The dome is a half-sphere, so this entire texture is used.)
  const W = 1024, H = 512;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d');

  // vertical gradient: zenith (top) -> horizon (bottom warm glow)
  const grad = g.createLinearGradient(0, 0, 0, H);
  for (const [off, hex] of stops) grad.addColorStop(off, '#' + hex.toString(16).padStart(6, '0'));
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);

  // helper: draw at x and its wrapped copies so nothing clips at the texture seam
  const wrap = (x, fn) => { for (const ox of [-W, 0, W]) fn(x + ox); };

  // periodic mountain ridge: sum of whole-number harmonics -> seamless at x=0/W
  const ridge = (x, n, ph) => {
    let h = 0, a = 1, k = 1;
    for (let i = 0; i < n; i++, k *= 2) h += a * Math.sin(2 * Math.PI * k * x / W + ph[i]);
    return h;
  };
  const phFar  = [Math.random() * 6.28, Math.random() * 6.28, Math.random() * 6.28, Math.random() * 6.28];
  const phNear = [Math.random() * 6.28, Math.random() * 6.28, Math.random() * 6.28, Math.random() * 6.28];
  const drawRidge = (base, amp, ph, color) => {
    g.fillStyle = color;
    g.beginPath();
    g.moveTo(0, H);
    for (let x = 0; x <= W; x += 4) g.lineTo(x, H - base - amp * ridge(x, 4, ph) * 0.7);
    g.lineTo(W, H);
    g.closePath();
    g.fill();
  };
  drawRidge(H * 0.055, H * 0.075, phFar,  '#5d708c');  // distant range, hazier
  drawRidge(H * 0.020, H * 0.050, phNear, '#232c40');  // near range, darker

  // stars, mostly near the zenith, fading out toward the horizon
  for (let i = 0; i < 200; i++) {
    const x = Math.random() * W;
    const y = Math.pow(Math.random(), 1.6) * H * 0.7;      // biased toward zenith
    const r = 0.4 + Math.random() * 1.0;
    const fade = 1 - y / (H * 0.8);                        // softer near horizon
    g.globalAlpha = (0.2 + Math.random() * 0.6) * Math.max(0.15, fade);
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
export function addSky(scene, sunDir = new THREE.Vector3(60, 90, -35), stops = DEFAULT_SKY) {
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(450, 48, 32, 0, Math.PI * 2, 0, Math.PI / 2), // upper hemisphere only
    new THREE.MeshBasicMaterial({ map: makeSkyTexture(stops), side: THREE.BackSide, fog: false, toneMapped: false }),
  );
  scene.add(dome);

  const sun = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: makeSunTexture(), blending: THREE.AdditiveBlending, depthWrite: false, fog: false, toneMapped: false }),
  );
  sun.position.copy(sunDir).normalize().multiplyScalar(380);
  sun.scale.setScalar(170);
  scene.add(sun);

  // hold a reference so later track themes can repaint the gradient
  scene.userData.skyDome = dome;
}

/** repaint the sky dome of a scene with a new gradient (array of [offset, hex]) */
export function retintSky(scene, stops) {
  const dome = scene.userData?.skyDome;
  if (!dome) return;
  const old = dome.material.map;
  dome.material.map = makeSkyTexture(stops);
  dome.material.needsUpdate = true;
  old.dispose();
}
