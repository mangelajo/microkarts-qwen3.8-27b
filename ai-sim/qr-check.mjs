// qr-check.mjs — headless verification of src/qr.js (the 2P pairing QR encoder).
//
// Three layers, reference-free:
//   1. spec structure — size, finder/separator/timing geometry, alignment
//      patterns, format region (Hamming ≤ 3 of the M-level code), version
//      region (exact 18-bit match for v≥7);
//   2. full Reed-Solomon decode — read the zigzag codewords, un-interleave
//      the block structure, and require every block's RS syndrome to be
//      zero (any generator-polynomial / interleave / padding bug breaks
//      this);
//   3. known-matrix fixture — the v1 '!' payload must reproduce an exact
//      441-bit matrix (guards against silent table drift).
//
// Spec tables below were extracted from ISO/IEC 18004 (via the reference
// `qrcode` package). The always-dark module (8, 4v+10) is NOT asserted: the
// reference implementation omits it and our parity target is that output.
//
// Self-contained: imports only src/ (qr.js is pure, no DOM).
import { qrEncode, qrEncodeMask } from '../src/qr.js';

let fails = 0;
const check = (name, ok, detail = '') => {
  if (!ok) { fails++; console.error('FAIL  ' + name + (detail ? ' — ' + detail : '')); }
  else console.log('OK    ' + name);
};

/* ---------------- spec data (ISO 18004) ---------------- */
const SIZE = v => 17 + 4 * v;

// M-level: total codewords, block count, total EC codewords — v1..v40
const CW_TOTAL = [26, 44, 70, 100, 134, 172, 196, 242, 292, 346, 404, 466, 532, 581, 655, 733, 815, 901, 991, 1085, 1156, 1258, 1364, 1474, 1588, 1706, 1828, 1921, 2051, 2185, 2323, 2465, 2611, 2761, 2876, 3034, 3196, 3362, 3532, 3706];
const M_BLOCKS = [1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49];
const M_EC = [10, 16, 26, 36, 48, 64, 72, 88, 110, 130, 150, 176, 198, 216, 240, 280, 308, 338, 364, 416, 442, 476, 504, 560, 588, 644, 700, 728, 784, 812, 868, 924, 980, 1036, 1064, 1120, 1204, 1260, 1316, 1372];

// 15-bit format codes for level M, masks 0..7
const FMT_M = [21522, 20773, 24188, 23371, 17913, 16590, 20375, 19104];

// 18-bit version codes, v7..v40
const VER18 = { 7: 31892, 8: 34236, 9: 39577, 10: 42195, 11: 48118, 12: 51042, 13: 55367, 14: 58893, 15: 63784, 16: 68472, 17: 70749, 18: 76311, 19: 79154, 20: 84390, 21: 87683, 22: 92361, 23: 96236, 24: 102084, 25: 102881, 26: 110507, 27: 110734, 28: 117786, 29: 119615, 30: 126325, 31: 127568, 32: 133589, 33: 136944, 34: 141498, 35: 145311, 36: 150283, 37: 152622, 38: 158308, 39: 161089, 40: 167017 };

/* same alignment-position algorithm as src/qr.js */
function alignPositions(version) {
  if (version === 1) return [];
  const posCount = Math.floor(version / 7) + 2;
  const size = SIZE(version);
  const intervals = size === 145 ? 26 : Math.ceil((size - 13) / (2 * posCount - 2)) * 2;
  const positions = [size - 7];
  for (let i = 1; i < posCount - 1; i++) positions[i] = positions[i - 1] - intervals;
  positions.push(6);
  return positions.reverse();
}

/* ---------------- helpers ---------------- */
const hamming15 = (a, b) => { let h = 0; for (let i = 0; i < 15; i++) h += ((a >> i) ^ (b >> i)) & 1; return h; };

/* 7x7 finder at (r0, c0) + the in-matrix white separator ring */
function checkFinder(q, r0, c0, R) {
  const P = [
    1, 1, 1, 1, 1, 1, 1, 0,
    1, 0, 0, 0, 0, 0, 1, 0,
    1, 0, 1, 1, 1, 0, 1, 0,
    1, 0, 1, 1, 1, 0, 1, 0,
    1, 0, 1, 1, 1, 0, 1, 0,
    1, 0, 0, 0, 0, 0, 1, 0,
    1, 1, 1, 1, 1, 1, 1, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
  ];
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    if (r0 + r >= R || c0 + c >= R) continue; // separator side outside the matrix
    if (q.at(r0 + r, c0 + c) !== P[r * 8 + c]) return false;
  }
  return true;
}

/* the 5x5 alignment pattern: dark ring, light 3x3 inside, dark center */
function checkAlignment(q, r, c) {
  for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
    const m = (Math.abs(dr) === 2 || Math.abs(dc) === 2 || (dr === 0 && dc === 0)) ? 1 : 0;
    if (q.at(r + dr, c + dc) !== m) return false;
  }
  return true;
}

/* 15-bit format region, both copies — the reference's exact placement order:
   bit i at (i<6 ? i : i<8 ? i+1 : R-15+i, 8) [vertical copy] and at
   (8, i<8 ? R-i-1 : i===8 ? 7 : 14-i) [horizontal copy] */
function formatBits(q, R) {
  let a = 0, b = 0;
  for (let i = 0; i < 15; i++) {
    const vr = i < 6 ? i : i < 8 ? i + 1 : R - 15 + i;
    a |= q.at(vr, 8) << i;
    const hc = i < 8 ? R - i - 1 : i === 8 ? 7 : 14 - i;
    b |= q.at(8, hc) << i;
  }
  return { a, b };
}

/* 18-bit version region, both copies — jsqr's exact read order
   (the decoder ground truth): top-right rows 5..0 x cols R-9..R-11,
   bottom-left cols 5..0 x rows R-9..R-11, LSB-first */
function versionBits(q, R) {
  let a = 0, b = 0;
  for (let y = 5; y >= 0; y--)
    for (let x = R - 9; x >= R - 11; x--) a = (a << 1) | q.at(y, x);
  for (let x = 5; x >= 0; x--)
    for (let y = R - 9; y >= R - 11; y--) b = (b << 1) | q.at(y, x);
  return { a, b };
}

/* build the reserved (function-module) set exactly as the encoder does,
   so the zigzag reader can skip the same cells the writer skips */
function reservedSet(v, R) {
  const res = new Set();
  const put = (r, c) => { if (r >= 0 && r < R && c >= 0 && c < R) res.add(r * R + c); };
  for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) {
    put(r, c); put(r, R - 1 - c); put(R - 1 - r, c);
  }
  for (let i = 8; i < R - 8; i++) { put(6, i); put(i, 6); }
  const pos = alignPositions(v);
  if (v >= 2) {
    // the encoder iterates pos x pos with the three finder-overlap skips
    for (const r of pos) for (const c of pos) {
      if ((r === 6 && c === 6) || (r === 6 && c === R - 7) || (r === R - 7 && c === 6)) continue;
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) put(r + dr, c + dc);
    }
  }
  put(R - 8, 8); // dark module
  // format (dummy placement reserves the same cells as the final write)
  for (let i = 0; i < 15; i++) {
    if (i < 6) put(i, 8);
    else if (i < 8) put(i + 1, 8);
    else put(R - 15 + i, 8);
    if (i < 8) put(8, R - i - 1);
    else if (i < 9) put(8, 15 - i);
    else put(8, 15 - i - 1);
  }
  if (v >= 7) {
    for (let i = 0; i < 18; i++) {
      put(Math.floor(i / 3), (i % 3) + R - 11);
      put((i % 3) + R - 11, Math.floor(i / 3));
    }
  }
  return res;
}

/* the eight spec mask conditions (reader must unmask data cells) */
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

/* ---------------- layer 1+2: structural + RS decode ---------------- */
function verifyMatrix(q, label) {
  const v = q.version, R = q.size, mask = q.mask;
  const detail = (x) => `${label}: ${x}`;
  check(`size v${v}`, R === SIZE(v), detail(`R=${R} expected ${SIZE(v)}`));

  check('finder TL', checkFinder(q, 0, 0, R));
  check('finder TR', checkFinder(q, 0, R - 7, R));
  check('finder BL', checkFinder(q, R - 7, 0, R));

  let timing = true;
  for (let i = 8; i <= R - 9; i++) {
    if (q.at(6, i) !== (i % 2 === 0 ? 1 : 0)) timing = false;
    if (q.at(i, 6) !== (i % 2 === 0 ? 1 : 0)) timing = false;
  }
  check('timing', timing, detail('row/col 6 not alternating'));

  if (v >= 2) {
    check('dark module', q.at(R - 8, 8) === 1, detail('(R-8, 8) not dark'));
  }

  if (v >= 2) {
    const pos = alignPositions(v);
    let ok = true;
    for (const r of pos) for (const c of pos) {
      if ((r === 6 && c === 6) || (r === 6 && c === R - 7) || (r === R - 7 && c === 6)) continue;
      if (!checkAlignment(q, r, c)) ok = false;
    }
    check('alignment x' + (pos.length * pos.length - 3), ok, detail('bad 5x5 pattern'));
  }

  const fb = formatBits(q, R);
  const expected = FMT_M[mask];
  check('format copy1', hamming15(fb.a, expected) <= 3, detail(`got 0x${fb.a.toString(16)} want 0x${expected.toString(16)}`));
  check('format copy2', hamming15(fb.b, expected) <= 3, detail(`got 0x${fb.b.toString(16)} want 0x${expected.toString(16)}`));

  if (v >= 7) {
    const vb = versionBits(q, R);
    check('version copy1', vb.a === VER18[v], detail(`got 0x${vb.a.toString(16)} want 0x${VER18[v].toString(16)}`));
    check('version copy2', vb.b === VER18[v], detail(`got 0x${vb.b.toString(16)} want 0x${VER18[v].toString(16)}`));
  }

  /* ---- layer 2: read the data zigzag, un-interleave, RS syndrome ---- */
  const vIdx = v - 1;
  const blocks = M_BLOCKS[vIdx], ecTotal = M_EC[vIdx], cwTotal = CW_TOTAL[vIdx];
  const dataTotal = cwTotal - ecTotal;
  const g2 = cwTotal % blocks;
  const d1 = Math.floor(dataTotal / blocks);
  const d2 = d1 + 1;
  const ecCount = Math.floor(cwTotal / blocks) - d1;
  const dataLens = [];
  for (let b = 0; b < blocks; b++) dataLens.push(b < blocks - g2 ? d1 : d2);

  // zigzag read (spec): rightmost two-column pairs, skip col 6, up/down;
  // reserved (function) cells are skipped exactly as the writer skips them;
  // data cells are UNMASKED (the matrix holds masked data)
  const res = reservedSet(v, R);
  const bits = [];
  let inc = -1, row = R - 1;
  for (let col = R - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (;;) {
      for (let c = 0; c < 2; c++) {
        const r = row, cc = col - c;
        if (cc < 0 || res.has(r * R + cc)) continue;
        bits.push(q.at(r, cc) ^ (maskAt(mask, r, cc) ? 1 : 0));
      }
      row += inc;
      if (row < 0 || row >= R) { inc = -inc; row += inc; break; }
    }
  }
  const cw = [];
  for (let i = 0; i < cwTotal; i++) {
    let byte = 0;
    for (let b = 0; b < 8; b++) byte = (byte << 1) | bits[i * 8 + b];
    cw.push(byte);
  }

  // un-interleave: data rows first (i over maxData), then EC rows (i over ecCount)
  const dBlocks = Array.from({ length: blocks }, () => []);
  const eBlocks = Array.from({ length: blocks }, () => []);
  let idx = 0;
  const maxD = Math.max(d2, d1);
  for (let i = 0; i < maxD; i++)
    for (let b = 0; b < blocks; b++)
      if (i < dataLens[b]) dBlocks[b].push(cw[idx++]);
  for (let i = 0; i < ecCount; i++)
    for (let b = 0; b < blocks; b++) eBlocks[b].push(cw[idx++]);
  if (idx !== cwTotal) {
    check('un-interleave length', false, detail(`idx=${idx} expected ${cwTotal}`));
    return;
  }

  // RS syndrome: each (data || ec) block must be 0 mod the generator
  const GEXP = new Uint8Array(256), GLOG = new Uint8Array(256);
  let x = 1;
  for (let i = 0; i < 255; i++) { GEXP[i] = x; GLOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11D; }
  const gmul = (a, b) => (a && b) ? GEXP[(GLOG[a] + GLOG[b]) % 255] : 0;
  // generator = prod_{i=0}^{ecCount-1} (x - alpha^i), coefficients highest-first
  let gen = [1];
  for (let i = 0; i < ecCount; i++) {
    const next = new Array(gen.length + 1).fill(0);
    for (let j = 0; j < gen.length; j++) {
      next[j] ^= gen[j];                       // - alpha^i * x^j
      next[j + 1] ^= gmul(gen[j], GEXP[i]);
    }
    gen = next;
  }
  let allZero = true, badBlock = -1;
  for (let b = 0; b < blocks; b++) {
    const block = dBlocks[b].concat(eBlocks[b]);
    // synthetic division: block (degree d1+d2... d+ecCount) mod gen
    let rem = [...block, ...new Array(gen.length - 1).fill(0)];
    for (let i = 0; i < block.length; i++) {
      const coef = rem[i];
      if (!coef) continue;
      for (let j = 1; j < gen.length; j++) rem[i + j] ^= gmul(gen[j], coef);
    }
    const tail = rem.slice(block.length);
    if (tail.some(t => t !== 0) && badBlock === -1) { badBlock = b; }
    if (tail.some(t => t !== 0)) allZero = false;
  }
  check(`RS syndrome x${blocks}`, allZero, badBlock >= 0 ? detail(`block ${badBlock} nonzero remainder`) : '');
}

/* ---------------- the test matrix ---------------- */
// payloads: (payload, expected version) — spans v1, v4, v13, v18, v22, v34, v40
const CASES = [
  ['!', 1],
  ['a'.repeat(56) + '!!!!', 4],
  ['a'.repeat(300) + '!!!!', 13],
  ['a'.repeat(700) + '!!!!', 21],
  ['a'.repeat(1200) + '!!!!', 29],
  ['a'.repeat(1700) + '!!!!', 34],
  ['a'.repeat(2322) + '!!!!', 40],
];
for (const [s, expV] of CASES) {
  const q = qrEncode(s);
  check(`version select (${s.length}B)`, q.version === expV, `got v${q.version}`);
  verifyMatrix(q, `v${q.version}`);
}

// forced-mask parity: every mask must decode structurally (all 8, on one payload)
for (const mask of [0, 1, 2, 3, 4, 5, 6, 7]) {
  const q = qrEncodeMask('a'.repeat(300) + '!!!!', mask);
  verifyMatrix(q, `v${q.version}/mask${mask}`);
}

// over-capacity must throw
try {
  qrEncode('a'.repeat(3000));
  check('over-capacity throws', false, 'no throw');
} catch {
  check('over-capacity throws', true);
}

/* ---------------- layer 3: known-matrix fixture ---------------- */
// v1, payload '!', mask 0: the exact 441-bit matrix (row-major).
// Guards against silent spec-table drift (the failure mode that made the
// encoder look valid while producing undecodable QRs).
const FIX_B64 = Buffer.from('MTExMTExMTAwMDExMDAxMTExMTExMTAwMDAwMTAxMDAwMTAxMDAwMDAxMTAxMTEwMTAwMTAwMTAxMDExMTAxMTAxMTEwMTAwMDAwMTAxMDExMTAxMTAxMTEwMTAxMDAwMTAxMDExMTAxMTAwMDAwMTAwMDAwMTAxMDAwMDAxMTExMTExMTAxMDEwMTAxMTExMTExMDAwMDAwMDAwMDExMTAwMDAwMDAwMTAxMDEwMTAwMDExMDAwMDEwMDEwMTAxMTEwMDEwMDEwMDAxMDAwMTEwMTAxMTAxMTExMDEwMTAwMDEwMDAxMDExMTAxMDAxMTEwMDAxMDAwMTAwMDAwMTAxMTExMTAwMTAxMDEwMTAxMDAwMDAwMDAxMDExMDEwMTAxMDExMTExMTExMTAwMTAxMDExMTAxMTAxMTAwMDAwMTAwMDExMTEwMTExMDAwMTAxMTEwMTAxMTExMDExMTAxMTAxMTAxMTEwMTAwMDAwMDAxMDAwMTEwMTAxMTEwMTAxMDEwMTAwMDEwMDAxMTAwMDAwMTAwMTEwMDAxMDAwMTEwMTExMTExMTAxMTEwMTAxMDEwMTEx', 'base64').toString('utf8');
const fx = qrEncodeMask('!', 0);
check('fixture size', fx.size === 21 && fx.mask === 0, `size=${fx.size} mask=${fx.mask}`);
let bits = '';
for (let r = 0; r < 21; r++) for (let c = 0; c < 21; c++) bits += fx.at(r, c);
let fixDetail = '';
if (bits !== FIX_B64) {
  for (let i = 0; i < Math.min(bits.length, FIX_B64.length); i++)
    if (bits[i] !== FIX_B64[i]) { fixDetail = `first diff at bit ${i}`; break; }
  if (!fixDetail) fixDetail = `length ${bits.length} vs ${FIX_B64.length}`;
}
check('fixture matrix exact', bits === FIX_B64, fixDetail);

/* ---------------- result ---------------- */
if (fails) {
  console.error(`\nqr-check: ${fails} FAILURE(S)`);
  process.exit(1);
}
console.log('\nqr-check: ALL PASS');
