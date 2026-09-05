// EventSource (SSE) — `new EventSource(url)` opens a TCP-backed
// stream on the Ruby side; events flow back through
// `__csim_deliverEventSourceEvents` which the settle path drains
// each tick. The actual TCP / chunked-parsing work lives in Ruby
// (Browser#event_source_open / #event_source_close) because Net::HTTP
// won't stream chunked bodies through WebMock and we need real
// socket access.

import { Event, MessageEvent, EventTarget, dispatchWithOnHandler, defineEventHandlers } from './events.js';
import { buildSwRequest } from './sw-client.js';

const byId = new Map();
globalThis.__csim_eventSourceById = byId;

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

export class EventSource extends EventTarget {
  constructor(url, options) {
    super();
    // `url` is a USVString (unpaired surrogates → U+FFFD), parsed against the
    // document base URL and stored serialized (so U+FFFD shows as %EF%BF%BD).
    const usv = globalThis.__csimToUSVString ? globalThis.__csimToUSVString(url) : String(url);
    let resolved = usv;
    try {
      const base = (globalThis.document && globalThis.document.URL) ||
                   (globalThis.location && globalThis.location.href) || undefined;
      const u = globalThis.__csim_parseUrl(usv, base);
      if (u && !u.error && u.href) resolved = u.href;
    } catch (_) {}
    this.url             = resolved;
    this.withCredentials = !!(options && options.withCredentials);
    this.readyState      = 0;            // CONNECTING
    this._id             = 0;
    // Resource Timing: an EventSource connection files an entry whose initiator is 'other'
    // (resource-timing/initiator-type/misc). The stream itself is delivered separately; this
    // records the request the connection makes.
    if (typeof globalThis.__csimRecordResource === 'function') {
      globalThis.__csimRecordResource({ name: this.url, initiatorType: 'other',
                                        startTime: globalThis.performance ? globalThis.performance.now() : 0 });
    }
    // A controlled client's EventSource connection goes to the controlling SW's `fetch` event
    // first (like fetch): a cors / no-store request the SW may serve a `text/event-stream` body
    // for. A fall-through opens the real connection below.
    const ctrl = globalThis.__csimSWControllerHandle && globalThis.__csimSWControllerHandle();
    if (ctrl) { this._connectViaServiceWorker(ctrl); return; }
    this._openNetwork();
  }
  _openNetwork() {
    try { this._id = globalThis.__csim_eventSourceOpen(this.url) | 0; } catch (_) { this._id = 0; }
    if (this._id > 0) byId.set(this._id, this);
  }
  // Route the connection request through the controlling SW. A fall-through (no respondWith) opens
  // the real connection; a network error / non-200 / non-event-stream response fails the source.
  _connectViaServiceWorker(ctrl) {
    const self = this;
    // EventSource always requests mode 'cors' with the http cache bypassed ('no-store'); the
    // credentials mode follows `withCredentials`. The rest are Request defaults.
    const swReq = buildSwRequest({
      credentials: this.withCredentials ? 'include' : 'same-origin',
      cache:       'no-store'
    });
    try {
      globalThis.__csimSWInterceptFetch(ctrl, 'GET', this.url, {Accept: 'text/event-stream'}, null, false, swReq, function (swResp) {
        if (self.readyState === 2) return;
        if (swResp == null) { self._openNetwork(); return; }      // SW fell through → real connection
        if (swResp.__networkError) { self._fireError(); return; }
        self._deliverServiceWorkerResponse(swResp);
      });
    } catch (_) { this._openNetwork(); }
  }
  _deliverServiceWorkerResponse(swResp) {
    let resp;
    try { resp = new globalThis.Response(swResp, this.url); } catch (_) { this._fireError(); return; }
    // A non-200 status or a MIME type that isn't text/event-stream fails the source (HTML
    // "process the fetch request" — an error, no reconnect).
    const ct = (resp.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (resp.status !== 200 || ct !== 'text/event-stream') { this._fireError(); return; }
    const self = this;
    resp.text().then(function (text) {
      if (self.readyState === 2) return;
      self.readyState = 1;                          // OPEN
      dispatchWithOnHandler(self, new Event('open'));
      for (const evt of parseEventStream(text)) {
        if (self.readyState === 2) break;
        dispatchWithOnHandler(self, new MessageEvent(evt.type, {data: evt.data, lastEventId: evt.lastEventId, origin: originOf(self.url)}));
      }
      // The SW served a FIXED body (not a live stream), so the stream has ended. We don't
      // reconnect (a live SSE-over-SW stream is a later refinement); the source stays OPEN until
      // close(), matching the harness flow (its message handler closes synchronously).
    }, function () { self._fireError(); });
  }
  _fireError() {
    if (this.readyState === 2) return;
    this.readyState = 2;                            // CLOSED (fatal — no reconnect)
    dispatchWithOnHandler(this, new Event('error'));
  }
  close() {
    if (this.readyState === 2) return;
    this.readyState = 2;
    if (this._id > 0) {
      globalThis.__csim_eventSourceClose(this._id);
      byId.delete(this._id);
    }
  }
}
EventSource.CONNECTING = 0;
EventSource.OPEN       = 1;
EventSource.CLOSED     = 2;

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
    const src = byId.get(e.id | 0);
    if (!src) continue;
    if (e.type === '__open') {
      if (src.readyState === 0) {
        src.readyState = 1;
        dispatchWithOnHandler(src, new Event('open'));
        delivered++;
      }
      continue;
    }
    if (e.type === '__error') {
      src.readyState = 2;
      const evt = new Event('error');
      if (e.message) try { evt.message = String(e.message); } catch (_) {}
      dispatchWithOnHandler(src, evt);
      byId.delete(e.id | 0);
      delivered++;
      continue;
    }
    const type = e.type || 'message';
    dispatchWithOnHandler(src, new MessageEvent(type, {
      data:        e.data == null ? '' : String(e.data),
      lastEventId: e.lastEventId == null ? '' : String(e.lastEventId),
      origin:      originOf(src.url)
    }));
    delivered++;
  }
  return delivered;
};

defineEventHandlers(EventSource.prototype, ['open', 'message', 'error']);
globalThis.EventSource = EventSource;
