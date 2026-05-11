// v3 bridge: DOM lives entirely in V8. No __dom callbacks. Capybara's
// Ruby side dispatches via `Context#call('__csim<Op>', args)` at the
// granularity of Capybara actions (visit / click / find / has_? / …),
// not per DOM op.
//
// PoC milestone 1 surface: just enough to verify a Browser instance
// can `visit` a static-body app and `find('#x').text` round-trips.
// Each milestone adds more.

(function () {
  'use strict';

  // ── Node / Element classes ──────────────────────────────────────
  //
  // Mutable, JS-native, no Ruby roundtrip. Children kept in a plain
  // Array so JIT can specialise. Attributes in a plain object (string
  // keys, string values; same shape browsers expose). `_parent` is a
  // back-pointer for parentNode walks.

  const NODE_ELEMENT = 1;
  const NODE_TEXT    = 3;
  const NODE_DOC     = 9;

  let __nextId = 1;
  // Carry the registered tag through `new SomeCustomElement()` so the
  // Element base ctor can populate `_tag` even when the subclass
  // doesn't call super(tag). Browsers do this via a per-construction
  // queue; the single-threaded JS engine lets us collapse to a slot.
  let __currentTag = null;

  class Node {
    constructor() {
      this._id        = __nextId++;
      this._parent    = null;
      this._children  = [];      // ordered child nodes (Element + Text)
      this._listeners = null;    // type → [{handler, capture}]; lazy
      this.nodeType   = NODE_ELEMENT;
    }
    addEventListener(type, handler, options) {
      if (typeof handler !== 'function') return;
      const capture = !!(options && (options === true || options.capture));
      this._listeners = this._listeners || Object.create(null);
      const list = this._listeners[type] || (this._listeners[type] = []);
      // Per spec, identical {type, handler, capture} is deduped.
      if (list.some(l => l.handler === handler && l.capture === capture)) return;
      list.push({ handler, capture });
    }
    removeEventListener(type, handler, options) {
      if (!this._listeners || !this._listeners[type]) return;
      const capture = !!(options && (options === true || options.capture));
      this._listeners[type] = this._listeners[type].filter(l =>
        !(l.handler === handler && l.capture === capture));
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
    // Focus tracking is a stub: real browsers maintain document.activeElement
    // and dispatch focus/blur events. v3 PoC just records the slot
    // — enough to satisfy test code that calls `el.focus()` before
    // typing. blur(), if anyone calls it, clears the slot.
    focus() { globalThis.document._activeElement = this; }
    blur()  { if (globalThis.document._activeElement === this) globalThis.document._activeElement = null; }

    // Layout stubs — there's no rendering engine, so geometry is
    // always zero. Returning a sensible shape lets feature-detection
    // probes in jQuery / DOM libraries continue instead of throwing
    // "not a function". `getBoundingClientRect()` is the canonical
    // shape; `getClientRects()` returns a DOMRectList (an empty
    // array works for callers that just iterate or check length).
    getBoundingClientRect() {
      return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 };
    }
    getClientRects() { return []; }
    get offsetWidth()  { return 0; }
    get offsetHeight() { return 0; }
    get clientWidth()  { return 0; }
    get clientHeight() { return 0; }
    get scrollWidth()  { return 0; }
    get scrollHeight() { return 0; }
    get offsetTop()    { return 0; }
    get offsetLeft()   { return 0; }
    get offsetParent() { return this._parent && this._parent.nodeType === NODE_ELEMENT ? this._parent : null; }
    scrollIntoView() { /* no-op */ }

    // DOM Node bitmask: DOCUMENT_POSITION_PRECEDING=2,
    // DOCUMENT_POSITION_FOLLOWING=4. Stimulus / Sizzle / various
    // libs use this for document-order sorting.
    compareDocumentPosition(other) {
      if (other === this) return 0;
      const cmp = compareDocOrder(this, other);
      if (cmp < 0) return 4;  // FOLLOWING
      if (cmp > 0) return 2;  // PRECEDING
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
      return copy;
    }
    _cloneShell() {
      // Override in Element / Text.
      return new this.constructor();
    }
    get parentNode()    { return this._parent; }
    get parentElement() { return this._parent && this._parent.nodeType === NODE_ELEMENT ? this._parent : null; }
    get firstChild()    { return this._children[0] || null; }
    get lastChild()     { return this._children[this._children.length - 1] || null; }
    get childNodes()    { return this._children.slice(); }
    get children()      { return this._children.filter(c => c.nodeType === NODE_ELEMENT); }
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
    appendChild(child) {
      // DocumentFragment splice: spec says appendChild(fragment) moves
      // each child of the fragment to the new parent and leaves the
      // fragment empty. The fragment itself is not inserted. Real-DOM
      // libraries (jQuery's `.html(fragment)`, Stimulus's element
      // templating) rely on this — without unwrapping we'd graft a
      // bare DocumentFragment into the tree, breaking ancestor walks
      // and Capybara's visibility / find_xpath paths.
      if (child && child.nodeType === NODE_FRAGMENT) {
        const moved = child._children.slice();
        for (const c of moved) {
          if (c._parent) c._parent.removeChild(c);
          c._parent = this;
          this._children.push(c);
          registerSubtree(c);
          recordChildList(this, [c], []);
          if (isConnected(this)) fireCEConnect(c);
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
      // DocumentFragment splice — same unwrap as appendChild, but
      // inserting before `ref` rather than at the end.
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
      if (wasConnected) { fireCEDisconnect(old); fireCEConnect(neu); }
      return old;
    }
    // textContent collects descendant text; setter replaces children
    // with a single text node.
    get textContent() {
      let s = '';
      for (const c of this._children) {
        s += c.nodeType === NODE_TEXT ? c.data : c.textContent;
      }
      return s;
    }
    set textContent(v) {
      this._children = [];
      const t = new Text(String(v == null ? '' : v));
      t._parent = this;
      this._children.push(t);
    }
  }

  class Text extends Node {
    constructor(data) {
      super();
      this.nodeType = NODE_TEXT;
      this.data     = String(data == null ? '' : data);
    }
    get nodeName()    { return '#text'; }
    _cloneShell()     { return new Text(this.data); }
    get nodeValue()   { return this.data; }
    set nodeValue(v)  { this.data = String(v == null ? '' : v); }
    get textContent() { return this.data; }
    set textContent(v){ this.data = String(v == null ? '' : v); }
    // wgxpath uses these on text nodes via XPath `text()` / `string()`.
    get prefix()       { return null; }
    get namespaceURI() { return null; }
    get localName()    { return null; }
    get ownerDocument(){ return globalThis.document; }
  }

  class Element extends Node {
    constructor(tagName) {
      super();
      // Allow subclasses (custom elements) to call `super()` without
      // a tagName — `__currentTag` carries the registered tag through
      // the `new MyCustomElement()` path from createElement.
      this._tag    = String(tagName || __currentTag || '').toLowerCase();
      this._attrs  = {};   // name(lower) → value(string)
    }
    _cloneShell() {
      const e = new Element(this._tag);
      e._attrs = Object.assign({}, this._attrs);
      return e;
    }
    get tagName()    { return this._tag.toUpperCase(); }
    get nodeName()   { return this.tagName; }
    get nodeValue()  { return null; }
    get localName()  { return this._tag; }
    // XPath 1.0 `*` wildcard matches names in *no* namespace. Reporting
    // the XHTML namespace here would silently mismatch Capybara-emitted
    // `//*` queries. We don't model XML namespaces; null is what
    // Capybara / Selenium effectively see in real-browser HTML mode.
    get prefix()       { return null; }
    get namespaceURI() { return null; }
    get ownerDocument(){ return globalThis.document; }
    getAttribute(name)        { const v = this._attrs[String(name).toLowerCase()]; return v == null ? null : v; }
    setAttribute(name, value) {
      const n = String(name).toLowerCase();
      const old = this._attrs[n];
      this._attrs[n] = String(value);
      recordAttrMutation(this, n, old == null ? null : old);
    }
    removeAttribute(name) {
      const n = String(name).toLowerCase();
      if (!Object.prototype.hasOwnProperty.call(this._attrs, n)) return;
      const old = this._attrs[n];
      delete this._attrs[n];
      recordAttrMutation(this, n, old == null ? null : old);
    }
    hasAttribute(name)        { return Object.prototype.hasOwnProperty.call(this._attrs, String(name).toLowerCase()); }
    // `attributes` returns a NamedNodeMap-shaped collection — array-
    // indexed + `getNamedItem(name)`. wgxpath iterates via `length` +
    // index access; Capybara's `Element#native.attributes` reads
    // `{name, value}` pairs. We give each item the Attr fields wgxpath
    // touches (`specified`, `namespaceURI`, `prefix`, `localName`,
    // `ownerElement`).
    get attributes() {
      const el    = this;
      const names = Object.keys(this._attrs);
      const list  = names.map(n => makeAttr(el, n));
      // NamedNodeMap supports both numeric (`attributes[0]`) and named
      // (`attributes['id']`) access. The array gives us numeric for
      // free; assign named keys for getNamedItem-equivalent lookups
      // that frameworks (jQuery 1.x, Sizzle) use during feature
      // detection.
      for (const n of names) list[n] = makeAttr(el, n);
      list.getNamedItem = name => {
        const lower = String(name).toLowerCase();
        return Object.prototype.hasOwnProperty.call(el._attrs, lower) ? makeAttr(el, lower) : null;
      };
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
      const all = t === '*' ? this.querySelectorAll('*') : this.querySelectorAll(t);
      return all.filter(n => n !== this);
    }
    getElementsByClassName(cls) {
      const sel = String(cls).split(/\s+/).filter(Boolean).map(c => '.' + c).join('');
      return this.querySelectorAll(sel).filter(n => n !== this);
    }
    getElementsByName(name) {
      const sel = '[name="' + String(name).replace(/"/g, '\\"') + '"]';
      return this.querySelectorAll(sel).filter(n => n !== this);
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
      this.setAttribute('style', String(v == null ? '' : v));
      this._styleProxy = null;
    }

    get id()        { return this._attrs.id || ''; }
    set id(v)       { this.setAttribute('id', String(v)); }
    get className() { return this._attrs['class'] || ''; }
    set className(v){ this.setAttribute('class', String(v)); }
    get classList() {
      const el = this;
      // DOMTokenList — `add` / `remove` are variadic per the spec;
      // libraries lean on that (`el.classList.add('a','b','c')`).
      return {
        contains(c) { return classes(el).includes(c); },
        add(...names) {
          const cs = classes(el);
          for (const n of names) if (!cs.includes(n)) cs.push(n);
          el._attrs['class'] = cs.join(' ');
        },
        remove(...names) {
          const drop = new Set(names);
          el._attrs['class'] = classes(el).filter(x => !drop.has(x)).join(' ');
        },
        toggle(c, force) {
          const cs = classes(el);
          const i = cs.indexOf(c);
          const present = i >= 0;
          if (force === true || (force === undefined && !present)) {
            if (!present) cs.push(c);
          } else {
            if (present) cs.splice(i, 1);
          }
          el._attrs['class'] = cs.join(' ');
          return cs.includes(c);
        }
      };
    }
    // querySelector / matches: PoC supports the small subset Capybara
    // emits internally (tag, #id, .class, [attr=value], descendant
    // combinator). Full CSS3 deferred to a proper port.
    querySelector(sel)        { return findFirst(this, parseSelector(sel)); }
    querySelectorAll(sel)     { return findAll(this, parseSelector(sel)); }
    matches(sel)              { return matchOne(this, parseSelector(sel)); }
    closest(sel) {
      const p = parseSelector(sel);
      let cur = this;
      while (cur && cur.nodeType === NODE_ELEMENT) {
        if (matchOne(cur, p)) return cur;
        cur = cur._parent;
      }
      return null;
    }
    contains(other) {
      let cur = other;
      while (cur) {
        if (cur === this) return true;
        cur = cur._parent;
      }
      return false;
    }
    // Form-control IDL attributes. v2 leans on Nokogiri attribute
    // mirroring; here we expose the same pair-of-attr-and-IDL shape
    // so JS like `input.value = 'x'` / `input.checked = true` works
    // and reads back via `__csimValue` / serialised attrs alike.
    get value()    { return this._attrs.value != null ? this._attrs.value : ''; }
    set value(v)   { this._attrs.value = String(v == null ? '' : v); }
    // HTMLScriptElement / HTMLTitleElement / etc. expose `.text` as
    // an alias for `textContent`. stimulus-rails' `parseImportmapJson`
    // reads `script.text` to get the JSON; without this alias it
    // gets `undefined`.
    get text()     { return this.textContent; }
    set text(v)    { this.textContent = v; }
    get checked()  { return this._attrs.checked != null; }
    set checked(v) { if (v) this._attrs.checked = ''; else delete this._attrs.checked; }
    // Constraint validation API — PoC stubs. We don't actually run
    // the validation algorithm, so `valid` is always true and the
    // message is empty. Frameworks (Stimulus form controllers,
    // Capybara's `:valid` filter) probe these without crashing.
    get validity()          { return { valid: true, valueMissing: false, typeMismatch: false, patternMismatch: false, tooLong: false, tooShort: false, rangeUnderflow: false, rangeOverflow: false, stepMismatch: false, badInput: false, customError: false }; }
    get validationMessage() { return this._validationMessage || ''; }
    get willValidate()      { return false; }
    checkValidity()         { return true; }
    reportValidity()        { return true; }
    setCustomValidity(msg)  { this._validationMessage = String(msg || ''); }

    get innerHTML() { return serializeChildren(this); }
    set innerHTML(html) {
      for (const c of this._children) unregisterSubtree(c);
      this._children = [];
      const frag = parseFragment(String(html == null ? '' : html));
      for (const c of frag) {
        c._parent = this;
        this._children.push(c);
        registerSubtree(c);
      }
    }
    get outerHTML() { return serializeElement(this); }
  }

  // DocumentFragment: a Node-shaped subtree root that's *not* in the
  // document tree. Standard appendChild / removeChild / etc. inherit
  // from Node. nodeType=11 per spec. The unique twist: when a
  // DocumentFragment is appended to a real parent, its children move
  // and the fragment is left empty — Node.appendChild has to detect
  // this and splice. v3 PoC keeps the simple form (a fragment can
  // hold children; users typically iterate `.childNodes` themselves
  // before splicing) so jQuery's "build then splice via firstChild"
  // pattern works.
  const NODE_FRAGMENT = 11;
  class DocumentFragment extends Node {
    constructor() {
      super();
      this.nodeType = NODE_FRAGMENT;
    }
    get nodeName()     { return '#document-fragment'; }
    get ownerDocument(){ return globalThis.document; }
  }
  globalThis.DocumentFragment = DocumentFragment;

  class Document extends Node {
    constructor() {
      super();
      this.nodeType   = NODE_DOC;
      this.readyState = 'complete';
      this.documentElement = null;
    }
    // jQuery's `mc(node)` helper resolves a node back to its window
    // via `doc.defaultView || doc.parentWindow`; without these the
    // offset / scroll path throws "Cannot read properties of
    // undefined (reading 'pageYOffset')".
    get defaultView()   { return globalThis; }
    get parentWindow()  { return globalThis; }
    createElement(tag) {
      const t = String(tag).toLowerCase();
      const ctor = __customElementRegistry.get(t);
      if (ctor) {
        const prev = __currentTag;
        __currentTag = t;
        try { return new ctor(); } finally { __currentTag = prev; }
      }
      return new Element(t);
    }
    createTextNode(data)   { return new Text(data); }
    get body() {
      const html = this.documentElement;
      if (!html) return null;
      for (const c of html._children) {
        if (c._tag === 'body') return c;
      }
      return null;
    }
    get head() {
      const html = this.documentElement;
      if (!html) return null;
      for (const c of html._children) {
        if (c._tag === 'head') return c;
      }
      return null;
    }
    getElementById(id) {
      return findFirst(this.documentElement, parseSelector('#' + String(id)));
    }
    querySelector(sel)    { return this.documentElement ? this.documentElement.querySelector(sel) : null; }
    querySelectorAll(sel) { return this.documentElement ? this.documentElement.querySelectorAll(sel) : []; }
    // wgxpath optimizes `descendant::name` and `descendant::*` against
    // Document-rooted queries via getElementsByTagName. Without these
    // shims the descendant axis returns empty from a Document context.
    getElementsByTagName(tag) {
      return this.documentElement ? this.documentElement.getElementsByTagName(tag) : [];
    }
    getElementsByClassName(cls) {
      return this.documentElement ? this.documentElement.getElementsByClassName(cls) : [];
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
    // `document.implementation.createHTMLDocument(title)` — DOMParser
    // shims and Turbo Drive page-snapshot logic both probe it. We
    // return a fresh Document with a minimal `<html><head><title>X</title>
    // </head><body></body></html>` skeleton; full HTML-spec
    // construction (DOCTYPE / quirks-mode flag) is out of scope.
    get implementation() {
      return {
        createHTMLDocument: (title) => {
          const d = new Document();
          const html = new Element('html');
          const head = new Element('head');
          const body = new Element('body');
          html._children = [head, body];
          head._parent = html; body._parent = html;
          d.documentElement = html;
          html._parent = d;
          d._children = [html];
          if (title != null) {
            const t = new Element('title');
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
    createRange() { return new DocumentOrderRange(); }
  }
  class DocumentOrderRange {
    constructor() {
      this.startContainer = null;
      this.startOffset    = 0;
      this.endContainer   = null;
      this.endOffset      = 0;
    }
    setStart(node, offset)  { this.startContainer = node; this.startOffset = offset | 0; }
    setEnd(node, offset)    { this.endContainer   = node; this.endOffset   = offset | 0; }
    // Real DOM: selectNode sets the range to span the given node
    // *within* its parent. Collapse moves both endpoints to one side.
    // wgxpath only cares that the start container ends up referring to
    // the node we passed.
    selectNode(node) {
      this.startContainer = this.endContainer = node;
      this.startOffset    = this.endOffset    = 0;
    }
    selectNodeContents(node) {
      this.startContainer = this.endContainer = node;
      this.startOffset    = 0;
      this.endOffset      = node._children ? node._children.length : 0;
    }
    collapse(toStart) {
      if (toStart) { this.endContainer = this.startContainer; this.endOffset = this.startOffset; }
      else         { this.startContainer = this.endContainer; this.startOffset = this.endOffset; }
    }
    compareBoundaryPoints(_how, other) {
      return compareDocOrder(this.startContainer, other.startContainer);
    }
  }
  // Range boundary-comparison constants. wgxpath reads them off the
  // range instance via `range.START_TO_END` so they have to live on
  // the prototype (not just the constructor).
  DocumentOrderRange.START_TO_START = 0;
  DocumentOrderRange.START_TO_END   = 1;
  DocumentOrderRange.END_TO_END     = 2;
  DocumentOrderRange.END_TO_START   = 3;
  DocumentOrderRange.prototype.START_TO_START = 0;
  DocumentOrderRange.prototype.START_TO_END   = 1;
  DocumentOrderRange.prototype.END_TO_END     = 2;
  DocumentOrderRange.prototype.END_TO_START   = 3;
  globalThis.Range = DocumentOrderRange;
  function compareDocOrder(a, b) {
    if (a === b) return 0;
    const chainA = ancestorChain(a), chainB = ancestorChain(b);
    let i = 0;
    while (i < chainA.length && i < chainB.length && chainA[i] === chainB[i]) i++;
    if (i === 0) return 0; // disconnected — treat as equal
    const lca = chainA[i - 1];
    // If one node is an ancestor of the other, ancestor comes first.
    if (i === chainA.length) return -1;
    if (i === chainB.length) return  1;
    const idxA = lca._children.indexOf(chainA[i]);
    const idxB = lca._children.indexOf(chainB[i]);
    return idxA < idxB ? -1 : (idxA > idxB ? 1 : 0);
  }
  function ancestorChain(node) {
    const chain = [];
    let cur = node;
    while (cur) { chain.unshift(cur); cur = cur._parent; }
    return chain;
  }

  function classes(el) {
    const cls = el._attrs['class'];
    return cls ? cls.split(/\s+/).filter(Boolean) : [];
  }

  // Lightweight CSSStyleDeclaration proxy backed by `style="..."`.
  // `cssText` is the round-trip serialization; individual property
  // access (e.g. `style.display = 'none'`) parses / rebuilds the
  // declaration string in place. jQuery 1.x sets `style.cssText`
  // during feature detection, so the proxy has to at least support
  // round-trip without throwing.
  function makeStyleProxy(el) {
    // A Proxy that intercepts both camelCase IDL property access
    // (`style.backgroundColor`) and kebab-case (`style['background-color']`).
    // Reads parse the `style="..."` attribute; writes update it.
    // Frameworks that probe arbitrary CSS properties (jQuery UI's
    // `p.style.backgroundColor.indexOf("rgba")`) now get a string
    // back instead of `undefined`.
    const target = function () {}; // dummy callable for compatibility
    const handler = {
      get(_t, prop) {
        if (prop === 'cssText') return el._attrs.style || '';
        if (prop === 'getPropertyValue') return name => readCssProp(el, String(name));
        if (prop === 'setProperty')      return (n, v) => writeCssProp(el, String(n), String(v));
        if (prop === 'removeProperty')   return name => removeCssProp(el, String(name));
        if (prop === 'length') return Object.keys(parseStyleDecls(el._attrs.style || '')).length;
        if (typeof prop !== 'string') return undefined;
        // camelCase → kebab-case lookup
        return readCssProp(el, camelToKebab(prop));
      },
      set(_t, prop, value) {
        if (prop === 'cssText') {
          el.setAttribute('style', String(value == null ? '' : value));
          return true;
        }
        if (typeof prop === 'string') {
          writeCssProp(el, camelToKebab(prop), String(value));
        }
        return true;
      },
      has(_t, prop) {
        if (prop === 'cssText' || prop === 'getPropertyValue' ||
            prop === 'setProperty' || prop === 'removeProperty' || prop === 'length') return true;
        return readCssProp(el, camelToKebab(String(prop))) !== '';
      }
    };
    return new Proxy(target, handler);
  }
  function camelToKebab(name) {
    return name.replace(/[A-Z]/g, m => '-' + m.toLowerCase());
  }
  function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function readCssProp(el, name) {
    const css = el._attrs.style || '';
    const re = new RegExp('(?:^|;)\\s*' + escapeRe(name) + '\\s*:\\s*([^;]+)', 'i');
    const m = re.exec(css);
    return m ? m[1].trim() : '';
  }
  function writeCssProp(el, name, value) {
    const css = (el._attrs.style || '').replace(new RegExp('(?:^|;)\\s*' + escapeRe(name) + '\\s*:[^;]*;?', 'i'), '');
    const trimmed = css.replace(/^\s*;|;\s*$/g, '').trim();
    const next = (trimmed ? trimmed + '; ' : '') + name + ': ' + value;
    el.setAttribute('style', next);
  }
  function removeCssProp(el, name) {
    const v = readCssProp(el, name);
    const css = (el._attrs.style || '').replace(new RegExp('(?:^|;)\\s*' + escapeRe(name) + '\\s*:[^;]*;?', 'i'), '');
    el.setAttribute('style', css.replace(/^\s*;|;\s*$/g, '').trim());
    return v;
  }
  function parseStyleDecls(css) {
    const out = {};
    for (const decl of css.split(';')) {
      const i = decl.indexOf(':');
      if (i < 0) continue;
      const name = decl.slice(0, i).trim();
      const val  = decl.slice(i + 1).trim();
      if (name) out[name] = val;
    }
    return out;
  }

  // Build an Attr-shaped object on demand. Returned from `attributes`
  // / `getAttributeNode`. wgxpath reads `specified`, `value`,
  // `nodeName`, `name`, `namespaceURI`, `prefix`, `localName`,
  // `ownerElement`.
  function makeAttr(el, name) {
    return {
      name,
      nodeName: name,
      value:    el._attrs[name],
      nodeValue: el._attrs[name],
      specified: true,
      namespaceURI: null,
      prefix:    null,
      localName: name,
      ownerElement: el,
      ownerDocument: globalThis.document,
      // wgxpath calls `node.ownerDocument.createRange()` for
      // document-order comparison. Real DOM gives every node a
      // valid ownerDocument; we have to thread it through Attr
      // shims explicitly since they're plain objects.
      parentNode: null,
      nodeType:  2  // ATTRIBUTE_NODE
    };
  }

  // ── Event class + dispatch walk ─────────────────────────────────
  //
  // Capture / target / bubble per DOM4. PoC ignores listener `once` /
  // `passive` and event-subclass IDL (KeyboardEvent / MouseEvent /
  // InputEvent specifics) — enough to drive smoke-spec scenarios; v2's
  // bridge.js has the full set when we need parity.

  class Event {
    constructor(type, init) {
      init = init || {};
      this.type             = String(type);
      this.bubbles          = !!init.bubbles;
      this.cancelable       = !!init.cancelable;
      this.composed         = !!init.composed;
      this.defaultPrevented = false;
      this.target           = null;
      this.currentTarget    = null;
      this.eventPhase       = 0;
      this._propagationStopped       = false;
      this._immediatePropagationStopped = false;
    }
    preventDefault() { if (this.cancelable) this.defaultPrevented = true; }
    stopPropagation() { this._propagationStopped = true; }
    stopImmediatePropagation() { this._propagationStopped = true; this._immediatePropagationStopped = true; }
  }
  globalThis.Event = Event;
  globalThis.CustomEvent = class CustomEvent extends Event {
    constructor(type, init) {
      super(type, init);
      this.detail = init && init.detail !== undefined ? init.detail : null;
    }
  };
  // Subclasses Capybara / framework code commonly checks for; for now
  // they're just `Event`-shaped with extra fields.
  globalThis.MouseEvent      = class extends Event {};
  globalThis.KeyboardEvent   = class extends Event {};
  globalThis.InputEvent      = class extends Event {};
  globalThis.SubmitEvent     = class extends Event {
    constructor(type, init) { super(type, init); this.submitter = init && init.submitter || null; }
  };

  // Each event dispatch is one "task". MutationObserver records that
  // queue *during* the task deliver as a microtask at the end of the
  // task — matching spec timing closely enough for tests that look at
  // `addedNodes` / attribute changes from a click handler.
  function dispatchEvent(target, event) {
    event.target = target;
    const path = [];
    let cur = target;
    while (cur) { path.push(cur); cur = cur._parent; }
    try {
      // capture: root → target's parent
      event.eventPhase = 1;
      for (let i = path.length - 1; i > 0; i--) {
        fireListeners(path[i], event, true);
        if (event._propagationStopped) return !event.defaultPrevented;
      }
      // target
      event.eventPhase = 2;
      fireListeners(target, event, false);
      fireListeners(target, event, true);
      if (event._propagationStopped || !event.bubbles) return !event.defaultPrevented;
      // bubble: target's parent → root
      event.eventPhase = 3;
      for (let i = 1; i < path.length; i++) {
        fireListeners(path[i], event, false);
        if (event._propagationStopped) return !event.defaultPrevented;
      }
      return !event.defaultPrevented;
    } finally {
      if (__observers.size && __pendingRecords.length) deliverMutations();
    }
  }
  function fireListeners(node, event, capture) {
    const list = node._listeners && node._listeners[event.type];
    if (!list || !list.length) return;
    event.currentTarget = node;
    for (const entry of list.slice()) {
      if (entry.capture !== capture) continue;
      if (event._immediatePropagationStopped) return;
      try { entry.handler.call(node, event); } catch (e) {
        try { console.error('[csim v3] listener threw:', e && e.message); } catch (_) {}
      }
    }
  }
  globalThis.__csimDispatchEvent = function (h, type, init) {
    const n = lookup(h);
    if (!n) return false;
    return dispatchEvent(n, new Event(String(type), init || {}));
  };

  // ── Modal dialogs ───────────────────────────────────────────────
  //
  // window.alert / confirm / prompt route through `__modalDialog`
  // (Ruby host fn). The Ruby side checks the active accept_modal /
  // dismiss_modal handler stack and returns whatever the handler
  // produced — true/false for confirm, the response string for
  // prompt, null for alert.

  globalThis.alert   = function (message) {
    __modalDialog('alert', String(message == null ? '' : message), null);
  };
  globalThis.confirm = function (message) {
    return !!__modalDialog('confirm', String(message == null ? '' : message), null);
  };
  globalThis.prompt  = function (message, def) {
    return __modalDialog('prompt', String(message == null ? '' : message),
                         def == null ? '' : String(def));
  };

  // ── MutationObserver ────────────────────────────────────────────
  //
  // Records are queued globally on every attribute / childList
  // mutation. At delivery time each observer filters by its observed
  // targets' current containment of the record's target — this is
  // what makes "set id on detached, then appendChild" deliver both
  // records (matching v2's behaviour and what real browsers do for
  // this pattern).

  const __observers = new Set();
  const __pendingRecords = [];

  function recordAttrMutation(target, name, oldValue) {
    if (__observers.size === 0) return;
    __pendingRecords.push({
      type:           'attributes',
      target,
      attributeName:  name,
      attributeNamespace: null,
      oldValue,
      addedNodes:    [],
      removedNodes:  [],
      previousSibling: null,
      nextSibling:    null
    });
  }
  function recordChildList(target, added, removed) {
    if (__observers.size === 0) return;
    __pendingRecords.push({
      type:           'childList',
      target,
      addedNodes:    added.slice(),
      removedNodes:  removed.slice(),
      attributeName: null,
      attributeNamespace: null,
      oldValue:      null,
      previousSibling: null,
      nextSibling:    null
    });
  }

  function recordMatches(entry, rec) {
    const opts = entry.options;
    if (rec.type === 'childList' && !opts.childList) return false;
    if (rec.type === 'attributes' &&
        !opts.attributes && !opts.attributeFilter) return false;
    if (rec.type === 'characterData' && !opts.characterData) return false;
    if (rec.type === 'attributes' && opts.attributeFilter &&
        opts.attributeFilter.indexOf(rec.attributeName) === -1) return false;
    if (rec.target === entry.target) return true;
    if (!opts.subtree) return false;
    // contains() walks up rec.target's ancestors.
    let cur = rec.target;
    while (cur) { if (cur === entry.target) return true; cur = cur._parent; }
    return false;
  }

  class MutationObserver {
    constructor(callback) {
      this._cb = callback;
      this._observed = [];
      this._records  = [];
    }
    observe(target, options) {
      if (!target) return;
      // Spec: attributeOldValue / characterDataOldValue imply
      // attributes / characterData respectively.
      const opts = Object.assign({}, options || {});
      if (opts.attributeOldValue) opts.attributes = true;
      if (opts.characterDataOldValue) opts.characterData = true;
      this._observed.push({ target, options: opts });
      __observers.add(this);
    }
    disconnect() {
      this._observed = [];
      this._records  = [];
      __observers.delete(this);
    }
    takeRecords() {
      const out = this._records;
      this._records = [];
      return out;
    }
  }
  globalThis.MutationObserver = MutationObserver;

  // Drain pending records into each observer's batch, then fire
  // each observer's callback with its batch. Looped (bounded) so a
  // mutation inside a callback re-delivers, mirroring spec microtask
  // semantics.
  function deliverMutations() {
    let iter = 0;
    while (__pendingRecords.length && iter++ < 16) {
      const batch = __pendingRecords.splice(0, __pendingRecords.length);
      for (const obs of __observers) {
        const mine = [];
        for (const rec of batch) {
          for (const entry of obs._observed) {
            if (recordMatches(entry, rec)) { mine.push(rec); break; }
          }
        }
        if (mine.length) {
          try { obs._cb(mine, obs); }
          catch (e) {
            try { console.error('[csim v3] MO callback threw:', e && e.message); } catch (_) {}
          }
        }
      }
    }
  }
  globalThis.__deliverMutations = deliverMutations;

  // ── Custom elements ─────────────────────────────────────────────
  //
  // `HTMLElement` is just an alias for our `Element`; user classes do
  // `class MyThing extends HTMLElement`. `customElements.define(tag,
  // ctor)` registers the constructor and upgrades any pre-existing
  // elements with that tag (prototype swap + connectedCallback if
  // they're in the document). `connectedCallback` /
  // `disconnectedCallback` fire when nodes attach to / detach from
  // the document — handled inside `appendChild` / `insertBefore` /
  // `removeChild`.

  globalThis.HTMLElement = Element;
  const __customElementRegistry = new Map(); // tag → ctor

  globalThis.customElements = {
    define(tag, ctor) {
      const t = String(tag).toLowerCase();
      if (__customElementRegistry.has(t)) return;
      __customElementRegistry.set(t, ctor);
      // Upgrade existing matching elements in the document.
      const doc = globalThis.document;
      if (!doc || !doc.documentElement) return;
      const matches = doc.documentElement.querySelectorAll(t);
      for (const el of matches) {
        upgradeElement(el, ctor);
        if (isConnected(el)) fireCEHook(el, 'connectedCallback');
      }
    },
    get(tag) { return __customElementRegistry.get(String(tag).toLowerCase()) || undefined; },
    whenDefined(tag) {
      const ctor = this.get(tag);
      return ctor ? Promise.resolve(ctor) : Promise.resolve();
    },
    upgrade(_node) { /* no-op stub */ }
  };

  function upgradeElement(el, ctor) {
    // Prototype-swap into the user's class so methods + hooks are
    // visible. Skips running user constructor again — close enough for
    // the smoke spec; full spec runs the ctor with `customElements
    // upgrade` semantics.
    try { Object.setPrototypeOf(el, ctor.prototype); } catch (_) {}
  }
  function fireCEHook(el, hookName) {
    try {
      const fn = el[hookName];
      if (typeof fn === 'function') fn.call(el);
    } catch (e) {
      try { console.error('[csim v3] custom element ' + hookName + ' threw:', e && e.message); } catch (_) {}
    }
  }
  function isConnected(node) {
    let cur = node;
    while (cur) { if (cur.nodeType === NODE_DOC) return true; cur = cur._parent; }
    return false;
  }
  function walkSubtree(node, fn) {
    if (!node) return;
    fn(node);
    if (node._children) for (const c of node._children) walkSubtree(c, fn);
  }
  function fireCEConnect(subtree) {
    walkSubtree(subtree, el => {
      if (el.nodeType !== NODE_ELEMENT) return;
      const ctor = __customElementRegistry.get(el._tag);
      if (!ctor) return;
      // Upgrade if this came from HTML parse (still a plain Element).
      if (Object.getPrototypeOf(el) !== ctor.prototype) upgradeElement(el, ctor);
      fireCEHook(el, 'connectedCallback');
    });
  }
  function fireCEDisconnect(subtree) {
    walkSubtree(subtree, el => {
      if (el.nodeType !== NODE_ELEMENT) return;
      if (__customElementRegistry.has(el._tag)) fireCEHook(el, 'disconnectedCallback');
    });
  }

  // ── Selector parser (minimal) ───────────────────────────────────
  //
  // Returns an array of "simple selector" units forming a descendant
  // chain. Each unit: { tag?, id?, classes?, attrs? }. No combinators
  // beyond descendant (space). No pseudo-classes. Good enough to
  // unblock smoke-spec; replace with a real parser later.

  // A "selector" here is a list of comma-separated chains; each chain
  // is an array of simple-selector units joined by descendant (space).
  // Capybara's compiled CSS uses commas (e.g. 'input,textarea,select')
  // so we split on top-level commas — bracket-balanced so attribute
  // selectors like '[data-x="a,b"]' aren't split mid-value.
  function parseSelector(sel) {
    const out = [];
    for (const chain of splitTopLevel(String(sel).trim(), ',')) {
      const c = chain.trim();
      if (!c) continue;
      // Tokenise around `>` child combinators while keeping descendant
      // (whitespace) combinators implicit. Each unit gets a `combinator`
      // tag (`'descendant'` | `'child'`) that drives `matchChain`'s
      // ancestor-walk vs direct-parent check.
      const raw = c.split(/\s+/);
      const units = [];
      let combinator = 'descendant';
      for (const tok of raw) {
        if (!tok) continue;
        if (tok === '>') { combinator = 'child'; continue; }
        const u = parseSimple(tok);
        u.combinator = combinator;
        units.push(u);
        combinator = 'descendant';
      }
      if (units.length) out.push(units);
    }
    return out;
  }
  function splitTopLevel(s, sep) {
    const parts = [];
    let depth = 0, start = 0;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === '[' || ch === '(') depth++;
      else if (ch === ']' || ch === ')') depth--;
      else if (ch === sep && depth === 0) { parts.push(s.slice(start, i)); start = i + 1; }
    }
    parts.push(s.slice(start));
    return parts;
  }
  function parseSimple(s) {
    const u = { tag: null, id: null, classes: [], attrs: [] };
    let i = 0;
    // tag (or *)
    let m = /^([a-zA-Z][\w-]*|\*)/.exec(s.slice(i));
    if (m) { if (m[1] !== '*') u.tag = m[1].toLowerCase(); i += m[0].length; }
    while (i < s.length) {
      const c = s[i];
      if (c === '#') {
        m = /^#([\w-]+)/.exec(s.slice(i));
        if (!m) break;
        u.id = m[1]; i += m[0].length;
      } else if (c === '.') {
        m = /^\.([\w-]+)/.exec(s.slice(i));
        if (!m) break;
        u.classes.push(m[1]); i += m[0].length;
      } else if (c === '[') {
        m = /^\[([\w-]+)(?:([~|^$*]?=)(?:"([^"]*)"|'([^']*)'|([^\]]+)))?\]/.exec(s.slice(i));
        if (!m) break;
        u.attrs.push({ name: m[1].toLowerCase(), op: m[2] || null, value: m[3] != null ? m[3] : (m[4] != null ? m[4] : (m[5] || '')) });
        i += m[0].length;
      } else {
        break;
      }
    }
    // Anything left unparsed (pseudo-classes, combinators like `>`, …)
    // signals an unsupported selector. Throwing lets callers fall back
    // (jQuery's `.matches` wraps in try/catch and reverts to its own
    // filter engine — without the throw, `:visible` parsed as `{}` and
    // matched every element, breaking jQuery's responsive-menu probe).
    if (i < s.length) throw new SyntaxError('csim v3: unsupported selector segment: ' + s.slice(i));
    return u;
  }
  function matchUnit(el, u) {
    if (el.nodeType !== NODE_ELEMENT) return false;
    if (u.tag && el._tag !== u.tag) return false;
    if (u.id && el._attrs.id !== u.id) return false;
    if (u.classes.length) {
      const cs = classes(el);
      for (const c of u.classes) if (!cs.includes(c)) return false;
    }
    for (const a of u.attrs) {
      const v = el._attrs[a.name];
      if (a.op == null) {
        if (v == null) return false;
      } else if (a.op === '=') {
        if (v !== a.value) return false;
      } else if (a.op === '~=') {
        if (!v) return false;
        if (!v.split(/\s+/).includes(a.value)) return false;
      } else if (a.op === '^=') {
        if (v == null || !v.startsWith(a.value)) return false;
      } else if (a.op === '$=') {
        if (v == null || !v.endsWith(a.value)) return false;
      } else if (a.op === '*=') {
        if (v == null || v.indexOf(a.value) < 0) return false;
      } else if (a.op === '|=') {
        if (v == null) return false;
        if (v !== a.value && !v.startsWith(a.value + '-')) return false;
      }
    }
    return true;
  }
  // Match el against a single chain of units. Each non-first unit's
  // `combinator` says how to bridge from its predecessor: `'descendant'`
  // walks ancestors (any depth); `'child'` only accepts the immediate
  // parent. The combinator stored on a unit refers to the relationship
  // *with the preceding unit*, so we read it from the unit we're about
  // to match.
  function matchChain(el, units) {
    if (!units.length) return false;
    if (!matchUnit(el, units[units.length - 1])) return false;
    let cur = el._parent;
    for (let i = units.length - 2; i >= 0; i--) {
      const next = units[i + 1];
      if (next.combinator === 'child') {
        if (!cur || cur.nodeType !== NODE_ELEMENT || !matchUnit(cur, units[i])) return false;
      } else {
        while (cur && cur.nodeType === NODE_ELEMENT && !matchUnit(cur, units[i])) cur = cur._parent;
        if (!cur || cur.nodeType !== NODE_ELEMENT) return false;
      }
      cur = cur._parent;
    }
    return true;
  }
  // Match against a group (array of chains) — any chain hits ⇒ match.
  function matchOne(el, group) {
    for (const chain of group) if (matchChain(el, chain)) return true;
    return false;
  }
  function findAll(root, group) {
    const out = [];
    walk(root, el => { if (matchOne(el, group)) out.push(el); });
    return out;
  }
  function findFirst(root, group) {
    let hit = null;
    walk(root, el => { if (!hit && matchOne(el, group)) hit = el; });
    return hit;
  }
  function walk(node, fn) {
    if (!node) return;
    if (node.nodeType === NODE_ELEMENT) fn(node);
    for (const c of node._children) walk(c, fn);
  }

  // ── HTML parser (tag-soup, just enough for smoke) ───────────────
  //
  // PoC: handles void elements, attribute syntax, text nodes,
  // simple <script>/<style> raw-text. Ignores DOCTYPE / comments.
  // No table-body insertion mode, no SVG. Replace with parse5 or a
  // proper port once milestone 2 is solid.

  const VOID = new Set(['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr']);
  const RAWTEXT = new Set(['script','style']);

  function parseDocument(html) {
    const doc = new Document();
    const root = new Element('html');
    doc.documentElement = root;
    root._parent = doc;
    doc._children.push(root);
    const body = new Element('body');
    // pre-create head + body so document.body / document.head work
    // even before the parsed tree is grafted in.
    const head = new Element('head');
    head._parent = root; root._children.push(head);
    body._parent = root; root._children.push(body);
    const stripped = stripHtmlWrapper(html);
    const nodes = parseFragment(stripped.body);
    for (const n of nodes) { n._parent = body; body._children.push(n); }
    if (stripped.head) {
      const headNodes = parseFragment(stripped.head);
      for (const n of headNodes) { n._parent = head; head._children.push(n); }
    }
    return doc;
  }

  function stripHtmlWrapper(html) {
    // Crude: pull out <head>…</head> and <body>…</body> blocks; if
    // neither is present treat the whole thing as body content.
    const head = (/<head\b[^>]*>([\s\S]*?)<\/head>/i.exec(html) || [, ''])[1];
    const body = (/<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html) || [, ''])[1];
    if (body) return { head: head, body: body };
    // No wrapper: the whole input is body content. Strip <!doctype>.
    return { head: head, body: html.replace(/<!doctype[^>]*>/i, '').replace(/<\/?html\b[^>]*>/gi, '') };
  }

  function parseFragment(html) {
    const out = [];
    const stack = []; // { el }
    let target = out;
    // Text / nested-element pushes inside `target` need `_parent` set
    // to the owning Element so `firstChild` / `nextSibling` traversal
    // (the path wgxpath uses) walks the full sibling chain. Without
    // this, text nodes were created with `_parent = null` and the
    // sibling walk fell off after the first text child.
    const pushChild = (child) => {
      const parent = stack.length ? stack[stack.length - 1].el : null;
      child._parent = parent;
      target.push(child);
    };
    let i = 0;
    const re = /<(\/?)([a-zA-Z][\w-]*)([^>]*)>/g;
    let m, last = 0;
    while ((m = re.exec(html)) !== null) {
      if (m.index > last) {
        const text = html.slice(last, m.index);
        if (text.length) pushChild(makeText(text));
      }
      const closing = m[1] === '/';
      const tag = m[2].toLowerCase();
      const rest = m[3];
      last = re.lastIndex;
      if (closing) {
        // pop stack until we find this tag
        for (let s = stack.length - 1; s >= 0; s--) {
          if (stack[s].el._tag === tag) {
            stack.length = s;
            target = stack.length ? stack[stack.length - 1].el._children : out;
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
        const closeRe = new RegExp('</' + tag + '\\s*>', 'i');
        const closeIdx = html.search.call(html.slice(last), closeRe);
        const absIdx   = closeIdx < 0 ? html.length : last + closeIdx;
        const raw = html.slice(last, absIdx);
        if (raw.length) {
          const t = makeText(raw);
          t._parent = el;
          el._children.push(t);
        }
        const end = closeIdx < 0 ? html.length : (last + closeIdx + ('</' + tag + '>').length);
        last = end; re.lastIndex = end;
        continue;
      }
      stack.push({ el });
      target = el._children;
    }
    if (last < html.length) {
      const tail = html.slice(last);
      if (tail.length) pushChild(makeText(tail));
    }
    // Top-level nodes have no fragment-level parent; the caller
    // (parseDocument or `innerHTML` setter) re-parents them.
    for (const n of out) n._parent = null;
    return out;
  }

  function makeText(s) {
    return new Text(decodeEntities(s));
  }
  function decodeEntities(s) {
    return s.replace(/&(amp|lt|gt|quot|apos|nbsp|#\d+|#x[0-9a-fA-F]+);/g, (_, e) => {
      if (e === 'amp') return '&';
      if (e === 'lt') return '<';
      if (e === 'gt') return '>';
      if (e === 'quot') return '"';
      if (e === 'apos') return "'";
      if (e === 'nbsp') return ' ';
      if (e[0] === '#') {
        const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : '';
      }
      return '';
    });
  }
  function applyAttributes(el, rest) {
    const re = /([a-zA-Z_:][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
    let m;
    while ((m = re.exec(rest)) !== null) {
      const v = m[2] != null ? m[2] : (m[3] != null ? m[3] : (m[4] != null ? m[4] : ''));
      el.setAttribute(m[1], decodeEntities(v));
    }
  }

  function serializeElement(el) {
    // DocumentFragment / Comment / Unknown nodeTypes lack `_attrs` and
    // `_tag` — they shouldn't be serialised as elements. Guard so a
    // foreign node grafted into the tree doesn't crash the dump path.
    if (!el || !el._tag || !el._attrs) return '';
    const attrs = Object.keys(el._attrs).map(n => ' ' + n + '="' + escapeAttr(el._attrs[n]) + '"').join('');
    if (VOID.has(el._tag)) return '<' + el._tag + attrs + '>';
    return '<' + el._tag + attrs + '>' + serializeChildren(el) + '</' + el._tag + '>';
  }
  function serializeChildren(el) {
    let s = '';
    if (!el || !el._children) return s;
    for (const c of el._children) {
      s += c.nodeType === NODE_TEXT ? escapeText(c.data) : serializeElement(c);
    }
    return s;
  }
  function escapeAttr(v) { return String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;'); }
  function escapeText(v) { return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  // ── Globals seen by Ruby side via Context#call('__csim<Op>') ────

  // Make `globalThis` (== window) listenable. Libraries register
  // `window.addEventListener('DOMContentLoaded', ...)` /
  // `window.addEventListener('load', ...)`; without these, every such
  // call throws "addEventListener is not a function" and the listener
  // chain dies.
  const __windowListeners = Object.create(null);
  globalThis.addEventListener = function (type, handler, options) {
    if (typeof handler !== 'function') return;
    const capture = !!(options && (options === true || options.capture));
    const list = __windowListeners[type] || (__windowListeners[type] = []);
    if (list.some(l => l.handler === handler && l.capture === capture)) return;
    list.push({ handler, capture });
  };
  globalThis.removeEventListener = function (type, handler, options) {
    const list = __windowListeners[type];
    if (!list) return;
    const capture = !!(options && (options === true || options.capture));
    __windowListeners[type] = list.filter(l => !(l.handler === handler && l.capture === capture));
  };
  globalThis.dispatchEvent = function (event) {
    const list = __windowListeners[event.type];
    if (!list || !list.length) return true;
    for (const { handler } of list.slice()) {
      try { handler.call(globalThis, event); }
      catch (e) { try { console.error('[csim v3] window listener threw:', e && e.message); } catch (_) {} }
    }
    return !event.defaultPrevented;
  };

  globalThis.Document = Document;     // so wgxpath patches Document.prototype.evaluate
  globalThis.Element  = Element;
  globalThis.Node     = Node;
  globalThis.Text     = Text;
  globalThis.document = new Document();
  globalThis.window   = globalThis;
  // location proxy. URL components mirror what Ruby's V3Browser
  // tracks; updated on each `__csimLoadDocument(html, url)`. Library
  // code (jQuery 1.x feature detect, Turbo Drive) reads `.href` early
  // so we need at least a non-throwing initial value.
  globalThis.location = makeLocation('http://www.example.com/');
  function makeLocation(url) {
    return parseUrlForLocation(url);
  }
  function parseUrlForLocation(url) {
    try {
      const u = __csim_parseUrl(url, null);
      if (u && !u.error) return Object.assign({}, u, {
        toString() { return this.href; },
        assign:  (next) => __locationAssign(next),
        replace: (next) => __locationAssign(next),
        reload:  () => __locationReload()
      });
    } catch (_) {}
    return { href: url || '', protocol: 'http:', host: '', hostname: '',
             port: '', pathname: '/', search: '', hash: '', origin: '',
             toString() { return this.href; },
             assign:  (next) => __locationAssign(next),
             replace: (next) => __locationAssign(next),
             reload:  () => __locationReload() };
  }
  globalThis.__csimUpdateLocation = function (url) {
    globalThis.location = makeLocation(String(url || ''));
  };

  // `getComputedStyle(el)` — minimal stub. We don't run a real cascade
  // (cascade-derived visibility lives behind a separate code path),
  // so this just exposes inline `style="..."` as the computed style.
  // jQuery 1.x assigns its computed-style helper (`Ra`) only if
  // `window.getComputedStyle` is truthy, so the stub also guards
  // against `Ra is not a function` deep in jQuery UI's measurement
  // path.
  // navigator stub. jQuery UI / Stimulus / framework feature detection
  // reads `navigator.userAgent` early. We pretend to be a modern
  // browser with a JS-capable runtime; tests that inspect specific
  // UA strings (mobile / Safari quirks) are out of scope.
  globalThis.navigator = {
    userAgent: 'capybara-simulated/v3 (V8-resident DOM)',
    appName:   'Netscape',
    appVersion:'5.0',
    platform:  'Linux',
    language:  'en-US',
    languages: ['en-US', 'en'],
    onLine:    true,
    cookieEnabled: true
  };
  // History stub — Turbo Drive + many SPA libs read `history.length`
  // and call `history.pushState` / `replaceState`. We thread through
  // existing `__setCurrentUrl` for state changes.
  // Window scroll / size stubs. No layout engine → all zero. Libraries
  // (jQuery offset, Stimulus / Turbo scroll restoration) read these.
  globalThis.pageXOffset = 0;
  globalThis.pageYOffset = 0;
  globalThis.scrollX     = 0;
  globalThis.scrollY     = 0;
  globalThis.innerWidth  = 1024;
  globalThis.innerHeight = 768;
  globalThis.outerWidth  = 1024;
  globalThis.outerHeight = 768;
  globalThis.scrollTo    = function () { /* no-op */ };
  globalThis.scrollBy    = function () { /* no-op */ };
  globalThis.scroll      = function () { /* no-op */ };

  globalThis.history = {
    length: 1,
    state:  null,
    pushState(state, _title, url) { this.state = state; if (url) __setCurrentUrl(String(url)); },
    replaceState(state, _title, url) { this.state = state; if (url) __setCurrentUrl(String(url)); },
    back()    { __locationReload(); },
    forward() { __locationReload(); },
    go()      { __locationReload(); }
  };

  globalThis.getComputedStyle = function (el) {
    if (!el || el.nodeType !== NODE_ELEMENT) return makeStyleProxy({ _attrs: {} });
    return el.style;
  };

  // Handle registry — Ruby keeps integer ids, looks up Element back
  // via `__csimGet*(handle)` accessors. Wired in `parseDocument`
  // and pushed during create / append paths once those exist.
  const __handles = new Map();
  function registerNode(n) {
    __handles.set(n._id, n);
    if (n._children) for (const c of n._children) registerNode(c);
  }
  function lookup(h) { return __handles.get(h) || null; }
  // Mutation hooks (called from Node.prototype.{appendChild, insertBefore,
  // replaceChild, removeChild} and `innerHTML` setter). Keeps the
  // handle registry in sync so Capybara's `find` results stay live
  // and stale references invalidate after `removeChild`.
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

  // Replace the document with a freshly-parsed one. Capybara's `visit`
  // ends up here. After parse, walk top-level `<script>` elements and
  // eval their text — that's enough to drive inline scripts that
  // populate globals tests then read via evaluate_script. External
  // `<script src>` / `defer` / `async` ordering lifts in once
  // resource fetching ports to v3.
  globalThis.__csimLoadDocument = function (html) {
    __handles.clear();
    __hideRules = [];
    // Drop pending timers from the prior page — otherwise stale
    // setTimeouts captured against the previous jQuery closure
    // fire under the new page's context. We saw this surface as
    // Redmine's `addFormObserversForDoubleSubmit` running 3× (once
    // for the new page's ready resolution + leftovers from prior
    // visits' chained-Deferred .then setTimeouts).
    __resetTimers();
    // Module cache survives __resetPage (the snapshot's `__csim_modules`
    // is the cross-Context warm-up store), but per-page state in the
    // page's modules should not. We don't have a clean way to dump
    // it yet — left as a follow-up.
    globalThis.document = parseDocument(String(html == null ? '' : html));
    registerNode(globalThis.document);
    // Cascade-derived hide rules need to land *before* scripts run —
    // a script that tests visibility (`offsetWidth`-style probes) or
    // queries Capybara-visible elements would otherwise see the
    // pre-cascade state.
    __hideRules = collectHideRules(globalThis.document);
    runInlineScripts(globalThis.document);
    return globalThis.document._id;
  };

  function runInlineScripts(doc) {
    if (!doc || !doc.documentElement) return;
    // Importmaps land first so `<script type="module">` can resolve
    // bare specifiers against them. The module-execution path is
    // gated by a Ruby-side env-var feature flag because activating
    // Stimulus / Hotwire here surfaces a regression on Redmine where
    // legacy jQuery handlers fire twice and intercept the form
    // submit. Once that's untangled the default flips on.
    ingestImportmaps(doc);
    const scripts = doc.documentElement.querySelectorAll('script');
    for (const s of scripts) {
      const type = (s._attrs.type || '').toLowerCase();
      if (type === 'importmap') continue;  // already consumed
      if (type === 'module') {
        if (globalThis.__csim_esm_enabled) runModuleScript(s);
        continue;
      }
      if (type && !SCRIPT_TYPES_CLASSIC.has(type)) continue;
      let body;
      if (s._attrs.src) {
        // Synchronous fetch via Ruby Rack callback. mini_racer's attach
        // is blocking, so this preserves the classic-script "block the
        // parser until loaded" semantics without an event loop.
        const resp = __rackFetch('GET', s._attrs.src, '', null, 'follow');
        if (!resp || resp.status >= 400) continue;
        body = resp.body || '';
      } else {
        body = scriptText(s);
      }
      if (!body) continue;
      try { (0, eval)(body); } catch (e) {
        try { console.error('[csim v3] script threw:', e && e.message); } catch (_) {}
      }
    }
    if (__observers.size && __pendingRecords.length) deliverMutations();
    // After scripts have run, fire the readiness lifecycle events
    // libraries hook into (`DOMContentLoaded` on document, `load` on
    // window). jQuery 1.x's `$(handler)` short-circuits if
    // `readyState === 'complete'` at the time it's called; but a
    // library that registers via `addEventListener('DOMContentLoaded')`
    // only sees the handler fire if we actually emit the event.
    if (doc) {
      try { dispatchEvent(doc, new Event('DOMContentLoaded', { bubbles: true, cancelable: false })); } catch (_) {}
    }
  }
  function runModuleScript(s) {
    const baseUrl = (globalThis.location && globalThis.location.href) || null;
    if (s._attrs.src) {
      const url = resolveAgainst(s._attrs.src, baseUrl);
      try { __csim_require(url); }
      catch (e) {
        try { console.error('[csim v3] module', url, 'failed:', e && e.message); } catch (_) {}
      }
    } else {
      const body = scriptText(s);
      if (!body) return;
      // Inline modules have no URL — synthesise a stable one per
      // body so module-cache hits work after a re-eval.
      const url = (baseUrl || 'inline://') + '#inline-' + hashStr(body);
      globalThis.__csim_inlineSources = globalThis.__csim_inlineSources || Object.create(null);
      globalThis.__csim_inlineSources[url] = body;
      try { __csim_require(url); }
      catch (e) {
        try { console.error('[csim v3] inline module failed:', e && e.message); } catch (_) {}
      }
    }
  }
  function hashStr(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(16);
  }
  globalThis.__csim_inlineSources = Object.create(null);
  function scriptText(el) {
    let s = '';
    for (const c of el._children) if (c.nodeType === NODE_TEXT) s += c.data;
    return s;
  }
  const SCRIPT_TYPES_CLASSIC = new Set([
    '', 'text/javascript', 'application/javascript', 'application/ecmascript'
  ]);

  // ── ES module loader ────────────────────────────────────────────
  //
  // mini_racer doesn't expose V8's host-module callbacks, so we
  // synthesise the loader in JS. EsmRewriter (Ruby) transforms each
  // module body into a function whose `import` statements become
  // `__csim_require(url)` calls and whose `export` statements become
  // `__exports.*` assignments. Cached source comes back from Ruby via
  // `__csim_fetchModuleSource(url)`.

  // Exposed via globalThis so test / debug code can read them. Also
  // because `evaluate_script` runs in a new `Function` scope that
  // can't see IIFE-local constants.
  globalThis.__csim_modules    = Object.create(null);  // url → exports
  globalThis.__csim_factories  = Object.create(null);  // url → factory fn
  globalThis.__csim_inProgress = Object.create(null);  // url → partially-built exports
  globalThis.__csim_importmap  = { imports: Object.create(null), scopes: Object.create(null) };
  const __csim_modules    = globalThis.__csim_modules;
  const __csim_factories  = globalThis.__csim_factories;
  const __csim_inProgress = globalThis.__csim_inProgress;
  const __csim_importmap  = globalThis.__csim_importmap;

  // EsmRewriter collapses `import(spec)` into a regular call site —
  // this is the function it points at. Synchronous Promise wrapper
  // matches what v2's V8 path does.
  globalThis.__csim_dynamicImport = function (spec) {
    try {
      // Dynamic specifiers are computed at runtime; resolve via the
      // importmap + base URL the same way the static-rewrite path
      // does at load time.
      const baseUrl = (globalThis.location && globalThis.location.href) || null;
      const resolved = __csim_resolveSpecifier(String(spec), baseUrl);
      return Promise.resolve(__csim_require(resolved));
    } catch (e) { return Promise.reject(e); }
  };

  globalThis.__csim_require = function (url) {
    if (url in __csim_modules)    return __csim_modules[url];
    if (url in __csim_inProgress) return __csim_inProgress[url];
    let factory = __csim_factories[url];
    if (!factory) {
      const src = __csim_fetchModuleSource(String(url));
      if (src == null) throw new Error('module not registered: ' + url);
      try { factory = new Function('__exports', src); }
      catch (e) {
        throw new Error('module compile failed for ' + url + ': ' + (e && e.message ? e.message : e));
      }
      __csim_factories[url] = factory;
    }
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

  // Module specifier resolution: bare specifiers → importmap;
  // anything else → URL-joined against the importer.
  globalThis.__csim_resolveSpecifier = function (specifier, baseUrl) {
    const mapped = __csim_importmap.imports[specifier];
    if (mapped) return resolveAgainst(mapped, baseUrl);
    if (specifier.charAt(0) === '/' ||
        specifier.startsWith('./') || specifier.startsWith('../') ||
        /^[a-z]+:\/\//i.test(specifier)) {
      return resolveAgainst(specifier, baseUrl);
    }
    return specifier; // bare, no map — surface as-is so the loader errors usefully
  };
  function resolveAgainst(url, base) {
    try {
      const u = __csim_parseUrl(url, base || (globalThis.location && globalThis.location.href) || null);
      return u && !u.error ? u.href : url;
    } catch (_) { return url; }
  }

  // Ingest `<script type="importmap">` tags. Per HTML spec only the
  // first map wins, but importmap-rails / Rails 8 can ship multi-pin
  // output as separate tags; later maps override earlier keys.
  function ingestImportmaps(doc) {
    if (!doc || !doc.documentElement) return;
    const tags = doc.documentElement.getElementsByTagName('script');
    for (const t of tags) {
      if ((t._attrs.type || '').toLowerCase() !== 'importmap') continue;
      const src = t._attrs.src;
      let text;
      if (src) {
        try {
          const resp = __rackFetch('GET', src, '', null, 'follow');
          text = resp && resp.status < 400 ? resp.body : null;
        } catch (_) { text = null; }
      } else {
        text = scriptText(t);
      }
      if (!text) continue;
      let parsed;
      try { parsed = JSON.parse(text); } catch (_) { continue; }
      if (parsed && typeof parsed === 'object') {
        if (parsed.imports && typeof parsed.imports === 'object') Object.assign(__csim_importmap.imports, parsed.imports);
        if (parsed.scopes  && typeof parsed.scopes  === 'object') Object.assign(__csim_importmap.scopes,  parsed.scopes);
      }
    }
    // Push the merged map to the Ruby side so `load_module`'s
    // bare-specifier resolution agrees with JS-side
    // `__csim_resolveSpecifier`. Best-effort: if Ruby hasn't
    // wired the callback (e.g. snapshot path), the stub is a
    // no-op.
    try { __csim_pushImportmap(JSON.stringify(__csim_importmap)); } catch (_) {}
  }

  // Stub overridden by Ruby-attached host fn. The snapshot needs the
  // symbol bound (otherwise the `new Function('return eval(...)')`
  // wrap in `evaluate_script` can't reference it).
  if (typeof globalThis.__csim_fetchModuleSource !== 'function') {
    globalThis.__csim_fetchModuleSource = function () { return null; };
  }

  // Capybara's `Session#evaluate_script` reaches here. Wrap the code
  // in a function so it sees `arguments[N]` and an implicit return
  // hands back the last expression. Mirrors v2's `__evalScript`
  // contract closely enough for the smoke tests. Args coming over
  // the wire may include `{__elementHandle: id}` sentinels (Capybara
  // passing Node instances); rehydrate them to live Element refs so
  // user scripts can call methods on them.
  // `eval(code)` inside the function body sees that function's
  // `arguments`, so user scripts referencing `arguments[i]` work the
  // same way as selenium / chrome. eval also handles statements vs
  // expressions uniformly — the `return <expr>` wrapping breaks the
  // moment a script starts with `var ...;` or similar.
  const __evalCache = new Map();
  function compileScript(code) {
    let fn = __evalCache.get(code);
    if (!fn) {
      fn = new Function('return eval(' + JSON.stringify(code) + ');');
      __evalCache.set(code, fn);
    }
    return fn;
  }
  globalThis.__csimEvalScript = function (code, args) {
    return marshalReturn(compileScript(code).apply(null, rehydrateArgs(args || [])));
  };
  function rehydrateArgs(args) {
    if (Array.isArray(args)) return args.map(rehydrateArgs);
    if (args && typeof args === 'object') {
      if (typeof args.__elementHandle === 'number') return lookup(args.__elementHandle);
      const out = {};
      for (const k of Object.keys(args)) out[k] = rehydrateArgs(args[k]);
      return out;
    }
    return args;
  }
  // Inverse: when a script returns an Element / NodeList, marshal so
  // the Ruby side can wrap the handles back into Node instances.
  function marshalReturn(value) {
    if (value && typeof value === 'object' && value.nodeType !== undefined && typeof value._id === 'number') {
      return { __elementHandle: value._id };
    }
    if (Array.isArray(value)) return value.map(marshalReturn);
    return value;
  }
  globalThis.__csimDocumentTitle = function () {
    const head = globalThis.document.head;
    if (!head) return '';
    const t = head._children.find(c => c._tag === 'title');
    return t ? t.textContent : '';
  };
  globalThis.__csimDocumentText = function () {
    const body = globalThis.document.body;
    return body ? body.textContent : '';
  };

  // Query under `root` (handle, or 0 for document). Returns array of
  // handles; Ruby resolves each via accessors below.
  globalThis.__csimQuery = function (rootHandle, selector) {
    const root = rootHandle ? lookup(rootHandle) : globalThis.document;
    if (!root) return [];
    const matches = root.nodeType === NODE_DOC
      ? root.querySelectorAll(selector)
      : (root.querySelectorAll ? root.querySelectorAll(selector) : []);
    return matches.map(el => el._id);
  };
  // XPath evaluation via wgxpath (Google's wicked-good-xpath, vendored
  // into vendor/js/wgxpath.js and installed at boot). `document.
  // evaluate` is patched onto Document.prototype. We use ORDERED_NODE_
  // SNAPSHOT_TYPE (7) so the result is a live array we can iterate
  // by index, and so the node order matches Capybara's expectations.
  globalThis.__csimEvaluateXPath = function (xpath, contextHandle) {
    const ctx = contextHandle ? lookup(contextHandle) : globalThis.document;
    if (!ctx) return [];
    let result;
    try {
      result = globalThis.document.evaluate(String(xpath), ctx, null, 7, null);
    } catch (e) {
      // Match Capybara's selenium driver: throw `Capybara::ElementNotFound`
      // for bad XPath. Surface to Ruby as a sentinel so the caller can
      // raise; for now we just return an empty result and log.
      try { console.error('[csim v3] XPath threw:', e && e.message, 'for', xpath); } catch (_) {}
      return [];
    }
    const out = [];
    for (let i = 0; i < result.snapshotLength; i++) {
      const n = result.snapshotItem(i);
      if (n && typeof n._id === 'number') out.push(n._id);
    }
    return out;
  };

  globalThis.__csimQueryOne = function (rootHandle, selector) {
    const root = rootHandle ? lookup(rootHandle) : globalThis.document;
    if (!root) return 0;
    const hit = root.nodeType === NODE_DOC
      ? root.querySelector(selector)
      : (root.querySelector ? root.querySelector(selector) : null);
    return hit ? hit._id : 0;
  };

  // Element field accessors. Each is one V8 round-trip from Ruby
  // (mini_racer's `Context#call`) — at the granularity of one
  // Capybara DSL operation (`node.text`, `node.tag_name`, …), not
  // per-internal-DOM-op.
  globalThis.__csimText      = function (h) { const n = lookup(h); return n ? n.textContent : ''; };
  globalThis.__csimTag       = function (h) { const n = lookup(h); return n && n._tag ? n._tag : ''; };
  globalThis.__csimAttr      = function (h, name) { const n = lookup(h); return n && n.getAttribute ? n.getAttribute(name) : null; };
  globalThis.__csimHasAttr   = function (h, name) { const n = lookup(h); return !!(n && n.hasAttribute && n.hasAttribute(name)); };
  // Visibility walk mirroring v2's `self_hidden?` + ancestor chain:
  // INVISIBLE_TAGS (head/script/style/template/noscript/title),
  // `<input type=hidden>`, `hidden` attribute, inline `style=`
  // `display:none` / `visibility:hidden`. Cascade-driven visibility
  // (class-based hide rules from external stylesheets) is deferred —
  // when we need it, port `class_hidden?` / cascade resolution from
  // v2's Browser.
  const INVISIBLE_TAGS = new Set(['head','script','style','template','noscript','title']);
  const DISPLAY_NONE_RE       = /(^|;|\s)display\s*:\s*none\b/i;
  const VISIBILITY_HIDDEN_RE  = /(^|;|\s)visibility\s*:\s*hidden\b/i;
  function selfHidden(el) {
    if (el._attrs.hidden != null) return true;
    const style = el._attrs.style;
    if (style && (DISPLAY_NONE_RE.test(style) || VISIBILITY_HIDDEN_RE.test(style))) return true;
    // Cascade-derived hide rules collected at page-load time. We don't
    // resolve the full CSS cascade (specificity / inheritance / media
    // queries); we just check whether *any* parsed `display: none` /
    // `visibility: hidden` rule's selector matches this element.
    // Good enough for class-based hides (Tailwind `.hidden`, Bootstrap
    // `.d-none`, Redmine `.contextual.collapsed > ul`), which is the
    // common case for apps under test.
    return matchesAnyHideRule(el);
  }

  // ── Hide-rule cascade (PoC) ─────────────────────────────────────
  //
  // Populated from `<style>` text and fetched `<link rel="stylesheet">`
  // content during `__csimLoadDocument`. Each rule is `{ group, hide }`
  // where `group` is a selector group parsed via `parseSelector` (the
  // same JS-side parser our `querySelectorAll` already uses).

  let __hideRules = [];

  // Source-order-last-wins resolution of `display` + `visibility`
  // across all matching rules. Cheaper than a full cascade and good
  // enough for the responsive overrides that are the common cause of
  // false-positive hides (Redmine's `.flyout-menu{display:none}` →
  // `.flyout-menu{display:block}` chain in responsive.css).
  function matchesAnyHideRule(el) {
    if (__hideRules.length === 0) return false;
    let display = null;
    let visibility = null;
    for (const r of __hideRules) {
      try {
        if (matchOne(el, r.group)) {
          if (r.display    != null) display    = r.display;
          if (r.visibility != null) visibility = r.visibility;
        }
      } catch (_) {}
    }
    return display === 'none' || visibility === 'hidden';
  }

  // Strip CSS comments and at-rule blocks before regexing rule bodies.
  // We don't model @media / @supports / @container; the inside-rules
  // of common `@media (prefers-*)` blocks rarely toggle display:none
  // for test-relevant elements, so dropping them keeps false-positives
  // down rather than treating all @media rules as always-on.
  function stripCssComments(s) { return s.replace(/\/\*[\s\S]*?\*\//g, ''); }
  function stripAtRules(s) {
    // Walk and remove balanced `@... { ... }` blocks at top level.
    let out = '', i = 0, depth = 0, skipDepth = 0;
    while (i < s.length) {
      const ch = s[i];
      if (skipDepth > 0) {
        if (ch === '{') skipDepth++;
        else if (ch === '}') skipDepth--;
        i++;
        continue;
      }
      if (ch === '@' && depth === 0) {
        // Find the matching `{` or `;`.
        let j = i + 1;
        while (j < s.length && s[j] !== '{' && s[j] !== ';') j++;
        if (j < s.length && s[j] === ';') { i = j + 1; continue; }
        if (j < s.length && s[j] === '{') { skipDepth = 1; i = j + 1; continue; }
        break;
      }
      out += ch;
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      i++;
    }
    return out;
  }
  const DISPLAY_DECL_RE    = /(?:^|;|\s)display\s*:\s*([^;]+?)(?:;|$)/i;
  const VISIBILITY_DECL_RE = /(?:^|;|\s)visibility\s*:\s*([^;]+?)(?:;|$)/i;
  function extractHideRules(cssText) {
    const out = [];
    const cleaned = stripAtRules(stripCssComments(cssText));
    const re = /([^{}]+?)\s*\{\s*([^{}]*?)\s*\}/g;
    let m;
    while ((m = re.exec(cleaned)) !== null) {
      const selector = m[1].trim();
      const decls    = m[2];
      if (!selector) continue;
      const dm = DISPLAY_DECL_RE.exec(decls);
      const vm = VISIBILITY_DECL_RE.exec(decls);
      if (!dm && !vm) continue;
      const display    = dm ? dm[1].trim().toLowerCase() : null;
      const visibility = vm ? vm[1].trim().toLowerCase() : null;
      // Source-order-last-wins resolution needs to keep reveal rules
      // (display:block etc.) too, not just `display:none` — otherwise
      // a later `.flyout-menu{display:block}` can't override an earlier
      // `.flyout-menu{display:none}`. (Specificity is approximated by
      // source order; good enough for class-based responsive overrides.)
      for (const sel of splitTopLevel(selector, ',')) {
        const trimmed = sel.trim();
        if (!trimmed) continue;
        let group;
        try { group = parseSelector(trimmed); } catch (_) { continue; }
        if (group && group.length) out.push({ group, display, visibility });
      }
    }
    return out;
  }

  function collectHideRules(doc) {
    if (!doc || !doc.documentElement) return [];
    const rules = [];
    // <style> blocks first.
    const styles = doc.documentElement.querySelectorAll('style');
    for (const s of styles) {
      const txt = scriptText(s); // re-use raw-text accessor
      if (txt) rules.push(...extractHideRules(txt));
    }
    // <link rel="stylesheet" href="..."> — synchronously fetched via
    // the same `__rackFetch` host fn used for external `<script src>`.
    // Network errors fall through silently; cascade is best-effort
    // for visibility resolution, not load-bearing.
    const links = doc.documentElement.querySelectorAll('link');
    for (const l of links) {
      const rel = (l._attrs.rel || '').toLowerCase();
      if (!rel.split(/\s+/).includes('stylesheet')) continue;
      const href = l._attrs.href;
      if (!href) continue;
      try {
        const resp = __rackFetch('GET', href, '', null, 'follow');
        if (resp && resp.status < 400 && resp.body) {
          rules.push(...extractHideRules(resp.body));
        }
      } catch (_) {}
    }
    return rules;
  }
  globalThis.__csimVisible = function (h) {
    const n = lookup(h);
    if (!n || n.nodeType !== NODE_ELEMENT) return false;
    if (INVISIBLE_TAGS.has(n._tag)) return false;
    if (n._tag === 'input' && (n._attrs.type || '').toLowerCase() === 'hidden') return false;
    let summarySeen = false;
    let cur = n;
    while (cur) {
      if (cur.nodeType === NODE_DOC) return true;
      if (cur.nodeType === NODE_ELEMENT) {
        if (INVISIBLE_TAGS.has(cur._tag)) return false;
        if (selfHidden(cur)) return false;
        // <details> hides its content while closed *unless* the target
        // sits inside <summary>.
        if (cur._tag === 'details' && cur._attrs.open == null && !summarySeen) return false;
        if (cur._tag === 'summary') summarySeen = true;
      }
      cur = cur._parent;
    }
    return true;
  };

  // visible_text walks the subtree like textContent does, but skips
  // INVISIBLE_TAGS / hidden / display:none / `<input type=hidden>`
  // children. Capybara's `has_text?` defaults to this path; without
  // the skip, page titles and <script> source land in the visible-
  // text string and trip "found N times including non-visible text"
  // assertions.
  globalThis.__csimVisibleText = function (h) {
    const n = lookup(h);
    return n ? collectVisibleText(n) : '';
  };
  function collectVisibleText(node) {
    if (node.nodeType === NODE_TEXT) return node.data;
    if (node.nodeType !== NODE_ELEMENT && node.nodeType !== NODE_DOC) return '';
    if (node.nodeType === NODE_ELEMENT) {
      if (INVISIBLE_TAGS.has(node._tag)) return '';
      if (node._tag === 'input' && (node._attrs.type || '').toLowerCase() === 'hidden') return '';
      if (selfHidden(node)) return '';
      if (node._tag === 'details' && node._attrs.open == null) {
        // Closed details: only emit text inside <summary>.
        let s = '';
        for (const c of node._children) {
          if (c.nodeType === NODE_ELEMENT && c._tag === 'summary') s += collectVisibleText(c);
        }
        return s;
      }
    }
    let out = '';
    for (const c of node._children) out += collectVisibleText(c);
    return out;
  }

  // `disabled?` mirrors v2's logic: only form controls (+ fieldset)
  // can be disabled; an `<option>` inherits disabled from an ancestor
  // `<select>` / `<optgroup>`; form controls inherit from an ancestor
  // `<fieldset disabled>` unless they sit inside its first `<legend>`.
  const FORM_CONTROLS = new Set(['input','select','textarea','button','optgroup','option']);
  globalThis.__csimDisabled = function (h) {
    const n = lookup(h);
    if (!n || n.nodeType !== NODE_ELEMENT) return false;
    if ((FORM_CONTROLS.has(n._tag) || n._tag === 'fieldset') && n._attrs.disabled != null) return true;
    if (n._tag === 'option') {
      let cur = n._parent;
      while (cur && cur.nodeType === NODE_ELEMENT && (cur._tag === 'optgroup' || cur._tag === 'select')) {
        if (cur._attrs.disabled != null) return true;
        cur = cur._parent;
      }
    }
    if (FORM_CONTROLS.has(n._tag)) {
      let cur = n._parent;
      while (cur && cur.nodeType === NODE_ELEMENT) {
        if (cur._tag === 'fieldset' && cur._attrs.disabled != null) {
          // Find the fieldset's first <legend>; if n sits inside it,
          // it stays enabled.
          let legend = null;
          for (const c of cur._children) {
            if (c.nodeType === NODE_ELEMENT && c._tag === 'legend') { legend = c; break; }
          }
          if (legend) {
            let p = n;
            while (p) { if (p === legend) return false; p = p._parent; }
          }
          return true;
        }
        cur = cur._parent;
      }
    }
    return false;
  };

  globalThis.__csimAttrs = function (h) {
    const n = lookup(h);
    return n && n._attrs ? Object.assign({}, n._attrs) : {};
  };
  // Lifetime / stale check. v2 pins a Nokogiri node; here the handle is
  // alive iff it's still in `__handles`. Detaches drop on the next
  // GC walk; for now we treat "in map" as "alive".
  globalThis.__csimAlive = function (h) { return __handles.has(h); };

  // Form-field value reader. Mirrors what Capybara reads via
  // Node#value: input/textarea use `.value`, select returns its
  // selected option value, checkbox / radio surface their `.value` only
  // when checked (rack-test parity). PoC: read `.value` attr / first
  // option for select; refined as milestone-3 forms work lands.
  globalThis.__csimValue = function (h) {
    const n = lookup(h);
    if (!n || n.nodeType !== NODE_ELEMENT) return null;
    const tag = n._tag;
    if (tag === 'textarea') {
      // HTML spec: when initialised from parsed text, the textarea
      // value drops one leading newline that immediately follows the
      // open tag (the spec calls this "first newline removal"). After
      // a `set`, `_attrs.value` carries the user's intent verbatim,
      // so prefer that.
      if (n._attrs.value != null) return n._attrs.value;
      const txt = n.textContent;
      return txt.length && txt.charCodeAt(0) === 10 ? txt.slice(1) : txt;
    }
    if (tag === 'select') {
      const opts = n.querySelectorAll('option');
      const multi = n._attrs.multiple != null;
      // `<select multiple>` returns an array of every selected
      // option's value; single-select returns the first explicitly-
      // selected option, or the first non-disabled option as the
      // implicit default.
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
    if (tag === 'input') {
      const type = (n._attrs.type || 'text').toLowerCase();
      if (type === 'checkbox' || type === 'radio') return n._attrs.value != null ? n._attrs.value : 'on';
      return n._attrs.value != null ? n._attrs.value : '';
    }
    return n._attrs.value != null ? n._attrs.value : '';
  };

  // `__csimSerialize(h)` — outerHTML of the subtree, with each Element's
  // handle id baked into a `data-csim-handle` attribute so the Ruby
  // side can run libxml2-XPath against the serialised doc and recover
  // node identities. One serialisation per `find_xpath` call; cheap
  // compared to v2's per-element __dom callbacks.
  globalThis.__csimSerialize = function (h) {
    const root = h ? lookup(h) : globalThis.document;
    if (!root) return '';
    if (root.nodeType === NODE_DOC) return serializeDoc(root);
    return serializeElementWithHandles(root);
  };
  function serializeDoc(doc) {
    return doc.documentElement ? serializeElementWithHandles(doc.documentElement) : '';
  }
  function serializeElementWithHandles(el) {
    if (!el || !el._tag || !el._attrs) return '';
    const attrs = Object.keys(el._attrs)
      .map(n => ' ' + n + '="' + escapeAttr(el._attrs[n]) + '"').join('');
    const handle = ' data-csim-handle="' + el._id + '"';
    if (VOID.has(el._tag)) return '<' + el._tag + handle + attrs + '>';
    return '<' + el._tag + handle + attrs + '>' + serializeChildrenWithHandles(el) + '</' + el._tag + '>';
  }
  function serializeChildrenWithHandles(el) {
    let s = '';
    for (const c of el._children) {
      s += c.nodeType === NODE_TEXT ? escapeText(c.data) : serializeElementWithHandles(c);
    }
    return s;
  }

  // Document-level reads that don't need a handle.
  globalThis.__csimDocumentHtml = function () {
    return globalThis.document.documentElement
      ? serializeElement(globalThis.document.documentElement)
      : '';
  };

  // Click resolver. PoC: maps an element click to one of three
  // outcomes the Ruby side knows how to drive:
  //   - {kind:'navigate', url}  — <a href>
  //   - {kind:'submit',   formHandle}  — submit-button inside <form>
  //   - null                    — everything else (checkbox/radio
  //     toggling happens inline so Ruby sees the new state on the
  //     follow-up read, and other clicks are no-ops until milestone 4
  //     lands event dispatch).
  globalThis.__csimClickResolve = function (h) {
    const n = lookup(h);
    if (!n || n.nodeType !== NODE_ELEMENT) return null;

    // checkbox / radio: toggle *before* the click dispatch so listeners
    // observe the new state. Mirrors what real browsers do (the IDL
    // mutation precedes the click event chain when the user clicks
    // a form control).
    let preToggled = null;
    if (n._tag === 'input') {
      const type = (n._attrs.type || '').toLowerCase();
      if (type === 'checkbox') { toggleChecked(n); preToggled = 'checkbox'; }
      else if (type === 'radio') { setRadio(n);   preToggled = 'radio'; }
    }

    const click = new Event('click', { bubbles: true, cancelable: true });
    dispatchEvent(n, click);
    if (click.defaultPrevented) return null;

    if (n._tag === 'a' && n._attrs.href != null) {
      return { kind: 'navigate', url: n._attrs.href };
    }
    if (isSubmitButton(n)) {
      const form = formForControl(n);
      if (!form) return null;
      const submit = new SubmitEvent('submit', { bubbles: true, cancelable: true, submitter: n });
      dispatchEvent(form, submit);
      if (submit.defaultPrevented) return null;
      return { kind: 'submit', formHandle: form._id, submitter: n._id };
    }
    return null;
  };
  function isContenteditable(n) {
    let cur = n;
    while (cur && cur.nodeType === NODE_ELEMENT) {
      const v = cur._attrs.contenteditable;
      if (v != null) {
        // contenteditable="" / "true" → editable; "false" → not.
        const lower = String(v).toLowerCase();
        if (lower === '' || lower === 'true' || lower === 'plaintext-only') return true;
        if (lower === 'false') return false;
      }
      cur = cur._parent;
    }
    return false;
  }

  function isSubmitButton(n) {
    if (n._tag === 'button') {
      const t = (n._attrs.type || 'submit').toLowerCase();
      return t === 'submit';
    }
    if (n._tag === 'input') {
      const t = (n._attrs.type || '').toLowerCase();
      return t === 'submit' || t === 'image';
    }
    return false;
  }
  function ancestorForm(n) {
    let cur = n._parent;
    while (cur && cur.nodeType === NODE_ELEMENT) {
      if (cur._tag === 'form') return cur;
      cur = cur._parent;
    }
    return null;
  }
  // HTML 5: a form control's owning form is resolved via either the
  // `form="<id>"` IDL attribute (looking up the form by id) or — when
  // absent — by walking ancestors. The attribute takes precedence
  // and is the only way to associate a button that lives *outside*
  // the form's DOM subtree.
  function formForControl(n) {
    const formId = n._attrs.form;
    if (formId) {
      const root = globalThis.document.documentElement;
      if (root) {
        const forms = root.getElementsByTagName('form');
        for (const f of forms) if (f._attrs.id === formId) return f;
      }
    }
    return ancestorForm(n);
  }
  function toggleChecked(n) {
    if (n._attrs.checked != null) delete n._attrs.checked;
    else n._attrs.checked = '';
  }
  function setRadio(n) {
    const name = n._attrs.name;
    if (name) {
      // siblings in same form sharing name: clear, then set this one
      const root = ancestorForm(n) || globalThis.document.documentElement;
      const candidates = root && root.querySelectorAll
        ? root.querySelectorAll('input')
        : [];
      for (const o of candidates) {
        if ((o._attrs.type || '').toLowerCase() === 'radio' && o._attrs.name === name) {
          delete o._attrs.checked;
        }
      }
    }
    n._attrs.checked = '';
  }

  // ── Form-field mutations ────────────────────────────────────────
  //
  // Ruby-side Capybara DSL (`fill_in 'X', with: 'Y'`, `choose`,
  // `select`) all eventually call Node#set / select_option /
  // unselect_option. Each is one Context#call into here.

  // send_keys: append text to a focusable control and fire `input`+
  // `change`. Mirrors what selenium does at this level — keydown/
  // keypress/keyup chain comes later when test pages depend on it.
  globalThis.__csimSendKeys = function (h, text) {
    const n = lookup(h);
    if (!n || n.nodeType !== NODE_ELEMENT) return false;
    if (n._tag === 'input' || n._tag === 'textarea') {
      if (n._attrs.readonly != null || n._attrs.disabled != null) return false;
      const cur = n._attrs.value != null ? n._attrs.value : '';
      const newVal = cur + String(text);
      const maxlen = parseInt(n._attrs.maxlength || '', 10);
      n._attrs.value = (maxlen > 0 && newVal.length > maxlen) ? newVal.slice(0, maxlen) : newVal;
      if (n._tag === 'textarea') {
        n._children = [Object.assign(new Text(n._attrs.value), { _parent: n })];
      }
      dispatchEvent(n, new InputEvent('input',  { bubbles: true, cancelable: true }));
      dispatchEvent(n, new Event('change', { bubbles: true, cancelable: false }));
      return true;
    }
    return false;
  };

  globalThis.__csimAncestorForm = function (h) {
    const n = lookup(h);
    if (!n) return 0;
    const f = ancestorForm(n);
    return f ? f._id : 0;
  };

  globalThis.__csimSetValue = function (h, value) {
    const n = lookup(h);
    if (!n || n.nodeType !== NODE_ELEMENT) return false;
    const tag = n._tag;
    // readonly / disabled inputs reject programmatic value changes —
    // mirrors what real browsers + selenium do.
    if ((tag === 'input' || tag === 'textarea') &&
        (n._attrs.readonly != null || n._attrs.disabled != null)) {
      return false;
    }
    const v = value == null ? '' : String(value);
    let kind = 'value';
    if (tag === 'textarea') {
      n._children = []; n._children.push(Object.assign(new Text(v), { _parent: n }));
      n._attrs.value = v;
    } else if (tag === 'input') {
      const type = (n._attrs.type || 'text').toLowerCase();
      if (type === 'checkbox' || type === 'radio') {
        if (value === true || value === 'true') {
          // Radio: setting one in a group clears the others on the
          // same `name`.
          if (type === 'radio') setRadio(n);
          else                  n._attrs.checked = '';
        } else if (value === false || value === 'false') delete n._attrs.checked;
        else n._attrs.value = v;
        kind = 'checked';
      } else {
        // Browsers truncate at maxlength when the user types; programmatic
        // assignment via the IDL setter does the same when the input is
        // a text-like control.
        const maxlen = parseInt(n._attrs.maxlength || '', 10);
        n._attrs.value = (maxlen > 0 && v.length > maxlen) ? v.slice(0, maxlen) : v;
      }
    } else if (tag === 'select') {
      // Match the first <option> whose value (or textContent fallback)
      // equals v; mark it selected, clear siblings.
      const opts = n.querySelectorAll('option');
      let hit = false;
      for (const o of opts) {
        const ov = o._attrs.value != null ? o._attrs.value : o.textContent;
        if (ov === v) { selectOptionExclusive(n, o); hit = true; break; }
      }
      if (!hit) return false;
    } else if (isContenteditable(n)) {
      // Capybara `.set('text')` on a contenteditable element replaces
      // the text content. Real browsers fire `input` (no `change`)
      // and don't touch a `value` attribute.
      n.textContent = v;
      dispatchEvent(n, new InputEvent('input', { bubbles: true, cancelable: true }));
      return true;
    } else {
      n._attrs.value = v;
    }
    // Fire `input` (cancellable, bubbles) then `change` (bubbles only).
    // For checkbox / radio real browsers fire `change` only on a real
    // user interaction, but Capybara's `set` mirrors what `selenium`
    // does — both events, so listeners see the update either way.
    dispatchEvent(n, new InputEvent('input',  { bubbles: true, cancelable: true }));
    dispatchEvent(n, new Event('change', { bubbles: true, cancelable: false }));
    return true;
  };
  function selectOptionExclusive(select, opt) {
    const multi = select._attrs.multiple != null;
    const opts = select.querySelectorAll('option');
    if (!multi) for (const o of opts) delete o._attrs.selected;
    opt._attrs.selected = '';
  }
  globalThis.__csimSelectOption = function (h) {
    const n = lookup(h);
    if (!n || n._tag !== 'option') return false;
    // walk up to <select>
    let sel = n._parent;
    while (sel && sel._tag !== 'select') sel = sel._parent;
    if (!sel) { n._attrs.selected = ''; return true; }
    selectOptionExclusive(sel, n);
    return true;
  };
  globalThis.__csimUnselectOption = function (h) {
    const n = lookup(h);
    if (!n || n._tag !== 'option') return false;
    delete n._attrs.selected;
    return true;
  };

  // Form serialise — mirrors urlencoded submit semantics. Skips:
  //   - inputs without `name`
  //   - disabled controls
  //   - unchecked checkbox / radio
  //   - file inputs (PoC: no multipart yet)
  //   - submit buttons other than the submitter
  globalThis.__csimFormSerialize = function (formHandle, submitterHandle) {
    const form = lookup(formHandle);
    if (!form || form._tag !== 'form') return null;
    const submitter = submitterHandle ? lookup(submitterHandle) : null;
    const fields = [];
    // HTML's `form` IDL: controls participate via either DOM ancestry
    // (descendant of the form) *or* an explicit `form="<form-id>"`
    // attribute pointing at the form. Skip descendant controls whose
    // `form` attr points elsewhere — they belong to another form.
    const inputs = [];
    for (const f of form.querySelectorAll('input,textarea,select,button')) {
      if (f._attrs.form == null || f._attrs.form === form._attrs.id) inputs.push(f);
    }
    const formId = form._attrs.id;
    if (formId) {
      for (const f of globalThis.document.documentElement.querySelectorAll('input,textarea,select,button')) {
        if (f._attrs.form === formId && !inputs.includes(f)) inputs.push(f);
      }
    }
    for (const f of inputs) {
      if (!f._attrs.name) continue;
      if (f._attrs.disabled != null) continue;
      const tag = f._tag;
      const name = f._attrs.name;
      if (tag === 'input') {
        const type = (f._attrs.type || 'text').toLowerCase();
        if (type === 'submit' || type === 'image' || type === 'reset' || type === 'button') {
          if (f !== submitter) continue;
          fields.push([name, f._attrs.value != null ? f._attrs.value : '']);
          continue;
        }
        if (type === 'checkbox' || type === 'radio') {
          if (f._attrs.checked == null) continue;
          fields.push([name, f._attrs.value != null ? f._attrs.value : 'on']);
          continue;
        }
        if (type === 'file') continue; // PoC: skip until multipart support
        fields.push([name, f._attrs.value != null ? f._attrs.value : '']);
      } else if (tag === 'textarea') {
        // HTML form-submission spec normalizes textarea LF to CRLF.
        const raw = f._attrs.value != null ? f._attrs.value : f.textContent;
        fields.push([name, String(raw).replace(/\r\n|\r|\n/g, '\r\n')]);
      } else if (tag === 'select') {
        const multi = f._attrs.multiple != null;
        const opts = f.querySelectorAll('option');
        let chose = false;
        for (const o of opts) {
          if (o._attrs.selected != null) {
            const v = o._attrs.value != null ? o._attrs.value : o.textContent;
            fields.push([name, v]);
            chose = true;
            if (!multi) break;
          }
        }
        // Implicit selection: single-select non-multi falls back to
        // first non-disabled option (mirrors browser submit).
        if (!chose && !multi) {
          for (const o of opts) {
            if (o._attrs.disabled != null) continue;
            const v = o._attrs.value != null ? o._attrs.value : o.textContent;
            fields.push([name, v]);
            break;
          }
        }
      } else if (tag === 'button') {
        const type = (f._attrs.type || 'submit').toLowerCase();
        if (type !== 'submit') continue;
        if (f !== submitter) continue;
        fields.push([name, f._attrs.value != null ? f._attrs.value : '']);
      }
    }
    // HTML 5: a `<button formaction="...">` / `<button formmethod>` /
    // `<button formenctype>` on the submitter overrides the form's
    // attributes for that one submission.
    const subAction  = submitter && submitter._attrs && submitter._attrs.formaction;
    const subMethod  = submitter && submitter._attrs && submitter._attrs.formmethod;
    const subEnctype = submitter && submitter._attrs && submitter._attrs.formenctype;
    return {
      action:  subAction  != null ? subAction  : (form._attrs.action  != null ? form._attrs.action  : ''),
      method:  (subMethod  || form._attrs.method  || 'get').toLowerCase(),
      enctype: (subEnctype || form._attrs.enctype || 'application/x-www-form-urlencoded').toLowerCase(),
      fields: fields
    };
  };

  // ── Virtual clock + timer queue ─────────────────────────────────
  //
  // Lifted from v2 bridge.js. Tests don't sleep; Ruby calls
  // `__drainTimers(N)` (`tick_real_time`) before each find / has_? so
  // the virtual clock advances by however much wall-clock has actually
  // elapsed between Capybara polls. `__setTimersActive` flips the
  // Ruby-side `timers_active` flag so `Driver#wait?` returns true
  // while work is pending.

  const __timers = new Map();        // id → {handler, args, due, period?}
  let   __nextTimerId = 1;
  let   __virtualNow  = 0;

  function scheduleTimer(handler, ms, args, period) {
    if (typeof handler !== 'function') return 0;
    const id = __nextTimerId++;
    const delay = Math.max(0, +ms || 0);
    const wasEmpty = __timers.size === 0;
    __timers.set(id, { handler, args, due: __virtualNow + delay, period });
    if (wasEmpty) __setTimersActive(true);
    return id;
  }

  globalThis.setTimeout    = function (h, ms, ...a) { return scheduleTimer(h, ms, a, null); };
  globalThis.setInterval   = function (h, ms, ...a) { return scheduleTimer(h, ms, a, Math.max(1, +ms || 0)); };
  globalThis.clearTimeout  = function (id) {
    if (__timers.delete(id) && __timers.size === 0) __setTimersActive(false);
  };
  globalThis.clearInterval = globalThis.clearTimeout;
  globalThis.requestAnimationFrame = function (cb) {
    return scheduleTimer(() => cb(__virtualNow), 16, [], null);
  };
  globalThis.cancelAnimationFrame = globalThis.clearTimeout;
  // queueMicrotask: collapse to setTimeout(0). True microtasks run
  // before the next macrotask, but on a virtual clock the difference
  // is unobservable for the workloads we care about.
  globalThis.queueMicrotask = function (cb) { scheduleTimer(cb, 0, [], null); };

  globalThis.__virtualNow    = () => __virtualNow;
  globalThis.__hasReadyTimer = function () {
    for (const t of __timers.values()) if (t.due <= __virtualNow) return true;
    return false;
  };

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
      if (t.period != null) t.due = __virtualNow + t.period;
      else __timers.delete(nextId);
      try { t.handler.apply(null, t.args || []); }
      catch (e) {
        try { console.error('[csim v3] timer threw:', e && e.message); } catch (_) {}
      }
      if (__observers.size && __pendingRecords.length) deliverMutations();
    }
    // Pin clock at limit even when nothing fired, so a follow-up
    // drain reflects cumulative elapsed time.
    if (__virtualNow < limit) __virtualNow = limit;
    if (__timers.size === 0) __setTimersActive(false);
  };

  globalThis.__resetTimers = function () {
    const had = __timers.size > 0;
    __timers.clear();
    __virtualNow = 0;
    if (had) __setTimersActive(false);
  };

  globalThis.__resetPage = function () {
    globalThis.document = new Document();
    __handles.clear();
    registerNode(globalThis.document);
    __resetTimers();
  };

})();
