/* ------------------------------------------------------------------ *
 *  Relay-check: the full client↔relay round-trip (ai-sim).
 *
 *  Runs the same scenario against whichever backend is available:
 *    1. the REAL PHP relay on 127.0.0.1:8123 (podman `mkphp`), when
 *       it answers — proves the shipped contract, end to end.
 *    2. an in-process mock of the same contract — so the gate passes
 *       where PHP is absent (CI). The mock is binary-safe (chunk
 *       collection, base64 both ways) and mirrors relay.php's rules.
 *
 *  Scenario: room code format → host registers + heartbeats → joiner
 *  joins (hello handshake, even though the host's race frames were
 *  sent before the joiner's first poll — the queue is a backlog) →
 *  state / input / track frames round-trip intact → the lobby lists
 *  the room → the global rank board round-trips → clean close.
 *  Exit 0 = all pass.
 * ------------------------------------------------------------------ */
import { createServer } from 'node:http';
import { genRoomCode, RelaySession } from '../src/relaynet.js';
import { makeStateEncoder } from '../src/net.js';

let failures = 0;
function mark(ok, why) { if (!ok) { failures++; console.log('  !! FAIL:', why); } }

async function probePhp() {
  try {
    const r = await fetch('http://127.0.0.1:8123/api/rooms.php', { signal: AbortSignal.timeout(1500) });
    return (await r.json());
  } catch { return null; }
}

/* The PHP contract, in-process (binary-safe). */
async function startMock() {
  const rooms = {}, queues = {};
  const s = createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const body = () => new Promise(r => { const cs = [];
      req.on('data', c => cs.push(c));
      req.on('end', () => r(Buffer.concat(cs))); });
    if (u.pathname === '/api/rooms.php') {
      if (req.method === 'POST') {
        body().then(b => {
          const j = JSON.parse(b.toString());
          if (j && j.code) rooms[j.code] = { name: j.name, track: j.track,
            ts: Date.now() / 1000 | 0 };
          res.end('{"ok":true}');
        });
      } else {
        const fresh = Object.entries(rooms)
          .filter(([, e]) => Date.now() / 1000 - e.ts < 20)
          .map(([code, e]) => ({ code, ...e }));
        res.end(JSON.stringify({ rooms: fresh }));
      }
    } else if (u.pathname === '/api/relay.php') {
      const room = (u.searchParams.get('room') || '').toUpperCase();
      if (!/^[A-Z2-9]{4,8}$/.test(room)) { res.end('{"error":"bad room"}'); return; }
      if (req.method === 'POST') {
        const who = u.searchParams.get('who');
        body().then(b => {
          if (who !== 'HOST' && who !== 'P2') { res.end('{"error":"bad who"}'); return; }
          const q = queues[room] = queues[room] || [];
          const seq = q.length + 1;
          q.push({ seq, from: who, data: b.toString('base64'), ts: Date.now() / 1000 | 0 });
          res.end('{"ok":true,"seq":' + seq + '}');
        });
      } else {
        const after = parseInt(u.searchParams.get('after') || '0', 10);
        const t0 = Date.now();
        const check = () => {
          const out = (queues[room] || []).filter(m => m.seq > after);
          if (out.length) { res.end(JSON.stringify({ msgs: out })); return; }
          if (Date.now() - t0 > 2000) { res.end('{"msgs":[]}'); return; }
          setTimeout(check, 50);
        };
        check();
      }
    } else if (u.pathname === '/api/rank.php') {
      if (req.method === 'POST') {
        body().then(b => {
          const j = JSON.parse(b.toString());
          const board = (rankStore[+u.searchParams.get('track') || 0] ||= []);
          board.push({ name: j.name, ms: +j.ms, d: 'x' });
          board.sort((a, b2) => a.ms - b2.ms);
          res.end('{"ok":true}');
        });
      } else {
        res.end(JSON.stringify({ top: (rankStore[+u.searchParams.get('track') || 0] || []).slice(0, 5) }));
      }
    } else { res.statusCode = 404; res.end('{"error":"404"}'); }
  });
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  return { api: 'http://127.0.0.1:' + s.address().port, close: () => s.close() };
}
const rankStore = {};

const php = await probePhp();
let mock = null;
const api = php ? 'http://127.0.0.1:8123' : (mock = await startMock()).api;
console.log('-- relay backend:', php ? 'real PHP (podman:8123)' : 'in-process mock');

/* 1 — room code: 4 chars from the 31-symbol alphabet */
const rng = (() => { let s = 7; return () => (s = (s * 16807) % 2147483647) / 2147483647; })();
mark(/^[A-Z2-9]{4}$/.test(genRoomCode(rng)), 'room code format');

/* 2 — host registers, joiner joins, the queue backfills late arrivals */
let hostOpen = false, joinOpen = false, lastIn = null, lastSt = null, lastTr = null;
const host = new RelaySession('host', {
  onOpen: () => { hostOpen = true; },
  onInput: i => { lastIn = i; },
}, api);
await host.hostStart('RELAY', 1);
await new Promise(r => setTimeout(r, 300));
const join = new RelaySession('join', {
  onOpen: () => { joinOpen = true; },
  onState: st => { lastSt = st; },
  onTrack: idx => { lastTr = idx; },
}, api);
await join.joinOffer(host.code);
const t0 = Date.now();
while (!hostOpen || !joinOpen) { if (Date.now() - t0 > 15000) break; await new Promise(r => setTimeout(r, 50)); }
mark(hostOpen && joinOpen, 'relay connection (hello handshake)');

/* start+state BEFORE the joiner's first poll lands — the queue must
 * backfill (this is the PHP long-poll property the mock mirrors) */
const karts = [0, 1, 2, 3].map(i => ({ pos: { x: i, y: 0, z: i * 2 }, heading: 0, speed: 3 + i,
  steerVel: 0, offRoad: false, lapDone: 0, posIdx: i, raceDone: false, item: 0 }));
host.sendStart({ karts: 4, laps: 3, rosterN: 4, steerFlip: false, simDt: 1 / 60,
  grid: [1, 0, 2, 1, 3, 2, 4, 3] });
host.sendState(makeStateEncoder(4)(1234, 7, karts));
const t1 = Date.now();
while (!lastSt) { if (Date.now() - t1 > 15000) break; await new Promise(r => setTimeout(r, 50)); }
mark(!!lastSt && lastSt.hostMs === 1234 && lastSt.karts.length === 4, 'state frame via relay (backfilled)');
mark(lastSt && Math.abs(lastSt.karts[2].speed - 5) < 1e-3, 'state frame payload intact');

/* input: joiner → host */
join.sendInput(0.5, -0.2, true, false);
const t2 = Date.now();
while (!lastIn) { if (Date.now() - t2 > 15000) break; await new Promise(r => setTimeout(r, 50)); }
mark(!!lastIn && Math.abs(lastIn.throttle - 0.5) < 0.01, 'input frame via relay');

/* track change host → joiner */
host.sendTrack(3, 1, 0);
const t3 = Date.now();
while (lastTr === null) { if (Date.now() - t3 > 15000) break; await new Promise(r => setTimeout(r, 50)); }
mark(lastTr === 3, 'track frame via relay');

/* prep + finish travel too (bye rides inside close()) */
host.sendPrep(3, 3000);
host.sendFinish([0, 1, 2, 3], 0);

/* lobby lists the host room */
await new Promise(r => setTimeout(r, 300));
const rj = await (await fetch(api + '/api/rooms.php')).json();
mark(rj.rooms.some(x => x.code === host.code && x.name === 'RELAY'), 'lobby lists the host room');

/* Rank round-trip check (unique name: the server rate-limits per name+track) */
const rankName = 'TEST' + (Math.random() * 9999 | 0);
const rankMs = 987 + (Math.random() * 10 | 0);   // faster than any stale entry → guaranteed top-5
await fetch(api + '/api/rank.php', { method: 'POST', headers: { 'Content-Type': 'text/plain' },
  body: JSON.stringify({ name: rankName, ms: rankMs, track: 1 }) });
const rk = await (await fetch(api + '/api/rank.php?track=1')).json();
mark((rk.top || []).some(x => x.name === rankName && x.ms === rankMs), 'global rank round-trip');

host.close(); join.close();
await new Promise(r => setTimeout(r, 200));
mark(!host.active && !join.active, 'relay sessions close cleanly');
if (mock) mock.close();

if (failures) { console.log('== RELAY-CHECK FAIL (' + failures + ') =='); process.exit(1); }
console.log('== RELAY-CHECK PASS ==');
process.exit(0);
