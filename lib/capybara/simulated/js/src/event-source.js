// EventSource (SSE), generated from its IDL — `new EventSource(url)` hands its request to the host, which fetches it as
// every request is fetched and reads the stream as it comes (Browser#event_source_open / #event_source_close); events
// flow back through `__csim_deliverEventSourceEvents`, which the settle path drains each tick.

import { Event, EventTarget, createMessageEvent, dispatchWithOnHandler, installEventHandlerAttrs } from './events.js';
import { buildSwRequest, controllerHandle, requestRoute } from './sw-client.js';
import { J_EVENT_SOURCE, ROUTE_SERVICE_WORKER } from './constants.js';
import { convertEventSourceArguments, installEventSource } from './generated/bindings.js';
import { makeSlots, promiseThen, registerInterface, slotsOf } from './webidl.js';
import { getHeader } from './headers.js';
import { responseFromRaw, responseOf, responseText } from './fetch.js';
import { apiURLSettings } from './base-url.js';
import { clientReferrerSource, containerReferrerPolicy, hostRequest } from './document-origin.js';
import { hostTask, queueTask } from './timers.js';

// The sources by the host's id for their connection, each `{target, deliver}`: the TOP window's map, a frame's sources
// too (see websocket.js).
const sources = () => {
  let g = globalThis;
  while (g.__csimParent && g.__csimParent !== g) g = g.__csimParent;
  if (!g.__csimEventSources) Object.defineProperty(g, '__csimEventSources', { value: new Map(), configurable: true });
  return g.__csimEventSources;
};

// A `text/event-stream` body's events (HTML "interpret an event stream"), the engine's reading (event_stream.rs) — a
// record a blank line ends dispatched where it has data, one the stream ended in the middle of not — and what a
// reconnection after it asks with: the last event ID string and the reconnection time it set (-1 for none). Of a source
// whose last event ID string is `lastEventId`: a reconnection's stream starts from it.
function parseEventStream(text, lastEventId) {
  const flat = globalThis.__dom.eventStream(text, lastEventId), events = [];
  for (let i = 0; i < flat.length - 2; i += 3) events.push({ type: flat[i], data: flat[i + 1], lastEventId: flat[i + 2] });
  return { events, lastEventId: flat[flat.length - 2], retry: flat[flat.length - 1] };
}

// The source's connection as the page sees it is the engine's (event_source_state.rs): its URL and its messages' origin,
// whether it sends credentials, its ready state, the host's id for its connection, and what each delivery does to it —
// the fields `esField` reads, and the event `esDeliver` / `esServed` answer to fire.
const URL_FIELD = 0, ORIGIN = 1, WITH_CREDENTIALS = 2, READY_STATE = 3, LAST_EVENT_ID = 4;
const CONNECTING = 0, CLOSED = 2;
const FIRE_OPEN = 1, FIRE_ERROR = 2, FIRE_MESSAGE = 3;
const stateOf = (o) => slotsOf(o, 'EventSource')?.state;
const field = (o, f) => globalThis.__dom.esField(stateOf(o), f);
registerInterface('EventSource', (o) => stateOf(o) !== undefined);
export class EventSource extends EventTarget {
  // The constructor steps (HTML §9.2.2), the engine's: `url` encoding-parsed relative to the settings object — failure a
  // SyntaxError — and its connection opened: through the controlling service worker's `fetch` event first where one
  // controls the page.
  constructor(url, eventSourceInitDict) {
    [url, eventSourceInitDict] = convertEventSourceArguments(arguments);
    super();
    const [base, encoding] = apiURLSettings();
    const state = new globalThis.__dom.EventSourceStateBase(url, base, encoding, eventSourceInitDict.withCredentials);
    makeSlots(this, 'EventSource', { state });
    const href = field(this, URL_FIELD);
    // Resource Timing: an EventSource connection files an entry whose initiator is 'other'
    // (resource-timing/initiator-type/misc). The stream itself is delivered separately; this
    // records the request the connection makes.
    if (typeof globalThis.__csimRecordResource === 'function') {
      globalThis.__csimRecordResource({ name: href, kind: J_EVENT_SOURCE, startTime: globalThis.__csimPerformanceNow() });
    }
    connect(this);
  }
}
// HTML "establish the connection", at construction and at each reconnection: a controlled client's connection goes to
// the controlling SW's `fetch` event first (like fetch) — a cors / no-store request the SW may serve a
// `text/event-stream` body for, an http(s) one alone (sw-client.js `requestRoute`) — and a fall-through, or no
// controller, opens the real connection.
function connect(source) {
  const ctrl = controllerHandle();
  if (ctrl && requestRoute(field(source, URL_FIELD), 0, ctrl) === ROUTE_SERVICE_WORKER) connectViaServiceWorker(source, ctrl);
  else openNetwork(source);
}
// (…its header list: the event stream type it accepts, and on a reconnection the last event ID string its stream left,
// where that is not empty)
function requestHeaders(source) {
  const lastEventId = field(source, LAST_EVENT_ID);
  return lastEventId ? { Accept: 'text/event-stream', 'Last-Event-ID': lastEventId } : { Accept: 'text/event-stream' };
}
// HTML "reestablish the connection": the source connecting again and an `error` fired — none where it is closed already
// — and once its reconnection time has passed (on the virtual clock), the connection established anew, unless the
// source was closed or reconnected meanwhile. `lastEventId` and `retry` what its stream left it (-1: no retry).
function reestablish(source, lastEventId, retry) {
  const wait = globalThis.__dom.esReconnect(stateOf(source), lastEventId, retry);
  if (wait < 0) return false;
  dispatchWithOnHandler(source, new Event('error'));
  queueTask(() => { if (field(source, READY_STATE) === CONNECTING) connect(source); }, wait);
  return true;
}
// HTML "establish the connection": a GET of the source's URL, `Accept: text/event-stream`, its mode `cors`, its
// credentials mode as `withCredentials` says, the HTTP cache bypassed (`no-store`) — under its client's referrer policy
// and referred by it, as every request of no referrer of its own is.
function openNetwork(source) {
  let id = 0;
  try {
    const request = hostRequest({
      method:         'GET',
      url:            field(source, URL_FIELD),
      headers:        requestHeaders(source),
      redirect:       'follow',
      mode:           'cors',
      credentials:    field(source, WITH_CREDENTIALS) ? 'include' : 'same-origin',
      referrerPolicy: containerReferrerPolicy(),
      referrer:       clientReferrerSource(),
      cache:          'no-store',
      dest:           ''
    });
    id = globalThis.__csim_eventSourceOpen(request) | 0;
  } catch (_) { id = 0; }
  globalThis.__dom.esSetId(stateOf(source), id);
  if (id > 0) sources().set(id, { target: source, deliver: deliverOne });
}
// …and the sources of this realm a controlling service worker answers, which have no host connection to be found by:
// the unloading document cleanup steps close them too (`__csimDropEventSources`).
const served = new Set();
// Route the connection request through the controlling SW. A fall-through (no respondWith) opens
// the real connection; a network error / non-200 / non-event-stream response fails the source.
function connectViaServiceWorker(source, ctrl) {
  served.add(source);
  // EventSource always requests mode 'cors' with the http cache bypassed ('no-store'); the
  // credentials mode follows `withCredentials`. The rest are Request defaults.
  const swReq = buildSwRequest({
    credentials: field(source, WITH_CREDENTIALS) ? 'include' : 'same-origin',
    cache:       'no-store'
  });
  try {
    globalThis.__csimSWInterceptFetch(ctrl, 'GET', field(source, URL_FIELD), requestHeaders(source), null, swReq, (swResp) => {
      if (field(source, READY_STATE) === CLOSED) return;
      if (swResp == null) { served.delete(source); openNetwork(source); return; }      // SW fell through → real connection
      if (swResp.__networkError) { failSource(source); return; }
      deliverServiceWorkerResponse(source, swResp);
    });
  } catch (_) { served.delete(source); openNetwork(source); }
}
// The SW's answer, as "process the event source response" takes it (`esServed`): a status other than 200, or no
// `text/event-stream`, fails the source — an error, no reconnect — and any other announces the connection at once, its
// head's (open, and its `open`, in the one task), its body's events dispatched as the body is read.
function deliverServiceWorkerResponse(source, swResp) {
  let resp;
  try { resp = responseFromRaw(swResp, field(source, URL_FIELD)); } catch (_) { failSource(source); return; }
  const r = responseOf(resp);
  const fire = globalThis.__dom.esServed(stateOf(source), r.status, getHeader(r.headers, 'content-type') || '', swResp.url || undefined);
  if (fire === FIRE_ERROR) { served.delete(source); dispatchWithOnHandler(source, new Event('error')); return; }
  if (fire !== FIRE_OPEN) return;
  dispatchWithOnHandler(source, new Event('open'));
  promiseThen.call(responseText(resp), (text) => {
    const origin = field(source, ORIGIN), stream = parseEventStream(text, field(source, LAST_EVENT_ID));
    for (const evt of stream.events) {
      if (field(source, READY_STATE) === CLOSED) return;
      dispatchWithOnHandler(source, createMessageEvent(evt.type, {data: evt.data, lastEventId: evt.lastEventId, origin}));
    }
    // (…the body read whole, its events after: a stream the worker keeps feeding delivers what it fed once it closes —
    // and then, as any stream that ends, reconnects)
    served.delete(source);
    reestablish(source, stream.lastEventId, stream.retry);
  }, () => failSource(source));
}
// "Fail the connection": closed, and a simple `error` (no reconnect) — none for one closed already.
function failSource(source) {
  served.delete(source);
  if (globalThis.__dom.esDeliver(stateOf(source), '__fail') === FIRE_ERROR) dispatchWithOnHandler(source, new Event('error'));
}
installEventSource(EventSource, {
  get_url: (es) => field(es, URL_FIELD),
  get_withCredentials: (es) => field(es, WITH_CREDENTIALS),
  get_readyState: (es) => field(es, READY_STATE),
  close(es) {
    served.delete(es);
    const id = globalThis.__dom.esClose(stateOf(es));
    if (id > 0) {
      globalThis.__csim_eventSourceClose(id);
      sources().delete(id);
    }
  },
  installEventHandlers: installEventHandlerAttrs
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
// The host delivers every connection's events through the top window's realm; each source is handed its own through its
// own realm's delivery (`deliverOne`), so its events, and the Blob or ArrayBuffer a message carries, are its realm's.
globalThis.__csim_deliverEventSourceEvents = hostTask(function (events) {
  if (!events || !events.length) return 0;
  let delivered = 0;
  for (const e of events) {
    const entry = sources().get(e.id | 0);
    if (entry) delivered += entry.deliver(entry.target, e);
  }
  return delivered;
});
// One event to src, in this realm, as the engine says it changes the source (`esDeliver`): 1 where it fired one. A
// `__reconnect` — the stream ended — reestablishes it, its connection gone.
function deliverOne(src, e) {
  if (e.type === '__reconnect') {
    sources().delete(e.id | 0);
    return reestablish(src, e.lastEventId == null ? '' : String(e.lastEventId), e.retry == null ? -1 : e.retry) ? 1 : 0;
  }
  const fire = globalThis.__dom.esDeliver(stateOf(src), e.type || 'message', e.url);
  if (fire === FIRE_OPEN) dispatchWithOnHandler(src, new Event('open'));
  else if (fire === FIRE_ERROR) {
    dispatchWithOnHandler(src, new Event('error'));   // (…a simple event, HTML's: no message of its own)
    sources().delete(e.id | 0);
  } else if (fire === FIRE_MESSAGE) {
    dispatchWithOnHandler(src, createMessageEvent(e.type || 'message', {
      data:        e.data == null ? '' : String(e.data),
      lastEventId: e.lastEventId == null ? '' : String(e.lastEventId),
      origin:      field(src, ORIGIN)
    }));
  }
  return fire === 0 ? 0 : 1;
}

// HTML "abort a document" (`window.stop()`): its fetches cancelled — an aborted network error, which fails each source
// whose connection is in flight, connecting or reading its body, in a task of its own (`failSource`); a service worker's
// answer awaited the same. One waiting to reconnect has no fetch to cancel, and goes on waiting.
globalThis.__csimAbortEventSources = function () {
  for (const [id, entry] of sources()) {
    if (entry.deliver !== deliverOne) continue;
    sources().delete(id);
    globalThis.__csim_eventSourceClose(id);
    queueTask(() => failSource(entry.target));
  }
  for (const source of served) queueTask(() => failSource(source));
  served.clear();
};

// "Unloading document cleanup steps": this realm's sources closed as its document goes (a frame removed or navigated).
globalThis.__csimDropEventSources = function () {
  for (const [id, entry] of sources()) {
    if (entry.deliver !== deliverOne) continue;
    sources().delete(id);
    globalThis.__dom.esClose(stateOf(entry.target));
    globalThis.__csim_eventSourceClose(id);
  }
  for (const source of served) globalThis.__dom.esClose(stateOf(source));
  served.clear();
};
