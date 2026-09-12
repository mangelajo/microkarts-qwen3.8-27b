/* ------------------------------------------------------------------ *
 *  Track catalogue — pure data. Each entry:
 *    name     display name (menu + HUD)
 *    theme    palette key (see THEMES)
 *    points   closed Catmull-Rom control points, [x, y, z] triples, u units
 *             (y = elevation above the table; flat tracks use 0). Legacy
 *             [x, z] pairs are still accepted and read as y = 0.
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
  // late afternoon over a sugar canyon
  sunset: {
    fog: 0x2a1410,
    sky: [[0.00, 0x2b1a4a], [0.35, 0x6b3a6e], [0.62, 0xc06a5a], [0.82, 0xe89a58], [0.93, 0xf7c66a], [1.00, 0xfadda0]],
    wood: '#7a4a2e', road: 0x332e2c,
    light: { sun: 1.7, hemi: 0.9, fill: 0.4 },
  },
  // a space-table night: deep indigo, a magenta nebula on the horizon
  space: {
    fog: 0x0d0a1e,
    sky: [[0.00, 0x06041a], [0.35, 0x120d33], [0.62, 0x2b1a4d], [0.82, 0x4a2d6b], [0.93, 0x6b3d84], [1.00, 0x8a4d9e]],
    wood: '#2e2a3e', road: 0x2a2438,
    light: { sun: 1.1, hemi: 0.7, fill: 0.45 },
  },
};

export const TRACKS = [
  {
    name: 'BUTTERFINGO LOOP',
    theme: 'dusk',
    points: [
      [   0,    0,    0],
      [  38,    0,   -4],
      [  66,    0,    8],
      [  74,    0,   38],
      [  54,    0,   60],
      [  30,    0,   48],
      [  12,    0,   64],
      [ -12,    0,   48],
      [ -34,    0,   60],
      [ -62,    0,   46],
      [ -74,    0,   18],
      [ -56,    0,   -6],
      [ -28,    0,  -14],
    ],
  },
  {
    // long bottom straight, S-chicane into the top, tight hairpin on the left
    name: 'CANDY TANGLE',
    theme: 'candy',
    points: [
      [  -80,    0,  -55],
      [   -8,    0,  -60],
      [   55,    0,  -52],
      [   88,    0,  -30],
      [   92,    0,   10],
      [   62,    0,   30],
      [   30,    0,   10],
      [    2,    0,   34],
      [   34,    0,   56],
      [   62,    0,   62],
      [   74,    0,   34],
      [   66,    0,   -6],
      [   38,    0,  -18],
      [   -4,    0,  -14],
      [  -36,    0,   -2],
      [  -70,    0,   14],
      [  -86,    0,   44],
      [  -62,    0,   64],
      [  -32,    0,   56],
    ],
  },
  {
    // flowing teardrop: one long right-sweeping bank, a wide left bend
    name: 'MIDNIGHT TEARDROP',
    theme: 'midnight',
    points: [
      [  -70,    0,  -30],
      [  -30,    0,  -55],
      [   25,    0,  -58],
      [   65,    0,  -40],
      [   84,    0,   -5],
      [   70,    0,   32],
      [   40,    0,   50],
      [   -5,    0,   54],
      [  -50,    0,   40],
    ],
  },
  {
    // 3D: the old loop as a canyon — long climb to the far crest, then a
    // fast run back down over the start. Elevation 0..13.
    name: 'SUGAR CANYON',
    theme: 'sunset',
    points: [
      [    0,    0,    0],
      [   38,    1,   -4],
      [   66,    6,    8],
      [   74,   13,   38],
      [   54,    9,   60],
      [   30,    3,   48],
      [   12,    0,   64],
      [  -12,    1,   48],
      [  -34,    6,   60],
      [  -60,   12,   46],
      [  -74,    7,   18],
      [  -56,    2,   -6],
      [  -28,    0,  -14],
    ],
  },
  {
    // 3D: teardrop over a ridge — climb the right sweep up to the crest at
    // the top corner, then the long left bend runs back downhill. 0..15.
    name: 'MIDNIGHT RIDGE',
    theme: 'midnight',
    points: [
      [  -70,    0,  -30],
      [  -30,    3,  -55],
      [   25,    9,  -58],
      [   65,   15,  -40],
      [   84,   10,   -5],
      [   70,    4,   32],
      [   40,    1,   50],
      [   -5,    0,   54],
      [  -50,    0,   40],
    ],
  },
  {
    // flat: a swirl — the outer ring runs the table, two inner hooks cut
    // back through the middle (a fast loop with a slow, twisty heart).
    name: 'NEBULA SWIRL',
    theme: 'space',
    points: [
      [    0,    0,  -95],
      [   60,    0,  -70],
      [   95,    0,  -10],
      [   75,    0,   50],
      [   30,    0,   30],
      [   35,    0,   75],
      [  -10,    0,   92],
      [  -65,    0,   68],
      [  -95,    0,    5],
      [  -75,    0,  -40],
      [  -35,    0,  -30],
      [  -20,    0,  -75],
    ],
  },
];

export const trackTheme = def => THEMES[def.theme];
