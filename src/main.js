import * as THREE from 'three';
import {
  N_AI, AI_SKILL, MAX_SPEED, MAX_REV,
  CAM_DIST, CAM_HEIGHT, clamp, game,
} from './config.js';
import { renderer, scene, camera } from './scene.js';
import { Kart, aiControl } from './kart.js';
import { selectTrack } from './track.js';
import {
  fmt, el, startBtn, resultsEl, showOverlay, hideOverlay, hideCountdown, updateHud,
  initTrackPicker, cycleTrack, getTrackIdx,
} from './hud.js';
import * as audio from './audio.js';

/* ------------------------------------------------------------------ *
 *  Karts: the player + computer opponents
 * ------------------------------------------------------------------ */
const karts = [];
const player = new Kart({ isPlayer: true, color: 0xe0392b, accent: 0xf6c445 });
const ROSTER = [
  { color: 0x2e7dd1, name: 'AZURE' },
  { color: 0x39b17c, name: 'MATCHA' },
  { color: 0xd153f1, name: 'PLUMP' },
];
for (let i = 0; i < N_AI; i++) {
  karts.push(new Kart({ ...ROSTER[i], isPlayer: false, skill: AI_SKILL[i] }));
}
karts.push(player);

function resetKarts() {
  // 2x2 grid just behind the start/finish line
  const cells = [
    { u: 0.9925, o: -1.75 }, { u: 0.9925, o: +1.75 },
    { u: 0.985,  o: -1.75 }, { u: 0.985,  o: +1.75 },
  ];
  // grid order: strongest AI, player, then the rest
  const order = [karts[0], player, karts[1], karts[2]];
  order.forEach((k, i) => k.placeAt(cells[i].u, cells[i].o));
}

/* ------------------------------------------------------------------ *
 *  Input
 * ------------------------------------------------------------------ */
const keys = { up: false, down: false, left: false, right: false };
const KEYMAP = {
  KeyW: 'up', ArrowUp: 'up',
  KeyS: 'down', ArrowDown: 'down',
  KeyA: 'left', ArrowLeft: 'left',
  KeyD: 'right', ArrowRight: 'right',
};
addEventListener('keydown', e => {
  audio.ensureAudio();
  const k = KEYMAP[e.code];
  if (k) { keys[k] = true; e.preventDefault(); }
  if (e.code === 'Enter' || e.code === 'KeyR') primaryAction();
  if (e.code === 'KeyM') updateMusicMute();
  if (e.code === 'KeyN') updateSfxMute();
  // on the menu, arrows double as track switching (race steering unaffected —
  // the game isn't racing, so no conflict)
  if ((game.state === 'menu' || game.state === 'finished') && !e.repeat) {
    if (e.code === 'ArrowLeft') { audio.ensureAudio(); cycleTrack(-1); audio.beep(330); }
    if (e.code === 'ArrowRight') { audio.ensureAudio(); cycleTrack(1); audio.beep(440); }
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
});

/* ------------------------------------------------------------------ *
 *  Race lifecycle
 * ------------------------------------------------------------------ */
const COUNTDOWN_MS = 3000;
const camPos = new THREE.Vector3();
const camLook = new THREE.Vector3();
const _cdVec = new THREE.Vector3();

el('nCars').textContent = String(karts.length);

function startRace() {
  audio.ensureAudio();
  audio.startMusic();
  resetKarts();
  game.raceTime = 0;
  game.raceOverAt = 0;
  const now = performance.now();
  game.raceStart = now + COUNTDOWN_MS;
  for (const k of karts) k.lapStart = game.raceStart;
  game.state = 'countdown';
  game.cdText = -1;
  hideOverlay();
  hideCountdown();
  startBtn.blur();
  // snap camera behind the player kart
  const p = player, f = new THREE.Vector3(Math.sin(p.heading), 0, Math.cos(p.heading));
  camPos.copy(p.pos).addScaledVector(f, -CAM_DIST);
  camPos.y = CAM_HEIGHT;
  camLook.copy(p.pos);
  camera.position.copy(camPos);
  camera.lookAt(camLook);
  updateHud(0, 0, karts);
}

function finishRace() {
  game.state = 'finished';
  hideCountdown();
  const best = player.lapDone > 0 ? Math.min(...player.lapTimes) : null;
  el('best').innerHTML = 'BEST <span class="val">' + fmt(best) + '</span>';
  const order = raceOrder();
  const rows = [];
  order.forEach((k, i) => {
    const nm = k.isPlayer ? 'YOU' : k.name;
    const lap = k.lapDone > 0 ? ' ' + fmt(k.lapTimes[k.lapTimes.length - 1]) : '';
    rows.push((i + 1) + '. ' + (k.isPlayer ? '<b>' + nm + '</b>' + lap : nm + lap));
  });
  const place = karts.indexOf(player) + 1;
  const placeMsg =
    place === 1 ? 'YOU WRECKED EVERYONE AROUND THE TABLE' :
    place === karts.length ? 'LAST PLACE ON THE DINNER TABLE' :
    'YOU FINISHED ' + place + ' OF ' + karts.length;
  showOverlay('RACE COMPLETE', placeMsg, 'RACE AGAIN', false, 'OR PRESS R');
  audio.stopMusicTimer();
  resultsEl.innerHTML = '<b>TOTAL ' + fmt(game.raceTime) + '</b> &nbsp;·&nbsp; BEST LAP <b>' +
    fmt(best) + '</b><div style="font-size:13px;letter-spacing:1px;margin-top:10px">' +
    rows.join(' &nbsp;&nbsp; ') + '</div>';
  resultsEl.style.display = '';
}

function primaryAction() {
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
  idx => { selectTrack(idx); },
);
if (getTrackIdx() !== 0) selectTrack(getTrackIdx());

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
 *  Race progress, positions & collisions
 * ------------------------------------------------------------------ */
function progress(k) {
  return k.lapDone + k.prevU;
}
function raceOrder() {
  return karts.slice().sort((a, b) => progress(b) - progress(a));
}
function refreshPositions() {
  const order = raceOrder();
  order.forEach((k, i) => { k.posIdx = i + 1; });
  return order;
}
function collideKarts() {
  for (let i = 0; i < karts.length; i++) {
    for (let j = i + 1; j < karts.length; j++) {
      const a = karts[i], b = karts[j];
      const dx = b.pos.x - a.pos.x, dz = b.pos.z - a.pos.z;
      const d2 = dx * dx + dz * dz;
      const min = 2.15;
      if (d2 < min * min && d2 > 1e-6) {
        const d = Math.sqrt(d2);
        const nx = dx / d, nz = dz / d;
        const push = (min - d) / 2 + 0.01;
        a.pos.x -= nx * push; a.pos.z -= nz * push;
        b.pos.x += nx * push; b.pos.z += nz * push;
        const va = Math.sin(a.heading) * a.speed * nx + Math.cos(a.heading) * a.speed * nz;
        const vb = Math.sin(b.heading) * b.speed * nx + Math.cos(b.heading) * b.speed * nz;
        const dv = vb - va;
        if (dv < 0) {
          const jimp = -0.58 * dv;
          a.speed -= Math.sin(a.heading) * jimp * 0.5 + Math.cos(a.heading) * jimp * 0.5;
          b.speed += Math.sin(b.heading) * jimp * 0.5 + Math.cos(b.heading) * jimp * 0.5;
          a.speed = clamp(a.speed, -MAX_REV, MAX_SPEED + 3);
          b.speed = clamp(b.speed, -MAX_REV, MAX_SPEED + 3);
          if (a.isPlayer || b.isPlayer) audio.crash(Math.min(1, -dv / 14));
        }
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 *  Cameras
 * ------------------------------------------------------------------ */
function snapChaseCam(dt) {
  const p = player;
  const fx = Math.sin(p.heading), fz = Math.cos(p.heading);
  const target = _cdVec.set(p.pos.x - fx * CAM_DIST, CAM_HEIGHT, p.pos.z - fz * CAM_DIST);
  camPos.lerp(target, 1 - Math.exp(-7 * dt));
  camera.position.copy(camPos);
  camLook.lerp(_cdVec.set(p.pos.x + fx * 3.5, 0.9, p.pos.z + fz * 3.5), 1 - Math.exp(-7 * dt));
  camera.lookAt(camLook);
}

/* ------------------------------------------------------------------ *
 *  Main loop
 * ------------------------------------------------------------------ */
const clock = new THREE.Clock();
const menuLook = new THREE.Vector3(0, 0, 5);

function animate() {
  requestAnimationFrame(animate);
  game.dt = Math.min(clock.getDelta(), 0.05);
  const dt = game.dt;
  const now = performance.now();

  if (game.state === 'menu') {
    const a = now * 0.00009;
    camera.position.set(Math.cos(a) * 105, 62, Math.sin(a) * 105 + 5);
    camera.lookAt(menuLook);
  } else if (game.state === 'countdown') {
    const remain = (game.raceStart - now) / 1000;
    const txt = remain <= 0 ? 'GO' : String(remain > 3 ? 3 : Math.ceil(remain - 1e-6));
    if (txt !== game.cdText) {
      game.cdText = txt;
      if (txt === 'GO') audio.go(); else audio.beep(440);
      const c = el('countdown');
      c.textContent = txt;
      c.classList.add('on');
      c.classList.toggle('go', txt === 'GO');
    }
    if (now >= game.raceStart + 700) {
      game.state = 'racing';
      hideCountdown();
    }
  } else {
    // control + integrate every kart
    for (const k of karts) {
      let throttle, steerIn;
      if (k.isPlayer) {
        const racing = game.state === 'racing';
        throttle = racing ? (keys.up ? 1 : 0) - (keys.down ? 1 : 0) : 0;
        steerIn  = racing ? (keys.left ? 1 : 0) - (keys.right ? 1 : 0) : 0;
      } else if (game.state === 'racing') {
        const c = aiControl(k, karts);
        throttle = c.throttle; steerIn = c.steer;
      } else {
        throttle = 0; steerIn = 0;
      }
      k.step(dt, throttle, steerIn, now);
    }
    collideKarts();
    const pSteer = (keys.left ? 1 : 0) - (keys.right ? 1 : 0);
    audio.updateEngine(player.speed, pSteer, !player.offRoad);
    if (player.lapDone !== game.lastLapBeep) {
      game.lastLapBeep = player.lapDone;
      if (player.lapDone > 0 && !player.raceDone) audio.lap();
    }
    if (game.state === 'racing') {
      refreshPositions();
      const finishedKarts = karts.filter(k => k.raceDone).length;
      if (player.raceDone === false && finishedKarts >= karts.length - 1 && game.raceOverAt === 0) {
        game.raceOverAt = now + 5000; // player still racing, rivals done — give it a moment
      }
      if (finishedKarts >= karts.length && game.raceOverAt === 0) game.raceOverAt = now + 1200;
    }
    for (const k of karts) k.sync(dt);
    game.raceTime = Math.max(0, (now - game.raceStart) / 1000);
    if (game.state !== 'finished') {
      updateHud(game.raceTime, Math.max(0, (now - player.lapStart) / 1000), karts);
      snapChaseCam(dt);
    }
    if (game.state === 'racing' && (player.raceDone || (game.raceOverAt && now >= game.raceOverAt))) finishRace();
  }
  renderer.render(scene, camera);
}

animate();
