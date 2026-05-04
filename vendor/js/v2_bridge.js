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
    get innerText()   { return __dom(this.__h, 'innerText',   []); }
    get innerHTML()   { return __dom(this.__h, 'innerHTML',   []); }
    get outerHTML()   { return __dom(this.__h, 'outerHTML',   []); }

    // Attributes
    getAttribute(name)    { return __dom(this.__h, 'getAttribute', [String(name)]); }
    hasAttribute(name)    { return !!__dom(this.__h, 'hasAttribute', [String(name)]); }
    get attributes()      { return __dom(this.__h, 'attributes', []); }

    // Common element shortcuts
    get id()        { return this.getAttribute('id') || ''; }
    get className() { return this.getAttribute('class') || ''; }
    get value()     { return __dom(this.__h, 'value', []); }
    get checked()   { return !!__dom(this.__h, 'checked', []); }
    get disabled()  { return !!__dom(this.__h, 'disabled', []); }
    get hidden()    { return !!__dom(this.__h, 'hidden', []); }

    // <form> ergonomics
    get form() { return wrap(__dom(this.__h, 'form', [])); }
  }

  globalThis.Element = Element;
  globalThis.document = new Element(0);

  // Convenience top-level shortcuts.
  globalThis.document.body            = globalThis.document.querySelector('body');
  globalThis.document.head            = globalThis.document.querySelector('head');
  globalThis.document.documentElement = globalThis.document.querySelector('html');
})();
