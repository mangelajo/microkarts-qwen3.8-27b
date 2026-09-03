import * as THREE from 'three';
import {
  N_AI, AI_SKILL,
  CAM_DIST, CAM_HEIGHT, SIM_DT, INTERP_DELAY, P2_COLOR, LAPS,
  game,
} from './config.js';
import { renderer, scene, camera, updateDust, dustForKart } from './scene.js';
import { initMinimap, setMinimapVisible, updateMinimap, resizeMinimap } from './minimap.js';
import { Kart, aiControl } from './kart.js';
import { selectTrack } from './track.js';
import { GRID, simulateTick, raceOrder } from './race.js';
import { setObstaclesOn, getObstaclesOn } from './obstacles.js';
import { NetSession, makeStateEncoder, encFinish } from './net.js';
import { FrameRing, sampleState } from './interp.js';
import {
  fmt, el, startBtn, resultsEl, showOverlay, hideOverlay, hideCountdown, updateHud,
  initTrackPicker, setTrack, cycleTrack, getTrackIdx,
  setMode, setStatus, hostCode, hostMsg, joinMsg, getMode,
  initModePicker, setHostRoster,
  initHazardPicker, setHazard, getHazardOn, loadHazardPref,
} from './hud.js';
import * as audio from './audio.js';
import { getDrive, initTouch, setActive as touchSetActive, pulseHint } from './touch.js';

/* ------------------------------------------------------------------ *
 *  Karts — the roster has 3 AI bodies (solo uses 3, 2P uses 2) + the
 *  local player, which stays LAST in `karts`. P2 (the networked human)
 *  is spliced in before the local player on the first 2P session.
 *  Host-side 2P wire order: [AI0, AI1, P2, local].
 * ------------------------------------------------------------------ */
const karts = [];
const player = new Kart({ isPlayer: true, color: 0xe0392b, accent: 0xf6c445 });
let p2 = null;
const ROSTER = [
  { color: 0x2e7dd1, name: 'AZURE' },
  { color: 0x39b17c, name: 'MATCHA' },
  { color: 0xd153f1, name: 'PLUMP' },
];
for (let i = 0; i < N_AI; i++) {
  karts.push(new Kart({ ...ROSTER[i], isPlayer: false, skill: AI_SKILL[i] }));
}
karts.push(player);

function ensureP2() {
  if (!p2) {
    p2 = new Kart({ isPlayer: false, net: true, name: 'P2', color: P2_COLOR, accent: 0xf6c445 });
    karts.splice(karts.length - 1, 0, p2); // before the local player
  }
  return p2;
}

/* 2P active order: [AZURE, MATCHA, P2, you] (2ai) or [P2, you] (1v1);
   solo: [AZURE, MATCHA, PLUMP, you]. Wire order = this array, player last. */
function racers() {
  if (game.netMode !== 2) return karts.filter(k => k !== p2); // solo: 3 AI + you (p2 stays hidden)
  return game.roster === '1v1' ? [p2, player] : [karts[0], karts[1], p2, player];
}

// karts outside the active roster (e.g. unused AI in 1v1) are hidden
function syncRosterVisibility() {
  const active = racers();
  for (const k of karts) k.mesh.root.visible = active.includes(k);
  el('nCars').textContent = String(active.length);
}

function resetKarts() {
  const order = game.netMode !== 2 ? [karts[0], player, karts[1], karts[2]]
    : game.roster === '1v1' ? [player, p2]
                            : [player, p2, karts[0], karts[1]];   // humans in the front row
  order.forEach((k, i) => { k.laps = game.laps; k.placeAt(GRID[i].u, GRID[i].o); });
  syncRosterVisibility();
}

/* ------------------------------------------------------------------ *
 *  Input (each device drives its own WASD+arrows — no remapping)
 * ------------------------------------------------------------------ */
const keys = { up: false, down: false, left: false, right: false };
const KEYMAP = {
  KeyW: 'up', ArrowUp: 'up',
  KeyS: 'down', ArrowDown: 'down',
  KeyA: 'left', ArrowLeft: 'left',
  KeyD: 'right', ArrowRight: 'right',
};
function inText() { return (keys.left ? 1 : 0) - (keys.right ? 1 : 0); }
// The car's single local drive source: a live finger drag (touch.js) wins over
// the keyboard so the two never fight; fall back to the classic discrete WASD.
// readDrive is called per frame for the player's kart, for the audio pitch, and
// (on the client) for what gets streamed over the wire.
const drive = { throttle: 0, steer: 0 };
function readDrive(racing) {
  const t = getDrive();
  if (t.active && racing) { drive.throttle = t.throttle; drive.steer = t.steer; }
  else {
    drive.throttle = (keys.up ? 1 : 0) - (keys.down ? 1 : 0);
    drive.steer = inText();
   }
  return drive;
}
addEventListener('keydown', e => {
  audio.ensureAudio();
  const k = KEYMAP[e.code];
  if (k) { keys[k] = true; e.preventDefault(); }
  if (e.target && e.target.isContentEditable) return; // typing a pairing code
  if (e.code === 'Enter' || e.code === 'KeyR') primaryAction();
  if (e.code === 'KeyM') updateMusicMute();
  if (e.code === 'KeyN') updateSfxMute();
  if (e.code === 'KeyK') toggleMap();
  // on the menu, arrows double as track switching (race steering unaffected —
  // the game isn't racing, so no conflict)
  if ((game.state === 'menu' || game.state === 'finished') && !e.repeat) {
    if (e.code === 'ArrowLeft') { audio.ensureAudio(); cycleTrack(-1); audio.beep(330); }
    if (e.code === 'ArrowRight') { audio.ensureAudio(); cycleTrack(1); audio.beep(440); }
    if (e.code === 'KeyZ' && getMode() !== 'join') {
      audio.ensureAudio(); toggleHazard(); audio.beep(getObstaclesOn() ? 440 : 330);
    }
  }
  if (e.code === 'Space') e.preventDefault();
});
addEventListener('keyup', e => {
  const k = KEYMAP[e.code];
  if (k) { keys[k] = false; e.preventDefault(); }
});
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  resizeMinimap();
});

// mobile: the floating "pull" joystick lives on the render canvas; it drives
// via the same {throttle, steer} channel as the keyboard (see readDrive).
initTouch(renderer.domElement);

function keyInput(k, racing) {
  if (!k.isPlayer || !racing) return { throttle: 0, steer: 0 };
  return readDrive(racing);
}

/* ------------------------------------------------------------------ *
 *  2P net session (host = authoritative sim; join = render-only)
 * ------------------------------------------------------------------ */
game.netMode = 0; // 0 solo · 2 two-player
let net = null;
let hostSimT = 0;          // host sim clock (ms)
let hostAcc = 0;           // fixed-step accumulator
let lastNetInput = { throttle: 0, steer: 0, ping: -1, at: 0 };
let stateEncoder = null;
let clientRing = null;
let clientLapSeen = [];
let clientLapMark = []; // host-sim-ms of each kart's last detected line crossing
let netStartWall = 0;      // join role: when the host's start frame landed

const COUNTDOWN_MS = 3000;

function netRole() { return game.netMode === 2 && net ? net.role : null; }
// "you" per device: host/solo = player kart · client = p2 (its own wire kart)
function selfKart() { return netRole() === 'join' ? p2 : player; }

function sessionCbs() {
  return {
    onOpen: () => {
      setStatus('CONNECTED');
      audio.beep(880);
      if (netRole() === 'host') { net.sendTrack(getTrackIdx(), getObstaclesOn()); hostMsg.textContent = 'P2 connected! Pick a track, then press START RACE.'; }
      if (netRole() === 'join') joinMsg.textContent = 'CONNECTED! Now wait — the host picks the track and starts the race.';
    },
    onStatus: s => {
      const label = {
        'standby': 'NO PEER',
        'awaiting-peer': 'WAITING FOR P2…',
        'awaiting-host': 'WAITING FOR HOST…',
        'connected': 'CONNECTED',
        'open': 'CONNECTED',
        'closed': 'P2 LOST',
        'failed': 'P2 LOST',
      }[s];
      if (label) setStatus(label);
      if (s === 'failed' || s === 'closed') {
        const hint = 'CONNECTION LOST/FAILED — same Wi-Fi? Open the game via a LAN IP (not localhost) and retry.';
        if (netRole() === 'host') hostMsg.textContent = hint;
        if (netRole() === 'join') joinMsg.textContent = hint;
      }
    },
    onPrep: prep => {
      if (netRole() !== 'join') return;
      if (prep.trackIdx !== getTrackIdx()) setTrack(prep.trackIdx); // mirror the host's pick
      netStartWall = performance.now();
      clientRing = new FrameRing();
      clientLapSeen = racers().map(() => 0);
      clientLapMark = racers().map(() => 0);
      game.raceStart = netStartWall + prep.cdMs;
      game.raceOverAt = 0;
      game.cdText = -1;
      syncRosterVisibility();
      if (game.state !== 'countdown') { // skip the re-countdown after a finished race
        game.state = 'countdown';
        hideOverlay();
        hideCountdown();
      }
    },
    onTrack: (idx, haz) => { // host → live picker preview (client watches the host's chips)
      if (netRole() !== 'join') return;
      const wantObs = haz === undefined ? getObstaclesOn() : !!haz;
      const obsChanged = getObstaclesOn() !== wantObs;
      const idxChanged = idx !== getTrackIdx();
      if (!idxChanged && !obsChanged) return;
      if (obsChanged) setObstaclesOn(wantObs);
      if (idx === getTrackIdx()) selectTrack(idx);  // flag-only change: rebuild, chips already right
      else setTrack(idx);                            // idx change: rebuild + chips via onChange
    },
    onStart: info => {
      if (netRole() !== 'join') return;
      clientStart(info);
    },
    onState: st => {
      // session already decoded the frame: { hostMs, echoPing, karts }
      if (netRole() !== 'join') return;
      if (!clientRing) return;
      clientRing.push(st, performance.now());
      game.net = st;
      clientRaceBookkeeping(st);
      // RTT readout: host echoes the ping from our latest input
      if (st.echoPing !== lastNetInput.ping && lastNetInput.at > 0) {
        const rtt = Math.round(performance.now() - lastNetInput.at);
        if (rtt > 0 && rtt < 2500) { setStatus('P2 CONNECTED · ' + rtt + ' ms'); net.rtt = rtt; }
      }
    },    onFinish: (order, lapsMs) => {
      if (netRole() !== 'join') return;
      clientFinish(order, lapsMs);
    },
    onInput: inp => { // client → host: drives the peer's kart on the sim
      lastNetInput = { throttle: inp.throttle, steer: inp.steer, ping: inp.ping, at: performance.now() };
    },
    onClose: () => onPeerLost(),
  };
}

function onPeerLost() {
  const wasNet = game.netMode === 2;
  const wasRacing = wasNet && (game.state === 'racing' || game.state === 'countdown');
  game.netMode = 0;
  startBtn.textContent = 'START RACE';
  if (clientRing) clientRing.clear();
  const s = net; net = null;
  if (s && !s.closed) s.close(); // fires onClose → re-enters onPeerLost, guarded by s.closed
  hostAcc = 0; lastNetInput.ping = -1;
  if (p2) p2.netOn = false;
  syncRosterVisibility();
  if (wasNet && wasRacing) {
    game.state = 'menu';
    game.raceOverAt = 0;
    game.laps = LAPS;
    karts.forEach(k => { k.raceDone = false; k.lapDone = 0; k.lapTimes = []; k.laps = LAPS; });
    hideCountdown();
    showOverlay('LINK DROPPED', 'PLAYER 2 LEFT — BACK TO SOLO', 'START RACE', false, 'OR PRESS ENTER · 3 LAPS');
  } else {
    setStatus(''); // intentional mode switch: clear the 'P2 LOST' chip
  }
}

const LAN_HINT = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
  ? '  ⚠ You opened the game via localhost — other devices can’t reach it. Open http://<your-LAN-IP>:8080 on THIS machine instead.'
  : '';

function beginHostSession() {
  if (net) net.close();
  hostSimT = 0; hostAcc = 0;
  lastNetInput = { throttle: 0, steer: 0, ping: -1, at: 0 };
  ensureP2().netOn = false; // peer's kart is AI-free until the channel opens
  net = new NetSession('host', sessionCbs());
  net.kartN = racers().length;
  net.hostStart().then(code => {
    hostCode.textContent = code;
    hostMsg.textContent = 'Send this code to player 2, then paste their answer in STEP 2.' + LAN_HINT;
  }).catch(err => { hostMsg.textContent = 'WEBRTC UNAVAILABLE — ' + err.message; });
}

function hostPasteAnswer() {
  const code = el('answerField').innerText.trim();
  if (!code || !net) return;
  el('answerField').innerText = '';
  net.hostAnswer(code).then(() => {
    hostMsg.textContent = 'Handshake done — connecting… (same Wi-Fi?); status top-right';
  }).catch(err => { hostMsg.textContent = 'BAD CODE — ' + err.message; });
}

function joinPasteOffer() {
  const code = el('joinInField').innerText.trim();
  if (!code) return;
  if (!net) net = new NetSession('join', sessionCbs());
  net.kartN = 4;
  el('joinBtn').disabled = true;
  joinMsg.textContent = 'Working…';
  net.joinOffer(code).then(answerCode => {
    el('joinInField').innerText = '';
    const out = el('joinOutCode');
    out.textContent = answerCode;
    out.classList.remove('hidden');
    el('joinOutLabel').style.display = '';
    el('joinBtn').disabled = false;
    try {
      navigator.clipboard.writeText(answerCode);
      joinMsg.textContent = 'Copied! Paste it in the host STEP 2 box, then wait for CONNECTED.';
    } catch {
      joinMsg.textContent = 'Click the code box to copy it, then paste it in the host STEP 2 box.';
    }
  }).catch(err => { joinMsg.textContent = 'BAD CODE — ' + err.message; el('joinBtn').disabled = false; });
}

/* ---------------------------- client (join) ---------------------------- */
function clientStart(info) {
  ensureP2();
  game.roster = info.karts === 2 ? '1v1' : '2ai';
  net.kartN = info.karts;
  syncRosterVisibility();
  for (const k of racers()) { k.laps = info.laps; }
  for (let i = 0; i < racers().length; i++) {
    racers()[i].placeAt(info.grid[i * 2], info.grid[i * 2 + 1]);
  }
  game.laps = info.laps;
  clientRing = new FrameRing();
  lastClientSp = 0;
  clientLapSeen = racers().map(() => 0);
  clientLapMark = racers().map(() => 0);
  netStartWall = performance.now();
  game.raceStart = netStartWall + COUNTDOWN_MS;
  game.raceOverAt = 0;
  game.state = 'countdown';
  game.cdText = -1;
  hideOverlay();
  hideCountdown();
  // snap camera behind our grid spot (state frames take over in a moment)
  const p = selfKart();
  const f = new THREE.Vector3(Math.sin(p.heading), 0, Math.cos(p.heading));
  camPos.copy(p.pos).addScaledVector(f, -CAM_DIST);
  camPos.y = CAM_HEIGHT;
  camLook.copy(p.pos);
  camera.position.copy(camPos);
  camera.lookAt(camLook);
  pulseHint();               // client sees the same cue when the host's race begins
}

// client mirrors host lap/finish events from the snapshot deltas
function clientRaceBookkeeping(st) {
  const list = racers();
  for (let i = 0; i < list.length && i < st.karts.length; i++) {
    const m = st.karts[i];
    if (m.lapDone > clientLapSeen[i]) {
      clientLapSeen[i] = m.lapDone;
      list[i].lapDone = m.lapDone;
      list[i].lapTimes.push((st.hostMs - clientLapMark[i]) / 1000);
      clientLapMark[i] = st.hostMs;
      const isYou = i === list.length - 2;
      const isP1 = i === list.length - 1;
      if (isYou && !m.raceDone) audio.lap();   // our own lap crossing
      if (isP1 && !m.raceDone) audio.beep(660); // P1 crossing (party cue)
    }
    if (m.raceDone) list[i].raceDone = true;
  }
}

let lastClientSp = 0; // own-kart speed from the last applied frame (impact estimate)
function applyClientState(dt) {
  if (!clientRing || clientRing.size < 1) return;
  const st = sampleState(clientRing, performance.now() - INTERP_DELAY);
  if (!st || !game.net) return;
  const list = racers();
  for (let i = 0; i < list.length && i < st.karts.length; i++) {
    const k = list[i], m = st.karts[i];
    k.pos.set(m.x, 0, m.z);
    k.heading = m.heading;
    k.speed = m.speed;
    k.steerVel = m.steerVel;
    k.offRoad = m.offRoad;
    k.posIdx = m.posIdx;
    k.sync(dt); // cosmetic: wheels, roll, pitch (fed by interpolated speed)
  }
  // collision juice on the client: we don't run the sim, so estimate our own
  // impact from how hard our kart's speed dropped since the last frame
  const sk = selfKart();
  const drop = lastClientSp - sk.speed;
  if (drop > 5 && sk.speed > 1) {
    sk.jolt = Math.min(1, drop / 16);
    addShake(sk.jolt * 0.8);
    audio.crash(sk.jolt);
  }
  lastClientSp = Math.abs(sk.speed);
  game.raceTime = st.hostMs / 1000;
  const you = list.length - 2; // client "you" = p2; updateHud reads the last kart
  const lapStartMs = clientLapMark[you] || COUNTDOWN_MS; // host clock: GO at cdMs
  const hudList = [...list.slice(0, -2), player, p2];
  updateHud(game.raceTime, Math.max(0, (st.hostMs - lapStartMs) / 1000), hudList);
  snapChaseCam(dt);
}

function clientFinish(order, lapsMs) {
  game.state = 'finished';
  hideCountdown();
  const list = racers();
  audio.stopMusicTimer();
  const rows = order.map((idx, i) => {
    const nm = idx === list.length - 2 ? '<b>YOU</b>' : idx === list.length - 1 ? '<b>P1</b>' : list[idx].name;
    const lap = lapsMs[idx] ? ' ' + fmt(lapsMs[idx] / 1000) : '';
    return (i + 1) + '. ' + nm + lap;
  });
  resultsEl.innerHTML = rows.join(' &nbsp;&nbsp; ');
  resultsEl.style.display = '';
  const place = order.indexOf(list.length - 2) + 1;
  const placeMsg =
    place === 1 ? 'YOU WRECKED THE TABLE!' :
    'YOU WERE ' + place + ' OF ' + list.length;
  showOverlay('RACE COMPLETE', placeMsg, 'WAIT FOR HOST', false, 'HOST CAN RACE AGAIN');
}

/* Collision juice: jolt both karts + shake the camera if it's our kart */
function crashJuice(a, b, v) {
  a.jolt = Math.min(1, Math.max(a.jolt, v));
  b.jolt = Math.min(1, Math.max(b.jolt, v));
  if (a === player || b === player) addShake(v * 0.9);
  if (a === p2 || b === p2) addShake(v * 0.9); // client: our kart is p2
  if (a === player || b === player) audio.crash(v);
}

/* Sugar-hazard juice: jolt + shake + thump when one of OUR karts clips candy */
function obJuice(k, v) {
  k.jolt = Math.min(1, Math.max(k.jolt, v));
  if (k === player || k === p2) addShake(v * 0.7);
  if (k === player || k === p2) audio.crash(v * 0.8);
}

/* ------------------------------------------------------------------ *
 *  Race lifecycle
 * ------------------------------------------------------------------ */
const camPos = new THREE.Vector3();
const camLook = new THREE.Vector3();
const _cdVec = new THREE.Vector3();

el('nCars').textContent = String(karts.length);

function startRace() {
  audio.ensureAudio();
  audio.startMusic(getTrackIdx());
  game.laps = LAPS;
  resetKarts();
  game.raceTime = 0;
  game.raceOverAt = 0;
  const now = performance.now();
  game.state = 'countdown';
  game.cdText = -1;
  hideOverlay();
  hideCountdown();
  startBtn.blur();
  if (netRole() === 'host') {
    // fixed sim clock starts at 0 → GO at COUNTDOWN_MS
    hostSimT = 0; hostAcc = 0;
    game.raceStart = COUNTDOWN_MS; // host-sim-ms
    stateEncoder = makeStateEncoder(racers().length);
    net.kartN = racers().length;
    const list = racers();
    net.sendPrep(getTrackIdx(), COUNTDOWN_MS); // client syncs countdown first (ordered channel)
    net.sendStart({
      karts: list.length, laps: LAPS, rosterN: list.length,
      steerFlip: false, simDt: SIM_DT,
      grid: list.flatMap(k => [GRID[gridSlot(k)].u, GRID[gridSlot(k)].o]),
    });
  } else {
    game.raceStart = now + COUNTDOWN_MS;
  }
  for (const k of racers()) k.lapStart = game.raceStart;
  // snap camera behind the player kart
  const p = player, f = new THREE.Vector3(Math.sin(p.heading), 0, Math.cos(p.heading));
  camPos.copy(p.pos).addScaledVector(f, -CAM_DIST);
  camPos.y = CAM_HEIGHT;
  camLook.copy(p.pos);
  camera.position.copy(camPos);
  camera.lookAt(camLook);
  updateHud(0, 0, racers());
  pulseHint();               // show the "PULL TO DRIVE" cue (no-op on non-touch)
}

// grid slot per kart — must match resetKarts()' placement order
function gridSlot(k) {
  if (game.netMode !== 2) return k === player ? 1 : k === karts[0] ? 0 : k === karts[1] ? 2 : 3;
  if (game.roster === '1v1') return k === player ? 0 : 1;
  return k === player ? 0 : k === p2 ? 1 : k === karts[0] ? 2 : 3;
}

function finishRace() {
  game.state = 'finished';
  hideCountdown();
  const best = player.lapDone > 0 ? Math.min(...player.lapTimes) : null;
  el('best').innerHTML = 'BEST <span class="val">' + fmt(best) + '</span>';
  const list = racers();
  const order = raceOrder(list);
  const rows = [];
  order.forEach((k, i) => {
    const nm = k.isPlayer ? 'YOU' : (k === p2 ? 'P2' : k.name);
    const lap = k.lapTimes.length ? ' ' + fmt(k.lapTimes[k.lapTimes.length - 1]) : '';
    rows.push((i + 1) + '. ' + (k.isPlayer ? '<b>' + nm + '</b>' : nm) + lap);
  });
  const place = list.indexOf(player) + 1;
  const placeMsg =
    place === 1 ? 'YOU WRECKED EVERYONE AROUND THE TABLE' :
    place === list.length ? 'LAST PLACE ON THE DINNER TABLE' :
    'YOU FINISHED ' + place + ' OF ' + list.length;
  showOverlay('RACE COMPLETE', placeMsg, 'RACE AGAIN', false, 'OR PRESS R');
  audio.stopMusicTimer();
  resultsEl.innerHTML = '<b>TOTAL ' + fmt(game.raceTime) + '</b> &nbsp;·&nbsp; BEST LAP <b>' +
    fmt(best) + '</b><div style="font-size:13px;letter-spacing:1px;margin-top:10px">' +
    rows.join(' &nbsp;&nbsp; ') + '</div>';
  resultsEl.style.display = '';
  if (netRole() === 'host') {
    net.sendFinish(encFinish(order.map(k => list.indexOf(k)),
      order.map(k => k.lapTimes.length ? k.lapTimes[k.lapTimes.length - 1] * 1000 : 0)));
  }
}

function primaryAction() {
  if (netRole() === 'join') return;               // the host calls the shots
  if (netRole() === 'host' && !net.open) return;  // wait for the pairing
  if (game.state === 'menu' || game.state === 'finished') startRace();
}

function updateMusicMute() {
  const m = audio.toggleMusicMute();
  el('muteMusic').textContent = m ? 'MUSIC OFF' : 'MUSIC';
  el('muteMusic').classList.toggle('on', m);
}

function updateSfxMute() {
  const m = audio.toggleSfxMute();
  el('muteSfx').textContent = m ? 'SFX OFF' : 'SFX';
  el('muteSfx').classList.toggle('on', m);
}

startBtn.addEventListener('click', () => {
  audio.ensureAudio();
  primaryAction();
  startBtn.blur();
});

// track picker: chips + persistence. Rebuild the scene on selection;
// track.js already built TRACKS[0] eagerly at import, so skip a redundant build.
initTrackPicker(
  idx => {
    selectTrack(idx);
    if (netRole() === 'host') net.sendTrack(getTrackIdx(), getObstaclesOn()); // client previews the host's track
  },
);

// sugar hazards: restore the persisted toggle BEFORE the first rebuild so the
// boot-up track already has its candy; Z on the menu toggles it too.
function toggleHazard() { setHazard(!getHazardOn()); }
setObstaclesOn(loadHazardPref());
initHazardPicker(
  on => {
    setObstaclesOn(on);
    selectTrack(getTrackIdx());
    if (netRole() === 'host') net.sendTrack(getTrackIdx(), getObstaclesOn()); // client mirrors hazards
  },
  getObstaclesOn(),
);
if (getTrackIdx() !== 0 || getObstaclesOn()) selectTrack(getTrackIdx());

// restore mute preferences
try {
  if (localStorage.getItem('mkr-music') === '1') audio.setMusicMuted(true);
  if (localStorage.getItem('mkr-sfx') === '1') audio.setSfxMuted(true);
} catch { /* private mode */ }
el('muteMusic').textContent = audio.isMusicMuted() ? 'MUSIC OFF' : 'MUSIC';
el('muteMusic').classList.toggle('on', audio.isMusicMuted());
el('muteSfx').textContent = audio.isSfxMuted() ? 'SFX OFF' : 'SFX';
el('muteSfx').classList.toggle('on', audio.isSfxMuted());
el('muteMusic').addEventListener('click', e => { audio.ensureAudio(); updateMusicMute(); e.target.blur(); });
el('muteSfx').addEventListener('click', e => { audio.ensureAudio(); updateSfxMute(); e.target.blur(); });

/* ------------------------------------------------------------------ *
 *  Minimap — a top-down track map (bottom-left HUD). Shown on the grid and
 *  during the race; hidden on the menu / results. 'K' toggles it (persisted).
 * ------------------------------------------------------------------ */
let mmOn = true;
try { if (localStorage.getItem('mkr-map') === '0') mmOn = false; } catch { /* private mode */ }
initMinimap();
function toggleMap() {
  mmOn = !mmOn;
  try { localStorage.setItem('mkr-map', mmOn ? '1' : '0'); } catch { /* private mode */ }
  setMinimapVisible(false);              // re-evaluated next frame from the game state
}

/* ------------------------------------------------------------------ *
 *  Mode / 2P wiring
 * ------------------------------------------------------------------ */
hostCode.addEventListener('click', () => {
  try {
    navigator.clipboard.writeText(hostCode.textContent);
    hostMsg.textContent = 'Code copied! Send it to player 2.';
  } catch { /* select + copy manually */ }
});
initModePicker(
  m => {
    if (game.state === 'racing' || game.state === 'countdown') return;
    setMode(m);
    if (m === 'solo') {
      if (game.netMode === 2) onPeerLost();
      game.netMode = 0;
      startBtn.textContent = 'START RACE';
    } else if (m === 'host') {
      startBtn.textContent = 'START RACE';
      game.netMode = 2;
      beginHostSession();
      syncRosterVisibility();
    } else if (m === 'join') {
      if (game.netMode === 2 && net && net.role === 'join') return;
      if (net) net.close();
      startBtn.textContent = 'WAITING FOR HOST…';
      game.netMode = 2;
      net = new NetSession('join', sessionCbs());
      net.kartN = 4;
      setHostRoster(game.roster);
      joinMsg.textContent = "Paste the host's MKR-… code here.";
      el('joinInField').innerText = '';
    }
  },
  hostPasteAnswer,
  joinPasteOffer,
  r => { game.roster = r; setHostRoster(r); if (game.netMode === 2) syncRosterVisibility(); },
);

/* ------------------------------------------------------------------ *
 *  Per-kart input: who drives each kart, per context
 * ------------------------------------------------------------------ */
function soloInputFor(k, racing) {
  if (k.isPlayer) return keyInput(k, racing);
  if (racing) { const c = aiControl(k, racers()); return { throttle: c.throttle, steer: c.steer }; }
  return { throttle: 0, steer: 0 };
}

function hostInputFor(k, racing) {
  if (k.isPlayer) return keyInput(k, racing);
  if (k === p2) {
    // the peer's kart: driven from the wire (or still before the channel / GO)
    if (!racing || !net || !net.open || p2.netOn === false) return { throttle: 0, steer: 0 };
    if (lastNetInput.at && performance.now() - lastNetInput.at < 250) {
      return { throttle: lastNetInput.throttle, steer: lastNetInput.steer };
    }
    return { throttle: 0, steer: 0 }; // peer frozen — no phantom throttle
  }
  if (racing) { const c = aiControl(k, racers()); return { throttle: c.throttle, steer: c.steer }; }
  return { throttle: 0, steer: 0 };
}

/* ------------------------------------------------------------------ *
 *  Cameras
 * ------------------------------------------------------------------ */
let camShake = 0; // collision camera shake, decays
function addShake(v) { camShake = Math.min(1, camShake + v); }

function snapChaseCam(dt) {
  const p = selfKart();
  const fx = Math.sin(p.heading), fz = Math.cos(p.heading);
  const target = _cdVec.set(p.pos.x - fx * CAM_DIST, CAM_HEIGHT, p.pos.z - fz * CAM_DIST);
  camPos.lerp(target, 1 - Math.exp(-7 * dt));
  camera.position.copy(camPos);
  camLook.lerp(_cdVec.set(p.pos.x + fx * 3.5, 0.9, p.pos.z + fz * 3.5), 1 - Math.exp(-7 * dt));
  camera.lookAt(camLook);
  // speed-FOV: widens with speed for a sense of pace (55 -> ~70 at top speed)
  const fovT = 55 + 15 * Math.min(Math.abs(p.speed) / 30, 1);
  camera.fov += (fovT - camera.fov) * Math.min(1, 4 * dt);
  camera.updateProjectionMatrix();
  // collision shake: high-frequency offset, decays fast
  if (camShake > 0.003) {
    const t = performance.now() * 0.05;
    camera.position.x += Math.sin(t * 1.7) * camShake * 0.28;
    camera.position.y += Math.sin(t * 2.3 + 1.3) * camShake * 0.22;
    camera.position.z += Math.sin(t * 1.9 + 2.1) * camShake * 0.28;
    camera.lookAt(camLook);
    camShake *= Math.exp(-9 * dt);
  }
}

/* ------------------------------------------------------------------ *
 *  Main loop — three contexts:
 *    solo    variable-step sim (byte-identical feel to the old loop)
 *    host    fixed-step sim (@SIM_DT), authoritative, broadcasts state
 *    join    render-only: interpolate host state, send key input
 * ------------------------------------------------------------------ */
const clock = new THREE.Clock();
const menuLook = new THREE.Vector3(0, 0, 5);

function broadcastState() {
  net.sendState(stateEncoder(hostSimT, lastNetInput.ping, racers()));
}

function animate() {
  requestAnimationFrame(animate);
  game.dt = Math.min(clock.getDelta(), 0.05);
  const dt = game.dt;
  const now = performance.now();
  const list = racers();
  const role = netRole();
  // the pull-joystick only drives while the car may move; it parks on menu/results
  touchSetActive(game.state === 'countdown' || game.state === 'racing');

  if (game.state === 'menu') {
    const a = now * 0.00009;
    camera.position.set(Math.cos(a) * 105, 62, Math.sin(a) * 105 + 5);
    camera.lookAt(menuLook);
  } else if (game.state === 'countdown') {
    let clockMs = now;
    if (role === 'host') {
      // step the (static) sim so hostSimT tracks the client's expected wall clock
      hostAcc += Math.min(dt, 0.1);
      let steps = 0;
      while (hostAcc >= SIM_DT && steps < 8) {
        hostSimT += SIM_DT * 1000;
        simulateTick(list, hostInputFor, SIM_DT, hostSimT, { racing: false });
        if (net.open) broadcastState();
        hostAcc -= SIM_DT;
        steps++;
      }
      if (steps === 8) hostAcc = 0;
      clockMs = hostSimT;
    }
    const remain = (game.raceStart - clockMs) / 1000;
    const txt = remain <= 0 ? 'GO' : String(remain > 3 ? 3 : Math.ceil(remain - 1e-6));
    if (txt !== game.cdText) {
      game.cdText = txt;
      if (txt === 'GO') audio.go(); else audio.beep(440);
      const c = el('countdown');
      c.textContent = txt;
      c.classList.add('on');
      c.classList.toggle('go', txt === 'GO');
    }
    if (clockMs >= game.raceStart + 700) {
      game.state = 'racing';
      hideCountdown();
      if (role === 'host') { hostAcc = 0; p2.netOn = true; }
    }
  } else if (role === 'join') {      // ---- client: no sim, render snapshots + stream our input ----
    if (game.state === 'racing') {
      // live touch drag drives over the wire; otherwise the keyboard. steer pitch
      const d = readDrive(true);
      net.inputNow(d.throttle, d.steer);
      applyClientState(dt);
      const sk = selfKart();
      audio.updateEngine(sk.speed, d.steer, !sk.offRoad); // local engine sound from interpolated speed
    }
  } else {
    // ---- solo + host sim ----
    if (role === 'host') {
      const hostRacing = game.state === 'racing'; // false after finish: karts coast, no drive/positions
      hostAcc += Math.min(dt, 0.1);
      let steps = 0;
      while (hostAcc >= SIM_DT && steps < 8) {
        hostSimT += SIM_DT * 1000;
        p2.netOn = true;
        simulateTick(list, hostInputFor, SIM_DT, hostSimT, {
          racing: hostRacing,
          crashFor: crashJuice,
          obFor: obJuice,
        });
        if (net.open && hostRacing) broadcastState();
        hostAcc -= SIM_DT;
        steps++;
      }
      if (steps === 8) hostAcc = 0; // tab stall — stop the sim rather than spiral

      audio.updateEngine(player.speed, readDrive(hostRacing).steer, !player.offRoad);
      if (player.lapDone !== game.lastLapBeep) {
        game.lastLapBeep = player.lapDone;
        if (player.lapDone > 0 && !player.raceDone) audio.lap();
      }
      let finished = 0;
      for (const k of list) if (k.raceDone) finished++;
      if (player.raceDone === false && finished >= list.length - 1 && game.raceOverAt === 0) {
        game.raceOverAt = hostSimT + 5000;
      }
      if (finished >= list.length && game.raceOverAt === 0) game.raceOverAt = hostSimT + 1200;
      for (const k of list) k.sync(dt);
      game.raceTime = Math.max(0, (hostSimT - game.raceStart) / 1000);
      if (game.state !== 'finished') {
        updateHud(game.raceTime, Math.max(0, (hostSimT - player.lapStart) / 1000), list);
        snapChaseCam(dt);
      }
      if (player.raceDone || (game.raceOverAt && hostSimT >= game.raceOverAt)) finishRace();
    } else {
      // ---- solo: variable step, unchanged from the original loop ----
      const racing = game.state === 'racing';
      simulateTick(list, soloInputFor, dt, now, {
        racing,
        crashFor: crashJuice,
        obFor: obJuice,
      });
      audio.updateEngine(player.speed, readDrive(racing).steer, !player.offRoad);
      if (player.lapDone !== game.lastLapBeep) {
        game.lastLapBeep = player.lapDone;
        if (player.lapDone > 0 && !player.raceDone) audio.lap();
      }
      if (racing) {
        let finished = 0;
        for (const k of list) if (k.raceDone) finished++;
        if (player.raceDone === false && finished >= list.length - 1 && game.raceOverAt === 0) {
          game.raceOverAt = now + 5000; // player still racing, rivals done — give it a moment
        }
        if (finished >= list.length && game.raceOverAt === 0) game.raceOverAt = now + 1200;
      }
      for (const k of list) k.sync(dt);
      game.raceTime = Math.max(0, (now - game.raceStart) / 1000);
      if (game.state !== 'finished') {
        updateHud(game.raceTime, Math.max(0, (now - player.lapStart) / 1000), list);
        snapChaseCam(dt);
      }
      if (racing && (player.raceDone || (game.raceOverAt && now >= game.raceOverAt))) finishRace();
    }
  }
  if (game.state !== 'menu') {
    for (const k of list) dustForKart(k, dt);
    updateDust(dt);
  }
   // minimap: on the grid + during the race (hidden on menu / results)
  if (mmOn && (game.state === 'countdown' || game.state === 'racing')) {
    setMinimapVisible(true);
    updateMinimap(list, selfKart());
   } else {
    setMinimapVisible(false);
   }
  renderer.render(scene, camera);
}

animate();
