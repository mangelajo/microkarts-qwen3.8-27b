# Plan — 2-Player over LAN (serverless)

**Status:** planning (not started). Picked up in a later session.
**Related roadmap item:** Phase 2.4 "2-player (local, same keyboard)". This plan *replaces* the
same-keyboard version with a **LAN** version: each player on their **own device/browser**, driving
with their own WASD+arrows. That is actually *easier* on input (no key remapping) and turns the
game from a solo demo into a walk-up party game.

---

## TL;DR — viability

- **2-player over LAN: yes, fully viable.** Kart state is ~112 bytes and input is 2 bytes/tick —
  trivial LAN bandwidth. Perceivable latency is a few ms.
- **Serverless, no relay: yes.** Use **WebRTC DataChannel** (P2P, encrypted, no server on the data
  path). One peer runs the **authoritative sim** and streams state; the other renders it.
- **UDP-multicast auto-discovery: not directly, with browser Web APIs.** There is **no** raw UDP /
  multicast socket in Chrome/Safari. `BroadcastChannel`/`localStorage`/`SharedWorker` only work
  *within one browser on one machine*, so they can't do cross-device discovery. So "walk in, press
  play, auto-find each other" is **not** achievable with pure browser APIs.

  What *is* serverless and achievable: **WebRTC P2P with manual signaling** — the host shows an
  on-screen **code/QR**, the other player enters/scans it. No server, no relay, P2P and encrypted.
  The discovery cost is one code entry (or a QR scan). This is the standard "no infra" WebRTC UX.

  If literal zero-typing discovery is a must for v2, the only option is a **~30-line local UDP
  beacon** helper (a trivial LAN process that lists peers). That is technically a small "server",
  so it's a separate opt-in, not the default.

**Decision for this plan:** **WebRTC DataChannel, P2P, host-authoritative sim, manual code/QR
signaling.** No server, no relay, ~1 code entry to pair. Everything else in the game is untouched.

---

## Why "host-authoritative" (one browser is the sim)

The user's instinct — "one of the browsers becomes the server/sim state" — is the right call, and
it's the **simplest robust** model:

- The **host** runs `step()` + `collideKarts()` exactly as today. It simulates *both* human karts
  (yours from your sent input, the peer's from the peer's sent input) plus the AI karts.
- The **client** simulates nothing. It sends its throttle/steer each frame and **interpolates**
  the host's state snapshots for rendering.
- Float-precision differences between machines are *irrelevant* (only the host integrates), and
  any future randomisation (items!) doesn't desync. We don't *need* the sim to be deterministic to
  sync, even though today it already happens to be (no RNG in the hot path).
- **Latency for the remote player:** client→host (1 frame) + host→client (1 frame) ≈ **2–6 ms** on
  a LAN. Comfortable for a chill kart game. We add ~30–60 ms interpolation buffer for smoothness.

The heavier alternative — **predictive lockstep with rollback** (each peer simulates everything and
only exchanges inputs) — is more code and only worth it if we later want true peer-to-peer equality
or sub-frame input latency. **Skip it for v1.** It stays an option because the sim is already
deterministic (no RNG), so lockstep would be a clean add if ever needed.

---

## Architecture

```
        ┌─────────────── LAN (same subnet) ───────────────┐
        │                                                 │
   HOST browser                                   CLIENT browser
 ┌───────────────────────┐                ┌───────────────────────┐
 │  Menu: [HOST]          │                │  Menu: [JOIN]         │
 │  (creates the sim)     │                │  (enters code/QR)     │
 └───────────┬───────────┘                └───────────┬───────────┘
        RTC peer connection (WebRTC DataChannel, P2P)
             ▲                                        │
             │  state frames (~112B, ~30Hz)           │  input (2B, ~30Hz)
             └────────────────────────────────────────┘
 Host: fixed-step sim, authoritative.  Client: interpolate+render, no sim.
```

- **Roles:** the peer that presses **HOST** runs the authoritative sim. The peer that presses
  **JOIN** is the client. (Later: pick the lower-RTT peer as host — unnecessary now.)
- **Transport:** one `RTCDataChannel`, **reliable + ordered** for v1 (traffic is tiny; reliability
  removes a whole class of dropped-packet bugs). If the 30 Hz state stream ever lags under load,
  split into two channels (unreliable/non-ordered for state, reliable for everything else).
- **No STUN/TURN needed on a LAN** — host candidates (`addIceCandidate`) alone will connect two
  peers on the same subnet. Keep the ICE loop minimal.

---

## Message protocol

Small binary frames on the DataChannel. Header byte = type, then a `DataView`.

| type | name    | dir    | payload                                    | when            |
|------|---------|--------|--------------------------------------------|-----------------|
| 0x01 | hello   | both   | {name, skill, seed}  (strings/ints)         | on connect      |
| 0x02 | track   | host→  | {trackIdx: u8}                             | on start        |
| 0x03 | start   | host→  | {laps: u8, grid: u8 per kart, SIM_DT: f32}  | on start        |
| 0x10 | input   | both   | {throttle: i8, steer: i8}  (−1/0/1)         | ~each frame     |
| 0x20 | state   | host→  | 4 × kartState (see below)                   | ~each fixed tick|
| 0x30 | finish  | host→  | {order: u8×4, times: f32×4}                 | on finish       |
| 0x40 | bye     | both   | (empty)                                     | on close        |

`kartState` (per kart, ~24 B, `DataView` in a shared `ArrayBuffer`):
`f32 x, f32 z, f32 heading, f32 speed, f32 steerVel, u8 offRoad, u8 lapDone, u8 posIdx, u8 raceDone`
→ **4 karts ≈ 100–120 bytes/frame.** At 30 Hz that's ~3–4 KB/s. Negligible.

**Signaling** (the manual part). The host generates `RTCPeerConnection` + `createOffer()`, and we
encode `{sdp, sessionCode}` for the peer to paste in; then host receives the `answer`. To keep it to
**one** manual step, present the SDP as:
- an **on-screen code** (base64, truncated with a copy button) *and*
- a **QR** (add a tiny QR lib, or render to a `<canvas>`) that a phone/tablet browser camera can
  open via a deep link `index.html#join=...`.

The `#join=` hash means: if the client loads the page *from the QR/URL*, it already has the offer
and only needs to post its answer back — and for that we still need the DataChannel to exist first,
so v1 is: **both open `index.html` normally, host shows a code, peer types it.** The QR-into-a-deep-
link variant is a nice-to-have once the base flow works.

---

## Sim changes (localized, low-risk)

The goal: pull the per-tick simulation out of `animate()` into a clean, callable `simulateTick(dt)`
so the host can drive it on a **fixed timestep**, and so `ai-sim` and the networked host share the
exact same path.

`src/main.js` currently does (inside `animate()`, the `racing` branch):
```
for (const k of karts) k.step(dt, inFor(k), now);
collideKarts();
...
```

1. **Extract `simulateTick(dt, nowMs)`:**
   - loops karts, computes `throttle/steerIn` via a per-kart `inputFor(k)` (player → keys, AI →
     `aiControl`), calls `k.step(dt, throttle, steerIn, nowMs)`, then `collideKarts()`.
   - `inputFor(k)` for the **remote human kart** reads the *latest input received from the DataChannel*
     instead of the keyboard. That's the only gameplay change the network makes.
2. **Fixed timestep on the host:** accumulator pattern.
   ```
   acc += clamp(clock.getDelta(), 0, 0.1);
   while (acc >= SIM_DT) {
     simTime += SIM_DT;
     simulateTick(SIM_DT, simTime);
     broadcastState();           // host→ peer
     acc -= SIM_DT;
   }
   ```
   Add `SIM_DT = 1/60` to `src/config.js`. **Solo/1P keeps its current real-delta step** (calls
   `simulateTick(game.dt)` once) so there is zero feel change for existing players — only the
   networked host switches to fixed-step.
3. **Lap timing on sim-time:** `Kart.updateLapLogic(now)` currently uses `performance.now()`. Change
   the host to pass the accumulated `simTime` so lap times match the snapshot stream and are stable
   (also makes them deterministic). Solo can keep `performance.now()`; the field is already a `now`
   parameter.
4. **`resetKarts()` grid for 2P:** put the two humans in the two *front* cells. Currently
   `order = [karts[0], player, karts[1], karts[2]]`; in 2P reorder so P1 & P2 lead and AI fill the
   back. Trivial re-order of that array.

All of this is additive — a build flag / presence of a peer decides whether the fixed-step host path
or the solo path runs. **Solo must remain byte-for-byte the current behaviour** (regression guard:
`make sim` + the existing headless smoke test).

---

## Client rendering (no sim)

- Keep a ring of the last ~8 host `[ArrayBuffer, recvTime]` state frames.
- **Interpolate** each kart between the two frames that bracket `nowMs − INTERP_DELAY`
  (`INTERP_DELAY ≈ 30–60 ms`, well above LAN RTT → smooth, hides jitter).
- **Extrapolate** short-term when a frame is late: `heading += steerVel*turnFactor(speed)*Δt`,
  `pos += forward(speed)*Δt`. Kart tops out at ~30 u/s, so even a 100 ms miss is ~3 u — stable to
  guess for a few frames, then snap on the next real frame.
- Drive the local **cosmetic** FX (engine pitch, wheel spin, roll/pitch) from the interpolated speed
  — same as today, just fed by interpolated speed instead of own `k.speed`.
- **Optional v1.5 polish:** if 60 ms feels laggy in the peer's *own* kart, add **local prediction of
  self** (run a local `step()` for your one kart with your own input, reconcile to host snapshots).
  One kart, small scope — only if playtest says so. Don't build it up-front.
- Add **`src/interp.js`** (new, ~80 lines): `pushFrame`, `sampleState(offsetMs)` returning per-kart
  `{x,z,heading,speed}` + metadata. Pure function → unit-testable with fake frames (no WebGL needed).

---

## Menu / UI changes

`src/hud.js` + `index.html` (menu overlay, the `#trackWrap` region and below the start button):

- Add a **mode** row next to the track chips: `[ SOLO ] [ HOST 2P ] [ JOIN 2P ]`.
  - **SOLO** = current game, unchanged.
  - **HOST 2P** → creates the `RTCPeerConnection`, shows the code/QR panel ("Waiting for player 2…"),
    disables the track picker until locked, then the normal countdown.
  - **JOIN 2P** → text field for the code; on submit, completes the WebRTC handshake, then the
    client sits at a "Connected — host will start" screen.
- A **connection status** chip (e.g. top-right): `● P2 connected (12 ms)` / `● no peer`.
- **Track in 2P:** the *host* owns the picker; on start it sends `track` + both call the existing
  `selectTrack(idx)` (no geometry is transmitted — both build from `src/tracks.js`). Until start, the
  client can preview the track the host selects (host broadcasts `track` live on change).
- **Kart identity/colors:** host = you (existing red), client = new color (e.g. cyan). P2 kart is just
  a `Kart` with `isPlayer:false` *from the host's perspective* (the host drives it from input, not
  `aiControl`) — so add a `k.net` flag so `inputFor()` routes it to the DataChannel input instead of
  `aiControl` **and** excludes it from the AI count.
- **2P roster:** default **2 humans + 2 AI = 4 karts** (keeps the pack feel; current `karts.length`
  stays 4). Offer a menu toggle `[ 1v1 (no AI) ] [ 2H + 2 AI ]`. Implementation = set `N_AI` and
  reorder the grid. (1v1 is just 2 humans + 2 AI removed.)

Keyboard: **no remapping needed** — each device is a full browser with its own WASD+arrows. This is
the key simplification vs. the roadmap's same-keyboard 2P.

---

## Discovery / pairing UX (the honest part)

Pure browser, cross-device, **no infrastructure**:
1. Host opens the game → **HOST 2P** → screen shows a code: `MKE-8F3K-2QZA` (+ QR) and "waiting…".
2. Player 2 opens the game on their tablet/phone (any device on the LAN) → **JOIN 2P** → types the
   code (the code is a *routing hint*; the real pairing is the WebRTC SDP the host shows).
   - Simplest v1: **no code needed at all** — host shows the raw (base64) offer as a copy field; peer
     pastes it into their "JOIN" field; host shows the answer; peer pastes back. Two pastes, zero
     servers, zero infra. Slightly clunky; the QR deep-link removes the typing.
3. DataChannel opens → status chip goes green → host picks track → countdown.

**If literal "walk up and it finds the other tablet" is required**, add in **v2** a tiny UDP beacon:
a ~30-line Node/Go helper (`make net`) that listens on a LAN port; each browser (on load) sends a
`hello` and lists peers; clicking a peer name starts the WebRTC handshake by exchanging SDP through
the beacon. This is a small local process (a "server" in name only), so it's opt-in, not the default.

---

## Files

| file | change |
|------|--------|
| `src/config.js` | add `SIM_DT`, `INTERP_DELAY`, 2P roster consts, P2 color |
| `src/main.js` | refactor `animate()` → `simulateTick(dt, nowMs)`; fixed-step host loop; `inputFor(k)` incl. `net` routing; 2P grid order; wire net start/finish |
| `src/net.js` **(new)** | the whole WebRTC layer: session, `RTCDataChannel`, code/QR build, encode/decode frames, `sendInput`, `onState/onStart/onFinish` callbacks. No three/scene imports (keeps it headless-testable). |
| `src/interp.js` **(new)** | client-side frame ring + interpolate/extrapolate. Pure, unit-testable. |
| `src/kart.js` | add `k.net` flag (route to input buffer, exclude from AI); no physics change |
| `src/hud.js` | mode row (SOLO/HOST/JOIN), code field + QR panel, connection status chip, 1v1 toggle |
| `index.html` | DOM for the above (`.mode` chips, `#joinField`, `#qrcode`, `#netStatus`) |
| `ai-sim/` | optionally add a `net-sim` that feeds two "human input" streams through `simulateTick` and asserts both humans finish — reuses the existing harness pattern, no WebGL |

Keep solo/1P code paths intact; all 2P is additive behind "a peer is present".

---

## Phases (one commit each, each independently shippable)

- **P0 — Sim refactor (no network).** Extract `simulateTick(dt, nowMs)`; add `SIM_DT`; host-ready
  fixed-step *behind a flag*; `lap` on sim-time. Green: `make sim` + headless smoke. *Nothing changes
  for players.* — this is the de-risking step.
- **P1 — Same-machine net round-trip.** `src/net.js` + a `[HOST]/[JOIN]` mode where host & client run
  in **two tabs of the same browser/machine** (ICE host candidates connect localhost). Client renders
  host state; both drive real karts. **This is our dev harness — no second device needed to prove the
  protocol end-to-end.** Green: 2 tabs, both finish a race.
- **P2 — Real LAN.** Point a second tablet/phone at the same `http://<host-ip>:8000`. Code/QR pairing.
  Verify on a real network; tune `INTERP_DELAY`. Green: two physical devices race smoothly.
- **P3 — UX polish.** QR deep-link pairing, connection latency readout, 1v1 toggle, "peer's own-kart"
  local prediction *if* playtest lags.
- **(v2, opt-in) — UDP beacon** for zero-typing auto-discovery, only if required.

---

## Risks / gotchas

- **No cross-device discovery in browser APIs** — accept manual code/QR (or v2 beacon). Don't waste
  time trying raw UDP in a tab; it's not there.
- **CORS/mixed-content:** WebRTC is fine over `http://` on a LAN (no `wss:` needed). But browsers may
  gate mic/camera for QR scanning on non-localhost over plain HTTP — the **code-entry** path sidesteps
  that entirely, which is why it's the v1 default.
- **Fixed-step only on the host.** Solo must keep variable step to preserve current feel (regression).
- **Don't make the client simulate.** The moment the client also runs `step()`, you inherit
  float-drift sync problems. Client = render-only until someone explicitly wants lockstep.
- **Kart count & `aiControl` must skip the `net` kart.** Otherwise the peer's kart is also AI-driven
  and fights the real player.
- **`game` in `config.js` is shared state** — the client doesn't own the authoritative `game`
  (it mirrors it from `hello/start/finish` frames). Keep the client's `game` strictly a render mirror.

---

## Acceptance criteria

- Solo 1P is **unchanged** in feel; `make sim` green; headless boot smoke still passes (canvas renders,
  no console errors).
- Two tabs on one machine: both players drive, both finish, results screen correct on both.
- Two physical devices on the same LAN: pair via code, race a full 3-lap session, remote input
  latency imperceptible (< ~50 ms perceived), no desync after 3 laps.
- `make sim` (or `net-sim`) drives two human input streams through `simulateTick` on **every
  track** and asserts both finish — the "broken sim" safety net extends to 2P.
- Closing/disconnecting one peer cleanly drops back to solo (no stuck state, no leak in the rAF loop).
