(() => {
  var __defProp = Object.defineProperty;
  var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

  // lib/capybara/simulated/js/src/url-parse.js
  var USM = globalThis.__csimVendor && globalThis.__csimVendor.urlEngine;
  globalThis.__csim_parseUrl = function(input, base) {
    if (!USM) return { error: true };
    let parsedBase = null;
    if (base != null) {
      parsedBase = USM.basicURLParse(String(base));
      if (parsedBase === null) return { error: true };
    }
    const u = USM.basicURLParse(String(input), { baseURL: parsedBase });
    if (u === null) return { error: true };
    const host = u.host;
    const hostname = host === null ? "" : USM.serializeHost(host);
    const port = u.port === null ? "" : USM.serializeInteger(u.port);
    return {
      href: USM.serializeURL(u),
      protocol: u.scheme + ":",
      username: u.username,
      password: u.password,
      host: host === null ? "" : port ? hostname + ":" + port : hostname,
      hostname,
      port,
      pathname: USM.serializePath(u),
      search: u.query === null || u.query === "" ? "" : "?" + u.query,
      hash: u.fragment === null || u.fragment === "" ? "" : "#" + u.fragment,
      origin: USM.serializeURLOrigin(u),
      // Opaque-path URLs (`javascript:…`, `data:…`, `mailto:…`) serialize WITHOUT
      // a `//` authority — the `URL` class's href reassembly keys off this.
      opaque: USM.hasAnOpaquePath(u),
      // Whether the URL has an authority (host !== null). The WHATWG serializer
      // emits `//` iff this holds, distinguishing `foo:/path` (null host, no `//`)
      // from `foo://host` / `foo://` (empty-or-set host, has `//`). Both report
      // `host === ''` via the IDL getter when empty, so href reassembly can't tell
      // them apart from `host` alone — without this, `new URL('foo:/').href` was
      // wrongly serialized `foo:///`.
      hasAuthority: u.host !== null,
      // Same null-vs-empty split for query/fragment: the `search`/`hash` IDL
      // getters return '' for both a null and an empty component, but href must
      // keep the bare `?`/`#` for an empty-but-present one (`new URL('?', base)`
      // → `…/bar?`, `new URL('#', base)` → `…/bar#`).
      hasQuery: u.query !== null,
      hasFragment: u.fragment !== null
    };
  };

  // lib/capybara/simulated/js/src/constants.js
  var NODE_ELEMENT = 1;
  var NODE_ATTRIBUTE = 2;
  var NODE_TEXT = 3;
  var NODE_CDATA = 4;
  var NODE_PI = 7;
  var NODE_COMMENT = 8;
  var NODE_DOC = 9;
  var NODE_DOCTYPE = 10;
  var NODE_FRAGMENT = 11;
  function installNodeConstants(Node2) {
    const c = {
      ELEMENT_NODE: 1,
      ATTRIBUTE_NODE: 2,
      TEXT_NODE: 3,
      CDATA_SECTION_NODE: 4,
      ENTITY_REFERENCE_NODE: 5,
      ENTITY_NODE: 6,
      PROCESSING_INSTRUCTION_NODE: 7,
      COMMENT_NODE: 8,
      DOCUMENT_NODE: 9,
      DOCUMENT_TYPE_NODE: 10,
      DOCUMENT_FRAGMENT_NODE: 11,
      NOTATION_NODE: 12,
      DOCUMENT_POSITION_DISCONNECTED: 1,
      DOCUMENT_POSITION_PRECEDING: 2,
      DOCUMENT_POSITION_FOLLOWING: 4,
      DOCUMENT_POSITION_CONTAINS: 8,
      DOCUMENT_POSITION_CONTAINED_BY: 16,
      DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC: 32
    };
    for (const k in c) {
      Node2[k] = c[k];
      Node2.prototype[k] = c[k];
    }
  }
  __name(installNodeConstants, "installNodeConstants");

  // lib/capybara/simulated/js/src/walk.js
  function walk(node, fn) {
    if (!node) return;
    if (node.nodeType === NODE_ELEMENT) fn(node);
    const ch = node._children;
    for (let i = 0; i < ch.length; i++) walk(ch[i], fn);
  }
  __name(walk, "walk");
  function walkFind(node, pred) {
    if (!node) return null;
    if (node.nodeType === NODE_ELEMENT && pred(node)) return node;
    const ch = node._children;
    for (let i = 0; i < ch.length; i++) {
      const hit = walkFind(ch[i], pred);
      if (hit) return hit;
    }
    return null;
  }
  __name(walkFind, "walkFind");
  function walkSubtree(node, fn) {
    if (!node) return;
    fn(node);
    const ch = node._children;
    if (ch) for (let i = 0; i < ch.length; i++) walkSubtree(ch[i], fn);
  }
  __name(walkSubtree, "walkSubtree");
  function isConnected(node) {
    let cur = node;
    while (cur) {
      if (cur.nodeType === NODE_DOC) return true;
      cur = cur._parent;
    }
    return false;
  }
  __name(isConnected, "isConnected");
  function stripOneLeadingNewline(s) {
    if (typeof s !== "string" || s.length === 0) return s;
    if (s.length >= 2 && s.charCodeAt(0) === 13 && s.charCodeAt(1) === 10) return s.slice(2);
    if (s.charCodeAt(0) === 13 || s.charCodeAt(0) === 10) return s.slice(1);
    return s;
  }
  __name(stripOneLeadingNewline, "stripOneLeadingNewline");
  function scriptText(el) {
    let s = "";
    for (const c of el._children) if (c.nodeType === NODE_TEXT || c.nodeType === NODE_CDATA) s += c.data;
    return s;
  }
  __name(scriptText, "scriptText");
  function classes(el) {
    const cls = el._attrs["class"];
    if (!cls) return [];
    if (el._classesCacheKey === cls) return el._classesCache;
    const arr = cls.split(/\s+/).filter(Boolean);
    el._classesCacheKey = cls;
    el._classesCache = arr;
    return arr;
  }
  __name(classes, "classes");
  function findById(root, id) {
    if (!root) return null;
    const target = String(id);
    if (target.length === 0) return null;
    return walkFind(root, (el) => el._attrs && el._attrs.id === target);
  }
  __name(findById, "findById");

  // lib/capybara/simulated/js/src/handles.js
  var handles = /* @__PURE__ */ new Map();
  function lookup(h) {
    return handles.get(h) || null;
  }
  __name(lookup, "lookup");
  function registerNode(n) {
    handles.set(n._id, n);
    const ch = n._children;
    if (ch) for (let i = 0; i < ch.length; i++) registerNode(ch[i]);
  }
  __name(registerNode, "registerNode");
  function registerSubtree(node) {
    if (!node) return;
    handles.set(node._id, node);
    const ch = node._children;
    if (ch) for (let i = 0; i < ch.length; i++) registerSubtree(ch[i]);
  }
  __name(registerSubtree, "registerSubtree");
  function unregisterSubtree(node) {
    if (!node) return;
    handles.delete(node._id);
    if (node._frameRealmId != null) {
      const rid = node._frameRealmId;
      node._frameRealmId = null;
      if (globalThis.__csimChildRealmIds) globalThis.__csimChildRealmIds.delete(rid);
      if (globalThis.__csim_disposeFrameRealm) globalThis.__csim_disposeFrameRealm(rid);
    }
    const ch = node._children;
    if (ch) for (let i = 0; i < ch.length; i++) unregisterSubtree(ch[i]);
  }
  __name(unregisterSubtree, "unregisterSubtree");

  // lib/capybara/simulated/js/src/console.js
  function consoleFmt(v, seen) {
    if (v && typeof v === "object") {
      if (v instanceof Error) return v.stack || v.name + ": " + v.message;
      if (seen.has(v)) return "[Circular]";
      seen.add(v);
      try {
        return JSON.stringify(v);
      } catch (_) {
        return String(v);
      }
    }
    return v;
  }
  __name(consoleFmt, "consoleFmt");
  function consoleJoin(args) {
    let needsFormat = false;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a !== null && typeof a === "object") {
        needsFormat = true;
        break;
      }
    }
    if (!needsFormat) return Array.prototype.join.call(args, " ");
    const seen = /* @__PURE__ */ new WeakSet();
    const out = new Array(args.length);
    for (let i = 0; i < args.length; i++) out[i] = consoleFmt(args[i], seen);
    return out.join(" ");
  }
  __name(consoleJoin, "consoleJoin");
  var traceActive = false;
  var makeConsoleFn = /* @__PURE__ */ __name((level) => function() {
    if (!traceActive) return void 0;
    try {
      globalThis.__csim_logConsole(level, consoleJoin(arguments));
    } catch (_) {
    }
    return void 0;
  }, "makeConsoleFn");
  globalThis.__csim_traceActive = false;
  globalThis.__csimSetTraceActive = function(v) {
    traceActive = !!v;
    globalThis.__csim_traceActive = traceActive;
  };
  globalThis.console = {
    log: makeConsoleFn("log"),
    info: makeConsoleFn("info"),
    warn: makeConsoleFn("warn"),
    error: makeConsoleFn("error"),
    debug: makeConsoleFn("debug")
  };
  function logThrew(label, e) {
    try {
      const detail = e && (e.stack || e.message) || String(e);
      console.error("[csim] " + label + " threw:", detail);
    } catch (_) {
    }
  }
  __name(logThrew, "logThrew");

  // lib/capybara/simulated/js/src/css-utils.js
  function splitTopLevel(s, sep) {
    const parts = [];
    let depth = 0, start = 0;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === "[" || ch === "(") depth++;
      else if (ch === "]" || ch === ")") depth--;
      else if (ch === sep && depth === 0) {
        parts.push(s.slice(start, i));
        start = i + 1;
      }
    }
    parts.push(s.slice(start));
    return parts;
  }
  __name(splitTopLevel, "splitTopLevel");

  // lib/capybara/simulated/js/src/events.js
  var PASSIVE_DEFAULT_EVENTS = /* @__PURE__ */ new Set(["touchstart", "touchmove", "wheel", "mousewheel"]);
  function defaultPassiveValue(type, target) {
    if (!PASSIVE_DEFAULT_EVENTS.has(type)) return false;
    if (target === globalThis) return true;
    const nt = target && target.nodeType;
    if (nt === 9) return true;
    if (nt === 1 && target.ownerDocument) {
      const doc = target.ownerDocument;
      if (target === doc.documentElement || target._tag === "body") return true;
    }
    return false;
  }
  __name(defaultPassiveValue, "defaultPassiveValue");
  function removeOnceListener(entry, listArr) {
    entry.removed = true;
    if (listArr) {
      const i = listArr.indexOf(entry);
      if (i !== -1) listArr.splice(i, 1);
    }
  }
  __name(removeOnceListener, "removeOnceListener");
  var Event = class {
    static {
      __name(this, "Event");
    }
    constructor(type, init) {
      init = init || {};
      this.type = String(type);
      this.bubbles = !!init.bubbles;
      this.cancelable = !!init.cancelable;
      this.composed = !!init.composed;
      this.defaultPrevented = false;
      this.target = null;
      this._currentTarget = null;
      this.eventPhase = 0;
      this.isTrusted = false;
      this._propagationStopped = false;
      this._immediatePropagationStopped = false;
      this._initialized = true;
      this._dispatchFlag = false;
      this._ts = typeof globalThis.performance !== "undefined" && globalThis.performance.now ? globalThis.performance.now() : Date.now();
    }
    get timeStamp() {
      if (this._ts == null) {
        this._ts = typeof globalThis.performance !== "undefined" && globalThis.performance.now ? globalThis.performance.now() : Date.now();
      }
      return this._ts;
    }
    preventDefault() {
      if (this.cancelable && !this._inPassiveListener) this.defaultPrevented = true;
    }
    stopPropagation() {
      this._propagationStopped = true;
    }
    stopImmediatePropagation() {
      this._propagationStopped = true;
      this._immediatePropagationStopped = true;
    }
    // Legacy `cancelBubble`: reads the stop-propagation flag; setting it true is
    // an alias for stopPropagation(); setting it false has NO effect (you can't
    // un-stop propagation), per the DOM spec.
    get cancelBubble() {
      return this._propagationStopped;
    }
    set cancelBubble(v) {
      if (v) this._propagationStopped = true;
    }
    // Legacy `initEvent(type, bubbles, cancelable)` (for events made via
    // `document.createEvent`). DOM spec step 1: if this's dispatch flag is set,
    // return — re-initialising an event mid-dispatch is a no-op. Otherwise mark
    // it initialized, clear the propagation/canceled flags + target, and set the
    // three attributes.
    initEvent(type, bubbles, cancelable) {
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
      if (!this._dispatchFlag) return [];
      const structs = this._csimPath;
      if (!structs) {
        const full = [];
        for (let n = this.target; n; n = n._parent) full.push(n);
        const top = full[full.length - 1];
        if (top && top.nodeType === 9) {
          if (!full.includes(globalThis)) full.push(globalThis);
        }
        return full;
      }
      const ct = this._currentTarget;
      let currentTargetIndex = -1;
      let level = 0;
      let index = structs.length - 1;
      while (index >= 0) {
        if (structs[index].rootClosed) level++;
        if (structs[index].node === ct) {
          currentTargetIndex = index;
          break;
        }
        if (structs[index].slotClosed) level--;
        index--;
      }
      if (currentTargetIndex === -1) return structs.map((s) => s.node);
      const composed = [ct];
      let current = level, max = level;
      for (index = currentTargetIndex - 1; index >= 0; index--) {
        if (structs[index].rootClosed) current++;
        if (current <= max) composed.unshift(structs[index].node);
        if (structs[index].slotClosed) {
          current--;
          if (current < max) max = current;
        }
      }
      current = level;
      max = level;
      for (index = currentTargetIndex + 1; index < structs.length; index++) {
        if (structs[index].slotClosed) current++;
        if (current <= max) composed.push(structs[index].node);
        if (structs[index].rootClosed) {
          current--;
          if (current < max) max = current;
        }
      }
      return composed;
    }
    get srcElement() {
      return this.target;
    }
    // Legacy IE alias of `!defaultPrevented`. Reading returns whether the
    // default action is still allowed; assigning `false` cancels it
    // (assigning anything else is a no-op), matching the HTML spec's
    // `returnValue` accessor on Event.
    get returnValue() {
      return !this.defaultPrevented;
    }
    set returnValue(v) {
      if (v === false) this.preventDefault();
    }
  };
  for (const [k, v] of [["NONE", 0], ["CAPTURING_PHASE", 1], ["AT_TARGET", 2], ["BUBBLING_PHASE", 3]]) {
    Object.defineProperty(Event, k, { value: v, enumerable: true });
    Object.defineProperty(Event.prototype, k, { value: v, enumerable: true });
  }
  Object.defineProperty(Event.prototype, "currentTarget", {
    configurable: true,
    enumerable: true,
    get() {
      return this._currentTarget;
    },
    set(v) {
      this._currentTarget = v;
    }
  });
  var DOMEXC_BRAND = /* @__PURE__ */ Symbol("DOMException");
  var DOMException2 = class _DOMException extends Error {
    static {
      __name(this, "DOMException");
    }
    constructor(message = "", name = "Error") {
      super(message);
      Object.defineProperty(this, "name", { value: String(name), writable: true, enumerable: true, configurable: true });
      Object.defineProperty(this, "code", { value: _DOMException._codeFor(name), writable: true, enumerable: true, configurable: true });
      Object.defineProperty(this, DOMEXC_BRAND, { value: true });
    }
    static _codeFor(name) {
      return {
        IndexSizeError: 1,
        HierarchyRequestError: 3,
        WrongDocumentError: 4,
        InvalidCharacterError: 5,
        NoModificationAllowedError: 7,
        NotFoundError: 8,
        NotSupportedError: 9,
        InUseAttributeError: 10,
        InvalidStateError: 11,
        SyntaxError: 12,
        InvalidModificationError: 13,
        NamespaceError: 14,
        InvalidAccessError: 15,
        TypeMismatchError: 17,
        SecurityError: 18,
        NetworkError: 19,
        AbortError: 20,
        URLMismatchError: 21,
        QuotaExceededError: 22,
        TimeoutError: 23,
        InvalidNodeTypeError: 24,
        DataCloneError: 25
      }[name] || 0;
    }
  };
  Object.entries({
    INDEX_SIZE_ERR: 1,
    DOMSTRING_SIZE_ERR: 2,
    HIERARCHY_REQUEST_ERR: 3,
    WRONG_DOCUMENT_ERR: 4,
    INVALID_CHARACTER_ERR: 5,
    NO_DATA_ALLOWED_ERR: 6,
    NO_MODIFICATION_ALLOWED_ERR: 7,
    NOT_FOUND_ERR: 8,
    NOT_SUPPORTED_ERR: 9,
    INUSE_ATTRIBUTE_ERR: 10,
    INVALID_STATE_ERR: 11,
    SYNTAX_ERR: 12,
    INVALID_MODIFICATION_ERR: 13,
    NAMESPACE_ERR: 14,
    INVALID_ACCESS_ERR: 15,
    VALIDATION_ERR: 16,
    TYPE_MISMATCH_ERR: 17,
    SECURITY_ERR: 18,
    NETWORK_ERR: 19,
    ABORT_ERR: 20,
    URL_MISMATCH_ERR: 21,
    QUOTA_EXCEEDED_ERR: 22,
    TIMEOUT_ERR: 23,
    INVALID_NODE_TYPE_ERR: 24,
    DATA_CLONE_ERR: 25
  }).forEach(([k, v]) => {
    Object.defineProperty(DOMException2, k, { value: v, enumerable: true });
    Object.defineProperty(DOMException2.prototype, k, { value: v, enumerable: true });
  });
  for (const attr of ["message", "name", "code"]) {
    Object.defineProperty(DOMException2.prototype, attr, {
      get() {
        if (!this || !this[DOMEXC_BRAND]) {
          throw new TypeError("Illegal invocation");
        }
        return attr === "code" ? 0 : attr === "name" ? "Error" : "";
      },
      enumerable: true,
      configurable: true
    });
  }
  var CustomEvent = class extends Event {
    static {
      __name(this, "CustomEvent");
    }
    constructor(type, init) {
      super(type, init);
      this.detail = init && init.detail !== void 0 ? init.detail : null;
    }
    // Legacy initialiser per the HTML spec — kept for libraries that
    // construct `document.createEvent('CustomEvent')` then
    // `initCustomEvent(...)`. Overwrites type / bubbles / cancelable /
    // detail in place, mirroring `Event#initEvent`.
    initCustomEvent(type, bubbles, cancelable, detail) {
      if (arguments.length < 1) throw new TypeError("Failed to execute 'initCustomEvent' on 'CustomEvent': 1 argument required, but only 0 present.");
      if (this._dispatchFlag) return;
      this.initEvent(type, bubbles, cancelable);
      this.detail = detail === void 0 ? null : detail;
    }
  };
  var UIEvent = class extends Event {
    static {
      __name(this, "UIEvent");
    }
    constructor(type, init) {
      super(type, init);
      init = init || {};
      let view = null;
      if (init.view != null) {
        const t = typeof init.view;
        if (t !== "object" && t !== "function") {
          throw new TypeError("Failed to construct 'UIEvent': member view is not of type Window.");
        }
        view = init.view;
      }
      this.view = view;
      this.detail = init.detail || 0;
    }
    // Legacy initialiser; no-op while dispatching (dispatch flag set).
    initUIEvent(type, bubbles, cancelable, view, detail) {
      if (this._dispatchFlag) return;
      this.initEvent(type, bubbles, cancelable);
      this.view = view != null ? view : null;
      this.detail = detail || 0;
    }
  };
  var FocusEvent = class extends UIEvent {
    static {
      __name(this, "FocusEvent");
    }
    constructor(type, init) {
      super(type, init);
      this.relatedTarget = init && init.relatedTarget || null;
    }
  };
  var CompositionEvent = class extends UIEvent {
    static {
      __name(this, "CompositionEvent");
    }
    constructor(type, init) {
      super(type, init);
      this.data = init && init.data != null ? String(init.data) : "";
    }
  };
  var TextEvent = class extends UIEvent {
    static {
      __name(this, "TextEvent");
    }
    constructor(type, init) {
      super(type, init);
      this.data = init && init.data != null ? String(init.data) : "";
    }
  };
  var DeviceMotionEvent = class extends Event {
    static {
      __name(this, "DeviceMotionEvent");
    }
    constructor(type, init) {
      super(type, init);
      init = init || {};
      this.acceleration = init.acceleration || null;
      this.accelerationIncludingGravity = init.accelerationIncludingGravity || null;
      this.rotationRate = init.rotationRate || null;
      this.interval = init.interval || 0;
    }
  };
  var DeviceOrientationEvent = class extends Event {
    static {
      __name(this, "DeviceOrientationEvent");
    }
    constructor(type, init) {
      super(type, init);
      init = init || {};
      this.alpha = init.alpha != null ? init.alpha : null;
      this.beta = init.beta != null ? init.beta : null;
      this.gamma = init.gamma != null ? init.gamma : null;
      this.absolute = !!init.absolute;
    }
  };
  var TouchEvent = class extends UIEvent {
    static {
      __name(this, "TouchEvent");
    }
    constructor(type, init) {
      super(type, init);
      init = init || {};
      this.touches = init.touches || [];
      this.targetTouches = init.targetTouches || [];
      this.changedTouches = init.changedTouches || [];
      this.altKey = !!init.altKey;
      this.ctrlKey = !!init.ctrlKey;
      this.metaKey = !!init.metaKey;
      this.shiftKey = !!init.shiftKey;
    }
  };
  var ProgressEvent = class extends Event {
    static {
      __name(this, "ProgressEvent");
    }
    constructor(type, init) {
      super(type, init);
      init = init || {};
      this.lengthComputable = !!init.lengthComputable;
      this.loaded = init.loaded || 0;
      this.total = init.total || 0;
    }
  };
  var PopStateEvent = class extends Event {
    static {
      __name(this, "PopStateEvent");
    }
    constructor(type, init) {
      super(type, init);
      this.state = init && "state" in init ? init.state : null;
    }
  };
  var HashChangeEvent = class extends Event {
    static {
      __name(this, "HashChangeEvent");
    }
    constructor(type, init) {
      super(type, init);
      init = init || {};
      this.oldURL = init.oldURL || "";
      this.newURL = init.newURL || "";
    }
  };
  var StorageEvent = class extends Event {
    static {
      __name(this, "StorageEvent");
    }
    constructor(type, init) {
      super(type, init);
      init = init || {};
      this.key = init.key == null ? null : String(init.key);
      this.oldValue = init.oldValue == null ? null : String(init.oldValue);
      this.newValue = init.newValue == null ? null : String(init.newValue);
      this.url = init.url || "";
      this.storageArea = init.storageArea || null;
    }
  };
  var ErrorEvent = class extends Event {
    static {
      __name(this, "ErrorEvent");
    }
    constructor(type, init) {
      super(type, init);
      init = init || {};
      this.message = init.message || "";
      this.filename = init.filename || "";
      this.lineno = init.lineno || 0;
      this.colno = init.colno || 0;
      this.error = init.error || null;
    }
  };
  var PromiseRejectionEvent = class extends Event {
    static {
      __name(this, "PromiseRejectionEvent");
    }
    constructor(type, init) {
      super(type, init);
      init = init || {};
      this.promise = init.promise || null;
      this.reason = init.reason;
    }
  };
  var AnimationEvent = class extends Event {
    static {
      __name(this, "AnimationEvent");
    }
    constructor(type, init) {
      super(type, init);
      init = init || {};
      this.animationName = init.animationName || "";
      this.elapsedTime = init.elapsedTime || 0;
      this.pseudoElement = init.pseudoElement || "";
    }
  };
  var TransitionEvent = class extends Event {
    static {
      __name(this, "TransitionEvent");
    }
    constructor(type, init) {
      super(type, init);
      init = init || {};
      this.propertyName = init.propertyName || "";
      this.elapsedTime = init.elapsedTime || 0;
      this.pseudoElement = init.pseudoElement || "";
    }
  };
  var FormDataEvent = class extends Event {
    static {
      __name(this, "FormDataEvent");
    }
    constructor(type, init) {
      super(type, init);
      this.formData = init && init.formData || null;
    }
  };
  var BeforeUnloadEvent = class extends Event {
    static {
      __name(this, "BeforeUnloadEvent");
    }
    constructor(type, init) {
      super(type, init);
      this.returnValue = "";
    }
  };
  var MouseEvent = class extends UIEvent {
    static {
      __name(this, "MouseEvent");
    }
    constructor(type, init) {
      super(type, init);
      init = init || {};
      this.button = init.button != null ? init.button : 0;
      this.buttons = init.buttons != null ? init.buttons : 0;
      this.which = init.which != null ? init.which : this.button + 1;
      this.clientX = init.clientX || 0;
      this.clientY = init.clientY || 0;
      this.pageX = init.pageX != null ? init.pageX : this.clientX;
      this.pageY = init.pageY != null ? init.pageY : this.clientY;
      this.screenX = init.screenX || 0;
      this.screenY = init.screenY || 0;
      this.offsetX = init.offsetX != null ? init.offsetX : 0;
      this.offsetY = init.offsetY != null ? init.offsetY : 0;
      this.movementX = init.movementX || 0;
      this.movementY = init.movementY || 0;
      this.altKey = !!init.altKey;
      this.ctrlKey = !!init.ctrlKey;
      this.metaKey = !!init.metaKey;
      this.shiftKey = !!init.shiftKey;
      this.relatedTarget = init.relatedTarget || null;
    }
    // CSSOM-View: `x`/`y` alias `clientX`/`clientY`.
    get x() {
      return this.clientX;
    }
    get y() {
      return this.clientY;
    }
    // UI Events: returns whether the given modifier was held at dispatch.
    getModifierState(keyArg) {
      switch (String(keyArg)) {
        case "Alt":
          return this.altKey;
        case "Control":
          return this.ctrlKey;
        case "Meta":
        case "OS":
          return this.metaKey;
        case "Shift":
          return this.shiftKey;
      }
      return false;
    }
    // Legacy initialiser; no-op while dispatching (dispatch flag set).
    initMouseEvent(type, bubbles, cancelable, view, detail, screenX, screenY, clientX, clientY, ctrlKey, altKey, shiftKey, metaKey, button, relatedTarget) {
      if (this._dispatchFlag) return;
      this.initEvent(type, bubbles, cancelable);
      this.view = view != null ? view : null;
      this.detail = detail || 0;
      this.screenX = screenX || 0;
      this.screenY = screenY || 0;
      this.clientX = clientX || 0;
      this.clientY = clientY || 0;
      this.ctrlKey = !!ctrlKey;
      this.altKey = !!altKey;
      this.shiftKey = !!shiftKey;
      this.metaKey = !!metaKey;
      this.button = button || 0;
      this.relatedTarget = relatedTarget || null;
    }
  };
  var WheelEvent = class extends MouseEvent {
    static {
      __name(this, "WheelEvent");
    }
    constructor(type, init) {
      super(type, init);
      init = init || {};
      this.deltaX = init.deltaX != null ? init.deltaX : 0;
      this.deltaY = init.deltaY != null ? init.deltaY : 0;
      this.deltaZ = init.deltaZ != null ? init.deltaZ : 0;
      this.deltaMode = init.deltaMode != null ? init.deltaMode : 0;
    }
  };
  for (const [k, v] of [["DOM_DELTA_PIXEL", 0], ["DOM_DELTA_LINE", 1], ["DOM_DELTA_PAGE", 2]]) {
    Object.defineProperty(WheelEvent, k, { value: v, enumerable: true });
    Object.defineProperty(WheelEvent.prototype, k, { value: v, enumerable: true });
  }
  var PointerEvent = class extends MouseEvent {
    static {
      __name(this, "PointerEvent");
    }
    constructor(type, init) {
      super(type, init);
      init = init || {};
      this.pointerId = init.pointerId != null ? init.pointerId : 0;
      this.pointerType = init.pointerType != null ? String(init.pointerType) : "";
      this.width = init.width != null ? init.width : 1;
      this.height = init.height != null ? init.height : 1;
      this.pressure = init.pressure != null ? init.pressure : 0;
      this.tangentialPressure = init.tangentialPressure || 0;
      this.tiltX = init.tiltX || 0;
      this.tiltY = init.tiltY || 0;
      this.twist = init.twist || 0;
      this.isPrimary = !!init.isPrimary;
    }
  };
  var DragEvent = class extends MouseEvent {
    static {
      __name(this, "DragEvent");
    }
    constructor(type, init) {
      super(type, init);
      this.dataTransfer = init && init.dataTransfer || null;
    }
  };
  var KeyboardEvent = class extends UIEvent {
    static {
      __name(this, "KeyboardEvent");
    }
    constructor(type, init) {
      super(type, init);
      init = init || {};
      this.key = init.key != null ? String(init.key) : "";
      this.code = init.code != null ? String(init.code) : "";
      this.keyCode = init.keyCode != null ? init.keyCode : 0;
      this.which = init.which != null ? init.which : this.keyCode;
      this.charCode = init.charCode != null ? init.charCode : 0;
      this.location = init.location != null ? init.location : 0;
      this.repeat = !!init.repeat;
      this.isComposing = !!init.isComposing;
      this.ctrlKey = !!init.ctrlKey;
      this.metaKey = !!init.metaKey;
      this.shiftKey = !!init.shiftKey;
      this.altKey = !!init.altKey;
    }
    getModifierState(keyArg) {
      switch (String(keyArg)) {
        case "Alt":
          return this.altKey;
        case "Control":
          return this.ctrlKey;
        case "Meta":
        case "OS":
          return this.metaKey;
        case "Shift":
          return this.shiftKey;
      }
      return false;
    }
    // Legacy initialiser (typeArg, canBubble, cancelable, view, key, location,
    // modifiersList, repeat, locale); no-op while dispatching (dispatch flag set).
    initKeyboardEvent(type, bubbles, cancelable, view, key, location, modifiersList, repeat) {
      if (this._dispatchFlag) return;
      this.initEvent(type, bubbles, cancelable);
      this.view = view != null ? view : null;
      this.key = key != null ? String(key) : "";
      this.location = location != null ? location : 0;
      this.repeat = !!repeat;
      const mods = modifiersList ? String(modifiersList).split(/\s+/) : [];
      this.ctrlKey = mods.includes("Control");
      this.altKey = mods.includes("Alt");
      this.shiftKey = mods.includes("Shift");
      this.metaKey = mods.includes("Meta");
    }
  };
  for (const [k, v] of [["DOM_KEY_LOCATION_STANDARD", 0], ["DOM_KEY_LOCATION_LEFT", 1], ["DOM_KEY_LOCATION_RIGHT", 2], ["DOM_KEY_LOCATION_NUMPAD", 3]]) {
    Object.defineProperty(KeyboardEvent, k, { value: v, enumerable: true });
    Object.defineProperty(KeyboardEvent.prototype, k, { value: v, enumerable: true });
  }
  var InputEvent = class extends UIEvent {
    static {
      __name(this, "InputEvent");
    }
    constructor(type, init) {
      super(type, init);
      init = init || {};
      this._data = init.data != null ? String(init.data) : null;
      this._inputType = init.inputType != null ? String(init.inputType) : "";
      this._isComposing = !!init.isComposing;
      this._targetRanges = Array.isArray(init.targetRanges) ? init.targetRanges.slice() : [];
    }
    get data() {
      return this._data;
    }
    get inputType() {
      return this._inputType;
    }
    get isComposing() {
      return this._isComposing;
    }
    getTargetRanges() {
      return this._targetRanges.slice();
    }
  };
  var SubmitEvent = class extends Event {
    static {
      __name(this, "SubmitEvent");
    }
    constructor(type, init) {
      super(type, init);
      this.submitter = init && init.submitter || null;
    }
  };
  var ClipboardEvent = class extends Event {
    static {
      __name(this, "ClipboardEvent");
    }
    constructor(type, init) {
      super(type, init);
      const i = init || {};
      let cd = null;
      if (i.clipboardData) {
        cd = i.clipboardData;
      } else if ("clipboardDataText" in i) {
        const text = i.clipboardDataText == null ? "" : String(i.clipboardDataText);
        cd = {
          types: ["text/plain"],
          getData(kind) {
            return kind === "text" || kind === "text/plain" ? text : "";
          },
          setData() {
          }
        };
      }
      Object.defineProperty(this, "clipboardData", { value: cd, writable: true, configurable: true, enumerable: true });
    }
  };
  var MessageEvent = class extends Event {
    static {
      __name(this, "MessageEvent");
    }
    constructor(type, init) {
      super(type, init);
      init = init || {};
      this.data = init.data == null ? null : init.data;
      this.lastEventId = init.lastEventId == null ? "" : String(init.lastEventId);
      this.origin = init.origin == null ? "" : String(init.origin);
      this.source = init.source || null;
      this.ports = init.ports || [];
    }
  };
  function dispatchWithOnHandler(target, evt) {
    try {
      target.dispatchEvent(evt);
    } catch (_) {
    }
    const h = target["on" + evt.type];
    if (typeof h === "function") {
      try {
        h.call(target, evt);
      } catch (_) {
      }
    }
  }
  __name(dispatchWithOnHandler, "dispatchWithOnHandler");
  function flattenCapture(options) {
    if (options == null) return false;
    if (typeof options === "object") return !!options.capture;
    return !!options;
  }
  __name(flattenCapture, "flattenCapture");
  var EventTarget = class {
    static {
      __name(this, "EventTarget");
    }
    addEventListener(type, handler, options) {
      const self = this == null ? globalThis : this;
      const capture = flattenCapture(options);
      let isObject = false;
      if (typeof handler === "function") {
      } else if (handler !== null && typeof handler === "object") isObject = true;
      else return;
      const passive = options && typeof options === "object" && options.passive !== void 0 ? !!options.passive : defaultPassiveValue(type, self);
      const once = !!(options && typeof options === "object" && options.once);
      let store = self._listeners;
      if (!store) {
        store = /* @__PURE__ */ Object.create(null);
        Object.defineProperty(self, "_listeners", { value: store, writable: true, enumerable: false, configurable: true });
      }
      const list = store[type] || (store[type] = []);
      if (list.some((l) => l.handler === handler && l.capture === capture)) return;
      list.push({ handler, isObject, capture, passive, once });
    }
    removeEventListener(type, handler, options) {
      const self = this == null ? globalThis : this;
      const capture = flattenCapture(options);
      if (!self._listeners || !self._listeners[type]) return;
      self._listeners[type] = self._listeners[type].filter((l) => {
        const isMatch = l.capture === capture && l.handler === handler;
        if (isMatch) l.removed = true;
        return !isMatch;
      });
    }
    dispatchEvent(event) {
      const self = this == null ? globalThis : this;
      if (event && event.target == null) event.target = self;
      event.currentTarget = self;
      const list = self._listeners && self._listeners[event.type];
      if (list) {
        for (const entry of list.slice()) {
          if (entry.removed) continue;
          if (event._immediatePropagationStopped) break;
          if (entry.once) removeOnceListener(entry, self._listeners[event.type]);
          event._inPassiveListener = !!entry.passive;
          try {
            if (entry.isObject) {
              const cb = entry.handler.handleEvent;
              if (typeof cb === "function") cb.call(entry.handler, event);
            } else {
              entry.handler.call(self, event);
            }
          } catch (e) {
            logThrew("EventTarget listener", e);
          } finally {
            event._inPassiveListener = false;
          }
        }
      }
      if (self === globalThis) fireWindowOnHandler(event);
      event.currentTarget = null;
      return !event.defaultPrevented;
    }
  };
  function fireWindowOnHandler(event) {
    const h = globalThis["on" + event.type];
    if (typeof h !== "function") return false;
    try {
      if (event.type === "error" && typeof globalThis.ErrorEvent === "function" && event instanceof globalThis.ErrorEvent) {
        const handled = h.call(globalThis, event.message, event.filename, event.lineno, event.colno, event.error);
        if (handled === true && event.cancelable) event.defaultPrevented = true;
      } else {
        h.call(globalThis, event);
      }
    } catch (e) {
      logThrew("window on-handler", e);
    }
    return true;
  }
  __name(fireWindowOnHandler, "fireWindowOnHandler");
  var ON_HANDLER_NAMES = "abort blur cancel canplay canplaythrough change click close contextmenu copy cuechange cut dblclick drag dragend dragenter dragexit dragleave dragover dragstart drop durationchange emptied ended error focus formdata input invalid keydown keypress keyup load loadeddata loadedmetadata loadstart mousedown mouseenter mouseleave mousemove mouseout mouseover mouseup paste pause play playing pointercancel pointerdown pointerenter pointerleave pointermove pointerout pointerover pointerup progress ratechange reset resize scroll seeked seeking select selectstart selectionchange show stalled submit suspend timeupdate toggle touchcancel touchend touchmove touchstart transitioncancel transitionend transitionrun transitionstart volumechange waiting wheel".split(/\s+/);
  function installOnHandlerSlots(Element2) {
    for (const n of ON_HANDLER_NAMES) {
      const prop = "on" + n;
      if (!(prop in Element2.prototype)) Element2.prototype[prop] = null;
    }
  }
  __name(installOnHandlerSlots, "installOnHandlerSlots");
  var WINDOW_FORWARDED_HANDLERS = ["blur", "error", "focus", "load", "scroll", "resize"];
  var winStore = /* @__PURE__ */ Object.create(null);
  var WINDOW_FORWARDED_ATTR = new Set(WINDOW_FORWARDED_HANDLERS.map((n) => "on" + n));
  function windowForwardedHandlerName(attrName) {
    return WINDOW_FORWARDED_ATTR.has(attrName) ? attrName.slice(2) : null;
  }
  __name(windowForwardedHandlerName, "windowForwardedHandlerName");
  function activateWindowForwardedHandler(name, code) {
    if (code == null) {
      winStore[name] = null;
      return;
    }
    try {
      winStore[name] = new Function("event", String(code));
    } catch (_) {
      winStore[name] = null;
    }
  }
  __name(activateWindowForwardedHandler, "activateWindowForwardedHandler");
  function installWindowForwardedHandlers(Element2) {
    for (const name of WINDOW_FORWARDED_HANDLERS) {
      const on = "on" + name, slot = "_csim_" + on;
      Object.defineProperty(globalThis, on, {
        configurable: true,
        enumerable: true,
        get() {
          return winStore[name] || null;
        },
        set(v) {
          winStore[name] = typeof v === "function" ? v : null;
        }
      });
      Object.defineProperty(Element2.prototype, on, {
        configurable: true,
        enumerable: true,
        get() {
          return this._tag === "body" || this._tag === "frameset" ? winStore[name] || null : this[slot] != null ? this[slot] : null;
        },
        set(v) {
          const fn = typeof v === "function" ? v : null;
          if (this._tag === "body" || this._tag === "frameset") winStore[name] = fn;
          else this[slot] = fn;
        }
      });
    }
  }
  __name(installWindowForwardedHandlers, "installWindowForwardedHandlers");

  // lib/capybara/simulated/js/src/media-query.js
  function mediaMatches(text, vp) {
    if (!text) return true;
    for (const q of splitTopLevel(text, ",")) {
      if (singleMediaMatches(q.trim(), vp)) return true;
    }
    return false;
  }
  __name(mediaMatches, "mediaMatches");
  function supportsMatches(prelude) {
    if (!prelude || typeof prelude !== "string") return true;
    const tokens = tokenizeSupports(prelude);
    let pos = 0;
    const peek = /* @__PURE__ */ __name(() => tokens[pos], "peek");
    const next = /* @__PURE__ */ __name(() => tokens[pos++], "next");
    function parseOr() {
      let v = parseAnd();
      while (peek() && peek().toLowerCase() === "or") {
        next();
        const r = parseAnd();
        v = v || r;
      }
      return v;
    }
    __name(parseOr, "parseOr");
    function parseAnd() {
      let v = parseUnary();
      while (peek() && peek().toLowerCase() === "and") {
        next();
        const r = parseUnary();
        v = v && r;
      }
      return v;
    }
    __name(parseAnd, "parseAnd");
    function parseUnary() {
      if (peek() && peek().toLowerCase() === "not") {
        next();
        return !parseUnary();
      }
      return parsePrimary();
    }
    __name(parseUnary, "parseUnary");
    function parsePrimary() {
      const t = next();
      if (t === void 0) return false;
      if (t === "(") {
        const v = parseOr();
        if (peek() === ")") next();
        return v;
      }
      return evalSupportsFeature(t);
    }
    __name(parsePrimary, "parsePrimary");
    const result = parseOr();
    return result === void 0 ? false : result;
  }
  __name(supportsMatches, "supportsMatches");
  function evalSupportsFeature(text) {
    const s = String(text).trim();
    const fn = /^([a-z-]+)\s*\(([\s\S]*)\)\s*$/i.exec(s);
    if (fn) {
      const name = fn[1].toLowerCase();
      if (name === "selector") {
        const sel = fn[2].trim();
        if (!sel) return false;
        try {
          const groups = globalThis.__csimVendor.cssWhat.parse(sel);
          return !!(groups && groups.length);
        } catch (_) {
          return false;
        }
      }
      return true;
    }
    const idx = s.indexOf(":");
    if (idx === -1) return false;
    let prop = s.slice(0, idx).trim().toLowerCase();
    const value = s.slice(idx + 1).trim();
    if (!prop || !value) return false;
    prop = prop.replace(/^-(webkit|moz|ms|o)-/, "");
    return /^[-a-z]+$/.test(prop);
  }
  __name(evalSupportsFeature, "evalSupportsFeature");
  function tokenizeSupports(input) {
    const out = [];
    let i = 0;
    const n = input.length;
    while (i < n) {
      const ch = input[i];
      if (ch === " " || ch === "	" || ch === "\n" || ch === "\r" || ch === "\f") {
        i++;
        continue;
      }
      if (ch === "(") {
        let depth = 0, j2 = i, inner = "";
        while (j2 < n) {
          const c = input[j2];
          if (c === "(") {
            depth++;
            if (depth > 1) inner += c;
          } else if (c === ")") {
            depth--;
            if (depth === 0) {
              j2++;
              break;
            } else inner += c;
          } else if (depth >= 1) inner += c;
          j2++;
        }
        const trimmed = inner.trim();
        const looksLikeGroup = /(^|\s)(and|or|not)(\s|$)/i.test(trimmed) || /^\(/.test(trimmed);
        if (looksLikeGroup) {
          out.push("(");
          for (const t of tokenizeSupports(trimmed)) out.push(t);
          out.push(")");
        } else {
          out.push(trimmed);
        }
        i = j2;
        continue;
      }
      if (ch === ")") {
        out.push(")");
        i++;
        continue;
      }
      let j = i;
      while (j < n && " 	\n\r\f()".indexOf(input[j]) === -1) j++;
      out.push(input.slice(i, j));
      i = j;
    }
    return out;
  }
  __name(tokenizeSupports, "tokenizeSupports");
  function singleMediaMatches(q, vp) {
    if (!q) return true;
    let negate = false;
    const lower = q.toLowerCase();
    if (/^only\s+/.test(lower)) q = q.replace(/^\s*only\s+/i, "");
    if (/^not\s+/.test(lower)) {
      negate = true;
      q = q.replace(/^\s*not\s+/i, "");
    }
    const parts = splitMediaAnd(q);
    let result = true;
    for (const p of parts) {
      if (!matchMediaPart(p.trim(), vp)) {
        result = false;
        break;
      }
    }
    return negate ? !result : result;
  }
  __name(singleMediaMatches, "singleMediaMatches");
  function splitMediaAnd(s) {
    const out = [];
    let depth = 0, start = 0;
    const lower = s.toLowerCase();
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      else if (depth === 0) {
        const prev = i > 0 ? s[i - 1] : "";
        const isAndStart = (prev === ")" || /\s/.test(prev)) && lower.startsWith("and", i) && (i + 3 >= s.length || /\s/.test(s[i + 3]) || s[i + 3] === "(");
        if (isAndStart) {
          out.push(s.slice(start, i).trimEnd());
          i += 3;
          start = i;
        }
      }
    }
    out.push(s.slice(start).trimStart());
    return out;
  }
  __name(splitMediaAnd, "splitMediaAnd");
  function matchMediaPart(p, vp) {
    if (!p) return true;
    if (p[0] !== "(") {
      const t = p.toLowerCase().trim();
      if (t === "all" || t === "" || t === "screen") return true;
      if (t === "print" || t === "speech") return false;
      return false;
    }
    if (p[p.length - 1] !== ")") return false;
    const inside = p.slice(1, -1).trim();
    const m = /^([a-zA-Z-]+)\s*:\s*(.*)$/.exec(inside);
    if (!m) {
      const name = inside.toLowerCase().trim();
      if (name === "hover" || name === "any-hover") return true;
      if (name === "pointer" || name === "any-pointer") return true;
      return false;
    }
    const feat = m[1].toLowerCase();
    const val = m[2].trim().toLowerCase();
    if (feat === "min-width") return vp.width >= parsePx(val);
    if (feat === "max-width") return vp.width <= parsePx(val);
    if (feat === "width") return vp.width === parsePx(val);
    if (feat === "min-height") return vp.height >= parsePx(val);
    if (feat === "max-height") return vp.height <= parsePx(val);
    if (feat === "height") return vp.height === parsePx(val);
    if (feat === "orientation") return val === (vp.width >= vp.height ? "landscape" : "portrait");
    if (feat === "hover" || feat === "any-hover") return val === (vp.width <= 700 ? "none" : "hover");
    if (feat === "pointer" || feat === "any-pointer") return val === (vp.width <= 700 ? "coarse" : "fine");
    if (feat === "prefers-color-scheme") return val === "light";
    if (feat === "prefers-reduced-motion") return val === "no-preference";
    if (feat === "min-resolution" || feat === "max-resolution" || feat === "resolution") {
      const t = parseDppx(val);
      if (feat === "min-resolution") return 1 >= t;
      if (feat === "max-resolution") return 1 <= t;
      return 1 === t;
    }
    return false;
  }
  __name(matchMediaPart, "matchMediaPart");
  var PX_PER_EM = 16;
  var DPI_PER_DPPX = 96;
  var CM_PER_INCH = 2.54;
  var DPCM_PER_DPPX = DPI_PER_DPPX / CM_PER_INCH;
  function parsePx(s) {
    const n = parseFloat(s);
    if (Number.isNaN(n)) return 0;
    if (/em$/.test(s)) return n * PX_PER_EM;
    if (/rem$/.test(s)) return n * PX_PER_EM;
    return n;
  }
  __name(parsePx, "parsePx");
  function parseDppx(s) {
    const n = parseFloat(s);
    if (Number.isNaN(n)) return 1;
    if (/dppx$/.test(s)) return n;
    if (/dpi$/.test(s)) return n / DPI_PER_DPPX;
    if (/dpcm$/.test(s)) return n / DPCM_PER_DPPX;
    return n;
  }
  __name(parseDppx, "parseDppx");
  var VIEWPORT_DEFAULT = { width: 1024, height: 768 };
  function currentViewport() {
    return {
      width: Number(globalThis.innerWidth) || VIEWPORT_DEFAULT.width,
      height: Number(globalThis.innerHeight) || VIEWPORT_DEFAULT.height
    };
  }
  __name(currentViewport, "currentViewport");
  var MediaQueryList = class extends EventTarget {
    static {
      __name(this, "MediaQueryList");
    }
    constructor(text) {
      super();
      this.media = text;
      this.onchange = null;
      this._lastMatches = mediaMatches(text, currentViewport());
    }
    get matches() {
      return mediaMatches(this.media, currentViewport());
    }
    addListener(handler) {
      this.addEventListener("change", handler);
    }
    removeListener(handler) {
      this.removeEventListener("change", handler);
    }
  };
  var _activeQueries = [];
  globalThis.matchMedia = /* @__PURE__ */ __name(function matchMedia(query) {
    const mql = new MediaQueryList(String(query || ""));
    _activeQueries.push(mql);
    return mql;
  }, "matchMedia");
  globalThis.__csimViewportChanged = function() {
    for (const mql of _activeQueries) {
      const now = mediaMatches(mql.media, currentViewport());
      if (now !== mql._lastMatches) {
        mql._lastMatches = now;
        dispatchWithOnHandler(mql, { type: "change", matches: now, media: mql.media });
      }
    }
  };

  // lib/capybara/simulated/js/src/selectors.js
  var cssSelect = globalThis.__csimVendor.cssSelect;
  var cssWhat = globalThis.__csimVendor.cssWhat;
  var cssTree = globalThis.__csimVendor.cssTree;
  var HTML_NS = "http://www.w3.org/1999/xhtml";
  var asciiLower = /* @__PURE__ */ __name((s) => s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32)), "asciiLower");
  var strictValidated = /* @__PURE__ */ new Set();
  var focusPseudoMatchers = {
    focus: /* @__PURE__ */ __name((el) => globalThis.document && globalThis.document._activeElement === el, "focus"),
    "focus-visible": /* @__PURE__ */ __name((el) => globalThis.document && globalThis.document._activeElement === el, "focus-visible"),
    "focus-within": /* @__PURE__ */ __name((el) => {
      const active = globalThis.document && globalThis.document._activeElement;
      if (!active) return false;
      for (let cur = active; cur; cur = cur._parent) if (cur === el) return true;
      return false;
    }, "focus-within")
  };
  var adapter = {
    isTag: /* @__PURE__ */ __name((n) => n && n.nodeType === NODE_ELEMENT, "isTag"),
    existsOne(test, elems) {
      return this.findOne(test, elems) !== null;
    },
    getAttributeValue: /* @__PURE__ */ __name((el, name) => {
      const attrs = el._attrs;
      if (Object.prototype.hasOwnProperty.call(attrs, name)) return attrs[name];
      if (el._ns === HTML_NS && /[A-Z]/.test(name)) {
        const k = asciiLower(name);
        if (Object.prototype.hasOwnProperty.call(attrs, k)) return attrs[k];
      }
      return void 0;
    }, "getAttributeValue"),
    getChildren: /* @__PURE__ */ __name((n) => n._children, "getChildren"),
    getName: /* @__PURE__ */ __name((el) => el._tag, "getName"),
    getParent: /* @__PURE__ */ __name((n) => n._parent, "getParent"),
    getSiblings: /* @__PURE__ */ __name((n) => n._parent ? n._parent._children : [n], "getSiblings"),
    prevElementSibling: /* @__PURE__ */ __name((n) => n.previousElementSibling, "prevElementSibling"),
    // domutils-style "rendered text": "" for comment / PI nodes (their data is
    // NOT content), the node's text otherwise. Pairs with our LOCAL css-select
    // `:empty` patch, which makes a whitespace-only text child disqualify :empty
    // to match real browsers (`<p> </p>` is not :empty in Chrome). That patch is
    // deliberately LOCAL-ONLY — do NOT upstream it: css-select allows whitespace
    // in :empty on purpose (maintainer PR #795, Selectors-4 wording), so reversing
    // it is a spec-vs-impl policy change, not a bug fix. This getText shim lets a
    // comment/PI child not disqualify while a text node does (a Comment's DOM
    // `textContent` is its data, which would wrongly fail `<p><!--x--></p>`).
    getText: /* @__PURE__ */ __name((n) => n.nodeType === NODE_COMMENT || n.nodeType === NODE_PI ? "" : n.textContent, "getText"),
    hasAttrib: /* @__PURE__ */ __name((el, name) => {
      const attrs = el._attrs;
      if (Object.prototype.hasOwnProperty.call(attrs, name)) return true;
      return el._ns === HTML_NS && /[A-Z]/.test(name) && // HTML: names are case-insensitive
      Object.prototype.hasOwnProperty.call(attrs, asciiLower(name));
    }, "hasAttrib"),
    // Drop nodes whose ancestor is also in the list (css-select calls
    // this to dedup before iterating; e.g. `:has(...)` results).
    removeSubsets(nodes) {
      const out = nodes.slice();
      let i = out.length;
      while (--i >= 0) {
        let p = out[i]._parent;
        while (p) {
          if (out.includes(p)) {
            out.splice(i, 1);
            break;
          }
          p = p._parent;
        }
      }
      return out;
    },
    findAll(test, nodes) {
      const out = [];
      const visit = /* @__PURE__ */ __name((el) => {
        if (test(el)) out.push(el);
      }, "visit");
      for (const n of nodes) walk(n, visit);
      return out;
    },
    findOne(test, nodes) {
      for (const n of nodes) {
        const hit = walkFind(n, test);
        if (hit) return hit;
      }
      return null;
    },
    equals: /* @__PURE__ */ __name((a, b) => a === b, "equals"),
    // `:hover` applies to the hovered element AND every ancestor. We track the
    // last-moused-over node on `document._hoverElement` (set by dispatchHover);
    // `el` is hovered iff it's on that node's ancestor-or-self chain. The cascade
    // matches through css-select now, so this hook is what makes `.x:hover .y`
    // reveal rules resolve after `hover` — the matcher used to own this.
    isHovered: /* @__PURE__ */ __name((el) => {
      const hov = globalThis.document && globalThis.document._hoverElement;
      let cur = hov;
      while (cur) {
        if (cur === el) return true;
        cur = cur._parent;
      }
      return false;
    }, "isHovered"),
    // No real layout / history → `:visited` / `:active` never apply.
    isVisited: /* @__PURE__ */ __name(() => false, "isVisited"),
    isActive: /* @__PURE__ */ __name(() => false, "isActive"),
    // `:root` matches ONLY the document's root element (`documentElement`), not
    // any element that merely lacks an element parent — css-select's default
    // (`getElementParent(el) === null`) wrongly matches a DocumentFragment's top
    // child. Our patched `root` filter calls this hook.
    isDocumentRoot: /* @__PURE__ */ __name((el) => {
      const doc = el && (el._ownerDoc || globalThis.document);
      return !!doc && doc.documentElement === el;
    }, "isDocumentRoot")
  };
  var BARRED_INPUT_TYPES = /* @__PURE__ */ new Set(["hidden", "reset", "button"]);
  var BARRED_BUTTON_TYPES = /* @__PURE__ */ new Set(["reset", "button"]);
  function isInFirstLegend(el, fieldset) {
    let legend = null;
    if (fieldset._children) {
      for (const c of fieldset._children) {
        if (c.nodeType === NODE_ELEMENT && c._tag === "legend") {
          legend = c;
          break;
        }
      }
    }
    if (!legend) return false;
    for (let p = el; p; p = p._parent) {
      if (p === legend) return true;
      if (p === fieldset) return false;
    }
    return false;
  }
  __name(isInFirstLegend, "isInFirstLegend");
  function isEffectivelyDisabled(el) {
    if (el._attrs.disabled != null) return true;
    for (let p = el._parent; p; p = p._parent) {
      if (p._tag === "fieldset" && p._attrs.disabled != null && !isInFirstLegend(el, p)) return true;
    }
    return false;
  }
  __name(isEffectivelyDisabled, "isEffectivelyDisabled");
  function isValidationCandidate(el) {
    const t = el._tag;
    let barred;
    if (t === "input") barred = BARRED_INPUT_TYPES.has((el._attrs.type || "").toLowerCase());
    else if (t === "button") barred = BARRED_BUTTON_TYPES.has((el._attrs.type || "").toLowerCase());
    else if (t === "textarea" || t === "select") barred = false;
    else return false;
    if (barred) return false;
    if ((t === "input" || t === "textarea") && el._attrs.readonly != null) return false;
    return !isEffectivelyDisabled(el);
  }
  __name(isValidationCandidate, "isValidationCandidate");
  function controlIsInvalid(el) {
    if (!isValidationCandidate(el)) return false;
    const v = el.validity;
    return !!v && v.valid === false;
  }
  __name(controlIsInvalid, "controlIsInvalid");
  function hasInvalidDescendant(el) {
    const stack = el._children ? el._children.slice() : [];
    while (stack.length) {
      const n = stack.pop();
      if (n.nodeType !== NODE_ELEMENT) continue;
      if (controlIsInvalid(n)) return true;
      if (n._children) for (const c of n._children) stack.push(c);
    }
    return false;
  }
  __name(hasInvalidDescendant, "hasInvalidDescendant");
  var userPseudos = {
    ...focusPseudoMatchers,
    // Pseudo-classes css-select doesn't implement natively (it throws "Unknown
    // pseudo-class") but the visibility cascade — and CSS-only UIs — rely on.
    // Ported from the old hand-rolled matcher; required now that the cascade
    // matches through css-select. css-select calls `fn(elem)` for these.
    // :target = the element whose id matches the document's URL fragment. The
    // element must be IN the document (a detached / DocumentFragment clone with
    // the same id is not the target). The fragment comes from the element's OWN
    // document: a nested frame document carries its src URL (incl. #fragment) on
    // `_url`; the main document's fragment lives on the shared `location`.
    target: /* @__PURE__ */ __name((el) => {
      const id = el._attrs.id;
      if (!id || !isConnected(el)) return false;
      const doc = el._ownerDoc;
      let hash = "";
      if (doc && doc._url) {
        try {
          hash = new URL(doc._url).hash;
        } catch (_) {
          hash = "";
        }
      } else {
        hash = globalThis.location && globalThis.location.hash || "";
      }
      if (hash.length <= 1) return false;
      let frag = hash.slice(1);
      try {
        frag = decodeURIComponent(frag);
      } catch (_) {
      }
      return frag === id;
    }, "target"),
    "placeholder-shown": /* @__PURE__ */ __name((el) => {
      if (el._tag !== "input" && el._tag !== "textarea") return false;
      if (el._attrs.placeholder == null) return false;
      const v = el._attrs.value;
      return v == null || v === "";
    }, "placeholder-shown"),
    default: /* @__PURE__ */ __name((el) => {
      if (el._tag === "option") return el._attrs.selected != null;
      if (el._tag === "input") {
        const t = (el._attrs.type || "").toLowerCase();
        if (t === "checkbox" || t === "radio") return el._attrs.checked != null;
        if (t === "submit" || t === "image") return true;
      }
      if (el._tag === "button") return (el._attrs.type || "submit").toLowerCase() === "submit";
      return false;
    }, "default"),
    indeterminate: /* @__PURE__ */ __name((el) => el._indeterminate === true, "indeterminate"),
    valid: /* @__PURE__ */ __name((el) => {
      if (isValidationCandidate(el)) {
        const v = el.validity;
        return !v || v.valid !== false;
      }
      if (el._tag === "form" || el._tag === "fieldset") return !hasInvalidDescendant(el);
      return false;
    }, "valid"),
    invalid: /* @__PURE__ */ __name((el) => {
      if (isValidationCandidate(el)) return controlIsInvalid(el);
      if (el._tag === "form" || el._tag === "fieldset") return hasInvalidDescendant(el);
      return false;
    }, "invalid"),
    "user-valid": /* @__PURE__ */ __name(() => true, "user-valid"),
    "user-invalid": /* @__PURE__ */ __name(() => false, "user-invalid")
  };
  function rejectInvalidStrict(key) {
    if (typeof key !== "string" || strictValidated.has(key)) return;
    let probe = key;
    const tail = probe.match(/\\+$/);
    if (tail && tail[0].length % 2 === 1) probe = probe.slice(0, -1) + "\uFFFD";
    let ast;
    try {
      ast = cssTree.parse(probe, { context: "selectorList" });
    } catch (e) {
      throw new globalThis.DOMException("csim: " + (e && e.message ? e.message : e), "SyntaxError");
    }
    ast.children.forEach((sel) => {
      const first = sel.children && sel.children.first;
      if (first && first.type === "Combinator") {
        throw new globalThis.DOMException("csim: a relative selector is not allowed here", "SyntaxError");
      }
    });
    strictValidated.add(key);
  }
  __name(rejectInvalidStrict, "rejectInvalidStrict");
  var compiledCacheNoScope = /* @__PURE__ */ new Map();
  var compiledCacheScoped = /* @__PURE__ */ new WeakMap();
  function selectorNeedsScope(key) {
    return key.indexOf(":scope") !== -1;
  }
  __name(selectorNeedsScope, "selectorNeedsScope");
  function compile(sel, scopeRoot) {
    if (typeof sel !== "string") sel = String(sel);
    if (sel.indexOf("\0") !== -1) sel = sel.replace(/\x00/g, "\uFFFD");
    const key = sel;
    if (key.trim() === "") {
      throw new globalThis.DOMException("csim: '' is not a valid selector", "SyntaxError");
    }
    if (scopeRoot == null || !selectorNeedsScope(key)) {
      let fn2 = compiledCacheNoScope.get(key);
      if (fn2) return fn2;
      fn2 = compileRaw(key);
      compiledCacheNoScope.set(key, fn2);
      return fn2;
    }
    let perKey = compiledCacheScoped.get(scopeRoot);
    if (!perKey) {
      perKey = /* @__PURE__ */ new Map();
      compiledCacheScoped.set(scopeRoot, perKey);
    }
    let fn = perKey.get(key);
    if (fn) return fn;
    fn = compileRaw(key, [scopeRoot]);
    perKey.set(key, fn);
    return fn;
  }
  __name(compile, "compile");
  var KNOWN_PSEUDO_ELEMENTS = /* @__PURE__ */ new Set(["before", "after", "first-line", "first-letter", "slotted"]);
  function targetsPseudoElement(arm) {
    let groups;
    try {
      groups = cssWhat.parse(arm);
    } catch (_) {
      return /::slotted\([^)]*$/i.test(arm);
    }
    return (groups[0] || []).some((t) => t.type === "pseudo-element" && KNOWN_PSEUDO_ELEMENTS.has((t.name || "").toLowerCase()));
  }
  __name(targetsPseudoElement, "targetsPseudoElement");
  function compileRaw(key, context) {
    let fn;
    try {
      fn = cssSelect.compile(key, { adapter, pseudos: userPseudos, cacheResults: false, lowerCaseAttributeNames: false }, context);
    } catch (e) {
      const f = pseudoElementFallback(key, context);
      if (f) return f;
      const nsFn = namespaceFallback(key, context);
      if (nsFn) return nsFn;
      throw new globalThis.DOMException("csim: " + (e && e.message ? e.message : e), "SyntaxError");
    }
    rejectInvalidStrict(key);
    return fn;
  }
  __name(compileRaw, "compileRaw");
  function namespaceFallback(key, context) {
    let groups;
    try {
      groups = cssWhat.parse(key);
    } catch (_) {
      return null;
    }
    if (groups.length !== 1) return null;
    const group = groups[0];
    let lastComb = -1;
    for (let i = 0; i < group.length; i++) if (cssWhat.isTraversal(group[i])) lastComb = i;
    let hasNs = false, subjectNoNs = false;
    for (let i = 0; i < group.length; i++) {
      const t = group[i];
      if (t.namespace == null) continue;
      hasNs = true;
      if (t.namespace !== "*" && t.namespace !== "") return null;
      if (t.namespace === "" && (t.type === "tag" || t.type === "universal") && i > lastComb) subjectNoNs = true;
      t.namespace = null;
    }
    if (!hasNs) return null;
    let compiled;
    try {
      compiled = cssSelect.compile(cssWhat.stringify(groups), { adapter, pseudos: userPseudos, cacheResults: false, lowerCaseAttributeNames: false }, context);
    } catch (_) {
      return null;
    }
    if (!subjectNoNs) return compiled;
    return (el) => compiled(el) && el.namespaceURI == null;
  }
  __name(namespaceFallback, "namespaceFallback");
  function pseudoElementFallback(key, context) {
    const arms = splitTopLevel(key, ",").map((a) => a.trim()).filter(Boolean);
    if (!arms.some(targetsPseudoElement)) return null;
    const fns = [];
    for (const arm of arms) {
      if (targetsPseudoElement(arm)) continue;
      try {
        fns.push(cssSelect.compile(arm, { adapter, pseudos: userPseudos, cacheResults: false, lowerCaseAttributeNames: false }, context));
      } catch (_) {
        return null;
      }
    }
    if (fns.length === 0) return () => false;
    if (fns.length === 1) return fns[0];
    return (el) => fns.some((f) => f(el));
  }
  __name(pseudoElementFallback, "pseudoElementFallback");
  function selectAll(roots, sel, scopeRoot) {
    return adapter.findAll(compile(sel, scopeRoot), roots);
  }
  __name(selectAll, "selectAll");
  function selectFirst(roots, sel, scopeRoot) {
    return adapter.findOne(compile(sel, scopeRoot), roots);
  }
  __name(selectFirst, "selectFirst");
  function matchesSelector(el, sel) {
    return el && el.nodeType === NODE_ELEMENT && compile(sel, el)(el);
  }
  __name(matchesSelector, "matchesSelector");
  function closestSelector(el, sel) {
    const fn = compile(sel, el);
    for (let cur = el; cur; cur = cur._parent) {
      if (cur.nodeType === NODE_ELEMENT && fn(cur)) return cur;
    }
    return null;
  }
  __name(closestSelector, "closestSelector");

  // lib/capybara/simulated/js/src/cascade.js
  var CT = globalThis.__csimVendor.cssTree;
  var CW = globalThis.__csimVendor.cssWhat;
  function compareSpec(a, b) {
    return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  }
  __name(compareSpec, "compareSpec");
  var SPEC_ZERO_PSEUDOS = /* @__PURE__ */ new Set(["where"]);
  var SPEC_MAX_PSEUDOS = /* @__PURE__ */ new Set(["is", "not", "has", "matches", "-webkit-any"]);
  function addSpec(a, s) {
    a[0] += s[0];
    a[1] += s[1];
    a[2] += s[2];
  }
  __name(addSpec, "addSpec");
  function selectorListMax(children) {
    let best = [0, 0, 0];
    if (!children) return best;
    children.forEach((ch) => {
      if (ch.type === "SelectorList") {
        ch.children.forEach((sel) => {
          const s = selectorSpecificity(sel);
          if (compareSpec(s, best) > 0) best = s;
        });
      } else if (ch.type === "Selector") {
        const s = selectorSpecificity(ch);
        if (compareSpec(s, best) > 0) best = s;
      } else if (ch.type === "Raw") {
        try {
          CT.parse(ch.value, { context: "selectorList" }).children.forEach((sel) => {
            const s = selectorSpecificity(sel);
            if (compareSpec(s, best) > 0) best = s;
          });
        } catch (_) {
        }
      }
    });
    return best;
  }
  __name(selectorListMax, "selectorListMax");
  function selectorSpecificity(selNode) {
    const acc = [0, 0, 0];
    CT.walk(selNode, {
      enter(node) {
        switch (node.type) {
          case "IdSelector":
            acc[0]++;
            break;
          case "ClassSelector":
          case "AttributeSelector":
            acc[1]++;
            break;
          case "TypeSelector":
            if (node.name !== "*") acc[2]++;
            break;
          case "PseudoElementSelector":
            acc[2]++;
            break;
          case "PseudoClassSelector": {
            const n = (node.name || "").toLowerCase();
            if (SPEC_ZERO_PSEUDOS.has(n)) return this.skip;
            if (SPEC_MAX_PSEUDOS.has(n)) {
              addSpec(acc, selectorListMax(node.children));
              return this.skip;
            }
            acc[1]++;
            break;
          }
        }
      }
    });
    return acc;
  }
  __name(selectorSpecificity, "selectorSpecificity");
  function specificityOf(selText) {
    try {
      return selectorSpecificity(CT.parse(selText, { context: "selector" }));
    } catch (_) {
      return [0, 0, 0];
    }
  }
  __name(specificityOf, "specificityOf");
  var CW_COMBINATORS = /* @__PURE__ */ new Set(["descendant", "child", "parent", "sibling", "adjacent", "column-combinator"]);
  function terminalKey(selText) {
    let groups;
    try {
      groups = CW.parse(selText);
    } catch (_) {
      return { kind: "universal" };
    }
    let id = null, cls = null, tag = null;
    for (const t of groups[0] || []) {
      if (CW_COMBINATORS.has(t.type)) {
        id = cls = tag = null;
        continue;
      }
      if (t.type === "tag") {
        if (t.name !== "*") tag = t.name.toLowerCase();
      } else if (t.type === "attribute") {
        if (t.name === "class" && t.action === "element") {
          if (!cls) cls = t.value;
        } else if (t.name === "id" && t.action === "equals") {
          if (!id) id = t.value;
        }
      }
    }
    if (cls) return { kind: "class", key: cls };
    if (id) return { kind: "id", key: id };
    if (tag) return { kind: "tag", key: tag };
    return { kind: "universal" };
  }
  __name(terminalKey, "terminalKey");
  function safeMatches(el, selectorText) {
    try {
      return matchesSelector(el, selectorText);
    } catch (_) {
      return false;
    }
  }
  __name(safeMatches, "safeMatches");
  var INVISIBLE_TAGS = /* @__PURE__ */ new Set(["head", "script", "style", "template", "noscript", "title"]);
  function isVisibleNode(el) {
    return isVisibleNodeImpl(el, false);
  }
  __name(isVisibleNode, "isVisibleNode");
  function isLaidOutNode(el) {
    return isVisibleNodeImpl(el, true);
  }
  __name(isLaidOutNode, "isLaidOutNode");
  function isVisibleNodeImpl(el, ignoreVisibility) {
    if (!el || el.nodeType !== NODE_ELEMENT) return false;
    if (INVISIBLE_TAGS.has(el._tag)) return false;
    if (el._tag === "input" && (el._attrs.type || "").toLowerCase() === "hidden") return false;
    let cur = el, connected = false;
    while (cur) {
      if (cur.nodeType === NODE_DOC) {
        connected = true;
        break;
      }
      if (cur.nodeType === NODE_ELEMENT) {
        if (INVISIBLE_TAGS.has(cur._tag)) return false;
        if (selfHidden(cur, true)) return false;
      }
      cur = cur._parent;
    }
    if (!connected) return false;
    if (!ignoreVisibility && visibilityHidden(el)) return false;
    return true;
  }
  __name(isVisibleNodeImpl, "isVisibleNodeImpl");
  globalThis.__isVisibleNode = isVisibleNode;
  globalThis.__isLaidOutNode = isLaidOutNode;
  function selfHidden(el, ignoreVisibility = false) {
    const hidden = el._attrs.hidden != null;
    if (el._tag === "dialog" && el._attrs.open == null) return true;
    const inline = inlineHideDecl(el);
    if (inline && !state.hasImportantHideRule) {
      if (inline.display === "none") return true;
      if (!ignoreVisibility && (inline.visibility === "hidden" || inline.visibility === "collapse")) return true;
      const displaySettled = inline.display != null;
      const visibilitySettled = ignoreVisibility || inline.visibility != null;
      if (displaySettled && visibilitySettled) return false;
    }
    return matchesAnyHideRule(el, ignoreVisibility, inline, hidden);
  }
  __name(selfHidden, "selfHidden");
  function inlineHideDecl(el) {
    const style = el._attrs && el._attrs.style;
    if (!style) return null;
    if (el._isKey === style) return el._isCache;
    let display = null, displayImp = false;
    let visibility = null, visibilityImp = false;
    const dm = /(?:^|;)\s*display\s*:\s*([^;]+)/i.exec(style);
    if (dm) {
      let v = dm[1].trim();
      if (/!\s*important\s*$/i.test(v)) {
        displayImp = true;
        v = v.replace(/!\s*important\s*$/i, "").trim();
      }
      display = v.toLowerCase();
    }
    const vm = /(?:^|;)\s*visibility\s*:\s*([^;]+)/i.exec(style);
    if (vm) {
      let v = vm[1].trim();
      if (/!\s*important\s*$/i.test(v)) {
        visibilityImp = true;
        v = v.replace(/!\s*important\s*$/i, "").trim();
      }
      visibility = v.toLowerCase();
    }
    if (display == null && visibility == null) {
      el._isKey = style;
      el._isCache = null;
      return null;
    }
    const decl = {
      display,
      displayImp,
      visibility,
      visibilityImp,
      inline: true,
      spec: [0, 0, 0],
      source: Number.MAX_SAFE_INTEGER
    };
    el._isKey = style;
    el._isCache = decl;
    return decl;
  }
  __name(inlineHideDecl, "inlineHideDecl");
  var state = {
    hideRules: [],
    layoutRules: [],
    hideIdx: null,
    layoutIdx: null,
    ruleSerial: 0,
    hasImportantHideRule: false,
    hasVisibilityRule: false
  };
  function fnv1a(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
    }
    return h.toString(16);
  }
  __name(fnv1a, "fnv1a");
  function cascadeCacheKey(doc, vp) {
    const root = doc.documentElement;
    let acc = "vp:" + vp.width + "x" + vp.height;
    for (const s of root.querySelectorAll("style")) {
      const media = s._attrs.media;
      if (media && !mediaMatches(media, vp)) continue;
      const t = scriptText(s);
      if (t) acc += "\nS:" + fnv1a(t) + ":" + t.length;
    }
    for (const l of root.querySelectorAll("link")) {
      const rel = (l._attrs.rel || "").toLowerCase();
      if (!rel.split(/\s+/).includes("stylesheet")) continue;
      const href = l._attrs.href;
      if (!href) continue;
      const media = l._attrs.media;
      if (media && !mediaMatches(media, vp)) continue;
      acc += "\nL:" + href;
    }
    return acc;
  }
  __name(cascadeCacheKey, "cascadeCacheKey");
  var lastCascadeKey = null;
  var cascadeVersion = 0;
  globalThis.__csimCascadeVersion = () => cascadeVersion;
  function rebuildCascade(doc) {
    doc = doc || globalThis.document;
    if (!doc || !doc.documentElement) return;
    let hide, layout;
    const vp = currentViewport();
    const key = cascadeCacheKey(doc, vp);
    if (key === lastCascadeKey) return;
    lastCascadeKey = key;
    cascadeVersion = cascadeVersion + 1 | 0;
    const getFn = globalThis.__csimCascadeCacheGet;
    const cached = getFn ? getFn(key) : null;
    if (cached) {
      try {
        const obj = JSON.parse(cached);
        hide = obj.hide;
        layout = obj.layout;
      } catch (_) {
        hide = null;
      }
    }
    if (!hide) {
      ({ hide, layout } = collectCascadeRules(doc));
      const putFn = globalThis.__csimCascadeCachePut;
      if (putFn) {
        try {
          putFn(key, JSON.stringify({ hide, layout }));
        } catch (_) {
        }
      }
    }
    state.hideRules = hide;
    state.layoutRules = layout;
    state.hideIdx = state.layoutIdx = null;
    state.propCache = null;
    state.hasImportantHideRule = computeHasImportantHideRule(hide);
    state.hasVisibilityRule = computeHasVisibilityRule(hide);
  }
  __name(rebuildCascade, "rebuildCascade");
  function resetCascadeState() {
    lastCascadeKey = null;
    cascadeVersion = cascadeVersion + 1 | 0;
    state.hideRules = [];
    state.layoutRules = [];
    state.hideIdx = state.layoutIdx = null;
    state.propCache = null;
    state.hasImportantHideRule = false;
    state.hasVisibilityRule = false;
  }
  __name(resetCascadeState, "resetCascadeState");
  function computeHasImportantHideRule(hide) {
    for (const r of hide) {
      if (r.displayImp || r.visibilityImp) return true;
    }
    return false;
  }
  __name(computeHasImportantHideRule, "computeHasImportantHideRule");
  function computeHasVisibilityRule(hide) {
    for (const r of hide) {
      if (r.visibility != null) return true;
    }
    return false;
  }
  __name(computeHasVisibilityRule, "computeHasVisibilityRule");
  globalThis.__csimRebuildCascade = function() {
    rebuildCascade();
  };
  var cascadeRefreshScheduled = false;
  function scheduleCascadeRefresh() {
    if (cascadeRefreshScheduled) return;
    cascadeRefreshScheduled = true;
    Promise.resolve().then(() => {
      cascadeRefreshScheduled = false;
      try {
        rebuildCascade(globalThis.document);
      } catch (_) {
      }
    });
  }
  __name(scheduleCascadeRefresh, "scheduleCascadeRefresh");
  var LOWERCASE_VALUE_PROPS = /* @__PURE__ */ new Set(["display", "visibility", "text-transform", "white-space"]);
  var CAPTURED_PROPS = /* @__PURE__ */ new Set(["top", "left", "width", "height", "color", "background-color"]);
  function containerMatches(prelude, vp) {
    const featureQuery = (prelude || "").replace(/^[^\s(]*\s*/, "");
    if (!featureQuery.trim().startsWith("(")) return true;
    return mediaMatches(featureQuery, vp);
  }
  __name(containerMatches, "containerMatches");
  function composeNestedSelector(child, parent) {
    if (!parent) return child;
    const childParts = splitTopLevel(child, ",").map((p) => p.trim()).filter(Boolean);
    const parentParts = splitTopLevel(parent, ",").map((p) => p.trim()).filter(Boolean);
    const out = [];
    for (const cp of childParts) {
      const hasAmpersand = /&/.test(cp);
      for (const pp of parentParts) {
        if (hasAmpersand) {
          out.push(cp.replace(/&/g, ":is(" + pp + ")"));
        } else {
          out.push(pp + " " + cp);
        }
      }
    }
    return out.join(", ");
  }
  __name(composeNestedSelector, "composeNestedSelector");
  var CSS_COMMENT_RE = /\/\*[\s\S]*?\*\//g;
  function ruleDecls(block) {
    const decls = [];
    if (!block || !block.children) return decls;
    block.children.forEach((node) => {
      if (node.type !== "Declaration") return;
      const prop = node.property.toLowerCase();
      const custom = prop.startsWith("--");
      if (!LOWERCASE_VALUE_PROPS.has(prop) && !CAPTURED_PROPS.has(prop) && !custom) return;
      let value = CT.generate(node.value).replace(CSS_COMMENT_RE, "").trim();
      if (LOWERCASE_VALUE_PROPS.has(prop)) value = value.toLowerCase();
      decls.push({ prop, value, important: !!node.important });
    });
    return decls;
  }
  __name(ruleDecls, "ruleDecls");
  function preludeSource(ruleNode, src) {
    const end = ruleNode.block.loc.start.offset;
    return src.slice(ruleNode.loc.start.offset, end).replace(CSS_COMMENT_RE, "").trim();
  }
  __name(preludeSource, "preludeSource");
  function cssTreeFlatten(cssText, vp) {
    const out = [];
    const layers = [];
    const seenLayers = /* @__PURE__ */ new Set();
    let anon = 0;
    const addLayer = /* @__PURE__ */ __name((full) => {
      if (!seenLayers.has(full)) {
        seenLayers.add(full);
        layers.push(full);
      }
    }, "addLayer");
    const PARSE_OPTS = { parseValue: false, parseRulePrelude: false, positions: true };
    const emitRule = /* @__PURE__ */ __name((ruleNode, src, parentSel, layer) => {
      const sel = composeNestedSelector(preludeSource(ruleNode, src), parentSel);
      const decls = ruleDecls(ruleNode.block);
      if (decls.length) out.push({ selectorText: sel, decls, layer });
      visit(ruleNode.block && ruleNode.block.children, src, sel, layer);
    }, "emitRule");
    const visit = /* @__PURE__ */ __name((children, src, parentSel, layer) => {
      if (!children) return;
      children.forEach((node) => {
        if (node.type === "Rule") {
          emitRule(node, src, parentSel, layer);
        } else if (node.type === "Raw") {
          if (parentSel && node.loc && node.value.indexOf("{") !== -1) {
            const mini = "& " + src.slice(node.loc.start.offset, node.loc.end.offset);
            let r;
            try {
              r = CT.parse(mini, { context: "rule", ...PARSE_OPTS });
            } catch (_) {
              return;
            }
            if (r && r.type === "Rule") emitRule(r, mini, parentSel, layer);
          }
        } else if (node.type === "Atrule") {
          const name = (node.name || "").toLowerCase();
          const prelude = node.prelude ? CT.generate(node.prelude).trim() : "";
          if (name === "layer") {
            const names = prelude ? prelude.split(",").map((s) => s.trim()).filter(Boolean) : [];
            const qualify = /* @__PURE__ */ __name((nm) => layer ? layer + "." + nm : nm, "qualify");
            if (node.block) {
              const full = qualify(names[0] || "%anon" + anon++);
              addLayer(full);
              visit(node.block.children, src, parentSel, full);
            } else {
              for (const nm of names) addLayer(qualify(nm));
            }
            return;
          }
          if (name === "media") {
            if (!mediaMatches(prelude, vp)) return;
          } else if (name === "supports") {
            if (!supportsMatches(prelude)) return;
          } else if (name === "container") {
            if (!containerMatches(prelude, vp)) return;
          } else {
            return;
          }
          if (parentSel) {
            const decls = ruleDecls(node.block);
            if (decls.length) out.push({ selectorText: parentSel, decls, layer });
          }
          visit(node.block && node.block.children, src, parentSel, layer);
        }
      });
    }, "visit");
    let ast;
    try {
      ast = CT.parse(cssText, PARSE_OPTS);
    } catch (_) {
      return { rules: out, layers };
    }
    visit(ast.children, cssText, null, null);
    return { rules: out, layers };
  }
  __name(cssTreeFlatten, "cssTreeFlatten");
  var __sheetCache = /* @__PURE__ */ new Map();
  var SHEET_CACHE_LIMIT = 256;
  function __sheetCacheKey(text, vp) {
    let h = 5381;
    for (let i = 0; i < text.length; i++) h = (h << 5) + h + text.charCodeAt(i) | 0;
    return text.length + ":" + (h >>> 0).toString(16) + ":" + vp.width + "x" + vp.height;
  }
  __name(__sheetCacheKey, "__sheetCacheKey");
  function parseSheet(cssText, vp) {
    const hide = [];
    const layout = [];
    let serial = 0;
    let flat;
    try {
      flat = cssTreeFlatten(cssText, vp);
    } catch (_) {
      return { hide, layout, count: 0, layers: [] };
    }
    for (const r of flat.rules) {
      if (!r.selectorText || !r.decls.length) continue;
      let display = null, displayImp = false;
      let visibility = null, visibilityImp = false;
      const captured = {};
      for (const d of r.decls) {
        if (d.prop === "display") {
          display = d.value;
          displayImp = d.important;
        } else if (d.prop === "visibility") {
          visibility = d.value;
          visibilityImp = d.important;
        }
        if (LAYOUT_PROPS.includes(d.prop) || d.prop.startsWith("--")) {
          captured[d.prop] = { value: d.value, important: d.important };
        }
      }
      const hasHide = display != null || visibility != null;
      const hasLayout = Object.keys(captured).length > 0;
      if (!hasHide && !hasLayout) continue;
      for (const sel of splitTopLevel(r.selectorText, ",")) {
        const trimmed = sel.trim();
        if (!trimmed) continue;
        const spec = specificityOf(trimmed);
        const term = terminalKey(trimmed);
        const source = serial++;
        if (hasHide) hide.push({ selectorText: trimmed, term, spec, source, layer: r.layer, display, displayImp, visibility, visibilityImp });
        if (hasLayout) layout.push({ selectorText: trimmed, term, spec, source, layer: r.layer, captured });
      }
    }
    return { hide, layout, count: serial, layers: flat.layers };
  }
  __name(parseSheet, "parseSheet");
  function parseSheetCached(cssText, vp) {
    const key = __sheetCacheKey(cssText, vp);
    let hit = __sheetCache.get(key);
    if (hit) return hit;
    const getFn = globalThis.__csimSheetCacheGet;
    if (getFn) {
      const cached = getFn(key);
      if (cached) {
        try {
          hit = JSON.parse(cached);
        } catch (_) {
          hit = null;
        }
      }
    }
    if (!hit) {
      hit = parseSheet(cssText, vp);
      const putFn = globalThis.__csimSheetCachePut;
      if (putFn) {
        try {
          putFn(key, JSON.stringify(hit));
        } catch (_) {
        }
      }
    }
    while (__sheetCache.size >= SHEET_CACHE_LIMIT) {
      __sheetCache.delete(__sheetCache.keys().next().value);
    }
    __sheetCache.set(key, hit);
    return hit;
  }
  __name(parseSheetCached, "parseSheetCached");
  function collectCascadeRules(doc) {
    const empty = { hide: [], layout: [] };
    if (!doc || !doc.documentElement) return empty;
    state.ruleSerial = 0;
    const vp = currentViewport();
    const hide = [];
    const layout = [];
    const sheets = [];
    for (const s of doc.documentElement.querySelectorAll("style")) {
      const media = s._attrs.media;
      if (media && !mediaMatches(media, vp)) continue;
      const txt = scriptText(s);
      if (txt) sheets.push(parseSheetCached(txt, vp));
    }
    for (const l of doc.documentElement.querySelectorAll("link")) {
      const rel = (l._attrs.rel || "").toLowerCase();
      if (!rel.split(/\s+/).includes("stylesheet")) continue;
      const href = l._attrs.href;
      if (!href) continue;
      const media = l._attrs.media;
      if (media && !mediaMatches(media, vp)) continue;
      try {
        const body = globalThis.__csimExternalAsset(href);
        if (body) sheets.push(parseSheetCached(body, vp));
      } catch (_) {
      }
    }
    const ordered = [];
    const seen = /* @__PURE__ */ new Set();
    for (const sh of sheets) for (const nm of sh.layers || []) if (!seen.has(nm)) {
      seen.add(nm);
      ordered.push(nm);
    }
    const layerRank = buildLayerRanks(ordered);
    const rankOf = /* @__PURE__ */ __name((r) => r.layer != null ? layerRank.get(r.layer) : null, "rankOf");
    for (const sh of sheets) {
      const base = state.ruleSerial;
      for (const r of sh.hide) hide.push({ ...r, source: r.source + base, layerRank: rankOf(r) });
      for (const r of sh.layout) layout.push({ ...r, source: r.source + base, layerRank: rankOf(r) });
      state.ruleSerial += sh.count;
    }
    return { hide, layout };
  }
  __name(collectCascadeRules, "collectCascadeRules");
  function buildLayerRanks(orderedNames) {
    const root = { children: /* @__PURE__ */ new Map(), order: [] };
    for (const name of orderedNames) {
      let node = root;
      for (const seg of name.split(".")) {
        let child = node.children.get(seg);
        if (!child) {
          child = { children: /* @__PURE__ */ new Map(), order: [] };
          node.children.set(seg, child);
          node.order.push(seg);
        }
        node = child;
      }
    }
    const ranks = /* @__PURE__ */ new Map();
    const path = [];
    let next = 0;
    const visit = /* @__PURE__ */ __name((node) => {
      for (const seg of node.order) {
        path.push(seg);
        visit(node.children.get(seg));
        path.pop();
      }
      if (path.length) ranks.set(path.join("."), next++);
    }, "visit");
    visit(root);
    return ranks;
  }
  __name(buildLayerRanks, "buildLayerRanks");
  function buildRuleIndex(rules) {
    const idx = {
      byTag: /* @__PURE__ */ new Map(),
      byId: /* @__PURE__ */ new Map(),
      byClass: /* @__PURE__ */ new Map(),
      universal: []
    };
    for (const r of rules) {
      const term = r.term;
      let bucket;
      if (term.kind === "class") {
        bucket = idx.byClass.get(term.key);
        if (!bucket) idx.byClass.set(term.key, bucket = []);
      } else if (term.kind === "id") {
        bucket = idx.byId.get(term.key);
        if (!bucket) idx.byId.set(term.key, bucket = []);
      } else if (term.kind === "tag") {
        bucket = idx.byTag.get(term.key);
        if (!bucket) idx.byTag.set(term.key, bucket = []);
      } else {
        bucket = idx.universal;
      }
      bucket.push(r);
    }
    return idx;
  }
  __name(buildRuleIndex, "buildRuleIndex");
  function forEachCandidateRule(idx, el, cb) {
    const tagBucket = idx.byTag.get(el._tag);
    if (tagBucket) for (const r of tagBucket) cb(r);
    const idAttr = el._attrs.id;
    if (idAttr) {
      const idBucket = idx.byId.get(idAttr);
      if (idBucket) for (const r of idBucket) cb(r);
    }
    for (const c of classes(el)) {
      const cb2 = idx.byClass.get(c);
      if (cb2) for (const r of cb2) cb(r);
    }
    if (idx.universal.length) for (const r of idx.universal) cb(r);
  }
  __name(forEachCandidateRule, "forEachCandidateRule");
  var LAYOUT_PROPS = [...CAPTURED_PROPS, "text-transform", "white-space"];
  var IMPORTANT_RE = /\s*!\s*important\s*$/i;
  function splitImportant(value) {
    if (typeof value !== "string" || value.indexOf("!") < 0) return { value, important: false };
    return IMPORTANT_RE.test(value) ? { value: value.replace(IMPORTANT_RE, "").trim(), important: true } : { value, important: false };
  }
  __name(splitImportant, "splitImportant");
  function parseInlineLayout(el) {
    const out = {};
    const s = el._attrs && el._attrs.style;
    if (!s) return out;
    for (const part of String(s).split(";")) {
      const m = /^\s*(top|left|width|height)\s*:\s*([^;]+?)\s*$/.exec(part);
      if (m) {
        const d = splitImportant(m[2]);
        out[m[1]] = { value: d.value, important: d.important };
      }
    }
    return out;
  }
  __name(parseInlineLayout, "parseInlineLayout");
  function parsePx2(v) {
    if (v == null) return null;
    const m = /^(-?\d+(?:\.\d+)?)px$/.exec(String(v).trim());
    return m ? parseFloat(m[1]) : /^(-?\d+(?:\.\d+)?)$/.test(v) ? parseFloat(v) : null;
  }
  __name(parsePx2, "parsePx");
  function resolveLayoutProp(el, prop) {
    const inline = parseInlineLayout(el)[prop];
    let best = inline ? { spec: [0, 0, 0], source: Infinity, inline: true, ...inline } : null;
    if (state.layoutRules.length) {
      if (!state.layoutIdx) state.layoutIdx = buildRuleIndex(state.layoutRules);
      forEachCandidateRule(state.layoutIdx, el, (r) => {
        const cap = r.captured[prop];
        if (!cap) return;
        if (!safeMatches(el, r.selectorText)) return;
        if (winsProp(best, r.spec, r.source, cap.important, r.layerRank)) {
          best = { value: cap.value, important: cap.important, spec: r.spec, source: r.source, layerRank: r.layerRank };
        }
      });
    }
    return best ? parsePx2(best.value) : null;
  }
  __name(resolveLayoutProp, "resolveLayoutProp");
  function winsProp(current, candSpec, candSource, candImp, candLayerRank) {
    if (!current) return true;
    if (candImp && !current.important) return true;
    if (!candImp && current.important) return false;
    if (current.inline) return false;
    const candLP = layerPriority(candLayerRank, candImp);
    const curLP = layerPriority(current.layerRank, current.important);
    if (candLP !== curLP) return candLP > curLP;
    if (compareSpec(candSpec, current.spec) !== 0) return compareSpec(candSpec, current.spec) > 0;
    return candSource >= current.source;
  }
  __name(winsProp, "winsProp");
  function matchesAnyHideRule(el, ignoreVisibility = false, inline = null, hidden = false) {
    if (state.hideRules.length === 0 && !inline) return hidden;
    let bestD = null, bestV = null;
    if (inline) {
      if (inline.display != null) {
        bestD = { value: inline.display, important: inline.displayImp, spec: inline.spec, source: inline.source, inline: true };
      }
      if (!ignoreVisibility && inline.visibility != null) {
        bestV = { value: inline.visibility, important: inline.visibilityImp, spec: inline.spec, source: inline.source, inline: true };
      }
    }
    if (state.hideRules.length) {
      if (!state.hideIdx) state.hideIdx = buildRuleIndex(state.hideRules);
      forEachCandidateRule(state.hideIdx, el, (r) => {
        if (!safeMatches(el, r.selectorText)) return;
        if (r.display != null && winsCascade(bestD, r, true)) {
          bestD = { value: r.display, important: r.displayImp, spec: r.spec, source: r.source, layerRank: r.layerRank };
        }
        if (!ignoreVisibility && r.visibility != null && winsCascade(bestV, r, false)) {
          bestV = { value: r.visibility, important: r.visibilityImp, spec: r.spec, source: r.source, layerRank: r.layerRank };
        }
      });
    }
    if (bestD && bestD.value === "none") return true;
    if (hidden && bestD == null) return true;
    if (bestV && (bestV.value === "hidden" || bestV.value === "collapse")) return true;
    return false;
  }
  __name(matchesAnyHideRule, "matchesAnyHideRule");
  function ownVisibility(el) {
    const inline = inlineHideDecl(el);
    let best = inline && inline.visibility != null ? { value: inline.visibility, important: inline.visibilityImp, spec: inline.spec, source: inline.source, inline: true } : null;
    if (state.hasVisibilityRule && state.hideRules.length) {
      if (!state.hideIdx) state.hideIdx = buildRuleIndex(state.hideRules);
      forEachCandidateRule(state.hideIdx, el, (r) => {
        if (r.visibility == null) return;
        if (!safeMatches(el, r.selectorText)) return;
        if (winsCascade(best, r, false)) {
          best = { value: r.visibility, important: r.visibilityImp, spec: r.spec, source: r.source, layerRank: r.layerRank };
        }
      });
    }
    return best ? best.value : null;
  }
  __name(ownVisibility, "ownVisibility");
  function visibilityHidden(el) {
    let cur = el;
    while (cur && cur.nodeType === NODE_ELEMENT) {
      const v = ownVisibility(cur);
      if (v != null) return v === "hidden" || v === "collapse";
      cur = cur._parent;
    }
    return false;
  }
  __name(visibilityHidden, "visibilityHidden");
  function winsCascade(current, candidate, isDisplay) {
    const candImp = isDisplay ? candidate.displayImp : candidate.visibilityImp;
    if (!current) return true;
    if (candImp && !current.important) return true;
    if (!candImp && current.important) return false;
    const candInline = !!candidate.inline;
    const curInline = !!current.inline;
    if (candInline && !curInline) return true;
    if (!candInline && curInline) return false;
    const candLP = layerPriority(candidate.layerRank, candImp);
    const curLP = layerPriority(current.layerRank, current.important);
    if (candLP !== curLP) return candLP > curLP;
    const cmp = compareSpec(candidate.spec, current.spec);
    if (cmp !== 0) return cmp > 0;
    return candidate.source >= current.source;
  }
  __name(winsCascade, "winsCascade");
  function layerPriority(rank, important) {
    if (rank == null) return important ? -Infinity : Infinity;
    return important ? -rank : rank;
  }
  __name(layerPriority, "layerPriority");
  var INLINE_WS_RE = /[\t\n\v\f\r]+/g;
  var BLOCK_TAGS = /* @__PURE__ */ new Set([
    "address",
    "article",
    "aside",
    "blockquote",
    "dd",
    "div",
    "dl",
    "dt",
    "figcaption",
    "figure",
    "footer",
    "form",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "header",
    "hr",
    "li",
    "main",
    "nav",
    "ol",
    "p",
    "pre",
    "section",
    "table",
    "tbody",
    "tfoot",
    "thead",
    "tr",
    "ul"
  ]);
  var TABLE_CELL_TAGS = /* @__PURE__ */ new Set(["td", "th"]);
  function hasNextCellSibling(node) {
    const siblings = node._parent && node._parent._children;
    if (!siblings) return false;
    const i = siblings.indexOf(node);
    for (let j = i + 1; j < siblings.length; j++) {
      const s = siblings[j];
      if (s.nodeType === NODE_ELEMENT && TABLE_CELL_TAGS.has(s._tag)) return true;
    }
    return false;
  }
  __name(hasNextCellSibling, "hasNextCellSibling");
  var FLEX_LIKE_DISPLAY = /* @__PURE__ */ new Set(["flex", "grid", "inline-flex", "inline-grid"]);
  var INLINE_DISPLAY_RE = /(?:^|;)\s*display\s*:\s*([^;!]+?)\s*(?:!important)?\s*(?:;|$)/i;
  function isFlexLikeContainer(el) {
    const style = el._attrs && el._attrs.style;
    if (style) {
      const m = INLINE_DISPLAY_RE.exec(style);
      if (m) {
        const v = m[1].trim().toLowerCase();
        return FLEX_LIKE_DISPLAY.has(v);
      }
    }
    for (const tok of classes(el)) {
      if (FLEX_LIKE_DISPLAY.has(tok)) return true;
    }
    return resolvedDisplayIsFlexLike(el);
  }
  __name(isFlexLikeContainer, "isFlexLikeContainer");
  function resolvedDisplayIsFlexLike(el) {
    const d = resolveCascadeDisplay(el);
    return d ? FLEX_LIKE_DISPLAY.has(d) : false;
  }
  __name(resolvedDisplayIsFlexLike, "resolvedDisplayIsFlexLike");
  function resolveCascadeDisplay(el) {
    if (state.hideRules.length === 0) return null;
    if (!state.hideIdx) state.hideIdx = buildRuleIndex(state.hideRules);
    let best = null;
    forEachCandidateRule(state.hideIdx, el, (r) => {
      if (r.display == null) return;
      if (!safeMatches(el, r.selectorText)) return;
      if (winsCascade(best, r, true)) {
        best = { value: r.display, important: r.displayImp, spec: r.spec, source: r.source, layerRank: r.layerRank };
      }
    });
    return best ? String(best.value).trim().toLowerCase() : null;
  }
  __name(resolveCascadeDisplay, "resolveCascadeDisplay");
  function cascadedProperty(el, prop) {
    const style = el._attrs && el._attrs.style;
    const inline = style ? parseInlinePropertyValue(style, prop) : null;
    let best = inline ? { value: inline.value, important: inline.important, spec: [0, 0, 0], source: Infinity, inline: true } : null;
    const rules = state.layoutRules;
    if (rules.length && rulesIndexHas(prop)) {
      if (!state.layoutIdx) state.layoutIdx = buildRuleIndex(rules);
      forEachCandidateRule(state.layoutIdx, el, (r) => {
        const cap = r.captured[prop];
        if (!cap) return;
        if (!safeMatches(el, r.selectorText)) return;
        if (winsProp(best, r.spec, r.source, cap.important, r.layerRank)) {
          best = { value: cap.value, important: cap.important, spec: r.spec, source: r.source, layerRank: r.layerRank };
        }
      });
    }
    return best ? best.value : null;
  }
  __name(cascadedProperty, "cascadedProperty");
  function parseInlinePropertyValue(style, prop) {
    const re = new RegExp("(?:^|;)\\s*" + prop + "\\s*:\\s*([^;!]+?)\\s*(!\\s*important)?\\s*(?:;|$)", "i");
    const m = re.exec(String(style));
    if (!m) return null;
    const lower = prop === "display" || prop === "visibility" || prop === "text-transform" || prop === "white-space";
    return { value: lower ? m[1].toLowerCase() : m[1], important: m[2] != null };
  }
  __name(parseInlinePropertyValue, "parseInlinePropertyValue");
  function rulesIndexHas(prop) {
    let cache = state.propCache;
    if (!cache) cache = state.propCache = /* @__PURE__ */ Object.create(null);
    if (prop in cache) return cache[prop];
    let found = false;
    for (const r of state.layoutRules) {
      if (r.captured && r.captured[prop]) {
        found = true;
        break;
      }
    }
    return cache[prop] = found;
  }
  __name(rulesIndexHas, "rulesIndexHas");
  function cascadedTextTransform(el) {
    return cascadedProperty(el, "text-transform");
  }
  __name(cascadedTextTransform, "cascadedTextTransform");
  function resolveTextTransform(el) {
    for (let cur = el; cur && cur.nodeType === NODE_ELEMENT; cur = cur._parent) {
      const v = cascadedTextTransform(cur);
      if (v && v !== "inherit") return v;
    }
    return "none";
  }
  __name(resolveTextTransform, "resolveTextTransform");
  function applyTextTransform(text, mode) {
    if (!text || mode === "none" || mode === "initial" || mode === "unset" || !mode) return text;
    if (mode === "uppercase") return text.toUpperCase();
    if (mode === "lowercase") return text.toLowerCase();
    if (mode === "capitalize") {
      return text.replace(/(^|\s)(\S)/g, (_, ws, ch) => ws + ch.toUpperCase());
    }
    return text;
  }
  __name(applyTextTransform, "applyTextTransform");
  var WS_PRESERVING_VALUES = /* @__PURE__ */ new Set(["pre", "pre-wrap", "pre-line", "break-spaces"]);
  function elementPreservesWhitespace(node) {
    if (node._tag === "pre") return true;
    const v = cascadedProperty(node, "white-space");
    return v != null && WS_PRESERVING_VALUES.has(v);
  }
  __name(elementPreservesWhitespace, "elementPreservesWhitespace");
  function collectVisibleText(node, transform, preserveWs) {
    if (node.nodeType === NODE_TEXT) {
      const data = String(node.data || "");
      if (preserveWs === void 0) {
        for (let cur = node._parent; cur; cur = cur._parent) {
          if (cur.nodeType !== NODE_ELEMENT) continue;
          if (elementPreservesWhitespace(cur)) {
            preserveWs = true;
            break;
          }
        }
      }
      let raw = preserveWs ? data : data.replace(INLINE_WS_RE, " ");
      if (preserveWs && raw.length) {
        raw = raw.replace(/ +(?=\n)|(?<=\n) +/g, (m) => "\xA0".repeat(m.length));
        if (raw.endsWith(" ")) {
          const next = node.nextSibling;
          if (next && next.nodeType === NODE_ELEMENT && next._tag === "br") {
            raw = raw.replace(/ +$/, (m) => "\xA0".repeat(m.length));
          }
        }
      }
      return applyTextTransform(raw, transform || "none");
    }
    if (node.nodeType !== NODE_ELEMENT && node.nodeType !== NODE_DOC && node.nodeType !== NODE_FRAGMENT) return "";
    if (node.nodeType === NODE_ELEMENT) {
      if (INVISIBLE_TAGS.has(node._tag)) return "";
      if (node._tag === "input" && (node._attrs.type || "").toLowerCase() === "hidden") return "";
      if (selfHidden(node)) return "";
      if (node._tag === "br") return "\n";
      const ownTransform = cascadedTextTransform(node);
      const effTransform = ownTransform && ownTransform !== "inherit" ? ownTransform : transform || "none";
      if (!preserveWs && elementPreservesWhitespace(node)) preserveWs = true;
      if (node._tag === "details" && node._attrs.open == null) {
        let s = "";
        for (const c of node._children) {
          if (c.nodeType === NODE_ELEMENT && c._tag === "summary") s += collectVisibleText(c, effTransform, preserveWs);
        }
        return s;
      }
      transform = effTransform;
    }
    const flexContext = node.nodeType === NODE_ELEMENT && isFlexLikeContainer(node);
    let out = "";
    for (const c of node._children) {
      if (flexContext && c.nodeType === NODE_TEXT && !/\S/.test(String(c.data || ""))) continue;
      const part = collectVisibleText(c, transform, preserveWs);
      if (!part) continue;
      const isCellWithInnerBlock = c.nodeType === NODE_ELEMENT && TABLE_CELL_TAGS.has(c._tag) && part.indexOf("\n") !== -1;
      const isBlock = c.nodeType === NODE_ELEMENT && (BLOCK_TAGS.has(c._tag) || flexContext || isCellWithInnerBlock);
      if (isBlock && out && !out.endsWith("\n")) out += "\n";
      out += part;
      if (isBlock && !part.endsWith("\n")) out += "\n";
      if (c.nodeType === NODE_ELEMENT && TABLE_CELL_TAGS.has(c._tag) && hasNextCellSibling(c)) {
        out += "	";
      }
    }
    return out;
  }
  __name(collectVisibleText, "collectVisibleText");

  // lib/capybara/simulated/js/src/mutation-observer.js
  function touchesStylesheet(nodes) {
    for (let i = 0; i < nodes.length; i++) {
      const t = nodes[i] && nodes[i]._tag;
      if (t === "style" || t === "link") return true;
    }
    return false;
  }
  __name(touchesStylesheet, "touchesStylesheet");
  var MutationRecord = class {
    static {
      __name(this, "MutationRecord");
    }
  };
  globalThis.MutationRecord = MutationRecord;
  var RECORD_PROTO = MutationRecord.prototype;
  var observers = /* @__PURE__ */ new Set();
  var signalSlots = /* @__PURE__ */ new Set();
  var slotChangeFirer = null;
  var slotChildListHook = null;
  var slotAttrHook = null;
  function setSlotChangeFirer(fn) {
    slotChangeFirer = fn;
  }
  __name(setSlotChangeFirer, "setSlotChangeFirer");
  function setSlotMutationHooks(childList, attr) {
    slotChildListHook = childList;
    slotAttrHook = attr;
  }
  __name(setSlotMutationHooks, "setSlotMutationHooks");
  function signalSlotChange(slot) {
    signalSlots.add(slot);
    scheduleMutationDelivery();
  }
  __name(signalSlotChange, "signalSlotChange");
  function takeSignaledSlots() {
    if (!signalSlots.size) return null;
    const slots = [...signalSlots];
    signalSlots.clear();
    return slots;
  }
  __name(takeSignaledSlots, "takeSignaledSlots");
  function fireSignaledSlots(slots) {
    if (!slots || !slotChangeFirer) return;
    for (const slot of slots) slotChangeFirer(slot);
  }
  __name(fireSignaledSlots, "fireSignaledSlots");
  var settleGen = 0;
  function bumpSettleGen() {
    settleGen = settleGen + 1 | 0;
  }
  __name(bumpSettleGen, "bumpSettleGen");
  function currentSettleGen() {
    return settleGen;
  }
  __name(currentSettleGen, "currentSettleGen");
  globalThis.__settleGenGet = () => settleGen;
  var MutationObserver = class {
    static {
      __name(this, "MutationObserver");
    }
    constructor(callback) {
      this._cb = callback;
      this._observed = [];
      this._records = [];
    }
    observe(target, options) {
      if (!target) return;
      const raw = options || {};
      const opts = Object.assign({}, raw);
      if (("attributeOldValue" in raw || "attributeFilter" in raw) && !("attributes" in raw)) opts.attributes = true;
      if ("characterDataOldValue" in raw && !("characterData" in raw)) opts.characterData = true;
      if (!opts.childList && !opts.attributes && !opts.characterData) {
        throw new TypeError("Failed to execute 'observe' on 'MutationObserver': The options object must set at least one of 'attributes', 'characterData', or 'childList' to true.");
      }
      if (opts.attributeOldValue && !opts.attributes) {
        throw new TypeError("Failed to execute 'observe' on 'MutationObserver': The options object may only set 'attributeOldValue' to true when 'attributes' is true or not present.");
      }
      if (opts.attributeFilter && !opts.attributes) {
        throw new TypeError("Failed to execute 'observe' on 'MutationObserver': The options object may only set 'attributeFilter' when 'attributes' is true or not present.");
      }
      if (opts.characterDataOldValue && !opts.characterData) {
        throw new TypeError("Failed to execute 'observe' on 'MutationObserver': The options object may only set 'characterDataOldValue' to true when 'characterData' is true or not present.");
      }
      for (const entry of this._observed) {
        if (entry.target === target) {
          entry.options = opts;
          observers.add(this);
          return;
        }
      }
      this._observed.push({ target, options: opts });
      observers.add(this);
    }
    disconnect() {
      this._observed = [];
      this._records = [];
      observers.delete(this);
    }
    takeRecords() {
      const out = this._records;
      this._records = [];
      return out;
    }
  };
  function matchEntry(entry, rec) {
    const opts = entry.options;
    if (rec.type === "childList" && !opts.childList) return null;
    if (rec.type === "attributes" && !opts.attributes && !opts.attributeFilter) return null;
    if (rec.type === "characterData" && !opts.characterData) return null;
    if (rec.type === "attributes" && opts.attributeFilter && opts.attributeFilter.indexOf(rec.attributeName) === -1) return null;
    if (rec.target === entry.target) return entry;
    if (!opts.subtree) return null;
    for (let cur = rec.target; cur; cur = cur._parent) {
      if (cur === entry.target) return entry;
    }
    return null;
  }
  __name(matchEntry, "matchEntry");
  function queueRecord(rec) {
    if (observers.size === 0) return;
    let queued = false;
    for (const obs of observers) {
      for (const entry of obs._observed) {
        const matched = matchEntry(entry, rec);
        if (matched) {
          if (rec.oldValue == null || rec.type === "attributes" && matched.options.attributeOldValue || rec.type === "characterData" && matched.options.characterDataOldValue) {
            obs._records.push(rec);
          } else {
            obs._records.push({ __proto__: RECORD_PROTO, ...rec, oldValue: null });
          }
          queued = true;
          break;
        }
      }
    }
    if (queued) scheduleMutationDelivery();
  }
  __name(queueRecord, "queueRecord");
  function recordAttrMutation(target, key, oldValue, meta) {
    bumpSettleGen();
    if (slotAttrHook && (key === "slot" || key === "name")) slotAttrHook(target, key);
    if (observers.size === 0) return;
    const m = meta !== void 0 ? meta : target._attrNS && target._attrNS[key];
    queueRecord({
      __proto__: RECORD_PROTO,
      type: "attributes",
      target,
      attributeName: m ? m.localName : key,
      attributeNamespace: m ? m.ns : null,
      oldValue,
      addedNodes: [],
      removedNodes: [],
      previousSibling: null,
      nextSibling: null
    });
  }
  __name(recordAttrMutation, "recordAttrMutation");
  function recordChildList(target, added, removed, prevSibling, nextSibling) {
    bumpSettleGen();
    if (added.length && touchesStylesheet(added) || removed.length && touchesStylesheet(removed)) scheduleCascadeRefresh();
    if (slotChildListHook) slotChildListHook(target, added, removed);
    if (observers.size === 0) return;
    let previousSibling = prevSibling !== void 0 ? prevSibling : null;
    let next = nextSibling !== void 0 ? nextSibling : null;
    if (prevSibling === void 0 && nextSibling === void 0 && added.length && target && target._children) {
      const kids = target._children;
      const first = kids.indexOf(added[0]);
      const last = kids.indexOf(added[added.length - 1]);
      if (first !== -1) previousSibling = first > 0 ? kids[first - 1] : null;
      if (last !== -1) next = last + 1 < kids.length ? kids[last + 1] : null;
    }
    queueRecord({
      __proto__: RECORD_PROTO,
      type: "childList",
      target,
      addedNodes: added.slice(),
      removedNodes: removed.slice(),
      attributeName: null,
      attributeNamespace: null,
      oldValue: null,
      previousSibling,
      nextSibling: next
    });
  }
  __name(recordChildList, "recordChildList");
  function recordCharacterData(target, oldValue) {
    bumpSettleGen();
    if (target && target._parent && target._parent._tag === "style") scheduleCascadeRefresh();
    if (observers.size === 0) return;
    queueRecord({
      __proto__: RECORD_PROTO,
      type: "characterData",
      target,
      addedNodes: [],
      removedNodes: [],
      attributeName: null,
      attributeNamespace: null,
      oldValue,
      previousSibling: null,
      nextSibling: null
    });
  }
  __name(recordCharacterData, "recordCharacterData");
  var deliveringMutations = false;
  function deliverMutations() {
    if (deliveringMutations) return;
    deliveringMutations = true;
    try {
      const slotsToFire = takeSignaledSlots();
      const batch = [];
      for (const obs of observers) {
        if (!obs._records.length) continue;
        batch.push([obs, obs._records]);
        obs._records = [];
      }
      for (const [obs, mine] of batch) {
        try {
          obs._cb(mine, obs);
        } catch (e) {
          try {
            globalThis.__csimReportCallbackError(obs._cb, e);
          } catch (_) {
            logThrew("MO callback", e);
          }
        }
      }
      if (typeof globalThis.__recheckIntersectionObservers === "function") {
        globalThis.__recheckIntersectionObservers();
      }
      fireSignaledSlots(slotsToFire);
    } finally {
      deliveringMutations = false;
    }
  }
  __name(deliverMutations, "deliverMutations");
  function hasQueuedRecords() {
    for (const obs of observers) {
      if (obs._records.length) return true;
    }
    return false;
  }
  __name(hasQueuedRecords, "hasQueuedRecords");
  function hasObservers() {
    return observers.size > 0;
  }
  __name(hasObservers, "hasObservers");
  var deliveryPending = false;
  function scheduleMutationDelivery() {
    if (deliveryPending) return;
    deliveryPending = true;
    Promise.resolve().then(() => {
      deliveryPending = false;
      if (observers.size && hasQueuedRecords() || signalSlots.size) deliverMutations();
    });
  }
  __name(scheduleMutationDelivery, "scheduleMutationDelivery");
  globalThis.MutationObserver = MutationObserver;

  // lib/capybara/simulated/js/src/window-events.js
  globalThis.addEventListener = EventTarget.prototype.addEventListener;
  globalThis.removeEventListener = EventTarget.prototype.removeEventListener;
  globalThis.dispatchEvent = EventTarget.prototype.dispatchEvent;
  function fireWindowListeners(event, capture) {
    const list = globalThis._listeners && globalThis._listeners[event.type];
    const hasIdlHandler = !capture && typeof globalThis["on" + event.type] === "function";
    if ((!list || !list.length) && !hasIdlHandler) return false;
    event.currentTarget = globalThis;
    let fired = false;
    if (list) {
      for (const entry of list.slice()) {
        if (!!entry.capture !== !!capture) continue;
        if (entry.removed) continue;
        if (event._propagationStopped) return fired;
        if (entry.once) removeOnceListener(entry, globalThis._listeners[event.type]);
        event._inPassiveListener = !!entry.passive;
        try {
          if (entry.isObject) {
            const cb = entry.handler.handleEvent;
            if (typeof cb === "function") {
              cb.call(entry.handler, event);
              fired = true;
            }
          } else {
            entry.handler.call(globalThis, event);
            fired = true;
          }
        } catch (e) {
          logThrew("window listener", e);
        } finally {
          event._inPassiveListener = false;
        }
      }
    }
    if (!capture && !event._propagationStopped && fireWindowOnHandler(event)) fired = true;
    return fired;
  }
  __name(fireWindowListeners, "fireWindowListeners");
  globalThis.__csimWindowListenersFor = function(type) {
    const list = globalThis._listeners && globalThis._listeners[type];
    return list ? list.map((l) => ({ passive: !!l.passive, capture: !!l.capture })) : [];
  };

  // lib/capybara/simulated/js/src/form-helpers.js
  function closeDialog(dlg, returnValue) {
    if (!dlg || dlg._tag !== "dialog") return;
    dlg.returnValue = String(returnValue == null ? "" : returnValue);
    if (Object.prototype.hasOwnProperty.call(dlg._attrs, "open")) {
      const old = dlg._attrs.open;
      delete dlg._attrs.open;
      recordAttrMutation(dlg, "open", old == null ? null : old);
    }
    try {
      dispatchEvent(dlg, new Event("close", { bubbles: false, cancelable: false }));
    } catch (_) {
    }
  }
  __name(closeDialog, "closeDialog");
  var LABELABLE = /* @__PURE__ */ new Set(["button", "input", "meter", "output", "progress", "select", "textarea"]);
  function isLabelableControl(n) {
    if (!LABELABLE.has(n._tag)) return false;
    return !(n._tag === "input" && (n._attrs.type || "").toLowerCase() === "hidden");
  }
  __name(isLabelableControl, "isLabelableControl");
  function labeledControlFor(label) {
    const forId = label._attrs.for;
    if (forId) {
      const root = globalThis.document.documentElement;
      if (root) {
        const hit = selectFirst([root], "#" + forId);
        if (hit && isLabelableControl(hit)) return hit;
      }
    }
    const stack = [label];
    while (stack.length) {
      const cur = stack.shift();
      for (const c of cur._children) {
        if (c.nodeType !== NODE_ELEMENT) continue;
        if (isLabelableControl(c)) return c;
        if (LABELABLE.has(c._tag)) continue;
        stack.push(c);
      }
    }
    return null;
  }
  __name(labeledControlFor, "labeledControlFor");
  function isInteractiveForLabel(n) {
    const t = n._tag;
    if (t === "summary" || t === "details") return true;
    if ((t === "a" || t === "area") && n._attrs.href != null) return true;
    return false;
  }
  __name(isInteractiveForLabel, "isInteractiveForLabel");
  function enclosingLabelFor(n) {
    let cur = n._parent;
    while (cur && cur.nodeType === NODE_ELEMENT) {
      if (cur._tag === "label") return cur;
      if (LABELABLE.has(cur._tag)) return null;
      if (isInteractiveForLabel(cur)) return null;
      cur = cur._parent;
    }
    return null;
  }
  __name(enclosingLabelFor, "enclosingLabelFor");
  function contenteditableHost(n) {
    let cur = n;
    while (cur && cur.nodeType === NODE_ELEMENT) {
      const v = cur._attrs.contenteditable;
      if (v != null) {
        const lower = String(v).toLowerCase();
        if (lower === "" || lower === "true" || lower === "plaintext-only") return cur;
        if (lower === "false") return null;
      }
      cur = cur._parent;
    }
    return null;
  }
  __name(contenteditableHost, "contenteditableHost");
  function isContenteditable(n) {
    return contenteditableHost(n) != null;
  }
  __name(isContenteditable, "isContenteditable");
  function isSubmitButton(n) {
    if (n._tag === "button") {
      const t = (n._attrs.type || "submit").toLowerCase();
      return t === "submit";
    }
    if (n._tag === "input") {
      const t = (n._attrs.type || "").toLowerCase();
      return t === "submit" || t === "image";
    }
    return false;
  }
  __name(isSubmitButton, "isSubmitButton");
  function ancestorForm(n) {
    let cur = n._parent;
    while (cur && cur.nodeType === NODE_ELEMENT) {
      if (cur._tag === "form") return cur;
      cur = cur._parent;
    }
    return null;
  }
  __name(ancestorForm, "ancestorForm");
  function formForControl(n) {
    const formId = n._attrs.form;
    if (formId) {
      const root = globalThis.document.documentElement;
      if (root) {
        const forms = root.getElementsByTagName("form");
        for (const f of forms) if (f._attrs.id === formId) return f;
      }
    }
    return ancestorForm(n);
  }
  __name(formForControl, "formForControl");
  function toggleChecked(n) {
    if (n._attrs.checked != null) delete n._attrs.checked;
    else n._attrs.checked = "";
  }
  __name(toggleChecked, "toggleChecked");
  function checkedRadioInGroup(n) {
    const name = n._attrs.name;
    if (!name) return n._attrs.checked != null ? n : null;
    const root = ancestorForm(n) || globalThis.document.documentElement;
    const candidates = root && root.querySelectorAll ? root.querySelectorAll("input") : [];
    for (const o of candidates) {
      if ((o._attrs.type || "").toLowerCase() === "radio" && o._attrs.name === name && o._attrs.checked != null) return o;
    }
    return null;
  }
  __name(checkedRadioInGroup, "checkedRadioInGroup");
  function setRadio(n) {
    const name = n._attrs.name;
    if (name) {
      const root = ancestorForm(n) || globalThis.document.documentElement;
      const candidates = root && root.querySelectorAll ? root.querySelectorAll("input") : [];
      for (const o of candidates) {
        if ((o._attrs.type || "").toLowerCase() === "radio" && o._attrs.name === name) {
          delete o._attrs.checked;
        }
      }
    }
    n._attrs.checked = "";
  }
  __name(setRadio, "setRadio");

  // lib/capybara/simulated/js/src/custom-elements.js
  var registry = /* @__PURE__ */ new Map();
  var pendingWhenDefined = /* @__PURE__ */ new Map();
  var ceState = { pendingUpgrade: null };
  var customElements = {
    define(tag, ctor) {
      const t = String(tag).toLowerCase();
      if (registry.has(t)) return;
      registry.set(t, ctor);
      const waiters = pendingWhenDefined.get(t);
      if (waiters) {
        pendingWhenDefined.delete(t);
        for (const resolve of waiters) {
          try {
            resolve(ctor);
          } catch (_) {
          }
        }
      }
      const doc = globalThis.document;
      if (!doc || !doc.documentElement) return;
      const matches = doc.documentElement.querySelectorAll(t);
      for (const el of matches) {
        upgradeElement(el, ctor);
        if (isConnected(el)) fireCEHook(el, "connectedCallback");
      }
    },
    get(tag) {
      return registry.get(String(tag).toLowerCase()) || void 0;
    },
    // Spec: resolves with the constructor when the tag is defined.
    // Apps `await customElements.whenDefined(tag)` before reading
    // from elements that haven't upgraded yet.
    whenDefined(tag) {
      const t = String(tag).toLowerCase();
      const ctor = registry.get(t);
      if (ctor) return Promise.resolve(ctor);
      return new Promise((resolve) => {
        const list = pendingWhenDefined.get(t) || [];
        list.push(resolve);
        pendingWhenDefined.set(t, list);
      });
    },
    // Spec: walks the subtree of `node` and upgrades any element whose
    // tag has a registered constructor but hasn't been upgraded yet.
    // Lit / Stencil flows that build elements off-document and then
    // call `customElements.upgrade(fragment)` before attaching depend
    // on it.
    upgrade(root) {
      if (!root || typeof root._children === "undefined") return;
      const walk2 = /* @__PURE__ */ __name((node) => {
        if (node && node.nodeType === 1) {
          const ctor = registry.get(node._tag);
          if (ctor && Object.getPrototypeOf(node) !== ctor.prototype) {
            upgradeElement(node, ctor);
          }
        }
        if (node && node._children) for (const c of node._children) walk2(c);
      }, "walk");
      walk2(root);
    }
  };
  function getCustomElementCtor(tag) {
    return registry.get(tag);
  }
  __name(getCustomElementCtor, "getCustomElementCtor");
  function upgradeElement(el, ctor) {
    if (Object.getPrototypeOf(el) === ctor.prototype) return;
    ceState.pendingUpgrade = el;
    try {
      Reflect.construct(ctor, [], ctor);
    } catch (e) {
      logThrew("custom element constructor", e);
      try {
        Object.setPrototypeOf(el, ctor.prototype);
      } catch (_) {
      }
    } finally {
      ceState.pendingUpgrade = null;
    }
    const observed = ctor.observedAttributes;
    const fn = el.attributeChangedCallback;
    if (observed && observed.length && typeof fn === "function") {
      for (const name of observed) {
        if (Object.prototype.hasOwnProperty.call(el._attrs, name)) {
          try {
            fn.call(el, name, null, el._attrs[name], null);
          } catch (e) {
            logThrew("attributeChangedCallback (upgrade)", e);
          }
        }
      }
    }
  }
  __name(upgradeElement, "upgradeElement");
  function fireCEHook(el, hookName) {
    try {
      const fn = el[hookName];
      if (typeof fn === "function") fn.call(el);
    } catch (e) {
      logThrew("custom element " + hookName, e);
    }
  }
  __name(fireCEHook, "fireCEHook");
  function fireAttrChangedCallback(el, name, oldValue, newValue) {
    if (!el || el.nodeType !== NODE_ELEMENT) return;
    const fn = el.attributeChangedCallback;
    if (typeof fn !== "function") return;
    const ctor = el.constructor;
    const observed = ctor && ctor.observedAttributes;
    if (!observed || observed.indexOf(name) < 0) return;
    try {
      fn.call(el, name, oldValue, newValue, null);
    } catch (e) {
      logThrew("attributeChangedCallback", e);
    }
  }
  __name(fireAttrChangedCallback, "fireAttrChangedCallback");
  function askForReset(child) {
    if (!child || child.nodeType !== NODE_ELEMENT) return;
    const t = child._tag;
    if (t === "option") {
      if (child._attrs.selected == null) return;
    } else if (t === "optgroup") {
      let any = false;
      for (const o of child._children) {
        if (o.nodeType === NODE_ELEMENT && o._tag === "option" && o._attrs.selected != null) {
          any = true;
          break;
        }
      }
      if (!any) return;
    } else {
      return;
    }
    let p = child._parent;
    while (p && p.nodeType === NODE_ELEMENT && p._tag !== "select") p = p._parent;
    if (!p || p._tag !== "select") return;
    if (p._attrs.multiple != null) return;
    const opts = p.querySelectorAll("option");
    let last = null;
    for (const o of opts) if (o._attrs.selected != null) last = o;
    if (!last) return;
    for (const o of opts) if (o !== last) delete o._attrs.selected;
  }
  __name(askForReset, "askForReset");
  function ceUpgradeTree(subtree) {
    walk(subtree, (el) => {
      const ctor = registry.get(el._tag);
      if (!ctor) return;
      if (Object.getPrototypeOf(el) !== ctor.prototype) upgradeElement(el, ctor);
    });
  }
  __name(ceUpgradeTree, "ceUpgradeTree");
  function ceTryConnect(el) {
    const ctor = registry.get(el._tag);
    if (!ctor) return;
    if (Object.getPrototypeOf(el) !== ctor.prototype) upgradeElement(el, ctor);
    fireCEHook(el, "connectedCallback");
  }
  __name(ceTryConnect, "ceTryConnect");
  function fireCEDisconnect(subtree) {
    walk(subtree, (el) => {
      if (registry.has(el._tag)) fireCEHook(el, "disconnectedCallback");
    });
  }
  __name(fireCEDisconnect, "fireCEDisconnect");
  function fireCEMoveReactions(subtree) {
    walk(subtree, (el) => {
      if (!registry.has(el._tag)) return;
      if (typeof el.connectedMoveCallback === "function") {
        fireCEHook(el, "connectedMoveCallback");
      } else {
        fireCEHook(el, "disconnectedCallback");
        fireCEHook(el, "connectedCallback");
      }
    });
  }
  __name(fireCEMoveReactions, "fireCEMoveReactions");
  globalThis.customElements = customElements;

  // lib/capybara/simulated/js/src/style-proxy.js
  function makeStyleProxy(el) {
    const target = {};
    const handler = {
      get(_t, prop) {
        if (prop === "cssText") return serializeStyleDecls(parsedDecls(el));
        if (prop === "getPropertyValue") return (name) => readCssProp(el, String(name));
        if (prop === "getPropertyPriority") return (name) => readCssPriority(el, String(name));
        if (prop === "setProperty") return (n, v, priority) => writeCssProp(el, String(n), String(v), priority);
        if (prop === "removeProperty") return (name) => removeCssProp(el, String(name));
        if (prop === "length") return Object.keys(parsedDecls(el)).length;
        if (typeof prop !== "string") return void 0;
        return readCssProp(el, camelToKebab(prop));
      },
      set(_t, prop, value) {
        if (prop === "cssText") {
          el.setAttribute("style", String(value == null ? "" : value));
          return true;
        }
        if (typeof prop === "string") {
          writeCssProp(el, camelToKebab(prop), String(value));
        }
        return true;
      },
      has(_t, prop) {
        if (prop === "cssText" || prop === "getPropertyValue" || prop === "getPropertyPriority" || prop === "setProperty" || prop === "removeProperty" || prop === "length") return true;
        return readCssProp(el, camelToKebab(String(prop))) !== "";
      }
    };
    return new Proxy(target, handler);
  }
  __name(makeStyleProxy, "makeStyleProxy");
  function camelToKebab(name) {
    return name.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());
  }
  __name(camelToKebab, "camelToKebab");
  function parsedDecls(el) {
    const s = el._attrs.style || "";
    if (el._declKey !== s) {
      el._declCache = parseStyleDecls(s);
      el._declKey = s;
    }
    return el._declCache;
  }
  __name(parsedDecls, "parsedDecls");
  var IMPORTANT_SUFFIX_RE = /\s*!\s*important\s*$/i;
  function stripImportant(v) {
    if (typeof v !== "string" || v.indexOf("!") < 0) return v;
    return v.replace(IMPORTANT_SUFFIX_RE, "").trim();
  }
  __name(stripImportant, "stripImportant");
  function readCssProp(el, name) {
    const decls = parsedDecls(el);
    return decls[name] != null ? stripImportant(decls[name]) : "";
  }
  __name(readCssProp, "readCssProp");
  function readCssPriority(el, name) {
    const v = parsedDecls(el)[name];
    return v != null && splitImportant(v).important ? "important" : "";
  }
  __name(readCssPriority, "readCssPriority");
  function writeCssProp(el, name, value, priority) {
    const decls = parseStyleDecls(el._attrs.style || "");
    if (value === "" || value == null) {
      delete decls[name];
    } else {
      let v = String(value);
      if (/^\s*important\s*$/i.test(String(priority == null ? "" : priority))) {
        v = stripImportant(v) + " !important";
      } else if (priority != null && priority !== "") {
        return;
      }
      decls[name] = v;
    }
    el.setAttribute("style", serializeStyleDecls(decls));
  }
  __name(writeCssProp, "writeCssProp");
  function removeCssProp(el, name) {
    const v = readCssProp(el, name);
    const decls = parseStyleDecls(el._attrs.style || "");
    delete decls[name];
    el.setAttribute("style", serializeStyleDecls(decls));
    return v;
  }
  __name(removeCssProp, "removeCssProp");
  function serializeStyleDecls(decls) {
    return Object.entries(decls).map(([k, v]) => k + ": " + v + ";").join(" ");
  }
  __name(serializeStyleDecls, "serializeStyleDecls");
  function parseStyleDecls(css) {
    const out = {};
    let i = 0;
    const n = css.length;
    while (i < n) {
      while (i < n && (css[i] === ";" || /\s/.test(css[i]))) i++;
      if (i >= n) break;
      const nameStart = i;
      while (i < n && /[a-zA-Z-]/.test(css[i])) i++;
      if (i === nameStart) {
        i++;
        continue;
      }
      const name = css.slice(nameStart, i).toLowerCase();
      while (i < n && /\s/.test(css[i])) i++;
      if (css[i] !== ":") continue;
      i++;
      while (i < n && /\s/.test(css[i])) i++;
      let value = "";
      let parenDepth = 0;
      while (i < n) {
        const c = css[i];
        if (c === "(") parenDepth++;
        else if (c === ")") parenDepth--;
        else if (c === ";" && parenDepth === 0) {
          i++;
          break;
        } else if (parenDepth === 0 && /\s/.test(c)) {
          let j = i + 1;
          while (j < n && /\s/.test(css[j])) j++;
          const wStart = j;
          while (j < n && /[a-zA-Z-]/.test(css[j])) j++;
          if (j > wStart) {
            let k = j;
            while (k < n && /\s/.test(css[k])) k++;
            if (css[k] === ":") break;
          }
        }
        value += c;
        i++;
      }
      if (name) out[name] = value.trim();
    }
    return out;
  }
  __name(parseStyleDecls, "parseStyleDecls");
  var DEFAULT_DISPLAY = {
    a: "inline",
    abbr: "inline",
    b: "inline",
    bdi: "inline",
    bdo: "inline",
    br: "inline",
    cite: "inline",
    code: "inline",
    data: "inline",
    dfn: "inline",
    em: "inline",
    i: "inline",
    kbd: "inline",
    mark: "inline",
    q: "inline",
    rp: "inline",
    rt: "inline",
    ruby: "inline",
    s: "inline",
    samp: "inline",
    small: "inline",
    span: "inline",
    strong: "inline",
    sub: "inline",
    sup: "inline",
    time: "inline",
    u: "inline",
    var: "inline",
    wbr: "inline",
    label: "inline",
    input: "inline-block",
    img: "inline",
    button: "inline-block",
    select: "inline-block",
    textarea: "inline-block",
    table: "table",
    thead: "table-header-group",
    tbody: "table-row-group",
    tfoot: "table-footer-group",
    tr: "table-row",
    th: "table-cell",
    td: "table-cell",
    li: "list-item",
    summary: "list-item",
    template: "none",
    script: "none",
    style: "none",
    noscript: "none",
    head: "none",
    title: "none",
    meta: "none",
    link: "none",
    option: "block",
    optgroup: "block"
  };
  function computedDisplayFor(el) {
    const inlineStyle = el._attrs.style;
    if (inlineStyle) {
      const m = /(^|;|\s)display\s*:\s*([^;]+)/i.exec(inlineStyle);
      if (m) return stripImportant(m[2].trim());
    }
    if (matchesAnyHideRule(el, true, null, el._attrs.hidden != null)) return "none";
    return DEFAULT_DISPLAY[el._tag] || "block";
  }
  __name(computedDisplayFor, "computedDisplayFor");
  function computedVisibilityFor(el) {
    const inlineStyle = el._attrs.style;
    if (inlineStyle) {
      const m = /(^|;|\s)visibility\s*:\s*([^;]+)/i.exec(inlineStyle);
      if (m) return stripImportant(m[2].trim());
    }
    return "";
  }
  __name(computedVisibilityFor, "computedVisibilityFor");
  function resolveCssVars(el, value, depth) {
    if (typeof value !== "string" || value.indexOf("var(") < 0) return value;
    if (depth == null) depth = 0;
    if (depth > 16) return value;
    let out = "";
    let i = 0;
    while (i < value.length) {
      const start = value.indexOf("var(", i);
      if (start < 0) {
        out += value.slice(i);
        break;
      }
      out += value.slice(i, start);
      const inside = sliceBalanced(value, start + 4);
      if (!inside) {
        out += value.slice(start);
        break;
      }
      const commaIdx = topLevelComma(inside.body);
      const name = (commaIdx < 0 ? inside.body : inside.body.slice(0, commaIdx)).trim();
      const fallback = commaIdx < 0 ? "" : inside.body.slice(commaIdx + 1).trim();
      let resolved = null;
      for (let cur = el; cur && cur.nodeType === NODE_ELEMENT; cur = cur._parent) {
        const v = cascadedProperty(cur, name);
        if (v != null && v !== "") {
          resolved = v;
          break;
        }
      }
      out += resolveCssVars(el, resolved != null ? resolved : fallback, depth + 1);
      i = inside.end;
    }
    return out;
  }
  __name(resolveCssVars, "resolveCssVars");
  function sliceBalanced(s, i) {
    let depth = 1;
    const start = i;
    while (i < s.length) {
      const ch = s[i];
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) return { body: s.slice(start, i), end: i + 1 };
      }
      i++;
    }
    return null;
  }
  __name(sliceBalanced, "sliceBalanced");
  function topLevelComma(s) {
    let depth = 0;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      else if (ch === "," && depth === 0) return i;
    }
    return -1;
  }
  __name(topLevelComma, "topLevelComma");
  function normalizeColor(value) {
    if (typeof value !== "string") return value;
    const v = value.trim();
    let m = v.match(/^#([0-9a-fA-F]{8})$/);
    if (m) {
      const r = parseInt(m[1].slice(0, 2), 16);
      const g = parseInt(m[1].slice(2, 4), 16);
      const b = parseInt(m[1].slice(4, 6), 16);
      const a = parseInt(m[1].slice(6, 8), 16) / 255;
      return `rgba(${r}, ${g}, ${b}, ${+a.toFixed(3)})`;
    }
    m = v.match(/^#([0-9a-fA-F]{6})$/);
    if (m) {
      const n = parseInt(m[1], 16);
      return `rgb(${n >> 16 & 255}, ${n >> 8 & 255}, ${n & 255})`;
    }
    m = v.match(/^#([0-9a-fA-F]{4})$/);
    if (m) {
      const c = m[1];
      const r = parseInt(c[0] + c[0], 16);
      const g = parseInt(c[1] + c[1], 16);
      const b = parseInt(c[2] + c[2], 16);
      const a = parseInt(c[3] + c[3], 16) / 255;
      return `rgba(${r}, ${g}, ${b}, ${+a.toFixed(3)})`;
    }
    m = v.match(/^#([0-9a-fA-F]{3})$/);
    if (m) {
      const c = m[1];
      const r = parseInt(c[0] + c[0], 16);
      const g = parseInt(c[1] + c[1], 16);
      const b = parseInt(c[2] + c[2], 16);
      return `rgb(${r}, ${g}, ${b})`;
    }
    const named = NAMED_COLORS[v.toLowerCase()];
    if (named) return named;
    return v;
  }
  __name(normalizeColor, "normalizeColor");
  var NAMED_COLORS = {
    transparent: "rgba(0, 0, 0, 0)",
    black: "rgb(0, 0, 0)",
    white: "rgb(255, 255, 255)",
    red: "rgb(255, 0, 0)",
    green: "rgb(0, 128, 0)",
    blue: "rgb(0, 0, 255)",
    yellow: "rgb(255, 255, 0)",
    cyan: "rgb(0, 255, 255)",
    magenta: "rgb(255, 0, 255)",
    gray: "rgb(128, 128, 128)",
    grey: "rgb(128, 128, 128)",
    silver: "rgb(192, 192, 192)",
    maroon: "rgb(128, 0, 0)",
    olive: "rgb(128, 128, 0)",
    lime: "rgb(0, 255, 0)",
    aqua: "rgb(0, 255, 255)",
    teal: "rgb(0, 128, 128)",
    navy: "rgb(0, 0, 128)",
    fuchsia: "rgb(255, 0, 255)",
    purple: "rgb(128, 0, 128)",
    orange: "rgb(255, 165, 0)"
  };
  var LAYOUT_COMPUTED_PROPS = /* @__PURE__ */ new Set([
    "width",
    "height",
    "top",
    "right",
    "bottom",
    "left",
    "inline-size",
    "block-size",
    "min-width",
    "min-height",
    "max-width",
    "max-height",
    "margin",
    "margin-top",
    "margin-right",
    "margin-bottom",
    "margin-left",
    "padding",
    "padding-top",
    "padding-right",
    "padding-bottom",
    "padding-left",
    "border-width",
    "border-top-width",
    "border-right-width",
    "border-bottom-width",
    "border-left-width"
  ]);
  var COMPUTED_INITIAL_VALUES = {
    "opacity": "1",
    "position": "static",
    "z-index": "auto",
    "float": "none",
    "clear": "none",
    "font-weight": "400",
    "font-style": "normal",
    "text-align": "start",
    "text-transform": "none",
    "text-decoration": "none",
    "white-space": "normal",
    "overflow": "visible",
    "overflow-x": "visible",
    "overflow-y": "visible",
    "box-sizing": "content-box",
    "cursor": "auto",
    "pointer-events": "auto",
    "vertical-align": "baseline",
    "letter-spacing": "normal",
    "word-spacing": "normal",
    "direction": "ltr",
    "text-indent": "0px",
    "border-collapse": "separate",
    "table-layout": "auto",
    "flex-direction": "row",
    "flex-wrap": "nowrap",
    "order": "0"
  };
  function readComputed(el, key) {
    if (key === "display") return { hit: true, value: computedDisplayFor(el) };
    if (key === "visibility") return { hit: true, value: computedVisibilityFor(el) };
    if (LAYOUT_COMPUTED_PROPS.has(key)) return { hit: false };
    const cascaded = cascadedProperty(el, key);
    if (cascaded != null && cascaded !== "") {
      const resolved = resolveCssVars(el, cascaded);
      const value = key === "color" || key.endsWith("-color") ? normalizeColor(resolved) : resolved;
      return { hit: true, value };
    }
    if (Object.prototype.hasOwnProperty.call(COMPUTED_INITIAL_VALUES, key)) {
      return { hit: true, value: COMPUTED_INITIAL_VALUES[key] };
    }
    return { hit: false };
  }
  __name(readComputed, "readComputed");
  function makeComputedStyleProxy(el) {
    return new Proxy(el.style, {
      get(target, key) {
        if (key === "getPropertyValue") {
          return function(name) {
            const r2 = readComputed(el, String(name).toLowerCase());
            if (r2.hit) return r2.value;
            return target.getPropertyValue ? target.getPropertyValue(name) : "";
          };
        }
        if (typeof key !== "string") return target[key];
        const r = readComputed(el, camelToKebab(key));
        return r.hit ? r.value : target[key];
      }
    });
  }
  __name(makeComputedStyleProxy, "makeComputedStyleProxy");
  globalThis.getComputedStyle = function(el) {
    if (!el || el.nodeType !== NODE_ELEMENT) return makeStyleProxy({ _attrs: {} });
    return el._computedStyleProxy || (el._computedStyleProxy = makeComputedStyleProxy(el));
  };
  globalThis.__csimComputedStyle = function(handle, names) {
    const el = handles.get(handle);
    if (!el || el.nodeType !== NODE_ELEMENT) return {};
    const proxy = globalThis.getComputedStyle(el);
    const out = {};
    for (const n of names) out[n] = String(proxy[n] || "");
    return out;
  };

  // lib/capybara/simulated/js/src/dom-collections.js
  var HTML_NS_HC = "http://www.w3.org/1999/xhtml";
  var INDEX_RE = /^(?:0|[1-9]\d*)$/;
  var HTMLCollection = class {
    static {
      __name(this, "HTMLCollection");
    }
  };
  Object.defineProperty(HTMLCollection.prototype, "item", {
    value: /* @__PURE__ */ __name(function(i) {
      i = i >>> 0;
      const v = this[i];
      return v === void 0 ? null : v;
    }, "value"),
    writable: true,
    enumerable: false,
    configurable: true
  });
  Object.defineProperty(HTMLCollection.prototype, "namedItem", {
    // Spec: first element whose `id` is `name` (any namespace), else the first
    // HTML-namespace element whose `name` is `name`.
    value: /* @__PURE__ */ __name(function(name) {
      if (name == null || name === "") return null;
      name = String(name);
      const len = this.length;
      for (let i = 0; i < len; i++) {
        const el = this[i];
        if (el && el._attrs && el._attrs.id === name) return el;
      }
      for (let i = 0; i < len; i++) {
        const el = this[i];
        if (el && el._ns === HTML_NS_HC && el._attrs && el._attrs.name === name) return el;
      }
      return null;
    }, "value"),
    writable: true,
    enumerable: false,
    configurable: true
  });
  Object.defineProperty(HTMLCollection.prototype, Symbol.iterator, {
    value: /* @__PURE__ */ __name(function() {
      const self = this;
      let i = 0;
      return {
        next: /* @__PURE__ */ __name(() => i < self.length ? { value: self[i++], done: false } : { value: void 0, done: true }, "next"),
        [Symbol.iterator]() {
          return this;
        }
      };
    }, "value"),
    writable: true,
    enumerable: false,
    configurable: true
  });
  Object.defineProperty(HTMLCollection.prototype, Symbol.toStringTag, { value: "HTMLCollection", configurable: true });
  var NodeList = class extends Array {
    static {
      __name(this, "NodeList");
    }
    // Spec `NodeList.item(i)` — `null` past the end (vs Array's `undefined`).
    item(i) {
      i = i >>> 0;
      return i < this.length ? this[i] : null;
    }
  };
  var staticNodeListLen = /* @__PURE__ */ new WeakMap();
  Object.defineProperty(NodeList.prototype, "length", {
    get() {
      const n = staticNodeListLen.get(this);
      return n === void 0 ? 0 : n;
    },
    configurable: true
  });
  var nnmState = /* @__PURE__ */ new WeakMap();
  var NamedNodeMap = class {
    static {
      __name(this, "NamedNodeMap");
    }
    get length() {
      const s = nnmState.get(this);
      return s ? s.live().length : 0;
    }
    item(i) {
      i = i >>> 0;
      const s = nnmState.get(this);
      const a = s && s.live();
      return a && i < a.length ? a[i] : null;
    }
    getNamedItem(name) {
      const s = nnmState.get(this);
      return s ? s.el.getAttributeNode(name) : null;
    }
    getNamedItemNS(ns, ln) {
      const s = nnmState.get(this);
      return s ? s.el.getAttributeNodeNS(ns, ln) : null;
    }
    setNamedItem(attr) {
      const s = nnmState.get(this);
      return s ? s.el.setAttributeNode(attr) : null;
    }
    setNamedItemNS(attr) {
      const s = nnmState.get(this);
      return s ? s.el.setAttributeNode(attr) : null;
    }
    removeNamedItem(name) {
      const s = nnmState.get(this);
      const removed = s && s.el.getAttributeNode(name);
      if (!removed) throw new globalThis.DOMException("No attribute named '" + name + "'.", "NotFoundError");
      return s.el.removeAttributeNode(removed);
    }
    removeNamedItemNS(ns, ln) {
      const s = nnmState.get(this);
      const removed = s && s.el.getAttributeNodeNS(ns, ln);
      if (!removed) throw new globalThis.DOMException("No matching attribute.", "NotFoundError");
      return s.el.removeAttributeNode(removed);
    }
    [Symbol.iterator]() {
      const s = nnmState.get(this), a = s ? s.live() : [];
      let i = 0;
      return {
        next: /* @__PURE__ */ __name(() => i < a.length ? { value: a[i++], done: false } : { value: void 0, done: true }, "next"),
        [Symbol.iterator]() {
          return this;
        }
      };
    }
  };
  Object.defineProperty(NamedNodeMap.prototype, Symbol.toStringTag, { value: "NamedNodeMap", configurable: true });
  function nnmNamedItem(arr, name) {
    for (const a of arr) if (a && a.name === name) return a;
    return null;
  }
  __name(nnmNamedItem, "nnmNamedItem");
  function liveNamedNodeMap(el, dropUppercase) {
    let cacheGen = NaN, cached = null;
    const live = /* @__PURE__ */ __name(() => {
      const g = currentSettleGen();
      if (g !== cacheGen) {
        cached = Object.keys(el._attrs).map((k) => el._attrNodeFor(k));
        cacheGen = g;
      }
      return cached;
    }, "live");
    const droppable = /* @__PURE__ */ __name((n) => dropUppercase && /[A-Z]/.test(n), "droppable");
    const supportedNames = /* @__PURE__ */ __name(() => {
      const out = [], seen = /* @__PURE__ */ new Set();
      for (const a of live()) {
        const n = a.name;
        if (seen.has(n) || droppable(n)) continue;
        seen.add(n);
        out.push(n);
      }
      return out;
    }, "supportedNames");
    const target = new NamedNodeMap();
    const isSupportedNamed = /* @__PURE__ */ __name((t, prop) => typeof prop === "string" && !Object.prototype.hasOwnProperty.call(t, prop) && !(prop in NamedNodeMap.prototype) && !droppable(prop) && !!nnmNamedItem(live(), prop), "isSupportedNamed");
    let proxy;
    proxy = new Proxy(target, {
      get(t, prop, recv) {
        if (prop === "length") {
          if (recv !== proxy) throw new TypeError("Illegal invocation");
          return live().length;
        }
        if (typeof prop === "string" && INDEX_RE.test(prop)) {
          const arr = live(), i = +prop;
          return i < arr.length ? arr[i] : void 0;
        }
        if (Object.prototype.hasOwnProperty.call(t, prop)) return t[prop];
        if (typeof prop === "string" && !(prop in NamedNodeMap.prototype) && !droppable(prop)) {
          const named = nnmNamedItem(live(), prop);
          if (named) return named;
        }
        return Reflect.get(t, prop, recv);
      },
      set(t, prop, val, recv) {
        if (recv !== proxy) return Reflect.set(t, prop, val, recv);
        if (typeof prop === "string" && INDEX_RE.test(prop)) return false;
        if (isSupportedNamed(t, prop)) return false;
        t[prop] = val;
        return true;
      },
      has(t, prop) {
        if (prop === "length") return true;
        if (typeof prop === "string" && INDEX_RE.test(prop)) return +prop < live().length;
        if (prop in t) return true;
        if (typeof prop === "string" && !(prop in NamedNodeMap.prototype) && !droppable(prop) && nnmNamedItem(live(), prop)) return true;
        return false;
      },
      getOwnPropertyDescriptor(t, prop) {
        if (prop === "length") return void 0;
        if (typeof prop === "string" && INDEX_RE.test(prop)) {
          const arr = live(), i = +prop;
          if (i < arr.length) return { value: arr[i], writable: false, enumerable: true, configurable: true };
          return void 0;
        }
        if (Object.prototype.hasOwnProperty.call(t, prop)) return Object.getOwnPropertyDescriptor(t, prop);
        if (typeof prop === "string" && !(prop in NamedNodeMap.prototype) && !droppable(prop)) {
          const named = nnmNamedItem(live(), prop);
          if (named) return { value: named, writable: false, enumerable: false, configurable: true };
        }
        return void 0;
      },
      ownKeys(t) {
        const arr = live(), keys = [];
        for (let i = 0; i < arr.length; i++) keys.push(String(i));
        for (const n of supportedNames()) if (!INDEX_RE.test(n) && !(n in NamedNodeMap.prototype)) keys.push(n);
        for (const k of Reflect.ownKeys(t)) if (keys.indexOf(k) === -1) keys.push(k);
        return keys;
      },
      defineProperty(t, prop, desc) {
        if (typeof prop === "string" && INDEX_RE.test(prop)) return false;
        if (isSupportedNamed(t, prop)) return false;
        return Reflect.defineProperty(t, prop, desc);
      },
      deleteProperty(t, prop) {
        if (typeof prop === "string" && INDEX_RE.test(prop)) return +prop >= live().length;
        if (isSupportedNamed(t, prop)) return false;
        return Reflect.deleteProperty(t, prop);
      }
    });
    nnmState.set(proxy, { el, live });
    return proxy;
  }
  __name(liveNamedNodeMap, "liveNamedNodeMap");
  globalThis.HTMLCollection = HTMLCollection;
  globalThis.NodeList = NodeList;
  globalThis.NamedNodeMap = NamedNodeMap;
  function htmlCollection(src) {
    const snap = Array.isArray(src) ? src : Array.from(src);
    return liveHTMLCollection(() => snap);
  }
  __name(htmlCollection, "htmlCollection");
  function hcNamedItem(arr, name) {
    if (name == null || name === "") return null;
    for (const el of arr) if (el && el._attrs && el._attrs.id === name) return el;
    for (const el of arr) if (el && el._ns === HTML_NS_HC && el._attrs && el._attrs.name === name) return el;
    return null;
  }
  __name(hcNamedItem, "hcNamedItem");
  function hcSupportedNames(arr) {
    const out = [], seen = /* @__PURE__ */ new Set();
    for (const el of arr) {
      if (!el || !el._attrs) continue;
      const id = el._attrs.id;
      if (id && !seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
      const nm = el._ns === HTML_NS_HC ? el._attrs.name : null;
      if (nm && !seen.has(nm)) {
        seen.add(nm);
        out.push(nm);
      }
    }
    return out;
  }
  __name(hcSupportedNames, "hcSupportedNames");
  function liveHTMLCollection(rawQuery) {
    let cacheGen = NaN, cached = null;
    const live = /* @__PURE__ */ __name(() => {
      const g = currentSettleGen();
      if (g !== cacheGen) {
        cached = rawQuery();
        cacheGen = g;
      }
      return cached;
    }, "live");
    const target = new HTMLCollection();
    const isSupportedNamed = /* @__PURE__ */ __name((t, prop) => typeof prop === "string" && !Object.prototype.hasOwnProperty.call(t, prop) && !(prop in HTMLCollection.prototype) && !!hcNamedItem(live(), prop), "isSupportedNamed");
    let proxy;
    proxy = new Proxy(target, {
      get(t, prop, recv) {
        if (prop === "length") {
          if (recv !== proxy) throw new TypeError("Illegal invocation");
          return live().length;
        }
        if (typeof prop === "string" && INDEX_RE.test(prop)) {
          const arr = live(), i = +prop;
          return i < arr.length ? arr[i] : void 0;
        }
        if (Object.prototype.hasOwnProperty.call(t, prop)) return t[prop];
        if (typeof prop === "string" && !(prop in HTMLCollection.prototype)) {
          const named = hcNamedItem(live(), prop);
          if (named) return named;
        }
        return Reflect.get(t, prop, recv);
      },
      set(t, prop, val, recv) {
        if (recv !== proxy) return Reflect.set(t, prop, val, recv);
        if (typeof prop === "string" && INDEX_RE.test(prop)) return false;
        if (isSupportedNamed(t, prop)) return false;
        t[prop] = val;
        return true;
      },
      has(t, prop) {
        if (prop === "length") return true;
        if (typeof prop === "string" && INDEX_RE.test(prop)) return +prop < live().length;
        if (prop in t) return true;
        if (typeof prop === "string" && !(prop in HTMLCollection.prototype) && hcNamedItem(live(), prop)) return true;
        return false;
      },
      getOwnPropertyDescriptor(t, prop) {
        if (prop === "length") return void 0;
        if (typeof prop === "string" && INDEX_RE.test(prop)) {
          const arr = live(), i = +prop;
          if (i < arr.length) return { value: arr[i], writable: false, enumerable: true, configurable: true };
          return void 0;
        }
        if (Object.prototype.hasOwnProperty.call(t, prop)) return Object.getOwnPropertyDescriptor(t, prop);
        if (typeof prop === "string" && !(prop in HTMLCollection.prototype)) {
          const named = hcNamedItem(live(), prop);
          if (named) return { value: named, writable: false, enumerable: false, configurable: true };
        }
        return void 0;
      },
      ownKeys(t) {
        const arr = live(), keys = [];
        for (let i = 0; i < arr.length; i++) keys.push(String(i));
        for (const n of hcSupportedNames(arr)) if (!INDEX_RE.test(n) && !(n in HTMLCollection.prototype)) keys.push(n);
        for (const k of Reflect.ownKeys(t)) if (keys.indexOf(k) === -1) keys.push(k);
        return keys;
      },
      defineProperty(t, prop, desc) {
        if (typeof prop === "string" && INDEX_RE.test(prop)) return false;
        if (isSupportedNamed(t, prop)) return false;
        return Reflect.defineProperty(t, prop, desc);
      },
      deleteProperty(t, prop) {
        if (typeof prop === "string" && INDEX_RE.test(prop)) {
          return +prop >= live().length;
        }
        if (isSupportedNamed(t, prop)) return false;
        return Reflect.deleteProperty(t, prop);
      }
    });
    return proxy;
  }
  __name(liveHTMLCollection, "liveHTMLCollection");
  function nodeList(arr) {
    const n = arr.length;
    const nl = Object.create(NodeList.prototype);
    for (let i = 0; i < n; i++) nl[i] = arr[i];
    staticNodeListLen.set(nl, n);
    return nl;
  }
  __name(nodeList, "nodeList");
  function newChildList(items) {
    const nl = new NodeList();
    if (items) for (const x of items) nl.push(x);
    return nl;
  }
  __name(newChildList, "newChildList");

  // lib/capybara/simulated/js/src/encodings.js
  var ENCODINGS = {
    "UTF-8": ["unicode-1-1-utf-8", "unicode11utf8", "unicode20utf8", "utf-8", "utf8", "x-unicode20utf8"],
    "IBM866": ["866", "cp866", "csibm866", "ibm866"],
    "ISO-8859-2": ["csisolatin2", "iso-8859-2", "iso-ir-101", "iso8859-2", "iso88592", "iso_8859-2", "iso_8859-2:1987", "l2", "latin2"],
    "ISO-8859-3": ["csisolatin3", "iso-8859-3", "iso-ir-109", "iso8859-3", "iso88593", "iso_8859-3", "iso_8859-3:1988", "l3", "latin3"],
    "ISO-8859-4": ["csisolatin4", "iso-8859-4", "iso-ir-110", "iso8859-4", "iso88594", "iso_8859-4", "iso_8859-4:1988", "l4", "latin4"],
    "ISO-8859-5": ["csisolatincyrillic", "cyrillic", "iso-8859-5", "iso-ir-144", "iso8859-5", "iso88595", "iso_8859-5", "iso_8859-5:1988"],
    "ISO-8859-6": ["arabic", "asmo-708", "csiso88596e", "csiso88596i", "csisolatinarabic", "ecma-114", "iso-8859-6", "iso-8859-6-e", "iso-8859-6-i", "iso-ir-127", "iso8859-6", "iso88596", "iso_8859-6", "iso_8859-6:1987"],
    "ISO-8859-7": ["csisolatingreek", "ecma-118", "elot_928", "greek", "greek8", "iso-8859-7", "iso-ir-126", "iso8859-7", "iso88597", "iso_8859-7", "iso_8859-7:1987", "sun_eu_greek"],
    "ISO-8859-8": ["csiso88598e", "csisolatinhebrew", "hebrew", "iso-8859-8", "iso-8859-8-e", "iso-ir-138", "iso8859-8", "iso88598", "iso_8859-8", "iso_8859-8:1988", "visual"],
    "ISO-8859-8-I": ["csiso88598i", "iso-8859-8-i", "logical"],
    "ISO-8859-10": ["csisolatin6", "iso-8859-10", "iso-ir-157", "iso8859-10", "iso885910", "l6", "latin6"],
    "ISO-8859-13": ["iso-8859-13", "iso8859-13", "iso885913"],
    "ISO-8859-14": ["iso-8859-14", "iso8859-14", "iso885914"],
    "ISO-8859-15": ["csisolatin9", "iso-8859-15", "iso8859-15", "iso885915", "iso_8859-15", "l9"],
    "ISO-8859-16": ["iso-8859-16"],
    "KOI8-R": ["cskoi8r", "koi", "koi8", "koi8-r", "koi8_r"],
    "KOI8-U": ["koi8-ru", "koi8-u"],
    "macintosh": ["csmacintosh", "mac", "macintosh", "x-mac-roman"],
    "windows-874": ["dos-874", "iso-8859-11", "iso8859-11", "iso885911", "tis-620", "windows-874"],
    "windows-1250": ["cp1250", "windows-1250", "x-cp1250"],
    "windows-1251": ["cp1251", "windows-1251", "x-cp1251"],
    "windows-1252": ["ansi_x3.4-1968", "ascii", "cp1252", "cp819", "csisolatin1", "ibm819", "iso-8859-1", "iso-ir-100", "iso8859-1", "iso88591", "iso_8859-1", "iso_8859-1:1987", "l1", "latin1", "us-ascii", "windows-1252", "x-cp1252"],
    "windows-1253": ["cp1253", "windows-1253", "x-cp1253"],
    "windows-1254": ["cp1254", "csisolatin5", "iso-8859-9", "iso-ir-148", "iso8859-9", "iso88599", "iso_8859-9", "iso_8859-9:1989", "l5", "latin5", "windows-1254", "x-cp1254"],
    "windows-1255": ["cp1255", "windows-1255", "x-cp1255"],
    "windows-1256": ["cp1256", "windows-1256", "x-cp1256"],
    "windows-1257": ["cp1257", "windows-1257", "x-cp1257"],
    "windows-1258": ["cp1258", "windows-1258", "x-cp1258"],
    "x-mac-cyrillic": ["x-mac-cyrillic", "x-mac-ukrainian"],
    "GBK": ["chinese", "csgb2312", "csiso58gb231280", "gb2312", "gb_2312", "gb_2312-80", "gbk", "iso-ir-58", "x-gbk"],
    "gb18030": ["gb18030"],
    "Big5": ["big5", "big5-hkscs", "cn-big5", "csbig5", "x-x-big5"],
    "EUC-JP": ["cseucpkdfmtjapanese", "euc-jp", "x-euc-jp"],
    "ISO-2022-JP": ["csiso2022jp", "iso-2022-jp"],
    "Shift_JIS": ["csshiftjis", "ms932", "ms_kanji", "shift-jis", "shift_jis", "sjis", "windows-31j", "x-sjis"],
    "EUC-KR": ["cseuckr", "csksc56011987", "euc-kr", "iso-ir-149", "korean", "ks_c_5601-1987", "ks_c_5601-1989", "ksc5601", "ksc_5601", "windows-949"],
    "replacement": ["csiso2022kr", "hz-gb-2312", "iso-2022-cn", "iso-2022-cn-ext", "iso-2022-kr", "replacement"],
    "UTF-16BE": ["unicodefffe", "utf-16be"],
    "UTF-16LE": ["csunicode", "iso-10646-ucs-2", "ucs-2", "unicode", "unicodefeff", "utf-16", "utf-16le"],
    "x-user-defined": ["x-user-defined"]
  };
  var LABEL_TO_NAME = /* @__PURE__ */ new Map();
  for (const name in ENCODINGS) for (const label of ENCODINGS[name]) LABEL_TO_NAME.set(label, name);
  function getEncoding(label, fromMeta) {
    const norm = String(label).replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "").replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
    const name = LABEL_TO_NAME.get(norm);
    if (!name) return null;
    if (fromMeta) {
      if (name === "UTF-16BE" || name === "UTF-16LE") return "UTF-8";
      if (name === "x-user-defined") return "windows-1252";
    }
    return name;
  }
  __name(getEncoding, "getEncoding");

  // lib/capybara/simulated/js/src/location.js
  var _u = (function() {
    try {
      const parsed = globalThis.__csim_parseUrl("http://www.example.com/", null);
      if (parsed && !parsed.error) return parsed;
    } catch (_) {
    }
    return {
      href: "http://www.example.com/",
      protocol: "http:",
      host: "www.example.com",
      hostname: "www.example.com",
      port: "",
      pathname: "/",
      search: "",
      hash: "",
      origin: "http://www.example.com"
    };
  })();
  function navTarget(resolved) {
    return globalThis.__locationAssign(resolved);
  }
  __name(navTarget, "navTarget");
  function composeWith(overrides) {
    const o = Object.assign({}, _u, overrides);
    const cred = o.username || o.password ? (o.username || "") + (o.password ? ":" + o.password : "") + "@" : "";
    return (o.protocol || "") + "//" + cred + (o.host || "") + (o.pathname || "") + (o.search || "") + (o.hash || "");
  }
  __name(composeWith, "composeWith");
  var _location = {
    toString() {
      return this.href;
    },
    assign: /* @__PURE__ */ __name((next) => {
      if (!tryFragmentNavigate(String(next))) globalThis.__locationAssign(next);
    }, "assign"),
    replace: /* @__PURE__ */ __name((next) => {
      if (!tryFragmentNavigate(String(next), true)) globalThis.__locationAssign(next);
    }, "replace"),
    reload: /* @__PURE__ */ __name(() => globalThis.__locationReload(), "reload")
  };
  Object.defineProperty(_location, "href", {
    configurable: true,
    get() {
      return _u.href;
    },
    set(v) {
      const next = String(v);
      if (tryFragmentNavigate(next)) return;
      navTarget(next);
    }
  });
  var partProps = {
    pathname: "/",
    hash: "#",
    search: "?"
  };
  for (const [key, prefix] of Object.entries(partProps)) {
    Object.defineProperty(_location, key, {
      configurable: true,
      get() {
        return _u[key];
      },
      set(v) {
        const s = String(v == null ? "" : v);
        const part = s.length > 0 && !s.startsWith(prefix) ? prefix + s : s;
        const next = composeWith({ [key]: part });
        if (key === "hash" && part === (_u.hash || "")) return;
        if (tryFragmentNavigate(next)) return;
        navTarget(next);
      }
    });
  }
  for (const key of ["protocol", "host", "hostname", "port", "origin", "username", "password"]) {
    Object.defineProperty(_location, key, {
      configurable: true,
      get() {
        return _u[key];
      }
    });
  }
  function setLocationFromUrl(url) {
    try {
      const parsed = globalThis.__csim_parseUrl(url, null);
      if (parsed && !parsed.error) {
        _u = parsed;
        return;
      }
    } catch (_) {
    }
    _u = Object.assign({}, _u, { href: url || "", pathname: "/", search: "", hash: "" });
  }
  __name(setLocationFromUrl, "setLocationFromUrl");
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    get() {
      return _location;
    },
    set(v) {
      globalThis.__locationAssign(String(v));
    }
  });
  function tryFragmentNavigate(destHref, replace = false) {
    let dest, cur;
    try {
      dest = new globalThis.URL(String(destHref), _u.href);
    } catch (_) {
      return false;
    }
    try {
      cur = new globalThis.URL(_u.href);
    } catch (_) {
      return false;
    }
    if (dest.origin !== cur.origin || dest.pathname !== cur.pathname || dest.search !== cur.search) {
      return false;
    }
    if (dest.hash === cur.hash) return false;
    const oldURL = cur.href, newURL = dest.href;
    setLocationFromUrl(newURL);
    bumpSettleGen();
    try {
      if (replace) {
        if (typeof globalThis.__setCurrentUrl === "function") globalThis.__setCurrentUrl(newURL, null);
      } else {
        if (typeof globalThis.__pushHistoryEntry === "function") globalThis.__pushHistoryEntry(newURL, null);
      }
    } catch (_) {
    }
    try {
      globalThis.dispatchEvent(new globalThis.HashChangeEvent("hashchange", { oldURL, newURL }));
    } catch (_) {
    }
    return true;
  }
  __name(tryFragmentNavigate, "tryFragmentNavigate");
  globalThis.__csimUpdateLocation = function(url) {
    let s = String(url || "");
    if (s && !/^[a-z][a-z0-9+.-]*:/i.test(s)) {
      try {
        const base = globalThis.location && globalThis.location.href || null;
        if (base && /^[a-z][a-z0-9+.-]*:/i.test(base)) s = new URL(s, base).href;
      } catch (_) {
      }
    }
    setLocationFromUrl(s);
    bumpSettleGen();
  };

  // lib/capybara/simulated/js/src/html-parser.js
  var VOID = /* @__PURE__ */ new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
  var RAWTEXT = /* @__PURE__ */ new Set(["script", "style", "noembed"]);
  var HEAD_CONTENT = /* @__PURE__ */ new Set([
    "base",
    "basefont",
    "bgsound",
    "link",
    "meta",
    "noscript",
    "noframes",
    "script",
    "style",
    "template",
    "title"
  ]);
  var SPECIAL = /* @__PURE__ */ new Set([
    "address",
    "applet",
    "area",
    "article",
    "aside",
    "base",
    "basefont",
    "bgsound",
    "blockquote",
    "body",
    "br",
    "button",
    "caption",
    "center",
    "col",
    "colgroup",
    "dd",
    "details",
    "dir",
    "div",
    "dl",
    "dt",
    "embed",
    "fieldset",
    "figcaption",
    "figure",
    "footer",
    "form",
    "frame",
    "frameset",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "head",
    "header",
    "hgroup",
    "hr",
    "html",
    "iframe",
    "img",
    "input",
    "keygen",
    "li",
    "link",
    "listing",
    "main",
    "marquee",
    "menu",
    "meta",
    "nav",
    "noembed",
    "noframes",
    "noscript",
    "object",
    "ol",
    "p",
    "param",
    "plaintext",
    "pre",
    "script",
    "section",
    "select",
    "source",
    "style",
    "summary",
    "table",
    "tbody",
    "td",
    "template",
    "textarea",
    "tfoot",
    "th",
    "thead",
    "title",
    "tr",
    "track",
    "ul",
    "wbr",
    "xmp"
  ]);
  var CLOSES_P = /* @__PURE__ */ new Set([
    "address",
    "article",
    "aside",
    "blockquote",
    "center",
    "details",
    "dialog",
    "dir",
    "div",
    "dl",
    "dd",
    "dt",
    "fieldset",
    "figcaption",
    "figure",
    "footer",
    "header",
    "hgroup",
    "hr",
    "listing",
    "main",
    "menu",
    "nav",
    "ol",
    "p",
    "plaintext",
    "pre",
    "section",
    "summary",
    "table",
    "ul",
    "xmp",
    "form",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "li"
  ]);
  var P_SCOPE_BOUNDARY = /* @__PURE__ */ new Set(["applet", "caption", "html", "table", "td", "th", "marquee", "object", "template", "button"]);
  var DOCTYPE_RE = /^\s*<!doctype\s+([^\s>]+)(?:\s+(?:public\s+("[^"]*"|'[^']*')(?:\s+("[^"]*"|'[^']*'))?|system\s+("[^"]*"|'[^']*')))?[^>]*>/i;
  function installHtmlParser({ Document: Document2, Element: Element2, Text: Text2, Comment: Comment2, DocumentFragment: DocumentFragment2, DocumentType: DocumentType2, createHtmlPageDocument: createHtmlPageDocument2, registerNamedAccess: registerNamedAccess2 }) {
    const unquote = /* @__PURE__ */ __name((s) => s == null ? "" : s.slice(1, -1), "unquote");
    const HTML_NS_P = "http://www.w3.org/1999/xhtml";
    const SVG_NS_P = "http://www.w3.org/2000/svg";
    const MATHML_NS_P = "http://www.w3.org/1998/Math/MathML";
    const XLINK_NS_P = "http://www.w3.org/1999/xlink";
    const XML_NS_P = "http://www.w3.org/XML/1998/namespace";
    const XMLNS_NS_P = "http://www.w3.org/2000/xmlns/";
    const normalizeNewlines = /* @__PURE__ */ __name((s) => typeof s === "string" && s.indexOf("\r") !== -1 ? s.replace(/\r\n?/g, "\n") : s, "normalizeNewlines");
    function parseDocument2(html) {
      html = normalizeNewlines(html);
      const doc = createHtmlPageDocument2(false);
      let hasDoctype = false;
      let prologEnd = 0;
      for (; ; ) {
        const rest = html.slice(prologEnd);
        let m;
        if (m = /^[\t\n\f\r ]+/.exec(rest)) {
          prologEnd += m[0].length;
          continue;
        }
        if (m = /^<!--([\s\S]*?)-->/.exec(rest)) {
          const node = new Comment2(m[1]);
          node._parent = doc;
          node._ownerDoc = doc;
          doc._children.push(node);
          prologEnd += m[0].length;
          continue;
        }
        if (DocumentType2 && (m = DOCTYPE_RE.exec(rest))) {
          const node = new DocumentType2(m[1], unquote(m[2]), unquote(m[3] || m[4]), doc);
          node._parent = doc;
          doc._children.push(node);
          hasDoctype = true;
          prologEnd += m[0].length;
          continue;
        }
        break;
      }
      if (prologEnd > 0) html = html.slice(prologEnd);
      doc._quirks = !hasDoctype;
      const root = new Element2("html");
      root._parent = doc;
      doc._children.push(root);
      const head = new Element2("head");
      const body = new Element2("body");
      head._parent = root;
      root._children.push(head);
      body._parent = root;
      root._children.push(body);
      const stripped = stripHtmlWrapper(html);
      if (stripped.htmlAttrs) applyAttributes(root, stripped.htmlAttrs);
      if (stripped.headAttrs) applyAttributes(head, stripped.headAttrs);
      if (stripped.bodyAttrs) applyAttributes(body, stripped.bodyAttrs);
      const nodes = parseFragment2(stripped.body);
      for (const n of nodes) {
        n._parent = body;
        body._children.push(n);
      }
      if (stripped.head) {
        const headNodes = parseFragment2(stripped.head);
        for (const n of headNodes) {
          n._parent = head;
          head._children.push(n);
        }
      }
      if (stripped.implicitHead) {
        const kids = body._children;
        let n = 0;
        while (n < kids.length) {
          const c = kids[n];
          if (c.nodeType === NODE_ELEMENT && HEAD_CONTENT.has(c._tag)) {
            n++;
            continue;
          }
          if (c.nodeType === NODE_COMMENT) {
            n++;
            continue;
          }
          if (c.nodeType === NODE_TEXT && /^[\t\n\f\r ]*$/.test(String(c.data || ""))) {
            n++;
            continue;
          }
          break;
        }
        if (n > 0) {
          const moved = kids.splice(0, n);
          for (const m of moved) {
            m._parent = head;
            head._children.push(m);
          }
        }
      }
      for (const table of body.querySelectorAll("table")) wrapLooseTrs(table);
      return doc;
    }
    __name(parseDocument2, "parseDocument");
    function wrapLooseTrs(table) {
      const kids = table._children;
      if (!kids) return;
      const isWs2 = /* @__PURE__ */ __name((k) => k.nodeType === NODE_TEXT && /^\s*$/.test(String(k.data || "")), "isWs");
      const isTr = /* @__PURE__ */ __name((k) => k.nodeType === NODE_ELEMENT && k._tag === "tr", "isTr");
      const isFiller = /* @__PURE__ */ __name((k) => isWs2(k) || k.nodeType === NODE_COMMENT, "isFiller");
      let i = 0;
      while (i < kids.length) {
        if (!isTr(kids[i])) {
          i++;
          continue;
        }
        const tbody = new Element2("tbody");
        tbody._parent = table;
        let j = i;
        while (j < kids.length) {
          const k = kids[j];
          if (isTr(k)) {
          } else if (isFiller(k)) {
            let p = j + 1;
            while (p < kids.length && isFiller(kids[p])) p++;
            if (p >= kids.length || !isTr(kids[p])) break;
          } else break;
          k._parent = tbody;
          tbody._children.push(k);
          j++;
        }
        kids.splice(i, j - i, tbody);
        i++;
      }
    }
    __name(wrapLooseTrs, "wrapLooseTrs");
    const RAWSPAN = "<!--[\\s\\S]*?-->|<script\\b[^>]*>[\\s\\S]*?<\\/script\\s*>|<style\\b[^>]*>[\\s\\S]*?<\\/style\\s*>";
    function findStructuralTag(html, want, from) {
      const re = new RegExp(RAWSPAN + "|<(" + want + ")\\b([^>]*)>", "gi");
      re.lastIndex = from || 0;
      for (let m; m = re.exec(html); ) {
        if (m[1] !== void 0) return { index: m.index, attrs: m[2] || "", end: re.lastIndex };
      }
      return null;
    }
    __name(findStructuralTag, "findStructuralTag");
    function stripStructural(s, tagAlt) {
      const re = new RegExp("(" + RAWSPAN + ")|<!doctype[^>]*>|<\\/?(?:" + tagAlt + ")\\b[^>]*>", "gi");
      return s.replace(re, (m, keep) => keep != null ? keep : "");
    }
    __name(stripStructural, "stripStructural");
    function stripHtmlWrapper(html) {
      const bodyTag = findStructuralTag(html, "body");
      if (bodyTag) {
        const pre = html.slice(0, bodyTag.index);
        const htmlOpen2 = findStructuralTag(pre, "html");
        const headOpen2 = findStructuralTag(pre, "head");
        const head = stripStructural(pre, "html|head");
        const close = findStructuralTag(html, "\\/body", bodyTag.end);
        const body = close ? html.slice(bodyTag.end, close.index) : html.slice(bodyTag.end);
        return {
          head,
          body,
          htmlAttrs: htmlOpen2 ? htmlOpen2.attrs : "",
          headAttrs: headOpen2 ? headOpen2.attrs : "",
          bodyAttrs: bodyTag.attrs,
          // <body> delimits the head explicitly — no implicit-head pass.
          implicitHead: false
        };
      }
      const htmlOpen = findStructuralTag(html, "html");
      const headOpen = findStructuralTag(html, "head");
      const headClose = headOpen ? findStructuralTag(html, "\\/head", headOpen.end) : null;
      const hasHead = !!(headOpen && headClose);
      const bodySrc = hasHead ? html.slice(0, headOpen.index) + html.slice(headClose.end) : html;
      return {
        head: hasHead ? html.slice(headOpen.end, headClose.index) : "",
        htmlAttrs: htmlOpen ? htmlOpen.attrs : "",
        headAttrs: hasHead ? headOpen.attrs : "",
        bodyAttrs: "",
        implicitHead: !hasHead,
        body: stripStructural(bodySrc, "html")
      };
    }
    __name(stripHtmlWrapper, "stripHtmlWrapper");
    function parseFragment2(html) {
      html = normalizeNewlines(html);
      const out = [];
      const stack = [];
      let target = out;
      const pushChild = /* @__PURE__ */ __name((child) => {
        const frame = stack.length ? stack[stack.length - 1] : null;
        child._parent = frame ? frame.parentForChildren : null;
        target.push(child);
      }, "pushChild");
      const re = /(<!--(?:>|->|[\s\S]*?-->))|(<[!?][^>]*>)|<(\/?)([a-zA-Z][\w<-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
      let m, last = 0;
      while ((m = re.exec(html)) !== null) {
        if (m.index > last) {
          const text = html.slice(last, m.index);
          if (text.length) pushChild(makeText(text));
        }
        if (m[1] !== void 0) {
          const data = m[1] === "<!-->" || m[1] === "<!--->" ? "" : m[1].slice(4, -3);
          pushChild(new Comment2(data));
          last = re.lastIndex;
          continue;
        }
        if (m[2] !== void 0) {
          if (/^<!doctype/i.test(m[2])) {
            last = re.lastIndex;
            continue;
          }
          const data = m[2].charAt(1) === "?" ? m[2].slice(1, -1) : m[2].slice(2, -1);
          pushChild(new Comment2(data));
          last = re.lastIndex;
          continue;
        }
        const closing = m[3] === "/";
        const tag = m[4].toLowerCase();
        const rest = m[5];
        last = re.lastIndex;
        if (closing) {
          for (let s = stack.length - 1; s >= 0; s--) {
            if (stack[s].el._tag === tag) {
              stack.length = s;
              target = stack.length ? stack[stack.length - 1].container : out;
              break;
            }
          }
          continue;
        }
        if (tag === "li" || tag === "dd" || tag === "dt") {
          const isItem = tag === "li" ? ((t) => t === "li") : ((t) => t === "dd" || t === "dt");
          for (let s = stack.length - 1; s >= 0; s--) {
            const t = stack[s].el._tag;
            if (isItem(t)) {
              stack.length = s;
              target = stack.length ? stack[stack.length - 1].container : out;
              break;
            }
            if (SPECIAL.has(t) && t !== "address" && t !== "div" && t !== "p") break;
          }
        }
        if (CLOSES_P.has(tag)) {
          for (let s = stack.length - 1; s >= 0; s--) {
            const t = stack[s].el._tag;
            if (t === "p") {
              stack.length = s;
              target = stack.length ? stack[stack.length - 1].container : out;
              break;
            }
            if (P_SCOPE_BOUNDARY.has(t)) break;
          }
        }
        const parentNS = stack.length ? stack[stack.length - 1].el._ns : HTML_NS_P;
        const elNS = tag === "svg" ? SVG_NS_P : tag === "math" ? MATHML_NS_P : parentNS === SVG_NS_P || parentNS === MATHML_NS_P ? parentNS : HTML_NS_P;
        if (elNS === HTML_NS_P && (tag === "html" || tag === "head" || tag === "body")) continue;
        const el = new Element2(tag);
        if (elNS !== HTML_NS_P) el._ns = elNS;
        applyAttributes(el, rest, elNS !== HTML_NS_P);
        if (tag === "script") el._csimRan = !stack.some((f) => f.el._tag === "template");
        pushChild(el);
        if (VOID.has(tag) || /\/\s*$/.test(rest)) continue;
        if (RAWTEXT.has(tag)) {
          const closeRe = new RegExp("</" + tag + "\\s*>", "i");
          const closeIdx = html.search.call(html.slice(last), closeRe);
          const absIdx = closeIdx < 0 ? html.length : last + closeIdx;
          const raw = html.slice(last, absIdx);
          if (raw.length) {
            const t = new Text2(raw);
            t._parent = el;
            el._children.push(t);
          }
          const end = closeIdx < 0 ? html.length : last + closeIdx + ("</" + tag + ">").length;
          last = end;
          re.lastIndex = end;
          continue;
        }
        if (tag === "template") {
          const frag = new DocumentFragment2();
          frag._parent = null;
          el._templateContent = frag;
          stack.push({ el, parentForChildren: frag, container: frag._children });
          target = frag._children;
          continue;
        }
        stack.push({ el, parentForChildren: el, container: el._children });
        target = el._children;
      }
      if (last < html.length) {
        const tail = html.slice(last);
        if (tail.length) pushChild(makeText(tail));
      }
      for (const n of out) n._parent = null;
      return out;
    }
    __name(parseFragment2, "parseFragment");
    function makeText(s) {
      return new Text2(decodeEntities(s));
    }
    __name(makeText, "makeText");
    function asciiLowerAttr(s) {
      return s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
    }
    __name(asciiLowerAttr, "asciiLowerAttr");
    function foreignAttr(rawName) {
      if (rawName === "xmlns") return { key: rawName, meta: { ns: XMLNS_NS_P, prefix: null, localName: "xmlns" } };
      const ci = rawName.indexOf(":");
      if (ci > 0) {
        const p = rawName.slice(0, ci), ln = rawName.slice(ci + 1);
        if (p === "xmlns") return { key: rawName, meta: { ns: XMLNS_NS_P, prefix: "xmlns", localName: ln } };
        if (p === "xlink") return { key: rawName, meta: { ns: XLINK_NS_P, prefix: "xlink", localName: ln } };
        if (p === "xml") return { key: rawName, meta: { ns: XML_NS_P, prefix: "xml", localName: ln } };
      }
      return null;
    }
    __name(foreignAttr, "foreignAttr");
    function applyAttributes(el, rest, foreign) {
      const re = /([^\s"'=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
      let m;
      const slow = el._tag === "body" || el._tag === "frameset";
      while ((m = re.exec(rest)) !== null) {
        const v = m[2] != null ? m[2] : m[3] != null ? m[3] : m[4] != null ? m[4] : "";
        if (slow) {
          el.setAttribute(m[1], decodeEntities(v));
          continue;
        }
        if (foreign) {
          const fa = foreignAttr(m[1]);
          el._attrs[m[1]] = decodeEntities(v);
          if (fa) (el._attrNS || (el._attrNS = {}))[fa.key] = fa.meta;
          continue;
        }
        const k = asciiLowerAttr(m[1]);
        const dv = decodeEntities(v);
        el._attrs[k] = dv;
        if (k === "id" || k === "name") registerNamedAccess2(el, k, dv);
      }
    }
    __name(applyAttributes, "applyAttributes");
    return { parseDocument: parseDocument2, parseFragment: parseFragment2 };
  }
  __name(installHtmlParser, "installHtmlParser");
  function serializeElement(el) {
    if (!el || !el._tag || !el._attrs) return "";
    const attrs = Object.keys(el._attrs).map((n) => {
      const m = el._attrNS && el._attrNS[n];
      const qn = m ? m.prefix ? m.prefix + ":" + m.localName : m.localName : n;
      return " " + qn + '="' + escapeAttr(el._attrs[n]) + '"';
    }).join("");
    if (VOID.has(el._tag)) return "<" + el._tag + attrs + ">";
    return "<" + el._tag + attrs + ">" + serializeChildren(el) + "</" + el._tag + ">";
  }
  __name(serializeElement, "serializeElement");
  function serializeChildren(el) {
    let s = "";
    if (!el || !el._children) return s;
    for (const c of el._children) {
      if (c.nodeType === NODE_TEXT) s += escapeText(c.data);
      else if (c.nodeType === NODE_COMMENT) s += "<!--" + String(c.data == null ? "" : c.data) + "-->";
      else if (c.nodeType === NODE_CDATA) s += "<![CDATA[" + String(c.data == null ? "" : c.data) + "]]>";
      else s += serializeElement(c);
    }
    return s;
  }
  __name(serializeChildren, "serializeChildren");
  function decodeEntities(s) {
    return s.replace(/&(amp|lt|gt|quot|apos|nbsp|#\d+|#x[0-9a-fA-F]+);/g, (_, e) => {
      if (e === "amp") return "&";
      if (e === "lt") return "<";
      if (e === "gt") return ">";
      if (e === "quot") return '"';
      if (e === "apos") return "'";
      if (e === "nbsp") return "\xA0";
      if (e[0] === "#") {
        const code = e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : "";
      }
      return "";
    });
  }
  __name(decodeEntities, "decodeEntities");
  function escapeAttr(v) {
    return String(v).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  }
  __name(escapeAttr, "escapeAttr");
  function escapeText(v) {
    return String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  __name(escapeText, "escapeText");

  // lib/capybara/simulated/js/src/xml-parser.js
  var XML_NS = "http://www.w3.org/XML/1998/namespace";
  var XMLNS_NS = "http://www.w3.org/2000/xmlns/";
  var PARSERERROR_NS = "http://www.mozilla.org/newlayout/xml/parsererror.xml";
  var isWs = /* @__PURE__ */ __name((c) => c === " " || c === "	" || c === "\n" || c === "\r" || c === "\f", "isWs");
  var isNCName = /* @__PURE__ */ __name((s) => /^[A-Za-z_][\w.\-]*$/.test(s), "isNCName");
  var isQName = /* @__PURE__ */ __name((s) => {
    const c = s.indexOf(":");
    return c === -1 ? isNCName(s) : isNCName(s.slice(0, c)) && isNCName(s.slice(c + 1));
  }, "isQName");
  function findTagEnd(s, lt) {
    let q = null;
    for (let i = lt + 1; i < s.length; i++) {
      const c = s[i];
      if (q) {
        if (c === q) q = null;
      } else if (c === '"' || c === "'") q = c;
      else if (c === ">") return i;
    }
    return -1;
  }
  __name(findTagEnd, "findTagEnd");
  function parseTag(inner) {
    let i = 0;
    const n = inner.length;
    let err = false;
    while (i < n && isWs(inner[i])) i++;
    let nameEnd = i;
    while (nameEnd < n && !isWs(inner[nameEnd])) nameEnd++;
    const name = inner.slice(i, nameEnd);
    i = nameEnd;
    const attrs = [];
    while (i < n) {
      while (i < n && (isWs(inner[i]) || inner[i] === "/")) i++;
      if (i >= n) break;
      if (inner[i] === "=") {
        err = true;
        break;
      }
      let ae = i;
      while (ae < n && !isWs(inner[ae]) && inner[ae] !== "=") ae++;
      const aname = inner.slice(i, ae);
      i = ae;
      while (i < n && isWs(inner[i])) i++;
      if (inner[i] !== "=") {
        err = true;
        break;
      }
      i++;
      while (i < n && isWs(inner[i])) i++;
      const q = inner[i];
      if (q !== '"' && q !== "'") {
        err = true;
        break;
      }
      const end = inner.indexOf(q, i + 1);
      if (end === -1) {
        err = true;
        break;
      }
      attrs.push({ name: aname, value: decodeEntities(inner.slice(i + 1, end)) });
      i = end + 1;
    }
    return { name, attrs, err };
  }
  __name(parseTag, "parseTag");
  function installXmlParser({ Element: Element2, Text: Text2, Comment: Comment2, ProcessingInstruction: ProcessingInstruction2, CDATASection: CDATASection2, DocumentType: DocumentType2 }) {
    function makeDoctype(decl) {
      if (!/^DOCTYPE(\s|$)/i.test(decl)) return { dt: null, err: false };
      const parts = decl.replace(/\[[\s\S]*\]/, "").match(/"[^"]*"|'[^']*'|\S+/g) || [];
      const unq = /* @__PURE__ */ __name((x) => x ? x.replace(/^['"]|['"]$/g, "") : "", "unq");
      const name = parts[1] || "";
      const kw = (parts[2] || "").toUpperCase();
      let publicId = "", systemId = "";
      if (kw === "PUBLIC") {
        if (parts[3] === void 0 || parts[4] === void 0) return { dt: null, err: true };
        publicId = unq(parts[3]);
        systemId = unq(parts[4]);
      } else if (kw === "SYSTEM") {
        if (parts[3] === void 0) return { dt: null, err: true };
        systemId = unq(parts[3]);
      }
      return { dt: new DocumentType2(name, publicId, systemId, null), err: false };
    }
    __name(makeDoctype, "makeDoctype");
    function collectEntities(decl, into) {
      const subset = decl.match(/\[([\s\S]*)\]/);
      if (!subset) return;
      const re = /<!ENTITY\s+([^\s%][^\s]*)\s+(?:"([^"]*)"|'([^']*)')\s*>/g;
      let m;
      while ((m = re.exec(subset[1])) !== null) {
        into[m[1]] = m[2] !== void 0 ? m[2] : m[3];
      }
    }
    __name(collectEntities, "collectEntities");
    function inScopeNamespaces(el) {
      const scope = { xml: XML_NS };
      const chain = [];
      for (let node = el; node instanceof Element2; node = node._parent) chain.push(node);
      for (let k = chain.length - 1; k >= 0; k--) {
        const attrs = chain[k]._attrs || {};
        for (const name in attrs) {
          if (name === "xmlns") scope[""] = attrs[name] || null;
          else if (name.slice(0, 6) === "xmlns:") scope[name.slice(6)] = attrs[name] || null;
        }
      }
      return scope;
    }
    __name(inScopeNamespaces, "inScopeNamespaces");
    function parseXml2(src, opts) {
      const context = opts && opts.context;
      const seedScope = opts && opts.scope;
      const fragment = context !== void 0 && context !== null || seedScope !== void 0 && seedScope !== null;
      const s = String(src == null ? "" : src);
      const n = s.length;
      const top = [];
      const stack = [];
      const nsStack = [seedScope != null ? seedScope : context != null ? inScopeNamespaces(context) : { xml: XML_NS }];
      const entities = /* @__PURE__ */ Object.create(null);
      let i = 0;
      let err = false;
      const append = /* @__PURE__ */ __name((node) => {
        if (stack.length) {
          node._parent = stack[stack.length - 1];
          stack[stack.length - 1]._children.push(node);
        } else {
          top.push(node);
        }
      }, "append");
      const appendChars = /* @__PURE__ */ __name((text) => {
        if (!/&[^\s;&]+;/.test(text)) {
          append(new Text2(decodeEntities(text)));
          return;
        }
        const re = /&([^\s;&]+);/g;
        let last = 0, m;
        while ((m = re.exec(text)) !== null) {
          if (!(m[1] in entities)) continue;
          if (m.index > last) append(new Text2(decodeEntities(text.slice(last, m.index))));
          const expanded = parseXml2(entities[m[1]], { scope: nsStack[nsStack.length - 1] });
          if (expanded === null) {
            err = true;
          } else {
            for (const node of expanded) append(node);
          }
          last = re.lastIndex;
        }
        if (last < text.length) append(new Text2(decodeEntities(text.slice(last))));
      }, "appendChars");
      while (i < n) {
        if (s[i] === "<") {
          if (s.startsWith("<!--", i)) {
            const end = s.indexOf("-->", i + 4);
            append(new Comment2(end === -1 ? s.slice(i + 4) : s.slice(i + 4, end)));
            i = end === -1 ? n : end + 3;
          } else if (s.startsWith("<![CDATA[", i)) {
            const end = s.indexOf("]]>", i + 9);
            append(new CDATASection2(end === -1 ? s.slice(i + 9) : s.slice(i + 9, end)));
            i = end === -1 ? n : end + 3;
          } else if (s.startsWith("<!", i)) {
            let j = i + 2, depth = 0;
            for (; j < n; j++) {
              const c = s[j];
              if (c === "[") depth++;
              else if (c === "]") depth--;
              else if (c === ">" && depth <= 0) break;
            }
            const decl = s.slice(i + 2, j);
            const { dt, err: dtErr } = makeDoctype(decl);
            if (dtErr) err = true;
            else if (dt) {
              append(dt);
              collectEntities(decl, entities);
            }
            i = j < n ? j + 1 : n;
          } else if (s[i + 1] === "?") {
            const end = s.indexOf("?>", i + 2);
            const raw = end === -1 ? s.slice(i + 2) : s.slice(i + 2, end);
            i = end === -1 ? n : end + 2;
            const m = /^([^\s?]+)([\s\S]*)$/.exec(raw);
            if (m && m[1].toLowerCase() !== "xml") {
              append(new ProcessingInstruction2(m[1], m[2].replace(/^\s+/, ""), null));
            }
          } else if (s[i + 1] === "/") {
            const end = s.indexOf(">", i);
            const raw = end === -1 ? s.slice(i + 2) : s.slice(i + 2, end);
            const endName = raw.replace(/\s+$/, "");
            if (end === -1 || /^\s/.test(raw) || !endName) err = true;
            if (stack.length === 0) {
              err = true;
            } else {
              const top2 = stack[stack.length - 1];
              const openName = top2._prefix ? top2._prefix + ":" + top2._localName : top2._localName;
              if (endName !== openName) err = true;
              stack.pop();
              nsStack.pop();
            }
            i = end === -1 ? n : end + 1;
          } else {
            if (isWs(s[i + 1])) err = true;
            const end = findTagEnd(s, i);
            if (end === -1) {
              err = true;
              i = n;
              break;
            }
            let inner = s.slice(i + 1, end);
            const selfClose = /\/\s*$/.test(inner);
            if (selfClose) inner = inner.replace(/\/\s*$/, "");
            const { name, attrs, err: tagErr } = parseTag(inner);
            if (tagErr || !isQName(name)) err = true;
            i = end + 1;
            const scope = Object.assign({}, nsStack[nsStack.length - 1]);
            for (const a of attrs) {
              if (a.name === "xmlns") {
                scope[""] = a.value || null;
              } else if (a.name.slice(0, 6) === "xmlns:") {
                const p = a.name.slice(6);
                if (!isNCName(p) || p === "xmlns") err = true;
                else scope[p] = a.value || null;
              }
            }
            for (const a of attrs) {
              if (a.name === "xmlns" || a.name.slice(0, 6) === "xmlns:") continue;
              if (!isQName(a.name)) {
                err = true;
                continue;
              }
              const ac = a.name.indexOf(":");
              if (ac !== -1 && a.name.slice(0, ac) !== "xml" && !(a.name.slice(0, ac) in scope)) {
                err = true;
              }
            }
            const colon = name.indexOf(":");
            const prefix = colon === -1 ? null : name.slice(0, colon);
            const localName = colon === -1 ? name : name.slice(colon + 1);
            if (prefix && prefix !== "xml" && !(prefix in scope)) err = true;
            const ns = prefix ? scope[prefix] || null : scope[""] || null;
            const el = new Element2(name);
            el._localName = localName;
            el._prefix = prefix;
            el._ns = ns;
            el._attrs = {};
            for (const a of attrs) {
              el._attrs[a.name] = a.value;
              const ac = a.name.indexOf(":");
              if (a.name === "xmlns") {
                (el._attrNS || (el._attrNS = {}))[a.name] = { ns: XMLNS_NS, prefix: null, localName: "xmlns" };
              } else if (ac !== -1) {
                const ap = a.name.slice(0, ac), al = a.name.slice(ac + 1);
                const ans = ap === "xmlns" ? XMLNS_NS : ap === "xml" ? XML_NS : scope[ap] || null;
                (el._attrNS || (el._attrNS = {}))[a.name] = { ns: ans, prefix: ap, localName: al };
              }
            }
            if (fragment && el._tag === "script") el._csimRan = true;
            append(el);
            if (!selfClose) {
              stack.push(el);
              nsStack.push(scope);
            }
          }
        } else {
          let j = s.indexOf("<", i);
          if (j === -1) j = n;
          const text = s.slice(i, j);
          if (stack.length ? text.length : /\S/.test(text)) {
            appendChars(text);
          }
          i = j;
        }
      }
      if (stack.length > 0) err = true;
      if (fragment) return err ? null : top;
      if (err) {
        const pe = new Element2("parsererror");
        pe._localName = "parsererror";
        pe._ns = PARSERERROR_NS;
        const msg = new Text2("XML parsing error");
        msg._parent = pe;
        pe._children.push(msg);
        return [pe];
      }
      return top;
    }
    __name(parseXml2, "parseXml");
    return { parseXml: parseXml2 };
  }
  __name(installXmlParser, "installXmlParser");

  // lib/capybara/simulated/js/src/dom-nodes.js
  function firstMetaCharset(doc) {
    const root = doc.documentElement;
    if (!root) return null;
    const metas = root.getElementsByTagName("meta");
    for (let i = 0; i < metas.length; i++) {
      const m = metas[i];
      let label = m._attrs.charset;
      if (label == null && (m._attrs["http-equiv"] || "").toLowerCase() === "content-type") {
        const mm = /charset\s*=\s*("[^"]*"|'[^']*'|[^\s;]+)/i.exec(m._attrs.content || "");
        if (mm) label = mm[1].replace(/^["']|["']$/g, "");
      }
      if (label != null && getEncoding(label, true) != null) return label;
    }
    return null;
  }
  __name(firstMetaCharset, "firstMetaCharset");
  var __nextId = 1;
  var __currentTag = null;
  function __notifyScroll(target) {
    try {
      const doc = globalThis.document;
      if (target && target !== doc) {
        dispatchEvent(target, new Event("scroll", { bubbles: false }));
      }
      if (doc) {
        dispatchEvent(doc, new Event("scroll", { bubbles: false }));
      }
      if (typeof globalThis.dispatchEvent === "function") {
        globalThis.dispatchEvent(new Event("scroll", { bubbles: false }));
      }
    } catch (_) {
    }
    try {
      if (typeof globalThis.__forceRefireIntersectionObservers === "function") {
        globalThis.__forceRefireIntersectionObservers();
      }
    } catch (_) {
    }
  }
  __name(__notifyScroll, "__notifyScroll");
  function __scrollArgsToXY(args) {
    if (args.length >= 2) {
      return [Number(args[0]) || 0, Number(args[1]) || 0];
    }
    const opt = args[0];
    if (opt && typeof opt === "object") {
      const x = opt.left != null ? Number(opt.left) || 0 : void 0;
      const y = opt.top != null ? Number(opt.top) || 0 : void 0;
      return [x, y];
    }
    return [void 0, void 0];
  }
  __name(__scrollArgsToXY, "__scrollArgsToXY");
  function toNode(v) {
    if (isNodeArg(v)) return v;
    return new Text(String(v));
  }
  __name(toNode, "toNode");
  function convertNodesIntoNode(nodes) {
    if (nodes.length === 1) return toNode(nodes[0]);
    const frag = new DocumentFragment();
    for (const n of nodes) frag.appendChild(toNode(n));
    return frag;
  }
  __name(convertNodesIntoNode, "convertNodesIntoNode");
  var ASCII_WHITESPACE = /[\t\n\f\r ]+/;
  function collectDescendants(scope, matches) {
    const out = [];
    const isDoc = scope.nodeType === NODE_DOC;
    const root = isDoc ? scope.documentElement : scope;
    if (!root) return out;
    if (isDoc && matches(root)) out.push(root);
    for (const n of root.querySelectorAll("*")) {
      if (n === root) continue;
      if (matches(n)) out.push(n);
    }
    return out;
  }
  __name(collectDescendants, "collectDescendants");
  function collectByClassName(scope, classNames) {
    const wanted = String(classNames).split(ASCII_WHITESPACE).filter(Boolean);
    if (!wanted.length) return [];
    return collectDescendants(scope, (el) => {
      const c = el._attrs && el._attrs["class"];
      if (!c) return false;
      const tok = c.split(ASCII_WHITESPACE);
      return wanted.every((w) => tok.indexOf(w) !== -1);
    });
  }
  __name(collectByClassName, "collectByClassName");
  function collectByTagNameNS(scope, namespace, localName) {
    const wantNs = namespace === "*" ? "*" : namespace == null || namespace === "" ? null : String(namespace);
    const wantLn = String(localName);
    return collectDescendants(scope, (el) => (wantNs === "*" || el._ns === wantNs) && (wantLn === "*" || el._localName === wantLn));
  }
  __name(collectByTagNameNS, "collectByTagNameNS");
  function collectByTagName(scope, tag) {
    const q = String(tag);
    const htmlDoc = isHtmlDocument(scope.ownerDocument);
    const qLower = htmlDoc ? asciiLower2(q) : q;
    return collectDescendants(scope, (n) => {
      if (q === "*") return true;
      const qn = n._prefix ? n._prefix + ":" + n._localName : n._localName;
      return htmlDoc ? n._ns === HTML_NS2 ? qn === qLower : qn === q : qn === q;
    });
  }
  __name(collectByTagName, "collectByTagName");
  var NODE_TYPE_NAMES = {
    [NODE_ELEMENT]: "Element",
    [NODE_TEXT]: "Text",
    [NODE_COMMENT]: "Comment",
    [NODE_DOC]: "Document",
    [NODE_DOCTYPE]: "DocumentType",
    [NODE_FRAGMENT]: "DocumentFragment"
  };
  function nodeTypeName(node) {
    return NODE_TYPE_NAMES[node && node.nodeType] || "node";
  }
  __name(nodeTypeName, "nodeTypeName");
  function isInclusiveAncestor(node, parent) {
    for (let p = parent; p; p = p._parent) {
      if (p === node) return true;
    }
    return false;
  }
  __name(isInclusiveAncestor, "isInclusiveAncestor");
  function hierarchyError(msg) {
    return new globalThis.DOMException(msg, "HierarchyRequestError");
  }
  __name(hierarchyError, "hierarchyError");
  function siblingOfType(parent, child, t, after) {
    const arr = parent._children, i = arr.indexOf(child);
    if (i < 0) return false;
    if (after) {
      for (let j = i + 1; j < arr.length; j++) if (arr[j].nodeType === t) return true;
    } else {
      for (let j = 0; j < i; j++) if (arr[j].nodeType === t) return true;
    }
    return false;
  }
  __name(siblingOfType, "siblingOfType");
  function validateInsertion(node, parent, child, isReplace) {
    const pt = parent.nodeType;
    if (pt !== NODE_DOC && pt !== NODE_FRAGMENT && pt !== NODE_ELEMENT) {
      throw hierarchyError(`Cannot add a child to a ${nodeTypeName(parent)} node`);
    }
    if (isInclusiveAncestor(node, parent)) {
      throw hierarchyError("The new child is an ancestor of the parent");
    }
    if (child != null && child._parent !== parent) {
      throw new globalThis.DOMException("The reference child is not a child of this node", "NotFoundError");
    }
    const t = node.nodeType;
    if (t !== NODE_FRAGMENT && t !== NODE_DOCTYPE && t !== NODE_ELEMENT && t !== NODE_TEXT && t !== NODE_CDATA && t !== NODE_COMMENT && t !== NODE_PI) {
      throw hierarchyError(`Cannot insert a ${nodeTypeName(node)} node`);
    }
    if ((t === NODE_TEXT || t === NODE_CDATA) && pt === NODE_DOC || t === NODE_DOCTYPE && pt !== NODE_DOC) {
      throw hierarchyError(`A ${nodeTypeName(node)} node cannot be a child of a ${nodeTypeName(parent)} node`);
    }
    if (pt !== NODE_DOC) return;
    const except = isReplace ? child : null;
    const hasEl = parent._children.some((c) => c.nodeType === NODE_ELEMENT && c !== except);
    const hasDt = parent._children.some((c) => c.nodeType === NODE_DOCTYPE && c !== except);
    const childIsDoctype = !isReplace && child && child.nodeType === NODE_DOCTYPE;
    if (t === NODE_FRAGMENT) {
      let nEl = 0, hasText = false;
      for (const c of node._children) {
        if (c.nodeType === NODE_ELEMENT) nEl++;
        else if (c.nodeType === NODE_TEXT) hasText = true;
      }
      if (nEl > 1 || hasText) throw hierarchyError("Document can contain only one element");
      if (nEl === 1 && (hasEl || childIsDoctype || child && siblingOfType(parent, child, NODE_DOCTYPE, true))) {
        throw hierarchyError("Invalid placement of an element in a Document");
      }
    } else if (t === NODE_ELEMENT) {
      if (hasEl || childIsDoctype || child && siblingOfType(parent, child, NODE_DOCTYPE, true)) {
        throw hierarchyError("Document can contain only one element child");
      }
    } else if (t === NODE_DOCTYPE) {
      if (hasDt || child && siblingOfType(parent, child, NODE_ELEMENT, false) || !child && parent._children.some((c) => c.nodeType === NODE_ELEMENT)) {
        throw hierarchyError("Invalid placement of a doctype in a Document");
      }
    }
  }
  __name(validateInsertion, "validateInsertion");
  function ensurePreInsertionValidity(node, parent, child) {
    validateInsertion(node, parent, child, false);
  }
  __name(ensurePreInsertionValidity, "ensurePreInsertionValidity");
  function adoptIntoParent(parent, node) {
    const destDoc = parent.nodeType === NODE_DOC ? parent : parent.ownerDocument;
    if (destDoc && node.ownerDocument !== destDoc && typeof destDoc.adoptNode === "function") {
      destDoc.adoptNode(node);
    } else if (node._parent) {
      node._parent.removeChild(node);
    }
  }
  __name(adoptIntoParent, "adoptIntoParent");
  function assertNodeArg(value) {
    if (value == null || typeof value.nodeType !== "number") {
      throw new TypeError("Argument is not an object that implements Node");
    }
  }
  __name(assertNodeArg, "assertNodeArg");
  var DISABLEABLE_TAGS = /* @__PURE__ */ new Set(["button", "input", "select", "textarea", "optgroup", "option", "fieldset"]);
  var NO_REQUIRED_INPUT_TYPES = /* @__PURE__ */ new Set([
    "submit",
    "image",
    "reset",
    "button",
    "hidden",
    "range",
    "color"
  ]);
  function isActuallyDisabled(el) {
    return !!el && el.nodeType === NODE_ELEMENT && DISABLEABLE_TAGS.has(el._tag) && el._attrs.disabled != null;
  }
  __name(isActuallyDisabled, "isActuallyDisabled");
  var DOM_WS_RUN = /[\t\n\f\r ]+/;
  var DOM_WS_ANY = /[\t\n\f\r ]/;
  function parseOrderedSet(str) {
    if (!str) return [];
    const out = [], seen = /* @__PURE__ */ new Set();
    for (const tok of String(str).split(DOM_WS_RUN)) {
      if (tok === "" || seen.has(tok)) continue;
      seen.add(tok);
      out.push(tok);
    }
    return out;
  }
  __name(parseOrderedSet, "parseOrderedSet");
  var REL_LINK = /* @__PURE__ */ new Set([
    "alternate",
    "canonical",
    "dns-prefetch",
    "icon",
    "manifest",
    "modulepreload",
    "next",
    "preconnect",
    "prefetch",
    "preload",
    "stylesheet",
    "apple-touch-icon"
  ]);
  var REL_HYPERLINK = /* @__PURE__ */ new Set(["noopener", "noreferrer", "opener"]);
  var SANDBOX_TOKENS = /* @__PURE__ */ new Set([
    "allow-downloads",
    "allow-forms",
    "allow-modals",
    "allow-orientation-lock",
    "allow-pointer-lock",
    "allow-popups",
    "allow-popups-to-escape-sandbox",
    "allow-presentation",
    "allow-same-origin",
    "allow-scripts",
    "allow-storage-access-by-user-activation",
    "allow-top-navigation",
    "allow-top-navigation-by-user-activation"
  ]);
  function supportedTokensFor(el, attr) {
    const tag = (el && el.tagName ? String(el.tagName) : "").toLowerCase();
    if (attr === "rel") {
      if (tag === "link") return REL_LINK;
      if (tag === "a" || tag === "area" || tag === "form") return REL_HYPERLINK;
      return null;
    }
    if (attr === "sandbox" && tag === "iframe") return SANDBOX_TOKENS;
    return null;
  }
  __name(supportedTokensFor, "supportedTokensFor");
  function validateToken(token, method) {
    if (token === "") {
      throw new globalThis.DOMException(
        `Failed to execute '${method}' on 'DOMTokenList': The token provided must not be empty.`,
        "SyntaxError"
      );
    }
    if (DOM_WS_ANY.test(token)) {
      throw new globalThis.DOMException(
        `Failed to execute '${method}' on 'DOMTokenList': The token provided ('${token}') contains HTML space characters, which are not valid in tokens.`,
        "InvalidCharacterError"
      );
    }
  }
  __name(validateToken, "validateToken");
  var DOMTokenList = class {
    static {
      __name(this, "DOMTokenList");
    }
    constructor(el, attr) {
      Object.defineProperty(this, "_el", { value: el });
      Object.defineProperty(this, "_attr", { value: attr });
    }
    // The current token set (ordered, deduped) parsed from the attribute.
    _set() {
      return parseOrderedSet(this._el._attrs[this._attr]);
    }
    // Update steps: serialize the set back to the attribute — but if the
    // attribute is absent AND the set is empty, do nothing (don't create it).
    _update(tokens) {
      if (!(this._attr in this._el._attrs) && tokens.length === 0) return;
      this._el.setAttribute(this._attr, tokens.join(" "));
    }
    get length() {
      return this._set().length;
    }
    item(index) {
      const set = this._set();
      index = index >>> 0;
      return index < set.length ? set[index] : null;
    }
    contains(token) {
      return this._set().includes(String(token));
    }
    add(...tokens) {
      tokens = tokens.map(String);
      for (const t of tokens) validateToken(t, "add");
      const set = this._set();
      for (const t of tokens) if (!set.includes(t)) set.push(t);
      this._update(set);
    }
    remove(...tokens) {
      tokens = tokens.map(String);
      for (const t of tokens) validateToken(t, "remove");
      const drop = new Set(tokens);
      this._update(this._set().filter((t) => !drop.has(t)));
    }
    toggle(token, force) {
      token = String(token);
      validateToken(token, "toggle");
      const hasForce = arguments.length > 1;
      const f = hasForce ? Boolean(force) : void 0;
      const set = this._set();
      const i = set.indexOf(token);
      if (i >= 0) {
        if (!hasForce || f === false) {
          set.splice(i, 1);
          this._update(set);
          return false;
        }
        return true;
      }
      if (!hasForce || f === true) {
        set.push(token);
        this._update(set);
        return true;
      }
      return false;
    }
    replace(token, newToken) {
      token = String(token);
      newToken = String(newToken);
      if (token === "" || newToken === "") {
        throw new globalThis.DOMException(
          "Failed to execute 'replace' on 'DOMTokenList': The token provided must not be empty.",
          "SyntaxError"
        );
      }
      if (DOM_WS_ANY.test(token) || DOM_WS_ANY.test(newToken)) {
        throw new globalThis.DOMException(
          "Failed to execute 'replace' on 'DOMTokenList': The token provided contains HTML space characters.",
          "InvalidCharacterError"
        );
      }
      const set = this._set();
      const i = set.indexOf(token);
      if (i < 0) return false;
      set[i] = newToken;
      this._update(parseOrderedSet(set.join(" ")));
      return true;
    }
    // Per spec, supports(token) throws only when the associated attribute
    // defines no supported tokens (e.g. class); for rel / sandbox it returns
    // whether the ASCII-lowercased token is in the supported set.
    supports(token) {
      const supported = supportedTokensFor(this._el, this._attr);
      if (!supported) {
        throw new TypeError("Failed to execute 'supports' on 'DOMTokenList': DOMTokenList has no supported tokens.");
      }
      return supported.has(String(token).toLowerCase());
    }
    get [Symbol.toStringTag]() {
      return "DOMTokenList";
    }
    get value() {
      return this._el._attrs[this._attr] || "";
    }
    set value(v) {
      this._el.setAttribute(this._attr, v == null ? "" : String(v));
    }
    toString() {
      return this.value;
    }
    forEach(fn, thisArg) {
      this._set().forEach((t, i) => fn.call(thisArg, t, i, this));
    }
    entries() {
      return this._set().entries();
    }
    keys() {
      return this._set().keys();
    }
    values() {
      return this._set().values();
    }
    [Symbol.iterator]() {
      return this._set()[Symbol.iterator]();
    }
  };
  globalThis.DOMTokenList = DOMTokenList;
  function asArrayIndex(prop) {
    if (typeof prop !== "string") return -1;
    const n = prop >>> 0;
    return String(n) === prop && n < 4294967295 ? n : -1;
  }
  __name(asArrayIndex, "asArrayIndex");
  function tokenListFor(el, attr) {
    const cache = el._tokenLists || (el._tokenLists = {});
    if (cache[attr]) return cache[attr];
    const list = new DOMTokenList(el, attr);
    const proxy = new Proxy(list, {
      get(target, prop, receiver) {
        const idx = asArrayIndex(prop);
        if (idx >= 0) {
          const v = target.item(idx);
          return v === null ? void 0 : v;
        }
        return Reflect.get(target, prop, receiver);
      },
      has(target, prop) {
        const idx = asArrayIndex(prop);
        if (idx >= 0) return idx < target.length;
        return Reflect.has(target, prop);
      }
    });
    cache[attr] = proxy;
    return proxy;
  }
  __name(tokenListFor, "tokenListFor");
  var HTML_NS2 = "http://www.w3.org/1999/xhtml";
  var SVG_NS = "http://www.w3.org/2000/svg";
  var XML_NS2 = "http://www.w3.org/XML/1998/namespace";
  var XMLNS_NS2 = "http://www.w3.org/2000/xmlns/";
  var PREFIX_FORBIDDEN = /[\t\n\f\r \0/>]/;
  function isAsciiAlpha(c) {
    return c >= 65 && c <= 90 || c >= 97 && c <= 122;
  }
  __name(isAsciiAlpha, "isAsciiAlpha");
  function isAsciiDigit(c) {
    return c >= 48 && c <= 57;
  }
  __name(isAsciiDigit, "isAsciiDigit");
  function isValidNamespacePrefix(s) {
    return s.length >= 1 && !PREFIX_FORBIDDEN.test(s);
  }
  __name(isValidNamespacePrefix, "isValidNamespacePrefix");
  function isValidElementLocalName(name) {
    if (name.length === 0) return false;
    const c0 = name.codePointAt(0);
    if (isAsciiAlpha(c0)) return !PREFIX_FORBIDDEN.test(name);
    if (!(c0 === 58 || c0 === 95 || c0 >= 128)) return false;
    for (const ch of name) {
      const c = ch.codePointAt(0);
      const ok = isAsciiAlpha(c) || isAsciiDigit(c) || c === 45 || c === 46 || c === 58 || c === 95 || c >= 128;
      if (!ok) return false;
    }
    return true;
  }
  __name(isValidElementLocalName, "isValidElementLocalName");
  function asciiUpper(s) {
    return s.replace(/[a-z]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 32));
  }
  __name(asciiUpper, "asciiUpper");
  function asciiLower2(s) {
    return s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
  }
  __name(asciiLower2, "asciiLower");
  function isHtmlDocument(doc) {
    if (!doc || !doc._contentType) return true;
    const ct = doc._contentType;
    return ct !== "text/xml" && ct !== "application/xml" && ct !== "application/xhtml+xml" && ct !== "image/svg+xml";
  }
  __name(isHtmlDocument, "isHtmlDocument");
  var DOCTYPE_NAME_FORBIDDEN = /[\t\n\f\r \0>]/;
  function isValidDoctypeName(name) {
    return !DOCTYPE_NAME_FORBIDDEN.test(name);
  }
  __name(isValidDoctypeName, "isValidDoctypeName");
  function locateNamespace(node, prefix) {
    if (!node) return null;
    const parentEl = /* @__PURE__ */ __name((n) => n._parent && n._parent.nodeType === NODE_ELEMENT ? n._parent : null, "parentEl");
    switch (node.nodeType) {
      case NODE_ELEMENT: {
        if (prefix === "xml") return XML_NS2;
        if (prefix === "xmlns") return XMLNS_NS2;
        if (node._ns != null && node._prefix === prefix) return node._ns;
        if (node._attrNS) {
          for (const key in node._attrNS) {
            const meta = node._attrNS[key];
            if (meta.ns !== XMLNS_NS2) continue;
            const match = prefix != null ? meta.prefix === "xmlns" && meta.localName === prefix : meta.prefix == null && meta.localName === "xmlns";
            if (match) {
              const v = node._attrs[key];
              return v === "" ? null : v;
            }
          }
        }
        return locateNamespace(parentEl(node), prefix);
      }
      case NODE_DOC:
        return locateNamespace(node.documentElement, prefix);
      case NODE_ATTRIBUTE:
        return locateNamespace(node._ownerElement, prefix);
      // attr → its element
      case NODE_DOCTYPE:
      case NODE_FRAGMENT:
        return null;
      default:
        return locateNamespace(parentEl(node), prefix);
    }
  }
  __name(locateNamespace, "locateNamespace");
  var CREATE_EVENT_INTERFACES = {
    beforeunloadevent: "BeforeUnloadEvent",
    compositionevent: "CompositionEvent",
    customevent: "CustomEvent",
    devicemotionevent: "DeviceMotionEvent",
    deviceorientationevent: "DeviceOrientationEvent",
    dragevent: "DragEvent",
    event: "Event",
    events: "Event",
    focusevent: "FocusEvent",
    hashchangeevent: "HashChangeEvent",
    htmlevents: "Event",
    keyboardevent: "KeyboardEvent",
    messageevent: "MessageEvent",
    mouseevent: "MouseEvent",
    mouseevents: "MouseEvent",
    storageevent: "StorageEvent",
    svgevents: "Event",
    textevent: "TextEvent",
    // touchevent is added by the Touch Events spec; we expose touch
    // (`ontouchstart` in document), so it's supported here too. (wheelevent is
    // deliberately absent — it's a non-legacy interface and must NotSupportedError.)
    touchevent: "TouchEvent",
    uievent: "UIEvent",
    uievents: "UIEvent"
  };
  var ATTR_NAME_FORBIDDEN = /[\t\n\f\r \0/=>]/;
  function isValidAttributeLocalName(name) {
    return name.length >= 1 && !ATTR_NAME_FORBIDDEN.test(name);
  }
  __name(isValidAttributeLocalName, "isValidAttributeLocalName");
  function attrKey(el, name) {
    const s = String(name);
    return el && el._ns === HTML_NS2 ? asciiLower2(s) : s;
  }
  __name(attrKey, "attrKey");
  function attrQName(el, key) {
    const m = el._attrNS && el._attrNS[key];
    return m ? m.prefix ? m.prefix + ":" + m.localName : m.localName : key;
  }
  __name(attrQName, "attrQName");
  function freshAttrKey(el, qn) {
    if (!Object.prototype.hasOwnProperty.call(el._attrs, qn)) return qn;
    let i = 1, k;
    do {
      k = qn + "\0" + i++;
    } while (Object.prototype.hasOwnProperty.call(el._attrs, k));
    return k;
  }
  __name(freshAttrKey, "freshAttrKey");
  function firstAttrKeyByQName(el, name) {
    const want = el._ns === HTML_NS2 ? asciiLower2(String(name)) : String(name);
    for (const k in el._attrs) if (attrQName(el, k) === want) return k;
    return null;
  }
  __name(firstAttrKeyByQName, "firstAttrKeyByQName");
  function validateAndExtract(namespace, qualifiedName, context) {
    if (namespace === "") namespace = null;
    let prefix = null, localName = qualifiedName;
    const ci = qualifiedName.indexOf(":");
    if (ci !== -1) {
      prefix = qualifiedName.slice(0, ci);
      localName = qualifiedName.slice(ci + 1);
    }
    if (prefix !== null && !isValidNamespacePrefix(prefix)) {
      throw new globalThis.DOMException(
        `The qualified name  contains an invalid prefix.`,
        "InvalidCharacterError"
      );
    }
    const localNameOk = context === "attribute" ? isValidAttributeLocalName(localName) : isValidElementLocalName(localName);
    if (!localNameOk) {
      throw new globalThis.DOMException(
        `The local name is not a valid name.`,
        "InvalidCharacterError"
      );
    }
    if (prefix !== null && namespace === null) {
      throw new globalThis.DOMException("A namespace prefix was given but no namespace.", "NamespaceError");
    }
    if (prefix === "xml" && namespace !== XML_NS2) {
      throw new globalThis.DOMException('The "xml" prefix requires the XML namespace.', "NamespaceError");
    }
    if ((qualifiedName === "xmlns" || prefix === "xmlns") && namespace !== XMLNS_NS2) {
      throw new globalThis.DOMException('The "xmlns" name requires the XMLNS namespace.', "NamespaceError");
    }
    if (namespace === XMLNS_NS2 && qualifiedName !== "xmlns" && prefix !== "xmlns") {
      throw new globalThis.DOMException("The XMLNS namespace is reserved for the xmlns name.", "NamespaceError");
    }
    return { namespace, prefix, localName };
  }
  __name(validateAndExtract, "validateAndExtract");
  var Node = class {
    static {
      __name(this, "Node");
    }
    constructor() {
      this._id = __nextId++;
      this._parent = null;
      this._children = newChildList();
      this._listeners = null;
      this.nodeType = NODE_ELEMENT;
      this._ownerDoc = null;
    }
    getRootNode(options) {
      const composed = !!(options && options.composed);
      let cur = this;
      while (cur._parent) {
        if (!composed && cur._isShadowRoot) break;
        cur = cur._parent;
      }
      return cur;
    }
    // Per DOM, `nodeValue` is null for every node type except Attr (its value)
    // and CharacterData (its data), and its setter is a no-op on the others.
    // CharacterData / Attr override both; this base covers Document,
    // DocumentFragment, DocumentType, and Element (which otherwise inherited an
    // `undefined` nodeValue here).
    get nodeValue() {
      return null;
    }
    set nodeValue(_v) {
    }
    isSameNode(other) {
      return other != null && this === other;
    }
    // `Node.isEqualNode(other)` per DOM spec — structural equality
    // ignoring node identity. Turbo Drive's `PageRenderer.
    // mergeProvisionalElements` walks the old/new head's provisional
    // elements and calls `newElement.isEqualNode(element)` to decide
    // which to keep; without this the render chain throws "isEqualNode
    // is not a function" inside `await prepareToRenderSnapshot`,
    // never fires `turbo:before-render`, and the body swap that should
    // turn `/edit` into the `/show` page silently aborts (the URL
    // updates via history.pushState earlier in the chain but the DOM
    // stays on the edit form).
    isEqualNode(other) {
      if (other == null || this.nodeType !== other.nodeType) return false;
      if (this.nodeType === NODE_ELEMENT) {
        if (this._ns !== other._ns || this._prefix !== other._prefix || this._localName !== other._localName) return false;
        const ak = Object.keys(this._attrs), bk = Object.keys(other._attrs);
        if (ak.length !== bk.length) return false;
        const bMap = /* @__PURE__ */ new Map();
        for (const k of bk) {
          const m = other._attrNS && other._attrNS[k];
          bMap.set((m ? m.ns || "" : "") + "\0" + (m ? m.localName : k), other._attrs[k]);
        }
        for (const k of ak) {
          const m = this._attrNS && this._attrNS[k];
          const key = (m ? m.ns || "" : "") + "\0" + (m ? m.localName : k);
          if (!bMap.has(key) || bMap.get(key) !== this._attrs[k]) return false;
        }
      } else if (this.nodeType === NODE_ATTRIBUTE) {
        if (this._ns !== other._ns || this._localName !== other._localName || this.value !== other.value) return false;
      } else if (this.nodeType === NODE_DOCTYPE) {
        if (this.name !== other.name || this.publicId !== other.publicId || this.systemId !== other.systemId) return false;
      } else if (this.nodeType === NODE_PI) {
        if (this._target !== other._target || (this._data || "") !== (other._data || "")) return false;
      } else if (this.nodeType === NODE_TEXT || this.nodeType === NODE_COMMENT) {
        if ((this._data || "") !== (other._data || "")) return false;
      }
      const ac = this._children || [], bc = other._children || [];
      if (ac.length !== bc.length) return false;
      for (let i = 0; i < ac.length; i++) {
        if (!ac[i].isEqualNode(bc[i])) return false;
      }
      return true;
    }
    addEventListener(type, handler, options) {
      const capture = flattenCapture(options);
      let isObject = false;
      if (typeof handler === "function") {
      } else if (handler !== null && typeof handler === "object") isObject = true;
      else return;
      const passive = options && typeof options === "object" && options.passive !== void 0 ? !!options.passive : defaultPassiveValue(type, this);
      const once = !!(options && typeof options === "object" && options.once);
      this._listeners = this._listeners || /* @__PURE__ */ Object.create(null);
      const list = this._listeners[type] || (this._listeners[type] = []);
      if (list.some((l) => l.handler === handler && l.capture === capture)) return;
      list.push({ handler, isObject, capture, passive, once });
    }
    removeEventListener(type, handler, options) {
      const capture = flattenCapture(options);
      if (!this._listeners || !this._listeners[type]) return;
      this._listeners[type] = this._listeners[type].filter((l) => {
        const isMatch = l.capture === capture && l.handler === handler;
        if (isMatch) l.removed = true;
        return !isMatch;
      });
    }
    dispatchEvent(event) {
      return dispatchEvent(this, event);
    }
    // Shallow / deep node cloning. jQuery probes feature support
    // via `document.createElement('div').cloneNode(true).attachEvent`
    // etc. before initialising, so this needs to work even on
    // detached nodes. Cloned nodes copy attrs and (deep) clone
    // children; listeners + custom-element state are intentionally
    // *not* copied (matches HTML spec).
    // Focus tracking: record `document.activeElement` and emit
    // focus / focusin / blur / focusout events so listeners observing
    // either path (`onfocus="..."` attribute, addEventListener, or
    // jQuery's `.focus(handler)`) actually fire. `:focus` pseudo-
    // class matches via `_activeElement` comparison in matchPseudo.
    focus() {
      if (!isFocusable(this)) return;
      const prev = globalThis.document._activeElement;
      if (prev === this) return;
      if (prev) {
        try {
          dispatchEvent(prev, new Event("blur", { bubbles: false, cancelable: false }));
        } catch (_) {
        }
        try {
          dispatchEvent(prev, new Event("focusout", { bubbles: true, cancelable: false }));
        } catch (_) {
        }
      }
      globalThis.document._activeElement = this;
      if (typeof isContenteditable === "function" && isContenteditable(this) && typeof globalThis.getSelection === "function") {
        try {
          const sel = globalThis.getSelection();
          const r0 = sel._ranges && sel._ranges[0];
          const inside = r0 && r0.startContainer && nodeContains(this, r0.startContainer);
          if (!inside) {
            const VOID_TAGS = /* @__PURE__ */ new Set(["br", "img", "hr", "input", "wbr", "meta", "link"]);
            let leaf = this;
            while (leaf._children && leaf._children.length > 0) {
              const next = leaf._children.find(
                (c) => c.nodeType === NODE_ELEMENT && !VOID_TAGS.has(c._tag)
              );
              if (!next) break;
              leaf = next;
            }
            if (leaf._children && leaf._children.length === 1 && leaf._children[0].nodeType === NODE_TEXT) {
              sel.collapse(leaf._children[0], leaf._children[0]._data.length);
            } else {
              sel.collapse(leaf, leaf._children ? leaf._children.length : 0);
            }
          }
        } catch (_) {
        }
      }
      try {
        dispatchEvent(this, new Event("focus", { bubbles: false, cancelable: false }));
      } catch (_) {
      }
      try {
        dispatchEvent(this, new Event("focusin", { bubbles: true, cancelable: false }));
      } catch (_) {
      }
    }
    blur() {
      if (globalThis.document._activeElement !== this) return;
      globalThis.document._activeElement = null;
      try {
        dispatchEvent(this, new Event("blur", { bubbles: false, cancelable: false }));
      } catch (_) {
      }
      try {
        dispatchEvent(this, new Event("focusout", { bubbles: true, cancelable: false }));
      } catch (_) {
      }
    }
    // Layout stubs — there's no rendering engine, so geometry is
    // always zero. Returning a sensible shape lets feature-detection
    // probes in jQuery / DOM libraries continue instead of throwing
    // "not a function". `getBoundingClientRect()` is the canonical
    // shape; `getClientRects()` returns a DOMRectList (an empty
    // array works for callers that just iterate or check length).
    // No layout engine; the 1×1 sentinel keeps jQuery `:visible` /
    // Stimulus / IntersectionObserver probes from misclassifying
    // visible elements as hidden. `_layoutY` gives each visible
    // element a unique top in measurement order — Discourse's
    // `_moveSelection` (J/K shortcut) calls `articles.find(rect.top
    // >= headerOffset())`; with all rects at top=0 the find never
    // matches and Discourse's fallback selects the LAST article
    // instead of the first. Assigning Y lazily on first measurement
    // means header (measured at boot to set `--header-offset`) lands
    // at 0 and later-measured articles get Y > headerOffset.
    _ensureLayoutY() {
      if (!isVisibleNode(this)) return null;
      return this._layoutY ??= nextLayoutY();
    }
    getBoundingClientRect() {
      const y = this._ensureLayoutY();
      return y == null ? new globalThis.DOMRect(0, 0, 0, 0) : new globalThis.DOMRect(0, y, 1, 1);
    }
    getClientRects() {
      const y = this._ensureLayoutY();
      return y == null ? [] : [new globalThis.DOMRect(0, y, 1, 1)];
    }
    // CSSOM-View Level 5: returns false when the element is invisible
    // (display:none, hidden attr, etc). `opts.checkVisibilityCSS` /
    // `checkOpacity` are nuances we don't model — defer to the same
    // visibility predicate as `isVisibleNode`.
    checkVisibility(_opts) {
      return isVisibleNode(this);
    }
    // Web Animations API stub: returns a no-op Animation-shaped object.
    // Tailwind transitions / motion-one feature-probe `el.animate?.`
    // and bail to a CSS class fallback when it's absent; returning a
    // resolved-shape stub keeps the JS-side animate branch alive.
    animate(_keyframes, _options) {
      const anim = {
        playState: "finished",
        finished: Promise.resolve(this),
        ready: Promise.resolve(this),
        cancel() {
        },
        finish() {
        },
        pause() {
        },
        play() {
        },
        reverse() {
        },
        addEventListener() {
        },
        removeEventListener() {
        },
        dispatchEvent() {
          return true;
        }
      };
      return anim;
    }
    getAnimations(_opts) {
      return [];
    }
    get offsetWidth() {
      return isVisibleNode(this) ? 1 : 0;
    }
    get offsetHeight() {
      return isVisibleNode(this) ? 1 : 0;
    }
    get clientWidth() {
      return isVisibleNode(this) ? 1 : 0;
    }
    get clientHeight() {
      return isVisibleNode(this) ? 1 : 0;
    }
    get scrollWidth() {
      return isVisibleNode(this) ? 1 : 0;
    }
    // Approximate scrollHeight as 20px/line over 80 chars/line so
    // content-length gates fire. Avo's Trix body checks
    // `scrollHeight > some-threshold` to decide whether to inject the
    // "More content" expander; a flat `1` keeps it from ever rendering.
    // Counts element children only (whitespace text nodes between
    // formatted HTML would otherwise inflate the count and trip the
    // gate on short content).
    get scrollHeight() {
      if (!isVisibleNode(this)) return 0;
      const txt = (this.textContent || "").length;
      const kids = this.children ? this.children.length : 0;
      if (txt === 0 && kids === 0) return 0;
      return Math.max(Math.ceil(txt / 80) * 20, kids * 20);
    }
    get offsetTop() {
      return 0;
    }
    get offsetLeft() {
      return 0;
    }
    get offsetParent() {
      return this._parent && this._parent.nodeType === NODE_ELEMENT ? this._parent : null;
    }
    // Per-element scroll state. Real browsers store scroll offsets on
    // every scrollable box; without a layout engine we can't know which
    // boxes are actually scrollable, so we just remember whatever a
    // caller stored. Discourse's RouteScrollManager saves
    // `scrollingElement.scrollTop` on routeWillChange and restores it on
    // routeDidChange — the restore is `scrollingElement.scrollTo(left,
    // top)`, so a no-op scroll setter loses the saved position and the
    // `page.go_back` scroll-restore assertion fails.
    get scrollTop() {
      return this._scrollTop || 0;
    }
    set scrollTop(v) {
      const next = Number(v) || 0;
      if (next === (this._scrollTop || 0)) return;
      this._scrollTop = next;
      __notifyScroll(this);
    }
    get scrollLeft() {
      return this._scrollLeft || 0;
    }
    set scrollLeft(v) {
      const next = Number(v) || 0;
      if (next === (this._scrollLeft || 0)) return;
      this._scrollLeft = next;
      __notifyScroll(this);
    }
    // scrollIntoView({behavior, block, inline}) — without layout we
    // can't actually scroll, but the user-scroll signal is what
    // DLoadMore-style pagination sentinels gate on. Update the document
    // scrolling element's scrollTop to the target's monotonic Y so
    // `window.scrollY > 0` after a programmatic scrollIntoView (Ember's
    // route-scroll-manager service saves/restores this between routes).
    scrollIntoView(_opts) {
      const y = this._ensureLayoutY();
      const root = globalThis.document && globalThis.document.documentElement;
      if (root && typeof y === "number") {
        root._scrollTop = y;
      }
      __notifyScroll(this);
    }
    scrollIntoViewIfNeeded(_opts) {
      this.scrollIntoView(_opts);
    }
    scrollTo() {
      const [x, y] = __scrollArgsToXY(arguments);
      let changed = false;
      if (typeof x === "number" && x !== (this._scrollLeft || 0)) {
        this._scrollLeft = x;
        changed = true;
      }
      if (typeof y === "number" && y !== (this._scrollTop || 0)) {
        this._scrollTop = y;
        changed = true;
      }
      if (changed) __notifyScroll(this);
    }
    scrollBy() {
      const [dx, dy] = __scrollArgsToXY(arguments);
      let changed = false;
      if (typeof dx === "number" && dx !== 0) {
        this._scrollLeft = (this._scrollLeft || 0) + dx;
        changed = true;
      }
      if (typeof dy === "number" && dy !== 0) {
        this._scrollTop = (this._scrollTop || 0) + dy;
        changed = true;
      }
      if (changed) __notifyScroll(this);
    }
    // DOM Node bitmask (https://dom.spec.whatwg.org/#dom-node-comparedocumentposition):
    // DISCONNECTED=1, PRECEDING=2, FOLLOWING=4, CONTAINS=8,
    // CONTAINED_BY=16, IMPLEMENTATION_SPECIFIC=32. Stimulus / Sizzle /
    // various libs use this for document-order sorting; idiomorph reads
    // the CONTAINS / CONTAINED_BY bits for ancestor relationships.
    compareDocumentPosition(other) {
      if (other === this) return 0;
      const DISCONNECTED = 1, PRECEDING = 2, FOLLOWING = 4, CONTAINS = 8, CONTAINED_BY = 16, IMPLEMENTATION_SPECIFIC = 32;
      for (let n = this._parent; n; n = n._parent) {
        if (n === other) return CONTAINS | PRECEDING;
      }
      for (let n = other._parent; n; n = n._parent) {
        if (n === this) return CONTAINED_BY | FOLLOWING;
      }
      const cmp = compareDocOrder(this, other);
      if (cmp < 0) return FOLLOWING;
      if (cmp > 0) return PRECEDING;
      const dir = __nodeOrdinal(this) < __nodeOrdinal(other) ? FOLLOWING : PRECEDING;
      return DISCONNECTED | IMPLEMENTATION_SPECIFIC | dir;
    }
    cloneNode(deep) {
      const copy = this._cloneShell();
      if (deep && this._children) {
        for (const c of this._children) {
          const cc = c.cloneNode(true);
          cc._parent = copy;
          copy._children.push(cc);
        }
        if (copy.nodeType === NODE_DOC) {
          for (const c of copy._children) walkSubtree(c, (n) => {
            n._ownerDoc = copy;
          });
        }
      }
      if (deep && this.nodeType === NODE_ELEMENT && this._tag === "template" && this._templateContent) {
        const frag = new DocumentFragment();
        for (const c of this._templateContent._children) {
          const cc = c.cloneNode(true);
          cc._parent = frag;
          frag._children.push(cc);
        }
        copy._templateContent = frag;
      }
      if (this.nodeType === NODE_ELEMENT && this._shadowRoot && this._shadowRoot.clonable) {
        const src = this._shadowRoot;
        const sr = copy.attachShadow({ mode: src.mode, slotAssignment: src.slotAssignment, clonable: true });
        for (const c of src._children) {
          const cc = c.cloneNode(true);
          cc._parent = sr;
          sr._children.push(cc);
        }
      }
      return copy;
    }
    _cloneShell() {
      return new this.constructor();
    }
    get parentNode() {
      return this._parent;
    }
    get parentElement() {
      return this._parent && this._parent.nodeType === NODE_ELEMENT ? this._parent : null;
    }
    // `Node.isConnected` — true iff this node's root is its owner
    // document (i.e. it's attached to the live tree). Turbo's
    // `dispatch` helper checks `target.isConnected` before
    // `target.dispatchEvent(event)` and falls back to
    // `document.documentElement.dispatchEvent(event)` when false — so
    // a missing `isConnected` getter makes every dispatched event's
    // `target` resolve to `<html>`, which breaks `clickEventIsSignificant`
    // (`element.closest("turbo-frame, html") == this.element` is no
    // longer the link's html-ancestor relationship). Frame-redirect
    // for link clicks with `data-turbo-frame` stops working.
    get isConnected() {
      return isConnected(this);
    }
    // `Node.normalize()` per DOM spec — merge adjacent exclusive-Text
    // children (concatenating their data), drop empty Text nodes, then
    // recurse into element children. Sanitizers / contenteditable
    // reconcilers call it to coalesce text runs after repeated edits.
    normalize() {
      const kids = this._children;
      for (let i = 0; i < kids.length; i++) {
        const node = kids[i];
        if (node.nodeType === NODE_TEXT) {
          if ((node._data || "").length === 0) {
            const ep = i > 0 ? kids[i - 1] : null;
            const en = i + 1 < kids.length ? kids[i + 1] : null;
            kids.splice(i, 1);
            node._parent = null;
            unregisterSubtree(node);
            recordChildList(this, [], [node], ep, en);
            i--;
            continue;
          }
          let next = kids[i + 1];
          while (next && next.nodeType === NODE_TEXT) {
            const prev = node._data || "";
            node._data = prev + (next._data || "");
            recordCharacterData(node, prev);
            const removedNext = kids[i + 2] || null;
            kids.splice(i + 1, 1);
            next._parent = null;
            unregisterSubtree(next);
            recordChildList(this, [], [next], node, removedNext);
            next = kids[i + 1];
          }
        } else if (node.nodeType === NODE_ELEMENT) {
          node.normalize();
        }
      }
    }
    // https://dom.spec.whatwg.org/#dom-node-lookupnamespaceuri
    lookupNamespaceURI(prefix) {
      return locateNamespace(this, prefix == null || prefix === "" ? null : String(prefix));
    }
    // https://dom.spec.whatwg.org/#dom-node-isdefaultnamespace
    isDefaultNamespace(namespace) {
      const want = namespace == null || namespace === "" ? null : String(namespace);
      return locateNamespace(this, null) === want;
    }
    // https://dom.spec.whatwg.org/#dom-node-lookupprefix
    lookupPrefix(namespace) {
      if (namespace == null || namespace === "") return null;
      const ns = String(namespace);
      for (let el = this.nodeType === NODE_ELEMENT ? this : this.nodeType === NODE_DOC ? this.documentElement : this._parent && this._parent.nodeType === NODE_ELEMENT ? this._parent : null; el; el = el._parent && el._parent.nodeType === NODE_ELEMENT ? el._parent : null) {
        if (el._ns === ns && el._prefix != null) return el._prefix;
        if (el._attrNS) {
          for (const key in el._attrNS) {
            const meta = el._attrNS[key];
            if (meta.ns === XMLNS_NS2 && meta.prefix === "xmlns" && el._attrs[key] === ns) return meta.localName;
          }
        }
      }
      return null;
    }
    get firstChild() {
      return this._children[0] || null;
    }
    get lastChild() {
      return this._children[this._children.length - 1] || null;
    }
    // Live + cached NodeList: `_children` IS a NodeList, so return it directly
    // (per spec childNodes is a live, identity-stable collection). Internal code
    // mutates `_children` in place, so held childNodes references stay current.
    get childNodes() {
      return this._children;
    }
    hasChildNodes() {
      return this._children.length > 0;
    }
    // `Node.baseURI` — the node document's document base URL, honouring the
    // first `<base href>` element (falling back to the document URL). Document
    // overrides to resolve against itself.
    get baseURI() {
      const d = this.ownerDocument;
      if (d && d !== this) return documentBaseURL(d);
      return globalThis.location && globalThis.location.href || "about:blank";
    }
    // `Node.contains(other)` — true if other is inclusively `this` or
    // descendant. Per DOM spec lives on Node (Document inherits).
    // jQuery 3.x's `isAttached(elem)` calls
    // `jQuery.contains(elem.ownerDocument, elem)`, and jQuery.contains
    // internally calls `document.contains(elem)`; without the method
    // on Document the isHidden path threw and `.toggle()` mis-decided
    // its direction (always hide).
    contains(other) {
      let cur = other;
      while (cur) {
        if (cur === this) return true;
        cur = cur._parent;
      }
      return false;
    }
    // `form.submit()` — programmatic form submission. Per HTML spec
    // this does NOT fire a `submit` event (selenium-mode submit-via-
    // button fires submit; programmatic skips it; memory
    // `feedback_form_submit_spec_compliance`). We can't return out
    // through the synchronous JS call stack here, so we stash the
    // intent on a global slot that the outer click-resolver picks up
    // (Rails-UJS data-method/data-confirm chain ends in form.submit
    // inside the click handler; the Ruby side reads the intent after
    // dispatch and routes through the normal POST/GET form-submit
    // path). Direct callers (Capybara `Node#submit`) hit the host
    // fn instead.
    submit() {
      if (this._tag !== "form") return;
      globalThis.__csimPendingFormSubmit = { form: this, submitter: null };
    }
    requestSubmit(submitter) {
      if (this._tag !== "form") return;
      const ev = new SubmitEvent("submit", { bubbles: true, cancelable: true, submitter: submitter || null });
      dispatchEvent(this, ev);
      if (ev.defaultPrevented) return;
      globalThis.__csimPendingFormSubmit = { form: this, submitter: submitter || null };
    }
    // `el.click()` — programmatic synthetic click. jstoolbar dispatches
    // its keyboard-shortcut handlers via
    // `this.toolbar.querySelector('.jstb_strong').click()`, jQuery
    // form submission triggers `form[0].click()` on hidden submit
    // buttons, and Rails-UJS uses it to retrigger confirmed actions.
    // Per HTML spec the synthetic click is the same shape as a real
    // primary-button mouse click; we fire `click` directly (skipping
    // mousedown / mouseup because those are pointer-only). When the
    // synthetic click lands on a submit-shaped input/button inside a
    // form, we also fire the form's submit event and record the
    // submit intent so the outer click resolver can route the
    // navigation through Ruby's form-submit path — Rails-UJS's
    // data-method handler builds a hidden form, then calls
    // `form.querySelector('[type="submit"]').click()` to trigger
    // navigation, so without this step the form sits attached but
    // never submits.
    click() {
      if (isActuallyDisabled(this)) return;
      try {
        let isInputControl = false;
        let inputType = "";
        if (this._tag === "input") {
          inputType = (this._attrs.type || "").toLowerCase();
          isInputControl = inputType === "checkbox" || inputType === "radio";
        }
        const wasChecked = isInputControl ? this._attrs.checked != null : null;
        const prevCheckedRadio = inputType === "radio" ? checkedRadioInGroup(this) : null;
        if (isInputControl) {
          if (inputType === "checkbox") toggleChecked(this);
          else setRadio(this);
        }
        const ev = new MouseEvent("click", { bubbles: true, cancelable: true, composed: true, button: 0, which: 1 });
        ev._csimActivationHandled = true;
        dispatchEvent(this, ev);
        if (ev.defaultPrevented && isInputControl) {
          if (inputType === "radio") {
            delete this._attrs.checked;
            if (prevCheckedRadio) prevCheckedRadio._attrs.checked = "";
          } else if (wasChecked) this._attrs.checked = "";
          else delete this._attrs.checked;
        } else if (isInputControl && isConnected(this) && this._attrs.checked != null !== wasChecked) {
          try {
            dispatchEvent(this, new InputEvent("input", { bubbles: true, cancelable: true }));
          } catch (_) {
          }
          try {
            dispatchEvent(this, new Event("change", { bubbles: true, cancelable: false }));
          } catch (_) {
          }
        }
        let selfActivated = isInputControl && !ev.defaultPrevented;
        let didSubmit = false;
        if (!ev.defaultPrevented && isSubmitButton(this) && isConnected(this) && !isActuallyDisabled(this)) {
          const form = formForControl(this);
          if (form) {
            const submitEv = new SubmitEvent("submit", { bubbles: true, cancelable: true, submitter: this });
            dispatchEvent(form, submitEv);
            if (!submitEv.defaultPrevented) {
              globalThis.__csimPendingFormSubmit = { form, submitter: this };
              didSubmit = true;
              selfActivated = true;
            }
          }
        }
        if (!ev.defaultPrevented && (this._tag === "input" || this._tag === "button") && (this._attrs.type || "").toLowerCase() === "reset") {
          const form = formForControl(this);
          if (form && typeof form.reset === "function") {
            form.reset();
            selfActivated = true;
          }
        }
        if (!ev.defaultPrevented && this._tag === "summary") {
          let details = this._parent;
          while (details && details.nodeType === NODE_ELEMENT && details._tag !== "details") {
            details = details._parent;
          }
          if (details && details.nodeType === NODE_ELEMENT && details._tag === "details") {
            const oldOpen = details._attrs.open;
            if (oldOpen != null) delete details._attrs.open;
            else details._attrs.open = "";
            recordAttrMutation(details, "open", oldOpen == null ? null : oldOpen);
            try {
              dispatchEvent(details, new Event("toggle", { bubbles: false }));
            } catch (_) {
            }
            selfActivated = true;
          }
        }
        if (!ev.defaultPrevented && !selfActivated && this._tag !== "label" && !LABELABLE.has(this._tag) && !isInteractiveForLabel(this)) {
          const label = enclosingLabelFor(this);
          if (label) {
            const labeled = labeledControlFor(label);
            if (labeled && labeled !== this) {
              labeled.click();
              selfActivated = true;
            }
          }
        }
        if (!ev.defaultPrevented && !didSubmit && !selfActivated && (this._tag === "a" || this._tag === "area") && this._attrs.href != null && (this._attrs.href || "").trim() !== "" && !(this._attrs.href || "").toLowerCase().startsWith("javascript:")) {
          if (!fragmentNavigate(this)) {
            globalThis.__csimPendingNavigation = {
              url: String(this._attrs.href),
              target: this._attrs.target || ""
            };
          }
        }
      } catch (_) {
      }
    }
    // `Element.remove()` / `ChildNode.remove()` — detach this node from
    // its parent. Standard since DOM4; the table-paste Stimulus
    // controller walks pasted HTML and strips `<style>` / wrapping
    // nodes via `e.remove()` before formatting.
    remove() {
      if (this._parent) this._parent.removeChild(this);
    }
    // `ChildNode.before(...nodes)` / `after(...nodes)` / `replaceWith
    // (...nodes)` — convenience neighbours of `remove`. Pass strings or
    // nodes; strings become Text nodes. Stimulus / jQuery 3.x lean on
    // these for shorter swap-this-with-that idioms.
    before(...nodes) {
      const parent = this._parent;
      if (!parent) return;
      let ref = this.previousSibling;
      while (ref && nodes.indexOf(ref) !== -1) ref = ref.previousSibling;
      const node = convertNodesIntoNode(nodes);
      parent.insertBefore(node, ref ? ref.nextSibling : parent.firstChild);
    }
    after(...nodes) {
      const parent = this._parent;
      if (!parent) return;
      let ref = this.nextSibling;
      while (ref && nodes.indexOf(ref) !== -1) ref = ref.nextSibling;
      parent.insertBefore(convertNodesIntoNode(nodes), ref);
    }
    replaceWith(...nodes) {
      const parent = this._parent;
      if (!parent) return;
      let ref = this.nextSibling;
      while (ref && nodes.indexOf(ref) !== -1) ref = ref.nextSibling;
      const node = convertNodesIntoNode(nodes);
      if (this._parent === parent) {
        parent.insertBefore(node, this);
        parent.removeChild(this);
      } else parent.insertBefore(node, ref);
    }
    // `ParentNode.prepend(...nodes)` / `append(...nodes)` — the
    // sibling of `appendChild` that accepts strings + variadic args.
    prepend(...nodes) {
      this.insertBefore(convertNodesIntoNode(nodes), this._children[0] || null);
    }
    append(...nodes) {
      this.appendChild(convertNodesIntoNode(nodes));
    }
    // ParentNode.replaceChildren(...nodes) — DOM spec: clear then append.
    // React 19 / Stimulus controllers reach for it as the modern
    // shorthand instead of `el.innerHTML = ''` + appendChild.
    replaceChildren(...nodes) {
      const node = convertNodesIntoNode(nodes);
      ensurePreInsertionValidity(node, this, null);
      const isFrag = node && node.nodeType === NODE_FRAGMENT;
      const added = isFrag ? node._children.slice() : node ? [node] : [];
      const removed = this._children.slice();
      const wasConnected = isConnected(this);
      for (const c of removed) {
        c._parent = null;
        unregisterSubtree(c);
      }
      this._children = newChildList();
      for (const c of added) {
        if (c._parent && c._parent !== this && c._parent !== node) c._parent.removeChild(c);
        c._parent = this;
        this._children.push(c);
        registerSubtree(c);
        askForReset(c);
      }
      if (isFrag) node._children = newChildList();
      if (removed.length || added.length) recordChildList(this, added, removed);
      if (wasConnected) {
        for (const c of removed) fireCEDisconnect(c);
        for (const c of added) globalThis.__csimFireCEConnect(c);
      }
    }
    // `Element.children` is a LIVE HTMLCollection (not a plain Array): it carries
    // `item`/`namedItem` and the empty-name / named-getter semantics. The collection
    // object is cached per element (like real browsers) so repeated `.children`
    // access on a hot DOM-traversal path is O(1) and `el.children === el.children`;
    // its Proxy re-runs the element-filter query per settle generation, so it still
    // tracks the live tree after mutations.
    get children() {
      return this._childrenColl || (this._childrenColl = liveHTMLCollection(() => this._children.filter((c) => c.nodeType === NODE_ELEMENT)));
    }
    // ParentNode mixin: element-only child accessors. Hand-rolled
    // short-circuit walks rather than composing on `children` so
    // hot DOM-traversal callers don't pay an array allocation per
    // access just to read first / last / count.
    get firstElementChild() {
      for (const c of this._children) if (c.nodeType === NODE_ELEMENT) return c;
      return null;
    }
    get lastElementChild() {
      for (let i = this._children.length - 1; i >= 0; i--) {
        if (this._children[i].nodeType === NODE_ELEMENT) return this._children[i];
      }
      return null;
    }
    get childElementCount() {
      let n = 0;
      for (const c of this._children) if (c.nodeType === NODE_ELEMENT) n++;
      return n;
    }
    get nextSibling() {
      if (!this._parent) return null;
      const sibs = this._parent._children;
      const i = sibs.indexOf(this);
      return i >= 0 && i + 1 < sibs.length ? sibs[i + 1] : null;
    }
    get previousSibling() {
      if (!this._parent) return null;
      const sibs = this._parent._children;
      const i = sibs.indexOf(this);
      return i > 0 ? sibs[i - 1] : null;
    }
    // Skip non-element siblings (text / comment nodes). Standard DOM
    // API; libraries and css-select v7's `:first-child` /
    // `:nth-of-type` rely on these.
    get previousElementSibling() {
      if (!this._parent) return null;
      const sibs = this._parent._children;
      for (let i = sibs.indexOf(this) - 1; i >= 0; i--) {
        if (sibs[i].nodeType === NODE_ELEMENT) return sibs[i];
      }
      return null;
    }
    get nextElementSibling() {
      if (!this._parent) return null;
      const sibs = this._parent._children;
      for (let i = sibs.indexOf(this) + 1; i < sibs.length; i++) {
        if (sibs[i].nodeType === NODE_ELEMENT) return sibs[i];
      }
      return null;
    }
    // Move every child of `frag` into this before `ref` (null = append), per the
    // DOM "insert"/"remove" steps: the fragment's children are first removed (ONE
    // childList record on the fragment) then inserted (ONE record on this with all
    // of them as addedNodes) — not one record per child.
    _insertFragmentChildren(frag, ref) {
      const moved = frag._children.slice();
      if (!moved.length) return frag;
      for (const c of moved) c._parent = null;
      frag._children.length = 0;
      recordChildList(frag, [], moved, null, null);
      let idx = ref == null ? this._children.length : this._children.indexOf(ref);
      if (idx < 0) idx = this._children.length;
      const prevSib = idx > 0 ? this._children[idx - 1] : null;
      const nextSib = idx < this._children.length ? this._children[idx] : null;
      this._children.splice(idx, 0, ...moved);
      liveRangesOnInsert(this, idx, moved.length);
      const connected = isConnected(this);
      for (const c of moved) {
        c._parent = this;
        registerSubtree(c);
      }
      recordChildList(this, moved.slice(), [], prevSib, nextSib);
      if (this._tag === "script") globalThis.__csimScriptChildrenChanged(this);
      if (connected) for (const c of moved) globalThis.__csimFireCEConnect(c);
      for (const c of moved) askForReset(c);
      return frag;
    }
    // Replace `old` (a child of this) with `nodes` (already-detached nodes, e.g.
    // a parsed fragment's children) as a single DOM "replace": ONE childList
    // record on this with removedNodes = [old] and addedNodes = nodes — not a
    // remove plus separate inserts. Shared by the `outerHTML` setter and
    // replaceChild's DocumentFragment branch.
    _replaceChildWithNodes(old, nodes) {
      const i = this._children.indexOf(old);
      if (i < 0) return;
      const wasConnected = isConnected(this);
      const prevSib = i > 0 ? this._children[i - 1] : null;
      const nextSib = i + 1 < this._children.length ? this._children[i + 1] : null;
      for (const c of nodes) adoptIntoParent(this, c);
      liveRangesOnRemove(this, old, i);
      old._parent = null;
      unregisterSubtree(old);
      this._children.splice(i, 1, ...nodes);
      liveRangesOnInsert(this, i, nodes.length);
      for (const c of nodes) {
        c._parent = this;
        registerSubtree(c);
      }
      recordChildList(this, nodes.slice(), [old], prevSib, nextSib);
      if (wasConnected) {
        fireCEDisconnect(old);
        for (const c of nodes) globalThis.__csimFireCEConnect(c);
      }
      for (const c of nodes) askForReset(c);
    }
    appendChild(child) {
      assertNodeArg(child);
      ensurePreInsertionValidity(child, this, null);
      if (child && child.nodeType === NODE_FRAGMENT) return this._insertFragmentChildren(child, null);
      adoptIntoParent(this, child);
      child._parent = this;
      const insertIndex = this._children.length;
      this._children.push(child);
      liveRangesOnInsert(this, insertIndex, 1);
      registerSubtree(child);
      recordChildList(this, [child], []);
      if (this._tag === "script") globalThis.__csimScriptChildrenChanged(this);
      if (isConnected(this)) globalThis.__csimFireCEConnect(child);
      askForReset(child);
      return child;
    }
    removeChild(child) {
      assertNodeArg(child);
      if (child._parent !== this) {
        throw new globalThis.DOMException(
          "The node to be removed is not a child of this node.",
          "NotFoundError"
        );
      }
      const i = this._children.indexOf(child);
      if (i < 0) return null;
      const prevSib = i > 0 ? this._children[i - 1] : null;
      const nextSib = i + 1 < this._children.length ? this._children[i + 1] : null;
      const wasConnected = isConnected(this);
      nodeIteratorPreRemove(child);
      liveRangesOnRemove(this, child, i);
      this._children.splice(i, 1);
      child._parent = null;
      unregisterSubtree(child);
      const doc = globalThis.document;
      const ae = doc && doc._activeElement;
      if (ae && (ae === child || nodeContains(child, ae))) doc._activeElement = null;
      recordChildList(this, [], [child], prevSib, nextSib);
      if (wasConnected) fireCEDisconnect(child);
      return child;
    }
    insertBefore(child, ref) {
      if (arguments.length < 2) {
        throw new TypeError("Failed to execute 'insertBefore': 2 arguments required");
      }
      assertNodeArg(child);
      if (ref != null) assertNodeArg(ref);
      ensurePreInsertionValidity(child, this, ref);
      if (ref === child) ref = child.nextSibling;
      if (ref == null) return this.appendChild(child);
      if (child && child.nodeType === NODE_FRAGMENT) return this._insertFragmentChildren(child, ref);
      adoptIntoParent(this, child);
      const i = this._children.indexOf(ref);
      if (i < 0) return this.appendChild(child);
      child._parent = this;
      this._children.splice(i, 0, child);
      liveRangesOnInsert(this, i, 1);
      registerSubtree(child);
      recordChildList(this, [child], []);
      if (this._tag === "script") globalThis.__csimScriptChildrenChanged(this);
      if (isConnected(this)) globalThis.__csimFireCEConnect(child);
      askForReset(child);
      return child;
    }
    replaceChild(neu, old) {
      assertNodeArg(neu);
      assertNodeArg(old);
      validateInsertion(neu, this, old, true);
      const i = this._children.indexOf(old);
      if (i < 0) return null;
      if (neu === old) {
        const ref = old.nextSibling;
        this.removeChild(old);
        this.insertBefore(neu, ref);
        return old;
      }
      if (neu.nodeType === NODE_FRAGMENT) {
        const moved = neu._children.slice();
        for (const c of moved) c._parent = null;
        neu._children.length = 0;
        if (moved.length) recordChildList(neu, [], moved, null, null);
        this._replaceChildWithNodes(old, moved);
        return old;
      }
      const wasConnected = isConnected(this);
      adoptIntoParent(this, neu);
      const j = this._children.indexOf(old);
      liveRangesOnRemove(this, old, j);
      neu._parent = this;
      old._parent = null;
      this._children[j] = neu;
      liveRangesOnInsert(this, j, 1);
      unregisterSubtree(old);
      registerSubtree(neu);
      recordChildList(this, [neu], [old]);
      if (wasConnected) {
        fireCEDisconnect(old);
        globalThis.__csimFireCEConnect(neu);
      }
      askForReset(neu);
      return old;
    }
    // textContent collects descendant text; setter replaces children
    // with a single text node.
    get textContent() {
      let s = "";
      for (const c of this._children) {
        if (c.nodeType === NODE_TEXT || c.nodeType === NODE_CDATA) s += c.data;
        else if (c.nodeType === NODE_ELEMENT) s += c.textContent;
      }
      return s;
    }
    set textContent(v) {
      const removed = this._children.slice();
      for (const c of removed) c._parent = null;
      this._children = newChildList();
      const text = String(v == null ? "" : v);
      const added = [];
      if (text.length > 0) {
        const t = new Text(text);
        t._parent = this;
        this._children.push(t);
        added.push(t);
      }
      if (removed.length > 0 || added.length > 0) {
        recordChildList(this, added, removed);
      }
    }
    // `innerText` is the "as rendered" sibling of textContent — line
    // breaks from `<br>` / block boundaries, whitespace collapsed,
    // visibility-aware. Without a layout engine we can't compute the
    // rendered form, so we fall back to textContent — what Chromium
    // does anyway for detached / not-being-rendered subtrees per spec
    // note. Critical because Redmine's jstoolbar builds its Edit /
    // Preview tabs via `link.innerText = tabName`, and without the
    // setter the tabs end up empty and `click_link 'Preview'` fails.
    get innerText() {
      return this.textContent;
    }
    set innerText(v) {
      this.textContent = v;
    }
  };
  Object.defineProperty(Node.prototype, "__csimIsNode", { value: true });
  function isNodeArg(x) {
    return x != null && x.__csimIsNode === true;
  }
  __name(isNodeArg, "isNodeArg");
  var CharacterData = class extends Node {
    static {
      __name(this, "CharacterData");
    }
    constructor(data) {
      super();
      this._data = data === void 0 ? "" : String(data);
    }
    get data() {
      return this._data;
    }
    // Spec: every write to a Text node's `data` (or `nodeValue` /
    // `textContent`, which proxy through here) queues a
    // `characterData` mutation record. ProseMirror/Tiptap's
    // `domchange` reconciler reads these to map browser-side text
    // edits back into a transaction; without the record, our
    // `set("text")` on contenteditable updates the DOM but PM
    // silently skips the model update and `onUpdate` never fires.
    // `data` is `[LegacyNullToEmptyString] DOMString`: null → "", but undefined
    // → "undefined". nodeValue / textContent are nullable, so both null AND
    // undefined → "". Each coerces, then routes through `_setData`.
    set data(v) {
      this._setData(v === null ? "" : String(v));
    }
    get nodeValue() {
      return this.data;
    }
    set nodeValue(v) {
      this._setData(v == null ? "" : String(v));
    }
    get textContent() {
      return this.data;
    }
    set textContent(v) {
      this._setData(v == null ? "" : String(v));
    }
    _setData(next) {
      const prev = this._data;
      liveRangesOnReplaceData(this, 0, prev.length, next.length);
      if (prev === next) return;
      this._data = next;
      recordCharacterData(this, prev);
    }
    // prefix/namespaceURI/localName are NOT exposed on CharacterData: per DOM they
    // are IDL members of Element and Attr only, so `'localName' in textNode` must
    // be false (dom/historical.html). The XPath adapter coerces the resulting
    // undefined back to null for these nodes (see xpath.js).
    get ownerDocument() {
      return this._ownerDoc || globalThis.document;
    }
    // Layout stubs — Text nodes implement getClientRects/getBoundingClientRect
    // too (browsers wrap each line in a rect; we don't lay out, so
    // empty/zero-rect responses are the closest spec-shaped fallback).
    // PM's domchange calls getClientRects on changed text nodes to
    // decide whether to bail on certain CSS-cursor edge cases; without
    // these methods PM's flush throws and never delivers the
    // transaction.
    getClientRects() {
      return [];
    }
    getBoundingClientRect() {
      return new globalThis.DOMRect(0, 0, 0, 0);
    }
    // CharacterData methods (https://dom.spec.whatwg.org/#interface-characterdata).
    // All offsets/counts are UTF-16 code units (JS string indexing), coerced to
    // unsigned long; the shared replace step clamps count and queues the
    // characterData mutation record.
    get length() {
      return this._data.length;
    }
    substringData(offset, count) {
      if (arguments.length < 2) throw new TypeError("Failed to execute 'substringData': 2 arguments required.");
      offset = offset >>> 0;
      count = count >>> 0;
      const len = this._data.length;
      if (offset > len) throw new globalThis.DOMException("The offset is greater than the data length.", "IndexSizeError");
      return this._data.slice(offset, offset + count);
    }
    appendData(data) {
      if (arguments.length < 1) throw new TypeError("Failed to execute 'appendData': 1 argument required.");
      this._replaceData(this._data.length, 0, data);
    }
    insertData(offset, data) {
      if (arguments.length < 2) throw new TypeError("Failed to execute 'insertData': 2 arguments required.");
      this._replaceData(offset, 0, data);
    }
    deleteData(offset, count) {
      if (arguments.length < 2) throw new TypeError("Failed to execute 'deleteData': 2 arguments required.");
      this._replaceData(offset, count, "");
    }
    replaceData(offset, count, data) {
      if (arguments.length < 3) throw new TypeError("Failed to execute 'replaceData': 3 arguments required.");
      this._replaceData(offset, count, data);
    }
    _replaceData(offset, count, data) {
      offset = offset >>> 0;
      count = count >>> 0;
      const prev = this._data;
      const len = prev.length;
      if (offset > len) throw new globalThis.DOMException("The offset is greater than the data length.", "IndexSizeError");
      if (offset + count > len) count = len - offset;
      const str = String(data);
      liveRangesOnReplaceData(this, offset, count, str.length);
      this._data = prev.slice(0, offset) + str + prev.slice(offset + count);
      recordCharacterData(this, prev);
    }
  };
  globalThis.CharacterData = CharacterData;
  var Text = class _Text extends CharacterData {
    static {
      __name(this, "Text");
    }
    constructor(data) {
      super(data);
      this.nodeType = NODE_TEXT;
    }
    get nodeName() {
      return "#text";
    }
    // Slottable mixin (Text + Element only — not Comment / ProcessingInstruction):
    // the slot this text node is assigned to in an open shadow tree.
    get assignedSlot() {
      return findSlotForSlottable(this, true);
    }
    _cloneShell() {
      return new _Text(this._data);
    }
    // Per DOM spec: split this text node into two at `offset`, keep the
    // prefix in `this`, return a new Text sibling holding the suffix
    // and inserted into the parent right after `this`. Discourse's
    // `HighlightedSearch` modifier calls splitText to wrap matched
    // substrings in `<span class="d-highlighted">`; without this, the
    // modifier throws and Glimmer aborts the rest of the modifier
    // install chain on that template (including `{{on "click"}}` on
    // search-result anchors).
    splitText(offset) {
      offset = offset >>> 0;
      const len = this._data.length;
      if (offset > len) {
        throw new globalThis.DOMException("Index or size is negative or greater than the allowed amount", "IndexSizeError");
      }
      const count = len - offset;
      const newNode = new this.constructor(this._data.substring(offset));
      newNode._ownerDoc = this._ownerDoc;
      const parent = this._parent;
      if (parent) {
        const idx = parent._children.indexOf(this);
        parent._children.splice(idx + 1, 0, newNode);
        newNode._parent = parent;
        registerSubtree(newNode);
        recordChildList(parent, [newNode], []);
        liveRangesOnSplit(this, offset, newNode, parent, idx);
      }
      this._replaceData(offset, count, "");
      return newNode;
    }
    // DOM `Text.wholeText`: the concatenated data of this node and its contiguous
    // Text-node siblings (the run of adjacent Text / CDATASection nodes), in tree
    // order. A non-Text sibling — or no parent — bounds the run.
    get wholeText() {
      const parent = this._parent;
      if (!parent || !parent._children) return this._data;
      const kids = parent._children;
      const isTextLike = /* @__PURE__ */ __name((n) => n && (n.nodeType === NODE_TEXT || n.nodeType === NODE_CDATA), "isTextLike");
      let start = kids.indexOf(this);
      if (start < 0) return this._data;
      while (start > 0 && isTextLike(kids[start - 1])) start--;
      let s = "";
      for (let j = start; j < kids.length && isTextLike(kids[j]); j++) s += kids[j]._data;
      return s;
    }
  };
  var Comment = class _Comment extends CharacterData {
    static {
      __name(this, "Comment");
    }
    constructor(data) {
      super(data);
      this.nodeType = NODE_COMMENT;
    }
    get nodeName() {
      return "#comment";
    }
    _cloneShell() {
      return new _Comment(this.data);
    }
  };
  globalThis.Comment = Comment;
  var CDATASection = class _CDATASection extends Text {
    static {
      __name(this, "CDATASection");
    }
    constructor(data) {
      super(data);
      this.nodeType = NODE_CDATA;
    }
    get nodeName() {
      return "#cdata-section";
    }
    _cloneShell() {
      return new _CDATASection(this.data);
    }
  };
  globalThis.CDATASection = CDATASection;
  function isXMLNameStartChar(c) {
    return c === 58 || c >= 65 && c <= 90 || c === 95 || c >= 97 && c <= 122 || c >= 192 && c <= 214 || c >= 216 && c <= 246 || c >= 248 && c <= 767 || c >= 880 && c <= 893 || c >= 895 && c <= 8191 || c >= 8204 && c <= 8205 || c >= 8304 && c <= 8591 || c >= 11264 && c <= 12271 || c >= 12289 && c <= 55295 || c >= 63744 && c <= 64975 || c >= 65008 && c <= 65533 || c >= 65536 && c <= 983039;
  }
  __name(isXMLNameStartChar, "isXMLNameStartChar");
  function isXMLNameChar(c) {
    return isXMLNameStartChar(c) || c === 45 || c === 46 || c >= 48 && c <= 57 || c === 183 || c >= 768 && c <= 879 || c >= 8255 && c <= 8256;
  }
  __name(isXMLNameChar, "isXMLNameChar");
  function isXMLName(s) {
    if (s.length === 0) return false;
    let first = true;
    for (const ch of s) {
      const c = ch.codePointAt(0);
      if (first) {
        if (!isXMLNameStartChar(c)) return false;
        first = false;
      } else if (!isXMLNameChar(c)) return false;
    }
    return true;
  }
  __name(isXMLName, "isXMLName");
  var ProcessingInstruction = class _ProcessingInstruction extends CharacterData {
    static {
      __name(this, "ProcessingInstruction");
    }
    constructor(target, data, ownerDoc) {
      super(data == null ? "" : String(data));
      this.nodeType = NODE_PI;
      this._target = String(target);
      this._ownerDoc = ownerDoc || null;
    }
    get target() {
      return this._target;
    }
    get nodeName() {
      return this._target;
    }
    get ownerDocument() {
      return this._ownerDoc || globalThis.document;
    }
    _cloneShell() {
      return new _ProcessingInstruction(this._target, this.data, this._ownerDoc);
    }
  };
  globalThis.ProcessingInstruction = ProcessingInstruction;
  var Attr = class _Attr extends Node {
    static {
      __name(this, "Attr");
    }
    constructor(localName, namespace, prefix, value, ownerDoc) {
      super();
      this.nodeType = NODE_ATTRIBUTE;
      this._localName = String(localName);
      this._ns = namespace == null ? null : String(namespace);
      this._prefix = prefix == null ? null : String(prefix);
      this._value = value == null ? "" : String(value);
      this._ownerElement = null;
      this._key = null;
      this._ownerDoc = ownerDoc || null;
    }
    get namespaceURI() {
      return this._ns;
    }
    get prefix() {
      return this._prefix;
    }
    get localName() {
      return this._localName;
    }
    get name() {
      return this._prefix ? this._prefix + ":" + this._localName : this._localName;
    }
    get nodeName() {
      return this.name;
    }
    get specified() {
      return true;
    }
    get ownerElement() {
      return this._ownerElement;
    }
    get ownerDocument() {
      return this._ownerDoc || globalThis.document;
    }
    get value() {
      const el = this._ownerElement;
      if (el && this._key != null && Object.prototype.hasOwnProperty.call(el._attrs, this._key)) {
        return el._attrs[this._key];
      }
      return this._value;
    }
    set value(v) {
      const s = String(v);
      const el = this._ownerElement;
      if (el && this._key != null) el._setAttrNodeValue(this._key, s);
      this._value = s;
    }
    get nodeValue() {
      return this.value;
    }
    set nodeValue(v) {
      this.value = v;
    }
    get textContent() {
      return this.value;
    }
    set textContent(v) {
      this.value = v;
    }
    _cloneShell() {
      return new _Attr(this._localName, this._ns, this._prefix, this.value, this._ownerDoc);
    }
  };
  globalThis.Attr = Attr;
  var DocumentType = class _DocumentType extends Node {
    static {
      __name(this, "DocumentType");
    }
    constructor(name, publicId, systemId, ownerDoc) {
      super();
      this.nodeType = NODE_DOCTYPE;
      this.name = String(name);
      this.publicId = String(publicId == null ? "" : publicId);
      this.systemId = String(systemId == null ? "" : systemId);
      this._ownerDoc = ownerDoc || null;
    }
    get nodeName() {
      return this.name;
    }
    get textContent() {
      return null;
    }
    set textContent(_) {
    }
    get ownerDocument() {
      return this._ownerDoc || globalThis.document;
    }
    _cloneShell() {
      return new _DocumentType(this.name, this.publicId, this.systemId, this._ownerDoc);
    }
  };
  globalThis.DocumentType = DocumentType;
  var HREF_REFLECTING_TAGS = /* @__PURE__ */ new Set(["a", "area", "link"]);
  var SRC_REFLECTING_TAGS = /* @__PURE__ */ new Set([
    "script",
    "img",
    "iframe",
    "frame",
    "embed",
    "source",
    "audio",
    "video",
    "track"
  ]);
  function firstBaseWithHref(doc) {
    const head = doc.head;
    if (!head || !head._children) return null;
    for (const c of head._children) {
      if (c.nodeType === NODE_ELEMENT && c._tag === "base" && c._attrs.href != null) return c;
    }
    return null;
  }
  __name(firstBaseWithHref, "firstBaseWithHref");
  function documentBaseURL(doc) {
    const fallback = doc && typeof doc.URL === "string" && doc.URL || globalThis.location && globalThis.location.href || "about:blank";
    if (!doc || !doc.documentElement) return fallback;
    const gen = currentSettleGen();
    const cache = doc.__baseUrlCache;
    if (cache && cache.gen === gen && cache.fallback === fallback) return cache.href;
    let href = fallback;
    const baseEl = firstBaseWithHref(doc);
    if (baseEl) {
      try {
        const u = globalThis.__csim_parseUrl(baseEl._attrs.href, fallback);
        if (u && !u.error && u.href) href = u.href;
      } catch (_) {
      }
    }
    doc.__baseUrlCache = { gen, fallback, href };
    return href;
  }
  __name(documentBaseURL, "documentBaseURL");
  function reflectURLAttr(el, name, tagSet) {
    if (!tagSet.has(el._tag)) return el._attrs[name];
    const v = el._attrs[name];
    if (v == null) return "";
    try {
      const base = documentBaseURL(el.ownerDocument);
      const u = globalThis.__csim_parseUrl(v, base);
      return u && !u.error ? u.href : v;
    } catch (_) {
      return v;
    }
  }
  __name(reflectURLAttr, "reflectURLAttr");
  var __layoutYSeq = 0;
  function nextLayoutY() {
    return __layoutYSeq++;
  }
  __name(nextLayoutY, "nextLayoutY");
  function resetLayoutY() {
    __layoutYSeq = 0;
  }
  __name(resetLayoutY, "resetLayoutY");
  var __FOCUSABLE_TAGS = /* @__PURE__ */ new Set(["input", "textarea", "select", "button", "iframe", "embed", "object", "audio", "video", "details", "summary"]);
  function isFocusable(n) {
    if (!n || n.nodeType !== NODE_ELEMENT) return false;
    if (n._attrs.disabled != null) return false;
    let candidate = false;
    if (n._attrs.tabindex != null) candidate = true;
    else {
      const t = n._tag;
      if (__FOCUSABLE_TAGS.has(t)) {
        if (t === "input" && (n._attrs.type || "").toLowerCase() === "hidden") return false;
        candidate = true;
      } else if ((t === "a" || t === "area") && n._attrs.href != null) {
        candidate = true;
      } else {
        const ce = n._attrs.contenteditable;
        if (ce != null && String(ce).toLowerCase() !== "false") candidate = true;
      }
    }
    if (!candidate) return false;
    return isLaidOutNode(n);
  }
  __name(isFocusable, "isFocusable");
  var Element = class _Element extends Node {
    static {
      __name(this, "Element");
    }
    constructor(tagName) {
      if (ceState.pendingUpgrade) {
        const target = ceState.pendingUpgrade;
        ceState.pendingUpgrade = null;
        try {
          Object.setPrototypeOf(target, new.target.prototype);
        } catch (_) {
        }
        return target;
      }
      super();
      this._tag = String(tagName || __currentTag || "").toLowerCase();
      this._attrs = {};
      this._ns = HTML_NS2;
      this._prefix = null;
      this._localName = this._tag;
      this._classesCache = null;
      this._classesCacheKey = null;
      this._isKey = null;
      this._isCache = null;
      this._declKey = null;
      this._declCache = null;
      this._vt = "";
      this._vtGen = -1;
      this._vtCV = -1;
      this._attrsColl = null;
      if (this._tag === "form") Object.setPrototypeOf(this, FormNamedProto);
    }
    _cloneShell() {
      const e = new _Element(this._tag);
      e._attrs = Object.assign({}, this._attrs);
      if (this._attrNS) e._attrNS = Object.assign({}, this._attrNS);
      e._ns = this._ns;
      e._prefix = this._prefix;
      e._localName = this._localName;
      if (this._tag === "script" && this._csimRan) e._csimRan = true;
      return e;
    }
    // tagName / nodeName: the qualified name, ASCII-uppercased only for an
    // HTML-namespace element whose node document is an HTML document (so an
    // element in an XML/XHTML iframe document keeps its case).
    get tagName() {
      const qn = this._prefix ? this._prefix + ":" + this._localName : this._localName;
      return this._ns === HTML_NS2 && isHtmlDocument(this.ownerDocument) ? asciiUpper(qn) : qn;
    }
    get nodeName() {
      return this.tagName;
    }
    get localName() {
      return this._localName;
    }
    // `.content` is tag-specific per HTML spec:
    //   - `<template>`: the inert `DocumentFragment` carrying the
    //     template's children. Lazy-initialised for templates created
    //     via `document.createElement`; the HTML parser pre-populates
    //     `_templateContent` when it encounters `<template>…</template>`.
    //     Readonly per IDL — the setter is a silent no-op.
    //   - `<meta>`: reflects the `content` attribute. Forem's
    //     `initializeBodyData.js` builds the csrf-token meta via
    //     `createElement('meta'); el.content = token; head.append(el)`,
    //     so without the setter the csrf wait loop never resolves and
    //     Preact never mounts.
    // Any other element treats `.content` as an own data property,
    // matching real-browser behaviour for tags without a `content`
    // IDL slot.
    get content() {
      if (this._tag === "template") {
        if (!this._templateContent) this._templateContent = new DocumentFragment();
        return this._templateContent;
      }
      if (this._tag === "meta") {
        const v = this._attrs["content"];
        return v == null ? "" : v;
      }
      return void 0;
    }
    set content(v) {
      if (this._tag === "template") return;
      if (this._tag === "meta") {
        this.setAttribute("content", v == null ? "" : String(v));
        return;
      }
      Object.defineProperty(this, "content", { value: v, writable: true, configurable: true, enumerable: true });
    }
    // `HTMLStyleElement.sheet` — the CSSStyleSheet associated with a connected
    // `<style>` (CSSOM). It exists once the element is in a document and reflects
    // the element's current text content, so an earlier-inserted script can
    // observe a later-inserted `<style>` already applied (cssRules track the text
    // live). Disconnected → null; `<link>` sheets (which need the fetched
    // resource) are not modelled here. Created lazily and cached for stable identity.
    get sheet() {
      if (this._tag === "style") {
        if (!this.isConnected) {
          this._sheet = null;
          return null;
        }
        const type = (this._attrs.type || "").toLowerCase();
        if (type && type !== "text/css") {
          this._sheet = null;
          return null;
        }
        if (!this._sheet) {
          this._sheet = new globalThis.CSSStyleSheet();
          this._sheet.ownerNode = this;
        }
        this._sheet.replaceSync(this.textContent || "");
        return this._sheet;
      }
      if (this._tag === "link") {
        const rel = (this._attrs.rel || "").toLowerCase().split(/\s+/);
        const href = this._attrs.href;
        if (!this.isConnected || !rel.includes("stylesheet") || !href) {
          this._sheet = null;
          return null;
        }
        if (!this._sheet) {
          this._sheet = new globalThis.CSSStyleSheet();
          this._sheet.ownerNode = this;
          this._sheet.href = href;
          let css = "";
          const dataCss = /^data:text\/css[^,]*,(.*)$/is.exec(href);
          if (dataCss) {
            try {
              css = decodeURIComponent(dataCss[1]);
            } catch (_) {
              css = dataCss[1];
            }
          } else {
            try {
              css = globalThis.__csimExternalAsset(href) || "";
            } catch (_) {
            }
          }
          this._sheet.replaceSync(css);
        }
        return this._sheet;
      }
      return void 0;
    }
    // `<dialog>` HTML interface — show() / showModal() / close() per
    // HTMLDialogElement. Turbo's confirm flow uses this: opens
    // `<dialog id="turbo-confirm">` via `showModal()`, waits for the
    // `close` event, reads `returnValue`. The `<form method="dialog">`
    // submit path in `globalThis.__csimClickResolve` is the close trigger; show
    // simply flips the `open` attribute (no real layout / focus
    // trapping — Capybara just queries the visible-by-attribute
    // descendants and that suffices).
    show() {
      if (this._tag !== "dialog") return;
      this.setAttribute("open", "");
    }
    showModal() {
      if (this._tag !== "dialog") return;
      this.setAttribute("open", "");
    }
    close(returnValue) {
      if (this._tag !== "dialog") return;
      closeDialog(this, returnValue);
    }
    // `<iframe>` / `<frame>` nested browsing context — a same-realm nested
    // Document parsed from srcdoc / src (lazily, via the bridge frame loader).
    // contentWindow.DOMException etc. resolve to the shared globals, so
    // `instanceof` across the frame boundary works. Non-frame tags get null.
    get contentWindow() {
      if (this._tag !== "iframe" && this._tag !== "frame") return null;
      return globalThis.__csimFrameWindow ? globalThis.__csimFrameWindow(this) : null;
    }
    get contentDocument() {
      const w = this.contentWindow;
      return w ? w.document : null;
    }
    // Report the XHTML namespace per HTML spec. The XPath engine scopes
    // unprefixed element name tests to the XHTML namespace in HTML
    // documents, so reporting it explicitly keeps `//*` and `//div`
    // queries working. Also required for DOMPurify's `_checkValidNamespace`
    // to keep elements (Trix's HTMLSanitizer wipes the body
    // without it).
    get prefix() {
      return this._prefix;
    }
    get namespaceURI() {
      return this._ns;
    }
    get ownerDocument() {
      return this._ownerDoc || globalThis.document;
    }
    getAttribute(name) {
      const v = this._attrs[attrKey(this, name)];
      if (v != null) return v;
      if (this._attrNS) {
        const k = firstAttrKeyByQName(this, name);
        if (k != null) return this._attrs[k];
      }
      return null;
    }
    setAttribute(name, value) {
      const qn = String(name);
      if (!isValidAttributeLocalName(qn)) {
        throw new globalThis.DOMException("'" + qn + "' is not a valid attribute name.", "InvalidCharacterError");
      }
      let n = attrKey(this, qn);
      if (this._attrNS && !Object.prototype.hasOwnProperty.call(this._attrs, n)) {
        n = firstAttrKeyByQName(this, qn) || n;
      }
      const old = this._attrs[n];
      const next = String(value);
      this._attrs[n] = next;
      if ((n === "id" || n === "name") && next) registerNamedAccess(this, n, next);
      if ((n === "src" || n === "srcdoc") && (this._tag === "iframe" || this._tag === "frame") && old !== next) {
        const oldRealmId = this._frameRealmId;
        this._frameWindow = null;
        this._frameRealmId = null;
        if (oldRealmId != null) {
          if (globalThis.__csimChildRealmIds) globalThis.__csimChildRealmIds.delete(oldRealmId);
          if (globalThis.__csim_disposeFrameRealm) globalThis.__csim_disposeFrameRealm(oldRealmId);
        }
        this._frameLoadFired = false;
        if (isConnected(this) && globalThis.__csim_onFrameSrcAssigned) globalThis.__csim_onFrameSrcAssigned(this);
      }
      if (this._tag === "body" || this._tag === "frameset") {
        const evt = windowForwardedHandlerName(n);
        if (evt) activateWindowForwardedHandler(evt, next);
      }
      recordAttrMutation(this, n, old == null ? null : old);
      if (old !== next) fireAttrChangedCallback(this, n, old == null ? null : old, next);
    }
    // Namespaced attributes: validate-and-extract the (namespace, prefix,
    // localName), key the flat store on the qualified name, and remember the
    // namespace metadata in `_attrNS` (sparse — only namespaced/prefixed attrs).
    // getAttributeNS / hasAttributeNS / removeAttributeNS match on
    // (namespace, localName), case-sensitively, per spec.
    setAttributeNS(namespace, qualifiedName, value) {
      const ns = namespace == null ? null : String(namespace);
      const { namespace: rns, prefix, localName } = validateAndExtract(ns, String(qualifiedName), "attribute");
      const qn = prefix ? prefix + ":" + localName : localName;
      const existing = this._attrKeyByNS(rns, localName);
      const key = existing != null ? existing : freshAttrKey(this, qn);
      const old = this._attrs[key];
      const next = String(value);
      this._attrs[key] = next;
      if (rns === null && (localName === "id" || localName === "name") && next) registerNamedAccess(this, localName, next);
      if (rns !== null || prefix !== null || key !== qn) {
        (this._attrNS || (this._attrNS = {}))[key] = { ns: rns, prefix, localName };
      } else if (this._attrNS) {
        delete this._attrNS[key];
      }
      recordAttrMutation(this, key, old == null ? null : old);
      if (old !== next) fireAttrChangedCallback(this, key, old == null ? null : old, next);
    }
    // The stored key of the attribute matching (namespace, localName), or null.
    _attrKeyByNS(ns, localName) {
      const wantNs = ns === "" ? null : ns;
      if (!this._attrNS) {
        return wantNs === null && Object.prototype.hasOwnProperty.call(this._attrs, localName) ? localName : null;
      }
      for (const key in this._attrs) {
        const meta = this._attrNS && this._attrNS[key];
        const aNs = meta ? meta.ns : null;
        const aLn = meta ? meta.localName : key;
        if (aNs === wantNs && aLn === localName) return key;
      }
      return null;
    }
    getAttributeNS(namespace, localName) {
      const key = this._attrKeyByNS(namespace == null ? null : String(namespace), String(localName));
      return key == null ? null : this._attrs[key];
    }
    hasAttributeNS(namespace, localName) {
      return this._attrKeyByNS(namespace == null ? null : String(namespace), String(localName)) != null;
    }
    removeAttributeNS(namespace, localName) {
      const key = this._attrKeyByNS(namespace == null ? null : String(namespace), String(localName));
      if (key != null) this._removeAttrKey(key);
    }
    removeAttribute(name) {
      const key = attrKey(this, name);
      if (Object.prototype.hasOwnProperty.call(this._attrs, key)) {
        this._removeAttrKey(key);
        return;
      }
      if (this._attrNS) {
        const k = firstAttrKeyByQName(this, name);
        if (k != null) this._removeAttrKey(k);
      }
    }
    // Stable, live Attr node for the attribute stored under `key`. Cached on
    // the element so `getAttributeNode` returns the same identity each call.
    _attrNodeFor(key) {
      const cache = this._attrNodes || (this._attrNodes = {});
      let a = cache[key];
      if (!a) {
        const meta = this._attrNS && this._attrNS[key];
        a = new Attr(
          meta ? meta.localName : key,
          meta ? meta.ns : null,
          meta ? meta.prefix : null,
          this._attrs[key],
          this.ownerDocument
        );
        a._ownerElement = this;
        a._key = key;
        cache[key] = a;
      }
      return a;
    }
    // Low-level store write used by a bound Attr's `value` setter (keeps the
    // mutation-record / attributeChangedCallback side effects of setAttribute).
    _setAttrNodeValue(key, value) {
      const old = this._attrs[key];
      this._attrs[key] = value;
      if ((key === "id" || key === "name") && value) registerNamedAccess(this, key, value);
      recordAttrMutation(this, key, old == null ? null : old);
      if (old !== value) fireAttrChangedCallback(this, key, old == null ? null : old, value);
    }
    // Detach the cached Attr node (if any) at `key`: snapshot its value and
    // sever the owner link so a held reference reads its last value and a null
    // owner, per the DOM "remove an attribute" steps.
    _detachAttrNode(key) {
      const a = this._attrNodes && this._attrNodes[key];
      if (!a) return;
      a._value = this._attrs[key];
      a._ownerElement = null;
      a._key = null;
      delete this._attrNodes[key];
    }
    // Bind a detached Attr into this element's store (setAttributeNode).
    _bindAttrNode(attr) {
      const hasNs = attr._ns != null || attr._prefix != null;
      const qn = attr.name;
      const key = hasNs ? this._attrKeyByNS(attr._ns, attr._localName) || freshAttrKey(this, qn) : asciiLower2(qn);
      const old = this._attrs[key];
      this._attrs[key] = attr._value;
      if (!hasNs && (key === "id" || key === "name") && attr._value) registerNamedAccess(this, key, attr._value);
      if (hasNs) (this._attrNS || (this._attrNS = {}))[key] = { ns: attr._ns, prefix: attr._prefix, localName: attr._localName };
      else if (this._attrNS) delete this._attrNS[key];
      attr._ownerElement = this;
      attr._key = key;
      (this._attrNodes || (this._attrNodes = {}))[key] = attr;
      recordAttrMutation(this, key, old == null ? null : old);
      if (old !== attr._value) fireAttrChangedCallback(this, key, old == null ? null : old, attr._value);
    }
    // Remove the attribute stored under the exact key `n` (no re-keying).
    _removeAttrKey(n) {
      if (!Object.prototype.hasOwnProperty.call(this._attrs, n)) return;
      const old = this._attrs[n];
      const meta = this._attrNS && this._attrNS[n] || null;
      this._detachAttrNode(n);
      delete this._attrs[n];
      if (this._attrNS) delete this._attrNS[n];
      if ((n === "src" || n === "srcdoc") && (this._tag === "iframe" || this._tag === "frame")) {
        const oldRealmId = this._frameRealmId;
        this._frameWindow = null;
        this._frameRealmId = null;
        if (oldRealmId != null) {
          if (globalThis.__csimChildRealmIds) globalThis.__csimChildRealmIds.delete(oldRealmId);
          if (globalThis.__csim_disposeFrameRealm) globalThis.__csim_disposeFrameRealm(oldRealmId);
        }
      }
      if (this._tag === "body" || this._tag === "frameset") {
        const evt = windowForwardedHandlerName(n);
        if (evt) activateWindowForwardedHandler(evt, null);
      }
      recordAttrMutation(this, n, old == null ? null : old, meta);
      fireAttrChangedCallback(this, n, old == null ? null : old, null);
    }
    hasAttribute(name) {
      if (Object.prototype.hasOwnProperty.call(this._attrs, attrKey(this, name))) return true;
      return this._attrNS ? firstAttrKeyByQName(this, name) != null : false;
    }
    // `Element.toggleAttribute(name, force?)` per DOM spec. Without
    // `force`, flips the attribute (present → absent, absent →
    // present-with-empty-value); with `force`, asserts the state.
    // Returns the resulting presence as a boolean. Trix's
    // `makeEditable(element)` calls `element.toggleAttribute(
    // "contenteditable", !element.disabled)` and throws if the
    // method is missing — connectedCallback aborts before the
    // EditorController is wired up.
    toggleAttribute(name, force) {
      const qn = String(name);
      if (!isValidAttributeLocalName(qn)) {
        throw new globalThis.DOMException("'" + qn + "' is not a valid attribute name.", "InvalidCharacterError");
      }
      name = qn;
      const has = this.hasAttribute(name);
      const next = arguments.length > 1 ? !!force : !has;
      if (next === has) return next;
      if (next) this.setAttribute(name, "");
      else this.removeAttribute(name);
      return next;
    }
    // Qualified names in attribute order. Maps collision-keyed synthetic keys back
    // to their qualified name (no-op for the common case where key === name).
    getAttributeNames() {
      const keys = Object.keys(this._attrs);
      return this._attrNS ? keys.map((k) => attrQName(this, k)) : keys;
    }
    // `attributes` returns a live-platform-object NamedNodeMap (a fresh snapshot
    // per access): indexed entries + supported named properties, with `length` /
    // `item` / `getNamedItem` on the prototype. Each entry is an Attr carrying the
    // fields consumers touch (`name`, `value`, `namespaceURI`, `prefix`,
    // `localName`, `ownerElement`). The XPath engine reads attributes straight
    // from the store, not through this collection.
    get attributes() {
      if (this._attrsColl) return this._attrsColl;
      const dropUppercase = this._ns === HTML_NS2 && isHtmlDocument(this.ownerDocument);
      return this._attrsColl = liveNamedNodeMap(this, dropUppercase);
    }
    getAttributeNode(name) {
      const n = attrKey(this, name);
      return Object.prototype.hasOwnProperty.call(this._attrs, n) ? makeAttr(this, n) : null;
    }
    // HTMLCollection-shaped getters framework code expects.
    // Spec says these return *descendants* of the element (not self).
    // https://dom.spec.whatwg.org/#concept-getelementsbytagname — match on the
    // element's qualified name (prefix:localName), not the uppercased tagName. In
    // an HTML document the comparison is ASCII case-insensitive for HTML-namespace
    // elements and case-sensitive otherwise; in an XML/XHTML document it is always
    // case-sensitive. We refine querySelectorAll('*') (the iterative CSS walk — no
    // recursion, so it's deep-DOM safe, unlike a recursive walk). Note this does
    // materialise all descendants; a tag-specific CSS query can't substitute here
    // because it would over-match foreign-namespace elements by lowercased tag.
    getElementsByTagName(tag) {
      return liveHTMLCollection(() => collectByTagName(this, tag));
    }
    getElementsByClassName(cls) {
      return liveHTMLCollection(() => collectByClassName(this, cls));
    }
    getElementsByName(name) {
      const sel = '[name="' + String(name).replace(/"/g, '\\"') + '"]';
      return htmlCollection(this.querySelectorAll(sel).filter((n) => n !== this));
    }
    // IDL `id` / `className` go through setAttribute so MO sees the
    // change record. Setting them directly on `_attrs` would skip the
    // hook and break observers that watch `attributes`.
    // Minimal CSSStyleDeclaration. We don't parse / compute styles —
    // `cssText` is just a mirror onto the `style="..."` attribute,
    // and individual property access reads / writes the corresponding
    // declaration in that string. Enough for jQuery / framework
    // feature-detection (`el.style.cssText = '...'`); not enough for
    // `getComputedStyle()`-style cascade resolution.
    get style() {
      if (!this._styleProxy) this._styleProxy = makeStyleProxy(this);
      return this._styleProxy;
    }
    set style(v) {
      this.setAttribute("style", String(v == null ? "" : v));
      this._styleProxy = null;
    }
    get id() {
      return this._attrs.id || "";
    }
    set id(v) {
      this.setAttribute("id", String(v));
    }
    get className() {
      return this._attrs["class"] || "";
    }
    set className(v) {
      this.setAttribute("class", String(v));
    }
    // HTML spec IDL: true iff the element is editable (own
    // `contenteditable` is "" / "true" / "plaintext-only", OR an
    // ancestor enables it without an intervening "false"). Mousetrap's
    // default `stopCallback` checks this to skip keyboard shortcuts
    // while typing in a contenteditable — without the getter, plain
    // letters typed into a PM/Tiptap editor route through Discourse's
    // window-level `c`-to-compose / etc. shortcuts and surprise the
    // user with modals.
    get isContentEditable() {
      return isContenteditable(this);
    }
    // HTML spec: `el.hidden` reflects the `hidden` content attribute as
    // a boolean. Stimulus controllers commonly do `el.hidden = true`
    // instead of `el.setAttribute('hidden', '')`; without the setter
    // those toggles silently lose the attribute.
    get hidden() {
      return this._attrs.hidden != null;
    }
    set hidden(v) {
      if (v) this.setAttribute("hidden", "");
      else this.removeAttribute("hidden");
    }
    // HTML spec: `<details>` and `<dialog>` expose `open` as a boolean
    // IDL attribute reflecting the content attribute. Discourse's
    // select-kit `_handleNativeToggle` reads `element.open` to decide
    // open vs close; without this getter the read is `undefined`,
    // its open/close branches mis-fire and the dropdown stays empty.
    get open() {
      return this._attrs.open != null;
    }
    set open(v) {
      if (v) this.setAttribute("open", "");
      else this.removeAttribute("open");
    }
    // HTML Popover API — `el.popover` reflects the `popover` attribute
    // ('' / 'auto' / 'manual' / 'hint'). `showPopover` / `hidePopover`
    // / `togglePopover` flip a UA `:popover-open` state which we track
    // on `_popoverOpen`. Fire `toggle` / `beforetoggle` events per spec.
    get popover() {
      return this._attrs.popover == null ? null : this._attrs.popover || "auto";
    }
    set popover(v) {
      if (v == null) this.removeAttribute("popover");
      else this.setAttribute("popover", String(v));
    }
    showPopover() {
      if (this._popoverOpen) return;
      try {
        dispatchEvent(this, new Event("beforetoggle", { bubbles: false, cancelable: true }));
      } catch (_) {
      }
      this._popoverOpen = true;
      try {
        dispatchEvent(this, new Event("toggle", { bubbles: false, cancelable: false }));
      } catch (_) {
      }
    }
    hidePopover() {
      if (!this._popoverOpen) return;
      try {
        dispatchEvent(this, new Event("beforetoggle", { bubbles: false, cancelable: true }));
      } catch (_) {
      }
      this._popoverOpen = false;
      try {
        dispatchEvent(this, new Event("toggle", { bubbles: false, cancelable: false }));
      } catch (_) {
      }
    }
    togglePopover(force) {
      const next = force != null ? !!force : !this._popoverOpen;
      if (next) this.showPopover();
      else this.hidePopover();
      return this._popoverOpen;
    }
    // `HTMLTimeElement#dateTime` reflects the `datetime` content
    // attribute. Mastodon's `public.tsx` reads `<time>.dateTime` to
    // re-format timestamps; without the IDL getter the property is
    // undefined, `new Date(undefined)` is Invalid Date, and
    // `Intl.DateTimeFormat.format(invalid)` throws under QuickJS's
    // strict polyfill (V8 returns "Invalid Date" instead).
    get dateTime() {
      return this._attrs.datetime || "";
    }
    set dateTime(v) {
      this.setAttribute("datetime", String(v));
    }
    // [SameObject, PutForwards=value] — return one cached DOMTokenList per
    // element (identity is observable: `e.classList === e.classList`), and
    // assigning to `.classList` forwards to its `.value`. Writes round-trip
    // through setAttribute('class', …) so MutationObserver + cascade + CE
    // `attributeChangedCallback` all see the change (e.g. the
    // IntersectionObserver recheck that reveals lazy turbo-frames on
    // `classList.remove('hidden')`).
    get classList() {
      return tokenListFor(this, "class");
    }
    set classList(v) {
      this.classList.value = v;
    }
    // HTMLElement.dataset — DOMStringMap-shaped live view of every
    // `data-*` attribute on the element. Real-browser equivalents:
    // `el.dataset.fooBar` ↔ `data-foo-bar` attribute (camelCase
    // ↔ kebab-case). Libraries lean on it heavily (Tribute checks
    // `element.dataset.tribute === 'true'` to avoid double-attach,
    // Stimulus stores controller / target / action data, Trix mirrors
    // its editor state, etc.) — without the getter, the read throws
    // `Cannot read properties of undefined (reading 'fooBar')` and the
    // library short-circuits silently. Proxy reads `_attrs` lazily so
    // setAttribute / removeAttribute mutations show through without
    // cache invalidation.
    get dataset() {
      if (this._datasetProxy) return this._datasetProxy;
      const el = this;
      const toAttr = /* @__PURE__ */ __name((k) => "data-" + String(k).replace(/[A-Z]/g, (m) => "-" + m.toLowerCase()), "toAttr");
      const fromAttr = /* @__PURE__ */ __name((n) => n.slice(5).replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase()), "fromAttr");
      this._datasetProxy = new Proxy({}, {
        get(_t, key) {
          if (typeof key !== "string") return void 0;
          const v = el._attrs[toAttr(key)];
          return v == null ? void 0 : v;
        },
        set(_t, key, value) {
          if (typeof key !== "string") return false;
          el.setAttribute(toAttr(key), String(value));
          return true;
        },
        deleteProperty(_t, key) {
          if (typeof key !== "string") return false;
          el.removeAttribute(toAttr(key));
          return true;
        },
        has(_t, key) {
          return typeof key === "string" && Object.prototype.hasOwnProperty.call(el._attrs, toAttr(key));
        },
        ownKeys() {
          return Object.keys(el._attrs).filter((n) => n.startsWith("data-")).map(fromAttr);
        },
        getOwnPropertyDescriptor(_t, key) {
          if (typeof key !== "string") return void 0;
          const attr = toAttr(key);
          if (!Object.prototype.hasOwnProperty.call(el._attrs, attr)) return void 0;
          return { enumerable: true, configurable: true, value: el._attrs[attr] };
        }
      });
      return this._datasetProxy;
    }
    // `Element#querySelectorAll` matches against the element's
    // *descendants only* — the element itself is never returned
    // even when the selector would match it. Pass children as
    // roots, not `this`.
    querySelector(sel) {
      if (arguments.length < 1) throw new TypeError("Failed to execute 'querySelector': 1 argument required, but only 0 present.");
      return selectFirst(this._children, sel, this);
    }
    querySelectorAll(sel) {
      if (arguments.length < 1) throw new TypeError("Failed to execute 'querySelectorAll': 1 argument required, but only 0 present.");
      return nodeList(selectAll(this._children, sel, this));
    }
    matches(sel) {
      if (arguments.length < 1) throw new TypeError("Failed to execute 'matches': 1 argument required, but only 0 present.");
      return matchesSelector(this, sel);
    }
    closest(sel) {
      return closestSelector(this, sel);
    }
    // Common HTMLElement / form-control IDL attributes that mirror to
    // their named attributes. jQuery 3.x's `.serialize()` filter keys
    // on `this.name` / `this.type`; without these getters the filter
    // rejects every form element (`.name` undefined → falsy → skip).
    // Mirrors HTML spec's reflection rules: read returns the attribute
    // value (or '' if absent), write goes through setAttribute so
    // MutationObserver / attributeChangedCallback see the change.
    get name() {
      return this._attrs.name != null ? this._attrs.name : "";
    }
    set name(v) {
      this.setAttribute("name", String(v == null ? "" : v));
    }
    get type() {
      if (this._tag === "input") {
        const t = this._attrs.type;
        return t != null ? t.toLowerCase() : "text";
      }
      if (this._tag === "select") {
        return this._attrs.multiple != null ? "select-multiple" : "select-one";
      }
      return this._attrs.type != null ? this._attrs.type : "";
    }
    set type(v) {
      this.setAttribute("type", String(v == null ? "" : v));
    }
    // `<select>.options` / `<datalist>.options` — HTMLOptionsCollection /
    // live HTMLCollection of every `<option>` descendant. jQuery's
    // `.val()` reads it with an indexed lookup based on `selectedIndex`;
    // controllers also reach for the collection's spec mutators
    // (`add` / `remove` / `item` / `namedItem`) — Avo's
    // `city-in-country` does `options.remove(0)` per option to wipe and
    // rebuild after a country change.
    get options() {
      if (this._tag !== "select" && this._tag !== "datalist") return void 0;
      const arr = selectAll(this._children, "option", this);
      const owner = this;
      arr.add = function(option, before) {
        owner.add ? owner.add(option, before) : owner.appendChild(option);
      };
      arr.remove = function(idx) {
        const o = arr[idx];
        if (o && o._parent) o._parent.removeChild(o);
      };
      arr.item = function(i) {
        return arr[i] || null;
      };
      arr.namedItem = function(name) {
        return arr.find((o) => o._attrs.id === name || o._attrs.name === name) || null;
      };
      return arr;
    }
    // HTMLSelectElement.add(option, before?) — `before` may be a
    // numeric index into the existing options or the reference
    // element itself.
    add(element, before) {
      if (this._tag !== "select") return;
      if (before == null) this.appendChild(element);
      else if (typeof before === "number") {
        this.insertBefore(element, this.querySelectorAll("option")[before] || null);
      } else this.insertBefore(element, before);
    }
    get title() {
      return this._attrs.title != null ? this._attrs.title : "";
    }
    set title(v) {
      this.setAttribute("title", String(v == null ? "" : v));
    }
    // HTMLFormElement.elements — collection of named form controls.
    // jQuery's `.serialize()` reads this; without it, serialize returns
    // empty even though the form has inputs (Redmine's context-menu
    // AJAX sends an empty query string and the server 404s). Real
    // browsers include input/select/textarea/button (and a few more);
    // returning a length-bearing array is sufficient for jQuery.
    get elements() {
      if (this._tag !== "form") return void 0;
      const out = [];
      walkSubtree(this, (el) => {
        if (el === this || el.nodeType !== NODE_ELEMENT) return;
        const t = el._tag;
        if (t === "input" || t === "select" || t === "textarea" || t === "button" || t === "fieldset" || t === "object") {
          out.push(el);
        }
      });
      out.length = out.length;
      return out;
    }
    // `HTMLButtonElement.form` (and the IDL for all form-associated
    // controls) — returns the owning form. Per spec the `form="<id>"`
    // attribute takes precedence over the ancestor `<form>`; we
    // mirror that. Redmine's settings page uses
    // `onclick="moveOptions(this.form.selected_..., this.form.
    // available_...)"` to wire up its column-mover buttons — without
    // `this.form` the onclick threw and the columns never moved.
    get form() {
      if (!FORM_ASSOCIATED_TAGS.has(this._tag)) return void 0;
      return formForControl(this) || null;
    }
    // Form-control IDL attributes — expose the pair-of-attr-and-IDL
    // shape so JS like `input.value = 'x'` / `input.checked = true`
    // works and reads back via `globalThis.__csimValue` / serialised attrs alike.
    get value() {
      if (this._tag === "select") {
        const opts = this.querySelectorAll("option");
        if (this._attrs.multiple != null) {
          const out = [];
          for (const o of opts) if (o._attrs.selected != null) {
            out.push(o._attrs.value != null ? o._attrs.value : o.textContent);
          }
          return out;
        }
        let implicit = null;
        for (const o of opts) {
          if (o._attrs.disabled != null) continue;
          if (o._attrs.selected != null) return o._attrs.value != null ? o._attrs.value : o.textContent;
          if (implicit == null) implicit = o._attrs.value != null ? o._attrs.value : o.textContent;
        }
        return implicit == null ? "" : implicit;
      }
      if (this._tag === "textarea") {
        if (this._attrs.value != null) return this._attrs.value;
        return stripOneLeadingNewline(this.textContent);
      }
      return this._attrs.value != null ? this._attrs.value : "";
    }
    set value(v) {
      if (this._tag === "select") {
        const target = String(v == null ? "" : v);
        const opts = this.querySelectorAll("option");
        for (const o of opts) delete o._attrs.selected;
        for (const o of opts) {
          const ov = o._attrs.value != null ? o._attrs.value : o.textContent;
          if (ov === target) {
            o._attrs.selected = "";
            break;
          }
        }
        return;
      }
      if (this._defaultValue === void 0) {
        this._defaultValue = this._tag === "textarea" ? this.textContent : this._attrs.value || "";
      }
      this._attrs.value = String(v == null ? "" : v);
    }
    // `<option>.selected` IDL — boolean reflecting the `selected`
    // content attribute. jQuery's `.val()` over a `<select>` walks the
    // options checking each `.selected`; Redmine's onchange handlers
    // probe `option[selected]` after manual `select` calls. Without
    // the IDL getter the read returns `undefined` and the resolved
    // value comes back empty.
    get selected() {
      if (this._tag !== "option") return false;
      return this._attrs.selected != null;
    }
    set selected(v) {
      if (this._tag !== "option") return;
      let changed = this._attrs.selected != null !== !!v;
      if (v) {
        this._attrs.selected = "";
        let p = this._parent;
        while (p && p.nodeType === NODE_ELEMENT && p._tag !== "select") p = p._parent;
        if (p && p._tag === "select" && p._attrs.multiple == null) {
          for (const o of p.querySelectorAll("option")) {
            if (o !== this && o._attrs.selected != null) {
              delete o._attrs.selected;
              changed = true;
            }
          }
        }
      } else {
        delete this._attrs.selected;
      }
      if (changed) bumpSettleGen();
    }
    // `<select>.selectedIndex` — index of the first selected option,
    // or 0 (the default) when no option is explicitly selected.
    get selectedIndex() {
      if (this._tag !== "select") return -1;
      const opts = this.querySelectorAll("option");
      for (let i = 0; i < opts.length; i++) {
        if (opts[i]._attrs.selected != null) return i;
      }
      return opts.length > 0 ? 0 : -1;
    }
    // `<select>.selectedOptions` — live HTMLCollection of every
    // currently-selected `<option>` descendant. Avo's
    // `multiple-select-filter` controller reads
    // `Array.from(selectorTarget.selectedOptions).map(...)` to build
    // the filter query; without this accessor the filter button click
    // throws silently and the URL never gains the `encoded_filters`
    // param.
    get selectedOptions() {
      if (this._tag !== "select") return void 0;
      return selectAll(this._children, "option", this).filter((o) => o._attrs.selected != null);
    }
    // Rails-UJS reads `element.href` to get an AJAX target; the raw
    // attribute would resolve against `location.href` (= current page)
    // and re-fetch the current page on every remote-link click.
    get href() {
      return reflectURLAttr(this, "href", HREF_REFLECTING_TAGS);
    }
    set href(v) {
      const next = String(v == null ? "" : v);
      const old = this._attrs.href;
      this._attrs.href = next;
      if (this._tag === "link" && old !== next && globalThis.__csim_onLinkHrefAssigned) {
        globalThis.__csim_onLinkHrefAssigned(this);
      }
      if (this._tag === "base" && old !== next) bumpSettleGen();
    }
    // Bundlers read `document.currentScript.src` at top level to derive
    // their public-path origin; an unresolved `/assets/…` crashes
    // auto-detection ("Automatic publicPath is not supported in this
    // browser").
    get src() {
      return reflectURLAttr(this, "src", SRC_REFLECTING_TAGS);
    }
    set src(v) {
      const next = String(v == null ? "" : v);
      if (this._tag === "iframe" || this._tag === "frame") {
        this.setAttribute("src", next);
        return;
      }
      this._attrs.src = next;
      if (this._tag === "video" && globalThis.__csim_onVideoSrcAssigned) {
        globalThis.__csim_onVideoSrcAssigned(this, next);
      }
    }
    // `<a>` / `<area>` `download` IDL attribute — reflects the
    // `download` content attribute as a string. file-saver feature-
    // detects via `'download' in HTMLAnchorElement.prototype` to pick
    // its saveAs implementation; without this getter it falls through
    // to the popup-based fallback (`open('', '_blank')`) which throws
    // a ReferenceError, breaking Avo's action downloads.
    get download() {
      return this._attrs.download == null ? "" : String(this._attrs.download);
    }
    set download(v) {
      this.setAttribute("download", v == null ? "" : String(v));
    }
    // `<link>` / `<a>` / `<area>` reflect the `rel` content attribute.
    // Vite's preload-helper sets `l.rel = 'stylesheet'` before
    // `head.appendChild(l)`; without the reflection the rel attribute
    // stays empty and downstream selectors / event-firing gates
    // (`maybeFireLinkLoad`'s rel check) miss the link entirely.
    get rel() {
      return this._attrs.rel == null ? "" : String(this._attrs.rel);
    }
    set rel(v) {
      this.setAttribute("rel", v == null ? "" : String(v));
    }
    // `<link>` / `<style>` / `<source>` reflect the `media` content
    // attribute. Discourse's `interface-color` service does
    // `lightStylesheet.media = "all"` to toggle color schemes; without
    // the setter the JS-side `link.media` is a plain instance prop and
    // `document.querySelector('link[media="all"]')` (the color-mode page
    // object's check) never matches.
    get media() {
      return this._attrs.media == null ? "" : String(this._attrs.media);
    }
    set media(v) {
      this.setAttribute("media", v == null ? "" : String(v));
    }
    // `<canvas>.getContext('2d')` delegates to the same context
    // implementation OffscreenCanvas uses, so libraries that work
    // off a DOM canvas (e.g. image-processing widgets) get the same
    // `drawImage` / `getImageData` surface.
    getContext(type) {
      if (this._tag !== "canvas") return null;
      if (type !== "2d" && type !== "bitmaprenderer") return null;
      this._ctx = this._ctx || new globalThis.CanvasRenderingContext2D(this);
      return this._ctx;
    }
    // HTMLHyperlinkElementUtils mixin: `<a>` / `<area>` override
    // `toString()` to return the resolved `href`. Forem's
    // `trackNotification` reads `target.toString()` on the clicked
    // link to build an ahoy event property; without this, every
    // anchor stringifies to the default `[object Object]`.
    toString() {
      if (this._tag === "a" || this._tag === "area") return this.href;
      return Object.prototype.toString.call(this);
    }
    // HTMLFormElement IDL — `method` / `action` / `enctype` /
    // `target` are reflections of the corresponding attributes.
    // Rails-UJS's `handleMethod` builds a synthetic form via
    // `form.method = 'post'` / `form.action = href`; without
    // these setters those land as plain JS properties (not
    // attributes), and our form serialiser reads the attrs as
    // null → default GET → submits with the wrong method and a
    // query-string instead of a POST body.
    get method() {
      if (this._tag !== "form") return this._attrs.method;
      const m = (this._attrs.method || "get").toLowerCase();
      return m === "dialog" ? "dialog" : m === "post" ? "post" : "get";
    }
    set method(v) {
      if (this._tag === "form") this.setAttribute("method", String(v == null ? "" : v));
      else this._attrs.method = String(v == null ? "" : v);
    }
    get action() {
      if (this._tag !== "form") return this._attrs.action;
      const a = this._attrs.action;
      if (a == null) return globalThis.location && globalThis.location.href || "";
      try {
        const base = globalThis.location && globalThis.location.href || null;
        const u = globalThis.__csim_parseUrl(a, base);
        return u && !u.error ? u.href : a;
      } catch (_) {
        return a;
      }
    }
    set action(v) {
      this.setAttribute("action", String(v == null ? "" : v));
    }
    get enctype() {
      return this._attrs.enctype != null ? this._attrs.enctype : "application/x-www-form-urlencoded";
    }
    set enctype(v) {
      this.setAttribute("enctype", String(v == null ? "" : v));
    }
    get target() {
      return this._attrs.target != null ? this._attrs.target : "";
    }
    set target(v) {
      this.setAttribute("target", String(v == null ? "" : v));
    }
    // HTMLScriptElement / HTMLTitleElement / etc. expose `.text` as
    // an alias for `textContent`. stimulus-rails' `parseImportmapJson`
    // reads `script.text` to get the JSON; without this alias it
    // gets `undefined`.
    get text() {
      return this.textContent;
    }
    set text(v) {
      this.textContent = v;
    }
    // `<input list="<id>">` exposes the associated <datalist> via
    // `input.list`. Capybara's `select` for datalist inputs reads
    // `this.list.options` to enumerate choices.
    get list() {
      if (this._tag !== "input") return null;
      const id = this._attrs.list;
      if (!id) return null;
      return globalThis.document && globalThis.document.getElementById(id);
    }
    get checked() {
      return this._attrs.checked != null;
    }
    set checked(v) {
      if (this._defaultChecked === void 0) this._defaultChecked = this._attrs.checked != null;
      const was = this._attrs.checked != null;
      if (v) this._attrs.checked = "";
      else delete this._attrs.checked;
      if (was !== !!v) bumpSettleGen();
    }
    // Boolean IDL reflections — `el.disabled = true` mirrors to the `disabled`
    // content attribute (HTML IDL contract), so route through setAttribute /
    // removeAttribute (like `hidden` / `open`) rather than writing `_attrs`
    // directly: that fires the MutationObserver attributes record + settle-gen bump
    // real browsers produce for a reflected change (and re-resolves any cascade
    // memo keyed on the settle generation). A direct `_attrs` write was silent to
    // both — e.g. `el.disabled = true` under `input[disabled]{display:none}` left
    // the element wrongly reported visible.
    get disabled() {
      return this._attrs.disabled != null;
    }
    set disabled(v) {
      if (v) this.setAttribute("disabled", "");
      else this.removeAttribute("disabled");
    }
    get readOnly() {
      return this._attrs.readonly != null;
    }
    set readOnly(v) {
      if (v) this.setAttribute("readonly", "");
      else this.removeAttribute("readonly");
    }
    get required() {
      return this._attrs.required != null;
    }
    set required(v) {
      if (v) this.setAttribute("required", "");
      else this.removeAttribute("required");
    }
    // Integer-reflecting IDL: `<input minlength="10">` → input.minLength === 10
    // (real browsers return -1 when unset). Discourse's
    // form-template-validation passes `count: field.minLength` into the
    // tooShort i18n string; an undefined here renders the literal
    // `count=undefined` placeholder instead of the translated count.
    get minLength() {
      const n = parseInt(this._attrs.minlength || "", 10);
      return isNaN(n) ? -1 : n;
    }
    set minLength(v) {
      this.setAttribute("minlength", String(v == null ? "" : v));
    }
    get maxLength() {
      const n = parseInt(this._attrs.maxlength || "", 10);
      return isNaN(n) ? -1 : n;
    }
    set maxLength(v) {
      this.setAttribute("maxlength", String(v == null ? "" : v));
    }
    // ── HTMLInputElement reflected string IDL ─────────────────────────
    // Each reflects its same-named (lowercased) content attribute as a
    // string. Only meaningful on `<input>`; mirror the existing
    // reflected-string idiom and default to '' off-input.
    get accept() {
      return this._tag === "input" ? this._attrs.accept == null ? "" : String(this._attrs.accept) : "";
    }
    set accept(v) {
      this.setAttribute("accept", v == null ? "" : String(v));
    }
    get alt() {
      return this._tag === "input" ? this._attrs.alt == null ? "" : String(this._attrs.alt) : "";
    }
    set alt(v) {
      this.setAttribute("alt", v == null ? "" : String(v));
    }
    get pattern() {
      return this._tag === "input" ? this._attrs.pattern == null ? "" : String(this._attrs.pattern) : "";
    }
    set pattern(v) {
      this.setAttribute("pattern", v == null ? "" : String(v));
    }
    get placeholder() {
      return this._tag === "input" ? this._attrs.placeholder == null ? "" : String(this._attrs.placeholder) : "";
    }
    set placeholder(v) {
      this.setAttribute("placeholder", v == null ? "" : String(v));
    }
    get step() {
      return this._tag === "input" ? this._attrs.step == null ? "" : String(this._attrs.step) : "";
    }
    set step(v) {
      this.setAttribute("step", v == null ? "" : String(v));
    }
    get min() {
      return this._tag === "input" ? this._attrs.min == null ? "" : String(this._attrs.min) : "";
    }
    set min(v) {
      this.setAttribute("min", v == null ? "" : String(v));
    }
    get max() {
      return this._tag === "input" ? this._attrs.max == null ? "" : String(this._attrs.max) : "";
    }
    set max(v) {
      this.setAttribute("max", v == null ? "" : String(v));
    }
    get dirName() {
      return this._tag === "input" ? this._attrs.dirname == null ? "" : String(this._attrs.dirname) : "";
    }
    set dirName(v) {
      this.setAttribute("dirname", v == null ? "" : String(v));
    }
    get capture() {
      return this._tag === "input" ? this._attrs.capture == null ? "" : String(this._attrs.capture) : "";
    }
    set capture(v) {
      this.setAttribute("capture", v == null ? "" : String(v));
    }
    get useMap() {
      return this._tag === "input" ? this._attrs.usemap == null ? "" : String(this._attrs.usemap) : "";
    }
    set useMap(v) {
      this.setAttribute("usemap", v == null ? "" : String(v));
    }
    get align() {
      return this._tag === "input" ? this._attrs.align == null ? "" : String(this._attrs.align) : "";
    }
    set align(v) {
      this.setAttribute("align", v == null ? "" : String(v));
    }
    // formaction / formenctype / formmethod / formtarget — submit-button
    // overrides; plain reflected strings.
    get formAction() {
      return this._tag === "input" ? this._attrs.formaction == null ? "" : String(this._attrs.formaction) : "";
    }
    set formAction(v) {
      this.setAttribute("formaction", v == null ? "" : String(v));
    }
    get formEnctype() {
      return this._tag === "input" ? this._attrs.formenctype == null ? "" : String(this._attrs.formenctype) : "";
    }
    set formEnctype(v) {
      this.setAttribute("formenctype", v == null ? "" : String(v));
    }
    get formMethod() {
      return this._tag === "input" ? this._attrs.formmethod == null ? "" : String(this._attrs.formmethod) : "";
    }
    set formMethod(v) {
      this.setAttribute("formmethod", v == null ? "" : String(v));
    }
    get formTarget() {
      return this._tag === "input" ? this._attrs.formtarget == null ? "" : String(this._attrs.formtarget) : "";
    }
    set formTarget(v) {
      this.setAttribute("formtarget", v == null ? "" : String(v));
    }
    // popovertargetaction — enumerated string, default ''.
    get popoverTargetAction() {
      return this._tag === "input" ? this._attrs.popovertargetaction == null ? "" : String(this._attrs.popovertargetaction) : "";
    }
    set popoverTargetAction(v) {
      this.setAttribute("popovertargetaction", v == null ? "" : String(v));
    }
    // ── HTMLInputElement boolean IDL reflections ──────────────────────
    get formNoValidate() {
      return this._tag === "input" ? this.hasAttribute("formnovalidate") : false;
    }
    set formNoValidate(v) {
      if (v) this.setAttribute("formnovalidate", "");
      else this.removeAttribute("formnovalidate");
    }
    get multiple() {
      return this._tag === "input" ? this.hasAttribute("multiple") : false;
    }
    set multiple(v) {
      if (v) this.setAttribute("multiple", "");
      else this.removeAttribute("multiple");
    }
    get webkitdirectory() {
      return this._tag === "input" ? this.hasAttribute("webkitdirectory") : false;
    }
    set webkitdirectory(v) {
      if (v) this.setAttribute("webkitdirectory", "");
      else this.removeAttribute("webkitdirectory");
    }
    // ── HTMLInputElement unsigned-long IDL reflections ────────────────
    // size defaults to 20; non-positive / NaN falls back to the default.
    get size() {
      const n = parseInt(this._attrs.size, 10);
      return Number.isNaN(n) || n <= 0 ? 20 : n;
    }
    set size(v) {
      this.setAttribute("size", String(v == null ? "" : v));
    }
    // height / width default to 0 (the rendered pixel size for image
    // inputs; we don't lay out, so just reflect the attribute or 0).
    get height() {
      const n = parseInt(this._attrs.height, 10);
      return Number.isNaN(n) ? 0 : n;
    }
    set height(v) {
      this.setAttribute("height", String(v == null ? "" : v));
    }
    get width() {
      const n = parseInt(this._attrs.width, 10);
      return Number.isNaN(n) ? 0 : n;
    }
    set width(v) {
      this.setAttribute("width", String(v == null ? "" : v));
    }
    // ── HTMLInputElement default* IDL ─────────────────────────────────
    // `defaultChecked` / `defaultValue` reflect the *content* attribute
    // (`checked` / `value`), NOT the dirty-tracking `_defaultChecked` /
    // `_defaultValue` snapshot fields used by `<form>.reset()` — those
    // are independent concepts (HTML "dirty flag" vs. attribute view).
    get defaultChecked() {
      return this.hasAttribute("checked");
    }
    set defaultChecked(v) {
      if (v) this.setAttribute("checked", "");
      else this.removeAttribute("checked");
    }
    // NB: the live `value` IDL and the `value` content attribute share
    // the `_attrs.value` slot in this codebase (a known wart). Reading /
    // writing `defaultValue` via getAttribute/setAttribute('value', …)
    // at least keeps it consistent with the attribute view.
    // `value` and the `value` content attribute share the `_attrs.value`
    // slot here, so once the live value is dirtied (`set value`) the
    // content attribute is gone. `set value` snapshots the pre-dirty
    // default into `_defaultValue` (same field `<form>.reset()` restores
    // from), so prefer that snapshot — that IS the default value. Falls
    // back to the live attribute when never dirtied.
    get defaultValue() {
      return this._defaultValue !== void 0 ? this._defaultValue : this.getAttribute("value") || "";
    }
    set defaultValue(v) {
      const s = v == null ? "" : String(v);
      if (this._defaultValue !== void 0) this._defaultValue = s;
      else this.setAttribute("value", s);
    }
    // `indeterminate` is an IDL boolean stored on the instance — it has
    // no content attribute. Backed by a field, default false.
    get indeterminate() {
      return this._indeterminate === true;
    }
    set indeterminate(v) {
      this._indeterminate = !!v;
    }
    // `<input>.labels` — every `<label for=this.id>` in the document
    // plus any ancestor `<label>`. Deduped, in document order. When the
    // id is empty, only ancestor labels participate.
    get labels() {
      if (this._tag !== "input") return void 0;
      const out = [];
      const seen = /* @__PURE__ */ new Set();
      const push = /* @__PURE__ */ __name((l) => {
        if (l && !seen.has(l)) {
          seen.add(l);
          out.push(l);
        }
      }, "push");
      const doc = this.ownerDocument;
      const id = this._attrs.id;
      if (id && doc) {
        for (const l of doc.getElementsByTagName("label")) {
          if (l._attrs.for === id) push(l);
        }
      }
      let p = this._parent;
      while (p && p.nodeType === NODE_ELEMENT) {
        if (p._tag === "label") push(p);
        p = p._parent;
      }
      if (doc) {
        const all = Array.from(doc.getElementsByTagName("label"));
        out.sort((a, b) => all.indexOf(a) - all.indexOf(b));
      }
      return out;
    }
    // ── HTMLInputElement value-as-number / value-as-date ──────────────
    // For number / range, parse `value` as a float (NaN when blank /
    // invalid). Other types report NaN (minimal — date parsing is heavy).
    get valueAsNumber() {
      if (this._tag !== "input") return NaN;
      const type = (this._attrs.type || "text").toLowerCase();
      if (type === "number" || type === "range") {
        const v = this.value;
        if (v === "" || v == null) return NaN;
        const n = parseFloat(v);
        return Number.isNaN(n) ? NaN : n;
      }
      return NaN;
    }
    set valueAsNumber(v) {
      if (this._tag !== "input") return;
      this.value = v == null || Number.isNaN(v) ? "" : String(v);
    }
    // Minimal `valueAsDate`: cheaply support type=date (`new Date(value)`,
    // null on invalid); other types / blank → null. Setter formats a
    // Date into `value` for date types.
    get valueAsDate() {
      if (this._tag !== "input") return null;
      const type = (this._attrs.type || "text").toLowerCase();
      if (type === "date") {
        const v = this.value;
        if (!v) return null;
        const d = new Date(v);
        return Number.isNaN(d.getTime()) ? null : d;
      }
      return null;
    }
    set valueAsDate(v) {
      if (this._tag !== "input") return;
      if (v == null) {
        this.value = "";
        return;
      }
      const type = (this._attrs.type || "text").toLowerCase();
      if (type === "date" && v instanceof Date && !Number.isNaN(v.getTime())) {
        this.value = v.toISOString().slice(0, 10);
      } else {
        this.value = "";
      }
    }
    // `stepUp(n)` / `stepDown(n)` — adjust the numeric value by
    // `step * n`, clamped to min / max when those parse as numbers.
    stepUp(n) {
      this._stepBy(n == null ? 1 : n);
    }
    stepDown(n) {
      this._stepBy(-(n == null ? 1 : n));
    }
    _stepBy(delta) {
      if (this._tag !== "input") return;
      const min = parseFloat(this._attrs.min);
      const step = parseFloat(this._attrs.step);
      const base = (() => {
        const b = parseFloat(this.value);
        return Number.isNaN(b) ? Number.isNaN(min) ? 0 : min : b;
      })();
      let next = base + (Number.isNaN(step) ? 1 : step) * delta;
      if (!Number.isNaN(min) && next < min) next = min;
      const max = parseFloat(this._attrs.max);
      if (!Number.isNaN(max) && next > max) next = max;
      this.value = String(next);
    }
    // `showPicker()` — real browsers require user activation; a no-op is
    // a safe approximation (we have no native picker UI).
    showPicker() {
    }
    // Constraint validation API — partial. We compute a subset of the
    // validity flags below (enough for `:valid` / `:invalid` selectors
    // and the common Stimulus form-controller probes); the full
    // algorithm including custom validators isn't run.
    get validity() {
      const tag = this._tag;
      const type = (this._attrs.type || "text").toLowerCase();
      const val = this._attrs.value != null ? String(this._attrs.value) : "";
      const checkable = type === "checkbox" || type === "radio";
      let empty;
      if (tag === "select") {
        const sv = this.value;
        empty = Array.isArray(sv) ? sv.length === 0 : sv == null || sv === "";
      } else {
        empty = checkable ? this._attrs.checked == null : val === "";
      }
      const v = {
        valueMissing: false,
        typeMismatch: false,
        patternMismatch: false,
        tooLong: false,
        tooShort: false,
        rangeUnderflow: false,
        rangeOverflow: false,
        stepMismatch: false,
        badInput: false,
        customError: !!this._validationMessage,
        valid: true
      };
      if (tag === "input" || tag === "textarea" || tag === "select") {
        const requiredApplies = tag !== "input" || !NO_REQUIRED_INPUT_TYPES.has(type);
        if (requiredApplies && this._attrs.required != null && empty) v.valueMissing = true;
        if (!empty && this._attrs.pattern != null && tag === "input") {
          try {
            v.patternMismatch = !new RegExp("^(?:" + this._attrs.pattern + ")$").test(val);
          } catch (_) {
          }
        }
        if (!empty && tag === "input") {
          if (type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val)) v.typeMismatch = true;
          if (type === "url" && !/^[a-z]+:\/\//i.test(val)) v.typeMismatch = true;
        }
        if (!empty && tag === "input") {
          const min = parseInt(this._attrs.minlength || "", 10);
          const max = parseInt(this._attrs.maxlength || "", 10);
          if (!isNaN(min) && val.length < min) v.tooShort = true;
          if (!isNaN(max) && val.length > max) v.tooLong = true;
        }
        if (v.valueMissing || v.patternMismatch || v.typeMismatch || v.tooShort || v.tooLong || v.customError) v.valid = false;
      }
      return v;
    }
    get validationMessage() {
      if (this._validationMessage) return this._validationMessage;
      const v = this.validity;
      if (v.valid) return "";
      if (v.valueMissing) return "Please fill out this field.";
      if (v.typeMismatch) return "Please match the requested format.";
      if (v.patternMismatch) return "Please match the requested format.";
      return "";
    }
    get willValidate() {
      if (this._tag === "form") return true;
      if (this._tag !== "input" && this._tag !== "textarea" && this._tag !== "select") return false;
      if ((this._attrs.type || "").toLowerCase() === "hidden") return false;
      if (this._attrs.disabled != null || this._attrs.readonly != null) return false;
      return true;
    }
    checkValidity() {
      if (this._tag === "form") {
        let allValid = true;
        for (const el of this.elements || []) {
          if (typeof el.checkValidity === "function" && !el.checkValidity()) allValid = false;
        }
        return allValid;
      }
      if (!this.willValidate) return true;
      if (this.validity.valid) return true;
      try {
        dispatchEvent(this, new globalThis.Event("invalid", { bubbles: false, cancelable: true }));
      } catch (_) {
      }
      return false;
    }
    reportValidity() {
      return this.checkValidity();
    }
    setCustomValidity(msg) {
      this._validationMessage = String(msg || "");
    }
    // Text-input selection — minimum HTMLInputElement / HTMLTextAreaElement
    // surface. `setSelectionRange` is called by Redmine's "reply to issue"
    // / partial-quote flow and by some libraries' "focus and select all"
    // patterns; we just store the offsets so reads of selectionStart /
    // selectionEnd are stable.
    get selectionStart() {
      return this._selectionStart || 0;
    }
    set selectionStart(v) {
      this._selectionStart = v | 0;
    }
    get selectionEnd() {
      return this._selectionEnd != null ? this._selectionEnd : (this._attrs.value || "").length;
    }
    set selectionEnd(v) {
      this._selectionEnd = v | 0;
    }
    get selectionDirection() {
      return this._selectionDirection || "none";
    }
    set selectionDirection(v) {
      this._selectionDirection = String(v || "none");
    }
    setSelectionRange(start, end, direction) {
      this._selectionStart = start | 0;
      this._selectionEnd = end | 0;
      this._selectionDirection = direction != null ? String(direction) : "none";
    }
    // `setRangeText(replacement, start, end, selectMode)` — HTMLSpec.
    // Replaces the text between `start` and `end` with `replacement`
    // and updates the caret per the `selectMode` argument
    // ('select' / 'start' / 'end' / 'preserve'; default 'preserve').
    // Redmine's list-autofill controller calls this with `'start'` to
    // remove a list marker when the user presses Enter on an empty
    // item; without the method the call throws and the marker stays.
    setRangeText(replacement, start, end, selectMode) {
      if (this._tag !== "input" && this._tag !== "textarea") return;
      const cur = this._attrs.value != null ? this._attrs.value : "";
      const len = cur.length;
      if (replacement == null) replacement = "";
      replacement = String(replacement);
      let s = start == null ? this._selectionStart || 0 : start | 0;
      let e = end == null ? this._selectionEnd || s : end | 0;
      if (s < 0) s = 0;
      if (e > len) e = len;
      if (s > e) s = e;
      const before = cur.slice(0, s);
      const after = cur.slice(e);
      const next = before + replacement + after;
      this._attrs.value = next;
      if (this._tag === "textarea") {
        this._children = newChildList([Object.assign(new Text(next), { _parent: this })]);
      }
      const mode = selectMode == null ? "preserve" : String(selectMode);
      const replEnd = s + replacement.length;
      if (mode === "select") {
        this._selectionStart = s;
        this._selectionEnd = replEnd;
      } else if (mode === "start") {
        this._selectionStart = s;
        this._selectionEnd = s;
      } else if (mode === "end") {
        this._selectionStart = replEnd;
        this._selectionEnd = replEnd;
      } else {
        const delta = replacement.length - (e - s);
        let ss = this._selectionStart != null ? this._selectionStart : len;
        let se = this._selectionEnd != null ? this._selectionEnd : len;
        if (ss > e) ss += delta;
        else if (ss > s) ss = replEnd;
        if (se > e) se += delta;
        else if (se > s) se = replEnd;
        this._selectionStart = ss;
        this._selectionEnd = se;
      }
    }
    select() {
      this.focus();
      this._selectionStart = 0;
      this._selectionEnd = (this._attrs.value || "").length;
      try {
        dispatchEvent(this, new Event("select", { bubbles: true, cancelable: false }));
      } catch (_) {
      }
    }
    // File-input `.files` accessor. Set by `globalThis.__csimSetFiles` after
    // `attach_file`; each entry is a File-shaped object with name /
    // size / type / lastModified. Libraries that iterate input.files
    // (Redmine's `uploadAndAttachFiles`, drag-drop handlers reading
    // `dataTransfer.files`) see something usable. The actual byte
    // stream isn't carried here — the multipart serialiser pulls the
    // file contents from `@file_picks` on the Ruby side at form-submit
    // time.
    get files() {
      if (this._tag !== "input") return null;
      const t = (this._attrs.type || "").toLowerCase();
      if (t !== "file") return null;
      const list = this._files || [];
      list.item = function(i) {
        return this[i] || null;
      };
      return list;
    }
    // HTML lets you assign a `FileList` to a file input programmatically — the
    // canonical pattern is `input.files = dataTransfer.files` (drag-drop libraries,
    // and the kamalog `attach-images` Stimulus controller, do exactly this). Accept
    // any array-like of File objects; null/undefined clears the selection.
    set files(value) {
      if (this._tag !== "input") return;
      if ((this._attrs.type || "").toLowerCase() !== "file") return;
      this._files = value == null ? [] : Array.from(value);
    }
    // In an XML/XHTML document `innerHTML` getting is the XML serialization of the
    // children (require-well-formed), not the HTML serialization.
    get innerHTML() {
      return isHtmlDocument(this.ownerDocument) ? serializeChildren(this) : xmlSerializeInner(this);
    }
    set innerHTML(html) {
      if (!isHtmlDocument(this.ownerDocument)) {
        const doc = this.ownerDocument;
        const parsed = parseXmlFragment(html, this);
        const removed = this._children.slice();
        for (const c of removed) {
          c._parent = null;
          unregisterSubtree(c);
        }
        this._children = newChildList();
        for (const c of parsed) {
          doc.adoptNode(c);
          c._parent = this;
          this._children.push(c);
          registerSubtree(c);
        }
        if (removed.length || parsed.length) recordChildList(this, parsed, removed);
        return;
      }
      if (this._tag === "template") {
        const frag2 = this.content;
        const tmplRemoved = frag2._children.slice();
        for (const c of tmplRemoved) {
          c._parent = null;
          unregisterSubtree(c);
        }
        frag2._children = newChildList();
        const parsed = parseFragment(String(html === null ? "" : html));
        for (const c of parsed) {
          c._parent = frag2;
          frag2._children.push(c);
          registerSubtree(c);
        }
        bumpSettleGen();
        return;
      }
      const removedChildren = this._children.slice();
      for (const c of removedChildren) {
        c._parent = null;
        unregisterSubtree(c);
      }
      this._children = newChildList();
      let frag;
      if (this._tag === "html") {
        const parsed = parseDocument(String(html === null ? "" : html));
        frag = parsed.documentElement ? parsed.documentElement._children.slice() : [];
      } else {
        frag = parseFragment(String(html === null ? "" : html));
      }
      const ownerDoc = this.ownerDocument;
      const adopt = ownerDoc && ownerDoc !== globalThis.document && typeof ownerDoc.adoptNode === "function";
      for (const c of frag) {
        if (adopt) ownerDoc.adoptNode(c);
        c._parent = this;
        this._children.push(c);
        registerSubtree(c);
      }
      if (removedChildren.length || frag.length) {
        recordChildList(this, frag, removedChildren);
      }
    }
    // In an XML/XHTML document `outerHTML` getting is the XML serialization of the
    // element itself (require-well-formed), mirroring the innerHTML getter.
    get outerHTML() {
      return isHtmlDocument(this.ownerDocument) ? serializeElement(this) : xmlSerializeOuter(this);
    }
    // `el.outerHTML = html` (DOM Parsing spec): parse `html` as a fragment and
    // replace this element with the result, within this element's parent.
    set outerHTML(html) {
      const parent = this._parent;
      if (parent == null) return;
      if (parent.nodeType === NODE_DOC) {
        throw new globalThis.DOMException("Cannot set the 'outerHTML' property on an element whose parent is a Document.", "NoModificationAllowedError");
      }
      const nodes = isHtmlDocument(this.ownerDocument) ? parseFragment(html === null ? "" : String(html)) : parseXmlFragment(html, parent);
      parent._replaceChildWithNodes(this, nodes);
    }
    // `insertAdjacentHTML(position, html)` — DOM spec method. Forem's
    // initializeBroadcast uses `el.insertAdjacentHTML('afterbegin', …)`
    // to inject the announcement banner. Positions: `beforebegin` /
    // `afterbegin` / `beforeend` / `afterend`.
    insertAdjacentHTML(position, html) {
      const pos = String(position).toLowerCase();
      if (pos === "beforebegin" || pos === "afterend") {
        if (!this._parent || this._parent.nodeType === NODE_DOC) {
          throw new globalThis.DOMException("Cannot insert adjacent HTML: the element has no parent.", "NoModificationAllowedError");
        }
      } else if (pos !== "afterbegin" && pos !== "beforeend") {
        throw new globalThis.DOMException("The value provided ('" + position + "') is not one of 'beforeBegin', 'afterBegin', 'beforeEnd', or 'afterEnd'.", "SyntaxError");
      }
      const frag = isHtmlDocument(this.ownerDocument) ? parseFragment(String(html === null ? "" : html)) : parseXmlFragment(html, pos === "beforebegin" || pos === "afterend" ? this._parent : this);
      if (pos === "beforebegin") {
        for (const c of frag) this._parent.insertBefore(c, this);
      } else if (pos === "afterbegin") {
        const first = this._children[0] || null;
        for (const c of frag) this.insertBefore(c, first);
      } else if (pos === "beforeend") {
        for (const c of frag) this.appendChild(c);
      } else {
        const next = this.nextSibling;
        for (const c of frag) this._parent.insertBefore(c, next);
      }
    }
    // Shared "insert adjacent" core for insertAdjacentElement / insertAdjacentText
    // (NOT insertAdjacentHTML, which has its own context algorithm). beforebegin /
    // afterend with no parent return null; an unknown position is a SyntaxError;
    // a Document parent surfaces as HierarchyRequestError from the pre-insertion
    // validity inside insertBefore (NOT the NoModificationAllowedError that
    // insertAdjacentHTML raises).
    _insertAdjacent(position, node) {
      const pos = String(position).toLowerCase();
      if (pos === "beforebegin") {
        if (!this._parent) return null;
        this._parent.insertBefore(node, this);
      } else if (pos === "afterbegin") {
        this.insertBefore(node, this._children[0] || null);
      } else if (pos === "beforeend") {
        this.appendChild(node);
      } else if (pos === "afterend") {
        if (!this._parent) return null;
        this._parent.insertBefore(node, this.nextSibling);
      } else throw new globalThis.DOMException("The value provided ('" + position + "') is not one of 'beforeBegin', 'afterBegin', 'beforeEnd', or 'afterEnd'.", "SyntaxError");
      return node;
    }
    insertAdjacentText(position, text) {
      this._insertAdjacent(position, this.ownerDocument.createTextNode(String(text == null ? "" : text)));
    }
    insertAdjacentElement(position, element) {
      if (element == null || element.nodeType !== NODE_ELEMENT) {
        throw new TypeError("Failed to execute 'insertAdjacentElement' on 'Element': parameter 2 is not of type 'Element'.");
      }
      return this._insertAdjacent(position, element);
    }
    attachShadow(init) {
      const mode = init && init.mode;
      if (mode !== "open" && mode !== "closed") {
        throw new globalThis.TypeError("Failed to execute 'attachShadow' on 'Element': The provided value '" + mode + "' is not a valid enum value of type ShadowRootMode.");
      }
      const slotAssignment = init && init.slotAssignment !== void 0 ? String(init.slotAssignment) : "named";
      if (slotAssignment !== "named" && slotAssignment !== "manual") {
        throw new globalThis.TypeError("Failed to execute 'attachShadow' on 'Element': The provided value '" + slotAssignment + "' is not a valid enum value of type SlotAssignmentMode.");
      }
      if (!canAttachShadow(this)) {
        throw new globalThis.DOMException("Failed to execute 'attachShadow' on 'Element': This element does not support attachShadow", "NotSupportedError");
      }
      if (this._shadowRoot) {
        throw new globalThis.DOMException("Failed to execute 'attachShadow' on 'Element': Shadow root cannot be created on a host which already hosts a shadow tree.", "NotSupportedError");
      }
      const sr = new ShadowRoot(this, mode, SHADOW_ROOT_INTERNAL);
      sr._slotAssignment = slotAssignment;
      sr._clonable = !!(init && init.clonable);
      this._shadowRoot = sr;
      shadowHostCount++;
      registerSubtree(sr);
      return sr;
    }
    get shadowRoot() {
      return this._shadowRoot && this._shadowRoot.mode === "open" ? this._shadowRoot : null;
    }
    // ── DOM Element method completeness (BATCH B2/B3) ───────────────
    hasAttributes() {
      return Object.keys(this._attrs).length > 0;
    }
    // `webkitMatchesSelector` is the legacy vendor alias of `matches`. Needs its
    // own arity guard: `this.matches(sel)` would pass an explicit `undefined`
    // (arity 1), so a no-arg `webkitMatchesSelector()` wouldn't otherwise throw.
    webkitMatchesSelector(sel) {
      if (arguments.length < 1) throw new TypeError("Failed to execute 'webkitMatchesSelector': 1 argument required, but only 0 present.");
      return this.matches(sel);
    }
    // Namespace-aware element queries collapse to the flat tag store.
    getElementsByTagNameNS(ns, local) {
      return liveHTMLCollection(() => collectByTagNameNS(this, ns, local));
    }
    getAttributeNodeNS(ns, localName) {
      const key = this._attrKeyByNS(ns == null ? null : String(ns), String(localName));
      return key == null ? null : this._attrNodeFor(key);
    }
    // `setAttributeNode(attr)` per https://dom.spec.whatwg.org/#dom-element-setattributenode:
    // adopt a real Attr into this element's attribute list, replacing any
    // existing attribute with the same (namespace, local name), and return the
    // replaced Attr (or null). Throws InUseAttributeError if `attr` is already
    // bound to a different element.
    setAttributeNode(attr) {
      if (!(attr instanceof Attr)) {
        throw new globalThis.DOMException("Argument to setAttributeNode is not an Attr.", "TypeMismatchError");
      }
      if (attr._ownerElement != null && attr._ownerElement !== this) {
        throw new globalThis.DOMException("The attribute is in use by another element.", "InUseAttributeError");
      }
      const key = this._attrKeyByNS(attr._ns, attr._localName);
      const oldAttr = key != null ? this._attrNodeFor(key) : null;
      if (oldAttr === attr) return attr;
      if (oldAttr) this._detachAttrNode(oldAttr._key);
      this._bindAttrNode(attr);
      return oldAttr;
    }
    setAttributeNodeNS(attr) {
      return this.setAttributeNode(attr);
    }
    // `removeAttributeNode(attr)` — detach `attr` from this element and return
    // it. NotFoundError if `attr` is not in this element's attribute list.
    removeAttributeNode(attr) {
      if (!(attr instanceof Attr) || attr._ownerElement !== this) {
        throw new globalThis.DOMException("The attribute is not owned by this element.", "NotFoundError");
      }
      this._removeAttrKey(attr._key);
      return attr;
    }
    // `slot` reflects the `slot` content attribute (shadow-DOM slotting).
    get slot() {
      return this._attrs.slot || "";
    }
    set slot(v) {
      this.setAttribute("slot", String(v == null ? "" : v));
    }
    // Slottable mixin: the slot this element is assigned to (open shadow trees
    // only — a slot inside a closed shadow tree is not observable here).
    get assignedSlot() {
      return findSlotForSlottable(this, true);
    }
    // HTMLSlotElement methods. Live on Element.prototype (every HTML interface
    // shares it) but only meaningful for a <slot>: on any other element they
    // return [] (findSlottables sees no enclosing shadow root for it). flatten
    // expands nested slots / fallback content; assignedElements drops Text.
    // slotAssignedNodes already returns a fresh array, so no defensive copy.
    assignedNodes(options) {
      return slotAssignedNodes(this, options);
    }
    assignedElements(options) {
      return slotAssignedNodes(this, options).filter((n) => n.nodeType === NODE_ELEMENT);
    }
    // HTMLSlotElement.assign((Element or Text)... nodes) — imperative slot
    // assignment. WebIDL takes a variadic, NOT a sequence: an array argument (or
    // any non-Element/Text node) is a TypeError. Meaningful only for a <slot> in
    // a manual-assignment shadow root; recording is harmless elsewhere.
    assign(...nodes) {
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        if (!n || n.nodeType !== NODE_ELEMENT && n.nodeType !== NODE_TEXT) {
          throw new TypeError("Failed to execute 'assign' on 'HTMLSlotElement': The provided value is not of type '(Element or Text)'.");
        }
      }
      assignManualSlottables(this, nodes);
    }
    // `scroll(...)` is the legacy synonym of `scrollTo(...)`.
    scroll(...args) {
      return this.scrollTo(...args);
    }
    // Pointer-capture API — no real pointer device, so capture is never
    // held. Methods are no-ops that satisfy feature-detecting callers.
    hasPointerCapture(_id) {
      return false;
    }
    setPointerCapture(_id) {
    }
    releasePointerCapture(_id) {
    }
    // HTML serialization helpers — `getHTML()` returns serialized
    // children; `setHTMLUnsafe(s)` parses markup into children. Both
    // route through the existing innerHTML path.
    getHTML(_options) {
      return this.innerHTML;
    }
    setHTMLUnsafe(markup) {
      const html = String(markup == null ? "" : markup);
      this.innerHTML = html;
    }
    // ── HTMLElement string / boolean reflection (BATCH C) ───────────
    get lang() {
      return this._attrs.lang || "";
    }
    set lang(v) {
      this.setAttribute("lang", String(v == null ? "" : v));
    }
    get dir() {
      return this._attrs.dir || "";
    }
    set dir(v) {
      this.setAttribute("dir", String(v == null ? "" : v));
    }
    get nonce() {
      return this._attrs.nonce || "";
    }
    set nonce(v) {
      this.setAttribute("nonce", String(v == null ? "" : v));
    }
    get accessKey() {
      return this._attrs.accesskey || "";
    }
    set accessKey(v) {
      this.setAttribute("accesskey", String(v == null ? "" : v));
    }
    get accessKeyLabel() {
      return "";
    }
    get autocapitalize() {
      return this._attrs.autocapitalize || "";
    }
    set autocapitalize(v) {
      this.setAttribute("autocapitalize", String(v == null ? "" : v));
    }
    get autocorrect() {
      return this._attrs.autocorrect || "";
    }
    set autocorrect(v) {
      this.setAttribute("autocorrect", String(v == null ? "" : v));
    }
    get enterKeyHint() {
      return this._attrs.enterkeyhint || "";
    }
    set enterKeyHint(v) {
      this.setAttribute("enterkeyhint", String(v == null ? "" : v));
    }
    get inputMode() {
      return this._attrs.inputmode || "";
    }
    set inputMode(v) {
      this.setAttribute("inputmode", String(v == null ? "" : v));
    }
    get virtualKeyboardPolicy() {
      return this._attrs.virtualkeyboardpolicy || "";
    }
    set virtualKeyboardPolicy(v) {
      this.setAttribute("virtualkeyboardpolicy", String(v == null ? "" : v));
    }
    // `draggable` is an enumerated attribute ('true' / 'false') reflected
    // as a boolean IDL. Missing-value default is TRUE for <img> and for
    // <a> / <area> with an href, false otherwise (HTML spec).
    get draggable() {
      const v = this._attrs.draggable;
      if (v != null) return v === "true";
      const t = this._tag;
      if (t === "img") return true;
      if ((t === "a" || t === "area") && this._attrs.href != null) return true;
      return false;
    }
    set draggable(v) {
      this.setAttribute("draggable", v ? "true" : "false");
    }
    // `spellcheck` / `translate` / `writingSuggestions` default to "on".
    get spellcheck() {
      return this._attrs.spellcheck !== "false";
    }
    set spellcheck(v) {
      this.setAttribute("spellcheck", v ? "true" : "false");
    }
    // `translate` is an INHERITED enumerated attribute (missing-value
    // default 'inherit'): an element with no own `translate` attr takes
    // the value from its nearest ancestor that has one; default true at
    // the root (HTML spec).
    get translate() {
      let el = this;
      while (el && el.nodeType === NODE_ELEMENT) {
        const v = el._attrs.translate;
        if (v === "yes") return true;
        if (v === "no") return false;
        el = el._parent;
      }
      return true;
    }
    set translate(v) {
      this.setAttribute("translate", v ? "yes" : "no");
    }
    get writingSuggestions() {
      return this._attrs.writingsuggestions !== "false";
    }
    set writingSuggestions(v) {
      this.setAttribute("writingsuggestions", v ? "true" : "false");
    }
    // `inert` / `autofocus` are plain boolean reflections.
    get inert() {
      return this.hasAttribute("inert");
    }
    set inert(v) {
      if (v) this.setAttribute("inert", "");
      else this.removeAttribute("inert");
    }
    get autofocus() {
      return this.hasAttribute("autofocus");
    }
    set autofocus(v) {
      if (v) this.setAttribute("autofocus", "");
      else this.removeAttribute("autofocus");
    }
    // `tabIndex` reflects `tabindex` as a long; default 0 for natively-
    // focusable elements, -1 otherwise.
    get tabIndex() {
      const n = parseInt(this._attrs.tabindex, 10);
      if (!Number.isNaN(n)) return n;
      const t = this._tag;
      if (t === "a" || t === "area" ? this._attrs.href != null : t === "button" || t === "input" || t === "select" || t === "textarea" || t === "iframe" || t === "details" || t === "summary") return 0;
      return -1;
    }
    set tabIndex(v) {
      this.setAttribute("tabindex", String(v));
    }
    // `contentEditable` enumerated reflection of `contenteditable`
    // (the boolean `isContentEditable` IDL lives elsewhere).
    get contentEditable() {
      const v = this._attrs.contenteditable;
      if (v == null) return "inherit";
      const lc = String(v).toLowerCase();
      if (lc === "" || lc === "true") return "true";
      if (lc === "false") return "false";
      if (lc === "plaintext-only") return "plaintext-only";
      return "inherit";
    }
    set contentEditable(v) {
      this.setAttribute("contenteditable", String(v == null ? "" : v));
    }
    // `outerText` getter mirrors `innerText`. The setter is writable in
    // real browsers (a getter-only accessor throws under strict mode).
    // Spec-wise it replaces the element *itself* with the assigned text
    // (newlines → <br>); we approximate by replacing the element's
    // content with a single Text node, which avoids the TypeError
    // regression and covers the common `el.outerText = str` usage.
    get outerText() {
      return this.innerText;
    }
    set outerText(v) {
      this.textContent = String(v == null ? "" : v);
    }
    // ── HTMLAnchorElement URL decomposition (BATCH E) ───────────────
    // Gate on the `<a>` / `<area>` tag and parse the resolved href.
    get hreflang() {
      return this._attrs.hreflang || "";
    }
    set hreflang(v) {
      this.setAttribute("hreflang", String(v == null ? "" : v));
    }
    get referrerPolicy() {
      return this._attrs.referrerpolicy || "";
    }
    set referrerPolicy(v) {
      this.setAttribute("referrerpolicy", String(v == null ? "" : v));
    }
    get rev() {
      return this._attrs.rev || "";
    }
    set rev(v) {
      this.setAttribute("rev", String(v == null ? "" : v));
    }
    get coords() {
      return this._attrs.coords || "";
    }
    set coords(v) {
      this.setAttribute("coords", String(v == null ? "" : v));
    }
    get shape() {
      return this._attrs.shape || "";
    }
    set shape(v) {
      this.setAttribute("shape", String(v == null ? "" : v));
    }
    get charset() {
      return this._attrs.charset || "";
    }
    set charset(v) {
      this.setAttribute("charset", String(v == null ? "" : v));
    }
    get ping() {
      return this._attrs.ping || "";
    }
    set ping(v) {
      this.setAttribute("ping", String(v == null ? "" : v));
    }
    // Per HTMLHyperlinkElementUtils, when the element's url is null (absent or
    // unparseable href) the `protocol` getter returns ':' (every other component
    // returns ''). Gated to a/area so a stray `div.protocol` stays ''.
    get protocol() {
      if (this._tag !== "a" && this._tag !== "area") return "";
      const u = anchorURL(this);
      return u ? u.protocol : ":";
    }
    set protocol(v) {
      anchorSetURL(this, (u) => {
        u.protocol = String(v);
      });
    }
    get host() {
      const u = anchorURL(this);
      return u ? u.host : "";
    }
    set host(v) {
      anchorSetURL(this, (u) => {
        u.host = String(v);
      });
    }
    get hostname() {
      const u = anchorURL(this);
      return u ? u.hostname : "";
    }
    set hostname(v) {
      anchorSetURL(this, (u) => {
        u.hostname = String(v);
      });
    }
    get port() {
      const u = anchorURL(this);
      return u ? u.port : "";
    }
    set port(v) {
      anchorSetURL(this, (u) => {
        u.port = String(v);
      });
    }
    get pathname() {
      const u = anchorURL(this);
      return u ? u.pathname : "";
    }
    set pathname(v) {
      anchorSetURL(this, (u) => {
        u.pathname = String(v);
      });
    }
    get search() {
      const u = anchorURL(this);
      return u ? u.search : "";
    }
    set search(v) {
      anchorSetURL(this, (u) => {
        u.search = String(v);
      });
    }
    get hash() {
      const u = anchorURL(this);
      return u ? u.hash : "";
    }
    set hash(v) {
      anchorSetURL(this, (u) => {
        u.hash = String(v);
      });
    }
    get origin() {
      const u = anchorURL(this);
      return u ? u.origin : "";
    }
    get username() {
      const u = anchorURL(this);
      return u ? u.username : "";
    }
    set username(v) {
      anchorSetURL(this, (u) => {
        u.username = String(v);
      });
    }
    get password() {
      const u = anchorURL(this);
      return u ? u.password : "";
    }
    set password(v) {
      anchorSetURL(this, (u) => {
        u.password = String(v);
      });
    }
    // Token-list reflections are element-type gated per the HTML spec: an
    // element that doesn't define the attribute exposes `undefined`, not a
    // stray DOMTokenList. `relList` is on a/area/link/form (HTML) plus <a> in
    // SVG; sandbox/sizes/htmlFor are each on a single HTML element.
    get relList() {
      const ns = this._ns, ln = this._localName;
      if (ns === HTML_NS2 && (ln === "a" || ln === "area" || ln === "link" || ln === "form") || ns === SVG_NS && ln === "a") return tokenListFor(this, "rel");
      return void 0;
    }
    get sandbox() {
      return this._ns === HTML_NS2 && this._localName === "iframe" ? tokenListFor(this, "sandbox") : void 0;
    }
    get sizes() {
      return this._ns === HTML_NS2 && this._localName === "link" ? tokenListFor(this, "sizes") : void 0;
    }
    // `htmlFor` is a DOMTokenList on <output> but a plain string ('for'
    // attribute) on <label>; undefined on everything else.
    get htmlFor() {
      if (this._ns !== HTML_NS2) return void 0;
      if (this._localName === "output") return tokenListFor(this, "for");
      if (this._localName === "label") return this.getAttribute("for") || "";
      return void 0;
    }
    // <output>.htmlFor is a [PutForwards=value] DOMTokenList and <label>.htmlFor
    // a plain string — both write the `for` attribute, so the setter is shared.
    set htmlFor(v) {
      if (this._ns === HTML_NS2 && (this._localName === "label" || this._localName === "output")) {
        this.setAttribute("for", String(v));
      }
    }
    // ── HTMLFormElement members (BATCH F) ───────────────────────────
    // `encoding` is the legacy alias of `enctype`.
    get encoding() {
      return this.enctype;
    }
    set encoding(v) {
      this.enctype = v;
    }
    // `acceptCharset` reflects the hyphenated `accept-charset` attribute.
    get acceptCharset() {
      return this._attrs["accept-charset"] || "";
    }
    set acceptCharset(v) {
      this.setAttribute("accept-charset", String(v == null ? "" : v));
    }
    get noValidate() {
      return this.hasAttribute("novalidate");
    }
    set noValidate(v) {
      if (v) this.setAttribute("novalidate", "");
      else this.removeAttribute("novalidate");
    }
    // `<form>.autocomplete` is enumerated 'on' / 'off' (default 'on').
    get autocomplete() {
      const v = (this._attrs.autocomplete || "").toLowerCase();
      return v === "off" ? "off" : "on";
    }
    set autocomplete(v) {
      this.setAttribute("autocomplete", String(v == null ? "" : v));
    }
    // `<form>.length` is the number of listed form controls.
    get length() {
      if (this._tag !== "form") return void 0;
      const els = this.elements;
      return els ? els.length : 0;
    }
    // `<form>.reset()` restores each control to its default value /
    // checkedness (the original content attribute) and dispatches a
    // cancelable `reset` event, per the HTML reset algorithm.
    reset() {
      if (this._tag !== "form") return;
      for (const el of this.elements || []) {
        const t = el._tag;
        if (t === "input") {
          const type = (el._attrs.type || "").toLowerCase();
          if (type === "checkbox" || type === "radio") {
            const def = el._defaultChecked !== void 0 ? el._defaultChecked : el.hasAttribute("checked");
            if (def) el._attrs.checked = "";
            else delete el._attrs.checked;
          } else {
            el._attrs.value = el._defaultValue !== void 0 ? el._defaultValue : el.getAttribute("value") || "";
          }
        } else if (t === "textarea") {
          el._attrs.value = el._defaultValue !== void 0 ? el._defaultValue : el.value;
        } else if (t === "select") {
          for (const o of el.querySelectorAll("option")) {
            if (o.getAttributeNode("selected")) o._attrs.selected = "";
            else delete o._attrs.selected;
          }
        }
      }
      try {
        dispatchEvent(this, new Event("reset", { bubbles: true, cancelable: true }));
      } catch (_) {
      }
    }
  };
  function anchorURL(el) {
    if (el._tag !== "a" && el._tag !== "area") return null;
    const href = el.href;
    if (!href) return null;
    try {
      return new globalThis.URL(href);
    } catch (_) {
      return null;
    }
  }
  __name(anchorURL, "anchorURL");
  function anchorSetURL(el, mutate) {
    const u = anchorURL(el);
    if (!u) return;
    try {
      mutate(u);
      el.href = u.href;
    } catch (_) {
    }
  }
  __name(anchorSetURL, "anchorSetURL");
  function fragmentNavigate(anchor) {
    const target = String(anchor._attrs.target || "").toLowerCase();
    if (target && target !== "_self") return false;
    const rawHref = anchor._attrs.href || "";
    if (rawHref.indexOf("#") === -1 && (globalThis.location.href || "").indexOf("#") === -1) return false;
    return tryFragmentNavigate(anchor.href);
  }
  __name(fragmentNavigate, "fragmentNavigate");
  var ARIA_REFLECTED_ATTRS = {
    role: "role",
    ariaAtomic: "aria-atomic",
    ariaAutoComplete: "aria-autocomplete",
    ariaBusy: "aria-busy",
    ariaChecked: "aria-checked",
    ariaColCount: "aria-colcount",
    ariaColIndex: "aria-colindex",
    ariaColIndexText: "aria-colindextext",
    ariaColSpan: "aria-colspan",
    ariaCurrent: "aria-current",
    ariaDescription: "aria-description",
    ariaDisabled: "aria-disabled",
    ariaExpanded: "aria-expanded",
    ariaHasPopup: "aria-haspopup",
    ariaHidden: "aria-hidden",
    ariaInvalid: "aria-invalid",
    ariaKeyShortcuts: "aria-keyshortcuts",
    ariaLabel: "aria-label",
    ariaLevel: "aria-level",
    ariaLive: "aria-live",
    ariaModal: "aria-modal",
    ariaMultiLine: "aria-multiline",
    ariaMultiSelectable: "aria-multiselectable",
    ariaOrientation: "aria-orientation",
    ariaPlaceholder: "aria-placeholder",
    ariaPosInSet: "aria-posinset",
    ariaPressed: "aria-pressed",
    ariaReadOnly: "aria-readonly",
    ariaRelevant: "aria-relevant",
    ariaRequired: "aria-required",
    ariaRoleDescription: "aria-roledescription",
    ariaRowCount: "aria-rowcount",
    ariaRowIndex: "aria-rowindex",
    ariaRowIndexText: "aria-rowindextext",
    ariaRowSpan: "aria-rowspan",
    ariaSelected: "aria-selected",
    ariaSetSize: "aria-setsize",
    ariaSort: "aria-sort",
    ariaValueMax: "aria-valuemax",
    ariaValueMin: "aria-valuemin",
    ariaValueNow: "aria-valuenow",
    ariaValueText: "aria-valuetext",
    ariaBrailleLabel: "aria-braillelabel",
    ariaBrailleRoleDescription: "aria-brailleroledescription"
  };
  for (const idl of Object.keys(ARIA_REFLECTED_ATTRS)) {
    const attr = ARIA_REFLECTED_ATTRS[idl];
    Object.defineProperty(Element.prototype, idl, {
      configurable: true,
      enumerable: false,
      get() {
        const v = this._attrs[attr];
        return v == null ? null : v;
      },
      set(value) {
        if (value == null) this.removeAttribute(attr);
        else this.setAttribute(attr, String(value));
      }
    });
  }
  var ARIA_ELEMENT_REF_ATTRS = {
    ariaActiveDescendantElement: "aria-activedescendant"
  };
  var ARIA_ELEMENT_REFLIST_ATTRS = {
    ariaControlsElements: "aria-controls",
    ariaDescribedByElements: "aria-describedby",
    ariaDetailsElements: "aria-details",
    ariaErrorMessageElements: "aria-errormessage",
    ariaFlowToElements: "aria-flowto",
    ariaLabelledByElements: "aria-labelledby",
    ariaOwnsElements: "aria-owns"
  };
  function __ariaRefDoc(el) {
    return el && el.ownerDocument || globalThis.document || null;
  }
  __name(__ariaRefDoc, "__ariaRefDoc");
  function __ariaClearSlot(el, idl) {
    if (el._attrElements) delete el._attrElements[idl];
  }
  __name(__ariaClearSlot, "__ariaClearSlot");
  function __ariaStoreSlot(el, idl, value) {
    (el._attrElements || (el._attrElements = /* @__PURE__ */ Object.create(null)))[idl] = value;
  }
  __name(__ariaStoreSlot, "__ariaStoreSlot");
  for (const idl of Object.keys(ARIA_ELEMENT_REF_ATTRS)) {
    const attr = ARIA_ELEMENT_REF_ATTRS[idl];
    Object.defineProperty(Element.prototype, idl, {
      configurable: true,
      enumerable: false,
      get() {
        if (this._attrElements && idl in this._attrElements) return this._attrElements[idl] || null;
        const id = this._attrs[attr];
        if (id == null || id === "") return null;
        const doc = __ariaRefDoc(this);
        return doc && doc.getElementById(String(id)) || null;
      },
      set(value) {
        if (value == null) {
          __ariaClearSlot(this, idl);
          this.removeAttribute(attr);
          return;
        }
        __ariaStoreSlot(this, idl, value);
        this.setAttribute(attr, "");
      }
    });
  }
  for (const idl of Object.keys(ARIA_ELEMENT_REFLIST_ATTRS)) {
    const attr = ARIA_ELEMENT_REFLIST_ATTRS[idl];
    Object.defineProperty(Element.prototype, idl, {
      configurable: true,
      enumerable: false,
      get() {
        if (this._attrElements && idl in this._attrElements) return this._attrElements[idl];
        const raw = this._attrs[attr];
        if (raw == null || raw === "") return null;
        const doc = __ariaRefDoc(this);
        if (!doc) return null;
        const out = [];
        for (const id of String(raw).split(/\s+/)) {
          if (!id) continue;
          const el = doc.getElementById(id);
          if (el) out.push(el);
        }
        return Object.freeze(out);
      },
      set(value) {
        if (value == null) {
          __ariaClearSlot(this, idl);
          this.removeAttribute(attr);
          return;
        }
        if (typeof value !== "object" || typeof value[Symbol.iterator] !== "function") {
          throw new TypeError("Failed to set the '" + idl + "' property on 'Element': The provided value is not iterable.");
        }
        __ariaStoreSlot(this, idl, Object.freeze(Array.from(value)));
        this.setAttribute(attr, "");
      }
    });
  }
  Object.defineProperty(Element.prototype, "customElementRegistry", {
    configurable: true,
    enumerable: false,
    get() {
      return globalThis.customElements || null;
    }
  });
  var FormNamedProto = Object.create(Element.prototype);
  var FORM_NAMED_PROPS = /* @__PURE__ */ new Set();
  var FORM_NAMED_TAGS = /* @__PURE__ */ new Set(["input", "select", "textarea", "button", "fieldset", "object"]);
  function formNamedLookup(form, name) {
    if (!form || form._tag !== "form") return void 0;
    const els = form.elements;
    if (els) for (const c of els) {
      if (c._attrs && (c._attrs.name === name || c._attrs.id === name)) return c;
    }
    return void 0;
  }
  __name(formNamedLookup, "formNamedLookup");
  function registerFormName(el, value) {
    if (!value || !FORM_NAMED_TAGS.has(el._tag)) return;
    if (FORM_NAMED_PROPS.has(value)) return;
    FORM_NAMED_PROPS.add(value);
    if (value in FormNamedProto) return;
    Object.defineProperty(FormNamedProto, value, {
      configurable: true,
      enumerable: false,
      get() {
        return formNamedLookup(this, value);
      },
      // Assigning `form.<name> = x` creates an OWN property that shadows the
      // named getter — matching browser LegacyPlatformObject semantics (named
      // properties are configurable). Without a setter, strict-mode assignment
      // to a getter-only property THROWS; jQuery stores its private-data expando
      // directly on the element (`form[expando] = cache`) and also parks its
      // marker on `id`/`name` during scoped queries, so a getter-only named prop
      // would break every form jQuery binds an event to or calls `.data()` on.
      set(v) {
        Object.defineProperty(this, value, { value: v, writable: true, enumerable: true, configurable: true });
      }
    });
  }
  __name(registerFormName, "registerFormName");
  var WINDOW_NAMED_PROPS = /* @__PURE__ */ new Set();
  var WINDOW_NAME_VALUES = /* @__PURE__ */ new Set();
  var WINDOW_NAME_TAGS = /* @__PURE__ */ new Set(["a", "applet", "area", "embed", "form", "frameset", "frame", "iframe", "img", "object"]);
  var WindowNamedProps = Object.create(Object.getPrototypeOf(globalThis));
  if (!globalThis.__csimWindowNamedProps) {
    globalThis.__csimWindowNamedProps = WindowNamedProps;
    Object.setPrototypeOf(globalThis, WindowNamedProps);
  }
  function windowNamedLookup(name) {
    const doc = globalThis.document;
    if (!doc) return void 0;
    const byId3 = doc.getElementById && doc.getElementById(name);
    if (byId3) return byId3;
    if (!WINDOW_NAME_VALUES.has(name)) return void 0;
    let found;
    walkSubtree(doc, (el) => {
      if (found || el.nodeType !== NODE_ELEMENT) return;
      if (WINDOW_NAME_TAGS.has(el._tag) && el._attrs && el._attrs.name === name) found = el;
    });
    return found;
  }
  __name(windowNamedLookup, "windowNamedLookup");
  function registerWindowName(el, attrName, value) {
    if (!value) return;
    if (attrName === "name") {
      if (!WINDOW_NAME_TAGS.has(el._tag)) return;
      WINDOW_NAME_VALUES.add(value);
    }
    if (WINDOW_NAMED_PROPS.has(value)) return;
    WINDOW_NAMED_PROPS.add(value);
    if (value in globalThis) return;
    Object.defineProperty(globalThis.__csimWindowNamedProps, value, {
      configurable: true,
      enumerable: false,
      get() {
        return windowNamedLookup(value);
      },
      // As with form named access, assignment shadows the getter with an own
      // property (configurable named properties); without a setter, strict-mode
      // `window.foo = x` for an id-named `foo` would throw.
      set(v) {
        Object.defineProperty(globalThis, value, { value: v, writable: true, enumerable: true, configurable: true });
      }
    });
  }
  __name(registerWindowName, "registerWindowName");
  function registerNamedAccess(el, attrName, value) {
    registerFormName(el, value);
    registerWindowName(el, attrName, value);
  }
  __name(registerNamedAccess, "registerNamedAccess");
  var DocumentFragment = class extends Node {
    static {
      __name(this, "DocumentFragment");
    }
    constructor() {
      super();
      this.nodeType = NODE_FRAGMENT;
    }
    get nodeName() {
      return "#document-fragment";
    }
    get ownerDocument() {
      return this._ownerDoc || globalThis.document;
    }
    get innerHTML() {
      return isHtmlDocument(this.ownerDocument) ? serializeChildren(this) : xmlSerializeInner(this);
    }
    set innerHTML(html) {
      const removed = this._children.slice();
      const isHtml = isHtmlDocument(this.ownerDocument);
      const parsed = isHtml ? parseFragment(String(html === null ? "" : html)) : parseXmlFragment(html, this);
      const doc = this.ownerDocument;
      for (const c of removed) {
        c._parent = null;
        unregisterSubtree(c);
      }
      this._children = newChildList();
      const added = [];
      for (const c of parsed) {
        if (!isHtml) doc.adoptNode(c);
        c._parent = this;
        this._children.push(c);
        registerSubtree(c);
        added.push(c);
      }
      if (removed.length > 0 || added.length > 0) {
        recordChildList(this, added, removed);
      }
    }
    querySelector(sel) {
      if (arguments.length < 1) throw new TypeError("Failed to execute 'querySelector': 1 argument required, but only 0 present.");
      return selectFirst(this._children, sel, this);
    }
    querySelectorAll(sel) {
      if (arguments.length < 1) throw new TypeError("Failed to execute 'querySelectorAll': 1 argument required, but only 0 present.");
      return nodeList(selectAll(this._children, sel, this));
    }
    getElementById(id) {
      return findById(this, id);
    }
    // `getElementsByTagName('*')` on a context node must work for a
    // ShadowRoot too — inherit Element's behaviour so a ShadowRoot
    // context resolves
    // `.//*[@id=…]` against its own subtree.
    getElementsByTagName(tag) {
      const t = String(tag).toLowerCase();
      return liveHTMLCollection(() => {
        const all = t === "*" ? this.querySelectorAll("*") : this.querySelectorAll(t);
        return all.filter((n) => n !== this);
      });
    }
    getElementsByClassName(cls) {
      return liveHTMLCollection(() => collectByClassName(this, cls));
    }
  };
  globalThis.DocumentFragment = DocumentFragment;
  var SHADOW_ROOT_INTERNAL = {};
  var ShadowRoot = class extends DocumentFragment {
    static {
      __name(this, "ShadowRoot");
    }
    constructor(host, mode, token) {
      if (token !== SHADOW_ROOT_INTERNAL) throw new TypeError("Illegal constructor");
      super();
      this.host = host;
      this.mode = mode || "open";
      this._isShadowRoot = true;
      this._parent = host;
    }
    get nodeName() {
      return "#shadow-root";
    }
    // A shadow root has no parent in the node tree — `parentNode` / `parentElement`
    // are always null (its host is reached via `.host`, not as a parent). The
    // internal `_parent` slot still points at the host so the event-dispatch walk
    // and isConnected climb across the boundary; only the public accessors hide it.
    get parentNode() {
      return null;
    }
    get parentElement() {
      return null;
    }
    // A shadow root's node document is its host's node document (DOM: the shadow
    // root is created in the host's document). This also drives adoption — a node
    // inserted into the shadow tree is adopted into the host's document, since
    // adoptIntoParent reads the parent's ownerDocument.
    get ownerDocument() {
      return this.host ? this.host.ownerDocument : this._ownerDoc || globalThis.document;
    }
    // The slot-assignment mode chosen at attachShadow time ('named' | 'manual').
    get slotAssignment() {
      return this._slotAssignment || "named";
    }
    // Whether cloneNode of the host duplicates this shadow tree (attachShadow
    // `clonable`); declarative shadow roots opt in via `shadowrootclonable`.
    get clonable() {
      return !!this._clonable;
    }
    // DocumentOrShadowRoot.activeElement: the focused element when it lives in
    // THIS shadow tree (and is still connected), else null.
    get activeElement() {
      const ae = globalThis.document && globalThis.document._activeElement;
      if (!ae || !ae.isConnected) return null;
      return enclosingShadowRoot(ae) === this ? ae : null;
    }
    // DocumentOrShadowRoot.styleSheets: a StyleSheetList of the CSSStyleSheets of
    // the <style>/<link> elements in this tree (the element's own `.sheet`, so
    // identity matches; null — hence empty — while the root is disconnected).
    get styleSheets() {
      const list = [];
      walkSubtree(this, (n) => {
        if (n.nodeType === NODE_ELEMENT && (n._tag === "style" || n._tag === "link")) {
          const s = n.sheet;
          if (s) list.push(s);
        }
      });
      list.item = (i) => list[i] || null;
      return list;
    }
  };
  globalThis.ShadowRoot = ShadowRoot;
  var shadowHostCount = 0;
  var SHADOW_HOST_TAGS = /* @__PURE__ */ new Set([
    "article",
    "aside",
    "blockquote",
    "body",
    "div",
    "footer",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "header",
    "main",
    "nav",
    "p",
    "section",
    "span"
  ]);
  function canAttachShadow(el) {
    if (el._ns !== HTML_NS2) return false;
    const ln = el._localName;
    return SHADOW_HOST_TAGS.has(ln) || ln.indexOf("-") !== -1;
  }
  __name(canAttachShadow, "canAttachShadow");
  function isSlottable(node) {
    return node && (node.nodeType === NODE_ELEMENT || node.nodeType === NODE_TEXT);
  }
  __name(isSlottable, "isSlottable");
  function slottableName(node) {
    return node.nodeType === NODE_ELEMENT ? node._attrs.slot || "" : "";
  }
  __name(slottableName, "slottableName");
  function enclosingShadowRoot(node) {
    for (let n = node; n; n = n._parent) {
      if (n._isShadowRoot) return n;
    }
    return null;
  }
  __name(enclosingShadowRoot, "enclosingShadowRoot");
  function isHtmlSlot(el) {
    return el._tag === "slot" && el._ns === HTML_NS2;
  }
  __name(isHtmlSlot, "isHtmlSlot");
  function slotNameMap(sr) {
    const map = /* @__PURE__ */ new Map();
    walk(sr, (el) => {
      if (!isHtmlSlot(el)) return;
      const n = el._attrs.name || "";
      if (!map.has(n)) map.set(n, el);
    });
    return map;
  }
  __name(slotNameMap, "slotNameMap");
  function findSlotForSlottable(node, openOnly) {
    const parent = node._parent;
    if (!parent) return null;
    const sr = parent._shadowRoot;
    if (!sr) return null;
    if (openOnly && sr.mode !== "open") return null;
    if (sr.slotAssignment === "manual") {
      const slot = node._manualSlot;
      return slot && enclosingShadowRoot(slot) === sr ? slot : null;
    }
    return slotNameMap(sr).get(slottableName(node)) || null;
  }
  __name(findSlotForSlottable, "findSlotForSlottable");
  function findSlottables(slot) {
    const sr = enclosingShadowRoot(slot);
    if (!sr) return [];
    if (sr.slotAssignment === "manual") return manualSlottablesForSlot(sr, slot);
    return slottablesForSlot(sr, slot, slotNameMap(sr));
  }
  __name(findSlottables, "findSlottables");
  function manualSlottablesForSlot(sr, slot) {
    const host = sr.host;
    const list = slot._manualAssignedNodes || EMPTY_NODES;
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const n = list[i];
      if (n._parent === host && isSlottable(n)) out.push(n);
    }
    return out;
  }
  __name(manualSlottablesForSlot, "manualSlottablesForSlot");
  function assignManualSlottables(slot, nodes) {
    const seen = /* @__PURE__ */ new Set();
    const deduped = [];
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (!seen.has(n)) {
        seen.add(n);
        deduped.push(n);
      }
    }
    const touched = /* @__PURE__ */ new Set();
    const here = enclosingShadowRoot(slot);
    if (here) touched.add(here);
    const prev = slot._manualAssignedNodes || EMPTY_NODES;
    for (let i = 0; i < prev.length; i++) {
      if (prev[i]._manualSlot === slot) prev[i]._manualSlot = null;
    }
    for (let i = 0; i < deduped.length; i++) {
      const n = deduped[i], old = n._manualSlot;
      if (old && old !== slot) {
        old._manualAssignedNodes = (old._manualAssignedNodes || EMPTY_NODES).filter((x) => x !== n);
        const osr = enclosingShadowRoot(old);
        if (osr) touched.add(osr);
      }
    }
    slot._manualAssignedNodes = deduped;
    for (let i = 0; i < deduped.length; i++) deduped[i]._manualSlot = slot;
    for (const sr of touched) assignSlottablesForShadowRoot(sr);
  }
  __name(assignManualSlottables, "assignManualSlottables");
  function slottablesForSlot(sr, slot, map) {
    const kids = sr.host._children;
    const out = [];
    for (let i = 0; i < kids.length; i++) {
      const c = kids[i];
      if (isSlottable(c) && map.get(slottableName(c)) === slot) out.push(c);
    }
    return out;
  }
  __name(slottablesForSlot, "slottablesForSlot");
  function findFlattenedSlottables(slot) {
    if (!enclosingShadowRoot(slot)) return [];
    let slottables = findSlottables(slot);
    if (slottables.length === 0) {
      const kids = slot._children;
      for (let i = 0; i < kids.length; i++) if (isSlottable(kids[i])) slottables.push(kids[i]);
    }
    const out = [];
    for (const s of slottables) {
      if (s.nodeType === NODE_ELEMENT && isHtmlSlot(s) && enclosingShadowRoot(s)) {
        const inner = findFlattenedSlottables(s);
        for (let i = 0; i < inner.length; i++) out.push(inner[i]);
      } else {
        out.push(s);
      }
    }
    return out;
  }
  __name(findFlattenedSlottables, "findFlattenedSlottables");
  function slotAssignedNodes(slot, options) {
    return options && options.flatten === true ? findFlattenedSlottables(slot) : findSlottables(slot);
  }
  __name(slotAssignedNodes, "slotAssignedNodes");
  function flatTreeAssignedSlot(node) {
    return findSlotForSlottable(node, false);
  }
  __name(flatTreeAssignedSlot, "flatTreeAssignedSlot");
  function isSlottableNode(node) {
    return isSlottable(node);
  }
  __name(isSlottableNode, "isSlottableNode");
  function hasShadowRoots() {
    return shadowHostCount > 0;
  }
  __name(hasShadowRoots, "hasShadowRoots");
  var EMPTY_NODES = [];
  function sameNodeList(a, b) {
    if (a === b) return true;
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  __name(sameNodeList, "sameNodeList");
  function assignSlottablesForShadowRoot(sr) {
    if (sr.slotAssignment === "manual") {
      const mslots = [];
      walk(sr, (el) => {
        if (isHtmlSlot(el)) mslots.push(el);
      });
      for (const slot of mslots) {
        const assigned = manualSlottablesForSlot(sr, slot);
        if (!sameNodeList(slot._assignedSnapshot || EMPTY_NODES, assigned)) {
          slot._assignedSnapshot = assigned;
          signalSlotChange(slot);
        }
      }
      return;
    }
    const slots = [];
    const map = /* @__PURE__ */ new Map();
    walk(sr, (el) => {
      if (!isHtmlSlot(el)) return;
      slots.push(el);
      const n = el._attrs.name || "";
      if (!map.has(n)) map.set(n, el);
    });
    if (!slots.length) return;
    const buckets = /* @__PURE__ */ new Map();
    const kids = sr.host._children;
    for (let i = 0; i < kids.length; i++) {
      const c = kids[i];
      if (!isSlottable(c)) continue;
      const slot = map.get(slottableName(c));
      if (!slot) continue;
      const b = buckets.get(slot);
      if (b) b.push(c);
      else buckets.set(slot, [c]);
    }
    for (const slot of slots) {
      const assigned = buckets.get(slot) || EMPTY_NODES;
      if (!sameNodeList(slot._assignedSnapshot || EMPTY_NODES, assigned)) {
        slot._assignedSnapshot = assigned;
        signalSlotChange(slot);
      }
    }
  }
  __name(assignSlottablesForShadowRoot, "assignSlottablesForShadowRoot");
  function subtreeHasSlot(nodes) {
    if (!nodes || !nodes.length) return false;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (!n || n.nodeType !== NODE_ELEMENT) continue;
      if (isHtmlSlot(n) || walkFind(n, isHtmlSlot)) return true;
    }
    return false;
  }
  __name(subtreeHasSlot, "subtreeHasSlot");
  function signalSlotIfChanged(slot) {
    const assigned = findSlottables(slot);
    if (!sameNodeList(slot._assignedSnapshot || EMPTY_NODES, assigned)) {
      slot._assignedSnapshot = assigned;
      signalSlotChange(slot);
    }
  }
  __name(signalSlotIfChanged, "signalSlotIfChanged");
  function signalRemovedSlots(removed) {
    for (let i = 0; i < removed.length; i++) {
      const n = removed[i];
      if (!n || n.nodeType !== NODE_ELEMENT) continue;
      walk(n, (el) => {
        if (isHtmlSlot(el)) signalSlotIfChanged(el);
      });
    }
  }
  __name(signalRemovedSlots, "signalRemovedSlots");
  setSlotMutationHooks(
    /* @__PURE__ */ __name(function onChildListMutation(target, added, removed) {
      if (!shadowHostCount || !target) return;
      if (target._shadowRoot) assignSlottablesForShadowRoot(target._shadowRoot);
      if (subtreeHasSlot(removed)) signalRemovedSlots(removed);
      if (subtreeHasSlot(added) || subtreeHasSlot(removed)) {
        const sr = enclosingShadowRoot(target);
        if (sr) assignSlottablesForShadowRoot(sr);
      }
      if (isHtmlSlot(target) && enclosingShadowRoot(target)) {
        for (let s = target; s && isHtmlSlot(s); s = s._parent) {
          if (findSlottables(s).length) break;
          signalSlotChange(s);
        }
      }
    }, "onChildListMutation"),
    /* @__PURE__ */ __name(function onAttrMutation(target, key) {
      if (!shadowHostCount || !target) return;
      if (key === "slot") {
        const host = target._parent;
        if (host && host._shadowRoot) assignSlottablesForShadowRoot(host._shadowRoot);
      } else if (isHtmlSlot(target)) {
        const sr = enclosingShadowRoot(target);
        if (sr) assignSlottablesForShadowRoot(sr);
      }
    }, "onAttrMutation")
  );
  setSlotChangeFirer(/* @__PURE__ */ __name(function fireSlotChange(slot) {
    try {
      slot.dispatchEvent(new globalThis.Event("slotchange", { bubbles: true }));
    } catch (_) {
    }
  }, "fireSlotChange"));
  var GLOBAL_EVENT_HANDLER_ATTRS = [
    "onabort",
    "onblur",
    "oncancel",
    "oncanplay",
    "oncanplaythrough",
    "onchange",
    "onclick",
    "onclose",
    "oncontextmenu",
    "oncopy",
    "oncuechange",
    "oncut",
    "ondblclick",
    "ondrag",
    "ondragend",
    "ondragenter",
    "ondragleave",
    "ondragover",
    "ondragstart",
    "ondrop",
    "ondurationchange",
    "onemptied",
    "onended",
    "onerror",
    "onfocus",
    "oninput",
    "oninvalid",
    "onkeydown",
    "onkeypress",
    "onkeyup",
    "onload",
    "onloadeddata",
    "onloadedmetadata",
    "onloadstart",
    "onmousedown",
    "onmouseenter",
    "onmouseleave",
    "onmousemove",
    "onmouseout",
    "onmouseover",
    "onmouseup",
    "onpaste",
    "onpause",
    "onplay",
    "onplaying",
    "onprogress",
    "onratechange",
    "onreset",
    "onresize",
    "onscroll",
    "onseeked",
    "onseeking",
    "onselect",
    "onstalled",
    "onsubmit",
    "onsuspend",
    "ontimeupdate",
    "ontoggle",
    "onvolumechange",
    "onwaiting",
    "onwheel",
    "onanimationcancel",
    "onanimationend",
    "onanimationiteration",
    "onanimationstart",
    "onauxclick",
    "onbeforeinput",
    "onbeforematch",
    "onbeforetoggle",
    "onbeforexrselect",
    "oncommand",
    "oncontextlost",
    "oncontextrestored",
    "onfencedtreeclick",
    "onformdata",
    "onfreeze",
    "onfullscreenchange",
    "onfullscreenerror",
    "ongotpointercapture",
    "onlostpointercapture",
    "onpointercancel",
    "onpointerdown",
    "onpointerenter",
    "onpointerleave",
    "onpointerlockchange",
    "onpointerlockerror",
    "onpointermove",
    "onpointerout",
    "onpointerover",
    "onpointerrawupdate",
    "onpointerup",
    "onprerenderingchange",
    "onreadystatechange",
    "onresume",
    "onscrollend",
    "onsecuritypolicyviolation",
    "onselectionchange",
    "onselectstart",
    "onslotchange",
    "onsnapchanged",
    "onsnapchanging",
    "ontouchcancel",
    "ontouchend",
    "ontouchmove",
    "ontouchstart",
    "ontransitioncancel",
    "ontransitionend",
    "ontransitionrun",
    "ontransitionstart",
    "onvisibilitychange",
    "onwebkitanimationend",
    "onwebkitanimationiteration",
    "onwebkitanimationstart",
    "onwebkittransitionend"
  ];
  for (const __h of GLOBAL_EVENT_HANDLER_ATTRS) {
    if (!(__h in Element.prototype)) Element.prototype[__h] = null;
  }
  var DOMImplementation = class {
    static {
      __name(this, "DOMImplementation");
    }
    constructor(doc) {
      this._doc = doc;
    }
    // Legacy: `hasFeature` always returns true (DOM §4.5.1).
    hasFeature() {
      return true;
    }
    // `createHTMLDocument(title)` — DOMParser shims and Turbo Drive's page-
    // snapshot logic both probe it. Returns a fresh Document with a minimal
    // `<!DOCTYPE html><html><head><title>X</title></head><body></body></html>`
    // skeleton; full HTML-spec construction (quirks-mode flag) is out of scope.
    createHTMLDocument(...args) {
      const d = new Document();
      const doctype = new DocumentType("html", "", "", d);
      doctype._parent = d;
      const html = new Element("html");
      const head = new Element("head");
      const body = new Element("body");
      html._children = newChildList([head, body]);
      head._parent = html;
      body._parent = html;
      html._parent = d;
      d._children = newChildList([doctype, html]);
      if (args.length > 0 && args[0] !== void 0) {
        const t = new Element("title");
        t._children = newChildList([Object.assign(new Text(String(args[0])), { _parent: t })]);
        t._parent = head;
        head._children.push(t);
      }
      d._contentType = "text/html";
      walkSubtree(d, (n) => {
        n._ownerDoc = d;
      });
      return d;
    }
    // createDocumentType(qualifiedName, publicId, systemId) — modern spec
    // validates only the name (a "valid doctype name"); no namespace checks.
    createDocumentType(qualifiedName, publicId, systemId) {
      const name = String(qualifiedName);
      if (!isValidDoctypeName(name)) {
        throw new globalThis.DOMException(
          `The qualified name '${name}' is not a valid doctype name.`,
          "InvalidCharacterError"
        );
      }
      return new DocumentType(name, publicId, systemId, this._doc);
    }
    // createDocument(namespace, qualifiedName, doctype) — a fresh XMLDocument with
    // an optional root element (from the validated qualifiedName) and an optional
    // doctype, in [doctype?, element?] order.
    createDocument(...args) {
      if (args.length < 2) {
        throw new TypeError("Failed to execute 'createDocument': 2 arguments required.");
      }
      const namespace = args[0], qualifiedName = args[1], doctype = args[2];
      if (doctype != null && !(doctype instanceof DocumentType)) {
        throw new TypeError("Failed to execute 'createDocument': parameter 3 is not of type 'DocumentType'.");
      }
      const ns = namespace == null || namespace === "" ? null : String(namespace);
      const qn = qualifiedName === null ? "" : String(qualifiedName);
      let rns = null, prefix = null, localName = null;
      if (qn !== "") ({ namespace: rns, prefix, localName } = validateAndExtract(ns, qn, "element"));
      const d = new XMLDocument();
      d._contentType = ns === HTML_NS2 ? "application/xhtml+xml" : ns === SVG_NS ? "image/svg+xml" : "application/xml";
      d._children = newChildList();
      d.readyState = "complete";
      if (doctype != null) {
        if (doctype._parent) {
          const i = doctype._parent._children.indexOf(doctype);
          if (i >= 0) doctype._parent._children.splice(i, 1);
        }
        doctype._parent = d;
        doctype._ownerDoc = d;
        d._children.push(doctype);
      }
      if (qn !== "") {
        const el = d._createElement(rns, prefix, localName);
        el._parent = d;
        d._children.push(el);
      }
      return d;
    }
  };
  globalThis.DOMImplementation = DOMImplementation;
  var Document = class extends Node {
    static {
      __name(this, "Document");
    }
    // No window-manager → always treat the document as visible + focused.
    // Apps that gate work on these (Mastodon's scroll context, Vue's
    // hidden-tab pause, etc.) get the steady-state "user is here" branch.
    get visibilityState() {
      return "visible";
    }
    get hidden() {
      return false;
    }
    hasFocus() {
      return true;
    }
    // Modern feature-detection slots — apps that probe
    // `document.fullscreenElement` / `pictureInPictureElement` / etc.
    // before calling the respective `request…` shouldn't get a missing-
    // property crash. We have no real fullscreen / PiP, so always null.
    get fullscreenElement() {
      return null;
    }
    get pictureInPictureElement() {
      return null;
    }
    get pointerLockElement() {
      return null;
    }
    // Scoped custom-element registry — single global registry here.
    get customElementRegistry() {
      return globalThis.customElements || null;
    }
    // `document.styleSheets` is a live StyleSheetList of every
    // `<style>` and `<link rel=stylesheet>` in the document. We build
    // CSSStyleSheet shells (no real CSSOM) so apps that enumerate
    // sheets (Webpack style-loader, Lit's adopted-stylesheet probe)
    // don't crash on the missing list.
    get styleSheets() {
      const list = [];
      if (this.documentElement) walkSubtree(this.documentElement, (n) => {
        if (n.nodeType !== NODE_ELEMENT) return;
        if (n._tag === "style") {
          const ss = new globalThis.CSSStyleSheet();
          ss.ownerNode = n;
          const text = (n._children || []).map((c) => c.data || "").join("");
          ss.replaceSync(text);
          list.push(ss);
        } else if (n._tag === "link" && (n._attrs.rel || "").toLowerCase().includes("stylesheet")) {
          const ss = new globalThis.CSSStyleSheet({ baseURL: n._attrs.href });
          ss.ownerNode = n;
          list.push(ss);
        }
      });
      list.item = (i) => list[i] || null;
      return list;
    }
    // `document.adoptedStyleSheets` — empty Array per spec when no
    // sheets adopted. Lit/Stencil's component init reads this.
    get adoptedStyleSheets() {
      return [];
    }
    set adoptedStyleSheets(_) {
    }
    exitFullscreen() {
      return Promise.resolve();
    }
    exitPictureInPicture() {
      return Promise.resolve();
    }
    exitPointerLock() {
    }
    // CSSOM-View `document.elementFromPoint(x, y)` — without layout we
    // can't pick a "topmost at coords" element. ProseMirror's mousedown
    // handler uses this (via posAtCoords) to resolve click → node so
    // it can set NodeSelection on the clicked image / leaf. Pinning the
    // most recent click target (set by `__csimClickResolve`) lets that
    // resolution work without geometry. Falls back to the deepest
    // laid-out descendant so drag-drop libs that just need ANY element
    // keep working.
    elementFromPoint(_x, _y) {
      const last = globalThis.__csimLastClickTarget;
      if (last && last.nodeType === NODE_ELEMENT && globalThis.document && globalThis.document.body && globalThis.document.body.contains(last)) {
        return last;
      }
      const body = this.body;
      if (!body) return null;
      let deepest = null;
      walkSubtree(body, (n) => {
        if (n.nodeType === NODE_ELEMENT && globalThis.__isLaidOutNode && globalThis.__isLaidOutNode(n)) deepest = n;
      });
      return deepest;
    }
    elementsFromPoint(x, y) {
      const el = this.elementFromPoint(x, y);
      if (!el) return [];
      const out = [];
      for (let cur = el; cur && cur.nodeType === NODE_ELEMENT; cur = cur._parent) out.push(cur);
      return out;
    }
    // Currently-executing `<script>` element (set by `runInlineScripts`
    // around `globalThis.__csim_runScript`). Bundlers read `currentScript.src` to
    // derive the public-path origin.
    get currentScript() {
      return this._currentScript || null;
    }
    // Standards-mode viewport scroll root. Scroll-aware libs read
    // `scrollingElement.scrollLeft` during route transitions; undefined
    // here throws and aborts the transition.
    get scrollingElement() {
      return this.documentElement || null;
    }
    constructor() {
      super();
      this.nodeType = NODE_DOC;
      this.readyState = "complete";
      this._contentType = "application/xml";
      this._url = "about:blank";
      this._noBrowsingContext = true;
      for (const name of GLOBAL_EVENT_HANDLER_ATTRS) this[name] = null;
    }
    // The document element is the document's (single) element child — derived
    // from the tree rather than maintained as a field, so it stays correct after
    // any insert / remove (e.g. `new Document().appendChild(html)`), not just the
    // explicit parser / graft paths. A Document's child list is tiny (an optional
    // doctype + the root), so the scan is effectively free; the manual loop
    // avoids a per-access closure allocation on this hot getter.
    get documentElement() {
      const kids = this._children;
      for (let i = 0; i < kids.length; i++) {
        if (kids[i].nodeType === NODE_ELEMENT) return kids[i];
      }
      return null;
    }
    // jQuery's `mc(node)` helper resolves a node back to its window
    // via `doc.defaultView || doc.parentWindow`; without these the
    // offset / scroll path throws "Cannot read properties of
    // undefined (reading 'pageYOffset')".
    // The main document's window is the global; a nested (iframe) document
    // carries its own `_defaultView` (a frame-window proxy) set at load time.
    // A document with no browsing context (`new Document()`, createHTMLDocument,
    // createDocument) has no associated window — `defaultView` is null (DOM
    // §4.5.1). Returning the global here would splice the live window (and its
    // document) into a detached document's event path, cycling it unbounded.
    get defaultView() {
      return this._noBrowsingContext ? null : this._defaultView || globalThis;
    }
    get parentWindow() {
      return this.defaultView;
    }
    // Document node basics (BATCH H) — the Document node's own
    // nodeName / nodeValue / ownerDocument per DOM spec. (Document
    // inherits Node's ownerDocument, which would resolve to itself;
    // spec says a Document's ownerDocument is null.)
    get nodeName() {
      return "#document";
    }
    get textContent() {
      return null;
    }
    set textContent(_) {
    }
    get ownerDocument() {
      return null;
    }
    // Cloning a Document yields a new EMPTY document of the same kind, carrying
    // the content type and browsing-context-ness — children are copied only on a
    // deep clone (cloneNode handles that + sets documentElement).
    _cloneShell() {
      const d = new this.constructor();
      d._children = newChildList();
      d._contentType = this._contentType;
      d._noBrowsingContext = this._noBrowsingContext;
      d._url = this._url;
      d.readyState = "complete";
      return d;
    }
    // HTML spec `Document.location` aliases `window.location`. Forem's
    // searchParams.js reads `document.location.search`; without this
    // getter the call hits `undefined.search` and the whole bundle's
    // top-level module init aborts before the search-feed fetch fires.
    // A document with no browsing context (createHTMLDocument) has `location`
    // null; the main / frame documents return the live location object.
    get location() {
      return this._noBrowsingContext ? null : globalThis.location;
    }
    set location(v) {
      globalThis.__locationAssign(String(v));
    }
    // DOM spec URL accessors — all return the document's URL string.
    // Honeybadger's XHR breadcrumb instrumentation calls
    // `parseURL(document.URL)` to decide same-origin; without `URL`
    // the parser is fed `undefined`, throws on `.match`, and the
    // entire XHR open path that triggered the breadcrumb aborts
    // (which on Forem's top-bar is the `/notifications/counts`
    // request that populates the notification badge).
    // A document parsed for a nested browsing context (iframe/frame) or via
    // DOMParser carries its own `_url` (the frame's src / the DOMParser owner
    // document's URL); the live top-level document has none and reflects
    // `location.href` so pushState navigation is tracked.
    get URL() {
      return this._url || globalThis.location && globalThis.location.href || "";
    }
    get documentURI() {
      return this.URL;
    }
    get baseURI() {
      return documentBaseURL(this);
    }
    // `document.cookie` IDL — getter returns the serialised cookie
    // jar, setter parses a single `name=value; flags…` line. The Ruby
    // host fns (`globalThis.__getDocumentCookie` / `globalThis.__setDocumentCookie`) own
    // the storage; Browser-side cookies survive ctx rebuilds.
    get cookie() {
      return globalThis.__getDocumentCookie() || "";
    }
    set cookie(v) {
      globalThis.__setDocumentCookie(String(v == null ? "" : v));
    }
    // Public accessor over the internal `_activeElement` slot that the
    // Element focus/blur methods write to. Returns the document's
    // body as a sentinel when no element is focused, matching real
    // browsers (HTMLBodyElement is the fallback `activeElement` per
    // the HTML spec, and libraries occasionally test for non-null
    // before reading properties).
    get activeElement() {
      const ae = this._activeElement;
      if (ae && isConnected(ae)) return ae;
      return this.body || null;
    }
    // PM (and other libs) call `view.root.getSelection()` where
    // `view.root` is the document — `globalThis.getSelection` exists
    // but `document.getSelection` was missing, throwing
    // "Cannot read properties of undefined (reading 'getSelection')"
    // inside `domSelectionRange()`. Per the Selection API spec
    // `document.getSelection()` is a synonym for window.getSelection().
    getSelection() {
      return globalThis.getSelection ? globalThis.getSelection() : null;
    }
    // createElement(localName) per DOM spec. The name is validated, then
    // ASCII-lowercased only in an HTML document (XML/XHTML preserve case);
    // createElement never splits a prefix (localName may contain ":"). The
    // namespace is HTML for HTML / XHTML documents, null for XML documents.
    createElement(tag) {
      const raw = String(tag);
      if (!isValidElementLocalName(raw)) {
        throw new globalThis.DOMException(
          `The tag name provided ('${raw}') is not a valid name.`,
          "InvalidCharacterError"
        );
      }
      const html = isHtmlDocument(this);
      const localName = html ? asciiLower2(raw) : raw;
      const ns = html || this._contentType === "application/xhtml+xml" ? HTML_NS2 : null;
      return this._createElement(ns, null, localName);
    }
    // createElementNS(namespace, qualifiedName) per DOM spec: validate-and-extract
    // the (namespace, prefix, localName), then create an element carrying them.
    // Preact's `z` takes this path for SVG (Forem's crayons_icon_tag icons); the
    // matcher / cascade / event paths still key off the lowercased `_tag`, so
    // SVG keeps matching while namespaceURI / prefix / localName / tagName reflect
    // the real namespace.
    createElementNS(namespace, qualifiedName) {
      const ns = namespace == null ? null : String(namespace);
      const { namespace: rns, prefix, localName } = validateAndExtract(ns, String(qualifiedName));
      return this._createElement(rns, prefix, localName);
    }
    // Shared "create an element" step for createElement / createElementNS: build
    // the element (custom-element upgrade only in the HTML namespace) and stamp
    // its namespace slots + owner document.
    _createElement(ns, prefix, localName) {
      let el;
      const ctor = ns === HTML_NS2 ? getCustomElementCtor(localName.toLowerCase()) : null;
      if (ctor) {
        const prev = __currentTag;
        __currentTag = localName.toLowerCase();
        try {
          el = new ctor();
        } finally {
          __currentTag = prev;
        }
      } else {
        el = new Element(localName);
      }
      el._ns = ns;
      el._prefix = prefix;
      el._localName = localName;
      el._ownerDoc = this;
      return el;
    }
    // `data` is a required DOMString (not nullable): `null` → "null", `undefined`
    // → "undefined". Coerce at the factory so the node ctor still receives a
    // string (its own `new Text()`/`new Comment()` optional-arg default is
    // separate). NB: these factories have no internal callers — public API only.
    createTextNode(data) {
      const t = new Text(String(data));
      t._ownerDoc = this;
      return t;
    }
    createComment(data) {
      const c = new Comment(String(data));
      c._ownerDoc = this;
      return c;
    }
    // `createCDATASection(data)` — XML documents only (NotSupportedError in HTML);
    // data must not contain the CDATA-section close delimiter "]]>".
    createCDATASection(data) {
      if (isHtmlDocument(this)) {
        throw new globalThis.DOMException("This operation is not supported for HTML documents.", "NotSupportedError");
      }
      const s = String(data);
      if (s.includes("]]>")) {
        throw new globalThis.DOMException("String contains an invalid character.", "InvalidCharacterError");
      }
      const c = new CDATASection(s);
      c._ownerDoc = this;
      return c;
    }
    get body() {
      const html = this.documentElement;
      if (!html) return null;
      for (const c of html._children) {
        if (c._tag === "body") return c;
      }
      return null;
    }
    // The document's DocumentType child, or null. Populated for a page's
    // `<!DOCTYPE html>` (the parser synthesizes the node and the per-visit
    // graft in __csimLoadDocument carries it onto the live document) and
    // for createDocument / createDocumentType.
    get doctype() {
      for (const c of this._children) if (c.nodeType === NODE_DOCTYPE) return c;
      return null;
    }
    get head() {
      const html = this.documentElement;
      if (!html) return null;
      for (const c of html._children) {
        if (c._tag === "head") return c;
      }
      return null;
    }
    get title() {
      const head = this.head;
      const title = head && head.querySelector("title");
      if (!title) return "";
      return title.textContent.replace(/[\t\n\f\r ]+/g, " ").replace(/^ | $/g, "");
    }
    // Per HTML spec, `document.referrer` is the URL of the page that
    // initiated this navigation — populated for link clicks / form
    // submits, empty for address-bar visits. Discourse's `/login` route
    // relies on `document.referrer` to set the `destination_url` cookie
    // when the user clicked into login from an internal topic page;
    // without this the post-auth `location.assign(destination_url)`
    // branch never fires and the user lands on `/` instead of the
    // pre-login URL.
    get referrer() {
      return typeof globalThis.__getDocumentReferrer === "function" ? globalThis.__getDocumentReferrer() || "" : "";
    }
    set title(v) {
      let head = this.head;
      if (!head) {
        head = new Element("head");
        head._parent = this.documentElement;
        this.documentElement._children.unshift(head);
        registerSubtree(head);
        bumpSettleGen();
      }
      let title = head.querySelector("title");
      if (!title) {
        title = new Element("title");
        title._parent = head;
        head._children.push(title);
        registerSubtree(title);
        bumpSettleGen();
      }
      title.textContent = String(v == null ? "" : v);
    }
    getElementById(id) {
      return findById(this.documentElement, id);
    }
    // Spec: `Document#querySelector` matches against the entire
    // document tree — documentElement itself IS a valid match. Use
    // documentElement as a root (not its children) so e.g.
    // `document.querySelector('html')` returns the html element.
    querySelector(sel) {
      if (arguments.length < 1) throw new TypeError("Failed to execute 'querySelector': 1 argument required, but only 0 present.");
      return this.documentElement ? selectFirst([this.documentElement], sel, this.documentElement) : null;
    }
    querySelectorAll(sel) {
      if (arguments.length < 1) throw new TypeError("Failed to execute 'querySelectorAll': 1 argument required, but only 0 present.");
      return nodeList(this.documentElement ? selectAll([this.documentElement], sel, this.documentElement) : []);
    }
    // `getElementsByTagName` on a Document is a real DOM API apps and
    // Capybara reach for directly. Per DOM spec these include self when
    // called on Document (the
    // documentElement IS a descendant of Document), so `//html`
    // matching documentElement is a hard requirement Capybara relies
    // on for `find(:css, 'html')` and `match_selector('html')`.
    getElementsByTagName(tag) {
      const want = String(tag).toLowerCase();
      return liveHTMLCollection(() => {
        const root = this.documentElement;
        if (!root) return [];
        const out = want === "*" || root._tag === want ? [root] : [];
        for (const n of collectByTagName(root, tag)) out.push(n);
        return out;
      });
    }
    getElementsByClassName(cls) {
      return liveHTMLCollection(() => collectByClassName(this, cls));
    }
    getElementsByName(name) {
      return this.documentElement ? this.documentElement.getElementsByName(name) : [];
    }
    // DocumentFragment — a lightweight node container with no parent
    // identity in the document. jQuery (and similar libraries) build
    // off-document subtrees in fragments before splicing them into
    // the live tree via `appendChild`. We give it just enough surface
    // for `appendChild` / `childNodes` to work.
    createDocumentFragment() {
      const f = new DocumentFragment();
      f._ownerDoc = this;
      return f;
    }
    // `Document.createEvent(interfaceName)` — legacy DOM Level 2 API
    // still used by libraries that target older browsers (Trix's
    // `triggerEvent` builds `document.createEvent("Event")` /
    // `event.initEvent(...)` so it works without `new Event()`
    // support detection). The returned event needs `initEvent` /
    // `initCustomEvent` mutators per the spec.
    createEvent(interfaceName) {
      const name = asciiLower2(String(interfaceName == null ? "" : interfaceName));
      const ctorName = CREATE_EVENT_INTERFACES[name];
      if (!ctorName) {
        throw new globalThis.DOMException(
          `The event interface "${interfaceName}" is not supported.`,
          "NotSupportedError"
        );
      }
      const Ctor = globalThis[ctorName] || globalThis.Event;
      const ev = new Ctor("", { bubbles: false, cancelable: false });
      ev._initialized = false;
      return ev;
    }
    // `Document.importNode(node, deep)` — clone of `node` adopted into
    // this document. We only have one document at a time, so this is
    // an alias for `cloneNode(deep)`. Turbo Drive's
    // `importStreamElements` uses `document.importNode(streamElement,
    // true)` to graft turbo-stream fragments into the live tree.
    importNode(node, deep) {
      if (!node || typeof node.cloneNode !== "function") return null;
      const out = node.cloneNode(!!deep);
      ceUpgradeTree(out);
      return out;
    }
    adoptNode(node) {
      if (!node) return null;
      if (node.nodeType === NODE_DOC) {
        throw new globalThis.DOMException("Cannot adopt a document", "NotSupportedError");
      }
      if (node._isShadowRoot) {
        throw new globalThis.DOMException("Cannot adopt a shadow root", "HierarchyRequestError");
      }
      if (node._parent && typeof node._parent.removeChild === "function") {
        try {
          node._parent.removeChild(node);
        } catch (_) {
        }
      }
      const dest = this;
      const oldDoc = node.ownerDocument;
      walkSubtree(node, (n) => {
        n._ownerDoc = dest;
        if (n._attrNodes) for (const k in n._attrNodes) n._attrNodes[k]._ownerDoc = dest;
      });
      const oldReg = oldDoc && oldDoc._liveRanges;
      if (oldReg && oldReg.size) {
        for (const r of [...oldReg]) {
          if (sameTreeContains(node, r.startContainer) || sameTreeContains(node, r.endContainer)) r._track();
        }
      }
      return node;
    }
    // `document.implementation` — a per-document, cached `DOMImplementation`
    // (createHTMLDocument / createDocument / createDocumentType / hasFeature).
    // Cached so repeated reads return the same instance, and a real class so
    // `instanceof DOMImplementation` holds.
    get implementation() {
      return this._implementation || (this._implementation = new DOMImplementation(this));
    }
    // Minimal Range stub for `document.createRange()`. We don't model
    // partial-range selection (start/end offsets on text nodes etc.);
    // only document-order comparison between two nodes' start containers
    // via `compareBoundaryPoints`, which is all the consumers here drive.
    createRange() {
      return new DocumentOrderRange(this);
    }
    // Minimal NodeIterator. DOMPurify is the canonical consumer —
    // it walks a freshly-parsed sanitisation fragment via
    // `nextNode()` and uses `whatToShow` to gate ELEMENT / TEXT /
    // COMMENT visits. We pre-collect descendants in document order;
    // DOMPurify operates on small per-call fragments so the up-front
    // walk is cheaper than the per-step sibling/ancestor traversal.
    createNodeIterator(root, whatToShow, filter) {
      if (!isNodeArg(root)) {
        throw new TypeError("Failed to execute 'createNodeIterator': parameter 1 is not of type 'Node'.");
      }
      whatToShow = whatToShow === void 0 ? 4294967295 : whatToShow >>> 0;
      if (filter === void 0) filter = null;
      const state2 = { node: root, before: true, active: false };
      const accept = /* @__PURE__ */ __name((n) => {
        if (!(1 << n.nodeType - 1 & whatToShow)) return 3;
        if (filter) {
          const fn = typeof filter === "function" ? filter : filter && filter.acceptNode;
          if (fn) {
            if (state2.active) {
              throw new globalThis.DOMException("Failed to execute 'nextNode' on 'NodeIterator': the iterator's filter is already active.", "InvalidStateError");
            }
            state2.active = true;
            let r;
            try {
              r = fn.call(filter || null, n);
            } finally {
              state2.active = false;
            }
            if (r === 2 || r === 3 || r === false) return 3;
          }
        }
        return 1;
      }, "accept");
      const it = {
        nextNode() {
          return nodeIteratorTraverse(this, true);
        },
        previousNode() {
          return nodeIteratorTraverse(this, false);
        },
        detach() {
        }
      };
      Object.defineProperties(it, {
        _state: { value: state2, writable: false, enumerable: false },
        _accept: { value: accept, writable: false, enumerable: false },
        root: { value: root, enumerable: true },
        whatToShow: { value: whatToShow, enumerable: true },
        filter: { value: filter, enumerable: true },
        referenceNode: { get() {
          return state2.node;
        }, enumerable: true },
        pointerBeforeReferenceNode: { get() {
          return state2.before;
        }, enumerable: true },
        [Symbol.toStringTag]: { value: "NodeIterator" }
      });
      LIVE_NODE_ITERATORS.add(it);
      return it;
    }
    // `Document.createTreeWalker(root, whatToShow, filter)` — Trix
    // builds one to traverse the editable subtree by nodeType (its
    // `walkTree` helper passes `SHOW_ELEMENT` / `SHOW_TEXT` /
    // `SHOW_COMMENT`). We pre-walk descendants in document order and
    // serve `nextNode` / sibling navigation off the buffer; Trix only
    // uses `nextNode()` and `currentNode` so the rest of the
    // TreeWalker surface (`firstChild` / `nextSibling` / etc.) is a
    // light shim.
    createTreeWalker(root, whatToShow, filter) {
      if (!isNodeArg(root)) {
        throw new TypeError("Failed to execute 'createTreeWalker': parameter 1 is not of type 'Node'.");
      }
      whatToShow = whatToShow === void 0 ? 4294967295 : whatToShow >>> 0;
      filter = filter == null ? null : filter;
      let cur = root;
      let active = false;
      const accept = /* @__PURE__ */ __name((n) => {
        const mask = 1 << n.nodeType - 1;
        if (!(mask & whatToShow)) return 3;
        if (!filter) return 1;
        const fn = typeof filter === "function" ? filter : filter.acceptNode;
        if (typeof fn !== "function") throw new TypeError("Failed to execute 'acceptNode' on 'NodeFilter': the callback is not callable.");
        if (active) throw new globalThis.DOMException("TreeWalker filter is already running.", "InvalidStateError");
        active = true;
        let r;
        try {
          r = fn.call(filter, n);
        } finally {
          active = false;
        }
        return r & 65535;
      }, "accept");
      const fc = /* @__PURE__ */ __name((n) => n._children && n._children.length ? n._children[0] : null, "fc");
      const lc = /* @__PURE__ */ __name((n) => n._children && n._children.length ? n._children[n._children.length - 1] : null, "lc");
      const ns = /* @__PURE__ */ __name((n) => {
        const p = n._parent;
        if (!p) return null;
        const i = p._children.indexOf(n);
        return i >= 0 && i + 1 < p._children.length ? p._children[i + 1] : null;
      }, "ns");
      const ps = /* @__PURE__ */ __name((n) => {
        const p = n._parent;
        if (!p) return null;
        const i = p._children.indexOf(n);
        return i > 0 ? p._children[i - 1] : null;
      }, "ps");
      function traverseChildren(forward) {
        let node = forward ? fc(cur) : lc(cur);
        while (node) {
          const r = accept(node);
          if (r === 1) {
            cur = node;
            return node;
          }
          if (r === 3) {
            const child = forward ? fc(node) : lc(node);
            if (child) {
              node = child;
              continue;
            }
          }
          while (node) {
            const sib = forward ? ns(node) : ps(node);
            if (sib) {
              node = sib;
              break;
            }
            const parent = node._parent;
            if (!parent || parent === root || parent === cur) return null;
            node = parent;
          }
        }
        return null;
      }
      __name(traverseChildren, "traverseChildren");
      function traverseSiblings(forward) {
        let node = cur;
        if (node === root) return null;
        while (true) {
          let sibling = forward ? ns(node) : ps(node);
          while (sibling) {
            node = sibling;
            const r = accept(node);
            if (r === 1) {
              cur = node;
              return node;
            }
            sibling = forward ? fc(node) : lc(node);
            if (r === 2 || !sibling) sibling = forward ? ns(node) : ps(node);
          }
          node = node._parent;
          if (!node || node === root) return null;
          if (accept(node) === 1) return null;
        }
      }
      __name(traverseSiblings, "traverseSiblings");
      const tw = {
        get currentNode() {
          return cur;
        },
        set currentNode(v) {
          if (!isNodeArg(v)) throw new TypeError("Failed to set the 'currentNode' property on 'TreeWalker': parameter 1 is not of type 'Node'.");
          cur = v;
        },
        parentNode() {
          let node = cur;
          while (node && node !== root) {
            node = node._parent;
            if (node && accept(node) === 1) {
              cur = node;
              return node;
            }
          }
          return null;
        },
        firstChild() {
          return traverseChildren(true);
        },
        lastChild() {
          return traverseChildren(false);
        },
        nextSibling() {
          return traverseSiblings(true);
        },
        previousSibling() {
          return traverseSiblings(false);
        },
        nextNode() {
          let node = cur, result = 1;
          while (true) {
            while (result !== 2 && fc(node)) {
              node = fc(node);
              result = accept(node);
              if (result === 1) {
                cur = node;
                return node;
              }
            }
            let sibling = null, temp = node;
            while (temp) {
              if (temp === root) return null;
              sibling = ns(temp);
              if (sibling) {
                node = sibling;
                break;
              }
              temp = temp._parent;
            }
            if (!sibling) return null;
            result = accept(node);
            if (result === 1) {
              cur = node;
              return node;
            }
          }
        },
        previousNode() {
          let node = cur;
          while (node !== root) {
            let sibling = ps(node);
            while (sibling) {
              node = sibling;
              let result = accept(node);
              while (result !== 2 && lc(node)) {
                node = lc(node);
                result = accept(node);
              }
              if (result === 1) {
                cur = node;
                return node;
              }
              sibling = ps(node);
            }
            if (node === root || !node._parent) return null;
            node = node._parent;
            if (accept(node) === 1) {
              cur = node;
              return node;
            }
          }
          return null;
        }
      };
      Object.defineProperty(tw, "root", { value: root, enumerable: true, writable: false });
      Object.defineProperty(tw, "whatToShow", { value: whatToShow, enumerable: true, writable: false });
      Object.defineProperty(tw, "filter", { value: filter, enumerable: true, writable: false });
      Object.defineProperty(tw, Symbol.toStringTag, { value: "TreeWalker" });
      return tw;
    }
    // `document.execCommand(command, showUI, value)` — deprecated but
    // still in real browsers. Discourse's d-editor uses
    // `execCommand('insertText', false, str)` to insert upload
    // placeholders into the composer textarea while the upload is
    // running; without it, Uppy emits an `error` event and the upload
    // never completes. We implement only the commands the suite actually
    // exercises (`insertText`, `copy`); everything else is a tolerant
    // no-op returning false.
    execCommand(command, _showUI, value) {
      const cmd = String(command || "").toLowerCase();
      const active = this._activeElement;
      if (cmd === "copy") {
        let text = "";
        if (active && (active._tag === "input" || active._tag === "textarea")) {
          const v = String(active._attrs.value || "");
          text = v.slice(active.selectionStart, active.selectionEnd);
        } else {
          const sel = globalThis.getSelection && globalThis.getSelection();
          if (sel && typeof sel.toString === "function") text = sel.toString();
        }
        globalThis.__csimClipboardSet(text);
        return true;
      }
      if (!active) return false;
      if (cmd === "inserttext") {
        const str = value == null ? "" : String(value);
        if (active._tag === "textarea" || active._tag === "input" && /^(text|search|email|url|tel|password)?$/i.test(active._attrs.type || "")) {
          const cur = String(active._attrs.value == null ? "" : active._attrs.value);
          const ss = active.selectionStart == null ? cur.length : active.selectionStart;
          const se = active.selectionEnd == null ? cur.length : active.selectionEnd;
          const next = cur.slice(0, ss) + str + cur.slice(se);
          active._attrs.value = next;
          active.selectionStart = active.selectionEnd = ss + str.length;
          try {
            dispatchEvent(active, new globalThis.InputEvent("input", { bubbles: true, cancelable: true, data: str, inputType: "insertText" }));
          } catch (_) {
          }
          return true;
        }
        if (active._attrs.contenteditable != null && (active._attrs.contenteditable || "").toLowerCase() !== "false") {
          let prevented = false;
          try {
            const bi = new globalThis.InputEvent("beforeinput", { bubbles: true, cancelable: true, data: str, inputType: "insertText" });
            prevented = !dispatchEvent(active, bi);
          } catch (_) {
          }
          if (!prevented) {
            globalThis.__csimInsertTextAtSelection(str);
            try {
              dispatchEvent(active, new globalThis.InputEvent("input", { bubbles: true, cancelable: true, data: str, inputType: "insertText" }));
            } catch (_) {
            }
          }
          return true;
        }
      }
      return false;
    }
    queryCommandSupported(command) {
      const c = String(command || "").toLowerCase();
      return c === "inserttext" || c === "copy";
    }
    queryCommandEnabled(command) {
      return this.queryCommandSupported(command);
    }
    // execCommand legacy state/value/indeterminacy probes — we don't
    // run execCommand, so report the inert defaults.
    queryCommandState() {
      return false;
    }
    queryCommandValue() {
      return "";
    }
    queryCommandIndeterm() {
      return false;
    }
    // ── Document collections (BATCH G) ──────────────────────────────
    // Live HTMLCollections built from tag/attribute queries, matching
    // the legacy `document.forms` / `images` / etc. surface.
    get forms() {
      return htmlCollection(this.getElementsByTagName("form"));
    }
    get images() {
      return htmlCollection(this.getElementsByTagName("img"));
    }
    // `links` = <a> / <area> with an href attribute.
    get links() {
      return htmlCollection(this.querySelectorAll("a[href], area[href]"));
    }
    get scripts() {
      return htmlCollection(this.getElementsByTagName("script"));
    }
    // `anchors` = <a> elements with a `name` attribute (legacy).
    get anchors() {
      return htmlCollection(this.querySelectorAll("a[name]"));
    }
    get embeds() {
      return htmlCollection(this.getElementsByTagName("embed"));
    }
    // `plugins` is the legacy alias of `embeds`.
    get plugins() {
      return htmlCollection(this.getElementsByTagName("embed"));
    }
    // Namespace-aware lookup collapses to the flat local-name query.
    getElementsByTagNameNS(ns, local) {
      return liveHTMLCollection(() => collectByTagNameNS(this, ns, local));
    }
    // ── Document legacy string / metadata members (BATCH G) ─────────
    // `document.dir` reflects the documentElement's `dir` attribute.
    get dir() {
      const de = this.documentElement;
      return de ? de._attrs.dir || "" : "";
    }
    set dir(v) {
      const de = this.documentElement;
      if (de) de.setAttribute("dir", String(v == null ? "" : v));
    }
    // `domain` defaults to the current host; stored so writes round-trip.
    get domain() {
      return this._domain != null ? this._domain : globalThis.location && globalThis.location.hostname || "";
    }
    set domain(v) {
      this._domain = String(v == null ? "" : v);
    }
    // `designMode` is 'off' by default; stored so a write round-trips.
    get designMode() {
      return this._designMode || "off";
    }
    set designMode(v) {
      this._designMode = String(v == null ? "" : v);
    }
    // Legacy presentational color attributes — empty steady state,
    // stored for round-trip reads.
    get fgColor() {
      return this._fgColor || "";
    }
    set fgColor(v) {
      this._fgColor = String(v == null ? "" : v);
    }
    get bgColor() {
      return this._bgColor || "";
    }
    set bgColor(v) {
      this._bgColor = String(v == null ? "" : v);
    }
    get linkColor() {
      return this._linkColor || "";
    }
    set linkColor(v) {
      this._linkColor = String(v == null ? "" : v);
    }
    get vlinkColor() {
      return this._vlinkColor || "";
    }
    set vlinkColor(v) {
      this._vlinkColor = String(v == null ? "" : v);
    }
    get alinkColor() {
      return this._alinkColor || "";
    }
    set alinkColor(v) {
      this._alinkColor = String(v == null ? "" : v);
    }
    // Encoding accessors. We don't transcode bytes (the loader hands us UTF-8),
    // but the declared charset IS observable: the first valid `<meta charset>` /
    // `<meta http-equiv=content-type>`, normalised to its canonical Encoding-
    // standard name (default UTF-8). `_httpCharset` is a forward hook for an HTTP
    // `Content-Type; charset=…` (which per spec would win over meta) — not yet
    // wired (no test needs it; our responses carry no charset). `charset` /
    // `inputEncoding` are legacy aliases of `characterSet`.
    get characterSet() {
      let name = this._httpCharset ? getEncoding(this._httpCharset, false) : null;
      if (!name) {
        const label = firstMetaCharset(this);
        if (label != null) name = getEncoding(label, true);
      }
      return name || "UTF-8";
    }
    get charset() {
      return this.characterSet;
    }
    get inputEncoding() {
      return this.characterSet;
    }
    get contentType() {
      return this._contentType || "text/html";
    }
    // Standards-mode rendering only.
    get compatMode() {
      return this._quirks ? "BackCompat" : "CSS1Compat";
    }
    // Deterministic fixed timestamp (MM/DD/YYYY HH:MM:SS, local time).
    get lastModified() {
      return "01/01/1970 00:00:00";
    }
    // ── Document Attr / storage / legacy-event members (BATCH G) ─────
    // `createAttribute(localName)` — a detached Attr (no owner, empty value).
    // Validates the Name production and ASCII-lowercases in an HTML document.
    createAttribute(name) {
      const qn = String(name);
      if (!isValidAttributeLocalName(qn)) {
        throw new globalThis.DOMException("'" + qn + "' is not a valid attribute name.", "InvalidCharacterError");
      }
      const ln = isHtmlDocument(this) ? asciiLower2(qn) : qn;
      return new Attr(ln, null, null, "", this);
    }
    createAttributeNS(namespace, qualifiedName) {
      const ns = namespace == null ? null : String(namespace);
      const { namespace: rns, prefix, localName } = validateAndExtract(ns, String(qualifiedName), "attribute");
      return new Attr(localName, rns, prefix, "", this);
    }
    // `createProcessingInstruction(target, data)` — target must match the XML Name
    // production; data must not contain the PI close delimiter "?>".
    createProcessingInstruction(target, data) {
      const t = String(target);
      if (!isXMLName(t)) {
        throw new globalThis.DOMException("'" + t + "' is not a valid PI target.", "InvalidCharacterError");
      }
      const d = String(data);
      if (d.indexOf("?>") !== -1) {
        throw new globalThis.DOMException("PI data must not contain '?>'.", "InvalidCharacterError");
      }
      return new ProcessingInstruction(t, d, this);
    }
    // Storage Access API — no cookie partitioning here, always granted.
    hasStorageAccess() {
      return Promise.resolve(true);
    }
    requestStorageAccess() {
      return Promise.resolve();
    }
    hasUnpartitionedCookieAccess() {
      return Promise.resolve(true);
    }
    // Legacy Netscape event-model no-ops.
    captureEvents() {
    }
    releaseEvents() {
    }
    clear() {
    }
  };
  var XMLDocument = class extends Document {
    static {
      __name(this, "XMLDocument");
    }
    get location() {
      return null;
    }
    get URL() {
      return "about:blank";
    }
    // no browsing context; documentURI follows via this.URL
  };
  globalThis.XMLDocument = XMLDocument;
  function createHtmlPageDocument(withSkeleton) {
    const doc = new Document();
    doc._contentType = void 0;
    doc._url = void 0;
    doc._noBrowsingContext = false;
    doc.readyState = "loading";
    if (withSkeleton) {
      const html = new Element("html");
      const head = new Element("head");
      const body = new Element("body");
      html._parent = doc;
      doc._children.push(html);
      head._parent = html;
      html._children.push(head);
      body._parent = html;
      html._children.push(body);
    }
    return doc;
  }
  __name(createHtmlPageDocument, "createHtmlPageDocument");
  function rangesFor(node) {
    const d = node && (node.nodeType === NODE_DOC ? node : node.ownerDocument);
    return d ? d._liveRanges : null;
  }
  __name(rangesFor, "rangesFor");
  function liveRangesOnInsert(parent, index, count) {
    const reg = rangesFor(parent);
    if (!reg || reg.size === 0) return;
    for (const r of reg) {
      if (r.startContainer === parent && r.startOffset > index) r.startOffset += count;
      if (r.endContainer === parent && r.endOffset > index) r.endOffset += count;
    }
  }
  __name(liveRangesOnInsert, "liveRangesOnInsert");
  function sameTreeContains(ancestor, descendant) {
    for (let n = descendant; n; n = n._parent) {
      if (n === ancestor) return true;
      if (n._isShadowRoot) return false;
    }
    return false;
  }
  __name(sameTreeContains, "sameTreeContains");
  function liveRangesOnRemove(oldParent, node, index) {
    const reg = rangesFor(oldParent);
    if (!reg || reg.size === 0) return;
    for (const r of reg) {
      if (sameTreeContains(node, r.startContainer)) {
        r.startContainer = oldParent;
        r.startOffset = index;
      }
      if (sameTreeContains(node, r.endContainer)) {
        r.endContainer = oldParent;
        r.endOffset = index;
      }
      if (r.startContainer === oldParent && r.startOffset > index) r.startOffset -= 1;
      if (r.endContainer === oldParent && r.endOffset > index) r.endOffset -= 1;
    }
  }
  __name(liveRangesOnRemove, "liveRangesOnRemove");
  function liveRangesOnReplaceData(node, offset, count, dataLen) {
    const reg = rangesFor(node);
    if (!reg || reg.size === 0) return;
    const delta = dataLen - count;
    for (const r of reg) {
      if (r.startContainer === node) {
        if (r.startOffset > offset && r.startOffset <= offset + count) r.startOffset = offset;
        else if (r.startOffset > offset + count) r.startOffset += delta;
      }
      if (r.endContainer === node) {
        if (r.endOffset > offset && r.endOffset <= offset + count) r.endOffset = offset;
        else if (r.endOffset > offset + count) r.endOffset += delta;
      }
    }
  }
  __name(liveRangesOnReplaceData, "liveRangesOnReplaceData");
  function liveRangesOnSplit(node, offset, newNode, parent, nodeIndex) {
    const reg = rangesFor(node);
    if (!reg || reg.size === 0) return;
    for (const r of reg) {
      if (r.startContainer === node && r.startOffset > offset) {
        r.startContainer = newNode;
        r.startOffset -= offset;
      }
      if (r.endContainer === node && r.endOffset > offset) {
        r.endContainer = newNode;
        r.endOffset -= offset;
      }
      if (parent) {
        if (r.startContainer === parent && r.startOffset === nodeIndex + 1) r.startOffset += 1;
        if (r.endContainer === parent && r.endOffset === nodeIndex + 1) r.endOffset += 1;
      }
    }
  }
  __name(liveRangesOnSplit, "liveRangesOnSplit");
  var LIVE_NODE_ITERATORS = /* @__PURE__ */ new Set();
  function followingSkippingSubtree(node, root) {
    for (let cur = node; cur && cur !== root; cur = cur._parent) {
      const p = cur._parent;
      if (p) {
        const sibs = p._children, i = sibs.indexOf(cur);
        if (i >= 0 && i + 1 < sibs.length) return sibs[i + 1];
      }
    }
    return null;
  }
  __name(followingSkippingSubtree, "followingSkippingSubtree");
  function followingWithinRoot(node, root) {
    if (node._children && node._children.length) return node._children[0];
    return followingSkippingSubtree(node, root);
  }
  __name(followingWithinRoot, "followingWithinRoot");
  function precedingWithinRoot(node, root) {
    if (node === root || !node._parent) return null;
    const sibs = node._parent._children, i = sibs.indexOf(node);
    if (i > 0) {
      let n = sibs[i - 1];
      while (n._children && n._children.length) n = n._children[n._children.length - 1];
      return n;
    }
    return node._parent;
  }
  __name(precedingWithinRoot, "precedingWithinRoot");
  function nodeIteratorTraverse(it, forward) {
    let node = it._state.node;
    let before = it._state.before;
    while (true) {
      if (forward) {
        if (!before) {
          const n = followingWithinRoot(node, it.root);
          if (!n) return null;
          node = n;
        } else before = false;
      } else {
        if (before) {
          const n = precedingWithinRoot(node, it.root);
          if (!n) return null;
          node = n;
        } else before = true;
      }
      if (it._accept(node) === 1) break;
    }
    it._state.node = node;
    it._state.before = before;
    return node;
  }
  __name(nodeIteratorTraverse, "nodeIteratorTraverse");
  function nodeIteratorPreRemove(toBeRemoved) {
    if (LIVE_NODE_ITERATORS.size === 0) return;
    const removedDoc = toBeRemoved.nodeType === NODE_DOC ? toBeRemoved : toBeRemoved.ownerDocument;
    for (const it of LIVE_NODE_ITERATORS) {
      const st = it._state;
      if (nodeContains(toBeRemoved, it.root)) continue;
      const itDoc = it.root.nodeType === NODE_DOC ? it.root : it.root.ownerDocument;
      if (itDoc !== removedDoc) continue;
      if (!nodeContains(toBeRemoved, st.node)) continue;
      if (st.before) {
        const next = followingSkippingSubtree(toBeRemoved, null);
        if (next) {
          st.node = next;
          continue;
        }
        st.before = false;
      }
      const prevSib = toBeRemoved.previousSibling;
      if (!prevSib) {
        st.node = toBeRemoved._parent;
      } else {
        let n = prevSib;
        while (n._children && n._children.length) n = n._children[n._children.length - 1];
        st.node = n;
      }
    }
  }
  __name(nodeIteratorPreRemove, "nodeIteratorPreRemove");
  function nodeLength(node) {
    const t = node.nodeType;
    if (t === NODE_DOCTYPE) return 0;
    if (t === NODE_TEXT || t === NODE_CDATA || t === NODE_COMMENT || t === NODE_PI) {
      return (node.data || "").length;
    }
    return node._children ? node._children.length : 0;
  }
  __name(nodeLength, "nodeLength");
  function setRangeBoundary(range, node, offset, which) {
    const fn = which === "start" ? "setStart" : "setEnd";
    if (!isNodeArg(node)) {
      throw new TypeError(`Failed to execute '${fn}' on 'Range': parameter 1 is not of type 'Node'.`);
    }
    if (node.nodeType === NODE_DOCTYPE) {
      throw new globalThis.DOMException(`Failed to execute '${fn}' on 'Range': the node is a doctype.`, "InvalidNodeTypeError");
    }
    offset = offset >>> 0;
    if (offset > nodeLength(node)) {
      throw new globalThis.DOMException(`Failed to execute '${fn}' on 'Range': the offset ${offset} is larger than the node's length.`, "IndexSizeError");
    }
    const newRoot = ancestorChain(node)[0];
    if (which === "start") {
      const endRoot = range.endContainer && ancestorChain(range.endContainer)[0];
      if (newRoot !== endRoot || compareBoundaryPoint(node, offset, range.endContainer, range.endOffset) > 0) {
        range.endContainer = node;
        range.endOffset = offset;
      }
      range.startContainer = node;
      range.startOffset = offset;
    } else {
      const startRoot = range.startContainer && ancestorChain(range.startContainer)[0];
      if (newRoot !== startRoot || compareBoundaryPoint(node, offset, range.startContainer, range.startOffset) < 0) {
        range.startContainer = node;
        range.startOffset = offset;
      }
      range.endContainer = node;
      range.endOffset = offset;
    }
    range._track();
  }
  __name(setRangeBoundary, "setRangeBoundary");
  function boundaryRelativeToNode(range, node, which, after) {
    const fn = (which === "start" ? "setStart" : "setEnd") + (after ? "After" : "Before");
    const parent = node && node._parent;
    if (!parent) {
      throw new globalThis.DOMException(`Failed to execute '${fn}' on 'Range': the node has no parent.`, "InvalidNodeTypeError");
    }
    const index = parent._children.indexOf(node);
    setRangeBoundary(range, parent, index + (after ? 1 : 0), which);
  }
  __name(boundaryRelativeToNode, "boundaryRelativeToNode");
  var DocumentOrderRange = class _DocumentOrderRange {
    static {
      __name(this, "DocumentOrderRange");
    }
    constructor(doc) {
      const d = doc || globalThis.document || null;
      this.startContainer = d;
      this.startOffset = 0;
      this.endContainer = d;
      this.endOffset = 0;
      this._reg = null;
      this._track();
    }
    // (Re-)register this range in its current document's live-range set. Called
    // after every boundary change so a range that moves to another document is
    // tracked there (the registry hangs off the shared document, not a realm).
    _track() {
      const sc = this.startContainer;
      const d = sc && (sc.nodeType === NODE_DOC ? sc : sc.ownerDocument);
      const reg = d ? d._liveRanges || (d._liveRanges = /* @__PURE__ */ new Set()) : null;
      if (reg === this._reg) return;
      if (this._reg) this._reg.delete(this);
      this._reg = reg;
      if (reg) reg.add(this);
    }
    setStart(node, offset) {
      setRangeBoundary(this, node, offset, "start");
    }
    setEnd(node, offset) {
      setRangeBoundary(this, node, offset, "end");
    }
    setStartBefore(node) {
      boundaryRelativeToNode(this, node, "start", false);
    }
    setStartAfter(node) {
      boundaryRelativeToNode(this, node, "start", true);
    }
    setEndBefore(node) {
      boundaryRelativeToNode(this, node, "end", false);
    }
    setEndAfter(node) {
      boundaryRelativeToNode(this, node, "end", true);
    }
    // selectNode spans `node` within its parent: start (parent, index),
    // end (parent, index+1). A parentless node → InvalidNodeTypeError.
    selectNode(node) {
      const parent = node && node._parent;
      if (!parent) {
        throw new globalThis.DOMException("Failed to execute 'selectNode' on 'Range': the node has no parent.", "InvalidNodeTypeError");
      }
      const index = parent._children.indexOf(node);
      this.startContainer = parent;
      this.startOffset = index;
      this.endContainer = parent;
      this.endOffset = index + 1;
      this._track();
    }
    // selectNodeContents spans the whole node: start (node, 0), end (node, length).
    // A doctype has no contents to select → InvalidNodeTypeError.
    selectNodeContents(node) {
      if (node.nodeType === NODE_DOCTYPE) {
        throw new globalThis.DOMException("Failed to execute 'selectNodeContents' on 'Range': the node is a doctype.", "InvalidNodeTypeError");
      }
      this.startContainer = this.endContainer = node;
      this.startOffset = 0;
      this.endOffset = nodeLength(node);
      this._track();
    }
    // `Range.createContextualFragment(html)` — parse `html` as a fragment using
    // the range's start node as context, returning a DocumentFragment owned by the
    // start node's document. The context element is the start node when it's an
    // Element (an `<html>` element, a non-element node, or none falls back to a
    // body context — which our body-context parseFragment already is). `fragment`
    // is a required WebIDL argument, so a missing one is a TypeError (not "").
    createContextualFragment(html) {
      if (arguments.length === 0) {
        throw new TypeError("Failed to execute 'createContextualFragment' on 'Range': 1 argument required, but only 0 present.");
      }
      const node = this.startContainer;
      const doc = node && node.ownerDocument || globalThis.document;
      const frag = doc.createDocumentFragment();
      for (const c of parseFragment(String(html))) frag.appendChild(c);
      doc.adoptNode(frag);
      walkSubtree(frag, (n) => {
        if (n._tag === "script") n._csimRan = false;
      });
      return frag;
    }
    // `Range.detach()` is a no-op in the modern DOM (kept for legacy callers).
    detach() {
    }
    // `Range.intersectsNode(node)` — true if any part of node overlaps
    // the range. quote-reply uses this to find which of the
    // window.getSelection() ranges intersects the issue description.
    intersectsNode(node) {
      if (!isNodeArg(node)) throw new TypeError("Failed to execute 'intersectsNode' on 'Range': parameter 1 is not of type 'Node'.");
      return rangeIntersectsNode(this, node);
    }
    // `Range.cloneContents()` — returns a DocumentFragment cloned from
    // the range. quote-reply walks the fragment's textContent / HTML
    // to build the quoted reply. The full DOM spec algorithm is
    // intricate (partial container splits, text-node boundary
    // handling, …); we implement the common-case subset that Redmine's
    // partial-quote tests exercise.
    cloneContents() {
      return cloneRangeContents(this);
    }
    extractContents() {
      return extractRangeContents(this);
    }
    // Spec: removes everything inside the range from its container.
    // Turbo's `FrameRenderer` calls `selectNodeContents(currentElement);
    // deleteContents()` to clear the lazy frame's loading placeholder
    // before grafting the response's frame content. Without this the
    // placeholder stays in place and the comment list never appears.
    deleteContents() {
      deleteRangeContents(this);
    }
    collapse(toStart) {
      if (toStart) {
        this.endContainer = this.startContainer;
        this.endOffset = this.startOffset;
      } else {
        this.startContainer = this.endContainer;
        this.startOffset = this.endOffset;
      }
    }
    // Range.getClientRects / getBoundingClientRect — return the
    // geometry of each rendered fragment covered by the range. PM's
    // domchange `singleRect` calls `textRange(child, 0, len).
    // getClientRects()` to measure changed text nodes. Layout-free,
    // so we return zero-rect stubs (matches Element's geometry stubs).
    getClientRects() {
      return [];
    }
    getBoundingClientRect() {
      return new globalThis.DOMRect(0, 0, 0, 0);
    }
    cloneRange() {
      const r = new _DocumentOrderRange();
      r.startContainer = this.startContainer;
      r.startOffset = this.startOffset;
      r.endContainer = this.endContainer;
      r.endOffset = this.endOffset;
      r._track();
      return r;
    }
    // DOM spec Range#toString: concatenates the text of all Text nodes
    // wholly or partly contained within the range, slicing the
    // boundary text nodes by start/end offset. Selection-API consumers
    // (Tiptap's domchange, Trix's range readback, our own `copy`
    // execCommand fallback) need this.
    toString() {
      const sc = this.startContainer, ec = this.endContainer;
      if (!sc || !ec) return "";
      if (sc === ec && sc.nodeType === NODE_TEXT) {
        const data = sc.data || "";
        return data.slice(this.startOffset, this.endOffset);
      }
      let out = "";
      let inRange = false;
      let done = false;
      walkSubtree(this.commonAncestorContainer || sc, (n) => {
        if (done) return;
        if (n === sc) {
          inRange = true;
          if (sc.nodeType === NODE_TEXT) out += (sc.data || "").slice(this.startOffset);
          return;
        }
        if (n === ec) {
          if (ec.nodeType === NODE_TEXT) out += (ec.data || "").slice(0, this.endOffset);
          done = true;
          return;
        }
        if (inRange && n.nodeType === NODE_TEXT) out += n.data || "";
      });
      return out;
    }
    // Range#insertNode(node): inserts `node` at the start of the range.
    // Per DOM spec, splits a Text startContainer at the offset, then
    // inserts the new node before the second half. For Element
    // containers, inserts at child index `startOffset`. Tiptap /
    // ProseMirror's text-insertion fallback uses this.
    insertNode(node) {
      if (!isNodeArg(node)) throw new TypeError("Failed to execute 'insertNode' on 'Range': parameter 1 is not of type 'Node'.");
      const sc = this.startContainer;
      const startIsText = sc.nodeType === NODE_TEXT || sc.nodeType === NODE_CDATA;
      if (sc.nodeType === NODE_PI || sc.nodeType === NODE_COMMENT || startIsText && !sc._parent || node === sc || nodeContains(node, sc)) {
        throw new globalThis.DOMException("Failed to execute 'insertNode' on 'Range': the node may not be inserted here.", "HierarchyRequestError");
      }
      let referenceNode = startIsText ? sc : sc._children ? sc._children[this.startOffset] || null : null;
      const parent = referenceNode == null ? sc : referenceNode._parent;
      ensurePreInsertionValidity(node, parent, referenceNode);
      if (startIsText) referenceNode = sc.splitText(this.startOffset);
      if (node === referenceNode) referenceNode = node.nextSibling;
      if (node._parent) node._parent.removeChild(node);
      let newOffset = referenceNode == null ? nodeLength(parent) : parent._children.indexOf(referenceNode);
      newOffset += node.nodeType === NODE_FRAGMENT ? nodeLength(node) : 1;
      parent.insertBefore(node, referenceNode);
      if (this.collapsed) {
        this.endContainer = parent;
        this.endOffset = newOffset;
      }
    }
    // Range#surroundContents(newParent): extract range contents, wrap
    // in `newParent`, insert wrapper at the range's start. Used by
    // highlight / annotate libraries.
    surroundContents(newParent) {
      const common = this.commonAncestorContainer;
      const partialNonText = /* @__PURE__ */ __name((boundary, other) => {
        if (nodeContains(boundary, other)) return false;
        for (let n = boundary; n && n !== common; n = n._parent) {
          if (n.nodeType !== NODE_TEXT && n.nodeType !== NODE_CDATA) return true;
        }
        return false;
      }, "partialNonText");
      if (partialNonText(this.startContainer, this.endContainer) || partialNonText(this.endContainer, this.startContainer)) {
        throw new globalThis.DOMException("Failed to execute 'surroundContents' on 'Range': the range partially selects a non-Text node.", "InvalidStateError");
      }
      const nt = newParent.nodeType;
      if (nt === NODE_DOC || nt === NODE_DOCTYPE || nt === NODE_FRAGMENT) {
        throw new globalThis.DOMException("Failed to execute 'surroundContents' on 'Range': the new parent is a Document, DocumentType, or DocumentFragment node.", "InvalidNodeTypeError");
      }
      const fragment = extractRangeContents(this);
      if (newParent._children) for (const c of newParent._children.slice()) newParent.removeChild(c);
      this.insertNode(newParent);
      newParent.appendChild(fragment);
      this.selectNode(newParent);
    }
    // Range#comparePoint(node, offset) — -1/0/+1 vs the range.
    // Range#isPointInRange(node, offset) — true if inside.
    comparePoint(node, offset) {
      if (!isNodeArg(node)) throw new TypeError("Failed to execute 'comparePoint' on 'Range': parameter 1 is not of type 'Node'.");
      if (ancestorChain(node)[0] !== ancestorChain(this.startContainer)[0]) {
        throw new globalThis.DOMException("The node provided is in a different tree than this Range.", "WrongDocumentError");
      }
      if (node.nodeType === NODE_DOCTYPE) {
        throw new globalThis.DOMException("Failed to execute 'comparePoint' on 'Range': the node is a doctype.", "InvalidNodeTypeError");
      }
      offset = offset >>> 0;
      if (offset > nodeLength(node)) {
        throw new globalThis.DOMException(`Failed to execute 'comparePoint' on 'Range': the offset ${offset} is larger than the node's length.`, "IndexSizeError");
      }
      if (compareBoundaryPoint(node, offset, this.startContainer, this.startOffset) < 0) return -1;
      if (compareBoundaryPoint(node, offset, this.endContainer, this.endOffset) > 0) return 1;
      return 0;
    }
    isPointInRange(node, offset) {
      if (!isNodeArg(node)) throw new TypeError("Failed to execute 'isPointInRange' on 'Range': parameter 1 is not of type 'Node'.");
      if (ancestorChain(node)[0] !== ancestorChain(this.startContainer)[0]) return false;
      if (node.nodeType === NODE_DOCTYPE) {
        throw new globalThis.DOMException("Failed to execute 'isPointInRange' on 'Range': the node is a doctype.", "InvalidNodeTypeError");
      }
      offset = offset >>> 0;
      if (offset > nodeLength(node)) {
        throw new globalThis.DOMException(`Failed to execute 'isPointInRange' on 'Range': the offset ${offset} is larger than the node's length.`, "IndexSizeError");
      }
      if (compareBoundaryPoint(node, offset, this.startContainer, this.startOffset) < 0) return false;
      if (compareBoundaryPoint(node, offset, this.endContainer, this.endOffset) > 0) return false;
      return true;
    }
    get collapsed() {
      return this.startContainer === this.endContainer && this.startOffset === this.endOffset;
    }
    get commonAncestorContainer() {
      if (!this.startContainer) return null;
      if (this.startContainer === this.endContainer) return this.startContainer;
      const a = ancestorChain(this.startContainer);
      const b = ancestorChain(this.endContainer);
      let i = 0;
      while (i < a.length && i < b.length && a[i] === b[i]) i++;
      return i > 0 ? a[i - 1] : this.startContainer;
    }
    // compareBoundaryPoints(how, sourceRange): compares the two ranges' boundary
    // points selected by `how`. `how` is a WebIDL unsigned short; a value outside
    // {0,1,2,3} → NotSupportedError. Different roots → WrongDocumentError.
    compareBoundaryPoints(how, other) {
      how = how & 65535;
      if (how > 3) {
        throw new globalThis.DOMException("Failed to execute 'compareBoundaryPoints' on 'Range': the comparison method must be 0, 1, 2 or 3.", "NotSupportedError");
      }
      if (ancestorChain(this.startContainer)[0] !== ancestorChain(other.startContainer)[0]) {
        throw new globalThis.DOMException("The two Ranges are not in the same tree.", "WrongDocumentError");
      }
      let tn, to, on, oo;
      if (how === 0) {
        tn = this.startContainer;
        to = this.startOffset;
        on = other.startContainer;
        oo = other.startOffset;
      } else if (how === 1) {
        tn = this.endContainer;
        to = this.endOffset;
        on = other.startContainer;
        oo = other.startOffset;
      } else if (how === 2) {
        tn = this.endContainer;
        to = this.endOffset;
        on = other.endContainer;
        oo = other.endOffset;
      } else {
        tn = this.startContainer;
        to = this.startOffset;
        on = other.endContainer;
        oo = other.endOffset;
      }
      return compareBoundaryPoint(tn, to, on, oo);
    }
  };
  DocumentOrderRange.START_TO_START = 0;
  DocumentOrderRange.START_TO_END = 1;
  DocumentOrderRange.END_TO_END = 2;
  DocumentOrderRange.END_TO_START = 3;
  DocumentOrderRange.prototype.START_TO_START = 0;
  DocumentOrderRange.prototype.START_TO_END = 1;
  DocumentOrderRange.prototype.END_TO_END = 2;
  DocumentOrderRange.prototype.END_TO_START = 3;
  function nodeContains(ancestor, descendant) {
    return ancestor != null && ancestor.contains ? ancestor.contains(descendant) : false;
  }
  __name(nodeContains, "nodeContains");
  var FORM_ASSOCIATED_TAGS = /* @__PURE__ */ new Set([
    "input",
    "select",
    "textarea",
    "button",
    "fieldset",
    "object",
    "output"
  ]);
  function compareBoundaryPoint(nodeA, offsetA, nodeB, offsetB) {
    if (nodeA === nodeB) return offsetA < offsetB ? -1 : offsetA > offsetB ? 1 : 0;
    if (compareDocOrder(nodeA, nodeB) > 0) return -compareBoundaryPoint(nodeB, offsetB, nodeA, offsetA);
    if (nodeContains(nodeA, nodeB)) {
      let child = nodeB;
      while (child && child._parent !== nodeA) child = child._parent;
      if (child) return nodeA._children.indexOf(child) < offsetA ? 1 : -1;
    }
    return -1;
  }
  __name(compareBoundaryPoint, "compareBoundaryPoint");
  function rangeIntersectsNode(range, node) {
    if (!range.startContainer) return false;
    if (ancestorChain(node)[0] !== ancestorChain(range.startContainer)[0]) return false;
    const parent = node._parent;
    if (!parent) return true;
    const offset = parent._children.indexOf(node);
    return compareBoundaryPoint(parent, offset, range.endContainer, range.endOffset) < 0 && compareBoundaryPoint(parent, offset + 1, range.startContainer, range.startOffset) > 0;
  }
  __name(rangeIntersectsNode, "rangeIntersectsNode");
  function __rangeAncestorChild(ancestor, descendant) {
    let cur = descendant;
    while (cur && cur._parent && cur._parent !== ancestor) cur = cur._parent;
    return cur && cur._parent === ancestor ? cur : null;
  }
  __name(__rangeAncestorChild, "__rangeAncestorChild");
  function __csimInsertTextAtSelection(text) {
    const sel = globalThis.getSelection && globalThis.getSelection();
    if (!sel || !sel._ranges.length) return false;
    let range = sel._ranges[0];
    let sc = range.startContainer;
    if (sc && !isConnected(sc)) {
      const doc = globalThis.document;
      const active = doc && doc.activeElement;
      if (active && active.nodeType === NODE_ELEMENT && isContenteditable(active)) {
        const VOID_TAGS = /* @__PURE__ */ new Set(["br", "img", "hr", "input", "wbr", "meta", "link"]);
        let leaf = active;
        while (leaf._children && leaf._children.length > 0) {
          const next = leaf._children.find(
            (c) => c.nodeType === NODE_ELEMENT && !VOID_TAGS.has(c._tag)
          );
          if (!next) break;
          leaf = next;
        }
        sel.collapse(leaf, leaf._children ? leaf._children.length : 0);
        range = sel._ranges[0];
        sc = range.startContainer;
      } else {
        return false;
      }
    }
    if (!range.collapsed) deleteRangeContents(range);
    const so = range.startOffset | 0;
    if (!sc) return false;
    if (sc.nodeType === NODE_TEXT) {
      const before = sc._data.slice(0, so);
      const after = sc._data.slice(so);
      sc.data = before + text + after;
      const newPos = so + text.length;
      range.startContainer = sc;
      range.endContainer = sc;
      range.startOffset = newPos;
      range.endOffset = newPos;
      globalThis.__notifySelectionChange();
      return true;
    }
    const children = sc._children || [];
    const prevNode = children[so - 1];
    const atNode = children[so];
    if (prevNode && prevNode.nodeType === NODE_TEXT) {
      const oldLen = prevNode._data.length;
      prevNode.data = prevNode._data + text;
      range.startContainer = prevNode;
      range.endContainer = prevNode;
      range.startOffset = oldLen + text.length;
      range.endOffset = range.startOffset;
    } else if (atNode && atNode.nodeType === NODE_TEXT) {
      atNode.data = text + atNode._data;
      range.startContainer = atNode;
      range.endContainer = atNode;
      range.startOffset = text.length;
      range.endOffset = range.startOffset;
    } else {
      const t = new Text(text);
      if (atNode) sc.insertBefore(t, atNode);
      else sc.appendChild(t);
      range.startContainer = t;
      range.endContainer = t;
      range.startOffset = text.length;
      range.endOffset = range.startOffset;
    }
    globalThis.__notifySelectionChange();
    return true;
  }
  __name(__csimInsertTextAtSelection, "__csimInsertTextAtSelection");
  globalThis.__csimInsertTextAtSelection = __csimInsertTextAtSelection;
  function isCharacterData(n) {
    return n != null && (n.nodeType === NODE_TEXT || n.nodeType === NODE_CDATA || n.nodeType === NODE_COMMENT || n.nodeType === NODE_PI);
  }
  __name(isCharacterData, "isCharacterData");
  function processRangeContents(range, mode) {
    const sc = range.startContainer, so = range.startOffset;
    const ec = range.endContainer, eo = range.endOffset;
    const ownerDoc = sc && (sc.nodeType === NODE_DOC ? sc : sc.ownerDocument) || globalThis.document;
    const frag = mode === "delete" ? null : ownerDoc.createDocumentFragment();
    if (!sc || !ec) return frag;
    if (sc === ec && so === eo) return frag;
    if (sc === ec && isCharacterData(sc)) {
      if (mode !== "delete") {
        const clone = sc.cloneNode(false);
        clone._data = (sc.data || "").slice(so, eo);
        frag.appendChild(clone);
      }
      if (mode !== "clone") sc._replaceData(so, eo - so, "");
      return frag;
    }
    const common = range.commonAncestorContainer;
    const firstPC = nodeContains(sc, ec) ? null : __rangeAncestorChild(common, sc);
    const lastPC = nodeContains(ec, sc) ? null : __rangeAncestorChild(common, ec);
    const contained = [];
    const kids = common._children || [];
    for (let i = 0; i < kids.length; i++) {
      if (compareBoundaryPoint(common, i, sc, so) >= 0 && compareBoundaryPoint(common, i + 1, ec, eo) <= 0) {
        contained.push(kids[i]);
      }
    }
    let newNode = sc, newOffset = so;
    if (mode !== "clone" && !nodeContains(sc, ec)) {
      let ref = sc;
      while (ref._parent && !nodeContains(ref._parent, ec)) ref = ref._parent;
      newNode = ref._parent;
      newOffset = newNode._children.indexOf(ref) + 1;
    }
    if (isCharacterData(firstPC)) {
      if (mode !== "delete") {
        const clone = sc.cloneNode(false);
        clone._data = (sc.data || "").slice(so);
        frag.appendChild(clone);
      }
      if (mode !== "clone") sc._replaceData(so, nodeLength(sc) - so, "");
    } else if (firstPC) {
      let clone = null;
      if (mode !== "delete") {
        clone = firstPC.cloneNode(false);
        frag.appendChild(clone);
      }
      const sub = new DocumentOrderRange(ownerDoc);
      sub.startContainer = sc;
      sub.startOffset = so;
      sub.endContainer = firstPC;
      sub.endOffset = nodeLength(firstPC);
      const subResult = processRangeContents(sub, mode);
      if (clone) clone.appendChild(subResult);
      if (sub._reg) sub._reg.delete(sub);
    }
    for (const child of contained) {
      if (mode === "clone") frag.appendChild(child.cloneNode(true));
      else if (mode === "extract") frag.appendChild(child);
      else if (child._parent) child._parent.removeChild(child);
    }
    if (isCharacterData(lastPC)) {
      if (mode !== "delete") {
        const clone = ec.cloneNode(false);
        clone._data = (ec.data || "").slice(0, eo);
        frag.appendChild(clone);
      }
      if (mode !== "clone") ec._replaceData(0, eo, "");
    } else if (lastPC) {
      let clone = null;
      if (mode !== "delete") {
        clone = lastPC.cloneNode(false);
        frag.appendChild(clone);
      }
      const sub = new DocumentOrderRange(ownerDoc);
      sub.startContainer = lastPC;
      sub.startOffset = 0;
      sub.endContainer = ec;
      sub.endOffset = eo;
      const subResult = processRangeContents(sub, mode);
      if (clone) clone.appendChild(subResult);
      if (sub._reg) sub._reg.delete(sub);
    }
    if (mode !== "clone") {
      range.startContainer = newNode;
      range.startOffset = newOffset;
      range.endContainer = newNode;
      range.endOffset = newOffset;
    }
    return frag;
  }
  __name(processRangeContents, "processRangeContents");
  function deleteRangeContents(range) {
    processRangeContents(range, "delete");
  }
  __name(deleteRangeContents, "deleteRangeContents");
  function cloneRangeContents(range) {
    return processRangeContents(range, "clone");
  }
  __name(cloneRangeContents, "cloneRangeContents");
  function extractRangeContents(range) {
    return processRangeContents(range, "extract");
  }
  __name(extractRangeContents, "extractRangeContents");
  DocumentOrderRange.END_TO_START = 3;
  DocumentOrderRange.prototype.START_TO_START = 0;
  DocumentOrderRange.prototype.START_TO_END = 1;
  DocumentOrderRange.prototype.END_TO_END = 2;
  DocumentOrderRange.prototype.END_TO_START = 3;
  globalThis.Range = DocumentOrderRange;
  var StaticRange = class {
    static {
      __name(this, "StaticRange");
    }
    constructor(init) {
      const i = init == null ? {} : init;
      if (!isNodeArg(i.startContainer) || !isNodeArg(i.endContainer)) {
        throw new TypeError("Failed to construct 'StaticRange': a required Node member is undefined or null.");
      }
      if (i.startOffset === void 0 || i.endOffset === void 0) {
        throw new TypeError("Failed to construct 'StaticRange': a required offset member is undefined.");
      }
      if (i.startContainer.nodeType === NODE_DOCTYPE || i.startContainer.nodeType === NODE_ATTRIBUTE || i.endContainer.nodeType === NODE_DOCTYPE || i.endContainer.nodeType === NODE_ATTRIBUTE) {
        throw new globalThis.DOMException(
          "Failed to construct 'StaticRange': a DocumentType or Attr node may not be a container.",
          "InvalidNodeTypeError"
        );
      }
      this._startContainer = i.startContainer;
      this._startOffset = i.startOffset >>> 0;
      this._endContainer = i.endContainer;
      this._endOffset = i.endOffset >>> 0;
    }
    get startContainer() {
      return this._startContainer;
    }
    get startOffset() {
      return this._startOffset;
    }
    get endContainer() {
      return this._endContainer;
    }
    get endOffset() {
      return this._endOffset;
    }
    get collapsed() {
      return this._startContainer === this._endContainer && this._startOffset === this._endOffset;
    }
  };
  globalThis.StaticRange = StaticRange;
  var XML_SER_VOID = /* @__PURE__ */ new Set([
    "area",
    "base",
    "basefont",
    "bgsound",
    "br",
    "col",
    "embed",
    "frame",
    "hr",
    "img",
    "input",
    "keygen",
    "link",
    "menuitem",
    "meta",
    "param",
    "source",
    "track",
    "wbr"
  ]);
  function xmlSerIsXmlChar(s) {
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c >= 55296 && c <= 56319) {
        const n = s.charCodeAt(i + 1);
        if (n >= 56320 && n <= 57343) {
          i++;
          continue;
        }
        return false;
      }
      if (c >= 56320 && c <= 57343) return false;
      if (c === 9 || c === 10 || c === 13) continue;
      if (c >= 32 && c <= 55295) continue;
      if (c >= 57344 && c <= 65533) continue;
      return false;
    }
    return true;
  }
  __name(xmlSerIsXmlChar, "xmlSerIsXmlChar");
  function xmlSerWfThrow(message) {
    throw new globalThis.DOMException(message, "InvalidStateError");
  }
  __name(xmlSerWfThrow, "xmlSerWfThrow");
  function xmlSerLocalName(el) {
    return el._localName || el._tag;
  }
  __name(xmlSerLocalName, "xmlSerLocalName");
  function xmlSerAttrList(el) {
    const list = [];
    const attrs = el._attrs || {};
    const meta = el._attrNS;
    for (const key of Object.keys(attrs)) {
      const m = meta && meta[key];
      list.push({
        namespaceURI: m ? m.ns || null : null,
        prefix: m ? m.prefix || null : null,
        localName: m ? m.localName : key,
        value: attrs[key]
      });
    }
    return list;
  }
  __name(xmlSerAttrList, "xmlSerAttrList");
  function xmlSerEscapeAttrValue(value) {
    if (value === null) return "";
    return String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\t/g, "&#x9;").replace(/\n/g, "&#xA;").replace(/\r/g, "&#xD;");
  }
  __name(xmlSerEscapeAttrValue, "xmlSerEscapeAttrValue");
  function xmlSerCopyMap(map) {
    const out = /* @__PURE__ */ Object.create(null);
    for (const ns in map) out[ns] = map[ns].slice();
    return out;
  }
  __name(xmlSerCopyMap, "xmlSerCopyMap");
  function xmlSerGeneratePrefix(map, newNamespace, refs) {
    const generated = "ns" + refs.prefixIndex;
    refs.prefixIndex += 1;
    map[newNamespace] = [generated];
    return generated;
  }
  __name(xmlSerGeneratePrefix, "xmlSerGeneratePrefix");
  function xmlSerPreferredPrefix(map, ns, preferredPrefix) {
    const candidates = map[ns];
    if (!candidates) return null;
    if (candidates.includes(preferredPrefix)) return preferredPrefix;
    return candidates[candidates.length - 1];
  }
  __name(xmlSerPreferredPrefix, "xmlSerPreferredPrefix");
  function xmlSerPrefixInUse(map, prefix) {
    for (const ns in map) if (map[ns].includes(prefix)) return true;
    return false;
  }
  __name(xmlSerPrefixInUse, "xmlSerPrefixInUse");
  function xmlSerRecordNamespaces(el, map, localPrefixes) {
    let defaultNamespaceAttrValue = null;
    for (const attr of xmlSerAttrList(el)) {
      if (attr.namespaceURI === null && attr.localName === "xmlns" && attr.prefix === null) {
        defaultNamespaceAttrValue = attr.value;
        continue;
      }
      if (attr.namespaceURI !== XMLNS_NS2) continue;
      if (attr.prefix === null) {
        defaultNamespaceAttrValue = attr.value;
        continue;
      }
      let namespaceDefinition = attr.value;
      if (namespaceDefinition === XML_NS2) continue;
      if (namespaceDefinition === null) namespaceDefinition = "";
      if (map[namespaceDefinition] && map[namespaceDefinition].includes(attr.localName)) continue;
      if (!map[namespaceDefinition]) map[namespaceDefinition] = [];
      map[namespaceDefinition].push(attr.localName);
      localPrefixes[attr.localName] = namespaceDefinition;
    }
    return defaultNamespaceAttrValue;
  }
  __name(xmlSerRecordNamespaces, "xmlSerRecordNamespaces");
  function xmlSerSerializeAttributes(el, map, localPrefixes, ignoreNamespaceDefAttr, refs) {
    let result = "";
    for (const attr of xmlSerAttrList(el)) {
      const attributeNamespace = attr.namespaceURI;
      let candidatePrefix = null;
      if (attributeNamespace !== null) {
        candidatePrefix = xmlSerPreferredPrefix(map, attributeNamespace, attr.prefix);
        if (attributeNamespace === XMLNS_NS2) {
          if (attr.value === XML_NS2 || attr.prefix === null && ignoreNamespaceDefAttr || attr.prefix !== null && localPrefixes[attr.localName] !== attr.value && map[attr.value] && map[attr.value].includes(attr.localName)) {
            continue;
          }
          if (attr.prefix === "xmlns") candidatePrefix = "xmlns";
        } else if (candidatePrefix === null) {
          if (attr.prefix !== null && attr.prefix !== "xmlns" && !xmlSerPrefixInUse(map, attr.prefix)) {
            candidatePrefix = attr.prefix;
            if (map[attributeNamespace]) map[attributeNamespace].push(candidatePrefix);
            else map[attributeNamespace] = [candidatePrefix];
          } else {
            candidatePrefix = xmlSerGeneratePrefix(map, attributeNamespace, refs);
          }
          result += " xmlns:" + candidatePrefix + '="' + xmlSerEscapeAttrValue(attributeNamespace) + '"';
        }
      }
      result += " ";
      if (candidatePrefix !== null) result += candidatePrefix + ":";
      if (refs.wf && (String(attr.localName).indexOf(":") !== -1 || !xmlSerIsXmlChar(String(attr.value == null ? "" : attr.value)))) {
        xmlSerWfThrow("Failed to serialize XML: attribute is not well-formed.");
      }
      result += attr.localName + '="' + xmlSerEscapeAttrValue(attr.value) + '"';
    }
    return result;
  }
  __name(xmlSerSerializeAttributes, "xmlSerSerializeAttributes");
  function xmlSerSerializeElement(node, namespace, prefixMap, refs) {
    if (refs.wf && xmlSerLocalName(node).indexOf(":") !== -1) {
      xmlSerWfThrow("Failed to serialize XML: an element's local name contains ':'.");
    }
    let markup = "<";
    let qualifiedName = "";
    let skipEndTag = false;
    let ignoreNamespaceDefAttr = false;
    const map = xmlSerCopyMap(prefixMap);
    const localPrefixes = /* @__PURE__ */ Object.create(null);
    const localDefaultNamespace = xmlSerRecordNamespaces(node, map, localPrefixes);
    let inheritedNs = namespace;
    const ns = node._ns || null;
    if (inheritedNs === ns) {
      if (localDefaultNamespace !== null) ignoreNamespaceDefAttr = true;
      qualifiedName = ns === XML_NS2 ? "xml:" + xmlSerLocalName(node) : xmlSerLocalName(node);
      markup += qualifiedName;
    } else {
      let prefix = node._prefix || null;
      let candidatePrefix = xmlSerPreferredPrefix(map, ns, prefix);
      if (prefix === "xmlns") candidatePrefix = "xmlns";
      if (candidatePrefix !== null) {
        qualifiedName = candidatePrefix + ":" + xmlSerLocalName(node);
        if (localDefaultNamespace !== null && localDefaultNamespace !== XML_NS2) {
          inheritedNs = localDefaultNamespace === "" ? null : localDefaultNamespace;
        }
        markup += qualifiedName;
      } else if (prefix !== null) {
        if (prefix in localPrefixes) prefix = xmlSerGeneratePrefix(map, ns, refs);
        if (map[ns]) map[ns].push(prefix);
        else map[ns] = [prefix];
        qualifiedName = prefix + ":" + xmlSerLocalName(node);
        markup += qualifiedName + " xmlns:" + prefix + '="' + xmlSerEscapeAttrValue(ns) + '"';
        if (localDefaultNamespace !== null) {
          inheritedNs = localDefaultNamespace === "" ? null : localDefaultNamespace;
        }
      } else if (localDefaultNamespace === null || localDefaultNamespace !== ns) {
        ignoreNamespaceDefAttr = true;
        qualifiedName = xmlSerLocalName(node);
        inheritedNs = ns;
        markup += qualifiedName + ' xmlns="' + xmlSerEscapeAttrValue(ns) + '"';
      } else {
        qualifiedName = xmlSerLocalName(node);
        inheritedNs = ns;
        markup += qualifiedName;
      }
    }
    markup += xmlSerSerializeAttributes(node, map, localPrefixes, ignoreNamespaceDefAttr, refs);
    const kids = node._children || [];
    if (ns === HTML_NS2 && kids.length === 0 && XML_SER_VOID.has(xmlSerLocalName(node))) {
      markup += " /";
      skipEndTag = true;
    } else if (ns !== HTML_NS2 && kids.length === 0) {
      markup += "/";
      skipEndTag = true;
    }
    markup += ">";
    if (skipEndTag) return markup;
    if (ns === HTML_NS2 && xmlSerLocalName(node) === "template" && node.content) {
      markup += xmlSerSerializeNode(node.content, inheritedNs, map, refs);
    } else {
      for (const child of kids) markup += xmlSerSerializeNode(child, inheritedNs, map, refs);
    }
    markup += "</" + qualifiedName + ">";
    return markup;
  }
  __name(xmlSerSerializeElement, "xmlSerSerializeElement");
  function xmlSerSerializeDoctype(dt) {
    let markup = "<!DOCTYPE " + dt.name;
    if (dt.publicId) markup += ' PUBLIC "' + dt.publicId + '"';
    else if (dt.systemId) markup += " SYSTEM";
    if (dt.systemId) markup += ' "' + dt.systemId + '"';
    return markup + ">";
  }
  __name(xmlSerSerializeDoctype, "xmlSerSerializeDoctype");
  function xmlSerSerializeNode(node, namespace, prefixMap, refs) {
    switch (node.nodeType) {
      case NODE_ELEMENT:
        return xmlSerSerializeElement(node, namespace, prefixMap, refs);
      case NODE_TEXT: {
        const data = node._data == null ? "" : String(node._data);
        if (refs.wf && !xmlSerIsXmlChar(data)) {
          xmlSerWfThrow("Failed to serialize XML: text node data contains a character not allowed by the XML Char production.");
        }
        return escapeText(node._data == null ? "" : node._data);
      }
      case NODE_CDATA: {
        const data = String(node._data == null ? "" : node._data);
        if (refs.wf && (!xmlSerIsXmlChar(data) || data.indexOf("]]>") !== -1)) {
          xmlSerWfThrow("Failed to serialize XML: CDATA section data is not well-formed.");
        }
        return "<![CDATA[" + node._data + "]]>";
      }
      case NODE_COMMENT: {
        const data = String(node._data == null ? "" : node._data);
        if (refs.wf && (!xmlSerIsXmlChar(data) || data.indexOf("--") !== -1 || data.endsWith("-"))) {
          xmlSerWfThrow("Failed to serialize XML: comment node data is not well-formed.");
        }
        return "<!--" + node._data + "-->";
      }
      case NODE_PI: {
        const data = String(node._data == null ? "" : node._data);
        const target = String(node._target == null ? "" : node._target);
        if (refs.wf && (target.indexOf(":") !== -1 || /^xml$/i.test(target) || !xmlSerIsXmlChar(data) || data.indexOf("?>") !== -1)) {
          xmlSerWfThrow("Failed to serialize XML: processing instruction node is not well-formed.");
        }
        return "<?" + node._target + " " + node._data + "?>";
      }
      case NODE_DOCTYPE:
        return xmlSerSerializeDoctype(node);
      case NODE_ATTRIBUTE:
        return "";
      case NODE_DOC:
      case NODE_FRAGMENT: {
        let out = "";
        for (const child of node._children || []) out += xmlSerSerializeNode(child, namespace, prefixMap, refs);
        return out;
      }
      default:
        return "";
    }
  }
  __name(xmlSerSerializeNode, "xmlSerSerializeNode");
  function xmlSerializeInner(el) {
    const map = /* @__PURE__ */ Object.create(null);
    map[XML_NS2] = ["xml"];
    const refs = { prefixIndex: 1, wf: true };
    let out = "";
    for (const c of el._children || []) out += xmlSerSerializeNode(c, null, map, refs);
    return out;
  }
  __name(xmlSerializeInner, "xmlSerializeInner");
  function xmlSerializeOuter(el) {
    const map = /* @__PURE__ */ Object.create(null);
    map[XML_NS2] = ["xml"];
    return xmlSerSerializeNode(el, null, map, { prefixIndex: 1, wf: true });
  }
  __name(xmlSerializeOuter, "xmlSerializeOuter");
  var XMLSerializer = class {
    static {
      __name(this, "XMLSerializer");
    }
    serializeToString(node) {
      if (!node || typeof node.nodeType !== "number") {
        throw new TypeError("Failed to execute 'serializeToString' on 'XMLSerializer': parameter 1 is not of type 'Node'.");
      }
      const map = /* @__PURE__ */ Object.create(null);
      map[XML_NS2] = ["xml"];
      return xmlSerSerializeNode(node, null, map, { prefixIndex: 1 });
    }
  };
  globalThis.XMLSerializer = XMLSerializer;
  function moveBeforeImpl(node, child) {
    if (arguments.length < 2) {
      throw new TypeError("Failed to execute 'moveBefore': 2 arguments required");
    }
    assertNodeArg(node);
    if (child != null) assertNodeArg(child);
    const parent = this;
    if (node.getRootNode({ composed: true }) !== parent.getRootNode({ composed: true })) {
      throw hierarchyError("moveBefore: node and new parent are not in the same tree");
    }
    if (isInclusiveAncestor(node, parent)) {
      throw hierarchyError("moveBefore: the moved node is an ancestor of the new parent");
    }
    if (child != null && child._parent !== parent) {
      throw new globalThis.DOMException("The reference child is not a child of this node", "NotFoundError");
    }
    const t = node.nodeType;
    if (t !== NODE_ELEMENT && t !== NODE_TEXT && t !== NODE_CDATA && t !== NODE_COMMENT && t !== NODE_PI) {
      throw hierarchyError(`moveBefore: a ${nodeTypeName(node)} node cannot be moved`);
    }
    if (parent.nodeType === NODE_DOC) {
      if (t === NODE_TEXT || t === NODE_CDATA) {
        throw hierarchyError("moveBefore: a Text node cannot be a child of a Document");
      }
      if (t === NODE_ELEMENT && parent._children.some((c) => c.nodeType === NODE_ELEMENT && c !== node)) {
        throw hierarchyError("moveBefore: a Document can contain only one element child");
      }
    }
    let ref = child === node ? node.nextSibling : child;
    const oldParent = node._parent;
    let prevSib = null, nextSib = null;
    if (oldParent) {
      const oi = oldParent._children.indexOf(node);
      if (oi >= 0) {
        prevSib = oi > 0 ? oldParent._children[oi - 1] : null;
        nextSib = oi + 1 < oldParent._children.length ? oldParent._children[oi + 1] : null;
        oldParent._children.splice(oi, 1);
      }
    }
    node._parent = parent;
    const ii = ref == null ? -1 : parent._children.indexOf(ref);
    if (ii < 0) parent._children.push(node);
    else parent._children.splice(ii, 0, node);
    askForReset(node);
    if (oldParent) recordChildList(oldParent, [], [node], prevSib, nextSib);
    recordChildList(parent, [node], []);
    if (isConnected(node)) fireCEMoveReactions(node);
    return void 0;
  }
  __name(moveBeforeImpl, "moveBeforeImpl");
  Element.prototype.moveBefore = moveBeforeImpl;
  Document.prototype.moveBefore = moveBeforeImpl;
  DocumentFragment.prototype.moveBefore = moveBeforeImpl;
  Object.defineProperty(Element.prototype, Symbol.unscopables, {
    value: Object.assign(/* @__PURE__ */ Object.create(null), {
      after: true,
      append: true,
      before: true,
      prepend: true,
      remove: true,
      replaceChildren: true,
      replaceWith: true,
      slot: true,
      moveBefore: true
    }),
    writable: false,
    enumerable: false,
    configurable: true
  });
  function compareDocOrder(a, b) {
    if (a === b) return 0;
    const chainA = ancestorChain(a), chainB = ancestorChain(b);
    let i = 0;
    while (i < chainA.length && i < chainB.length && chainA[i] === chainB[i]) i++;
    if (i === 0) return 0;
    const lca = chainA[i - 1];
    if (i === chainA.length) return -1;
    if (i === chainB.length) return 1;
    const idxA = lca._children.indexOf(chainA[i]);
    const idxB = lca._children.indexOf(chainB[i]);
    return idxA < idxB ? -1 : idxA > idxB ? 1 : 0;
  }
  __name(compareDocOrder, "compareDocOrder");
  function ancestorChain(node) {
    const chain = [];
    let cur = node;
    while (cur) {
      chain.unshift(cur);
      cur = cur._parent;
    }
    return chain;
  }
  __name(ancestorChain, "ancestorChain");
  var __nodeOrdinalSeq = 0;
  function __nodeOrdinal(node) {
    if (node.__ordinal == null) {
      Object.defineProperty(node, "__ordinal", {
        value: ++__nodeOrdinalSeq,
        enumerable: false,
        writable: true,
        configurable: true
      });
    }
    return node.__ordinal;
  }
  __name(__nodeOrdinal, "__nodeOrdinal");
  function makeAttr(el, key) {
    return el._attrNodeFor(key);
  }
  __name(makeAttr, "makeAttr");
  var { parseDocument, parseFragment } = installHtmlParser({ Document, Element, Text, Comment, DocumentFragment, DocumentType, createHtmlPageDocument, registerNamedAccess });
  var { parseXml } = installXmlParser({ Element, Text, Comment, ProcessingInstruction, CDATASection, DocumentType });
  function parseXmlFragment(html, context) {
    const nodes = parseXml(String(html === null ? "" : html), { context });
    if (nodes === null) {
      throw new globalThis.DOMException("The given markup is invalid XML, and therefore cannot be inserted into an XML document.", "SyntaxError");
    }
    return nodes;
  }
  __name(parseXmlFragment, "parseXmlFragment");

  // lib/capybara/simulated/js/src/dispatch.js
  var NOOP = /* @__PURE__ */ __name(() => {
  }, "NOOP");
  function dispatchEvent(target, event) {
    if (event && (event._dispatchFlag || event._initialized === false)) {
      throw new globalThis.DOMException(
        "The event is already being dispatched, or has not been initialized.",
        "InvalidStateError"
      );
    }
    return dispatchPath(target, event, NOOP);
  }
  __name(dispatchEvent, "dispatchEvent");
  function dispatchEventForUserAction(target, event) {
    return dispatchPath(target, event, globalThis.__csim_yield || NOOP);
  }
  __name(dispatchEventForUserAction, "dispatchEventForUserAction");
  function dispatchPath(target, event, drain) {
    event.target = target;
    event._dispatchFlag = true;
    let path;
    let structMap = null;
    let topSat = target;
    let windowRel;
    let clearTargets = false;
    const origRelated = event.relatedTarget;
    if (!hasShadowRoots()) {
      path = [];
      for (let cur = target; cur; cur = cur._parent) path.push(cur);
    } else {
      const built = buildFlatTreePath(target, event);
      const structs = built.structs;
      path = new Array(structs.length);
      structMap = /* @__PURE__ */ new Map();
      for (let i = 0; i < structs.length; i++) {
        path[i] = structs[i].node;
        structMap.set(structs[i].node, structs[i]);
      }
      if (structs.length) {
        const topStruct = structs[structs.length - 1];
        topSat = topStruct.sat;
        if (origRelated != null) windowRel = retarget(origRelated, globalThis);
        clearTargets = nodeRoot(topSat)._isShadowRoot || topStruct.rel != null && nodeRoot(topStruct.rel)._isShadowRoot;
      }
      event._csimPath = built.reachesWindow ? structs.concat([{ node: globalThis, rootClosed: false, slotClosed: false }]) : structs;
      event._csimStructMap = structMap;
    }
    const prevWinEvent = globalThis.event;
    globalThis.event = event;
    if (structMap) event._csimPrevWinEvent = prevWinEvent;
    let ckActivation = null;
    try {
      if (event.type === "click" && !event._csimActivationHandled && event instanceof MouseEvent) {
        let actNode = null;
        for (let i = 0; i < path.length; i++) {
          const n = path[i];
          if (n.nodeType === NODE_ELEMENT && n._tag === "input") {
            const it = (n._attrs.type || "").toLowerCase();
            if (it === "checkbox" || it === "radio") {
              actNode = n;
              break;
            }
          }
          if (!event.bubbles) break;
        }
        const itype = actNode ? (actNode._attrs.type || "").toLowerCase() : "";
        if (itype === "checkbox") {
          ckActivation = { kind: "checkbox", node: actNode, wasChecked: actNode._attrs.checked != null };
          toggleChecked(actNode);
        } else if (itype === "radio") {
          ckActivation = { kind: "radio", node: actNode, prevChecked: checkedRadioInGroup(actNode) };
          setRadio(actNode);
        }
      }
      event.eventPhase = 1;
      if (structMap) {
        event.target = topSat;
        if (windowRel !== void 0) event.relatedTarget = windowRel;
        globalThis.event = event;
      }
      if (path.length && fireWindowListeners(event, true)) drain();
      if (!event._propagationStopped) {
        for (let i = path.length - 1; i > 0; i--) {
          if (fireListeners(path[i], event, true)) drain();
          if (event._propagationStopped) break;
        }
      }
      if (path.length && !event._propagationStopped) {
        event.eventPhase = 2;
        const a = fireListeners(target, event, true);
        const b = event._propagationStopped ? false : fireListeners(target, event, false);
        if (a || b) drain();
      }
      if (path.length && !event._propagationStopped && event.bubbles) {
        event.eventPhase = 3;
        let bubbleLimit = path.length;
        if (event.type === "submit" || event.type === "reset") {
          for (let i = 1; i < path.length; i++) {
            const n = path[i];
            if (n.nodeType === NODE_ELEMENT && n._tag === "form") {
              bubbleLimit = i;
              break;
            }
          }
        }
        for (let i = 1; i < bubbleLimit; i++) {
          if (fireListeners(path[i], event, false)) drain();
          if (event._propagationStopped) break;
        }
        if (!event._propagationStopped && bubbleLimit === path.length) {
          if (structMap) {
            event.target = topSat;
            if (windowRel !== void 0) event.relatedTarget = windowRel;
            event.eventPhase = 3;
            globalThis.event = event;
          }
          if (fireWindowListeners(event, false)) drain();
        }
      }
      if (!event.defaultPrevented && event.type === "click") {
        let anchor = target;
        if (anchor && anchor.nodeType === NODE_ELEMENT && anchor._tag !== "area") {
          while (anchor && anchor.nodeType === NODE_ELEMENT && anchor._tag !== "a") {
            anchor = anchor._parent;
          }
        }
        if (anchor && anchor.nodeType === NODE_ELEMENT && (anchor._tag === "a" || anchor._tag === "area") && anchor._attrs.href != null) {
          if (event instanceof MouseEvent && /^\s*javascript:/i.test(anchor._attrs.href)) {
            const code = String(anchor._attrs.href).replace(/^\s*javascript:/i, "");
            if (typeof globalThis.setTimeout === "function") {
              globalThis.setTimeout(() => {
                try {
                  new Function(code)();
                } catch (e) {
                  if (typeof globalThis.reportError === "function") {
                    try {
                      globalThis.reportError(e);
                    } catch (_) {
                    }
                  }
                }
              }, 0);
            }
          } else if (anchor._tag === "a" && anchor._attrs.download != null) {
            globalThis.__csimPendingDownload = {
              url: String(anchor._attrs.href),
              filename: String(anchor._attrs.download || "")
            };
          }
        }
      }
    } finally {
      event.eventPhase = 0;
      event._currentTarget = null;
      event._dispatchFlag = false;
      event._propagationStopped = false;
      event._immediatePropagationStopped = false;
      if (hasObservers() && hasQueuedRecords()) Promise.resolve().then(deliverMutations);
      if (typeof globalThis.__recheckIntersectionObservers === "function") globalThis.__recheckIntersectionObservers();
      globalThis.event = prevWinEvent;
      if (structMap) {
        if (path.length) {
          if (clearTargets) {
            event.target = null;
            event.relatedTarget = null;
          } else {
            event.target = topSat;
            if (windowRel !== void 0) event.relatedTarget = windowRel;
          }
        }
        event._csimPath = null;
        event._csimStructMap = null;
        event._csimPrevWinEvent = void 0;
      }
    }
    if (ckActivation) {
      const node = ckActivation.node;
      if (event.defaultPrevented) {
        if (ckActivation.kind === "radio") {
          delete node._attrs.checked;
          if (ckActivation.prevChecked) ckActivation.prevChecked._attrs.checked = "";
        } else if (ckActivation.wasChecked) {
          node._attrs.checked = "";
        } else {
          delete node._attrs.checked;
        }
      } else {
        const wasChecked = ckActivation.kind === "radio" ? ckActivation.prevChecked === node : ckActivation.wasChecked;
        if (isConnected(node) && node._attrs.checked != null !== wasChecked) {
          try {
            dispatchEvent(node, new InputEvent("input", { bubbles: true, cancelable: true }));
          } catch (_) {
          }
          try {
            dispatchEvent(node, new Event("change", { bubbles: true, cancelable: false }));
          } catch (_) {
          }
        }
      }
    }
    return !event.defaultPrevented;
  }
  __name(dispatchPath, "dispatchPath");
  function fireListeners(node, event, capture) {
    let fired = false;
    if (event._csimStructMap) {
      const s = event._csimStructMap.get(node);
      if (s) {
        event.target = s.sat;
        if (s.rel !== void 0) event.relatedTarget = s.rel;
        event.eventPhase = s.sat === node ? 2 : capture ? 1 : 3;
      }
      globalThis.event = nodeRoot(node)._isShadowRoot ? event._csimPrevWinEvent : event;
    }
    if (!capture && !event._immediatePropagationStopped && (node._attrs || node._isShadowRoot)) {
      const attrName = "on" + event.type.toLowerCase();
      const propHandler = typeof node[attrName] === "function" ? node[attrName] : null;
      const attrVal = propHandler || !node._attrs ? null : node._attrs[attrName];
      let handler = propHandler;
      if (!handler && attrVal != null) {
        handler = node._onCompiled && node._onCompiled[attrName];
        if (handler === void 0) {
          try {
            handler = new Function("event", String(attrVal));
          } catch (_) {
            handler = null;
          }
          (node._onCompiled = node._onCompiled || {})[attrName] = handler;
        }
      }
      if (handler) {
        event.currentTarget = node;
        try {
          const ret = handler.call(node, event);
          if (ret === false && event.cancelable) event.defaultPrevented = true;
          fired = true;
        } catch (e) {
          logThrew("on-attribute handler", e);
        }
      }
    }
    const list = node._listeners && node._listeners[event.type];
    if (!list || !list.length) return fired;
    event.currentTarget = node;
    for (const entry of list.slice()) {
      if (entry.capture !== capture) continue;
      if (entry.removed) continue;
      if (event._immediatePropagationStopped) return fired;
      if (entry.once) removeOnceListener(entry, node._listeners && node._listeners[event.type]);
      event._inPassiveListener = !!entry.passive;
      if (entry.isObject) {
        let cb;
        try {
          cb = entry.handler.handleEvent;
          if (typeof cb !== "function") throw new TypeError("Failed to invoke event listener: the 'handleEvent' property is not callable.");
        } catch (e) {
          event._inPassiveListener = false;
          try {
            globalThis.reportError(e);
          } catch (_) {
          }
          continue;
        }
        try {
          cb.call(entry.handler, event);
          fired = true;
        } catch (e) {
          try {
            globalThis.__csimReportCallbackError(cb, e);
          } catch (_) {
          }
        } finally {
          event._inPassiveListener = false;
        }
      } else {
        try {
          entry.handler.call(node, event);
          fired = true;
        } catch (e) {
          try {
            globalThis.__csimReportCallbackError(entry.handler, e);
          } catch (_) {
          }
        } finally {
          event._inPassiveListener = false;
        }
      }
    }
    return fired;
  }
  __name(fireListeners, "fireListeners");
  function nodeRoot(node) {
    let n = node;
    while (n) {
      if (n._isShadowRoot) return n;
      if (!n._parent) return n;
      n = n._parent;
    }
    return n;
  }
  __name(nodeRoot, "nodeRoot");
  function isShadowIncludingInclusiveAncestor(x, y) {
    for (let n = y; n; n = n._parent) {
      if (n === x) return true;
    }
    return false;
  }
  __name(isShadowIncludingInclusiveAncestor, "isShadowIncludingInclusiveAncestor");
  function retarget(a, b) {
    while (a && a.nodeType !== void 0) {
      const root = nodeRoot(a);
      if (!root._isShadowRoot) return a;
      if (isShadowIncludingInclusiveAncestor(root, b)) return a;
      a = root.host || null;
    }
    return a;
  }
  __name(retarget, "retarget");
  function eventParent(node, event, targetRoot) {
    if (node._isShadowRoot) {
      if (!event.composed && node === targetRoot) return null;
      return node.host || null;
    }
    const slot = flatTreeAssignedSlot(node);
    if (slot) return slot;
    return node._parent || null;
  }
  __name(eventParent, "eventParent");
  function buildFlatTreePath(origTarget, event) {
    const related = event.relatedTarget != null ? event.relatedTarget : null;
    const targetRoot = nodeRoot(origTarget);
    if (related && origTarget === retarget(related, origTarget) && origTarget !== related) {
      return { structs: [], reachesWindow: false };
    }
    const structs = [{
      node: origTarget,
      sat: origTarget,
      rel: related ? retarget(related, origTarget) : void 0,
      rootClosed: !!(origTarget._isShadowRoot && origTarget.mode === "closed"),
      slotClosed: false
    }];
    let curTarget = origTarget;
    let curTargetRoot = targetRoot;
    let slottable = isSlottableNode(origTarget) && flatTreeAssignedSlot(origTarget) ? origTarget : null;
    let slotInClosedTree = false;
    let parent = eventParent(origTarget, event, targetRoot);
    while (parent) {
      if (slottable !== null) {
        slottable = null;
        const sr = nodeRoot(parent);
        if (sr._isShadowRoot && sr.mode === "closed") slotInClosedTree = true;
      }
      if (isSlottableNode(parent) && flatTreeAssignedSlot(parent)) slottable = parent;
      const rel = related ? retarget(related, parent) : void 0;
      const rootClosed = !!(parent._isShadowRoot && parent.mode === "closed");
      if (isShadowIncludingInclusiveAncestor(curTargetRoot, parent)) {
        structs.push({ node: parent, sat: curTarget, rel, rootClosed, slotClosed: slotInClosedTree });
      } else if (related && parent === rel) {
        break;
      } else {
        curTarget = parent;
        curTargetRoot = nodeRoot(parent);
        structs.push({ node: parent, sat: curTarget, rel, rootClosed, slotClosed: slotInClosedTree });
      }
      slotInClosedTree = false;
      parent = eventParent(parent, event, targetRoot);
    }
    const top = structs[structs.length - 1].node;
    return { structs, reachesWindow: !!(top && top.nodeType === NODE_DOC) };
  }
  __name(buildFlatTreePath, "buildFlatTreePath");

  // lib/capybara/simulated/js/src/storage.js
  function dispatchStorageEvent(kind, key, oldValue, newValue) {
    if (typeof globalThis.dispatchEvent !== "function") return;
    try {
      globalThis.dispatchEvent(new StorageEvent("storage", {
        key,
        oldValue,
        newValue,
        url: globalThis.location ? globalThis.location.href : "",
        storageArea: kind === "local" ? globalThis.localStorage : globalThis.sessionStorage
      }));
    } catch (_) {
    }
  }
  __name(dispatchStorageEvent, "dispatchStorageEvent");
  var STORAGE_API_METHODS = /* @__PURE__ */ new Set(["length", "key", "getItem", "setItem", "removeItem", "clear"]);
  function makeStorage(kind) {
    const self = {
      get length() {
        return globalThis.__csim_storageLength(kind);
      },
      key(i) {
        const v = globalThis.__csim_storageKey(kind, i | 0);
        return v == null ? null : String(v);
      },
      getItem(k) {
        const v = globalThis.__csim_storageGet(kind, String(k));
        return v == null ? null : String(v);
      },
      setItem(k, v) {
        const key = String(k);
        const old = self.getItem(key);
        const value = String(v == null ? "" : v);
        globalThis.__csim_storageSet(kind, key, value);
        if (old !== value) dispatchStorageEvent(kind, key, old, value);
      },
      removeItem(k) {
        const key = String(k);
        const old = self.getItem(key);
        globalThis.__csim_storageRemove(kind, key);
        if (old != null) dispatchStorageEvent(kind, key, old, null);
      },
      clear() {
        globalThis.__csim_storageClear(kind);
        dispatchStorageEvent(kind, null, null, null);
      }
    };
    return new Proxy(self, {
      get(target, prop) {
        if (typeof prop === "symbol" || STORAGE_API_METHODS.has(prop)) return target[prop];
        const v = target.getItem(prop);
        return v == null ? void 0 : v;
      },
      set(target, prop, value) {
        if (typeof prop === "symbol" || STORAGE_API_METHODS.has(prop)) {
          target[prop] = value;
          return true;
        }
        target.setItem(prop, value);
        return true;
      },
      deleteProperty(target, prop) {
        if (typeof prop === "symbol" || STORAGE_API_METHODS.has(prop)) {
          delete target[prop];
          return true;
        }
        target.removeItem(prop);
        return true;
      },
      has(target, prop) {
        if (typeof prop === "symbol" || STORAGE_API_METHODS.has(prop)) return prop in target;
        return target.getItem(prop) != null;
      },
      ownKeys(target) {
        const keys = [];
        const len = target.length;
        for (let i = 0; i < len; i++) keys.push(target.key(i));
        return keys;
      },
      getOwnPropertyDescriptor(target, prop) {
        if (typeof prop === "symbol" || STORAGE_API_METHODS.has(prop)) {
          return Object.getOwnPropertyDescriptor(target, prop);
        }
        const v = target.getItem(prop);
        return v == null ? void 0 : { value: v, writable: true, enumerable: true, configurable: true };
      }
    });
  }
  __name(makeStorage, "makeStorage");
  var localStorage = makeStorage("local");
  var sessionStorage = makeStorage("session");

  // lib/capybara/simulated/js/src/observers.js
  var StubObserver = class {
    static {
      __name(this, "StubObserver");
    }
    constructor(cb) {
      this._cb = cb;
    }
    observe() {
    }
    unobserve() {
    }
    disconnect() {
    }
    takeRecords() {
      return [];
    }
  };
  var activeIOs = /* @__PURE__ */ new Set();
  var IntersectionObserver = class {
    static {
      __name(this, "IntersectionObserver");
    }
    constructor(cb) {
      this._cb = cb;
      this._observed = /* @__PURE__ */ new Set();
      this._fired = /* @__PURE__ */ new Set();
    }
    observe(target) {
      if (!target || this._observed.has(target)) return;
      this._observed.add(target);
      activeIOs.add(this);
      const self = this;
      Promise.resolve().then(() => self._maybeFire(target));
    }
    unobserve(target) {
      this._observed.delete(target);
      this._fired.delete(target);
      if (this._observed.size === 0) activeIOs.delete(this);
    }
    disconnect() {
      this._observed.clear();
      this._fired.clear();
      activeIOs.delete(this);
    }
    takeRecords() {
      return [];
    }
    _maybeFire(target) {
      if (!this._observed.has(target)) return;
      if (this._fired.has(target)) return;
      if (!globalThis.__isLaidOutNode(target)) return;
      this._fired.add(target);
      const rect = { x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0 };
      try {
        this._cb([{
          target,
          isIntersecting: true,
          intersectionRatio: 1,
          boundingClientRect: rect,
          intersectionRect: rect,
          rootBounds: rect,
          time: 0
        }], this);
      } catch (e) {
        logThrew("IntersectionObserver cb", e);
      }
    }
  };
  function recheckIntersectionObservers() {
    if (activeIOs.size === 0) return;
    for (const io of Array.from(activeIOs)) {
      for (const target of Array.from(io._observed)) {
        io._maybeFire(target);
      }
    }
  }
  __name(recheckIntersectionObservers, "recheckIntersectionObservers");
  function forceRefireIntersectionObservers() {
    if (activeIOs.size === 0) return;
    for (const io of Array.from(activeIOs)) {
      io._fired.clear();
      for (const target of Array.from(io._observed)) {
        io._maybeFire(target);
      }
    }
  }
  __name(forceRefireIntersectionObservers, "forceRefireIntersectionObservers");
  globalThis.__forceRefireIntersectionObservers = forceRefireIntersectionObservers;
  globalThis.IntersectionObserver = IntersectionObserver;
  globalThis.ResizeObserver = class extends StubObserver {
  };
  var _perfObservers = /* @__PURE__ */ new Set();
  var PerformanceObserverImpl = class {
    static {
      __name(this, "PerformanceObserverImpl");
    }
    constructor(cb) {
      this._cb = cb;
      this._entryTypes = /* @__PURE__ */ new Set();
      this._records = [];
    }
    observe(opts) {
      if (opts && Array.isArray(opts.entryTypes)) {
        for (const t of opts.entryTypes) this._entryTypes.add(String(t));
      } else if (opts && typeof opts.type === "string") {
        this._entryTypes.add(opts.type);
      }
      _perfObservers.add(this);
    }
    disconnect() {
      _perfObservers.delete(this);
      this._records = [];
    }
    takeRecords() {
      const r = this._records;
      this._records = [];
      return r;
    }
  };
  PerformanceObserverImpl.supportedEntryTypes = ["mark", "measure"];
  globalThis.PerformanceObserver = PerformanceObserverImpl;
  globalThis.__csimDeliverPerfEntry = function(entry) {
    if (_perfObservers.size === 0) return;
    for (const obs of Array.from(_perfObservers)) {
      if (!obs._entryTypes.has(entry.entryType)) continue;
      obs._records.push(entry);
      const taken = obs._records;
      obs._records = [];
      Promise.resolve().then(() => {
        try {
          obs._cb({ getEntries: /* @__PURE__ */ __name(() => taken, "getEntries"), getEntriesByName: /* @__PURE__ */ __name(() => taken, "getEntriesByName"), getEntriesByType: /* @__PURE__ */ __name(() => taken, "getEntriesByType") }, obs);
        } catch (_) {
        }
      });
    }
  };
  globalThis.__recheckIntersectionObservers = recheckIntersectionObservers;

  // lib/capybara/simulated/js/src/timers.js
  var setTimersActive = /* @__PURE__ */ __name(function(flag) {
    globalThis.__setTimersActive(flag);
  }, "setTimersActive");
  var timers = /* @__PURE__ */ new Map();
  var nextTimerId = 1;
  var virtualNow = 0;
  var rafCallbacks = [];
  var rafCancelled = /* @__PURE__ */ new Set();
  var rafIdSeq = 1;
  function pendingEmpty() {
    return timers.size === 0 && rafCallbacks.length === 0;
  }
  __name(pendingEmpty, "pendingEmpty");
  function microcheck() {
    const f = globalThis.__csim_yield;
    if (f) f();
  }
  __name(microcheck, "microcheck");
  var virtualOffsetMs = 0;
  var timeTravelOffsetMs = 0;
  var _origDateNow = Date.now;
  Date.now = function() {
    return _origDateNow() + virtualOffsetMs + timeTravelOffsetMs;
  };
  globalThis.__csimSetTimeTravelOffsetMs = function(ms) {
    timeTravelOffsetMs = Number.isFinite(ms) ? ms : 0;
    installVirtualDate();
  };
  function installVirtualDate() {
    if (globalThis.Date !== _OrigDate) return;
    function VirtualDate(...args) {
      if (args.length === 0) return new _OrigDate(_origDateNow() + virtualOffsetMs);
      return new _OrigDate(...args);
    }
    __name(VirtualDate, "VirtualDate");
    VirtualDate.prototype = _OrigDate.prototype;
    VirtualDate.now = Date.now;
    VirtualDate.parse = _OrigDate.parse;
    VirtualDate.UTC = _OrigDate.UTC;
    Object.setPrototypeOf(VirtualDate, _OrigDate);
    globalThis.Date = VirtualDate;
  }
  __name(installVirtualDate, "installVirtualDate");
  var _OrigDate = globalThis.Date;
  function toTimerDelay(ms) {
    const n = ms | 0;
    return n < 0 ? 0 : n;
  }
  __name(toTimerDelay, "toTimerDelay");
  function scheduleTimer(handler, ms, args, period) {
    const h = typeof handler === "function" ? handler : String(handler);
    const id = nextTimerId++;
    const delay = toTimerDelay(ms);
    const wasIdle = pendingEmpty();
    timers.set(id, { handler: h, args, due: virtualNow + delay, period });
    if (wasIdle) setTimersActive(true);
    return id;
  }
  __name(scheduleTimer, "scheduleTimer");
  globalThis.setTimeout = function(h, ms, ...a) {
    return scheduleTimer(h, ms, a, null);
  };
  globalThis.setInterval = function(h, ms, ...a) {
    return scheduleTimer(h, ms, a, Math.max(1, toTimerDelay(ms)));
  };
  globalThis.clearTimeout = function(id) {
    if (timers.delete(id) && pendingEmpty()) setTimersActive(false);
  };
  globalThis.clearInterval = globalThis.clearTimeout;
  globalThis.requestAnimationFrame = function(cb) {
    const id = rafIdSeq++;
    const wasIdle = pendingEmpty();
    rafCallbacks.push({ id, cb });
    if (wasIdle) setTimersActive(true);
    return id;
  };
  globalThis.cancelAnimationFrame = function(id) {
    if (id != null) rafCancelled.add(id);
  };
  globalThis.queueMicrotask = function(cb) {
    if (typeof cb !== "function") {
      throw new TypeError("Failed to execute 'queueMicrotask': parameter 1 is not of type 'Function'.");
    }
    Promise.resolve().then(() => {
      try {
        cb();
      } catch (e) {
        globalThis.__csimReportCallbackError(cb, e);
      }
    });
  };
  globalThis.__virtualNow = () => virtualNow;
  globalThis.__hasReadyTimer = function() {
    if (rafCallbacks.length) return true;
    for (const t of timers.values()) if (t.due <= virtualNow) return true;
    return false;
  };
  globalThis.__nextTimerDelay = function() {
    if (rafCallbacks.length) return 0;
    let min = Infinity;
    for (const t of timers.values()) {
      const d = t.due - virtualNow;
      if (d < min) min = d;
    }
    if (min === Infinity) return -1;
    return min < 0 ? 0 : min;
  };
  function bumpVirtualOffset(startNow) {
    if (virtualNow > startNow) {
      virtualOffsetMs += virtualNow - startNow;
      installVirtualDate();
    }
  }
  __name(bumpVirtualOffset, "bumpVirtualOffset");
  function runRenderPhase() {
    microcheck();
    if (rafCallbacks.length) {
      const frame = rafCallbacks.splice(0, rafCallbacks.length);
      for (const { id, cb } of frame) {
        if (rafCancelled.has(id)) {
          rafCancelled.delete(id);
          continue;
        }
        try {
          cb(virtualNow);
        } catch (e) {
          logThrew("requestAnimationFrame cb", e);
        }
        microcheck();
      }
    }
    recheckIntersectionObservers();
    if (hasObservers() && hasQueuedRecords()) deliverMutations();
    microcheck();
  }
  __name(runRenderPhase, "runRenderPhase");
  var runLoopStepLocal = /* @__PURE__ */ __name(function(maxMs, maxIter, yieldOnGen) {
    if (typeof maxMs !== "number") maxMs = 2e3;
    if (typeof maxIter !== "number") maxIter = 1e4;
    yieldOnGen = !!yieldOnGen;
    const startNow = virtualNow;
    const limit = virtualNow + maxMs;
    const startGen = currentSettleGen();
    let iter = 0, fired = 0;
    while (true) {
      if (iter++ >= maxIter) {
        bumpVirtualOffset(startNow);
        const g2 = currentSettleGen();
        return { fired, gen: g2, dirtied: g2 !== startGen };
      }
      let nextId = null, nextDue = Infinity;
      for (const [id, t2] of timers) {
        if (t2.due < nextDue) {
          nextDue = t2.due;
          nextId = id;
        }
      }
      if (nextId === null || nextDue > limit) break;
      if (nextDue > virtualNow) virtualNow = nextDue;
      const t = timers.get(nextId);
      if (t.period != null) t.due = virtualNow + t.period;
      else timers.delete(nextId);
      try {
        if (typeof t.handler === "function") t.handler.apply(null, t.args || []);
        else (0, eval)(t.handler);
      } catch (e) {
        try {
          globalThis.__csimReportCallbackError(typeof t.handler === "function" ? t.handler : null, e);
        } catch (_) {
        }
      }
      fired++;
      microcheck();
      if (yieldOnGen && currentSettleGen() !== startGen) {
        runRenderPhase();
        bumpVirtualOffset(startNow);
        if (pendingEmpty()) setTimersActive(false);
        {
          const g2 = currentSettleGen();
          return { fired, gen: g2, dirtied: g2 !== startGen };
        }
      }
    }
    runRenderPhase();
    if (virtualNow < limit) virtualNow = limit;
    bumpVirtualOffset(startNow);
    if (pendingEmpty()) setTimersActive(false);
    const g = currentSettleGen();
    return { fired, gen: g, dirtied: g !== startGen };
  }, "runLoopStepLocal");
  function drainChildRealms(maxMs, maxIter, r) {
    const ids = globalThis.__csimChildRealmIds;
    if (!ids || !ids.size || !globalThis.RustyRacer || typeof globalThis.RustyRacer.contextGlobal !== "function") return;
    for (const id of ids) {
      try {
        const g = globalThis.RustyRacer.contextGlobal(id);
        if (g && typeof g.__runLoopStep === "function") {
          const cr = g.__runLoopStep(maxMs, maxIter, false);
          if (cr) {
            r.fired += cr.fired || 0;
            if (cr.dirtied) r.dirtied = true;
          }
        }
      } catch (_) {
      }
    }
  }
  __name(drainChildRealms, "drainChildRealms");
  globalThis.__runLoopStep = function(maxMs, maxIter, yieldOnGen) {
    const r = runLoopStepLocal(maxMs, maxIter, yieldOnGen);
    drainChildRealms(maxMs, maxIter, r);
    return r;
  };
  globalThis.__drainTimers = function(maxMs, maxIter) {
    return globalThis.__runLoopStep(
      typeof maxMs === "number" ? maxMs : 2e3,
      typeof maxIter === "number" ? maxIter : 1e4,
      false
    ).fired;
  };
  function timerStats() {
    return { size: timers.size, virtualNow };
  }
  __name(timerStats, "timerStats");
  function resetTimers() {
    const had = !pendingEmpty();
    timers.clear();
    rafCallbacks.length = 0;
    rafCancelled.clear();
    virtualNow = 0;
    if (had) setTimersActive(false);
  }
  __name(resetTimers, "resetTimers");
  globalThis.__resetTimers = resetTimers;

  // lib/capybara/simulated/js/src/bytes.js
  function bytesToLatin1(view) {
    let s = "";
    for (let i = 0; i < view.length; i += 32768) {
      s += String.fromCharCode.apply(null, view.subarray(i, i + 32768));
    }
    return s;
  }
  __name(bytesToLatin1, "bytesToLatin1");
  function latin1ToBytes(bytes) {
    const v = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) v[i] = bytes.charCodeAt(i) & 255;
    return v;
  }
  __name(latin1ToBytes, "latin1ToBytes");
  function bytesToArrayBuffer(bytes) {
    return latin1ToBytes(bytes).buffer;
  }
  __name(bytesToArrayBuffer, "bytesToArrayBuffer");
  function fetchedToBytes(fetched) {
    if (fetched instanceof Uint8Array) return fetched;
    if (fetched instanceof ArrayBuffer) return new Uint8Array(fetched);
    if (typeof fetched === "string") return latin1ToBytes(globalThis.atob(fetched));
    return null;
  }
  __name(fetchedToBytes, "fetchedToBytes");
  function fetchTransfer(refId) {
    if (!refId || typeof globalThis.__csim_transferFetch !== "function") return null;
    return fetchedToBytes(globalThis.__csim_transferFetch(refId | 0));
  }
  __name(fetchTransfer, "fetchTransfer");
  function stashTransfer(view) {
    if (typeof globalThis.__csim_transferStash !== "function") return 0;
    return globalThis.__csim_transferStash(view) | 0;
  }
  __name(stashTransfer, "stashTransfer");
  function detachTransferables(transferList) {
    if (!Array.isArray(transferList)) return;
    for (const t of transferList) {
      if (t instanceof ArrayBuffer && typeof t.transfer === "function") {
        try {
          t.transfer();
        } catch (_) {
        }
      }
    }
  }
  __name(detachTransferables, "detachTransferables");

  // lib/capybara/simulated/js/src/workers.js
  function hasWorkers() {
    const m = globalThis.__csim_workersByHandle;
    return !!(m && m.size > 0);
  }
  __name(hasWorkers, "hasWorkers");
  var TRANSFER_STASH_MIN = 64 * 1024;
  function transferSetFrom(transferList) {
    if (!transferList || !transferList.length) return null;
    const set = /* @__PURE__ */ new Set();
    for (const t of transferList) set.add(t instanceof ArrayBuffer ? t : t && t.buffer || t);
    return set;
  }
  __name(transferSetFrom, "transferSetFrom");
  function encode(data, transferSet) {
    const NS = globalThis.RustyRacer;
    const canTransfer = transferSet && NS && typeof NS.transferOut === "function";
    return JSON.stringify(data, function(_key, value) {
      const isU8 = value instanceof Uint8Array;
      const isAB = !isU8 && value instanceof ArrayBuffer;
      if (!isU8 && !isAB) return value;
      const type = isU8 ? "Uint8Array" : "ArrayBuffer";
      const buf = isU8 ? value.buffer : value;
      if (canTransfer && transferSet.has(buf)) {
        const token = NS.transferOut(value) | 0;
        if (token > 0) {
          if (globalThis.__csim_transferIssued) globalThis.__csim_transferIssued(token);
          return isU8 ? { __csimType: type, xfer: token, byteOffset: value.byteOffset, length: value.length } : { __csimType: type, xfer: token };
        }
      }
      const view = isU8 ? value : new Uint8Array(value);
      if (view.byteLength >= TRANSFER_STASH_MIN) {
        const refId = stashTransfer(view);
        if (refId > 0) return { __csimType: type, refId };
      }
      return { __csimType: type, b64: globalThis.btoa(bytesToLatin1(view)) };
    });
  }
  __name(encode, "encode");
  function decode(s) {
    const NS = globalThis.RustyRacer;
    return JSON.parse(s, function(_key, value) {
      if (!value || typeof value !== "object") return value;
      const tag = value.__csimType;
      if (tag !== "Uint8Array" && tag !== "ArrayBuffer") return value;
      if (value.xfer != null && NS && typeof NS.transferIn === "function") {
        const ab = NS.transferIn(value.xfer);
        if (ab) {
          return tag === "ArrayBuffer" ? ab : new Uint8Array(ab, value.byteOffset || 0, value.length != null ? value.length : ab.byteLength);
        }
        return tag === "ArrayBuffer" ? new ArrayBuffer(0) : new Uint8Array(0);
      }
      const u = fetchTransfer(value.refId) || latin1ToBytes(globalThis.atob(value.b64 || ""));
      return tag === "ArrayBuffer" ? u.buffer : u;
    });
  }
  __name(decode, "decode");
  if (!globalThis.__csim_isWorker) {
    globalThis.__csim_installWorker = function() {
      if (typeof globalThis.Worker === "function") return;
      const byHandle = /* @__PURE__ */ new Map();
      globalThis.__csim_workersByHandle = byHandle;
      class Worker extends EventTarget {
        static {
          __name(this, "Worker");
        }
        constructor(url, _options) {
          super();
          this.url = String(url);
          this.onmessage = null;
          this.onerror = null;
          this.onmessageerror = null;
          this._handle = globalThis.__csim_workerSpawn(this.url) | 0;
          if (this._handle > 0) byHandle.set(this._handle, this);
        }
        postMessage(data, transferList) {
          if (this._handle <= 0) return;
          let payload;
          try {
            payload = encode(data, transferSetFrom(transferList));
          } catch (_) {
            payload = "null";
          }
          globalThis.__csim_workerPostToWorker(this._handle, payload);
          detachTransferables(transferList);
        }
        terminate() {
          if (this._handle <= 0) return;
          globalThis.__csim_workerTerminate(this._handle);
          byHandle.delete(this._handle);
          this._handle = -1;
        }
      }
      globalThis.Worker = Worker;
      globalThis.__csim_deliverWorkerMessages = function(events) {
        if (!events || !events.length) return 0;
        let n = 0;
        for (const e of events) {
          const w = byHandle.get(e.handle | 0);
          if (!w) continue;
          if (e.kind === "__error") {
            const evt = new Event("error");
            if (e.message) try {
              evt.message = String(e.message);
            } catch (_) {
            }
            dispatchWithOnHandler(w, evt);
          } else {
            let data;
            try {
              data = decode(e.data);
            } catch (_) {
              data = null;
            }
            dispatchWithOnHandler(w, new MessageEvent("message", { data }));
          }
          n++;
        }
        return n;
      };
    };
  }
  globalThis.__csim_installWorkerScope = function() {
    globalThis.__csim_isWorker = true;
    try {
      delete globalThis.window;
    } catch (_) {
      globalThis.window = void 0;
    }
    try {
      delete globalThis.document;
    } catch (_) {
      globalThis.document = void 0;
    }
    try {
      delete globalThis.open;
    } catch (_) {
      globalThis.open = void 0;
    }
    try {
      delete globalThis.opener;
    } catch (_) {
      globalThis.opener = void 0;
    }
    globalThis.WorkerGlobalScope = globalThis.WorkerGlobalScope || /* @__PURE__ */ __name(function WorkerGlobalScope() {
    }, "WorkerGlobalScope");
    globalThis.DedicatedWorkerGlobalScope = globalThis.DedicatedWorkerGlobalScope || /* @__PURE__ */ __name(function DedicatedWorkerGlobalScope() {
    }, "DedicatedWorkerGlobalScope");
    if (typeof globalThis.postMessage !== "function") {
      globalThis.postMessage = function(data, transferList) {
        let payload;
        try {
          payload = encode(data, transferSetFrom(transferList));
        } catch (_) {
          payload = "null";
        }
        globalThis.__csim_workerPostMessage(payload);
        detachTransferables(transferList);
      };
    }
    globalThis.importScripts = function(...urls) {
      for (const u of urls) {
        const url = String(u);
        const resp = globalThis.__rackFetch("GET", url, "", null, "follow");
        if (!resp || resp.status >= 400) throw new Error("importScripts: HTTP " + (resp && resp.status) + " for " + url);
        (0, eval)(resp.body + "\n//# sourceURL=" + url);
      }
    };
    if (typeof globalThis.WebAssembly === "object") {
      globalThis.WebAssembly.compile = function(bufferSource) {
        return Promise.resolve().then(() => new globalThis.WebAssembly.Module(bufferSource));
      };
      globalThis.WebAssembly.instantiate = function(bufferOrModule, importObject) {
        return Promise.resolve().then(() => {
          if (bufferOrModule instanceof globalThis.WebAssembly.Module) {
            return new globalThis.WebAssembly.Instance(bufferOrModule, importObject);
          }
          const mod = new globalThis.WebAssembly.Module(bufferOrModule);
          const inst = new globalThis.WebAssembly.Instance(mod, importObject);
          return { module: mod, instance: inst };
        });
      };
    }
  };
  globalThis.__csim_workerOnMessage = function(dataStr) {
    let data;
    try {
      data = decode(dataStr);
    } catch (_) {
      data = null;
    }
    dispatchWithOnHandler(globalThis, new MessageEvent("message", { data }));
  };

  // lib/capybara/simulated/js/src/blob.js
  var blobs = globalThis.__csimBlobs = globalThis.__csimBlobs || /* @__PURE__ */ new Map();
  globalThis.__csimBlobCounter = globalThis.__csimBlobCounter || { n: 0 };
  function readHostFile(blob) {
    if (typeof globalThis.__csimReadFilePick !== "function") return "";
    const b64 = globalThis.__csimReadFilePick(blob._handle, blob._index, blob._start, blob._end);
    if (!b64) return "";
    try {
      return globalThis.atob(String(b64));
    } catch (_) {
      return "";
    }
  }
  __name(readHostFile, "readHostFile");
  function blobBytes(blob) {
    if (!blob) return "";
    if (blob._csimHost) return readHostFile(blob);
    return blob._parts ? blob._parts.join("") : "";
  }
  __name(blobBytes, "blobBytes");
  var Blob = class _Blob {
    static {
      __name(this, "Blob");
    }
    constructor(parts, opts) {
      const i = opts || {};
      this._parts = (parts || []).map((p) => {
        if (typeof p === "string") return p;
        if (p instanceof _Blob) return blobBytes(p);
        if (p instanceof ArrayBuffer) return bytesToLatin1(new Uint8Array(p));
        if (p && typeof p === "object" && typeof p.byteLength === "number" && p.buffer instanceof ArrayBuffer) {
          return bytesToLatin1(new Uint8Array(p.buffer, p.byteOffset || 0, p.byteLength));
        }
        return String(p);
      });
      this.size = this._parts.reduce((s, p) => s + (p ? p.length : 0), 0);
      this.type = i.type || "";
    }
    text() {
      if (this._csimHost) return Promise.resolve(readHostFile(this));
      return Promise.resolve(this._parts.join(""));
    }
    arrayBuffer() {
      return this.text().then(bytesToArrayBuffer);
    }
    slice(start, end, type) {
      if (this._csimHost) {
        const s = Math.max(0, start || 0);
        const e = end == null ? this.size : Math.min(this.size, end);
        const next = Object.create(Object.getPrototypeOf(this));
        next._csimHost = true;
        next._handle = this._handle;
        next._index = this._index;
        next._start = this._start + s;
        next._end = this._start + e;
        next.size = Math.max(0, next._end - next._start);
        next.type = type == null ? this.type : String(type);
        next._parts = [];
        return next;
      }
      const all = this._parts.join("");
      return new _Blob([all.slice(start || 0, end == null ? void 0 : end)], { type: type || this.type });
    }
    stream() {
      return null;
    }
  };
  var File = class extends Blob {
    static {
      __name(this, "File");
    }
    constructor(parts, name, opts) {
      super(parts, opts);
      const i = opts || {};
      this.name = String(name == null ? "" : name);
      this.lastModified = i.lastModified || Date.now();
    }
  };
  function utf8Latin1(s) {
    return bytesToLatin1(new globalThis.TextEncoder().encode(String(s)));
  }
  __name(utf8Latin1, "utf8Latin1");
  function serializeMultipart(formData) {
    const boundary = "----csimFormBoundary" + Math.random().toString(36).slice(2);
    let body = "";
    formData.forEach((value, key) => {
      body += "--" + boundary + "\r\n";
      if (value instanceof Blob) {
        const filename = value.name != null ? String(value.name) : "blob";
        const contentType = value.type || "application/octet-stream";
        body += 'Content-Disposition: form-data; name="' + utf8Latin1(key) + '"; filename="' + utf8Latin1(filename) + '"\r\n';
        body += "Content-Type: " + contentType + "\r\n\r\n";
        body += blobBytes(value);
        body += "\r\n";
      } else {
        body += 'Content-Disposition: form-data; name="' + utf8Latin1(key) + '"\r\n\r\n';
        body += utf8Latin1(value) + "\r\n";
      }
    });
    body += "--" + boundary + "--\r\n";
    return { body, boundary };
  }
  __name(serializeMultipart, "serializeMultipart");
  function resolveBlobBytes(url) {
    const blob = blobs.get(String(url));
    if (blob) return { bytes: blobBytes(blob), type: blob.type || "application/octet-stream" };
    let b64;
    try {
      b64 = globalThis.__csim_blobResolve(url);
    } catch (_) {
      b64 = null;
    }
    if (b64 == null) return null;
    let bytes = "";
    try {
      bytes = globalThis.atob(String(b64));
    } catch (_) {
    }
    return { bytes, type: "application/octet-stream" };
  }
  __name(resolveBlobBytes, "resolveBlobBytes");
  function installBlobURL() {
    if (!globalThis.URL || globalThis.URL.__csimBlobInstalled) return;
    globalThis.URL.createObjectURL = function(blob) {
      const url = "blob:csim-" + ++globalThis.__csimBlobCounter.n;
      blobs.set(url, blob);
      if (hasWorkers()) {
        try {
          globalThis.__csim_blobRegister(url, globalThis.btoa(blobBytes(blob) || ""));
        } catch (_) {
        }
      }
      return url;
    };
    globalThis.URL.revokeObjectURL = function(url) {
      blobs.delete(url);
      try {
        globalThis.__csim_blobUnregister(url);
      } catch (_) {
      }
    };
    globalThis.URL.__csimBlobInstalled = true;
  }
  __name(installBlobURL, "installBlobURL");
  globalThis.__csimReadBlobBase64 = function(url) {
    const blob = blobs.get(String(url));
    if (!blob) return null;
    try {
      return globalThis.btoa(blobBytes(blob));
    } catch (_) {
      return null;
    }
  };

  // lib/capybara/simulated/js/src/intl-collator.js
  function installIfMissing() {
    if (typeof Intl === "undefined" || typeof Intl.Collator !== "undefined") return;
    Intl.Collator = function(_locales, options) {
      if (!(this instanceof Intl.Collator)) return new Intl.Collator(_locales, options);
      const sensitivity = options && options.sensitivity || "variant";
      const fold = sensitivity === "base" || sensitivity === "accent" ? (s) => String(s).toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "") : (s) => String(s);
      this.compare = function(a, b) {
        const fa = fold(a), fb = fold(b);
        return fa < fb ? -1 : fa > fb ? 1 : 0;
      };
      this.resolvedOptions = function() {
        return Object.assign({
          locale: "en",
          usage: "sort",
          sensitivity,
          ignorePunctuation: false,
          collation: "default",
          numeric: false,
          caseFirst: "false"
        }, options || {});
      };
    };
    Intl.Collator.supportedLocalesOf = function(locales) {
      return Array.isArray(locales) ? locales.slice() : locales ? [locales] : [];
    };
  }
  __name(installIfMissing, "installIfMissing");

  // lib/capybara/simulated/js/src/dom-class-aliases.js
  var TAG_ELEMENT_CTORS = {
    HTMLAnchorElement: "a",
    HTMLAreaElement: "area",
    HTMLBodyElement: "body",
    HTMLButtonElement: "button",
    HTMLCanvasElement: "canvas",
    HTMLDialogElement: "dialog",
    HTMLDivElement: "div",
    HTMLFieldSetElement: "fieldset",
    HTMLFormElement: "form",
    HTMLHeadElement: "head",
    HTMLHtmlElement: "html",
    HTMLIFrameElement: "iframe",
    HTMLImageElement: "img",
    HTMLInputElement: "input",
    HTMLLabelElement: "label",
    HTMLLIElement: "li",
    HTMLLinkElement: "link",
    HTMLMetaElement: "meta",
    HTMLOListElement: "ol",
    HTMLOptGroupElement: "optgroup",
    HTMLOptionElement: "option",
    HTMLOutputElement: "output",
    HTMLScriptElement: "script",
    HTMLSelectElement: "select",
    HTMLSlotElement: "slot",
    HTMLSpanElement: "span",
    HTMLStyleElement: "style",
    HTMLTableElement: "table",
    HTMLTemplateElement: "template",
    HTMLTextAreaElement: "textarea",
    HTMLUListElement: "ul",
    HTMLVideoElement: "video",
    HTMLAudioElement: "audio",
    HTMLSourceElement: "source",
    HTMLTrackElement: "track",
    HTMLPictureElement: "picture",
    HTMLProgressElement: "progress",
    HTMLDataListElement: "datalist",
    HTMLDataElement: "data",
    HTMLTimeElement: "time",
    HTMLDetailsElement: "details",
    HTMLEmbedElement: "embed",
    HTMLObjectElement: "object",
    HTMLBaseElement: "base",
    HTMLBRElement: "br",
    HTMLTableCaptionElement: "caption",
    HTMLDirectoryElement: "dir",
    HTMLDListElement: "dl",
    HTMLFontElement: "font",
    HTMLFrameElement: "frame",
    HTMLFrameSetElement: "frameset",
    HTMLHRElement: "hr",
    HTMLLegendElement: "legend",
    HTMLMapElement: "map",
    HTMLMeterElement: "meter",
    HTMLParagraphElement: "p",
    HTMLParamElement: "param",
    HTMLPreElement: "pre",
    HTMLTitleElement: "title",
    HTMLTableRowElement: "tr",
    HTMLMenuElement: "menu"
  };
  var MULTI_TAG_ELEMENT_CTORS = {
    HTMLModElement: ["del", "ins"],
    HTMLTableColElement: ["col", "colgroup"],
    HTMLHeadingElement: ["h1", "h2", "h3", "h4", "h5", "h6"],
    HTMLQuoteElement: ["blockquote", "q"],
    HTMLTableCellElement: ["td", "th"],
    HTMLTableSectionElement: ["thead", "tbody", "tfoot"]
  };
  var KNOWN_HTML_TAGS = /* @__PURE__ */ new Set([
    "a",
    "abbr",
    "acronym",
    "address",
    "area",
    "article",
    "aside",
    "audio",
    "b",
    "base",
    "bdi",
    "bdo",
    "bgsound",
    "big",
    "blockquote",
    "body",
    "br",
    "button",
    "canvas",
    "caption",
    "center",
    "cite",
    "code",
    "col",
    "colgroup",
    "data",
    "datalist",
    "dd",
    "del",
    "details",
    "dfn",
    "dialog",
    "dir",
    "div",
    "dl",
    "dt",
    "em",
    "embed",
    "fieldset",
    "figcaption",
    "figure",
    "font",
    "footer",
    "form",
    "frame",
    "frameset",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "head",
    "header",
    "hgroup",
    "hr",
    "html",
    "i",
    "iframe",
    "img",
    "input",
    "ins",
    "isindex",
    "kbd",
    "label",
    "legend",
    "li",
    "link",
    "main",
    "map",
    "mark",
    "marquee",
    "menu",
    "meta",
    "meter",
    "nav",
    "nobr",
    "noembed",
    "noframes",
    "noscript",
    "object",
    "ol",
    "optgroup",
    "option",
    "output",
    "p",
    "param",
    "picture",
    "plaintext",
    "pre",
    "progress",
    "q",
    "rp",
    "rt",
    "ruby",
    "s",
    "samp",
    "script",
    "section",
    "select",
    "slot",
    "small",
    "source",
    "spacer",
    "span",
    "strike",
    "strong",
    "style",
    "sub",
    "summary",
    "sup",
    "table",
    "tbody",
    "td",
    "template",
    "textarea",
    "tfoot",
    "th",
    "thead",
    "time",
    "title",
    "tr",
    "track",
    "tt",
    "u",
    "ul",
    "var",
    "video",
    "wbr",
    "xmp"
  ]);
  var HTML_NS3 = "http://www.w3.org/1999/xhtml";
  var SVG_NS2 = "http://www.w3.org/2000/svg";
  function makeTagCtor(name, tag, Element2) {
    const ctor = /* @__PURE__ */ __name(function() {
    }, "ctor");
    Object.defineProperty(ctor, "name", { value: name, configurable: true });
    ctor.prototype = Element2.prototype;
    const match = Array.isArray(tag) ? (obj) => obj != null && obj._ns === HTML_NS3 && tag.indexOf(obj._localName) !== -1 : (obj) => obj != null && obj._ns === HTML_NS3 && obj._localName === tag;
    Object.defineProperty(ctor, Symbol.hasInstance, { value: match });
    return ctor;
  }
  __name(makeTagCtor, "makeTagCtor");
  function installDomClassAliases({ Element: Element2, Document: Document2, Text: Text2 }) {
    const tagToCtor = /* @__PURE__ */ new Map();
    for (const [name, tag] of Object.entries(TAG_ELEMENT_CTORS)) {
      const ctor = makeTagCtor(name, tag, Element2);
      globalThis[name] = ctor;
      tagToCtor.set(tag, ctor);
    }
    for (const [name, tags] of Object.entries(MULTI_TAG_ELEMENT_CTORS)) {
      const ctor = makeTagCtor(name, tags, Element2);
      globalThis[name] = ctor;
      for (const t of tags) tagToCtor.set(t, ctor);
    }
    {
      const ctor = /* @__PURE__ */ __name(function() {
      }, "ctor");
      Object.defineProperty(ctor, "name", { value: "HTMLUnknownElement", configurable: true });
      ctor.prototype = Element2.prototype;
      Object.defineProperty(ctor, Symbol.hasInstance, {
        value: /* @__PURE__ */ __name((obj) => obj != null && obj._ns === HTML_NS3 && obj._localName != null && !KNOWN_HTML_TAGS.has(obj._localName), "value")
      });
      globalThis.HTMLUnknownElement = ctor;
    }
    class HTMLElement extends Element2 {
      static {
        __name(this, "HTMLElement");
      }
    }
    Object.defineProperty(HTMLElement, Symbol.hasInstance, { value: /* @__PURE__ */ __name((obj) => obj != null && obj._ns === HTML_NS3, "value") });
    class SVGElement extends Element2 {
      static {
        __name(this, "SVGElement");
      }
    }
    Object.defineProperty(SVGElement, Symbol.hasInstance, { value: /* @__PURE__ */ __name((obj) => obj != null && obj._ns === SVG_NS2, "value") });
    globalThis.HTMLElement = HTMLElement;
    globalThis.SVGElement = SVGElement;
    globalThis.HTMLDocument = Document2;
    globalThis.Window = /* @__PURE__ */ __name(function Window() {
    }, "Window");
    try {
      Object.defineProperty(globalThis, "constructor", {
        value: globalThis.Window,
        writable: true,
        configurable: true
      });
    } catch (_) {
    }
    globalThis.Option = /* @__PURE__ */ __name(function Option(text, value, defaultSelected, selected) {
      const o = globalThis.document.createElement("option");
      if (text !== void 0) o.textContent = String(text);
      if (value !== void 0) o.setAttribute("value", String(value));
      if (defaultSelected) o.setAttribute("selected", "");
      if (selected) o.selected = true;
      return o;
    }, "Option");
    globalThis.Image = /* @__PURE__ */ __name(function Image(width, height) {
      const img = globalThis.document.createElement("img");
      if (width != null) img.setAttribute("width", String(width | 0));
      if (height != null) img.setAttribute("height", String(height | 0));
      return img;
    }, "Image");
    globalThis.Image.prototype = Element2.prototype;
    globalThis.Audio = /* @__PURE__ */ __name(function Audio2(src) {
      const a = globalThis.document.createElement("audio");
      if (src != null) a.setAttribute("src", String(src));
      return a;
    }, "Audio");
    globalThis.Audio.prototype = Element2.prototype;
    Object.defineProperty(Element2.prototype, "constructor", {
      configurable: true,
      get() {
        const ln = this._localName;
        if (ln == null) return Element2;
        if (this._ns === HTML_NS3) {
          return tagToCtor.get(ln) || (KNOWN_HTML_TAGS.has(ln) ? globalThis.HTMLElement : globalThis.HTMLUnknownElement);
        }
        if (this._ns === SVG_NS2) return globalThis.SVGElement;
        return Element2;
      }
    });
  }
  __name(installDomClassAliases, "installDomClassAliases");

  // lib/capybara/simulated/js/src/xpath.js
  var X = globalThis.__csimVendor && globalThis.__csimVendor.xpathway;
  var DOCUMENT_POSITION_FOLLOWING = 4;
  function isHtmlDoc(doc) {
    if (!doc || !doc._contentType) return true;
    const ct = doc._contentType;
    return ct !== "text/xml" && ct !== "application/xml" && ct !== "application/xhtml+xml" && ct !== "image/svg+xml";
  }
  __name(isHtmlDoc, "isHtmlDoc");
  function stringValue(n) {
    switch (n.nodeType) {
      case 2:
        return n.value;
      // attribute
      case 3:
      case 7:
      case 8:
        return n.data;
      // text, PI, comment
      case 9:
      case 11: {
        let s = "";
        for (const c of n.childNodes) {
          if (c.nodeType === 3) s += c.data;
          else if (c.nodeType === 1) s += c.textContent;
        }
        return s;
      }
      default:
        return n.textContent;
    }
  }
  __name(stringValue, "stringValue");
  var adapter2 = {
    nodeType: /* @__PURE__ */ __name((n) => n.nodeType, "nodeType"),
    parent: /* @__PURE__ */ __name((n) => n.parentNode, "parent"),
    childNodes: /* @__PURE__ */ __name((n) => n.childNodes, "childNodes"),
    ownerDocument: /* @__PURE__ */ __name((n) => n.ownerDocument, "ownerDocument"),
    // localName/namespaceURI are IDL members of Element/Attr only (not Node), so
    // a Text/Comment/Document node doesn't expose them — coerce the resulting
    // undefined back to null, the value the XPath data model wants for nodes
    // without an expanded-name (matches the old CharacterData null getters).
    localName: /* @__PURE__ */ __name((n) => n.localName ?? null, "localName"),
    namespaceURI: /* @__PURE__ */ __name((n) => n.namespaceURI ?? null, "namespaceURI"),
    nodeName: /* @__PURE__ */ __name((n) => n.nodeName, "nodeName"),
    // Plain Attr array for xpathway's attribute axis — built directly from the
    // store (the public `attributes` NamedNodeMap is a non-Array legacy platform
    // object, and rebuilding it per visited element would be wasted work here).
    attributes: /* @__PURE__ */ __name((el) => el._attrs ? Object.keys(el._attrs).map((k) => el._attrNodeFor(k)) : [], "attributes"),
    getAttribute: /* @__PURE__ */ __name((el, ns, ln) => ns == null ? el.getAttribute(ln) : el.getAttributeNS(ns, ln), "getAttribute"),
    stringValue,
    // xpathway wants a comparator (negative / 0 / positive), not the DOM bitmask.
    // FOLLOWING set on `a.compareDocumentPosition(b)` means b follows a in document
    // order, i.e. a precedes b → negative. (Covers the contained-by case too.)
    compareDocumentPosition: /* @__PURE__ */ __name((a, b) => a === b ? 0 : a.compareDocumentPosition(b) & DOCUMENT_POSITION_FOLLOWING ? -1 : 1, "compareDocumentPosition"),
    getElementById: /* @__PURE__ */ __name((doc, id) => doc.getElementById ? doc.getElementById(id) : null, "getElementById"),
    isHtmlDocument: /* @__PURE__ */ __name((doc) => isHtmlDoc(doc), "isHtmlDocument"),
    nextSibling: /* @__PURE__ */ __name((n) => n.nextSibling, "nextSibling"),
    previousSibling: /* @__PURE__ */ __name((n) => n.previousSibling, "previousSibling")
  };
  function installXPath(DocumentProto) {
    if (!X) {
      throw new Error("xpathway engine missing from vendor bundle (__csimVendor.xpathway undefined) \u2014 rebuild vendor.bundle.js");
    }
    if (!DocumentProto) return;
    const evaluator = X.createEvaluator(adapter2, {
      // Make grammar errors real DOMExceptions so app JS sees err.name ===
      // 'SyntaxError'; type errors stay native TypeErrors.
      exceptions: {
        syntaxError: /* @__PURE__ */ __name((m) => new globalThis.DOMException(String(m), "SyntaxError"), "syntaxError"),
        typeError: /* @__PURE__ */ __name((m) => new globalThis.TypeError(String(m)), "typeError")
      }
    });
    DocumentProto.evaluate = function(expression, contextNode, resolver, type, result) {
      return evaluator.evaluate(expression, contextNode, resolver, type, result);
    };
    DocumentProto.createExpression = function(expression, resolver) {
      return evaluator.createExpression(expression, resolver);
    };
    DocumentProto.createNSResolver = function(node) {
      return evaluator.createNSResolver(node);
    };
    if (X.XPathResult) globalThis.XPathResult = X.XPathResult;
  }
  __name(installXPath, "installXPath");

  // lib/capybara/simulated/js/src/esm-loader.js
  var importmap = { imports: /* @__PURE__ */ Object.create(null), scopes: /* @__PURE__ */ Object.create(null) };
  globalThis.__csim_importmap = importmap;
  function resolveAgainst(url, base) {
    try {
      const u = globalThis.__csim_parseUrl(url, base || globalThis.location && globalThis.location.href || null);
      return u && !u.error ? u.href : url;
    } catch (_) {
      return url;
    }
  }
  __name(resolveAgainst, "resolveAgainst");
  function ingestImportmaps(doc) {
    if (!doc || !doc.documentElement) return;
    const tags = doc.documentElement.getElementsByTagName("script");
    for (const t of tags) {
      if ((t._attrs.type || "").toLowerCase() !== "importmap") continue;
      const src = t._attrs.src;
      let text;
      if (src) {
        try {
          const resp = globalThis.__rackFetch("GET", src, "", null, "follow");
          text = resp && resp.status < 400 ? resp.body : null;
        } catch (_) {
          text = null;
        }
      } else {
        text = scriptText(t);
      }
      if (!text) continue;
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (_) {
        continue;
      }
      if (parsed && typeof parsed === "object") {
        if (parsed.imports && typeof parsed.imports === "object") Object.assign(importmap.imports, parsed.imports);
        if (parsed.scopes && typeof parsed.scopes === "object") Object.assign(importmap.scopes, parsed.scopes);
      }
    }
    try {
      globalThis.__csim_pushImportmap(JSON.stringify(importmap));
    } catch (_) {
    }
  }
  __name(ingestImportmaps, "ingestImportmaps");

  // lib/capybara/simulated/js/src/abort.js
  function defaultAbortReason() {
    return new DOMException2("signal is aborted without reason", "AbortError");
  }
  __name(defaultAbortReason, "defaultAbortReason");
  var AbortSignal = class _AbortSignal extends EventTarget {
    static {
      __name(this, "AbortSignal");
    }
    constructor() {
      super();
      this.aborted = false;
      this.reason = void 0;
    }
    throwIfAborted() {
      if (this.aborted) throw this.reason;
    }
    _markAborted(reason) {
      if (this.aborted) return;
      this.aborted = true;
      this.reason = reason === void 0 ? defaultAbortReason() : reason;
      this.dispatchEvent(new Event("abort"));
    }
    static abort(reason) {
      const s = new _AbortSignal();
      s.aborted = true;
      s.reason = reason === void 0 ? defaultAbortReason() : reason;
      return s;
    }
    // Spec: aborts the returned signal with a TimeoutError DOMException
    // after `ms` virtual-clock milliseconds. fetch() with `{signal:
    // AbortSignal.timeout(ms)}` is the canonical timeout idiom.
    static timeout(ms) {
      const s = new _AbortSignal();
      globalThis.setTimeout(() => s._markAborted(new DOMException2("signal timed out", "TimeoutError")), Number(ms) || 0);
      return s;
    }
    // Spec: returns a signal that aborts when any input signal aborts.
    // If any input is already aborted, the returned signal is born
    // aborted with that signal's reason.
    static any(signals) {
      const combined = new _AbortSignal();
      for (const s of signals || []) {
        if (s && s.aborted) {
          combined.aborted = true;
          combined.reason = s.reason;
          return combined;
        }
      }
      for (const s of signals || []) {
        if (!s || typeof s.addEventListener !== "function") continue;
        s.addEventListener("abort", () => combined._markAborted(s.reason));
      }
      return combined;
    }
  };
  var AbortController = class {
    static {
      __name(this, "AbortController");
    }
    constructor() {
      this.signal = new AbortSignal();
    }
    abort(reason) {
      this.signal._markAborted(reason);
    }
  };
  globalThis.AbortSignal = AbortSignal;
  globalThis.AbortController = AbortController;

  // lib/capybara/simulated/js/src/audio.js
  function Audio(src) {
    const el = globalThis.document.createElement("audio");
    if (src) el.setAttribute("src", String(src));
    el.play = function() {
      return Promise.resolve();
    };
    el.pause = function() {
    };
    el.load = function() {
    };
    el.canPlayType = function() {
      return "";
    };
    el.paused = true;
    el.currentTime = 0;
    el.volume = 1;
    el.muted = false;
    return el;
  }
  __name(Audio, "Audio");
  globalThis.Audio = Audio;

  // lib/capybara/simulated/js/src/canvas.js
  var ImageData = class {
    static {
      __name(this, "ImageData");
    }
    constructor(a, b, c) {
      if (a instanceof globalThis.Uint8ClampedArray) {
        this.data = a;
        this.width = b | 0;
        this.height = c | 0 || this.data.length / 4 / this.width | 0;
      } else {
        this.width = a | 0;
        this.height = b | 0;
        this.data = new globalThis.Uint8ClampedArray(this.width * this.height * 4);
      }
      this.colorSpace = "srgb";
    }
  };
  var ImageBitmap = class {
    static {
      __name(this, "ImageBitmap");
    }
    constructor() {
      this.width = 0;
      this.height = 0;
      this._pixels = null;
    }
    close() {
      this._pixels = null;
      this.width = this.height = 0;
    }
  };
  function resolveImagePixels(src) {
    if (!src) return null;
    if (src._pixels && src.width && src.height) return { pixels: src._pixels, width: src.width, height: src.height };
    const f = src._csimVideoFrame;
    if (f && f._pixels && f.width && f.height) return { pixels: f._pixels, width: f.width, height: f.height };
    return null;
  }
  __name(resolveImagePixels, "resolveImagePixels");
  function blitRGBA(src, srcW, srcH, sx, sy, sw, sh, dst, dstW, dstH, dx, dy, dw, dh) {
    const isIdentity = sw === dw && sh === dh;
    const allInBounds = sx >= 0 && sy >= 0 && sx + sw <= srcW && sy + sh <= srcH && dx >= 0 && dy >= 0 && dx + dw <= dstW && dy + dh <= dstH;
    if (isIdentity && allInBounds) {
      for (let row = 0; row < sh; row++) {
        const sRowStart = ((sy + row) * srcW + sx) * 4;
        const dRowStart = ((dy + row) * dstW + dx) * 4;
        dst.set(src.subarray(sRowStart, sRowStart + sw * 4), dRowStart);
      }
      return;
    }
    for (let row = 0; row < dh; row++) {
      const srcRow = sy + (row * sh / dh | 0);
      const dstRow = dy + row;
      if (dstRow < 0 || dstRow >= dstH || srcRow < 0 || srcRow >= srcH) continue;
      for (let col = 0; col < dw; col++) {
        const srcCol = sx + (col * sw / dw | 0);
        const dstCol = dx + col;
        if (dstCol < 0 || dstCol >= dstW || srcCol < 0 || srcCol >= srcW) continue;
        const sIdx = (srcRow * srcW + srcCol) * 4;
        const dIdx = (dstRow * dstW + dstCol) * 4;
        dst[dIdx] = src[sIdx];
        dst[dIdx + 1] = src[sIdx + 1];
        dst[dIdx + 2] = src[sIdx + 2];
        dst[dIdx + 3] = src[sIdx + 3];
      }
    }
  }
  __name(blitRGBA, "blitRGBA");
  function createImageBitmap(source, optionsOrSx, sy, sw, sh, opts) {
    let options = optionsOrSx;
    if (typeof optionsOrSx === "number") options = opts || {};
    options = options || {};
    return new Promise((resolve, reject) => {
      let bytes = "";
      if (source instanceof globalThis.Blob) {
        bytes = blobBytes(source);
      } else if (source instanceof ImageData) {
        const bm2 = new ImageBitmap();
        bm2._pixels = new globalThis.Uint8ClampedArray(source.data);
        bm2.width = source.width;
        bm2.height = source.height;
        return resolve(bm2);
      } else {
        return reject(new TypeError("createImageBitmap: unsupported source"));
      }
      if (!bytes) return reject(new Error("createImageBitmap: empty source"));
      const decoded = globalThis.__csim_decodeImage(globalThis.btoa(bytes), options.resizeWidth | 0, options.resizeHeight | 0);
      if (!decoded) return reject(new Error("createImageBitmap: decode failed"));
      const pixelBytes = fetchTransfer(decoded.refId) || fetchedToBytes(decoded.pixels);
      if (!pixelBytes) return reject(new Error("createImageBitmap: decode failed"));
      const bm = new ImageBitmap();
      bm._pixels = new globalThis.Uint8ClampedArray(pixelBytes.buffer, pixelBytes.byteOffset, pixelBytes.byteLength);
      bm.width = decoded.width | 0;
      bm.height = decoded.height | 0;
      resolve(bm);
    });
  }
  __name(createImageBitmap, "createImageBitmap");
  var CanvasRenderingContext2D = class {
    static {
      __name(this, "CanvasRenderingContext2D");
    }
    constructor(canvas) {
      this.canvas = canvas;
      this.fillStyle = "#000000";
      this.strokeStyle = "#000000";
      this.globalAlpha = 1;
      this.globalCompositeOperation = "source-over";
      this.imageSmoothingEnabled = true;
      this.lineWidth = 1;
      this.font = "10px sans-serif";
      this.textAlign = "start";
      this.textBaseline = "alphabetic";
    }
    // No-op vector primitives — present so libraries that build a
    // path and then `getImageData` don't crash.
    save() {
    }
    restore() {
    }
    scale() {
    }
    rotate() {
    }
    translate() {
    }
    transform() {
    }
    setTransform() {
    }
    resetTransform() {
    }
    beginPath() {
    }
    closePath() {
    }
    moveTo() {
    }
    lineTo() {
    }
    bezierCurveTo() {
    }
    quadraticCurveTo() {
    }
    arc() {
    }
    arcTo() {
    }
    rect() {
    }
    ellipse() {
    }
    fill() {
    }
    stroke() {
    }
    clip() {
    }
    fillRect() {
    }
    strokeRect() {
    }
    clearRect() {
    }
    fillText() {
    }
    strokeText() {
    }
    measureText(s) {
      return {
        width: String(s).length * 6,
        actualBoundingBoxLeft: 0,
        actualBoundingBoxRight: 0,
        actualBoundingBoxAscent: 8,
        actualBoundingBoxDescent: 2
      };
    }
    drawImage(source, ...args) {
      const src = resolveImagePixels(source);
      if (!src) return;
      let sx = 0, sy = 0, sw = src.width, sh = src.height;
      let dx = 0, dy = 0, dw = sw, dh = sh;
      if (args.length === 2) {
        dx = args[0] | 0;
        dy = args[1] | 0;
      } else if (args.length === 4) {
        dx = args[0] | 0;
        dy = args[1] | 0;
        dw = args[2] | 0;
        dh = args[3] | 0;
      } else if (args.length === 8) {
        sx = args[0] | 0;
        sy = args[1] | 0;
        sw = args[2] | 0;
        sh = args[3] | 0;
        dx = args[4] | 0;
        dy = args[5] | 0;
        dw = args[6] | 0;
        dh = args[7] | 0;
      }
      const cw = this.canvas.width | 0;
      const ch = this.canvas.height | 0;
      if (!cw || !ch) return;
      if (!this.canvas._pixels) this.canvas._pixels = new globalThis.Uint8ClampedArray(cw * ch * 4);
      blitRGBA(
        src.pixels,
        src.width,
        src.height,
        sx,
        sy,
        sw,
        sh,
        this.canvas._pixels,
        cw,
        ch,
        dx,
        dy,
        dw,
        dh
      );
    }
    getImageData(x, y, w, h) {
      x |= 0;
      y |= 0;
      w |= 0;
      h |= 0;
      const cw = this.canvas.width | 0;
      const ch = this.canvas.height | 0;
      const out = new globalThis.Uint8ClampedArray(w * h * 4);
      const src = this.canvas._pixels;
      if (src) blitRGBA(src, cw, ch, x, y, w, h, out, w, h, 0, 0, w, h);
      return new ImageData(out, w, h);
    }
    putImageData(imageData, dx, dy, dirtyX, dirtyY, dirtyW, dirtyH) {
      const cw = this.canvas.width | 0;
      const ch = this.canvas.height | 0;
      if (!cw || !ch) return;
      if (!this.canvas._pixels) this.canvas._pixels = new globalThis.Uint8ClampedArray(cw * ch * 4);
      const iw = imageData.width | 0;
      const ih = imageData.height | 0;
      const drX = dirtyX == null ? 0 : dirtyX | 0;
      const drY = dirtyY == null ? 0 : dirtyY | 0;
      const drW = dirtyW == null ? iw : dirtyW | 0;
      const drH = dirtyH == null ? ih : dirtyH | 0;
      blitRGBA(
        imageData.data,
        iw,
        ih,
        drX,
        drY,
        drW,
        drH,
        this.canvas._pixels,
        cw,
        ch,
        (dx | 0) + drX,
        (dy | 0) + drY,
        drW,
        drH
      );
    }
    createImageData(arg1, arg2) {
      if (arg1 instanceof ImageData) return new ImageData(arg1.width, arg1.height);
      return new ImageData(arg1 | 0, arg2 | 0);
    }
  };
  var OffscreenCanvas = class {
    static {
      __name(this, "OffscreenCanvas");
    }
    constructor(width, height) {
      this.width = width | 0;
      this.height = height | 0;
      this._pixels = null;
      this._ctx = null;
    }
    getContext(type) {
      if (type !== "2d" && type !== "bitmaprenderer") return null;
      this._ctx = this._ctx || new CanvasRenderingContext2D(this);
      return this._ctx;
    }
    transferToImageBitmap() {
      const bm = new ImageBitmap();
      bm._pixels = this._pixels && new globalThis.Uint8ClampedArray(this._pixels);
      bm.width = this.width;
      bm.height = this.height;
      this._pixels = null;
      return bm;
    }
    convertToBlob(options) {
      return Promise.resolve(canvasEncodeBlob(this, options));
    }
    toBlob(callback, type, quality) {
      scheduleToBlob(this, callback, type, quality);
    }
  };
  function scheduleToBlob(canvas, callback, type, quality) {
    const cb = typeof callback === "function" ? callback : function() {
    };
    queueMicrotask(() => {
      try {
        cb(canvasEncodeBlob(canvas, { type, quality }));
      } catch (_) {
        cb(null);
      }
    });
  }
  __name(scheduleToBlob, "scheduleToBlob");
  function canvasEncodeBlob(canvas, options) {
    const opts = options || {};
    const type = String(opts.type || "image/png").toLowerCase();
    const quality = typeof opts.quality === "number" ? Math.round(opts.quality * 100) : 90;
    if (!canvas._pixels || !canvas.width || !canvas.height) {
      return new globalThis.Blob([""], { type });
    }
    const inRef = stashTransfer(canvas._pixels);
    const result = typeof globalThis.__csim_encodeImage === "function" ? globalThis.__csim_encodeImage(inRef, canvas.width | 0, canvas.height | 0, type, quality) : null;
    const encoded = result && fetchTransfer(result.refId);
    if (!encoded) {
      return new globalThis.Blob([bytesToLatin1(canvas._pixels)], { type: "application/octet-stream" });
    }
    return new globalThis.Blob([bytesToLatin1(encoded)], { type });
  }
  __name(canvasEncodeBlob, "canvasEncodeBlob");
  function installCanvasToBlob(ElementCtor) {
    const proto = ElementCtor.prototype;
    if (proto._csimCanvasToBlobInstalled) return;
    proto._csimCanvasToBlobInstalled = true;
    proto.toBlob = function(callback, type, quality) {
      if (this._tag !== "canvas") {
        const cb = typeof callback === "function" ? callback : function() {
        };
        queueMicrotask(() => cb(null));
        return;
      }
      scheduleToBlob(this, callback, type, quality);
    };
  }
  __name(installCanvasToBlob, "installCanvasToBlob");
  globalThis.ImageData = ImageData;
  globalThis.ImageBitmap = ImageBitmap;
  globalThis.CanvasRenderingContext2D = CanvasRenderingContext2D;
  globalThis.OffscreenCanvas = OffscreenCanvas;
  globalThis.createImageBitmap = createImageBitmap;

  // lib/capybara/simulated/js/src/video.js
  function isVideo(node) {
    return node && node._tag === "video";
  }
  __name(isVideo, "isVideo");
  function resolveVideoBytes(src) {
    if (!src) return "";
    if (src.startsWith("blob:")) {
      const blob = globalThis.__csimBlobs && globalThis.__csimBlobs.get(src);
      if (blob) return blobBytes(blob);
      if (typeof globalThis.__csim_blobResolve === "function") {
        const b64 = globalThis.__csim_blobResolve(src);
        if (b64) {
          try {
            return globalThis.atob(String(b64));
          } catch (_) {
          }
        }
      }
    }
    return "";
  }
  __name(resolveVideoBytes, "resolveVideoBytes");
  function decodeAndDispatch(video, src) {
    const bytes = resolveVideoBytes(src);
    if (!bytes) {
      queueMicrotask(() => dispatchVideoEvent(video, "error"));
      return;
    }
    const decoded = globalThis.__csim_decodeVideoFrame(globalThis.btoa(bytes));
    if (!decoded) {
      queueMicrotask(() => dispatchVideoEvent(video, "error"));
      return;
    }
    video._csimVideoWidth = decoded.width | 0;
    video._csimVideoHeight = decoded.height | 0;
    video._csimVideoDuration = +decoded.duration || 0;
    const pixels = fetchTransfer(decoded.refId);
    if (pixels) {
      video._csimVideoFrame = {
        width: video._csimVideoWidth,
        height: video._csimVideoHeight,
        _pixels: new globalThis.Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.byteLength)
      };
    }
    video._csimVideoReadyState = 4;
    queueMicrotask(() => {
      dispatchVideoEvent(video, "loadedmetadata");
      dispatchVideoEvent(video, "loadeddata");
      dispatchVideoEvent(video, "canplay");
      dispatchVideoEvent(video, "canplaythrough");
    });
  }
  __name(decodeAndDispatch, "decodeAndDispatch");
  function dispatchVideoEvent(video, type) {
    if (!video) return;
    const Ctor = globalThis.Event || function(t) {
      this.type = t;
    };
    const ev = new Ctor(type, { bubbles: false, cancelable: false });
    if (typeof video.dispatchEvent === "function") {
      try {
        video.dispatchEvent(ev);
      } catch (_) {
      }
    }
    const handler = video["on" + type];
    if (typeof handler === "function") {
      try {
        handler.call(video, ev);
      } catch (_) {
      }
    }
  }
  __name(dispatchVideoEvent, "dispatchVideoEvent");
  function onVideoSrcAssigned(video, src) {
    if (!isVideo(video) || !src) return;
    decodeAndDispatch(video, src);
  }
  __name(onVideoSrcAssigned, "onVideoSrcAssigned");
  function installVideoIDL(ElementCtor) {
    const proto = ElementCtor.prototype;
    if (proto._csimVideoIDLInstalled) return;
    proto._csimVideoIDLInstalled = true;
    const def = /* @__PURE__ */ __name((name, get, set) => Object.defineProperty(proto, name, { configurable: true, get, set }), "def");
    def("videoWidth", function() {
      return isVideo(this) ? this._csimVideoWidth | 0 : void 0;
    });
    def("videoHeight", function() {
      return isVideo(this) ? this._csimVideoHeight | 0 : void 0;
    });
    def("duration", function() {
      return isVideo(this) ? +this._csimVideoDuration || 0 : void 0;
    });
    def("readyState", function() {
      return isVideo(this) ? this._csimVideoReadyState | 0 : void 0;
    });
    def("paused", function() {
      return isVideo(this) ? !this._csimVideoPlaying : void 0;
    });
    def("ended", function() {
      return isVideo(this) ? false : void 0;
    });
    def(
      "currentTime",
      function() {
        return isVideo(this) ? +this._csimVideoCurrentTime || 0 : void 0;
      },
      function(v) {
        if (!isVideo(this)) return;
        this._csimVideoCurrentTime = +v || 0;
        queueMicrotask(() => dispatchVideoEvent(this, "seeked"));
      }
    );
    def(
      "muted",
      function() {
        return isVideo(this) ? !!this._csimVideoMuted : void 0;
      },
      function(v) {
        if (isVideo(this)) this._csimVideoMuted = !!v;
      }
    );
    def(
      "autoplay",
      function() {
        return isVideo(this) ? this._attrs.autoplay != null : void 0;
      },
      function(v) {
        if (isVideo(this)) v ? this.setAttribute("autoplay", "") : this.removeAttribute("autoplay");
      }
    );
    def(
      "playsInline",
      function() {
        return isVideo(this) ? this._attrs.playsinline != null : void 0;
      },
      function(v) {
        if (isVideo(this)) v ? this.setAttribute("playsinline", "") : this.removeAttribute("playsinline");
      }
    );
    proto.load = function() {
      if (isVideo(this) && this._attrs.src) decodeAndDispatch(this, this._attrs.src);
    };
    proto.play = function() {
      if (!isVideo(this)) return Promise.resolve();
      this._csimVideoPlaying = true;
      queueMicrotask(() => dispatchVideoEvent(this, "play"));
      return Promise.resolve();
    };
    proto.pause = function() {
      if (!isVideo(this)) return;
      this._csimVideoPlaying = false;
      queueMicrotask(() => dispatchVideoEvent(this, "pause"));
    };
    proto.canPlayType = function(type) {
      if (!isVideo(this)) return "";
      const t = String(type || "").toLowerCase();
      if (/video\/(webm|mp4|ogg|quicktime)/.test(t)) return "probably";
      if (/video\//.test(t)) return "maybe";
      return "";
    };
  }
  __name(installVideoIDL, "installVideoIDL");

  // lib/capybara/simulated/js/src/dialogs.js
  function alert(message) {
    globalThis.__modalDialog("alert", String(message == null ? "" : message), null);
  }
  __name(alert, "alert");
  function confirm(message) {
    return !!globalThis.__modalDialog("confirm", String(message == null ? "" : message), null);
  }
  __name(confirm, "confirm");
  function prompt(message, def) {
    return globalThis.__modalDialog(
      "prompt",
      String(message == null ? "" : message),
      def == null ? "" : String(def)
    );
  }
  __name(prompt, "prompt");
  globalThis.alert = alert;
  globalThis.confirm = confirm;
  globalThis.prompt = prompt;

  // lib/capybara/simulated/js/src/encoding.js
  var B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  var B64_INDEX = (function() {
    const m = new Uint8Array(256);
    for (let i = 0; i < 256; i++) m[i] = 255;
    for (let i = 0; i < 64; i++) m[B64_CHARS.charCodeAt(i)] = i;
    return m;
  })();
  function btoa(data) {
    const s = String(data);
    let out = "";
    for (let i = 0; i < s.length; i += 3) {
      const c1 = s.charCodeAt(i);
      const c2 = i + 1 < s.length ? s.charCodeAt(i + 1) : NaN;
      const c3 = i + 2 < s.length ? s.charCodeAt(i + 2) : NaN;
      if (c1 > 255 || i + 1 < s.length && c2 > 255 || i + 2 < s.length && c3 > 255) {
        throw new Error("InvalidCharacterError: 'btoa' input contained non-Latin1 char");
      }
      const b1 = c1 >> 2;
      const b2 = (c1 & 3) << 4 | (Number.isNaN(c2) ? 0 : c2 >> 4);
      const b3 = Number.isNaN(c2) ? 64 : (c2 & 15) << 2 | (Number.isNaN(c3) ? 0 : c3 >> 6);
      const b4 = Number.isNaN(c3) ? 64 : c3 & 63;
      out += B64_CHARS[b1] + B64_CHARS[b2] + (b3 === 64 ? "=" : B64_CHARS[b3]) + (b4 === 64 ? "=" : B64_CHARS[b4]);
    }
    return out;
  }
  __name(btoa, "btoa");
  function atob(data) {
    let s = String(data).replace(/[\t\n\f\r ]/g, "");
    if (s.length % 4 === 1) throw new Error("InvalidCharacterError: bad 'atob' length");
    s = s.replace(/=+$/, "");
    let out = "";
    let bits = 0, value = 0;
    for (let i = 0; i < s.length; i++) {
      const idx = B64_INDEX[s.charCodeAt(i)];
      if (idx === 255) throw new Error("InvalidCharacterError: bad 'atob' char");
      value = value << 6 | idx;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out += String.fromCharCode(value >> bits & 255);
      }
    }
    return out;
  }
  __name(atob, "atob");
  var TextEncoder2 = class {
    static {
      __name(this, "TextEncoder");
    }
    get encoding() {
      return "utf-8";
    }
    encode(input) {
      const s = String(input == null ? "" : input);
      const bytes = [];
      for (let i = 0; i < s.length; i++) {
        let cp = s.charCodeAt(i);
        if (cp >= 55296 && cp <= 56319 && i + 1 < s.length) {
          const low = s.charCodeAt(i + 1);
          if (low >= 56320 && low <= 57343) {
            cp = 65536 + (cp - 55296 << 10) + (low - 56320);
            i++;
          }
        }
        if (cp >= 55296 && cp <= 57343) cp = 65533;
        if (cp < 128) {
          bytes.push(cp);
        } else if (cp < 2048) {
          bytes.push(192 | cp >> 6, 128 | cp & 63);
        } else if (cp < 65536) {
          bytes.push(224 | cp >> 12, 128 | cp >> 6 & 63, 128 | cp & 63);
        } else {
          bytes.push(
            240 | cp >> 18,
            128 | cp >> 12 & 63,
            128 | cp >> 6 & 63,
            128 | cp & 63
          );
        }
      }
      return new Uint8Array(bytes);
    }
    // WHATWG `encodeInto`: UTF-8-encode `source` into the `destination`
    // Uint8Array, never writing a partial code point. Returns
    // `{read, written}` — `read` counts UTF-16 code units consumed,
    // `written` counts bytes emitted. Stops at the first code point that
    // wouldn't fit in the remaining space.
    encodeInto(source, destination) {
      if (!(destination instanceof Uint8Array)) {
        throw new TypeError("Failed to execute 'encodeInto' on 'TextEncoder': destination is not a Uint8Array.");
      }
      const s = String(source == null ? "" : source);
      const cap = destination.length;
      let read = 0, written = 0;
      for (let i = 0; i < s.length; ) {
        let cp = s.charCodeAt(i);
        let units = 1;
        if (cp >= 55296 && cp <= 56319 && i + 1 < s.length) {
          const low = s.charCodeAt(i + 1);
          if (low >= 56320 && low <= 57343) {
            cp = 65536 + (cp - 55296 << 10) + (low - 56320);
            units = 2;
          }
        }
        if (cp >= 55296 && cp <= 57343) cp = 65533;
        const need = cp < 128 ? 1 : cp < 2048 ? 2 : cp < 65536 ? 3 : 4;
        if (written + need > cap) break;
        if (need === 1) {
          destination[written++] = cp;
        } else if (need === 2) {
          destination[written++] = 192 | cp >> 6;
          destination[written++] = 128 | cp & 63;
        } else if (need === 3) {
          destination[written++] = 224 | cp >> 12;
          destination[written++] = 128 | cp >> 6 & 63;
          destination[written++] = 128 | cp & 63;
        } else {
          destination[written++] = 240 | cp >> 18;
          destination[written++] = 128 | cp >> 12 & 63;
          destination[written++] = 128 | cp >> 6 & 63;
          destination[written++] = 128 | cp & 63;
        }
        read += units;
        i += units;
      }
      return { read, written };
    }
  };
  var CP1252_HIGH = {
    128: 8364,
    130: 8218,
    131: 402,
    132: 8222,
    133: 8230,
    134: 8224,
    135: 8225,
    136: 710,
    137: 8240,
    138: 352,
    139: 8249,
    140: 338,
    142: 381,
    145: 8216,
    146: 8217,
    147: 8220,
    148: 8221,
    149: 8226,
    150: 8211,
    151: 8212,
    152: 732,
    153: 8482,
    154: 353,
    155: 8250,
    156: 339,
    158: 382,
    159: 376
  };
  function decodeStrategy(name) {
    switch (name) {
      case "UTF-16LE":
        return "utf-16le";
      case "UTF-16BE":
        return "utf-16be";
      case "windows-1252":
        return "windows-1252";
      default:
        return "utf-8";
    }
  }
  __name(decodeStrategy, "decodeStrategy");
  var EMPTY_BYTES = new Uint8Array(0);
  function toUint8Copy(input) {
    if (input == null || typeof input !== "object") return EMPTY_BYTES;
    try {
      if (ArrayBuffer.isView(input)) {
        return new Uint8Array(input.buffer, input.byteOffset || 0, input.byteLength).slice();
      }
      return new Uint8Array(input).slice();
    } catch (_) {
      return EMPTY_BYTES;
    }
  }
  __name(toUint8Copy, "toUint8Copy");
  var TextDecoder = class {
    static {
      __name(this, "TextDecoder");
    }
    constructor(label, options) {
      const name = getEncoding(label === void 0 ? "utf-8" : String(label));
      if (!name || name === "replacement") {
        throw new RangeError("Failed to construct 'TextDecoder': The encoding label provided ('" + label + "') is invalid.");
      }
      this.encoding = name.toLowerCase();
      this._dec = decodeStrategy(name);
      this.fatal = !!(options && options.fatal);
      this.ignoreBOM = !!(options && options.ignoreBOM);
      this._bomEnc = this._dec === "utf-8" || this._dec === "utf-16le" || this._dec === "utf-16be";
      this._doNotFlush = false;
      this._bomSeen = false;
      this._resetDecoder();
    }
    _resetUtf8() {
      this._cp = 0;
      this._need = 0;
      this._seen = 0;
      this._lo = 128;
      this._hi = 191;
    }
    _resetDecoder() {
      this._resetUtf8();
      this._leadByte = -1;
      this._leadSurr = -1;
    }
    // Append one decoded code point to `out` (an array of string pieces),
    // performing the spec serialize step's one-time BOM removal: the first
    // U+FEFF of the whole output stream is dropped for UTF-8 / UTF-16 unless
    // ignoreBOM. A replacement char counts as that first item too, so a BOM that
    // follows it is no longer stripped.
    _emit(out, cp) {
      if (this._bomEnc && !this._bomSeen) {
        this._bomSeen = true;
        if (!this.ignoreBOM && cp === 65279) return;
      }
      out.push(cp > 65535 ? String.fromCharCode(55296 + (cp - 65536 >> 10), 56320 + (cp - 65536 & 1023)) : String.fromCharCode(cp));
    }
    _err(out) {
      if (this.fatal) {
        throw new TypeError("The encoded data was not valid for encoding " + this.encoding + ".");
      }
      this._emit(out, 65533);
    }
    decode(input, options) {
      const stream = !!(options && options.stream);
      if (!this._doNotFlush) {
        this._resetDecoder();
        this._bomSeen = false;
      }
      this._doNotFlush = stream;
      const bytes = toUint8Copy(input);
      const flush = !stream;
      const out = [];
      try {
        switch (this._dec) {
          case "utf-16le":
            this._utf16(out, bytes, true, flush);
            break;
          case "utf-16be":
            this._utf16(out, bytes, false, flush);
            break;
          case "windows-1252":
            this._win1252(out, bytes);
            break;
          default:
            this._utf8(out, bytes, flush);
            break;
        }
      } catch (e) {
        this._resetDecoder();
        this._bomSeen = false;
        this._doNotFlush = false;
        throw e;
      }
      return out.join("");
    }
    // WHATWG UTF-8 decoder. Tracks bytes-needed/seen plus a per-sequence lower /
    // upper continuation boundary (0xE0→lo 0xA0, 0xED→hi 0x9F, 0xF0→lo 0x90,
    // 0xF4→hi 0x8F) so overlong encodings, encoded surrogates and >U+10FFFF are
    // rejected without a separate range check. An invalid continuation byte is
    // *not* consumed: it's left to be reprocessed as a fresh lead byte (the
    // "prepend" / restore step) — this is why e.g. `F0 41 42` → "�AB".
    _utf8(out, bytes, flush) {
      const n = bytes.length;
      let i = 0;
      for (; ; ) {
        if (i >= n) {
          if (flush && this._need !== 0) {
            this._resetUtf8();
            this._err(out);
          }
          return;
        }
        const b = bytes[i];
        if (this._need === 0) {
          if (b <= 127) {
            this._emit(out, b);
            i++;
          } else if (b >= 194 && b <= 223) {
            this._need = 1;
            this._cp = b & 31;
            i++;
          } else if (b >= 224 && b <= 239) {
            if (b === 224) this._lo = 160;
            else if (b === 237) this._hi = 159;
            this._need = 2;
            this._cp = b & 15;
            i++;
          } else if (b >= 240 && b <= 244) {
            if (b === 240) this._lo = 144;
            else if (b === 244) this._hi = 143;
            this._need = 3;
            this._cp = b & 7;
            i++;
          } else {
            this._err(out);
            i++;
          }
        } else if (b < this._lo || b > this._hi) {
          this._resetUtf8();
          this._err(out);
        } else {
          this._lo = 128;
          this._hi = 191;
          this._cp = this._cp << 6 | b & 63;
          this._seen++;
          i++;
          if (this._seen === this._need) {
            this._emit(out, this._cp);
            this._cp = 0;
            this._need = 0;
            this._seen = 0;
          }
        }
      }
    }
    // WHATWG shared UTF-16 decoder. Buffers a lead byte to form 16-bit code units,
    // pairs a lead surrogate with a following trail. An unmatched lead surrogate
    // emits an error and the following code unit is reprocessed as fresh (handled
    // by falling through with `cu` already assembled). A lone trail is an error.
    _utf16(out, bytes, le, flush) {
      const n = bytes.length;
      let i = 0;
      for (; ; ) {
        if (i >= n) {
          if (flush && (this._leadByte >= 0 || this._leadSurr >= 0)) {
            this._leadByte = -1;
            this._leadSurr = -1;
            this._err(out);
          }
          return;
        }
        const b = bytes[i++];
        if (this._leadByte < 0) {
          this._leadByte = b;
          continue;
        }
        const cu = le ? b << 8 | this._leadByte : this._leadByte << 8 | b;
        this._leadByte = -1;
        if (this._leadSurr >= 0) {
          const ls = this._leadSurr;
          this._leadSurr = -1;
          if (cu >= 56320 && cu <= 57343) {
            this._emit(out, 65536 + (ls - 55296 << 10) + (cu - 56320));
            continue;
          }
          this._err(out);
        }
        if (cu >= 55296 && cu <= 56319) {
          this._leadSurr = cu;
          continue;
        }
        if (cu >= 56320 && cu <= 57343) {
          this._err(out);
          continue;
        }
        this._emit(out, cu);
      }
    }
    // windows-1252: identity except 0x80–0x9F, which map to printable punctuation
    // via the cp1252 table (the 5 undefined slots fall through to the byte value).
    // Also the decode target for iso-8859-1 / ascii labels. Single-byte, so it is
    // stateless and never errors.
    _win1252(out, bytes) {
      for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i];
        this._emit(out, b >= 128 && b <= 159 && CP1252_HIGH[b] !== void 0 ? CP1252_HIGH[b] : b);
      }
    }
  };
  globalThis.btoa = btoa;
  globalThis.atob = atob;
  globalThis.TextEncoder = TextEncoder2;
  globalThis.TextDecoder = TextDecoder;

  // lib/capybara/simulated/js/src/event-source.js
  var byId = /* @__PURE__ */ new Map();
  globalThis.__csim_eventSourceById = byId;
  var EventSource = class extends EventTarget {
    static {
      __name(this, "EventSource");
    }
    constructor(url, options) {
      super();
      this.url = String(url);
      this.withCredentials = !!(options && options.withCredentials);
      this.readyState = 0;
      this.onopen = null;
      this.onmessage = null;
      this.onerror = null;
      this._id = globalThis.__csim_eventSourceOpen(this.url) | 0;
      if (this._id > 0) byId.set(this._id, this);
    }
    close() {
      if (this.readyState === 2) return;
      this.readyState = 2;
      if (this._id > 0) {
        globalThis.__csim_eventSourceClose(this._id);
        byId.delete(this._id);
      }
    }
  };
  EventSource.CONNECTING = 0;
  EventSource.OPEN = 1;
  EventSource.CLOSED = 2;
  globalThis.__csim_deliverEventSourceEvents = function(events) {
    if (!events || !events.length) return 0;
    let delivered = 0;
    for (const e of events) {
      const src = byId.get(e.id | 0);
      if (!src) continue;
      if (e.type === "__open") {
        if (src.readyState === 0) {
          src.readyState = 1;
          dispatchWithOnHandler(src, new Event("open"));
          delivered++;
        }
        continue;
      }
      if (e.type === "__error") {
        src.readyState = 2;
        const evt = new Event("error");
        if (e.message) try {
          evt.message = String(e.message);
        } catch (_) {
        }
        dispatchWithOnHandler(src, evt);
        byId.delete(e.id | 0);
        delivered++;
        continue;
      }
      const type = e.type || "message";
      dispatchWithOnHandler(src, new MessageEvent(type, {
        data: e.data == null ? "" : String(e.data),
        lastEventId: e.lastEventId == null ? "" : String(e.lastEventId),
        origin: src.url
      }));
      delivered++;
    }
    return delivered;
  };
  globalThis.EventSource = EventSource;

  // lib/capybara/simulated/js/src/websocket.js
  var byId2 = /* @__PURE__ */ new Map();
  globalThis.__csim_webSocketById = byId2;
  var WebSocket = class extends EventTarget {
    static {
      __name(this, "WebSocket");
    }
    constructor(url, protocols) {
      super();
      this.url = String(url);
      this.readyState = 0;
      this.bufferedAmount = 0;
      this.extensions = "";
      this.protocol = "";
      this.binaryType = "blob";
      this.onopen = null;
      this.onmessage = null;
      this.onclose = null;
      this.onerror = null;
      const list = protocols == null ? [] : Array.isArray(protocols) ? protocols.map(String) : [String(protocols)];
      this._id = globalThis.__csim_wsOpen(this.url, list) | 0;
      if (this._id > 0) byId2.set(this._id, this);
    }
    send(data) {
      if (this.readyState === 0) throw new DOMException("Failed to execute 'send' on 'WebSocket': Still in CONNECTING state.", "InvalidStateError");
      if (this.readyState !== 1) return;
      if (typeof data === "string") {
        globalThis.__csim_wsSend(this._id, data, false, false);
        return;
      }
      let bytes;
      if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
      else if (ArrayBuffer.isView(data)) bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      else bytes = new Uint8Array(0);
      if (globalThis.RustyRacer) {
        globalThis.__csim_wsSend(this._id, bytes, true, false);
      } else {
        globalThis.__csim_wsSend(this._id, globalThis.btoa(bytesToLatin1(bytes)), true, true);
      }
    }
    close(code, reason) {
      if (this.readyState === 2 || this.readyState === 3) return;
      this.readyState = 2;
      if (this._id > 0) globalThis.__csim_wsClose(this._id, code == null ? 1e3 : code | 0, reason == null ? "" : String(reason));
    }
  };
  WebSocket.CONNECTING = 0;
  WebSocket.OPEN = 1;
  WebSocket.CLOSING = 2;
  WebSocket.CLOSED = 3;
  globalThis.__csim_deliverWebSocketEvents = function(events) {
    if (!events || !events.length) return 0;
    let delivered = 0;
    for (const e of events) {
      const ws = byId2.get(e.id | 0);
      if (!ws) continue;
      if (e.type === "__open") {
        if (ws.readyState === 0) {
          ws.readyState = 1;
          if (e.protocol) ws.protocol = String(e.protocol);
          dispatchWithOnHandler(ws, new Event("open"));
          delivered++;
        }
        continue;
      }
      if (e.type === "__close" || e.type === "__error") {
        if (e.type === "__error") {
          const err = new Event("error");
          if (e.message) try {
            err.message = String(e.message);
          } catch (_) {
          }
          dispatchWithOnHandler(ws, err);
        }
        if (ws.readyState !== 3) {
          ws.readyState = 3;
          const ev = new Event("close");
          try {
            ev.code = e.code == null ? 1006 : e.code | 0;
            ev.reason = e.reason == null ? "" : String(e.reason);
            ev.wasClean = e.type === "__close" && e.code != null;
          } catch (_) {
          }
          dispatchWithOnHandler(ws, ev);
        }
        byId2.delete(e.id | 0);
        delivered++;
        continue;
      }
      let data;
      if (e.binary) {
        const bytes = fetchedToBytes(e.data) || new Uint8Array(0);
        if (ws.binaryType === "arraybuffer") {
          data = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        } else {
          data = typeof globalThis.Blob === "function" ? new globalThis.Blob([bytes]) : bytes.buffer;
        }
      } else {
        data = e.data == null ? "" : e.data;
      }
      dispatchWithOnHandler(ws, new MessageEvent("message", { data, origin: ws.url }));
      delivered++;
    }
    return delivered;
  };
  globalThis.WebSocket = WebSocket;

  // lib/capybara/simulated/js/src/request-body.js
  function setContentTypeIfMissing(headers, value) {
    if (!("Content-Type" in headers) && !("content-type" in headers)) {
      headers["Content-Type"] = value;
    }
  }
  __name(setContentTypeIfMissing, "setContentTypeIfMissing");
  function serializeFormData(fd, headers) {
    let hasFile = false;
    fd.forEach((v) => {
      if (v instanceof globalThis.Blob) hasFile = true;
    });
    if (hasFile) {
      const ser = serializeMultipart(fd);
      setContentTypeIfMissing(headers, "multipart/form-data; boundary=" + ser.boundary);
      return { body: globalThis.btoa(ser.body), b64: true };
    }
    setContentTypeIfMissing(headers, "application/x-www-form-urlencoded;charset=UTF-8");
    const parts = [];
    fd.forEach((v, k) => parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(String(v))));
    return { body: parts.join("&"), b64: false };
  }
  __name(serializeFormData, "serializeFormData");
  function serializeBlob(blob, headers) {
    if (blob.type) setContentTypeIfMissing(headers, blob.type);
    const raw = blobBytes(blob);
    return { body: raw ? globalThis.btoa(raw) : "", b64: true };
  }
  __name(serializeBlob, "serializeBlob");
  function serializeRequestBody(body, headers) {
    if (body == null) return { body: "", b64: false };
    if (typeof body === "string") return { body, b64: false };
    if (body instanceof globalThis.FormData) return serializeFormData(body, headers);
    if (body instanceof globalThis.URLSearchParams) {
      setContentTypeIfMissing(headers, "application/x-www-form-urlencoded;charset=UTF-8");
      return { body: body.toString(), b64: false };
    }
    if (body instanceof globalThis.Blob) return serializeBlob(body, headers);
    return { body: String(body), b64: false };
  }
  __name(serializeRequestBody, "serializeRequestBody");

  // lib/capybara/simulated/js/src/fetch.js
  var Request = class _Request {
    static {
      __name(this, "Request");
    }
    constructor(input, init) {
      init = init || {};
      if (input instanceof _Request) {
        this.url = input.url;
        this.method = input.method;
        this._body = input._body;
        this._headers = new globalThis.Headers(input.headers);
      } else {
        this.url = String(input);
        this.method = "GET";
        this._body = null;
        this._headers = new globalThis.Headers();
      }
      if (init.method) this.method = String(init.method).toUpperCase();
      if (init.body != null) this._body = init.body;
      if (init.headers) {
        if (init.headers instanceof globalThis.Headers) {
          init.headers.forEach((v, k) => this._headers.append(k, v));
        } else if (typeof init.headers === "object") {
          for (const [k, v] of Object.entries(init.headers)) this._headers.append(k, v);
        }
      }
      this.mode = init.mode || "cors";
      this.credentials = init.credentials || "same-origin";
      this.cache = init.cache || "default";
      this.redirect = init.redirect || "follow";
      this.referrer = init.referrer || "about:client";
      this.integrity = init.integrity || "";
      this.signal = init.signal || null;
      this.bodyUsed = false;
    }
    get headers() {
      return this._headers;
    }
    get body() {
      return this._body;
    }
    _consume() {
      if (this.bodyUsed) return Promise.reject(new TypeError("Body already consumed"));
      this.bodyUsed = true;
      return null;
    }
    text() {
      return this._consume() || Promise.resolve(this._body == null ? "" : String(this._body));
    }
    json() {
      const g = this._consume();
      if (g) return g;
      try {
        return Promise.resolve(JSON.parse(this._body || "null"));
      } catch (e) {
        return Promise.reject(e);
      }
    }
    blob() {
      return this._consume() || Promise.resolve(new globalThis.Blob([this._body == null ? "" : String(this._body)]));
    }
    arrayBuffer() {
      return this._consume() || Promise.resolve(bytesToArrayBuffer(this._body == null ? "" : String(this._body)));
    }
    formData() {
      return Promise.resolve(new globalThis.FormData());
    }
    clone() {
      return new _Request(this);
    }
  };
  var FetchResponse = class _FetchResponse {
    static {
      __name(this, "FetchResponse");
    }
    constructor(raw, url) {
      this._raw = raw;
      this._url = url;
      this._consumed = false;
      this._bodyText = raw && raw.body || "";
      this.headers = new globalThis.Headers(raw && raw.headers || {});
      this.url = raw && raw.url || url;
      this.status = raw ? raw.status : 0;
      this.statusText = "";
      this.ok = this.status >= 200 && this.status < 300;
      this.redirected = !!(raw && raw.redirected);
      this.type = raw && raw.type || "basic";
      this.bodyUsed = false;
    }
    _decodeBytes() {
      if (this._raw && typeof this._raw.body_b64 === "string") {
        try {
          return globalThis.atob(this._raw.body_b64);
        } catch (_) {
          return "";
        }
      }
      return this._bodyText;
    }
    _consume() {
      if (this._consumed) return Promise.reject(new TypeError("Body already consumed"));
      this._consumed = true;
      this.bodyUsed = true;
      return null;
    }
    text() {
      return this._consume() || Promise.resolve(this._bodyText);
    }
    json() {
      const guard = this._consume();
      if (guard) return guard;
      try {
        return Promise.resolve(JSON.parse(this._bodyText || "null"));
      } catch (e) {
        return Promise.reject(e);
      }
    }
    blob() {
      return this._consume() || Promise.resolve(
        new globalThis.Blob([this._decodeBytes()], { type: this.headers.get && this.headers.get("content-type") || "" })
      );
    }
    arrayBuffer() {
      return this._consume() || Promise.resolve(bytesToArrayBuffer(this._decodeBytes()));
    }
    formData() {
      return Promise.resolve(new globalThis.FormData());
    }
    clone() {
      return new _FetchResponse(this._raw, this._url);
    }
  };
  var Response = class _Response extends FetchResponse {
    static {
      __name(this, "Response");
    }
    constructor(bodyOrRaw, initOrUrl) {
      const isInternal = bodyOrRaw && typeof bodyOrRaw === "object" && "status" in bodyOrRaw && "body" in bodyOrRaw;
      if (isInternal) {
        super(bodyOrRaw, initOrUrl);
        return;
      }
      const init = initOrUrl || {};
      const status = init.status != null ? Number(init.status) : 200;
      const statusText = init.statusText != null ? String(init.statusText) : "";
      let headers = {};
      if (init.headers) {
        if (init.headers instanceof globalThis.Headers) {
          init.headers.forEach((v, k) => {
            headers[k] = v;
          });
        } else if (Array.isArray(init.headers)) {
          for (const [k, v] of init.headers) headers[k] = v;
        } else if (typeof init.headers === "object") {
          Object.assign(headers, init.headers);
        }
      }
      const bodyText = bodyOrRaw == null ? "" : String(bodyOrRaw);
      super({ status, body: bodyText, headers, url: "" }, "");
      this.statusText = statusText;
      this.type = "default";
    }
    static json(data, init) {
      init = init || {};
      const headers = Object.assign({ "content-type": "application/json" }, init.headers || {});
      return new _Response(JSON.stringify(data), Object.assign({}, init, { headers }));
    }
    static error() {
      const r = new _Response("", { status: 0 });
      r.type = "error";
      return r;
    }
    static redirect(url, status) {
      const r = new _Response("", { status: status || 302, headers: { location: String(url) } });
      return r;
    }
  };
  globalThis.fetch = /* @__PURE__ */ __name(function fetch(input, init) {
    init = init || {};
    let url, method = "GET", body = null, headers = {};
    if (typeof input === "string") {
      url = input;
    } else if (input && input.url) {
      url = input.url;
      if (input.method) method = input.method;
      if (input.body != null) body = input.body;
      if (input.headers) headers = input.headers;
    } else {
      url = String(input);
    }
    if (init.method) method = init.method;
    if (init.body != null) body = init.body;
    if (init.headers) {
      if (init.headers instanceof globalThis.Headers) {
        init.headers.forEach((v, k) => {
          headers[k] = v;
        });
      } else if (typeof init.headers === "object") {
        Object.assign(headers, init.headers);
      }
    }
    const { body: bodyStr, b64 } = serializeRequestBody(body, headers);
    if (b64) headers["X-Csim-Body-B64"] = "1";
    if (typeof url === "string" && url.startsWith("blob:")) {
      return new Promise(function(resolve, reject) {
        globalThis.setTimeout(function() {
          const r = resolveBlobBytes(url);
          if (!r) return reject(new TypeError("blob URL not found: " + url));
          resolve(new Response({
            status: 200,
            body: r.bytes,
            headers: { "content-type": r.type },
            url
          }, url));
        }, 0);
      });
    }
    if (typeof url === "string" && url.startsWith("data:")) {
      return new Promise(function(resolve, reject) {
        globalThis.setTimeout(function() {
          try {
            const comma = url.indexOf(",");
            if (comma < 0) return reject(new TypeError("malformed data URL"));
            const meta = url.slice(5, comma);
            const payload = url.slice(comma + 1);
            const isBase64 = /;base64$/i.test(meta);
            const mediaType = meta.replace(/;base64$/i, "") || "text/plain;charset=US-ASCII";
            let bytes;
            if (isBase64) {
              const bin = globalThis.atob(payload);
              bytes = new Uint8Array(bin.length);
              for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            } else {
              bytes = new TextEncoder().encode(decodeURIComponent(payload));
            }
            resolve(new Response({
              status: 200,
              body: bytes,
              headers: { "content-type": mediaType },
              url
            }, url));
          } catch (e) {
            reject(e);
          }
        }, 0);
      });
    }
    return new Promise(function(resolve, reject) {
      globalThis.setTimeout(function() {
        try {
          const resp = globalThis.__rackFetch(method.toUpperCase(), url, bodyStr, headers, "follow");
          if (!resp) {
            reject(new TypeError("Network request failed: " + url));
            return;
          }
          resolve(new Response(resp, url));
        } catch (e) {
          reject(e);
        }
      }, 0);
    });
  }, "fetch");
  globalThis.Request = Request;
  globalThis.Response = Response;

  // lib/capybara/simulated/js/src/file-reader.js
  var FileReader = class extends EventTarget {
    static {
      __name(this, "FileReader");
    }
    constructor() {
      super();
      this.result = null;
      this.readyState = 0;
      this.error = null;
    }
    readAsText(blob) {
      this._read(blob, (t) => t);
    }
    readAsDataURL(blob) {
      this._read(blob, (t) => "data:" + (blob.type || "application/octet-stream") + ";base64," + (globalThis.__csim_btoa ? globalThis.__csim_btoa(t) : ""));
    }
    readAsArrayBuffer(blob) {
      this._read(blob, (t) => bytesToArrayBuffer(t));
    }
    readAsBinaryString(blob) {
      this._read(blob, (t) => t);
    }
    abort() {
      this.readyState = 2;
      this._fire("abort");
    }
    _read(blob, transform) {
      this.readyState = 1;
      Promise.resolve(blob && blob.text ? blob.text() : "").then((t) => {
        try {
          this.result = transform(t);
          this.readyState = 2;
          this._fire("load");
          this._fire("loadend");
        } catch (e) {
          this.error = e;
          this.readyState = 2;
          this._fire("error");
          this._fire("loadend");
        }
      });
    }
    _fire(type) {
      dispatchWithOnHandler(this, new Event(type));
    }
  };
  globalThis.FileReader = FileReader;

  // lib/capybara/simulated/js/src/form-data.js
  function normalizeEntry(value, filename) {
    const Blob2 = globalThis.Blob;
    const File2 = globalThis.File;
    if (Blob2 && value instanceof Blob2) {
      const name = filename != null ? String(filename) : value.name || "blob";
      if (File2 && value instanceof File2 && filename == null) return value;
      if (File2) return new File2([value], name, { type: value.type, lastModified: value.lastModified });
      return value;
    }
    return String(value);
  }
  __name(normalizeEntry, "normalizeEntry");
  var FormData = class {
    static {
      __name(this, "FormData");
    }
    constructor(form, submitter) {
      this._entries = [];
      if (form && form._tag === "form") {
        const spec = globalThis.__csimFormSerialize(form._id, 0);
        if (spec && Array.isArray(spec.fields)) {
          for (const pair of spec.fields) this._entries.push([String(pair[0]), String(pair[1])]);
        }
        if (spec && Array.isArray(spec.fileInputs)) {
          const File2 = globalThis.File;
          for (const fi of spec.fileInputs) {
            const el = lookup(fi.handle);
            const files = el && el.files;
            if (files && files.length) {
              for (const f of files) this._entries.push([String(fi.name), f]);
            } else if (File2) {
              this._entries.push([String(fi.name), new File2([], "", { type: "application/octet-stream" })]);
            }
          }
        }
        if (submitter && submitter._attrs && submitter._attrs.name) {
          this._entries.push([String(submitter._attrs.name), String(submitter._attrs.value || "")]);
        }
      }
    }
    append(k, v, filename) {
      this._entries.push([String(k), normalizeEntry(v, filename)]);
    }
    delete(k) {
      this._entries = this._entries.filter((e) => e[0] !== String(k));
    }
    get(k) {
      for (const e of this._entries) if (e[0] === String(k)) return e[1];
      return null;
    }
    getAll(k) {
      return this._entries.filter((e) => e[0] === String(k)).map((e) => e[1]);
    }
    has(k) {
      return this._entries.some((e) => e[0] === String(k));
    }
    set(k, v, filename) {
      this.delete(k);
      this.append(k, v, filename);
    }
    forEach(fn) {
      for (const e of this._entries) fn(e[1], e[0], this);
    }
    entries() {
      return this._entries[Symbol.iterator]();
    }
    keys() {
      return this._entries.map((e) => e[0])[Symbol.iterator]();
    }
    values() {
      return this._entries.map((e) => e[1])[Symbol.iterator]();
    }
    [Symbol.iterator]() {
      return this.entries();
    }
  };
  globalThis.FormData = FormData;

  // lib/capybara/simulated/js/src/form-fields.js
  var __KEY_NAME_MAP = {
    enter: { key: "Enter", code: "Enter", keyCode: 13, char: "\n", inputType: "insertLineBreak" },
    return: { key: "Enter", code: "Enter", keyCode: 13, char: "\n", inputType: "insertLineBreak" },
    tab: { key: "Tab", code: "Tab", keyCode: 9, char: "	", inputType: "insertText" },
    space: { key: " ", code: "Space", keyCode: 32, char: " ", inputType: "insertText" },
    backspace: { key: "Backspace", code: "Backspace", keyCode: 8, char: null, inputType: "deleteContentBackward" },
    delete: { key: "Delete", code: "Delete", keyCode: 46, char: null, inputType: "deleteContentForward" },
    escape: { key: "Escape", code: "Escape", keyCode: 27, char: null, inputType: null },
    up: { key: "ArrowUp", code: "ArrowUp", keyCode: 38, char: null, inputType: null },
    down: { key: "ArrowDown", code: "ArrowDown", keyCode: 40, char: null, inputType: null },
    left: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37, char: null, inputType: null },
    right: { key: "ArrowRight", code: "ArrowRight", keyCode: 39, char: null, inputType: null },
    home: { key: "Home", code: "Home", keyCode: 36, char: null, inputType: null },
    end: { key: "End", code: "End", keyCode: 35, char: null, inputType: null },
    page_up: { key: "PageUp", code: "PageUp", keyCode: 33, char: null, inputType: null },
    page_down: { key: "PageDown", code: "PageDown", keyCode: 34, char: null, inputType: null },
    pageup: { key: "PageUp", code: "PageUp", keyCode: 33, char: null, inputType: null },
    pagedown: { key: "PageDown", code: "PageDown", keyCode: 34, char: null, inputType: null }
  };
  var __MODIFIER_NAMES = /* @__PURE__ */ new Set([
    "control",
    "ctrl",
    "command",
    "cmd",
    "meta",
    "shift",
    "alt",
    "option"
  ]);
  var __MODIFIER_KEY_INFO = {
    shift: { key: "Shift", code: "ShiftLeft", keyCode: 16 },
    control: { key: "Control", code: "ControlLeft", keyCode: 17 },
    ctrl: { key: "Control", code: "ControlLeft", keyCode: 17 },
    alt: { key: "Alt", code: "AltLeft", keyCode: 18 },
    option: { key: "Alt", code: "AltLeft", keyCode: 18 },
    meta: { key: "Meta", code: "MetaLeft", keyCode: 91 },
    command: { key: "Meta", code: "MetaLeft", keyCode: 91 },
    cmd: { key: "Meta", code: "MetaLeft", keyCode: 91 }
  };
  var __PRINTABLE_KEY_INFO = {
    " ": { code: "Space", keyCode: 32 },
    "!": { code: "Digit1", keyCode: 49 },
    '"': { code: "Quote", keyCode: 222 },
    "#": { code: "Digit3", keyCode: 51 },
    "$": { code: "Digit4", keyCode: 52 },
    "%": { code: "Digit5", keyCode: 53 },
    "&": { code: "Digit7", keyCode: 55 },
    "'": { code: "Quote", keyCode: 222 },
    "(": { code: "Digit9", keyCode: 57 },
    ")": { code: "Digit0", keyCode: 48 },
    "*": { code: "Digit8", keyCode: 56 },
    "+": { code: "Equal", keyCode: 187 },
    ",": { code: "Comma", keyCode: 188 },
    "-": { code: "Minus", keyCode: 189 },
    ".": { code: "Period", keyCode: 190 },
    "/": { code: "Slash", keyCode: 191 },
    ":": { code: "Semicolon", keyCode: 186 },
    ";": { code: "Semicolon", keyCode: 186 },
    "<": { code: "Comma", keyCode: 188 },
    "=": { code: "Equal", keyCode: 187 },
    ">": { code: "Period", keyCode: 190 },
    "?": { code: "Slash", keyCode: 191 },
    "@": { code: "Digit2", keyCode: 50 },
    "[": { code: "BracketLeft", keyCode: 219 },
    "\\": { code: "Backslash", keyCode: 220 },
    "]": { code: "BracketRight", keyCode: 221 },
    "^": { code: "Digit6", keyCode: 54 },
    "_": { code: "Minus", keyCode: 189 },
    "`": { code: "Backquote", keyCode: 192 },
    "{": { code: "BracketLeft", keyCode: 219 },
    "|": { code: "Backslash", keyCode: 220 },
    "}": { code: "BracketRight", keyCode: 221 },
    "~": { code: "Backquote", keyCode: 192 }
  };
  function __resolveKey(spec) {
    const known = __KEY_NAME_MAP[String(spec).toLowerCase()];
    if (known) return Object.assign({}, known);
    if (spec === "\n") return Object.assign({}, __KEY_NAME_MAP.enter);
    if (spec === "	") return Object.assign({}, __KEY_NAME_MAP.tab);
    if (typeof spec === "string" && spec.length >= 1) {
      const len = spec.length;
      const punct = len === 1 ? __PRINTABLE_KEY_INFO[spec] : null;
      let code, keyCode;
      if (punct) {
        code = punct.code;
        keyCode = punct.keyCode;
      } else if (len === 1) {
        code = "Key" + spec.toUpperCase();
        keyCode = spec.toUpperCase().charCodeAt(0);
      } else {
        code = "";
        keyCode = 0;
      }
      return { key: spec, code, keyCode, char: spec, inputType: "insertText" };
    }
    return { key: String(spec), code: "", keyCode: 0, char: null, inputType: null };
  }
  __name(__resolveKey, "__resolveKey");
  function moveContenteditableCaret(dir) {
    const sel = globalThis.getSelection && globalThis.getSelection();
    if (!sel) return;
    const r = sel._ranges && sel._ranges[0];
    if (!r) return;
    let node = r.startContainer;
    let off = r.startOffset;
    if (dir < 0) {
      if (node && node.nodeType === NODE_TEXT && off > 0) {
        off -= 1;
      } else {
        const prev = previousTextLeaf(node);
        if (!prev) return;
        node = prev;
        off = (prev.data || "").length;
      }
    } else {
      const len = node && node.nodeType === NODE_TEXT ? (node.data || "").length : 0;
      if (node && node.nodeType === NODE_TEXT && off < len) {
        off += 1;
      } else {
        const next = nextTextLeaf(node);
        if (!next) return;
        node = next;
        off = 0;
      }
    }
    if (typeof sel.collapse === "function") sel.collapse(node, off);
  }
  __name(moveContenteditableCaret, "moveContenteditableCaret");
  function previousTextLeaf(start) {
    let n = start;
    while (n) {
      const prev = n.previousSibling;
      if (prev) {
        const leaf = deepestLastText(prev);
        if (leaf && leaf.nodeType === NODE_TEXT) return leaf;
        n = prev;
      } else {
        n = n._parent;
      }
    }
    return null;
  }
  __name(previousTextLeaf, "previousTextLeaf");
  function nextTextLeaf(start) {
    let n = start;
    while (n) {
      const next = n.nextSibling;
      if (next) {
        const leaf = deepestFirstText(next);
        if (leaf && leaf.nodeType === NODE_TEXT) return leaf;
        n = next;
      } else {
        n = n._parent;
      }
    }
    return null;
  }
  __name(nextTextLeaf, "nextTextLeaf");
  function nearestPreAncestor(node) {
    for (let cur = node; cur; cur = cur._parent) {
      if (cur.nodeType === NODE_ELEMENT && cur._tag === "pre") return cur;
    }
    return null;
  }
  __name(nearestPreAncestor, "nearestPreAncestor");
  function moveCaretInPre(dir, savedSel) {
    const sel = globalThis.getSelection && globalThis.getSelection();
    if (!sel) return;
    const sc = savedSel.node;
    const so = savedSel.offset | 0;
    const data = sc.data || "";
    if (data.indexOf("\n") < 0) return;
    const lineStart = data.lastIndexOf("\n", so - 1) + 1;
    const lineEnd = (() => {
      const i = data.indexOf("\n", so);
      return i < 0 ? data.length : i;
    })();
    const col = so - lineStart;
    let target;
    if (dir < 0) {
      if (lineStart === 0) return;
      const prevEnd = lineStart - 1;
      const prevStart = data.lastIndexOf("\n", prevEnd - 1) + 1;
      target = prevStart + Math.min(col, prevEnd - prevStart);
    } else {
      if (lineEnd === data.length) return;
      const nextStart = lineEnd + 1;
      const nextEndAfter = data.indexOf("\n", nextStart);
      const nextEnd = nextEndAfter < 0 ? data.length : nextEndAfter;
      target = nextStart + Math.min(col, nextEnd - nextStart);
    }
    if (typeof sel.collapse === "function") sel.collapse(sc, target);
  }
  __name(moveCaretInPre, "moveCaretInPre");
  function moveContenteditableCaretToBlockEdge(edge) {
    const sel = globalThis.getSelection && globalThis.getSelection();
    if (!sel) return;
    const r = sel._ranges && sel._ranges[0];
    if (!r) return;
    const start = r.startContainer;
    if (!start) return;
    const block = findBlockAncestor(start);
    if (!block) return;
    const leaf = edge === "start" ? deepestFirstText(block) : deepestLastText(block);
    if (!leaf) return;
    const off = edge === "start" ? 0 : leaf.nodeType === NODE_TEXT ? (leaf.data || "").length : leaf._children ? leaf._children.length : 0;
    if (typeof sel.collapse === "function") sel.collapse(leaf, off);
  }
  __name(moveContenteditableCaretToBlockEdge, "moveContenteditableCaretToBlockEdge");
  function findBlockAncestor(node) {
    for (let cur = node; cur; cur = cur._parent) {
      if (cur.nodeType !== NODE_ELEMENT) continue;
      if (BLOCK_TAGS.has(cur._tag)) return cur;
    }
    return null;
  }
  __name(findBlockAncestor, "findBlockAncestor");
  function deepestLastText(root) {
    let n = root;
    while (n && n._children && n._children.length > 0) {
      n = n._children[n._children.length - 1];
    }
    return n;
  }
  __name(deepestLastText, "deepestLastText");
  function deepestFirstText(root) {
    let n = root;
    while (n && n._children && n._children.length > 0) {
      n = n._children[0];
    }
    return n;
  }
  __name(deepestFirstText, "deepestFirstText");
  function findFirstNonEmptyText(root) {
    if (!root) return null;
    if (root.nodeType === NODE_TEXT && (root.data || "").length) return root;
    const kids = root._children;
    if (!kids) return null;
    for (let i = 0; i < kids.length; i++) {
      const hit = findFirstNonEmptyText(kids[i]);
      if (hit) return hit;
    }
    return null;
  }
  __name(findFirstNonEmptyText, "findFirstNonEmptyText");
  function __modifierFlags(names) {
    const out = { ctrlKey: false, metaKey: false, shiftKey: false, altKey: false };
    for (const raw of names) {
      const n = String(raw).toLowerCase();
      if (n === "control" || n === "ctrl") out.ctrlKey = true;
      else if (n === "command" || n === "cmd" || n === "meta") out.metaKey = true;
      else if (n === "shift") out.shiftKey = true;
      else if (n === "alt" || n === "option") out.altKey = true;
    }
    return out;
  }
  __name(__modifierFlags, "__modifierFlags");
  function __appendValue(n, ch) {
    if (ch == null) return;
    const cur = n._attrs.value != null ? n._attrs.value : "";
    const s = n._selectionStart != null ? n._selectionStart : cur.length;
    const e = n._selectionEnd != null ? n._selectionEnd : s;
    const composed = cur.slice(0, s) + ch + cur.slice(e);
    const maxlen = parseInt(n._attrs.maxlength || "", 10);
    n._attrs.value = maxlen > 0 && composed.length > maxlen ? composed.slice(0, maxlen) : composed;
    if (n._tag === "textarea") {
      n._children = newChildList([Object.assign(new Text(n._attrs.value), { _parent: n })]);
    }
    const caret = Math.min(n._attrs.value.length, s + ch.length);
    n._selectionStart = caret;
    n._selectionEnd = caret;
  }
  __name(__appendValue, "__appendValue");
  globalThis.__csimSendKeys = function(h, atoms) {
    let n = lookup(h);
    if (!n || n.nodeType !== NODE_ELEMENT) return false;
    if ((n._tag === "details" || n._tag === "div") && globalThis.document) {
      const active = globalThis.document.activeElement;
      if (active && active !== n && active !== globalThis.document.body) {
        let cur = active;
        while (cur && cur !== n) cur = cur._parent;
        if (cur === n) n = active;
      }
    }
    const ceTypeable = isContenteditable(n);
    const inputType = (n._attrs.type || "").toLowerCase();
    const isCheckOrRadio = n._tag === "input" && (inputType === "radio" || inputType === "checkbox");
    const isFormControl = (n._tag === "input" || n._tag === "textarea") && !(n._attrs.readonly != null || n._attrs.disabled != null);
    const typeable = ceTypeable || isFormControl && !isCheckOrRadio;
    const isInteractive = n._tag === "a" || n._tag === "button" || n._tag === "summary" || n._tag === "select";
    if (typeable || isCheckOrRadio || isInteractive) {
      try {
        n.focus();
      } catch (_) {
      }
    }
    const startValue = typeable ? n._attrs.value || "" : null;
    const pressKey = /* @__PURE__ */ __name((info, modifiers) => {
      const initBase = Object.assign({ bubbles: true, cancelable: true }, modifiers || {});
      const init = Object.assign({}, initBase, { key: info.key, code: info.code, keyCode: info.keyCode, which: info.keyCode });
      const kd = new KeyboardEvent("keydown", init);
      let preNavSavedSel = null;
      if (ceTypeable && (info.key === "ArrowUp" || info.key === "ArrowDown")) {
        const s0 = globalThis.getSelection && globalThis.getSelection();
        const r0 = s0 && s0._ranges && s0._ranges[0];
        const sc0 = r0 && r0.startContainer;
        if (sc0 && sc0.nodeType === NODE_TEXT && nearestPreAncestor(sc0) && (sc0.data || "").indexOf("\n") >= 0) {
          preNavSavedSel = { node: sc0, offset: r0.startOffset | 0 };
        }
      }
      dispatchEvent(n, kd);
      let blocked = kd.defaultPrevented;
      if (!blocked && isCheckOrRadio && info.key === " ") {
        try {
          globalThis.__csimClickResolve(n._id, modifiers || null);
        } catch (_) {
        }
        dispatchEvent(n, new KeyboardEvent("keyup", init));
        return;
      }
      if (!blocked && info.key === "Enter" && typeable && (!modifiers || !modifiers.ctrlKey && !modifiers.metaKey && !modifiers.altKey)) {
        const form = implicitSubmitFormFor(n);
        if (form) {
          const submit = new SubmitEvent("submit", { bubbles: true, cancelable: true, submitter: null });
          dispatchEvent(form, submit);
          if (!submit.defaultPrevented) {
            globalThis.__csimPendingFormSubmit = { form, submitter: null };
          }
        }
      }
      if (info.key === "Enter" || info.key === " ") {
        const isLink = n._tag === "a" && n._attrs.href != null;
        const isButton = n._tag === "button";
        const hasMods = modifiers && (modifiers.ctrlKey || modifiers.metaKey || modifiers.altKey);
        const okDefault = !blocked && n._attrs.disabled == null;
        if (okDefault && (isLink || isButton && !hasMods)) {
          try {
            const action = globalThis.__csimClickResolve(n._id, modifiers || null);
            if (action && action.kind === "navigate" && action.url) {
              globalThis.__csimPendingNavigation = { url: action.url, target: action.target || "" };
            }
          } catch (_) {
          }
        }
      }
      const wouldType = typeable && !blocked && (info.char != null || info.inputType === "deleteContentBackward" || info.inputType === "deleteContentForward") && (!modifiers || !modifiers.ctrlKey && !modifiers.metaKey && !modifiers.altKey);
      if (wouldType && info.inputType) {
        const bi = new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          data: info.char != null ? info.char : null,
          inputType: info.inputType
        });
        dispatchEvent(n, bi);
        if (bi.defaultPrevented) blocked = true;
      }
      if (typeable && !blocked && (info.key === "Home" || info.key === "End")) {
        if (ceTypeable) {
          moveContenteditableCaretToBlockEdge(info.key === "Home" ? "start" : "end");
        } else {
          const cur = n._attrs.value != null ? n._attrs.value : "";
          const pos = info.key === "Home" ? 0 : cur.length;
          n._selectionStart = pos;
          n._selectionEnd = pos;
        }
      } else if (typeable && !blocked && (info.key === "ArrowLeft" || info.key === "ArrowRight")) {
        const dir = info.key === "ArrowLeft" ? -1 : 1;
        if (ceTypeable) {
          moveContenteditableCaret(dir);
        } else {
          const cur = n._attrs.value != null ? n._attrs.value : "";
          const baseAnchor = dir < 0 ? n._selectionStart != null ? n._selectionStart : cur.length : n._selectionEnd != null ? n._selectionEnd : cur.length;
          const next = dir < 0 ? Math.max(0, baseAnchor - 1) : Math.min(cur.length, baseAnchor + 1);
          n._selectionStart = next;
          n._selectionEnd = next;
        }
      } else if (preNavSavedSel) {
        const dir = info.key === "ArrowUp" ? -1 : 1;
        globalThis.setTimeout(() => moveCaretInPre(dir, preNavSavedSel), 0);
      }
      if (!blocked && wouldType) {
        const doDefault = /* @__PURE__ */ __name(() => {
          if (ceTypeable) {
            if (info.char != null) {
              globalThis.__csimInsertTextAtSelection(info.char);
            } else if (info.inputType === "deleteContentBackward") {
              const sel = globalThis.getSelection && globalThis.getSelection();
              const r = sel && sel._ranges[0];
              const sc = r && r.startContainer;
              if (sc && sc.nodeType === NODE_TEXT && r.startOffset > 0) {
                const pos = r.startOffset;
                sc.data = sc._data.slice(0, pos - 1) + sc._data.slice(pos);
                r.startOffset = pos - 1;
                r.endOffset = pos - 1;
              }
            }
          } else if (info.char != null) {
            __appendValue(n, info.char);
          } else if (info.inputType === "deleteContentBackward") {
            const cur = n._attrs.value != null ? n._attrs.value : "";
            const pos = n._selectionStart != null ? n._selectionStart : cur.length;
            if (pos > 0) {
              const next = cur.slice(0, pos - 1) + cur.slice(pos);
              n._attrs.value = next;
              if (n._tag === "textarea") n._children = newChildList([Object.assign(new Text(next), { _parent: n })]);
              n._selectionStart = pos - 1;
              n._selectionEnd = pos - 1;
            }
          }
          try {
            dispatchEvent(n, new InputEvent("input", {
              bubbles: true,
              cancelable: true,
              data: info.char != null ? info.char : null,
              inputType: info.inputType
            }));
          } catch (_) {
          }
        }, "doDefault");
        if (info.key === "Enter" || info.key === "Tab") {
          scheduleTimer(() => {
            if (kd.defaultPrevented) return;
            doDefault();
          }, 0, [], null);
        } else {
          doDefault();
        }
      }
      if (!blocked && info.key === "Tab") {
        scheduleTimer(() => {
          if (kd.defaultPrevented) return;
          try {
            globalThis.__csimAdvanceFocus(!!(modifiers && modifiers.shiftKey));
          } catch (_) {
          }
        }, 0, [], null);
      }
      const kupTarget = globalThis.document.activeElement || n;
      if (!blocked && info.char != null) {
        const printable = info.key && info.key.length === 1 && info.key === info.char;
        const kpInit = printable ? Object.assign({}, init, { which: info.char.charCodeAt(0) }) : init;
        dispatchEvent(kupTarget, new KeyboardEvent("keypress", kpInit));
      }
      dispatchEvent(kupTarget, new KeyboardEvent("keyup", init));
    }, "pressKey");
    const atomList = Array.isArray(atoms) ? atoms : [];
    for (const a of atomList) {
      if (!a || typeof a !== "object") continue;
      if (a.kind === "text") {
        const s = String(a.value || "");
        for (const ch of s) pressKey(__resolveKey(ch), null);
      } else if (a.kind === "key") {
        pressKey(__resolveKey(a.name), null);
      } else if (a.kind === "combo") {
        const parts = Array.isArray(a.parts) ? a.parts : [];
        let lastKeyIdx = -1;
        for (let i = parts.length - 1; i >= 0; i--) {
          if (!__MODIFIER_NAMES.has(String(parts[i]).toLowerCase())) {
            lastKeyIdx = i;
            break;
          }
        }
        const modNames = parts.slice(0, lastKeyIdx >= 0 ? lastKeyIdx : parts.length);
        const mods = __modifierFlags(modNames);
        const keyName = lastKeyIdx >= 0 ? parts[lastKeyIdx] : "";
        const modInfos = modNames.map((m) => __MODIFIER_KEY_INFO[String(m).toLowerCase()]).filter(Boolean);
        for (const mi of modInfos) {
          try {
            dispatchEvent(n, new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: mi.key, code: mi.code, keyCode: mi.keyCode, which: mi.keyCode, ...mods }));
          } catch (_) {
          }
        }
        const isNamedKey = typeof keyName === "string" && __KEY_NAME_MAP[keyName.toLowerCase()];
        if (typeof keyName === "string" && keyName.length > 1 && !isNamedKey) {
          for (const ch of keyName) {
            const cooked = mods.shiftKey ? ch.toUpperCase() : ch;
            pressKey(__resolveKey(cooked), mods);
          }
        } else {
          const single = String(keyName);
          const cooked = mods.shiftKey && single.length === 1 ? single.toUpperCase() : single;
          pressKey(__resolveKey(cooked), mods);
        }
        for (let i = modInfos.length - 1; i >= 0; i--) {
          const mi = modInfos[i];
          try {
            dispatchEvent(n, new KeyboardEvent("keyup", { bubbles: true, cancelable: true, key: mi.key, code: mi.code, keyCode: mi.keyCode, which: mi.keyCode }));
          } catch (_) {
          }
        }
        const lowerKey = String(keyName).toLowerCase();
        const isModCombo = mods.ctrlKey || mods.metaKey;
        if (isModCombo && lowerKey === "a") {
          if (ceTypeable) {
            const sel = globalThis.getSelection?.();
            const host = contenteditableHost(n);
            if (sel && host) sel.selectAllChildren(host);
          } else if (typeable) {
            n.select();
          }
        }
        if (isModCombo && lowerKey === "v") {
          const types = (globalThis.__csimClipboardTypes ? globalThis.__csimClipboardTypes() : []).slice();
          const plain = globalThis.__csimClipboardGet("text/plain") || "";
          const html = globalThis.__csimClipboardGet("text/html") || "";
          const files = (globalThis.__csimClipboardFiles ? globalThis.__csimClipboardFiles() : []).slice();
          if (files.length > 0 && !types.includes("Files")) types.push("Files");
          if (types.length > 0 || plain || html) {
            const ev = new Event("paste", { bubbles: true, cancelable: true });
            ev.clipboardData = {
              types,
              files,
              items: types.map((t) => {
                const isFile = files.some((f) => f && f.type === t);
                return {
                  kind: isFile ? "file" : "string",
                  type: t,
                  getAsFile: isFile ? (() => {
                    const f = files.find((x) => x.type === t);
                    return f || null;
                  }) : (() => null),
                  getAsString: isFile ? ((_cb) => {
                  }) : ((cb) => {
                    try {
                      cb(globalThis.__csimClipboardGet(t) || "");
                    } catch (_) {
                    }
                  })
                };
              }),
              getData(kind) {
                const k = String(kind || "").toLowerCase();
                if (k === "text" || k === "text/plain") return plain;
                if (k === "text/html") return html;
                return globalThis.__csimClipboardGet(k) || "";
              },
              setData() {
              }
            };
            dispatchEvent(n, ev);
            if (!ev.defaultPrevented && typeable) {
              const text = plain || html;
              if (ceTypeable) {
                if (text) globalThis.__csimInsertTextAtSelection(text);
              } else {
                const cur = n._attrs.value != null ? n._attrs.value : "";
                const s = n._selectionStart != null ? n._selectionStart : cur.length;
                const e = n._selectionEnd != null ? n._selectionEnd : s;
                const next = cur.slice(0, s) + text + cur.slice(e);
                n._attrs.value = next;
                if (n._tag === "textarea") {
                  n._children = newChildList([Object.assign(new Text(next), { _parent: n })]);
                }
                n._selectionStart = n._selectionEnd = s + text.length;
                dispatchEvent(n, new InputEvent("input", {
                  bubbles: true,
                  cancelable: true,
                  data: text,
                  inputType: "insertFromPaste"
                }));
              }
            }
          }
        }
      }
    }
    if (typeable && n._attrs.value !== startValue) {
      dispatchEvent(n, new Event("change", { bubbles: true, cancelable: false }));
    }
    return true;
  };
  globalThis.__csimSelectWordAt = function(h) {
    const n = lookup(h);
    if (!n || n.nodeType !== NODE_ELEMENT) return;
    if (!isContenteditable(n)) return;
    const sel = globalThis.getSelection && globalThis.getSelection();
    if (!sel) return;
    let r = sel._ranges && sel._ranges[0];
    let textNode = null;
    let off = 0;
    if (r && r.startContainer && n.contains(r.startContainer) && r.startContainer.nodeType === NODE_TEXT) {
      textNode = r.startContainer;
      off = r.startOffset | 0;
    } else {
      const leaf = findFirstNonEmptyText(n);
      if (!leaf) return;
      textNode = leaf;
      off = 0;
    }
    const wordChar = /[\p{L}\p{N}_]/u;
    const data0 = textNode.data || "";
    let startNode = textNode;
    let startOff = Math.min(off, data0.length);
    let endNode = textNode;
    let endOff = startOff;
    while (startOff > 0 && wordChar.test(data0[startOff - 1])) startOff -= 1;
    while (endOff < data0.length && wordChar.test(data0[endOff])) endOff += 1;
    const anchorBlock = findBlockAncestor(textNode);
    if (startOff === 0) {
      [startNode, startOff] = extendWordAcrossLeaves(startNode, -1, wordChar, anchorBlock);
    }
    if (endOff === data0.length) {
      [endNode, endOff] = extendWordAcrossLeaves(endNode, 1, wordChar, anchorBlock);
    }
    if (startNode === endNode && startOff === endOff) return;
    if (typeof sel.setBaseAndExtent === "function") {
      sel.setBaseAndExtent(startNode, startOff, endNode, endOff);
    } else if (typeof sel.collapse === "function") {
      sel.collapse(startNode, startOff);
      if (typeof sel.extend === "function") sel.extend(endNode, endOff);
    }
  };
  function extendWordAcrossLeaves(startLeaf, dir, wordChar, anchorBlock) {
    let leaf = startLeaf;
    let off = dir < 0 ? 0 : (leaf.data || "").length;
    let cur = dir < 0 ? previousTextLeaf(leaf) : nextTextLeaf(leaf);
    while (cur && cur.nodeType === NODE_TEXT && findBlockAncestor(cur) === anchorBlock) {
      const d = cur.data || "";
      if (!d.length) break;
      const edgeChar = dir < 0 ? d[d.length - 1] : d[0];
      if (!wordChar.test(edgeChar)) break;
      leaf = cur;
      if (dir < 0) {
        off = d.length;
        while (off > 0 && wordChar.test(d[off - 1])) off -= 1;
        if (off > 0) break;
      } else {
        off = 0;
        while (off < d.length && wordChar.test(d[off])) off += 1;
        if (off < d.length) break;
      }
      cur = dir < 0 ? previousTextLeaf(cur) : nextTextLeaf(cur);
    }
    return [leaf, off];
  }
  __name(extendWordAcrossLeaves, "extendWordAcrossLeaves");
  globalThis.__csimIsContentEditable = function(h) {
    const n = lookup(h);
    return !!(n && n.nodeType === NODE_ELEMENT && isContenteditable(n));
  };
  globalThis.__csimAncestorForm = function(h) {
    const n = lookup(h);
    if (!n) return 0;
    const f = ancestorForm(n);
    return f ? f._id : 0;
  };
  function __makeHostBackedFile(info, handle, index) {
    const size = Number(info.size || 0);
    const file = new globalThis.File([], String(info.name || ""), {
      type: String(info.type || ""),
      lastModified: Number(info.lastModified || 0)
    });
    file._csimHost = true;
    file._handle = handle;
    file._index = index;
    file._start = 0;
    file._end = size;
    file.size = size;
    return file;
  }
  __name(__makeHostBackedFile, "__makeHostBackedFile");
  globalThis.__csimSetFiles = function(h, fileInfos) {
    const n = lookup(h);
    if (!n || n.nodeType !== NODE_ELEMENT) return false;
    const list = Array.isArray(fileInfos) ? fileInfos : [];
    n._files = list.map((info, i) => __makeHostBackedFile(info, h, i));
    return true;
  };
  globalThis.__csimSetValue = function(h, value) {
    let n = lookup(h);
    if (!n || n.nodeType !== NODE_ELEMENT) {
      const doc = globalThis.document;
      const active = doc && doc.activeElement;
      if (active && active !== doc.body && active.nodeType === NODE_ELEMENT && (active._tag === "input" || active._tag === "textarea" || isContenteditable(active))) {
        n = active;
      } else {
        return false;
      }
    }
    let tag = n._tag;
    if (tag === "input" || tag === "textarea") {
      if (n._attrs.readonly != null) {
        const t = (n._attrs.type || "text").toLowerCase();
        const READONLY_RESPECTING = /* @__PURE__ */ new Set(["text", "email", "password", "tel", "url", "search", "number", "date", "datetime-local", "time", "week", "month"]);
        if (READONLY_RESPECTING.has(t) || tag === "textarea") return false;
      }
    }
    if (tag === "input" || tag === "textarea" || isContenteditable(n)) {
      try {
        n.focus();
      } catch (_) {
      }
      try {
        if (typeof globalThis.__drainTimers === "function") globalThis.__drainTimers(0, 1e3);
      } catch (_) {
      }
      const active = globalThis.document && globalThis.document.activeElement;
      if (active && active.nodeType === NODE_ELEMENT && active !== n && (n.contains(active) || !n._parent) && (active._tag === "input" || active._tag === "textarea" || isContenteditable(active))) {
        n = active;
        tag = n._tag;
      }
    }
    const v = value == null ? "" : String(value);
    let kind = "value";
    if (tag === "textarea") {
      if (n._defaultValue === void 0) n._defaultValue = n.textContent;
      n._children = newChildList();
      n._children.push(Object.assign(new Text(v), { _parent: n }));
      n._attrs.value = v;
      n._selectionStart = v.length;
      n._selectionEnd = v.length;
    } else if (tag === "input") {
      const type = (n._attrs.type || "text").toLowerCase();
      if (type === "checkbox" || type === "radio") {
        if (n._defaultChecked === void 0) n._defaultChecked = n._attrs.checked != null;
        if (n._defaultValue === void 0) n._defaultValue = n._attrs.value || "";
        const wasChecked = n._attrs.checked != null;
        if (value === true || value === "true") {
          if (type === "radio") setRadio(n);
          else n._attrs.checked = "";
        } else if (value === false || value === "false") delete n._attrs.checked;
        else n._attrs.value = v;
        if (n._attrs.checked != null !== wasChecked) {
          const clickEv = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, which: 1 });
          clickEv._csimActivationHandled = true;
          try {
            dispatchEvent(n, clickEv);
          } catch (_) {
          }
        }
        kind = "checked";
      } else if (type === "range" || type === "number") {
        if (n._defaultValue === void 0) n._defaultValue = n._attrs.value || "";
        const num = parseFloat(v);
        const min = parseFloat(n._attrs.min);
        const max = parseFloat(n._attrs.max);
        let clamped = isNaN(num) ? isNaN(min) ? 0 : min : num;
        if (!isNaN(min) && clamped < min) clamped = min;
        if (!isNaN(max) && clamped > max) clamped = max;
        if (type === "range") {
          const step = parseFloat(n._attrs.step) || 1;
          if (!isNaN(min) && step > 0) {
            const k = Math.round((clamped - min) / step);
            clamped = min + k * step;
            clamped = parseFloat(clamped.toFixed(10));
          }
        }
        n._attrs.value = String(clamped);
      } else {
        if (n._defaultValue === void 0) n._defaultValue = n._attrs.value || "";
        const maxlen = parseInt(n._attrs.maxlength || "", 10);
        n._attrs.value = maxlen > 0 && v.length > maxlen ? v.slice(0, maxlen) : v;
        n._selectionStart = n._attrs.value.length;
        n._selectionEnd = n._attrs.value.length;
      }
    } else if (tag === "select") {
      const opts = n.querySelectorAll("option");
      let hit = false;
      for (const o of opts) {
        const ov = o._attrs.value != null ? o._attrs.value : o.textContent;
        if (ov === v) {
          selectOptionExclusive(n, o);
          hit = true;
          break;
        }
      }
      if (!hit) return false;
    } else if (isContenteditable(n)) {
      const sel = globalThis.getSelection && globalThis.getSelection();
      if (sel) {
        sel.selectAllChildren(n);
        const r0 = sel._ranges[0];
        if (r0 && !r0.collapsed) deleteRangeContents(r0);
        const VOID_TAGS = /* @__PURE__ */ new Set(["br", "img", "hr", "input", "wbr", "meta", "link"]);
        let leaf = n;
        while (leaf._children && leaf._children.length > 0) {
          const next = leaf._children.find(
            (c) => c.nodeType === NODE_ELEMENT && !VOID_TAGS.has(c._tag)
          );
          if (!next) break;
          leaf = next;
        }
        sel.collapse(leaf, leaf._children ? leaf._children.length : 0);
      }
      for (let i = 0; i < v.length; i++) {
        const ch = v[i];
        const kd = new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: ch,
          char: ch
        });
        dispatchEvent(n, kd);
        if (kd.defaultPrevented) {
          continue;
        }
        const r = sel && sel._ranges[0];
        const targetRanges = r ? [{
          startContainer: r.startContainer,
          startOffset: r.startOffset | 0,
          endContainer: r.endContainer,
          endOffset: r.endOffset | 0
        }] : [];
        const bi = new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          data: ch,
          inputType: "insertText",
          targetRanges
        });
        dispatchEvent(n, bi);
        if (!bi.defaultPrevented) {
          globalThis.__csimInsertTextAtSelection(ch);
        }
        try {
          dispatchEvent(n, new InputEvent("input", {
            bubbles: true,
            cancelable: false,
            data: ch,
            inputType: "insertText"
          }));
        } catch (_) {
        }
        try {
          dispatchEvent(n, new KeyboardEvent("keyup", {
            bubbles: true,
            cancelable: true,
            key: ch,
            char: ch
          }));
        } catch (_) {
        }
      }
      dispatchEvent(n, new InputEvent("input", {
        bubbles: true,
        cancelable: false,
        data: v,
        inputType: "insertText"
      }));
      return true;
    } else {
      n._attrs.value = v;
    }
    if (tag === "input" || tag === "textarea" || isContenteditable(n)) {
      try {
        dispatchEvent(n, new KeyboardEvent("keydown", { bubbles: true, cancelable: true }));
      } catch (_) {
      }
    }
    dispatchEvent(n, new InputEvent("input", { bubbles: true, cancelable: true }));
    dispatchEvent(n, new Event("change", { bubbles: true, cancelable: false }));
    if (tag === "input" || tag === "textarea" || isContenteditable(n)) {
      try {
        dispatchEvent(n, new KeyboardEvent("keyup", { bubbles: true, cancelable: true }));
      } catch (_) {
      }
    }
    if (tag === "input" && typeof value === "string" && value.endsWith("\n")) {
      n._attrs.value = String(n._attrs.value || "").replace(/\n$/, "");
      const form = implicitSubmitFormFor(n);
      if (form) {
        globalThis.__csimPendingFormSubmit = { form, submitter: null };
      }
    }
    return true;
  };
  var TEXT_LIKE_INPUT_TYPES = /* @__PURE__ */ new Set([
    "text",
    "email",
    "password",
    "search",
    "tel",
    "url",
    "number",
    "date",
    "datetime-local",
    "month",
    "time",
    "week"
  ]);
  var DEFAULT_SUBMIT_SELECTOR = 'button[type="submit"], button:not([type]), input[type="submit"], input[type="image"]';
  function implicitSubmitFormFor(control) {
    if (!control || control._tag !== "input") return null;
    const type = (control._attrs.type || "text").toLowerCase();
    if (!TEXT_LIKE_INPUT_TYPES.has(type)) return null;
    const form = formForControl(control);
    if (!form) return null;
    if (form.querySelector(DEFAULT_SUBMIT_SELECTOR)) return form;
    let count = 0;
    for (const el of form.querySelectorAll("input")) {
      if (TEXT_LIKE_INPUT_TYPES.has((el._attrs.type || "text").toLowerCase())) {
        if (++count > 1) return null;
      }
    }
    return count === 1 ? form : null;
  }
  __name(implicitSubmitFormFor, "implicitSubmitFormFor");
  function selectOptionExclusive(select, opt) {
    const multi = select._attrs.multiple != null;
    const opts = select.querySelectorAll("option");
    if (!multi) for (const o of opts) delete o._attrs.selected;
    opt._attrs.selected = "";
  }
  __name(selectOptionExclusive, "selectOptionExclusive");
  function __fireSelectChange(sel) {
    try {
      dispatchEvent(sel, new InputEvent("input", { bubbles: true, cancelable: true }));
    } catch (_) {
    }
    try {
      dispatchEvent(sel, new Event("change", { bubbles: true, cancelable: false }));
    } catch (_) {
    }
  }
  __name(__fireSelectChange, "__fireSelectChange");
  function __ancestorSelect(option) {
    let cur = option._parent;
    while (cur && cur._tag !== "select") cur = cur._parent;
    return cur && cur._tag === "select" ? cur : null;
  }
  __name(__ancestorSelect, "__ancestorSelect");
  globalThis.__csimSelectOption = function(h) {
    const n = lookup(h);
    if (!n || n._tag !== "option") return false;
    const sel = __ancestorSelect(n);
    if (!sel) {
      n._attrs.selected = "";
      return true;
    }
    const wasSelected = n._attrs.selected != null;
    selectOptionExclusive(sel, n);
    if (!wasSelected) __fireSelectChange(sel);
    return true;
  };
  globalThis.__csimUnselectOption = function(h) {
    const n = lookup(h);
    if (!n || n._tag !== "option") return false;
    const wasSelected = n._attrs.selected != null;
    delete n._attrs.selected;
    if (wasSelected) {
      const sel = __ancestorSelect(n);
      if (sel) __fireSelectChange(sel);
    }
    return true;
  };
  globalThis.__csimFormSerialize = function(formHandle, submitterHandle) {
    const form = lookup(formHandle);
    if (!form || form._tag !== "form") return null;
    const submitter = submitterHandle ? lookup(submitterHandle) : null;
    const fields = [];
    const fileInputs = [];
    const formId = form._attrs.id;
    const isDescendant = /* @__PURE__ */ __name((el) => {
      for (let cur = el._parent; cur; cur = cur._parent) if (cur === form) return true;
      return false;
    }, "isDescendant");
    const inputs = [];
    for (const f of globalThis.document.documentElement.querySelectorAll("input,textarea,select,button")) {
      const explicit = f._attrs.form;
      if (explicit != null) {
        if (formId && explicit === formId) inputs.push(f);
      } else if (isDescendant(f)) {
        inputs.push(f);
      }
    }
    for (const f of inputs) {
      if (!f._attrs.name) continue;
      const tag = f._tag;
      const name = f._attrs.name;
      if (f._attrs.disabled != null && f !== submitter) continue;
      if (tag === "input") {
        const type = (f._attrs.type || "text").toLowerCase();
        if (type === "submit" || type === "image" || type === "reset" || type === "button") {
          if (f !== submitter) continue;
          fields.push([name, f._attrs.value != null ? f._attrs.value : ""]);
          continue;
        }
        if (type === "checkbox" || type === "radio") {
          if (f._attrs.checked == null) continue;
          fields.push([name, f._attrs.value != null ? f._attrs.value : "on"]);
          continue;
        }
        if (type === "file") {
          const files = (f._files || []).map((file) => ({
            name: String(file.name || ""),
            handle: file && file._csimHost ? file._handle : null,
            index: file && file._csimHost ? file._index : null
          }));
          fileInputs.push({ name, handle: f._id, files });
          continue;
        }
        fields.push([name, f._attrs.value != null ? f._attrs.value : ""]);
      } else if (tag === "textarea") {
        const raw = f._attrs.value != null ? f._attrs.value : stripOneLeadingNewline(f.textContent);
        fields.push([name, String(raw).replace(/\r\n|\r|\n/g, "\r\n")]);
      } else if (tag === "select") {
        const multi = f._attrs.multiple != null;
        const opts = f.querySelectorAll("option");
        let chose = false;
        for (const o of opts) {
          if (o._attrs.selected != null) {
            const v = o._attrs.value != null ? o._attrs.value : o.textContent;
            fields.push([name, v]);
            chose = true;
            if (!multi) break;
          }
        }
        if (!chose && !multi) {
          for (const o of opts) {
            if (o._attrs.disabled != null) continue;
            const v = o._attrs.value != null ? o._attrs.value : o.textContent;
            fields.push([name, v]);
            break;
          }
        }
      } else if (tag === "button") {
        const type = (f._attrs.type || "submit").toLowerCase();
        if (type !== "submit") continue;
        if (f !== submitter) continue;
        fields.push([name, f._attrs.value != null ? f._attrs.value : ""]);
      }
    }
    const subAction = submitter && submitter._attrs && submitter._attrs.formaction;
    const subMethod = submitter && submitter._attrs && submitter._attrs.formmethod;
    const subEnctype = submitter && submitter._attrs && submitter._attrs.formenctype;
    const subTarget = submitter && submitter._attrs && submitter._attrs.formtarget;
    return {
      action: subAction != null ? subAction : form._attrs.action != null ? form._attrs.action : "",
      method: (subMethod || form._attrs.method || "get").toLowerCase(),
      enctype: (subEnctype || form._attrs.enctype || "application/x-www-form-urlencoded").toLowerCase(),
      target: subTarget != null ? subTarget : form._attrs.target != null ? form._attrs.target : "",
      fields,
      fileInputs
    };
  };

  // lib/capybara/simulated/js/src/history.js
  var _state = null;
  function applyHistoryUrl(state2, url, push) {
    _state = state2 === void 0 ? null : state2;
    const target = url == null ? globalThis.location && globalThis.location.href : String(url);
    if (push) {
      if (typeof globalThis.__pushHistoryEntry === "function") globalThis.__pushHistoryEntry(target, _state);
    } else if (typeof globalThis.__setCurrentUrl === "function") {
      globalThis.__setCurrentUrl(target, _state);
    }
    if (url != null && typeof globalThis.__csimUpdateLocation === "function") {
      globalThis.__csimUpdateLocation(target);
    }
  }
  __name(applyHistoryUrl, "applyHistoryUrl");
  var history = {
    get length() {
      return typeof globalThis.__historyLength === "function" ? globalThis.__historyLength() : 1;
    },
    get state() {
      return _state;
    },
    scrollRestoration: "auto",
    pushState(state2, _title, url) {
      applyHistoryUrl(state2, url, true);
    },
    replaceState(state2, _title, url) {
      applyHistoryUrl(state2, url, false);
    },
    back() {
      if (typeof globalThis.__historyGo === "function") globalThis.__historyGo(-1);
    },
    forward() {
      if (typeof globalThis.__historyGo === "function") globalThis.__historyGo(1);
    },
    go(delta = 0) {
      const d = Number(delta) | 0;
      if (d === 0) {
        if (typeof globalThis.__locationReload === "function") globalThis.__locationReload();
        return;
      }
      if (typeof globalThis.__historyGo === "function") globalThis.__historyGo(d);
    }
  };
  globalThis.__csimDispatchPopState = function(state2) {
    _state = state2 === void 0 ? null : state2;
    try {
      globalThis.dispatchEvent(new PopStateEvent("popstate", { state: _state }));
    } catch (_) {
    }
  };
  globalThis.history = history;

  // lib/capybara/simulated/js/src/host-queries.js
  function implicitDefaultOption(sel) {
    const gen = currentSettleGen();
    if (sel.__csimImplicitDefaultGen === gen) return sel.__csimImplicitDefaultOpt;
    const opts = sel.querySelectorAll("option");
    let firstEnabled = null;
    let result = null;
    for (const o of opts) {
      if (o._attrs.selected != null) {
        result = false;
        break;
      }
      if (o._attrs.disabled == null && firstEnabled === null) firstEnabled = o;
    }
    if (result !== false) result = firstEnabled;
    sel.__csimImplicitDefaultGen = gen;
    sel.__csimImplicitDefaultOpt = result;
    return result;
  }
  __name(implicitDefaultOption, "implicitDefaultOption");
  globalThis.__csimDocumentTitle = function() {
    const head = globalThis.document.head;
    if (!head) return "";
    const t = head._children.find((c) => c._tag === "title");
    if (!t) return "";
    return t.textContent.replace(/[\t\n\f\r ]+/g, " ").replace(/^ | $/g, "");
  };
  globalThis.__csimDocumentText = function() {
    const body = globalThis.document.body;
    return body ? body.textContent : "";
  };
  globalThis.__csimQuery = function(rootHandle, selector) {
    const root = rootHandle ? lookup(rootHandle) : globalThis.document;
    if (!root) return [];
    const matches = root.nodeType === NODE_DOC ? root.querySelectorAll(selector) : root.querySelectorAll ? root.querySelectorAll(selector) : [];
    return matches.map((el) => el._id);
  };
  globalThis.__csimEvaluateXPath = function(xpath, contextHandle) {
    const ctx = contextHandle ? lookup(contextHandle) : globalThis.document;
    if (!ctx) return [];
    let result;
    try {
      result = globalThis.document.evaluate(String(xpath), ctx, null, 7, null);
    } catch (e) {
      try {
        console.error("[csim] XPath threw:", e && e.message, "for", xpath);
      } catch (_) {
      }
      return [];
    }
    const out = [];
    for (let i = 0; i < result.snapshotLength; i++) {
      const n = result.snapshotItem(i);
      if (n && typeof n._id === "number") out.push(n._id);
    }
    return out;
  };
  globalThis.__csimQueryOne = function(rootHandle, selector) {
    const root = rootHandle ? lookup(rootHandle) : globalThis.document;
    if (!root) return 0;
    const hit = root.nodeType === NODE_DOC ? root.querySelector(selector) : root.querySelector ? root.querySelector(selector) : null;
    return hit ? hit._id : 0;
  };
  globalThis.__csimText = function(h) {
    const n = lookup(h);
    return n ? n.textContent : "";
  };
  globalThis.__csimTag = function(h) {
    const n = lookup(h);
    if (!n) return "";
    if (n._tag) return n._tag;
    if (n instanceof globalThis.ShadowRoot) return "ShadowRoot";
    return "";
  };
  globalThis.__csimDescribeNode = function(h) {
    const n = lookup(h);
    if (!n || n.nodeType !== NODE_ELEMENT) return null;
    const cls = (n._attrs.class || "").trim().split(/\s+/)[0] || "";
    return { tag: n._tag || "", id: n._attrs.id || "", cls };
  };
  var __csimIntAttrIDLs = {
    ol: /* @__PURE__ */ new Set(["start"]),
    li: /* @__PURE__ */ new Set(["value"]),
    td: /* @__PURE__ */ new Set(["colSpan", "colspan", "rowSpan", "rowspan"]),
    th: /* @__PURE__ */ new Set(["colSpan", "colspan", "rowSpan", "rowspan"]),
    input: /* @__PURE__ */ new Set(["maxLength", "maxlength", "minLength", "minlength", "size"]),
    textarea: /* @__PURE__ */ new Set(["cols", "rows", "maxLength", "maxlength", "minLength", "minlength"]),
    select: /* @__PURE__ */ new Set(["size"]),
    img: /* @__PURE__ */ new Set(["width", "height", "naturalWidth", "naturalHeight"])
  };
  globalThis.__csimAttr = function(h, name) {
    const n = lookup(h);
    if (!n) return null;
    const s = String(name);
    switch (s) {
      case "validationMessage":
        return n.validationMessage || "";
      case "validity":
        return n.validity || null;
      case "innerHTML":
        return typeof n.innerHTML === "string" ? n.innerHTML : null;
      case "outerHTML":
        return typeof n.outerHTML === "string" ? n.outerHTML : null;
      case "innerText": {
        const raw = typeof globalThis.__csimVisibleText === "function" ? globalThis.__csimVisibleText(h) : typeof n.innerText === "string" ? n.innerText : null;
        if (raw == null) return null;
        return raw.split("\n").map((line) => line.replace(/ {2,}/g, " ").trim()).join("\n").replace(/^\n+|\n+$/g, "");
      }
      case "textContent":
        return typeof n.textContent === "string" ? n.textContent : null;
      case "checked":
        return !!n.checked;
      case "disabled":
        return !!n.disabled;
      case "value":
        return n.value != null ? n.value : "";
      case "href":
      case "src":
        if (typeof n[s] === "string") return n[s];
        break;
    }
    const intSet = n._tag && __csimIntAttrIDLs[n._tag];
    if (intSet && intSet.has(s)) {
      const raw = n.getAttribute && n.getAttribute(s.toLowerCase());
      if (raw != null) {
        const parsed = parseInt(raw, 10);
        if (!isNaN(parsed)) return parsed;
      }
    }
    if (s.length > 4 && s.startsWith("aria") && s[4] >= "A" && s[4] <= "Z" && n.getAttribute) {
      return n.getAttribute("aria-" + s[4].toLowerCase() + s.slice(5));
    }
    return n.getAttribute ? n.getAttribute(s) : null;
  };
  globalThis.__csimHasAttr = function(h, name) {
    const n = lookup(h);
    return !!(n && n.hasAttribute && n.hasAttribute(name));
  };
  globalThis.__csimOptionSelected = function(h) {
    const n = lookup(h);
    if (!n || n.nodeType !== NODE_ELEMENT || n._tag !== "option") return false;
    if (n._attrs.selected != null) return true;
    let sel = n._parent;
    while (sel && sel.nodeType === NODE_ELEMENT && sel._tag === "optgroup") sel = sel._parent;
    if (!sel || sel._tag !== "select") return false;
    if (sel._attrs.multiple != null) return false;
    return n === implicitDefaultOption(sel);
  };
  var FORM_CONTROLS = /* @__PURE__ */ new Set(["input", "select", "textarea", "button", "optgroup", "option"]);
  globalThis.__csimDisabled = function(h) {
    const n = lookup(h);
    if (!n || n.nodeType !== NODE_ELEMENT) return false;
    if ((FORM_CONTROLS.has(n._tag) || n._tag === "fieldset") && n._attrs.disabled != null) return true;
    if (n._tag === "option") {
      let cur = n._parent;
      while (cur && cur.nodeType === NODE_ELEMENT && (cur._tag === "optgroup" || cur._tag === "select")) {
        if (cur._attrs.disabled != null) return true;
        cur = cur._parent;
      }
    }
    if (FORM_CONTROLS.has(n._tag)) {
      let cur = n._parent;
      while (cur && cur.nodeType === NODE_ELEMENT) {
        if (cur._tag === "fieldset" && cur._attrs.disabled != null) {
          let legend = null;
          for (const c of cur._children) {
            if (c.nodeType === NODE_ELEMENT && c._tag === "legend") {
              legend = c;
              break;
            }
          }
          if (legend) {
            let p = n;
            while (p) {
              if (p === legend) return false;
              p = p._parent;
            }
          }
          return true;
        }
        cur = cur._parent;
      }
    }
    return false;
  };
  globalThis.__csimAttrs = function(h) {
    const n = lookup(h);
    return n && n._attrs ? Object.assign({}, n._attrs) : {};
  };
  globalThis.__csimBaseHref = function() {
    const doc = globalThis.document;
    if (!doc || !doc.head) return "";
    for (const c of doc.head._children || []) {
      if (c.nodeType === NODE_ELEMENT && c._tag === "base" && c._attrs.href != null) {
        return String(c._attrs.href);
      }
    }
    return "";
  };
  globalThis.__csimNodePath = function(h) {
    const start = handles.get(h);
    if (!start || start.nodeType !== NODE_ELEMENT) return "";
    for (let cur2 = start; cur2; cur2 = cur2._parent) {
      if (cur2 instanceof globalThis.ShadowRoot) return "(: Shadow DOM element - no XPath :)";
    }
    const segments = [];
    let cur = start;
    while (cur && cur.nodeType === NODE_ELEMENT) {
      const parent = cur._parent;
      if (!parent) break;
      const sibs = (parent._children || []).filter(
        (c) => c.nodeType === NODE_ELEMENT && c._tag === cur._tag
      );
      const idx = sibs.indexOf(cur) + 1;
      segments.unshift(cur._tag + "[" + idx + "]");
      cur = parent;
    }
    return "/" + segments.join("/");
  };
  globalThis.__csimOptionContext = function(h) {
    const n = handles.get(h);
    if (!n || n.nodeType !== NODE_ELEMENT) return { hasSelect: false, multiple: false };
    let cur = n._parent;
    while (cur && cur._tag !== "select") cur = cur._parent;
    if (!cur || cur._tag !== "select") return { hasSelect: false, multiple: false };
    return { hasSelect: true, multiple: cur._attrs.multiple != null };
  };
  globalThis.__csimShadowRoot = function(h) {
    const el = handles.get(h);
    const sr = el && el._shadowRoot;
    return sr && sr.mode === "open" && sr._id != null ? sr._id : 0;
  };
  globalThis.__csimActiveElement = function() {
    const doc = globalThis.document;
    if (!doc) return 0;
    const el = doc._activeElement || doc.body || doc.documentElement;
    return el && el._id != null ? el._id : 0;
  };
  globalThis.__csimAlive = function(h) {
    const n = handles.get(h);
    return n != null && isConnected(n);
  };
  globalThis.__csimEnsureFrameRealm = function(h) {
    const el = lookup(h);
    if (!el || el._tag !== "iframe" && el._tag !== "frame") return 0;
    if (typeof globalThis.__csimFrameWindow !== "function") return 0;
    globalThis.__csimFrameWindow(el);
    return el._frameRealmId != null ? el._frameRealmId : 0;
  };
  globalThis.__csimLocationHref = function() {
    return globalThis.location && globalThis.location.href || "";
  };
  globalThis.__csimRebindFrameRealm = function(h, oldId, newId) {
    const el = lookup(h);
    if (el) {
      el._frameRealmId = newId || null;
      el._frameWindow = null;
    }
    const ids = globalThis.__csimChildRealmIds;
    if (ids) {
      if (oldId) ids.delete(oldId);
      if (newId) ids.add(newId);
    }
  };
  globalThis.__csimValue = function(h) {
    const n = lookup(h);
    if (!n || n.nodeType !== NODE_ELEMENT) return null;
    const tag = n._tag;
    if (tag === "textarea") {
      if (n._attrs.value != null) return n._attrs.value;
      return stripOneLeadingNewline(n.textContent);
    }
    if (tag === "select") {
      const opts = n.querySelectorAll("option");
      const multi = n._attrs.multiple != null;
      if (multi) {
        const out = [];
        for (const o of opts) {
          if (o._attrs.selected != null) out.push(o._attrs.value != null ? o._attrs.value : o.textContent);
        }
        return out;
      }
      let implicit = null;
      for (const o of opts) {
        if (o._attrs.disabled != null) continue;
        if (o._attrs.selected != null) return o._attrs.value != null ? o._attrs.value : o.textContent;
        if (implicit == null) implicit = o._attrs.value != null ? o._attrs.value : o.textContent;
      }
      return implicit;
    }
    if (tag === "input") {
      const type = (n._attrs.type || "text").toLowerCase();
      if (type === "checkbox" || type === "radio") return n._attrs.value != null ? n._attrs.value : "on";
      return n._attrs.value != null ? n._attrs.value : "";
    }
    return n._attrs.value != null ? n._attrs.value : "";
  };
  globalThis.__csimInnerHTML = function(h) {
    const el = lookup(h);
    return el && el.nodeType === NODE_ELEMENT ? el.innerHTML : "";
  };
  globalThis.__csimOuterHTML = function(h) {
    const el = lookup(h);
    return el && el.nodeType === NODE_ELEMENT ? el.outerHTML : "";
  };
  globalThis.__csimDocumentHtml = function() {
    return globalThis.document.documentElement ? serializeElement(globalThis.document.documentElement) : "";
  };

  // lib/capybara/simulated/js/src/idb.js
  var _db = /* @__PURE__ */ new Map();
  var _meta = /* @__PURE__ */ new Map();
  var _keyGen = /* @__PURE__ */ new Map();
  function nextAutoKey(dbName, storeName) {
    const id = dbName + "\0" + storeName;
    const cur = _keyGen.get(id) || 0;
    const next = cur + 1;
    _keyGen.set(id, next);
    return next;
  }
  __name(nextAutoKey, "nextAutoKey");
  function bumpKeyGen(dbName, storeName, key) {
    if (typeof key !== "number") return;
    const floored = Math.floor(key);
    if (floored < 1) return;
    const id = dbName + "\0" + storeName;
    const cur = _keyGen.get(id) || 0;
    if (floored > cur) _keyGen.set(id, floored);
  }
  __name(bumpKeyGen, "bumpKeyGen");
  function ensureDb(name) {
    if (!_db.has(name)) _db.set(name, /* @__PURE__ */ new Map());
    if (!_meta.has(name)) _meta.set(name, { version: 0, storeNames: /* @__PURE__ */ new Set(), stores: /* @__PURE__ */ new Map() });
    const m = _meta.get(name);
    if (!m.stores) m.stores = /* @__PURE__ */ new Map();
    return _db.get(name);
  }
  __name(ensureDb, "ensureDb");
  function storeDef(dbName, storeName) {
    ensureDb(dbName);
    const stores = _meta.get(dbName).stores;
    if (!stores.has(storeName)) {
      stores.set(storeName, { keyPath: null, autoIncrement: false, indexes: /* @__PURE__ */ new Map() });
    }
    return stores.get(storeName);
  }
  __name(storeDef, "storeDef");
  function ensureStore(dbName, storeName) {
    const db = ensureDb(dbName);
    if (!db.has(storeName)) db.set(storeName, /* @__PURE__ */ new Map());
    return db.get(storeName);
  }
  __name(ensureStore, "ensureStore");
  function keyTypeRank(k) {
    if (typeof k === "number") return 0;
    if (k instanceof Date) return 1;
    if (typeof k === "string") return 2;
    if (k instanceof ArrayBuffer || k && ArrayBuffer.isView(k)) return 3;
    if (Array.isArray(k)) return 4;
    return 2;
  }
  __name(keyTypeRank, "keyTypeRank");
  function asBytes(k) {
    if (k instanceof ArrayBuffer) return new Uint8Array(k);
    return new Uint8Array(k.buffer, k.byteOffset || 0, k.byteLength);
  }
  __name(asBytes, "asBytes");
  function cmpKey(a, b) {
    const ra = keyTypeRank(a), rb = keyTypeRank(b);
    if (ra !== rb) return ra < rb ? -1 : 1;
    switch (ra) {
      case 0: {
        if (a === b) return 0;
        return a < b ? -1 : 1;
      }
      case 1: {
        const ta = a.getTime(), tb = b.getTime();
        return ta === tb ? 0 : ta < tb ? -1 : 1;
      }
      case 3: {
        const ba = asBytes(a), bb = asBytes(b);
        const n = Math.min(ba.length, bb.length);
        for (let i = 0; i < n; i++) if (ba[i] !== bb[i]) return ba[i] < bb[i] ? -1 : 1;
        return ba.length === bb.length ? 0 : ba.length < bb.length ? -1 : 1;
      }
      case 4: {
        const n = Math.min(a.length, b.length);
        for (let i = 0; i < n; i++) {
          const c = cmpKey(a[i], b[i]);
          if (c !== 0) return c;
        }
        return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
      }
      default: {
        if (a === b) return 0;
        return a < b ? -1 : 1;
      }
    }
  }
  __name(cmpKey, "cmpKey");
  function sortedEntries(map) {
    return Array.from(map.entries()).sort((a, b) => cmpKey(a[0], b[0]));
  }
  __name(sortedEntries, "sortedEntries");
  var IDBKeyRange = class _IDBKeyRange {
    static {
      __name(this, "IDBKeyRange");
    }
    constructor(lower, upper, lowerOpen, upperOpen) {
      this.lower = lower;
      this.upper = upper;
      this.lowerOpen = !!lowerOpen;
      this.upperOpen = !!upperOpen;
    }
    includes(key) {
      if (this.lower !== void 0) {
        const c = cmpKey(key, this.lower);
        if (c < 0 || c === 0 && this.lowerOpen) return false;
      }
      if (this.upper !== void 0) {
        const c = cmpKey(key, this.upper);
        if (c > 0 || c === 0 && this.upperOpen) return false;
      }
      return true;
    }
    static only(v) {
      return new _IDBKeyRange(v, v, false, false);
    }
    static lowerBound(v, open) {
      return new _IDBKeyRange(v, void 0, !!open, false);
    }
    static upperBound(v, open) {
      return new _IDBKeyRange(void 0, v, false, !!open);
    }
    static bound(lower, upper, lOpen, uOpen) {
      return new _IDBKeyRange(lower, upper, !!lOpen, !!uOpen);
    }
  };
  function extractKeyPath(record, keyPath) {
    if (record == null) return void 0;
    if (Array.isArray(keyPath)) return keyPath.map((p) => extractKeyPath(record, p));
    let cur = record;
    for (const part of String(keyPath).split(".")) {
      if (cur == null) return void 0;
      cur = cur[part];
    }
    return cur;
  }
  __name(extractKeyPath, "extractKeyPath");
  function asPredicate(query) {
    if (query == null) return () => true;
    if (query instanceof IDBKeyRange) return (k) => query.includes(k);
    return (k) => cmpKey(k, query) === 0;
  }
  __name(asPredicate, "asPredicate");
  var IDBRequest = class extends EventTarget {
    static {
      __name(this, "IDBRequest");
    }
    constructor(source) {
      super();
      this.source = source || null;
      this.result = null;
      this.error = null;
      this.readyState = "pending";
      this.transaction = null;
      this.onsuccess = null;
      this.onerror = null;
      this.onupgradeneeded = null;
    }
  };
  function deliver(req, type) {
    Promise.resolve().then(() => {
      req.readyState = "done";
      dispatchWithOnHandler(req, { type, target: req });
      if (req.transaction) req.transaction._maybeComplete();
    });
    return req;
  }
  __name(deliver, "deliver");
  function newRequest(store, setup) {
    const req = new IDBRequest(store);
    req.transaction = store.transaction;
    if (store.transaction) store.transaction._track();
    try {
      setup(req);
    } catch (e) {
      req.error = e;
    }
    return deliver(req, req.error ? "error" : "success");
  }
  __name(newRequest, "newRequest");
  var IDBDatabase = class extends EventTarget {
    static {
      __name(this, "IDBDatabase");
    }
    constructor(name) {
      super();
      this.name = name;
      this.version = _meta.get(name) && _meta.get(name).version || 0;
      this.onversionchange = null;
      this.onclose = null;
    }
    get objectStoreNames() {
      return Array.from(_meta.get(this.name).storeNames);
    }
    createObjectStore(name, opts) {
      _meta.get(this.name).storeNames.add(name);
      ensureStore(this.name, name);
      const def = storeDef(this.name, name);
      def.keyPath = opts && opts.keyPath || null;
      def.autoIncrement = !!(opts && opts.autoIncrement);
      return new IDBObjectStore(this.name, name, opts || {});
    }
    deleteObjectStore(name) {
      _meta.get(this.name).storeNames.delete(name);
      _meta.get(this.name).stores.delete(name);
      _db.get(this.name).delete(name);
    }
    transaction(storeNames, mode) {
      return new IDBTransaction(this, storeNames, mode);
    }
    close() {
    }
  };
  var IDBTransaction = class extends EventTarget {
    static {
      __name(this, "IDBTransaction");
    }
    constructor(db, storeNames, mode) {
      super();
      this.db = db;
      this.mode = mode || "readonly";
      this.objectStoreNames = Array.isArray(storeNames) ? storeNames : [storeNames];
      this._pendingRequests = 0;
      this._completed = false;
      this.oncomplete = null;
      this.onerror = null;
      this.onabort = null;
    }
    objectStore(name) {
      const os = new IDBObjectStore(this.db.name, name);
      os.transaction = this;
      return os;
    }
    // Spec: transaction.commit() is a hint; we treat it as marking
    // completion after pending requests settle.
    commit() {
      Promise.resolve().then(() => this._maybeComplete());
    }
    abort() {
      this._completed = true;
      dispatchWithOnHandler(this, { type: "abort", target: this });
    }
    _track() {
      this._pendingRequests++;
    }
    _maybeComplete() {
      if (this._completed) return;
      if (this._pendingRequests > 0) this._pendingRequests--;
      if (this._pendingRequests === 0) {
        this._completed = true;
        Promise.resolve().then(() => dispatchWithOnHandler(this, { type: "complete", target: this }));
      }
    }
  };
  var IDBObjectStore = class extends EventTarget {
    static {
      __name(this, "IDBObjectStore");
    }
    constructor(dbName, name, opts) {
      super();
      this.name = name;
      this._dbName = dbName;
      const def = storeDef(dbName, name);
      this.keyPath = opts && "keyPath" in opts ? opts.keyPath || null : def.keyPath;
      this.autoIncrement = opts && "autoIncrement" in opts ? !!opts.autoIncrement : def.autoIncrement;
      this.transaction = null;
      this._indexes = /* @__PURE__ */ new Map();
      for (const [iname, idef] of def.indexes) {
        const idx = new IDBIndex(this, iname);
        idx.keyPath = idef.keyPath;
        idx.unique = idef.unique;
        idx.multiEntry = idef.multiEntry;
        this._indexes.set(iname, idx);
      }
    }
    _store() {
      return ensureStore(this._dbName, this.name);
    }
    // Point ops bypass sortedEntries — direct Map ops are O(1) and the
    // spec only requires sort order for range/cursor queries.
    get(key) {
      return newRequest(this, (req) => {
        req.result = this._store().get(key);
      });
    }
    // Resolve the effective key for a write: explicit arg wins, else an
    // in-line keyPath value, else (for autoIncrement stores) a generated
    // monotonic integer.
    _resolveWriteKey(value, key) {
      let k = key !== void 0 ? key : this._extractKey(value);
      if (k === void 0 || k === null) {
        if (this.autoIncrement) k = nextAutoKey(this._dbName, this.name);
      } else {
        bumpKeyGen(this._dbName, this.name, k);
      }
      return k;
    }
    put(value, key) {
      return newRequest(this, (req) => {
        const k = this._resolveWriteKey(value, key);
        this._store().set(k, value);
        req.result = k;
      });
    }
    // Spec: add() fails with a ConstraintError when a record with the
    // same key already exists, rather than overwriting (which put does).
    add(value, key) {
      return newRequest(this, (req) => {
        const k = this._resolveWriteKey(value, key);
        const store = this._store();
        if (store.has(k)) {
          const err = new Error("ConstraintError: Key already exists in the object store.");
          err.name = "ConstraintError";
          req.error = err;
          return;
        }
        store.set(k, value);
        req.result = k;
      });
    }
    clear() {
      return newRequest(this, (req) => {
        this._store().clear();
        req.result = void 0;
      });
    }
    getKey(query) {
      return newRequest(this, (req) => {
        const pred = asPredicate(query);
        for (const [k] of sortedEntries(this._store())) if (pred(k)) {
          req.result = k;
          return;
        }
        req.result = void 0;
      });
    }
    getAll(query, count) {
      return newRequest(this, (req) => {
        req.result = this._scan(query, count, ([, v]) => v);
      });
    }
    getAllKeys(query, count) {
      return newRequest(this, (req) => {
        req.result = this._scan(query, count, ([k]) => k);
      });
    }
    count(query) {
      return newRequest(this, (req) => {
        req.result = this._scan(query, void 0, () => 1).length;
      });
    }
    delete(query) {
      return newRequest(this, (req) => {
        const pred = asPredicate(query);
        const store = this._store();
        for (const k of Array.from(store.keys())) if (pred(k)) store.delete(k);
        req.result = void 0;
      });
    }
    _scan(query, count, project) {
      const pred = asPredicate(query);
      const max = count == null ? Infinity : Number(count) || 0;
      const out = [];
      for (const entry of sortedEntries(this._store())) {
        if (out.length >= max) break;
        if (pred(entry[0])) out.push(project(entry));
      }
      return out;
    }
    openCursor(query, direction) {
      return this._newCursorRequest(query, direction, false);
    }
    openKeyCursor(query, direction) {
      return this._newCursorRequest(query, direction, true);
    }
    _newCursorRequest(query, direction, keyOnly) {
      const req = new IDBRequest(this);
      req.transaction = this.transaction;
      if (this.transaction) this.transaction._track();
      const pred = asPredicate(query);
      let entries = sortedEntries(this._store()).filter(([k]) => pred(k));
      if (direction === "prev" || direction === "prevunique") entries.reverse();
      let i = 0;
      const step = /* @__PURE__ */ __name(() => {
        if (i >= entries.length) {
          req.result = null;
        } else {
          const [k, v] = entries[i++];
          req.result = new IDBCursor(req, k, keyOnly ? void 0 : v, step);
        }
        Promise.resolve().then(() => dispatchWithOnHandler(req, { type: "success", target: req }));
      }, "step");
      step();
      if (this.transaction) Promise.resolve().then(() => this.transaction._maybeComplete());
      return req;
    }
    createIndex(name, keyPath, opts) {
      const idx = new IDBIndex(this, name);
      idx.keyPath = keyPath != null ? keyPath : null;
      idx.unique = !!(opts && opts.unique);
      idx.multiEntry = !!(opts && opts.multiEntry);
      this._indexes.set(name, idx);
      storeDef(this._dbName, this.name).indexes.set(name, {
        keyPath: idx.keyPath,
        unique: idx.unique,
        multiEntry: idx.multiEntry
      });
      return idx;
    }
    index(name) {
      return this._indexes.get(name) || new IDBIndex(this, name);
    }
    deleteIndex(name) {
      this._indexes.delete(name);
      storeDef(this._dbName, this.name).indexes.delete(name);
    }
    _extractKey(value) {
      if (!this.keyPath) return void 0;
      return extractKeyPath(value, this.keyPath);
    }
  };
  var IDBIndex = class extends EventTarget {
    static {
      __name(this, "IDBIndex");
    }
    constructor(objectStore, name) {
      super();
      this.name = name;
      this.objectStore = objectStore;
      this.keyPath = null;
      this.unique = false;
      this.multiEntry = false;
    }
    // Records whose index-keyPath value matches `query`, sorted by that
    // index key. Without a keyPath we degrade to primary-key matching.
    _matches(query) {
      if (this.keyPath == null) {
        const pred2 = asPredicate(query);
        return sortedEntries(this.objectStore._store()).filter(([k]) => pred2(k)).map(([k, v]) => ({ indexKey: k, primaryKey: k, value: v }));
      }
      const pred = asPredicate(query);
      const out = [];
      for (const [pk, v] of this.objectStore._store()) {
        const ik = extractKeyPath(v, this.keyPath);
        if (ik === void 0) continue;
        if (pred(ik)) out.push({ indexKey: ik, primaryKey: pk, value: v });
      }
      out.sort((a, b) => cmpKey(a.indexKey, b.indexKey) || cmpKey(a.primaryKey, b.primaryKey));
      return out;
    }
    get(query) {
      return newRequest(this.objectStore, (req) => {
        const m = this._matches(query);
        req.result = m.length ? m[0].value : void 0;
      });
    }
    getKey(query) {
      return newRequest(this.objectStore, (req) => {
        const m = this._matches(query);
        req.result = m.length ? m[0].primaryKey : void 0;
      });
    }
    getAll(q, n) {
      return newRequest(this.objectStore, (req) => {
        const max = n == null ? Infinity : Number(n) || 0;
        req.result = this._matches(q).slice(0, max).map((e) => e.value);
      });
    }
    getAllKeys(q, n) {
      return newRequest(this.objectStore, (req) => {
        const max = n == null ? Infinity : Number(n) || 0;
        req.result = this._matches(q).slice(0, max).map((e) => e.primaryKey);
      });
    }
    count(q) {
      return newRequest(this.objectStore, (req) => {
        req.result = this._matches(q).length;
      });
    }
    openCursor(query, direction) {
      return this._newIndexCursor(query, direction, false);
    }
    openKeyCursor(query, direction) {
      return this._newIndexCursor(query, direction, true);
    }
    _newIndexCursor(query, direction, keyOnly) {
      const store = this.objectStore;
      const req = new IDBRequest(store);
      req.transaction = store.transaction;
      if (store.transaction) store.transaction._track();
      let entries = this._matches(query);
      if (direction === "prev" || direction === "prevunique") entries.reverse();
      let i = 0;
      const step = /* @__PURE__ */ __name(() => {
        if (i >= entries.length) {
          req.result = null;
        } else {
          const e = entries[i++];
          const cur = new IDBCursor(req, e.indexKey, keyOnly ? void 0 : e.value, step);
          cur.primaryKey = e.primaryKey;
          req.result = cur;
        }
        Promise.resolve().then(() => dispatchWithOnHandler(req, { type: "success", target: req }));
      }, "step");
      step();
      if (store.transaction) Promise.resolve().then(() => store.transaction._maybeComplete());
      return req;
    }
  };
  var IDBCursor = class {
    static {
      __name(this, "IDBCursor");
    }
    constructor(request, key, value, advanceFn) {
      this._req = request;
      this.key = key;
      this.primaryKey = key;
      this.value = value;
      this.source = request.source;
      this.direction = "next";
      this._advance = advanceFn;
    }
    advance(count) {
      const n = Math.max(1, count | 0);
      for (let i = 0; i < n; i++) this._advance();
    }
    continue(_key) {
      this._advance();
    }
    continuePrimaryKey() {
      this._advance();
    }
    update(value) {
      if (this.source && this.source._store) this.source._store().set(this.key, value);
      return this._req;
    }
    delete() {
      if (this.source && this.source._store) this.source._store().delete(this.key);
      return this._req;
    }
  };
  var indexedDB = {
    open(name, version) {
      const req = new IDBRequest();
      const meta = _meta.get(String(name));
      const oldVersion = meta ? meta.version : 0;
      const newVersion = version || (oldVersion || 1);
      ensureDb(String(name));
      _meta.get(String(name)).version = newVersion;
      const db = new IDBDatabase(String(name));
      db.version = newVersion;
      req.result = db;
      if (newVersion > oldVersion) {
        Promise.resolve().then(() => {
          dispatchWithOnHandler(req, { type: "upgradeneeded", target: req, oldVersion, newVersion });
        });
      }
      return deliver(req, "success");
    },
    deleteDatabase(name) {
      const req = new IDBRequest();
      _db.delete(String(name));
      _meta.delete(String(name));
      return deliver(req, "success");
    },
    databases() {
      return Promise.resolve(Array.from(_meta.keys()).map((name) => ({ name, version: _meta.get(name).version })));
    },
    cmp(a, b) {
      return cmpKey(a, b);
    }
  };
  globalThis.indexedDB = indexedDB;
  globalThis.IDBRequest = IDBRequest;
  globalThis.IDBDatabase = IDBDatabase;
  globalThis.IDBObjectStore = IDBObjectStore;
  globalThis.IDBTransaction = IDBTransaction;
  globalThis.IDBIndex = IDBIndex;
  globalThis.IDBCursor = IDBCursor;
  globalThis.IDBKeyRange = IDBKeyRange;

  // lib/capybara/simulated/js/src/navigator.js
  var clipboardEntries = {};
  var navigator = {
    // Lead with `Mozilla/5.0` so server-side bot detectors (`browser`
    // gem, ahoy_matey's `Browser.new(ua).bot?`) recognise us as a
    // regular client rather than a crawler. Without it Ahoy's exclude
    // path drops every visit/event we POST. Keep in sync with
    // `Browser::USER_AGENT` in `lib/capybara/simulated/browser.rb`,
    // which sets the same string as `HTTP_USER_AGENT` on the Rack env.
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36 capybara-simulated",
    appName: "Netscape",
    appVersion: "5.0",
    platform: "Linux",
    language: "en-US",
    languages: ["en-US", "en"],
    // Tests flip this via `__csimSetOnline(false)` from the CDP
    // `Network.emulateNetworkConditions(offline:true)` shim — fires
    // `online`/`offline` on window so app-level connectivity services
    // (Discourse's NetworkConnectivity) react.
    get onLine() {
      return globalThis.__csimOnline !== false;
    },
    cookieEnabled: true,
    // Stimulus `navigator.clipboard.writeText(...)` from
    // `copyToClipboard` / `clipboard#copyPre` resolves cleanly. The
    // buffer is in-process and survives across visits in the same
    // Browser — real browsers share a system clipboard; we just need
    // round-trip parity for the copy-then-paste flow tested by
    // `copy_*_to_clipboard`.
    clipboard: {
      writeText(text) {
        const s = String(text == null ? "" : text);
        clipboardEntries = { "text/plain": new globalThis.Blob([s], { type: "text/plain" }) };
        return Promise.resolve();
      },
      readText() {
        const b = clipboardEntries["text/plain"];
        return b ? b.text() : Promise.resolve("");
      },
      // ClipboardItem-based write: ProseMirror / Tiptap paste tests
      // round-trip rich content via
      // `navigator.clipboard.write([new ClipboardItem({'text/html': blob, 'text/plain': blob})])`,
      // and Discourse's `cdp.copy_test_image` writes an `image/png`
      // Blob alongside a `text/html` placeholder for image-paste
      // tests. Store the Blob directly so binary MIMEs (image/*) are
      // surfaced through `clipboardData.files` while text MIMEs stay
      // readable via `Blob.text()`.
      write(items) {
        const next = {};
        const list = Array.isArray(items) ? items : [];
        const pending = [];
        for (const it of list) {
          if (!it || typeof it !== "object") continue;
          const types = Array.isArray(it.types) ? it.types : [];
          for (const t of types) {
            pending.push(
              it.getType(t).then((b) => {
                next[String(t)] = b;
              }).catch(() => {
              })
            );
          }
        }
        return Promise.all(pending).then(() => {
          clipboardEntries = next;
        });
      },
      read() {
        return Promise.resolve([]);
      }
    },
    // PWA registration probes — apps test `'serviceWorker' in navigator`
    // before calling `register(...)`. We return a rejected Promise so the
    // application's "registration failed" branch runs rather than a
    // half-implemented success path.
    serviceWorker: {
      register() {
        return Promise.reject(new Error("Service Workers not supported"));
      },
      getRegistration() {
        return Promise.resolve(void 0);
      },
      getRegistrations() {
        return Promise.resolve([]);
      },
      ready: Promise.reject(new Error("Service Workers not supported")),
      addEventListener() {
      },
      removeEventListener() {
      },
      dispatchEvent() {
      }
    },
    // Permissions API — `navigator.permissions.query({name: …})` is
    // commonly probed before reading the clipboard / using geolocation.
    // Returning `{state: 'prompt'}` lets apps proceed with the request
    // and rely on the request path's own granted/denied feedback.
    permissions: {
      query(descriptor) {
        let state2 = "prompt";
        if (descriptor && descriptor.name === "geolocation") {
          const cfg = __csimReadGeolocationState();
          if (cfg && cfg.denied) {
            state2 = "denied";
          } else if (cfg && (cfg.coords || typeof cfg.latitude === "number")) {
            state2 = "granted";
          }
        }
        return Promise.resolve({ state: state2, addEventListener() {
        }, removeEventListener() {
        }, dispatchEvent() {
        } });
      },
      // Proposed `permissions.request(descriptor)` resolves a
      // PermissionStatus the same way `query` does — same shape, same
      // geolocation-aware state — since we have no real prompt UI.
      request(descriptor) {
        return this.query(descriptor);
      },
      // Legacy `permissions.revoke({name})` resets a permission back to
      // its default prompt state and resolves with the new status. We
      // have no persistent grant store, so report `prompt` unconditionally.
      revoke() {
        return Promise.resolve({ state: "prompt" });
      }
    },
    // Geolocation API. The configured position / denial state is Ruby-backed
    // (set via `page.driver.set_geolocation(...)`) and read on every call
    // through the `__csimGeolocationState` host fn — this survives the per-call
    // VM rebuilds, the way web storage does.
    //
    // Delivery is SYNCHRONOUS, a deliberate parity trade-off. Real browsers
    // fire the callback asynchronously (a task after the current script). We
    // cannot defer through the virtual clock here: a 0-delay timer only fires
    // when `tick_real_time` advances the clock, and the wall-clock step between
    // the `execute_script` that calls getCurrentPosition and the follow-up
    // `evaluate_script` that reads the result rounds to 0 ms on a warm run, so
    // the callback would non-deterministically not have fired yet (flaky). The
    // hot-path alternatives (always draining ready timers, or a per-tick
    // ready-timer probe) regress the find path. Synchronous delivery is
    // deterministic and observationally identical for the only thing that reads
    // a geolocation result here — Capybara, after the call returns. The single
    // observable difference (app code reading state between the call and the end
    // of the current task, expecting the callback NOT to have run) is a pattern
    // no realistic page depends on, and matches the driver's other pragmatic
    // sync shims (sendBeacon, fetch-via-Rack).
    geolocation: {
      getCurrentPosition(success, error) {
        __csimDeliverGeolocation(success, error);
      },
      watchPosition(success, error) {
        const id = ++__csimGeoWatchSeq;
        __csimGeoWatches.set(id, { id, success, error });
        __csimDeliverGeolocation(success, error);
        return id;
      },
      clearWatch(id) {
        __csimGeoWatches.delete(id);
      }
    },
    hardwareConcurrency: 4,
    maxTouchPoints: 0,
    doNotTrack: null,
    pdfViewerEnabled: false,
    // Device Memory API — a coarse RAM hint in GiB, capped at 8 by the
    // spec. Static value; some analytics / adaptive-loading libraries
    // read it before deciding how much to prefetch.
    deviceMemory: 8,
    // Global Privacy Control — a boolean opt-out signal. We are not a
    // GPC-enabled client, so report `false`.
    globalPrivacyControl: false,
    // `sendBeacon` is what analytics libraries (Ahoy.js, Segment) use
    // to POST a payload at page-unload time without blocking
    // navigation. Real browsers queue the request and fire it
    // asynchronously; we route through `__rackFetch` synchronously
    // which is fine for tests — the assertion that follows the click
    // sees the POST through. Without this method,
    // `typeof navigator.sendBeacon === "undefined"` makes Ahoy.js's
    // `canTrackNow()` return false and the code falls back to
    // `setTimeout(trackEvent, 1000)`, which a fast synchronous test
    // never advances past.
    sendBeacon(url, data) {
      try {
        const headers = {};
        const { body, b64 } = serializeRequestBody(data, headers);
        if (typeof data === "string" && !headers["Content-Type"] && !headers["content-type"]) {
          headers["Content-Type"] = "text/plain;charset=UTF-8";
        }
        if (b64) headers["X-Csim-Body-B64"] = "1";
        const resp = globalThis.__rackFetch("POST", String(url), body, headers, "follow");
        return !!resp;
      } catch (_) {
        return false;
      }
    },
    // Legacy `navigator.vibrate(pattern)` — no haptics; report that the
    // request was not honoured.
    vibrate() {
      return false;
    },
    // Long-deprecated `javaEnabled()` / `taintEnabled()` — always false.
    javaEnabled() {
      return false;
    },
    taintEnabled() {
      return false;
    },
    // Gamepad API — no connected gamepads.
    getGamepads() {
      return [];
    },
    // NetworkInformation stub. `navigator.connection.effectiveType` is
    // read by adaptive-loading / lazy-image libraries to decide quality;
    // report a fast, unmetered connection.
    connection: {
      effectiveType: "4g",
      rtt: 50,
      downlink: 10,
      downlinkMax: Infinity,
      saveData: false,
      type: "wifi",
      onchange: null,
      addEventListener() {
      },
      removeEventListener() {
      },
      dispatchEvent() {
        return true;
      }
    },
    // UserActivation — `isActive` is the transient activation flag,
    // `hasBeenActive` the sticky one. We have no per-call activation
    // tracking, so report sticky-active (a real visited page) but not
    // transiently active.
    userActivation: {
      get isActive() {
        return false;
      },
      get hasBeenActive() {
        return true;
      }
    },
    // MediaDevices stub — no camera / microphone. Enumerate yields an
    // empty list and capture requests reject with NotAllowedError, the
    // same as a headless browser with no media permissions.
    mediaDevices: {
      enumerateDevices() {
        return Promise.resolve([]);
      },
      getUserMedia() {
        return Promise.reject(new globalThis.DOMException("Permission denied", "NotAllowedError"));
      },
      getDisplayMedia() {
        return Promise.reject(new globalThis.DOMException("Permission denied", "NotAllowedError"));
      },
      getSupportedConstraints() {
        return {};
      },
      addEventListener() {
      },
      removeEventListener() {
      },
      dispatchEvent() {
        return true;
      },
      ondevicechange: null
    },
    // Media Capabilities — report nothing as supported / smooth / power
    // efficient so apps fall back to their baseline codec path.
    mediaCapabilities: {
      decodingInfo() {
        return Promise.resolve({ supported: false, smooth: false, powerEfficient: false });
      },
      encodingInfo() {
        return Promise.resolve({ supported: false, smooth: false, powerEfficient: false });
      }
    },
    // Web Locks API. `request(name, opts?, cb)` grants the lock
    // immediately (no contention in a single VM) and runs the callback
    // on a microtask; `query()` reports no held / pending locks.
    locks: {
      request(name, optsOrCb, maybeCb) {
        const cb = typeof optsOrCb === "function" ? optsOrCb : maybeCb;
        const opts = optsOrCb && typeof optsOrCb === "object" ? optsOrCb : {};
        const mode = opts.mode === "shared" ? "shared" : "exclusive";
        return Promise.resolve().then(() => cb({ name, mode }));
      },
      query() {
        return Promise.resolve({ held: [], pending: [] });
      }
    }
  };
  globalThis.__csimClipboardGet = function(kind) {
    const t = String(kind || "text/plain");
    const b = clipboardEntries[t] || (t === "text" ? clipboardEntries["text/plain"] : null);
    if (!b) return "";
    if (typeof b === "string") return b;
    if (b._parts && b._parts.length) {
      let out = "";
      for (const p of b._parts) {
        if (typeof p === "string") out += p;
      }
      return out;
    }
    return "";
  };
  globalThis.__csimClipboardSet = function(text) {
    const s = String(text == null ? "" : text);
    clipboardEntries = { "text/plain": new globalThis.Blob([s], { type: "text/plain" }) };
  };
  globalThis.__csimClipboardTypes = function() {
    return Object.keys(clipboardEntries);
  };
  var __EXT_BY_MIME = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/svg+xml": "svg",
    "application/pdf": "pdf",
    "application/zip": "zip",
    "audio/mpeg": "mp3",
    "audio/wav": "wav",
    "video/mp4": "mp4",
    "video/webm": "webm"
  };
  globalThis.__csimClipboardFiles = function() {
    const out = [];
    for (const t of Object.keys(clipboardEntries)) {
      if (t === "text/plain" || t === "text/html" || t === "text/uri-list") continue;
      const b = clipboardEntries[t];
      if (!b) continue;
      if (b instanceof globalThis.File) {
        out.push(b);
        continue;
      }
      const kind = String(t).split("/")[0] || "file";
      const ext = __EXT_BY_MIME[t] || "bin";
      const name = `${kind}.${ext}`;
      out.push(new globalThis.File([b], name, { type: t }));
    }
    return out;
  };
  globalThis.navigator = navigator;
  var __CSIM_GEO_PERMISSION_DENIED = 1;
  var __CSIM_GEO_POSITION_UNAVAILABLE = 2;
  var __CSIM_GEO_TIMEOUT = 3;
  var __csimGeoWatchSeq = 0;
  var __csimGeoWatches = /* @__PURE__ */ new Map();
  function __csimReadGeolocationState() {
    try {
      const json = globalThis.__csimGeolocationState();
      return json ? JSON.parse(json) : null;
    } catch (_) {
      return null;
    }
  }
  __name(__csimReadGeolocationState, "__csimReadGeolocationState");
  function __csimMakeGeolocationPosition(cfg) {
    if (!cfg || typeof cfg !== "object" || cfg.denied) return null;
    const c = cfg.coords || cfg;
    if (typeof c.latitude !== "number" || typeof c.longitude !== "number") return null;
    return {
      coords: {
        latitude: c.latitude,
        longitude: c.longitude,
        accuracy: typeof c.accuracy === "number" ? c.accuracy : 10,
        altitude: typeof c.altitude === "number" ? c.altitude : null,
        altitudeAccuracy: typeof c.altitudeAccuracy === "number" ? c.altitudeAccuracy : null,
        heading: typeof c.heading === "number" ? c.heading : null,
        speed: typeof c.speed === "number" ? c.speed : null
      },
      timestamp: typeof cfg.timestamp === "number" ? cfg.timestamp : Date.now()
    };
  }
  __name(__csimMakeGeolocationPosition, "__csimMakeGeolocationPosition");
  function __csimMakeGeolocationError(code, message) {
    return {
      code,
      message,
      PERMISSION_DENIED: __CSIM_GEO_PERMISSION_DENIED,
      POSITION_UNAVAILABLE: __CSIM_GEO_POSITION_UNAVAILABLE,
      TIMEOUT: __CSIM_GEO_TIMEOUT
    };
  }
  __name(__csimMakeGeolocationError, "__csimMakeGeolocationError");
  function __csimDeliverGeolocation(success, error) {
    const cfg = __csimReadGeolocationState();
    if (cfg && cfg.denied) {
      if (typeof error === "function") {
        error(__csimMakeGeolocationError(__CSIM_GEO_PERMISSION_DENIED, "User denied Geolocation"));
      }
      return;
    }
    const position = __csimMakeGeolocationPosition(cfg);
    if (position) {
      if (typeof success === "function") success(position);
      return;
    }
    if (typeof error === "function") {
      error(__csimMakeGeolocationError(__CSIM_GEO_POSITION_UNAVAILABLE, "Position unavailable"));
    }
  }
  __name(__csimDeliverGeolocation, "__csimDeliverGeolocation");
  globalThis.__csimGeoRefireWatches = function() {
    for (const w of Array.from(__csimGeoWatches.values())) {
      if (__csimGeoWatches.has(w.id)) __csimDeliverGeolocation(w.success, w.error);
    }
  };
  globalThis.__csimSetOnline = function(online) {
    const next = !!online;
    const prev = globalThis.__csimOnline !== false;
    if (next === prev) return;
    globalThis.__csimOnline = next;
    try {
      const evt = new globalThis.Event(next ? "online" : "offline", { bubbles: false, cancelable: false });
      globalThis.dispatchEvent(evt);
    } catch (_) {
    }
  };
  globalThis.ClipboardItem = class ClipboardItem {
    static {
      __name(this, "ClipboardItem");
    }
    constructor(map) {
      this._map = {};
      if (map && typeof map === "object") {
        for (const k of Object.keys(map)) this._map[String(k)] = map[k];
      }
    }
    get types() {
      return Object.keys(this._map);
    }
    getType(type) {
      const v = this._map[String(type)];
      return v ? Promise.resolve(v) : Promise.reject(new Error("NotFoundError"));
    }
  };

  // lib/capybara/simulated/js/src/webauthn.js
  function bytesToB64Url(buf) {
    const u8 = toUint8(buf);
    return globalThis.btoa(bytesToLatin1(u8)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  __name(bytesToB64Url, "bytesToB64Url");
  function b64ToBytes(b64) {
    let s = String(b64 || "").replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    return latin1ToBytes(globalThis.atob(s));
  }
  __name(b64ToBytes, "b64ToBytes");
  function b64ToBuffer(b64) {
    return b64ToBytes(b64).buffer;
  }
  __name(b64ToBuffer, "b64ToBuffer");
  function toUint8(buf) {
    if (!buf) return new Uint8Array(0);
    if (buf instanceof Uint8Array) return buf;
    if (buf instanceof ArrayBuffer) return new Uint8Array(buf);
    if (ArrayBuffer.isView(buf)) return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    if (Array.isArray(buf)) return new Uint8Array(buf);
    return new Uint8Array(0);
  }
  __name(toUint8, "toUint8");
  function namedError(message, name) {
    const err = new Error(String(message || ""));
    err.name = name || "NotAllowedError";
    return err;
  }
  __name(namedError, "namedError");
  function parseHostError(raw) {
    if (raw == null) return namedError("No virtual authenticator", "NotAllowedError");
    if (typeof raw === "object" && raw.error) {
      return namedError(raw.error, raw.name);
    }
    return null;
  }
  __name(parseHostError, "parseHostError");
  function abortIfNeeded(signal) {
    if (signal && signal.aborted) {
      throw namedError("The operation was aborted.", "AbortError");
    }
  }
  __name(abortIfNeeded, "abortIfNeeded");
  var AuthenticatorResponse = class {
    static {
      __name(this, "AuthenticatorResponse");
    }
    constructor(clientDataJSON) {
      this.clientDataJSON = clientDataJSON;
    }
  };
  var AuthenticatorAttestationResponse = class extends AuthenticatorResponse {
    static {
      __name(this, "AuthenticatorAttestationResponse");
    }
    constructor(clientDataJSON, attestationObject) {
      super(clientDataJSON);
      this.attestationObject = attestationObject;
    }
    getTransports() {
      return ["usb"];
    }
    getAuthenticatorData() {
      return this.attestationObject;
    }
    getPublicKey() {
      return null;
    }
    getPublicKeyAlgorithm() {
      return -7;
    }
  };
  var AuthenticatorAssertionResponse = class extends AuthenticatorResponse {
    static {
      __name(this, "AuthenticatorAssertionResponse");
    }
    constructor(clientDataJSON, authenticatorData, signature, userHandle) {
      super(clientDataJSON);
      this.authenticatorData = authenticatorData;
      this.signature = signature;
      this.userHandle = userHandle;
    }
  };
  var PublicKeyCredential = class {
    static {
      __name(this, "PublicKeyCredential");
    }
    constructor({ id, rawId, response, type, authenticatorAttachment }) {
      this.id = id;
      this.rawId = rawId;
      this.response = response;
      this.type = type || "public-key";
      this.authenticatorAttachment = authenticatorAttachment || "cross-platform";
    }
    getClientExtensionResults() {
      return {};
    }
  };
  PublicKeyCredential.isConditionalMediationAvailable = function() {
    return Promise.resolve(true);
  };
  PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable = function() {
    return Promise.resolve(true);
  };
  var CredentialsContainer = class {
    static {
      __name(this, "CredentialsContainer");
    }
    create(options) {
      if (!options || !options.publicKey) {
        return Promise.reject(namedError("publicKey option required", "NotSupportedError"));
      }
      const pk = options.publicKey;
      let req;
      try {
        abortIfNeeded(options.signal);
        req = {
          rp: { id: pk.rp && pk.rp.id || "", name: pk.rp && pk.rp.name || "" },
          user: {
            id: bytesToB64Url(pk.user && pk.user.id),
            name: pk.user && pk.user.name || "",
            displayName: pk.user && pk.user.displayName || ""
          },
          challenge: bytesToB64Url(pk.challenge),
          pubKeyCredParams: (pk.pubKeyCredParams || []).map((p) => ({ type: p.type, alg: p.alg | 0 })),
          excludeCredentials: (pk.excludeCredentials || []).map((c) => ({
            type: c.type,
            id: bytesToB64Url(c.id)
          })),
          authenticatorSelection: pk.authenticatorSelection || {},
          attestation: pk.attestation || "none",
          origin: globalThis.location && globalThis.location.origin || ""
        };
      } catch (e) {
        return Promise.reject(e);
      }
      const result = globalThis.__csimWebauthnCreate(JSON.stringify(req));
      const err = parseHostError(result);
      if (err) return Promise.reject(err);
      return Promise.resolve(new PublicKeyCredential({
        id: result.credentialId,
        rawId: b64ToBuffer(result.credentialId),
        response: new AuthenticatorAttestationResponse(
          b64ToBuffer(result.clientDataJSON),
          b64ToBuffer(result.attestationObject)
        ),
        type: "public-key"
      }));
    }
    get(options) {
      if (!options || !options.publicKey) {
        return Promise.reject(namedError("publicKey option required", "NotSupportedError"));
      }
      const pk = options.publicKey;
      let req;
      try {
        abortIfNeeded(options.signal);
        req = {
          rpId: pk.rpId || globalThis.location && globalThis.location.hostname || "",
          challenge: bytesToB64Url(pk.challenge),
          allowCredentials: (pk.allowCredentials || []).map((c) => ({
            type: c.type,
            id: bytesToB64Url(c.id)
          })),
          userVerification: pk.userVerification || "preferred",
          origin: globalThis.location && globalThis.location.origin || ""
        };
      } catch (e) {
        return Promise.reject(e);
      }
      const result = globalThis.__csimWebauthnGet(JSON.stringify(req));
      const err = parseHostError(result);
      if (err) return Promise.reject(err);
      return Promise.resolve(new PublicKeyCredential({
        id: result.credentialId,
        rawId: b64ToBuffer(result.credentialId),
        response: new AuthenticatorAssertionResponse(
          b64ToBuffer(result.clientDataJSON),
          b64ToBuffer(result.authenticatorData),
          b64ToBuffer(result.signature),
          result.userHandle ? b64ToBuffer(result.userHandle) : null
        ),
        type: "public-key"
      }));
    }
    store() {
      return Promise.resolve();
    }
    preventSilentAccess() {
      return Promise.resolve();
    }
  };
  globalThis.PublicKeyCredential = PublicKeyCredential;
  globalThis.AuthenticatorAttestationResponse = AuthenticatorAttestationResponse;
  globalThis.AuthenticatorAssertionResponse = AuthenticatorAssertionResponse;
  globalThis.AuthenticatorResponse = AuthenticatorResponse;
  if (globalThis.navigator) {
    globalThis.navigator.credentials = new CredentialsContainer();
  }

  // lib/capybara/simulated/js/src/platform-globals.js
  var VIEWPORT_W = 1024;
  var VIEWPORT_H = 768;
  function bytesFromBuffer(src) {
    if (!src) return [];
    if (Array.isArray(src)) return src;
    if (typeof src.byteLength === "number") {
      const view = src.buffer instanceof ArrayBuffer ? new Uint8Array(src.buffer, src.byteOffset || 0, src.byteLength) : new Uint8Array(src);
      const out = new Array(view.length);
      for (let i = 0; i < view.length; i++) out[i] = view[i];
      return out;
    }
    return [];
  }
  __name(bytesFromBuffer, "bytesFromBuffer");
  globalThis.crypto = {
    randomUUID() {
      return typeof globalThis.__csim_randomUUID === "function" ? String(globalThis.__csim_randomUUID()) : "00000000-0000-0000-0000-000000000000";
    },
    getRandomValues(typedArray) {
      if (!typedArray || typeof typedArray.length !== "number") return typedArray;
      const bytes = typeof globalThis.__csim_randomBytes === "function" ? globalThis.__csim_randomBytes(typedArray.length) : new Array(typedArray.length).fill(0);
      const arr = bytes || [];
      for (let i = 0; i < typedArray.length; i++) {
        typedArray[i] = (arr[i] | 0) & 255;
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
        if (typeof fn !== "function") return Promise.reject(new Error("SubtleCrypto.digest unavailable"));
        const bytes = bytesFromBuffer(data);
        try {
          const out = fn(String(algo || ""), bytes);
          const arr = Array.isArray(out) ? out : [];
          const buf = new ArrayBuffer(arr.length);
          const view = new Uint8Array(buf);
          for (let i = 0; i < arr.length; i++) view[i] = arr[i] & 255;
          return Promise.resolve(buf);
        } catch (e) {
          return Promise.reject(e);
        }
      },
      generateKey() {
        return Promise.reject(notSupported("generateKey"));
      },
      sign() {
        return Promise.reject(notSupported("sign"));
      },
      verify() {
        return Promise.reject(notSupported("verify"));
      },
      encrypt() {
        return Promise.reject(notSupported("encrypt"));
      },
      decrypt() {
        return Promise.reject(notSupported("decrypt"));
      },
      importKey() {
        return Promise.reject(notSupported("importKey"));
      },
      exportKey() {
        return Promise.reject(notSupported("exportKey"));
      },
      deriveBits() {
        return Promise.reject(notSupported("deriveBits"));
      },
      deriveKey() {
        return Promise.reject(notSupported("deriveKey"));
      },
      wrapKey() {
        return Promise.reject(notSupported("wrapKey"));
      },
      unwrapKey() {
        return Promise.reject(notSupported("unwrapKey"));
      }
    }
  };
  function notSupported(name) {
    const e = new Error("SubtleCrypto." + name + " is not implemented");
    e.name = "NotSupportedError";
    return e;
  }
  __name(notSupported, "notSupported");
  globalThis.isSecureContext = true;
  globalThis.devicePixelRatio = 1;
  globalThis.screen = {
    width: VIEWPORT_W,
    height: VIEWPORT_H,
    availWidth: VIEWPORT_W,
    availHeight: VIEWPORT_H,
    colorDepth: 24,
    pixelDepth: 24,
    orientation: { angle: 0, type: "landscape-primary" }
  };
  globalThis.self = globalThis;
  globalThis.top = globalThis;
  globalThis.parent = globalThis;
  globalThis.frameElement = null;
  globalThis.frames = new Proxy(globalThis, {
    get(target, prop) {
      if (typeof prop === "string" && /^[0-9]+$/.test(prop)) {
        const el = globalThis.document.querySelectorAll("iframe, frame")[Number(prop)];
        return el ? el.contentWindow : void 0;
      }
      if (prop === "length") return globalThis.document.querySelectorAll("iframe, frame").length;
      return Reflect.get(target, prop, globalThis);
    }
  });
  function __docScrollLeft() {
    const root = globalThis.document && globalThis.document.documentElement;
    return root ? root._scrollLeft || 0 : 0;
  }
  __name(__docScrollLeft, "__docScrollLeft");
  function __docScrollTop() {
    const root = globalThis.document && globalThis.document.documentElement;
    return root ? root._scrollTop || 0 : 0;
  }
  __name(__docScrollTop, "__docScrollTop");
  Object.defineProperty(globalThis, "scrollX", { get: __docScrollLeft });
  Object.defineProperty(globalThis, "scrollY", { get: __docScrollTop });
  Object.defineProperty(globalThis, "pageXOffset", { get: __docScrollLeft });
  Object.defineProperty(globalThis, "pageYOffset", { get: __docScrollTop });
  globalThis.innerWidth = VIEWPORT_W;
  globalThis.innerHeight = VIEWPORT_H;
  globalThis.outerWidth = VIEWPORT_W;
  globalThis.outerHeight = VIEWPORT_H;
  globalThis.visualViewport = {
    get offsetLeft() {
      return 0;
    },
    get offsetTop() {
      return 0;
    },
    get pageLeft() {
      return globalThis.scrollX;
    },
    get pageTop() {
      return globalThis.scrollY;
    },
    get width() {
      return globalThis.innerWidth;
    },
    get height() {
      return globalThis.innerHeight;
    },
    get scale() {
      return 1;
    },
    onresize: null,
    onscroll: null,
    addEventListener() {
    },
    removeEventListener() {
    },
    dispatchEvent() {
      return true;
    }
  };
  function __windowScrollDelegate(method, args) {
    const root = globalThis.document && globalThis.document.documentElement;
    if (root && typeof root[method] === "function") root[method].apply(root, args);
  }
  __name(__windowScrollDelegate, "__windowScrollDelegate");
  globalThis.scrollTo = function() {
    __windowScrollDelegate("scrollTo", arguments);
  };
  globalThis.scrollBy = function() {
    __windowScrollDelegate("scrollBy", arguments);
  };
  globalThis.scroll = globalThis.scrollTo;
  globalThis.CSS = {
    escape(value) {
      if (arguments.length === 0) throw new TypeError("CSS.escape requires an argument.");
      const s = String(value);
      const len = s.length;
      const first = s.charCodeAt(0);
      if (len === 1 && first === 45) return "\\-";
      let out = "";
      for (let i = 0; i < len; i++) {
        const c = s.charCodeAt(i);
        if (c === 0) {
          out += "\uFFFD";
          continue;
        }
        if (c >= 1 && c <= 31 || c === 127 || i === 0 && c >= 48 && c <= 57 || i === 1 && c >= 48 && c <= 57 && first === 45) {
          out += "\\" + c.toString(16) + " ";
          continue;
        }
        if (c >= 128 || c === 45 || c === 95 || c >= 48 && c <= 57 || c >= 65 && c <= 90 || c >= 97 && c <= 122) {
          out += s.charAt(i);
          continue;
        }
        out += "\\" + s.charAt(i);
      }
      return out;
    },
    supports() {
      return true;
    }
  };
  var perfStart = Date.now();
  var _perfEntries = [];
  function recordEntry(entry) {
    _perfEntries.push(entry);
    if (typeof globalThis.__csimDeliverPerfEntry === "function") globalThis.__csimDeliverPerfEntry(entry);
  }
  __name(recordEntry, "recordEntry");
  globalThis.performance = {
    now() {
      return Date.now() - perfStart;
    },
    timeOrigin: perfStart,
    timing: { navigationStart: perfStart },
    mark(name, options) {
      const entry = {
        name: String(name),
        entryType: "mark",
        startTime: options && options.startTime != null ? options.startTime : Date.now() - perfStart,
        duration: 0,
        detail: options ? options.detail : null
      };
      recordEntry(entry);
      return entry;
    },
    measure(name, startOrOptions, endMark) {
      let startTime = 0, duration = 0, detail = null;
      if (typeof startOrOptions === "object" && startOrOptions !== null) {
        startTime = startOrOptions.start != null ? startOrOptions.start : 0;
        duration = startOrOptions.duration != null ? startOrOptions.duration : startOrOptions.end != null ? startOrOptions.end - startTime : 0;
        detail = startOrOptions.detail || null;
      } else if (typeof startOrOptions === "string") {
        const startEntry = _perfEntries.find((e) => e.entryType === "mark" && e.name === startOrOptions);
        startTime = startEntry ? startEntry.startTime : 0;
        if (endMark != null) {
          const endEntry = _perfEntries.find((e) => e.entryType === "mark" && e.name === endMark);
          duration = (endEntry ? endEntry.startTime : Date.now() - perfStart) - startTime;
        } else {
          duration = Date.now() - perfStart - startTime;
        }
      }
      const entry = { name: String(name), entryType: "measure", startTime, duration, detail };
      recordEntry(entry);
      return entry;
    },
    getEntries() {
      return _perfEntries.slice();
    },
    getEntriesByName(name, type) {
      return _perfEntries.filter((e) => e.name === name && (!type || e.entryType === type));
    },
    getEntriesByType(type) {
      return _perfEntries.filter((e) => e.entryType === type);
    },
    clearMarks(name) {
      for (let i = _perfEntries.length - 1; i >= 0; i--) {
        if (_perfEntries[i].entryType !== "mark") continue;
        if (name != null && _perfEntries[i].name !== name) continue;
        _perfEntries.splice(i, 1);
      }
    },
    clearMeasures(name) {
      for (let i = _perfEntries.length - 1; i >= 0; i--) {
        if (_perfEntries[i].entryType !== "measure") continue;
        if (name != null && _perfEntries[i].name !== name) continue;
        _perfEntries.splice(i, 1);
      }
    }
  };
  var DOMPointReadOnly = class _DOMPointReadOnly {
    static {
      __name(this, "DOMPointReadOnly");
    }
    constructor(x = 0, y = 0, z = 0, w = 1) {
      this.x = +x || 0;
      this.y = +y || 0;
      this.z = +z || 0;
      this.w = +w === 0 ? 0 : +w || 1;
    }
    static fromPoint(p) {
      return new _DOMPointReadOnly(p && p.x, p && p.y, p && p.z, p && p.w);
    }
    toJSON() {
      return { x: this.x, y: this.y, z: this.z, w: this.w };
    }
  };
  var DOMPoint = class _DOMPoint extends DOMPointReadOnly {
    static {
      __name(this, "DOMPoint");
    }
    static fromPoint(p) {
      return new _DOMPoint(p && p.x, p && p.y, p && p.z, p && p.w);
    }
  };
  var DOMRectReadOnly = class _DOMRectReadOnly {
    static {
      __name(this, "DOMRectReadOnly");
    }
    constructor(x = 0, y = 0, w = 0, h = 0) {
      this.x = +x || 0;
      this.y = +y || 0;
      this.width = +w || 0;
      this.height = +h || 0;
    }
    get top() {
      return this.y;
    }
    get left() {
      return this.x;
    }
    get right() {
      return this.x + this.width;
    }
    get bottom() {
      return this.y + this.height;
    }
    static fromRect(r) {
      return new _DOMRectReadOnly(r && r.x, r && r.y, r && r.width, r && r.height);
    }
    toJSON() {
      return {
        x: this.x,
        y: this.y,
        width: this.width,
        height: this.height,
        top: this.top,
        right: this.right,
        bottom: this.bottom,
        left: this.left
      };
    }
  };
  var DOMRect = class _DOMRect extends DOMRectReadOnly {
    static {
      __name(this, "DOMRect");
    }
    static fromRect(r) {
      return new _DOMRect(r && r.x, r && r.y, r && r.width, r && r.height);
    }
  };
  globalThis.DOMPointReadOnly = DOMPointReadOnly;
  globalThis.DOMPoint = DOMPoint;
  globalThis.DOMRectReadOnly = DOMRectReadOnly;
  globalThis.DOMRect = DOMRect;
  function cloneInto(v, seen) {
    if (v == null || typeof v !== "object") return v;
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
      const out2 = /* @__PURE__ */ new Map();
      seen.set(v, out2);
      for (const [k, val] of v) out2.set(cloneInto(k, seen), cloneInto(val, seen));
      return out2;
    }
    if (v instanceof Set) {
      const out2 = /* @__PURE__ */ new Set();
      seen.set(v, out2);
      for (const x of v) out2.add(cloneInto(x, seen));
      return out2;
    }
    if (v instanceof ArrayBuffer) {
      const copy = new ArrayBuffer(v.byteLength);
      new Uint8Array(copy).set(new Uint8Array(v));
      seen.set(v, copy);
      return copy;
    }
    if (ArrayBuffer.isView && ArrayBuffer.isView(v)) {
      const buf = cloneInto(v.buffer, seen);
      const out2 = new v.constructor(buf, v.byteOffset, v.length);
      seen.set(v, out2);
      return out2;
    }
    if (Array.isArray(v)) {
      const out2 = new Array(v.length);
      seen.set(v, out2);
      for (let i = 0; i < v.length; i++) out2[i] = cloneInto(v[i], seen);
      return out2;
    }
    const out = {};
    seen.set(v, out);
    for (const k of Object.keys(v)) out[k] = cloneInto(v[k], seen);
    return out;
  }
  __name(cloneInto, "cloneInto");
  globalThis.structuredClone = /* @__PURE__ */ __name(function structuredClone(v) {
    return cloneInto(v, /* @__PURE__ */ new Map());
  }, "structuredClone");
  var __csimReportingError = false;
  globalThis.reportError = /* @__PURE__ */ __name(function reportError(e) {
    if (__csimReportingError) {
      try {
        console.error(e && e.stack ? e.stack : String(e));
      } catch (_) {
      }
      return;
    }
    let cancelled = false;
    __csimReportingError = true;
    try {
      if (typeof globalThis.ErrorEvent !== "undefined" && typeof globalThis.dispatchEvent === "function") {
        const ev = new globalThis.ErrorEvent("error", {
          cancelable: true,
          // Duck-type, not `instanceof Error`: a cross-realm Error (reported on the
          // callback's realm via `__csimReportCallbackError`) isn't an instance of
          // THIS realm's Error, but still has a string `message` to surface.
          message: e && typeof e === "object" && typeof e.message === "string" ? e.message : String(e),
          error: e
        });
        cancelled = globalThis.dispatchEvent(ev) === false;
      }
    } catch (_) {
    } finally {
      __csimReportingError = false;
    }
    if (!cancelled) {
      try {
        console.error(e && e.stack ? e.stack : String(e));
      } catch (_) {
      }
    }
  }, "reportError");
  globalThis.__csimReportCallbackError = function(cb, e) {
    try {
      if (typeof cb === "function" && globalThis.RustyRacer && typeof globalThis.RustyRacer.contextOf === "function" && typeof globalThis.RustyRacer.contextGlobal === "function") {
        const id = globalThis.RustyRacer.contextOf(cb);
        if (id != null) {
          const g = globalThis.RustyRacer.contextGlobal(id);
          if (g && g !== globalThis && typeof g.reportError === "function") {
            g.reportError(e);
            return;
          }
        }
      }
    } catch (_) {
    }
    globalThis.reportError(e);
  };
  globalThis.requestIdleCallback = function(cb) {
    return globalThis.setTimeout(() => cb({ didTimeout: false, timeRemaining: /* @__PURE__ */ __name(() => 0, "timeRemaining") }), 0);
  };
  globalThis.cancelIdleCallback = function(id) {
    globalThis.clearTimeout(id);
  };
  var CSSStyleDeclaration = class {
    static {
      __name(this, "CSSStyleDeclaration");
    }
    constructor() {
    }
  };
  var CSSRule = class {
    static {
      __name(this, "CSSRule");
    }
    constructor(selectorText, cssText) {
      this.type = 1;
      this.cssText = cssText || "";
      this.selectorText = selectorText || "";
      this.style = new CSSStyleDeclaration();
      this.parentStyleSheet = null;
    }
  };
  CSSRule.STYLE_RULE = 1;
  CSSRule.CHARSET_RULE = 2;
  CSSRule.IMPORT_RULE = 3;
  CSSRule.MEDIA_RULE = 4;
  CSSRule.FONT_FACE_RULE = 5;
  CSSRule.PAGE_RULE = 6;
  CSSRule.KEYFRAMES_RULE = 7;
  CSSRule.KEYFRAME_RULE = 8;
  var CSSRuleList = class extends Array {
    static {
      __name(this, "CSSRuleList");
    }
    item(i) {
      return this[i] || null;
    }
  };
  var CSSStyleSheet = class {
    static {
      __name(this, "CSSStyleSheet");
    }
    constructor(opts) {
      this.cssRules = new CSSRuleList();
      this.ownerNode = null;
      this.disabled = false;
      this.href = opts && opts.baseURL || null;
      this.media = opts && opts.media || "";
      this.title = "";
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
    deleteRule(index) {
      this.cssRules.splice(index | 0, 1);
    }
    replace(text) {
      this.replaceSync(text);
      return Promise.resolve(this);
    }
    replaceSync(text) {
      this.cssRules.length = 0;
      if (typeof text === "string") {
        for (const chunk of text.split("}")) {
          const piece = chunk.trim();
          if (!piece) continue;
          const open = piece.indexOf("{");
          if (open < 0) continue;
          this.cssRules.push(new CSSRule(piece.slice(0, open).trim(), piece + "}"));
        }
      }
    }
  };
  globalThis.CSSStyleDeclaration = CSSStyleDeclaration;
  globalThis.CSSRule = CSSRule;
  globalThis.CSSRuleList = CSSRuleList;
  globalThis.CSSStyleSheet = CSSStyleSheet;
  var DataTransferItem = class {
    static {
      __name(this, "DataTransferItem");
    }
    constructor(kind, type, value, file) {
      this.kind = kind;
      this.type = String(type || "");
      this._value = value;
      this._file = file || null;
    }
    getAsString(cb) {
      if (this.kind !== "string" || typeof cb !== "function") return;
      Promise.resolve().then(() => {
        try {
          cb(this._value);
        } catch (_) {
        }
      });
    }
    getAsFile() {
      return this.kind === "file" ? this._file : null;
    }
  };
  var DataTransferItemList = class extends Array {
    static {
      __name(this, "DataTransferItemList");
    }
    add(data, type) {
      if (data && data.size != null && data.name) {
        const item = new DataTransferItem("file", data.type || "", null, data);
        this.push(item);
        return item;
      }
      if (typeof data === "string") {
        const item = new DataTransferItem("string", type || "text/plain", data, null);
        this.push(item);
        return item;
      }
      return null;
    }
    clear() {
      this.length = 0;
    }
    remove(i) {
      this.splice(i | 0, 1);
    }
  };
  var DataTransfer = class {
    static {
      __name(this, "DataTransfer");
    }
    constructor() {
      this.items = new DataTransferItemList();
      this.dropEffect = "none";
      this.effectAllowed = "all";
      this.types = [];
    }
    // `files` is the FileList view of the file-kind items — derived so it stays in
    // sync however items were added (`items.add(file)`, drag-drop construction, …).
    get files() {
      const out = [];
      for (const it of this.items) if (it.kind === "file" && it._file) out.push(it._file);
      out.item = function(i) {
        return this[i] || null;
      };
      return out;
    }
    getData(type) {
      for (const it of this.items) if (it.kind === "string" && it.type === type) return it._value;
      return "";
    }
    setData(type, value) {
      this.items.add(String(value), String(type));
      if (!this.types.includes(type)) this.types.push(type);
    }
    clearData(type) {
      if (type) {
        for (let i = this.items.length - 1; i >= 0; i--) {
          if (this.items[i].type === type) this.items.splice(i, 1);
        }
        this.types = this.types.filter((t) => t !== type);
      } else {
        this.items.clear();
        this.types = [];
      }
    }
    setDragImage() {
    }
  };
  globalThis.DataTransfer = DataTransfer;
  globalThis.DataTransferItem = DataTransferItem;
  globalThis.DataTransferItemList = DataTransferItemList;
  var MessagePort = class extends EventTarget {
    static {
      __name(this, "MessagePort");
    }
    constructor() {
      super();
      this._peer = null;
      this.onmessage = null;
      this.onmessageerror = null;
      this._started = false;
    }
    postMessage(data, _transfer) {
      const peer = this._peer;
      if (!peer) return;
      Promise.resolve().then(() => {
        const ev = new MessageEvent("message", { data, ports: [], origin: "", lastEventId: "", source: null });
        ev.target = peer;
        dispatchWithOnHandler(peer, ev);
      });
    }
    addEventListener(type, handler) {
      super.addEventListener(type, handler);
      if (type === "message") this._started = true;
    }
    start() {
      this._started = true;
    }
    close() {
      this._peer = null;
    }
  };
  var MessageChannel = class {
    static {
      __name(this, "MessageChannel");
    }
    constructor() {
      this.port1 = new MessagePort();
      this.port2 = new MessagePort();
      this.port1._peer = this.port2;
      this.port2._peer = this.port1;
    }
  };
  globalThis.MessageChannel = MessageChannel;
  globalThis.MessagePort = MessagePort;
  var _bcChannels = /* @__PURE__ */ new Map();
  var BroadcastChannel = class extends EventTarget {
    static {
      __name(this, "BroadcastChannel");
    }
    constructor(name) {
      super();
      this.name = String(name);
      this.onmessage = null;
      this.onmessageerror = null;
      const set = _bcChannels.get(this.name) || /* @__PURE__ */ new Set();
      set.add(this);
      _bcChannels.set(this.name, set);
    }
    postMessage(data) {
      const set = _bcChannels.get(this.name);
      if (!set) return;
      Promise.resolve().then(() => {
        for (const ch of set) {
          if (ch === this) continue;
          const ev = new MessageEvent("message", { data, origin: "", lastEventId: "", source: null, ports: [] });
          ev.target = ch;
          dispatchWithOnHandler(ch, ev);
        }
      });
    }
    close() {
      const set = _bcChannels.get(this.name);
      if (set) {
        set.delete(this);
        if (set.size === 0) _bcChannels.delete(this.name);
      }
    }
  };
  globalThis.BroadcastChannel = BroadcastChannel;
  globalThis.__csimTransferDropAll = function(tokens) {
    const NS = globalThis.RustyRacer;
    if (!tokens || !NS || typeof NS.transferDrop !== "function") return;
    for (let i = 0; i < tokens.length; i++) NS.transferDrop(tokens[i]);
  };
  var __csimWindowProxies = /* @__PURE__ */ new Map();
  function csimMaybeTransferOut(data, transfer) {
    if (!transfer || !transfer.length) return null;
    const NS = globalThis.RustyRacer;
    if (!NS || typeof NS.transferOut !== "function") return null;
    const isAB = data instanceof ArrayBuffer;
    const isView = !isAB && ArrayBuffer.isView(data);
    if (!isAB && !isView) return null;
    const buf = isAB ? data : data.buffer;
    let inList = false;
    for (let i = 0; i < transfer.length; i++) {
      const t = transfer[i];
      if (t === buf || t && t.buffer === buf) {
        inList = true;
        break;
      }
    }
    if (!inList) return null;
    const token = NS.transferOut(data) | 0;
    if (token <= 0) return null;
    if (globalThis.__csim_transferIssued) globalThis.__csim_transferIssued(token);
    return isAB ? { __csimXfer: token, kind: "ArrayBuffer" } : {
      __csimXfer: token,
      kind: data.constructor && data.constructor.name || "Uint8Array",
      byteOffset: data.byteOffset,
      length: data.length
    };
  }
  __name(csimMaybeTransferOut, "csimMaybeTransferOut");
  function csimMaybeTransferIn(data) {
    if (!data || typeof data !== "object" || data.__csimXfer == null) return data;
    const NS = globalThis.RustyRacer;
    if (!NS || typeof NS.transferIn !== "function") return data;
    const ab = NS.transferIn(data.__csimXfer);
    if (!ab) return new ArrayBuffer(0);
    if (data.kind === "ArrayBuffer") return ab;
    const Ctor = globalThis[data.kind] || globalThis.Uint8Array;
    try {
      return new Ctor(ab, data.byteOffset || 0, data.length);
    } catch (_) {
      return new Uint8Array(ab);
    }
  }
  __name(csimMaybeTransferIn, "csimMaybeTransferIn");
  function csimWindowProxy(handle) {
    if (handle == null || handle === "") return null;
    let proxy = __csimWindowProxies.get(handle);
    if (proxy) return proxy;
    const location = {
      get href() {
        return globalThis.__csimWindowLocation(handle);
      },
      set href(v) {
        globalThis.__csimWindowSetLocation(handle, String(v));
      },
      assign(v) {
        globalThis.__csimWindowSetLocation(handle, String(v));
      },
      replace(v) {
        globalThis.__csimWindowSetLocation(handle, String(v));
      },
      toString() {
        return globalThis.__csimWindowLocation(handle);
      }
    };
    proxy = {
      get closed() {
        return !!globalThis.__csimWindowClosed(handle);
      },
      close() {
        globalThis.__csimWindowClose(handle);
      },
      focus() {
      },
      blur() {
      },
      // Cross-window postMessage. The data round-trips JS→Ruby→JS through the
      // host marshaller rather than a true structured-clone: plain
      // primitives/arrays/objects survive, but `undefined`→null, functions /
      // symbols drop (no DataCloneError is thrown), and prototypes/identity are
      // lost — fine for the JSON-ish payloads postMessage carries in practice.
      // `targetOrigin` is accepted but, like the single-origin model elsewhere,
      // not enforced.
      postMessage(data, targetOrigin, transfer) {
        const xfer = csimMaybeTransferOut(data, transfer);
        globalThis.__csimWindowPostMessage(handle, xfer || data, String(targetOrigin == null ? "*" : targetOrigin));
        detachTransferables(transfer);
      },
      get location() {
        return location;
      },
      set location(v) {
        location.href = v;
      },
      get window() {
        return proxy;
      },
      get self() {
        return proxy;
      },
      get __csimWindowHandle() {
        return handle;
      }
    };
    __csimWindowProxies.set(handle, proxy);
    return proxy;
  }
  __name(csimWindowProxy, "csimWindowProxy");
  globalThis.open = function(url, name, _features) {
    const fn = globalThis.__csimWindowOpen;
    if (typeof fn !== "function") return null;
    const handle = fn(url == null ? "" : String(url), name == null ? "" : String(name));
    return handle ? csimWindowProxy(handle) : null;
  };
  var __csimOpenerOverride;
  Object.defineProperty(globalThis, "opener", {
    configurable: true,
    get() {
      if (__csimOpenerOverride !== void 0) return __csimOpenerOverride;
      const fn = globalThis.__csimWindowOpener;
      const handle = typeof fn === "function" ? fn() : null;
      return handle ? csimWindowProxy(handle) : null;
    },
    set(v) {
      __csimOpenerOverride = v;
    }
  });
  globalThis.__csim_deliverWindowMessages = function(events) {
    if (!events || !events.length) return;
    for (const ev of events) {
      const source = ev && ev.sourceHandle ? csimWindowProxy(ev.sourceHandle) : null;
      dispatchWithOnHandler(globalThis, new MessageEvent("message", {
        data: csimMaybeTransferIn(ev ? ev.data : void 0),
        origin: ev && ev.origin || "",
        source,
        lastEventId: "",
        ports: []
      }));
    }
  };
  globalThis.NodeFilter = {
    SHOW_ALL: 4294967295,
    SHOW_ELEMENT: 1,
    SHOW_ATTRIBUTE: 2,
    SHOW_TEXT: 4,
    SHOW_CDATA_SECTION: 8,
    SHOW_ENTITY_REFERENCE: 16,
    // legacy node types (unmodelled) — values per spec
    SHOW_ENTITY: 32,
    // legacy
    SHOW_PROCESSING_INSTRUCTION: 64,
    SHOW_COMMENT: 128,
    SHOW_DOCUMENT: 256,
    SHOW_DOCUMENT_TYPE: 512,
    SHOW_DOCUMENT_FRAGMENT: 1024,
    SHOW_NOTATION: 2048,
    // legacy
    FILTER_ACCEPT: 1,
    FILTER_REJECT: 2,
    FILTER_SKIP: 3
  };

  // lib/capybara/simulated/js/src/selection.js
  function notifySelectionChange() {
    const doc = globalThis.document;
    if (!doc) return;
    try {
      dispatchEvent(doc, new Event("selectionchange", { bubbles: false, cancelable: false }));
    } catch (_) {
    }
  }
  __name(notifySelectionChange, "notifySelectionChange");
  var Selection = class {
    static {
      __name(this, "Selection");
    }
    constructor() {
      this._ranges = [];
      this._direction = "none";
    }
    get rangeCount() {
      return this._ranges.length;
    }
    get direction() {
      return this._direction;
    }
    get isCollapsed() {
      if (!this._ranges.length) return true;
      return this._ranges[0].collapsed;
    }
    get anchorNode() {
      return this._ranges.length ? this._ranges[0].startContainer : null;
    }
    get focusNode() {
      return this._ranges.length ? this._ranges[0].endContainer : null;
    }
    get anchorOffset() {
      return this._ranges.length ? this._ranges[0].startOffset : 0;
    }
    get focusOffset() {
      return this._ranges.length ? this._ranges[0].endOffset : 0;
    }
    get type() {
      return this._ranges.length ? this.isCollapsed ? "Caret" : "Range" : "None";
    }
    toString() {
      if (!this._ranges.length) return "";
      const frag = cloneRangeContents(this._ranges[0]);
      return frag.textContent || "";
    }
    getRangeAt(i) {
      return this._ranges[i] || null;
    }
    addRange(r) {
      this._ranges = [r];
      notifySelectionChange();
    }
    removeRange(r) {
      const i = this._ranges.indexOf(r);
      if (i >= 0) {
        this._ranges.splice(i, 1);
        notifySelectionChange();
      }
    }
    removeAllRanges() {
      if (this._ranges.length) {
        this._ranges.length = 0;
        notifySelectionChange();
      }
    }
    empty() {
      this.removeAllRanges();
    }
    // Per spec: `collapse(node, offset)` clears ranges and inserts a
    // single collapsed range at (node, offset). PM's editor uses this
    // (via `Selection.collapse(domNode, offset)`) to drive its cursor
    // position; rich-text libraries that drive their own focus call
    // it from selectionchange handlers.
    collapse(node, offset) {
      if (node == null) {
        this.removeAllRanges();
        return;
      }
      const r = new DocumentOrderRange();
      r.setStart(node, offset || 0);
      r.setEnd(node, offset || 0);
      this._ranges = [r];
      notifySelectionChange();
    }
    collapseToStart() {
      if (!this._ranges.length) throw new Error("InvalidStateError: no range");
      const r = this._ranges[0];
      r.endContainer = r.startContainer;
      r.endOffset = r.startOffset;
      notifySelectionChange();
    }
    collapseToEnd() {
      if (!this._ranges.length) throw new Error("InvalidStateError: no range");
      const r = this._ranges[0];
      r.startContainer = r.endContainer;
      r.startOffset = r.endOffset;
      notifySelectionChange();
    }
    selectAllChildren(node) {
      if (!node) return;
      const r = new DocumentOrderRange();
      r.setStart(node, 0);
      const count = node._children ? node._children.length : 0;
      r.setEnd(node, count);
      this._ranges = [r];
      notifySelectionChange();
    }
    // Spec: extend the current range's focus to (node, offset). Anchor
    // stays; focus moves. We don't track direction separately, so just
    // update end to the new focus point. PM uses this to expand a
    // selection from a known anchor.
    extend(node, offset) {
      if (!this._ranges.length) throw new Error("InvalidStateError: no range");
      const r = this._ranges[0];
      r.endContainer = node;
      r.endOffset = offset | 0;
      notifySelectionChange();
    }
    setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset) {
      const r = new DocumentOrderRange();
      r.setStart(anchorNode, anchorOffset | 0);
      r.setEnd(focusNode, focusOffset | 0);
      this._ranges = [r];
      notifySelectionChange();
    }
    setPosition(node, offset) {
      this.collapse(node, offset);
    }
    // True if `node` is contained (fully if `partial` is false, or
    // even partially if `partial` is true) within any range of the
    // selection. quote-reply gates `isSelected` on this for the
    // "selection partially covers target element" check before
    // walking the range.
    containsNode(node, partial) {
      for (const r of this._ranges) {
        if (rangeIntersectsNode(r, node)) {
          if (partial) return true;
          if (nodeContains(r.startContainer, node) === false && nodeContains(r.endContainer, node) === false && nodeContains(node, r.startContainer) === true && nodeContains(node, r.endContainer) === true) {
            return true;
          }
        }
      }
      return false;
    }
    deleteFromDocument() {
    }
    // CSS Editing module: modify(alter, direction, granularity). We
    // don't model layout-aware motion (word/line), but spec-correct
    // single-character / per-element motion through the selection is
    // enough for Tiptap/ProseMirror's keyboard navigation polyfill.
    // `alter`: "move" (anchor follows) | "extend" (anchor stays)
    // `direction`: "forward" | "backward" | "left" | "right"
    // `granularity`: "character" | "word" | "line" | "lineboundary" | etc.
    modify(alter, direction, _granularity) {
      if (!this._ranges.length) return;
      const r = this._ranges[0];
      const forward = direction === "forward" || direction === "right";
      const focusContainer = r.endContainer;
      if (focusContainer && focusContainer.nodeType === 3) {
        const len = (focusContainer.data || "").length;
        const next = forward ? Math.min(len, r.endOffset + 1) : Math.max(0, r.endOffset - 1);
        r.endOffset = next;
        if (alter === "move") {
          r.startContainer = focusContainer;
          r.startOffset = next;
          this._direction = "none";
        } else {
          this._direction = forward ? "forward" : "backward";
        }
        notifySelectionChange();
      }
    }
  };
  var sharedSelection = new Selection();
  globalThis.Selection = Selection;
  globalThis.getSelection = function() {
    return sharedSelection;
  };
  globalThis.__notifySelectionChange = notifySelectionChange;

  // lib/capybara/simulated/js/src/tz-override.js
  var targetTZ = null;
  globalThis.__csimSetTimezone = function(tz) {
    targetTZ = typeof tz === "string" && tz.length > 0 ? tz : null;
  };
  var OrigDTF = Intl.DateTimeFormat;
  function PatchedDTF(locales, options) {
    if (!(this instanceof PatchedDTF)) return new PatchedDTF(locales, options);
    if (!targetTZ || options && options.timeZone) return new OrigDTF(locales, options);
    return new OrigDTF(locales, Object.assign({}, options, { timeZone: targetTZ }));
  }
  __name(PatchedDTF, "PatchedDTF");
  PatchedDTF.prototype = OrigDTF.prototype;
  PatchedDTF.supportedLocalesOf = function(l, o) {
    return OrigDTF.supportedLocalesOf(l, o);
  };
  Intl.DateTimeFormat = PatchedDTF;

  // lib/capybara/simulated/js/src/unhandled-rejection.js
  var LOGGED = "__csimRejectionLogged";
  function fireUnhandledRejection(promise, reason) {
    const ev = new PromiseRejectionEvent("unhandledrejection", {
      promise,
      reason,
      cancelable: true
    });
    try {
      globalThis.dispatchEvent(ev);
    } catch (_) {
    }
    try {
      const handler = globalThis.onunhandledrejection;
      if (typeof handler === "function" && !ev.defaultPrevented) handler.call(globalThis, ev);
    } catch (_) {
    }
    return !!ev.defaultPrevented;
  }
  __name(fireUnhandledRejection, "fireUnhandledRejection");
  function logErr(err, kind, promise) {
    if (err == null) return;
    if (typeof err === "object") {
      if (err[LOGGED]) return;
      err[LOGGED] = true;
    }
    const prevented = fireUnhandledRejection(promise || null, err);
    if (prevented) return;
    try {
      const ctor = err.constructor && err.constructor.name;
      const msg = err.message ? (ctor ? ctor + ": " : "") + err.message : String(err);
      const stk = err.stack ? "\n" + err.stack.slice(0, 600) : "";
      console.error("unhandled rejection (" + kind + "):", msg, stk);
    } catch (_) {
    }
  }
  __name(logErr, "logErr");
  globalThis.__csimLogUnhandledRejection = function(reason, promise) {
    try {
      logErr(reason, "unhandled", promise);
    } catch (_) {
    }
  };
  var pendingRejections = /* @__PURE__ */ new Map();
  var rejectionFlushQueued = false;
  function flushRejections() {
    rejectionFlushQueued = false;
    const entries = [...pendingRejections.entries()];
    pendingRejections.clear();
    for (const [promise, rec] of entries) {
      let log = globalThis.__csimLogUnhandledRejection;
      try {
        const NS = globalThis.RustyRacer;
        if (NS && rec.contextId != null && typeof NS.contextGlobal === "function") {
          const g = NS.contextGlobal(rec.contextId);
          if (g && typeof g.__csimLogUnhandledRejection === "function") {
            log = g.__csimLogUnhandledRejection;
          }
        }
      } catch (_) {
      }
      try {
        log(rec.reason, promise);
      } catch (_) {
      }
    }
  }
  __name(flushRejections, "flushRejections");
  globalThis.__csimPromiseRejected = function(event, contextId, promise, reason) {
    if (event === 0) {
      pendingRejections.set(promise, { contextId, reason });
      if (!rejectionFlushQueued) {
        rejectionFlushQueued = true;
        origThen.call(Promise.resolve(), flushRejections);
      }
    } else if (event === 1) {
      pendingRejections.delete(promise);
    }
  };
  var origThen = Promise.prototype.then;
  var alreadyWrapped = /* @__PURE__ */ new WeakSet();
  function propagateAndLog(self) {
    return function(err) {
      logErr(err, "propagated", self);
      throw err;
    };
  }
  __name(propagateAndLog, "propagateAndLog");
  function wrapOnF(self, onF) {
    if (typeof onF !== "function") return onF;
    return function(v) {
      try {
        return onF.call(this, v);
      } catch (e) {
        logErr(e, "onF threw", self);
        throw e;
      }
    };
  }
  __name(wrapOnF, "wrapOnF");
  Promise.prototype.then = function(onF, onR) {
    if (typeof onR === "function") return origThen.call(this, onF, onR);
    if (alreadyWrapped.has(this)) return origThen.call(this, onF);
    const next = origThen.call(this, wrapOnF(this, onF), propagateAndLog(this));
    alreadyWrapped.add(next);
    return next;
  };

  // lib/capybara/simulated/js/src/url.js
  var USM2 = globalThis.__csimVendor && globalThis.__csimVendor.urlEngine;
  function formEncode(s) {
    return encodeURIComponent(s).replace(/%20/g, "+").replace(/[!'()~]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  }
  __name(formEncode, "formEncode");
  function toUSV(s) {
    s = String(s);
    let out = "";
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c >= 55296 && c <= 56319) {
        const n = s.charCodeAt(i + 1);
        if (n >= 56320 && n <= 57343) {
          out += s[i] + s[i + 1];
          i++;
        } else out += "\uFFFD";
      } else if (c >= 56320 && c <= 57343) {
        out += "\uFFFD";
      } else {
        out += s[i];
      }
    }
    return out;
  }
  __name(toUSV, "toUSV");
  var HEX = /[0-9A-Fa-f]/;
  function formDecode(s) {
    const bytes = [];
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === "+") {
        bytes.push(32);
      } else if (c === "%" && HEX.test(s[i + 1] || "") && HEX.test(s[i + 2] || "")) {
        bytes.push(parseInt(s[i + 1] + s[i + 2], 16));
        i += 2;
      } else {
        let cp = s.codePointAt(i);
        if (cp > 65535) i++;
        if (cp < 128) bytes.push(cp);
        else if (cp < 2048) bytes.push(192 | cp >> 6, 128 | cp & 63);
        else if (cp < 65536) bytes.push(224 | cp >> 12, 128 | cp >> 6 & 63, 128 | cp & 63);
        else bytes.push(240 | cp >> 18, 128 | cp >> 12 & 63, 128 | cp >> 6 & 63, 128 | cp & 63);
      }
    }
    return new globalThis.TextDecoder("utf-8", { ignoreBOM: true }).decode(new Uint8Array(bytes));
  }
  __name(formDecode, "formDecode");
  var URL2 = class _URL {
    static {
      __name(this, "URL");
    }
    constructor(input, base) {
      let baseRec = null;
      if (base !== void 0 && base !== null) {
        baseRec = USM2.basicURLParse(String(base));
        if (baseRec === null) throw new TypeError("Invalid base URL: " + base);
      }
      const rec = USM2.basicURLParse(String(input), { baseURL: baseRec || void 0 });
      if (rec === null) throw new TypeError("Invalid URL: " + input);
      this._rec = rec;
      this._searchParams = new URLSearchParams(rec.query == null ? "" : rec.query, this);
    }
    // `searchParams` is a readonly attribute (getter only), so assigning to it
    // throws in strict mode — the same live object is returned every read.
    get searchParams() {
      return this._searchParams;
    }
    get href() {
      return USM2.serializeURL(this._rec);
    }
    set href(v) {
      const rec = USM2.basicURLParse(String(v));
      if (rec === null) throw new TypeError("Invalid URL: " + v);
      this._rec = rec;
      this._searchParams._reset(rec.query == null ? "" : rec.query);
    }
    get origin() {
      return USM2.serializeURLOrigin(this._rec);
    }
    get protocol() {
      return this._rec.scheme + ":";
    }
    set protocol(v) {
      USM2.basicURLParse(String(v) + ":", { url: this._rec, stateOverride: "scheme start" });
    }
    get username() {
      return this._rec.username;
    }
    set username(v) {
      if (!USM2.cannotHaveAUsernamePasswordPort(this._rec)) USM2.setTheUsername(this._rec, String(v));
    }
    get password() {
      return this._rec.password;
    }
    set password(v) {
      if (!USM2.cannotHaveAUsernamePasswordPort(this._rec)) USM2.setThePassword(this._rec, String(v));
    }
    get host() {
      const u = this._rec;
      if (u.host === null) return "";
      return u.port === null ? USM2.serializeHost(u.host) : USM2.serializeHost(u.host) + ":" + USM2.serializeInteger(u.port);
    }
    set host(v) {
      if (!USM2.hasAnOpaquePath(this._rec)) USM2.basicURLParse(String(v), { url: this._rec, stateOverride: "host" });
    }
    get hostname() {
      return this._rec.host === null ? "" : USM2.serializeHost(this._rec.host);
    }
    set hostname(v) {
      if (!USM2.hasAnOpaquePath(this._rec)) USM2.basicURLParse(String(v), { url: this._rec, stateOverride: "hostname" });
    }
    get port() {
      return this._rec.port === null ? "" : USM2.serializeInteger(this._rec.port);
    }
    set port(v) {
      if (USM2.cannotHaveAUsernamePasswordPort(this._rec)) return;
      if (String(v) === "") this._rec.port = null;
      else USM2.basicURLParse(String(v), { url: this._rec, stateOverride: "port" });
    }
    get pathname() {
      return USM2.serializePath(this._rec);
    }
    set pathname(v) {
      if (USM2.hasAnOpaquePath(this._rec)) return;
      this._rec.path = [];
      USM2.basicURLParse(String(v), { url: this._rec, stateOverride: "path start" });
    }
    get search() {
      const q = this._rec.query;
      return q === null || q === "" ? "" : "?" + q;
    }
    set search(v) {
      const s = String(v);
      if (s === "") {
        this._rec.query = null;
        this._searchParams._reset("");
        return;
      }
      const input = s[0] === "?" ? s.slice(1) : s;
      this._rec.query = "";
      USM2.basicURLParse(input, { url: this._rec, stateOverride: "query" });
      this._searchParams._reset(input);
    }
    get hash() {
      const f = this._rec.fragment;
      return f === null || f === "" ? "" : "#" + f;
    }
    set hash(v) {
      const s = String(v);
      if (s === "") {
        this._rec.fragment = null;
        return;
      }
      const input = s[0] === "#" ? s.slice(1) : s;
      this._rec.fragment = "";
      USM2.basicURLParse(input, { url: this._rec, stateOverride: "fragment" });
    }
    toString() {
      return USM2.serializeURL(this._rec);
    }
    toJSON() {
      return USM2.serializeURL(this._rec);
    }
    // Static helpers — Chromium 120+; WHATWG fetch polyfills probe them.
    static canParse(input, base) {
      try {
        new _URL(input, base);
        return true;
      } catch (_) {
        return false;
      }
    }
    static parse(input, base) {
      try {
        return new _URL(input, base);
      } catch (_) {
        return null;
      }
    }
  };
  var URLSearchParams = class {
    static {
      __name(this, "URLSearchParams");
    }
    // `_url` (internal 2nd arg) links this params object back to the owning URL
    // so mutations propagate to `url.search`/`url.href` — the spec's two-way
    // binding. Public `new URLSearchParams(init)` callers pass no `_url` and stay
    // standalone.
    constructor(init, _url) {
      this._entries = [];
      this._url = _url || null;
      if (init === void 0 || init === null) {
      } else if (typeof init === "string") {
        this._parseQuery(this._url || init.charAt(0) !== "?" ? init : init.slice(1));
      } else if (typeof init[Symbol.iterator] === "function") {
        for (const pair of init) {
          if (pair == null || typeof pair[Symbol.iterator] !== "function") {
            throw new TypeError("Failed to construct 'URLSearchParams': parameter 1 sequence's element is not iterable.");
          }
          const p = [...pair];
          if (p.length !== 2) {
            throw new TypeError("Failed to construct 'URLSearchParams': each pair must have exactly two elements.");
          }
          this._entries.push([toUSV(p[0]), toUSV(p[1])]);
        }
      } else if (typeof init === "object" || typeof init === "function") {
        const m = /* @__PURE__ */ new Map();
        for (const k of Object.keys(init)) m.set(toUSV(k), toUSV(init[k]));
        for (const [k, v] of m) this._entries.push([k, v]);
      }
    }
    // Parse a query string (already past any leading '?') into entries (`+`→space,
    // then percent-decode). The leading-'?' strip is the caller's responsibility:
    // only the public string constructor does it (see the constructor), since the
    // URL-bound path is fed the query component verbatim.
    _parseQuery(str) {
      const s = str;
      if (!s.length) return;
      for (const pair of s.split("&")) {
        if (pair === "") continue;
        const idx = pair.indexOf("=");
        const k = idx >= 0 ? pair.slice(0, idx) : pair;
        const v = idx >= 0 ? pair.slice(idx + 1) : "";
        this._entries.push([formDecode(k), formDecode(v)]);
      }
    }
    // Reload entries from a query string IN PLACE (keeps object identity + the
    // `_url` link) — the URL's `search`/`href` setters call this so a retained
    // `url.searchParams` reference stays the same live object, per spec.
    _reset(str) {
      this._entries = [];
      this._parseQuery(str || "");
    }
    // Propagate a mutation to the owning URL (if any). Per the spec update
    // steps, an empty serialization sets the URL's query to null — so an emptied
    // params object drops the `?` from href.
    _writeBack() {
      if (!this._url) return;
      const s = this.toString();
      this._url._rec.query = s === "" ? null : s;
    }
    append(k, v) {
      this._entries.push([String(k), String(v)]);
      this._writeBack();
    }
    // `delete`/`has` take an optional second `value` argument (HTML/URL "delete"
    // and "has" with a value): when given, only pairs matching BOTH name and value
    // are targeted. An explicit `undefined` second arg counts as absent (WebIDL
    // optional), so it falls back to name-only matching.
    delete(k, v) {
      const name = String(k);
      this._entries = v === void 0 ? this._entries.filter((e) => e[0] !== name) : this._entries.filter((e) => !(e[0] === name && e[1] === String(v)));
      this._writeBack();
    }
    get(k) {
      for (const e of this._entries) if (e[0] === String(k)) return e[1];
      return null;
    }
    getAll(k) {
      return this._entries.filter((e) => e[0] === String(k)).map((e) => e[1]);
    }
    has(k, v) {
      const name = String(k);
      return v === void 0 ? this._entries.some((e) => e[0] === name) : this._entries.some((e) => e[0] === name && e[1] === String(v));
    }
    // Spec `set`: if a pair with this name exists, set the FIRST such pair's value
    // and drop the rest (preserving the first occurrence's POSITION); otherwise
    // append. delete-then-append would instead move the pair to the end.
    set(k, v) {
      const name = String(k), val = String(v);
      let found = false;
      const out = [];
      for (const e of this._entries) {
        if (e[0] === name) {
          if (!found) {
            out.push([name, val]);
            found = true;
          }
        } else {
          out.push(e);
        }
      }
      if (!found) out.push([name, val]);
      this._entries = out;
      this._writeBack();
    }
    // Spec stable sort by name (key) — used for canonical query strings
    // (cache keys, signed-URL building).
    sort() {
      this._entries.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
      this._writeBack();
    }
    get size() {
      return this._entries.length;
    }
    // Iteration is LIVE: the URLSearchParams iterator and `forEach` re-read the
    // entry list by index each step, so pairs appended or deleted during iteration
    // are observed per spec (e.g. deleting the current/next param mid-loop, or a
    // `url.search =` reset that swaps the backing list). A cached `.values()`
    // iterator over a snapshot array would not see those mutations.
    *_iterate(project) {
      for (let i = 0; i < this._entries.length; i++) {
        const e = this._entries[i];
        yield project(e);
      }
    }
    entries() {
      return this._iterate((e) => [e[0], e[1]]);
    }
    keys() {
      return this._iterate((e) => e[0]);
    }
    values() {
      return this._iterate((e) => e[1]);
    }
    forEach(fn) {
      for (let i = 0; i < this._entries.length; i++) fn(this._entries[i][1], this._entries[i][0], this);
    }
    // application/x-www-form-urlencoded serializer: space→`+`, and percent-encode
    // the chars encodeURIComponent leaves literal but the form serializer does not
    // (`!'()~`). Matches real-browser URLSearchParams.toString().
    toString() {
      return this._entries.map((e) => formEncode(e[0]) + "=" + formEncode(e[1])).join("&");
    }
    [Symbol.iterator]() {
      return this.entries();
    }
  };
  function normHeaderName(k) {
    return String(k).toLowerCase();
  }
  __name(normHeaderName, "normHeaderName");
  var Headers = class _Headers {
    static {
      __name(this, "Headers");
    }
    constructor(init) {
      this._map = /* @__PURE__ */ new Map();
      if (!init) return;
      if (init instanceof _Headers) {
        init.forEach((v, k) => this.append(k, v));
      } else if (Array.isArray(init)) {
        for (const e of init) this.append(e[0], e[1]);
      } else if (typeof init === "object") {
        for (const k of Object.keys(init)) this.append(k, init[k]);
      }
    }
    append(k, v) {
      const key = normHeaderName(k);
      const prev = this._map.get(key);
      this._map.set(key, prev == null ? String(v) : prev + ", " + String(v));
    }
    delete(k) {
      this._map.delete(normHeaderName(k));
    }
    get(k) {
      const v = this._map.get(normHeaderName(k));
      return v == null ? null : v;
    }
    has(k) {
      return this._map.has(normHeaderName(k));
    }
    set(k, v) {
      this._map.set(normHeaderName(k), String(v));
    }
    // Modern (2023) — Set-Cookie is special-cased: the spec keeps each
    // value separately rather than comma-joined. We don't model that
    // separation (the map combine is single-string), but return the
    // joined string split on ", " as a best-effort to apps probing this.
    getSetCookie() {
      const v = this._map.get("set-cookie");
      if (!v) return [];
      return v.split(/,\s+(?=[^=,]+=)/);
    }
    forEach(fn) {
      this._map.forEach((v, k) => fn(v, k, this));
    }
    entries() {
      return this._map.entries();
    }
    keys() {
      return this._map.keys();
    }
    values() {
      return this._map.values();
    }
    [Symbol.iterator]() {
      return this.entries();
    }
  };
  globalThis.URL = URL2;
  globalThis.URLSearchParams = URLSearchParams;
  globalThis.Headers = Headers;

  // lib/capybara/simulated/js/src/xhr.js
  function responseValue(responseType, text, bytes, contentType) {
    switch (responseType) {
      case "arraybuffer":
        return bytesToArrayBuffer(bytes);
      case "blob":
        return new globalThis.Blob([bytes], { type: contentType || "application/octet-stream" });
      case "json":
        try {
          return text ? JSON.parse(text) : null;
        } catch (_) {
          return null;
        }
      default:
        return text;
    }
  }
  __name(responseValue, "responseValue");
  var XMLHttpRequestUpload = class extends EventTarget {
    static {
      __name(this, "XMLHttpRequestUpload");
    }
    constructor() {
      super();
      this.onloadstart = null;
      this.onprogress = null;
      this.onload = null;
      this.onloadend = null;
      this.onerror = null;
      this.onabort = null;
      this.ontimeout = null;
    }
    _fire(type, extra) {
      const evt = new ProgressEvent(type, extra || {});
      dispatchWithOnHandler(this, evt);
    }
  };
  var XMLHttpRequest = class extends EventTarget {
    static {
      __name(this, "XMLHttpRequest");
    }
    static UNSENT = 0;
    static OPENED = 1;
    static HEADERS_RECEIVED = 2;
    static LOADING = 3;
    static DONE = 4;
    constructor() {
      super();
      this.readyState = 0;
      this.status = 0;
      this.statusText = "";
      this.responseText = "";
      this.response = "";
      this.responseType = "";
      this.responseURL = "";
      this.responseXML = null;
      this.timeout = 0;
      this.withCredentials = false;
      this.upload = new XMLHttpRequestUpload();
      this.onreadystatechange = null;
      this.onload = null;
      this.onloadstart = null;
      this.onloadend = null;
      this.onerror = null;
      this.onabort = null;
      this.ontimeout = null;
      this.onprogress = null;
      this._method = "GET";
      this._url = "";
      this._async = true;
      this._headers = {};
      this._respHeaders = {};
      this._aborted = false;
      this._timeoutId = null;
    }
    // Instance copies of the readyState constants so `xhr.DONE` works.
    // Static constants on the class itself (`XMLHttpRequest.DONE`)
    // come from the static fields above.
    get UNSENT() {
      return 0;
    }
    get OPENED() {
      return 1;
    }
    get HEADERS_RECEIVED() {
      return 2;
    }
    get LOADING() {
      return 3;
    }
    get DONE() {
      return 4;
    }
    open(method, url, async) {
      this._method = String(method || "GET").toUpperCase();
      this._url = String(url || "");
      this._async = async !== false;
      this._headers = {};
      this._aborted = false;
      this.status = 0;
      this.statusText = "";
      this.responseText = "";
      this.response = "";
      this.responseURL = "";
      this.responseXML = null;
      this._respHeaders = {};
      this.readyState = 1;
      this._fireReady();
    }
    setRequestHeader(name, value) {
      this._headers[String(name)] = String(value);
    }
    getResponseHeader(name) {
      const v = this._respHeaders[String(name).toLowerCase()];
      return v == null ? null : v;
    }
    getAllResponseHeaders() {
      return Object.entries(this._respHeaders).map(([k, v]) => k + ": " + v).join("\r\n");
    }
    overrideMimeType() {
    }
    abort() {
      this._terminate("abort");
    }
    // Mark the request done with `reason` ('abort' | 'timeout' | 'error')
    // and fan out the corresponding event pair on both the request and
    // the upload object per XHR spec § "request error steps".
    _terminate(reason) {
      if (this._timeoutId != null) {
        try {
          globalThis.clearTimeout(this._timeoutId);
        } catch (_) {
        }
        this._timeoutId = null;
      }
      if (this._asyncFetchHandle && typeof globalThis.__csim_rackFetchAsyncAbort === "function") {
        try {
          globalThis.__csim_rackFetchAsyncAbort(this._asyncFetchHandle);
        } catch (_) {
        }
        if (globalThis.__csim_asyncFetchPending) delete globalThis.__csim_asyncFetchPending[this._asyncFetchHandle];
        this._asyncFetchHandle = 0;
      }
      this._aborted = true;
      this.readyState = 4;
      this.status = 0;
      this._fireReady();
      this._fireEvent(reason);
      this._fireEvent("loadend");
      this.upload._fire(reason);
      this.upload._fire("loadend");
    }
    send(body) {
      const hasBody = body != null;
      const total = hasBody ? this._approxBodyLength(body) : 0;
      const fire = /* @__PURE__ */ __name(() => {
        if (this._aborted) return;
        this.upload._fire("loadstart", { loaded: 0, total, lengthComputable: total > 0 });
        this._doFetch(body, total);
      }, "fire");
      const isWrite = hasBody && (this._method === "POST" || this._method === "PUT" || this._method === "PATCH");
      if (globalThis.__csimSlowUploadActive && isWrite) {
        globalThis.__csimSlowUploadPending.push(fire);
        return;
      }
      if (this._async) {
        globalThis.setTimeout(fire, 0);
      } else {
        fire();
      }
      if (this._async && this.timeout > 0) {
        this._timeoutId = globalThis.setTimeout(() => {
          if (this.readyState === 4 || this._aborted) return;
          this._terminate("timeout");
        }, this.timeout);
      }
    }
    // Approximate body length for upload progress reporting. Real
    // browsers count the on-the-wire bytes; we count the serialised
    // string. FormData / Blob counts come from the serialiser.
    _approxBodyLength(body) {
      if (body == null) return 0;
      if (typeof body === "string") return body.length;
      if (typeof body.size === "number") return body.size;
      if (body instanceof ArrayBuffer) return body.byteLength;
      if (ArrayBuffer.isView && ArrayBuffer.isView(body)) return body.byteLength;
      return 0;
    }
    _doFetch(body, uploadTotal) {
      if (this._aborted) return;
      if (this._timeoutId != null) {
        try {
          globalThis.clearTimeout(this._timeoutId);
        } catch (_) {
        }
        this._timeoutId = null;
      }
      if (uploadTotal != null) {
        const t = uploadTotal | 0;
        this.upload._fire("progress", { loaded: t, total: t, lengthComputable: t > 0 });
        this.upload._fire("load", { loaded: t, total: t, lengthComputable: t > 0 });
        this.upload._fire("loadend", { loaded: t, total: t, lengthComputable: t > 0 });
      }
      if (this._async && this._method === "POST" && typeof this._url === "string" && /\/message-bus\/[^/]+\/poll(?:\?|$)/.test(this._url) && typeof globalThis.__csim_rackFetchAsync === "function") {
        const bodyStr = typeof body === "string" ? body : this._serializeBody(body);
        const headersJson = JSON.stringify(this._headers || {});
        const result = globalThis.__csim_rackFetchAsync(this._method, this._url, bodyStr, headersJson);
        if (result && typeof result === "object") {
          if (typeof result.handle === "number" && result.handle > 0) {
            this._asyncFetchHandle = result.handle;
            if (!globalThis.__csim_asyncFetchPending) globalThis.__csim_asyncFetchPending = {};
            globalThis.__csim_asyncFetchPending[result.handle] = this;
            return;
          }
          this._completeWith(result);
          return;
        }
      }
      if (typeof this._url === "string" && this._url.startsWith("blob:")) {
        const r = resolveBlobBytes(this._url);
        const bytes = r ? r.bytes : "";
        const contentType = r ? r.type : "";
        this.status = r ? 200 : 404;
        this.statusText = r ? "OK" : "Not Found";
        this.responseURL = this._url;
        this.responseText = bytes;
        this.response = responseValue(this.responseType, bytes, bytes, contentType);
        this._respHeaders = r ? { "content-type": contentType } : {};
        this.readyState = 4;
        this._fireReady();
        this._fireEvent(r ? "load" : "error");
        this._fireEvent("loadend");
        return;
      }
      let resp;
      try {
        const bodyStr = this._serializeBody(body);
        resp = globalThis.__rackFetch(this._method, this._url, bodyStr, this._headers, "follow");
      } catch (_) {
        resp = null;
      }
      this._completeWith(resp);
    }
    _completeWith(resp) {
      if (this._aborted) return;
      if (!resp) {
        this.readyState = 4;
        this.status = 0;
        this._fireReady();
        this._fireEvent("error");
        this._fireEvent("loadend");
        return;
      }
      this.status = resp.status || 200;
      this.statusText = resp.statusText || "";
      this.responseURL = resp.url || this._url;
      this.responseText = resp.body == null ? "" : String(resp.body);
      const needsBytes = this.responseType === "arraybuffer" || this.responseType === "blob";
      let bytes = this.responseText;
      if (needsBytes && typeof resp.body_b64 === "string") {
        try {
          bytes = globalThis.atob(resp.body_b64);
        } catch (_) {
        }
      }
      const headers = resp.headers || {};
      const contentType = headers["content-type"] || headers["Content-Type"] || "";
      this.response = responseValue(this.responseType, this.responseText, bytes, contentType);
      const norm = {};
      for (const k of Object.keys(headers)) norm[k.toLowerCase()] = String(headers[k]);
      this._respHeaders = norm;
      this.readyState = 2;
      this._fireReady();
      this.readyState = 3;
      this._fireReady();
      const total = this.responseText.length;
      this._fireEvent("progress", { loaded: total, total, lengthComputable: total > 0 });
      this.readyState = 4;
      this._fireReady();
      this._fireEvent("load");
      this._fireEvent("loadend");
    }
    _serializeBody(body) {
      const { body: out, b64 } = serializeRequestBody(body, this._headers);
      if (b64) this._headers["X-Csim-Body-B64"] = "1";
      return out;
    }
    // `readystatechange` flows through dispatchWithOnHandler too — the
    // `onreadystatechange` IDL slot reads through it once, so we don't
    // double-fire (which used to re-eval Rails-UJS's script response and
    // toggle visibility back to hidden).
    _fireReady() {
      this._fireEvent("readystatechange");
    }
    _fireEvent(type, extra) {
      const evt = extra ? new ProgressEvent(type, extra) : new Event(type);
      dispatchWithOnHandler(this, evt);
    }
  };
  globalThis.XMLHttpRequest = XMLHttpRequest;
  globalThis.__csimSlowUploadPending = [];
  globalThis.__csimDrainSlowUploads = function() {
    const q = globalThis.__csimSlowUploadPending;
    globalThis.__csimSlowUploadPending = [];
    for (const fn of q) fn();
  };
  globalThis.__csim_deliverHijackedFetches = function(responses) {
    if (!responses || !responses.length) return 0;
    const pending = globalThis.__csim_asyncFetchPending || {};
    let delivered = 0;
    for (const r of responses) {
      const handle = r && r.handle | 0;
      const xhr = pending[handle];
      if (!xhr) continue;
      delete pending[handle];
      xhr._asyncFetchHandle = 0;
      xhr._completeWith(r);
      delivered++;
    }
    return delivered;
  };

  // lib/capybara/simulated/js/src/bridge.entry.js
  (function() {
    "use strict";
    globalThis.Event = Event;
    globalThis.DOMException = DOMException2;
    globalThis.CustomEvent = CustomEvent;
    globalThis.MouseEvent = MouseEvent;
    globalThis.KeyboardEvent = KeyboardEvent;
    globalThis.InputEvent = InputEvent;
    globalThis.SubmitEvent = SubmitEvent;
    globalThis.UIEvent = UIEvent;
    globalThis.PointerEvent = PointerEvent;
    globalThis.DragEvent = DragEvent;
    globalThis.FocusEvent = FocusEvent;
    globalThis.WheelEvent = WheelEvent;
    globalThis.TouchEvent = TouchEvent;
    globalThis.CompositionEvent = CompositionEvent;
    globalThis.TextEvent = TextEvent;
    globalThis.DeviceMotionEvent = DeviceMotionEvent;
    globalThis.DeviceOrientationEvent = DeviceOrientationEvent;
    globalThis.ProgressEvent = ProgressEvent;
    globalThis.PopStateEvent = PopStateEvent;
    globalThis.HashChangeEvent = HashChangeEvent;
    globalThis.StorageEvent = StorageEvent;
    globalThis.ErrorEvent = ErrorEvent;
    globalThis.PromiseRejectionEvent = PromiseRejectionEvent;
    globalThis.AnimationEvent = AnimationEvent;
    globalThis.TransitionEvent = TransitionEvent;
    globalThis.FormDataEvent = FormDataEvent;
    globalThis.BeforeUnloadEvent = BeforeUnloadEvent;
    const MOUSE_EVENT_TYPES = /* @__PURE__ */ new Set([
      "click",
      "dblclick",
      "mousedown",
      "mouseup",
      "mouseover",
      "mouseout",
      "mouseenter",
      "mouseleave",
      "mousemove",
      "contextmenu"
    ]);
    globalThis.__csimDispatchEvent = function(h, type, init) {
      const n = lookup(h);
      if (!n) return false;
      const typeStr = String(type);
      const ctor = MOUSE_EVENT_TYPES.has(typeStr) ? MouseEvent : Event;
      const merged = Object.assign({ bubbles: true, cancelable: true }, init || {});
      return dispatchEvent(n, new ctor(typeStr, merged));
    };
    globalThis.__csimFireCEConnect = fireCEConnect;
    function fireCEConnect(subtree) {
      walkSubtree(subtree, (el) => {
        if (el.nodeType !== NODE_ELEMENT) return;
        if (!__inHTMLGrafting && el._tag === "script" && !el._csimRan && el.isConnected) maybeRunScript(el);
        if (el._tag === "link") maybeFireLinkLoad(el);
        if (el._tag === "iframe" || el._tag === "frame") maybeFireFrameLoad(el);
        ceTryConnect(el);
      });
    }
    __name(fireCEConnect, "fireCEConnect");
    globalThis.__csim_onLinkHrefAssigned = maybeFireLinkLoad;
    globalThis.__csim_onFrameSrcAssigned = maybeFireFrameLoad;
    function maybeFireFrameLoad(el) {
      if (el._frameLoadFired) return;
      el._frameLoadFired = true;
      Promise.resolve().then(() => {
        if (!isConnected(el)) return;
        try {
          el.dispatchEvent(new Event("load"));
        } catch (_) {
        }
      });
    }
    __name(maybeFireFrameLoad, "maybeFireFrameLoad");
    function maybeFireLinkLoad(el) {
      const rel = (el._attrs.rel || "").toLowerCase().split(/\s+/);
      const isStylesheet = rel.includes("stylesheet");
      if (!isStylesheet && !rel.includes("modulepreload") && !rel.includes("preload")) return;
      const href = el._attrs.href;
      if (!href) return;
      Promise.resolve().then(() => {
        if (!isConnected(el)) return;
        let ok = true;
        try {
          const resp = __rackFetch("GET", href, "", null, "follow");
          ok = !!(resp && resp.status < 400);
        } catch (_) {
          ok = false;
        }
        if (ok && isStylesheet) {
          try {
            rebuildCascade(globalThis.document);
          } catch (_) {
          }
        }
        try {
          el.dispatchEvent(new Event(ok ? "load" : "error"));
        } catch (_) {
        }
      });
    }
    __name(maybeFireLinkLoad, "maybeFireLinkLoad");
    let __initialScriptsDone = false;
    let __inHTMLGrafting = false;
    function dispatchScriptLoad(el, ok) {
      if (!el._attrs.src) return;
      try {
        el.dispatchEvent(new Event(ok ? "load" : "error"));
      } catch (_) {
      }
    }
    __name(dispatchScriptLoad, "dispatchScriptLoad");
    function maybeRunScript(el) {
      const type = (el._attrs.type || "").toLowerCase();
      if (type && type !== "text/javascript" && type !== "application/javascript" && type !== "application/x-javascript" && type !== "text/ecmascript") return;
      let body;
      if (el._attrs.src) {
        el._csimRan = true;
        try {
          const resp = __rackFetch("GET", el._attrs.src, "", null, "follow");
          if (!resp || resp.status >= 400) {
            dispatchScriptLoad(el, false);
            return;
          }
          body = resp.body || "";
        } catch (_) {
          dispatchScriptLoad(el, false);
          return;
        }
        if (!body) {
          dispatchScriptLoad(el, true);
          return;
        }
      } else {
        body = scriptText(el);
        if (!body) return;
        el._csimRan = true;
      }
      const label = el._attrs.src || "inline://" + hashStr(body);
      let _ok = true;
      try {
        __csim_runScript(label, body);
      } catch (e) {
        _ok = false;
        logThrew("dynamic script", e);
      }
      dispatchScriptLoad(el, _ok);
    }
    __name(maybeRunScript, "maybeRunScript");
    globalThis.__csimScriptChildrenChanged = function(el) {
      if (!__inHTMLGrafting && el && el._tag === "script" && !el._csimRan && el.isConnected) {
        maybeRunScript(el);
      }
    };
    globalThis.Document = Document;
    globalThis.Element = Element;
    installXPath(Document.prototype);
    installOnHandlerSlots(Element);
    installWindowForwardedHandlers(Element);
    installVideoIDL(Element);
    installCanvasToBlob(Element);
    globalThis.__csim_onVideoSrcAssigned = onVideoSrcAssigned;
    globalThis.Node = Node;
    installNodeConstants(Node);
    globalThis.Text = Text;
    installDomClassAliases({ Element, Document, Text });
    globalThis.document = createHtmlPageDocument(true);
    globalThis.window = globalThis;
    globalThis.EventTarget = EventTarget;
    globalThis.Blob = Blob;
    globalThis.File = File;
    globalThis.localStorage = localStorage;
    globalThis.sessionStorage = sessionStorage;
    globalThis.ClipboardEvent = ClipboardEvent;
    function isXmlMimeType(t) {
      return t === "text/xml" || t === "application/xml" || t === "application/xhtml+xml" || t === "image/svg+xml";
    }
    __name(isXmlMimeType, "isXmlMimeType");
    const DOMPARSER_SUPPORTED_TYPES = /* @__PURE__ */ new Set([
      "text/html",
      "text/xml",
      "application/xml",
      "application/xhtml+xml",
      "image/svg+xml"
    ]);
    globalThis.DOMParser = class DOMParser {
      static {
        __name(this, "DOMParser");
      }
      constructor() {
        this._ownerDoc = globalThis.document;
      }
      parseFromString(input, mimeType) {
        const src = String(input == null ? "" : input);
        const provided = mimeType != null;
        const t = provided ? String(mimeType).toLowerCase() : "text/html";
        if (provided && !DOMPARSER_SUPPORTED_TYPES.has(t)) {
          throw new TypeError("Failed to execute 'parseFromString' on 'DOMParser': The provided value '" + String(mimeType) + "' is not a valid enum value of type SupportedType.");
        }
        let doc;
        if (isXmlMimeType(t)) {
          doc = parseXMLDocument(src);
          doc._contentType = t;
        } else {
          doc = parseDocument(src);
        }
        walkSubtree(doc, (n) => {
          n._ownerDoc = doc;
        });
        const ownerURL = (this._ownerDoc || globalThis.document).URL;
        if (ownerURL) doc._url = ownerURL;
        doc._noBrowsingContext = true;
        return doc;
      }
    };
    function parseXMLDocument(xml) {
      const doc = new Document();
      doc._children = newChildList();
      doc._url = void 0;
      doc._noBrowsingContext = false;
      doc.readyState = "loading";
      for (const node of parseXml(String(xml == null ? "" : xml))) {
        node._parent = doc;
        doc._children.push(node);
      }
      return doc;
    }
    __name(parseXMLDocument, "parseXMLDocument");
    function makeFrameWindow(doc, frameEl) {
      let win;
      win = new Proxy(globalThis, {
        get(target, prop) {
          switch (prop) {
            case "document":
              return doc;
            case "frameElement":
              return frameEl;
            case "self":
            case "window":
              return win;
            case "parent":
            case "top":
              return globalThis;
            default:
              return Reflect.get(target, prop, globalThis);
          }
        },
        has(target, prop) {
          return Reflect.has(target, prop);
        }
      });
      return win;
    }
    __name(makeFrameWindow, "makeFrameWindow");
    globalThis.__csimFrameWindow = function(frameEl) {
      if (!frameEl || frameEl._tag !== "iframe" && frameEl._tag !== "frame") return null;
      if (frameEl._frameRealmId != null && globalThis.RustyRacer && typeof globalThis.RustyRacer.contextGlobal === "function") {
        return globalThis.RustyRacer.contextGlobal(frameEl._frameRealmId);
      }
      if (frameEl._frameWindow) return frameEl._frameWindow;
      let body = "", contentType = "text/html", frameUrl = "";
      const srcdoc = frameEl.getAttribute("srcdoc");
      if (srcdoc != null) {
        body = srcdoc;
      } else {
        const src = frameEl.getAttribute("src");
        if (src && src !== "about:blank") {
          try {
            const base = globalThis.location && globalThis.location.href || "http://localhost/";
            frameUrl = new URL(src, base).href;
            const resp = globalThis.__rackFetch("GET", frameUrl, null, {}, "follow");
            if (resp) {
              body = resp.body || "";
              const ct2 = resp.headers && (resp.headers["content-type"] || resp.headers["Content-Type"]);
              if (ct2) contentType = ct2;
            }
          } catch (e) {
          }
        }
      }
      if (typeof globalThis.__csim_createFrameRealm === "function" && globalThis.RustyRacer && typeof globalThis.RustyRacer.contextGlobal === "function") {
        const parentId = typeof globalThis.RustyRacer.contextOf === "function" ? globalThis.RustyRacer.contextOf(globalThis) : 0;
        const id = globalThis.__csim_createFrameRealm(frameUrl, body, contentType, parentId);
        if (id != null) {
          frameEl._frameRealmId = id;
          (globalThis.__csimChildRealmIds || (globalThis.__csimChildRealmIds = /* @__PURE__ */ new Set())).add(id);
          const win2 = globalThis.RustyRacer.contextGlobal(id);
          try {
            win2.frameElement = frameEl;
          } catch (e) {
          }
          return win2;
        }
      }
      const ct = String(contentType).split(";")[0].trim().toLowerCase();
      const doc = isXmlMimeType(ct) ? parseXMLDocument(body) : parseDocument(String(body));
      doc._contentType = ct || "text/html";
      if (frameUrl) doc._url = frameUrl;
      const win = makeFrameWindow(doc, frameEl);
      doc._defaultView = win;
      walkSubtree(doc, (n) => {
        n._ownerDoc = doc;
      });
      frameEl._frameWindow = win;
      return win;
    };
    installBlobURL();
    registerNode(globalThis.document);
    function descendForHover(n) {
      while (n && n.nodeType === NODE_ELEMENT && n._children) {
        let only = null;
        let multi = false;
        for (const child of n._children) {
          if (child.nodeType !== NODE_ELEMENT) continue;
          if (!__isVisibleNode(child)) continue;
          if (only) {
            multi = true;
            break;
          }
          only = child;
        }
        if (multi || !only) break;
        n = only;
      }
      return n;
    }
    __name(descendForHover, "descendForHover");
    function commonAncestor(a, b) {
      if (!a || !b) return null;
      const seen = /* @__PURE__ */ new Set();
      for (let cur = a; cur; cur = cur._parent) seen.add(cur);
      for (let cur = b; cur; cur = cur._parent) if (seen.has(cur)) return cur;
      return null;
    }
    __name(commonAncestor, "commonAncestor");
    function fireMouseEventSafe(node, type, init) {
      try {
        dispatchEvent(node, new MouseEvent(type, init));
      } catch (_) {
      }
    }
    __name(fireMouseEventSafe, "fireMouseEventSafe");
    function dispatchHover(n, opts) {
      opts = opts || {};
      const doc = globalThis.document;
      if (!doc) return;
      const prev = doc._hoverElement || null;
      if (opts.dedupe && prev === n) return;
      const target = descendForHover(n);
      const changed = prev !== target;
      doc._hoverElement = target;
      if (opts.dedupe && !changed) return;
      const common = prev && changed ? commonAncestor(prev, target) : null;
      if (prev && changed) {
        const outInit = { bubbles: true, cancelable: true, relatedTarget: target };
        const leaveInit = { bubbles: false, cancelable: false, relatedTarget: target };
        fireMouseEventSafe(prev, "pointerout", outInit);
        fireMouseEventSafe(prev, "mouseout", outInit);
        for (let cur = prev; cur && cur !== common; cur = cur._parent) {
          fireMouseEventSafe(cur, "pointerleave", leaveInit);
          fireMouseEventSafe(cur, "mouseleave", leaveInit);
        }
      }
      const init = Object.assign({ bubbles: true, cancelable: true, relatedTarget: prev }, opts.init || {});
      const enterInit = { bubbles: false, cancelable: false, relatedTarget: prev };
      const enterPath = opts.dispatchEnter ? [] : null;
      if (enterPath) {
        for (let cur = target; cur && cur !== common; cur = cur._parent) enterPath.push(cur);
      }
      fireMouseEventSafe(target, "pointerover", init);
      if (enterPath) {
        for (let i = enterPath.length - 1; i >= 0; i--) fireMouseEventSafe(enterPath[i], "pointerenter", enterInit);
      }
      fireMouseEventSafe(target, "mouseover", init);
      if (enterPath) {
        for (let i = enterPath.length - 1; i >= 0; i--) fireMouseEventSafe(enterPath[i], "mouseenter", enterInit);
      }
      fireMouseEventSafe(target, "pointermove", init);
      fireMouseEventSafe(target, "mousemove", init);
    }
    __name(dispatchHover, "dispatchHover");
    globalThis.__csimSetHover = function(h) {
      const n = lookup(h);
      if (!n) return false;
      dispatchHover(n, { dispatchEnter: true });
      return true;
    };
    function __takePendingFormSubmit() {
      const p = globalThis.__csimPendingFormSubmit;
      if (!p) return null;
      globalThis.__csimPendingFormSubmit = null;
      return {
        formHandle: p.form && p.form._id,
        submitterHandle: p.submitter && p.submitter._id
      };
    }
    __name(__takePendingFormSubmit, "__takePendingFormSubmit");
    globalThis.__csimTakePendingFormSubmit = __takePendingFormSubmit;
    globalThis.__csimTakePendingNavigation = function() {
      const p = globalThis.__csimPendingNavigation;
      globalThis.__csimPendingNavigation = null;
      return p;
    };
    globalThis.__csimTakePendingDownload = function() {
      const p = globalThis.__csimPendingDownload;
      globalThis.__csimPendingDownload = null;
      return p;
    };
    globalThis.__csimLoadDocument = function(html, contentType) {
      __initialScriptsDone = false;
      resetCascadeState();
      resetLayoutY();
      globalThis.document._hoverElement = null;
      globalThis.__csimPendingFormSubmit = null;
      const __root = globalThis.document.documentElement;
      if (__root) {
        __root._scrollTop = 0;
        __root._scrollLeft = 0;
      }
      const __ct = String(contentType || "").split(";")[0].trim().toLowerCase();
      if (isXmlMimeType(__ct)) {
        __inHTMLGrafting = true;
        const xmlDoc = parseXMLDocument(String(html == null ? "" : html));
        const dx = globalThis.document;
        for (const c of dx._children.slice()) {
          unregisterSubtree(c);
          c._parent = null;
        }
        dx._children = newChildList();
        dx._contentType = __ct;
        for (const c of xmlDoc._children) {
          c._parent = dx;
          walkSubtree(c, (n) => {
            n._ownerDoc = dx;
          });
          dx._children.push(c);
        }
        registerSubtree(dx);
        globalThis.__csimFireCEConnect(dx);
        dx.readyState = "loading";
        rebuildCascade(dx);
        __inHTMLGrafting = false;
        runInlineScripts(dx);
        dx.readyState = "interactive";
        try {
          dispatchEvent(dx, new Event("readystatechange", { bubbles: false, cancelable: false }));
        } catch (_) {
        }
        dx.readyState = "complete";
        try {
          dispatchEvent(dx, new Event("readystatechange", { bubbles: false, cancelable: false }));
        } catch (_) {
        }
        __initialScriptsDone = true;
        return dx._id;
      }
      __inHTMLGrafting = true;
      const freshDoc = parseDocument(String(html == null ? "" : html));
      const d = globalThis.document;
      d._contentType = __ct || "text/html";
      for (const c of d._children.slice()) {
        if (c.nodeType === NODE_DOCTYPE || c.nodeType === NODE_COMMENT) {
          unregisterSubtree(c);
          c._parent = null;
          const i = d._children.indexOf(c);
          if (i !== -1) d._children.splice(i, 1);
        }
      }
      const freshKids = freshDoc._children;
      const freshHtmlIdx = freshKids.indexOf(freshDoc.documentElement);
      const prolog = freshHtmlIdx > 0 ? freshKids.slice(0, freshHtmlIdx).filter((c) => c.nodeType === NODE_DOCTYPE || c.nodeType === NODE_COMMENT) : [];
      const liveHtmlIdx = d._children.indexOf(d.documentElement);
      if (liveHtmlIdx !== -1 && prolog.length) {
        for (const c of prolog) {
          c._parent = d;
          c._ownerDoc = d;
          registerSubtree(c);
        }
        d._children.splice(liveHtmlIdx, 0, ...prolog);
      }
      d._quirks = freshDoc._quirks;
      const freshHtml = freshDoc.documentElement;
      const liveHtml = d.documentElement;
      if (freshHtml && liveHtml) {
        const freshHead = freshHtml._children.find((c) => c._tag === "head");
        const freshBody = freshHtml._children.find((c) => c._tag === "body");
        const liveHead = liveHtml._children.find((c) => c._tag === "head");
        const liveBody = liveHtml._children.find((c) => c._tag === "body");
        if (liveHead) for (const c of liveHead._children.slice()) liveHead.removeChild(c);
        if (liveBody) for (const c of liveBody._children.slice()) liveBody.removeChild(c);
        if (liveHead && freshHead) for (const c of freshHead._children.slice()) {
          c._parent = null;
          liveHead.appendChild(c);
        }
        if (liveBody && freshBody) for (const c of freshBody._children.slice()) {
          c._parent = null;
          liveBody.appendChild(c);
        }
        if (liveHtml && freshHtml) {
          for (const k of Object.keys(liveHtml._attrs)) delete liveHtml._attrs[k];
          Object.assign(liveHtml._attrs, freshHtml._attrs);
          liveHtml._attrNodes = null;
        }
        if (liveHead && freshHead) {
          for (const k of Object.keys(liveHead._attrs)) delete liveHead._attrs[k];
          Object.assign(liveHead._attrs, freshHead._attrs);
          liveHead._attrNodes = null;
        }
        if (liveBody && freshBody) {
          for (const k of Object.keys(liveBody._attrs)) delete liveBody._attrs[k];
          Object.assign(liveBody._attrs, freshBody._attrs);
          liveBody._attrNodes = null;
        }
      }
      d.readyState = "loading";
      rebuildCascade(globalThis.document);
      __inHTMLGrafting = false;
      runInlineScripts(globalThis.document);
      d.readyState = "interactive";
      try {
        dispatchEvent(d, new Event("readystatechange", { bubbles: false, cancelable: false }));
      } catch (_) {
      }
      d.readyState = "complete";
      try {
        dispatchEvent(d, new Event("readystatechange", { bubbles: false, cancelable: false }));
      } catch (_) {
      }
      __initialScriptsDone = true;
      return globalThis.document._id;
    };
    globalThis.__csimBootContext = function(opts) {
      if (typeof opts.viewportW === "number") globalThis.innerWidth = opts.viewportW;
      if (typeof opts.viewportH === "number") globalThis.innerHeight = opts.viewportH;
      if (opts.userAgent) {
        try {
          Object.defineProperty(globalThis.navigator, "userAgent", { value: opts.userAgent, configurable: true });
        } catch (_) {
        }
      }
      globalThis.__csimSetTraceActive(!!opts.traceActive);
      globalThis.__csimSetTimezone(opts.timezone || "");
      if (opts.timeTravelOffsetMs) globalThis.__csimSetTimeTravelOffsetMs(opts.timeTravelOffsetMs);
      if (opts.url) globalThis.__csimUpdateLocation(opts.url);
      return globalThis.__csimLoadDocument(opts.html, opts.contentType);
    };
    const __externalScriptsRun = /* @__PURE__ */ new Map();
    function runInlineScripts(doc) {
      if (!doc || !doc.documentElement) return;
      ingestImportmaps(doc);
      const scripts = Array.from(doc.documentElement.querySelectorAll("script"));
      for (const s of scripts) {
        const type = (s._attrs.type || "").toLowerCase();
        if (type === "importmap") continue;
        if (type === "module") {
          runModuleScript(s);
          continue;
        }
        if (type && !SCRIPT_TYPES_CLASSIC.has(type)) continue;
        let body;
        if (s._attrs.src) {
          if (__externalScriptsRun.has(s._attrs.src)) continue;
          body = globalThis.__csimExternalAsset(s._attrs.src);
          if (!body) continue;
          __externalScriptsRun.set(s._attrs.src, body);
        } else {
          body = scriptText(s);
        }
        if (!body) {
          s._csimRan = false;
          continue;
        }
        const label = s._attrs.src || "inline://" + hashStr(body);
        const prevCurrent = globalThis.document && globalThis.document._currentScript;
        if (globalThis.document) globalThis.document._currentScript = s;
        s._csimRan = true;
        let _ok = true;
        try {
          __csim_runScript(label, body);
        } catch (e) {
          _ok = false;
          try {
            const _prev = Error.stackTraceLimit;
            Error.stackTraceLimit = 60;
            const where = s._attrs.src || "(inline) " + body.slice(0, 120).replace(/\s+/g, " ");
            const detail = e && (e.stack || e.message) || "typeof=" + typeof e + " str=" + String(e);
            console.error("[csim] script threw in", where, ":", detail);
            Error.stackTraceLimit = _prev;
          } catch (_) {
          }
        } finally {
          if (globalThis.document) globalThis.document._currentScript = prevCurrent;
        }
        dispatchScriptLoad(s, _ok);
      }
      if (hasObservers() && hasQueuedRecords()) deliverMutations();
      if (typeof globalThis.__recheckIntersectionObservers === "function") globalThis.__recheckIntersectionObservers();
      if (doc) {
        try {
          dispatchEvent(doc, new Event("DOMContentLoaded", { bubbles: true, cancelable: false }));
        } catch (_) {
        }
      }
    }
    __name(runInlineScripts, "runInlineScripts");
    function runModuleScript(s) {
      const baseUrl = globalThis.location && globalThis.location.href || null;
      if (s._attrs.src) {
        const url = resolveAgainst(s._attrs.src, baseUrl);
        try {
          __csim_evalEsmEntry(url, null);
        } catch (e) {
          try {
            console.error("[csim] module", url, "failed:", e && (e.stack || e.message));
          } catch (_) {
          }
        }
      } else {
        const body = scriptText(s);
        if (!body) return;
        const url = (baseUrl || "inline://") + "#inline-" + hashStr(body);
        try {
          __csim_evalEsmEntry(url, body);
        } catch (e) {
          try {
            console.error("[csim] inline module failed:", e && e.message);
          } catch (_) {
          }
        }
      }
    }
    __name(runModuleScript, "runModuleScript");
    function hashStr(s) {
      let h = 5381;
      for (let i = 0; i < s.length; i++) h = (h << 5) + h + s.charCodeAt(i) | 0;
      return (h >>> 0).toString(16);
    }
    __name(hashStr, "hashStr");
    const SCRIPT_TYPES_CLASSIC = /* @__PURE__ */ new Set([
      "",
      "text/javascript",
      "application/javascript",
      "application/ecmascript"
    ]);
    const __evalCache = /* @__PURE__ */ new Map();
    function compileScript(code) {
      let fn = __evalCache.get(code);
      if (!fn) {
        fn = new Function("return eval(" + JSON.stringify(code) + ");");
        __evalCache.set(code, fn);
      }
      return fn;
    }
    __name(compileScript, "compileScript");
    globalThis.__csimEvalScript = function(code, args) {
      return marshalReturn(compileScript(code).apply(null, rehydrateArgs(args || [])));
    };
    globalThis.__csimExecScript = function(code, args) {
      compileScript(code).apply(null, rehydrateArgs(args || []));
    };
    function rehydrateArgs(args) {
      if (Array.isArray(args)) return args.map(rehydrateArgs);
      if (args && typeof args === "object") {
        if (typeof args.__elementHandle === "number") return lookup(args.__elementHandle);
        const out = {};
        for (const k of Object.keys(args)) out[k] = rehydrateArgs(args[k]);
        return out;
      }
      return args;
    }
    __name(rehydrateArgs, "rehydrateArgs");
    function isDomCollection(v) {
      return v && typeof v === "object" && (globalThis.HTMLCollection && v instanceof globalThis.HTMLCollection || globalThis.NodeList && v instanceof globalThis.NodeList);
    }
    __name(isDomCollection, "isDomCollection");
    function marshalReturn(value) {
      if (value && typeof value === "object" && value.nodeType !== void 0 && typeof value._id === "number") {
        return { __elementHandle: value._id };
      }
      if (Array.isArray(value)) return value.map(marshalReturn);
      if (isDomCollection(value)) {
        return Array.from(value, marshalReturn);
      }
      return value;
    }
    __name(marshalReturn, "marshalReturn");
    globalThis.__csimVisible = function(h) {
      const n = lookup(h);
      if (!n || n.nodeType !== NODE_ELEMENT) return false;
      if (INVISIBLE_TAGS.has(n._tag)) return false;
      if (n._tag === "input" && (n._attrs.type || "").toLowerCase() === "hidden") return false;
      let summarySeen = false;
      let cur = n;
      let prev = null;
      while (cur) {
        if (cur.nodeType === NODE_DOC) break;
        if (cur.nodeType === NODE_ELEMENT) {
          if (INVISIBLE_TAGS.has(cur._tag)) return false;
          if (selfHidden(cur, true)) return false;
          if (cur !== n && cur._tag === "details" && cur._attrs.open == null && !summarySeen) {
            const display = prev && prev.nodeType === NODE_ELEMENT ? resolveCascadeDisplay(prev) : null;
            if (display == null || display === "none") return false;
          }
          if (cur._tag === "summary") summarySeen = true;
        }
        prev = cur;
        cur = cur._parent;
      }
      if (visibilityHidden(n)) return false;
      return true;
    };
    function __computeVisibleText(n) {
      for (let cur = n._parent; cur; cur = cur._parent) {
        if (cur.nodeType === NODE_ELEMENT && (INVISIBLE_TAGS.has(cur._tag) || selfHidden(cur))) return "";
      }
      if (n.nodeType === NODE_ELEMENT && n._tag === "textarea") {
        return n.value == null ? "" : String(n.value);
      }
      const startTransform = n._parent ? resolveTextTransform(n._parent) : "none";
      let preserveWs = false;
      for (let cur = n._parent; cur; cur = cur._parent) {
        if (cur.nodeType !== NODE_ELEMENT) continue;
        if (elementPreservesWhitespace(cur)) {
          preserveWs = true;
          break;
        }
      }
      return collectVisibleText(n, startTransform, preserveWs);
    }
    __name(__computeVisibleText, "__computeVisibleText");
    globalThis.__csimVisibleText = function(h) {
      const n = lookup(h);
      if (!n) return "";
      if (n.nodeType === NODE_ELEMENT && n._tag === "textarea") return __computeVisibleText(n);
      const gen = globalThis.__settleGenGet();
      const cv = globalThis.__csimCascadeVersion ? globalThis.__csimCascadeVersion() : 0;
      if (n._vtGen === gen && n._vtCV === cv) return n._vt;
      const result = __computeVisibleText(n);
      n._vtGen = gen;
      n._vtCV = cv;
      n._vt = result;
      return result;
    };
    globalThis.__csimTimersDebug = timerStats;
    globalThis.__csimElementRect = function(h) {
      const el = handles.get(h);
      if (!el || el.nodeType !== NODE_ELEMENT) return { x: 0, y: 0, width: 0, height: 0 };
      let x = resolveLayoutProp(el, "left") || 0;
      let y = resolveLayoutProp(el, "top") || 0;
      const w = resolveLayoutProp(el, "width") || 0;
      const h2 = resolveLayoutProp(el, "height") || 0;
      for (let cur = el._parent; cur && cur.nodeType === NODE_ELEMENT; cur = cur._parent) {
        x += resolveLayoutProp(cur, "left") || 0;
        y += resolveLayoutProp(cur, "top") || 0;
      }
      return { x, y, width: w, height: h2 };
    };
    let __asyncResult = null;
    globalThis.__evalAsyncScript = function(code, args) {
      __asyncResult = null;
      const list = (args || []).map(
        (a) => a && typeof a === "object" && "__elementHandle" in a ? handles.get(a.__elementHandle) || null : a
      );
      list.push(function(v) {
        __asyncResult = { value: __marshalAsyncResult(v) };
      });
      try {
        new Function("args", "return (function (" + list.map((_, i) => "a" + i).join(", ") + ") { " + String(code) + " }).apply(null, args);")(list);
      } catch (e) {
        __asyncResult = { value: null, error: e && e.message };
      }
    };
    function __marshalAsyncResult(v) {
      if (v && typeof v === "object") {
        if (v.nodeType === NODE_ELEMENT) return { __elementHandle: v._id };
        if (Array.isArray(v)) return v.map(__marshalAsyncResult);
        if (isDomCollection(v)) return Array.from(v, __marshalAsyncResult);
      }
      return v;
    }
    __name(__marshalAsyncResult, "__marshalAsyncResult");
    globalThis.__pollAsyncResult = function() {
      return __asyncResult;
    };
    function __csimMakeDataTransfer(items) {
      const dt = new globalThis.DataTransfer();
      for (const it of items || []) {
        if (it.kind === "file") {
          const file = { name: it.name, type: "", size: 0 };
          dt.items.push(new globalThis.DataTransferItem("file", "application/octet-stream", null, file));
          if (!dt.types.includes("Files")) dt.types.push("Files");
        } else {
          dt.items.push(new globalThis.DataTransferItem("string", it.type, it.value, null));
          if (!dt.types.includes(it.type)) dt.types.push(it.type);
        }
      }
      return dt;
    }
    __name(__csimMakeDataTransfer, "__csimMakeDataTransfer");
    globalThis.__csimClickFinish = function(h, base) {
      const n = handles.get(h);
      if (!n || n.nodeType !== NODE_ELEMENT) return null;
      dispatchEvent(n, new MouseEvent("mouseup", base));
      const click = new MouseEvent("click", base);
      click._csimActivationHandled = true;
      dispatchEvent(n, click);
      const pendingSubmit = __takePendingFormSubmit();
      if (pendingSubmit) return { kind: "submit", formHandle: pendingSubmit.formHandle, submitter: pendingSubmit.submitterHandle || 0 };
      if (click.defaultPrevented) return null;
      if (n._tag === "a" && n._attrs.href != null) {
        const href = String(n._attrs.href);
        if (/^\s*javascript:/i.test(href)) return null;
        if (n._attrs.download != null) {
          return { kind: "download", url: href, filename: String(n._attrs.download || "") };
        }
        let target = String(n._attrs.target || "");
        if (click && (click.metaKey || click.ctrlKey)) target = "_blank";
        return { kind: "navigate", url: href, target };
      }
      return null;
    };
    globalThis.__csimDropOnto = function(h, items) {
      const target = handles.get(h);
      if (!target) return false;
      const dt = __csimMakeDataTransfer(items || []);
      for (const type of ["dragenter", "dragover", "drop"]) {
        const ev = new Event(type, { bubbles: true, cancelable: true });
        ev.dataTransfer = dt;
        dispatchEvent(target, ev);
      }
      return true;
    };
    globalThis.__csimDragOnto = function(sourceHandle, targetHandle) {
      const source = handles.get(sourceHandle);
      const target = handles.get(targetHandle);
      if (!source || !target) return false;
      const dt = new globalThis.DataTransfer();
      const init = { bubbles: true, cancelable: true, button: 0 };
      dispatchEvent(source, new MouseEvent("mousedown", init));
      const fireDrag = /* @__PURE__ */ __name((el, type) => {
        const ev = new DragEvent(type, init);
        ev.dataTransfer = dt;
        dispatchEvent(el, ev);
      }, "fireDrag");
      fireDrag(source, "dragstart");
      fireDrag(target, "dragenter");
      fireDrag(target, "dragover");
      fireDrag(target, "drop");
      fireDrag(source, "dragend");
      dispatchEvent(source, new MouseEvent("mouseup", init));
      return true;
    };
    const __TABBABLE_TAGS = /* @__PURE__ */ new Set(["a", "button", "input", "select", "textarea"]);
    function __isTabbable(el) {
      if (!el || el.nodeType !== NODE_ELEMENT) return false;
      if (el._attrs.disabled != null) return false;
      if (selfHidden(el)) return false;
      const ti = el._attrs.tabindex;
      if (ti != null) {
        const n = parseInt(ti, 10);
        return !isNaN(n) && n >= 0;
      }
      if (el._attrs.contenteditable != null && (el._attrs.contenteditable || "").toLowerCase() !== "false") {
        return true;
      }
      for (let cur = el._parent; cur; cur = cur._parent) {
        if (cur.nodeType !== NODE_ELEMENT) continue;
        const ce = cur._attrs.contenteditable;
        if (ce != null && String(ce).toLowerCase() !== "false") return false;
      }
      if (!__TABBABLE_TAGS.has(el._tag)) return false;
      if (el._tag === "input" && (el._attrs.type || "").toLowerCase() === "hidden") return false;
      if (el._tag === "a" && el._attrs.href == null) return false;
      return true;
    }
    __name(__isTabbable, "__isTabbable");
    function __collectTabbables() {
      const out = [];
      if (globalThis.document) walk(globalThis.document, (el) => {
        if (__isTabbable(el)) out.push(el);
      });
      return out;
    }
    __name(__collectTabbables, "__collectTabbables");
    globalThis.__csimAdvanceFocus = function(reverse) {
      const list = __collectTabbables();
      if (list.length === 0) return false;
      const current = globalThis.document && globalThis.document._activeElement;
      let idx = current ? list.indexOf(current) : -1;
      idx = reverse ? idx <= 0 ? list.length - 1 : idx - 1 : (idx + 1) % list.length;
      const next = list[idx];
      if (next && typeof next.focus === "function") {
        try {
          next.focus();
        } catch (_) {
        }
      }
      return true;
    };
    const __csimCEAtomicTags = /* @__PURE__ */ new Set(["img", "video", "audio", "iframe", "object", "embed", "br", "hr", "input", "wbr", "svg", "math"]);
    const __csimInteractiveTags = /* @__PURE__ */ new Set(["a", "button", "input", "select", "textarea"]);
    function __csimIsHitTarget(n) {
      if (__csimInteractiveTags.has(n._tag)) return true;
      if (n._tag === "label") return true;
      const ll = n._listeners;
      if (ll && (ll.click || ll.mousedown || ll.pointerdown)) return true;
      const a = n._attrs;
      if (a && (a.onclick != null || a.onmousedown != null)) return true;
      return false;
    }
    __name(__csimIsHitTarget, "__csimIsHitTarget");
    function __csimHitTestRetarget(n) {
      if (!n || n.nodeType !== NODE_ELEMENT) return n;
      if (__csimIsHitTarget(n)) return n;
      if (contenteditableHost(n)) return n;
      function dfs(node) {
        const kids = node._children;
        if (!kids) return null;
        for (let i = 0; i < kids.length; i++) {
          const k = kids[i];
          if (k.nodeType !== NODE_ELEMENT) continue;
          if (k._tag === "a") continue;
          if (__csimIsHitTarget(k)) return k;
          const found = dfs(k);
          if (found) return found;
        }
        return null;
      }
      __name(dfs, "dfs");
      const hit = dfs(n);
      if (hit) return hit;
      const dataUrl = n._attrs && n._attrs["data-url"];
      const anchors = [];
      function collectAnchors(node) {
        const kids = node._children;
        if (!kids) return;
        for (let i = 0; i < kids.length; i++) {
          const k = kids[i];
          if (k.nodeType !== NODE_ELEMENT) continue;
          if (k._tag === "a" && k._attrs.href != null) anchors.push(k);
          collectAnchors(k);
        }
      }
      __name(collectAnchors, "collectAnchors");
      collectAnchors(n);
      if (anchors.length === 0) return n;
      if (anchors.length === 1) return anchors[0];
      if (dataUrl) {
        const match = anchors.find((a) => a._attrs.href === dataUrl);
        if (match) return match;
      }
      const cand = anchors[0];
      const wraps = anchors.every((a) => {
        if (a === cand) return true;
        for (let p = a._parent; p; p = p._parent) if (p === cand) return true;
        return false;
      });
      if (wraps) return cand;
      let listAncestor = null;
      let allInSameList = true;
      for (const a of anchors) {
        let p = a._parent;
        while (p && p !== n && p._tag !== "ul" && p._tag !== "ol") {
          p = p._parent;
        }
        if (!p || p === n || p._tag !== "ul" && p._tag !== "ol") {
          allInSameList = false;
          break;
        }
        if (listAncestor === null) listAncestor = p;
        else if (listAncestor !== p) {
          allInSameList = false;
          break;
        }
      }
      if (allInSameList) return anchors[Math.floor(anchors.length / 2)];
      return n;
    }
    __name(__csimHitTestRetarget, "__csimHitTestRetarget");
    globalThis.__csimClickResolve = function(h, modifiers) {
      const n = __csimHitTestRetarget(lookup(h));
      if (!n || n.nodeType !== NODE_ELEMENT) return null;
      const mods = modifiers || {};
      let preToggled = null;
      let wasChecked = null;
      let prevCheckedRadio = null;
      if (n._tag === "input") {
        const type = (n._attrs.type || "").toLowerCase();
        if (type === "checkbox") {
          wasChecked = n._attrs.checked != null;
          toggleChecked(n);
          preToggled = "checkbox";
        } else if (type === "radio") {
          wasChecked = n._attrs.checked != null;
          prevCheckedRadio = checkedRadioInGroup(n);
          setRadio(n);
          preToggled = "radio";
        }
      }
      const clickX = +mods.clientX || n._id * 31 % 1e3 + 1;
      const clickY = +mods.clientY || n._id * 71 % 1e3 + 1;
      const base = {
        bubbles: true,
        cancelable: true,
        button: 0,
        which: 1,
        shiftKey: !!mods.shiftKey,
        ctrlKey: !!mods.ctrlKey,
        altKey: !!mods.altKey,
        metaKey: !!mods.metaKey,
        clientX: clickX,
        clientY: clickY
      };
      globalThis.__csimLastClickTarget = n;
      dispatchHover(n, { dedupe: true, init: base });
      globalThis.__csimPendingFormSubmit = null;
      globalThis.__csimPendingNavigation = null;
      try {
        dispatchEvent(n, new MouseEvent("pointerdown", base));
      } catch (_) {
      }
      const mousedownEv = new MouseEvent("mousedown", base);
      dispatchEvent(n, mousedownEv);
      if (!mousedownEv.defaultPrevented && isFocusable(n)) {
        try {
          n.focus();
        } catch (_) {
        }
      }
      if (!mousedownEv.defaultPrevented && !__csimCEAtomicTags.has(n._tag)) {
        const ceHost = contenteditableHost(n);
        if (ceHost && ceHost !== n) {
          try {
            if (globalThis.document._activeElement !== ceHost) ceHost.focus();
            const sel = globalThis.getSelection();
            if (sel) sel.collapse(n, 0);
          } catch (_) {
          }
        }
      }
      if (mods.mouseDownOnly) {
        return { kind: "partial", base };
      }
      try {
        dispatchEvent(n, new MouseEvent("pointerup", base));
      } catch (_) {
      }
      dispatchEvent(n, new MouseEvent("mouseup", base));
      const click = new MouseEvent("click", base);
      click._csimActivationHandled = true;
      dispatchEventForUserAction(n, click);
      if (preToggled) {
        if (click.defaultPrevented) {
          if (preToggled === "radio") {
            delete n._attrs.checked;
            if (prevCheckedRadio) prevCheckedRadio._attrs.checked = "";
          } else if (wasChecked) n._attrs.checked = "";
          else delete n._attrs.checked;
        } else if (isConnected(n) && n._attrs.checked != null !== wasChecked) {
          try {
            dispatchEvent(n, new InputEvent("input", { bubbles: true, cancelable: true }));
          } catch (_) {
          }
          try {
            dispatchEvent(n, new Event("change", { bubbles: true, cancelable: false }));
          } catch (_) {
          }
        }
      }
      const pendingSubmit = __takePendingFormSubmit();
      if (pendingSubmit) return { kind: "submit", formHandle: pendingSubmit.formHandle, submitter: pendingSubmit.submitterHandle || 0 };
      const pendingNav = globalThis.__csimPendingNavigation;
      if (pendingNav && pendingNav.url) {
        globalThis.__csimPendingNavigation = null;
        return { kind: "navigate", url: String(pendingNav.url), target: String(pendingNav.target || "") };
      }
      {
        let details = null;
        if (n._tag === "summary" && !click.defaultPrevented) {
          let p = n._parent;
          while (p && p._tag !== "details") p = p._parent;
          details = p && p._tag === "details" ? p : null;
        } else if (n._tag === "details" && (n._children || []).some((c) => c && c._tag === "summary")) {
          details = n;
        }
        if (details) {
          const oldOpen = details._attrs.open;
          if (oldOpen != null) delete details._attrs.open;
          else details._attrs.open = "";
          recordAttrMutation(details, "open", oldOpen == null ? null : oldOpen);
          try {
            dispatchEvent(details, new Event("toggle", { bubbles: false }));
          } catch (_) {
          }
        }
      }
      if (click.defaultPrevented) return null;
      let __anchor = n;
      if (n._tag !== "area") {
        while (__anchor && __anchor.nodeType === NODE_ELEMENT && __anchor._tag !== "a") {
          __anchor = __anchor._parent;
        }
      }
      if (__anchor && __anchor.nodeType === NODE_ELEMENT && (__anchor._tag === "a" || __anchor._tag === "area") && __anchor._attrs.href != null) {
        const href = String(__anchor._attrs.href);
        if (/^\s*javascript:/i.test(href)) return null;
        if (__anchor._attrs.download != null) {
          return { kind: "download", url: href, filename: String(__anchor._attrs.download || "") };
        }
        let target = String(__anchor._attrs.target || "");
        if (click && (click.metaKey || click.ctrlKey)) target = "_blank";
        if (!(click && (click.metaKey || click.ctrlKey)) && fragmentNavigate(__anchor)) return null;
        return { kind: "navigate", url: href, target };
      }
      const label = n._tag === "label" ? n : LABELABLE.has(n._tag) ? null : enclosingLabelFor(n);
      if (label) {
        const labeled = labeledControlFor(label);
        if (labeled && labeled !== n && labeled !== label) {
          return __csimClickResolve(labeled._id);
        }
      }
      if (isSubmitButton(n)) {
        const form = formForControl(n);
        if (!form) return null;
        const submit = new SubmitEvent("submit", { bubbles: true, cancelable: true, submitter: n });
        dispatchEvent(form, submit);
        const pendingFromHandler = __takePendingFormSubmit();
        if (pendingFromHandler) return { kind: "submit", formHandle: pendingFromHandler.formHandle, submitter: pendingFromHandler.submitterHandle || 0 };
        if (submit.defaultPrevented) return null;
        const methodAttr = (n._attrs.formmethod || form._attrs.method || "").toLowerCase();
        if (methodAttr === "dialog") {
          let dlg = form._parent;
          while (dlg && dlg._tag !== "dialog") dlg = dlg._parent;
          if (dlg) closeDialog(dlg, String(n._attrs.value == null ? "" : n._attrs.value));
          return null;
        }
        return { kind: "submit", formHandle: form._id, submitter: n._id };
      }
      return null;
    };
    globalThis.MessageEvent = MessageEvent;
    installIfMissing();
  })();
})();
