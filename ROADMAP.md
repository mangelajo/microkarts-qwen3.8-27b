# Roadmap

Ideas for continuing to improve Micro Kart Racing, rough-ordered by value-per-effort.
Check items off as they land.

## Current state (what's already solid)

- Arcade physics with off-road handling; lap/checkpoint counting with midpoint gate
- **2-player LAN over WebRTC** — serverless code-paste pairing, host-authoritative fixed-step sim,
  60 Hz state stream + 80 ms client interpolation, 2 humans + 2 AI or 1 v 1 (`plans/2_player_lan.md`)
- 3 distinct AI drivers + headless test bench (`make sim` AI · `make netsim` wire + 2P race, `ai-sim/`)
- Fully procedural scene: wood table, tabletop props, dusk sky + mountains — no assets
- Shadows, chase camera, HUD, countdown/results flow

## What's missing

- **No rubber-banding / items** — races are 100% deterministic
- **Sparse player feedback** — no speed-FOV, no drift, no minimap
- **No mobile/touch**
- **No best-lap persistence** — track pick + mutes survive refresh; laps don't

---

## Phase 1 — *Feel* (weekend-scale, no architecture changes)

- [x] **Procedural audio** (`src/audio.js`, keeps the no-assets policy)
  - WebAudio engine oscillator, pitch tied to speed, gear-like stepping ✅
  - Skid noise when |steer| high & speed high; thud on collision; lap chime; countdown beeps ✅
  - Chiptune background music (A-minor 126 BPM, sequenced on the audio clock) ✅
  - `M` key / HUD button toggles mute (persisted in localStorage) ✅
- [ ] **Speed feel** — FOV widens with speed (e.g. 62 → 74); kart jolt on collisions
- [ ] **Particle dust** when off-road (`THREE.Points` puffs at the wheels)
- [ ] **Minimap** — 2D canvas HUD overlay; track outline once at boot + kart dots (~50 lines, track data is already flat 2D)
- [ ] **Collision juice** — verify real-game karts push apart (sim has collisions; port them in)

## Phase 2 — *Depth* ("why do I want to play again")

- [x] **More tracks** (`src/tracks.js`, done in `test-micro`) — 3 named tracks, each with its own control-point set **and theme palette** (sky gradient, fog, light levels, table wood tint, road colour):
  - **BUTTERFINGO LOOP** (dusk, the original), **CANDY TANGLE** (19-point S-chicane hairpin, candy theme), **MIDNIGHT TEARDROP** (9-point flowing bank, midnight theme)
  - `track.js` now exposes `buildTrack(def)` / `selectTrack(idx)`: refills `samples`/`sampleHead`/`trackLen` **in place** so the kart physics + AI + sim keep working untouched, and swaps a `THREE.Group` of road/curbs/props with old geometries+materials disposed
  - menu picks a track via chips or `←`/`→` (persisted in `localStorage mkr-track`); HUD shows the current track name
  - **`make sim` now runs the full AI suite against every track** — a broken control-point set fails the harness instead of the browser (exit code 1)
  - AI stays track-agnostic: it only reads `samples`/`curvatureAt`. Adding a track = add an entry to `TRACKS` and run `make sim`
- [ ] **Items / boost pads** — boost pads on straights (track data); a simple item box (turbo / rubber band / wall); AI skips smart use, player with `Space`
- [ ] **Skid-to-drift** — hold `Space` at speed: reduced lateral grip + extra steering, builds charge released as mini-boost. Small `step()` physics tweak; sim harness makes tuning safe
- [x] **2-player** (superseded the local plan — went LAN instead): WebRTC DataChannel P2P, manual code pairing (no server), host runs the authoritative fixed-step sim, client interpolates. Headless safety net: `make netsim` (wire round-trips, interp unit checks, full 2P races on every track). Remaining: QR pairing (v1.5), local-prediction polish if the peer's own kart feels laggy

## Phase 3 — *Structure* (keep the project sustainable)

- [ ] **Split monoliths** — `kart.js` (301 lines) → `physics.js` (step/off-road); `aiControl` → `ai.js`; `main.js` (now ~700 with the 2P contexts) → `game.js` (state machine) + `net2p.js` (host/join orchestration)
- [ ] **`ai-sim/` as tuning playground** — `--watch` mode or a browser port (pure data in, telemetry out): tune physics/drift against a live canvas instead of guessing
- [ ] **localStorage best laps + ghost** — record best lap as a position timeline; render a semi-transparent ghost kart. "Beat your ghost" hook (~80 lines)
- [ ] **Mobile / touch** — on-screen pedals + tilt steering; pause the loop when the tab is hidden

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
Phase 2.1 + Phase 3.1         →  content milestone: add tracks (Phase 2.1 ✅ done) + split code
Phase 3.3 (ghost)             →  "comeback" milestone
```

**Top-3 picks if only doing three:**

1. ~~Phase 1.1 — **audio**~~ ✅ done
2. ~~Phase 2.4 — **2-player**~~ ✅ done — LAN/WebRTC with `make netsim` safety net (transforms the audience)
3. ~~Phase 2.1 — **more tracks**~~ ✅ done (3 tracks + themes)
