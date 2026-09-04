// calibrate per-skill look-ahead: look = a*speed + b, sweep a small grid
import { samples, sampleHead, curvatureAt, trackLen } from '../src/track.js';
import { N_SAMPLES, ROAD_HW, MAX_SPEED, STEER_RATE, clamp, turnFactor } from '../src/config.js';
import { Kart } from '../src/kart.js';
const n = N_SAMPLES;

function cornerCap(K) {
  let lo = 2, hi = MAX_SPEED * 1.3;
  for (let i = 0; i < 24; i++) {
    const mid = 0.5 * (lo + hi);
    if (K * mid < STEER_RATE * turnFactor(mid)) lo = mid; else hi = mid;
  }
  return lo;
}

function makeCtl(skill, lookA, lookB) {
  const topSp = s => Math.min(MAX_SPEED, MAX_SPEED * (0.38 + 0.65 * skill) * (1 + 0.012 * s));
  const grip = 4.5 + 6.5 * skill;
  const gripScale = 0.8 + 1.4 * skill;
  const margin = 1 + 0.45 * (1 - skill);
  const gain = 2.2 + 1.0 * skill;
  const errMax = 0.16 * (1 - skill);
  const wobble = 0.10 * (1 - skill);
  return (k) => {
    const myIdx = k.trackIdx;
    let lane = clamp(k.lane || 0, -(ROAD_HW - 1.6), ROAD_HW - 1.6);
    lane += wobble * 3.2 * Math.sin(k.speed * 0.35 + myIdx * 0.05);
    lane = clamp(lane, -(ROAD_HW - 1.6), ROAD_HW - 1.6);
    const T = topSp(k.lapDone);
    const maxSp = k.offRoad ? Math.min(8, T) : T;
    const dist = 25 + 2.4 * Math.max(0, k.speed);
    let vNeed = Infinity;
    const du = dist / trackLen;
    for (let i1 = 1; i1 <= 40; i1++) {
      const K = Math.abs(curvatureAt(k.prevU + du * i1 / 40));
      if (K > 0.0004) {
        let v = Math.sqrt((grip * gripScale * 2.2) / K) * margin;
        v = Math.min(v, cornerCap(K));
        vNeed = Math.min(vNeed, v);
        if (vNeed < maxSp * 0.3) break;
      }
    }
    vNeed = Math.min(vNeed, maxSp);
    let throttle = k.speed > vNeed + 0.9 ? -1 : k.speed < vNeed - 0.4 ? 1 : 0;
    const sp = Math.max(0, k.speed);
    const look = lookA * sp + lookB + (k.offRoad ? dist * 0.5 : 0);
    const lu = k.prevU + look / trackLen;
    const it = Math.floor((((lu % 1) + 1) % 1) * n) % n;
    const Px = samples[it].x - Math.cos(sampleHead[it]) * lane;
    const Pz = samples[it].z + Math.sin(sampleHead[it]) * lane;
    const dTgt = Math.atan2(Px - k.pos.x, Pz - k.pos.z);
    let err = Math.atan2(Math.sin(dTgt - k.heading), Math.cos(dTgt - k.heading));
    err -= errMax * Math.sign(err || 1) * Math.min(1, Math.abs(err) / 0.6);
    err += wobble * 0.5 * Math.sin(k.lapDone * 7 + k.prevU * 90);
    let steer = clamp(err * gain, -1.5, 1.5);
    const dp = k.pos.distanceTo(samples[myIdx]);
    if (dp > ROAD_HW * 2.2 && Math.abs(err) > 1.1)
      return { throttle: -0.9, steer: clamp(err * 1.5, -1, 1) };
    if (dp > ROAD_HW * 1.2) {
      const rIdx = (myIdx + 6) % n;
      const rd = Math.atan2(samples[rIdx].x - k.pos.x, samples[rIdx].z - k.pos.z);
      const rErr = Math.atan2(Math.sin(rd - k.heading), Math.cos(rd - k.heading));
      steer = clamp(rErr * (gain * 1.8 + 1.5), -1.5, 1.5);
      if (throttle === 1 && k.speed < T * 0.5) throttle = 0.7;
    }
    return { throttle, steer };
  };
}

function run(ctrlFn, secs = 240) {
  const k = new Kart({ isPlayer: false, name: 'S' });
  const i = Math.floor(0.99 * n) % n;
  k.pos.copy(samples[i]);
  const T = samples[(i + 1) % n].clone().sub(samples[i]);
  k.heading = Math.atan2(T.x, T.z);
  k.trackIdx = i; k.prevU = 0.99;
  let t = 0, offTime = 0, maxLat = 0;
  while (t < secs && !k.raceDone) {
    const c = ctrlFn(k, []);
    k.step(1 / 60, c.throttle, c.steer, t * 1000);
    t += 1 / 60;
    const r = k.nearestTrack();
    if (k.offRoad) offTime += 1 / 60;
    maxLat = Math.max(maxLat, r.lat);
  }
  return { laps: k.lapDone, off: (100 * offTime / t).toFixed(1), maxLat: maxLat.toFixed(1),
           best: k.lapTimes.length ? Math.min(...k.lapTimes).toFixed(1) : '-', done: k.raceDone };
}

for (const skill of [0.96, 0.85, 0.62]) {
  const best = [];
  for (const a of [0.55, 0.7, 0.85, 1.0])
    for (const b of [0, 5, 10, 15]) {
      const r = run(makeCtl(skill, a, b));
      best.push(`  a=${a} b=${b}: ${r.done?'DONE':'INCON'} off=${r.off}% best=${r.best}`);
    }
  console.log(`skill=${skill}`);
  console.log(best.join('\n'));
}
