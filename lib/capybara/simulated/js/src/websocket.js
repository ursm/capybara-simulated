// WebSocket — `new WebSocket(url)` opens a connection on the Ruby side over
// the in-process `rack.hijack` socket (Browser#ws_open), the same substrate
// the SSE / message_bus long-poll readers use. Frames flow back through
// `__csim_deliverWebSocketEvents`, drained by the settle path each tick; the
// RFC6455 handshake + framing live in Ruby. The primary target is Action
// Cable (which hijacks the connection and speaks WebSocket frames in-process),
// so Turbo Streams / `turbo_stream_from` live updates work.

import { Event, MessageEvent, CloseEvent, EventTarget, dispatchWithOnHandler, defineEventHandlers } from './events.js';
import { fetchedToBytes, bytesToLatin1 } from './bytes.js';

const byId = new Map();
globalThis.__csim_webSocketById = byId;

// A valid WebSocket subprotocol is an RFC 7230 `token`: one or more of these ASCII chars,
// no separators / controls (the constructor rejects anything else with SyntaxError).
const WS_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

// UTF-8 byte length of a string, counted without allocating the encoded buffer — `bufferedAmount`
// grows by the wire byte count of each queued text message.
function utf8Length(str) {
  let n = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xD800 && c <= 0xDBFF) { n += 4; i++; }   // a surrogate pair → one 4-byte code point
    else n += 3;
  }
  return n;
}

export class WebSocket extends EventTarget {
  constructor(url, protocols) {
    super();
    if (arguments.length < 1) throw new TypeError("Failed to construct 'WebSocket': 1 argument required, but only 0 present.");
    // WHATWG "The WebSocket(url, protocols) constructor": parse `url` against the base URL,
    // normalise an http(s) scheme to ws(s), and reject a non-ws(s) scheme or a fragment with
    // SyntaxError. Then validate each subprotocol is a token with no ASCII-case-insensitive
    // duplicate. All of this happens before the connection is opened.
    const base = (globalThis.document && globalThis.document.baseURI) || (globalThis.location && globalThis.location.href) || undefined;
    let record;
    try { record = new globalThis.URL(String(url), base); }
    catch (_) { throw new DOMException(`Failed to construct 'WebSocket': The URL '${url}' is invalid.`, 'SyntaxError'); }
    let scheme = record.protocol;                       // includes the trailing ':'
    let href   = record.href;
    if (scheme === 'http:')       { scheme = 'ws:';  href = 'ws:'  + href.slice(5); }
    else if (scheme === 'https:') { scheme = 'wss:'; href = 'wss:' + href.slice(6); }
    if (scheme !== 'ws:' && scheme !== 'wss:')
      throw new DOMException(`Failed to construct 'WebSocket': The URL's scheme must be either 'ws' or 'wss'. '${scheme.slice(0, -1)}' is not allowed.`, 'SyntaxError');
    if (record.hash !== '')
      throw new DOMException(`Failed to construct 'WebSocket': The URL contains a fragment identifier ('${record.hash.slice(1)}'). Fragment identifiers are not allowed in WebSocket URLs.`, 'SyntaxError');
    const list = protocols == null ? [] : (Array.isArray(protocols) ? protocols.map(String) : [String(protocols)]);
    const seen = new Set();
    for (const p of list) {
      if (!WS_TOKEN.test(p))
        throw new DOMException(`Failed to construct 'WebSocket': The subprotocol '${p}' is invalid.`, 'SyntaxError');
      const lc = p.toLowerCase();
      if (seen.has(lc))
        throw new DOMException(`Failed to construct 'WebSocket': The subprotocol '${p}' is duplicated.`, 'SyntaxError');
      seen.add(lc);
    }
    // The IDL attributes are readonly (except binaryType) → prototype getters over these internal
    // slots, so `ws.url = x` / `delete ws.readyState` / a re-`defineProperty` can't perturb them.
    this._url            = href;
    this._origin         = scheme + '//' + record.host;   // the URL's origin (no path) for message events
    this._readyState     = 0;         // CONNECTING
    this._bufferedAmount = 0;
    this._extensions     = '';
    this._protocol       = '';
    this._binaryType     = 'blob';
    this._protocols      = list;      // for validating the server's selected subprotocol on open
    this._id = globalThis.__csim_wsOpen(this._url, list) | 0;
    if (this._id > 0) byId.set(this._id, this);
  }
  send(data) {
    if (arguments.length < 1) throw new TypeError("Failed to execute 'send' on 'WebSocket': 1 argument required, but only 0 present.");
    if (this._readyState === 0) throw new DOMException("Failed to execute 'send' on 'WebSocket': Still in CONNECTING state.", 'InvalidStateError');
    if (this._readyState !== 1) return;   // CLOSING / CLOSED drop silently
    // Per the IDL `send(USVString or BufferSource or Blob)`: an ArrayBuffer / typed-array view
    // is sent as a binary frame; ANYTHING ELSE (a string, but also a number / null / undefined /
    // object) is ToString'd and sent as text. (Blob would be binary, but our Blob bytes are
    // host-backed + async — it falls through to its string form for now.)
    let bytes = null;
    if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
    else if (ArrayBuffer.isView(data)) bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (bytes === null) {
      const str = String(data);
      this._queueBuffered(utf8Length(str));
      globalThis.__csim_wsSend(this._id, str, false, false);
      return;
    }
    this._queueBuffered(bytes.byteLength);
    // V8 marshals a Uint8Array arg to a clean BINARY String; QuickJS reinterprets
    // bytes ≥ 0x80 as UTF-8 and corrupts them (the reason bytes.js base64-dances),
    // so on QuickJS hand the host a base64 string and decode it Ruby-side.
    if (globalThis.RustyRacer) {
      globalThis.__csim_wsSend(this._id, bytes, true, false);
    } else {
      globalThis.__csim_wsSend(this._id, globalThis.btoa(bytesToLatin1(bytes)), true, true);
    }
  }
  // bufferedAmount grows synchronously as messages are queued in send() and drains BETWEEN event
  // loop turns (never while script runs). Our transport writes synchronously, so the queued bytes
  // are notional: report them until the next microtask checkpoint, then reset to zero.
  _queueBuffered(n) {
    this._bufferedAmount += n;
    if (this._bufferedDrainScheduled) return;
    this._bufferedDrainScheduled = true;
    globalThis.queueMicrotask(() => {
      this._bufferedAmount = 0;
      this._bufferedDrainScheduled = false;
    });
  }

  close(code, reason) {
    if (this._readyState === 2 || this._readyState === 3) return;
    // close() called before the connection is established (still CONNECTING) fails the
    // connection: the eventual close event is abnormal (code 1006, wasClean false), no matter
    // what the server's closing handshake says. `open` never fires (see delivery below).
    if (this._readyState === 0) this._failConnecting = true;
    this._readyState = 2;                 // CLOSING
    // A missing code sends a bodyless close (no status) → the peer echoes it and the close
    // event reports 1005; an explicit code is framed as-is.
    if (this._id > 0) globalThis.__csim_wsClose(this._id, code == null ? null : code | 0, reason == null ? '' : String(reason));
  }
}
// The readyState constants are `{ ReadOnly }` on both the interface object and its prototype
// (so `WebSocket.OPEN`, `WebSocket.prototype.OPEN`, and an instance's inherited `ws.OPEN` all
// read the value and ignore assignment) — constants/002 sets them to 5 and asserts no-op.
for (const [k, v] of [['CONNECTING', 0], ['OPEN', 1], ['CLOSING', 2], ['CLOSED', 3]]) {
  const desc = {value: v, writable: false, enumerable: true, configurable: false};
  Object.defineProperty(WebSocket, k, desc);
  Object.defineProperty(WebSocket.prototype, k, desc);
}

// The readonly IDL attributes are prototype getters over the internal slots (setting / deleting /
// re-defining them on an instance can't change the reported value). `binaryType` is the one
// read-write attribute, and only accepts the two legal enum values.
for (const name of ['url', 'readyState', 'bufferedAmount', 'extensions', 'protocol']) {
  Object.defineProperty(WebSocket.prototype, name, {
    get() { return this['_' + name]; },
    enumerable: true,
    configurable: true,
  });
}
Object.defineProperty(WebSocket.prototype, 'binaryType', {
  get() { return this._binaryType; },
  set(v) { if (v === 'blob' || v === 'arraybuffer') this._binaryType = v; },
  enumerable: true,
  configurable: true,
});

// `events`: Array<{id, type, data?, code?, reason?, protocol?, message?}> with
// sentinel types `__open` / `__close` / `__error` for lifecycle transitions
// and `message` for a received frame. Like the SSE delivery, don't bump
// `__settleGen` here — the listener's render chain is what changes the DOM and
// the next settle iter's microtask drain picks it up.
globalThis.__csim_deliverWebSocketEvents = function (events) {
  if (!events || !events.length) return 0;
  let delivered = 0;
  for (const e of events) {
    const ws = byId.get(e.id | 0);
    if (!ws) continue;
    if (e.type === '__open') {
      if (ws._readyState === 0) {
        // The server's selected subprotocol MUST be one the client offered (exact,
        // case-sensitive) — otherwise the connection is failed (error + abnormal close,
        // no open). A missing/empty selection is always valid.
        const proto = e.protocol ? String(e.protocol) : '';
        if (proto !== '' && !ws._protocols.includes(proto)) {
          ws._readyState = 3;            // CLOSED
          dispatchWithOnHandler(ws, new Event('error'));
          dispatchWithOnHandler(ws, new CloseEvent('close', {code: 1006, reason: '', wasClean: false}));
          byId.delete(e.id | 0);
          delivered++;
          continue;
        }
        ws._readyState = 1;              // OPEN
        ws._protocol = proto;
        dispatchWithOnHandler(ws, new Event('open'));
        delivered++;
      }
      continue;
    }
    if (e.type === '__close' || e.type === '__error') {
      if (e.type === '__error') {
        const err = new Event('error');
        if (e.message) try { err.message = String(e.message); } catch (_) {}
        dispatchWithOnHandler(ws, err);
      }
      if (ws._readyState !== 3) {
        ws._readyState = 3;              // CLOSED
        // A clean close carries the server's code (1000 by default); an abnormal drop
        // (`__error`, a `__close` with no code, or a close that raced the opening handshake)
        // is 1006 + wasClean false.
        const clean = e.type === '__close' && e.code != null && !ws._failConnecting;
        dispatchWithOnHandler(ws, new CloseEvent('close', {
          code:     ws._failConnecting || e.code == null ? 1006 : e.code | 0,
          reason:   ws._failConnecting || e.reason == null ? '' : String(e.reason),
          wasClean: clean,
        }));
      }
      byId.delete(e.id | 0);
      delivered++;
      continue;
    }
    // A received data frame. Binary frames arrive as raw bytes (Uint8Array on
    // V8 / base64 string on QuickJS — `fetchedToBytes` normalises both) and are
    // surfaced per `binaryType` (ArrayBuffer, or a Blob by default); text is a
    // plain string.
    let data;
    if (e.binary) {
      const bytes = fetchedToBytes(e.data) || new Uint8Array(0);
      if (ws.binaryType === 'arraybuffer') {
        data = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
          ? bytes.buffer
          : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      } else {
        data = typeof globalThis.Blob === 'function' ? new globalThis.Blob([bytes]) : bytes.buffer;
      }
    } else {
      data = e.data == null ? '' : e.data;
    }
    dispatchWithOnHandler(ws, new MessageEvent('message', { data, origin: ws._origin }));
    delivered++;
  }
  return delivered;
};

defineEventHandlers(WebSocket.prototype, ['open', 'message', 'close', 'error']);
globalThis.WebSocket = WebSocket;
