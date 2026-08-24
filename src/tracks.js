/* ------------------------------------------------------------------ *
 *  Track catalogue — pure data. Each entry:
 *    name     display name (menu + HUD)
 *    theme    palette key (see THEMES)
 *    points   closed Catmull-Rom control points, [x, z] pairs, u units
 *
 *  All tracks share the same table (420u square, centred on the origin),
 *  so every loop stays comfortably within ±130 of x and z.
 *  AI is track-agnostic: it only reads samples/sampleHead/curvatureAt
 *  from track.js, rebuilt from these points on selection.
 * ------------------------------------------------------------------ */

const THEMES = {
  // the original dusk-on-the-family-table look; sky stops are [offset, hex]
  dusk: {
    fog: 0x180f0a,
    sky: [[0.00, 0x35598f], [0.35, 0x4f7cb4], [0.62, 0x7ba2cf], [0.82, 0xa7a99f], [0.93, 0xc99b5e], [1.00, 0xd9a25c]],
    wood: '#8a5a33', road: 0x2e2e33,
    light: { sun: 1.6, hemi: 0.85, fill: 0.35 },
  },
  // a candy-shop table after dark
  candy: {
    fog: 0x241019,
    sky: [[0.00, 0x53335f], [0.35, 0x77467c], [0.62, 0xa5659e], [0.82, 0xcf7f9f], [0.93, 0xf0a08c], [1.00, 0xf8c090]],
    wood: '#8a5568', road: 0x3a3040,
    light: { sun: 1.45, hemi: 0.8, fill: 0.45 },
  },
  // the same table, later at night
  midnight: {
    fog: 0x0a1013,
    sky: [[0.00, 0x0a1220], [0.35, 0x12233b], [0.62, 0x1d3a55], [0.82, 0x2d4a63], [0.93, 0x3f5a70], [1.00, 0x54718a]],
    wood: '#4e5a54', road: 0x262b30,
    light: { sun: 1.2, hemi: 0.6, fill: 0.3 },
  },
};

export const TRACKS = [
  {
    name: 'BUTTERFINGO LOOP',
    theme: 'dusk',
    points: [
      [   0,    0],
      [  38,   -4],
      [  66,    8],
      [  74,   38],
      [  54,   60],
      [  30,   48],
      [  12,   64],
      [ -12,   48],
      [ -34,   60],
      [ -62,   46],
      [ -74,   18],
      [ -56,   -6],
      [ -28,  -14],
    ],
  },
  {
    // long bottom straight, S-chicane into the top, tight hairpin on the left
    name: 'CANDY TANGLE',
    theme: 'candy',
    points: [
      [  -80,  -55],
      [   -8,  -60],
      [  55,  -52],
      [  88,  -30],
      [  92,   10],
      [  62,   30],
      [  30,   10],
      [   2,   34],
      [  34,   56],
      [  62,   62],
      [  74,   34],
      [  66,   -6],
      [  38,  -18],
      [  -4,  -14],
      [ -36,   -2],
      [ -70,   14],
      [ -86,   44],
      [ -62,   64],
      [ -32,   56],
    ],
  },
  {
    // flowing teardrop: one long right-sweeping bank, a wide left bend
    name: 'MIDNIGHT TEARDROP',
    theme: 'midnight',
    points: [
      [  -70,  -30],
      [  -30,  -55],
      [  25,  -58],
      [  65,  -40],
      [  84,   -5],
      [  70,   32],
      [  40,   50],
      [  -5,   54],
      [ -50,   40],
    ],
  },
];

export const trackTheme = def => THEMES[def.theme];
