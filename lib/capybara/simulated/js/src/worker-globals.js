// A worker's global (workers.js `__csim_installWorkerScope`), made from the window's snapshot: it drops the Window's
// members (window.js) and the interface objects of those exposed in a Window alone, and becomes its kind's global scope
// (HTML §10.2.1) — generated from the IDL: its [[Prototype]] DedicatedWorkerGlobalScope's or SharedWorkerGlobalScope's
// prototype, whose chain runs through WorkerGlobalScope's (WindowOrWorkerGlobalScope's members among its own) to
// EventTarget's; the [Global] interface's own members the global's own properties; its `navigator` a WorkerNavigator
// and its `location` a WorkerLocation. A service worker's is WorkerGlobalScope's, its own scope (workers.js) on top.
// (A leaf, which bridge.entry.js imports: workers.js is in an import cycle with blob.js, and its hook asks this one.)

import {
  WINDOW_ONLY_INTERFACES, installDedicatedWorkerGlobalScope, installSharedWorkerGlobalScope, installWorkerGlobalScope,
  installWorkerLocation, installWorkerNavigator
} from './generated/bindings.js';
import { PLATFORM, constructedBy, registerInterface } from './webidl.js';
import { documentOrigin, performance, reportError, structuredClone } from './platform-globals.js';
import {
  cancelAnimationFrame, clearTimer, queueMicrotask, requestAnimationFrame, setInterval, setTimeout
} from './timers.js';
import { atob, btoa } from './encoding.js';
import { createImageBitmap } from './canvas.js';
import { location } from './location.js';
import { navigator } from './navigator.js';
import { indexedDB } from './idb.js';
import { caches } from './cache-storage.js';
import { crypto } from './webcrypto.js';
import { windowMemberNames } from './window.js';
import { EventTarget, installEventHandlerAttrs, markWorkerRealm } from './events.js';
import { closeWorker, importScripts, postToOwner } from './workers.js';

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
class WorkerNavigator {
  constructor(token) { constructedBy(PLATFORM, token, 'WorkerNavigator'); }
}
class WorkerLocation {
  constructor(token) { constructedBy(PLATFORM, token, 'WorkerLocation'); }
}

// (…a worker's global is one of them in its own realm alone, of its kind; this realm's navigator and location the only
// objects of theirs)
const workerRealm = () => globalThis.__csim_isWorker === true;
registerInterface('WorkerGlobalScope', (o) => o === globalThis && workerRealm());
registerInterface('DedicatedWorkerGlobalScope', (o) => o === globalThis && workerRealm() && globalThis.__csimWorkerKind === 'dedicated');
registerInterface('SharedWorkerGlobalScope', (o) => o === globalThis && workerRealm() && globalThis.__csimWorkerKind === 'shared');
let workerNavigator = null, workerLocation = null, workerFonts = null;
registerInterface('WorkerNavigator', (o) => o !== null && o === workerNavigator);
registerInterface('WorkerLocation', (o) => o !== null && o === workerLocation);

// (…its event handlers listeners, as a window's are)
const installHandlers = (holder, names) => installEventHandlerAttrs(holder, names, null);

// WorkerGlobalScope's members (WindowOrWorkerGlobalScope's among them): the timers, encoding, cloning and storage the
// window's are, its `self` the scope, its navigator, location and font set the realm's.
installWorkerGlobalScope(WorkerGlobalScope, {
  get_self: (self) => self,
  get_location: () => workerLocation,
  get_navigator: () => workerNavigator,
  importScripts: (self, urls) => importScripts(...urls),
  get_origin: () => documentOrigin(),
  get_isSecureContext: () => true,
  get_crossOriginIsolated: () => false,
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

// A dedicated worker's and a shared worker's own: its name (none given here), postMessage to its owner — the transfer
// list either form of the call names — `close()`, and a dedicated one's animation frames.
const dedicated = installDedicatedWorkerGlobalScope(DedicatedWorkerGlobalScope, {
  get_name: () => '',
  postMessage_message_transfer: (self, message, transfer) => postToOwner(message, transfer),
  postMessage_message_options: (self, message, options) => postToOwner(message, options.transfer),
  close: () => closeWorker(),
  requestAnimationFrame: (self, callback) => requestAnimationFrame(callback),
  cancelAnimationFrame: (self, handle) => cancelAnimationFrame(handle),
  installEventHandlers: installHandlers
});
const shared = installSharedWorkerGlobalScope(SharedWorkerGlobalScope, {
  get_name: () => '',
  close: () => closeWorker(),
  installEventHandlers: installHandlers
});

// The worker's navigator and location: the window's values a worker has (its user agent, languages, hardware), and the
// worker script's URL, which `__csimUpdateLocation` keeps (location.js).
installWorkerNavigator(WorkerNavigator, {
  get_appCodeName: () => 'Mozilla',
  get_appName: () => navigator.appName,
  get_appVersion: () => navigator.appVersion,
  get_platform: () => navigator.platform,
  get_product: () => 'Gecko',
  get_userAgent: () => navigator.userAgent,
  get_language: () => navigator.language,
  get_languages: () => navigator.languages,
  get_onLine: () => navigator.onLine,
  get_hardwareConcurrency: () => navigator.hardwareConcurrency,
  get_deviceMemory: () => navigator.deviceMemory,
  get_globalPrivacyControl: () => navigator.globalPrivacyControl,
  get_connection: () => navigator.connection,
  get_locks: () => navigator.locks,
  get_serviceWorker: () => navigator.serviceWorker
});
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

globalThis.__csimInstallWorkerGlobals = function () {
  markWorkerRealm();
  for (const name of windowMemberNames()) delete globalThis[name];
  // (…and the interface objects of those exposed in a Window alone: a worker has no Node, no MouseEvent)
  for (const name of WINDOW_ONLY_INTERFACES) delete globalThis[name];
  delete globalThis[Symbol.toStringTag];   // (…the window's class string: its scope's prototype has its own)
  workerNavigator = new WorkerNavigator(PLATFORM);
  workerLocation = new WorkerLocation(PLATFORM);
  const kind = globalThis.__csimWorkerKind;
  const scope = kind === 'dedicated' ? DedicatedWorkerGlobalScope : kind === 'shared' ? SharedWorkerGlobalScope : WorkerGlobalScope;
  Object.setPrototypeOf(globalThis, scope.prototype);
  if (kind === 'dedicated') dedicated.defineMembers(globalThis);
  if (kind === 'shared') shared.defineMembers(globalThis);
  // (…its interface objects, each where it is exposed: WorkerGlobalScope in any worker, its kind's in its own)
  const expose = (name, iface) => Object.defineProperty(globalThis, name, { value: iface, writable: true, enumerable: false, configurable: true });
  expose('WorkerGlobalScope', WorkerGlobalScope);
  expose('WorkerNavigator', WorkerNavigator);
  expose('WorkerLocation', WorkerLocation);
  if (kind === 'dedicated') expose('DedicatedWorkerGlobalScope', DedicatedWorkerGlobalScope);
  if (kind === 'shared') expose('SharedWorkerGlobalScope', SharedWorkerGlobalScope);
};
