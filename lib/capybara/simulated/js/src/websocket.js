// WebSocket, generated from its IDL — `new WebSocket(url)` opens a connection on the Ruby side over
// the in-process `rack.hijack` socket (Browser#ws_open), the same substrate
// the SSE / message_bus long-poll readers use. Frames flow back through
// `__csim_deliverWebSocketEvents`, drained by the settle path each tick; the
// RFC6455 handshake + framing live in Ruby. The primary target is Action
// Cable (which hijacks the connection and speaks WebSocket frames in-process),
// so Turbo Streams / `turbo_stream_from` live updates work.

import { Event, CloseEvent, createMessageEvent, EventTarget, dispatchWithOnHandler, installEventHandlerAttrs } from './events.js';
import { convertWebSocketArguments, installWebSocket } from './generated/bindings.js';
import { makeSlots, registerInterface, slotsOf } from './webidl.js';
import { location } from './location.js';
import { latin1ToBytes, utf8Length } from './bytes.js';
import { blobBytes, blobSize, isBlob } from './blob.js';

// The sockets by the host's id for their connection: the TOP window's map, which a frame's sockets go in too — the host
// delivers every connection's events through the top window's realm, and a frame's own map was one nothing read.
const sockets = () => {
  let g = globalThis;
  while (g.__csimParent && g.__csimParent !== g) g = g.__csimParent;
  return (g.__csimWebSockets ??= new Map());
};

// A valid WebSocket subprotocol is an RFC 7230 `token`: one or more of these ASCII chars,
// no separators / controls (the constructor rejects anything else with SyntaxError).
const WS_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

// The fetch spec's bad-port list (https://fetch.spec.whatwg.org/#port-blocking): a connection
// to one of these is FAILED — asynchronously, after the constructor returns, so the page's
// `onerror` (assigned right after `new WebSocket`) still sees it — never attempted. The ws/wss
// defaults (80/443) are not on the list, so a default-port URL never consults it.
const BAD_PORTS = new Set([
  0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95,
  101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179,
  389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601,
  636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566,
  6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080
]);

const CONSTRUCT = "Failed to construct 'WebSocket': ";
const CONNECTING = 0, OPEN = 1, CLOSING = 2, CLOSED = 3;

// Its slots: its URL and that URL's origin (a message event's), its ready state, the bytes `send` has queued — those sent
// while it was open, which the event loop's next turn sees gone, and those given it once closing, which never go — the
// extensions and the subprotocol the server chose, its binary type, the subprotocols it offered (the server's choice must
// be one of them), whether close() came while it was still connecting (its close is then abnormal), and the host's id
// for its connection.
const wsOf = (o) => slotsOf(o, 'WebSocket');
registerInterface('WebSocket', (o) => wsOf(o) !== undefined);
export class WebSocket extends EventTarget {
  // The constructor steps (WebSockets §3): `url` parsed against the base URL — failure a SyntaxError — an http(s) scheme
  // made ws(s), any other but ws(s) refused, a fragment refused; each subprotocol a token, none twice — ASCII
  // case-insensitively, as websockets/Create-protocols-repeated-case-insensitive holds the spec's "occur more than once"
  // to (Chrome takes `['a', 'A']`). All of it before the connection is opened.
  constructor(url, protocols) {
    [url, protocols] = convertWebSocketArguments(arguments);
    super();
    const base = (globalThis.document && globalThis.document.baseURI) || location.href || undefined;
    let record;
    try { record = new globalThis.URL(url, base); }
    catch (_) { throw new DOMException(`${CONSTRUCT}The URL '${url}' is invalid.`, 'SyntaxError'); }
    let scheme = record.protocol;                       // includes the trailing ':'
    let href   = record.href;
    if (scheme === 'http:')       { scheme = 'ws:';  href = 'ws:'  + href.slice(5); }
    else if (scheme === 'https:') { scheme = 'wss:'; href = 'wss:' + href.slice(6); }
    if (scheme !== 'ws:' && scheme !== 'wss:') {
      throw new DOMException(`${CONSTRUCT}The URL's scheme must be either 'http', 'https', 'ws', or 'wss'. '${scheme.slice(0, -1)}' is not allowed.`, 'SyntaxError');
    }
    if (record.hash !== '') {
      throw new DOMException(`${CONSTRUCT}The URL contains a fragment identifier ('${record.hash.slice(1)}'). Fragment identifiers are not allowed in WebSocket URLs.`, 'SyntaxError');
    }
    const list = typeof protocols === 'string' ? [protocols] : protocols;
    const seen = new Set();
    for (const p of list) {
      if (!WS_TOKEN.test(p)) throw new DOMException(`${CONSTRUCT}The subprotocol '${p}' is invalid.`, 'SyntaxError');
      if (seen.has(p.toLowerCase())) throw new DOMException(`${CONSTRUCT}The subprotocol '${p}' is duplicated.`, 'SyntaxError');
      seen.add(p.toLowerCase());
    }
    const s = makeSlots(this, 'WebSocket', {
      url: href, origin: scheme + '//' + record.host, readyState: CONNECTING, queued: 0, unsent: 0, draining: false,
      extensions: '', protocol: '', binaryType: 'blob', protocols: list, failConnecting: false, id: 0
    });
    // Port blocking: a bad-port connection is failed without ever being attempted. The failure
    // is a microtask, not a throw — the constructor returns normally and the handlers the page
    // assigns right after it fire (error, then a wasClean:false 1006 close), per "fail the
    // WebSocket connection".
    if (record.port !== '' && BAD_PORTS.has(record.port | 0)) {
      globalThis.__csimQueueMicrotask(() => {
        if (s.readyState === CLOSED) return;   // fail exactly once (a close() meanwhile still lands here)
        s.readyState = CLOSED;
        dispatchWithOnHandler(this, new Event('error'));
        dispatchWithOnHandler(this, new CloseEvent('close', {code: 1006, reason: '', wasClean: false}));
      });
      return;
    }
    s.id = globalThis.__csim_wsOpen(s.url, list) | 0;
    if (s.id > 0) sockets().set(s.id, this);
  }
}

// What send() is given, as its size in bytes — a string's UTF-8, a buffer's or a view's (a detached one's none: "get a
// copy of the bytes" of it is empty), a blob's — and the frame it goes as: a string as text, anything else binary.
function sizeOf(data) {
  if (typeof data === 'string') return utf8Length(data);
  return isBlob(data) ? blobSize(data) : data.byteLength;
}
function sendFrame(s, data) {
  if (typeof data === 'string') {
    globalThis.__csim_wsSend(s.id, data, false);
    return;
  }
  const bytes = isBlob(data) ? latin1ToBytes(blobBytes(data))
    : data.byteLength === 0 ? new Uint8Array(0)
    : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    : new Uint8Array(data);
  globalThis.__csim_wsSend(s.id, bytes, true);   // (…a Uint8Array marshals as a binary String)
}

installWebSocket(WebSocket, {
  get_url: (ws) => wsOf(ws).url,
  get_readyState: (ws) => wsOf(ws).readyState,
  get_bufferedAmount: (ws) => wsOf(ws).queued + wsOf(ws).unsent,
  get_extensions: (ws) => wsOf(ws).extensions,
  get_protocol: (ws) => wsOf(ws).protocol,
  get_binaryType: (ws) => wsOf(ws).binaryType,
  set_binaryType: (ws, v) => { wsOf(ws).binaryType = v; },
  // send(): none while connecting (InvalidStateError); on an open connection the frame goes out — a string as text,
  // anything else binary — and its size counts in bufferedAmount until the event loop next turns (our transport writes
  // at once, so the queue is notional); once closing or closed nothing is sent, and the size stays counted, as the bytes
  // never leave (WebSockets §3: "must increase the bufferedAmount").
  send(ws, data) {
    const s = wsOf(ws);
    if (s.readyState === CONNECTING) throw new DOMException("Failed to execute 'send' on 'WebSocket': Still in CONNECTING state.", 'InvalidStateError');
    if (s.readyState !== OPEN) {
      s.unsent += sizeOf(data);
      return;
    }
    s.queued += sizeOf(data);
    sendFrame(s, data);
    if (s.draining) return;
    s.draining = true;
    globalThis.__csimQueueMicrotask(() => {
      s.draining = false;
      s.queued = 0;
    });
  },
  // close(): a code 1000 or 3000-4999 (InvalidAccessError — after [Clamp], so `close(2 ** 16 + 1000)` reports 65535), a
  // reason of at most 123 UTF-8 bytes (SyntaxError); nothing more once closing; while connecting, the connection fails —
  // its close is abnormal (1006), whatever the server's handshake says, and `open` never fires. A reason with no code
  // goes with 1000 (the spec's "set code to 1000"); neither sends a bodyless close frame, which the peer echoes as 1005.
  close(ws, code, reason) {
    const s = wsOf(ws);
    if (code !== undefined && code !== 1000 && (code < 3000 || code > 4999)) {
      throw new DOMException(`Failed to execute 'close' on 'WebSocket': The close code must be either 1000, or between 3000 and 4999. ${code} is neither.`, 'InvalidAccessError');
    }
    if (reason !== undefined && utf8Length(reason) > 123) {
      throw new DOMException("Failed to execute 'close' on 'WebSocket': The close reason must not be greater than 123 UTF-8 bytes.", 'SyntaxError');
    }
    if (s.readyState === CLOSING || s.readyState === CLOSED) return;
    if (s.readyState === CONNECTING) s.failConnecting = true;
    s.readyState = CLOSING;
    if (code === undefined && reason !== undefined) code = 1000;
    if (s.id > 0) globalThis.__csim_wsClose(s.id, code === undefined ? null : code, reason === undefined ? '' : reason);
  },
  installEventHandlers: (proto, names, isSelf) => installEventHandlerAttrs(proto, names, null, isSelf)
});
globalThis.WebSocket = WebSocket;

// `events`: Array<{id, type, data?, code?, reason?, protocol?, message?}> with
// sentinel types `__open` / `__close` / `__error` for lifecycle transitions
// and `message` for a received frame. Like the SSE delivery, don't bump
// `__settleGen` here — the listener's render chain is what changes the DOM and
// the next settle iter's microtask drain picks it up.
globalThis.__csim_deliverWebSocketEvents = function (events) {
  if (!events || !events.length) return 0;
  let delivered = 0;
  for (const e of events) {
    const ws = sockets().get(e.id | 0);
    if (!ws) continue;
    const s = wsOf(ws);
    if (e.type === '__open') {
      if (s.readyState === CONNECTING) {
        // The server's selected subprotocol MUST be one the client offered (exact,
        // case-sensitive) — otherwise the connection is failed (error + abnormal close,
        // no open). A missing/empty selection is always valid.
        const proto = e.protocol ? String(e.protocol) : '';
        if (proto !== '' && !s.protocols.includes(proto)) {
          s.readyState = CLOSED;
          dispatchWithOnHandler(ws, new Event('error'));
          dispatchWithOnHandler(ws, new CloseEvent('close', {code: 1006, reason: '', wasClean: false}));
          sockets().delete(e.id | 0);
          delivered++;
          continue;
        }
        s.readyState = OPEN;
        s.protocol = proto;
        dispatchWithOnHandler(ws, new Event('open'));
        delivered++;
      }
      continue;
    }
    if (e.type === '__close' || e.type === '__error') {
      // "Fail / close the WebSocket connection": readyState becomes CLOSED BEFORE any event, so an
      // `error` / `close` handler already observes readyState === CLOSED.
      // (…a close() while connecting failed the connection: an `error` before its close, whatever the server said)
      const fireClose = s.readyState !== CLOSED;
      s.readyState = CLOSED;
      if (e.type === '__error' || (fireClose && s.failConnecting)) dispatchWithOnHandler(ws, new Event('error'));
      if (fireClose) {
        // A clean close carries the server's code (1000 by default); an abnormal drop
        // (`__error`, a `__close` with no code, or a close that raced the opening handshake)
        // is 1006 + wasClean false.
        const clean = e.type === '__close' && e.code != null && !s.failConnecting;
        dispatchWithOnHandler(ws, new CloseEvent('close', {
          code:     s.failConnecting || e.code == null ? 1006 : e.code | 0,
          reason:   s.failConnecting || e.reason == null ? '' : String(e.reason),
          wasClean: clean
        }));
      }
      sockets().delete(e.id | 0);
      delivered++;
      continue;
    }
    // A received data frame. Binary frames arrive as raw bytes (a Uint8Array)
    // and are surfaced per `binaryType` (ArrayBuffer, or a Blob by default);
    // text is a plain string.
    let data;
    if (e.binary) {
      const bytes = e.data;
      if (s.binaryType === 'arraybuffer') {
        data = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
          ? bytes.buffer
          : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      } else {
        data = new globalThis.Blob([bytes]);
      }
    } else {
      data = e.data == null ? '' : e.data;
    }
    dispatchWithOnHandler(ws, createMessageEvent('message', { data, origin: s.origin }));
    delivered++;
  }
  return delivered;
};
