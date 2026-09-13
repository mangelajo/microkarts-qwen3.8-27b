// Track editor: drag the current track's control points on a top-down
// canvas; the track rebuilds live (same buildTrack path — corners, pads,
// puddles, scenery all follow). Session-only (not persisted) and solo-only
// (a 2P peer would build the un-edited track from the track idx).
import { TRACKS } from './tracks.js';
import { selectTrack, samples } from './track.js';
import { N_SAMPLES } from './config.js';

let canvas, g, viewScale, viewC, dragging = -1, lastRebuild = 0, noteEl;
const FACTORY = TRACKS.map(t => t.points.map(p => p.slice()));   // captured at boot

const RANGE = 130;   // the editor window is ±130 u (bigger than any stock track)

export function initTrackEditor(trackIdx, note) {
  canvas = document.getElementById('editCanvas');
  if (!canvas) return;
  g = canvas.getContext('2d');
  noteEl = note;
  viewC = canvas.width / 2;
  viewScale = (canvas.width / 2 - 14) / RANGE;
  canvas.addEventListener('pointerdown', e => {
    const p = pt(e);
    dragging = hit(p.x, p.y);
    if (dragging >= 0) canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', e => {
    if (dragging < 0) return;
    const p = pt(e);
    const t = TRACKS[trackIdx].points;
    t[dragging] = [Math.max(-125, Math.min(125, p.x)), 0, Math.max(-125, Math.min(125), p.y)];
    scheduleRebuild(trackIdx);
  });
  canvas.addEventListener('pointerup', () => { dragging = -1; });
  draw(trackIdx);
}

function pt(e) {
  const r = canvas.getBoundingClientRect();
  const sx = canvas.width / r.width, sy = canvas.height / r.height;
  return { x: (e.clientX - r.left) * sx - viewC, y: (e.clientY - r.top) * sy - viewC };
}

function hit(px, py) {
  const t = TRACKS[currentIdx()].points;
  for (let i = t.length - 1; i >= 0; i--) {
    if (Math.hypot(px - t[i][0] * viewScale, py - t[i][2] * viewScale) < 14 / Math.max(0.5, viewScale / 1.2)) return i;
  }
  return -1;
}

let curIdx = 0;
function currentIdx() { return curIdx; }

export function setEditorTrackIdx(i) { curIdx = i; draw(i); }

function scheduleRebuild(idx) {
  const now = performance.now();
  if (now - lastRebuild < 140) return;
  lastRebuild = now;
  selectTrack(idx);   // full rebuild — corners/pads/puddles/scenery follow
  draw(idx);
}

function draw(idx) {
  const t = TRACKS[idx];
  g.clearRect(0, 0, canvas.width, canvas.height);
  g.fillStyle = '#141018';
  g.fillRect(0, 0, canvas.width, canvas.height);
  // the racing line (samples of the CURRENT build)
  g.strokeStyle = 'rgba(255,200,90,0.35)';
  g.lineWidth = 2;
  g.beginPath();
  for (let i = 0; i <= N_SAMPLES; i += 3) {
    const s = samples[i % N_SAMPLES];
    const x = viewC + s.x * viewScale, y = viewC + s.z * viewScale;
    if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
  }
  g.closePath();
  g.stroke();
  // the control points (draggable, numbered)
  t.points.forEach((p, i) => {
    const x = viewC + p[0] * viewScale, y = viewC + p[2] * viewScale;
    g.fillStyle = i === dragging ? '#ffd21e' : '#8a7a5a';
    g.beginPath();
    g.arc(x, y, 9, 0, 6.29);
    g.fill();
    g.fillStyle = '#141018';
    g.font = 'bold 10px monospace';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(String(i + 1), x, y + 0.5);
  });
  if (noteEl) noteEl.textContent =
    `TRACK ${idx + 1} — ${t.name} · ${t.points.length} POINTS · SOLO · SESSION-ONLY (NOT SAVED)` +
    (hasEditChanges(idx) ? ' · EDITED' : '');
}

export function resetEditor(idx) {
  TRACKS[idx].points = FACTORY[idx].map(p => p.slice());
  selectTrack(idx);
  draw(idx);
}

export function hasEditChanges(idx) {
  return TRACKS[idx].points.some((p, i) => p[0] !== FACTORY[idx][i][0] || p[2] !== FACTORY[idx][i][2]);
}
