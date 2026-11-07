// The Service Worker objects, generated from their IDL: what a page script observes for a registered service worker —
// `navigator.serviceWorker` (ServiceWorkerContainer), the ServiceWorkerRegistration, and its ServiceWorker objects
// (installing / waiting / active) with their lifecycle `state` + `statechange` / `updatefound` events — and the service
// worker's own view of itself and its registration (`self.serviceWorker`, `self.registration`), the same interfaces'.
//
// The service worker ITSELF runs as a separate-isolate executor worker
// (`worker_spawn(service: true)` → its own V8 isolate + Ruby thread). Every global's objects
// — a window's, a frame's, a worker's, the service worker's own — are views of the host's
// registry (sw_registry.rs): the host steps each version's lifecycle (installing → installed
// → activating → activated — browser.rb sw_step), a task apart so a listener attached in the
// register-promise `.then` chain observes each transition, and every global's objects take
// each step as its events (Update Worker State). The SW's own `install` / `activate` handlers
// run in the worker isolate (see `__csim_installServiceWorkerScope`), each as the host's step
// reaches it.

import { EventTarget, Event, createMessageEvent, dispatchWithOnHandler, installEventHandlerAttrs } from './events.js';
import { decodeMessage, encodeMessage, messageEventType, sentAt } from './workers.js';
import { askedWorker, atItsTime, clockAtLeast, clockNow, followWindowClock, hostTask, hostWait, queueTask } from './timers.js';
import { requestBodyBase64 } from './request-body.js';
import { rawFromWire } from './response-wire.js';
import { apiBaseURL } from './platform-globals.js';
import { clientReferrerSource, documentOrigin, documentOriginIsOpaque } from './document-origin.js';
import { parseURL } from './url-parse.js';
import {
  installNavigationPreloadManager,
  installServiceWorker,
  installServiceWorkerContainer,
  installServiceWorkerRegistration
} from './generated/bindings.js';
import {
  IntrinsicPromise,
  PLATFORM,
  constructedBy,
  jsonParse,
  jsonStringify,
  makeSlots,
  registerInterface,
  rejectedPromise,
  resolvedPromise,
  slotsOf,
  inheritInterface,
  NO_ARGUMENTS,
  PlainObject,
  reflectConstruct
} from './webidl.js';
import { ReadableStream } from './streams.js';
import { DOMException } from './dom-exception.js';
import { responseHeader } from './header-rules.js';
import { asciiLower } from './ascii.js';
import { FETCH_CONTROLLED, FETCH_SAME_ORIGIN, ROUTE_SERVICE_WORKER } from './constants.js';

// This browsing context's id as a service-worker client (the source of client→SW
// messages, and the routing key for SW→client replies): its document's environment id —
// the reserved client id its navigation's chain minted, which the realm ADOPTED (the host's
// telling, realm_identity.rs `realmClientId`: create_frame_realm, Browser#boot_response_into_ctx),
// a new one for each document of the page though its realm is reused — so its reply is
// delivered back to THAT document's navigator.serviceWorker (Browser#deliver_worker_messages
// routes by this id), clients.matchAll() tells frames apart, and `event.resultingClientId` ===
// clients.get(...).id === the id this context messages the SW as. `client-<realm>`, matching
// the browser's Client registry, for a realm built outside a chain.
export function clientId() {
  return globalThis.__dom.realmClientId() ?? 'client-' + globalThis.__csimClientSpace() + globalThis.__csimRealmId();
}

// NavigationPreloadManager (Service Workers §3.5) — `registration.navigationPreload` — generated from its IDL, made by
// the platform alone, its slot the registration it is of. The enabled flag and header value are the registration's,
// held Ruby-side by its scope (so the client and the service worker's isolate observe one shared state, an update
// keeps it, and a navigation can read it). A registration with no active worker has none to set: enable / disable /
// setHeaderValue then reject with an InvalidStateError (getState still answers).
const preloadOf = (o) => slotsOf(o, 'NavigationPreloadManager');
registerInterface('NavigationPreloadManager', (o) => preloadOf(o) !== undefined);
class NavigationPreloadManager {
  constructor(token, registration) {
    constructedBy(PLATFORM, token, 'NavigationPreloadManager');
    makeSlots(this, 'NavigationPreloadManager').registration = registration;
  }
}
function setPreload(manager, enabled, header) {
  const reg = preloadOf(manager).registration;
  const r = registrationOf(reg);
  if (!versionsOf(reg).active) return rejectedPromise(new DOMException('There is no active worker for navigation preload.', 'InvalidStateError'));
  try { globalThis.__csim_swNavPreloadSet(r.scope, enabled, header, storageSite()); } catch (_) {}
  return resolvedPromise(undefined);
}
installNavigationPreloadManager(NavigationPreloadManager, {
  enable: (manager) => setPreload(manager, true, null),
  disable: (manager) => setPreload(manager, false, null),
  // (…a ByteString, which the bindings converted, that is a header value: no NUL, CR or LF, and no leading or trailing
  // tab or space — Fetch's "header value")
  setHeaderValue(manager, value) {
    if (!globalThis.__dom.headerValue(value)) {
      return rejectedPromise(new TypeError("Failed to execute 'setHeaderValue' on 'NavigationPreloadManager': The string contains invalid characters."));
    }
    return setPreload(manager, null, value);
  },
  getState(manager) {
    const st = globalThis.__csim_swNavPreloadState(registrationOf(preloadOf(manager).registration).scope, storageSite()) || {};
    return resolvedPromise({ enabled: !!st.enabled, headerValue: String(st.headerValue) });
  }
});
globalThis.NavigationPreloadManager = NavigationPreloadManager;

// This realm's objects of the session's registrations and service workers — one of each per realm (Service Workers "get
// the service worker registration object" / "get the service worker object"), made as a client first meets it:
// registration number → ServiceWorkerRegistration, worker handle → ServiceWorker. What they reflect — a registration's
// versions, a worker's state — is the host's registry (sw_registry.rs), which every realm reads alike; what changes it
// reaches every realm's objects as their events (`__csim_swWorkerStateChanged`, `__csim_swRegistrationUpdateFound`).
const registrationObjects = new Map();
const workerByHandle      = new Map();

// ServiceWorker (Service Workers §3.1), generated from its IDL — made by the platform alone: a client's reflection of a
// worker (a registration's version, a controller, the service worker a global is). Its slots: its script URL and state,
// and the handle of the worker it reflects.
const workerOf = (o) => slotsOf(o, 'ServiceWorker');
registerInterface('ServiceWorker', (o) => workerOf(o) !== undefined);
class ServiceWorker extends Object {
  constructor(token, scriptURL, state, handle) {
    constructedBy(PLATFORM, token, 'ServiceWorker');
    const self = reflectConstruct(PlainObject, NO_ARGUMENTS, new.target);
    const slots = makeSlots(self, 'ServiceWorker');
    slots.scriptURL = scriptURL;
    slots.state = state;
    slots.handle = handle;
    return self;
  }
}
inheritInterface(ServiceWorker, EventTarget);
// This realm's of the worker `handle`, which follows the window's clock (its worker's timers run on it), made where it
// has none — its script URL and state the registry's (`scriptURL` for a worker the registry has none of).
function workerObject(handle, scriptURL = '') {
  const h = handle | 0;
  let worker = workerByHandle.get(h);
  if (!worker) {
    let rec = null;
    try { rec = globalThis.__csim_swWorker(h); } catch (_) {}
    followWindowClock();
    worker = new ServiceWorker(PLATFORM, rec ? String(rec[0]) : scriptURL, rec ? String(rec[2]) : 'activated', h);
    workerByHandle.set(h, worker);
  }
  return worker;
}
// A worker's state moved: `statechange` fired where it is a change.
function setWorkerState(worker, state) {
  const w = workerOf(worker);
  if (w.state === state) return;
  w.state = state;
  dispatchWithOnHandler(worker, new Event('statechange'));
}
// SW postMessage: serialized and routed to the SW's `message` event (source = this client, or the service worker this
// global is — itself among them, or another version of its registration). The SW replies via `event.source.postMessage`,
// delivered to this container's 'message' event (see __csim_swDeliverClientMessage). An uncloneable message, or a bad
// transfer list, is the caller's DataCloneError.
function postToWorker(worker, message, transfer) {
  const payload = encodeMessage(message, transfer);
  const href = (globalThis.location && globalThis.location.href) || '';
  const sender = ownWorker ? workerOf(ownWorker).handle : 0;
  try { globalThis.__csim_serviceWorkerPostMessage(workerOf(worker).handle, payload, clientId(), href, sender); } catch (_) {}
  askedWorker();
}
installServiceWorker(ServiceWorker, {
  postMessage_message_transfer: (worker, message, transfer) => postToWorker(worker, message, transfer),
  postMessage_message_options: (worker, message, options) => postToWorker(worker, message, options.transfer),
  installEventHandlers: installEventHandlerAttrs
});

// ServiceWorkerRegistration (Service Workers §3.2), generated from its IDL — made by the platform alone, one per
// registration in a realm (`registrationObjects`), the service worker's own (`self.registration`) among them. Its slots:
// its scope, its number in the registry, its versions as it last read them from there, its updateViaCache mode as this
// side last knew it, and its NavigationPreloadManager ([SameObject], made at the first read).
const registrationOf = (o) => slotsOf(o, 'ServiceWorkerRegistration');
registerInterface('ServiceWorkerRegistration', (o) => registrationOf(o) !== undefined);
class ServiceWorkerRegistration extends Object {
  constructor(token, scope, id) {
    constructedBy(PLATFORM, token, 'ServiceWorkerRegistration');
    const self = reflectConstruct(PlainObject, NO_ARGUMENTS, new.target);
    const slots = makeSlots(self, 'ServiceWorkerRegistration');
    slots.scope = scope;
    slots.id = id;
    slots.installing = null;
    slots.waiting = null;
    slots.active = null;
    slots.updateViaCache = 'imports';
    slots.navigationPreload = null;
    return self;
  }
}
inheritInterface(ServiceWorkerRegistration, EventTarget);
// A registration's versions, `{installing, waiting, active}` (each a ServiceWorker or null): the registry's, kept in its
// slots as last read — a discarded document's object, which reaches the host no more, answers with them.
function versionsOf(reg) {
  const r = registrationOf(reg);
  let handles;
  try { handles = globalThis.__csim_swVersions(r.id); } catch (_) {}
  if (handles) {
    const at = (i) => (handles[i] ? workerObject(handles[i]) : null);
    r.installing = at(0);
    r.waiting    = at(1);
    r.active     = at(2);
  }
  return { installing: r.installing, waiting: r.waiting, active: r.active };
}
// …whether the registration map holds it at its scope.
function isLive(reg) {
  try { return (globalThis.__csim_swRegisteredAt(registrationOf(reg).scope, storageSite()) | 0) === registrationOf(reg).id; } catch (_) { return false; }
}
// A registration's updateViaCache mode — REGISTRATION-wide state that lives host-side (a frame's registration object
// must see the mode the top window set — registration-updateviacache's cross-frame cases), read while it is its scope's
// live registration. The local echo is what survives unregister: a dead registration keeps its last value, even after a
// NEW registration reclaims the scope with a different mode.
function updateViaCacheOf(reg) {
  const r = registrationOf(reg);
  if (isLive(reg)) {
    try {
      const v = globalThis.__csim_swScopeUpdateViaCache && globalThis.__csim_swScopeUpdateViaCache(r.scope, storageSite());
      if (v) r.updateViaCache = v;
    } catch (_) {}
  }
  return r.updateViaCache;
}
installServiceWorkerRegistration(ServiceWorkerRegistration, {
  get_installing: (reg) => versionsOf(reg).installing,
  get_waiting: (reg) => versionsOf(reg).waiting,
  get_active: (reg) => versionsOf(reg).active,
  get_updateViaCache: (reg) => updateViaCacheOf(reg),
  get_navigationPreload: (reg) => (registrationOf(reg).navigationPreload ??= new NavigationPreloadManager(PLATFORM, reg)),
  update: (reg) => scheduleJob('update', '', registrationOf(reg).scope, null, '', registrationOf(reg).id),
  // (…the Unregister job at its scope, resolving with whether the map held a registration there — false once it is
  // already gone: "Unregister twice")
  unregister: (reg) => scheduleJob('unregister', '', registrationOf(reg).scope, null, '', registrationOf(reg).id),
  installEventHandlers: installEventHandlerAttrs
});

// The top-level site of this environment's storage key (Storage "obtain a storage key"): a document's its top-level
// traversable's, a worker's its owner's — the engine's (blob_rules.rs `partition_site`), '' for an opaque one.
const storageSite = () => globalThis.__dom.blobPartitionSite();
// The registration map as this document's storage key has it — `[id, scope]` of each registration, in the order made — and
// the registration `url` matches (Match Service Worker Registration), `[id, scope]` or null: the host's registry, whose
// every registration is of a storage key — an origin and a top-level site (`storageSite`, its environment's: a frame's
// its top-level traversable's, a worker's its owner's) — no other key's seen.
function registrationMap() {
  try { return globalThis.__csim_swRegistrations(documentOrigin(), storageSite()) || []; } catch (_) { return []; }
}
function matchRegistration(url) {
  try { return globalThis.__csim_swMatchRegistration(documentOrigin(), url, storageSite()) || null; } catch (_) { return null; }
}
// This realm's object of the registration `id` at `scope`, made where it has none — and of the one matching `url`.
function registrationObject(id, scope) {
  let reg = registrationObjects.get(id);
  if (!reg) {
    reg = new ServiceWorkerRegistration(PLATFORM, scope, id);
    registrationObjects.set(id, reg);
  }
  return reg;
}
function registrationForURL(url) {
  const entry = matchRegistration(url);
  return entry ? registrationObject(entry[0], entry[1]) : null;
}

// ServiceWorkerContainer (Service Workers §3.4) — `navigator.serviceWorker` — generated from its IDL, made by the
// platform alone. Its slots: its controller, and the handle of the worker a request of its goes to — that controller, where
// it intercepts, else none — its `ready` promise — CACHED (`sw.ready === sw.ready`), resolved with the
// active registration whose scope CONTROLS this client (a prefix of the document URL — not merely "some active
// registration"); resolving is idempotent, so a read after activation returns the settled promise — and the steps of
// its realm (`CONTAINER_STEPS`), whose registrations it answers with whichever realm's members a page calls.
const containerOf = (o) => slotsOf(o, 'ServiceWorkerContainer');
registerInterface('ServiceWorkerContainer', (o) => containerOf(o) !== undefined);
class ServiceWorkerContainer extends Object {
  constructor(token) {
    constructedBy(PLATFORM, token, 'ServiceWorkerContainer');
    // (…and its client message queue: the messages its service workers posted it, held while it is disabled)
    const self = reflectConstruct(PlainObject, NO_ARGUMENTS, new.target);
    const slots = makeSlots(self, 'ServiceWorkerContainer');
    slots.controller = null;
    slots.routingHandle = 0;
    slots.ready = null;
    slots.resolveReady = null;
    slots.steps = CONTAINER_STEPS;
    slots.queued = [];
    slots.queueEnabled = false;
    return self;
  }
}
inheritInterface(ServiceWorkerContainer, EventTarget);
// The container's `ready` resolved, where a registration controls the client now.
function maybeResolveReady(container = serviceWorkerContainer) {
  const c = containerOf(container);
  if (!c.resolveReady) return;
  const reg = activeRegistrationForClient();
  if (reg) c.resolveReady(reg);
}
const CONTAINER_STEPS = {
  maybeResolveReady,
  register: (scriptURL, options) => register(scriptURL, options),
  getRegistration(clientURL) {
    const u = parseURL(clientURL, apiBaseURL());
    if (u === null) return rejectedPromise(new TypeError(`getRegistration: '${clientURL}' is no URL`));
    // Per spec, getRegistration rejects with SecurityError for a cross-origin clientURL
    // (getregistration "with a cross origin URL") — against the DOCUMENT's origin, which a srcdoc
    // frame inherits from its parent (its location's is opaque), and which, opaque, no URL's is.
    if (u.origin !== documentOrigin() || u.origin === 'null') {
      return rejectedPromise(new DOMException('The origin of the provided clientURL does not match the current origin', 'SecurityError'));
    }
    return resolvedInTask(() => registrationForURL(u.href) || undefined);
  },
  // (…a FrozenArray)
  getRegistrations() {
    return resolvedInTask(() => Object.freeze(registrationMap().map(([id, scope]) => registrationObject(id, scope))));
  }
};
// A promise the registry's answer resolves — looked up "in parallel" and resolved by a task queued on this realm's event
// loop (Service Workers `getRegistration()` / `getRegistrations()`), so a state the host is telling every realm of in the
// meantime — a worker activated: each realm's `statechange` — has reached them all first.
const resolvedInTask = (answer) => new IntrinsicPromise((resolve) => { queueTask(() => resolve(answer())); });
installServiceWorkerContainer(ServiceWorkerContainer, {
  get_ready(container) {
    const c = containerOf(container);
    c.ready ??= new IntrinsicPromise(resolve => { c.resolveReady = resolve; });
    c.steps.maybeResolveReady(container);
    return c.ready;
  },
  register: (container, scriptURL, options) => containerOf(container).steps.register(scriptURL, options),
  getRegistration: (container, clientURL) => containerOf(container).steps.getRegistration(clientURL),
  getRegistrations: (container) => containerOf(container).steps.getRegistrations(),
  startMessages: (container) => enableClientMessageQueue(container),
  // (…setting `onmessage` to a handler enables its client message queue as `startMessages()` does (§3.4.7);
  // `addEventListener('message')` does not)
  installEventHandlers(proto, names, isSelf) {
    installEventHandlerAttrs(proto, names, isSelf);
    const handler = Object.getOwnPropertyDescriptor(proto, 'onmessage');
    const { set } = Object.getOwnPropertyDescriptor({
      set onmessage(v) {
        handler.set.call(this, v);
        if (v !== null && (typeof v === 'object' || typeof v === 'function')) enableClientMessageQueue(this);
      }
    }, 'onmessage');
    Object.defineProperty(proto, 'onmessage', { ...handler, set });
  }
});
// The container's client message queue enabled (Service Workers §3.4: by `startMessages()`, an `onmessage` set, and HTML
// "the end" once DOMContentLoaded fired — a worker client's from the start): what it held delivered, each a task of its
// own, in order. Once.
export function enableClientMessageQueue(container = serviceWorkerContainer) {
  const c = containerOf(container);
  if (c.queueEnabled) return;
  c.queueEnabled = true;
  for (const m of c.queued.splice(0)) queueTask(() => deliverClientMessage(m));
}

// ServiceWorkerContainer's register(scriptURL, options), its arguments converted (`options` a RegistrationOptions), and a
// registration's update() and unregister(): a Register, Update or Unregister job the host runs at the scope
// (browser.rb sw_schedule_job — Start Register's checks, the scope's job queue, the script's fetch and its worker's
// evaluation), the promise its settlement resolves: with this realm's object of the registration, or — unregister()'s —
// with whether there was one. Asked from any global: a worker's jobs are the same jobs, their settlement told it too.
const register = (scriptURL, options) =>
  scheduleJob('register', scriptURL, options.scope === undefined ? null : options.scope, options.updateViaCache, options.type, 0);
// (…job number → the resolve / reject of each promise waiting on it: an equivalent job joins the one before it)
const pendingJobs = new Map();
function scheduleJob(kind, scriptURL, scope, updateViaCache, type, registrationId) {
  let scheduled;
  try {
    scheduled = globalThis.__csim_swScheduleJob(
      kind,
      scriptURL,
      scope,
      updateViaCache,
      type,
      registrationId,
      apiBaseURL(),
      documentOrigin(),
      clientRealmTag(),
      globalThis.__csimOriginKey(),
      storageSite()
    );
  } catch (e) { return rejectedPromise(e); }
  const [what, value] = scheduled;
  if (what !== 'job') return rejectedPromise(jobError(what, value));
  return new IntrinsicPromise((resolve, reject) => {
    const waiting = pendingJobs.get(value) || [];
    waiting.push({ kind, resolve, reject });
    pendingJobs.set(value, waiting);
  });
}
const jobError = (name, message) => (name === 'TypeError' ? new TypeError(message) : new DOMException(message, name));
// The host queues a job's run as a task of the platform's, and tells every realm how it settled: rejected with an error
// of `errorName`, or resolved with the registration `registrationId` at `scope` — an Unregister job with whether it
// `unregistered` one.
globalThis.__csim_swQueueJob = function (id) {
  queueTask(() => globalThis.__csim_swRunJob(id));
};
globalThis.__csim_swJobSettled = function (id, registrationId, scope, errorName, message, unregistered) {
  const waiting = pendingJobs.get(id | 0);
  if (!waiting) return;
  pendingJobs.delete(id | 0);
  if (errorName) {
    const error = jobError(String(errorName), String(message));
    for (const w of waiting) w.reject(error);
    return;
  }
  for (const w of waiting) {
    if (w.kind === 'unregister') {
      w.resolve(!!unregistered);
      continue;
    }
    const reg = registrationObject(registrationId | 0, String(scope));
    updateViaCacheOf(reg);   // (…its echo refreshed: the mode the job committed)
    w.resolve(reg);
  }
};

// The host's next lifecycle step for the worker `handle`, queued as a task of the platform's — each step one, so an
// observer sees every state between (sw_registry.rs `queue_step`).
globalThis.__csim_swQueueStep = function (handle) {
  queueTask(() => globalThis.__csim_swStep(handle));
};

// Update Worker State reached this realm: its ServiceWorker of the worker, where it has one, takes the state — its
// `statechange` fired — and a worker activated may make this client's `ready`.
// A redundant worker is done with: its object goes — no version or controller can hold it again.
globalThis.__csim_swWorkerStateChanged = function (handle, state) {
  const h = handle | 0;
  const worker = workerByHandle.get(h);
  if (worker) setWorkerState(worker, String(state));
  if (state === 'activated') maybeResolveReady();
  if (state === 'redundant') workerByHandle.delete(h);
};
// …and a worker began installing the registration `id`: this realm's object of it, where it has one, fires
// `updatefound`.
globalThis.__csim_swRegistrationUpdateFound = function (id) {
  const reg = registrationObjects.get(id | 0);
  if (reg) dispatchWithOnHandler(reg, new Event('updatefound'));
};
function documentHref() {
  try { return (globalThis.location && globalThis.location.href) || ''; } catch (_) { return ''; }
}

// The ACTIVE registration controlling the current document (longest matching scope).
function activeRegistrationForClient() {
  const reg = registrationForURL(documentHref());
  return reg && versionsOf(reg).active ? reg : null;
}

// ── Fetch interception (controlled client) ──────────────────────────────────
let fetchSeq = 0;
const pendingFetch = new Map();   // fetchId → callback(rawResponse | null)

// The controlling SW's worker handle, or 0 — what routes a controlled client's request. A controller with no `fetch`
// listener never intercepts (spec Handle Fetch skips it, the registry's `intercepts`), so the whole cross-isolate round-trip
// is bypassed for messaging/push-only service workers.
export const controllerHandle = () => containerOf(serviceWorkerContainer).routingHandle;
globalThis.__csimSWControllerHandle = controllerHandle;
// What answers this client's request of `url` (absolute), `flags` its FETCH_* facts — the engine's choice (fetch_rules.rs
// `fetch_route`), whether it is controlled — by `ctrl`, the controller handle read as the request was made, the one a
// ROUTE_SERVICE_WORKER request then goes to — among them: a ROUTE_* code (constants.js).
export function requestRoute(url, flags, ctrl) {
  const all = flags | (ctrl ? FETCH_CONTROLLED : 0);
  return globalThis.__dom.fetchRoute(url, all, all & FETCH_SAME_ORIGIN ? documentOrigin() : '');
}
// …the controlling service worker's handle where it answers this client's subresource request of `url` — an http(s)
// one's alone — else 0 (for workers.js and font-metrics.js too, which import nothing of this module: an import of it
// would reorder the bundle's initialisers).
export function serviceWorkerFor(url) {
  const ctrl = controllerHandle();
  return ctrl && requestRoute(url, 0, ctrl) === ROUTE_SERVICE_WORKER ? ctrl : 0;
}
globalThis.__csimServiceWorkerFor = serviceWorkerFor;
// The request-attribute object `__csimSWInterceptFetch` hands the worker, so the SW's
// `event.request` reflects the client's request (redirect / mode / credentials / cache / keepalive
// / integrity / destination / referrer). Each field defaults to the Request default the worker
// would apply anyway — the worker skips the empty/falsy ones — so a caller (fetch / XHR /
// EventSource / <img>) sets ONLY what differs. `referrerSource` defaults to the URL this client refers by
// (about:client: `clientReferrerSource`), which the SW resolves under `referrerPolicy`.
export function buildSwRequest(opts) {
  const o = opts || {};
  return {
    redirect:       o.redirect       || 'follow',
    mode:           o.mode           || 'cors',
    credentials:    o.credentials    || 'same-origin',
    cache:          o.cache          || 'default',
    keepalive:      o.keepalive      || false,
    integrity:      o.integrity      || '',
    destination:    o.destination    || '',
    // (…its policy container's where the request names none — Fetch "main fetch" — the platform default where neither
    // does: subresource_plan.rs `requestReferrerPolicy`)
    referrerPolicy: o.referrerPolicy || globalThis.__dom.requestReferrerPolicy(0),
    referrerSource: o.referrerSource !== undefined ? o.referrerSource : (clientReferrerSource() ?? ''),
    // The fetching client's OWN id (an adopted reserved id, or the realm-derived
    // fallback) — the worker uses it for `event.clientId` so a subresource fetch
    // and the client's records/messages agree on one identity.
    clientId:       o.clientId || clientId()
  };
}
// …a subresource's, as the engine planned it (subresource_plan.rs `plan`: its mode and credentials, the referrer policy
// it is made under — its element's `referrerpolicy` among them — and its destination), of `integrity` metadata.
export function swRequestOfPlan(plan, integrity = '') {
  const [mode, credentials, referrerPolicy, destination] = globalThis.__dom.subresourcePlanFields(plan);
  return buildSwRequest({ mode, credentials, destination, referrerPolicy, integrity });
}
// A service worker's answer as a Resource Timing entry reads it (resource_timing.rs `answer`): its status, type and
// headers, and its body's bytes — `bytes`, else those it holds whole (a streamed one's not read for it, which its
// reader reads) — and, a chain of hops the client followed (`swFetchChain`: `hops` past the first), its final URL,
// redirected: what the worker itself followed inside its answer no entry shows.
export const workerAnswerFacts = (resp, bytes = resp.bodyStream ? undefined : resp.body_bytes, hops = 0, url = '') => ({
  bytes, status: resp.status, type: resp.type, headers: resp.headers, ...(hops > 0 ? { redirected: true, url } : {})
});
// A controlled client's request, hop by hop (Fetch "HTTP fetch" over Handle Fetch, then "HTTP-redirect fetch"): each
// hop the worker `ctrl`'s `fetch` event's to answer (`swReq` the request's attributes), its `mode` and `redirect` mode
// deciding what the answer does (fetch_rules.rs `intercepted_hop`) — a redirect it follows the next hop, its method,
// body and headers as "HTTP-redirect fetch" leaves them, `hops` counting the follows, `crossed` whether the chain has been
// at another origin, `tainted` whether a redirect tainted its origin. `then.network(hopUrl, hopMethod, hopHeaders,
// hopBody, hops, crossed, tainted)` for a hop the worker falls through on; `then.done(response)` for the response the
// request takes (a followed chain's redirected, at its last hop's URL; an opaque-redirect one where its redirect mode is
// manual); `then.fail(reason)` for a network error (`reason` the engine's, or null for the worker's own). `then.alive()`
// asked as each answer comes, false to drop it (the request aborted or superseded). A `sync` request's chain runs to
// its end before this returns, each answer awaited in place (`interceptFetchSync`) — `then.timeout()` where the time
// `timeLeft()` gives (ms, Infinity for none: what remains of the request's timeout, the hops before having spent theirs)
// passes first.
export function swFetchChain(ctrl, { swReq, mode, redirect, url, method, headers, body, sync = false, timeLeft = () => Infinity }, then) {
  const intercept = sync ? (h, m, u, hs, b, r, cb) => {
    const left = timeLeft();
    if (left <= 0) cb({ __timeout: true });
    else interceptFetchSync(h, m, u, hs, b, r, Number.isFinite(left) ? Math.ceil(left) : 0, cb);
  } : globalThis.__csimSWInterceptFetch;
  // (…`taint` the request's redirect-taint so far by name and `site` its latched Sec-Fetch-Site, null none: what the
  // worker's redirects made of its URL list, which a network leg after them carries on — fetch_rules.rs `interceptedHop`)
  const hop = (hopUrl, hopMethod, hopHeaders, hopBody, hops, crossed, taint, site) => {
    intercept(ctrl, hopMethod, hopUrl, hopHeaders, hopBody, swReq, (swResp) => {
      if (then.alive && !then.alive()) return;
      if (swResp == null) { then.network(hopUrl, hopMethod, hopHeaders, hopBody, hops, crossed, taint, site); return; }
      if (swResp.__networkError) { then.fail(null); return; }
      if (swResp.__timeout) { then.timeout(); return; }
      const outcome = globalThis.__dom.interceptedHop(mode, redirect, hopUrl, hopMethod, documentOrigin(), crossed, hops, swResp.status | 0,
        swResp.type || 'default', swResp.url || '', !!swResp.redirected, responseHeader(swResp.headers, 'location'), taint, site);
      if (outcome !== 0) cancelBody(swResp);
      if (typeof outcome === 'string') { then.fail(outcome); return; }
      if (outcome === 1) {
        then.done({ status: 0, statusText: '', headers: {}, body: '', body_null: true, url: hopUrl, type: 'opaqueredirect' });
        return;
      }
      if (outcome !== 0) {
        const [next, step, taintNext, siteNext] = outcome;
        let h2 = hopHeaders;
        if ((step & 3) !== 0) {
          h2 = {};
          for (const k in hopHeaders) {
            if ((step & 1 && globalThis.__dom.requestBodyHeader(k)) || (step & 2 && asciiLower(k) === 'authorization')) continue;
            h2[k] = hopHeaders[k];
          }
        }
        const crossedNext = (step & 4) !== 0;
        if (step & 1) hop(next, 'GET', h2, '', hops + 1, crossedNext, taintNext, siteNext);
        else hop(next, hopMethod, h2, hopBody, hops + 1, crossedNext, taintNext, siteNext);
        return;
      }
      // (…an empty response URL list clones the request's: the last hop's)
      if (hops > 0) {
        if (!swResp.redirected) swResp.redirected = true;
        if (!swResp.url) swResp.url = hopUrl;
      }
      then.done(swResp, hops, hopUrl);
    });
  };
  hop(url, method, headers, body, 0, false, 'same-origin', null);
}
// The chain owns a response it does not answer with — a STREAMED one's body is never read, so it is cancelled, or the
// worker pumps into a stream nobody drains.
function cancelBody(swResp) {
  if (swResp.bodyStream) { try { swResp.bodyStream.cancel(); } catch (_) {} }
}
// Route a controlled client's request to the SW's `fetch` event; `cb` is called with the raw
// response shape (for `new Response(shape, url)`), or null to fall through to the network. `req`
// carries the request attributes the SW's `event.request` must reflect (redirect / mode /
// credentials / cache / integrity / referrer) — the host resolves the referrer per policy.
globalThis.__csimSWInterceptFetch = function (handle, method, url, headers, body, req, cb) {
  const id = ++fetchSeq;
  pendingFetch.set(id, cb);
  globalThis.__dom.swAsked(id);
  let ok = false;
  try {
    ok = !!globalThis.__csim_serviceWorkerControllerFetch(handle, interceptPayload(method, url, headers, body, req), id, clientRealmTag());
  } catch (_) {}
  if (!ok) { pendingFetch.delete(id); globalThis.__dom.swAnswered(id); cb(null); }   // SW gone → network fallback
  else askedWorker();
};
// …and a SYNCHRONOUS request's (a sync XHR's): the same `fetch` event, its answer awaited in place — Handle Fetch is the
// request's whatever its caller waits on — `cb` called before this returns, a timeout's marker where `timeout` ms of the
// worker's time passed first. (…the wait the worker's time, which the virtual clock shows, and none of the script's:
// `hostWait`)
// (…the wait none of the script's time, the answer the worker's model time it took from its event's dispatch — its
// virtual time, which the host moved this clock by meanwhile, and its script's. Not the time on its clock it was given
// at, as an async answer's: the worker runs on to its next timer at once for a script waiting in place, past the
// timeout of a request given up on, and a sync XHR after that one read the worker's 200 ms on.)
function interceptFetchSync(handle, method, url, headers, body, req, timeout, cb) {
  let answer = null;
  const payload = interceptPayload(method, url, headers, body, req);
  const asked = clockNow();
  try { answer = hostWait(() => globalThis.__csim_serviceWorkerSyncFetch(handle, payload, clientRealmTag(), timeout), true); } catch (_) {}
  let took = 0;
  try { took = answer == null ? 0 : Number(jsonParse(answer).took) || 0; } catch (_) {}
  // (…the script waiting in place for it, its clock on to the time the answer came: its virtual clock by the worker's
  // virtual time, as the host moved it — Browser#await_worker_reply — and on by the worker's scripts' time beside that,
  // which no event loop of the waiting script's runs through: timers.js `clockAtLeast`)
  if (took > 0) clockAtLeast(asked + took);
  cb(answer == null ? null : workerAnswer(answer));
}
// The request the worker's `fetch` event is made of: `body` a serialized request body (serializeRequestBody), a string
// contributing its UTF-8 bytes, exactly as it would on the network hop; `req` the request attributes (redirect / mode /
// … / referrerSource), which the worker reconstructs `event.request` from, the host resolving the referrer per policy.
function interceptPayload(method, url, headers, body, req) {
  const body_b64 = (method === 'GET' || method === 'HEAD') ? '' : requestBodyBase64(body);
  return jsonStringify({method, url, headers: headers || {}, body_b64, ...(req || {})});
}
// fetchSeq / pendingFetch are per-realm, so ids collide across realms — tag THIS realm so the
// response is delivered back to it (not the main realm). 0 = the main/top realm. A WORKER
// client (a controlled dedicated/shared worker fetching through its SW) is its own isolate,
// not a realm: it tags the NEGATIVE of its worker handle, which the response router
// (deliver_worker_messages) resolves to this worker's inbox.
const clientRealmTag = () => globalThis.__csim_isWorker ? -globalThis.__dom.workerHandle() : globalThis.__csimRealmId();
// A worker's answer as its wire carries it (JSON): null to fall through to the network, a network error's marker, or
// the raw shape the client Response ctor accepts — serializeResponseWire (workers.js) emits it
// (status/statusText/headers/url/type) once its base64 text is bytes again: the wire shape is owned by ONE side.
function workerAnswer(respJson) {
  let r;
  try { r = jsonParse(respJson); } catch (_) { return null; }
  if (r.fallthrough) return null;
  if (r.networkError) return {__networkError: true};
  if (r.timeout) return {__timeout: true};
  return rawFromWire(r);
}
// The SW's respondWith result (host-driven from deliver_worker_messages), run at the time the request was asked at and
// the time the worker spent on it, `spent` and `took` (timers.rs `swAnswered`).
globalThis.__csim_swControllerFetchResponse = hostTask(function (fetchId, respJson, spent = 0, took = 0) {
  atItsTime('f' + (fetchId | 0), globalThis.__dom.swAnswered(fetchId | 0, spent, took), () => {
    const cb = pendingFetch.get(fetchId | 0);
    if (!cb) return;
    pendingFetch.delete(fetchId | 0);
    cb(workerAnswer(respJson));
  });
});

// A STREAMING respondWith (workers.js streamDeliver): the response head arrives first
// (`fetchStreamStart`), then the body arrives as `fetchStreamChunk` frames, then a terminal
// `fetchStreamClose` / `fetchStreamError`. The client resolves the fetch AT THE HEAD with a
// Response whose body is a live ReadableStream, and enqueues each chunk into it as it lands —
// so the page observes bytes before the SW has finished producing them. Controllers are keyed
// by (per-realm) fetch id, matching pendingFetch.
const swStreamControllers = new Map();
// (…its frames, the head and the chunks after it, each in turn at the answer's time: timers.js `atItsTime`)
globalThis.__csim_swFetchStreamStart = function (fetchId, metaJson, spent = 0, took = 0) {
  atItsTime('f' + (fetchId | 0), globalThis.__dom.swAnswered(fetchId | 0, spent, took), () => streamStart(fetchId, metaJson));
};
function streamStart(fetchId, metaJson) {
  const cb = pendingFetch.get(fetchId | 0);
  if (!cb) return;
  pendingFetch.delete(fetchId | 0);
  let meta;
  try { meta = jsonParse(metaJson); } catch (_) { meta = {}; }
  let controller;
  const realmId = globalThis.__csimRealmId();
  // Tell the SW to cancel its source stream (readable-stream cancel/abort observability).
  const notifySwCancel = () => {
    swStreamControllers.delete(fetchId | 0);
    try { globalThis.__csim_swStreamCancel(fetchId | 0, realmId); } catch (_) {}
  };
  const stream = new ReadableStream({
    start(c) { controller = c; },
    // `response.body.cancel()` / `reader.cancel()` fires here — the SW must observe it.
    cancel() { notifySwCancel(); }
  });
  swStreamControllers.set(fetchId | 0, controller);
  // An AbortController abort cancels the fetch body even while the page is READING it (a locked
  // stream, where the public `cancel()` would throw). fetch.js invokes this hook on abort: notify
  // the SW and error the controller with the abort reason, so a pending read rejects as it should.
  stream.__csimAbort = reason => {
    notifySwCancel();
    try { controller.error(reason || new DOMException('The user aborted a request.', 'AbortError')); } catch (_) {}
  };
  // Hand the live stream to the client Response ctor via the internal wire form (bodyStream) so
  // it carries the head's status / headers / url / type while its body streams (fetch.js).
  cb({
    status:     meta.status,
    statusText: meta.statusText,
    headers:    meta.headers || {},
    body:       '',
    bodyStream: stream,
    url:        meta.url || '',
    type:       meta.type || 'default',
    redirected: !!meta.redirected
  });
};
globalThis.__csim_swFetchStreamChunk = function (fetchId, bytes) {
  atItsTime('f' + (fetchId | 0), 0, () => streamChunk(fetchId, bytes));
};
function streamChunk(fetchId, bytes) {
  const c = swStreamControllers.get(fetchId | 0);
  if (!c) return;
  try { c.enqueue(bytes); } catch (_) {}
};
globalThis.__csim_swFetchStreamClose = function (fetchId) {
  atItsTime('f' + (fetchId | 0), 0, () => streamClose(fetchId));
};
function streamClose(fetchId) {
  const c = swStreamControllers.get(fetchId | 0);
  if (!c) return;
  swStreamControllers.delete(fetchId | 0);
  try { c.close(); } catch (_) {}
};
globalThis.__csim_swFetchStreamError = function (fetchId) {
  atItsTime('f' + (fetchId | 0), 0, () => streamError(fetchId));
};
function streamError(fetchId) {
  const c = swStreamControllers.get(fetchId | 0);
  if (!c) return;
  swStreamControllers.delete(fetchId | 0);
  try { c.error(new TypeError('ServiceWorker response body stream errored')); } catch (_) {}
};
// This browsing context's `Client.frameType`: 'nested' inside a frame, 'auxiliary' for a window
// another context opened, else 'top-level'.
function clientFrameType() {
  if (globalThis.__csimParent && globalThis.__csimParent !== globalThis) return 'nested';
  if (globalThis.__csimWindowSteps.get_opener(globalThis)) return 'auxiliary';   // (…its opener, not a page's `opener`)
  return 'top-level';
}
// Report this browsing context as a service-worker client (the host's registry). Called when the document
// loads and again whenever control is installed — a context is a client of its ORIGIN whether or
// not a worker controls it (`matchAll({includeUncontrolled: true})` must see it), so the host
// needs to know about it either way, and the container's controller says which worker, if any, owns it.
// An opaque-origin document is no client at all.
function reportAsClient() {
  // A WORKER isolate must never take the realm-style path: __csimRealmId() reads 0
  // there, so the report would OVERWRITE the top window's client record with the
  // worker's URL. The HOST owns a worker client's record (sw_note_worker_client);
  // the only self-reportable change is the CONTROLLER (claim adoption) — send just
  // that, through the worker-specific note.
  if (globalThis.__csim_isWorker) {
    const ctrl = containerOf(serviceWorkerContainer).controller;
    try { globalThis.__csim_workerNoteController(globalThis.__dom.workerHandle(), (ctrl && workerOf(ctrl).handle) | 0); } catch (_) {}
    return;
  }
  if (documentOriginIsOpaque()) return;
  const note = globalThis.__csimNoteClient;
  if (typeof note !== 'function') return;
  const ctrl = containerOf(serviceWorkerContainer).controller;
  try { note(globalThis.__csimRealmId(), documentHref(), clientFrameType(), (ctrl && workerOf(ctrl).handle) | 0, documentOrigin(), storageSite()); } catch (_) {}
}
// Host-called once this realm's document has loaded (its URL is set by then, and any host-wired
// controller is already installed), so an uncontrolled context still becomes a known client.
// Called from three places: that host broadcast, `installController` (becoming controlled joins the
// worker's client set), and a Register or Update job (browser.rb sw_run_job) — which announces the
// client that asked before spawning a worker, so a worker that enumerates clients while its script
// evaluates can find the one that registered it.
globalThis.__csim_swReportClient = reportAsClient;

// This context's CURRENT controller handle (0 when uncontrolled). Read live, because control moves
// after load — `clients.claim()` is the common case — so any host-side snapshot taken at realm build
// is stale by the time a script gets around to `new Worker(...)`. A dedicated worker inherits the
// creating context's service worker, so this is what it must be given — whether or not it listens for `fetch`.
globalThis.__csimControllerHandle = function () {
  const w = containerOf(serviceWorkerContainer).controller;
  return (w && workerOf(w).handle) | 0;
};

// Install `w` as this client's controller (idempotent) and fire controllerchange on a change.
function installController(w, intercepts) {
  containerOf(serviceWorkerContainer).routingHandle = intercepts ? workerOf(w).handle : 0;
  if (containerOf(serviceWorkerContainer).controller === w) return;
  containerOf(serviceWorkerContainer).controller = w;
  // Becoming controlled is exactly when this browsing context joins the worker's client set, so
  // this is the ONE place a client is registered — whether control arrived by register() (the
  // top-level page's own), by claim(), or host-wired for a SW-navigated frame. Reported rather
  // than inferred Ruby-side because only the realm knows its own URL and frame type. Runs before
  // the document loads on the host-wired path, so a load-time script that messages the worker
  // already has a client there to answer as.
  reportAsClient();
  dispatchWithOnHandler(serviceWorkerContainer, new Event('controllerchange'));
}
// clients.claim() reaches THIS client realm (host broadcasts to every realm). If this document is
// in the claiming registration's scope, adopt the worker as controller — via the Direct path, which
// mints the worker + synthesizes the registration for a client that never register()'d (an iframe
// created BEFORE the service worker existed, the whole point of claim()). Self-checks scope so the
// host doesn't need a realm→URL map; installController only fires controllerchange on a real change,
// so an already-controlled client is a no-op.
// (…`site` the top-level site of the claiming registration's storage key, and each scope its registration's rivals: the
// engine's, service_worker.rs `swClaims`, against the host's AUTHORITATIVE registration set — under load a sibling's
// registration may have reached no realm yet)
globalThis.__csim_swClaimClient = function (handle, hasFetch, scriptURL, scope, allScopes, site) {
  if (!(handle > 0) || !globalThis.__dom.swClaims(documentHref(), String(scope), allScopes, String(site))) return;
  globalThis.__csim_swSetControllerDirect(handle | 0, hasFetch, scriptURL, String(scope));
};
// Set THIS realm's controller directly from a handle — for a SW-navigated iframe, which never called register().
// Host-driven at frame-realm build, via __csim_swClaimClient on claim(), and as Activate replaces its controller, from the
// host's routing. Makes this realm's
// ServiceWorker of the handle where it has none — host-wired, the host owning its isolate's lifecycle — whose handle
// and fetch handler route the frame's subresource fetches (__csimSWControllerHandle).
globalThis.__csim_swSetControllerDirect = function (handle, hasFetchHandler, scriptURL, scope) {
  if (!(handle > 0)) return;
  // A document with an OPAQUE origin (sandboxed without allow-same-origin) is cross-origin to
  // every registration: it gets no controller — a real browser gives such a document no
  // service-worker container at all, so `ready` must never resolve for it. Guarded at this entry
  // because `clients.claim()` broadcasts to every realm and routes here — which is how a
  // sandboxed in-scope frame would otherwise claim itself.
  if (documentOriginIsOpaque()) return;
  installController(workerObject(handle, scriptURL || ''), hasFetchHandler);
  // (…and its registration — the registry's, which `getRegistration()` / `.ready` / `registration.active` read alike
  // here: controller-on-load / -on-reload)
  if (scope) maybeResolveReady();
};

// This browsing context was disconnected or discarded: it is no longer a service-worker client, so a reference
// retained to its `navigator.serviceWorker` reports no controller (controller-on-disconnect). Called in its realm, while
// that is still alive, just before disposal.
globalThis.__csim_swClientDiscarded = function () {
  containerOf(serviceWorkerContainer).controller = null;
  containerOf(serviceWorkerContainer).routingHandle = 0;
};

// A service worker → client message (host-driven from deliver_worker_messages): fire a
// `message` event on this window's navigator.serviceWorker, source = this realm's object of
// the SENDING worker (the host passes the posting worker's handle — postmessage-to-client
// asserts `e.source === controller`), origin its origin (Client.postMessage: the incumbent's,
// not this document's: a srcdoc frame's location has none).
// (…held on its client message queue while that is disabled: `enableClientMessageQueue`)
globalThis.__csim_swDeliverClientMessage = hostTask(function (dataStr, handle) {
  const c = containerOf(serviceWorkerContainer);
  // (…a worker client's enabled from the start, as it has no "the end" to enable it)
  if (c.queueEnabled || globalThis.__csim_isWorker) deliverClientMessage([dataStr, handle]);
  else c.queued.push([dataStr, handle]);
});
function deliverClientMessage([dataStr, handle]) {
  atItsTime('s' + handle, sentAt(dataStr), () => clientMessage(dataStr, handle));
}
function clientMessage(dataStr, handle) {
  const m = decodeMessage(dataStr);
  const source = workerObject(handle);
  const origin = parseURL(workerOf(source).scriptURL)?.origin ?? '';
  dispatchWithOnHandler(serviceWorkerContainer, createMessageEvent(messageEventType(m), { data: m.data, origin, source, ports: m.ports }));
}

globalThis.ServiceWorker             = ServiceWorker;
globalThis.ServiceWorkerRegistration = ServiceWorkerRegistration;
globalThis.ServiceWorkerContainer    = ServiceWorkerContainer;

export const serviceWorkerContainer = new ServiceWorkerContainer(PLATFORM);

// ── The service worker's own view (ServiceWorkerGlobalScope's `serviceWorker` and `registration`) ──
// The worker a service worker's global is, its object of it, and that global's registration: this realm's objects of them
// as any global's are (Service Workers "get the service worker object", "get the service worker registration object"), so
// they follow the registry as every realm's do, told each step in the order the host takes it (browser.rb
// `sw_tell_workers`). Made only in a service worker's isolate (workers.js `__csim_installServiceWorkerScope`, through the
// hook `__csimServiceWorkerObjects`).
let ownWorker = null;
globalThis.__csimServiceWorkerObjects = {
  // …of the worker `handle`, and of the registration `id` at `scope`, in the updateViaCache mode `uvc` its job gives it.
  own(handle, id, scope, uvc) {
    ownWorker = workerObject(handle);
    const registration = registrationObject(id, scope);
    if (uvc) registrationOf(registration).updateViaCache = uvc;
    return { serviceWorker: ownWorker, registration };
  },
  // …this realm's object of the worker `handle`.
  worker: workerObject
};
