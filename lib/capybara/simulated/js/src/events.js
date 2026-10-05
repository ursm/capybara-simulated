// DOM event constructors. Capture / target / bubble dispatch lives
// in bridge.entry.js; this module just defines the value types.

import { HTML_NS } from './constants.js';
import { normalizeDataFormat } from './mime.js';
import { documentElementOf } from './document-tree.js';
import { brandPrototype, defineClassString, registerInterface } from './webidl.js';
import {
  WINDOW_EVENT_HANDLERS, convertCustomEventArguments, convertEventArguments, installCustomEvent, installEvent, installEventTarget
} from './generated/bindings.js';

// Unwrap a cross-realm WindowProxy to its raw global (no-op for everything else),
// so EventTarget methods invoked through a proxy operate on the real window.
function unwrapWin(o) {
  return globalThis.__csimUnwrapWindow ? globalThis.__csimUnwrapWindow(o) : o;
}
// WebIDL USVString coercion (ToString, then unpaired surrogates → U+FFFD). Used by the
// event types whose IDL declares a USVString member (StorageEvent.url, …).
function toUSVString(v) {
  return globalThis.__csimToUSVString ? globalThis.__csimToUSVString(v) : String(v);
}
// Map any window global in a composedPath result to the active-listener realm's
// WindowProxy, so a cross-realm listener sees `composedPath()` entries === its own
// `contentWindow`/`parent` (shadow event-dispatch/test-003).
function retargetWindowsInPath(path) {
  // Single-realm pages can't have a cross-realm window to retarget — skip the
  // per-element native-crossing scan entirely (rule 3).
  if (!globalThis.__csimMultiRealm || !globalThis.__csimMultiRealm()) return path;
  if (!globalThis.__csimRetargetWindow || !globalThis.__csimIsWindowGlobal) return path;
  for (let i = 0; i < path.length; i++) {
    if (globalThis.__csimIsWindowGlobal(path[i])) path[i] = globalThis.__csimRetargetWindow(path[i]);
  }
  return path;
}

// https://dom.spec.whatwg.org/#default-passive-value — a listener for one of
// these event types defaults to passive (preventDefault becomes a no-op) when
// registered on the Window, the Document, the documentElement, or the body and
// the `passive` option is omitted. Explicit `{passive: …}` always wins.
export const PASSIVE_DEFAULT_EVENTS = new Set(['touchstart', 'touchmove', 'wheel', 'mousewheel']);
export function defaultPassiveValue(type, target) {
  if (!PASSIVE_DEFAULT_EVENTS.has(type)) return false;
  if (target === globalThis) return true;                       // Window
  const nt = target && target._nodeType;
  if (nt === 9) return true;                                    // Document
  if (nt === 1 && target.ownerDocument) {                       // documentElement / body
    const doc = target.ownerDocument;
    if (target === documentElementOf(doc) || target._tag === 'body') return true;
  }
  return false;
}

// Spec "inner invoke": a `once` listener is removed *before* its callback runs.
// Set `removed` so an in-flight dispatch's `list.slice()` snapshot skips the
// still-referenced entry (keeping a self-re-dispatching `once` callback from
// re-entering itself), and splice it out of the live array so the stored list
// doesn't accumulate fired one-shots. Shared by the Node and window dispatch
// loops so the removal semantics can't drift between them.
export function removeOnceListener(entry, listArr, type) {
  entry.removed = true;
  noteListener(type, -1);
  if (listArr) {
    const i = listArr.indexOf(entry);
    if (i !== -1) listArr.splice(i, 1);
  }
}

// The Event interface (DOM §2.2): its state the internal fields below, which the dispatch writes; its members
// generated from its IDL (`installEvent`, after the class), `isTrusted` — [LegacyUnforgeable] — each event's own.
// (…a subclass of ours hands its converted arguments over with CONVERTED, as its own constructor converted them; a
// page's subclass, or `new Event(…)`, has them converted here)
export const CONVERTED = Symbol('converted');
export class Event {
  constructor(type, init) {
    if (type !== CONVERTED) [type, init] = convertEventArguments(arguments);
    else [type, init] = [init, arguments[2]];
    this._type        = type;
    this._bubbles     = init.bubbles;
    this._cancelable  = init.cancelable;
    this._composed    = init.composed;
    this._canceled    = false;
    this._target      = null;
    this._currentTarget = null;
    this._eventPhase  = 0;
    this._isTrusted   = false;
    this._propagationStopped          = false;
    this._immediatePropagationStopped = false;
    // DOM "initialized flag": a constructed event is initialized; one made via
    // `document.createEvent` is NOT until `initEvent` runs. `_dispatchFlag`
    // guards against re-dispatching an event that's mid-flight. Both gate
    // `dispatchEvent` (InvalidStateError).
    this._initialized  = true;
    this._dispatchFlag = false;
    // Capture timeStamp EAGERLY at construction (the event's time origin per
    // spec) rather than lazily at first read — a lazily-read timestamp is taken
    // AFTER the event was created, which breaks `before <= e.timeStamp <= after`
    // when the reader brackets construction with performance.now() (WPT
    // Event-timestamp-high-resolution).
    this._ts = globalThis.__csimPerformance.now();
    defineEventUnforgeables(this);
  }
}
function composedPathOf(ev) {
  // Outside dispatch the event's path is empty, so composedPath() is the
  // empty list (the dispatch algorithm empties it on cleanup). Library
  // probes read it from within a listener, where the flag is set.
  if (!ev._dispatchFlag) return [];
  // (…a flat dispatch's path its one invocation target — the window's for its `load`, whose target is the document)
  if (ev._csimFlatTarget) return retargetWindowsInPath([ev._csimFlatTarget]);
  const structs = ev._csimPath;
  if (!structs) {
    // FAST PATH (no shadow trees): the flattened tree is the node tree, so
    // composedPath is just the target -> root `_parent` walk plus the window
    // the dispatch went on to (dispatch.js `pathWindow`: none for an inert
    // document's or a `load`). No retargeting, no per-listener trimming.
    const full = [];
    for (let n = ev._target; n; n = n._parent) full.push(n);
    if (ev._csimPathWindow) full.push(ev._csimPathWindow);
    return retargetWindowsInPath(full);
  }
  // Shadow case: trim the precomputed event path to what `currentTarget` may
  // observe, per the DOM composedPath algorithm
  // (https://dom.spec.whatwg.org/#dom-event-composedpath) using the
  // root-of-closed-tree / slot-in-closed-tree flags carried on each struct.
  const ct = ev._currentTarget;
  let currentTargetIndex = -1;
  let level = 0;
  let index = structs.length - 1;
  while (index >= 0) {
    if (structs[index].rootClosed) level++;
    if (structs[index].node === ct) { currentTargetIndex = index; break; }
    if (structs[index].slotClosed) level--;
    index--;
  }
  // currentTarget isn't on the recorded path (e.g. a window listener whose
  // window was never appended because the event didn't reach the document, or
  // a delegated handler that reassigned currentTarget). Per the dispatch model
  // such a listener sees the whole path it observed — return every node
  // untrimmed rather than emit a malformed (window-led) list.
  if (currentTargetIndex === -1) return retargetWindowsInPath(structs.map((s) => s.node));
  const composed = [ct];
  let current = level, max = level;
  for (index = currentTargetIndex - 1; index >= 0; index--) {
    if (structs[index].rootClosed) current++;
    if (current <= max) composed.unshift(structs[index].node);
    if (structs[index].slotClosed) { current--; if (current < max) max = current; }
  }
  current = level; max = level;
  for (index = currentTargetIndex + 1; index < structs.length; index++) {
    if (structs[index].slotClosed) current++;
    if (current <= max) composed.push(structs[index].node);
    if (structs[index].rootClosed) { current--; if (current < max) max = current; }
  }
  return retargetWindowsInPath(composed);
}
// What tells an event apart, for a conversion to one (`dispatchEvent`'s argument): Event.prototype behind it — any
// realm's, which brands itself: an iframe's event dispatched here is one.
const EVENT = brandPrototype(Event, 'Event');
registerInterface('Event', (o) => o !== null && typeof o === 'object' && o[EVENT] === true);
// Event's members (generated/bindings.js): its state's — `currentTarget` a prototype getter a page may shadow on an
// event (selector-set / Rails-UJS-style delegation: `Object.defineProperty(event, 'currentTarget', {get: …})`, which
// Mastodon's `data-method` handler reads) — and its steps.
// (…its class string a data property, so each subclass of ours has its own: a page's subclass reports `Event`)
const defineEventUnforgeables = installEvent(Event, {
  get_type: (ev) => ev._type,
  get_target: (ev) => ev._target,
  get_srcElement: (ev) => ev._target,
  get_currentTarget: (ev) => ev._currentTarget,
  composedPath: (ev) => composedPathOf(ev),
  get_eventPhase: (ev) => ev._eventPhase,
  stopPropagation(ev) { ev._propagationStopped = true; },
  // Legacy `cancelBubble`: the stop-propagation flag; setting it true stops propagation, false does nothing.
  get_cancelBubble: (ev) => ev._propagationStopped,
  set_cancelBubble(ev, value) { if (value) ev._propagationStopped = true; },
  stopImmediatePropagation(ev) { ev._propagationStopped = true; ev._immediatePropagationStopped = true; },
  get_bubbles: (ev) => ev._bubbles,
  get_cancelable: (ev) => ev._cancelable,
  // Legacy `returnValue`: whether the default action is still allowed; false cancels it, true does nothing.
  get_returnValue: (ev) => !ev._canceled,
  set_returnValue(ev, value) { if (!value) cancelEvent(ev); },
  preventDefault(ev) { cancelEvent(ev); },
  get_defaultPrevented: (ev) => ev._canceled,
  get_composed: (ev) => ev._composed,
  get_timeStamp: (ev) => ev._ts,
  // Legacy `initEvent` (for an event `document.createEvent` made): nothing mid-dispatch; else initialized, its flags,
  // its target cleared, and the three attributes.
  initEvent(ev, type, bubbles, cancelable) {
    if (!ev._dispatchFlag) initEventSteps(ev, type, bubbles, cancelable);
  },
  get_isTrusted: (ev) => ev._isTrusted
});
// DOM "initialize" an event: initialized, its flags and target cleared, its type and two attributes `type`'s.
function initEventSteps(ev, type, bubbles, cancelable) {
  ev._initialized = true;
  ev._propagationStopped = false;
  ev._immediatePropagationStopped = false;
  ev._canceled = false;
  ev._isTrusted = false;
  ev._target = null;
  ev._type = type;
  ev._bubbles = bubbles;
  ev._cancelable = cancelable;
}
// DOM "set the canceled flag": a cancelable event's, unless a passive listener is the one asking.
export function cancelEvent(ev) {
  if (ev._cancelable && !ev._inPassiveListener) ev._canceled = true;
}

// Minimal WebIDL DOMException — browsers expose it; core-js's
// DOMException polyfill (Mastodon's `polyfills` chunk) reads
// `globalThis.DOMException.prototype` at module-init time and dies
// with "Cannot read properties of undefined" without it.
// Legacy numeric codes per https://webidl.spec.whatwg.org/#idl-DOMException.
const DOMEXC_BRAND = Symbol('DOMException');

export class DOMException extends Error {
  constructor(message = '', name = 'Error') {
    super(message);
    // `name`/`code` are exposed as branded getter-only accessors on the prototype
    // (below), so a plain `this.name = …` would hit the inherited accessor and
    // throw in strict mode; define the per-instance own data props directly.
    Object.defineProperty(this, 'name', { value: String(name), writable: true, enumerable: true, configurable: true });
    Object.defineProperty(this, 'code', { value: DOMException._codeFor(name), writable: true, enumerable: true, configurable: true });
    Object.defineProperty(this, DOMEXC_BRAND, { value: true });
  }
  static _codeFor(name) {
    return ({
      IndexSizeError:              1,  HierarchyRequestError:    3,
      WrongDocumentError:          4,  InvalidCharacterError:    5,
      NoModificationAllowedError:  7,  NotFoundError:            8,
      NotSupportedError:           9,  InUseAttributeError:     10,
      InvalidStateError:          11,  SyntaxError:             12,
      InvalidModificationError:   13,  NamespaceError:          14,
      InvalidAccessError:         15,  TypeMismatchError:       17,
      SecurityError:              18,  NetworkError:            19,
      AbortError:                 20,  URLMismatchError:        21,
      QuotaExceededError:         22,  TimeoutError:            23,
      InvalidNodeTypeError:       24,  DataCloneError:          25
    })[name] || 0;
  }
}
Object.entries({
  INDEX_SIZE_ERR: 1,            DOMSTRING_SIZE_ERR: 2,
  HIERARCHY_REQUEST_ERR: 3,     WRONG_DOCUMENT_ERR: 4,
  INVALID_CHARACTER_ERR: 5,     NO_DATA_ALLOWED_ERR: 6,
  NO_MODIFICATION_ALLOWED_ERR: 7, NOT_FOUND_ERR: 8,
  NOT_SUPPORTED_ERR: 9,         INUSE_ATTRIBUTE_ERR: 10,
  INVALID_STATE_ERR: 11,        SYNTAX_ERR: 12,
  INVALID_MODIFICATION_ERR: 13, NAMESPACE_ERR: 14,
  INVALID_ACCESS_ERR: 15,       VALIDATION_ERR: 16,
  TYPE_MISMATCH_ERR: 17,        SECURITY_ERR: 18,
  NETWORK_ERR: 19,              ABORT_ERR: 20,
  URL_MISMATCH_ERR: 21,         QUOTA_EXCEEDED_ERR: 22,
  TIMEOUT_ERR: 23,              INVALID_NODE_TYPE_ERR: 24,
  DATA_CLONE_ERR: 25
}).forEach(([k, v]) => {
  Object.defineProperty(DOMException,           k, { value: v, enumerable: true });
  Object.defineProperty(DOMException.prototype, k, { value: v, enumerable: true });
});

// WebIDL exposes `message`/`name`/`code` as branded accessors on the interface
// prototype object: reading them off the bare `DOMException.prototype` (or any
// non-branded object) throws a TypeError ("Illegal invocation"). Real instances
// carry their own data props (set in the constructor, and by Error for `message`),
// which shadow these getters — so the throw only bites the bare prototype. That
// is what `new URLSearchParams(DOMException.prototype)` relies on: the record
// conversion reads each own-enumerable key and the branded getter aborts it.
for (const attr of ['message', 'name', 'code']) {
  Object.defineProperty(DOMException.prototype, attr, {
    get() {
      if (!this || !this[DOMEXC_BRAND]) {
        throw new TypeError('Illegal invocation');
      }
      // Reached only for a branded object lacking the own data prop (none in
      // practice — instances always carry their own); return the IDL default
      // (DOMException.name defaults to 'Error', message to '', code to 0).
      return attr === 'code' ? 0 : (attr === 'name' ? 'Error' : '');
    },
    enumerable:   true,
    configurable: true
  });
}

// QuotaExceededError — a DOMException subclass (name/code 22 inherited) carrying the storage/quota
// spec's nullable `quota` + `requested` doubles. WPT's assert_throws_quotaexceedederror checks that
// a thrown QuotaExceededError has `requested === null` (and `quota === null`) when unspecified, so
// these must be present-and-null, not undefined.
export class QuotaExceededError extends DOMException {
  constructor(message = '', options = {}) {
    super(message, 'QuotaExceededError');
    const q = options && options.quota;
    const r = options && options.requested;
    this._quota     = typeof q === 'number' ? q : null;
    this._requested = typeof r === 'number' ? r : null;
  }

  get quota()     { return this._quota; }
  get requested() { return this._requested; }
}

// CustomEvent (DOM §2.4): its `detail`, and the legacy `initCustomEvent` (Trix's `document.createEvent('CustomEvent')`).
export class CustomEvent extends Event {
  constructor(type, init) {
    if (type !== CONVERTED) [type, init] = convertCustomEventArguments(arguments);
    else [type, init] = [init, arguments[2]];
    super(CONVERTED, type, init);
    this._detail = init.detail;
  }
}
const CUSTOM_EVENT = brandPrototype(CustomEvent, 'CustomEvent');
registerInterface('CustomEvent', (o) => o !== null && typeof o === 'object' && o[CUSTOM_EVENT] === true);
installCustomEvent(CustomEvent, {
  get_detail: (ev) => ev._detail,
  // (…nothing mid-dispatch; else the event's initialisation, then its detail)
  initCustomEvent(ev, type, bubbles, cancelable, detail) {
    if (ev._dispatchFlag) return;
    initEventSteps(ev, type, bubbles, cancelable);
    ev._detail = detail;
  }
});

// UIEvent — base for any event with a `view` (window) + `detail`
// (click count, wheel delta). Spec parent of MouseEvent / KeyboardEvent /
// FocusEvent / WheelEvent / CompositionEvent / InputEvent.
export class UIEvent extends Event {
  static { defineClassString(this.prototype, 'UIEvent'); }
  constructor(type, init) {
    super(type, init);
    init = init || {};
    // `view` is WebIDL `Window?` — defaults to null (a constructed event
    // is not bound to a window unless one is passed), and a non-null
    // non-object value is a TypeError per the IDL conversion.
    let view = null;
    if (init.view != null) {
      const t = typeof init.view;
      if (t !== 'object' && t !== 'function') {
        throw new TypeError("Failed to construct 'UIEvent': member view is not of type Window.");
      }
      view = init.view;
    }
    this.view   = view;
    this.detail = init.detail || 0;
  }
  // Legacy initialiser; no-op while dispatching (dispatch flag set).
  initUIEvent(type, bubbles, cancelable, view, detail) {
    if (this._dispatchFlag) return;
    initEventSteps(this, String(type), !!bubbles, !!cancelable);
    this.view   = view != null ? view : null;
    this.detail = detail || 0;
  }
}

export class FocusEvent extends UIEvent {
  static { defineClassString(this.prototype, 'FocusEvent'); }
  constructor(type, init) {
    super(type, init);
    this.relatedTarget = (init && init.relatedTarget) || null;
  }
}

export class CompositionEvent extends UIEvent {
  static { defineClassString(this.prototype, 'CompositionEvent'); }
  constructor(type, init) {
    super(type, init);
    this.data = init && init.data != null ? String(init.data) : '';
  }
}

// Legacy `TextEvent` (UIEvent subtype) — kept distinct from CompositionEvent so
// `document.createEvent("TextEvent")` reports the right interface.
export class TextEvent extends UIEvent {
  static { defineClassString(this.prototype, 'TextEvent'); }
  constructor(type, init) {
    super(type, init);
    this.data = init && init.data != null ? String(init.data) : '';
  }
}

// Device sensor events — minimal interfaces so `document.createEvent(…)` and
// feature-detection (`"DeviceMotionEvent" in window`) see the right type. No
// real sensor data (no layout/hardware backend).
export class DeviceMotionEvent extends Event {
  static { defineClassString(this.prototype, 'DeviceMotionEvent'); }
  constructor(type, init) {
    super(type, init);
    init = init || {};
    this.acceleration = init.acceleration || null;
    this.accelerationIncludingGravity = init.accelerationIncludingGravity || null;
    this.rotationRate = init.rotationRate || null;
    this.interval = init.interval || 0;
  }
}
export class DeviceOrientationEvent extends Event {
  static { defineClassString(this.prototype, 'DeviceOrientationEvent'); }
  constructor(type, init) {
    super(type, init);
    init = init || {};
    this.alpha = init.alpha != null ? init.alpha : null;
    this.beta  = init.beta  != null ? init.beta  : null;
    this.gamma = init.gamma != null ? init.gamma : null;
    this.absolute = !!init.absolute;
  }
}


export class TouchEvent extends UIEvent {
  static { defineClassString(this.prototype, 'TouchEvent'); }
  constructor(type, init) {
    super(type, init);
    init = init || {};
    this.touches        = init.touches        || [];
    this.targetTouches  = init.targetTouches  || [];
    this.changedTouches = init.changedTouches || [];
    this.altKey   = !!init.altKey;
    this.ctrlKey  = !!init.ctrlKey;
    this.metaKey  = !!init.metaKey;
    this.shiftKey = !!init.shiftKey;
  }
}

// Progress / lifecycle events. All commonly constructed by libraries
// (`new ProgressEvent('progress', {loaded, total})` is the XHR wrapper
// pattern; `new PopStateEvent` and `new HashChangeEvent` are how Turbo
// and history-API polyfills synthesize navigation events).
const PROGRESS_BRAND = Symbol('ProgressEvent');

export class ProgressEvent extends Event {
  static { defineClassString(this.prototype, 'ProgressEvent'); }
  // `init` is optional (WebIDL) — the default keeps the constructor's `length` at 1
  // (progressevent-interface). `lengthComputable`/`loaded`/`total` are exposed as
  // branded getter-only accessors on the prototype (below), so a plain `this.x = …`
  // would hit the inherited setter-less accessor and throw in strict mode; define the
  // per-instance own data props directly (they shadow the getters).
  constructor(type, init = {}) {
    super(type, init);
    // readonly WebIDL attributes — own data props (non-writable) that shadow the
    // branded prototype getters below; a stray `pe.loaded = …` is a no-op as in browsers.
    Object.defineProperty(this, 'lengthComputable', { value: !!init.lengthComputable, enumerable: true, configurable: true });
    Object.defineProperty(this, 'loaded', { value: Number(init.loaded) || 0, enumerable: true, configurable: true });
    Object.defineProperty(this, 'total',  { value: Number(init.total)  || 0, enumerable: true, configurable: true });
    Object.defineProperty(this, PROGRESS_BRAND, { value: true });
  }
}
// WebIDL branded accessors on the interface prototype: reading them off the bare
// `ProgressEvent.prototype` (no brand) throws a TypeError; real instances carry their
// own data props (above) which shadow these. Enumerable + configurable per WebIDL.
for (const attr of ['lengthComputable', 'loaded', 'total']) {
  Object.defineProperty(ProgressEvent.prototype, attr, {
    get() {
      if (!this || !this[PROGRESS_BRAND]) throw new TypeError('Illegal invocation');
      return attr === 'lengthComputable' ? false : 0;   // branded-but-own-prop-less default
    },
    enumerable:   true,
    configurable: true
  });
}

export class PopStateEvent extends Event {
  static { defineClassString(this.prototype, 'PopStateEvent'); }
  constructor(type, init) {
    super(type, init);
    this.state = init && 'state' in init ? init.state : null;
  }
}

export class HashChangeEvent extends Event {
  static { defineClassString(this.prototype, 'HashChangeEvent'); }
  constructor(type, init) {
    super(type, init);
    init = init || {};
    this.oldURL = init.oldURL || '';
    this.newURL = init.newURL || '';
  }
}

export class StorageEvent extends Event {
  static { defineClassString(this.prototype, 'StorageEvent'); }
  // `init` is optional (StorageEventInit has all-defaulted members), so the interface
  // object's length is 1 and `new StorageEvent()` (no type) is a TypeError.
  constructor(type, init = {}) {
    if (arguments.length < 1) throw new globalThis.TypeError("Failed to construct 'StorageEvent': 1 argument required, but only 0 present.");
    super(type, init);
    init = init || {};
    this.key         = init.key == null         ? null : String(init.key);
    this.oldValue    = init.oldValue == null    ? null : String(init.oldValue);
    this.newValue    = init.newValue == null    ? null : String(init.newValue);
    // `url` is a USVString with default "" — an ABSENT member (missing, or explicitly
    // `undefined`, which WebIDL treats as absent) → ""; an explicit `null` is present
    // and coerces (USVString(null) === "null"). So test `!== undefined`, not `== null`.
    this.url         = init.url !== undefined ? toUSVString(init.url) : '';
    this.storageArea = init.storageArea || null;
  }
  // Legacy initialiser (`document.createEvent('StorageEvent')` → initStorageEvent).
  // The trailing members are optional with spec defaults, so `.length` is 1; a call
  // while the event is mid-dispatch is a no-op.
  initStorageEvent(type, bubbles = false, cancelable = false, key = null, oldValue = null, newValue = null, url = '', storageArea = null) {
    if (arguments.length < 1) throw new globalThis.TypeError("Failed to execute 'initStorageEvent' on 'StorageEvent': 1 argument required, but only 0 present.");
    if (this._dispatchFlag) return;
    initEventSteps(this, String(type), !!bubbles, !!cancelable);
    this.key         = key === null ? null : String(key);
    this.oldValue    = oldValue === null ? null : String(oldValue);
    this.newValue    = newValue === null ? null : String(newValue);
    this.url         = toUSVString(url);   // default '' → ''; explicit null → "null"
    this.storageArea = storageArea;
  }
}

export class ErrorEvent extends Event {
  static { defineClassString(this.prototype, 'ErrorEvent'); }
  constructor(type, init) {
    super(type, init);
    init = init || {};
    this.message  = init.message  || '';
    this.filename = init.filename || '';
    this.lineno   = init.lineno   || 0;
    this.colno    = init.colno    || 0;
    // `error` is `any` with no IDL default → `undefined` when unset (NOT null), and an
    // explicit `undefined` stays undefined (event-handler-processing "error member can
    // be set to undefined"; synthetic-errorevent "Initial values").
    this.error    = init.error;
  }
}
const ERROR_EVENT = brandPrototype(ErrorEvent, 'ErrorEvent');   // (…an event of any realm, as the event handler processing algorithm asks)

export class PromiseRejectionEvent extends Event {
  static { defineClassString(this.prototype, 'PromiseRejectionEvent'); }
  constructor(type, init) {
    super(type, init);
    init = init || {};
    this.promise = init.promise || null;
    this.reason  = init.reason;
  }
}

// CloseEvent — the `close` event fired at a WebSocket. `code` is an unsigned short (ToUint16),
// `reason` a USVString, `wasClean` a boolean; all default to 0 / '' / false when absent. They are
// readonly IDL attributes → prototype getters over internal slots (so `e.wasClean = true` is a
// no-op and `delete CloseEvent.prototype.wasClean` makes `e.wasClean` undefined — close-basic).
export class CloseEvent extends Event {
  static { defineClassString(this.prototype, 'CloseEvent'); }
  constructor(type, init) {
    super(type, init);
    init = init || {};
    this._wasClean = !!init.wasClean;
    this._code     = init.code == null ? 0 : (init.code & 0xffff);
    this._reason   = init.reason == null ? '' : String(init.reason);
  }

  get wasClean() { return this._wasClean; }
  get code()     { return this._code; }
  get reason()   { return this._reason; }
}

// The three animation events share one shape: a required `type`, and readonly attributes. A WebIDL
// attribute is an accessor on the INTERFACE PROTOTYPE, not an own property of the instance —
// `assert_idl_attribute` looks for it in the prototype chain and an own data prop fails that, which
// is what `animationevent-types.html` asserts. So the values go in `_`-prefixed slots and the
// prototype carries the getters (the shape `CloseEvent` already uses above).
function defineReadonly(target, values) {
  for (const key of Object.keys(values)) {
    Object.defineProperty(target, '_' + key, { value: values[key], writable: true, configurable: true });
  }
}
function defineIdlAttributes(cls, names) {
  for (const name of names) {
    Object.defineProperty(cls.prototype, name, {
      get() { return this['_' + name]; },
      enumerable: true,
      configurable: true
    });
  }
}
// A WebIDL `DOMString` takes `null` as the four characters "null" — the dictionary member is not
// nullable, so the conversion runs on whatever was passed.
const idlString = (v, dflt) => (v === undefined ? dflt : String(v));
// …and a `double` REJECTS NaN and Infinity (WebIDL "unrestricted double" would take them; these
// members are plain doubles), which is a TypeError at conversion time.
function idlDouble(v, dflt, iface, member) {
  if (v === undefined) return dflt;
  const n = Number(v);
  if (!Number.isFinite(n)) {
    throw new globalThis.TypeError(
      `Failed to construct '${iface}': The provided double value for '${member}' is non-finite.`);
  }
  return n;
}

export class AnimationEvent extends Event {
  static { defineClassString(this.prototype, 'AnimationEvent'); }
  constructor(type, init) {
    // The base class checks ITS argument count, and a subclass always hands it two — so the
    // required-`type` check has to be made here, or `new AnimationEvent()` constructs happily.
    if (arguments.length < 1) {
      throw new globalThis.TypeError("Failed to construct 'AnimationEvent': 1 argument required, but only 0 present.");
    }
    super(type, init);
    init = init || {};
    defineReadonly(this, {
      animationName: idlString(init.animationName, ''),
      elapsedTime:   idlDouble(init.elapsedTime, 0, 'AnimationEvent', 'elapsedTime'),
      pseudoElement: idlString(init.pseudoElement, ''),
      // css-animations-2: the `CSSAnimation` this event is about, so a listener can reach the
      // object without going back through `getAnimations()`.
      animation:     init.animation === undefined ? null : init.animation
    });
  }
}

// web-animations §AnimationPlaybackEvent — what `finish` and `cancel` deliver, carrying the two
// times the listener needs to know WHERE the animation was when it fired.
export class AnimationPlaybackEvent extends Event {
  static { defineClassString(this.prototype, 'AnimationPlaybackEvent'); }
  constructor(type, init) {
    // The base class checks ITS argument count, and a subclass always hands it two — so the
    // required-`type` check has to be made here, or `new AnimationPlaybackEvent()` constructs happily.
    if (arguments.length < 1) {
      throw new globalThis.TypeError("Failed to construct 'AnimationPlaybackEvent': 1 argument required, but only 0 present.");
    }
    super(type, init);
    init = init || {};
    defineReadonly(this, {
      currentTime:  init.currentTime  === undefined ? null : init.currentTime,
      timelineTime: init.timelineTime === undefined ? null : init.timelineTime
    });
  }
}

// How many listeners the realm has for each CSS animation and transition event — an event handler attribute or property
// among them, which registers one: an event of a type nothing listens for anywhere carries no object, and making one
// for each of a thousand transitions a page starts at once is what it would cost.
const ANIMATION_EVENT_TYPES = new Set([
  'animationstart', 'animationiteration', 'animationend', 'animationcancel',
  'transitionrun', 'transitionstart', 'transitionend', 'transitioncancel'
]);
const ANIMATION_LISTENERS = new Map();
export function listensForAnimationEvent(type) {
  return (ANIMATION_LISTENERS.get(type) || 0) > 0;
}
// …kept by every `addEventListener` / `removeEventListener` there is (a node's and any other event target's), and by
// every `once` listener a dispatch takes.
export function noteListener(type, delta) {
  if (ANIMATION_EVENT_TYPES.has(type)) ANIMATION_LISTENERS.set(type, (ANIMATION_LISTENERS.get(type) || 0) + delta);
}

export class TransitionEvent extends Event {
  static { defineClassString(this.prototype, 'TransitionEvent'); }
  constructor(type, init) {
    // The base class checks ITS argument count, and a subclass always hands it two — so the
    // required-`type` check has to be made here, or `new TransitionEvent()` constructs happily.
    if (arguments.length < 1) {
      throw new globalThis.TypeError("Failed to construct 'TransitionEvent': 1 argument required, but only 0 present.");
    }
    super(type, init);
    init = init || {};
    defineReadonly(this, {
      propertyName:  idlString(init.propertyName, ''),
      elapsedTime:   idlDouble(init.elapsedTime, 0, 'TransitionEvent', 'elapsedTime'),
      pseudoElement: idlString(init.pseudoElement, ''),
      animation:     init.animation === undefined ? null : init.animation     // css-transitions-2
    });
  }
}

defineIdlAttributes(AnimationEvent, ['animationName', 'elapsedTime', 'pseudoElement', 'animation']);
defineIdlAttributes(AnimationPlaybackEvent, ['currentTime', 'timelineTime']);
defineIdlAttributes(TransitionEvent, ['propertyName', 'elapsedTime', 'pseudoElement', 'animation']);

export class FormDataEvent extends Event {
  static { defineClassString(this.prototype, 'FormDataEvent'); }
  constructor(type, init) {
    // WebIDL: `type` is required and `formData` is a required FormData dict member —
    // a missing/null dict or a non-FormData formData is a TypeError (FormDataEvent
    // "Failing constructor"). Called without `new` already throws (ES class).
    if (arguments.length < 1)
      throw new TypeError("Failed to construct 'FormDataEvent': 1 argument required, but only 0 present.");
    if (init == null || !(init.formData instanceof globalThis.FormData))
      throw new TypeError("Failed to construct 'FormDataEvent': member formData is required and must be a FormData.");
    super(type, init);
    this.formData = init.formData;
  }
}

export class BeforeUnloadEvent extends Event {
  static { defineClassString(this.prototype, 'BeforeUnloadEvent'); }
  constructor(type, init) {
    super(type, init);
    // `BeforeUnloadEvent.returnValue` is a DOMString (the legacy unload-prompt
    // text), distinct from Event's boolean `returnValue` alias. An OWN accessor
    // shadows the inherited one and coerces on assignment per WebIDL (so
    // `returnValue = 123` stores "123"); the Event prototype setter would
    // otherwise swallow the assignment.
    let rv = (init && init.returnValue != null) ? String(init.returnValue) : '';
    Object.defineProperty(this, 'returnValue', {
      enumerable: true, configurable: true,
      get() { return rv; },
      set(v) { rv = (v == null ? '' : String(v)); },
    });
  }
}
const BEFORE_UNLOAD_EVENT = brandPrototype(BeforeUnloadEvent, 'BeforeUnloadEvent');

export class GamepadEvent extends Event {
  static { defineClassString(this.prototype, 'GamepadEvent'); }
  constructor(type, init) {
    super(type, init);
    this.gamepad = (init && 'gamepad' in init) ? init.gamepad : null;
  }
}

export class MouseEvent extends UIEvent {
  static { defineClassString(this.prototype, 'MouseEvent'); }
  constructor(type, init) {
    super(type, init);
    init = init || {};
    // Real MouseEvent defaults: button=0 (primary), which=1. Many
    // legacy click handlers (Redmine's context_menu.js, jQuery 1.x
    // probes) gate on `event.which === 1` to detect a primary click —
    // without explicit defaults our synthetic click events looked
    // like non-primary clicks and the handler bailed before
    // running its body.
    this.button    = init.button    != null ? init.button    : 0;
    this.buttons   = init.buttons   != null ? init.buttons   : 0;
    this.which     = init.which     != null ? init.which     : (this.button + 1);
    this.clientX   = init.clientX   || 0;
    this.clientY   = init.clientY   || 0;
    this.pageX     = init.pageX     != null ? init.pageX     : this.clientX;
    this.pageY     = init.pageY     != null ? init.pageY     : this.clientY;
    this.screenX   = init.screenX   || 0;
    this.screenY   = init.screenY   || 0;
    this.offsetX   = init.offsetX   != null ? init.offsetX   : 0;
    this.offsetY   = init.offsetY   != null ? init.offsetY   : 0;
    this.movementX = init.movementX || 0;
    this.movementY = init.movementY || 0;
    this.altKey    = !!init.altKey;
    this.ctrlKey   = !!init.ctrlKey;
    this.metaKey   = !!init.metaKey;
    this.shiftKey  = !!init.shiftKey;
    this.relatedTarget = init.relatedTarget || null;
  }
  // CSSOM-View: `x`/`y` alias `clientX`/`clientY`.
  get x() { return this.clientX; }
  get y() { return this.clientY; }
  // UI Events: returns whether the given modifier was held at dispatch.
  getModifierState(keyArg) {
    switch (String(keyArg)) {
      case 'Alt':              return this.altKey;
      case 'Control':          return this.ctrlKey;
      case 'Meta': case 'OS':  return this.metaKey;
      case 'Shift':            return this.shiftKey;
    }
    return false;
  }
  // Legacy initialiser; no-op while dispatching (dispatch flag set).
  initMouseEvent(type, bubbles, cancelable, view, detail, screenX, screenY,
                 clientX, clientY, ctrlKey, altKey, shiftKey, metaKey, button, relatedTarget) {
    if (this._dispatchFlag) return;
    initEventSteps(this, String(type), !!bubbles, !!cancelable);
    this.view    = view != null ? view : null;
    this.detail  = detail || 0;
    this.screenX = screenX || 0; this.screenY = screenY || 0;
    this.clientX = clientX || 0; this.clientY = clientY || 0;
    this.ctrlKey = !!ctrlKey; this.altKey = !!altKey;
    this.shiftKey = !!shiftKey; this.metaKey = !!metaKey;
    this.button  = button || 0;
    this.relatedTarget = relatedTarget || null;
  }
}

// WheelEvent extends MouseEvent per the UI Events spec (so a wheel event
// satisfies `instanceof MouseEvent` and carries the pointer-position /
// modifier fields). Defined after MouseEvent for the class reference.
export class WheelEvent extends MouseEvent {
  static { defineClassString(this.prototype, 'WheelEvent'); }
  constructor(type, init) {
    super(type, init);
    init = init || {};
    this.deltaX    = init.deltaX    != null ? init.deltaX    : 0;
    this.deltaY    = init.deltaY    != null ? init.deltaY    : 0;
    this.deltaZ    = init.deltaZ    != null ? init.deltaZ    : 0;
    this.deltaMode = init.deltaMode != null ? init.deltaMode : 0;
  }
}
for (const [k, v] of [['DOM_DELTA_PIXEL', 0], ['DOM_DELTA_LINE', 1], ['DOM_DELTA_PAGE', 2]]) {
  Object.defineProperty(WheelEvent,           k, { value: v, enumerable: true });
  Object.defineProperty(WheelEvent.prototype, k, { value: v, enumerable: true });
}

// Pointer Events level 3 — extends MouseEvent so `pointerdown`
// dispatched as PointerEvent still satisfies `instanceof MouseEvent`
// (Stimulus / selector-set delegation expects either).
export class PointerEvent extends MouseEvent {
  static { defineClassString(this.prototype, 'PointerEvent'); }
  constructor(type, init) {
    super(type, init);
    init = init || {};
    this.pointerId    = init.pointerId    != null ? init.pointerId    : 0;
    this.pointerType  = init.pointerType  != null ? String(init.pointerType) : '';
    this.width        = init.width        != null ? init.width        : 1;
    this.height       = init.height       != null ? init.height       : 1;
    this.pressure     = init.pressure     != null ? init.pressure     : 0;
    this.tangentialPressure = init.tangentialPressure || 0;
    this.tiltX        = init.tiltX        || 0;
    this.tiltY        = init.tiltY        || 0;
    this.twist        = init.twist        || 0;
    this.isPrimary    = !!init.isPrimary;
  }
}

// A UA-fired mouse gesture also fires its Pointer Event twin: same coordinates and modifiers, plus
// the pointer identity fields a library branches on to prefer the pointer path. One helper so every
// synthetic gesture (the click path, drag.js) produces the same shape. `pressure` is 0.5 while a
// button is held and 0 once released, per Pointer Events.
export function pointerEventInit(mouseInit, pressure) {
  return Object.assign(
    { pointerId: 1, pointerType: 'mouse', isPrimary: true, pressure: pressure == null ? 0.5 : pressure },
    mouseInit
  );
}

export class DragEvent extends MouseEvent {
  static { defineClassString(this.prototype, 'DragEvent'); }
  constructor(type, init) {
    super(type, init);
    this.dataTransfer = (init && init.dataTransfer) || null;
  }
}

export class KeyboardEvent extends UIEvent {
  static { defineClassString(this.prototype, 'KeyboardEvent'); }
  constructor(type, init) {
    super(type, init);
    init = init || {};
    // KeyboardEvent fields per the UI Events spec — listeners gate
    // on `key` (string like 'Enter' / 'a'), `code` (physical key),
    // `keyCode` (legacy), `ctrlKey` / `metaKey` / `shiftKey` /
    // `altKey`. Redmine's jstoolbar reads `event.key.toLowerCase()`
    // and `event.ctrlKey || event.metaKey`; the document-level
    // toogleEditPreview shortcut reads the same combination.
    this.key      = init.key      != null ? String(init.key)  : '';
    this.code     = init.code     != null ? String(init.code) : '';
    this.keyCode  = init.keyCode  != null ? init.keyCode  : 0;
    this.which    = init.which    != null ? init.which    : this.keyCode;
    this.charCode = init.charCode != null ? init.charCode : 0;
    this.location = init.location != null ? init.location : 0;
    this.repeat   = !!init.repeat;
    this.isComposing = !!init.isComposing;
    this.ctrlKey  = !!init.ctrlKey;
    this.metaKey  = !!init.metaKey;
    this.shiftKey = !!init.shiftKey;
    this.altKey   = !!init.altKey;
  }
  getModifierState(keyArg) {
    switch (String(keyArg)) {
      case 'Alt':                                  return this.altKey;
      case 'Control':                              return this.ctrlKey;
      case 'Meta': case 'OS':                      return this.metaKey;
      case 'Shift':                                return this.shiftKey;
    }
    return false;
  }
  // Legacy initialiser (typeArg, canBubble, cancelable, view, key, location,
  // modifiersList, repeat, locale); no-op while dispatching (dispatch flag set).
  initKeyboardEvent(type, bubbles, cancelable, view, key, location, modifiersList, repeat) {
    if (this._dispatchFlag) return;
    initEventSteps(this, String(type), !!bubbles, !!cancelable);
    this.view     = view != null ? view : null;
    this.key      = key != null ? String(key) : '';
    this.location = location != null ? location : 0;
    this.repeat   = !!repeat;
    // Legacy `modifiersList` is a space-separated key list ("Control Shift").
    const mods = modifiersList ? String(modifiersList).split(/\s+/) : [];
    this.ctrlKey  = mods.includes('Control');
    this.altKey   = mods.includes('Alt');
    this.shiftKey = mods.includes('Shift');
    this.metaKey  = mods.includes('Meta');
  }
}
for (const [k, v] of [['DOM_KEY_LOCATION_STANDARD', 0], ['DOM_KEY_LOCATION_LEFT', 1], ['DOM_KEY_LOCATION_RIGHT', 2], ['DOM_KEY_LOCATION_NUMPAD', 3]]) {
  Object.defineProperty(KeyboardEvent,           k, { value: v, enumerable: true });
  Object.defineProperty(KeyboardEvent.prototype, k, { value: v, enumerable: true });
}

export class InputEvent extends UIEvent {
  static { defineClassString(this.prototype, 'InputEvent'); }
  constructor(type, init) {
    super(type, init);
    init = init || {};
    // `data` is the typed text, `inputType` distinguishes
    // 'insertText' / 'deleteContentBackward' / etc. Stimulus-driven
    // `beforeinput` handlers branch on inputType. Stored on a
    // backing slot rather than as own data properties so the
    // prototype-level getters below satisfy `"data" in
    // InputEvent.prototype` — Trix uses that feature probe to
    // decide between Level 2 (uses `beforeinput`) and Level 0
    // input controllers.
    this._data        = init.data      != null ? String(init.data)      : null;
    this._inputType   = init.inputType != null ? String(init.inputType) : '';
    this._isComposing = !!init.isComposing;
    this._targetRanges = Array.isArray(init.targetRanges) ? init.targetRanges.slice() : [];
    // Nullable DataTransfer — set for clipboard/drag inputTypes (insertFromPaste /
    // insertFromDrop), null otherwise. A plain edit (insertText / insertLineBreak /
    // formatBold / …) reads it back as null, not undefined.
    this._dataTransfer = (init && init.dataTransfer) || null;
  }
  get data()         { return this._data; }
  get inputType()    { return this._inputType; }
  get isComposing()  { return this._isComposing; }
  get dataTransfer() { return this._dataTransfer; }
  // The target ranges are live only while the event is being dispatched; once
  // dispatch finishes (`_dispatchFlag` cleared) getTargetRanges() returns empty,
  // which input-events-get-target-ranges asserts by reading a captured event
  // afterwards.
  getTargetRanges()  { return this._dispatchFlag ? this._targetRanges.slice() : []; }
}

export class SubmitEvent extends Event {
  static { defineClassString(this.prototype, 'SubmitEvent'); }
  constructor(type, init) {
    // WebIDL: `type` is required; `submitter` is an optional `HTMLElement?` — null /
    // undefined / a missing dict default to null, but a non-element value (e.g. a
    // string) is a TypeError (SubmitEvent "Failing constructor").
    if (arguments.length < 1)
      throw new TypeError("Failed to construct 'SubmitEvent': 1 argument required, but only 0 present.");
    super(type, init);
    const submitter = (init && init.submitter != null) ? init.submitter : null;
    if (submitter !== null && !(submitter instanceof globalThis.HTMLElement))
      throw new TypeError("Failed to construct 'SubmitEvent': member submitter is not of type HTMLElement.");
    this.submitter = submitter;
  }
}

// Apps that handle paste / copy with a real ClipboardEvent (Trix,
// Avo's image-cropper paste) check `event.clipboardData.getData(...)`.
// Construct a minimal DataTransfer shape from `init.clipboardData`
// or a flat `init.clipboardDataText` string.
export class ClipboardEvent extends Event {
  static { defineClassString(this.prototype, 'ClipboardEvent'); }
  constructor(type, init) {
    super(type, init);
    const i = init || {};
    let cd = null;
    if (i.clipboardData) {
      cd = i.clipboardData;
    } else if ('clipboardDataText' in i) {
      const text = i.clipboardDataText == null ? '' : String(i.clipboardDataText);
      cd = {
        types: ['text/plain'],
        getData(kind) { return normalizeDataFormat(kind) === 'text/plain' ? text : ''; },
        setData() {}
      };
    }
    Object.defineProperty(this, 'clipboardData', {value: cd, writable: true, configurable: true, enumerable: true});
  }
}

// EventSource and Worker both dispatch these; data carries the
// JSON-roundtripped payload (for Worker) or the SSE event body
// (for EventSource).
// `MessageEvent.ports` is a `FrozenArray<MessagePort>`: a frozen copy of the given
// sequence, stored once so every read returns that same frozen object. An absent member
// defaults to an (empty) frozen array; an explicit `null` is a non-iterable sequence →
// TypeError (messageevent-constructor "Passing null for ports").
export function toFrozenPorts(ports) {
  if (ports === undefined) return Object.freeze([]);
  // WebIDL sequence conversion requires an OBJECT with an @@iterator — a primitive
  // (even an iterable one like a string: `ports: ''`) is a TypeError
  // (extendable-message-event-constructor "`ports` is specified").
  if (ports === null || typeof ports !== 'object' || typeof ports[Symbol.iterator] !== 'function') {
    throw new TypeError("Failed to construct 'MessageEvent': The provided value cannot be converted to a sequence.");
  }
  return Object.freeze(Array.from(ports));
}

export class MessageEvent extends Event {
  static { defineClassString(this.prototype, 'MessageEvent'); }
  constructor(type, init) {
    super(type, init);
    init = init || {};
    // `data` is `any` with a `null` DEFAULT: the default applies only when the member is ABSENT.
    // A present `data: undefined` keeps undefined (postMessage(undefined) delivers event.data ===
    // undefined, not null — webmessaging without-ports/010).
    this.data        = ('data' in init) ? init.data : null;
    this.lastEventId = init.lastEventId == null ? '' : String(init.lastEventId);
    this.origin      = init.origin == null ? '' : String(init.origin);
    this.source      = init.source || null;
    this.ports       = toFrozenPorts(init.ports);
  }
  // Legacy `initMessageEvent(type, bubbles, cancelable, data, origin, lastEventId,
  // source, ports)` — re-initializes the event's members (used with
  // `document.createEvent("messageevent")`). Only `type` is required, so the IDL
  // `.length` is 1; the rest are read positionally with their dictionary defaults.
  // `ports` is converted first (a `null` argument is a non-iterable sequence → throws,
  // like the constructor), then the dispatch-flag no-op and the base reset (`initEventSteps`, not a `initEvent` a page
  // may have replaced) before the message-specific members are set.
  initMessageEvent(type) {
    const a = arguments;
    if (a.length < 1) throw new TypeError("Failed to execute 'initMessageEvent' on 'MessageEvent': 1 argument required, but only 0 present.");
    const ports = toFrozenPorts(a.length > 7 ? a[7] : undefined);
    if (this._dispatchFlag) return;
    initEventSteps(this, String(type), a.length > 1 ? !!a[1] : false, a.length > 2 ? !!a[2] : false);
    this.data        = a.length > 3 ? (a[3] == null ? null : a[3]) : null;
    this.origin      = a.length > 4 && a[4] != null ? String(a[4]) : '';
    this.lastEventId = a.length > 5 && a[5] != null ? String(a[5]) : '';
    this.source      = a.length > 6 ? (a[6] || null) : null;
    this.ports       = ports;
  }
}


// Dispatch + fire the matching `on<type>` IDL handler if present.
// WebIDL says event handler IDL attributes (`xhr.onload = …`,
// `req.onsuccess = …`) get invoked after addEventListener-registered
// handlers; combining both lets stub classes (FileReader / IDBRequest
// / EventSource / Worker) reuse `EventTarget` without each
// reinventing the on<type> half.
// Historically this fired the target's `on<type>` AFTER dispatchEvent; that is
// now done inside EventTarget.dispatchEvent itself (on-handlers are listeners),
// so this is a thin wrapper kept for its callers. The on-handler still fires
// (via dispatchEvent) even though the per-listener errors are swallowed there.
export function dispatchWithOnHandler(target, evt) {
  // This is the UA-internal "fire an event" path for plain EventTargets / the Window
  // (XHR / WebSocket / EventSource / FileReader / IDB / MessagePort / BroadcastChannel /
  // Worker / window postMessage) — every caller fires a genuinely UA-dispatched event, so
  // the event is TRUSTED. Mark it so the base dispatchEvent below keeps `isTrusted = true`
  // instead of clearing it to false (which is the contract only for a scripted dispatchEvent).
  // (…dispatched by the steps, not through a `dispatchEvent` the page may have replaced; the marker left behind by none
  // that refuses the event)
  evt._uaFired = true;
  try { return dispatchAt(targetOf(target), evt); } catch (_) { return true; } finally { evt._uaFired = false; }
}

// `EventTarget` is the ONE listener implementation for the whole platform:
// plain EventTargets (`class Foo extends EventTarget` — XHR / FileReader / IDB /
// Worker / AbortSignal / Avo's date-picker …), DOM nodes (Node extends it), and
// the Window (window-events.js points `globalThis.{add,remove,dispatch}EventListener`
// at its members). Sharing one implementation makes `window.addEventListener ===
// EventTarget.prototype.addEventListener` (WPT window-extends-event-target) and
// lets a member invoked with a different `this` operate on that target.
//
// Listeners live in `_listeners` (type → [{handler,isObject,capture,passive,
// once,removed}]) — the same store the DOM tree walker (dispatch.js
// fireListeners) and the Window walker (window-events.js fireWindowListeners)
// read, so registering through any of the three surfaces is mutually visible.
// A node's dispatch is the capture/bubble tree walk (dispatch.js); any other's
// the flat AT_TARGET fire (`dispatchAt`).

// DOM "inner invoke" sets the legacy `window.event` (current event) on EACH
// listener callback's RELEVANT GLOBAL, then restores it — not once per dispatch.
// `perRealmCurrentEvent()` is the cheap gate (property reads only) choosing the
// model for this dispatch:
//   - SINGLE-realm page (the common case — top frame, no iframes): false → set
//     `globalThis.__csimCurrentEvent` once for the whole dispatch (the hot path, zero
//     per-listener cost).
//   - MULTI-realm page (top frame owns iframe realms, OR this dispatch runs
//     INSIDE a child realm — its `top` points at the parent): true → per-listener
//     set/restore on each callback's own realm via invokeWithCurrentEvent. That
//     pays one `contextOf` native crossing per listener (same-realm callbacks
//     short-circuit in __csimRealmGlobalOf without the second `contextGlobal`),
//     which is why it's gated to multi-realm pages — the base EventTarget/window
//     dispatch this guards is far cooler than the Node dispatch (dispatch.js),
//     which keeps the per-dispatch model unchanged (rule 3).
export function perRealmCurrentEvent() {
  return !!((globalThis.__csimChildRealmIds && globalThis.__csimChildRealmIds.size) ||
            (globalThis.__csimTop && globalThis.__csimTop !== globalThis));
}

// Invoke an event LISTENER (`handler`, a function or — `isObject` — an object
// with a `handleEvent`) or an on-handler with the legacy current event set on
// the LISTENER's realm global for the duration — INCLUDING HTML "report the
// exception" if it throws (the realm `event` is restored only as DOM "inner
// invoke"'s last step, the `finally`). Single-realm pages (`perRealm` false)
// leave the dispatch-level `globalThis.__csimCurrentEvent` in place; multi-realm pages
// set/restore the LISTENER's own realm `event` — so a cross-realm `window.onerror
// = new frames[0].Function(...)` sees `frames[0].window.event` while the
// dispatching realm's stays the ambient (load) event.
//
// The realm, the `handleEvent` resolution (its getter runs on every dispatch and
// a throw from it is reported), the non-callable-`handleEvent` TypeError, and the
// error report ALL anchor on `handler` (the listener) — never on `handleEvent`,
// which can be a foreign-realm Proxy in a DIFFERENT realm than the object. So the
// in-handler `window.event` and the reported `error` event always target the one
// realm the spec calls the listener's relevant global. Nothing propagates to the
// dispatchEvent() caller.
// (…an event handler's realm its function's, not its listener's, which is this module's: `window.onerror = new
// frames[0].Function(…)` sets `frames[0].event` and reports its throw there)
// (…looked up, not read off it: a listener may be a revoked Proxy, which no property read survives)
const HANDLER_OF_LISTENER = new WeakMap();   // an event handler's listener → the handler it calls, read live
function realmAnchorOf(handler) {
  const handlerOf = HANDLER_OF_LISTENER.get(handler);
  return (handlerOf && handlerOf()) || handler;
}
export function invokeWithCurrentEvent(perRealm, handler, isObject, thisArg, event) {
  let g = null, prev;
  if (perRealm) {
    g = (globalThis.__csimRealmGlobalOf && globalThis.__csimRealmGlobalOf(realmAnchorOf(handler))) || globalThis;
    prev = g.__csimCurrentEvent;
    g.__csimCurrentEvent = event;
    // WindowProxy retargeting: when the event target is a WINDOW and this listener
    // belongs to ANOTHER realm, present `event.target` as that realm's WindowProxy
    // for the window — so a cross-realm listener (and a post-dispatch reader in its
    // realm) sees the same object `contentWindow`/`parent` yields (Event-dispatch-
    // throwing-multiple-globals: `errorEvent.target === iframe.contentWindow`). Not
    // restored afterward: like a real browser, `event.target` stays the WindowProxy.
    if (g !== globalThis && event && g.__csimFrameWindowProxyFor &&
        globalThis.__csimIsWindowGlobal && globalThis.__csimIsWindowGlobal(event._target)) {
      try {
        const proxied = g.__csimFrameWindowProxyFor(globalThis.RustyRacer.contextOf(event._target));
        if (proxied && proxied !== event._target) {
          if (event._currentTarget === event._target) event._currentTarget = proxied;
          event._target = proxied;
        }
      } catch (_) {}
    }
  }
  try {
    const cb = isObject ? handler.handleEvent : handler;
    if (typeof cb !== 'function') throw new TypeError("Failed to invoke event listener: the 'handleEvent' property is not callable.");
    cb.call(thisArg, event);
  } catch (e) {
    try { globalThis.__csimReportListenerError(realmAnchorOf(handler), e); } catch (_) {}
  } finally {
    if (g) g.__csimCurrentEvent = prev;
  }
}

// The dispatch of an event at a node — over its tree, with its event path (dispatch.js `dispatchEventPublic`, which
// registers it: dispatch.js imports this module, not this one it).
let nodeDispatch = null;
export function setNodeDispatch(dispatch) {
  nodeDispatch = dispatch;
}

// The target a member acts on: the object itself, or for a window, its global — a WindowProxy (a frame's, whichever
// realm made it, answers its global as `__csimRawWindow`) unwrapped, as the listeners live where events fire.
function targetOf(o) {
  // (…the window and the document first: on the hottest targets, an inherited miss — a Proxy's trap, on the
  // document — costs more than the call it guards)
  if (o === globalThis || o === globalThis.document || o[EVENT_TARGET] === true) return o;
  return o.__csimRawWindow || unwrapWin(o);
}
// What tells an EventTarget apart, for its members' `this` and a conversion to one: an object EventTarget.prototype is
// behind — any realm's, which brands itself — or a window, whose global none is (`window instanceof EventTarget` is the
// Window's own test).
function isEventTarget(o) {
  if (o === null || (typeof o !== 'object' && typeof o !== 'function')) return false;
  if (o === globalThis || o === globalThis.document) return true;
  if (o[EVENT_TARGET] === true) return true;
  const raw = targetOf(o);
  return raw === globalThis || globalThis.__csimIsWindowGlobal(raw);
}

export class EventTarget {}
const EVENT_TARGET = brandPrototype(EventTarget, 'EventTarget');

// DOM "add an event listener" (§2.7): `options` the converted `(AddEventListenerOptions or boolean)` — a boolean its
// `capture` — read whatever the callback (its `signal` converted too, so `{signal: null}` is a TypeError even with no
// callback); a null callback, or a signal already aborted, adds nothing. `passive` unsaid is the target's default
// (`defaultPassiveValue`: a touch or wheel listener on the window, the document or its root is passive).
function addListener(self, type, handler, options) {
  const dict = typeof options === 'object';
  const capture = dict ? options.capture : options;
  const passive = dict && options.passive !== undefined ? options.passive : defaultPassiveValue(type, self);
  const once = dict && options.once;
  const signal = dict ? options.signal : undefined;
  if (handler === null) return;
  if (signal !== undefined && signal.aborted) return;
  // Keep the listener store off the enumerable surface (Object.keys / for-in /
  // JSON.stringify / spread / structuredClone) — it's internal state, like the
  // old non-enumerable `_etListeners` and the module-private window store.
  let store = self._listeners;
  if (!store) {
    store = Object.create(null);
    // (…a node has the slot from its making — written as it is, the node's hidden class kept)
    if (self._listeners === null) self._listeners = store;
    else Object.defineProperty(self, '_listeners', { value: store, writable: true, enumerable: false, configurable: true });
  }
  const list = store[type] || (store[type] = []);
  // Dedup on {type, callback, capture} with original callback identity.
  if (list.some(l => l.handler === handler && l.capture === capture)) return;
  list.push({ handler, isObject: typeof handler !== 'function', capture, passive, once });
  noteListener(type, 1);
  // Only after the listener is actually added (not deduped): abort removes it.
  if (signal !== undefined) {
    signal.addEventListener('abort', () => removeListener(self, type, handler, capture), { once: true });
  }
}
// DOM "remove an event listener": `options` the converted `(EventListenerOptions or boolean)`, or the capture alone.
function removeListener(self, type, handler, options) {
  const capture = typeof options === 'object' ? options.capture : options;
  if (!self._listeners || !self._listeners[type]) return;
  self._listeners[type] = self._listeners[type].filter(l => {
    const isMatch = l.capture === capture && l.handler === handler;
    if (isMatch) l.removed = true;   // in-flight dispatch snapshot must skip it
    if (isMatch) noteListener(type, -1);
    return !isMatch;
  });
}
// DOM "dispatch": a node's over its tree (dispatch.js), any other target's — a plain EventTarget's, the window's — flat,
// at the target.
function dispatchAt(self, event) {
  // (…a node's is over its tree: dispatch.js's)
  if (self.__csimIsNode === true) return nodeDispatch(self, event);
  if (event._dispatchFlag || event._initialized === false) {
    throw new globalThis.DOMException(
      "The event is already being dispatched, or has not been initialized.", "InvalidStateError");
  }
  // A scripted `dispatchEvent()` produces an UNTRUSTED event (DOM "dispatchEvent" sets
  // isTrusted to false); UA-internal firing (dispatchWithOnHandler) marks `_uaFired` so the
  // event stays TRUSTED. The marker is single-use — cleared here so a later scripted
  // re-dispatch of the same object is correctly untrusted.
  event._isTrusted = event._uaFired === true;
  event._uaFired = false;
  // (…its target the window's document under the "legacy target override flag", which only the window's `load` sets)
  event._target = event._legacyTargetOverride === true ? self.document : self;
  event._legacyTargetOverride = false;
  event._csimFlatTarget = self; // (…its path the target alone: composedPath() is [self])
  event._dispatchFlag = true;   // re-dispatching it mid-flight → InvalidStateError
  event._currentTarget = self;
  event._eventPhase = 2;   // AT_TARGET — a plain EventTarget (or the Window) is always the target of its own flat dispatch
  try {
    return dispatchAtTarget(self, event);
  } finally {
    // The end of dispatch, as a node's (dispatch.js): phase NONE, no current target, and the dispatch and stop flags
    // unset — `finally`, past a throwing `on*` handler.
    event._eventPhase = 0;
    event._currentTarget = null;
    event._dispatchFlag = false;
    event._csimFlatTarget = null;
    event._propagationStopped = false;
    event._immediatePropagationStopped = false;
  }
}
function dispatchAtTarget(self, event) {
  const perRealm = perRealmCurrentEvent();
  let prevWinEvent;
  if (!perRealm) { prevWinEvent = globalThis.__csimCurrentEvent; globalThis.__csimCurrentEvent = event; }
  const list = self._listeners && self._listeners[event._type];
  if (list) {
    for (const entry of list.slice()) {
      if (entry.removed) continue;
      if (event._immediatePropagationStopped) break;
      if (entry.once) removeOnceListener(entry, self._listeners[event._type], event._type);
      event._inPassiveListener = !!entry.passive;   // passive → preventDefault no-op
      // An object listener is called with the object as `this`
      // (handleEvent.call(obj)); a function listener with the EventTarget. The
      // helper resolves handleEvent + reports any throw on the listener's realm.
      invokeWithCurrentEvent(perRealm, entry.handler, entry.isObject, entry.isObject ? entry.handler : self, event);
      event._inPassiveListener = false;
    }
  }
  // Event-handler IDL attributes (`onload` / `onerror` / …) ARE event
  // listeners per HTML, so they fire on any dispatch — including a direct
  // `target.dispatchEvent(...)` — not just the internal helper paths. A window's
  // and a worker scope's accessors' are among the listeners above; a worker
  // scope's plain `on<type>` property fires through fireWindowOnHandler, and a
  // plain EventTarget's here, after the addEventListener listeners and while
  // `window.event` is still set. A throw is reported (HTML "report the
  // exception"), like the listeners above.
  if (self === globalThis) {
    fireWindowOnHandler(event, perRealm);
  } else {
    const h = self['on' + event._type];
    // Skip when this handler is managed as a registered listener (defineEventHandler):
    // it already fired in the loop above, at its true registration position — firing it
    // here too would double-invoke it. Plain-field handlers (XHR.onload = fn, …) have no
    // `_onwrap_<type>` and still fire here, after the addEventListener listeners.
    if (typeof h === 'function' && !self['_onwrap_' + event._type]) invokeWithCurrentEvent(perRealm, h, false, self, event);
  }
  if (!perRealm) globalThis.__csimCurrentEvent = prevWinEvent;
  return !event._canceled;
}

// EventTarget's members (generated/bindings.js): Observables' `when` none of them — no implementation answers it.
registerInterface('EventTarget', isEventTarget);
installEventTarget(EventTarget, {
  addEventListener: (target, type, callback, options) => addListener(targetOf(target), type, callback, options),
  removeEventListener: (target, type, callback, options) => removeListener(targetOf(target), type, callback, options),
  dispatchEvent: (target, event) => dispatchAt(targetOf(target), event)
});

// The Window's IDL event-handler attribute (`window.onload`/`onpopstate`/…, and
// the body-reflected `onload`/`onerror`/… via the globalThis accessors). HTML
// runs it as a bubble-phase listener. Shared by this base dispatchEvent and the
// element-walk integration in window-events.js (fireWindowListeners).
export function fireWindowOnHandler(event, perRealm) {
  // (…a worker's global's alone, and only a handler no accessor of its holds: a window's handlers and a worker's
  // WorkerGlobalScope ones are its listeners, which the dispatch has called — a window's `onfoo = f` no handler at all)
  if (!globalThis.__csim_isWorker || globalThis['_ehw_' + event._type] !== undefined) return false;
  const h = globalThis['on' + event._type];
  if (typeof h !== 'function') return false;
  // `perRealm` is threaded from the dispatch when known; default it for the
  // window-walk caller (window-events.js fireWindowListeners). When the handler
  // belongs to ANOTHER realm (`window.onerror = new frames[0].Function(...)`),
  // set the current event on THAT realm's global, leaving this realm's
  // `window.event` as the ambient (load) event (event-global-is-still-set-*).
  if (perRealm === undefined) perRealm = perRealmCurrentEvent();
  let g = null, prev;
  if (perRealm) {
    g = (globalThis.__csimRealmGlobalOf && globalThis.__csimRealmGlobalOf(h)) || globalThis;
    prev = g.__csimCurrentEvent;
    g.__csimCurrentEvent = event;
  }
  try {
    // `window.onerror` is an OnErrorEventHandler: for an ErrorEvent it takes the
    // legacy 5-arg form (message, source, lineno, colno, error), not the event.
    if (event._type === 'error' && typeof globalThis.ErrorEvent === 'function' &&
        event instanceof globalThis.ErrorEvent) {
      const handled = h.call(globalThis, event.message, event.filename, event.lineno, event.colno, event.error);
      if (handled === true && event._cancelable) event._canceled = true;
    } else {
      h.call(globalThis, event);
    }
  } catch (e) {
    // HTML "report the exception": a throwing window on-handler is REPORTED on
    // the handler's own realm — a cross-realm `window.onerror` that throws fires
    // THAT realm's `error` event (→ its own onerror) in turn — not swallowed.
    // reportError's re-entrancy guard bounds the recursion.
    try { globalThis.__csimReportListenerError(h, e); } catch (_) {}
  }
  finally { if (g) g.__csimCurrentEvent = prev; }
  return true;
}

// Make `on<type>` a spec-faithful EventHandler IDL attribute on a plain EventTarget
// `proto` (XMLHttpRequest / FileReader / MessagePort / BroadcastChannel / Worker /
// IDB* / AbortSignal / MediaQueryList — surfaces with no content attributes). Assigning
// a function REGISTERS a real event listener, so the handler fires INTERLEAVED with
// addEventListener listeners in registration order (not always last, as the plain-field
// fallback in dispatchEvent does); null removes it; a function→function replace keeps the
// SAME position (the wrapper reads the handler live). The `_on_<type>` / `_onwrap_<type>`
// backing (shared with setHandlerSlot below) is non-enumerable, and dispatchEvent checks
// `_onwrap_<type>` to avoid double-firing. Element / Document / ShadowRoot handlers, which
// additionally reflect content attributes + forward body/frameset handlers to the window,
// use installEventHandlerAttrs below.
export function defineEventHandlers(proto, types) {
  for (const t of types) defineEventHandler(proto, t);
}
export function defineEventHandler(proto, type) {
  const slot = '_on_' + type, wrapKey = '_onwrap_' + type;
  Object.defineProperty(proto, 'on' + type, {
    // WebIDL attributes are enumerable on the interface prototype (verified in Chrome:
    // `MessagePort.prototype.onmessage` is enum=true), same as installEventHandlerAttrs.
    configurable: true, enumerable: true,
    get() { return this[slot] == null ? null : this[slot]; },   // stored value verbatim (object or callable), else null
    set(v) {
      // WebIDL EventHandler is [LegacyTreatNonObjectAsNull]: a non-object primitive
      // becomes null; an object — callable or NOT — is stored as-is (only a CALLABLE is
      // ever invoked). So `onX = {}` round-trips to `{}` but never fires.
      const stored = (v !== null && (typeof v === 'object' || typeof v === 'function')) ? v : null;
      setHandlerSlot(this, type, slot, wrapKey, stored);
    }
  });
}

// ── GlobalEventHandlers IDL attributes on Element / Document / ShadowRoot ──
//
// A single HTML "event handler" is identified by (node, type). Per spec it has a
// VALUE — null, a callback (assigned via the IDL attribute), or an internal raw
// uncompiled handler (a `RawHandler`, assigned via a content attribute and
// compiled lazily on first use) — and ONE associated event listener, added the
// first time the value becomes callable (at that DOM position) and removed when it
// returns to null. The listener reads the value LIVE, so the IDL property,
// setAttribute and removeAttribute all drive the SAME listener — matching HTML
// reflection and making the handler fire INTERLEAVED with addEventListener
// listeners in registration order (the old dispatch-walk fired it always-first).
//
// `<body>` / `<frameset>` reflect the six window-reflecting handlers
// (onblur/onerror/onfocus/onload/onscroll/onresize) to the WINDOW instead of the
// element; every other element treats them as ordinary handlers (so `<img
// onerror>` / `<script onload>` register a real listener).

// HTML "compile a handler": build the handler function from an inline source. Per
// spec the function is NAMED after the handler (`function onclick(event) {…}`), the
// OnErrorEventHandler (window / body-reflected `onerror`) takes the legacy 5-arg
// signature, and the body runs in the element's lexical scope chain (element → form
// owner → document; the Window is the realm the function is created in), so
// `onclick="cellIndex"` resolves against the element, `"domain"` against the
// document, `"print"` against the window. The scopes are injected with `with`
// (which honours `Symbol.unscopables` natively), and the named function is CREATED
// INSIDE the `with` blocks — so it captures them by closure while its OWN source is
// just `function <name>(<args>) { <src> }`, giving the clean spec-required
// `toString()` with no `with` wrapper. `scopeChain` is outermost-first (document …
// element); empty for a Window handler (global scope only). A syntax error → null,
// and (when `report`) HTML "report the exception" fires the window `error` event.
function compileHandler(src, name, fiveArg, scopeChain, report) {
  const args   = fiveArg ? 'event, source, lineno, colno, error' : 'event';
  const params = scopeChain.map((_, i) => '$scope' + i);
  let withHead = '';
  for (const p of params) withHead += 'with (' + p + ') ';
  const factorySrc = withHead + '{ return function ' + name + '(' + args + ') {\n' + String(src) + '\n}; }';
  try {
    return new Function(params.join(','), factorySrc).apply(undefined, scopeChain);
  } catch (e) {
    if (report) { try { globalThis.__csimReportError(e); } catch (_) {} }
    return null;
  }
}

// The form owner added to a form-associated element's inline-handler scope chain.
// The resolver (which needs formForControl + the custom-element registry + the
// form-associated tag set — all owned by dom-nodes) is injected there, both to keep
// that knowledge in one place and to avoid an events↔form-helpers import cycle. It
// returns the form owner, or null for a non-form-associated element.
let resolveScopeFormOwner = null;
export function setScopeFormOwnerResolver(fn) { resolveScopeFormOwner = fn; }

// The element's inline-handler lexical scope chain, outermost-first: the node
// document, the form owner (only for a form-associated element that has one), then
// the element itself (innermost, shadows the rest).
function elementHandlerScopeChain(node) {
  const chain = [];
  const doc = node.ownerDocument || globalThis.document;
  if (doc) chain.push(doc);
  const form = resolveScopeFormOwner ? resolveScopeFormOwner(node) : null;
  if (form) chain.push(form);
  chain.push(node);
  return chain;
}

// An uncompiled inline-handler source bound to its owning element + handler name,
// compiled LAZILY on first use (getter read or first dispatch) and memoized — a
// never-triggered inline handler is never compiled (matching the old lazy-compile
// perf), and a syntax error is reported exactly ONCE. A distinct type so an
// IDL-assigned plain object (`el.onclick = {}`, which round-trips but never fires) is
// never mistaken for one.
// (…a Window's — a body's or frameset's forwarded one — with no element: the global scope, and `onerror` the legacy
// five arguments, OnErrorEventHandler's)
class RawHandler {
  constructor(src, node, name) { this.src = src; this.node = node; this.name = name; this.fn = undefined; }
  compile() {
    if (this.fn === undefined) {
      // Memoize to null BEFORE compiling: compileHandler reports a syntax error
      // synchronously (a window `error` event), and a handler reacting to it that
      // reads this same `el.onX` would otherwise re-enter with `fn` still undefined —
      // recompiling and re-reporting without bound. With `fn` already null, the
      // re-entrant read short-circuits (compiled once, reported once).
      this.fn = null;
      this.fn = this.node === null
        ? compileHandler(this.src, this.name, this.name === 'onerror', [], true)
        : compileHandler(this.src, this.name, false, elementHandlerScopeChain(this.node), true);
    }
    return this.fn;
  }
}

// `<body>`/`<frameset>` forward these handlers to the Window (HTML §8.1.8.2): the "Window-reflecting
// body element event handler set" (blur/error/focus/load/resize/scroll) and WindowEventHandlers' —
// `<body onload>` / `body.onpopstate = f` are their node document's window's handler, and the
// element has none of its own. (A document with no window: no handler, read null, set nothing.)
const FORWARDED_TYPE = new Set(['blur', 'error', 'focus', 'load', 'scroll', 'resize', ...WINDOW_EVENT_HANDLERS.map((n) => n.slice(2))]);
function isForwardingHost(node) { return node._ns === HTML_NS && (node._localName === 'body' || node._localName === 'frameset'); }
function forwardingWindowOf(node) {
  const doc = node.ownerDocument;
  if (doc === globalThis.document) return globalThis;
  const view = doc && doc.defaultView;
  return view ? (view.__csimRawWindow || view) : null;
}

// A handler's "event handler event type" is usually the attribute name minus
// `on`, but the four legacy WebKit-prefixed handlers listen for the CAMEL-CASE
// event type (`onwebkitanimationend` → `webkitAnimationEnd`), per HTML — a
// `webkitAnimationEnd` event fires them, the unprefixed `animationend` does not.
const HANDLER_EVENT_TYPE = {
  onwebkitanimationend:       'webkitAnimationEnd',
  onwebkitanimationiteration: 'webkitAnimationIteration',
  onwebkitanimationstart:     'webkitAnimationStart',
  onwebkittransitionend:      'webkitTransitionEnd'
};

// The IDL getter's reflected value: a RawHandler compiles to its function (or
// null); a function or non-callable object is returned verbatim (WebIDL
// [LegacyTreatNonObjectAsNull] lets `onclick = {}` round-trip); else null.
function reflectHandler(v) {
  if (v == null) return null;
  if (v instanceof RawHandler) return v.compile();
  return v;
}
// The callable actually invoked on dispatch: a RawHandler's compiled function
// (compiled lazily here on first fire), a function verbatim, else null (a
// non-callable object never fires).
function handlerCallable(v) {
  if (v instanceof RawHandler) return v.compile();
  return typeof v === 'function' ? v : null;
}
// Whether a stored value gets a registered listener. Per HTML "activate an event
// handler", the listener is added the first time the value becomes NON-NULL — a
// function, a RawHandler (inline source, registered WITHOUT compiling — a syntax error
// still registers a listener that no-ops), OR a non-callable object (`el.onclick = {}`).
// A non-callable object's listener never fires (the wrapper's `handlerCallable` no-ops),
// but it MUST be registered so its DOM position is claimed: a later assignment of a
// callable reuses that first position instead of appending after intervening
// addEventListener listeners (event-handler-spec-example). `stored` is pre-normalised to
// null-or-object/function/RawHandler, so any non-null value is registrable. Decided
// without compiling, so a never-triggered inline handler is never parsed.
function isRegistrableHandler(v) {
  return v != null;
}

// The shared EventHandler primitive (used by defineEventHandler for plain
// EventTargets and by installEventHandlerAttrs / syncInlineEventHandler for
// Element / Document / ShadowRoot): set a node's handler backing slot to `stored`
// (null | function | non-callable object | RawHandler) and add/remove its single
// wrapper listener as the registrability transitions. The wrapper reads the slot
// LIVE, so a later value change (IDL re-assign, setAttribute) keeps the SAME
// listener position, and returning false from a cancelable event's handler cancels it.
function setHandlerSlot(node, type, slotKey, wrapKey, stored) {
  const wasActive = isRegistrableHandler(node[slotKey]);
  if (Object.prototype.hasOwnProperty.call(node, slotKey)) node[slotKey] = stored;
  else Object.defineProperty(node, slotKey, { value: stored, writable: true, enumerable: false, configurable: true });
  const nowActive = isRegistrableHandler(stored);
  if (nowActive && !wasActive) {
    let wrap = node[wrapKey];
    if (!wrap) {
      // HTML "the event handler processing algorithm": a global's `error` handler called with an ErrorEvent's five
      // values, whose true cancels it; a `beforeunload` handler's non-null value cancelling it, and its returnValue
      // that value where none was set (coerced to a string while the event is the current one); any other returning
      // false cancelling the event (an inline `onclick="…; return false"`).
      wrap = (ev) => {
        const cb = handlerCallable(node[slotKey]);
        if (!cb) return;
        if (ev._type === 'error' && ev[ERROR_EVENT] === true && isGlobal(node)) {
          const ret = cb.call(node, ev.message, ev.filename, ev.lineno, ev.colno, ev.error);
          if (ret === true && ev._cancelable) ev._canceled = true;
          return;
        }
        const ret = cb.call(node, ev);
        if (ev._type === 'beforeunload' && ev[BEFORE_UNLOAD_EVENT] === true) {
          if (ret != null) {
            if (ev._cancelable) ev._canceled = true;
            if (ev.returnValue === '') ev.returnValue = ret;
          }
          return;
        }
        if (ret === false && ev._cancelable) ev._canceled = true;
      };
      HANDLER_OF_LISTENER.set(wrap, () => handlerCallable(node[slotKey]));
      Object.defineProperty(node, wrapKey, { value: wrap, writable: true, enumerable: false, configurable: true });
    }
    addListener(node, type, wrap, false);
  } else if (!nowActive && wasActive && node[wrapKey]) {
    removeListener(node, type, node[wrapKey], false);
  }
}
function isGlobal(o) {
  return o === globalThis || globalThis.__csimIsWindowGlobal(o);
}

// Install the GlobalEventHandlers IDL attributes (`onclick` / `onload` / …) as
// spec-faithful EventHandler accessors on `proto` (Element / Document /
// ShadowRoot); each becomes an accessor that registers a listener. The accessors
// are enumerable to match the plain `null` slots they replace (so React-DOM's
// `'oninput' in element` probe still answers true). `contentAttrOf`, for an element
// interface's, tells the elements whose event-handler CONTENT attribute the lowercase
// name also is (`syncInlineEventHandler` recognises it there alone: an element of no
// namespace with handlers has none, a `<div onstorage>` is no body's); Document /
// ShadowRoot expose these purely as IDL properties (null), and a Document-only handler
// (`onreadystatechange` / `onvisibilitychange`) must NOT be a content attribute on any
// element.
const INLINE_HANDLER_TYPE = Object.create(null);   // 'onclick' → 'click', element content-attr handlers only
const INLINE_HANDLER_OWNER = Object.create(null);  // 'onclick' → the elements it is a content attribute of
export function installEventHandlerAttrs(proto, attrNames, contentAttrOf) {
  for (const attr of attrNames) {
    const type    = HANDLER_EVENT_TYPE[attr] || attr.slice(2);
    const slotKey = '_eh_' + type, wrapKey = '_ehw_' + type;
    const forwarded = FORWARDED_TYPE.has(type);
    if (contentAttrOf) { INLINE_HANDLER_TYPE[attr] = type; INLINE_HANDLER_OWNER[attr] = contentAttrOf; }
    Object.defineProperty(proto, attr, {
      configurable: true, enumerable: true,
      get() {
        if (forwarded && isForwardingHost(this)) {
          const win = forwardingWindowOf(this);
          return win ? reflectHandler(win[slotKey]) : null;
        }
        return reflectHandler(this[slotKey]);
      },
      set(v) {
        // WebIDL EventHandler [LegacyTreatNonObjectAsNull]: a non-object primitive
        // → null; an object (callable or not) is stored verbatim.
        const stored = (v !== null && (typeof v === 'object' || typeof v === 'function')) ? v : null;
        if (forwarded && isForwardingHost(this)) {
          const win = forwardingWindowOf(this);
          if (win) setHandlerSlot(win, type, slotKey, wrapKey, stored);
          return;
        }
        setHandlerSlot(this, type, slotKey, wrapKey, stored);
      }
    });
  }
}

// Activate / update / clear a node's inline (content-attribute) event handler from
// an attribute mutation (setAttribute / setAttributeNS / removeAttribute /
// setAttributeNode / Attr#value / parser / clone). `attrName` is the lowercase key;
// a fast `on` prefix gate keeps every other attribute off this path, and only a
// RECOGNISED handler attribute activates. `raw` null clears it. On <body>/<frameset>
// the six window-reflecting handlers drive the Window's handler instead of the
// element's — except when re-activating a detached clone (`fromClone`), which must
// not touch the live window handler.
export function syncInlineEventHandler(node, attrName, raw, fromClone) {
  if (attrName.charCodeAt(0) !== 111 || attrName.charCodeAt(1) !== 110) return;   // not "on…"
  const type = INLINE_HANDLER_TYPE[attrName];
  if (type === undefined || !INLINE_HANDLER_OWNER[attrName](node)) return;
  if (FORWARDED_TYPE.has(type) && isForwardingHost(node)) {
    // (…the window's handler, compiled in its global scope — though not again from a clone's copy of the attributes,
    // which would replace the window's live one)
    const win = !fromClone && forwardingWindowOf(node);
    if (win) setHandlerSlot(win, type, '_eh_' + type, '_ehw_' + type, raw == null ? null : new RawHandler(raw, null, attrName));
    return;
  }
  setHandlerSlot(node, type, '_eh_' + type, '_ehw_' + type, raw == null ? null : new RawHandler(raw, node, attrName));
}

