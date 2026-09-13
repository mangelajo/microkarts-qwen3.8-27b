// Replays: the sim is 100% deterministic from inputs, so a replay is just
// the player's recorded input stream re-fed to a fresh race on the same
// track + config. Pure + headless-safe.
let frames = [];      // {t: throttle, s: steer, d: drift, i: itemEdge}
let recOn = false;
let recLen = 0;

export function recordStart() {
  frames = [];
  recOn = true;
  recLen = 0;
}
export function recordStop() {
  recOn = false;
}
export function recordFrame(th, st, df, it) {
  if (!recOn) return;
  if (recLen < 60 * 240) {          // cap: ~5 min at 120 Hz (a 3-lap race fits)
    frames.push({ t: th, s: st, d: df, i: it });
    recLen++;
  }
}
export function hasRecording() {
  return frames.length >= 120;      // at least ~1 s of input
}
export function recordingLen() {
  return frames.length;
}
export function playbackFrame(idx) {
  const f = frames[idx];
  return f ? { th: f.t, st: f.s, df: f.d, it: f.i } : null;
}
