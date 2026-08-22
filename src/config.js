/* ------------------------------------------------------------------ *
 *  TUNING — tweak these to taste
 * ------------------------------------------------------------------ */
export const ACCEL      = 15;      // engine accel (u/s^2)
export const BRAKE      = 26;      // braking decel
export const MAX_SPEED  = 30;      // top speed (u/s)
export const MAX_REV    = 8;       // max reverse speed
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

// AI opponents: N_AI total, skill in [0..1] drives their pace/cornering
export const N_AI         = 3;
export const AI_SKILL     = [0.94, 0.90, 0.86];

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const P2D = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

/* ------------------------------------------------------------------ *
 *  Shared game state — mutate properties, never reassign
 * ------------------------------------------------------------------ */
export const game = {
  state: 'menu',        // menu | countdown | racing | finished
  raceStart: 0,
  raceTime: 0,
  cdText: -1,
  raceOverAt: 0,
  dt: 1 / 60,
};
