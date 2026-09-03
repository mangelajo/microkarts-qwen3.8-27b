import { STEER_RATE, turnFactor } from './config.js';

/* ------------------------------------------------------------------ *
 *  Client-side interpolation (render-only, no sim).
 *
 *  Keeps a ring of the last few host state frames and samples the
 *  state at (now - offset) for smoothness. Two frames bracketing the
 *  target time → lerp. Frames late → short-term extrapolation using
 *  each kart's own steering, then snap on the next real frame
 *  (plans/2_player_lan.md, "Client rendering").
 *
 *  Pure + side-effect free: unit-testable with fake frames.
 * ------------------------------------------------------------------ */

/* frame: the decoded state the host sends — a plain object:
 *   { t: hostClockMs, karts: [ {x,z,heading,speed,steerVel, offRoad,
 *                               lapDone,posIdx,raceDone} × N ] }
 */
export class FrameRing {
  constructor(cap = 12) {
    this.cap = cap;
    this.frames = [];
  }
  push(frame, recvT) {
    this.frames.push({ frame, recvT });
    while (this.frames.length > this.cap) this.frames.shift();
  }
  clear() { this.frames.length = 0; }
  get size() { return this.frames.length; }
  newest() { return this.frames.length ? this.frames[this.frames.length - 1].frame : null; }
}

const lerp = (a, b, f) => a + (b - a) * f;
const angLerp = (a, b, f) => {
  const d = Math.atan2(Math.sin(b - a), Math.cos(b - a));
  return a + d * f;
};

export function sampleRat(a, b, f) {
  return {
    x: lerp(a.x, b.x, f), z: lerp(a.z, b.z, f),
    heading: angLerp(a.heading, b.heading, f),
    speed: lerp(a.speed, b.speed, f),
    steerVel: lerp(a.steerVel, b.steerVel, f),
  };
}

// one kart's extrapolation step (mirrors Kart.step's steering/position lines)
function extrapolate(k, dt) {
  k.heading += k.steerVel * STEER_RATE * turnFactor(k.speed) * (k.speed < 0 ? -1 : 1) * dt;
  k.posx = k.x + Math.sin(k.heading) * k.speed * dt;
  k.posz = k.z + Math.cos(k.heading) * k.speed * dt;
  k.x = k.posx; k.z = k.posz;
}

/*
 * Sample the ring at targetRecvT (ms on the local clock).
 * Returns { hostMs, karts: [ {x,z,heading,speed,steerVel,offRoad,lapDone,
 *           posIdx,raceDone} … ] } — hostMs is the host sim-clock of the
 * frame the sample is based on (client HUD + lap timing).
 * null if no frames yet.
 */
export function sampleState(ring, targetRecvT) {
  const frames = ring.frames;
  if (!frames.length) return null;

  // find the two frames that bracket the target
  let before = null, after = null;
  for (let i = frames.length - 1; i >= 0; i--) {
    const { frame, recvT } = frames[i];
    if (recvT <= targetRecvT) { before = { frame, recvT }; break; }
    after = { frame, recvT };
  }
  if (!before) before = { frame: frames[0].frame, recvT: frames[0].recvT };

  const out = before.frame.karts.map(k => ({ ...k }));
  // host sim-clock of the sampled moment: interpolate between the bracketing
  // frames (NOT the ring's oldest frame — that made the client HUD/lap clock
  // lag by up to a full ring), or extend past the newest while extrapolating
  let hostMs;
  if (after) {
    const span = Math.max(after.recvT - before.recvT, 1);
    const f = Math.min(1, (targetRecvT - before.recvT) / span);
    hostMs = lerp(before.frame.hostMs, after.frame.hostMs, f);
    for (let i = 0; i < out.length; i++) {
      const a = before.frame.karts[i], b = after.frame.karts[i];
      const s = sampleRat(a, b, f);
      out[i] = { ...out[i], ...s };
    }
  } else {
    // target is past the newest frame: extrapolate (bounded — karts top
    // out at ~30 u/s, so 200 ms of guessing is ~6 u; snap next real frame)
    const dt = Math.min(0.2, (targetRecvT - before.recvT) / 1000);
    hostMs = (before.frame.hostMs || 0) + dt * 1000;
    if (dt > 0) for (const k of out) extrapolate(k, dt);
  }
  return { hostMs, karts: out };
}
