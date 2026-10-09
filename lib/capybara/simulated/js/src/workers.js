// Web Workers — main-scope `new Worker(url)` spawns a Ruby thread
// that creates a fresh V8 Context (real isolate, no
// shared memory) and loads the worker script. Cross-isolate
// communication is via Thread::Queue on the Ruby side; postMessage
// payloads are JSON-cloned with an extra wrapper for binary types —
// raw `JSON.stringify` flattens a Uint8Array to a numeric-keyed
// object, so image bytes posted through a worker would arrive as
// garbage.
//
// Worker class wiring is installed per realm, by `__csimInitRealm()` (bridge.entry.js), which Ruby calls as it makes one.

import {
  CONVERTED, DOMException, ErrorEvent, Event, EventTarget, createMessageEvent, dispatchWithOnHandler, eventTest,
  fireWithCheckpoints, installEventHandlerAttrs
} from './events.js';
import { fetchTransfer, stashTransfer, transferListFrom } from './bytes.js';
import { responseFromWire, serializeResponseWire, serializeResponseMeta } from './response-wire.js';
import {
  IntrinsicPromise,
  PLATFORM,
  brandPrototype,
  constructedBy,
  hasSlots,
  interfaceCheck,
  isBufferOf,
  makeSlots,
  promiseThen,
  promiseThenChained,
  registerInterface,
  rejectedPromise,
  resolvedPromise,
  slotsOf
} from './webidl.js';
import { location } from './location.js';
import { followWindowClock, hostTask } from './timers.js';
import { isMessagePort, newEntangledPorts } from './message-port.js';
import { deserializePlatformObjects, deserializeWithTransfer, serializeWithTransfer } from './platform-globals.js';
import {
  LEGACY_WINDOW_ALIASES,
  convertExtendableEventArguments,
  convertExtendableMessageEventArguments,
  convertFetchEventArguments,
  convertInstallEventArguments,
  convertSharedWorkerArguments,
  convertWorkerArguments,
  installClient,
  installClients,
  installExtendableEvent,
  installExtendableMessageEvent,
  installFetchEvent,
  installInstallEvent,
  installSharedWorker,
  installWindowClient,
  installWorker
} from './generated/bindings.js';
import { setHeadersGuard } from './headers.js';
import { Request, requestOf, responseBytes, responseOf } from './fetch.js';

// The `error` a worker's failure fires at its Worker: a script's exception its global left unhandled, an ErrorEvent of
// its message and place (`__scripterror`, cancelable); a script that could not be fetched or run, a simple event.
function workerErrorEvent(e) {
  if (e.kind !== '__scripterror') return new Event('error');
  return new ErrorEvent('error', { message: String(e.message), filename: String(e.filename || ''), lineno: e.lineno | 0, colno: e.colno | 0, cancelable: true });
}
// True iff blob URLs created here must be visible to ANOTHER isolate:
// the main scope has spawned a Worker, OR we ARE a worker (our blob
// URLs are inherently reachable by the owning page). Blob.createObjectURL
// gates its Ruby-side blob-registry byte IPC on this so the no-Worker fast
// path skips a btoa+host-fn per File pick.
export function hasWorkers() {
  return globalThis.__csim_isWorker || workersByHandle.size > 0;
}

// Buffers ≥ TRANSFER_STASH_MIN cross isolates by refId rather than
// JSON-base64; otherwise the 8900×8900-RGBA postMessage in Discourse's
// media-optimization-worker peaks JS heap at gigabytes of intermediate
// latin-1 / base64 strings before the worker even sees the payload.
const TRANSFER_STASH_MIN = 64 * 1024;
const IS_READABLE_STREAM = interfaceCheck('ReadableStream');

// The "JavaScript MIME type essence match" set (Fetch/Infra): a classic worker-imported script whose
// Content-Type essence isn't one of these is a network error. Used by importScripts (below).
const JS_MIME_ESSENCES = new Set([
  'application/ecmascript', 'application/javascript', 'application/x-ecmascript', 'application/x-javascript',
  'text/ecmascript', 'text/javascript', 'text/javascript1.0', 'text/javascript1.1', 'text/javascript1.2',
  'text/javascript1.3', 'text/javascript1.4', 'text/javascript1.5', 'text/jscript', 'text/livescript',
  'text/x-ecmascript', 'text/x-javascript'
]);


// A postMessage across isolates — to a worker, from one, over a port whose other end is in another — WITH its transfer
// list: StructuredSerializeWithTransfer here (platform-globals.js `serializeWithTransfer`: the list checked, the data
// serialized, every transferable moved), the serialization taken out of this isolate (`__dom.structuredExport`), and
// the wire: its bytes — base64, or a stash reference for a large one — each transferred ArrayBuffer's memory by a
// zero-copy token (`RustyRacer.transferOut`), and, by its place in the list, each other transferable's form across — a
// MessagePort its channel end, an ImageBitmap or an OffscreenCanvas its record, pixels and all, which go serialized as
// data are (`serializedBytes`). A ReadableStream crosses no isolate here:
// a DataCloneError, before anything is serialized; nor does a SharedArrayBuffer, which no isolate here shares with
// another. The bytes go by the stash (`stash`) only between a window and its dedicated worker, which share its window's
// registry, and for a message read back once: inline across windows — each its own registry — and to every channel of
// a broadcast.
export function encodeMessage(data, transferList, stash = false) {
  const tf = transferListFrom(transferList);
  for (const t of tf) if (IS_READABLE_STREAM(t)) throw new DOMException('A ReadableStream could not be transferred to another agent.', 'DataCloneError');
  const { serialized, list, moved } = serializeWithTransfer(data, tf, false);
  const [bytes, buffers] = globalThis.__dom.structuredExport(serialized);
  const view = new Uint8Array(bytes);
  const refId = stash && view.byteLength >= TRANSFER_STASH_MIN ? stashTransfer(view) : 0;
  const NS = globalThis.RustyRacer;
  const tokens = buffers.map((b) => {
    const token = NS.transferOut(b) | 0;
    if (token > 0 && globalThis.__csim_transferIssued) globalThis.__csim_transferIssued(token);
    return token;
  });
  const across = list.map((t) => {
    if (!moved.has(t)) return null;
    const m = moved.get(t);
    return isMessagePort(m)
      ? { port: globalThis.__csimPortToEnd(m) }
      : { record: globalThis.__csimCanvasSerialization.record(m, new Set([m])) };
  });
  const forms = serializedBytes(across).toBase64();
  return JSON.stringify(refId > 0 ? { r: refId, x: tokens, t: forms } : { b: view.toBase64(), x: tokens, t: forms });
}
// Plain data — records, typed arrays and all, no platform object — serialized and taken out of this isolate as bytes,
// and read back.
const serializedBytes = (data) => new Uint8Array(globalThis.__dom.structuredExport(globalThis.__dom.structuredSerialize(data, refusePlatformObject, false, NO_TRANSFER))[0]);
const refusePlatformObject = () => { throw new DOMException('A platform object could not be serialized as data.', 'DataCloneError'); };
const deserializedBytes = (bytes) => globalThis.__dom.structuredDeserialize(globalThis.__dom.structuredImport(bytes.buffer, NO_TRANSFER), deserializePlatformObjects);
const NO_TRANSFER = Object.freeze([]);
// …and StructuredDeserializeWithTransfer it in this realm: the serialization brought into this isolate
// (`__dom.structuredImport`), its ArrayBuffers' memory from their tokens, and each other transferable made of its form
// across — the channel end a MessagePort of this realm. The data, and the transferred MessagePorts: `event.ports`. One
// that cannot be read back here is `failed`, its event a `messageerror` with no data and no ports (HTML), and what it
// brought in let go.
const FAILED = Object.freeze({ data: null, ports: Object.freeze([]), failed: true });
export function decodeMessage(str) {
  let serialized = -1;
  try {
    const wire = JSON.parse(str);
    const bytes = wire.r != null ? fetchTransfer(wire.r) : globalThis.Uint8Array.fromBase64(wire.b);
    const NS = globalThis.RustyRacer;
    const buffers = wire.x.map((token) => NS.transferIn(token) || new ArrayBuffer(0));
    const copy = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.slice().buffer;
    serialized = globalThis.__dom.structuredImport(copy, buffers);
    const list = [], moved = new Map();
    deserializedBytes(globalThis.Uint8Array.fromBase64(wire.t)).forEach((t, place) => {
      list.push(place);
      if (t !== null) moved.set(place, t.port != null ? globalThis.__csimEndToPort(t.port) : globalThis.__csimCanvasSerialization.fromRecord(t.record));
    });
    return deserializeWithTransfer({ serialized, list, moved });
  } catch (_) {
    if (serialized !== -1) globalThis.__dom.structuredDiscard(serialized);
    return FAILED;
  }
}
// A message read back here, encoded again to cross on — a port's held messages, as it is transferred — or, where it
// cannot be (it failed already, or holds what crosses no isolate), one that is read back as failed.
export function reencodeMessage(m) {
  if (m.failed) return 'null';
  try { return encodeMessage(m.data, m.ports); } catch (_) { return 'null'; }
}
globalThis.__csimReencodeMessage = reencodeMessage;
// The event a message read back fires: `message`, or `messageerror` where it could not be.
export const messageEventType = (m) => (m.failed ? 'messageerror' : 'message');
globalThis.__csimEncodeMessage = encodeMessage;
globalThis.__csimDecodeMessage = decodeMessage;

// The creating context's live controller handle (0 when uncontrolled / before sw-client.js has
// installed the accessor). Read at `new Worker(...)` time, never cached: control commonly arrives
// after load, via `clients.claim()`.
function controllerHandle() {
  const f = globalThis.__csimControllerHandle;
  return typeof f === 'function' ? (f() | 0) : 0;
}

// ── Worker and SharedWorker (HTML §10.2.6), generated from their IDL ──
// A Worker — a window's, or a nested one a worker makes — and a SharedWorker, a window's, reached through its port.
// Their slots: the handle of the worker the host spawned (-1 once terminated), and a SharedWorker's port. Every one this
// realm or isolate made, by handle, for the host's deliveries (`__csim_deliverWorkerMessages`).
const workersByHandle = new Map();
registerInterface('Worker', (o) => slotsOf(o, 'Worker') !== undefined);
registerInterface('SharedWorker', (o) => slotsOf(o, 'SharedWorker') !== undefined);

// A worker's script URL, resolved against the CONSTRUCTING realm's own document base — the host would otherwise
// resolve it against the MAIN document (resolve_against_current), another directory for a frame's `new Worker('x.js')`
// (worker-client-id; the same unify as the relative <script src> fix) — or a nested worker's against its parent's
// script URL. One that does not parse is a SyntaxError (HTML "encoding-parse a URL").
function resolveWorkerUrl(url, iface) {
  try {
    return new globalThis.URL(url, (globalThis.document && globalThis.document.baseURI) || location.href || undefined).href;
  } catch (_) {
    throw new DOMException(`Failed to construct '${iface}': Script at '${url}' cannot be parsed.`, 'SyntaxError');
  }
}
// The host's spawn of a worker of `url`, `shared` or not, with the creator it dies with — the constructing REALM, or
// -(the parent worker's handle) for a nested worker (the worker-parent convention the fetch routing already uses: the
// host records the parentage, routes the child's messages back through the parent's inbox, and terminates the child with
// its parent) — the creating context's origin key (so a blob:/data: worker, whose script URL has no real origin,
// inherits this agent cluster's origin for BroadcastChannel scoping), and its CURRENT controller, which a DEDICATED
// worker inherits rather than scope-matching its own (often opaque) script URL.
function spawnWorker(url, shared, type, name) {
  const creator = globalThis.__csim_isWorker ? -(globalThis.__csimWorkerHandle | 0) : globalThis.__csimRealmId();
  return globalThis.__csim_workerSpawn(url, shared, globalThis.__csimBcOriginKey(), creator, shared ? 0 : controllerHandle(), type, name) | 0;
}
// Resource Timing for a window's DEDICATED worker's own main-script fetch: a classic worker files an 'other' entry, a
// module worker a 'script' entry (resource-timing/initiator-type/workers). `worker_spawn` stashed the fetch fact for the
// script it just fetched (only for a dedicated worker — a shared worker's script is not a document subresource, so it
// files nothing); filed here so the entry lands in the creating realm's timeline, with the type the constructor knows.
function recordWorkerRt(fallbackUrl, type) {
  if (typeof globalThis.__csim_takeWorkerRt !== 'function' || typeof globalThis.__csimRecordResource !== 'function') return;
  const rt = globalThis.__csim_takeWorkerRt();
  if (!rt) return;
  globalThis.__csimRecordResource({
    name:          rt.url || fallbackUrl,
    initiatorType: type === 'module' ? 'script' : 'other',
    startTime:     globalThis.__csimPerformanceNow(),
    resp:          rt.meta,
    noCors:        false
  });
}

class Worker extends EventTarget {
  constructor() {
    const [scriptURL, options] = convertWorkerArguments(arguments);
    super();
    const url = resolveWorkerUrl(scriptURL, 'Worker');
    const handle = spawnWorker(url, false, options.type, options.name);
    makeSlots(this, 'Worker', { handle });
    if (handle > 0) workersByHandle.set(handle, this);
    // (…a window's on the window's clock, its script's fetch in the window's timeline)
    if (!globalThis.__csim_isWorker) {
      followWindowClock();
      recordWorkerRt(url, options.type);
    }
  }
}
// What a page posts to a worker, serialized for its inbox.
function postToWorker(handle, message, transfer) {
  if (handle <= 0) return;
  globalThis.__csim_workerPostToWorker(handle, encodeMessage(message, transfer, true));
}
installWorker(Worker, {
  postMessage_message_transfer: (worker, message, transfer) => postToWorker(slotsOf(worker, 'Worker').handle, message, transfer),
  postMessage_message_options: (worker, message, options) => postToWorker(slotsOf(worker, 'Worker').handle, message, options.transfer),
  terminate(worker) {
    const w = slotsOf(worker, 'Worker');
    if (w.handle <= 0) return;
    globalThis.__csim_workerTerminate(w.handle);
    workersByHandle.delete(w.handle);
    w.handle = -1;
  },
  installEventHandlers: (proto, names, isSelf) => installEventHandlerAttrs(proto, names, null, isSelf)
});

// A SharedWorker's port is one end of a channel whose other end — the inside port — goes to the worker with the
// connection, which its `connect` event carries (HTML "run a worker"); what either posts crosses as any transferred
// port's messages do. A shared worker's script is not a document subresource, so it files no Resource Timing entry
// (resource-timing/shared-worker-rt-entry).
class SharedWorker extends EventTarget {
  constructor() {
    const [scriptURL, options] = convertSharedWorkerArguments(arguments);
    super();
    const { type, name } = typeof options === 'string' ? { type: 'classic', name: options } : options;
    const handle = spawnWorker(resolveWorkerUrl(scriptURL, 'SharedWorker'), true, type, name);
    const [outside, inside] = newEntangledPorts();
    makeSlots(this, 'SharedWorker', { handle, port: outside });
    followWindowClock();
    if (handle > 0) {
      workersByHandle.set(handle, this);
      postToWorker(handle, null, [inside]);
    }
  }
}
installSharedWorker(SharedWorker, {
  get_port: (worker) => slotsOf(worker, 'SharedWorker').port,
  installEventHandlers: (proto, names, isSelf) => installEventHandlerAttrs(proto, names, null, isSelf)
});

// The host's deliveries of what this realm's or isolate's workers sent: each `{handle, kind:'message', data}` (a JSON
// string) a message at its Worker, or `{handle, kind:'__error' | '__scripterror', …}` an error at its Worker or
// SharedWorker (a SharedWorker's messages come through its port). A window realm fans what it could not place out to
// its child realms: a worker made INSIDE a frame keeps its entry there (worker_spawn is a host fn on the browser, but
// `new Worker` ran in the frame realm), while the Ruby drain delivers via the MAIN realm; each child handles its own and
// recurses, so a worker in a nested frame is reached too.
globalThis.__csim_deliverWorkerMessages = hostTask(function (events) {
  if (!events || !events.length) return 0;
  let n = 0;
  const unhandled = [];
  for (const e of events) {
    const worker = workersByHandle.get(e.handle | 0);
    if (!worker) { unhandled.push(e); continue; }
    if (e.kind === '__error' || e.kind === '__scripterror') {
      dispatchWithOnHandler(worker, workerErrorEvent(e));
    } else {
      const m = decodeMessage(e.data);
      dispatchWithOnHandler(worker, createMessageEvent(messageEventType(m), { data: m.data, ports: m.ports }));
    }
    n++;
  }
  if (unhandled.length && typeof globalThis.__csimEachChildRealm === 'function') {
    globalThis.__csimEachChildRealm(g => {
      if (typeof g.__csim_deliverWorkerMessages === 'function') n += g.__csim_deliverWorkerMessages(unhandled) || 0;
      return undefined;   // visit every child (accumulate), never short-circuit
    });
  }
  return n;
});
// An interface object on the global, as WebIDL gives one: writable and configurable, not enumerable.
const exposeInterface = (iface) => {
  Object.defineProperty(globalThis, iface.name, { value: iface, writable: true, enumerable: false, configurable: true });
};
// A window realm's Worker and SharedWorker interface objects (bridge.entry.js `__csimInitRealm`).
globalThis.__csim_installWorker = function () {
  exposeInterface(Worker);
  exposeInterface(SharedWorker);
};

// `importScripts(url, ...)` is the Web Worker API for synchronous
// script include — Tesseract.js's blob-bundled bootstrapper does
// `importScripts('worker.min.js')` first thing. Synchronously
// fetch via `__rackFetch` (worker thread → Ruby `Browser`
// `rack_fetch`, which is mutex-safe for the cache and uses the
// shared Rack app) and indirect-eval at global scope.
export function importScripts(...urls) {
  // importScripts is CLASSIC-worker-only: a module worker throws a TypeError
  // (HTML "importing scripts and libraries": module workers must use import()).
  if (globalThis.__csimWorkerModule) {
    throw new globalThis.TypeError("Failed to execute 'importScripts' on 'WorkerGlobalScope': Module scripts don't support importScripts().");
  }
  // importScripts resolves each URL against the WORKER SCRIPT's URL (self.location).
  // `__rackFetch` resolves relative URLs against the parent page instead, so resolve
  // here first — the executor-worker's `importScripts('./dispatcher.js')` must hit
  // the worker's own directory, not the opener document's.
  const base = location.href || null;
  for (const u of urls) {
    let url = String(u);
    if (base) { try { url = new globalThis.URL(url, base).href; } catch (_) {} }
    // The script resource map: a URL already imported by THIS worker is re-run from
    // the map, never re-fetched — and BEFORE any interception: the spec consults the
    // map before a fetch exists, so a controlled worker's repeat import must not
    // fire a fetch event at its SW (import-scripts-resource-map).
    const rmap = globalThis.__csimImportedScripts || (globalThis.__csimImportedScripts = new Map());
    if (rmap.has(url)) {
      const cached = rmap.get(url);
      if (typeof globalThis.__csim_workerImportEval === 'function') globalThis.__csim_workerImportEval(cached);
      else (0, eval)(cached);
      continue;
    }
    let resp = null;
    // A `data:` import is decoded in-realm (RFC 2397) — there is no server to ask
    // and no fetch event fires. Percent-decode BEFORE the forgiving-base64 (a
    // percent-encoded `%3D` padding is legal); a mediatype-less URL defaults to
    // text/plain, which the JS-MIME gate below then rejects, as real browsers do.
    if (/^data:/i.test(url)) {
      const comma = url.indexOf(',');
      if (comma < 0) throw new globalThis.DOMException("Failed to execute 'importScripts' on 'WorkerGlobalScope': The script at '" + url + "' failed to load.", 'NetworkError');
      const meta = url.slice(5, comma);
      let bodyText;
      try {
        const payload = decodeURIComponent(url.slice(comma + 1));
        bodyText = /;base64\s*$/i.test(meta) ? globalThis.__csimAtob(payload) : payload;
      } catch (_) {
        throw new globalThis.DOMException("Failed to execute 'importScripts' on 'WorkerGlobalScope': The script at '" + url + "' failed to load.", 'NetworkError');
      }
      resp = {status: 200, headers: {'content-type': meta.split(';')[0] || 'text/plain'}, body: bodyText};
    }
    // A version spawned by a registration UPDATE runs from the Update probe's
    // responses — its script resource map — not fresh fetches: the 404 the
    // byte-check saw must be the 404 this importScripts sees (one-shot per URL).
    if (!resp && globalThis.__csimSwImportMap && globalThis.__csimSwImportMap[url]) {
      resp = globalThis.__csimSwImportMap[url];
      delete globalThis.__csimSwImportMap[url];
    }
    // A CONTROLLED worker's import routes through its SW's fetch event —
    // synchronously, on this worker's own thread (the safe direction; only a
    // main-thread wait deadlocks). null falls through to the network; a blocked
    // reply (network error / a type same-origin mode forbids) is a NetworkError.
    const ctrl = (typeof globalThis.__csimSWControllerHandle === 'function') ? globalThis.__csimSWControllerHandle() : 0;
    if (!resp && ctrl) {
      const r = globalThis.__csim_swImportFetch(ctrl, url, globalThis.__csimWorkerHandle | 0);
      if (r && r.blocked) {
        throw new globalThis.DOMException("Failed to execute 'importScripts' on 'WorkerGlobalScope': The script at '" + url + "' failed to load.", 'NetworkError');
      }
      if (r) resp = r;
    }
    // A SERVICE worker's imports honor the registration's updateViaCache mode
    // ('none' revalidates every import; 'imports'/'all' — the default here — read
    // the HTTP cache, which is what keeps an unchanged import byte-identical across
    // an update). Other worker kinds keep the plain default.
    const swCache = workerKind === 'service' && globalThis.__csimSwUvc === 'none' ? 'no-cache' : undefined;
    resp = resp || globalThis.__rackFetch('GET', url, '', null, 'follow', null, null, null, null, swCache);
    if (!resp || resp.status >= 400) throw new Error('importScripts: HTTP ' + (resp && resp.status) + ' for ' + url);
    // Per "fetch a classic worker-imported script": the response's Content-Type essence must be a
    // JavaScript MIME type, otherwise importScripts throws a NetworkError (import-scripts-mime-types).
    // ENFORCED ONLY in the universal-server (WPT) context: a real app's asset pipeline may serve a
    // bundle with a non-JS Content-Type (a serving concern independent of this contract), and breaking
    // a worker import there — e.g. Mastodon's Tesseract worker.min.js — is a regression the app suites
    // (not run in this repo) would catch. WPT's static handler serves `.js` as `text/javascript`, so
    // testharness / dispatcher imports pass; a route serving text/plain or no type is rejected.
    if (globalThis.__csim_allHostsLocal && globalThis.__csim_allHostsLocal()) {
      let ct = '';
      if (resp.headers) for (const k in resp.headers) { if (k.toLowerCase() === 'content-type') { ct = resp.headers[k]; break; } }
      const essence = String(ct || '').split(';')[0].trim().toLowerCase();
      if (!JS_MIME_ESSENCES.has(essence)) {
        throw new globalThis.DOMException("Failed to execute 'importScripts' on 'WorkerGlobalScope': The script at '" + url + "' failed to load.", 'NetworkError');
      }
    }
    // Record a SERVICE worker's import (URL → bytes) on its host registry entry: the
    // Update algorithm byte-checks imports when the main script came back identical
    // (update-bytecheck / registration-updateviacache 'none').
    if (workerKind === 'service') {
      try { globalThis.__csim_swNoteImport(globalThis.__csimWorkerHandle | 0, url, resp.body); } catch (_) {}
    }
    const src = resp.body + '\n//# sourceURL=' + url;
    // Record in the script resource map BEFORE evaluating: a re-import from inside
    // the script itself must already find it.
    rmap.set(url, src);
    // Run at TOP-LEVEL script scope so the script's top-level const/let/class join
    // the worker's shared global lexical env (dispatcher.js's `const send`/`receive`
    // must be visible to later code). `(0, eval)` would block-scope them away.
    if (typeof globalThis.__csim_workerImportEval === 'function') globalThis.__csim_workerImportEval(src);
    else (0, eval)(src);
  }
}

// The worker's postMessage, to its owner (the main thread) — a dedicated worker's global's (worker-globals.js).
export function postToOwner(data, transferList) {
  globalThis.__csim_workerPostMessage(encodeMessage(data, transferList, true));
}
// `self.close()` — a worker shuts itself down. The currently-running script still runs to completion (so a
// `close(); …; postMessage(x)` sequence still delivers x), but the host loop stops pulling further messages once it
// sees the flag.
export function closeWorker() { globalThis.__csimWorkerClosed = true; }
// A service worker's scope state, which its ServiceWorkerGlobalScope members answer (worker-globals.js): its clients, its
// registration and the ServiceWorker it is, set up as its scope is (`__csim_installServiceWorkerScope`) — the last two
// made, and moved along its lifecycle, by sw-client.js (the hook `__csimServiceWorkerObjects`, which imports this module).
export const swScope = { clients: null, registration: null, serviceWorker: null };

// The init of an event the platform makes, its arguments already what a conversion would give: Event's members, and
// `members` its own.
const platformInit = (members) => ({ bubbles: false, cancelable: false, composed: false, ...members });
// A `message` event on the SW global — an ExtendableMessageEvent, NOT a plain MessageEvent: SW message handlers may
// `event.waitUntil(...)`. Its data as it is, a postMessage(undefined)'s too.
function deliverMessage(m, source, origin) {
  const ev = new ExtendableMessageEvent(CONVERTED, messageEventType(m), platformInit({ data: m.data, origin, lastEventId: '', source, ports: m.ports }));
  dispatchExtendable(ev);
  // An unsettled `event.waitUntil(...)` EXTENDS this worker's lifetime: while any are
  // pending, an installed successor must keep waiting — even past skipWaiting —
  // until they settle (activation.https: the in-flight 'wait' request holds the new
  // version in `waiting`; 'go' releases it). Tracked as a counter whose transitions
  // ride to the host (run_worker's `extended` hook → try-activate on reaching 0).
  if (ev._extendLifetimePromises.length) {
    globalThis.__csimSwPendingExts = (globalThis.__csimSwPendingExts | 0) + 1;
    try { globalThis.__csim_swExtendedChanged(globalThis.__csimSwPendingExts); } catch (_) {}
    promiseThen.call(extensionsSettled(ev), () => {
      globalThis.__csimSwPendingExts = (globalThis.__csimSwPendingExts | 0) - 1;
      try { globalThis.__csim_swExtendedChanged(globalThis.__csimSwPendingExts); } catch (_) {}
    });
  }
}
// …and a message the worker posted to itself (`self.serviceWorker.postMessage`, sw-client.js): its source its own
// ServiceWorker, its origin its own.
export function deliverSelfMessage(dataStr) {
  deliverMessage(decodeMessage(dataStr), swScope.serviceWorker, location.origin);
}

// `skipWaiting()` lets an installed worker activate without waiting for the outgoing one to lose its controllees. The
// waiting slot lives on the CLIENT side (per-realm registration objects), so the request rides the outbox like claim()
// — fire-and-forget: the spec's promise resolves once the request is made, not once activation happens.
export function skipWaiting() {
  try { globalThis.__csim_swSkipWaitingRequest(); } catch (_) {}
  return Promise.resolve();
}

// The worker this realm is, latched as its scope is installed, out of a page's reach: its KIND — 'dedicated', 'shared'
// or 'service' — and its name (WorkerOptions'); null in a window's realm.
export let workerKind = null;
// …and whether it is cross-origin isolated — a dedicated or shared worker as its creating window is (worker-globals.js).
export let workerCrossOriginIsolated = false;
export let workerName = '';

// Worker-scope install — called by `V8Runtime.build_worker` after host
// fns are attached, so the worker-scope shape only appears in actual
// worker isolates.
globalThis.__csim_installWorkerScope = function (kind, name, isolated) {
  workerKind = kind;
  workerName = name;
  workerCrossOriginIsolated = isolated === true;
  // (…with no SharedArrayBuffer constructor where not, as a window's realm — bridge.entry.js `__csimInitRealm`)
  if (!workerCrossOriginIsolated) delete globalThis.SharedArrayBuffer;
  globalThis.__csim_isWorker = true;
  // Cross-isolate MessagePort channels route through the worker OUTBOX (a worker thread can't call
  // the browser directly), in place of the window's plumbing message-port.js defines. Channel ids
  // are keyed by this worker's handle so they never collide with another isolate's.
  let __workerPortSeq = 0;
  globalThis.__csimAllocPortChannel = function () { return 'pc-h' + (globalThis.__csimWorkerHandle | 0) + '-' + (++__workerPortSeq); };
  globalThis.__csimPortRemotePost = function (end, dataStr) { globalThis.__csim_workerPortPost(end, dataStr); };
  globalThis.__csimPortEndHere    = function (end) { globalThis.__csim_workerPortEndHere(end); };
  globalThis.__csimPortEndGone    = function (end, held) { globalThis.__csim_workerPortEndGone(end, held); };
  globalThis.__csimPortEndClosed  = function (end) { globalThis.__csim_workerPortEndClosed(end); };
  globalThis.__csimPortRedeliver  = function (end, dataStr) { globalThis.__csim_workerPortRedeliver(end, dataStr); };
  // The worker's global scope (worker-globals.js) — and none of the Window's members, which only a window's realm
  // installs: Emscripten (Tesseract.js's wasm wrapper) tells a worker by `typeof window` + `typeof importScripts`, and a
  // worker-side feature-detect of `open` / `focus` must not find a browsing context's.
  globalThis.__csimInstallWorkerGlobals();
  // The Window's other names for interface objects ([LegacyWindowAlias]) are a Window's only.
  for (const aliases of Object.values(LEGACY_WINDOW_ALIASES)) for (const alias of aliases) delete globalThis[alias];
  // Cheap host-callable reader for the close flag — the worker run-loop polls it
  // each tick via `c.call` (not a string `eval`, which would recompile per tick).
  globalThis.__csimWorkerClosedRead = function () { return !!globalThis.__csimWorkerClosed; };
  // NESTED dedicated workers (`new Worker` INSIDE a dedicated or shared worker — [Exposed=(Window,DedicatedWorker,
  // SharedWorker)], not a service worker's), whose postbacks the host delivers through this isolate's inbox (run_worker
  // `nested_worker_msgs`). Scope-matched http(s) child scripts get their own controller; a scope-less http(s) child is
  // uncontrolled (blob:/data: nested scripts are refused for now — the blob registry lives in the main VM, unreachable
  // from this thread).
  if (kind !== 'service') exposeInterface(Worker);

  // `WebAssembly.instantiate` / `compile` return Promises that V8
  // schedules off its background thread pool — in a per-Worker
  // isolate the pool work never lands back as a resolved Promise
  // (Emscripten / Tesseract's `await TesseractCore(...)` hangs
  // forever at "initializing tesseract"). Route through the
  // synchronous `new WebAssembly.Module` + `new Instance` pair and
  // wrap in a microtask-resolved Promise so the consumer's `then`
  // chain still fires.
  if (typeof globalThis.WebAssembly === 'object') {
    globalThis.WebAssembly.compile = function (bufferSource) {
      return Promise.resolve().then(() => new globalThis.WebAssembly.Module(bufferSource));
    };
    globalThis.WebAssembly.instantiate = function (bufferOrModule, importObject) {
      return Promise.resolve().then(() => {
        if (bufferOrModule instanceof globalThis.WebAssembly.Module) {
          return new globalThis.WebAssembly.Instance(bufferOrModule, importObject);
        }
        const mod  = new globalThis.WebAssembly.Module(bufferOrModule);
        const inst = new globalThis.WebAssembly.Instance(mod, importObject);
        return {module: mod, instance: inst};
      });
    };
  }
};

// ── A service worker's clients and events (Service Workers §4, generated from their IDL) ──
// Made at module level, exposed only in a ServiceWorkerGlobalScope (`__csim_installServiceWorkerScope`).

// Client and WindowClient (§4.2, §4.3) — `event.source` of a `message`, and `clients.matchAll()` entries: a controlled
// window or worker the SW can post back to. `postMessage` routes to the host, which delivers to that client's
// `navigator.serviceWorker` 'message'. A client's slots: its id, URL, type and frame type, and whether THIS worker
// controls it — every same-origin context is mirrored here, because `matchAll({includeUncontrolled: true})` must see
// the ones it doesn't. The set is mirrored from the host (`__csim_swRegisterClient`); `clientFor` only fills in a sender
// the mirror hasn't reached yet, so `event.source` is never missing.
const clientOf = (o) => slotsOf(o, 'Client');
registerInterface('Client', (o) => clientOf(o) !== undefined);
registerInterface('WindowClient', (o) => slotsOf(o, 'WindowClient') !== undefined);
const clientsById = new Map();
// The ids of every client that counts as focused, mirrored from the host (`note_focused_realm`) — a worker isolate
// can't ask the browser, and the answer is cross-realm, so it's pushed on every change. This is the focused context AND
// its ANCESTORS: `focused` follows `document.hasFocus()`, which is true all the way up from the focused frame, so a page
// containing it reports focused too. Empty before any focus.
let focusedClientIds = [];
class Client {
  constructor(token, id, url, type, frameType, controlled) {
    constructedBy(PLATFORM, token, 'Client');
    makeSlots(this, 'Client', { id: String(id), url: url || '', type: type || 'window', frameType: frameType || 'top-level', controlled: !!controlled });
  }
}
// (…an uncloneable message, or a bad transfer list, the caller's DataCloneError — not a `null` delivered)
function postToClient(client, message, transfer) {
  const payload = encodeMessage(message, transfer);
  try { globalThis.__csim_swPostToClient(clientOf(client).id, payload); } catch (_) {}
}
installClient(Client, {
  get_url: (client) => clientOf(client).url,
  get_frameType: (client) => clientOf(client).frameType,
  get_id: (client) => clientOf(client).id,
  get_type: (client) => clientOf(client).type,
  postMessage_message_transfer: (client, message, transfer) => postToClient(client, message, transfer),
  postMessage_message_options: (client, message, options) => postToClient(client, message, options.transfer)
});
// A client that is a window (rather than a worker) also exposes its visibility and focus, and can be navigated.
class WindowClient extends Client {
  constructor(token, id, url, type, frameType, controlled) {
    super(token, id, url, type, frameType, controlled);
    makeSlots(this, 'WindowClient');
  }
}
// In-flight WindowClient.navigate() calls, keyed by the id carried on the outbox request and echoed back on the reply.
const pendingNavigations = new Map();
let navSeq = 0;
installWindowClient(WindowClient, {
  // Every browsing context this driver runs is on screen — there is no minimized window, no background tab, and no way
  // to hide a document — so a window client is `visible`.
  get_visibilityState: () => 'visible',
  get_focused: (client) => focusedClientIds.includes(clientOf(client).id),
  // A window is focused only on a user's activation — a notification click — which nothing here ever gives a service
  // worker: an InvalidAccessError, as openWindow's (§4.3.4).
  focus: () => rejectedPromise(new DOMException('Not allowed to focus a window.', 'InvalidAccessError')),
  // Navigate the client's browsing context. The answer depends on where the navigation ENDED — the URL after redirects,
  // and whether that is still same-origin — so this is a round trip: the request rides the outbox, the host performs the
  // navigation, and its reply settles the promise (__csim_swClientNavigateResult).
  navigate(client, url) {
    let parsed;
    // "Parse url with this's associated service worker's script url as base"; a URL that doesn't parse rejects with
    // TypeError.
    try { parsed = new globalThis.URL(url, location.href || undefined); } catch (_) {
      return rejectedPromise(new TypeError('Failed to parse URL: ' + url));
    }
    const target = parsed.href;
    // Only an HTTP(S) target may be navigated to. That covers about:blank (a client may not be sent back to its initial
    // document) and every non-fetchable scheme the spec rejects the same way — file:///, view-source://, javascript:,
    // data:.
    if (!/^https?:$/i.test(parsed.protocol)) return rejectedPromise(new TypeError('cannot navigate a client to ' + target));
    // Only a client THIS worker controls may be navigated.
    const c = clientOf(client);
    if (!c.controlled) return rejectedPromise(new TypeError('the client is not controlled by this service worker'));
    const navId = ++navSeq;
    return new IntrinsicPromise((resolve, reject) => {
      pendingNavigations.set(navId, { resolve, reject, client });
      try { globalThis.__csim_swNavigateClient(c.id, target, navId); }
      catch (e) { pendingNavigations.delete(navId); reject(new TypeError(String(e && e.message || e))); }
    });
  }
});
function makeClient(id, url, type, frameType, controlled) {
  const Ctor = (type == null || type === 'window') ? WindowClient : Client;
  return new Ctor(PLATFORM, id, url, type, frameType, controlled);
}
// Fill in a client the host registry hasn't reached — the sender of a message, or the originator of a fetch — so
// `event.source` / `clients.get(event.clientId)` are never missing. Neither path carries a client TYPE, so this GUESSES
// `window`, which is what a client reached through a document's fetch or postMessage almost always is; a worker client
// is reported as a window until a host registration refines it. That guess is load-bearing for `matchAll`'s type
// filter, so it stays a guess in one place only. `controlled` is NOT guessed: a fetch that reaches this SW came through
// it, but a `registration.active.postMessage()` sender may sit entirely outside our scope — assuming control there
// would put an uncontrolled page into the default `matchAll()`.
function clientFor(id, url, controlled) {
  let client = clientsById.get(String(id));
  if (!client) {
    client = makeClient(id, url, null, null, !!controlled);
    clientsById.set(String(id), client);
  } else if (url && !clientOf(client).url) {
    clientOf(client).url = url;
  }
  return client;
}
// Clients are ORIGIN-scoped: a worker never sees another origin's clients (Service Workers "Query Service Worker Client
// Objects" filters on the service worker's origin — navigation-redirect's cross-origin finals must be invisible to the
// same-origin workers and vice versa). The host mirror broadcasts every client to every worker, so the visibility cut
// is made here. Only a record at a REAL http(s) origin is cut: an about:blank / about:srcdoc client's URL origin
// serializes to "null" but the document INHERITS its creator's origin (about-blank-replacement), and an empty /
// unparseable url (a lazily-guessed postMessage client) has nothing to compare — both stay visible, matching the
// pre-filter behavior those flows relied on.
function sameOriginClient(client) {
  try {
    const url = clientOf(client).url;
    if (!url) return true;
    const u = new globalThis.URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return true;
    return u.origin === (location.origin || u.origin);
  } catch (_) { return true; }
}

// Clients (§4.4) — `self.clients` — made by the platform alone.
registerInterface('Clients', (o) => slotsOf(o, 'Clients') !== undefined);
class Clients {
  constructor(token) {
    constructedBy(PLATFORM, token, 'Clients');
    makeSlots(this, 'Clients');
  }
}
installClients(Clients, {
  get(clients, id) {
    const client = clientsById.get(id);
    return resolvedPromise(client && sameOriginClient(client) ? client : undefined);
  },
  // "Query Service Worker Client Objects": the focused window client comes first, then the rest in CREATION order (the
  // Map's insertion order — the host registers each realm as it is built). `options` is a ClientQueryOptions the
  // bindings converted: `type` "window" by default, "all" keeping workers too; `includeUncontrolled` false by default,
  // which is why the mirror carries every same-origin context with a `controlled` flag rather than only the ones this
  // worker controls. More than one client can be focused — the focused frame and every ancestor — so focus is a stable
  // partition, not a single winner moved to the front.
  matchAll(clients, options) {
    const matched = Array.from(clientsById.values()).filter((client) => {
      const c = clientOf(client);
      return sameOriginClient(client) && (options.includeUncontrolled || c.controlled) && (options.type === 'all' || c.type === options.type);
    });
    const focused = matched.filter((client) => focusedClientIds.includes(clientOf(client).id));
    return resolvedPromise(Object.freeze(focused.concat(matched.filter((client) => !focused.includes(client)))));
  },
  // A window is opened only on a user's activation — a notification click — which nothing here ever gives a service
  // worker: after its URL is checked (a TypeError where it parses as none, or is about:blank), an InvalidAccessError.
  openWindow(clients, url) {
    let parsed;
    try { parsed = new globalThis.URL(url, location.href || undefined); } catch (_) {
      return rejectedPromise(new TypeError('Failed to parse URL: ' + url));
    }
    if (parsed.href === 'about:blank') return rejectedPromise(new TypeError('Cannot open about:blank.'));
    return rejectedPromise(new DOMException('Not allowed to open a window.', 'InvalidAccessError'));
  },
  // Makes this active worker the controller of its in-scope clients: their fetches route through this SW. The host sets
  // each client's navigator.serviceWorker.controller.
  claim() {
    try { globalThis.__csim_swClaim(); } catch (_) {}
    return resolvedPromise(undefined);
  }
});

// ExtendableEvent (§4.5) — an `install` / `activate` event whose `waitUntil(promise)` extends the lifetime of its
// lifecycle step (and of the worker: the host drains the promises before advancing it). Its fields: its lifetime
// promises and how many are pending — it is active while one is, or while it is dispatched, and `waitUntil` refuses one
// that is not, or that no browser dispatched.
class ExtendableEvent extends Event {
  constructor(type, init) {
    if (type !== CONVERTED) [type, init] = convertExtendableEventArguments(arguments);
    else [type, init] = [init, arguments[2]];
    super(CONVERTED, type, init);
    this._extendLifetimePromises = [];
    this._pendingPromises = 0;
  }
}
// "Add lifetime promise": `promise` among the event's, pending until a microtask after it settles.
function addLifetimePromise(ev, promise) {
  ev._extendLifetimePromises.push(promise);
  ev._pendingPromises++;
  const settled = () => promiseThen.call(resolvedPromise(), () => { ev._pendingPromises--; });
  promiseThen.call(promise, settled, settled);
}
// The platform's dispatch of an extendable event at the worker's global: active through its handlers and the microtask
// checkpoint after each (HTML's "clean up after running script" — a handler's microtasks, however deep they chain, may
// still `waitUntil` / `respondWith`), not from a later task.
const dispatchExtendable = (ev) => fireWithCheckpoints(globalThis, ev);
// A promise of whether every lifetime promise of `ev` fulfilled, once all have settled — those added while others were
// pending too, the event being active while one is (§4.5.1): the wait is over when its pending promises count is zero.
function extensionsSettled(ev) {
  const promises = ev._extendLifetimePromises;
  let ok = true;
  let seen = 0;
  // (…the promises added since the last round, each settled)
  const round = () => new IntrinsicPromise((resolve) => {
    const batch = promises.slice(seen);
    seen = promises.length;
    let left = batch.length;
    const settled = () => { if (--left === 0) resolve(); };
    for (const p of batch) promiseThen.call(p, settled, () => { ok = false; settled(); });
  });
  const wait = () => (seen === promises.length ? resolvedPromise(ok) : promiseThenChained(round(), wait));
  return wait();
}
installExtendableEvent(ExtendableEvent, {
  waitUntil(ev, promise) {
    if (!ev._isTrusted) throw new DOMException("Failed to execute 'waitUntil' on 'ExtendableEvent': The event handler is untrusted.", 'InvalidStateError');
    if (!ev._dispatchFlag && ev._pendingPromises === 0) {
      throw new DOMException("Failed to execute 'waitUntil' on 'ExtendableEvent': The event handler is already finished.", 'InvalidStateError');
    }
    addLifetimePromise(ev, promise);
  }
});

// ExtendableMessageEvent (§4.6) — the `message` event a ServiceWorkerGlobalScope receives: the MessageEvent surface
// (data / origin / source / ports / lastEventId) on an EXTENDABLE event. A plain MessageEvent here made
// `event.waitUntil(...)` throw BEFORE the handler's reply was posted — the get-resultingClientId worker parks
// `event.waitUntil(testFinishPromise)` across a whole test, and its 'ok' reply never left (clients-get-resultingClientId
// TIMEOUT). waitUntil only extends the worker's lifetime — the message ACK stays dispatch-synchronous (run_worker),
// which matches "extended lifetime" semantics. Its `ports` a FrozenArray, the same object at every read.
class ExtendableMessageEvent extends ExtendableEvent {
  constructor(type, init) {
    if (type !== CONVERTED) [type, init] = convertExtendableMessageEventArguments(arguments);
    else [type, init] = [init, arguments[2]];
    super(CONVERTED, type, init);
    this._data        = init.data;
    this._origin      = init.origin;
    this._lastEventId = init.lastEventId;
    this._source      = init.source;
    this._ports       = Object.freeze(init.ports.slice());
  }
}
installExtendableMessageEvent(ExtendableMessageEvent, {
  get_data: (ev) => ev._data,
  get_origin: (ev) => ev._origin,
  get_lastEventId: (ev) => ev._lastEventId,
  get_source: (ev) => ev._source,
  get_ports: (ev) => ev._ports
});

// FetchEvent (§4.7) — dispatched for a controlled client's request. `respondWith(r)` supplies the Response (or a
// Promise of one); if no handler calls it, the request falls through to network. Its fields: what its init gave, the
// respondWith state, and the outcome `handled` settles with.
class FetchEvent extends ExtendableEvent {
  constructor(type, init) {
    if (type !== CONVERTED) [type, init] = convertFetchEventArguments(arguments);
    else [type, init] = [init, arguments[2]];
    super(CONVERTED, type, init);
    this._request           = init.request;
    this._clientId          = init.clientId;
    this._resultingClientId = init.resultingClientId;
    this._replacesClientId  = init.replacesClientId;
    // Navigation Preload: the browser-issued preload Response when the controlling registration had preload enabled,
    // else undefined (the default). A SW serves it via `respondWith(event.preloadResponse)`.
    this._preloadResponse   = init.preloadResponse ?? resolvedPromise(undefined);
    this._responded         = false;
    this._responsePromise   = null;
    // `handled` — a promise that resolves once the event is handled with a valid response (or falls through to
    // network) and rejects with a TypeError on a network-error outcome (uncalled+canceled, a rejected respondWith, or a
    // non-Response result). The outcome is recorded by settleHandled at the same point the dispatch decides the wire
    // result; the promise itself is made at the first `handled` read (almost no SW reads it, so eager creation would
    // allocate a promise + closures per intercepted fetch for nothing). Fields are declared here so every FetchEvent
    // shares one hidden class.
    this._handledPromise    = null;
    this._handledResolve    = null;
    this._handledReject     = null;
    this._handledSettled    = false;
    this._handledOk         = false;
    this._handledErr        = null;
  }
}
// Record a fetch event's final outcome (idempotent at the wire level via the dispatch `finish` guard), and settle its
// `handled` promise if a read already made it.
function settleHandled(ev, ok, err) {
  ev._handledSettled = true;
  ev._handledOk      = ok;
  ev._handledErr     = err;
  if (ev._handledResolve) ok ? ev._handledResolve() : ev._handledReject(err);
}
installFetchEvent(FetchEvent, {
  get_request: (ev) => ev._request,
  get_preloadResponse: (ev) => ev._preloadResponse,
  get_clientId: (ev) => ev._clientId,
  get_resultingClientId: (ev) => ev._resultingClientId,
  get_replacesClientId: (ev) => ev._replacesClientId,
  get_handled(ev) {
    if (!ev._handledPromise) {
      ev._handledPromise = new IntrinsicPromise((resolve, reject) => {
        ev._handledResolve = resolve;
        ev._handledReject  = reject;
      });
      // (…a SW that reads `handled` but ignores its rejection reports none unhandled)
      promiseThen.call(ev._handledPromise, undefined, () => {});
      // A read after the outcome was already recorded replays it onto the fresh promise.
      if (ev._handledSettled) ev._handledOk ? ev._handledResolve() : ev._handledReject(ev._handledErr);
    }
    return ev._handledPromise;
  },
  // Valid only DURING dispatch — a script's, or the platform's (`dispatchExtendable`): after it finished, an
  // InvalidStateError — as is a second call. (FetchEvent "respond with" checks the dispatch and respond-with flags.) The
  // response is one of the event's lifetime promises, and it sets the event's stop-propagation and
  // stop-immediate-propagation flags, so no later `fetch` listener runs once one has responded.
  respondWith(ev, promise) {
    if (!ev._dispatchFlag) throw new DOMException('respondWith called outside the fetch event dispatch', 'InvalidStateError');
    if (ev._responded) throw new DOMException('respondWith called twice', 'InvalidStateError');
    addLifetimePromise(ev, promise);
    ev._responded = true;
    ev._responsePromise = promise;
    ev._propagationStopped = ev._immediatePropagationStopped = true;
  }
});

// InstallEvent (§4.8) — the install event, whose `addRoutes` (the Static Routing API) is its only member beyond
// ExtendableEvent's. Validation is synchronous; the promise carries the outcome (the WPT worker awaits and records the
// rejection).
class InstallEvent extends ExtendableEvent {
  constructor(type, init) {
    if (type !== CONVERTED) [type, init] = convertInstallEventArguments(arguments);
    else [type, init] = [init, arguments[2]];
    super(CONVERTED, type, init);
  }
}
installInstallEvent(InstallEvent, {
  addRoutes(ev, rules) {
    globalThis.__csim_swAddRoutes(Array.isArray(rules) ? rules : [rules]);
    return resolvedPromise(undefined);
  }
});
for (const iface of [ExtendableEvent, ExtendableMessageEvent, FetchEvent, InstallEvent]) {
  registerInterface(iface.name, eventTest(brandPrototype(iface, iface.name)));
}

// Adjust a worker scope into a ServiceWorkerGlobalScope (run AFTER
// __csim_installWorkerScope, by run_worker for a service worker). A SW scope adds
// the real SW surface: lifecycle events (install/activate ExtendableEvents fired by
// the host after the script's initial run), the Clients API (clients.claim routes
// the controlled client's fetches here; client.postMessage crosses back to its
// navigator.serviceWorker), and FetchEvent dispatch with respondWith (see
// __csim_swDispatchFetch). It deliberately does NOT expose blob-URL minting —
// `URL` in a SW has no create/revokeObjectURL (cross-partition.https asserts
// `'revokeObjectURL' in URL` is false in a SW).
globalThis.__csim_installServiceWorkerScope = function () {
  const drop = (o, k) => { try { delete o[k]; } catch (_) { try { o[k] = undefined; } catch (__) {} } };
  drop(globalThis.URL, 'createObjectURL');
  drop(globalThis.URL, 'revokeObjectURL');
  // XMLHttpRequest — its event target and upload too — is exposed on
  // Dedicated/SharedWorkerGlobalScope but NOT on ServiceWorkerGlobalScope (a SW uses
  // fetch()) — interface-requirements-sw "xhr is not exposed".
  for (const name of ['XMLHttpRequest', 'XMLHttpRequestUpload', 'XMLHttpRequestEventTarget']) drop(globalThis, name);

  // The interfaces of a service worker's clients and events (above), exposed in its scope alone: code brand-checks
  // against them — clients-get-worker.js filters its results with `client instanceof Client`, which throws a bare
  // ReferenceError, hanging the whole waitUntil, if the name is missing.
  for (const iface of [Client, WindowClient, Clients, ExtendableEvent, ExtendableMessageEvent, FetchEvent, InstallEvent]) {
    exposeInterface(iface);
  }
  swScope.clients = new Clients(PLATFORM);
  // Host reply for a navigate(): `url` is where the client ended up, or '' when the result is
  // CROSS-ORIGIN (the spec resolves with null rather than handing back a client we may not see).
  // `error` non-empty means the navigation was refused — mixed content, a failed load — which is
  // a TypeError rejection.
  //
  // `clientId` is the context's id AFTER the navigation. It can differ from the one navigate() was
  // called on, because a navigation rebuilds the realm the id is derived from; resolving with the
  // stale object would hand back a client whose postMessage goes nowhere and whose focus() aims at
  // a discarded realm. The host has already registered the new id (the realm reports itself as it
  // loads, and the inbox is FIFO), so prefer the registry entry.
  globalThis.__csim_swClientNavigateResult = function (navId, url, clientId, error) {
    const pending = pendingNavigations.get(navId | 0);
    if (!pending) return;
    pendingNavigations.delete(navId | 0);
    if (error) return pending.reject(new TypeError(String(error)));
    if (!url) return pending.resolve(null);
    let client = pending.client;
    if (clientId && String(clientId) !== clientOf(client).id) {
      client = clientsById.get(String(clientId)) || makeClient(clientId, url, 'window', clientOf(client).frameType, true);
      clientsById.set(String(clientId), client);
    }
    clientOf(client).url = String(url);
    pending.resolve(client);
  };

  // The host answered a `self.registration.unregister()` with the had-status —
  // resolve the oldest parked promise (FIFO: replies ride the inbox in request order).
  globalThis.__csim_swUnregisterResult = function (ok) {
    const w = globalThis.__csimSwUnregisterWaiters;
    const resolve = w && w.shift();
    if (resolve) resolve(!!ok);
  };

  // Host-driven Client registry: the browser mirrors every controlled client
  // (frame / window realm) here — with its url / type / frameType — so matchAll and
  // getClientByURL reflect the REAL client set, not only clients that happened to
  // postMessage this worker. A re-registration (same id) refreshes the record.
  globalThis.__csim_swRegisterClient = function (rec) {
    if (!rec || rec.id == null) return;
    clientsById.set(String(rec.id), makeClient(rec.id, rec.url, rec.type, rec.frameType, rec.controlled));
  };

  globalThis.__csim_swUnregisterClient = function (id) {
    clientsById.delete(String(id));
  };

  globalThis.__csim_swNoteFocusedClient = function (ids) {
    focusedClientIds = Array.isArray(ids) ? ids.map(String) : (ids == null ? [] : [String(ids)]);
  };


  // Whether this SW has a `fetch` handler — an `addEventListener('fetch', …)` listener OR the
  // `onfetch` event-handler property (a bare `onfetch = fn`, which fires via fireWindowOnHandler at
  // dispatch but is NOT in `_listeners`). Snapshotted by the host after the script's initial run —
  // matching the spec, which records the fetch-handler presence at install time; a listener added
  // later is ignored (Chrome warns and does the same). Lets the client skip the cross-isolate
  // dispatch entirely for messaging/push-only service workers.
  globalThis.__csim_swHasFetchListener = function () {
    const l = globalThis._listeners;
    return !!((l && l.fetch && l.fetch.length) || typeof globalThis.onfetch === 'function');
  };

  // ── ServiceWorker Static Routing API ───────────────────────────────────────
  // `InstallEvent.addRoutes(rules)`: rules are validated + canonicalized HERE, at
  // registration time, and kept IN THIS ISOLATE (live URLPattern objects — their
  // ignoreCase flag has no reflection surface, so serializing them out would lose
  // it). Handle Fetch consults them at the top of __csim_swDispatchFetch: the
  // routing decision happens where every controlled request already arrives, so
  // no host-side rule mirror is needed — the host only learns THAT rules exist
  // (__csim_swNoteRouterRules), which keeps a fetch-handler-less router SW
  // dispatchable (static-router-no-fetch-handler).
  const ROUTER_MAX_RULES           = 1024;
  const ROUTER_MAX_CONDITION_DEPTH = 10;
  // (…a URLPatternCompatible the bindings converted: a URLPattern, a string, or a URLPatternInit — the SW script's URL
  // its default baseURL, "build a URLPattern from a URLPatternCompatible", an explicit member winning)
  const routerBuildPattern = raw => {
    const base = location.href || undefined;
    let pattern;
    // (…the realm's polyfill, not a `URLPattern` a page put in its place)
    const URLPattern = globalThis.__csimVendor.URLPattern;
    if (typeof raw === 'string') pattern = new URLPattern(raw, base);
    else if (interfaceCheck('URLPattern')(raw)) pattern = raw;
    else pattern = new URLPattern(Object.assign({ baseURL: base }, raw));
    // Spec "verify a router condition": a pattern with regexp groups is rejected
    // (its exec cost is unbounded for a per-request static route).
    if (pattern.hasRegExpGroups) throw new globalThis.TypeError('addRoutes: urlPattern with regexp groups is not allowed');
    return pattern;
  };
  // (…a ByteString the bindings converted: a Fetch "method" token, then not a forbidden one, normalized where known)
  const routerNormalizeMethod = s => {
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(s)) throw new globalThis.TypeError('addRoutes: requestMethod is not a valid HTTP method');
    if (/^(CONNECT|TRACE|TRACK)$/i.test(s)) throw new globalThis.TypeError('addRoutes: requestMethod is a forbidden method');
    return /^(DELETE|GET|HEAD|OPTIONS|POST|PUT)$/i.test(s) ? s.toUpperCase() : s;
  };
  // (…a RouterCondition the bindings converted, its members the spec's "verify a router condition" checks: the depth, at
  // least one member, `or` and `not` exclusive of every other)
  const routerParseCondition = (c, depth) => {
    if (depth > ROUTER_MAX_CONDITION_DEPTH) throw new globalThis.TypeError('addRoutes: condition exceeds the depth limit');
    const out = {};
    let members = 0;
    if (c.or !== undefined) { out.or = c.or.map(x => routerParseCondition(x, depth + 1)); members++; }
    if (c.not !== undefined) { out.not = routerParseCondition(c.not, depth + 1); members++; }
    if (c.urlPattern !== undefined)         { out.urlPattern = routerBuildPattern(c.urlPattern); members++; }
    if (c.requestMethod !== undefined)      { out.requestMethod = routerNormalizeMethod(c.requestMethod); members++; }
    if (c.requestMode !== undefined)        { out.requestMode = c.requestMode; members++; }
    if (c.requestDestination !== undefined) { out.requestDestination = c.requestDestination; members++; }
    if (c.runningStatus !== undefined)      { out.runningStatus = c.runningStatus; members++; }
    if (members === 0) throw new globalThis.TypeError('addRoutes: condition has no members');
    // `or` (and `not`) is exclusive of every other member per the spec's verify step.
    if ((out.or || out.not) && members > 1) throw new globalThis.TypeError('addRoutes: or/not cannot be combined with other conditions');
    return out;
  };
  // (…a RouterSourceEnum, or a RouterSourceDict naming its cache)
  const routerParseSource = s => {
    if (typeof s === 'string') return s;
    if (s.cacheName !== undefined) return { cacheName: s.cacheName };
    throw new globalThis.TypeError('addRoutes: invalid source');
  };
  // InstallEvent's addRoutes, of its rules the bindings converted.
  globalThis.__csim_swAddRoutes = function (rules) {
    const parsed = rules.map(rule => {
      const source = routerParseSource(rule.source);
      if ((source === 'fetch-event' || source === 'race-network-and-fetch-handler') && !globalThis.__csim_swHasFetchListener()) {
        throw new globalThis.TypeError('addRoutes: the ' + source + ' source requires a fetch event handler');
      }
      return { condition: routerParseCondition(rule.condition, 1), source };
    });
    const rulesStore = globalThis.__csimSwRouterRules || (globalThis.__csimSwRouterRules = []);
    if (rulesStore.length + parsed.length > ROUTER_MAX_RULES) {
      throw new globalThis.TypeError('addRoutes: the number of router rules exceeds the limit');
    }
    rulesStore.push(...parsed);
    // The host's dispatch gates (navigation routing, claim has_fetch, controller
    // minting) must treat this worker as interception-worthy even with no fetch
    // handler — the router alone can serve network/cache sources.
    try { globalThis.__csim_swNoteRouterRules(); } catch (_) {}
  };
  const routerMatchCondition = (cond, req) => {
    if (cond.or)  return cond.or.some(c => routerMatchCondition(c, req));
    if (cond.not) return !routerMatchCondition(cond.not, req);
    if (cond.urlPattern && !cond.urlPattern.test(req.url)) return false;
    if (cond.requestMethod !== undefined && req.method !== cond.requestMethod) return false;
    if (cond.requestMode !== undefined && req.mode !== cond.requestMode) return false;
    if (cond.requestDestination !== undefined && req.destination !== cond.requestDestination) return false;
    // This worker is, by construction, running when it evaluates its own rules.
    if (cond.runningStatus !== undefined && cond.runningStatus !== 'running') return false;
    return true;
  };
  // The first matching rule's source, or null (→ the normal fetch-event dispatch).
  const routerMatchSource = req => {
    const rules = globalThis.__csimSwRouterRules;
    if (!rules || !rules.length || !req) return null;
    for (const rule of rules) {
      try { if (routerMatchCondition(rule.condition, req)) return rule.source; } catch (_) {}
    }
    return null;
  };
  // Readers of in-flight streaming respondWith bodies, keyed by (per-realm) fetch id — so a client
  // that cancels its response body (host-routed to __csim_swStreamCancel) cancels the reader here,
  // firing the source stream's `cancel()` (readable-stream cancel/abort observability).
  const swStreamReaders = new Map();
  globalThis.__csim_swStreamCancel = function (fetchId) {
    const r = swStreamReaders.get(fetchId | 0);
    if (!r) return;
    swStreamReaders.delete(fetchId | 0);
    try { r.cancel(); } catch (_) {}
  };

  // Dispatch a `fetch` event for a controlled client's request (host-driven from run_worker).
  // Posts the respondWith Response back (or a fall-through / network-error marker) via the host.
  globalThis.__csim_swDispatchFetch = function (reqJson, fetchId, realmId) {
    let req, reqReferrer = '', preloadResponse, preloadWire = null;
    let wireClientId = '', navResultingId = '';
    try {
      const r = JSON.parse(reqJson);
      // The FETCHING client's own id (an adopted reserved id — sw-client.js
      // buildSwRequest), and — for a NAVIGATION — the RESERVED client id the chain
      // minted for the document it will create (service_worker_navigation_fetch).
      wireClientId   = r.clientId          || '';
      navResultingId = r.resultingClientId || '';
      reqReferrer = r.referrer || '';
      preloadWire = r.preloadResponse || null;   // rebuilt into event.preloadResponse below
      const init = {method: r.method, headers: r.headers};
      if (r.body_b64 && r.method !== 'GET' && r.method !== 'HEAD') init.body = globalThis.Uint8Array.fromBase64(r.body_b64);
      req = new Request(r.url, init);
      const rs = requestOf(req);
      // A navigation request carries mode 'navigate' (+ destination / reload / history flags)
      // that the public Request ctor rejects — set its slots directly so the SW's
      // handler sees `event.request.mode === 'navigate'`. A subresource request reflects the
      // client's redirect / mode / credentials / cache / integrity / referrer so the SW's
      // `event.request.*` matches what a real browser hands its fetch handler.
      if (r.mode === 'navigate')      rs.mode = 'navigate';
      else if (r.mode)                rs.mode = r.mode;
      if (r.destination)              rs.destination = r.destination;
      if (r.isReloadNavigation)       rs.isReloadNavigation = true;
      if (r.isHistoryNavigation)      rs.isHistoryNavigation = true;
      if (r.redirect)                 rs.redirect = r.redirect;
      if (r.credentials)              rs.credentials = r.credentials;
      if (r.cache)                    rs.cache = r.cache;
      if (r.keepalive)                rs.keepalive = true;
      if (r.integrity)                rs.integrity = r.integrity;
      if (r.referrerPolicy)           rs.referrerPolicy = r.referrerPolicy;
      if (r.referrer != null)         rs.referrer = r.referrer;
      // A NAVIGATION carries its initiator origin (the navigating frame's) + the redirect chain's
      // latched Sec-Fetch-Site seed / Origin taint, so a passthrough `fetch(event.request)` re-fetch
      // reports the frame's Origin / Sec-Fetch-Site to the server (a `new Request(event.request,init)`
      // re-fetch resets them to this SW's own origin — see the Request constructor).
      if (r.initiator != null)        rs.initiator = r.initiator;
      if (r.siteSeed != null)         rs.siteSeed = r.siteSeed;
      if (r.originNull)               rs.originNull = true;
      // The ancestor-chain cookie verdict of the frame this navigation commits into
      // (RFC 6265bis site-for-cookies): a property of the TARGET FRAME, so unlike the
      // initiator it survives `new Request(event.request, init)` (see the Request ctor).
      if (r.cookieCrossSite)          rs.cookieCrossSite = true;
      // A navigation request's default credentials mode is 'include' (Fetch "create navigation
      // request") — reflect it on the SW-visible request when the wire didn't specify. The nav
      // redirect mode 'manual' rides the wire (service_worker_navigation_fetch): a passthrough
      // `fetch(event.request)` of a redirecting URL yields an opaqueredirect, which the
      // navigation consuming the respondWith FOLLOWS (the private redirect_loc channel).
      if (rs.mode === 'navigate' && !r.credentials) rs.credentials = 'include';
      // Handle Fetch hands the SW a request whose header list is IMMUTABLE — an
      // `event.request.headers.append(...)` throws (request-end-to-end); a SW that wants
      // modified headers builds `new Request(event.request, {headers})`, whose copy gets
      // the mutable 'request' guard as usual.
      setHeadersGuard(rs.headers, 'immutable');
    } catch (_) { req = null; }
    // clientId = the client that MADE the request; resultingClientId = the client the request
    // CREATES. A navigation has no initiating client (clientId '') but reserves the resulting
    // client (the document it will load); a subresource is the reverse — its client made it, and it
    // creates none (resultingClientId ''). The client is keyed by the ORIGINATING realm
    // (`client-<realm>`, matching sw-client.js clientId() + the browser registry); the main/top realm
    // ── Static Routing API: the registered router rules are evaluated BEFORE any
    // fetch event exists (Handle Fetch's router evaluation precedes the event
    // dispatch — a 'network'-routed request must never run the fetch handler).
    const routerSource = routerMatchSource(req);
    // 'race-network-and-fetch-handler': the HOST runs the network leg RIGHT
    // HERE (synchronously, on this worker thread) and holds the result; the
    // fetch event then dispatches as usual and the host decides the winner at
    // respondWith time by comparing the server's modeled delay against the
    // handler's measured dispatch span (sw_race_take_network_win — a ≥400
    // network response records nothing, so the handler wins those by default).
    if (routerSource === 'race-network-and-fetch-handler' && req) {
      try { globalThis.__csim_swRaceNetwork(fetchId, realmId, req.url, req.method); } catch (_) {}
    }
    if (routerSource === 'network') {
      try { globalThis.__csim_swFetchRespond(fetchId, JSON.stringify({ fallthrough: true }), realmId); } catch (_) {}
      return;
    }
    if (routerSource === 'cache' || (routerSource && typeof routerSource === 'object')) {
      const respondWire = json => { try { globalThis.__csim_swFetchRespond(fetchId, json, realmId); } catch (_) {} };
      const lookup = routerSource === 'cache'
        ? globalThis.caches.match(req)
        : globalThis.caches.open(routerSource.cacheName).then(c => c.match(req));
      lookup.then(resp => {
        // Cache miss → the network (static-router-main-resource "fallback to the
        // network when there is no cache entry").
        if (!resp) { respondWire(JSON.stringify({ fallthrough: true })); return; }
        return responseBytes(resp).then(bytes => respondWire(JSON.stringify(serializeResponseWire(resp, bytes))));
      }).catch(() => respondWire(JSON.stringify({ fallthrough: true })));
      return;
    }
    // (realmId 0) is 'client-window'.
    const isNav     = req !== null && requestOf(req).mode === 'navigate';
    // The FETCHING client's id: the wire value (the client's own identity, possibly an
    // adopted reserved id) when present; the realm-derived key is the fallback.
    const clientKey = wireClientId || ((realmId | 0) > 0 ? ('client-' + (realmId | 0)) : 'client-window');
    // A controlled client that FETCHES is a Client even if it never postMessaged the SW — register
    // it lazily here (url = the request's referrer, i.e. the requesting document) so
    // `clients.get(event.clientId)` / matchAll resolve it. (Not for a navigation: the resulting
    // client's document doesn't exist yet.)
    if (!isNav) { try { clientFor(clientKey, reqReferrer, true); } catch (_) {} }
    // Navigation Preload: rebuild the browser-issued preload response (present only when preload was
    // enabled) as a resolved `event.preloadResponse` the SW can `respondWith` — a NETWORK response, its
    // headers verbatim and immutable as a fetch's (the internal raw form), not a script's checked
    // through the Response constructor. (A failed/disabled preload leaves it the default undefined;
    // the spec distinction — a FAILED preload rejects — is a fidelity gap no vendored subtest covers.)
    if (preloadWire) preloadResponse = resolvedPromise(responseFromWire(preloadWire));
    const ev = new FetchEvent(CONVERTED, 'fetch', platformInit({
      request:           req,
      clientId:          isNav ? '' : clientKey,
      // A navigation falls back to the realm key; a NON-nav request (a worker
      // MAIN-SCRIPT fetch) uses the wire value when the host supplied one —
      // the script request CREATES the worker's client.
      resultingClientId: navResultingId || (isNav ? clientKey : ''),
      replacesClientId:  '',
      preloadResponse:   preloadResponse,
      cancelable:        true   // a FetchEvent is cancelable — preventDefault() (no respondWith) = network error
    }));
    dispatchExtendable(ev);
    // The response is delivered back to the ORIGINATING realm (realmId) — fetch ids are per-realm.
    const done = respJson => { try { globalThis.__csim_swFetchRespond(fetchId, respJson, realmId); } catch (_) {} };
    // Single owner of the wire-outcome ⟺ `handled`-outcome pairing: deliver the wire result and
    // settle `event.handled` together, exactly once. `ok` resolves handled (valid response /
    // network fallthrough); otherwise handled rejects with the network-error TypeError a real
    // browser surfaces. The `finished` guard makes it structurally impossible to double-deliver
    // or leave `handled` unsettled once any outcome is reached.
    let finished = false;
    const finish = (wireJson, ok, err) => {
      if (finished) return;
      finished = true;
      settleHandled(ev, ok, err);
      done(wireJson);
    };
    const networkError = () => finish(JSON.stringify({networkError: true}), false, new globalThis.TypeError('ServiceWorker fetch event resulted in a network error'));
    // No respondWith: if the handler called preventDefault() the fetch is a NETWORK ERROR (Handle
    // Fetch cancels a request whose event was canceled without a response); otherwise it falls
    // through to the network (fetch-event-network-error) — a successful outcome.
    if (!ev._responded) {
      if (ev._canceled) networkError();
      else                     finish(JSON.stringify({fallthrough: true}), true);
      return;
    }
    // A respondWith Response whose body is a GENUINE ReadableStream is delivered INCREMENTALLY —
    // a `start` frame (head) then a `chunk` frame per enqueued piece then `close`/`error` — so the
    // client observes bytes as they are produced (a body the SW keeps open, a stream errored mid-
    // flight). A byte-body response keeps the cheap single-shot arrayBuffer path. Navigation fetches
    // (negative id, delivered on the synchronous nav outbox) always buffer.
    const streamDeliver = resp => {
      let reader;
      // Claim the reader BEFORE committing: a locked/disturbed body can't be streamed → network error.
      try { reader = responseOf(resp).bodyStream.getReader(); } catch (_) { networkError(); return; }
      finished = true;                 // committed to the stream outcome — no single-shot done can fire
      settleHandled(ev, true);         // the response is handled the moment its head is delivered
      // Register the reader so a client-side body cancel (routed via __csim_swStreamCancel) can
      // cancel it, firing the source stream's `cancel()` — the SW observes the page's cancellation.
      swStreamReaders.set(fetchId | 0, reader);
      const emit = (kind, payload) => { try { globalThis.__csim_swFetchStream(fetchId, kind, payload || '', realmId); } catch (_) {} };
      emit('start', JSON.stringify(serializeResponseMeta(resp)));
      const pump = () => reader.read().then(({ value, done }) => {
        if (done) { swStreamReaders.delete(fetchId | 0); emit('close'); return; }
        // Each chunk must be a BufferSource; any other value errors the response body stream
        // (respond-with-response-body-with-invalid-chunk).
        let bytes;
        if (value instanceof globalThis.Uint8Array)               bytes = value;
        else if (value instanceof globalThis.ArrayBuffer)         bytes = new globalThis.Uint8Array(value);
        else if (value && value.buffer instanceof globalThis.ArrayBuffer) bytes = new globalThis.Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        else { swStreamReaders.delete(fetchId | 0); emit('error'); try { reader.cancel(); } catch (_) {} return; }
        emit('chunk', bytes);
        return pump();
      }, () => { swStreamReaders.delete(fetchId | 0); emit('error'); });
      return pump();
    };
    // Per Handle Fetch, a non-Response respondWith argument, a `Response.error()`, a rejected
    // promise, and a body that can't be read (already used / serialization failure) are all
    // network errors. `handled` resolves only once the body has been materialized to the wire, so
    // a late serialization failure still rejects it (via the .catch backstop) consistently with
    // the client fetch. No path can leave the client fetch pending.
    ev._responsePromise
      .then(resp => {
        if (responseOf(resp) === undefined || responseOf(resp).type === 'error') { networkError(); return; }
        // Streaming delivery only for REALM clients (realmId ≥ 0): the fr_* frame route
        // realm_calls the target, which for a WORKER client (negative realmId — a
        // controlled worker's fetch, or a direct main-script fetch) would misroute to the
        // MAIN realm and could resolve the wrong same-numbered fetch. A worker client
        // gets the buffered single-shot body instead; incremental streaming INTO a worker
        // isolate is a follow-up.
        if (responseOf(resp).bodyIsStream && fetchId > 0 && (realmId | 0) >= 0) return streamDeliver(resp);
        return responseBytes(resp).then(bytes => finish(JSON.stringify(serializeResponseWire(resp, bytes)), true));
      })
      .catch(networkError);
  };
  // A client → SW `postMessage` arrives here (host-driven from run_worker): its `source` the posting Client, so the SW's
  // handler (and the WPT ServiceWorkerTestEnvironment) can reply via `event.source`, its origin the client's (from its
  // URL).
  globalThis.__csim_swClientMessage = function (dataStr, clientId, clientURL) {
    let origin = '';
    try { origin = clientURL ? new globalThis.URL(clientURL).origin : ''; } catch (_) {}
    deliverMessage(decodeMessage(dataStr), clientFor(clientId == null ? 'client' : clientId, clientURL, false), origin);
  };
  // The worker itself and its registration (sw-client.js): the registration's scope threaded from register() through
  // worker_spawn (`__csimSwScope`) — the script URL for a spawn path that carries none (a directly-spawned service:true
  // worker outside register()) — its updateViaCache mode (`__csimSwUvc`), and the spawn-time snapshot of its active
  // version (`__csimSwPrevActive`: its script URL and handle).
  const { serviceWorker, registration } = globalThis.__csimServiceWorkerObjects.make(
    globalThis.__csimSwScope || location.href || '', location.href || '', globalThis.__csimSwUvc, globalThis.__csimSwPrevActive
  );
  swScope.serviceWorker = serviceWorker;
  swScope.registration = registration;
};

// Fire the service worker's lifecycle events (host-driven from run_worker, AFTER the
// worker's top-level script ran so its `addEventListener('install'|'activate', …)`
// handlers are registered). The phase's OUTCOME — every `waitUntil` promise settled,
// and whether any rejected — is what gates the registration's lifecycle ("Install"
// fails the version on a rejected waitUntil; "Activate" completes regardless but the
// state stays 'activating' until then), so it is recorded in a state cell the host
// polls (`__csim_swPhaseTake`) from its message loop rather than awaited inline: a
// waitUntil parked on a client message can only settle if this worker keeps reading
// its inbox while the phase is pending.
globalThis.__csim_swFireLifecycleEvent = function (type) {
  // Advance the worker's own registration mirror to where an observer expects it
  // at this event: `updatefound` (installing = this version) precedes the install
  // event; the activating statechange precedes the activate event.
  if (swScope.registration && type === 'install') advanceScope('updatefound');
  if (swScope.registration && type === 'activate') advanceScope('activating');
  // The install event is an InstallEvent (addRoutes — the Static Routing API); activate a plain ExtendableEvent.
  const ev = new (type === 'install' ? InstallEvent : ExtendableEvent)(CONVERTED, type, platformInit({}));
  dispatchExtendable(ev);
  const st = { phase: type, done: false, ok: true };
  globalThis.__csimSwPhaseState = st;
  // A rejected waitUntil must not short-circuit the wait — the state transition happens only after EVERY lifetime promise
  // settled (extendable-event-waituntil "reject precedence"), those added while others were pending too.
  promiseThen.call(extensionsSettled(ev), (ok) => {
    st.done = true;
    st.ok   = ok;
  });
};

// The service worker's lifecycle reached `step`: its registration's slots and its state moved to match (sw-client.js).
const advanceScope = (step) => globalThis.__csimServiceWorkerObjects.advance(swScope.registration, swScope.serviceWorker, step);

// One-shot read of a settled lifecycle phase: null while the current phase's
// waitUntil promises are still pending, `{phase, ok}` once they all settled.
// Settlement is also where the registration mirror's post-phase statechange
// lands: installed / redundant for install (by outcome), activated for activate.
globalThis.__csim_swPhaseTake = function () {
  const st = globalThis.__csimSwPhaseState;
  if (!st || !st.done) return null;
  globalThis.__csimSwPhaseState = null;
  if (swScope.registration && st.phase === 'install') advanceScope(st.ok ? 'installed' : 'installFailed');
  if (swScope.registration && st.phase === 'activate') advanceScope('activated');
  return { phase: st.phase, ok: st.ok };
};

// HTML "report an exception" in a worker: an ErrorEvent of its message and place at the worker's global first
// (platform-globals reportException) — then, unless a listener canceled that, in a DEDICATED worker one of the same at
// its Worker (`__csim_workerReportError`); a shared worker's goes to no SharedWorker. Whatever threw it: its script,
// a listener, a timer.
globalThis.__csimForwardUnhandledError = function (ev) {
  if (workerKind !== 'dedicated') return;
  globalThis.__csim_workerReportError(ev._message, ev._filename, ev._lineno, ev._colno);
};
// …and an exception the worker's script threw, which the host's evaluation hands over as its message and place
// (run_worker_script): the thrown value does not survive it, so the events' `error` is null.
globalThis.__csimReportWorkerScriptError = function (message, filename, lineno, colno) {
  const ev = new ErrorEvent('error', { message, filename, lineno, colno, error: null, cancelable: true });
  if (dispatchWithOnHandler(globalThis, ev)) globalThis.__csimForwardUnhandledError(ev);
};

// Called by the Ruby worker loop with each main → worker message (a JSON string): a `message` event at the worker's
// global scope, so both `self.onmessage = …` and `self.addEventListener('message', …)` pick it up. A shared worker's
// every message is a connection — the inside port of a SharedWorker's channel — which its `connect` event carries, the
// port its source as well (HTML "run a worker").
globalThis.__csim_workerOnMessage = function (dataStr) {
  const m = decodeMessage(dataStr);
  if (workerKind === 'shared') {
    if (!m.failed) dispatchWithOnHandler(globalThis, createMessageEvent('connect', { data: '', origin: '', source: m.ports[0], ports: m.ports }));
  } else {
    dispatchWithOnHandler(globalThis, createMessageEvent(messageEventType(m), { data: m.data, ports: m.ports }));
  }
};
