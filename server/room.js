/* ------------------------------------------------------------------ *
 *  server/room.js — ONE authoritative race room. The server is the
 *  source of truth: it owns the sim clock, every kart, the item boxes,
 *  pads, obstacles and the AI. Both clients are pure renderers that
 *  stream input — the host only has UI rights (track pick + START).
 *
 *  Reuses the SAME pure sim modules the headless gates run
 *  (make sim): selectTrack + Kart + simulateTick + aiControl.
 *
 *  Wire (binary, type byte first — values from src/net.js where a
 *  client encoder/decoder already exists):
 *    client → server
 *      0x41 CONNECT  u8 kind ('H'=72 host / 'J'=74 joiner), u8 nameLen,
 *                   name, [u8 4 code]
 *      0x02 TRACK    encTrack(idx, hazards, items)
 *      0x03 START    encStart({karts, laps, rosterN, steerFlip, simDt, grid})
 *      0x10 INPUT    encInput(t, s, ping, drift, use)
 *      0x70 PING     u32 clientTs
 *      0x60 BYE
 *    server → client
 *      0x41 HELLO     u8 ok, u8 4 code, u8 nameLen, name, u8 myIdx
 *      0x82 PEER_JOINED u8 idx, u8 nameLen, name
 *      0x81 PEER_LEFT  u8 idx
 *      0x05 PREP      encPrep(trackIdx, cdMs)  — sent with the START echo
 *      0x03 START     encStart — every client (incl. the host) syncs grid
 *      0x20 STATE     makeStateEncoder frames, 30 Hz
 *      0x30 FINISH    encFinish(order, lapsMs)
 *      0x71 PONG     u32 clientTs echo
 *      0x83 KICK     u8 len, reason
 * ------------------------------------------------------------------ */
import { selectTrack } from '../src/track.js';
import { Kart } from '../src/kart.js';
import { aiControl } from '../src/ai.js';
import { simulateTick } from '../src/race.js';
import { setObstaclesOn, buildObstacles } from '../src/obstacles.js';
import { setItemsOn } from '../src/items.js';
import { decInput, decStart, encPrep, encStart, encFinish, makeStateEncoder } from '../src/net.js';

const SIM_DT = 1 / 60;
const CD_MS = 3000;
const dec = new TextDecoder();

const str = (d, off, n) => n ? dec.decode(d.subarray(off, off + n)) : '';

export function createRoom(code, ownerName) {
  const room = {
    code,
    owner: ownerName,
    trackIdx: 0,
    hazards: false,
    items: false,
    state: 'waiting',          // waiting → countdown → racing → finished
    karts: [],
    humans: new Map(),         // ws -> { slot, name }
    input: new Map(),          // ws -> decInput + { at }
    t: 0,
    tick: 0,
    goAt: CD_MS + 700,        // sim-ms of GO (mirrors the clients' wall clock)
    raceDoneAt: [],
    enc: null,
    timer: null,
    closed: false,
  };

  // a fresh grid (also the re-race path: the host presses START again)
  room.resetRoster = (info) => {
    room.karts = Array.from({ length: info.karts }, (_, i) => {
      const k = new Kart({ skill: 0.85 });
      // deterministic names the client mirrors (clientFinish names by slot —
      // no new wire fields)
      k.name = i === 0 ? 'P1' : i === 1 ? 'P2' : 'AI-' + (i + 1);
      k.placeAt(info.grid[i * 2], info.grid[i * 2 + 1]);
      k.laps = info.laps;
      return k;
    });
    room.t = 0;
    room.tick = 0;
    room.raceDoneAt = Array.from({ length: info.karts }, () => 0);
    room.enc = makeStateEncoder(info.karts);
  };

  room.beginCountdown = (info) => {
    room.resetRoster(info);
    room.state = 'countdown';
  };

  const inputFor = (k, racing) => {
    const idx = room.karts.indexOf(k);
    for (const [ws, h] of room.humans) {
      if (h.slot !== idx) continue;
      if (!racing) return { throttle: 0, steer: 0 };
      // a PRESENT human (ws still in the map) always owns the kart: a stale
      // frame just means "keys released" (0,0) — AI takeover is for the
      // DETACHED (dropped) human, which falls through to the final return
      const inp = room.input.get(ws);
      if (inp) return { throttle: inp.throttle, steer: inp.steer, drift: inp.drift, use: inp.use };
      return { throttle: 0, steer: 0 };
    }
    return racing ? aiControl(k, room.karts) : { throttle: 0, steer: 0 };
  };

  room.step = () => {
    if (room.closed || room.state === 'waiting') return;
    room.t += SIM_DT * 1000;
    room.tick++;
    if (room.state === 'countdown' && room.t >= room.goAt) room.state = 'racing';
    const racing = room.state === 'racing';
    simulateTick(room.karts, inputFor, SIM_DT, room.t, { racing });
    if (racing) {
      for (let i = 0; i < room.karts.length; i++)
        if (room.karts[i].raceDone && !room.raceDoneAt[i]) room.raceDoneAt[i] = room.t;
      if (room.state === 'racing' && room.karts.every(k => k.raceDone)) {
        room.state = 'finished';
        const order = room.karts.map((_, i) => i)
          .sort((a, b) => room.raceDoneAt[a] - room.raceDoneAt[b]);
        room.announce(new Uint8Array(encFinish(order, room.raceDoneAt)).buffer);
      }
    }
    if ((room.tick & 1) === 0) {           // 30 Hz on the wire
      const buf = room.enc(room.t, 0, room.karts);
      room.announce(buf);
    }
  };

  room.startLoop = () => {
    if (room.timer) return;
    room.timer = setInterval(room.step, 1000 / 60);
  };

  room.announce = (data) => {
    for (const ws of room.humans.keys())
      if (ws.readyState === 1) ws.send(data);
  };

  room.kick = (ws, reason) => {
    const d = new Uint8Array(3 + reason.length);
    d[0] = 0x83; d[1] = reason.length;
    for (let i = 0; i < reason.length; i++) d[2 + i] = reason.charCodeAt(i);
    if (ws.readyState === 1) ws.send(d.buffer);
  };

  // CONNECT: u8 kind, u8 nameLen, name, [4B code]
  room.attach = (ws, d, kind) => {
    const nameLen = d[2];
    const name = str(d, 3, nameLen);
    const off = 3 + nameLen;
    const code = kind === 'J' ? str(d, off, 4) : room.code;
    if (kind === 'H') {
      room.owner = name;
      room.humans.set(ws, { slot: 0, name });
    } else {
      if ([...room.humans.values()].some(v => v.slot === 1)) {
        const hd = new Uint8Array(2);
        hd[0] = 0x41; hd[1] = 0;   // HELLO ok=0
        if (ws.readyState === 1) ws.send(hd.buffer);
        room.kick(ws, 'ROOM FULL');
        return false;
      }
      room.humans.set(ws, { slot: 1, name });
      room.announceJoin(1, name);
    }
    // HELLO: ok, code(4), nameLen, name, myIdx
    const slot = room.humans.get(ws).slot;
    const hd = new Uint8Array(2 + 4 + 1 + name.length + 1);
    hd[0] = 0x41; hd[1] = 1;
    for (let i = 0; i < 4; i++) hd[2 + i] = code.charCodeAt(i);
    let o = 6; hd[o] = name.length; o += 1;
    for (let i = 0; i < name.length; i++) hd[o + i] = name.charCodeAt(i);
    hd[o + name.length] = slot;
    ws.send(hd.buffer);
    return true;
  };

  room.announceJoin = (slot, name) => {
    const d = new Uint8Array(3 + 1 + name.length);
    d[0] = 0x82; d[1] = slot; d[2] = name.length;
    for (let i = 0; i < name.length; i++) d[3 + i] = name.charCodeAt(i);
    for (const ws of room.humans.keys())
      if (ws.readyState === 1) ws.send(d.buffer);
  };

  room.detach = (ws) => {
    const h = room.humans.get(ws);
    if (!h) return;
    room.input.delete(ws);
    room.humans.delete(ws);
    const d = new Uint8Array([0x81, h.slot]);
    room.announce(d);
    if (h.slot === 0 && room.state === 'waiting') room.dissolve();  // host left pre-race
  };

  room.dissolve = () => {
    room.closed = true;
    if (room.timer) clearInterval(room.timer);
    for (const ws of room.humans.keys()) {
      if (ws.readyState === 1) { room.kick(ws, 'HOST LEFT'); ws.close(); }
    }
    room.humans.clear();
  };

  // a full client frame (ws is bound by index.js)
  room.handleFrame = (ws, d) => {
    const type = d[0];
    if (type === 0x02) {                    // encTrack: idx, hazards, items (all u8)
      room.trackIdx = d[1];
      room.hazards = !!d[2];
      room.items = !!d[3];
      setObstaclesOn(room.hazards); buildObstacles(room.trackIdx);
      setItemsOn(room.items);
      selectTrack(room.trackIdx);           // rebuild the field (pure data)
      
      // forward the live picker to the other client (the joiner mirrors the
      // host's chips — the frame is re-sent as-is, no new wire fields)
      const d2 = new Uint8Array(d);
      for (const [ws2] of room.humans)
        if (ws2 !== ws && ws2.readyState === 1) ws2.send(d2.buffer);
    } else if (type === 0x03) {
      if (!room.humans.has(ws)) return;
      const info = decStart(d);
      room.beginCountdown(info);
      room.announce(new Uint8Array(encPrep(room.trackIdx, CD_MS)).buffer);
      room.announce(new Uint8Array(encStart(info)).buffer);
    } else if (type === 0x10) {
      if (!room.humans.has(ws)) return;
      const p = decInput(d);
      room.input.set(ws, { ...p, at: performance.now() });
    } else if (type === 0x70) {
      const ts = new DataView(d.buffer, d.byteOffset).getUint32(1);
      const pong = new Uint8Array(5);
      pong[0] = 0x71;
      new DataView(pong.buffer).setUint32(1, ts);
      if (ws.readyState === 1) ws.send(pong.buffer);
    }
    // 0x60 BYE: handled by the ws close event
  };

  return room;
}
