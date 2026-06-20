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

import { Event, MessageEvent, EventTarget, dispatchWithOnHandler } from './events.js';
import { bytesToLatin1, latin1ToBytes, fetchTransfer, stashTransfer, detachTransferables } from './bytes.js';

// True iff at least one main-scope Worker isolate currently exists.
// Blob.createObjectURL gates its Ruby-side blob-registry IPC on this
// so the no-Worker fast path skips a btoa+host-fn per File pick.
// Reads through globalThis because the `byHandle` Map is created
// lazily by `__csim_installWorker()` (only on V8; QuickJS opts out).
export function hasWorkers() {
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
function encode(data, transferSet) {
  const NS = globalThis.RustyRacer;
  const canTransfer = transferSet && NS && typeof NS.transferOut === 'function';
  return JSON.stringify(data, function (_key, value) {
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
function decode(s) {
  const NS = globalThis.RustyRacer;
  return JSON.parse(s, function (_key, value) {
    if (!value || typeof value !== 'object') return value;
    const tag = value.__csimType;
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

if (!globalThis.__csim_isWorker) {
  globalThis.__csim_installWorker = function () {
    if (typeof globalThis.Worker === 'function') return;
    const byHandle = new Map();
    globalThis.__csim_workersByHandle = byHandle;

    class Worker extends EventTarget {
      constructor(url, _options) {
        super();
        this.url            = String(url);
        this.onmessage      = null;
        this.onerror        = null;
        this.onmessageerror = null;
        this._handle        = globalThis.__csim_workerSpawn(this.url) | 0;
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
    globalThis.Worker = Worker;

    // Drained by the Ruby settle loop. Each entry is either
    // `{handle, kind:'message', data}` (JSON string) or
    // `{handle, kind:'__error', message}`.
    globalThis.__csim_deliverWorkerMessages = function (events) {
      if (!events || !events.length) return 0;
      let n = 0;
      for (const e of events) {
        const w = byHandle.get(e.handle | 0);
        if (!w) continue;
        if (e.kind === '__error') {
          const evt = new Event('error');
          if (e.message) try { evt.message = String(e.message); } catch (_) {}
          dispatchWithOnHandler(w, evt);
        } else {
          let data;
          try { data = decode(e.data); } catch (_) { data = null; }
          dispatchWithOnHandler(w, new MessageEvent('message', {data}));
        }
        n++;
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
  // `importScripts(url, ...)` is the Web Worker API for synchronous
  // script include — Tesseract.js's blob-bundled bootstrapper does
  // `importScripts('worker.min.js')` first thing. Synchronously
  // fetch via `__rackFetch` (worker thread → Ruby `Browser`
  // `rack_fetch`, which is mutex-safe for the cache and uses the
  // shared Rack app) and indirect-eval at global scope.
  globalThis.importScripts = function (...urls) {
    for (const u of urls) {
      const url = String(u);
      const resp = globalThis.__rackFetch('GET', url, '', null, 'follow');
      if (!resp || resp.status >= 400) throw new Error('importScripts: HTTP ' + (resp && resp.status) + ' for ' + url);
      (0, eval)(resp.body + '\n//# sourceURL=' + url);
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

// Called by the Ruby worker loop with each main → worker message
// (JSON string). Dispatches on the worker's global scope, so both
// `self.onmessage = …` and `self.addEventListener('message', …)`
// pick it up.
globalThis.__csim_workerOnMessage = function (dataStr) {
  let data;
  try { data = decode(dataStr); } catch (_) { data = null; }
  dispatchWithOnHandler(globalThis, new MessageEvent('message', {data}));
};
