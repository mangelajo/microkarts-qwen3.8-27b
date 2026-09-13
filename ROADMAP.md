# Microkarts roadmap

The old roadmap (Phases 1–4) is **100% shipped** — compressed at the bottom. This
document is the next arc: feel, world, beyond-the-race, scale. Same rules apply:
zero assets, deterministic sim, headless-verified (`make sim` / `make netsim`),
wire backward-compatible, flat tracks stay flat.

## Current state

- 6 procedural tracks (3 flat, 3 elevated), day/night sky, fully synthesized audio
- Solo vs AI + 2-player WebRTC (QR pairing, `?join=` deep link), host-authoritative sim
- 3D elevation: slope speed, crest-launch, wheel-torque tipping, table fall + respawn
- Drift → boost → pads; sugar hazards; item boxes (turbo / timed rubber / wall)
- Ghost + top-5 rankings (localStorage); results FX; reactive tabletop props
- AI bench (`make sim`), wire round-trip + race sims (`make netsim`), tuning
  playground + watch mode, Playwright render check (`make screens`)

## Phase 5 — Feel

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
- [ ] **Spectator mode** — a third device joins as spectator: the join flow
  gains a mode bit (old peers decode it as 0 → normal join, backward
  compatible); the spectator sends no input (the host runs a parked kart for
  it) and its camera follows the leader with the minimap + live positions.
  `make netsim` gets a 3-party sim (host + racer + spectator frames).
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
  is a protocol re-design, not an extension (spectator above is the cheap
  step toward it).
- **Asset-based content** — the zero-asset rule is a feature (instant load,
  no CDN); everything stays procedural.
- **Server backend / accounts** — localStorage + WebRTC stays the whole stack;
  rankings/ghost are local by design.

---

## Shipped (Phases 1–4, complete)

**Core**: 2P WebRTC (pairing code + QR on both sides, `?join=` deep link),
host-authoritative sim, wire round-trip sims · 6 tracks (3 flat, 3 elevated)
incl. NEBULA SWIRL · 3D elevation (slope speed, crest-launch, wheel-torque
tipping, no-magic-lift fall + respawn) · drift → boost → pads · sugar hazards
· item boxes (turbo / **timed rubber band with HUD countdown** / wall) ·
ghost + top-5 rankings · day/night cycle (drifting sun/moon, starfield,
per-theme modes) · results confetti + podium pips · drift sound pitch +
nitro flames · **reactive tabletop props** (seeded field, drift-band props,
contact spin/wobble/hop) · multi-page menu (RACE/EXTRAS/CONTROLS/2P) ·
fully synthesized audio (engine, skids, chiptune per track)

**Engineering**: monolith split (`main.js` → `game.js` + `net2p.js`),
`config.js` tuning surface (51 live constants) + AI bench + tuning playground
+ watch mode, headless QR encoder (`src/qr.js`, reference-verified), Playwright
render check (20 captures, every screen size), `make sim` / `make netsim` /
`make screens` / `make qrcheck` gates, CI on every push, `make deploy`
