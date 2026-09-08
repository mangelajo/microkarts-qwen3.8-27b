/* ------------------------------------------------------------------ *
 *  Import-graph check — the one thing `make sim` / `make netsim`
 *  cannot see: BROWSER-ONLY modules (main.js, hud.js, scene.js, …)
 *  are never imported by the headless sims, so a wrong named import
 *  in there only explodes in the browser. This script statically
 *  verifies that every relative import in src/ + ai-sim/ names an
 *  export the target module actually declares. Cheap, no execution,
 *  no stubs needed.
 * ------------------------------------------------------------------ */
import { readFileSync, readdirSync } from 'node:fs';

const dirs = ['src/', 'ai-sim/'];
const files = dirs.flatMap(d =>
  readdirSync(d).filter(f => f.endsWith('.js')).map(f => d + f));

/* static export names of a module (const/let/function/class + export {…}) */
const exportsOf = new Map();
for (const f of files) {
  const s = readFileSync(f, 'utf8');
  const names = new Set();
  for (const m of s.matchAll(/export\s+(?:const|let|var|function|class|async function)\s+([A-Za-z0-9_$]+)/g))
    names.add(m[1]);
  for (const m of s.matchAll(/export\s*\{([^}]+)\}/g))
    for (const part of m[1].split(',')) {
      const n = part.split(' as ').pop().trim();
      if (n) names.add(n);
    }
  exportsOf.set(f, names);
}

let bad = 0;
for (const f of files) {
  const s = readFileSync(f, 'utf8');
  for (const m of s.matchAll(
    /import\s*(?:\*\s+as\s+[A-Za-z0-9_$]+|([A-Za-z0-9_$]+)|\{([^}]+)\})?\s*from\s*['"](\.\.?\/[A-Za-z0-9_/.-]+\.js)['"]/g)) {
    const [, defName, named, rawPath] = m;
    // resolve './x.js' and '../src/x.js' against the importing file
    const base = f.slice(0, f.lastIndexOf('/') + 1);
    const parts = (base + rawPath).split('/');
    const out = [];
    for (const p of parts) {
      if (p === '.' || p === '') continue;
      if (p === '..') out.pop(); else out.push(p);
    }
    const target = out.join('/');
    if (!exportsOf.has(target)) {
      console.log(`!! ${f}: cannot resolve ${rawPath} -> ${target}`);
      bad++;
      continue;
    }
    const names = [
      ...(defName ? [defName] : []),
      ...(named ? named.split(',').map(p => p.split(' as ').shift().trim()).filter(Boolean) : []),
    ];
    for (const n of names)
      if (!exportsOf.get(target).has(n)) {
        console.log(`!! ${f}: ${rawPath} has no export named '${n}'`);
        bad++;
      }
  }
}
console.log(bad === 0
  ? `== IMPORTS OK (${files.length} modules) ==`
  : `== ${bad} BAD IMPORT(S) ==`);
process.exit(bad ? 1 : 0);
