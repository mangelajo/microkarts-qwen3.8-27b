/* ------------------------------------------------------------------ *
 *  Watch mode — re-run the headless AI bench (ai-sim/sim.mjs) on every
 *  change under src/ or ai-sim/. A change that lands while a bench run
 *  is still going re-triggers the run as soon as it finishes.
 *
 *  Run:  make simwatch   (or: node ai-sim/watch.mjs)
 * ------------------------------------------------------------------ */
import { watch } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const targets = ['src/', 'ai-sim/'].map(p => root + p);

let dirty = false;
let running = null;
function run(label) {
  if (running) { dirty = true; return; }
  const t0 = Date.now();
  console.log(`\n[watch] ${label} — running the bench…`);
  running = spawn(process.execPath, ['--import', './ai-sim/stub.js', 'ai-sim/sim.mjs'],
    { cwd: root, stdio: 'inherit' });
  running.on('close', code => {
    running = null;
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[watch] done in ${secs}s — ${code === 0 ? 'PASS' : 'FAIL (exit ' + code + ')'}`);
    if (dirty) { dirty = false; run('change (landed mid-run)'); }
  });
}

let pending = null;
for (const t of targets) {
  watch(t, { recursive: true }, (ev, name) => {
    clearTimeout(pending);
    pending = setTimeout(() => { pending = null; run(`change: ${name}`); }, 300);
  });
}
process.on('SIGINT', () => process.exit(0));

console.log('[watch] re-running the AI bench on every change in src/ + ai-sim/ (Ctrl-C to quit)');
run('initial');
