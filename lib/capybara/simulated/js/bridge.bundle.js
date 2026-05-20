(() => {
  // lib/capybara/simulated/js/src/constants.js
  var NODE_ELEMENT = 1;
  var NODE_TEXT = 3;
  var NODE_COMMENT = 8;
  var NODE_DOC = 9;
  var NODE_FRAGMENT = 11;

  // lib/capybara/simulated/js/src/walk.js
  function walk(node, fn) {
    if (!node) return;
    if (node.nodeType === NODE_ELEMENT) fn(node);
    for (const c of node._children) walk(c, fn);
  }

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

  // lib/capybara/simulated/js/src/selectors.js
  var cssSelect = globalThis.__csimVendor.cssSelect;
  var compiledCache = /* @__PURE__ */ new Map();
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
  function normaliseScopedSelector(sel) {
    if (typeof sel !== "string") return sel;
    const trimmed = sel.replace(/^\s+/, "");
    if (trimmed.startsWith(">") || trimmed.startsWith("+") || trimmed.startsWith("~")) {
      return ":scope " + trimmed;
    }
    return sel;
  }
  function compile(sel) {
    const key = normaliseScopedSelector(sel);
    let fn = compiledCache.get(key);
    if (fn) return fn;
    try {
      fn = cssSelect.compile(key, { adapter });
    } catch (e) {
      throw new Error("csim: " + (e && e.message ? e.message : e));
    }
    compiledCache.set(key, fn);
    return fn;
  }
  function selectAll(roots, sel) {
    return adapter.findAll(compile(sel), roots);
  }
  function selectFirst(roots, sel) {
    return adapter.findOne(compile(sel), roots);
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

  // lib/capybara/simulated/js/src/storage.js
  function makeStorage(kind) {
    return {
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
        globalThis.__csim_storageSet(kind, String(k), String(v == null ? "" : v));
      },
      removeItem(k) {
        globalThis.__csim_storageRemove(kind, String(k));
      },
      clear() {
        globalThis.__csim_storageClear(kind);
      }
    };
  }
  var localStorage = makeStorage("local");
  var sessionStorage = makeStorage("session");

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
      this._propagationStopped = false;
      this._immediatePropagationStopped = false;
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
  };
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
  var MouseEvent = class extends Event {
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
      this.movementX = init.movementX || 0;
      this.movementY = init.movementY || 0;
      this.altKey = !!init.altKey;
      this.ctrlKey = !!init.ctrlKey;
      this.metaKey = !!init.metaKey;
      this.shiftKey = !!init.shiftKey;
      this.relatedTarget = init.relatedTarget || null;
    }
  };
  var KeyboardEvent = class extends Event {
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
  };
  var InputEvent = class extends Event {
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
          try {
            console.error("[csim] EventTarget listener threw:", e && e.message);
          } catch (_) {
          }
        }
      }
      return !event.defaultPrevented;
    }
  };

  // lib/capybara/simulated/js/src/abort.js
  var AbortSignal = class _AbortSignal {
    constructor() {
      this.aborted = false;
    }
    static abort(reason) {
      const s = new _AbortSignal();
      s.aborted = true;
      s.reason = reason;
      return s;
    }
    static timeout() {
      return new _AbortSignal();
    }
  };
  var AbortController = class {
    constructor() {
      this.signal = { aborted: false, addEventListener() {
      }, removeEventListener() {
      }, dispatchEvent() {
      } };
    }
    abort() {
      this.signal.aborted = true;
    }
  };

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
        bytes = globalThis.__csimBlobBytes(source);
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
      if (!decoded || !decoded.pixels) return reject(new Error("createImageBitmap: decode failed"));
      const bm = new ImageBitmap();
      bm._pixels = new globalThis.Uint8ClampedArray(latin1ToBytes(globalThis.atob(String(decoded.pixels))));
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
    convertToBlob(_options) {
      const parts = this._pixels ? [String.fromCharCode.apply(null, this._pixels)] : [""];
      return Promise.resolve(new globalThis.Blob(parts, { type: "application/octet-stream" }));
    }
  };

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
  var TextEncoder = class {
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
  var URL = class {
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
  var XMLHttpRequest = class {
    static UNSENT = 0;
    static OPENED = 1;
    static HEADERS_RECEIVED = 2;
    static LOADING = 3;
    static DONE = 4;
    constructor() {
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
      this.upload = { addEventListener() {
      }, removeEventListener() {
      }, dispatchEvent() {
      } };
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
      this._listeners = /* @__PURE__ */ Object.create(null);
      this._aborted = false;
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
    addEventListener(type, handler) {
      if (typeof handler !== "function") return;
      (this._listeners[type] = this._listeners[type] || []).push(handler);
    }
    removeEventListener(type, handler) {
      const list = this._listeners[type];
      if (!list) return;
      this._listeners[type] = list.filter((h) => h !== handler);
    }
    abort() {
      this._aborted = true;
      this.readyState = 4;
      this.status = 0;
      this._fireReady();
      this._fireEvent("abort");
      this._fireEvent("loadend");
    }
    send(body) {
      const doFetch = () => this._doFetch(body);
      if (this._async) globalThis.setTimeout(doFetch, 0);
      else doFetch();
    }
    _doFetch(body) {
      if (this._aborted) return;
      if (typeof this._url === "string" && this._url.startsWith("blob:")) {
        const r = globalThis.__csimResolveBlobBytes(this._url);
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
      this.readyState = 4;
      this._fireReady();
      this._fireEvent("load");
      this._fireEvent("loadend");
    }
    // FormData / URLSearchParams / Headers all reach here when
    // Rails-UJS submits a `data-remote="true"` form. The default
    // `String(fd)` returns `"[object Object]"` which Rails treats as
    // garbage. Serialise to urlencoded — the most common no-file path
    // — and let the multipart layer handle attachments.
    _serializeBody(body) {
      if (body == null) return "";
      if (typeof body === "string") return body;
      if (body instanceof globalThis.FormData) return this._serializeFormData(body);
      if (body instanceof globalThis.URLSearchParams) return this._serializeURLSearchParams(body);
      if (body instanceof globalThis.Blob) return this._serializeBlob(body);
      return String(body);
    }
    _serializeFormData(fd) {
      let hasFile = false;
      fd.forEach((v) => {
        if (v instanceof globalThis.Blob) hasFile = true;
      });
      if (hasFile) {
        const ser = globalThis.__csimSerializeMultipart(fd);
        this._headers["X-Csim-Body-B64"] = "1";
        if (!this._headers["Content-Type"] && !this._headers["content-type"]) {
          this._headers["Content-Type"] = "multipart/form-data; boundary=" + ser.boundary;
        }
        return globalThis.btoa(ser.body);
      }
      const parts = [];
      fd.forEach((v, k) => parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(String(v))));
      if (!this._headers["Content-Type"] && !this._headers["content-type"]) {
        this._headers["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8";
      }
      return parts.join("&");
    }
    _serializeURLSearchParams(params) {
      if (!this._headers["Content-Type"] && !this._headers["content-type"]) {
        this._headers["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8";
      }
      return params.toString();
    }
    // ActiveStorage's `BlobUpload` PUTs the raw file to disk storage
    // via `xhr.send(file)`. The bytes need to cross the mini_racer
    // boundary without UTF-8 reinterpretation, so we base64 them and
    // signal to Rack via a custom header. The Ruby side decodes before
    // building the env input.
    _serializeBlob(blob) {
      this._headers["X-Csim-Body-B64"] = "1";
      if (!this._headers["Content-Type"] && !this._headers["content-type"] && blob.type) {
        this._headers["Content-Type"] = blob.type;
      }
      const raw = globalThis.__csimBlobBytes(blob);
      return raw ? globalThis.btoa(raw) : "";
    }
    // `readystatechange` goes through `_fireEvent`, which itself reads
    // `this.onreadystatechange` — calling the handler here directly
    // double-fires it. Rails-UJS keys on the DONE state to invoke its
    // `done(xhr)` callback, so the second fire triggered
    // `processResponse` a second time and re-eval'd the script
    // response (toggling visibility back to hidden). The single
    // `_fireEvent` dispatch is enough.
    _fireReady() {
      this._fireEvent("readystatechange");
    }
    _fireEvent(type) {
      const evt = { type, target: this, currentTarget: this };
      const handler = this["on" + type];
      if (typeof handler === "function") {
        try {
          handler.call(this, evt);
        } catch (_) {
        }
      }
      const list = this._listeners[type];
      if (list) for (const h of list.slice()) {
        try {
          h.call(this, evt);
        } catch (_) {
        }
      }
    }
  };

  // lib/capybara/simulated/js/src/navigator.js
  var clipboardText = "";
  var navigator = {
    // Lead with `Mozilla/5.0` so server-side bot detectors (`browser`
    // gem, ahoy_matey's `Browser.new(ua).bot?`) recognise us as a
    // regular client rather than a crawler. Without it Ahoy's exclude
    // path drops every visit/event we POST. Keep in sync with
    // `Browser::USER_AGENT` in `lib/capybara/simulated/browser.rb`,
    // which sets the same string as `HTTP_USER_AGENT` on the Rack env.
    userAgent: "Mozilla/5.0 (X11; Linux x86_64; Rails Testing) capybara-simulated (V8-resident DOM)",
    appName: "Netscape",
    appVersion: "5.0",
    platform: "Linux",
    language: "en-US",
    languages: ["en-US", "en"],
    onLine: true,
    cookieEnabled: true,
    // Stimulus `navigator.clipboard.writeText(...)` from
    // `copyToClipboard` / `clipboard#copyPre` resolves cleanly. The
    // buffer is in-process and survives across visits in the same
    // Browser — real browsers share a system clipboard; we just need
    // round-trip parity for the copy-then-paste flow tested by
    // `copy_*_to_clipboard`.
    clipboard: {
      writeText(text) {
        clipboardText = String(text == null ? "" : text);
        return Promise.resolve();
      },
      readText() {
        return Promise.resolve(clipboardText);
      },
      // Generic write/read with ClipboardItem entries (rare in app
      // code; provide a stub so feature-detection doesn't trip).
      write() {
        return Promise.resolve();
      },
      read() {
        return Promise.resolve([]);
      }
    },
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
        let body = "";
        const headers = {};
        if (data instanceof globalThis.FormData) {
          const parts = [];
          data.forEach((v, k) => parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(String(v))));
          body = parts.join("&");
          headers["Content-Type"] = "application/x-www-form-urlencoded;charset=UTF-8";
        } else if (data instanceof globalThis.URLSearchParams) {
          body = data.toString();
          headers["Content-Type"] = "application/x-www-form-urlencoded;charset=UTF-8";
        } else if (typeof data === "string") {
          body = data;
          headers["Content-Type"] = "text/plain;charset=UTF-8";
        } else if (data instanceof globalThis.Blob) {
          body = (data._parts || []).join("");
          headers["Content-Type"] = data.type || "application/octet-stream";
        } else if (data == null) {
          body = "";
        } else {
          body = String(data);
          headers["Content-Type"] = "application/octet-stream";
        }
        const resp = globalThis.__rackFetch("POST", String(url), body, headers, "follow");
        return !!resp;
      } catch (_) {
        return false;
      }
    }
  };
  globalThis.__csimClipboardGet = function() {
    return clipboardText;
  };
  globalThis.__csimClipboardSet = function(text) {
    clipboardText = String(text == null ? "" : text);
  };

  // lib/capybara/simulated/js/src/history.js
  function applyHistoryUrl(self, state, url, push) {
    self.state = state;
    if (!url) return;
    const s = String(url);
    if (globalThis.location && globalThis.location.href === s) return;
    if (push && typeof globalThis.__pushHistoryEntry === "function") {
      globalThis.__pushHistoryEntry(s);
    } else {
      globalThis.__setCurrentUrl(s);
    }
    globalThis.__csimUpdateLocation(s);
  }
  var history = {
    length: 1,
    state: null,
    pushState(state, _title, url) {
      applyHistoryUrl(this, state, url, true);
    },
    replaceState(state, _title, url) {
      applyHistoryUrl(this, state, url, false);
    },
    back() {
      globalThis.__locationReload();
    },
    forward() {
      globalThis.__locationReload();
    },
    go() {
      globalThis.__locationReload();
    }
  };

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

  // lib/capybara/simulated/js/src/idb.js
  var IDBRequest = class extends EventTarget {
    constructor() {
      super();
      this.result = null;
      this.error = null;
      this.readyState = "pending";
      this.onsuccess = null;
      this.onerror = null;
      this.onupgradeneeded = null;
    }
  };
  var store = /* @__PURE__ */ new Map();
  function deliverAsync(target, type) {
    Promise.resolve().then(() => dispatchWithOnHandler(target, { type, target }));
    return target;
  }
  var IDBDatabase = class extends EventTarget {
    constructor() {
      super();
      this._stores = /* @__PURE__ */ new Set();
    }
    createObjectStore(name) {
      this._stores.add(name);
      return new IDBObjectStore(name);
    }
    transaction(_storeNames, _mode) {
      return new IDBTransaction();
    }
    close() {
    }
  };
  var IDBTransaction = class extends EventTarget {
    objectStore(name) {
      return new IDBObjectStore(name);
    }
  };
  var IDBObjectStore = class extends EventTarget {
    constructor(name) {
      super();
      this._name = name;
    }
    get(key) {
      const req = new IDBRequest();
      req.result = store.get(this._name + " " + String(key));
      return deliverAsync(req, "success");
    }
    put(value, key) {
      const req = new IDBRequest();
      store.set(this._name + " " + String(key), value);
      req.result = key;
      return deliverAsync(req, "success");
    }
    delete(key) {
      const req = new IDBRequest();
      store.delete(this._name + " " + String(key));
      return deliverAsync(req, "success");
    }
    clear() {
      const req = new IDBRequest();
      for (const k of Array.from(store.keys())) {
        if (k.startsWith(this._name + " ")) store.delete(k);
      }
      return deliverAsync(req, "success");
    }
  };
  var IDBIndex = class extends EventTarget {
  };
  var IDBCursor = class {
    advance() {
    }
    continue() {
    }
    continuePrimaryKey() {
    }
  };
  var indexedDB = {
    open(_name, _version) {
      const req = new IDBRequest();
      req.result = new IDBDatabase();
      Promise.resolve().then(() => {
        dispatchWithOnHandler(req, { type: "upgradeneeded", target: req });
        dispatchWithOnHandler(req, { type: "success", target: req });
      });
      return req;
    },
    deleteDatabase() {
      return deliverAsync(new IDBRequest(), "success");
    }
  };

  // lib/capybara/simulated/js/src/workers.js
  function encode(data) {
    return JSON.stringify(data, function(_key, value) {
      const isU8 = value instanceof Uint8Array;
      const isAB = !isU8 && value instanceof ArrayBuffer;
      if (!isU8 && !isAB) return value;
      const view = isU8 ? value : new Uint8Array(value);
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
      const u = latin1ToBytes(globalThis.atob(value.b64));
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

  // lib/capybara/simulated/js/src/bridge.entry.js
  (function() {
    "use strict";
    let __nextId = 1;
    let __currentTag = null;
    class Node {
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
      getBoundingClientRect() {
        if (__isVisibleNode(this)) {
          return { top: 0, left: 0, right: 1, bottom: 1, width: 1, height: 1, x: 0, y: 0 };
        }
        return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 };
      }
      getClientRects() {
        return __isVisibleNode(this) ? [{ top: 0, left: 0, right: 1, bottom: 1, width: 1, height: 1, x: 0, y: 0 }] : [];
      }
      get offsetWidth() {
        return __isVisibleNode(this) ? 1 : 0;
      }
      get offsetHeight() {
        return __isVisibleNode(this) ? 1 : 0;
      }
      get clientWidth() {
        return __isVisibleNode(this) ? 1 : 0;
      }
      get clientHeight() {
        return __isVisibleNode(this) ? 1 : 0;
      }
      get scrollWidth() {
        return __isVisibleNode(this) ? 1 : 0;
      }
      // Approximate scrollHeight as 20px/line over 80 chars/line so
      // content-length gates fire. Avo's Trix body checks
      // `scrollHeight > some-threshold` to decide whether to inject the
      // "More content" expander; a flat `1` keeps it from ever rendering.
      // Counts element children only (whitespace text nodes between
      // formatted HTML would otherwise inflate the count and trip the
      // gate on short content).
      get scrollHeight() {
        if (!__isVisibleNode(this)) return 0;
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
      scrollIntoView() {
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
            if (isConnected(this)) fireCEConnect(c);
            __askForReset(c);
          }
          child._children.length = 0;
          return child;
        }
        if (child._parent) child._parent.removeChild(child);
        child._parent = this;
        this._children.push(child);
        registerSubtree(child);
        recordChildList(this, [child], []);
        if (isConnected(this)) fireCEConnect(child);
        __askForReset(child);
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
            if (isConnected(this)) fireCEConnect(c);
            __askForReset(c);
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
        if (isConnected(this)) fireCEConnect(child);
        __askForReset(child);
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
          fireCEConnect(neu);
        }
        __askForReset(neu);
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
    }
    class Text extends Node {
      constructor(data) {
        super();
        this.nodeType = NODE_TEXT;
        this._data = String(data == null ? "" : data);
      }
      get nodeName() {
        return "#text";
      }
      _cloneShell() {
        return new Text(this._data);
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
        return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 };
      }
    }
    class Comment extends Text {
      constructor(data) {
        super(data);
        this.nodeType = NODE_COMMENT;
      }
      get nodeName() {
        return "#comment";
      }
      _cloneShell() {
        return new Comment(this.data);
      }
    }
    globalThis.Comment = Comment;
    const HREF_REFLECTING_TAGS = /* @__PURE__ */ new Set(["a", "area", "link"]);
    const SRC_REFLECTING_TAGS = /* @__PURE__ */ new Set([
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
        const u = __csim_parseUrl(v, base);
        return u && !u.error ? u.href : v;
      } catch (_) {
        return v;
      }
    }
    class Element extends Node {
      constructor(tagName) {
        if (__pendingUpgrade) {
          const target = __pendingUpgrade;
          __pendingUpgrade = null;
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
        const e = new Element(this._tag);
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
      // submit path in `__csimClickResolve` is the close trigger; show
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
        if (old !== next) fireAttrChangedCallback(this, n, old == null ? null : old, next);
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
        fireAttrChangedCallback(this, n, old == null ? null : old, null);
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
        return __htmlCollection(all.filter((n) => n !== this));
      }
      getElementsByClassName(cls) {
        const sel = String(cls).split(/\s+/).filter(Boolean).map((c) => "." + c).join("");
        return __htmlCollection(this.querySelectorAll(sel).filter((n) => n !== this));
      }
      getElementsByName(name) {
        const sel = '[name="' + String(name).replace(/"/g, '\\"') + '"]';
        return __htmlCollection(this.querySelectorAll(sel).filter((n) => n !== this));
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
        return {
          contains(c) {
            return classes(el).includes(c);
          },
          add(...names) {
            const cs = classes(el);
            for (const n of names) if (!cs.includes(n)) cs.push(n);
            el._attrs["class"] = cs.join(" ");
          },
          remove(...names) {
            const drop = new Set(names);
            el._attrs["class"] = classes(el).filter((x) => !drop.has(x)).join(" ");
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
            el._attrs["class"] = cs.join(" ");
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
            el._attrs["class"] = cs.join(" ");
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
            el._attrs["class"] = String(v == null ? "" : v);
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
        return selectFirst(this._children, sel);
      }
      querySelectorAll(sel) {
        return selectAll(this._children, sel);
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
        return form ? __formNamedAccess(form) : null;
      }
      // Form-control IDL attributes — expose the pair-of-attr-and-IDL
      // shape so JS like `input.value = 'x'` / `input.checked = true`
      // works and reads back via `__csimValue` / serialised attrs alike.
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
          return __stripOneLeadingNewline(this.textContent);
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
        this._attrs.src = String(v == null ? "" : v);
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
          const u = __csim_parseUrl(a, base);
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
        return false;
      }
      checkValidity() {
        return true;
      }
      reportValidity() {
        return true;
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
        this._selectionStart = 0;
        this._selectionEnd = (this._attrs.value || "").length;
      }
      // File-input `.files` accessor. Set by `__csimSetFiles` after
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
    }
    class DocumentFragment extends Node {
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
        return selectFirst(this._children, sel);
      }
      querySelectorAll(sel) {
        return selectAll(this._children, sel);
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
        return __htmlCollection(all.filter((n) => n !== this));
      }
      getElementsByClassName(cls) {
        const sel = String(cls).split(/\s+/).filter(Boolean).map((c) => "." + c).join("");
        return __htmlCollection(this.querySelectorAll(sel).filter((n) => n !== this));
      }
    }
    globalThis.DocumentFragment = DocumentFragment;
    class ShadowRoot extends DocumentFragment {
      constructor(host, mode) {
        super();
        this.host = host;
        this.mode = mode || "open";
        this._parent = host;
      }
      get nodeName() {
        return "#shadow-root";
      }
    }
    globalThis.ShadowRoot = ShadowRoot;
    const GLOBAL_EVENT_HANDLER_ATTRS = [
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
    class Document extends Node {
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
      // Currently-executing `<script>` element (set by `runInlineScripts`
      // around `__csim_runScript`). Bundlers read `currentScript.src` to
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
      // host fns (`__getDocumentCookie` / `__setDocumentCookie`) own
      // the storage; Browser-side cookies survive ctx rebuilds.
      get cookie() {
        return __getDocumentCookie() || "";
      }
      set cookie(v) {
        __setDocumentCookie(String(v == null ? "" : v));
      }
      // Public accessor over the internal `_activeElement` slot that the
      // Element focus/blur methods write to. Returns the document's
      // body as a sentinel when no element is focused, matching real
      // browsers (HTMLBodyElement is the fallback `activeElement` per
      // the HTML spec, and libraries occasionally test for non-null
      // before reading properties).
      get activeElement() {
        return this._activeElement || this.body || null;
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
        const ctor = __customElementRegistry.get(t);
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
        return this.documentElement ? selectFirst([this.documentElement], sel) : null;
      }
      querySelectorAll(sel) {
        return this.documentElement ? selectAll([this.documentElement], sel) : [];
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
        __ceUpgradeTree(out);
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
            const d = new Document();
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
        (function walk2(n) {
          all.push(n);
          if (n && n._children) for (const c of n._children) walk2(c);
        })(root);
        let i = -1;
        return {
          root,
          whatToShow,
          filter,
          referenceNode: root,
          pointerBeforeReferenceNode: true,
          nextNode() {
            while (++i < all.length) {
              const n = all[i];
              const mask = 1 << n.nodeType - 1;
              if (!(mask & whatToShow)) continue;
              if (filter) {
                const fn = typeof filter === "function" ? filter : filter && filter.acceptNode;
                if (fn) {
                  const r = fn.call(filter || null, n);
                  if (r === 2 || r === 3 || r === false) continue;
                }
              }
              this.referenceNode = n;
              this.pointerBeforeReferenceNode = false;
              return n;
            }
            return null;
          },
          previousNode() {
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
        (function walk2(n) {
          all.push(n);
          if (n && n._children) for (const c of n._children) walk2(c);
        })(root);
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
    }
    class DocumentOrderRange {
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
        return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 };
      }
      cloneRange() {
        const r = new DocumentOrderRange();
        r.startContainer = this.startContainer;
        r.startOffset = this.startOffset;
        r.endContainer = this.endContainer;
        r.endOffset = this.endOffset;
        return r;
      }
      toString() {
        return "";
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
    }
    DocumentOrderRange.START_TO_START = 0;
    DocumentOrderRange.START_TO_END = 1;
    DocumentOrderRange.END_TO_END = 2;
    function nodeContains(ancestor, descendant) {
      return ancestor != null && ancestor.contains ? ancestor.contains(descendant) : false;
    }
    const FORM_ASSOCIATED_TAGS = /* @__PURE__ */ new Set([
      "input",
      "select",
      "textarea",
      "button",
      "fieldset",
      "object",
      "output"
    ]);
    function __stripOneLeadingNewline(s) {
      if (typeof s !== "string" || s.length === 0) return s;
      if (s.length >= 2 && s.charCodeAt(0) === 13 && s.charCodeAt(1) === 10) return s.slice(2);
      if (s.charCodeAt(0) === 13 || s.charCodeAt(0) === 10) return s.slice(1);
      return s;
    }
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
      try {
        (globalThis.__csim_inserts = globalThis.__csim_inserts || []).push({ text, sc_tag: sc && (sc._tag || sc.nodeName), sc_data: sc && sc.nodeType === 3 ? (sc._data || "").slice(0, 20) : null, connected: sc && isConnected(sc) });
      } catch (_) {
      }
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
        __notifySelectionChange();
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
      __notifySelectionChange();
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
    function classes(el) {
      const cls = el._attrs["class"];
      if (!cls) return [];
      if (el._classesCacheKey === cls) return el._classesCache;
      const arr = cls.split(/\s+/).filter(Boolean);
      el._classesCacheKey = cls;
      el._classesCache = arr;
      return arr;
    }
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
    function escapeRe(s) {
      return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
    globalThis.Event = Event;
    globalThis.DOMException = DOMException;
    globalThis.CustomEvent = CustomEvent;
    globalThis.MouseEvent = MouseEvent;
    globalThis.KeyboardEvent = KeyboardEvent;
    globalThis.InputEvent = InputEvent;
    globalThis.SubmitEvent = SubmitEvent;
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
        if (__observers.size && __hasQueuedRecords()) scheduleMutationDelivery();
        if (typeof __recheckIntersectionObservers === "function") __recheckIntersectionObservers();
        globalThis.event = prevWinEvent;
      }
    }
    function fireWindowListeners(event, capture) {
      const list = __windowListeners[event.type];
      if (!list || !list.length) return;
      event.currentTarget = globalThis;
      for (const { handler, capture: cap } of list.slice()) {
        if (!!cap !== !!capture) continue;
        if (event._propagationStopped) return;
        try {
          handler.call(globalThis, event);
        } catch (e) {
          try {
            console.error("[csim] window listener threw:", e && e.message);
          } catch (_) {
          }
        }
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
            try {
              console.error("[csim] on-attribute handler threw:", e && e.message);
            } catch (_) {
            }
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
          try {
            console.error("[csim] listener threw on event=" + event.type + " tag=" + (node && node._tag) + ": " + (e && e.message));
          } catch (_) {
          }
        }
      }
    }
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
    globalThis.alert = alert;
    globalThis.confirm = confirm;
    globalThis.prompt = prompt;
    const __observers = /* @__PURE__ */ new Set();
    globalThis.__csimGetObservers = function() {
      return Array.from(__observers).map((o) => ({
        observed: o._observed.map((e) => ({ tag: e.target && e.target._tag, opts: e.options })),
        records: o._records.length
      }));
    };
    let __settleGen = 0;
    globalThis.__settleGenGet = () => __settleGen;
    function __bumpSettleGen() {
      __settleGen = __settleGen + 1 | 0;
    }
    function __queueRecordForObservers(rec) {
      if (__observers.size === 0) return;
      let queued = false;
      for (const obs of __observers) {
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
      __bumpSettleGen();
      if (__observers.size === 0) return;
      __queueRecordForObservers({
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
      __bumpSettleGen();
      if (__observers.size === 0) return;
      __queueRecordForObservers({
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
      __bumpSettleGen();
      if (__observers.size === 0) return;
      __queueRecordForObservers({
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
    function recordMatches(entry, rec) {
      const opts = entry.options;
      if (rec.type === "childList" && !opts.childList) return false;
      if (rec.type === "attributes" && !opts.attributes && !opts.attributeFilter) return false;
      if (rec.type === "characterData" && !opts.characterData) return false;
      if (rec.type === "attributes" && opts.attributeFilter && opts.attributeFilter.indexOf(rec.attributeName) === -1) return false;
      if (rec.target === entry.target) return true;
      if (!opts.subtree) return false;
      let cur = rec.target;
      while (cur) {
        if (cur === entry.target) return true;
        cur = cur._parent;
      }
      return false;
    }
    class MutationObserver {
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
        __observers.add(this);
      }
      disconnect() {
        this._observed = [];
        this._records = [];
        __observers.delete(this);
      }
      takeRecords() {
        const out = this._records;
        this._records = [];
        return out;
      }
    }
    globalThis.MutationObserver = MutationObserver;
    let __deliveringMutations = false;
    function deliverMutations() {
      if (__deliveringMutations) return;
      __deliveringMutations = true;
      try {
        for (const obs of __observers) {
          if (!obs._records.length) continue;
          const mine = obs._records;
          obs._records = [];
          try {
            obs._cb(mine, obs);
          } catch (e) {
            try {
              console.error("[csim] MO callback threw:", e && e.message);
            } catch (_) {
            }
          }
        }
        if (typeof __recheckIntersectionObservers === "function") __recheckIntersectionObservers();
      } finally {
        __deliveringMutations = false;
      }
    }
    let __mutationDeliveryPending = false;
    function __hasQueuedRecords() {
      for (const obs of __observers) {
        if (obs._records.length) return true;
      }
      return false;
    }
    function scheduleMutationDelivery() {
      if (__mutationDeliveryPending) return;
      __mutationDeliveryPending = true;
      Promise.resolve().then(() => {
        __mutationDeliveryPending = false;
        if (__observers.size && __hasQueuedRecords()) deliverMutations();
      });
    }
    globalThis.__deliverMutations = deliverMutations;
    globalThis.HTMLElement = Element;
    const __customElementRegistry = /* @__PURE__ */ new Map();
    let __pendingUpgrade = null;
    globalThis.customElements = {
      define(tag, ctor) {
        const t = String(tag).toLowerCase();
        if (__customElementRegistry.has(t)) return;
        __customElementRegistry.set(t, ctor);
        const doc = globalThis.document;
        if (!doc || !doc.documentElement) return;
        const matches = doc.documentElement.querySelectorAll(t);
        for (const el of matches) {
          upgradeElement(el, ctor);
          if (isConnected(el)) fireCEHook(el, "connectedCallback");
        }
      },
      get(tag) {
        return __customElementRegistry.get(String(tag).toLowerCase()) || void 0;
      },
      whenDefined(tag) {
        const ctor = this.get(tag);
        return ctor ? Promise.resolve(ctor) : Promise.resolve();
      },
      upgrade(_node) {
      }
    };
    function upgradeElement(el, ctor) {
      if (Object.getPrototypeOf(el) === ctor.prototype) return;
      __pendingUpgrade = el;
      try {
        Reflect.construct(ctor, [], ctor);
      } catch (e) {
        try {
          console.error("[csim] custom element constructor threw:", e && e.message);
        } catch (_) {
        }
        try {
          Object.setPrototypeOf(el, ctor.prototype);
        } catch (_) {
        }
      } finally {
        __pendingUpgrade = null;
      }
      const observed = ctor.observedAttributes;
      const fn = el.attributeChangedCallback;
      if (observed && observed.length && typeof fn === "function") {
        for (const name of observed) {
          if (Object.prototype.hasOwnProperty.call(el._attrs, name)) {
            try {
              fn.call(el, name, null, el._attrs[name], null);
            } catch (e) {
              try {
                console.error("[csim] attributeChangedCallback (upgrade) threw:", e && e.message);
              } catch (_) {
              }
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
        try {
          console.error("[csim] custom element " + hookName + " threw:", e && e.message);
        } catch (_) {
        }
      }
    }
    function fireAttrChangedCallback(el, name, oldValue, newValue) {
      if (!el || el.nodeType !== NODE_ELEMENT) return;
      const ctor = el.constructor;
      if (!ctor || ctor === Element) return;
      const observed = ctor.observedAttributes;
      if (!observed || observed.indexOf(name) < 0) return;
      const fn = el.attributeChangedCallback;
      if (typeof fn !== "function") return;
      try {
        fn.call(el, name, oldValue, newValue, null);
      } catch (e) {
        try {
          console.error("[csim] attributeChangedCallback threw:", e && e.message);
        } catch (_) {
        }
      }
    }
    function isConnected(node) {
      let cur = node;
      while (cur) {
        if (cur.nodeType === NODE_DOC) return true;
        cur = cur._parent;
      }
      return false;
    }
    function walkSubtree(node, fn) {
      if (!node) return;
      fn(node);
      if (node._children) for (const c of node._children) walkSubtree(c, fn);
    }
    function __askForReset(child) {
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
    function __ceUpgradeTree(subtree) {
      walkSubtree(subtree, (el) => {
        if (el.nodeType !== NODE_ELEMENT) return;
        const ctor = __customElementRegistry.get(el._tag);
        if (!ctor) return;
        if (Object.getPrototypeOf(el) !== ctor.prototype) upgradeElement(el, ctor);
      });
    }
    function fireCEConnect(subtree) {
      walkSubtree(subtree, (el) => {
        if (el.nodeType !== NODE_ELEMENT) return;
        if (!__inHTMLGrafting && el._tag === "script" && !el._csimRan) maybeRunScript(el);
        if (el._tag === "link") maybeFireLinkLoad(el);
        const ctor = __customElementRegistry.get(el._tag);
        if (!ctor) return;
        if (Object.getPrototypeOf(el) !== ctor.prototype) upgradeElement(el, ctor);
        fireCEHook(el, "connectedCallback");
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
    function maybeRunScript(el) {
      const type = (el._attrs.type || "").toLowerCase();
      if (type && type !== "text/javascript" && type !== "application/javascript" && type !== "application/x-javascript" && type !== "text/ecmascript") return;
      el._csimRan = true;
      let body;
      if (el._attrs.src) {
        try {
          const resp = __rackFetch("GET", el._attrs.src, "", null, "follow");
          if (!resp || resp.status >= 400) return;
          body = resp.body || "";
        } catch (_) {
          return;
        }
      } else {
        body = scriptText(el);
      }
      if (!body) return;
      const label = el._attrs.src || "inline://" + hashStr(body);
      let _ok = true;
      try {
        __csim_runScript(label, body);
      } catch (e) {
        _ok = false;
        try {
          console.error("[csim] dynamic script threw:", e && e.message);
        } catch (_) {
        }
      }
      dispatchScriptLoad(el, _ok);
    }
    function fireCEDisconnect(subtree) {
      walkSubtree(subtree, (el) => {
        if (el.nodeType !== NODE_ELEMENT) return;
        if (__customElementRegistry.has(el._tag)) fireCEHook(el, "disconnectedCallback");
      });
    }
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
    const PSEUDO_NO_ARG = /* @__PURE__ */ new Set([
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
      "indeterminate"
    ]);
    const PSEUDO_NTH = /* @__PURE__ */ new Set([
      "nth-child",
      "nth-last-child",
      "nth-of-type",
      "nth-last-of-type"
    ]);
    function parsePseudoToken(name, args) {
      const n = name.toLowerCase();
      if (n === "not" || n === "is" || n === "where") {
        if (args == null) throw new SyntaxError("csim: " + n + " needs args");
        return { name: n, list: parseSelector(args) };
      }
      if (PSEUDO_NTH.has(n)) {
        if (args == null) throw new SyntaxError("csim: " + n + " needs args");
        return { name: n, nth: parseNth(args) };
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
    function matchPseudo(el, p) {
      switch (p.name) {
        case "__never_match__":
          return false;
        case "not":
          return !p.list.some((seq) => matchComplex(el, seq));
        case "is":
        case "where":
          return p.list.some((seq) => matchComplex(el, seq));
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
          const sibs = elementSiblings(el);
          const idx = sibs.indexOf(el);
          return idx >= 0 && nthMatches(idx + 1, p.nth);
        }
        case "nth-last-child": {
          const sibs = elementSiblings(el);
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
          return globalThis.document && globalThis.document._activeElement === el;
        case "focus-within": {
          const active = globalThis.document && globalThis.document._activeElement;
          if (!active) return false;
          let cur = active;
          while (cur) {
            if (cur === el) return true;
            cur = cur._parent;
          }
          return false;
        }
        case "active":
          return false;
        case "visited":
          return false;
        case "link":
          return el._tag === "a" && el._attrs.href != null;
        case "target":
          return false;
        case "placeholder-shown":
          return false;
        case "default":
          return false;
        case "indeterminate":
          return false;
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
          if (p.name === "not" || p.name === "is") {
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
    let __scopeRoot = null;
    function findAll(root, group) {
      const out = [];
      const prev = __scopeRoot;
      __scopeRoot = root;
      try {
        walk(root, (el) => {
          if (matchOne(el, group)) out.push(el);
        });
      } finally {
        __scopeRoot = prev;
      }
      return out;
    }
    function findFirst(root, group) {
      let hit = null;
      const prev = __scopeRoot;
      __scopeRoot = root;
      try {
        walk(root, (el) => {
          if (!hit && matchOne(el, group)) hit = el;
        });
      } finally {
        __scopeRoot = prev;
      }
      return hit;
    }
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
    const VOID = /* @__PURE__ */ new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
    const RAWTEXT = /* @__PURE__ */ new Set(["script", "style"]);
    function parseDocument(html) {
      const doc = new Document();
      const root = new Element("html");
      doc.documentElement = root;
      root._parent = doc;
      doc._children.push(root);
      const body = new Element("body");
      const head = new Element("head");
      head._parent = root;
      root._children.push(head);
      body._parent = root;
      root._children.push(body);
      const stripped = stripHtmlWrapper(html);
      if (stripped.htmlAttrs) applyAttributes(root, stripped.htmlAttrs);
      if (stripped.headAttrs) applyAttributes(head, stripped.headAttrs);
      if (stripped.bodyAttrs) applyAttributes(body, stripped.bodyAttrs);
      const nodes = parseFragment(stripped.body);
      for (const n of nodes) {
        n._parent = body;
        body._children.push(n);
      }
      if (stripped.head) {
        const headNodes = parseFragment(stripped.head);
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
        const tbody = new Element("tbody");
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
    function parseFragment(html) {
      const out = [];
      const stack = [];
      let target = out;
      const pushChild = (child) => {
        const frame = stack.length ? stack[stack.length - 1] : null;
        child._parent = frame ? frame.parentForChildren : null;
        target.push(child);
      };
      let i = 0;
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
        const el = new Element(tag);
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
          const frag = new DocumentFragment();
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
      return new Text(decodeEntities(s));
    }
    function __formNamedAccess(form) {
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
    function __htmlCollection(arr) {
      const hc = HTMLCollection.from(arr);
      hc.item = function(i) {
        return this[i] || null;
      };
      hc.namedItem = function(n) {
        for (const el of this) if (el && (el._attrs && (el._attrs.id === n || el._attrs.name === n))) return el;
        return null;
      };
      return hc;
    }
    function toNode(v) {
      if (v && (v.nodeType === NODE_ELEMENT || v.nodeType === NODE_TEXT || v.nodeType === NODE_FRAGMENT || v.nodeType === NODE_DOC)) return v;
      return new Text(v == null ? "" : String(v));
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
    function applyAttributes(el, rest) {
      const re = /([a-zA-Z_:][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
      let m;
      while ((m = re.exec(rest)) !== null) {
        const v = m[2] != null ? m[2] : m[3] != null ? m[3] : m[4] != null ? m[4] : "";
        el.setAttribute(m[1], decodeEntities(v));
      }
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
    function escapeAttr(v) {
      return String(v).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
    }
    function escapeText(v) {
      return String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }
    const __windowListeners = /* @__PURE__ */ Object.create(null);
    globalThis.addEventListener = function(type, handler, options) {
      if (typeof handler !== "function") return;
      const capture = !!(options && (options === true || options.capture));
      const list = __windowListeners[type] || (__windowListeners[type] = []);
      if (list.some((l) => l.handler === handler && l.capture === capture)) return;
      list.push({ handler, capture });
    };
    globalThis.removeEventListener = function(type, handler, options) {
      const list = __windowListeners[type];
      if (!list) return;
      const capture = !!(options && (options === true || options.capture));
      __windowListeners[type] = list.filter((l) => !(l.handler === handler && l.capture === capture));
    };
    globalThis.dispatchEvent = function(event) {
      const list = __windowListeners[event.type];
      if (!list || !list.length) return true;
      for (const { handler } of list.slice()) {
        try {
          handler.call(globalThis, event);
        } catch (e) {
          try {
            console.error("[csim] window listener threw:", e && e.message);
          } catch (_) {
          }
        }
      }
      return !event.defaultPrevented;
    };
    (function() {
      const origThen = Promise.prototype.then;
      const LOGGED = "__csimRejectionLogged";
      const logErr = (err, kind) => {
        if (!err || err[LOGGED]) return;
        try {
          err[LOGGED] = true;
          const ctor = err.constructor && err.constructor.name;
          const msg = err.message ? (ctor ? ctor + ": " : "") + err.message : String(err);
          const stk = err.stack ? "\n" + err.stack.slice(0, 600) : "";
          console.error("unhandled rejection (" + kind + "):", msg, stk);
        } catch (_) {
        }
      };
      Promise.prototype.then = function(onF, onR) {
        if (typeof onR === "function") return origThen.call(this, onF, onR);
        const wrappedOnF = typeof onF === "function" ? function(v) {
          try {
            return onF.call(this, v);
          } catch (e) {
            logErr(e, "onF threw");
            throw e;
          }
        } : onF;
        return origThen.call(this, wrappedOnF, function(err) {
          logErr(err, "propagated");
          throw err;
        });
      };
    })();
    globalThis.Document = Document;
    globalThis.Element = Element;
    (function() {
      const onNames = "abort blur cancel canplay canplaythrough change click close contextmenu copy cuechange cut dblclick drag dragend dragenter dragexit dragleave dragover dragstart drop durationchange emptied ended error focus formdata input invalid keydown keypress keyup load loadeddata loadedmetadata loadstart mousedown mouseenter mouseleave mousemove mouseout mouseover mouseup paste pause play playing pointercancel pointerdown pointerenter pointerleave pointermove pointerout pointerover pointerup progress ratechange reset resize scroll seeked seeking select selectstart selectionchange show stalled submit suspend timeupdate toggle touchcancel touchend touchmove touchstart transitioncancel transitionend transitionrun transitionstart volumechange waiting wheel".split(/\s+/);
      for (const n of onNames) {
        const prop = "on" + n;
        if (!(prop in Element.prototype)) Element.prototype[prop] = null;
      }
    })();
    globalThis.Node = Node;
    Node.ELEMENT_NODE = 1;
    Node.ATTRIBUTE_NODE = 2;
    Node.TEXT_NODE = 3;
    Node.CDATA_SECTION_NODE = 4;
    Node.PROCESSING_INSTRUCTION_NODE = 7;
    Node.COMMENT_NODE = 8;
    Node.DOCUMENT_NODE = 9;
    Node.DOCUMENT_TYPE_NODE = 10;
    Node.DOCUMENT_FRAGMENT_NODE = 11;
    Node.prototype.ELEMENT_NODE = 1;
    Node.prototype.ATTRIBUTE_NODE = 2;
    Node.prototype.TEXT_NODE = 3;
    Node.prototype.CDATA_SECTION_NODE = 4;
    Node.prototype.PROCESSING_INSTRUCTION_NODE = 7;
    Node.prototype.COMMENT_NODE = 8;
    Node.prototype.DOCUMENT_NODE = 9;
    Node.prototype.DOCUMENT_TYPE_NODE = 10;
    Node.prototype.DOCUMENT_FRAGMENT_NODE = 11;
    globalThis.Text = Text;
    class HTMLCollection extends Array {
    }
    class NodeList extends Array {
    }
    class NamedNodeMap extends Array {
    }
    globalThis.HTMLCollection = HTMLCollection;
    globalThis.NodeList = NodeList;
    globalThis.NamedNodeMap = NamedNodeMap;
    for (const name of [
      "HTMLInputElement",
      "HTMLTextAreaElement",
      "HTMLSelectElement",
      "HTMLOptionElement",
      "HTMLButtonElement",
      "HTMLImageElement",
      "HTMLScriptElement",
      "HTMLDivElement",
      "HTMLSpanElement",
      "HTMLTableElement",
      "HTMLLabelElement",
      "HTMLLIElement",
      "HTMLUListElement",
      "HTMLOListElement",
      "HTMLAreaElement",
      "HTMLCanvasElement",
      "HTMLDialogElement",
      "HTMLHeadElement",
      "HTMLHtmlElement",
      "HTMLIFrameElement",
      "HTMLLinkElement",
      "HTMLMetaElement",
      "HTMLStyleElement",
      "HTMLTemplateElement",
      "ShadowRoot",
      "SVGElement"
    ]) globalThis[name] = Element;
    const __makeTagCtor = (tagName) => {
      const ctor = function() {
      };
      ctor.prototype = Element.prototype;
      Object.defineProperty(ctor, Symbol.hasInstance, {
        value: (obj) => obj != null && obj._tag === tagName
      });
      return ctor;
    };
    globalThis.HTMLFormElement = __makeTagCtor("form");
    globalThis.HTMLBodyElement = __makeTagCtor("body");
    globalThis.HTMLAnchorElement = __makeTagCtor("a");
    globalThis.HTMLDocument = Document;
    globalThis.CharacterData = Text;
    globalThis.Comment = Text;
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
    globalThis.document = new Document();
    globalThis.window = globalThis;
    globalThis.__csim_traceActive = false;
    globalThis.__csimSetTraceActive = function(v) {
      globalThis.__csim_traceActive = !!v;
    };
    const __consoleFmt = (v, seen) => {
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
    };
    const __consoleJoin = (args) => {
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
      for (let i = 0; i < args.length; i++) out[i] = __consoleFmt(args[i], seen);
      return out.join(" ");
    };
    const __consoleFn = (level) => function() {
      if (!globalThis.__csim_traceActive) return void 0;
      try {
        __csim_logConsole(level, __consoleJoin(arguments));
      } catch (_) {
      }
      return void 0;
    };
    globalThis.console = {
      log: __consoleFn("log"),
      info: __consoleFn("info"),
      warn: __consoleFn("warn"),
      error: __consoleFn("error"),
      debug: __consoleFn("debug")
    };
    globalThis.self = globalThis;
    globalThis.top = globalThis;
    globalThis.parent = globalThis;
    globalThis.frames = globalThis;
    globalThis.frameElement = null;
    globalThis.crypto = {
      randomUUID() {
        return typeof __csim_randomUUID === "function" ? String(__csim_randomUUID()) : "00000000-0000-0000-0000-000000000000";
      },
      getRandomValues(typedArray) {
        if (!typedArray || typeof typedArray.length !== "number") return typedArray;
        const bytes = typeof __csim_randomBytes === "function" ? __csim_randomBytes(typedArray.length) : new Array(typedArray.length).fill(0);
        const arr = bytes || [];
        for (let i = 0; i < typedArray.length; i++) {
          typedArray[i] = (arr[i] | 0) & 255;
        }
        return typedArray;
      }
    };
    globalThis.devicePixelRatio = 1;
    globalThis.screen = {
      width: 1024,
      height: 768,
      availWidth: 1024,
      availHeight: 768,
      colorDepth: 24,
      pixelDepth: 24,
      orientation: { angle: 0, type: "landscape-primary" }
    };
    globalThis.matchMedia = function matchMedia(query) {
      const text = String(query || "");
      return {
        media: text,
        get matches() {
          return mediaMatches(text, currentViewport());
        },
        onchange: null,
        addListener: () => {
        },
        removeListener: () => {
        },
        addEventListener: () => {
        },
        removeEventListener: () => {
        },
        dispatchEvent: () => false
      };
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
      // No real layout/cascade behind us, but blanket `false` makes
      // browser-feature-gates flag us as "unsupported" and abort
      // bootstrap. Default to `true`: apps gating progressive
      // enhancement on a specific feature take the modern path; tests
      // that rely on the legacy fallback would need a real cascade to
      // verify anyway.
      supports() {
        return true;
      }
    };
    const __perfStart = Date.now();
    globalThis.performance = {
      now() {
        return Date.now() - __perfStart;
      },
      timeOrigin: __perfStart,
      timing: { navigationStart: __perfStart },
      mark() {
      },
      measure() {
      },
      getEntries() {
        return [];
      },
      getEntriesByName() {
        return [];
      },
      getEntriesByType() {
        return [];
      },
      clearMarks() {
      },
      clearMeasures() {
      }
    };
    globalThis.structuredClone = function structuredClone(v) {
      if (v == null || typeof v !== "object") return v;
      try {
        return JSON.parse(JSON.stringify(v));
      } catch (_) {
        return v;
      }
    };
    globalThis.reportError = function reportError(e) {
      try {
        console.error(e && e.stack ? e.stack : String(e));
      } catch (_) {
      }
    };
    globalThis.requestIdleCallback = function(cb) {
      return setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 0 }), 0);
    };
    globalThis.cancelIdleCallback = function(id) {
      clearTimeout(id);
    };
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
    class CsimStubObserver {
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
    }
    const __activeIOs = /* @__PURE__ */ new Set();
    globalThis.IntersectionObserver = class IntersectionObserver {
      constructor(cb) {
        this._cb = cb;
        this._observed = /* @__PURE__ */ new Set();
      }
      observe(target) {
        if (!target || this._observed.has(target)) return;
        this._observed.add(target);
        __activeIOs.add(this);
        const self = this;
        Promise.resolve().then(() => self._maybeFire(target));
      }
      unobserve(target) {
        this._observed.delete(target);
        if (this._observed.size === 0) __activeIOs.delete(this);
      }
      disconnect() {
        this._observed.clear();
        __activeIOs.delete(this);
      }
      takeRecords() {
        return [];
      }
      _maybeFire(target) {
        if (!this._observed.has(target)) return;
        if (!__isVisibleNode(target)) return;
        this._observed.delete(target);
        if (this._observed.size === 0) __activeIOs.delete(this);
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
          try {
            console.error("[csim] IntersectionObserver cb threw:", e && e.message);
          } catch (_) {
          }
        }
      }
    };
    function __recheckIntersectionObservers() {
      if (__activeIOs.size === 0) return;
      for (const io of Array.from(__activeIOs)) {
        for (const target of Array.from(io._observed)) {
          io._maybeFire(target);
        }
      }
    }
    globalThis.__recheckIntersectionObservers = __recheckIntersectionObservers;
    globalThis.ResizeObserver = class extends CsimStubObserver {
    };
    globalThis.PerformanceObserver = class extends CsimStubObserver {
    };
    globalThis.AbortSignal = AbortSignal;
    globalThis.AbortController = AbortController;
    globalThis.EventTarget = EventTarget;
    globalThis.Blob = class Blob {
      constructor(parts, opts) {
        const i = opts || {};
        this._parts = (parts || []).map((p) => {
          if (typeof p === "string") return p;
          if (p && p.text) return "";
          if (p instanceof ArrayBuffer) {
            const view = new Uint8Array(p);
            let s = "";
            for (let k = 0; k < view.length; k++) s += String.fromCharCode(view[k]);
            return s;
          }
          if (p && typeof p === "object" && typeof p.byteLength === "number" && p.buffer instanceof ArrayBuffer) {
            const view = new Uint8Array(p.buffer, p.byteOffset || 0, p.byteLength);
            let s = "";
            for (let k = 0; k < view.length; k++) s += String.fromCharCode(view[k]);
            return s;
          }
          return String(p);
        });
        this.size = this._parts.reduce((s, p) => s + (p ? p.length : 0), 0);
        this.type = i.type || "";
      }
      text() {
        if (this._csimHost) return Promise.resolve(__csimReadHostFile(this));
        return Promise.resolve(this._parts.join(""));
      }
      arrayBuffer() {
        return this.text().then((t) => {
          const b = new ArrayBuffer(t.length);
          const v = new Uint8Array(b);
          for (let i = 0; i < t.length; i++) v[i] = t.charCodeAt(i) & 255;
          return b;
        });
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
        return new globalThis.Blob([all.slice(start || 0, end == null ? void 0 : end)], { type: type || this.type });
      }
      stream() {
        return null;
      }
    };
    function __csimReadHostFile(blob) {
      if (typeof __csimReadFilePick !== "function") return "";
      const b64 = __csimReadFilePick(blob._handle, blob._index, blob._start, blob._end);
      if (!b64) return "";
      try {
        return globalThis.atob(String(b64));
      } catch (_) {
        return "";
      }
    }
    function __csimBlobBytes(blob) {
      if (!blob) return "";
      if (blob._csimHost) return __csimReadHostFile(blob);
      return blob._parts ? blob._parts.join("") : "";
    }
    globalThis.__csimBlobBytes = __csimBlobBytes;
    function __csimSerializeMultipart(formData) {
      const boundary = "----csimFormBoundary" + Math.random().toString(36).slice(2);
      let body = "";
      formData.forEach((value, key) => {
        body += "--" + boundary + "\r\n";
        if (value instanceof globalThis.Blob) {
          const filename = value.name != null ? String(value.name) : "blob";
          const contentType = value.type || "application/octet-stream";
          body += 'Content-Disposition: form-data; name="' + key + '"; filename="' + filename + '"\r\n';
          body += "Content-Type: " + contentType + "\r\n\r\n";
          body += __csimBlobBytes(value);
          body += "\r\n";
        } else {
          body += 'Content-Disposition: form-data; name="' + key + '"\r\n\r\n';
          body += String(value) + "\r\n";
        }
      });
      body += "--" + boundary + "--\r\n";
      return { body, boundary };
    }
    globalThis.File = class File extends globalThis.Blob {
      constructor(parts, name, opts) {
        super(parts, opts);
        const i = opts || {};
        this.name = String(name == null ? "" : name);
        this.lastModified = i.lastModified || Date.now();
      }
    };
    const __csimBlobs = globalThis.__csimBlobs = globalThis.__csimBlobs || /* @__PURE__ */ new Map();
    globalThis.__csimBlobCounter = globalThis.__csimBlobCounter || { n: 0 };
    function __csimWorkersAlive() {
      const m = globalThis.__csim_workersByHandle;
      return !!(m && m.size > 0);
    }
    function __csimInstallBlobURL() {
      if (!globalThis.URL || globalThis.URL.__csimBlobInstalled) return;
      globalThis.URL.createObjectURL = function(blob) {
        const url = "blob:csim-" + ++globalThis.__csimBlobCounter.n;
        __csimBlobs.set(url, blob);
        if (__csimWorkersAlive()) {
          try {
            __csim_blobRegister(url, globalThis.btoa(__csimBlobBytes(blob) || ""));
          } catch (_) {
          }
        }
        return url;
      };
      globalThis.URL.revokeObjectURL = function(url) {
        __csimBlobs.delete(url);
        try {
          __csim_blobUnregister(url);
        } catch (_) {
        }
      };
      globalThis.URL.__csimBlobInstalled = true;
    }
    globalThis.__csimReadBlobBase64 = function(url) {
      const blob = __csimBlobs.get(String(url));
      if (!blob) return null;
      try {
        return globalThis.btoa(__csimBlobBytes(blob));
      } catch (_) {
        return null;
      }
    };
    function __csimResolveBlobBytes(url) {
      const blob = __csimBlobs.get(String(url));
      if (blob) return { bytes: __csimBlobBytes(blob), type: blob.type || "application/octet-stream" };
      let b64;
      try {
        b64 = __csim_blobResolve(url);
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
    if (globalThis.URL) __csimInstallBlobURL();
    globalThis.__csimResolveBlobBytes = __csimResolveBlobBytes;
    globalThis.__csimSerializeMultipart = __csimSerializeMultipart;
    globalThis.FileReader = FileReader;
    globalThis.ImageData = ImageData;
    globalThis.ImageBitmap = ImageBitmap;
    globalThis.CanvasRenderingContext2D = CanvasRenderingContext2D;
    globalThis.OffscreenCanvas = OffscreenCanvas;
    globalThis.createImageBitmap = createImageBitmap;
    globalThis.localStorage = localStorage;
    globalThis.sessionStorage = sessionStorage;
    globalThis.ClipboardEvent = ClipboardEvent;
    globalThis.location = makeLocation("http://www.example.com/");
    function makeLocation(url) {
      return parseUrlForLocation(url);
    }
    function parseUrlForLocation(url) {
      try {
        const u = __csim_parseUrl(url, null);
        if (u && !u.error) {
          const loc = Object.assign({}, u, {
            toString() {
              return this.href;
            },
            assign: (next) => __locationAssign(next),
            replace: (next) => __locationAssign(next),
            reload: () => __locationReload()
          });
          const navTarget = (resolved) => __locationAssign(resolved);
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
        assign: (next) => __locationAssign(next),
        replace: (next) => __locationAssign(next),
        reload: () => __locationReload()
      };
    }
    globalThis.__csimUpdateLocation = function(url) {
      let s = String(url || "");
      if (s && !/^[a-z][a-z0-9+.-]*:/i.test(s)) {
        try {
          const base = globalThis.location && globalThis.location.href || null;
          if (base && /^[a-z][a-z0-9+.-]*:/i.test(base)) s = new URL(s, base).href;
        } catch (_) {
        }
      }
      globalThis.location = makeLocation(s);
      __bumpSettleGen();
    };
    globalThis.navigator = navigator;
    globalThis.pageXOffset = 0;
    globalThis.pageYOffset = 0;
    globalThis.scrollX = 0;
    globalThis.scrollY = 0;
    globalThis.innerWidth = 1024;
    globalThis.innerHeight = 768;
    globalThis.outerWidth = 1024;
    globalThis.outerHeight = 768;
    globalThis.scrollTo = function() {
    };
    globalThis.scrollBy = function() {
    };
    globalThis.scroll = function() {
    };
    class CsimSelection {
      constructor() {
        this._ranges = [];
      }
      get rangeCount() {
        return this._ranges.length;
      }
      get isCollapsed() {
        if (!this._ranges.length) return true;
        const r = this._ranges[0];
        return r.collapsed;
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
        __notifySelectionChange();
      }
      removeRange(r) {
        const i = this._ranges.indexOf(r);
        if (i >= 0) {
          this._ranges.splice(i, 1);
          __notifySelectionChange();
        }
      }
      removeAllRanges() {
        if (this._ranges.length) {
          this._ranges.length = 0;
          __notifySelectionChange();
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
        __notifySelectionChange();
      }
      collapseToStart() {
        if (!this._ranges.length) throw new Error("InvalidStateError: no range");
        const r = this._ranges[0];
        r.endContainer = r.startContainer;
        r.endOffset = r.startOffset;
        __notifySelectionChange();
      }
      collapseToEnd() {
        if (!this._ranges.length) throw new Error("InvalidStateError: no range");
        const r = this._ranges[0];
        r.startContainer = r.endContainer;
        r.startOffset = r.endOffset;
        __notifySelectionChange();
      }
      selectAllChildren(node) {
        if (!node) return;
        const r = new DocumentOrderRange();
        r.setStart(node, 0);
        const count = node._children ? node._children.length : 0;
        r.setEnd(node, count);
        this._ranges = [r];
        __notifySelectionChange();
      }
      // Spec: extend the current range's focus to (node, offset).
      // Anchor stays; focus moves. We don't track direction separately,
      // so we just update end to the new focus point. PM uses this to
      // expand a selection from a known anchor.
      extend(node, offset) {
        if (!this._ranges.length) throw new Error("InvalidStateError: no range");
        const r = this._ranges[0];
        r.endContainer = node;
        r.endOffset = offset | 0;
        __notifySelectionChange();
      }
      setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset) {
        const r = new DocumentOrderRange();
        r.setStart(anchorNode, anchorOffset | 0);
        r.setEnd(focusNode, focusOffset | 0);
        this._ranges = [r];
        __notifySelectionChange();
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
    }
    globalThis.Selection = CsimSelection;
    const __sharedSelection = new CsimSelection();
    globalThis.getSelection = function() {
      return __sharedSelection;
    };
    function __notifySelectionChange() {
      const doc = globalThis.document;
      if (!doc) return;
      try {
        dispatchEvent(doc, new Event("selectionchange", { bubbles: false, cancelable: false }));
      } catch (_) {
      }
    }
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
    globalThis.btoa = btoa;
    globalThis.atob = atob;
    globalThis.TextEncoder = TextEncoder;
    globalThis.TextDecoder = TextDecoder;
    globalThis.URL = URL;
    globalThis.URLSearchParams = URLSearchParams;
    globalThis.Headers = Headers;
    __csimInstallBlobURL();
    globalThis.FormData = function FormData(form) {
      this._entries = [];
      if (form && form._tag === "form") {
        const spec = globalThis.__csimFormSerialize(form._id, 0);
        if (spec && Array.isArray(spec.fields)) {
          for (const pair of spec.fields) this._entries.push([String(pair[0]), String(pair[1])]);
        }
      }
    };
    Object.defineProperties(globalThis.FormData.prototype, {
      append: { value: function(k, v) {
        this._entries.push([String(k), v]);
      }, writable: true, configurable: true },
      delete: { value: function(k) {
        this._entries = this._entries.filter((e) => e[0] !== String(k));
      }, writable: true, configurable: true },
      get: { value: function(k) {
        for (const e of this._entries) if (e[0] === String(k)) return e[1];
        return null;
      }, writable: true, configurable: true },
      getAll: { value: function(k) {
        return this._entries.filter((e) => e[0] === String(k)).map((e) => e[1]);
      }, writable: true, configurable: true },
      has: { value: function(k) {
        return this._entries.some((e) => e[0] === String(k));
      }, writable: true, configurable: true },
      set: { value: function(k, v) {
        this.delete(k);
        this.append(k, v);
      }, writable: true, configurable: true },
      forEach: { value: function(fn) {
        for (const e of this._entries) fn(e[1], e[0], this);
      }, writable: true, configurable: true },
      entries: { value: function() {
        return this._entries[Symbol.iterator]();
      }, writable: true, configurable: true },
      keys: { value: function() {
        return this._entries.map((e) => e[0])[Symbol.iterator]();
      }, writable: true, configurable: true },
      values: { value: function() {
        return this._entries.map((e) => e[1])[Symbol.iterator]();
      }, writable: true, configurable: true },
      [Symbol.iterator]: { value: function() {
        return this.entries();
      }, writable: true, configurable: true }
    });
    function __makeFetchResponse(raw, url) {
      let consumed = false;
      const headers = new globalThis.Headers(raw && raw.headers || {});
      const bodyText = raw && raw.body || "";
      const decodeBytes = () => {
        if (raw && typeof raw.body_b64 === "string") {
          try {
            return globalThis.atob(raw.body_b64);
          } catch (_) {
            return "";
          }
        }
        return bodyText;
      };
      const status = raw ? raw.status : 0;
      const resp = {
        url: raw && raw.url || url,
        status,
        statusText: "",
        ok: status >= 200 && status < 300,
        redirected: !!(raw && raw.redirected),
        type: raw && raw.type || "basic",
        headers,
        bodyUsed: false,
        _raw: raw,
        text() {
          if (consumed) return Promise.reject(new TypeError("Body already consumed"));
          consumed = true;
          this.bodyUsed = true;
          return Promise.resolve(bodyText);
        },
        json() {
          if (consumed) return Promise.reject(new TypeError("Body already consumed"));
          consumed = true;
          this.bodyUsed = true;
          try {
            return Promise.resolve(JSON.parse(bodyText || "null"));
          } catch (e) {
            return Promise.reject(e);
          }
        },
        blob() {
          if (consumed) return Promise.reject(new TypeError("Body already consumed"));
          consumed = true;
          this.bodyUsed = true;
          return Promise.resolve(new globalThis.Blob([decodeBytes()], { type: headers.get && headers.get("content-type") || "" }));
        },
        arrayBuffer() {
          if (consumed) return Promise.reject(new TypeError("Body already consumed"));
          consumed = true;
          this.bodyUsed = true;
          const bytes = decodeBytes();
          const buf = new ArrayBuffer(bytes.length);
          const view = new Uint8Array(buf);
          for (let i = 0; i < bytes.length; i++) view[i] = bytes.charCodeAt(i) & 255;
          return Promise.resolve(buf);
        },
        formData() {
          const fd = new globalThis.FormData();
          return Promise.resolve(fd);
        },
        clone() {
          return __makeFetchResponse(raw, url);
        }
      };
      return resp;
    }
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
      let bodyStr = "";
      if (body != null) {
        if (typeof body === "string") {
          bodyStr = body;
        } else if (body instanceof globalThis.FormData) {
          const parts = [];
          body.forEach((v, k) => parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(String(v))));
          bodyStr = parts.join("&");
          if (!("Content-Type" in headers) && !("content-type" in headers)) {
            headers["Content-Type"] = "application/x-www-form-urlencoded";
          }
        } else if (body instanceof globalThis.URLSearchParams) {
          bodyStr = body.toString();
          if (!("Content-Type" in headers) && !("content-type" in headers)) {
            headers["Content-Type"] = "application/x-www-form-urlencoded";
          }
        } else if (body && typeof body === "object" && typeof body.toString === "function") {
          bodyStr = String(body);
        } else {
          bodyStr = String(body);
        }
      }
      if (typeof url === "string" && url.startsWith("blob:")) {
        return new Promise(function(resolve, reject) {
          const r = __csimResolveBlobBytes(url);
          if (!r) return reject(new TypeError("blob URL not found: " + url));
          resolve(__makeFetchResponse({
            status: 200,
            body: r.bytes,
            headers: { "content-type": r.type },
            url
          }, url));
        });
      }
      return new Promise(function(resolve, reject) {
        try {
          const resp = __rackFetch(method.toUpperCase(), url, bodyStr, headers, "follow");
          if (!resp) {
            reject(new TypeError("Network request failed: " + url));
            return;
          }
          resolve(__makeFetchResponse(resp, url));
        } catch (e) {
          reject(e);
        }
      });
    };
    globalThis.history = history;
    const __DEFAULT_DISPLAY = {
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
    function __computedDisplayFor(el) {
      const inlineStyle = el._attrs.style;
      if (inlineStyle) {
        const m = /(^|;|\s)display\s*:\s*([^;]+)/i.exec(inlineStyle);
        if (m) return m[2].trim();
      }
      if (el._attrs.hidden != null) return "none";
      if (matchesAnyHideRule(el)) return "none";
      return __DEFAULT_DISPLAY[el._tag] || "block";
    }
    function __computedVisibilityFor(el) {
      const inlineStyle = el._attrs.style;
      if (inlineStyle) {
        const m = /(^|;|\s)visibility\s*:\s*([^;]+)/i.exec(inlineStyle);
        if (m) return m[2].trim();
      }
      return "";
    }
    function __makeComputedStyleProxy(el) {
      return new Proxy(el.style, {
        get(target, key) {
          if (key === "display") return __computedDisplayFor(el);
          if (key === "visibility") return __computedVisibilityFor(el);
          if (key === "getPropertyValue") {
            return function(name) {
              const n = String(name).toLowerCase();
              if (n === "display") return __computedDisplayFor(el);
              if (n === "visibility") return __computedVisibilityFor(el);
              return target.getPropertyValue ? target.getPropertyValue(name) : target[n] || "";
            };
          }
          return target[key];
        }
      });
    }
    globalThis.getComputedStyle = function(el) {
      if (!el || el.nodeType !== NODE_ELEMENT) return makeStyleProxy({ _attrs: {} });
      return el._computedStyleProxy || (el._computedStyleProxy = __makeComputedStyleProxy(el));
    };
    globalThis.__csimComputedStyle = function(handle, names) {
      const el = __handles.get(handle);
      if (!el || el.nodeType !== NODE_ELEMENT) return {};
      const proxy = getComputedStyle(el);
      const out = {};
      for (const n of names) out[n] = String(proxy[n] || "");
      return out;
    };
    const __handles = /* @__PURE__ */ new Map();
    registerNode(globalThis.document);
    function registerNode(n) {
      __handles.set(n._id, n);
      if (n._children) for (const c of n._children) registerNode(c);
    }
    function lookup(h) {
      return __handles.get(h) || null;
    }
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
    function registerSubtree(node) {
      if (!node) return;
      __handles.set(node._id, node);
      if (node._children) for (const c of node._children) registerSubtree(c);
    }
    function unregisterSubtree(node) {
      if (!node) return;
      __handles.delete(node._id);
      if (node._children) for (const c of node._children) unregisterSubtree(c);
    }
    globalThis.__csimLoadDocument = function(html) {
      __initialScriptsDone = false;
      __hideRules = [];
      __layoutRules = [];
      __hideRuleIdx = __layoutRuleIdx = null;
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
      ({ hide: __hideRules, layout: __layoutRules } = collectCascadeRules(globalThis.document));
      __hideRuleIdx = __layoutRuleIdx = null;
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
      if (__observers.size && __hasQueuedRecords()) deliverMutations();
      if (typeof __recheckIntersectionObservers === "function") __recheckIntersectionObservers();
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
    function scriptText(el) {
      let s = "";
      for (const c of el._children) if (c.nodeType === NODE_TEXT) s += c.data;
      return s;
    }
    const SCRIPT_TYPES_CLASSIC = /* @__PURE__ */ new Set([
      "",
      "text/javascript",
      "application/javascript",
      "application/ecmascript"
    ]);
    globalThis.__csim_modules = /* @__PURE__ */ Object.create(null);
    globalThis.__csim_inProgress = /* @__PURE__ */ Object.create(null);
    globalThis.__csim_importmap = { imports: /* @__PURE__ */ Object.create(null), scopes: /* @__PURE__ */ Object.create(null) };
    const __csim_modules = globalThis.__csim_modules;
    const __csim_inProgress = globalThis.__csim_inProgress;
    const __csim_importmap = globalThis.__csim_importmap;
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
        const resolved = __csim_resolveSpecifier(String(spec), base);
        return Promise.resolve(__csim_require(resolved));
      } catch (e) {
        return Promise.reject(e);
      }
    };
    globalThis.__csim_require = function(url) {
      if (url in __csim_modules) return __csim_modules[url];
      if (url in __csim_inProgress) return __csim_inProgress[url];
      const src = __csim_fetchModuleSource(String(url));
      if (src == null) throw new Error("module not registered: " + url);
      const wrapped = "globalThis.__csim_pending_factory = function (__exports) {\n" + src + "\n};";
      try {
        __csim_runScript(url, wrapped);
      } catch (e) {
        throw new Error("module compile failed for " + url + ": " + (e && e.message ? e.message : e));
      }
      const factory = globalThis.__csim_pending_factory;
      globalThis.__csim_pending_factory = null;
      if (typeof factory !== "function") throw new Error("module factory did not register for " + url);
      const exports = {};
      __csim_inProgress[url] = exports;
      try {
        factory(exports);
        __csim_modules[url] = exports;
      } finally {
        delete __csim_inProgress[url];
      }
      return exports;
    };
    globalThis.__csim_resolveSpecifier = function(specifier, baseUrl) {
      const mapped = __csim_importmap.imports[specifier];
      if (mapped) return resolveAgainst(mapped, baseUrl);
      if (specifier.charAt(0) === "/" || specifier.startsWith("./") || specifier.startsWith("../") || /^[a-z]+:\/\//i.test(specifier)) {
        return resolveAgainst(specifier, baseUrl);
      }
      return specifier;
    };
    function resolveAgainst(url, base) {
      try {
        const u = __csim_parseUrl(url, base || globalThis.location && globalThis.location.href || null);
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
            const resp = __rackFetch("GET", src, "", null, "follow");
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
          if (parsed.imports && typeof parsed.imports === "object") Object.assign(__csim_importmap.imports, parsed.imports);
          if (parsed.scopes && typeof parsed.scopes === "object") Object.assign(__csim_importmap.scopes, parsed.scopes);
        }
      }
      try {
        __csim_pushImportmap(JSON.stringify(__csim_importmap));
      } catch (_) {
      }
    }
    if (typeof globalThis.__csim_fetchModuleSource !== "function") {
      globalThis.__csim_fetchModuleSource = function() {
        return null;
      };
    }
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
      if (n instanceof ShadowRoot) return "ShadowRoot";
      return "";
    };
    globalThis.__csimDescribeNode = function(h) {
      const n = lookup(h);
      if (!n || n.nodeType !== NODE_ELEMENT) return null;
      const cls = (n._attrs.class || "").trim().split(/\s+/)[0] || "";
      return { tag: n._tag || "", id: n._attrs.id || "", cls };
    };
    globalThis.__csimAttr = function(h, name) {
      const n = lookup(h);
      if (!n) return null;
      switch (String(name)) {
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
      }
      return n.getAttribute ? n.getAttribute(name) : null;
    };
    globalThis.__csimHasAttr = function(h, name) {
      const n = lookup(h);
      return !!(n && n.hasAttribute && n.hasAttribute(name));
    };
    const INVISIBLE_TAGS = /* @__PURE__ */ new Set(["head", "script", "style", "template", "noscript", "title"]);
    const DISPLAY_NONE_RE = /(^|;|\s)display\s*:\s*none\b/i;
    const VISIBILITY_HIDDEN_RE = /(^|;|\s)visibility\s*:\s*hidden\b/i;
    const DISPLAY_OTHER_RE = /(^|;|\s)display\s*:\s*(?!none\b)[^;]+/i;
    const VISIBILITY_OTHER_RE = /(^|;|\s)visibility\s*:\s*(?!hidden\b)[^;]+/i;
    function selfHidden(el) {
      if (el._attrs.hidden != null) return true;
      if (el._tag === "dialog" && el._attrs.open == null) return true;
      const style = el._attrs.style;
      if (style && (DISPLAY_NONE_RE.test(style) || VISIBILITY_HIDDEN_RE.test(style))) return true;
      if (style && DISPLAY_OTHER_RE.test(style)) return false;
      return matchesAnyHideRule(el);
    }
    function __isVisibleNode(el) {
      if (!el || el.nodeType !== NODE_ELEMENT) return false;
      if (INVISIBLE_TAGS.has(el._tag)) return false;
      if (el._tag === "input" && (el._attrs.type || "").toLowerCase() === "hidden") return false;
      let cur = el;
      while (cur) {
        if (cur.nodeType === NODE_DOC) return true;
        if (cur.nodeType === NODE_ELEMENT) {
          if (INVISIBLE_TAGS.has(cur._tag)) return false;
          if (selfHidden(cur)) return false;
        }
        cur = cur._parent;
      }
      return false;
    }
    globalThis.__isVisibleNode = __isVisibleNode;
    let __hideRules = [];
    let __layoutRules = [];
    let __ruleSerial = 0;
    const VIEWPORT_DEFAULT = { width: 1024, height: 768 };
    function currentViewport() {
      return {
        width: Number(globalThis.innerWidth) || VIEWPORT_DEFAULT.width,
        height: Number(globalThis.innerHeight) || VIEWPORT_DEFAULT.height
      };
    }
    globalThis.__csimRebuildCascade = function() {
      if (!globalThis.document || !globalThis.document.documentElement) return;
      ({ hide: __hideRules, layout: __layoutRules } = collectCascadeRules(globalThis.document));
      __hideRuleIdx = __layoutRuleIdx = null;
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
              if (prop === "display" || prop === "visibility" || prop === "text-transform") {
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
      if (feat === "hover" || feat === "any-hover") return val === "hover";
      if (feat === "pointer" || feat === "any-pointer") return val === "fine";
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
    function parsePx(s) {
      const n = parseFloat(s);
      if (Number.isNaN(n)) return 0;
      if (/em$/.test(s)) return n * 16;
      if (/rem$/.test(s)) return n * 16;
      return n;
    }
    function parseDppx(s) {
      const n = parseFloat(s);
      if (Number.isNaN(n)) return 1;
      if (/dppx$/.test(s)) return n;
      if (/dpi$/.test(s)) return n / 96;
      if (/dpcm$/.test(s)) return n / 37.795;
      return n;
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
            if (node.name === "supports" || node.name === "container") {
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
      __ruleSerial = 0;
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
            const source = __ruleSerial++;
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
          const resp = __rackFetch("GET", href, "", null, "follow");
          if (resp && resp.status < 400 && resp.body) consume(resp.body);
        } catch (_) {
        }
      }
      return { hide, layout };
    }
    let __hideRuleIdx = null;
    let __layoutRuleIdx = null;
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
      for (const c of classTokens(el)) {
        const cb2 = idx.byClass.get(c);
        if (cb2) for (const r of cb2) cb(r);
      }
      if (idx.universal.length) for (const r of idx.universal) cb(r);
    }
    const EMPTY_CLASS_TOKENS = Object.freeze([]);
    function classTokens(el) {
      const cls = el._attrs.class;
      if (!cls) return EMPTY_CLASS_TOKENS;
      if (el._classTokensKey !== cls) {
        el._classTokensKey = cls;
        el._classTokensCache = cls.split(/\s+/).filter(Boolean);
      }
      return el._classTokensCache;
    }
    const LAYOUT_PROPS = ["top", "left", "width", "height", "text-transform"];
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
    function parsePx(v) {
      if (v == null) return null;
      const m = /^(-?\d+(?:\.\d+)?)px$/.exec(String(v).trim());
      return m ? parseFloat(m[1]) : /^(-?\d+(?:\.\d+)?)$/.test(v) ? parseFloat(v) : null;
    }
    function resolveLayoutProp(el, prop) {
      const inline = parseInlineLayout(el)[prop];
      let best = inline ? { spec: [1, 0, 0, 0], source: Infinity, ...inline } : null;
      if (__layoutRules.length) {
        if (!__layoutRuleIdx) __layoutRuleIdx = buildRuleIndex(__layoutRules);
        forEachCandidateRule(__layoutRuleIdx, el, (r) => {
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
      return best ? parsePx(best.value) : null;
    }
    function specCompare(a, b) {
      for (let i = 0; i < 4; i++) {
        if (a[i] !== b[i]) return a[i] - b[i];
      }
      return 0;
    }
    globalThis.__csimTimersDebug = function() {
      return { size: __timers.size, virtualNow: __virtualNow };
    };
    globalThis.__csimElementRect = function(h) {
      const el = __handles.get(h);
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
    function matchesAnyHideRule(el) {
      if (__hideRules.length === 0) return false;
      if (!__hideRuleIdx) __hideRuleIdx = buildRuleIndex(__hideRules);
      let bestD = null, bestV = null;
      forEachCandidateRule(__hideRuleIdx, el, (r) => {
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
        if (r.visibility != null && winsCascade(bestV, r, false)) {
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
    globalThis.__csimVisible = function(h) {
      const n = lookup(h);
      if (!n || n.nodeType !== NODE_ELEMENT) return false;
      if (INVISIBLE_TAGS.has(n._tag)) return false;
      if (n._tag === "input" && (n._attrs.type || "").toLowerCase() === "hidden") return false;
      let summarySeen = false;
      let cur = n;
      while (cur) {
        if (cur.nodeType === NODE_DOC) return true;
        if (cur.nodeType === NODE_ELEMENT) {
          if (INVISIBLE_TAGS.has(cur._tag)) return false;
          if (selfHidden(cur)) return false;
          if (cur._tag === "details" && cur._attrs.open == null && !summarySeen) return false;
          if (cur._tag === "summary") summarySeen = true;
        }
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
      let startTransform = "none";
      for (let cur = n._parent; cur; cur = cur._parent) {
        if (cur.nodeType !== NODE_ELEMENT) continue;
        const v = cascadedTextTransform(cur);
        if (v && v !== "inherit") {
          startTransform = v;
          break;
        }
      }
      return collectVisibleText(n, startTransform);
    };
    const INLINE_WS_RE = /[\t\n\v\f\r]+/g;
    const BLOCK_TAGS = /* @__PURE__ */ new Set([
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
      "td",
      "tfoot",
      "th",
      "thead",
      "tr",
      "ul"
    ]);
    const TABLE_CELL_TAGS = /* @__PURE__ */ new Set(["td", "th"]);
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
    const FLEX_LIKE_DISPLAY = /* @__PURE__ */ new Set(["flex", "grid", "inline-flex", "inline-grid"]);
    const INLINE_DISPLAY_RE = /(?:^|;)\s*display\s*:\s*([^;!]+?)\s*(?:!important)?\s*(?:;|$)/i;
    function isFlexLikeContainer(el) {
      const style = el._attrs && el._attrs.style;
      if (style) {
        const m = INLINE_DISPLAY_RE.exec(style);
        if (m) {
          const v = m[1].trim().toLowerCase();
          return FLEX_LIKE_DISPLAY.has(v);
        }
      }
      for (const tok of classTokens(el)) {
        if (FLEX_LIKE_DISPLAY.has(tok)) return true;
      }
      return false;
    }
    const TAILWIND_TEXT_TRANSFORM = Object.assign(/* @__PURE__ */ Object.create(null), {
      uppercase: "uppercase",
      lowercase: "lowercase",
      capitalize: "capitalize",
      "normal-case": "none"
    });
    function tailwindTextTransform(el) {
      for (const tok of classTokens(el)) {
        const t = TAILWIND_TEXT_TRANSFORM[tok];
        if (t) return t;
      }
      return null;
    }
    function parseInlineTextTransform(el) {
      const s = el._attrs && el._attrs.style;
      if (!s) return null;
      const m = /(?:^|;)\s*text-transform\s*:\s*([^;!]+?)\s*(?:!important)?\s*(?:;|$)/i.exec(String(s));
      return m ? m[1].toLowerCase() : null;
    }
    function cascadedTextTransform(el) {
      const inline = parseInlineTextTransform(el);
      if (!inline) {
        const tw = tailwindTextTransform(el);
        if (tw) return tw;
      }
      let best = inline ? { value: inline, spec: [1, 0, 0, 0], important: /!important/i.test(el._attrs.style || ""), source: Infinity } : null;
      if (__layoutRules.length) {
        if (!__layoutRuleIdx) __layoutRuleIdx = buildRuleIndex(__layoutRules);
        forEachCandidateRule(__layoutRuleIdx, el, (r) => {
          const cap = r.captured["text-transform"];
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
    function collectVisibleText(node, transform) {
      if (node.nodeType === NODE_TEXT) {
        const raw = String(node.data || "").replace(INLINE_WS_RE, " ");
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
        if (node._tag === "details" && node._attrs.open == null) {
          let s = "";
          for (const c of node._children) {
            if (c.nodeType === NODE_ELEMENT && c._tag === "summary") s += collectVisibleText(c, effTransform);
          }
          return s;
        }
        transform = effTransform;
      }
      const flexContext = node.nodeType === NODE_ELEMENT && isFlexLikeContainer(node);
      let out = "";
      for (const c of node._children) {
        if (flexContext && c.nodeType === NODE_TEXT && !/\S/.test(String(c.data || ""))) continue;
        const part = collectVisibleText(c, transform);
        if (!part) continue;
        const isBlock = c.nodeType === NODE_ELEMENT && (BLOCK_TAGS.has(c._tag) || flexContext);
        if (isBlock && out && !out.endsWith("\n")) out += "\n";
        out += part;
        if (isBlock && !part.endsWith("\n")) out += "\n";
        if (c.nodeType === NODE_ELEMENT && TABLE_CELL_TAGS.has(c._tag) && hasNextCellSibling(c)) {
          out += "	";
        }
      }
      return out;
    }
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
    const FORM_CONTROLS = /* @__PURE__ */ new Set(["input", "select", "textarea", "button", "optgroup", "option"]);
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
    let __asyncResult = null;
    globalThis.__evalAsyncScript = function(code, args) {
      __asyncResult = null;
      const list = (args || []).map(
        (a) => a && typeof a === "object" && "__elementHandle" in a ? __handles.get(a.__elementHandle) || null : a
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
      const start = __handles.get(h);
      if (!start || start.nodeType !== NODE_ELEMENT) return "";
      for (let cur2 = start; cur2; cur2 = cur2._parent) {
        if (cur2 instanceof ShadowRoot) return "(: Shadow DOM element - no XPath :)";
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
        segments.unshift(`${cur._tag}[${idx}]`);
        cur = parent;
      }
      return "/" + segments.join("/");
    };
    globalThis.__csimOptionContext = function(h) {
      const n = __handles.get(h);
      if (!n || n.nodeType !== NODE_ELEMENT) return { hasSelect: false, multiple: false };
      let cur = n._parent;
      while (cur && cur._tag !== "select") cur = cur._parent;
      if (!cur || cur._tag !== "select") return { hasSelect: false, multiple: false };
      return { hasSelect: true, multiple: cur._attrs.multiple != null };
    };
    function __csimMakeDataTransfer(items) {
      const dtItems = items.map((it) => {
        if (it.kind === "file") {
          const file = { name: it.name, type: "", size: 0 };
          return { kind: "file", type: "application/octet-stream", getAsFile: () => file };
        }
        return {
          kind: "string",
          type: it.type,
          getAsString: (cb) => {
            try {
              cb(it.value);
            } catch (_) {
            }
          }
        };
      });
      const files = items.filter((it) => it.kind === "file").map((it) => ({ name: it.name, type: "", size: 0 }));
      const types = items.map((it) => it.kind === "file" ? "Files" : it.type);
      return {
        items: dtItems,
        files,
        types,
        effectAllowed: "all",
        dropEffect: "none",
        getData: (t) => {
          const i = items.find((x) => x.type === t);
          return i ? i.value : "";
        },
        setData: () => {
        },
        clearData: () => {
        }
      };
    }
    globalThis.__csimClickFinish = function(h, base) {
      const n = __handles.get(h);
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
        return { kind: "navigate", url: href, target: String(n._attrs.target || "") };
      }
      return null;
    };
    globalThis.__csimDropOnto = function(h, items) {
      const target = __handles.get(h);
      if (!target) return false;
      const dt = __csimMakeDataTransfer(items || []);
      for (const type of ["dragenter", "dragover", "drop"]) {
        const ev = new Event(type, { bubbles: true, cancelable: true });
        ev.dataTransfer = dt;
        dispatchEvent(target, ev);
      }
      return true;
    };
    globalThis.__csimShadowRoot = function(h) {
      const el = __handles.get(h);
      const sr = el && el._shadowRoot;
      return sr && sr.mode === "open" && sr._id != null ? sr._id : 0;
    };
    globalThis.__csimActiveElement = function() {
      const doc = globalThis.document;
      if (!doc) return 0;
      const el = doc._activeElement || doc.body || doc.documentElement;
      return el && el._id != null ? el._id : 0;
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
    globalThis.__csimAlive = function(h) {
      const n = __handles.get(h);
      return n != null && isConnected(n);
    };
    globalThis.__csimValue = function(h) {
      const n = lookup(h);
      if (!n || n.nodeType !== NODE_ELEMENT) return null;
      const tag = n._tag;
      if (tag === "textarea") {
        if (n._attrs.value != null) return n._attrs.value;
        return __stripOneLeadingNewline(n.textContent);
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
    function __csimIsFocusable(n) {
      if (!n || n.nodeType !== NODE_ELEMENT) return false;
      if (n._attrs.disabled != null) return false;
      const t = n._tag;
      if (t === "input") {
        const it = (n._attrs.type || "").toLowerCase();
        if (it === "hidden") return false;
        return true;
      }
      if (t === "textarea" || t === "select" || t === "button") return true;
      if (t === "a" && n._attrs.href != null) return true;
      if (n._attrs.tabindex != null) return true;
      if (n._attrs.contenteditable != null && (n._attrs.contenteditable || "").toLowerCase() !== "false") return true;
      return false;
    }
    globalThis.__csimClickResolve = function(h, modifiers) {
      const n = lookup(h);
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
      const base = {
        bubbles: true,
        cancelable: true,
        button: 0,
        which: 1,
        shiftKey: !!mods.shiftKey,
        ctrlKey: !!mods.ctrlKey,
        altKey: !!mods.altKey,
        metaKey: !!mods.metaKey,
        clientX: +mods.clientX || 0,
        clientY: +mods.clientY || 0
      };
      dispatchHover(n, { dedupe: true, init: base });
      globalThis.__csimPendingFormSubmit = null;
      globalThis.__csimPendingNavigation = null;
      const mousedownEv = new MouseEvent("mousedown", base);
      dispatchEvent(n, mousedownEv);
      if (!mousedownEv.defaultPrevented && __csimIsFocusable(n)) {
        try {
          n.focus();
        } catch (_) {
        }
      }
      if (mods.mouseDownOnly) {
        return { kind: "partial", base };
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
      if (click.defaultPrevented) return null;
      if (n._tag === "summary" && !click.defaultPrevented) {
        let parent = n._parent;
        while (parent && parent._tag !== "details") parent = parent._parent;
        if (parent && parent._tag === "details") {
          if (parent._attrs.open != null) delete parent._attrs.open;
          else parent._attrs.open = "";
          try {
            dispatchEvent(parent, new Event("toggle", { bubbles: false }));
          } catch (_) {
          }
        }
      }
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
        return { kind: "navigate", url: href, target: String(__anchor._attrs.target || "") };
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
    function labeledControlFor(label) {
      const forId = label._attrs.for;
      if (forId) {
        const root = globalThis.document.documentElement;
        if (root) {
          const hit = selectFirst([root], "#" + forId);
          if (hit) return hit;
        }
      }
      const LABELABLE = /* @__PURE__ */ new Set(["button", "input", "meter", "output", "progress", "select", "textarea"]);
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
    function isContenteditable(n) {
      let cur = n;
      while (cur && cur.nodeType === NODE_ELEMENT) {
        const v = cur._attrs.contenteditable;
        if (v != null) {
          const lower = String(v).toLowerCase();
          if (lower === "" || lower === "true" || lower === "plaintext-only") return true;
          if (lower === "false") return false;
        }
        cur = cur._parent;
      }
      return false;
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
    const __KEY_NAME_MAP = {
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
      right: { key: "ArrowRight", code: "ArrowRight", keyCode: 39, char: null, inputType: null }
    };
    const __MODIFIER_NAMES = /* @__PURE__ */ new Set([
      "control",
      "ctrl",
      "command",
      "cmd",
      "meta",
      "shift",
      "alt",
      "option"
    ]);
    const __MODIFIER_KEY_INFO = {
      shift: { key: "Shift", code: "ShiftLeft", keyCode: 16 },
      control: { key: "Control", code: "ControlLeft", keyCode: 17 },
      ctrl: { key: "Control", code: "ControlLeft", keyCode: 17 },
      alt: { key: "Alt", code: "AltLeft", keyCode: 18 },
      option: { key: "Alt", code: "AltLeft", keyCode: 18 },
      meta: { key: "Meta", code: "MetaLeft", keyCode: 91 },
      command: { key: "Meta", code: "MetaLeft", keyCode: 91 },
      cmd: { key: "Meta", code: "MetaLeft", keyCode: 91 }
    };
    function __resolveKey(spec) {
      const known = __KEY_NAME_MAP[String(spec).toLowerCase()];
      if (known) return Object.assign({}, known);
      if (typeof spec === "string" && spec.length >= 1) {
        return {
          key: spec,
          code: spec.length === 1 ? "Key" + spec.toUpperCase() : "",
          keyCode: spec.length === 1 ? spec.toUpperCase().charCodeAt(0) : 0,
          char: spec,
          inputType: "insertText"
        };
      }
      return { key: String(spec), code: "", keyCode: 0, char: null, inputType: null };
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
      const n = lookup(h);
      if (!n || n.nodeType !== NODE_ELEMENT) return false;
      const ceTypeable = isContenteditable(n);
      const typeable = ceTypeable || (n._tag === "input" || n._tag === "textarea") && !(n._attrs.readonly != null || n._attrs.disabled != null);
      if (typeable) {
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
        dispatchEvent(n, kd);
        let blocked = kd.defaultPrevented;
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
        if (typeable && !blocked && info.key === "ArrowLeft") {
          const cur = n._attrs.value != null ? n._attrs.value : "";
          const pos = n._selectionStart != null ? n._selectionStart : cur.length;
          const next = Math.max(0, pos - 1);
          n._selectionStart = next;
          n._selectionEnd = next;
        } else if (typeable && !blocked && info.key === "ArrowRight") {
          const cur = n._attrs.value != null ? n._attrs.value : "";
          const pos = n._selectionEnd != null ? n._selectionEnd : cur.length;
          const next = Math.min(cur.length, pos + 1);
          n._selectionStart = next;
          n._selectionEnd = next;
        }
        if (!blocked && wouldType) {
          const doDefault = () => {
            if (ceTypeable) {
              if (info.char != null) {
                __csimInsertTextAtSelection(info.char);
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
        dispatchEvent(n, new KeyboardEvent("keyup", init));
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
          if (typeable && (mods.ctrlKey || mods.metaKey) && lowerKey === "v") {
            const pasted = globalThis.__csimClipboardGet();
            if (pasted) {
              const ev = new Event("paste", { bubbles: true, cancelable: true });
              ev.clipboardData = {
                types: ["text/plain"],
                getData(kind) {
                  return kind === "text" || kind === "text/plain" ? pasted : "";
                },
                setData() {
                }
              };
              dispatchEvent(n, ev);
              if (!ev.defaultPrevented) {
                const cur = n._attrs.value != null ? n._attrs.value : "";
                const s = n._selectionStart != null ? n._selectionStart : cur.length;
                const e = n._selectionEnd != null ? n._selectionEnd : s;
                const next = cur.slice(0, s) + pasted + cur.slice(e);
                n._attrs.value = next;
                if (n._tag === "textarea") {
                  n._children = [Object.assign(new Text(next), { _parent: n })];
                }
                n._selectionStart = n._selectionEnd = s + pasted.length;
                dispatchEvent(n, new InputEvent("input", {
                  bubbles: true,
                  cancelable: true,
                  data: pasted,
                  inputType: "insertFromPaste"
                }));
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
            __csimInsertTextAtSelection(ch);
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
    const TEXT_LIKE_INPUT_TYPES = /* @__PURE__ */ new Set([
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
    const DEFAULT_SUBMIT_SELECTOR = 'button[type="submit"], button:not([type]), input[type="submit"], input[type="image"]';
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
        if (f._attrs.disabled != null) continue;
        const tag = f._tag;
        const name = f._attrs.name;
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
          const raw = f._attrs.value != null ? f._attrs.value : __stripOneLeadingNewline(f.textContent);
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
    const __timers = /* @__PURE__ */ new Map();
    let __nextTimerId = 1;
    let __virtualNow = 0;
    function scheduleTimer(handler, ms, args, period) {
      if (typeof handler !== "function") return 0;
      const id = __nextTimerId++;
      const delay = Math.max(0, +ms || 0);
      const wasEmpty = __timers.size === 0;
      __timers.set(id, { handler, args, due: __virtualNow + delay, period });
      if (wasEmpty) __setTimersActive(true);
      return id;
    }
    globalThis.setTimeout = function(h, ms, ...a) {
      return scheduleTimer(h, ms, a, null);
    };
    globalThis.setInterval = function(h, ms, ...a) {
      return scheduleTimer(h, ms, a, Math.max(1, +ms || 0));
    };
    globalThis.clearTimeout = function(id) {
      if (__timers.delete(id) && __timers.size === 0) __setTimersActive(false);
    };
    globalThis.clearInterval = globalThis.clearTimeout;
    let __rafIdSeq = 1;
    const __rafCancelled = /* @__PURE__ */ new Set();
    globalThis.requestAnimationFrame = function(cb) {
      const id = __rafIdSeq++;
      Promise.resolve().then(() => {
        if (__rafCancelled.has(id)) {
          __rafCancelled.delete(id);
          return;
        }
        try {
          cb(__virtualNow);
        } catch (e) {
          try {
            console.error("[csim] requestAnimationFrame cb threw:", e && (e.message || e));
          } catch (_) {
          }
        }
      });
      return id;
    };
    globalThis.cancelAnimationFrame = function(id) {
      if (id != null) __rafCancelled.add(id);
    };
    globalThis.queueMicrotask = function(cb) {
      scheduleTimer(cb, 0, [], null);
    };
    globalThis.XMLHttpRequest = XMLHttpRequest;
    globalThis.__virtualNow = () => __virtualNow;
    globalThis.__hasReadyTimer = function() {
      for (const t of __timers.values()) if (t.due <= __virtualNow) return true;
      return false;
    };
    globalThis.__drainTimers = function(maxMs, maxIter) {
      if (typeof maxMs !== "number") maxMs = 2e3;
      if (typeof maxIter !== "number") maxIter = 1e4;
      const limit = __virtualNow + maxMs;
      let iter = 0;
      let fired = 0;
      while (iter++ < maxIter && __timers.size > 0) {
        let nextId = null, nextDue = Infinity;
        for (const [id, t2] of __timers) {
          if (t2.due < nextDue) {
            nextDue = t2.due;
            nextId = id;
          }
        }
        if (nextId === null || nextDue > limit) break;
        __virtualNow = nextDue;
        const t = __timers.get(nextId);
        if (t.period != null) t.due = __virtualNow + t.period;
        else __timers.delete(nextId);
        try {
          t.handler.apply(null, t.args || []);
        } catch (e) {
          try {
            const where = t.handler && t.handler.toString && t.handler.toString().slice(0, 200) || "(no source)";
            console.error("[csim] timer threw:", e && (e.stack || e.message), "\n  handler:", where);
          } catch (_) {
          }
        }
        if (__observers.size && __hasQueuedRecords()) deliverMutations();
        if (typeof __recheckIntersectionObservers === "function") __recheckIntersectionObservers();
        fired++;
      }
      if (__virtualNow < limit) __virtualNow = limit;
      if (__timers.size === 0) __setTimersActive(false);
      return fired;
    };
    globalThis.__resetTimers = function() {
      const had = __timers.size > 0;
      __timers.clear();
      __virtualNow = 0;
      if (had) __setTimersActive(false);
    };
    globalThis.__resetPage = function() {
      if (globalThis.document) {
        for (const c of globalThis.document._children.slice()) {
          globalThis.document.removeChild(c);
        }
        globalThis.document.documentElement = null;
        globalThis.document._listeners = null;
      } else {
        globalThis.document = new Document();
      }
      __handles.clear();
      registerNode(globalThis.document);
      __resetTimers();
      __externalScriptsRun.clear();
      delete globalThis._rails_loaded;
    };
    (function() {
      let __targetTZ = null;
      globalThis.__csimSetTimezone = function(tz) {
        __targetTZ = typeof tz === "string" && tz.length > 0 ? tz : null;
      };
      const OrigDTF = Intl.DateTimeFormat;
      function PatchedDTF(locales, options) {
        if (!(this instanceof PatchedDTF)) return new PatchedDTF(locales, options);
        if (!__targetTZ || options && options.timeZone) return new OrigDTF(locales, options);
        return new OrigDTF(locales, Object.assign({}, options, { timeZone: __targetTZ }));
      }
      PatchedDTF.prototype = OrigDTF.prototype;
      PatchedDTF.supportedLocalesOf = function(l, o) {
        return OrigDTF.supportedLocalesOf(l, o);
      };
      Intl.DateTimeFormat = PatchedDTF;
    })();
    globalThis.MessageEvent = MessageEvent;
    globalThis.EventSource = EventSource;
    globalThis.Audio = Audio;
    globalThis.indexedDB = indexedDB;
    globalThis.IDBRequest = IDBRequest;
    globalThis.IDBDatabase = IDBDatabase;
    globalThis.IDBObjectStore = IDBObjectStore;
    globalThis.IDBTransaction = IDBTransaction;
    globalThis.IDBIndex = IDBIndex;
    globalThis.IDBCursor = IDBCursor;
    installIfMissing();
  })();
})();
