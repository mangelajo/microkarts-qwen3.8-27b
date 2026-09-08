/* ------------------------------------------------------------------ *
 *  Headless 2P-LAN harness (plans/2_player_lan.md, P0 safety net)
 *
 *  Runs the REAL host-authoritative path (race.js simulateTick +
 *  kart.js physics) in Node, feeding TWO "human input" streams plus
 *  two AI drivers, and verifies both humans finish on every track.
 *  Also round-trips every wire message (net.js enc/dec) so a header
 *  change breaks here, not in someone's browser.
 *
 *  Run:  make netsim   (or: node --import ./ai-sim/stub.js ai-sim/net-sim.mjs)
 * ------------------------------------------------------------------ */
import * as THREE from 'three';
import { samples, selectTrack, angDiff, curvatureAt, trackLen } from '../src/track.js';
import { TRACKS } from '../src/tracks.js';
import { N_SAMPLES, SIM_DT, LAPS, AI_SKILL, clamp, ITEM_TURBO, ITEM_RUBBER, ITEM_WALL, ITEM_RESPAWN } from '../src/config.js';
import { Kart } from '../src/kart.js';
import { DRIFT_MAX_SLIP, DRIFT_CHARGE_MAX, ROAD_HW } from '../src/config.js';
import { buildPads, hitPads, padList, PAD_STRENGTH } from '../src/pads.js';
import { aiControl } from '../src/ai.js';
import { GRID, simulateTick, raceOrder, progress, collideKarts } from '../src/race.js';
import { setObstaclesOn, buildObstacles, obstacleList } from '../src/obstacles.js';
import { setItemsOn, buildItems, itemBoxList, tickItems, tickRubber, useItem, walls } from '../src/items.js';
import { FrameRing, sampleState, sampleRat } from '../src/interp.js';
import { initGhost, ghostSetTrack, ghostLapStart, ghostFrame, ghostLapDone, ghostStop, getBestMs } from '../src/ghost.js';
import {
  encTrack, encPrep, encStart, decStart,
  encInput, decInput,
  makeStateEncoder, decodeState,
  encFinish, decFinish,
  encBye, T_TRACK, T_PREP, T_BYE,
  codeFromSdp, sdpFromCode,
} from '../src/net.js';

const n = N_SAMPLES;
function posAt(t) {
  const tt = ((t % 1) + 1) % 1;
  const i = Math.floor(tt * n) % n;
  const f = tt * n - i;
  const i1 = (i + 1) % n;
  const P = samples[i].clone().lerp(samples[i1], f);
  const T = samples[i1].clone().sub(samples[i]);
  const Nn = new THREE.Vector3(-T.z, 0, T.x).normalize();
  return { P, T, Nn };
}

/* ------------------------------------------------------------------ *
 *  A naive "human" input stream: full throttle, steer toward a point
 *  on the center line, brake before corners. Deliberately NOT the AI
 *  controller — the sim is about the host-authoritative plumbing, not
 *  how fast a human drives.
 * ------------------------------------------------------------------ */
function humanPilot(k) {
  const { u, lat } = k.nearestTrack();
  const look = 3.5; // u of foresight, scaled down at speed
  const target = posAt(u + (look / trackLen) * clamp(k.speed / 12, 0.35, 1));
  const want = Math.atan2(target.P.x - k.pos.x, target.P.z - k.pos.z);
  const err = angDiff(want, k.heading);
  const K = Math.abs(curvatureAt(u + (look * 1.7) / trackLen));
  const vCorner = Math.sqrt((9.8 * 0.7) / Math.max(K, 1e-4));
  let throttle = 1;
  if (k.speed > vCorner + 3) throttle = -1;                    // brake early
  if (k.offRoad && Math.abs(lat) > 6) throttle = 0;            // calm down wide
  // a human fires eagerly: turbo right away, wall the moment they have one
  const use = k.item === ITEM_TURBO || k.item === ITEM_WALL;
  return { throttle, steer: clamp(err * 2.5, -1, 1), use };
}

/* Regression (user-reported): reversing into another kart's front used to pin
   the driver and shove them forward. A faces -z (heading pi), holds full
   reverse (drives +z) into B's front (B at +2.0, facing -z, idle). After 3 s:
   A must keep making backwards progress; B must roll out of the way. */
function reverseCollisionRegression() {
  const A = new Kart({ isPlayer: true });
  const B = new Kart({ isPlayer: false, net: true, color: 0x111111 });
  A.pos.set(0, 0, 0);    A.heading = Math.PI;   // facing -z; reverse drives +z
  B.pos.set(0, 0, 2.0);  B.heading = Math.PI;   // facing A, idle
  let now = 0, contact = 0;
  for (let i = 0; i < 180; i++) {
    now += 1000 / 60;
    A.step(1 / 60, -1, 0, now);   // full reverse
    B.step(1 / 60, 0, 0, now);    // idle
    const d = Math.hypot(A.pos.x - B.pos.x, A.pos.z - B.pos.z);
    if (d < 2.15) contact++;
    collideKarts([A, B]);
  }
  const aMove = A.pos.z;            // strongly +z expected (kept reversing)
  const bMove = B.pos.z - 2.0;      // +z expected (rolled out of the way)
  const gap = B.pos.z - A.pos.z;    // karts must NOT cross over each other
  const aFwd = Math.sin(A.heading) * A.speed; // + = moving where A's nose points (against held reverse)
  mark(aMove > 1.5, `A keeps reversing into contact (moved +${aMove.toFixed(2)}u, want >+1.5) — was pinned/shoved forward`);
  mark(bMove > 0.8, `B rolled out of the way (moved +${bMove.toFixed(2)}u, want >+0.8)`);
  mark(gap > 1.5, `A not shoved through B (final gap ${gap.toFixed(2)}u, want >1.5)`);
  mark(aFwd < 1.5, `A's forward jolt bounded (end fwd-speed ${aFwd.toFixed(2)}u/s, want <1.5)`);
  // sustained smooth contact (no oscillating push/bounce — the old constant
  // shove made the pair judder apart and back ~3.5x/sec, which read as
  // "the kart I'm reversing into gets shoved forward")
  mark(contact > 150, `contact is smooth and sustained (${contact}/180 ticks, want >150 — old code oscillated)`);
  console.log(`  reverse-into-front: A +${aMove.toFixed(2)}u, B +${bMove.toFixed(2)}u, gap ${gap.toFixed(2)}u, contact ${contact}/180`);
}

let failures = 0;
const mark = (ok, why) => { if (!ok) { failures++; console.log(`  !! FAIL: ${why}`); } };

/* ------------------------------------------------------------------ *
 *  Wire round-trip (pure — same code the browser ships)
 * ------------------------------------------------------------------ */
console.log('\n== regression: reverse-collision shove ==');
reverseCollisionRegression();

console.log('== wire round-trip ==');
mark(new DataView(encTrack(2)).getUint8(0) === T_TRACK, 'track type');
mark(new DataView(encTrack(2)).getUint8(1) === 2, 'track idx');
mark(new DataView(encTrack(2, 1, 1)).getUint8(2) === 1 && new DataView(encTrack(2, 1, 1)).getUint8(3) === 1,
  'track frame carries hazards + items bytes');
mark(new DataView(encTrack(2)).byteLength === 4 && new DataView(encTrack(2)).getUint8(3) === 0,
  'items default off in the track frame');
{
  const prep = encPrep(1, 3000);
  const dv = new DataView(prep);
  mark(dv.getUint8(0) === T_PREP && dv.getUint8(1) === 1 && dv.getUint32(2) === 3000, 'prep frame');
}
{
  const grid = GRID.flatMap(c => [c.u, c.o]);
  const d = decStart(encStart({ karts: 4, laps: LAPS, rosterN: 4, steerFlip: false, simDt: SIM_DT, grid }));
  mark(d.karts === 4 && d.laps === LAPS && d.rosterN === 4 && d.grid.length === 8, 'start header');
  mark(Math.abs(d.simDt - SIM_DT) < 1e-9, 'start simDt');
  for (let i = 0; i < grid.length; i++) mark(Math.abs(d.grid[i] - grid[i]) < 1e-5, `start grid[${i}]`);
}
{
  const d = decInput(encInput(-1, 1, 12345, true, true));
  mark(d.throttle === -1 && d.steer === 1 && d.ping === 12345 && d.drift === true && d.use === true,
    'input frame + drift + use flags');
  mark(decInput(encInput(0.5, -0.5, 7)).drift === false, 'drift defaults to off');
  mark(decInput(encInput(0.5, -0.5, 7)).use === false, 'use defaults to off');
  {   // legacy: a pre-item peer sent a flagless 5-byte frame — both flags false
    const legacy = new Uint8Array([0x10, 64, -13, 0x00, 0x02]);
    const ld = decInput(legacy.buffer);
    mark(ld.use === false && ld.drift === false, 'legacy 5-byte input frame: use = false');
  }
}
/* Drift physics (kart.step): engage gate, slide, charge -> boost, headroom.
 * The kart is rail-ed back onto the centre line each frame — a 90-frame
 * full-lock slide would otherwise throw it off-road, and off-road cuts the
 * drift (which would make these assertions about the gate, not the model). */
console.log('\n== drift: slide model + boost ==');
{
  selectTrack(0);
  const K = new Kart({ isPlayer: true });
  // gate: below DRIFT_MIN_KMH the button does nothing
  K.placeAt(0.25, 0);
  K.speed = 8; K.velDir = K.heading;
  K.step(1 / 60, 1, 0, 0, true);
  mark(K.drifting === false, 'no drift below the speed gate');
  mark(K.slip === 0, 'no slip without a slide');
  // engage + slide: nose outruns the motion direction, capped at DRIFT_MAX_SLIP
  K.placeAt(0.25, 0);
  K.speed = 22; K.velDir = K.heading;
  const P0 = K.pos.clone();
  const rail = () => { K.pos.copy(P0); K.offRoad = false; K.speed = Math.max(K.speed, 20); };
  K.step(1 / 60, 1, 0, 0, true);
  mark(K.drifting === true, 'drift engages at speed on asphalt');
  mark(K.charge > 0 && K.boost === 0, 'charge builds while sliding, boost stays armed off');
  for (let i = 0; i < 20; i++) { K.step(1 / 60, 1, 1, i * 17, true); rail(); }
  mark(Math.abs(K.slip) > 0.15, 'nose outruns motion direction (the slide)');
  mark(Math.abs(K.slip) <= DRIFT_MAX_SLIP + 1e-6, 'slip angle is capped');
  for (let i = 20; i < 90; i++) { K.step(1 / 60, 1, 1, i * 17, true); rail(); }
  mark(K.charge >= DRIFT_CHARGE_MAX - 1e-6, 'charge tops out at DRIFT_CHARGE_MAX');
  // release -> charge converts to boost, motion snaps back behind the nose
  K.step(1 / 60, 1, 0, 99999, false); rail();
  mark(K.drifting === false && K.boost > 0.95, 'full-charge release fires a full boost (decaying)');
  mark(K.boostEdge === true && K.slip === 0, 'boost edge flagged for sfx; slide is over');
  mark(K.charge === 0, 'charge consumed on release');
  const s0 = K.speed;
  for (let i = 0; i < 45; i++) { K.step(1 / 60, 1, 0, 1000 + i * 17, false); rail(); }
  mark(K.speed > 30, `boost headroom exceeds top speed (got ${K.speed.toFixed(1)} > 30)`);
  mark(K.speed > s0 || K.boost >= 0, 'boost decays but never reverses');
  // a too-short slide releases nothing
  K.placeAt(0.25, 0);
  K.speed = 22; K.velDir = K.heading; K.boost = 0; K.boostEdge = false;
  K.step(1 / 60, 1, 0, 0, true);
  K.step(1 / 60, 1, 0, 16, false);
  mark(K.boost === 0, 'a tap below DRIFT_CHARGE_MIN releases no boost');
  // braking / off-road still cut the drift (safety first)
  K.placeAt(0.25, 0);
  K.speed = 22; K.velDir = K.heading;
  K.offRoad = true;
  K.step(1 / 60, 1, 0, 0, true);
  mark(K.drifting === false, 'off-road never drifts');
}
/* ------------------------------------------------------------------ *
 *  Boost pads (pads.js): seeded layout (wire-free, like hazards) and
 *  the chain-hit model. Full 2P races below already run hitPads every
 *  tick through simulateTick, so the integration is exercised too.
 * ------------------------------------------------------------------ */
console.log('\n== boost pads: layout + chain model ==');
{
  selectTrack(0);
  mark(padList.length >= 3 && padList.length % 3 === 0, 'pad strips built (3 cells each)');
  const snap = padList.map(c => c.x.toFixed(4) + ',' + c.z.toFixed(4)).join('|');
  buildPads(0);
  mark(padList.map(c => c.x.toFixed(4) + ',' + c.z.toFixed(4)).join('|') === snap,
    'pad layout seeded-deterministic (host+clients agree with zero wire traffic)');
  mark(padList.every(c => Math.abs(c.o) <= ROAD_HW - 1.8 + 1e-9), 'every pad cell sits inside the asphalt');
  // chain model: three consecutive cells escalate; standing still debounces
  const K = new Kart({ isPlayer: true });
  K.placeAt(0.5, 0);
  const cells = padList.filter(c => c.strip === padList[0].strip);
  const onCell = c => { K.pos.x = c.x; K.pos.z = c.z; };
  onCell(cells[0]); hitPads([K], 1 / 60);
  mark(K.padChain === 1 && Math.abs(K.boost - PAD_STRENGTH[0]) < 1e-9 && K.boostEdge,
    'first cell fires a small boost');
  onCell(cells[1]); hitPads([K], 1 / 60);
  mark(K.padChain === 2 && Math.abs(K.boost - PAD_STRENGTH[1]) < 1e-9, 'consecutive cell chains UP');
  onCell(cells[2]); hitPads([K], 1 / 60);
  mark(K.padChain === 3 && Math.abs(K.boost - PAD_STRENGTH[2]) < 1e-9, 'full-strip chain is the big one');
  hitPads([K], 1 / 60);
  mark(K.padChain === 3 && Math.abs(K.boost - PAD_STRENGTH[2]) < 1e-9, 'one firing per cell (debounced)');
  // missing the window kills the chain, and strips re-arm for the next lap
  K.pos.set(9999, 0, 9999);
  hitPads([K], 1.0);
  mark(K.padChain === 0, 'chain window expires when the next cell is missed');
  onCell(cells[0]); hitPads([K], 1 / 60);
  mark(K.padChain === 1, 'strips re-arm for the next pass');
}
{
  const fake = [{ pos: new THREE.Vector3(1.5, 2.5, -2.25), heading: 0.75, speed: 12.5, steerVel: 0.3, offRoad: false, lapDone: 1, posIdx: 2, raceDone: false, item: ITEM_WALL }];
  const enc = makeStateEncoder(1);
  const d = decodeState(enc(987654, 17, fake), 1);
  mark(d.hostMs === 987654 && d.echoPing === 17, 'state header');
  const k = d.karts[0];
  mark(Math.abs(k.x - 1.5) < 1e-5 && Math.abs(k.z + 2.25) < 1e-5, 'state pos');
  mark(Math.abs(k.y - 2.5) < 1e-5, 'state pos y (elevation round-trips)');
  mark(Math.abs(k.heading - 0.75) < 1e-5 && Math.abs(k.speed - 12.5) < 1e-5, 'state speed');
  mark(k.lapDone === 1 && k.posIdx === 2 && !k.raceDone && !k.offRoad, 'state flags');
  mark(k.item === ITEM_WALL, 'state frame round-trips the held item');
}
{
  // legacy: a pre-item peer sends 28-byte karts (no item) — decode item = 0
  // and still parse every other field at the right offsets
  const v = new DataView(new ArrayBuffer(7 + 28));
  v.setUint8(0, 0x20); v.setUint32(1, 42); v.setUint16(5, 9);
  v.setFloat32(7, 1.5); v.setFloat32(11, 2.5); v.setFloat32(15, -2.25);
  v.setFloat32(19, 0.75); v.setFloat32(23, 12.5); v.setFloat32(27, 0.3);
  v.setUint8(31, 0); v.setUint8(32, 1); v.setUint8(33, 2); v.setUint8(34, 0);
  const k = decodeState(v.buffer, 1).karts[0];
  mark(k.item === 0, 'legacy 28-byte state frame decodes item = 0');
  mark(Math.abs(k.y - 2.5) < 1e-5 && Math.abs(k.speed - 12.5) < 1e-5, 'legacy 28-byte frame still parses y/speed');
  mark(k.lapDone === 1 && k.posIdx === 2 && !k.raceDone, 'legacy 28-byte frame still parses flags');
}
{   // backward compat: a pre-3D peer sends 24-byte karts (no y) — the
    // decoder must read y = 0 and still parse z/heading/speed correctly
  const v = new DataView(new ArrayBuffer(7 + 24));
  v.setUint8(0, 0x20); v.setUint32(1, 42); v.setUint16(5, 9);
  v.setFloat32(7, 1.5); v.setFloat32(11, -2.25); v.setFloat32(15, 0.75);
  v.setFloat32(19, 12.5); v.setFloat32(23, 0.3);
  v.setUint8(27, 0); v.setUint8(28, 1); v.setUint8(29, 2); v.setUint8(30, 0);
  const k = decodeState(v.buffer, 1).karts[0];
  mark(k.y === 0, 'legacy state frame decodes as y = 0');
  mark(Math.abs(k.z + 2.25) < 1e-5 && Math.abs(k.speed - 12.5) < 1e-5, 'legacy state frame still parses z/speed');
}
{   // the catalogue has 3D tracks and they are deterministic per index:
    // same track index → identical samples (x, y, z), like the pad/hazard
    // fields. This is what keeps host == client frame-for-frame.
  const ti3d = TRACKS.findIndex(t => t.points.some(p => p.length === 3 && p[1] > 0));
  mark(ti3d >= 0, 'catalogue contains 3D (elevated) tracks');
  for (const ti of [ti3d, ti3d + 1 >= TRACKS.length ? ti3d : ti3d + 1]) {
    selectTrack(ti);
    const a = [0, 137, 500, 999].map(i => samples[i].x.toFixed(4) + ',' + samples[i].y.toFixed(4) + ',' + samples[i].z.toFixed(4));
    selectTrack(ti); // as a "freshly-joined client" would
    const b = [0, 137, 500, 999].map(i => samples[i].x.toFixed(4) + ',' + samples[i].y.toFixed(4) + ',' + samples[i].z.toFixed(4));
    mark(a.join('|') === b.join('|'), `track layout (incl. elevation) deterministic for index ${ti}`);
  }
}
{
  const d = decFinish(encFinish([3, 0, 1, 2], [31.2, 33.0, 35.5, 36.1]));
  mark(d.order.join(',') === '3,0,1,2' && d.laps.length === 4 && Math.abs(d.laps[0] - 31.2) < 1e-4, 'finish frame');
}
mark(new DataView(encBye()).getUint8(0) === T_BYE, 'bye frame');
{
  const sdp = 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n';
  mark(sdpFromCode(codeFromSdp(sdp)) === sdp, 'pairing code round-trip');
  mark(sdpFromCode('garbage!!') === '', 'pairing code rejects junk');
}
console.log(failures === 0 ? '  wire OK' : `  ${failures} wire failure(s)`);

/* ------------------------------------------------------------------ *
 *  Interpolation (interp.js) — lerp between frames, extrapolate when
 *  late, so a jittery LAN doesn't stutter the render.
 * ------------------------------------------------------------------ */
console.log('\n== interpolation ==');
{
  const kart = (x, z, heading, speed) => ({ x, z, heading, speed, steerVel: 0, offRoad: false, lapDone: 0, posIdx: 1, raceDone: false });
  const ring = new FrameRing();
  ring.push({ hostMs: 3000, karts: [kart(0, 0, 0, 20)] }, 0);   // t=0
  ring.push({ hostMs: 3050, karts: [kart(1, 0, 0, 20)] }, 50);  // t=50
  let s = sampleState(ring, 25);
  mark(s && Math.abs(s.karts[0].x - 0.5) < 1e-9, `interp midpoint (got ${s && s.karts[0].x})`);
  s = sampleState(ring, 40);
  mark(Math.abs(s.karts[0].x - 0.8) < 1e-9, `interp past-newest (got ${s.karts[0].x})`);
  mark(sampleState(new FrameRing(), 10) === null, 'empty ring → null');
  s = sampleState(ring, 25);
  mark(s.hostMs === 3025, `sampleState hostMs interpolates between frames (got ${s.hostMs}, want 3025)`);
  // past the newest frame: hostMs extrapolates with the same dt as the karts
  s = sampleState(ring, 70);
  mark(Math.abs(s.hostMs - 3070) < 1e-6, `sampleState hostMs extrapolates (got ${s.hostMs}, want 3070)`);
  // the old bug: hostMs came from the ring's OLDEST frame — with a 3-frame
  // ring sampled between frames 2 and 3, that lagged by a full 50 ms
  const ring3 = new FrameRing();
  ring3.push({ hostMs: 1000, karts: [kart(0, 0, 0, 0)] }, 0);
  ring3.push({ hostMs: 1050, karts: [kart(0, 0, 0, 0)] }, 50);
  ring3.push({ hostMs: 1100, karts: [kart(0, 0, 0, 0)] }, 100);
  s = sampleState(ring3, 75);
  mark(Math.abs(s.hostMs - 1075) < 1e-6, `hostMs is the bracketing frame, not the oldest (got ${s.hostMs}, want 1075)`);
  mark(sampleState(new FrameRing(), 10) === null, 'empty ring → null');
  // heading wrap: -170°→+170° should cross ±180, not go the long way round
  const r = sampleRat({ x: 0, z: 0, heading: -2.967, speed: 0, steerVel: 0 }, { x: 0, z: 0, heading: 2.967, speed: 0, steerVel: 0 }, 0.5);
  mark(Math.abs(Math.abs(r.heading) - Math.PI) < 0.01, `heading wrap lerp (got ${r.heading})`);
}
console.log(failures === 0 ? '  interp OK' : '  interp failures above');

/* ------------------------------------------------------------------ *
 *  Ghost (ghost.js): best-lap recording + per-track store — the pure
 *  record/save half (mesh playback is visual-only). localStorage is
 *  faked; the ghost must also survive WITHOUT it (private mode).
 * ------------------------------------------------------------------ */
console.log('\n== ghost: best-lap record + store ==');
{
  const mem = {};
  globalThis.localStorage = {
    getItem: k => (k in mem ? mem[k] : null),
    setItem: (k, v) => { mem[k] = String(v); },
  };
  selectTrack(0);
  initGhost(0);
  mark(getBestMs() === null, 'no stored best initially');
  const fake = { pos: { x: 0, z: 0 }, heading: 0 };
  ghostLapStart();
  for (let i = 0; i < 60 * 30; i++) { fake.pos.x += 0.1; ghostFrame(1 / 60, fake); }
  mark(ghostLapDone(30000) === true, 'first timed lap is stored as best');
  mark(getBestMs() === 30000, 'best readable');
  ghostLapStart();
  for (let i = 0; i < 60 * 35; i++) ghostFrame(1 / 60, fake);
  mark(ghostLapDone(35000) === false, 'slower lap does NOT overwrite the best');
  mark(getBestMs() === 30000, 'best unchanged after a slower lap');
  ghostLapStart();
  for (let i = 0; i < 60 * 25; i++) ghostFrame(1 / 60, fake);
  mark(ghostLapDone(25000) === true, 'faster lap becomes the new best');
  mark(getBestMs() === 25000, 'best updated');
  // per-track: another track has its own record
  ghostSetTrack(1);
  mark(getBestMs() === null, 'best laps are per-track');
  // the store survives an init reload (simulates a refresh)
  initGhost(0);
  mark(getBestMs() === 25000, 'store reloads from localStorage');
  // ~10 Hz sampling: a 30 s take must be ~300 triples, not 1800
  ghostLapStart();
  for (let i = 0; i < 60 * 30; i++) ghostFrame(1 / 60, fake);
  ghostLapDone(1000);
  const saved = JSON.parse(mem['mkr-ghost']);
  const flat = saved[0].samples;
  mark(flat.length % 3 === 0 && flat.length / 3 >= 290 && flat.length / 3 <= 310,
    `timeline sampled ~10Hz (got ${flat.length / 3} samples, want ~300)`);
  ghostStop();
}/* ------------------------------------------------------------------ *
 *  Sugar-hazard multiplayer determinism: the whole reason the hazard
 *  layout is seeded (trackIdx) alone is that the HOST and every LAN
 *  CLIENT build the identical candy layout with NOTHING streamed over
 *  the wire. Verify that holds, and that a host-authoritative race with
 *  hazards on still stays in sync (all karts finish, positions set).
 * ------------------------------------------------------------------ */
console.log('\n== sugar hazards: LAN determinism + host race ==');
{
  // 1) identical seeded layout for the same track on every (re)build —
  //    this is what guarantees host == client frame-for-frame.
  for (let ti = 0; ti < TRACKS.length; ti++) {
    selectTrack(ti);
    setObstaclesOn(true);  buildObstacles(ti);
    const a = obstacleList.map(o => [o.x, o.z, o.kind, o.r]);
    buildObstacles(ti);    // as a "freshly-joined client" would
    const b = obstacleList.map(o => [o.x, o.z, o.kind, o.r]);
    mark(a.length === b.length && a.length > 0 && a.every((q, i) => q[0]===b[i][0] && q[1]===b[i][1] && q[2]===b[i][2] && Math.abs(q[3]-b[i][3])<1e-9),
      `hazard layout identical on rebuild (track ${ti}, ${a.length} candy)`);
  }
  // 2) host-authoritative race WITH hazards on: every kart still finishes
  const ti = 1;   // Candy Tangle — densest (11 hazards)
  selectTrack(ti);  setObstaclesOn(true);  buildObstacles(ti);
  const list = [0, 1, 2, 3].map((who, i) => {
    const k = new Kart({ isPlayer: who === 3, net: who === 2, name: who === 3 ? 'YOU' : `AI${who}`, skill: who === 3 ? 0.95 : AI_SKILL[who] });
    k.laps = LAPS;
    const { P, T, Nn } = posAt(GRID[i].u);
    k.pos.copy(P).addScaledVector(Nn, GRID[i].o);
    k.heading = Math.atan2(T.x, T.z);
    k.trackIdx = Math.floor(GRID[i].u * n) % n;
    k.prevU = GRID[i].u;
    return k;
  });
  let t = 0, clips = 0;
  const GO = 3000;
  while (t < 480 * 1000 && !list.every(k => k.raceDone)) {
    const r = t >= GO;
    simulateTick(list, (k, rac) => rac ? aiControl(k, list) : { throttle: 0, steer: 0 },
      SIM_DT, t, { racing: r, crashFor: null, obFor: () => { clips++; } });
    t += SIM_DT * 1000;
  }
  const fin = list.filter(k => k.raceDone).length;
  mark(fin === list.length, `hazard host race: ${fin}/${list.length} finished (Candy Tangle)`);
  console.log(`  Candy Tangle host race w/ ${obstacleList.length} candy: ${fin}/${list.length} finished, ${clips} hazard clips, ${(t/1000).toFixed(0)}s`);
  setObstaclesOn(false);   // back off: the plain 2P races below drive with no candy
}

/* ------------------------------------------------------------------ *
 *  Item boxes (items.js): seeded layout (wire-free, like pads/hazards),
 *  deterministic rolls, and the effect models — turbo is the boost
 *  currency, rubber is the passive trailing push, wall the projectile.
 *  The 2P races below run with items ON, so simulateTick's full path
 *  (pickups + AI/human fires + walls) is exercised end to end.
 * ------------------------------------------------------------------ */
console.log('\n== item boxes: layout + effect models ==');
{
  setItemsOn(true);
  for (let ti = 0; ti < TRACKS.length; ti++) {
    buildItems(ti);
    const snap = itemBoxList.map(b => b.u.toFixed(4) + ',' + b.o.toFixed(3) + ',' + b.item).join('|');
    buildItems(ti);   // as a "freshly-joined client" would
    mark(itemBoxList.length >= 1 &&
      itemBoxList.map(b => b.u.toFixed(4) + ',' + b.o.toFixed(3) + ',' + b.item).join('|') === snap,
      `item layout seeded-deterministic (track ${ti}, ${itemBoxList.length} boxes)`);
    mark(itemBoxList.every(b => [ITEM_TURBO, ITEM_RUBBER, ITEM_WALL].includes(b.item) && b.respawnT === 0),
      `track ${ti}: boxes hold real items and start live`);
  }
  setItemsOn(false);
  buildItems(0);
  mark(itemBoxList.length === 0, 'items OFF: no boxes built (the gates stay pure)');
  setItemsOn(true);

  // effect models — two karts on the line of track 0
  selectTrack(0);
  buildItems(0);
  const A = new Kart({ isPlayer: true, name: 'A' });
  const B = new Kart({ isPlayer: false, name: 'B', skill: 1 });
  // turbo: the drift/pad boost currency, full charge + edge flag
  A.placeAt(0.20, 0);
  A.item = ITEM_TURBO;
  const ev = useItem(A);
  mark(ev && ev.kind === 'turbo' && A.item === 0 && A.boost >= 1 && A.boostEdge,
    'turbo fires: slot empties, boost full, edge flagged');
  // rubber: pushes a TRAILING holder only
  B.placeAt(0.30, 0);
  A.item = ITEM_RUBBER;
  const s0 = A.speed;
  for (let i = 0; i < 60; i++) tickRubber([A, B], 1 / 60);
  mark(A.speed > s0, `rubber pushes the trailing holder (${s0.toFixed(1)} -> ${A.speed.toFixed(1)} u/s)`);
  B.item = ITEM_RUBBER; A.item = 0;
  const s1 = B.speed;
  for (let i = 0; i < 60; i++) tickRubber([A, B], 1 / 60);
  mark(B.speed === s1, 'rubber never pushes the leader');
  // wall: flies, slams the first rival, vanishes; thrower exempt; expires.
  // (placeAt leaves heading/trackIdx alone — point A down the track first)
  A.placeAt(0.40, 0);
  {
    const a = Math.floor(0.40 * n) % n;
    A.heading = Math.atan2(samples[(a + 1) % n].x - samples[a].x, samples[(a + 1) % n].z - samples[a].z);
    A.trackIdx = a;
  }
  // B sits 8u straight ahead along A's heading — ON the wall's flight line
  // (a target 13u around the next corner would never be hit by a straight
  //  projectile, which is correct behaviour, not a bug)
  B.pos.set(A.pos.x + Math.sin(A.heading) * 8, 0, A.pos.z + Math.cos(A.heading) * 8);
  B.trackIdx = A.trackIdx; B.speed = 15;
  A.item = ITEM_WALL;
  mark(useItem(A) && walls.length === 1, 'wall throw: one projectile in flight');
  const bs = B.speed;
  let hitWho = null;
  for (let i = 0; i < 60 * 4 && walls.length; i++) tickItems([A, B], 1 / 60, (w, k) => { hitWho = k; });
  mark(hitWho === B, 'wall slams the kart ahead of the thrower');
  mark(hitWho && hitWho.speed < bs * 0.6, 'wall hit cuts the target speed');
  mark(walls.length === 0, 'wall consumed on hit');
  B.pos.z -= 200;   // clear the line so the next throw finds nothing
  A.item = ITEM_WALL; useItem(A);
  for (let i = 0; i < 60 * 4; i++) tickItems([A, B], 1 / 60);
  mark(walls.length === 0, 'wall expires after its lifetime when it hits nothing');
  // pickup: a kart over a live box grabs the box's (fixed) item; the box
  // goes into its cooldown and comes back
  buildItems(0);
  const box = itemBoxList[0];
  A.item = 0; A.itemT = 0;
  A.pos.x = box.x; A.pos.y = box.y; A.pos.z = box.z;
  tickItems([A, B], 1 / 60);
  mark(A.item === box.item, `pickup grants the box item (${A.item})`);
  mark(Math.abs(box.respawnT - ITEM_RESPAWN) < 1e-9, 'picked box enters its respawn cooldown');
  for (let i = 0; i < 60 * (ITEM_RESPAWN + 1); i++) tickItems([A, B], 1 / 60);
  mark(box.respawnT === 0, 'box back after the cooldown');
  setItemsOn(true);   // the 2P race loop below wants them on
}

/* ------------------------------------------------------------------ *
 *  Host-authoritative 2P race: 2 human input streams + 2 AI, 60 Hz
 *  (items ON — pickups + fires ride the same simulateTick path)
 * ------------------------------------------------------------------ */
for (let ti = 0; ti < TRACKS.length; ti++) {
  const info = selectTrack(ti);
  console.log(`\n== ${info.name} - 2P host race (${info.points} pts, items ON) ==`);

  // mirrors main.js resetKarts for 2P: humans front row, AI behind
  const list = [0, 1, 'P2', 'YOU'].map((who, i) => {
    const k = new Kart({
      isPlayer: who === 'YOU',
      net: who === 'P2',
      name: typeof who === 'string' ? who : `AI${who}`,
      skill: typeof who === 'number' ? AI_SKILL[who] : 1,
    });
    k.laps = LAPS;
    const { P, T, Nn } = posAt(GRID[i].u);
    k.pos.copy(P).addScaledVector(Nn, GRID[i].o);
    k.heading = Math.atan2(T.x, T.z);
    k.trackIdx = Math.floor(GRID[i].u * n) % n;
    k.prevU = GRID[i].u;
    return k;
  });
  const p1 = list[2], p2 = list[3];

  let t = 0; const GO = 3000; let racing = false;
  let pickups = 0, wallHits = 0;
  const seen = new Map();
  while (t < 300 * 1000 && !(p1.raceDone && p2.raceDone)) {
    racing = (t >= GO);
    simulateTick(list, (k, r) => r ? (k.net ? humanPilot(k) : aiControl(k, list)) : { throttle: 0, steer: 0 },
      SIM_DT, t, { racing, crashFor: null, wallFor: () => { wallHits++; } });
    for (const k of list) {   // count 0 -> item transitions (pickups)
      const was = seen.get(k) ?? 0;
      if (k.item && !was) pickups++;
      seen.set(k, k.item);
    }
    t += SIM_DT * 1000;
  }
  mark(pickups >= 3, `${info.name}: items exercised in the pack (pickups=${pickups})`);

  const secs = t / 1000;
  const order = raceOrder(list);
  mark(order.every((k, i) => k.posIdx === i + 1), 'positions consistent');
  mark(progress(p1) >= LAPS && p1.raceDone, `${info.name}: P1 (human) did not finish (${p1.lapDone} laps)`);
  mark(progress(p2) >= LAPS && p2.raceDone, `${info.name}: P2 (human) did not finish (${p2.lapDone} laps)`);
  mark(p1.lapTimes.length === LAPS, `${info.name}: P1 lapTimes ${p1.lapTimes.length}/${LAPS}`);
  mark(p2.lapTimes.length === LAPS, `${info.name}: P2 lapTimes ${p2.lapTimes.length}/${LAPS}`);
  for (const k of [p1, p2]) {
    const last = k.lapTimes[k.lapTimes.length - 1];
    mark(last > 10 && last < 240, `${info.name}: ${k.name} final lap ${last ? last.toFixed(1) : 'n/a'}s out of range`);
  }
  for (const k of list) {
    const last = k.lapTimes.length ? k.lapTimes[k.lapTimes.length - 1].toFixed(1) : '-';
    console.log(`  ${k.name.padEnd(4)} ${k.raceDone ? 'FINISHED' : 'stuck      '} laps=${k.lapDone} pos=${k.posIdx} lastLap=${last}s`);
  }
  console.log(`  race time ${secs.toFixed(1)}s`);

  {
    const two = [2, 3].map((src, i) => {
      const k = new Kart({ isPlayer: src === 3, net: src === 2, name: src === 3 ? 'YOU' : 'P2', skill: 1 });
      k.laps = LAPS;
      const { P, T, Nn } = posAt(GRID[i].u);
      k.pos.copy(P).addScaledVector(Nn, GRID[i].o);
      k.heading = Math.atan2(T.x, T.z);
      k.trackIdx = Math.floor(GRID[i].u * n) % n;
      k.prevU = GRID[i].u;
      return k;
    });
    let t2 = 0;
    while (t2 < 300 * 1000 && !(two[0].raceDone && two[1].raceDone)) {
      simulateTick(two, (k, r) => r ? humanPilot(k) : { throttle: 0, steer: 0 }, SIM_DT, t2, { racing: t2 >= GO, crashFor: null });
      t2 += SIM_DT * 1000;
    }
    mark(two[0].raceDone && two[1].raceDone, `${info.name}: 1v1 humans did not finish (${two.map(k => k.lapDone).join('/')})`);
    mark(two[0].posIdx !== two[1].posIdx, `${info.name}: 1v1 positions equal`);
  }
  console.log(`  items: ${pickups} pickups, ${wallHits} wall hits`);
}
setItemsOn(false);

console.log(failures === 0 ? `\n== NET-SIM PASS (${TRACKS.length} tracks, wire OK) ==`
                           : `\n== ${failures} NET-SIM FAILURE(S) ==`);
process.exitCode = failures === 0 ? 0 : 1;
