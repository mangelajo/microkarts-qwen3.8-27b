import * as THREE from 'three';
import {
  game,
  N_AI, AI_SKILL,
  CAM_DIST, CAM_HEIGHT, SIM_DT, COUNTDOWN_MS, LAPS, KMH_PER_U, DRIFT_MIN_KMH, DRIFT_CHARGE_MAX, P2_COLOR,
  ITEM_TURBO, ITEM_WALL,
} from './config.js';
import { renderer, scene, camera, updateDust, dustForKart } from './scene.js';
import { initMinimap, setMinimapVisible, updateMinimap, resizeMinimap } from './minimap.js';
import { Kart } from './kart.js';
import { aiControl } from './ai.js';
import { selectTrack, updateItemBoxes, syncWallMeshes } from './track.js';
import { GRID, simulateTick, raceOrder } from './race.js';
import { setObstaclesOn, getObstaclesOn } from './obstacles.js';
import { setItemsOn, getItemsOn } from './items.js';
import { makeStateEncoder, encFinish } from './net.js';
import {
  fmt, el, startBtn, resultsEl, showOverlay, hideOverlay, hideCountdown, updateHud,
  initTrackPicker, cycleTrack, getTrackIdx, getMode,
  initHazardPicker, setHazard, getHazardOn, loadHazardPref,
  initItemPicker, setItem, getItemOn, loadItemPref,
  initMenuTabs, setMenuPage,
  hudRankNudge,
} from './hud.js';
import * as audio from './audio.js';
import {
  initGhost, ghostSetTrack, ghostLapStart, ghostFrame, ghostLapDone, ghostStop,
} from './ghost.js';
import { rankInit, rankSetTrack, rankLapDone } from './rankings.js';
import { getDrive, initTouch, setActive as touchSetActive, pulseHint, isTouchDevice } from './touch.js';
import { createNet2p } from './net2p.js';
import { podiumHtml, celebrate } from './resultsfx.js';

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
const keys = { up: false, down: false, left: false, right: false, drift: false };
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
const drive = { throttle: 0, steer: 0, drift: false };
function readDrive(racing) {
  const t = getDrive();
  if (t.active && racing) {
    drive.throttle = t.throttle; drive.steer = t.steer;
    // touch has no drift button: drag the stick to FULL lock to commit to a slide
    drive.drift = keys.drift || (Math.abs(t.steer) > 0.95 && t.throttle > 0.5);
  }
  else {
    drive.throttle = (keys.up ? 1 : 0) - (keys.down ? 1 : 0);
    drive.steer = inText();
    drive.drift = keys.drift;
   }
  return drive;
}
addEventListener('keydown', e => {
  audio.ensureAudio();
  const k = KEYMAP[e.code];
  if (k) { keys[k] = true; e.preventDefault(); }
  if (e.target && e.target.isContentEditable) return; // typing a pairing code
  if (e.code === 'Enter' || e.code === 'KeyR') primaryAction();
  if (e.code === 'Escape' && game.state === 'finished') toMenu();
  // menu pages (menu state only — no conflict with race keys)
  if (game.state === 'menu' && !e.repeat) {
    if (e.code === 'Digit1') setMenuPage('race');
    if (e.code === 'Digit2') setMenuPage('extras');
    if (e.code === 'Digit3') setMenuPage('controls');
  }
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
    if (e.code === 'KeyI' && getMode() !== 'join') {
      audio.ensureAudio(); toggleItems(); audio.beep(getItemsOn() ? 440 : 330);
    }
  }
  if (e.code === 'KeyE' && game.state === 'racing' && !e.repeat) itemUseQ++; // fire held item
  if (e.code === 'Space') { keys.drift = true; e.preventDefault(); }   // hold to drift
});
addEventListener('keyup', e => {
  const k = KEYMAP[e.code];
  if (k) { keys[k] = false; e.preventDefault(); }
  if (e.code === 'Space') keys.drift = false;
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

// item use is edge-triggered: E queues one fire (itemUseQ), touch devices
// auto-fire a turbo/wall ~450 ms after pickup (autoUseAt). The rubber band
// never needs the button — it works passively (items.js tickRubber).
let itemUseQ = 0;
let autoUseAt = 0;
let lastPlayerItem = 0;   // pickup sfx + touch auto-fire arming
function tryConsumeItemUse(now) {
  const touchFire = isTouchDevice() && now >= autoUseAt
    && (player.item === ITEM_TURBO || player.item === ITEM_WALL);
  if (itemUseQ > 0 || touchFire) { itemUseQ = 0; autoUseAt = 0; return true; }
  return false;
}

function keyInput(k, racing) {
  if (!k.isPlayer || !racing) return { throttle: 0, steer: 0 };
  const c = readDrive(racing);
  if (tryConsumeItemUse(performance.now())) {
    return { throttle: c.throttle, steer: c.steer, drift: c.drift, use: true }; // spread: drive is shared
  }
  return c;
}

/* ------------------------------------------------------------------ *
 *  2P net session — the orchestration (NetSession, host/join lifecycle,
 *  the client render mirror, HUD mode wiring) lives in net2p.js; game.js
 *  hands in the shared context and drives the per-frame host ticks +
 *  client pass in animate().
 * ------------------------------------------------------------------ */
const n2 = createNet2p({
  karts, player, p2Ref: () => p2, ensureP2,
  racers, syncRosterVisibility, addShake, snapChaseCam, camSnap,
});

/* ------------------------------------------------------------------ *
 *  Race lifecycle
 * ------------------------------------------------------------------ */
const camPos = new THREE.Vector3();
const camLook = new THREE.Vector3();
const _cdVec = new THREE.Vector3();

el('nCars').textContent = String(karts.length);

// snap the chase camera behind a kart's grid spot (startRace + clientStart)
function camSnap(p) {
  const f = new THREE.Vector3(Math.sin(p.heading), 0, Math.cos(p.heading));
  camPos.copy(p.pos).addScaledVector(f, -CAM_DIST);
  camPos.y = p.pos.y + CAM_HEIGHT;
  camLook.copy(p.pos);
  camera.position.copy(camPos);
  camera.lookAt(camLook);
}

function startRace() {
  audio.ensureAudio();
  audio.startMusic(getTrackIdx());
  game.laps = LAPS;
  resetKarts();
  itemUseQ = 0; autoUseAt = 0; lastPlayerItem = 0;   // fresh item state each race
  n2.resetClientItems();
  ghostStop();          // fresh race: the ghost restarts at GO
  game.raceTime = 0;
  game.raceOverAt = 0;
  const now = performance.now();
  game.state = 'countdown';
  game.cdText = -1;
  hideOverlay();
  hideCountdown();
  startBtn.blur();
  if (n2.role() === 'host') {
    // fixed sim clock starts at 0 → GO at COUNTDOWN_MS
    n2.host.t = 0; n2.host.acc = 0;
    game.raceStart = COUNTDOWN_MS; // host-sim-ms
    n2.host.enc = makeStateEncoder(racers().length);
    n2.net().kartN = racers().length;
    const list = racers();
    n2.net().sendPrep(getTrackIdx(), COUNTDOWN_MS); // client syncs countdown first (ordered channel)
    n2.net().sendStart({
      karts: list.length, laps: LAPS, rosterN: list.length,
      steerFlip: false, simDt: SIM_DT,
      grid: list.flatMap(k => [GRID[gridSlot(k)].u, GRID[gridSlot(k)].o]),
    });
  } else {
    game.raceStart = now + COUNTDOWN_MS;
  }
  for (const k of racers()) k.lapStart = game.raceStart;
  camSnap(player);               // snap camera behind the player kart
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
  ghostStop();
  const best = player.lapDone > 0 ? Math.min(...player.lapTimes) : null;
  el('best').innerHTML = 'BEST <span class="val">' + fmt(best) + '</span>';
  const list = racers();
  const order = raceOrder(list);
  const nameOf = k => k.isPlayer ? 'YOU' : (k === p2 ? 'P2' : k.name);
  const rows = [];
  order.forEach((k, i) => {
    const nm = nameOf(k);
    const lap = k.lapTimes.length ? ' ' + fmt(k.lapTimes[k.lapTimes.length - 1]) : '';
    rows.push((i + 1) + '. ' + (k.isPlayer ? '<b>' + nm + '</b>' : nm) + lap);
  });
  const place = list.indexOf(player) + 1;
  const placeMsg =
    place === 1 ? 'YOU WRECKED EVERYONE AROUND THE TABLE' :
    place === list.length ? 'LAST PLACE ON THE DINNER TABLE' :
    'YOU FINISHED ' + place + ' OF ' + list.length;
  showOverlay('RACE COMPLETE', placeMsg, 'RACE AGAIN', false, 'OR PRESS R \u00b7 ESC = MENU');
  audio.stopMusicTimer();
  resultsEl.innerHTML = '<b>TOTAL ' + fmt(game.raceTime) + '</b> &nbsp;·&nbsp; BEST LAP <b>' +
    fmt(best) + '</b>' + podiumHtml(order, nameOf) +
    '<div style="font-size:13px;letter-spacing:1px;margin-top:10px">' +
    rows.join(' &nbsp;&nbsp; ') + '</div>';
  resultsEl.style.display = '';
  celebrate();   // confetti burst (resultsfx.js)
  if (n2.role() === 'host') {
    n2.net().sendFinish(encFinish(order.map(k => list.indexOf(k)),
      order.map(k => k.lapTimes.length ? k.lapTimes[k.lapTimes.length - 1] * 1000 : 0)));
  }
}

function primaryAction() {
  if (n2.role() === 'join') return;               // the host calls the shots
  if (n2.role() === 'host' && !n2.net().open) return;  // wait for the pairing
  if (game.state === 'menu' || game.state === 'finished') startRace();
}

// back to the menu from the results screen (Esc): the menu is the full
// state again — fresh karts, clean HUD, mode/track/toggles all editable
function toMenu() {
  if (game.state !== 'finished') return;
  if (n2.role() === 'join') return;             // the host calls the shots
  game.state = 'menu';
  ghostStop();
  hideCountdown();
  resultsEl.style.display = 'none';
  el('lap').textContent = 'LAP 1/' + LAPS;
  el('time').textContent = '0:00.0';
  el('pos').textContent = '1';
  el('speed').textContent = '0';
  el('itemSlot').textContent = '—';
  setMenuPage('race');
  showOverlay('MICRO KART RACING', 'A TINY CIRCUIT ON THE DINNER TABLE',
    'START RACE', true, 'OR PRESS ENTER \u00a0\u00b7\u00a0 3 LAPS \u00a0\u00b7\u00a0 1/2/3 = PAGES');
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
    ghostSetTrack(idx);   // best laps + ghost timeline are per-track
    rankSetTrack(idx);   // the top-5 board is per-track too
    if (n2.role() === 'host') n2.net().sendTrack(getTrackIdx(), getObstaclesOn(), getItemOn()); // client previews
  },
);

// menu pages: RACE / EXTRAS / CONTROLS — chips + 1/2/3
initMenuTabs(p => setMenuPage(p));

// sugar hazards: restore the persisted toggle BEFORE the first rebuild so the
// boot-up track already has its candy; Z on the menu toggles it too.
function toggleHazard() { setHazard(!getHazardOn()); }
setObstaclesOn(loadHazardPref());
initHazardPicker(
  on => {
    setObstaclesOn(on);
    selectTrack(getTrackIdx());
    if (n2.role() === 'host') n2.net().sendTrack(getTrackIdx(), getObstaclesOn(), getItemOn()); // client mirrors
  },
  getObstaclesOn(),
);

// item boxes: restore the persisted toggle BEFORE the first rebuild so the
// boot-up track already has its boxes; I on the menu toggles them too.
function toggleItems() { setItem(!getItemOn()); }
setItemsOn(loadItemPref());
initItemPicker(
  on => {
    setItemsOn(on);
    selectTrack(getTrackIdx());
    if (n2.role() === 'host') n2.net().sendTrack(getTrackIdx(), getObstaclesOn(), getItemOn()); // client mirrors
  },
  getItemsOn(),
);
if (getTrackIdx() !== 0 || getObstaclesOn() || getItemsOn()) selectTrack(getTrackIdx());

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
initGhost(getTrackIdx());
rankInit();   // top-5 best-lap board (rankings.js)
function toggleMap() {
  mmOn = !mmOn;
  try { localStorage.setItem('mkr-map', mmOn ? '1' : '0'); } catch { /* private mode */ }
  setMinimapVisible(false);              // re-evaluated next frame from the game state
}

/* ------------------------------------------------------------------ *
 *  Collision juice: jolt both karts + shake the camera if it's our kart
 * ------------------------------------------------------------------ */
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

/* wall juice: shake + thump when one of our karts eats a wall (host + solo;
 * the join client sees the slam via the host's position snap + jolt). */
function wallJuice(w, k) {
  if (k === player || k === p2) { addShake(0.8); audio.crash(0.8); }
}

/* ------------------------------------------------------------------ *
 *  Per-kart input: who drives each kart, per context
 * ------------------------------------------------------------------ */
function soloInputFor(k, racing) {
  if (k.isPlayer) return keyInput(k, racing);
  if (racing) { const c = aiControl(k, racers()); return { throttle: c.throttle, steer: c.steer, use: !!c.use }; }
  return { throttle: 0, steer: 0 };
}

function hostInputFor(k, racing) {
  if (k.isPlayer) return keyInput(k, racing);
  if (k === p2) {
    // the peer's kart: driven from the wire (or still before the channel / GO)
    if (!racing || !n2.net() || !n2.net().open || p2.netOn === false) return { throttle: 0, steer: 0 };
    const inp = n2.input();
    if (inp.at && performance.now() - inp.at < 250) {
      return { throttle: inp.throttle, steer: inp.steer, drift: inp.drift, use: !!inp.use };
    }
    return { throttle: 0, steer: 0 }; // peer frozen — no phantom throttle
  }
  if (racing) { const c = aiControl(k, racers()); return { throttle: c.throttle, steer: c.steer, use: !!c.use }; }
  return { throttle: 0, steer: 0 };
}

/* ------------------------------------------------------------------ *
 *  Cameras
 * ------------------------------------------------------------------ */
let camShake = 0; // collision camera shake, decays
function addShake(v) { camShake = Math.min(1, camShake + v); }

function snapChaseCam(dt) {
  const p = n2.selfKart();
  const fx = Math.sin(p.heading), fz = Math.cos(p.heading);
  // the camera rides with the kart's elevation (3D tracks: p.pos.y > 0)
  const target = _cdVec.set(p.pos.x - fx * CAM_DIST, p.pos.y + CAM_HEIGHT, p.pos.z - fz * CAM_DIST);
  camPos.lerp(target, 1 - Math.exp(-7 * dt));
  camera.position.copy(camPos);
  camLook.lerp(_cdVec.set(p.pos.x + fx * 3.5, p.pos.y + 0.9, p.pos.z + fz * 3.5), 1 - Math.exp(-7 * dt));
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

function animate() {
  requestAnimationFrame(animate);
  game.dt = Math.min(clock.getDelta(), 0.05);
  const dt = game.dt;
  const now = performance.now();
  const list = racers();
  const role = n2.role();
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
      n2.host.acc += Math.min(dt, 0.1);
      let steps = 0;
      while (n2.host.acc >= SIM_DT && steps < 8) {
        n2.host.t += SIM_DT * 1000;
        simulateTick(list, hostInputFor, SIM_DT, n2.host.t, { racing: false });
        n2.broadcast();
        n2.host.acc -= SIM_DT;
        steps++;
      }
      if (steps === 8) n2.host.acc = 0;
      clockMs = n2.host.t;
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
      if (role === 'host') { n2.host.acc = 0; p2.netOn = true; }
      // GO — the ghost laps with us from here (join clients mirror, never record)
      if (role !== 'join') ghostLapStart();
    }
  } else if (role === 'join') {      // ---- client: no sim, render snapshots + stream our input ----
    if (game.state === 'racing') {
      // live touch drag drives over the wire; otherwise the keyboard. steer pitch
      const d = readDrive(true);
      const use = tryConsumeItemUse(performance.now());   // E / touch auto-fire
      n2.net().inputNow(d.throttle, d.steer, d.drift, use);
      n2.applyClientState(dt);
      const sk = n2.selfKart();
      if (sk.item !== lastPlayerItem) {   // item juice on the wire-mirrored item
        if (sk.item !== 0) {
          audio.beep(660 + 220 * sk.item);
          if (isTouchDevice() && (sk.item === ITEM_TURBO || sk.item === ITEM_WALL)) autoUseAt = performance.now() + 450;
        }
        lastPlayerItem = sk.item;
      }
      audio.updateEngine(sk.speed, d.steer, !sk.offRoad, d.drift && sk.speed * KMH_PER_U > DRIFT_MIN_KMH, (sk.charge || 0) / DRIFT_CHARGE_MAX, sk.boost || 0); // engine sound from interpolated speed
    }
  } else {
    // ---- solo + net host sim: ONE shared body, only the time base differs.
    // The host steps fixed SIM_DT ticks off its own sim clock (n2.host.t) and
    // streams every tick; solo steps a single variable dt off performance.now().
    const racing = game.state === 'racing'; // false after finish: karts coast
    let clockMs;
    if (role === 'host') {
      n2.host.acc += Math.min(dt, 0.1);
      let steps = 0;
      while (n2.host.acc >= SIM_DT && steps < 8) {
        n2.host.t += SIM_DT * 1000;
        p2.netOn = true;
        simulateTick(list, hostInputFor, SIM_DT, n2.host.t, {
          racing,
          crashFor: crashJuice,
          obFor: obJuice,
          wallFor: wallJuice,
        });
        if (racing) n2.broadcast();
        n2.host.acc -= SIM_DT;
        steps++;
      }
      if (steps === 8) n2.host.acc = 0; // tab stall — stop the sim rather than spiral
      clockMs = n2.host.t;
    } else {
      simulateTick(list, soloInputFor, dt, now, {
        racing,
        crashFor: crashJuice,
        obFor: obJuice,
        wallFor: wallJuice,
      });
      clockMs = now;
    }
    audio.updateEngine(player.speed, readDrive(racing).steer, !player.offRoad, player.drifting, player.charge / DRIFT_CHARGE_MAX, player.boost);
    if (player.boostEdge) {   // drift released with charge — whoosh (louder = more charge)
      player.boostEdge = false;
      if (player.boost > 0.2) audio.beep(430 + 640 * player.boost);
    }
    if (racing && player.item !== lastPlayerItem) {   // pickup chime + touch auto-fire arming
      if (player.item !== 0) {
        audio.beep(660 + 220 * player.item);
        if (isTouchDevice() && (player.item === ITEM_TURBO || player.item === ITEM_WALL)) autoUseAt = now + 450;
      }
      lastPlayerItem = player.item;
    }
    if (player.lapDone !== game.lastLapBeep) {
      game.lastLapBeep = player.lapDone;
      if (player.lapDone > 0 && !player.raceDone) audio.lap();
      if (player.lapDone > 0 && role !== 'join') {
        // completed lap: bank it if it's the track best, then start the next
        // ghost lap (finisher's partial final lap never gets recorded)
        const prev = player.lapDone - 1;
        if (!player.raceDone || prev <= player.laps) {
          const lapMs = player.lapTimes.length ? player.lapTimes[player.lapTimes.length - 1] * 1000 : 0;
          if (ghostLapDone(lapMs)) audio.beep(990);   // new track record chime
          const rk = rankLapDone(lapMs);              // top-5 board (same local-only gate)
          if (rk > 0) hudRankNudge(rk);              // "NEW RECORD — #N" flash
          if (!player.raceDone) ghostLapStart();
        }
      }
    }
    if (racing) ghostFrame(dt, player);
    if (racing) {
      let finished = 0;
      for (const k of list) if (k.raceDone) finished++;
      if (player.raceDone === false && finished >= list.length - 1 && game.raceOverAt === 0) {
        game.raceOverAt = clockMs + 5000; // player still racing, rivals done — give it a moment
      }
      if (finished >= list.length && game.raceOverAt === 0) game.raceOverAt = clockMs + 1200;
    }
    for (const k of list) k.sync(dt);
    game.raceTime = Math.max(0, (clockMs - game.raceStart) / 1000);
    if (game.state !== 'finished') {
      updateHud(game.raceTime, Math.max(0, (clockMs - player.lapStart) / 1000), list);
      snapChaseCam(dt);
    }
    // `racing &&` fires finishRace exactly once, on the frame the flag drops.
    // (The old host path lacked this guard and re-ran finishRace — re-sending
    // finish frames at 60 Hz — for every frame after the race ended.)
    if (racing && (player.raceDone || (game.raceOverAt && clockMs >= game.raceOverAt))) finishRace();
  }
  if (game.state !== 'menu') {
    for (const k of list) dustForKart(k, dt);
    updateDust(dt);
  }
   // minimap: on the grid + during the race (hidden on menu / results)
  if (mmOn && (game.state === 'countdown' || game.state === 'racing')) {
    setMinimapVisible(true);
    updateMinimap(list, n2.selfKart());
   } else {
    setMinimapVisible(false);
   }
  updateItemBoxes(dt, now);   // spin + bob the item boxes (hidden while respawning)
  syncWallMeshes();           // point the pooled wall meshes at live projectiles
  renderer.render(scene, camera);
}

animate();
