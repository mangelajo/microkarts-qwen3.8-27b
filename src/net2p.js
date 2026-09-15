import {
  game, LAPS, COUNTDOWN_MS, INTERP_DELAY, N_SAMPLES,
  FELL_MIN_HEIGHT, FELL_PENALTY, ITEM_RESPAWN, P2_COLOR,
} from './config.js';
import { WSSession, wsUrl } from './wsnet.js';
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
  // render-time pacing (no rewinds — the old law moved the render target
  // directly with the delay, so every delay change (the 2 ms/frame shrink,
  // the +25 starvation step) slid the sampled moment BACK — the cart
  // advanced, moved back, advanced, moved back). Now:
  //   * renderT = the sampled moment, monotonic non-decreasing
  //   * targetDelay = the p95-jitter desired buffer — it only moves the
  //     CLAMPS (fast-forward bound, hold bound), never the target itself
  //   * behind the desired delay → bounded 3× fast-forward (a slide)
  //   * starved (past the newest frame) → hold at newest + 80 ms
  //     (sampleState extrapolates within that window)
  let renderT = 0;                 // 0 = not seeded (first frame seeds it)
  let targetDelay = INTERP_DELAY;  // desired buffer, p95-adapted (60–350 ms)
  let lastStateAt = 0;
  let gapHist = [];                  // recent inter-frame gaps (ms)
  let lastSeq = null;               // last state-frame tick seq (u16)
  let lastLagMs = 0;   // how old the sampled snapshot was (the real perceived delay)
  let clientLapSeen = [];
  let clientLapMark = []; // host-sim-ms of each kart's last detected line crossing
  let netStartWall = 0;      // join role: when the host's start frame landed
  let clientItemSeen = [];   // per-kart: did the last frame carry an item? (pickup mirror)
  let lastClientSp = 0; // own-kart speed from the last applied frame (impact estimate)
  let lastClientY = 0; // own-kart height — detects a fall for the HUD message
  let prevRemoteY = []; // per-mirrored-kart height from the last frame (floor-hit FX)

  const role = () => game.netMode === 2 && net ? net.role : null;
  // "you" per device: host/solo = player kart · client = p2 (its own wire kart)
  const selfKart = () => (wsMode() && net
    ? ctx.racers()[mySlot()]   // WS: the vessel that mirrors MY server slot
    : role() === 'join' ? ctx.p2Ref() : ctx.player);

  function sessionCbs() {
    return {
      onOpen: () => {
        setStatus('SERVER CONNECTED');
        audio.beep(880);
        if (role() === 'host') { hostMsg.textContent = 'Waiting for a joiner — send them the code (or QR).'; }
        if (role() === 'join') { setJoinUi('connected'); joinMsg.textContent = 'Connected. Now just wait — the host starts the race.'; }
      },
      onPeerJoined: () => {
        if (role() !== 'host') return;
        if (net && net.isWS) net.sendTrack(getTrackIdx(), getObstaclesOn(), getItemOn());
        updateHostPlayers(2, true);
      },
      onStatus: s => {
        const label = {
          'connecting': 'CONNECTING…',
          'online': 'SERVER CONNECTED',
          'offline': (game.netMode === 2 ? 'SERVER OFFLINE' : ''),
        }[s];
        if (label) setStatus(label);
        if (s === 'offline' && game.netMode === 2) {
          const hint = 'SERVER LINK LOST — reconnect (or the room dissolved). Solo still works.';
          if (role() === 'host') hostMsg.textContent = hint;
          if (role() === 'join') joinMsg.textContent = hint;
        }
      },
      onPrep: prep => {
        if (role() !== 'join' && !wsMode()) return;
        if (prep.trackIdx !== getTrackIdx()) setTrack(prep.trackIdx); // mirror the host's pick
        netStartWall = performance.now();
        clientRing = new FrameRing(24);
        gapHist.length = 0; lastSeq = null; renderT = 0;
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
        if (role() !== 'join' && !wsMode()) return;
        clientStart(info);
      },
      onState: st => {
        // session already decoded the frame: { hostMs, echoPing, karts }
        if (role() !== 'join' && !wsMode()) return;
        if (!clientRing) return;
        const nowA = performance.now();
        const gap = lastStateAt ? nowA - lastStateAt : 100;
        lastStateAt = nowA;
        // --- adaptive target buffer (moves the clamps, never the render time) ---
        gapHist.push(gap); if (gapHist.length > 40) gapHist.shift();
        if (st.seq != null) {
          if (lastSeq != null) {
            const d = (st.seq - lastSeq) & 0xffff;   // u16 distance (handles wrap)
            if (d > 1 && d < 0x8000) targetDelay = Math.min(350, targetDelay + 33);
          }
          lastSeq = st.seq;
        }
        if (renderT > 0 && renderT > clientRing.newestAt() + 80) {
          targetDelay = Math.min(350, targetDelay + 25);   // starving — widen fast
        } else if (gapHist.length > 4) {
          const s = gapHist.slice().sort((a, b) => a - b);
          const p95 = s[Math.min(s.length - 1, Math.floor(s.length * 0.95))];
          const floor = Math.max(60, Math.min(350, p95 * 1.2 + 15));
          targetDelay = Math.max(floor, targetDelay - 2);  // drift slowly back
        }
        if (!renderT) renderT = nowA - targetDelay;   // seed on the first frame
        clientRing.push(st, nowA);
        mirrorItemPickups(st);   // boxes are deterministic locally — no wire traffic
        game.net = st;
        clientRaceBookkeeping(st);
        // RTT readout: WS mode uses the session's PING/PONG RTT; the legacy
        // echo-ping path survives for any non-WS transport
        if (wsMode() && net.rttMs) {
          setStatus('P2 CONNECTED · ' + net.rttMs + ' ms');
          net.rtt = net.rttMs;
        } else if (st.echoPing !== lastNetInput.ping && lastNetInput.at > 0) {
          const rtt = Math.round(performance.now() - lastNetInput.at);
          if (rtt > 0 && rtt < 2500) { setStatus('P2 CONNECTED · ' + rtt + ' ms'); net.rtt = rtt; }
        }
      },    onFinish: f => {
        if (role() !== 'join' && !wsMode()) return;
        const order = Array.isArray(f) ? f : f.order;
        const lapsMs = Array.isArray(f) ? null : f.laps;
        clientFinish(order, lapsMs);
      },
      onInput: inp => { // server echoes our input back (the RTT readout uses the PING/PONG path)
        if (inp) lastNetInput = { throttle: inp.throttle, steer: inp.steer, drift: inp.drift, use: !!inp.use, ping: inp.ping, at: lastNetInput.at || performance.now() };
      },
      onClose: () => onPeerLost(),
      onPeerLost: () => onPeerLost(),
    };
  }

  // WSSession registers callbacks explicitly (RelaySession took them at
  // construction) — wire the same cbs object onto either shape
  function wireSession(s) {
    const cbs = sessionCbs();
    for (const k of ['onOpen', 'onStatus', 'onPrep', 'onTrack', 'onStart', 'onState', 'onFinish', 'onInput', 'onPeerLost', 'onPeerJoined', 'onClose']) {
      if (cbs[k] && s[k]) s[k](cbs[k]);
    }
  }

  function onPeerLost() {
    const wasNet = game.netMode === 2;
    const wasRacing = wasNet && (game.state === 'racing' || game.state === 'countdown');
    game.netMode = 0;
    if (hostPoll) { clearInterval(hostPoll); hostPoll = null; }
    if (hostHelloTimer) { clearTimeout(hostHelloTimer); hostHelloTimer = null; }
    hostReady = false;
    startBtn.textContent = 'START RACE';
    ghostStop();
    if (clientRing) clientRing.clear();
    const s = net; net = null;
    if (s && !s.closed) s.close(); // fires onClose → re-enters onPeerLost, guarded by s.closed
    host.acc = 0; lastNetInput.ping = -1;
    lastStateAt = 0;   // don't carry the drop's gap into the next session's buffer
    gapHist.length = 0; lastSeq = null; renderT = 0;
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

  const wsMode = () => !!(net && net.isWS);
  const mySlot = () => net ? (net.slot >= 0 ? net.slot : (role() === 'join' ? 1 : 0)) : 0;

  const httpBase = () => {
    // the lobby/rooms HTTP endpoint sits on the same origin as the ws server
    const q = new URLSearchParams(location.search).get('ws');
    try {
      if (q) return q.replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://').replace(/\/ws$/, '');
      return location.origin;
    } catch { return ''; }   // headless: no location
  };

  let hostReady = false;   // a joiner is actually in the room (PEER_JOINED or room poll)
  let hostPoll = null;    // 2 s room-list poll — the host screen shows the live player count
  let hostHelloTimer = null;

  function beginHostSession() {
    if (net) net.close();
    host.t = 0; host.acc = 0;
    lastNetInput = { throttle: 0, steer: 0, drift: false, use: false, ping: -1, at: 0 };
    ctx.ensureP2().netOn = false; // peer's kart is AI-free until the race starts
    game.netMode = 2;   // the host IS a 2P device (racers() must use the 2P/WS order)
    net = new WSSession(wsUrl());
    net.role = 'host';
    net.active = true;
    hostReady = false;
    wireSession(net);
    startBtn.textContent = 'CONNECTING…';
    hostMsg.textContent = 'Connecting to the server…';
    // a server that never answers HELLO must not leave the screen stuck on CONNECTING
    let helloDone = false;
    hostHelloTimer = setTimeout(() => {
      if (helloDone) return;
      startBtn.textContent = 'START RACE';
      hostMsg.textContent = 'COULD NOT REACH THE MULTIPLAYER SERVER — check the connection (or ?ws=ws://host:port/ws). Solo still works.';
    }, 8000);
    net.open('H', 'HOSTY').then(ok => {
      helloDone = true; clearTimeout(hostHelloTimer);
      if (!ok) {
        startBtn.textContent = 'START RACE';
        hostMsg.textContent = 'MULTIPLAYER SERVER UNREACHABLE — solo still works; or ?ws=ws://host:port/ws to point at one.';
        return;
      }
      hostCode.textContent = net.code;
      startBtn.textContent = 'START RACE';   // gated until a joiner is in (hostReady)
      try { drawQr(el('hostCodeQr'), location.origin + location.pathname + '?join=' + net.code); el('hostCodeQr').classList.remove('hidden'); } catch { /* QR is optional decoration */ }
      hostMsg.textContent = 'PLAYERS 1/2 — send this room code to player 2 (or let them scan the QR).';
      // live player count: the /rooms endpoint carries the room's player total,
      // so the screen shows 1/2 → 2/2 even if the PEER_JOINED frame is lost
      if (hostPoll) clearInterval(hostPoll);
      hostPoll = setInterval(() => {
        if (!net || net.role !== 'host' || !net.code) return;
        fetch(httpBase() + '/rooms').then(r => r.json()).then(j => {
          const arr = Array.isArray(j) ? j : (j && j.rooms) || [];
          const mine = arr.find(rm => rm.code === net.code);
          updateHostPlayers(mine ? mine.players : 0, false);
        }).catch(() => { /* transient network blip — the next poll retries */ });
      }, 2000);
    });
  }

  function updateHostPlayers(n, fromFrame) {
    if (n >= 2) {
      if (!hostReady) {
        hostReady = true;
        startBtn.textContent = 'START RACE';
        audio.beep(1180);
      }
      hostMsg.textContent = 'PLAYERS 2/2 — ready. Pick a track, then press START RACE.';
    } else {
      hostMsg.textContent = 'PLAYERS ' + n + '/2 — waiting for a joiner… send the code (or the QR).';
    }
    if (fromFrame) hostCode.textContent = net ? net.code : hostCode.textContent; // frame path: ensure the code is on screen
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
  const joinConnected = () => net && net.role === 'join' && net.active && net.connected;

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
    const code = el('joinInField').innerText.trim().toUpperCase();
    if (!code) return;
    setJoinUi('joining');
    if (!net || net.role !== 'join' || !net.active) {
      if (net) net.close();
      net = new WSSession(wsUrl());
      net.role = 'join';
      net.active = true;
      wireSession(net);
    }
    el('joinBtn').disabled = true;
    joinMsg.textContent = 'Joining room ' + code + '…';
    net.open('J', 'JOINR', code).then(ok => {
      el('joinBtn').disabled = false;
      if (!ok) { joinMsg.textContent = 'COULD NOT REACH THE SERVER — check your connection (or ?ws=ws://host:port/ws).'; return; }
      el('joinCodeEcho').textContent = code;
      setJoinUi('connected');
      joinMsg.textContent = 'Connected. Now just wait — the host starts the race.';
    });
  }

  // FIND A RACE: the room list (the server's /rooms endpoint) — poll while in the menu
  async function refreshLobby() {
    const listEl = el('lobbyList');
    if (!listEl) return;
    try {
      const r = await fetch(httpBase() + '/rooms');
      const j = await r.json();
      const rooms = Array.isArray(j) ? j : (j && j.rooms) || [];
      listEl.innerHTML = '';
      if (!rooms.length) {
        const d = document.createElement('div');
        d.className = 'lobby-empty';
        d.textContent = 'NO ACTIVE ROOMS — HOST 2P (above) creates one.';
        listEl.appendChild(d);
      }
      for (const room of rooms) {
        const row = document.createElement('div');
        row.className = 'lobby-row';
        const label = document.createElement('span');
        label.textContent = room.code + '  ·  ' + room.host + '  ·  ' + ((TRACKS[room.track] || {}).name || '?');
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
      d.textContent = 'SERVER OFFLINE — cannot reach the room list.';
      listEl.appendChild(d);
    }
  }
  setInterval(() => { if (game.state === 'menu') refreshLobby(); }, 4000);

  function clientStart(info) {
    ctx.ensureP2();
    clientItemSeen = ctx.racers().map(() => false);
    game.roster = info.karts === 2 ? '1v1' : '2ai';
    ctx.syncRosterVisibility();
    for (const k of ctx.racers()) { k.laps = info.laps; }
    for (let i = 0; i < ctx.racers().length; i++) {
      ctx.racers()[i].placeAt(info.grid[i * 2], info.grid[i * 2 + 1]);
    }
    // repaint per WIRE slot (WS only — the legacy LAN order keeps its
    // traditional palette): a local object's paint follows the object, but
    // each device's local objects sit at different slots (the host's player
    // is wire 0, the joiner's player is wire 1) — without this, the same
    // kart is red on one screen and green on the other. Palette:
    // 0 = host (red), 1 = joiner (P2 green), 2/3 = the AI colours.
    if (wsMode()) {
      const PAL = [
        [0xe0392b, 0xf6c445], [P2_COLOR, 0xf6c445],
        [0x2e7dd1, 0x80c8e0], [0x39b17c, 0xa8e6c0],
      ];
      for (let i = 0; i < ctx.racers().length && i < 4; i++)
        ctx.racers()[i].setColor(PAL[i][0], PAL[i][1]);
    }
    game.laps = info.laps;
    clientRing = new FrameRing(24);
    gapHist.length = 0; lastSeq = null; renderT = 0;
    lastClientSp = 0;
    clientLapSeen = ctx.racers().map(() => 0);
    clientLapMark = ctx.racers().map(() => 0);
    netStartWall = performance.now();
    game.raceStart = netStartWall + COUNTDOWN_MS;
    game.raceOverAt = 0;
    game.state = 'countdown';
    game.cdText = -1;
    hideOverlay();
    ctx.racers().forEach(k => { k.lapStart = game.raceStart; });   // HUD lap-timer base
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
        list[i].lapStart = performance.now();        // HUD lap-timer re-bases
        const isYou = i === mySlot();
        const isP1 = i === 0 && mySlot() !== 0;
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
    const nowA = performance.now();
    // --- monotonic render-time pacing (the cart can never rewind) ---
    // dt is bounded: a backgrounded tab (a 1 s dt) must slide forward, not
    // jump — an unbounded step would let renderT run past newest+80 and the
    // hold clamp below would slide it BACK.
    const step = Math.min(dt * 1000, 100);
    const newest = clientRing.newestAt();
    if (renderT <= 0) renderT = newest - targetDelay;   // (re)seed
    else {
      const desired = newest - targetDelay;
      if (renderT < desired) {
        // buffer deeper than the target: catch up at 3× real time (a slide)
        renderT = Math.min(desired, renderT + step * 3);
      } else if (renderT > newest) {
        // starved: hold inside the extrapolation window (no advance, no slide back)
        if (renderT > newest + 80) renderT = newest + 80;
      } else {
        // normal: real-time advance, capped inside the extrapolation window
        // (so the starved hold below can never slide the target back)
        renderT = Math.min(renderT + step, newest + 80);
      }
    }
    const st = sampleState(clientRing, renderT);
    if (!st || !game.net) return;
    // perceived delay: how old the sampled snapshot is on the arrival clock
    lastLagMs = Math.max(0, nowA - renderT);
    const list = ctx.racers();
    for (let i = 0; i < list.length && i < st.karts.length; i++) {
      const k = list[i], m = st.karts[i];
      k.pos.set(m.x, m.y ?? 0, m.z);
      k.slope = slopeAtKart(m.x, m.z);
      k.heading = m.heading;
      k.speed = m.speed;
      k.steerVel = m.steerVel;
      k.offRoad = m.offRoad;
      k.fellOff = m.fellOff;   // server-authoritative fall state (floor-hit FX + HUD)
      k.posIdx = m.posIdx;
      k.item = m.item ?? 0;   // held item (interpolated frames pass it through intact)
      // explosion mirror: a remote kart falling to the table (y drops from
      // the track to 0) bursts — read from the existing y f32, no wire change
      const my = m.y ?? 0;
      if (my < 0.5 && prevRemoteY[i] > 2 && k !== selfKart()) ctx.boom(k.pos.x, 0, k.pos.z);
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
    // updateHud reads the LAST kart as "you" — in WS mode the self vessel
    // is racers()[mySlot()] (player on both devices), p2 mirrors the peer
    const selfV = selfKart();
    const peerVessel = selfV === ctx.player ? ctx.p2Ref() : ctx.player;
    const hudList = (wsMode() && net)
      ? [...list.slice(0, -2), peerVessel, selfV]
      : [...list.slice(0, -2), ctx.player, ctx.p2Ref()];
    updateHud(game.raceTime, Math.max(0, (st.hostMs - lapStartMs) / 1000), hudList);
    ctx.snapChaseCam(dt);
  }

  function clientFinish(order, lapsMs) {
    game.state = 'finished';
    hideCountdown();
    audio.stopMusicTimer();
    // names by slot — the server's roster is deterministic (P1/P2/AI-N), no
    // wire change; `order` is the server's authoritative kart index order
    const my = mySlot();
    const nameOfIdx = idx => idx === my ? '<b>YOU</b>' : idx === 0 ? 'P1' : idx === 1 ? 'P2' : 'AI-' + (idx + 1);
    const rows = order.map((idx, i) => {
      const nm = nameOfIdx(idx);
      const lap = lapsMs && lapsMs[idx] ? ' ' + fmt(lapsMs[idx] / 1000) : '';
      return (i + 1) + '. ' + nm + lap;
    });
    const nameOf = idx => idx === my ? 'YOU' : idx === 0 ? 'P1' : idx === 1 ? 'P2' : 'AI-' + (idx + 1);
    resultsEl.innerHTML = podiumHtml(order, nameOf) + rows.join(' &nbsp;&nbsp; ');
    resultsEl.style.display = '';
    celebrate();   // confetti burst (resultsfx.js)
    const place = order.indexOf(my) + 1;
    const placeMsg =
      place === 1 ? 'YOU WRECKED THE TABLE!' :
      'YOU WERE ' + place + ' OF ' + order.length;
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
    wsMode, mySlot,
    hostReady: () => hostReady,
    netReady: () => !!(net && net.isWS && net.connected && hostReady),
    net: () => net,
    input: () => lastNetInput,
    inputNow: (t, s, d, u) => net && net.sendInput && net.sendInput(t, s, d, u),
    interpDelayMs: () => clientRing ? Math.max(0, clientRing.newestAt() - renderT) : 0,   // live buffer depth (the probe + HUD read this)
    lastLagMs: () => lastLagMs,
    resetClientItems: () => { clientItemSeen = ctx.racers().map(() => false); },
    applyClientState,
    beginHostSession, joinRoom, joinAuto, onPeerLost, refreshLobby,
  };
}
