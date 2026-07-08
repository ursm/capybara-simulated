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
import { encode, decode } from './workers.js';

// A stable id for this window as a service-worker client (source of client→SW messages).
// KNOWN LIMITATION (inc 2): a single top-window client is modeled — every window/iframe posts as
// this same id, and a SW→client reply is delivered to the top realm's navigator.serviceWorker (see
// Browser#deliver_worker_messages). Distinct clients per iframe/aux-window (clients.matchAll with
// several entries, replies routed to the posting realm) is a later increment. Also NOT modeled:
// ServiceWorkerContainer message BUFFERING until the first 'message' listener / startMessages() —
// the harness flow attaches its listener synchronously before settle drives the worker, so a reply
// is never delivered before a listener exists in practice.
const CLIENT_ID = 'client-window';

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
  postMessage(data) {
    let payload;
    try { payload = encode(data); } catch (_) { return; }
    const href = (globalThis.location && globalThis.location.href) || '';
    try { globalThis.__csim_serviceWorkerPostMessage(this._handle, payload, CLIENT_ID, href); } catch (_) {}
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
      workerByHandle.delete(w._handle);
      try { globalThis.__csim_workerTerminate(w._handle); } catch (_) {}
    }
    this._installing = this._waiting = this._active = null;
  }
  unregister() {
    registrations.delete(this._scope);
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
      abs   = new globalThis.URL(String(scriptURL), base).href;
      scope = (options && options.scope != null)
        ? new globalThis.URL(String(options.scope), base).href
        : new globalThis.URL('./', abs).href;
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
    let url;
    try {
      const base = (globalThis.location && globalThis.location.href) || undefined;
      url = new globalThis.URL(String(clientURL == null ? '' : clientURL), base).href;
    } catch (_) {
      // An unresolvable clientURL matches nothing (must NOT fall through to matching
      // every registration).
      return Promise.resolve(undefined);
    }
    return Promise.resolve(registrationForURL(url) || undefined);
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
      // activating → activated; resolve `ready` if this registration controls the client.
      () => { worker._setState('activated'); this._maybeResolveReady(); }
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

// The ACTIVE registration controlling the current document (longest matching scope).
function activeRegistrationForClient() {
  let href = '';
  try { href = (globalThis.location && globalThis.location.href) || ''; } catch (_) {}
  const reg = registrationForURL(href);
  return reg && reg._active ? reg : null;
}

// A service worker → client message (host-driven from deliver_worker_messages): fire a
// `message` event on this window's navigator.serviceWorker, source = the active worker.
globalThis.__csim_swDeliverClientMessage = function (dataStr) {
  let data;
  try { data = decode(dataStr); } catch (_) { data = null; }
  const active = firstActiveWorker();
  const ev = new MessageEvent('message', {data, origin: originOfDocument(), source: active, ports: []});
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
