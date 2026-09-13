/* ------------------------------------------------------------------ *
 *  Zero-asset QR encoder — renders the 2P pairing codes as scannable
 *  QR codes (procedural, no images). Byte mode, EC level M, auto
 *  version 1-40, auto mask (lowest penalty N1-N4). Pure — no DOM, so
 *  the headless bench (ai-sim) cross-checks matrices against
 *  reference vectors.
 *
 *  The M-level tables below are the ISO/IEC 18004 values; block groups
 *  are derived exactly as (group2 = total % blocks get one extra data
 *  codeword), which the ai-sim fixture pins against a reference
 *  encoder.
 * ------------------------------------------------------------------ */

const CW_TOTAL = [26, 44, 70, 100, 134, 172, 196, 242, 292, 346,
  404, 466, 532, 581, 655, 733, 815, 901, 991, 1085,
  1156, 1258, 1364, 1474, 1588, 1706, 1828, 1921, 2051, 2185,
  2323, 2465, 2611, 2761, 2876, 3034, 3196, 3362, 3532, 3706];
const M_BLOCKS = [1, 1, 1, 2, 2, 4, 4, 4, 5, 5,
  5, 8, 9, 9, 10, 10, 11, 13, 14, 16,
  17, 17, 18, 20, 21, 23, 25, 26, 28, 29,
  31, 33, 35, 37, 38, 40, 43, 45, 47, 49];
const M_EC = [10, 16, 26, 36, 48, 64, 72, 88, 110, 130,
  150, 176, 198, 216, 240, 280, 308, 338, 364, 416,
  442, 476, 504, 560, 588, 644, 700, 728, 784, 812,
  868, 924, 980, 1036, 1064, 1120, 1204, 1260, 1316, 1372];

/* GF(256), poly 0x11D */
const GEXP = new Uint8Array(256);
const GLOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) { GEXP[i] = x; GLOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11D; }
  for (let i = 255; i < 256; i++) GEXP[i] = GEXP[i - 255];
}
const gmul = (a, b) => (a && b) ? GEXP[(GLOG[a] + GLOG[b]) % 255] : 0;

function bchDigit(x) { let d = 0; while (x) { d++; x >>>= 1; } return d; }

/* Reed-Solomon generator polynomial of degree n (highest first) */
function genPoly(n) {
  let p = [1];
  for (let i = 0; i < n; i++) {
    const q = new Array(p.length + 1).fill(0);
    for (let j = 0; j < p.length; j++) {
      q[j] ^= p[j];
      q[j + 1] ^= gmul(p[j], GEXP[i]);
    }
    p = q;
  }
  return p;
}
function rsEncode(data, gen) {
  const n = gen.length - 1;
  const res = new Uint8Array(n);
  for (let i = 0; i < data.length; i++) {
    const factor = data[i] ^ res[0];
    res.copyWithin(0, 1);
    res[n - 1] = 0;
    if (factor) for (let j = 1; j <= n; j++) res[j - 1] ^= gmul(gen[j], factor);
  }
  return res;
}

/* byte-mode data codewords + RS blocks, interleaved (level M) */
function makeCodewords(bytes, version) {
  const v = version - 1;
  const blocks = M_BLOCKS[v];
  const dataTotal = CW_TOTAL[v] - M_EC[v];
  const dataG1 = Math.floor(dataTotal / blocks);
  const group2 = dataTotal % blocks;
  const ecCount = Math.floor(CW_TOTAL[v] / blocks) - dataG1;

  // byte mode: 4-bit indicator + char count (8 bits v1-9, 16 bits v10+) + data
  const bits = [];
  const push = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  push(4, 4);
  push(bytes.length, version <= 9 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  for (let i = 0; i < 4 && bits.length % 8 !== 0; i++) bits.push(0); // terminator
  for (let i = 0; bits.length < dataTotal * 8; i++) push(i % 2 ? 0x11 : 0xEC, 8); // pads
  const dataCw = new Uint8Array(bits.length / 8);
  for (let i = 0; i < dataCw.length; i++) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i * 8 + j];
    dataCw[i] = b;
  }
  if (dataCw.length !== dataTotal) throw new Error(`qr: ${dataCw.length} != ${dataTotal} data codewords`);

  const gen = genPoly(ecCount);
  const out = new Uint8Array(CW_TOTAL[v]);
  const d1 = dataG1, d2 = dataG1 + 1;
  const ecBlocks = [];
  let off = 0;
  for (let b = 0; b < blocks; b++) {
    const size = b < blocks - group2 ? d1 : d2;
    ecBlocks.push(rsEncode(dataCw.subarray(off, off + size), gen));
    off += size;
  }
  // interleave: data first, then EC (column-wise over blocks)
  const maxData = d2;
  let idx = 0;
  const starts = [];
  off = 0;
  for (let b = 0; b < blocks; b++) {
    const size = b < blocks - group2 ? d1 : d2;
    starts.push(off); off += size;
  }
  for (let i = 0; i < maxData; i++) for (let b = 0; b < blocks; b++) {
    const size = b < blocks - group2 ? d1 : d2;
    if (i < size) out[idx++] = dataCw[starts[b] + i];
  }
  const ecLen = ecBlocks[0].length;
  for (let i = 0; i < ecLen; i++) for (let b = 0; b < blocks; b++) out[idx++] = ecBlocks[b][i];
  if (idx !== out.length) throw new Error('qr: interleave length mismatch');
  return out;
}

/* symbol geometry */
const sizeOf = v => 17 + 4 * v;
function alignPositions(version) {
  if (version === 1) return [];
  const posCount = Math.floor(version / 7) + 2;
  const size = sizeOf(version);
  const intervals = size === 145 ? 26 : Math.ceil((size - 13) / (2 * posCount - 2)) * 2;
  const positions = [size - 7];
  for (let i = 1; i < posCount - 1; i++) positions[i] = positions[i - 1] - intervals;
  positions.push(6);
  return positions.reverse();
}

function maskAt(m, r, c) {
  switch (m) {
    case 0: return (r + c) % 2 === 0;
    case 1: return r % 2 === 0;
    case 2: return c % 3 === 0;
    case 3: return (r + c) % 3 === 0;
    case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5: return (r * c) % 2 + (r * c) % 3 === 0;
    case 6: return ((r * c) % 2 + (r * c) % 3) % 2 === 0;
    default: return ((r + c) % 2 + (r * c) % 3) % 2 === 0;
  }
}

const G15 = (1 << 10) | (1 << 8) | (1 << 5) | (1 << 4) | (1 << 2) | (1 << 1) | 1;
const G15_MASK = (1 << 14) | (1 << 12) | (1 << 10) | (1 << 4) | (1 << 1);
const G18 = (1 << 12) | (1 << 11) | (1 << 10) | (1 << 9) | (1 << 8) | (1 << 5) | (1 << 2) | 1;

function formatBits(mask) {
  // EC level M = 0b00
  const data = (0 << 3) | mask;
  let d = data << 10;
  const g15Bits = bchDigit(G15);
  while (bchDigit(d) - g15Bits >= 0) d ^= G15 << (bchDigit(d) - g15Bits);
  return ((data << 10) | d) ^ G15_MASK;
}
function versionBits(version) {
  let d = version << 12;
  const g18Bits = bchDigit(G18);
  while (bchDigit(d) - g18Bits >= 0) d ^= G18 << (bchDigit(d) - g18Bits);
  return (version << 12) | d;
}

/* one full matrix build for a mask candidate; returns { mods, reserved } */
function buildMatrix(version, codewords, mask) {
  const size = sizeOf(version);
  const mods = new Uint8Array(size * size);
  const reserved = new Uint8Array(size * size);
  const set = (r, c, v) => { mods[r * size + c] = v; reserved[r * size + c] = 1; };

  // finder patterns + separators (three corners)
  for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) {
    const dark = (r >= 0 && r <= 6 && (c === 0 || c === 6)) || (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
      (r >= 2 && r <= 4 && c >= 2 && c <= 4);
    const put = (rr, cc) => { if (rr >= 0 && rr < size && cc >= 0 && cc < size) set(rr, cc, dark ? 1 : 0); };
    put(r, c); put(r, size - 1 - c); put(size - 1 - r, c);
  }
  // timing
  for (let i = 8; i < size - 8; i++) {
    if (i % 2 === 0) { set(6, i, 1); set(i, 6, 1); } else { set(6, i, 0); set(i, 6, 0); }
  }
  // alignment (skip the three corners that overlap finders)
  const pos = alignPositions(version);
  for (const r of pos) for (const c of pos) {
    if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) continue;
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
      set(r + dr, c + dc, dr === -2 || dr === 2 || dc === -2 || dc === 2 || (dr === 0 && dc === 0) ? 1 : 0);
    }
  }
  // dark module (always dark)
  set(size - 8, 8, 1);

  // dummy format (reserves the modules; replaced after masking)
  const writeFormat = bits => {
    for (let i = 0; i < 15; i++) {
      const bit = (bits >> i) & 1;
      if (i < 6) set(i, 8, bit);
      else if (i < 8) set(i + 1, 8, bit);
      else set(size - 15 + i, 8, bit);
      if (i < 8) set(8, size - i - 1, bit);
      else if (i < 9) set(8, 15 - i, bit);
      else set(8, 15 - i - 1, bit);
    }
  };
  writeFormat(formatBits(0));
  // version info (v>=7) — placed before the data, never masked
  if (version >= 7) {
    const bits = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const bit = (bits >> i) & 1;
      set(Math.floor(i / 3), i % 3 + size - 11, bit);
      set(i % 3 + size - 11, Math.floor(i / 3), bit);
    }
  }

  // data: zigzag over the two-column pairs, right to left, skipping column 6
  let inc = -1, row = size - 1, bitIndex = 7, byteIndex = 0;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (;;) {
      for (let c = 0; c < 2; c++) {
        const r = row, cc = col - c;
        if (cc < 0 || reserved[r * size + cc]) continue;
        const bit = byteIndex < codewords.length ? (codewords[byteIndex] >>> bitIndex) & 1 : 0;
        mods[r * size + cc] = bit;
        bitIndex--;
        if (bitIndex === -1) { byteIndex++; bitIndex = 7; }
      }
      row += inc;
      if (row < 0 || row >= size) { inc = -inc; row += inc; break; }
    }
  }
  // apply the candidate mask to the data region only
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) {
    if (!reserved[r * size + c] && maskAt(mask, r, c)) mods[r * size + c] ^= 1;
  }
  writeFormat(formatBits(mask));
  return mods;
}

function penalty(mods) {
  const size = mods.length ? Math.round(Math.sqrt(mods.length)) : 0;
  const at = (r, c) => mods[r * size + c];
  let points = 0;
  // N1: runs of >= 6 same-color (rows + columns)
  for (let r = 0; r < size; r++) for (let axis = 0; axis < 2; axis++) {
    let run = 1;
    for (let i = 1; i < size; i++) {
      const a = axis ? at(i, r) : at(r, i);
      const b = axis ? at(i - 1, r) : at(r, i - 1);
      if (a === b) run++;
      else {
        if (run >= 5) points += 3 + (run - 5);
        run = 1;
      }
    }
    if (run >= 5) points += 3 + (run - 5);
  }
  // N2: 2x2 blocks
  for (let r = 0; r < size - 1; r++) for (let c = 0; c < size - 1; c++) {
    const s = at(r, c) + at(r, c + 1) + at(r + 1, c) + at(r + 1, c + 1);
    if (s === 0 || s === 4) points += 3;
  }
  // N3: 1:1:3:1:1 with a 4-wide light run (scan 11-bit windows)
  for (let r = 0; r < size; r++) for (let axis = 0; axis < 2; axis++) {
    let bits = 0;
    for (let i = 0; i < size; i++) {
      bits = ((bits << 1) & 0x7FF) | (axis ? at(i, r) : at(r, i));
      if (i >= 10 && (bits === 0x5D0 || bits === 0x05D)) points += 40;
    }
  }
  // N4: dark proportion
  let dark = 0;
  for (let i = 0; i < mods.length; i++) dark += mods[i];
  points += Math.abs(Math.ceil(dark * 100 / mods.length / 5) - 10) * 10;
  return points;
}

/* the public API: encode → { version, size, mask, at(r,c) } */
export function qrEncodeMask(text, mask) {
  const bytes = new TextEncoder().encode(text);
  for (let version = 1; version <= 40; version++) {
    const cap = CW_TOTAL[version - 1] - M_EC[version - 1];
    const headerBytes = version <= 9 ? 2 : 3; // 12/20 header bits -> fits in this many bytes
    if (bytes.length + headerBytes > cap) continue;
    const codewords = makeCodewords(bytes, version);
    const mods = buildMatrix(version, codewords, mask);
    const size = sizeOf(version);
    return { version, size, mask, at: (r, c) => (mods[r * size + c] ? 1 : 0) };
  }
  throw new Error(`qr: data of ${bytes.length} bytes does not fit level-M v40`);
}
export function qrEncode(text) {
  const bytes = new TextEncoder().encode(text);
  for (let version = 1; version <= 40; version++) {
    const cap = CW_TOTAL[version - 1] - M_EC[version - 1];
    const headerBytes = version <= 9 ? 2 : 3; // 12/20 header bits -> fits in this many bytes
    if (bytes.length + headerBytes > cap) continue;
    const codewords = makeCodewords(bytes, version);
    let best = -1, bestScore = Infinity;
    const candidates = [];
    for (let m = 0; m < 8; m++) {
      const mods = buildMatrix(version, codewords, m);
      const score = penalty(mods);
      if (score < bestScore) { best = m; bestScore = score; }
      candidates.push(mods);
    }
    const mods = candidates[best];
    const size = sizeOf(version);
    return { version, size, mask: best, at: (r, c) => (mods[r * size + c] ? 1 : 0) };
  }
  throw new Error(`qr: data of ${bytes.length} bytes does not fit level-M v40`);
}

/* draw a QR code onto a 2D canvas (quiet zone 2 modules) */
export function drawQr(canvas, text) {
  const q = qrEncode(text);
  const scale = Math.max(3, Math.floor(320 / q.size));
  const px = (scale + 2) * q.size;
  canvas.width = px; canvas.height = px;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#f6ead2';
  ctx.fillRect(0, 0, px, px);
  ctx.fillStyle = '#22190f';
  for (let r = 0; r < q.size; r++) for (let c = 0; c < q.size; c++) {
    if (q.at(r, c)) ctx.fillRect((c + 2) * scale, (r + 2) * scale, scale, scale);
  }
}
