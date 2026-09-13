import * as THREE from 'three';
import { scene, sun, hemi, fill } from './scene.js';
import { TRACKS, trackTheme } from './tracks.js';

/*
 * Day/night cycle — pure visuals (zero physics, zero wire):
 *
 *  - "cycle" tracks (dusk / candy / sunset): the sky drifts through a full
 *    day in 6 min (sunrise → noon → sunset → night); the sun/moon arc across
 *    the sky, stars fade in after dark, lights + fog follow the phase.
 *  - "night" tracks (midnight): stay night — but get the moon + starfield.
 *  - "static" (space): untouched (its baked-in look is final).
 *
 * Headless-safe: this module only touches the (faked) scene objects at import
 * time; the canvas work happens in initDayNight(), which game.js (browser
 * only) calls once.
 */

const CYCLE_S = 360; // one full day/night every 6 min
const CYCLE_BY_THEME = {
  dusk: { mode: 'cycle', base: 0.72 },   // low golden sun at boot → drifts into night
  candy: { mode: 'cycle', base: 0.78 },  // pink evening → night
  sunset: { mode: 'cycle', base: 0.68 }, // golden afternoon → sunset
  midnight: { mode: 'night' },
  space: { mode: 'static' },
};

let starDome = null, sunSprite = null, moonSprite = null, domeMat = null;
let mode = 'static', basePhase = 0;
let themeLight = null;
let themeFog = new THREE.Color(), nightFog = new THREE.Color(0x0a0f1e);

const COL = {
  tintNight: new THREE.Color(0x8fa8d8), tintDay: new THREE.Color(0xffffff), tintWarm: new THREE.Color(0xffd9a8),
  sunDay: new THREE.Color(0xfff0d8), sunNight: new THREE.Color(0x9fb4ff), sunGold: new THREE.Color(0xffb860),
};
const _tint = new THREE.Color(), _sunC = new THREE.Color(), _fog = new THREE.Color();

/* a transparent starfield (procedural canvas — zero assets) */
function makeStarTexture() {
  const W = 1024, H = 512;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  const wrap = (x, fn) => { for (const ox of [-W, 0, W]) fn(x + ox); };
  for (let i = 0; i < 450; i++) {
    const x = Math.random() * W;
    const y = Math.pow(Math.random(), 1.2) * H;      // zenith (top) → horizon (bottom)
    const r = 0.4 + Math.random() * 1.5;
    const fade = 1 - y / (H * 1.05);
    g.globalAlpha = (0.5 + Math.random() * 0.5) * Math.max(0.45, fade);
    g.fillStyle = Math.random() < 0.15 ? '#cfe0ff' : Math.random() < 0.1 ? '#ffe9c0' : '#ffffff';
    wrap(x, xx => { g.beginPath(); g.arc(xx, y, r, 0, Math.PI * 2); g.fill(); });
  }
  g.globalAlpha = 1;
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeMoonTexture() {
  const S = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d');
  const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  grad.addColorStop(0.00, 'rgba(235,240,255,0.95)');
  grad.addColorStop(0.30, 'rgba(210,220,250,0.55)');
  grad.addColorStop(0.60, 'rgba(180,195,240,0.18)');
  grad.addColorStop(1.00, 'rgba(160,180,230,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, S, S);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function initDayNight() {
  if (starDome) return;
  sunSprite = scene.userData.sunSprite;
  domeMat = scene.userData.skyDome?.material;

  starDome = new THREE.Mesh(
    new THREE.SphereGeometry(448, 48, 32, 0, Math.PI * 2, 0, Math.PI / 2), // just inside the sky dome
    new THREE.MeshBasicMaterial({ map: makeStarTexture(), transparent: true, opacity: 0, side: THREE.BackSide, depthWrite: false, fog: false, toneMapped: false }),
  );
  scene.add(starDome);

  moonSprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: makeMoonTexture(), blending: THREE.AdditiveBlending, depthWrite: false, fog: false, toneMapped: false, opacity: 0 }),
  );
  moonSprite.scale.setScalar(85);
  scene.add(moonSprite);
}

/* per-track config, called whenever the track changes */
export function setDayNightFor(idx) {
  const th = trackTheme(TRACKS[idx]);
  const c = CYCLE_BY_THEME[TRACKS[idx].theme] || { mode: 'static' };
  mode = c.mode; basePhase = c.base || 0;
  themeLight = th.light;
  themeFog.set(th.fog);
  if (mode === 'night' && starDome) {
    // just past moonrise; keeps the theme's own light values
    applyPhase(0.78, false);
    if (moonSprite) { moonSprite.position.y = 230; moonSprite.scale.setScalar(340); moonSprite.material.opacity = 1; }
  }
}

/* the fixed night look is the moon arc at p=0.78 (a 12°-high moon, the
   height the race chase camera shows well), stars out, white tint */

const clamp01 = x => (x < 0 ? 0 : x > 1 ? 1 : x);

/* one phase of the day: positions the sun/moon arc, stars, tint + (optionally)
   the light/fog shift. dimLights=false keeps the theme's own light values
   (the established midnight look, unchanged). */
function applyPhase(p, dimLights) {
  const th = 2 * Math.PI * (p - 0.25); // 0 at sunrise, PI/2 at noon, PI at sunset
  const el = Math.sin(th);
  const day = clamp01(el);
  const warm = (1 - Math.min(1, Math.abs(el) / 0.3)) * (el > 0 ? 1 : 0); // gold at dawn/dusk
  if (!sunSprite) return;

  // sun arc (east → west), moon its antipode
  sunSprite.position.set(300 * Math.cos(th), 330 * Math.sin(th), -120);
  sunSprite.material.opacity = clamp01((el + 0.15) / 0.5);
  moonSprite.position.set(-300 * Math.cos(th), -330 * Math.sin(th), 120);
  moonSprite.material.opacity = clamp01((-el + 0.15) / 0.5) * 0.9;
  if (starDome) starDome.material.opacity = 0.9 * (1 - day);

  if (dimLights) {
    // lights follow the phase (theme values = the noon baseline)
    sun.intensity = themeLight.sun * (0.18 + 0.82 * day);
    _sunC.copy(COL.sunNight).lerp(COL.sunDay, day).lerp(COL.sunGold, warm * 0.55);
    if (sun.color && sun.color.copy) sun.color.copy(_sunC);
    hemi.intensity = themeLight.hemi * (0.4 + 0.6 * day);
    fill.intensity = themeLight.fill * (0.55 + 0.45 * day);
    // sky tint + a subtle fog shift toward night
    if (domeMat) {
      _tint.copy(COL.tintNight).lerp(COL.tintDay, day).lerp(COL.tintWarm, warm * 0.35);
      domeMat.color.copy(_tint);
    }
    if (scene.fog?.color?.set) {
      _fog.copy(themeFog).lerp(nightFog, (1 - day) * 0.45);
      scene.fog.color.copy(_fog);
    }
    if (scene.background?.copy) scene.background.copy(_fog);
  } else if (domeMat) {
    domeMat.color.copy(COL.tintDay);
  }
}

/* per frame (cycle mode): t = seconds since boot */
export function updateDayNight(t) {
  if (mode !== 'cycle' || !sunSprite) return;
  applyPhase((basePhase + t / CYCLE_S) % 1, true);
}
