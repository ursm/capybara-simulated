(() => {
  // lib/capybara/simulated/js/src/constants.js
  var NODE_ELEMENT = 1;
  var NODE_TEXT = 3;
  var NODE_COMMENT = 8;
  var NODE_DOC = 9;
  var NODE_FRAGMENT = 11;
  function installNodeConstants(Node2) {
    const c = {
      ELEMENT_NODE: 1,
      ATTRIBUTE_NODE: 2,
      TEXT_NODE: 3,
      CDATA_SECTION_NODE: 4,
      PROCESSING_INSTRUCTION_NODE: 7,
      COMMENT_NODE: 8,
      DOCUMENT_NODE: 9,
      DOCUMENT_TYPE_NODE: 10,
      DOCUMENT_FRAGMENT_NODE: 11
    };
    for (const k in c) {
      Node2[k] = c[k];
      Node2.prototype[k] = c[k];
    }
  }

  // lib/capybara/simulated/js/src/walk.js
  function walk(node, fn) {
    if (!node) return;
    if (node.nodeType === NODE_ELEMENT) fn(node);
    for (const c of node._children) walk(c, fn);
  }
  function walkSubtree(node, fn) {
    if (!node) return;
    fn(node);
    if (node._children) for (const c of node._children) walkSubtree(c, fn);
  }
  function isConnected(node) {
    let cur = node;
    while (cur) {
      if (cur.nodeType === NODE_DOC) return true;
      cur = cur._parent;
    }
    return false;
  }
  function stripOneLeadingNewline(s) {
    if (typeof s !== "string" || s.length === 0) return s;
    if (s.length >= 2 && s.charCodeAt(0) === 13 && s.charCodeAt(1) === 10) return s.slice(2);
    if (s.charCodeAt(0) === 13 || s.charCodeAt(0) === 10) return s.slice(1);
    return s;
  }
  function scriptText(el) {
    let s = "";
    for (const c of el._children) if (c.nodeType === NODE_TEXT) s += c.data;
    return s;
  }
  function classes(el) {
    const cls = el._attrs["class"];
    if (!cls) return [];
    if (el._classesCacheKey === cls) return el._classesCache;
    const arr = cls.split(/\s+/).filter(Boolean);
    el._classesCacheKey = cls;
    el._classesCache = arr;
    return arr;
  }

  // lib/capybara/simulated/js/src/handles.js
  var handles = /* @__PURE__ */ new Map();
  function lookup(h) {
    return handles.get(h) || null;
  }
  function registerNode(n) {
    handles.set(n._id, n);
    if (n._children) for (const c of n._children) registerNode(c);
  }
  function registerSubtree(node) {
    if (!node) return;
    handles.set(node._id, node);
    if (node._children) for (const c of node._children) registerSubtree(c);
  }
  function unregisterSubtree(node) {
    if (!node) return;
    handles.delete(node._id);
    if (node._children) for (const c of node._children) unregisterSubtree(c);
  }

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
  var traceActive = false;
  var makeConsoleFn = (level) => function() {
    if (!traceActive) return void 0;
    try {
      globalThis.__csim_logConsole(level, consoleJoin(arguments));
    } catch (_) {
    }
    return void 0;
  };
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

  // lib/capybara/simulated/js/src/mutation-observer.js
  var observers = /* @__PURE__ */ new Set();
  var settleGen = 0;
  function bumpSettleGen() {
    settleGen = settleGen + 1 | 0;
  }
  globalThis.__settleGenGet = () => settleGen;
  var MutationObserver = class {
    constructor(callback) {
      this._cb = callback;
      this._observed = [];
      this._records = [];
    }
    observe(target, options) {
      if (!target) return;
      const opts = Object.assign({}, options || {});
      if (opts.attributeOldValue) opts.attributes = true;
      if (opts.characterDataOldValue) opts.characterData = true;
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
  function recordMatches(entry, rec) {
    const opts = entry.options;
    if (rec.type === "childList" && !opts.childList) return false;
    if (rec.type === "attributes" && !opts.attributes && !opts.attributeFilter) return false;
    if (rec.type === "characterData" && !opts.characterData) return false;
    if (rec.type === "attributes" && opts.attributeFilter && opts.attributeFilter.indexOf(rec.attributeName) === -1) return false;
    if (rec.target === entry.target) return true;
    if (!opts.subtree) return false;
    for (let cur = rec.target; cur; cur = cur._parent) {
      if (cur === entry.target) return true;
    }
    return false;
  }
  function queueRecord(rec) {
    if (observers.size === 0) return;
    let queued = false;
    for (const obs of observers) {
      for (const entry of obs._observed) {
        if (recordMatches(entry, rec)) {
          obs._records.push(rec);
          queued = true;
          break;
        }
      }
    }
    if (queued) scheduleMutationDelivery();
  }
  function recordAttrMutation(target, name, oldValue) {
    bumpSettleGen();
    if (observers.size === 0) return;
    queueRecord({
      type: "attributes",
      target,
      attributeName: name,
      attributeNamespace: null,
      oldValue,
      addedNodes: [],
      removedNodes: [],
      previousSibling: null,
      nextSibling: null
    });
  }
  function recordChildList(target, added, removed) {
    bumpSettleGen();
    if (observers.size === 0) return;
    queueRecord({
      type: "childList",
      target,
      addedNodes: added.slice(),
      removedNodes: removed.slice(),
      attributeName: null,
      attributeNamespace: null,
      oldValue: null,
      previousSibling: null,
      nextSibling: null
    });
  }
  function recordCharacterData(target, oldValue) {
    bumpSettleGen();
    if (observers.size === 0) return;
    queueRecord({
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
  var deliveringMutations = false;
  function deliverMutations() {
    if (deliveringMutations) return;
    deliveringMutations = true;
    try {
      for (const obs of observers) {
        if (!obs._records.length) continue;
        const mine = obs._records;
        obs._records = [];
        try {
          obs._cb(mine, obs);
        } catch (e) {
          logThrew("MO callback", e);
        }
      }
      if (typeof globalThis.__recheckIntersectionObservers === "function") {
        globalThis.__recheckIntersectionObservers();
      }
    } finally {
      deliveringMutations = false;
    }
  }
  function hasQueuedRecords() {
    for (const obs of observers) {
      if (obs._records.length) return true;
    }
    return false;
  }
  function hasObservers() {
    return observers.size > 0;
  }
  var deliveryPending = false;
  function scheduleMutationDelivery() {
    if (deliveryPending) return;
    deliveryPending = true;
    Promise.resolve().then(() => {
      deliveryPending = false;
      if (observers.size && hasQueuedRecords()) deliverMutations();
    });
  }
  globalThis.MutationObserver = MutationObserver;

  // lib/capybara/simulated/js/src/window-events.js
  var windowListeners = /* @__PURE__ */ Object.create(null);
  function fireWindowListeners(event, capture) {
    const list = windowListeners[event.type];
    if (!list || !list.length) return;
    event.currentTarget = globalThis;
    for (const { handler, capture: cap } of list.slice()) {
      if (!!cap !== !!capture) continue;
      if (event._propagationStopped) return;
      try {
        handler.call(globalThis, event);
      } catch (e) {
        logThrew("window listener", e);
      }
    }
  }
  globalThis.addEventListener = function(type, handler, options) {
    if (typeof handler !== "function") return;
    const capture = !!(options && (options === true || options.capture));
    const list = windowListeners[type] || (windowListeners[type] = []);
    if (list.some((l) => l.handler === handler && l.capture === capture)) return;
    list.push({ handler, capture });
  };
  globalThis.removeEventListener = function(type, handler, options) {
    const list = windowListeners[type];
    if (!list) return;
    const capture = !!(options && (options === true || options.capture));
    windowListeners[type] = list.filter((l) => !(l.handler === handler && l.capture === capture));
  };
  globalThis.dispatchEvent = function(event) {
    const list = windowListeners[event.type];
    if (!list || !list.length) return true;
    for (const { handler } of list.slice()) {
      try {
        handler.call(globalThis, event);
      } catch (e) {
        logThrew("window listener", e);
      }
    }
    return !event.defaultPrevented;
  };

  // lib/capybara/simulated/js/src/dispatch.js
  function dispatchEvent(target, event) {
    event.target = target;
    const path = [];
    let cur = target;
    while (cur) {
      path.push(cur);
      cur = cur._parent;
    }
    const prevWinEvent = globalThis.event;
    globalThis.event = event;
    try {
      event.eventPhase = 1;
      fireWindowListeners(event, true);
      if (!event._propagationStopped) {
        for (let i = path.length - 1; i > 0; i--) {
          fireListeners(path[i], event, true);
          if (event._propagationStopped) break;
        }
      }
      if (!event._propagationStopped) {
        event.eventPhase = 2;
        fireListeners(target, event, false);
        fireListeners(target, event, true);
      }
      if (!event._propagationStopped && event.bubbles) {
        event.eventPhase = 3;
        for (let i = 1; i < path.length; i++) {
          fireListeners(path[i], event, false);
          if (event._propagationStopped) break;
        }
        if (!event._propagationStopped) fireWindowListeners(event, false);
      }
      if (!event.defaultPrevented && event.type === "click") {
        let anchor = target;
        while (anchor && anchor.nodeType === NODE_ELEMENT && anchor._tag !== "a") {
          anchor = anchor._parent;
        }
        if (anchor && anchor.nodeType === NODE_ELEMENT && anchor._tag === "a" && anchor._attrs.download != null && anchor._attrs.href != null) {
          globalThis.__csimPendingDownload = {
            url: String(anchor._attrs.href),
            filename: String(anchor._attrs.download || "")
          };
        }
      }
      return !event.defaultPrevented;
    } finally {
      if (hasObservers() && hasQueuedRecords()) Promise.resolve().then(deliverMutations);
      if (typeof globalThis.__recheckIntersectionObservers === "function") globalThis.__recheckIntersectionObservers();
      globalThis.event = prevWinEvent;
    }
  }
  function fireListeners(node, event, capture) {
    if (!capture && node._attrs && !event._immediatePropagationStopped) {
      const attrName = "on" + event.type;
      const propHandler = typeof node[attrName] === "function" ? node[attrName] : null;
      const attrVal = propHandler ? null : node._attrs[attrName];
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
        } catch (e) {
          logThrew("on-attribute handler", e);
        }
      }
    }
    const list = node._listeners && node._listeners[event.type];
    if (!list || !list.length) return;
    event.currentTarget = node;
    for (const entry of list.slice()) {
      if (entry.capture !== capture) continue;
      if (event._immediatePropagationStopped) return;
      try {
        entry.handler.call(node, event);
      } catch (e) {
        logThrew("listener (event=" + event.type + ", tag=" + (node && node._tag) + ")", e);
      }
    }
  }

  // lib/capybara/simulated/js/src/events.js
  var Event = class {
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
    }
    // Lazy timeStamp: most dispatched events never have it read.
    // First access caches on the instance to satisfy "stable across
    // reads" expectations.
    get timeStamp() {
      const v = typeof globalThis.performance !== "undefined" && globalThis.performance.now ? globalThis.performance.now() : Date.now();
      Object.defineProperty(this, "timeStamp", { value: v, enumerable: true });
      return v;
    }
    preventDefault() {
      if (this.cancelable) this.defaultPrevented = true;
    }
    stopPropagation() {
      this._propagationStopped = true;
    }
    stopImmediatePropagation() {
      this._propagationStopped = true;
      this._immediatePropagationStopped = true;
    }
    // Bubbling chain from target to document to window. Real
    // browsers thread this through shadow boundaries; we walk
    // `_parent` only. Modern delegation (Stimulus / Lit) reads
    // composedPath() rather than walking currentTarget manually.
    composedPath() {
      const path = [];
      for (let n = this.target; n; n = n._parent) path.push(n);
      if (globalThis.document && !path.includes(globalThis.document)) path.push(globalThis.document);
      if (!path.includes(globalThis)) path.push(globalThis);
      return path;
    }
    get srcElement() {
      return this.target;
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
  var DOMException = class _DOMException extends Error {
    constructor(message = "", name = "Error") {
      super(message);
      this.name = name;
      this.code = _DOMException._codeFor(name);
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
    Object.defineProperty(DOMException, k, { value: v, enumerable: true });
    Object.defineProperty(DOMException.prototype, k, { value: v, enumerable: true });
  });
  var CustomEvent = class extends Event {
    constructor(type, init) {
      super(type, init);
      this.detail = init && init.detail !== void 0 ? init.detail : null;
    }
  };
  var UIEvent = class extends Event {
    constructor(type, init) {
      super(type, init);
      init = init || {};
      this.view = init.view || globalThis;
      this.detail = init.detail || 0;
    }
  };
  var FocusEvent = class extends UIEvent {
    constructor(type, init) {
      super(type, init);
      this.relatedTarget = init && init.relatedTarget || null;
    }
  };
  var WheelEvent = class extends UIEvent {
    constructor(type, init) {
      super(type, init);
      init = init || {};
      this.deltaX = init.deltaX || 0;
      this.deltaY = init.deltaY || 0;
      this.deltaZ = init.deltaZ || 0;
      this.deltaMode = init.deltaMode || 0;
    }
  };
  for (const [k, v] of [["DOM_DELTA_PIXEL", 0], ["DOM_DELTA_LINE", 1], ["DOM_DELTA_PAGE", 2]]) {
    Object.defineProperty(WheelEvent, k, { value: v, enumerable: true });
    Object.defineProperty(WheelEvent.prototype, k, { value: v, enumerable: true });
  }
  var CompositionEvent = class extends UIEvent {
    constructor(type, init) {
      super(type, init);
      this.data = init && init.data != null ? String(init.data) : "";
    }
  };
  var TouchEvent = class extends UIEvent {
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
    constructor(type, init) {
      super(type, init);
      init = init || {};
      this.lengthComputable = !!init.lengthComputable;
      this.loaded = init.loaded || 0;
      this.total = init.total || 0;
    }
  };
  var PopStateEvent = class extends Event {
    constructor(type, init) {
      super(type, init);
      this.state = init && "state" in init ? init.state : null;
    }
  };
  var HashChangeEvent = class extends Event {
    constructor(type, init) {
      super(type, init);
      init = init || {};
      this.oldURL = init.oldURL || "";
      this.newURL = init.newURL || "";
    }
  };
  var StorageEvent = class extends Event {
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
    constructor(type, init) {
      super(type, init);
      init = init || {};
      this.promise = init.promise || null;
      this.reason = init.reason;
    }
  };
  var AnimationEvent = class extends Event {
    constructor(type, init) {
      super(type, init);
      init = init || {};
      this.animationName = init.animationName || "";
      this.elapsedTime = init.elapsedTime || 0;
      this.pseudoElement = init.pseudoElement || "";
    }
  };
  var TransitionEvent = class extends Event {
    constructor(type, init) {
      super(type, init);
      init = init || {};
      this.propertyName = init.propertyName || "";
      this.elapsedTime = init.elapsedTime || 0;
      this.pseudoElement = init.pseudoElement || "";
    }
  };
  var FormDataEvent = class extends Event {
    constructor(type, init) {
      super(type, init);
      this.formData = init && init.formData || null;
    }
  };
  var BeforeUnloadEvent = class extends Event {
    constructor(type, init) {
      super(type, init);
      this.returnValue = "";
    }
  };
  var MouseEvent = class extends UIEvent {
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
  };
  var PointerEvent = class extends MouseEvent {
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
    constructor(type, init) {
      super(type, init);
      this.dataTransfer = init && init.dataTransfer || null;
    }
  };
  var KeyboardEvent = class extends UIEvent {
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
  };
  for (const [k, v] of [["DOM_KEY_LOCATION_STANDARD", 0], ["DOM_KEY_LOCATION_LEFT", 1], ["DOM_KEY_LOCATION_RIGHT", 2], ["DOM_KEY_LOCATION_NUMPAD", 3]]) {
    Object.defineProperty(KeyboardEvent, k, { value: v, enumerable: true });
    Object.defineProperty(KeyboardEvent.prototype, k, { value: v, enumerable: true });
  }
  var InputEvent = class extends UIEvent {
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
    constructor(type, init) {
      super(type, init);
      this.submitter = init && init.submitter || null;
    }
  };
  var ClipboardEvent = class extends Event {
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
  var EventTarget = class {
    constructor() {
      Object.defineProperty(this, "_etListeners", { value: /* @__PURE__ */ new Map(), enumerable: false });
    }
    addEventListener(type, handler) {
      if (typeof handler !== "function" && !(handler && typeof handler.handleEvent === "function")) return;
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
          if (typeof h === "function") h.call(this, event);
          else h.handleEvent.call(h, event);
        } catch (e) {
          logThrew("EventTarget listener", e);
        }
      }
      return !event.defaultPrevented;
    }
  };
  var ON_HANDLER_NAMES = "abort blur cancel canplay canplaythrough change click close contextmenu copy cuechange cut dblclick drag dragend dragenter dragexit dragleave dragover dragstart drop durationchange emptied ended error focus formdata input invalid keydown keypress keyup load loadeddata loadedmetadata loadstart mousedown mouseenter mouseleave mousemove mouseout mouseover mouseup paste pause play playing pointercancel pointerdown pointerenter pointerleave pointermove pointerout pointerover pointerup progress ratechange reset resize scroll seeked seeking select selectstart selectionchange show stalled submit suspend timeupdate toggle touchcancel touchend touchmove touchstart transitioncancel transitionend transitionrun transitionstart volumechange waiting wheel".split(/\s+/);
  function installOnHandlerSlots(Element2) {
    for (const n of ON_HANDLER_NAMES) {
      const prop = "on" + n;
      if (!(prop in Element2.prototype)) Element2.prototype[prop] = null;
    }
  }

  // lib/capybara/simulated/js/src/selector-parser.js
  function readIdent(s, i) {
    const len = s.length;
    let out = "";
    while (i < len) {
      const c = s[i];
      if (/[\w-]/.test(c)) {
        out += c;
        i++;
        continue;
      }
      if (c === "\\") {
        if (i + 1 >= len) break;
        const next = s[i + 1];
        if (/[0-9a-fA-F]/.test(next)) {
          let j = i + 1, hex = "";
          while (j < len && hex.length < 6 && /[0-9a-fA-F]/.test(s[j])) {
            hex += s[j];
            j++;
          }
          if (j < len && /\s/.test(s[j])) j++;
          out += String.fromCodePoint(parseInt(hex, 16));
          i = j;
          continue;
        }
        out += next;
        i += 2;
        continue;
      }
      break;
    }
    return [out, i];
  }
  function tokenizeSelector(s) {
    const tokens = [];
    let i = 0;
    const len = s.length;
    while (i < len) {
      const c = s[i];
      if (c === " " || c === "	" || c === "\n" || c === "\r" || c === "\f") {
        while (i < len && /\s/.test(s[i])) i++;
        tokens.push({ kind: "ws" });
        continue;
      }
      if (c === ">") {
        tokens.push({ kind: "gt" });
        i++;
        continue;
      }
      if (c === "+") {
        tokens.push({ kind: "plus" });
        i++;
        continue;
      }
      if (c === "~") {
        tokens.push({ kind: "tilde" });
        i++;
        continue;
      }
      if (c === ",") {
        tokens.push({ kind: "comma" });
        i++;
        continue;
      }
      if (c === "*") {
        tokens.push({ kind: "star" });
        i++;
        continue;
      }
      if (c === "#") {
        const [name, j] = readIdent(s, i + 1);
        if (j === i + 1) throw new SyntaxError("csim: bad #id at " + i);
        tokens.push({ kind: "hash", value: name });
        i = j;
        continue;
      }
      if (c === ".") {
        const [name, j] = readIdent(s, i + 1);
        if (j === i + 1) throw new SyntaxError("csim: bad .class at " + i);
        tokens.push({ kind: "class", value: name });
        i = j;
        continue;
      }
      if (c === "[") {
        let depth = 1, j = i + 1;
        while (j < len && depth > 0) {
          if (s[j] === "[") depth++;
          else if (s[j] === "]") depth--;
          if (depth > 0) j++;
        }
        if (j >= len) throw new SyntaxError("csim: unterminated [attr] at " + i);
        tokens.push({ kind: "attr", value: s.slice(i + 1, j) });
        i = j + 1;
        continue;
      }
      if (c === ":") {
        let j = i + 1;
        if (s[j] === ":") j++;
        const nameStart = j;
        while (j < len && /[\w-]/.test(s[j])) j++;
        const name = s.slice(nameStart, j);
        if (!name) throw new SyntaxError("csim: bad pseudo at " + i);
        let args = null;
        if (s[j] === "(") {
          let depth = 1, k = j + 1;
          while (k < len && depth > 0) {
            if (s[k] === "(") depth++;
            else if (s[k] === ")") depth--;
            if (depth > 0) k++;
          }
          if (k >= len) throw new SyntaxError("csim: unterminated pseudo args at " + i);
          args = s.slice(j + 1, k);
          j = k + 1;
        }
        tokens.push({ kind: "pseudo", value: name, args });
        i = j;
        continue;
      }
      if (/[a-zA-Z_]/.test(c)) {
        let j = i;
        while (j < len && /[\w-]/.test(s[j])) j++;
        tokens.push({ kind: "tag", value: s.slice(i, j) });
        i = j;
        continue;
      }
      if (c === "&") {
        throw new SyntaxError("csim: stray & in selector");
      }
      throw new SyntaxError("csim: unexpected selector char: " + JSON.stringify(c) + " at " + i);
    }
    return tokens;
  }
  function parseAttrToken(s) {
    const m = /^\s*((?:\\.|[\w-])+)\s*(?:([~|^$*]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\s\]]+)))?\s*([isIS])?\s*$/.exec(s);
    if (!m) throw new SyntaxError("csim: bad attr selector: " + s);
    const flag = m[6];
    return {
      name: m[1].replace(/\\(.)/g, "$1").toLowerCase(),
      op: m[2] || null,
      value: m[3] != null ? m[3] : m[4] != null ? m[4] : m[5] || "",
      ci: flag === "i" || flag === "I"
    };
  }
  var PSEUDO_NO_ARG = /* @__PURE__ */ new Set([
    "first-child",
    "last-child",
    "only-child",
    "first-of-type",
    "last-of-type",
    "only-of-type",
    "empty",
    "root",
    "scope",
    "checked",
    "disabled",
    "enabled",
    "required",
    "optional",
    "read-only",
    "read-write",
    "hover",
    "focus",
    "focus-within",
    "focus-visible",
    "active",
    "visited",
    "link",
    "target",
    "placeholder-shown",
    "default",
    "indeterminate",
    "valid",
    "invalid",
    "user-valid",
    "user-invalid"
  ]);
  var PSEUDO_NTH = /* @__PURE__ */ new Set([
    "nth-child",
    "nth-last-child",
    "nth-of-type",
    "nth-last-of-type"
  ]);
  function parsePseudoToken(name, args) {
    const n = name.toLowerCase();
    if (n === "not" || n === "is" || n === "where" || n === "has") {
      if (args == null) throw new SyntaxError("csim: " + n + " needs args");
      return { name: n, list: parseSelector(args) };
    }
    if (PSEUDO_NTH.has(n)) {
      if (args == null) throw new SyntaxError("csim: " + n + " needs args");
      const ofMatch = /\s+of\s+/i.exec(args);
      if (ofMatch && (n === "nth-child" || n === "nth-last-child")) {
        return {
          name: n,
          nth: parseNth(args.slice(0, ofMatch.index)),
          ofList: parseSelector(args.slice(ofMatch.index + ofMatch[0].length))
        };
      }
      return { name: n, nth: parseNth(args) };
    }
    if (n === "dir" || n === "lang") {
      if (args == null) throw new SyntaxError("csim: " + n + " needs args");
      return { name: n, value: args.trim().toLowerCase().replace(/['"]/g, "") };
    }
    if (PSEUDO_NO_ARG.has(n)) return { name: n };
    if (n === "before" || n === "after" || n === "first-letter" || n === "first-line" || n === "placeholder" || n === "selection" || n === "marker" || n === "backdrop") {
      return { name: "__never_match__" };
    }
    throw new SyntaxError("csim: unsupported pseudo :" + n);
  }
  function parseNth(s) {
    const t = s.trim().toLowerCase();
    if (t === "odd") return { a: 2, b: 1 };
    if (t === "even") return { a: 2, b: 0 };
    const m = /^([+-]?\d*)n\s*([+-]\s*\d+)?$/.exec(t);
    if (m) {
      const aStr = m[1];
      const a = aStr === "" || aStr === "+" ? 1 : aStr === "-" ? -1 : parseInt(aStr, 10);
      const b = m[2] != null ? parseInt(m[2].replace(/\s+/g, ""), 10) : 0;
      return { a, b };
    }
    const mb = /^([+-]?\d+)$/.exec(t);
    if (mb) return { a: 0, b: parseInt(mb[1], 10) };
    throw new SyntaxError("csim: bad nth expression: " + s);
  }
  function parseSelector(sel) {
    const tokens = tokenizeSelector(String(sel).trim());
    const groups = [];
    let i = 0;
    while (i < tokens.length) {
      while (i < tokens.length && (tokens[i].kind === "ws" || tokens[i].kind === "comma")) i++;
      if (i >= tokens.length) break;
      const parsed = parseComplex(tokens, i);
      if (parsed.complex.length) groups.push(parsed.complex);
      i = parsed.next;
    }
    return groups;
  }
  function parseComplex(tokens, i) {
    const seq = [];
    let pendingCombinator = null;
    while (i < tokens.length) {
      const t = tokens[i];
      if (t.kind === "comma") break;
      if (t.kind === "ws") {
        let j = i + 1;
        while (j < tokens.length && tokens[j].kind === "ws") j++;
        if (j >= tokens.length || tokens[j].kind === "comma") {
          i = j;
          continue;
        }
        if (tokens[j].kind === "gt" || tokens[j].kind === "plus" || tokens[j].kind === "tilde") {
          i = j;
          continue;
        }
        if (seq.length > 0 && pendingCombinator == null) pendingCombinator = "descendant";
        i = j;
        continue;
      }
      if (t.kind === "gt") {
        pendingCombinator = "child";
        i++;
        continue;
      }
      if (t.kind === "plus") {
        pendingCombinator = "adjacent";
        i++;
        continue;
      }
      if (t.kind === "tilde") {
        pendingCombinator = "sibling";
        i++;
        continue;
      }
      const parsed = parseCompound(tokens, i);
      parsed.compound.combinator = seq.length === 0 ? null : pendingCombinator || "descendant";
      seq.push(parsed.compound);
      pendingCombinator = null;
      i = parsed.next;
    }
    return { complex: seq, next: i };
  }
  function parseCompound(tokens, i) {
    const c = { tag: null, id: null, classes: [], attrs: [], pseudos: [], combinator: null };
    let consumed = false;
    while (i < tokens.length) {
      const t = tokens[i];
      if (t.kind === "tag") {
        c.tag = t.value.toLowerCase();
        consumed = true;
        i++;
        continue;
      }
      if (t.kind === "star") {
        consumed = true;
        i++;
        continue;
      }
      if (t.kind === "hash") {
        c.id = t.value;
        consumed = true;
        i++;
        continue;
      }
      if (t.kind === "class") {
        c.classes.push(t.value);
        consumed = true;
        i++;
        continue;
      }
      if (t.kind === "attr") {
        c.attrs.push(parseAttrToken(t.value));
        consumed = true;
        i++;
        continue;
      }
      if (t.kind === "pseudo") {
        c.pseudos.push(parsePseudoToken(t.value, t.args));
        consumed = true;
        i++;
        continue;
      }
      break;
    }
    if (!consumed) throw new SyntaxError("csim: empty compound selector");
    return { compound: c, next: i };
  }
  function matchUnit(el, u) {
    if (el.nodeType !== NODE_ELEMENT) return false;
    if (u.tag && el._tag !== u.tag) return false;
    if (u.id && el._attrs.id !== u.id) return false;
    if (u.classes && u.classes.length) {
      const cs = classes(el);
      for (const c of u.classes) if (!cs.includes(c)) return false;
    }
    if (u.attrs) {
      for (const a of u.attrs) if (!matchAttr(el, a)) return false;
    }
    if (u.pseudos) {
      for (const p of u.pseudos) if (!matchPseudo(el, p)) return false;
    }
    return true;
  }
  function matchAttr(el, a) {
    let v = el._attrs[a.name];
    if (a.op == null) return v != null;
    if (v == null) return false;
    let needle = a.value;
    if (a.ci) {
      v = v.toLowerCase();
      needle = needle.toLowerCase();
    }
    switch (a.op) {
      case "=":
        return v === needle;
      case "~=":
        return v.split(/\s+/).includes(needle);
      case "^=":
        return needle !== "" && v.startsWith(needle);
      case "$=":
        return needle !== "" && v.endsWith(needle);
      case "*=":
        return needle !== "" && v.indexOf(needle) >= 0;
      case "|=":
        return v === needle || v.startsWith(needle + "-");
    }
    return false;
  }
  function elementSiblings(el) {
    if (!el._parent) return [];
    return el._parent._children.filter((n) => n.nodeType === NODE_ELEMENT);
  }
  function elementSiblingsOfType(el) {
    if (!el._parent) return [];
    return el._parent._children.filter((n) => n.nodeType === NODE_ELEMENT && n._tag === el._tag);
  }
  function prevElementSibling(el) {
    if (!el._parent) return null;
    const sibs = el._parent._children;
    const idx = sibs.indexOf(el);
    for (let i = idx - 1; i >= 0; i--) {
      if (sibs[i].nodeType === NODE_ELEMENT) return sibs[i];
    }
    return null;
  }
  function nthMatches(position, nth) {
    const { a, b } = nth;
    if (a === 0) return position === b;
    const diff = position - b;
    if (a > 0) return diff >= 0 && diff % a === 0;
    return diff <= 0 && diff % a === 0;
  }
  var focusPseudoMatchers = {
    focus: (el) => globalThis.document && globalThis.document._activeElement === el,
    "focus-visible": (el) => globalThis.document && globalThis.document._activeElement === el,
    "focus-within": (el) => {
      const active = globalThis.document && globalThis.document._activeElement;
      if (!active) return false;
      for (let cur = active; cur; cur = cur._parent) if (cur === el) return true;
      return false;
    }
  };
  function hasMatchInDescendants(root, seq) {
    const stack = [root];
    while (stack.length) {
      const cur = stack.pop();
      if (cur !== root && cur.nodeType === NODE_ELEMENT && matchComplex(cur, seq)) return true;
      if (cur._children) for (const c of cur._children) {
        if (c.nodeType === NODE_ELEMENT) stack.push(c);
      }
    }
    return false;
  }
  function matchPseudo(el, p) {
    switch (p.name) {
      case "__never_match__":
        return false;
      case "not":
        return !p.list.some((seq) => matchComplex(el, seq));
      case "is":
      case "where":
        return p.list.some((seq) => matchComplex(el, seq));
      case "has": {
        const prev = __scopeRoot;
        __scopeRoot = el;
        try {
          for (const seq of p.list) {
            if (hasMatchInDescendants(el, seq)) return true;
          }
          return false;
        } finally {
          __scopeRoot = prev;
        }
      }
      case "first-child": {
        const sibs = elementSiblings(el);
        return sibs.length > 0 && sibs[0] === el;
      }
      case "last-child": {
        const sibs = elementSiblings(el);
        return sibs.length > 0 && sibs[sibs.length - 1] === el;
      }
      case "only-child": {
        const sibs = elementSiblings(el);
        return sibs.length === 1 && sibs[0] === el;
      }
      case "first-of-type": {
        const sibs = elementSiblingsOfType(el);
        return sibs.length > 0 && sibs[0] === el;
      }
      case "last-of-type": {
        const sibs = elementSiblingsOfType(el);
        return sibs.length > 0 && sibs[sibs.length - 1] === el;
      }
      case "only-of-type": {
        const sibs = elementSiblingsOfType(el);
        return sibs.length === 1 && sibs[0] === el;
      }
      case "nth-child": {
        let sibs = elementSiblings(el);
        if (p.ofList) {
          sibs = sibs.filter((s) => p.ofList.some((seq) => matchComplex(s, seq)));
        }
        const idx = sibs.indexOf(el);
        return idx >= 0 && nthMatches(idx + 1, p.nth);
      }
      case "nth-last-child": {
        let sibs = elementSiblings(el);
        if (p.ofList) {
          sibs = sibs.filter((s) => p.ofList.some((seq) => matchComplex(s, seq)));
        }
        const idx = sibs.indexOf(el);
        return idx >= 0 && nthMatches(sibs.length - idx, p.nth);
      }
      case "nth-of-type": {
        const sibs = elementSiblingsOfType(el);
        const idx = sibs.indexOf(el);
        return idx >= 0 && nthMatches(idx + 1, p.nth);
      }
      case "nth-last-of-type": {
        const sibs = elementSiblingsOfType(el);
        const idx = sibs.indexOf(el);
        return idx >= 0 && nthMatches(sibs.length - idx, p.nth);
      }
      case "empty":
        for (const c of el._children) {
          if (c.nodeType === NODE_TEXT) {
            if (c.data && c.data.length > 0) return false;
          } else if (c.nodeType === NODE_ELEMENT) {
            return false;
          }
        }
        return true;
      case "root":
        return el._parent && el._parent.nodeType === NODE_DOC;
      case "checked": {
        if (el._tag === "option") return el._attrs.selected != null;
        const t = (el._attrs.type || "").toLowerCase();
        if (el._tag === "input" && (t === "checkbox" || t === "radio")) return el._attrs.checked != null;
        return false;
      }
      case "disabled":
        return el._attrs.disabled != null;
      case "enabled":
        return el._attrs.disabled == null;
      case "required":
        return el._attrs.required != null;
      case "optional":
        return el._attrs.required == null;
      case "read-only":
        return el._attrs.readonly != null;
      case "read-write":
        return el._attrs.readonly == null;
      // We don't drive a real focus/hover state machine yet, so these
      // are conservatively false. jQuery's `:hover` / `:focus` filters
      // fall back to its own DOM-state check, so this only affects
      // cascade rules that gate on them — and those rules generally
      // *reveal* content rather than hide it (so reporting false here
      // keeps the element visibility-stable until a real test cares).
      case "scope":
        return __scopeRoot != null && el === __scopeRoot;
      case "hover": {
        const hov = globalThis.document && globalThis.document._hoverElement;
        if (!hov) return false;
        let cur = hov;
        while (cur) {
          if (cur === el) return true;
          cur = cur._parent;
        }
        return false;
      }
      case "focus":
      case "focus-visible":
      case "focus-within":
        return focusPseudoMatchers[p.name](el);
      case "active":
        return false;
      case "visited":
        return false;
      case "link":
        return el._tag === "a" && el._attrs.href != null;
      case "target": {
        const id = el._attrs.id;
        if (!id) return false;
        const hash = globalThis.location && globalThis.location.hash || "";
        return hash.length > 1 && hash.slice(1) === id;
      }
      case "placeholder-shown": {
        if (el._tag !== "input" && el._tag !== "textarea") return false;
        if (el._attrs.placeholder == null) return false;
        const v = el._attrs.value;
        return v == null || v === "";
      }
      case "default": {
        if (el._tag === "option") return el._attrs.selected != null;
        if (el._tag === "input") {
          const t = (el._attrs.type || "").toLowerCase();
          if (t === "checkbox" || t === "radio") return el._attrs.checked != null;
          if (t === "submit" || t === "image") return true;
        }
        if (el._tag === "button") return (el._attrs.type || "submit").toLowerCase() === "submit";
        return false;
      }
      case "indeterminate":
        return el._indeterminate === true;
      case "valid":
        return true;
      case "invalid":
        return false;
      case "user-valid":
        return true;
      case "user-invalid":
        return false;
      case "dir": {
        const want = (p.value || "").toLowerCase();
        let cur = el;
        while (cur && cur.nodeType === NODE_ELEMENT) {
          const d = cur._attrs && cur._attrs.dir;
          if (d) return d.toLowerCase() === want;
          cur = cur._parent;
        }
        return want === "ltr";
      }
      case "lang": {
        const want = (p.value || "").toLowerCase();
        let cur = el;
        while (cur && cur.nodeType === NODE_ELEMENT) {
          const l = cur._attrs && cur._attrs.lang;
          if (l) {
            const v = String(l).toLowerCase();
            return v === want || v.startsWith(want + "-");
          }
          cur = cur._parent;
        }
        return false;
      }
    }
    return false;
  }
  function matchComplex(el, seq) {
    if (!seq.length) return false;
    if (!matchUnit(el, seq[seq.length - 1])) return false;
    let cur = el;
    for (let i = seq.length - 2; i >= 0; i--) {
      const combinator = seq[i + 1].combinator;
      if (combinator === "child") {
        cur = cur._parent;
        if (!cur || cur.nodeType !== NODE_ELEMENT || !matchUnit(cur, seq[i])) return false;
      } else if (combinator === "adjacent") {
        cur = prevElementSibling(cur);
        if (!cur || !matchUnit(cur, seq[i])) return false;
      } else if (combinator === "sibling") {
        let s = prevElementSibling(cur);
        while (s && !matchUnit(s, seq[i])) s = prevElementSibling(s);
        if (!s) return false;
        cur = s;
      } else {
        cur = cur._parent;
        while (cur && cur.nodeType === NODE_ELEMENT && !matchUnit(cur, seq[i])) cur = cur._parent;
        if (!cur || cur.nodeType !== NODE_ELEMENT) return false;
      }
    }
    return true;
  }
  function matchOne(el, group) {
    for (const seq of group) if (matchComplex(el, seq)) return true;
    return false;
  }
  function specificity(seq) {
    let a = 0, b = 0, c = 0;
    for (const u of seq) {
      if (u.id) a++;
      if (u.classes && u.classes.length) b += u.classes.length;
      if (u.attrs && u.attrs.length) b += u.attrs.length;
      if (u.pseudos) for (const p of u.pseudos) {
        if (p.name === "where") continue;
        if (p.name === "not" || p.name === "is" || p.name === "has") {
          let max = [0, 0, 0];
          for (const inner of p.list) {
            const s = specificity(inner);
            if (compareSpec(s, max) > 0) max = s;
          }
          a += max[0];
          b += max[1];
          c += max[2];
          continue;
        }
        b++;
      }
      if (u.tag) c++;
    }
    return [a, b, c];
  }
  function compareSpec(s1, s2) {
    if (s1[0] !== s2[0]) return s1[0] - s2[0];
    if (s1[1] !== s2[1]) return s1[1] - s2[1];
    return s1[2] - s2[2];
  }
  var __scopeRoot = null;
  function findById(root, id) {
    if (!root || id == null) return null;
    const target = String(id);
    if (target.length === 0) return null;
    let hit = null;
    walk(root, (el) => {
      if (!hit && el._attrs && el._attrs.id === target) hit = el;
    });
    return hit;
  }

  // lib/capybara/simulated/js/src/selectors.js
  var cssSelect = globalThis.__csimVendor.cssSelect;
  var adapter = {
    isTag: (n) => n && n.nodeType === NODE_ELEMENT,
    existsOne(test, elems) {
      return this.findOne(test, elems) !== null;
    },
    getAttributeValue: (el, name) => el._attrs[name] == null ? void 0 : el._attrs[name],
    getChildren: (n) => n._children,
    getName: (el) => el._tag,
    getParent: (n) => n._parent,
    getSiblings: (n) => n._parent ? n._parent._children : [n],
    prevElementSibling: (n) => n.previousElementSibling,
    getText: (n) => n.textContent,
    hasAttrib: (el, name) => Object.prototype.hasOwnProperty.call(el._attrs, name),
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
      const visit = (el) => {
        if (test(el)) out.push(el);
      };
      for (const n of nodes) walk(n, visit);
      return out;
    },
    findOne(test, nodes) {
      let hit = null;
      const visit = (el) => {
        if (!hit && test(el)) hit = el;
      };
      for (const n of nodes) {
        if (hit) break;
        walk(n, visit);
      }
      return hit;
    },
    equals: (a, b) => a === b,
    // No real layout → :hover/:visited/:active never apply at the
    // matcher level. The cascade has its own `:hover` propagation.
    isHovered: () => false,
    isVisited: () => false,
    isActive: () => false
  };
  var userPseudos = { ...focusPseudoMatchers };
  function normaliseScopedSelector(sel) {
    if (typeof sel !== "string") return sel;
    const trimmed = sel.replace(/^\s+/, "");
    if (trimmed.startsWith(">") || trimmed.startsWith("+") || trimmed.startsWith("~")) {
      return ":scope " + trimmed;
    }
    return sel;
  }
  var compiledCacheNoScope = /* @__PURE__ */ new Map();
  var compiledCacheScoped = /* @__PURE__ */ new WeakMap();
  function selectorNeedsScope(key) {
    return key.indexOf(":scope") !== -1;
  }
  function compile(sel, scopeRoot) {
    const key = normaliseScopedSelector(sel);
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
  function compileRaw(key, context) {
    try {
      return cssSelect.compile(key, { adapter, pseudos: userPseudos, cacheResults: false }, context);
    } catch (e) {
      throw new Error("csim: " + (e && e.message ? e.message : e));
    }
  }
  function selectAll(roots, sel, scopeRoot) {
    return adapter.findAll(compile(sel, scopeRoot), roots);
  }
  function selectFirst(roots, sel, scopeRoot) {
    return adapter.findOne(compile(sel, scopeRoot), roots);
  }
  function matchesSelector(el, sel) {
    return el && el.nodeType === NODE_ELEMENT && compile(sel)(el);
  }
  function closestSelector(el, sel) {
    const fn = compile(sel);
    for (let cur = el; cur; cur = cur._parent) {
      if (cur.nodeType === NODE_ELEMENT && fn(cur)) return cur;
    }
    return null;
  }

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
  var LABELABLE = /* @__PURE__ */ new Set(["button", "input", "meter", "output", "progress", "select", "textarea"]);
  function labeledControlFor(label) {
    const forId = label._attrs.for;
    if (forId) {
      const root = globalThis.document.documentElement;
      if (root) {
        const hit = selectFirst([root], "#" + forId);
        if (hit) return hit;
      }
    }
    const stack = [label];
    while (stack.length) {
      const cur = stack.shift();
      for (const c of cur._children) {
        if (c.nodeType !== NODE_ELEMENT) continue;
        if (LABELABLE.has(c._tag)) {
          if (c._tag === "input" && (c._attrs.type || "").toLowerCase() === "hidden") continue;
          return c;
        }
        stack.push(c);
      }
    }
    return null;
  }
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
  function isContenteditable(n) {
    return contenteditableHost(n) != null;
  }
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
  function ancestorForm(n) {
    let cur = n._parent;
    while (cur && cur.nodeType === NODE_ELEMENT) {
      if (cur._tag === "form") return cur;
      cur = cur._parent;
    }
    return null;
  }
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
  function toggleChecked(n) {
    if (n._attrs.checked != null) delete n._attrs.checked;
    else n._attrs.checked = "";
  }
  function formNamedAccess(form) {
    if (form._namedAccessProxy) return form._namedAccessProxy;
    const proxy = new Proxy(form, {
      get(target, key) {
        if (key in target) return target[key];
        if (typeof key !== "string") return target[key];
        for (const f of target.elements || []) {
          if (f._attrs && (f._attrs.name === key || f._attrs.id === key)) return f;
        }
        return void 0;
      }
    });
    form._namedAccessProxy = proxy;
    return proxy;
  }
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
      const walk2 = (node) => {
        if (node && node.nodeType === 1) {
          const ctor = registry.get(node._tag);
          if (ctor && Object.getPrototypeOf(node) !== ctor.prototype) {
            upgradeElement(node, ctor);
          }
        }
        if (node && node._children) for (const c of node._children) walk2(c);
      };
      walk2(root);
    }
  };
  function getCustomElementCtor(tag) {
    return registry.get(tag);
  }
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
  function fireCEHook(el, hookName) {
    try {
      const fn = el[hookName];
      if (typeof fn === "function") fn.call(el);
    } catch (e) {
      logThrew("custom element " + hookName, e);
    }
  }
  function fireAttrChangedCallback(el, name, oldValue, newValue, ElementCtor) {
    if (!el || el.nodeType !== NODE_ELEMENT) return;
    const ctor = el.constructor;
    if (!ctor || ctor === ElementCtor) return;
    const observed = ctor.observedAttributes;
    if (!observed || observed.indexOf(name) < 0) return;
    const fn = el.attributeChangedCallback;
    if (typeof fn !== "function") return;
    try {
      fn.call(el, name, oldValue, newValue, null);
    } catch (e) {
      logThrew("attributeChangedCallback", e);
    }
  }
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
  function ceUpgradeTree(subtree) {
    walk(subtree, (el) => {
      const ctor = registry.get(el._tag);
      if (!ctor) return;
      if (Object.getPrototypeOf(el) !== ctor.prototype) upgradeElement(el, ctor);
    });
  }
  function ceTryConnect(el) {
    const ctor = registry.get(el._tag);
    if (!ctor) return;
    if (Object.getPrototypeOf(el) !== ctor.prototype) upgradeElement(el, ctor);
    fireCEHook(el, "connectedCallback");
  }
  function fireCEDisconnect(subtree) {
    walk(subtree, (el) => {
      if (registry.has(el._tag)) fireCEHook(el, "disconnectedCallback");
    });
  }
  globalThis.customElements = customElements;

  // lib/capybara/simulated/js/src/html-parser.js
  var VOID = /* @__PURE__ */ new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
  var RAWTEXT = /* @__PURE__ */ new Set(["script", "style"]);
  function installHtmlParser({ Document: Document2, Element: Element2, Text: Text2, DocumentFragment: DocumentFragment2 }) {
    function parseDocument2(html) {
      const doc = new Document2();
      const root = new Element2("html");
      doc.documentElement = root;
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
      for (const table of body.querySelectorAll("table")) wrapLooseTrs(table);
      return doc;
    }
    function wrapLooseTrs(table) {
      const kids = table._children;
      if (!kids) return;
      const isWs = (k) => k.nodeType === NODE_TEXT && /^\s*$/.test(String(k.data || ""));
      const isTr = (k) => k.nodeType === NODE_ELEMENT && k._tag === "tr";
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
          } else if (isWs(k)) {
            let p = j + 1;
            while (p < kids.length && isWs(kids[p])) p++;
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
    function stripHtmlWrapper(html) {
      const htmlMatch = /<html\b([^>]*)>/i.exec(html);
      const headMatch = /<head\b([^>]*)>([\s\S]*?)<\/head>/i.exec(html);
      const bodyMatch = /<body\b([^>]*)>([\s\S]*?)<\/body>/i.exec(html);
      const head = headMatch ? headMatch[2] : "";
      const body = bodyMatch ? bodyMatch[2] : "";
      const htmlAttrs = htmlMatch ? htmlMatch[1] : "";
      const headAttrs = headMatch ? headMatch[1] : "";
      const bodyAttrs = bodyMatch ? bodyMatch[1] : "";
      if (bodyMatch) return { head, body, htmlAttrs, headAttrs, bodyAttrs };
      return {
        head,
        htmlAttrs,
        headAttrs,
        bodyAttrs,
        body: html.replace(/<!doctype[^>]*>/i, "").replace(/<\/?html\b[^>]*>/gi, "")
      };
    }
    function parseFragment2(html) {
      const out = [];
      const stack = [];
      let target = out;
      const pushChild = (child) => {
        const frame = stack.length ? stack[stack.length - 1] : null;
        child._parent = frame ? frame.parentForChildren : null;
        target.push(child);
      };
      const re = /<!--(?:>|->|[\s\S]*?-->)|<(\/?)([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
      let m, last = 0;
      while ((m = re.exec(html)) !== null) {
        if (m.index > last) {
          const text = html.slice(last, m.index);
          if (text.length) pushChild(makeText(text));
        }
        if (m[0].startsWith("<!--")) {
          last = re.lastIndex;
          continue;
        }
        const closing = m[1] === "/";
        const tag = m[2].toLowerCase();
        const rest = m[3];
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
        const el = new Element2(tag);
        applyAttributes(el, rest);
        pushChild(el);
        if (VOID.has(tag) || /\/\s*$/.test(rest)) continue;
        if (RAWTEXT.has(tag)) {
          const closeRe = new RegExp("</" + tag + "\\s*>", "i");
          const closeIdx = html.search.call(html.slice(last), closeRe);
          const absIdx = closeIdx < 0 ? html.length : last + closeIdx;
          const raw = html.slice(last, absIdx);
          if (raw.length) {
            const t = makeText(raw);
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
    function makeText(s) {
      return new Text2(decodeEntities(s));
    }
    function applyAttributes(el, rest) {
      const re = /([a-zA-Z_:][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
      let m;
      while ((m = re.exec(rest)) !== null) {
        const v = m[2] != null ? m[2] : m[3] != null ? m[3] : m[4] != null ? m[4] : "";
        el.setAttribute(m[1], decodeEntities(v));
      }
    }
    return { parseDocument: parseDocument2, parseFragment: parseFragment2 };
  }
  function serializeElement(el) {
    if (!el || !el._tag || !el._attrs) return "";
    const attrs = Object.keys(el._attrs).map((n) => " " + n + '="' + escapeAttr(el._attrs[n]) + '"').join("");
    if (VOID.has(el._tag)) return "<" + el._tag + attrs + ">";
    return "<" + el._tag + attrs + ">" + serializeChildren(el) + "</" + el._tag + ">";
  }
  function serializeChildren(el) {
    let s = "";
    if (!el || !el._children) return s;
    for (const c of el._children) {
      if (c.nodeType === NODE_TEXT) s += escapeText(c.data);
      else if (c.nodeType === NODE_COMMENT) s += "<!--" + String(c.data == null ? "" : c.data) + "-->";
      else s += serializeElement(c);
    }
    return s;
  }
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
  function escapeAttr(v) {
    return String(v).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  }
  function escapeText(v) {
    return String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

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

  // lib/capybara/simulated/js/src/media-query.js
  function mediaMatches(text, vp) {
    if (!text) return true;
    for (const q of splitTopLevel(text, ",")) {
      if (singleMediaMatches(q.trim(), vp)) return true;
    }
    return false;
  }
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
  function splitMediaAnd(s) {
    const out = [];
    let depth = 0, start = 0;
    const lower = s.toLowerCase();
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      else if (depth === 0 && lower.startsWith(" and ", i)) {
        out.push(s.slice(start, i));
        i += 4;
        start = i + 1;
      }
    }
    out.push(s.slice(start));
    return out;
  }
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
  function parseDppx(s) {
    const n = parseFloat(s);
    if (Number.isNaN(n)) return 1;
    if (/dppx$/.test(s)) return n;
    if (/dpi$/.test(s)) return n / DPI_PER_DPPX;
    if (/dpcm$/.test(s)) return n / DPCM_PER_DPPX;
    return n;
  }
  var VIEWPORT_DEFAULT = { width: 1024, height: 768 };
  function currentViewport() {
    return {
      width: Number(globalThis.innerWidth) || VIEWPORT_DEFAULT.width,
      height: Number(globalThis.innerHeight) || VIEWPORT_DEFAULT.height
    };
  }
  var MediaQueryList = class extends EventTarget {
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
  globalThis.matchMedia = function matchMedia(query) {
    const mql = new MediaQueryList(String(query || ""));
    _activeQueries.push(mql);
    return mql;
  };
  globalThis.__csimViewportChanged = function() {
    for (const mql of _activeQueries) {
      const now = mediaMatches(mql.media, currentViewport());
      if (now !== mql._lastMatches) {
        mql._lastMatches = now;
        dispatchWithOnHandler(mql, { type: "change", matches: now, media: mql.media });
      }
    }
  };

  // lib/capybara/simulated/js/src/cascade.js
  var INVISIBLE_TAGS = /* @__PURE__ */ new Set(["head", "script", "style", "template", "noscript", "title"]);
  var DISPLAY_NONE_RE = /(^|;|\s)display\s*:\s*none\b/i;
  var VISIBILITY_HIDDEN_RE = /(^|;|\s)visibility\s*:\s*hidden\b/i;
  var DISPLAY_OTHER_RE = /(^|;|\s)display\s*:\s*(?!none\b)[^;]+/i;
  function isVisibleNode(el) {
    return isVisibleNodeImpl(el, false);
  }
  function isLaidOutNode(el) {
    return isVisibleNodeImpl(el, true);
  }
  function isVisibleNodeImpl(el, ignoreVisibility) {
    if (!el || el.nodeType !== NODE_ELEMENT) return false;
    if (INVISIBLE_TAGS.has(el._tag)) return false;
    if (el._tag === "input" && (el._attrs.type || "").toLowerCase() === "hidden") return false;
    let cur = el;
    while (cur) {
      if (cur.nodeType === NODE_DOC) return true;
      if (cur.nodeType === NODE_ELEMENT) {
        if (INVISIBLE_TAGS.has(cur._tag)) return false;
        if (selfHidden(cur, ignoreVisibility)) return false;
      }
      cur = cur._parent;
    }
    return false;
  }
  globalThis.__isVisibleNode = isVisibleNode;
  globalThis.__isLaidOutNode = isLaidOutNode;
  function selfHidden(el, ignoreVisibility = false) {
    if (el._attrs.hidden != null) return true;
    if (el._tag === "dialog" && el._attrs.open == null) return true;
    const style = el._attrs.style;
    if (style) {
      if (DISPLAY_NONE_RE.test(style)) return true;
      if (!ignoreVisibility && VISIBILITY_HIDDEN_RE.test(style)) return true;
      if (DISPLAY_OTHER_RE.test(style)) return false;
    }
    return matchesAnyHideRule(el, ignoreVisibility);
  }
  var state = {
    hideRules: [],
    layoutRules: [],
    hideIdx: null,
    layoutIdx: null,
    ruleSerial: 0
  };
  function rebuildCascade(doc) {
    doc = doc || globalThis.document;
    if (!doc || !doc.documentElement) return;
    const { hide, layout } = collectCascadeRules(doc);
    state.hideRules = hide;
    state.layoutRules = layout;
    state.hideIdx = state.layoutIdx = null;
    state.propCache = null;
  }
  function resetCascadeState() {
    state.hideRules = [];
    state.layoutRules = [];
    state.hideIdx = state.layoutIdx = null;
    state.propCache = null;
  }
  globalThis.__csimRebuildCascade = function() {
    rebuildCascade();
  };
  function stripCssComments(s) {
    return s.replace(/\/\*[\s\S]*?\*\//g, "");
  }
  function parseCssTree(text) {
    const s = stripCssComments(text);
    const out = parseCssBody(s, 0, false);
    return out.nodes;
  }
  function parseCssBody(s, start, inBlock) {
    const nodes = [];
    let i = start;
    while (i < s.length) {
      while (i < s.length && /\s/.test(s[i])) i++;
      if (i >= s.length) break;
      if (inBlock && s[i] === "}") {
        i++;
        return { nodes, next: i };
      }
      if (s[i] === "@") {
        const at = parseAtRule(s, i);
        nodes.push(at.node);
        i = at.next;
        continue;
      }
      const probe = scanToBreaker(s, i);
      if (probe.kind === "lbrace") {
        const selector = s.slice(i, probe.at).trim();
        const body = parseDeclsAndNested(s, probe.at + 1);
        nodes.push({ type: "rule", selector, decls: body.decls, children: body.children });
        i = body.next;
        continue;
      }
      i = probe.at + (probe.kind === "semi" ? 1 : 0);
      if (i <= start) i = s.length;
    }
    return { nodes, next: i };
  }
  function scanToBreaker(s, i) {
    let depth = 0;
    while (i < s.length) {
      const c = s[i];
      if (c === "\\" && i + 1 < s.length) {
        i += 2;
        continue;
      }
      if (c === '"' || c === "'") {
        const q = c;
        i++;
        while (i < s.length && s[i] !== q) {
          if (s[i] === "\\") i++;
          i++;
        }
        i++;
        continue;
      }
      if (c === "(" || c === "[") depth++;
      else if (c === ")" || c === "]") depth--;
      else if (depth === 0 && (c === "{" || c === ";" || c === "}")) {
        return { kind: c === "{" ? "lbrace" : c === ";" ? "semi" : "rbrace", at: i };
      }
      i++;
    }
    return { kind: "eof", at: i };
  }
  function parseAtRule(s, i) {
    i++;
    const start = i;
    while (i < s.length && /[a-zA-Z-]/.test(s[i])) i++;
    const name = s.slice(start, i).toLowerCase();
    const preStart = i;
    while (i < s.length && /\s/.test(s[i])) i++;
    const pStart = i;
    let depth = 0;
    while (i < s.length) {
      const c = s[i];
      if (c === "\\" && i + 1 < s.length) {
        i += 2;
        continue;
      }
      if (c === '"' || c === "'") {
        const q = c;
        i++;
        while (i < s.length && s[i] !== q) {
          if (s[i] === "\\") i++;
          i++;
        }
        i++;
        continue;
      }
      if (c === "(" || c === "[") depth++;
      else if (c === ")" || c === "]") depth--;
      else if (depth === 0 && (c === ";" || c === "{")) break;
      i++;
    }
    const prelude = s.slice(pStart, i).trim();
    if (i >= s.length || s[i] === ";") {
      return { node: { type: "at-rule", name, prelude, children: null }, next: i + 1 };
    }
    i++;
    if (name === "keyframes" || name === "font-face" || name === "page" || name === "counter-style" || name === "property" || name === "font-feature-values") {
      const skipped = skipBalancedBlock(s, i);
      return { node: { type: "at-rule", name, prelude, children: null }, next: skipped };
    }
    const body = parseDeclsAndNested(s, i);
    return {
      node: { type: "at-rule", name, prelude, children: body.children, decls: body.decls },
      next: body.next
    };
  }
  function skipBalancedBlock(s, i) {
    let depth = 1;
    while (i < s.length && depth > 0) {
      const c = s[i];
      if (c === "\\" && i + 1 < s.length) {
        i += 2;
        continue;
      }
      if (c === '"' || c === "'") {
        const q = c;
        i++;
        while (i < s.length && s[i] !== q) {
          if (s[i] === "\\") i++;
          i++;
        }
        i++;
        continue;
      }
      if (c === "{") depth++;
      else if (c === "}") depth--;
      i++;
    }
    return i;
  }
  function parseDeclsAndNested(s, i) {
    const decls = [];
    const children = [];
    while (i < s.length) {
      while (i < s.length && /\s/.test(s[i])) i++;
      if (i >= s.length) break;
      if (s[i] === "}") return { decls, children, next: i + 1 };
      if (s[i] === "@") {
        const at = parseAtRule(s, i);
        children.push(at.node);
        i = at.next;
        continue;
      }
      const probe = scanToBreaker(s, i);
      if (probe.kind === "lbrace") {
        const selector = s.slice(i, probe.at).trim();
        const body = parseDeclsAndNested(s, probe.at + 1);
        children.push({ type: "rule", selector, decls: body.decls, children: body.children });
        i = body.next;
        continue;
      }
      if (probe.kind === "semi" || probe.kind === "rbrace") {
        const declText = s.slice(i, probe.at).trim();
        if (declText) {
          const colonIdx = declText.indexOf(":");
          if (colonIdx > 0) {
            const prop = declText.slice(0, colonIdx).trim().toLowerCase();
            let value = declText.slice(colonIdx + 1).trim();
            let important = false;
            if (/!important\s*$/i.test(value)) {
              important = true;
              value = value.replace(/!important\s*$/i, "").trim();
            }
            if (prop === "display" || prop === "visibility" || prop === "text-transform" || prop === "white-space") {
              decls.push({ prop, value: value.toLowerCase(), important });
            } else if (prop === "top" || prop === "left" || prop === "width" || prop === "height") {
              decls.push({ prop, value: value.trim(), important });
            }
          }
        }
        if (probe.kind === "rbrace") return { decls, children, next: probe.at + 1 };
        i = probe.at + 1;
        continue;
      }
      break;
    }
    return { decls, children, next: i };
  }
  function containerMatches(prelude, vp) {
    const featureQuery = (prelude || "").replace(/^[^\s(]*\s*/, "");
    if (!featureQuery.trim().startsWith("(")) return true;
    return mediaMatches(featureQuery, vp);
  }
  function flattenCssTree(tree, vp) {
    const out = [];
    const stack = [];
    function walk2(nodes) {
      for (const node of nodes) {
        if (node.type === "at-rule") {
          if (node.name === "media") {
            if (mediaMatches(node.prelude, vp)) {
              if (node.decls && node.decls.length && stack.length) {
                out.push({ selectorText: stack[stack.length - 1], decls: node.decls });
              }
              walk2(node.children || []);
            }
            continue;
          }
          if (node.name === "supports") {
            if (node.decls && node.decls.length && stack.length) {
              out.push({ selectorText: stack[stack.length - 1], decls: node.decls });
            }
            walk2(node.children || []);
            continue;
          }
          if (node.name === "container") {
            if (!containerMatches(node.prelude, vp)) continue;
            if (node.decls && node.decls.length && stack.length) {
              out.push({ selectorText: stack[stack.length - 1], decls: node.decls });
            }
            walk2(node.children || []);
            continue;
          }
          continue;
        }
        const parentSel = stack.length ? stack[stack.length - 1] : null;
        const resolved = composeNestedSelector(node.selector, parentSel);
        if (node.decls && node.decls.length) {
          out.push({ selectorText: resolved, decls: node.decls });
        }
        if (node.children && node.children.length) {
          stack.push(resolved);
          walk2(node.children);
          stack.pop();
        }
      }
    }
    walk2(tree);
    return out;
  }
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
  function collectCascadeRules(doc) {
    const empty = { hide: [], layout: [] };
    if (!doc || !doc.documentElement) return empty;
    state.ruleSerial = 0;
    const vp = currentViewport();
    const hide = [];
    const layout = [];
    const consume = (cssText) => {
      let tree;
      try {
        tree = parseCssTree(cssText);
      } catch (_) {
        return;
      }
      for (const r of flattenCssTree(tree, vp)) {
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
          if (LAYOUT_PROPS.includes(d.prop)) captured[d.prop] = { value: d.value, important: d.important };
        }
        const hasHide = display != null || visibility != null;
        const hasLayout = Object.keys(captured).length > 0;
        if (!hasHide && !hasLayout) continue;
        for (const sel of splitTopLevel(r.selectorText, ",")) {
          const trimmed = sel.trim();
          if (!trimmed) continue;
          let group;
          try {
            group = parseSelector(trimmed);
          } catch (_) {
            continue;
          }
          if (!group || !group.length) continue;
          const spec = specificity(group[0]);
          const source = state.ruleSerial++;
          if (hasHide) hide.push({ group, spec, source, display, displayImp, visibility, visibilityImp });
          if (hasLayout) layout.push({ group, spec, source, captured });
        }
      }
    };
    for (const s of doc.documentElement.querySelectorAll("style")) {
      const txt = scriptText(s);
      if (txt) consume(txt);
    }
    for (const l of doc.documentElement.querySelectorAll("link")) {
      const rel = (l._attrs.rel || "").toLowerCase();
      if (!rel.split(/\s+/).includes("stylesheet")) continue;
      const href = l._attrs.href;
      if (!href) continue;
      try {
        const resp = globalThis.__rackFetch("GET", href, "", null, "follow");
        if (resp && resp.status < 400 && resp.body) consume(resp.body);
      } catch (_) {
      }
    }
    return { hide, layout };
  }
  function buildRuleIndex(rules) {
    const idx = {
      byTag: /* @__PURE__ */ new Map(),
      byId: /* @__PURE__ */ new Map(),
      byClass: /* @__PURE__ */ new Map(),
      universal: []
    };
    for (const r of rules) {
      const seq = r.group[0];
      const term = seq[seq.length - 1];
      let bucket;
      if (term.classes && term.classes.length) {
        const key = term.classes[0];
        bucket = idx.byClass.get(key);
        if (!bucket) idx.byClass.set(key, bucket = []);
      } else if (term.id) {
        bucket = idx.byId.get(term.id);
        if (!bucket) idx.byId.set(term.id, bucket = []);
      } else if (term.tag) {
        bucket = idx.byTag.get(term.tag);
        if (!bucket) idx.byTag.set(term.tag, bucket = []);
      } else {
        bucket = idx.universal;
      }
      bucket.push(r);
    }
    return idx;
  }
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
  var LAYOUT_PROPS = ["top", "left", "width", "height", "text-transform", "white-space"];
  function parseInlineLayout(el) {
    const out = {};
    const s = el._attrs && el._attrs.style;
    if (!s) return out;
    for (const part of String(s).split(";")) {
      const m = /^\s*(top|left|width|height)\s*:\s*([^;]+?)\s*$/.exec(part);
      if (m) out[m[1]] = { value: m[2], important: /\s+!important\s*$/.test(m[2]) };
    }
    return out;
  }
  function parsePx2(v) {
    if (v == null) return null;
    const m = /^(-?\d+(?:\.\d+)?)px$/.exec(String(v).trim());
    return m ? parseFloat(m[1]) : /^(-?\d+(?:\.\d+)?)$/.test(v) ? parseFloat(v) : null;
  }
  function resolveLayoutProp(el, prop) {
    const inline = parseInlineLayout(el)[prop];
    let best = inline ? { spec: [1, 0, 0, 0], source: Infinity, ...inline } : null;
    if (state.layoutRules.length) {
      if (!state.layoutIdx) state.layoutIdx = buildRuleIndex(state.layoutRules);
      forEachCandidateRule(state.layoutIdx, el, (r) => {
        const cap = r.captured[prop];
        if (!cap) return;
        let m;
        try {
          m = matchOne(el, r.group);
        } catch (_) {
          return;
        }
        if (!m) return;
        if (!best || cap.important && !best.important || cap.important === best.important && (specCompare(r.spec, best.spec) > 0 || specCompare(r.spec, best.spec) === 0 && r.source >= best.source)) {
          best = { value: cap.value, important: cap.important, spec: r.spec, source: r.source };
        }
      });
    }
    return best ? parsePx2(best.value) : null;
  }
  function specCompare(a, b) {
    for (let i = 0; i < 4; i++) {
      if (a[i] !== b[i]) return a[i] - b[i];
    }
    return 0;
  }
  function matchesAnyHideRule(el, ignoreVisibility = false) {
    if (state.hideRules.length === 0) return false;
    if (!state.hideIdx) state.hideIdx = buildRuleIndex(state.hideRules);
    let bestD = null, bestV = null;
    forEachCandidateRule(state.hideIdx, el, (r) => {
      let m;
      try {
        m = matchOne(el, r.group);
      } catch (_) {
        return;
      }
      if (!m) return;
      if (r.display != null && winsCascade(bestD, r, true)) {
        bestD = { value: r.display, important: r.displayImp, spec: r.spec, source: r.source };
      }
      if (!ignoreVisibility && r.visibility != null && winsCascade(bestV, r, false)) {
        bestV = { value: r.visibility, important: r.visibilityImp, spec: r.spec, source: r.source };
      }
    });
    if (bestD && bestD.value === "none") return true;
    if (bestV && bestV.value === "hidden") return true;
    return false;
  }
  function winsCascade(current, candidate, isDisplay) {
    const candImp = isDisplay ? candidate.displayImp : candidate.visibilityImp;
    if (!current) return true;
    if (candImp && !current.important) return true;
    if (!candImp && current.important) return false;
    const cmp = compareSpec(candidate.spec, current.spec);
    if (cmp !== 0) return cmp > 0;
    return candidate.source >= current.source;
  }
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
  function resolvedDisplayIsFlexLike(el) {
    const d = resolveCascadeDisplay(el);
    return d ? FLEX_LIKE_DISPLAY.has(d) : false;
  }
  function resolveCascadeDisplay(el) {
    if (state.hideRules.length === 0) return null;
    if (!state.hideIdx) state.hideIdx = buildRuleIndex(state.hideRules);
    let best = null;
    forEachCandidateRule(state.hideIdx, el, (r) => {
      if (r.display == null) return;
      let m;
      try {
        m = matchOne(el, r.group);
      } catch (_) {
        return;
      }
      if (!m) return;
      if (winsCascade(best, r, true)) {
        best = { value: r.display, important: r.displayImp, spec: r.spec, source: r.source };
      }
    });
    return best ? String(best.value).trim().toLowerCase() : null;
  }
  var TAILWIND_TEXT_TRANSFORM = Object.assign(/* @__PURE__ */ Object.create(null), {
    uppercase: "uppercase",
    lowercase: "lowercase",
    capitalize: "capitalize",
    "normal-case": "none"
  });
  function tailwindTextTransform(el) {
    for (const tok of classes(el)) {
      const t = TAILWIND_TEXT_TRANSFORM[tok];
      if (t) return t;
    }
    return null;
  }
  function cascadedProperty(el, prop) {
    const style = el._attrs && el._attrs.style;
    const inline = style ? parseInlinePropertyValue(style, prop) : null;
    let best = inline ? { value: inline.value, important: inline.important, spec: [1, 0, 0, 0], source: Infinity } : null;
    const rules = state.layoutRules;
    if (rules.length && rulesIndexHas(prop)) {
      if (!state.layoutIdx) state.layoutIdx = buildRuleIndex(rules);
      forEachCandidateRule(state.layoutIdx, el, (r) => {
        const cap = r.captured[prop];
        if (!cap) return;
        let m;
        try {
          m = matchOne(el, r.group);
        } catch (_) {
          return;
        }
        if (!m) return;
        if (!best || cap.important && !best.important || cap.important === best.important && (specCompare(r.spec, best.spec) > 0 || specCompare(r.spec, best.spec) === 0 && r.source >= best.source)) {
          best = { value: cap.value, important: cap.important, spec: r.spec, source: r.source };
        }
      });
    }
    return best ? best.value : null;
  }
  function parseInlinePropertyValue(style, prop) {
    const re = new RegExp("(?:^|;)\\s*" + prop + "\\s*:\\s*([^;!]+?)\\s*(?:!important)?\\s*(?:;|$)", "i");
    const m = re.exec(String(style));
    if (!m) return null;
    return { value: m[1].toLowerCase(), important: /!important/i.test(style) };
  }
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
  function cascadedTextTransform(el) {
    const inlineStyle = el._attrs && el._attrs.style;
    if (!inlineStyle || !/text-transform/i.test(inlineStyle)) {
      const tw = tailwindTextTransform(el);
      if (tw) return tw;
    }
    return cascadedProperty(el, "text-transform");
  }
  function resolveTextTransform(el) {
    for (let cur = el; cur && cur.nodeType === NODE_ELEMENT; cur = cur._parent) {
      const v = cascadedTextTransform(cur);
      if (v && v !== "inherit") return v;
    }
    return "none";
  }
  function applyTextTransform(text, mode) {
    if (!text || mode === "none" || mode === "initial" || mode === "unset" || !mode) return text;
    if (mode === "uppercase") return text.toUpperCase();
    if (mode === "lowercase") return text.toLowerCase();
    if (mode === "capitalize") {
      return text.replace(/(^|\s)(\S)/g, (_, ws, ch) => ws + ch.toUpperCase());
    }
    return text;
  }
  var WS_PRESERVING_VALUES = /* @__PURE__ */ new Set(["pre", "pre-wrap", "pre-line", "break-spaces"]);
  function elementPreservesWhitespace(node) {
    if (node._tag === "pre") return true;
    const v = cascadedProperty(node, "white-space");
    return v != null && WS_PRESERVING_VALUES.has(v);
  }
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
  var localStorage = makeStorage("local");
  var sessionStorage = makeStorage("session");

  // lib/capybara/simulated/js/src/observers.js
  var StubObserver = class {
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
    constructor(cb) {
      this._cb = cb;
      this._observed = /* @__PURE__ */ new Set();
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
      if (this._observed.size === 0) activeIOs.delete(this);
    }
    disconnect() {
      this._observed.clear();
      activeIOs.delete(this);
    }
    takeRecords() {
      return [];
    }
    _maybeFire(target) {
      if (!this._observed.has(target)) return;
      if (!globalThis.__isLaidOutNode(target)) return;
      this._observed.delete(target);
      if (this._observed.size === 0) activeIOs.delete(this);
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
  globalThis.IntersectionObserver = IntersectionObserver;
  globalThis.ResizeObserver = class extends StubObserver {
  };
  var _perfObservers = /* @__PURE__ */ new Set();
  var PerformanceObserverImpl = class {
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
          obs._cb({ getEntries: () => taken, getEntriesByName: () => taken, getEntriesByType: () => taken }, obs);
        } catch (_) {
        }
      });
    }
  };
  globalThis.__recheckIntersectionObservers = recheckIntersectionObservers;

  // lib/capybara/simulated/js/src/timers.js
  var setTimersActive = function(flag) {
    globalThis.__setTimersActive(flag);
  };
  var timers = /* @__PURE__ */ new Map();
  var nextTimerId = 1;
  var virtualNow = 0;
  var virtualOffsetMs = 0;
  var _origDateNow = Date.now;
  Date.now = function() {
    return _origDateNow() + virtualOffsetMs;
  };
  function installVirtualDate() {
    if (globalThis.Date !== _OrigDate) return;
    function VirtualDate(...args) {
      if (args.length === 0) return new _OrigDate(_origDateNow() + virtualOffsetMs);
      return new _OrigDate(...args);
    }
    VirtualDate.prototype = _OrigDate.prototype;
    VirtualDate.now = Date.now;
    VirtualDate.parse = _OrigDate.parse;
    VirtualDate.UTC = _OrigDate.UTC;
    Object.setPrototypeOf(VirtualDate, _OrigDate);
    globalThis.Date = VirtualDate;
  }
  var _OrigDate = globalThis.Date;
  function scheduleTimer(handler, ms, args, period) {
    if (typeof handler !== "function") return 0;
    const id = nextTimerId++;
    const delay = Math.max(0, +ms || 0);
    const wasEmpty = timers.size === 0;
    timers.set(id, { handler, args, due: virtualNow + delay, period });
    if (wasEmpty) setTimersActive(true);
    return id;
  }
  globalThis.setTimeout = function(h, ms, ...a) {
    return scheduleTimer(h, ms, a, null);
  };
  globalThis.setInterval = function(h, ms, ...a) {
    return scheduleTimer(h, ms, a, Math.max(1, +ms || 0));
  };
  globalThis.clearTimeout = function(id) {
    if (timers.delete(id) && timers.size === 0) setTimersActive(false);
  };
  globalThis.clearInterval = globalThis.clearTimeout;
  var rafIdSeq = 1;
  var rafCancelled = /* @__PURE__ */ new Set();
  globalThis.requestAnimationFrame = function(cb) {
    const id = rafIdSeq++;
    Promise.resolve().then(() => {
      if (rafCancelled.has(id)) {
        rafCancelled.delete(id);
        return;
      }
      try {
        cb(virtualNow);
      } catch (e) {
        logThrew("requestAnimationFrame cb", e);
      }
    });
    return id;
  };
  globalThis.cancelAnimationFrame = function(id) {
    if (id != null) rafCancelled.add(id);
  };
  globalThis.queueMicrotask = function(cb) {
    scheduleTimer(cb, 0, [], null);
  };
  globalThis.__virtualNow = () => virtualNow;
  globalThis.__hasReadyTimer = function() {
    for (const t of timers.values()) if (t.due <= virtualNow) return true;
    return false;
  };
  globalThis.__drainTimers = function(maxMs, maxIter) {
    if (typeof maxMs !== "number") maxMs = 2e3;
    if (typeof maxIter !== "number") maxIter = 1e4;
    const startNow = virtualNow;
    const limit = virtualNow + maxMs;
    let iter = 0;
    let fired = 0;
    while (iter++ < maxIter && timers.size > 0) {
      let nextId = null, nextDue = Infinity;
      for (const [id, t2] of timers) {
        if (t2.due < nextDue) {
          nextDue = t2.due;
          nextId = id;
        }
      }
      if (nextId === null || nextDue > limit) break;
      virtualNow = nextDue;
      const t = timers.get(nextId);
      if (t.period != null) t.due = virtualNow + t.period;
      else timers.delete(nextId);
      try {
        t.handler.apply(null, t.args || []);
      } catch (e) {
        try {
          const where = t.handler && t.handler.toString && t.handler.toString().slice(0, 200) || "(no source)";
          console.error("[csim] timer threw:", e && (e.stack || e.message), "\n  handler:", where);
        } catch (_) {
        }
      }
      if (hasObservers() && hasQueuedRecords()) deliverMutations();
      recheckIntersectionObservers();
      fired++;
    }
    if (virtualNow < limit) virtualNow = limit;
    if (virtualNow > startNow) {
      virtualOffsetMs += virtualNow - startNow;
      installVirtualDate();
    }
    if (timers.size === 0) setTimersActive(false);
    return fired;
  };
  function timerStats() {
    return { size: timers.size, virtualNow };
  }
  function resetTimers() {
    const had = timers.size > 0;
    timers.clear();
    virtualNow = 0;
    if (had) setTimersActive(false);
  }
  globalThis.__resetTimers = resetTimers;

  // lib/capybara/simulated/js/src/bytes.js
  function bytesToLatin1(view) {
    let s = "";
    for (let i = 0; i < view.length; i += 32768) {
      s += String.fromCharCode.apply(null, view.subarray(i, i + 32768));
    }
    return s;
  }
  function latin1ToBytes(bytes) {
    const v = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) v[i] = bytes.charCodeAt(i) & 255;
    return v;
  }
  function bytesToArrayBuffer(bytes) {
    return latin1ToBytes(bytes).buffer;
  }
  function fetchedToBytes(fetched) {
    if (fetched instanceof Uint8Array) return fetched;
    if (fetched instanceof ArrayBuffer) return new Uint8Array(fetched);
    if (typeof fetched === "string") return latin1ToBytes(globalThis.atob(fetched));
    return null;
  }
  function fetchTransfer(refId) {
    if (!refId || typeof globalThis.__csim_transferFetch !== "function") return null;
    return fetchedToBytes(globalThis.__csim_transferFetch(refId | 0));
  }
  function stashTransfer(view) {
    if (typeof globalThis.__csim_transferStash !== "function") return 0;
    return globalThis.__csim_transferStash(view) | 0;
  }

  // lib/capybara/simulated/js/src/workers.js
  function hasWorkers() {
    const m = globalThis.__csim_workersByHandle;
    return !!(m && m.size > 0);
  }
  var TRANSFER_STASH_MIN = 64 * 1024;
  function encode(data) {
    return JSON.stringify(data, function(_key, value) {
      const isU8 = value instanceof Uint8Array;
      const isAB = !isU8 && value instanceof ArrayBuffer;
      if (!isU8 && !isAB) return value;
      const view = isU8 ? value : new Uint8Array(value);
      if (view.byteLength >= TRANSFER_STASH_MIN) {
        const refId = stashTransfer(view);
        if (refId > 0) return { __csimType: isU8 ? "Uint8Array" : "ArrayBuffer", refId };
      }
      return {
        __csimType: isU8 ? "Uint8Array" : "ArrayBuffer",
        b64: globalThis.btoa(bytesToLatin1(view))
      };
    });
  }
  function decode(s) {
    return JSON.parse(s, function(_key, value) {
      if (!value || typeof value !== "object") return value;
      const tag = value.__csimType;
      if (tag !== "Uint8Array" && tag !== "ArrayBuffer") return value;
      const u = fetchTransfer(value.refId) || latin1ToBytes(globalThis.atob(value.b64 || ""));
      return tag === "ArrayBuffer" ? u.buffer : u;
    });
  }
  if (!globalThis.__csim_isWorker) {
    globalThis.__csim_installWorker = function() {
      if (typeof globalThis.Worker === "function") return;
      const byHandle = /* @__PURE__ */ new Map();
      globalThis.__csim_workersByHandle = byHandle;
      class Worker extends EventTarget {
        constructor(url, _options) {
          super();
          this.url = String(url);
          this.onmessage = null;
          this.onerror = null;
          this.onmessageerror = null;
          this._handle = globalThis.__csim_workerSpawn(this.url) | 0;
          if (this._handle > 0) byHandle.set(this._handle, this);
        }
        postMessage(data, _transferList) {
          if (this._handle <= 0) return;
          let payload;
          try {
            payload = encode(data);
          } catch (_) {
            payload = "null";
          }
          globalThis.__csim_workerPostToWorker(this._handle, payload);
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
    globalThis.WorkerGlobalScope = globalThis.WorkerGlobalScope || function WorkerGlobalScope() {
    };
    globalThis.DedicatedWorkerGlobalScope = globalThis.DedicatedWorkerGlobalScope || function DedicatedWorkerGlobalScope() {
    };
    if (typeof globalThis.postMessage !== "function") {
      globalThis.postMessage = function(data, _transferList) {
        let payload;
        try {
          payload = encode(data);
        } catch (_) {
          payload = "null";
        }
        globalThis.__csim_workerPostMessage(payload);
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
  function blobBytes(blob) {
    if (!blob) return "";
    if (blob._csimHost) return readHostFile(blob);
    return blob._parts ? blob._parts.join("") : "";
  }
  var Blob = class _Blob {
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
    constructor(parts, name, opts) {
      super(parts, opts);
      const i = opts || {};
      this.name = String(name == null ? "" : name);
      this.lastModified = i.lastModified || Date.now();
    }
  };
  function serializeMultipart(formData) {
    const boundary = "----csimFormBoundary" + Math.random().toString(36).slice(2);
    let body = "";
    formData.forEach((value, key) => {
      body += "--" + boundary + "\r\n";
      if (value instanceof Blob) {
        const filename = value.name != null ? String(value.name) : "blob";
        const contentType = value.type || "application/octet-stream";
        body += 'Content-Disposition: form-data; name="' + key + '"; filename="' + filename + '"\r\n';
        body += "Content-Type: " + contentType + "\r\n\r\n";
        body += blobBytes(value);
        body += "\r\n";
      } else {
        body += 'Content-Disposition: form-data; name="' + key + '"\r\n\r\n';
        body += String(value) + "\r\n";
      }
    });
    body += "--" + boundary + "--\r\n";
    return { body, boundary };
  }
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
    HTMLObjectElement: "object"
  };
  function makeTagCtor(tagName, Element2) {
    const ctor = function() {
    };
    ctor.prototype = Element2.prototype;
    Object.defineProperty(ctor, Symbol.hasInstance, {
      value: (obj) => obj != null && obj._tag === tagName
    });
    return ctor;
  }
  function installDomClassAliases({ Element: Element2, Document: Document2, Text: Text2 }) {
    for (const [name, tag] of Object.entries(TAG_ELEMENT_CTORS)) {
      globalThis[name] = makeTagCtor(tag, Element2);
    }
    globalThis.HTMLElement = Element2;
    globalThis.SVGElement = Element2;
    globalThis.HTMLDocument = Document2;
    globalThis.CharacterData = Text2;
    globalThis.Comment = Text2;
    globalThis.Window = function Window() {
    };
    try {
      Object.defineProperty(globalThis, "constructor", {
        value: globalThis.Window,
        writable: true,
        configurable: true
      });
    } catch (_) {
    }
    globalThis.Option = function Option(text, value, defaultSelected, selected) {
      const o = globalThis.document.createElement("option");
      if (text !== void 0) o.textContent = String(text);
      if (value !== void 0) o.setAttribute("value", String(value));
      if (defaultSelected) o.setAttribute("selected", "");
      if (selected) o.selected = true;
      return o;
    };
    globalThis.Image = function Image(width, height) {
      const img = globalThis.document.createElement("img");
      if (width != null) img.setAttribute("width", String(width | 0));
      if (height != null) img.setAttribute("height", String(height | 0));
      return img;
    };
    globalThis.Image.prototype = Element2.prototype;
    globalThis.Audio = function Audio2(src) {
      const a = globalThis.document.createElement("audio");
      if (src != null) a.setAttribute("src", String(src));
      return a;
    };
    globalThis.Audio.prototype = Element2.prototype;
  }

  // lib/capybara/simulated/js/src/location.js
  function parseUrlForLocation(url) {
    try {
      const u = globalThis.__csim_parseUrl(url, null);
      if (u && !u.error) {
        const loc = Object.assign({}, u, {
          toString() {
            return this.href;
          },
          assign: (next) => globalThis.__locationAssign(next),
          replace: (next) => globalThis.__locationAssign(next),
          reload: () => globalThis.__locationReload()
        });
        const navTarget = (resolved) => globalThis.__locationAssign(resolved);
        Object.defineProperty(loc, "href", {
          configurable: true,
          get() {
            return u.href;
          },
          set(v) {
            navTarget(String(v));
          }
        });
        const composeWith = (overrides) => {
          const o = Object.assign({}, u, overrides);
          const cred = o.username || o.password ? (o.username || "") + (o.password ? ":" + o.password : "") + "@" : "";
          return (o.protocol || "") + "//" + cred + (o.host || "") + (o.pathname || "") + (o.search || "") + (o.hash || "");
        };
        const assignPart = (key, prefix) => {
          Object.defineProperty(loc, key, {
            configurable: true,
            get() {
              return u[key];
            },
            set(v) {
              const s = String(v == null ? "" : v);
              const part = prefix && s.length > 0 && !s.startsWith(prefix) ? prefix + s : s;
              navTarget(composeWith({ [key]: part }));
            }
          });
        };
        assignPart("pathname", "/");
        assignPart("hash", "#");
        assignPart("search", "?");
        return loc;
      }
    } catch (_) {
    }
    return {
      href: url || "",
      protocol: "http:",
      host: "",
      hostname: "",
      port: "",
      pathname: "/",
      search: "",
      hash: "",
      origin: "",
      toString() {
        return this.href;
      },
      assign: (next) => globalThis.__locationAssign(next),
      replace: (next) => globalThis.__locationAssign(next),
      reload: () => globalThis.__locationReload()
    };
  }
  function makeLocation(url) {
    return parseUrlForLocation(url);
  }
  var _location = makeLocation("http://www.example.com/");
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    get() {
      return _location;
    },
    set(v) {
      globalThis.__locationAssign(String(v));
    }
  });
  globalThis.__csimUpdateLocation = function(url) {
    let s = String(url || "");
    if (s && !/^[a-z][a-z0-9+.-]*:/i.test(s)) {
      try {
        const base = globalThis.location && globalThis.location.href || null;
        if (base && /^[a-z][a-z0-9+.-]*:/i.test(base)) s = new URL(s, base).href;
      } catch (_) {
      }
    }
    _location = makeLocation(s);
    bumpSettleGen();
  };

  // lib/capybara/simulated/js/src/esm-loader.js
  globalThis.__csim_modules = /* @__PURE__ */ Object.create(null);
  globalThis.__csim_inProgress = /* @__PURE__ */ Object.create(null);
  globalThis.__csim_importmap = { imports: /* @__PURE__ */ Object.create(null), scopes: /* @__PURE__ */ Object.create(null) };
  var modules = globalThis.__csim_modules;
  var inProgress = globalThis.__csim_inProgress;
  var importmap = globalThis.__csim_importmap;
  globalThis.__csim_liveImport = function(module, key) {
    const current = module[key];
    if (current != null && typeof current !== "function") {
      return current;
    }
    const target = function() {
    };
    return new Proxy(target, {
      apply(_, thisArg, args) {
        const fn = module[key];
        if (fn == null) return void 0;
        return Reflect.apply(fn, thisArg, args);
      },
      construct(_, args, newTarget) {
        const ctor = module[key];
        if (ctor == null) return void 0;
        return Reflect.construct(ctor, args, newTarget);
      },
      get(_, prop) {
        const v = module[key];
        if (prop === Symbol.toPrimitive) {
          return (hint) => {
            if (v == null) return v;
            const m = v[Symbol.toPrimitive];
            return typeof m === "function" ? m.call(v, hint) : v;
          };
        }
        if (v == null) return void 0;
        return v[prop];
      },
      set(_, prop, value) {
        const v = module[key];
        if (v != null) v[prop] = value;
        return true;
      },
      has(_, prop) {
        const v = module[key];
        return v != null && prop in Object(v);
      },
      ownKeys() {
        const v = module[key];
        const valKeys = v != null ? Reflect.ownKeys(Object(v)) : [];
        return Array.from(/* @__PURE__ */ new Set([...Reflect.ownKeys(target), ...valKeys]));
      },
      getOwnPropertyDescriptor(_, prop) {
        if (Object.prototype.hasOwnProperty.call(target, prop)) {
          return Reflect.getOwnPropertyDescriptor(target, prop);
        }
        const v = module[key];
        if (v == null) return void 0;
        const desc = Reflect.getOwnPropertyDescriptor(Object(v), prop);
        return desc && { ...desc, configurable: true };
      }
    });
  };
  globalThis.__csim_defineExport = function(exports, name, getter) {
    Object.defineProperty(exports, name, { get: getter, enumerable: true, configurable: true });
  };
  globalThis.__csim_dynamicImport = function(spec, baseUrl) {
    try {
      const base = baseUrl || globalThis.location && globalThis.location.href || null;
      const resolved = globalThis.__csim_resolveSpecifier(String(spec), base);
      return Promise.resolve(globalThis.__csim_require(resolved));
    } catch (e) {
      return Promise.reject(e);
    }
  };
  globalThis.__csim_require = function(url) {
    if (url in modules) return modules[url];
    if (url in inProgress) return inProgress[url];
    const src = globalThis.__csim_fetchModuleSource(String(url));
    if (src == null) throw new Error("module not registered: " + url);
    const wrapped = "globalThis.__csim_pending_factory = function (__exports) {\n" + src + "\n};";
    try {
      globalThis.__csim_runScript(url, wrapped);
    } catch (e) {
      throw new Error("module compile failed for " + url + ": " + (e && e.message ? e.message : e));
    }
    const factory = globalThis.__csim_pending_factory;
    globalThis.__csim_pending_factory = null;
    if (typeof factory !== "function") throw new Error("module factory did not register for " + url);
    const exports = {};
    inProgress[url] = exports;
    try {
      factory(exports);
      modules[url] = exports;
    } finally {
      delete inProgress[url];
    }
    return exports;
  };
  globalThis.__csim_resolveSpecifier = function(specifier, baseUrl) {
    const mapped = importmap.imports[specifier];
    if (mapped) return resolveAgainst(mapped, baseUrl);
    if (specifier.charAt(0) === "/" || specifier.startsWith("./") || specifier.startsWith("../") || /^[a-z]+:\/\//i.test(specifier)) {
      return resolveAgainst(specifier, baseUrl);
    }
    return specifier;
  };
  function resolveAgainst(url, base) {
    try {
      const u = globalThis.__csim_parseUrl(url, base || globalThis.location && globalThis.location.href || null);
      return u && !u.error ? u.href : url;
    } catch (_) {
      return url;
    }
  }
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
  if (typeof globalThis.__csim_fetchModuleSource !== "function") {
    globalThis.__csim_fetchModuleSource = function() {
      return null;
    };
  }

  // lib/capybara/simulated/js/src/style-proxy.js
  function makeStyleProxy(el) {
    const target = {};
    const handler = {
      get(_t, prop) {
        if (prop === "cssText") return el._attrs.style || "";
        if (prop === "getPropertyValue") return (name) => readCssProp(el, String(name));
        if (prop === "setProperty") return (n, v) => writeCssProp(el, String(n), String(v));
        if (prop === "removeProperty") return (name) => removeCssProp(el, String(name));
        if (prop === "length") return Object.keys(parseStyleDecls(el._attrs.style || "")).length;
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
        if (prop === "cssText" || prop === "getPropertyValue" || prop === "setProperty" || prop === "removeProperty" || prop === "length") return true;
        return readCssProp(el, camelToKebab(String(prop))) !== "";
      }
    };
    return new Proxy(target, handler);
  }
  function camelToKebab(name) {
    return name.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());
  }
  function readCssProp(el, name) {
    const decls = parseStyleDecls(el._attrs.style || "");
    return decls[name] != null ? decls[name] : "";
  }
  function writeCssProp(el, name, value) {
    const decls = parseStyleDecls(el._attrs.style || "");
    if (value === "" || value == null) {
      delete decls[name];
    } else {
      decls[name] = String(value);
    }
    el.setAttribute("style", serializeStyleDecls(decls));
  }
  function removeCssProp(el, name) {
    const v = readCssProp(el, name);
    const decls = parseStyleDecls(el._attrs.style || "");
    delete decls[name];
    el.setAttribute("style", serializeStyleDecls(decls));
    return v;
  }
  function serializeStyleDecls(decls) {
    return Object.entries(decls).map(([k, v]) => k + ": " + v).join("; ");
  }
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
      if (m) return m[2].trim();
    }
    if (el._attrs.hidden != null) return "none";
    if (matchesAnyHideRule(el)) return "none";
    return DEFAULT_DISPLAY[el._tag] || "block";
  }
  function computedVisibilityFor(el) {
    const inlineStyle = el._attrs.style;
    if (inlineStyle) {
      const m = /(^|;|\s)visibility\s*:\s*([^;]+)/i.exec(inlineStyle);
      if (m) return m[2].trim();
    }
    return "";
  }
  function makeComputedStyleProxy(el) {
    return new Proxy(el.style, {
      get(target, key) {
        if (key === "display") return computedDisplayFor(el);
        if (key === "visibility") return computedVisibilityFor(el);
        if (key === "getPropertyValue") {
          return function(name) {
            const n = String(name).toLowerCase();
            if (n === "display") return computedDisplayFor(el);
            if (n === "visibility") return computedVisibilityFor(el);
            return target.getPropertyValue ? target.getPropertyValue(name) : target[n] || "";
          };
        }
        return target[key];
      }
    });
  }
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
  var HTMLCollection = class extends Array {
  };
  var NodeList = class extends Array {
  };
  var NamedNodeMap = class extends Array {
  };
  globalThis.HTMLCollection = HTMLCollection;
  globalThis.NodeList = NodeList;
  globalThis.NamedNodeMap = NamedNodeMap;
  function htmlCollection(arr) {
    const hc = HTMLCollection.from(arr);
    hc.item = function(i) {
      return this[i] || null;
    };
    hc.namedItem = function(n) {
      for (const el of this) if (el && el._attrs && (el._attrs.id === n || el._attrs.name === n)) return el;
      return null;
    };
    return hc;
  }

  // lib/capybara/simulated/js/src/dom-nodes.js
  var __nextId = 1;
  var __currentTag = null;
  function toNode(v) {
    if (v && (v.nodeType === NODE_ELEMENT || v.nodeType === NODE_TEXT || v.nodeType === NODE_FRAGMENT || v.nodeType === NODE_DOC)) return v;
    return new Text(v == null ? "" : String(v));
  }
  var Node = class {
    constructor() {
      this._id = __nextId++;
      this._parent = null;
      this._children = [];
      this._listeners = null;
      this.nodeType = NODE_ELEMENT;
    }
    getRootNode(_options) {
      let cur = this;
      while (cur._parent) cur = cur._parent;
      return cur;
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
        if (this._tag !== other._tag) return false;
        const a = this._attrs || {}, b = other._attrs || {};
        const akeys = Object.keys(a), bkeys = Object.keys(b);
        if (akeys.length !== bkeys.length) return false;
        for (const k of akeys) if (a[k] !== b[k]) return false;
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
      let fn = null;
      if (typeof handler === "function") fn = handler;
      else if (handler && typeof handler.handleEvent === "function") {
        fn = handler.handleEvent.bind(handler);
        fn._csimEventListenerObject = handler;
      } else return;
      const capture = !!(options && (options === true || options.capture));
      this._listeners = this._listeners || /* @__PURE__ */ Object.create(null);
      const list = this._listeners[type] || (this._listeners[type] = []);
      if (list.some((l) => (l.handler === fn || handler && l.handler._csimEventListenerObject === handler) && l.capture === capture)) return;
      list.push({ handler: fn, capture });
    }
    removeEventListener(type, handler, options) {
      if (!this._listeners || !this._listeners[type]) return;
      const capture = !!(options && (options === true || options.capture));
      this._listeners[type] = this._listeners[type].filter((l) => {
        if (l.capture !== capture) return true;
        if (typeof handler === "function") return l.handler !== handler;
        if (handler && typeof handler.handleEvent === "function") {
          return l.handler._csimEventListenerObject !== handler;
        }
        return true;
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
    get scrollTop() {
      return 0;
    }
    set scrollTop(_) {
    }
    get scrollLeft() {
      return 0;
    }
    set scrollLeft(_) {
    }
    // scrollIntoView({behavior, block, inline}) — without layout we
    // can't actually scroll, but accepting the options arg keeps smooth-
    // scroll polyfills from bailing on the feature-probe ("If
    // scrollIntoView accepts an options object…").
    scrollIntoView(_opts) {
    }
    scrollIntoViewIfNeeded(_opts) {
    }
    scrollTo() {
    }
    scrollBy() {
    }
    // DOM Node bitmask: DOCUMENT_POSITION_PRECEDING=2,
    // DOCUMENT_POSITION_FOLLOWING=4. Stimulus / Sizzle / various
    // libs use this for document-order sorting.
    compareDocumentPosition(other) {
      if (other === this) return 0;
      const cmp = compareDocOrder(this, other);
      if (cmp < 0) return 4;
      if (cmp > 0) return 2;
      return 0;
    }
    cloneNode(deep) {
      const copy = this._cloneShell();
      if (deep && this._children) {
        for (const c of this._children) {
          const cc = c.cloneNode(true);
          cc._parent = copy;
          copy._children.push(cc);
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
    get firstChild() {
      return this._children[0] || null;
    }
    get lastChild() {
      return this._children[this._children.length - 1] || null;
    }
    get childNodes() {
      return this._children.slice();
    }
    hasChildNodes() {
      return this._children.length > 0;
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
      try {
        let isInputControl = false;
        let inputType = "";
        if (this._tag === "input") {
          inputType = (this._attrs.type || "").toLowerCase();
          isInputControl = inputType === "checkbox" || inputType === "radio";
        }
        const wasChecked = isInputControl ? this._attrs.checked != null : null;
        if (isInputControl) {
          if (inputType === "checkbox") toggleChecked(this);
          else setRadio(this);
        }
        const ev = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, which: 1 });
        dispatchEvent(this, ev);
        if (ev.defaultPrevented && isInputControl) {
          if (wasChecked) this._attrs.checked = "";
          else delete this._attrs.checked;
        } else if (isInputControl && this._attrs.checked != null !== wasChecked) {
          try {
            dispatchEvent(this, new InputEvent("input", { bubbles: true, cancelable: true }));
          } catch (_) {
          }
          try {
            dispatchEvent(this, new Event("change", { bubbles: true, cancelable: false }));
          } catch (_) {
          }
        }
        if (!ev.defaultPrevented && isSubmitButton(this)) {
          const form = formForControl(this);
          if (form) {
            const submitEv = new SubmitEvent("submit", { bubbles: true, cancelable: true, submitter: this });
            dispatchEvent(form, submitEv);
            if (!submitEv.defaultPrevented) {
              globalThis.__csimPendingFormSubmit = { form, submitter: this };
            }
          }
        }
        if (!ev.defaultPrevented && !globalThis.__csimPendingFormSubmit) {
          let anchor = this;
          while (anchor && anchor.nodeType === NODE_ELEMENT && anchor._tag !== "a") {
            anchor = anchor._parent;
          }
          if (anchor && anchor.nodeType === NODE_ELEMENT && anchor._tag === "a" && anchor._attrs.href != null && (anchor._attrs.href || "").trim() !== "" && !(anchor._attrs.href || "").toLowerCase().startsWith("javascript:")) {
            globalThis.__csimPendingNavigation = {
              url: String(anchor._attrs.href),
              target: anchor._attrs.target || ""
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
      if (this._parent) for (const n of nodes) this._parent.insertBefore(toNode(n), this);
    }
    after(...nodes) {
      if (!this._parent) return;
      const sibs = this._parent._children;
      const idx = sibs.indexOf(this);
      const ref = idx + 1 < sibs.length ? sibs[idx + 1] : null;
      for (const n of nodes) this._parent.insertBefore(toNode(n), ref);
    }
    replaceWith(...nodes) {
      if (!this._parent) return;
      const p = this._parent;
      for (const n of nodes) p.insertBefore(toNode(n), this);
      p.removeChild(this);
    }
    // `ParentNode.prepend(...nodes)` / `append(...nodes)` — the
    // sibling of `appendChild` that accepts strings + variadic args.
    prepend(...nodes) {
      const first = this._children[0] || null;
      for (const n of nodes) this.insertBefore(toNode(n), first);
    }
    append(...nodes) {
      for (const n of nodes) this.appendChild(toNode(n));
    }
    // ParentNode.replaceChildren(...nodes) — DOM spec: clear then append.
    // React 19 / Stimulus controllers reach for it as the modern
    // shorthand instead of `el.innerHTML = ''` + appendChild.
    replaceChildren(...nodes) {
      while (this._children.length) this.removeChild(this._children[this._children.length - 1]);
      for (const n of nodes) this.appendChild(toNode(n));
    }
    get children() {
      return this._children.filter((c) => c.nodeType === NODE_ELEMENT);
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
    appendChild(child) {
      if (child && child.nodeType === NODE_FRAGMENT) {
        const moved = child._children.slice();
        for (const c of moved) {
          if (c._parent) c._parent.removeChild(c);
          c._parent = this;
          this._children.push(c);
          registerSubtree(c);
          recordChildList(this, [c], []);
          if (isConnected(this)) globalThis.__csimFireCEConnect(c);
          askForReset(c);
        }
        child._children.length = 0;
        return child;
      }
      if (child._parent) child._parent.removeChild(child);
      child._parent = this;
      this._children.push(child);
      registerSubtree(child);
      recordChildList(this, [child], []);
      if (isConnected(this)) globalThis.__csimFireCEConnect(child);
      askForReset(child);
      return child;
    }
    removeChild(child) {
      const i = this._children.indexOf(child);
      if (i < 0) return null;
      const wasConnected = isConnected(this);
      this._children.splice(i, 1);
      child._parent = null;
      unregisterSubtree(child);
      recordChildList(this, [], [child]);
      if (wasConnected) fireCEDisconnect(child);
      return child;
    }
    insertBefore(child, ref) {
      if (ref == null) return this.appendChild(child);
      if (child && child.nodeType === NODE_FRAGMENT) {
        const moved = child._children.slice();
        for (const c of moved) {
          if (c._parent) c._parent.removeChild(c);
          const idx = this._children.indexOf(ref);
          c._parent = this;
          this._children.splice(idx < 0 ? this._children.length : idx, 0, c);
          registerSubtree(c);
          recordChildList(this, [c], []);
          if (isConnected(this)) globalThis.__csimFireCEConnect(c);
          askForReset(c);
        }
        child._children.length = 0;
        return child;
      }
      if (child._parent) child._parent.removeChild(child);
      const i = this._children.indexOf(ref);
      if (i < 0) return this.appendChild(child);
      child._parent = this;
      this._children.splice(i, 0, child);
      registerSubtree(child);
      recordChildList(this, [child], []);
      if (isConnected(this)) globalThis.__csimFireCEConnect(child);
      askForReset(child);
      return child;
    }
    replaceChild(neu, old) {
      const i = this._children.indexOf(old);
      if (i < 0) return null;
      const wasConnected = isConnected(this);
      if (neu._parent) neu._parent.removeChild(neu);
      neu._parent = this;
      old._parent = null;
      this._children[i] = neu;
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
        s += c.nodeType === NODE_TEXT ? c.data : c.textContent;
      }
      return s;
    }
    set textContent(v) {
      const removed = this._children.slice();
      for (const c of removed) c._parent = null;
      this._children = [];
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
  var Text = class _Text extends Node {
    constructor(data) {
      super();
      this.nodeType = NODE_TEXT;
      this._data = String(data == null ? "" : data);
    }
    get nodeName() {
      return "#text";
    }
    _cloneShell() {
      return new _Text(this._data);
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
    set data(v) {
      const next = String(v == null ? "" : v);
      const prev = this._data;
      if (prev === next) return;
      this._data = next;
      recordCharacterData(this, prev);
    }
    get nodeValue() {
      return this.data;
    }
    set nodeValue(v) {
      this.data = v;
    }
    get textContent() {
      return this.data;
    }
    set textContent(v) {
      this.data = v;
    }
    // wgxpath uses these on text nodes via XPath `text()` / `string()`.
    get prefix() {
      return null;
    }
    get namespaceURI() {
      return null;
    }
    get localName() {
      return null;
    }
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
  };
  var Comment = class _Comment extends Text {
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
  function reflectURLAttr(el, name, tagSet) {
    if (!tagSet.has(el._tag)) return el._attrs[name];
    const v = el._attrs[name];
    if (v == null) return "";
    try {
      const base = globalThis.location && globalThis.location.href || null;
      const u = globalThis.__csim_parseUrl(v, base);
      return u && !u.error ? u.href : v;
    } catch (_) {
      return v;
    }
  }
  var __layoutYSeq = 0;
  function nextLayoutY() {
    return __layoutYSeq++;
  }
  function resetLayoutY() {
    __layoutYSeq = 0;
  }
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
  var Element = class _Element extends Node {
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
    }
    _cloneShell() {
      const e = new _Element(this._tag);
      e._attrs = Object.assign({}, this._attrs);
      return e;
    }
    get tagName() {
      return this._tag.toUpperCase();
    }
    get nodeName() {
      return this.tagName;
    }
    get nodeValue() {
      return null;
    }
    get localName() {
      return this._tag;
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
    // Report the XHTML namespace per HTML spec. wgxpath defaults
    // missing namespaceURI to XHTML (vendor/js/wgxpath.js:55), so
    // Capybara's `//*` queries are unaffected by reporting it
    // explicitly. Required for DOMPurify's `_checkValidNamespace`
    // to keep elements (Trix's HTMLSanitizer wipes the body
    // without it).
    get prefix() {
      return null;
    }
    get namespaceURI() {
      return "http://www.w3.org/1999/xhtml";
    }
    get ownerDocument() {
      return this._ownerDoc || globalThis.document;
    }
    getAttribute(name) {
      const v = this._attrs[String(name).toLowerCase()];
      return v == null ? null : v;
    }
    setAttribute(name, value) {
      const n = String(name).toLowerCase();
      const old = this._attrs[n];
      const next = String(value);
      this._attrs[n] = next;
      recordAttrMutation(this, n, old == null ? null : old);
      if (old !== next) fireAttrChangedCallback(this, n, old == null ? null : old, next, _Element);
    }
    // Namespace-aware setters delegate to the flat store. React-DOM
    // production calls `setAttributeNS('http://www.w3.org/1999/xlink',
    // 'xlink:href', value)` etc. for SVG attributes; we ignore the
    // namespace and key on the qualified name, which is enough for
    // serialization parity and selector matching.
    setAttributeNS(_ns, qualifiedName, value) {
      this.setAttribute(qualifiedName, value);
    }
    removeAttributeNS(_ns, qualifiedName) {
      this.removeAttribute(qualifiedName);
    }
    getAttributeNS(_ns, qualifiedName) {
      return this.getAttribute(qualifiedName);
    }
    hasAttributeNS(_ns, qualifiedName) {
      return this.hasAttribute(qualifiedName);
    }
    removeAttribute(name) {
      const n = String(name).toLowerCase();
      if (!Object.prototype.hasOwnProperty.call(this._attrs, n)) return;
      const old = this._attrs[n];
      delete this._attrs[n];
      recordAttrMutation(this, n, old == null ? null : old);
      fireAttrChangedCallback(this, n, old == null ? null : old, null, _Element);
    }
    hasAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this._attrs, String(name).toLowerCase());
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
      const has = this.hasAttribute(name);
      const next = arguments.length > 1 ? !!force : !has;
      if (next === has) return next;
      if (next) this.setAttribute(name, "");
      else this.removeAttribute(name);
      return next;
    }
    getAttributeNames() {
      return Object.keys(this._attrs);
    }
    // `attributes` returns a NamedNodeMap-shaped collection — array-
    // indexed + `getNamedItem(name)`. wgxpath iterates via `length` +
    // index access; Capybara's `Element#native.attributes` reads
    // `{name, value}` pairs. We give each item the Attr fields wgxpath
    // touches (`specified`, `namespaceURI`, `prefix`, `localName`,
    // `ownerElement`).
    get attributes() {
      const el = this;
      const names = Object.keys(this._attrs);
      const list = names.map((n) => makeAttr(el, n));
      for (const n of names) {
        Object.defineProperty(list, n, { value: makeAttr(el, n), enumerable: false, configurable: true, writable: true });
      }
      Object.defineProperty(list, "getNamedItem", {
        value: (name) => {
          const lower = String(name).toLowerCase();
          return Object.prototype.hasOwnProperty.call(el._attrs, lower) ? makeAttr(el, lower) : null;
        },
        enumerable: false,
        configurable: true,
        writable: true
      });
      return list;
    }
    getAttributeNode(name) {
      const n = String(name).toLowerCase();
      return Object.prototype.hasOwnProperty.call(this._attrs, n) ? makeAttr(this, n) : null;
    }
    // HTMLCollection-shaped getters wgxpath / framework code expects.
    // Spec says these return *descendants* of the element (not self);
    // my `walk()` starts at the receiver so we have to drop the
    // self-hit explicitly to avoid wgxpath descendant-axis dupes.
    getElementsByTagName(tag) {
      const t = String(tag).toLowerCase();
      const all = t === "*" ? this.querySelectorAll("*") : this.querySelectorAll(t);
      return htmlCollection(all.filter((n) => n !== this));
    }
    getElementsByClassName(cls) {
      const sel = String(cls).split(/\s+/).filter(Boolean).map((c) => "." + c).join("");
      return htmlCollection(this.querySelectorAll(sel).filter((n) => n !== this));
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
    get classList() {
      const el = this;
      const commit = (cs) => el.setAttribute("class", cs.join(" "));
      return {
        contains(c) {
          return classes(el).includes(c);
        },
        add(...names) {
          const cs = classes(el);
          let changed = false;
          for (const n of names) if (!cs.includes(n)) {
            cs.push(n);
            changed = true;
          }
          if (changed) commit(cs);
        },
        remove(...names) {
          const cs = classes(el);
          const drop = new Set(names);
          if (!cs.some((c) => drop.has(c))) return;
          commit(cs.filter((x) => !drop.has(x)));
        },
        toggle(c, force) {
          const cs = classes(el);
          const i = cs.indexOf(c);
          const present = i >= 0;
          if (force === true || force === void 0 && !present) {
            if (!present) cs.push(c);
          } else {
            if (present) cs.splice(i, 1);
          }
          commit(cs);
          return cs.includes(c);
        },
        // `replace(old, new)` — swaps one class for another (DOMTokenList
        // spec). Returns true if `old` was present. quote-reply +
        // syntax-highlighter callers do
        // `el.classList.replace('ruby', 'language-ruby')`.
        replace(oldClass, newClass) {
          const cs = classes(el);
          const i = cs.indexOf(String(oldClass));
          if (i < 0) return false;
          cs[i] = String(newClass);
          commit(cs);
          return true;
        },
        item(i) {
          const cs = classes(el);
          return i >= 0 && i < cs.length ? cs[i] : null;
        },
        get length() {
          return classes(el).length;
        },
        get value() {
          return el._attrs["class"] || "";
        },
        set value(v) {
          el.setAttribute("class", v == null ? "" : String(v));
        },
        toString() {
          return el._attrs["class"] || "";
        },
        forEach(fn) {
          classes(el).forEach((c, i) => fn(c, i, this));
        },
        entries() {
          return classes(el).entries();
        },
        keys() {
          return classes(el).keys();
        },
        values() {
          return classes(el).values();
        }
      };
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
      const toAttr = (k) => "data-" + String(k).replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());
      const fromAttr = (n) => n.slice(5).replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
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
      return selectFirst(this._children, sel, this);
    }
    querySelectorAll(sel) {
      return selectAll(this._children, sel, this);
    }
    matches(sel) {
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
      const arr = this.querySelectorAll("option");
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
      const form = formForControl(this);
      return form ? formNamedAccess(form) : null;
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
      if (v) {
        this._attrs.selected = "";
        let p = this._parent;
        while (p && p.nodeType === NODE_ELEMENT && p._tag !== "select") p = p._parent;
        if (p && p._tag === "select" && p._attrs.multiple == null) {
          for (const o of p.querySelectorAll("option")) {
            if (o !== this) delete o._attrs.selected;
          }
        }
      } else {
        delete this._attrs.selected;
      }
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
      return this.querySelectorAll("option").filter((o) => o._attrs.selected != null);
    }
    // Rails-UJS reads `element.href` to get an AJAX target; the raw
    // attribute would resolve against `location.href` (= current page)
    // and re-fetch the current page on every remote-link click.
    get href() {
      return reflectURLAttr(this, "href", HREF_REFLECTING_TAGS);
    }
    set href(v) {
      this._attrs.href = String(v == null ? "" : v);
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
      if (v) this._attrs.checked = "";
      else delete this._attrs.checked;
    }
    // Boolean IDL reflections — `el.disabled = true` mirrors to the
    // `disabled` content attribute (HTML IDL contract).
    get disabled() {
      return this._attrs.disabled != null;
    }
    set disabled(v) {
      if (v) this._attrs.disabled = "";
      else delete this._attrs.disabled;
    }
    get readOnly() {
      return this._attrs.readonly != null;
    }
    set readOnly(v) {
      if (v) this._attrs.readonly = "";
      else delete this._attrs.readonly;
    }
    get required() {
      return this._attrs.required != null;
    }
    set required(v) {
      if (v) this._attrs.required = "";
      else delete this._attrs.required;
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
    // Constraint validation API — partial. We compute a subset of the
    // validity flags below (enough for `:valid` / `:invalid` selectors
    // and the common Stimulus form-controller probes); the full
    // algorithm including custom validators isn't run.
    get validity() {
      const tag = this._tag;
      const type = (this._attrs.type || "text").toLowerCase();
      const val = this._attrs.value != null ? String(this._attrs.value) : "";
      const checkable = type === "checkbox" || type === "radio";
      const empty = checkable ? this._attrs.checked == null : val === "";
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
        if (this._attrs.required != null && empty) v.valueMissing = true;
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
        this._children = [Object.assign(new Text(next), { _parent: this })];
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
    get innerHTML() {
      return serializeChildren(this);
    }
    set innerHTML(html) {
      if (this._tag === "template") {
        const frag2 = this.content;
        const tmplRemoved = frag2._children.slice();
        for (const c of tmplRemoved) {
          c._parent = null;
          unregisterSubtree(c);
        }
        frag2._children = [];
        const parsed = parseFragment(String(html == null ? "" : html));
        for (const c of parsed) {
          c._parent = frag2;
          frag2._children.push(c);
          registerSubtree(c);
        }
        return;
      }
      const removedChildren = this._children.slice();
      for (const c of removedChildren) {
        c._parent = null;
        unregisterSubtree(c);
      }
      this._children = [];
      let frag;
      if (this._tag === "html") {
        const parsed = parseDocument(String(html == null ? "" : html));
        frag = parsed.documentElement ? parsed.documentElement._children.slice() : [];
      } else {
        frag = parseFragment(String(html == null ? "" : html));
      }
      for (const c of frag) {
        c._parent = this;
        this._children.push(c);
        registerSubtree(c);
      }
      if (removedChildren.length || frag.length) {
        recordChildList(this, frag, removedChildren);
      }
    }
    get outerHTML() {
      return serializeElement(this);
    }
    // `insertAdjacentHTML(position, html)` — DOM spec method. Forem's
    // initializeBroadcast uses `el.insertAdjacentHTML('afterbegin', …)`
    // to inject the announcement banner. Positions: `beforebegin` /
    // `afterbegin` / `beforeend` / `afterend`.
    insertAdjacentHTML(position, html) {
      const pos = String(position || "").toLowerCase();
      const frag = parseFragment(String(html == null ? "" : html));
      if (pos === "beforebegin" || pos === "afterend") {
        if (!this._parent) return;
        const ref = pos === "beforebegin" ? this : this._children && this.nextSibling;
        for (const c of frag) this._parent.insertBefore(c, pos === "afterend" ? this.nextSibling : this);
        return;
      }
      if (pos === "afterbegin") {
        const first = this._children[0] || null;
        for (const c of frag) this.insertBefore(c, first);
        return;
      }
      if (pos === "beforeend") {
        for (const c of frag) this.appendChild(c);
      }
    }
    insertAdjacentText(position, text) {
      this.insertAdjacentHTML(position, escapeText(String(text == null ? "" : text)));
    }
    insertAdjacentElement(position, element) {
      const pos = String(position || "").toLowerCase();
      if (pos === "beforebegin" || pos === "afterend") {
        if (!this._parent) return null;
        this._parent.insertBefore(element, pos === "afterend" ? this.nextSibling : this);
      } else if (pos === "afterbegin") {
        this.insertBefore(element, this._children[0] || null);
      } else if (pos === "beforeend") {
        this.appendChild(element);
      }
      return element;
    }
    attachShadow(init) {
      if (this._shadowRoot) return this._shadowRoot;
      const mode = init && init.mode === "closed" ? "closed" : "open";
      const sr = new ShadowRoot(this, mode);
      this._shadowRoot = sr;
      registerSubtree(sr);
      return sr;
    }
    get shadowRoot() {
      return this._shadowRoot && this._shadowRoot.mode === "open" ? this._shadowRoot : null;
    }
  };
  var DocumentFragment = class extends Node {
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
      return serializeChildren(this);
    }
    set innerHTML(html) {
      const removed = this._children.slice();
      for (const c of removed) {
        c._parent = null;
        unregisterSubtree(c);
      }
      this._children = [];
      const added = [];
      for (const c of parseFragment(String(html == null ? "" : html))) {
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
      return selectFirst(this._children, sel, this);
    }
    querySelectorAll(sel) {
      return selectAll(this._children, sel, this);
    }
    getElementById(id) {
      return findById(this, id);
    }
    // wgxpath's descendant axis traversal probes
    // `getElementsByTagName('*')` on the context node. Inherit
    // Element's behaviour so a ShadowRoot context resolves
    // `.//*[@id=…]` against its own subtree.
    getElementsByTagName(tag) {
      const t = String(tag).toLowerCase();
      const all = t === "*" ? this.querySelectorAll("*") : this.querySelectorAll(t);
      return htmlCollection(all.filter((n) => n !== this));
    }
    getElementsByClassName(cls) {
      const sel = String(cls).split(/\s+/).filter(Boolean).map((c) => "." + c).join("");
      return htmlCollection(this.querySelectorAll(sel).filter((n) => n !== this));
    }
  };
  globalThis.DocumentFragment = DocumentFragment;
  var ShadowRoot = class extends DocumentFragment {
    constructor(host, mode) {
      super();
      this.host = host;
      this.mode = mode || "open";
      this._parent = host;
    }
    get nodeName() {
      return "#shadow-root";
    }
  };
  globalThis.ShadowRoot = ShadowRoot;
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
    "onwheel"
  ];
  var Document = class _Document extends Node {
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
      this.readyState = "loading";
      const html = new Element("html");
      const head = new Element("head");
      const body = new Element("body");
      html._parent = this;
      this._children.push(html);
      head._parent = html;
      html._children.push(head);
      body._parent = html;
      html._children.push(body);
      this.documentElement = html;
      for (const name of GLOBAL_EVENT_HANDLER_ATTRS) this[name] = null;
    }
    // jQuery's `mc(node)` helper resolves a node back to its window
    // via `doc.defaultView || doc.parentWindow`; without these the
    // offset / scroll path throws "Cannot read properties of
    // undefined (reading 'pageYOffset')".
    get defaultView() {
      return globalThis;
    }
    get parentWindow() {
      return globalThis;
    }
    // HTML spec `Document.location` aliases `window.location`. Forem's
    // searchParams.js reads `document.location.search`; without this
    // getter the call hits `undefined.search` and the whole bundle's
    // top-level module init aborts before the search-feed fetch fires.
    get location() {
      return globalThis.location;
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
    get URL() {
      return globalThis.location && globalThis.location.href || "";
    }
    get documentURI() {
      return this.URL;
    }
    get baseURI() {
      return this.URL;
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
    createElement(tag) {
      const t = String(tag).toLowerCase();
      const ctor = getCustomElementCtor(t);
      if (ctor) {
        const prev = __currentTag;
        __currentTag = t;
        try {
          return new ctor();
        } finally {
          __currentTag = prev;
        }
      }
      return new Element(t);
    }
    // `createElementNS(ns, tag)` per DOM spec. Preact's `z` function
    // takes this path for any SVG tag (it checks the SVG-namespace
    // flag and routes through createElementNS). Without it, Forem's
    // Preact-rendered editor — which uses inline SVG icons via
    // crayons_icon_tag — throws during diff and the whole component
    // tree fails to mount. We ignore the namespace argument since
    // we don't track SVG vs HTML namespaces (no layout engine to
    // care about the distinction); the tag-only fallback works
    // because matcher / cascade / event-dispatch paths don't
    // discriminate by ns either.
    createElementNS(_ns, tag) {
      return this.createElement(tag);
    }
    createTextNode(data) {
      return new Text(data);
    }
    createComment(data) {
      return new Comment(String(data == null ? "" : data));
    }
    get body() {
      const html = this.documentElement;
      if (!html) return null;
      for (const c of html._children) {
        if (c._tag === "body") return c;
      }
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
      return title ? title.textContent : "";
    }
    // Per HTML spec, `document.referrer` is always a string — empty for
    // a top-level navigation with no referrer. Tracking libraries
    // (Ahoy / Honeybadger) read `document.referrer.length` during their
    // setTimeout-scheduled init; without this getter the read returns
    // `undefined`, throws, and the timer's downstream side effects
    // (visit registration, follow-up render scheduling) never happen.
    get referrer() {
      return "";
    }
    set title(v) {
      let head = this.head;
      if (!head) {
        head = new Element("head");
        head._parent = this.documentElement;
        this.documentElement._children.unshift(head);
        registerSubtree(head);
      }
      let title = head.querySelector("title");
      if (!title) {
        title = new Element("title");
        title._parent = head;
        head._children.push(title);
        registerSubtree(title);
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
      return this.documentElement ? selectFirst([this.documentElement], sel, this.documentElement) : null;
    }
    querySelectorAll(sel) {
      return this.documentElement ? selectAll([this.documentElement], sel, this.documentElement) : [];
    }
    // wgxpath optimizes `descendant::name` and `descendant::*` against
    // Document-rooted queries via getElementsByTagName. Without these
    // shims the descendant axis returns empty from a Document context.
    // Per DOM spec these include self when called on Document (the
    // documentElement IS a descendant of Document), so `//html`
    // matching documentElement is a hard requirement Capybara relies
    // on for `find(:css, 'html')` and `match_selector('html')`.
    getElementsByTagName(tag) {
      const root = this.documentElement;
      if (!root) return [];
      const want = String(tag).toLowerCase();
      const out = want === "*" || root._tag === want ? [root] : [];
      const tail = root.getElementsByTagName(tag);
      for (let i = 0; i < tail.length; i++) out.push(tail[i]);
      return out;
    }
    getElementsByClassName(cls) {
      const root = this.documentElement;
      if (!root) return [];
      const classes2 = String(cls).split(/\s+/).filter(Boolean);
      const has = (el) => classes2.every((c) => el.classList && el.classList.contains(c));
      const out = has(root) ? [root] : [];
      const tail = root.getElementsByClassName(cls);
      for (let i = 0; i < tail.length; i++) out.push(tail[i]);
      return out;
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
      return new DocumentFragment();
    }
    // `Document.createEvent(interfaceName)` — legacy DOM Level 2 API
    // still used by libraries that target older browsers (Trix's
    // `triggerEvent` builds `document.createEvent("Event")` /
    // `event.initEvent(...)` so it works without `new Event()`
    // support detection). The returned event needs `initEvent` /
    // `initCustomEvent` mutators per the spec.
    createEvent(interfaceName) {
      const name = String(interfaceName || "").toLowerCase();
      const Ctor = name === "customevent" || name === "customevents" ? globalThis.CustomEvent : globalThis.Event;
      const ev = new Ctor("", { bubbles: false, cancelable: false });
      ev.initEvent = function(type, bubbles, cancelable) {
        ev.type = String(type || "");
        ev.bubbles = !!bubbles;
        ev.cancelable = !!cancelable;
      };
      ev.initCustomEvent = function(type, bubbles, cancelable, detail) {
        ev.type = String(type || "");
        ev.bubbles = !!bubbles;
        ev.cancelable = !!cancelable;
        ev.detail = detail;
      };
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
      if (node._parent && typeof node._parent.removeChild === "function") {
        try {
          node._parent.removeChild(node);
        } catch (_) {
        }
      }
      const dest = this;
      walkSubtree(node, (n) => {
        n._ownerDoc = dest;
      });
      return node;
    }
    // `document.implementation.createHTMLDocument(title)` — DOMParser
    // shims and Turbo Drive page-snapshot logic both probe it. We
    // return a fresh Document with a minimal `<html><head><title>X</title>
    // </head><body></body></html>` skeleton; full HTML-spec
    // construction (DOCTYPE / quirks-mode flag) is out of scope.
    get implementation() {
      return {
        createHTMLDocument: (title) => {
          const d = new _Document();
          const html = new Element("html");
          const head = new Element("head");
          const body = new Element("body");
          html._children = [head, body];
          head._parent = html;
          body._parent = html;
          d.documentElement = html;
          html._parent = d;
          d._children = [html];
          if (title != null) {
            const t = new Element("title");
            t._children = [Object.assign(new Text(String(title)), { _parent: t })];
            t._parent = head;
            head._children.push(t);
          }
          return d;
        },
        hasFeature: () => true
      };
    }
    // Minimal Range stub. wgxpath uses `document.createRange()` +
    // `compareBoundaryPoints` to sort XPath result sets into document
    // order. We don't model partial-range selection (start/end offsets
    // on text nodes etc.); only document-order comparison between two
    // nodes' start containers, which is the only thing wgxpath drives.
    createRange() {
      return new DocumentOrderRange();
    }
    // Minimal NodeIterator. DOMPurify is the canonical consumer —
    // it walks a freshly-parsed sanitisation fragment via
    // `nextNode()` and uses `whatToShow` to gate ELEMENT / TEXT /
    // COMMENT visits. We pre-collect descendants in document order;
    // DOMPurify operates on small per-call fragments so the up-front
    // walk is cheaper than the per-step sibling/ancestor traversal.
    createNodeIterator(root, whatToShow, filter) {
      if (whatToShow == null) whatToShow = 4294967295;
      const all = [];
      walkSubtree(root, (n) => all.push(n));
      const accept = (n) => {
        const mask = 1 << n.nodeType - 1;
        if (!(mask & whatToShow)) return 3;
        if (filter) {
          const fn = typeof filter === "function" ? filter : filter && filter.acceptNode;
          if (fn) {
            const r = fn.call(filter || null, n);
            if (r === 2 || r === 3 || r === false) return 3;
          }
        }
        return 1;
      };
      let i = -1;
      return {
        root,
        whatToShow,
        filter,
        referenceNode: root,
        pointerBeforeReferenceNode: true,
        nextNode() {
          while (++i < all.length) {
            if (accept(all[i]) !== 1) continue;
            this.referenceNode = all[i];
            this.pointerBeforeReferenceNode = false;
            return all[i];
          }
          return null;
        },
        previousNode() {
          while (--i >= 0) {
            if (accept(all[i]) !== 1) continue;
            this.referenceNode = all[i];
            this.pointerBeforeReferenceNode = false;
            return all[i];
          }
          return null;
        },
        detach() {
        }
      };
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
      if (whatToShow == null) whatToShow = 4294967295;
      const all = [];
      walkSubtree(root, (n) => all.push(n));
      const accept = (n) => {
        if (!n) return 2;
        const mask = 1 << n.nodeType - 1;
        if (!(mask & whatToShow)) return 3;
        if (filter) {
          const fn = typeof filter === "function" ? filter : filter && filter.acceptNode;
          if (fn) return fn.call(filter || null, n);
        }
        return 1;
      };
      const tw = {
        root,
        whatToShow,
        filter,
        currentNode: root,
        nextNode() {
          const i = all.indexOf(this.currentNode);
          for (let j = i + 1; j < all.length; j++) {
            if (accept(all[j]) === 1) {
              this.currentNode = all[j];
              return all[j];
            }
          }
          return null;
        },
        previousNode() {
          const i = all.indexOf(this.currentNode);
          for (let j = i - 1; j >= 0; j--) {
            if (accept(all[j]) === 1) {
              this.currentNode = all[j];
              return all[j];
            }
          }
          return null;
        },
        parentNode() {
          let p = this.currentNode && this.currentNode._parent;
          while (p && p !== root && accept(p) !== 1) p = p._parent;
          if (p && p !== root) {
            this.currentNode = p;
            return p;
          }
          return null;
        },
        firstChild() {
          const c = this.currentNode && this.currentNode._children;
          if (c) {
            for (const k of c) if (accept(k) === 1) {
              this.currentNode = k;
              return k;
            }
          }
          return null;
        },
        lastChild() {
          const c = this.currentNode && this.currentNode._children;
          if (c) {
            for (let i = c.length - 1; i >= 0; i--) if (accept(c[i]) === 1) {
              this.currentNode = c[i];
              return c[i];
            }
          }
          return null;
        },
        nextSibling() {
          const p = this.currentNode && this.currentNode._parent;
          const c = p && p._children;
          if (!c) return null;
          const i = c.indexOf(this.currentNode);
          for (let j = i + 1; j < c.length; j++) if (accept(c[j]) === 1) {
            this.currentNode = c[j];
            return c[j];
          }
          return null;
        },
        previousSibling() {
          const p = this.currentNode && this.currentNode._parent;
          const c = p && p._children;
          if (!c) return null;
          const i = c.indexOf(this.currentNode);
          for (let j = i - 1; j >= 0; j--) if (accept(c[j]) === 1) {
            this.currentNode = c[j];
            return c[j];
          }
          return null;
        }
      };
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
          const text = new Text(str);
          active._children.push(text);
          text._parent = active;
          try {
            dispatchEvent(active, new globalThis.InputEvent("input", { bubbles: true, cancelable: true, data: str, inputType: "insertText" }));
          } catch (_) {
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
  };
  var DocumentOrderRange = class _DocumentOrderRange {
    constructor() {
      this.startContainer = null;
      this.startOffset = 0;
      this.endContainer = null;
      this.endOffset = 0;
    }
    setStart(node, offset) {
      this.startContainer = node;
      this.startOffset = offset | 0;
    }
    setEnd(node, offset) {
      this.endContainer = node;
      this.endOffset = offset | 0;
    }
    // Boundary helpers — node-relative variants of setStart / setEnd.
    // `setStartBefore(n)` puts the range start at (n.parentNode,
    // indexOf(n)); `setStartAfter` adds 1; ditto for end. Per HTML
    // spec — the offset is the position of `n` among its parent's
    // children. The old "offset=0" approximation broke partial-quote
    // tests where the range was supposed to skip past leading
    // siblings, and quote-reply's cloneContents walked from the
    // wrong start position.
    setStartBefore(node) {
      const p = node && node._parent;
      this.startContainer = p || node;
      this.startOffset = p ? p._children.indexOf(node) : 0;
    }
    setStartAfter(node) {
      const p = node && node._parent;
      this.startContainer = p || node;
      this.startOffset = p ? p._children.indexOf(node) + 1 : 0;
    }
    setEndBefore(node) {
      const p = node && node._parent;
      this.endContainer = p || node;
      this.endOffset = p ? p._children.indexOf(node) : 0;
    }
    setEndAfter(node) {
      const p = node && node._parent;
      this.endContainer = p || node;
      this.endOffset = p ? p._children.indexOf(node) + 1 : 0;
    }
    // Real DOM: selectNode sets the range to span the given node
    // *within* its parent. Collapse moves both endpoints to one side.
    // wgxpath only cares that the start container ends up referring to
    // the node we passed.
    selectNode(node) {
      this.startContainer = this.endContainer = node;
      this.startOffset = this.endOffset = 0;
    }
    selectNodeContents(node) {
      this.startContainer = this.endContainer = node;
      this.startOffset = 0;
      this.endOffset = node.nodeType === NODE_TEXT ? (node.data || "").length : node._children ? node._children.length : 0;
    }
    // `Range.intersectsNode(node)` — true if any part of node overlaps
    // the range. quote-reply uses this to find which of the
    // window.getSelection() ranges intersects the issue description.
    intersectsNode(node) {
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
      const frag = cloneRangeContents(this);
      deleteRangeContents(this);
      return frag;
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
      const sc = this.startContainer;
      if (!sc) return;
      if (sc.nodeType === NODE_TEXT) {
        const parent = sc._parent;
        if (!parent) return;
        const text = sc.data || "";
        const before = text.slice(0, this.startOffset);
        const after = text.slice(this.startOffset);
        sc.data = before;
        const idx = parent._children.indexOf(sc);
        if (after.length > 0) {
          const tail = new Text(after);
          parent.insertBefore(tail, parent._children[idx + 1] || null);
        }
        parent.insertBefore(node, parent._children[idx + 1] || null);
      } else {
        const ref = sc._children ? sc._children[this.startOffset] : null;
        sc.insertBefore(node, ref || null);
      }
      this.setStartAfter(node);
      this.collapse(true);
    }
    // Range#surroundContents(newParent): extract range contents, wrap
    // in `newParent`, insert wrapper at the range's start. Used by
    // highlight / annotate libraries.
    surroundContents(newParent) {
      const frag = this.extractContents();
      newParent.appendChild(frag);
      this.insertNode(newParent);
    }
    // Range#comparePoint(node, offset) — -1/0/+1 vs the range.
    // Range#isPointInRange(node, offset) — true if inside.
    comparePoint(node, offset) {
      if (!this.startContainer || !this.endContainer) return 0;
      if (compareDocOrder(node, this.startContainer) < 0) return -1;
      if (compareDocOrder(node, this.endContainer) > 0) return 1;
      return 0;
    }
    isPointInRange(node, offset) {
      return this.comparePoint(node, offset) === 0;
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
    compareBoundaryPoints(_how, other) {
      return compareDocOrder(this.startContainer, other.startContainer);
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
  var FORM_ASSOCIATED_TAGS = /* @__PURE__ */ new Set([
    "input",
    "select",
    "textarea",
    "button",
    "fieldset",
    "object",
    "output"
  ]);
  function rangeIntersectsNode(range, node) {
    if (!range.startContainer) return false;
    if (nodeContains(node, range.startContainer)) return true;
    if (nodeContains(node, range.endContainer)) return true;
    if (nodeContains(range.startContainer, node) && nodeContains(range.endContainer, node)) return true;
    const s = compareDocOrder(range.startContainer, node);
    const e = compareDocOrder(range.endContainer, node);
    if (s <= 0 && e >= 0) return true;
    return false;
  }
  function __rangeAncestorChild(ancestor, descendant) {
    let cur = descendant;
    while (cur && cur._parent && cur._parent !== ancestor) cur = cur._parent;
    return cur && cur._parent === ancestor ? cur : null;
  }
  function __appendCloned(parent, child) {
    child._parent = parent;
    parent._children.push(child);
  }
  function __emitSlice(target, subtree, startCut, endCut) {
    const kids = subtree._children || [];
    let startIdx = 0, startChild = null;
    if (startCut) {
      if (startCut.container === subtree) {
        startIdx = startCut.offset;
      } else {
        startChild = __rangeAncestorChild(subtree, startCut.container);
        if (startChild) startIdx = kids.indexOf(startChild) + 1;
      }
    }
    let endIdx = kids.length, endChild = null;
    if (endCut) {
      if (endCut.container === subtree) {
        endIdx = endCut.offset;
      } else {
        endChild = __rangeAncestorChild(subtree, endCut.container);
        if (endChild) endIdx = kids.indexOf(endChild);
      }
    }
    if (startChild && startChild === endChild) {
      __appendCloned(target, __cloneSlice(startChild, startCut, endCut));
      return;
    }
    if (startChild) __appendCloned(target, __cloneSlice(startChild, startCut, null));
    for (let i = startIdx; i < endIdx; i++) {
      if (kids[i]) __appendCloned(target, kids[i].cloneNode(true));
    }
    if (endChild) __appendCloned(target, __cloneSlice(endChild, null, endCut));
  }
  function __cloneSlice(subtree, startCut, endCut) {
    if (subtree.nodeType === NODE_TEXT) {
      const data = subtree.data || "";
      const lo = startCut && startCut.container === subtree ? startCut.offset : 0;
      const hi = endCut && endCut.container === subtree ? endCut.offset : data.length;
      return new Text(data.slice(lo, hi));
    }
    const shell = subtree.cloneNode(false);
    __emitSlice(shell, subtree, startCut, endCut);
    return shell;
  }
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
  globalThis.__csimInsertTextAtSelection = __csimInsertTextAtSelection;
  function deleteRangeContents(range) {
    const sc = range.startContainer, so = range.startOffset | 0;
    const ec = range.endContainer, eo = range.endOffset | 0;
    if (sc === ec && sc && sc._children) {
      const end = Math.min(eo, sc._children.length);
      for (let i = end - 1; i >= so; i--) {
        const child = sc._children[i];
        if (child) sc.removeChild(child);
      }
      range.endOffset = range.startOffset;
      range.endContainer = range.startContainer;
    } else if (sc === ec && sc && sc.nodeType === NODE_TEXT) {
      const data = sc.data || "";
      sc.data = data.slice(0, so) + data.slice(eo);
      range.endOffset = range.startOffset;
    }
  }
  function cloneRangeContents(range) {
    const frag = new DocumentFragment();
    if (!range.startContainer || !range.endContainer) return frag;
    const sc = range.startContainer, so = range.startOffset;
    const ec = range.endContainer, eo = range.endOffset;
    if (sc === ec) {
      if (sc.nodeType === NODE_TEXT) {
        __appendCloned(frag, new Text((sc.data || "").slice(so, eo)));
      } else if (sc._children) {
        for (let i = so; i < Math.min(eo, sc._children.length); i++) {
          __appendCloned(frag, sc._children[i].cloneNode(true));
        }
      }
      return frag;
    }
    const ancestor = range.commonAncestorContainer;
    if (ancestor) {
      __emitSlice(frag, ancestor, { container: sc, offset: so }, { container: ec, offset: eo });
    }
    return frag;
  }
  DocumentOrderRange.END_TO_START = 3;
  DocumentOrderRange.prototype.START_TO_START = 0;
  DocumentOrderRange.prototype.START_TO_END = 1;
  DocumentOrderRange.prototype.END_TO_END = 2;
  DocumentOrderRange.prototype.END_TO_START = 3;
  globalThis.Range = DocumentOrderRange;
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
  function ancestorChain(node) {
    const chain = [];
    let cur = node;
    while (cur) {
      chain.unshift(cur);
      cur = cur._parent;
    }
    return chain;
  }
  function makeAttr(el, name) {
    return {
      name,
      nodeName: name,
      value: el._attrs[name],
      nodeValue: el._attrs[name],
      specified: true,
      namespaceURI: null,
      prefix: null,
      localName: name,
      ownerElement: el,
      ownerDocument: globalThis.document,
      // wgxpath calls `node.ownerDocument.createRange()` for
      // document-order comparison. Real DOM gives every node a
      // valid ownerDocument; we have to thread it through Attr
      // shims explicitly since they're plain objects.
      parentNode: null,
      nodeType: 2
      // ATTRIBUTE_NODE
    };
  }
  var { parseDocument, parseFragment } = installHtmlParser({ Document, Element, Text, DocumentFragment });

  // lib/capybara/simulated/js/src/abort.js
  function defaultAbortReason() {
    return new DOMException("signal is aborted without reason", "AbortError");
  }
  var AbortSignal = class _AbortSignal extends EventTarget {
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
      globalThis.setTimeout(() => s._markAborted(new DOMException("signal timed out", "TimeoutError")), Number(ms) || 0);
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
  globalThis.Audio = Audio;

  // lib/capybara/simulated/js/src/canvas.js
  var ImageData = class {
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
  var CanvasRenderingContext2D = class {
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
  globalThis.ImageData = ImageData;
  globalThis.ImageBitmap = ImageBitmap;
  globalThis.CanvasRenderingContext2D = CanvasRenderingContext2D;
  globalThis.OffscreenCanvas = OffscreenCanvas;
  globalThis.createImageBitmap = createImageBitmap;

  // lib/capybara/simulated/js/src/video.js
  function isVideo(node) {
    return node && node._tag === "video";
  }
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
  function onVideoSrcAssigned(video, src) {
    if (!isVideo(video) || !src) return;
    decodeAndDispatch(video, src);
  }
  function installVideoIDL(ElementCtor) {
    const proto = ElementCtor.prototype;
    if (proto._csimVideoIDLInstalled) return;
    proto._csimVideoIDLInstalled = true;
    const def = (name, get, set) => Object.defineProperty(proto, name, { configurable: true, get, set });
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

  // lib/capybara/simulated/js/src/dialogs.js
  function alert(message) {
    globalThis.__modalDialog("alert", String(message == null ? "" : message), null);
  }
  function confirm(message) {
    return !!globalThis.__modalDialog("confirm", String(message == null ? "" : message), null);
  }
  function prompt(message, def) {
    return globalThis.__modalDialog(
      "prompt",
      String(message == null ? "" : message),
      def == null ? "" : String(def)
    );
  }
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
  var TextEncoder2 = class {
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
  };
  var TextDecoder = class {
    constructor(label) {
      this.encoding = (label || "utf-8").toString().toLowerCase();
    }
    decode(input) {
      if (input == null) return "";
      const buf = input.buffer ? new Uint8Array(input.buffer, input.byteOffset || 0, input.byteLength) : input instanceof ArrayBuffer ? new Uint8Array(input) : input;
      let out = "";
      for (let i = 0; i < buf.length; ) {
        const b1 = buf[i++];
        let cp;
        if (b1 < 128) cp = b1;
        else if ((b1 & 224) === 192) cp = (b1 & 31) << 6 | buf[i++] & 63;
        else if ((b1 & 240) === 224) cp = (b1 & 15) << 12 | (buf[i++] & 63) << 6 | buf[i++] & 63;
        else if ((b1 & 248) === 240) cp = (b1 & 7) << 18 | (buf[i++] & 63) << 12 | (buf[i++] & 63) << 6 | buf[i++] & 63;
        else cp = 65533;
        if (cp > 65535) {
          cp -= 65536;
          out += String.fromCharCode(55296 + (cp >> 10), 56320 + (cp & 1023));
        } else {
          out += String.fromCharCode(cp);
        }
      }
      return out;
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

  // lib/capybara/simulated/js/src/request-body.js
  function setContentTypeIfMissing(headers, value) {
    if (!("Content-Type" in headers) && !("content-type" in headers)) {
      headers["Content-Type"] = value;
    }
  }
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
  function serializeBlob(blob, headers) {
    if (blob.type) setContentTypeIfMissing(headers, blob.type);
    const raw = blobBytes(blob);
    return { body: raw ? globalThis.btoa(raw) : "", b64: true };
  }
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

  // lib/capybara/simulated/js/src/fetch.js
  var Request = class _Request {
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
  globalThis.fetch = function fetch(input, init) {
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
  };
  globalThis.Request = Request;
  globalThis.Response = Response;

  // lib/capybara/simulated/js/src/file-reader.js
  var FileReader = class extends EventTarget {
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
  var FormData = class {
    constructor(form, submitter) {
      this._entries = [];
      if (form && form._tag === "form") {
        const spec = globalThis.__csimFormSerialize(form._id, 0);
        if (spec && Array.isArray(spec.fields)) {
          for (const pair of spec.fields) this._entries.push([String(pair[0]), String(pair[1])]);
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
  function nearestPreAncestor(node) {
    for (let cur = node; cur; cur = cur._parent) {
      if (cur.nodeType === NODE_ELEMENT && cur._tag === "pre") return cur;
    }
    return null;
  }
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
  function findBlockAncestor(node) {
    for (let cur = node; cur; cur = cur._parent) {
      if (cur.nodeType !== NODE_ELEMENT) continue;
      if (BLOCK_TAGS.has(cur._tag)) return cur;
    }
    return null;
  }
  function deepestLastText(root) {
    let n = root;
    while (n && n._children && n._children.length > 0) {
      n = n._children[n._children.length - 1];
    }
    return n;
  }
  function deepestFirstText(root) {
    let n = root;
    while (n && n._children && n._children.length > 0) {
      n = n._children[0];
    }
    return n;
  }
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
  function __appendValue(n, ch) {
    if (ch == null) return;
    const cur = n._attrs.value != null ? n._attrs.value : "";
    const s = n._selectionStart != null ? n._selectionStart : cur.length;
    const e = n._selectionEnd != null ? n._selectionEnd : s;
    const composed = cur.slice(0, s) + ch + cur.slice(e);
    const maxlen = parseInt(n._attrs.maxlength || "", 10);
    n._attrs.value = maxlen > 0 && composed.length > maxlen ? composed.slice(0, maxlen) : composed;
    if (n._tag === "textarea") {
      n._children = [Object.assign(new Text(n._attrs.value), { _parent: n })];
    }
    const caret = Math.min(n._attrs.value.length, s + ch.length);
    n._selectionStart = caret;
    n._selectionEnd = caret;
  }
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
    if (typeable || isCheckOrRadio) {
      try {
        n.focus();
      } catch (_) {
      }
    }
    const startValue = typeable ? n._attrs.value || "" : null;
    const pressKey = (info, modifiers) => {
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
        const linkNewTab = isLink && hasMods;
        const okDefault = !blocked && n._attrs.disabled == null;
        if (linkNewTab || okDefault && (isLink || isButton && !hasMods)) {
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
        const doDefault = () => {
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
              if (n._tag === "textarea") n._children = [Object.assign(new Text(next), { _parent: n })];
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
        };
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
    };
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
        if ((mods.ctrlKey || mods.metaKey) && lowerKey === "v") {
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
                  n._children = [Object.assign(new Text(next), { _parent: n })];
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
      n._children = [];
      n._children.push(Object.assign(new Text(v), { _parent: n }));
      n._attrs.value = v;
      n._selectionStart = v.length;
      n._selectionEnd = v.length;
    } else if (tag === "input") {
      const type = (n._attrs.type || "text").toLowerCase();
      if (type === "checkbox" || type === "radio") {
        const wasChecked = n._attrs.checked != null;
        if (value === true || value === "true") {
          if (type === "radio") setRadio(n);
          else n._attrs.checked = "";
        } else if (value === false || value === "false") delete n._attrs.checked;
        else n._attrs.value = v;
        if (n._attrs.checked != null !== wasChecked) {
          try {
            dispatchEvent(n, new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, which: 1 }));
          } catch (_) {
          }
        }
        kind = "checked";
      } else if (type === "range" || type === "number") {
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
  function selectOptionExclusive(select, opt) {
    const multi = select._attrs.multiple != null;
    const opts = select.querySelectorAll("option");
    if (!multi) for (const o of opts) delete o._attrs.selected;
    opt._attrs.selected = "";
  }
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
  function __ancestorSelect(option) {
    let cur = option._parent;
    while (cur && cur._tag !== "select") cur = cur._parent;
    return cur && cur._tag === "select" ? cur : null;
  }
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
    const isDescendant = (el) => {
      for (let cur = el._parent; cur; cur = cur._parent) if (cur === form) return true;
      return false;
    };
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
          fileInputs.push({ name, handle: f._id });
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
    return {
      action: subAction != null ? subAction : form._attrs.action != null ? form._attrs.action : "",
      method: (subMethod || form._attrs.method || "get").toLowerCase(),
      enctype: (subEnctype || form._attrs.enctype || "application/x-www-form-urlencoded").toLowerCase(),
      fields,
      fileInputs
    };
  };

  // lib/capybara/simulated/js/src/history.js
  var _state = null;
  var _length = 1;
  function applyHistoryUrl(state2, url, push) {
    _state = state2 === void 0 ? null : state2;
    const target = url == null ? globalThis.location && globalThis.location.href : String(url);
    if (push) {
      if (typeof globalThis.__pushHistoryEntry === "function") globalThis.__pushHistoryEntry(target, _state);
      _length += 1;
    } else if (typeof globalThis.__setCurrentUrl === "function") {
      globalThis.__setCurrentUrl(target, _state);
    }
    if (url != null && typeof globalThis.__csimUpdateLocation === "function") {
      globalThis.__csimUpdateLocation(target);
    }
  }
  var history = {
    get length() {
      return _length;
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
  globalThis.__csimDocumentTitle = function() {
    const head = globalThis.document.head;
    if (!head) return "";
    const t = head._children.find((c) => c._tag === "title");
    return t ? t.textContent : "";
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
    const opts = sel.querySelectorAll("option");
    let firstEnabled = null;
    for (const o of opts) {
      if (o._attrs.selected != null) return false;
      if (o._attrs.disabled == null && firstEnabled === null) firstEnabled = o;
    }
    return n === firstEnabled;
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
  function ensureDb(name) {
    if (!_db.has(name)) _db.set(name, /* @__PURE__ */ new Map());
    if (!_meta.has(name)) _meta.set(name, { version: 0, storeNames: /* @__PURE__ */ new Set() });
    return _db.get(name);
  }
  function ensureStore(dbName, storeName) {
    const db = ensureDb(dbName);
    if (!db.has(storeName)) db.set(storeName, /* @__PURE__ */ new Map());
    return db.get(storeName);
  }
  function cmpKey(a, b) {
    if (a === b) return 0;
    return a < b ? -1 : 1;
  }
  function sortedEntries(map) {
    return Array.from(map.entries()).sort((a, b) => cmpKey(a[0], b[0]));
  }
  var IDBKeyRange = class _IDBKeyRange {
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
  function asPredicate(query) {
    if (query == null) return () => true;
    if (query instanceof IDBKeyRange) return (k) => query.includes(k);
    return (k) => cmpKey(k, query) === 0;
  }
  var IDBRequest = class extends EventTarget {
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
  var IDBDatabase = class extends EventTarget {
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
      return new IDBObjectStore(this.name, name, opts || {});
    }
    deleteObjectStore(name) {
      _meta.get(this.name).storeNames.delete(name);
      _db.get(this.name).delete(name);
    }
    transaction(storeNames, mode) {
      return new IDBTransaction(this, storeNames, mode);
    }
    close() {
    }
  };
  var IDBTransaction = class extends EventTarget {
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
    constructor(dbName, name, opts) {
      super();
      this.name = name;
      this._dbName = dbName;
      this.keyPath = opts && opts.keyPath || null;
      this.autoIncrement = !!(opts && opts.autoIncrement);
      this.transaction = null;
      this._indexes = /* @__PURE__ */ new Map();
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
    put(value, key) {
      return newRequest(this, (req) => {
        const k = key !== void 0 ? key : this._extractKey(value);
        this._store().set(k, value);
        req.result = k;
      });
    }
    add(value, key) {
      return this.put(value, key);
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
      const step = () => {
        if (i >= entries.length) {
          req.result = null;
        } else {
          const [k, v] = entries[i++];
          req.result = new IDBCursor(req, k, keyOnly ? void 0 : v, step);
        }
        Promise.resolve().then(() => dispatchWithOnHandler(req, { type: "success", target: req }));
      };
      step();
      if (this.transaction) Promise.resolve().then(() => this.transaction._maybeComplete());
      return req;
    }
    createIndex(name, _keyPath, _opts) {
      this._indexes.set(name, new IDBIndex(this, name));
      return this._indexes.get(name);
    }
    index(name) {
      return this._indexes.get(name) || new IDBIndex(this, name);
    }
    deleteIndex(name) {
      this._indexes.delete(name);
    }
    _extractKey(value) {
      if (!this.keyPath) return void 0;
      if (Array.isArray(this.keyPath)) return this.keyPath.map((p) => value && value[p]);
      return value && value[this.keyPath];
    }
  };
  var IDBIndex = class extends EventTarget {
    constructor(objectStore, name) {
      super();
      this.name = name;
      this.objectStore = objectStore;
      this.keyPath = null;
      this.unique = false;
      this.multiEntry = false;
    }
    get(query) {
      return this.objectStore.get(query);
    }
    getKey(query) {
      return this.objectStore.getKey(query);
    }
    getAll(q, n) {
      return this.objectStore.getAll(q, n);
    }
    getAllKeys(q, n) {
      return this.objectStore.getAllKeys(q, n);
    }
    count(q) {
      return this.objectStore.count(q);
    }
    openCursor(q, dir) {
      return this.objectStore.openCursor(q, dir);
    }
    openKeyCursor(q, dir) {
      return this.objectStore.openKeyCursor(q, dir);
    }
  };
  var IDBCursor = class {
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
      query() {
        return Promise.resolve({ state: "prompt", addEventListener() {
        }, removeEventListener() {
        }, dispatchEvent() {
        } });
      }
    },
    hardwareConcurrency: 4,
    maxTouchPoints: 0,
    doNotTrack: null,
    pdfViewerEnabled: false,
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
  function b64ToBytes(b64) {
    let s = String(b64 || "").replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    return latin1ToBytes(globalThis.atob(s));
  }
  function b64ToBuffer(b64) {
    return b64ToBytes(b64).buffer;
  }
  function toUint8(buf) {
    if (!buf) return new Uint8Array(0);
    if (buf instanceof Uint8Array) return buf;
    if (buf instanceof ArrayBuffer) return new Uint8Array(buf);
    if (ArrayBuffer.isView(buf)) return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    if (Array.isArray(buf)) return new Uint8Array(buf);
    return new Uint8Array(0);
  }
  function namedError(message, name) {
    const err = new Error(String(message || ""));
    err.name = name || "NotAllowedError";
    return err;
  }
  function parseHostError(raw) {
    if (raw == null) return namedError("No virtual authenticator", "NotAllowedError");
    if (typeof raw === "object" && raw.error) {
      return namedError(raw.error, raw.name);
    }
    return null;
  }
  function abortIfNeeded(signal) {
    if (signal && signal.aborted) {
      throw namedError("The operation was aborted.", "AbortError");
    }
  }
  var AuthenticatorResponse = class {
    constructor(clientDataJSON) {
      this.clientDataJSON = clientDataJSON;
    }
  };
  var AuthenticatorAttestationResponse = class extends AuthenticatorResponse {
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
    constructor(clientDataJSON, authenticatorData, signature, userHandle) {
      super(clientDataJSON);
      this.authenticatorData = authenticatorData;
      this.signature = signature;
      this.userHandle = userHandle;
    }
  };
  var PublicKeyCredential = class {
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
  globalThis.frames = globalThis;
  globalThis.frameElement = null;
  globalThis.pageXOffset = 0;
  globalThis.pageYOffset = 0;
  globalThis.scrollX = 0;
  globalThis.scrollY = 0;
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
  globalThis.scrollTo = function() {
  };
  globalThis.scrollBy = function() {
  };
  globalThis.scroll = function() {
  };
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
    static fromPoint(p) {
      return new _DOMPoint(p && p.x, p && p.y, p && p.z, p && p.w);
    }
  };
  var DOMRectReadOnly = class _DOMRectReadOnly {
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
  globalThis.structuredClone = function structuredClone(v) {
    return cloneInto(v, /* @__PURE__ */ new Map());
  };
  globalThis.reportError = function reportError(e) {
    try {
      console.error(e && e.stack ? e.stack : String(e));
    } catch (_) {
    }
  };
  globalThis.requestIdleCallback = function(cb) {
    return globalThis.setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 0 }), 0);
  };
  globalThis.cancelIdleCallback = function(id) {
    globalThis.clearTimeout(id);
  };
  var CSSStyleDeclaration = class {
    constructor() {
    }
  };
  var CSSRule = class {
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
    item(i) {
      return this[i] || null;
    }
  };
  var CSSStyleSheet = class {
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
    constructor() {
      this.items = new DataTransferItemList();
      this.dropEffect = "none";
      this.effectAllowed = "all";
      this.types = [];
      this.files = [];
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
  globalThis.NodeFilter = {
    SHOW_ALL: 4294967295,
    SHOW_ELEMENT: 1,
    SHOW_ATTRIBUTE: 2,
    SHOW_TEXT: 4,
    SHOW_CDATA_SECTION: 8,
    SHOW_PROCESSING_INSTRUCTION: 64,
    SHOW_COMMENT: 128,
    SHOW_DOCUMENT: 256,
    SHOW_DOCUMENT_TYPE: 512,
    SHOW_DOCUMENT_FRAGMENT: 1024,
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
  var Selection = class {
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
  function logErr(err, kind, promise) {
    if (!err || err[LOGGED]) return;
    err[LOGGED] = true;
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
  var origThen = Promise.prototype.then;
  var alreadyWrapped = /* @__PURE__ */ new WeakSet();
  function propagateAndLog(self) {
    return function(err) {
      logErr(err, "propagated", self);
      throw err;
    };
  }
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
  Promise.prototype.then = function(onF, onR) {
    if (typeof onR === "function") return origThen.call(this, onF, onR);
    if (alreadyWrapped.has(this)) return origThen.call(this, onF);
    const next = origThen.call(this, wrapOnF(this, onF), propagateAndLog(this));
    alreadyWrapped.add(next);
    return next;
  };

  // lib/capybara/simulated/js/src/url.js
  function buildHref(u) {
    const search = u._search && u._search[0] !== "?" && u._search.length ? "?" + u._search : u._search || "";
    const hash = u._hash && u._hash[0] !== "#" && u._hash.length ? "#" + u._hash : u._hash || "";
    return u._protocol + "//" + (u._username ? u._username + (u._password ? ":" + u._password : "") + "@" : "") + u._host + u._pathname + search + hash;
  }
  function normSearch(val) {
    const s = String(val == null ? "" : val);
    if (!s.length) return "";
    return s[0] === "?" ? s : "?" + s;
  }
  function normHash(val) {
    const s = String(val == null ? "" : val);
    if (!s.length) return "";
    return s[0] === "#" ? s : "#" + s;
  }
  var URL2 = class _URL {
    constructor(input, base) {
      const u = globalThis.__csim_parseUrl(String(input), base != null ? String(base) : null);
      if (!u || u.error) throw new TypeError("Invalid URL: " + input);
      this._protocol = u.protocol;
      this._username = u.username;
      this._password = u.password;
      this._host = u.host;
      this._hostname = u.hostname;
      this._port = u.port;
      this._pathname = u.pathname;
      this._search = u.search;
      this._hash = u.hash;
      this._origin = u.origin;
      this.searchParams = new URLSearchParams(this._search);
    }
    // `href`'s setter parses a fresh URL — Forem's followButtons.js
    // builds the bulk-status URL via `url.search = sp` and reads
    // `url.toString()` afterward; the search setter then propagates.
    get href() {
      return buildHref(this);
    }
    set href(v) {
      const u = globalThis.__csim_parseUrl(String(v), null);
      if (!u || u.error) throw new TypeError("Invalid URL: " + v);
      this._protocol = u.protocol;
      this._username = u.username;
      this._password = u.password;
      this._host = u.host;
      this._hostname = u.hostname;
      this._port = u.port;
      this._pathname = u.pathname;
      this._search = u.search;
      this._hash = u.hash;
      this._origin = u.origin;
      this.searchParams = new URLSearchParams(this._search);
    }
    get protocol() {
      return this._protocol;
    }
    set protocol(v) {
      this._protocol = String(v);
    }
    get username() {
      return this._username;
    }
    set username(v) {
      this._username = String(v);
    }
    get password() {
      return this._password;
    }
    set password(v) {
      this._password = String(v);
    }
    get host() {
      return this._host;
    }
    set host(v) {
      this._host = String(v);
    }
    get hostname() {
      return this._hostname;
    }
    set hostname(v) {
      this._hostname = String(v);
    }
    get port() {
      return this._port;
    }
    set port(v) {
      this._port = String(v);
    }
    get pathname() {
      return this._pathname;
    }
    set pathname(v) {
      this._pathname = String(v);
    }
    get search() {
      return this._search;
    }
    set search(v) {
      this._search = normSearch(v);
      this.searchParams = new URLSearchParams(this._search);
    }
    get hash() {
      return this._hash;
    }
    set hash(v) {
      this._hash = normHash(v);
    }
    get origin() {
      return this._origin;
    }
    toString() {
      return buildHref(this);
    }
    toJSON() {
      return buildHref(this);
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
    constructor(init) {
      this._entries = [];
      if (typeof init === "string") {
        let s = init;
        if (s.charAt(0) === "?") s = s.slice(1);
        if (s.length) {
          for (const pair of s.split("&")) {
            const idx = pair.indexOf("=");
            const k = idx >= 0 ? pair.slice(0, idx) : pair;
            const v = idx >= 0 ? pair.slice(idx + 1) : "";
            this._entries.push([decodeURIComponent(k.replace(/\+/g, " ")), decodeURIComponent(v.replace(/\+/g, " "))]);
          }
        }
      } else if (init && typeof init.forEach === "function") {
        init.forEach((v, k) => this._entries.push([String(k), String(v)]));
      } else if (Array.isArray(init)) {
        for (const e of init) this._entries.push([String(e[0]), String(e[1])]);
      } else if (init && typeof init === "object") {
        for (const k of Object.keys(init)) this._entries.push([k, String(init[k])]);
      }
    }
    append(k, v) {
      this._entries.push([String(k), String(v)]);
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
    set(k, v) {
      this.delete(k);
      this.append(k, v);
    }
    // Spec stable sort by name (key) — used for canonical query strings
    // (cache keys, signed-URL building).
    sort() {
      this._entries.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
    }
    get size() {
      return this._entries.length;
    }
    entries() {
      return this._entries.values();
    }
    keys() {
      return this._entries.map((e) => e[0]).values();
    }
    values() {
      return this._entries.map((e) => e[1]).values();
    }
    forEach(fn) {
      for (const e of this._entries) fn(e[1], e[0], this);
    }
    toString() {
      return this._entries.map((e) => encodeURIComponent(e[0]) + "=" + encodeURIComponent(e[1])).join("&");
    }
    [Symbol.iterator]() {
      return this.entries();
    }
  };
  function normHeaderName(k) {
    return String(k).toLowerCase();
  }
  var Headers = class _Headers {
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
  var XMLHttpRequestUpload = class extends EventTarget {
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
      const fire = () => {
        if (this._aborted) return;
        this.upload._fire("loadstart", { loaded: 0, total, lengthComputable: total > 0 });
        this._doFetch(body, total);
      };
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
      if (typeof this._url === "string" && this._url.startsWith("blob:")) {
        const r = resolveBlobBytes(this._url);
        const bytes2 = r ? r.bytes : "";
        const contentType2 = r ? r.type : "";
        this.status = r ? 200 : 404;
        this.statusText = r ? "OK" : "Not Found";
        this.responseURL = this._url;
        this.responseText = bytes2;
        this.response = responseValue(this.responseType, bytes2, bytes2, contentType2);
        this._respHeaders = r ? { "content-type": contentType2 } : {};
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

  // lib/capybara/simulated/js/src/bridge.entry.js
  (function() {
    "use strict";
    globalThis.Event = Event;
    globalThis.DOMException = DOMException;
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
    globalThis.HTMLElement = Element;
    globalThis.__csimFireCEConnect = fireCEConnect;
    function fireCEConnect(subtree) {
      walkSubtree(subtree, (el) => {
        if (el.nodeType !== NODE_ELEMENT) return;
        if (!__inHTMLGrafting && el._tag === "script" && !el._csimRan) maybeRunScript(el);
        if (el._tag === "link") maybeFireLinkLoad(el);
        ceTryConnect(el);
      });
    }
    function maybeFireLinkLoad(el) {
      const rel = (el._attrs.rel || "").toLowerCase().split(/\s+/);
      if (!rel.includes("stylesheet") && !rel.includes("modulepreload") && !rel.includes("preload")) return;
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
        try {
          el.dispatchEvent(new Event(ok ? "load" : "error"));
        } catch (_) {
        }
      });
    }
    let __initialScriptsDone = false;
    let __inHTMLGrafting = false;
    function dispatchScriptLoad(el, ok) {
      if (!el._attrs.src) return;
      try {
        el.dispatchEvent(new Event(ok ? "load" : "error"));
      } catch (_) {
      }
    }
    const CSIM_CLASSIC_IMPORT_RE = /(?<![\w$.])\bimport(?=\s*\()/g;
    function csimRewriteClassicScript(body) {
      return body.indexOf("import") < 0 ? body : body.replace(CSIM_CLASSIC_IMPORT_RE, "__csim_dynamicImport");
    }
    function maybeRunScript(el) {
      const type = (el._attrs.type || "").toLowerCase();
      if (type && type !== "text/javascript" && type !== "application/javascript" && type !== "application/x-javascript" && type !== "text/ecmascript") return;
      el._csimRan = true;
      let body;
      if (el._attrs.src) {
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
      } else {
        body = scriptText(el);
      }
      if (!body) {
        dispatchScriptLoad(el, true);
        return;
      }
      body = csimRewriteClassicScript(body);
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
    globalThis.Document = Document;
    globalThis.Element = Element;
    installOnHandlerSlots(Element);
    installVideoIDL(Element);
    installCanvasToBlob(Element);
    globalThis.__csim_onVideoSrcAssigned = onVideoSrcAssigned;
    globalThis.Node = Node;
    installNodeConstants(Node);
    globalThis.Text = Text;
    installDomClassAliases({ Element, Document, Text });
    globalThis.document = new Document();
    globalThis.window = globalThis;
    globalThis.EventTarget = EventTarget;
    globalThis.Blob = Blob;
    globalThis.File = File;
    globalThis.localStorage = localStorage;
    globalThis.sessionStorage = sessionStorage;
    globalThis.ClipboardEvent = ClipboardEvent;
    globalThis.DOMParser = class DOMParser {
      parseFromString(input, mimeType) {
        const html = String(input == null ? "" : input);
        const t = String(mimeType || "text/html").toLowerCase();
        const doc = parseDocument(html);
        walkSubtree(doc, (n) => {
          n._ownerDoc = doc;
        });
        return doc;
      }
    };
    installBlobURL();
    registerNode(globalThis.document);
    function dispatchHover(n, opts) {
      opts = opts || {};
      const doc = globalThis.document;
      if (!doc) return;
      const prev = doc._hoverElement || null;
      const changed = prev !== n;
      doc._hoverElement = n;
      if (opts.dedupe && !changed) return;
      const init = Object.assign({ bubbles: true, cancelable: true, relatedTarget: prev }, opts.init || {});
      try {
        dispatchEvent(n, new MouseEvent("mouseover", init));
      } catch (_) {
      }
      if (opts.dispatchEnter) {
        try {
          dispatchEvent(n, new MouseEvent("mouseenter", { bubbles: false, cancelable: false, relatedTarget: prev }));
        } catch (_) {
        }
      }
    }
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
    globalThis.__csimLoadDocument = function(html) {
      __initialScriptsDone = false;
      resetCascadeState();
      resetLayoutY();
      globalThis.document._hoverElement = null;
      globalThis.__csimPendingFormSubmit = null;
      __inHTMLGrafting = true;
      const freshDoc = parseDocument(String(html == null ? "" : html));
      const d = globalThis.document;
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
        }
        if (liveHead && freshHead) {
          for (const k of Object.keys(liveHead._attrs)) delete liveHead._attrs[k];
          Object.assign(liveHead._attrs, freshHead._attrs);
        }
        if (liveBody && freshBody) {
          for (const k of Object.keys(liveBody._attrs)) delete liveBody._attrs[k];
          Object.assign(liveBody._attrs, freshBody._attrs);
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
    const __externalScriptsRun = /* @__PURE__ */ new Map();
    function runInlineScripts(doc) {
      if (!doc || !doc.documentElement) return;
      ingestImportmaps(doc);
      const scripts = doc.documentElement.querySelectorAll("script");
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
          const resp = __rackFetch("GET", s._attrs.src, "", null, "follow");
          if (!resp || resp.status >= 400) continue;
          body = resp.body || "";
          __externalScriptsRun.set(s._attrs.src, body);
        } else {
          body = scriptText(s);
        }
        if (!body) continue;
        body = csimRewriteClassicScript(body);
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
    function runModuleScript(s) {
      const baseUrl = globalThis.location && globalThis.location.href || null;
      const nativeEsm = typeof globalThis.__csim_evalEsmEntry === "function";
      if (s._attrs.src) {
        const url = resolveAgainst(s._attrs.src, baseUrl);
        try {
          if (nativeEsm) __csim_evalEsmEntry(url, null);
          else __csim_require(url);
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
        globalThis.__csim_inlineSources = globalThis.__csim_inlineSources || /* @__PURE__ */ Object.create(null);
        globalThis.__csim_inlineSources[url] = body;
        try {
          if (nativeEsm) __csim_evalEsmEntry(url, body);
          else __csim_require(url);
        } catch (e) {
          try {
            console.error("[csim] inline module failed:", e && e.message);
          } catch (_) {
          }
        }
      }
    }
    function hashStr(s) {
      let h = 5381;
      for (let i = 0; i < s.length; i++) h = (h << 5) + h + s.charCodeAt(i) | 0;
      return (h >>> 0).toString(16);
    }
    globalThis.__csim_inlineSources = /* @__PURE__ */ Object.create(null);
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
    function marshalReturn(value) {
      if (value && typeof value === "object" && value.nodeType !== void 0 && typeof value._id === "number") {
        return { __elementHandle: value._id };
      }
      if (Array.isArray(value)) return value.map(marshalReturn);
      return value;
    }
    globalThis.__csimVisible = function(h) {
      const n = lookup(h);
      if (!n || n.nodeType !== NODE_ELEMENT) return false;
      if (INVISIBLE_TAGS.has(n._tag)) return false;
      if (n._tag === "input" && (n._attrs.type || "").toLowerCase() === "hidden") return false;
      let summarySeen = false;
      let cur = n;
      let prev = null;
      while (cur) {
        if (cur.nodeType === NODE_DOC) return true;
        if (cur.nodeType === NODE_ELEMENT) {
          if (INVISIBLE_TAGS.has(cur._tag)) return false;
          if (selfHidden(cur)) return false;
          if (cur !== n && cur._tag === "details" && cur._attrs.open == null && !summarySeen) {
            const display = prev && prev.nodeType === NODE_ELEMENT ? resolveCascadeDisplay(prev) : null;
            if (display == null || display === "none") return false;
          }
          if (cur._tag === "summary") summarySeen = true;
        }
        prev = cur;
        cur = cur._parent;
      }
      return true;
    };
    globalThis.__csimVisibleText = function(h) {
      const n = lookup(h);
      if (!n) return "";
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
      }
      return v;
    }
    globalThis.__pollAsyncResult = function() {
      return __asyncResult;
    };
    function __csimMakeDataTransfer(items) {
      const dt = new globalThis.DataTransfer();
      for (const it of items || []) {
        if (it.kind === "file") {
          const file = { name: it.name, type: "", size: 0 };
          dt.items.push(new globalThis.DataTransferItem("file", "application/octet-stream", null, file));
          dt.files.push(file);
          if (!dt.types.includes("Files")) dt.types.push("Files");
        } else {
          dt.items.push(new globalThis.DataTransferItem("string", it.type, it.value, null));
          if (!dt.types.includes(it.type)) dt.types.push(it.type);
        }
      }
      return dt;
    }
    globalThis.__csimClickFinish = function(h, base) {
      const n = handles.get(h);
      if (!n || n.nodeType !== NODE_ELEMENT) return null;
      dispatchEvent(n, new MouseEvent("mouseup", base));
      const click = new MouseEvent("click", base);
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
      const fireDrag = (el, type) => {
        const ev = new DragEvent(type, init);
        ev.dataTransfer = dt;
        dispatchEvent(el, ev);
      };
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
      if (el._attrs.hidden != null) return false;
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
    function __collectTabbables() {
      const out = [];
      if (globalThis.document) walk(globalThis.document, (el) => {
        if (__isTabbable(el)) out.push(el);
      });
      return out;
    }
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
      const hit = dfs(n);
      if (hit) return hit;
      let single = n;
      while (single) {
        const kids = (single._children || []).filter((k) => k && k.nodeType === NODE_ELEMENT);
        if (kids.length !== 1) return n;
        single = kids[0];
        if (single._tag === "a" && single._attrs && single._attrs.href != null) return single;
      }
      return n;
    }
    globalThis.__csimClickResolve = function(h, modifiers) {
      const n = __csimHitTestRetarget(lookup(h));
      if (!n || n.nodeType !== NODE_ELEMENT) return null;
      const mods = modifiers || {};
      let preToggled = null;
      let wasChecked = null;
      if (n._tag === "input") {
        const type = (n._attrs.type || "").toLowerCase();
        if (type === "checkbox") {
          wasChecked = n._attrs.checked != null;
          toggleChecked(n);
          preToggled = "checkbox";
        } else if (type === "radio") {
          wasChecked = n._attrs.checked != null;
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
      dispatchEvent(n, click);
      if (preToggled) {
        if (click.defaultPrevented) {
          if (wasChecked) n._attrs.checked = "";
          else delete n._attrs.checked;
        } else if (n._attrs.checked != null !== wasChecked) {
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
          if (details._attrs.open != null) delete details._attrs.open;
          else details._attrs.open = "";
          try {
            dispatchEvent(details, new Event("toggle", { bubbles: false }));
          } catch (_) {
          }
        }
      }
      if (click.defaultPrevented) return null;
      let __anchor = n;
      while (__anchor && __anchor.nodeType === NODE_ELEMENT && __anchor._tag !== "a") {
        __anchor = __anchor._parent;
      }
      if (__anchor && __anchor.nodeType === NODE_ELEMENT && __anchor._tag === "a" && __anchor._attrs.href != null) {
        const href = String(__anchor._attrs.href);
        if (/^\s*javascript:/i.test(href)) return null;
        if (__anchor._attrs.download != null) {
          return { kind: "download", url: href, filename: String(__anchor._attrs.download || "") };
        }
        let target = String(__anchor._attrs.target || "");
        if (click && (click.metaKey || click.ctrlKey)) target = "_blank";
        return { kind: "navigate", url: href, target };
      }
      if (n._tag === "label") {
        const labeled = labeledControlFor(n);
        if (labeled && labeled !== n) {
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
