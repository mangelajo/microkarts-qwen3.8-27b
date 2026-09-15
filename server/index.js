/* ------------------------------------------------------------------ *
 *  server/index.js — ONE container, ONE port:
 *    • static files (the game itself: index.html + src/)
 *    • /ws    — WebSocket game server (per-room authoritative sim)
 *    • /rooms — the lobby (GET)
 *    • /health
 *
 *  The clients need no configuration: same origin, /ws path.
 *  `WS_TEST=1` exposes the test-only hooks (force finish) the gate uses.
 * ------------------------------------------------------------------ */
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { createRoom } from './room.js';
import { samples } from '../src/track.js';

const PORT = process.env.PORT || 8080;
const ROOT = process.env.WEB_ROOT || fileURLToPath(new URL('..', import.meta.url));
const WS_TEST = process.env.WS_TEST === '1';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain',
};

const rooms = new Map();   // code -> room

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   // no I/O/0/1 (matches the QR code)
const genCode = (rng = Math.random) =>
  Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(rng() * CODE_CHARS.length)]).join('');

const json = (res, code, obj) => {
  const b = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  });
  res.end(b);
};

// test hook (WS_TEST only): park every kart just past the line (the lap
// logic needs prevU > 0.85 → u < 0.15 with hasMid) so the next tick ends the race
const forceFinish = room => {
  if (!WS_TEST) return;
  const n = samples.length;
  const i1 = Math.floor(0.05 * n) % n;
  for (const k of room.karts) {
    k.hasMid = true;
    k.prevU = 0.9;
    k.lapDone = (k.laps || 3) - 1;
    k.pos.copy(samples[i1]);
    k.speed = 5;
  }
};

const httpSrv = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  try {
    if (u.pathname === '/health') return json(res, 200, { ok: true, rooms: rooms.size, test: WS_TEST, commit: process.env.GIT_SHA || 'dev' });
    if (u.pathname === '/rooms') {
      return json(res, 200, [...rooms.values()].filter(r => !r.closed).map(r => ({
        code: r.code,
        host: r.owner,
        track: r.trackIdx,
        state: r.state,
        players: r.humans.size,   // host included — the host screen shows 1/2 → 2/2
      })));
    }
    if (u.pathname === '/ws-test-finish') {
      if (!WS_TEST) return json(res, 404, { err: 'not in test mode' });
      for (const r of rooms.values()) forceFinish(r);
      return json(res, 200, { ok: true });
    }
    // static files
    let p = u.pathname === '/' ? '/index.html' : u.pathname;
    const file = join(ROOT, normalize(p).replace(/^([.][.][/])*/, ''));
    if (!file.startsWith(ROOT)) return json(res, 403, { err: 'forbidden' });
    const st = await stat(file).catch(() => null);
    if (!st || !st.isFile()) return json(res, 404, { err: 'not found' });
    const buf = await readFile(file);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',   // never cache — a stale client build silently runs old code after a deploy
    });
    res.end(buf);
  } catch (e) {
    json(res, 500, { err: String(e.message || e) });
  }
});

const wss = new WebSocketServer({ server: httpSrv, path: '/ws' });

const dec = new TextDecoder();

wss.on('connection', ws => {
  ws._room = null;
  ws.on('message', (data) => {
    const d = new Uint8Array(data);
    if (d[0] === 0x41 && !ws._room) {
      // CONNECT: kind, nameLen, name, [code]
      const kind = String.fromCharCode(d[1]);
      const nameLen = d[2];
      let off = 3;
      const name = dec.decode(d.subarray(off, off + nameLen));
      off += nameLen;
      const code = kind === 'J' ? dec.decode(d.subarray(off, off + 4)) : genCode();
      if (kind === 'J') {
        const room = rooms.get(code);
        if (!room || room.closed) {
          const hd = new Uint8Array(2 + 1);
          hd[0] = 0x41; hd[1] = 0;   // ok = 0
          ws.send(hd.buffer);
          return;
        }
        ws._room = room;
        room.attach(ws, d, 'J');
        return;
      }
      const room = createRoom(code, name);
      rooms.set(code, room);
      room.startLoop();
      ws._room = room;
      room.attach(ws, d, 'H');
      return;
    }
    if (ws._room && !ws._room.closed) ws._room.handleFrame(ws, d);
  });
  ws.on('close', () => {
    if (ws._room && !ws._room.closed) ws._room.detach(ws);
    if (ws._room && ws._room.closed) rooms.delete(ws._room.code);   // prune dissolved
  });
});

httpSrv.listen(PORT, () => {
  console.log(`microkarts server on :${PORT} (root ${ROOT}, test=${WS_TEST})`);
  console.log(`  game:                  http://localhost:${PORT}/`);
  console.log(`  multiplayer:           ws://localhost:${PORT}/ws (same origin — no config needed)`);
  console.log(`  ai-sim playground:    http://localhost:${PORT}/ai-sim/playground.html`);
  console.log(`  lobby / health:       http://localhost:${PORT}/rooms  http://localhost:${PORT}/health`);
});

export { rooms, genCode };
