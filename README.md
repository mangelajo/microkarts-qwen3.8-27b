# Micro Kart Racing

A tiny arcade kart racer on a dinner-table circuit, built with [three.js](https://threejs.org).
All geometry, textures, the sky and the audio are generated at runtime — zero external assets.

## Run

ES modules require a server (opening `index.html` directly will block the CDN module):

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

Headless AI test bench (runs the full suite on **every** track; fails the build on a
broken shape):

```bash
make imports # static import-graph check (browser-only modules included)
make sim     # AI drivers on every track
make netsim  # wire round-trips + 2P race sims on every track
make wscheck # a WS client drives the real game server (start → race → finish)
make wse2e   # two real browser pages race over the server (full loop)
make serve   # local full stack on ONE port: static + /ws multiplayer +
             # /rooms + /health (the same process the container runs)
make screens # Playwright render check — boots the game in headless Chromium
             # (menu / 2P / countdown / race, desktop + phone viewports)
```

**Production = the single game-server container** (the server is the sim
authority — multiplayer needs it anyway):

```bash
podman build -f Containerfile.game -t microkarts-game .
podman run -d -p 8080:8080 microkarts-game
# → http://host:8080/ — the game + multiplayer on ONE port, zero configuration
#   (the client dials same-origin /ws; /rooms + /health are on the same port)
```

An optional two-container variant (Nginx front :80 → game :8080):
`docker compose up -d --build` (see `docker-compose.yml`).

Static-only hosts (no 2P): `make deploy` uploads `index.html` + `src/`
+ `ai-sim/` to ajo.es/microkarts (run the gates first: `make sim
netsim deploy`) — multiplayer on such a host is played locally via
`make serve` (one process: static + `/ws` on one port) or a self-hosted
`Containerfile.game` / `docker-compose.yml` setup.

All game constants live in `src/config.js`: `ACCEL`, `BRAKE`, `MAX_SPEED`,
`STEER_RATE`, `ROAD_HW`, `LAPS`, `AI_SKILL`, …

To add a track, append an entry to `TRACKS` in `src/tracks.js` — a `name`,
a `theme` (reuses one of the palettes or define a new one), and a closed list
of `[x, y, z]` control points that stays within the 420u table (y = elevation
above the table, 0 for flat tracks). Then run
`make sim`: the AI harness drives all three skills on the new loop and exits
non-zero if a driver can't hold the road or recover.
## Controls

| Key            | Action            |
|----------------|-------------------|
| `W` / `↑`      | Accelerate        |
| `S` / `↓`      | Brake / reverse   |
| `A` `D` / `←` `→` | Steer          |
| `SPACE` (hold)    | Drift — release for a mini-boost; at the top of the charge curve a **PERFECT** release pays extra boost (touch: drag the stick to full lock) |
| **Gamepad**       | Left stick steer · stick down = gas · LT / Y = drift (release = boost) · RT / X = item |
| `T` (menu)        | Rain — wet road + puddles + rain patter (EXTRAS chip) |
| `←` `→` (menu)  | Pick track        |
| `M`            | Music on/off      |
| `N`            | SFX on/off        |
| `K`            | Minimap on/off    |
| `Z`            | Sugar hazards on/off (menu; join mirrors the host) |
| `E`            | Use item — turbo / wall (rubber is passive; touch auto-fires on pickup) |
| `I`            | Item boxes on/off (menu; join mirrors the host) |
| `Enter` / `R`  | Start / restart   |
| `Esc`          | Back to menu (from the results screen) |
| `1` · `2` · `3` | Menu page — RACE / EXTRAS / CONTROLS (menu only) |

3 laps to finish. Best lap per track is stored locally — a translucent ghost kart
races it alongside you, so you're always chasing your own best lap.

## Tracks

Eight circuits on the same dinner table, each with its own theme palette
(sky, fog, lighting, table wood, road colour) — six flat loops and two
whose roads rise off the table (up to ~15 u):

| # | Track | Style |
|---|-------|-------|
| 1 | BUTTERFINGO LOOP | the original dusk circuit |
| 2 | CANDY TANGLE | S-chicane + hairpin, candy-lit |
| 3 | MIDNIGHT TEARDROP | one long flowing bank, night |
| 4 | SUGAR CANYON | the old loop over a ridge, sunset — climbs to the far crest, fast run back down |
| 5 | MIDNIGHT RIDGE | teardrop over a ridge, night — climb the bank, drop the long bend |
| 6 | NEBULA SWIRL | space table — outer ring + two inner hooks (a fast loop with a slow, twisty heart) |
| 7 | CANDY CAVERN | indoor neon cave — a low ceiling, crystal clusters + hanging candy, a smooth loop with a waved top |
| 8 | STORM HARBOUR | overcast harbour — the table is a sea, bobbing buoys + a lighthouse with a rotating beacon; wind gusts nudge the AI |

Pick with the chips on the menu (or `←`/`→`); the choice is remembered.
Adding a track = a new entry in `src/tracks.js` (points + theme) and a
`make sim` run — the AI is track-agnostic and the harness runs every
take in the catalogue. All track shapes are validated headlessly.

## Features

- Five data-driven tracks (Catmull-Rom control points in `src/tracks.js`) with
  per-track theme palettes; menu selection persisted in localStorage
- **3D elevation** — the road itself has height (y up to ~15 u on the two 3D
  tracks). Karts stick to the road surface while on it, and the slope drives
  speed: `speed += -slope * GRAVITY * dt`, so climbs bleed and drops feed.
  Flat out over a crest, a kart launches when `v²·curvature > gravity` and
  flies a short parabola until the road holds it again. The red/white curb is
  road: wheels on it are fully supported and never tip. Past the curb, a
  wheel-level torque model tips the kart in the direction of exit — nose into
  the edge: nose down, tail: tail down, side: roll to the floating side, one
  corner: diagonal flip — then it tumbles under real gravity to the table;
  landing off an elevated track stuns it ~2.5 s ("FELL OFF" message) and
  resets it onto the racing line. A kart on the table under the track is
  never lifted. The height is pure track data (like pads and hazards), so
  host and clients compute it locally with zero wire traffic; the wire carries
  one extra f32 per kart (y) and old peers decode it as y = 0.
  The AI brakes for climbs off the same slope field, the camera and kart
  pitch follow the road, and the ghost rides the track height. Flat tracks
  are untouched: zero slope, zero elevation, identical physics and render
- Closed Catmull-Rom spline track swept into a ribbon road with curbs + checkered start line
- Low-poly cart with steering/rolling wheels, body pitch & roll, chase camera
- Arcade physics (delta-time based): accel, brake, drag, speed-scaled steering
- Off-road detection with drag + "OFF TRACK" warning; lap counting with a midpoint
  checkpoint (backing over the line doesn't count a lap)
- 3 AI opponents with distinct ability levels — pure-pursuit line following,
  curvature-aware braking, off-road recovery; tuning backed by `ai-sim/`
  (headless bench + a **live tuning playground**: `make serve` →
  `ai-sim/playground.html` runs the real `simulateTick` + AI on a 2D top-down
  canvas and writes straight into `config.js`'s live bindings via `tuneConfig`;
  `make simwatch` re-runs the bench on every save)
- Procedural dusk scene: canvas-painted sky dome with stars + mountains + sun glow,
  wood-textured table, scattered tabletop props (donuts, lollipops, pencil, …) that
  **react to contact** — a kart that grazes one spins it (scaled to speed), wobbles it,
  and a hard graze makes it hop (cosmetic only, `src/track.js` `tickProps`, verified in `make netsim`)
- Fully synthesized audio (`src/audio.js`): engine, tire skids, crashes, lap &
  countdown SFX, one chiptune per track (108–152 BPM depending on track)
- **Multiplayer over a WebSocket game server** (no shared network, no SDP
  pasting, no relay wrangling): the 2P menu tab connects to the game server
  (same-origin `/ws` when hosted in the container, or `?ws=ws://host:port/ws`),
  creates a 4-char room code (a QR is drawn for it) or lists live rooms from
  the lobby ("FIND A RACE"); the joiner types the code (or scans the QR —
  `?join=CODE` auto-fills + connects). **The server is the single sim
  authority**: each room runs the 60 Hz `simulateTick` loop in Node (the same
  pure-JS sim modules the headless sims use), with 2 human slots + 2 AI fill;
  both humans are pure renderers — input goes to the server at 60 Hz (a
  drift/item edge is never rate-gated), the server broadcasts state at
  60 Hz (with a trailing u16 tick **seq** the client uses for drop/late
  detection — legacy frames decode with `seq = undefined`, old clients
  ignore the trailing bytes), and the client renders through a **p95-jitter
  adaptive interpolation buffer** (grows fast on starvation, shrinks slowly
  toward `p95×1.2+15`, 60–350 ms floor/cap) + a PING/PONG RTT
  readout. Input ownership is explicit: a **connected human always owns
  their kart** (no key input = a parked kart — the server never drives it),
  and a **dropped** human's kart is silently AI-driven (the race
  continues); a host drop dissolves the room (the joiner is kicked back to
  the code screen). The WS grid staggers the AI row (further back, offset
  toward the centre) so the AI launch can't rear-end a human before they
  can steer, and kart-vs-kart impulse is projected along the collision
  normal so a rear-end push moves the front kart forward, not backwards.
  The countdown + finish are decided by the server. **The state frame's
  off-road byte doubles as the fall state (0/1 = on/off road, 2 = fell
  off)** so the server-authoritative fall-off stun reaches both clients
  (floor-hit explosion + HUD warning); old peers read a 2 as a plain
  off-road flag. Kart paint follows the wire slot, not the local object —
  host is red and the joiner is teal on both screens (AI = azure/matcha
  everywhere). The WS clients' HUD (speed, lap timer, position, item slot)
  is driven from the interpolated mirror, and the host's `TRACK` frame is
  forwarded to the joiner so their local item boxes / hazards always match
  the server's sim (item pickups mirror on both screens). The host screen
  shows a live player count (1/2 → 2/2 via the `/rooms` poll, which also
  reports `players`, host included) and the START action is gated until a
  joiner is actually in the room; a server that never answers HELLO times
  out with a clear error instead of sitting on “CONNECTING”. Verified
  headlessly by `make wscheck` (a WS client drives the real server: lobby,
  create/join, start, state, input → control, PING/PONG, finish, kick,
  dissolve) and by `make wse2e` (two real browser pages race over the
  server — the full production loop)
- **QR pairing** — the room code can be scanned instead of typed: the 2P menu
  tab shows a big canvas QR (280 px) encoding the join URL (`…?join=CODE`), and
  opening the join URL on any device
  auto-fills the code, pre-arms the connection and jumps to the 2P tab (`?join=` is
  stripped from the address bar after boot). The QR is drawn by a self-contained
  encoder (`src/qr.js`, ~290 lines, zero assets / zero dependencies): auto
  version 1–40, byte mode, level-M Reed-Solomon (16- or 18-bit generator),
  block interleave, all 8 masks with penalty selection, format + version info.
  Validated headlessly by `ai-sim/qr-check.mjs` — structural checks (finders,
  timing, alignment, dark module, format/version Hamming), a full zigzag read
  back with un-masking + block de-interleave + RS syndrome check (zero
  remainder, independently computed generator) on 7 version cases × all 8 masks
  (v1 → v40), over-capacity rejection, and an exact-matrix fixture
- **Day/night cycle** — the procedural sky is no longer a fixed per-track
  palette (`src/daynight.js`, pure visuals, zero physics/wire): the three
  daylight themes (**dusk / candy / sunset**) drift through a full day in 6 min —
  a sun rises, sets and a moon takes over while stars fade in on a dedicated
  starfield dome; lights, sky tint and fog follow the phase (boot is a low
  golden sun, so each track opens with its established look and slides into a
  starlit night over the race). The two **midnight** tracks stay night but
  gain the moon + starfield; **space** is untouched. Headless-safe (only the
  faked scene objects at import; canvas work in `initDayNight()`, called from
  browser-only `game.js`); `make sim` + `make netsim` unchanged; `make screens`
  adds a night-track race capture (moon + starfield)
- **Skid-to-drift** — hold `Space` above ~95 km/h on asphalt: the nose steers in
  faster than the motion follows (real slip angle, capped + controllable), charge
  builds, releasing fires a mini-boost scaled by the slide. **Perfect drift**: release
  at the top of the charge curve (≥94% of max, `PERFECT_CHARGE`) pays extra boost on
  top of full (`PERFECT_BONUS`, the decaying boost model handles >1 without new state)
  with a "PERFECT" callout + chime (`kart.js` + `game.js`, `make netsim` covers
  window/flag/bonus + early-release). The skid howl's pitch
  rises as the charge builds, the boost whoosh decays with `k.boost` (drift release
  OR pad, `audio.js`), and any boost flares a **golden nitro exhaust** at any speed
  (`blastfx.js`). Touch: drag to full lock. Wire-compatible (flag byte in the input
  frame); the AI never drifts, so `make sim` is a true no-regression gate. 13 headless
  assertions in `make netsim`
- **Sugar-hazard obstacles** (`src/obstacles.js`) — gumdrops, dice, gumballs and
  other candy scattered on the asphalt on a seed-per-track RNG, so host and every
  LAN client build the identical layout from the track index alone — nothing is
  streamed over the wire and races stay 100% deterministic. Hits live in the shared
  `race.js` `simulateTick` (solo + host + net-sim), and the AI dodges like a human:
  skill-scaled lane avoidance with per-driver side hysteresis, and a
  reverse-to-unwrap + 6 s per-hazard cooldown when a weak driver gets wedged.
  **Reactive**: a fast kart in a hazard's radius squash-stretches + wobbles the
  candy (a decaying pulse, `track.js` `tickHazards` — cosmetic, headless-safe).
- **Floor-hit explosion** (`src/explosion.js` + `audio.js`) — a kart that fell off
  an elevated track bursts when it hits the table: 12 pooled particles + smoke +
  an expanding shockwave ring, plus a synthesized boom (lowpass thump + sub +
  crackle). Host/solo fire on the `fellOff` transition; the join client fires its
  own from the fellOff mirror and the remote's from the existing y f32 drop —
  zero wire change. The pool saturates (8 booms) and fully decays; `make netsim`
  covers spawn/decay/saturation
- **Two new tracks** — CANDY CAVERN (track 7, indoor neon: a low dark ceiling +
  seeded crystal clusters + hanging candy, `src/scenery.js`) and STORM HARBOUR
  (track 8, overcast: the table is a **sea** — `seaTexture()`, bobbing buoys +
  a lighthouse with a rotating beacon; **wind gusts nudge the AI** via a
  deterministic spatial field in `ai.js`). Both are flat; day/night is `static`
  (indoor / overcast). Adding a track = a `src/tracks.js` entry + a `make sim`
  run — the AI is track-agnostic and the harness runs all 8 tracks
- **Controller-free mobile polish** — an on-screen **DRIFT button** (a big
  circular touch target, shown only on touch devices — verified with a
  Playwright touch context): hold to slide, release to boost; **haptic
  pulses** (`navigator.vibrate`) fire on drift-charge milestones (⅓, ⅔,
  PERFECT) and on the button press. A **9:16 portrait layout pass** for
  the chase camera: portrait viewports pull the camera in (×0.82), raise
  it (×1.2) and widen the FOV (+8) so the kart + road ahead both fit
- **Item #4: sticky candy** — a box reward that leaves a **slow patch**
  behind the thrower for 2 s: the first kart through it loses *grip* (65%
  steering authority + a slide), not speed — distinct from the wall's
  slam. `gripPenalty` decays in `kart.step`; the patch is host-
  authoritative in `items.js` (one-shot, 2 s lifetime, pooled brown disc in
  track.js, fades out). Same item-box economy (weighted roll,
  `ITEM_WEIGHTS` = 40/25/20/15); one more u8 value — old peers decode it
  as ITEM_NONE (a blank slot, safe). `make netsim` covers the patch field
  + grip model
- **Instanced rendering** — the scattered table props (donut / lollipop /
  block / gumdrop / pencil) now render as **7 InstancedMeshes** (one per
  part) instead of ~40 individual meshes: the per-prop state (spin, wobble,
  hop) still lives in `propList`, and `refreshPropMatrices()` in track.js
  pushes the matrices after each `tickProps`; per-prop colours ride
  `instanceColor`. A big draw-call reduction on mobile; visuals identical
  (screens-verified)
- **Track editor** — a 5th menu tab (EDIT, key `5`): drag the current
  track's control points on a top-down canvas; the track rebuilds live
  (same `buildTrack` path — corners, pads, puddles, scenery all follow).
  `src/trackedit.js` (browser-only); **solo + session-only** (not
  persisted; a 2P peer would build the un-edited track from the track idx).
  RESET restores the factory points; RACE IT starts the race on the edit
- **Replays** — the sim is 100% deterministic from inputs (all game RNG is
  seeded), so a replay is the player's recorded input stream re-fed to a
  fresh race: `src/replay.js` records the drive input each race (capped at
  ~5 min); a REPLAY THIS RACE button on the results screen re-runs the race
  with the recorded stream (deterministic — the kart traces the identical
  path; net-sim: record/playback round-trip + full re-run determinism). No
  wire change (local only)
- **Daily challenge** — a DAILY CHALLENGE button on the menu picks today's
  (UTC) fixed track + setup: `src/daily.js` derives the selection from the
  date int via `mulberry32` (same day → same track/hazards/items, every
  boot). The button applies the config + selects the track through the
  normal picker, so persistence + the 2P wire flow are unchanged
  (net-sim: daily determinism + range)
- **Rain + puddles** — the `T` menu key / EXTRAS chip toggles a fully
  procedural weather: 320 falling rain-streak points (generated streak texture),
  a wet-road retint (glossy dark, `roughness 0.3`), seeded **puddle discs on
  flat road sections only** (deterministic per track — the host and every
  client build the identical field; ripple + scale-pulse when a kart passes
  over), dimmed lights (scaled after day/night's absolute set each frame) and a
  band-passed rain patter. Purely cosmetic: zero physics, no wire, headless
  safe; `make netsim` covers the puddle field (count, flat-section gate,
  rebuild-identical determinism) + ripple lifecycle + headless toggle
- **Music reactivity** — the per-track chiptune gains a second layer driven by
  `audio.setMusicEnergy()` (0.55 · drift charge + 0.45 · boost, fed every frame
  from `game.js`): a lowpass in the music bus opens from 1.5 kHz to 20 kHz with
  energy, plus off-beat arp notes appear above 0.5 energy. Pure additive — at
  energy 0 the filter sits at 20 kHz (transparent) and the reactive layer is
  silent, so the song plays exactly as before. Headless-safe (the setter clamps
  and the filter path is browser-only); `make netsim` smoke-tests the setter
- **Gamepad support** — `navigator.getGamepads()` wired at boot (`src/gamepad.js`):
  left stick steer, stick-down = gas / up = brake, LT or Y = drift (release =
  boost), RT or X = item (edge-triggered into the same `itemUseQ` as `E`), D-pad
  fallback. The mapping is a pure `mapGamepad()` — a connected, active pad
  overrides keyboard/touch in `readDrive`. Headless-safe (the browser wiring is
  guarded); `make netsim` tests the mapping with a fake pad
- **Per-corner timing + deltas** — corners are the plateaus of the 2D (xz)
  curvature (min span + min turn angle, adjacent regions merged — deterministic
  from the samples, `src/corners.js`); every kart's in-corner time is ticked in
  the shared sim body (the join client runs it on the interpolated mirror) and
  banked on the lap edge. The HUD flashes the just-closed corner vs the
  session-best lap's per-corner time (+0.21 red / −0.04 green; neutral raw time
  on the first lap). Cosmetic only — nothing new rides the wire. `make netsim`
  covers the corner field, in-corner accumulation, close + lap-edge bank/reset
  Menu toggle: chip or `Z` (persisted, **ON by default**)
- **Boost pads** — glowing chevron strips auto-placed on each track's straights;
  crossing the three cells back-to-back chains a bigger and bigger kick, and the
  chain stacks with a drift release (drift-into-the-pads = go). The layout is
  derived from the track shape + a seeded PRNG (`src/pads.js`, pure + headless,
  exactly like the hazard field) so host and clients agree with zero wire traffic;
  hits fire inside `simulateTick`, so solo / host / `make netsim` share the model —
  and the AI reuses the pads too (skill-0.96 best lap already dropped ~1 s)
- **Beat your ghost** — best lap per track + a ~10 Hz position timeline persist in
  `localStorage`; a translucent ghost plays it back aligned to your current lap
  (solo + host — join clients mirror, never record)
- **Rankings** — a top-5 best-lap board per track in its own `localStorage` key
  (`src/rankings.js`, ms + date per entry, nothing over the wire); the menu shows
  the current track's board, and a lap that cracks it flashes "NEW RECORD — #N"
  (a new #1 keeps the chime). `make netsim` covers insert/sort/cap/reject/reload
- **Results juice** — podium pips on the finish screen (2-1-3 medal layout, the
  rest plain) + a ~180-piece procedural confetti burst; solo, 2P host and join
  client all go through `src/resultsfx.js` (ordering data = `raceOrder()`,
  covered headlessly by `make netsim`)
- **Menu fits every screen** — the menu is **multi-page** (four tabs, chips or `1`/`2`/`3`/`4`:
  **RACE** = track + START (2P lives in the 2P tab), **2P** = the whole multiplayer setup
  (mode toggle + pairing codes + the QRs),
  **EXTRAS** = sugar-hazard/item-box toggles + the top-5 board, **CONTROLS** = the key/touch
  list) so every page fits a phone without scrolling; the overlay is scroll-safe: `#overlay`
  scrolls and the `.panel` uses `margin:auto` (centred when it fits, top-aligned when it
  overflows); a compact media-query layout under 520 px wide / 1000 px tall — the panel
  is capped at 1020 px (one track-chip row) so ultrawide-short windows get a centred
  panel instead of a stretched one; on touch devices the key list is swapped for the
  pull-stick hints (`hud.js`). The menu controls **hide on the results screen**
  (`showOverlay`'s `isMenu` flag toggles `#menuSections`); `Esc` returns to the menu from
  results. **Sugar hazards + item boxes are ON by default** (persisted, `Z`/`I` to opt out;
  `sim.mjs` opts its base scenario out explicitly, the scenario sections opt back in).
  Verified by `make screens` — 20 captures (menu + all 4 pages + 2P host/join + results +
  countdown + race on desktop 1280×900 + phone 390×844, plus a night-track race)
- **Playwright render check** — `make screens` (`ai-sim/screens.mjs`) serves
  the game no-cache and boots it in headless Chromium on desktop (1280×900) +
  phone (390×844); captures menu / 2P panel / countdown / live race into
  `screens/` and fails on any page JS error. CI runs it as the `render` job —
  the first check that sees what the browser actually renders
- **Item boxes** (`src/items.js`) — three candy boxes per track on a seed-per-track RNG
  (like pads and hazards: host and every LAN client build the identical field from the track
  index alone, nothing streamed). Each box's own seeded PRNG fixes its reward — turbo (45%),
  rubber band (30%), wall (25%) — and it re-grants the same item after an 8 s respawn. Turbo is
  the drift/pad boost currency; the rubber band passively pushes a trailing holder (MK8-style:
  `E` does nothing while holding it), lasts `RUBBER_DURATION` (8 s) and then frees the slot —
  a live countdown ticks down in the item HUD (`#itemTimer`, a local clock from the item-id
  transition, so no wire change); the wall flies as a host-authoritative projectile and
  slams the first rival it touches. Pickups / fires / hits all run inside `simulateTick` (solo +
  host + net-sim share the model); the AI fires turbo on pickup and throws the wall only at
  close range; humans fire with `E` (touch: 450 ms auto-fire). Held item rides the state frame
  as one u8 per kart (29-byte karts; pre-item peers decode item = 0), the input frame gains a
  `use` bit (old frames decode use = false), and the track frame grows to 4 bytes (old 3-byte
  peers keep their local setting). ON by default — chip or `I` in the menu, persisted, host
  broadcasts; `make sim` runs an items-ON pack per track and `make netsim` covers wire
  round-trips, legacy decodes, layout determinism and the effect models

## Code layout

| File               | What it does |
|--------------------|--------------|
| `src/config.js`   | Tunable constants (speed, steering, track, AI skill levels) |
| `src/tracks.js`   | Track catalogue: control points + name + theme palette per track |
| `src/track.js`    | `buildTrack()`: spline → samples → ribbon road, curbs, table, reactive props (`tickProps`) + reactive hazards (`tickHazards`) |
| `src/scene.js`    | Renderer, lights, fog, sky |
| `src/sky.js`      | Procedural sky dome + sun (re-paintable gradient per theme) |
| `src/kart.js`     | Kart mesh + physics `step()` |
| `src/ai.js`       | AI driver: pure-pursuit line following, curvature-aware braking, recovery |
| `src/blastfx.js`  | Exhaust flame/smoke particle pools above the speed threshold + golden nitro flare on boost |
| `src/explosion.js`| Pooled floor-hit explosion FX (particle burst + smoke + shockwave ring) |
| `src/corners.js`   | Per-corner timing — curvature-plateau corner field, in-corner time, lap-edge bank (deterministic; deltas are cosmetic) |
| `src/gamepad.js`   | Gamepad — pure `mapGamepad()` (stick + D-pad + LT/Y drift, RT/X item) with browser connect/poll wiring (no-op headless) |
| `src/trackedit.js` | Track editor — drag the control points on a top-down canvas; live rebuild (browser-only, solo, session-only) |
| `src/replay.js`    | Replays — record the player's input each race; REPLAY re-feeds it (deterministic re-run) |
| `src/daily.js`     | Daily challenge — `mulberry32(date int)` → track + hazards + items (pure, deterministic) |
| `src/weather.js`   | Rain + puddles — streak field, seeded flat-section puddle discs with ripples, wet retint + light dim (cosmetic, headless-safe) |
| `src/scenery.js`   | Per-theme scenery — cavern ceiling + neon crystals + hanging candy, storm buoys + lighthouse (seeded, cosmetic, headless-safe) |
| `src/race.js`     | Headless race core: grid, progress, positions, collisions, `simulateTick()` |
| `src/pads.js`     | Boost-pad field: seeded straight-aware layout + chain-hit model (pure) |
| `src/obstacles.js`| Sugar-hazard field: seeded candy layout + per-driver AI dodging (pure) |
| `src/items.js`    | Item boxes: seeded layout + weighted rolls, pickups, wall projectiles, rubber band (pure) |
| `src/touch.js`    | Mobile "pull" joystick: first finger seeds a virtual stick, drag = drive vector |
| `src/textures.js` | Procedural canvas textures (wood table, sea, …) |
| `src/net.js`      | 2P wire protocol (u8 frame enc/dec) — pure, no transport; also the client↔server protocol (CONNECT/HELLO 0x41, PEER_JOINED 0x82, PEER_LEFT 0x81, KICK 0x83, PING/PONG 0x70/0x71) |
| `src/wsnet.js`    | WS transport (`WSSession`): WebSocket connect + binary frame dispatch (ArrayBuffer), 60 Hz input rate gate (drift/item edges never gated), PING/PONG RTT, connect timeout — `?ws=URL` override, same-origin `/ws` otherwise |
| `server/index.js` | **The game server** (Node, one container, one port): static files + `/ws` (WebSocket) + `/rooms` lobby (reports `players`, host included) + `/health`; CONNECT → create/join room, host leave dissolves, room-full kick, `/rooms` + `/health` |
| `server/room.js`  | Per-room **server-authoritative sim**: the 60 Hz `simulateTick` loop (same pure-JS sim modules), 2 human slots + 2 AI fill, 60 Hz state broadcast (trailing tick seq), **connected human always owns the kart** (no input = parked; only a *dropped* human becomes AI), host drop → dissolve, force-finish hook (`WS_TEST=1`) |
| `src/interp.js`   | Client-side interpolation ring + sampler (adaptive delay via `net2p`, angular wrap; `newestAt()` feeds the perceived-lag readout) |
| `src/game.js`     | Game state machine: karts, input, race lifecycle, cameras, the `animate()` loop — in WS mode both humans render the server's state (solo + LAN-host sim otherwise) — boots the `net2p` session |
| `src/net2p.js`    | 2P net orchestration: `WSSession` host/join lifecycle, room code + QR, lobby (FIND A RACE), client render mirror (interp, lap/finish bookkeeping, item-pickup mirror) |
| `src/hud.js`      | DOM HUD + overlays, 2P mode/roster pickers + net panels |
| `src/minimap.js`  | HUD minimap: track outline + racer dots + heading arrow |
| `src/ghost.js`    | Best-lap `localStorage` store + ghost-kart playback |
| `src/rankings.js` | Per-track top-5 best-lap board (separate `localStorage` key) + `rankLapDone()` rank |
| `src/qr.js`       | Self-contained QR encoder (auto v1–40, byte mode, level-M RS, 8-mask penalty selection) + canvas `drawQr()` |
| `src/resultsfx.js`| Results juice: podium pips (`podiumHtml`) + procedural confetti burst (`celebrate`) |
| `src/daynight.js` | Day/night cycle: 6-min day drift (sun/moon arc, starfield dome, light/tint/fog phase) per theme — cycle / night / static |
| `src/audio.js`    | WebAudio SFX + music sequencer (skid pitch follows drift charge, boost whoosh decays with `k.boost`, floor-hit boom, reactive filter + off-beat arp from drift/boost energy) |
| `ai-sim/`         | Node harnesses: `make sim` (AI) · `make netsim` (wire + 2P race sim) · `make wscheck` / `make wse2e` (server) |
| `ai-sim/playground.html` + `.js` | Browser **tuning playground**: the real `simulateTick` + AI on a 2D top-down canvas, runtime `tuneConfig`, telemetry (off % / stalls / laps / best lap) |
| `ai-sim/watch.mjs`  | `make simwatch` — re-runs the AI bench on every change in `src/` + `ai-sim/` |
| `ai-sim/screens.mjs` | `make screens` — Playwright render check: boots the game in headless Chromium (desktop + phone), captures menu/2P/countdown/race + a night-track race, fails on any page JS error |
| `ai-sim/qr-check.mjs` | `make qrcheck` — QR encoder gate: structural checks + full zigzag/RS decode (7 versions × 8 masks) + exact-matrix fixture |
| `ai-sim/ws-check.mjs` | `make wscheck` — the WS client drives the real server: health, lobby, create/join, start, state, input → control, PING/PONG, finish, kick, host-left dissolve |
| `ai-sim/ws-e2e.mjs`  | `make wse2e` — two real browser pages (Playwright) race over the server: create → type code → countdown → both pages `state=racing` → server-driven kart speed on both |
| `Containerfile.game` | **The single-container deploy**: Node 20 slim + `ws` + the game — static files + `/ws` + `/rooms` + `/health` on one port (zero-config multiplayer: the client at `http://host/` dials same-origin `/ws`) |
| `Containerfile.web` + `deploy/nginx.conf` + `docker-compose.yml` | The optional two-container variant: Nginx front (static + `/ws` proxy) → the game container |

## Tuning

All game constants live in `src/config.js`: `ACCEL`, `BRAKE`, `MAX_SPEED`,
`STEER_RATE`, `ROAD_HW`, `LAPS`, `AI_SKILL`, …

Two ways to tune:
* **Live (recommended):** `make serve` → `http://localhost:8080/ai-sim/playground.html`
  — the real race core on a 2D top-down canvas; the editor writes straight into
  `config.js`'s live `let` bindings (`tuneConfig`), so the next sim tick runs the
  new values. Telemetry matches `make sim`'s numbers, so a tuning that fixes the
  playground fixes the game.
* **Static:** edit the constants, then run `make sim`. `make simwatch` re-runs the
  bench automatically on every save.

To change a track shape, edit its control-point array in `src/tracks.js`
(closed Catmull-Rom loop). After adjusting AI or physics, run `make sim` to make
sure the drivers hold the road on every track.

## License

MIT-0 (zero-clause) — see [LICENSE](LICENSE).
