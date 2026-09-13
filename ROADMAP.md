# Microkarts roadmap

Phases 1–4 (core, 3D, engineering, polish) are complete — see git history.
Same rules apply to everything below: zero assets, deterministic sim,
headless-verified (`make sim` / `make netsim`), wire backward-compatible,
flat tracks stay flat.

## Current state

- 6 procedural tracks (3 flat, 3 elevated), day/night sky, fully synthesized audio
- Solo vs AI + 2-player WebRTC (QR pairing, `?join=` deep link), host-authoritative sim
- 3D elevation: slope speed, crest-launch, wheel-torque tipping, table fall + respawn
- Drift → boost → pads; sugar hazards; item boxes (turbo / timed rubber / wall)
- Ghost + top-5 rankings; results FX; reactive props; floor-hit explosion FX

## Phase 5 — Feel

- [x] **Reactive obstacles** ✅ (`src/track.js` `tickHazards`) — a fast kart in a
  hazard's radius squash-stretches + wobbles the candy (a decaying pulse, like the
  props); purely cosmetic, headless-safe, `make netsim` covers pulse/decay/slow-crawl
- [x] **Floor-hit explosion** ✅ (`src/explosion.js` + `audio.js` + `game.js` +
  `net2p.js`) — a kart that fell off an elevated track bursts on hitting the table:
  12 pooled particles + smoke + an expanding shockwave ring, plus a synthesized boom
  (lowpass thump + sub + crackle). Host/solo fire on the `fellOff` transition; the
  join client fires its own from the fellOff mirror and the remote's from the
  existing y f32 drop (no wire change). Pool saturates + fully decays; `make netsim`
  covers spawn/decay/saturation
- [x] **Perfect drift** ✅ (`src/kart.js` + `src/config.js` + `game.js` + `audio.js`) —
  releasing at the top of the charge curve (≥`PERFECT_CHARGE` = 94% of max) pays
  `PERFECT_BONUS` (0.3) boost on top of full — the decaying boost model handles >1
  without new state — plus a "PERFECT" callout + chime. The AI omits drift (unchanged);
  `make netsim` covers window/flag/bonus + early-release
- [x] **Corner deltas** ✅ (`src/corners.js` + `race.js` + `game.js` + `net2p.js`) —
  per-corner timing vs your session-best lap: the HUD flashes `+0.21` / `-0.04`
  as you clear each corner (corner = a curvature plateau in the samples, 5–9 per
  track). Per-kart in-corner time ticked in the shared sim body (client: on the
  interpolated mirror), banked on the lap edge. Pure local timing, no wire;
  `make netsim` covers the field/accumulation/close/bank-reset
- [x] **Gamepad support** ✅ (`src/gamepad.js` + `game.js`) — `navigator.getGamepads()`
  at boot: left stick steer, stick-down = gas / up = brake, LT or Y = drift
  (release = boost), RT or X = item (edge into the same `itemUseQ` as `E`), D-pad
  fallback. Pure `mapGamepad()` — a connected, active pad overrides
  keyboard/touch; browser wiring is guarded (no-op headless); `make netsim` tests
  the mapping with a fake pad
- [x] **Music reactivity** ✅ (`audio.js` + `game.js`) — a lowpass in the music
  bus opens from 1.5 kHz to 20 kHz with energy (0.55 · drift charge + 0.45 ·
  boost, fed every frame), plus off-beat arp notes above 0.5 energy, so a big
  release audibly "hits". Pure additive: at energy 0 the filter is at 20 kHz
  (transparent) and the reactive layer is silent — the song plays as before.
  Headless-safe; `make netsim` smoke-tests the setter

## Phase 6 — World

- [x] **Rain + puddles** ✅ (`src/weather.js` + `track.js` + `audio.js`) —
  procedural rain streaks (320-point field, generated texture) + a wet-road
  retint + a deterministic field of **puddle discs on flat sections** (seeded
  per track like pads; ripple when a kart passes) + dimmed lights + band-passed
  patter. Shipped as **purely cosmetic** — no grip penalty (that would change
  the sim; the flat-track invariant stays bit-identical). No wire; `make
  netsim` covers the puddle field + ripple lifecycle + headless toggle
- [x] **Two new tracks** — shipped as CANDY CAVERN (indoor neon: low dark
  ceiling + seeded crystal clusters + hanging candy) and STORM HARBOUR
  (overcast harbour: the table is a sea with bobbing buoys + a lighthouse
  with a rotating beacon; wind gusts nudge the AI). Each = data in
  `tracks.js` + a theme + `src/scenery.js` scenery; `make sim`/`netsim` run
  all 8 tracks, screens capture a cavern race.
- [x] **Daily challenge** — shipped as a DAILY CHALLENGE button (menu, RACE
  page): `src/daily.js` = `mulberry32(date int)` → track + hazards + items
  (the same UTC day always yields the same challenge, every boot; the button
  applies the config + selects the track through the normal picker). Follow-up
  for a future pass: re-seed the pad/hazard/prop fields from the day (seed =
  trackIdx ⊕ day) so the layout differs day-to-day on the same spline.

## Phase 7 — Beyond the race

- [x] **Replays** — shipped: the sim is 100% deterministic from inputs (all
  game RNG is seeded), so a replay is the player's recorded input stream
  re-fed to a fresh race on the same track + config (`src/replay.js`;
  REPLAY THIS RACE button on the results screen; memory-only, capped, no
  wire traffic). Follow-up: 0.5×/1×/2× playback speed + leader-chase
  camera.
  `make netsim` validates a record→replay determinism (bit-identical karts).
- [x] **Track editor** — shipped: 5th menu tab (EDIT, key `5`) — drag the
  current track's control points on a top-down canvas; live rebuild
  (corners/pads/puddles/scenery follow), RESET to factory points, RACE IT.
  Solo + session-only (`src/trackedit.js`). Follow-up: pad placement,
  localStorage save, share via a `?track=` deep link (base64, like the
  pairing code) + geometry validation.

## Phase 8 — Scale & polish

- [ ] **Instanced rendering** — curbs, pads, hazards and props merged into
  instanced meshes (one draw call each) + adaptive pixel ratio (drop to 0.75×
  on sustained <45 fps). No behaviour change: `make sim` byte-identical,
  `make screens` captures prove visual parity.
- [ ] **Item #4: sticky candy** — a box reward that leaves a slow patch
  behind the thrower for 2 s (the first kart through it loses grip, not
  speed — distinct from the wall). Same item-box economy (weighted roll),
  one more u8 value (old peers decode as ITEM_NONE… they'd see a blank slot,
  which is safe). `make netsim` covers the patch field + grip model.
- [ ] **Controller-free mobile polish** — on-screen drift/boost buttons with
  haptic pulses on charge milestones (already partially there — the auto-fire
  path), plus a 9:16 portrait layout pass for the chase camera.

## Deliberately not doing (for now)

- **3+ racers** — the state frame is sized for 2 karts; a real n-player mode
  is a protocol re-design, not an extension.
- **Asset-based content** — the zero-asset rule is a feature (instant load,
  no CDN); everything stays procedural.
- **Server backend / accounts** — localStorage + WebRTC stays the whole stack;
  rankings/ghost are local by design.
