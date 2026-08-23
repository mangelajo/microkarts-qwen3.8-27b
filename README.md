# Micro Kart Racing

A tiny arcade kart racer on a dinner-table circuit, built with [three.js](https://threejs.org).
All geometry, textures, the sky and the audio are generated at runtime — zero external assets.

## Run

ES modules require a server (opening `index.html` directly will block the CDN module):

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

Headless AI test bench (verifies the drivers stay on track and finish):

```bash
make sim
```

## Controls

| Key            | Action            |
|----------------|-------------------|
| `W` / `↑`      | Accelerate        |
| `S` / `↓`      | Brake / reverse   |
| `A` `D` / `←` `→` | Steer          |
| `M`            | Sound on/off      |
| `Enter` / `R`  | Start / restart   |

3 laps to finish. Best lap time is tracked in the HUD.

## Features

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

## Code layout

| File               | What it does |
|--------------------|--------------|
| `src/config.js`   | Tunable constants (speed, steering, track, AI skill levels) |
| `src/track.js`    | Spline → samples → ribbon road, curbs, table, props |
| `src/scene.js`    | Renderer, lights, fog, sky |
| `src/sky.js`      | Procedural sky dome + sun |
| `src/kart.js`     | Kart mesh, physics `step()`, AI driver |
| `src/main.js`     | Game loop, input, race lifecycle, camera |
| `src/hud.js`      | DOM HUD + overlays |
| `src/audio.js`    | WebAudio SFX + music sequencer |
| `ai-sim/`         | Node harness to test the AI headlessly (`make sim`) |

## Tuning

All game constants live in `src/config.js`: `ACCEL`, `BRAKE`, `MAX_SPEED`,
`STEER_RATE`, `ROAD_HW`, `LAPS`, `AI_SKILL`, …

To change the track shape, edit the `curve` control-point array in `src/track.js`
(closed Catmull-Rom loop). After adjusting AI or physics, run `make sim` to make
sure the drivers stay on track.
