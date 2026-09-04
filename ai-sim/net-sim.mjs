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
import { N_SAMPLES, SIM_DT, LAPS, AI_SKILL, clamp } from '../src/config.js';
import { Kart } from '../src/kart.js';
import { aiControl } from '../src/ai.js';
import { GRID, simulateTick, raceOrder, progress, collideKarts } from '../src/race.js';
import { setObstaclesOn, buildObstacles, obstacleList } from '../src/obstacles.js';
import { FrameRing, sampleState, sampleRat } from '../src/interp.js';
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
  return { throttle, steer: clamp(err * 2.5, -1, 1) };
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
  const d = decInput(encInput(-1, 1, 12345));
  mark(d.throttle === -1 && d.steer === 1 && d.ping === 12345, 'input frame');
}
{
  const fake = [{ pos: new THREE.Vector3(1.5, 0, -2.25), heading: 0.75, speed: 12.5, steerVel: 0.3, offRoad: false, lapDone: 1, posIdx: 2, raceDone: false }];
  const enc = makeStateEncoder(1);
  const d = decodeState(enc(987654, 17, fake), 1);
  mark(d.hostMs === 987654 && d.echoPing === 17, 'state header');
  const k = d.karts[0];
  mark(Math.abs(k.x - 1.5) < 1e-5 && Math.abs(k.z + 2.25) < 1e-5, 'state pos');
  mark(Math.abs(k.heading - 0.75) < 1e-5 && Math.abs(k.speed - 12.5) < 1e-5, 'state speed');
  mark(k.lapDone === 1 && k.posIdx === 2 && !k.raceDone && !k.offRoad, 'state flags');
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
console.log(failures === 0 ? '  interp OK' : '  interp failures above');/* ------------------------------------------------------------------ *
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
 *  Host-authoritative 2P race: 2 human input streams + 2 AI, 60 Hz
 * ------------------------------------------------------------------ */
for (let ti = 0; ti < TRACKS.length; ti++) {
  const info = selectTrack(ti);
  console.log(`\n== ${info.name} - 2P host race (${info.points} pts) ==`);

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
  while (t < 300 * 1000 && !(p1.raceDone && p2.raceDone)) {
    racing = (t >= GO);
    simulateTick(list, (k, r) => r ? (k.net ? humanPilot(k) : aiControl(k, list)) : { throttle: 0, steer: 0 },
      SIM_DT, t, { racing, crashFor: null });
    t += SIM_DT * 1000;
  }

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
}

console.log(failures === 0 ? `\n== NET-SIM PASS (${TRACKS.length} tracks, wire OK) ==`
                           : `\n== ${failures} NET-SIM FAILURE(S) ==`);
process.exitCode = failures === 0 ? 0 : 1;
