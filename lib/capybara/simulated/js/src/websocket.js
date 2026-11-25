// WebSocket, generated from its IDL — `new WebSocket(url)` hands the request its opening handshake makes (the engine's:
// fetch_request.rs `webSocketRequest`) to the host, which opens the connection over the in-process `rack.hijack` socket
// (Browser#ws_open), the same substrate the SSE / message_bus long-poll readers use. Frames flow back through
// `deliverWebSocketEvents`, drained by the settle path each tick; the frames are the engine's to write and read
// (ws_frame.rs), the socket and the handshake the host's. The primary target is Action Cable (which hijacks the
// connection and speaks WebSocket frames in-process), so Turbo Streams / `turbo_stream_from` live updates work.

import { Event, CloseEvent, createMessageEvent, EventTarget, dispatchWithOnHandler, installEventHandlerAttrs } from './events.js';
import { convertWebSocketArguments, installWebSocket } from './generated/bindings.js';
import { bufferSourceByteLength, bufferSourceBytes, makeSlots, registerInterface, slotsOf, inheritInterface, createObject } from './webidl.js';
import { apiBaseURL } from './platform-globals.js';
import { utf8Length } from './bytes.js';
import { Blob, blobByteArray, blobSize, isBlob } from './blob.js';
import { hostTask } from './timers.js';
import { dom, hostObject, hostSteps, realmHooks } from './engine.js';
import { viewBuffer, viewByteLength } from './intrinsics.js';

// Its connection as the page sees it is the engine's (ws_state.rs, `__dom.WebSocketStateBase`): its URL and origin, its
// ready state, what `send` queued, the subprotocol chosen, its binary type, and the host's id for its connection — its
// constructor's checks, `close()`'s, and what each event the host delivers does to it — and the realm's sockets.
const W_URL = 0, W_ORIGIN = 1, W_READY_STATE = 2, W_BUFFERED_AMOUNT = 3, W_PROTOCOL = 4, W_BINARY_TYPE = 5, W_ID = 6,
      W_BAD_PORT = 7;
const wsOf = (o) => slotsOf(o, 'WebSocket')?.state;
registerInterface('WebSocket', (o) => wsOf(o) !== undefined);
const field = (state, k) => dom.wsField(state, k);
export class WebSocket extends Object {
  constructor(url, protocols) {
    const converted = convertWebSocketArguments(arguments);
    url = converted[0];
    protocols = converted[1];
    const list = typeof protocols === 'string' ? [protocols] : protocols;
    // (…"apply the URL parser to url with baseURL" — WebSockets §3.1: no encoding-parse, its query UTF-8 in any document)
    const state = new dom.WebSocketStateBase(url, list, apiBaseURL());
    const self = createObject(new.target);
    makeSlots(self, 'WebSocket').state = state;
    dom.wsRegister(state, self);
    // Port blocking: a bad-port connection is failed without ever being attempted. The failure is a microtask, not a
    // throw — the constructor returns normally and the handlers the page assigns right after it fire (error, then a
    // wasClean:false 1006 close), per "fail the WebSocket connection".
    if (field(state, W_BAD_PORT)) {
      realmHooks.queueMicrotask(() => fire(self, dom.wsDeliver(state, '__error')));
      return self;
    }
    const id = hostObject.wsOpen(dom.webSocketRequest(state)[1]) | 0;
    dom.wsSetField(state, W_ID, id);
    return self;
  }
}
inheritInterface(WebSocket, EventTarget);
// The events the engine says a change of `ws`'s connection fires, in order (`wsDeliver`).
function fire(ws, events) {
  for (let i = 0; i < events.length; i++) {
    const type = events[i][0], code = events[i][1], reason = events[i][2], wasClean = events[i][3];
    dispatchWithOnHandler(ws, type === 'close' ? new CloseEvent('close', { __proto__: null, code, reason, wasClean }) : new Event(type));
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
    hostObject.wsSend(id, data, false);
    return utf8Length(data);
  }
  const bytes = isBlob(data) ? blobByteArray(data) : bufferSourceBytes(data);
  hostObject.wsSend(id, bytes, true);   // (…a Uint8Array marshals as a binary String)
  return viewByteLength(bytes);
}

installWebSocket(WebSocket, {
  get_url: (ws) => field(wsOf(ws), W_URL),
  get_readyState: (ws) => field(wsOf(ws), W_READY_STATE),
  get_bufferedAmount: (ws) => field(wsOf(ws), W_BUFFERED_AMOUNT),
  get_extensions: () => '',
  get_protocol: (ws) => field(wsOf(ws), W_PROTOCOL),
  get_binaryType: (ws) => field(wsOf(ws), W_BINARY_TYPE),
  set_binaryType: (ws, v) => { dom.wsSetField(wsOf(ws), W_BINARY_TYPE, v); },
  // send(): what the engine says it does (`wsSend`) — a frame sent on an open connection, its size counted until the
  // event loop next turns.
  send(ws, data) {
    const state = wsOf(ws);
    // (…measured only where its size is all a socket once closing takes of it)
    let step = dom.wsSend(state, -1, false);
    if (step === 3) step = dom.wsSend(state, sizeOf(data), false);
    if (step !== 1) return;
    if (dom.wsSend(state, sendFrame(state, data), true) === 2) {
      realmHooks.queueMicrotask(() => dom.wsDrained(state));
    }
  },
  // close(): the code the engine closes the connection with (`wsClose`), where it closes it.
  close(ws, code, reason) {
    const state = wsOf(ws);
    const sent = dom.wsClose(state, code, reason === undefined ? undefined : utf8Length(reason));
    const id = field(state, W_ID);
    if (sent !== undefined && id > 0) hostObject.wsClose(id, sent, reason === undefined ? '' : reason);
  },
  installEventHandlers: installEventHandlerAttrs
});
globalThis.WebSocket = WebSocket;

// `events`: Array<{id, type, data?, code?, reason?, protocol?, message?}> with
// sentinel types `__open` / `__close` / `__error` for lifecycle transitions
// and `message` for a received frame. Like the SSE delivery, don't bump
// `__settleGen` here — the listener's render chain is what changes the DOM and
// the next settle iter's microtask drain picks it up.
// The host delivers a connection's events in the realm that opened it (Browser#deliver_websocket_events), so its events,
// and the Blob or ArrayBuffer a message carries, are its realm's; one of a socket closed since, or made to disappear
// with its document, is not delivered.
hostSteps.deliverWebSocketEvents = hostTask(function (events) {
  if (!events || !events.length) return 0;
  let delivered = 0;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    const ws = dom.wsSocketOf(e.id | 0);
    if (ws) delivered += deliverOne(ws, e);
  }
  return delivered;
});
// One event to ws: 1 where it was delivered — a lifecycle one's events the engine's (`wsDeliver`), a closed connection's
// forgotten; a received data frame surfaced per `binaryType` (a binary frame's raw bytes as an ArrayBuffer, or a Blob by
// default; text a plain string).
function deliverOne(ws, e) {
  const state = wsOf(ws);
  if (e.type === '__open' || e.type === '__close' || e.type === '__error') {
    const events = dom.wsDeliver(state, e.type, e.protocol, e.code, e.reason);
    fire(ws, events);
    // (…an open that came when it was no longer connecting not delivered)
    return e.type !== '__open' || events.length ? 1 : 0;
  }
  let data;
  if (e.binary) {
    // (…copied into this realm: the host hands them over in the top window's)
    data = field(state, W_BINARY_TYPE) === 'arraybuffer' ? viewBuffer(new Uint8Array(e.data)) : new Blob([e.data]);
  } else {
    data = e.data == null ? '' : e.data;
  }
  dispatchWithOnHandler(ws, createMessageEvent('message', { data, origin: field(state, W_ORIGIN) }));
  return 1;
}

// "Unloading document cleanup steps": this realm's sockets made to disappear as its document goes — a frame removed or
// navigated — each still connecting or open starting its closing handshake as Going Away (1001), unheard from now on.
realmHooks.dropWebSockets = function () {
  const closing = dom.wsDrop();
  for (let i = 0; i < closing.length; i += 2) hostObject.wsClose(closing[i], closing[i + 1], '');
};
