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
* `imports.mjs` (`make imports`) statically verifies that every relative import
  in `src/` + `ai-sim/` names an export the target declares — the one bug class
  the sims can't see, because browser-only modules (`main.js`, `hud.js`, …) are
  never imported headlessly.

## Scenarios (run against **every** track in `src/tracks.js`)
1. **clean start** — on the racing line from the grid.
2. **knocked-out start** — 8u off the road, facing 45° the wrong way.
3. **head-on start** — on the road, facing the wrong way.
4. **full 4-kart race** — grid + kart collisions, as in `main.js`.

## Watch mode — `make simwatch`

Re-runs the full AI bench on every change under `src/` or `ai-sim/`
(debounced; a change that lands mid-run re-triggers the next run):

```sh
make simwatch   # or: node ai-sim/watch.mjs
```

## Screenshot rig — `make screens`

Boots the game in headless Chromium (Playwright) and captures the menu, the 2P
host panel, the countdown and a live race on desktop (1280×800) and phone
(390×844) viewports into `screens/` (gitignored). Serves the project root
itself (no-cache), waits for the overlay, then drives the page — and **fails
on any page JS error**, so it doubles as the CI render check (the `render`
job in `.github/workflows/ci.yml` runs `npm run screens`):

```sh
make screens    # or: npm run screens / node ai-sim/screens.mjs [port]
```

This is how the phone menu-overflow bug was found: Playwright couldn't even
scroll `#startBtn` into view on the 390×844 viewport — the button sat below
the fold.

## Tuning playground (browser) — `make serve` → `ai-sim/playground.html`

The real race core (`race.js simulateTick` + `ai.js aiControl` — the same
call as `sim.mjs`'s items scenario) on a live 2D top-down canvas, with
`config.js` tunable **at runtime**: the constants are live `let` exports and
`config.js tuneConfig()` overwrites them in place, so the next sim tick runs
the new values (no reload). The 51 tunables are listed in the pre-filled
editor (physics / 3D / drift / items / AI / 2P groups); unknown names are
rejected with an error. Applying a tuning resets the race so the run starts
clean. `N_SAMPLES` is excluded on purpose (track.js bakes it into module-scope
arrays).

Controls: track select (all 5), hazards/items toggles, 1×/2×/4× speed, pause,
reset, and a skill slider (per-kart `k.skill`, live). Telemetry per kart:
laps, km/h, cumulative **off-road %**, **stall %** and best lap — the same
numbers the headless bench prints, so a tuning that fixes the playground fixes
the game. A finish report (per-kart finish/stuck + wall hits) appears when
the pack ends or the 300 s cap hits.

The page also hosts `scene.js`'s real WebGL canvas in a parked, off-screen
`#app` div (track.js / kart.js import it) — the playground itself renders
2D only.

```sh
make serve   # then open http://localhost:8080/ai-sim/playground.html
```

## Tuning the AI
* `ai-sim/cal.mjs` sweeps lookahead parameters per skill — useful when
  re-tuning `aiParams()` in `src/ai.js`:
  `node --import ./ai-sim/stub.js ai-sim/cal.mjs`
* Skills come from `AI_SKILL` in `src/config.js`; change them and re-run
  `make sim` to see the new pace spread (best-lap times should separate).

**Targets for a good AI (per track):** off-road < 5% over 3 laps and
no stalling in the clean/held scenarios, every driver recovers from a
knock-out, and the pack race finishes for the player. `make sim` exits
non-zero if any track fails, so a broken control-point set in
`src/tracks.js` is caught here, not in the browser.
