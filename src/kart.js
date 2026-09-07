import * as THREE from 'three';
import {
  ACCEL, BRAKE, MAX_SPEED, MAX_REV, DRAG, OFF_DRAG, OFF_GRIP, STEER_RATE, MAX_VISUAL_STEER,
  ROAD_HW, WHEEL_R, N_SAMPLES, LAPS, KMH_PER_U, clamp, turnFactor, GRAVITY,
  FALL_G, FELL_MIN_HEIGHT, FELL_PENALTY,
  DRIFT_MIN_KMH, DRIFT_STEER, DRIFT_GRIP, DRIFT_MAX_SLIP, DRIFT_DRAG,
  DRIFT_CHARGE_MAX, DRIFT_CHARGE_MIN, BOOST_ACCEL, BOOST_HEADROOM,
} from './config.js';
import { scene } from './scene.js';
import { samples, trackLen, sampleHead } from './track.js';
import { makeBlastFx } from './blastfx.js';

// orientation: tilt around the kart's OWN left-right axis, then yaw. Euler
// x+y would yaw first and pitch around WORLD X, so the wheels dug into
// sloped sections whenever the heading wasn't aligned with the Z axis.
const _qY = new THREE.Quaternion();
const _qX = new THREE.Quaternion();
const _AX = new THREE.Vector3(1, 0, 0);
const _AY = new THREE.Vector3(0, 1, 0);

export function makeKart(bodyColor, accentColor) {
  const root = new THREE.Group();
  const bodyGroup = new THREE.Group();        // jolts: chassis, driver, cockpit, aero
  root.add(bodyGroup);

    // --- materials -------------------------------------------------------
  const paint    = new THREE.MeshStandardMaterial({ color: bodyColor,  roughness: 0.28, metalness: 0.15 });
  const accent   = new THREE.MeshStandardMaterial({ color: accentColor, roughness: 0.32, metalness: 0.25 });
  const carbon   = new THREE.MeshStandardMaterial({ color: 0x1a1c21,      roughness: 0.5,  metalness: 0.4 });
  const chrome   = new THREE.MeshStandardMaterial({ color: 0xb9c0c9,      roughness: 0.18, metalness: 0.95 });
  const rimMat   = new THREE.MeshStandardMaterial({ color: 0xd6d7dc,      roughness: 0.3,  metalness: 0.9 });
  const tireMat  = new THREE.MeshStandardMaterial({ color: 0x131315,      roughness: 0.95 });
  const discMat  = new THREE.MeshStandardMaterial({ color: 0x8b9098,      roughness: 0.35, metalness: 0.85 });
  const caliperMat = new THREE.MeshStandardMaterial({ color: accentColor, emissive: new THREE.Color(accentColor), emissiveIntensity: 0.35, roughness: 0.4, metalness: 0.2 });
  const helmetMat = new THREE.MeshStandardMaterial({ color: 0xf2f2f4,     roughness: 0.24, metalness: 0.1 });
  const visorMat  = new THREE.MeshStandardMaterial({ color: 0x101a24,     roughness: 0.08, metalness: 0.6 });
  const exhaustGlow = new THREE.MeshStandardMaterial({ color: 0xff7a24, emissive: new THREE.Color(0xff5210), emissiveIntensity: 1.0, roughness: 0.4 });
  const brakeLight = new THREE.MeshStandardMaterial({ color: 0xff2a1a, emissive: new THREE.Color(0xff2010), emissiveIntensity: 1.3, roughness: 0.3 });

    // --- helpers ---------------------------------------------------------
  const addMesh = (geo, mat, x, y, z, parent = bodyGroup) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    parent.add(m);
    return m;
    };
  const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _d = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);
    // a strut / arm between two points (suspension legs, wing struts, exhaust pipes)
  const arm = (ax, ay, az, bx, by, bz, r, mat, parent = bodyGroup, seg = 6) => {
     _a.set(ax, ay, az); _b.set(bx, by, bz);
      _d.subVectors(_b, _a); const len = _d.length();
    if (len < 1e-4) return;
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, seg), mat);
     _d.normalize();
    m.position.set((ax + bx) * 0.5, (ay + by) * 0.5, (az + bz) * 0.5);
    m.quaternion.setFromUnitVectors(_up, _d);
    m.castShadow = true;
    parent.add(m);
    return m;
    };
  const box = (g, w, h, d, x, y, z, mat) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z); m.castShadow = true; g.add(m); return m;
    };

    /* --- chassis / bodywork -------------------------------------------- */
  box(bodyGroup, 1.5, 0.16, 2.5, 0, 0.35, -0.05, carbon);          // carbon floor / skid pan
  box(bodyGroup, 0.9, 0.06, 1.9, 0, 0.24, -0.1, carbon);           // low under-tray
  for (const s of [1, -1]) box(bodyGroup, 0.36, 0.42, 1.3, s * 0.56, 0.58, -0.1, paint);    // sidepods
  for (const s of [1, -1]) box(bodyGroup, 0.30, 0.10, 1.1, s * 0.56, 0.42, -0.1, carbon);   // intake slot
  box(bodyGroup, 1.3, 0.42, 1.5, 0, 0.62, 0.25, paint);            // main tub (front-weighted)
  box(bodyGroup, 0.94, 0.34, 0.8, 0, 0.94, -0.85, paint);          // raised engine deck / hump
  box(bodyGroup, 0.5, 0.14, 0.2, 0, 1.14, -0.72, carbon).rotation.x = -0.5;                // angled air scoop
  box(bodyGroup, 0.7, 0.10, 0.12, 0, 1.06, -1.05, accent);                                // top intake trim

    /* --- nose + front wing --------------------------------------------- */
  const nose = addMesh(new THREE.ConeGeometry(0.5, 1.0, 14), paint, 0, 0.42, 1.02);
  nose.rotation.x = Math.PI / 2; nose.scale.set(1.05, 1.4, 1.0);        // stretch lengthwise
  addMesh(new THREE.BoxGeometry(1.7, 0.07, 0.4), carbon, 0, 0.28, 1.5);              // front splitter
  addMesh(new THREE.BoxGeometry(1.5, 0.06, 0.5), paint, 0, 0.40, 1.42);            // front wing plate
  for (const s of [1, -1]) addMesh(new THREE.BoxGeometry(0.06, 0.20, 0.5), paint, s * 0.78, 0.36, 1.42);    // endplates
  for (const s of [1, -1]) addMesh(new THREE.BoxGeometry(0.34, 0.12, 0.1), carbon, s * 0.34, 0.44, 1.18);    // coolers

    /* --- open cockpit + driver + helmet -------------------------------- */
  addMesh(new THREE.BoxGeometry(0.66, 0.16, 0.44), accent, 0, 0.84, -0.20);        // cockpit rim
  addMesh(new THREE.BoxGeometry(0.62, 0.10, 0.66), carbon, 0, 0.74, -0.22);        // seat base
  addMesh(new THREE.BoxGeometry(0.60, 0.46, 0.10), carbon, 0, 0.98, -0.5).rotation.x = 0.32;   // seat back
    // roll hoop: two posts + arch bar behind the driver
  arm(-0.16, 1.0, -0.62, -0.16, 1.46, -0.60, 0.05, carbon);
  arm( 0.16, 1.0, -0.62,  0.16, 1.46, -0.60, 0.05, carbon);
  addMesh(new THREE.BoxGeometry(0.36, 0.10, 0.10), carbon, 0, 1.47, -0.60);
    // steering wheel in front of the driver (ring faces +z, toward the helmet)
  addMesh(new THREE.TorusGeometry(0.15, 0.028, 8, 20), chrome, 0, 0.90, 0.16);
  addMesh(new THREE.CylinderGeometry(0.04, 0.04, 0.14, 10), carbon, 0, 0.90, 0.16).rotation.x = Math.PI / 2;
    // helmet + tinted visor + accent fin/stripe
  addMesh(new THREE.SphereGeometry(0.20, 16, 14), helmetMat, 0, 1.06, -0.34);
  const visor = addMesh(new THREE.SphereGeometry(0.17, 12, 10), visorMat, 0, 1.07, -0.19);
  visor.scale.set(0.9, 0.62, 0.6);
  addMesh(new THREE.BoxGeometry(0.14, 0.14, 0.03), accent, 0, 1.25, -0.32);        // top fin
  addMesh(new THREE.BoxGeometry(0.05, 0.30, 0.34), accent, 0, 1.05, -0.32);        // side stripe

    /* --- rear wing ----------------------------------------------------- */
  for (const s of [1, -1]) arm(0, 1.0, -1.25, s * 0.7, 1.36, -1.35, 0.045, chrome);   // struts
  addMesh(new THREE.BoxGeometry(1.7, 0.06, 0.46), paint, 0, 1.38, -1.35);            // main element
  addMesh(new THREE.BoxGeometry(1.5, 0.05, 0.28), carbon, 0, 1.30, -1.2);           // flap
  for (const s of [1, -1]) addMesh(new THREE.BoxGeometry(0.07, 0.34, 0.5), paint, s * 0.82, 1.30, -1.35);   // endplates
  addMesh(new THREE.BoxGeometry(1.4, 0.05, 0.05), accent, 0, 1.34, -1.05);          // centre spine
  addMesh(new THREE.BoxGeometry(0.5, 0.06, 0.05), brakeLight, 0, 1.30, -1.58);      // taillight

    /* --- dual chrome exhausts with glowing tips ------------------------ */
  for (const s of [1, -1]) {
    arm(s * 0.30, 0.86, -0.98, s * 0.34, 0.98, -1.5, 0.05, chrome);
    addMesh(new THREE.CylinderGeometry(0.055, 0.055, 0.1, 10), exhaustGlow, s * 0.35, 1.0, -1.55).rotation.x = Math.PI / 2;
    }

     /* --- exhaust blast: flame + smoke above BLAST_KMH (src/blastfx.js) --- */
     // FX parents to root so it inherits heading + position; particles are
     // emitted at the two rear exhaust tips and trail backwards (-z).
  const tips = [new THREE.Vector3( 0.35, 1.0, -1.55), new THREE.Vector3(-0.35, 1.0, -1.55)];
  const blast = makeBlastFx(root, tips);

    /* --- livery -------------------------------------------------------- */
  addMesh(new THREE.BoxGeometry(0.16, 0.03, 1.5), accent, 0, 0.86, 0.2);            // centre stripe
  for (const s of [1, -1]) addMesh(new THREE.BoxGeometry(0.05, 0.36, 1.1), accent, s * 0.55, 0.58, -0.1);   // side accent

    /* --- wheels: tyre + tread ring, 5-spoke rim, hub, disc, caliper, arm */
  const wheels = [];
  const frontPivots = [];
  const wheelGeo = new THREE.CylinderGeometry(WHEEL_R, WHEEL_R, 0.34, 22);
  wheelGeo.rotateZ(Math.PI / 2);               // axle along local X
  const treadGeo = new THREE.TorusGeometry(WHEEL_R, 0.055, 8, 22); treadGeo.rotateY(Math.PI / 2); // tread ring around X
  const discGeo = new THREE.CylinderGeometry(WHEEL_R * 0.6, WHEEL_R * 0.6, 0.05, 16); discGeo.rotateZ(Math.PI / 2);
  const hubGeo = new THREE.CylinderGeometry(WHEEL_R * 0.34, WHEEL_R * 0.42, 0.12, 12); hubGeo.rotateZ(Math.PI / 2);
  const spokeGeo = new THREE.BoxGeometry(0.05, WHEEL_R * 1.05, 0.05);
  const addWheel = (x, z, front) => {
      // anchor = steering pivot (front) or static mount (rear), centred on the wheel
    const anchor = new THREE.Group();
    anchor.position.set(x, WHEEL_R, z);
    root.add(anchor);
    if (front) frontPivots.push(anchor);
    const outer = Math.sign(x) || 1;         // which way faces away from the car centre
    const inb = -outer * 0.10;               // inboard (toward car centre)
    const wheel = new THREE.Mesh(wheelGeo, tireMat); wheel.castShadow = true;
    anchor.add(wheel);                        // wheel spins; its children spin with it
      // tread ring on the outer face
    const tread = new THREE.Mesh(treadGeo, tireMat); tread.position.x = outer * 0.12; wheel.add(tread);
      // rim cap + 5 rotating spokes
    addMesh(hubGeo, rimMat, 0, 0, outer * 0.10, wheel);
    for (let i = 0; i < 5; i++) {
      const ang = (i / 5) * Math.PI * 2;
      const sp = new THREE.Mesh(spokeGeo, rimMat);
      sp.position.set(outer * 0.10, Math.cos(ang) * WHEEL_R * 0.42, Math.sin(ang) * WHEEL_R * 0.42);
      sp.rotation.x = ang;
      sp.castShadow = true;
      wheel.add(sp);
      }
      // brake disc (spins with wheel) + caliper (fixed to the knuckle, does not spin)
    const disc = new THREE.Mesh(discGeo, discMat); disc.position.x = inb; wheel.add(disc);
    box(anchor, 0.10, 0.16, 0.14, inb, 0.02, 0.0, caliperMat);                  // caliper fixed to the knuckle
      // A-arm suspension: two inboard chassis links -> wheel hub
    arm(inb * 1.6, 0.44, z + 0.16, x, WHEEL_R, z + 0.02, 0.035, carbon, root);
    arm(inb * 1.6, 0.18, z - 0.16, x, WHEEL_R, z - 0.02, 0.035, carbon, root);
    wheels.push(wheel);
    return wheel;
    };
  addWheel( 0.85,    1.05, true);
  addWheel(-0.85,    1.05, true);
  addWheel( 0.85,   -1.05, false);
  addWheel(-0.85,   -1.05, false);

  scene.add(root);
  return { root, bodyGroup, wheels, frontPivots, exhaustGlow, blast };
}


/* ------------------------------------------------------------------ *
 *  Kart entity: integrates arcade driving physics along the track
 * ------------------------------------------------------------------ */
export class Kart {
  constructor(opts) {
    this.isPlayer = !!opts.isPlayer;
    this.net = !!opts.net; // driven over the LAN (host routes input from the wire, never aiControl)
    this.name = opts.name || (this.isPlayer ? 'YOU' : 'RIVALE');
    this.skill = opts.skill ?? 0.9;
    const color = opts.color || 0xe0392b;
    this.color = color;                          // body paint — also the minimap dot colour
    const accent = opts.accent ?? (((color >> 8) & 255) | 0x808080);
    this.mesh = makeKart(color, accent);
    this.pos = new THREE.Vector3();
    this.heading = 0;
    this.speed = 0;
    this.vy = 0;             // vertical velocity while falling off the road
    this.fellOff = false;    // fell off an elevated track: stunned, respawn pending
    this.fellTimer = 0;
    this.fallY = 0;          // road height while on the road ("fell from" marker)
    this.slope = 0;          // road rise/run under us (PLAN.md 3D elevation)
    this.pitch = 0;          // smoothed mesh tilt (rad) to the road slope
    this.offRoad = false;
    this.lapDone = 0;
    this.laps = LAPS;          // per-race lap count (net host sets it from the start frame)
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
    this.jolt = 0;        // collision impact intensity 0..1 — decays, drives the body kick
    this.joltPhase = Math.random() * 6.28; // per-kart phase so paired karts kick differently
    // drift state (see step()): velDir = direction the kart actually MOVES in;
    // while sliding it lags behind heading, which is what a slide physically is
    this.velDir = 0;
    this.slip = 0;        // heading - velDir while sliding (rad, signed) — visuals + audio
    this.drifting = false;
    this.charge = 0;      // 0..DRIFT_CHARGE_MAX seconds of held slide
    this.boost = 0;       // 0..1 decaying mini-boost — drift release OR boost pads (pads.js)
    this.boostEdge = false; // true for one frame after a boost fires (main.js sfx)
    // boost-pad chain bookkeeping (pads.js hitPads)
    this.padT = 0; this.padChain = 0; this.padStrip = -1; this.padPrevCell = -1; this.padLast = -1;
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
    this.vy = 0;
    this.fellOff = false;
    this.fellTimer = 0;
    this.fallY = P.y;
    this.lapDone = 0;              // grid sits behind the line
    this.hasMid = false;
    this.prevU = tt;
    this.trackIdx = Math.floor(tt * n) % n;
    this.slope = (samples[(i1) % n].y - samples[(i + n - 1) % n].y) / Math.max(1e-6, 2 * trackLen / n);
    this.lapTimes = [];
    this.raceDone = false;
    this.netOn = false;      // host-side: peer's kart drives from the wire after GO
    this.steerVel = 0;
    this.posIdx = 0;
    this.lane = offset * 0.9;      // keep the grid side as a racing lane
    this.velDir = this.heading;
    this.slip = 0;
    this.drifting = false;
    this.charge = 0;
    this.boost = 0;
    this.boostEdge = false;
    this.padT = 0; this.padChain = 0; this.padStrip = -1; this.padPrevCell = -1; this.padLast = -1;
    this.mesh.root.position.copy(this.pos);
    this.pitch = -Math.atan(this.slope);
    this.setOrientation();
  }

  /* tilt to the slope, then yaw (quaternion — see note at top) */
  setOrientation() {
    _qX.setFromAxisAngle(_AX, this.pitch);
    _qY.setFromAxisAngle(_AY, this.heading);
    this.mesh.root.quaternion.copy(_qY.multiply(_qX));
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
        if (this.lapDone >= (this.laps || LAPS)) this.raceDone = true;
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

  /* fell off an elevated track: back on the racing line after the penalty */
  respawnToTrack() {
    const i = this.trackIdx; // nearest sample, maintained by nearestTrack()
    this.pos.set(samples[i].x, samples[i].y, samples[i].z);
    this.heading = sampleHead[i];
    this.velDir = this.heading;
    this.speed = 0;
    this.vy = 0;
    this.fellOff = false;
    this.fellTimer = 0;
    this.fallY = samples[i].y;
  }

  step(dt, throttle, steerIn, now, drift = false) {
    this.steerVel += (steerIn - this.steerVel) * Math.min(1, 12 * dt);
    const th = this.raceDone ? 0 : throttle;

    // --- drift engage/release ------------------------------------------
    // Asphalt only, forward, above speed. Releasing a charged slide fires the boost.
    const wantDrift = !!drift && !this.offRoad && !this.raceDone
      && this.speed > DRIFT_MIN_KMH / KMH_PER_U;
    if (wantDrift) this.drifting = true;
    else if (this.drifting) {
      this.drifting = false;
      if (this.charge >= DRIFT_CHARGE_MIN) {
        this.boost = Math.min(this.charge / DRIFT_CHARGE_MAX, 1);
        this.boostEdge = true;              // main.js plays the whoosh once
      }
      this.charge = 0;
    }

    if (th > 0) this.speed += ACCEL * (this.offRoad ? OFF_GRIP : 1) * dt;
    else if (th < 0) this.speed -= (this.speed > 0 ? BRAKE : ACCEL * 0.7) * dt;
    this.speed -= this.speed * (this.drifting ? DRIFT_DRAG : DRAG) * dt;   // slides keep momentum
    if (this.offRoad) this.speed -= Math.sign(this.speed) * Math.min(Math.abs(this.speed), OFF_DRAG * dt);
    if (this.drifting) this.charge = Math.min(this.charge + dt * (0.55 + Math.abs(this.steerVel)), DRIFT_CHARGE_MAX);
    if (this.boost > 0) {
      this.speed += BOOST_ACCEL * this.boost * dt;
      this.boost *= Math.exp(-2.2 * dt);
      if (this.boost < 0.02) this.boost = 0;
    }
    this.speed = clamp(this.speed, -MAX_REV, MAX_SPEED * (1 + BOOST_HEADROOM * this.boost));
    if (th === 0 && Math.abs(this.speed) < 0.03) this.speed = 0;

    // sliding buys steering authority — the classic kart trade
    const steerMul = turnFactor(this.speed) * (this.drifting ? DRIFT_STEER : 1);
    this.heading += this.steerVel * STEER_RATE * steerMul * (this.speed < 0 ? -1 : 1) * dt;

    // motion direction: glued to the nose unless sliding, where it follows
    // at DRIFT_GRIP with a hard slip cap (so slides stay controllable)
    if (this.drifting) {
      let d = this.heading - this.velDir;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.velDir += d * Math.min(1, DRIFT_GRIP * dt);
      d = this.heading - this.velDir;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      if (Math.abs(d) > DRIFT_MAX_SLIP) this.velDir = this.heading - Math.sign(d) * DRIFT_MAX_SLIP;
      this.slip = this.heading - this.velDir;
    } else {
      this.velDir = this.heading;
      this.slip = 0;
    }
    this.pos.x += Math.sin(this.velDir) * this.speed * dt;
    this.pos.z += Math.cos(this.velDir) * this.speed * dt;
    if (!this.raceDone) this.updateLapLogic(now);
    // 3D elevation, real physics: STICK to the road only when you are on it
    // AND at its height — a kart on the table UNDER the track is never lifted
    // (no magic). Off the road the kart falls under gravity to the table.
    // Falling off an elevated track = FELL_PENALTY s stunned, then respawn
    // on the nearest track point. Flat tracks: roadY ≈ 0, nothing changes.
    {
      const n = N_SAMPLES, i = this.trackIdx;
      const roadY = samples[i].y;
      if (!this.offRoad && Math.abs(this.pos.y - roadY) < 1.5) {
        // on the road: stuck to the surface, slope drives speed
        this.slope = (samples[(i + 1) % n].y - samples[(i + n - 1) % n].y) / Math.max(1e-6, 2 * trackLen / n);
        this.speed += -this.slope * GRAVITY * dt;
        this.pos.y = roadY;
        this.vy = 0;
        this.fellOff = false;
        this.fellTimer = 0;
        this.fallY = roadY;   // remember the height we are on (for fall-off)
      } else {
        this.slope = 0;
        if (this.pos.y > 0.01) {                 // falling to the table
          this.vy -= FALL_G * dt;
          this.pos.y += this.vy * dt;
          if (this.pos.y <= 0) { this.pos.y = 0; this.vy = 0; }
        } else if (Math.max(this.fallY, roadY) > FELL_MIN_HEIGHT) { // fell off, or driving on the table under an elevated track
          if (!this.fellOff) { this.fellOff = true; this.fellTimer = FELL_PENALTY; }
          this.speed = 0;                        // stunned
          this.fellTimer -= dt;
          if (this.fellTimer <= 0) this.respawnToTrack();
        }
      }
    }
  }

  sync(dt) {
    this.mesh.root.position.copy(this.pos);
    // pitch to the road slope (tilt then yaw, smoothed so crest crossings
    // don't jack the chassis)
    this.pitch += (-Math.atan(this.slope) - this.pitch) * Math.min(1, 10 * dt);
    this.setOrientation();
    this.wheelSpin += this.speed * dt / WHEEL_R;
    for (const w of this.mesh.wheels) w.rotation.x = this.wheelSpin;
    for (const p of this.mesh.frontPivots) p.rotation.y = this.steerVel * MAX_VISUAL_STEER;
    const sp = Math.min(Math.abs(this.speed) / MAX_SPEED, 1);
     // exhaust tips flare from an idle glow up to a hot orange as revs build
    const glow = this.mesh.exhaustGlow;
    if (glow) glow.emissiveIntensity = 0.35 + sp * 1.7 + this.boost * 1.6 + 0.18 * Math.abs(Math.sin(this.wheelSpin * 2.3 + this.joltPhase));
    let rollT = this.steerVel * 0.22 * sp;
    if (this.drifting) rollT += this.slip * 0.3;   // leaning into the slide
    const pitchT = (Math.abs(this.speed) > 0.5 ? -0.03 : 0) * (sp + 0.3);
    // collision juice: a fast, damped roll/pitch kick on impact
    const j = this.jolt * Math.cos(this.joltPhase + 22 * dt) * 0.35;
    this.mesh.bodyGroup.rotation.z += (rollT + j - this.mesh.bodyGroup.rotation.z) * Math.min(1, 14 * dt);
    this.mesh.bodyGroup.rotation.x += (pitchT + j * 0.5 - this.mesh.bodyGroup.rotation.x) * Math.min(1, 14 * dt);
    this.jolt *= Math.exp(-6 * dt);
    if (this.jolt < 0.01) this.jolt = 0;
      // exhaust blast: above BLAST_KMH the kart sprays flame + smoke from its tips
    const b = this.mesh.blast;
    if (b) b.update(dt, this.speed);
  }
}
