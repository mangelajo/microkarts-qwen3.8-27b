import { selectTrack, samples } from '../src/track.js';
import { N_SAMPLES } from '../src/config.js';
import { Kart } from '../src/kart.js';
const n = N_SAMPLES;
selectTrack(4);
let hi = -1;
for (let i = 0; i < n; i++) if (samples[i].y > 12) { hi = i; break; }
const S = samples[hi], S1 = samples[(hi + 1) % n];
let tx = S1.x - S.x, tz = S1.z - S.z;
const tl = Math.hypot(tx, tz); tx /= tl; tz /= tl;
const nx = -tz, nz = tx;
const tangent = Math.atan2(tx, tz);
const k = new Kart({ isPlayer: true });
for (const h of [tangent + Math.PI / 2, tangent - Math.PI / 2]) {
  k.pos.set(S.x + nx * 1.9, S.y, S.z + nz * 1.9);
  k.heading = h; k.trackIdx = hi; k.pitch = 0; k.roll = 0;
  const c = k.cornerTorques();
  // per-corner detail (replicate the loop with logging)
  const S2 = samples[k.trackIdx], S3 = samples[(k.trackIdx + 1) % n];
  let t2 = S3.x - S2.x, z2 = S3.z - S2.z;
  const l2 = Math.hypot(t2, z2); t2 /= l2; z2 /= l2;
  const x2 = -z2, z3 = t2;
  const ch = Math.cos(k.heading), sh = Math.sin(k.heading);
  for (let cI = 0; cI < 4; cI++) {
    const cx = cI === 0 || cI === 2 ? 0.95 : -0.95;
    const cz = cI <= 1 ? 1.05 : -1.05;
    const wx = k.pos.x + cx * ch + cz * sh;
    const wz = k.pos.z - cx * sh + cz * ch;
    const lx = (wx - S2.x) * x2 + (wz - S2.z) * z3;
    const sup = Math.abs(lx) <= 2.1 + 0.8 ? S2.y : 0;
    console.log(`h=${(h - tangent > 0 ? '+90' : '-90')} corner(${cx > 0 ? 'R' : 'L'}${cz > 0 ? 'F' : 'Rear'}): lx=${lx.toFixed(2)} sup=${sup.toFixed(1)} gap=${Math.max(0, k.pos.y - sup - 0.15).toFixed(2)}`);
  }
  console.log(`  -> tP=${c.tP.toFixed(2)} tR=${c.tR.toFixed(2)} m=${c.m.toFixed(2)} maxG=${c.maxG.toFixed(2)}`);
}
