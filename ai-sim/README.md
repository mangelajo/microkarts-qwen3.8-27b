# ai-sim — headless AI test bench

Runs the **real** kart physics and AI (`src/kart.js`, `src/track.js`) in Node
and measures how well each AI driver holds the racing line — no browser needed.

```sh
make sim
# or:
node --import ./ai-sim/stub.js ai-sim/sim.mjs
```

## How it works
* `stub.js` registers ESM loader hooks (`hooks.mjs`) that replace the
  browser-only modules (`scene.js`, `textures.js`) with no-op fakes.
* `sim.mjs` drives real `Kart` instances through `aiControl()` at 60 Hz and
  reports: laps completed, % of time off-road, stalling, recovery time after a
  knock-out, best lap.

## Scenarios (run against **every** track in `src/tracks.js`)
1. **clean start** — on the racing line from the grid.
2. **knocked-out start** — 8u off the road, facing 45° the wrong way.
3. **head-on start** — on the road, facing the wrong way.
4. **full 4-kart race** — grid + kart collisions, as in `main.js`.

## Tuning the AI
* `ai-sim/cal.mjs` sweeps lookahead parameters per skill — useful when
  re-tuning `aiParams()` in `src/kart.js`:
  `node --import ./ai-sim/stub.js ai-sim/cal.mjs`
* Skills come from `AI_SKILL` in `src/config.js`; change them and re-run
  `make sim` to see the new pace spread (best-lap times should separate).

**Targets for a good AI (per track):** off-road < 5% over 3 laps and
no stalling in the clean/held scenarios, every driver recovers from a
knock-out, and the pack race finishes for the player. `make sim` exits
non-zero if any track fails, so a broken control-point set in
`src/tracks.js` is caught here, not in the browser.
