/* ------------------------------------------------------------------ *
 *  Item boxes — N_ITEM_BOXES candy boxes per track grant weighted
 *  power-ups (turbo / rubber band / wall).
 *
 *  Pure + headless-safe (no THREE / DOM), exactly like obstacles.js /
 *  pads.js: the box LAYOUT is seeded from the track index and each box's
 *  roll is drawn from its own seeded PRNG, so the host and every LAN
 *  client build the identical field with NOTHING streamed — the
 *  100%-deterministic-race property holds. The per-frame held item rides
 *  the state frame as one u8 per kart (net.js; old peers decode item=0);
 *  walls are the host-authoritative projectile list, drawn from here by
 *  track.js and mirrored cosmetically by the join client.
 *
 *  Items are OFF by default so the headless sim gates stay pure
 *  no-regression harnesses; the menu toggles them (chip + I, persisted,
 *  host broadcasts the pick over the wire like hazards).
 * ------------------------------------------------------------------ */
import { samples, trackLen } from './track.js';
import { sampleHead } from './track.js';
import { obstacleList, mulberry32 } from './obstacles.js';
import { padList } from './pads.js';
import { progress } from './race.js';
import {
  ITEM_NONE, ITEM_TURBO, ITEM_RUBBER, ITEM_WALL, ITEM_WEIGHTS,
  N_ITEM_BOXES, ITEM_RESPAWN, ITEM_COOLDOWN, ITEM_PICKUP_R,
  RUBBER_ACCEL, WALL_SPEED, WALL_LIFE, WALL_HIT_R, WALL_HIT_KILL,
  MAX_SPEED,
} from './config.js';

export const itemBoxList = [];  // filled IN PLACE by buildItems; empty when off
export const walls = [];        // live projectiles (host-authoritative, visual mirror elsewhere)

let itemsOn = true;
export const getItemsOn = () => itemsOn;
export const setItemsOn = v => { itemsOn = !!v; };

/* ------------------------------------------------------------------ *
 *  Layout — deterministic per track index (host == client, zero wire).
 *  Each box gets its OWN seeded PRNG: the position walk and the item
 *  roll share it, so the same build always yields the same box, and a
 *  pickup only advances that box's roll at build time (the roll itself
 *  is fixed — a box always re-grants the same item on respawn).
 * ------------------------------------------------------------------ */
function rollItem(rng) {
  const total = ITEM_WEIGHTS.reduce((a, b) => a + b, 0);
  let r = rng() * total;
  for (let i = 0; i < ITEM_WEIGHTS.length; i++) {
    r -= ITEM_WEIGHTS[i];
    if (r <= 0) return [ITEM_TURBO, ITEM_RUBBER, ITEM_WALL][i];
  }
  return ITEM_WALL;
}

export function buildItems(trackIdx) {
  const list = itemBoxList;
  list.length = 0;
  walls.length = 0;               // in-flight projectiles die with the track
  if (!itemsOn || trackLen <= 0) return list;

  const N_S = samples.length;
  const placed = [];
  for (let b = 0; b < N_ITEM_BOXES; b++) {
    const rng = mulberry32((0x5eed51ed ^ Math.imul(trackIdx * 7 + b + 1, 2654435761)) >>> 0);
    for (let tries = 0; tries < 48; tries++) {
      const u = 0.10 + rng() * 0.80;
      if (u > 0.91) continue;                     // keep the grid / start line clear
      if (placed.some(q => Math.min(Math.abs(q - u), 1 - Math.abs(q - u)) < 0.16)) continue; // spread out
      const idx = Math.floor(u * N_S) % N_S;
      // gentle surface only — a box on a 30° slope would float visually
      const dy = Math.abs(samples[(idx + 20) % N_S].y - samples[(idx + N_S - 20) % N_S].y);
      if (dy > 1.5) continue;
      const h = sampleHead[idx];
      const o = (rng() * 2 - 1) * 1.6;            // near the racing line, easy to catch
      const x = samples[idx].x - Math.cos(h) * o;
      const z = samples[idx].z + Math.sin(h) * o;
      // never on top of candy or a boost pad
      if (obstacleList.some(ob => (ob.x - x) ** 2 + (ob.z - z) ** 2 < 3 * 3)) continue;
      if (padList.some(p => (p.x - x) ** 2 + (p.z - z) ** 2 < 2.6 * 2.6)) continue;
      placed.push(u);
      list.push({ x, z, y: samples[idx].y, h, u, o, iid: b, item: rollItem(rng), respawnT: 0 });
      break;
    }
  }
  return list;
}

/* ------------------------------------------------------------------ *
 *  Per-tick: pickup cooldowns, box respawns, pickups, walls in flight,
 *  passive rubber band. Called from race.js simulateTick, so solo + net
 *  host + every sim share the exact same code path. hitWall(wall, kart)
 *  is a juice/sfx callback (main.js); omit it in the headless sims.
 * ------------------------------------------------------------------ */
function nearestRoadIdx(w, last) {
  const N = samples.length;
  let best = last, bd = Infinity;
  for (let d = -40; d <= 40; d++) {
    const i = (last + d + N) % N;
    const dx = samples[i].x - w.x, dz = samples[i].z - w.z;
    const d2 = dx * dx + dz * dz;
    if (d2 < bd) { bd = d2; best = i; }
  }
  return best;
}

export function tickItems(karts, dt, hitWall) {
  for (const k of karts) {
    if ((k.itemT || 0) > 0) { k.itemT -= dt; if (k.itemT < 0) k.itemT = 0; }
  }
  for (const b of itemBoxList) {
    if (b.respawnT > 0) { b.respawnT -= dt; if (b.respawnT <= 0) b.respawnT = 0; }
  }
  // pickups — a kart with a free slot grabs the nearest live box in reach
  for (const k of karts) {
    if (k.raceDone || k.item !== ITEM_NONE) continue;
    let best = null, bd = ITEM_PICKUP_R * ITEM_PICKUP_R;
    for (const b of itemBoxList) {
      if (b.respawnT > 0) continue;
      const dx = k.pos.x - b.x, dz = k.pos.z - b.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bd) { bd = d2; best = b; }
    }
    if (best) {
      k.item = best.item;
      k.itemT = ITEM_COOLDOWN;
      best.respawnT = ITEM_RESPAWN;
    }
  }
  // walls fly straight along the throw heading, hugging the road surface
  for (let i = walls.length - 1; i >= 0; i--) {
    const w = walls[i];
    w.t += dt;
    w.x += w.dx * WALL_SPEED * dt;
    w.z += w.dz * WALL_SPEED * dt;
    w.idx = nearestRoadIdx(w, w.idx);
    w.y = samples[w.idx].y;
    let hit = null;
    for (const k of karts) {
      if (k === w.owner || k.raceDone) continue;
      const dx = k.pos.x - w.x, dz = k.pos.z - w.z;
      if (dx * dx + dz * dz < WALL_HIT_R * WALL_HIT_R) { hit = k; break; }
    }
    if (hit) {
      hit.speed *= WALL_HIT_KILL;          // slam, don't kill momentum dead
      hit.jolt = Math.min(1, Math.max(hit.jolt || 0, 0.9));
      if (hitWall) hitWall(w, hit);
      walls.splice(i, 1);
    } else if (w.t > WALL_LIFE) {
      walls.splice(i, 1);
    }
  }
}

/* E-key use (edge-triggered by the caller). Returns an event {kind, kart}
 * for sfx/juice, or null. The rubber is passive — holding it does work
 * (tickRubber), pressing E does not (MK8-style). */
export function useItem(k) {
  if (!k || k.raceDone || k.item === ITEM_NONE) return null;
  if (k.item === ITEM_TURBO) {
    k.item = ITEM_NONE;
    if (k.boost < 1) k.boost = 1;          // the drift/pad boost currency, full charge
    k.boostEdge = true;
    return { kind: 'turbo', kart: k };
  }
  if (k.item === ITEM_WALL) {
    k.item = ITEM_NONE;
    walls.push({
      owner: k,
      x: k.pos.x + Math.sin(k.heading) * 1.2,   // spawn just off the nose
      z: k.pos.z + Math.cos(k.heading) * 1.2,
      y: k.pos.y, dx: Math.sin(k.heading), dz: Math.cos(k.heading),
      idx: k.trackIdx, t: 0,
    });
    return { kind: 'wall', kart: k };
  }
  return null;
}

/* Passive rubber band: a TRAILING holder gets an extra push scaled by the
 * gap to the leader (0.05 laps behind = full push). Pure acceleration —
 * no input, no wire, host-authoritative like everything else in the sim. */
export function tickRubber(karts, dt) {
  if (!karts.length) return;
  let lead = karts[0];
  for (const k of karts) if (progress(k) > progress(lead)) lead = k;
  for (const k of karts) {
    if (k.item !== ITEM_RUBBER || k.raceDone || k === lead) continue;
    const gap = progress(lead) - progress(k);   // laps behind the leader
    if (gap <= 0.002) continue;
    k.speed += RUBBER_ACCEL * Math.min(1, gap * 20) * dt;
    k.speed = Math.min(k.speed, MAX_SPEED * 1.12);
  }
}
