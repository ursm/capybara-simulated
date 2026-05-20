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
  }
};

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

// `structuredClone` — deep clone via JSON for the JSON-safe subset.
// Real structuredClone covers Map/Set/Date/typed arrays/cycles;
// we fall back to a no-clone passthrough on JSON failure.
globalThis.structuredClone = function structuredClone(v) {
  if (v == null || typeof v !== 'object') return v;
  try { return JSON.parse(JSON.stringify(v)); }
  catch (_) { return v; }
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
