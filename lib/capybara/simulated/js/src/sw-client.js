// The Service Worker objects, generated from their IDL: what a page script observes for a registered service worker —
// `navigator.serviceWorker` (ServiceWorkerContainer), the ServiceWorkerRegistration, and its ServiceWorker objects
// (installing / waiting / active) with their lifecycle `state` + `statechange` / `updatefound` events — and the service
// worker's own view of itself and its registration (`self.serviceWorker`, `self.registration`), the same interfaces'.
//
// The service worker ITSELF runs as a separate-isolate executor worker
// (`worker_spawn(service: true)` → its own V8 isolate + Ruby thread); the client's objects
// are the main-context surface that drives `wait_for_state` / `wait_for_update` in
// the WPT harness and the `navigator.serviceWorker.register(...).then(...)` app path.
// They are views of the host's registry (sw_registry.rs): the host steps each version's
// lifecycle (installing → installed → activating → activated — browser.rb sw_step), a task
// apart so a listener attached in the register-promise `.then` chain observes each
// transition, and every realm's objects take each step as its events. The SW's own
// `install` / `activate` handlers run in the worker isolate (see
// `__csim_installServiceWorkerScope`), driven by `run_worker` at spawn.

import { EventTarget, Event, createMessageEvent, dispatchWithOnHandler, installEventHandlerAttrs } from './events.js';
import { decodeMessage, deliverSelfMessage, encodeMessage, messageEventType } from './workers.js';
import { followWindowClock, hostTask, queueTask } from './timers.js';
import { requestBodyBase64 } from './request-body.js';
import { rawFromWire } from './response-wire.js';
import { apiBaseURL, documentOrigin, documentOriginIsOpaque } from './platform-globals.js';
import { parseURL } from './url-parse.js';
import {
  installNavigationPreloadManager,
  installServiceWorker,
  installServiceWorkerContainer,
  installServiceWorkerRegistration
} from './generated/bindings.js';
import {
  IntrinsicPromise, PLATFORM, constructedBy, jsonParse, jsonStringify, makeSlots, registerInterface, rejectedPromise,
  resolvedPromise, slotsOf
} from './webidl.js';
import { ReadableStream } from './streams.js';
import { DOMException } from './dom-exception.js';
import { responseHeader } from './header-rules.js';
import { asciiLower } from './ascii.js';

// This browsing context's id as a service-worker client (the source of client→SW
// messages, and the routing key for SW→client replies). A FRAME realm reports
// `client-<realm>` — matching the browser's Client registry — so its reply is
// delivered back to THAT realm's navigator.serviceWorker (Browser#deliver_worker_
// messages routes by this id) and clients.matchAll() tells frames apart. The top
// window keeps 'client-window', delivered to the main realm. Computed lazily, not at
// module load: `top`/`parent` are wired AFTER the bridge snapshot evaluates, so a
// frame realm looks like top-level until create_frame_realm finishes.
// NOT modeled: ServiceWorkerContainer message BUFFERING until the first 'message'
// listener / startMessages() — the harness attaches its listener synchronously
// before settle drives the worker, so a reply is never delivered listener-less.
export function clientId() {
  // A document committed by the navigation chain ADOPTED its reserved client id
  // (`__csimClientId`, injected at realm build — create_frame_realm): that IS this
  // client's identity (`event.resultingClientId` === clients.get(...).id === the id
  // this context messages the SW as). The realm-derived forms below are the
  // fallback for realms built outside the chain.
  if (globalThis.__csimClientId) return String(globalThis.__csimClientId);
  if (globalThis.__csimTop && globalThis.__csimTop !== globalThis) {
    const id = globalThis.RustyRacer.contextOf(globalThis);
    if (id) return 'client-' + globalThis.__csimClientSpace() + id;
  }
  return 'client-' + globalThis.__csimClientSpace() + 'window';
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
    makeSlots(this, 'NavigationPreloadManager', { registration });
  }
}
function setPreload(manager, enabled, header) {
  const reg = preloadOf(manager).registration;
  const r = registrationOf(reg);
  if (!versionsOf(reg).active) return rejectedPromise(new DOMException('There is no active worker for navigation preload.', 'InvalidStateError'));
  try { globalThis.__csim_swNavPreloadSet(r.scope, enabled, header); } catch (_) {}
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
    const st = globalThis.__csim_swNavPreloadState(registrationOf(preloadOf(manager).registration).scope) || {};
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
// worker (a registration's version, a controller) or a service worker's own view of itself and its registration's
// versions. Its slots: its script URL and state, the handle of the worker it reflects (0 for a service worker's own
// view, which reaches no other isolate), and — a client's controller — whether it handles fetches.
const workerOf = (o) => slotsOf(o, 'ServiceWorker');
registerInterface('ServiceWorker', (o) => workerOf(o) !== undefined);
class ServiceWorker extends EventTarget {
  constructor(token, scriptURL, state, handle) {
    constructedBy(PLATFORM, token, 'ServiceWorker');
    super();
    makeSlots(this, 'ServiceWorker', { scriptURL, state, handle, hasFetchHandler: false });
  }
}
// A ServiceWorker of `scriptURL` in `state`, reflecting the worker of `handle` (none: 0).
const newServiceWorker = (scriptURL, state, handle = 0) => new ServiceWorker(PLATFORM, scriptURL, state, handle);
// …a client's, which follows the window's clock (its worker's timers run on it): this realm's of the worker `handle`,
// made where it has none — its script URL and state the registry's (`scriptURL` for a worker the registry has none of).
function workerObject(handle, scriptURL = '') {
  const h = handle | 0;
  let worker = workerByHandle.get(h);
  if (!worker) {
    let rec = null;
    try { rec = globalThis.__csim_swWorker(h); } catch (_) {}
    followWindowClock();
    worker = newServiceWorker(rec ? String(rec[0]) : scriptURL, rec ? String(rec[2]) : 'activated', h);
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
// Client → SW postMessage: serialized and routed to the SW's `message` event (source = this client). The SW replies
// via `event.source.postMessage`, delivered to this container's 'message' event (see __csim_swDeliverClientMessage). An
// uncloneable message, or a bad transfer list, is the caller's DataCloneError. A service worker posting to itself
// (`self.serviceWorker`) gets the message as a task of its own; its view of another version reaches no isolate (no
// handle), and what it posts there is serialized and dropped.
function postToWorker(worker, message, transfer) {
  const payload = encodeMessage(message, transfer);
  const handle = workerOf(worker).handle;
  if (handle) {
    const href = (globalThis.location && globalThis.location.href) || '';
    try { globalThis.__csim_serviceWorkerPostMessage(handle, payload, clientId(), href); } catch (_) {}
  } else if (worker === scopeWorker) {
    globalThis.__csimSetTimeout(() => deliverSelfMessage(payload), 0);
  }
}
installServiceWorker(ServiceWorker, {
  get_scriptURL: (worker) => workerOf(worker).scriptURL,
  get_state: (worker) => workerOf(worker).state,
  postMessage_message_transfer: (worker, message, transfer) => postToWorker(worker, message, transfer),
  postMessage_message_options: (worker, message, options) => postToWorker(worker, message, options.transfer),
  installEventHandlers: (proto, names, isSelf) => installEventHandlerAttrs(proto, names, null, isSelf)
});

// ServiceWorkerRegistration (Service Workers §3.2), generated from its IDL — made by the platform alone: a client's (one
// per registration in a realm, `registrationObjects`) or the service worker's own (`self.registration`). Its slots: its
// scope, its number in the registry (a client's), its versions (the service worker's own, which its isolate keeps — a
// client's the registry's, these slots only what it last read), its updateViaCache mode as this side last knew it, its
// NavigationPreloadManager ([SameObject], made at the first read), and the steps of the side that holds it — its
// `versions`, `update` / `unregister`, and whether it is its scope's live registration (`live`).
const registrationOf = (o) => slotsOf(o, 'ServiceWorkerRegistration');
registerInterface('ServiceWorkerRegistration', (o) => registrationOf(o) !== undefined);
class ServiceWorkerRegistration extends EventTarget {
  constructor(token, scope, id, steps) {
    constructedBy(PLATFORM, token, 'ServiceWorkerRegistration');
    super();
    makeSlots(this, 'ServiceWorkerRegistration', {
      scope,
      id,
      installing: null,
      waiting: null,
      active: null,
      updateViaCache: 'imports',
      navigationPreload: null,
      steps
    });
  }
}
// A registration's versions, `{installing, waiting, active}` (each a ServiceWorker or null).
const versionsOf = (reg) => registrationOf(reg).steps.versions(reg);
// A registration's updateViaCache mode — REGISTRATION-wide state that lives host-side (a frame's registration object
// must see the mode the top window set — registration-updateviacache's cross-frame cases), read while it is its scope's
// live registration. The local echo is what survives unregister: a dead registration keeps its last value, even after a
// NEW registration reclaims the scope with a different mode.
function updateViaCacheOf(reg) {
  const r = registrationOf(reg);
  if (r.steps.live(reg)) {
    try {
      const v = globalThis.__csim_swScopeUpdateViaCache && globalThis.__csim_swScopeUpdateViaCache(r.scope);
      if (v) r.updateViaCache = v;
    } catch (_) {}
  }
  return r.updateViaCache;
}
installServiceWorkerRegistration(ServiceWorkerRegistration, {
  get_installing: (reg) => versionsOf(reg).installing,
  get_waiting: (reg) => versionsOf(reg).waiting,
  get_active: (reg) => versionsOf(reg).active,
  get_scope: (reg) => registrationOf(reg).scope,
  get_updateViaCache: (reg) => updateViaCacheOf(reg),
  get_navigationPreload: (reg) => (registrationOf(reg).navigationPreload ??= new NavigationPreloadManager(PLATFORM, reg)),
  update: (reg) => registrationOf(reg).steps.update(reg),
  unregister: (reg) => registrationOf(reg).steps.unregister(reg),
  installEventHandlers: (proto, names, isSelf) => installEventHandlerAttrs(proto, names, null, isSelf)
});

// A client's registration: its versions the registry's, its update and unregister the client's jobs, live while the
// registration map holds it at its scope.
const CLIENT_REGISTRATION = {
  // (…kept in its slots as last read: a discarded document's object, which reaches the host no more, answers with them)
  versions(reg) {
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
  },
  update: (reg) => scheduleJob('update', '', registrationOf(reg).scope, null, '', registrationOf(reg).id),
  // (…the Unregister job at its scope, resolving with whether the map held a registration there — false once it is
  // already gone: "Unregister twice")
  unregister: (reg) => scheduleJob('unregister', '', registrationOf(reg).scope, null, '', registrationOf(reg).id),
  live(reg) {
    try { return (globalThis.__csim_swRegisteredAt(registrationOf(reg).scope) | 0) === registrationOf(reg).id; } catch (_) { return false; }
  }
};

// The registration map as this document's origin has it — `[id, scope]` of each registration, in the order made — and
// the registration `url` matches (Match Service Worker Registration), `[id, scope]` or null: the host's registry.
function registrationMap() {
  try { return globalThis.__csim_swRegistrations(documentOrigin()) || []; } catch (_) { return []; }
}
function matchRegistration(url) {
  try { return globalThis.__csim_swMatchRegistration(documentOrigin(), url) || null; } catch (_) { return null; }
}
// This realm's object of the registration `id` at `scope`, made where it has none — and of the one matching `url`.
function registrationObject(id, scope) {
  let reg = registrationObjects.get(id);
  if (!reg) {
    reg = new ServiceWorkerRegistration(PLATFORM, scope, id, CLIENT_REGISTRATION);
    registrationObjects.set(id, reg);
  }
  return reg;
}
function registrationForURL(url) {
  const entry = matchRegistration(url);
  return entry ? registrationObject(entry[0], entry[1]) : null;
}

// ServiceWorkerContainer (Service Workers §3.4) — `navigator.serviceWorker` — generated from its IDL, made by the
// platform alone. Its slots: its controller, its `ready` promise — CACHED (`sw.ready === sw.ready`), resolved with the
// active registration whose scope CONTROLS this client (a prefix of the document URL — not merely "some active
// registration"); resolving is idempotent, so a read after activation returns the settled promise — and the steps of
// its realm (`CONTAINER_STEPS`), whose registrations it answers with whichever realm's members a page calls.
const containerOf = (o) => slotsOf(o, 'ServiceWorkerContainer');
registerInterface('ServiceWorkerContainer', (o) => containerOf(o) !== undefined);
class ServiceWorkerContainer extends EventTarget {
  constructor(token) {
    constructedBy(PLATFORM, token, 'ServiceWorkerContainer');
    super();
    makeSlots(this, 'ServiceWorkerContainer', { controller: null, ready: null, resolveReady: null, steps: CONTAINER_STEPS });
  }
}
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
    return resolvedPromise(registrationForURL(u.href) || undefined);
  },
  // (…a FrozenArray)
  getRegistrations() {
    return resolvedPromise(Object.freeze(registrationMap().map(([id, scope]) => registrationObject(id, scope))));
  }
};
installServiceWorkerContainer(ServiceWorkerContainer, {
  get_controller: (container) => containerOf(container).controller,
  get_ready(container) {
    const c = containerOf(container);
    c.ready ??= new IntrinsicPromise(resolve => { c.resolveReady = resolve; });
    c.steps.maybeResolveReady(container);
    return c.ready;
  },
  register: (container, scriptURL, options) => containerOf(container).steps.register(scriptURL, options),
  getRegistration: (container, clientURL) => containerOf(container).steps.getRegistration(clientURL),
  getRegistrations: (container) => containerOf(container).steps.getRegistrations(),
  startMessages() {},
  installEventHandlers: (proto, names, isSelf) => installEventHandlerAttrs(proto, names, null, isSelf)
});

// ServiceWorkerContainer's register(scriptURL, options), its arguments converted (`options` a RegistrationOptions), and a
// registration's update() and unregister(): a Register, Update or Unregister job the host runs at the scope
// (browser.rb sw_schedule_job — Start Register's checks, the scope's job queue, the script's fetch and its worker's
// evaluation), the promise its settlement resolves: with this realm's object of the registration, or — unregister()'s —
// with whether there was one.
const register = (scriptURL, options) =>
  scheduleJob('register', scriptURL, options.scope === undefined ? null : options.scope, options.updateViaCache, options.type, 0);
// (…job number → the resolve / reject of each promise waiting on it: an equivalent register() joins the job before it)
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
      globalThis.__csimRealmId(),
      globalThis.__csimBcOriginKey()
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
// observer sees every state between (browser.rb sw_queue_step).
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
// The host tells every realm as a worker begins activating (browser.rb sw_activating): a client USING its registration —
// controlled by an earlier version of it, not merely in its scope — controlled by the new worker, a `controllerchange`
// fired: Activate sets every such client to it (Service Workers §8 "Activate", Notify Controller Change).
globalThis.__csim_swRegistrationActivated = function (handle, scriptURL, hasFetchHandler) {
  const controller = containerOf(serviceWorkerContainer).controller;
  if (!controller || (workerOf(controller).handle | 0) === (handle | 0)) return;
  const registrationOfWorker = (h) => {
    try { return (globalThis.__csim_swWorker(h | 0) || [])[3] | 0; } catch (_) { return 0; }
  };
  const id = registrationOfWorker(handle);
  if (id && registrationOfWorker(workerOf(controller).handle) === id) installController(workerObject(handle, scriptURL), hasFetchHandler);
};

function documentHref() {
  try { return (globalThis.location && globalThis.location.href) || ''; } catch (_) { return ''; }
}

// The ACTIVE registration controlling the current document (longest matching scope).
function activeRegistrationForClient() {
  const reg = registrationForURL(documentHref());
  return reg && versionsOf(reg).active ? reg : null;
}

// The gate for the navigation-interception host call: whether a registration of this document's origin has a scope
// covering `url` — one host call, which only a fetch in 'navigate' mode makes (a form submitted to a named frame), and
// which real apps, registering no service worker (register() rejects outside a universal-server context), find empty.
globalThis.__csimSWMayInterceptNavigation = function (url) {
  return !!matchRegistration(url);
};

// ── Fetch interception (controlled client) ──────────────────────────────────
let fetchSeq = 0;
const pendingFetch = new Map();   // fetchId → callback(rawResponse | null)

// The controlling SW's worker handle, or 0 — read by fetch.js to route a controlled fetch.
// A controller with no `fetch` listener never intercepts (spec Handle Fetch skips it), so the
// whole cross-isolate round-trip is bypassed for messaging/push-only service workers.
globalThis.__csimSWControllerHandle = function () {
  const c = containerOf(serviceWorkerContainer).controller;
  return c && workerOf(c).hasFetchHandler ? workerOf(c).handle : 0;
};
// The request-attribute object `__csimSWInterceptFetch` hands the worker, so the SW's
// `event.request` reflects the client's request (redirect / mode / credentials / cache / keepalive
// / integrity / destination / referrer). Each field defaults to the Request default the worker
// would apply anyway — the worker skips the empty/falsy ones — so a caller (fetch / XHR /
// EventSource / <img>) sets ONLY what differs. `referrerSource` defaults to this client's document
// URL (about:client), which the SW resolves under `referrerPolicy`.
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
    referrerPolicy: o.referrerPolicy || 'strict-origin-when-cross-origin',
    referrerSource: o.referrerSource !== undefined ? o.referrerSource : ((globalThis.location && globalThis.location.href) || ''),
    // The fetching client's OWN id (an adopted reserved id, or the realm-derived
    // fallback) — the worker uses it for `event.clientId` so a subresource fetch
    // and the client's records/messages agree on one identity.
    clientId:       o.clientId || clientId()
  };
}
// A controlled client's request, hop by hop (Fetch "HTTP fetch" over Handle Fetch, then "HTTP-redirect fetch"): each
// hop the worker `ctrl`'s `fetch` event's to answer (`swReq` the request's attributes), its `mode` and `redirect` mode
// deciding what the answer does (fetch_rules.rs `intercepted_hop`) — a redirect it follows the next hop, its method,
// body and headers as "HTTP-redirect fetch" leaves them, `hops` counting the follows. `then.network(hopUrl, hopMethod,
// hopHeaders, hopBody, hops, crossed)` for a hop the worker falls through on; `then.done(response)` for the response the
// request takes (a followed chain's redirected, at its last hop's URL; an opaque-redirect one where its redirect mode is
// manual); `then.fail(reason)` for a network error (`reason` the engine's, or null for the worker's own). `then.alive()`
// asked as each answer comes, false to drop it (the request aborted or superseded).
export function swFetchChain(ctrl, { swReq, mode, redirect, url, method, headers, body }, then) {
  const hop = (hopUrl, hopMethod, hopHeaders, hopBody, hops, crossed) => {
    globalThis.__csimSWInterceptFetch(ctrl, hopMethod, hopUrl, hopHeaders, hopBody, swReq, (swResp) => {
      if (then.alive && !then.alive()) return;
      if (swResp == null) { then.network(hopUrl, hopMethod, hopHeaders, hopBody, hops, crossed); return; }
      if (swResp.__networkError) { then.fail(null); return; }
      const outcome = globalThis.__dom.interceptedHop(mode, redirect, hopUrl, hopMethod, documentOrigin(), crossed, hops, swResp.status | 0,
        swResp.type || 'default', swResp.url || '', !!swResp.redirected, responseHeader(swResp.headers, 'location'));
      if (outcome !== 0) cancelBody(swResp);
      if (typeof outcome === 'string') { then.fail(outcome); return; }
      if (outcome === 1) {
        then.done({ status: 0, statusText: '', headers: {}, body: '', body_null: true, url: hopUrl, type: 'opaqueredirect' });
        return;
      }
      if (outcome !== 0) {
        const [next, step] = outcome;
        let h2 = hopHeaders;
        if ((step & 3) !== 0) {
          h2 = {};
          for (const k in hopHeaders) {
            if ((step & 1 && globalThis.__dom.requestBodyHeader(k)) || (step & 2 && asciiLower(k) === 'authorization')) continue;
            h2[k] = hopHeaders[k];
          }
        }
        if (step & 1) hop(next, 'GET', h2, '', hops + 1, (step & 4) !== 0);
        else hop(next, hopMethod, h2, hopBody, hops + 1, (step & 4) !== 0);
        return;
      }
      // (…an empty response URL list clones the request's: the last hop's)
      if (hops > 0) {
        if (!swResp.redirected) swResp.redirected = true;
        if (!swResp.url) swResp.url = hopUrl;
      }
      then.done(swResp);
    });
  };
  hop(url, method, headers, body, 0, false);
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
  let ok = false;
  try {
    // `body` is a serialized request body (serializeRequestBody): a string contributes its
    // UTF-8 bytes, exactly as it would on the network hop.
    const body_b64 = (method === 'GET' || method === 'HEAD') ? '' : requestBodyBase64(body);
    // `req` carries the request attributes (redirect / mode / … / referrerSource); the worker
    // reconstructs `event.request` from them and the host resolves the referrer per policy.
    const payload = {method, url, headers: headers || {}, body_b64, ...(req || {})};
    // fetchSeq / pendingFetch are per-realm, so ids collide across realms — tag THIS realm so the
    // response is delivered back to it (not the main realm). 0 = the main/top realm. A WORKER
    // client (a controlled dedicated/shared worker fetching through its SW) is its own isolate,
    // not a realm: it tags the NEGATIVE of its worker handle, which the response router
    // (deliver_worker_messages) resolves to this worker's inbox.
    const realmId = globalThis.__csim_isWorker
      ? -(globalThis.__csimWorkerHandle | 0)
      : (globalThis.RustyRacer.contextOf(globalThis) || 0);
    ok = !!globalThis.__csim_serviceWorkerControllerFetch(handle, jsonStringify(payload), id, realmId);
  } catch (_) {}
  if (!ok) { pendingFetch.delete(id); cb(null); }   // SW gone → network fallback
};
// The SW's respondWith result (host-driven from deliver_worker_messages).
globalThis.__csim_swControllerFetchResponse = hostTask(function (fetchId, respJson) {
  const cb = pendingFetch.get(fetchId | 0);
  if (!cb) return;
  pendingFetch.delete(fetchId | 0);
  let r;
  try { r = jsonParse(respJson); } catch (_) { r = {fallthrough: true}; }
  if (r.fallthrough) { cb(null); return; }
  if (r.networkError) { cb({__networkError: true}); return; }
  // serializeResponseWire (workers.js) emits the exact raw shape the client Response ctor
  // accepts (status/statusText/headers/url/type) once its base64 text is bytes again — the
  // wire shape is owned by ONE side.
  cb(rawFromWire(r));
});

// A STREAMING respondWith (workers.js streamDeliver): the response head arrives first
// (`fetchStreamStart`), then the body arrives as `fetchStreamChunk` frames, then a terminal
// `fetchStreamClose` / `fetchStreamError`. The client resolves the fetch AT THE HEAD with a
// Response whose body is a live ReadableStream, and enqueues each chunk into it as it lands —
// so the page observes bytes before the SW has finished producing them. Controllers are keyed
// by (per-realm) fetch id, matching pendingFetch.
const swStreamControllers = new Map();
globalThis.__csim_swFetchStreamStart = function (fetchId, metaJson) {
  const cb = pendingFetch.get(fetchId | 0);
  if (!cb) return;
  pendingFetch.delete(fetchId | 0);
  let meta;
  try { meta = jsonParse(metaJson); } catch (_) { meta = {}; }
  let controller;
  const realmId = globalThis.RustyRacer.contextOf(globalThis) || 0;
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
  const c = swStreamControllers.get(fetchId | 0);
  if (!c) return;
  try { c.enqueue(bytes); } catch (_) {}
};
globalThis.__csim_swFetchStreamClose = function (fetchId) {
  const c = swStreamControllers.get(fetchId | 0);
  if (!c) return;
  swStreamControllers.delete(fetchId | 0);
  try { c.close(); } catch (_) {}
};
globalThis.__csim_swFetchStreamError = function (fetchId) {
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
    try { globalThis.__csim_workerNoteController(globalThis.__csimWorkerHandle | 0, (ctrl && workerOf(ctrl).handle) | 0); } catch (_) {}
    return;
  }
  if (documentOriginIsOpaque()) return;
  const note = globalThis.__csimNoteClient;
  if (typeof note !== 'function') return;
  const ctrl = containerOf(serviceWorkerContainer).controller;
  try { note(globalThis.__csimRealmId(), documentHref(), clientFrameType(), (ctrl && workerOf(ctrl).handle) | 0, documentOrigin()); } catch (_) {}
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
// creating context's service worker, so this is what it must be given.
globalThis.__csimControllerHandle = function () {
  const w = containerOf(serviceWorkerContainer).controller;
  return (w && workerOf(w).handle) | 0;
};

// Install `w` as this client's controller (idempotent) and fire controllerchange on a change.
function installController(w, hasFetchHandler) {
  workerOf(w).hasFetchHandler = !!hasFetchHandler;
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
globalThis.__csim_swClaimClient = function (handle, hasFetch, scriptURL, scope, allScopes) {
  if (!(handle > 0) || !scope) return;
  // (…this document in the claiming scope, and that its LONGEST matching registration — the engine's, service_worker.rs
  // `claims`: claim-not-using-registration — against the host's AUTHORITATIVE registration set (its registry), not this
  // realm's local map: under load a sibling registration's realm-local synthesis can lag the claim, so the local map would
  // miss the longer scope and wrongly steal the client)
  if (!globalThis.__dom.swClaims(documentHref(), String(scope), Array.isArray(allScopes) ? allScopes.map(String) : [])) return;
  globalThis.__csim_swSetControllerDirect(handle | 0, hasFetch, scriptURL, String(scope));
};
// Set THIS realm's controller directly from a handle — for a SW-navigated iframe, which never called register().
// Host-driven at frame-realm build (and via __csim_swClaimClient on claim()) from the host's routing. Makes this realm's
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
};

// A service worker → client message (host-driven from deliver_worker_messages): fire a
// `message` event on this window's navigator.serviceWorker, source = this realm's object of
// the SENDING worker (the host passes the posting worker's handle — postmessage-to-client
// asserts `e.source === controller`); without one, this client's `controller`, then the
// first active registration's worker.
globalThis.__csim_swDeliverClientMessage = hostTask(function (dataStr, handle) {
  const m = decodeMessage(dataStr);
  const active = (handle && workerObject(handle)) || containerOf(serviceWorkerContainer).controller || firstActiveWorker();
  const ev = createMessageEvent(messageEventType(m), { data: m.data, origin: originOfDocument(), source: active, ports: m.ports });
  dispatchWithOnHandler(serviceWorkerContainer, ev);
});

function firstActiveWorker() {
  for (const [id, scope] of registrationMap()) {
    const active = versionsOf(registrationObject(id, scope)).active;
    if (active) return active;
  }
  return null;
}
function originOfDocument() {
  try { return (globalThis.location && globalThis.location.origin) || ''; } catch (_) { return ''; }
}

globalThis.ServiceWorker             = ServiceWorker;
globalThis.ServiceWorkerRegistration = ServiceWorkerRegistration;
globalThis.ServiceWorkerContainer    = ServiceWorkerContainer;

export const serviceWorkerContainer = new ServiceWorkerContainer(PLATFORM);

// ── The service worker's own view (ServiceWorkerGlobalScope's `serviceWorker` and `registration`) ──
// One ServiceWorker the worker itself is, from its script's evaluation on ('parsed'), and its registration, whose slots
// hold it as its lifecycle advances (`advance`, which workers.js calls as each phase lands, so each transition is where
// an observer sees it: `updatefound` before the install event, `statechange(installed)` once the install waitUntil
// settled, `statechange(activating)` before the activate event, `statechange(activated)` once activation completed).
// Distinct objects from the client realms' ServiceWorker instances, as the spec has them (one per global). Its
// `active` is the spawn-time snapshot of the registration's ACTIVE version (an update spawns this worker while the
// previous one runs — registration-attribute's newer worker asserts `active` names the old script during its own
// install); another version installing later, in its own isolate, is a cross-isolate signal not relayed (no vendored
// subtest reads it from the outgoing worker's side). Made only in a service worker's isolate (workers.js
// `__csim_installServiceWorkerScope`, through the hook `__csimServiceWorkerObjects`).
let scopeWorker = null;      // the ServiceWorker this isolate's worker is
let scopePrevActive = 0;     // …and the handle of the active version it was spawned beside, 0 for none
const SCOPE_REGISTRATION = {
  versions(reg) {
    const r = registrationOf(reg);
    return { installing: r.installing, waiting: r.waiting, active: r.active };
  },
  // Update from a service worker whose OWN install is still running rejects (spec Update job: promote-then-reject when
  // the job's worker is the registration's installing worker — update-not-allowed "from installing service worker
  // throws"). From an installed or active worker it resolves without re-running Update — the real worker-side Soft
  // Update job (outbox route) is the SWGlobalScope/update backlog item.
  update(reg) {
    const installing = versionsOf(reg).installing;
    if (installing && workerOf(installing).state === 'installing') {
      return rejectedPromise(new DOMException('update() is not allowed from an installing service worker', 'InvalidStateError'));
    }
    return resolvedPromise(reg);
  },
  // The registration lives host-side (and as per-realm client objects), so the request rides the outbox and the
  // promise parks until the host's `unregister_result` answers with the had-status. The host runs the SAME unregister
  // job as the client-side call: scope unmapped everywhere, Clear Registration deferred while clients use the
  // registration — which is why this worker may be terminated before the reply ever arrives (an uncontrolled
  // registration clears immediately); the unresolved promise dies with the isolate, exactly like a real terminated
  // worker's. A worker the host gave no unregister route (one spawned outside register()) just closes.
  unregister() {
    if (typeof globalThis.__csim_swUnregisterRequest !== 'function') {
      try { globalThis.close(); } catch (_) {}
      return resolvedPromise(true);
    }
    return new IntrinsicPromise(resolve => {
      (globalThis.__csimSwUnregisterWaiters || (globalThis.__csimSwUnregisterWaiters = [])).push(resolve);
      globalThis.__csim_swUnregisterRequest();
    });
  },
  // (…live while its scope's active worker is still one of its own versions — none yet, this worker, or the version it
  // was spawned beside — not once an unregister and a register gave the scope another registration)
  live(reg) {
    let h = 0;
    try { h = globalThis.__csim_swActiveHandleForScope(registrationOf(reg).scope) | 0; } catch (_) {}
    return h === 0 || h === (globalThis.__csimWorkerHandle | 0) || h === scopePrevActive;
  },
};
globalThis.__csimServiceWorkerObjects = {
  // The worker of `scriptURL` and its registration of `scope`, in the updateViaCache mode `uvc`, the version it was
  // spawned beside (`previousActive`: its script URL and handle) its active worker.
  make(scope, scriptURL, uvc, previousActive) {
    scopeWorker = newServiceWorker(scriptURL, 'parsed');
    const registration = new ServiceWorkerRegistration(PLATFORM, scope, 0, SCOPE_REGISTRATION);
    const r = registrationOf(registration);
    if (uvc) r.updateViaCache = uvc;
    if (previousActive) {
      r.active = newServiceWorker(previousActive.url, 'activated');
      scopePrevActive = previousActive.handle | 0;
    }
    return { serviceWorker: scopeWorker, registration };
  },
  // The worker's lifecycle reached `step`: its registration's slots and its state moved to match.
  advance(registration, serviceWorker, step) {
    const r = registrationOf(registration);
    switch (step) {
      case 'updatefound':
        r.installing = serviceWorker;
        setWorkerState(serviceWorker, 'installing');
        dispatchWithOnHandler(registration, new Event('updatefound'));
        break;
      case 'installed': {
        const w = r.installing;
        if (!w) return;
        r.installing = null;
        r.waiting = w;
        setWorkerState(w, 'installed');
        break;
      }
      case 'installFailed': {
        const w = r.installing;
        if (!w) return;
        r.installing = null;
        setWorkerState(w, 'redundant');
        break;
      }
      case 'activating': {
        const w = r.waiting || r.installing;
        if (!w) return;
        r.waiting = r.installing = null;
        r.active = w;   // the outgoing snapshot version is replaced at handover
        setWorkerState(w, 'activating');
        break;
      }
      case 'activated':
        if (r.active) setWorkerState(r.active, 'activated');
        break;
    }
  }
};
