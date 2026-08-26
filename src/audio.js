/*
 * All sound is synthesized live in WebAudio — keeps the no-assets policy.
 *  - engine + skid follow the player's speed / steering
 *  - small one-shot SFX (countdown, lap, crash, go)
 *  - chiptune background music, sequenced on the audio clock
 * Music and sfx run on separate buses so they can be muted independently;
 * the sfx bus also sits 2 dB below the music bus.
 * Audio is only created after a user gesture (browser autoplay policy).
 */

const BPM = 140;
const BEAT = 60 / BPM;        // sec per beat
const SIX = BEAT / 4;         // 16th note

/* A minor chiptune: Am — F — C — G, one chord per bar */
const CHORDS = [[12, 16, 19], [8, 12, 15], [24, 28, 31], [10, 14, 17]];
const ROOTS  = [45, 41, 36, 43]; // A1, F1, C1, G1 (midi)
const ARP = [0, 1, 2, 4, 0, 2, 1, 2, 0, 1, 2, 4, 2, 4, 2, 1];
const BASSP = [0, 0, 3, 4, 2, 0, 3, 2, 0, 0, 3, 4, 2, 0, 3, 2];
const midiHz = m => 440 * Math.pow(2, (m - 69) / 12);

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

export function startMusic() {
  if (!ctx || musicTimer) return;   // not created yet, or already playing
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

function scheduleStep(s, t, chord) {
  const midi = CHORDS[chord];
  if (s === 0 && chord > 0) noiseHit(ctx, t, 0.5, 0.12, 'highpass', 5000, 0.6, musicGain); // crash on bar change
  // driving 8th-note bass with offbeat pump
  if (s % 2 === 0) note(ctx, t, midiHz(ROOTS[chord] + BASSP[s]), BEAT * 0.45, 'square', s % 4 === 0 ? 0.15 : 0.09, musicGain);
  note(ctx, t, midiHz(60 + midi[0] + ARP[s]), SIX * 1.4, 'triangle', 0.08, musicGain);
  if (s % 4 === 2) note(ctx, t, midiHz(midi[2] + 24), SIX * 3, 'triangle', 0.05, musicGain);       // lead blip (chord 3rd, 2 oct up)
  if (s === 11 && chord % 2 === 1) note(ctx, t, midiHz(84 + midi[2]), SIX * 0.8, 'square', 0.05, musicGain); // sparkle on bars 2 & 4
  if (s % 4 === 0) note(ctx, t, 150, 0.13, 'sine', 0.55, musicGain, 42);                           // four-on-the-floor kick
  if (s === 4 || s === 12) noiseHit(ctx, t, 0.09, 0.2, 'highpass', 1600, 0.8, musicGain);          // snare
  if (s === 7) noiseHit(ctx, t, 0.05, 0.07, 'highpass', 2400, 1, musicGain);                       // ghost snare into beat 3
  if (s % 2 === 0) noiseHit(ctx, t, 0.03, s % 4 === 2 ? 0.07 : 0.045, 'highpass', 9000, 1, musicGain); // tight 8th hats
  else if (s % 4 === 3) noiseHit(ctx, t, 0.09, 0.05, 'highpass', 7500, 0.7, musicGain);            // open hat on the "and"
}

/* ---------------- engine + skid (continuous) ---------------- */
export function updateEngine(speed, steering, onRoad) {
  if (!ctx) return;
  const sp = Math.min(Math.abs(speed) / 30, 1);
  const gear = Math.floor(sp * 2.7 + 0.4);
  const inGear = sp * 2.7 + 0.4 - gear;       // 0..1 within the current "gear" — gives pitch steps
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
