/* ------------------------------------------------------------------ *
 *  Headless AI harness
 *  Runs the REAL kart physics + AI (kart.js / track.js) in Node and
 *  reports how well each AI driver holds the racing line — on EVERY
 *  track in the catalogue, so a broken control-point set fails here
 *  instead of in someone's browser.
 *
 *  Run:  make sim          (or: node --import ./ai-sim/stub.js ai-sim/sim.mjs)
 * ------------------------------------------------------------------ */
import * as THREE from 'three';
import { samples, selectTrack } from '../src/track.js';
import { TRACKS } from '../src/tracks.js';
import { N_SAMPLES, AI_SKILL } from '../src/config.js';
import { Kart, aiControl } from '../src/kart.js';

const n = N_SAMPLES;
function posAt(t) {
  const tt = ((t % 1) + 1) % 1;
  const i = Math.floor(tt * n) % n;
  const f = tt * n - i;
  const i1 = (i + 1) % n;
  const P = samples[i].clone().lerp(samples[i1], f);
  const T = samples[i1].clone().sub(samples[i]);
  const Nn = new THREE.Vector3(-T.z, 0, T.x).normalize();
  return { P, T, Nn };
}

const DT = 1 / 60;
const SECONDS = 240; // enough for 3+ laps

function drive(k, secs, extra) {
  let t = 0, offTime = 0, stillTime = 0, maxLat = 0;
  const recoveredAt = [null];
  let knocked = !!extra?.knocked;
  while (t < secs && !k.raceDone) {
    const c = aiControl(k, karts);
    k.step(DT, c.throttle, c.steer, t * 1000);
    t += DT;
    const { lat } = k.nearestTrack();
    maxLat = Math.max(maxLat, lat);
    if (k.offRoad) offTime += DT;
    if (knocked && !k.offRoad) { recoveredAt[0] = t; knocked = false; }
    if (Math.abs(k.speed) < 0.03) stillTime += DT;
  }
  return {
    laps: k.lapDone, done: k.raceDone, time: k.raceDone ? t : secs,
    offRoadPct: 100 * offTime / t,
    stalledPct: 100 * stillTime / t,
    maxLat, recoveredIn: recoveredAt[0],
    lapsBest: k.lapTimes.length ? Math.min(...k.lapTimes).toFixed(1) : '-',
  };
}

function newKart(skill, u, offRoadDist, headingOffset) {
  const k = new Kart({ isPlayer: false, name: 'SIM', skill });
  const { P, T, Nn } = posAt(u);
  k.pos.copy(P).addScaledVector(Nn, offRoadDist || 0);
  k.heading = Math.atan2(T.x, T.z) + (headingOffset || 0);
  k.trackIdx = Math.floor(u * n) % n;
  k.prevU = u;
  karts.length = 0;
  karts.push(k);
  return k;
}

// one kart at a time (the sim measures pure tracking, not the pack)
const karts = [];

// kart collisions, mirrors main.js (simplified impulse)
function collide(list) {
  for (let i = 0; i < list.length; i++)
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      const dx = b.pos.x - a.pos.x, dz = b.pos.z - a.pos.z;
      const d2 = dx * dx + dz * dz, min = 2.15;
      if (d2 < min * min && d2 > 1e-6) {
        const d = Math.sqrt(d2), nx = dx / d, nz = dz / d;
        const push = (min - d) / 2 + 0.01;
        a.pos.x -= nx * push; a.pos.z -= nz * push;
        b.pos.x += nx * push; b.pos.z += nz * push;
        const va = Math.sin(a.heading) * a.speed * nx + Math.cos(a.heading) * a.speed * nz;
        const vb = Math.sin(b.heading) * b.speed * nx + Math.cos(b.heading) * b.speed * nz;
        if (vb - va < 0) {
          const ji = -0.58 * (vb - va);
          a.speed -= (Math.sin(a.heading) + Math.cos(a.heading)) * ji * 0.5;
          b.speed += (Math.sin(a.heading) + Math.cos(a.heading)) * ji * 0.5;
          a.speed = Math.max(-8, Math.min(33, a.speed));
          b.speed = Math.max(-8, Math.min(33, b.speed));
        }
      }
    }
}

/* ------------------------------------------------------------------ *
 *  Full suite per track. Thresholds (off-road %, stalls) are loose
 *  enough for slow tracks but tight enough to catch a broken shape.
 * ------------------------------------------------------------------ */
let failures = 0;
const mark = (ok, why) => { if (!ok) { failures++; console.log(`  !! FAIL: ${why}`); } };

for (let ti = 0; ti < TRACKS.length; ti++) {
  const info = selectTrack(ti);
  console.log(`\n################  ${info.name}  (${info.points} points, ${Math.round(info.trackLen)} u)  ################`);

  console.log(`== clean start (on the racing line)     [skills: ${AI_SKILL.join(', ')}]`);
  for (const skill of AI_SKILL) {
    const k = newKart(skill, 0.99, 0);
    const r = drive(k, SECONDS);
    mark(r.done, `${info.name} clean skill=${skill} did not finish (${r.laps} laps)`);
    mark(r.offRoadPct < 5, `${info.name} clean skill=${skill} offRoad=${r.offRoadPct.toFixed(1)}%`);
    mark(r.stalledPct < 2, `${info.name} clean skill=${skill} stalled=${r.stalledPct.toFixed(1)}%`);
    console.log(`skill=${skill}: laps=${r.laps} ${r.done ? 'DONE' : 'INCON'} offRoad=${r.offRoadPct.toFixed(1)}% stalled=${r.stalledPct.toFixed(1)}% maxLat=${r.maxLat.toFixed(1)} bestLap=${r.lapsBest}`);
  }

  console.log('\n== knocked-out start (8u off the road, facing 45° wrong)');
  for (const skill of AI_SKILL) {
    const k = newKart(skill, 0.99, 8, -0.8); // 8u off the road, facing 45° wrong
    const r = drive(k, SECONDS, { knocked: true });
    mark(r.recoveredIn != null, `${info.name} knocked skill=${skill} never recovered`);
    mark(r.done, `${info.name} knocked skill=${skill} did not finish (${r.laps} laps)`);
    console.log(`skill=${skill}: laps=${r.laps} ${r.done ? 'DONE' : 'INCON'} recoveredIn=${r.recoveredIn ? r.recoveredIn.toFixed(1) + 's' : 'NEVER'} offRoad=${r.offRoadPct.toFixed(1)}% stalled=${r.stalledPct.toFixed(1)}%`);
  }

  console.log('\n== head-on start (on the road, facing 140° the wrong way)');
  for (const skill of AI_SKILL) {
    const k = newKart(skill, 0.99, 0, 2.4);
    const r = drive(k, SECONDS);
    mark(r.done, `${info.name} headon skill=${skill} did not finish (${r.laps} laps)`);
    mark(r.offRoadPct < 8, `${info.name} headon skill=${skill} offRoad=${r.offRoadPct.toFixed(1)}%`);
    console.log(`skill=${skill}: laps=${r.laps} ${r.done ? 'DONE' : 'INCON'} offRoad=${r.offRoadPct.toFixed(1)}% stalled=${r.stalledPct.toFixed(1)}% bestLap=${r.lapsBest}`);
  }

  console.log('\n== full 4-kart race (grid + collisions, mirrors main.js)');
  {
    const skills = AI_SKILL;
    const grid = [{ u: 0.9925, o: -1.75 }, { u: 0.9925, o: 1.75 }, { u: 0.985, o: -1.75 }, { u: 0.985, o: 1.75 }];
    // order: strongest AI, "player" (skill 0.95), rest
    const list = [0, 99, 1, 2].map((si, i) => {
      const k = new Kart({ isPlayer: si === 99, name: si === 99 ? 'YOU' : `AI${si}`, skill: si === 99 ? 0.95 : skills[si] });
      const { P, T, Nn } = posAt(grid[i].u);
      k.pos.copy(P).addScaledVector(Nn, grid[i].o);
      k.heading = Math.atan2(T.x, T.z);
      k.trackIdx = Math.floor(grid[i].u * n) % n;
      k.prevU = grid[i].u;
      k.lane = grid[i].o * 0.9;
      return k;
    });
    let t = 0;
    while (t < 300 && !list[1].raceDone) {
      for (const k of list) {
        const c = aiControl(k, list);
        k.step(DT, c.throttle, c.steer, t * 1000);
      }
      collide(list);
      t += DT;
    }
    for (const k of list) {
      const last = k.lapTimes.length ? k.lapTimes[k.lapTimes.length - 1].toFixed(1) : '-';
      console.log(`${k.name} (skill ${k.skill}): ${k.raceDone ? 'FINISHED' : 'stuck'} laps=${k.lapDone} lastLap=${last}`);
    }
    mark(list[1].raceDone, `${info.name} full race: player (skill .95) never finished`);
    // note: lat is reported for information only — in a pack, karts bounce
    // wide (4-5u) after collisions and recover; the solo scenarios above are
    // the strict track-shape gates.
    for (const k of list) {
      const r = k.nearestTrack();
      console.log(`   ${k.name}: lat=${r.lat.toFixed(2)} off=${k.offRoad}`);
    }
  }
}

console.log(failures === 0
  ? `\n== ALL ${TRACKS.length} TRACKS PASS ==`
  : `\n== ${failures} FAILURE(S) ACROSS ${TRACKS.length} TRACKS ==`);
process.exitCode = failures === 0 ? 0 : 1;
