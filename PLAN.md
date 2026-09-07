# Plan: 3D Track Elevation (Stuck-to-Road Model)

## Goal

Give tracks vertical dimension. Karts "stick" to the road surface (no jumping/falling).
Slope affects speed (gravity component). Track rises from the table surface.

## Model

- **Stuck-to-road**: `pos.y = heightAt(sampleIdx)` (interpolated from nearest samples)
- **Slope physics**: `slope = ΔY / Δdist` between adjacent samples → `speed += slope * G * dt`
- **Visual**: kart mesh pitches to match road slope (`atan2(slopeY, slopeDist)`)
- **No free-flying**: Y is always determined by the track; no gravity "fall"
- Determinism preserved: height is track-derived, no wire traffic needed (same as pads/obstacles)

## Steps

### 1. Track data format (`src/tracks.js`)

- Change control points from `[x, z]` to `[x, y, z]` (Y = elevation in u)
- Keep existing tracks with Y=0 (backward compat)
- Add 1–2 new 3D tracks with interesting elevation profiles
- Optionally: a `maxElevation` config so tracks stay within a reasonable range

### 2. Spline + samples (`src/track.js`)

- `CatmullRomCurve3` already supports 3D — just feed the Y values
- `samples[i].y` now carries the height
- `buildRibbon`: use `p.y` instead of the constant `y` parameter
- Curbs, start line, checkered line: follow `p.y`

### 3. Kart physics (`src/kart.js`)

- In `step()`:
  - Look up the nearest sample index (already tracked via `posIdx` or a search)
  - `this.pos.y = samples[ni].y` (or lerp between `ni` and `ni+1`)
  - Compute slope: `slopeY = (samples[ni+1].y - samples[ni-1].y) / (2 * sampleDist)`
  - `this.speed += -slopeY * G * dt` (positive slope = uphill = decelerate)
- Mesh pitch: `this.mesh.root.rotation.x = atan2(slopeY, 1)` (small angle, arcade)
- G constant in `config.js` (tune for arcade feel, not real gravity)

### 4. AI (`src/ai.js`)

- Add slope to braking target: `cornerSpeed` calculation already uses curvature;
  add a `slopePenalty = max(0, -slopeY) * SLOPE_BRAKE_FACTOR` to the target speed
- Uphill → brake earlier; downhill → hold speed (but don't exceed MAX_SPEED)
- No other changes — pursuit, obstacle avoidance, recovery all work in XZ

### 5. Rendering (`src/track.js`)

- `buildRibbon`: replace constant `y` with `p.y`
- Curbs: follow the 3D curve
- Boost pads (`src/pads.js`): the "straight" scan uses XZ headings — add a Y-slope
  threshold so pads only appear on truly flat (or gentle) stretches
- Obstacles (`src/obstacles.js`): place on `p.y` (they sit on the road)
- Table: stays at Y=0 as the base; the track "pops up" from it (option c — no ramps needed)

### 6. Net wire (`src/net.js`)

- State frame: add `y` float per kart (one more f32)
- Interp (`src/interp.js`): already handles 3D positions — just verify
- Backward compat: old clients without Y field decode as `y=0`

### 7. Camera (`src/main.js`)

- Chase camera already tracks `kart.pos` — should follow Y automatically
- Verify vertical framing looks good on steep slopes (maybe add a small Y offset)

### 8. Test harnesses

- `make sim` (AI): existing assertions (off-road %, stalls) should still pass with flat tracks
  (Y=0 → slope=0 → no change). Add a 3D track to the suite.
- `make netsim`: wire round-trip with Y field; 2P race on a 3D track;
  determinism check (same track index → same layout)

## Config additions (`src/config.js`)

- `GRAVITY` — slope gravity constant (arcade-tuned, ~2–5, not 9.8)
- `SLOPE_BRAKE_FACTOR` — AI slope braking multiplier
- `MAX_ELEVATION` — soft cap for track design (e.g. 20u)

## Verification

- `make sim` — all tracks × all AI skill levels, 0 stalls, off-road < 1%
- `make netsim` — wire round-trips, 2P race on 3D track, determinism
- Manual: drive each track, feel the slope, check camera, check AI behaviour
- Flat tracks (Y=0 everywhere) must produce identical physics to before (regression gate)

## Sequencing

1. Track data + spline (data format, `make sim` still green with flat tracks)
2. Kart physics + visual pitch (core gameplay)
3. AI slope braking
4. Rendering (ribbon, curbs, pads, obstacles follow Y)
5. New 3D tracks in the catalogue
6. Wire + net-sim
7. `make sim` + `make netsim` full green
