// EventSource (SSE), generated from its IDL — `new EventSource(url)` hands its request (the engine's: fetch_request.rs
// `eventSourceRequest`) to the controlling service worker, or to the host, which fetches it as every request is fetched
// and reads the stream as it comes (Browser#event_source_open / #event_source_close); events flow back through
// `deliverEventSourceEvents`, in the realm whose source opened the connection. The source's state, and the realm's
// sources, are the engine's (event_source_state.rs).

import { Event, EventTarget, createMessageEvent, dispatchWithOnHandler, installEventHandlerAttrs } from './events.js';
import { clientId, controllerHandle } from './sw-client.js';
import { J_EVENT_SOURCE, ROUTE_SERVICE_WORKER } from './constants.js';
import { convertEventSourceArguments, installEventSource } from './generated/bindings.js';
import { makeSlots, promiseThen, registerInterface, slotsOf, inheritInterface, createObject } from './webidl.js';
import { getHeader } from './headers.js';
import { responseFromRaw, responseOf, responseText } from './fetch.js';
import { apiURLSettings } from './base-url.js';
import { hostTask, queueTask } from './timers.js';
import { dom, hostObject, hostSteps, listPush, newList, realmHooks } from './engine.js';
import { reflectApply } from './intrinsics.js';

// A `text/event-stream` body's events (HTML "interpret an event stream"), the engine's reading (event_stream.rs) — a
// record a blank line ends dispatched where it has data, one the stream ended in the middle of not — and what a
// reconnection after it asks with: the last event ID string and the reconnection time it set (-1 for none). Of a source
// whose last event ID string is `lastEventId`: a reconnection's stream starts from it.
function parseEventStream(text, lastEventId) {
  const flat = dom.eventStream(text, lastEventId), events = newList();
  for (let i = 0; i < flat.length - 2; i += 3) listPush(events, { type: flat[i], data: flat[i + 1], lastEventId: flat[i + 2] });
  return { events, lastEventId: flat[flat.length - 2], retry: flat[flat.length - 1] };
}

// The source's connection as the page sees it is the engine's (event_source_state.rs): its URL and its messages' origin,
// whether it sends credentials, its ready state, what its connection waits on, and what each delivery does to it — the
// fields `esField` reads, and the event `esDeliver` / `esServed` answer to fire.
const URL_FIELD = 0, ORIGIN = 1, WITH_CREDENTIALS = 2, READY_STATE = 3, LAST_EVENT_ID = 4;
const CLOSED = 2;
const FIRE_OPEN = 1, FIRE_ERROR = 2, FIRE_MESSAGE = 3;
const stateOf = (o) => slotsOf(o, 'EventSource')?.state;
const field = (o, f) => dom.esField(stateOf(o), f);
registerInterface('EventSource', (o) => stateOf(o) !== undefined);
export class EventSource extends Object {
  // The constructor steps (HTML §9.2.2), the engine's: `url` encoding-parsed relative to the settings object — failure a
  // SyntaxError — and its connection opened: through the controlling service worker's `fetch` event first where one
  // controls the page.
  constructor(url, eventSourceInitDict) {
    const converted = convertEventSourceArguments(arguments);
    url = converted[0];
    eventSourceInitDict = converted[1];
    const settings = apiURLSettings(), base = settings[0], encoding = settings[1];
    const state = new dom.EventSourceStateBase(url, base, encoding, eventSourceInitDict.withCredentials);
    const self = createObject(new.target);
    makeSlots(self, 'EventSource').state = state;
    dom.esRegister(state, self);
    const href = field(self, URL_FIELD);
    // Resource Timing: an EventSource connection files an entry whose initiator is 'other'
    // (resource-timing/initiator-type/misc). The stream itself is delivered separately; this
    // records the request the connection makes.
    if (typeof realmHooks.recordResource === 'function') {
      realmHooks.recordResource({ name: href, kind: J_EVENT_SOURCE, startTime: realmHooks.performanceNow() });
    }
    connect(self);
    return self;
  }
}
inheritInterface(EventSource, EventTarget);
// HTML "establish the connection", at construction and at each reconnection: its request (`eventSourceRequest`) goes to
// the controlling SW's `fetch` event first where one answers it (like fetch) — a cors / no-store request the SW may serve
// a `text/event-stream` body for, an http(s) one alone — and a fall-through, or no controller, opens the real connection.
function connect(source) {
  const ctrl = controllerHandle();
  const r = dom.eventSourceRequest(stateOf(source), ctrl, ctrl ? clientId() : '');
  if (r[0] === ROUTE_SERVICE_WORKER) connectViaServiceWorker(source, ctrl, r[1], r[2]);
  else openNetwork(source, r[1]);
}
// HTML "reestablish the connection": the source connecting again and an `error` fired — none where it is closed already
// — and once its reconnection time has passed (on the virtual clock), the connection established anew, unless the
// source was closed or reconnected meanwhile (`esReconnectDue`). `lastEventId` and `retry` what its stream left it (-1:
// no retry).
function reestablish(source, lastEventId, retry) {
  const wait = dom.esReconnect(stateOf(source), lastEventId, retry);
  if (wait < 0) return false;
  dispatchWithOnHandler(source, new Event('error'));
  queueTask(() => { if (dom.esReconnectDue(stateOf(source))) connect(source); }, wait);
  return true;
}
// The connection the host makes of `request`, whose events are this realm's to deliver.
function openNetwork(source, request) {
  let id = 0;
  try { id = hostObject.eventSourceOpen(request) | 0; } catch (_) { id = 0; }
  dom.esSetId(stateOf(source), id);
}
// Route the connection request through the controlling SW (`worker` the request its fetch event is made of: the wire). A
// fall-through (no respondWith) opens the real connection; a network error / non-200 / non-event-stream response fails
// the source.
function connectViaServiceWorker(source, ctrl, request, worker) {
  dom.esSetId(stateOf(source), -1);
  try {
    realmHooks.swInterceptFetch(ctrl, worker, (swResp) => {
      if (field(source, READY_STATE) === CLOSED) return;
      if (swResp == null) { openNetwork(source, request); return; }      // SW fell through → real connection
      if (swResp.__networkError) { failSource(source); return; }
      deliverServiceWorkerResponse(source, swResp);
    });
  } catch (_) { openNetwork(source, request); }
}
// The SW's answer, as "process the event source response" takes it (`esServed`): a status other than 200, or no
// `text/event-stream`, fails the source — an error, no reconnect — and any other announces the connection at once, its
// head's (open, and its `open`, in the one task), its body's events dispatched as the body is read.
function deliverServiceWorkerResponse(source, swResp) {
  let resp;
  try { resp = responseFromRaw(swResp, field(source, URL_FIELD)); } catch (_) { failSource(source); return; }
  const r = responseOf(resp);
  const fire = dom.esServed(stateOf(source), r.status, getHeader(r.headers, 'content-type') || '', swResp.url || undefined);
  if (fire === FIRE_ERROR) { dispatchWithOnHandler(source, new Event('error')); return; }
  if (fire !== FIRE_OPEN) return;
  dispatchWithOnHandler(source, new Event('open'));
  reflectApply(promiseThen, responseText(resp), [(text) => {
    const origin = field(source, ORIGIN), stream = parseEventStream(text, field(source, LAST_EVENT_ID));
    for (let i = 0, list = stream.events; i < list.length; i++) {
      const evt = list[i];
      if (field(source, READY_STATE) === CLOSED) return;
      dispatchWithOnHandler(source, createMessageEvent(evt.type, {data: evt.data, lastEventId: evt.lastEventId, origin}));
    }
    // (…the body read whole, its events after: a stream the worker keeps feeding delivers what it fed once it closes —
    // and then, as any stream that ends, reconnects)
    // (…in a task of its own, as HTML queues it: this is a promise reaction's microtask — its fetch over now, which a
    // window.stop() meanwhile has nothing of to abort)
    dom.esSetId(stateOf(source), -2);
    queueTask(() => reestablish(source, stream.lastEventId, stream.retry));
  }, () => failSource(source)]);
}
// "Fail the connection": closed, and a simple `error` (no reconnect) — none for one closed already.
function failSource(source) {
  if (dom.esDeliver(stateOf(source), '__fail') === FIRE_ERROR) dispatchWithOnHandler(source, new Event('error'));
}
installEventSource(EventSource, {
  get_url: (es) => field(es, URL_FIELD),
  get_withCredentials: (es) => field(es, WITH_CREDENTIALS),
  get_readyState: (es) => field(es, READY_STATE),
  close(es) {
    const id = dom.esClose(stateOf(es));
    if (id > 0) hostObject.eventSourceClose(id);
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
// The host delivers a connection's events in the realm whose source opened it (Browser#deliver_event_source_events), so
// its events, and the Blob or ArrayBuffer a message carries, are its realm's; one of a source closed since — or one
// reconnecting, whose old connection's events come late — is not delivered.
hostSteps.deliverEventSourceEvents = hostTask(function (events) {
  if (!events || !events.length) return 0;
  let delivered = 0;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    const source = dom.esSourceOf(e.id | 0);
    if (source) delivered += deliverOne(source, e);
  }
  return delivered;
});
// One event to src, in this realm, as the engine says it changes the source (`esDeliver`): 1 where it fired one. A
// `__reconnect` — the stream ended — reestablishes it, its connection gone.
function deliverOne(src, e) {
  if (e.type === '__reconnect') {
    return reestablish(src, e.lastEventId == null ? '' : String(e.lastEventId), e.retry == null ? -1 : e.retry) ? 1 : 0;
  }
  const fire = dom.esDeliver(stateOf(src), e.type || 'message', e.url);
  if (fire === FIRE_OPEN) dispatchWithOnHandler(src, new Event('open'));
  else if (fire === FIRE_ERROR) {
    dispatchWithOnHandler(src, new Event('error'));   // (…a simple event, HTML's: no message of its own)
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
// whose connection is in flight, connecting or reading its body, or awaiting a service worker's answer: each closed now
// (`esAbort`), its `error` in a task of its own, so nothing that arrives before the task finds it open. One waiting to
// reconnect has no fetch to cancel, and goes on waiting.
realmHooks.abortEventSources = function () {
  const aborted = dom.esAbort();
  for (let i = 0; i < aborted.length; i += 2) {
    const source = aborted[i], id = aborted[i + 1];
    if (id > 0) hostObject.eventSourceClose(id);
    queueTask(() => dispatchWithOnHandler(source, new Event('error')));
  }
};

// "Unloading document cleanup steps": this realm's sources closed as its document goes (a frame removed or navigated).
realmHooks.dropEventSources = function () {
  const ids = dom.esDrop();
  for (let i = 0; i < ids.length; i++) hostObject.eventSourceClose(ids[i]);
};
