import { LAPS, game, KMH_PER_U, BLAST_KMH, ITEM_NAMES } from './config.js';
import { TRACKS } from './tracks.js';
import { getBestMs } from './ghost.js';

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

/* ------------------------------------------------------------------ *
 *  2P LAN UI — mode chips (SOLO / HOST / JOIN), pairing panel, status
 * ------------------------------------------------------------------ */
const modeRow = el('modeRow');
export const hostCode  = el('hostCode');
export const joinInField  = el('joinInField');
export const joinOutCode = el('joinOutCode');
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
    joinOutCode.textContent = '—';
    joinOutCode.classList.add('hidden');
    el('joinOutLabel').style.display = 'none';
  }
  netPanel.classList.toggle('hidden', m === 'solo');
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
export function setHostRoster(r) {
  hostRoster = r;
  for (const c of rosterRow.children) c.classList.toggle('sel', c.dataset.roster === r);
}
export function getHostRoster() { return hostRoster; }


export function initModePicker(onMode, onHostAnswer, onJoinSend, onRoster) {
  for (const c of modeRow.children) {
    c.addEventListener('click', e => { onMode(c.dataset.mode); e.target.blur(); });
  }
  el('answerBtn').addEventListener('click', e => { onHostAnswer(); e.target.blur(); });
  el('joinBtn').addEventListener('click', e => { onJoinSend(); e.target.blur(); });
  for (const c of rosterRow.children) {
    c.addEventListener('click', e => { onRoster(c.dataset.roster); e.target.blur(); });
  }
  el('joinInField').addEventListener('input', () => { joinInField.innerText = joinInField.innerText.trimStart(); });
  joinOutCode.addEventListener('click', () => {
    if (joinOutCode.textContent === '—') return;
    try { navigator.clipboard.writeText(joinOutCode.textContent); joinMsg.textContent = 'Copied! Paste it in the host STEP 2 box.'; }
    catch { joinMsg.textContent = 'Select + copy the code, then paste it on the host’s screen.'; }
  });
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
  try { return localStorage.getItem('mkr-hazard') === '1'; } catch { return false; }
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
  try { return localStorage.getItem('mkr-items') === '1'; } catch { return false; }
}
