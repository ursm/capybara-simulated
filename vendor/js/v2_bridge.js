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

  globalThis.Element = Element;
  globalThis.document = new Element(0);

  // Convenience top-level shortcuts.
  globalThis.document.body            = globalThis.document.querySelector('body');
  globalThis.document.head            = globalThis.document.querySelector('head');
  globalThis.document.documentElement = globalThis.document.querySelector('html');
})();
