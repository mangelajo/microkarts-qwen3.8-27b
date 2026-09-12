/* ------------------------------------------------------------------ *
 *  TUNING — tweak these to taste
 * ------------------------------------------------------------------ */
export const ACCEL      = 15;      // engine accel (u/s^2)
export const BRAKE      = 26;      // braking decel
export const MAX_SPEED  = 30;      // top speed (u/s)
export const MAX_REV    = 8;       // max reverse speed
export const KMH_PER_U    = 7;          // speed readout: km/h = |speed| * KMH_PER_U
export const BLAST_KMH    = 180;        // exhaust flame + smoke kicks in above this speed
export const DRAG       = 0.55;    // per-second exponential drag
export const OFF_DRAG   = 4.5;     // extra drag when off the asphalt
export const OFF_GRIP   = 0.45;    // acceleration multiplier off track
export const STEER_RATE = 2.7;     // base steering rate (rad/s @ full grip)
export const MAX_VISUAL_STEER = 0.5; // max front-wheel yaw (rad) at full steer
export const ROAD_HW    = 4.2;     // road half-width (u)
export const CURB_W     = 0.9;     // curb strip width
export const LAPS       = 3;
export const WHEEL_R    = 0.34;
export const CAM_DIST   = 7.5;
export const CAM_HEIGHT = 3.3;
export const N_SAMPLES  = 1000;    // track sampling resolution

// 3D elevation (PLAN.md): karts stick to the road, slope drives speed.
// GRAVITY is arcade-tuned (not 9.8): speed += -slope * GRAVITY * dt
export const GRAVITY          = 4;   // slope gravity (u/s^2 per unit of rise/run)
export const FALL_G           = 20;  // u/s^2: real gravity when a kart drops off the road
export const FELL_MIN_HEIGHT  = 1.5; // road this high (or more) = "fell off" when you land
export const FELL_PENALTY     = 2.5; // s: stun on the table, then respawn on the track
export const JUMP_MIN_SPEED   = 5;   // u/s: crest launch only above this speed
export const TUMBLE_RATE      = 2.4;  // rad/s: the kart rolls in the fall direction
export const SLOPE_BRAKE_FACTOR = 20; // AI target-speed cut per unit of uphill slope
export const MAX_ELEVATION  = 20;   // soft cap: taller control points are scaled down

// Skid-to-drift: hold the drift input (Space / full-lock touch drag) above
// DRIFT_MIN_KMH on asphalt — the nose steers in faster than the motion follows
// (a real slide), charge builds, and releasing fires a mini-boost scaled by it.
export const DRIFT_MIN_KMH    = 95;    // below this speed the drift button does nothing
export const DRIFT_STEER      = 1.5;   // steering-rate multiplier while sliding
export const DRIFT_GRIP       = 2.6;   // how fast the motion snaps behind the nose (1/s)
export const DRIFT_MAX_SLIP   = 0.7;   // max nose-vs-motion angle while sliding (rad)
export const DRIFT_DRAG       = 0.35;  // drag while sliding (lower than grip = faster lines)
export const DRIFT_CHARGE_MAX = 1.5;   // seconds of slide for a full-charge boost
export const DRIFT_CHARGE_MIN = 0.4;   // shorter slides release nothing
export const BOOST_ACCEL      = 26;    // boost kick acceleration (u/s^2)
export const BOOST_HEADROOM   = 0.28;  // top-speed extension at full boost

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
export const ITEM_WEIGHTS   = [45, 30, 25]; // turbo / rubber / wall
export const N_ITEM_BOXES   = 3;
export const ITEM_RESPAWN   = 8;     // s: a picked-up box reappears after this
export const ITEM_COOLDOWN  = 0.25;  // s: per-kart pickup debounce
export const ITEM_PICKUP_R  = 2.0;   // u: distance to box centre that counts
export const RUBBER_ACCEL   = 9;     // u/s²: max push for the trailing holder
export const WALL_SPEED     = 32;    // u/s (beats kart top speed so close shots land)
export const WALL_LIFE      = 2.8;   // s
export const WALL_HIT_R     = 2.0;   // u: combined wall+kart hit radius
export const WALL_HIT_KILL  = 0.4;   // target speed multiplier on hit

// AI opponents: N_AI total, skill in [0..1] drives their pace/cornering.
// Deliberate spread: one front-runner, one mid-packer, one back-marker.
export const N_AI         = 3;
export const AI_SKILL     = [0.96, 0.85, 0.62];

// 2-player LAN (see plans/2_player_lan.md)
export const SIM_DT       = 1 / 60;  // fixed sim step for the networked host (solo keeps variable step)
export const COUNTDOWN_MS = 3000;  // ms: pre-GO countdown (host sim clock + client wall clock)
export const INTERP_DELAY = 50;      // ms the client interpolates in the past (hides LAN jitter)
export const P2_COLOR     = 0x1fc9b8; // player-2 kart (teal), distinct from solo red
export const N_AI_2P      = 2;       // 2P default roster: 2 humans + 2 AI

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
