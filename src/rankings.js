/* ------------------------------------------------------------------ *
 *  Rankings — top-5 best laps per track (ROADMAP Phase 3, the ghost
 *  phase remnant).
 *
 *  Owns a SEPARATE localStorage key ('mkr-rank') from the ghost
 *  ('mkr-ghost'): the ghost keeps one record per track (best lap + its
 *  position timeline), the rankings keep five per track — ms + a short
 *  date, no timeline, so an entry is tens of bytes and the whole board
 *  stays well under a KB. Local-only, like the ghost: solo + host
 *  lap events only (the join client mirrors host-clock laps; its
 *  caller in game.js is already gated), and nothing goes over the wire.
 *  Not imported by ai-sim: localStorage code never runs headless
 *  (net-sim polyfills it for the store tests).
 * ------------------------------------------------------------------ */

const KEY = 'mkr-rank';
const TOP_N = 5;

let store = {};
let trackIdx = 0;
let remote = [];   // [{ ms, d, name }] from rank.php (best effort, non-blocking)

function apiBase() {
  try {
    const m = new URLSearchParams(location.search).get('api');
    return m ? m.replace(/\/$/, '') : '';
  } catch { return ''; }   // headless: no location — no relay
}

function load() {
  try { store = JSON.parse(localStorage.getItem(KEY)) || {}; } catch { store = {}; }
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(store)); } catch { /* private mode */ }
}

/** Load the board (call once at boot; re-loading after a refresh is a no-op). */
export function rankInit() {
  load();
  fetchRemote();
}

/** Pull the global top-5 for the current track (best effort). The relay
 *  is optional — offline = local board only. */
function fetchRemote() {
  if (typeof fetch !== 'function') return;
  fetch(apiBase() + '/api/rank.php?track=' + trackIdx)
    .then(r => r.json())
    .then(j => { remote = (j && j.top) || []; })
    .catch(() => { remote = []; });
}

/** Point the board at another track (menu / host track change). */
export function rankSetTrack(idx) {
  trackIdx = idx;
  fetchRemote();
}

/** The top 5 for the current track, fastest first: local entries
 *  { ms, d } (d = 'YYMMDD') merged with global entries
 *  { ms, d, name, g:true }. A copy: callers may not mutate the store. */
export function getTop() {
  const all = (store[trackIdx] || []).concat(remote);
  all.sort((a, b) => a.ms - b.ms);
  return all.slice(0, TOP_N);
}

/** The player completed a lap of `lapMs` ms: if it cracks the current
 *  track's top 5, store it and return its rank (1..TOP_N), else 0.
 *  A tie with the worst slot is rejected — the board stays stable.
 *  `name` also submits to the global board (best effort, fire-and-forget). */
export function rankLapDone(lapMs, name = 'YOU') {
  if (!(lapMs > 0)) return 0;
  const list = store[trackIdx] ? store[trackIdx].slice() : [];
  if (list.length >= TOP_N && lapMs >= list[TOP_N - 1].ms) {
    submitRemote(lapMs, name);
    return 0;
  }
  const d = new Date();
  const ds = String(d.getFullYear()).slice(2)
    + String(d.getMonth() + 1).padStart(2, '0')
    + String(d.getDate()).padStart(2, '0');
  const entry = { ms: Math.round(lapMs), d: ds };
  list.push(entry);
  list.sort((a, b) => a.ms - b.ms);
  const rank = list.indexOf(entry);
  store[trackIdx] = list.slice(0, TOP_N);
  save();
  submitRemote(lapMs, name);
  return rank + 1;
}

/** Best-effort global submission (rate-limited server-side). */
function submitRemote(lapMs, name) {
  if (typeof fetch !== 'function') return;
  fetch(apiBase() + '/api/rank.php', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ name: String(name).slice(0, 12), ms: Math.round(lapMs), track: trackIdx }),
  }).catch(() => {});
}
