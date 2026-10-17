// WebSocket, generated from its IDL — `new WebSocket(url)` opens a connection on the Ruby side over
// the in-process `rack.hijack` socket (Browser#ws_open), the same substrate
// the SSE / message_bus long-poll readers use. Frames flow back through
// `__csim_deliverWebSocketEvents`, drained by the settle path each tick; the
// RFC6455 handshake + framing live in Ruby. The primary target is Action
// Cable (which hijacks the connection and speaks WebSocket frames in-process),
// so Turbo Streams / `turbo_stream_from` live updates work.

import { Event, CloseEvent, createMessageEvent, EventTarget, dispatchWithOnHandler, installEventHandlerAttrs } from './events.js';
import { convertWebSocketArguments, installWebSocket } from './generated/bindings.js';
import { bufferSourceByteLength, bufferSourceBytes, makeSlots, registerInterface, slotsOf } from './webidl.js';
import { apiBaseURL } from './platform-globals.js';
import { latin1ToBytes, utf8Length } from './bytes.js';
import { blobBytes, blobSize, isBlob } from './blob.js';
import { hostTask } from './timers.js';

// The sockets by the host's id for their connection, each `{target, deliver}` — the socket and its realm's delivery: the
// TOP window's map, which a frame's sockets go in too, as the host delivers every connection's events through the top
// window's realm.
const sockets = () => {
  let g = globalThis;
  while (g.__csimParent && g.__csimParent !== g) g = g.__csimParent;
  if (!g.__csimWebSockets) Object.defineProperty(g, '__csimWebSockets', { value: new Map(), configurable: true });
  return g.__csimWebSockets;
};

// Its connection as the page sees it is the engine's (ws_state.rs, `__dom.WebSocketStateBase`): its URL and origin, its
// ready state, what `send` queued, the subprotocol chosen, its binary type, and the host's id for its connection — its
// constructor's checks, `close()`'s, and what each event the host delivers does to it.
const W_URL = 0, W_ORIGIN = 1, W_READY_STATE = 2, W_BUFFERED_AMOUNT = 3, W_PROTOCOL = 4, W_BINARY_TYPE = 5, W_ID = 6,
      W_BAD_PORT = 7;
const CLOSED = 3;
const wsOf = (o) => slotsOf(o, 'WebSocket')?.state;
registerInterface('WebSocket', (o) => wsOf(o) !== undefined);
const field = (state, k) => globalThis.__dom.wsField(state, k);
export class WebSocket extends EventTarget {
  constructor(url, protocols) {
    [url, protocols] = convertWebSocketArguments(arguments);
    super();
    const list = typeof protocols === 'string' ? [protocols] : protocols;
    // (…"apply the URL parser to url with baseURL" — WebSockets §3.1: no encoding-parse, its query UTF-8 in any document)
    const state = new globalThis.__dom.WebSocketStateBase(url, list, apiBaseURL());
    makeSlots(this, 'WebSocket', { state });
    // Port blocking: a bad-port connection is failed without ever being attempted. The failure is a microtask, not a
    // throw — the constructor returns normally and the handlers the page assigns right after it fire (error, then a
    // wasClean:false 1006 close), per "fail the WebSocket connection".
    if (field(state, W_BAD_PORT)) {
      globalThis.__csimQueueMicrotask(() => fire(this, globalThis.__dom.wsDeliver(state, '__error')));
      return;
    }
    const id = globalThis.__csim_wsOpen(field(state, W_URL), list) | 0;
    globalThis.__dom.wsSetField(state, W_ID, id);
    if (id > 0) sockets().set(id, { target: this, deliver: deliverOne });
  }
}
// The events the engine says a change of `ws`'s connection fires, in order (`wsDeliver`).
function fire(ws, events) {
  for (const [type, code, reason, wasClean] of events) {
    dispatchWithOnHandler(ws, type === 'close' ? new CloseEvent('close', { code, reason, wasClean }) : new Event(type));
  }
}

// What send() is given, as a frame: a string as text, anything else binary — a buffer source's bytes copied as Web IDL
// gets them (a detached one's none), a blob's read — and its size in bytes, which is all a socket once closing takes
// of it (a blob's its size, unread).
function sizeOf(data) {
  if (typeof data === 'string') return utf8Length(data);
  return isBlob(data) ? blobSize(data) : bufferSourceByteLength(data);
}
function sendFrame(state, data) {
  const id = field(state, W_ID);
  if (typeof data === 'string') {
    globalThis.__csim_wsSend(id, data, false);
    return utf8Length(data);
  }
  const bytes = isBlob(data) ? latin1ToBytes(blobBytes(data)) : bufferSourceBytes(data);
  globalThis.__csim_wsSend(id, bytes, true);   // (…a Uint8Array marshals as a binary String)
  return bytes.byteLength;
}

installWebSocket(WebSocket, {
  get_url: (ws) => field(wsOf(ws), W_URL),
  get_readyState: (ws) => field(wsOf(ws), W_READY_STATE),
  get_bufferedAmount: (ws) => field(wsOf(ws), W_BUFFERED_AMOUNT),
  get_extensions: () => '',
  get_protocol: (ws) => field(wsOf(ws), W_PROTOCOL),
  get_binaryType: (ws) => field(wsOf(ws), W_BINARY_TYPE),
  set_binaryType: (ws, v) => { globalThis.__dom.wsSetField(wsOf(ws), W_BINARY_TYPE, v); },
  // send(): what the engine says it does (`wsSend`) — a frame sent on an open connection, its size counted until the
  // event loop next turns.
  send(ws, data) {
    const state = wsOf(ws);
    if (globalThis.__dom.wsSend(state, sizeOf(data), false) !== 1) return;
    if (globalThis.__dom.wsSend(state, sendFrame(state, data), true) === 2) {
      globalThis.__csimQueueMicrotask(() => globalThis.__dom.wsDrained(state));
    }
  },
  // close(): the code the engine closes the connection with (`wsClose`), where it closes it.
  close(ws, code, reason) {
    const state = wsOf(ws);
    const sent = globalThis.__dom.wsClose(state, code, reason === undefined ? undefined : utf8Length(reason), false);
    const id = field(state, W_ID);
    if (sent !== undefined && id > 0) globalThis.__csim_wsClose(id, sent, reason === undefined ? '' : reason);
  },
  installEventHandlers: (proto, names, isSelf) => installEventHandlerAttrs(proto, names, null, isSelf)
});
globalThis.WebSocket = WebSocket;

// `events`: Array<{id, type, data?, code?, reason?, protocol?, message?}> with
// sentinel types `__open` / `__close` / `__error` for lifecycle transitions
// and `message` for a received frame. Like the SSE delivery, don't bump
// `__settleGen` here — the listener's render chain is what changes the DOM and
// the next settle iter's microtask drain picks it up.
// The host delivers every connection's events through the top window's realm; each socket is handed its own through its
// own realm's delivery (`deliverOne`), so its events, and the Blob or ArrayBuffer a message carries, are its realm's.
globalThis.__csim_deliverWebSocketEvents = hostTask(function (events) {
  if (!events || !events.length) return 0;
  let delivered = 0;
  for (const e of events) {
    const entry = sockets().get(e.id | 0);
    if (entry) delivered += entry.deliver(entry.target, e);
  }
  return delivered;
});
// One event to ws, in this realm: 1 where it was delivered — a lifecycle one's events the engine's (`wsDeliver`), a closed
// connection's forgotten; a received data frame surfaced per `binaryType` (a binary frame's raw bytes as an
// ArrayBuffer, or a Blob by default; text a plain string).
function deliverOne(ws, e) {
  const state = wsOf(ws);
  if (e.type === '__open' || e.type === '__close' || e.type === '__error') {
    const events = globalThis.__dom.wsDeliver(state, e.type, e.protocol, e.code, e.reason);
    if (field(state, W_READY_STATE) === CLOSED) sockets().delete(e.id | 0);
    fire(ws, events);
    // (…an open that came when it was no longer connecting not delivered)
    return e.type !== '__open' || events.length ? 1 : 0;
  }
  let data;
  if (e.binary) {
    // (…copied into this realm: the host hands them over in the top window's)
    data = field(state, W_BINARY_TYPE) === 'arraybuffer' ? new Uint8Array(e.data).buffer : new globalThis.Blob([e.data]);
  } else {
    data = e.data == null ? '' : e.data;
  }
  dispatchWithOnHandler(ws, createMessageEvent('message', { data, origin: field(state, W_ORIGIN) }));
  return 1;
}

// "Unloading document cleanup steps": this realm's sockets made to disappear as its document goes — a frame removed or
// navigated — each still connecting or open starting its closing handshake as Going Away (1001), unheard from now on.
globalThis.__csimDropWebSockets = function () {
  for (const [id, entry] of sockets()) {
    if (entry.deliver !== deliverOne) continue;
    sockets().delete(id);
    const code = globalThis.__dom.wsClose(wsOf(entry.target), undefined, undefined, true);
    if (code !== undefined) globalThis.__csim_wsClose(id, code, '');
  }
};
