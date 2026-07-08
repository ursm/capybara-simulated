// DOM event constructors. Capture / target / bubble dispatch lives
// in bridge.entry.js; this module just defines the value types.

// Unwrap a cross-realm WindowProxy to its raw global (no-op for everything else),
// so EventTarget methods invoked through a proxy operate on the real window.
function unwrapWin(o) {
  return globalThis.__csimUnwrapWindow ? globalThis.__csimUnwrapWindow(o) : o;
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
  const nt = target && target.nodeType;
  if (nt === 9) return true;                                    // Document
  if (nt === 1 && target.ownerDocument) {                       // documentElement / body
    const doc = target.ownerDocument;
    if (target === doc.documentElement || target._tag === 'body') return true;
  }
  return false;
}

// Spec "inner invoke": a `once` listener is removed *before* its callback runs.
// Set `removed` so an in-flight dispatch's `list.slice()` snapshot skips the
// still-referenced entry (keeping a self-re-dispatching `once` callback from
// re-entering itself), and splice it out of the live array so the stored list
// doesn't accumulate fired one-shots. Shared by the Node and window dispatch
// loops so the removal semantics can't drift between them.
export function removeOnceListener(entry, listArr) {
  entry.removed = true;
  if (listArr) {
    const i = listArr.indexOf(entry);
    if (i !== -1) listArr.splice(i, 1);
  }
}

export class Event {
  constructor(type, init) {
    init = init || {};
    this.type             = String(type);
    this.bubbles          = !!init.bubbles;
    this.cancelable       = !!init.cancelable;
    this.composed         = !!init.composed;
    this.defaultPrevented = false;
    this.target           = null;
    this._currentTarget   = null;
    this.eventPhase       = 0;
    this.isTrusted        = false;
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
    // Event-timestamp-high-resolution). One performance.now() per event is
    // negligible next to the dispatch work.
    this._ts = (typeof globalThis.performance !== 'undefined' && globalThis.performance.now)
      ? globalThis.performance.now() : Date.now();
  }
  get timeStamp() {
    // Eagerly set in the ctor; lazy fallback for any event not built through it.
    if (this._ts == null) {
      this._ts = (typeof globalThis.performance !== 'undefined' && globalThis.performance.now)
        ? globalThis.performance.now() : Date.now();
    }
    return this._ts;
  }
  preventDefault()           { if (this.cancelable && !this._inPassiveListener) this.defaultPrevented = true; }
  stopPropagation()          { this._propagationStopped = true; }
  stopImmediatePropagation() { this._propagationStopped = true; this._immediatePropagationStopped = true; }
  // Legacy `cancelBubble`: reads the stop-propagation flag; setting it true is
  // an alias for stopPropagation(); setting it false has NO effect (you can't
  // un-stop propagation), per the DOM spec.
  get cancelBubble()  { return this._propagationStopped; }
  set cancelBubble(v) { if (v) this._propagationStopped = true; }
  // Legacy `initEvent(type, bubbles, cancelable)` (for events made via
  // `document.createEvent`). DOM spec step 1: if this's dispatch flag is set,
  // return — re-initialising an event mid-dispatch is a no-op. Otherwise mark
  // it initialized, clear the propagation/canceled flags + target, and set the
  // three attributes.
  initEvent(type, bubbles, cancelable) {
    // WebIDL arity check runs before the method body, so it throws even
    // mid-dispatch (before the dispatch-flag no-op below).
    if (arguments.length < 1) throw new TypeError("Failed to execute 'initEvent' on 'Event': 1 argument required, but only 0 present.");
    if (this._dispatchFlag) return;
    this._initialized = true;
    this._propagationStopped = false;
    this._immediatePropagationStopped = false;
    this.defaultPrevented = false;
    this.isTrusted = false;
    this.target = null;
    this.type = String(type);
    this.bubbles = !!bubbles;
    this.cancelable = !!cancelable;
  }
  // Bubbling chain from target to document to window, threaded through
  // shadow boundaries per the DOM spec. A ShadowRoot's `_parent` is its
  // host, so the `_parent` walk climbs across boundaries for free; a
  // `composed === false` event stops at its first ShadowRoot
  // (encapsulation). Per
  // https://dom.spec.whatwg.org/#dom-event-composedpath the result is
  // computed from `currentTarget`'s perspective: nodes inside a shadow
  // tree the current target can't see are hidden. Modern delegation
  // (Stimulus / Lit) reads composedPath() inside a listener rather than
  // walking currentTarget manually.
  composedPath() {
    // Outside dispatch the event's path is empty, so composedPath() is the
    // empty list (the dispatch algorithm empties it on cleanup). Library
    // probes read it from within a listener, where the flag is set.
    if (!this._dispatchFlag) return [];
    const structs = this._csimPath;
    if (!structs) {
      // FAST PATH (no shadow trees): the flattened tree is the node tree, so
      // composedPath is just the target -> root `_parent` walk plus
      // document / window. No retargeting, no per-listener trimming.
      const full = [];
      for (let n = this.target; n; n = n._parent) full.push(n);
      const top = full[full.length - 1];
      if (top && top.nodeType === 9) {   // reached the document
        if (!full.includes(globalThis)) full.push(globalThis);
      }
      return retargetWindowsInPath(full);
    }
    // Shadow case: trim the precomputed event path to what `currentTarget` may
    // observe, per the DOM composedPath algorithm
    // (https://dom.spec.whatwg.org/#dom-event-composedpath) using the
    // root-of-closed-tree / slot-in-closed-tree flags carried on each struct.
    const ct = this._currentTarget;
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
  get srcElement() { return this.target; }
  // Legacy IE alias of `!defaultPrevented`. Reading returns whether the
  // default action is still allowed; assigning `false` cancels it
  // (assigning anything else is a no-op), matching the HTML spec's
  // `returnValue` accessor on Event.
  get returnValue() { return !this.defaultPrevented; }
  set returnValue(v) { if (v === false) this.preventDefault(); }
}
for (const [k, v] of [['NONE', 0], ['CAPTURING_PHASE', 1], ['AT_TARGET', 2], ['BUBBLING_PHASE', 3]]) {
  Object.defineProperty(Event,           k, { value: v, enumerable: true });
  Object.defineProperty(Event.prototype, k, { value: v, enumerable: true });
}
// `currentTarget` lives on the prototype as a getter/setter so
// selector-set / Rails-UJS-style delegated handlers can override
// it via `Object.defineProperty(event, 'currentTarget', {get: ...})`.
// Without a prototype descriptor, `Object.getOwnPropertyDescriptor(
// Event.prototype, 'currentTarget')` returns undefined and the
// selector-set library's `S(e, t)` function silently skips the
// override — leaving `currentTarget` set to `document` instead of
// the matched ancestor, so Mastodon's `data-method` handler's
// `e.currentTarget instanceof HTMLAnchorElement` check fails.
Object.defineProperty(Event.prototype, 'currentTarget', {
  configurable: true,
  enumerable:   true,
  get() { return this._currentTarget; },
  set(v) { this._currentTarget = v; }
});

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

export class CustomEvent extends Event {
  constructor(type, init) {
    super(type, init);
    this.detail = init && init.detail !== undefined ? init.detail : null;
  }
  // Legacy initialiser per the HTML spec — kept for libraries that
  // construct `document.createEvent('CustomEvent')` then
  // `initCustomEvent(...)`. Overwrites type / bubbles / cancelable /
  // detail in place, mirroring `Event#initEvent`.
  initCustomEvent(type, bubbles, cancelable, detail) {
    if (arguments.length < 1) throw new TypeError("Failed to execute 'initCustomEvent' on 'CustomEvent': 1 argument required, but only 0 present.");
    if (this._dispatchFlag) return;
    // Pass an explicit arity to initEvent so its own mandatory-first-arg
    // check never mis-fires, and default `detail` to null (spec default).
    this.initEvent(type, bubbles, cancelable);
    this.detail = detail === undefined ? null : detail;
  }
}

// UIEvent — base for any event with a `view` (window) + `detail`
// (click count, wheel delta). Spec parent of MouseEvent / KeyboardEvent /
// FocusEvent / WheelEvent / CompositionEvent / InputEvent.
export class UIEvent extends Event {
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
    this.initEvent(type, bubbles, cancelable);
    this.view   = view != null ? view : null;
    this.detail = detail || 0;
  }
}

export class FocusEvent extends UIEvent {
  constructor(type, init) {
    super(type, init);
    this.relatedTarget = (init && init.relatedTarget) || null;
  }
}

export class CompositionEvent extends UIEvent {
  constructor(type, init) {
    super(type, init);
    this.data = init && init.data != null ? String(init.data) : '';
  }
}

// Legacy `TextEvent` (UIEvent subtype) — kept distinct from CompositionEvent so
// `document.createEvent("TextEvent")` reports the right interface.
export class TextEvent extends UIEvent {
  constructor(type, init) {
    super(type, init);
    this.data = init && init.data != null ? String(init.data) : '';
  }
}

// Device sensor events — minimal interfaces so `document.createEvent(…)` and
// feature-detection (`"DeviceMotionEvent" in window`) see the right type. No
// real sensor data (no layout/hardware backend).
export class DeviceMotionEvent extends Event {
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
  constructor(type, init) {
    super(type, init);
    this.state = init && 'state' in init ? init.state : null;
  }
}

export class HashChangeEvent extends Event {
  constructor(type, init) {
    super(type, init);
    init = init || {};
    this.oldURL = init.oldURL || '';
    this.newURL = init.newURL || '';
  }
}

export class StorageEvent extends Event {
  constructor(type, init) {
    super(type, init);
    init = init || {};
    this.key         = init.key == null         ? null : String(init.key);
    this.oldValue    = init.oldValue == null    ? null : String(init.oldValue);
    this.newValue    = init.newValue == null    ? null : String(init.newValue);
    // `url` is a USVString (unpaired surrogates → U+FFFD); default "" when absent.
    this.url         = init.url == null ? '' : (globalThis.__csimToUSVString ? globalThis.__csimToUSVString(init.url) : String(init.url));
    this.storageArea = init.storageArea || null;
  }
}

export class ErrorEvent extends Event {
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

export class PromiseRejectionEvent extends Event {
  constructor(type, init) {
    super(type, init);
    init = init || {};
    this.promise = init.promise || null;
    this.reason  = init.reason;
  }
}

export class AnimationEvent extends Event {
  constructor(type, init) {
    super(type, init);
    init = init || {};
    this.animationName = init.animationName || '';
    this.elapsedTime   = init.elapsedTime   || 0;
    this.pseudoElement = init.pseudoElement || '';
  }
}

export class TransitionEvent extends Event {
  constructor(type, init) {
    super(type, init);
    init = init || {};
    this.propertyName  = init.propertyName  || '';
    this.elapsedTime   = init.elapsedTime   || 0;
    this.pseudoElement = init.pseudoElement || '';
  }
}

export class FormDataEvent extends Event {
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

export class GamepadEvent extends Event {
  constructor(type, init) {
    super(type, init);
    this.gamepad = (init && 'gamepad' in init) ? init.gamepad : null;
  }
}

export class MouseEvent extends UIEvent {
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
    this.initEvent(type, bubbles, cancelable);
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

export class DragEvent extends MouseEvent {
  constructor(type, init) {
    super(type, init);
    this.dataTransfer = (init && init.dataTransfer) || null;
  }
}

export class KeyboardEvent extends UIEvent {
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
    this.initEvent(type, bubbles, cancelable);
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
        getData(kind) { return (kind === 'text' || kind === 'text/plain') ? text : ''; },
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
function toFrozenPorts(ports) {
  if (ports === undefined) return Object.freeze([]);
  if (ports === null || typeof ports[Symbol.iterator] !== 'function') {
    throw new TypeError("Failed to construct 'MessageEvent': The provided value cannot be converted to a sequence.");
  }
  return Object.freeze(Array.from(ports));
}

export class MessageEvent extends Event {
  constructor(type, init) {
    super(type, init);
    init = init || {};
    this.data        = init.data == null ? null : init.data;
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
  // like the constructor), then the base reset (`initEvent`) applies the dispatch-flag
  // no-op + flag/target/isTrusted clears before the message-specific members are set.
  initMessageEvent(type) {
    const a = arguments;
    if (a.length < 1) throw new TypeError("Failed to execute 'initMessageEvent' on 'MessageEvent': 1 argument required, but only 0 present.");
    const ports = toFrozenPorts(a.length > 7 ? a[7] : undefined);
    if (this._dispatchFlag) return;
    this.initEvent(String(type), a.length > 1 ? !!a[1] : false, a.length > 2 ? !!a[2] : false);
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
  if (evt && typeof evt === 'object') evt._uaFired = true;
  try { target.dispatchEvent(evt); } catch (_) {}
}

// DOM "flatten options": the add/removeEventListener `options` arg is
// `(AddEventListenerOptions or boolean)`. An object → `!!options.capture`; a
// non-object primitive → ToBoolean (so `addEventListener(t, fn, 2.3)` captures,
// `…, "")` does not); null/undefined → false. Shared by EventTarget / Node /
// Window so the single listener implementation below can serve all three.
export function flattenCapture(options) {
  if (options == null) return false;
  if (typeof options === 'object') return !!options.capture;
  return !!options;
}

// `EventTarget` is the ONE listener implementation for the whole platform:
// plain EventTargets (`class Foo extends EventTarget` — XHR / FileReader / IDB /
// Worker / AbortSignal / Avo's date-picker …), DOM nodes (Node assigns these
// add/remove methods to its prototype — see dom-nodes.js), and the Window
// (window-events.js points `globalThis.{add,remove,dispatch}EventListener` at
// these). Sharing one implementation makes `window.addEventListener ===
// EventTarget.prototype.addEventListener` (WPT window-extends-event-target) and
// lets a method invoked with a different `this` operate on that target.
//
// Listeners live in `_listeners` (type → [{handler,isObject,capture,passive,
// once,removed}]) — the same store the DOM tree walker (dispatch.js
// fireListeners) and the Window walker (window-events.js fireWindowListeners)
// read, so registering through any of the three surfaces is mutually visible.
// Nodes override `dispatchEvent` with the capture/bubble tree walk; this base
// `dispatchEvent` is the flat AT_TARGET fire used by plain EventTargets and the
// Window.

// DOM "inner invoke" sets the legacy `window.event` (current event) on EACH
// listener callback's RELEVANT GLOBAL, then restores it — not once per dispatch.
// `perRealmCurrentEvent()` is the cheap gate (property reads only) choosing the
// model for this dispatch:
//   - SINGLE-realm page (the common case — top frame, no iframes): false → set
//     `globalThis.event` once for the whole dispatch (the hot path, zero
//     per-listener cost).
//   - MULTI-realm page (top frame owns iframe realms, OR this dispatch runs
//     INSIDE a child realm — its `top` points at the parent): true → per-listener
//     set/restore on each callback's own realm via invokeWithCurrentEvent. That
//     pays one `contextOf` native crossing per listener (same-realm callbacks
//     short-circuit in __csimRealmGlobalOf without the second `contextGlobal`),
//     which is why it's gated to multi-realm pages — the base EventTarget/window
//     dispatch this guards is far cooler than the Node dispatch (dispatch.js),
//     which keeps the per-dispatch model unchanged (rule 3).
function perRealmCurrentEvent() {
  return !!((globalThis.__csimChildRealmIds && globalThis.__csimChildRealmIds.size) ||
            (globalThis.top && globalThis.top !== globalThis));
}

// Invoke an event LISTENER (`handler`, a function or — `isObject` — an object
// with a `handleEvent`) or an on-handler with the legacy current event set on
// the LISTENER's realm global for the duration — INCLUDING HTML "report the
// exception" if it throws (the realm `event` is restored only as DOM "inner
// invoke"'s last step, the `finally`). Single-realm pages (`perRealm` false)
// leave the dispatch-level `globalThis.event` in place; multi-realm pages
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
function invokeWithCurrentEvent(perRealm, handler, isObject, thisArg, event) {
  let g = null, prev;
  if (perRealm) {
    g = (globalThis.__csimRealmGlobalOf && globalThis.__csimRealmGlobalOf(handler)) || globalThis;
    prev = g.event;
    g.event = event;
    // WindowProxy retargeting: when the event target is a WINDOW and this listener
    // belongs to ANOTHER realm, present `event.target` as that realm's WindowProxy
    // for the window — so a cross-realm listener (and a post-dispatch reader in its
    // realm) sees the same object `contentWindow`/`parent` yields (Event-dispatch-
    // throwing-multiple-globals: `errorEvent.target === iframe.contentWindow`). Not
    // restored afterward: like a real browser, `event.target` stays the WindowProxy.
    if (g !== globalThis && event && g.__csimFrameWindowProxyFor && globalThis.RustyRacer &&
        globalThis.__csimIsWindowGlobal && globalThis.__csimIsWindowGlobal(event.target)) {
      try {
        const proxied = g.__csimFrameWindowProxyFor(globalThis.RustyRacer.contextOf(event.target));
        if (proxied && proxied !== event.target) {
          if (event.currentTarget === event.target) event.currentTarget = proxied;
          event.target = proxied;
        }
      } catch (_) {}
    }
  }
  try {
    const cb = isObject ? handler.handleEvent : handler;
    if (typeof cb !== 'function') throw new TypeError("Failed to invoke event listener: the 'handleEvent' property is not callable.");
    cb.call(thisArg, event);
  } catch (e) {
    try { globalThis.__csimReportListenerError(handler, e); } catch (_) {}
  } finally {
    if (g) g.event = prev;
  }
}

export class EventTarget {
  addEventListener(type, handler, options) {
    // A WindowProxy (cross-realm window ref) unwraps to its raw global so the
    // listener lands where events actually fire. WebIDL: nullish `this` → Window.
    const self = unwrapWin(this == null ? globalThis : this);
    const capture = flattenCapture(options);
    let isObject = false;
    if (typeof handler === 'function') { /* function callback */ }
    else if (handler !== null && typeof handler === 'object') isObject = true;
    else return;   // null / undefined / primitive → no-op
    const passive = (options && typeof options === 'object' && options.passive !== undefined)
      ? !!options.passive
      : defaultPassiveValue(type, self);
    const once = !!(options && typeof options === 'object' && options.once);
    // Keep the listener store off the enumerable surface (Object.keys / for-in /
    // JSON.stringify / spread / structuredClone) — it's internal state, like the
    // old non-enumerable `_etListeners` and the module-private window store.
    let store = self._listeners;
    if (!store) {
      store = Object.create(null);
      Object.defineProperty(self, '_listeners', { value: store, writable: true, enumerable: false, configurable: true });
    }
    const list = store[type] || (store[type] = []);
    // Dedup on {type, callback, capture} with original callback identity.
    if (list.some(l => l.handler === handler && l.capture === capture)) return;
    list.push({ handler, isObject, capture, passive, once });
  }
  removeEventListener(type, handler, options) {
    const self = unwrapWin(this == null ? globalThis : this);
    const capture = flattenCapture(options);
    if (!self._listeners || !self._listeners[type]) return;
    self._listeners[type] = self._listeners[type].filter(l => {
      const isMatch = l.capture === capture && l.handler === handler;
      if (isMatch) l.removed = true;   // in-flight dispatch snapshot must skip it
      return !isMatch;
    });
  }
  dispatchEvent(event) {
    const self = unwrapWin(this == null ? globalThis : this);
    // A scripted `dispatchEvent()` produces an UNTRUSTED event (DOM "dispatchEvent" sets
    // isTrusted to false); UA-internal firing (dispatchWithOnHandler) marks `_uaFired` so the
    // event stays TRUSTED. The marker is single-use — cleared here so a later scripted
    // re-dispatch of the same object is correctly untrusted.
    if (event) { event.isTrusted = event._uaFired === true; event._uaFired = false; }
    if (event && event.target == null) event.target = self;
    event.currentTarget = self;
    // Legacy `window.event` during dispatch. A plain EventTarget (XHR,
    // AbortSignal, …) is never in a shadow tree, so the event is always visible
    // to `window.event` (unlike the Node path in dispatch.js, which hides it for
    // shadow-tree targets). On a single-realm page set it once for the whole
    // dispatch and restore at the end so nested dispatch nests; on a multi-realm
    // page set it per-listener on each callback's own realm global instead (see
    // invokeWithCurrentEvent / perRealmCurrentEvent).
    const perRealm = perRealmCurrentEvent();
    let prevWinEvent;
    if (!perRealm) { prevWinEvent = globalThis.event; globalThis.event = event; }
    const list = self._listeners && self._listeners[event.type];
    if (list) {
      for (const entry of list.slice()) {
        if (entry.removed) continue;
        if (event._immediatePropagationStopped) break;
        if (entry.once) removeOnceListener(entry, self._listeners[event.type]);
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
    // `target.dispatchEvent(...)` — not just the internal helper paths. The
    // Window has its own (legacy 5-arg `onerror`, body-reflected handlers) via
    // fireWindowOnHandler; a plain EventTarget fires `on<type>` here, after the
    // addEventListener listeners and while `window.event` is still set. A throw
    // is reported (HTML "report the exception"), like the listeners above.
    if (self === globalThis) {
      fireWindowOnHandler(event, perRealm);
    } else {
      const h = self['on' + event.type];
      // Skip when this handler is managed as a registered listener (defineEventHandler):
      // it already fired in the loop above, at its true registration position — firing it
      // here too would double-invoke it. Plain-field handlers (XHR.onload = fn, …) have no
      // `_onwrap_<type>` and still fire here, after the addEventListener listeners.
      if (typeof h === 'function' && !self['_onwrap_' + event.type]) invokeWithCurrentEvent(perRealm, h, false, self, event);
    }
    if (!perRealm) globalThis.event = prevWinEvent;
    event.currentTarget = null;
    return !event.defaultPrevented;
  }
}

// The Window's IDL event-handler attribute (`window.onload`/`onpopstate`/…, and
// the body-reflected `onload`/`onerror`/… via the globalThis accessors). HTML
// runs it as a bubble-phase listener. Shared by this base dispatchEvent and the
// element-walk integration in window-events.js (fireWindowListeners).
export function fireWindowOnHandler(event, perRealm) {
  const h = globalThis['on' + event.type];
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
    prev = g.event;
    g.event = event;
  }
  try {
    // `window.onerror` is an OnErrorEventHandler: for an ErrorEvent it takes the
    // legacy 5-arg form (message, source, lineno, colno, error), not the event.
    if (event.type === 'error' && typeof globalThis.ErrorEvent === 'function' &&
        event instanceof globalThis.ErrorEvent) {
      const handled = h.call(globalThis, event.message, event.filename, event.lineno, event.colno, event.error);
      if (handled === true && event.cancelable) event.defaultPrevented = true;
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
  finally { if (g) g.event = prev; }
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
    configurable: true,
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
    if (report) { try { globalThis.reportError && globalThis.reportError(e); } catch (_) {} }
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
      this.fn = compileHandler(this.src, this.name, false, elementHandlerScopeChain(this.node), true);
    }
    return this.fn;
  }
}

const WINDOW_FORWARDED_HANDLERS = ['blur', 'error', 'focus', 'load', 'scroll', 'resize'];
const FORWARDED_TYPE = new Set(WINDOW_FORWARDED_HANDLERS);
const winStore = Object.create(null);   // the Window's handler functions, by event name

// A body/frameset element reflects the six window-reflecting handlers to the Window
// (its `onload` etc. get/set winStore, not an element-level listener).
function isForwardingHost(node) { return node._tag === 'body' || node._tag === 'frameset'; }
// Store a window handler assigned as a FUNCTION (IDL path); a non-function → null.
function setWindowHandler(name, v) { winStore[name] = typeof v === 'function' ? v : null; }

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
      wrap = (ev) => {
        const cb = handlerCallable(node[slotKey]);
        if (!cb) return;
        // HTML "event handler processing algorithm": a handler returning false
        // cancels the event (mirrors an inline `onclick="…; return false"`).
        const ret = cb.call(node, ev);
        if (ret === false && ev.cancelable) ev.defaultPrevented = true;
      };
      Object.defineProperty(node, wrapKey, { value: wrap, writable: true, enumerable: false, configurable: true });
    }
    node.addEventListener(type, wrap);
  } else if (!nowActive && wasActive && node[wrapKey]) {
    node.removeEventListener(type, node[wrapKey]);
  }
}

// Install the GlobalEventHandlers IDL attributes (`onclick` / `onload` / …) as
// spec-faithful EventHandler accessors on `proto` (Element / Document /
// ShadowRoot); each becomes an accessor that registers a listener. The accessors
// are enumerable to match the plain `null` slots they replace (so React-DOM's
// `'oninput' in element` probe still answers true). `asContentAttr` records the
// lowercase name as an event-handler CONTENT attribute (`syncInlineEventHandler`
// recognises it) — true only for Element, since only elements have content
// attributes; Document / ShadowRoot expose these purely as IDL properties, and a
// Document-only handler (`onreadystatechange` / `onvisibilitychange`) must NOT be a
// content attribute on any element.
const INLINE_HANDLER_TYPE = Object.create(null);   // 'onclick' → 'click', element content-attr handlers only
export function installEventHandlerAttrs(proto, attrNames, asContentAttr) {
  for (const attr of attrNames) {
    const type    = HANDLER_EVENT_TYPE[attr] || attr.slice(2);
    const slotKey = '_eh_' + type, wrapKey = '_ehw_' + type;
    const forwarded = FORWARDED_TYPE.has(type);
    if (asContentAttr) INLINE_HANDLER_TYPE[attr] = type;
    Object.defineProperty(proto, attr, {
      configurable: true, enumerable: true,
      get() {
        if (forwarded && isForwardingHost(this)) return winStore[type] || null;
        return reflectHandler(this[slotKey]);
      },
      set(v) {
        if (forwarded && isForwardingHost(this)) { setWindowHandler(type, v); return; }
        // WebIDL EventHandler [LegacyTreatNonObjectAsNull]: a non-object primitive
        // → null; an object (callable or not) is stored verbatim.
        const stored = (v !== null && (typeof v === 'object' || typeof v === 'function')) ? v : null;
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
  if (type === undefined) return;
  if (FORWARDED_TYPE.has(type) && isForwardingHost(node)) {
    // A clone is not the document's body/frameset; writing winStore would clobber
    // the live window.onload / onresize / …. Skip it — the clone's forwarded getter
    // still reflects winStore, matching the pre-migration model.
    if (!fromClone) activateWindowForwardedHandler(type, raw);
    return;
  }
  setHandlerSlot(node, type, '_eh_' + type, '_ehw_' + type, raw == null ? null : new RawHandler(raw, node, attrName));
}

// Compile + store (or clear) a window-reflected handler in winStore from a raw
// content-attribute source (`<body onresize="…">`), so `window.onX === bodyEl.onX`.
// `name` is the event type; the function is named `on<name>`, and `onerror` is the
// OnErrorEventHandler (legacy 5-arg signature). A Window handler runs in global scope
// (no `with` chain). A compile error → null.
export function activateWindowForwardedHandler(name, code) {
  winStore[name] = code == null ? null : compileHandler(code, 'on' + name, name === 'error', [], false);
}
// The Window's own forwarded-handler accessors (`window.onload` / … read & write
// winStore). The element side is handled by installEventHandlerAttrs' forwarded
// branch, so this only touches globalThis.
export function installWindowForwardedHandlers() {
  for (const name of WINDOW_FORWARDED_HANDLERS) {
    Object.defineProperty(globalThis, 'on' + name, {
      configurable: true, enumerable: true,
      get() { return winStore[name] || null; },
      set(v) { setWindowHandler(name, v); }
    });
  }
}
