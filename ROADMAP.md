# Microkarts roadmap — v2

v1 (Phases 1–8: core, 3D, engineering, polish, feel, world, beyond-the-race,
scale) is **complete — 14/14 items shipped**, see git history.
Same rules apply to everything below: zero assets, deterministic sim,
headless-verified (`make sim` / `make netsim`), wire backward-compatible,
flat tracks stay flat.

## Current state

- 8 procedural tracks (4 flat, 4 elevated), day/night sky, procedural rain,
  fully synthesized reactive music
- 1P / 2P WebRTC (QR pairing, `?join=` deep link), host-authoritative sim
- Drift → boost → pads + perfect drift; 4 item-box rewards (turbo / timed
  rubber / wall / sticky candy); sugar hazards; corner deltas
- Ghost + top-5 rankings; replays; daily challenge; 5-tab menu incl. track
  editor; gamepad + on-screen mobile controls; haptic charge pulses;
  9:16 portrait camera pass; instanced prop rendering

## Phase 9 — Four karts, four players

- [ ] **4-player races** — the state frame is already length-derived
  (`makeStateEncoder(kartN)` / `decodeState(d, kartN)` infer the stride from
  `byteLength`), and the sim takes an arbitrary kart array with AI fill —
  so a roster of 1P / 2P / 3P / 4P is an extension, not a redesign:
  roster picker on the RACE + 2P pages (AI fills empty seats), `kartN` in
  the start/hello message, per-player input messages (each peer already
  sends its own input; the host sim applies N of them). Backward
  compatibility: an old 2P peer joining a 4-kart race sees the first two
  karts (stride check passes) — `make netsim` covers a 4-kart race, AI
  fill, and old-peer decode of a 4-kart frame. Results/rankings/ghost/minimap
  already handle arrays; `posIdx` u8 already supports 4.
- [ ] **Roster UI** — the 2P page's "2+2" becomes a segmented control
  (1P / 2P / 3P / 4P, AI fills the rest), persisted like the other menu
  choices; screens capture all four roster states on phone + desktop.

## Phase 10 — World expansion

- [ ] **Reverse mode** — a REVERSE chip on the track picker inverts the
  spline (free 8 → 16 track content); pad / hazard / prop / puddle / corner
  fields re-seed with `trackIdx ^ 1` (deterministic, per the field rule —
  never streamed); `make sim` runs every track in both directions; a reverse
  lap records under its own ghost / ranking entry.
- [ ] **Two new tracks** — SNOWDRIFT ALPINE (winter theme + a **snow mode**
  in `src/weather.js`: the rain streak field retinted white, falling
  slower, white retint on the road) and PANCAKE PEAKS (the third elevated
  track: a layered-pancake table, syrup-hazard theme). Each = data in
  `tracks.js` + a theme + `src/scenery.js` scenery; `make sim` / `netsim`
  run all 10 tracks, screens capture a snow race.
- [ ] **Lift pads** — on elevated tracks only, one pad kind that launches
  the kart off the table edge (velocity y at the crest, same
  crest-launch model the spline already has) with a synthesized whoosh;
  flat tracks are unaffected (the flat invariant stays bit-identical);
  `make netsim` covers launch / airtime / re-stick.

## Phase 11 — Modes

- [ ] **Time trial** — a TIME TRIAL button on the RACE page: 1 lap,
  ghost-only (no AI, no rubber band), the lap posts straight to rankings +
  ghost. A thin wrapper over the existing solo path (LAPS = 1, roster =
  player + ghost).
- [ ] **Attract / watch mode** — the menu background runs a low-priority
  4-AI race (the sim is cheap; `aiControl` already takes a skill roster):
  "WATCH" from the menu, and an idle attract loop behind the menu after
  30 s. Pure local sim + render, zero wire; the sim keeps ticking the
  AI karts with a shared `simulateTick` so the flat-track invariant is
  untouched.
- [ ] **Overtime** — a third race variant: every kart starts with one
  boost charge and an item; first to the finish line wins (1 lap). The
  "who's in front" HUD already exists; `make netsim` covers the start
  state.

## Phase 12 — Feel & juice

- [ ] **Hit-stop + shake pass** — a 40 ms hit-stop (sim + render freeze)
  on wall-slam and the floor-hit explosion, plus a screen-shake curve
  matched to impact speed (the `camShake` decay exists; make it scale with
  the fall height). Cosmetic only — the sim timestamp keeps running so
  the host / client clocks stay in sync.
- [ ] **Cinematic replay** — in replay playback: leader-chase camera
  (the follow-up from Phase 7) + a slow orbit "photo" orbit around the
  leader, and 0.5× / 1× / 2× playback speed. Replays are a re-fed input
  stream, so speed = decimate / duplicate the feed; `make netsim` covers
  the 2× determinism.
- [ ] **Photo mode** — P (or a long-press on mobile): freeze-frame + a
  `canvas.toBlob()` PNG you can download / share (`navigator.share` where
  available) — zero assets, the share text encodes the track + time.
  Screens capture a photo-mode frame.
- [ ] **Music visualizer** — a waveform ring around the minimap that
  pulses with the music's energy (the same 0..1 value that drives the
  filter): pure additive draw pass, energy 0 = flat ring; `make netsim`
  smoke-tests the setter, screens capture an energy>0 ring.

## Phase 13 — Persistence & sharing (localStorage, no server)

- [ ] **Track editor: save + share** — the Phase 7 follow-up: pad
  placement, localStorage save (per track), and a `?track=` deep link
  (base64 point array, like the pairing code) + geometry validation
  (min separation / no self-intersection before `selectTrack`).
- [ ] **Share a lap** — the rankings entry encodes into a short code
  (track idx + time, base64) you can send as text: "I did 0:42.1 on
  STORM HARBOUR — code XK4A". No server: it's a brag string, not a
  validation. `make netsim` covers encode / decode round-trip.
- [ ] **Settings persistence** — music / SFX / weather / night toggle /
  roster / camera FOV persist across boots (localStorage, one key,
  versioned). `make netsim` covers a fake-store round-trip.

## Phase 14 — Performance

- [ ] **Adaptive pixel ratio** — the Phase 8 follow-up: drop the renderer
  pixel ratio to 0.75× on a sustained <45 fps (3 s moving average), restore
  at >58 fps; a playground FPS overlay to tune it.
- [ ] **Curb / pad / hazard instancing** — the Phase 8 follow-up: the
  remaining per-part table meshes (curb strips, pads, hazards) as
  InstancedMeshes (colours via `instanceColor`); draw-call count logged
  by a screens pass before / after.
- [ ] **Mobile perf pass** — touch devices: half-res shadow map + a
  reduced rain-streak count (160) + the portrait camera's closer framing
  already cuts the draw distance; a Playwright phone pass logs the frame
  time median.

## Deliberately not doing (for now)

- **5+ players** — the state frame is now sized for 4 karts; beyond that
  is a protocol re-design, not an extension.
- **Asset-based content** — the zero-asset rule is a feature (instant load,
  no CDN); everything stays procedural.
- **Server backend / matchmaking / accounts** — localStorage + WebRTC
  pairing stays the whole stack; rankings / ghost / share-a-lap are
  local-or-brag by design.
- **Full 3D physics** — still a 2.5D table: y comes from the spline, no
  rigid-body world.
