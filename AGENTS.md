# Agent instructions

## Feature-completion protocol

Every time a new feature (or a coherent set of related changes) is finished:

1. **Run the gates — all must pass before anything else:**
   - `make lint`
   - `make sim` (AI harness on every track)
   - `make netsim` (wire round-trip + 2P race sims on every track)

2. **Update `README.md`:**
   - Add/extend a bullet in **Features** (what it does, how it works in 1–3
     sentences, which headless check covers it, and any wire-format change
     with its backward-compatibility note)
   - New key / touch gesture → a row in the **Controls** table
   - New `src/` or `ai-sim/` file → a row in the **Code layout** table
   - New track(s) → the **Tracks** table + the flat/3D count in its intro line

3. **Update `ROADMAP.md`:**
   - Check off the matching item (or add a new checked item under the right
     phase) with a short "what actually shipped" note
   - If it changes what's solid, add/extend the **Current state** section

4. **Clean up:** delete throwaway debug scripts (`ai-sim/*.tmp.mjs`) and
   untracked scratch files.

5. **Commit + push:** one descriptive subject line; mention the ROADMAP
   phase when applicable, e.g.
   `Corner-torque tipping: direction-specific tilt when wheels leave the road edge (ROADMAP Phase 2)`.
   Amend nothing — each finished feature is its own commit.

## Invariants (never break these)

- **Flat tracks stay bit-identical**: any new physics must produce zero
  effect (zero slope, zero elevation, zero tilt, zero airborne frames) on a
  y=0 track — `make sim` compares against this.
- **No magic lift**: a kart on the table under an elevated track is never
  pulled up; re-stick to the road only happens from a landing above it.
- **Track geometry is pure data** (points in `src/tracks.js`, pads in
  `src/pads.js`, hazards in `src/obstacles.js`): host and every client
  compute it locally from the track index — it is **never streamed** over the
  wire. New per-frame physics must follow the same rule (e.g. y is recomputed
  locally from the spline; only a small y field rides the state frame).
- **Wire backward compatibility**: any protocol change must decode old
  frames (asserted in `make netsim`).
- **`make sim` and `make netsim` are the no-regression gates** — if they
  can't express a property, add the assertion before the feature lands.
- **Zero external assets**: geometry, textures, sky and audio are all
  generated at runtime.
- New headless verification scripts belong in `ai-sim/`; keep them
  self-contained (import only `src/` + `ai-sim/stub.js`).
