/* ------------------------------------------------------------------ *
 *  Sugar hazards — random candy strewn across the asphalt that karts
 *  have to swerve around.
 *
 *  Pure + headless-safe (no THREE / DOM): the authoritative sim
 *  (race.js) and the AI (kart.js) both import it, and the headless
 *  harness (ai-sim) runs it in Node. Visual meshes live in track.js.
 *
 *  The hazard FIELD is deterministic — seeded from the track index — so
 *  every client (solo AND the networked join role) generates the exact
 *  same layout without the host ever streaming positions. That keeps
 *  the "100% deterministic race" property the net-sim relies on: same
 *  track + same mode => same hazards, frame for frame.
 * ------------------------------------------------------------------ */
import { samples, sampleHead, trackLen } from './track.js';
import { ROAD_HW } from './config.js';

export const obstacleList = [];   // filled in place by buildObstacles; empty when off
let obstaclesOn = false;
export const getObstaclesOn = () => obstaclesOn;
export const setObstaclesOn = v => { obstaclesOn = !!v; };

// mulberry32 — tiny deterministic PRNG (seed drives the whole field)
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = t + Math.imul(t ^ (t >>> 7), 61 | t) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
   };
}

// collision radius per candy kind; the visual warning ring uses the same r
const KINDS = [
  { kind: 'gumdrop',   r: 0.85 },
  { kind: 'lolly',     r: 0.72 },
  { kind: 'gumball',   r: 0.78 },
  { kind: 'jawbreaker', r: 1.05 },
  { kind: 'dice',      r: 0.95 },
  { kind: 'bean',      r: 0.70 },
];
export const OBSTACLE_KINDS = KINDS;
// per-kind candy body colour (the visual; collision uses r only)
export const HAZ_COLOR = {
  gumdrop: 0xff5aa8, lolly: 0x8fd4ff, gumball: 0xffd23f,
  jawbreaker: 0xff8a3d, dice: 0xf4f0e8, bean: 0x9be36a,
};
// a kart is ~1.8u wide; its solid core against candy is a 1.0u disc
export const KART_R = 1.0;

// NOTE: samples/sampleHead/trackLen resolve lazily — track.js imports this
// module, so a top-level reference here would hit the TDZ at load time.

/**
 * (Re)build the hazard field for a track. Fills obstacleList IN PLACE so
 * every consumer (sim + AI + renderer) reads the same array. Empty when
 * disabled. The field is a fixed walk of the loop at arc-spaced gaps,
 * keeping the start line / grid zone clear so nobody spawns in candy.
 */
export function buildObstacles(trackIdx) {
  const list = obstacleList;
  list.length = 0;
  if (!obstaclesOn || trackLen <= 0) return list;

  const rng = mulberry32((0x9e3779b1 ^ ((trackIdx + 1) * 2654435761)) >>> 0);
  const N_S = samples.length;
  const N = Math.max(5, Math.round(trackLen / 75));   // ~1 hazard per 75u of asphalt
  let u = 0.07 + rng() * 0.05;                        // first one well past the start
  for (let i = 0; i < N; i++) {
    // keep the start/grid zone [0.93,1) clear, and never sit on the start line
    if (u > 0.92) u = 0.07 + rng() * 0.05;
    const idx = Math.floor(u * N_S) % N_S;
    const h = sampleHead[idx];
    const nx = -Math.cos(h), nz = Math.sin(h);         // "left of travel"
    const o = (rng() * 2 - 1) * (ROAD_HW - 1.4);       // leaves >= ~1.4u of escape lane
    const spec = KINDS[(rng() * KINDS.length) | 0];
    const r = spec.r * (0.9 + rng() * 0.22);
    list.push({
      kind: spec.kind, r,
      x: samples[idx].x + nx * o,
      z: samples[idx].z + nz * o,
      y: samples[idx].y,   // sits on the (elevated) road
      u: ((u % 1) + 1) % 1,
      o,
      rot: rng() * Math.PI * 2,
      iid: list.length,   // stable identity this build (for per-driver hysteresis)
     });
    // generous arc gaps — never two hazards form a tight gate (that deadlocks
    // a driver who can't steer around both at once). 0.09–0.16 lap ≈ 35–63u.
    u = (u + 0.09 + rng() * 0.06) % 1;
   }
  return list;
}

/* ------------------------------------------------------------------ *
 *  Kart-vs-candy collision — static obstacles, so we resolve the full
 *  overlap every tick (a parked kart can't push candy the way it pushes
 *  another kart). Charging into a hazard bleeds speed hard and kicks the
 *  jolt; glancing off (already leaving) just pops the kart clear.
 * ------------------------------------------------------------------ */
export function collideObstacles(karts, onHit) {
  const list = obstacleList;
  if (!list.length) return;
  for (const k of karts) {
    if (k.raceDone) continue;
    let hit = null, best = Infinity;
    for (let i = 0; i < list.length; i++) {
      const o = list[i];
      const dx = k.pos.x - o.x, dz = k.pos.z - o.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < best) { best = d2; hit = o; }
     }
    const min = hit.r + KART_R;
    if (best >= min * min) continue;
    const d = Math.sqrt(best) || 1e-4;
    const nx = (k.pos.x - hit.x) / d, nz = (k.pos.z - hit.z) / d;
    // relative velocity of the kart along the push axis: <0 means charging IN
    const rel = Math.sin(k.heading) * nx + Math.cos(k.heading) * nz;
    k.pos.x += nx * (min - d);                         // pop just clear of the candy
    k.pos.z += nz * (min - d);
    const charge = Math.max(0, -rel) * Math.min(1, Math.abs(k.speed) / 18);
    if (charge > 0.02) {
      k.speed *= Math.max(0.65, 1 - charge * 0.6);   // decelerate but keep moving
      if (onHit) onHit(k, Math.min(1, 0.12 + charge * 1.3));
     }
   }
}

/* ------------------------------------------------------------------ *
 *  AI avoidance — the PRIMARY defense (escape is just a safety net).
 *  Returns a signed lateral nudge to add to the driver's pursuit lane,
 *  pulling them AWAY FROM the nearest hazard that is ahead and inside our
 *  lane. All geometry is in the kart's heading frame (fwd/side) so it
 *  needs no u/trackLen bookkeeping and wraps across the lap seam for free
 *  (the look-ahead window is far shorter than one loop length).
 *
 *  urgency  how urgent  = 1 - clamp(fwd / horizon)  → bigger the closer we are
 *  strength  = (KART_R + hazard.r + 0.3) * urgency * (0.6 + 0.4 * skill)
 *              strong drivers commit near-full and clear the candy (dodge);
 *              weak ones under-steer and clip it — that's the point of a hazard.
 *  hard cap  ±3u so a single candy can never shove a slow driver wide of the road.
 *
 *  Per-driver committed side (k.hazId / k.hazSide) is hysteresis: while the
 *  hazard stays on the same side (right on top of us) we hold the chosen
 *  direction instead of re-deciding it every tick, so we dodge cleanly
 *  instead of weaving. Each kart keeps its OWN state (not on the obstacle!)
 *  so one driver's committed side never bleeds into another's.
 * ------------------------------------------------------------------ */
export function obstacleAvoid(k, dist, skill) {
  // Return a small signed nudge (added to the pursuit lane) that pulls the
  // driver away from the candy in their path. All in the kart's heading frame
  // (fwd/side). Scales with urgency (how close) and skill (strong drivers
  // commit hard; weak ones barely flinch and clip it — that's the point).
  // Per-kart hysteresis (k.hazId/k.hazSide) holds the committed side while
  // right on top of a candy so we don't weave tick-to-tick.
  const list = obstacleList;
  if (!list.length) { k.hazId = -1; return 0; }
  const fx = Math.sin(k.heading), fz = Math.cos(k.heading);
  const lx = -Math.cos(k.heading), lz = Math.sin(k.heading);
  const laneW = 1.0 + KART_R;  // our lane width including kart radius
  let best = 0, bestSide = 0, bestR = 0, bestI = -1;
  for (let i = 0; i < list.length; i++) {
    const o = list[i];
    const dx = o.x - k.pos.x, dz = o.z - k.pos.z;
    const fwd = dx * fx + dz * fz;                // ahead, wraps fine
    if (fwd < 0.4 || fwd > dist) continue;
    const side = dx * lx + dz * lz;               // + = hazard to our left
    if (Math.abs(side) > o.r + laneW + 0.6) continue;
    const urg = 1 - Math.min(1, fwd / Math.max(10, dist * 0.5));
    if (urg > best) { best = urg; bestSide = side; bestR = o.r; bestI = i; }
   }
  if (bestI < 0) { k.hazId = -1; return 0; }
  let dir = bestSide >= 0 ? -1 : 1;  // hazard to our LEFT -> nudge RIGHT (negative lane)
  if (k.hazSide && ((k.hazSide < 0) === (dir < 0)) && Math.abs(bestSide) < bestR + laneW + 1.5)
    dir = k.hazSide;  // hold committed side when right on top
  k.hazId = bestI; k.hazSide = dir;
  const nudge = dir * (KART_R + bestR + 0.3) * best * (0.6 + 0.4 * skill);
  return Math.min(Math.max(nudge, -3.0), 3.0);  // hard cap ~3u max
}
export function blockingHazard(k) {
  if (k.speed > 0.8) return null;                 // only a crawling / stopped driver
  const fx = Math.sin(k.heading), fz = Math.cos(k.heading);
  const lx = -Math.cos(k.heading), lz = Math.sin(k.heading);
  for (const o of obstacleList) {
    const dx = o.x - k.pos.x, dz = o.z - k.pos.z;
    const fwd = dx * fx + dz * fz;
    if (fwd < -2 || fwd > 4) continue;
    const side = dx * lx + dz * lz;
    if (Math.abs(side) <= o.r + KART_R + 0.8) return o;
   }
  return null;
}
