// v2 bridge: thin DOM proxy backed by Ruby callbacks via `__dom(handle, op, args)`.
// Every method delegates straight through to Capybara::Simulated::V2::Browser#dom_op.
// Keep the implementation small — adding a method here means adding a case in
// Browser#dom_op too.

(function () {
  function wrap(h) {
    return h == null ? null : new Element(h);
  }

  class Element {
    constructor(h) {
      Object.defineProperty(this, '__h', {value: h, writable: false});
    }

    // Tree queries
    querySelector(s)    { return wrap(__dom(this.__h, 'querySelector', [s])); }
    querySelectorAll(s) { return __dom(this.__h, 'querySelectorAll', [s]).map(wrap); }
    getElementById(id)  { return wrap(__dom(this.__h, 'getElementById', [id])); }
    closest(s)          { return wrap(__dom(this.__h, 'closest', [s])); }
    matches(s)          { return !!__dom(this.__h, 'matches', [s]); }
    contains(other)     { return !!__dom(this.__h, 'contains', [other && other.__h]); }

    // Tree pointers
    get parentNode()      { return wrap(__dom(this.__h, 'parentNode',      [])); }
    get parentElement()   { return wrap(__dom(this.__h, 'parentElement',   [])); }
    get firstChild()      { return wrap(__dom(this.__h, 'firstChild',      [])); }
    get lastChild()       { return wrap(__dom(this.__h, 'lastChild',       [])); }
    get nextSibling()     { return wrap(__dom(this.__h, 'nextSibling',     [])); }
    get previousSibling() { return wrap(__dom(this.__h, 'previousSibling', [])); }
    get children()        { return __dom(this.__h, 'children',   []).map(wrap); }
    get childNodes()      { return __dom(this.__h, 'childNodes', []).map(wrap); }

    // Identity / shape
    get nodeType()    { return __dom(this.__h, 'nodeType',    []); }
    get nodeName()    { return __dom(this.__h, 'nodeName',    []); }
    get tagName()     { return __dom(this.__h, 'tagName',     []); }
    get textContent() { return __dom(this.__h, 'textContent', []); }
    set textContent(v) { __dom(this.__h, 'setTextContent', [String(v)]); }
    get innerText()   { return __dom(this.__h, 'innerText',   []); }
    get innerHTML()   { return __dom(this.__h, 'innerHTML',   []); }
    set innerHTML(v)  { __dom(this.__h, 'setInnerHTML', [String(v)]); }
    get outerHTML()   { return __dom(this.__h, 'outerHTML',   []); }

    // Attributes
    getAttribute(name)        { return __dom(this.__h, 'getAttribute', [String(name)]); }
    hasAttribute(name)        { return !!__dom(this.__h, 'hasAttribute', [String(name)]); }
    setAttribute(name, value) { __dom(this.__h, 'setAttribute', [String(name), String(value)]); }
    removeAttribute(name)     { __dom(this.__h, 'removeAttribute', [String(name)]); }
    // NamedNodeMap-shaped: array-iterable AND name-indexable. jQuery
    // does `el.attributes[name].expando` for feature detection, so we
    // return Attr-like records on each named slot.
    get attributes() {
      const pairs = __dom(this.__h, 'attributes', []);
      const out = [];
      for (const p of pairs) {
        const attr = {name: p[0], value: p[1], specified: true, expando: false};
        out.push(attr);
        out[p[0]] = attr;
      }
      return out;
    }

    // Common element shortcuts
    get id()        { return this.getAttribute('id') || ''; }
    set id(v)       { this.setAttribute('id', v); }
    get className() { return this.getAttribute('class') || ''; }
    set className(v) { this.setAttribute('class', v); }
    get value()     { return __dom(this.__h, 'value', []); }
    set value(v)    { __dom(this.__h, 'setValue', [v == null ? '' : String(v)]); }
    get checked()   { return !!__dom(this.__h, 'checked', []); }
    set checked(v)  { __dom(this.__h, 'setChecked', [!!v]); }
    get disabled()  { return !!__dom(this.__h, 'disabled', []); }
    get hidden()    { return !!__dom(this.__h, 'hidden', []); }

    // <form> ergonomics
    get form() { return wrap(__dom(this.__h, 'form', [])); }

    // <input list="...">'s referenced <datalist>, plus its options. Used
    // by Capybara's datalist-option resolver via element.evaluate_script.
    get list()    { return wrap(__dom(this.__h, 'list', [])); }
    get options() { return __dom(this.__h, 'options', []).map(wrap); }
    // <option>.label — falls back to text content when no label attr.
    get label()   { return __dom(this.__h, 'label', []); }

    // HTML5 form validation. Constraint computation lives on the Ruby
    // side (see Browser#compute_validity); these proxy through.
    get validity()           { return __dom(this.__h, 'validity', []); }
    get validationMessage()  { return __dom(this.__h, 'validationMessage', []); }
    checkValidity()          { return !!this.validity.valid; }
    reportValidity()         { return this.checkValidity(); }
    setCustomValidity()      {}

    // Library boot-time probes — ownerDocument is the Document any node
    // belongs to; we model a single document so it's always the global.
    get ownerDocument() { return globalThis.document; }
    get nodeValue()     { return null; }
    get prefix()        { return null; }
    get namespaceURI()  { return null; }

    // Layout-related getters return zeros / empties — no layout engine,
    // but libraries probe these during boot and at runtime. Returning
    // a plausible-shaped object is enough to keep them out of the way.
    getClientRects()         { return []; }
    getBoundingClientRect()  { return {top: 0, right: 0, bottom: 0, left: 0, width: 0, height: 0, x: 0, y: 0}; }
    get offsetParent()       { return null; }
    get offsetWidth()        { return 0; }
    get offsetHeight()       { return 0; }
    get offsetLeft()         { return 0; }
    get offsetTop()          { return 0; }
    get clientWidth()        { return 0; }
    get clientHeight()       { return 0; }
    get clientLeft()         { return 0; }
    get clientTop()          { return 0; }
    get scrollWidth()        { return 0; }
    get scrollHeight()       { return 0; }
    get scrollLeft()         { return 0; }
    get scrollTop()          { return 0; }
    set scrollLeft(v)        {}
    set scrollTop(v)         {}
    scrollIntoView()         {}
    scrollTo()               {}
    focus()                  { __dom(this.__h, 'focus', []); }
    blur()                   { __dom(this.__h, 'blur',  []); }
    select()                 {}
    setSelectionRange()      {}
    setRangeText()           {}

    // Mutations
    appendChild(child) {
      if (child == null) return null;
      __dom(this.__h, 'appendChild', [child.__h]);
      return child;
    }
    removeChild(child) {
      if (child == null) return null;
      __dom(this.__h, 'removeChild', [child.__h]);
      return child;
    }
    insertBefore(newChild, refChild) {
      if (newChild == null) return null;
      __dom(this.__h, 'insertBefore', [newChild.__h, refChild && refChild.__h]);
      return newChild;
    }
    replaceChild(newChild, oldChild) {
      if (newChild == null || oldChild == null) return null;
      __dom(this.__h, 'replaceChild', [newChild.__h, oldChild.__h]);
      return oldChild;
    }

    // Document factory ops live on Element so document.createElement works
    // without a separate Document subclass.
    createElement(tag)        { return wrap(__dom(this.__h, 'createElement',         [String(tag)])); }
    createTextNode(text)      { return wrap(__dom(this.__h, 'createTextNode',        [String(text)])); }
    createComment(text)       { return wrap(__dom(this.__h, 'createComment',         [String(text)])); }
    createDocumentFragment()  { return wrap(__dom(this.__h, 'createDocumentFragment', [])); }
    // Attribute object isn't really used by libraries except for
    // existence-checks; return a plain shape with name/value.
    createAttribute(name)     { return {name: String(name), value: '', specified: true}; }

    // getElementsBy* — jQuery / older libs probe for these directly.
    getElementsByTagName(tag)   { return __dom(this.__h, 'getElementsByTagName',   [String(tag)]).map(wrap); }
    getElementsByClassName(cls) { return __dom(this.__h, 'getElementsByClassName', [String(cls)]).map(wrap); }
    getElementsByName(name)     { return __dom(this.__h, 'getElementsByName',      [String(name)]).map(wrap); }

    cloneNode(deep)              { return wrap(__dom(this.__h, 'cloneNode', [!!deep])); }
    compareDocumentPosition(o)   { return __dom(this.__h, 'compareDocumentPosition', [o && o.__h]); }

    // CSSStyleDeclaration-shaped: cssText round-trips through the style
    // attribute; getPropertyValue / setProperty / removeProperty edit
    // individual rules. Named property access (`el.style.color`) isn't
    // wired — would need a Proxy, which adds cost most callers don't
    // need. Libraries that boot-probe via cssText (jQuery 1.12) work.
    get style() {
      let f = __styleFacades.get(this.__h);
      if (!f) { f = CSSStyleFacade(this); __styleFacades.set(this.__h, f); }
      return f;
    }

    // classList — implemented in JS atop get/setAttribute. Two round-trips
    // per mutation, but classList ops are infrequent enough that adding
    // dedicated dom_op cases isn't worth the surface-area cost.
    get classList() { return new ClassList(this); }

    // EventTarget — listeners live in JS, keyed by handle. Ruby-driven
    // actions (click, submit) call into __dispatchFromRuby below to fire
    // an event before performing the default action.
    addEventListener(type, handler, options) {
      if (!handler) return;
      type = String(type);
      const opts = (options && typeof options === 'object') ? options : {capture: !!options};
      let byType = __listeners.get(this.__h);
      if (!byType) __listeners.set(this.__h, byType = new Map());
      let arr = byType.get(type);
      if (!arr) byType.set(type, arr = []);
      arr.push({handler, capture: !!opts.capture, once: !!opts.once});
      bumpListenerCount(type, +1);
    }
    removeEventListener(type, handler, options) {
      type = String(type);
      const byType = __listeners.get(this.__h);
      if (!byType) return;
      const arr = byType.get(type);
      if (!arr) return;
      const opts = (options && typeof options === 'object') ? options : {capture: !!options};
      const cap = !!opts.capture;
      const i = arr.findIndex(l => l.handler === handler && l.capture === cap);
      if (i >= 0) {
        arr.splice(i, 1);
        bumpListenerCount(type, -1);
      }
    }
    dispatchEvent(event) {
      return __dispatch(this, event);
    }
  }

  // CSSStyleDeclaration shim. Wraps a Proxy so libraries that touch
  // `el.style.backgroundColor` (camelCase) and `el.style['background-color']`
  // (kebab) both flow through getPropertyValue / setProperty against the
  // underlying `style` attribute.
  function camelToKebab(s) {
    return String(s).replace(/[A-Z]/g, m => '-' + m.toLowerCase());
  }
  function CSSStyleFacade(el) {
    const target = {
      _el: el,
      get cssText() { return el.getAttribute('style') || ''; },
      set cssText(v) { el.setAttribute('style', String(v)); },
      getPropertyValue(name) {
        const want = String(name).toLowerCase();
        const text = el.getAttribute('style') || '';
        for (const rule of text.split(';')) {
          const m = rule.match(/^\s*([^:]+?)\s*:\s*(.*?)\s*$/);
          if (m && m[1].toLowerCase() === want) return m[2];
        }
        return '';
      },
      setProperty(name, value) {
        const want = String(name).toLowerCase();
        const rules = (el.getAttribute('style') || '').split(';')
          .map(r => r.trim()).filter(Boolean)
          .filter(r => r.split(':')[0].trim().toLowerCase() !== want);
        if (value !== '' && value != null) rules.push(`${want}: ${value}`);
        el.setAttribute('style', rules.join('; '));
      },
      removeProperty(name) {
        const want = String(name).toLowerCase();
        const rules = (el.getAttribute('style') || '').split(';')
          .map(r => r.trim()).filter(Boolean)
          .filter(r => r.split(':')[0].trim().toLowerCase() !== want);
        el.setAttribute('style', rules.join('; '));
      },
      get length() {
        return (el.getAttribute('style') || '').split(';').filter(r => r.trim()).length;
      }
    };
    return new Proxy(target, {
      get(t, p) {
        if (typeof p === 'symbol' || p in t) return t[p];
        return t.getPropertyValue(camelToKebab(p));
      },
      set(t, p, v) {
        if (p in t) { t[p] = v; return true; }
        t.setProperty(camelToKebab(p), v);
        return true;
      },
      has(t, p) {
        return (p in t) || t.getPropertyValue(camelToKebab(p)) !== '';
      }
    });
  }

  class ClassList {
    constructor(el) {
      Object.defineProperty(this, '_el', {value: el, writable: false});
    }
    _list() {
      const v = this._el.getAttribute('class') || '';
      return v.split(/\s+/).filter(Boolean);
    }
    _write(list) {
      this._el.setAttribute('class', list.join(' '));
    }
    contains(c) { return this._list().indexOf(String(c)) !== -1; }
    add(...cs) {
      const cur = this._list();
      let changed = false;
      for (const c of cs) {
        const s = String(c);
        if (cur.indexOf(s) === -1) { cur.push(s); changed = true; }
      }
      if (changed) this._write(cur);
    }
    remove(...cs) {
      const cur = this._list();
      const drop = new Set(cs.map(String));
      const out  = cur.filter(c => !drop.has(c));
      if (out.length !== cur.length) this._write(out);
    }
    toggle(c, force) {
      const cur = this._list();
      const s   = String(c);
      const has = cur.indexOf(s) !== -1;
      if (force === true || (force === undefined && !has)) {
        if (!has) { cur.push(s); this._write(cur); }
        return true;
      }
      if (has) this._write(cur.filter(x => x !== s));
      return false;
    }
  }

  // Listener registry: handle (int) -> Map<type, Array<{handler, capture, once}>>.
  // Keyed by handle rather than Element because each JS access wraps the same
  // node in a fresh Element object — the integer handle is the stable identity.
  const __listeners = new Map();
  // CSSStyleDeclaration cache, keyed by handle. jQuery `.css(prop, val)`
  // reads `el.style.X` repeatedly per element; caching avoids rebuilding
  // the Proxy / target each call. Cleared in __resetPage along with the
  // listener / observer maps.
  const __styleFacades = new Map();
  // Per-type listener counts so Ruby can short-circuit dispatch when no
  // one's listening for a given event type. Notified via __setListenedType.
  const __listenerCounts = new Map();
  function bumpListenerCount(type, delta) {
    const cur = __listenerCounts.get(type) || 0;
    const nxt = cur + delta;
    if (nxt <= 0) {
      __listenerCounts.delete(type);
      if (cur > 0) __setListenedType(type, false);
    } else {
      __listenerCounts.set(type, nxt);
      if (cur === 0) __setListenedType(type, true);
    }
  }

  class Event {
    constructor(type, init) {
      const i = init || {};
      this.type = String(type);
      this.bubbles = !!i.bubbles;
      this.cancelable = !!i.cancelable;
      this.target = null;
      this.currentTarget = null;
      this.eventPhase = 0;
      this.defaultPrevented = false;
      this._stopped = false;
      this._immediate = false;
      // Spread remaining init keys (shiftKey / ctrlKey / detail / key /
      // keyCode / clientX / ...) so both Event and any subclass carry
      // the modifier and mouse / keyboard fields page handlers read.
      for (const k of Object.keys(i)) {
        if (!(k in this)) this[k] = i[k];
      }
    }
    preventDefault() { if (this.cancelable) this.defaultPrevented = true; }
    stopPropagation() { this._stopped = true; }
    stopImmediatePropagation() { this._stopped = true; this._immediate = true; }
  }
  globalThis.Event = Event;
  // Subtypes are aliases — base Event already spreads init keys, so every
  // field on `init` (e.detail / e.key / e.button) is already a property.
  // The named subclasses exist only because library boot does `instanceof
  // MouseEvent` / `new KeyboardEvent(...)`-style construction.
  function makeEventSubclass(name) {
    const C = class extends Event {};
    Object.defineProperty(C, 'name', {value: name});
    return C;
  }
  globalThis.MouseEvent    = makeEventSubclass('MouseEvent');
  globalThis.KeyboardEvent = makeEventSubclass('KeyboardEvent');
  globalThis.SubmitEvent   = makeEventSubclass('SubmitEvent');
  globalThis.InputEvent    = makeEventSubclass('InputEvent');
  globalThis.CustomEvent   = makeEventSubclass('CustomEvent');

  function buildPath(target) {
    const path = [];
    let cur = target;
    while (cur) { path.push(cur); cur = cur.parentNode; }
    return path;
  }

  function invokeListeners(el, event, capture, atTarget) {
    const byType = __listeners.get(el.__h);
    if (!byType) return;
    const arr = byType.get(event.type);
    if (!arr || arr.length === 0) return;
    event.currentTarget = el;
    // Snapshot — handlers may add/remove during dispatch.
    const snapshot = arr.slice();
    for (const l of snapshot) {
      if (event._immediate) break;
      if (!atTarget && l.capture !== capture) continue;
      try {
        l.handler.call(el, event);
      } catch (e) {
        // Browsers report listener errors but keep dispatching the rest.
        try { console.error('listener threw:', e && e.message ? e.message : e); } catch (_) {}
      }
      if (l.once) {
        const i = arr.indexOf(l);
        if (i >= 0) {
          arr.splice(i, 1);
          bumpListenerCount(event.type, -1);
        }
      }
    }
  }

  function __dispatch(target, event) {
    if (!target) return true;
    event.target = target;
    const path = buildPath(target);  // [target, parent, ..., document]
    // Capture: document → target's parent
    for (let i = path.length - 1; i > 0; i--) {
      if (event._stopped) break;
      event.eventPhase = 1;
      invokeListeners(path[i], event, true, false);
    }
    // Target
    if (!event._stopped) {
      event.eventPhase = 2;
      invokeListeners(target, event, false, true);
    }
    // Bubble: target's parent → document (only if event bubbles)
    if (event.bubbles) {
      for (let i = 1; i < path.length; i++) {
        if (event._stopped) break;
        event.eventPhase = 3;
        invokeListeners(path[i], event, false, false);
      }
    }
    event.eventPhase = 0;
    return !event.defaultPrevented;
  }

  // Called from Ruby (`browser.dispatch_event`). Returns true if no
  // listener prevented the default action — Ruby uses that to decide
  // whether to navigate, submit, etc.
  globalThis.__dispatchFromRuby = function (handle, type, init) {
    return __dispatch(new Element(handle), new Event(type, init));
  };
  // Send a keyboard event with the right shape for the page-level
  // listeners that read e.keyCode / e.which (legacy but still common).
  globalThis.__dispatchKeyFromRuby = function (handle, type, keyCode) {
    return __dispatch(new Element(handle), new KeyboardEvent(type, {
      bubbles: true, cancelable: true,
      keyCode: keyCode, which: keyCode, charCode: type === 'keypress' ? keyCode : 0
    }));
  };

  // HTML5 drag-and-drop synthesis. Ruby#drop builds an items array
  // ([{kind:'file',name,path} | {kind:'string',type,value}]); we wrap
  // it in a DataTransfer-shaped object and fire the dragenter / dragover
  // / drop sequence at the target.
  function makeDataTransfer(items) {
    const dtItems = items.map(it => {
      if (it.kind === 'file') {
        const file = {name: it.name, type: '', size: 0};
        return {kind: 'file', type: 'application/octet-stream', getAsFile: () => file};
      }
      return {
        kind: 'string', type: it.type,
        getAsString: cb => { try { cb(it.value); } catch (_) {} }
      };
    });
    const files = items.filter(it => it.kind === 'file').map(it => ({name: it.name, type: '', size: 0}));
    const types = items.map(it => it.kind === 'file' ? 'Files' : it.type);
    return {
      items:    dtItems,
      files:    files,
      types:    types,
      effectAllowed: 'all',
      dropEffect:    'none',
      getData: t => { const i = items.find(x => x.type === t); return i ? i.value : ''; },
      setData: () => {},
      clearData: () => {},
      setDragImage: () => {}
    };
  }

  globalThis.__dropOnto = function (handle, items) {
    const target = new Element(handle);
    const dt     = makeDataTransfer(items || []);
    const init   = {bubbles: true, cancelable: true, dataTransfer: dt};
    __dispatch(target, new Event('dragenter', init));
    __dispatch(target, new Event('dragover',  init));
    __dispatch(target, new Event('drop',      init));
  };

  // Called from Ruby#fire_lifecycle_events. Dispatches DOMContentLoaded /
  // load on document AND window — libraries listen on either.
  globalThis.__fireLifecycle = function (type) {
    const ev = new Event(type, {bubbles: false, cancelable: false});
    __dispatch(globalThis.document, ev);
    // Same event, separate dispatch on the window-as-EventTarget.
    if (typeof globalThis.dispatchEvent === 'function') {
      try { globalThis.dispatchEvent(ev); } catch (_) {}
    }
  };
  globalThis.__setReadyState = function (state) {
    globalThis.document.readyState = state;
  };
  // Browser bumps this on every navigate / pushState / replaceState so
  // location.href / pathname etc. reflect the current URL on read.
  globalThis.__syncLocation = function (url) {
    try { __locationUrl = new URL(url); } catch (_) {}
  };
  // Window-level event listener API — jQuery binds `load` on window.
  // Reuses the document's listener machinery so __dispatch routes there.
  const __windowListeners = new Map();
  globalThis.addEventListener = function (type, handler) {
    let arr = __windowListeners.get(String(type));
    if (!arr) __windowListeners.set(String(type), arr = []);
    arr.push(handler);
  };
  globalThis.removeEventListener = function (type, handler) {
    const arr = __windowListeners.get(String(type));
    if (!arr) return;
    const i = arr.indexOf(handler);
    if (i >= 0) arr.splice(i, 1);
  };
  globalThis.dispatchEvent = function (event) {
    const arr = __windowListeners.get(event.type);
    if (!arr) return true;
    for (const h of arr.slice()) {
      try { h.call(globalThis, event); } catch (_) {}
    }
    return !event.defaultPrevented;
  };


  // ── evaluate_script ──────────────────────────────────────────
  // Capybara's `evaluate_script(code, *args)` wraps `code` in a
  // `return (<code>)` function so an expression's value flows back.
  // Element args / returns travel as {__elementHandle: N} sidecars so
  // they round-trip through JSON on both bridge directions.
  function rehydrateArg(a) {
    if (a == null || typeof a !== 'object') return a;
    if (a.__elementHandle != null) return new Element(a.__elementHandle);
    if (Array.isArray(a)) return a.map(rehydrateArg);
    const out = {};
    for (const k of Object.keys(a)) out[k] = rehydrateArg(a[k]);
    return out;
  }
  function marshalResult(v) {
    if (v == null || typeof v !== 'object') return v;
    if (v instanceof Element) return {__elementHandle: v.__h};
    if (Array.isArray(v)) return v.map(marshalResult);
    // Plain-object walk; skip non-enumerable / throwing accessors.
    const out = {};
    for (const k of Object.keys(v)) {
      try { out[k] = marshalResult(v[k]); } catch (_) {}
    }
    return out;
  }
  globalThis.__evalScript = function (code, args) {
    const a = (args || []).map(rehydrateArg);
    // `eval` inside the function body sees the function's `arguments`,
    // so user code referencing `arguments[i]` works the same as in
    // selenium / chrome. eval also handles statements / expressions
    // uniformly — selenium's "return <expr>" wrapping can't.
    const fn = new Function('return eval(' + JSON.stringify(code) + ');');
    return marshalResult(fn.apply(null, a));
  };

  // evaluate_async_script: the last argument the script receives is a
  // callback; the result is whatever the callback is invoked with. We
  // start the script (which typically schedules a setTimeout / fetch /
  // etc.), Ruby then drains the virtual clock via settle, and reads
  // the result via __pollAsyncResult. If the callback never fires
  // (script hung), Ruby raises.
  let __asyncResult = null;
  globalThis.__evalAsyncScript = function (code, args) {
    __asyncResult = null;
    const a = (args || []).map(rehydrateArg);
    a.push(function (v) { __asyncResult = {value: marshalResult(v)}; });
    const fn = new Function('return eval(' + JSON.stringify(code) + ');');
    fn.apply(null, a);
  };
  globalThis.__pollAsyncResult = function () {
    return __asyncResult;
  };

  // ── Virtual clock + timer queue ─────────────────────────────
  // Real test runs don't sleep; instead Ruby calls __drainTimers after
  // each user action, advancing __virtualNow until the queue is empty
  // (or the cap kicks in to break runaway setInterval / chains).
  const __timers = new Map();  // id -> {handler, args, due, period?}
  let __nextTimerId = 1;
  let __virtualNow = 0;

  function scheduleTimer(handler, ms, args, period) {
    if (typeof handler !== 'function') return 0;
    const id = __nextTimerId++;
    const delay = Math.max(0, +ms || 0);
    const wasEmpty = __timers.size === 0;
    __timers.set(id, {handler, args, due: __virtualNow + delay, period});
    if (wasEmpty) __setTimersActive(true);
    return id;
  }

  globalThis.setTimeout    = function (h, ms, ...a) { return scheduleTimer(h, ms, a, null); };
  globalThis.setInterval   = function (h, ms, ...a) { return scheduleTimer(h, ms, a, Math.max(1, +ms || 0)); };
  globalThis.clearTimeout  = function (id) {
    if (__timers.delete(id) && __timers.size === 0) __setTimersActive(false);
  };
  globalThis.clearInterval = globalThis.clearTimeout;
  globalThis.requestAnimationFrame = function (cb) { return scheduleTimer(() => cb(__virtualNow), 16, [], null); };
  globalThis.cancelAnimationFrame  = globalThis.clearTimeout;
  // queueMicrotask: collapse to setTimeout(0). Real microtasks run before
  // the next macrotask, but with virtual time it's near-equivalent.
  globalThis.queueMicrotask = function (cb) { scheduleTimer(cb, 0, [], null); };

  globalThis.__drainTimers = function (maxMs, maxIter) {
    if (typeof maxMs   !== 'number') maxMs   = 2000;
    if (typeof maxIter !== 'number') maxIter = 10000;
    const limit = __virtualNow + maxMs;
    let iter = 0;
    while (iter++ < maxIter && __timers.size > 0) {
      let nextId = null, nextDue = Infinity;
      for (const [id, t] of __timers) {
        if (t.due < nextDue) { nextDue = t.due; nextId = id; }
      }
      if (nextId === null || nextDue > limit) break;
      __virtualNow = nextDue;
      const t = __timers.get(nextId);
      if (t.period != null) {
        t.due = __virtualNow + t.period;
      } else {
        __timers.delete(nextId);
      }
      try {
        t.handler.apply(null, t.args || []);
      } catch (e) {
        try { console.error('timer threw:', e && e.message ? e.message : e); } catch (_) {}
      }
    }
    if (__timers.size === 0) __setTimersActive(false);
  };

  // Reset between sessions / pages so leftover timers from a prior page
  // don't fire on the next one.
  globalThis.__resetTimers = function () {
    const had = __timers.size > 0;
    __timers.clear();
    __virtualNow = 0;
    if (had) __setTimersActive(false);
  };

  // Wipe per-page JS state on navigate / reset!. Handle integers from the
  // old document end up reassigned to fresh nodes after the document
  // re-parses, so listeners / observers / CE instances keyed on those
  // handles would silently fire against the wrong nodes (and accumulate
  // every visit). customElement *definitions* clear too — registry is
  // window-scoped, and our tests treat each visit as a fresh window.
  globalThis.__resetPage = function () {
    __listeners.clear();
    __windowListeners.clear();
    __styleFacades.clear();
    for (const t of __listenerCounts.keys()) __setListenedType(t, false);
    __listenerCounts.clear();
    __observers.clear();
    __notifyMutationActive(false);
    __ceDefs.clear();
    __ceInstances.clear();
    __ceWaiters.clear();
    __ceObserver = null;
    __resetTimers();
  };

  // ── MutationObserver ────────────────────────────────────────
  // Observer storage lives in JS; Ruby buffers records during DOM
  // writes (dom_op) and ships them in batches through __deliverMutations.
  // observe()/disconnect() flip a Ruby-side flag via __notifyMutationActive
  // so that pages with no observers pay zero per-mutation overhead.
  const __observers = new Set();

  function matchRecord(obsTarget, options, rec) {
    if (rec.type === 'childList' && !options.childList) return false;
    if (rec.type === 'attributes' &&
        !options.attributes && !options.attributeFilter) return false;
    if (rec.type === 'characterData' && !options.characterData) return false;
    if (rec.type === 'attributes' && options.attributeFilter &&
        options.attributeFilter.indexOf(rec.attributeName) === -1) return false;
    if (rec.target.__h === obsTarget.__h) return true;
    return !!options.subtree && obsTarget.contains(rec.target);
  }

  class MutationObserver {
    constructor(callback) {
      Object.defineProperty(this, '_cb', {value: callback, writable: false});
      this._observed  = [];
      this._records   = [];
      this._scheduled = false;
    }
    observe(target, options) {
      if (!target) return;
      this._observed.push({target, options: options || {}});
      const wasEmpty = __observers.size === 0;
      __observers.add(this);
      if (wasEmpty) __notifyMutationActive(true);
    }
    disconnect() {
      this._observed = [];
      this._records  = [];
      const had = __observers.delete(this);
      if (had && __observers.size === 0) __notifyMutationActive(false);
    }
    takeRecords() {
      const out = this._records;
      this._records = [];
      return out;
    }
  }
  globalThis.MutationObserver = MutationObserver;

  // Called from Ruby with a JSON-serialised batch of records. We wrap
  // node handles back into Element instances, route to interested
  // observers, and queue a microtask per observer to flush its batch
  // (matching the spec's "deliver as a microtask" semantics).
  globalThis.__deliverMutations = function (records) {
    if (!records || records.length === 0) return;
    for (const r of records) {
      r.target       = wrap(r.target);
      r.addedNodes   = (r.addedNodes   || []).map(wrap);
      r.removedNodes = (r.removedNodes || []).map(wrap);
    }
    for (const obs of __observers) {
      const matched = [];
      for (const rec of records) {
        for (const o of obs._observed) {
          if (matchRecord(o.target, o.options, rec)) { matched.push(rec); break; }
        }
      }
      if (matched.length === 0) continue;
      for (const rec of matched) obs._records.push(rec);
      if (obs._scheduled) continue;
      obs._scheduled = true;
      queueMicrotask(() => {
        obs._scheduled = false;
        const out = obs._records;
        if (out.length === 0) return;
        obs._records = [];
        try { obs._cb(out, obs); } catch (e) {
          try { console.error('MO threw:', e && e.message ? e.message : e); } catch (_) {}
        }
      });
    }
  };

  globalThis.Element = Element;
  // HTMLElement is the conventional base for `class Foo extends HTMLElement`
  // — we don't model an HTML/SVG split, so it's just an alias for Element.
  globalThis.HTMLElement = Element;
  globalThis.Node        = Element;
  // DOM compareDocumentPosition bitmask values. Selector-engine sort
  // routines (jQuery's Sizzle) probe these on the `Node` constructor.
  Node.DOCUMENT_POSITION_DISCONNECTED            = 1;
  Node.DOCUMENT_POSITION_PRECEDING               = 2;
  Node.DOCUMENT_POSITION_FOLLOWING               = 4;
  Node.DOCUMENT_POSITION_CONTAINS                = 8;
  Node.DOCUMENT_POSITION_CONTAINED_BY            = 16;
  Node.DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC = 32;
  globalThis.document = new Element(0);

  // Convenience top-level shortcuts.
  globalThis.document.body            = globalThis.document.querySelector('body');
  globalThis.document.head            = globalThis.document.querySelector('head');
  globalThis.document.documentElement = globalThis.document.querySelector('html');
  // jQuery and friends sniff for these — define them as best-effort
  // no-ops so library load time doesn't ReferenceError.
  // Start as 'loading'; Browser bumps us through interactive → complete
  // around the lifecycle-event firing.
  globalThis.document.readyState  = 'loading';
  globalThis.document.compatMode  = 'CSS1Compat';
  // location.href / pathname / hash / search assignments navigate.
  // Backed by a real URL instance (POLYFILL_URL); reads return the
  // current URL's components, writes synthesise the new href via
  // URL's spec-defined component setters and hand it to Ruby.
  // __syncLocation rebuilds the URL after every navigate.
  let __locationUrl = new URL('http://placeholder/');
  globalThis.document.location = new Proxy({}, {
    get(_, p) {
      if (p === 'assign' || p === 'replace') return url => __locationAssign(String(url));
      if (p === 'reload')                    return () => __locationReload();
      if (p === 'toString')                  return () => __locationUrl.href;
      return __locationUrl[p];
    },
    set(_, p, v) {
      if (p === 'href') { __locationAssign(String(v)); return true; }
      const next = new URL(__locationUrl.href);
      next[p] = String(v);
      __locationAssign(next.href);
      return true;
    }
  });
  globalThis.document.cookie      = '';
  globalThis.document.implementation = {createHTMLDocument: () => globalThis.document};
  // window === defaultView is the canonical relationship; libraries
  // walk it via `node.ownerDocument.defaultView` to find the global.
  globalThis.document.defaultView = globalThis;

  // window === globalThis is the universal "this is a browser-ish env"
  // signal. Plus a handful of shims used during library boot.
  globalThis.window     = globalThis;
  globalThis.self       = globalThis;
  globalThis.location   = globalThis.document.location;
  globalThis.navigator  = {userAgent: 'capybara-simulated/v2', language: 'en-US', languages: ['en-US']};
  globalThis.screen     = {width: 1024, height: 768};
  // history.pushState / replaceState route to Ruby so the v2 driver's
  // current_url tracks SPA-style URL changes. State + title are
  // accepted but ignored — we only mirror the URL.
  globalThis.history = {
    length: 0,
    pushState: function (_state, _title, url) {
      if (url != null) __setCurrentUrl(String(url));
    },
    replaceState: function (_state, _title, url) {
      if (url != null) __setCurrentUrl(String(url));
    },
    back:    function () {},
    forward: function () {},
    go:      function () {}
  };
  globalThis.localStorage   = {getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {}, length: 0, key: () => null};
  globalThis.sessionStorage = {getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {}, length: 0, key: () => null};
  globalThis.getComputedStyle = function () { return {getPropertyValue: () => '', length: 0}; };
  globalThis.matchMedia = function () { return {matches: false, addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}}; };

  // Modal dialogs — alert / confirm / prompt route through Ruby-side
  // __modalDialog (a define_function callback). Ruby decides what to
  // return based on the active accept_modal / dismiss_modal handler;
  // when no handler is set, alert is a no-op, confirm dismisses, and
  // prompt returns null (matches a user clicking "Cancel").
  globalThis.alert = function (message) {
    __modalDialog('alert', String(message == null ? '' : message), null);
  };
  globalThis.confirm = function (message) {
    return !!__modalDialog('confirm', String(message == null ? '' : message), null);
  };
  globalThis.prompt = function (message, def) {
    return __modalDialog('prompt', String(message == null ? '' : message),
                         def == null ? '' : String(def));
  };

  // ── customElements ───────────────────────────────────────────
  // Minimal CE registry: define / get / whenDefined, plus auto-upgrade
  // for existing matches and an internal MutationObserver that catches
  // future insertions / removals to fire connected / disconnectedCallback.
  // observedAttributes / attributeChangedCallback aren't wired yet —
  // libraries that need attribute reactivity tend to use MutationObserver
  // directly anyway.
  const __ceDefs      = new Map();   // tag (lowercased) → ctor
  const __ceInstances = new Map();   // handle → instance object
  const __ceWaiters   = new Map();   // tag → [resolve, ...]
  let   __ceObserver  = null;

  function ceCtorFor(tagName) {
    return __ceDefs.get(String(tagName || '').toLowerCase());
  }

  function ceUpgrade(el) {
    if (!el || el.nodeType !== 1) return;
    if (__ceInstances.has(el.__h)) return;
    const ctor = ceCtorFor(el.tagName);
    if (!ctor) return;
    const inst = Object.create(ctor.prototype);
    Object.defineProperty(inst, '__h', {value: el.__h, writable: false});
    __ceInstances.set(el.__h, inst);
    if (typeof inst.connectedCallback === 'function') {
      try { inst.connectedCallback.call(inst); } catch (e) {
        try { console.error('connectedCallback threw:', e && e.message ? e.message : e); } catch (_) {}
      }
    }
  }

  function ceUpgradeTree(el) {
    if (!el) return;
    ceUpgrade(el);
    if (el.nodeType === 1) {
      for (const c of el.children) ceUpgradeTree(c);
    }
  }

  function ceDisconnect(el) {
    if (!el || el.nodeType !== 1) return;
    const inst = __ceInstances.get(el.__h);
    if (!inst) return;
    __ceInstances.delete(el.__h);
    if (typeof inst.disconnectedCallback === 'function') {
      try { inst.disconnectedCallback.call(inst); } catch (e) {
        try { console.error('disconnectedCallback threw:', e && e.message ? e.message : e); } catch (_) {}
      }
    }
  }

  function ceDisconnectTree(el) {
    if (!el) return;
    ceDisconnect(el);
    if (el.nodeType === 1) {
      for (const c of el.children) ceDisconnectTree(c);
    }
  }

  function ceEnsureObserver() {
    if (__ceObserver) return;
    __ceObserver = new MutationObserver(records => {
      for (const r of records) {
        if (r.type !== 'childList') continue;
        for (const el of r.addedNodes)   ceUpgradeTree(el);
        for (const el of r.removedNodes) ceDisconnectTree(el);
      }
    });
    __ceObserver.observe(document, {childList: true, subtree: true});
  }

  globalThis.customElements = {
    define(name, ctor /*, options */) {
      name = String(name).toLowerCase();
      if (__ceDefs.has(name)) throw new Error('customElement already defined: ' + name);
      if (typeof ctor !== 'function') throw new TypeError('ctor must be a function');
      // Splice Element.prototype into the chain only if it isn't already
      // reachable — preserves user inheritance like
      // `class B extends HTMLElement {}; class A extends B {}`.
      let p = ctor.prototype;
      while (p && p !== Element.prototype) {
        const next = Object.getPrototypeOf(p);
        if (next === Object.prototype || next === null) {
          try { Object.setPrototypeOf(p, Element.prototype); } catch (_) {}
          break;
        }
        p = next;
      }
      __ceDefs.set(name, ctor);
      ceEnsureObserver();
      for (const el of document.querySelectorAll(name)) ceUpgrade(el);
      const arr = __ceWaiters.get(name);
      if (arr) { for (const r of arr) { try { r(ctor); } catch (_) {} } __ceWaiters.delete(name); }
    },
    get(name) {
      return __ceDefs.get(String(name).toLowerCase());
    },
    whenDefined(name) {
      name = String(name).toLowerCase();
      const ctor = __ceDefs.get(name);
      if (ctor && typeof Promise !== 'undefined') return Promise.resolve(ctor);
      // Best-effort thenable when Promise isn't around: invoke immediately.
      if (ctor) return {then: cb => cb(ctor)};
      if (typeof Promise !== 'undefined') {
        return new Promise(resolve => {
          let arr = __ceWaiters.get(name);
          if (!arr) __ceWaiters.set(name, arr = []);
          arr.push(resolve);
        });
      }
      return {then: cb => {
        let arr = __ceWaiters.get(name);
        if (!arr) __ceWaiters.set(name, arr = []);
        arr.push(cb);
      }};
    }
  };
})();
