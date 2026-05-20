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
import { bytesToLatin1, latin1ToBytes } from './bytes.js';

// True iff at least one main-scope Worker isolate currently exists.
// Blob.createObjectURL gates its Ruby-side blob-registry IPC on this
// so the no-Worker fast path skips a btoa+host-fn per File pick.
// Reads through globalThis because the `byHandle` Map is created
// lazily by `__csim_installWorker()` (only on V8; QuickJS opts out).
export function hasWorkers() {
  const m = globalThis.__csim_workersByHandle;
  return !!(m && m.size > 0);
}

function encode(data) {
  return JSON.stringify(data, function (_key, value) {
    const isU8 = value instanceof Uint8Array;
    const isAB = !isU8 && value instanceof ArrayBuffer;
    if (!isU8 && !isAB) return value;
    const view = isU8 ? value : new Uint8Array(value);
    return {__csimType: isU8 ? 'Uint8Array' : 'ArrayBuffer',
            b64: globalThis.btoa(bytesToLatin1(view))};
  });
}
function decode(s) {
  return JSON.parse(s, function (_key, value) {
    if (!value || typeof value !== 'object') return value;
    const tag = value.__csimType;
    if (tag !== 'Uint8Array' && tag !== 'ArrayBuffer') return value;
    const u = latin1ToBytes(globalThis.atob(value.b64));
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
      postMessage(data, _transferList) {
        if (this._handle <= 0) return;
        let payload;
        try { payload = encode(data); } catch (_) { payload = 'null'; }
        globalThis.__csim_workerPostToWorker(this._handle, payload);
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
// fns are attached, so the symbol only appears in actual worker
// isolates. Defining `globalThis.postMessage` in main context (even
// gated by an `__csim_isWorker` runtime check) leaks a function-
// shaped symbol that some apps treat as a "we have postMessage
// support" signal — Mastodon's React mount broke during regression
// bisect when the function was present in main.
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
  // Expose `WorkerGlobalScope` / `DedicatedWorkerGlobalScope` as
  // typeof-checkable classes so libraries that branch on
  // `typeof WorkerGlobalScope !== 'undefined'` (Tesseract.js's env
  // detector picks the global `fetch` path on the webworker branch —
  // without this it falls through to a no-op `fetch` adapter and
  // `loadLanguage` hangs awaiting `undefined`).
  globalThis.WorkerGlobalScope          = globalThis.WorkerGlobalScope          || function WorkerGlobalScope() {};
  globalThis.DedicatedWorkerGlobalScope = globalThis.DedicatedWorkerGlobalScope || function DedicatedWorkerGlobalScope() {};
  if (typeof globalThis.postMessage !== 'function') {
    globalThis.postMessage = function (data, _transferList) {
      let payload;
      try { payload = encode(data); } catch (_) { payload = 'null'; }
      globalThis.__csim_workerPostMessage(payload);
    };
  }
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
