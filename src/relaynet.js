/* ------------------------------------------------------------------ *
 *  Relay transport: the SAME binary frames as net.js, carried over a
 *  small long-poll relay (api/relay.php + api/rooms.php) instead of a
 *  WebRTC data channel — for playing over the internet without LAN /
 *  QR wrangling. A room code (4 chars, A–Z2–9) replaces the two-code
 *  SDP paste. Drop-in for NetSession: same cbs + send surface.
 *
 *  Zero DOM: headless-testable (Node fetch + the relay contract).
 *  Wire: one new type byte —
 *    0x41 hello  both   u8 role (0 = host, 1 = joiner) — the host
 *                 re-sends it every 5 s as a keep-alive; a joiner with
 *                 no host frame for 10 s declares the link closed.
 *  Old WebRTC peers never see it (relay-only), so the LAN path and its
 *  backward-compat guarantees are untouched.
 * ------------------------------------------------------------------ */
import {
  encTrack, encPrep, encStart, encFinish, encInput, encBye,
  decStart, decInput, decFinish, decodeState,
} from './net.js';

export const T_HELLO = 0x41;
export const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** 4-char room code (A–Z2–9 — no I/O/0/1). Seeded = testable. */
export function genRoomCode(rng = Math.random) {
  let s = '';
  for (let i = 0; i < 4; i++) s += CODE_CHARS[Math.floor(rng() * CODE_CHARS.length) % CODE_CHARS.length];
  return s;
}

export class RelaySession {
  constructor(role, cbs = {}, apiBase = '') {
    this.role = role;             // 'host' | 'join'
    this.cbs = cbs;              // onOpen onTrack onPrep onStart onState
                                // onFinish onInput onStatus onClose
    this.api = apiBase.replace(/\/$/, '');
    this.open = false;
    this.active = false;
    this.code = '';
    this.name = '';
    this.trackIdx = 0;           // host's current track (rooms.json heartbeat)
    this.lastSeq = 0;
    this.lastHostFrameAt = 0;
    this.keepAliveAt = -1e9;   // -inf: the first hello fires immediately
    this.kartN = 4;   // default roster; the START frame overwrites (ordered relay)
    this.closedFired = false;
  }

  _status(s) { this.cbs.onStatus && this.cbs.onStatus(s); }

  /* ---- host: register a room, wait for the joiner's hello ---- */
  hostStart(name = 'HOST', trackIdx = 0, rng = Math.random) {
    this.code = genRoomCode(rng);
    this.name = name;
    this.trackIdx = trackIdx;
    this.active = true;
    this._status('awaiting-peer');
    this._heartbeat();
    this._heartTimer = setInterval(() => {
      if (this.active && this.role === 'host') this._heartbeat();
    }, 5000);
    this._pollLoop();
    return Promise.resolve('MKR-' + this.code);
  }

  _heartbeat() {
    // rooms.json lobby entry + a keep-alive frame the joiner can watch
    fetch(this.api + '/api/rooms.php', { method: 'POST', keepalive: false,
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ code: this.code, name: this.name, track: this.trackIdx })
    }).catch(() => {});
    if (performance.now() - this.keepAliveAt > 5000) this._sendHello();
  }

  /* ---- joiner: join a room, wait for the host's first frame ---- */
  joinOffer(code, name = 'P2') {
    this.code = (code || '').toUpperCase().replace(/[^A-Z2-9]/g, '').slice(-8);
    if (this.code.length < 4) return Promise.reject(new Error('bad room code'));
    this.name = name;
    this.active = true;
    this._status('awaiting-host');
    this._sendHello();
    this._pollLoop();
    return Promise.resolve(this.code);
  }

  /* the host's hostAnswer is a no-op on the relay (no SDP exchange) */
  hostAnswer() { return Promise.resolve(); }

  close() {
    if (!this.active) return;
    this.active = false;
    clearInterval(this._heartTimer);
    clearInterval(this._aliveTimer);
    if (this.open && !this.closedFired) {
      this.closedFired = true;
      this._post(this._buf(encBye()), this.role === 'host' ? 'HOST' : 'P2');
      this.cbs.onClose && this.cbs.onClose();
    }
  }

  /* ---- keep-alive liveness (joiner-side; the host is always live) ---- */
  _startAliveWatch() {
    if (this._aliveTimer || this.role !== 'join') return;
    this._aliveTimer = setInterval(() => {
      if (this.active && this.open && !this.closedFired &&
          performance.now() - this.lastHostFrameAt > 10000) {
        this.close();   // full close path: status + onClose → onPeerLost restores the menu
      }
    }, 2000);
  }

  /* ---- the long-poll receive loop (reconnects with back-off) ---- */
  _pollLoop() {
    if (this._polling) return;
    this._polling = true;
    let backoff = 500;
    const tick = async () => {
      if (!this.active) { this._polling = false; return; }
      try {
        const r = await fetch(this.api + '/api/relay.php?room=' + this.code +
          '&after=' + this.lastSeq, { keepalive: false });
        const j = await r.json();
        backoff = 500;
        if (j && j.msgs) for (const m of j.msgs) {
          try { this._onMsg(m); }
          catch { /* one malformed frame must not kill the session */ }
        }
      } catch {
        await new Promise(s => setTimeout(s, backoff));
        backoff = Math.min(backoff * 2, 5000);
      }
      if (this.active) tick();   // always reschedule — even after an error
    };
    tick();
  }

  _onMsg(m) {
    this.lastSeq = Math.max(this.lastSeq, m.seq || 0);
    const from = (m.from || '').toLowerCase() === 'host' ? 'host' : 'join';
    if (from === (this.role === 'host' ? 'host' : 'join')) return; // own echo
    if (this.role === 'join' && from === 'host') this.lastHostFrameAt = performance.now();
    const buf = Uint8Array.from(atob(m.data), c => c.charCodeAt(0)).buffer;
    const d = new DataView(buf);
    switch (d.getUint8(0)) {
      case T_HELLO:
        if (!this.open) {
          this.open = true; this._status('connected');
          this.cbs.onOpen && this.cbs.onOpen();
          if (this.role === 'join') this._startAliveWatch();
        }
        break;
      case 0x02: this.cbs.onTrack && this.cbs.onTrack(d.getUint8(1), d.byteLength > 2 ? d.getUint8(2) : undefined,
        d.byteLength > 3 ? d.getUint8(3) : undefined); break;
      case 0x05: this.cbs.onPrep && this.cbs.onPrep({ trackIdx: d.getUint8(1), cdMs: d.getUint32(2) }); break;
      case 0x03: { const st = decStart(d); this.kartN = st.karts;
        this.cbs.onStart && this.cbs.onStart(st); break; }
      case 0x10: this.cbs.onInput && this.cbs.onInput(decInput(d)); break;
      case 0x20: this.cbs.onState && this.cbs.onState(decodeState(d, this.kartN)); break;
      case 0x30: this.cbs.onFinish && this.cbs.onFinish(decFinish(d)); break;
      case 0x40: if (this.open && !this.closedFired) {
        this.closedFired = true; this._status('closed');
        this.cbs.onClose && this.cbs.onClose(); }
        break;
    }
  }

  _sendHello() {
    this.keepAliveAt = performance.now();
    const b = new Uint8Array([T_HELLO, this.role === 'host' ? 0 : 1]);
    this._post(b.buffer, this.role === 'host' ? 'HOST' : 'P2');
  }

  _buf(x) { return x instanceof ArrayBuffer ? x : x.buffer; }
  _post(body, who) {
    if (!this.active) return;
    fetch(this.api + '/api/relay.php?room=' + this.code + '&who=' + who, {
      method: 'POST', keepalive: false,
      headers: { 'Content-Type': 'text/plain' }, body
    }).catch(() => {});   // a dropped frame is retried on the next tick
  }

  /* ---- same send surface as the old NetSession ---- */
  sendTrack(idx, haz, itm) { this.trackIdx = idx; if (this.active && this.code) this._post(this._buf(encTrack(idx, haz, itm)), 'HOST'); }
  sendPrep(idx, cdMs) { if (this.active && this.code) this._post(this._buf(encPrep(idx, cdMs)), 'HOST'); }
  sendStart(info) { if (this.active && this.code) this._post(this._buf(encStart(info)), 'HOST'); }
  sendFinish(order, laps) { if (this.active && this.code) this._post(this._buf(encFinish(order, laps)), 'HOST'); }
  sendInput(t, s, drift, use) {
    if (!this.open) return;
    const now = performance.now();
    // 30 Hz on the wire (the host's 250 ms freshness window is far larger):
    // throttle/steer ride the interval; a drift/use edge is never gated (it
    // must land in the very tick it happened)
    if (now - (this._inAt || 0) < 33 && use === this._inUse && drift === this._inDrift) return;
    this._inAt = now; this._inUse = use; this._inDrift = drift;
    this._post(this._buf(encInput(t, s, 0, drift, use)), 'P2');
  }
  sendState(buf) { if (this.active && this.code) this._post(buf, 'HOST'); }   // raw frame, as before
}
