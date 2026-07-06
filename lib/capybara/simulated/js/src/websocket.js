// WebSocket — `new WebSocket(url)` opens a connection on the Ruby side over
// the in-process `rack.hijack` socket (Browser#ws_open), the same substrate
// the SSE / message_bus long-poll readers use. Frames flow back through
// `__csim_deliverWebSocketEvents`, drained by the settle path each tick; the
// RFC6455 handshake + framing live in Ruby. The primary target is Action
// Cable (which hijacks the connection and speaks WebSocket frames in-process),
// so Turbo Streams / `turbo_stream_from` live updates work.

import { Event, MessageEvent, EventTarget, dispatchWithOnHandler, defineEventHandlers } from './events.js';
import { fetchedToBytes, bytesToLatin1 } from './bytes.js';

const byId = new Map();
globalThis.__csim_webSocketById = byId;

export class WebSocket extends EventTarget {
  constructor(url, protocols) {
    super();
    this.url           = String(url);
    this.readyState    = 0;          // CONNECTING
    this.bufferedAmount = 0;
    this.extensions    = '';
    this.protocol      = '';
    this.binaryType    = 'blob';
    const list = protocols == null ? [] : (Array.isArray(protocols) ? protocols.map(String) : [String(protocols)]);
    this._id = globalThis.__csim_wsOpen(this.url, list) | 0;
    if (this._id > 0) byId.set(this._id, this);
  }
  send(data) {
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
    this.readyState = 2;                 // CLOSING
    if (this._id > 0) globalThis.__csim_wsClose(this._id, code == null ? 1000 : code | 0, reason == null ? '' : String(reason));
  }
}
WebSocket.CONNECTING = 0;
WebSocket.OPEN       = 1;
WebSocket.CLOSING    = 2;
WebSocket.CLOSED     = 3;

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
        const ev = new Event('close');
        try {
          ev.code     = e.code == null ? 1006 : e.code | 0;
          ev.reason   = e.reason == null ? '' : String(e.reason);
          ev.wasClean = e.type === '__close' && e.code != null;
        } catch (_) {}
        dispatchWithOnHandler(ws, ev);
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
