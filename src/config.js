/* ------------------------------------------------------------------ *
 *  TUNING — tweak these to taste
 * ------------------------------------------------------------------ */
export let ACCEL      = 15;      // engine accel (u/s^2)
export let BRAKE      = 26;      // braking decel
export let MAX_SPEED  = 30;      // top speed (u/s)
export let MAX_REV    = 8;       // max reverse speed
export let KMH_PER_U    = 7;          // speed readout: km/h = |speed| * KMH_PER_U
export let BLAST_KMH    = 180;        // exhaust flame + smoke kicks in above this speed
export let DRAG       = 0.55;    // per-second exponential drag
export let OFF_DRAG   = 4.5;     // extra drag when off the asphalt
export let OFF_GRIP   = 0.45;    // acceleration multiplier off track
export let STEER_RATE = 2.7;     // base steering rate (rad/s @ full grip)
export let MAX_VISUAL_STEER = 0.5; // max front-wheel yaw (rad) at full steer
export let ROAD_HW    = 4.2;     // road half-width (u)
export let CURB_W     = 0.9;     // curb strip width
export let LAPS       = 3;
export let WHEEL_R    = 0.34;
export let CAM_DIST   = 7.5;
export let CAM_HEIGHT = 3.3;
export const N_SAMPLES  = 1000;    // track sampling resolution

// 3D elevation (PLAN.md): karts stick to the road, slope drives speed.
// GRAVITY is arcade-tuned (not 9.8): speed += -slope * GRAVITY * dt
export let GRAVITY          = 4;   // slope gravity (u/s^2 per unit of rise/run)
export let FALL_G           = 20;  // u/s^2: real gravity when a kart drops off the road
export let FELL_MIN_HEIGHT  = 1.5; // road this high (or more) = "fell off" when you land
export let FELL_PENALTY     = 2.5; // s: stun on the table, then respawn on the track
export let JUMP_MIN_SPEED   = 5;   // u/s: crest launch only above this speed
export let TUMBLE_RATE      = 2.4;  // rad/s: the kart rolls in the fall direction
export let SLOPE_BRAKE_FACTOR = 20; // AI target-speed cut per unit of uphill slope
export let MAX_ELEVATION  = 20;   // soft cap: taller control points are scaled down

// Skid-to-drift: hold the drift input (Space / full-lock touch drag) above
// DRIFT_MIN_KMH on asphalt — the nose steers in faster than the motion follows
// (a real slide), charge builds, and releasing fires a mini-boost scaled by it.
export let DRIFT_MIN_KMH    = 95;    // below this speed the drift button does nothing
export let DRIFT_STEER      = 1.5;   // steering-rate multiplier while sliding
export let DRIFT_GRIP       = 2.6;   // how fast the motion snaps behind the nose (1/s)
export let DRIFT_MAX_SLIP   = 0.7;   // max nose-vs-motion angle while sliding (rad)
export let DRIFT_DRAG       = 0.35;  // drag while sliding (lower than grip = faster lines)
export let DRIFT_CHARGE_MAX = 1.5;   // seconds of slide for a full-charge boost
export let DRIFT_CHARGE_MIN = 0.4;   // shorter slides release nothing
export let BOOST_ACCEL      = 26;    // boost kick acceleration (u/s^2)
export let BOOST_HEADROOM   = 0.28;  // top-speed extension at full boost

// Item boxes (items.js): N_ITEM_BOXES seeded boxes per track grant weighted
// power-ups. Turbo = instant boost (the drift/pad currency); wall = a
// projectile that slams the first kart it touches; rubber band = passive —
// a trailing holder gets a push scaled by the gap to the leader (MK8-style:
// pressing E while holding the rubber does nothing). Boxes are OFF by
// default so the headless gates stay pure no-regression harnesses.
export const ITEM_NONE   = 0;
export const ITEM_TURBO  = 1;
export const ITEM_RUBBER = 2;
export const ITEM_WALL   = 3;
export const ITEM_NAMES  = { 1: 'TURBO', 2: 'RUBBER', 3: 'WALL' };
export let ITEM_WEIGHTS   = [45, 30, 25]; // turbo / rubber / wall
export let N_ITEM_BOXES   = 3;
export let ITEM_RESPAWN   = 8;     // s: a picked-up box reappears after this
export let ITEM_COOLDOWN  = 0.25;  // s: per-kart pickup debounce
export let ITEM_PICKUP_R  = 2.0;   // u: distance to box centre that counts
export let RUBBER_ACCEL   = 9;     // u/s²: max push for the trailing holder
export let WALL_SPEED     = 32;    // u/s (beats kart top speed so close shots land)
export let WALL_LIFE      = 2.8;   // s
export let WALL_HIT_R     = 2.0;   // u: combined wall+kart hit radius
export let WALL_HIT_KILL  = 0.4;   // target speed multiplier on hit

// AI opponents: N_AI total, skill in [0..1] drives their pace/cornering.
// Deliberate spread: one front-runner, one mid-packer, one back-marker.
export let N_AI         = 3;
export let AI_SKILL     = [0.96, 0.85, 0.62];

// 2-player LAN (see plans/2_player_lan.md)
export let SIM_DT       = 1 / 60;  // fixed sim step for the networked host (solo keeps variable step)
export let COUNTDOWN_MS = 3000;  // ms: pre-GO countdown (host sim clock + client wall clock)
export let INTERP_DELAY = 50;      // ms the client interpolates in the past (hides LAN jitter)
export let P2_COLOR     = 0x1fc9b8; // player-2 kart (teal), distinct from solo red
export let N_AI_2P      = 2;       // 2P default roster: 2 humans + 2 AI

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const P2D = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

// steering authority vs speed (shared by kart.js and the net client's extrapolator)
export function turnFactor(s) {
  const a = Math.abs(s);
  const grip = Math.min(a / 6, 1);                            // no turning while (nearly) still
  const calm = 1 - 0.3 * Math.min(a / MAX_SPEED, 1);          // less twitchy at speed
  return grip * calm;
}

/* ------------------------------------------------------------------ *
 *  Shared game state — mutate properties, never reassign
 * ------------------------------------------------------------------ */
export const game = {
  state: 'menu',        // menu | countdown | racing | finished
  laps: LAPS,           // laps for the current race (2P host broadcasts via start frame)
  roster: '2ai',        // 2P roster: '2ai' = 2 humans + 2 AI · '1v1' = humans only
  raceStart: 0,
  raceTime: 0,
  cdText: -1,
  raceOverAt: 0,
  dt: 1 / 60,
  lastLapBeep: 0,       // player lapDone when we last beeped (lap audio debounce)
  // 2P render mirror (client only): host-authoritative values we copy
  net: null,            // { hostMs, karts, echoPing } latest raw state frame
};

/* ------------------------------------------------------------------ *  Runtime tuning (ai-sim playground) — `tuneConfig({ ACCEL: 20 })`
 * overwrites any constant in place. The `let` exports above are LIVE
 * bindings, so every importer (kart.js, track.js, …) reads the current
 * value on every tick — no restart, no reload. Unknown names are
 * ignored; validate against TUNE_NAMES first.
 * N_SAMPLES is const on purpose: track.js bakes it into module-scope
 * arrays at import time, so a live change would silently mismatch.
 * ------------------------------------------------------------------ */
const _tune = {
  // physics
  ACCEL: v => ACCEL = v,
  BRAKE: v => BRAKE = v,
  MAX_SPEED: v => MAX_SPEED = v,
  MAX_REV: v => MAX_REV = v,
  KMH_PER_U: v => KMH_PER_U = v,
  BLAST_KMH: v => BLAST_KMH = v,
  DRAG: v => DRAG = v,
  OFF_DRAG: v => OFF_DRAG = v,
  OFF_GRIP: v => OFF_GRIP = v,
  STEER_RATE: v => STEER_RATE = v,
  MAX_VISUAL_STEER: v => MAX_VISUAL_STEER = v,
  ROAD_HW: v => ROAD_HW = v,
  CURB_W: v => CURB_W = v,
  LAPS: v => LAPS = v,
  WHEEL_R: v => WHEEL_R = v,
  CAM_DIST: v => CAM_DIST = v,
  CAM_HEIGHT: v => CAM_HEIGHT = v,
  // 3D elevation
  GRAVITY: v => GRAVITY = v,
  FALL_G: v => FALL_G = v,
  FELL_MIN_HEIGHT: v => FELL_MIN_HEIGHT = v,
  FELL_PENALTY: v => FELL_PENALTY = v,
  JUMP_MIN_SPEED: v => JUMP_MIN_SPEED = v,
  TUMBLE_RATE: v => TUMBLE_RATE = v,
  SLOPE_BRAKE_FACTOR: v => SLOPE_BRAKE_FACTOR = v,
  MAX_ELEVATION: v => MAX_ELEVATION = v,
  // drift
  DRIFT_MIN_KMH: v => DRIFT_MIN_KMH = v,
  DRIFT_STEER: v => DRIFT_STEER = v,
  DRIFT_GRIP: v => DRIFT_GRIP = v,
  DRIFT_MAX_SLIP: v => DRIFT_MAX_SLIP = v,
  DRIFT_DRAG: v => DRIFT_DRAG = v,
  DRIFT_CHARGE_MAX: v => DRIFT_CHARGE_MAX = v,
  DRIFT_CHARGE_MIN: v => DRIFT_CHARGE_MIN = v,
  BOOST_ACCEL: v => BOOST_ACCEL = v,
  BOOST_HEADROOM: v => BOOST_HEADROOM = v,
  // items
  ITEM_WEIGHTS: v => ITEM_WEIGHTS = v,
  N_ITEM_BOXES: v => N_ITEM_BOXES = v,
  ITEM_RESPAWN: v => ITEM_RESPAWN = v,
  ITEM_COOLDOWN: v => ITEM_COOLDOWN = v,
  ITEM_PICKUP_R: v => ITEM_PICKUP_R = v,
  RUBBER_ACCEL: v => RUBBER_ACCEL = v,
  WALL_SPEED: v => WALL_SPEED = v,
  WALL_LIFE: v => WALL_LIFE = v,
  WALL_HIT_R: v => WALL_HIT_R = v,
  WALL_HIT_KILL: v => WALL_HIT_KILL = v,
  // AI
  N_AI: v => N_AI = v,
  AI_SKILL: v => AI_SKILL = v,
  // 2P net
  SIM_DT: v => SIM_DT = v,
  COUNTDOWN_MS: v => COUNTDOWN_MS = v,
  INTERP_DELAY: v => INTERP_DELAY = v,
  P2_COLOR: v => P2_COLOR = v,
  N_AI_2P: v => N_AI_2P = v,
};

/**
 * Runtime tuning (ai-sim playground): overwrite any tuning constant in
 * place. The `let` export bindings are live, so every importer (kart.js,
 * track.js, …) sees the new value from the next tick — the playground
 * resets the race afterwards so the run starts clean. Unknown names are
 * ignored; validate with TUNE_NAMES first.
 */
export function tuneConfig(partial) {
  for (const [k, v] of Object.entries(partial)) {
    const set = _tune[k];
    if (set) set(v);
  }
}
export const TUNE_NAMES = Object.keys(_tune);

