import { LAPS, game, KMH_PER_U, BLAST_KMH, ITEM_NAMES, ITEM_RUBBER, RUBBER_DURATION } from './config.js';
import { TRACKS } from './tracks.js';
import { getBestMs } from './ghost.js';
import { getTop } from './rankings.js';
import { isTouchDevice } from './touch.js';

/* ------------------------------------------------------------------ *
 *  HUD
 * ------------------------------------------------------------------ */
export const el = id => document.getElementById(id);

/* rubber-band countdown clock (display only): the wire carries the item id,
   not remaining time, so a local clock runs from the id transition — the
   sim's itemLife is authoritative for the local kart; the remote mirror
   matches within interpolation error */
let rubberStartT = 0;
export const overlay   = el('overlay');
export const startBtn  = el('startBtn');
const titleEl   = el('title');
const menuSections = el('menuSections');
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

export function showOverlay(title, subtitle, btn, isMenu, footnote) {
  titleEl.textContent = title;
  subEl.textContent = subtitle;
  // isMenu (the old "keysVisible"): the whole menu block — keys, mode,
  // pairing, track, toggles, rankings — only exists on the menu; results
  // and link-dropped states must not show the controls underneath
  menuSections.style.display = isMenu ? '' : 'none';
  keysEl.style.display = isMenu ? '' : 'none';
  footEl.textContent = footnote;
  startBtn.textContent = btn;
  overlay.classList.remove('hidden');
}
export function hideOverlay() { overlay.classList.add('hidden'); }
export function hideCountdown() {
  el('countdown').classList.remove('on', 'go');
  game.cdText = -1;
}

/* ------------------------------------------------------------------ *
 *  2P LAN UI — mode chips (SOLO / HOST / JOIN), pairing panel, status
 * ------------------------------------------------------------------ */
const modeRow = el('modeRow');
export const hostCode  = el('hostCode');
export const joinInField  = el('joinInField');
export const netStatus = el('netStatus');
export const rosterRow = el('rosterRow');
export const hostMsg   = el('hostMsg');
export const joinMsg   = el('joinMsg');
export let netPanel    = el('netPanel');
let hostPanel = el('hostPanel');
let joinPanel = el('joinPanel');
let mode = 'solo'; // solo | host | join

export function getMode() { return mode; }

export function setMode(m) {
  mode = m;
  hostPanel.style.display = m === 'host' ? '' : 'none';
  joinPanel.style.display = m === 'join' ? '' : 'none';
  rosterRow.style.display  = m === 'host' ? '' : 'none';
  if (m === 'join') { // fresh join attempt
    joinInField.innerText = '';
  }
  if (m !== 'host') el('hostCodeQr').classList.add('hidden');
  netPanel.classList.toggle('hidden', m === 'solo');
  el('multiHint').style.display = m === 'solo' ? '' : 'none';
  trackWrapEl().style.display = m === 'join' ? 'none' : '';
  hazardWrapEl().style.display = m === 'join' ? 'none' : ''; // join mirrors the host's pick
  itemWrapEl().style.display = m === 'join' ? 'none' : '';   // ditto for item boxes
  for (const c of modeRow.children) c.classList.toggle('sel', c.dataset.mode === m);
  setStatus(m === 'solo' ? '' : 'standby');
}

export function setStatus(s) {
  netStatus.style.display = s ? '' : 'none';
  netStatus.textContent = s;
  netStatus.classList.toggle('on', !!s && s.indexOf('CONNECTED') >= 0);
}

function trackWrapEl() { return el('trackWrap'); }
function hazardWrapEl() { return el('hazardWrap'); }
function itemWrapEl() { return el('itemWrap'); }

let hostRoster = '2ai'; // '2ai' | '1v1' — host-owned, broadcast on start
/* ---------------- menu pages (RACE / EXTRAS / CONTROLS) ---------------- */
const menuTabs = el('menuTabs');
export function initMenuTabs(onTab) {
  for (const c of menuTabs.children) {
    c.addEventListener('click', () => { onTab(c.dataset.tab); c.blur(); });
  }
}
const PAGES = ['race', 'multi', 'extras', 'controls', 'edit'];
export function setMenuPage(p) {
  for (const c of menuTabs.children) c.classList.toggle('sel', c.dataset.tab === p);
  for (const pg of PAGES) {
    el('page' + pg[0].toUpperCase() + pg.slice(1)).classList.toggle('hidden', pg !== p);
  }
}

export function setHostRoster(r) {
  hostRoster = r;
  for (const c of rosterRow.children) c.classList.toggle('sel', c.dataset.roster === r);
}
export function getHostRoster() { return hostRoster; }


export function initModePicker(onMode, onJoinSend, onRoster) {
  for (const c of modeRow.children) {
    c.addEventListener('click', e => { onMode(c.dataset.mode); e.target.blur(); });
  }
  el('joinBtn').addEventListener('click', e => { onJoinSend(); e.target.blur(); });
  for (const c of rosterRow.children) {
    c.addEventListener('click', e => { onRoster(c.dataset.roster); e.target.blur(); });
  }
  // NOTE: no 'input' handler on joinInField — re-writing innerText per
  // keystroke resets the caret to the start; joinRoom() trims on submit.
  // Enter in the field = JOIN (the game key handler ignores editable targets).
  el('joinInField').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); onJoinSend(); }
  });
  // phones have no keyboard — the CONTROLS page shows the pull-stick hints
  if (isTouchDevice()) {
    keysEl.innerHTML =
      '<div><kbd>DRAG</kbd>Drive + steer</div>' +
      '<div><kbd>PULL ↓</kbd>Brake · reverse</div>' +
      '<div><kbd>FULL LOCK</kbd>Drift · release = boost</div>';
  }
}


export function updateHud(r, l, karts) {
  const p = karts[karts.length - 1]; // player is pushed last
  const laps = p.laps || LAPS;
  el('lap').textContent = 'LAP ' + Math.min(p.lapDone + 1, laps) + '/' + laps;
  el('time').textContent = fmt(r);
  el('laptime').textContent = fmt(l);
  const kmh = Math.abs(p.speed) * KMH_PER_U;
  el('speed').textContent = Math.round(kmh);
     // glow the readout when the exhaust is on full (above BLAST_KMH)
  el('speed').style.color = kmh > BLAST_KMH ? '#ff6a3d' : '';
  // session best, else the stored track record (survives refresh, ROADMAP 3.3)
  const best = p.lapDone && p.lapTimes.length ? Math.min(...p.lapTimes)
    : (getBestMs() != null ? getBestMs() / 1000 : null);
  el('best').innerHTML = 'BEST <span class="val">' + (best == null ? '--' : fmt(best)) + '</span>';
  el('pos').textContent = String(p.posIdx || 1);
  el('pos').parentElement.classList.toggle('lead', p.posIdx === 1);
  el('warn').textContent = p.fellOff ? 'FELL OFF — RESET' : 'OFF TRACK';
  el('warn').classList.toggle('on', (p.offRoad || p.fellOff) && game.state === 'racing');
  // held item slot (items.js): glows per item kind; '—' while empty-handed
  const it = p.item || 0;
  el('itemSlot').textContent = it ? ITEM_NAMES[it] : '—';
  el('itemSlot').dataset.item = it;
  // the rubber band's expiry counter (it frees the slot when it hits 0)
  const timer = el('itemTimer');
  if (it === ITEM_RUBBER) {
    if (rubberStartT === 0) rubberStartT = performance.now();
    timer.textContent = Math.max(0, RUBBER_DURATION - (performance.now() - rubberStartT) / 1000).toFixed(1);
    timer.classList.remove('hidden');
  } else {
    rubberStartT = 0;
    timer.classList.add('hidden');
  }
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
  refreshRanks();
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
  refreshRanks();
}

/* ------------------------------------------------------------------ *
 *  Rankings (rankings.js) — the menu's per-track top-5 board + the
 *  "NEW RECORD — #N" flash when a lap cracks it
 * ------------------------------------------------------------------ */
let rankNudgeTimer = 0;
export function hudRankNudge(rk) {
  const n = el('rankNudge');
  n.textContent = 'NEW RECORD — #' + rk;
  n.style.opacity = '1';
  clearTimeout(rankNudgeTimer);
  rankNudgeTimer = setTimeout(() => { n.style.opacity = '0'; }, 3500);
}

const rankRow = el('rankRow');
const rankTrackName = el('rankTrackName');
export function refreshRanks() {
  const top = getTop();
  rankTrackName.textContent = TRACKS[trackSel.idx].name;
  rankRow.innerHTML = top.length
    ? top.map((r, i) =>
      `<div class="rk"><b>${i + 1}</b><span>${fmt(r.ms / 1000)}</span><span class="rkd">${r.d}</span></div>`).join('')
    : '<div class="rk" style="opacity:.5">— first lap to the board —</div>';
}

/* ------------------------------------------------------------------ *
 *  Sugar-hazard toggle — chips on the menu; persisted in localStorage
 * ------------------------------------------------------------------ */
const hazardChips = [];
let hazardOnChange = null;

export function initHazardPicker(onChange, initialOn) {
  hazardOnChange = onChange;
  const row = el('hazardRow');
  for (const c of row.children) {
    c.addEventListener('click', e => { setHazard(c.dataset.hazard === 'on'); e.target.blur(); });
    hazardChips.push(c);
  }
  setHazard(initialOn, /*fire*/ false);
}

export function setHazard(on, fire = true) {
  const v = !!on;
  for (const c of hazardChips) c.classList.toggle('sel', c.dataset.hazard === (v ? 'on' : 'off'));
  try { localStorage.setItem('mkr-hazard', v ? '1' : '0'); } catch { /* private mode */ }
  if (fire && hazardOnChange) hazardOnChange(v);
}

export function getHazardOn() {
  return hazardChips.some(c => c.dataset.hazard === 'on' && c.classList.contains('sel'));
}

export function loadHazardPref() {
  try { return localStorage.getItem('mkr-hazard') !== '0'; } catch { return true; }
}

/* ------------------------------------------------------------------ *
 *  Rain toggle — chips on the EXTRAS page. Purely cosmetic (no
 *  persistence, no wire): state lives in weather.js.
 * ------------------------------------------------------------------ */
let weatherChips = [];
let weatherOnChange = null;

export function initWeatherPicker(onChange, initialOn) {
  weatherOnChange = onChange;
  const row = el('rainRow');
  if (!row) return;
  for (const c of row.children) {
    c.addEventListener('click', e => { weatherOnChange(c.dataset.rain === 'on'); e.target.blur(); });
    weatherChips.push(c);
  }
  setWeatherChip(initialOn);
}

export function setWeatherChip(on) {
  const v = !!on;
  for (const c of weatherChips) c.classList.toggle('sel', c.dataset.rain === (v ? 'on' : 'off'));
}

/* ------------------------------------------------------------------ *
 *  Item-box toggle — chips on the menu; persisted in localStorage.
 *  Mirrors the hazard picker exactly (host broadcasts the pick over the
 *  wire; join clients mirror it and hide their own chips).
 * ------------------------------------------------------------------ */
const itemChips = [];
let itemOnChange = null;

export function initItemPicker(onChange, initialOn) {
  itemOnChange = onChange;
  const row = el('itemRow');
  for (const c of row.children) {
    c.addEventListener('click', e => { setItem(c.dataset.item === 'on'); e.target.blur(); });
    itemChips.push(c);
  }
  setItem(initialOn, /*fire*/ false);
}

export function setItem(on, fire = true) {
  const v = !!on;
  for (const c of itemChips) c.classList.toggle('sel', c.dataset.item === (v ? 'on' : 'off'));
  try { localStorage.setItem('mkr-items', v ? '1' : '0'); } catch { /* private mode */ }
  if (fire && itemOnChange) itemOnChange(v);
}

export function getItemOn() {
  return itemChips.some(c => c.dataset.item === 'on' && c.classList.contains('sel'));
}

export function loadItemPref() {
  try { return localStorage.getItem('mkr-items') !== '0'; } catch { return true; }
}
