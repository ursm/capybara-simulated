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
    get attributes()          { return __dom(this.__h, 'attributes', []); }

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
    createElement(tag)   { return wrap(__dom(this.__h, 'createElement',  [String(tag)])); }
    createTextNode(text) { return wrap(__dom(this.__h, 'createTextNode', [String(text)])); }

    // classList — implemented in JS atop get/setAttribute. Two round-trips
    // per mutation, but classList ops are infrequent enough that adding
    // dedicated dom_op cases isn't worth the surface-area cost.
    get classList() { return new ClassList(this); }

    // EventTarget — listeners live in JS, keyed by handle. Ruby-driven
    // actions (click, submit) call into __dispatchFromRuby below to fire
    // an event before performing the default action.
    addEventListener(type, handler, options) {
      if (!handler) return;
      const opts = (options && typeof options === 'object') ? options : {capture: !!options};
      let byType = __listeners.get(this.__h);
      if (!byType) __listeners.set(this.__h, byType = new Map());
      let arr = byType.get(String(type));
      if (!arr) byType.set(String(type), arr = []);
      arr.push({handler, capture: !!opts.capture, once: !!opts.once});
    }
    removeEventListener(type, handler, options) {
      const byType = __listeners.get(this.__h);
      if (!byType) return;
      const arr = byType.get(String(type));
      if (!arr) return;
      const opts = (options && typeof options === 'object') ? options : {capture: !!options};
      const cap = !!opts.capture;
      const i = arr.findIndex(l => l.handler === handler && l.capture === cap);
      if (i >= 0) arr.splice(i, 1);
    }
    dispatchEvent(event) {
      return __dispatch(this, event);
    }
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
    }
    preventDefault() { if (this.cancelable) this.defaultPrevented = true; }
    stopPropagation() { this._stopped = true; }
    stopImmediatePropagation() { this._stopped = true; this._immediate = true; }
  }
  globalThis.Event = Event;
  // Subtypes get a permissive shim: every field on `init` becomes a property
  // so handlers reading e.detail / e.key / e.button find what they expect.
  function makeEventSubclass(name) {
    const C = class extends Event {
      constructor(type, init) {
        super(type, init);
        if (init) for (const k of Object.keys(init)) {
          if (!(k in this)) this[k] = init[k];
        }
      }
    };
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
        if (i >= 0) arr.splice(i, 1);
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

  globalThis.Element = Element;
  globalThis.document = new Element(0);

  // Convenience top-level shortcuts.
  globalThis.document.body            = globalThis.document.querySelector('body');
  globalThis.document.head            = globalThis.document.querySelector('head');
  globalThis.document.documentElement = globalThis.document.querySelector('html');
})();
