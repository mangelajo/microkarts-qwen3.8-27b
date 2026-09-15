/* ------------------------------------------------------------------ *
 *  ws-check — full round-trip against the real game server:
 *    health, lobby, create room, join, hello handshake, peer-joined,
 *    track pick, start (grid echo), input → state frames (30 Hz),
 *    PING/PONG RTT, force-finish (WS_TEST), FINISH order, BYE/detach,
 *    host-left dissolve, room-full kick.
 *
 *  Run: make wscheck   (WS_TEST=1 node server/index.js + this client)
 * ------------------------------------------------------------------ */
import WebSocket from 'ws';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PORT = 8199;
const BASE = `http://127.0.0.1:${PORT}`;
const WS = `ws://127.0.0.1:${PORT}/ws`;
const root = fileURLToPath(new URL('..', import.meta.url));

let failures = 0;
const mark = (cond, msg) => {
  console.log(`   ${cond ? 'ok  ' : 'FAIL'} ${msg}`);
  if (!cond) failures++;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

// boot the server in test mode
const srv = spawn(process.execPath, ['--import', `file://${root}ai-sim/stub.js`, `${root}server/index.js`], {
  env: { ...process.env, PORT: String(PORT), WS_TEST: '1', WEB_ROOT: `${root}` },
  stdio: ['ignore', 'pipe', 'pipe'],
});
srv.stdout.on('data', d => { const s = String(d); if (s.includes('FAIL')) console.log(s); });
await new Promise((res) => {
  const to = setTimeout(res, 15000);
  srv.stdout.on('data', d => { if (String(d).includes('microkarts server on')) { clearTimeout(to); res(); } });
});

const http = (p) => fetch(`${BASE}${p}`).then(r => r.json());
const conn = () => new Promise((res, rej) => {
  const ws = new WebSocket(WS);
  ws._buf = [];   // buffer every frame — nextMsg may be registered after delivery
  ws._waitingFor = null;
  const tap = (data) => {
    const u = new Uint8Array(data);
    // a nextMsg 'h' handler is waiting for this type: it will resolve the
    // frame itself — don't buffer a second copy (double-bookkeeping made
    // the next nextMsg read the same frame twice)
    if (ws._waitingFor !== null && u[0] === ws._waitingFor) return;
    ws._buf.push(u);
  };
  ws.on('message', tap);
  ws.on('open', () => res(ws));
  ws.on('error', rej);
});
const drainMsg = (ws, type) => { for (let i = ws._buf.length - 1; i >= 0; i--) if (ws._buf[i][0] === type) ws._buf.splice(i, 1); };
const decName = f => new TextDecoder().decode(f.subarray(3, 3 + f[2]));
const nextMsg = (ws, type, timeout = 5000) => new Promise((res, rej) => {
  // already delivered? (splice it out so later reads don't get stale frames)
  for (let i = 0; i < ws._buf.length; i++) {
    if (ws._buf[i][0] === type) return res(ws._buf.splice(i, 1)[0]);
  }
  const to = setTimeout(() => { ws.off('message', h); ws._waitingFor = null; rej(new Error(`timeout waiting for 0x${type.toString(16)}`)); }, timeout);
  const h = (data) => {
    const d = new Uint8Array(data);
    if (d[0] !== type) return;
    clearTimeout(to); ws.off('message', h); ws._waitingFor = null; res(d);
  };
  ws._waitingFor = type;
  ws.on('message', h);
});
const connect = async (kind, name, code) => {
  const ws = await conn();
  const d = new Uint8Array(3 + name.length + (code ? 4 : 0));
  d[0] = 0x41;
  d[1] = kind.charCodeAt(0);
  d[2] = name.length;
  for (let i = 0; i < name.length; i++) d[3 + i] = name.charCodeAt(i);
  if (code) for (let i = 0; i < 4; i++) d[3 + name.length + i] = code.charCodeAt(i);
  ws.send(d.buffer);
  const h = await nextMsg(ws, 0x41);          // HELLO
  const ok = h[1];
  const hCode = ok ? String.fromCharCode(h[2], h[3], h[4], h[5]) : '';
  const nameLen = h[6] ?? 0;
  const hName = ok && nameLen ? new TextDecoder().decode(h.subarray(7, 7 + nameLen)) : '';
  const idx = ok && nameLen ? h[7 + nameLen] : -1;
  return { ws, ok, code: hCode, name: hName, idx };
};
const encInput = (t, s) => {
  const b = new Uint8Array(6);
  b[0] = 0x10; b[1] = Math.round(t * 127); b[2] = Math.round(s * 127);
  return b.buffer;
};
const encTrack = (idx, hz, it) => {
  const b = new Uint8Array(4); b[0] = 0x02; b[1] = idx; b[2] = hz ? 1 : 0; b[3] = it ? 1 : 0;
  return b.buffer;
};
const encStart = (karts, laps, grid) => {
  const b = new Uint8Array(9 + grid.length * 4);
  b[0] = 0x03; b[1] = karts; b[2] = laps; b[3] = karts;
  const v = new DataView(b.buffer);
  v.setFloat32(5, 1 / 60);
  for (let i = 0; i < grid.length; i++) v.setFloat32(9 + i * 4, grid[i]);
  return b.buffer;
};

console.log('== ws-check (real server, in-process) ==');
try {

// health + empty lobby
let h = await http('/health');
mark(h.ok === true && h.rooms === 0, 'health ok, 0 rooms');
let lobby = await http('/rooms');
mark(lobby.length === 0, 'lobby empty');

// create room (host) — real nicknames to verify the name exchange
const host = await connect('H', 'ALFA');
mark(host.ok === 1 && host.name === 'ALFA', `hello ok, code ${host.code}, name echoed ALFA`);
lobby = await http('/rooms');
mark(lobby.length === 1 && lobby[0].code === host.code && lobby[0].state === 'waiting', 'lobby shows the room (waiting)');

// join
const join = await connect('J', 'BRAVO', host.code);
mark(join.ok === 1 && join.idx === 1 && join.name === 'BRAVO', 'joiner hello, slot 1, name echoed BRAVO');
// the host also receives its OWN slot-0 name broadcast (it now gets one
// 0x82 per connected human, incl. itself) — read until the joiner's slot-1
let pj = null;
for (let i = 0; i < 3 && !pj; i++) {
  const f = await nextMsg(host.ws, 0x82);
  if (f[1] === 1) pj = f;
}
mark(pj !== null && decName(pj) === 'BRAVO', 'host got PEER_JOINED (slot 1, name BRAVO)');
// the joiner learns the host's name via a targeted PEER_JOINED (slot 0);
// its own slot-1 broadcast arrives first
let pjHost = null;
for (let i = 0; i < 2 && !pjHost; i++) {
  const f = await nextMsg(join.ws, 0x82);
  if (f[1] === 0) pjHost = f;
}
mark(pjHost !== null && decName(pjHost) === 'ALFA', 'joiner learned the host name (slot 0, ALFA)');

// track pick
host.ws.send(encTrack(2, 1, 0));
await sleep(200);
lobby = await http('/rooms');
mark(lobby[0].track === 2, 'lobby shows the track pick');
const tf = await nextMsg(join.ws, 0x02);
mark(tf[1] === 2 && tf[2] === 1 && tf[3] === 0, 'joiner got the forwarded TRACK frame (idx + flags)');

// start (grid for 4 karts)
const grid = [0.9925, -1.75, 0.9925, 1.75, 0.985, -1.75, 0.985, 1.75];
host.ws.send(encStart(4, 3, grid));
const prep = await nextMsg(host.ws, 0x05);
mark(new DataView(prep.buffer).getUint32(2) === 3000, 'PREP echo received (cdMs = 3000)');
const stEcho = await nextMsg(host.ws, 0x03);
mark(stEcho[1] === 4 && stEcho[2] === 3, 'START echo: 4 karts, 3 laps');

// state frames at 60 Hz (countdown, karts parked on the grid)
const s0 = await nextMsg(join.ws, 0x20);
const v0 = new DataView(s0.buffer);
mark(v0.getFloat32(7) < 0.01, 'state frame: kart0 x ≈ grid (countdown parked)');
mark(s0.length >= 7 + 4 * 29 + 2, 'state frame stride = 29 B/kart + trailing seq');
const s1b = await nextMsg(join.ws, 0x20);
const seq0 = new DataView(s0.buffer).getUint16(7 + 4 * 29);
const seq1 = new DataView(s1b.buffer).getUint16(7 + 4 * 29);
mark(seq1 !== seq0, 'state frames carry an incrementing tick seq (client gap detection)');

// input → the joiner's kart (slot 1) accelerates (the loop outlasts the 3.7 s
// countdown so the final frame is well into racing)
for (let i = 0; i < 60; i++) { join.ws.send(encInput(1, 0)); host.ws.send(encInput(1, 0)); await sleep(100); }
drainMsg(join.ws, 0x20);
const s1 = await nextMsg(join.ws, 0x20);
const v1 = new DataView(s1.buffer);
const sp1 = v1.getFloat32(7 + 29 + 16);   // kart1 (joiner) speed field
mark(sp1 > 1, `joiner kart speed ${sp1.toFixed(2)} after input (racing or late countdown)`);

// PING/PONG
const ping = new Uint8Array(5);
ping[0] = 0x70;
new DataView(ping.buffer).setUint32(1, 12345);
join.ws.send(ping.buffer);
const pong = await nextMsg(join.ws, 0x71);
mark(new DataView(pong.buffer).getUint32(1) === 12345, 'PING/PONG echo');

// force finish (WS_TEST) → FINISH frame with an order
const t0 = Date.now();
await fetch(`${BASE}/ws-test-finish`);
const fin = await nextMsg(host.ws, 0x30, 30000);
const n = fin[1];
mark(n === 4, `FINISH: 4 karts ordered after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
mark(fin[2] >= 0 && fin[2] < 4, 'FINISH order[0] valid');

// detach: joiner closes → host gets PEER_LEFT
join.ws.close();
const pl = await nextMsg(host.ws, 0x81);
mark(pl[1] === 1, 'host got PEER_LEFT (slot 1)');

// the finished room lingers while the host stays (to re-race) — players 1
lobby = await http('/rooms');
const linger = lobby.find(r => r.code === host.code);
mark(!!linger && linger.players === 1, 'finished room lingers while the host stays (players 1)');
// the host also leaves → the empty room is dissolved + pruned from the lobby
host.ws.close();
await sleep(400);
lobby = await http('/rooms');
mark(!lobby.some(r => r.code === host.code), 'empty room pruned when the last player leaves');

// host leaves → joiner... (joiner is gone) — new pair for the dissolve test
const h2 = await connect('H', 'HOST2');
const j2 = await connect('J', 'JOIN2', h2.code);
mark(j2.ok === 1, 'second room paired');
h2.ws.close();
const kick = await nextMsg(j2.ws, 0x83);
mark(kick[1] > 0, 'joiner KICKED when host leaves (waiting room dissolves)');

// 4-player room: 4 humans fill slots 0..3; the host learns each name; the
// last joiner learns the host's name; /rooms shows players = 4
const h4 = await connect('H', 'H-4P');
const j4a = await connect('J', 'J4-A', h4.code);
const j4b = await connect('J', 'J4-B', h4.code);
const j4c = await connect('J', 'J4-C', h4.code);
mark(j4a.ok === 1 && j4b.ok === 1 && j4c.ok === 1, 'three joiners all connected (room holds 4)');
mark(j4a.idx === 1 && j4b.idx === 2 && j4c.idx === 3, 'joiners got slots 1, 2, 3');
lobby = await http('/rooms');
const l4 = lobby.find(r => r.code === h4.code);
mark(!!l4 && l4.players === 4, '/rooms shows players = 4 (host + 3 joiners)');
// the host learns each joiner's name (a PEER_JOINED per slot — it also
// gets its own slot-0 broadcast, which we skip here)
const names = {};
const deadline = Date.now() + 5000;
while (Object.keys(names).length < 3 && Date.now() < deadline) {
  const f = await nextMsg(h4.ws, 0x82, 2500).catch(() => null);
  if (!f) break;
  if (f[1] >= 1 && f[1] <= 3 && !(f[1] in names)) names[f[1]] = decName(f);
}
mark(names[1] === 'J4-A' && names[2] === 'J4-B' && names[3] === 'J4-C', 'host learned all three joiner names');
// the 3rd joiner (slot 3) learns the host's name via a targeted PEER_JOINED (slot 0)
let pj4host = null;
for (let i = 0; i < 4 && !pj4host; i++) {
  const f = await nextMsg(j4c.ws, 0x82);
  if (f[1] === 0) pj4host = f;
}
mark(pj4host !== null && decName(pj4host) === 'H-4P', 'slot-3 joiner learned the host name');
// a 4-kart state frame reaches the last joiner (stride 29 B/kart, 4 karts)
h4.ws.send(encTrack(0, 0, 0));
await sleep(150);
h4.ws.send(encStart(4, 3, grid));
const s4 = await nextMsg(j4c.ws, 0x20);
mark(s4.length >= 7 + 4 * 29 + 2, 'slot-3 joiner got a 4-kart state frame (stride 29)');
// clean up the 4P room
j4c.ws.close(); j4b.ws.close(); j4a.ws.close(); h4.ws.close();
await sleep(300);
lobby = await http('/rooms');
mark(!lobby.some(r => r.code === h4.code), '4P room pruned when everyone leaves');

// room full: the cap is 4 humans (the host + three joiners); a fourth
// joiner is rejected
const h3 = await connect('H', 'HOST3');
const j3a = await connect('J', 'J3A', h3.code);
const j3b = await connect('J', 'J3B', h3.code);
const j3c = await connect('J', 'J3C', h3.code);
const j3d = await connect('J', 'J3D', h3.code);
mark(j3a.ok === 1 && j3b.ok === 1 && j3c.ok === 1, 'three joiners fit (host + 3 = 4, slots 0..3)');
mark(j3d.ok === 0, 'fourth joiner KICKED (room full)');
// clean up
j3c.ws.close(); j3b.ws.close(); j3a.ws.close(); h3.ws.close();

} finally {
  srv.kill();
}
console.log(failures === 0 ? '\n== WS-CHECK PASS ==\n' : `\n== WS-CHECK FAIL (${failures}) ==\n`);
process.exit(failures === 0 ? 0 : 1);
