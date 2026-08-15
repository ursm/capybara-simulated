// Closure-free Web platform stubs. Just enough surface that
// feature-detection ("typeof CSS !== 'undefined'", "performance.now",
// "navigator.crypto.randomUUID") returns truthy and modern code paths
// don't crash on a missing global.

import { EventTarget, MessageEvent, dispatchWithOnHandler, defineEventHandler, defineEventHandlers } from './events.js';
import { detachTransferables, transferListFrom } from './bytes.js';
import { installWebCrypto } from './webcrypto.js';
import { isSupportedCssPropertyName } from './css-utils.js';
import { normalizeDataFormat } from './mime.js';

// The display. The window starts out filling it, `resize_to` moves the window off it, and
// `maximize` / `fullscreen` restore it. Mirrored Ruby-side as `Browser::SCREEN_SIZE`
// (spec/viewport_resize_spec.rb asserts the two agree, so they can't drift apart).
const SCREEN_W = 1024;
const SCREEN_H = 768;

// Web Crypto API — `crypto` (getRandomValues / randomUUID), `crypto.subtle`
// (SubtleCrypto), and CryptoKey, backed by Ruby's OpenSSL. In browsers `crypto`
// is a WindowOrWorkerGlobalScope member on `globalThis`, so apps don't
// feature-detect it: Tagify's `getUID`, ActiveStorage's DirectUpload, and every
// auth stack call it directly. See js/src/webcrypto.js for the operation set.
installWebCrypto(globalThis);
globalThis.isSecureContext = true;

// `screen.orientation` is an EventTarget (it announces `change` as the device rotates).
// A fixed viewport never rotates, so `change` never fires — but the EventTarget surface
// has to exist regardless, because listening is unconditional in the wild and an object
// that is truthy-but-not-an-EventTarget passes an `if (screen.orientation)` guard and
// then throws on addEventListener. Values match headless Chrome on a desktop profile,
// down to `lock()` rejecting NotSupportedError and `unlock()` being a no-op.
class ScreenOrientation extends EventTarget {
  get angle() { return 0; }
  get type()  { return 'landscape-primary'; }
  lock()      { return globalThis.Promise.reject(new globalThis.DOMException('screen.orientation.lock() is not available on this device.', 'NotSupportedError')); }
  unlock()    {}
  get [Symbol.toStringTag]() { return 'ScreenOrientation'; }
}
defineEventHandler(ScreenOrientation.prototype, 'change');
globalThis.ScreenOrientation = ScreenOrientation;

// `screen` is the DISPLAY, not the window: it stays put while `resize_to` moves the viewport,
// exactly as a real browser's does, and it is what `maximize` / `fullscreen` resize back to.
// Libraries probe it for HiDPI / responsive decisions and we fall to the "small desktop" branch.
globalThis.devicePixelRatio = 1;
globalThis.screen = {
  width: SCREEN_W,      height: SCREEN_H,
  availWidth: SCREEN_W, availHeight: SCREEN_H,
  colorDepth: 24,         pixelDepth: 24,
  orientation: new ScreenOrientation()
};

// Single-window runtime, so every frame-aware reference points at
// the same global (or null for frameElement — we're not framed).
globalThis.self         = globalThis;
globalThis.top          = globalThis;
globalThis.parent       = globalThis;
globalThis.frameElement = null;

// `self.origin` / `window.origin` — the document's origin. For a normal page /
// real-URL frame it's the serialized location origin; a frame whose document
// origin differs from its location origin carries it in `__csimDocumentOrigin`
// (set at frame build): an opaque-URL frame (about:blank / srcdoc / javascript:)
// inherits its parent's origin, and a sandboxed-without-allow-same-origin frame
// is the opaque "null". Read for CORS / postMessage-target checks.
// (self-origin.sub.)
//
// Read-only Window / WindowOrWorkerGlobalScope members live on the global's PROTOTYPE in
// real browsers (Window.prototype), not as own properties. That's load-bearing here: a
// top-level classic script must be able to shadow one with its own `var` — e.g.
// `for (var origin of …)` (redirect-mode) or `var scrollX`. An OWN accessor can't be
// redefined by `var`, so the assignment silently no-ops (or, for a non-configurable own
// accessor, throws at declaration), pinning the variable to the live global. Defining
// them on the prototype lets `var` create a shadowing own data property, as browsers do.
// On V8 the global's prototype is a dedicated Window-like object, so accessors defined there
// stay in the Window chain (and a top-level `var origin` can shadow them with an own property).
// On QuickJS the global's prototype IS Object.prototype, so defining them there would pollute
// EVERY object's chain — a bare `<span>` would gain `origin`/`scrollX` (idl-leak check), and a
// `MessageEvent` constructor's `this.origin = …` would hit the getter-only accessor. In that
// case put them as OWN accessors on globalThis (the `var`-shadow nicety only matters to a WPT
// test the QuickJS engine doesn't run).
const __windowProto = Object.getPrototypeOf(globalThis);
// The prototype an ORDINARY object reaches — i.e. what a `<span>` inherits from. On V8 this is
// distinct from the Window prototype; on QuickJS the global's prototype IS this shared object.
const __sharedObjectProto = Object.getPrototypeOf({});
// `replaceable: true` implements WebIDL `[Replaceable]` (every viewport / scroll attribute below
// carries it): assigning to the attribute REPLACES it with a plain own data property on the window
// instead of throwing in strict mode / silently no-opping in sloppy mode. Real browsers behave this
// way, and page code does assign these — a device-emulation shim setting `window.innerWidth` must
// not abort the script, and equally must NOT move the driver's viewport (the getter is simply gone
// for that page from then on).
function defineWindowAccessor(name, get, {replaceable = false} = {}) {
  const desc = {configurable: true, get};
  if (replaceable) {
    desc.set = function (value) {
      Object.defineProperty(globalThis, name, {value, writable: true, enumerable: true, configurable: true});
    };
  }
  Object.defineProperty(__windowProto, name, desc);
  // On QuickJS a Window accessor can land on the shared Object.prototype (polluting every
  // object's chain — a `<span>` would gain `origin`, a `this.origin =` would throw). If it did,
  // move it onto globalThis as an own accessor so it stays out of ordinary objects' chains.
  if (Object.prototype.hasOwnProperty.call(__sharedObjectProto, name)) {
    delete __sharedObjectProto[name];
    if (!Object.prototype.hasOwnProperty.call(globalThis, name)) Object.defineProperty(globalThis, name, desc);
  }
}
defineWindowAccessor('origin', () => {
  if (globalThis.__csimDocumentOrigin != null) return globalThis.__csimDocumentOrigin;
  try { return (globalThis.location && globalThis.location.origin) || ''; } catch (_) { return ''; }
});

// The origin KEY a BroadcastChannel is scoped to. For a tuple (non-opaque) origin it's the
// serialized origin string. For an OPAQUE origin (serialized as "null" — a sandboxed / data: /
// srcdoc context) every context has its OWN unique opaque origin, so a bare "null" can't be the
// key: two unrelated opaque contexts would collide and cross-talk. Mint a stable per-realm token
// instead (cached on first use) so this context's channel only reaches peers sharing its EXACT
// opaque origin — its own realm, plus any worker that INHERITED it (a blob: worker created here:
// the agent cluster). A worker is handed its key explicitly at spawn (`__csimOriginKey`), so it
// never mints one here.
globalThis.__csimBcOriginKey = function () {
  if (globalThis.__csimOriginKey != null) return globalThis.__csimOriginKey;
  let o = '';
  try { o = globalThis.origin || ''; } catch (_) {}
  if (o !== 'null') return o;
  const NS = globalThis.RustyRacer;
  const rid = (NS && typeof NS.contextOf === 'function') ? NS.contextOf(globalThis) : 0;
  return (globalThis.__csimOriginKey = 'opaque:realm' + rid);
};
// Serialize an origin key back to what MessageEvent.origin exposes: an opaque token → "null";
// a tuple origin is itself.
function serializeOriginKey(key) {
  return (typeof key === 'string' && key.startsWith('opaque:')) ? 'null' : (key || '');
}

// `window.frames` is the window itself, but indexable by frame number: a
// numeric `frames[i]` is the i-th nested browsing context's window — for us the
// i-th `<iframe>`/`<frame>`'s `contentWindow` (a real per-frame realm global) —
// and `frames.length` their count. Everything else delegates to the window.
globalThis.frames = new Proxy(globalThis, {
  get(target, prop) {
    if (typeof prop === 'string' && /^[0-9]+$/.test(prop)) {
      const el = globalThis.document.querySelectorAll('iframe, frame')[Number(prop)];
      return el ? el.contentWindow : undefined;
    }
    if (prop === 'length') return globalThis.document.querySelectorAll('iframe, frame').length;
    return Reflect.get(target, prop, globalThis);
  }
});

// scrollX / scrollY (and the deprecated pageXOffset / pageYOffset
// aliases) reflect the scrolling element's offsets. Discourse's
// `route-scroll-manager` service reads `window.scrollY` to assert
// scroll position before/after route transitions; without live
// getters every poll lands on 0 even after a `scrollIntoView`.
function __docScrollLeft() {
  const root = globalThis.document && globalThis.document.documentElement;
  return root ? (root._scrollLeft || 0) : 0;
}
function __docScrollTop() {
  const root = globalThis.document && globalThis.document.documentElement;
  return root ? (root._scrollTop || 0) : 0;
}
// On the prototype (see defineWindowAccessor) so a top-level `var scrollX` can shadow them.
defineWindowAccessor('scrollX',     __docScrollLeft, {replaceable: true});
defineWindowAccessor('scrollY',     __docScrollTop,  {replaceable: true});
defineWindowAccessor('pageXOffset', __docScrollLeft, {replaceable: true});
defineWindowAccessor('pageYOffset', __docScrollTop,  {replaceable: true});
// THE viewport — one value, owned by the driver (`Browser#set_viewport`, i.e. Capybara's
// `current_window.resize_to`), read by `innerWidth` / `innerHeight`, by the `@media` cascade and
// `matchMedia` (media-query.js `currentViewport`), and by the layout engine. Page script reaches it
// only through the `[Replaceable]` accessors below, so an assignment shadows the getter for that
// page without repointing layout — which is exactly what a real browser does.
globalThis.__csimViewport = {width: SCREEN_W, height: SCREEN_H};
defineWindowAccessor('innerWidth',  () => globalThis.__csimViewport.width,  {replaceable: true});
defineWindowAccessor('innerHeight', () => globalThis.__csimViewport.height, {replaceable: true});
// The window's OUTER size. Coarse: we model no window chrome, so outer == inner (a real browser's
// outer is a title bar and borders larger).
defineWindowAccessor('outerWidth',  () => globalThis.__csimViewport.width,  {replaceable: true});
defineWindowAccessor('outerHeight', () => globalThis.__csimViewport.height, {replaceable: true});

// `visualViewport` — modern mobile-keyboard / pinch-zoom aware
// viewport. Apps subscribe to its `resize` / `scroll` events to
// reflow when the soft keyboard appears (Mastodon's composer, chat
// UIs). Static values match the layout viewport; listeners are
// stored but never invoked because we don't model layout shifts.
globalThis.visualViewport = {
  get offsetLeft() { return 0; },
  get offsetTop()  { return 0; },
  get pageLeft()   { return globalThis.scrollX; },
  get pageTop()    { return globalThis.scrollY; },
  get width()      { return globalThis.innerWidth; },
  get height()     { return globalThis.innerHeight; },
  get scale()      { return 1; },
  onresize: null,
  onscroll: null,
  addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; }
};
// Window-level scroll APIs forward to the document scrolling element,
// which is what `window.scrollY` reads through. Setting `top`/`left`
// here is what `page.execute_script("window.scrollTo(0, 0)")` and
// Discourse's logo-refresh path actually do.
function __windowScrollDelegate(method, args) {
  const root = globalThis.document && globalThis.document.documentElement;
  if (root && typeof root[method] === 'function') root[method].apply(root, args);
}
globalThis.scrollTo = function () { __windowScrollDelegate('scrollTo', arguments); };
globalThis.scrollBy = function () { __windowScrollDelegate('scrollBy', arguments); };
globalThis.scroll   = globalThis.scrollTo;
// This realm's own id, as the host knows it — 0 for the main realm and for an engine with
// no realms at all (QuickJS). Every JS→host call that names a browsing context (port
// endpoints, the focus chain) identifies itself through this.
globalThis.__csimRealmId = function () {
  const NS = globalThis.RustyRacer;
  return (NS && typeof NS.contextOf === 'function') ? (NS.contextOf(globalThis) || 0) : 0;
};
// `window.focus()` — HTML "focusing steps" applied to a BROWSING CONTEXT rather than an
// element: it moves the focus chain to this window without touching its activeElement. Only
// the host tracks which context holds focus (it is cross-realm state), so this is purely a
// report. There is no window manager to raise, so nothing else happens; `blur()` is the
// no-op it is in every modern browser (the spec says user agents may ignore it entirely).
globalThis.focus = function focus() {
  const note = globalThis.__csimNoteFocusedRealm;
  if (typeof note !== 'function') return;
  try { note(globalThis.__csimRealmId()); } catch (_) {}
};
globalThis.blur = function blur() {};
// `window.print()` — no rendering surface to print, so a no-op (like `alert`).
// Present so feature detection and inline handlers referencing `print` resolve it.
globalThis.print = function print() {};

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
  // Two-argument form: does the declaration `property: value` parse? We don't model per-property
  // value grammar, so approximate — a SUPPORTED property (or a `--custom` property) with a
  // non-empty value. That's enough to reject non-properties (`CSS.supports('has-own-property', …)`
  // → false), which the old bare `return true` accepted, wrongly folding Object.prototype method
  // names into "supported properties". The one-argument `<supports-condition>` string form stays
  // permissive (we don't parse the condition grammar here).
  supports(property, value) {
    if (arguments.length < 2) return true;
    const name = String(property);
    const prop = name.indexOf('--') === 0 ? name : name.toLowerCase();
    return (prop.indexOf('--') === 0 || isSupportedCssPropertyName(prop)) && String(value).trim() !== '';
  }
};
// `CSS` is a namespace object: `Object.prototype.toString.call(CSS)` is
// `[object CSS]` via a configurable, non-writable, non-enumerable @@toStringTag.
Object.defineProperty(globalThis.CSS, Symbol.toStringTag, { value: 'CSS', configurable: true });

// `performance.now()` returns ms since the runtime started, measured on the
// SAME clock as `Date.now()` — so it advances with the virtual clock
// (`virtualNow`), not wall time. In this synchronous in-process environment
// "real elapsed wall time" between two reads is ~0, so the virtual clock is the
// only meaningful timeline; sharing it keeps `performance.now()` deltas (e.g. an
// rAF callback's timestamp) consistent with `Date.now()` and on real frame
// cadence. `mark` / `measure` record entries and notify any active
// PerformanceObserver via `__csimDeliverPerfEntry`.
const perfStart = Date.now();
const _perfEntries = [];
function recordEntry(entry) {
  _perfEntries.push(entry);
  if (typeof globalThis.__csimDeliverPerfEntry === 'function') globalThis.__csimDeliverPerfEntry(entry);
}
globalThis.performance = {
  now()        { return Date.now() - perfStart; },
  timeOrigin:   perfStart,
  timing:      { navigationStart: perfStart },
  mark(name, options) {
    const entry = {
      name:      String(name),
      entryType: 'mark',
      startTime: (options && options.startTime != null) ? options.startTime : (Date.now() - perfStart),
      duration:  0,
      detail:    options ? options.detail : null
    };
    recordEntry(entry);
    return entry;
  },
  measure(name, startOrOptions, endMark) {
    let startTime = 0, duration = 0, detail = null;
    if (typeof startOrOptions === 'object' && startOrOptions !== null) {
      startTime = startOrOptions.start != null ? startOrOptions.start : 0;
      duration  = startOrOptions.duration != null ? startOrOptions.duration :
                  (startOrOptions.end != null ? (startOrOptions.end - startTime) : 0);
      detail    = startOrOptions.detail || null;
    } else if (typeof startOrOptions === 'string') {
      const startEntry = _perfEntries.find(e => e.entryType === 'mark' && e.name === startOrOptions);
      startTime = startEntry ? startEntry.startTime : 0;
      if (endMark != null) {
        const endEntry = _perfEntries.find(e => e.entryType === 'mark' && e.name === endMark);
        duration = (endEntry ? endEntry.startTime : (Date.now() - perfStart)) - startTime;
      } else {
        duration = (Date.now() - perfStart) - startTime;
      }
    }
    const entry = {name: String(name), entryType: 'measure', startTime, duration, detail};
    recordEntry(entry);
    return entry;
  },
  getEntries()                  { return _perfEntries.slice(); },
  getEntriesByName(name, type)  { return _perfEntries.filter(e => e.name === name && (!type || e.entryType === type)); },
  getEntriesByType(type)        { return _perfEntries.filter(e => e.entryType === type); },
  clearMarks(name) {
    for (let i = _perfEntries.length - 1; i >= 0; i--) {
      if (_perfEntries[i].entryType !== 'mark') continue;
      if (name != null && _perfEntries[i].name !== name) continue;
      _perfEntries.splice(i, 1);
    }
  },
  clearMeasures(name) {
    for (let i = _perfEntries.length - 1; i >= 0; i--) {
      if (_perfEntries[i].entryType !== 'measure') continue;
      if (name != null && _perfEntries[i].name !== name) continue;
      _perfEntries.splice(i, 1);
    }
  }
};

// CSSOM-View geometry types. We don't model layout, so the values
// callers see are zero (or whatever the element-getter computed),
// but `instanceof DOMRect` checks succeed and the spec-shaped fields
// (top/right/bottom/left derived from x/y/width/height) are correct.
class DOMPointReadOnly {
  constructor(x = 0, y = 0, z = 0, w = 1) { this.x = +x || 0; this.y = +y || 0; this.z = +z || 0; this.w = +w === 0 ? 0 : (+w || 1); }
  static fromPoint(p)    { return new DOMPointReadOnly(p && p.x, p && p.y, p && p.z, p && p.w); }
  toJSON()               { return {x: this.x, y: this.y, z: this.z, w: this.w}; }
}
class DOMPoint extends DOMPointReadOnly {
  static fromPoint(p)    { return new DOMPoint(p && p.x, p && p.y, p && p.z, p && p.w); }
}
class DOMRectReadOnly {
  constructor(x = 0, y = 0, w = 0, h = 0) { this.x = +x || 0; this.y = +y || 0; this.width = +w || 0; this.height = +h || 0; }
  get top()    { return this.y; }
  get left()   { return this.x; }
  get right()  { return this.x + this.width; }
  get bottom() { return this.y + this.height; }
  static fromRect(r)     { return new DOMRectReadOnly(r && r.x, r && r.y, r && r.width, r && r.height); }
  toJSON() {
    return {x: this.x, y: this.y, width: this.width, height: this.height,
            top: this.top, right: this.right, bottom: this.bottom, left: this.left};
  }
}
class DOMRect extends DOMRectReadOnly {
  static fromRect(r)     { return new DOMRect(r && r.x, r && r.y, r && r.width, r && r.height); }
}
globalThis.DOMPointReadOnly = DOMPointReadOnly;
globalThis.DOMPoint         = DOMPoint;
globalThis.DOMRectReadOnly  = DOMRectReadOnly;
globalThis.DOMRect          = DOMRect;

// DOMMatrix / DOMMatrixReadOnly. Unlike DOMRect/DOMPoint these carry real behavior
// (canvas getTransform/setTransform, Path2D.addPath, CanvasPattern.setTransform, and
// app code doing custom transforms), so the full 4×4 algebra is implemented. Storage
// is a 16-element COLUMN-MAJOR array `_m` = [m11,m12,m13,m14, m21,…, m44] — the same
// order toFloat32Array/toFloat64Array expose — with `_is2D` tracking the 2D-ness flag.
const M_IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const M_KEYS  = ['m11', 'm12', 'm13', 'm14', 'm21', 'm22', 'm23', 'm24', 'm31', 'm32', 'm33', 'm34', 'm41', 'm42', 'm43', 'm44'];
const M_ALIAS = {a: 0, b: 1, c: 4, d: 5, e: 12, f: 13};   // 2D name → index into _m
// Indices that must stay identity for a matrix to be 2D: the 3D off-diagonals (→ 0)
// plus m33 / m44 (→ 1). Setting any of these to a non-identity value drops is2D.
const M_3D_ZERO = new globalThis.Set([2, 3, 6, 7, 8, 9, 11, 14]);
const deg2rad = (d) => d * Math.PI / 180;

// C = A · B, both column-major 16-arrays (apply B first, then A — matches transformPoint).
function matMul(A, B) {
  const r = new globalThis.Array(16);
  for (let col = 0; col < 4; col++) {
    const bx = B[col * 4], by = B[col * 4 + 1], bz = B[col * 4 + 2], bw = B[col * 4 + 3];
    r[col * 4]     = A[0] * bx + A[4] * by + A[8]  * bz + A[12] * bw;
    r[col * 4 + 1] = A[1] * bx + A[5] * by + A[9]  * bz + A[13] * bw;
    r[col * 4 + 2] = A[2] * bx + A[6] * by + A[10] * bz + A[14] * bw;
    r[col * 4 + 3] = A[3] * bx + A[7] * by + A[11] * bz + A[15] * bw;
  }
  return r;
}

// General 4×4 inverse (column-major); returns null when singular.
function matInverse(m) {
  const b00 = m[0] * m[5] - m[1] * m[4], b01 = m[0] * m[6] - m[2] * m[4];
  const b02 = m[0] * m[7] - m[3] * m[4], b03 = m[1] * m[6] - m[2] * m[5];
  const b04 = m[1] * m[7] - m[3] * m[5], b05 = m[2] * m[7] - m[3] * m[6];
  const b06 = m[8] * m[13] - m[9] * m[12], b07 = m[8] * m[14] - m[10] * m[12];
  const b08 = m[8] * m[15] - m[11] * m[12], b09 = m[9] * m[14] - m[10] * m[13];
  const b10 = m[9] * m[15] - m[11] * m[13], b11 = m[10] * m[15] - m[11] * m[14];
  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return null;
  det = 1 / det;
  return [
    (m[5] * b11 - m[6] * b10 + m[7] * b09) * det, (m[2] * b10 - m[1] * b11 - m[3] * b09) * det,
    (m[13] * b05 - m[14] * b04 + m[15] * b03) * det, (m[10] * b04 - m[9] * b05 - m[11] * b03) * det,
    (m[6] * b08 - m[4] * b11 - m[7] * b07) * det, (m[0] * b11 - m[2] * b08 + m[3] * b07) * det,
    (m[14] * b02 - m[12] * b05 - m[15] * b01) * det, (m[8] * b05 - m[10] * b02 + m[11] * b01) * det,
    (m[4] * b10 - m[5] * b08 + m[7] * b06) * det, (m[1] * b08 - m[0] * b10 - m[3] * b06) * det,
    (m[12] * b04 - m[13] * b02 + m[15] * b00) * det, (m[9] * b02 - m[8] * b04 - m[11] * b00) * det,
    (m[5] * b07 - m[4] * b09 - m[6] * b06) * det, (m[0] * b09 - m[1] * b07 + m[2] * b06) * det,
    (m[13] * b01 - m[12] * b03 - m[14] * b00) * det, (m[8] * b03 - m[9] * b01 + m[10] * b00) * det,
  ];
}

// A 6- or 16-element numeric sequence → {m, is2D}. Per spec 6 ⇒ 2D, 16 ⇒ 3D. The
// elements are `unrestricted double`, so Infinity / NaN are kept, not rejected.
function matFromArray(arr) {
  const a = [];
  for (let i = 0; i < arr.length; i++) a.push(+arr[i]);
  if (a.length === 6) return {m: [a[0], a[1], 0, 0, a[2], a[3], 0, 0, 0, 0, 1, 0, a[4], a[5], 0, 1], is2D: true};
  if (a.length === 16) return {m: a, is2D: false};
  throw new globalThis.TypeError('DOMMatrix: sequence must have 6 or 16 elements');
}

// A CSS transform string → {m, is2D}. Handles the serialized forms getComputedStyle
// hands back (matrix(), matrix3d()) plus 'none' / empty; a full <transform-list>
// parser (rotate()/translate()/… composition) is backlog.
function matFromString(str) {
  str = String(str).trim();
  if (str === '' || str === 'none') return {m: M_IDENT.slice(), is2D: true};
  let mt = /^matrix\(([^)]*)\)$/.exec(str);
  if (mt) return matFromArray(mt[1].split(','));
  mt = /^matrix3d\(([^)]*)\)$/.exec(str);
  if (mt) return matFromArray(mt[1].split(','));
  throw new globalThis.DOMException('DOMMatrix: unsupported transform string ' + JSON.stringify(str), 'SyntaxError');
}

// A DOMMatrixInit dictionary (or DOMMatrix) → {m, is2D}, validating the a↔m11 …
// f↔m42 aliases agree and deriving is2D from any 3D entries present.
function matFromDict(d) {
  const pick = (twoD, threeD, dflt) => {
    const t = d[twoD], m = d[threeD];
    if (t != null && m != null && +t !== +m && !(globalThis.Number.isNaN(+t) && globalThis.Number.isNaN(+m))) {
      throw new globalThis.TypeError('DOMMatrix: inconsistent ' + twoD + '/' + threeD);
    }
    return t != null ? +t : m != null ? +m : dflt;
  };
  const m11 = pick('a', 'm11', 1), m12 = pick('b', 'm12', 0), m21 = pick('c', 'm21', 0);
  const m22 = pick('d', 'm22', 1), m41 = pick('e', 'm41', 0), m42 = pick('f', 'm42', 0);
  const g = (k, dflt) => d[k] != null ? +d[k] : dflt;
  const m = [m11, m12, g('m13', 0), g('m14', 0), m21, m22, g('m23', 0), g('m24', 0),
             g('m31', 0), g('m32', 0), g('m33', 1), g('m34', 0), m41, m42, g('m43', 0), g('m44', 1)];
  let is2D = !M_KEYS.some((_, i) => M_3D_ZERO.has(i) && m[i] !== 0) && m[10] === 1 && m[15] === 1;
  if (d.is2D != null) { if (d.is2D && !is2D) throw new globalThis.TypeError('DOMMatrix: is2D true but has 3D components'); is2D = !!d.is2D && is2D; }
  return {m, is2D};
}

// Coerce a DOMMatrixInit-or-sequence-or-DOMMatrix into {m, is2D}.
function toMatrixCore(v) {
  if (v == null) return {m: M_IDENT.slice(), is2D: true};
  if (v instanceof DOMMatrixReadOnly) return {m: v._m.slice(), is2D: v._is2D};
  if (typeof v.length === 'number' || v[globalThis.Symbol.iterator]) return matFromArray(globalThis.Array.from(v));
  return matFromDict(v);
}

class DOMMatrixReadOnly {
  constructor(init) {
    let core;
    if (init == null) core = {m: M_IDENT.slice(), is2D: true};
    else if (typeof init === 'string') core = matFromString(init);
    else core = matFromArray(globalThis.Array.from(init));
    this._m = core.m; this._is2D = core.is2D;
  }
  static fromMatrix(o)        { const c = toMatrixCore(o == null ? undefined : o); return matrixFrom(this, c.m, c.is2D); }
  static fromFloat32Array(a)  { const c = matFromArray(globalThis.Array.from(a)); return matrixFrom(this, c.m, c.is2D); }
  static fromFloat64Array(a)  { const c = matFromArray(globalThis.Array.from(a)); return matrixFrom(this, c.m, c.is2D); }

  get is2D()       { return this._is2D; }
  get isIdentity() { for (let i = 0; i < 16; i++) if (this._m[i] !== M_IDENT[i]) return false; return true; }
  get [Symbol.toStringTag]() { return this.constructor.name; }

  translate(tx = 0, ty = 0, tz = 0) {
    const m = matMul(this._m, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, +tx || 0, +ty || 0, +tz || 0, 1]);
    return newMatrix(m, this._is2D && !tz);
  }
  scale(sx = 1, sy, sz = 1, ox = 0, oy = 0, oz = 0) {
    sx = +sx; sy = sy === undefined ? sx : +sy; sz = +sz;
    let m = this._m;
    if (ox || oy || oz) m = matMul(m, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, +ox, +oy, +oz, 1]);
    m = matMul(m, [sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, sz, 0, 0, 0, 0, 1]);
    if (ox || oy || oz) m = matMul(m, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -ox, -oy, -oz, 1]);
    return newMatrix(m, this._is2D && sz === 1 && !oz);
  }
  scaleNonUniform(sx = 1, sy = 1) { return this.scale(sx, sy, 1, 0, 0, 0); }
  scale3d(s = 1, ox = 0, oy = 0, oz = 0) { return this.scale(s, s, s, ox, oy, oz); }
  rotate(rx = 0, ry, rz) {
    rx = +rx || 0;
    if (ry === undefined && rz === undefined) { rz = rx; rx = 0; ry = 0; }
    else { ry = +ry || 0; rz = +rz || 0; }
    // Post-multiply Z, then Y, then X (spec order) → M · Rz · Ry · Rx.
    let m = this._m;
    if (rz) { const a = deg2rad(rz), c = Math.cos(a), s = Math.sin(a); m = matMul(m, [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]); }
    if (ry) { const a = deg2rad(ry), c = Math.cos(a), s = Math.sin(a); m = matMul(m, [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]); }
    if (rx) { const a = deg2rad(rx), c = Math.cos(a), s = Math.sin(a); m = matMul(m, [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]); }
    return newMatrix(m, this._is2D && !rx && !ry);
  }
  rotateFromVector(x = 0, y = 0) { return this.rotate((x || y) ? Math.atan2(+y, +x) * 180 / Math.PI : 0); }
  rotateAxisAngle(x = 0, y = 0, z = 0, angle = 0) {
    x = +x; y = +y; z = +z; const len = Math.hypot(x, y, z);
    if (!len) return newMatrix(this._m.slice(), this._is2D);
    x /= len; y /= len; z /= len;
    const a = deg2rad(+angle), c = Math.cos(a), s = Math.sin(a), t = 1 - c;
    const r = [t * x * x + c, t * x * y + s * z, t * x * z - s * y, 0,
               t * x * y - s * z, t * y * y + c, t * y * z + s * x, 0,
               t * x * z + s * y, t * y * z - s * x, t * z * z + c, 0, 0, 0, 0, 1];
    return newMatrix(matMul(this._m, r), this._is2D && x === 0 && y === 0);
  }
  skewX(deg = 0) { return newMatrix(matMul(this._m, [1, 0, 0, 0, Math.tan(deg2rad(+deg)), 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), this._is2D); }
  skewY(deg = 0) { return newMatrix(matMul(this._m, [1, Math.tan(deg2rad(+deg)), 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), this._is2D); }
  multiply(other) { const c = toMatrixCore(other); return newMatrix(matMul(this._m, c.m), this._is2D && c.is2D); }
  flipX() { return newMatrix(matMul(this._m, [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), this._is2D); }
  flipY() { return newMatrix(matMul(this._m, [1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), this._is2D); }
  inverse() { const inv = matInverse(this._m); return inv ? newMatrix(inv, this._is2D) : newMatrix(new globalThis.Array(16).fill(NaN), false); }
  transformPoint(p = {}) {
    const x = p.x == null ? 0 : +p.x, y = p.y == null ? 0 : +p.y, z = p.z == null ? 0 : +p.z, w = p.w == null ? 1 : +p.w, m = this._m;
    return new DOMPoint(m[0] * x + m[4] * y + m[8] * z + m[12] * w, m[1] * x + m[5] * y + m[9] * z + m[13] * w,
                        m[2] * x + m[6] * y + m[10] * z + m[14] * w, m[3] * x + m[7] * y + m[11] * z + m[15] * w);
  }
  toFloat32Array() { return new globalThis.Float32Array(this._m); }
  toFloat64Array() { return new globalThis.Float64Array(this._m); }
  toJSON() {
    const o = {is2D: this._is2D, isIdentity: this.isIdentity};
    M_KEYS.forEach((k, i) => o[k] = this._m[i]);
    for (const k in M_ALIAS) o[k] = this._m[M_ALIAS[k]];
    return o;
  }
  toString() {
    const m = this._m;
    for (let i = 0; i < 16; i++) if (!globalThis.isFinite(m[i])) throw new globalThis.DOMException('DOMMatrix: cannot serialize a non-finite matrix', 'InvalidStateError');
    if (!this._is2D) return 'matrix3d(' + m.join(', ') + ')';
    return 'matrix(' + [m[0], m[1], m[4], m[5], m[12], m[13]].join(', ') + ')';
  }
}
// m11–m44 + a–f as read-only getters on the prototype.
M_KEYS.forEach((k, i) => globalThis.Object.defineProperty(DOMMatrixReadOnly.prototype, k, {
  get() { return this._m[i]; }, configurable: true, enumerable: true,
}));
for (const k in M_ALIAS) globalThis.Object.defineProperty(DOMMatrixReadOnly.prototype, k, {
  get() { return this._m[M_ALIAS[k]]; }, configurable: true, enumerable: true,
});

class DOMMatrix extends DOMMatrixReadOnly {
  static fromMatrix(o)       { return DOMMatrixReadOnly.fromMatrix.call(DOMMatrix, o); }
  static fromFloat32Array(a) { return DOMMatrixReadOnly.fromFloat32Array.call(DOMMatrix, a); }
  static fromFloat64Array(a) { return DOMMatrixReadOnly.fromFloat64Array.call(DOMMatrix, a); }

  multiplySelf(other)    { const c = toMatrixCore(other); this._m = matMul(this._m, c.m); this._is2D = this._is2D && c.is2D; return this; }
  preMultiplySelf(other) { const c = toMatrixCore(other); this._m = matMul(c.m, this._m); this._is2D = this._is2D && c.is2D; return this; }
  translateSelf(tx, ty, tz)                 { return this._becomes(this.translate(tx, ty, tz)); }
  scaleSelf(sx, sy, sz, ox, oy, oz)         { return this._becomes(this.scale(sx, sy, sz, ox, oy, oz)); }
  scale3dSelf(s, ox, oy, oz)                { return this._becomes(this.scale3d(s, ox, oy, oz)); }
  rotateSelf(rx, ry, rz)                    { return this._becomes(this.rotate(rx, ry, rz)); }
  rotateFromVectorSelf(x, y)                { return this._becomes(this.rotateFromVector(x, y)); }
  rotateAxisAngleSelf(x, y, z, a)           { return this._becomes(this.rotateAxisAngle(x, y, z, a)); }
  skewXSelf(deg)                            { return this._becomes(this.skewX(deg)); }
  skewYSelf(deg)                            { return this._becomes(this.skewY(deg)); }
  invertSelf()                              { return this._becomes(this.inverse()); }
  setMatrixValue(str)                       { const c = matFromString(str); this._m = c.m; this._is2D = c.is2D; return this; }
  _becomes(other) { this._m = other._m; this._is2D = other._is2D; return this; }
}
// m11–m44 gain setters that drop is2D when a 3D-only entry becomes non-identity; a–f
// stay 2D. (Direct field writes are how mutable DOMMatrix is spec'd to work.)
M_KEYS.forEach((k, i) => globalThis.Object.defineProperty(DOMMatrix.prototype, k, {
  get() { return this._m[i]; },
  set(v) { v = +v; this._m[i] = v; if ((M_3D_ZERO.has(i) && v !== 0) || ((i === 10 || i === 15) && v !== 1)) this._is2D = false; },
  configurable: true, enumerable: true,
}));
for (const k in M_ALIAS) globalThis.Object.defineProperty(DOMMatrix.prototype, k, {
  get() { return this._m[M_ALIAS[k]]; }, set(v) { this._m[M_ALIAS[k]] = +v; }, configurable: true, enumerable: true,
});

// Build an instance of `cls` (DOMMatrix or DOMMatrixReadOnly) from a raw core.
function matrixFrom(cls, m, is2D) { const r = globalThis.Object.create(cls.prototype); r._m = m; r._is2D = is2D; return r; }
// Immutable ops always return a fresh DOMMatrix (per spec, even on the read-only type).
function newMatrix(m, is2D) { return matrixFrom(DOMMatrix, m, is2D); }

globalThis.DOMMatrixReadOnly = DOMMatrixReadOnly;
globalThis.DOMMatrix         = DOMMatrix;

// CSS Font Loading (FontFace / FontFaceSet). An @font-face family is loaded on demand
// by the canvas text host (fetched + handed to pango) the first time it renders, so a
// font is effectively always "loaded" — the surface here is enough for the common
// `await document.fonts.ready` gate plus basic set queries. Actual glyph rendering
// goes through the @font-face → src → host-font path, not this object.
class FontFace {
  constructor(family, source, descriptors = {}) {
    const d = descriptors || {};
    this.family = String(family);
    this.style = d.style || 'normal';
    this.weight = d.weight || 'normal';
    this.stretch = d.stretch || 'normal';
    this.unicodeRange = d.unicodeRange || 'U+0-10FFFF';
    this.featureSettings = d.featureSettings || 'normal';
    this.variationSettings = d.variationSettings || 'normal';
    this.display = d.display || 'auto';
    this.ascentOverride = d.ascentOverride || 'normal';
    this.descentOverride = d.descentOverride || 'normal';
    this.lineGapOverride = d.lineGapOverride || 'normal';
    this.status = 'loaded';
    this._source = source;
    this.loaded = globalThis.Promise.resolve(this);
  }
  load() {
    // The url() source FETCHES through a controlling service worker (destination
    // 'font', bytes discarded — rasterization isn't modeled, the fetch is the
    // observable). A blocked respondWith fails the face like a browser.
    const m = /url\(\s*(['"]?)([^'")]+)\1\s*\)/i.exec(String(this._source || ''));
    if (m && typeof globalThis.__csimSwFetchDest === 'function') {
      let abs = m[2];
      try { abs = new globalThis.URL(m[2], (globalThis.location && globalThis.location.href) || undefined).href; } catch (_) {}
      if (/^https?:/i.test(abs)) {
        const sw = globalThis.__csimSwFetchDest(abs, 'font', 'cors', 'same-origin', true);
        if (sw && sw.blocked) {
          // `loaded` is [SameObject]: load() returns IT, and a failed load rejects
          // both — a consumer awaiting `face.loaded` must see the failure too.
          this.status = 'error';
          this.loaded = globalThis.Promise.reject(new globalThis.DOMException('A network error occurred.', 'NetworkError'));
          this.loaded.catch(() => {});   // guard the unhandled-rejection logger
          return this.loaded;
        }
      }
    }
    this.status = 'loaded';
    return globalThis.Promise.resolve(this);
  }
  get [Symbol.toStringTag]() { return 'FontFace'; }
}
// FontFaceSet is an EventTarget: it announces `loading` / `loadingdone` /
// `loadingerror` as a family finishes. Nothing fires those here — a font is loaded on
// demand, so the set never leaves "loaded" and there is no transition to announce — but
// the surface has to exist, because listening is unconditional in the wild:
// react-textarea-autosize does `if (el) el.addEventListener('loadingdone', …)` on
// `document.fonts`, and a set that is truthy-but-not-an-EventTarget passes the guard and
// then throws.
class FontFaceSet extends EventTarget {
  constructor() {
    super();
    // Internal state stays off the enumerable surface (Object.keys / for-in /
    // JSON.stringify / spread), like EventTarget's listener store — a browser's set has
    // no own keys at all.
    Object.defineProperty(this, '_faces', { value: new globalThis.Set(), enumerable: false });
  }
  get ready()  { return this._ready || (this._ready = globalThis.Promise.resolve(this)); }   // one stable promise
  get status() { return 'loaded'; }
  get size()   { return this._faces.size; }
  add(f)       { this._faces.add(f); return this; }
  delete(f)    { return this._faces.delete(f); }
  has(f)       { return this._faces.has(f); }
  clear()      { this._faces.clear(); }
  check()      { return true; }                                  // available on demand
  load()       { return globalThis.Promise.resolve([]); }
  forEach(cb, thisArg) { this._faces.forEach(f => cb.call(thisArg, f, f, this)); }
  values()     { return this._faces.values(); }
  keys()       { return this._faces.values(); }
  entries()    { const out = []; this._faces.forEach(f => out.push([f, f])); return out[globalThis.Symbol.iterator](); }
  [Symbol.iterator]() { return this._faces[globalThis.Symbol.iterator](); }
  get [Symbol.toStringTag]() { return 'FontFaceSet'; }
}
defineEventHandlers(FontFaceSet.prototype, ['loading', 'loadingdone', 'loadingerror']);

globalThis.FontFace    = FontFace;
globalThis.FontFaceSet = FontFaceSet;

// The standard Error subtypes StructuredSerialize preserves; any other `name` deserializes
// as a plain Error.
const ERROR_NAMES = ['Error', 'EvalError', 'RangeError', 'ReferenceError', 'SyntaxError', 'TypeError', 'URIError'];

function dataCloneError(msg) {
  return new globalThis.DOMException(
    msg || "Failed to execute 'structuredClone' on 'Window': An object could not be cloned.",
    'DataCloneError'
  );
}

// The transfer state for the structuredClone() currently in progress, or null:
// `{ set: Set<transferable>, cache: Map<source, moved> }`. Set by structuredClone with a
// save/restore and read by cloneInto, so it need not be threaded through every recursive call.
// A source is transferred LAZILY (on first reference during the clone) so a view's metadata is
// captured while its buffer is still intact.
let currentTransfer = null;

// Whether `t` is a transferable object in a usable (non-detached) state — WITHOUT neutering it.
// Uses the module-local classes (not globalThis) so a test that deletes the global interface
// can still transfer (structured-clone "interface deleted from the global object"). Throws
// DataCloneError otherwise.
function validateTransferable(t) {
  const tag = Object.prototype.toString.call(t);
  if (tag === '[object ArrayBuffer]') { if (t.detached) throw dataCloneError('An ArrayBuffer is detached and could not be transferred.'); return; }
  if (t instanceof MessagePort)       { if (t._detached) throw dataCloneError('A detached MessagePort could not be transferred.'); return; }
  if (globalThis.ImageBitmap    && t instanceof globalThis.ImageBitmap)    return;
  if (globalThis.OffscreenCanvas && t instanceof globalThis.OffscreenCanvas) return;
  if (globalThis.ReadableStream && t instanceof globalThis.ReadableStream) { if (t.locked) throw dataCloneError('A locked ReadableStream could not be transferred.'); return; }
  throw dataCloneError('Value is not a transferable object.');
}

// Transfer a transferable to its moved counterpart, NEUTERING the source.
function transferValue(t) {
  const tag = Object.prototype.toString.call(t);
  if (tag === '[object ArrayBuffer]') {
    // COPY the bytes now and defer the source detach to the END of the clone (see
    // structuredClone). Detaching eagerly would neuter the buffer before a view over it that
    // appears LATER in the object graph is cloned — the view would then read as empty. The
    // spec serializes the whole graph first and detaches last; deferring matches that.
    const copy = t.resizable ? new ArrayBuffer(t.byteLength, { maxByteLength: t.maxByteLength })
                             : new ArrayBuffer(t.byteLength);
    new Uint8Array(copy).set(new Uint8Array(t));
    currentTransfer.pendingDetach.push(t);
    return copy;
  }
  if (t instanceof MessagePort) {
    // Move the entanglement onto a fresh port and neuter the source (single-isolate: the port
    // object shuttles across as-is rather than through the wire). The source's not-yet-delivered
    // message queue and enabled state travel WITH it, so messages that arrived before the transfer
    // are received in order once the moved port is enabled (transfer-entangled ordering).
    const peer  = t._peer;
    const moved = new MessagePort();
    moved._peer    = peer;
    moved._started = t._started;
    moved._queue   = t._queue;
    if (peer) peer._peer = moved;
    t._peer = null;
    t._queue = [];
    t._detached = true;
    return moved;
  }
  if (globalThis.ImageBitmap && t instanceof globalThis.ImageBitmap) {
    // Inline the copy (NOT cloneInto — t is in the transfer set, which would recurse here).
    const o = new globalThis.ImageBitmap();
    o.width  = t.width;
    o.height = t.height;
    o._pixels = t._pixels ? new globalThis.Uint8ClampedArray(t._pixels) : null;
    o._colorSpace = t._colorSpace;        // preserve the colour space across transfer
    o._pixelsP3 = t._pixelsP3;             // and the wide-gamut (P3) rendering, if any
    t.close();                            // transfer neuters the source bitmap
    return o;
  }
  if (globalThis.OffscreenCanvas && t instanceof globalThis.OffscreenCanvas) {
    const o = new globalThis.OffscreenCanvas(t.width, t.height);
    o._pixels = t._pixels && new globalThis.Uint8ClampedArray(t._pixels);
    t.width = 0; t.height = 0; t._pixels = null;   // neuter the source canvas
    return o;
  }
  if (globalThis.ReadableStream && t instanceof globalThis.ReadableStream) {
    // Single-isolate: pipe the source through a fresh base ReadableStream (a subclass is thus
    // received as its closest transferable superclass) and neuter the source by locking it.
    const reader = t.getReader();
    return new globalThis.ReadableStream({
      pull(c)    { return reader.read().then(({ done, value }) => { if (done) c.close(); else c.enqueue(value); }); },
      cancel(r)  { return reader.cancel(r); }
    });
  }
  throw dataCloneError('Value is not a transferable object.');
}

// The moved counterpart of a transferable, transferred lazily on first reference.
function transferredCounterpart(t) {
  if (currentTransfer.cache.has(t)) return currentTransfer.cache.get(t);
  const moved = transferValue(t);
  currentTransfer.cache.set(t, moved);
  return moved;
}

// `structuredClone` — spec-compliant clone of Date / RegExp / Map / Set / boxed primitives /
// Error / ArrayBuffer / typed arrays / plain objects, cycle-safe. JSON fallback would silently
// drop the typed cases and crash on cycles.
function cloneInto(v, seen) {
  // StructuredSerialize throws a DataCloneError for a Symbol or a callable (function);
  // every other primitive clones to itself. Intercept before the primitive fast path
  // (a function is `typeof 'function'`, not 'object', so it would otherwise pass through).
  const t = typeof v;
  if (t === 'symbol')   throw dataCloneError('A Symbol value could not be cloned.');
  if (t === 'function') throw dataCloneError('A function could not be cloned.');
  if (v == null || t !== 'object') return v;
  if (seen.has(v)) return seen.get(v);
  // A value in the transfer list deserializes to its (lazily) moved counterpart.
  if (currentTransfer && currentTransfer.set.has(v)) return transferredCounterpart(v);
  // Brand-based type tags (Object.prototype.toString reads the internal slot)
  // rather than `instanceof`, so a CROSS-REALM value — an iframe's Date / Map /
  // Set / RegExp / ArrayBuffer handed over by `window.postMessage` — is detected
  // by its slot, not by a realm-relative constructor identity (a cross-realm
  // `instanceof Map` is false, which would mis-clone it as a plain `{}`).
  // `Array.isArray` / `ArrayBuffer.isView` below are already brand-based.
  const tag = Object.prototype.toString.call(v);
  // Blob / File clone in THIS realm (a posted Blob crossing into an iframe realm
  // must arrive as a real, usable Blob — not a plain object).
  if ((tag === '[object Blob]' || tag === '[object File]') && typeof globalThis.__csimCloneBlob === 'function') {
    const b = globalThis.__csimCloneBlob(v); seen.set(v, b); return b;
  }
  // A CryptoKey is serializable — duplicate it (algorithm + key material) through the
  // Web Crypto hook. Brand-tagged so a same-realm key handed to structuredClone / a
  // posted key both match.
  if (tag === '[object CryptoKey]' && typeof globalThis.__csimCloneCryptoKey === 'function') {
    const k = globalThis.__csimCloneCryptoKey(v); seen.set(v, k); return k;
  }
  if (tag === '[object Date]')   { const d = new Date(v.getTime()); seen.set(v, d); return d; }
  if (tag === '[object RegExp]') { const r = new RegExp(v.source, v.flags); seen.set(v, r); return r; }
  // Boxed primitives (new Number/String/Boolean) clone to a wrapper of the same type carrying
  // the same primitive (StructuredSerialize [[BooleanData]] / [[NumberData]] / [[StringData]]).
  if (tag === '[object Number]')  { const o = new Number(v.valueOf());  seen.set(v, o); return o; }
  if (tag === '[object String]')  { const o = new String(v.valueOf());  seen.set(v, o); return o; }
  if (tag === '[object Boolean]') { const o = new Boolean(v.valueOf()); seen.set(v, o); return o; }
  if (tag === '[object BigInt]')  { const o = Object(v.valueOf());      seen.set(v, o); return o; }
  // An Error clones to an error of the matching standard type (else a plain Error), carrying
  // message / stack / cause — NOT arbitrary own properties (StructuredSerialize [[ErrorData]]).
  // Only an OWN `message` is carried, so an empty Error (message from the prototype) clones
  // without an own `message` (the battery test asserts hasOwnProperty parity).
  if (tag === '[object Error]') {
    const name = ERROR_NAMES.indexOf(v.name) !== -1 ? v.name : 'Error';
    const Ctor = globalThis[name] || globalThis.Error;
    const e    = Object.prototype.hasOwnProperty.call(v, 'message') ? new Ctor(String(v.message)) : new Ctor();
    seen.set(v, e);
    if (typeof v.stack === 'string') { try { e.stack = v.stack; } catch (_) {} }
    if ('cause' in v) e.cause = cloneInto(v.cause, seen);
    return e;
  }
  // An ImageBitmap clones to a new bitmap with a copy of its pixel buffer (it is serializable —
  // the pixels come from our 2D rasterizer / image decoder, not a layout engine).
  if (tag === '[object ImageBitmap]' && globalThis.ImageBitmap) {
    const o = new globalThis.ImageBitmap();
    o.width  = v.width;
    o.height = v.height;
    o._pixels = v._pixels ? new globalThis.Uint8ClampedArray(v._pixels) : null;
    o._colorSpace = v._colorSpace;        // preserve the colour space across the clone
    o._pixelsP3 = v._pixelsP3 && new globalThis.Uint8ClampedArray(v._pixelsP3);
    seen.set(v, o);
    return o;
  }
  // An ImageData clones to a new ImageData with a copy of its pixel buffer (its
  // members are readonly getters, so a generic own-property copy would produce an
  // empty object — clone through the constructor to get a real, usable ImageData).
  if (tag === '[object ImageData]' && globalThis.ImageData) {
    const o = new globalThis.ImageData(new globalThis.Uint8ClampedArray(v.data), v.width, v.height, { colorSpace: v.colorSpace });
    seen.set(v, o);
    return o;
  }
  // A FileList clones to a FileList of cloned File entries (it is serializable).
  if (tag === '[object FileList]') {
    const out = new globalThis.FileList(Array.from(v).map(f => cloneInto(f, seen)));
    seen.set(v, out);
    return out;
  }
  if (tag === '[object Map]') {
    const out = new Map(); seen.set(v, out);
    for (const [k, val] of v) out.set(cloneInto(k, seen), cloneInto(val, seen));
    return out;
  }
  if (tag === '[object Set]') {
    const out = new Set(); seen.set(v, out);
    for (const x of v) out.add(cloneInto(x, seen));
    return out;
  }
  if (tag === '[object ArrayBuffer]') {
    // A resizable ArrayBuffer clones to a resizable buffer with the same maxByteLength
    // (structured-clone "Resizable ArrayBuffer").
    const copy = v.resizable ? new ArrayBuffer(v.byteLength, { maxByteLength: v.maxByteLength })
                             : new ArrayBuffer(v.byteLength);
    new Uint8Array(copy).set(new Uint8Array(v));
    seen.set(v, copy);
    return copy;
  }
  if (ArrayBuffer.isView && ArrayBuffer.isView(v)) {
    const isDV = tag === '[object DataView]';
    // Capture the source view's geometry BEFORE its buffer may be detached by a transfer.
    // An out-of-bounds view (its buffer was resized below the view's offset) can't be
    // serialized — reading its offset/length throws, which we surface as DataCloneError
    // (structured-clone "Transferring OOB … throws"). A LENGTH-TRACKING view over a resizable
    // buffer (byteOffset 0, currently spanning the whole buffer) is rebuilt WITHOUT a length so
    // the clone keeps tracking after a later resize.
    let offset, len, tracks;
    try {
      offset = v.byteOffset;
      const bl = v.buffer.byteLength;
      // The view is out of bounds if its buffer shrank below the view's offset.
      if (offset > bl) throw 0;
      tracks = v.buffer.resizable && offset === 0 && (offset + v.byteLength === bl);
      len    = isDV ? v.byteLength : v.length;
    } catch (_) { throw dataCloneError('An out-of-bounds ArrayBuffer view could not be cloned.'); }
    const buf = (currentTransfer && currentTransfer.set.has(v.buffer)) ? transferredCounterpart(v.buffer) : cloneInto(v.buffer, seen);
    let out;
    // A typed array's 3rd constructor arg is an element COUNT; a DataView takes a BYTE length.
    try { out = tracks ? new v.constructor(buf) : new v.constructor(buf, offset, len); }
    catch (_) { throw dataCloneError('An out-of-bounds ArrayBuffer view could not be cloned.'); }
    seen.set(v, out);
    return out;
  }
  if (Array.isArray(v)) {
    const out = new Array(v.length); seen.set(v, out);
    // Copy EVERY own enumerable property, not just the indices — a structured clone preserves
    // an array's non-index own props too (battery test "Array with non-index property").
    for (const k of Object.keys(v)) out[k] = cloneInto(v[k], seen);
    return out;
  }
  // Non-serializable platform objects throw DataCloneError (StructuredSerialize) rather
  // than degrading to a plain-object copy — URL / URLSearchParams have no [Serializable]
  // (url/historical: "no structured serialize/deserialize support"). Brand-tag matched
  // (their @@toStringTag) so a cross-realm value handed over by postMessage is caught too.
  if (tag === '[object URL]' || tag === '[object URLSearchParams]') {
    throw dataCloneError();
  }
  // Fetch types (Response / Request / Headers) are platform objects with no [Serializable] —
  // cloning one is a DataCloneError, not a plain-object degrade (structured-clone "Serializing a
  // non-serializable platform object fails"). They carry no @@toStringTag, so brand by instanceof.
  if ((globalThis.Response && v instanceof globalThis.Response) ||
      (globalThis.Request  && v instanceof globalThis.Request) ||
      (globalThis.Headers  && v instanceof globalThis.Headers)) {
    throw dataCloneError();
  }
  // The global object (`[object Window]`, brand-matched so a cross-realm global is caught too)
  // and DOM Nodes are host objects with no [Serializable]: cloning one is a DataCloneError, not a
  // plain-object degrade. Structural so the contract doesn't rely on the global incidentally
  // carrying a function-valued own property (which would otherwise be what throws).
  if (tag === '[object Window]' || v === globalThis || (globalThis.Node && v instanceof globalThis.Node)) {
    throw dataCloneError();
  }
  // Transferable-ONLY platform objects (MessagePort / ReadableStream / OffscreenCanvas) have no
  // [Serializable]: cloning one that is NOT being transferred is a DataCloneError (a transferred one
  // was already handed to its moved counterpart via the `currentTransfer.set` check above).
  if (v instanceof MessagePort ||
      (globalThis.ReadableStream  && v instanceof globalThis.ReadableStream) ||
      (globalThis.OffscreenCanvas && v instanceof globalThis.OffscreenCanvas)) {
    throw dataCloneError();
  }
  const out = {}; seen.set(v, out);
  for (const k of Object.keys(v)) out[k] = cloneInto(v[k], seen);
  return out;
}
globalThis.structuredClone = function structuredClone(v, options) {
  const transferList = options && options.transfer ? Array.from(options.transfer) : [];
  const saved = currentTransfer;
  // A plain clone runs with NO transfer context — clear it so a nested structuredClone reached
  // through a getter can't route a value through an outer clone's transfer set.
  if (transferList.length === 0) {
    currentTransfer = null;
    try { return cloneInto(v, new Map()); } finally { currentTransfer = saved; }
  }
  // Validate every transferable up front (transferable + not already detached) WITHOUT
  // neutering — an OOB view still in the value graph must fail the serialize step first, and the
  // source buffers are only detached AFTER the whole graph is cloned (transferValue copies the
  // bytes and records the source in pendingDetach).
  const set = new Set(transferList);
  for (const t of set) validateTransferable(t);
  currentTransfer = { set, cache: new Map(), pendingDetach: [] };
  try {
    const result = cloneInto(v, new Map());
    // Transfer any listed transferables the value graph didn't reach (they're neutered too).
    for (const t of set) transferredCounterpart(t);
    // Detach the transferred ArrayBuffers now that every view over them has been cloned.
    for (const ab of currentTransfer.pendingDetach) { try { ab.transfer(); } catch (_) {} }
    return result;
  } finally {
    currentTransfer = saved;
  }
};

// StructuredSerializeWithTransfer for a `message` + `transfer` list: clone the message and MOVE
// each listed transferable (a MessagePort is re-homed to a fresh entangled object and its source
// neutered; an ArrayBuffer is copied then detached), returning the moved MessagePorts in
// transfer-list order for delivery in the message event's `ports`. Same-isolate, so a moved value
// IS the received object. Used by MessagePort.postMessage; the window / worker paths clone inline.
function serializeMessageWithTransfer(data, transferList) {
  const set = new Set(transferList);
  // A transferable listed twice is a DataCloneError (it can't be transferred to two places).
  if (set.size !== transferList.length) throw dataCloneError('A transferable was listed more than once.');
  for (const t of set) validateTransferable(t);
  const saved = currentTransfer;
  currentTransfer = { set, cache: new Map(), pendingDetach: [] };
  try {
    const serialized = cloneInto(data, new Map());
    const ports = [];
    // Move any listed transferable the value graph didn't reach (it's neutered too); a MessagePort
    // is delivered in `ports` as its moved counterpart.
    for (const t of transferList) {
      const moved = transferredCounterpart(t);
      if (t instanceof MessagePort) ports.push(moved);
    }
    for (const ab of currentTransfer.pendingDetach) { try { ab.transfer(); } catch (_) {} }
    return { data: serialized, ports };
  } finally {
    currentTransfer = saved;
  }
}

// `reportError(error)` — HTML "report the exception": fire a cancelable `error`
// ErrorEvent on the global, then, only if no listener cancelled it, log to the
// console. This is also the channel a throwing event-loop callback surfaces
// through (e.g. queueMicrotask), so it must fire the `error` event — NOT the
// promise-rejection channel — to match real-browser behavior.
let __csimReportingError = false;
globalThis.reportError = function reportError(e) {
  // Re-entrancy guard: an `error` handler (`window.onerror` / an `error`
  // listener) that itself throws is reported too — but firing ANOTHER `error`
  // event for it would recurse unboundedly. While already reporting, skip the
  // event and just log, matching browsers (error reporting is not re-entrant).
  if (__csimReportingError) {
    try { console.error(e && e.stack ? e.stack : String(e)); } catch (_) {}
    return;
  }
  let cancelled = false;
  __csimReportingError = true;
  try {
    if (typeof globalThis.ErrorEvent !== 'undefined' && typeof globalThis.dispatchEvent === 'function') {
      const ev = new globalThis.ErrorEvent('error', {
        cancelable: true,
        // Duck-type, not `instanceof Error`: a cross-realm Error (reported on the
        // callback's realm via `__csimReportCallbackError`) isn't an instance of
        // THIS realm's Error, but still has a string `message` to surface.
        message:    e && typeof e === 'object' && typeof e.message === 'string' ? e.message : String(e),
        error:      e
      });
      // dispatchEvent returns false iff a listener called preventDefault.
      cancelled = globalThis.dispatchEvent(ev) === false;
    }
  } catch (_) {} finally { __csimReportingError = false; }
  if (!cancelled) {
    try { console.error(e && e.stack ? e.stack : String(e)); } catch (_) {}
  }
};

// The cross-realm global associated with `anchor` (its [[Realm]]), or null when
// same-realm / no realm info / no realm support. rusty_racer's
// `RustyRacer.contextOf(value)` maps ANY value (function or object) to its
// realm id; `contextGlobal(id)` is that realm's global.
//
// This is on the event-dispatch hot path on multi-realm pages (events.js calls
// it per listener), where the OVERWHELMING majority of callbacks are same-realm.
// `__csimSelfRealmId` memoizes THIS realm's own id (constant per realm) so the
// same-realm case is a single `contextOf` + integer compare — it never pays the
// second `contextGlobal` native crossing (rule 3).
let __csimSelfRealmId;
function __csimRealmGlobalOf(anchor) {
  try {
    const NS = globalThis.RustyRacer;
    if (anchor && NS && typeof NS.contextOf === 'function' && typeof NS.contextGlobal === 'function') {
      if (__csimSelfRealmId === undefined) {
        const self = NS.contextOf(globalThis);
        if (self != null) __csimSelfRealmId = self;
      }
      const id = NS.contextOf(anchor);
      if (id != null && id !== __csimSelfRealmId) {
        const g = NS.contextGlobal(id);
        if (g && g !== globalThis) return g;
      }
    }
  } catch (_) {}
  return null;
}
// Exposed so the event-dispatch path (events.js) can route the legacy
// `window.event` current-event to a cross-realm listener / on-handler's own
// global per DOM "inner invoke" (event-global-is-still-set-*).
globalThis.__csimRealmGlobalOf = __csimRealmGlobalOf;

// ── WindowProxy (cross-realm window references) ──
// A reference from THIS realm (the observer) to ANOTHER same-page realm's window
// is a Proxy over that realm's raw global. It exists so cross-realm postMessage
// sets `event.source` correctly: the proxy bakes in the OBSERVER realm (= the
// holder = the sender when it calls `proxy.postMessage`), captured here at
// creation time — immune to caching / async continuations (unlike an "incumbent"
// slot, which can't recover a cached-ref sender). Transparent for everything else
// (reads/writes/getters/constructors forward to the raw global). Cached per
// target realm so identity holds: `iframe.contentWindow` === a later `e.source`
// from that frame === `parent` seen from inside it.
const __winProxyByTarget = new Map();   // targetRealmId -> this realm's proxy for it
const __winProxyRaw      = new WeakMap();   // proxy -> raw target global (for unwrap)
// EventTarget methods (events.js) call this so add/removeEventListener/dispatch
// operate on the REAL window (listeners must live where events actually fire).
globalThis.__csimUnwrapWindow = function (o) {
  if (o && typeof o === 'object') { const raw = __winProxyRaw.get(o); if (raw) return raw; }
  return o;
};
globalThis.__csimIsWindowProxy = function (o) {
  return !!(o && typeof o === 'object' && __winProxyRaw.has(o));
};
function __csimSelfId() {
  const NS = globalThis.RustyRacer;
  if (!NS || typeof NS.contextOf !== 'function') return undefined;
  if (__csimSelfRealmId === undefined) {
    try { __csimSelfRealmId = NS.contextOf(globalThis); } catch (_) {}
  }
  return __csimSelfRealmId;
}
// The properties a cross-origin Window exposes (HTML "CrossOriginProperties").
// Reading anything else (most notably `document`) on a cross-origin WindowProxy
// throws a SecurityError; these stay readable so postMessage / frame-navigation /
// opener handshakes keep working across origins.
const CROSS_ORIGIN_WINDOW_PROPS = new Set([
  'window', 'self', 'location', 'close', 'closed', 'focus', 'blur',
  'frames', 'length', 'top', 'opener', 'parent', 'postMessage'
]);
function crossOriginSecurityError() {
  return new globalThis.DOMException("Blocked a frame from accessing a cross-origin frame.", 'SecurityError');
}
// Which keys a cross-origin WindowProxy still exposes to `[[Get]]` / `[[Has]]` /
// `[[OwnPropertyKeys]]`: the CrossOriginProperties, indexed-frame keys, any Symbol
// (@@toStringTag etc.), and internal `__csim*` bookkeeping (never web-observable — the
// blob-nav snapshot walk reads it on a cross-origin parent/top). Everything else is hidden.
function crossOriginWindowAccessible(prop) {
  if (typeof prop === 'symbol') return true;
  if (typeof prop !== 'string') return false;
  return prop.lastIndexOf('__csim', 0) === 0 || /^[0-9]+$/.test(prop) || CROSS_ORIGIN_WINDOW_PROPS.has(prop);
}
// A cross-origin `Location` exposes ONLY the `href` SETTER and `replace()` (HTML
// CrossOriginProperties for Location); every other member — the `href` getter,
// `assign`, `protocol`, `reload`, … — throws SecurityError. `location` itself IS a
// cross-origin-readable Window property, so `frame.location` returns this wrapper rather
// than throwing; the wrapper then guards the members. Proxied over the raw Location (whose
// members are all configurable own accessors, so hiding the disallowed ones honours the
// Proxy invariants). Cached per raw Location so identity is stable across reads.
const __crossLocByRaw = new WeakMap();
function crossOriginLocation(rawLoc) {
  let w = __crossLocByRaw.get(rawLoc);
  if (w) return w;
  const allowed = (prop) => prop === 'href' || prop === 'replace';
  w = new Proxy(rawLoc, {
    get(t, prop) {
      if (typeof prop === 'symbol') return Reflect.get(t, prop, t);   // @@toStringTag etc.
      if (typeof prop === 'string' && prop.lastIndexOf('__csim', 0) === 0) return Reflect.get(t, prop, t);
      if (prop === 'replace') return (url) => t.replace(url);   // the one allowed method
      throw crossOriginSecurityError();                          // href GETTER + everything else
    },
    set(t, prop, val) {
      if (prop === 'href') { try { t.href = val; } catch (_) {} return true; }   // the one allowed setter
      throw crossOriginSecurityError();
    },
    has(_t, prop)  { return allowed(prop) || typeof prop === 'symbol'; },
    ownKeys()      { return ['href', 'replace']; },
    getOwnPropertyDescriptor(t, prop) {
      if (!allowed(prop)) return undefined;
      // Must be configurable (the wrapper target is a real object whose href/replace ARE
      // configurable own props) so the ownKeys ⇄ getOwnPropertyDescriptor invariant holds.
      return { configurable: true, enumerable: false, value: prop === 'replace' ? w.replace : undefined, writable: true };
    },
    getPrototypeOf() { return null; },
    setPrototypeOf() { return false; },
    defineProperty() { return false; },
    deleteProperty() { return false; }
  });
  __crossLocByRaw.set(rawLoc, w);
  return w;
}
// Same-origin iff the target realm's document origin equals THIS realm's. Read the
// origin off the raw child global (not the proxy) — same serialized-compare rule as
// contentDocument's SOP: distinct opaque origins both serialize to "null", and the
// only "null" === "null" hit is a child that inherited this realm's opaque origin
// (about:blank / srcdoc under an opaque parent). Fail CLOSED (cross-origin) if the
// origin can't be read.
function isSameOriginAs(rawWindow) {
  let o, read = false;
  try { o = rawWindow.origin; read = true; } catch (_) {}
  return read && o === globalThis.origin;
}
globalThis.__csimIsSameOriginWindow = isSameOriginAs;

function frameWindowProxyFor(targetRealmId) {
  const NS = globalThis.RustyRacer;
  if (targetRealmId == null || !NS || typeof NS.contextGlobal !== 'function' || typeof NS.contextOf !== 'function') return null;
  let raw;
  try { raw = NS.contextGlobal(targetRealmId); } catch (_) { return null; }
  if (!raw) return null;
  // Same realm → the real global (`window === self === globalThis`, never a proxy).
  const selfId = __csimSelfId();
  if (raw === globalThis || targetRealmId === selfId) return globalThis;
  let p = __winProxyByTarget.get(targetRealmId);
  if (p) return p;
  const observerId = selfId, targetId = targetRealmId;
  const pmsg = function (message, targetOriginOrOptions, transfer) {
    // A bad targetOrigin is a SyntaxError thrown SYNCHRONOUSLY before the cross-realm hand-off, minted
    // in the TARGET window's realm (`raw`) — a method's exceptions belong to its own realm. Accept
    // both the WindowPostMessageOptions dictionary and the legacy (targetOrigin, transfer) form.
    validatePostMessageTargetOrigin(targetOriginOrOptions, raw);
    const to   = postMessageTargetOriginOf(targetOriginOrOptions);
    const xfer = isPostMessageOptions(targetOriginOrOptions) && targetOriginOrOptions != null
      ? targetOriginOrOptions.transfer : transfer;
    return globalThis.__csimPostMessageRealm(observerId, targetId, message, to, xfer);
  };
  // Same-origin-ness of this proxy (over a fixed target `raw`) can only change when the OBSERVER
  // realm's origin changes — and a freshly built child realm is created with an INHERITED
  // (about:blank) origin, then `__csimUpdateLocation` sets its real one AFTER its parent/top proxies
  // exist. A plain "memoize true" cache captured that transient inherited origin: a cross-origin
  // child whose parent proxy was touched pre-navigation (parent === child origin then) memoized
  // same-origin=true and never re-evaluated, leaving `parent.document` readable for the frame's life
  // (a cross-origin SOP hole). Key the cache on the observer's CURRENT origin instead: the hot
  // stable-origin path still returns the cached result (rule 3), but the first read after the origin
  // is finalized recomputes. `raw.origin` (the target) is stable — a target re-navigation disposes
  // its realm and evicts this proxy — so only the observer origin varies.
  let memoOrigin = null, memoResult = false;
  const sameOrigin = () => {
    let cur = ''; try { cur = globalThis.origin || ''; } catch (_) {}
    if (memoOrigin !== cur) { memoResult = isSameOriginAs(raw); memoOrigin = cur; }
    return memoResult;
  };
  p = new Proxy(raw, {
    get(t, prop) {
      if (prop === '__csimRawWindow') return t;   // unwrap hook (also used cross-realm)
      if (prop === 'postMessage') return pmsg;
      if (prop === 'window' || prop === 'self') return p;
      // Observer-relative IDENTITY for `parent` / `top`, narrowest form: when the target's own
      // parent/top IS this (observer) realm's window, hand back the raw `globalThis` so a cross-
      // origin child's `parent`, read from its actual parent, is `window` itself (event.source /
      // opener reply patterns). Any OTHER target — a different window — returns the raw resolution
      // unchanged, so internal frame/SW walks that depend on the raw parent/top chain are untouched.
      // (parent/top are CrossOriginProperties, so this bypasses nothing the SOP gate below would
      // have blocked.)
      if ((prop === 'parent' || prop === 'top') && !sameOrigin()) {
        let inner; try { inner = Reflect.get(t, prop, t); } catch (_) {}
        const innerRaw = (inner && inner.__csimRawWindow) || inner;
        return innerRaw === globalThis ? globalThis : inner;
      }
      // SOP: a cross-origin WindowProxy exposes only the CrossOriginProperties;
      // reading anything else (e.g. `document`) throws SecurityError. Internal
      // driver bookkeeping (`__csim*`) is never web-observable so it bypasses the
      // gate (the blob-nav snapshot walk reads it on cross-origin parent/top);
      // Symbols and numeric (indexed-frame) keys pass through too.
      if (typeof prop === 'string' && prop.lastIndexOf('__csim', 0) !== 0 &&
          !/^[0-9]+$/.test(prop) && !CROSS_ORIGIN_WINDOW_PROPS.has(prop) && !sameOrigin()) {
        throw crossOriginSecurityError();
      }
      // `location` is cross-origin-readable, but the returned Location is itself SOP-gated:
      // only its `href` setter + `replace()` work cross-origin (so `frame.location.href`
      // GETTER throws, not leaks the URL). Same-origin returns the raw Location unchanged.
      if (prop === 'location' && !sameOrigin()) {
        const raw = Reflect.get(t, prop, t);
        return raw ? crossOriginLocation(raw) : raw;
      }
      return Reflect.get(t, prop, t);   // getters/methods resolve against the real window
    },
    set(t, prop, val)                 { try { Reflect.set(t, prop, val, t); } catch (_) {} return true; },
    // `[[Has]]` / `[[OwnPropertyKeys]]` / `[[GetOwnProperty]]` are SOP-gated cross-origin so the
    // same-origin surface (`'document' in frame`, `Object.keys(frame)`, a descriptor probe) doesn't
    // leak. A non-accessible key is hidden — safe because every window own property we'd hide is
    // configurable (the Proxy invariant only forbids hiding a NON-configurable own property, and any
    // such key falls through to the real reflection). `in` reports absent (false); a direct
    // descriptor probe throws SecurityError, matching browsers.
    has(t, prop) {
      if (sameOrigin() || crossOriginWindowAccessible(prop)) return Reflect.has(t, prop);
      const d = Reflect.getOwnPropertyDescriptor(t, prop);
      return !!(d && !d.configurable);
    },
    deleteProperty(t, prop)           { try { return Reflect.deleteProperty(t, prop); } catch (_) { return false; } },
    getOwnPropertyDescriptor(t, prop) {
      if (sameOrigin() || crossOriginWindowAccessible(prop)) return Reflect.getOwnPropertyDescriptor(t, prop);
      const d = Reflect.getOwnPropertyDescriptor(t, prop);
      if (d && !d.configurable) return d;   // invariant: a non-configurable own prop can't be hidden
      throw crossOriginSecurityError();     // hidden props throw on a direct descriptor probe
    },
    ownKeys(t) {
      if (sameOrigin()) return Reflect.ownKeys(t);
      return Reflect.ownKeys(t).filter(k =>
        crossOriginWindowAccessible(k) || (Reflect.getOwnPropertyDescriptor(t, k) || {}).configurable === false);
    },
    getPrototypeOf(t)                 { return sameOrigin() ? Reflect.getPrototypeOf(t) : null; },
    setPrototypeOf()                  { return false; }
  });
  __winProxyByTarget.set(targetId, p);
  __winProxyRaw.set(p, raw);
  return p;
}
globalThis.__csimFrameWindowProxyFor = frameWindowProxyFor;
// Drop a disposed frame realm's cached WindowProxy (and unpin its raw global) so
// it doesn't linger after the iframe is removed — called from the realm that owns
// the iframe when it disposes the child realm. Cheap; no-op if not cached here.
globalThis.__csimEvictWindowProxy = function (targetRealmId) {
  const p = __winProxyByTarget.get(targetRealmId);
  if (p) { __winProxyByTarget.delete(targetRealmId); __winProxyRaw.delete(p); }
};
// True iff this is a multi-realm page (owns child realms, or is itself a frame) —
// the only case where cross-realm WindowProxy retargeting can apply. Lets the hot
// single-realm dispatch / composedPath paths short-circuit (rule 3). Property
// reads only (no native crossing).
globalThis.__csimMultiRealm = function () {
  return !!((globalThis.__csimChildRealmIds && globalThis.__csimChildRealmIds.size) ||
            (globalThis.top && globalThis.top !== globalThis));
};
// True if `o` is a realm's global object (a Window) — used by event dispatch to
// retarget a window event-target to the observing listener's own WindowProxy.
globalThis.__csimIsWindowGlobal = function (o) {
  if (!o || typeof o !== 'object') return false;
  if (o === globalThis) return true;
  const NS = globalThis.RustyRacer;
  if (!NS || typeof NS.contextOf !== 'function' || typeof NS.contextGlobal !== 'function') return false;
  try { const id = NS.contextOf(o); return id != null && NS.contextGlobal(id) === o; } catch (_) { return false; }
};
// Is this realm's WHOLE window chain (self → top) free of insecure (http:)
// documents? A service worker only controls a client ALL of whose ancestors are
// secure contexts (HTML "secure context"), so a navigation initiated from — or a
// frame built under — an http document bypasses SW interception
// (secure-context.https). Walks the raw parent chain (the `__csimRawWindow`
// unwrap is SOP-exempt), so a cross-origin ancestor doesn't throw.
globalThis.__csimSecureAncestorChain = function () {
  try {
    let w = globalThis;
    for (let hops = 0; hops < 64; hops++) {
      if (((w.location && w.location.protocol) || '') === 'http:') return false;
      const p = w.parent;
      const raw = (p && p.__csimRawWindow) || p;
      if (!raw || raw === w) return true;
      w = raw;
    }
  } catch (_) {}
  return true;
};
globalThis.__csimRealmGlobalById = function (id) {
  const NS = globalThis.RustyRacer;
  if (id == null || !NS || typeof NS.contextGlobal !== 'function') return null;
  try { return NS.contextGlobal(id) || null; } catch (_) { return null; }
};
// Iterate this realm's direct child realms' globals, calling `cb(childGlobal)`. If a
// call returns a value !== undefined, iteration stops and returns it (a "first hit"
// search); otherwise returns undefined after visiting all. Keeps the child-realm
// fan-out guard (set presence + contextGlobal availability) in ONE place for the
// blob-store / worker-delivery searches. (timers.js drainChildRealms keeps its own
// hot-path loop — it gates per child and folds results differently.)
globalThis.__csimEachChildRealm = function (cb) {
  const ids = globalThis.__csimChildRealmIds;
  if (!ids || !ids.size) return undefined;
  for (const id of ids) {
    const g = globalThis.__csimRealmGlobalById(id);
    if (!g) continue;
    let r;
    try { r = cb(g); } catch (_) { r = undefined; }
    if (r !== undefined) return r;
  }
  return undefined;
};
// The realm of the event listener currently running, recorded by the dispatch
// paths so `composedPath()` (which runs in the EVENT's realm) can present the
// window entry as the LISTENER realm's WindowProxy. Slot lives on the shared main
// global (reachable cross-realm via `top`).
globalThis.__csimSetActiveListenerRealm = function (handler) {
  const NS = globalThis.RustyRacer;
  const root = globalThis.top || globalThis;
  let id;
  if (NS && typeof NS.contextOf === 'function' && handler != null) { try { id = NS.contextOf(handler); } catch (_) {} }
  try { root.__csimActiveListenerRealmId = id; } catch (_) {}
  return id;
};
globalThis.__csimGetActiveListenerRealm = function () {
  const root = globalThis.top || globalThis;
  try { return root.__csimActiveListenerRealmId; } catch (_) { return undefined; }
};
// Map a window global to the active-listener realm's WindowProxy (for
// composedPath / any post-dispatch window-in-path read). No-op same-realm.
globalThis.__csimRetargetWindow = function (win) {
  const NS = globalThis.RustyRacer;
  if (!win || !NS || typeof NS.contextOf !== 'function') return win;
  const obsId = globalThis.__csimGetActiveListenerRealm();
  if (obsId == null) return win;
  let winId; try { winId = NS.contextOf(win); } catch (_) { return win; }
  if (obsId === winId) return win;
  const obs = globalThis.__csimRealmGlobalById(obsId);
  if (obs && typeof obs.__csimFrameWindowProxyFor === 'function') {
    try { return obs.__csimFrameWindowProxyFor(winId) || win; } catch (_) {}
  }
  return win;
};
// Deliver a cross-realm same-page postMessage. Called (in the SENDER realm) by a
// WindowProxy's postMessage; routes into the TARGET realm so the payload is cloned
// there and the message task queued there with `event.source` = the target's own
// proxy for the sender.
// Parse the origin of a postMessage targetOrigin argument (an absolute URL or a
// bare origin); '' if unparseable.
function originOfTarget(s) {
  try { return new globalThis.URL(String(s)).origin; } catch (_) { return ''; }
}
function realmOrigin(realmId) {
  try { const g = globalThis.__csimRealmGlobalById(realmId); return g ? g.origin : ''; } catch (_) { return ''; }
}
globalThis.__csimPostMessageRealm = function (senderId, targetId, message, targetOrigin, transfer) {
  const g = globalThis.__csimRealmGlobalById(targetId);
  const D = (g && g.DOMException) || globalThis.DOMException;
  const tf = Array.isArray(transfer) ? transfer : [];
  // StructuredSerializeWithTransfer in the SENDER realm, NOW (HTML transfers at post time, before
  // the origin check can discard a mis-targeted message). It does three things at once:
  //   * validates the whole message graph is cloneable — a Document / function / other
  //     non-serializable value, or a transferable listed twice, throws DataCloneError SYNCHRONOUSLY,
  //     which is what `assert_throws(() => frame.postMessage(…))` checks;
  //   * moves each ArrayBuffer's bytes INTO the payload (a bare detach would leave the target
  //     re-cloning a detached buffer → the receiver gets nothing — cross-site ArrayBuffer transfer);
  //   * moves each MessagePort onto a fresh entangled port for the target realm to adopt.
  // The DataClone exception belongs to the METHOD's realm — the target — so re-mint it there. The
  // target still re-clones the payload for receiver-realm object identity (see __csimDeliverFrameMessage).
  let data, ports;
  try { ({ data, ports } = serializeMessageWithTransfer(message, tf)); }
  catch (e) {
    if (e && e.name === 'DataCloneError') throw new D(e.message, 'DataCloneError');
    throw e;
  }
  if (!g || typeof g.__csimDeliverFrameMessage !== 'function') return;
  // HTML "window post message": the targetOrigin gates delivery. "*" always
  // delivers; "/" requires the target be same-origin as the SENDER; any other
  // value must equal the TARGET's origin or the message is silently dropped.
  const to = targetOrigin == null ? '*' : String(targetOrigin);
  const senderOrigin = realmOrigin(senderId);
  if (to !== '*') {
    let targetOrig = ''; try { targetOrig = g.origin; } catch (_) {}
    const wanted = to === '/' ? senderOrigin : originOfTarget(to);
    if (targetOrig !== wanted) return;
  }
  // event.origin in the receiver is the SENDER's origin (not '').
  g.__csimDeliverFrameMessage(senderId, data, senderOrigin, ports);
};
// Adopt a MessagePort transferred from another realm INTO this realm: create a
// realm-native port and move the transferred port's entanglement (peer + pending
// queue + enabled state) onto it, so a delivered `event.ports[i]` is a this-realm
// MessagePort (brand-correct) whose postMessage/structuredClone run in this realm.
// The cross-realm `_peer` reference routes messages both ways (each port's method
// runs in its own realm). The transient sender-realm moved port is neutered.
// LIMITATION: a `port.postMessage` clones its payload in the SENDER's realm (as the
// same-realm path does) and the peer dispatches it without re-cloning, so across
// realms `event.data` is a foreign-realm object graph — fine for plain/JSON payloads
// (property reads + @@toStringTag brand checks work), off for receiver-realm
// `instanceof Object` identity. Matches the same-realm transfer model.
function adoptPortIntoRealm(mp) {
  const p = new MessagePort();
  p._peer    = mp._peer;
  p._started = mp._started;
  p._queue   = mp._queue || [];
  if (mp._peer) mp._peer._peer = p;
  mp._peer = null; mp._queue = []; mp._detached = true;
  return p;
}
// Runs in the TARGET realm: clone the payload into this realm, adopt any transferred
// ports, and queue the `message` event task with source = this realm's proxy for the sender.
globalThis.__csimDeliverFrameMessage = function (senderId, message, senderOrigin, movedPorts) {
  let data;
  try { data = structuredClone(message); } catch (_) { data = message; }
  const ports = [];
  if (Array.isArray(movedPorts)) {
    for (const mp of movedPorts) { try { ports.push(adoptPortIntoRealm(mp)); } catch (_) {} }
  }
  setTimeout(() => {
    let source = null;
    try { source = frameWindowProxyFor(senderId); } catch (_) {}
    try {
      dispatchWithOnHandler(globalThis, new MessageEvent('message', {
        data, origin: senderOrigin || '', source, lastEventId: '', ports
      }));
    } catch (_) {}
  }, 0);
};

// Re-create `e` as a TypeError of realm `g` when it is a TypeError not already
// belonging to `g`. WebIDL "invoke a callback function" runs with the callback's
// [[Realm]] current, so a TypeError it raises (non-callable operation, revoked
// Proxy) is of THAT realm — but we can't switch V8's active realm from JS, so the
// caught error is in the wrong realm. Rebuilding it under `g.TypeError` makes
// cross-realm `error.constructor === g.TypeError` / `instanceof g.TypeError`
// hold. ONLY TypeErrors are rebuilt: a filter/listener that throws a DOMException
// or a custom error must propagate UNCHANGED (rebuilding would erase its type).
function __csimRealmizeError(g, e) {
  try {
    if (g && e && e.name === 'TypeError' && typeof g.TypeError === 'function' && !(e instanceof g.TypeError)) {
      return new g.TypeError(e.message != null ? String(e.message) : String(e));
    }
  } catch (_) {}
  return e;
}

// "Report the exception" for a CALLBACK that threw (timer / microtask /
// observer). Per WebIDL "invoke a callback function", the exception is reported
// on the callback's [[Realm]] global — NOT the realm that scheduled it. We fire
// that realm's OWN `reportError` (so its ErrorEvent + window.onerror run in the
// right global). Same-realm / no realm support → the local `reportError`.
globalThis.__csimReportCallbackError = function (cb, e) {
  const g = (typeof cb === 'function') ? __csimRealmGlobalOf(cb) : null;
  if (g && typeof g.reportError === 'function') {
    try { g.reportError(e); return; } catch (_) {}
  }
  globalThis.reportError(e);
};

// "Report the exception" for an EVENT LISTENER invocation that failed — a
// missing/non-callable `handleEvent` or a throw from the call. Like
// __csimReportCallbackError, but ALSO re-creates the error in the listener
// realm so `error.constructor === otherRealm.TypeError` holds. `anchor` is the
// listener object/function (the callback realm), distinct from the thrown
// error's realm (e.g. a same-realm revoked Proxy used as a cross-realm
// listener's handleEvent). Same-realm → identical to reportError.
globalThis.__csimReportListenerError = function (anchor, e) {
  const g = __csimRealmGlobalOf(anchor);
  if (g && typeof g.reportError === 'function') {
    try { g.reportError(__csimRealmizeError(g, e)); return; } catch (_) {}
  }
  globalThis.reportError(e);
};

// Realm-correct an exception that PROPAGATES to the caller rather than being
// reported — a NodeFilter `acceptNode` failure in TreeWalker / NodeIterator,
// where `assert_throws_js(otherRealm.TypeError, …)` checks the thrown error's
// realm. Returns the error re-created in `anchor`'s realm (or `e` unchanged
// same-realm). The caller throws the result.
globalThis.__csimRealmizeCallbackError = function (anchor, e) {
  return __csimRealmizeError(__csimRealmGlobalOf(anchor), e);
};

// Is `cb` still "runnable" — i.e. does it belong to a browsing context that
// hasn't been destroyed? A callback whose realm is a DISPOSED child frame realm
// (the frame was removed from the document) is no longer runnable, and per HTML
// "invoke a callback function" the caller throws instead of calling it (e.g.
// NodeIterator/TreeWalker filtering after `iframe.remove()`). Returns true for a
// same-realm/main callback, an object-shaped callback with no realm, or when the
// engine has no realm support (QuickJS) — only a callback mapping to a child
// realm id no longer in `__csimChildRealmIds` is dead.
// (dom/traversal/TreeWalker-acceptNode-filter-cross-realm-null-browsing-context.html)
globalThis.__csimCallbackRunnable = function (cb) {
  try {
    const NS = globalThis.RustyRacer;
    if (!cb || !NS || typeof NS.contextOf !== 'function') return true;
    const id = NS.contextOf(cb);
    if (id == null) return true;
    if (id === NS.contextOf(globalThis)) return true;  // main realm
    return !!(globalThis.__csimChildRealmIds && globalThis.__csimChildRealmIds.has(id));
  } catch (_) { return true; }
};

// `requestIdleCallback` / `cancelIdleCallback` — fall back to
// `setTimeout(0)` so libraries that defer expensive setup to idle
// (Turbo Drive prefetch, Stimulus debounced renders) make progress.
globalThis.requestIdleCallback = function (cb) {
  return globalThis.setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 0 }), 0);
};
globalThis.cancelIdleCallback = function (id) { globalThis.clearTimeout(id); };

// CSSOM types (`CSSStyleSheet` / the `CSSRule` hierarchy / `CSSRuleList` /
// `MediaList` / `CSSStyleDeclaration`) live in cssom.js — a css-tree-backed object
// model — and are registered on globalThis there.

// DataTransfer + DataTransferItem(s) — drag-drop and ClipboardEvent
// surface. Real apps probe `e.dataTransfer instanceof DataTransfer`
// and iterate `dataTransfer.items` to handle drop / paste. Spec-
// shaped classes so those probes pass.
class DataTransferItem {
  constructor(kind, type, value, file) {
    this.kind  = kind;       // 'string' | 'file'
    this.type  = String(type || '');
    this._value = value;
    this._file = file || null;
  }
  getAsString(cb) {
    if (this.kind !== 'string' || typeof cb !== 'function') return;
    Promise.resolve().then(() => { try { cb(this._value); } catch (_) {} });
  }
  getAsFile() { return this.kind === 'file' ? this._file : null; }
}
// Spec DataTransferItemList exposes items by numeric index
// (`list[i]`) and `length`. Extending Array gives us both with
// trivial iteration; we just add the `add` / `clear` / `remove`
// methods on top.
class DataTransferItemList extends Array {
  add(data, type) {
    if (data && data.size != null && data.name) {  // File / Blob
      const item = new DataTransferItem('file', data.type || '', null, data);
      this.push(item);
      return item;
    }
    if (typeof data === 'string') {
      // The type is ASCII-lowercased, like every other drag-data-store format key.
      const item = new DataTransferItem('string', String(type || 'text/plain').toLowerCase(), data, null);
      this.push(item);
      return item;
    }
    return null;
  }
  clear() { this.length = 0; }
  remove(i) { this.splice(i | 0, 1); }
}
// FileList — the live array-like returned by `<input type=file>.files` and
// `DataTransfer.files`. `item` and `length` live on the PROTOTYPE (WPT
// filelist.html asserts they are inherited, not own properties), files are
// exposed as indexed own properties, and the constructor takes a rest param so
// `FileList.length === 0`.
class FileList {
  constructor(...args) {
    const files = args[0] ? Array.from(args[0]) : [];
    Object.defineProperty(this, '_items', { value: files });
    for (let i = 0; i < files.length; i++) this[i] = files[i];
  }
  get length() { return this._items.length; }
  item(i) { i = i >>> 0; return i < this._items.length ? this._items[i] : null; }
  [Symbol.iterator]() { return this._items[Symbol.iterator](); }
  get [Symbol.toStringTag]() { return 'FileList'; }
}
globalThis.FileList = FileList;

class DataTransfer {
  constructor() {
    this.items         = new DataTransferItemList();
    this.dropEffect    = 'none';
    this.effectAllowed = 'all';
  }
  // `types` is a VIEW of the drag data store, not a parallel list: every way an item can arrive
  // (`setData`, `items.add`, a driver-built drop) has to show up here, and a file item contributes
  // the "Files" entry. Derived rather than maintained so the entry points can't drift apart.
  get types() {
    const out = [];
    let hasFile = false;
    for (const it of this.items) {
      if (it.kind === 'file') hasFile = true;
      else if (!out.includes(it.type)) out.push(it.type);
    }
    if (hasFile) out.push('Files');
    return out;
  }
  // `files` is the FileList view of the file-kind items — derived so it stays in
  // sync however items were added (`items.add(file)`, drag-drop construction, …),
  // yet [SameObject]: the same FileList instance is returned while the file set is
  // unchanged (so `i.files = dt.files; dt.files === <that>` holds), rebuilt only
  // when the underlying files actually change.
  get files() {
    const out = [];
    for (const it of this.items) if (it.kind === 'file' && it._file) out.push(it._file);
    const cur = this._filesView;
    if (cur && cur._items.length === out.length && cur._items.every((f, i) => f === out[i])) {
      return cur;
    }
    return (this._filesView = new FileList(out));
  }
  getData(type) {
    const t = normalizeDataFormat(type);
    for (const it of this.items) if (it.kind === 'string' && it.type === t) return it._value;
    return '';
  }
  setData(type, value) {
    if (this._readOnly) return;   // read-only mode (an input/paste event's dataTransfer): a no-op
    const t = normalizeDataFormat(type);
    this._removeFormat(t);        // the drag data store holds ONE item per format — setData replaces
    this.items.add(String(value), t);
  }
  // `clearData()` with no format empties the store; `clearData(format)` removes just that one — and
  // the empty string IS a format, so the two cases turn on the argument being absent, not falsy.
  clearData(type) {
    if (this._readOnly) return;   // read-only mode: a no-op
    if (type == null) this.items.clear();
    else this._removeFormat(normalizeDataFormat(type));
  }
  // Drop the (single) string item stored under `format`. Splices in place so the indexed view stays
  // consistent — reassigning the backing array would leave Array index slots on the old entries.
  _removeFormat(format) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      if (this.items[i].kind === 'string' && this.items[i].type === format) this.items.splice(i, 1);
    }
  }
  setDragImage() {}
}
globalThis.DataTransfer         = DataTransfer;
globalThis.DataTransferItem     = DataTransferItem;
globalThis.DataTransferItemList = DataTransferItemList;

// MessageChannel / MessagePort — modern microtask-scheduler libraries
// (React 18, Scheduler, idle-callback polyfills) prefer MessageChannel
// over setTimeout(0) when available, posting to one port and reading
// from the other in the listener. We're single-isolate, so the two
// ports just shuttle messages within the same VM via a microtask.
class MessagePort extends EventTarget {
  constructor() {
    super();
    this._peer     = null;
    this._started  = false;   // "port message queue enabled" — set by start() / onmessage, NOT addEventListener
    this._queue    = [];      // messages received while the queue is still disabled
  }
  postMessage(data, transfer) {
    // Accept both transfer overload forms: the array `postMessage(msg, [port])` and the
    // `{transfer: [port]}` dictionary — same normalization as the Worker / SW / window entry points.
    const tf = transferListFrom(transfer);
    // Transferring the port you're posting through is a DataCloneError (a port can't be sent over
    // itself). Checked before serialization so nothing is moved on the failure path.
    if (tf.indexOf(this) !== -1) throw dataCloneError('The source port could not be transferred.');
    // A REMOTE port (its entangled peer lives in another isolate — window/frame realm ↔ worker/SW):
    // serialize the message + any transferred ports and route through the host by channel id. The
    // host delivers it to the peer isolate's port (__csimPortChannelDeliver → peer._accept).
    if (this._remoteChannel) {
      if (typeof globalThis.__csimEncodeMessage === 'function' && typeof globalThis.__csimPortRemotePost === 'function') {
        globalThis.__csimPortRemotePost(this._remoteChannel, globalThis.__csimEncodeMessage(data, tf));
      }
      return;
    }
    // StructuredSerialize[WithTransfer]: an uncloneable message (a DOM node, the global, a function,
    // a non-transferred transferable) throws DataCloneError SYNCHRONOUSLY at post time, like window /
    // BroadcastChannel. The peer receives a distinct clone (spec identity), and each listed
    // transferable is MOVED — a MessagePort becomes a new entangled object (source neutered) and is
    // delivered in `ports`; an ArrayBuffer is detached on the source.
    let payload, ports;
    if (tf.length === 0) {
      payload = globalThis.structuredClone ? globalThis.structuredClone(data) : data;
      ports   = [];
    } else {
      ({ data: payload, ports } = serializeMessageWithTransfer(data, tf));
    }
    const peer = this._peer;
    if (!peer) return;
    peer._accept(payload, ports);
  }
  // HTML "port message queue": a message is delivered as a task when the queue is enabled, else
  // held until start()/onmessage enables it (then flushed in order).
  _accept(data, ports) {
    if (this._started) this._deliverTask(data, ports);
    else this._queue.push({ data, ports });
  }
  // HTML "post a message": the dispatch is a TASK queued on the port message queue
  // (this realm's event-loop task source), NOT a microtask — so a message-driven
  // postMessage loop yields to other tasks (a co-queued `setTimeout(0)` interleaves
  // rather than being starved by a fully-draining microtask checkpoint), matching
  // MessageEvent_onmessage_postMessage_infinite_loop. Queuing on THIS realm's timer
  // queue also means a port owned by a detached iframe stops delivering once that
  // realm leaves the event loop (its timers are no longer drained) — the
  // message-channels/detached-iframe contract — where a microtask on the dead
  // realm's queue would still run.
  _deliverTask(data, ports) {
    globalThis.setTimeout(() => {
      if (this._detached) return;
      const ev = new MessageEvent('message', { data, ports, origin: '', lastEventId: '', source: null });
      ev.target = this;
      dispatchWithOnHandler(this, ev);
    }, 0);
  }
  // Enable the port message queue (start() / onmessage), flushing anything received while disabled
  // in arrival order. A no-op once already enabled.
  _enable() {
    if (this._started) return;
    this._started = true;
    if (this._queue.length) {
      const q = this._queue; this._queue = [];
      for (const m of q) this._deliverTask(m.data, m.ports);
    }
  }
  // addEventListener('message') does NOT enable the queue (only start()/onmessage do), so a port
  // used with addEventListener must call start() explicitly (MessagePort_initial_disabled).
  start() { this._enable(); }
  // close() DISENTANGLES this port: it's detached (so it can no longer be transferred — a closed
  // port in a transfer list is a DataCloneError) and its peer's back-reference is cleared so a
  // later `peer.postMessage(...)` has nowhere to deliver. The peer itself is NOT closed.
  close() {
    this._detached = true;
    const peer = this._peer;
    this._peer = null;
    if (peer && peer._peer === this) peer._peer = null;
  }
  // WebIDL brand → "[object MessagePort]". Also the REALM-INDEPENDENT brand the cross-isolate
  // message serializer (workers.js isMessagePort) relies on: `instanceof globalThis.MessagePort`
  // fails for a port transferred in from another realm (a frame posting to its parent-owned
  // controller, then on to the SW), @@toStringTag does not.
  get [Symbol.toStringTag]() { return 'MessagePort'; }
}
class MessageChannel {
  constructor() {
    this.port1 = new MessagePort();
    this.port2 = new MessagePort();
    this.port1._peer = this.port2;
    this.port2._peer = this.port1;
  }
}
// onmessage / onmessageerror register a real listener at set time (correct ordering vs
// addEventListener). The onmessage IDL setter ALSO enables the port message queue (as if start()
// ran) when set to a non-null handler — addEventListener('message') does not.
defineEventHandler(MessagePort.prototype, 'message');
defineEventHandler(MessagePort.prototype, 'messageerror');
{
  const desc = Object.getOwnPropertyDescriptor(MessagePort.prototype, 'onmessage');
  Object.defineProperty(MessagePort.prototype, 'onmessage', {
    configurable: true,
    get: desc.get,
    set(v) {
      desc.set.call(this, v);
      if (v !== null && (typeof v === 'object' || typeof v === 'function')) this._enable();
    },
  });
}
globalThis.MessageChannel = MessageChannel;
// MessagePort has NO constructor per WebIDL: `new MessagePort()` / `MessagePort()` throws TypeError.
// Expose a throwing stand-in whose `.prototype` IS the real class's, so `port instanceof MessagePort`
// still holds and every method/getter is inherited, while user construction is blocked. Internal code
// (MessageChannel / transfer / adopt) keeps using the module-local class directly.
function MessagePortInterface() { throw new globalThis.TypeError('Illegal constructor'); }
MessagePortInterface.prototype = MessagePort.prototype;
try { Object.defineProperty(MessagePort.prototype, 'constructor', { value: MessagePortInterface, configurable: true, writable: true }); } catch (_) {}
globalThis.MessagePort = MessagePortInterface;

// ── Cross-isolate MessagePort transfer (window / frame realm ↔ worker / SW isolate) ──
// A MessagePort whose entangled peer is transferred to ANOTHER isolate can't share the
// heap, so it becomes a REMOTE port routed by a globally-unique CHANNEL id: each isolate
// holds one endpoint under the channel and posts through the host, which connects them.
const __portsByChannel = new Map();   // channel id → this isolate's endpoint MessagePort
// Transfer `port` away: its KEPT entangled peer becomes this isolate's channel endpoint
// (routes future postMessages through the host), `port` is neutered, and the fresh channel
// id is returned (stamped on `port` so the same transfer appears once in data + once in
// the transfer list without minting two channels). Called by the message serializer.
globalThis.__csimPortToChannel = function (port) {
  if (port._transferChannel) return port._transferChannel;
  const channel = String(globalThis.__csimAllocPortChannel());
  const peer = port._peer;
  const kept = peer || new MessagePort();   // a lone port still gets a routable (if idle) endpoint
  kept._remoteChannel = channel;
  __portsByChannel.set(channel, kept);
  port._transferChannel = channel;
  port._peer = null; port._detached = true; port._queue = [];
  if (peer) peer._peer = null;
  if (typeof globalThis.__csimPortEndpointHere === 'function') { try { globalThis.__csimPortEndpointHere(channel); } catch (_) {} }
  return channel;
};
// Reconstruct THIS isolate's endpoint for a channel transferred TO it (idempotent — a
// channel referenced in both the data graph and the transfer list yields ONE port object).
globalThis.__csimChannelToPort = function (channel) {
  channel = String(channel);
  let p = __portsByChannel.get(channel);
  if (!p) {
    p = new MessagePort();
    p._remoteChannel = channel;
    __portsByChannel.set(channel, p);
    if (typeof globalThis.__csimPortEndpointHere === 'function') { try { globalThis.__csimPortEndpointHere(channel); } catch (_) {} }
  }
  return p;
};
// The host delivers a message routed to a channel endpoint in THIS isolate. `dataStr` is a
// serialized message (data + any nested transferred ports); decode + hand to the port queue.
globalThis.__csimPortChannelDeliver = function (channel, dataStr) {
  const p = __portsByChannel.get(String(channel));
  if (!p) return;
  let data = null, ports = [];
  if (typeof globalThis.__csimDecodeMessage === 'function') {
    try { ({ data, ports } = globalThis.__csimDecodeMessage(dataStr)); } catch (_) {}
  }
  p._accept(data, ports);
};
// Channel id: a per-isolate-unique token (`pc-r<realm>-<n>` for a window/frame realm) so the two
// isolates never collide. The SW/worker scope overrides this with a handle-keyed allocator.
let __portChannelSeq = 0;
globalThis.__csimAllocPortChannel = function () {
  return 'pc-r' + globalThis.__csimRealmId() + '-' + (++__portChannelSeq);
};
// Client-side (main-thread window/frame realm) channel plumbing: post + endpoint registration call
// the host directly. The SW/worker scope overrides __csimPortRemotePost / __csimPortEndpointHere
// with outbox-routed versions (a worker thread can't touch the browser directly).
globalThis.__csimPortRemotePost = function (channel, dataStr) {
  try { globalThis.__csimClientPortPost(channel, dataStr); } catch (_) {}
};
globalThis.__csimPortEndpointHere = function (channel) {
  try { globalThis.__csimClientPortEndpoint(channel, globalThis.__csimRealmId()); } catch (_) {}
};

// BroadcastChannel — multi-tab same-origin pub/sub. Mastodon's
// across-tab sync, Discourse's `MessageBus` fall-back. Single-window
// runtime so messages don't actually traverse tabs, but the API
// shape is needed so apps that always construct one don't crash.
const _bcChannels = new Map();
// The realm id of the CURRENTLY-executing context (0 = main window, else a frame/window realm),
// used to key this channel in the host BroadcastChannel registry (see the ordered-delivery note on
// postMessage below).
function bcRealmId() {
  const NS = globalThis.RustyRacer;
  return (NS && typeof NS.contextOf === 'function') ? NS.contextOf(globalThis) : 0;
}
// Per-realm local channel id → channel, so a host-ordered delivery (`__csim_bcDeliverOne`) can
// address ONE specific channel (by creation, not by name) — the registry the host holds is keyed by
// (realm id, this local id).
let   _bcLocalSeq = 1;
const _bcByLocal  = new Map();
class BroadcastChannel extends EventTarget {
  constructor(name) {
    super();
    if (arguments.length < 1) throw new globalThis.TypeError("Failed to construct 'BroadcastChannel': 1 argument required, but only 0 present.");
    this._name          = String(name);
    this._closed        = false;
    const set = _bcChannels.get(this._name) || new Set();
    set.add(this);
    _bcChannels.set(this._name, set);
    // Register with the host's isolate-wide, creation-ordered channel registry. This is what lets a
    // multi-frame post be delivered to every same-origin channel "in creation order, oldest first"
    // across realms (the single-realm case never consults it — see postMessage). Cheap: one host call
    // per channel construction, and channels are few.
    // Workers are a SEPARATE isolate reached by inbox, never through the main isolate's ordered
    // registry — and their `contextOf` would collide with the main window's realm 0. So a worker
    // channel skips registration entirely and always uses the legacy fan-out path.
    this._bcLocal = _bcLocalSeq++;
    _bcByLocal.set(this._bcLocal, this);
    if (!globalThis.__csim_isWorker && typeof globalThis.__csimBcRegister === 'function') {
      try { globalThis.__csimBcRegister(bcRealmId(), this._bcLocal, this._name, globalThis.__csimBcOriginKey()); } catch (_) {}
    }
  }
  get name() { return this._name; }   // readonly attribute — the bus key can't be reassigned out from under a queued delivery
  postMessage(data) {
    if (arguments.length < 1) throw new globalThis.TypeError("Failed to execute 'postMessage' on 'BroadcastChannel': 1 argument required, but only 0 present.");
    if (this._closed) throw new globalThis.DOMException('BroadcastChannel is closed', 'InvalidStateError');
    // A worker that called `self.close()` has a terminated event loop: its BroadcastChannel posts
    // are silently dropped (no in-VM delivery, no cross-context fan-out) — broadcastchannel/workers
    // "messages from/within a closed worker should be ignored".
    if (globalThis.__csimWorkerClosed) return;
    // The posting context's origin, two forms. `origin` is the SERIALIZED origin ("null" for an
    // opaque context) exposed as the delivered MessageEvent.origin to same-realm peers below.
    // `originKey` is the SCOPING identity (a unique token for an opaque origin, see
    // `__csimBcOriginKey`) the cross-realm/window/worker fanout gates on — a BroadcastChannel is
    // scoped to (origin, name). Read once so every delivery path shares them.
    const origin    = globalThis.origin || '';
    const originKey = globalThis.__csimBcOriginKey();
    // Serialize ONCE at post time: catches an uncloneable value synchronously (DataCloneError, per
    // StructuredSerialize) and snapshots the current state (a later mutation of `data` by the poster
    // must not leak into delivery). Each destination gets its OWN deserialized copy so one recipient
    // mutating its message can't affect another's.
    const clone = v => (globalThis.structuredClone ? globalThis.structuredClone(v) : v);
    const serialized = clone(data);
    // Two delivery models, chosen by whether another same-isolate realm exists:
    //
    // Multi-realm (a frame/window realm besides this one is live): route EVERY delivery — this realm's
    // own sibling channels INCLUDED — through the host's isolate-wide, creation-ordered registry
    // (`__csimBcPost`). BroadcastChannel guarantees delivery "in creation order, oldest first" across
    // the whole agent, and a channel created AFTER a post must not receive it; only one global queue
    // that snapshots eligible targets at post time can honour both across realms (the per-realm
    // microtask path below can't order a sibling frame's channel against a local one, and re-reads its
    // set at delivery time so a just-created channel wrongly receives an older post). The host also
    // fans out to workers + other windows from `bc_post`, so the `__csimBroadcast` call is skipped here.
    //
    // Single-realm (the overwhelmingly common app case — no frames): keep the original in-VM microtask
    // delivery to this realm's other channels, plus `__csimBroadcast` for workers / other windows.
    // Zero behavioural change for a single-window page (the host registry is never consulted).
    if (!globalThis.__csim_isWorker && typeof globalThis.__csimBcSiblingsExist === 'function' && globalThis.__csimBcSiblingsExist()) {
      if (typeof globalThis.__csimBcPost === 'function') {
        try { globalThis.__csimBcPost(bcRealmId(), this._bcLocal, this.name, originKey, serialized, origin); } catch (_) {}
      }
      return;
    }
    const set = _bcChannels.get(this.name);
    if (set) {
      const destinations = [];
      for (const ch of set) if (ch !== this) destinations.push(ch);
      for (const ch of destinations) {
        Promise.resolve().then(() => {
          // Re-check against the SAME set captured at post time (close() mutates it in
          // place) — not a fresh name lookup — so a channel closed by an earlier handler
          // is skipped and delivery is unaffected by any later name change.
          if (ch._closed || !set.has(ch)) return;
          const ev = new MessageEvent('message', {data: clone(serialized), origin, lastEventId: '', source: null, ports: []});
          ev.target = ch;
          dispatchWithOnHandler(ch, ev);
        });
      }
    }
    // Fan out beyond this realm via the Driver — same-origin BroadcastChannel spans
    // every same-origin browsing context: OTHER windows (separate isolates) AND a worker
    // that inherited this origin, which `_bcChannels` (realm-local) above doesn't reach.
    if (typeof globalThis.__csimBroadcast === 'function') {
      // Carry the posting context's ORIGIN KEY so the receiver realms can drop cross-origin
      // deliveries (a BroadcastChannel is scoped to (origin, name); an opaque origin's key is a
      // unique token that only matches its own agent cluster).
      try { globalThis.__csimBroadcast(this.name, data, bcRealmId(), originKey); } catch (_) {}
    }
  }
  close() {
    this._closed = true;
    const set = _bcChannels.get(this.name);
    if (set) { set.delete(this); if (set.size === 0) _bcChannels.delete(this.name); }
    _bcByLocal.delete(this._bcLocal);
    if (!globalThis.__csim_isWorker && typeof globalThis.__csimBcUnregister === 'function') {
      try { globalThis.__csimBcUnregister(bcRealmId(), this._bcLocal); } catch (_) {}
    }
  }
}
// Host-ordered delivery of ONE queued BroadcastChannel message to a specific local channel (multi-realm
// path): the host drains its global creation-ordered queue and calls this per (realm, local id). Skips a
// channel closed after the post was queued (spec: a channel closed by an earlier handler gets nothing).
globalThis.__csim_bcDeliverOne = function (localId, data, origin) {
  const ch = _bcByLocal.get(localId);
  if (!ch || ch._closed) return;
  const ev = new MessageEvent('message', {data, origin, lastEventId: '', source: null, ports: []});
  ev.target = ch;
  dispatchWithOnHandler(ch, ev);
};
defineEventHandler(BroadcastChannel.prototype, 'message');
defineEventHandler(BroadcastChannel.prototype, 'messageerror');
globalThis.BroadcastChannel = BroadcastChannel;
// Deliver BroadcastChannel messages queued from OTHER windows (host → this VM):
// fire a `message` event on every local channel with the matching name.
globalThis.__csim_deliverBroadcasts = function (events) {
  if (!events || !events.length) return;
  const myKey = globalThis.__csimBcOriginKey();
  for (const ev of events) {
    const set = _bcChannels.get(ev && ev.name);
    if (!set) continue;
    // A BroadcastChannel is scoped to (origin, name): a channel only receives a post whose ORIGIN
    // KEY matches this context's. Opaque origins carry a unique token (see `__csimBcOriginKey`), so
    // two unrelated opaque contexts never match — only a shared agent cluster does (a context and
    // the blob: worker that inherited its origin). MessageEvent.origin is the SERIALIZED origin
    // ("null" for opaque).
    const senderKey = ev.origin == null ? '' : String(ev.origin);
    if (senderKey !== myKey) continue;
    const origin = serializeOriginKey(senderKey);
    const data = csimMaybeTransferIn(ev.data);
    for (const ch of set) {
      const m = new MessageEvent('message', {data, origin, lastEventId: '', source: null, ports: []});
      m.target = ch;
      dispatchWithOnHandler(ch, m);
    }
  }
};

// Release a batch of zero-copy postMessage transfer tokens
// (`RustyRacer.transferOut`). Called from Ruby on `reset!` to free any backing
// store whose token was never imported; `transferDrop` no-ops on an
// already-imported token, so over-dropping is safe.
globalThis.__csimTransferDropAll = function (tokens) {
  const NS = globalThis.RustyRacer;
  if (!tokens || !NS || typeof NS.transferDrop !== 'function') return;
  for (let i = 0; i < tokens.length; i++) NS.transferDrop(tokens[i]);
};

// ── Cross-window references: window.open / window.opener / postMessage ──
// Each browsing context (window/tab) is a SEPARATE isolate, so a reference to
// another window can't be a live JS object — it's a proxy that forwards every
// operation to the host, which routes to that window's VM. The host fns
// (`__csimWindow*`, wired per-window by the Ruby Driver) only exist post-
// snapshot, so resolve them at call time rather than guarding at module eval.
const __csimWindowProxies = new Map();   // handle -> proxy (stable identity)

// Zero-copy the common "post a buffer" case (rusty_racer transferOut/In): if the
// postMessage payload IS an ArrayBuffer / typed-array view named in the transfer
// list, move its backing store by token instead of copying it through the host
// marshaller. Returns a `{__csimXfer}` placeholder to send in `data`'s place, or
// null (send `data` as-is, copied). Nested buffers aren't walked — they copy.
function csimMaybeTransferOut(data, transfer) {
  if (!transfer || !transfer.length) return null;
  const NS = globalThis.RustyRacer;
  if (!NS || typeof NS.transferOut !== 'function') return null;
  const isAB   = data instanceof ArrayBuffer;
  const isView = !isAB && ArrayBuffer.isView(data);
  if (!isAB && !isView) return null;
  const buf = isAB ? data : data.buffer;
  let inList = false;
  for (let i = 0; i < transfer.length; i++) {
    const t = transfer[i];
    if (t === buf || (t && t.buffer === buf)) { inList = true; break; }
  }
  if (!inList) return null;
  const token = NS.transferOut(data) | 0;   // detaches the source
  if (token <= 0) return null;
  if (globalThis.__csim_transferIssued) globalThis.__csim_transferIssued(token);
  return isAB
    ? {__csimXfer: token, kind: 'ArrayBuffer'}
    : {__csimXfer: token, kind: (data.constructor && data.constructor.name) || 'Uint8Array',
       byteOffset: data.byteOffset, length: data.length};
}

// Reverse: rebuild a transferred buffer/view over its (zero-copy) backing store.
function csimMaybeTransferIn(data) {
  if (!data || typeof data !== 'object' || data.__csimXfer == null) return data;
  const NS = globalThis.RustyRacer;
  if (!NS || typeof NS.transferIn !== 'function') return data;
  const ab = NS.transferIn(data.__csimXfer);
  if (!ab) return new ArrayBuffer(0);          // token already imported / dropped
  if (data.kind === 'ArrayBuffer') return ab;
  const Ctor = globalThis[data.kind] || globalThis.Uint8Array;
  try { return new Ctor(ab, data.byteOffset || 0, data.length); }
  catch (_) { return new Uint8Array(ab); }
}

// ── Cross-window remote-ref proxy (SOURCE side) ────────────────────────────
// Wraps a ref id from another window's VM (a DOM node, a non-node object, or the
// window itself = id 0) in a Proxy that forwards every get/set/method-call across
// the host boundary (__csimWindowRef{Get,Set,Call}). Returned nodes/objects come
// back as `{__csimRef:id}` markers and are wrapped into further proxies; a
// returned function comes back as `{__csimRefFn:true}` and is exposed as a local
// function that re-invokes it as a method call on the owning ref.
//
// Scope is single-hop scripting (the patterns real cross-window tests/apps use:
// read/write a property, call a method, chain through returned nodes/objects).
// Deliberately NOT modelled — each only matters for exotic cross-window use no
// test/app exercises, and each needs a heavier mechanism:
//   - passing a source FUNCTION as an argument (callbacks can't cross isolates);
//   - passing a ref-proxy owned by window A into a method on window B (the id is
//     resolved in B's registry — node identity is per-window);
//   - iterating a returned collection (Symbol.iterator isn't forwarded);
//   - a method whose RETURN value is itself a function.
// The target-side object registry (host-queries) holds non-node objects for the
// window's VM lifetime (dropped when the window/VM is disposed).
const __csimRefProxies = new Map();   // `${winHandle}:${id}` -> proxy
function csimWrapRef(winHandle, v) {
  return (v && typeof v === 'object' && v.__csimRef != null)
    ? csimRemoteRefProxy(winHandle, v.__csimRef) : v;
}
function csimPackArg(a) {
  // A ref-proxy passed back as an argument round-trips by its id.
  return (a && typeof a === 'object' && a.__csimRefId != null) ? { __csimRef: a.__csimRefId } : a;
}
function csimRemoteRefProxy(winHandle, id) {
  if (id == null) return null;
  const key = winHandle + ':' + id;
  let p = __csimRefProxies.get(key);
  if (p) return p;
  p = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === '__csimRefId') return id;
      if (typeof prop === 'symbol' || prop === 'then') return undefined;
      const v = globalThis.__csimWindowRefGet(winHandle, id, String(prop));
      if (v && typeof v === 'object' && v.__csimRefFn) {
        return (...args) => csimWrapRef(winHandle, globalThis.__csimWindowRefCall(winHandle, id, String(prop), args.map(csimPackArg)));
      }
      return csimWrapRef(winHandle, v);
    },
    set(_t, prop, value) {
      if (typeof prop === 'symbol') return true;
      globalThis.__csimWindowRefSet(winHandle, id, String(prop), csimPackArg(value));
      return true;
    }
  });
  __csimRefProxies.set(key, p);
  return p;
}

function csimWindowProxy(handle) {
  if (handle == null || handle === '') return null;
  let proxy = __csimWindowProxies.get(handle);
  if (proxy) return proxy;
  // `location.href`/`assign`/`replace` take a USVString (unpaired surrogates →
  // U+FFFD before navigation). The getter serializes the stored URL (idempotent
  // for well-formed URLs) so a U+FFFD reads back percent-encoded as %EF%BF%BD;
  // `hash` is the serialized URL's fragment.
  const usv = (v) => globalThis.__csimToUSVString ? globalThis.__csimToUSVString(v) : String(v);
  // Fire the aux window's OWN `load` on the next task (deferred, like window.open)
  // so the newly-loaded child's `window.onload` runs AFTER the opener's current
  // task — e.g. the loadResolver-reports-back form-restore pattern. Deferring
  // also sidesteps cross-VM re-entrancy: the child's `window.opener.foo()` runs
  // when the opener's VM is idle (next task), not while it is blocked in the
  // host call that triggered the navigation.
  const fireAuxLoadSoon = () => {
    setTimeout(() => { try { if (typeof globalThis.__csimFireAuxWindowLoad === 'function') globalThis.__csimFireAuxWindowLoad(handle); } catch (_) {} }, 0);
  };
  // Navigate the aux window, then fire its load deferred.
  const navAux = (v) => {
    globalThis.__csimWindowSetLocation(handle, usv(v));
    fireAuxLoadSoon();
  };
  // `w.history.back()/forward()/go(n)` from the opener. The traversal runs in the
  // (non-active) target window eagerly; a CROSS-document traversal loads a
  // different document, so fire its deferred `load` like navAux. A same-document
  // (pushState) traversal fires popstate in the target and needs no load.
  const histGo = (delta) => {
    const crossDoc = (typeof globalThis.__csimWindowHistoryGo === 'function')
      ? globalThis.__csimWindowHistoryGo(handle, delta) : false;
    if (crossDoc) fireAuxLoadSoon();
  };
  let historyProxy;   // memoized so `w.history` keeps a stable identity
  const serializedHref = () => {
    const h = globalThis.__csimWindowLocation(handle);
    try { const u = globalThis.__csim_parseUrl(h); return (u && !u.error && u.href) ? u.href : h; }
    catch (_) { return h; }
  };
  const location = {
    get href()   { return serializedHref(); },
    set href(v)  { navAux(v); },
    assign(v)    { navAux(v); },
    replace(v)   { navAux(v); },
    get hash()   { const h = serializedHref(); const i = h.indexOf('#'); return i >= 0 ? h.slice(i) : ''; },
    toString()   { return serializedHref(); }
  };
  const loadListeners = [];
  const base = {
    get closed() { return !!globalThis.__csimWindowClosed(handle); },
    close()      { globalThis.__csimWindowClose(handle); },
    focus()      {},
    blur()       {},
    onload:      null,
    onmessage:   null,
    // Cross-window postMessage. The data round-trips JS→Ruby→JS through the
    // host marshaller rather than a true structured-clone: plain
    // primitives/arrays/objects survive, but `undefined`→null, functions /
    // symbols drop (no DataCloneError is thrown), and prototypes/identity are
    // lost — fine for the JSON-ish payloads postMessage carries in practice.
    // The targetOrigin is validated here (SyntaxError, sender-side per spec) and
    // GATES delivery on the target side; `/` resolves to the SENDER's origin
    // now, since the target can't recover it. event.origin carries the sender's
    // origin — the receiving page's origin check (`e.origin != expected`) is
    // the whole point of the field.
    postMessage(data, targetOrigin, transfer) {
      // Absent / dictionary targetOrigin resolves through the shared resolver ("/" default,
      // matching the in-page frame path) — not the old always-'*'.
      let to = validatePostMessageTargetOrigin(targetOrigin);
      const sender = String(globalThis.origin || '');
      // Reduce a URL-shaped targetOrigin to its ORIGIN before it travels — the delivery
      // gate compares against the target's serialized origin, and Chrome accepts
      // 'https://a.com/path' / trailing slashes / default ports (mirrors the in-page
      // frame path at __csimPostMessageRealm).
      if (to === '/') to = sender;
      else if (to !== '*') to = originOfTarget(to);
      // A transferred buffer moves zero-copy via a token placeholder; otherwise
      // the host call deep-copies `data` into the target window's inbox.
      const xfer = csimMaybeTransferOut(data, transfer);
      globalThis.__csimWindowPostMessage(handle, xfer || data, to, sender);
      // Neuter any copy-fallback buffers in the list (a zero-copy'd one is
      // already detached by transferOut — its `.transfer()` throws → no-op).
      detachTransferables(transfer);
    },
    addEventListener(type, fn)    { if (type === 'load' && typeof fn === 'function') loadListeners.push(fn); },
    removeEventListener(type, fn) { if (type === 'load') { const i = loadListeners.indexOf(fn); if (i >= 0) loadListeners.splice(i, 1); } },
    // Fire the aux window's `load` at the opener — scheduled by `open()` once the
    // aux document has loaded, on a task so an `onload` set right after window.open
    // still catches it.
    __csimFireLoad() {
      const ev = { type: 'load', target: proxy, currentTarget: proxy };
      if (typeof base.onload === 'function') { try { base.onload(ev); } catch (_) {} }
      for (const fn of loadListeners.slice()) { try { fn(ev); } catch (_) {} }
    },
    get location() { return location; },
    set location(v) { location.href = v; },
    // `w.history` — back/forward/go traverse the target window and fire its
    // deferred `load` (cross-document) via histGo; every other member (length,
    // state, scrollRestoration, push/replaceState) forwards to the target
    // window's real History through the remote-ref RPC.
    get history() {
      return historyProxy || (historyProxy = new Proxy({}, {
        get(_t, prop) {
          if (prop === 'back')    return () => histGo(-1);
          if (prop === 'forward') return () => histGo(1);
          if (prop === 'go')      return (d) => histGo(d == null ? 0 : (Math.trunc(Number(d)) || 0));
          // length / state / scrollRestoration / push/replaceState — re-resolve the
          // aux history ref per access: its remote-ref id is invalidated when the
          // aux navigates (VM rebuild); the traversal methods above don't need it.
          const ref = csimWrapRef(handle, globalThis.__csimWindowRefGet(handle, 0, 'history'));
          return ref ? ref[prop] : undefined;
        }
      }));
    },
    // `win.document` (and any other cross-window object: navigator, history, a
    // queried node, …) resolves through the remote-ref RPC with the target window
    // as ref id 0 — so `win.document.querySelector('input').value = x` and
    // `win.navigator.userActivation.isActive` forward into the aux window's VM.
    get document() { return csimWrapRef(handle, globalThis.__csimWindowRefGet(handle, 0, 'document')); },
    get __csimWindowHandle() { return handle; }
  };
  // A Proxy so an arbitrary cross-window property read (`win.test_result`) is
  // forwarded to the aux window's VM; known members (close / postMessage / onload
  // / location / document / …) resolve locally.
  proxy = new Proxy(base, {
    get(t, prop, _recv) {
      if (prop === 'window' || prop === 'self') return proxy;
      if (prop in t) return t[prop];
      if (typeof prop === 'symbol' || prop === 'then') return undefined;
      const v = globalThis.__csimWindowRefGet(handle, 0, String(prop));
      if (v && typeof v === 'object' && v.__csimRefFn) {
        return (...args) => csimWrapRef(handle, globalThis.__csimWindowRefCall(handle, 0, String(prop), args.map(csimPackArg)));
      }
      return csimWrapRef(handle, v);
    },
    // Known members (getter-only closed/document/window/self, settable onload/…)
    // resolve locally; any other assignment forwards into the target window's VM.
    set(t, prop, v) {
      if (prop in t) { try { t[prop] = v; } catch (_) {} return true; }
      if (typeof prop !== 'symbol') globalThis.__csimWindowRefSet(handle, 0, String(prop), csimPackArg(v));
      return true;
    }
  });
  __csimWindowProxies.set(handle, proxy);
  return proxy;
}

// Read a PRIMITIVE property off THIS window's globalThis (onDoc false) or its
// document (onDoc true) — the Driver calls it on an aux Browser's VM to serve a
// cross-window proxy read (`win.test_result` / `win.document.charset`). Only
// primitives cross the host boundary; objects/functions → null.
globalThis.__csimReadWindowProp = function (onDoc, prop) {
  try {
    const obj = onDoc ? globalThis.document : globalThis;
    if (!obj) return null;
    const v = obj[prop];
    const t = typeof v;
    return (t === 'string' || t === 'number' || t === 'boolean') ? v : null;
  } catch (_) { return null; }
};

// Consume transient user activation — opening a new top-level browsing context
// (window.open / a `<form target=_blank>` submit) consumes it per HTML. Called
// from the Ruby form-submit path when it opens an aux window.
globalThis.__csimConsumeTransientActivation = function () {
  globalThis.__csimTransientActivation = false;
};

// `window.open(url, name, features)` opens (or, by name, reuses) a real
// auxiliary window via the Driver and returns a proxy for it (null if the
// host can't open one, e.g. no Driver).
globalThis.open = function (url, name, _features) {
  // `url` is a USVString (unpaired surrogates → U+FFFD before parsing).
  const u = url == null ? '' : (globalThis.__csimToUSVString ? globalThis.__csimToUSVString(url) : String(url));
  // Spec: a NON-empty url is parsed against the document base; a parse FAILURE
  // throws a SyntaxError DOMException synchronously — before the host
  // open_aux_window path (which would otherwise drain on a malformed URL).
  // An empty url opens about:blank (no parse).
  if (u !== '') {
    const base = (globalThis.location && globalThis.location.href) || undefined;
    if (globalThis.__csim_urlIsMalformed(u, base)) {
      throw new globalThis.DOMException(
        "Failed to execute 'open' on 'Window': Unable to open a window with invalid URL '" + u + "'.", 'SyntaxError');
    }
  }
  const fn = globalThis.__csimWindowOpen;
  if (typeof fn !== 'function') return null;
  // Pass the OPENER's realm id so a same-isolate window realm can wire window.opener
  // to a WindowProxy for it (0 = the main realm, a valid opener — distinct from "no
  // opener"). Falls back to 0 when contextOf is unavailable.
  const __ns = globalThis.RustyRacer;
  const callerRealmId = (__ns && typeof __ns.contextOf === 'function') ? __ns.contextOf(globalThis) : 0;
  // An about:blank popup's URL is opaque, but its ORIGIN and its BASE URL — what its relative
  // URLs resolve against — are both INHERITED from this document, exactly as an empty
  // <iframe>'s are. Hand them over so the new realm can be seeded with them; without the
  // origin the popup would be cross-origin to its own opener.
  let aboutBase = '', aboutOrigin = '';
  try { aboutBase = (globalThis.document && globalThis.document.baseURI) || ''; } catch (_) {}
  // Read the origin WITHOUT `globalThis.origin`: that is a Window PROTOTYPE accessor precisely
  // so page script can shadow it (`var origin`), which would hand us the page's value.
  try {
    aboutOrigin = globalThis.__csimDocumentOrigin != null
      ? String(globalThis.__csimDocumentOrigin)
      : ((globalThis.location && globalThis.location.origin) || '');
  } catch (_) {}
  const handle = fn(u, name == null ? '' : String(name), callerRealmId, aboutBase, aboutOrigin);
  if (!handle) return null;
  // A NUMERIC handle is a same-origin window realm in this isolate → a native
  // WindowProxy (like iframe.contentWindow): `popup.document` is a real
  // same-isolate Document. A STRING handle is a separate-isolate aux window →
  // the cross-isolate RPC proxy.
  const proxy = (typeof handle === 'number' && typeof globalThis.__csimFrameWindowProxyFor === 'function')
    ? globalThis.__csimFrameWindowProxyFor(handle)
    : csimWindowProxy(handle);
  if (!proxy) return null;
  // The aux document loads during the host open() call (synchronously). Fire the
  // load events on the NEXT task so an `onload` assigned right after window.open()
  // (here AND in the child, which reports back via `window.opener`) is registered
  // first (url-charset / url-in-tags-revoke; the form-restore loadResolver pattern):
  //   - the aux window's OWN `load` (in its VM, so the child's window.onload runs),
  //   - then the proxy's `load` at this opener (the `w.onload` the opener set).
  if (u !== '' && proxy && typeof proxy.__csimFireLoad === 'function') {
    setTimeout(() => {
      try { if (typeof globalThis.__csimFireAuxWindowLoad === 'function') globalThis.__csimFireAuxWindowLoad(handle); } catch (_) {}
      try { proxy.__csimFireLoad(); } catch (_) {}
    }, 0);
  }
  return proxy;
};

// `window.opener` — the window that opened this one (or null). A page may set
// it (commonly `window.opener = null` for tab-nabbing defence), so honour an
// override; otherwise resolve the opener handle from the host each read.
let __csimOpenerOverride;   // undefined = not overridden
Object.defineProperty(globalThis, 'opener', {
  configurable: true,
  get() {
    if (__csimOpenerOverride !== undefined) return __csimOpenerOverride;
    const fn = globalThis.__csimWindowOpener;
    const handle = typeof fn === 'function' ? fn() : null;
    return handle ? csimWindowProxy(handle) : null;
  },
  set(v) { __csimOpenerOverride = v; }
});

// Deliver cross-window postMessage payloads the host queued for THIS window:
// fire a `message` event carrying `.data` / `.origin` / `.source` (a proxy for
// the sender). Called from Ruby's settle/tick drain.
globalThis.__csim_deliverWindowMessages = function (events) {
  if (!events || !events.length) return;
  for (const ev of events) {
    // targetOrigin gate, evaluated HERE because only the target VM knows its own
    // current origin: '*' delivers to anyone; anything else must match this
    // window's origin or the message is silently dropped (HTML "window post
    // message" step 7.2). A '/' was already resolved to the sender's origin on
    // the sending side. Legacy inbox entries without the field deliver.
    const to = ev && ev.targetOrigin;
    if (to && to !== '*' && to !== String(globalThis.origin || '')) continue;
    const source = ev && ev.sourceHandle ? csimWindowProxy(ev.sourceHandle) : null;
    dispatchWithOnHandler(globalThis, new MessageEvent('message', {
      data:        csimMaybeTransferIn(ev ? ev.data : undefined),
      origin:      (ev && ev.origin) || '',
      source:      source,
      lastEventId: '',
      ports:       []
    }));
  }
};

// `window.postMessage(message, targetOrigin, transfer)` — same-page messaging
// between a parent and its nested iframe browsing contexts. Each frame realm runs
// its own bridge, and a cross-realm window reference (`parent`, set in
// create_frame_realm; `iframe.contentWindow`, the child's real global) carries
// its OWN `postMessage`, which V8 runs in that window's realm — so inside this
// function `globalThis` IS the target window. We clone the payload into this
// realm and queue a task that fires a `message` MessageEvent, per HTML "window
// post message" (a task, not synchronous, so the sender returns first).
//
// Aux / opened windows (window.open) are SEPARATE browsers and post through the
// csimWindowProxy.postMessage above (host round-trip + __csim_deliverWindowMessages);
// this method is only reached for in-VM same-browser windows.
//
// `source` is best-effort null: the posting realm isn't recoverable across the
// cross-realm call (V8 runs the callee in the target's realm), and no in-scope
// consumer reads `event.source` on a frame message. `origin` is '' (same-page;
// we don't model distinct frame origins). The 2-arg `targetOrigin` is accepted
// and ignored (no origin gating).
// Reached only for a SAME-realm self-post (`window.postMessage(x)` /
// `self.postMessage(x)`) — a cross-realm target is a WindowProxy whose own
// postMessage routes through __csimPostMessageRealm. `event.source` is this
// window itself (the sender is this realm).
// Resolve + validate a `Window.postMessage` second argument's targetOrigin — either the legacy
// USVString form or a WindowPostMessageOptions dictionary's `targetOrigin` (default "/"). `*` (any)
// and `/` (same origin) are special; any other value must parse as an absolute URL, else the whole
// call is a SyntaxError (HTML "window post message" step 4). Shared by the same-realm self-post and
// the cross-realm WindowProxy post so both reject a bad origin synchronously in the sender.
// A `Window.postMessage` second argument is EITHER a WindowPostMessageOptions dictionary OR a legacy
// targetOrigin USVString. Per WebIDL overload resolution, `null`/`undefined`/an object at that
// position is the dictionary (targetOrigin default "/"); any other primitive is the string form.
function isPostMessageOptions(arg) { return arg == null || typeof arg === 'object'; }
// Resolve the targetOrigin from that argument.
function postMessageTargetOriginOf(arg) {
  if (isPostMessageOptions(arg)) return (arg != null && arg.targetOrigin !== undefined) ? String(arg.targetOrigin) : '/';
  return String(arg);
}
// Validate a resolved targetOrigin: `*` (any) and `/` (same origin) are special; any other value must
// parse as an absolute URL, else the call is a SyntaxError (HTML "window post message" step). The
// exception is minted in `realm` (the TARGET window for a cross-realm post — a method's exceptions
// belong to its own realm), defaulting to this realm.
function validatePostMessageTargetOrigin(arg, realm) {
  realm = realm || globalThis;
  const to = postMessageTargetOriginOf(arg);
  if (to !== '*' && to !== '/') {
    let ok = false;
    try { new (realm.URL || globalThis.URL)(to); ok = true; } catch (_) {}
    if (!ok) throw new (realm.DOMException || globalThis.DOMException)(
      "Failed to execute 'postMessage' on 'Window': Invalid target origin '" + to + "' in a call to 'postMessage'.", 'SyntaxError');
  }
  return to;
}
if (typeof globalThis.postMessage !== 'function') {
  globalThis.postMessage = function postMessage(message, targetOriginOrOptions, transfer) {
    // `message` is a required WebIDL argument — a zero-argument call is a TypeError.
    if (arguments.length < 1) throw new globalThis.TypeError(
      "Failed to execute 'postMessage' on 'Window': 1 argument required, but only 0 present.");
    const xfer = isPostMessageOptions(targetOriginOrOptions) && targetOriginOrOptions != null
      ? targetOriginOrOptions.transfer : transfer;
    // Error precedence matches browsers: transfer sequence-conversion (TypeError), THEN serialize
    // (DataCloneError), THEN targetOrigin syntax (SyntaxError). `transfer` is a `sequence<object>`:
    // absent → none; null / non-iterable / a non-object element → TypeError.
    let tf = [];
    if (xfer !== undefined) {
      if (xfer === null || typeof xfer[globalThis.Symbol.iterator] !== 'function') throw new globalThis.TypeError(
        "Failed to execute 'postMessage' on 'Window': The provided value cannot be converted to a sequence.");
      tf = Array.from(xfer);
      for (const t of tf) if (t === null || typeof t !== 'object') throw new globalThis.TypeError(
        "Failed to execute 'postMessage' on 'Window': The provided value is not of type 'object'.");
    }
    // StructuredSerializeWithTransfer: an uncloneable message throws DataCloneError; a transferred
    // MessagePort is delivered in event.ports as its moved counterpart.
    let data, ports;
    if (tf.length === 0) { data = structuredClone(message); ports = []; }
    else ({ data, ports } = serializeMessageWithTransfer(message, tf));
    validatePostMessageTargetOrigin(targetOriginOrOptions);
    // The targetOrigin gates delivery exactly as it does cross-realm (__csimPostMessageRealm):
    // sender and target are the SAME window here, so "*" always delivers, "/" and any explicit
    // origin require it to equal THIS window's origin, else the message is silently dropped. And
    // event.origin is this window's own origin (a same-window post is same-origin), never ''.
    const myOrigin = globalThis.origin || '';
    const to = postMessageTargetOriginOf(targetOriginOrOptions);
    if (to !== '*' && myOrigin !== (to === '/' ? myOrigin : originOfTarget(to))) return;
    setTimeout(() => {
      try {
        dispatchWithOnHandler(globalThis, new MessageEvent('message', {
          data, origin: myOrigin, source: globalThis, lastEventId: '', ports
        }));
      } catch (_) {}
    }, 0);
  };
}

// Fire `beforeunload` on THIS window when it is being navigated away (a frame's
// document is about to be unloaded). Called by the frame-navigation / src-
// reassignment path BEFORE the realm is disposed, IN this realm (so window.event,
// the handler, and a custom toString all see this realm's globals). Gated on a
// handler being present to bound the blast radius (Turbo frame src swaps).
//
// Per HTML "prompt to unload": the legacy unload-prompt string is the handler's
// return value (`return "msg"`) or `event.returnValue`, COERCED to a string —
// and that coercion runs while `window.event` is still the beforeunload event,
// so a custom `toString` observes it
// (event-global-is-still-set-when-coercing-beforeunload-result).
// Fire `pagehide` then `unload` on THIS window — the document-teardown pair a
// navigating/removed frame dispatches before its realm dies (HTML "unload a
// document"). Self-gates on any handler being present, like beforeunload, so a
// handler-less teardown pays only the property reads. `pagehide.persisted` is
// false (no bfcache model). The primary consumer is `fetch(…, {keepalive})`
// issued from these handlers (the keepalive WPT family) — the eager keepalive
// dispatch runs synchronously inside the handler, before the realm is neutered.
globalThis.__csimFireWindowUnload = function () {
  for (const type of ['pagehide', 'unload']) {
    const h    = globalThis['on' + type];
    const list = (globalThis._listeners && globalThis._listeners[type]) || null;
    if (typeof h !== 'function' && !(list && list.length)) continue;
    let ev;
    try { ev = new globalThis.Event(type); } catch (_) { continue; }
    if (type === 'pagehide') { try { ev.persisted = false; } catch (_) {} }
    ev.isTrusted = true;
    if (ev.target == null) ev.target = globalThis;
    ev.currentTarget = globalThis;
    const prev = globalThis.event;
    globalThis.event = ev;
    try {
      if (typeof h === 'function') { try { h.call(globalThis, ev); } catch (e) { try { globalThis.__csimReportListenerError(h, e); } catch (_) {} } }
      if (list) {
        for (const entry of list.slice()) {
          if (ev._immediatePropagationStopped) break;
          if (entry.removed) continue;
          try { (entry.isObject ? entry.handler.handleEvent : entry.handler).call(globalThis, ev); }
          catch (e) { try { globalThis.__csimReportListenerError(entry.handler, e); } catch (_) {} }
        }
      }
    } finally { globalThis.event = prev; }
  }
};

// The whole-tree variant: this window's teardown pair, then every descendant
// frame realm's, parent-first (the order Chrome fires them on window close /
// removal). Driven by the host when an aux window is closed — its nested
// iframes' unload handlers (a keepalive beacon, redirect-keepalive's
// "[new window][unload]" family) must run before the VM is disposed.
globalThis.__csimFireWindowUnloadDeep = function () {
  try { globalThis.__csimFireWindowUnload(); } catch (_) {}
  const NS   = globalThis.RustyRacer;
  const kids = globalThis.__csimChildRealmIds;
  if (!kids || !NS || typeof NS.contextGlobal !== 'function') return;
  Array.from(kids).forEach((id) => {
    try {
      const w = NS.contextGlobal(id);
      if (w && typeof w.__csimFireWindowUnloadDeep === 'function') w.__csimFireWindowUnloadDeep();
    } catch (_) {}
  });
};

globalThis.__csimFireBeforeUnload = function () {
  const h    = globalThis.onbeforeunload;
  const list = (globalThis._listeners && globalThis._listeners.beforeunload) || null;
  if (typeof h !== 'function' && !(list && list.length)) return;
  let ev;
  try { ev = new globalThis.BeforeUnloadEvent('beforeunload', { cancelable: true }); }
  catch (_) { try { ev = new globalThis.Event('beforeunload', { cancelable: true }); } catch (_) { return; } }
  ev.isTrusted = true;
  if (ev.target == null) ev.target = globalThis;
  ev.currentTarget = globalThis;
  const prev = globalThis.event;
  globalThis.event = ev;
  try {
    if (list) {
      for (const entry of list.slice()) {
        if (ev._immediatePropagationStopped) break;   // stopImmediatePropagation()
        if (entry.removed) continue;
        try { (entry.isObject ? entry.handler.handleEvent : entry.handler).call(globalThis, ev); }
        catch (e) { try { globalThis.__csimReportListenerError(entry.handler, e); } catch (_) {} }
      }
    }
    let handlerReturn;
    if (typeof h === 'function' && !ev._immediatePropagationStopped) {
      try { handlerReturn = h.call(globalThis, ev); }
      catch (e) { try { globalThis.__csimReportListenerError(h, e); } catch (_) {} }
    }
    // Coerce the effective return value to a string (window.event still set):
    // event.returnValue (now always a coerced DOMString) if set, else the
    // handler's return value.
    const toCoerce = (ev.returnValue != null && ev.returnValue !== '') ? ev.returnValue : handlerReturn;
    if (toCoerce != null && toCoerce !== '') { try { String(toCoerce); } catch (_) {} }
  } finally {
    globalThis.event = prev;
    ev.currentTarget = null;
  }
};

// Set this frame realm's `window.name` from the container's `name` content
// attribute. Called by create_frame_realm BEFORE the document loads + its window
// `load` fires, so a frame whose load handler reads `window.name` to identify
// itself (shadow-dom declarative-child-frame: `parent.postMessage({name: window.name})`)
// sees the right value. (Setting it after the load — as the post-build path did —
// is too late for that handler.)
globalThis.__csimSetWindowName = function (n) {
  try { globalThis.name = (n == null ? '' : String(n)); } catch (_) {}
};
// Seed a frame realm's document origin (opaque "null" / inherited parent origin)
// BEFORE its document loads, so the frame's load-time scripts read the right
// self.origin. Real-URL frames don't call this (origin = location.origin).
globalThis.__csimSetDocumentOrigin = function (o) {
  try { globalThis.__csimDocumentOrigin = (o == null ? null : String(o)); } catch (_) {}
};

// Seed a frame realm's `location.origin` BEFORE its document loads. Set to the
// opaque "null" for a frame whose URL is opaque (about:blank / srcdoc /
// javascript:) — its location origin differs from the inherited document origin
// (`__csimSetDocumentOrigin`). Real-URL frames don't call this (location.origin =
// the URL's own origin). See the `_location.origin` getter in location.js.
globalThis.__csimSetLocationOrigin = function (o) {
  try { globalThis.__csimLocationOriginOverride = (o == null ? null : String(o)); } catch (_) {}
};

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
  SHOW_ENTITY_REFERENCE:       16,    // legacy node types (unmodelled) — values per spec
  SHOW_ENTITY:                 32,    // legacy
  SHOW_PROCESSING_INSTRUCTION: 64,
  SHOW_COMMENT:                128,
  SHOW_DOCUMENT:               256,
  SHOW_DOCUMENT_TYPE:          512,
  SHOW_DOCUMENT_FRAGMENT:      1024,
  SHOW_NOTATION:               2048,  // legacy
  FILTER_ACCEPT: 1,
  FILTER_REJECT: 2,
  FILTER_SKIP:   3
};

// URLPattern (the URL Pattern standard) — backed by the reference polyfill in
// the vendor bundle (urlpattern-polyfill; pure subpath import, the bridge owns
// the exposure). Exposed on Window AND worker scopes per the IDL. First
// consumer: the ServiceWorker Static Routing API's `urlPattern` conditions.
{
  const VP = globalThis.__csimVendor && globalThis.__csimVendor.URLPattern;
  if (VP && !globalThis.URLPattern) globalThis.URLPattern = VP;
}
