import * as THREE from 'three';
import { ACCEL, BRAKE, MAX_SPEED, MAX_REV, DRAG, OFF_DRAG, OFF_GRIP, STEER_RATE, MAX_VISUAL_STEER, ROAD_HW, WHEEL_R, N_SAMPLES, LAPS, clamp } from './config.js';
import { scene } from './scene.js';
import { samples, sampleHead, angDiff, curvatureAt, trackLen } from './track.js';

/* ------------------------------------------------------------------ *
 *  The kart
 * ------------------------------------------------------------------ */
export function makeKart(bodyColor, accentColor) {
  const root = new THREE.Group();
  const bodyGroup = new THREE.Group();
  root.add(bodyGroup);
  const bodyMat  = new THREE.MeshStandardMaterial({ color: bodyColor, roughness: 0.35, metalness: 0.15 });
  const accMat   = new THREE.MeshStandardMaterial({ color: accentColor, roughness: 0.4 });
  const darkMat  = new THREE.MeshStandardMaterial({ color: 0x23262b, roughness: 0.6 });
  const tireMat  = new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.9 });
  const addBox = (parent, w, h, d, x, y, z, mat) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    parent.add(m);
    return m;
  };
  addBox(bodyGroup, 1.7, 0.5, 1.6, 0, 0.78, -0.15, bodyMat);   // body
  addBox(bodyGroup, 1.2, 0.35, 0.9, 0, 0.72, 1.35, accMat);    // nose
  addBox(bodyGroup, 1.0, 0.5, 0.6, 0, 1.18, -0.55, darkMat);   // seat
  {
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 1.1, 8), darkMat);
    bar.geometry.rotateZ(Math.PI / 2);
    bar.position.set(0, 1.38, 0.5);
    bar.castShadow = true;
    bodyGroup.add(bar);
  }
  const wheels = [];
  const frontPivots = [];
  const wheelGeo = new THREE.CylinderGeometry(WHEEL_R, WHEEL_R, 0.32, 18);
  wheelGeo.rotateZ(Math.PI / 2); // axle along local X
  const addWheel = (x, z, front) => {
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(WHEEL_R * 0.5, WHEEL_R * 0.5, 0.34, 12), accMat);
    hub.geometry.rotateZ(Math.PI / 2);
    const wheel = new THREE.Mesh(wheelGeo, tireMat);
    wheel.castShadow = true;
    wheel.add(hub);
    if (front) {
      const g = new THREE.Group(); // steering pivot at wheel center
      g.position.set(x, WHEEL_R, z);
      wheel.position.set(0, 0, 0);
      g.add(wheel);
      root.add(g);
      frontPivots.push(g);
    } else {
      wheel.position.set(x, WHEEL_R, z);
      root.add(wheel);
    }
    wheels.push(wheel);
  };
  addWheel( 0.85,  1.05, true);
  addWheel(-0.85,  1.05, true);
  addWheel( 0.85, -1.05, false);
  addWheel(-0.85, -1.05, false);
  scene.add(root);
  return { root, bodyGroup, wheels, frontPivots };
}

/* ------------------------------------------------------------------ *
 *  Kart entity: integrates arcade driving physics along the track
 * ------------------------------------------------------------------ */
export class Kart {
  constructor(opts) {
    this.isPlayer = !!opts.isPlayer;
    this.name = opts.name || (this.isPlayer ? 'YOU' : 'RIVALE');
    this.skill = opts.skill ?? 0.9;
    const color = opts.color || 0xe0392b;
    const accent = opts.accent ?? (((color >> 8) & 255) | 0x808080);
    this.mesh = makeKart(color, accent);
    this.pos = new THREE.Vector3();
    this.heading = 0;
    this.speed = 0;
    this.offRoad = false;
    this.lapDone = 0;
    this.lapStart = 0;
    this.lapTimes = [];
    this.hasMid = false;
    this.prevU = 0;
    this.raceDone = false;
    this.finalLapTime = 0;
    this.trackIdx = 0;
    this.steerVel = 0;
    this.wheelSpin = 0;
    this.posIdx = 0;
  }

  placeAt(t, offset) {
    const n = N_SAMPLES;
    const tt = ((t % 1) + 1) % 1;
    const i = Math.floor(tt * n) % n;
    const f = tt * n - i;
    const i1 = (i + 1) % n;
    const P = samples[i].clone().lerp(samples[i1], f);
    const T = samples[i1].clone().sub(samples[i]);
    const Nn = new THREE.Vector3(-T.z, 0, T.x).normalize();
    this.pos.copy(P).addScaledVector(Nn, offset);
    this.heading = Math.atan2(T.x, T.z);
    this.speed = 0;
    this.lapDone = 0;              // grid sits behind the line
    this.hasMid = false;
    this.prevU = tt;
    this.trackIdx = Math.floor(tt * n) % n;
    this.lapTimes = [];
    this.raceDone = false;
    this.steerVel = 0;
    this.posIdx = 0;
    this.lane = offset * 0.9;      // keep the grid side as a racing lane
    this.mesh.root.position.copy(this.pos);
    this.mesh.root.rotation.y = this.heading;
  }

  nearestTrack() {
    let best = -1, bd = Infinity;
    for (let o = -60; o <= 60; o++) {
      const i = (this.trackIdx + o + N_SAMPLES) % N_SAMPLES;
      const p = samples[i];
      const dx = p.x - this.pos.x, dz = p.z - this.pos.z;
      const d = dx * dx + dz * dz;
      if (d < bd) { bd = d; best = i; }
    }
    if (bd > 144) { // lost it — full search
      bd = Infinity;
      for (let i = 0; i < N_SAMPLES; i++) {
        const p = samples[i];
        const dx = p.x - this.pos.x, dz = p.z - this.pos.z;
        const d = dx * dx + dz * dz;
        if (d < bd) { bd = d; best = i; }
      }
    }
    this.trackIdx = best;
    this.offRoad = Math.sqrt(bd) > ROAD_HW - 0.5;
    return { u: best / N_SAMPLES, lat: Math.sqrt(bd) };
  }

  updateLapLogic(now) {
    const { u } = this.nearestTrack();
    if (u > 0.4 && u < 0.6) this.hasMid = true;
    if (this.prevU > 0.85 && u < 0.15) {
      if (this.hasMid) {
        const t = (now - this.lapStart) / 1000;
        this.lapDone++;
        if (this.lapDone >= LAPS) this.raceDone = true;
        this.lapTimes.push(t);
        this.finalLapTime = t;
        this.lapStart = now;
      }
      this.hasMid = false;
    } else if (this.prevU < 0.15 && u > 0.85) {
      this.hasMid = false; // crossed backwards
    }
    this.prevU = u;
  }

  step(dt, throttle, steerIn, now) {
    this.steerVel += (steerIn - this.steerVel) * Math.min(1, 12 * dt);
    const th = this.raceDone ? 0 : throttle;
    if (th > 0) this.speed += ACCEL * (this.offRoad ? OFF_GRIP : 1) * dt;
    else if (th < 0) this.speed -= (this.speed > 0 ? BRAKE : ACCEL * 0.7) * dt;
    this.speed -= this.speed * DRAG * dt;
    if (this.offRoad) this.speed -= Math.sign(this.speed) * Math.min(Math.abs(this.speed), OFF_DRAG * dt);
    this.speed = clamp(this.speed, -MAX_REV, MAX_SPEED);
    if (th === 0 && Math.abs(this.speed) < 0.03) this.speed = 0;
    this.heading += this.steerVel * STEER_RATE * turnFactor(this.speed) * (this.speed < 0 ? -1 : 1) * dt;
    this.pos.x += Math.sin(this.heading) * this.speed * dt;
    this.pos.z += Math.cos(this.heading) * this.speed * dt;
    if (!this.raceDone) this.updateLapLogic(now);
  }

  sync(dt) {
    this.mesh.root.position.copy(this.pos);
    this.mesh.root.rotation.y = this.heading;
    this.wheelSpin += this.speed * dt / WHEEL_R;
    for (const w of this.mesh.wheels) w.rotation.x = this.wheelSpin;
    for (const p of this.mesh.frontPivots) p.rotation.y = this.steerVel * MAX_VISUAL_STEER;
    const sp = Math.min(Math.abs(this.speed) / MAX_SPEED, 1);
    const rollT = this.steerVel * 0.22 * sp;
    const pitchT = (Math.abs(this.speed) > 0.5 ? -0.03 : 0) * (sp + 0.3);
    this.mesh.bodyGroup.rotation.z += (rollT - this.mesh.bodyGroup.rotation.z) * Math.min(1, 8 * dt);
    this.mesh.bodyGroup.rotation.x += (pitchT - this.mesh.bodyGroup.rotation.x) * Math.min(1, 6 * dt);
  }
}

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
  const P = aiParams(k.skill ?? 0.9);
  const n = N_SAMPLES;

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

/* ------------------------------------------------------------------ *
 *  Driving
 * ------------------------------------------------------------------ */
export function turnFactor(s) {
  const a = Math.abs(s);
  const grip = Math.min(a / 6, 1);                            // no turning while (nearly) still
  const calm = 1 - 0.3 * Math.min(a / MAX_SPEED, 1);          // less twitchy at speed
  return grip * calm;
}
