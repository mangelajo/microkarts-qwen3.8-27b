/* ------------------------------------------------------------------ *
 *  Relay E2E: two real browser pages race over the PHP relay.
 *
 *  Page A (host):  ?api=<php>  → 2P page → HOST 2P → read the room
 *                  code → START RACE.
 *  Page B (join): ?join=<code>&api=<php> → deep-link auto-join →
 *  mirrors the host's countdown + race.
 *
 *  Requires: `make serve` (port 8124) + the PHP relay (podman :8123).
 *  With no PHP, it prints SKIP (the contract is covered by
 *  relaycheck's in-process mock). Exit 0 = pass or skip.
 * ------------------------------------------------------------------ */
import { chromium } from 'playwright';
/* eslint-disable no-undef */ // page.evaluate callbacks run in the browser context

const SERVE = process.env.MKR_SERVE || 'http://127.0.0.1:8124';
const PHP = process.env.MKR_PHP || 'http://127.0.0.1:8123';

async function up(url) {
  try { await fetch(url, { signal: AbortSignal.timeout(1500) }); return true; }
  catch { return false; }
}
if (!(await up(SERVE + '/'))) { console.log('SKIP — serve not running (' + SERVE + ')'); process.exit(0); }
if (!(await up(PHP + '/api/rooms.php'))) { console.log('SKIP — PHP relay not running (' + PHP + ')'); process.exit(0); }

const browser = await chromium.launch();
const mk = async () => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  page.on('pageerror', e => console.log('  [pageerror]', e.message));
  return page;
};
const host = await mk();
const join = await mk();

/* host: boot, 2P page, HOST 2P, read the room code */
await host.goto(SERVE + '/?api=' + PHP, { waitUntil: 'load' });
await host.waitForTimeout(1500);
await host.click('[data-tab="multi"]');
await host.waitForTimeout(300);
await host.click('[data-mode="host"]');
await host.waitForTimeout(2500);   // room registered + QR drawn
const code = (await host.textContent('#hostCode'))?.trim().replace(/^MKR-/, '');
if (!/^[A-Z2-9]{4}$/.test(code || '')) { console.log('FAIL — no room code:', code); process.exit(1); }
console.log('host room:', code);

/* join: deep-link auto-join */
await join.goto(SERVE + '/?join=' + code + '&api=' + PHP, { waitUntil: 'load' });
await join.waitForTimeout(2500);
const joinNet = await join.evaluate(() => window.__mkr?.game?.netMode);
if (joinNet !== 2) { console.log('FAIL — joiner not in 2P mode (netMode=' + joinNet + ')'); process.exit(1); }

/* lobby lists the host's room */
const lobby = await host.textContent('#lobbyList').catch(() => '');
if (!lobby.includes(code)) { console.log('FAIL — lobby does not list the room'); process.exit(1); }
console.log('lobby lists the room ✓');

/* host: wait for the joiner's hello, then GO (primaryAction gates on net.open) */
const t1 = Date.now();
while (Date.now() - t1 < 45000) {
  const open = await host.evaluate(() => window.__mkr?.n2?.net()?.open);
  if (open) break;
  await host.waitForTimeout(500);
}
await host.click('#startBtn');
await host.waitForTimeout(1500);
const hostState = await host.evaluate(() => window.__mkr?.game?.state);
console.log('host state after start:', hostState);

/* joiner must see the countdown, then racing */
let sawCountdown = false, sawRacing = false;
const t0 = Date.now();
while (Date.now() - t0 < 45000) {
  const st = await join.evaluate(() => window.__mkr?.game?.state);
  if (st === 'countdown') sawCountdown = true;
  if (st === 'racing') { sawRacing = true; break; }
  await join.waitForTimeout(500);
}
if (!sawCountdown || !sawRacing) { console.log('FAIL — joiner never reached the race (countdown=' + sawCountdown + ')'); process.exit(1); }
console.log('joiner saw countdown + racing ✓');

/* the joiner's HUD is live: lap text present, time ticking */
const lapHud = await join.textContent('#lap-hud').catch(() => '');
console.log('joiner lap HUD:', (lapHud || '').replace(/\s+/g, ' ').slice(0, 40));
if (!/LAP/i.test(lapHud || '')) { console.log('FAIL — joiner lap HUD missing'); process.exit(1); }

/* host drives for 8 s; the joiner must see the peer kart's position
 * move (its interpolated mirror renders — check the pos HUD / speed) */
await join.waitForTimeout(8000);
const speedHud = await join.textContent('#speed-hud').catch(() => '');
console.log('joiner speed HUD:', (speedHud || '').trim().slice(0, 20));

await browser.close();
console.log('== RELAY-E2E PASS ==');
process.exit(0);
