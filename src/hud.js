import { LAPS, game } from './config.js';
import { TRACKS } from './tracks.js';

/* ------------------------------------------------------------------ *
 *  HUD
 * ------------------------------------------------------------------ */
export const el = id => document.getElementById(id);
export const overlay   = el('overlay');
export const startBtn  = el('startBtn');
const titleEl   = el('title');
const subEl     = el('subtitle');
const keysEl    = el('keys');
const footEl    = el('footnote');
export const resultsEl = el('results');

export function fmt(t) {
  if (t == null) return '--';
  const d = Math.floor(t * 10); // tenths, floored once
  const m = Math.floor(d / 600);
  const ss = String(Math.floor((d % 600) / 10)).padStart(2, '0');
  return m + ':' + ss + '.' + (d % 10);
}

export function showOverlay(title, subtitle, btn, keysVisible, footnote) {
  titleEl.textContent = title;
  subEl.textContent = subtitle;
  keysEl.style.display = keysVisible ? '' : 'none';
  footEl.textContent = footnote;
  startBtn.textContent = btn;
  overlay.classList.remove('hidden');
}
export function hideOverlay() { overlay.classList.add('hidden'); }
export function hideCountdown() {
  el('countdown').classList.remove('on', 'go');
  game.cdText = -1;
}

export function updateHud(r, l, karts) {
  const p = karts[karts.length - 1]; // player is pushed last
  el('lap').textContent = 'LAP ' + Math.min(p.lapDone + 1, LAPS) + '/' + LAPS;
  el('time').textContent = fmt(r);
  el('laptime').textContent = fmt(l);
  el('speed').textContent = Math.round(Math.abs(p.speed) * 7);
  const best = p.lapDone ? Math.min(...p.lapTimes) : null;
  el('best').innerHTML = 'BEST <span class="val">' + (best == null ? '--' : fmt(best)) + '</span>';
  el('pos').textContent = String(p.posIdx || 1);
  el('pos').parentElement.classList.toggle('lead', p.posIdx === 1);
  el('warn').classList.toggle('on', p.offRoad && game.state === 'racing');
}

/* ------------------------------------------------------------------ *
 *  Track picker — chips on the menu; persisted in localStorage
 * ------------------------------------------------------------------ */
const trackSel = { idx: 0, onChange: null };
const trackRow = el('trackRow');
const trackChips = [];
export const getTrackIdx = () => trackSel.idx;

export function initTrackPicker(onChange) {
  trackSel.onChange = onChange;
  for (let i = 0; i < TRACKS.length; i++) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'tchip';
    chip.textContent = (i + 1) + '. ' + TRACKS[i].name;
    chip.addEventListener('click', e => { setTrack(i); e.target.blur(); });
    trackRow.appendChild(chip);
    trackChips.push(chip);
  }
  loadPersisted();
}

export function setTrack(i) {
  const n = ((i % TRACKS.length) + TRACKS.length) % TRACKS.length;
  if (n === trackSel.idx) return;
  trackSel.idx = n;
  trackChips.forEach((c, j) => c.classList.toggle('sel', j === n));
  el('trackName').textContent = TRACKS[n].name;
  try { localStorage.setItem('mkr-track', String(n)); } catch { /* private mode */ }
  trackSel.onChange && trackSel.onChange(n);
}

export function cycleTrack(dir) {
  const n = ((trackSel.idx + dir) % TRACKS.length + TRACKS.length) % TRACKS.length;
  setTrack(n);
}

function loadPersisted() {
  let i = 0;
  try {
    const v = parseInt(localStorage.getItem('mkr-track'), 10);
    if (v >= 0 && v < TRACKS.length) i = v;
  } catch { /* private mode */ }
  trackSel.idx = i;
  trackChips.forEach((c, j) => c.classList.toggle('sel', j === i));
  el('trackName').textContent = TRACKS[i].name;
}
