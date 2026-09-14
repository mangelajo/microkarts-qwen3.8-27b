import {
  game, LAPS, COUNTDOWN_MS, INTERP_DELAY, N_SAMPLES,
  FELL_MIN_HEIGHT, FELL_PENALTY, ITEM_RESPAWN,
} from './config.js';
import { RelaySession } from './relaynet.js';
import { FrameRing, sampleState } from './interp.js';
import { TRACKS } from './tracks.js';
import { selectTrack, samples, trackLen } from './track.js';
import { tickCorners, closeCorners, resetCorners } from './corners.js';
import { setObstaclesOn, getObstaclesOn } from './obstacles.js';
import { setItemsOn, getItemsOn, itemBoxList } from './items.js';
import {
  el, startBtn, hostCode, hostMsg, joinMsg,
  setStatus, setMode, setHostRoster, initModePicker,
  setTrack, getTrackIdx, getItemOn,
  showOverlay, hideOverlay, hideCountdown, updateHud, fmt, resultsEl,
} from './hud.js';
import { podiumHtml, celebrate } from './resultsfx.js';
import { drawQr } from './qr.js';
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
  let prevRemoteY = []; // per-mirrored-kart height from the last frame (floor-hit FX)

  const role = () => game.netMode === 2 && net ? net.role : null;
  // "you" per device: host/solo = player kart · client = p2 (its own wire kart)
  const selfKart = () => role() === 'join' ? ctx.p2Ref() : ctx.player;

  function sessionCbs() {
    return {
      onOpen: () => {
        setStatus('CONNECTED');
        audio.beep(880);
        if (role() === 'host') { net.sendTrack(getTrackIdx(), getObstaclesOn(), getItemOn()); hostMsg.textContent = 'P2 connected! Pick a track, then press START RACE.'; }
        if (role() === 'join') { setJoinUi('connected'); joinMsg.textContent = 'Connected. Now just wait — the host starts the race.'; }
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
    if (s && s.role === 'join') {   // joiner lost the link: back to code entry
      setJoinUi('joining');
      joinMsg.textContent = 'CONNECTION LOST — enter the room code again (or re-scan the QR).';
    }
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

  const apiBase = () => {
    const m = new URLSearchParams(location.search).get('api');
    if (m) return m.replace(/\/$/, '');
    // same origin (production): the app's own directory — the game sits at
    // <base>/index.html and the relay at <base>/api/, so a bare '' would
    // hit the domain root and 404 in a subdirectory deploy (e.g. /microkarts/)
    try {
      return location.pathname.replace(/index\.html$/, '').replace(/\/$/, '');
    } catch { return ''; }   // headless: no location — no relay
  };

  function beginHostSession() {
    if (net) net.close();
    host.t = 0; host.acc = 0;
    lastNetInput = { throttle: 0, steer: 0, drift: false, use: false, ping: -1, at: 0 };
    ctx.ensureP2().netOn = false; // peer's kart is AI-free until the race starts
    net = new RelaySession('host', sessionCbs(), apiBase());
    net.hostStart('HOST', getTrackIdx()).then(code => {
      hostCode.textContent = code.replace(/^MKR-/, '');
      try { drawQr(el('hostCodeQr'), location.origin + location.pathname + '?join=' + code.replace(/^MKR-/, '')); el('hostCodeQr').classList.remove('hidden'); } catch { /* QR is optional decoration */ }
      hostMsg.textContent = 'Send this room code to player 2 (or let them scan the QR). They pick JOIN and type it — no shared network needed.';
    }).catch(err => { hostMsg.textContent = 'RELAY UNAVAILABLE — ' + err.message; });
  }

  // join-side menu UI: 'joining' = code entry + lobby visible; 'connected' =
  // big CONNECTED banner only (input box, JOIN button + race list go away)
  function setJoinUi(state) {
    const conn = el('joinConnected'), row = el('joinJoinRow'), lobby = el('lobbyWrap');
    if (!conn || !row) return;
    conn.classList.toggle('hidden', state !== 'connected');
    row.style.display = state === 'connected' ? 'none' : '';
    if (lobby) lobby.style.display = state === 'connected' ? 'none' : '';
  }
  const joinConnected = () => net && net.role === 'join' && net.active && net.open;

  function beginJoinSession() {
    if (game.netMode === 2 && net && net.role === 'join' && net.active) {
      setJoinUi(joinConnected() ? 'connected' : 'joining');   // re-click: keep the current state
      return;
    }
    if (net) net.close();
    startBtn.textContent = 'WAITING FOR HOST…';
    ctx.ensureP2();   // peer kart must exist before netMode=2 — racers() returns it, and a null entry would crash the frame loops
    game.netMode = 2;
    setHostRoster(game.roster);
    joinMsg.textContent = 'Type the 4-char room code (or scan the host\'s QR).';
    el('joinInField').innerText = '';
    setJoinUi('joining');
  }

  function joinRoom() {
    const code = el('joinInField').innerText.trim();
    if (!code) return;
    setJoinUi('joining');
    if (!net || net.role !== 'join' || !net.active) {
      if (net) net.close();
      net = new RelaySession('join', sessionCbs(), apiBase());
    }
    el('joinBtn').disabled = true;
    joinMsg.textContent = 'Joining room ' + code.toUpperCase() + '…';
    net.joinOffer(code).then(() => {
      el('joinCodeEcho').textContent = code.toUpperCase();
      joinMsg.textContent = 'Waiting for the host\'s signal… (status top-right)';
      el('joinBtn').disabled = false;
    }).catch(err => { joinMsg.textContent = 'BAD CODE — ' + err.message; el('joinBtn').disabled = false; });
  }

  // FIND A RACE: the room list (rooms.php) — poll while in the menu
  async function refreshLobby() {
    const listEl = el('lobbyList');
    if (!listEl) return;
    try {
      const r = await fetch(apiBase() + '/api/rooms.php');
      const j = await r.json();
      const rooms = (j && j.rooms) || [];
      listEl.innerHTML = '';
      if (!rooms.length) {
        const d = document.createElement('div');
        d.className = 'lobby-empty';
        d.textContent = 'NO ACTIVE ROOMS — create one on the left.';
        listEl.appendChild(d);
      }
      for (const room of rooms) {
        const row = document.createElement('div');
        row.className = 'lobby-row';
        const label = document.createElement('span');
        label.textContent = room.code + '  ·  ' + room.name + '  ·  ' + ((TRACKS[room.track] || {}).name || '?');
        const btn = document.createElement('button');
        btn.textContent = 'JOIN';
        btn.onclick = () => {
          el('joinInField').innerText = room.code;
          joinRoom();
        };
        row.appendChild(label); row.appendChild(btn);
        listEl.appendChild(row);
      }
    } catch {
      const d = document.createElement('div');
      d.className = 'lobby-empty';
      d.textContent = 'RELAY OFFLINE — cannot reach the room list.';
      listEl.appendChild(d);
    }
  }
  setInterval(() => { if (game.state === 'menu' && !joinConnected()) refreshLobby(); }, 4000);

  function clientStart(info) {
    ctx.ensureP2();
    clientItemSeen = ctx.racers().map(() => false);
    game.roster = info.karts === 2 ? '1v1' : '2ai';
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
      // explosion mirror: a remote kart falling to the table (y drops from
      // the track to 0) bursts — read from the existing y f32, no wire change
      const my = m.y ?? 0;
      if (my < 0.5 && prevRemoteY[i] > 2 && k !== ctx.player) ctx.boom(k.pos.x, 0, k.pos.z);
      prevRemoteY[i] = my;
      // cosmetic tumble mirror: run the same corner-torque dynamics as the
      // local sim so a falling remote kart tips the same way (host stays
      // authoritative for position; the pose is derived, never sent)
      const bi = nearestSampleIdx(m.x, m.z);
      k.trackIdx = bi;
      // per-corner timing on the interpolated mirror (cosmetic delta)
      if (m.lapDone !== k._cl) {
        k._cl = m.lapDone;
        closeCorners(k, performance.now());
        k.lapCorners = k.cornerTimes.slice();
        resetCorners(k);
      }
      const cc = tickCorners(k, performance.now());
      if (cc >= 0) k.cornerClosedNow = { idx: cc, t: performance.now() };
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
      if (!ctx.player.fellOff) { ctx.boom(ctx.player.pos.x, 0, ctx.player.pos.z); audio.explode(); }
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
    const nameOfIdx = idx => idx === list.length - 2 ? '<b>YOU</b>' : idx === list.length - 1 ? '<b>P1</b>' : list[idx].name;
    const rows = order.map((idx, i) => {
      const nm = nameOfIdx(idx);
      const lap = lapsMs[idx] ? ' ' + fmt(lapsMs[idx] / 1000) : '';
      return (i + 1) + '. ' + nm + lap;
    });
    const nameOf = idx => idx === list.length - 2 ? 'YOU' : idx === list.length - 1 ? 'P1' : list[idx].name;
    resultsEl.innerHTML = podiumHtml(order, nameOf) + rows.join(' &nbsp;&nbsp; ');
    resultsEl.style.display = '';
    celebrate();   // confetti burst (resultsfx.js)
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
        beginJoinSession();
      }
    },
    joinRoom,
    r => { game.roster = r; setHostRoster(r); if (game.netMode === 2) ctx.syncRosterVisibility(); },
  );

  // ?join=CODE (scanned on P2's phone): select JOIN mode, create the
  // session, pre-fill the room code and connect immediately — one tap.
  function joinAuto(code) {
    if (game.state === 'racing' || game.state === 'countdown') return;
    beginJoinSession();
    el('joinInField').innerText = code;
    joinRoom();
  }

  return {
    role, selfKart, host, broadcast,
    net: () => net,
    input: () => lastNetInput,
    inputNow: (t, s, d, u) => net && net.sendInput && net.sendInput(t, s, d, u),
    resetClientItems: () => { clientItemSeen = ctx.racers().map(() => false); },
    applyClientState,
    beginHostSession, joinRoom, joinAuto, onPeerLost, refreshLobby, apiBase,
  };
}
