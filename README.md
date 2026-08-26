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
make sim
```

All game constants live in `src/config.js`: `ACCEL`, `BRAKE`, `MAX_SPEED`,
`STEER_RATE`, `ROAD_HW`, `LAPS`, `AI_SKILL`, …

To add a track, append an entry to `TRACKS` in `src/tracks.js` — a `name`,
a `theme` (reuses one of the palettes or define a new one), and a closed list
of `[x, z]` control points that stays within the 420u table. Then run
`make sim`: the AI harness drives all three skills on the new loop and exits
non-zero if a driver can't hold the road or recover.
## Controls

| Key            | Action            |
|----------------|-------------------|
| `W` / `↑`      | Accelerate        |
| `S` / `↓`      | Brake / reverse   |
| `A` `D` / `←` `→` | Steer          |
| `←` `→` (menu)  | Pick track        |
| `M`            | Music on/off      |
| `N`            | SFX on/off        |
| `Enter` / `R`  | Start / restart   |

3 laps to finish. Best lap time is tracked in the HUD.

## Tracks

Three circuits on the same dinner table, each with its own theme palette
(sky, fog, lighting, table wood, road colour):

| # | Track | Style |
|---|-------|-------|
| 1 | BUTTERFINGO LOOP | the original dusk circuit |
| 2 | CANDY TANGLE | S-chicane + hairpin, candy-lit |
| 3 | MIDNIGHT TEARDROP | one long flowing bank, night |

Pick with the chips on the menu (or `←`/`→`); the choice is remembered.
Adding a track = a new entry in `src/tracks.js` (points + theme) and a
`make sim` run — the AI is track-agnostic and the harness runs every
take in the catalogue. All track shapes are validated headlessly.

## Features

- Three data-driven tracks (Catmull-Rom control points in `src/tracks.js`) with
  per-track theme palettes; menu selection persisted in localStorage
- Closed Catmull-Rom spline track swept into a ribbon road with curbs + checkered start line
- Low-poly cart with steering/rolling wheels, body pitch & roll, chase camera
- Arcade physics (delta-time based): accel, brake, drag, speed-scaled steering
- Off-road detection with drag + "OFF TRACK" warning; lap counting with a midpoint
  checkpoint (backing over the line doesn't count a lap)
- 3 AI opponents with distinct ability levels — pure-pursuit line following,
  curvature-aware braking, off-road recovery; tuning backed by `ai-sim/`
- Procedural dusk scene: canvas-painted sky dome with stars + mountains + sun glow,
  wood-textured table, scattered tabletop props (donuts, lollipops, pencil, …)
- Fully synthesized audio (`src/audio.js`): engine, tire skids, crashes, lap &
  countdown SFX, chiptune background music at 126 BPM
- **2-player LAN** over WebRTC DataChannel (no server): host or join from the
  menu, pair by pasting codes (`MKR-…`), then race 2 humans + 2 AI (or 1 v 1).
  The host runs the authoritative fixed-step sim and streams state frames at
  60 Hz; the joiner renders with 80 ms interpolation and sends input at 60 Hz.
  Protocol + simulation are verified headlessly (`make netsim`)

## Code layout

| File               | What it does |
|--------------------|--------------|
| `src/config.js`   | Tunable constants (speed, steering, track, AI skill levels) |
| `src/tracks.js`   | Track catalogue: control points + name + theme palette per track |
| `src/track.js`    | `buildTrack()`: spline → samples → ribbon road, curbs, table, props |
| `src/scene.js`    | Renderer, lights, fog, sky |
| `src/sky.js`      | Procedural sky dome + sun (re-paintable gradient per theme) |
| `src/kart.js`     | Kart mesh, physics `step()`, AI driver |
| `src/race.js`     | Headless race core: grid, progress, positions, collisions, `simulateTick()` |
| `src/net.js`      | 2P wire protocol (enc/dec) + `NetSession` (pairing, DataChannel routing) |
| `src/interp.js`   | Client-side interpolation ring + sampler (80 ms delay, angular wrap) |
| `src/main.js`     | Game loop, input, race lifecycle, camera, 2P host/join orchestration |
| `src/hud.js`      | DOM HUD + overlays, 2P mode/roster pickers + net panels |
| `src/audio.js`    | WebAudio SFX + music sequencer |
| `ai-sim/`         | Node harnesses: `make sim` (AI) · `make netsim` (wire + 2P race sim) |

## Tuning

All game constants live in `src/config.js`: `ACCEL`, `BRAKE`, `MAX_SPEED`,
`STEER_RATE`, `ROAD_HW`, `LAPS`, `AI_SKILL`, …

To change a track shape, edit its control-point array in `src/tracks.js`
(closed Catmull-Rom loop). After adjusting AI or physics, run `make sim` to make
sure the drivers hold the road on every track.
