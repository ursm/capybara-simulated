// Closure-free Web platform stubs. Just enough surface that
// feature-detection ("typeof CSS !== 'undefined'", "performance.now",
// "navigator.crypto.randomUUID") returns truthy and modern code paths
// don't crash on a missing global.

const VIEWPORT_W = 1024;
const VIEWPORT_H = 768;

// Web Crypto API — minimal `crypto.randomUUID()` and
// `crypto.getRandomValues(typedArray)`. Backed by SecureRandom on
// the Ruby side. Tagify, ActiveStorage's DirectUpload, and many
// libraries call `crypto.getRandomValues` for IDs/checksums; in
// browsers `crypto` lives on `globalThis` directly (it's
// `WindowOrWorkerGlobalScope`-mixed), so apps don't even
// feature-detect it. Without this, Tagify's `getUID` throws
// ReferenceError mid-`addTags` and the whole `<tag>` render
// pipeline silently aborts inside Stimulus's `connect` catch.
function bytesFromBuffer(src) {
  if (!src) return [];
  if (Array.isArray(src)) return src;
  if (typeof src.byteLength === 'number') {
    const view = src.buffer instanceof ArrayBuffer
      ? new Uint8Array(src.buffer, src.byteOffset || 0, src.byteLength)
      : new Uint8Array(src);
    const out = new Array(view.length);
    for (let i = 0; i < view.length; i++) out[i] = view[i];
    return out;
  }
  return [];
}

globalThis.crypto = {
  randomUUID() {
    return typeof globalThis.__csim_randomUUID === 'function'
      ? String(globalThis.__csim_randomUUID())
      : '00000000-0000-0000-0000-000000000000';
  },
  getRandomValues(typedArray) {
    if (!typedArray || typeof typedArray.length !== 'number') return typedArray;
    const bytes = typeof globalThis.__csim_randomBytes === 'function'
      ? globalThis.__csim_randomBytes(typedArray.length)
      : new Array(typedArray.length).fill(0);
    const arr = bytes || [];
    for (let i = 0; i < typedArray.length; i++) {
      typedArray[i] = (arr[i] | 0) & 0xff;
    }
    return typedArray;
  },
  // SubtleCrypto.digest — Uppy's checksum plugin / subresource hash
  // libraries / anti-CSRF token derivation feature-probe
  // `crypto.subtle?.digest`. Returns the digest in an ArrayBuffer so
  // the async chain resolves; signing/key generation stay out of scope.
  subtle: {
    digest(algo, data) {
      const fn = globalThis.__csim_subtleDigest;
      if (typeof fn !== 'function') return Promise.reject(new Error('SubtleCrypto.digest unavailable'));
      const bytes = bytesFromBuffer(data);
      try {
        const out = fn(String(algo || ''), bytes);
        const arr = Array.isArray(out) ? out : [];
        const buf = new ArrayBuffer(arr.length);
        const view = new Uint8Array(buf);
        for (let i = 0; i < arr.length; i++) view[i] = arr[i] & 0xff;
        return Promise.resolve(buf);
      } catch (e) {
        return Promise.reject(e);
      }
    }
  }
};
globalThis.isSecureContext = true;

// `screen` is a fixed viewport; libraries probe it for HiDPI /
// responsive decisions and we fall to the "small desktop" branch.
globalThis.devicePixelRatio = 1;
globalThis.screen = {
  width: VIEWPORT_W,      height: VIEWPORT_H,
  availWidth: VIEWPORT_W, availHeight: VIEWPORT_H,
  colorDepth: 24,         pixelDepth: 24,
  orientation: { angle: 0, type: 'landscape-primary' }
};

// Single-window runtime, so every frame-aware reference points at
// the same global (or null for frameElement — we're not framed).
globalThis.self         = globalThis;
globalThis.top          = globalThis;
globalThis.parent       = globalThis;
globalThis.frames       = globalThis;
globalThis.frameElement = null;

globalThis.pageXOffset = 0;
globalThis.pageYOffset = 0;
globalThis.scrollX     = 0;
globalThis.scrollY     = 0;
globalThis.innerWidth  = VIEWPORT_W;
globalThis.innerHeight = VIEWPORT_H;
globalThis.outerWidth  = VIEWPORT_W;
globalThis.outerHeight = VIEWPORT_H;
globalThis.scrollTo    = function () {};
globalThis.scrollBy    = function () {};
globalThis.scroll      = function () {};

// `CSS.escape(s)` per CSSOM — serialise `s` as a CSS identifier
// (control chars become `\xx ` hex escapes, leading digits / `-`
// get escaped, etc.). Turbo Drive's `extractForeignFrameElement`
// builds `\`turbo-frame#${CSS.escape(this.id)}\`` to scope its
// `querySelector` to the right frame; without `CSS` the whole
// chain throws and `turbo-frame[loading=lazy]` content never
// renders. `supports()` defaults to `true` so feature gates take
// the modern path; tests that rely on the legacy fallback would
// need a real cascade to verify anyway.
globalThis.CSS = {
  escape(value) {
    if (arguments.length === 0) throw new TypeError('CSS.escape requires an argument.');
    const s = String(value);
    const len = s.length;
    const first = s.charCodeAt(0);
    if (len === 1 && first === 0x002D) return '\\-';
    let out = '';
    for (let i = 0; i < len; i++) {
      const c = s.charCodeAt(i);
      if (c === 0) { out += '�'; continue; }
      if ((c >= 0x0001 && c <= 0x001F) || c === 0x007F ||
          (i === 0 && c >= 0x0030 && c <= 0x0039) ||
          (i === 1 && c >= 0x0030 && c <= 0x0039 && first === 0x002D)) {
        out += '\\' + c.toString(16) + ' ';
        continue;
      }
      if (c >= 0x0080 || c === 0x002D || c === 0x005F ||
          (c >= 0x0030 && c <= 0x0039) ||
          (c >= 0x0041 && c <= 0x005A) ||
          (c >= 0x0061 && c <= 0x007A)) {
        out += s.charAt(i);
        continue;
      }
      out += '\\' + s.charAt(i);
    }
    return out;
  },
  supports() { return true; }
};

// `performance.now()` returns ms since the runtime started — not the
// virtual JS clock, since most callers (perf timing, jitter
// smoothing) want monotonic wall time, not virtual ticks.
const perfStart = Date.now();
globalThis.performance = {
  now()        { return Date.now() - perfStart; },
  timeOrigin:   perfStart,
  timing:      { navigationStart: perfStart },
  mark()       {},
  measure()    {},
  getEntries() { return []; },
  getEntriesByName() { return []; },
  getEntriesByType() { return []; },
  clearMarks()    {},
  clearMeasures() {}
};

// `structuredClone` — Redux Toolkit and Immer probe it for state
// cloning; the JSON-only fallback silently dropped Map/Set/Date and
// died on cycles. Spec-compliant clone of the common types.
globalThis.structuredClone = function structuredClone(v, _options, seen) {
  if (v == null || typeof v !== 'object') return v;
  seen = seen || new Map();
  if (seen.has(v)) return seen.get(v);
  if (v instanceof Date) {
    const d = new Date(v.getTime());
    seen.set(v, d);
    return d;
  }
  if (v instanceof RegExp) {
    const r = new RegExp(v.source, v.flags);
    seen.set(v, r);
    return r;
  }
  if (v instanceof Map) {
    const out = new Map();
    seen.set(v, out);
    for (const [k, val] of v) out.set(structuredClone(k, _options, seen), structuredClone(val, _options, seen));
    return out;
  }
  if (v instanceof Set) {
    const out = new Set();
    seen.set(v, out);
    for (const x of v) out.add(structuredClone(x, _options, seen));
    return out;
  }
  if (v instanceof ArrayBuffer) {
    const copy = new ArrayBuffer(v.byteLength);
    new Uint8Array(copy).set(new Uint8Array(v));
    seen.set(v, copy);
    return copy;
  }
  if (ArrayBuffer.isView && ArrayBuffer.isView(v)) {
    const Ctor = v.constructor;
    const buf  = structuredClone(v.buffer, _options, seen);
    const out  = new Ctor(buf, v.byteOffset, v.length);
    seen.set(v, out);
    return out;
  }
  if (Array.isArray(v)) {
    const out = new Array(v.length);
    seen.set(v, out);
    for (let i = 0; i < v.length; i++) out[i] = structuredClone(v[i], _options, seen);
    return out;
  }
  const out = {};
  seen.set(v, out);
  for (const k of Object.keys(v)) out[k] = structuredClone(v[k], _options, seen);
  return out;
};

// `reportError(error)` — spec: dispatch error event on global, log
// if unhandled. Logging is enough for our scenarios.
globalThis.reportError = function reportError(e) {
  try { console.error(e && e.stack ? e.stack : String(e)); } catch (_) {}
};

// `requestIdleCallback` / `cancelIdleCallback` — fall back to
// `setTimeout(0)` so libraries that defer expensive setup to idle
// (Turbo Drive prefetch, Stimulus debounced renders) make progress.
globalThis.requestIdleCallback = function (cb) {
  return globalThis.setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 0 }), 0);
};
globalThis.cancelIdleCallback = function (id) { globalThis.clearTimeout(id); };

// `NodeFilter` constants — DOMPurify constructs TreeWalker /
// NodeIterator with these masks. We don't ship a full TreeWalker
// (no consumer in the failing set yet), but the constants need to
// exist so the constructor call doesn't throw.
globalThis.NodeFilter = {
  SHOW_ALL:                    0xFFFFFFFF,
  SHOW_ELEMENT:                1,
  SHOW_ATTRIBUTE:              2,
  SHOW_TEXT:                   4,
  SHOW_CDATA_SECTION:          8,
  SHOW_PROCESSING_INSTRUCTION: 64,
  SHOW_COMMENT:                128,
  SHOW_DOCUMENT:               256,
  SHOW_DOCUMENT_TYPE:          512,
  SHOW_DOCUMENT_FRAGMENT:      1024,
  FILTER_ACCEPT: 1,
  FILTER_REJECT: 2,
  FILTER_SKIP:   3
};
