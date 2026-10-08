// Closure-free Web platform stubs. Just enough surface that
// feature-detection ("typeof CSS !== 'undefined'", "performance.now",
// "navigator.crypto.randomUUID") returns truthy and modern code paths
// don't crash on a missing global.

import {
  ErrorEvent, Event, EventTarget, FontFaceSetLoadEvent, PageTransitionEvent, createBeforeUnloadEvent, createMessageEvent,
  defineEventHandlers, deserializeException, dispatchWithOnHandler, installEventHandlerAttrs, serializeException
} from './events.js';
import { installScreenOrientation } from './generated/bindings.js';
import { faceSources, fontFileFromBytes } from './font-metrics.js';
import { onFontFlush } from './animation.js';
import { detachTransferables, transferListFrom } from './bytes.js';
import { installWebCrypto } from './webcrypto.js';
import { settledScrollOffsetOf } from './native-query-shadow.js';
import { cloneGeometry } from './geometry.js';
import { PLATFORM, brandPrototype, constructedBy, hasSlots, interfaceCheck, makeSlots, registerInterface, rejectedPromise, resolvedPromise, slotsOf } from './webidl.js';
import { scrollElement } from './dom-nodes.js';
import { documentElementOf } from './document-tree.js';
import { clearTimer, queueTask } from './timers.js';
import { fireEvent } from './dispatch.js';
import { location } from './location.js';
import { createFileList, filesOf } from './file-list.js';
import { acceptMessage, installPorts, isMessagePort, movePort, peerOf, portDetached, postRemote } from './message-port.js';

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

// `screen.orientation` (Screen Orientation), generated from its IDL — an EventTarget (it announces `change` as the
// device rotates). A fixed viewport never rotates, so `change` never fires — but the EventTarget surface has to exist
// regardless, because listening is unconditional in the wild and an object that is truthy-but-not-an-EventTarget passes
// an `if (screen.orientation)` guard and then throws on addEventListener. Values match headless Chrome on a desktop
// profile, down to `lock()` rejecting NotSupportedError (a desktop's orientation cannot be locked) and `unlock()` being
// a no-op. Made by the platform alone: the one `screen` has.
class ScreenOrientation extends EventTarget {
  constructor(token) {
    constructedBy(PLATFORM, token, 'ScreenOrientation');
    super();
    makeSlots(this, 'ScreenOrientation', {});
  }
}
registerInterface('ScreenOrientation', (o) => slotsOf(o, 'ScreenOrientation') !== undefined);
installScreenOrientation(ScreenOrientation, {
  get_type: () => 'landscape-primary',
  get_angle: () => 0,
  lock: () => rejectedPromise(new DOMException('screen.orientation.lock() is not available on this device.', 'NotSupportedError')),
  unlock() {},
  installEventHandlers: (proto, names, isSelf) => installEventHandlerAttrs(proto, names, null, isSelf)
});
globalThis.ScreenOrientation = ScreenOrientation;

// `screen` is the DISPLAY, not the window: it stays put while `resize_to` moves the viewport,
// exactly as a real browser's does, and it is what `maximize` / `fullscreen` resize back to.
// Libraries probe it for HiDPI / responsive decisions and we fall to the "small desktop" branch.
// (The Window's, window.js.)
export const screen = {
  width: SCREEN_W,      height: SCREEN_H,
  availWidth: SCREEN_W, availHeight: SCREEN_H,
  colorDepth: 24,         pixelDepth: 24,
  orientation: new ScreenOrientation(PLATFORM)
};

// …and the container the driver reads, whatever the page may see (a frame realm redefines it).
Object.defineProperty(globalThis, '__csimFrameContainer', { configurable: true, writable: true, value: null });

// `self.origin` / `window.origin` — the document's origin. For a normal page /
// real-URL frame it's the serialized location origin; a frame whose document
// origin differs from its location origin carries it in `__csimDocumentOrigin`
// (set at frame build): an opaque-URL frame (about:blank / srcdoc / javascript:)
// inherits its parent's origin, and a sandboxed-without-allow-same-origin frame
// is the opaque "null". Read for CORS / postMessage-target checks.
// (self-origin.sub.) The Window's (window.js) and a worker's scope's.
export function documentOrigin() {
  if (globalThis.__csimDocumentOrigin != null) return globalThis.__csimDocumentOrigin;
  try { return location.origin || ''; } catch (_) { return ''; }
}

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
  const o = documentOrigin();
  if (o !== 'null') return o;
  return (globalThis.__csimOriginKey = 'opaque:realm' + globalThis.RustyRacer.contextOf(globalThis));
};
// Serialize an origin key back to what MessageEvent.origin exposes: an opaque token → "null";
// a tuple origin is itself.
export function serializeOriginKey(key) {
  return (typeof key === 'string' && key.startsWith('opaque:')) ? 'null' : (key || '');
}

// `window.frames` is the window itself, but indexable by frame number: a
// numeric `frames[i]` is the i-th nested browsing context's window — for us the
// i-th `<iframe>`/`<frame>`'s `contentWindow` (a real per-frame realm global) —
// and `frames.length` their count. Everything else delegates to the window. (The
// global can't be indexed itself, so this is a Proxy of it, which `frames ===
// window` tells apart — the Window's, window.js.)
export function childFrameCount() {
  return globalThis.document.querySelectorAll('iframe, frame').length;
}
export const frames = new Proxy(globalThis, {
  get(target, prop) {
    if (typeof prop === 'string' && /^[0-9]+$/.test(prop)) {
      const el = globalThis.document.querySelectorAll('iframe, frame')[Number(prop)];
      return el ? el.contentWindow : undefined;
    }
    if (prop === 'length') return childFrameCount();
    return Reflect.get(target, prop, globalThis);
  }
});

// scrollX / scrollY (and the deprecated pageXOffset / pageYOffset
// aliases) reflect the scrolling element's offsets. Discourse's
// `route-scroll-manager` service reads `window.scrollY` to assert
// scroll position before/after route transitions; without live
// getters every poll lands on 0 even after a `scrollIntoView`.
export function windowScrollX() {
  const root = globalThis.document && documentElementOf(globalThis.document);
  return root ? settledScrollOffsetOf(root, 0) : 0;
}
export function windowScrollY() {
  const root = globalThis.document && documentElementOf(globalThis.document);
  return root ? settledScrollOffsetOf(root, 1) : 0;
}
// THE viewport — one value, owned by the driver (`Browser#set_viewport`, i.e. Capybara's
// `current_window.resize_to`), read by `innerWidth` / `innerHeight`, by the `@media` cascade and
// `matchMedia` (media-query.js `currentViewport`), and by the layout engine. Page script reaches it
// only through the Window's `[Replaceable]` attributes, so an assignment shadows the getter for that
// page without repointing layout — which is exactly what a real browser does. (The window's OUTER
// size is the same: we model no window chrome, where a real browser's is a title bar and borders
// larger.)
globalThis.__csimViewport = {width: SCREEN_W, height: SCREEN_H};

// `visualViewport` — modern mobile-keyboard / pinch-zoom aware
// viewport. Apps subscribe to its `resize` / `scroll` events to
// reflow when the soft keyboard appears (Mastodon's composer, chat
// UIs). Static values match the layout viewport; listeners are
// stored but never invoked because we don't model layout shifts.
export const visualViewport = {
  get offsetLeft() { return 0; },
  get offsetTop()  { return 0; },
  get pageLeft()   { return windowScrollX(); },
  get pageTop()    { return windowScrollY(); },
  get width()      { return globalThis.__csimViewport.width; },
  get height()     { return globalThis.__csimViewport.height; },
  get scale()      { return 1; },
  onresize: null,
  onscroll: null,
  addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; }
};
// The window's scrolls (CSSOM View): its document's scrolling element's — the body in quirks mode, whose offset IS
// the viewport's there — which is what `window.scrollY` reads through: `page.execute_script("window.scrollTo(0, 0)")`
// and Discourse's logo-refresh path scroll the page so. `scroll` and `scrollTo` to a position, `scrollBy` by an offset
// — a promise of the scroll's completion. (The Window's, window.js, which converted the arguments.)
export function scrollWindow(x, y, by) {
  const doc = globalThis.document;
  const el = doc && (doc.scrollingElement || documentElementOf(doc));
  return el ? scrollElement(el, x, y, by) : resolvedPromise();
}
// This realm's own id, as the host knows it — 0 for the main realm. Every JS→host call that
// names a browsing context (port endpoints, the focus chain) identifies itself through this.
globalThis.__csimRealmId = function () {
  return globalThis.RustyRacer.contextOf(globalThis) || 0;
};
// `window.focus()` — HTML "focusing steps" applied to a BROWSING CONTEXT rather than an
// element: it moves the focus chain to this window without touching its activeElement. Only
// the host tracks which context holds focus (it is cross-realm state), so this is purely a
// report. There is no window manager to raise, so nothing else happens. (The Window's,
// window.js, whose `blur()` is the no-op it is in every modern browser: the spec says user
// agents may ignore it.)
export function focusWindow() {
  const note = globalThis.__csimNoteFocusedRealm;
  if (typeof note !== 'function') return;
  try { note(globalThis.__csimRealmId()); } catch (_) {}
}

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
  // Both forms are the style engine's (cssom_decl.rs): does the declaration `property: value` parse as one the engine
  // implements — the judgement the declaration setter makes, so `CSS.supports('line-height', '-1')` and
  // `el.style.lineHeight = '-1'` cannot disagree — and, given one argument, a `<supports-condition>` or a bare
  // declaration (`CSS.supports('display: grid')`), evaluated as an `@supports` rule evaluates it.
  supports(property, value) {
    if (arguments.length < 2) return globalThis.__dom.declSupportsCondition(String(property));
    return globalThis.__dom.declSupports(String(property), String(value));
  }
};
// `CSS` is a namespace object: `Object.prototype.toString.call(CSS)` is
// `[object CSS]` via a configurable, non-writable, non-enumerable @@toStringTag.
Object.defineProperty(globalThis.CSS, Symbol.toStringTag, { value: 'CSS', configurable: true });


// CSS Font Loading (FontFace / FontFaceSet). A downloaded face (`@font-face` with a `url()`
// src) is FETCHED the first time text needs it — font-metrics.js `faceFile` asks the host for the
// file, the way Chrome loads a web font on first use —
// and `document.fonts` is the set of the document's CSS-connected faces plus what script
// added: `ready` resolves once the faces the rendered text needs are in (a layout pass loads
// them), `load()` / `check()` take a font shorthand, and a fetch runs a loading cycle
// (`loading`, then `loadingdone` / `loadingerror` with the faces), every step of it a task.
// Not modelled: a face's `unicode-range`, `local()` sources, a WOFF2 face's metrics (fetched
// and `loaded`, measured with the fallback family), `size-adjust` and the override
// descriptors.
// A FontFace descriptor is a validated getter/setter: setting an invalid value throws
// SyntaxError, and an invalid value passed to the CONSTRUCTOR errors the face (its `load()`
// rejects SyntaxError, its status is 'error') rather than throwing. `family` / `unicode-range`
// keep the driver's lenient acceptance; the override / size-adjust / percentage grammars are
// validated because css-font-loading tests assert the SyntaxError.
const FONT_DESCRIPTORS = {
  family:            { def: '',            slot: '_family' },
  style:             { def: 'normal',      slot: '_style' },
  weight:            { def: 'normal',      slot: '_weight' },
  stretch:           { def: 'normal',      slot: '_stretch' },
  unicodeRange:      { def: 'U+0-10FFFF',  slot: '_unicodeRange' },
  featureSettings:   { def: 'normal',      slot: '_featureSettings' },
  variationSettings: { def: 'normal',      slot: '_variationSettings' },
  display:           { def: 'auto',        slot: '_display',  valid: (v) => /^(auto|block|swap|fallback|optional)$/i.test(v.trim()) },
  ascentOverride:    { def: 'normal',      slot: '_ascentOverride',  valid: validOverride },
  descentOverride:   { def: 'normal',      slot: '_descentOverride', valid: validOverride },
  lineGapOverride:   { def: 'normal',      slot: '_lineGapOverride', valid: validOverride },
  sizeAdjust:        { def: '100%',        slot: '_sizeAdjust',      valid: validSizeAdjust }
};
// `normal` or a non-negative <percentage> (CSS Fonts 4 §5.x metric overrides).
const CALC_RE = /^calc\(/i;   // Chrome stores a calc() percentage verbatim, no deep validation
function validOverride(v) { const t = String(v).trim(); return t.toLowerCase() === 'normal' || CALC_RE.test(t) || nonNegPercent(t); }
function validSizeAdjust(v) { const t = String(v).trim(); return CALC_RE.test(t) || nonNegPercent(t); }
// A non-negative <percentage>, `-0%` included; `+` and a bare leading `.` allowed.
function nonNegPercent(t) { const m = /^([+-]?)(\d+(?:\.\d+)?|\.\d+)%$/.exec(t); return !!m && (m[1] !== '-' || parseFloat(m[2]) === 0); }
// The serialized form of a validated descriptor (Chrome normalizes: keywords lowercased, a
// percentage's `+` dropped, a bare `.5%` padded to `0.5%`, `-0%` to `0%`, whitespace trimmed;
// a `calc()` is kept verbatim). Only the validated descriptors are normalized — `family` and
// the list-valued ones round-trip as given.
function normalizeDescriptor(name, v) {
  const t = String(v).trim();
  if (name === 'display') return t.toLowerCase();
  if (CALC_RE.test(t)) return t;
  if (t.toLowerCase() === 'normal') return 'normal';
  const m = /^([+-]?)(\d+(?:\.\d+)?|\.\d+)%$/.exec(t);
  if (!m) return t;
  let n = parseFloat(m[2]);
  if (n === 0) n = 0;                                  // `-0` → `0`
  return (Number.isFinite(n) ? String(n) : m[2]) + '%';
}
// The value a descriptor takes from `raw`: its default when absent, stored normalized when valid, and null when invalid
// (the constructor errors the face then, and keeps the default — Chrome's getter reads it).
function descriptorValue(name, raw) {
  const spec = FONT_DESCRIPTORS[name];
  if (raw == null) return spec.def;
  const str = String(raw);
  if (!spec.valid) return str;
  return spec.valid(str) ? normalizeDescriptor(name, str) : null;
}
class FontFace {
  constructor(family, source, descriptors = {}) {
    const d = descriptors || {};
    hidden(this, '_descError', false);              // an invalid ctor descriptor → the face is errored
    hidden(this, '_family', String(family));
    for (const name in FONT_DESCRIPTORS) {
      if (name === 'family') continue;
      const val = descriptorValue(name, d[name]);
      if (val === null) this._descError = true;
      hidden(this, FONT_DESCRIPTORS[name].slot, val === null ? FONT_DESCRIPTORS[name].def : val);
    }
    hidden(this, '_source', source);
    hidden(this, '_loaded', null);
    hidden(this, '_settle', null);
    if (this._descError) {
      // Errored at construction, synchronously (Chrome): status is `error` at once and `loaded`
      // is already a rejected promise, whether or not `load()` is ever called.
      hidden(this, 'status', 'error');
      const p = this.loaded;                        // creates `_settle`
      this._settle.reject(new globalThis.DOMException('The provided descriptor value is invalid.', 'SyntaxError'));
    } else if (typeof source === 'string') {
      hidden(this, 'status', 'unloaded');
    } else {
      // A buffer source is the face's own bytes, parsed at construction: a buffer that is no
      // font fails the face (Chrome: `error`, `loaded` rejects with a SyntaxError).
      hidden(this, 'status', 'loading');
      const r = fontFileFromBytes(bufferBytes(source));
      hidden(this, '_sfntPath', r.path);
      globalThis.__csimSetTimeout(() => this._finish(r.ok, 'SyntaxError'), 0);
    }
  }
  get loaded() {
    if (!this._loaded) {
      this._loaded = new globalThis.Promise((resolve, reject) => { this._settle = { resolve, reject }; });
      this._loaded.catch(() => {});   // an `error` face rejects it; nobody has to listen
    }
    return this._loaded;
  }
  // `relayout`: whether text already laid out has to be measured again, which it does when the face settles on its own
  // schedule (a script's `load()`, a buffer). One layout fetched is being measured with by that very pass, and a
  // cascade refresh for it threw away every declared value and kept subtree on the page: a Redmine issue page paid a
  // whole relayout per load for its Noto Sans.
  _finish(ok, errorName = 'NetworkError', relayout = true) {
    if (this.status === 'loaded' || this.status === 'error') return;
    this.status = ok ? 'loaded' : 'error';
    this.loaded;                                             // make sure the promise exists
    if (this._settle) {
      if (ok) this._settle.resolve(this);
      else this._settle.reject(new globalThis.DOMException(ok ? '' : 'A network error occurred.', errorName));
    }
    if (relayout && typeof globalThis.__csimScheduleCascadeRefresh === 'function') globalThis.__csimScheduleCascadeRefresh();
  }
  load() {
    if (this._descError) return this.loaded;      // already errored + rejected at construction
    if (this.status !== 'unloaded') return this.loaded;
    this.status = 'loading';
    const base = location.href || undefined;
    const sources = typeof this._source === 'string' ? faceSources(this._source, base) : [];
    const src = sources.find(([kind]) => kind === 'url');
    if (!src) {
      // No downloadable source: a `local(<name>)` face loads if this machine has the font under
      // that name, else it fails (Chrome rejects `loaded` with a NetworkError — `font-face-reject`).
      const locals = sources.map(([, name]) => name);
      let ok = false;
      if (locals.length && typeof globalThis.__csim_localFontFile === 'function') {
        const bold = parseInt(this.weight, 10) >= 600, italic = /italic|oblique/.test(this.style);
        const ws = (bold ? 'bold' : '') + (italic ? (bold ? ':italic' : 'italic') : '');   // colon form, as `fc_match` expects
        for (const name of locals) {
          try { if (globalThis.__csim_localFontFile(name, ws)) { ok = true; break; } } catch (_) { /* misses */ }
        }
      }
      globalThis.__csimSetTimeout(() => this._finish(ok), 0);
      return this.loaded;
    }
    // A controlling service worker answers first (destination 'font'); a blocked
    // respondWith fails the face like a browser.
    const abs = src[1];
    if (/^https?:/i.test(abs) && typeof globalThis.__csimSwFetchDest === 'function') {
      const sw = globalThis.__csimSwFetchDest(abs, 'font', 'cors', 'same-origin', true);
      if (sw && sw.blocked) { globalThis.__csimSetTimeout(() => this._finish(false), 0); return this.loaded; }
    }
    if (typeof globalThis.__csimWebFontLoadUrl === 'function') {
      try { globalThis.__csimWebFontLoadUrl(this._source, globalThis.document, this); } catch (_) { globalThis.__csimSetTimeout(() => this._finish(false), 0); }
    } else {
      globalThis.__csimSetTimeout(() => this._finish(false), 0);
    }
    return this.loaded;
  }
  get [Symbol.toStringTag]() { return 'FontFace'; }
}
// A non-enumerable own slot — a FontFace has no enumerable own keys (Chrome: `Object.keys` is
// []), so the backing state must not leak through `for..in` / `Object.keys` / `JSON.stringify`.
function hidden(obj, key, value) { Object.defineProperty(obj, key, { value, writable: true, configurable: true, enumerable: false }); }
// The descriptor accessors: read the stored value; a set validates and throws SyntaxError on
// an invalid value (CSS Font Loading — a set never errors the face, only throws).
Object.defineProperty(FontFace.prototype, 'family', {
  configurable: true, enumerable: true,
  get() { return this._family; },
  set(v) { this._family = String(v); descriptorChanged(this); }
});
for (const name in FONT_DESCRIPTORS) {
  if (name === 'family') continue;
  const spec = FONT_DESCRIPTORS[name];
  Object.defineProperty(FontFace.prototype, name, {
    configurable: true, enumerable: true,
    get() { return this[spec.slot]; },
    set(v) {
      const val = String(v);
      if (spec.valid && !spec.valid(val)) {
        throw new globalThis.DOMException("Failed to set the '" + name + "' property on 'FontFace': The provided value '" + val + "' is invalid.", 'SyntaxError');
      }
      this[spec.slot] = spec.valid ? normalizeDescriptor(name, val) : val;
      descriptorChanged(this);
    }
  });
}
// A face the document's set holds matches by its descriptors, so rewriting one changes what the set holds as surely as
// adding the face does (`fontface-descriptor-updates-2`: a style swapped, a family renamed, and the next measure takes
// them). The document's index was rebuilt on every DOM mutation until it keyed on what decides it, and so saw these only
// when a mutation happened to follow.
function descriptorChanged(face) {
  const set = globalThis.document && globalThis.document._fontFaceSet;
  if (set && set._faces.has(face)) set._facesChanged();
}
function bufferBytes(source) {
  try {
    return source instanceof globalThis.ArrayBuffer ? new globalThis.Uint8Array(source)
         : (globalThis.ArrayBuffer.isView(source) ? new globalThis.Uint8Array(source.buffer, source.byteOffset, source.byteLength) : new globalThis.Uint8Array(0));
  } catch (_) { return new globalThis.Uint8Array(0); }
}
// The document's set: the faces its stylesheets declare (CSS-connected, one FontFace per
// `@font-face` rule that applies, kept while the rule lives) plus the ones script `add()`ed.
const FONT_SET_TOKEN = {};
// A CSS-connected face's identity (`FontFaceSet._connected`): its family and the sources its `src` names, each `url()`
// resolved against `base` — what makes two reads of one rule the same face, however each wrote its declarations (a
// format hint, the quoting, the spacing between them).
function faceIdentity(style, base) {
  const family = (style.getPropertyValue('font-family') || '').trim().replace(/^["']|["']$/g, '');
  const sources = faceSources(style.getPropertyValue('src') || '', base).map(([kind, value]) => `${kind}:${value}`);
  return `${family}\n${sources.join('\n')}`;
}

// The `@font-face` descriptor each FontFace attribute reflects.
const RULE_DESCRIPTORS = {
  style:             'font-style',
  weight:            'font-weight',
  stretch:           'font-stretch',
  unicodeRange:      'unicode-range',
  featureSettings:   'font-feature-settings',
  variationSettings: 'font-variation-settings',
  display:           'font-display',
  ascentOverride:    'ascent-override',
  descentOverride:   'descent-override',
  lineGapOverride:   'line-gap-override',
  sizeAdjust:        'size-adjust'
};
// A rule's descriptors as the FontFace constructor takes them: the ones it declares.
function ruleDescriptors(style) {
  const d = {};
  for (const name in RULE_DESCRIPTORS) {
    const v = style.getPropertyValue(RULE_DESCRIPTORS[name]);
    if (v) d[name] = v;
  }
  return d;
}
// …and written over a face already connected to it once they CHANGE (`_ruleDesc`, what was last reflected): each
// attribute what the rule says now, or its default. A rule that says the same as it did leaves the face alone — a
// script may have set an attribute since, which this face keeps (Chrome; the setters reach no rule here).
function reflectRuleDescriptors(face, style) {
  const d = ruleDescriptors(style), sig = JSON.stringify(d);
  if (sig === face._ruleDesc) return;
  face._ruleDesc = sig;
  for (const name in RULE_DESCRIPTORS) {
    const val = descriptorValue(name, d[name]);
    face[FONT_DESCRIPTORS[name].slot] = val === null ? FONT_DESCRIPTORS[name].def : val;
  }
}

class FontFaceSet extends EventTarget {
  constructor(doc, token) {
    // Not constructible from script (`document.fonts` is the only source): a page-side
    // `new FontFaceSet()` throws, as in Chrome (css-font-loading/historical.html).
    if (token !== FONT_SET_TOKEN) throw new TypeError('Illegal constructor');
    super();
    Object.defineProperty(this, '_faces', { value: new globalThis.Set(), enumerable: false });
    Object.defineProperty(this, '_doc', { value: doc || null, enumerable: false, writable: true });
    Object.defineProperty(this, '_cssFaces', { value: new globalThis.Map(), enumerable: false });
    Object.defineProperty(this, '_pending', { value: [], enumerable: false, writable: true });
    Object.defineProperty(this, '_cycleQueued', { value: false, enumerable: false, writable: true });
    Object.defineProperty(this, '_readyPromise', { value: null, enumerable: false, writable: true });
    Object.defineProperty(this, '_readySettle', { value: null, enumerable: false, writable: true });
    // …the generation of what the set HOLDS — a face added, deleted, or one of its descriptors rewritten — which the
    // document's face index keys on (font-metrics.js `fontFaceIndex`).
    Object.defineProperty(this, '_facesGen', { value: 0, enumerable: false, writable: true });
    // The rendering update loads the faces rendered text needs; true when the set has changed since
    // the last such flush (initially, so the first update loads the page's own faces).
    Object.defineProperty(this, '_needFlush', { value: true, enumerable: false, writable: true });
  }
  // The CSS-connected faces, in stylesheet order — a FontFace per applying rule, reused
  // while the rule lives (a face removed with its stylesheet drops out of the set).
  _connected() {
    const out = [], doc = this._doc;
    const entries = doc && typeof globalThis.__csimFontFaceIndex === 'function' ? globalThis.__csimFontFaceIndex(doc).rules : [];
    const live = new globalThis.Set();
    for (const entry of entries) {
      // (…keyed by the face's identity, `entry.key`, which outlives the rule it is read from: see cascade.js `faceKey`.)
      const r = entry.rule, key = entry.key;
      if (!r.style) continue;
      // …and only while it is the face it was made from: a rule inserted before it moves the next rule into its place,
      // which is a face of its own. Known by its family and its sources, resolved — not by its declarations' text, which
      // the style engine (an unbuilt sheet's faces) and the CSSOM (a built one's) write differently for one face.
      const decl = faceIdentity(r.style, entry.base);
      let face = this._cssFaces.get(key);
      if (face && face._cssDecl !== decl) face = null;
      // The same face reflects its rule as it is now (CSS Font Loading §2.2: a CSS-connected face's attributes are its
      // rule's descriptors) — one whose weight or style was rewritten keeps its identity, and reads the new value.
      if (face) reflectRuleDescriptors(face, r.style);
      else {
        const fam = (r.style.getPropertyValue('font-family') || '').trim().replace(/^["']|["']$/g, '');
        const desc = ruleDescriptors(r.style);
        face = new FontFace(fam, r.style.getPropertyValue('src') || '', desc);
        hidden(face, '_ruleDesc', JSON.stringify(desc));
        hidden(face, '_rule', key);
        hidden(face, '_cssDecl', decl);
        // A CSS-connected face whose file layout already fetched (text needed it before
        // script looked at `document.fonts`) is loaded — or failed — from the start; a face
        // script constructs starts `unloaded` whatever the cache holds.
        // …loaded from the start unless THIS is the face `_faceFetched` is materialising for
        // its own cycle (that face settles there, not here).
        if (key !== this._materialisingRule && typeof globalThis.__csimWebFontStatus === 'function') {
          const st = globalThis.__csimWebFontStatus(face._source, entry.base);
          if (st !== 'unloaded') { face.status = st; if (st === 'loaded') face._loaded = globalThis.Promise.resolve(face); else { face._loaded = globalThis.Promise.reject(new globalThis.DOMException('A network error occurred.', 'NetworkError')); face._loaded.catch(() => {}); } }
        }
        this._cssFaces.set(key, face);
      }
      live.add(key);
      out.push(face);
    }
    for (const k of Array.from(this._cssFaces.keys())) if (!live.has(k)) this._cssFaces.delete(k);
    return out;
  }
  // Reading the set lays the document out first: Chrome has loaded the faces its rendered
  // text needs by the time script looks, and layout is what loads them here.
  _all() { this._flushLayout(); return this._connected().concat(Array.from(this._faces)); }
  // Layout loads the faces the rendered text needs; the set reports after such a pass, as
  // Chrome has loaded them by the time script looks.
  _flushLayout() {
    const root = this._doc && documentElementOf(this._doc);
    if (root && typeof root.getBoundingClientRect === 'function') { try { root.getBoundingClientRect(); } catch (_) {} }
  }
  // font-metrics.js reports a fetched face here — by the face (its rule, or the script
  // object) — and the loading cycle's events go out as TASKS: `loading` once per cycle,
  // `loadingdone` / `loadingerror` with the faces once the turn's fetches are in, `ready`
  // settled after them. Nothing here touches layout: a listener that mutates the DOM
  // must not re-enter the pass that loaded the face.
  _faceFetched(who, ok) {
    let face = null;
    if (who && who.rule) {
      face = this._cssFaces.get(who.rule) || null;
      if (!face) {
        // Materialise the rule's face (no layout) as `unloaded`: THIS fetch is its cycle; other
        // CSS faces still take their cached status.
        this._materialisingRule = who.rule;
        try { this._connected(); } finally { this._materialisingRule = null; }
        face = this._cssFaces.get(who.rule) || null;
      }
    } else if (who instanceof FontFace) face = who;
    if (!face || face.status === 'loaded' || face.status === 'error') return;
    if (!this._pending.length && !this._cycleQueued) {
      this._cycleQueued = true;
      globalThis.__csimSetTimeout(() => {
        this._cycleQueued = false;
        fireEvent(this, new Event('loading'));
        globalThis.__csimSetTimeout(() => {
          const batch = this._pending; this._pending = [];
          for (const p of batch) p.face._finish(p.ok);
          const done = batch.filter((p) => p.ok).map((p) => p.face), failed = batch.filter((p) => !p.ok).map((p) => p.face);
          fireEvent(this, new FontFaceSetLoadEvent('loadingdone', { fontfaces: done }));
          if (failed.length) fireEvent(this, new FontFaceSetLoadEvent('loadingerror', { fontfaces: failed }));
          const settle = this._readySettle; this._readySettle = null;
          if (settle) settle(this);
        }, 0);
      }, 0);
    }
    // A face layout fetched is settled at once — Chrome has loaded what rendered text needs
    // by the time script looks; the cycle's events still go out as tasks. One script
    // `load()`ed stays `loading` until its task, as in Chrome.
    if (who && who.rule) face._finish(ok, 'NetworkError', false);
    else if (face.status === 'unloaded') face.status = 'loading';
    this._pending.push({ face, ok });
  }
  // `ready`: one promise per loading cycle, resolved once the cycle's `loadingdone` went out.
  get ready() {
    this._flushLayout();
    if (!this._pending.length && !this._cycleQueued) return this._readyPromise || (this._readyPromise = globalThis.Promise.resolve(this));
    if (!this._readySettle) this._readyPromise = new globalThis.Promise((resolve) => { this._readySettle = resolve; });
    return this._readyPromise;
  }
  get status() { return this._pending.length || this._cycleQueued ? 'loading' : 'loaded'; }
  get size()   { return this._all().length; }
  add(f)       {
    if (!(f instanceof FontFace)) throw new TypeError("Failed to execute 'add' on 'FontFaceSet': parameter 1 is not of type 'FontFace'.");
    if (f._rule) return this;                                   // a CSS-connected face is in the set already
    if (!this._faces.has(f)) { this._faces.add(f); this._needFlush = true; this._facesChanged(); }
    return this;
  }
  delete(f)    { const had = this._faces.delete(f); if (had) this._facesChanged(); return had; }
  has(f)       { return this._faces.has(f) || this._connected().includes(f); }
  clear()      { if (this._faces.size) { this._faces.clear(); this._facesChanged(); } }
  _facesChanged() {
    this._facesGen++;
    if (typeof globalThis.__csimScheduleCascadeRefresh === 'function') globalThis.__csimScheduleCascadeRefresh();
  }
  // `check(font)`: true when every family the shorthand names has no face to load or a
  // loaded one; `load(font)`: fetches those faces and resolves with them. Both take the
  // `font` shorthand, and a shorthand that does not parse is a SyntaxError.
  _familiesOf(font, method) {
    const fams = typeof globalThis.__csimFontShorthandFamilies === 'function' ? globalThis.__csimFontShorthandFamilies(font) : null;
    if (!fams) throw new globalThis.DOMException("Failed to execute '" + method + "' on 'FontFaceSet': Could not resolve '" + String(font) + "' as a font.", 'SyntaxError');
    return fams;
  }
  _facesFor(fam) { return this._all().filter((f) => f.family.replace(/^["']|["']$/g, '').toLowerCase() === fam.toLowerCase()); }
  check(font) {
    const fams = this._familiesOf(font, 'check');
    return fams.every((fam) => { const faces = this._facesFor(fam); return faces.length === 0 || faces.every((f) => f.status === 'loaded'); });
  }
  load(font) {
    let fams;
    try { fams = this._familiesOf(font, 'load'); } catch (e) { return globalThis.Promise.reject(e); }
    const faces = [];
    for (const fam of fams) {
      for (const f of this._facesFor(fam)) {
        if (f.status === 'unloaded') {
          if (f._rule && typeof globalThis.__csimWebFontLoad === 'function' && this._doc) { try { globalThis.__csimWebFontLoad(this._doc, fam); } catch (_) {} }
          else f.load();
        }
        faces.push(f);
      }
    }
    // Resolves with the faces once they are in; a face that failed rejects it (NetworkError).
    return globalThis.Promise.all(faces.map((f) => f.loaded)).then(() => faces);
  }
  forEach(cb, thisArg) { this._all().forEach(f => cb.call(thisArg, f, f, this)); }
  values()     { return this._all()[globalThis.Symbol.iterator](); }
  keys()       { return this.values(); }
  entries()    { return this._all().map((f) => [f, f])[globalThis.Symbol.iterator](); }
  [Symbol.iterator]() { return this.values(); }
  get [Symbol.toStringTag]() { return 'FontFaceSet'; }
}
defineEventHandlers(FontFaceSet.prototype, ['loading', 'loadingdone', 'loadingerror']);
// (…its brand, and the family its constructor gave it, for a conversion to one: a FontFaceSetLoadEvent's `fontfaces`)
const FONT_FACE = brandPrototype(FontFace, 'FontFace');
registerInterface('FontFace', (o) => o !== null && typeof o === 'object' && o[FONT_FACE] === true && o._family !== undefined);
globalThis.FontFace    = FontFace;
globalThis.FontFaceSet = FontFaceSet;
globalThis.__csimNewFontFaceSet = (doc) => new FontFaceSet(doc, FONT_SET_TOKEN);
// At each rendering update, load the faces this realm's rendered text needs — a browser loads a
// used font at the update even if no script measured it (`font-face-reject` relies on it). Gated on
// `_needFlush` (set when a face is added, and once initially), so a page whose faces have all
// settled pays nothing; the flush itself is a memoised layout when nothing changed.
onFontFlush(() => {
  const doc = globalThis.document;
  if (!doc) return;
  let set = doc._fontFaceSet;
  if (!set) {
    // No script has touched `document.fonts`, but a page can declare an `@font-face` used by
    // rendered text with no script at all — a browser still loads it at the rendering update.
    // Instantiate the set (its first flush) only when the document declares a face; the O(1) gate
    // keeps a page with none from paying anything.
    if (typeof globalThis.__csimDocHasFontFace === 'function' && !globalThis.__csimDocHasFontFace()) return;
    set = doc.fonts;                                            // lazily creates it, `_needFlush` true
  }
  if (set && set._needFlush) { set._needFlush = false; set._flushLayout(); }
});

// The standard Error subtypes StructuredSerialize preserves; any other `name` deserializes
// as a plain Error.
const ERROR_NAMES = ['Error', 'EvalError', 'RangeError', 'ReferenceError', 'SyntaxError', 'TypeError', 'URIError'];

// (…what no structured clone takes: any realm's EventTarget; and the exception it takes as one)
const IS_EVENT_TARGET  = interfaceCheck('EventTarget');
const IS_DOM_EXCEPTION = interfaceCheck('DOMException');
const uncloneable = (what) => dataCloneError(`Failed to execute 'structuredClone' on 'Window': ${what} could not be cloned.`);
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
  if (isMessagePort(t))               { if (portDetached(t)) throw dataCloneError('A detached MessagePort could not be transferred.'); return; }
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
  // (…a MessagePort onto a fresh entangled one, its held messages and enabled state with it)
  if (isMessagePort(t)) return movePort(t);
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
  // (…any realm's, by its slots: an object merely claiming the class string, or behind Blob.prototype, is none)
  if (slotsOf(v, 'Blob') && typeof globalThis.__csimCloneBlob === 'function') {
    const b = globalThis.__csimCloneBlob(v); seen.set(v, b); return b;
  }
  // A CryptoKey is serializable — duplicate it (algorithm + key material) through the
  // Web Crypto hook. Brand-tagged so a same-realm key handed to structuredClone / a
  // posted key both match.
  if (tag === '[object CryptoKey]' && typeof globalThis.__csimCloneCryptoKey === 'function') {
    const k = globalThis.__csimCloneCryptoKey(v); seen.set(v, k); return k;
  }
  // A DOMPoint / DOMRect / DOMQuad / DOMMatrix (or a read-only one) clones to one of its kind — any realm's, by its slots.
  const geometry = hasSlots(v) ? cloneGeometry(v) : undefined;
  if (geometry) { seen.set(v, geometry); return geometry; }
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
  // A DOMException — any realm's — is [Serializable] (Web IDL §3.14.1): made this realm's again of its serialization.
  if (IS_DOM_EXCEPTION(v)) {
    const e = deserializeException(serializeException(v));
    seen.set(v, e);
    return e;
  }
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
  if (filesOf(v) !== undefined) {
    const out = createFileList(filesOf(v).map(f => cloneInto(f, seen)));
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
  // Non-serializable platform objects throw DataCloneError (StructuredSerialize) rather than degrading to a plain-object
  // copy carrying their internal state (structured-clone "Serializing a non-serializable platform object fails"): no
  // EventTarget is [Serializable] — a window (any realm's: `[object Window]`), a Node, an AbortSignal, a port not being
  // transferred — nor any other platform object with slots of its own here (a URL, a Headers, a FormData, a Request, a
  // Response, an AbortController, an XPathResult, a Location). Chrome's messages: "<interface> object", a window
  // "#<Window>".
  if (tag === '[object Window]') throw uncloneable('#<Window>');
  if (IS_EVENT_TARGET(v) || hasSlots(v)) throw uncloneable(`${tag.slice(8, -1)} object`);
  // …nor the transferable-ONLY ones (ReadableStream / OffscreenCanvas; a MessagePort is an EventTarget): cloning one
  // that is NOT being transferred is a DataCloneError (a transferred one was already handed to its moved counterpart
  // via the `currentTransfer.set` check above).
  if ((globalThis.ReadableStream  && v instanceof globalThis.ReadableStream) ||
      (globalThis.OffscreenCanvas && v instanceof globalThis.OffscreenCanvas)) {
    throw dataCloneError();
  }
  const out = {}; seen.set(v, out);
  for (const k of Object.keys(v)) out[k] = cloneInto(v[k], seen);
  return out;
}
// WindowOrWorkerGlobalScope's `structuredClone` (window.js, which converted `options`; a worker's scope).
export function structuredClone(v, options) {
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
}
globalThis.__csimStructuredClone = structuredClone;

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
      if (isMessagePort(t)) ports.push(moved);
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
export function reportError(e) {
  globalThis.__csimReportException(e, () => console.error(e && e.stack ? e.stack : String(e)));
}
globalThis.__csimReportError = reportError;
// …the same steps for the driver's own callers, which log in their own words (`log`, run only where no listener
// cancelled the event): a script the PARSER ran, whose exception reached no `window.onerror` at all before.
// An Error of ANY realm (the brand, not `instanceof`: a cross-realm callback's error is no instance of this realm's
// Error), or a DOMException of any realm (its slots: its class string is its own).
function isErrorObject(e) {
  return !!e && typeof e === 'object' && (Object.prototype.toString.call(e) === '[object Error]' || IS_DOM_EXCEPTION(e));
}
globalThis.__csimReportException = function reportException(e, log) {
  // Re-entrancy guard: an `error` handler (`window.onerror` / an `error`
  // listener) that itself throws is reported too — but firing ANOTHER `error`
  // event for it would recurse unboundedly. While already reporting, skip the
  // event and just log, matching browsers (error reporting is not re-entrant).
  if (__csimReportingError) {
    try { log(); } catch (_) {}
    return;
  }
  let cancelled = false, ev = null;
  __csimReportingError = true;
  try {
    ev = new ErrorEvent('error', {
      cancelable: true,
      // Duck-type, not `instanceof Error`: a cross-realm Error (reported on the
      // callback's realm via `__csimReportCallbackError`) isn't an instance of
      // THIS realm's Error, but still has a string `message` to surface.
      // …as "Name: message" for an Error or a DOMException: the spec leaves the text open, and it is what Chrome
      // ("Uncaught Error: x") and Firefox ("Error: x") share — bare "x" was neither's. Anything else thrown is its
      // string (Firefox's "[object Object]" half; a `{name, message}` object is no Error).
      message:    isErrorObject(e) ? e.name + ': ' + e.message : String(e),
      error:      e,
      ...errorLocation(e)
    });
    cancelled = !fireEvent(globalThis, ev);
  } catch (_) {} finally { __csimReportingError = false; }
  if (!cancelled) {
    // (…and, in a dedicated worker, reported on at its Worker: workers.js)
    if (ev && globalThis.__csimForwardUnhandledError) globalThis.__csimForwardUnhandledError(ev);
    try { log(ev); } catch (_) {}
  }
};
// Where an exception was thrown, for its ErrorEvent: the script, line and column of its stack's top frame (V8's
// `at f (url:line:col)` / `at url:line:col`) — an inline script's the document's URL, as Chrome reports it, not the
// label the driver ran it under — none for a value with no stack.
// (…the page's frame the error was thrown in: the driver's own — the snapshot's, where a binding threw it for the
// page's call — skipped, as a browser's bindings are no frame of a stack. Code the page's document compiled — an
// inline script, an event handler content attribute, a string handed to setTimeout, `new Function`, `eval`: V8's
// `eval at …, <anonymous>:L:C` — is the document's.)
const STACK_FRAME = /^\s+at (?:.*?\()?(\S+?):(\d+):(\d+)\)?$/;
const EVAL_FRAME = /^\s+at .*\(eval at .*, <anonymous>:(\d+):(\d+)\)$/;
function errorLocation(e) {
  const stack = isErrorObject(e) && typeof e.stack === 'string' ? e.stack : '';
  for (const line of stack.split('\n')) {
    const evaluated = EVAL_FRAME.exec(line);
    if (evaluated) return { filename: location.href, lineno: Number(evaluated[1]), colno: Number(evaluated[2]) };
    const frame = STACK_FRAME.exec(line);
    if (!frame || frame[1] === '<snapshot>') continue;
    const inline = /^(?:inline:\/\/|csim-eval)/.test(frame[1]);
    return { filename: inline ? location.href : frame[1], lineno: Number(frame[2]), colno: Number(frame[3]) };
  }
  return {};
}

// "Report the exception" of an error the platform raises with no exception object — ResizeObserver's loop error: an
// ErrorEvent of `message` alone, its `error` null and its location the document at 0:0 (Chrome), then the console where
// no listener cancelled it.
globalThis.__csimReportLoopError = function (message) {
  if (__csimReportingError) return;
  let cancelled = false;
  __csimReportingError = true;
  try {
    const ev = new ErrorEvent('error', { cancelable: true, message, filename: location.href, lineno: 0, colno: 0, error: null });
    cancelled = !fireEvent(globalThis, ev);
  } catch (_) {} finally { __csimReportingError = false; }
  if (!cancelled) console.error(message);
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
    if (anchor) {
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
  if (__csimSelfRealmId === undefined) {
    try { __csimSelfRealmId = globalThis.RustyRacer.contextOf(globalThis); } catch (_) {}
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
// The driver's own `__csim*` bookkeeping — never web-observable, so no origin gates it.
function isInternalKey(prop) {
  return typeof prop === 'string' && prop.lastIndexOf('__csim', 0) === 0 && !WINDOW_STATE_KEYS.has(prop);
}
// (…but a window's own state — its document, its name, its steps (window.js) — which is a page's to see as its members
// let it, so no more than they do cross-origin)
const WINDOW_STATE_KEYS = new Set([
  '__csimDocument', '__csimWindowSteps', '__csimWindowName', '__csimWindowStatus', '__csimOpener', '__csimCurrentEvent'
]);
// Which keys a cross-origin WindowProxy still exposes to `[[Get]]` / `[[Has]]` /
// `[[OwnPropertyKeys]]`: the CrossOriginProperties, indexed-frame keys, any Symbol
// (@@toStringTag etc.), and internal `__csim*` bookkeeping (never web-observable — the
// blob-nav snapshot walk reads it on a cross-origin parent/top). Everything else is hidden.
function crossOriginWindowAccessible(prop) {
  if (typeof prop === 'symbol') return true;
  if (typeof prop !== 'string') return false;
  return isInternalKey(prop) || /^[0-9]+$/.test(prop) || CROSS_ORIGIN_WINDOW_PROPS.has(prop);
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
      if (isInternalKey(prop)) return Reflect.get(t, prop, t);
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
  try { o = rawWindow.__csimOrigin(); read = true; } catch (_) {}
  return read && o === documentOrigin();
}
globalThis.__csimIsSameOriginWindow = isSameOriginAs;

function frameWindowProxyFor(targetRealmId) {
  if (targetRealmId == null) return null;
  let raw;
  try { raw = globalThis.RustyRacer.contextGlobal(targetRealmId); } catch (_) { return null; }
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
  // is finalized recomputes. The target's origin is stable — a target re-navigation disposes
  // its realm and evicts this proxy — so only the observer origin varies.
  let memoOrigin = null, memoResult = false;
  const sameOrigin = () => {
    const cur = documentOrigin();
    if (memoOrigin !== cur) { memoResult = isSameOriginAs(raw); memoOrigin = cur; }
    return memoResult;
  };
  // The proxy's target is no window but an object of its own, as HTML's WindowProxy is no JS Proxy of one: a window's
  // [LegacyUnforgeable] members are non-configurable, which a Proxy of it could neither hide cross-origin (`'document'
  // in frame` false) nor report configurable, as a WindowProxy does ([[GetOwnProperty]]) — the target holds only what
  // was defined non-configurable through the proxy, which its invariants then ask of it.
  const shadow = {};
  p = new Proxy(shadow, {
    get(_t, prop) {
      if (prop === '__csimRawWindow') return raw;   // unwrap hook (also used cross-realm)
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
        let inner; try { inner = Reflect.get(raw, prop, raw); } catch (_) {}
        const innerRaw = (inner && inner.__csimRawWindow) || inner;
        return innerRaw === globalThis ? globalThis : inner;
      }
      // SOP: a cross-origin WindowProxy exposes only the CrossOriginProperties;
      // reading anything else (e.g. `document`) throws SecurityError. Internal
      // driver bookkeeping (`__csim*`) is never web-observable so it bypasses the
      // gate (the blob-nav snapshot walk reads it on cross-origin parent/top);
      // Symbols and numeric (indexed-frame) keys pass through too.
      if (typeof prop === 'string' && !isInternalKey(prop) &&
          !/^[0-9]+$/.test(prop) && !CROSS_ORIGIN_WINDOW_PROPS.has(prop) && !sameOrigin()) {
        throw crossOriginSecurityError();
      }
      // `location` is cross-origin-readable, but the returned Location is itself SOP-gated:
      // only its `href` setter + `replace()` work cross-origin (so `frame.location.href`
      // GETTER throws, not leaks the URL). Same-origin returns the raw Location unchanged.
      if (prop === 'location' && !sameOrigin()) {
        const loc = Reflect.get(raw, prop, raw);
        return loc ? crossOriginLocation(loc) : loc;
      }
      return Reflect.get(raw, prop, raw);   // getters/methods resolve against the real window
    },
    // (…a setter that throws throws to the assigner: `frame.contentWindow.location = 'http://foo:-80/'` is a SyntaxError
    // in the frame's realm, as `location.href = …` is). Cross-origin only `location` is settable (HTML CrossOriginSet);
    // anything else is a SecurityError, as deleting anything is ([[Delete]]).
    set(_t, prop, val) {
      if (prop !== 'location' && !isInternalKey(prop) && !sameOrigin()) throw crossOriginSecurityError();
      return Reflect.set(raw, prop, val, raw);
    },
    // `[[Has]]` / `[[OwnPropertyKeys]]` / `[[GetOwnProperty]]` are SOP-gated cross-origin so the
    // same-origin surface (`'document' in frame`, `Object.keys(frame)`, a descriptor probe) doesn't
    // leak: `in` reports absent (false); a direct descriptor probe throws SecurityError, matching
    // browsers. A descriptor reported is configurable, as a WindowProxy's is, but for what the
    // target holds.
    has(_t, prop) {
      return (sameOrigin() || crossOriginWindowAccessible(prop)) && Reflect.has(raw, prop);
    },
    deleteProperty(_t, prop) {
      if (!isInternalKey(prop) && !sameOrigin()) throw crossOriginSecurityError();
      return Reflect.deleteProperty(raw, prop);
    },
    // (…and [[DefineOwnProperty]] likewise, HTML's WindowProxy: a cross-origin one defines nothing)
    defineProperty(t, prop, desc) {
      if (!isInternalKey(prop) && !sameOrigin()) throw crossOriginSecurityError();
      const defined = Reflect.defineProperty(raw, prop, desc);
      if (defined && desc.configurable === false) Reflect.defineProperty(t, prop, desc);
      return defined;
    },
    // (…cross-origin, unenumerable — HTML's CrossOriginGetOwnPropertyHelper)
    getOwnPropertyDescriptor(t, prop) {
      const same = sameOrigin();
      if (!same && !crossOriginWindowAccessible(prop)) throw crossOriginSecurityError();
      const d = Reflect.getOwnPropertyDescriptor(raw, prop);
      if (d && !d.configurable && !Reflect.getOwnPropertyDescriptor(t, prop)) d.configurable = true;
      if (d && !same && !Reflect.getOwnPropertyDescriptor(t, prop)) d.enumerable = false;
      return d;
    },
    ownKeys(t) {
      if (sameOrigin()) return Reflect.ownKeys(raw);
      return [...new Set([...Reflect.ownKeys(raw).filter((k) => crossOriginWindowAccessible(k)), ...Reflect.ownKeys(t)])];
    },
    getPrototypeOf()                  { return sameOrigin() ? Reflect.getPrototypeOf(raw) : null; },
    setPrototypeOf()                  { return false; },
    preventExtensions()               { return false; }
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
            (globalThis.__csimTop && globalThis.__csimTop !== globalThis));
};
// True if `o` is a realm's global object (a Window) — used by event dispatch to
// retarget a window event-target to the observing listener's own WindowProxy.
globalThis.__csimIsWindowGlobal = function (o) {
  if (!o || typeof o !== 'object') return false;
  if (o === globalThis) return true;
  const NS = globalThis.RustyRacer;
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
  if (id == null) return null;
  try { return globalThis.RustyRacer.contextGlobal(id) || null; } catch (_) { return null; }
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
  const root = globalThis.__csimTop || globalThis;
  let id;
  if (handler != null) { try { id = globalThis.RustyRacer.contextOf(handler); } catch (_) {} }
  try { root.__csimActiveListenerRealmId = id; } catch (_) {}
  return id;
};
globalThis.__csimGetActiveListenerRealm = function () {
  const root = globalThis.__csimTop || globalThis;
  try { return root.__csimActiveListenerRealmId; } catch (_) { return undefined; }
};
// Map a window global to the active-listener realm's WindowProxy (for
// composedPath / any post-dispatch window-in-path read). No-op same-realm.
globalThis.__csimRetargetWindow = function (win) {
  if (!win) return win;
  const obsId = globalThis.__csimGetActiveListenerRealm();
  if (obsId == null) return win;
  let winId; try { winId = globalThis.RustyRacer.contextOf(win); } catch (_) { return win; }
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
  try { const g = globalThis.__csimRealmGlobalById(realmId); return g ? g.__csimOrigin() : ''; } catch (_) { return ''; }
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
    let targetOrig = ''; try { targetOrig = g.__csimOrigin(); } catch (_) {}
    const wanted = to === '/' ? senderOrigin : originOfTarget(to);
    if (targetOrig !== wanted) return;
  }
  // event.origin in the receiver is the SENDER's origin (not '').
  g.__csimDeliverFrameMessage(senderId, data, senderOrigin, ports);
};
// A MessagePort transferred from another realm INTO this one is moved onto a port of this realm (`movePort`): a
// delivered `event.ports[i]` is a MessagePort of this realm, whose messages are this realm's tasks and events.
// LIMITATION: a `port.postMessage` clones its payload in the SENDER's realm (as the same-realm path does) and the peer
// dispatches it without re-cloning, so across realms `event.data` is a foreign-realm object graph — fine for plain/JSON
// payloads (property reads + @@toStringTag brand checks work), off for receiver-realm `instanceof Object` identity.
// Runs in the TARGET realm: clone the payload into this realm, adopt any transferred
// ports, and queue the `message` event task with source = this realm's proxy for the sender.
globalThis.__csimDeliverFrameMessage = function (senderId, message, senderOrigin, movedPorts) {
  let data;
  try { data = structuredClone(message); } catch (_) { data = message; }
  const ports = [];
  if (Array.isArray(movedPorts)) {
    for (const mp of movedPorts) { try { ports.push(movePort(mp)); } catch (_) {} }
  }
  setTimeout(() => {
    let source = null;
    try { source = frameWindowProxyFor(senderId); } catch (_) {}
    try {
      dispatchWithOnHandler(globalThis, createMessageEvent('message', {
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
  reportError(e);
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
  reportError(e);
};

// Realm-correct an exception that PROPAGATES to the caller rather than being
// reported — a NodeFilter `acceptNode` failure in TreeWalker / NodeIterator,
// where `assert_throws_js(otherRealm.TypeError, …)` checks the thrown error's
// realm. Returns the error re-created in `anchor`'s realm (or `e` unchanged
// same-realm). The caller throws the result.
globalThis.__csimRealmizeCallbackError = function (anchor, e) {
  return __csimRealmizeError(__csimRealmGlobalOf(anchor), e);
};

// Whether the window's browsing context is discarded — a removed frame's (`__csimNeuterDetachedWindow` marks it),
// which `window.closed` reads (window.js) through a reference captured before the removal.
// (…defined, false, from the start: every `defaultView` read asks it, and a miss on the global is a slow lookup)
Object.defineProperty(globalThis, '__csimBrowsingContextDiscarded', { value: false, writable: true, configurable: true, enumerable: false });

// Is `cb` still "runnable" — i.e. does it belong to a browsing context that
// hasn't been destroyed? A callback whose realm is a DISPOSED child frame realm
// (the frame was removed from the document) is no longer runnable, and per HTML
// "invoke a callback function" the caller throws instead of calling it (e.g.
// NodeIterator/TreeWalker filtering after `iframe.remove()`). Returns true for a
// same-realm callback or an object-shaped callback with no realm — only a callback
// of a realm in no live browsing-context tree (no realm's `__csimChildRealmIds`) is dead.
// (dom/traversal/TreeWalker-acceptNode-filter-cross-realm-null-browsing-context.html)
globalThis.__csimCallbackRunnable = function (cb) {
  try {
    const NS = globalThis.RustyRacer;
    if (!cb) return true;
    const id = NS.contextOf(cb);
    if (id == null) return true;
    if (id === NS.contextOf(globalThis)) return true;  // this realm
    if (globalThis.__csimChildRealmIds && globalThis.__csimChildRealmIds.has(id)) return true;
    // …or any realm of the live browsing-context tree — a parent's filter handed to a frame's document — found from the
    // page's realm (context 0) down: a removed frame's realm is in no realm's child set any more
    if (id === 0) return true;
    const queue = [0];
    while (queue.length) {
      const kids = NS.contextGlobal(queue.pop()).__csimChildRealmIds;
      if (!kids) continue;
      if (kids.has(id)) return true;
      kids.forEach((kid) => queue.push(kid));
    }
    return false;
  } catch (_) { return true; }
};

// `requestIdleCallback` / `cancelIdleCallback` — fall back to
// `setTimeout(0)` so libraries that defer expensive setup to idle
// (Turbo Drive prefetch, Stimulus debounced renders) make progress.
// Their identifiers are their own (HTML: the window's idle callback identifier), each naming the task it queued: a
// page's `clearTimeout` reaches no idle callback, nor `cancelIdleCallback` a timer (Chrome: both counts start at 1).
// (The Window's, window.js.)
const idleCallbacks = new Map();
let idleCallbackId = 0;
export function requestIdleCallback(cb) {
  const id = ++idleCallbackId;
  idleCallbacks.set(id, queueTask(() => {
    idleCallbacks.delete(id);
    cb({ didTimeout: false, timeRemaining: () => 0 });
  }));
  return id;
}
export function cancelIdleCallback(id) {
  const task = idleCallbacks.get(id);
  if (task === undefined) return;
  idleCallbacks.delete(id);
  clearTimer(task);
}

// CSSOM types (`CSSStyleSheet` / the `CSSRule` hierarchy / `CSSRuleList` /
// `MediaList` / `CSSStyleDeclaration`) live in cssom.js — a css-tree-backed object
// model — and are registered on globalThis there.


// A MessagePort's message (HTML §9.4.4 "message port post message steps"): StructuredSerializeWithTransfer at post
// time — an uncloneable message (a DOM node, the global, a function, a non-transferred transferable) throws
// DataCloneError synchronously, each listed transferable is MOVED (a port onto a fresh entangled one delivered in
// `ports`, an ArrayBuffer detached) — and the peer receives a distinct clone. The port it is posted through is no
// transferable of its own message. A remote port's goes serialized through the host to the other end of its channel.
function postPortMessage(port, message, transfer) {
  const tf = transferListFrom(transfer);
  if (tf.indexOf(port) !== -1) throw dataCloneError('The source port could not be transferred.');
  if (postRemote(port, message, tf)) return;
  const { data, ports } = tf.length === 0 ? { data: structuredClone(message), ports: [] } : serializeMessageWithTransfer(message, tf);
  const peer = peerOf(port);
  if (peer) acceptMessage(peer, data, ports);
}
installPorts(postPortMessage);


// Release a batch of zero-copy postMessage transfer tokens
// (`RustyRacer.transferOut`). Called from Ruby on `reset!` to free any backing
// store whose token was never imported; `transferDrop` no-ops on an
// already-imported token, so over-dropping is safe.
globalThis.__csimTransferDropAll = function (tokens) {
  const NS = globalThis.RustyRacer;
  if (!tokens) return;
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
export function csimMaybeTransferIn(data) {
  if (!data || typeof data !== 'object' || data.__csimXfer == null) return data;
  const ab = globalThis.RustyRacer.transferIn(data.__csimXfer);
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
      const sender = documentOrigin();
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
    // (…an Event, trusted, at the proxy — at its target while the handlers registered here, this realm's, run)
    __csimFireLoad() {
      const ev = new Event('load');
      ev._isTrusted = true;
      ev._target = ev._currentTarget = proxy;
      ev._eventPhase = 2;
      if (typeof base.onload === 'function') { try { base.onload(ev); } catch (_) {} }
      for (const fn of loadListeners.slice()) { try { fn(ev); } catch (_) {} }
      ev._eventPhase = 0;
      ev._currentTarget = null;
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
// (The Window's, window.js, which converted its arguments: `url` a USVString, `name` the target, '_blank' unsaid.)
export function openWindow(u, name) {
  // Spec: a NON-empty url is parsed against the document base; a parse FAILURE
  // throws a SyntaxError DOMException synchronously — before the host
  // open_aux_window path (which would otherwise drain on a malformed URL).
  // An empty url opens about:blank (no parse).
  if (u !== '') {
    const base = location.href || undefined;
    if (globalThis.__csim_urlIsMalformed(u, base)) {
      throw new globalThis.DOMException(
        "Failed to execute 'open' on 'Window': Unable to open a window with invalid URL '" + u + "'.", 'SyntaxError');
    }
  }
  // Target '_self' targets THIS browsing context (HTML window-open steps via
  // "the rules for choosing a navigable"; keyword match is ASCII
  // case-insensitive): navigate self and return the window's own proxy — no
  // new window. This is also where the 3-argument
  // `document.open(url, name, features)` overload lands.
  if (name.toLowerCase() === '_self') {
    if (u !== '') {
      // A `javascript:` target runs its source in THIS global on a queued
      // task — same model as the anchor-activation sink (dispatch.js) — the
      // location.href setter's host navigation doesn't model the scheme.
      let jsCode = null;
      try {
        const parsed = globalThis.__csim_parseUrl(u, location.href || null);
        if (parsed && !parsed.error && parsed.protocol === 'javascript:') {
          jsCode = globalThis.__csimJavascriptUrlSource(parsed.href);
        }
      } catch (_) { jsCode = null; }
      if (jsCode != null) {
        setTimeout(() => {
          try { (new Function(jsCode))(); }
          catch (e) { try { reportError(e); } catch (_) {} }
        }, 0);
      } else {
        location.href = u;
      }
    }
    return globalThis;
  }
  const fn = globalThis.__csimWindowOpen;
  if (typeof fn !== 'function') return null;
  // Pass the OPENER's realm id so a same-isolate window realm can wire window.opener
  // to a WindowProxy for it (0 = the main realm, a valid opener — distinct from "no
  // opener").
  const callerRealmId = globalThis.RustyRacer.contextOf(globalThis);
  // An about:blank popup's URL is opaque, but its ORIGIN and its BASE URL — what its relative
  // URLs resolve against — are both INHERITED from this document, exactly as an empty
  // <iframe>'s are. Hand them over so the new realm can be seeded with them; without the
  // origin the popup would be cross-origin to its own opener.
  let aboutBase = '', aboutOrigin = '';
  try { aboutBase = (globalThis.document && globalThis.document.baseURI) || ''; } catch (_) {}
  // (…the document's, not `origin`, which a page may have replaced)
  aboutOrigin = documentOrigin();
  // (…`_blank` no name: a new window, never one the host finds by name)
  const handle = fn(u, name.toLowerCase() === '_blank' ? '' : name, callerRealmId, aboutBase, aboutOrigin);
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
}

// `window.opener` — the window that opened this one (or null), resolved from the host each read (window.js keeps
// what a page or the driver sets instead).
export function hostOpener() {
  const fn = globalThis.__csimWindowOpener;
  const handle = typeof fn === 'function' ? fn() : null;
  return handle ? csimWindowProxy(handle) : null;
}

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
    if (to && to !== '*' && to !== documentOrigin()) continue;
    const source = ev && ev.sourceHandle ? csimWindowProxy(ev.sourceHandle) : null;
    dispatchWithOnHandler(globalThis, createMessageEvent('message', {
      data:        csimMaybeTransferIn(ev ? ev.data : undefined),
      origin:      (ev && ev.origin) || '',
      source:      source,
      lastEventId: '',
      ports:       []
    }));
  }
};

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
// A same-realm self-post (`window.postMessage(x)` — the Window's, window.js, which converted the arguments and took
// `targetOrigin` / `transfer` out of the options): serialized (DataCloneError for what cannot be, a transferred
// MessagePort delivered in `event.ports` as its moved counterpart), then the target origin validated (SyntaxError) —
// browsers' order. The targetOrigin gates delivery exactly as it does cross-realm (__csimPostMessageRealm): sender and
// target are the SAME window here, so "*" always delivers, "/" and any explicit origin require it to equal THIS
// window's origin, else the message is silently dropped. And event.origin is this window's own origin (a same-window
// post is same-origin), never ''.
export function postMessageToSelf(message, targetOrigin, transfer) {
  let data, ports;
  if (transfer.length === 0) { data = structuredClone(message); ports = []; }
  else ({ data, ports } = serializeMessageWithTransfer(message, transfer));
  validatePostMessageTargetOrigin(targetOrigin);
  const myOrigin = documentOrigin();
  const to = postMessageTargetOriginOf(targetOrigin);
  if (to !== '*' && myOrigin !== (to === '/' ? myOrigin : originOfTarget(to))) return;
  queueTask(() => {
    try {
      dispatchWithOnHandler(globalThis, createMessageEvent('message', {
        data, origin: myOrigin, source: globalThis, lastEventId: '', ports
      }));
    } catch (_) {}
  }, 0);
}

// Fire `pagehide` then `unload` on THIS window — the document-teardown pair a
// navigating/removed frame dispatches before its realm dies (HTML "unload a
// document"). Self-gates on any handler being present, like beforeunload, so a
// handler-less teardown pays only the property reads. `pagehide.persisted` is
// false (no bfcache model). The primary consumer is `fetch(…, {keepalive})`
// issued from these handlers (the keepalive WPT family) — the eager keepalive
// dispatch runs synchronously inside the handler, before the realm is neutered.
globalThis.__csimFireWindowUnload = function () {
  for (const type of ['pagehide', 'unload']) {
    const list = globalThis._listeners && globalThis._listeners[type];
    if (!list || !list.length) continue;
    dispatchWithOnHandler(globalThis, type === 'pagehide' ? new PageTransitionEvent(type, { persisted: false }) : new Event(type));
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
  if (!kids) return;
  Array.from(kids).forEach((id) => {
    try {
      const w = NS.contextGlobal(id);
      if (w && typeof w.__csimFireWindowUnloadDeep === 'function') w.__csimFireWindowUnloadDeep();
    } catch (_) {}
  });
};

// Fire `beforeunload` on THIS window when it is being navigated away (a frame's
// document is about to be unloaded). Called by the frame-navigation / src-
// reassignment path BEFORE the realm is disposed, IN this realm (so window.event,
// the handler, and a custom toString all see this realm's globals). Gated on a
// listener being present to bound the blast radius (Turbo frame src swaps). The
// handler's value becomes the event's returnValue — coerced to a string while
// `window.event` is still the beforeunload event (the event handler processing
// algorithm, events.js; event-global-is-still-set-when-coercing-beforeunload-result).
globalThis.__csimFireBeforeUnload = function () {
  const list = globalThis._listeners && globalThis._listeners.beforeunload;
  if (!list || !list.length) return;
  dispatchWithOnHandler(globalThis, createBeforeUnloadEvent('beforeunload', true));
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

// URLPattern (the URL Pattern standard) — backed by the reference polyfill in
// the vendor bundle (urlpattern-polyfill; pure subpath import, the bridge owns
// the exposure). Exposed on Window AND worker scopes per the IDL. First
// consumer: the ServiceWorker Static Routing API's `urlPattern` conditions.
{
  const VP = globalThis.__csimVendor && globalThis.__csimVendor.URLPattern;
  if (VP && !globalThis.URLPattern) globalThis.URLPattern = VP;
}
