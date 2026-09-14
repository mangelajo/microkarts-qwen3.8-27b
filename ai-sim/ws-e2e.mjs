/* ------------------------------------------------------------------ *
 *  ws-e2e — two real browser pages race over the local Node server
 *  (the full Plan B loop: WSSession → server sim → mirror render).
 *
 *  Boots: (1) the real server (node --import stub, PORT from
 *  WS_E2E_PORT or 8317), (2) a no-cache static server for the game
 *  (port 8318), then drives two headless Chromium pages:
 *
 *    host page  → 2P tab → HOST 2P → read the room code → START RACE
 *    join page  → 2P tab → JOIN 2P → type the code → JOIN ROOM
 *
 *  and asserts: both reach state 'racing' (wall-clock countdown — the
 *  sim lives on the server, so headless's ~13 fps rAF no longer slows
 *  the race), the joiner's mirrored kart accelerates (> 1 u/s), and
 *  neither page throws a JS error. SKIPs (exit 0) if Playwright or the
 *  chromium binary is unavailable.
 *
 *  Usage:  node ai-sim/ws-e2e.mjs   (or: make wse2e)
 * ------------------------------------------------------------------ */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WSPORT = Number(process.env.WS_E2E_PORT) || 8317;
const HTTP_PORT = WSPORT + 1;

let failures = 0;
const mark = (ok, msg) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${msg}`); if (!ok) failures++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

console.log(`== ws-e2e (two browsers over the local server :${WSPORT}) ==`);

// ---- the real server (stubbed scene modules, like make sim) ----
const srv = spawn(process.execPath, ['--import', `file://${ROOT}ai-sim/stub.js`, `${ROOT}server/index.js`], {
  env: { ...process.env, PORT: String(WSPORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
srv.stderr.on('data', d => { const s = String(d).trim(); if (s && !s.includes('Deprecation') && !s.includes('trace-deprecation')) console.log('SRV:', s.slice(0, 300)); });
const srvReady = new Promise((res, rej) => {
  const to = setTimeout(() => rej(new Error('server boot timeout')), 20000);
  srv.stdout.on('data', d => { if (String(d).includes('microkarts server on')) { clearTimeout(to); res(); } });
});
await srvReady;
console.log('   ok   server up');

// ---- no-cache static server ----
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript',
  '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png',
};
const staticSrv = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p0 = normalize(join(ROOT, decodeURIComponent(url.pathname)));
  const p = (p0 === ROOT || p0.endsWith('/')) ? join(p0, 'index.html') : p0;
  if (!p.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  try {
    const data = await readFile(p);
    res.writeHead(200, { 'Content-Type': MIME[extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('not found');
  }
});
await new Promise(r => staticSrv.listen(HTTP_PORT, '127.0.0.1', r));

// ---- playwright (SKIP if unavailable) ----
let chromium;
try { ({ chromium } = await import('playwright')); } catch {
  console.log('   SKIP  playwright not installed — run `npx playwright install chromium`');
  staticSrv.close(); srv.kill();
  process.exit(0);
}
const browser = await chromium.launch({ args: ['--no-sandbox'] });

const pageErrors = { host: [], join: [] };
const mkPage = async (name) => {
  const page = await browser.newPage();
  page.on('pageerror', e => pageErrors[name].push(String(e)));
  await page.goto(`http://127.0.0.1:${HTTP_PORT}/?ws=ws://127.0.0.1:${WSPORT}/ws`);
  await page.waitForTimeout(1500);   // boot (three.js + menu)
  return page;
};

let host, joinp;
try {
  host = await mkPage('host');
  joinp = await mkPage('join');
  mark(pageErrors.host.length === 0, 'host page boots without JS errors');
  mark(pageErrors.join.length === 0, 'join page boots without JS errors');

  // host: 2P tab → HOST 2P → wait for the room code
  await host.click('[data-tab="multi"]');
  await host.click('[data-mode="host"]');
  const code = await (await host.waitForFunction(() => {
    const c = document.getElementById('hostCode');
    return c && c.textContent && c.textContent !== '—' ? c.textContent : null;
  }, null, { timeout: 15000 })).jsonValue();
  mark(true, 'host connected, room code ' + code);

  // joiner: 2P tab → JOIN 2P → type the code → JOIN ROOM
  await joinp.click('[data-tab="multi"]');
  await joinp.click('[data-mode="join"]');
  await joinp.click('#joinInField');
  await joinp.keyboard.type(code);
  await joinp.click('#joinBtn');
  await joinp.waitForFunction(() => {
    const c = document.getElementById('joinConnected');
    return c && !c.classList.contains('hidden');
  }, null, { timeout: 15000 });
  mark(true, 'joiner connected (CONNECTED banner)');

  // host: START RACE (the server runs the 3.7 s countdown + the race)
  await host.click('#startBtn');
  const bothRacing = await Promise.all([
    host.waitForFunction(() => window.__mkr && window.__mkr.game.state === 'racing', null, { timeout: 20000 }),
    joinp.waitForFunction(() => window.__mkr && window.__mkr.game.state === 'racing', null, { timeout: 20000 }),
  ]);
  mark(!!bothRacing, 'both pages reached state=racing (server countdown)');

  // drive both karts: a connected human with no input owns the kart at rest
  // (the server's AI only takes over a DROPPED human), so the gate sends
  // real throttle — this exercises the full input → server → mirror loop.
  await host.keyboard.down('w');
  await joinp.keyboard.down('w');
  await sleep(6000);
  const joinSp = await joinp.evaluate(() => window.__mkr.n2.selfKart().speed);
  mark(joinSp > 1, `joiner mirrored kart speed ${joinSp.toFixed(2)} (server-driven)`);
  const hostSp = await host.evaluate(() => window.__mkr.n2.selfKart().speed);
  mark(hostSp > 1, `host mirrored kart speed ${hostSp.toFixed(2)} (server-driven)`);
  await host.keyboard.up('w');
  await joinp.keyboard.up('w');
} catch (e) {
  mark(false, 'e2e flow: ' + String(e).slice(0, 160));
}

mark(pageErrors.host.length === 0, 'no host JS errors at the end');
mark(pageErrors.join.length === 0, 'no joiner JS errors at the end');

await browser.close();
staticSrv.close();
srv.kill();
console.log(failures === 0 ? '\n== WS-E2E PASS ==\n' : `\n== WS-E2E FAIL (${failures}) ==\n`);
process.exit(failures === 0 ? 0 : 1);
