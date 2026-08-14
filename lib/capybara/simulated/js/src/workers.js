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

import { Event, MessageEvent, EventTarget, dispatchWithOnHandler, defineEventHandlers, toFrozenPorts } from './events.js';
import { bytesToLatin1, latin1ToBytes, fetchTransfer, stashTransfer, detachTransferables, transferListFrom } from './bytes.js';
import { blobBytes } from './blob.js';
import { serializeResponseWire, serializeResponseMeta } from './response-wire.js';

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

// The "JavaScript MIME type essence match" set (Fetch/Infra): a classic worker-imported script whose
// Content-Type essence isn't one of these is a network error. Used by importScripts (below).
const JS_MIME_ESSENCES = new Set([
  'application/ecmascript', 'application/javascript', 'application/x-ecmascript', 'application/x-javascript',
  'text/ecmascript', 'text/javascript', 'text/javascript1.0', 'text/javascript1.1', 'text/javascript1.2',
  'text/javascript1.3', 'text/javascript1.4', 'text/javascript1.5', 'text/jscript', 'text/livescript',
  'text/x-ecmascript', 'text/x-javascript'
]);

// Realm-independent MessagePort brand-check. A port transferred cross-realm before it crosses
// the isolate boundary (a frame posting to its parent-owned controller, which then relays to the
// SW) reaches the serializer as a foreign-realm object, so `instanceof globalThis.MessagePort`
// fails; @@toStringTag ('[object MessagePort]') is realm-independent. Same fix pattern as the
// cross-realm Blob / ReadableStream body brand-checks (inc-5h).
function isMessagePort(value) {
  if (value == null || typeof value !== 'object') return false;
  if (Object.prototype.toString.call(value) === '[object MessagePort]') return true;
  const MP = globalThis.MessagePort;
  return !!(MP && value instanceof MP);
}

// The set of ArrayBuffers a postMessage `transfer` list names (callers pass the
// buffers, or views whose `.buffer` is transferred). `encode` moves these
// zero-copy; everything else is cloned. Accepts both the array and `{transfer: […]}`
// dictionary overload forms (transferListFrom).
function transferSetFrom(transferList) {
  const list = transferListFrom(transferList);
  if (!list.length) return null;
  const set = new Set();
  for (const t of list) set.add(t instanceof ArrayBuffer ? t : (t && t.buffer) || t);
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
    // `undefined` is a structured-clone value (JSON drops it — a top-level `undefined` yields no
    // string at all, so `postMessage(undefined)` would arrive as null). Tag it so it round-trips.
    if (value === undefined) return { __csimType: 'undefined' };
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
    if (isMessagePort(value) && transferSet && transferSet.has(value) && typeof globalThis.__csimPortToChannel === 'function') {
      return { __csimType: 'MessagePort', channel: globalThis.__csimPortToChannel(value) };
    }
    const isU8 = value instanceof Uint8Array;
    const isAB = !isU8 && value instanceof ArrayBuffer;
    if (!isU8 && !isAB) return value;
    const type = isU8 ? 'Uint8Array' : 'ArrayBuffer';
    const buf  = isU8 ? value.buffer : value;
    if (canTransfer && transferSet.has(buf)) {
      // Capture the view window BEFORE transferOut detaches the buffer — a view over a
      // detached buffer reports byteOffset/length 0, so reading them afterward would ship a
      // zero-length slice (the bytes cross via the backing store but the far side rebuilds an
      // empty Uint8Array).
      const byteOffset = isU8 ? value.byteOffset : 0;
      const length     = isU8 ? value.length : 0;
      const token = NS.transferOut(value) | 0;   // detaches the source buffer
      if (token > 0) {
        if (globalThis.__csim_transferIssued) globalThis.__csim_transferIssued(token);
        // A view transfers its whole underlying buffer; record the view window
        // so the far side reconstructs the same Uint8Array slice.
        return isU8 ? {__csimType: type, xfer: token, byteOffset, length}
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
// A JSON.parse reviver that RETURNS undefined makes the parser DELETE the property, so a value
// that was `undefined` comes back MISSING rather than present-and-undefined — `[undefined, 1]`
// arrives as a HOLE, which `'0' in arr` and assert_array_equals can tell apart (a service
// worker reporting `client.visibilityState` for a non-window client sends exactly that).
// Revive to a private sentinel instead and assign real undefined in a second pass, which keeps
// the key present.
const UNDEF_SENTINEL = {};

// The WorkerOptions `type` member (Worker / SharedWorker / nested Worker ctors) — a
// WebIDL enum, so anything but "classic" / "module" is a TypeError at construction.
// SharedWorker's second argument is (name or options); a non-object carries no type.
function workerScriptType(options) {
  if (!options || typeof options !== 'object' || options.type === undefined) return 'classic';
  const t = String(options.type);
  if (t !== 'classic' && t !== 'module') {
    throw new globalThis.TypeError("The provided value '" + t + "' is not a valid enum value of type WorkerType.");
  }
  return t;
}
function unwrapUndefined(v) {
  if (v === UNDEF_SENTINEL) return undefined;
  if (v === null || typeof v !== 'object') return v;
  // Only walk plain JSON containers: a revived Blob / Uint8Array / MessagePort is a finished
  // platform object, and its properties are not ours to rewrite.
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) v[i] = unwrapUndefined(v[i]);
    return v;
  }
  if (Object.getPrototypeOf(v) !== Object.prototype) return v;
  for (const k of Object.keys(v)) v[k] = unwrapUndefined(v[k]);
  return v;
}

export function decode(s) {
  const NS = globalThis.RustyRacer;
  // Only pay for the fix-up walk when the payload actually carried an `undefined`; decode is on
  // the per-message hot path (worker postMessage, port relay, SW client messages) and the common
  // payload has none, so the second traversal would be pure overhead (rule 3).
  let sawUndefined = false;
  const parsed = JSON.parse(s, function (_key, value) {
    if (!value || typeof value !== 'object') return value;
    const tag = value.__csimType;
    if (tag === 'undefined') { sawUndefined = true; return UNDEF_SENTINEL; }
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
  return sawUndefined ? unwrapUndefined(parsed) : parsed;
}

// A postMessage across isolates, WITH its transfer list — the wire shape carries both the
// serialized data (embedded transferred ports become channel refs) and the ordered transfer-list
// port channels, so the receiver rebuilds `event.ports`. Used by the client↔SW message + port
// paths; a transfer-list port already turned into a channel by the data pass is reused (idempotent).
export function encodeMessage(data, transferList) {
  const tf = transferListFrom(transferList);
  let d = encode(data, transferSetFrom(tf));
  if (d === undefined) d = 'null';   // JSON.stringify(undefined) → undefined; keep `d` present so decodeMessage takes the {d,p} path
  const p  = [];
  for (const t of tf) {
    if (isMessagePort(t) && typeof globalThis.__csimPortToChannel === 'function') p.push(globalThis.__csimPortToChannel(t));
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

// The creating context's live controller handle (0 when uncontrolled / before sw-client.js has
// installed the accessor). Read at `new Worker(...)` time, never cached: control commonly arrives
// after load, via `clients.claim()`.
function controllerHandle() {
  const f = globalThis.__csimControllerHandle;
  return typeof f === 'function' ? (f() | 0) : 0;
}

if (!globalThis.__csim_isWorker) {
  globalThis.__csim_installWorker = function () {
    if (typeof globalThis.Worker === 'function') return;
    const byHandle = new Map();
    globalThis.__csim_workersByHandle = byHandle;

    // A RELATIVE worker script URL resolves against the CONSTRUCTING realm's own document
    // base — the host would otherwise resolve it against the MAIN document
    // (resolve_against_current), another directory for a frame's `new Worker('x.js')`
    // (worker-client-id; the same unify as the relative <script src> fix). blob:/data:/
    // absolute URLs pass through untouched; an unresolvable base keeps the raw string.
    function resolveWorkerUrl(url) {
      const s = String(url);
      try {
        return new globalThis.URL(s, (globalThis.document && globalThis.document.baseURI) || (globalThis.location && globalThis.location.href) || undefined).href;
      } catch (_) { return s; }
    }
    class Worker extends EventTarget {
      constructor(url, options) {
        super();
        this.url            = resolveWorkerUrl(url);
        // Pass the CREATING context's origin key so a blob:/data: worker (whose script URL has no
        // real origin) inherits this agent cluster's origin for BroadcastChannel scoping, the
        // creating REALM so the worker dies with it, and that context's CURRENT controller — a
        // DEDICATED worker inherits its creator's service worker rather than scope-matching its own
        // (often opaque) script URL.
        this._handle        = globalThis.__csim_workerSpawn(
          this.url, false, globalThis.__csimBcOriginKey(), globalThis.__csimRealmId(), controllerHandle(), workerScriptType(options)) | 0;
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
      constructor(url, nameOrOptions) {
        super();
        this.url     = resolveWorkerUrl(url);
        this._handle = globalThis.__csim_workerSpawn(this.url, true, globalThis.__csimBcOriginKey(), globalThis.__csimRealmId(), 0, workerScriptType(nameOrOptions)) | 0;
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
  // `focus` / `blur` are likewise window-only: they act on a BROWSING CONTEXT, which a
  // worker doesn't have. (`print` / `scroll*` leak the same way, but `print` is a real
  // global in some engines — dropping it would change what an environment detector sees.)
  try { delete globalThis.focus;    } catch (_) { globalThis.focus    = undefined; }
  try { delete globalThis.blur;     } catch (_) { globalThis.blur     = undefined; }
  // Expose `WorkerGlobalScope` / `DedicatedWorkerGlobalScope` as
  // typeof-checkable classes so libraries that branch on
  // `typeof WorkerGlobalScope !== 'undefined'` (Tesseract.js's env
  // detector picks the global `fetch` path on the webworker branch —
  // without this it falls through to a no-op `fetch` adapter and
  // `loadLanguage` hangs awaiting `undefined`).
  globalThis.WorkerGlobalScope          = globalThis.WorkerGlobalScope          || function WorkerGlobalScope() {};
  globalThis.DedicatedWorkerGlobalScope = globalThis.DedicatedWorkerGlobalScope || function DedicatedWorkerGlobalScope() {};
  globalThis.SharedWorkerGlobalScope    = globalThis.SharedWorkerGlobalScope    || function SharedWorkerGlobalScope() {};
  // `self instanceof DedicatedWorkerGlobalScope` (etc.) must hold for the matching
  // worker KIND — a served worker script branches on exactly this brand check
  // (postmessage-on-load-worker.js) and posts NOTHING when both arms are false.
  // `__csimWorkerKind` is injected by run_worker ('dedicated' | 'shared'; a service
  // worker's ServiceWorkerGlobalScope brand is installed by its own scope setup).
  function brandWorkerScope(cls, kind) {
    try {
      Object.defineProperty(cls, Symbol.hasInstance, {
        value: (o) => o === globalThis && (kind === null || globalThis.__csimWorkerKind === kind)
      });
    } catch (_) {}
  }
  brandWorkerScope(globalThis.WorkerGlobalScope, null);
  brandWorkerScope(globalThis.DedicatedWorkerGlobalScope, 'dedicated');
  brandWorkerScope(globalThis.SharedWorkerGlobalScope, 'shared');
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
    // importScripts is CLASSIC-worker-only: a module worker throws a TypeError
    // (HTML "importing scripts and libraries": module workers must use import()).
    if (globalThis.__csimWorkerModule) {
      throw new globalThis.TypeError("Failed to execute 'importScripts' on 'WorkerGlobalScope': Module scripts don't support importScripts().");
    }
    // importScripts resolves each URL against the WORKER SCRIPT's URL (self.location).
    // `__rackFetch` resolves relative URLs against the parent page instead, so resolve
    // here first — the executor-worker's `importScripts('./dispatcher.js')` must hit
    // the worker's own directory, not the opener document's.
    const base = (globalThis.location && globalThis.location.href) || null;
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
          bodyText = /;base64\s*$/i.test(meta) ? globalThis.atob(payload) : payload;
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
      const swCache = globalThis.__csimWorkerKind === 'service' && globalThis.__csimSwUvc === 'none' ? 'no-cache' : undefined;
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
      if (globalThis.__csimWorkerKind === 'service') {
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
  };
  // NESTED dedicated workers (`new Worker` INSIDE a worker): spawn through the same
  // host fn, tagging the creator as -(this worker's handle) — the worker-parent
  // convention the fetch routing already uses — so the host records the parentage,
  // routes the child's messages back through THIS isolate's inbox
  // (nested_worker_msgs), and terminates the child with its parent. Scope-matched
  // http(s) child scripts get their own controller; a scope-less http(s) child is
  // uncontrolled (blob:/data: nested scripts are refused for now — the blob registry
  // lives in the main VM, unreachable from this thread).
  {
    const nestedByHandle = new Map();
    globalThis.__csim_workersByHandle = nestedByHandle;
    class Worker extends EventTarget {
      constructor(url, options) {
        super();
        let abs = String(url);
        try { abs = new globalThis.URL(abs, (globalThis.location && globalThis.location.href) || undefined).href; } catch (_) {}
        this.url     = abs;
        this._handle = globalThis.__csim_workerSpawn(
          this.url, false, globalThis.__csimBcOriginKey(), -(globalThis.__csimWorkerHandle | 0), controllerHandle(), workerScriptType(options)) | 0;
        if (this._handle > 0) nestedByHandle.set(this._handle, this);
      }
      postMessage(data, transferList) {
        if (this._handle <= 0) return;
        let payload;
        try { payload = encode(data, transferSetFrom(transferList)); } catch (_) { payload = 'null'; }
        globalThis.__csim_workerPostToWorker(this._handle, payload);
        detachTransferables(transferList);
      }
      terminate() {
        if (this._handle <= 0) return;
        globalThis.__csim_workerTerminate(this._handle);
        nestedByHandle.delete(this._handle);
        this._handle = -1;
      }
    }
    defineEventHandlers(Worker.prototype, ['message', 'error', 'messageerror']);
    globalThis.Worker = Worker;
    // A nested worker's postbacks, delivered by the host through this isolate's inbox
    // (run_worker `nested_worker_msgs`) — the single-isolate shape of the window-side
    // __csim_deliverWorkerMessages (no child-realm fan-out here).
    globalThis.__csim_deliverWorkerMessages = function (events) {
      if (!events || !events.length) return 0;
      let n = 0;
      for (const e of events) {
        const w = nestedByHandle.get(e.handle | 0);
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
  }

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
  // XMLHttpRequest is exposed on Dedicated/SharedWorkerGlobalScope but NOT on
  // ServiceWorkerGlobalScope (a SW uses fetch()) — interface-requirements-sw "xhr is not exposed".
  drop(globalThis, 'XMLHttpRequest');
  // Worker is `[Exposed=(Window,DedicatedWorker,SharedWorker)]` — NOT ServiceWorker;
  // the nested-worker class __csim_installWorkerScope installed must not leak here.
  drop(globalThis, 'Worker');
  // `skipWaiting()` lets an installed worker activate without waiting for the outgoing one to lose
  // its controllees. The waiting slot lives on the CLIENT side (per-realm registration objects), so
  // the request rides the outbox like claim() — fire-and-forget: the spec's promise resolves once
  // the request is made, not once activation happens.
  globalThis.skipWaiting = function () {
    try { globalThis.__csim_swSkipWaitingRequest(); } catch (_) {}
    return Promise.resolve();
  };

  // Client objects (`event.source` of a `message`, and `clients.matchAll()` entries) —
  // a controlled window/worker the SW can post back to. `postMessage` routes to the
  // host, which delivers to that client's `navigator.serviceWorker` 'message'. The set is
  // mirrored from the host (`__csim_swRegisterClient` below); `clientFor` only fills in a
  // sender the mirror hasn't reached yet, so `event.source` is never missing.
  const clientsById = new Map();
  // The ids of every client that counts as focused, mirrored from the host
  // (`note_focused_realm`) — a worker isolate can't ask the browser, and the answer is
  // cross-realm, so it's pushed on every change. This is the focused context AND its
  // ANCESTORS: `focused` follows `document.hasFocus()`, which is true all the way up from
  // the focused frame, so a page containing it reports focused too. Empty before any focus.
  let focusedClientIds = [];
  class Client {
    constructor(id, url, type, frameType, controlled) {
      this.id          = String(id);
      this._url        = url || '';
      this._type       = type || 'window';
      this._frameType  = frameType || 'top-level';
      // Whether THIS worker controls the client. Every same-origin context is mirrored here,
      // because `matchAll({includeUncontrolled: true})` must see the ones we don't control.
      this._controlled = !!controlled;
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
  // A client that is a window (rather than a worker) also exposes its page-lifecycle state
  // and can be focused — `clients.matchAll().then(cs => cs[0].focus())` is how a
  // notificationclick handler raises the existing tab instead of opening a new one.
  class WindowClient extends Client {
    // Every browsing context this driver runs is on screen — there is no minimized window,
    // no background tab, and no way to hide a document — so a window client is `visible`.
    get visibilityState() { return 'visible'; }
    get focused()         { return focusedClientIds.indexOf(this.id) !== -1; }
    focus() {
      // Moving the focus chain is the browser's job (it is cross-realm state), so the request
      // rides the outbox like client.postMessage. But the browser only drains that outbox once
      // this worker's turn ENDS, so waiting for the echo would make `focus()` resolve with a
      // client that is not yet focused — and the spec resolves with the focused one. Apply it
      // to our own mirror now; the host's `client_focus` echo then agrees rather than informs.
      // The whole ancestor chain of a focused context is focused, but this worker only knows
      // the ids the host sent; claiming just this one is the honest local approximation until
      // the host's echo arrives with the full chain.
      focusedClientIds = [this.id];
      try { globalThis.__csim_swFocusClient(this.id); } catch (_) {}
      return Promise.resolve(this);
    }
    // WindowClient.navigate: navigate the client's browsing context. Unlike focus(), the answer
    // depends on where the navigation ENDED — the URL after redirects, and whether that is still
    // same-origin — so this is a real round trip: the request rides the outbox, the host performs
    // the navigation, and its reply settles the promise (__csim_swClientNavigateResult).
    navigate(url) {
      const base = (globalThis.location && globalThis.location.href) || undefined;
      let parsed;
      // "Parse url with this's associated service worker's script url as base"; a URL that doesn't
      // parse rejects with TypeError.
      try { parsed = new globalThis.URL(String(url), base); } catch (_) {
        return Promise.reject(new TypeError('Failed to parse URL: ' + url));
      }
      const target = parsed.href;
      // Only an HTTP(S) target may be navigated to. That covers about:blank (a client may not be
      // sent back to its initial document) and every non-fetchable scheme the spec rejects the same
      // way — file:///, view-source://, javascript:, data:.
      if (!/^https?:$/i.test(parsed.protocol)) {
        return Promise.reject(new TypeError('cannot navigate a client to ' + target));
      }
      // Only a client THIS worker controls may be navigated.
      if (!this._controlled) {
        return Promise.reject(new TypeError('the client is not controlled by this service worker'));
      }
      const navId = ++navSeq;
      return new Promise((resolve, reject) => {
        pendingNavigations.set(navId, {resolve, reject, client: this});
        try { globalThis.__csim_swNavigateClient(this.id, target, navId); }
        catch (e) { pendingNavigations.delete(navId); reject(new TypeError(String(e && e.message || e))); }
      });
    }
  }
  // In-flight WindowClient.navigate() calls, keyed by the id carried on the outbox request and
  // echoed back on the reply.
  const pendingNavigations = new Map();
  let navSeq = 0;
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
    if (clientId && String(clientId) !== client.id) {
      client = clientsById.get(String(clientId)) ||
               makeClient(clientId, url, 'window', client.frameType, true);
      clientsById.set(String(clientId), client);
    }
    client._url = String(url);
    pending.resolve(client);
  };
  // The host answered a `self.registration.unregister()` with the had-status —
  // resolve the oldest parked promise (FIFO: replies ride the inbox in request order).
  globalThis.__csim_swUnregisterResult = function (ok) {
    const w = globalThis.__csimSwUnregisterWaiters;
    const resolve = w && w.shift();
    if (resolve) resolve(!!ok);
  };
  function makeClient(id, url, type, frameType, controlled) {
    const Ctor = (type == null || type === 'window') ? WindowClient : Client;
    return new Ctor(id, url, type, frameType, controlled);
  }
  // Fill in a client the host registry hasn't reached — the sender of a message, or the
  // originator of a fetch — so `event.source` / `clients.get(event.clientId)` are never
  // missing. Neither path carries a client TYPE, so this GUESSES `window`, which is what a
  // client reached through a document's fetch or postMessage almost always is; a worker
  // client is reported as a window until a host registration refines it. That guess is
  // load-bearing for `matchAll`'s type filter, so it stays a guess in one place only.
  // `controlled` is NOT guessed: a fetch that reaches this SW came through it, but a
  // `registration.active.postMessage()` sender may sit entirely outside our scope — assuming
  // control there would put an uncontrolled page into the default `matchAll()`.
  function clientFor(id, url, controlled) {
    let c = clientsById.get(String(id));
    if (!c) { c = makeClient(id, url, null, null, !!controlled); clientsById.set(String(id), c); }
    else if (url && !c._url) { c._url = url; }
    return c;
  }
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
  // ServiceWorkerGlobalScope exposes the client interfaces, and code brand-checks against them:
  // clients-get-worker.js filters its results with `client instanceof Client`, which throws a
  // bare ReferenceError — hanging the whole waitUntil — if the name is missing.
  globalThis.Client       = Client;
  globalThis.WindowClient = WindowClient;
  globalThis.__csim_swNoteFocusedClient = function (ids) {
    focusedClientIds = Array.isArray(ids) ? ids.map(String) : (ids == null ? [] : [String(ids)]);
  };
  // Clients are ORIGIN-scoped: a worker never sees another origin's clients
  // (Service Workers "Query Service Worker Client Objects" filters on the service
  // worker's origin — navigation-redirect's cross-origin finals must be invisible
  // to the same-origin workers and vice versa). The host mirror broadcasts every
  // client to every worker, so the visibility cut is made here. Only a record at a
  // REAL http(s) origin is cut: an about:blank / about:srcdoc client's URL origin
  // serializes to "null" but the document INHERITS its creator's origin
  // (about-blank-replacement), and an empty / unparseable url (a lazily-guessed
  // postMessage client) has nothing to compare — both stay visible, matching the
  // pre-filter behavior those flows relied on.
  function sameOriginClient(c) {
    try {
      if (!c || !c.url) return true;
      const u = new globalThis.URL(c.url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return true;
      return u.origin === ((globalThis.location && globalThis.location.origin) || u.origin);
    } catch (_) { return true; }
  }
  class Clients {
    // claim() makes this active worker the controller of its in-scope clients: route their
    // fetches through this SW. The host sets each client's navigator.serviceWorker.controller.
    claim() { try { globalThis.__csim_swClaim(); } catch (_) {} return Promise.resolve(); }
    // Service Workers "Query Service Worker Client Objects": the focused window client comes
    // first, then the rest in CREATION order (the Map's insertion order — the host registers
    // each realm as it is built). `options.type` defaults to "window"; "all" keeps workers too.
    // `includeUncontrolled` defaults to false, which is why the mirror carries every same-origin
    // context with a `controlled` flag rather than only the ones this worker controls.
    matchAll(options) {
      const type    = (options && options.type) || 'window';
      const all     = !!(options && options.includeUncontrolled);
      const matched = Array.from(clientsById.values())
        .filter((c) => sameOriginClient(c) && (all || c._controlled) && (type === 'all' || c.type === type));
      // Focused clients first (spec order), then the rest in creation order. More than one can
      // be focused — the focused frame and every ancestor — so this is a stable partition, not
      // a single winner moved to the front.
      const focused = matched.filter((c) => c.focused);
      return Promise.resolve(focused.concat(matched.filter((c) => !c.focused)));
    }
    get(id) {
      const c = clientsById.get(String(id));
      return Promise.resolve(c && sameOriginClient(c) ? c : undefined);
    }
  }
  globalThis.Clients = Clients;
  globalThis.clients = new Clients();

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
  // ExtendableMessageEvent — the `message` event a ServiceWorkerGlobalScope receives
  // (client → SW postMessage): the MessageEvent surface (data / origin / source /
  // ports / lastEventId) on an EXTENDABLE event. A plain MessageEvent here made
  // `event.waitUntil(...)` throw BEFORE the handler's reply was posted — the
  // get-resultingClientId worker parks `event.waitUntil(testFinishPromise)` across a
  // whole test, and its 'ok' reply never left (clients-get-resultingClientId TIMEOUT).
  // waitUntil only extends the worker's lifetime — the message ACK stays
  // dispatch-synchronous (run_worker), which matches "extended lifetime" semantics.
  if (!globalThis.ExtendableMessageEvent) {
    globalThis.ExtendableMessageEvent = class ExtendableMessageEvent extends globalThis.ExtendableEvent {
      constructor(type, init) {
        super(type, init);
        const i = init || {};
        // WebIDL dictionary semantics throughout (extendable-message-event-constructor):
        // `data`'s null default applies when the member is absent OR present-as-undefined
        // (read once); `origin`/`lastEventId` String-coerce (null → 'null'); `ports` is the
        // spec FrozenArray conversion shared with MessageEvent (absent → frozen [],
        // null / non-iterable → TypeError). The internal dispatch sets `data` AFTER
        // construction, so a client's postMessage(undefined) still delivers undefined.
        const d = i.data;
        this.data        = d === undefined ? null : d;
        this.origin      = i.origin === undefined ? '' : String(i.origin);
        this.lastEventId = i.lastEventId === undefined ? '' : String(i.lastEventId);
        // `source` is `(Client or ServiceWorker or MessagePort)?` — anything else is a
        // TypeError. Each brand is guarded on the class existing in this scope (the SW
        // global has Client; a page realm constructing one has MessagePort).
        const src = i.source === undefined ? null : i.source;
        if (src !== null &&
            !(globalThis.Client       && src instanceof globalThis.Client) &&
            !(globalThis.ServiceWorker && src instanceof globalThis.ServiceWorker) &&
            !(globalThis.MessagePort  && src instanceof globalThis.MessagePort)) {
          throw new globalThis.TypeError("Failed to construct 'ExtendableMessageEvent': The provided value is not of type '(Client or ServiceWorker or MessagePort)'.");
        }
        this.source = src;
        // `ports` is `sequence<MessagePort>`: the FrozenArray conversion shared with
        // MessageEvent, plus the per-element brand check (a `[1, 2, 3]` sequence throws).
        this.ports = toFrozenPorts(i.ports);
        for (const p of this.ports) {
          if (!(globalThis.MessagePort && p instanceof globalThis.MessagePort)) {
            throw new globalThis.TypeError("Failed to construct 'ExtendableMessageEvent': ports element is not of type 'MessagePort'.");
          }
        }
      }
    };
  }

  // FetchEvent — dispatched for a controlled client's request. `respondWith(r)` supplies the
  // Response (or a Promise of one); if no handler calls it, the request falls through to network.
  if (!globalThis.FetchEvent) {
    globalThis.FetchEvent = class FetchEvent extends globalThis.ExtendableEvent {
      constructor(type, init) {
        // FetchEventInit has a `required Request request` member, so `new FetchEvent(type)` (or with no
        // request) is a TypeError (interface-requirements-sw "Event constructors"). Internal dispatch
        // always supplies a request.
        if (init == null || init.request == null) {
          throw new globalThis.TypeError("Failed to construct 'FetchEvent': Failed to read the 'request' property from 'FetchEventInit': Required member is undefined.");
        }
        super(type, init);
        this.request           = init.request;
        this.clientId          = init.clientId || '';
        this.resultingClientId = init.resultingClientId || '';
        // Navigation Preload: resolves to the browser-issued preload Response when the controlling
        // registration had preload enabled, else to undefined (the default). A SW serves it via
        // `respondWith(event.preloadResponse)`.
        this.preloadResponse   = init.preloadResponse || Promise.resolve(undefined);
        this._responded        = false;
        this._responsePromise  = null;
        this._dispatching      = false;   // set while the event is being dispatched (respondWith window)
        // FetchEvent.handled — a promise that resolves once the event is handled with a valid
        // response (or falls through to network) and rejects with a TypeError on a network-error
        // outcome (uncalled+canceled, a rejected respondWith, or a non-Response result). The
        // outcome is recorded by _settleHandled at the same point the dispatch decides the wire
        // result; the promise itself is created lazily on first `handled` read (almost no SW reads
        // it, so eager creation would allocate a promise + closures per intercepted fetch for
        // nothing). Fields are declared here so every FetchEvent shares one hidden class.
        this._handledPromise   = null;
        this._handledResolve   = null;
        this._handledReject    = null;
        this._handledSettled   = false;
        this._handledOk        = false;
        this._handledErr       = null;
      }
      // Record the final outcome (idempotent at the wire level via the dispatch `finish` guard) and
      // settle the promise if it was already materialized by a `handled` read.
      _settleHandled(ok, err) {
        this._handledSettled = true;
        this._handledOk      = ok;
        this._handledErr     = err;
        if (this._handledResolve) ok ? this._handledResolve() : this._handledReject(err);
      }
      get handled() {
        if (!this._handledPromise) {
          this._handledPromise = new Promise((resolve, reject) => {
            this._handledResolve = resolve;
            this._handledReject  = reject;
          });
          // Suppress unhandledrejection when the SW reads `handled` but ignores its rejection.
          this._handledPromise.catch(() => {});
          // A read after the outcome was already recorded replays it onto the fresh promise.
          if (this._handledSettled) this._handledOk ? this._handledResolve() : this._handledReject(this._handledErr);
        }
        return this._handledPromise;
      }
      respondWith(r) {
        // respondWith is only valid DURING dispatch (synchronously in the handler): calling it from a
        // later task/microtask, after the event finished dispatching, is an InvalidStateError — as is
        // calling it twice. (FetchEvent "respond with" checks the dispatch + respond-with flags.)
        if (!this._dispatching) throw new globalThis.DOMException('respondWith called outside the fetch event dispatch', 'InvalidStateError');
        if (this._responded)    throw new globalThis.DOMException('respondWith called twice', 'InvalidStateError');
        this._responded = true;
        this._responsePromise = Promise.resolve(r);
        // FetchEvent "respond with" sets the event's stop-propagation and
        // stop-immediate-propagation flags, so no later `fetch` listener runs
        // once one has responded.
        this.stopImmediatePropagation();
      }
    };
  }

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
  const routerBuildPattern = raw => {
    const base = (globalThis.location && globalThis.location.href) || undefined;
    let pattern;
    if (globalThis.URLPattern && raw instanceof globalThis.URLPattern) pattern = raw;
    else if (typeof raw === 'string') pattern = new globalThis.URLPattern(raw, base);
    else if (raw && typeof raw === 'object') {
      // URLPatternInit: the SW script's URL is the default baseURL ("build a
      // URLPattern from a URLPatternCompatible"); an explicit member wins.
      pattern = new globalThis.URLPattern(Object.assign({ baseURL: base }, raw));
    } else {
      throw new globalThis.TypeError('addRoutes: invalid urlPattern condition');
    }
    // Spec "verify a router condition": a pattern with regexp groups is rejected
    // (its exec cost is unbounded for a per-request static route).
    if (pattern.hasRegExpGroups) throw new globalThis.TypeError('addRoutes: urlPattern with regexp groups is not allowed');
    return pattern;
  };
  const ROUTER_REQUEST_MODES        = ['navigate', 'same-origin', 'no-cors', 'cors'];
  const ROUTER_REQUEST_DESTINATIONS = ['', 'audio', 'audioworklet', 'document', 'embed', 'font', 'frame', 'iframe', 'image', 'json', 'manifest', 'object', 'paintworklet', 'report', 'script', 'sharedworker', 'style', 'track', 'video', 'worker', 'xslt'];
  const routerEnum = (raw, allowed, what) => {
    const s = String(raw);
    if (!allowed.includes(s)) throw new globalThis.TypeError('addRoutes: invalid ' + what + " '" + s + "'");
    return s;
  };
  const routerNormalizeMethod = raw => {
    const s = String(raw);
    // WebIDL ByteString: any code unit above 0xFF is a conversion TypeError.
    for (let i = 0; i < s.length; i++) {
      if (s.charCodeAt(i) > 0xFF) throw new globalThis.TypeError('addRoutes: requestMethod is not a valid ByteString');
    }
    // Fetch "method" token, then the forbidden set, then normalize known methods.
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(s)) throw new globalThis.TypeError('addRoutes: requestMethod is not a valid HTTP method');
    if (/^(CONNECT|TRACE|TRACK)$/i.test(s)) throw new globalThis.TypeError('addRoutes: requestMethod is a forbidden method');
    return /^(DELETE|GET|HEAD|OPTIONS|POST|PUT)$/i.test(s) ? s.toUpperCase() : s;
  };
  const routerParseCondition = (c, depth) => {
    if (depth > ROUTER_MAX_CONDITION_DEPTH) throw new globalThis.TypeError('addRoutes: condition exceeds the depth limit');
    if (!c || typeof c !== 'object') throw new globalThis.TypeError('addRoutes: invalid condition');
    const out = {};
    let members = 0;
    if (c.or !== undefined) {
      // WebIDL sequence conversion: a non-iterable (or a string) is a TypeError,
      // not an empty — silently-never-matching — condition list.
      if (!c.or || typeof c.or !== 'object' || typeof c.or[globalThis.Symbol.iterator] !== 'function') {
        throw new globalThis.TypeError('addRoutes: or condition must be a sequence');
      }
      out.or = Array.from(c.or, x => routerParseCondition(x, depth + 1));
      members++;
    }
    if (c.not !== undefined) { out.not = routerParseCondition(c.not, depth + 1); members++; }
    if (c.urlPattern !== undefined)         { out.urlPattern = routerBuildPattern(c.urlPattern); members++; }
    if (c.requestMethod !== undefined)      { out.requestMethod = routerNormalizeMethod(c.requestMethod); members++; }
    if (c.requestMode !== undefined)        { out.requestMode = routerEnum(c.requestMode, ROUTER_REQUEST_MODES, 'requestMode'); members++; }
    if (c.requestDestination !== undefined) { out.requestDestination = routerEnum(c.requestDestination, ROUTER_REQUEST_DESTINATIONS, 'requestDestination'); members++; }
    if (c.runningStatus !== undefined)      { out.runningStatus = routerEnum(c.runningStatus, ['running', 'not-running'], 'runningStatus'); members++; }
    if (members === 0) throw new globalThis.TypeError('addRoutes: condition has no members');
    // `or` (and `not`) is exclusive of every other member per the spec's verify step.
    if ((out.or || out.not) && members > 1) throw new globalThis.TypeError('addRoutes: or/not cannot be combined with other conditions');
    return out;
  };
  const routerParseSource = s => {
    if (s === 'network' || s === 'cache' || s === 'fetch-event' || s === 'race-network-and-fetch-handler') return s;
    if (s && typeof s === 'object' && s.cacheName !== undefined) return { cacheName: String(s.cacheName) };
    throw new globalThis.TypeError('addRoutes: invalid source');
  };
  globalThis.__csim_swAddRoutes = function (rules) {
    // IDL: (RouterRule or sequence<RouterRule>) — a bare dict is one rule.
    const list = (rules && typeof rules === 'object' && typeof rules[globalThis.Symbol.iterator] === 'function')
      ? Array.from(rules) : [rules];
    const parsed = list.map(rule => {
      if (!rule || typeof rule !== 'object') throw new globalThis.TypeError('addRoutes: invalid rule');
      if (rule.condition == null) throw new globalThis.TypeError('addRoutes: rule has no condition');
      if (rule.source == null)    throw new globalThis.TypeError('addRoutes: rule has no source');
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
  // The install event's interface in a ServiceWorkerGlobalScope — addRoutes is
  // its only member beyond ExtendableEvent. Validation is synchronous; the
  // promise carries the outcome (the WPT worker awaits + records the rejection).
  if (!globalThis.InstallEvent) {
    globalThis.InstallEvent = class InstallEvent extends globalThis.ExtendableEvent {
      addRoutes(rules) {
        try { globalThis.__csim_swAddRoutes(rules); } catch (e) { return Promise.reject(e); }
        return Promise.resolve(undefined);
      }
    };
  }

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
      // A NAVIGATION carries its initiator origin (the navigating frame's) + the redirect chain's
      // latched Sec-Fetch-Site seed / Origin taint, so a passthrough `fetch(event.request)` re-fetch
      // reports the frame's Origin / Sec-Fetch-Site to the server (a `new Request(event.request,init)`
      // re-fetch resets them to this SW's own origin — see the Request constructor).
      if (r.initiator != null)        req._csimInitiator = r.initiator;
      if (r.siteSeed != null)         req._csimSiteSeed = r.siteSeed;
      if (r.originNull)               req._csimOriginNull = true;
      // The ancestor-chain cookie verdict of the frame this navigation commits into
      // (RFC 6265bis site-for-cookies): a property of the TARGET FRAME, so unlike the
      // initiator it survives `new Request(event.request, init)` (see the Request ctor).
      if (r.cookieCrossSite)          req._csimCookieCrossSite = true;
      // A navigation request's default credentials mode is 'include' (Fetch "create navigation
      // request") — reflect it on the SW-visible request when the wire didn't specify. The nav
      // redirect mode 'manual' rides the wire (service_worker_navigation_fetch): a passthrough
      // `fetch(event.request)` of a redirecting URL yields an opaqueredirect, which the
      // navigation consuming the respondWith FOLLOWS (the private redirect_loc channel).
      if (req._mode === 'navigate' && !r.credentials) req._credentials = 'include';
      // Handle Fetch hands the SW a request whose header list is IMMUTABLE — an
      // `event.request.headers.append(...)` throws (request-end-to-end); a SW that wants
      // modified headers builds `new Request(event.request, {headers})`, whose copy gets
      // the mutable 'request' guard as usual.
      req.headers._guard = 'immutable';
    } catch (_) { req = null; }
    // clientId = the client that MADE the request; resultingClientId = the client the request
    // CREATES. A navigation has no initiating client (clientId '') but reserves the resulting
    // client (the document it will load); a subresource is the reverse — its client made it, and it
    // creates none (resultingClientId ''). The client is keyed by the ORIGINATING realm
    // (`client-<realm>`, matching sw-client.js clientId() + the browser registry); the main/top realm
    // ── Static Routing API: the registered router rules are evaluated BEFORE any
    // fetch event exists (Handle Fetch's router evaluation precedes the event
    // dispatch — a 'network'-routed request must never run the fetch handler).
    // 'race-network-and-fetch-handler' falls through to the plain fetch-event
    // dispatch for now (the race semantics are a follow-up; those subtests stay
    // honestly red).
    const routerSource = routerMatchSource(req);
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
        return resp.arrayBuffer().then(buf => respondWire(JSON.stringify(serializeResponseWire(resp, new globalThis.Uint8Array(buf)))));
      }).catch(() => respondWire(JSON.stringify({ fallthrough: true })));
      return;
    }
    // (realmId 0) is 'client-window'.
    const isNav     = req && req._mode === 'navigate';
    // The FETCHING client's id: the wire value (the client's own identity, possibly an
    // adopted reserved id) when present; the realm-derived key is the fallback.
    const clientKey = wireClientId || ((realmId | 0) > 0 ? ('client-' + (realmId | 0)) : 'client-window');
    // A controlled client that FETCHES is a Client even if it never postMessaged the SW — register
    // it lazily here (url = the request's referrer, i.e. the requesting document) so
    // `clients.get(event.clientId)` / matchAll resolve it. (Not for a navigation: the resulting
    // client's document doesn't exist yet.)
    if (!isNav) { try { clientFor(clientKey, reqReferrer, true); } catch (_) {} }
    // Navigation Preload: rebuild the browser-issued preload response (present only when preload was
    // enabled) as a resolved `event.preloadResponse` the SW can `respondWith`. Built in ITS OWN try —
    // a preload response header the Headers constructor rejects must only drop the preload, never null
    // the request the FetchEvent carries. (A failed/disabled preload leaves it the default undefined;
    // the spec distinction — a FAILED preload rejects — is a fidelity gap no vendored subtest covers.)
    if (preloadWire) {
      try {
        const body = preloadWire.body_b64 ? latin1ToBytes(globalThis.atob(preloadWire.body_b64)) : new globalThis.Uint8Array(0);
        preloadResponse = Promise.resolve(new globalThis.Response(body, {status: preloadWire.status, statusText: preloadWire.statusText, headers: preloadWire.headers}));
      } catch (_) { preloadResponse = undefined; }
    }
    const ev = new globalThis.FetchEvent('fetch', {
      request:           req,
      clientId:          isNav ? '' : clientKey,
      // A navigation falls back to the realm key; a NON-nav request (a worker
      // MAIN-SCRIPT fetch) uses the wire value when the host supplied one —
      // the script request CREATES the worker's client.
      resultingClientId: navResultingId || (isNav ? clientKey : ''),
      preloadResponse:   preloadResponse,
      cancelable:        true   // a FetchEvent is cancelable — preventDefault() (no respondWith) = network error
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
    // Single owner of the wire-outcome ⟺ `handled`-outcome pairing: deliver the wire result and
    // settle `event.handled` together, exactly once. `ok` resolves handled (valid response /
    // network fallthrough); otherwise handled rejects with the network-error TypeError a real
    // browser surfaces. The `finished` guard makes it structurally impossible to double-deliver
    // or leave `handled` unsettled once any outcome is reached.
    let finished = false;
    const finish = (wireJson, ok, err) => {
      if (finished) return;
      finished = true;
      ev._settleHandled(ok, err);
      done(wireJson);
    };
    const networkError = () => finish(JSON.stringify({networkError: true}), false, new globalThis.TypeError('ServiceWorker fetch event resulted in a network error'));
    // No respondWith: if the handler called preventDefault() the fetch is a NETWORK ERROR (Handle
    // Fetch cancels a request whose event was canceled without a response); otherwise it falls
    // through to the network (fetch-event-network-error) — a successful outcome.
    if (!ev._responded) {
      if (ev.defaultPrevented) networkError();
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
      try { reader = resp.body.getReader(); } catch (_) { networkError(); return; }
      finished = true;                 // committed to the stream outcome — no single-shot done can fire
      ev._settleHandled(true);         // the response is handled the moment its head is delivered
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
        emit('chunk', globalThis.btoa(bytesToLatin1(bytes)));
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
        if (!(resp instanceof globalThis.Response) || resp.type === 'error') { networkError(); return; }
        // Streaming delivery only for REALM clients (realmId ≥ 0): the fr_* frame route
        // realm_calls the target, which for a WORKER client (negative realmId — a
        // controlled worker's fetch, or a direct main-script fetch) would misroute to the
        // MAIN realm and could resolve the wrong same-numbered fetch. A worker client
        // gets the buffered single-shot body instead; incremental streaming INTO a worker
        // isolate is a follow-up.
        if (resp._bodyIsStream && fetchId > 0 && (realmId | 0) >= 0) return streamDeliver(resp);
        return resp.arrayBuffer().then(buf => finish(JSON.stringify(serializeResponseWire(resp, new globalThis.Uint8Array(buf))), true));
      })
      .catch(networkError);
  };
  // A client → SW `postMessage` arrives here (host-driven from run_worker). Dispatch a
  // `message` event on the SW global whose `source` is the posting Client, so the SW's
  // handler (and the WPT ServiceWorkerTestEnvironment) can reply via `event.source`.
  globalThis.__csim_swClientMessage = function (dataStr, clientId, clientURL) {
    let data = null, ports = [];
    try { ({ data, ports } = decodeMessage(dataStr)); } catch (_) {}
    const source = clientFor(clientId == null ? 'client' : clientId, clientURL, false);
    // MessageEvent.origin is the SENDER's (the posting client's) origin, derived from its URL.
    let origin = '';
    try { origin = clientURL ? new globalThis.URL(clientURL).origin : ''; } catch (_) {}
    // An ExtendableMessageEvent, NOT a plain MessageEvent — SW message handlers may
    // `event.waitUntil(...)` (see the class definition above). `data` is set after
    // construction: the dictionary's null default must not swallow a client's
    // postMessage(undefined).
    const ev = new globalThis.ExtendableMessageEvent('message', {origin, source, ports});
    ev.data = data;
    dispatchWithOnHandler(globalThis, ev);
    // An unsettled `event.waitUntil(...)` EXTENDS this worker's lifetime: while any are
    // pending, an installed successor must keep waiting — even past skipWaiting —
    // until they settle (activation.https: the in-flight 'wait' request holds the new
    // version in `waiting`; 'go' releases it). Tracked as a counter whose transitions
    // ride to the host (run_worker's `extended` hook → try-activate on reaching 0).
    const exts = ev._extendLifetimePromises || [];
    if (exts.length) {
      globalThis.__csimSwPendingExts = (globalThis.__csimSwPendingExts | 0) + 1;
      try { globalThis.__csim_swExtendedChanged(globalThis.__csimSwPendingExts); } catch (_) {}
      Promise.allSettled(exts).then(() => {
        globalThis.__csimSwPendingExts = (globalThis.__csimSwPendingExts | 0) - 1;
        try { globalThis.__csim_swExtendedChanged(globalThis.__csimSwPendingExts); } catch (_) {}
      });
    }
  };
  // A version slot of the worker's own registration mirror (`self.registration.
  // installing/waiting/active`): scriptURL + state + a real `statechange`, which
  // registration-attribute-worker listens on. Distinct objects from the client
  // realms' ServiceWorker instances, as the spec has them (one per global).
  class SwVersionMirror extends EventTarget {
    constructor(scriptURL, state) {
      super();
      this._scriptURL = scriptURL;
      this._state     = state;
    }
    get scriptURL() { return this._scriptURL; }
    get state()     { return this._state; }
    _setState(s) {
      if (this._state === s) return;
      this._state = s;
      dispatchWithOnHandler(this, new Event('statechange'));
    }
  }
  defineEventHandlers(SwVersionMirror.prototype, ['statechange']);
  const reg = new EventTarget();
  Object.assign(reg, {
    // The registration's scope URL, threaded from register() through worker_spawn
    // (`__csimSwScope`). The script-URL fallback covers a spawn path that carries no
    // scope (a directly-spawned service:true worker outside register()).
    scope:      globalThis.__csimSwScope || (globalThis.location && globalThis.location.href) || '',
    // The spawn-time snapshot of the registration's ACTIVE version (an update spawns
    // this worker while the previous one runs — registration-attribute's newer
    // worker asserts `active` names the old script during its own install). The
    // mirror otherwise tracks only THIS worker's lifecycle: another version
    // installing later, in its own isolate, is a cross-isolate signal we don't
    // relay (no vendored subtest reads it from the outgoing worker's side).
    active:     globalThis.__csimSwPrevActiveUrl ? new SwVersionMirror(globalThis.__csimSwPrevActiveUrl, 'activated') : null,
    installing: null, waiting: null,
    update() {
      // Update from a service worker whose OWN install is still running rejects
      // (spec Update job: promote-then-reject when the job's worker is the
      // registration's installing worker — update-not-allowed "from installing
      // service worker throws"). The mirror knows: during the install phase the
      // installing slot holds this worker at state 'installing'.
      const inst = reg.installing;
      if (inst && inst.state === 'installing') {
        return Promise.reject(new globalThis.DOMException('update() is not allowed from an installing service worker', 'InvalidStateError'));
      }
      // From an installed/active worker: resolve without re-running Update — the
      // real worker-side Soft Update job (outbox route) is the SWGlobalScope/update
      // backlog item.
      return Promise.resolve(reg);
    },
    // `self.registration.unregister()` — the registration lives host-side (and as
    // per-realm client objects), so the request rides the outbox and the promise
    // parks until the host's `unregister_result` answers with the had-status. The
    // host runs the SAME unregister job as the client-side call: scope unmapped
    // everywhere, Clear Registration deferred while clients use the registration —
    // which is why this worker may be terminated before the reply ever arrives
    // (an uncontrolled registration clears immediately); the unresolved promise
    // dies with the isolate, exactly like a real terminated worker's.
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
    // The worker's own lifecycle, mirrored into the registration slots as it
    // advances (driven by __csim_swFireLifecycleEvent / __csim_swPhaseTake, so
    // each transition lands exactly where an observer sees it: `updatefound`
    // before the install event, `statechange(installed)` once the install
    // waitUntil settled, `statechange(activating)` before the activate event,
    // `statechange(activated)` once activation completed).
    _updatefound() {
      this.installing = new SwVersionMirror((globalThis.location && globalThis.location.href) || '', 'installing');
      dispatchWithOnHandler(this, new Event('updatefound'));
    },
    _installed() {
      const w = this.installing;
      if (!w) return;
      this.installing = null;
      this.waiting    = w;
      w._setState('installed');
    },
    _activating() {
      const w = this.waiting || this.installing;
      if (!w) return;
      this.waiting = this.installing = null;
      this.active  = w;   // the outgoing snapshot version is replaced at handover
      w._setState('activating');
    },
    _activated()     { if (this.active) this.active._setState('activated'); },
    _installFailed() {
      const w = this.installing;
      if (!w) return;
      this.installing = null;
      w._setState('redundant');
    }
  });
  // `self.registration.navigationPreload` — the same NavigationPreloadManager surface the client
  // sees, sharing the Ruby-held state keyed by THIS worker's handle (it is the registration's
  // active worker, so the handle is always present → enable/setHeaderValue never reject here).
  // defineProperty, NOT part of the Object.assign literal: assign would INVOKE a
  // source getter once (eagerly, with the literal as `this`) instead of copying it.
  Object.defineProperty(reg, 'navigationPreload', {
    configurable: true,
    get() { return this._navPreload || (this._navPreload = new globalThis.NavigationPreloadManager(() => globalThis.__csimWorkerHandle)); }
  });
  defineEventHandlers(reg, ['updatefound']);
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
  const reg = globalThis.registration;
  if (reg && type === 'install'  && reg._updatefound) reg._updatefound();
  if (reg && type === 'activate' && reg._activating)  reg._activating();
  // The install event is an InstallEvent (addRoutes — the Static Routing API)
  // in a ServiceWorkerGlobalScope; activate (and any non-SW caller) stays a
  // plain ExtendableEvent.
  const Ctor = (type === 'install' && globalThis.InstallEvent) || globalThis.ExtendableEvent;
  const ev = new Ctor(type);
  dispatchWithOnHandler(globalThis, ev);
  const st = { phase: type, done: false, ok: true };
  globalThis.__csimSwPhaseState = st;
  // allSettled: a rejected waitUntil must not short-circuit the wait — the state
  // transition happens only after EVERY extend-lifetime promise settled
  // (extendable-event-waituntil "reject precedence").
  Promise.allSettled(ev._extendLifetimePromises || []).then(results => {
    st.done = true;
    st.ok   = results.every(r => r.status === 'fulfilled');
  });
};

// One-shot read of a settled lifecycle phase: null while the current phase's
// waitUntil promises are still pending, `{phase, ok}` once they all settled.
// Settlement is also where the registration mirror's post-phase statechange
// lands: installed / redundant for install (by outcome), activated for activate.
globalThis.__csim_swPhaseTake = function () {
  const st = globalThis.__csimSwPhaseState;
  if (!st || !st.done) return null;
  globalThis.__csimSwPhaseState = null;
  const reg = globalThis.registration;
  if (reg && st.phase === 'install' && reg._installed) (st.ok ? reg._installed() : reg._installFailed());
  if (reg && st.phase === 'activate' && reg._activated) reg._activated();
  return { phase: st.phase, ok: st.ok };
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
