// DOM event constructors. Capture / target / bubble dispatch lives
// in bridge.entry.js; this module just defines the value types.

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
    this._propagationStopped          = false;
    this._immediatePropagationStopped = false;
  }
  preventDefault()           { if (this.cancelable) this.defaultPrevented = true; }
  stopPropagation()          { this._propagationStopped = true; }
  stopImmediatePropagation() { this._propagationStopped = true; this._immediatePropagationStopped = true; }
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
export class DOMException extends Error {
  constructor(message = '', name = 'Error') {
    super(message);
    this.name = name;
    this.code = DOMException._codeFor(name);
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

export class CustomEvent extends Event {
  constructor(type, init) {
    super(type, init);
    this.detail = init && init.detail !== undefined ? init.detail : null;
  }
}

export class MouseEvent extends Event {
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
    this.movementX = init.movementX || 0;
    this.movementY = init.movementY || 0;
    this.altKey    = !!init.altKey;
    this.ctrlKey   = !!init.ctrlKey;
    this.metaKey   = !!init.metaKey;
    this.shiftKey  = !!init.shiftKey;
    this.relatedTarget = init.relatedTarget || null;
  }
}

export class KeyboardEvent extends Event {
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
}

export class InputEvent extends Event {
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

// Apps do `class Foo extends EventTarget` (Avo's date-picker,
// mapbox shims, some Stimulus versions). Per-instance handler-list
// dispatch — independent of the DOM tree's capture/bubble walker
// (which lives in bridge.entry.js for Element / Document targets).
export class EventTarget {
  constructor() {
    Object.defineProperty(this, '_etListeners', { value: new Map(), enumerable: false });
  }
  addEventListener(type, handler) {
    if (typeof handler !== 'function' && !(handler && typeof handler.handleEvent === 'function')) return;
    const arr = this._etListeners.get(type) || [];
    if (!arr.includes(handler)) arr.push(handler);
    this._etListeners.set(type, arr);
  }
  removeEventListener(type, handler) {
    const arr = this._etListeners.get(type);
    if (!arr) return;
    const i = arr.indexOf(handler);
    if (i >= 0) arr.splice(i, 1);
  }
  dispatchEvent(event) {
    if (event && event.target == null) event.target = this;
    const list = this._etListeners.get(event && event.type);
    if (!list) return true;
    for (const h of list.slice()) {
      try {
        if (typeof h === 'function') h.call(this, event);
        else                          h.handleEvent.call(h, event);
      } catch (e) {
        try { console.error('[csim] EventTarget listener threw:', e && e.message); } catch (_) {}
      }
    }
    return !event.defaultPrevented;
  }
}
