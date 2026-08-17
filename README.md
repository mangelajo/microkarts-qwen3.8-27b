# Micro Kart Racing

A tiny arcade kart racer on a dinner-table circuit, built with [three.js](https://threejs.org/).
One self-contained `index.html`, no build step.

## Run

ES modules require a server (opening double-click will block the CDN module):

```bash
cd this-directory
python3 -m http.server 8000
# open http://localhost:8000
```

(Any static server works: `npx http-server`, Vite, etc.)

## Controls

| Key          | Action            |
|--------------|-------------------|
| `W` / `↑`    | Accelerate        |
| `S` / `↓`    | Brake / reverse   |
| `A` `D` / `←` `→` | Steer        |
| `Enter`      | Start / restart   |
| `R`          | Restart (after finish) |

3 laps to finish. Best lap time is tracked in the HUD.

## Features

- Closed spline track swept into a ribbon road with curbs + checkered start/finish line
- Low-poly cart with steering/rolling wheels, body pitch & roll, chase camera
- Arcade physics (delta-time based): accel, brake, drag, speed-scaled steering
- Off-road detection (drag + "OFF TRACK" warning), lap counting with a midpoint checkpoint
  (driving backwards or cutting the start line doesn't count)
- Shadows, hemispheric + directional lighting, procedural wood-textured table,
  scattered tabletop props (donuts, lollipops, blocks, gumdrops, pencil)

## Tuning

All constants live at the top of the `<script type="module">` block:
`ACCEL`, `BRAKE`, `MAX_SPEED`, `MAX_REV`, `DRAG`, `OFF_DRAG`, `STEER_RATE`,
`ROAD_HW`, `LAPS`, `CAM_DIST`.

To change the track shape, edit the `curve` control-point array (12 points, closed loop).
