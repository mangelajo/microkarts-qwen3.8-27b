/* ------------------------------------------------------------------ *
 *  ai-sim tuning playground (browser)
 *
 *  Runs the REAL kart physics + AI (race.js simulateTick + ai.js
 *  aiControl — the same code path as the game and `make sim`) on a
 *  live 2D top-down canvas. Tuning happens at runtime through
 *  config.js `tuneConfig` (live `let` bindings — no reload); the
 *  telemetry (off-road %, stalls, laps, best lap) is the same set of
 *  numbers the headless bench reports, so a tuning that fixes the
 *  bench fixes the game.
 *
 *  Run:  make serve  →  http://localhost:8080/ai-sim/playground.html
 *
 *  The `#app` div hosts scene.js's WebGL canvas — a real module import
 *  (track.js / kart.js pull it in) — parked off-screen; the playground
 *  itself renders 2D only. Kart meshes accumulate on resets (the dev
 *  tool never renders them; the renderer sits idle in #app).
 * ------------------------------------------------------------------ */
import * as THREE from 'three';
import * as cfg from '../src/config.js';
import { tuneConfig, TUNE_NAMES } from '../src/config.js';
import { samples, sampleHead, selectTrack } from '../src/track.js';
import { TRACKS } from '../src/tracks.js';
import { Kart } from '../src/kart.js';
import { aiControl } from '../src/ai.js';
import { simulateTick } from '../src/race.js';
import { setObstaclesOn, buildObstacles, obstacleList, HAZ_COLOR } from '../src/obstacles.js';
import { padList, CELL_LEN, CELL_W } from '../src/pads.js';
import { setItemsOn, itemBoxList } from '../src/items.js';

const N_S = cfg.N_SAMPLES;
const DT = 1 / 60;

/* ---------------- dom ---------------- */
const el = id => document.getElementById(id);
const view = el('view');
const vctx = view.getContext('2d');
const trackSel = el('track');
const hazChk = el('haz');
const itmChk = el('itm');
const tuneBox = el('tune');
const tuneErr = el('tuneErr');
const teleT = el('tele');
const reportEl = el('report');
const skillDef = el('skillDef');
const skillRange = el('skill');
const skillV = el('skillV');
const speedBtns = [el('sp1'), el('sp2'), el('sp4')];

for (let i = 0; i < TRACKS.length; i++)
  trackSel.insertAdjacentHTML('beforeend', `<option value="${i}">${TRACKS[i].name}</option>`);

/* ---------------- viewport: world → screen, fitted to the track bbox ---------------- */
let scale = 1, ox = 0, oz = 0;
function fit() {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < N_S; i++) {
    const s = samples[i];
    if (s.x < minX) minX = s.x;
    if (s.x > maxX) maxX = s.x;
    if (s.z < minZ) minZ = s.z;
    if (s.z > maxZ) maxZ = s.z;
  }
  const w = view.clientWidth, h = view.clientHeight;
  const pad = 46;
  scale = Math.min((w - 2 * pad) / Math.max(1, maxX - minX), (h - 2 * pad) / Math.max(1, maxZ - minZ));
  ox = (w - (maxX - minX) * scale) / 2 - minX * scale;
  oz = (h - (maxZ - minZ) * scale) / 2 - minZ * scale;
}
const SX = x => x * scale + ox;
const SY = z => z * scale + oz;
const hexCss = c => '#' + (c & 0xffffff).toString(16).padStart(6, '0');

/* road colours — cached per track (elevation shading for 3D tracks) */
let roadCol = [];
function rebuildRoadCol() {
  roadCol = new Array(N_S);
  for (let i = 0; i < N_S; i++) {
    const y = Math.min(samples[i].y, 15) / 15;
    roadCol[i] = `hsl(30, 20%, ${30 + Math.round(14 * y)}%)`;
  }
}

/* ---------------- the race: the same 4-kart grid as sim.mjs ---------------- */
function posAt(t) {
  const it = Math.floor((((t % 1) + 1) % 1) * N_S) % N_S;
  const h = sampleHead[it];
  const P = samples[it];
  const T = new THREE.Vector3(Math.cos(h), 0, Math.sin(h));
  const Nn = new THREE.Vector3(-T.z, 0, T.x);
  return { P, T, Nn, it };
}
const GRID4 = [
  { u: 0.9925, o: -1.75 }, { u: 0.9925, o: 1.75 },
  { u: 0.985, o: -1.75 }, { u: 0.985, o: 1.75 },
];
const SKILL_SET = [0, 99, 1, 2]; // 99 = the "YOU" slot (skill 0.95 in sim.mjs)

let karts = [];
let stat = [];
function buildKarts() {
  karts.length = 0;
  stat = [];
  for (let i = 0; i < 4; i++) {
    const si = SKILL_SET[i];
    const skill = si === 99 ? 0.95 : cfg.AI_SKILL[si];
    const k = new Kart({ isPlayer: si === 99, name: si === 99 ? 'YOU' : `AI${si}`, skill });
    const g = GRID4[i];
    const { P, T, Nn, it } = posAt(g.u);
    k.pos.copy(P).addScaledVector(Nn, g.o);
    k.heading = Math.atan2(T.x, T.z);
    k.trackIdx = it;
    k.prevU = g.u;
    k.lane = g.o * 0.9;
    karts.push(k);
    stat.push({ off: 0, still: 0, t: 0, best: 0 });
  }
}

let simMs = 0, paused = false, speedX = 1, doneAt = -1, wallHits = 0;
const allDone = () => karts.every(k => k.raceDone);
const timedOut = () => simMs / 1000 > 300 && !allDone();

/* the shared race core — same call as sim.mjs's items scenario */
const inputFor = (k, racing) => racing ? aiControl(k, karts) : { throttle: 0, steer: 0 };
function stepOnce() {
  simulateTick(karts, inputFor, DT, simMs, { racing: !allDone(), crashFor: null, wallFor: () => { wallHits++; } });
  simMs += DT * 1000;
  for (let i = 0; i < karts.length; i++) {
    const k = karts[i], s = stat[i];
    s.t += DT;
    if (k.offRoad) s.off += DT;
    if (Math.abs(k.speed) < 0.03) s.still += DT;
    const last = k.lapTimes.length ? k.lapTimes[k.lapTimes.length - 1] : 0;
    if (last > s.best) s.best = last;
  }
}
function resetRace() {
  buildKarts();
  simMs = 0;
  doneAt = -1;
  wallHits = 0;
  reportEl.textContent = '';
  tuneErr.textContent = '';
}

/* ---------------- 2D render (top-down) ---------------- */
function strokeTrack(width, color) {
  vctx.lineWidth = width;
  vctx.strokeStyle = color;
  vctx.beginPath();
  vctx.moveTo(SX(samples[0].x), SY(samples[0].z));
  for (let i = 1; i <= N_S; i++) vctx.lineTo(SX(samples[i % N_S].x), SY(samples[i % N_S].z));
  vctx.stroke();
}
function drawStartLine() {
  const s = samples[0];
  const h = sampleHead[0];
  const px = -Math.sin(h), pz = Math.cos(h); // perpendicular to the sample heading
  vctx.strokeStyle = '#e8e0d0';
  vctx.lineWidth = Math.max(2, 0.5 * scale);
  vctx.beginPath();
  vctx.moveTo(SX(s.x + px * cfg.ROAD_HW), SY(s.z + pz * cfg.ROAD_HW));
  vctx.lineTo(SX(s.x - px * cfg.ROAD_HW), SY(s.z - pz * cfg.ROAD_HW));
  vctx.stroke();
}
function drawPads() {
  const L = CELL_LEN * scale, W = CELL_W * scale;
  vctx.fillStyle = 'rgba(255, 200, 60, 0.4)';
  for (const p of padList) {
    vctx.save();
    vctx.translate(SX(p.x), SY(p.z));
    vctx.rotate(p.h); // +x along the direction of travel (screen x = x, screen y = z)
    vctx.fillRect(-L / 2, -W / 2, L, W);
    vctx.restore();
  }
}
function drawObstacles() {
  for (const ob of obstacleList) {
    vctx.fillStyle = hexCss(HAZ_COLOR[ob.kind] ?? 0xcc44aa);
    vctx.beginPath();
    vctx.arc(SX(ob.x), SY(ob.z), Math.max(2, ob.r * scale), 0, Math.PI * 2);
    vctx.fill();
  }
}
function drawItems() {
  vctx.fillStyle = '#ffd24a';
  for (const b of itemBoxList) {
    if (b.respawnT > 0) continue;
    const r = Math.max(3, 0.8 * scale);
    vctx.save();
    vctx.translate(SX(b.x), SY(b.z));
    vctx.rotate(Math.PI / 4);
    vctx.fillRect(-r, -r, 2 * r, 2 * r);
    vctx.restore();
  }
}
function drawKarts() {
  for (const k of karts) {
    const x = SX(k.pos.x), y = SY(k.pos.z);
    const r = Math.max(4, 1.15 * scale);
    vctx.fillStyle = hexCss(k.color);
    vctx.beginPath();
    vctx.arc(x, y, r, 0, Math.PI * 2);
    vctx.fill();
    if (k.offRoad) {
      vctx.strokeStyle = '#fff';
      vctx.lineWidth = 2;
      vctx.stroke();
    }
    vctx.strokeStyle = '#fff';
    vctx.lineWidth = 2;
    vctx.beginPath();
    vctx.moveTo(x, y);
    vctx.lineTo(x + Math.sin(k.heading) * r * 1.8, y + Math.cos(k.heading) * r * 1.8);
    vctx.stroke();
    vctx.fillStyle = '#e8d8c0';
    vctx.font = `${Math.max(10, 0.7 * scale)}px monospace`;
    vctx.fillText(k.name, x + r * 1.3, y - r * 1.3);
  }
}
function render() {
  const w = view.clientWidth, h = view.clientHeight;
  vctx.fillStyle = '#141008';
  vctx.fillRect(0, 0, w, h);
  vctx.lineCap = 'round';
  strokeTrack(2 * (cfg.ROAD_HW + cfg.CURB_W) * scale, '#8f8676'); // curbs (wider pass under)
  vctx.lineWidth = 2 * cfg.ROAD_HW * scale;                     // road, shaded by elevation
  for (let i = 0; i < N_S; i++) {
    const a = samples[i], b = samples[(i + 1) % N_S];
    vctx.strokeStyle = roadCol[i];
    vctx.beginPath();
    vctx.moveTo(SX(a.x), SY(a.z));
    vctx.lineTo(SX(b.x), SY(b.z));
    vctx.stroke();
  }
  drawStartLine();
  drawPads();
  drawObstacles();
  drawItems();
  drawKarts();
}

/* ---------------- telemetry (the same numbers `make sim` prints) ---------------- */
function updateTelemetry() {
  let html = '<tr><th>kart</th><th>skill</th><th>lap</th><th>km/h</th><th>off%</th><th>stall%</th><th>best lap</th></tr>';
  for (let i = 0; i < karts.length; i++) {
    const k = karts[i], s = stat[i];
    html += `<tr><td><span class="dot" style="background:${hexCss(k.color)}"></span>${k.name}</td>` +
      `<td>${k.skill.toFixed(2)}</td>` +
      `<td>${k.lapDone}/${k.laps}</td>` +
      `<td>${(Math.abs(k.speed) * cfg.KMH_PER_U).toFixed(0)}</td>` +
      `<td>${s.t ? (100 * s.off / s.t).toFixed(1) : '0.0'}</td>` +
      `<td>${s.t ? (100 * s.still / s.t).toFixed(1) : '0.0'}</td>` +
      `<td>${s.best ? s.best.toFixed(1) + 's' : '—'}</td></tr>`;
  }
  teleT.innerHTML = html;
  if ((allDone() || timedOut()) && doneAt < 0) {
    doneAt = simMs;
    reportEl.textContent = karts.map(k => {
      const last = k.lapTimes.length ? k.lapTimes[k.lapTimes.length - 1] : 0;
      return `${k.name} (${k.skill.toFixed(2)}): ${k.raceDone ? `FINISHED laps=${k.lapDone} lastLap=${last.toFixed(1)}` : `stuck laps=${k.lapDone}`}`;
    }).join('\n') + `\nwalls=${wallHits} · sim ${(simMs / 1000).toFixed(1)}s`;
  }
}

/* ---------------- the race loop (wall-clock budgeted; 60 Hz sim step) ---------------- */
let last = performance.now(), teleAcc = 0;
function frame() {
  requestAnimationFrame(frame);
  const now = performance.now();
  const wall = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (!paused && !(allDone() || timedOut())) {
    let budget = wall * speedX;
    let guard = 0;
    while (budget > 0 && guard++ < 12 && !(allDone() || timedOut())) {
      stepOnce();
      budget -= DT;
    }
  }
  render();
  teleAcc += wall;
  if (teleAcc > 0.15) {
    teleAcc = 0;
    updateTelemetry();
  }
}

/* ---------------- runtime tuning (config.js tuneConfig) ---------------- */
const TUNE_GROUPS = [
  ['physics', ['ACCEL', 'BRAKE', 'MAX_SPEED', 'MAX_REV', 'KMH_PER_U', 'DRAG', 'OFF_DRAG', 'OFF_GRIP', 'STEER_RATE', 'ROAD_HW', 'CURB_W', 'LAPS', 'WHEEL_R']],
  ['3d elevation', ['GRAVITY', 'FALL_G', 'FELL_MIN_HEIGHT', 'FELL_PENALTY', 'JUMP_MIN_SPEED', 'TUMBLE_RATE', 'SLOPE_BRAKE_FACTOR']],
  ['drift', ['DRIFT_MIN_KMH', 'DRIFT_STEER', 'DRIFT_GRIP', 'DRIFT_MAX_SLIP', 'DRIFT_DRAG', 'DRIFT_CHARGE_MAX', 'BOOST_ACCEL', 'BOOST_HEADROOM']],
  ['items', ['N_ITEM_BOXES', 'ITEM_WEIGHTS', 'ITEM_RESPAWN', 'ITEM_COOLDOWN', 'RUBBER_ACCEL', 'WALL_SPEED', 'WALL_LIFE', 'WALL_HIT_KILL']],
  ['ai', ['N_AI', 'AI_SKILL']],
  ['2p net', ['SIM_DT', 'COUNTDOWN_MS', 'INTERP_DELAY', 'N_AI_2P']],
];
const fmt = v => Array.isArray(v) ? '[' + v.join(', ') + ']' : String(v);
function prefill() {
  tuneBox.value = TUNE_GROUPS.map(([g, names]) =>
    `// ${g}\n` + names.map(n => `${n} = ${fmt(cfg[n])}`).join('\n')).join('\n\n');
}
let defaults = {};
function snapshot() {
  defaults = {};
  for (const n of TUNE_NAMES) defaults[n] = Array.isArray(cfg[n]) ? [...cfg[n]] : cfg[n];
}
function parseTune(text) {
  const patch = {}, errors = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('//')) continue;
    const m = line.match(/^(\w+)\s*=\s*(.+)$/);
    if (!m) { errors.push(`bad line: ${line}`); continue; }
    const [, name, vs] = m;
    if (!TUNE_NAMES.includes(name)) { errors.push(`unknown name: ${name}`); continue; }
    let v;
    if (vs.startsWith('[')) {
      const inner = vs.slice(1, vs.lastIndexOf(']') >= 0 ? vs.lastIndexOf(']') : vs.length)
        .split(',').map(x => parseFloat(x.trim()));
      if (inner.some(x => Number.isNaN(x))) { errors.push(`bad array for ${name}`); continue; }
      v = inner;
    } else {
      v = vs === 'true' ? true : vs === 'false' ? false : parseFloat(vs);
      if (Number.isNaN(v) && typeof cfg[name] !== 'boolean') { errors.push(`bad value for ${name}`); continue; }
    }
    patch[name] = v;
  }
  return { patch, errors };
}
el('apply').onclick = () => {
  const { patch, errors } = parseTune(tuneBox.value);
  tuneErr.textContent = errors.join(' · ');
  if (errors.length) return;
  tuneConfig(patch);
  resetRace(); // karts are rebuilt from the (now tuned) skill/lap values
};
el('def').onclick = () => {
  tuneConfig(defaults);
  prefill();
  resetRace();
};

/* ---------------- controls ---------------- */
let curTrack = 0;
trackSel.onchange = () => {
  curTrack = +trackSel.value;
  selectTrack(curTrack);
  fit();
  rebuildRoadCol();
  resetRace();
};
hazChk.onchange = () => { setObstaclesOn(hazChk.checked); buildObstacles(curTrack); };
itmChk.onchange = () => { setItemsOn(itmChk.checked); selectTrack(curTrack); };
function setSpeed(x) {
  speedX = x;
  [1, 2, 4].forEach((v, i) => speedBtns[i].classList.toggle('on', v === x));
}
speedBtns[0].onclick = () => setSpeed(1);
speedBtns[1].onclick = () => setSpeed(2);
speedBtns[2].onclick = () => setSpeed(4);
el('pause').onclick = () => {
  paused = !paused;
  el('pause').textContent = paused ? 'resume' : 'pause';
};
el('reset').onclick = resetRace;
skillDef.onchange = () => {
  skillRange.disabled = skillDef.checked;
  if (skillDef.checked) {
    for (let i = 0; i < karts.length; i++)
      karts[i].skill = i === 1 ? 0.95 : cfg.AI_SKILL[SKILL_SET[i]];
    skillV.textContent = '';
  }
};
skillRange.oninput = () => {
  skillDef.checked = false;
  skillRange.disabled = false;
  const v = +skillRange.value;
  for (const k of karts) k.skill = v;
  skillV.textContent = ` all=${v.toFixed(2)}`;
};

function resize() {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  view.width = view.clientWidth * dpr;
  view.height = view.clientHeight * dpr;
  vctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  fit();
}
window.addEventListener('resize', resize);

/* ---------------- go ---------------- */
resize();
snapshot();
prefill();
selectTrack(curTrack);
fit();
rebuildRoadCol();
resetRace();
requestAnimationFrame(frame);
