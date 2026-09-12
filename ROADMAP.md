# Roadmap

Ideas for continuing to improve Micro Kart Racing, rough-ordered by value-per-effort.
Check items off as they land.

## Current state (what's already solid)

- Arcade physics with off-road handling; lap/checkpoint counting with midpoint gate
- **3D track elevation** — two 3D tracks (roads up to ~15 u above the table): stick-to-road with slope-driven speed, crest-launch jump physics, wheel-level torque tipping (direction of exit = direction of tilt), real-gravity falls with FELL OFF penalty + respawn, no magic lift; flat tracks bit-identical (`efd2b03` + `a1829d0`)
- **2-player LAN over WebRTC** — serverless code-paste pairing, host-authoritative fixed-step sim,
  60 Hz state stream + 50 ms client interpolation, 2 humans + 2 AI or 1 v 1 (`plans/2_player_lan.md`)
- 3 distinct AI drivers + headless test bench (`make sim` AI · `make netsim` wire + 2P race, `ai-sim/`)
- **Modular browser code** — `src/game.js` (state machine: karts, input, race lifecycle, cameras, `animate()`) drives `src/net2p.js` (2P host/join orchestration: session lifecycle, code pairing, client render mirror); one-way dependency, split verified behavior-preserving (`make sim` output byte-identical pre/post)
- **ai-sim tuning playground** — browser port (`ai-sim/playground.html`: the real `simulateTick` + AI on a 2D top-down canvas, runtime tuning via `config.js` `tuneConfig` live `let` bindings, per-kart telemetry = the bench's numbers) + `make simwatch` watch mode (bench re-runs on every `src/`/`ai-sim/` change)
- **Item boxes** — 3 seeded candy boxes per track (turbo / rubber band / wall, fixed per-box rolls); pickups, fires and wall hits live in the shared `simulateTick`, host-authoritative projectiles; OFF by default, chip or `I` (`src/items.js`)
- Fully procedural scene: wood table, tabletop props, dusk sky + mountains — no assets
- Shadows, chase camera, HUD, countdown/results flow

## What's missing

- **Phase 2 tail**: QR pairing (v1.5); local-prediction polish if the join client's own kart feels laggy
- **Phase 4 (pick by mood)**: day/night cycle or new track themes · drift sound pitch / nitro flame / reactive props · results confetti + podium pips · `package.json` scripts + Playwright screenshot test (CI-able render check)

---

## Phase 1 — *Feel* (weekend-scale, no architecture changes)

- [x] **Procedural audio** (`src/audio.js`, keeps the no-assets policy)
  - WebAudio engine oscillator, pitch tied to speed, gear-like stepping ✅
  - Skid noise when |steer| high & speed high; thud on collision; lap chime; countdown beeps ✅
  - One chiptune per track (drive / pop / wave; sequenced on the audio clock) ✅
  - `M` key / HUD button toggles mute (persisted in localStorage) ✅
- [x] **Speed feel** — FOV widens 55 → 70 with speed (smoothed); collision camera shake + per-kart jolt kick (damped roll/pitch in `sync()`) ✅
- [x] **Particle dust** — `THREE.Points` pool (90 puffs) puffs behind karts off-road at speed (`dustForKart` in `scene.js`) ✅
- [x] **Minimap** — 2D canvas HUD overlay; whole track outline (rebuilt per track) + a coloured dot per racer + the local kart's heading arrow; fits the current loop each track, `K` toggles it (`src/minimap.js`)
- [x] **Collision juice** — collisions live in the shared `race.js` (host + solo + net-sim); **fixed the reverse-collision bug** (constant position shove + 0.58 restitution pinned/shoved the driver forward; now speed-weighted soft separation + restitution 0.3 — "the driver wins"). Regression test in `make netsim` (old code: 72/180 oscillating contact; fixed: 180/180 smooth) ✅

## Phase 2 — *Depth* ("why do I want to play again")

- [x] **More tracks** (`src/tracks.js`, done in `test-micro`) — 3 named tracks, each with its own control-point set **and theme palette** (sky gradient, fog, light levels, table wood tint, road colour):
  - **BUTTERFINGO LOOP** (dusk, the original), **CANDY TANGLE** (19-point S-chicane hairpin, candy theme), **MIDNIGHT TEARDROP** (9-point flowing bank, midnight theme)
  - `track.js` now exposes `buildTrack(def)` / `selectTrack(idx)`: refills `samples`/`sampleHead`/`trackLen` **in place** so the kart physics + AI + sim keep working untouched, and swaps a `THREE.Group` of road/curbs/props with old geometries+materials disposed
  - menu picks a track via chips or `←`/`→` (persisted in `localStorage mkr-track`); HUD shows the current track name
  - **`make sim` now runs the full AI suite against every track** — a broken control-point set fails the harness instead of the browser (exit code 1)
  - AI stays track-agnostic: it only reads `samples`/`curvatureAt`. Adding a track = add an entry to `TRACKS` and run `make sim`
  - Later extended to **5 tracks**: the 3D elevation feature added SUGAR CANYON + MIDNIGHT RIDGE (catalogue now 3 flat + 2 elevated)
- [x] **Sugar-hazard road obstacles** (`src/obstacles.js`, pure + headless) — candy (gumdrop / dice / gumball / jawbreaker / lolly / bean) scattered on the asphalt on a **seed-per-track RNG**, so the **host and every LAN client build the identical layout from the track index alone** — nothing is streamed over the wire, and the 100%-deterministic-race property the net-sim relies on holds. Start-menu toggle (chip + `Z`, persisted in `localStorage mkr-hazard`), client mirrors the host's pick in join mode. `collideObstacles` (karts pop clear + decel + `obJuice` jolt / camera shake / crash sfx) lives in `race.js` simulateTick (solo + host + net-sim all run the same code).
  - **AI dodges like a human, not a physics bug**: `obstacleAvoid` (primary defense) steers the pursuit lane around the nearest in-lane hazard — strength scales with skill (strong drivers clear it clean; weak ones under-steer and clip it, which is the point) + per-driver hysteresis so they hold a side instead of weaving. If a driver *does* end up wedged against a candy at crawl speed (turnFactor → ~0, can't steer out), they **reverse ~8u to make room** then the avoidance re-approaches it — with a **per-hazard 6s cooldown** that kills the endless clip→reverse→re-clip loop. `make sim` checks all tracks × 3 skill levels (observed off-road <1%, 0 stalls); `make netsim` checks the seeded-layout determinism + a 4-kart hazard host race (4/4 finish)
- [x] **Boost pads** (`src/pads.js`, pure + headless) — chevron strips auto-placed on
  each track's straights: the field is DERIVED (scan sample headings for straight runs,
  place a 3-cell strip by a track-index-seeded PRNG, keep grid/finish clear, never pave
  over candy) so host + every client build it identically with zero wire traffic — the
  same trick as the hazard field. Crossing cells back-to-back chains the boost
  (0.4 → 0.7 → 1.05, 0.9 s window; writes `kart.boost`/`boostEdge` — the drift-boost
  vocabulary, so exhaust flare + whoosh + headroom all reuse it; drift-into-the-pads
  combo falls out free). Hits fire from `race.js` `simulateTick` → solo + host +
  `make netsim` share it; chevrons drawn by `track.js`. 7 new `make netsim` assertions
  (strip layout / determinism / on-asphalt / chain up / debounce / window expiry /
  re-arm). The AI rides the pads passively — best laps already ~1 s faster.
- [x] **3D track elevation** (`src/kart.js` + `src/tracks.js`, SUGAR CANYON + MIDNIGHT RIDGE) — the road itself has height (y up to ~15 u). Karts stick to the road surface while on it; the slope drives speed (`speed += -slope * GRAVITY * dt` — climbs bleed, drops feed). Crest-launch: flat out over a crest, a kart launches when `v²·curvature > gravity` and flies a short parabola until the road holds it again (speed-gated, off-by-one-frame crest check). Wheel-level torque tipping: the 4 wheel corners are projected against the ribbon each frame; per-corner support (the lip is the OUTER curb edge — the red/white border is road, deadzone spans a full curb-width past it — then fade as the wheel clears the face) → per-corner gap weighted by corner position → pitch/roll torques; angular velocity ramps from the torques (capped) and persists as momentum, so the tilt matches the exit direction (nose in → nose down, side → roll, one corner → diagonal flip) and the spin starts slow then speeds up. Off the edge: real-gravity fall to the table; landing off an elevated track = ~2.5 s stun ("FELL OFF") + respawn onto the racing line; a kart on the table under the track is never lifted (no magic lift). Height is pure track data — host and clients compute it locally, wire carries one f32 per kart (y, old peers decode y = 0); the AI brakes climbs off the slope field, camera/pitch/ghost ride the road. Flat tracks bit-identical; verified by `make sim` / `make netsim` + headless tilt matrices
- [x] **Item boxes** ✅ (`src/items.js`) — three candy boxes per track (seeded layout + per-box
  seeded PRNG, exactly like pads/hazards: host and clients build the identical field from the track
  index, nothing streamed, races stay 100% deterministic). Each box holds a fixed weighted roll —
  turbo (45%) / rubber band (30%) / wall (25%) — and re-grants the same item after an 8 s respawn.
  Turbo is the drift/pad boost currency (full charge); the rubber band is passive MK8-style (a
  trailing holder gets a push scaled to the gap; `E` does nothing while holding it); the wall is a
  host-authoritative projectile that slams the first rival it touches (speed ×0.4 + jolt). Pickups,
  fires and hits all live inside `simulateTick`, so solo / host / `make netsim` share one model;
  the AI fires turbo on pickup and throws the wall only at close range (beyond ~10 u the
  projectile can't outrun a kart inside its 2.8 s life). `E` fires (touch: 450 ms auto-fire on
  pickup); HUD item slot with per-item colours. Wire: one u8 item per kart in the state frame
  (29-byte karts; old 28/24-byte peers decode item = 0), a `use` bit in the 6-byte input frame
  (old frames decode use = false), and the track frame grows to 4 bytes (items byte; old 3-byte
  peers keep the local setting). OFF by default like hazards — menu chip or `I`, persisted,
  host broadcasts. Gated by `make sim` (items-ON pack per track) + `make netsim` (wire
  round-trips, legacy decodes, layout determinism, effect models, 2P races with items ON)
- [x] **Skid-to-drift** ✅ (`src/kart.js` + config block) — hold `Space` (touch: stick to full lock)
    above `DRIFT_MIN_KMH` on asphalt: heading steers in ×`DRIFT_STEER` while the motion direction
    follows at `DRIFT_GRIP` with a hard `DRIFT_MAX_SLIP` cap → a real, controllable slide; slides
    keep momentum (`DRIFT_DRAG` < `DRAG`), charge builds and release fires `BOOST_ACCEL` scaled by
    charge with `BOOST_HEADROOM` over top speed. Off-road / slow / race-over never drift.
    Body leans into the slide, exhaust flares on boost, skid audio howls, whoosh on release.
    Wire: drift flag byte in the input frame (`encInput` v2, old frames decode drift=false);
    state frames unchanged — remote karts already SHOW the slide because heading and motion are
    both on the wire. AI doesn't drift → `make sim` stays a no-regression gate; 13 assertions
    in `make netsim` (gate / engage / slip cap / charge / boost / headroom / wire)
- [x] **2-player** (superseded the local plan — went LAN instead): WebRTC DataChannel P2P, manual code pairing (no server), host runs the authoritative fixed-step sim, client interpolates. Headless safety net: `make netsim` (wire round-trips, interp unit checks, full 2P races on every track). Remaining: QR pairing (v1.5), local-prediction polish if the peer's own kart feels laggy

## Phase 3 — *Structure* (keep the project sustainable)

- [x] **Split monoliths** — `aiControl` → `src/ai.js`, exhaust FX → `src/blastfx.js` (`kart.js` 551 → 301 lines; since regrown to ~600 with the 3D elevation physics); the duplicated solo/host sim bodies in `animate()` merged into one shared loop (only the time base differs — also fixed the host re-running `finishRace()` + re-sending finish frames every frame after the flag dropped); **`main.js` (994 lines) → `src/game.js` (state machine: karts, input, race lifecycle, cameras, `animate()`) + `src/net2p.js` (host/join orchestration: `NetSession` lifecycle, code pairing, client render mirror)** — one-way dependency (game.js drives net2p via a context object; no import cycle), `COUNTDOWN_MS` moved to `config.js`, the duplicated grid camera-snap deduped into `camSnap()`. Verified behavior-preserving: `make sim` output byte-identical to the pre-split tree, `make netsim` pass, and a per-function body diff of all 40 moved functions
- [x] **`ai-sim/` as tuning playground** ✅ — shipped both halves: the **browser port** (`ai-sim/playground.html` + `playground.js`) runs the real `simulateTick` + `aiControl` (the exact `sim.mjs` items-scenario call) on a 2D top-down canvas — road shaded by elevation, pads/hazards/item boxes drawn, per-kart telemetry (laps, km/h, off %, stall %, best lap) + a finish report; and **`--watch` mode** (`ai-sim/watch.mjs`, `make simwatch`) re-runs the full bench on every change in `src/` + `ai-sim/` (debounced, mid-run changes re-trigger). The enabling change: `config.js`'s 51 tuning constants are now live `let` exports + `tuneConfig()` (setter map; `N_SAMPLES` excluded — track.js bakes it into module-scope arrays), so the playground writes physics values in place and the next sim tick runs them — no reload. `make sim` output unchanged (bit-identical), lint/imports/netsim green, playground init + full race + tuning validated via a headless DOM-shim smoke test
- [x] **Rankings** ✅ (`src/rankings.js`) — the ghost phase's remnant: a **top-5 best-lap board per track** in its own `localStorage` key (`mkr-rank`, separate from the ghost's `mkr-ghost` — the ghost key format is untouched) — `rankLapDone(lapMs)` slots a finished lap in (ms + short `YYMMDD` date, no timeline, so entries are tens of bytes) and returns the rank 1..5 for the nudge; a tie with the worst slot is rejected so the board stays stable. Local-only like the ghost (solo + host, the join-client gate is the same `role !== 'join'` block; nothing goes over the wire). The **menu shows the current track's board** (refreshes on track change) and a lap that cracks the top 5 flashes **"NEW RECORD — #N"** (a new #1 keeps the existing chime). `make netsim` covers insert/sort/cap/reject/reload + key separation
- [x] **localStorage best laps + ghost** ✅ (`src/ghost.js`) — best lap per track + a ~10 Hz
  position timeline (flat rounded JSON, ~1.7 KB / 30 s lap) in `localStorage mkr-ghost`;
  a translucent ghost kart plays it back aligned to YOUR current lap (starts when you
  start; you always race the best that existed before this lap). Solo + host only — the
  join client's lap events are host-clock-mirrored, recording there would store garbage.
  HUD BEST shows the stored record from lap 1; new records chime. Headless coverage in
  `make netsim` (store / overwrite / per-track / reload / sample-rate)
- [x] **Mobile / touch** — `src/touch.js`, a floating "pull" joystick: the **first finger down anywhere on the canvas seeds a virtual stick at that point** and the live **drag delta = the drive vector** (`pull up → throttle, down → brake/reverse, sideways → steer`), each axis clamped to [-1,1] on a 74 px spring with a 12 px dead-zone. It feeds the *same* `{throttle, steer}` channel as the keyboard via `readDrive()` (a live drag wins so the two never fight), so solo + host + client are all covered; the client streams it over the LAN. The `i8` input fields now carry the ±1 range ×127, so an analog drag survives the wire while keyboard's ±1/0 stay exact (`decInput(encInput(-1,1)) === {-1,1}`). Headless-safe (`initTouch` is a no-op without a DOM; `ai-sim` never imports it), so `make netsim` still passes (wire + all 3 races). A "PULL FROM ANYWHERE TO DRIVE" cue flashes at GO on touch devices. Steer sign is `INVERT_STEER` one-liner if a phone test flips it.

## Phase 4 — *Polish* (endless, pick by mood)

- [ ] Day/night cycle or a new track theme (candyland, space table)
- [ ] Drift sound pitch, nitro flame on boost, props that react (spinning lollipop on contact)
- [ ] Results confetti + podium pips
- [ ] `package.json` scripts + Playwright screenshot test (CI-able render check)

---

## Suggested sequence / milestones

```
Phase 1 (audio → feel)        →  "playable demo"
Phase 2.1 (3 tracks)          →  ✅ done — "variety demo"
Phase 2.4 (2-player)          →  ✅ done (LAN, not local) — "party demo"
Phase 2.1 + Phase 3.1         →  ✅ done — content milestone: add tracks (Phase 2.1 ✅ done) + split code (Phase 3.1 ✅ done)
Phase 3.3 (ghost)             →  "comeback" milestone
```

**Top-3 picks if only doing three:**

1. ~~Phase 1.1 — **audio**~~ ✅ done
2. ~~Phase 2.4 — **2-player**~~ ✅ done — LAN/WebRTC with `make netsim` safety net (transforms the audience)
3. ~~Phase 2.1 — **more tracks**~~ ✅ done (3 tracks + themes; catalogue now 5 with the 3D pair)
