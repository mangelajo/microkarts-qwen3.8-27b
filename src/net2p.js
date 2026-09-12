import {
  game, LAPS, COUNTDOWN_MS, INTERP_DELAY, N_SAMPLES,
  FELL_MIN_HEIGHT, FELL_PENALTY, ITEM_RESPAWN,
} from './config.js';
import { NetSession } from './net.js';
import { FrameRing, sampleState } from './interp.js';
import { selectTrack, samples, trackLen } from './track.js';
import { setObstaclesOn, getObstaclesOn } from './obstacles.js';
import { setItemsOn, getItemsOn, itemBoxList } from './items.js';
import {
  el, startBtn, hostCode, hostMsg, joinMsg,
  setStatus, setMode, setHostRoster, initModePicker,
  setTrack, getTrackIdx, getItemOn,
  showOverlay, hideOverlay, hideCountdown, updateHud, fmt, resultsEl,
} from './hud.js';
import * as audio from './audio.js';
import { ghostStop } from './ghost.js';
import { pulseHint } from './touch.js';

/* ------------------------------------------------------------------ *
 *  2P net orchestration — host = authoritative fixed-step sim, join =
 *  render-only (interpolates host state, streams input). Owns the
 *  NetSession + all session state; game.js hands in the shared game
 *  context (roster, karts, input, camera) and drives the per-frame
 *  host ticks / client render pass. One-way dependency: net2p never
 *  imports game.js.
 * ------------------------------------------------------------------ */
export function createNet2p(ctx) {
  // ctx: { karts, player, p2Ref, ensureP2, racers, syncRosterVisibility,
  //        addShake, snapChaseCam, camSnap }

  let net = null;
  const host = { t: 0, acc: 0, enc: null }; // host sim clock (ms) + state encoder (set by game.js startRace)
  let lastNetInput = { throttle: 0, steer: 0, drift: false, use: false, ping: -1, at: 0 };
  let clientRing = null;
  let clientLapSeen = [];
  let clientLapMark = []; // host-sim-ms of each kart's last detected line crossing
  let netStartWall = 0;      // join role: when the host's start frame landed
  let clientItemSeen = [];   // per-kart: did the last frame carry an item? (pickup mirror)
  let lastClientSp = 0; // own-kart speed from the last applied frame (impact estimate)
  let lastClientY = 0; // own-kart height — detects a fall for the HUD message

  const role = () => game.netMode === 2 && net ? net.role : null;
  // "you" per device: host/solo = player kart · client = p2 (its own wire kart)
  const selfKart = () => role() === 'join' ? ctx.p2Ref() : ctx.player;

  function sessionCbs() {
    return {
      onOpen: () => {
        setStatus('CONNECTED');
        audio.beep(880);
        if (role() === 'host') { net.sendTrack(getTrackIdx(), getObstaclesOn(), getItemOn()); hostMsg.textContent = 'P2 connected! Pick a track, then press START RACE.'; }
        if (role() === 'join') joinMsg.textContent = 'CONNECTED! Now wait — the host picks the track and starts the race.';
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
          if (role() === 'host') hostMsg.textContent = hint;
          if (role() === 'join') joinMsg.textContent = hint;
        }
      },
      onPrep: prep => {
        if (role() !== 'join') return;
        if (prep.trackIdx !== getTrackIdx()) setTrack(prep.trackIdx); // mirror the host's pick
        netStartWall = performance.now();
        clientRing = new FrameRing();
        clientLapSeen = ctx.racers().map(() => 0);
        clientLapMark = ctx.racers().map(() => 0);
        game.raceStart = netStartWall + prep.cdMs;
        game.raceOverAt = 0;
        game.cdText = -1;
        ctx.syncRosterVisibility();
        if (game.state !== 'countdown') { // skip the re-countdown after a finished race
          game.state = 'countdown';
          hideOverlay();
          hideCountdown();
        }
      },
      onTrack: (idx, haz, itm) => { // host → live picker preview (client watches the host's chips)
        if (role() !== 'join') return;
        const wantObs = haz === undefined ? getObstaclesOn() : !!haz;
        const wantItm = itm === undefined ? getItemsOn() : !!itm;   // old host: keep local
        const obsChanged = getObstaclesOn() !== wantObs;
        const itmChanged = getItemsOn() !== wantItm;
        const idxChanged = idx !== getTrackIdx();
        if (!idxChanged && !obsChanged && !itmChanged) return;
        if (obsChanged) setObstaclesOn(wantObs);
        if (itmChanged) setItemsOn(wantItm);
        if (idx === getTrackIdx()) selectTrack(idx);  // flag-only change: rebuild, chips already right
        else setTrack(idx);                            // idx change: rebuild + chips via onChange
      },
      onStart: info => {
        if (role() !== 'join') return;
        clientStart(info);
      },
      onState: st => {
        // session already decoded the frame: { hostMs, echoPing, karts }
        if (role() !== 'join') return;
        if (!clientRing) return;
        clientRing.push(st, performance.now());
        mirrorItemPickups(st);   // boxes are deterministic locally — no wire traffic
        game.net = st;
        clientRaceBookkeeping(st);
        // RTT readout: host echoes the ping from our latest input
        if (st.echoPing !== lastNetInput.ping && lastNetInput.at > 0) {
          const rtt = Math.round(performance.now() - lastNetInput.at);
          if (rtt > 0 && rtt < 2500) { setStatus('P2 CONNECTED · ' + rtt + ' ms'); net.rtt = rtt; }
        }
      },    onFinish: (order, lapsMs) => {
        if (role() !== 'join') return;
        clientFinish(order, lapsMs);
      },
      onInput: inp => { // client → host: drives the peer's kart on the sim
        lastNetInput = { throttle: inp.throttle, steer: inp.steer, drift: inp.drift, use: !!inp.use, ping: inp.ping, at: performance.now() };
      },
      onClose: () => onPeerLost(),
    };
  }

  function onPeerLost() {
    const wasNet = game.netMode === 2;
    const wasRacing = wasNet && (game.state === 'racing' || game.state === 'countdown');
    game.netMode = 0;
    startBtn.textContent = 'START RACE';
    ghostStop();
    if (clientRing) clientRing.clear();
    const s = net; net = null;
    if (s && !s.closed) s.close(); // fires onClose → re-enters onPeerLost, guarded by s.closed
    host.acc = 0; lastNetInput.ping = -1;
    lastNetInput = { throttle: 0, steer: 0, drift: false, use: false, ping: -1, at: 0 };
    const p = ctx.p2Ref(); if (p) p.netOn = false;
    ctx.syncRosterVisibility();
    if (wasNet && wasRacing) {
      game.state = 'menu';
      game.raceOverAt = 0;
      game.laps = LAPS;
      ctx.karts.forEach(k => { k.raceDone = false; k.lapDone = 0; k.lapTimes = []; k.laps = LAPS; });
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
    host.t = 0; host.acc = 0;
    lastNetInput = { throttle: 0, steer: 0, drift: false, use: false, ping: -1, at: 0 };
    ctx.ensureP2().netOn = false; // peer's kart is AI-free until the channel opens
    net = new NetSession('host', sessionCbs());
    net.kartN = ctx.racers().length;
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

  function clientStart(info) {
    ctx.ensureP2();
    clientItemSeen = ctx.racers().map(() => false);
    game.roster = info.karts === 2 ? '1v1' : '2ai';
    net.kartN = info.karts;
    ctx.syncRosterVisibility();
    for (const k of ctx.racers()) { k.laps = info.laps; }
    for (let i = 0; i < ctx.racers().length; i++) {
      ctx.racers()[i].placeAt(info.grid[i * 2], info.grid[i * 2 + 1]);
    }
    game.laps = info.laps;
    clientRing = new FrameRing();
    lastClientSp = 0;
    clientLapSeen = ctx.racers().map(() => 0);
    clientLapMark = ctx.racers().map(() => 0);
    netStartWall = performance.now();
    game.raceStart = netStartWall + COUNTDOWN_MS;
    game.raceOverAt = 0;
    game.state = 'countdown';
    game.cdText = -1;
    hideOverlay();
    hideCountdown();
    // snap camera behind our grid spot (state frames take over in a moment)
    ctx.camSnap(selfKart());
    pulseHint();               // client sees the same cue when the host's race begins
  }

  // client mirrors host lap/finish events from the snapshot deltas
  function clientRaceBookkeeping(st) {
    const list = ctx.racers();
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

  // the client never runs the sim — derive the road slope at a kart's XZ so
  // remote karts sit on the elevated road and pitch with it (PLAN.md 3D)
  function nearestSampleIdx(x, z) {
    let best = 0, bd = Infinity;
    for (let i = 0; i < N_SAMPLES; i++) {
      const dx = samples[i].x - x, dz = samples[i].z - z;
      const d = dx * dx + dz * dz;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  function slopeAtKart(x, z) {
    const best = nearestSampleIdx(x, z);
    return (samples[(best + 1) % N_SAMPLES].y - samples[(best + N_SAMPLES - 1) % N_SAMPLES].y)
      / Math.max(1e-6, 2 * trackLen / N_SAMPLES);
  }

  function applyClientState(dt) {
    if (!clientRing || clientRing.size < 1) return;
    const st = sampleState(clientRing, performance.now() - INTERP_DELAY);
    if (!st || !game.net) return;
    const list = ctx.racers();
    for (let i = 0; i < list.length && i < st.karts.length; i++) {
      const k = list[i], m = st.karts[i];
      k.pos.set(m.x, m.y ?? 0, m.z);
      k.slope = slopeAtKart(m.x, m.z);
      k.heading = m.heading;
      k.speed = m.speed;
      k.steerVel = m.steerVel;
      k.offRoad = m.offRoad;
      k.posIdx = m.posIdx;
      k.item = m.item ?? 0;   // held item (interpolated frames pass it through intact)
      // cosmetic tumble mirror: run the same corner-torque dynamics as the
      // local sim so a falling remote kart tips the same way (host stays
      // authoritative for position; the pose is derived, never sent)
      const my = m.y ?? 0;
      const bi = nearestSampleIdx(m.x, m.z);
      k.trackIdx = bi;
      const ry = samples[bi].y;
      if (my > 0.3 && my < ry - 1) {
        k.tumbling = true;
        k.updateTumble(dt);
      } else {
        k.tumbling = false;
        k.omegaP = 0;
        k.omegaR = 0;
        if (my >= ry - 1.5) k.roll += (0 - k.roll) * Math.min(1, 8 * dt);   // settle flat
      }
      k.sync(dt); // cosmetic: wheels, roll, pitch (fed by interpolated speed)
    }
    // fell-off message: the host runs the penalty sim; the client just mirrors
    // its own kart's fellOff so the HUD reads the same (y drops from the
    // track to the table, then clears when it respawns back up)
    if (lastClientY > FELL_MIN_HEIGHT && ctx.player.pos.y < 0.3) {
      ctx.player.fellOff = true;
      ctx.player.fellTimer = FELL_PENALTY;
    }
    if (ctx.player.fellOff) {
      ctx.player.fellTimer -= dt;
      if (ctx.player.fellTimer <= 0 || ctx.player.pos.y > 1) ctx.player.fellOff = false;
    }
    lastClientY = ctx.player.pos.y;
    // collision juice on the client: we don't run the sim, so estimate our own
    // impact from how hard our kart's speed dropped since the last frame
    const sk = selfKart();
    const drop = lastClientSp - sk.speed;
    if (drop > 5 && sk.speed > 1) {
      sk.jolt = Math.min(1, drop / 16);
      ctx.addShake(sk.jolt * 0.8);
      audio.crash(sk.jolt);
    }
    lastClientSp = Math.abs(sk.speed);
    game.raceTime = st.hostMs / 1000;
    const you = list.length - 2; // client "you" = p2; updateHud reads the last kart
    const lapStartMs = clientLapMark[you] || COUNTDOWN_MS; // host clock: GO at cdMs
    const hudList = [...list.slice(0, -2), ctx.player, ctx.p2Ref()];
    updateHud(game.raceTime, Math.max(0, (st.hostMs - lapStartMs) / 1000), hudList);
    ctx.snapChaseCam(dt);
  }

  function clientFinish(order, lapsMs) {
    game.state = 'finished';
    hideCountdown();
    const list = ctx.racers();
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

  /* Item pickup mirror (join client only): when a kart's item goes 0 -> X the
   * host just grabbed a box — hide the nearest live box for the respawn window
   * so our boxes match the host's. Layout + rolls are seeded identically on
   * both ends, so only the pickup itself needs mirroring (it already rides
   * the item field; we just use it to schedule the local box's cooldown). */
  function mirrorItemPickups(st) {
    const list = ctx.racers();
    for (let i = 0; i < list.length && i < st.karts.length; i++) {
      const it = st.karts[i].item ?? 0;
      if (it && !clientItemSeen[i]) {
        let best = null, bd = 3 * 3;
        for (const b of itemBoxList) {
          if (b.respawnT > 0) continue;
          const d2 = (b.x - st.karts[i].x) ** 2 + (b.z - st.karts[i].z) ** 2;
          if (d2 < bd) { bd = d2; best = b; }
        }
        if (best) best.respawnT = ITEM_RESPAWN;
      }
      clientItemSeen[i] = !!it;
    }
  }

  // host → client: one state frame per sim tick (encoder set by game.js)
  function broadcast() {
    if (net && net.open) net.sendState(host.enc(host.t, lastNetInput.ping, ctx.racers()));
  }

  /* ---------------------------- HUD / mode wiring ---------------------------- */
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
        ctx.syncRosterVisibility();
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
    r => { game.roster = r; setHostRoster(r); if (game.netMode === 2) ctx.syncRosterVisibility(); },
  );

  return {
    role, selfKart, host, broadcast,
    net: () => net,
    input: () => lastNetInput,
    inputNow: (t, s, d, u) => net.inputNow(t, s, d, u),
    resetClientItems: () => { clientItemSeen = ctx.racers().map(() => false); },
    applyClientState,
    beginHostSession, hostPasteAnswer, joinPasteOffer, onPeerLost,
  };
}
