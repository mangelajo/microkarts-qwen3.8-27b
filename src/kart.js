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
 *  AI driver — follows the racing line, brakes for corners
 * ------------------------------------------------------------------ */
const _aiPt = new THREE.Vector3();

export function aiControl(k, karts) {
  const skill = k.skill ?? 0.9;
  // rivals pace up over the race, but stay below top speed
  const maxSp = k.offRoad ? 8
    : Math.min(MAX_SPEED, 7 + 9.5 * skill + 2.6 * skill * k.lapDone); // u/s
  const grip = 6 + 7 * skill;                        // corner aptitude; v_corner = sqrt(grip/|K|)
  const margin = 1 + 1.1 * (1 - skill);              // weak drivers brake earlier

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
  lane = clamp(lane, -(ROAD_HW - 1.6), ROAD_HW - 1.6);

  // 1) scan ahead for the fastest corner entry speed we can manage
  const horizon = (3 + 0.55 * k.speed) * (0.6 + 0.4 * skill); // u of track to look at
  let vNeed = Infinity;
  for (let s = 1; s <= 40; s++) {
    const K = curvatureAt(k.prevU + s * horizon / (trackLen * 40));
    if (K > 0.0004) {
      vNeed = Math.min(vNeed, Math.sqrt(grip / K) * margin);
      if (vNeed < maxSp * 0.3) break;
    }
  }
  vNeed = Math.min(vNeed, maxSp);
  const throttle = k.speed > vNeed + 0.5 ? -1 : k.speed < vNeed ? 1 : 0;

  // 2) aim down the racing line at the apex of the next corner
  const Kcur = Math.abs(curvatureAt(k.prevU + 0.01));
  const aAhead = 0.25 + 0.75 * Math.min(1, Kcur / 0.0022);
  const lt = k.prevU + (0.015 + 0.05 * aAhead);
  const it = Math.floor(((lt % 1) + 1) % 1 * N_SAMPLES) % N_SAMPLES;
  const P = _aiPt.copy(samples[it]);
  const Nx = -Math.cos(sampleHead[it]), Nz = Math.sin(sampleHead[it]); // "left of travel"
  P.x += Nx * lane; P.z += Nz * lane;
  const dTgt = Math.atan2(P.x - k.pos.x, P.z - k.pos.z);
  const err = Math.atan2(Math.sin(dTgt - k.heading), Math.cos(dTgt - k.heading));

  // lost the track? back up, then steer into the line
  const dp = k.pos.distanceTo(samples[k.trackIdx]);
  if (dp > ROAD_HW * 2.2) {
    if (Math.abs(err) > 0.6) return { throttle: -0.7, steer: Math.sign(err) }; // wrong way — reverse
    const ahead = samples[(k.trackIdx + 3) % N_SAMPLES];
    const da = Math.atan2(ahead.x - k.pos.x, ahead.z - k.pos.z);
    return { throttle: 0.9, steer: clamp(angDiff(da, k.heading) * 2.2, -1, 1) };
  }
  return { throttle, steer: clamp(err * 2.6, -1.5, 1.5) };
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
