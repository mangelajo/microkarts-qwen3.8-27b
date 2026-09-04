import { Kart } from './kart.js';

/* ------------------------------------------------------------------ *
 *  Best-lap persistence + ghost kart ("beat your ghost", ROADMAP 3.3).
 *
 *  Per track we keep the player's best lap: its duration plus a position
 *  timeline recorded at ~10 Hz (every 10th sample of the 60 Hz sim is
 *  plenty for a smooth ghost and keeps localStorage small: a 30 s lap is
 *  ~1.7 KB as rounded flat JSON [x,z,h,…]).
 *
 *  The ghost plays that timeline alongside you, lap clock aligned: it
 *  starts when YOU start a lap, so you always race your best — a step
 *  ahead of you if you're slow, behind if you're fast.
 *
 *  Solo + net-host only: the join client's lap events are mirrored with
 *  host-clock offsets, so recording there would store garbage takes.
 *  Not imported by ai-sim: DOM/localStorage code never runs headless.
 * ------------------------------------------------------------------ */

const SAMPLE_DT = 0.1;          // s between timeline samples (10 Hz)
const KEY = 'mkr-ghost';
const GHOST_COLOR = 0x9fd8ff;   // pale ice-blue — reads as a hologram at low opacity

// store: trackIdx -> { ms, samples: [x,z,h, x,z,h, …] }
let store = {};
let trackIdx = 0;

// ghost carrier: a real Kart mesh we never step — just pose it per frame
let ghost = null;

// live lap: recording state + the timeline we're racing against
let rec = null;                 // [x,z,h,…] growing during the player's current lap
let play = null;                // store[trackIdx] at the moment the lap began
let lapT = 0;                   // s since the current lap started

function load() {
  try { store = JSON.parse(localStorage.getItem(KEY)) || {}; } catch { store = {}; }
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(store)); } catch { /* private mode */ }
}

export function initGhost(idx) {
  load();
  trackIdx = idx;
}

/** Current track's stored best lap in seconds, or null — for the HUD/menu. */
export function getBestMs() {
  const b = store[trackIdx];
  return b ? b.ms : null;
}

function ensureMesh() {
  if (ghost) return;
  ghost = new Kart({ name: 'GHOST', isPlayer: false, color: GHOST_COLOR, accent: GHOST_COLOR });
  ghost.mesh.root.traverse(o => {
    if (o.isMesh) {
      o.material = o.material.clone();  // don't touch shared-with-nothing, but keep shadows off safely
      o.material.transparent = true;
      o.material.opacity = 0.42;
      o.castShadow = false;
    }
  });
  ghost.mesh.root.visible = false;
}

/** Point the ghost at another track (menu / host track change). */
export function ghostSetTrack(idx) {
  trackIdx = idx;
  play = null;
  rec = null;
  if (ghost) ghost.mesh.root.visible = false;
}

/** The player began a lap (GO or a line crossing): start recording, and
 *  race against the best that existed BEFORE this lap (never the one we
 *  might be about to set). */
export function ghostLapStart() {
  ensureMesh();
  rec = [];
  lapT = 0;
  play = store[trackIdx] || null;
}

/** Per-frame while racing: grow the recording, pose the playback ghost.
 *  Called with the player kart; a no-op outside a live lap. */
export function ghostFrame(dt, player) {
  if (!rec) return;
  lapT += dt;
  // record at ~10 Hz — flat triples, rounded to 1 cm
  if (rec.length <= Math.floor(lapT / SAMPLE_DT) * 3) {
    rec.push(+player.pos.x.toFixed(2), +player.pos.z.toFixed(2), +player.heading.toFixed(3));
  }
  poseGhost();
}

function poseGhost() {
  const g = ghost.mesh.root;
  if (!play || !play.samples.length || lapT * 1000 > play.ms) { g.visible = false; return; }
  const f = lapT / SAMPLE_DT;
  const i = Math.min(Math.floor(f), play.samples.length / 3 - 1);
  if (i < 0) { g.visible = false; return; }
  const fr = Math.min(1, f - i);
  const j = Math.min(i + 1, play.samples.length / 3 - 1);
  g.visible = true;
  g.position.set(
    play.samples[i * 3] + (play.samples[j * 3] - play.samples[i * 3]) * fr,
    0,
    play.samples[i * 3 + 1] + (play.samples[j * 3 + 1] - play.samples[i * 3 + 1]) * fr,
  );
  const ha = play.samples[i * 3 + 2], hb = play.samples[j * 3 + 2];
  g.rotation.y = ha + Math.atan2(Math.sin(hb - ha), Math.cos(hb - ha)) * fr; // wrapped lerp
}

/** The player completed a lap of `lapMs`: keep it if it's the best for this
 *  track. Returns true when a new record was stored (main.js can cue it). */
export function ghostLapDone(lapMs) {
  if (!rec) return false;
  const cur = store[trackIdx];
  if (lapMs > 0 && (!cur || lapMs < cur.ms)) {
    store[trackIdx] = { ms: Math.round(lapMs), samples: rec };
    save();
    rec = null;
    return true;
  }
  rec = null;
  return false;
}

/** Race over / back to menu / link lost: park the ghost. */
export function ghostStop() {
  rec = null;
  play = null;
  if (ghost) ghost.mesh.root.visible = false;
}
