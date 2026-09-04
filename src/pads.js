import { samples, sampleHead, trackLen } from './track.js';
import { ROAD_HW } from './config.js';
import { obstacleList, mulberry32 } from './obstacles.js';

/* ------------------------------------------------------------------ *
 *  Boost pads — glowing chevron strips on the straights. Each cell a
 *  kart crosses fires kart.boost (the same currency the drift boost
 *  uses); crossing the 3 cells of a strip back-to-back chains into a
 *  progressively bigger kick — the Mario-Kart "drift into the pads"
 *  combo falls out for free.
 *
 *  Pure + headless-safe (no THREE / DOM), exactly like obstacles.js:
 *  the layout is DERIVED from the track shape (straight sections found
 *  by scanning sample headings) plus a PRNG seeded by the track index,
 *  so solo, host and every join client build the identical field with
 *  nothing streamed — the "100% deterministic race" property holds.
 *  Visual meshes live in track.js.
 * ------------------------------------------------------------------ */

export const CELL_LEN = 1.7;      // along the track
export const CELL_W = 2.3;        // across
export const GAP = 2.1;           // between cells of a strip
export const CELLS = 3;
export const PAD_STRENGTH = [0.4, 0.7, 1.05];  // boost by chain depth
const CHAIN_WINDOW = 0.9;         // s to reach the next cell or the chain dies

export const padList = [];        // cells, filled IN PLACE by buildPads()

/**
 * (Re)build the pad field for a track. Fills padList in place. A strip is
 * only placed inside a genuinely straight run (heading changes < 0.3 rad
 * over a ~7% lap window), keeps the start/grid and finish zones clear, and
 * never lands on top of a sugar hazard. 0..2 strips per track depending on
 * how much genuine straight the shape offers.
 */
export function buildPads(trackIdx) {
  padList.length = 0;
  if (trackLen <= 0) return padList;

  const N_S = samples.length;
  const W = 20;                                    // half-window ≈ 4% lap
  const straight = new Uint8Array(N_S);
  for (let i = 0; i < N_S; i++) {
    const a = sampleHead[(i - W + N_S) % N_S], b = sampleHead[(i + W) % N_S];
    let d = b - a;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    straight[i] = Math.abs(d) < 0.35 ? 1 : 0;
  }
  // straight runs long enough to hold a 9.3u strip + margins (seam-wrapped)
  const runs = [];
  let i0 = -1;
  for (let i = 0; i <= N_S * 2; i++) {
    const s = i < N_S * 2 && straight[i % N_S];
    if (s && i0 < 0) i0 = i;
    if (!s && i0 >= 0) {
      const len = i - i0;
      if (len >= 75 && i0 < N_S) {
        const c = ((i0 + (len >> 1)) % N_S) / N_S;
        if (c > 0.14 && c < 0.86) runs.push({ a: i0 % N_S, len: Math.min(len, N_S) });
      }
      i0 = -1;
    }
  }

  const rng = mulberry32((0x51ed270b ^ Math.imul(trackIdx + 7, 2246822519)) >>> 0);
  const n = Math.min(2, runs.length);
  let si = 0;
  while (si < n && runs.length) {
    const r = runs.splice((rng() * runs.length) | 0, 1)[0];
    const margin = 10;                       // samples in from the run edges
    for (let tries = 0; tries < 6; tries++) {
      const ci = r.a + margin + Math.floor(rng() * Math.max(1, r.len - 2 * margin));
      const u0 = (ci % N_S) / N_S;           // middle cell sits here
      const o = (rng() * 2 - 1) * (ROAD_HW - 1.8);
      const cells = [];
      for (let c = 0; c < CELLS; c++) {
        const du = ((c - 1) * (GAP + CELL_LEN)) / trackLen;
        const u = (((u0 + du) % 1) + 1) % 1;
        const idx = Math.floor(u * N_S) % N_S;
        const h = sampleHead[idx];
        cells.push({ x: samples[idx].x - Math.cos(h) * o, z: samples[idx].z + Math.sin(h) * o,
          h, o, u, strip: si, cell: c, id: 0 });
      }
      // never pave over candy — a jawbreaker on a boost pad is a cheap shot
      const clear = cells.every(p => obstacleList.every(ob =>
        (ob.x - p.x) ** 2 + (ob.z - p.z) ** 2 > 4.6 * 4.6));
      if (!clear) continue;
      for (const p of cells) { p.id = padList.length; padList.push(p); }
      si++;
      break;
    }
  }
  return padList;
}

/**
 * Per-tick trigger check (called from race.js simulateTick, so solo +
 * net host + every sim share it). Fires kart.boost / boostEdge — the same
 * fields the drift release writes; the kart's own sync() flares the
 * exhaust off them, and main.js plays the whoosh for the local player.
 */
export function hitPads(karts, dt) {
  for (const k of karts) {
    if (k.padT > 0) {
      k.padT -= dt;
      if (k.padT <= 0) k.padChain = 0;      // too slow between cells — reset
    }
    if (!padList.length || k.raceDone) continue;
    let hit = null;
    for (const p of padList) {
      const dx = k.pos.x - p.x, dz = k.pos.z - p.z;
      if (dx * dx + dz * dz > 9) continue;  // cheap reject
      const along = dx * Math.sin(p.h) + dz * Math.cos(p.h);
      const across = dx * -Math.cos(p.h) + dz * Math.sin(p.h);
      if (Math.abs(along) <= CELL_LEN / 2 + 0.7 && Math.abs(across) <= CELL_W / 2 + 0.5) { hit = p; break; }
    }
    if (!hit) { k.padLast = -1; continue; } // left the strip — cells re-arm
    if (hit.id === k.padLast) continue;     // one firing per cell crossing
    k.padLast = hit.id;
    const chained = k.padChain > 0 && hit.strip === k.padStrip && hit.cell === k.padPrevCell + 1;
    k.padChain = chained ? Math.min(k.padChain + 1, CELLS) : 1;
    k.padStrip = hit.strip;
    k.padPrevCell = hit.cell;
    k.padT = CHAIN_WINDOW;
    const s = PAD_STRENGTH[k.padChain - 1];
    if (s > k.boost) k.boost = s;
    k.boostEdge = true;
  }
}
