import { LAPS, game } from './config.js';

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
