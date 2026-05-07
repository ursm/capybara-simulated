// bridge: thin DOM proxy backed by Ruby callbacks via `__dom(handle, op, args)`.
// Every method delegates straight through to Capybara::Simulated::Browser#dom_op.
// Keep the implementation small — adding a method here means adding a case in
// Browser#dom_op too.

(function () {
  // Identity is per-handle — Stimulus's `this.element === event.target`
  // would otherwise fail because each access creates a fresh wrapper.
  // Cleared in __resetPage (handle reuse + ceUpgrade prototype swaps).
  const __wrappers = new Map();
  // CharacterData covers TEXT (3), CDATA_SECTION (4), COMMENT (8) — the
  // node types whose payload lives in `nodeValue` / `data`.
  const isCharacterDataType = t => t === 3 || t === 4 || t === 8;
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
    querySelectorAll(s) { return NodeList.from(__dom(this.__h, 'querySelectorAll', [s]), wrap); }
    getElementById(id)  { return wrap(__dom(this.__h, 'getElementById', [id])); }
    closest(s)          { return wrap(__dom(this.__h, 'closest', [s])); }
    matches(s)          { return !!__dom(this.__h, 'matches', [s]); }
    contains(other)     { return !!__dom(this.__h, 'contains', [other && other.__h]); }

    // Tree pointers
    get parentNode()             { return wrap(__dom(this.__h, 'parentNode')); }
    get parentElement()          { return wrap(__dom(this.__h, 'parentElement')); }
    get firstChild()             { return wrap(__dom(this.__h, 'firstChild')); }
    get lastChild()              { return wrap(__dom(this.__h, 'lastChild')); }
    get nextSibling()            { return wrap(__dom(this.__h, 'nextSibling')); }
    get previousSibling()        { return wrap(__dom(this.__h, 'previousSibling')); }
    get children()               { return HTMLCollection.from(__dom(this.__h, 'children'), wrap); }
    get childNodes()             { return NodeList.from(__dom(this.__h, 'childNodes'), wrap); }
    get firstElementChild()      { return wrap(__dom(this.__h, 'firstElementChild')); }
    get lastElementChild()       { return wrap(__dom(this.__h, 'lastElementChild')); }
    get nextElementSibling()     { return wrap(__dom(this.__h, 'nextElementSibling')); }
    get previousElementSibling() { return wrap(__dom(this.__h, 'previousElementSibling')); }
    get childElementCount()      { return __dom(this.__h, 'childElementCount'); }
    hasChildNodes()              { return this.childNodes.length > 0; }

    // Identity / shape
    get nodeType()    { return __dom(this.__h, 'nodeType'); }
    get nodeName()    { return __dom(this.__h, 'nodeName'); }
    get tagName()     { return __dom(this.__h, 'tagName'); }
    // Preact 11's diff (`diff/index.js`'s element-reuse check) compares
    // `value.localName == nodeType` where `nodeType` is the lowercase
    // JSX tag name. Without this getter the comparison is
    // `undefined == "form"` and Preact creates a fresh element instead
    // of reusing the existing DOM, surfacing as duplicate static + Preact
    // forms on Forem's article-form mount.
    get localName()   { const t = this.tagName; return t ? t.toLowerCase() : t; }
    // Turbo's `dispatch` retargets events to documentElement when the
    // requested target isn't connected.
    get isConnected() { return !!__dom(0, 'contains', [this.__h]); }
    get textContent() { return __dom(this.__h, 'textContent'); }
    set textContent(v) { __dom(this.__h, 'setTextContent', [String(v)]); }
    // CharacterData#data — alias for the text payload on text /
    // comment nodes; turndown reads `node.data.replace(...)` while
    // walking text descendants. Undefined for element nodes per spec.
    get data()  { return isCharacterDataType(this.nodeType) ? this.textContent : undefined; }
    set data(v) { if (isCharacterDataType(this.nodeType)) this.textContent = v; }
    // IDL alias for textContent on script / title / style elements.
    get text()         { return __dom(this.__h, 'textContent'); }
    set text(v)        { this.textContent = v; }
    get innerText()   { return __dom(this.__h, 'innerText'); }
    set innerText(v)  { this.textContent = v; }
    get innerHTML()   { return __dom(this.__h, 'innerHTML'); }
    set innerHTML(v)  { __dom(this.__h, 'setInnerHTML', [String(v)]); }
    get outerHTML()   { return __dom(this.__h, 'outerHTML'); }
    set outerHTML(v)  { __dom(this.__h, 'setOuterHTML', [String(v)]); }
    // Forem's infinite-scroll inserts batches via
    // `followList.insertAdjacentHTML('beforeend', ...)`. Without it
    // the fetch chain throws, leaves `fetching` stuck at true, and
    // every subsequent setInterval call short-circuits on the
    // `!fetching` guard.
    insertAdjacentHTML(position, html) {
      const holder = document.createElement('div');
      holder.innerHTML = String(html);
      this._insertAdjacent(position, Array.from(holder.childNodes));
    }
    insertAdjacentElement(position, element) {
      this._insertAdjacent(position, [element]);
      return element;
    }
    insertAdjacentText(position, text) {
      this._insertAdjacent(position, [document.createTextNode(String(text))]);
    }

    // <dialog>.show / .showModal / .close — Forem opens user-suspension /
    // unpublish-post modals via the native dialog API. We can't model
    // top-layer rendering, but flipping the `open` attribute (which
    // Forem reads back) plus dispatching the spec's `close` event is
    // enough for those tests to drive the dialog state machine.
    show() {
      if (this.tagName !== 'DIALOG') return;
      this.setAttribute('open', '');
    }
    showModal() {
      if (this.tagName !== 'DIALOG') return;
      this.setAttribute('open', '');
    }
    close(returnValue) {
      if (this.tagName !== 'DIALOG') return;
      if (returnValue !== undefined) this.returnValue = String(returnValue);
      this.removeAttribute('open');
      __dispatch(this, new Event('close', {bubbles: false, cancelable: false}));
    }
    // Web Animations API — without a real animation pipeline we can
    // hand back an Animation-shaped object whose `.finished` resolves
    // immediately, so call sites that `await el.animate(...).finished`
    // proceed instead of hanging on a never-resolving Promise.
    animate(_keyframes, _options) {
      const finished = Promise.resolve();
      return {
        play()        {},
        pause()       {},
        cancel()      {},
        finish()      {},
        reverse()     {},
        commitStyles(){},
        addEventListener() {},
        removeEventListener() {},
        playbackRate: 1,
        currentTime:  0,
        startTime:    0,
        playState:    'finished',
        finished,
        ready:        finished
      };
    }
    getAnimations() { return []; }
    _insertAdjacent(position, nodes) {
      switch (String(position).toLowerCase()) {
        case 'beforebegin':
          if (this.parentNode) for (const n of nodes) this.parentNode.insertBefore(n, this);
          break;
        case 'afterbegin':
          for (const n of nodes.reverse()) this.insertBefore(n, this.firstChild);
          break;
        case 'beforeend':
          for (const n of nodes) this.appendChild(n);
          break;
        case 'afterend':
          if (this.parentNode) {
            const ref = this.nextSibling;
            for (const n of nodes) this.parentNode.insertBefore(n, ref);
          }
          break;
        default:
          throw new Error('invalid insertAdjacent position');
      }
    }

    // Attributes
    getAttribute(name)        { return __dom(this.__h, 'getAttribute', [String(name)]); }
    hasAttribute(name)        { return !!__dom(this.__h, 'hasAttribute', [String(name)]); }
    setAttribute(name, value) {
      const n = String(name), v = String(value);
      const oldVal = __dom(this.__h, 'setAttribute', [n, v]);
      if (__ceInstances.has(this.__h)) ceMaybeAttributeChanged(this, n, oldVal, v);
    }
    removeAttribute(name) {
      const n = String(name);
      const oldVal = __dom(this.__h, 'removeAttribute', [n]);
      if (__ceInstances.has(this.__h)) ceMaybeAttributeChanged(this, n, oldVal, null);
    }
    // NamedNodeMap-shaped: array-iterable AND name-indexable. jQuery
    // does `el.attributes[name].expando` for feature detection, so we
    // return Attr-like records on each named slot.
    get attributes() {
      const pairs = __dom(this.__h, 'attributes');
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
    get value()     { return __dom(this.__h, 'value'); }
    set value(v)    {
      __dom(this.__h, 'setValue', [v == null ? '' : String(v)]);
      // Real browsers move the caret to the end after a programmatic
      // value write — Tribute.js / autocomplete libraries read
      // `selectionStart` to find the trigger position; without
      // updating it on write, they think the caret never moved.
      const n = this.value ? this.value.length : 0;
      this._selStart = this._selEnd = n;
    }
    // Selection state. Real browsers track caret position on text-like
    // inputs / textareas; we model just the offsets, no direction. Set
    // by `setSelectionRange` / `select` and on programmatic value writes.
    // Default for an unset caret is end-of-value, matching freshly
    // focused fields in real browsers.
    get _caretDefault() { return this.value ? this.value.length : 0; }
    get selectionStart() { return this._selStart ?? this._caretDefault; }
    set selectionStart(v) { this._selStart = +v || 0; }
    get selectionEnd()   { return this._selEnd   ?? this._caretDefault; }
    set selectionEnd(v)  { this._selEnd = +v || 0; }
    get selectionDirection() { return 'none'; }
    set selectionDirection(_) {}
    get checked()   { return !!__dom(this.__h, 'checked'); }
    set checked(v)  { __dom(this.__h, 'setChecked', [!!v]); }
    get disabled()  { return !!__dom(this.__h, 'disabled'); }
    set disabled(v) { setBoolAttr(this, 'disabled', v); }
    get hidden()    { return !!__dom(this.__h, 'hidden'); }
    set hidden(v)   { setBoolAttr(this, 'hidden', v); }
    // <select multiple> reflects via `select.multiple`; jQuery's
    // valHooks branch on it and Redmine's dual-listbox JS reads it.
    get multiple()  { return this.hasAttribute('multiple'); }
    set multiple(v) { setBoolAttr(this, 'multiple', v); }
    get readOnly()  { return this.hasAttribute('readonly'); }
    set readOnly(v) { setBoolAttr(this, 'readonly', v); }
    get required()  { return this.hasAttribute('required'); }
    set required(v) { setBoolAttr(this, 'required', v); }
    // <option>.selected — jQuery's `.serialize()` walks `select.options`
    // and reads `option.selected` to find the chosen entry; without a
    // getter the read returned undefined and the form posted whichever
    // option the server marked as selected, even after `select_option`.
    // Setter routes through `setOptionSelected` so the Ruby side can
    // clear sibling options on a single-select (HTML IDL semantics)
    // and write the literal `selected="selected"` attribute Redmine's
    // form-update post-ready script keys off (`option[selected=selected]`).
    get selected()  { return !!__dom(this.__h, 'selected'); }
    set selected(v) { __dom(this.__h, 'setOptionSelected', [!!v]); }

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
    get type() {
      // <select>.type is "select-one" / "select-multiple" per the IDL,
      // with no underlying `type` attribute. jQuery's `valHooks.select`
      // gates on this to decide whether `.val()` returns a string or
      // an array; getAttribute('type') would always be '' and force
      // the multi-select branch on a single-select.
      if (this.tagName === 'SELECT') {
        return this.hasAttribute('multiple') ? 'select-multiple' : 'select-one';
      }
      return this.getAttribute('type') || '';
    }
    set type(v)        { this.setAttribute('type', v); }
    // <select>.selectedIndex — jQuery's `valHooks.select.get` reads
    // it (and treats undefined as NaN, returning null on single-selects).
    // Both getter and setter route through Ruby in one round-trip;
    // the JS-side iterate-and-set-each-option alternative is O(N²)
    // because each setter call clears every sibling's `selected` attr.
    get selectedIndex()  { return this.tagName === 'SELECT' ? __dom(this.__h, 'selectedIndex') : undefined; }
    set selectedIndex(v) { if (this.tagName === 'SELECT') __dom(this.__h, 'setSelectedIndex', [+v]); }
    // Reflected so JS-set values are also visible via getAttribute /
    // node['title'] — Redmine's jstoolbar does `button.title = ...`
    // and the `[title="..."]` Capybara filter reads the attribute.
    get title()        { return this.getAttribute('title') || ''; }
    set title(v)       { this.setAttribute('title', v == null ? '' : String(v)); }
    get alt()          { return this.getAttribute('alt') || ''; }
    set alt(v)         { this.setAttribute('alt', v == null ? '' : String(v)); }
    get placeholder()  { return this.getAttribute('placeholder') || ''; }
    set placeholder(v) { this.setAttribute('placeholder', v == null ? '' : String(v)); }

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
    // Owning <form> for a form-control. For `<form>` itself we wrap
    // the element in a Proxy that exposes named-element access
    // (`form.foo` / `form['foo']`) — legacy code (Redmine's
    // `moveOptions(this.form.selected_X, …)` inline handler) relies
    // on it.
    get form() {
      const f = wrap(__dom(this.__h, 'form'));
      return f && f.tagName === 'FORM' ? namedFormProxy(f) : f;
    }
    // HTMLFormElement.elements: HTMLFormControlsCollection of
    // submittable descendants, addressable by `[i]`, `.namedItem(n)`,
    // and (via the Proxy) `[name]` / `.name`. rails-ujs / jQuery
    // serialize forms via this.
    get elements() {
      if (this.tagName !== 'FORM') return null;
      return namedCollection(HTMLCollection.from(this.querySelectorAll('input, select, textarea, button, fieldset, output, object')));
    }

    // <input list="...">'s referenced <datalist>, plus its options. Used
    // by Capybara's datalist-option resolver via element.evaluate_script.
    get list()    { return wrap(__dom(this.__h, 'list')); }
    get options() { return __dom(this.__h, 'options').map(wrap); }
    // <option>.label — falls back to text content when no label attr.
    get label()   { return __dom(this.__h, 'label'); }

    // HTML5 form validation. Constraint computation lives on the Ruby
    // side (see Browser#compute_validity); these proxy through.
    get validity()           { return __dom(this.__h, 'validity'); }
    get validationMessage()  { return __dom(this.__h, 'validationMessage'); }
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
    // Text / comment / CDATA carry the payload as nodeValue; elements
    // and the document return null per spec. Turndown reads
    // `node.nodeValue` for text descendants and `null.replace(...)` is
    // the immediate symptom when the getter is uniform.
    get nodeValue()  { return isCharacterDataType(this.nodeType) ? this.textContent : null; }
    set nodeValue(v) { if (isCharacterDataType(this.nodeType)) this.textContent = v; }
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
    // No layout engine, so scrollHeight is fictional — but some
    // libraries (Avo's trix-body controller) gate the "content is too
    // tall, show 'more' link" decision on `scrollHeight > 50`. Return
    // a value that's non-zero whenever the element has any rendered
    // text or child elements, so those gates fire on populated content
    // and stay quiet on empty placeholders. Real-pixel callers
    // (CodeMirror's gutter, etc.) typically clamp to a min anyway.
    get scrollHeight() {
      const txt = (__dom(this.__h, 'textContent') || '').length;
      const kids = __dom(this.__h, 'childCount') || 0;
      return txt === 0 && kids === 0 ? 0 : Math.max(txt, kids * 18, 100);
    }
    get scrollLeft()         { return 0; }
    get scrollTop()          { return 0; }
    set scrollLeft(v)        {}
    set scrollTop(v)         {}
    scrollIntoView()         {}
    scrollTo()               {}
    focus()                  { __dom(this.__h, 'focus'); }
    blur()                   { __dom(this.__h, 'blur'); }
    click()                  { __dom(this.__h, 'click'); }
    setSelectionRange(start, end, _direction) {
      this._selStart = +start || 0;
      this._selEnd   = +end   || 0;
    }
    select() {
      this._selStart = 0;
      this._selEnd   = this.value ? this.value.length : 0;
    }
    // setRangeText(replacement, [start], [end], [selectionMode])
    // Replaces text within an input / textarea. Default range is the
    // current selection. Stimulus paste handlers (Redmine's
    // table-paste controller) call this to swap the typed-in chunk
    // with a Markdown / Textile-rendered table.
    setRangeText(replacement, start, end, selectionMode) {
      const v   = this.value || '';
      const str = String(replacement == null ? '' : replacement);
      const s   = start === undefined ? this.selectionStart : (+start || 0);
      const e   = end   === undefined ? this.selectionEnd   : (+end   || 0);
      const lo  = Math.min(s, e), hi = Math.max(s, e);
      this.value = v.slice(0, lo) + str + v.slice(hi);
      // Per spec: 'end' moves caret to past the inserted text, others
      // collapse / preserve selection. We model only the common case.
      const tail = lo + str.length;
      if (selectionMode === 'select')      { this._selStart = lo;   this._selEnd = tail; }
      else if (selectionMode === 'start')  { this._selStart = lo;   this._selEnd = lo;   }
      else                                 { this._selStart = tail; this._selEnd = tail; }
    }

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
    // SVG / MathML namespaced creation. Without a separate XML model
    // we hand back a plain element keyed on the local name; libraries
    // (Algolia Autocomplete, the search controller) only round-trip
    // attributes and structure, so the namespace is informational.
    createElementNS(_ns, tag)  { return wrap(__dom(this.__h, 'createElement',         [String(tag)])); }
    createTextNode(text)      { return wrap(__dom(this.__h, 'createTextNode',        [String(text)])); }
    createComment(text)       { return wrap(__dom(this.__h, 'createComment',         [String(text)])); }
    createDocumentFragment()  { return wrap(__dom(this.__h, 'createDocumentFragment')); }

    // Shadow DOM. Ruby keeps the shadow tree as a DocumentFragment in
    // Browser#shadow_roots, keyed by host handle; the wrapper reads
    // through the same dom_op surface as any other element.
    attachShadow(_init)  { return wrap(__dom(this.__h, 'attachShadow')); }
    get shadowRoot()     { return wrap(__dom(this.__h, 'shadowRoot')); }
    // Attribute object isn't really used by libraries except for
    // existence-checks; return a plain shape with name/value.
    createAttribute(name)     { return {name: String(name), value: '', specified: true}; }

    // getElementsBy* — jQuery / older libs probe for these directly.
    // Real browsers return an HTMLCollection (live in spec, but tests
    // rely on the `.item(i)` / `.namedItem(n)` shape, not liveness).
    getElementsByTagName(tag)   { return HTMLCollection.from(__dom(this.__h, 'getElementsByTagName',   [String(tag)]), wrap); }
    getElementsByClassName(cls) { return HTMLCollection.from(__dom(this.__h, 'getElementsByClassName', [String(cls)]), wrap); }
    getElementsByName(name)     { return HTMLCollection.from(__dom(this.__h, 'getElementsByName',      [String(name)]), wrap); }

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

    // DOMStringMap-shaped dataset. Stimulus reads `event.currentTarget.dataset.id`
    // for `<button data-id="...">`; without this it gets undefined.
    get dataset() { return makeDataset(this); }

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
    // Turbo's link-as-DELETE flow synthesises a hidden form and drives
    // its FormSubmitObserver via this; without it the submission never
    // happens and the link falls through to a regular GET.
    requestSubmit(submitter) {
      __dispatch(this, new SubmitEvent('submit', {bubbles: true, cancelable: true, submitter}));
    }
    // HTMLFormElement.submit() — spec says no `submit` event is fired
    // and validation is bypassed. We still dispatch one because that's
    // the cancellation point rails-ujs / Turbo / app code listens on
    // (jQuery's `$(form).submit()` falls through to this). If nothing
    // preventDefault'd, fall through to the actual Rack submission.
    submit() {
      const ev = new SubmitEvent('submit', {bubbles: true, cancelable: true, submitter: null});
      const proceed = __dispatch(this, ev);
      if (proceed) __dom(this.__h, 'submitForm');
    }
  }

  // Inline-event-handler properties (`onclick`, `onsubmit`, …). Two
  // reasons we need them on the prototype:
  //
  // - Preact 11's `setProperty` infers event-name casing by checking
  //   `'onclick' in dom`; if missing, it registers the listener under
  //   the JSX-literal name (`Click`) and the lowercase `click` event
  //   we dispatch never reaches the handler. Surfaces as Forem's
  //   `<button onClick={onPublish}>` silently doing nothing.
  // - Legacy `el.onclick = fn` assignment is still common in older
  //   pages and Stimulus mixins; round-tripping through
  //   `addEventListener` keeps the firing path identical to a JSX
  //   `onClick` registration.
  const __INLINE_EVENT_NAMES = [
    'click', 'dblclick', 'contextmenu',
    'mousedown', 'mouseup', 'mouseover', 'mouseout',
    'mouseenter', 'mouseleave', 'mousemove', 'wheel',
    'focus', 'blur', 'focusin', 'focusout',
    'keydown', 'keyup', 'keypress',
    'input', 'change', 'submit', 'reset', 'select',
    'load', 'error', 'scroll', 'resize',
    'touchstart', 'touchend', 'touchmove', 'touchcancel',
    'drag', 'dragstart', 'dragend', 'dragover', 'dragenter', 'dragleave', 'drop',
    'animationstart', 'animationend', 'animationiteration',
    'transitionstart', 'transitionend', 'transitionrun', 'transitioncancel',
    'pointerdown', 'pointerup', 'pointermove', 'pointerover', 'pointerout',
    'pointerenter', 'pointerleave', 'pointercancel',
    'beforeinput', 'compositionstart', 'compositionupdate', 'compositionend',
    'paste', 'copy', 'cut',
    'invalid', 'beforeunload', 'unload',
    'play', 'pause', 'ended', 'timeupdate', 'volumechange',
    'toggle', 'close', 'cancel'
  ];
  const __INLINE_EVENT_KEY = '__on_';
  for (const ev of __INLINE_EVENT_NAMES) {
    Object.defineProperty(Element.prototype, 'on' + ev, {
      configurable: true,
      get() { return this[__INLINE_EVENT_KEY + ev] || null; },
      set(v) {
        const key = __INLINE_EVENT_KEY + ev;
        const old = this[key];
        if (old) this.removeEventListener(ev, old);
        this[key] = v;
        if (typeof v === 'function') this.addEventListener(ev, v);
      }
    });
  }

  // CSSStyleDeclaration shim. Wraps a Proxy so libraries that touch
  // `el.style.backgroundColor` (camelCase) and `el.style['background-color']`
  // (kebab) both flow through getPropertyValue / setProperty against the
  // underlying `style` attribute.
  function setBoolAttr(el, name, on) {
    if (on) el.setAttribute(name, '');
    else    el.removeAttribute(name);
  }

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

  // DOMStringMap. dataset.fooBar reads `data-foo-bar`; assignments
  // write through to the attribute. Naming conversion follows the HTML
  // spec: lowercase ASCII after `-` becomes uppercase on read; uppercase
  // on write becomes `-` + lowercase. Symbols / inherited keys fall
  // through so JS engines that probe Symbol.toPrimitive etc. don't trip.
  function camelToDataAttr(name) {
    return 'data-' + String(name).replace(/[A-Z]/g, m => '-' + m.toLowerCase());
  }
  function makeDataset(el) {
    return new Proxy({__el: el}, {
      get(t, p) {
        if (typeof p === 'symbol' || p === '__el') return t[p];
        const v = el.getAttribute(camelToDataAttr(p));
        return v == null ? undefined : v;
      },
      set(_t, p, v) {
        if (typeof p === 'symbol') return false;
        el.setAttribute(camelToDataAttr(p), String(v));
        return true;
      },
      deleteProperty(_t, p) {
        if (typeof p === 'symbol') return false;
        el.removeAttribute(camelToDataAttr(p));
        return true;
      },
      has(_t, p) {
        if (typeof p === 'symbol') return false;
        return el.hasAttribute(camelToDataAttr(p));
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
    // DOMTokenList#replace(old, new) — swaps a token in place.
    replace(oldToken, newToken) {
      const cur = this._list();
      const i   = cur.indexOf(String(oldToken));
      if (i < 0) return false;
      cur[i] = String(newToken);
      this._write(cur);
      return true;
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
  // Run an inline-style handler and honour `return false` as
  // preventDefault (the legacy `<a onclick="...">` contract). Listener
  // exceptions are swallowed so dispatch continues, matching browsers.
  function runInlineHandler(label, fn, el, event) {
    try {
      if (fn.call(el, event) === false) event.preventDefault();
    } catch (e) {
      try { console.error(label + ' threw:', e && e.message ? e.message : e); } catch (_) {}
    }
  }
  function invokeInlineHandler(el, event) {
    // Property-style handler (`element.onkeydown = fn`) — jstoolbar
    // assigns these directly rather than using addEventListener.
    const propFn = el['on' + event.type];
    if (typeof propFn === 'function') runInlineHandler('property handler', propFn, el, event);

    const body = el.getAttribute('on' + event.type);
    if (body == null || body === '') return;
    let fn = __inlineCache.get(body);
    if (!fn) {
      try { fn = new Function('event', body); } catch (_) { __inlineCache.set(body, false); return; }
      __inlineCache.set(body, fn);
    }
    if (fn === false) return;
    runInlineHandler('inline handler', fn, el, event);
  }

  function __dispatch(target, event) {
    if (!target) return true;
    event.target = target;
    // Legacy `window.event` global. IE-era code (and Redmine's
    // Tribute config closure) reads `event.target.type` directly
    // without taking it as a parameter; without this set the handler
    // throws ReferenceError mid-dispatch and the dropdown silently
    // never populates. Cleared after dispatch so reentrant access
    // outside a handler doesn't see stale state.
    const __prevEvent = globalThis.event;
    globalThis.event = event;
    try {
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
    } finally {
      globalThis.event = __prevEvent;
    }
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

  // Typed subclass for click / submit / input so libraries that gate on
  // `event instanceof MouseEvent` (Turbo's LinkClickObserver) see what
  // they expect. Other types fall back to plain Event.
  const EVENT_CTOR_BY_TYPE = {
    click:       MouseEvent,
    dblclick:    MouseEvent,
    mousedown:   MouseEvent,
    mouseup:     MouseEvent,
    mousemove:   MouseEvent,
    mouseover:   MouseEvent,
    mouseout:    MouseEvent,
    mouseenter:  MouseEvent,
    mouseleave:  MouseEvent,
    contextmenu: MouseEvent,
    submit:      SubmitEvent,
    input:       InputEvent,
    keydown:     KeyboardEvent,
    keyup:       KeyboardEvent,
    keypress:    KeyboardEvent
  };

  // Called from Ruby (`browser.dispatch_event`). Returns true if no
  // listener prevented the default action — Ruby uses that to decide
  // whether to navigate, submit, etc. Integer-handle fields on init
  // (e.g. `submitter`) get wrapped so listeners see Element instances.
  globalThis.__dispatchFromRuby = function (handle, type, init) {
    const i = init || {};
    if (typeof i.submitter === 'number') i.submitter = wrap(i.submitter);
    const Ctor = EVENT_CTOR_BY_TYPE[type] || Event;
    return __dispatch(wrap(handle), new Ctor(type, i));
  };
  // Send a keyboard event with the right shape for the page-level
  // listeners that read e.keyCode / e.which (legacy but still common).
  // `extra` carries the modifier flags + `key:` string from send_keys's
  // chord state.
  globalThis.__dispatchKeyFromRuby = function (handle, type, keyCode, extra) {
    return __dispatch(wrap(handle), new KeyboardEvent(type, {
      bubbles: true, cancelable: true,
      keyCode: keyCode, which: keyCode, charCode: type === 'keypress' ? keyCode : 0,
      ...(extra || {})
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
        try { console.error('timer threw:', e && e.stack ? e.stack : (e && e.message ? e.message : e)); } catch (_) {}
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
    // Window listeners stay attached — Turbo's LinkClickObserver and
    // any global event hooks set up once at init must still fire after
    // a same-realm "navigation". Per-element __listeners are mostly
    // stale though (handles get reassigned), so they get cleared with
    // a remap of just the document-anchor entries below.
    __styleFacades.clear();
    // Without this, every fresh page loses Turbo's
    // FormSubmitObserver / FormLinkClickObserver listeners (attached to
    // document / documentElement once at init time).
    const anchorListeners = ANCHOR_REFS.flatMap(ref => {
      const tgt = resolveLogicalAnchor(ref);
      const byType = tgt && __listeners.get(tgt.__h);
      return byType ? [[ref, byType]] : [];
    });
    __listeners.clear();
    // Custom-element registrations are SET globally by Turbo's ESM
    // bundle, which loads once via vm.import and never re-runs across
    // navigations. Clearing __ceDefs would orphan the registry — new
    // pages' <turbo-frame> elements would never upgrade. We keep the
    // registry but drop all per-element instance state and re-arm the
    // mutation observer against the freshly-parsed document.
    __ceInstances.clear();
    __ceWaiters.clear();
    // Drop the old CE-upgrade observer from __observers BEFORE snapshotting
    // — ceEnsureObserver() below re-creates a fresh one, and replaying a
    // synthetic initial-scan record into the old instance would walk every
    // descendant of the new body via ceUpgradeTree (O(N) Ruby↔JS hops),
    // tripping the QuickJS 5s timeout on large pages.
    if (__ceObserver) __observers.delete(__ceObserver);
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
    globalThis.localStorage._reset();
    globalThis.sessionStorage._reset();
    globalThis.navigator.clipboard._reset();
    // Re-attach the CE observer + upgrade existing matches in the
    // freshly-parsed document.
    if (__ceDefs.size > 0) {
      ceEnsureObserver();
      for (const [tag] of __ceDefs) {
        for (const el of document.querySelectorAll(tag)) ceUpgrade(el);
      }
    }
    __listenerCounts.clear();
    for (const [ref, byType] of anchorListeners) {
      const tgt = resolveLogicalAnchor(ref);
      if (!tgt) continue;
      __listeners.set(tgt.__h, byType);
      for (const [type, arr] of byType) {
        __listenerCounts.set(type, (__listenerCounts.get(type) || 0) + arr.length);
      }
    }
    for (const [type, count] of __listenerCounts) {
      if (count > 0) __setListenedType(type, true);
    }
    for (const [type, arr] of __windowListeners) {
      if (arr.length > 0) __setListenedType(type, true);
    }
    return rebindObservers(stashedObservers);
  };

  const ANCHOR_REFS = ['document', 'documentElement', 'body', 'head'];

  // Re-bind observers whose targets were tagged as document anchors to
  // the fresh wrappers, then emit a synthetic childList record so they
  // re-discover the new tree's `data-controller` / `data-action` —
  // Stimulus's BindingObserver attaches once and never re-runs.
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
    return initialScans.length;
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
    scheduleObserverFlush(obs);
  }

  function scheduleObserverFlush(obs) {
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
      scheduleObserverFlush(obs);
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
  // querySelectorAll / Element.children return Array subclasses with the
  // spec methods — `.item(i)` for both, `.namedItem(n)` for HTMLCollection.
  // Mostly-array semantics (indexed access, .length, iteration, .map etc.)
  // are inherited; live-ness is not modelled, but tests rarely depend on it.
  globalThis.NodeList = class NodeList extends Array {
    item(i) { return this[i] ?? null; }
  };
  globalThis.HTMLCollection = class HTMLCollection extends Array {
    item(i)      { return this[i] ?? null; }
    namedItem(n) { return this.find(el => el && (el.id === n || el.name === n)) ?? null; }
  };
  // Named-element access for HTMLFormControlsCollection — `coll[name]`
  // / `coll.name` should find a member by `id` or `name`. Numeric and
  // Array-method access still flow through the underlying collection.
  function namedCollection(list) {
    return new Proxy(list, {
      get(target, prop) {
        if (prop in target || typeof prop === 'symbol') return target[prop];
        if (typeof prop === 'string' && /^\d+$/.test(prop)) return target[+prop];
        return target.namedItem(prop) ?? undefined;
      },
      has(target, prop) {
        if (prop in target) return true;
        return typeof prop === 'string' && target.namedItem(prop) != null;
      }
    });
  }
  // Proxy a `<form>` element so `form.name` / `form[name]` resolve
  // through `form.elements` first (legacy `this.form.<input-name>`
  // pattern). Real Element members win when the names collide. Cached
  // per wrapper so `this.form === this.form` holds inside a handler.
  const __formProxies = new WeakMap();
  function namedFormProxy(form) {
    let proxy = __formProxies.get(form);
    if (proxy) return proxy;
    proxy = new Proxy(form, {
      get(target, prop) {
        if (prop in target || typeof prop === 'symbol') return target[prop];
        const named = target.elements?.namedItem(prop);
        return named ?? target[prop];
      }
    });
    __formProxies.set(form, proxy);
    return proxy;
  }
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
  // Range — covers Redmine's quote-reply / table-paste flows. The
  // (startContainer, startOffset, endContainer, endOffset) quad is
  // tracked spec-style; `cloneContents` for cross-boundary selections
  // delegates to Ruby (`cloneRangeContents`) which walks Nokogiri
  // partial-cloning text nodes at the boundaries and full-cloning
  // interior siblings.
  function indexInParent(node) {
    const parent = node && node.parentNode;
    if (!parent) return 0;
    const kids = parent.childNodes;
    for (let i = 0; i < kids.length; i++) if (kids[i] === node) return i;
    return 0;
  }
  class Range {
    constructor() {
      this.startContainer  = null;
      this.endContainer    = null;
      this.startOffset     = 0;
      this.endOffset       = 0;
    }
    get commonAncestorContainer() {
      // Cached between boundary mutations — `intersectsNode` and the
      // surrounding quote-reply chain hits the getter several times.
      if (this._cachedCAC !== undefined && this._cachedCAC !== null) return this._cachedCAC;
      if (!this.startContainer || !this.endContainer) return null;
      if (this.startContainer === this.endContainer) return (this._cachedCAC = this.startContainer);
      const path = new Set();
      for (let n = this.startContainer; n; n = n.parentNode) path.add(n);
      for (let n = this.endContainer; n; n = n.parentNode) if (path.has(n)) return (this._cachedCAC = n);
      return null;
    }
    selectNodeContents(node) {
      const end = node && node.nodeType === 3
        ? (node.textContent || '').length
        : ((node && node.childNodes && node.childNodes.length) || 0);
      this._setBoundary(true,  node, 0);
      this._setBoundary(false, node, end);
    }
    selectNode(node) {
      const parent = node && node.parentNode;
      const idx    = indexInParent(node);
      this._setBoundary(true,  parent, idx);
      this._setBoundary(false, parent, idx + 1);
    }
    setStart(node, offset)   { this._setBoundary(true,  node, offset || 0); }
    setEnd(node, offset)     { this._setBoundary(false, node, offset || 0); }
    setStartBefore(node)     { this._setBoundary(true,  node && node.parentNode, indexInParent(node)); }
    setStartAfter(node)      { this._setBoundary(true,  node && node.parentNode, indexInParent(node) + 1); }
    setEndBefore(node)       { this._setBoundary(false, node && node.parentNode, indexInParent(node)); }
    setEndAfter(node)        { this._setBoundary(false, node && node.parentNode, indexInParent(node) + 1); }
    _setBoundary(isStart, node, offset) {
      if (isStart) { this.startContainer = node; this.startOffset = offset; }
      else         { this.endContainer   = node; this.endOffset   = offset; }
      this._cachedCAC = null;
    }
    collapse()               {}
    intersectsNode(node) {
      if (!this.startContainer || !node) return false;
      const ca = this.commonAncestorContainer;
      // Conservative: covered when the range's container contains node
      // or vice versa. Real browsers compute boundary-point comparisons.
      return ca === node ||
        (ca && ca.contains && ca.contains(node)) ||
        (node.contains && node.contains(ca));
    }
    deleteContents() {
      // Used by Turbo's FrameRenderer with selectNodeContents — always
      // a single-container range, so clearing children is enough.
      const c = this.startContainer;
      if (c && c.childNodes) {
        for (const k of Array.from(c.childNodes)) c.removeChild(k);
      }
    }
    extractContents() {
      const frag = document.createDocumentFragment();
      const c = this.startContainer;
      if (!c) return frag;
      for (const k of Array.from(c.childNodes)) {
        c.removeChild(k);
        frag.appendChild(k);
      }
      return frag;
    }
    cloneContents() {
      if (!this.startContainer) return document.createDocumentFragment();
      const handle = __dom(0, 'cloneRangeContents', [
        this.startContainer.__h, this.startOffset,
        this.endContainer.__h,   this.endOffset
      ]);
      return wrap(handle) || document.createDocumentFragment();
    }
    cloneRange()   { const r = new Range; Object.assign(r, this); return r; }
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
  // jQuery's feature-detection writes
  // `(createHTMLDocument("").body).innerHTML = "<form></form><form></form>"`
  // and counts childNodes. Returning the live `document` would clobber
  // the page body — give every call a fresh detached body wrapped in
  // a minimal Document-shaped object instead. `documentElement` /
  // `head` cover the rest of the surface jQuery probes.
  globalThis.document.implementation = {
    createHTMLDocument(_title) {
      const body = globalThis.document.createElement('body');
      const head = globalThis.document.createElement('head');
      const html = globalThis.document.createElement('html');
      html.appendChild(head);
      html.appendChild(body);
      return {
        documentElement: html,
        head:            head,
        body:            body,
        createElement:    (tag) => globalThis.document.createElement(tag),
        createTextNode:   (t)   => globalThis.document.createTextNode(t),
        createDocumentFragment: () => globalThis.document.createDocumentFragment(),
        querySelector:    (s)   => body.querySelector(s),
        querySelectorAll: (s)   => body.querySelectorAll(s)
      };
    }
  };
  // window === defaultView is the canonical relationship; libraries
  // walk it via `node.ownerDocument.defaultView` to find the global.
  globalThis.document.defaultView = globalThis;
  // EasyMDE et al. iterate document.styleSheets at construct-time —
  // without a stylesheet engine the answer is simply "no sheets",
  // which is enough to keep them from throwing on `.length`.
  // Provide a proper StyleSheetList with length and methods.
  globalThis.CSSStyleSheet = class CSSStyleSheet {
    constructor() {
      this.cssRules = [];
      this.media = { mediaText: '', appendMedium() {}, deleteMedium() {} };
      this.disabled = false;
      this.href = null;
      this.ownerNode = null;
      this.ownerRule = null;
      this.parentStyleSheet = null;
      this.title = '';
      this.type = 'text/css';
    }
    insertRule(rule, index = 0) { this.cssRules.splice(index, 0, rule); return index; }
    deleteRule(index) { this.cssRules.splice(index, 1); }
  };
  globalThis.document.styleSheets = {
    length: 0,
    item(index) { return null; },
    [Symbol.iterator]: function* () {},
    forEach(callback, thisArg) { }
  };

  // window === globalThis is the universal "this is a browser-ish env"
  // signal. Plus a handful of shims used during library boot.
  globalThis.window     = globalThis;
  globalThis.self       = globalThis;
  // `Window` (the constructor) is referenced for `instanceof` /
  // `PropTypes.instanceOf(Window)` checks. We don't model a separate
  // Window class — globalThis suffices as the only window-shaped
  // object — so just point the constructor at our stand-in. A bare
  // function works for both `instanceof` (returns false harmlessly)
  // and `=== Window` identity checks.
  globalThis.Window     = function Window() {};
  globalThis.location   = globalThis.document.location;
  // navigator.clipboard backed by an in-process buffer so tests that
  // round-trip writeText / readText work without depending on the
  // host clipboard. Cleared in __resetPage.
  let __clipboardText = '';
  const __clipboard = {
    writeText(text) { __clipboardText = String(text ?? ''); return Promise.resolve(); },
    readText()      { return Promise.resolve(__clipboardText); },
    write(_items)   { return Promise.resolve(); },
    read()          { return Promise.resolve([]); },
    _reset()        { __clipboardText = ''; }
  };
  // Ruby-side `send_keys [:control, 'v']` reads / writes the buffer
  // here to simulate a real paste / copy default action.
  globalThis.__getClipboard = function () { return __clipboardText; };
  globalThis.__setClipboard = function (text) { __clipboardText = String(text == null ? '' : text); };
  // Caret bridge for Ruby-side `send_keys` — `state[:caret]` only
  // tracks our buffered typing, but Stimulus listeners may have
  // called `setSelectionRange` mid-flight. Round-trip these so the
  // post-listener caret survives.
  globalThis.__getCaret = function (h) { const w = wrap(h); return w ? (w.selectionStart || 0) : 0; };
  globalThis.__setCaret = function (h, n) { const w = wrap(h); if (w && w.setSelectionRange) w.setSelectionRange(n, n); };
  globalThis.navigator = {
    userAgent:      'capybara-simulated',
    appVersion:     'capybara-simulated',
    appName:        'Netscape',
    appCodeName:    'Mozilla',
    product:        'Gecko',
    language:       'en-US',
    languages:      ['en-US'],
    platform:       'Linux x86_64',
    vendor:         '',
    onLine:         true,
    cookieEnabled:  true,
    doNotTrack:     null,
    maxTouchPoints: 0,
    clipboard:      __clipboard
  };
  globalThis.screen     = {width: 1024, height: 768};
  // No layout engine — scroll position is fictional, but scroll-driven
  // listeners (Forem's infinite-scroll, lazy-load fallbacks, sticky
  // headers) gate work on the `scroll` event firing, so dispatch one
  // synthetically when the test calls `window.scrollTo(...)`.
  function __dispatchScroll() {
    const ev = new Event('scroll', {bubbles: false, cancelable: false});
    __dispatch(globalThis.document, ev);
    if (typeof globalThis.dispatchEvent === 'function') {
      try { globalThis.dispatchEvent(ev); } catch (_) {}
    }
  }
  globalThis.scrollTo   = function () { __dispatchScroll(); };
  globalThis.scroll     = function () { __dispatchScroll(); };
  globalThis.scrollBy   = function () { __dispatchScroll(); };
  globalThis.scrollX = globalThis.scrollY = 0;
  globalThis.pageXOffset = globalThis.pageYOffset = 0;
  globalThis.innerWidth  = 1024;
  globalThis.innerHeight = 768;
  globalThis.outerWidth  = 1024;
  globalThis.outerHeight = 768;
  globalThis.devicePixelRatio = 1;

  // window.getSelection — Range/Selection only matter for tests that
  // probe text selection (Redmine's quote-reply uses this). A minimal
  // single-range Selection lets such tests reach the action under
  // test rather than failing at API existence.
  class Selection {
    constructor()       { this._ranges = []; }
    get rangeCount()    { return this._ranges.length; }
    get isCollapsed()   { return this._ranges.length === 0; }
    addRange(r)         { this._ranges.push(r); }
    removeAllRanges()   { this._ranges = []; }
    removeRange(r)      { const i = this._ranges.indexOf(r); if (i >= 0) this._ranges.splice(i, 1); }
    getRangeAt(i)       { return this._ranges[i]; }
    toString()          { return ''; }
    collapse()          {}
    collapseToEnd()     {}
    collapseToStart()   {}
    selectAllChildren() {}
    // Conservative `containsNode` — true if any range intersects.
    // Redmine's quote-reply gates the partial-quote path on this; an
    // empty selection (no ranges, the no-pre-selection case) returns
    // false so the controller falls through to the full-quote post.
    containsNode(node, _partialOk) {
      return this._ranges.some(r => r.intersectsNode && r.intersectsNode(node));
    }
  }
  globalThis.Selection = Selection;
  const __selection = new Selection();
  globalThis.getSelection = () => __selection;
  globalThis.document.getSelection = () => __selection;
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
  // Backed by a Map so set/get round-trip within a session — apps that
  // gate UI on a stored flag (theme, dismissed banner, ...) need that
  // to actually work. Cleared in __resetPage so each test starts fresh.
  function makeStorage() {
    const m = new Map();
    return {
      get length()        { return m.size; },
      key(i)              { return [...m.keys()][i] ?? null; },
      getItem(k)          { return m.has(String(k)) ? m.get(String(k)) : null; },
      setItem(k, v)       { m.set(String(k), String(v)); },
      removeItem(k)       { m.delete(String(k)); },
      clear()             { m.clear(); },
      _reset()            { m.clear(); }
    };
  }
  globalThis.localStorage   = makeStorage();
  globalThis.sessionStorage = makeStorage();
  // No layout engine, so "computed" style is mostly fiction. We
  // expose what we can actually answer accurately: inline
  // `style="..."` declarations + a hand-coded default-display table
  // (jQuery's `.show()` consults computed display to decide whether
  // an element is hidden via stylesheet, and bails on empty).
  const __DEFAULT_DISPLAY = {
    div: 'block', p: 'block', h1: 'block', h2: 'block', h3: 'block', h4: 'block',
    h5: 'block', h6: 'block', section: 'block', article: 'block', header: 'block',
    footer: 'block', nav: 'block', aside: 'block', main: 'block', form: 'block',
    fieldset: 'block', address: 'block', blockquote: 'block', pre: 'block',
    hr: 'block', ul: 'block', ol: 'block', dl: 'block', figure: 'block',
    figcaption: 'block',
    li: 'list-item', dt: 'block', dd: 'block',
    table: 'table', tbody: 'table-row-group', thead: 'table-header-group',
    tfoot: 'table-footer-group', tr: 'table-row', td: 'table-cell',
    th: 'table-cell', caption: 'table-caption', colgroup: 'table-column-group',
    col: 'table-column'
  };
  function defaultDisplayFor(el) {
    return __DEFAULT_DISPLAY[el.tagName?.toLowerCase()] || 'inline';
  }
  globalThis.getComputedStyle = function (el) {
    const inline = (el && el.getAttribute) ? (el.getAttribute('style') || '') : '';
    const decls = {};
    inline.split(';').forEach(decl => {
      const i = decl.indexOf(':');
      if (i < 0) return;
      const k = decl.slice(0, i).trim().toLowerCase();
      const v = decl.slice(i + 1).trim();
      if (k) decls[k] = v;
    });
    const baseStyle = {
      getPropertyValue(name) {
        const k = String(name).toLowerCase();
        if (k in decls) return decls[k];
        if (k === 'display') return defaultDisplayFor(el);
        return '';
      },
      get display()    { return decls.display    ?? defaultDisplayFor(el); },
      get visibility() { return decls.visibility ?? 'visible'; },
      get opacity()    { return decls.opacity    ?? '1'; },
      get position()   { return decls.position   ?? 'static'; },
      get overflow()   { return decls.overflow   ?? 'visible'; },
      get width()      { return decls.width      ?? '0px'; },
      get height()     { return decls.height     ?? '0px'; },
      get padding()    { return decls.padding    ?? '0px'; },
      get margin()     { return decls.margin     ?? '0px'; },
      length: Object.keys(decls).length
    };
    return new Proxy(baseStyle, {
      get(target, prop) {
        if (prop in target) return target[prop];
        return '';
      }
    });
  };
  globalThis.matchMedia = function () { return {matches: false, addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}}; };

  // performance.now() returns ms since the runtime started — not the
  // virtual JS clock, since most callers (perf timing, jitter
  // smoothing) want monotonic wall time, not virtual ticks.
  const __perfStart = Date.now();
  globalThis.performance = {
    now()        { return Date.now() - __perfStart; },
    timeOrigin:   __perfStart,
    mark()       {},
    measure()    {},
    getEntries() { return []; },
    getEntriesByName() { return []; },
    getEntriesByType() { return []; },
    clearMarks()    {},
    clearMeasures() {}
  };

  // XMLHttpRequest: synchronous-via-Rack underneath, async-shaped on top.
  // rails-ujs (`:remote => true` forms, `data-method` links) + jQuery's
  // `$.ajax` go through XHR; without this all that traffic silently
  // dropped. Send is dispatched to the underlying Rack app the same way
  // `fetch` is, then the load / loadend / readystatechange events fire
  // synchronously — close enough for test scenarios that immediately
  // assert against the side effects of the response.
  class XMLHttpRequest {
    constructor() {
      this.readyState   = 0;
      this.status       = 0;
      this.statusText   = '';
      this.response     = '';
      this.responseText = '';
      this.responseType = '';
      this.responseURL  = '';
      this.timeout      = 0;
      this.withCredentials = false;
      this.onreadystatechange = null;
      this.onload        = null;
      this.onerror       = null;
      this.onloadend     = null;
      this._method       = 'GET';
      this._url          = '';
      this._headers      = {};
      this._respHeaders  = [];
      this._listeners    = new Map();
      this._aborted      = false;
    }
    open(method, url) {
      this._method = String(method || 'GET').toUpperCase();
      this._url    = String(url || '');
      this.readyState = 1;
    }
    setRequestHeader(name, value) {
      this._headers[String(name).toLowerCase()] = String(value);
    }
    overrideMimeType() {}
    abort() { this._aborted = true; this._fireEvent('abort'); }
    send(body) {
      if (this._aborted) return;
      let raw;
      try {
        raw = __rackFetch(this._method, this._url, body == null ? null : (typeof body === 'string' ? body : body.toString()), this._headers, 'follow');
      } catch (e) {
        this._fireEvent('error');
        this._fireEvent('loadend');
        return;
      }
      this.status       = raw.status || 0;
      this.statusText   = '';
      this.responseURL  = raw.url || this._url;
      this.responseText = raw.body || '';
      this.response     = this.responseText;
      this._respHeaders = raw.headers || [];
      this.readyState   = 4;
      this._fireEvent('readystatechange');
      this._fireEvent('load');
      this._fireEvent('loadend');
    }
    getAllResponseHeaders() {
      return this._respHeaders.map(([k, v]) => `${k}: ${v}`).join('\r\n');
    }
    getResponseHeader(name) {
      const lower = String(name).toLowerCase();
      const hit = this._respHeaders.find(([k]) => k.toLowerCase() === lower);
      return hit ? hit[1] : null;
    }
    addEventListener(type, h) {
      if (typeof h !== 'function') return;
      let arr = this._listeners.get(type);
      if (!arr) this._listeners.set(type, arr = []);
      arr.push(h);
    }
    removeEventListener(type, h) {
      const arr = this._listeners.get(type);
      if (!arr) return;
      const i = arr.indexOf(h);
      if (i >= 0) arr.splice(i, 1);
    }
    dispatchEvent() { return true; }
    _fireEvent(type) {
      const inline = this['on' + type];
      const ev = {type, target: this, currentTarget: this};
      if (typeof inline === 'function') {
        try { inline.call(this, ev); } catch (e) { try { console.error('xhr ' + type + ' threw:', e && e.message ? e.message : e); } catch (_) {} }
      }
      const arr = this._listeners.get(type);
      if (arr) {
        for (const h of arr.slice()) {
          try { h.call(this, ev); } catch (e) { try { console.error('xhr ' + type + ' threw:', e && e.message ? e.message : e); } catch (_) {} }
        }
      }
    }
  }
  // Spec readyState constants. rails-ujs's done() callback gates on
  // `xhr.readyState === XMLHttpRequest.DONE`; without these the
  // comparison is `4 === undefined` and the response never processes.
  XMLHttpRequest.UNSENT           = 0;
  XMLHttpRequest.OPENED           = 1;
  XMLHttpRequest.HEADERS_RECEIVED = 2;
  XMLHttpRequest.LOADING          = 3;
  XMLHttpRequest.DONE             = 4;
  globalThis.XMLHttpRequest = XMLHttpRequest;

  // Idle callbacks: real browsers fire them when the main thread is
  // idle. With our virtual clock there's no idleness signal, so route
  // them through setTimeout(0) — close enough for libraries that just
  // want "run after current task".
  globalThis.requestIdleCallback = function (cb, _opts) {
    return setTimeout(() => cb({didTimeout: false, timeRemaining: () => 50}), 0);
  };
  globalThis.cancelIdleCallback = globalThis.clearTimeout;

  // structuredClone: deep clone via JSON for the common JSON-safe case.
  // Real structuredClone handles Map / Set / Date / typed arrays /
  // cycles; fall back to that gnarlier set only when JSON refuses.
  globalThis.structuredClone = function (v) {
    if (v == null || typeof v !== 'object') return v;
    try { return JSON.parse(JSON.stringify(v)); }
    catch (_) { return v; }
  };

  // reportError: the spec says "dispatch an error event on global,
  // log if no handler". Logging is enough for most callers.
  globalThis.reportError = function (e) {
    try { console.error(e && e.stack ? e.stack : String(e)); } catch (_) {}
  };

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
  // IntersectionObserver without a layout engine: we can't observe
  // real scroll position, but pretending every *visible* target is in
  // viewport is close enough for lazy turbo-frames and similar
  // viewport-gated UI. Targets whose ancestor chain is hidden
  // (display:none from cascade, [hidden], etc.) stay silent until they
  // become visible — `__pollIntersectionObservers()` re-checks pending
  // targets after every settle so a tab-reveal click promptly loads the
  // lazy frame inside it.
  const __ZERO_RECT = {top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0};
  const __ioInstances = new Set();
  class EagerIntersectionObserver {
    constructor(cb) {
      this._cb = cb;
      this._pending = new Set(); // observed but not yet intersecting
      this._fired   = new Set(); // already reported intersecting=true
      __ioInstances.add(this);
    }
    observe(target) {
      if (!target) return;
      if (this._fired.has(target) || this._pending.has(target)) return;
      this._pending.add(target);
      const obs = this;
      Promise.resolve().then(() => obs._maybeFire(target));
    }
    unobserve(target) {
      this._pending.delete(target);
      this._fired.delete(target);
    }
    disconnect() {
      this._pending.clear();
      this._fired.clear();
      __ioInstances.delete(this);
    }
    takeRecords() { return []; }
    _maybeFire(target) {
      if (!this._pending.has(target)) return;
      if (!__dom(target.__h, 'isVisible')) return;
      this._pending.delete(target);
      this._fired.add(target);
      try {
        this._cb([{
          target,
          isIntersecting:     true,
          intersectionRatio:  1,
          boundingClientRect: __ZERO_RECT,
          intersectionRect:   __ZERO_RECT,
          rootBounds:         __ZERO_RECT,
          time:               0
        }], this);
      } catch (_) {}
    }
    _poll() {
      if (this._pending.size === 0) return;
      for (const target of Array.from(this._pending)) this._maybeFire(target);
    }
  }
  // Called from settle (Ruby side) after every drain so freshly-revealed
  // targets pick up an intersecting=true entry without waiting for the
  // next observe() call.
  globalThis.__pollIntersectionObservers = function () {
    for (const obs of __ioInstances) obs._poll();
  };
  globalThis.IntersectionObserver = EagerIntersectionObserver;
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
  // URL.createObjectURL / revokeObjectURL — bundled libraries (Avo's
  // mapbox-gl shim, image-cropper widgets) call these to mint a worker
  // URL or src= for a Blob. We don't actually serve the bytes; the URL
  // is opaque enough that downstream code that doesn't fetch it gets
  // by, and code that does just sees a 404.
  let __blobCounter = 0;
  globalThis.URL.createObjectURL = function (_blob) { return 'blob:csim-' + (++__blobCounter); };
  globalThis.URL.revokeObjectURL = function (_url)  { /* no-op — we don't track */ };

  // EventTarget — bundled libraries like Avo's date-picker / mapbox
  // `class Foo extends EventTarget` and rely on
  // `addEventListener` / `dispatchEvent` actually delivering. Minimal
  // per-instance impl: per-type handler list, dispatch invokes them
  // synchronously with `event.target` set to the receiver.
  globalThis.EventTarget = class EventTarget {
    constructor() {
      Object.defineProperty(this, '_listeners', {value: new Map(), enumerable: false});
    }
    addEventListener(type, handler) {
      if (typeof handler !== 'function' && !(handler && typeof handler.handleEvent === 'function')) return;
      const arr = this._listeners.get(type) || [];
      if (!arr.includes(handler)) arr.push(handler);
      this._listeners.set(type, arr);
    }
    removeEventListener(type, handler) {
      const arr = this._listeners.get(type);
      if (!arr) return;
      const i = arr.indexOf(handler);
      if (i >= 0) arr.splice(i, 1);
    }
    dispatchEvent(event) {
      if (event && event.target == null) event.target = this;
      if (event && event.currentTarget == null) event.currentTarget = this;
      const arr = this._listeners.get(event && event.type);
      if (!arr) return true;
      for (const h of arr.slice()) {
        try {
          if (typeof h === 'function') h.call(this, event);
          else if (h && typeof h.handleEvent === 'function') h.handleEvent(event);
        } catch (e) {
          try { console.error('EventTarget listener threw:', e && e.message ? e.message : e); } catch (_) {}
        }
      }
      return !(event && event.defaultPrevented);
    }
  };


  // Worker, SharedWorker, MessagePort — mapbox-gl and other bundled libraries
  // instantiate these to offload tile rendering. No-op impls are enough since
  // Avo's map doesn't require actual web worker functionality in tests.
  globalThis.Worker = class Worker extends EventTarget {
    constructor(scriptUrl) {
      super();
      this.url = scriptUrl;
    }
    postMessage(message, transferList) { }
    terminate() { }
  };

  globalThis.SharedWorker = class SharedWorker extends EventTarget {
    constructor(scriptUrl, options) {
      super();
      this.url = scriptUrl;
      this.port = new globalThis.MessagePort();
    }
  };

  globalThis.MessagePort = class MessagePort extends EventTarget {
    constructor() {
      super();
    }
    postMessage(message, transferList) { }
    start() { }
    close() { }
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
          const opts     = f.querySelectorAll('option');
          const explicit = Array.from(opts).filter(o => o.getAttribute('selected') != null);
          // Single-select with nothing explicitly selected: browsers
          // submit the first non-disabled option's value.
          const chosen = explicit.length > 0
            ? explicit
            : (f.hasAttribute('multiple') ? [] : Array.from(opts).filter(o => !o.disabled).slice(0, 1));
          for (const opt of chosen) {
            this.append(name, opt.getAttribute('value') || opt.textContent || '');
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
      logCallbackError('CE constructor', e);
    }
    __ceInstances.set(el.__h, el);
    invokeCECallback(el, 'connectedCallback');
  }

  function invokeCECallback(el, name, ...args) {
    if (typeof el[name] !== 'function') return;
    try { el[name].apply(el, args); } catch (e) { logCallbackError(name, e); }
  }

  function logCallbackError(label, e) {
    try { console.error(label + ' threw:', e && e.message ? e.message : e); } catch (_) {}
  }

  // Notify a CE that an observedAttribute changed. Turbo's FrameElement
  // observes `src`, so `frame.src = url` triggers sourceURLChanged().
  function ceMaybeAttributeChanged(el, name, oldVal, newVal) {
    if (oldVal === newVal) return;
    const ctor = ceCtorFor(el.tagName);
    const observed = ctor && ctor.observedAttributes;
    if (!observed || observed.indexOf(name) === -1) return;
    invokeCECallback(el, 'attributeChangedCallback', name, oldVal, newVal);
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
    invokeCECallback(el, 'disconnectedCallback');
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
