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
- [ ] **Perfect drift** — releasing the drift in a short window (the top of the
  charge curve) pays extra boost + a "PERFECT" callout + chime. The window is a
  constant around `DRIFT_CHARGE_MAX`; the bonus scales the release charge.
  `make sim` asserts the window/bonus; flat tracks unchanged (it only adds boost
  currency, which exists today).
- [ ] **Corner deltas** — per-corner timing vs your session-best lap: the HUD
  flashes `+0.21` / `-0.04` as you clear each corner (corner = a curvature
  plateau in the samples, indexed the same way the AI reads it). Pure local
  timing, no wire; results screen gains a per-corner breakdown.
- [ ] **Gamepad support** — `navigator.getGamepads()`: left stick steer/throttle,
  right stick / triggers for drift + item, connected at boot with the same
  input struct the keyboard path feeds. Headless check: a fake gamepad object
  through the input reader; `make screens` adds a gamepad-icon state.
- [ ] **Music reactivity** — the per-track chiptune gains a second layer
  (arpeggio density + filter opening) driven by drift charge and boost, so a
  big release audibly "hits". `audio.js` only; headless: assert the layer
  gain tracks the charge curve with fake karts.

## Phase 6 — World

- [ ] **Rain + puddles** — procedural rain (line-segment pool, no assets) on
  the two coastal/midnight themes, plus a deterministic field of wet patches
  (seeded per track like pads): grip/speed penalty inside a patch. The patch
  field rides the track index (never streamed — old peers just see dry).
  `make sim` gets the grip-penalty scenario; flat tracks stay bit-identical
  when the field is empty.
- [ ] **Two new tracks** — CANDY CAVERN (indoor, neon glow, low ceiling props,
  a new "cavern" theme) and STORM HARBOUR (coastal, fog + the rain above,
  long straight for the wall item). Each = data in `tracks.js` + a theme +
  bench coverage; `make sim`/`netsim`/`screens` grow by 2 tracks.
- [ ] **Daily challenge** — "today's track" chip: a date hash picks the track
  AND re-seeds the pad/hazard/prop fields (seed = trackIdx ⊕ day), so the
  layout, hazards and boost field differ day-to-day on the same spline.
  Headless: assert the seed changes the pad layout and the date mapping is
  stable; wire note: the track frame already carries the track idx — the day
  seed is computed locally from the date (no protocol change).

## Phase 7 — Beyond the race

- [ ] **Replays** — the sim is 100% deterministic from inputs, so a replay is a
  *recorded input sequence* (host input + client input + AI seed), ~100 B/s:
  the host keeps the last race's input log (capped, memory-only) and the
  results screen offers REPLAY: re-simulate offline, chase the leader, any
  speed (0.5×/1×/2×). No wire traffic; old peers simply don't offer it.
  `make netsim` validates a record→replay determinism (bit-identical karts).
- [ ] **Track editor** — sandbox mode: drag control points on the existing
  spline gizmo, place pads, save to localStorage, and share via a short URL
  (base64 of the point/pad/hazard data, like the pairing code — `?track=`
  deep link, stripped after load). Geometry validation (min turn radius,
  min road width) reuses the bench's flat-track invariants. The biggest item
  in this arc; lands last.

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
