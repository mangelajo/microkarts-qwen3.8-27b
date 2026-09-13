// Gamepad — one mapping layer (standard layout): left stick steer (axes[0]) +
// throttle (axes[1], down = forward, up = brake), LT or Y = drift, RT or X =
// item (edge-triggered by the caller), D-pad as the fallback. The mapping
// itself is pure (a gamepad-like object -> drive struct) so the headless sims
// can test it with a fake pad; the browser wiring (boot connect + poll) is
// guarded and only runs when navigator.getGamepads exists.
const DEAD = 0.15;

export function mapGamepad(gp) {
  if (!gp || !gp.connected || !gp.axes || !gp.buttons) return null;
  const b = gp.buttons.map(x => !!x.pressed);
  const ax = v => (Math.abs(v) > DEAD ? v : 0);
  const stick = ax(gp.axes[0] ?? 0);
  const steer = stick || ax(((b[14] ? -1 : 0) + (b[15] ? 1 : 0)));
  const stickTh = ax(-(gp.axes[1] ?? 0));
  const dpTh = (b[12] ? 1 : 0) - (b[13] ? 1 : 0);
  const throttle = stickTh || dpTh;
  const drift = !!(b[3] || b[6]);
  const item = !!(b[2] || b[7]);
  if (steer === 0 && throttle === 0 && !drift && !item) return null;
  return { throttle, steer, drift, item };
}

// --- browser wiring (no-op headless) -----------------------------------------
let padIdx = 0;
let lastItem = false;

export function initGamepad() {
  if (typeof navigator === 'undefined' || !navigator.getGamepads) return;
  const scan = () => {
    const pads = navigator.getGamepads();
    for (let i = 0; i < pads.length; i++)
      if (pads[i] && pads[i].connected) { padIdx = i; break; }
  };
  scan();
  if (typeof addEventListener === 'function') {
    addEventListener('gamepadconnected', scan);
  }
}

// Returns { throttle, steer, drift, itemEdge? } or null when nothing is pressed.
export function gamepadPoll() {
  if (typeof navigator === 'undefined' || !navigator.getGamepads) return null;
  const pads = navigator.getGamepads();
  const p = pads[padIdx] && pads[padIdx].connected ? pads[padIdx] : pads.find(x => x && x.connected) || null;
  const m = p && mapGamepad(p);
  if (!m) { lastItem = false; return null; }
  const out = { throttle: m.throttle, steer: m.steer, drift: m.drift };
  if (m.item && !lastItem) out.itemEdge = true;
  lastItem = m.item;
  return out;
}
