// Corners: per-corner lap timing + deltas vs the session-best lap's per-corner
// times. Corners are the plateaus of the 2D (xz) curvature: a region of
// sustained turn (min span + min total turn angle, adjacent regions merged).
// The field is deterministic (samples only) — host + clients compute it locally
// from the track index; only the per-corner deltas are cosmetic (HUD flash),
// so nothing new rides the wire.
import { samples } from './track.js';
import { N_SAMPLES } from './config.js';

const CURV_TH = 0.006;    // per-sample |curvature| above this = inside a corner
const MIN_SPAN = 8;      // ...sustained this many samples
const MIN_TURN = 0.25;   // ...and turning this much in total (rad)
const GAP_MERGE = 10;    // regions closer than this are one corner

let cornerMap = new Array(N_SAMPLES).fill(-1);
let cornerCount = 0;

export function buildCorners() {
  const n = N_SAMPLES;
  const c = new Array(n);
  for (let i = 0; i < n; i++) {
    const p0 = samples[(i + n - 1) % n], p1 = samples[i], p2 = samples[(i + 1) % n];
    const ax = p1.x - p0.x, az = p1.z - p0.z, bx = p2.x - p1.x, bz = p2.z - p1.z;
    c[i] = (ax * bz - az * bx) / (Math.hypot(ax, az) * Math.hypot(bx, bz) || 1);
  }
  const cs = [];
  let i = 0;
  while (i < n) {
    if (Math.abs(c[i]) < CURV_TH) { i++; continue; }
    let j = i;
    while (j < n && Math.abs(c[j]) >= CURV_TH) j++;
    let turn = 0;
    for (let k = i; k < j; k++) turn += Math.abs(c[k]);
    if (j - i >= MIN_SPAN && turn >= MIN_TURN) cs.push([i, j]);
    i = j;
  }
  for (let p = cs.length - 2; p >= 0; p--)
    if (cs[p + 1][0] - cs[p][1] < GAP_MERGE) { cs[p][1] = cs[p + 1][1]; cs.splice(p + 1, 1); }
  cornerMap = new Array(n).fill(-1);
  cs.forEach((r, idx) => {
    for (let k = r[0]; k < r[1]; k++) cornerMap[k] = idx;
  });
  cornerCount = cs.length;
}

export function getCornerCount() { return cornerCount; }
export function getCornerIdx(trackIdx) { return cornerMap[trackIdx % N_SAMPLES]; }

// Per-kart corner timing (host-authoritative when the sim runs it; the client
// runs it on the interpolated mirror — the delta is cosmetic either way).
export function initCornerState(k) {
  k.cornerTimes = new Array(cornerCount).fill(0);
  k.cornerIn = -1;
  k.cornerT0 = 0;
}

// now = ms clock. Returns the corner idx that just closed (for the delta
// flash), or -1.
export function tickCorners(k, now) {
  if (!k.cornerTimes || k.cornerTimes.length !== cornerCount) initCornerState(k);
  const ci = getCornerIdx(k.trackIdx);
  if (ci === k.cornerIn) return -1;
  let closed = -1;
  if (k.cornerIn >= 0 && k.cornerT0 > 0) {
    k.cornerTimes[k.cornerIn] += (now - k.cornerT0) / 1000;
    closed = k.cornerIn;
  }
  k.cornerIn = ci;
  k.cornerT0 = ci >= 0 ? now : 0;
  return closed;
}

// lap end: close any open corner, then the per-corner times are the lap's
export function closeCorners(k, now) {
  if (k.cornerIn >= 0 && k.cornerT0 > 0) {
    k.cornerTimes[k.cornerIn] += (now - k.cornerT0) / 1000;
    k.cornerIn = -1;
    k.cornerT0 = 0;
  }
}

export function resetCorners(k) {
  k.cornerTimes.fill(0);
  k.cornerIn = -1;
  k.cornerT0 = 0;
}
