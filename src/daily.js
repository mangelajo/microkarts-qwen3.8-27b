// Daily challenge: the same day (UTC) always yields the same track + setup.
// Pure + headless-safe: deterministic from the date int alone.
import { mulberry32 } from './obstacles.js';
import { TRACKS } from './tracks.js';

function fromInt(int) {
  const rng = mulberry32(int >>> 0);
  const track = Math.floor(rng() * TRACKS.length);
  const hazards = rng() > 0.25;
  const items = rng() > 0.25;
  return { track, hazards, items };
}

// date int: yyyymmdd (UTC)
export function dailyChallengeFor(int) {
  const y = Math.floor(int / 10000), m = Math.floor((int % 10000) / 100), d = int % 100;
  const t = fromInt(int);
  return {
    ...t,
    label: `DAILY ${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
    trackName: TRACKS[t.track].name,
  };
}

// today's (UTC) challenge
export function dailyChallenge(date = new Date()) {
  return dailyChallengeFor(date.getUTCFullYear() * 10000 + (date.getUTCMonth() + 1) * 100 + date.getUTCDate());
}
