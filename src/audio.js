/*
 * All sound is synthesized live in WebAudio — keeps the no-assets policy.
 *   - engine + skid follow the player's speed / steering
 *   - small one-shot SFX (countdown, lap, crash, go)
 *   - one chiptune per track (SONGS), sequenced on the audio clock
 * Music and sfx run on separate buses so they can be muted independently;
 * the sfx bus also sits 2 dB below the music bus.
 * Audio is only created after a user gesture (browser autoplay policy).
 */

const midiHz = m => 440 * Math.pow(2, (m - 69) / 12);

/* ------------------------------------------------------------------ *
 * One chiptune per track, indexed the same as TRACKS. Each song:
 *   bpm     tempo
 *   style   'drive' | 'pop' | 'wave' — swaps the drum programming
 *   chords  4 semitone stacks, one per bar (offsets off midi 60)
 *   roots   bass root (midi) per chord
 *   arp     16-step 16th-note arp over the bar's chord
 *   bassp   16-step bass offsets (used only where the style fires)
 *   lead    optional 16-step top line; semitones above the bar's
 *           chord root + leadBase (-1 = rest)
 * Feel:
 *   drive 140 BPM, Am–F–C–G    – four-on-the-floor energy
 *   pop   152 BPM, C–G–Am–F   – bouncy candy-shop major key
 *   wave  108 BPM, Dm–Bb–F–C  – slow dreamy synthwave
 * ------------------------------------------------------------------ */
const SONGS = [
  {
    name: 'BUTTERFINGO', bpm: 140, style: 'drive',
    chords: [[12, 16, 19], [8, 12, 15], [24, 28, 31], [10, 14, 17]],   // Am – F – C – G
    roots: [45, 41, 36, 43],
    arp:   [0, 1, 2, 4, 0, 2, 1, 2, 0, 1, 2, 4, 2, 4, 2, 1],
    bassp: [0, 0, 3, 4, 2, 0, 3, 2, 0, 0, 3, 4, 2, 0, 3, 2],
    crash: true,
  },
  {
    name: 'CANDY TANGLE', bpm: 152, style: 'pop',
    chords: [[0, 4, 7], [7, 11, 14], [0, 3, 7], [0, 4, 7]],            // C – G – Am – F
    roots: [36, 43, 45, 41],
    arp:   [0, 4, 7, 12, 4, 7, 12, 16, 7, 4, 7, 12, 0, 4, 7, 12],    // rising, bouncy
    bassp: [0, 0, 0, 0, 7, 0, 0, 4, 0, 0, 0, 0, 4, 0, 7, 0],        // back-beat stabs
    lead:  [16, -1, -1, 12, -1, 7, -1, 12, 16, 12, -1, 7, 7, -1, 12, -1],
    leadBase: 24, leadDur: 1.8,
  },
  {
    name: 'MIDNIGHT TEARDROP', bpm: 108, style: 'wave',
    chords: [[0, 3, 7], [0, 4, 7], [0, 4, 7], [0, 4, 7]],             // Dm – Bb – F – C
    roots: [38, 46, 41, 36],
    arp:   [0, 3, 7, 3, 12, 7, 3, 0, 7, 12, 15, 12, 3, 7, 3, 0],    // rolling thirds
    bassp: [0, 0, 3, 0, 0, 0, 4, 0, 0, 0, 5, 0, 0, 0, 7, 0],        // slow pumping 8ths
    lead:  [0, -1, 3, -1, 7, 12, 10, -1, 12, -1, 7, -1, 16, 12, 7, 3], // sustained saw
    leadType: 'sawtooth', leadDur: 3,
  },
];

let song = SONGS[0];
let BEAT, SIX; // re-derived in startMusic, per song

let ctx, master, musicGain, sfxGain, engGain, engFilter, engOsc = [], skidGain, skidSrc;
let noiseBuf;
const SFX_GAIN = Math.pow(10, -2 / 20); // sfx bus level when enabled (-2 dB)
let musicMuted = false, sfxMuted = false;
let musicTimer = 0, nextNote = 0, step = 0;

function noise(a) {
  if (!noiseBuf) {
    noiseBuf = a.createBuffer(1, Math.floor(a.sampleRate * 1.5), a.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const s = a.createBufferSource();
  s.buffer = noiseBuf; s.loop = true;
  return s;
}

/** must be called from a user gesture (start button / keydown); also builds the engine bed */
export function ensureAudio() {
  if (ctx) return;
  ctx = new (window.AudioContext || window.webkitAudioContext());
  master = ctx.createGain();
  master.gain.value = 0.7;
  master.connect(ctx.destination);
  // separate buses so music and sfx can be muted independently
  musicGain = ctx.createGain(); musicGain.gain.value = musicMuted ? 0 : 1;
  musicGain.connect(master);
  sfxGain = ctx.createGain(); sfxGain.gain.value = sfxMuted ? 0 : SFX_GAIN;
  sfxGain.connect(master);
  buildEngine();
  // resume can fail silently if the gesture chain is odd — just no sound
  if (ctx.state !== 'running') ctx.resume();
}

function applyBusMute() {
  if (!ctx) return;
  const t = ctx.currentTime;
  musicGain.gain.setTargetAtTime(musicMuted ? 0 : 1, t, 0.02);
  sfxGain.gain.setTargetAtTime(sfxMuted ? 0 : SFX_GAIN, t, 0.02);
}

export function isMusicMuted() { return musicMuted; }
export function isSfxMuted() { return sfxMuted; }

export function toggleMusicMute() {
  musicMuted = !musicMuted;
  try { localStorage.setItem('mkr-music', musicMuted ? '1' : ''); } catch { /* private mode */ }
  applyBusMute();
  return musicMuted;
}

export function toggleSfxMute() {
  sfxMuted = !sfxMuted;
  try { localStorage.setItem('mkr-sfx', sfxMuted ? '1' : ''); } catch { /* private mode */ }
  applyBusMute();
  return sfxMuted;
}

export function setMusicMuted(m) { if (m !== musicMuted) toggleMusicMute(); }
export function setSfxMuted(m) { if (m !== sfxMuted) toggleSfxMute(); }

/** start the chiptune that matches this track (index into TRACKS / SONGS) */
export function startMusic(trackIdx = 0) {
  if (!ctx || musicTimer) return;    // not created yet, or already playing
  song = SONGS[trackIdx] || SONGS[0];
  BEAT = 60 / song.bpm; SIX = BEAT / 4;
  step = 0;
  nextNote = ctx.currentTime + 0.08;
  musicTimer = setInterval(() => {
    try {
      while (nextNote < ctx.currentTime + 0.22) {
        scheduleStep(step & 15, nextNote, (step >> 4) % 4);
        nextNote += SIX;
        step++;
      }
    } catch (e) {
      // a scheduling hiccup shouldn't kill the music forever
      console.warn('audio scheduler hiccup', e);
    }
  }, 50);
}

export function stopMusicTimer() {
  clearInterval(musicTimer);
  musicTimer = 0;
}

/* ---------------- sequencer voices ---------------- */
function note(a, t, f, dur, type, vol, dest, glide = 0) {
  if (!a) return;
  const o = a.createOscillator(), gn = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f, t);
  if (glide) o.frequency.linearRampToValueAtTime(glide, t + dur * 0.75);
  gn.gain.setValueAtTime(vol, t);
  gn.gain.exponentialRampToValueAtTime(0.0008, t + dur);
  o.connect(gn).connect(dest || master);
  o.start(t); o.stop(t + dur + 0.02);
}
function noiseHit(a, t, dur, vol, type, freq, q = 1, dest) {
  if (!a) return;
  const s = noise(a);
  const f = a.createBiquadFilter();
  f.type = type; f.frequency.value = freq; f.Q.value = q;
  const gn = a.createGain();
  gn.gain.setValueAtTime(vol, t);
  gn.gain.exponentialRampToValueAtTime(0.0008, t + dur);
  s.connect(f).connect(gn).connect(dest || sfxGain);
  s.start(t); s.stop(t + dur + 0.02);
}

const POP_KICK = new Set([0, 6, 8, 14]); // syncopated: 1, "and-of-2", 3, "and-of-4"

function scheduleStep(s, t, chord) {
  const midi = song.chords[chord];
  const root = song.roots[chord];
  if (song.crash && s === 0 && chord > 0) noiseHit(ctx, t, 0.5, 0.12, 'highpass', 5000, 0.6, musicGain); // crash on bar change

  // bass, per style
  if (song.style === 'drive') {
    if (s % 2 === 0) note(ctx, t, midiHz(root + song.bassp[s]), BEAT * 0.45, 'square', s % 4 === 0 ? 0.15 : 0.09, musicGain); // 8th-note pump
  } else if (song.style === 'pop') {
    if (s % 4 === 0 || s === 14) note(ctx, t, midiHz(root + song.bassp[s]), BEAT * 0.42, 'square', s % 4 === 0 ? 0.15 : 0.1, musicGain); // bouncy stabs
  } else {
    if (s % 2 === 0) note(ctx, t, midiHz(root + song.bassp[s]), BEAT * 0.9, 'triangle', s % 4 === 0 ? 0.12 : 0.06, musicGain); // synthwave throb
  }

  // arp shimmer — kept in every style
  note(ctx, t, midiHz(60 + midi[0] + song.arp[s]), SIX * 1.4, 'triangle', 0.08, musicGain);

  // lead top-line
  if (song.style === 'drive') {
    if (s % 4 === 2) note(ctx, t, midiHz(midi[2] + 24), SIX * 3, 'triangle', 0.05, musicGain);              // lead blip (chord 3rd, 2 oct up)
    if (s === 11 && chord % 2 === 1) note(ctx, t, midiHz(84 + midi[2]), SIX * 0.8, 'square', 0.05, musicGain); // sparkle on bars 2 & 4
  } else {
    const le = song.lead[s];
    if (le >= 0) note(ctx, t, midiHz(60 + root + (song.leadBase || 0) + le), SIX * (song.leadDur || 2), song.leadType || 'square', 0.05, musicGain);
  }

  // drums, per style
  if (song.style === 'pop') {
    if (POP_KICK.has(s)) note(ctx, t, 150, 0.13, 'sine', 0.55, musicGain, 42);
  } else {
    if (s % 4 === 0) note(ctx, t, 150, 0.13, 'sine', song.style === 'wave' ? 0.45 : 0.55, musicGain, 42); // four-on-the-floor
  }
  if (s === 4 || s === 12) noiseHit(ctx, t, 0.09, 0.2, 'highpass', 1600, 0.8, musicGain);   // snare
  if (song.style === 'drive') {
    if (s === 7) noiseHit(ctx, t, 0.05, 0.07, 'highpass', 2400, 1, musicGain);              // ghost snare into beat 3
    if (s % 2 === 0) noiseHit(ctx, t, 0.03, s % 4 === 2 ? 0.07 : 0.045, 'highpass', 9000, 1, musicGain); // tight 8th hats
    else if (s % 4 === 3) noiseHit(ctx, t, 0.09, 0.05, 'highpass', 7500, 0.7, musicGain);   // open hat on the "and"
  } else {
    // 16th hats: busy on pop, whisper on the wave
    const vol = s % 2 === 1 ? (song.style === 'pop' ? 0.035 : 0.015) : 0.04;
    noiseHit(ctx, t, 0.03, vol, 'highpass', 8500, 0.7, musicGain);
  }
}

/* ---------------- engine + skid (continuous) ---------------- */
export function updateEngine(speed, steering, onRoad) {
  if (!ctx) return;
  const sp = Math.min(Math.abs(speed) / 30, 1);
  const gear = Math.floor(sp * 2.7 + 0.4);
  const inGear = sp * 2.7 + 0.4 - gear;        // 0..1 within the current "gear" — gives pitch steps
  const t = ctx.currentTime;
  // pitch: low idle rumble -> high rev, with a gear-like sawtooth step
  const f = (58 + 320 * inGear) * (0.75 + 0.55 * (gear / 3));
  for (const o of engOsc) {
    o.frequency.setTargetAtTime(o.g === 1 ? f : f / 2, t, 0.03);
  }
  engFilter.frequency.setTargetAtTime(320 + 2400 * sp, t, 0.05);
  engGain.gain.setTargetAtTime(speed === 0 ? 0.03 : 0.10 + 0.13 * sp, t, 0.06);
  // skid: hard steering above speed
  const skidT = (onRoad && sp > 0.35 ? (Math.abs(steering) - 0.55) * 1.0 : 0);
  skidGain.gain.setTargetAtTime(Math.max(0, Math.min(0.22, skidT)), t, 0.04);
}

function buildEngine() {
  engFilter = ctx.createBiquadFilter();
  engFilter.type = 'lowpass';
  engFilter.frequency.value = 400;
  engGain = ctx.createGain();
  engGain.gain.value = 0;
  engFilter.connect(engGain).connect(sfxGain);
  for (const g of [1, 0.5]) {
    const o = ctx.createOscillator();
    o.type = g === 1 ? 'sawtooth' : 'triangle';
    o.g = g;
    o.frequency.value = 70;
    o.connect(engFilter);
    o.start();
    engOsc.push(o);
  }
  skidSrc = noise(ctx);
  const sf = ctx.createBiquadFilter();
  sf.type = 'bandpass'; sf.frequency.value = 950; sf.Q.value = 0.9;
  skidGain = ctx.createGain();
  skidGain.gain.value = 0;
  skidSrc.connect(sf).connect(skidGain).connect(sfxGain);
  skidSrc.start();
}

/* ---------------- one-shot SFX ---------------- */
export function beep(freq) {
  if (!ctx) return;
  const t = ctx.currentTime;
  note(ctx, t, freq, 0.16, 'square', 0.16, sfxGain);
  noiseHit(ctx, t, 0.06, 0.05, 'highpass', 4000, 0.7);
}

export function go() {
  if (!ctx) return;
  beep(880);
  note(ctx, ctx.currentTime + 0.16, 880, 0.3, 'square', 0.16, sfxGain);
}

export function crash(intensity) {
  if (!ctx) return;
  const t = ctx.currentTime;
  noiseHit(ctx, t, 0.14, 0.28 * intensity, 'bandpass', 280, 0.7);
  note(ctx, t, 120, 0.18, 'sine', 0.3 * intensity, sfxGain, 38);
}

export function lap() {
  if (!ctx) return;
  const t = ctx.currentTime;
  note(ctx, t, 660, 0.1, 'square', 0.14, sfxGain);
  note(ctx, t + 0.1, 990, 0.16, 'square', 0.14, sfxGain);
}
