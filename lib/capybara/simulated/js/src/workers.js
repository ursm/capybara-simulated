// Web Workers — main-scope `new Worker(url)` spawns a Ruby thread
// that creates a fresh V8 Context / QuickJS VM (real isolate, no
// shared memory) and loads the worker script. Cross-isolate
// communication is via Thread::Queue on the Ruby side; postMessage
// payloads are JSON-cloned with an extra wrapper for binary types —
// raw `JSON.stringify` flattens a Uint8Array to a numeric-keyed
// object, so image bytes posted through a worker would arrive as
// garbage.
//
// Worker class wiring is opt-in per engine — `V8Runtime#build_ctx`
// calls `__csim_installWorker()` after Context creation; QuickJS
// skips it (Quickjs::VM isn't yet safe to drive from a non-main Ruby
// thread, and the symptom is a process SEGV under sustained Worker
// churn). Apps that probe `typeof Worker === 'undefined'` take their
// no-worker fallback when the engine opts out.

import { Event, MessageEvent, EventTarget, dispatchWithOnHandler, defineEventHandlers } from './events.js';
import { bytesToLatin1, latin1ToBytes, fetchTransfer, stashTransfer, detachTransferables } from './bytes.js';
import { blobBytes } from './blob.js';
import { serializeResponseWire } from './response-wire.js';

// True iff blob URLs created here must be visible to ANOTHER isolate:
// the main scope has spawned a Worker, OR we ARE a worker (our blob
// URLs are inherently reachable by the owning page). Blob.createObjectURL
// gates its Ruby-side blob-registry byte IPC on this so the no-Worker fast
// path skips a btoa+host-fn per File pick. Reads through globalThis because
// the `byHandle` Map is created lazily by `__csim_installWorker()` (only on
// V8; QuickJS opts out).
export function hasWorkers() {
  if (globalThis.__csim_isWorker) return true;
  const m = globalThis.__csim_workersByHandle;
  return !!(m && m.size > 0);
}

// Buffers ≥ TRANSFER_STASH_MIN cross isolates by refId rather than
// JSON-base64; otherwise the 8900×8900-RGBA postMessage in Discourse's
// media-optimization-worker peaks JS heap at gigabytes of intermediate
// latin-1 / base64 strings before the worker even sees the payload.
const TRANSFER_STASH_MIN = 64 * 1024;

// The set of ArrayBuffers a postMessage `transfer` list names (callers pass the
// buffers, or views whose `.buffer` is transferred). `encode` moves these
// zero-copy; everything else is cloned.
function transferSetFrom(transferList) {
  if (!transferList || !transferList.length) return null;
  const set = new Set();
  for (const t of transferList) set.add(t instanceof ArrayBuffer ? t : (t && t.buffer) || t);
  return set;
}

// `transferSet` (optional) is the set of ArrayBuffers named in the postMessage
// transfer list. A buffer in it crosses ZERO-COPY via a `RustyRacer.transferOut`
// token (the source is detached, no bytes are copied); the recipient's `decode`
// rebuilds the buffer over the same backing store with `transferIn`. Buffers NOT
// transferred are cloned (the existing stash / base64 copy). On QuickJS there's
// no RustyRacer namespace, so everything falls back to the copy path.
export function encode(data, transferSet) {
  const NS = globalThis.RustyRacer;
  const canTransfer = transferSet && NS && typeof NS.transferOut === 'function';
  return JSON.stringify(data, function (_key, value) {
    // Blob / File structured-clone: serialize the bytes (+ type, and File's
    // name/lastModified) so the far isolate reconstructs a real Blob/File. A File
    // is also `instanceof Blob`, so test File first. blobBytes() handles both the
    // in-memory (_parts) and host-backed (file pick) byte sources.
    const BlobCtor = globalThis.Blob, FileCtor = globalThis.File;
    if (BlobCtor && value instanceof BlobCtor) {
      const isFile = (typeof FileCtor === 'function') && (value instanceof FileCtor);
      const bytes  = blobBytes(value);   // a latin-1 byte-string (1 char = 1 byte)
      const base   = isFile
        ? { __csimType: 'File', name: value.name != null ? String(value.name) : '', lastModified: value.lastModified, type: value.type || '' }
        : { __csimType: 'Blob', type: value.type || '' };
      // Only materialize a Uint8Array for the large-payload stash path; the small
      // path base64s the string directly (in-VM btoa — NOT host __csim_btoa, which
      // mangles bytes > 0x7F).
      if (bytes.length >= TRANSFER_STASH_MIN) {
        const refId = stashTransfer(latin1ToBytes(bytes));
        if (refId > 0) { base.refId = refId; return base; }
      }
      base.b64 = globalThis.btoa(bytes);
      return base;
    }
    // A transferred MessagePort → a cross-isolate channel ref (the kept peer becomes this
    // isolate's channel endpoint; see __csimPortToChannel). Only when actually in the transfer set.
    const MP = globalThis.MessagePort;
    if (MP && value instanceof MP && transferSet && transferSet.has(value) && typeof globalThis.__csimPortToChannel === 'function') {
      return { __csimType: 'MessagePort', channel: globalThis.__csimPortToChannel(value) };
    }
    const isU8 = value instanceof Uint8Array;
    const isAB = !isU8 && value instanceof ArrayBuffer;
    if (!isU8 && !isAB) return value;
    const type = isU8 ? 'Uint8Array' : 'ArrayBuffer';
    const buf  = isU8 ? value.buffer : value;
    if (canTransfer && transferSet.has(buf)) {
      const token = NS.transferOut(value) | 0;   // detaches the source buffer
      if (token > 0) {
        if (globalThis.__csim_transferIssued) globalThis.__csim_transferIssued(token);
        // A view transfers its whole underlying buffer; record the view window
        // so the far side reconstructs the same Uint8Array slice.
        return isU8 ? {__csimType: type, xfer: token, byteOffset: value.byteOffset, length: value.length}
                    : {__csimType: type, xfer: token};
      }
    }
    const view = isU8 ? value : new Uint8Array(value);
    if (view.byteLength >= TRANSFER_STASH_MIN) {
      const refId = stashTransfer(view);
      if (refId > 0) return {__csimType: type, refId};
    }
    return {__csimType: type, b64: globalThis.btoa(bytesToLatin1(view))};
  });
}
export function decode(s) {
  const NS = globalThis.RustyRacer;
  return JSON.parse(s, function (_key, value) {
    if (!value || typeof value !== 'object') return value;
    const tag = value.__csimType;
    if (tag === 'Blob' || tag === 'File') {
      const u = fetchTransfer(value.refId) || latin1ToBytes(globalThis.atob(value.b64 || ''));
      const FileCtor = globalThis.File;
      if (tag === 'File' && typeof FileCtor === 'function') {
        return new FileCtor([u], value.name || '', { type: value.type || '', lastModified: value.lastModified });
      }
      return new globalThis.Blob([u], { type: value.type || '' });
    }
    // A cross-isolate MessagePort channel ref → this isolate's endpoint port.
    if (tag === 'MessagePort' && typeof globalThis.__csimChannelToPort === 'function') {
      return globalThis.__csimChannelToPort(value.channel);
    }
    if (tag !== 'Uint8Array' && tag !== 'ArrayBuffer') return value;
    if (value.xfer != null && NS && typeof NS.transferIn === 'function') {
      const ab = NS.transferIn(value.xfer);                 // zero-copy: same backing store
      if (ab) {
        return tag === 'ArrayBuffer'
          ? ab
          : new Uint8Array(ab, value.byteOffset || 0, value.length != null ? value.length : ab.byteLength);
      }
      // Token gone (already imported / dropped) — fall through to empty.
      return tag === 'ArrayBuffer' ? new ArrayBuffer(0) : new Uint8Array(0);
    }
    const u = fetchTransfer(value.refId) || latin1ToBytes(globalThis.atob(value.b64 || ''));
    return tag === 'ArrayBuffer' ? u.buffer : u;
  });
}

// A postMessage across isolates, WITH its transfer list — the wire shape carries both the
// serialized data (embedded transferred ports become channel refs) and the ordered transfer-list
// port channels, so the receiver rebuilds `event.ports`. Used by the client↔SW message + port
// paths; a transfer-list port already turned into a channel by the data pass is reused (idempotent).
export function encodeMessage(data, transferList) {
  const tf = Array.isArray(transferList) ? transferList : [];
  let d = encode(data, transferSetFrom(tf));
  if (d === undefined) d = 'null';   // JSON.stringify(undefined) → undefined; keep `d` present so decodeMessage takes the {d,p} path
  const p  = [];
  const MP = globalThis.MessagePort;
  for (const t of tf) {
    if (MP && t instanceof MP && typeof globalThis.__csimPortToChannel === 'function') p.push(globalThis.__csimPortToChannel(t));
  }
  return JSON.stringify({ d, p });
}
export function decodeMessage(str) {
  let obj;
  try { obj = JSON.parse(str); } catch (_) { obj = null; }
  // Back-compat: a bare (non-{d,p}) payload is data-only (no transferred ports).
  if (!obj || typeof obj !== 'object' || !('d' in obj)) return { data: decode(str), ports: [] };
  const data  = decode(obj.d != null ? obj.d : 'null');
  const ports = (obj.p || []).map(ch => (typeof globalThis.__csimChannelToPort === 'function' ? globalThis.__csimChannelToPort(ch) : null)).filter(Boolean);
  return { data, ports };
}
globalThis.__csimEncodeMessage = encodeMessage;
globalThis.__csimDecodeMessage = decodeMessage;

if (!globalThis.__csim_isWorker) {
  globalThis.__csim_installWorker = function () {
    if (typeof globalThis.Worker === 'function') return;
    const byHandle = new Map();
    globalThis.__csim_workersByHandle = byHandle;

    class Worker extends EventTarget {
      constructor(url, _options) {
        super();
        this.url            = String(url);
        // Pass the CREATING context's origin key so a blob:/data: worker (whose script URL has no
        // real origin) inherits this agent cluster's origin for BroadcastChannel scoping.
        this._handle        = globalThis.__csim_workerSpawn(this.url, false, globalThis.__csimBcOriginKey()) | 0;
        if (this._handle > 0) byHandle.set(this._handle, this);
      }
      postMessage(data, transferList) {
        if (this._handle <= 0) return;
        let payload;
        try { payload = encode(data, transferSetFrom(transferList)); } catch (_) { payload = 'null'; }
        globalThis.__csim_workerPostToWorker(this._handle, payload);
        // `encode` copied the bytes (transfer-buffer stash / base64) into the
        // payload, so the source ArrayBuffers can now be neutered (transfer).
        detachTransferables(transferList);
      }
      terminate() {
        if (this._handle <= 0) return;
        globalThis.__csim_workerTerminate(this._handle);
        byHandle.delete(this._handle);
        this._handle = -1;
      }
    }
    defineEventHandlers(Worker.prototype, ['message', 'error', 'messageerror']);
    globalThis.Worker = Worker;

    // `SharedWorker` — a worker reached through a MessagePort (`worker.port`)
    // rather than direct postMessage. We reuse the dedicated-worker channel: the
    // shared worker spawns with a `shared` flag (so it fires `connect` instead of
    // running as a dedicated worker), and messages route through `worker.port`.
    // Single connection per SharedWorker (the in-process model has one document).
    class SharedWorker extends EventTarget {
      constructor(url, _name) {
        super();
        this.url     = String(url);
        this._handle = globalThis.__csim_workerSpawn(this.url, true, globalThis.__csimBcOriginKey()) | 0;
        const handle = this._handle;
        const port = new EventTarget();
        port.onmessage      = null;
        port.onmessageerror = null;
        port.start = function () {};   // messages flow once delivered; start is a no-op
        port.close = function () {};
        port.postMessage = function (data, transferList) {
          if (handle <= 0) return;
          let payload;
          try { payload = encode(data, transferSetFrom(transferList)); } catch (_) { payload = 'null'; }
          globalThis.__csim_workerPostToWorker(handle, payload);
          detachTransferables(transferList);
        };
        this.port = port;
        if (handle > 0) byHandle.set(handle, this);
      }
    }
    defineEventHandlers(SharedWorker.prototype, ['error']);
    globalThis.SharedWorker = SharedWorker;

    // Drained by the Ruby settle loop. Each entry is either
    // `{handle, kind:'message', data}` (JSON string) or
    // `{handle, kind:'__error', message}`.
    globalThis.__csim_deliverWorkerMessages = function (events) {
      if (!events || !events.length) return 0;
      let n = 0;
      const unhandled = [];
      for (const e of events) {
        const w = byHandle.get(e.handle | 0);
        if (!w) { unhandled.push(e); continue; }   // not ours — maybe a child realm's
        // A SharedWorker's messages are delivered on its port, not on itself.
        const target = w.port || w;
        if (e.kind === '__error') {
          const evt = new Event('error');
          if (e.message) try { evt.message = String(e.message); } catch (_) {}
          dispatchWithOnHandler(w, evt);   // errors fire on the worker object
        } else {
          let data;
          try { data = decode(e.data); } catch (_) { data = null; }
          dispatchWithOnHandler(target, new MessageEvent('message', {data}));
        }
        n++;
      }
      // A Worker/SharedWorker created INSIDE a child frame realm keeps its byHandle
      // there (worker_spawn is a host fn on the browser, but `new Worker` ran in the
      // frame realm), while the Ruby drain delivers via the MAIN realm. Fan the
      // events we couldn't place out to descendants; each child handles its own and
      // recurses, so a worker in a nested frame is reached too.
      if (unhandled.length && typeof globalThis.__csimEachChildRealm === 'function') {
        globalThis.__csimEachChildRealm(g => {
          if (typeof g.__csim_deliverWorkerMessages === 'function') n += g.__csim_deliverWorkerMessages(unhandled) || 0;
          return undefined;   // visit every child (accumulate), never short-circuit
        });
      }
      return n;
    };
  };
}

// Worker-scope install — called by `Runtime.build_worker` after host
// fns are attached, so the worker-scope shape only appears in actual
// worker isolates. NOTE: the main window now DOES define `window.postMessage`
// (platform-globals.js — same-page / iframe↔parent messaging), which is
// spec-correct and validated not to disturb React's scheduler (it uses
// MessageChannel; Mastodon 26/0). A historical buggy main-context postMessage
// once broke Mastodon's React mount, but that was a wrong-shaped function, not
// today's real window.postMessage. The worker scope OVERRIDES it below with the
// post-to-owner variant.
globalThis.__csim_installWorkerScope = function () {
  globalThis.__csim_isWorker = true;
  // Cross-isolate MessagePort channels route through the worker OUTBOX (a worker thread can't call
  // the browser directly), overriding the direct client-side plumbing platform-globals.js installed.
  // Channel ids are keyed by this worker's handle so they never collide with another isolate's.
  let __workerPortSeq = 0;
  globalThis.__csimAllocPortChannel = function () { return 'pc-h' + (globalThis.__csimWorkerHandle | 0) + '-' + (++__workerPortSeq); };
  globalThis.__csimPortRemotePost   = function (channel, dataStr) { try { globalThis.__csim_workerPortPost(channel, dataStr); } catch (_) {} };
  globalThis.__csimPortEndpointHere = function (channel) { try { globalThis.__csim_workerPortEndpoint(channel); } catch (_) {} };
  // Real DedicatedWorkerGlobalScope has neither `window` nor
  // `document`. Emscripten (Tesseract.js's wasm wrapper) uses
  // `typeof window` + `typeof importScripts` to detect environment;
  // leaving `window` defined steers it into the main-thread loader
  // path, which then can't reach the wasm binary and hangs at
  // "initializing tesseract". Same shape for `document`.
  try { delete globalThis.window;   } catch (_) { globalThis.window   = undefined; }
  try { delete globalThis.document; } catch (_) { globalThis.document = undefined; }
  // `window.open` / `window.opener` are window-only; a real WorkerGlobalScope
  // has neither. Drop them so a worker-side feature-detect (`typeof open`)
  // doesn't see the window's cross-window API and route through it.
  try { delete globalThis.open;     } catch (_) { globalThis.open     = undefined; }
  try { delete globalThis.opener;   } catch (_) { globalThis.opener   = undefined; }
  // Expose `WorkerGlobalScope` / `DedicatedWorkerGlobalScope` as
  // typeof-checkable classes so libraries that branch on
  // `typeof WorkerGlobalScope !== 'undefined'` (Tesseract.js's env
  // detector picks the global `fetch` path on the webworker branch —
  // without this it falls through to a no-op `fetch` adapter and
  // `loadLanguage` hangs awaiting `undefined`).
  globalThis.WorkerGlobalScope          = globalThis.WorkerGlobalScope          || function WorkerGlobalScope() {};
  globalThis.DedicatedWorkerGlobalScope = globalThis.DedicatedWorkerGlobalScope || function DedicatedWorkerGlobalScope() {};
  // Always install the worker-scope postMessage (route to the main thread),
  // OVERRIDING the window postMessage that platform-globals.js now installs in
  // every realm (it runs before this) — in a worker, `postMessage` posts to the
  // owner, not a local message dispatch. (Was gated on `typeof !== 'function'`
  // back when the main window had no postMessage; that gate now wrongly keeps the
  // window one.)
  globalThis.postMessage = function (data, transferList) {
    let payload;
    try { payload = encode(data, transferSetFrom(transferList)); } catch (_) { payload = 'null'; }
    globalThis.__csim_workerPostMessage(payload);
    detachTransferables(transferList);
  };
  // `self.close()` — a worker shuts itself down. The currently-running script
  // still runs to completion (so a `close(); …; postMessage(x)` sequence still
  // delivers x), but the host loop stops pulling further messages once it sees
  // the flag. Defined (real workers have it) so a `close()` call / `typeof close`
  // feature-detect doesn't throw or mis-route.
  globalThis.close = function () { globalThis.__csimWorkerClosed = true; };
  // Cheap host-callable reader for the close flag — the worker run-loop polls it
  // each tick via `c.call` (not a string `eval`, which would recompile per tick).
  globalThis.__csimWorkerClosedRead = function () { return !!globalThis.__csimWorkerClosed; };
  // `importScripts(url, ...)` is the Web Worker API for synchronous
  // script include — Tesseract.js's blob-bundled bootstrapper does
  // `importScripts('worker.min.js')` first thing. Synchronously
  // fetch via `__rackFetch` (worker thread → Ruby `Browser`
  // `rack_fetch`, which is mutex-safe for the cache and uses the
  // shared Rack app) and indirect-eval at global scope.
  globalThis.importScripts = function (...urls) {
    // importScripts resolves each URL against the WORKER SCRIPT's URL (self.location).
    // `__rackFetch` resolves relative URLs against the parent page instead, so resolve
    // here first — the executor-worker's `importScripts('./dispatcher.js')` must hit
    // the worker's own directory, not the opener document's.
    const base = (globalThis.location && globalThis.location.href) || null;
    for (const u of urls) {
      let url = String(u);
      if (base) { try { url = new globalThis.URL(url, base).href; } catch (_) {} }
      const resp = globalThis.__rackFetch('GET', url, '', null, 'follow');
      if (!resp || resp.status >= 400) throw new Error('importScripts: HTTP ' + (resp && resp.status) + ' for ' + url);
      const src = resp.body + '\n//# sourceURL=' + url;
      // Run at TOP-LEVEL script scope so the script's top-level const/let/class join
      // the worker's shared global lexical env (dispatcher.js's `const send`/`receive`
      // must be visible to later code). `(0, eval)` would block-scope them away.
      if (typeof globalThis.__csim_workerImportEval === 'function') globalThis.__csim_workerImportEval(src);
      else (0, eval)(src);
    }
  };
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
  globalThis.skipWaiting = function () { return Promise.resolve(); };

  // Client objects (`event.source` of a `message`, and `clients.matchAll()` entries) —
  // a controlled window/worker the SW can post back to. `postMessage` routes to the
  // host, which delivers to that client's `navigator.serviceWorker` 'message'. Clients
  // are tracked as they message the SW (keyed by id) so matchAll/get can return them.
  const clientsById = new Map();
  class Client {
    constructor(id, url, type, frameType) {
      this.id         = String(id);
      this._url       = url || '';
      this._type      = type || 'window';
      this._frameType = frameType || 'top-level';
    }
    get url()       { return this._url; }
    get type()      { return this._type; }
    get frameType() { return this._frameType; }
    postMessage(data, transferList) {
      let payload;
      try { payload = encodeMessage(data, transferList); } catch (_) { payload = JSON.stringify({d: 'null', p: []}); }
      try { globalThis.__csim_swPostToClient(this.id, payload); } catch (_) {}
      detachTransferables(transferList);
    }
  }
  function clientFor(id, url) {
    let c = clientsById.get(String(id));
    if (!c) { c = new Client(id, url); clientsById.set(String(id), c); }
    else if (url && !c._url) { c._url = url; }
    return c;
  }
  // Host-driven Client registry: the browser mirrors every controlled client
  // (frame / window realm) here — with its url / type / frameType — so matchAll and
  // getClientByURL reflect the REAL client set, not only clients that happened to
  // postMessage this worker. A re-registration (same id) refreshes the record.
  globalThis.__csim_swRegisterClient = function (rec) {
    if (!rec || rec.id == null) return;
    clientsById.set(String(rec.id), new Client(rec.id, rec.url, rec.type, rec.frameType));
  };
  globalThis.__csim_swUnregisterClient = function (id) {
    clientsById.delete(String(id));
  };
  globalThis.clients = {
    // claim() makes this active worker the controller of its in-scope clients: route their
    // fetches through this SW. The host sets each client's navigator.serviceWorker.controller.
    claim()    { try { globalThis.__csim_swClaim(); } catch (_) {} return Promise.resolve(); },
    matchAll() { return Promise.resolve(Array.from(clientsById.values())); },
    get(id)    { return Promise.resolve(clientsById.get(String(id))); }
  };

  // ExtendableEvent — an `install` / `activate` event whose `waitUntil(promise)`
  // extends the lifetime of the corresponding lifecycle step. We collect the
  // promises so the host can drain them before advancing the worker's state.
  // Defined before FetchEvent, which extends it.
  if (!globalThis.ExtendableEvent) {
    globalThis.ExtendableEvent = class ExtendableEvent extends globalThis.Event {
      constructor(type, init) { super(type, init); this._extendLifetimePromises = []; }
      waitUntil(p) { this._extendLifetimePromises.push(Promise.resolve(p)); }
    };
  }

  // FetchEvent — dispatched for a controlled client's request. `respondWith(r)` supplies the
  // Response (or a Promise of one); if no handler calls it, the request falls through to network.
  if (!globalThis.FetchEvent) {
    globalThis.FetchEvent = class FetchEvent extends globalThis.ExtendableEvent {
      constructor(type, init) {
        super(type, init);
        init = init || {};
        this.request           = init.request || null;
        this.clientId          = init.clientId || '';
        this.resultingClientId = init.resultingClientId || '';
        this.preloadResponse   = Promise.resolve(undefined);
        this._responded        = false;
        this._responsePromise  = null;
        this._dispatching      = false;   // set while the event is being dispatched (respondWith window)
      }
      respondWith(r) {
        // respondWith is only valid DURING dispatch (synchronously in the handler): calling it from a
        // later task/microtask, after the event finished dispatching, is an InvalidStateError — as is
        // calling it twice. (FetchEvent "respond with" checks the dispatch + respond-with flags.)
        if (!this._dispatching) throw new globalThis.DOMException('respondWith called outside the fetch event dispatch', 'InvalidStateError');
        if (this._responded)    throw new globalThis.DOMException('respondWith called twice', 'InvalidStateError');
        this._responded = true;
        this._responsePromise = Promise.resolve(r);
      }
    };
  }

  // Whether this SW has a `fetch` listener (on-handlers register as listeners, so `onfetch`
  // counts). Snapshotted by the host after the script's initial run — matching the spec, which
  // records the fetch-handler presence at install time; a listener added later is ignored
  // (Chrome warns and does the same). Lets the client skip the cross-isolate dispatch entirely
  // for messaging/push-only service workers.
  globalThis.__csim_swHasFetchListener = function () {
    const l = globalThis._listeners;
    return !!(l && l.fetch && l.fetch.length);
  };

  // Dispatch a `fetch` event for a controlled client's request (host-driven from run_worker).
  // Posts the respondWith Response back (or a fall-through / network-error marker) via the host.
  globalThis.__csim_swDispatchFetch = function (reqJson, fetchId, realmId) {
    let req, reqReferrer = '';
    try {
      const r = JSON.parse(reqJson);
      reqReferrer = r.referrer || '';
      const init = {method: r.method, headers: r.headers};
      if (r.body_b64 && r.method !== 'GET' && r.method !== 'HEAD') init.body = latin1ToBytes(globalThis.atob(r.body_b64));
      req = new globalThis.Request(r.url, init);
      // A navigation request carries mode 'navigate' (+ destination / reload / history flags)
      // that the public Request ctor rejects — set the backing fields directly so the SW's
      // handler sees `event.request.mode === 'navigate'`. A subresource request reflects the
      // client's redirect / mode / credentials / cache / integrity / referrer so the SW's
      // `event.request.*` matches what a real browser hands its fetch handler.
      if (r.mode === 'navigate')      req._mode = 'navigate';
      else if (r.mode)                req._mode = r.mode;
      if (r.destination)              req._destination = r.destination;
      if (r.isReloadNavigation)       req._isReloadNavigation = true;
      if (r.isHistoryNavigation)      req._isHistoryNavigation = true;
      if (r.redirect)                 req._redirect = r.redirect;
      if (r.credentials)              req._credentials = r.credentials;
      if (r.cache)                    req._cache = r.cache;
      if (r.keepalive)                req._keepalive = true;
      if (r.integrity)                req._integrity = r.integrity;
      if (r.referrerPolicy)           req._referrerPolicy = r.referrerPolicy;
      if (r.referrer != null)         req._referrer = r.referrer;
    } catch (_) { req = null; }
    // clientId = the client that MADE the request; resultingClientId = the client the request
    // CREATES. A navigation has no initiating client (clientId '') but reserves the resulting
    // client (the document it will load); a subresource is the reverse — its client made it, and it
    // creates none (resultingClientId ''). The client is keyed by the ORIGINATING realm
    // (`client-<realm>`, matching sw-client.js clientId() + the browser registry); the main/top realm
    // (realmId 0) is 'client-window'.
    const isNav     = req && req._mode === 'navigate';
    const clientKey = (realmId | 0) > 0 ? ('client-' + (realmId | 0)) : 'client-window';
    // A controlled client that FETCHES is a Client even if it never postMessaged the SW — register
    // it lazily here (url = the request's referrer, i.e. the requesting document) so
    // `clients.get(event.clientId)` / matchAll resolve it. (Not for a navigation: the resulting
    // client's document doesn't exist yet.)
    if (!isNav) { try { clientFor(clientKey, reqReferrer); } catch (_) {} }
    const ev = new globalThis.FetchEvent('fetch', {
      request:           req,
      clientId:          isNav ? '' : clientKey,
      resultingClientId: isNav ? clientKey : ''
    });
    // The dispatch flag gates respondWith: valid synchronously in the handler AND in the microtask
    // checkpoint that immediately follows (browsers keep the window open there — "respondWith in a
    // microtask does not throw"), but NOT from a later TASK. So clear it in a microtask queued AFTER
    // dispatch: it runs after the handler's own respondWith-microtask (FIFO) but before any later task.
    ev._dispatching = true;
    dispatchWithOnHandler(globalThis, ev);
    Promise.resolve().then(() => { ev._dispatching = false; });
    // The response is delivered back to the ORIGINATING realm (realmId) — fetch ids are per-realm.
    const done = respJson => { try { globalThis.__csim_swFetchRespond(fetchId, respJson, realmId); } catch (_) {} };
    if (!ev._responded) { done(JSON.stringify({fallthrough: true})); return; }
    // Per Handle Fetch, a non-Response respondWith argument, a `Response.error()`, a rejected
    // promise, and a body that can't be read (already used / serialization failure) are all
    // network errors — the client's fetch() rejects with a TypeError. The final rejection arm
    // also backstops the fulfillment arm, so no path can leave the client fetch pending.
    ev._responsePromise
      .then(resp => {
        if (!(resp instanceof globalThis.Response) || resp.type === 'error') return JSON.stringify({networkError: true});
        return resp.arrayBuffer().then(buf => JSON.stringify(serializeResponseWire(resp, new globalThis.Uint8Array(buf))));
      })
      .then(done, () => done(JSON.stringify({networkError: true})));
  };
  // A client → SW `postMessage` arrives here (host-driven from run_worker). Dispatch a
  // `message` event on the SW global whose `source` is the posting Client, so the SW's
  // handler (and the WPT ServiceWorkerTestEnvironment) can reply via `event.source`.
  globalThis.__csim_swClientMessage = function (dataStr, clientId, clientURL) {
    let data = null, ports = [];
    try { ({ data, ports } = decodeMessage(dataStr)); } catch (_) {}
    const source = clientFor(clientId == null ? 'client' : clientId, clientURL);
    // MessageEvent.origin is the SENDER's (the posting client's) origin, derived from its URL.
    let origin = '';
    try { origin = clientURL ? new globalThis.URL(clientURL).origin : ''; } catch (_) {}
    dispatchWithOnHandler(globalThis, new MessageEvent('message', {data, origin, source, ports}));
  };
  const reg = {
    scope:      (globalThis.location && globalThis.location.href) || '',
    active:     null, installing: null, waiting: null,
    update()     { return Promise.resolve(reg); },
    // `self.registration.unregister()` shuts this worker down (the run-loop exits on
    // the close flag), matching the opener-side reg.unregister() that terminates it.
    unregister() { try { globalThis.close(); } catch (_) {} return Promise.resolve(true); },
    addEventListener() {}, removeEventListener() {}
  };
  globalThis.registration = reg;
  if (!globalThis.ServiceWorkerGlobalScope) {
    globalThis.ServiceWorkerGlobalScope = function ServiceWorkerGlobalScope() {};
    // `global_scope instanceof ServiceWorkerGlobalScope` must hold so testharness.js
    // selects its ServiceWorkerTestEnvironment (which posts results to event.source).
    Object.defineProperty(globalThis.ServiceWorkerGlobalScope, Symbol.hasInstance, { value: o => o === globalThis });
  }
};

// Fire the service worker's lifecycle events (host-driven from run_worker, AFTER the
// worker's top-level script ran so its `addEventListener('install'|'activate', …)`
// handlers are registered). Returns a Promise that settles once every `waitUntil`
// of the given phase has settled — the host drains microtasks against it before
// advancing to the next phase / reporting the worker ready.
globalThis.__csim_swFireLifecycleEvent = function (type) {
  const ev = new globalThis.ExtendableEvent(type);
  dispatchWithOnHandler(globalThis, ev);
  return Promise.allSettled(ev._extendLifetimePromises || []);
};

// Called by the Ruby worker loop with each main → worker message
// (JSON string). Dispatches on the worker's global scope, so both
// `self.onmessage = …` and `self.addEventListener('message', …)`
// pick it up.
globalThis.__csim_workerOnMessage = function (dataStr) {
  let data;
  try { data = decode(dataStr); } catch (_) { data = null; }
  // In a SharedWorker, main->worker messages arrive on the connection port, not
  // on the global scope.
  const port = globalThis.__csimSharedWorkerPort;
  dispatchWithOnHandler(port || globalThis, new MessageEvent('message', {data}));
};

// Called by the host (run_worker) right after a SHARED worker's script has run,
// so `self.onconnect` (set by that script) sees the connection. Fires a `connect`
// event whose `ports[0]` is the worker side of the MessagePort pair; that port
// posts to the owner's outbox (delivered to `sharedWorker.port`).
globalThis.__csimFireSharedWorkerConnect = function () {
  if (globalThis.__csimSharedWorkerPort) return;   // single connection
  const port = new EventTarget();
  port.onmessage      = null;
  port.onmessageerror = null;
  port.start = function () {};
  port.close = function () {};
  port.postMessage = function (data, transferList) {
    let payload;
    try { payload = encode(data, transferSetFrom(transferList)); } catch (_) { payload = 'null'; }
    globalThis.__csim_workerPostMessage(payload);
    detachTransferables(transferList);
  };
  globalThis.__csimSharedWorkerPort = port;
  dispatchWithOnHandler(globalThis, new MessageEvent('connect', { data: '', origin: '', source: null, ports: [port] }));
};
