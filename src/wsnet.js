// WSSession — the multiplayer transport (server-authoritative, Plan B).
//
// Drop-in for the old RelaySession: same callback surface (onOpen, onStatus,
// onPrep, onStart, onState, onFinish, onPeerLost, onPeerJoined) and send
// surface (sendInput, sendTrack, sendStart, sendPrep, sendFinish, close).
// The transport swaps from "dumb relay" to "the game server": one WebSocket,
// binary frames in the same wire format as the WebRTC path (net.js), and the
// server is the single sim authority — both humans are pure renderers.
//
// Protocol (one ws per client; the server never sees anything else):
//   C→S  0x41 CONNECT  kind(1 char 'H'|'J') nameLen name [code(4)]
//   S→C  0x41 HELLO    ok(1) code(4) nameLen name slot(1)
//   S→C  0x82 PEER_JOINED slot name
//   S→C  0x81 PEER_LEFT   slot
//   S→C  0x83 KICK        msg  (room dissolved / room full / host left)
//   C→S  0x70 PING (payload = counter) / S→C 0x71 PONG (RTT readout)
//   + the existing net.js frames: 0x02 TRACK, 0x03 START, 0x05 PREP,
//     0x10 INPUT, 0x20 STATE, 0x30 FINISH, 0x40 BYE
//
// The state frame carries the server's full kart array (2 humans + 2 AI on
// the wire — the wire format is kart-count derived, unchanged). The client
// decodes with decodeState(d, kartN) exactly as the WebRTC/relay path.

import { decInput, decStart, decFinish, decodeState, encInput, encTrack, encStart, encBye } from './net.js';
// wire type bytes (the single-line export in net.js is opaque to the
// import-graph check — keep the values in one documented place)
const T_TRACK = 0x02, T_PREP = 0x05, T_START = 0x03, T_STATE = 0x20, T_FINISH = 0x30;

export class WSSession {
  constructor(url) {
    this._url = url;
    this._ws = null;
    this._cbs = {};
    this._buf = new Uint8Array(0);
    this._closed = false;
    this._intentional = false;
    this._inAt = 0; this._inUse = false; this._inDrift = false;
    this._pingAt = 0; this._pingN = 0;
    this.isWS = true;
    this.status = 'offline';
    this.connected = false;   // HELLO ok received
    this.code = null;      // room code (assigned by the server on CONNECT 'H')
    this.slot = -1;        // my kart slot (0 = host, 1 = joiner)
    this.kartN = 4;        // the server always simulates 4 (2 humans + 2 AI)
    this.rttMs = 0;
    this.peerJoined = false;
    this._liveness = null;
  }

  onOpen(cb) { this._cbs.open = cb; }
  onStatus(cb) { this._cbs.status = cb; }
  onPrep(cb) { this._cbs.prep = cb; }
  onTrack(cb) { this._cbs.track = cb; }
  onStart(cb) { this._cbs.start = cb; }
  onState(cb) { this._cbs.state = cb; }
  onFinish(cb) { this._cbs.finish = cb; }
  onInput(cb) { this._cbs.input = cb; }
  onPeerLost(cb) { this._cbs.peerLost = cb; }
  onPeerJoined(cb) { this._cbs.peerJoined = cb; }

  _setStatus(s) {
    if (this.status !== s) {
      this.status = s;
      if (this._cbs.status) this._cbs.status(s);
    }
  }

  /** open(kind, name, code) → resolves true on HELLO ok, false on failure.
   * kind 'H' = create a room (server assigns the code), 'J' = join by code. */
  open(kind, name, code) {
    this._closed = false; this._intentional = false;
    return new Promise((res) => {
      let settled = false;
      const done = (ok) => {
        if (settled) return; settled = true;
        this.connected = ok;
        if (ok) this._setStatus('online'); else this._setStatus('offline');
        res(ok);
      };
      let ws;
      try {
        ws = new WebSocket(this._url);
      } catch {
        this._setStatus('offline');
        res(false);
        return;
      }
      this._ws = ws;
      ws.binaryType = 'arraybuffer';   // the default is 'blob' — frames must be ArrayBuffers
      const timeout = setTimeout(() => {
        try { ws.close(); } catch { /* ignore */ }
        done(false);
      }, 8000);
      ws.onopen = () => {
        this._setStatus('connecting');
        const b = new Uint8Array(3 + name.length + (code ? 4 : 0));
        b[0] = 0x41;
        b[1] = kind.charCodeAt(0);
        b[2] = name.length;
        for (let i = 0; i < name.length; i++) b[3 + i] = name.charCodeAt(i);
        if (code) for (let i = 0; i < 4; i++) b[3 + name.length + i] = code.charCodeAt(i);
        ws.send(b.buffer);
      };
      ws.onmessage = (ev) => {
        const d = new Uint8Array(ev.data instanceof ArrayBuffer ? ev.data : ev.data);
        this._handle(d, done, timeout);
      };
      ws.onerror = () => { clearTimeout(timeout); done(false); };
      ws.onclose = () => {
        clearTimeout(timeout);
        this.connected = false;
        this.peerJoined = false;
        this._setStatus('offline');
        if (!this._intentional) {
          if (this._cbs.peerLost) this._cbs.peerLost();
        }
      };
      this._liveness = setInterval(() => {
        if (!this.connected || ws.readyState !== 1) return;
        this._pingN++;
        this._pingAt = performance.now();
        const b = new Uint8Array(1 + 4);
        b[0] = 0x70;
        new DataView(b.buffer).setUint32(1, this._pingN);
        ws.send(b.buffer);
      }, 600);
    });
  }

  _handle(d, done, timeout) {
    switch (d[0]) {
      case 0x41: {  // HELLO
        const ok = d[1];
        if (!ok) {
          if (this._cbs.status) this._cbs.status('offline');
          done(false);
          return;
        }
        clearTimeout(timeout);
        this.code = String.fromCharCode(d[2], d[3], d[4], d[5]);
        const nameLen = d[6];
        const name = d.length > 7 + nameLen ? String.fromCharCode(...d.subarray(7, 7 + nameLen)) : '';
        this.slot = d[7 + nameLen];
        done(true);
        if (this._cbs.open) this._cbs.open(this.code, name, this.slot);
        return;
      }
      case 0x82:  // PEER_JOINED
        this.peerJoined = true;
        if (this._cbs.peerJoined) this._cbs.peerJoined();
        return;
      case 0x81:  // PEER_LEFT — mid-race the kart becomes AI; the room only
        // dissolves when the HOST leaves (that also arrives as a KICK).
        return;
      case 0x83:  // KICK — the room is gone (or we were rejected)
        this.connected = false;
        this._setStatus('offline');
        if (this._cbs.peerLost) this._cbs.peerLost();
        return;
      case 0x71:  // PONG
        this.rttMs = Math.min(999, Math.max(0, Math.round(performance.now() - this._pingAt)));
        return;
      case T_PREP: {  // 0x05
        if (this._cbs.prep) this._cbs.prep({ trackIdx: d[1], cdMs: new DataView(d.buffer).getUint32(2) });
        return;
      }
      case T_TRACK: {  // 0x02 — the server forwards the host's live picker
        // (idx, hazards, items — all u8, encTrack layout) so the joiner's
        // local field (item boxes, hazards) matches the server's sim
        if (this._cbs.track) this._cbs.track(d[1], d[2], d[3]);
        return;
      }
      case T_START: {  // 0x03 — the server echoes the start (both clients sync
        // the countdown from the wall clock); the roster size rides along
        const st = decStart(d);
        if (st.karts) this.kartN = st.karts;
        if (this._cbs.start) this._cbs.start(st);
        return;
      }
      case T_STATE:  // 0x20 — decode before the cb (the n2 contract is decoded st)
        // the frame is length-derived: modern = 7 + kartN*29 + 2 (trailing
        // seq), legacy = 7 + kartN*29 (no seq). 1v1 races send 2-kart
        // frames, so never trust a cached kartN for the stride.
        {
          const modern = (d.byteLength - 9) % 29 === 0 && d.byteLength >= 9 + 29;
          const kartN = modern ? (d.byteLength - 9) / 29
            : Math.max(1, Math.floor((d.byteLength - 7) / 29));
          if (this._cbs.state) this._cbs.state(decodeState(d, kartN));
        }
        return;
      case T_FINISH: {  // 0x30
        if (this._cbs.finish) this._cbs.finish(decFinish(d));
        return;
      }
      case 0x10: {  // T_INPUT (the server relays it back for the RTT readout)
        if (this._cbs.input) this._cbs.input(decInput(d));
        return;
      }
      case 0x40:  // T_BYE
        return;
    }
  }

  /** 60 Hz rate gate with drift/use edge bypass — same contract as the relay. */
  sendInput(throttle, steer, drift, use) {
    if (!this.connected || !this._ws || this._ws.readyState !== 1) return;
    const now = performance.now();
    if (now - this._inAt < 16 && !!use === this._inUse && !!drift === this._inDrift) return;
    this._inAt = now; this._inUse = !!use; this._inDrift = !!drift;
    this._ws.send(encInput(throttle, steer, 0, drift, use));
  }

  sendTrack(idx, hazards, items) {
    if (!this.connected || !this._ws || this._ws.readyState !== 1) return;
    this._ws.send(encTrack(idx, hazards || 0, items || 0));
  }
  sendStart(info) {
    if (!this.connected || !this._ws || this._ws.readyState !== 1) return;
    this._ws.send(encStart(info));
  }
  /** the server broadcasts PREP itself — nothing to send */
  sendPrep() { /* no-op */ }
  /** FINISH is server-authoritative — the client never sends it */
  sendFinish() { /* no-op */ }

  close() {
    this._intentional = true;
    try {
      if (this._ws && this._ws.readyState === 1) this._ws.send(encBye());
      if (this._liveness) clearInterval(this._liveness);
      if (this._ws) this._ws.close();
    } catch { /* ignore */ }
    this._ws = null;
    this.connected = false;
    this._setStatus('offline');
  }
}

/** default ws url: ?ws= override, else same-origin /ws (works behind the
 * Nginx proxy and the single-container deploy) */
export function wsUrl() {
  const q = new URLSearchParams(location.search).get('ws');
  if (q) return q;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws`;
}
