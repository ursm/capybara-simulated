// Client-side Service Worker objects — the CLIENT-side reflections a page script
// observes for a registered service worker: `navigator.serviceWorker`
// (ServiceWorkerContainer), the ServiceWorkerRegistration, and its ServiceWorker
// objects (installing / waiting / active) with their lifecycle `state` +
// `statechange` / `updatefound` events.
//
// The service worker ITSELF runs as a separate-isolate executor worker
// (`worker_spawn(service: true)` → its own V8/QuickJS + Ruby thread); these objects
// are the main-context surface that drives `wait_for_state` / `wait_for_update` in
// the WPT harness and the `navigator.serviceWorker.register(...).then(...)` app path.
// The lifecycle state machine is played out here (installing → installed →
// activating → activated), stepped a task apart so a listener attached in the
// register-promise `.then` chain observes each transition. The SW's own
// `install` / `activate` handlers run in the worker isolate (see
// `__csim_installServiceWorkerScope`), driven by `run_worker` at spawn.

import { EventTarget, Event, MessageEvent, dispatchWithOnHandler, defineEventHandler } from './events.js';
import { encode, decode, encodeMessage, decodeMessage } from './workers.js';
import { utf8EncodeBytes, latin1ToBytes } from './bytes.js';

// This browsing context's id as a service-worker client (the source of client→SW
// messages, and the routing key for SW→client replies). A FRAME realm reports
// `client-<realm>` — matching the browser's Client registry — so its reply is
// delivered back to THAT realm's navigator.serviceWorker (Browser#deliver_worker_
// messages routes by this id) and clients.matchAll() tells frames apart. The top
// window (and QuickJS / same-isolate aux windows, which have no per-frame realm)
// keeps 'client-window', delivered to the main realm. Computed lazily, not at
// module load: `top`/`parent` are wired AFTER the bridge snapshot evaluates, so a
// frame realm looks like top-level until create_frame_realm finishes.
// NOT modeled: ServiceWorkerContainer message BUFFERING until the first 'message'
// listener / startMessages() — the harness attaches its listener synchronously
// before settle drives the worker, so a reply is never delivered listener-less.
function clientId() {
  const NS = globalThis.RustyRacer;
  if (globalThis.top && globalThis.top !== globalThis && NS && typeof NS.contextOf === 'function') {
    const id = NS.contextOf(globalThis);
    if (id) return 'client-' + id;
  }
  return 'client-window';
}

// scope href → ServiceWorkerRegistration (a document has at most one registration
// per scope; getRegistration matches the longest scope covering a client URL).
const registrations   = new Map();
// worker handle → ServiceWorker, so host lifecycle callbacks can find the object.
const workerByHandle  = new Map();

class ServiceWorker extends EventTarget {
  constructor(scriptURL, handle) {
    super();
    this._scriptURL = scriptURL;
    this._handle    = handle;
    this._state     = 'installing';
  }
  get scriptURL() { return this._scriptURL; }
  get state()     { return this._state; }
  _setState(s) {
    if (this._state === s) return;
    this._state = s;
    dispatchWithOnHandler(this, new Event('statechange'));
  }
  // Client → SW postMessage: serialize + route to the SW's `message` event (source = this
  // client). The SW replies via `event.source.postMessage`, delivered to this container's
  // 'message' event (see __csim_swDeliverClientMessage).
  postMessage(data, transfer) {
    let payload;
    try { payload = encodeMessage(data, transfer); } catch (_) { return; }
    const href = (globalThis.location && globalThis.location.href) || '';
    try { globalThis.__csim_serviceWorkerPostMessage(this._handle, payload, clientId(), href); } catch (_) {}
  }
}
defineEventHandler(ServiceWorker.prototype, 'statechange');

class ServiceWorkerRegistration extends EventTarget {
  constructor(scope) {
    super();
    this._scope      = scope;
    this._installing = null;
    this._waiting    = null;
    this._active     = null;
  }
  get scope()      { return this._scope; }
  get installing() { return this._installing; }
  get waiting()    { return this._waiting; }
  get active()     { return this._active; }
  update()     { return Promise.resolve(this); }
  // Terminate every worker this registration holds (installing / waiting / active —
  // they may share a handle, so dedupe) and forget them from `workerByHandle`. Used
  // by unregister() and when a re-registration supersedes the previous worker.
  _terminateWorkers() {
    const seen = new Set();
    for (const w of [this._installing, this._waiting, this._active]) {
      if (!w || seen.has(w._handle)) continue;
      seen.add(w._handle);
      // Clearing the registration (unregister / re-register supersede) makes each of its workers
      // 'redundant' — fires statechange, which registration-service-worker-attributes waits on
      // (`wait_for_state(active, 'redundant')`) and Update State's ordering requires.
      try { w._setState('redundant'); } catch (_) {}
      // A host-wired controller (minted by __csim_swSetControllerDirect for a directly-controlled
      // frame) is owned by the host, which terminates the isolate when its scope is unregistered
      // Ruby-side. A client-side unregister/re-register at that scope must NOT kill the shared
      // worker other clients (incl. the parent) still rely on — leave it to the host.
      if (w._hostWired) continue;
      workerByHandle.delete(w._handle);
      try { globalThis.__csim_workerTerminate(w._handle); } catch (_) {}
    }
    this._installing = this._waiting = this._active = null;
  }
  unregister() {
    registrations.delete(this._scope);
    try { globalThis.__csim_swUnregisterScope(this._scope); } catch (_) {}
    this._terminateWorkers();
    return Promise.resolve(true);
  }
}
defineEventHandler(ServiceWorkerRegistration.prototype, 'updatefound');

class ServiceWorkerContainer extends EventTarget {
  constructor() {
    super();
    this._controller   = null;
    this._readyPromise = null;   // cached — `serviceWorker.ready` is one stable Promise
    this._readyResolve = null;
  }
  get controller() { return this._controller; }
  // The `ready` Promise is CACHED (spec identity: `sw.ready === sw.ready`) and resolves
  // with the active registration whose scope CONTROLS this client (a prefix of the
  // document URL — not merely "some active registration"). Resolve is idempotent, so
  // re-accessing after activation just returns the settled promise.
  get ready() {
    if (!this._readyPromise) {
      this._readyPromise = new Promise(resolve => { this._readyResolve = resolve; });
    }
    const reg = activeRegistrationForClient();
    if (reg) this._readyResolve(reg);
    return this._readyPromise;
  }
  _maybeResolveReady() {
    if (!this._readyResolve) return;
    const reg = activeRegistrationForClient();
    if (reg) this._readyResolve(reg);
  }
  register(scriptURL, options) {
    // Service Workers are modeled only in a UNIVERSAL-SERVER context (the WPT runner,
    // where every host is served in-process). A real app keeps the "not supported"
    // rejection so its registration-failed branch runs rather than a half-modeled
    // success path. See navigator.js history.
    if (!(globalThis.__csim_allHostsLocal && globalThis.__csim_allHostsLocal())) {
      return Promise.reject(new globalThis.DOMException('Service Workers not supported', 'SecurityError'));
    }
    let abs, scope;
    try {
      const base = (globalThis.location && globalThis.location.href) || undefined;
      // Per spec ("Register" / "Start Register"), the script URL and scope URL have their
      // fragments stripped (set fragment to null) — `worker.scriptURL` and `registration.scope`
      // never carry a `#ref`.
      const scriptU = new globalThis.URL(String(scriptURL), base);
      scriptU.hash  = '';
      abs           = scriptU.href;
      const scopeU  = (options && options.scope != null)
        ? new globalThis.URL(String(options.scope), base)
        : new globalThis.URL('./', abs);
      scopeU.hash   = '';
      scope         = scopeU.href;
      // Per spec ("Start Register"): the script URL and the scope URL must be same-origin as the
      // registering document; a cross-origin URL rejects with a SecurityError (rejections.https).
      // Skip when this context's origin is opaque ('null') — see getRegistration.
      const docOrigin = globalThis.location && globalThis.location.origin;
      if (docOrigin && docOrigin !== 'null' && scriptU.origin !== docOrigin) {
        return Promise.reject(new globalThis.DOMException('The origin of the provided scriptURL does not match the current origin', 'SecurityError'));
      }
      if (docOrigin && docOrigin !== 'null' && scopeU.origin !== docOrigin) {
        return Promise.reject(new globalThis.DOMException('The origin of the provided scope does not match the current origin', 'SecurityError'));
      }
    } catch (e) { return Promise.reject(e); }

    let reg = registrations.get(scope);
    let handle;
    try {
      handle = globalThis.__csim_serviceWorkerRegister(abs, globalThis.__csimBcOriginKey()) | 0;
    } catch (e) { return Promise.reject(e); }
    if (!(handle > 0)) return Promise.reject(new globalThis.DOMException('Failed to register a ServiceWorker', 'AbortError'));

    if (!reg) { reg = new ServiceWorkerRegistration(scope); registrations.set(scope, reg); }
    else { reg._terminateWorkers(); }   // re-registration supersedes the previous worker (don't leak its isolate)
    const worker = new ServiceWorker(abs, handle);
    workerByHandle.set(handle, worker);
    reg._installing = worker;

    // register() resolves with the registration (installing set). The lifecycle then
    // plays out a task later, so `updatefound` fires AFTER the caller's `.then`
    // attaches its listener (wait_for_update), and the statechanges follow.
    this._scheduleLifecycle(reg, worker);
    return Promise.resolve(reg);
  }
  getRegistration(clientURL) {
    let u;
    try {
      const base = (globalThis.location && globalThis.location.href) || undefined;
      u = new globalThis.URL(String(clientURL == null ? '' : clientURL), base);
    } catch (_) {
      // An unresolvable clientURL matches nothing (must NOT fall through to matching
      // every registration).
      return Promise.resolve(undefined);
    }
    // Per spec, getRegistration rejects with SecurityError for a cross-origin clientURL
    // (getregistration "with a cross origin URL"). Skip when this context's origin is opaque
    // ('null') — a srcdoc frame inherits its parent's real origin in a browser, but our frame
    // model reports opaque, so an origin compare there would false-reject (srcdoc-iframe).
    const docOrigin = globalThis.location && globalThis.location.origin;
    if (docOrigin && docOrigin !== 'null' && u.origin !== docOrigin) {
      return Promise.reject(new globalThis.DOMException('The origin of the provided clientURL does not match the current origin', 'SecurityError'));
    }
    return Promise.resolve(registrationForURL(u.href) || undefined);
  }
  getRegistrations() { return Promise.resolve(Array.from(registrations.values())); }
  startMessages() {}

  _scheduleLifecycle(reg, worker) {
    // Each step runs in its OWN task so an observer sees the intermediate states: a
    // `wait_for_update` handler reads `reg.installing.state === 'installing'` right
    // after `updatefound`, before the worker advances. A fresh registration has no
    // active worker to replace, so it walks straight through to activated.
    // KNOWN LIMITATION (inc 1): this timeline is decoupled from the worker's ACTUAL
    // install outcome — a rejected `install` waitUntil should make the worker
    // 'redundant' and reject register(); gating on the real outcome needs the
    // cross-isolate signal (run_worker → __csim_swStateChange) and is a later increment.
    const steps = [
      // A new installing worker → `updatefound` (worker still 'installing').
      () => dispatchWithOnHandler(reg, new Event('updatefound')),
      // installing → installed (moves to the waiting slot).
      () => { worker._setState('installed'); reg._installing = null; reg._waiting = worker; },
      // installed → activating (moves to the active slot).
      () => { worker._setState('activating'); reg._waiting = null; reg._active = worker; },
      // activating → activated; resolve `ready` if this registration controls the client, and
      // mirror scope→active-handle into Ruby so a NAVIGATION into this scope (fetched Ruby-side,
      // before the destination realm's JS exists) can find its controlling worker.
      () => {
        worker._setState('activated');
        this._maybeResolveReady();
        // Only mirror if this worker is STILL the registration's active worker — a re-register
        // supersedes it (reg._active becomes the new worker), and this superseded worker's
        // already-queued step must not clobber the scope with its now-dead handle.
        if (reg._active === worker) {
          try { globalThis.__csim_swRegisterScope(reg._scope, worker._handle); } catch (_) {}
        }
      }
    ];
    const run = i => { if (i >= steps.length) return; steps[i](); globalThis.setTimeout(() => run(i + 1), 0); };
    globalThis.setTimeout(() => run(0), 0);
  }
}

// The registration whose scope is the longest prefix of `url` (spec "Match Service
// Worker Registration" uses plain string starts-with on the serialized scope).
function registrationForURL(url) {
  let best = null;
  for (const reg of registrations.values()) {
    if (url.indexOf(reg.scope) !== 0) continue;
    if (!best || reg.scope.length > best.scope.length) best = reg;
  }
  return best;
}

function documentHref() {
  try { return (globalThis.location && globalThis.location.href) || ''; } catch (_) { return ''; }
}

// The ACTIVE registration controlling the current document (longest matching scope).
function activeRegistrationForClient() {
  const reg = registrationForURL(documentHref());
  return reg && reg._active ? reg : null;
}

// Cheap JS-side gate for the navigation-interception host call (rule 3): true only when a
// registration in THIS realm has a scope covering `url`. Real apps never register a service
// worker (register() rejects outside a universal-server context), so this is always false for
// them and the per-iframe-build Ruby crossing is skipped entirely.
// LIMITATION (5a): consults the realm-local registrations Map, which rebuild_ctx wipes on a
// top-level navigation — so a page that navigated into an SW scope and THEN builds an iframe
// (without re-registering) misses interception even though Ruby's @sw_registrations still
// holds the controller. Wiring top-level navigation + a Ruby-authoritative gate is a later inc.
globalThis.__csimSWMayInterceptNavigation = function (url) {
  return !!registrationForURL(url);
};

// ── Fetch interception (controlled client) ──────────────────────────────────
let fetchSeq = 0;
const pendingFetch = new Map();   // fetchId → callback(rawResponse | null)

// The controlling SW's worker handle, or 0 — read by fetch.js to route a controlled fetch.
// A controller with no `fetch` listener never intercepts (spec Handle Fetch skips it), so the
// whole cross-isolate round-trip is bypassed for messaging/push-only service workers.
globalThis.__csimSWControllerHandle = function () {
  const c = serviceWorkerContainer._controller;
  return c && c._hasFetchHandler ? c._handle : 0;
};
// Route a controlled client's request to the SW's `fetch` event; `cb` is called with the raw
// response shape (for `new Response(shape, url)`), or null to fall through to the network. `req`
// carries the request attributes the SW's `event.request` must reflect (redirect / mode /
// credentials / cache / integrity / referrer) — the host resolves the referrer per policy.
globalThis.__csimSWInterceptFetch = function (handle, method, url, headers, bodyStr, b64, req, cb) {
  const id = ++fetchSeq;
  pendingFetch.set(id, cb);
  let ok = false;
  try {
    // A b64:false body is a raw JS string: UTF-8 encode before base64, exactly like the
    // network wire does (`bodyBytes`) — btoa alone throws on non-Latin-1 payloads.
    const body_b64 = (method === 'GET' || method === 'HEAD' || bodyStr == null || bodyStr === '')
      ? '' : (b64 ? String(bodyStr) : globalThis.btoa(utf8EncodeBytes(String(bodyStr))));
    // `req` carries the request attributes (redirect / mode / … / referrerSource); the worker
    // reconstructs `event.request` from them and the host resolves the referrer per policy.
    const payload = {method, url, headers: headers || {}, body_b64, ...(req || {})};
    // fetchSeq / pendingFetch are per-realm, so ids collide across realms — tag THIS realm so the
    // response is delivered back to it (not the main realm). 0 = the main/top realm.
    const NS = globalThis.RustyRacer;
    const realmId = (NS && typeof NS.contextOf === 'function') ? (NS.contextOf(globalThis) || 0) : 0;
    ok = !!globalThis.__csim_serviceWorkerControllerFetch(handle, JSON.stringify(payload), id, realmId);
  } catch (_) {}
  if (!ok) { pendingFetch.delete(id); cb(null); }   // SW gone → network fallback
};
// The SW's respondWith result (host-driven from deliver_worker_messages).
globalThis.__csim_swControllerFetchResponse = function (fetchId, respJson) {
  const cb = pendingFetch.get(fetchId | 0);
  if (!cb) return;
  pendingFetch.delete(fetchId | 0);
  let r;
  try { r = JSON.parse(respJson); } catch (_) { r = {fallthrough: true}; }
  if (r.fallthrough) { cb(null); return; }
  if (r.networkError) { cb({__networkError: true}); return; }
  // serializeSwResponse (workers.js) emits the exact raw shape the client Response ctor
  // accepts (status/statusText/headers/body_b64/url/type) — pass it through; the wire
  // shape is owned by ONE side.
  r.body = '';
  cb(r);
};

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
  try { meta = JSON.parse(metaJson); } catch (_) { meta = {}; }
  let controller;
  const NS = globalThis.RustyRacer;
  const realmId = (NS && typeof NS.contextOf === 'function') ? (NS.contextOf(globalThis) || 0) : 0;
  // Tell the SW to cancel its source stream (readable-stream cancel/abort observability).
  const notifySwCancel = () => {
    swStreamControllers.delete(fetchId | 0);
    try { globalThis.__csim_swStreamCancel(fetchId | 0, realmId); } catch (_) {}
  };
  const stream = new globalThis.ReadableStream({
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
    try { controller.error(reason || new globalThis.DOMException('The user aborted a request.', 'AbortError')); } catch (_) {}
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
globalThis.__csim_swFetchStreamChunk = function (fetchId, b64) {
  const c = swStreamControllers.get(fetchId | 0);
  if (!c) return;
  try { c.enqueue(latin1ToBytes(globalThis.atob(String(b64 || '')))); } catch (_) {}
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
  try { c.error(new globalThis.TypeError('ServiceWorker response body stream errored')); } catch (_) {}
};
// Install `w` as this client's controller (idempotent) and fire controllerchange on a change.
function installController(w, hasFetchHandler) {
  w._hasFetchHandler = !!hasFetchHandler;
  if (serviceWorkerContainer._controller === w) return;
  serviceWorkerContainer._controller = w;
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
  scope = String(scope);
  const href = documentHref();
  if (!href || href.indexOf(scope) !== 0) return;   // claiming scope doesn't cover this document
  // Longest-registration-wins (claim-not-using-registration): claim() only controls clients whose
  // LONGEST-matching registration is the claiming one. If a strictly-longer scope also covers this
  // document, a more-specific SW controls it — don't steal it (the claiming scope is a mere prefix).
  // Matched against the host's AUTHORITATIVE registration set (@sw_registrations), NOT this realm's
  // local map: under load a sibling registration's realm-local synthesis can lag the claim, so the
  // local map would miss the longer scope and wrongly steal the client (a rare full-gate flake).
  if (Array.isArray(allScopes)) {
    for (const s of allScopes) {
      const ss = String(s);
      if (ss.length > scope.length && href.indexOf(ss) === 0) return;
    }
  }
  globalThis.__csim_swSetControllerDirect(handle | 0, hasFetch, scriptURL, scope);
};
// Set THIS realm's controller directly from a handle — for a SW-navigated iframe, whose own
// per-realm `registrations` Map is empty (it never called register()). Host-driven at frame-realm
// build (and via __csim_swClaimClient on claim()) from Ruby's scope→handle mirror. Mints a
// minimal ServiceWorker if this realm hasn't seen the handle; __csimSWControllerHandle only reads
// `_handle` + `_hasFetchHandler`, so a bare object is enough to route the frame's subresource fetch.
globalThis.__csim_swSetControllerDirect = function (handle, hasFetchHandler, scriptURL, scope) {
  if (!(handle > 0)) return;
  let w = workerByHandle.get(handle | 0);
  if (!w) {
    w = new ServiceWorker(scriptURL || '', handle | 0);
    w._state = 'activated';   // a controller is, by definition, the registration's active worker
    w._hostWired = true;      // host owns this isolate's lifecycle (see _terminateWorkers)
    workerByHandle.set(handle | 0, w);
  }
  installController(w, hasFetchHandler);
  // A directly-wired controller (SW-navigated / inherited) never went through register(), so this
  // client has no ServiceWorkerRegistration — synthesize one keyed by the SW's scope, with the
  // controller as its active worker, so `navigator.serviceWorker.getRegistration()` /
  // `.ready` / `registration.active` reflect the controller (controller-on-load / -on-reload).
  if (scope) {
    let reg = registrations.get(scope);
    if (!reg) { reg = new ServiceWorkerRegistration(scope); registrations.set(scope, reg); }
    if (!reg._active) reg._active = w;
    serviceWorkerContainer._maybeResolveReady();
  }
};

// A service worker → client message (host-driven from deliver_worker_messages): fire a
// `message` event on this window's navigator.serviceWorker, source = the SENDING worker.
// `handle` identifies it exactly (the host passes the posting worker's handle); fall
// back to this client's `controller` (a directly-controlled frame never called
// register(), so its per-realm `registrations` map is empty — postmessage-to-client
// asserts `e.source === controller`), then to the first active registration.
globalThis.__csim_swDeliverClientMessage = function (dataStr, handle) {
  let data = null, ports = [];
  try { ({ data, ports } = decodeMessage(dataStr)); } catch (_) {}
  const active = (handle && workerByHandle.get(handle | 0)) || serviceWorkerContainer._controller || firstActiveWorker();
  const ev = new MessageEvent('message', {data, origin: originOfDocument(), source: active, ports});
  dispatchWithOnHandler(serviceWorkerContainer, ev);
};

// Host-reachable lifecycle callback (reserved for Ruby-driven transitions in a later
// increment — e.g. install failure → redundant). Looks a worker up by handle.
globalThis.__csim_swStateChange = function (handle, state) {
  const w = workerByHandle.get(handle | 0);
  if (w) w._setState(String(state));
};

function firstActiveWorker() {
  for (const reg of registrations.values()) if (reg._active) return reg._active;
  return null;
}
function originOfDocument() {
  try { return (globalThis.location && globalThis.location.origin) || ''; } catch (_) { return ''; }
}

// The interface objects are exposed globally + carry Symbol.toStringTag: testharness.js's
// `is_service_worker` gates on `'ServiceWorker' in self` AND
// `Object.prototype.toString.call(worker) === '[object ServiceWorker]'`.
ServiceWorker.prototype[Symbol.toStringTag]             = 'ServiceWorker';
ServiceWorkerRegistration.prototype[Symbol.toStringTag] = 'ServiceWorkerRegistration';
ServiceWorkerContainer.prototype[Symbol.toStringTag]    = 'ServiceWorkerContainer';
globalThis.ServiceWorker             = ServiceWorker;
globalThis.ServiceWorkerRegistration = ServiceWorkerRegistration;
globalThis.ServiceWorkerContainer    = ServiceWorkerContainer;

export const serviceWorkerContainer = new ServiceWorkerContainer();
defineEventHandler(ServiceWorkerContainer.prototype, 'message');
defineEventHandler(ServiceWorkerContainer.prototype, 'messageerror');
defineEventHandler(ServiceWorkerContainer.prototype, 'controllerchange');
export { ServiceWorker, ServiceWorkerRegistration, ServiceWorkerContainer };
