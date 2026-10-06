// DOM event constructors. Capture / target / bubble dispatch lives
// in bridge.entry.js; this module just defines the value types.

import { HTML_NS } from './constants.js';
import { normalizeDataFormat } from './mime.js';
import { documentElementOf } from './document-tree.js';
import { brandPrototype, defineClassString, interfaceCheck, registerInterface, toDOMString } from './webidl.js';
import {
  WINDOW_EVENT_HANDLERS, convertAnimationEventArguments, convertAnimationPlaybackEventArguments,
  convertClipboardEventArguments, convertCloseEventArguments, convertCompositionEventArguments,
  convertCustomEventArguments, convertDeviceMotionEventArguments, convertDeviceOrientationEventArguments,
  convertDragEventArguments, convertErrorEventArguments, convertEventArguments, convertFocusEventArguments,
  convertFontFaceSetLoadEventArguments, convertFormDataEventArguments, convertGamepadEventArguments,
  convertHashChangeEventArguments, convertIDBVersionChangeEventArguments, convertInputEventArguments,
  convertKeyboardEventArguments, convertMediaQueryListEventArguments, convertMessageEventArguments,
  convertMouseEventArguments, convertPageTransitionEventArguments, convertPointerEventArguments,
  convertPopStateEventArguments, convertProgressEventArguments, convertPromiseRejectionEventArguments,
  convertStorageEventArguments, convertSubmitEventArguments, convertToggleEventArguments,
  convertTransitionEventArguments, convertUIEventArguments, convertWheelEventArguments,
  defineDeviceMotionEventAcceleration, defineDeviceMotionEventRotationRate, installAnimationEvent,
  installAnimationPlaybackEvent, installBeforeUnloadEvent, installClipboardEvent, installCloseEvent,
  installCompositionEvent, installCustomEvent, installDeviceMotionEvent, installDeviceOrientationEvent,
  installDragEvent, installErrorEvent, installEvent, installEventTarget, installFocusEvent,
  installFontFaceSetLoadEvent, installFormDataEvent, installGamepadEvent, installHashChangeEvent,
  installIDBVersionChangeEvent, installInputEvent, installKeyboardEvent, installMediaQueryListEvent,
  installMessageEvent, installMouseEvent, installPageTransitionEvent, installPointerEvent, installPopStateEvent,
  installProgressEvent, installPromiseRejectionEvent, installStorageEvent, installSubmitEvent, installTextEvent,
  installToggleEvent, installTransitionEvent, installUIEvent, installWheelEvent
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
// What tells an event of an interface apart (`dispatchEvent`'s argument, its members' `this`): the interface's
// prototype behind it — any realm's, which brands itself: an iframe's event dispatched here is one — and the fields an
// Event constructor gave it, which the prototype itself, branded too, has none of (Chrome's "Illegal invocation" on
// `MouseEvent.prototype.clientX`).
const eventTest = (brand) => (o) => o !== null && typeof o === 'object' && o[brand] === true && o._dispatchFlag !== undefined;
const EVENT = brandPrototype(Event, 'Event');
registerInterface('Event', eventTest(EVENT));
// The window `o` is: this realm's global, another realm's (a WindowProxy unwrapped), or none — what tells a Window
// apart (window.js's members' `this`; a UIEvent's `view`), registered here, before the event interfaces taking one.
// (…a worker's global none: worker-globals.js makes this realm's one a worker's)
let realmIsWindow = true;
export function markWorkerRealm() { realmIsWindow = false; }
function windowOf(o) {
  if (o === globalThis) return realmIsWindow ? o : null;
  if (o === null || (typeof o !== 'object' && typeof o !== 'function')) return null;
  const raw = o.__csimRawWindow || o;
  return (raw === globalThis && realmIsWindow) || (raw !== globalThis && globalThis.__csimIsWindowGlobal(raw)) ? raw : null;
}
registerInterface('Window', (o) => windowOf(o) !== null);

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
export function initEventSteps(ev, type, bubbles, cancelable) {
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
registerInterface('CustomEvent', eventTest(CUSTOM_EVENT));
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
  constructor(type, init) {
    if (type !== CONVERTED) [type, init] = convertUIEventArguments(arguments);
    else [type, init] = [init, arguments[2]];
    super(CONVERTED, type, init);
    this._view   = init.view;
    this._detail = init.detail;
  }
}

export class FocusEvent extends UIEvent {
  constructor(type, init) {
    if (type !== CONVERTED) [type, init] = convertFocusEventArguments(arguments);
    else [type, init] = [init, arguments[2]];
    super(CONVERTED, type, init);
    this._relatedTarget = init.relatedTarget;
  }
}

export class CompositionEvent extends UIEvent {
  constructor(type, init) {
    if (type !== CONVERTED) [type, init] = convertCompositionEventArguments(arguments);
    else [type, init] = [init, arguments[2]];
    super(CONVERTED, type, init);
    this._data = init.data;
  }
}

// Legacy `TextEvent` (UIEvent subtype) — kept distinct from CompositionEvent so
// `document.createEvent("TextEvent")` reports the right interface.
export class TextEvent extends UIEvent {
  // (…no constructor of its IDL's: `document.createEvent('TextEvent')` makes one, `createTextEvent`)
  constructor(token) {
    if (token !== CONVERTED) throw new TypeError("Failed to construct 'TextEvent': Illegal constructor");
    super(CONVERTED, '', { bubbles: false, cancelable: false, composed: false, view: null, detail: 0, which: 0 });
    this._data = '';
  }
}
export const createTextEvent = () => new TextEvent(CONVERTED);

// Device sensor events (DeviceOrientation Event): a page feature-detects them and constructs them; no sensor here
// fires one. A motion's acceleration and rotation rate are objects of their own interfaces, made from the init's.
export class DeviceMotionEvent extends Event {
  constructor(type, init) {
    if (type !== CONVERTED) [type, init] = convertDeviceMotionEventArguments(arguments);
    else [type, init] = [init, arguments[2]];
    super(CONVERTED, type, init);
    this._acceleration = motionVector(DeviceMotionEventAcceleration, init.acceleration);
    this._accelerationIncludingGravity = motionVector(DeviceMotionEventAcceleration, init.accelerationIncludingGravity);
    this._rotationRate = motionVector(DeviceMotionEventRotationRate, init.rotationRate);
    this._interval = init.interval;
  }
}
// (…none where the init gives none, an object of its interface wherever it gives one, empty too: Chrome's)
function motionVector(binding, init) {
  return init ? binding.create(init) : null;
}
const DeviceMotionEventAcceleration = defineDeviceMotionEventAcceleration({
  init(slots, init) { slots.x = init.x; slots.y = init.y; slots.z = init.z; },
  get_x: (slots) => slots.x,
  get_y: (slots) => slots.y,
  get_z: (slots) => slots.z
});
const DeviceMotionEventRotationRate = defineDeviceMotionEventRotationRate({
  init(slots, init) { slots.alpha = init.alpha; slots.beta = init.beta; slots.gamma = init.gamma; },
  get_alpha: (slots) => slots.alpha,
  get_beta: (slots) => slots.beta,
  get_gamma: (slots) => slots.gamma
});
export const DeviceMotionEventAccelerationInterface = DeviceMotionEventAcceleration.interface;
export const DeviceMotionEventRotationRateInterface = DeviceMotionEventRotationRate.interface;

export class DeviceOrientationEvent extends Event {
  constructor(type, init) {
    if (type !== CONVERTED) [type, init] = convertDeviceOrientationEventArguments(arguments);
    else [type, init] = [init, arguments[2]];
    super(CONVERTED, type, init);
    this._alpha    = init.alpha;
    this._beta     = init.beta;
    this._gamma    = init.gamma;
    this._absolute = init.absolute;
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

// A request's progress (XHR's ProgressEvent): whether its length is known, how much of it has loaded, of how much.
export class ProgressEvent extends Event {
  constructor(type, init) {
    if (type !== CONVERTED) [type, init] = convertProgressEventArguments(arguments);
    else [type, init] = [init, arguments[2]];
    super(CONVERTED, type, init);
    this._lengthComputable = init.lengthComputable;
    this._loaded = init.loaded;
    this._total  = init.total;
  }
}

// HTML's navigation events: a history traversal's `popstate` (its state), a fragment navigation's `hashchange` (the two
// URLs), a document's `pageshow` / `pagehide` (whether it is kept in the back/forward cache, which no document here
// is). Turbo and history-API polyfills construct the first two.
export class PopStateEvent extends Event {
  constructor(type, init) {
    if (type !== CONVERTED) [type, init] = convertPopStateEventArguments(arguments);
    else [type, init] = [init, arguments[2]];
    super(CONVERTED, type, init);
    this._state = init.state;
    this._hasUAVisualTransition = init.hasUAVisualTransition;
  }
}

export class HashChangeEvent extends Event {
  constructor(type, init) {
    if (type !== CONVERTED) [type, init] = convertHashChangeEventArguments(arguments);
    else [type, init] = [init, arguments[2]];
    super(CONVERTED, type, init);
    this._oldURL = init.oldURL;
    this._newURL = init.newURL;
  }
}

export class PageTransitionEvent extends Event {
  constructor(type, init) {
    if (type !== CONVERTED) [type, init] = convertPageTransitionEventArguments(arguments);
    else [type, init] = [init, arguments[2]];
    super(CONVERTED, type, init);
    this._persisted = init.persisted;
  }
}

// A storage area's change, fired at another same-origin document (storage.js, which installs its members: they take
// a Storage).
export class StorageEvent extends Event {
  constructor(type, init) {
    if (type !== CONVERTED) [type, init] = convertStorageEventArguments(arguments);
    else [type, init] = [init, arguments[2]];
    super(CONVERTED, type, init);
    this._key         = init.key;
    this._oldValue    = init.oldValue;
    this._newValue    = init.newValue;
    this._url         = init.url;
    this._storageArea = init.storageArea;
  }
}

// A script's error, reported at its global (`error` — whose handler the event handler processing algorithm calls with
// its five values, so an event of any realm: its brand), and a promise's rejection no handler took (`unhandledrejection`,
// `rejectionhandled`). An ErrorEvent's `error` is `any`, undefined where it was not given.
export class ErrorEvent extends Event {
  constructor(type, init) {
    if (type !== CONVERTED) [type, init] = convertErrorEventArguments(arguments);
    else [type, init] = [init, arguments[2]];
    super(CONVERTED, type, init);
    this._message  = init.message;
    this._filename = init.filename;
    this._lineno   = init.lineno;
    this._colno    = init.colno;
    this._error    = init.error;
  }
}

export class PromiseRejectionEvent extends Event {
  constructor(type, init) {
    if (type !== CONVERTED) [type, init] = convertPromiseRejectionEventArguments(arguments);
    else [type, init] = [init, arguments[2]];
    super(CONVERTED, type, init);
    this._promise = init.promise;
    this._reason  = init.reason;
  }
}

// A media query list's `change` (CSSOM View): whether it matches now, and its query. A database's version change
// (IndexedDB's `upgradeneeded`): its old version and its new. A font set's load (CSS Font Loading's `loadingdone`,
// `loadingerror`): the faces it loaded, a frozen array.
export class MediaQueryListEvent extends Event {
  constructor(type, init) {
    if (type !== CONVERTED) [type, init] = convertMediaQueryListEventArguments(arguments);
    else [type, init] = [init, arguments[2]];
    super(CONVERTED, type, init);
    this._media   = init.media;
    this._matches = init.matches;
  }
}

export class IDBVersionChangeEvent extends Event {
  constructor(type, init) {
    if (type !== CONVERTED) [type, init] = convertIDBVersionChangeEventArguments(arguments);
    else [type, init] = [init, arguments[2]];
    super(CONVERTED, type, init);
    this._oldVersion = init.oldVersion;
    this._newVersion = init.newVersion;
  }
}

export class FontFaceSetLoadEvent extends Event {
  constructor(type, init) {
    if (type !== CONVERTED) [type, init] = convertFontFaceSetLoadEventArguments(arguments);
    else [type, init] = [init, arguments[2]];
    super(CONVERTED, type, init);
    this._fontfaces = Object.freeze(init.fontfaces.slice());
  }
}

// A WebSocket's closing (`close`): whether it closed cleanly, its code and its reason.
export class CloseEvent extends Event {
  constructor(type, init) {
    if (type !== CONVERTED) [type, init] = convertCloseEventArguments(arguments);
    else [type, init] = [init, arguments[2]];
    super(CONVERTED, type, init);
    this._wasClean = init.wasClean;
    this._code     = init.code;
    this._reason   = init.reason;
  }
}

// A CSS animation's and a CSS transition's events (css-animations, css-transitions: their name or property, the time
// elapsed, the pseudo-element — and, of their level 2, the CSSAnimation / CSSTransition itself), and a Web Animation's
// `finish` / `cancel` (its current time and its timeline's).
export class AnimationEvent extends Event {
  constructor(type, init) {
    if (type !== CONVERTED) [type, init] = convertAnimationEventArguments(arguments);
    else [type, init] = [init, arguments[2]];
    super(CONVERTED, type, init);
    this._animationName = init.animationName;
    this._elapsedTime   = init.elapsedTime;
    this._pseudoElement = init.pseudoElement;
    this._animation     = init.animation;
  }
}

export class TransitionEvent extends Event {
  constructor(type, init) {
    if (type !== CONVERTED) [type, init] = convertTransitionEventArguments(arguments);
    else [type, init] = [init, arguments[2]];
    super(CONVERTED, type, init);
    this._propertyName  = init.propertyName;
    this._elapsedTime   = init.elapsedTime;
    this._pseudoElement = init.pseudoElement;
    this._animation     = init.animation;
  }
}

export class AnimationPlaybackEvent extends Event {
  constructor(type, init) {
    if (type !== CONVERTED) [type, init] = convertAnimationPlaybackEventArguments(arguments);
    else [type, init] = [init, arguments[2]];
    super(CONVERTED, type, init);
    this._currentTime  = init.currentTime;
    this._timelineTime = init.timelineTime;
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

// A form's entry list as it is constructed (`formdata`), and its submission (`submit`, whose submitter is the button
// that submitted it, if one did); a popover's, a dialog's or a details element's change of state (`beforetoggle`,
// `toggle`: from and to "open" / "closed", and the element that asked for it).
export class FormDataEvent extends Event {
  constructor(type, init) {
    if (type !== CONVERTED) [type, init] = convertFormDataEventArguments(arguments);
    else [type, init] = [init, arguments[2]];
    super(CONVERTED, type, init);
    this._formData = init.formData;
  }
}

export class SubmitEvent extends Event {
  constructor(type, init) {
    if (type !== CONVERTED) [type, init] = convertSubmitEventArguments(arguments);
    else [type, init] = [init, arguments[2]];
    super(CONVERTED, type, init);
    this._submitter = init.submitter;
  }
}

export class ToggleEvent extends Event {
  constructor(type, init) {
    if (type !== CONVERTED) [type, init] = convertToggleEventArguments(arguments);
    else [type, init] = [init, arguments[2]];
    super(CONVERTED, type, init);
    this._oldState = init.oldState;
    this._newState = init.newState;
    this._source   = init.source;
  }
}

// A document's unloading (`beforeunload`): no constructor of its IDL's — `document.createEvent('BeforeUnloadEvent')` and
// the UA make one (createBeforeUnloadEvent) — its returnValue the legacy prompt text, a DOMString of its own.
export class BeforeUnloadEvent extends Event {
  constructor(token, type, init) {
    if (token !== CONVERTED) throw new TypeError("Failed to construct 'BeforeUnloadEvent': Illegal constructor");
    super(CONVERTED, type, init);
    this._returnValue = '';
  }
}
export const createBeforeUnloadEvent = (type = '', cancelable = false) => (
  new BeforeUnloadEvent(CONVERTED, type, { bubbles: false, cancelable, composed: false })
);

// A gamepad's connection or disconnection: no gamepad is ever connected here, so no Gamepad exists to give one.
export class GamepadEvent extends Event {
  constructor(type, init) {
    if (type !== CONVERTED) [type, init] = convertGamepadEventArguments(arguments);
    else [type, init] = [init, arguments[2]];
    super(CONVERTED, type, init);
    this._gamepad = init.gamepad;
  }
}
registerInterface('Gamepad', () => false);

// EventModifierInit's other modifiers (UI Events), held as the bits of one field.
const MODIFIER_KEYS = ['AltGraph', 'CapsLock', 'Fn', 'FnLock', 'Hyper', 'NumLock', 'ScrollLock', 'Super', 'Symbol', 'SymbolLock'];
const MODIFIER_MEMBERS = MODIFIER_KEYS.map((key) => 'modifier' + key);
function modifierBits(init) {
  let bits = 0;
  for (let i = 0; i < MODIFIER_MEMBERS.length; i++) if (init[MODIFIER_MEMBERS[i]]) bits |= 1 << i;
  return bits;
}

export class MouseEvent extends UIEvent {
  constructor(type, init) {
    if (type !== CONVERTED) [type, init] = convertMouseEventArguments(arguments);
    else [type, init] = [init, arguments[2]];
    super(CONVERTED, type, init);
    this._modifiers = modifierBits(init);
    this._screenX   = init.screenX;
    this._screenY   = init.screenY;
    this._clientX   = init.clientX;
    this._clientY   = init.clientY;
    this._ctrlKey   = init.ctrlKey;
    this._shiftKey  = init.shiftKey;
    this._altKey    = init.altKey;
    this._metaKey   = init.metaKey;
    this._button    = init.button;
    this._buttons   = init.buttons;
    this._relatedTarget = init.relatedTarget;
    this._movementX = init.movementX;
    this._movementY = init.movementY;
  }
}

// WheelEvent extends MouseEvent per the UI Events spec (so a wheel event
// satisfies `instanceof MouseEvent` and carries the pointer-position /
// modifier fields). Defined after MouseEvent for the class reference.
export class WheelEvent extends MouseEvent {
  constructor(type, init) {
    if (type !== CONVERTED) [type, init] = convertWheelEventArguments(arguments);
    else [type, init] = [init, arguments[2]];
    super(CONVERTED, type, init);
    this._deltaX    = init.deltaX;
    this._deltaY    = init.deltaY;
    this._deltaZ    = init.deltaZ;
    this._deltaMode = init.deltaMode;
  }
}

// Pointer Events level 3 — extends MouseEvent so `pointerdown`
// dispatched as PointerEvent still satisfies `instanceof MouseEvent`
// (Stimulus / selector-set delegation expects either).
export class PointerEvent extends MouseEvent {
  constructor(type, init) {
    if (type !== CONVERTED) [type, init] = convertPointerEventArguments(arguments);
    else [type, init] = [init, arguments[2]];
    super(CONVERTED, type, init);
    this._pointerId    = init.pointerId;
    this._width        = init.width;
    this._height       = init.height;
    this._pressure     = init.pressure;
    this._tangentialPressure = init.tangentialPressure;
    this._twist        = init.twist;
    pointerOrientation(this, init);
    this._pointerType  = init.pointerType;
    this._isPrimary    = init.isPrimary;
    this._persistentDeviceId = init.persistentDeviceId;
    this._coalescedEvents = init.coalescedEvents;
    this._predictedEvents = init.predictedEvents;
  }
}

// Pointer Events' orientation of a pointer, given either way (its tilts in degrees, or its altitude and azimuth in
// radians): the init's own, the other pair converted from it — the spec's conversions — and, given neither, a pointer
// perpendicular to the surface (no tilt, an altitude of π/2, an azimuth of 0).
function pointerOrientation(ev, init) {
  const tilted = init.tiltX !== undefined || init.tiltY !== undefined;
  const angled = init.altitudeAngle !== undefined || init.azimuthAngle !== undefined;
  if (tilted || !angled) {
    const tiltX = init.tiltX === undefined ? 0 : init.tiltX, tiltY = init.tiltY === undefined ? 0 : init.tiltY;
    ev._tiltX = tiltX;
    ev._tiltY = tiltY;
    if (angled) {
      ev._altitudeAngle = init.altitudeAngle === undefined ? Math.PI / 2 : init.altitudeAngle;
      ev._azimuthAngle  = init.azimuthAngle === undefined ? 0 : init.azimuthAngle;
      return;
    }
    const x = tiltX * Math.PI / 180, y = tiltY * Math.PI / 180;
    const upright = Math.abs(tiltX) === 90 || Math.abs(tiltY) === 90;
    ev._azimuthAngle = tiltX === 0 ? (tiltY > 0 ? Math.PI / 2 : tiltY < 0 ? 3 * Math.PI / 2 : 0)
      : tiltY === 0 ? (tiltX < 0 ? Math.PI : 0)
      : upright ? 0
      : (Math.atan2(Math.tan(y), Math.tan(x)) + 2 * Math.PI) % (2 * Math.PI);
    ev._altitudeAngle = upright ? 0
      : tiltX === 0 ? Math.PI / 2 - Math.abs(y)
      : tiltY === 0 ? Math.PI / 2 - Math.abs(x)
      : Math.atan(1 / Math.sqrt(Math.tan(x) ** 2 + Math.tan(y) ** 2));
    return;
  }
  const altitude = init.altitudeAngle === undefined ? Math.PI / 2 : init.altitudeAngle;
  const azimuth  = init.azimuthAngle === undefined ? 0 : init.azimuthAngle;
  ev._altitudeAngle = altitude;
  ev._azimuthAngle  = azimuth;
  let x = 0, y = 0;
  if (altitude === 0) {
    // (…lying on the surface: a tilt of ±90° toward the azimuth's quadrant)
    const q = Math.PI / 2;
    x = azimuth === q || azimuth === 3 * q ? 0 : azimuth < q || azimuth > 3 * q ? q : -q;
    y = azimuth === 0 || azimuth === 2 * q || azimuth === 4 * q ? 0 : azimuth < 2 * q ? q : -q;
  } else {
    x = Math.atan(Math.cos(azimuth) / Math.tan(altitude));
    y = Math.atan(Math.sin(azimuth) / Math.tan(altitude));
  }
  ev._tiltX = Math.round(x * 180 / Math.PI);
  ev._tiltY = Math.round(y * 180 / Math.PI);
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

// A `pointermove` the UA fires at `target`: trusted, its coalesced events the one move it is — a trusted move's list
// is never empty (Pointer Events) — trusted too, neither bubbling nor cancelable, at the same target, in the window
// (its page position that window's, as the move's is: dispatch.js dispatchEventForUserAction).
export function trustedPointerMove(target, init) {
  const coalesced = new PointerEvent('pointermove', Object.assign({}, init, { bubbles: false, cancelable: false, composed: true, view: globalThis }));
  coalesced._isTrusted = true;
  coalesced._target = target;
  return new PointerEvent('pointermove', Object.assign({}, init, { coalescedEvents: [coalesced] }));
}

export class DragEvent extends MouseEvent {
  constructor(type, init) {
    if (type !== CONVERTED) [type, init] = convertDragEventArguments(arguments);
    else [type, init] = [init, arguments[2]];
    super(CONVERTED, type, init);
    this._dataTransfer = init.dataTransfer;
  }
}

export class KeyboardEvent extends UIEvent {
  constructor(type, init) {
    if (type !== CONVERTED) [type, init] = convertKeyboardEventArguments(arguments);
    else [type, init] = [init, arguments[2]];
    super(CONVERTED, type, init);
    this._modifiers   = modifierBits(init);
    this._key         = init.key;
    this._code        = init.code;
    this._location    = init.location;
    this._ctrlKey     = init.ctrlKey;
    this._shiftKey    = init.shiftKey;
    this._altKey      = init.altKey;
    this._metaKey     = init.metaKey;
    this._repeat      = init.repeat;
    this._isComposing = init.isComposing;
    this._charCode    = init.charCode;
    this._keyCode     = init.keyCode;
  }
}

export class InputEvent extends UIEvent {
  constructor(type, init) {
    if (type !== CONVERTED) [type, init] = convertInputEventArguments(arguments);
    else [type, init] = [init, arguments[2]];
    super(CONVERTED, type, init);
    this._data         = init.data;
    this._inputType    = init.inputType;
    this._isComposing  = init.isComposing;
    this._dataTransfer = init.dataTransfer;
    this._targetRanges = init.targetRanges;
  }
}

// A clipboard action's event (`cut`, `copy`, `paste`): its clipboard data, a DataTransfer (dom-nodes
// performClipboardGesture). Trix and Avo's image-cropper read `event.clipboardData.getData(...)`.
export class ClipboardEvent extends Event {
  constructor(type, init) {
    if (type !== CONVERTED) [type, init] = convertClipboardEventArguments(arguments);
    else [type, init] = [init, arguments[2]];
    super(CONVERTED, type, init);
    this._clipboardData = init.clipboardData;
  }
}

// A message (HTML): its data — `any`, null where the init leaves it out — the origin and last event id, the window,
// port or service worker that sent it, and the ports it carries, a frozen array.
export class MessageEvent extends Event {
  constructor(type, init) {
    if (type !== CONVERTED) [type, init] = convertMessageEventArguments(arguments);
    else [type, init] = [init, arguments[2]];
    super(CONVERTED, type, init);
    this._data        = init.data;
    this._origin      = init.origin;
    this._lastEventId = init.lastEventId;
    this._source      = init.source;
    this._ports       = Object.freeze(init.ports.slice());
  }
}
// The UA's message: its fields as the sender's steps give them, never converted — `postMessage(undefined)` delivers
// undefined, which an init's conversion would make its default null.
export function createMessageEvent(type, fields) {
  return new MessageEvent(CONVERTED, type, {
    bubbles: false,
    cancelable: false,
    composed: false,
    data: 'data' in fields ? fields.data : null,
    origin: fields.origin ?? '',
    lastEventId: fields.lastEventId ?? '',
    source: fields.source ?? null,
    ports: fields.ports ?? []
  });
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
    if (event._type === 'error' && interfaceCheck('ErrorEvent')(event)) {
      const handled = h.call(globalThis, event._message, event._filename, event._lineno, event._colno, event._error);
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
        if (ev._type === 'error' && isGlobal(node) && interfaceCheck('ErrorEvent')(ev)) {
          const ret = cb.call(node, ev._message, ev._filename, ev._lineno, ev._colno, ev._error);
          if (ret === true && ev._cancelable) ev._canceled = true;
          return;
        }
        const ret = cb.call(node, ev);
        if (ev._type === 'beforeunload' && interfaceCheck('BeforeUnloadEvent')(ev)) {
          if (ret != null) {
            if (ev._cancelable) ev._canceled = true;
            if (ev._returnValue === '') ev._returnValue = toDOMString(ret);
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

// The UI Events' members (generated/bindings.js), each event's state its fields — installed after EventTarget's brand
// (`initMouseEvent`'s relatedTarget takes one).
// (…`which` the legacy alias Chrome and Firefox answer: a mouse event's button + 1, a keyboard event's key code, 0 for
// any other — the init's own `which` neither reads)
for (const iface of [UIEvent, FocusEvent, MouseEvent, WheelEvent, PointerEvent, DragEvent, KeyboardEvent, InputEvent, CompositionEvent, TextEvent]) {
  registerInterface(iface.name, eventTest(brandPrototype(iface, iface.name)));
}
installUIEvent(UIEvent, {
  get_view: (ev) => ev._view,
  get_detail: (ev) => ev._detail,
  // (…nothing mid-dispatch; else the event's initialisation, then its view and detail)
  initUIEvent(ev, type, bubbles, cancelable, view, detail) {
    if (ev._dispatchFlag) return;
    initEventSteps(ev, type, bubbles, cancelable);
    ev._view = view;
    ev._detail = detail;
  },
  get_which: (ev) => (ev._button !== undefined ? ev._button + 1 : ev._keyCode !== undefined ? ev._keyCode : 0)
});
installFocusEvent(FocusEvent, { get_relatedTarget: (ev) => ev._relatedTarget });
// UI Events' getModifierState: whether the given key was held — the four the init's flags name, the others its
// `modifier*` members (and 'Accel' the Control key, as Chrome and Firefox answer on Linux).
function modifierState(ev, key) {
  switch (key) {
    case 'Alt':     return ev._altKey;
    case 'Accel':
    case 'Control': return ev._ctrlKey;
    case 'Meta':    return ev._metaKey;
    case 'Shift':   return ev._shiftKey;
  }
  const i = MODIFIER_KEYS.indexOf(key);
  return i !== -1 && (ev._modifiers & (1 << i)) !== 0;
}
// CSSOM View's coordinates of a mouse event: its page position the client one and its window's scroll — the scroll
// when it was dispatched at the target (a dispatching event's), else its view's, none without one — and its offset
// from the target's padding edge while it is dispatched, its page position otherwise. (`layerX` / `layerY`, which no
// spec defines beyond "the current layer", the page position: no layer is modelled, and a page with no positioned
// ancestor is Chrome's.)
function pageXOf(ev) {
  const view = ev._dispatchFlag ? globalThis : ev._view && (ev._view.__csimRawWindow || ev._view);
  return ev._clientX + (view ? view.__csimWindowSteps.get_scrollX(view) : 0);
}
function pageYOf(ev) {
  const view = ev._dispatchFlag ? globalThis : ev._view && (ev._view.__csimRawWindow || ev._view);
  return ev._clientY + (view ? view.__csimWindowSteps.get_scrollY(view) : 0);
}
function offsetOf(ev, axis) {
  const target = ev._target;
  if (!ev._dispatchFlag || !target || target._nodeType !== 1) return axis === 'x' ? pageXOf(ev) : pageYOf(ev);
  const origin = globalThis.__csimPaddingEdgeOrigin(target);
  return axis === 'x' ? ev._clientX - origin.x : ev._clientY - origin.y;
}
installMouseEvent(MouseEvent, {
  get_screenX: (ev) => ev._screenX,
  get_screenY: (ev) => ev._screenY,
  get_clientX: (ev) => ev._clientX,
  get_clientY: (ev) => ev._clientY,
  get_layerX: (ev) => pageXOf(ev),
  get_layerY: (ev) => pageYOf(ev),
  get_ctrlKey: (ev) => ev._ctrlKey,
  get_shiftKey: (ev) => ev._shiftKey,
  get_altKey: (ev) => ev._altKey,
  get_metaKey: (ev) => ev._metaKey,
  get_button: (ev) => ev._button,
  get_buttons: (ev) => ev._buttons,
  get_relatedTarget: (ev) => ev._relatedTarget,
  getModifierState: (ev, key) => modifierState(ev, key),
  // (…nothing mid-dispatch; else the event's initialisation, then the rest of the arguments)
  initMouseEvent(ev, type, bubbles, cancelable, view, detail, screenX, screenY, clientX, clientY, ctrlKey, altKey, shiftKey, metaKey, button, relatedTarget) {
    if (ev._dispatchFlag) return;
    initEventSteps(ev, type, bubbles, cancelable);
    Object.assign(ev, {
      _view: view, _detail: detail, _screenX: screenX, _screenY: screenY, _clientX: clientX, _clientY: clientY,
      _ctrlKey: ctrlKey, _altKey: altKey, _shiftKey: shiftKey, _metaKey: metaKey, _button: button, _relatedTarget: relatedTarget
    });
  },
  get_pageX: (ev) => pageXOf(ev),
  get_pageY: (ev) => pageYOf(ev),
  get_x: (ev) => ev._clientX,
  get_y: (ev) => ev._clientY,
  get_offsetX: (ev) => offsetOf(ev, 'x'),
  get_offsetY: (ev) => offsetOf(ev, 'y'),
  get_movementX: (ev) => ev._movementX,
  get_movementY: (ev) => ev._movementY
});
installWheelEvent(WheelEvent, {
  get_deltaX: (ev) => ev._deltaX,
  get_deltaY: (ev) => ev._deltaY,
  get_deltaZ: (ev) => ev._deltaZ,
  get_deltaMode: (ev) => ev._deltaMode
});
// (…its coalesced and predicted events the init's: a trusted `pointermove`'s, trustedPointerMove)
installPointerEvent(PointerEvent, {
  get_pointerId: (ev) => ev._pointerId,
  get_width: (ev) => ev._width,
  get_height: (ev) => ev._height,
  get_pressure: (ev) => ev._pressure,
  get_tangentialPressure: (ev) => ev._tangentialPressure,
  get_tiltX: (ev) => ev._tiltX,
  get_tiltY: (ev) => ev._tiltY,
  get_twist: (ev) => ev._twist,
  get_altitudeAngle: (ev) => ev._altitudeAngle,
  get_azimuthAngle: (ev) => ev._azimuthAngle,
  get_pointerType: (ev) => ev._pointerType,
  get_isPrimary: (ev) => ev._isPrimary,
  get_persistentDeviceId: (ev) => ev._persistentDeviceId,
  getCoalescedEvents: (ev) => ev._coalescedEvents.slice(),
  getPredictedEvents: (ev) => ev._predictedEvents.slice()
});
installDragEvent(DragEvent, { get_dataTransfer: (ev) => ev._dataTransfer });

// The other specs' events (generated/bindings.js), each event's state its fields.
for (const iface of [
  PopStateEvent, HashChangeEvent, PageTransitionEvent, BeforeUnloadEvent, ErrorEvent, PromiseRejectionEvent, FormDataEvent,
  SubmitEvent, ToggleEvent, StorageEvent, MessageEvent, ProgressEvent, CloseEvent, AnimationEvent, TransitionEvent,
  AnimationPlaybackEvent, ClipboardEvent, GamepadEvent, DeviceMotionEvent, DeviceOrientationEvent, MediaQueryListEvent,
  IDBVersionChangeEvent, FontFaceSetLoadEvent
]) {
  registerInterface(iface.name, eventTest(brandPrototype(iface, iface.name)));
}
installPopStateEvent(PopStateEvent, {
  get_state: (ev) => ev._state,
  get_hasUAVisualTransition: (ev) => ev._hasUAVisualTransition
});
installHashChangeEvent(HashChangeEvent, { get_oldURL: (ev) => ev._oldURL, get_newURL: (ev) => ev._newURL });
installPageTransitionEvent(PageTransitionEvent, { get_persisted: (ev) => ev._persisted });
installBeforeUnloadEvent(BeforeUnloadEvent, {
  get_returnValue: (ev) => ev._returnValue,
  set_returnValue(ev, v) { ev._returnValue = v; }
});
installErrorEvent(ErrorEvent, {
  get_message: (ev) => ev._message,
  get_filename: (ev) => ev._filename,
  get_lineno: (ev) => ev._lineno,
  get_colno: (ev) => ev._colno,
  get_error: (ev) => ev._error
});
installPromiseRejectionEvent(PromiseRejectionEvent, { get_promise: (ev) => ev._promise, get_reason: (ev) => ev._reason });
installFormDataEvent(FormDataEvent, { get_formData: (ev) => ev._formData });
installSubmitEvent(SubmitEvent, { get_submitter: (ev) => ev._submitter });
installToggleEvent(ToggleEvent, {
  get_oldState: (ev) => ev._oldState,
  get_newState: (ev) => ev._newState,
  get_source: (ev) => ev._source
});
installStorageEvent(StorageEvent, {
  get_key: (ev) => ev._key,
  get_oldValue: (ev) => ev._oldValue,
  get_newValue: (ev) => ev._newValue,
  get_url: (ev) => ev._url,
  get_storageArea: (ev) => ev._storageArea,
  // (…nothing mid-dispatch; else the event's initialisation, then the rest of the arguments)
  initStorageEvent(ev, type, bubbles, cancelable, key, oldValue, newValue, url, storageArea) {
    if (ev._dispatchFlag) return;
    initEventSteps(ev, type, bubbles, cancelable);
    Object.assign(ev, { _key: key, _oldValue: oldValue, _newValue: newValue, _url: url, _storageArea: storageArea });
  }
});
installMessageEvent(MessageEvent, {
  get_data: (ev) => ev._data,
  get_origin: (ev) => ev._origin,
  get_lastEventId: (ev) => ev._lastEventId,
  get_source: (ev) => ev._source,
  get_ports: (ev) => ev._ports,
  // (…nothing mid-dispatch; else the event's initialisation, then the rest of the arguments)
  initMessageEvent(ev, type, bubbles, cancelable, data, origin, lastEventId, source, ports) {
    if (ev._dispatchFlag) return;
    initEventSteps(ev, type, bubbles, cancelable);
    Object.assign(ev, { _data: data, _origin: origin, _lastEventId: lastEventId, _source: source, _ports: Object.freeze(ports.slice()) });
  }
});
installProgressEvent(ProgressEvent, {
  get_lengthComputable: (ev) => ev._lengthComputable,
  get_loaded: (ev) => ev._loaded,
  get_total: (ev) => ev._total
});
installCloseEvent(CloseEvent, { get_wasClean: (ev) => ev._wasClean, get_code: (ev) => ev._code, get_reason: (ev) => ev._reason });
installAnimationEvent(AnimationEvent, {
  get_animationName: (ev) => ev._animationName,
  get_elapsedTime: (ev) => ev._elapsedTime,
  get_pseudoElement: (ev) => ev._pseudoElement,
  get_animation: (ev) => ev._animation
});
installTransitionEvent(TransitionEvent, {
  get_propertyName: (ev) => ev._propertyName,
  get_elapsedTime: (ev) => ev._elapsedTime,
  get_pseudoElement: (ev) => ev._pseudoElement,
  get_animation: (ev) => ev._animation
});
installAnimationPlaybackEvent(AnimationPlaybackEvent, { get_currentTime: (ev) => ev._currentTime, get_timelineTime: (ev) => ev._timelineTime });
installClipboardEvent(ClipboardEvent, { get_clipboardData: (ev) => ev._clipboardData });
installMediaQueryListEvent(MediaQueryListEvent, { get_media: (ev) => ev._media, get_matches: (ev) => ev._matches });
installIDBVersionChangeEvent(IDBVersionChangeEvent, { get_oldVersion: (ev) => ev._oldVersion, get_newVersion: (ev) => ev._newVersion });
installFontFaceSetLoadEvent(FontFaceSetLoadEvent, { get_fontfaces: (ev) => ev._fontfaces });
installGamepadEvent(GamepadEvent, { get_gamepad: (ev) => ev._gamepad });
// (…no sensor to ask a permission of: denied, as a desktop's browser without one answers)
installDeviceMotionEvent(DeviceMotionEvent, {
  get_acceleration: (ev) => ev._acceleration,
  get_accelerationIncludingGravity: (ev) => ev._accelerationIncludingGravity,
  get_rotationRate: (ev) => ev._rotationRate,
  get_interval: (ev) => ev._interval,
  requestPermission: () => Promise.resolve('denied')
});
installDeviceOrientationEvent(DeviceOrientationEvent, {
  get_alpha: (ev) => ev._alpha,
  get_beta: (ev) => ev._beta,
  get_gamma: (ev) => ev._gamma,
  get_absolute: (ev) => ev._absolute,
  requestPermission: () => Promise.resolve('denied')
});
installKeyboardEvent(KeyboardEvent, {
  get_key: (ev) => ev._key,
  get_code: (ev) => ev._code,
  get_location: (ev) => ev._location,
  get_ctrlKey: (ev) => ev._ctrlKey,
  get_shiftKey: (ev) => ev._shiftKey,
  get_altKey: (ev) => ev._altKey,
  get_metaKey: (ev) => ev._metaKey,
  get_repeat: (ev) => ev._repeat,
  get_isComposing: (ev) => ev._isComposing,
  getModifierState: (ev, key) => modifierState(ev, key),
  // (…nothing mid-dispatch; else the event's initialisation, then its view, key, location and modifiers)
  initKeyboardEvent(ev, type, bubbles, cancelable, view, key, location, ctrlKey, altKey, shiftKey, metaKey) {
    if (ev._dispatchFlag) return;
    initEventSteps(ev, type, bubbles, cancelable);
    Object.assign(ev, { _view: view, _key: key, _location: location, _ctrlKey: ctrlKey, _altKey: altKey, _shiftKey: shiftKey, _metaKey: metaKey });
  },
  get_charCode: (ev) => ev._charCode,
  get_keyCode: (ev) => ev._keyCode
});
// (…its target ranges until its dispatch ends: dispatch.js)
installInputEvent(InputEvent, {
  get_data: (ev) => ev._data,
  get_isComposing: (ev) => ev._isComposing,
  get_inputType: (ev) => ev._inputType,
  get_dataTransfer: (ev) => ev._dataTransfer,
  getTargetRanges: (ev) => ev._targetRanges.slice()
});
installCompositionEvent(CompositionEvent, {
  get_data: (ev) => ev._data,
  initCompositionEvent(ev, type, bubbles, cancelable, view, data) {
    if (ev._dispatchFlag) return;
    initEventSteps(ev, type, bubbles, cancelable);
    ev._view = view;
    ev._data = data;
  }
});
installTextEvent(TextEvent, {
  get_data: (ev) => ev._data,
  initTextEvent(ev, type, bubbles, cancelable, view, data) {
    if (ev._dispatchFlag) return;
    initEventSteps(ev, type, bubbles, cancelable);
    ev._view = view;
    ev._data = data;
  }
});
