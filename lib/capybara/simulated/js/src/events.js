// DOM event constructors. Capture / target / bubble dispatch lives
// in bridge.entry.js; this module just defines the value types.

import { logThrew } from './console.js';

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
      return full;
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
    if (currentTargetIndex === -1) return structs.map((s) => s.node);
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
    return composed;
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
export class ProgressEvent extends Event {
  constructor(type, init) {
    super(type, init);
    init = init || {};
    this.lengthComputable = !!init.lengthComputable;
    this.loaded = init.loaded || 0;
    this.total  = init.total  || 0;
  }
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
    this.url         = init.url || '';
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
    this.error    = init.error    || null;
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
    super(type, init);
    this.formData = (init && init.formData) || null;
  }
}

export class BeforeUnloadEvent extends Event {
  constructor(type, init) { super(type, init); this.returnValue = ''; }
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
  }
  get data()        { return this._data; }
  get inputType()   { return this._inputType; }
  get isComposing() { return this._isComposing; }
  getTargetRanges() { return this._targetRanges.slice(); }
}

export class SubmitEvent extends Event {
  constructor(type, init) { super(type, init); this.submitter = init && init.submitter || null; }
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
export class MessageEvent extends Event {
  constructor(type, init) {
    super(type, init);
    init = init || {};
    this.data        = init.data == null ? null : init.data;
    this.lastEventId = init.lastEventId == null ? '' : String(init.lastEventId);
    this.origin      = init.origin == null ? '' : String(init.origin);
    this.source      = init.source || null;
    this.ports       = init.ports || [];
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
export class EventTarget {
  addEventListener(type, handler, options) {
    const self = this == null ? globalThis : this;   // WebIDL: nullish `this` → Window
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
    const self = this == null ? globalThis : this;
    const capture = flattenCapture(options);
    if (!self._listeners || !self._listeners[type]) return;
    self._listeners[type] = self._listeners[type].filter(l => {
      const isMatch = l.capture === capture && l.handler === handler;
      if (isMatch) l.removed = true;   // in-flight dispatch snapshot must skip it
      return !isMatch;
    });
  }
  dispatchEvent(event) {
    const self = this == null ? globalThis : this;
    if (event && event.target == null) event.target = self;
    event.currentTarget = self;
    // Legacy `window.event` during dispatch. A plain EventTarget (XHR,
    // AbortSignal, …) is never in a shadow tree, so the event is always visible
    // to `window.event` (unlike the Node path in dispatch.js, which hides it for
    // shadow-tree targets). Restore the previous value so nested dispatch nests.
    const prevWinEvent = globalThis.event;
    globalThis.event = event;
    const list = self._listeners && self._listeners[event.type];
    if (list) {
      for (const entry of list.slice()) {
        if (entry.removed) continue;
        if (event._immediatePropagationStopped) break;
        if (entry.once) removeOnceListener(entry, self._listeners[event.type]);
        event._inPassiveListener = !!entry.passive;   // passive → preventDefault no-op
        try {
          if (entry.isObject) {
            const cb = entry.handler.handleEvent;
            if (typeof cb === 'function') cb.call(entry.handler, event);
          } else {
            entry.handler.call(self, event);
          }
        } catch (e) { logThrew('EventTarget listener', e); }
        finally { event._inPassiveListener = false; }
      }
    }
    // Event-handler IDL attributes (`onload` / `onerror` / …) ARE event
    // listeners per HTML, so they fire on any dispatch — including a direct
    // `target.dispatchEvent(...)` — not just the internal helper paths. The
    // Window has its own (legacy 5-arg `onerror`, body-reflected handlers) via
    // fireWindowOnHandler; a plain EventTarget fires `on<type>` here, after the
    // addEventListener listeners and while `window.event` is still set.
    if (self === globalThis) {
      fireWindowOnHandler(event);
    } else {
      const h = self['on' + event.type];
      if (typeof h === 'function') { try { h.call(self, event); } catch (e) { logThrew('on-handler', e); } }
    }
    globalThis.event = prevWinEvent;
    event.currentTarget = null;
    return !event.defaultPrevented;
  }
}

// The Window's IDL event-handler attribute (`window.onload`/`onpopstate`/…, and
// the body-reflected `onload`/`onerror`/… via the globalThis accessors). HTML
// runs it as a bubble-phase listener. Shared by this base dispatchEvent and the
// element-walk integration in window-events.js (fireWindowListeners).
export function fireWindowOnHandler(event) {
  const h = globalThis['on' + event.type];
  if (typeof h !== 'function') return false;
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
  } catch (e) { logThrew('window on-handler', e); }
  return true;
}

// HTML spec `GlobalEventHandlers` — every standard `onX` event-handler
// IDL attribute exists as a property on Element / HTMLElement, default
// `null`. Preact normalizes `<form onSubmit=…>` to lowercase
// `addEventListener('submit', …)` only when its `l in n` probe sees
// `'onsubmit' in element` as truthy — otherwise it falls through to
// the case-sensitive `addEventListener('Submit', …)` branch and the
// event never fires. Pre-install all the names Preact / framework
// code touches as `null` slots on the prototype so the `in` probe
// succeeds and our `fireListeners` bubble pass (reads `node['on' +
// type]`) keeps picking up any later property assignment.
const ON_HANDLER_NAMES = (
  'abort blur cancel canplay canplaythrough change click close ' +
  'contextmenu copy cuechange cut dblclick drag dragend dragenter dragexit ' +
  'dragleave dragover dragstart drop durationchange emptied ended error focus ' +
  'formdata input invalid keydown keypress keyup load loadeddata loadedmetadata ' +
  'loadstart mousedown mouseenter mouseleave mousemove mouseout mouseover ' +
  'mouseup paste pause play playing pointercancel pointerdown pointerenter ' +
  'pointerleave pointermove pointerout pointerover pointerup progress ratechange ' +
  'reset resize scroll seeked seeking select selectstart selectionchange show ' +
  'stalled submit suspend timeupdate toggle touchcancel touchend touchmove ' +
  'touchstart transitioncancel transitionend transitionrun transitionstart ' +
  'volumechange waiting wheel'
).split(/\s+/);

export function installOnHandlerSlots(Element) {
  for (const n of ON_HANDLER_NAMES) {
    const prop = 'on' + n;
    if (!(prop in Element.prototype)) Element.prototype[prop] = null;
  }
}

// HTML "Window-reflecting body element event handler set": on <body> / <frameset>
// these handlers get/set the WINDOW's handler instead of the element's own; on
// any other element they're a normal EventHandler IDL slot. Either way the IDL
// coercion applies — assigning a non-function stores null. Defined as accessors
// (overriding the plain slots installOnHandlerSlots left) so the `in` probe and
// the dispatch `node['on'+type]` read still work.
const WINDOW_FORWARDED_HANDLERS = ['blur', 'error', 'focus', 'load', 'scroll', 'resize'];
const winStore = Object.create(null);   // the Window's handler functions, by event name
// `onblur` → 'blur' if it's a window-reflected handler attribute, else null.
const WINDOW_FORWARDED_ATTR = new Set(WINDOW_FORWARDED_HANDLERS.map(n => 'on' + n));
export function windowForwardedHandlerName(attrName) {
  return WINDOW_FORWARDED_ATTR.has(attrName) ? attrName.slice(2) : null;
}
// Setting a window-reflected handler as a CONTENT attribute on body/frameset
// (`onblur="…"`) activates the Window's handler, compiling the source once so
// `window.onX === bodyEl.onX` (the forwarded getters both read winStore). null
// code clears it. A compile error → null (matches the dispatch on-attr path).
export function activateWindowForwardedHandler(name, code) {
  if (code == null) { winStore[name] = null; return; }
  try { winStore[name] = new Function('event', String(code)); }
  catch (_) { winStore[name] = null; }
}
export function installWindowForwardedHandlers(Element) {
  for (const name of WINDOW_FORWARDED_HANDLERS) {
    const on = 'on' + name, slot = '_csim_' + on;
    Object.defineProperty(globalThis, on, {
      configurable: true, enumerable: true,
      get() { return winStore[name] || null; },
      set(v) { winStore[name] = typeof v === 'function' ? v : null; }
    });
    Object.defineProperty(Element.prototype, on, {
      configurable: true, enumerable: true,
      get() {
        return (this._tag === 'body' || this._tag === 'frameset')
          ? (winStore[name] || null)
          : (this[slot] != null ? this[slot] : null);
      },
      set(v) {
        const fn = typeof v === 'function' ? v : null;
        if (this._tag === 'body' || this._tag === 'frameset') winStore[name] = fn;
        else this[slot] = fn;
      }
    });
  }
}
