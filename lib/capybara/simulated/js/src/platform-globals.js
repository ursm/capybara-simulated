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
  // SubtleCrypto — `digest` is the only operation backed by Ruby's
  // OpenSSL. The rest (generateKey / sign / verify / encrypt / decrypt
  // / importKey / exportKey / deriveBits / deriveKey / wrapKey /
  // unwrapKey) return rejected Promises with the spec's
  // `NotSupportedError`. Apps that feature-probe via try/catch on a
  // first call (jose, oidc-client-ts) take their unsupported branch
  // gracefully; apps that immediately use these stay out of scope.
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
    },
    generateKey() { return Promise.reject(notSupported('generateKey')); },
    sign()        { return Promise.reject(notSupported('sign')); },
    verify()      { return Promise.reject(notSupported('verify')); },
    encrypt()     { return Promise.reject(notSupported('encrypt')); },
    decrypt()     { return Promise.reject(notSupported('decrypt')); },
    importKey()   { return Promise.reject(notSupported('importKey')); },
    exportKey()   { return Promise.reject(notSupported('exportKey')); },
    deriveBits()  { return Promise.reject(notSupported('deriveBits')); },
    deriveKey()   { return Promise.reject(notSupported('deriveKey')); },
    wrapKey()     { return Promise.reject(notSupported('wrapKey')); },
    unwrapKey()   { return Promise.reject(notSupported('unwrapKey')); }
  }
};
function notSupported(name) {
  const e = new Error('SubtleCrypto.' + name + ' is not implemented');
  e.name = 'NotSupportedError';
  return e;
}
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
// `mark` / `measure` record entries and notify any active
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

// CSSOM types — `CSSStyleSheet` / `CSSRule` / `CSSRuleList` /
// `CSSStyleDeclaration`. Real layout-driven CSSOM serialization is
// out of scope, but apps that probe `el.style instanceof
// CSSStyleDeclaration` or build constructable stylesheets via
// `new CSSStyleSheet()` need the class identity. We back rules as
// simple objects (selectorText / cssText) and use the array shape
// for `CSSRuleList`.
class CSSStyleDeclaration {
  constructor() {}
}
class CSSRule {
  constructor(selectorText, cssText) {
    this.type = 1;  // CSSRule.STYLE_RULE
    this.cssText = cssText || '';
    this.selectorText = selectorText || '';
    this.style = new CSSStyleDeclaration();
    this.parentStyleSheet = null;
  }
}
CSSRule.STYLE_RULE     = 1;
CSSRule.CHARSET_RULE   = 2;
CSSRule.IMPORT_RULE    = 3;
CSSRule.MEDIA_RULE     = 4;
CSSRule.FONT_FACE_RULE = 5;
CSSRule.PAGE_RULE      = 6;
CSSRule.KEYFRAMES_RULE = 7;
CSSRule.KEYFRAME_RULE  = 8;
class CSSRuleList extends Array {
  item(i) { return this[i] || null; }
}
class CSSStyleSheet {
  constructor(opts) {
    this.cssRules = new CSSRuleList();
    this.ownerNode = null;
    this.disabled = false;
    this.href = (opts && opts.baseURL) || null;
    this.media = (opts && opts.media) || '';
    this.title = '';
  }
  // Constructable stylesheets — Lit / Tailwind in component mode use
  // `new CSSStyleSheet(); sheet.replaceSync(cssText)`. We just store
  // the cssText; no actual layout consumes it but the calls succeed.
  insertRule(rule, index) {
    const i = (index == null ? this.cssRules.length : index) | 0;
    const r = new CSSRule(rule, rule);
    r.parentStyleSheet = this;
    this.cssRules.splice(i, 0, r);
    return i;
  }
  deleteRule(index) { this.cssRules.splice(index | 0, 1); }
  replace(text)     { this.replaceSync(text); return Promise.resolve(this); }
  replaceSync(text) {
    this.cssRules.length = 0;
    if (typeof text === 'string') {
      // Best-effort: split on `}` to get rules; the cssText round-trip
      // is intentionally lossy (no parser here).
      for (const chunk of text.split('}')) {
        const piece = chunk.trim();
        if (!piece) continue;
        const open = piece.indexOf('{');
        if (open < 0) continue;
        this.cssRules.push(new CSSRule(piece.slice(0, open).trim(), piece + '}'));
      }
    }
  }
}
globalThis.CSSStyleDeclaration = CSSStyleDeclaration;
globalThis.CSSRule             = CSSRule;
globalThis.CSSRuleList         = CSSRuleList;
globalThis.CSSStyleSheet       = CSSStyleSheet;

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
      const item = new DataTransferItem('string', type || 'text/plain', data, null);
      this.push(item);
      return item;
    }
    return null;
  }
  clear() { this.length = 0; }
  remove(i) { this.splice(i | 0, 1); }
  // Internal alias for code that pushes directly (bridge.entry.js
  // builds DTILs from synthetic-drop input).
  get _items() { return this; }
}
class DataTransfer {
  constructor() {
    this.items         = new DataTransferItemList();
    this.dropEffect    = 'none';
    this.effectAllowed = 'all';
    this.types         = [];
    this.files         = [];
  }
  getData(type) {
    for (const it of this.items._items) if (it.kind === 'string' && it.type === type) return it._value;
    return '';
  }
  setData(type, value) {
    this.items.add(String(value), String(type));
    if (!this.types.includes(type)) this.types.push(type);
  }
  clearData(type) {
    if (type) {
      this.items._items = this.items._items.filter(it => it.type !== type);
      this.types = this.types.filter(t => t !== type);
    } else {
      this.items.clear();
      this.types = [];
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
class MessagePort {
  constructor() {
    this._peer = null;
    this._listeners = [];
    this.onmessage     = null;
    this.onmessageerror = null;
    this._started = false;
  }
  postMessage(data, _transfer) {
    const peer = this._peer;
    if (!peer) return;
    // Deferred via microtask so the call site can attach its
    // listener before the message lands — matches real MessagePort
    // delivery (no synchronous re-entrance).
    Promise.resolve().then(() => {
      if (!peer._started && typeof peer.onmessage !== 'function' && peer._listeners.length === 0) return;
      const ev = {type: 'message', data, target: peer, currentTarget: peer, ports: [], origin: '', lastEventId: '', source: null};
      if (typeof peer.onmessage === 'function') {
        try { peer.onmessage.call(peer, ev); } catch (_) {}
      }
      for (const h of peer._listeners.slice()) try { h.call(peer, ev); } catch (_) {}
    });
  }
  addEventListener(type, handler) {
    if (typeof handler !== 'function') return;
    if (type === 'message') {
      this._listeners.push(handler);
      this._started = true;
    }
  }
  removeEventListener(type, handler) {
    if (type !== 'message') return;
    this._listeners = this._listeners.filter(h => h !== handler);
  }
  start() { this._started = true; }
  close() { this._listeners = []; this._peer = null; }
  dispatchEvent() { return true; }
}
class MessageChannel {
  constructor() {
    this.port1 = new MessagePort();
    this.port2 = new MessagePort();
    this.port1._peer = this.port2;
    this.port2._peer = this.port1;
  }
}
globalThis.MessageChannel = MessageChannel;
globalThis.MessagePort    = MessagePort;

// BroadcastChannel — multi-tab same-origin pub/sub. Mastodon's
// across-tab sync, Discourse's `MessageBus` fall-back. Single-window
// runtime so messages don't actually traverse tabs, but the API
// shape is needed so apps that always construct one don't crash.
const _bcChannels = new Map();
class BroadcastChannel {
  constructor(name) {
    this.name = String(name);
    this._listeners = [];
    this.onmessage      = null;
    this.onmessageerror = null;
    const set = _bcChannels.get(this.name) || new Set();
    set.add(this);
    _bcChannels.set(this.name, set);
  }
  postMessage(data) {
    const set = _bcChannels.get(this.name);
    if (!set) return;
    Promise.resolve().then(() => {
      for (const ch of set) {
        if (ch === this) continue;
        const ev = {type: 'message', data, target: ch, currentTarget: ch, origin: '', lastEventId: '', source: null, ports: []};
        if (typeof ch.onmessage === 'function') { try { ch.onmessage.call(ch, ev); } catch (_) {} }
        for (const h of ch._listeners.slice()) { try { h.call(ch, ev); } catch (_) {} }
      }
    });
  }
  close() {
    const set = _bcChannels.get(this.name);
    if (set) { set.delete(this); if (set.size === 0) _bcChannels.delete(this.name); }
  }
  addEventListener(type, handler) {
    if (type === 'message' && typeof handler === 'function') this._listeners.push(handler);
  }
  removeEventListener(type, handler) {
    if (type !== 'message') return;
    this._listeners = this._listeners.filter(h => h !== handler);
  }
  dispatchEvent() { return true; }
}
globalThis.BroadcastChannel = BroadcastChannel;

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
