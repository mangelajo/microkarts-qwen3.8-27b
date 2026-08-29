/* ------------------------------------------------------------------ *
 *  Mobile / touch input — a floating "pull" joystick.
 *
 *  The first finger down anywhere on the canvas seeds a virtual stick at
 *  that point (the "initial touch point"); the drag delta is the drive
 *  vector, so the control surfaces wherever the thumb lands:
 *
 *     pull UP    → throttle  (accelerate)
 *     pull DOWN  → brake / reverse
 *     pull L / R → steer
 *
 *  The knob is a spring that saturates at MAX_R px, and each axis is
 *  clamped to its own [-1, 1], so a player can hold full throttle + full
 *  steer through a corner.
 *
 *  Headless-safe: initTouch() is a no-op without a DOM, so the sim
 *  harness (ai-sim) is unaffected. Keyboard still works — main.js blends
 *  the two sources and a LIVE drag wins over a key (so the two never fight).
 * ------------------------------------------------------------------ */

// throw radius (px) that maps to full drive magnitude, the dead-zone that
// swallows sub-pinch jitter, and the steer sign (false = "push left turns
// left", matching the A/← key; flip to true if a phone test shows it's back).
const MAX_R = 74;
const DEAD = 12;
const INVERT_STEER = false;

// exported live drive: throttle/steer in [-1,1], mag = |throw| 0..1,
// active = a finger is currently driving.
export const drive = { throttle: 0, steer: 0, mag: 0, active: false };

let ready = false;   // DOM wired up
let enabled = false; // live only during countdown/racing
let touchDevice = false;
let canvas = null;

// the engaged pointer's id (null when idle) + the joystick geometry:
let pid = null;       // engaged pointer id
let bx = 0, by = 0;   // base = the initial touch point
let dx = 0, dy = 0;   // clamped offset (base → knob)
let ui = null;        // { root, base, knob, hint }

function build() {
  const root = document.createElement('div');
  root.className = 'touch-ui';
  const base = document.createElement('div'); base.className = 'joy-base';
  const knob = document.createElement('div'); knob.className = 'joy-knob';
  const hint = document.createElement('div'); hint.className = 'joy-hint';
  hint.textContent = 'PULL FROM ANYWHERE TO DRIVE';
  root.appendChild(base); root.appendChild(knob); root.appendChild(hint);
  document.body.appendChild(root);
  ui = { root, base, knob, hint };
}

// position base at the seed point, knob at the clamped knob position
function place() {
  ui.base.style.left = bx + 'px'; ui.base.style.top = by + 'px';
  ui.knob.style.left = (bx + dx) + 'px'; ui.knob.style.top = (by + dy) + 'px';
}

function reset() {
  pid = null;
  drive.active = false; drive.throttle = 0; drive.steer = 0; drive.mag = 0;
  dx = 0; dy = 0;
  if (ui) { ui.base.classList.remove('on'); ui.knob.classList.remove('on'); }
}

function onDown(e) {
  if (!enabled || pid !== null) return;               // idle or one stick at a time
  if (e.pointerType === 'mouse' && !touchDevice &&
      location.search.indexOf('touch=1') < 0) return;  // keyboard owns the desktop
  pid = e.pointerId;
  bx = e.clientX; by = e.clientY; dx = 0; dy = 0;
  drive.active = true; drive.throttle = 0; drive.steer = 0; drive.mag = 0;
  try { canvas.setPointerCapture(e.pointerId); } catch { /* capture is best-effort */ }
  place();
  ui.base.classList.add('on'); ui.knob.classList.add('on');
  e.preventDefault();
}

// the heart of it: the drive vector is the diff from the seed (bx,by) to the
// current finger position, clamped to a MAX_R spring for a full-throw magnitude.
function onMove(e) {
  if (pid === null || e.pointerId !== pid) return;
  const ex = e.clientX - bx, ey = e.clientY - by;   // raw drag = (now - initial touch)
  const r = Math.hypot(ex, ey);
  if (r < DEAD) {                       // jitter well under the dead-zone → no drive
    dx = 0; dy = 0;
    drive.throttle = 0; drive.steer = 0; drive.mag = 0;
  } else {
    const cl = Math.min(r, MAX_R);           // spring saturates at full throw
    const u = cl / r;                        // keep the direction, cap the length
    dx = ex * u; dy = ey * u;
    const m = cl / MAX_R;                    // 0..1 how far the finger pulled
    drive.mag = m;
    drive.throttle = -(dy / cl) * m;         // pull UP on-screen → forward (+throttle)
    drive.steer    = (INVERT_STEER ? 1 : -1) * (dx / cl) * m; // push LEFT → turn left
  }
  place();
  e.preventDefault();
}

function onUp(e) {
  if (e.pointerId !== pid) return;            // only our engaged pointer ends the drive
  try { canvas.releasePointerCapture(e.pointerId); } catch { /* wasn't captured */ }
  reset();
}

export function initTouch(el) {
  if (typeof document === 'undefined' || !el) return;   // headless sim: nothing to wire
  if (ready) return;
  canvas = el;
  build();
  touchDevice = (typeof matchMedia === 'function' && matchMedia('(pointer:coarse)').matches)
              || 'ontouchstart' in window
              || (navigator.maxTouchPoints || 0) > 0;
  el.style.touchAction = 'none';          // kill the browser's scroll/zoom on the track
  el.addEventListener('pointerdown', onDown);
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp);
  el.addEventListener('pointercancel', onUp);
  el.addEventListener('lostpointercapture', onUp);
  ready = true;
}

// live only while the car may move — main.js toggles this off on the menu/results
export function setActive(v) { const was = enabled; enabled = !!v; if (was && !enabled) reset(); }
// main.js calls getDrive() once per frame for the player's kart/audio/wire input
export function getDrive() { return drive; }
export function isTouchDevice() { return touchDevice; }

// flash the "PULL FROM ANYWHERE TO DRIVE" cue when a race begins
export function pulseHint(ms = 2600) {
  if (!ui || !touchDevice) return;
  ui.hint.classList.remove('on'); void ui.hint.offsetWidth; // restart the CSS transition
  ui.hint.classList.add('on');
  clearTimeout(pulseHint._t);
  pulseHint._t = setTimeout(() => ui && ui.hint && ui.hint.classList.remove('on'), ms);
}
