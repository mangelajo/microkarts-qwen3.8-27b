/* ------------------------------------------------------------------ *
 *  Development screenshot rig (Playwright + headless Chromium).
 *
 *  Serves the project root (no-cache) and captures the menu, the 2P
 *  host panel, the countdown and a live race — on desktop AND phone
 *  viewports — into `screens/` (gitignored). Fails (exit 1) if the
 *  page throws any JS error or the overlay never appears, so it doubles
 *  as the CI render check: if the browser boots the game and renders,
 *  the screenshots exist.
 *
 *  Usage:  node ai-sim/screens.mjs [port]      (default 8123)
 *          npm run screens
 * ------------------------------------------------------------------ */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, 'screens');
const PORT = Number(process.argv[2]) || 8123;

/* ---- static server (same no-cache behaviour as ai-sim/serve.py) ---- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript',
  '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p0 = normalize(join(ROOT, decodeURIComponent(url.pathname)));
  const p = (p0 === ROOT || p0.endsWith('/')) ? join(p0, 'index.html') : p0;
  if (!p.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  try {
    const data = await readFile(p);
    res.writeHead(200, {
      'Content-Type': MIME[extname(p)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('not found');
  }
});

const VPS = {
  desktop: { width: 1280, height: 900 },
  phone: { width: 390, height: 844 },
};

const { mkdir } = await import('node:fs/promises');
await mkdir(OUT, { recursive: true });

const listen = p => new Promise((res, rej) => {
  server.once('error', rej);
  server.listen(p, () => { server.removeListener('error', rej); res(); });
});
try { await listen(PORT); } catch { await listen(0); }   // PORT busy -> OS picks
const PORT_ACTUAL = server.address().port;
console.log(`screens: serving ${ROOT} at http://localhost:${PORT_ACTUAL}`);
const browser = await chromium.launch();

let failed = false;
let shots = 0;
const shot = async (page, name) => {
  const p = join(OUT, `${name}.png`);
  await page.screenshot({ path: p });
  shots += 1;
  console.log(`  captured ${name}.png`);
};
for (const [name, vp] of Object.entries(VPS)) {
  const page = await browser.newPage({ viewport: vp });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto(`http://localhost:${PORT_ACTUAL}/`, { waitUntil: 'load', timeout: 30000 });
  await page.waitForSelector('#overlay', { state: 'visible', timeout: 20000 });
  await page.waitForTimeout(1500);                        // first frames + menu settle
  await shot(page, `${name}-menu`);

  // expand the 2P host panel (the biggest menu block) — skip if absent
  if (await page.locator('#modeRow [data-mode="host"]').count()) {
    await page.click('#modeRow [data-mode="host"]');
    await page.waitForTimeout(400);
    await shot(page, `${name}-menu-2p`);
    await page.click('#modeRow [data-mode="join"]');
    await page.waitForTimeout(400);
    await shot(page, `${name}-menu-join`);
    await page.click('#modeRow [data-mode="solo"]');
    await page.waitForTimeout(200);
  }

  // synthetic results state — same elements the real finish uses
  // (a full 3-lap race is too slow to wait for in a render check)
  /* eslint-disable no-undef -- page.evaluate() bodies run in the browser */
  await page.evaluate(() => {
    document.getElementById('title').textContent = 'RACE COMPLETE';
    document.getElementById('subtitle').textContent = 'YOU WRECKED EVERYONE AROUND THE TABLE';
    document.getElementById('menuSections').style.display = 'none';
    document.getElementById('startBtn').textContent = 'RACE AGAIN';
    document.getElementById('footnote').textContent = 'OR PRESS R · ESC = MENU';
    const r = document.getElementById('results');
    r.style.display = '';
    r.innerHTML = '<b>TOTAL 2:41.3</b> &nbsp;·&nbsp; BEST LAP <b>52.1</b>' +
      '<div style="font-size:13px;letter-spacing:1px;margin-top:10px">1. <b>YOU</b> 52.1 &nbsp;&nbsp; 2. BUTTERFLY 54.0 &nbsp;&nbsp; 3. MINT 55.2 &nbsp;&nbsp; 4. GUM 57.8</div>';
  });
  await page.waitForTimeout(300);
  await shot(page, `${name}-results`);
  // back to the menu for the race captures
  await page.evaluate(() => {
    document.getElementById('title').textContent = 'MICRO KART RACING';
    document.getElementById('subtitle').textContent = 'A TINY CIRCUIT ON THE DINNER TABLE';
    document.getElementById('menuSections').style.display = '';
    document.getElementById('startBtn').textContent = 'START RACE';
    document.getElementById('results').style.display = 'none';
  });
  /* eslint-enable no-undef */
  await page.waitForTimeout(200);

  await page.locator('#startBtn').scrollIntoViewIfNeeded();
  await page.click('#startBtn');
  await page.waitForTimeout(1200);                      // mid-countdown
  await shot(page, `${name}-countdown`);
  await page.waitForTimeout(3000);                     // after GO, live race
  await shot(page, `${name}-race`);

  if (errors.length) {
    console.error(`[${name}] page errors:\n  ` + errors.join('\n  '));
    failed = true;
  }
  await page.close();
}

await browser.close();
server.close();
console.log(failed
  ? '== SCREENS FAIL (page errors) =='
  : `== SCREENS OK (${shots} captures in screens/) ==`);
process.exit(failed ? 1 : 0);
