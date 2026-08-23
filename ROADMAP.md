# Roadmap

Ideas for continuing to improve Micro Kart Racing, rough-ordered by value-per-effort.
Check items off as they land.

## Current state (what's already solid)

- Arcade physics with off-road handling; lap/checkpoint counting with midpoint gate
- 3 distinct AI drivers + headless test bench (`make sim`, `ai-sim/`)
- Fully procedural scene: wood table, tabletop props, dusk sky + mountains — no assets
- Shadows, chase camera, HUD, countdown/results flow

## What's missing

- **Zero audio** — a kart game with no engine sound is half-dead
- **No rubber-banding / items** — races are 100% deterministic
- **One track** — variety is the fun in kart racers
- **Sparse player feedback** — no speed-FOV, no drift, no minimap
- **No mobile/touch**
- **No persistence** — best laps lost on refresh

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

- [ ] **More tracks** — extract `curve` into data (`src/tracks.js`: control-point sets + names + palettes); menu picks 1–3. AI is track-agnostic (reads `samples`/`curvatureAt`)
- [ ] **Items / boost pads** — boost pads on straights (track data); a simple item box (turbo / rubber band / wall); AI skips smart use, player with `Space`
- [ ] **Skid-to-drift** — hold `Space` at speed: reduced lateral grip + extra steering, builds charge released as mini-boost. Small `step()` physics tweak; sim harness makes tuning safe
- [ ] **Local 2-player** — second controller on the same keyboard (`IJKL`). `Kart` already supports `ai=false`; add a second input reader. Big "party game" unlock

## Phase 3 — *Structure* (keep the project sustainable)

- [ ] **Split monoliths** — `kart.js` (301 lines) → `physics.js` (step/off-road); `aiControl` → `ai.js`; `main.js` (247) → `game.js` (menu/countdown/racing/results state machine)
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
Phase 2.4 (2-player)          →  "party demo"
Phase 2.1 + Phase 3.1         →  "content" milestone (tracks + split code)
Phase 3.3 (ghost)             →  "comeback" milestone
```

**Top-3 picks if only doing three:**

1. Phase 1.1 — **audio** (transforms the feel)
2. Phase 2.4 — **2-player** (transforms the audience)
3. Phase 2.1 — **more tracks** (transforms replay value)
