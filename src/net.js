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

const b64u = {
  enc: buf => btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  dec: str => {
    let s = str.trim().replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    const bin = atob(s), out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  },
};

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
  const buf = new ArrayBuffer(1 + 4 + 2 + kartN * KART_BYTES);
  const v = new DataView(buf); v.setUint8(0, T_STATE);
  return (hostMs, echoPing, karts) => {
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
      v.setUint8(o, k.offRoad ? 1 : 0); o += 1;
      v.setUint8(o, k.lapDone); o += 1;
      v.setUint8(o, k.posIdx); o += 1;
      v.setUint8(o, k.raceDone ? 1 : 0); o += 1;
      v.setUint8(o, k.item ?? 0); o += 1;
    }
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
    karts[i].lapDone = v.getUint8(o + 21 + f);
    karts[i].posIdx = v.getUint8(o + 22 + f);
    karts[i].raceDone = v.getUint8(o + 23 + f) !== 0;
    karts[i].item = stride === KART_BYTES ? v.getUint8(o + 24 + f) : 0;
    o += stride;
  }
  return { hostMs: v.getUint32(1), echoPing: v.getUint16(5), karts };
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

/* ------------------------- pairing codes ------------------------- */
export function codeFromSdp(sdp) { return 'MKR-' + b64u.enc(new TextEncoder().encode(sdp)); }
export function sdpFromCode(code) {
  try { return new TextDecoder().decode(new Uint8Array(b64u.dec(String(code).replace(/^MKR-?/i, '')))); }
  catch { return ''; }
}

/* ------------------------- session ------------------------- */
export class NetSession {
  constructor(role, cbs = {}) {
    this.role = role; // 'host' | 'join'
    this.pc = null; this.ch = null; this.open = false; this.rtt = 0;
    this.kartN = 4; // default roster size; main.js overwrites per race
    this.closed = false;
    this.cbs = cbs; // onOpen onTrack onPrep onStart onState onFinish onInput onClose onStatus
  }
  _status(s) { this.cbs.onStatus && this.cbs.onStatus(s); }
  _mkPc() {
    if (this.pc) return this.pc;
    this.pc = new RTCPeerConnection({ iceServers: [] }); // LAN: host candidates suffice
    this.pc.onconnectionstatechange = () => {
      const s = this.pc.connectionState;
      if (s === 'connected') this._status('connected');
      else if (s === 'failed') { this._status('failed'); this.close(); }
      else if (s === 'disconnected' || s === 'closed') this.close();
    };
    const wire = ch => {
      this.ch = ch; ch.binaryType = 'arraybuffer';
      ch.onopen = () => { this.open = true; this._status('open'); this.cbs.onOpen && this.cbs.onOpen(); };
      ch.onclose = () => this.close();
      ch.onmessage = e => this._route(e.data);
    };
    if (this.role === 'host') wire(this.pc.createDataChannel('kart', { ordered: true }));
    else this.pc.ondatachannel = e => wire(e.channel);
    return this.pc;
  }
  _view(buf) { return buf instanceof ArrayBuffer ? buf : buf.buffer; }
  _route(buf) {
    const view = this._view(buf), d = new DataView(view, 0, view.byteLength);
    switch (d.getUint8(0)) {
      case T_TRACK: this.cbs.onTrack && this.cbs.onTrack(d.getUint8(1),
        view.byteLength > 2 ? d.getUint8(2) : undefined,
        view.byteLength > 3 ? d.getUint8(3) : undefined); break;
      case T_PREP: this.cbs.onPrep && this.cbs.onPrep({ trackIdx: d.getUint8(1), cdMs: d.getUint32(2) }); break;
      case T_START: this.cbs.onStart && this.cbs.onStart(decStart(d)); break;
      case T_STATE: this.cbs.onState && this.cbs.onState(decodeState(d, this.kartN)); break;
      case T_FINISH: this.cbs.onFinish && this.cbs.onFinish(decFinish(d)); break;
      case T_INPUT: this.cbs.onInput && this.cbs.onInput(decInput(d)); break;
      case T_BYE: this.close(); break;
    }
  }
  // Non-trickle flow: the pasted code must contain ALL our ICE candidates,
  // which only land in pc.localDescription after gathering completes.
  // (createOffer().sdp has none — encoding that yields an unreachable code.)
  async _gatheredSdp() {
    const pc = this.pc;
    if (pc.iceGatheringState !== 'complete') {
      await new Promise(res => {
        const t = setTimeout(res, 2000); // LAN gathering is instant; safety net
        pc.addEventListener('icegatheringstatechange', () => {
          if (pc.iceGatheringState === 'complete') { clearTimeout(t); res(); }
        });
      });
    }
    return pc.localDescription.sdp;
  }
  async hostStart() {
    const pc = this._mkPc();
    await pc.setLocalDescription(await pc.createOffer());
    this._status('awaiting-peer');
    return codeFromSdp(await this._gatheredSdp());
  }
  async hostAnswer(code) {
    const sdp = sdpFromCode(code);
    if (!sdp) throw new Error('bad code');
    await this.pc.setRemoteDescription({ type: 'answer', sdp });
  }
  async joinOffer(code) {
    const sdp = sdpFromCode(code);
    if (!sdp) throw new Error('bad code');
    const pc = this._mkPc();
    await pc.setRemoteDescription({ type: 'offer', sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    this._status('awaiting-host');
    return codeFromSdp(await this._gatheredSdp());
  }
  inputNow(throttle, steer, drift = false, use = false) {
    if (this.open) this.ch.send(encInput(throttle, steer, (Date.now() / 1000 | 0) & 0xffff, drift, use));
  }
  sendTrack(idx, hazards = 0, items = 0) { if (this.open) this.ch.send(encTrack(idx, hazards, items)); }
  sendPrep(trackIdx, cdMs) { if (this.open) this.ch.send(encPrep(trackIdx, cdMs)); }
  sendStart(info) { if (this.open) this.ch.send(encStart(info)); }
  sendState(buf) { if (this.open) this.ch.send(buf); }
  sendFinish(buf) { if (this.open) this.ch.send(buf); }
  close() {
    if (this.closed) return;
    this.closed = true;
    const wasOpen = this.open; this.open = false;
    try { if (this.ch) { this.ch.send(encBye()); this.ch.close(); } } catch { /* gone */ }
    try { this.pc && this.pc.close(); } catch { /* gone */ }
    if (wasOpen || this.pc) this._status('closed');
    this.cbs.onClose && this.cbs.onClose();
  }
}
