import * as THREE from 'three';
import { MAX_SPEED, STEER_RATE, ROAD_HW, N_SAMPLES, clamp, turnFactor } from './config.js';
import { samples, sampleHead, angDiff, curvatureAt, trackLen } from './track.js';
import { obstacleAvoid, blockingHazard } from './obstacles.js';

/* ------------------------------------------------------------------ *
 *  AI driver — pure-pursuit line following + curvature-aware braking
 *
 *  skill in [0..1] shapes: top speed, cornering grip, how far ahead the
 *  driver scans, steering accuracy (bias + wander) and recovery reflexes.
 * ------------------------------------------------------------------ */
const _aiPt = new THREE.Vector3();

function aiParams(skill) {
  return {
    maxSp:    s => Math.min(MAX_SPEED, MAX_SPEED * (0.38 + 0.65 * skill) * (1 + 0.012 * s)), // top speed by skill
    grip:     4.5 + 6.5 * skill,       // cornering aptitude; v_corner = sqrt(gripScale*9.8*skillish / K)
    gripScale: 0.8 + 1.4 * skill,      // how much of their theoretical corner speed they actually hold
    margin:   1 + 0.45 * (1 - skill),  // weak drivers brake earlier / leave more space
    look:     s => 0.7 * s + 6 * (1 - skill),  // pursue point, arc units ahead (weak = aims earlier, slower)
    gain:     2.2 + 1.0 * skill,       // steering gain (low = sloppy, high = sharp)
    errMax:   0.16 * (1 - skill),      // steady-state heading bias: strong≈0, weak≈9°
    wobble:   0.10 * (1 - skill),      // restless steering wobble at speed
    cornerK:  0.2 + 0.8 * skill,        // usable corner speed (hesitation in hairpins)
  };
}

// max speed the chassis can hold at curvature K (yaw-rate limited), found by bisection
function cornerCap(K) {
  let lo = 2, hi = MAX_SPEED * 1.3;
  for (let i = 0; i < 24; i++) {
    const mid = 0.5 * (lo + hi);
    if (K * mid < STEER_RATE * turnFactor(mid)) lo = mid; else hi = mid;
  }
  return lo;
}

export function aiControl(k, karts) {
  // per-hazard escape cooldown: prevents the endless clip→escape→re-clip loop
  if ((k._coolUntil || 0) > 0) k._coolUntil--;
  const P = aiParams(k.skill ?? 0.9);
  const n = N_SAMPLES;

  // --- deadlock escape (safety net). Steering avoidance (obstacleAvoid) is the
  // primary defense and dodges the candy. But a driver who ends up pressed UP
  // against a hazard at crawl speed is wedged: turnFactor(speed) → ~0 means a
  // parked kart can't steer out of the way. So — like a human — the driver puts
  // it in reverse, back up ~8u to make room, then the avoidance routine takes
  // over the re-approach with room to actually swerve. The trigger is a hazard
  // in reach while (nearly) stopped; the release is WORLD distance to the
  // remembered candy spot (heading-based distance would oscillate, because
  // reversing rotates the heading 180°). A per-hazard COOLDOWN then stops the
  // endless “escape → re-clip → escape” loop on one piece of candy.
  {
    if (k._escId !== undefined && k._escId !== -1) {
      const wd = Math.hypot(k.pos.x - k._escX, k.pos.z - k._escZ);
      if (wd < 8) {
        // plain reverse along the racing line (nose tracks the line 7 samples
        // behind us), so we pull back along it without arcing off-road.
        const bi = ((Math.floor((k.prevU || 0.5) * n) - 7) + n) % n;
        const BP = samples[bi];
        const rErr = Math.atan2(Math.sin(Math.atan2(BP.x - k.pos.x, BP.z - k.pos.z) - k.heading),
                                Math.cos(Math.atan2(BP.x - k.pos.x, BP.z - k.pos.z) - k.heading));
        k._escAge = (k._escAge || 0) + 1;
        return { throttle: -0.7, steer: clamp(rErr * 2.0, -1.2, 1.2) };
      }
      k._escId = -1;               // 8u clear — avoidance takes over the re-approach
      k._coolUntil = 60 * 6;       // ~6s before escape may fire for this candy again
    }
    const bh = blockingHazard(k);
    // only start if this candy isn't in cooldown (its avoid was just given a shot)
    if (bh && !(bh.iid === k._coolId && (k._coolUntil || 0) > 0)) {
      k._escId = bh.iid; k._escX = bh.x; k._escZ = bh.z; k._escR = bh.r; k._escAge = 0;
      k._coolId = bh.iid;
    }
  }

  // preferred lane, nudge away from whoever is right in front of us
  let lane = clamp(k.lane || 0, -(ROAD_HW - 1.6), ROAD_HW - 1.6);
  const myIdx = k.trackIdx;
  const hx = -Math.cos(sampleHead[myIdx]), hz = Math.sin(sampleHead[myIdx]); // "left of travel"
  for (const o of karts) {
    if (o === k) continue;
    const rel = angDiff(o.prevU, k.prevU);         // in-track progress of them vs us
    if (rel <= 0.002 || rel > 0.05) continue;      // only cars just AHEAD of us matter
    const relPos = _aiPt.copy(o.pos).sub(k.pos);
    const along = relPos.x * Math.sin(sampleHead[myIdx]) + relPos.z * Math.cos(sampleHead[myIdx]);
    if (along < 0.5 || along > 18) continue;
    const side = relPos.x * hx + relPos.z * hz;    // + = they're to our left
    if (Math.abs(side) < 3) lane -= Math.sign(side || 1) * Math.max(0, 4 - Math.abs(side)) * 0.6;
  }
  // weak drivers drift in and out of their lane as they drive
  lane += P.wobble * 1.6 * Math.sin(k.speed * 0.35 + myIdx * 0.05);
  lane = clamp(lane, -(ROAD_HW - 1.6), ROAD_HW - 1.6);

  // --- speed plan: fastest the driver can hold given corners in range ---
  const topSp = P.maxSp(k.lapDone);
  const maxSp = k.offRoad ? Math.min(8, topSp) : topSp;
  const dist = 25 + 2.4 * Math.max(0, k.speed);    // arc units the driver can react in
  // sugar hazards: aim the pursuit line at the far side of a candy in our
  // path. A strong driver commits hard and goes around clean; a weak one
  // barely adjusts and clips it (jolt + speed loss) — that's the point.
  const laneLo = -(ROAD_HW - 1.6), laneHi = ROAD_HW - 1.6;
  lane = clamp(lane + obstacleAvoid(k, dist, k.skill ?? 0.9), laneLo, laneHi);
let vNeed = Infinity;
  const du = trackLen > 0 ? dist / trackLen : 0.05;
  for (let s = 1; s <= 40; s++) {
    const K = Math.abs(curvatureAt(k.prevU + du * s / 40));
    if (K > 0.0004) {
      let v = Math.sqrt((P.grip * P.gripScale * 2.2) / K) * P.margin;  // 2.2: steady yaw inside off-road threshold
      v = Math.min(v, cornerCap(K) * P.cornerK);  // hesitation: weak drivers under-use their steering in the hairpins
      vNeed = Math.min(vNeed, v);
      if (vNeed < maxSp * 0.3) break;
    }
  }
  vNeed = Math.min(vNeed, maxSp);
  const th0 = k.speed > vNeed + 0.9 ? -1 : k.speed < vNeed - 0.4 ? 1 : 0;
  // hysteresis so throttle doesn't chatter at the boundary
  let throttle = th0;

  // --- steering: pure pursuit, aim at a point ahead on the preferred line ---
  const look = P.look(Math.max(0, k.speed)) + (k.offRoad ? dist * 0.5 : 0);
  const lu = k.prevU + look / (trackLen || 1);
  const it = Math.floor((((lu % 1) + 1) % 1) * n) % n;
  const Pt = _aiPt.copy(samples[it]);
  const Nx = -Math.cos(sampleHead[it]), Nz = Math.sin(sampleHead[it]); // "left of travel"
  Pt.x += Nx * lane; Pt.z += Nz * lane;
  const dTgt = Math.atan2(Pt.x - k.pos.x, Pt.z - k.pos.z);
  let err = Math.atan2(Math.sin(dTgt - k.heading), Math.cos(dTgt - k.heading));
  // imprecise drivers never quite line up; strong ones track to ~0.5°
  err -= P.errMax * Math.sign(err || 1) * Math.min(1, Math.abs(err) / 0.6);
  err += P.wobble * 0.5 * Math.sin(k.lapDone * 7 + k.prevU * 90);
  let steer = clamp(err * P.gain, -1.5, 1.5);

  // --- recovery: lost the road? chase the line back hard instead of limping ---
  const dp = k.pos.distanceTo(samples[k.trackIdx]);
  if (dp > ROAD_HW * 2.2 && Math.abs(err) > 1.1) {
    return { throttle: -0.9, steer: clamp(err * 1.5, -1, 1) }; // facing wrong way — back up
  }
  if (dp > ROAD_HW * 1.2) {
    const rIdx = (myIdx + Math.min(6, Math.round(6 + P.look(0) / 8))) % n;
    const RT = samples[rIdx];
    const rDt = Math.atan2(RT.x - k.pos.x, RT.z - k.pos.z);
    const rErr = Math.atan2(Math.sin(rDt - k.heading), Math.cos(rDt - k.heading));
    steer = clamp(rErr * (P.gain * 1.8 + 1.5), -1.5, 1.5);   // sharper pursuit while recovering
    if (throttle === 1 && k.speed < topSp * 0.5) throttle = 0.7; // don't floor it back onto the line
  }
  return { throttle, steer };
}
