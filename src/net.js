/* ------------------------------------------------------------------ *
 *  2-player LAN networking — WebRTC DataChannel, P2P, no server
 *  (plans/2_player_lan.md).
 *
 *  No three/DOM imports: headless-testable. The HOST runs the
 *  authoritative sim (main.js) and streams state; the CLIENT sends
 *  input and renders snapshots (main.js + interp).
 *
 *  Wire protocol — first byte = type, rest is a DataView payload:
 *    0x02 track   host→  u8 trackIdx, u8 hazards (0/1), u8 items (0/1)
 *                                   picker sync (old 3-byte frames: items = keep local)
 *    0x05 prep    host→  u8 trackIdx, u32 cdMs                    "countdown in 3..2..1"
 *    0x03 start   host→  u8 karts, u8 laps, u8 rosterN, i8 steerFlip,
 *                                   f32 simDt, f32[karts*2] grid (u,o pairs)
 *    0x10 input   both   i8 throttle*127, i8 steer*127, u16 ping, u8 flags
 *                                   (flags bit0 = drift, bit1 = use-item; old 5-byte
 *                                   flagless frames decode drift=false, use=false)
 *    0x20 state   host→  u32 hostMs, u16 echoPing, then per kart:
 *                                   f32 x,y,z,heading,speed,steerVel,
 *                                   u8 offRoad, lapDone, posIdx, raceDone, item
 *                                   (pre-item peers decode item = 0; pre-3D peers
 *                                   without the y field decode y = 0 — decodeState)
 *    0x30 finish  host→  u8 n, then per kart u8 idx, f32 finalLapMs
 *    0x40 bye     both   (empty)
 *
 *  Pairing (serverless): host shows a code = base64url(offer SDP) and
 *  the client pastes it; the client's answer comes back as a second
 *  code the host pastes. Two pastes, zero servers, zero infra.
 * ------------------------------------------------------------------ */

export const T_TRACK = 0x02, T_PREP = 0x05, T_START = 0x03, T_INPUT = 0x10, T_STATE = 0x20, T_FINISH = 0x30, T_BYE = 0x40;
const KART_BYTES = 4 * 6 + 5; // six f32 + five u8 (last = held item, items.js)

/* ------------------------- enc / dec (pure) -------------------------
 * dec*() take a DataView over the FULL frame (type byte at 0).
 * Headless-safe: no RTCPeerConnection needed. ------------------------- */
function toView(d) { return d instanceof ArrayBuffer ? d : d.buffer; }
export function encTrack(idx, hazards = 0, items = 0) {
  const v = new DataView(new ArrayBuffer(4)); v.setUint8(0, T_TRACK); v.setUint8(1, idx);
  v.setUint8(2, hazards ? 1 : 0); v.setUint8(3, items ? 1 : 0); return v.buffer;
}
export function encPrep(trackIdx, cdMs) {
  const v = new DataView(new ArrayBuffer(6)); v.setUint8(0, T_PREP); v.setUint8(1, trackIdx); v.setUint32(2, cdMs); return v.buffer;
}
export function encStart({ karts, laps, rosterN, steerFlip, simDt, grid }) { // grid: flat [u,o,...]
  const v = new DataView(new ArrayBuffer(1 + 5 + 4 + grid.length * 4));
  v.setUint8(0, T_START); v.setUint8(1, karts); v.setUint8(2, laps); v.setUint8(3, rosterN);
  v.setInt8(4, steerFlip ? 1 : 0); v.setFloat32(5, simDt);
  let o = 9; for (let i = 0; i < grid.length; i++) { v.setFloat32(o, grid[i]); o += 4; }
  return v.buffer;
}
export function decStart(d) {
  const v = new DataView(toView(d), 0);
  const grid = new Float32Array(v.getUint8(1) * 2);
  let o = 9; for (let i = 0; i < grid.length; i++) { grid[i] = v.getFloat32(o); o += 4; }
  return {
    karts: v.getUint8(1), laps: v.getUint8(2), rosterN: v.getUint8(3),
    steerFlip: v.getInt8(4) !== 0, simDt: v.getFloat32(5), grid,
  };
}
export function encInput(throttle, steer, ping, drift = false, use = false) {
  const v = new DataView(new ArrayBuffer(6)); v.setUint8(0, T_INPUT);
  v.setInt8(1, Math.round(throttle * 127)); // scale -1..1 into the 8-bit field
  v.setInt8(2, Math.round(steer * 127));
  v.setUint16(3, ping & 0xffff);
  v.setUint8(5, (drift ? 1 : 0) | (use ? 2 : 0));  // flags: bit0 = drift, bit1 = use item
  return v.buffer;
}
export function decInput(d) {
  const v = new DataView(toView(d), 0);
  const flags = v.byteLength > 5 ? v.getUint8(5) : 0;
  return { throttle: v.getInt8(1) / 127, steer: v.getInt8(2) / 127, ping: v.getUint16(3),
    drift: (flags & 1) !== 0, use: (flags & 2) !== 0 };
}
export function makeStateEncoder(kartN) {
  // a FRESH buffer per call: the ws send queue holds a reference, so a
  // shared buffer would be overwritten by the next tick before the
  // previous frame flushed (frames delivered with the *next* tick's
  // contents — visible as duplicated/stale state over the wire).
  return (hostMs, echoPing, karts, seq = 0) => {
    const buf = new ArrayBuffer(1 + 4 + 2 + kartN * KART_BYTES + 2);
    const v = new DataView(buf); v.setUint8(0, T_STATE);
    v.setUint32(1, hostMs & 0xffffffff); v.setUint16(5, echoPing & 0xffff);
    let o = 7;
    for (let i = 0; i < karts.length; i++) {
      const k = karts[i];
      v.setFloat32(o, k.pos.x); o += 4;
      v.setFloat32(o, k.pos.y); o += 4;
      v.setFloat32(o, k.pos.z); o += 4;
      v.setFloat32(o, k.heading); o += 4;
      v.setFloat32(o, k.speed); o += 4;
      v.setFloat32(o, k.steerVel); o += 4;
      v.setUint8(o, k.fellOff ? 2 : k.offRoad ? 1 : 0); o += 1;   // 2 = fell off (old peers read it as off-road)
      v.setUint8(o, k.lapDone); o += 1;
      v.setUint8(o, k.posIdx); o += 1;
      v.setUint8(o, k.raceDone ? 1 : 0); o += 1;
      v.setUint8(o, k.item ?? 0); o += 1;
    }
    v.setUint16(7 + kartN * KART_BYTES, seq & 0xffff);   // trailing — old decoders read the prefix and ignore the tail
    return buf;
  };
}
export function decodeState(d, kartN) {
  const v = new DataView(toView(d), 0);
  // legacy peers: pre-item karts are one byte shorter (item = 0); pre-3D
  // karts have no y at all (y = 0). Old clients + new hosts still race.
  const stride = v.byteLength - 7 >= kartN * KART_BYTES ? KART_BYTES
    : v.byteLength - 7 >= kartN * (KART_BYTES - 1) ? KART_BYTES - 1
    : KART_BYTES - 5;
  const karts = new Array(kartN); let o = 7;
  for (let i = 0; i < kartN; i++) {
    // y is present in both the modern (29B) and pre-item (28B) frames; only
    // the pre-3D (24B) layout lacks it — that shifts everything after x
    const f = stride >= KART_BYTES - 1 ? 4 : 0;
    karts[i] = {
      x: v.getFloat32(o),
      y: f ? v.getFloat32(o + 4) : 0,
      z: v.getFloat32(o + 4 + f),
      heading: v.getFloat32(o + 8 + f),
      speed: v.getFloat32(o + 12 + f),
      steerVel: v.getFloat32(o + 16 + f),
    };
    karts[i].offRoad = v.getUint8(o + 20 + f) !== 0;
    karts[i].fellOff = v.getUint8(o + 20 + f) === 2;
    karts[i].lapDone = v.getUint8(o + 21 + f);
    karts[i].posIdx = v.getUint8(o + 22 + f);
    karts[i].raceDone = v.getUint8(o + 23 + f) !== 0;
    karts[i].item = stride === KART_BYTES ? v.getUint8(o + 24 + f) : 0;
    o += stride;
  }
  const tail = 7 + kartN * stride;
  // trailing seq (60 Hz wire): absent on legacy frames → undefined
  const seq = v.byteLength >= tail + 2 ? v.getUint16(tail) : undefined;
  return { hostMs: v.getUint32(1), echoPing: v.getUint16(5), karts, seq };
}
export function encFinish(order, finalLapsMs) {
  const n = order.length;
  const v = new DataView(new ArrayBuffer(2 + n * 5)); v.setUint8(0, T_FINISH); v.setUint8(1, n);
  let o = 2;
  for (let i = 0; i < n; i++) { v.setUint8(o, order[i]); o += 1; v.setFloat32(o, finalLapsMs[i]); o += 4; }
  return v.buffer;
}
export function decFinish(d) {
  const v = new DataView(toView(d), 0);
  const n = v.getUint8(1), order = new Array(n), laps = new Array(n); let o = 2;
  for (let i = 0; i < n; i++) { order[i] = v.getUint8(o); o += 1; laps[i] = v.getFloat32(o); o += 4; }
  return { order, laps };
}
export function encBye() { return new Uint8Array([T_BYE]).buffer; }


