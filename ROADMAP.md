# Microkarts roadmap — v2

v1 (Phases 1–8: core, 3D, engineering, polish, feel, world, beyond-the-race,
scale) is **complete — 14/14 items shipped**, see git history.
Same rules apply to everything below: zero assets, deterministic sim,
headless-verified (`make sim` / `make netsim`), wire backward-compatible,
flat tracks stay flat.

## Current state

- 8 procedural tracks (4 flat, 4 elevated), day/night sky, procedural rain,
  fully synthesized reactive music
- 1P / 2P over the **Node WebSocket game server** (`server/`: 60 Hz
  server-authoritative sim per room, 2 human slots + 2 AI fill, connected
  human always owns their kart / dropped human → AI; 4-char
  room code, QR pairing, `?join=` deep link, FIND A RACE lobby;
  wire-slot kart colours, forwarded TRACK to the joiner, fall state
  over the wire for both devices' floor-hit FX, live 1/2 → 2/2 host
  screen with a start gate; **smoothness pass: 60 Hz state wire +
  trailing tick seq (drop/late detection, backward-compatible) +
  monotonic render-time pacing — the render target can never move
  backward; no-hold extrapolation (the render point advances through
  delivery gaps on the bounded 200 ms extrapolation, so the arrival
  flash — cart freezes then jumps the gap's motion — is gone);
  proportional catch-up drain (a deep buffer drains at ~1.35× max,
  decaying to 1× — no 3× fast-forward pulse); per-frame advance
  capped at 2× nominal (a hitching main thread slides over a few
  frames, never a 6× flash); re-seed after >500 ms of real stall;
  60 Hz input + fresh-buffer-per-frame encoder (no ws send-queue
  aliasing)** — measured over the real internet: server tick clean
  (p95 18 ms, zero gaps >300 ms in 3,707 frames), zero rendered-
  position rewinds, no periodic drain pulse, **render lerp over sim
  time (`hostMs`) not arrival time — the render point is a sim-clock
  accumulator, so the car is always 100% speed and a late frame no
  longer drops it to 16% / pulls it backward (the periodic backward
  pull fix)**; `/health` exposes the
  build's git commit), deployed as one container — static + `/ws`
  + `/rooms` on a single port (zero-config multiplayer); **empty rooms
  auto-dissolve + prune from the map (a finished room the host lingers
  in persists for re-race), and nicknames ride the existing CONNECT/
  HELLO/PEER_JOINED frames (no wire change) — shown on the host/joiner
  status, the results, and drawn in 3D above the kart in-race**.
  WebRTC/LAN and the PHP relay paths removed
- Drift → boost → pads + perfect drift; 4 item-box rewards (turbo / timed
  rubber / wall / sticky candy); sugar hazards; corner deltas
- Ghost + top-5 rankings; replays; daily challenge; 5-tab menu incl. track
  editor; gamepad + on-screen mobile controls; haptic charge pulses;
  9:16 portrait camera pass; instanced prop rendering

## Phase 9 — Network server (Node + WebSocket)

- [x] **Online rooms over a Node WebSocket server** — the shipped path.
  A single Node process is the whole backend: static files + `/ws`
  + `/rooms` lobby + `/health` on one port (`server/index.js` +
  `server/room.js`), built as one container (`Containerfile.game`) —
  **the client at `http://host/` needs zero configuration** (same-origin
  `/ws`). The server is the **single sim authority**: each room runs the
  60 Hz `simulateTick` loop (the same pure-JS sim modules `ai-sim`
  proves Node-safe) with 2 human slots + 2 AI fill; both humans are pure
  renderers — input at 30 Hz (drift/item edges never rate-gated), state
  broadcast at 30 Hz, rendered through the adaptive interpolation buffer
  (100–350 ms) with a PING/PONG RTT readout. Input ownership is
  explicit: a **connected human always owns their kart** (no key input =
  a parked kart — the server never drives it), a **dropped** human
  mid-race → silently AI-driven; host drop → room dissolves (joiner
  kicked back to the code screen). The WS grid staggers the AI row so
  the AI launch can't rear-end a human before they can steer, and
  kart-vs-kart impulse is projected along the collision normal (a
  rear-end push moves the front kart forward, not backwards — the old
  front-collision impulse knocked grid karts into reverse). The first
  WS build also shipped with three 2P-drivability bugs (vessel mapping
  used the legacy LAN kart order; 1v1 frames crashed on a hard-coded
  kartN=4; the lobby read a field the server never sent) — all fixed
  and covered by `make wse2e`. Client side: `src/wsnet.js` `WSSession` (WebSocket
  transport, binary frames, `?ws=URL` override), the WebRTC + PHP relay
  paths are **removed** (2P = WS server + QR pairing). The 2P tab: room
  code + QR, type-in join (or FIND A RACE lobby), `?join=CODE`
  deep-link auto-connects. Gates: `make wscheck` (a WS client drives the
  real server: lobby, create/join, start, state, input → control,
  PING/PONG, finish, kick, host-left dissolve) + `make wse2e` (two real
  browser pages race over the server — the full production loop);
  `make netsim` keeps the per-track 2P race sim + wire round-trip. A
  follow-up sweep fixed the first-race correctness gaps: **kart paint
  now follows the wire slot** (host red / joiner teal on *both* screens
  — the mirror objects used to keep their local-object colours), the
  **host's `TRACK` frame is forwarded to the joiner** (their local item
  boxes / hazards now match the server's sim, so pickups mirror on both
  screens) and the **WS clients' HUD is driven from the interpolated
  mirror** (the item slot / speed / lap timer used to sit frozen). The
  state frame's off-road byte doubles as the **fall state (2 = fell
  off)** so the floor-hit explosion + HUD warning reach both devices
  (old peers read a 2 as plain off-road — backward compatible). The host
  screen shows a **live player count (1/2 → 2/2** via the `/rooms`
  poll, which now reports `players`, host included), **gates START until
  a joiner is in**, and times out a dead server instead of sitting on
  “CONNECTING”. Both
  container variants verified end-to-end with podman (single container:
  static + WS on one port; two-container: Nginx front proxies `/ws` +
  `/rooms`). Earlier dead ends, recorded for the future: a pure-PHP
  long-poll relay (shipped + deployed, then replaced — long-poll clumps
  needed the adaptive buffer; file-queue stat staleness under mod_php;
  1 s mtime granularity) and the WebRTC/LAN path (NAT/SDP pain).
  Netplay tuning history: 60 Hz wire + fixed 50 ms buffer → catch-up
  jumps (28 % of samples); 30 Hz wire + adaptive buffer → 8 % (Δ > 1.5 u
  per 50 ms, headless A/B with a ~3× slow host); the server-authoritative
  path removes the host-side load asymmetry entirely.
- [ ] **Server-authoritative 4-player race** — the Phase 9 server already
  runs the room loop, so 4 humans is an extension, not a build: a
  third `humans` slot (the state frame is length-derived — the wire is
  already N-kart-ready), per-slot input routing, a 4-seat roster picker
  (AI fills the rest). No host privileges, no NAT, symmetric latency
  for all four; the Phase 10 4-player item then becomes an online mode.

- [x] **Periodic backward-pull fix — render lerp over sim time, not
  arrival time** — the render point is a sim-clock accumulator and the
  lerp brackets on `hostMs` (a uniform 16 ms axis), so the car renders
  at 100% speed always; a 100 ms late frame (the ~1.15 s-periodic real
  delivery gap) no longer spreads one frame's motion over the whole gap
  (16% speed → reads as a backward pull on a corner). Verified with a
  synthetic 100 ms-late-frame probe: sampled speed min = max = median =
  1.00×, zero backward samples (headless, `ai-sim`), plus the flat
  tracks stay bit-identical (`make sim`)
- [x] **Room auto-cleanup + nicknames + status UX** — an empty room is now
  dissolved *and* pruned from the server's room map (previously a
  disconnected room lived on forever — its 60 Hz loop kept running after
  both players left); a finished room the host lingers in (to re-race)
  persists, then is pruned when the last player leaves. Nicknames: each
  player sets a name (persisted, ≤ 12 chars) that rides the EXISTING
  `CONNECT` frame (**no wire change** — old/new clients interoperate), is
  echoed in `HELLO`, broadcast in `PEER_JOINED` (plus a targeted frame to
  the joiner for the host), and shows in the host's “P2 CONNECTED: <name>”
  line, the joiner's prominent “waiting for <host>” message (no longer a
  repurposed button), the results (slot → name), and is drawn **in 3D above
  the kart during the race** (billboarded canvas sprites, `src/nametag.js`).
  `make wscheck` asserts the name exchange (ALFA/BRAVO) + the full room
  lifecycle; `make wse2e` keeps the full loop green (no JS errors with the
  nametags active)
## Phase 10 — Four karts, four players

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

## Phase 11 — World expansion

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

- [x] **Track editor drag fix** — the EDIT-tab point drag had two bugs: the
  pointer position (center-relative *pixels*) was written to the point's
  *world* coord without dividing by `viewScale` (so a dragged point jumped
  `viewScale×` away from the cursor and couldn't be grabbed back), and the
  y-clamp was `Math.max(-125, Math.min(125), p.y)` (a missing paren made
  `Math.min(125)` a no-op, forcing `y=125` on almost any drag). The drag
  now converts pixels→world via `/viewScale` (matching the draw/hit path),
  the clamp is correct, the drag/hit/index all use the live `curIdx`, and
  `pointerup` re-draws so the point greys out. Verified headless
  (Playwright drag: the point lands within 3 px of the cursor)
## Phase 12 — Modes

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

## Phase 13 — Feel & juice

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

## Phase 14 — Persistence & sharing (localStorage, no server)

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

## Phase 15 — Performance

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
- **Accounts / asset pipelines / CDNs** — the server (Phase 9) is a thin
  room-sim backend: no sign-up, no stored profiles; the
  zero-asset rule is a feature (instant load), everything stays
  procedural. Share-a-lap stays a brag string, not a validation.
- **Full 3D physics** — still a 2.5D table: y comes from the spline, no
  rigid-body world.
