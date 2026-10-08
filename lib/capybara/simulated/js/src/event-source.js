// EventSource (SSE), generated from its IDL — `new EventSource(url)` opens a TCP-backed
// stream on the Ruby side; events flow back through
// `__csim_deliverEventSourceEvents` which the settle path drains
// each tick. The actual TCP / chunked-parsing work lives in Ruby
// (Browser#event_source_open / #event_source_close) because Net::HTTP
// won't stream chunked bodies through WebMock and we need real
// socket access.

import { Event, EventTarget, createMessageEvent, dispatchWithOnHandler, installEventHandlerAttrs } from './events.js';
import { buildSwRequest } from './sw-client.js';
import { convertEventSourceArguments, installEventSource } from './generated/bindings.js';
import { makeSlots, registerInterface, slotsOf } from './webidl.js';
import { getHeader } from './headers.js';
import { responseFromRaw, responseOf, responseText } from './fetch.js';
import { location } from './location.js';

// The sources by the host's id for their connection: the TOP window's map, a frame's sources too (see websocket.js).
const sources = () => {
  let g = globalThis;
  while (g.__csimParent && g.__csimParent !== g) g = g.__csimParent;
  return (g.__csimEventSources ??= new Map());
};

// A message event's `origin` is the ORIGIN of the stream URL (scheme://host:port), not the full
// URL — per the SSE spec ("origin" of the event stream).
function originOf(url) {
  try { return new globalThis.URL(url).origin; } catch (_) { return url; }
}

// Parse an `text/event-stream` body into dispatchable events (HTML "interpret an event stream").
// A record (fields since the last blank line) with a non-empty data buffer dispatches an event;
// `event` names the type (default 'message'), `id` sets the last event id. A trailing record with
// no closing blank line is NOT dispatched (the stream ended mid-event).
function parseEventStream(text) {
  const events = [];
  let data = [], type = '', lastEventId = '';
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  // The segment after the FINAL '\n' is an incomplete line (the stream ended before its
  // terminator); the spec holds it in a buffer and never processes it. Drop it so a body ending
  // mid-record (e.g. "data: a\n\ndata: b\n") doesn't spuriously dispatch the unterminated record.
  lines.pop();
  for (const line of lines) {
    if (line === '') {
      if (data.length) events.push({type: type || 'message', data: data.join('\n'), lastEventId});
      data = []; type = '';
      continue;
    }
    if (line[0] === ':') continue;   // comment
    const colon = line.indexOf(':');
    let field = line, value = '';
    if (colon >= 0) { field = line.slice(0, colon); value = line.slice(colon + 1); if (value[0] === ' ') value = value.slice(1); }
    if (field === 'data')       data.push(value);
    else if (field === 'event') type = value;
    else if (field === 'id' && value.indexOf('\0') === -1) lastEventId = value;
    // 'retry' is not modeled (no reconnect for the SW-served stream — see _connectViaServiceWorker).
  }
  return events;
}

const CONNECTING = 0, OPEN = 1, CLOSED = 2;

// Its slots: its URL (the parsed one, serialized) and its origin (its message events'), whether it sends credentials, its
// ready state, and the host's id for its connection.
const sourceOf = (o) => slotsOf(o, 'EventSource');
registerInterface('EventSource', (o) => sourceOf(o) !== undefined);
export class EventSource extends EventTarget {
  // The constructor steps (HTML §9.2.2): `url` parsed against the document's base URL (a `<base>`'s too) — failure a
  // SyntaxError — and its
  // connection opened: through the controlling service worker's `fetch` event first where one controls the page.
  constructor(url, eventSourceInitDict) {
    [url, eventSourceInitDict] = convertEventSourceArguments(arguments);
    super();
    const base = (globalThis.document && globalThis.document.baseURI) || location.href || undefined;
    const u = globalThis.__csim_parseUrl(url, base);
    if (!u || u.error || !u.href) {
      throw new DOMException(`Failed to construct 'EventSource': Cannot open an EventSource to '${url}'. The URL is invalid.`, 'SyntaxError');
    }
    const s = makeSlots(this, 'EventSource', {
      url: u.href, origin: originOf(u.href), withCredentials: eventSourceInitDict.withCredentials, readyState: CONNECTING, id: 0
    });
    // Resource Timing: an EventSource connection files an entry whose initiator is 'other'
    // (resource-timing/initiator-type/misc). The stream itself is delivered separately; this
    // records the request the connection makes.
    if (typeof globalThis.__csimRecordResource === 'function') {
      globalThis.__csimRecordResource({ name: s.url, initiatorType: 'other', startTime: globalThis.__csimPerformanceNow() });
    }
    // A controlled client's EventSource connection goes to the controlling SW's `fetch` event
    // first (like fetch): a cors / no-store request the SW may serve a `text/event-stream` body
    // for. A fall-through opens the real connection below.
    const ctrl = globalThis.__csimSWControllerHandle && globalThis.__csimSWControllerHandle();
    if (ctrl) connectViaServiceWorker(this, s, ctrl);
    else openNetwork(this, s);
  }
}
function openNetwork(source, s) {
  try { s.id = globalThis.__csim_eventSourceOpen(s.url) | 0; } catch (_) { s.id = 0; }
  if (s.id > 0) sources().set(s.id, source);
}
// Route the connection request through the controlling SW. A fall-through (no respondWith) opens
// the real connection; a network error / non-200 / non-event-stream response fails the source.
function connectViaServiceWorker(source, s, ctrl) {
  // EventSource always requests mode 'cors' with the http cache bypassed ('no-store'); the
  // credentials mode follows `withCredentials`. The rest are Request defaults.
  const swReq = buildSwRequest({
    credentials: s.withCredentials ? 'include' : 'same-origin',
    cache:       'no-store'
  });
  try {
    globalThis.__csimSWInterceptFetch(ctrl, 'GET', s.url, {Accept: 'text/event-stream'}, null, swReq, (swResp) => {
      if (s.readyState === CLOSED) return;
      if (swResp == null) { openNetwork(source, s); return; }      // SW fell through → real connection
      if (swResp.__networkError) { failSource(source, s); return; }
      deliverServiceWorkerResponse(source, s, swResp);
    });
  } catch (_) { openNetwork(source, s); }
}
function deliverServiceWorkerResponse(source, s, swResp) {
  let resp;
  try { resp = responseFromRaw(swResp, s.url); } catch (_) { failSource(source, s); return; }
  // A non-200 status or a MIME type that isn't text/event-stream fails the source (HTML
  // "process the fetch request" — an error, no reconnect).
  const r = responseOf(resp);
  const ct = (getHeader(r.headers, 'content-type') || '').split(';')[0].trim().toLowerCase();
  if (r.status !== 200 || ct !== 'text/event-stream') { failSource(source, s); return; }
  responseText(resp).then((text) => {
    if (s.readyState === CLOSED) return;
    s.readyState = OPEN;
    dispatchWithOnHandler(source, new Event('open'));
    for (const evt of parseEventStream(text)) {
      if (s.readyState === CLOSED) break;
      dispatchWithOnHandler(source, createMessageEvent(evt.type, {data: evt.data, lastEventId: evt.lastEventId, origin: s.origin}));
    }
    // The SW served a FIXED body (not a live stream), so the stream has ended. We don't
    // reconnect (a live SSE-over-SW stream is a later refinement); the source stays OPEN until
    // close(), matching the harness flow (its message handler closes synchronously).
  }, () => failSource(source, s));
}
// "Fail the connection": closed, and a simple `error` (no reconnect).
function failSource(source, s) {
  if (s.readyState === CLOSED) return;
  s.readyState = CLOSED;
  dispatchWithOnHandler(source, new Event('error'));
}
installEventSource(EventSource, {
  get_url: (es) => sourceOf(es).url,
  get_withCredentials: (es) => sourceOf(es).withCredentials,
  get_readyState: (es) => sourceOf(es).readyState,
  close(es) {
    const s = sourceOf(es);
    if (s.readyState === CLOSED) return;
    s.readyState = CLOSED;
    if (s.id > 0) {
      globalThis.__csim_eventSourceClose(s.id);
      sources().delete(s.id);
    }
  },
  installEventHandlers: (proto, names, isSelf) => installEventHandlerAttrs(proto, names, null, isSelf)
});
globalThis.EventSource = EventSource;

// `events`: Array<{id, type, data?, lastEventId?, message?}> with
// sentinel types `__open` / `__error` for lifecycle transitions and
// any other `type` for an actual SSE event. Don't bump
// `__settleGen` from delivery — the React / Redux render chain
// triggered by the listener is what genuinely changes the DOM, and
// `drain_microtasks` in the next settle iter picks that up
// naturally. Bumping here would cut settle short before those
// microtasks land.
globalThis.__csim_deliverEventSourceEvents = function (events) {
  if (!events || !events.length) return 0;
  let delivered = 0;
  for (const e of events) {
    const src = sources().get(e.id | 0);
    if (!src) continue;
    const s = sourceOf(src);
    if (e.type === '__open') {
      if (s.readyState === CONNECTING) {
        s.readyState = OPEN;
        dispatchWithOnHandler(src, new Event('open'));
        delivered++;
      }
      continue;
    }
    if (e.type === '__error') {
      s.readyState = CLOSED;
      dispatchWithOnHandler(src, new Event('error'));   // (…a simple event, HTML's: no message of its own)
      sources().delete(e.id | 0);
      delivered++;
      continue;
    }
    const type = e.type || 'message';
    dispatchWithOnHandler(src, createMessageEvent(type, {
      data:        e.data == null ? '' : String(e.data),
      lastEventId: e.lastEventId == null ? '' : String(e.lastEventId),
      origin:      s.origin
    }));
    delivered++;
  }
  return delivered;
};
