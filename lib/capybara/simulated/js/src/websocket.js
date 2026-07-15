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
    this.url           = href;
    this.readyState    = 0;          // CONNECTING
    this.bufferedAmount = 0;
    this.extensions    = '';
    this.protocol      = '';
    this.binaryType    = 'blob';
    this._id = globalThis.__csim_wsOpen(this.url, list) | 0;
    if (this._id > 0) byId.set(this._id, this);
  }
  send(data) {
    if (arguments.length < 1) throw new TypeError("Failed to execute 'send' on 'WebSocket': 1 argument required, but only 0 present.");
    if (this.readyState === 0) throw new DOMException("Failed to execute 'send' on 'WebSocket': Still in CONNECTING state.", 'InvalidStateError');
    if (this.readyState !== 1) return;   // CLOSING / CLOSED drop silently
    // The JS side knows text vs binary; tell Ruby explicitly rather than have
    // it guess from the marshalled String's encoding. Binary payloads
    // (ArrayBuffer / typed-array view) normalise to a Uint8Array; Blob is async
    // so it's not supported here (Action Cable is text-only anyway).
    if (typeof data === 'string') {
      globalThis.__csim_wsSend(this._id, data, false, false);
      return;
    }
    let bytes;
    if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
    else if (ArrayBuffer.isView(data)) bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    else bytes = new Uint8Array(0);
    // V8 marshals a Uint8Array arg to a clean BINARY String; QuickJS reinterprets
    // bytes ≥ 0x80 as UTF-8 and corrupts them (the reason bytes.js base64-dances),
    // so on QuickJS hand the host a base64 string and decode it Ruby-side.
    if (globalThis.RustyRacer) {
      globalThis.__csim_wsSend(this._id, bytes, true, false);
    } else {
      globalThis.__csim_wsSend(this._id, globalThis.btoa(bytesToLatin1(bytes)), true, true);
    }
  }
  close(code, reason) {
    if (this.readyState === 2 || this.readyState === 3) return;
    // close() called before the connection is established (still CONNECTING) fails the
    // connection: the eventual close event is abnormal (code 1006, wasClean false), no matter
    // what the server's closing handshake says. `open` never fires (see delivery below).
    if (this.readyState === 0) this._failConnecting = true;
    this.readyState = 2;                 // CLOSING
    if (this._id > 0) globalThis.__csim_wsClose(this._id, code == null ? 1000 : code | 0, reason == null ? '' : String(reason));
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
      if (ws.readyState === 0) {
        ws.readyState = 1;               // OPEN
        if (e.protocol) ws.protocol = String(e.protocol);
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
      if (ws.readyState !== 3) {
        ws.readyState = 3;               // CLOSED
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
    dispatchWithOnHandler(ws, new MessageEvent('message', { data, origin: ws.url }));
    delivered++;
  }
  return delivered;
};

defineEventHandlers(WebSocket.prototype, ['open', 'message', 'close', 'error']);
globalThis.WebSocket = WebSocket;
