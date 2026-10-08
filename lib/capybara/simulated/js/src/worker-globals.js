// A worker's global (workers.js `__csim_installWorkerScope`), made from the window's snapshot: it drops the Window's
// members (window.js) and the interface objects of those exposed in a Window alone, and becomes its kind's global scope
// (HTML §10.2.1) — generated from the IDL: its [[Prototype]] its kind's global scope interface's prototype, whose chain runs through WorkerGlobalScope's (WindowOrWorkerGlobalScope's members among its own) to
// EventTarget's; the [Global] interface's own members the global's own properties; its `navigator` a WorkerNavigator
// and its `location` a WorkerLocation. A service worker's is ServiceWorkerGlobalScope's, its state workers.js's.
// (A leaf, which bridge.entry.js imports: workers.js is in an import cycle with blob.js, and its hook asks this one.)

import {
  WINDOW_ONLY_INTERFACES, installDedicatedWorkerGlobalScope, installServiceWorkerGlobalScope, installSharedWorkerGlobalScope,
  installWorkerGlobalScope, installWorkerLocation, installWorkerNavigator
} from './generated/bindings.js';
import { PLATFORM, constructedBy, registerInterface } from './webidl.js';
import { documentOrigin, performance, reportError, structuredClone } from './platform-globals.js';
import {
  cancelAnimationFrame, clearTimer, queueMicrotask, requestAnimationFrame, setInterval, setTimeout
} from './timers.js';
import { atob, btoa } from './encoding.js';
import { createImageBitmap } from './canvas.js';
import { location } from './location.js';
import { navigatorIdentity } from './navigator.js';
import { indexedDB } from './idb.js';
import { caches } from './cache-storage.js';
import { crypto } from './webcrypto.js';
import { windowMemberNames } from './window.js';
import { FileReaderSync } from './file-reader.js';
import { EventTarget, installEventHandlerAttrs, markWorkerRealm } from './events.js';
import { closeWorker, importScripts, postToOwner, skipWaiting, swScope, workerCrossOriginIsolated, workerKind, workerName } from './workers.js';

// The interfaces: no page constructs one — a worker's global is the platform's, its navigator and location too.
const illegal = (name) => { throw new TypeError(`Failed to construct '${name}': Illegal constructor`); };
export class WorkerGlobalScope extends EventTarget {
  constructor() { illegal('WorkerGlobalScope'); super(); }
}
export class DedicatedWorkerGlobalScope extends WorkerGlobalScope {
  constructor() { illegal('DedicatedWorkerGlobalScope'); super(); }
}
export class SharedWorkerGlobalScope extends WorkerGlobalScope {
  constructor() { illegal('SharedWorkerGlobalScope'); super(); }
}
export class ServiceWorkerGlobalScope extends WorkerGlobalScope {
  constructor() { illegal('ServiceWorkerGlobalScope'); super(); }
}
class WorkerNavigator {
  constructor(token) { constructedBy(PLATFORM, token, 'WorkerNavigator'); }
}
class WorkerLocation {
  constructor(token) { constructedBy(PLATFORM, token, 'WorkerLocation'); }
}

// (…a worker's global is one of them in its own realm alone, of its kind — which workers.js latches; this realm's
// navigator and location the only objects of theirs)
registerInterface('WorkerGlobalScope', (o) => o === globalThis && workerKind !== null);
registerInterface('DedicatedWorkerGlobalScope', (o) => o === globalThis && workerKind === 'dedicated');
registerInterface('SharedWorkerGlobalScope', (o) => o === globalThis && workerKind === 'shared');
registerInterface('ServiceWorkerGlobalScope', (o) => o === globalThis && workerKind === 'service');
let workerNavigator = null, workerLocation = null, workerFonts = null;
registerInterface('WorkerNavigator', (o) => o !== null && o === workerNavigator);
registerInterface('WorkerLocation', (o) => o !== null && o === workerLocation);

// (…its event handlers listeners, as a window's are)
const installHandlers = (holder, names, isSelf) => installEventHandlerAttrs(holder, names, null, isSelf);

// The interfaces' members, installed as a worker's realm is made — a window's has no use for them: WorkerGlobalScope's on
// its prototype, its kind's own returned to be defined on the global, the navigator's and location's on theirs.
function installWorkerInterfaces() {
  // WorkerGlobalScope's members (WindowOrWorkerGlobalScope's among them): the timers, encoding, cloning and storage the
  // window's are, its `self` the scope, its navigator, location and font set the realm's.
  installWorkerGlobalScope(WorkerGlobalScope, {
    get_self: (self) => self,
    get_location: () => workerLocation,
    get_navigator: () => workerNavigator,
    importScripts: (self, urls) => importScripts(...urls),
    get_origin: () => documentOrigin(),
    get_isSecureContext: () => true,
    get_crossOriginIsolated: () => workerCrossOriginIsolated,
    reportError: (self, e) => reportError(e),
    btoa: (self, data) => btoa(data),
    atob: (self, data) => atob(data),
    setTimeout: (self, handler, timeout, args) => setTimeout(handler, timeout, args),
    clearTimeout: (self, id) => clearTimer(id),
    setInterval: (self, handler, timeout, args) => setInterval(handler, timeout, args),
    clearInterval: (self, id) => clearTimer(id),
    queueMicrotask: (self, callback) => queueMicrotask(callback),
    createImageBitmap_image_options: (self, image, options) => createImageBitmap(image, options),
    createImageBitmap_image_sx_sy_sw_sh_options: (self, image, sx, sy, sw, sh, options) => createImageBitmap(image, sx, sy, sw, sh, options),
    structuredClone: (self, value, options) => structuredClone(value, options),
    get_performance: () => performance,
    get_indexedDB: () => indexedDB,
    get_crypto: () => crypto,
    get_caches: () => caches,
    // (…a worker's FontFaceSet: no document, so no CSS-connected faces and nothing to lay out — `add()` / `check()` /
    // `load()` and a face's own `load()` fetch — made when first asked for)
    get_fonts: () => workerFonts || (workerFonts = globalThis.__csimNewFontFaceSet(null)),
    installEventHandlers: installHandlers
  });

  // A dedicated worker's and a shared worker's own: its name (WorkerOptions'), postMessage to its owner — the transfer
  // list either form of the call names — `close()`, and a dedicated one's animation frames.
  const dedicated = installDedicatedWorkerGlobalScope(DedicatedWorkerGlobalScope, {
    get_name: () => workerName,
    postMessage_message_transfer: (self, message, transfer) => postToOwner(message, transfer),
    postMessage_message_options: (self, message, options) => postToOwner(message, options.transfer),
    close: () => closeWorker(),
    requestAnimationFrame: (self, callback) => requestAnimationFrame(callback),
    cancelAnimationFrame: (self, handle) => cancelAnimationFrame(handle),
    installEventHandlers: installHandlers
  });
  const shared = installSharedWorkerGlobalScope(SharedWorkerGlobalScope, {
    get_name: () => workerName,
    close: () => closeWorker(),
    installEventHandlers: installHandlers
  });

  // The worker's navigator and location: what a window's says of the user agent, its languages and hardware (navigator.js),
  // and the worker script's URL, which `__csimUpdateLocation` keeps (location.js).
  installWorkerNavigator(WorkerNavigator, navigatorIdentity);
  installWorkerLocation(WorkerLocation, {
    get_href: () => location.href,
    get_origin: () => location.origin,
    get_protocol: () => location.protocol,
    get_host: () => location.host,
    get_hostname: () => location.hostname,
    get_port: () => location.port,
    get_pathname: () => location.pathname,
    get_search: () => location.search,
    get_hash: () => location.hash
  });
  // (…and a service worker's: its clients, its registration and the ServiceWorker it is, skipWaiting(), and the
  // lifecycle's, fetches' and messages' event handlers — workers.js keeps its state)
  const service = installServiceWorkerGlobalScope(ServiceWorkerGlobalScope, {
    get_clients: () => swScope.clients,
    get_registration: () => swScope.registration,
    get_serviceWorker: () => swScope.serviceWorker,
    skipWaiting: () => skipWaiting(),
    installEventHandlers: installHandlers
  });
  return { dedicated, shared, service };
}

globalThis.__csimInstallWorkerGlobals = function () {
  markWorkerRealm();
  const scopes = installWorkerInterfaces();
  for (const name of windowMemberNames()) delete globalThis[name];
  // (…and the interface objects of those exposed in a Window alone: a worker has no Node, no MouseEvent)
  for (const name of WINDOW_ONLY_INTERFACES) delete globalThis[name];
  // (…and what the window's global had of its own that the scope's prototype chain answers now: its class string, its
  // `constructor`, EventTarget's methods)
  for (const name of [Symbol.toStringTag, 'constructor', 'addEventListener', 'removeEventListener', 'dispatchEvent']) delete globalThis[name];
  workerNavigator = new WorkerNavigator(PLATFORM);
  workerLocation = new WorkerLocation(PLATFORM);
  const [scope, members] = {
    dedicated: [DedicatedWorkerGlobalScope, scopes.dedicated],
    shared: [SharedWorkerGlobalScope, scopes.shared],
    service: [ServiceWorkerGlobalScope, scopes.service]
  }[workerKind];
  Object.setPrototypeOf(globalThis, scope.prototype);
  members.defineMembers(globalThis);
  // (…its interface objects, each where it is exposed: WorkerGlobalScope in any worker, its kind's in its own)
  const expose = (name, iface) => Object.defineProperty(globalThis, name, { value: iface, writable: true, enumerable: false, configurable: true });
  expose('WorkerGlobalScope', WorkerGlobalScope);
  expose('WorkerNavigator', WorkerNavigator);
  expose('WorkerLocation', WorkerLocation);
  expose(scope.name, scope);
  // (…and a dedicated or shared worker's own: FileReaderSync, which a service worker, whose reads must not block, has not)
  if (workerKind !== 'service') expose('FileReaderSync', FileReaderSync);
};
