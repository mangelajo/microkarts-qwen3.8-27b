/* ------------------------------------------------------------------ *
 *  Minimap — a small top-down 2D canvas HUD (no assets, like everything
 *  else). Shows the whole closed track outline, every active racer as a
 *  coloured dot, and the local kart a white-ringed dot with a forward arrow
 *  so you can see where the others are relative to the loop.
 *
 *  The track data is flat 2D (samples = [x,z] on the table), so this is a
 *  fitted 2D projection: the outline is downsampled and the world bbox
 *  cached once per track rebuild — only the dots move every frame.
 *  North-up (fixed orientation), conventional for a minimap.
 * ------------------------------------------------------------------ */
import { samples, current } from './track.js';
import { ROAD_HW } from './config.js';

const SIZE = 132;                       // css px, square
const MARGIN = 14;                      // inner pad so the road edge isn't glued to the frame
const SUBSTEP = 3;                      // draw every Nth sample (1000 -> ~333 segments)

const canvas = document.getElementById('minimapCanvas');
const box = document.getElementById('minimap');
const ctx = canvas.getContext('2d');

// --- per-track cached geometry: a downsampled outline + its world bbox ---
let outline = null;       // [{x, z}, ...]
let cachedName = '';
let scale = 1, offx = 0, offz = 0, minx = 0, minz = 0;

function rebuild() {
  if (current.name === cachedName && outline) return;
  cachedName = current.name;
  outline = [];
  let loX = Infinity, loZ = Infinity, hiX = -Infinity, hiZ = -Infinity;
  for (let i = 0; i < samples.length; i += SUBSTEP) {
    const p = samples[i];
    outline.push(p);
    if (p.x < loX) loX = p.x; if (p.x > hiX) hiX = p.x;
    if (p.z < loZ) loZ = p.z; if (p.z > hiZ) hiZ = p.z;
   }
   // pad the box to the outer curb + a hair, then fit into the square area
  const m = ROAD_HW + 2;
  loX -= m; loZ -= m; hiX += m; hiZ += m;
  const usable = SIZE - MARGIN * 2;
  const s = usable / Math.max(hiX - loX, hiZ - loZ);
  const w = (hiX - loX) * s, h = (hiZ - loZ) * s;
  scale = s;
  offx = MARGIN + (usable - w) * 0.5;
  offz = MARGIN + (usable - h) * 0.5;
  minx = loX; minz = loZ;
}

function wx(x) { return offx + (x - minx) * scale; }
function wz(z) { return offz + (z - minz) * scale; }

// backing store honours device pixel ratio for a crisp small map
function fitBacking() {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  canvas.width = SIZE * dpr;
  canvas.height = SIZE * dpr;
  canvas.style.width = SIZE + 'px';
  canvas.style.height = SIZE + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

// a single racer dot: dark halo, coloured body, thin ring. `r` in px.
function dot(x, z, color, r) {
  const sx = wx(x), sy = wz(z);
  ctx.beginPath();
  ctx.arc(sx, sy, r, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(sx, sy, r, 0, Math.PI * 2);
  ctx.fillStyle = '#' + (color || 0xffffff).toString(16).padStart(6, '0');
  ctx.fill();
  ctx.lineWidth = 1.2;
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.stroke();
}

// the local kart: coloured body + white ring + a forward arrow along heading
function drawSelf(k) {
  const p = k.pos;
  const sx = wx(p.x), sy = wz(p.z);
  const fx = Math.sin(k.heading), fz = Math.cos(k.heading);  // forward in XZ (= screen-aligned)
   // forward spike just ahead of the body
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  ctx.moveTo(sx, sy);
  ctx.lineTo(sx + fx * 6.5, sy + fz * 6.5);
  ctx.stroke();
   // body dot on top so the arrow reads as "coming out of" it
  ctx.beginPath();
  ctx.arc(sx, sy, 3.4, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,0.65)';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(sx, sy, 3.0, 0, Math.PI * 2);
  ctx.fillStyle = '#' + (k.color || 0xff0000).toString(16).padStart(6, '0');
  ctx.fill();
  ctx.lineWidth = 1.6;
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();
}

/* public API --------------------------------------------------------- */
export function initMinimap() {
  fitBacking();
}

export function resizeMinimap() {
  fitBacking();
}

export function setMinimapVisible(on) {
  box.classList.toggle('hidden', !on);
}

// every frame: `list` = active karts, `self` = the local kart (drawn last/on top)
export function updateMinimap(list, self) {
  if (!list || list.length === 0 || !self) return;
  rebuild();

  ctx.clearRect(0, 0, SIZE, SIZE);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

   // track ribbon: a soft warm glow under a dark asphalt line under a bright edge
  ctx.beginPath();
  for (let i = 0; i < outline.length; i++) {
    const p = outline[i];
    const x = wx(p.x), y = wz(p.z);
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
   }
  ctx.closePath();
  ctx.strokeStyle = 'rgba(255,150,80,0.18)'; ctx.lineWidth = 9;   ctx.stroke();
  ctx.strokeStyle = 'rgba(18,14,12,0.95)';   ctx.lineWidth = 7;   ctx.stroke();
  ctx.strokeStyle = 'rgba(255,210,150,0.85)'; ctx.lineWidth = 1.4; ctx.stroke();

   // start / finish tick — a short white stroke across the loop at samples[0]
  const s0 = samples[0], s1 = samples[1] || samples[0];
  const px = -(s1.z - s0.z), pz = s1.x - s0.x;               // perpendicular to start tangent
  const nl = Math.hypot(px, pz) || 1, len = 3;
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(wx(s0.x - px / nl * len), wz(s0.z - pz / nl * len));
  ctx.lineTo(wx(s0.x + px / nl * len), wz(s0.z + pz / nl * len));
  ctx.stroke();

   // racers: everyone as a dot first, the local kart last so it sits on top
  for (const k of list) {
    if (k === self) continue;
    if (k.mesh && k.mesh.root && k.mesh.root.visible === false) continue;
    dot(k.pos.x, k.pos.z, k.color, 2.6);
   }
  drawSelf(self);
}
