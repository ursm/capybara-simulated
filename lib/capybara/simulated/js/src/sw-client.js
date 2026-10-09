// The Service Worker objects, generated from their IDL: what a page script observes for a registered service worker —
// `navigator.serviceWorker` (ServiceWorkerContainer), the ServiceWorkerRegistration, and its ServiceWorker objects
// (installing / waiting / active) with their lifecycle `state` + `statechange` / `updatefound` events — and the service
// worker's own view of itself and its registration (`self.serviceWorker`, `self.registration`), the same interfaces'.
//
// The service worker ITSELF runs as a separate-isolate executor worker
// (`worker_spawn(service: true)` → its own V8 isolate + Ruby thread); the client's objects
// are the main-context surface that drives `wait_for_state` / `wait_for_update` in
// the WPT harness and the `navigator.serviceWorker.register(...).then(...)` app path.
// The lifecycle state machine is played out here (installing → installed →
// activating → activated), stepped a task apart so a listener attached in the
// register-promise `.then` chain observes each transition. The SW's own
// `install` / `activate` handlers run in the worker isolate (see
// `__csim_installServiceWorkerScope`), driven by `run_worker` at spawn.

import { EventTarget, Event, createMessageEvent, dispatchWithOnHandler, installEventHandlerAttrs } from './events.js';
import { decodeMessage, deliverSelfMessage, encodeMessage } from './workers.js';
import { followWindowClock, hostTask } from './timers.js';
import { requestBodyBase64 } from './request-body.js';
import { rawFromWire } from './response-wire.js';
import {
  installNavigationPreloadManager,
  installServiceWorker,
  installServiceWorkerContainer,
  installServiceWorkerRegistration
} from './generated/bindings.js';
import { PLATFORM, constructedBy, makeSlots, registerInterface, slotsOf } from './webidl.js';

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
function clientId() {
  // A document committed by the navigation chain ADOPTED its reserved client id
  // (`__csimClientId`, injected at realm build — create_frame_realm): that IS this
  // client's identity (`event.resultingClientId` === clients.get(...).id === the id
  // this context messages the SW as). The realm-derived forms below are the
  // fallback for realms built outside the chain.
  if (globalThis.__csimClientId) return String(globalThis.__csimClientId);
  if (globalThis.__csimTop && globalThis.__csimTop !== globalThis) {
    const id = globalThis.RustyRacer.contextOf(globalThis);
    if (id) return 'client-' + id;
  }
  return 'client-window';
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
  const r = registrationOf(preloadOf(manager).registration);
  if (!r.active) return Promise.reject(new DOMException('There is no active worker for navigation preload.', 'InvalidStateError'));
  try { globalThis.__csim_swNavPreloadSet(r.scope, enabled, header); } catch (_) {}
  return Promise.resolve(undefined);
}
installNavigationPreloadManager(NavigationPreloadManager, {
  enable: (manager) => setPreload(manager, true, null),
  disable: (manager) => setPreload(manager, false, null),
  // (…a ByteString, which the bindings converted, that is a header value: no NUL, CR or LF, and no leading or trailing
  // tab or space — Fetch's "header value")
  setHeaderValue(manager, value) {
    if (/[\0\r\n]|^[\t ]|[\t ]$/.test(value)) {
      return Promise.reject(new TypeError("Failed to execute 'setHeaderValue' on 'NavigationPreloadManager': The string contains invalid characters."));
    }
    return setPreload(manager, null, value);
  },
  getState(manager) {
    const st = globalThis.__csim_swNavPreloadState(registrationOf(preloadOf(manager).registration).scope) || {};
    return Promise.resolve({ enabled: !!st.enabled, headerValue: String(st.headerValue) });
  }
});
globalThis.NavigationPreloadManager = NavigationPreloadManager;

// scope href → ServiceWorkerRegistration (a document has at most one registration
// per scope; getRegistration matches the longest scope covering a client URL).
const registrations   = new Map();
// worker handle → ServiceWorker, so host lifecycle callbacks can find the object.
const workerByHandle  = new Map();

// ServiceWorker (Service Workers §3.1), generated from its IDL — made by the platform alone: a client's reflection of a
// worker (a registration's version, a controller) or a service worker's own view of itself and its registration's
// versions. Its slots: its script URL and state, the handle of the worker it reflects (0 for a service worker's own
// view, which reaches no other isolate), and — a client's — whether the host wired it (`hostWired`: the host owns that
// isolate's lifecycle) and whether it handles fetches.
const workerOf = (o) => slotsOf(o, 'ServiceWorker');
registerInterface('ServiceWorker', (o) => workerOf(o) !== undefined);
class ServiceWorker extends EventTarget {
  constructor(token, scriptURL, state, handle) {
    constructedBy(PLATFORM, token, 'ServiceWorker');
    super();
    makeSlots(this, 'ServiceWorker', { scriptURL, state, handle, hostWired: false, hasFetchHandler: false });
  }
}
// A ServiceWorker of `scriptURL` in `state`, reflecting the worker of `handle` (none: 0).
const newServiceWorker = (scriptURL, state, handle = 0) => new ServiceWorker(PLATFORM, scriptURL, state, handle);
// …a client's, which follows the window's clock (its worker's timers run on it).
function clientWorker(scriptURL, handle, state = 'installing') {
  followWindowClock();
  return newServiceWorker(scriptURL, state, handle);
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

// ServiceWorkerRegistration (Service Workers §3.2), generated from its IDL — made by the platform alone: a client's
// (one per scope in a realm, `registrations`) or the service worker's own (`self.registration`). Its slots: its scope,
// its versions, its updateViaCache mode and WorkerType as this side last knew them, its NavigationPreloadManager
// ([SameObject], made at the first read), a client's parked activation (`resumeActivation`), and the steps of the side
// that holds it — `update` / `unregister`, and whether it is the scope's live registration (`live`).
const registrationOf = (o) => slotsOf(o, 'ServiceWorkerRegistration');
registerInterface('ServiceWorkerRegistration', (o) => registrationOf(o) !== undefined);
class ServiceWorkerRegistration extends EventTarget {
  constructor(token, scope, steps) {
    constructedBy(PLATFORM, token, 'ServiceWorkerRegistration');
    super();
    makeSlots(this, 'ServiceWorkerRegistration', {
      scope,
      installing: null,
      waiting: null,
      active: null,
      updateViaCache: 'imports',
      workerType: 'classic',
      navigationPreload: null,
      resumeActivation: null,
      steps
    });
  }
}
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
  get_installing: (reg) => registrationOf(reg).installing,
  get_waiting: (reg) => registrationOf(reg).waiting,
  get_active: (reg) => registrationOf(reg).active,
  get_scope: (reg) => registrationOf(reg).scope,
  get_updateViaCache: (reg) => updateViaCacheOf(reg),
  get_navigationPreload: (reg) => (registrationOf(reg).navigationPreload ??= new NavigationPreloadManager(PLATFORM, reg)),
  update: (reg) => registrationOf(reg).steps.update(reg),
  unregister: (reg) => registrationOf(reg).steps.unregister(reg),
  installEventHandlers: (proto, names, isSelf) => installEventHandlerAttrs(proto, names, null, isSelf)
});

// A client's registration of `scope`: its update and unregister the client's jobs, live while it is the realm's
// registration of its scope, its navigation preload keyed by its active worker — read live, so enable() rejects while
// it is still installing and succeeds once activated.
const CLIENT_REGISTRATION = {
  update: (reg) => updateRegistration(reg),
  // Resolves with whether a registration actually existed for this scope: true the first time, false once it's already
  // gone (unregister "Unregister twice") — `Map#delete`'s had-status.
  unregister(reg) {
    const scope = registrationOf(reg).scope;
    const existed = registrations.delete(scope);
    try { globalThis.__csim_swUnregisterScope(scope); } catch (_) {}
    if (existed) startUninstall(reg);
    return Promise.resolve(existed);
  },
  live: (reg) => registrations.get(registrationOf(reg).scope) === reg
};
const newRegistration = (scope) => new ServiceWorkerRegistration(PLATFORM, scope, CLIENT_REGISTRATION);

// A version retired: redundant, and its isolate terminated — unless the host wired it, and owns its lifecycle.
function retire(worker) {
  try { setWorkerState(worker, 'redundant'); } catch (_) {}
  const w = workerOf(worker);
  if (w.hostWired) return;
  workerByHandle.delete(w.handle);
  try { globalThis.__csim_workerTerminate(w.handle); } catch (_) {}
}

// Clear Registration: every worker this registration holds (installing / waiting /
// active — they may share a handle, so dedupe) goes 'redundant' and the slots empty.
// `terminate: false` leaves the isolates to the host (the deferred-uninstall clear
// terminates them Ruby-side after this broadcast).
function terminateWorkers(reg, terminate = true) {
  const r = registrationOf(reg);
  const seen = new Set();
  for (const worker of [r.installing, r.waiting, r.active]) {
    const w = worker && workerOf(worker);
    if (!w || seen.has(w.handle)) continue;
    seen.add(w.handle);
    // A worker cleared before its install marker arrived leaves a parked waiter
    // (holding this registration) / an unconsumed outcome — drop both.
    swInstallOutcome.delete(w.handle | 0);
    swInstallWaiters.delete(w.handle | 0);
    // Clearing the registration (unregister / re-register supersede) makes each of its workers
    // 'redundant' — fires statechange, which registration-service-worker-attributes waits on
    // (`wait_for_state(active, 'redundant')`) and Update State's ordering requires.
    try { setWorkerState(worker, 'redundant'); } catch (_) {}
    // A host-wired controller (minted by __csim_swSetControllerDirect for a directly-controlled
    // frame) is owned by the host, which terminates the isolate when its scope is unregistered
    // Ruby-side. A client-side unregister/re-register at that scope must NOT kill the shared
    // worker other clients (incl. the parent) still rely on — leave it to the host.
    if (w.hostWired) continue;
    workerByHandle.delete(w.handle);
    if (terminate) { try { globalThis.__csim_workerTerminate(w.handle); } catch (_) {} }
  }
  r.installing = r.waiting = r.active = null;
}
// An UPDATE supersedes only a version still INSTALLING (a half-run install cycle it
// replaces); the ACTIVE worker keeps running and keeps its controllees until the new
// one actually activates, and a WAITING worker keeps waiting — per Update State it is
// retired only when the NEWER version itself reaches 'installed' (the lifecycle's
// installed step), not the moment its replacement starts installing
// (skip-waiting.https: url2 must still be `waiting` while url3 installs).
function supersedePending(reg) {
  const r = registrationOf(reg);
  if (r.installing && r.installing !== r.active) retire(r.installing);
  r.installing = null;
}
// Unregister only UNMAPS the scope; Clear Registration is deferred until no client
// is using this registration and its workers have no pending extended work — an
// existing controllee keeps its controller and its interception, and slots stay
// populated (unregister-controller, unregister-then-register-new-script,
// activation.https 'finishing a request triggers unregister'). The host owns the
// verdict (client registry + extended counters) and broadcasts the clear; parked
// activations can't leak meanwhile because every resume path iterates the
// `registrations` map this scope just left. Shared by the client-side unregister()
// above and the worker-side registration.unregister() (__csim_swScopeUnregistered).
function startUninstall(reg) {
  const r = registrationOf(reg);
  const handles = [...new Set([r.installing, r.waiting, r.active]
    .filter(w => w && !workerOf(w).hostWired).map(w => workerOf(w).handle | 0))];
  if (handles.length && typeof globalThis.__csim_swNoteUninstalling === 'function') {
    // The map key travels to the host and BACK as the clear broadcast's argument —
    // an installing-only registration has no active worker, so the key must be
    // explicit (a 0-for-no-active convention broadcast 0 and the clear never landed).
    const activeHandle = r.active ? workerOf(r.active).handle | 0 : 0;
    const key = activeHandle || handles[0];
    uninstallingRegs.set(key, reg);
    try {
      globalThis.__csim_swNoteUninstalling(key, activeHandle, handles);
      return;
    } catch (_) { uninstallingRegs.delete(key); }
  }
  terminateWorkers(reg);
}

// Registrations whose scope is unregistered but whose Clear Registration is parked on the
// host's "no using clients + no extended work" verdict, keyed by their active worker's
// handle (handles are process-unique; the scope may be re-registered meanwhile).
const uninstallingRegs = new Map();

// The host's deferred Clear Registration fired: workers go redundant, slots empty.
// The host terminates the isolates itself right after this broadcast.
globalThis.__csim_swClearRegistration = function (activeHandle) {
  const reg = uninstallingRegs.get(activeHandle | 0);
  if (!reg) return;
  uninstallingRegs.delete(activeHandle | 0);
  terminateWorkers(reg, false);
};

// The SERVICE WORKER side called `self.registration.unregister()` — the host already
// unmapped the scope (its own map + every realm rides this broadcast); this realm
// drops its registration object and starts the same deferred uninstall the client-side
// unregister() would have (an installing worker with no holds goes straight to
// redundant, which is what `wait_for_state(installing, 'redundant')` observes).
globalThis.__csim_swScopeUnregistered = function (scope) {
  const reg = registrations.get(scope);
  if (!reg) return;
  registrations.delete(scope);
  startUninstall(reg);
};

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
    let u;
    try {
      u = new globalThis.URL(clientURL, (globalThis.location && globalThis.location.href) || undefined);
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
  },
  // (…a FrozenArray)
  getRegistrations: () => Promise.resolve(Object.freeze(Array.from(registrations.values())))
};
installServiceWorkerContainer(ServiceWorkerContainer, {
  get_controller: (container) => containerOf(container).controller,
  get_ready(container) {
    const c = containerOf(container);
    c.ready ??= new Promise(resolve => { c.resolveReady = resolve; });
    c.steps.maybeResolveReady(container);
    return c.ready;
  },
  register: (container, scriptURL, options) => containerOf(container).steps.register(scriptURL, options),
  getRegistration: (container, clientURL) => containerOf(container).steps.getRegistration(clientURL),
  getRegistrations: (container) => containerOf(container).steps.getRegistrations(),
  startMessages() {},
  installEventHandlers: (proto, names, isSelf) => installEventHandlerAttrs(proto, names, null, isSelf)
});

// ServiceWorkerContainer's register(scriptURL, options), its arguments converted (`options` a RegistrationOptions).
function register(scriptURL, options) {
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
    const scriptU = new globalThis.URL(scriptURL, base);
    scriptU.hash  = '';
    abs           = scriptU.href;
    const scopeU  = options.scope !== undefined ? new globalThis.URL(options.scope, base) : new globalThis.URL('./', abs);
    scopeU.hash   = '';
    scope         = scopeU.href;
    // Per spec ("Start Register"), BEFORE the same-origin check: both URLs' scheme must be http(s),
    // and neither path may contain a URL-encoded slash (%2f) or backslash (%5c). Each is a TypeError
    // — a distinct failure from the cross-origin SecurityError below, so a data:/ftp:/filesystem:
    // scope rejects with TypeError, not SecurityError (registration-scope). The URL parser leaves
    // %2f/%5c encoded in `pathname`, so a literal-string test catches them.
    for (const u of [scriptU, scopeU]) {
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        return Promise.reject(new globalThis.TypeError("Failed to register a ServiceWorker: The URL protocol of the current origin is not supported."));
      }
      if (/%2f|%5c/i.test(u.pathname)) {
        return Promise.reject(new globalThis.TypeError("Failed to register a ServiceWorker: The provided URL contains a URL-encoded slash or backslash."));
      }
    }
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

  // (…its updateViaCache mode and its WorkerType — the parse check below is classic-only: `new Function` compiles a
  // FUNCTION BODY, which cannot contain the static import/export declarations a module SW script opens with)
  const uvc = options.updateViaCache;
  const workerType = options.type;

  // An equivalent Register job is already in flight at this scope — join it.
  const inflight = pendingRegisterJobs.get(scope);
  if (inflight && inflight.script === abs && inflight.uvc === uvc && inflight.type === workerType) {
    return inflight.promise;
  }

  let reg = registrations.get(scope);
  // Re-register at a scope whose newest worker already holds THIS script (the Register
  // job's early exit): finish without an install cycle ONLY when the updateViaCache
  // mode is also unchanged — register() then resolves to the SAME registration object
  // with its workers untouched (multiple-register "same registration object"). A
  // CHANGED mode is recorded and runs the full Update algorithm instead: its cache
  // decisions just changed, so the byte-check can now find fresh bytes
  // (registration-updateviacache's X-then-Y cases). A DIFFERENT script URL falls
  // through to the plain re-register install cycle below.
  if (reg) {
    const r = registrationOf(reg);
    const newest = r.installing || r.waiting || r.active;
    // The early exit requires the TYPE unchanged too: a register() with the same
    // script but a different type is NOT an equivalent job — it re-runs the full
    // pipeline, whose spawn evaluates the same bytes under the NEW type (a classic
    // script as a module, or vice versa — update-registration-with-type's
    // "same main script" cases expect exactly that evaluation failure).
    if (newest && workerOf(newest).scriptURL === abs && r.workerType === workerType) {
      if (updateViaCacheOf(reg) === uvc) return Promise.resolve(reg);
      // The changed mode rides as the OVERRIDE and commits only once the update
      // pipeline succeeded — a rejecting register must not switch the stored mode.
      return updateRegistration(reg, uvc);
    }
    // The scope's JOB QUEUE serializes a Register job behind a RUNNING install (the
    // same rule updateRegistration applies): a register() with a DIFFERENT script
    // while a worker is INSTALLING must not fetch/spawn until that install completes
    // — the whole call re-runs once it settles (register-wait-forever-in-install-
    // worker: the queued register starts only when the never-resolving install
    // waitUntil is finally released). Only 'installing' queues: a worker parked in
    // the WAITING slot is a finished job, and a register during it must proceed —
    // it may be the very skipWaiting() version that releases the queue
    // (skip-waiting.https "both active and waiting").
    const pending = r.installing;
    if (pending && workerOf(pending).state === 'installing') {
      return new Promise(resolve => {
        const proceed = () => {
          pending.removeEventListener('statechange', proceed);
          resolve(register(scriptURL, options));
        };
        pending.addEventListener('statechange', proceed);
      });
    }
  }
  // Cross-realm: another browsing context already holds an ACTIVE worker at this EXACT scope. The
  // registration is shared across the origin, but each realm observes its OWN registration +
  // ServiceWorker objects (its `registrations` map is per-realm). With no local registration,
  // synthesize one reflecting the existing active worker — installing/waiting null, no duplicate
  // install (multiple-register "different iframe … same registration and workers"). Uses `abs` as the
  // active scriptURL: register() only reaches here for an already-active scope, and a cross-realm
  // register with a DIFFERENT script (a genuine update) is not exercised by any vendored test.
  if (!reg) {
    let activeHandle = 0;
    try { activeHandle = globalThis.__csim_swActiveHandleForScope(scope) | 0; } catch (_) {}
    if (activeHandle > 0) {
      reg = newRegistration(scope);
      registrations.set(scope, reg);
      const r = registrationOf(reg);
      // Mirror the registration's committed TYPE: an update()/re-register from THIS
      // realm must parse-check and respawn a module registration as a module, not
      // the 'classic' default.
      try { r.workerType = String(globalThis.__csim_swScopeWorkerType(scope) || 'classic'); } catch (_) {}
      r.active = clientWorker(abs, activeHandle, 'activated');
      workerByHandle.set(activeHandle, r.active);
      setUpdateViaCache(reg, uvc);   // the Register job sets the mode on every register
      maybeResolveReady();
      return Promise.resolve(reg);
    }
  }
  // Announce this context BEFORE the worker is spawned. A service worker may enumerate clients
  // at SCRIPT EVALUATION time (`self.clients.matchAll(...)` at top level, before install), and the
  // host seeds the new worker's mirror from its registry at spawn — so a client that has not
  // reported yet is invisible to a worker that looks that early. The registering document is
  // exactly the one such a worker expects to find.
  // The Register job runs the same Update pipeline registration.update() does: fetch +
  // validate the script — a redirect, a non-JS MIME type, or a script that fails to
  // parse rejects register() with no version installed and the stored updateViaCache
  // mode untouched ("updateViaCache is not updated if register() rejects"). The call's
  // own mode rides as the override (it drives the fetch's cache decision), and the
  // fetched bytes park host-side for the spawn below. handle 0 = no newest worker to
  // byte-compare, so a fresh/different-script register always installs.
  let fetched = null;
  try { fetched = globalThis.__csim_swUpdateFetch(scope, abs, 0, uvc); } catch (_) {}
  if (fetched && fetched.error === 'mime') {
    return Promise.reject(new globalThis.DOMException('Failed to register a ServiceWorker: the script has an unsupported MIME type.', 'SecurityError'));
  }
  if (!fetched || fetched.error) {
    return Promise.reject(new globalThis.TypeError('Failed to register a ServiceWorker: the script fetch failed.'));
  }
  if (workerType === 'classic' && !classicScriptParses(fetched.body)) {
    dropPendingScript(scope);
    return Promise.reject(new globalThis.TypeError('Failed to register a ServiceWorker: the script failed to parse.'));
  }
  reportAsClient();
  // The pipeline succeeded — commit the mode before the spawn (the worker's
  // importScripts read it: a 'none' registration's imports bypass the HTTP cache).
  try { globalThis.__csim_swSetUpdateViaCache(scope, uvc); } catch (_) {}
  let handle;
  try {
    handle = globalThis.__csim_serviceWorkerRegister(abs, globalThis.__csimBcOriginKey(), scope, workerType) | 0;
  } catch (e) { return Promise.reject(e); }
  if (!(handle > 0)) return Promise.reject(new globalThis.DOMException('Failed to register a ServiceWorker', 'AbortError'));

  // Everything observable is DEFERRED to the eval outcome: a script whose evaluation
  // fails (import 404, top-level throw) rejects register() with no registration /
  // version ever visible. On success, register() resolves with `installing` set and
  // the lifecycle plays out a task later, so `updatefound` fires AFTER the caller's
  // `.then` attached its listener (wait_for_update).
  const jobPromise = parkEvalOutcome(handle, () => {
    // Re-read the map HERE, not the call-time capture: another register at this
    // scope may have created the registration while this job's eval was in flight,
    // and there is exactly ONE registration object per (realm, scope) — a stale
    // capture would mint a second one and orphan the first's install cycle.
    let liveReg = registrations.get(scope);
    if (!liveReg) { liveReg = newRegistration(scope); registrations.set(scope, liveReg); }
    else { supersedePending(liveReg); }   // an update supersedes a pending worker, NOT the active one
    // Mirror the scope host-side the moment the registration is REAL: a claim's
    // longest-registration-wins check must already see it while this first worker
    // is merely installing (claim-not-using-registration "longer-matched").
    try { globalThis.__csim_swNoteRegistered(scope); } catch (_) {}
    const r = registrationOf(liveReg);
    r.updateViaCache = uvc;
    r.workerType     = workerType;   // update()'s parse check is classic-only too
    const worker = clientWorker(abs, handle);
    workerByHandle.set(handle, worker);
    r.installing = worker;
    scheduleLifecycle(liveReg, worker);
    return liveReg;
  });
  pendingRegisterJobs.set(scope, {script: abs, uvc, type: workerType, promise: jobPromise});
  const clear = () => { if (pendingRegisterJobs.get(scope) && pendingRegisterJobs.get(scope).promise === jobPromise) pendingRegisterJobs.delete(scope); };
  jobPromise.then(clear, clear);
  return jobPromise;
}
// The Update algorithm behind `registration.update()` and a same-script re-register
// whose updateViaCache mode changed. The fetch + byte-check live host-side
// (__csim_swUpdateFetch — main script per the cache mode, then the recorded imports);
// an identical result resolves with no new version, a changed one runs the same
// install cycle a re-register does, on the bytes the host just fetched.
// `uvcOverride` = a same-script re-register's CHANGED updateViaCache mode: it drives
// this update's cache decisions and is committed only once the pipeline succeeded
// (a rejecting register must not switch the stored mode).
function updateRegistration(reg, uvcOverride) {
  const r = registrationOf(reg);
  // unregister() already dropped the scope: the registration is uninstalling and
  // cannot update (update.https "pending uninstall flag").
  if (registrations.get(r.scope) !== reg) {
    return Promise.reject(new globalThis.TypeError('Failed to update a ServiceWorker: the registration has been unregistered.'));
  }
  // The scope's JOB QUEUE serializes an Update behind a RUNNING install: an
  // update() issued while a worker is installing (its install waitUntil
  // unsettled) waits for that install to complete before its fetch runs
  // (update-not-allowed "from client succeeds while installing": the probe
  // against an every-fetch-different script must not spawn a superseding version
  // that kills the very worker the test is about to finish installing). Only
  // 'installing' queues — a WAITING worker is a finished job and never blocks
  // the queue (skip-waiting.https); the new version it spawns simply retires it
  // on reaching installed.
  const pending = r.installing;
  if (pending && workerOf(pending).state === 'installing') {
    return new Promise(resolve => {
      const proceed = () => {
        pending.removeEventListener('statechange', proceed);
        resolve(updateRegistration(reg, uvcOverride));
      };
      pending.addEventListener('statechange', proceed);
    });
  }
  const newest = r.installing || r.waiting || r.active;
  const n = newest && workerOf(newest);
  if (!newest) {
    return Promise.reject(new globalThis.TypeError('Failed to update a ServiceWorker: no service worker.'));
  }
  let fetched = null;
  try { fetched = globalThis.__csim_swUpdateFetch(r.scope, n.scriptURL, n.handle | 0, uvcOverride == null ? null : uvcOverride); } catch (_) {}
  if (fetched && fetched.error === 'mime') {
    return Promise.reject(new globalThis.DOMException('Failed to update a ServiceWorker: the script has an unsupported MIME type.', 'SecurityError'));
  }
  if (!fetched || fetched.error) {
    return Promise.reject(new globalThis.TypeError('Failed to update a ServiceWorker: the script fetch failed.'));
  }
  if (r.workerType === 'classic' && fetched.changed && !classicScriptParses(fetched.body)) {
    dropPendingScript(r.scope);
    return Promise.reject(new globalThis.TypeError('Failed to update a ServiceWorker: the script failed to parse.'));
  }
  if (uvcOverride != null) setUpdateViaCache(reg, uvcOverride);
  if (!fetched.changed) return Promise.resolve(reg);
  reportAsClient();
  let handle = 0;
  try { handle = globalThis.__csim_serviceWorkerRegister(n.scriptURL, globalThis.__csimBcOriginKey(), r.scope, r.workerType) | 0; } catch (_) {}
  if (!(handle > 0)) {
    return Promise.reject(new globalThis.TypeError('Failed to update a ServiceWorker: the worker could not be started.'));
  }
  // Deferred to the eval outcome, like register(): a new version whose script fails
  // to evaluate (an import that 404s — update-import-scripts) rejects update() and
  // leaves the registration exactly as it was (active only, nothing superseded).
  return parkEvalOutcome(handle, () => {
    supersedePending(reg);
    const worker = clientWorker(n.scriptURL, handle);
    workerByHandle.set(handle, worker);
    r.installing = worker;
    scheduleLifecycle(reg, worker);
    return reg;
  });
}
function scheduleLifecycle(reg, worker) {
  const r = registrationOf(reg);
  const w = workerOf(worker);
  const h = w.handle | 0;
  // Each step runs in its OWN task so an observer sees the intermediate states: a
  // `wait_for_update` handler reads `reg.installing.state === 'installing'` right
  // after `updatefound`, before the worker advances. A fresh registration has no
  // active worker to replace, so it walks straight through to activated.
  // The timeline is GATED on the worker's actual phase outcomes (run_worker's
  // 'sw_phase' markers → __csim_swPhaseDone): 'installed' waits for the install
  // waitUntil promises to settle — a rejection fails the version (redundant, never
  // activated; Install "installFailed") — and 'activated' waits for the activate
  // phase to complete (a rejected activate waitUntil still activates).
  const steps = [
    // A new installing worker → `updatefound` (worker still 'installing').
    () => dispatchWithOnHandler(reg, new Event('updatefound')),
    // installing → installed (moves to the waiting slot). A version already SITTING
    // there is retired now — per Update State "installed", the previous waiting
    // worker goes redundant the moment a newer one reaches installed
    // (skip-waiting.https: url2 redundant once url3 installs).
    () => {
      if (r.waiting && r.waiting !== worker) retire(r.waiting);
      setWorkerState(worker, 'installed');
      r.installing = null;
      r.waiting = worker;
    },
    // installed → activating (moves to the active slot) — but only once the OUTGOING worker has
    // no controllees left, or this one called skipWaiting(). HTML's "try activate": an update
    // must not seize control of documents the previous version is already running.
    () => {
      // Retire the worker being replaced: it is redundant the moment the new one takes over, and
      // its isolate would otherwise outlive the registration.
      const outgoing = r.active;
      setWorkerState(worker, 'activating');
      r.waiting = null;
      r.active  = worker;
      if (outgoing && outgoing !== worker) retire(outgoing);
      // Tell the host the registration's active worker EXISTS but is still
      // 'activating' — Handle Fetch parks functional events against the scope until
      // the activated marker moves it into the real mirror (fetch-waits-for-activate).
      // Same currency guards as the step-3 mirror: a superseded cycle must not tag
      // the scope with its dead handle.
      if (r.active === worker && registrations.get(r.scope) === reg) {
        try { globalThis.__csim_swNoteActivating(r.scope, w.handle); } catch (_) {}
      }
    },
    // activating → activated; resolve `ready` if this registration controls the client, and
    // mirror scope→active-handle into Ruby so a NAVIGATION into this scope (fetched Ruby-side,
    // before the destination realm's JS exists) can find its controlling worker.
    () => {
      // Mirror BEFORE the state flips: sw_register_scope also flushes a buffered
      // clients.claim(), and a real browser applies the claim during the activate
      // handler — a synchronous `statechange` listener reading
      // `navigator.serviceWorker.controller` must already see it.
      // Only mirror if this worker is STILL the registration's active worker — a re-register
      // supersedes it (its `active` becomes the new worker), and this superseded worker's
      // already-queued step must not clobber the scope with its now-dead handle. The
      // registration must also still be the scope's LIVE one: an unregister() that raced
      // this parked cycle must not have the host controlling a scope the realm dropped.
      if (r.active === worker && registrations.get(r.scope) === reg) {
        try { globalThis.__csim_swRegisterScope(r.scope, w.handle); } catch (_) {}
      }
      setWorkerState(worker, 'activated');
      maybeResolveReady();
    }
  ];
  // Step 2 is the activation gate. A worker sits in `waiting` while the worker it is replacing
  // still controls clients, unless it has called skipWaiting(). `waitingGate` parks the
  // continuation on the registration so `__csim_swSkipWaiting` — or the outgoing worker losing
  // its last controllee — can resume it.
  const INSTALLED_STEP = 1;
  const ACTIVATE_STEP  = 2;
  const ACTIVATED_STEP = 3;
  const run = i => {
    if (i >= steps.length) return;
    // A SUPERSEDED worker's queued steps must stop: `redundant` is a TERMINAL state,
    // and letting a superseded install cycle keep running resurrects the dead worker
    // ('redundant' → 'installed' statechange) and clobbers the new cycle's slots
    // between ITS steps (reg.installing transiently null after the new updatefound).
    // Its install-marker bookkeeping goes with it (a resumed waiter re-enters here,
    // so the outcome entry would otherwise sit unconsumed forever).
    if (w.state === 'redundant') {
      swInstallOutcome.delete(h);
      swInstallWaiters.delete(h);
      return;
    }
    // 'installed' waits for the worker's install waitUntil promises to settle. A
    // rejection fails the version (spec Install "installFailed"): the worker goes
    // redundant without ever occupying the waiting/active slots, and a registration
    // left with no version at all is cleared — a failed install must not resurrect
    // an unregistered scope (unregister-then-register-new-script), nor leave a
    // phantom registration a later getRegistration() would find.
    if (i === INSTALLED_STEP) {
      if (!swInstallOutcome.has(h)) {
        swInstallWaiters.set(h, () => run(i));
        return;
      }
      const ok = swInstallOutcome.get(h);
      swInstallOutcome.delete(h);
      if (!ok) {
        retire(worker);
        if (r.installing === worker) r.installing = null;
        if (!r.installing && !r.waiting && !r.active && registrations.get(r.scope) === reg) {
          registrations.delete(r.scope);
          // The host mirror of "a live registration exists at this scope" goes with it
          // (Clear Registration — the failed install left no version at all).
          try { globalThis.__csim_swUnregisterScope(r.scope); } catch (_) {}
        }
        return;
      }
    }
    // The observable 'activated' waits for the worker's ACTIVATE PHASE to complete
    // (see swPhaseDone) — its claim/side effects precede the marker in the outbox,
    // so they are in place before any `wait_for_state(..., 'activated')` resolves.
    if (i === ACTIVATED_STEP && !swPhaseDone.has(h)) {
      swPhaseWaiters.set(h, () => run(i));
      return;
    }
    if (i === ACTIVATED_STEP) swPhaseDone.delete(h);
    if (i === ACTIVATE_STEP && !mayActivate(reg, worker)) {
      r.resumeActivation = () => { r.resumeActivation = null; run(i); };
      // Tell the host something is parked, so it only broadcasts try-activate on client
      // teardown when a broadcast could actually release something.
      try { globalThis.__csim_swNoteActivationParked(); } catch (_) {}
      return;
    }
    steps[i]();
    globalThis.__csimSetTimeout(() => run(i + 1), 0);
  };
  globalThis.__csimSetTimeout(() => run(0), 0);
}

// register()/update() promises PARKED on the spawned worker's script-evaluation outcome
// ("Run Service Worker" gates the job: an importScripts that 404s, a top-level throw —
// the version must not install and the promise must reject). The worker thread posts
// the outcome (run_worker → 'sw_eval' → broadcast); only the realm that spawned holds
// the park. `onOk` builds the registration/worker objects and starts the lifecycle —
// deferred to the outcome so a FAILED eval leaves no observable version at all.
const pendingEval = new Map();
// Worker handles whose ACTIVATE phase has completed (run_worker's 'sw_phase' marker),
// and lifecycle continuations parked on it: the observable 'activated' state must not
// precede the activate handler's side effects — the claim that arrived FIFO-ahead of
// the marker has to be in a page's `navigator.serviceWorker.controller` by the time
// `wait_for_state(..., 'activated')` resolves (activation.https setup).
const swPhaseDone    = new Set();
const swPhaseWaiters = new Map();
// Worker handles whose INSTALL phase settled, → whether every install waitUntil
// fulfilled (false = the version failed and goes redundant). Same park/resume shape
// as the activate marker; consumed one-shot by the lifecycle's 'installed' step.
const swInstallOutcome = new Map();
const swInstallWaiters = new Map();
globalThis.__csim_swPhaseDone = function (handle, phase, ok) {
  const h = handle | 0;
  if (String(phase) === 'install') {
    swInstallOutcome.set(h, ok !== false);
    const resumeInstall = swInstallWaiters.get(h);
    if (resumeInstall) { swInstallWaiters.delete(h); resumeInstall(); }
    return;
  }
  swPhaseDone.add(h);
  const resume = swPhaseWaiters.get(h);
  if (resume) { swPhaseWaiters.delete(h); resume(); }
  // …and a worker this realm only knows as a CONTROLLER (`__csim_swSetControllerDirect`), minted while it was still
  // activating: no lifecycle of this realm's moves it, so the marker does — with the `statechange` a page waits on.
  const minted = workerByHandle.get(h);
  if (String(phase) === 'activated' && minted && workerOf(minted).hostWired && workerOf(minted).state === 'activating') setWorkerState(minted, 'activated');
};
// In-flight Register jobs, scope-keyed: the spec's job queue COALESCES equivalent
// jobs, so two concurrent register() calls with the same scope/script/mode resolve to
// the SAME registration via the same job (multiple-register "Concurrent registrations
// resolve to the same registration object") instead of spawning twice.
const pendingRegisterJobs = new Map();
function parkEvalOutcome(handle, onOk) {
  return new Promise((resolve, reject) => {
    pendingEval.set(handle | 0, {onOk, resolve, reject});
  });
}
globalThis.__csim_swEvalOutcome = function (handle, ok, msg) {
  const p = pendingEval.get(handle | 0);
  if (!p) return;
  pendingEval.delete(handle | 0);
  if (ok) {
    try { p.resolve(p.onOk()); } catch (e) { p.reject(e); }
    return;
  }
  // The worker thread already exited; terminate reaps its registry entry.
  try { globalThis.__csim_workerTerminate(handle | 0); } catch (_) {}
  p.reject(new globalThis.TypeError('Failed to register a ServiceWorker: the script evaluation failed. ' + (msg || '')));
};

// Record a registration's updateViaCache mode: host-side (registration-wide, scope-keyed)
// plus the realm-local echo the attribute getter falls back to after unregister.
function setUpdateViaCache(reg, uvc) {
  const r = registrationOf(reg);
  try { globalThis.__csim_swSetUpdateViaCache(r.scope, uvc); } catch (_) {}
  r.updateViaCache = uvc;
}

// "Run Service Worker" fails a CLASSIC script that doesn't parse — register()/update()
// then reject with no new version. Function-body compilation is the closest classic-
// script syntax check available in-realm (a top-level `return` slips through;
// acceptable). NEVER for module scripts: a function body cannot contain their static
// import/export declarations.
function classicScriptParses(body) {
  try { new globalThis.Function(String(body)); return true; }
  catch (_) { return false; }
}

// A parse rejection must not leave the pipeline's parked bytes behind — the next
// register at this scope would otherwise be one call-site mistake away from running
// them (the park is consumed by the next SERVICE spawn there).
function dropPendingScript(scope) {
  try { globalThis.__csim_swDropPendingScript(scope); } catch (_) {}
}

// HTML "try activate": an installed worker may take over only when the worker it replaces has no
// pending extended work and no controllees left — or called skipWaiting(), which bypasses just the
// controllee half. All three facts are HOST knowledge (it owns the client registry, the extended-
// lifetime counters, and the skipWaiting flag recorded when the worker posted it), so the whole
// verdict is ONE host call: split reads raced each other and the flag's delivery (a skipWaiting
// consumed before this realm's worker objects existed was simply lost). Absent the host fn, or
// with no previous worker to displace, activation proceeds as before.
function mayActivate(reg, worker) {
  const outgoing = registrationOf(reg).active;
  if (!outgoing || outgoing === worker) return true;
  const gate = globalThis.__csim_swMayActivate;
  if (typeof gate !== 'function') return true;
  try { return !!gate(workerOf(outgoing).handle | 0, workerOf(worker).handle | 0); } catch (_) { return true; }
}

// A waiting worker called `skipWaiting()` — let it through. The flag itself is host state
// (recorded before this broadcast was even queued); this only resumes a parked continuation,
// which re-asks the host gate. Broadcast to every realm, because the registration objects are
// per-realm and any of them may be holding the park.
globalThis.__csim_swSkipWaiting = function (handle) {
  const h = handle | 0;
  for (const reg of registrations.values()) {
    const r = registrationOf(reg);
    const w = r.waiting || r.installing;
    if (w && (workerOf(w).handle | 0) === h && r.resumeActivation) r.resumeActivation();
  }
};

// The outgoing worker just lost a controllee. If that was its last, a worker parked in `waiting`
// can now activate — the other half of "try activate", which otherwise only ever fires on
// skipWaiting.
globalThis.__csim_swTryActivate = function () {
  for (const reg of registrations.values()) {
    const r = registrationOf(reg);
    if (r.resumeActivation && r.waiting && mayActivate(reg, r.waiting)) r.resumeActivation();
  }
};

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
  return reg && registrationOf(reg).active ? reg : null;
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
    ok = !!globalThis.__csim_serviceWorkerControllerFetch(handle, JSON.stringify(payload), id, realmId);
  } catch (_) {}
  if (!ok) { pendingFetch.delete(id); cb(null); }   // SW gone → network fallback
};
// The SW's respondWith result (host-driven from deliver_worker_messages).
globalThis.__csim_swControllerFetchResponse = hostTask(function (fetchId, respJson) {
  const cb = pendingFetch.get(fetchId | 0);
  if (!cb) return;
  pendingFetch.delete(fetchId | 0);
  let r;
  try { r = JSON.parse(respJson); } catch (_) { r = {fallthrough: true}; }
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
  try { meta = JSON.parse(metaJson); } catch (_) { meta = {}; }
  let controller;
  const realmId = globalThis.RustyRacer.contextOf(globalThis) || 0;
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
  try { c.error(new globalThis.TypeError('ServiceWorker response body stream errored')); } catch (_) {}
};
// This browsing context's `Client.frameType`: 'nested' inside a frame, 'auxiliary' for a window
// another context opened, else 'top-level'.
function clientFrameType() {
  if (globalThis.__csimParent && globalThis.__csimParent !== globalThis) return 'nested';
  if (globalThis.__csimWindowSteps.get_opener(globalThis)) return 'auxiliary';   // (…its opener, not a page's `opener`)
  return 'top-level';
}
// Whether this document's origin is OPAQUE (a frame sandboxed without allow-same-origin).
// Read WITHOUT the `origin` global: that is a Window PROTOTYPE accessor precisely so page script
// can shadow it (`var origin`, see platform-globals.js), and whether a document can be controlled
// must not hinge on what the page happens to name a variable.
function documentOriginIsOpaque() {
  if (globalThis.__csimDocumentOrigin != null) return globalThis.__csimDocumentOrigin === 'null';
  try { return !!globalThis.location && globalThis.location.origin === 'null'; } catch (_) { return false; }
}
// Mirror this browsing context into every service worker's client set. Called when the document
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
  try { note(globalThis.__csimRealmId(), documentHref(), clientFrameType(), (ctrl && workerOf(ctrl).handle) | 0); } catch (_) {}
}
// Host-called once this realm's document has loaded (its URL is set by then, and any host-wired
// controller is already installed), so an uncontrolled context still becomes a known client.
// Called from three places: that host broadcast, `installController` (becoming controlled joins the
// worker's client set), and `register()` — which announces this document before spawning a worker,
// so a worker that enumerates clients while its script evaluates can find the one that registered it.
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
// ServiceWorker if this realm hasn't seen the handle — host-wired, the host owning its isolate's lifecycle — whose handle
// and fetch handler route the frame's subresource fetches (__csimSWControllerHandle).
globalThis.__csim_swSetControllerDirect = function (handle, hasFetchHandler, scriptURL, scope) {
  if (!(handle > 0)) return;
  // A document with an OPAQUE origin (sandboxed without allow-same-origin) is cross-origin to
  // every registration: it gets no controller, and equally no synthesized registration below —
  // a real browser gives such a document no service-worker container at all, so `ready` must
  // never resolve for it. Guarded at this entry rather than deeper, because BOTH halves are
  // forbidden, and because `clients.claim()` broadcasts to every realm and routes here — which
  // is how a sandboxed in-scope frame would otherwise claim itself.
  if (documentOriginIsOpaque()) return;
  let w = workerByHandle.get(handle | 0);
  if (!w) {
    // A controller is the registration's ACTIVE worker — 'activated', or still 'activating' where a frame was built
    // while its registration activates it (the activated marker moves it on, `__csim_swPhaseDone`).
    let activated = true;
    try { activated = globalThis.__csim_swWorkerActivated(handle | 0) !== false; } catch (_) {}
    w = clientWorker(scriptURL || '', handle | 0, activated ? 'activated' : 'activating');
    workerOf(w).hostWired = true;      // host owns this isolate's lifecycle (see terminateWorkers)
    workerByHandle.set(handle | 0, w);
  }
  installController(w, hasFetchHandler);
  // A directly-wired controller (SW-navigated / inherited) never went through register(), so this
  // client has no ServiceWorkerRegistration — synthesize one keyed by the SW's scope, with the
  // controller as its active worker, so `navigator.serviceWorker.getRegistration()` /
  // `.ready` / `registration.active` reflect the controller (controller-on-load / -on-reload).
  if (scope) {
    let reg = registrations.get(scope);
    if (!reg) {
      reg = newRegistration(scope);
      registrations.set(scope, reg);
      // Same TYPE mirror as the cross-realm register synthesize path.
      try { registrationOf(reg).workerType = String(globalThis.__csim_swScopeWorkerType(scope) || 'classic'); } catch (_) {}
    }
    registrationOf(reg).active ??= w;
    maybeResolveReady();
  }
};

// This browsing context was disconnected or discarded: it is no longer a service-worker client, so a reference
// retained to its `navigator.serviceWorker` reports no controller (controller-on-disconnect). Called in its realm, while
// that is still alive, just before disposal.
globalThis.__csim_swClientDiscarded = function () {
  containerOf(serviceWorkerContainer).controller = null;
};

// A service worker → client message (host-driven from deliver_worker_messages): fire a
// `message` event on this window's navigator.serviceWorker, source = the SENDING worker.
// `handle` identifies it exactly (the host passes the posting worker's handle); fall
// back to this client's `controller` (a directly-controlled frame never called
// register(), so its per-realm `registrations` map is empty — postmessage-to-client
// asserts `e.source === controller`), then to the first active registration.
globalThis.__csim_swDeliverClientMessage = hostTask(function (dataStr, handle) {
  let data = null, ports = [];
  try { ({ data, ports } = decodeMessage(dataStr)); } catch (_) {}
  const active = (handle && workerByHandle.get(handle | 0)) || containerOf(serviceWorkerContainer).controller || firstActiveWorker();
  const ev = createMessageEvent('message', {data, origin: originOfDocument(), source: active, ports});
  dispatchWithOnHandler(serviceWorkerContainer, ev);
});

// Host-reachable lifecycle callback (reserved for Ruby-driven transitions in a later
// increment — e.g. install failure → redundant). Looks a worker up by handle.
globalThis.__csim_swStateChange = function (handle, state) {
  const w = workerByHandle.get(handle | 0);
  if (w) setWorkerState(w, String(state));
};

function firstActiveWorker() {
  for (const reg of registrations.values()) {
    const active = registrationOf(reg).active;
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
  // Update from a service worker whose OWN install is still running rejects (spec Update job: promote-then-reject when
  // the job's worker is the registration's installing worker — update-not-allowed "from installing service worker
  // throws"). From an installed or active worker it resolves without re-running Update — the real worker-side Soft
  // Update job (outbox route) is the SWGlobalScope/update backlog item.
  update(reg) {
    const installing = registrationOf(reg).installing;
    if (installing && workerOf(installing).state === 'installing') {
      return Promise.reject(new globalThis.DOMException('update() is not allowed from an installing service worker', 'InvalidStateError'));
    }
    return Promise.resolve(reg);
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
      return Promise.resolve(true);
    }
    return new Promise(resolve => {
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
    const registration = new ServiceWorkerRegistration(PLATFORM, scope, SCOPE_REGISTRATION);
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
