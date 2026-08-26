import { clamp, MAX_SPEED, MAX_REV } from './config.js';

/* ------------------------------------------------------------------ *
 *  Race core — pure, headless-safe (no DOM / WebGL). Shared by the
 *  browser (main.js) and the Node sims (ai-sim) so the networked host
 *  and every sim run the exact same code path (plans/2_player_lan.md, P0).
 *
 *  inputFor(k, racing) -> { throttle, steer } decides who drives each
 *  kart: local keys, the wire (k.net on the host), or aiControl.
 * ------------------------------------------------------------------ */
export const GRID = [
  { u: 0.9925, o: -1.75 }, { u: 0.9925, o: +1.75 },
  { u: 0.985,  o: -1.75 }, { u: 0.985,  o: +1.75 },
];

export function progress(k) {
  return k.lapDone + k.prevU;
}

export function raceOrder(karts) {
  return karts.slice().sort((a, b) => progress(b) - progress(a));
}

export function refreshPositions(karts) {
  const order = raceOrder(karts);
  order.forEach((k, i) => { k.posIdx = i + 1; });
  return order;
}

// crashFor, if provided, is called with (kartA, kartB, severity) for any
// overlapping pair — main.js uses it to play audio on the local player.
export function collideKarts(karts, crashFor) {
  for (let i = 0; i < karts.length; i++) {
    for (let j = i + 1; j < karts.length; j++) {
      const a = karts[i], b = karts[j];
      const dx = b.pos.x - a.pos.x, dz = b.pos.z - a.pos.z;
      const d2 = dx * dx + dz * dz;
      const min = 2.15;
      if (d2 < min * min && d2 > 1e-6) {
        const d = Math.sqrt(d2);
        const nx = dx / d, nz = dz / d;
        const push = (min - d) / 2 + 0.01;
        a.pos.x -= nx * push; a.pos.z -= nz * push;
        b.pos.x += nx * push; b.pos.z += nz * push;
        const va = Math.sin(a.heading) * a.speed * nx + Math.cos(a.heading) * a.speed * nz;
        const vb = Math.sin(b.heading) * b.speed * nx + Math.cos(b.heading) * b.speed * nz;
        const dv = vb - va;
        if (dv < 0) {
          const jimp = -0.58 * dv;
          a.speed -= Math.sin(a.heading) * jimp * 0.5 + Math.cos(a.heading) * jimp * 0.5;
          b.speed += Math.sin(b.heading) * jimp * 0.5 + Math.cos(b.heading) * jimp * 0.5;
          a.speed = clamp(a.speed, -MAX_REV, MAX_SPEED + 3);
          b.speed = clamp(b.speed, -MAX_REV, MAX_SPEED + 3);
          if (crashFor) crashFor(a, b, Math.min(1, -dv / 14));
        }
      }
    }
  }
}

// one fixed sim tick: integrate every kart, resolve collisions.
// Solo passes racing=false during the countdown (positions stay stale,
// same as before this refactor); the net host passes racing=true once
// the flag drops. `now` is ms (performance.now() for solo, host
// sim-clock for net) and drives lap timing.
export function simulateTick(karts, inputFor, dt, now, { racing, positions = true, crashFor } = {}) {
  for (const k of karts) {
    const c = inputFor(k, racing);
    k.step(dt, c.throttle, c.steer, now);
  }
  collideKarts(karts, crashFor);
  if (positions && racing) refreshPositions(karts);
}
