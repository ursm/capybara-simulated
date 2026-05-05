// bridge: thin DOM proxy backed by Ruby callbacks via `__dom(handle, op, args)`.
// Every method delegates straight through to Capybara::Simulated::Browser#dom_op.
// Keep the implementation small — adding a method here means adding a case in
// Browser#dom_op too.

(function () {
  // Identity is per-handle — Stimulus's `this.element === event.target`
  // would otherwise fail because each access creates a fresh wrapper.
  // Cleared in __resetPage (handle reuse + ceUpgrade prototype swaps).
  const __wrappers = new Map();
  function wrap(h) {
    if (h == null) return null;
    let w = __wrappers.get(h);
    if (!w) {
      w = new Element(h);
      __wrappers.set(h, w);
      // Custom elements are normally upgraded when inserted into the
      // live document (ceEnsureObserver's MutationObserver). DOMParser
      // / template-innerHTML parses don't trigger that observer
      // because the nodes start detached, so eagerly upgrade on first
      // wrapper access — matches the real-browser parse-time semantics
      // Turbo's importStreamElements relies on. `__lazyUpgrade` is
      // populated below once the CE registry is in scope.
      if (__lazyUpgrade) __lazyUpgrade(w);
    }
    return w;
  }
  let __lazyUpgrade = null;

  // Resolve a URL-bearing IDL attribute (href / src / action / ...)
  // against the document's location. `fallbackToDoc` mirrors
  // `form.action` semantics: missing / empty resolves to the document
  // URL rather than ''. Invalid URL → return raw so callers see what
  // they wrote.
  function resolveUrlAttr(raw, fallbackToDoc) {
    const base = globalThis.location && globalThis.location.href;
    if (raw == null || raw === '') {
      return fallbackToDoc ? (base || '') : '';
    }
    try { return new URL(raw, base).href; }
    catch (_) { return raw; }
  }

  class Element {
    constructor(h) {
      // No-arg call lets a CE subclass's `super()` reach this ctor
      // without clobbering the wrapper's pre-existing __h (ceUpgrade
      // swaps the prototype on a wrapper whose handle is already pinned).
      if (h !== undefined) {
        Object.defineProperty(this, '__h', {value: h, writable: false});
      }
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
    get firstElementChild()    { return wrap(__dom(this.__h, 'firstElementChild',    [])); }
    get lastElementChild()     { return wrap(__dom(this.__h, 'lastElementChild',     [])); }
    get nextElementSibling()   { return wrap(__dom(this.__h, 'nextElementSibling',   [])); }
    get previousElementSibling() { return wrap(__dom(this.__h, 'previousElementSibling', [])); }
    get childElementCount()    { return __dom(this.__h, 'childElementCount', []); }

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
    set disabled(v) {
      if (v) this.setAttribute('disabled', '');
      else   this.removeAttribute('disabled');
    }
    get hidden()    { return !!__dom(this.__h, 'hidden', []); }

    // URL-bearing IDL attrs serialise as ABSOLUTE URLs (resolved
    // against the document) — Turbo / Stimulus consume `link.href` as
    // a fully-qualified URL and `new URL(...)` would throw on the raw
    // relative attribute value.
    get href()       { return resolveUrlAttr(this.getAttribute('href')); }
    set href(v)      { this.setAttribute('href', v); }
    get src()        { return resolveUrlAttr(this.getAttribute('src')); }
    set src(v)       { this.setAttribute('src', v); }
    // form.action falls back to the document URL when missing /
    // empty (HTML spec), so it's always a parseable absolute URL.
    get action()     { return resolveUrlAttr(this.getAttribute('action'), true); }
    set action(v)    { this.setAttribute('action', v); }
    get formAction() { return resolveUrlAttr(this.getAttribute('formaction'), true); }
    set formAction(v){ this.setAttribute('formaction', v); }
    // form.method / form.enctype / form.target — these IDL attributes
    // default to spec-defined values, never undefined, so Turbo can
    // do `form.method.toLowerCase()` without a guard.
    get method()       { return (this.getAttribute('method') || 'get').toLowerCase(); }
    set method(v)      { this.setAttribute('method', v); }
    get formMethod()   { const v = this.getAttribute('formmethod'); return v ? v.toLowerCase() : ''; }
    set formMethod(v)  { this.setAttribute('formmethod', v); }
    get enctype()      { return this.getAttribute('enctype') || 'application/x-www-form-urlencoded'; }
    set enctype(v)     { this.setAttribute('enctype', v); }
    get formEnctype()  { return this.getAttribute('formenctype') || ''; }
    set formEnctype(v) { this.setAttribute('formenctype', v); }
    get target()       { return this.getAttribute('target') || ''; }
    set target(v)      { this.setAttribute('target', v); }
    get name()         { return this.getAttribute('name') || ''; }
    set name(v)        { this.setAttribute('name', v); }
    get type()         { return this.getAttribute('type') || ''; }
    set type(v)        { this.setAttribute('type', v); }

    // <template>.content: a real DocumentFragment in browsers; we
    // expose a fragment-view proxy that shares the template's handle
    // for read-side ops (querySelector / children) but signals to
    // appendChild / insertBefore that the children — not the
    // template element itself — should be moved.
    get content() {
      if (this.tagName !== 'TEMPLATE') return this;
      let f = this.__contentView;
      if (!f) {
        f = Object.create(Element.prototype);
        Object.defineProperty(f, '__h', {value: this.__h});
        Object.defineProperty(f, '__isContent', {value: true});
        this.__contentView = f;
      }
      return f;
    }

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
    // baseURI: the document's URL (or `<base href>` if present, but we
    // ignore that for now). Turbo passes this as the base when
    // constructing a URL from form action — it must be parseable.
    get baseURI()       { return (globalThis.location && globalThis.location.href) || 'http://placeholder/'; }
    // getRootNode walks to the tree root (document or shadow root).
    // Turbo's findClosestRecursively walks up via this when reaching
    // the top of the tree, so a missing implementation surfaces as
    // "not a function" mid-event-dispatch.
    getRootNode(_opts)   { return globalThis.document; }
    // No slot system — we don't model a layout-aware shadow tree.
    get assignedSlot()   { return null; }
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
      if (child.__isContent) {
        __dom(this.__h, 'appendChildrenOf', [child.__h]);
      } else {
        __dom(this.__h, 'appendChild', [child.__h]);
      }
      return child;
    }
    removeChild(child) {
      if (child == null) return null;
      __dom(this.__h, 'removeChild', [child.__h]);
      return child;
    }
    insertBefore(newChild, refChild) {
      if (newChild == null) return null;
      if (newChild.__isContent) {
        __dom(this.__h, 'insertChildrenOfBefore', [newChild.__h, refChild && refChild.__h]);
      } else {
        __dom(this.__h, 'insertBefore', [newChild.__h, refChild && refChild.__h]);
      }
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

    // Shadow DOM. Ruby keeps the shadow tree as a DocumentFragment in
    // Browser#shadow_roots, keyed by host handle; the wrapper reads
    // through the same dom_op surface as any other element.
    attachShadow(_init)  { return wrap(__dom(this.__h, 'attachShadow', [])); }
    get shadowRoot()     { return wrap(__dom(this.__h, 'shadowRoot', [])); }
    // Attribute object isn't really used by libraries except for
    // existence-checks; return a plain shape with name/value.
    createAttribute(name)     { return {name: String(name), value: '', specified: true}; }

    // getElementsBy* — jQuery / older libs probe for these directly.
    getElementsByTagName(tag)   { return __dom(this.__h, 'getElementsByTagName',   [String(tag)]).map(wrap); }
    getElementsByClassName(cls) { return __dom(this.__h, 'getElementsByClassName', [String(cls)]).map(wrap); }
    getElementsByName(name)     { return __dom(this.__h, 'getElementsByName',      [String(name)]).map(wrap); }

    cloneNode(deep) {
      const cloned = wrap(__dom(this.__h, 'cloneNode', [!!deep]));
      // Preserve fragment-view semantics across clone — `templateContent`
      // does `template.content.cloneNode(true)` and then appends the
      // result, expecting the children (not a wrapping template) to
      // land in the target.
      if (cloned && this.__isContent) {
        const view = Object.create(Element.prototype);
        Object.defineProperty(view, '__h', {value: cloned.__h});
        Object.defineProperty(view, '__isContent', {value: true});
        return view;
      }
      return cloned;
    }
    compareDocumentPosition(o)   { return __dom(this.__h, 'compareDocumentPosition', [o && o.__h]); }
    isEqualNode(o)               { return !!__dom(this.__h, 'isEqualNode', [o && o.__h]); }
    isSameNode(o)                { return o != null && this.__h === o.__h; }

    // Mutation: replace `this` with one or more nodes via the parent.
    // Strings get text-node-coerced to match the spec.
    replaceWith(...nodes) {
      const parent = this.parentNode;
      if (!parent) return;
      for (const n of nodes) {
        const node = (n && n.__h != null) ? n : globalThis.document.createTextNode(String(n));
        parent.insertBefore(node, this);
      }
      parent.removeChild(this);
    }
    // Append-self family — required by libraries that move elements
    // into document.head (PageRenderer.copyNewHeadStylesheetElements).
    before(...nodes) {
      const parent = this.parentNode;
      if (!parent) return;
      for (const n of nodes) {
        const node = (n && n.__h != null) ? n : globalThis.document.createTextNode(String(n));
        parent.insertBefore(node, this);
      }
    }
    after(...nodes) {
      const parent = this.parentNode;
      if (!parent) return;
      const ref = this.nextSibling;
      for (const n of nodes) {
        const node = (n && n.__h != null) ? n : globalThis.document.createTextNode(String(n));
        if (ref) parent.insertBefore(node, ref); else parent.appendChild(node);
      }
    }
    remove() {
      const parent = this.parentNode;
      if (parent) parent.removeChild(this);
    }
    append(...nodes) {
      for (const n of nodes) {
        const node = (n && n.__h != null) ? n : globalThis.document.createTextNode(String(n));
        this.appendChild(node);
      }
    }
    prepend(...nodes) {
      const ref = this.firstChild;
      for (const n of nodes) {
        const node = (n && n.__h != null) ? n : globalThis.document.createTextNode(String(n));
        if (ref) this.insertBefore(node, ref); else this.appendChild(node);
      }
    }

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
    event.currentTarget = el;
    // Inline `on<type>` HTML attribute — only fires in the bubble phase
    // at non-capture, matches what real browsers do for `onclick="..."`.
    if (atTarget || !capture) invokeInlineHandler(el, event);
    const byType = __listeners.get(el.__h);
    if (!byType) return;
    const arr = byType.get(event.type);
    if (!arr || arr.length === 0) return;
    // Snapshot — handlers may add/remove during dispatch.
    const snapshot = arr.slice();
    for (const l of snapshot) {
      if (event._immediate) break;
      if (!atTarget && l.capture !== capture) continue;
      callListener(l.handler, el, event);
      if (l.once) {
        const i = arr.indexOf(l);
        if (i >= 0) {
          arr.splice(i, 1);
          bumpListenerCount(event.type, -1);
        }
      }
    }
  }

  // EventListenerObject support: the spec accepts either a function
  // or `{handleEvent(event)}` (Stimulus's Action class uses the latter).
  // Browsers swallow listener errors so dispatch continues — match that.
  function callListener(handler, thisArg, event) {
    try {
      if (typeof handler === 'function') {
        handler.call(thisArg, event);
      } else if (handler && typeof handler.handleEvent === 'function') {
        handler.handleEvent(event);
      }
    } catch (e) {
      try { console.error('listener threw:', e && e.message ? e.message : e); } catch (_) {}
    }
  }

  // Compile-once cache for inline handler bodies — same attribute text
  // hits the same Function across dispatches. Intentionally NOT cleared
  // in __resetPage: the key is the body string (handle-independent) and
  // the same `onclick="..."` recurs across pages, so surviving the reset
  // is a real win.
  const __inlineCache = new Map();
  function invokeInlineHandler(el, event) {
    const body = el.getAttribute('on' + event.type);
    if (body == null || body === '') return;
    let fn = __inlineCache.get(body);
    if (!fn) {
      try { fn = new Function('event', body); } catch (_) { __inlineCache.set(body, false); return; }
      __inlineCache.set(body, fn);
    }
    if (fn === false) return;
    try {
      const ret = fn.call(el, event);
      if (ret === false) event.preventDefault();
    } catch (e) {
      try { console.error('inline handler threw:', e && e.message ? e.message : e); } catch (_) {}
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
      // After document, the bubble continues to the window — Turbo's
      // StreamObserver listens for `turbo:before-fetch-response` here
      // and `event.preventDefault()`s to short-circuit the normal
      // form-submission flow before it errors on a 200-without-redirect.
      if (!event._stopped) invokeWindowListeners(event);
    }
    event.eventPhase = 0;
    return !event.defaultPrevented;
  }

  function invokeWindowListeners(event) {
    const arr = __windowListeners.get(event.type);
    if (!arr) return;
    event.currentTarget = globalThis;
    for (const h of arr.slice()) {
      if (event._immediate) break;
      callListener(h, globalThis, event);
    }
  }

  // Called from Ruby (`browser.dispatch_event`). Returns true if no
  // listener prevented the default action — Ruby uses that to decide
  // whether to navigate, submit, etc.
  globalThis.__dispatchFromRuby = function (handle, type, init) {
    return __dispatch(wrap(handle), new Event(type, init));
  };
  // Send a keyboard event with the right shape for the page-level
  // listeners that read e.keyCode / e.which (legacy but still common).
  globalThis.__dispatchKeyFromRuby = function (handle, type, keyCode) {
    return __dispatch(wrap(handle), new KeyboardEvent(type, {
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
    const target = wrap(handle);
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
    for (const h of arr.slice()) callListener(h, globalThis, event);
    return !event.defaultPrevented;
  };


  // ── evaluate_script ──────────────────────────────────────────
  // Capybara's `evaluate_script(code, *args)` wraps `code` in a
  // `return (<code>)` function so an expression's value flows back.
  // Element args / returns travel as {__elementHandle: N} sidecars so
  // they round-trip through JSON on both bridge directions.
  function rehydrateArg(a) {
    if (a == null || typeof a !== 'object') return a;
    if (a.__elementHandle != null) return wrap(a.__elementHandle);
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
  // Compile-once cache — Capybara's matchers re-issue the same
  // evaluate_script bodies across polling iterations and across tests
  // (e.g. `this.validity.valid`), and `new Function(body)` allocates a
  // fresh compiled function each call. Repeated parsing under polling
  // pressure was tripping QuickJS's parser stack on long suites.
  const __evalCache = new Map();
  function compileScript(code) {
    let fn = __evalCache.get(code);
    if (!fn) {
      fn = new Function('return eval(' + JSON.stringify(code) + ');');
      __evalCache.set(code, fn);
    }
    return fn;
  }
  globalThis.__evalScript = function (code, args) {
    const a = (args || []).map(rehydrateArg);
    // `eval` inside the function body sees the function's `arguments`,
    // so user code referencing `arguments[i]` works the same as in
    // selenium / chrome. eval also handles statements / expressions
    // uniformly — selenium's "return <expr>" wrapping can't.
    return marshalResult(compileScript(code).apply(null, a));
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
    compileScript(code).apply(null, a);
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
      // Step the clock to the timer's due time so timers it schedules
      // anchor on the right moment.
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
    // Pin the clock at `limit` even when nothing fired, so a later
    // __drainTimers(N) reflects cumulative elapsed time and any
    // setTimeout queued *after* this call anchors on the new "now".
    if (__virtualNow < limit) __virtualNow = limit;
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

  // Handle integers get reassigned across documents, so listeners /
  // observers / CE instances keyed on those handles would silently fire
  // against the wrong nodes after a navigate. `__wrappers` is also
  // dropped — `ceUpgrade` rewrites a wrapper's [[Prototype]] to the CE
  // class, and that prototype chain mustn't outlive the page.
  globalThis.__resetPage = function () {
    __listeners.clear();
    __windowListeners.clear();
    __styleFacades.clear();
    for (const t of __listenerCounts.keys()) __setListenedType(t, false);
    __listenerCounts.clear();
    // Custom-element registrations are SET globally by Turbo's ESM
    // bundle, which loads once via vm.import and never re-runs across
    // navigations. Clearing __ceDefs would orphan the registry — new
    // pages' <turbo-frame> elements would never upgrade. We keep the
    // registry but drop all per-element instance state and re-arm the
    // mutation observer against the freshly-parsed document.
    __ceInstances.clear();
    __ceWaiters.clear();
    __ceObserver = null;
    // Snapshot observers BEFORE wiping __wrappers — their _observed
    // entries reference the old wrappers, which we'll re-resolve below.
    const stashedObservers = Array.from(__observers);
    __observers.clear();
    __wrappers.clear();
    // Re-pin the document wrapper so globalThis.document keeps its
    // decorations (location proxy, defaultView, readyState, etc.).
    __wrappers.set(0, globalThis.document);
    globalThis.document.readyState = 'loading';
    __resetTimers();
    // Re-attach the CE observer + upgrade existing matches in the
    // freshly-parsed document.
    if (__ceDefs.size > 0) {
      ceEnsureObserver();
      for (const [tag] of __ceDefs) {
        for (const el of document.querySelectorAll(tag)) ceUpgrade(el);
      }
    }
    rebindObservers(stashedObservers);
  };

  // Re-bind observers whose targets were tagged as document anchors
  // (document/documentElement/body/head) to the fresh wrappers, drop
  // entries we can't resolve, then emit a synthetic childList record
  // so each observer does an initial scan of the new tree (matching
  // the moment the page's body was parsed). Stimulus's BindingObserver
  // and ResizeObserver-style watchers rely on this to discover
  // `data-controller` / `data-action` attributes on every page.
  function rebindObservers(observers) {
    const initialScans = [];
    for (const obs of observers) {
      const fresh = [];
      for (const o of obs._observed) {
        const target = o.logicalRef ? resolveLogicalAnchor(o.logicalRef) : null;
        if (!target) continue;
        const entry = {target, options: o.options, logicalRef: o.logicalRef};
        fresh.push(entry);
        if (entry.options.childList) initialScans.push({obs, entry});
      }
      obs._observed = fresh;
      obs._records  = [];
      obs._scheduled = false;
      if (fresh.length > 0) __observers.add(obs);
    }
    __notifyMutationActive(__observers.size > 0);
    for (const {obs, entry} of initialScans) emitInitialScan(obs, entry);
  }

  function emitInitialScan(obs, entry) {
    const kids = entry.target.children ? Array.from(entry.target.children) : [];
    if (kids.length === 0) return;
    obs._records.push({
      type:           'childList',
      target:         entry.target,
      addedNodes:     kids,
      removedNodes:   [],
      attributeName:  null,
      previousSibling:null,
      nextSibling:    null
    });
    if (obs._scheduled) return;
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

  function logicalAnchorOf(target) {
    if (!target) return null;
    if (target === globalThis.document) return 'document';
    if (target === globalThis.document.documentElement) return 'documentElement';
    if (target === globalThis.document.body) return 'body';
    if (target === globalThis.document.head) return 'head';
    return null;
  }

  function resolveLogicalAnchor(ref) {
    switch (ref) {
      case 'document':        return globalThis.document;
      case 'documentElement': return globalThis.document.documentElement;
      case 'body':            return globalThis.document.body;
      case 'head':            return globalThis.document.head;
      default:                return null;
    }
  }

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
      // Tag known document anchors so __resetPage can re-bind the
      // observer to the freshly-parsed document. Stimulus's
      // BindingObserver runs once at Application.start() against
      // documentElement and never re-attaches across full-page
      // navigations — without this hint we'd lose all controllers
      // after the first nav.
      this._observed.push({target, options: options || {}, logicalRef: logicalAnchorOf(target)});
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
  // The HTML* hierarchy is alias-mapped to Element since we don't model
  // an HTML/SVG/MathML split; libraries do `class Foo extends
  // HTMLFormElement` or `obj instanceof HTMLInputElement` against these.
  globalThis.HTMLElement         = Element;
  globalThis.HTMLBodyElement     = Element;
  globalThis.HTMLHeadElement     = Element;
  globalThis.HTMLHtmlElement     = Element;
  globalThis.HTMLAnchorElement   = Element;
  globalThis.HTMLAreaElement     = Element;
  globalThis.HTMLButtonElement   = Element;
  globalThis.HTMLCanvasElement   = Element;
  globalThis.HTMLDialogElement   = Element;
  globalThis.HTMLDivElement      = Element;
  globalThis.HTMLDocument        = Element;
  globalThis.HTMLFormElement     = Element;
  globalThis.HTMLIFrameElement   = Element;
  globalThis.HTMLImageElement    = Element;
  globalThis.HTMLInputElement    = Element;
  globalThis.HTMLLabelElement    = Element;
  globalThis.HTMLLinkElement     = Element;
  globalThis.HTMLMetaElement     = Element;
  globalThis.HTMLOptionElement   = Element;
  globalThis.HTMLScriptElement   = Element;
  globalThis.HTMLSelectElement   = Element;
  globalThis.HTMLSpanElement     = Element;
  globalThis.HTMLStyleElement    = Element;
  globalThis.HTMLTableElement    = Element;
  globalThis.HTMLTemplateElement = Element;
  globalThis.HTMLTextAreaElement = Element;
  globalThis.HTMLUListElement    = Element;
  globalThis.SVGElement          = Element;
  globalThis.Document            = Element;
  globalThis.DocumentFragment    = Element;
  globalThis.ShadowRoot          = Element;
  globalThis.Node                = Element;
  // DOM Node type / compareDocumentPosition bitmask values. Stimulus's
  // ElementObserver gates its mutation-record processing on
  // `node.nodeType == Node.ELEMENT_NODE` — without these constants set,
  // every childList mutation silently bails. Sizzle / jQuery probe the
  // DOCUMENT_POSITION_* values too.
  Node.ELEMENT_NODE                  = 1;
  Node.ATTRIBUTE_NODE                = 2;
  Node.TEXT_NODE                     = 3;
  Node.CDATA_SECTION_NODE            = 4;
  Node.PROCESSING_INSTRUCTION_NODE   = 7;
  Node.COMMENT_NODE                  = 8;
  Node.DOCUMENT_NODE                 = 9;
  Node.DOCUMENT_TYPE_NODE            = 10;
  Node.DOCUMENT_FRAGMENT_NODE        = 11;
  Node.DOCUMENT_POSITION_DISCONNECTED            = 1;
  Node.DOCUMENT_POSITION_PRECEDING               = 2;
  Node.DOCUMENT_POSITION_FOLLOWING               = 4;
  Node.DOCUMENT_POSITION_CONTAINS                = 8;
  Node.DOCUMENT_POSITION_CONTAINED_BY            = 16;
  Node.DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC = 32;
  globalThis.document = wrap(0);

  // Body / head / documentElement are live getters: in real browsers
  // they re-resolve to whatever currently occupies the slot, even
  // after Turbo's `document.body.replaceWith(newBody)` swaps the
  // body element.
  Object.defineProperty(globalThis.document, 'body', {
    configurable: true,
    get() { return this.querySelector('body'); }
  });
  Object.defineProperty(globalThis.document, 'head', {
    configurable: true,
    get() { return this.querySelector('head'); }
  });
  Object.defineProperty(globalThis.document, 'documentElement', {
    configurable: true,
    get() { return this.querySelector('html'); }
  });
  // adoptNode / importNode are pass-through — Nokogiri's
  // insertBefore / replaceChild already span documents transparently.
  globalThis.document.adoptNode   = function (node) { return node; };
  globalThis.document.importNode  = function (node, _deep) { return node; };
  globalThis.document.contains    = function (other) {
    return !!(other && other.__h != null && __dom(0, 'contains', [other.__h]));
  };
  globalThis.document.createEvent = function (_type) {
    return new Event('', {bubbles: false, cancelable: false});
  };
  // Range: minimal shim. Turbo's FrameRenderer uses
  // selectNodeContents + deleteContents + extractContents to swap
  // frame bodies, which is the only flow we model — no offsets, no
  // partial-text selection, no boundary-point semantics.
  class Range {
    constructor() { this._node = null; }
    selectNodeContents(node)   { this._node = node; }
    selectNode(node)           { this._node = node && node.parentNode; }
    setStart()                 {}
    setEnd()                   {}
    collapse()                 {}
    deleteContents() {
      if (!this._node) return;
      const children = this._node.childNodes;
      for (const c of Array.from(children)) this._node.removeChild(c);
    }
    extractContents() {
      const frag = document.createDocumentFragment();
      if (!this._node) return frag;
      const children = Array.from(this._node.childNodes);
      for (const c of children) {
        this._node.removeChild(c);
        frag.appendChild(c);
      }
      return frag;
    }
    cloneContents() {
      const frag = document.createDocumentFragment();
      if (!this._node) return frag;
      for (const c of this._node.childNodes) frag.appendChild(c.cloneNode(true));
      return frag;
    }
    cloneRange()   { const r = new Range; r._node = this._node; return r; }
    detach()       {}
  }
  globalThis.Range = Range;
  globalThis.document.createRange = function () { return new Range; };
  // CSS.escape — Turbo's extractForeignFrameElement passes the frame
  // id through it before constructing a `turbo-frame#<id>` selector.
  globalThis.CSS = {
    escape(str) {
      return String(str).replace(/[^A-Za-z0-9_-]/g, c => '\\' + c);
    }
  };
  globalThis.document.readyState  = 'loading';
  globalThis.document.compatMode  = 'CSS1Compat';
  // location.{href,pathname,hash,search} assignments navigate.
  // Backed by a real URL (POLYFILL_URL); writes synthesise the new
  // href via URL's component setters and hand it to Ruby.
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
  globalThis.navigator  = {userAgent: 'capybara-simulated', language: 'en-US', languages: ['en-US']};
  globalThis.screen     = {width: 1024, height: 768};
  // history.pushState / replaceState route to Ruby so this driver's
  // current_url tracks SPA-style URL changes. State + title are
  // accepted but ignored — we only mirror the URL.
  globalThis.history = {
    length: 0,
    state: null,
    scrollRestoration: 'auto',
    pushState: function (state, _title, url) {
      this.state = state == null ? null : state;
      if (url == null) return;
      const next = new URL(String(url), __locationUrl.href).href;
      __locationUrl = new URL(next);
      __setCurrentUrl(next);
    },
    replaceState: function (state, _title, url) {
      this.state = state == null ? null : state;
      if (url == null) return;
      const next = new URL(String(url), __locationUrl.href).href;
      __locationUrl = new URL(next);
      __setCurrentUrl(next);
    },
    back:    function () {},
    forward: function () {},
    go:      function () {}
  };
  globalThis.localStorage   = {getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {}, length: 0, key: () => null};
  globalThis.sessionStorage = {getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {}, length: 0, key: () => null};
  globalThis.getComputedStyle = function () { return {getPropertyValue: () => '', length: 0}; };
  globalThis.matchMedia = function () { return {matches: false, addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}}; };

  // Layout-driven observers — libraries probe these via constructor
  // existence (Turbo's FrameController constructs an IntersectionObserver
  // eagerly), so the spec method shape is enough.
  class StubObserver {
    constructor(_cb)         {}
    observe(_target)         {}
    unobserve(_target)       {}
    disconnect()             {}
    takeRecords()            { return []; }
  }
  globalThis.IntersectionObserver = StubObserver;
  globalThis.ResizeObserver       = StubObserver;
  globalThis.PerformanceObserver  = StubObserver;

  // AbortController is shape-only — the fetch shim is synchronous so
  // there's nothing to actually abort, but Turbo / consumers
  // construct one eagerly per request and read .signal off it.
  class AbortSignal {
    constructor() { this.aborted = false; this.reason = undefined; this._cb = []; }
    addEventListener(type, h) { if (type === 'abort') this._cb.push(h); }
    removeEventListener(type, h) {
      if (type !== 'abort') return;
      const i = this._cb.indexOf(h);
      if (i >= 0) this._cb.splice(i, 1);
    }
    dispatchEvent(_ev) { return true; }
    throwIfAborted() { if (this.aborted) throw this.reason || new Error('aborted'); }
  }
  AbortSignal.abort  = (reason) => { const s = new AbortSignal(); s.aborted = true; s.reason = reason; return s; };
  AbortSignal.timeout = (_ms)  => new AbortSignal();
  globalThis.AbortSignal = AbortSignal;
  // Blob / File are stubbed for `instanceof` and constructor-shape
  // checks. Real binary-data round-trips aren't supported (no fetch
  // streaming, no FileReader); test apps that need real file uploads
  // should use Capybara's `attach_file` instead.
  class Blob {
    constructor(parts, opts) {
      const i = opts || {};
      this._parts = parts || [];
      this.size = (parts || []).reduce((s, p) => s + (p && p.length || 0), 0);
      this.type = i.type || '';
    }
    text()        { return Promise.resolve((this._parts || []).join('')); }
    arrayBuffer() { return this.text().then(t => { const b = new ArrayBuffer(t.length); const v = new Uint8Array(b); for (let i = 0; i < t.length; i++) v[i] = t.charCodeAt(i) & 0xff; return b; }); }
    slice()       { return new Blob(this._parts, {type: this.type}); }
  }
  globalThis.Blob = Blob;
  globalThis.File = class File extends Blob {
    constructor(parts, name, opts) {
      super(parts, opts);
      const i = opts || {};
      this.name = String(name);
      this.lastModified = i.lastModified || 0;
    }
  };

  globalThis.AbortController = class AbortController {
    constructor() { this.signal = new AbortSignal(); }
    abort(reason) {
      if (this.signal.aborted) return;
      this.signal.aborted = true;
      this.signal.reason  = reason || new Error('aborted');
      for (const h of this.signal._cb.slice()) {
        try { h.call(this.signal, {type: 'abort'}); } catch (_) {}
      }
    }
  };

  // ── fetch / Headers / Response / DOMParser ──────────────────
  // Synchronous Rack round-trip wrapped in Promise.resolve. There's
  // no real event loop; AbortSignal is honoured at start time only.
  class Headers {
    constructor(init) {
      this._map = new Map();
      if (!init) return;
      if (init instanceof Headers) {
        for (const [k, v] of init._map) this._map.set(k, v.slice());
        return;
      }
      if (Array.isArray(init)) {
        for (const [k, v] of init) this.append(k, v);
        return;
      }
      for (const k of Object.keys(init)) this.append(k, init[k]);
    }
    _key(name)  { return String(name).toLowerCase(); }
    // WHATWG: comma-space joins repeats. Single source of truth so it
    // doesn't drift across get/forEach/entries/values.
    _join(a)    { return a.join(', '); }
    append(name, value) {
      const k = this._key(name);
      const arr = this._map.get(k);
      if (arr) arr.push(String(value));
      else     this._map.set(k, [String(value)]);
    }
    delete(name)      { this._map.delete(this._key(name)); }
    get(name)         { const a = this._map.get(this._key(name)); return a ? this._join(a) : null; }
    has(name)         { return this._map.has(this._key(name)); }
    set(name, value)  { this._map.set(this._key(name), [String(value)]); }
    forEach(cb, thisArg) {
      for (const [k, a] of this._map) cb.call(thisArg, this._join(a), k, this);
    }
    *entries() { for (const [k, a] of this._map) yield [k, this._join(a)]; }
    *keys()    { for (const k of this._map.keys())  yield k; }
    *values()  { for (const [, a] of this._map)     yield this._join(a); }
    [Symbol.iterator]() { return this.entries(); }
  }
  globalThis.Headers = Headers;

  // FormData: minimal shim. `new FormData(formElement)` scrapes the
  // form's submittable controls so Turbo / consumers that POST forms
  // via fetch can serialise them. File inputs surface their handle's
  // file picks (path stubs); reading the body is left to consumers
  // that toString it (urlencoded) or iterate entries (multipart).
  class FormData {
    constructor(form) {
      this._entries = [];
      if (!form) return;
      const fields = form.querySelectorAll('input, select, textarea, button');
      for (const f of fields) {
        const name = f.getAttribute('name');
        if (!name || f.disabled) continue;
        const type = (f.getAttribute('type') || (f.tagName === 'BUTTON' ? 'submit' : '')).toLowerCase();
        if (type === 'submit' || type === 'reset' || type === 'button' || type === 'image') continue;
        if ((type === 'checkbox' || type === 'radio') && !f.checked) continue;
        if (f.tagName === 'SELECT') {
          for (const opt of f.querySelectorAll('option')) {
            if (opt.getAttribute('selected') != null) {
              this.append(name, opt.getAttribute('value') || opt.textContent || '');
            }
          }
          continue;
        }
        if (f.tagName === 'TEXTAREA') {
          this.append(name, f.textContent || '');
          continue;
        }
        this.append(name, f.value == null ? '' : String(f.value));
      }
    }
    append(name, value)  { this._entries.push([String(name), value]); }
    delete(name)         { this._entries = this._entries.filter(e => e[0] !== String(name)); }
    get(name)            { const e = this._entries.find(e => e[0] === String(name)); return e ? e[1] : null; }
    getAll(name)         { return this._entries.filter(e => e[0] === String(name)).map(e => e[1]); }
    has(name)            { return this._entries.some(e => e[0] === String(name)); }
    set(name, value)     { this.delete(name); this.append(name, value); }
    forEach(cb, thisArg) { for (const [k, v] of this._entries) cb.call(thisArg, v, k, this); }
    *entries()           { for (const e of this._entries) yield e.slice(); }
    *keys()              { for (const e of this._entries) yield e[0]; }
    *values()            { for (const e of this._entries) yield e[1]; }
    [Symbol.iterator]()  { return this.entries(); }
    toString() {
      // Default x-www-form-urlencoded serialisation — used by fetch's
      // body-shape handling when a FormData lands as the body.
      const params = new URLSearchParams();
      for (const [k, v] of this._entries) {
        params.append(k, typeof v === 'string' ? v : (v && v.name) || '');
      }
      return params.toString();
    }
  }
  globalThis.FormData = FormData;

  class Response {
    constructor(body, init) {
      const i = init || {};
      this._body       = body == null ? '' : String(body);
      this.status      = i.status != null ? i.status : 200;
      this.statusText  = i.statusText || '';
      this.headers     = i.headers instanceof Headers ? i.headers : new Headers(i.headers);
      this.url         = i.url || '';
      this.redirected  = !!i.redirected;
      this.type        = i.type || 'basic';
      this.ok          = this.status >= 200 && this.status < 300;
      this.bodyUsed    = false;
    }
    _consume() {
      if (this.bodyUsed) {
        return Promise.reject(new TypeError('Already read'));
      }
      this.bodyUsed = true;
      return Promise.resolve(this._body);
    }
    text() { return this._consume(); }
    json() { return this._consume().then(t => JSON.parse(t)); }
    arrayBuffer() {
      return this._consume().then(t => {
        const buf = new ArrayBuffer(t.length);
        const view = new Uint8Array(buf);
        for (let i = 0; i < t.length; i++) view[i] = t.charCodeAt(i) & 0xff;
        return buf;
      });
    }
    blob() {
      return this._consume().then(t => ({
        size: t.length, type: '',
        text: () => Promise.resolve(t),
        arrayBuffer: () => Promise.resolve(t)
      }));
    }
    clone() {
      return new Response(this._body, {
        status:     this.status,
        statusText: this.statusText,
        headers:    new Headers(this.headers),
        url:        this.url,
        redirected: this.redirected,
        type:       this.type
      });
    }
  }
  globalThis.Response = Response;

  class Request {
    constructor(input, init) {
      const i = init || {};
      if (typeof input === 'object' && input != null && 'url' in input) {
        this.url    = input.url;
        this.method = (i.method || input.method || 'GET').toUpperCase();
        this.headers = new Headers(i.headers || input.headers);
        this._body   = i.body != null ? i.body : input._body;
      } else {
        this.url     = String(input);
        this.method  = (i.method || 'GET').toUpperCase();
        this.headers = new Headers(i.headers);
        this._body   = i.body == null ? null : i.body;
      }
      this.credentials = i.credentials || 'same-origin';
      this.mode        = i.mode        || 'cors';
      this.redirect    = i.redirect    || 'follow';
      this.signal      = i.signal      || null;
    }
  }
  globalThis.Request = Request;

  globalThis.fetch = function (input, init) {
    const req = (input instanceof Request) ? input : new Request(input, init || {});
    if (req.signal && req.signal.aborted) {
      return Promise.reject(new Error('aborted'));
    }
    // Headers cross to Ruby as a flat object — duplicate names get
    // joined with comma per HTTP, which matches what `Headers.get` does.
    const hdrs = {};
    for (const [k, v] of req.headers.entries()) hdrs[k] = v;
    let body = req._body;
    // Serialise common body shapes Turbo / Stimulus produce. FormData /
    // URLSearchParams aren't fully shimmed; a `toString()`-able body is
    // enough for x-www-form-urlencoded round-trips.
    if (body != null && typeof body !== 'string') {
      if (body instanceof URLSearchParams) {
        body = body.toString();
        if (!hdrs['content-type']) hdrs['content-type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
      } else if (typeof body.toString === 'function') {
        body = body.toString();
      }
    }
    let raw;
    try {
      raw = __rackFetch(req.method, req.url, body, hdrs, req.redirect);
    } catch (e) {
      return Promise.reject(e);
    }
    if (!raw) return Promise.reject(new TypeError('fetch: no response'));
    const headers = new Headers();
    for (const [k, v] of (raw.headers || [])) headers.append(k, v);
    return Promise.resolve(new Response(raw.body || '', {
      status:     raw.status,
      statusText: '',
      headers:    headers,
      url:        raw.url,
      redirected: raw.redirected,
      type:       raw.type || 'basic'
    }));
  };

  // ── DOMParser ───────────────────────────────────────────────
  // Full HTML5 document parsing happens Ruby-side (Nokogiri::HTML5);
  // the bridge returns handles for documentElement / head / body of
  // the parsed tree. Nodes round-trip through `insertBefore` to land
  // in the live document — Turbo's `document.body.replaceWith(newBody)`
  // therefore actually swaps the live body.
  class ParsedDocument {
    constructor(handles) {
      this.documentElement = wrap(handles.documentElement);
      this.head = wrap(handles.head);
      this.body = wrap(handles.body);
      this._root = this.documentElement || this.body;
    }
    querySelector(s)        { return this._root ? this._root.querySelector(s) : null; }
    querySelectorAll(s)     { return this._root ? this._root.querySelectorAll(s) : []; }
    getElementById(id)      { return this._root ? this._root.getElementById(id) : null; }
    getElementsByTagName(t) { return this._root ? this._root.getElementsByTagName(t) : []; }
  }
  globalThis.DOMParser = class DOMParser {
    parseFromString(input, _type) {
      const handles = __dom(0, 'parseHTML5Document', [String(input == null ? '' : input)]);
      return new ParsedDocument(handles || {});
    }
  };

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

  // Walk an object graph rooted at `root` and replace every direct
  // reference to `tmp` with `el`. Limited depth + WeakSet visited
  // guard keep the cost bounded for delegate / view / observer
  // hierarchies (Turbo's FrameController's depth is ~3).
  function rewriteTmpRefs(root, tmp, el, depth = 4, seen = new WeakSet()) {
    if (depth <= 0 || !root || typeof root !== 'object' || seen.has(root)) return;
    seen.add(root);
    for (const k of Object.getOwnPropertyNames(root)) {
      let v;
      try { v = root[k]; } catch (_) { continue; }
      if (v === tmp) {
        try { root[k] = el; } catch (_) {}
      } else if (v && typeof v === 'object') {
        rewriteTmpRefs(v, tmp, el, depth - 1, seen);
      }
    }
  }

  function ceUpgrade(el) {
    if (!el || el.nodeType !== 1) return;
    if (__ceInstances.has(el.__h)) return;
    const ctor = ceCtorFor(el.tagName);
    if (!ctor) return;
    // Real browsers upgrade in place; we lack the [[Construct]] hook,
    // so we swap the prototype, run the ctor against a throwaway
    // `tmp` (sharing __h so DOM ops target the same node), then copy
    // own props onto the wrapper. Turbo's `class FrameElement` does
    // `this.delegate = new FrameController(this)` in its ctor — the
    // FrameController stashes `this.element = tmp`, so after copy
    // `el.delegate.element === tmp` (NOT `=== el`). FrameController's
    // willSubmitForm then does `form.closest('turbo-frame') === this.element`
    // and the strict-equality check fails (tmp ≠ el). Fix: walk the
    // copied subtree once and rewrite any `tmp` reference to `el`.
    Object.setPrototypeOf(el, ctor.prototype);
    try {
      const tmp = Reflect.construct(ctor, [], ctor);
      try { Object.defineProperty(tmp, '__h', {value: el.__h, writable: false}); } catch (_) {}
      for (const k of Object.getOwnPropertyNames(tmp)) {
        if (k === '__h') continue;
        try {
          Object.defineProperty(el, k, Object.getOwnPropertyDescriptor(tmp, k));
        } catch (_) {}
      }
      rewriteTmpRefs(el, tmp, el);
    } catch (e) {
      try { console.error('CE constructor threw:', e && e.message ? e.message : e); } catch (_) {}
    }
    __ceInstances.set(el.__h, el);
    if (typeof el.connectedCallback === 'function') {
      try { el.connectedCallback.call(el); } catch (e) {
        try { console.error('connectedCallback threw:', e && e.message ? e.message : e); } catch (_) {}
      }
    }
  }

  function ceUpgradeTree(el) {
    if (!el) return;
    ceUpgrade(el);
    // DocumentFragment (11) is opaque to ceUpgrade itself but its
    // children must still be walked — Turbo's FrameRenderer moves new
    // content into the live document via a fragment from
    // Range.extractContents, and the new <turbo-frame> sits inside.
    // Without descending into the fragment its CE never upgrades.
    if (el.nodeType === 1 || el.nodeType === 11) {
      for (const c of el.childNodes) ceUpgradeTree(c);
    }
  }

  function ceDisconnect(el) {
    if (!el || el.nodeType !== 1) return;
    if (!__ceInstances.has(el.__h)) return;
    __ceInstances.delete(el.__h);
    if (typeof el.disconnectedCallback === 'function') {
      try { el.disconnectedCallback.call(el); } catch (e) {
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

  // Wire up wrap()'s lazy CE upgrade — DOMParser / innerHTML produces
  // detached subtrees that the live-document observer never sees, so
  // we upgrade on first wrap() access *if* the element is part of a
  // parsed tree. Skip elements that came from createElement (no
  // parent yet): browsers upgrade those on insertion via the
  // observer, and upgrading too early loses post-creation property
  // assignments like `el.id = 'foo'`.
  __lazyUpgrade = function (el) {
    if (__ceDefs.size === 0) return;
    if (__ceInstances.has(el.__h)) return;
    if (!ceCtorFor(el.tagName)) return;
    if (!el.parentNode) return;
    ceUpgrade(el);
  };
})();
