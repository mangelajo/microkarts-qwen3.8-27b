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
```

Production deploy (uploads `index.html` + `src/` to ajo.es/microkarts — run the
gates first: `make sim netsim deploy`):

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
| `SPACE` (hold)    | Drift — release for a mini-boost (touch: drag the stick to full lock) |
| `←` `→` (menu)  | Pick track        |
| `M`            | Music on/off      |
| `N`            | SFX on/off        |
| `K`            | Minimap on/off    |
| `Z`            | Sugar hazards on/off (menu; join mirrors the host) |
| `E`            | Use item — turbo / wall (rubber is passive; touch auto-fires on pickup) |
| `I`            | Item boxes on/off (menu; join mirrors the host) |
| `Enter` / `R`  | Start / restart   |

3 laps to finish. Best lap per track is stored locally — a translucent ghost kart
races it alongside you, so you're always chasing your own best lap.

## Tracks

Six circuits on the same dinner table, each with its own theme palette
(sky, fog, lighting, table wood, road colour) — four flat loops and two
whose roads rise off the table (up to ~15 u):

| # | Track | Style |
|---|-------|-------|
| 1 | BUTTERFINGO LOOP | the original dusk circuit |
| 2 | CANDY TANGLE | S-chicane + hairpin, candy-lit |
| 3 | MIDNIGHT TEARDROP | one long flowing bank, night |
| 4 | SUGAR CANYON | the old loop over a ridge, sunset — climbs to the far crest, fast run back down |
| 5 | MIDNIGHT RIDGE | teardrop over a ridge, night — climb the bank, drop the long bend |
| 6 | NEBULA SWIRL | space table — outer ring + two inner hooks (a fast loop with a slow, twisty heart) |

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
  wood-textured table, scattered tabletop props (donuts, lollipops, pencil, …)
- Fully synthesized audio (`src/audio.js`): engine, tire skids, crashes, lap &
  countdown SFX, one chiptune per track (108–152 BPM depending on track)
- **2-player LAN** over WebRTC DataChannel (no server): host or join from the
  menu, pair by pasting codes (`MKR-…`), then race 2 humans + 2 AI (or 1 v 1).
  The host runs the authoritative fixed-step sim and streams state frames at
  60 Hz; the joiner renders with 50 ms interpolation and sends input at 60 Hz.
  Protocol + simulation are verified headlessly (`make netsim`)
- **Skid-to-drift** — hold `Space` above ~95 km/h on asphalt: the nose steers in
  faster than the motion follows (real slip angle, capped + controllable), charge
  builds, releasing fires a mini-boost scaled by the slide. The skid howl's pitch
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
  Menu toggle: chip or `Z` (persisted)
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
- **Item boxes** (`src/items.js`) — three candy boxes per track on a seed-per-track RNG
  (like pads and hazards: host and every LAN client build the identical field from the track
  index alone, nothing streamed). Each box's own seeded PRNG fixes its reward — turbo (45%),
  rubber band (30%), wall (25%) — and it re-grants the same item after an 8 s respawn. Turbo is
  the drift/pad boost currency; the rubber band passively pushes a trailing holder (MK8-style:
  `E` does nothing while holding it); the wall flies as a host-authoritative projectile and
  slams the first rival it touches. Pickups / fires / hits all run inside `simulateTick` (solo +
  host + net-sim share the model); the AI fires turbo on pickup and throws the wall only at
  close range; humans fire with `E` (touch: 450 ms auto-fire). Held item rides the state frame
  as one u8 per kart (29-byte karts; pre-item peers decode item = 0), the input frame gains a
  `use` bit (old frames decode use = false), and the track frame grows to 4 bytes (old 3-byte
  peers keep their local setting). OFF by default — chip or `I` in the menu, persisted, host
  broadcasts; `make sim` runs an items-ON pack per track and `make netsim` covers wire
  round-trips, legacy decodes, layout determinism and the effect models

## Code layout

| File               | What it does |
|--------------------|--------------|
| `src/config.js`   | Tunable constants (speed, steering, track, AI skill levels) |
| `src/tracks.js`   | Track catalogue: control points + name + theme palette per track |
| `src/track.js`    | `buildTrack()`: spline → samples → ribbon road, curbs, table, props |
| `src/scene.js`    | Renderer, lights, fog, sky |
| `src/sky.js`      | Procedural sky dome + sun (re-paintable gradient per theme) |
| `src/kart.js`     | Kart mesh + physics `step()` |
| `src/ai.js`       | AI driver: pure-pursuit line following, curvature-aware braking, recovery |
| `src/blastfx.js`  | Exhaust flame/smoke particle pools above the speed threshold + golden nitro flare on boost |
| `src/race.js`     | Headless race core: grid, progress, positions, collisions, `simulateTick()` |
| `src/pads.js`     | Boost-pad field: seeded straight-aware layout + chain-hit model (pure) |
| `src/obstacles.js`| Sugar-hazard field: seeded candy layout + per-driver AI dodging (pure) |
| `src/items.js`    | Item boxes: seeded layout + weighted rolls, pickups, wall projectiles, rubber band (pure) |
| `src/touch.js`    | Mobile "pull" joystick: first finger seeds a virtual stick, drag = drive vector |
| `src/textures.js` | Procedural canvas textures (wood table, …) |
| `src/net.js`      | 2P wire protocol (enc/dec) + `NetSession` (pairing, DataChannel routing) |
| `src/interp.js`   | Client-side interpolation ring + sampler (50 ms delay, angular wrap) |
| `src/game.js`     | Game state machine: karts, input, race lifecycle, cameras, the `animate()` loop (solo/host sim + client pass) — boots the `net2p` session |
| `src/net2p.js`    | 2P net orchestration: `NetSession` host/join lifecycle, code pairing, client render mirror (interp, lap/finish bookkeeping, item-pickup mirror) |
| `src/hud.js`      | DOM HUD + overlays, 2P mode/roster pickers + net panels |
| `src/minimap.js`  | HUD minimap: track outline + racer dots + heading arrow |
| `src/ghost.js`    | Best-lap `localStorage` store + ghost-kart playback |
| `src/rankings.js` | Per-track top-5 best-lap board (separate `localStorage` key) + `rankLapDone()` rank |
| `src/resultsfx.js`| Results juice: podium pips (`podiumHtml`) + procedural confetti burst (`celebrate`) |
| `src/audio.js`    | WebAudio SFX + music sequencer (skid pitch follows drift charge, boost whoosh decays with `k.boost`) |
| `ai-sim/`         | Node harnesses: `make sim` (AI) · `make netsim` (wire + 2P race sim) |
| `ai-sim/playground.html` + `.js` | Browser **tuning playground**: the real `simulateTick` + AI on a 2D top-down canvas, runtime `tuneConfig`, telemetry (off % / stalls / laps / best lap) |
| `ai-sim/watch.mjs`  | `make simwatch` — re-runs the AI bench on every change in `src/` + `ai-sim/` |

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
