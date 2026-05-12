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
      // DOM spec: handler may be either a function OR an EventListener
      // object with a `handleEvent` method. Stimulus's central
      // dispatcher passes the latter (one `EventListener` instance per
      // (element, eventName) pair, with bindings looked up inside
      // `handleEvent`) — without this branch the listener silently
      // never registers and every Stimulus `data-action` is a no-op.
      let fn = null;
      if (typeof handler === 'function') fn = handler;
      else if (handler && typeof handler.handleEvent === 'function') {
        fn = handler.handleEvent.bind(handler);
        fn._csimEventListenerObject = handler;
      } else return;
      const capture = !!(options && (options === true || options.capture));
      this._listeners = this._listeners || Object.create(null);
      const list = this._listeners[type] || (this._listeners[type] = []);
      // Per spec, identical {type, handler, capture} is deduped. The
      // identity for handler-object form is the original object, so
      // re-registering the same EventListener instance is a no-op.
      if (list.some(l => (l.handler === fn ||
                          (handler && l.handler._csimEventListenerObject === handler)) &&
                         l.capture === capture)) return;
      list.push({ handler: fn, capture });
    }
    removeEventListener(type, handler, options) {
      if (!this._listeners || !this._listeners[type]) return;
      const capture = !!(options && (options === true || options.capture));
      this._listeners[type] = this._listeners[type].filter(l => {
        if (l.capture !== capture) return true;
        if (typeof handler === 'function') return l.handler !== handler;
        if (handler && typeof handler.handleEvent === 'function') {
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
        try { dispatchEvent(prev, new Event('blur',     { bubbles: false, cancelable: false })); } catch (_) {}
        try { dispatchEvent(prev, new Event('focusout', { bubbles: true,  cancelable: false })); } catch (_) {}
      }
      globalThis.document._activeElement = this;
      try { dispatchEvent(this, new Event('focus',    { bubbles: false, cancelable: false })); } catch (_) {}
      try { dispatchEvent(this, new Event('focusin',  { bubbles: true,  cancelable: false })); } catch (_) {}
    }
    blur() {
      if (globalThis.document._activeElement !== this) return;
      globalThis.document._activeElement = null;
      try { dispatchEvent(this, new Event('blur',     { bubbles: false, cancelable: false })); } catch (_) {}
      try { dispatchEvent(this, new Event('focusout', { bubbles: true,  cancelable: false })); } catch (_) {}
    }

    // Layout stubs — there's no rendering engine, so geometry is
    // always zero. Returning a sensible shape lets feature-detection
    // probes in jQuery / DOM libraries continue instead of throwing
    // "not a function". `getBoundingClientRect()` is the canonical
    // shape; `getClientRects()` returns a DOMRectList (an empty
    // array works for callers that just iterate or check length).
    getBoundingClientRect() {
      // Non-zero dims for visible elements so libraries that probe
      // layout to test visibility (jQuery 3.x's `:visible` filter,
      // Stimulus targets, intersection observers' default behaviour)
      // see "rendered" results that match real-browser-equivalent
      // visibility. We don't model true layout; the 1×1 box at 0,0
      // is just a sentinel.
      if (__isVisibleNode(this)) {
        return { top: 0, left: 0, right: 1, bottom: 1, width: 1, height: 1, x: 0, y: 0 };
      }
      return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 };
    }
    getClientRects() {
      return __isVisibleNode(this)
        ? [{ top: 0, left: 0, right: 1, bottom: 1, width: 1, height: 1, x: 0, y: 0 }]
        : [];
    }
    get offsetWidth()  { return __isVisibleNode(this) ? 1 : 0; }
    get offsetHeight() { return __isVisibleNode(this) ? 1 : 0; }
    get clientWidth()  { return __isVisibleNode(this) ? 1 : 0; }
    get clientHeight() { return __isVisibleNode(this) ? 1 : 0; }
    get scrollWidth()  { return __isVisibleNode(this) ? 1 : 0; }
    get scrollHeight() { return __isVisibleNode(this) ? 1 : 0; }
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
    hasChildNodes()     { return this._children.length > 0; }
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
      if (this._tag !== 'form') return;
      globalThis.__csimPendingFormSubmit = { form: this, submitter: null };
    }
    requestSubmit(submitter) {
      // `form.requestSubmit()` (HTML spec): like submit() but DOES
      // fire 'submit' event and goes through the form-submit
      // algorithm. We can't fully run that algorithm pre-navigation,
      // so we dispatch submit + record the intent + let the
      // submitter contribute its value.
      if (this._tag !== 'form') return;
      const ev = new SubmitEvent('submit', { bubbles: true, cancelable: true, submitter: submitter || null });
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
        const ev = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, which: 1 });
        dispatchEvent(this, ev);
        if (!ev.defaultPrevented && isSubmitButton(this)) {
          const form = formForControl(this);
          if (form) {
            const submitEv = new SubmitEvent('submit', { bubbles: true, cancelable: true, submitter: this });
            dispatchEvent(form, submitEv);
            if (!submitEv.defaultPrevented) {
              globalThis.__csimPendingFormSubmit = { form, submitter: this };
            }
          }
        }
      } catch (_) {}
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
    before (...nodes) { if (this._parent) for (const n of nodes) this._parent.insertBefore(toNode(n), this); }
    after  (...nodes) {
      if (!this._parent) return;
      const sibs = this._parent._children;
      const idx  = sibs.indexOf(this);
      const ref  = idx + 1 < sibs.length ? sibs[idx + 1] : null;
      for (const n of nodes) this._parent.insertBefore(toNode(n), ref);
    }
    replaceWith (...nodes) {
      if (!this._parent) return;
      const p = this._parent;
      for (const n of nodes) p.insertBefore(toNode(n), this);
      p.removeChild(this);
    }
    // `ParentNode.prepend(...nodes)` / `append(...nodes)` — the
    // sibling of `appendChild` that accepts strings + variadic args.
    prepend (...nodes) {
      const first = this._children[0] || null;
      for (const n of nodes) this.insertBefore(toNode(n), first);
    }
    append (...nodes) { for (const n of nodes) this.appendChild(toNode(n)); }
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
    // `innerText` is the "as rendered" sibling of textContent — line
    // breaks from `<br>` / block boundaries, whitespace collapsed,
    // visibility-aware. Without a layout engine we can't compute the
    // rendered form, so we fall back to textContent — what Chromium
    // does anyway for detached / not-being-rendered subtrees per spec
    // note. Critical because Redmine's jstoolbar builds its Edit /
    // Preview tabs via `link.innerText = tabName`, and without the
    // setter the tabs end up empty and `click_link 'Preview'` fails.
    get innerText() { return this.textContent; }
    set innerText(v) { this.textContent = v; }
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
      return __htmlCollection(all.filter(n => n !== this));
    }
    getElementsByClassName(cls) {
      const sel = String(cls).split(/\s+/).filter(Boolean).map(c => '.' + c).join('');
      return __htmlCollection(this.querySelectorAll(sel).filter(n => n !== this));
    }
    getElementsByName(name) {
      const sel = '[name="' + String(name).replace(/"/g, '\\"') + '"]';
      return __htmlCollection(this.querySelectorAll(sel).filter(n => n !== this));
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
          el._attrs['class'] = cs.join(' ');
          return true;
        },
        item(i) {
          const cs = classes(el);
          return i >= 0 && i < cs.length ? cs[i] : null;
        },
        get length() { return classes(el).length; },
        get value()  { return el._attrs['class'] || ''; },
        set value(v) { el._attrs['class'] = String(v == null ? '' : v); },
        toString()   { return el._attrs['class'] || ''; },
        forEach(fn)  { classes(el).forEach((c, i) => fn(c, i, this)); },
        entries()    { return classes(el).entries(); },
        keys()       { return classes(el).keys(); },
        values()     { return classes(el).values(); }
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
      const toAttr   = (k) => 'data-' + String(k).replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
      const fromAttr = (n) => n.slice(5).replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
      this._datasetProxy = new Proxy({}, {
        get(_t, key) {
          if (typeof key !== 'string') return undefined;
          const v = el._attrs[toAttr(key)];
          return v == null ? undefined : v;
        },
        set(_t, key, value) {
          if (typeof key !== 'string') return false;
          el.setAttribute(toAttr(key), String(value));
          return true;
        },
        deleteProperty(_t, key) {
          if (typeof key !== 'string') return false;
          el.removeAttribute(toAttr(key));
          return true;
        },
        has(_t, key) {
          return typeof key === 'string' &&
                 Object.prototype.hasOwnProperty.call(el._attrs, toAttr(key));
        },
        ownKeys() {
          return Object.keys(el._attrs).filter((n) => n.startsWith('data-')).map(fromAttr);
        },
        getOwnPropertyDescriptor(_t, key) {
          if (typeof key !== 'string') return undefined;
          const attr = toAttr(key);
          if (!Object.prototype.hasOwnProperty.call(el._attrs, attr)) return undefined;
          return { enumerable: true, configurable: true, value: el._attrs[attr] };
        }
      });
      return this._datasetProxy;
    }
    // querySelector / matches: PoC supports the small subset Capybara
    // emits internally (tag, #id, .class, [attr=value], descendant
    // combinator). Full CSS3 deferred to a proper port.
    querySelector(sel)        { return findFirst(this, parseSelector(__normaliseScopedSelector(sel))); }
    querySelectorAll(sel)     { return findAll(this, parseSelector(__normaliseScopedSelector(sel))); }
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
    // Common HTMLElement / form-control IDL attributes that mirror to
    // their named attributes. jQuery 3.x's `.serialize()` filter keys
    // on `this.name` / `this.type`; without these getters the filter
    // rejects every form element (`.name` undefined → falsy → skip).
    // Mirrors HTML spec's reflection rules: read returns the attribute
    // value (or '' if absent), write goes through setAttribute so
    // MutationObserver / attributeChangedCallback see the change.
    get name()  { return this._attrs.name  != null ? this._attrs.name  : ''; }
    set name(v) { this.setAttribute('name', String(v == null ? '' : v)); }
    get type()  {
      // <input>.type defaults to 'text' when the type attr is absent
      // (spec). Other elements just reflect.
      if (this._tag === 'input') {
        const t = this._attrs.type;
        return t != null ? t.toLowerCase() : 'text';
      }
      // `<select>.type` is `'select-multiple'` when the multiple attr
      // is set, otherwise `'select-one'`. jQuery's `.val()` for a
      // select branches on this string; without the override it read
      // `''`, which doesn't equal `'select-one'`, so jQuery walked
      // every option as if multi-select and tripped over `null.value`.
      if (this._tag === 'select') {
        return this._attrs.multiple != null ? 'select-multiple' : 'select-one';
      }
      return this._attrs.type != null ? this._attrs.type : '';
    }
    set type(v) { this.setAttribute('type', String(v == null ? '' : v)); }
    // `<select>.options` — live HTMLOptionsCollection of every
    // `<option>` descendant (jQuery's `.val()` getter reads this with
    // an indexed lookup based on `selectedIndex`; without the property
    // the read returns undefined → `undefined.length` TypeError).
    get options() {
      if (this._tag !== 'select') return undefined;
      return this.querySelectorAll('option');
    }
    get title() { return this._attrs.title != null ? this._attrs.title : ''; }
    set title(v){ this.setAttribute('title', String(v == null ? '' : v)); }

    // HTMLFormElement.elements — collection of named form controls.
    // jQuery's `.serialize()` reads this; without it, serialize returns
    // empty even though the form has inputs (Redmine's context-menu
    // AJAX sends an empty query string and the server 404s). Real
    // browsers include input/select/textarea/button (and a few more);
    // returning a length-bearing array is sufficient for jQuery.
    get elements() {
      if (this._tag !== 'form') return undefined;
      const out = [];
      walkSubtree(this, el => {
        if (el === this || el.nodeType !== NODE_ELEMENT) return;
        const t = el._tag;
        if (t === 'input' || t === 'select' || t === 'textarea' ||
            t === 'button' || t === 'fieldset' || t === 'object') {
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
      if (!FORM_ASSOCIATED_TAGS.has(this._tag)) return undefined;
      const form = formForControl(this);
      return form ? __formNamedAccess(form) : null;
    }
    // Form-control IDL attributes. v2 leans on Nokogiri attribute
    // mirroring; here we expose the same pair-of-attr-and-IDL shape
    // so JS like `input.value = 'x'` / `input.checked = true` works
    // and reads back via `__csimValue` / serialised attrs alike.
    get value() {
      // `<select>.value` is the value of the first selected option, or
      // (per HTML spec) the value of the first non-disabled option as
      // the default. Library handlers (Redmine's `updateIssueFrom`
      // posts `$('#issue-form').serialize()` which reads the IDL
      // value, jQuery's `.val()` falls through to this getter for
      // selects) all expect this resolution rather than `_attrs.value`.
      if (this._tag === 'select') {
        const opts = this.querySelectorAll('option');
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
        return implicit == null ? '' : implicit;
      }
      return this._attrs.value != null ? this._attrs.value : '';
    }
    set value(v)   {
      if (this._tag === 'select') {
        const target = String(v == null ? '' : v);
        const opts = this.querySelectorAll('option');
        for (const o of opts) delete o._attrs.selected;
        for (const o of opts) {
          const ov = o._attrs.value != null ? o._attrs.value : o.textContent;
          if (ov === target) { o._attrs.selected = ''; break; }
        }
        return;
      }
      this._attrs.value = String(v == null ? '' : v);
    }
    // `<option>.selected` IDL — boolean reflecting the `selected`
    // content attribute. jQuery's `.val()` over a `<select>` walks the
    // options checking each `.selected`; Redmine's onchange handlers
    // probe `option[selected]` after manual `select` calls. Without
    // the IDL getter the read returns `undefined` and the resolved
    // value comes back empty.
    get selected() {
      if (this._tag !== 'option') return false;
      return this._attrs.selected != null;
    }
    set selected(v) {
      if (this._tag !== 'option') return;
      if (v) {
        this._attrs.selected = '';
        // HTML spec: setting `selected = true` on an option in a
        // single-select select implicitly clears `selected` from the
        // other options. Redmine's `selectTracker` sets
        // `target.find('option[value="X"]').prop('selected', true)`
        // and expects the previously-selected option to no longer
        // win the `.value` resolution.
        let p = this._parent;
        while (p && p.nodeType === NODE_ELEMENT && p._tag !== 'select') p = p._parent;
        if (p && p._tag === 'select' && p._attrs.multiple == null) {
          for (const o of p.querySelectorAll('option')) {
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
      if (this._tag !== 'select') return -1;
      const opts = this.querySelectorAll('option');
      for (let i = 0; i < opts.length; i++) {
        if (opts[i]._attrs.selected != null) return i;
      }
      return opts.length > 0 ? 0 : -1;
    }
    // <a> / <area> / <link>.href: IDL attribute returns the *resolved*
    // URL against the document base (per HTML spec). Rails-UJS reads
    // `element.href` to get the AJAX target; without this getter it
    // would fall back to `location.href` (= current page URL) and
    // every remote-link click would re-fetch the current page.
    get href() {
      if (this._tag !== 'a' && this._tag !== 'area' && this._tag !== 'link') return this._attrs.href;
      const v = this._attrs.href;
      if (v == null) return '';
      try {
        const base = (globalThis.location && globalThis.location.href) || null;
        const u = __csim_parseUrl(v, base);
        return u && !u.error ? u.href : v;
      } catch (_) { return v; }
    }
    set href(v) { this._attrs.href = String(v == null ? '' : v); }
    // HTMLFormElement IDL — `method` / `action` / `enctype` /
    // `target` are reflections of the corresponding attributes.
    // Rails-UJS's `handleMethod` builds a synthetic form via
    // `form.method = 'post'` / `form.action = href`; without
    // these setters those land as plain JS properties (not
    // attributes), and our form serialiser reads the attrs as
    // null → default GET → submits with the wrong method and a
    // query-string instead of a POST body.
    get method() {
      if (this._tag !== 'form') return this._attrs.method;
      const m = (this._attrs.method || 'get').toLowerCase();
      return m === 'dialog' ? 'dialog' : (m === 'post' ? 'post' : 'get');
    }
    set method(v) {
      if (this._tag === 'form') this.setAttribute('method', String(v == null ? '' : v));
      else                       this._attrs.method = String(v == null ? '' : v);
    }
    get action() {
      if (this._tag !== 'form') return this._attrs.action;
      const a = this._attrs.action;
      if (a == null) return (globalThis.location && globalThis.location.href) || '';
      try {
        const base = (globalThis.location && globalThis.location.href) || null;
        const u = __csim_parseUrl(a, base);
        return u && !u.error ? u.href : a;
      } catch (_) { return a; }
    }
    set action(v)  { this.setAttribute('action', String(v == null ? '' : v)); }
    get enctype()  { return this._attrs.enctype != null ? this._attrs.enctype : 'application/x-www-form-urlencoded'; }
    set enctype(v) { this.setAttribute('enctype', String(v == null ? '' : v)); }
    get target()   { return this._attrs.target != null ? this._attrs.target : ''; }
    set target(v)  { this.setAttribute('target', String(v == null ? '' : v)); }
    // HTMLScriptElement / HTMLTitleElement / etc. expose `.text` as
    // an alias for `textContent`. stimulus-rails' `parseImportmapJson`
    // reads `script.text` to get the JSON; without this alias it
    // gets `undefined`.
    get text()     { return this.textContent; }
    set text(v)    { this.textContent = v; }
    get checked()  { return this._attrs.checked != null; }
    set checked(v) { if (v) this._attrs.checked = ''; else delete this._attrs.checked; }
    // HTML IDL boolean-attribute reflections. Setting via property
    // mirrors to the underlying content attribute — without this,
    // `input.disabled = true` (the canonical way to disable a control
    // from script) would be a no-op as far as `:disabled` /
    // `getAttribute('disabled')` see, and Capybara's `assert_matches_selector(:css, 'input:disabled')`
    // never settles.
    get disabled() { return this._attrs.disabled != null; }
    set disabled(v){ if (v) this._attrs.disabled = ''; else delete this._attrs.disabled; }
    get readOnly() { return this._attrs.readonly != null; }
    set readOnly(v){ if (v) this._attrs.readonly = ''; else delete this._attrs.readonly; }
    get required() { return this._attrs.required != null; }
    set required(v){ if (v) this._attrs.required = ''; else delete this._attrs.required; }
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

    // Text-input selection — minimum HTMLInputElement / HTMLTextAreaElement
    // surface. `setSelectionRange` is called by Redmine's "reply to issue"
    // / partial-quote flow and by some libraries' "focus and select all"
    // patterns; we just store the offsets so reads of selectionStart /
    // selectionEnd are stable.
    get selectionStart() { return this._selectionStart || 0; }
    set selectionStart(v){ this._selectionStart = v | 0; }
    get selectionEnd()   { return this._selectionEnd != null ? this._selectionEnd : (this._attrs.value || '').length; }
    set selectionEnd(v)  { this._selectionEnd = v | 0; }
    get selectionDirection() { return this._selectionDirection || 'none'; }
    set selectionDirection(v){ this._selectionDirection = String(v || 'none'); }
    setSelectionRange(start, end, direction) {
      this._selectionStart     = start | 0;
      this._selectionEnd       = end   | 0;
      this._selectionDirection = direction != null ? String(direction) : 'none';
    }
    // `setRangeText(replacement, start, end, selectMode)` — HTMLSpec.
    // Replaces the text between `start` and `end` with `replacement`
    // and updates the caret per the `selectMode` argument
    // ('select' / 'start' / 'end' / 'preserve'; default 'preserve').
    // Redmine's list-autofill controller calls this with `'start'` to
    // remove a list marker when the user presses Enter on an empty
    // item; without the method the call throws and the marker stays.
    setRangeText(replacement, start, end, selectMode) {
      if (this._tag !== 'input' && this._tag !== 'textarea') return;
      const cur = this._attrs.value != null ? this._attrs.value : '';
      const len = cur.length;
      if (replacement == null) replacement = '';
      replacement = String(replacement);
      let s = start == null ? (this._selectionStart || 0) : (start | 0);
      let e = end   == null ? (this._selectionEnd   || s) : (end   | 0);
      if (s < 0) s = 0; if (e > len) e = len; if (s > e) s = e;
      const before = cur.slice(0, s);
      const after  = cur.slice(e);
      const next = before + replacement + after;
      this._attrs.value = next;
      if (this._tag === 'textarea') {
        this._children = [Object.assign(new Text(next), { _parent: this })];
      }
      const mode = selectMode == null ? 'preserve' : String(selectMode);
      const replEnd = s + replacement.length;
      if (mode === 'select') {
        this._selectionStart = s;
        this._selectionEnd   = replEnd;
      } else if (mode === 'start') {
        this._selectionStart = s;
        this._selectionEnd   = s;
      } else if (mode === 'end') {
        this._selectionStart = replEnd;
        this._selectionEnd   = replEnd;
      } else {
        // 'preserve': adjust positions to account for the length delta.
        const delta = replacement.length - (e - s);
        let ss = this._selectionStart != null ? this._selectionStart : len;
        let se = this._selectionEnd   != null ? this._selectionEnd   : len;
        if (ss > e) ss += delta; else if (ss > s) ss = replEnd;
        if (se > e) se += delta; else if (se > s) se = replEnd;
        this._selectionStart = ss;
        this._selectionEnd   = se;
      }
    }
    select() {
      this._selectionStart = 0;
      this._selectionEnd   = (this._attrs.value || '').length;
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
      if (this._tag !== 'input') return null;
      const t = (this._attrs.type || '').toLowerCase();
      if (t !== 'file') return null;
      const list = this._files || [];
      list.item = function (i) { return this[i] || null; };
      return list;
    }

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
      // Start in 'loading' so library IIFEs (jQuery 3.x sniffs
      // `document.readyState === 'complete'` and self-schedules
      // `jQuery.ready` via setTimeout) register a DOMContentLoaded
      // listener instead of side-effecting onto the virtual clock.
      // Each per-visit `__csimLoadDocument` flips us to 'complete'
      // *after* the new body is in place, then dispatches
      // DOMContentLoaded so the queued ready cbs fire against the
      // fresh body.
      this.readyState = 'loading';
      // Pre-populate an empty html/head/body skeleton. jQuery 3.x's
      // feature-detection code captures `documentElement` at IIFE
      // evaluation time and dereferences it later (e.g.
      // `T.createElement('fieldset')` inside a `$` support probe).
      // Without a valid skeleton in the snapshot, the captured `T`
      // is null/undefined and the IIFE throws before `window.jQuery`
      // gets assigned. The per-visit `__csimLoadDocument` swaps
      // this skeleton out for the parsed-from-HTML tree.
      const html = new Element('html');
      const head = new Element('head');
      const body = new Element('body');
      html._parent = this;     this._children.push(html);
      head._parent = html;     html._children.push(head);
      body._parent = html;     html._children.push(body);
      this.documentElement = html;
    }
    // jQuery's `mc(node)` helper resolves a node back to its window
    // via `doc.defaultView || doc.parentWindow`; without these the
    // offset / scroll path throws "Cannot read properties of
    // undefined (reading 'pageYOffset')".
    get defaultView()   { return globalThis; }
    get parentWindow()  { return globalThis; }
    // Public accessor over the internal `_activeElement` slot that the
    // Element focus/blur methods write to. Returns the document's
    // body as a sentinel when no element is focused, matching real
    // browsers (HTMLBodyElement is the fallback `activeElement` per
    // the HTML spec, and libraries occasionally test for non-null
    // before reading properties).
    get activeElement() {
      return this._activeElement || this.body || null;
    }
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
      this.startOffset    = p ? p._children.indexOf(node) : 0;
    }
    setStartAfter(node)  {
      const p = node && node._parent;
      this.startContainer = p || node;
      this.startOffset    = p ? (p._children.indexOf(node) + 1) : 0;
    }
    setEndBefore(node)   {
      const p = node && node._parent;
      this.endContainer   = p || node;
      this.endOffset      = p ? p._children.indexOf(node) : 0;
    }
    setEndAfter(node)    {
      const p = node && node._parent;
      this.endContainer   = p || node;
      this.endOffset      = p ? (p._children.indexOf(node) + 1) : 0;
    }
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
      // For a Text node, the upper bound is the character length;
      // for elements, the number of child nodes.
      this.endOffset = node.nodeType === NODE_TEXT
        ? (node.data || '').length
        : (node._children ? node._children.length : 0);
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
      // For our PoC consumers, extract == clone (no actual deletion);
      // quote-reply doesn't follow up with mutating the source tree.
      return cloneRangeContents(this);
    }
    collapse(toStart) {
      if (toStart) { this.endContainer = this.startContainer; this.endOffset = this.startOffset; }
      else         { this.startContainer = this.endContainer; this.startOffset = this.endOffset; }
    }
    cloneRange() {
      const r = new DocumentOrderRange();
      r.startContainer = this.startContainer; r.startOffset = this.startOffset;
      r.endContainer   = this.endContainer;   r.endOffset   = this.endOffset;
      return r;
    }
    toString() {
      // Best-effort: emit textContent of the start container when the
      // range collapses to a single element; otherwise empty. Partial-
      // quote tests reach here but the apps under test typically guard
      // on `selection.toString().length > 0`, so emitting empty mirrors
      // the "no selection" state cleanly.
      return '';
    }
    get collapsed() { return this.startContainer === this.endContainer && this.startOffset === this.endOffset; }
    get commonAncestorContainer() {
      if (!this.startContainer) return null;
      if (this.startContainer === this.endContainer) return this.startContainer;
      // Find LCA via ancestorChain.
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
  // Range boundary-comparison constants. wgxpath reads them off the
  // range instance via `range.START_TO_END` so they have to live on
  // the prototype (not just the constructor).
  DocumentOrderRange.START_TO_START = 0;
  DocumentOrderRange.START_TO_END   = 1;
  DocumentOrderRange.END_TO_END     = 2;

  // Helper: is `descendant` either equal to or contained in `ancestor`?
  function nodeContains(ancestor, descendant) {
    return ancestor != null && ancestor.contains ? ancestor.contains(descendant) : false;
  }
  // Tags whose IDL exposes `.form` to point at the owning HTMLFormElement.
  const FORM_ASSOCIATED_TAGS = new Set([
    'input', 'select', 'textarea', 'button', 'fieldset', 'object', 'output'
  ]);
  // HTML spec "first newline removal" for textarea contents: a single
  // leading line terminator (CR LF / CR / LF) that immediately follows
  // the open tag is dropped from the IDL value. Same rule applies to
  // the form-submission serialization.
  function __stripOneLeadingNewline (s) {
    if (typeof s !== 'string' || s.length === 0) return s;
    if (s.length >= 2 && s.charCodeAt(0) === 13 && s.charCodeAt(1) === 10) return s.slice(2);
    if (s.charCodeAt(0) === 13 || s.charCodeAt(0) === 10) return s.slice(1);
    return s;
  }
  // True if `range` overlaps with `node` (the node is partially or
  // fully covered by the range). The DOM-spec algorithm is "node and
  // range share at least one boundary point or one is inside the
  // other"; we implement a conservative subset that handles the
  // single-Text-node and within-an-element cases the partial-quote
  // tests use.
  function rangeIntersectsNode(range, node) {
    if (!range.startContainer) return false;
    if (nodeContains(node, range.startContainer)) return true;
    if (nodeContains(node, range.endContainer))   return true;
    if (nodeContains(range.startContainer, node) && nodeContains(range.endContainer, node)) return true;
    // Document-order overlap: node sits between start and end at the
    // same tree level.
    const s = compareDocOrder(range.startContainer, node);
    const e = compareDocOrder(range.endContainer,   node);
    if (s <= 0 && e >= 0) return true;
    return false;
  }
  // Clone the content covered by `range` into a DocumentFragment.
  // Spec-compliant; ported from v2's `clone_range_into` (Nokogiri).
  //
  // The recursive shape: each call to __cloneSlice clones one subtree
  // bounded by two optional cuts. A null cut means "no boundary on
  // this side" (clone from the start, or to the end). If a cut's
  // container is the subtree itself, slice by offset directly; if
  // it's a descendant, recurse into the ancestor-child that contains
  // it with a tighter cut. Text-node subtrees slice by character
  // offset; Element subtrees slice by child index.
  function __rangeAncestorChild (ancestor, descendant) {
    let cur = descendant;
    while (cur && cur._parent && cur._parent !== ancestor) cur = cur._parent;
    return cur && cur._parent === ancestor ? cur : null;
  }
  function __appendCloned (parent, child) {
    child._parent = parent;
    parent._children.push(child);
  }
  // Emit (into `target`) the slice of `subtree` between the cuts.
  // `target` is usually a shell clone of `subtree`, but cloneRangeContents
  // passes its top-level DocumentFragment for the common-ancestor walk.
  function __emitSlice (target, subtree, startCut, endCut) {
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
  function __cloneSlice (subtree, startCut, endCut) {
    if (subtree.nodeType === NODE_TEXT) {
      const data = subtree.data || '';
      const lo = startCut && startCut.container === subtree ? startCut.offset : 0;
      const hi = endCut   && endCut.container === subtree   ? endCut.offset   : data.length;
      return new Text(data.slice(lo, hi));
    }
    const shell = subtree.cloneNode(false);
    __emitSlice(shell, subtree, startCut, endCut);
    return shell;
  }
  function cloneRangeContents (range) {
    const frag = new DocumentFragment();
    if (!range.startContainer || !range.endContainer) return frag;
    const sc = range.startContainer, so = range.startOffset;
    const ec = range.endContainer,   eo = range.endOffset;
    if (sc === ec) {
      if (sc.nodeType === NODE_TEXT) {
        __appendCloned(frag, new Text((sc.data || '').slice(so, eo)));
      } else if (sc._children) {
        for (let i = so; i < Math.min(eo, sc._children.length); i++) {
          __appendCloned(frag, sc._children[i].cloneNode(true));
        }
      }
      return frag;
    }
    const ancestor = range.commonAncestorContainer;
    if (ancestor) {
      __emitSlice(frag, ancestor, {container: sc, offset: so}, {container: ec, offset: eo});
    }
    return frag;
  }
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
    // Proxy target is an object so `typeof el.style === 'object'`.
    // The original `function(){}` target made it `'function'`, which
    // broke jQuery 3.x's `isHiddenWithinTree` (reads
    // `elem.style.display` after a typeof check — when `elem.style`
    // is a function jQuery skipped the inline-style branch and
    // toggle() routed to the wrong direction).
    const target = {};
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
    const decls = parseStyleDecls(el._attrs.style || '');
    return decls[name] != null ? decls[name] : '';
  }
  function writeCssProp(el, name, value) {
    // Round-trip through parseStyleDecls so the style string is
    // canonical regardless of how the existing value was written
    // (multiple writes can leave declarations without `;` separators
    // when raw `cssText` setter pastes arbitrary strings). Removing a
    // property collapses cleanly; setting overwrites.
    const decls = parseStyleDecls(el._attrs.style || '');
    if (value === '' || value == null) {
      delete decls[name];
    } else {
      decls[name] = String(value);
    }
    el.setAttribute('style', serializeStyleDecls(decls));
  }
  function removeCssProp(el, name) {
    const v = readCssProp(el, name);
    const decls = parseStyleDecls(el._attrs.style || '');
    delete decls[name];
    el.setAttribute('style', serializeStyleDecls(decls));
    return v;
  }
  function serializeStyleDecls(decls) {
    return Object.entries(decls).map(([k, v]) => k + ': ' + v).join('; ');
  }
  function parseStyleDecls(css) {
    // Char-walking parser that tolerates inputs missing `;` between
    // declarations. We scan `name: value` pairs, terminating each
    // value at `;` *or* at a look-ahead `<word>:` pattern (which can
    // only be the start of the next declaration). Existing CSS values
    // never contain `:` outside of `url(...)` parens, so peeking for
    // an unparenthesised `<word>:` is safe.
    const out = {};
    let i = 0;
    const n = css.length;
    while (i < n) {
      while (i < n && (css[i] === ';' || /\s/.test(css[i]))) i++;
      if (i >= n) break;
      const nameStart = i;
      while (i < n && /[a-zA-Z-]/.test(css[i])) i++;
      if (i === nameStart) { i++; continue; }
      const name = css.slice(nameStart, i).toLowerCase();
      while (i < n && /\s/.test(css[i])) i++;
      if (css[i] !== ':') continue;
      i++;
      while (i < n && /\s/.test(css[i])) i++;
      let value = '';
      let parenDepth = 0;
      while (i < n) {
        const c = css[i];
        if (c === '(') parenDepth++;
        else if (c === ')') parenDepth--;
        else if (c === ';' && parenDepth === 0) { i++; break; }
        else if (parenDepth === 0 && /\s/.test(c)) {
          let j = i + 1;
          while (j < n && /\s/.test(css[j])) j++;
          const wStart = j;
          while (j < n && /[a-zA-Z-]/.test(css[j])) j++;
          if (j > wStart) {
            let k = j;
            while (k < n && /\s/.test(css[k])) k++;
            if (css[k] === ':') break; // next declaration begins
          }
        }
        value += c;
        i++;
      }
      if (name) out[name] = value.trim();
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
  globalThis.MouseEvent      = class extends Event {
    constructor(type, init) {
      super(type, init);
      init = init || {};
      // Real MouseEvent defaults: button=0 (primary), which=1. Many
      // legacy click handlers (Redmine's context_menu.js, jQuery 1.x
      // probes) gate on `event.which === 1` to detect a primary click —
      // without explicit defaults our synthetic click events looked
      // like non-primary clicks and the handler bailed before
      // running its body.
      this.button    = init.button    != null ? init.button    : 0;
      this.buttons   = init.buttons   != null ? init.buttons   : 0;
      this.which     = init.which     != null ? init.which     : (this.button + 1);
      this.clientX   = init.clientX   || 0;
      this.clientY   = init.clientY   || 0;
      this.pageX     = init.pageX     != null ? init.pageX     : this.clientX;
      this.pageY     = init.pageY     != null ? init.pageY     : this.clientY;
      this.screenX   = init.screenX   || 0;
      this.screenY   = init.screenY   || 0;
      this.movementX = init.movementX || 0;
      this.movementY = init.movementY || 0;
      this.altKey    = !!init.altKey;
      this.ctrlKey   = !!init.ctrlKey;
      this.metaKey   = !!init.metaKey;
      this.shiftKey  = !!init.shiftKey;
      this.relatedTarget = init.relatedTarget || null;
    }
  };
  globalThis.KeyboardEvent   = class extends Event {
    constructor(type, init) {
      super(type, init);
      init = init || {};
      // KeyboardEvent fields per the UI Events spec — listeners gate
      // on `key` (string like 'Enter' / 'a'), `code` (physical key),
      // `keyCode` (legacy), `ctrlKey` / `metaKey` / `shiftKey` /
      // `altKey`. Redmine's jstoolbar reads `event.key.toLowerCase()`
      // and `event.ctrlKey || event.metaKey`; the document-level
      // toogleEditPreview shortcut reads the same combination.
      this.key      = init.key      != null ? String(init.key)  : '';
      this.code     = init.code     != null ? String(init.code) : '';
      this.keyCode  = init.keyCode  != null ? init.keyCode  : 0;
      this.which    = init.which    != null ? init.which    : this.keyCode;
      this.charCode = init.charCode != null ? init.charCode : 0;
      this.location = init.location != null ? init.location : 0;
      this.repeat   = !!init.repeat;
      this.isComposing = !!init.isComposing;
      this.ctrlKey  = !!init.ctrlKey;
      this.metaKey  = !!init.metaKey;
      this.shiftKey = !!init.shiftKey;
      this.altKey   = !!init.altKey;
    }
  };
  globalThis.InputEvent      = class extends Event {
    constructor(type, init) {
      super(type, init);
      init = init || {};
      // InputEvent fields — `data` is the typed text, `inputType`
      // distinguishes 'insertText' / 'deleteContentBackward' / etc.
      // Stimulus-driven `beforeinput` handlers branch on inputType.
      this.data      = init.data      != null ? String(init.data) : null;
      this.inputType = init.inputType != null ? String(init.inputType) : '';
      this.isComposing = !!init.isComposing;
    }
  };
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
    // Legacy `window.event` — IE-era global that handlers reach for
    // when no event parameter is in scope. Redmine's inline-autocomplete
    // `values()` callback (`event.target.type === 'text'`) and a few
    // other library entry points rely on it. Save / restore so nested
    // dispatches don't shadow each other.
    const prevWinEvent = globalThis.event;
    globalThis.event = event;
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
      globalThis.event = prevWinEvent;
    }
  }
  function fireListeners(node, event, capture) {
    // Inline `on<event>` attribute handler (e.g. `onclick="..."`) fires
    // alongside the addEventListener-registered listeners in the
    // bubble phase. We compile the attribute value to a function once
    // and cache it on the node so the per-click cost is one closure
    // call. Without this, Redmine's `onclick="showAndScrollTo(...);
    // return false"` never runs and the issue-notes form stays
    // collapsed (the "Quote" link is effectively a no-op).
    if (!capture && node._attrs && !event._immediatePropagationStopped) {
      const attrName = 'on' + event.type;
      // Property assignment (`el.onclick = fn`) takes precedence over
      // any `onclick="..."` attribute per HTML spec — the setter
      // *replaces* the inline handler. jstoolbar registers its Edit /
      // Preview tab handlers via `this.previewTab.onclick = ...` and
      // the click_link 'Preview' chain depends on that running.
      // Plain property access works for the read; the only thing the
      // bridge has to do is dispatch through it during the bubble.
      const propHandler = typeof node[attrName] === 'function' ? node[attrName] : null;
      const attrVal     = propHandler ? null : node._attrs[attrName];
      let handler = propHandler;
      if (!handler && attrVal != null) {
        handler = node._onCompiled && node._onCompiled[attrName];
        if (handler === undefined) {
          try { handler = new Function('event', String(attrVal)); }
          catch (_) { handler = null; }
          (node._onCompiled = node._onCompiled || {})[attrName] = handler;
        }
      }
      if (handler) {
        event.currentTarget = node;
        try {
          const ret = handler.call(node, event);
          // Returning false from an on-attribute handler cancels the
          // event's default action (HTML spec; mirrored by jQuery's
          // own behaviour for event handlers).
          if (ret === false && event.cancelable) event.defaultPrevented = true;
        } catch (e) {
          try { console.error('[csim v3] on-attribute handler threw:', e && e.message); } catch (_) {}
        }
      }
    }
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
  // Mouse-event types need MouseEvent so click-handler readers see
  // `.button` / `.shiftKey` / `.ctrlKey` / `.altKey` / `.metaKey`
  // alongside the bubbling flags. Falls back to Event for keyboard /
  // generic events.
  const MOUSE_EVENT_TYPES = new Set([
    'click', 'dblclick', 'mousedown', 'mouseup', 'mouseover', 'mouseout',
    'mouseenter', 'mouseleave', 'mousemove', 'contextmenu'
  ]);
  globalThis.__csimDispatchEvent = function (h, type, init) {
    const n = lookup(h);
    if (!n) return false;
    const ctor = MOUSE_EVENT_TYPES.has(String(type)) ? MouseEvent : Event;
    return dispatchEvent(n, new ctor(String(type), init || {}));
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
      // Dynamically-inserted <script> elements should evaluate when
      // they become part of the document. Rails-UJS's `dataType:
      // 'script'` AJAX path creates a `<script>` with `.text = response`
      // and appends to head; without this hook the response never runs
      // and AJAX flows that depend on it (Redmine's show_api_key.js.erb
      // toggling visibility) silently no-op. Only do this *after* the
      // initial page-load script pass completes — otherwise the
      // initial pass would double-eval scripts that appendChild
      // surfaced via fireCEConnect during the page-build phase.
      if (__initialScriptsDone && el._tag === 'script' && !el._csimRan) maybeRunScript(el);
      const ctor = __customElementRegistry.get(el._tag);
      if (!ctor) return;
      // Upgrade if this came from HTML parse (still a plain Element).
      if (Object.getPrototypeOf(el) !== ctor.prototype) upgradeElement(el, ctor);
      fireCEHook(el, 'connectedCallback');
    });
  }
  let __initialScriptsDone = false;

  function maybeRunScript(el) {
    const type = (el._attrs.type || '').toLowerCase();
    // Same gate as the initial parse-time scripts: classic only, no
    // modules (those go through `__csim_require`). Inline scripts in
    // the original document parse run via `runInlineScripts`; this
    // path is for dynamically-appended `<script>` elements.
    if (type && type !== 'text/javascript' && type !== 'application/javascript' &&
        type !== 'application/x-javascript' && type !== 'text/ecmascript') return;
    el._csimRan = true;
    let body;
    if (el._attrs.src) {
      try {
        const resp = __rackFetch('GET', el._attrs.src, '', null, 'follow');
        if (!resp || resp.status >= 400) return;
        body = resp.body || '';
      } catch (_) { return; }
    } else {
      body = scriptText(el);
    }
    if (!body) return;
    try { (0, eval)(body); }
    catch (e) {
      try { console.error('[csim v3] dynamic script threw:', e && e.message); } catch (_) {}
    }
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
  // ── Selectors 4 subset ──────────────────────────────────────────
  //
  // Tokenizer + parser + matcher for the slice of CSS selectors real
  // apps lean on (tag, *, #id, .class, [attr op? value?], pseudo
  // classes, `>` / `+` / `~` / descendant combinators, comma groups).
  // Each parsed unit is a `compound` plus the combinator that connects
  // it to the previous compound in the same complex selector.
  //
  // Compound shape (kept compatible with the old PoC matcher so
  // querySelector / closest / matches just keep working):
  //   { tag: string|null, id: string|null, classes: string[],
  //     attrs: [{name, op?, value?}], pseudos: [{name, args?}],
  //     combinator: 'descendant'|'child'|'adjacent'|'sibling'|null }
  //
  // `parseSelector(s)` returns a *group* — an array of *complex*
  // selectors. A complex selector is an array of compounds.
  //
  // Unsupported tokens / pseudos throw SyntaxError; callers that care
  // (jQuery's `.is(':visible')`) catch and fall back to their own
  // filter — that's preferable to silently matching everything (which
  // was the pre-throw behaviour and broke Redmine's mobile probe).

  function tokenizeSelector(s) {
    const tokens = [];
    let i = 0;
    const len = s.length;
    while (i < len) {
      const c = s[i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f') {
        while (i < len && /\s/.test(s[i])) i++;
        tokens.push({ kind: 'ws' });
        continue;
      }
      if (c === '>') { tokens.push({ kind: 'gt' }); i++; continue; }
      if (c === '+') { tokens.push({ kind: 'plus' }); i++; continue; }
      if (c === '~') { tokens.push({ kind: 'tilde' }); i++; continue; }
      if (c === ',') { tokens.push({ kind: 'comma' }); i++; continue; }
      if (c === '*') { tokens.push({ kind: 'star' }); i++; continue; }
      if (c === '#') {
        let j = i + 1;
        while (j < len && /[\w-]/.test(s[j])) j++;
        if (j === i + 1) throw new SyntaxError('csim v3: bad #id at ' + i);
        tokens.push({ kind: 'hash', value: s.slice(i + 1, j) });
        i = j; continue;
      }
      if (c === '.') {
        let j = i + 1;
        while (j < len && /[\w-]/.test(s[j])) j++;
        if (j === i + 1) throw new SyntaxError('csim v3: bad .class at ' + i);
        tokens.push({ kind: 'class', value: s.slice(i + 1, j) });
        i = j; continue;
      }
      if (c === '[') {
        let depth = 1, j = i + 1;
        while (j < len && depth > 0) {
          if (s[j] === '[') depth++;
          else if (s[j] === ']') depth--;
          if (depth > 0) j++;
        }
        if (j >= len) throw new SyntaxError('csim v3: unterminated [attr] at ' + i);
        tokens.push({ kind: 'attr', value: s.slice(i + 1, j) });
        i = j + 1; continue;
      }
      if (c === ':') {
        // single `:` for pseudo-class; `::` collapses to pseudo-element
        // which we just treat as the same (we don't model rendering
        // boxes so `::before` etc. simply won't ever match a real DOM
        // element — close enough for hide-rule extraction to ignore).
        let j = i + 1;
        if (s[j] === ':') j++;
        const nameStart = j;
        while (j < len && /[\w-]/.test(s[j])) j++;
        const name = s.slice(nameStart, j);
        if (!name) throw new SyntaxError('csim v3: bad pseudo at ' + i);
        let args = null;
        if (s[j] === '(') {
          let depth = 1, k = j + 1;
          while (k < len && depth > 0) {
            if (s[k] === '(') depth++;
            else if (s[k] === ')') depth--;
            if (depth > 0) k++;
          }
          if (k >= len) throw new SyntaxError('csim v3: unterminated pseudo args at ' + i);
          args = s.slice(j + 1, k);
          j = k + 1;
        }
        tokens.push({ kind: 'pseudo', value: name, args });
        i = j; continue;
      }
      if (/[a-zA-Z_]/.test(c)) {
        let j = i;
        while (j < len && /[\w-]/.test(s[j])) j++;
        tokens.push({ kind: 'tag', value: s.slice(i, j) });
        i = j; continue;
      }
      if (c === '&') {
        // CSS nesting parent ref — only meaningful in nested-rule
        // flattening; in stand-alone selectors we treat it as a sentinel
        // the flattener will substitute before parsing. Reaching it here
        // is a programming error.
        throw new SyntaxError('csim v3: stray & in selector');
      }
      throw new SyntaxError('csim v3: unexpected selector char: ' + JSON.stringify(c) + ' at ' + i);
    }
    return tokens;
  }

  // Backward-compat: callers (extractHideRules, …) used to call
  // splitTopLevel(selector, ',') to split before parsing. We keep the
  // helper available because the CSS extractor still uses it to slice
  // rule selectors before substitution.
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

  function parseAttrToken(s) {
    const m = /^\s*([\w-]+)\s*(?:([~|^$*]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\s\]]+)))?\s*(?:[isIS])?\s*$/.exec(s);
    if (!m) throw new SyntaxError('csim v3: bad attr selector: ' + s);
    return {
      name: m[1].toLowerCase(),
      op: m[2] || null,
      value: m[3] != null ? m[3] : (m[4] != null ? m[4] : (m[5] || ''))
    };
  }

  // Recognised pseudo-class names. `:not(...)` / `:is(...)` / `:where(...)`
  // accept a nested selector group; nth-* accept an An+B expression.
  const PSEUDO_NO_ARG = new Set([
    'first-child', 'last-child', 'only-child',
    'first-of-type', 'last-of-type', 'only-of-type',
    'empty', 'root', 'scope',
    'checked', 'disabled', 'enabled',
    'required', 'optional', 'read-only', 'read-write',
    'hover', 'focus', 'focus-within', 'focus-visible',
    'active', 'visited', 'link', 'target',
    'placeholder-shown', 'default', 'indeterminate'
  ]);
  const PSEUDO_NTH = new Set([
    'nth-child', 'nth-last-child', 'nth-of-type', 'nth-last-of-type'
  ]);

  function parsePseudoToken(name, args) {
    const n = name.toLowerCase();
    if (n === 'not' || n === 'is' || n === 'where') {
      if (args == null) throw new SyntaxError('csim v3: ' + n + ' needs args');
      return { name: n, list: parseSelector(args) };
    }
    if (PSEUDO_NTH.has(n)) {
      if (args == null) throw new SyntaxError('csim v3: ' + n + ' needs args');
      return { name: n, nth: parseNth(args) };
    }
    if (PSEUDO_NO_ARG.has(n)) return { name: n };
    // Pseudo-elements (::before etc.) — drop on the floor; they can't
    // match real DOM nodes anyway.
    if (n === 'before' || n === 'after' || n === 'first-letter' || n === 'first-line' ||
        n === 'placeholder' || n === 'selection' || n === 'marker' || n === 'backdrop') {
      return { name: '__never_match__' };
    }
    throw new SyntaxError('csim v3: unsupported pseudo :' + n);
  }

  function parseNth(s) {
    const t = s.trim().toLowerCase();
    if (t === 'odd')  return { a: 2, b: 1 };
    if (t === 'even') return { a: 2, b: 0 };
    // an+b forms: -n+3, 2n, 2n+1, +3, -1, n+3, n, -n
    const m = /^([+-]?\d*)n\s*([+-]\s*\d+)?$/.exec(t);
    if (m) {
      const aStr = m[1];
      const a = aStr === '' || aStr === '+' ? 1 : aStr === '-' ? -1 : parseInt(aStr, 10);
      const b = m[2] != null ? parseInt(m[2].replace(/\s+/g, ''), 10) : 0;
      return { a, b };
    }
    const mb = /^([+-]?\d+)$/.exec(t);
    if (mb) return { a: 0, b: parseInt(mb[1], 10) };
    throw new SyntaxError('csim v3: bad nth expression: ' + s);
  }

  function parseSelector(sel) {
    const tokens = tokenizeSelector(String(sel).trim());
    const groups = [];
    let i = 0;
    while (i < tokens.length) {
      while (i < tokens.length && (tokens[i].kind === 'ws' || tokens[i].kind === 'comma')) i++;
      if (i >= tokens.length) break;
      const parsed = parseComplex(tokens, i);
      if (parsed.complex.length) groups.push(parsed.complex);
      i = parsed.next;
    }
    return groups;
  }

  function parseComplex(tokens, i) {
    const seq = [];
    let pendingCombinator = null; // applied to the next compound
    while (i < tokens.length) {
      const t = tokens[i];
      if (t.kind === 'comma') break;
      if (t.kind === 'ws') {
        // Peek next non-ws: if it's a combinator token, the whitespace is
        // decorative; otherwise the whitespace itself is a descendant
        // combinator (assuming there's another compound after).
        let j = i + 1;
        while (j < tokens.length && tokens[j].kind === 'ws') j++;
        if (j >= tokens.length || tokens[j].kind === 'comma') { i = j; continue; }
        if (tokens[j].kind === 'gt' || tokens[j].kind === 'plus' || tokens[j].kind === 'tilde') {
          i = j; continue;
        }
        if (seq.length > 0 && pendingCombinator == null) pendingCombinator = 'descendant';
        i = j; continue;
      }
      if (t.kind === 'gt')    { pendingCombinator = 'child';    i++; continue; }
      if (t.kind === 'plus')  { pendingCombinator = 'adjacent'; i++; continue; }
      if (t.kind === 'tilde') { pendingCombinator = 'sibling';  i++; continue; }
      const parsed = parseCompound(tokens, i);
      parsed.compound.combinator = seq.length === 0 ? null : (pendingCombinator || 'descendant');
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
      if (t.kind === 'tag')   { c.tag = t.value.toLowerCase(); consumed = true; i++; continue; }
      if (t.kind === 'star')  { consumed = true; i++; continue; } // universal selector
      if (t.kind === 'hash')  { c.id = t.value; consumed = true; i++; continue; }
      if (t.kind === 'class') { c.classes.push(t.value); consumed = true; i++; continue; }
      if (t.kind === 'attr')  { c.attrs.push(parseAttrToken(t.value)); consumed = true; i++; continue; }
      if (t.kind === 'pseudo'){ c.pseudos.push(parsePseudoToken(t.value, t.args)); consumed = true; i++; continue; }
      break;
    }
    if (!consumed) throw new SyntaxError('csim v3: empty compound selector');
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
    if (u.attrs) for (const a of u.attrs) if (!matchAttr(el, a)) return false;
    if (u.pseudos) for (const p of u.pseudos) if (!matchPseudo(el, p)) return false;
    return true;
  }

  function matchAttr(el, a) {
    const v = el._attrs[a.name];
    if (a.op == null) return v != null;
    if (v == null) return false;
    switch (a.op) {
      case '=':  return v === a.value;
      case '~=': return v.split(/\s+/).includes(a.value);
      case '^=': return a.value !== '' && v.startsWith(a.value);
      case '$=': return a.value !== '' && v.endsWith(a.value);
      case '*=': return a.value !== '' && v.indexOf(a.value) >= 0;
      case '|=': return v === a.value || v.startsWith(a.value + '-');
    }
    return false;
  }

  function elementSiblings(el) {
    if (!el._parent) return [];
    return el._parent._children.filter(n => n.nodeType === NODE_ELEMENT);
  }
  function elementSiblingsOfType(el) {
    if (!el._parent) return [];
    return el._parent._children.filter(n => n.nodeType === NODE_ELEMENT && n._tag === el._tag);
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

  // an + b membership: positions are 1-based per CSS. n = 0, 1, 2, ...
  // so `position` must equal `a*n + b` for some non-negative integer n.
  function nthMatches(position, nth) {
    const { a, b } = nth;
    if (a === 0) return position === b;
    const diff = position - b;
    if (a > 0) return diff >= 0 && diff % a === 0;
    return diff <= 0 && diff % a === 0;
  }

  function matchPseudo(el, p) {
    switch (p.name) {
      case '__never_match__': return false;
      case 'not':   return !p.list.some(seq => matchComplex(el, seq));
      case 'is':
      case 'where': return p.list.some(seq => matchComplex(el, seq));
      case 'first-child': {
        const sibs = elementSiblings(el);
        return sibs.length > 0 && sibs[0] === el;
      }
      case 'last-child': {
        const sibs = elementSiblings(el);
        return sibs.length > 0 && sibs[sibs.length - 1] === el;
      }
      case 'only-child': {
        const sibs = elementSiblings(el);
        return sibs.length === 1 && sibs[0] === el;
      }
      case 'first-of-type': {
        const sibs = elementSiblingsOfType(el);
        return sibs.length > 0 && sibs[0] === el;
      }
      case 'last-of-type': {
        const sibs = elementSiblingsOfType(el);
        return sibs.length > 0 && sibs[sibs.length - 1] === el;
      }
      case 'only-of-type': {
        const sibs = elementSiblingsOfType(el);
        return sibs.length === 1 && sibs[0] === el;
      }
      case 'nth-child': {
        const sibs = elementSiblings(el);
        const idx  = sibs.indexOf(el);
        return idx >= 0 && nthMatches(idx + 1, p.nth);
      }
      case 'nth-last-child': {
        const sibs = elementSiblings(el);
        const idx  = sibs.indexOf(el);
        return idx >= 0 && nthMatches(sibs.length - idx, p.nth);
      }
      case 'nth-of-type': {
        const sibs = elementSiblingsOfType(el);
        const idx  = sibs.indexOf(el);
        return idx >= 0 && nthMatches(idx + 1, p.nth);
      }
      case 'nth-last-of-type': {
        const sibs = elementSiblingsOfType(el);
        const idx  = sibs.indexOf(el);
        return idx >= 0 && nthMatches(sibs.length - idx, p.nth);
      }
      case 'empty':
        // CSS :empty matches when the element has no children, or only
        // comment children; whitespace-only text children DO disqualify.
        for (const c of el._children) {
          if (c.nodeType === NODE_TEXT) {
            if (c.data && c.data.length > 0) return false;
          } else if (c.nodeType === NODE_ELEMENT) {
            return false;
          }
        }
        return true;
      case 'root': return el._parent && el._parent.nodeType === NODE_DOC;
      case 'checked': {
        if (el._tag === 'option') return el._attrs.selected != null;
        const t = (el._attrs.type || '').toLowerCase();
        if (el._tag === 'input' && (t === 'checkbox' || t === 'radio')) return el._attrs.checked != null;
        return false;
      }
      case 'disabled': return el._attrs.disabled != null;
      case 'enabled':  return el._attrs.disabled == null;
      case 'required': return el._attrs.required != null;
      case 'optional': return el._attrs.required == null;
      case 'read-only':  return el._attrs.readonly != null;
      case 'read-write': return el._attrs.readonly == null;
      // We don't drive a real focus/hover state machine yet, so these
      // are conservatively false. jQuery's `:hover` / `:focus` filters
      // fall back to its own DOM-state check, so this only affects
      // cascade rules that gate on them — and those rules generally
      // *reveal* content rather than hide it (so reporting false here
      // keeps the element visibility-stable until a real test cares).
      case 'scope':
        // CSS Selectors 4 :scope — matches the context element of a
        // scoped selector query. `qsa('> li', el)` is normalised to
        // `qsa(':scope > li', el)` and we set `__scopeRoot = el`
        // around the walk, so a match against `:scope` succeeds when
        // the candidate equals the root.
        return __scopeRoot != null && el === __scopeRoot;
      case 'hover': {
        // CSS `:hover` applies to the hovered element AND every
        // ancestor. We track the last-moused-over node on
        // `document._hoverElement`; matches walk up the ancestor
        // chain to decide whether `el` is on it. The hover state
        // persists across polls (no auto-clear) because Selenium
        // similarly keeps the pointer in place between user actions
        // — until the next user action moves it.
        const hov = globalThis.document && globalThis.document._hoverElement;
        if (!hov) return false;
        let cur = hov;
        while (cur) { if (cur === el) return true; cur = cur._parent; }
        return false;
      }
      case 'focus':
      case 'focus-visible': return globalThis.document && globalThis.document._activeElement === el;
      case 'focus-within': {
        const active = globalThis.document && globalThis.document._activeElement;
        if (!active) return false;
        let cur = active;
        while (cur) { if (cur === el) return true; cur = cur._parent; }
        return false;
      }
      case 'active':        return false;
      case 'visited':       return false;
      case 'link':          return el._tag === 'a' && el._attrs.href != null;
      case 'target':        return false;
      case 'placeholder-shown': return false;
      case 'default':       return false;
      case 'indeterminate': return false;
    }
    return false;
  }

  function matchComplex(el, seq) {
    if (!seq.length) return false;
    if (!matchUnit(el, seq[seq.length - 1])) return false;
    let cur = el;
    for (let i = seq.length - 2; i >= 0; i--) {
      // `combinator` on seq[i+1] describes how seq[i] connects to its
      // successor — i.e. how we step from `cur` back toward seq[i].
      const combinator = seq[i + 1].combinator;
      if (combinator === 'child') {
        cur = cur._parent;
        if (!cur || cur.nodeType !== NODE_ELEMENT || !matchUnit(cur, seq[i])) return false;
      } else if (combinator === 'adjacent') {
        cur = prevElementSibling(cur);
        if (!cur || !matchUnit(cur, seq[i])) return false;
      } else if (combinator === 'sibling') {
        let s = prevElementSibling(cur);
        while (s && !matchUnit(s, seq[i])) s = prevElementSibling(s);
        if (!s) return false;
        cur = s;
      } else {
        // descendant (the default)
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

  // Specificity (a, b, c) per CSS Selectors Level 4. Used by the
  // display/visibility cascade resolver — last source-order wins among
  // equal-specificity rules; `:not(...)` / `:is(...)` take the *max*
  // specificity of their inner selector group; `:where(...)` contributes
  // zero.
  function specificity(seq) {
    let a = 0, b = 0, c = 0;
    for (const u of seq) {
      if (u.id) a++;
      if (u.classes && u.classes.length) b += u.classes.length;
      if (u.attrs && u.attrs.length) b += u.attrs.length;
      if (u.pseudos) for (const p of u.pseudos) {
        if (p.name === 'where') continue;
        if (p.name === 'not' || p.name === 'is') {
          let max = [0, 0, 0];
          for (const inner of p.list) {
            const s = specificity(inner);
            if (compareSpec(s, max) > 0) max = s;
          }
          a += max[0]; b += max[1]; c += max[2];
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
  // Scope root for `:scope` pseudo-class. matchPseudo reads this slot
  // when resolving `:scope` so qsa with relative combinator selectors
  // (`> *`, `+ li`, `~ span`) — normalised to `:scope > …` — match
  // against the context element rather than every descendant.
  let __scopeRoot = null;
  function findAll(root, group) {
    const out = [];
    const prev = __scopeRoot; __scopeRoot = root;
    try { walk(root, el => { if (matchOne(el, group)) out.push(el); }); }
    finally { __scopeRoot = prev; }
    return out;
  }
  function findFirst(root, group) {
    let hit = null;
    const prev = __scopeRoot; __scopeRoot = root;
    try { walk(root, el => { if (!hit && matchOne(el, group)) hit = el; }); }
    finally { __scopeRoot = prev; }
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
    // Preserve attributes on the html / body / head opening tags so
    // page-level classes (Redmine's `body class="controller-timelog
    // action-report"` is what hides the unused `<fieldset#options>`
    // via a body-class-scoped rule) survive the parse round-trip.
    if (stripped.htmlAttrs) applyAttributes(root, stripped.htmlAttrs);
    if (stripped.headAttrs) applyAttributes(head, stripped.headAttrs);
    if (stripped.bodyAttrs) applyAttributes(body, stripped.bodyAttrs);
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
    const htmlMatch = /<html\b([^>]*)>/i.exec(html);
    const headMatch = /<head\b([^>]*)>([\s\S]*?)<\/head>/i.exec(html);
    const bodyMatch = /<body\b([^>]*)>([\s\S]*?)<\/body>/i.exec(html);
    const head    = headMatch ? headMatch[2] : '';
    const body    = bodyMatch ? bodyMatch[2] : '';
    const htmlAttrs = htmlMatch ? htmlMatch[1] : '';
    const headAttrs = headMatch ? headMatch[1] : '';
    const bodyAttrs = bodyMatch ? bodyMatch[1] : '';
    if (bodyMatch) return { head, body, htmlAttrs, headAttrs, bodyAttrs };
    // No wrapper: the whole input is body content. Strip <!doctype>.
    return { head, htmlAttrs, headAttrs, bodyAttrs,
             body: html.replace(/<!doctype[^>]*>/i, '').replace(/<\/?html\b[^>]*>/gi, '') };
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
    // Tag regex: allow `>` inside quoted attribute values. Real HTML
    // only ends a tag on an unquoted `>`; without honouring quotes,
    // attributes like `data-action="click->stim#action"` (which
    // Stimulus / Hotwire emit pervasively) end the tag prematurely
    // and split the value into bogus garbage attributes. The repeated
    // alternation handles bare chars, double-quoted strings, and
    // single-quoted strings; everything else stops at `>`.
    const re = /<(\/?)([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
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
  // HTMLFormElement named-item access: `form.foo` returns the form
  // control whose `name` (or `id`) is `foo`. The Proxy delegates
  // anything Element already owns (methods, attrs, IDL) and falls
  // back to a named lookup on miss. Cached on the form so identity
  // checks (`button.form === form`) hold across multiple reads.
  function __formNamedAccess (form) {
    if (form._namedAccessProxy) return form._namedAccessProxy;
    const proxy = new Proxy(form, {
      get (target, key) {
        if (key in target) return target[key];
        if (typeof key !== 'string') return target[key];
        // Search descendants for matching name / id form controls.
        for (const f of target.elements || []) {
          if (f._attrs && (f._attrs.name === key || f._attrs.id === key)) return f;
        }
        return undefined;
      }
    });
    form._namedAccessProxy = proxy;
    return proxy;
  }
  // Selectors that start with a combinator (`> *`, `+ li`, `~ span`)
  // are relative to the context — jQuery's `.find('> *')` exercises
  // this for children-only queries. Native qsa doesn't accept the
  // leading combinator; we strip it and rely on `findAll` /
  // `findFirst` only descending into direct children for the first
  // selector unit when this flag is set. Since `parseSelector`
  // already produces a "child combinator from context" semantic with
  // a leading `>`, the simplest patch is: pass it through to the
  // selector parser unchanged after dropping the leading whitespace
  // — the parser already handles a leading combinator.
  function __normaliseScopedSelector(sel) {
    if (typeof sel !== 'string') return sel;
    const trimmed = sel.replace(/^\s+/, '');
    if (trimmed.startsWith('>') || trimmed.startsWith('+') || trimmed.startsWith('~')) {
      // Use `:scope` so `parseSelector` can match against the
      // context element (we handle `:scope` in matchPseudo). The
      // overall effect: `:scope > li` selects direct `<li>` children.
      return ':scope ' + trimmed;
    }
    return sel;
  }
  // Tag the returned Array as HTMLCollection-shaped (Array + `.item(i)`
  // + `.namedItem(name)`). DOM spec returns HTMLCollection; lots of
  // Redmine code paths (updateSVGIcon, etc.) do `collection.item(0)`.
  function __htmlCollection (arr) {
    arr.item = function (i) { return this[i] || null; };
    arr.namedItem = function (n) {
      for (const el of this) if (el && (el._attrs && (el._attrs.id === n || el._attrs.name === n))) return el;
      return null;
    };
    return arr;
  }
  // Used by `ChildNode.before/after/replaceWith` + `ParentNode.append
  // /prepend` to accept strings (auto-wrap as Text) alongside nodes.
  function toNode(v) {
    if (v && (v.nodeType === NODE_ELEMENT || v.nodeType === NODE_TEXT || v.nodeType === NODE_FRAGMENT || v.nodeType === NODE_DOC)) return v;
    return new Text(v == null ? '' : String(v));
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
  // DOM collection / element-subtype aliases. Libraries do constructor
  // identity tests (`x.constructor === NodeList`, `x instanceof
  // HTMLCollection`) to discriminate collections from plain arrays.
  // Aliasing each to its closest live shape (Array for index-and-
  // length collections, Element for typed-element checks) keeps those
  // probes from throwing ReferenceError. Tribute hits this on
  // `e.constructor === NodeList`; DOMPurify on `NamedNodeMap` /
  // `HTMLFormElement`.
  globalThis.NodeList            = Array;
  globalThis.HTMLCollection      = Array;
  globalThis.NamedNodeMap        = Array;
  // `instanceof Foo` / `el.constructor === Foo` checks across DOMPurify,
  // Tribute, Stimulus, jQuery — alias every typed-element name to
  // `Element` (or `Text` for character-data subtypes) so the probes
  // don't ReferenceError. Real subclass shapes are out of scope; the
  // structural check is the only consumer.
  for (const name of [
    'HTMLFormElement', 'HTMLInputElement', 'HTMLTextAreaElement',
    'HTMLSelectElement', 'HTMLOptionElement', 'HTMLButtonElement',
    'HTMLAnchorElement', 'HTMLImageElement', 'HTMLScriptElement',
    'HTMLDivElement', 'HTMLSpanElement', 'HTMLTableElement',
    'HTMLLabelElement', 'HTMLLIElement', 'HTMLUListElement',
    'HTMLOListElement', 'HTMLAreaElement', 'HTMLBodyElement',
    'HTMLCanvasElement', 'HTMLDialogElement', 'HTMLHeadElement',
    'HTMLHtmlElement', 'HTMLIFrameElement', 'HTMLLinkElement',
    'HTMLMetaElement', 'HTMLStyleElement', 'HTMLTemplateElement',
    'ShadowRoot', 'SVGElement'
  ]) globalThis[name] = Element;
  globalThis.HTMLDocument  = Document;
  globalThis.CharacterData = Text;
  globalThis.Comment       = Text;
  // `Window` global class — sandboxes / wrappers do `instanceof Window`
  // to distinguish a window from other globals. Real Window has many
  // members; we just need the constructor for the identity check.
  globalThis.Window = function Window () {};
  // `new Option(text, value, defaultSelected, selected)` — old DOM
  // constructor still used by some Stimulus controllers / select
  // refresh paths to build replacement options.
  globalThis.Option = function Option (text, value, defaultSelected, selected) {
    const o = globalThis.document.createElement('option');
    if (text !== undefined)  o.textContent = String(text);
    if (value !== undefined) o.setAttribute('value', String(value));
    if (defaultSelected)     o.setAttribute('selected', '');
    if (selected)            o.selected = true;
    return o;
  };

  globalThis.document = new Document();
  globalThis.window   = globalThis;
  // Window self-references that frame-aware code consults at boot:
  // `top`, `parent`, `self`, `frames`, `frameElement`. We're a
  // single-window runtime, so all of them point at the same global
  // (or null for frameElement — we're not framed).
  globalThis.self    = globalThis;
  globalThis.top     = globalThis;
  globalThis.parent  = globalThis;
  globalThis.frames  = globalThis;
  globalThis.frameElement = null;
  // Layout-driven stubs — no real layout, so device pixel ratio is 1
  // and `screen` is a fixed viewport. Libraries probe these for HiDPI
  // / responsive decisions; we let everything fall to the "small
  // desktop" branch.
  globalThis.devicePixelRatio = 1;
  globalThis.screen = {
    width: 1024, height: 768,
    availWidth: 1024, availHeight: 768,
    colorDepth: 24, pixelDepth: 24,
    orientation: { angle: 0, type: 'landscape-primary' }
  };
  // `matchMedia(query)` — returns a MediaQueryList-shaped object with
  // `matches=false` (we don't have layout, so no query matches).
  globalThis.matchMedia = function matchMedia (query) {
    return {
      media: String(query || ''),
      matches: false,
      onchange: null,
      addListener: () => {}, removeListener: () => {},
      addEventListener: () => {}, removeEventListener: () => {},
      dispatchEvent: () => false
    };
  };
  // `performance.now()` returns ms since the runtime started — not the
  // virtual JS clock, since most callers (perf timing, jitter
  // smoothing) want monotonic wall time, not virtual ticks.
  const __perfStart = Date.now();
  globalThis.performance = {
    now ()        { return Date.now() - __perfStart; },
    timeOrigin:    __perfStart,
    timing:       { navigationStart: __perfStart },
    mark ()       {},
    measure ()    {},
    getEntries () { return []; },
    getEntriesByName () { return []; },
    getEntriesByType () { return []; },
    clearMarks ()    {},
    clearMeasures () {}
  };
  // `structuredClone` — deep clone via JSON for the JSON-safe subset.
  // Real structuredClone covers Map/Set/Date/typed arrays/cycles;
  // we fall back to a no-clone passthrough on JSON failure.
  globalThis.structuredClone = function structuredClone (v) {
    if (v == null || typeof v !== 'object') return v;
    try { return JSON.parse(JSON.stringify(v)); }
    catch (_) { return v; }
  };
  // `reportError(error)` — spec: dispatch error event on global, log
  // if unhandled. Logging is enough for our scenarios.
  globalThis.reportError = function reportError (e) {
    try { console.error(e && e.stack ? e.stack : String(e)); } catch (_) {}
  };
  // `requestIdleCallback` / `cancelIdleCallback` — fall back to
  // `setTimeout(0)` so libraries that defer expensive setup to idle
  // (Turbo Drive prefetch, Stimulus debounced renders) make progress.
  globalThis.requestIdleCallback = function (cb) {
    return setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 0 }), 0);
  };
  globalThis.cancelIdleCallback = function (id) { clearTimeout(id); };

  // `NodeFilter` constants — DOMPurify constructs TreeWalker /
  // NodeIterator with these masks. We don't ship a full TreeWalker
  // yet (no consumer in Redmine's failing set), but the constants
  // need to exist so the constructor call doesn't throw.
  globalThis.NodeFilter = {
    SHOW_ALL:                    0xFFFFFFFF,
    SHOW_ELEMENT:                1,
    SHOW_ATTRIBUTE:              2,
    SHOW_TEXT:                   4,
    SHOW_CDATA_SECTION:          8,
    SHOW_PROCESSING_INSTRUCTION: 64,
    SHOW_COMMENT:                128,
    SHOW_DOCUMENT:               256,
    SHOW_DOCUMENT_TYPE:          512,
    SHOW_DOCUMENT_FRAGMENT:      1024,
    FILTER_ACCEPT: 1,
    FILTER_REJECT: 2,
    FILTER_SKIP:   3
  };
  // Layout-driven observers — apps construct these at module init
  // (Turbo's FrameController is the canonical case); they expect the
  // constructor to succeed and `observe()` to be a no-op when there's
  // no layout. `takeRecords()` returns empty so dirty-tracking code
  // doesn't loop.
  class CsimStubObserver {
    constructor (cb)         { this._cb = cb; }
    observe ()               {}
    unobserve ()             {}
    disconnect ()            {}
    takeRecords ()           { return []; }
  }
  globalThis.IntersectionObserver  = class extends CsimStubObserver {};
  globalThis.ResizeObserver        = class extends CsimStubObserver {};
  globalThis.PerformanceObserver   = class extends CsimStubObserver {};

  // `AbortSignal` — pair with AbortController; instanceof checks fall
  // back to a "never aborted" signal.
  globalThis.AbortSignal = function AbortSignal () {
    this.aborted = false;
  };
  globalThis.AbortSignal.abort = function (reason) {
    const s = new globalThis.AbortSignal();
    s.aborted = true; s.reason = reason;
    return s;
  };
  globalThis.AbortSignal.timeout = function () {
    return new globalThis.AbortSignal();
  };

  // `EventTarget` global class — apps do `class Foo extends
  // EventTarget` (Avo's date-picker, mapbox shims, Stimulus base in
  // some versions). Per-instance handler-list dispatch.
  globalThis.EventTarget = class EventTarget {
    constructor () {
      Object.defineProperty(this, '_etListeners', { value: new Map(), enumerable: false });
    }
    addEventListener (type, handler) {
      if (typeof handler !== 'function' && !(handler && typeof handler.handleEvent === 'function')) return;
      const arr = this._etListeners.get(type) || [];
      if (!arr.includes(handler)) arr.push(handler);
      this._etListeners.set(type, arr);
    }
    removeEventListener (type, handler) {
      const arr = this._etListeners.get(type);
      if (!arr) return;
      const i = arr.indexOf(handler);
      if (i >= 0) arr.splice(i, 1);
    }
    dispatchEvent (event) {
      if (event && event.target == null) event.target = this;
      const list = this._etListeners.get(event && event.type);
      if (!list) return true;
      for (const h of list.slice()) {
        try {
          if (typeof h === 'function') h.call(this, event);
          else                          h.handleEvent.call(h, event);
        } catch (e) {
          try { console.error('[csim v3] EventTarget listener threw:', e && e.message); } catch (_) {}
        }
      }
      return !event.defaultPrevented;
    }
  };

  // ── Blob / File / FileReader ────────────────────────────────────
  //
  // Used by file-attachment paths + dynamic asset generation (Avo's
  // export-to-CSV blob, image-cropper widgets, FileSaver.js). The
  // Blob bytes are stored as concatenated string parts; binary
  // round-trips aren't supported (no FileReader async streaming),
  // but `.text()` / `.arrayBuffer()` / `.size` / `.type` work.
  globalThis.Blob = class Blob {
    constructor (parts, opts) {
      const i = opts || {};
      this._parts = (parts || []).map(p => {
        if (typeof p === 'string') return p;
        if (p && p.text) return ''; // Nested Blob — defer fetching
        if (p instanceof ArrayBuffer) {
          const view = new Uint8Array(p);
          let s = '';
          for (let k = 0; k < view.length; k++) s += String.fromCharCode(view[k]);
          return s;
        }
        return String(p);
      });
      this.size = this._parts.reduce((s, p) => s + (p ? p.length : 0), 0);
      this.type = i.type || '';
    }
    text ()        { return Promise.resolve(this._parts.join('')); }
    arrayBuffer () {
      return this.text().then(t => {
        const b = new ArrayBuffer(t.length);
        const v = new Uint8Array(b);
        for (let i = 0; i < t.length; i++) v[i] = t.charCodeAt(i) & 0xff;
        return b;
      });
    }
    slice (start, end, type) {
      const all = this._parts.join('');
      return new globalThis.Blob([all.slice(start || 0, end == null ? undefined : end)], { type: type || this.type });
    }
    stream () { return null; }
  };
  globalThis.File = class File extends globalThis.Blob {
    constructor (parts, name, opts) {
      super(parts, opts);
      const i = opts || {};
      this.name = String(name == null ? '' : name);
      this.lastModified = i.lastModified || Date.now();
    }
  };
  // `URL.createObjectURL` / `revokeObjectURL` for Blob URLs. The
  // installer runs after `globalThis.URL` is defined further below,
  // and the Blob registry is stored on a hidden symbol so subsequent
  // installs share the same table.
  const __csimBlobs = globalThis.__csimBlobs = globalThis.__csimBlobs || new Map();
  globalThis.__csimBlobCounter = globalThis.__csimBlobCounter || { n: 0 };
  function __csimInstallBlobURL () {
    if (!globalThis.URL || globalThis.URL.__csimBlobInstalled) return;
    globalThis.URL.createObjectURL = function (blob) {
      const url = 'blob:csim-' + (++globalThis.__csimBlobCounter.n);
      __csimBlobs.set(url, blob);
      return url;
    };
    globalThis.URL.revokeObjectURL = function (url) { __csimBlobs.delete(url); };
    globalThis.URL.__csimBlobInstalled = true;
  }
  if (globalThis.URL) __csimInstallBlobURL();
  // Minimal FileReader — apps that mount file pickers (image preview
  // widgets) read the chosen File via `reader.readAsDataURL` /
  // `readAsText`. We feed the synchronous Blob.text() result back via
  // the event the next microtask.
  globalThis.FileReader = class FileReader extends globalThis.EventTarget {
    constructor () { super(); this.result = null; this.readyState = 0; this.error = null; }
    readAsText (blob) { this._read(blob, t => t); }
    readAsDataURL (blob) { this._read(blob, t => 'data:' + (blob.type || 'application/octet-stream') + ';base64,' + (__csim_btoa ? __csim_btoa(t) : '')); }
    readAsArrayBuffer (blob) { this._read(blob, t => { const b = new ArrayBuffer(t.length); const v = new Uint8Array(b); for (let i = 0; i < t.length; i++) v[i] = t.charCodeAt(i) & 0xff; return b; }); }
    readAsBinaryString (blob) { this._read(blob, t => t); }
    abort () { this.readyState = 2; this._fire('abort'); }
    _read (blob, transform) {
      const self = this;
      self.readyState = 1;
      Promise.resolve(blob && blob.text ? blob.text() : '').then(t => {
        try { self.result = transform(t); self.readyState = 2; self._fire('load'); self._fire('loadend'); }
        catch (e) { self.error = e; self.readyState = 2; self._fire('error'); self._fire('loadend'); }
      });
    }
    _fire (type) {
      const ev = { type, target: this, currentTarget: this };
      if (typeof this['on' + type] === 'function') {
        try { this['on' + type](ev); } catch (_) {}
      }
      try { this.dispatchEvent(ev); } catch (_) {}
    }
  };

  // ── Web Storage ─────────────────────────────────────────────────
  //
  // localStorage / sessionStorage — in-process Map per Browser. Per
  // memory `web_storage_persistence`, v2 routes these through Ruby so
  // they survive `boot_vm` rebuilds; v3 rebuilds per visit too, so
  // we'd need the same Ruby-backed model for cross-visit persistence.
  // For same-visit reads/writes the JS-side map is enough.
  function __csimMakeStorage () {
    const m = new Map();
    const storage = {
      get length () { return m.size; },
      key (i) {
        const keys = Array.from(m.keys());
        return i >= 0 && i < keys.length ? keys[i] : null;
      },
      getItem (k)    { return m.has(String(k)) ? m.get(String(k)) : null; },
      setItem (k, v) { m.set(String(k), String(v == null ? '' : v)); },
      removeItem (k) { m.delete(String(k)); },
      clear ()       { m.clear(); }
    };
    return storage;
  }
  globalThis.localStorage   = __csimMakeStorage();
  globalThis.sessionStorage = __csimMakeStorage();

  // ── ClipboardEvent ──────────────────────────────────────────────
  //
  // Apps that handle paste / copy with a real ClipboardEvent (Trix,
  // Avo's image-cropper paste) check `event.clipboardData.getData(...)`.
  // We construct a minimal DataTransfer shape from `init.clipboardData`
  // or a flat `init.clipboardDataText` string.
  globalThis.ClipboardEvent = class ClipboardEvent extends Event {
    constructor (type, init) {
      super(type, init);
      const i = init || {};
      let cd = null;
      if (i.clipboardData) {
        cd = i.clipboardData;
      } else if ('clipboardDataText' in i) {
        const text = i.clipboardDataText == null ? '' : String(i.clipboardDataText);
        cd = {
          types: ['text/plain'],
          getData (kind) { return (kind === 'text' || kind === 'text/plain') ? text : ''; },
          setData () {}
        };
      }
      Object.defineProperty(this, 'clipboardData', { value: cd, writable: true, configurable: true, enumerable: true });
    }
  };
  // location proxy. URL components mirror what Ruby's V3Browser
  // tracks; updated on each `__csimLoadDocument(html, url)`. Library
  // code (jQuery 1.x feature detect, Turbo Drive) reads `.href` early
  // so we need at least a non-throwing initial value.
  globalThis.location = makeLocation('http://www.example.com/');
  function makeLocation(url) {
    return parseUrlForLocation(url);
  }
  // Assigning to a property on `window.location` (`location.href = X`,
  // `location.pathname = X`, `location.hash = X`, …) navigates in real
  // browsers — it's syntactic sugar over `location.assign(resolved)`.
  // Without setters here the assignment silently no-ops, so any test
  // that triggers a setTimeout-driven path change via assignment hangs
  // until its `default_max_wait_time` expires.
  function parseUrlForLocation(url) {
    try {
      const u = __csim_parseUrl(url, null);
      if (u && !u.error) {
        const loc = Object.assign({}, u, {
          toString() { return this.href; },
          assign:  (next) => __locationAssign(next),
          replace: (next) => __locationAssign(next),
          reload:  () => __locationReload()
        });
        const navTarget = (resolved) => __locationAssign(resolved);
        Object.defineProperty(loc, 'href', {
          configurable: true,
          get() { return u.href; },
          set(v) { navTarget(String(v)); }
        });
        // Rebuild the absolute URL from this location's parts with one
        // part swapped — our `URL` doesn't update `href` when a part
        // setter fires, so a `new URL(u.href)` + assign approach would
        // navigate back to the original href instead of the new one.
        const composeWith = (overrides) => {
          const o = Object.assign({}, u, overrides);
          const cred = o.username || o.password
            ? (o.username || '') + (o.password ? ':' + o.password : '') + '@'
            : '';
          return (o.protocol || '') + '//' + cred + (o.host || '') +
                 (o.pathname || '') + (o.search || '') + (o.hash || '');
        };
        const assignPart = (key, prefix) => {
          Object.defineProperty(loc, key, {
            configurable: true,
            get() { return u[key]; },
            set(v) {
              const s = String(v == null ? '' : v);
              const part = prefix && s.length > 0 && !s.startsWith(prefix) ? prefix + s : s;
              navTarget(composeWith({ [key]: part }));
            }
          });
        };
        assignPart('pathname', '/');
        assignPart('hash',     '#');
        assignPart('search',   '?');
        return loc;
      }
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
  // Clipboard buffer — Promise-shaped read/write so Stimulus
  // `navigator.clipboard.writeText(...)` from `copyToClipboard` /
  // `clipboard#copyPre` resolves cleanly. The buffer is in-process
  // and survives across visits in the same Browser (real browsers
  // share a system clipboard; we just need round-trip parity for the
  // copy-then-paste flow tested by `copy_*_to_clipboard`).
  let __clipboardText = '';
  globalThis.navigator = {
    userAgent: 'capybara-simulated/v3 (V8-resident DOM)',
    appName:   'Netscape',
    appVersion:'5.0',
    platform:  'Linux',
    language:  'en-US',
    languages: ['en-US', 'en'],
    onLine:    true,
    cookieEnabled: true,
    clipboard: {
      writeText (text) {
        __clipboardText = String(text == null ? '' : text);
        return Promise.resolve();
      },
      readText () { return Promise.resolve(__clipboardText); },
      // Generic write/read with ClipboardItem entries (rare in app
      // code; provide a stub so feature-detection doesn't trip).
      write () { return Promise.resolve(); },
      read  () { return Promise.resolve([]); }
    }
  };
  globalThis.__csimClipboardGet = function () { return __clipboardText; };
  globalThis.__csimClipboardSet = function (text) { __clipboardText = String(text == null ? '' : text); };
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

  // Selection / `window.getSelection()` — minimal stub. Real apps
  // reading `selection.toString()` for partial-quote / copy-on-select
  // flows fall through to the "no selection" branch (length === 0)
  // without crashing. `addRange` / `removeAllRanges` are noops so
  // execCommand-style libraries don't trip over missing methods.
  class CsimSelection {
    constructor() { this._ranges = []; }
    get rangeCount()  { return this._ranges.length; }
    get isCollapsed() {
      if (!this._ranges.length) return true;
      const r = this._ranges[0];
      return r.collapsed;
    }
    get anchorNode()  { return this._ranges.length ? this._ranges[0].startContainer : null; }
    get focusNode()   { return this._ranges.length ? this._ranges[0].endContainer   : null; }
    get anchorOffset(){ return this._ranges.length ? this._ranges[0].startOffset    : 0; }
    get focusOffset() { return this._ranges.length ? this._ranges[0].endOffset      : 0; }
    get type()        { return this._ranges.length ? (this.isCollapsed ? 'Caret' : 'Range') : 'None'; }
    toString() {
      if (!this._ranges.length) return '';
      // Best-effort: emit the textContent of cloneContents() for the
      // first range. This isn't the spec algorithm (which walks the
      // range with whitespace collapsing) but matches what quote-reply
      // and the partial-quote tests actually inspect.
      const frag = cloneRangeContents(this._ranges[0]);
      return frag.textContent || '';
    }
    getRangeAt(i)     { return this._ranges[i] || null; }
    addRange(r)       { this._ranges.push(r); }
    removeRange(r)    { const i = this._ranges.indexOf(r); if (i >= 0) this._ranges.splice(i, 1); }
    removeAllRanges() { this._ranges.length = 0; }
    empty()           { this._ranges.length = 0; }
    collapse()        { this._ranges.length = 0; }
    collapseToStart() {}
    collapseToEnd()   {}
    selectAllChildren() {}
    extend()          {}
    // True if `node` is contained (fully if `partial` is false, or
    // even partially if `partial` is true) within any range of the
    // selection. quote-reply gates `isSelected` on this for the
    // "selection partially covers target element" check before
    // walking the range.
    containsNode(node, partial) {
      for (const r of this._ranges) {
        if (rangeIntersectsNode(r, node)) {
          if (partial) return true;
          // Strict full containment: range start must be at or before
          // node, end must be at or after.
          if (nodeContains(r.startContainer, node) === false &&
              nodeContains(r.endContainer, node) === false &&
              nodeContains(node, r.startContainer) === true &&
              nodeContains(node, r.endContainer) === true) {
            return true;
          }
        }
      }
      return false;
    }
    deleteFromDocument() {}
  }
  globalThis.Selection = CsimSelection;
  const __sharedSelection = new CsimSelection();
  globalThis.getSelection = function () { return __sharedSelection; };

  // `DOMParser` — parse an HTML / XML string into a Document. Turndown
  // (used by quote-reply Stimulus controller) checks `new DOMParser()`
  // at module-load time; without it, Turndown falls back to
  // `document.implementation.createHTMLDocument('').open()` which then
  // throws because we don't implement the legacy `Document.open()`.
  // Providing native DOMParser keeps Turndown on its fast path.
  globalThis.DOMParser = class DOMParser {
    parseFromString(input, mimeType) {
      const html = String(input == null ? '' : input);
      const t = String(mimeType || 'text/html').toLowerCase();
      if (t.indexOf('html') >= 0) return parseDocument(html);
      // XML / SVG / etc.: parse with the same loose parser, just for
      // the shape — Capybara-driven tests rarely poke past the root.
      return parseDocument(html);
    }
  };

  // ── Fetch / URL / Headers / FormData / URLSearchParams ──────────
  //
  // Modern Stimulus controllers + `@rails/request.js` lean on
  // `window.fetch(url, opts)` + `URL` / `Headers` / `FormData`. The
  // PoC implementation is synchronous-under-the-hood — `__rackFetch`
  // resolves the Rack app inline — but the public surface looks like
  // the real async fetch (returns a Promise; `Response#text/json`
  // also return Promises). V8 microtasks drain after each Context#eval
  // so the `await fetch(...)` chains in request.js progress without
  // any explicit ticking.
  globalThis.URL = function URL (input, base) {
    const u = __csim_parseUrl(String(input), base != null ? String(base) : null);
    if (!u || u.error) throw new TypeError('Invalid URL: ' + input);
    this.href     = u.href;
    this.protocol = u.protocol;
    this.username = u.username;
    this.password = u.password;
    this.host     = u.host;
    this.hostname = u.hostname;
    this.port     = u.port;
    this.pathname = u.pathname;
    this.search   = u.search;
    this.hash     = u.hash;
    this.origin   = u.origin;
    this.searchParams = new URLSearchParams(this.search);
  };
  globalThis.URL.prototype.toString = function () { return this.href; };
  // Real Blob URL bindings — `__csimInstallBlobURL` wires
  // createObjectURL / revokeObjectURL to the shared Blob registry
  // defined further up. The earlier conditional install is a no-op
  // when this section is the first definer of `globalThis.URL`.
  __csimInstallBlobURL();

  globalThis.URLSearchParams = function URLSearchParams (init) {
    this._entries = [];
    if (typeof init === 'string') {
      let s = init;
      if (s.charAt(0) === '?') s = s.slice(1);
      if (s.length) {
        for (const pair of s.split('&')) {
          const idx = pair.indexOf('=');
          const k = idx >= 0 ? pair.slice(0, idx) : pair;
          const v = idx >= 0 ? pair.slice(idx + 1)   : '';
          this._entries.push([decodeURIComponent(k.replace(/\+/g, ' ')), decodeURIComponent(v.replace(/\+/g, ' '))]);
        }
      }
    } else if (init && typeof init.forEach === 'function') {
      init.forEach((v, k) => this._entries.push([String(k), String(v)]));
    } else if (Array.isArray(init)) {
      for (const e of init) this._entries.push([String(e[0]), String(e[1])]);
    } else if (init && typeof init === 'object') {
      for (const k of Object.keys(init)) this._entries.push([k, String(init[k])]);
    }
  };
  Object.defineProperties(globalThis.URLSearchParams.prototype, {
    append:   { value: function (k, v) { this._entries.push([String(k), String(v)]); }, writable: true, configurable: true },
    delete:   { value: function (k) { this._entries = this._entries.filter(e => e[0] !== String(k)); }, writable: true, configurable: true },
    get:      { value: function (k) { for (const e of this._entries) if (e[0] === String(k)) return e[1]; return null; }, writable: true, configurable: true },
    getAll:   { value: function (k) { return this._entries.filter(e => e[0] === String(k)).map(e => e[1]); }, writable: true, configurable: true },
    has:      { value: function (k) { return this._entries.some(e => e[0] === String(k)); }, writable: true, configurable: true },
    set:      { value: function (k, v) { this.delete(k); this.append(k, v); }, writable: true, configurable: true },
    entries:  { value: function () { return this._entries[Symbol.iterator] ? this._entries[Symbol.iterator]() : this._entries.values(); }, writable: true, configurable: true },
    keys:     { value: function () { return this._entries.map(e => e[0])[Symbol.iterator](); }, writable: true, configurable: true },
    values:   { value: function () { return this._entries.map(e => e[1])[Symbol.iterator](); }, writable: true, configurable: true },
    forEach:  { value: function (fn) { for (const e of this._entries) fn(e[1], e[0], this); }, writable: true, configurable: true },
    toString: { value: function () { return this._entries.map(e => encodeURIComponent(e[0]) + '=' + encodeURIComponent(e[1])).join('&'); }, writable: true, configurable: true },
    [Symbol.iterator]: { value: function () { return this.entries(); }, writable: true, configurable: true }
  });

  function __normaliseHeaderName (k) { return String(k).toLowerCase(); }
  globalThis.Headers = function Headers (init) {
    this._map = new Map();
    if (init) {
      if (init instanceof globalThis.Headers) {
        init.forEach((v, k) => this.append(k, v));
      } else if (Array.isArray(init)) {
        for (const e of init) this.append(e[0], e[1]);
      } else if (typeof init === 'object') {
        for (const k of Object.keys(init)) this.append(k, init[k]);
      }
    }
  };
  Object.defineProperties(globalThis.Headers.prototype, {
    append:  { value: function (k, v) {
      const key = __normaliseHeaderName(k);
      const prev = this._map.get(key);
      this._map.set(key, prev == null ? String(v) : prev + ', ' + String(v));
    }, writable: true, configurable: true },
    delete:  { value: function (k) { this._map.delete(__normaliseHeaderName(k)); }, writable: true, configurable: true },
    get:     { value: function (k) { const v = this._map.get(__normaliseHeaderName(k)); return v == null ? null : v; }, writable: true, configurable: true },
    has:     { value: function (k) { return this._map.has(__normaliseHeaderName(k)); }, writable: true, configurable: true },
    set:     { value: function (k, v) { this._map.set(__normaliseHeaderName(k), String(v)); }, writable: true, configurable: true },
    forEach: { value: function (fn) { this._map.forEach((v, k) => fn(v, k, this)); }, writable: true, configurable: true },
    entries: { value: function () { return this._map.entries(); }, writable: true, configurable: true },
    keys:    { value: function () { return this._map.keys(); }, writable: true, configurable: true },
    values:  { value: function () { return this._map.values(); }, writable: true, configurable: true },
    [Symbol.iterator]: { value: function () { return this.entries(); }, writable: true, configurable: true }
  });

  globalThis.FormData = function FormData (form) {
    this._entries = [];
    // `new FormData(form)` populates from the form's submittable
    // controls. Rails-UJS's data-remote multipart path constructs
    // FormData(form) and immediately calls `xhr.send(fd)`; without
    // this branch the FormData is empty and the server reads zero
    // params from what looks like an empty form submit.
    if (form && form._tag === 'form') {
      const spec = globalThis.__csimFormSerialize(form._id, 0);
      if (spec && Array.isArray(spec.fields)) {
        for (const pair of spec.fields) this._entries.push([String(pair[0]), String(pair[1])]);
      }
    }
  };
  // Define methods on FormData.prototype so `instance.constructor`
  // stays pointing at FormData and `instance instanceof FormData`
  // remains true (replacing the prototype object with a literal
  // wiped the constructor link).
  Object.defineProperties(globalThis.FormData.prototype, {
    append:  { value: function (k, v) { this._entries.push([String(k), v]); }, writable: true, configurable: true },
    delete:  { value: function (k)    { this._entries = this._entries.filter(e => e[0] !== String(k)); }, writable: true, configurable: true },
    get:     { value: function (k)    { for (const e of this._entries) if (e[0] === String(k)) return e[1]; return null; }, writable: true, configurable: true },
    getAll:  { value: function (k)    { return this._entries.filter(e => e[0] === String(k)).map(e => e[1]); }, writable: true, configurable: true },
    has:     { value: function (k)    { return this._entries.some(e => e[0] === String(k)); }, writable: true, configurable: true },
    set:     { value: function (k, v) { this.delete(k); this.append(k, v); }, writable: true, configurable: true },
    forEach: { value: function (fn)   { for (const e of this._entries) fn(e[1], e[0], this); }, writable: true, configurable: true },
    entries: { value: function ()     { return this._entries[Symbol.iterator](); }, writable: true, configurable: true },
    keys:    { value: function ()     { return this._entries.map(e => e[0])[Symbol.iterator](); }, writable: true, configurable: true },
    values:  { value: function ()     { return this._entries.map(e => e[1])[Symbol.iterator](); }, writable: true, configurable: true },
    [Symbol.iterator]: { value: function () { return this.entries(); }, writable: true, configurable: true }
  });

  globalThis.AbortController = function AbortController () {
    this.signal = { aborted: false, addEventListener () {}, removeEventListener () {}, dispatchEvent () {} };
  };
  globalThis.AbortController.prototype.abort = function () { this.signal.aborted = true; };

  function __makeFetchResponse (raw, url) {
    let consumed = false;
    const headers = new globalThis.Headers(raw && raw.headers || {});
    const bodyText = (raw && raw.body) || '';
    const status   = raw ? raw.status : 0;
    const resp = {
      url,
      status,
      statusText: '',
      ok: status >= 200 && status < 300,
      redirected: false,
      type: 'basic',
      headers,
      bodyUsed: false,
      _raw: raw,
      text () {
        if (consumed) return Promise.reject(new TypeError('Body already consumed'));
        consumed = true; this.bodyUsed = true;
        return Promise.resolve(bodyText);
      },
      json () {
        if (consumed) return Promise.reject(new TypeError('Body already consumed'));
        consumed = true; this.bodyUsed = true;
        try { return Promise.resolve(JSON.parse(bodyText || 'null')); }
        catch (e) { return Promise.reject(e); }
      },
      blob () {
        if (consumed) return Promise.reject(new TypeError('Body already consumed'));
        consumed = true; this.bodyUsed = true;
        return Promise.resolve(bodyText);
      },
      arrayBuffer () {
        if (consumed) return Promise.reject(new TypeError('Body already consumed'));
        consumed = true; this.bodyUsed = true;
        const buf = new ArrayBuffer(bodyText.length);
        const view = new Uint8Array(buf);
        for (let i = 0; i < bodyText.length; i++) view[i] = bodyText.charCodeAt(i) & 0xff;
        return Promise.resolve(buf);
      },
      formData () {
        const fd = new globalThis.FormData();
        return Promise.resolve(fd);
      },
      clone () { return __makeFetchResponse(raw, url); }
    };
    return resp;
  }

  globalThis.fetch = function fetch (input, init) {
    init = init || {};
    let url, method = 'GET', body = null, headers = {};
    if (typeof input === 'string') {
      url = input;
    } else if (input && input.url) {
      url = input.url;
      if (input.method) method = input.method;
      if (input.body != null) body = input.body;
      if (input.headers) headers = input.headers;
    } else {
      url = String(input);
    }
    if (init.method)        method = init.method;
    if (init.body != null)  body   = init.body;
    if (init.headers) {
      if (init.headers instanceof globalThis.Headers) {
        init.headers.forEach((v, k) => { headers[k] = v; });
      } else if (typeof init.headers === 'object') {
        Object.assign(headers, init.headers);
      }
    }
    let bodyStr = '';
    if (body != null) {
      if (typeof body === 'string') {
        bodyStr = body;
      } else if (body instanceof globalThis.FormData) {
        const parts = [];
        body.forEach((v, k) => parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(v))));
        bodyStr = parts.join('&');
        if (!('Content-Type' in headers) && !('content-type' in headers)) {
          headers['Content-Type'] = 'application/x-www-form-urlencoded';
        }
      } else if (body instanceof globalThis.URLSearchParams) {
        bodyStr = body.toString();
        if (!('Content-Type' in headers) && !('content-type' in headers)) {
          headers['Content-Type'] = 'application/x-www-form-urlencoded';
        }
      } else if (body && typeof body === 'object' && typeof body.toString === 'function') {
        bodyStr = String(body);
      } else {
        bodyStr = String(body);
      }
    }
    return new Promise(function (resolve, reject) {
      try {
        const resp = __rackFetch(method.toUpperCase(), url, bodyStr, headers, 'follow');
        if (!resp) { reject(new TypeError('Network request failed: ' + url)); return; }
        resolve(__makeFetchResponse(resp, url));
      } catch (e) { reject(e); }
    });
  };

  globalThis.history = {
    length: 1,
    state:  null,
    pushState(state, _title, url) { this.state = state; if (url) __setCurrentUrl(String(url)); },
    replaceState(state, _title, url) { this.state = state; if (url) __setCurrentUrl(String(url)); },
    back()    { __locationReload(); },
    forward() { __locationReload(); },
    go()      { __locationReload(); }
  };

  // `getComputedStyle(el)` — minimal cascade-aware proxy. For the
  // properties we actually have answers for (`display`, `visibility`),
  // return the resolved value from the inline-or-cascade pipeline.
  // For every other property fall back to whatever the inline style
  // proxy reports. jQuery 3.x's `isHiddenWithinTree` reads
  // `jQuery.css(elem, 'display')` which lands here; without the
  // resolved 'none' answer for a class-hidden div, `$.fn.toggle()`
  // mis-direction-detects and ends up hiding an already-hidden div.
  // Tag → default `display` lookup. jQuery 3.x's `defaultDisplay`
  // probes this synthetically by mounting an element and reading its
  // computed display; without a default our `__computedDisplayFor`
  // returned '' for a "shown" element, jQuery resolved that as
  // hidden again, and `.show()` left a misleading empty inline
  // display on the element.
  const __DEFAULT_DISPLAY = {
    a: 'inline', abbr: 'inline', b: 'inline', bdi: 'inline', bdo: 'inline',
    br: 'inline', cite: 'inline', code: 'inline', data: 'inline',
    dfn: 'inline', em: 'inline', i: 'inline', kbd: 'inline', mark: 'inline',
    q: 'inline', rp: 'inline', rt: 'inline', ruby: 'inline', s: 'inline',
    samp: 'inline', small: 'inline', span: 'inline', strong: 'inline',
    sub: 'inline', sup: 'inline', time: 'inline', u: 'inline', var: 'inline',
    wbr: 'inline', label: 'inline', input: 'inline-block', img: 'inline',
    button: 'inline-block', select: 'inline-block', textarea: 'inline-block',
    table: 'table', thead: 'table-header-group', tbody: 'table-row-group',
    tfoot: 'table-footer-group', tr: 'table-row', th: 'table-cell', td: 'table-cell',
    li: 'list-item', summary: 'list-item',
    template: 'none', script: 'none', style: 'none', noscript: 'none',
    head: 'none', title: 'none', meta: 'none', link: 'none',
    option: 'block', optgroup: 'block'
  };
  function __computedDisplayFor (el) {
    const inlineStyle = el._attrs.style;
    if (inlineStyle) {
      const m = /(^|;|\s)display\s*:\s*([^;]+)/i.exec(inlineStyle);
      if (m) return m[2].trim();
    }
    // Cascade-derived hidden? `matchesAnyHideRule` returns true when
    // the winning display rule is 'none' OR visibility rule is
    // 'hidden'. We approximate by reading it for 'display:none' only.
    if (el._attrs.hidden != null) return 'none';
    if (matchesAnyHideRule(el)) return 'none';
    // Default-display table: jQuery uses this resolved value to
    // restore visibility on a `.show()`-after-class-hide.
    return __DEFAULT_DISPLAY[el._tag] || 'block';
  }
  function __computedVisibilityFor (el) {
    const inlineStyle = el._attrs.style;
    if (inlineStyle) {
      const m = /(^|;|\s)visibility\s*:\s*([^;]+)/i.exec(inlineStyle);
      if (m) return m[2].trim();
    }
    return '';
  }
  // jQuery 3.x calls `getComputedStyle(elem).display` on every
  // `.css()` / `:visible` query — i.e., the hot path. Cache the
  // proxy per element so we're not minting one (+ closure + inner
  // `getPropertyValue` closure) per call. The closure captures `el`
  // by reference, so any subsequent `_attrs.style` mutation is
  // reflected without invalidating the cache.
  function __makeComputedStyleProxy (el) {
    return new Proxy(el.style, {
      get (target, key) {
        if (key === 'display')    return __computedDisplayFor(el);
        if (key === 'visibility') return __computedVisibilityFor(el);
        if (key === 'getPropertyValue') {
          return function (name) {
            const n = String(name).toLowerCase();
            if (n === 'display')    return __computedDisplayFor(el);
            if (n === 'visibility') return __computedVisibilityFor(el);
            return target.getPropertyValue ? target.getPropertyValue(name) : (target[n] || '');
          };
        }
        return target[key];
      }
    });
  }
  globalThis.getComputedStyle = function (el) {
    if (!el || el.nodeType !== NODE_ELEMENT) return makeStyleProxy({ _attrs: {} });
    return el._computedStyleProxy || (el._computedStyleProxy = __makeComputedStyleProxy(el));
  };

  // Read N computed-style properties for `handle` in one host fn call.
  // Capybara's `assert_matches_style` / `Node#style` reads several
  // properties per matcher invocation; batching avoids paying the V8
  // round-trip per property.
  globalThis.__csimComputedStyle = function (handle, names) {
    const el = __handles.get(handle);
    if (!el || el.nodeType !== NODE_ELEMENT) return {};
    const proxy = getComputedStyle(el);
    const out = {};
    for (const n of names) out[n] = String(proxy[n] || '');
    return out;
  };

  // Handle registry — Ruby keeps integer ids, looks up Element back
  // via `__csimGet*(handle)` accessors. Wired in `parseDocument`
  // and pushed during create / append paths once those exist.
  const __handles = new Map();
  // Document + its html/head/body skeleton need to be in `__handles`
  // so wgxpath / find_xpath / `__csimVisible` lookups can resolve
  // skeleton nodes by id. We register the live document here at
  // bridge init; per-visit appendChild calls add the grafted body
  // descendants via `registerSubtree` automatically.
  registerNode(globalThis.document);
  function registerNode(n) {
    __handles.set(n._id, n);
    if (n._children) for (const c of n._children) registerNode(c);
  }
  function lookup(h) { return __handles.get(h) || null; }
  // Ruby-callable hover dispatch. Updates `document._hoverElement` so
  // `:hover` cascade matches resolve against this node, then fires
  // mouseover + mouseenter — both side effects in one host call so
  // Ruby doesn't need an interleaved eval that re-enters JS twice.
  globalThis.__csimSetHover = function (h) {
    const n = lookup(h);
    if (!n) return false;
    globalThis.document._hoverElement = n;
    try { dispatchEvent(n, new MouseEvent('mouseover',  { bubbles: true,  cancelable: true })); } catch (_) {}
    try { dispatchEvent(n, new MouseEvent('mouseenter', { bubbles: false, cancelable: false })); } catch (_) {}
    return true;
  };
  // Drain the JS-side pending-submit slot for the Ruby side. Returns
  // `{formHandle, submitterHandle}` shape so callers don't have to
  // know about the internal `{form, submitter}` Node refs. Used by
  // `Browser#consume_pending_form_submit` after each user action
  // that might have triggered `<select onchange="$('#f').submit()">`.
  function __takePendingFormSubmit () {
    const p = globalThis.__csimPendingFormSubmit;
    if (!p) return null;
    globalThis.__csimPendingFormSubmit = null;
    return {
      formHandle:      p.form && p.form._id,
      submitterHandle: p.submitter && p.submitter._id
    };
  }
  globalThis.__csimTakePendingFormSubmit = __takePendingFormSubmit;
  // Toggle the ESM-script-execution flag. Ruby-side `apply_esm_flag`
  // calls this after each per-visit Context rebuild so the snapshot's
  // (uninitialised) state gets the current setting without paying a
  // `Context#eval` string compile per visit.
  globalThis.__csimSetEsmEnabled = function (v) { globalThis.__csim_esm_enabled = !!v; };
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
    // Each Capybara visit lands here on a freshly-checked-out Context
    // from the snapshot pool. The Context is either:
    //   - "base snapshot" — just bridge + wgxpath, no app bundles run.
    //     `__externalScriptsRun` empty, document has no body. Library
    //     scripts in the page's `<head>` get evaluated here for the
    //     first time.
    //   - "app-warm snapshot" — bridge + wgxpath + app library bundles
    //     pre-evaluated, with their `$(document).on(...)` delegates
    //     attached to `document` and `__externalScriptsRun` already
    //     containing the library URLs. `readyState` is still 'loading'
    //     because the warmup epilogue parks DOMContentLoaded.
    // In the app-warm case the library delegates must keep pointing at
    // the SAME `document` instance the snapshot baked them against, so
    // we reuse `globalThis.document` here and only swap in fresh
    // children. In the base case we just append onto the empty doc.
    __initialScriptsDone = false;
    __hideRules = [];
    __hideRuleIdx = null;
    // Hover / pending-submit slots are per-visit transient state —
    // clear them so a stale `_hoverElement` from the previous page
    // can't keep matching `:hover` cascade rules against detached
    // nodes, and a never-consumed `__csimPendingFormSubmit` doesn't
    // pin the old form/submitter pair alive across the rebuild.
    globalThis.document._hoverElement = null;
    globalThis.__csimPendingFormSubmit = null;
    const freshDoc = parseDocument(String(html == null ? '' : html));
    const d = globalThis.document;
    // Preserve document / documentElement / head / body identity across
    // per-visit content swaps. Library IIFEs (jQuery 3.x in particular)
    // capture `document.documentElement` at evaluation time and reuse
    // it for `createElement` / `appendChild` probes; replacing the
    // documentElement strands those references on a detached node.
    // So instead: walk the parsed tree's <head> and <body> children
    // and graft them onto the live skeleton.
    const freshHtml = freshDoc.documentElement;
    const liveHtml  = d.documentElement;
    if (freshHtml && liveHtml) {
      const freshHead = freshHtml._children.find(c => c._tag === 'head');
      const freshBody = freshHtml._children.find(c => c._tag === 'body');
      const liveHead  = liveHtml._children.find(c => c._tag === 'head');
      const liveBody  = liveHtml._children.find(c => c._tag === 'body');
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
      // Copy attributes from the parsed body / head / html onto the
      // live skeleton elements. Redmine scopes its
      // `display: none` rule for unused fieldsets on
      // `body.controller-X.action-Y`; without the body class copy the
      // cascade selector misses and the fieldset stays visible.
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
    d.readyState = 'complete';
    // Cascade-derived hide rules need to land *before* scripts run —
    // a script that tests visibility (`offsetWidth`-style probes) or
    // queries Capybara-visible elements would otherwise see the
    // pre-cascade state.
    __hideRules = collectHideRules(globalThis.document);
    __hideRuleIdx = null; // rebuilt lazily on first lookup
    runInlineScripts(globalThis.document);
    // Flip the dynamic-script gate on: post-load <script> appends
    // (Rails-UJS dataType:'script' eval into head, jQuery .html() of
    // a fragment containing <script>) will now run via the
    // fireCEConnect → maybeRunScript path.
    __initialScriptsDone = true;
    return globalThis.document._id;
  };

  // External script URLs that have been evaluated in this Context.
  // Persists across page loads. Once an app-wide bundle (jQuery,
  // application-legacy.js, rails-ujs, etc.) has run its IIFE — which
  // typically attaches listeners to `document` via `$(document).on(...)`
  // — re-evaluating it on the next visit would attach the *same*
  // listeners again, duplicating delegated handlers. Real browsers
  // don't re-run cached scripts on bf-cache / SPA navigation, and we
  // keep `document` stable across visits, so the resulting semantics
  // match.
  // url → body. Doubles as the "already evaluated" set (.has() check
  // semantics) and the registry the Ruby side reads to build the
  // app-warm snapshot. Map (not Set) so we can hand back the bodies
  // verbatim instead of re-fetching them.
  const __externalScriptsRun = new Map();
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
        // De-dupe across page loads: each app-wide bundle runs once
        // per Context. See `__externalScriptsRun` comment above.
        if (__externalScriptsRun.has(s._attrs.src)) continue;
        // Synchronous fetch via Ruby Rack callback. mini_racer's attach
        // is blocking, so this preserves the classic-script "block the
        // parser until loaded" semantics without an event loop.
        const resp = __rackFetch('GET', s._attrs.src, '', null, 'follow');
        if (!resp || resp.status >= 400) continue;
        body = resp.body || '';
        __externalScriptsRun.set(s._attrs.src, body);
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
  // `display:none` / `visibility:hidden`. Cascade-derived rules
  // (display / visibility from <style> + <link rel=stylesheet>) are
  // resolved in `matchesAnyHideRule` with proper specificity + @media
  // evaluation — see the "Display / visibility cascade" block below.
  const INVISIBLE_TAGS = new Set(['head','script','style','template','noscript','title']);
  const DISPLAY_NONE_RE       = /(^|;|\s)display\s*:\s*none\b/i;
  const VISIBILITY_HIDDEN_RE  = /(^|;|\s)visibility\s*:\s*hidden\b/i;
  // Inline `display` / `visibility` declarations that AREN'T `none` /
  // `hidden` — anything else (block, inline, inline-block, …) wins
  // over a class-derived `display: none` (per spec, inline style has
  // higher specificity than ordinary author rules). jQuery's
  // `.show()` over a `.hidden`-classed element ends up writing
  // `style="display: block"`; without this branch the element stayed
  // invisible because matchesAnyHideRule kept asserting hidden.
  const DISPLAY_OTHER_RE      = /(^|;|\s)display\s*:\s*(?!none\b)[^;]+/i;
  const VISIBILITY_OTHER_RE   = /(^|;|\s)visibility\s*:\s*(?!hidden\b)[^;]+/i;
  function selfHidden(el) {
    if (el._attrs.hidden != null) return true;
    const style = el._attrs.style;
    if (style && (DISPLAY_NONE_RE.test(style) || VISIBILITY_HIDDEN_RE.test(style))) return true;
    // Inline display:<other> overrides any class-derived display:none.
    if (style && DISPLAY_OTHER_RE.test(style)) return false;
    return matchesAnyHideRule(el);
  }

  // Visibility predicate exposed to the Element class for layout-shaped
  // getters (offsetWidth, getBoundingClientRect, …). Mirrors the
  // ancestor walk in `__csimVisible` but takes a node directly. We
  // don't model real layout, so the answer is "true unless something
  // says hidden": INVISIBLE_TAGS (head/script/style/template/…),
  // `<input type=hidden>`, the `hidden` attribute, inline `display:none`
  // / `visibility:hidden`, or a cascade rule the resolver agrees with.
  function __isVisibleNode(el) {
    if (!el || el.nodeType !== NODE_ELEMENT) return false;
    if (INVISIBLE_TAGS.has(el._tag)) return false;
    if (el._tag === 'input' && (el._attrs.type || '').toLowerCase() === 'hidden') return false;
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

  // ── Display / visibility cascade ────────────────────────────────
  //
  // Scope: just `display` and `visibility`. We don't model any other
  // CSS property — selfHidden is the only consumer, so the resolver
  // can throw away everything else at parse time.
  //
  // Pipeline:
  //   1. parseCssTree(text)         — tokenise into nested {at-rule|rule}
  //   2. flattenRules(tree, ctx)    — eval @media against viewport,
  //                                   substitute & for parent selector,
  //                                   drop @keyframes / @font-face / etc.
  //   3. extractHideRules(text)     — flatten → one entry per (selector,
  //                                   display, visibility, !important).
  //   4. matchesAnyHideRule(el)     — for each matching rule, pick the
  //                                   declaration with highest priority
  //                                   (important > !important; among
  //                                   equals, higher specificity wins;
  //                                   among equals, later source order
  //                                   wins). Element is hidden iff the
  //                                   winning `display` is `none` or
  //                                   `visibility` is `hidden`.
  //
  // We don't compute inheritance — `visibility` does inherit per spec
  // but selfHidden walks the ancestor chain anyway, so the inheritance
  // falls out naturally. `display` doesn't inherit.

  let __hideRules = [];
  let __ruleSerial = 0;
  const VIEWPORT_DEFAULT = { width: 1024, height: 768 };
  function currentViewport() {
    return {
      width:  Number(globalThis.innerWidth)  || VIEWPORT_DEFAULT.width,
      height: Number(globalThis.innerHeight) || VIEWPORT_DEFAULT.height
    };
  }

  function stripCssComments(s) { return s.replace(/\/\*[\s\S]*?\*\//g, ''); }

  // Parse CSS text into a tree. Returns an array of nodes:
  //   { type: 'rule', selector, decls: [{prop, value, important}], children: [...] }
  //   { type: 'at-rule', name, prelude, children: [...] | null, decls: [...] }
  //
  // CSS Nesting (Level 4) is supported: a rule can contain both
  // declarations and child rules. The flattener composes child rule
  // selectors against the parent's.
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
      if (inBlock && s[i] === '}') { i++; return { nodes, next: i }; }
      if (s[i] === '@') {
        const at = parseAtRule(s, i);
        nodes.push(at.node);
        i = at.next;
        continue;
      }
      // Look ahead to decide if this is a declaration or a qualified
      // rule. Track top-level `{`/`;`/`}` (i.e. depth == 0 for [], ()).
      const probe = scanToBreaker(s, i);
      if (probe.kind === 'lbrace') {
        const selector = s.slice(i, probe.at).trim();
        const body = parseDeclsAndNested(s, probe.at + 1);
        nodes.push({ type: 'rule', selector, decls: body.decls, children: body.children });
        i = body.next;
        continue;
      }
      // Stray declaration at top level (or no terminator) — skip past.
      i = probe.at + (probe.kind === 'semi' ? 1 : 0);
      if (i <= start) i = s.length;
    }
    return { nodes, next: i };
  }

  function scanToBreaker(s, i) {
    let depth = 0;
    while (i < s.length) {
      const c = s[i];
      if (c === '"' || c === "'") {
        const q = c; i++;
        while (i < s.length && s[i] !== q) { if (s[i] === '\\') i++; i++; }
        i++; continue;
      }
      if (c === '(' || c === '[') depth++;
      else if (c === ')' || c === ']') depth--;
      else if (depth === 0 && (c === '{' || c === ';' || c === '}')) {
        return { kind: c === '{' ? 'lbrace' : c === ';' ? 'semi' : 'rbrace', at: i };
      }
      i++;
    }
    return { kind: 'eof', at: i };
  }

  function parseAtRule(s, i) {
    i++; // skip @
    const start = i;
    while (i < s.length && /[a-zA-Z-]/.test(s[i])) i++;
    const name = s.slice(start, i).toLowerCase();
    const preStart = i;
    while (i < s.length && /\s/.test(s[i])) i++;
    // prelude until ; or {
    const pStart = i;
    let depth = 0;
    while (i < s.length) {
      const c = s[i];
      if (c === '"' || c === "'") {
        const q = c; i++;
        while (i < s.length && s[i] !== q) { if (s[i] === '\\') i++; i++; }
        i++; continue;
      }
      if (c === '(' || c === '[') depth++;
      else if (c === ')' || c === ']') depth--;
      else if (depth === 0 && (c === ';' || c === '{')) break;
      i++;
    }
    const prelude = s.slice(pStart, i).trim();
    if (i >= s.length || s[i] === ';') {
      return { node: { type: 'at-rule', name, prelude, children: null }, next: i + 1 };
    }
    // s[i] === '{'
    i++;
    // For @keyframes / @font-face / @page / etc. we just want to skip
    // the body without descending. Everything else can carry nested
    // rules + declarations.
    if (name === 'keyframes' || name === 'font-face' || name === 'page' ||
        name === 'counter-style' || name === 'property' || name === 'font-feature-values') {
      const skipped = skipBalancedBlock(s, i);
      return { node: { type: 'at-rule', name, prelude, children: null }, next: skipped };
    }
    const body = parseDeclsAndNested(s, i);
    return {
      node: { type: 'at-rule', name, prelude, children: body.children, decls: body.decls },
      next: body.next
    };
  }

  function skipBalancedBlock(s, i) {
    let depth = 1;
    while (i < s.length && depth > 0) {
      const c = s[i];
      if (c === '"' || c === "'") {
        const q = c; i++;
        while (i < s.length && s[i] !== q) { if (s[i] === '\\') i++; i++; }
        i++; continue;
      }
      if (c === '{') depth++;
      else if (c === '}') depth--;
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
      if (s[i] === '}') return { decls, children, next: i + 1 };
      if (s[i] === '@') {
        const at = parseAtRule(s, i);
        children.push(at.node);
        i = at.next;
        continue;
      }
      const probe = scanToBreaker(s, i);
      if (probe.kind === 'lbrace') {
        // nested rule
        const selector = s.slice(i, probe.at).trim();
        const body = parseDeclsAndNested(s, probe.at + 1);
        children.push({ type: 'rule', selector, decls: body.decls, children: body.children });
        i = body.next;
        continue;
      }
      if (probe.kind === 'semi' || probe.kind === 'rbrace') {
        const declText = s.slice(i, probe.at).trim();
        if (declText) {
          const colonIdx = declText.indexOf(':');
          if (colonIdx > 0) {
            const prop = declText.slice(0, colonIdx).trim().toLowerCase();
            let value = declText.slice(colonIdx + 1).trim();
            let important = false;
            if (/!important\s*$/i.test(value)) {
              important = true;
              value = value.replace(/!important\s*$/i, '').trim();
            }
            // Only retain display / visibility; the rest is ignored to
            // keep the resolver's matching loop short.
            if (prop === 'display' || prop === 'visibility') {
              decls.push({ prop, value: value.toLowerCase(), important });
            }
          }
        }
        if (probe.kind === 'rbrace') return { decls, children, next: probe.at + 1 };
        i = probe.at + 1;
        continue;
      }
      // EOF / no terminator
      break;
    }
    return { decls, children, next: i };
  }

  // ── @media evaluator ────────────────────────────────────────────
  //
  // Common-subset only: media types (`all` / `screen` / `print`),
  // `and` / `not` / `only` joins (`,` is media-query-list), and the
  // following feature expressions:
  //   (min-width: N), (max-width: N), (width: N)
  //   (min-height: N), (max-height: N), (height: N)
  //   (orientation: landscape|portrait)
  //   (hover: hover|none), (pointer: fine|coarse|none)
  //   (prefers-color-scheme: light|dark)
  //   (prefers-reduced-motion: reduce|no-preference)
  //   (min-resolution: 1dppx etc.)
  // Anything else falls back to *false* (i.e. the block doesn't apply).
  // Conservative bias: a desktop viewport at 1× / no-touch / no-dark.
  function mediaMatches(text, vp) {
    if (!text) return true; // empty media list = matches all
    for (const q of splitTopLevel(text, ',')) {
      if (singleMediaMatches(q.trim(), vp)) return true;
    }
    return false;
  }

  function singleMediaMatches(q, vp) {
    if (!q) return true;
    let negate = false;
    const lower = q.toLowerCase();
    if (/^only\s+/.test(lower)) q = q.replace(/^\s*only\s+/i, '');
    if (/^not\s+/.test(lower))  { negate = true; q = q.replace(/^\s*not\s+/i, ''); }
    const parts = splitMediaAnd(q);
    let result = true;
    for (const p of parts) {
      if (!matchMediaPart(p.trim(), vp)) { result = false; break; }
    }
    return negate ? !result : result;
  }

  function splitMediaAnd(s) {
    // Splits on top-level " and " (case-insensitive), respecting
    // parentheses.
    const out = [];
    let depth = 0, start = 0;
    const lower = s.toLowerCase();
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      else if (depth === 0 && lower.startsWith(' and ', i)) {
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
    if (p[0] !== '(') {
      // media type
      const t = p.toLowerCase().trim();
      if (t === 'all' || t === '' || t === 'screen') return true;
      if (t === 'print' || t === 'speech') return false;
      return false; // unknown media type
    }
    // feature expression: (name) | (name: value) | (range)
    if (p[p.length - 1] !== ')') return false;
    const inside = p.slice(1, -1).trim();
    const m = /^([a-zA-Z-]+)\s*:\s*(.*)$/.exec(inside);
    if (!m) {
      // Bare feature like (hover) — treat as truthy if we'd answer
      // yes to its `(name: <any-value>)` form. Few tests rely on this.
      const name = inside.toLowerCase().trim();
      if (name === 'hover' || name === 'any-hover') return true;
      if (name === 'pointer' || name === 'any-pointer') return true;
      return false;
    }
    const feat = m[1].toLowerCase();
    const val  = m[2].trim().toLowerCase();
    if (feat === 'min-width')  return vp.width  >= parsePx(val);
    if (feat === 'max-width')  return vp.width  <= parsePx(val);
    if (feat === 'width')      return vp.width  === parsePx(val);
    if (feat === 'min-height') return vp.height >= parsePx(val);
    if (feat === 'max-height') return vp.height <= parsePx(val);
    if (feat === 'height')     return vp.height === parsePx(val);
    if (feat === 'orientation') return val === (vp.width >= vp.height ? 'landscape' : 'portrait');
    if (feat === 'hover' || feat === 'any-hover')     return val === 'hover';
    if (feat === 'pointer' || feat === 'any-pointer') return val === 'fine';
    if (feat === 'prefers-color-scheme')              return val === 'light';
    if (feat === 'prefers-reduced-motion')            return val === 'no-preference';
    if (feat === 'min-resolution' || feat === 'max-resolution' || feat === 'resolution') {
      // 1dppx baseline. min-resolution matches when test ≤ 1; etc.
      const t = parseDppx(val);
      if (feat === 'min-resolution') return 1 >= t;
      if (feat === 'max-resolution') return 1 <= t;
      return 1 === t;
    }
    return false;
  }

  function parsePx(s) {
    const n = parseFloat(s);
    if (Number.isNaN(n)) return 0;
    if (/em$/.test(s)) return n * 16; // approximate
    if (/rem$/.test(s)) return n * 16;
    return n;
  }
  function parseDppx(s) {
    const n = parseFloat(s);
    if (Number.isNaN(n)) return 1;
    if (/dppx$/.test(s)) return n;
    if (/dpi$/.test(s))  return n / 96;
    if (/dpcm$/.test(s)) return n / 37.795;
    return n;
  }

  // Flatten the parsed CSS tree to a list of {selectorText, decls,
  // sourceIdx, important}. Resolves @media (drops non-matching),
  // @supports (always-true, descend), CSS nesting via `&` substitution.
  function flattenCssTree(tree, vp) {
    const out = [];
    const stack = []; // parent selector groups for nesting context
    function walk(nodes) {
      for (const node of nodes) {
        if (node.type === 'at-rule') {
          if (node.name === 'media') {
            if (mediaMatches(node.prelude, vp)) {
              if (node.decls && node.decls.length && stack.length) {
                // Decls inside @media inside a rule attach to the
                // enclosing rule's selector.
                out.push({ selectorText: stack[stack.length - 1], decls: node.decls });
              }
              walk(node.children || []);
            }
            continue;
          }
          if (node.name === 'supports' || node.name === 'container') {
            // Always-on fallback: descend.
            if (node.decls && node.decls.length && stack.length) {
              out.push({ selectorText: stack[stack.length - 1], decls: node.decls });
            }
            walk(node.children || []);
            continue;
          }
          // @keyframes / @font-face / @import / etc. — skip.
          continue;
        }
        // node.type === 'rule'
        const parentSel = stack.length ? stack[stack.length - 1] : null;
        const resolved = composeNestedSelector(node.selector, parentSel);
        if (node.decls && node.decls.length) {
          out.push({ selectorText: resolved, decls: node.decls });
        }
        if (node.children && node.children.length) {
          stack.push(resolved);
          walk(node.children);
          stack.pop();
        }
      }
    }
    walk(tree);
    return out;
  }

  // CSS nesting: `&` in a nested selector substitutes the parent
  // selector list. Without `&`, the nested selector is implicitly
  // `& <descendant> child`. Multi-selector lists distribute.
  function composeNestedSelector(child, parent) {
    if (!parent) return child;
    const childParts = splitTopLevel(child, ',').map(p => p.trim()).filter(Boolean);
    const parentParts = splitTopLevel(parent, ',').map(p => p.trim()).filter(Boolean);
    const out = [];
    for (const cp of childParts) {
      const hasAmpersand = /&/.test(cp);
      for (const pp of parentParts) {
        if (hasAmpersand) {
          // Parentheses around pp so that `& .foo` keeps `pp` as a
          // single compound chunk in the descendant join. Real CSS uses
          // `:is(pp)` for this; the in-house matcher supports `:is`.
          out.push(cp.replace(/&/g, ':is(' + pp + ')'));
        } else {
          out.push(pp + ' ' + cp);
        }
      }
    }
    return out.join(', ');
  }

  function extractHideRules(cssText, vp) {
    const out = [];
    let tree;
    try { tree = parseCssTree(cssText); }
    catch (_) { return out; }
    const flat = flattenCssTree(tree, vp);
    for (const r of flat) {
      const selector = r.selectorText;
      const decls = r.decls;
      if (!selector || !decls.length) continue;
      // Pick out only display + visibility — done at parse time, so
      // the loop below already sees pre-filtered decls.
      let display = null, displayImp = false;
      let visibility = null, visibilityImp = false;
      for (const d of decls) {
        if (d.prop === 'display')    { display = d.value; displayImp = d.important; }
        if (d.prop === 'visibility') { visibility = d.value; visibilityImp = d.important; }
      }
      if (display == null && visibility == null) continue;
      // Split the selector group so each match-test is one chain — the
      // resolver iterates flat and ties break on (specificity, order).
      for (const sel of splitTopLevel(selector, ',')) {
        const trimmed = sel.trim();
        if (!trimmed) continue;
        let group;
        try { group = parseSelector(trimmed); } catch (_) { continue; }
        if (!group || !group.length) continue;
        // group has exactly one complex selector here (we split the
        // comma list above). Compute its specificity.
        const seq = group[0];
        const spec = specificity(seq);
        out.push({
          group, spec, source: __ruleSerial++,
          display, displayImp,
          visibility, visibilityImp
        });
      }
    }
    return out;
  }

  function collectHideRules(doc) {
    if (!doc || !doc.documentElement) return [];
    __ruleSerial = 0;
    const vp = currentViewport();
    const rules = [];
    const styles = doc.documentElement.querySelectorAll('style');
    for (const s of styles) {
      const txt = scriptText(s);
      if (txt) rules.push(...extractHideRules(txt, vp));
    }
    const links = doc.documentElement.querySelectorAll('link');
    for (const l of links) {
      const rel = (l._attrs.rel || '').toLowerCase();
      if (!rel.split(/\s+/).includes('stylesheet')) continue;
      const href = l._attrs.href;
      if (!href) continue;
      try {
        const resp = __rackFetch('GET', href, '', null, 'follow');
        if (resp && resp.status < 400 && resp.body) {
          rules.push(...extractHideRules(resp.body, vp));
        }
      } catch (_) {}
    }
    return rules;
  }

  // Hide-rule index: bucket each rule by the terminal compound's
  // most-discriminating signal (id > class > tag > universal). The
  // resolver then only walks buckets the element can plausibly match,
  // instead of scanning every rule on the page.
  //
  // Cost model: a Redmine-scale stylesheet has ~4000 rules, of which
  // the vast majority pin a class or tag at the terminal. With the
  // index, a visibility check for a `<div class="foo">` element
  // typically inspects ~5–20 rules instead of all 4000. Cascade
  // resolution (specificity + source order + !important) works the
  // same — each rule already carries its `spec` / `source` /
  // `displayImp` / `visibilityImp` so per-bucket order doesn't matter.
  let __hideRuleIdx = null;
  function buildHideRuleIndex(rules) {
    const idx = {
      byTag:     new Map(),
      byId:      new Map(),
      byClass:   new Map(),
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

  // Cascade resolution for {display, visibility} on `el`. Priority
  // order (highest wins):
  //   1. !important declarations
  //   2. specificity (a, b, c) — higher wins
  //   3. source order — later wins
  function matchesAnyHideRule(el) {
    if (__hideRules.length === 0) return false;
    if (!__hideRuleIdx) __hideRuleIdx = buildHideRuleIndex(__hideRules);
    const idx = __hideRuleIdx;
    let bestD = null, bestV = null;

    function check(bucket) {
      for (const r of bucket) {
        let m;
        try { m = matchOne(el, r.group); } catch (_) { continue; }
        if (!m) continue;
        if (r.display != null && winsCascade(bestD, r, true)) {
          bestD = { value: r.display, important: r.displayImp, spec: r.spec, source: r.source };
        }
        if (r.visibility != null && winsCascade(bestV, r, false)) {
          bestV = { value: r.visibility, important: r.visibilityImp, spec: r.spec, source: r.source };
        }
      }
    }

    const tagBucket = idx.byTag.get(el._tag);
    if (tagBucket) check(tagBucket);
    const idAttr = el._attrs.id;
    if (idAttr) {
      const idBucket = idx.byId.get(idAttr);
      if (idBucket) check(idBucket);
    }
    const clsAttr = el._attrs['class'];
    if (clsAttr) {
      for (const c of clsAttr.split(/\s+/)) {
        if (!c) continue;
        const cb = idx.byClass.get(c);
        if (cb) check(cb);
      }
    }
    if (idx.universal.length) check(idx.universal);

    if (bestD && bestD.value === 'none') return true;
    if (bestV && bestV.value === 'hidden') return true;
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
    if (!n) return '';
    // If any ancestor is hidden, the whole subtree is invisible —
    // Capybara's `text` on a node found with `visible: false` whose
    // parent has `display: none` must return ''. collectVisibleText
    // only consults the descended-into node, so walk parents first.
    for (let cur = n._parent; cur; cur = cur._parent) {
      if (cur.nodeType === NODE_ELEMENT && (INVISIBLE_TAGS.has(cur._tag) || selfHidden(cur))) return '';
    }
    return collectVisibleText(n);
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
  // "Alive" = the node behind this handle is still attached to the
  // document tree. Handles outlive their nodes (the handle map keeps
  // a strong ref so JS-side ops on detached fragments stay coherent),
  // so "is in __handles" isn't the same as "still in the document."
  // Capybara's stale-node detection (#reload / invalid_element_errors)
  // depends on this: a node that's been removed from the DOM must
  // report as stale on the next read.
  // Spec: when no element is explicitly focused, `document.activeElement`
  // falls back to `<body>` (or `<html>` if there's no body). Capybara's
  // `Session#active_element` expects a concrete Element handle, so the
  // host-fn surface returns the body's handle when nothing has focus.
  globalThis.__csimActiveElement = function () {
    const doc = globalThis.document;
    if (!doc) return 0;
    const el = doc._activeElement || doc.body || doc.documentElement;
    return el && el._id != null ? el._id : 0;
  };

  // Tab-key focus traversal. Walk the document in tree order, pull
  // out tabbable elements (tabindex >= 0 or default-tabbable form
  // controls / anchors), then move focus to the next (or previous,
  // for shift-tab) entry relative to the current `_activeElement`.
  const __TABBABLE_TAGS = new Set(['a', 'button', 'input', 'select', 'textarea']);
  function __isTabbable (el) {
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
    if (el._tag === 'input' && (el._attrs.type || '').toLowerCase() === 'hidden') return false;
    if (el._tag === 'a' && el._attrs.href == null) return false;
    return true;
  }
  function __collectTabbables () {
    const out = [];
    function walk (node) {
      if (!node || !node._children) return;
      for (const c of node._children) {
        if (__isTabbable(c)) out.push(c);
        walk(c);
      }
    }
    if (globalThis.document) walk(globalThis.document);
    return out;
  }
  globalThis.__csimAdvanceFocus = function (reverse) {
    const list = __collectTabbables();
    if (list.length === 0) return false;
    const current = globalThis.document && globalThis.document._activeElement;
    let idx = current ? list.indexOf(current) : -1;
    idx = reverse ? (idx <= 0 ? list.length - 1 : idx - 1) : (idx + 1) % list.length;
    const next = list[idx];
    if (next && typeof next.focus === 'function') {
      try { next.focus(); } catch (_) {}
    }
    return true;
  };

  globalThis.__csimAlive = function (h) {
    const n = __handles.get(h);
    return n != null && isConnected(n);
  };

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
      // so prefer that. The "one newline" is a single line terminator
      // — `\r\n` / `\r` / `\n` — not just `\n`, so we need to strip
      // CR + LF as a pair when Redmine sends a textarea body with CRLF
      // line endings (the default for forms responding via AJAX).
      if (n._attrs.value != null) return n._attrs.value;
      return __stripOneLeadingNewline(n.textContent);
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
  globalThis.__csimClickResolve = function (h, modifiers) {
    const n = lookup(h);
    if (!n || n.nodeType !== NODE_ELEMENT) return null;
    const mods = modifiers || {};

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

    // Real clicks fire `mousedown` → `mouseup` → `click` (with
    // `pointerdown` / `pointerup` for Pointer-Event-aware listeners).
    // Libraries listen on the down-half of the pair: Tribute attaches
    // its menu-click handler to `mousedown` (so the menu select fires
    // before the textarea's `blur` chain commits), and jQuery's
    // `:active` selector + sortable plugins drag-detect off mousedown.
    // Without these dispatches, clicking a Tribute `<li>` does not
    // call `selectItemAtIndex` and the autocomplete never inserts.
    // Track the click target as the hover element so `:hover`
    // cascade matches resolve correctly afterwards (Redmine's
    // `#context-menu .folder` reveals its nested `<ul>` via
    // `#context-menu li:hover ul { display: block }`). We don't
    // dispatch a mouseover here — real browsers do, but redispatching
    // mouseover at click time recursed into hover listeners that
    // re-clicked / re-hovered (the gantt tooltip controller is the
    // canonical case). Setting the slot is enough for the CSS path.
    try { if (globalThis.document) globalThis.document._hoverElement = n; } catch (_) {}
    // Reset the form-submit intent slot before dispatch so the
    // click handler can populate it if it ends in `form.submit()`
    // (Rails-UJS data-method / data-confirm chain).
    globalThis.__csimPendingFormSubmit = null;
    const base = { bubbles: true, cancelable: true, button: 0, which: 1,
                   shiftKey: !!mods.shiftKey, ctrlKey: !!mods.ctrlKey,
                   altKey: !!mods.altKey, metaKey: !!mods.metaKey };
    dispatchEvent(n, new MouseEvent('mousedown', base));
    dispatchEvent(n, new MouseEvent('mouseup',   base));
    const click = new MouseEvent('click', base);
    dispatchEvent(n, click);
    // A click handler that ended in `form.submit()` (Rails-UJS
    // data-method link → builds synthetic form → submit) takes
    // precedence: the page intent is to submit, not navigate.
    const pendingSubmit = __takePendingFormSubmit();
    if (pendingSubmit) return { kind: 'submit', formHandle: pendingSubmit.formHandle, submitter: pendingSubmit.submitterHandle || 0 };
    if (click.defaultPrevented) return null;

    if (n._tag === 'a' && n._attrs.href != null) {
      // `<a download>` (any value) signals that the linked resource
      // should be saved rather than rendered. Real browsers honour
      // this regardless of the response's Content-Disposition, so we
      // tell Ruby to take the download path even if the server only
      // sets a Content-Type.
      if (n._attrs.download != null) {
        return { kind: 'download', url: n._attrs.href, filename: String(n._attrs.download || '') };
      }
      return { kind: 'navigate', url: n._attrs.href };
    }
    // `<label>` activation: clicking a label clicks its labeled
    // form control. Redmine's "New member" modal renders user
    // checkboxes as `<label><input type=checkbox ...>Name</label>`;
    // without this hop, `find('label', text: ...).click` runs the
    // label's click chain but the checkbox stays unchecked and the
    // POST body omits the user_ids — the form submits but adds no
    // one. Per HTML spec the labeled control is the `for` target,
    // or — if no `for` attr — the first labelable descendant.
    if (n._tag === 'label') {
      const labeled = labeledControlFor(n);
      if (labeled && labeled !== n) {
        return __csimClickResolve(labeled._id);
      }
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
  // Resolve a `<label>` element to its labeled form control per HTML
  // spec. Preference order: `for` attribute → first labelable
  // descendant (input / textarea / select / button / output / meter
  // / progress, excluding `input[type=hidden]`).
  function labeledControlFor(label) {
    const forId = label._attrs.for;
    if (forId) {
      const root = globalThis.document.documentElement;
      if (root) {
        const hit = findFirst(root, parseSelector('#' + forId));
        if (hit) return hit;
      }
    }
    const LABELABLE = new Set(['button', 'input', 'meter', 'output', 'progress', 'select', 'textarea']);
    const stack = [label];
    while (stack.length) {
      const cur = stack.shift();
      for (const c of cur._children) {
        if (c.nodeType !== NODE_ELEMENT) continue;
        if (LABELABLE.has(c._tag)) {
          if (c._tag === 'input' && (c._attrs.type || '').toLowerCase() === 'hidden') continue;
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

  // send_keys: replay a sequence of typed keystrokes against a
  // focusable control (or, for non-typeable targets, a plain
  // keydown / keyup chain at the body). Each atom from the Ruby
  // side is one of:
  //   { kind: 'text',  value: 'abc' }   — printable text
  //   { kind: 'key',   name: 'enter' }  — special key (no modifier)
  //   { kind: 'combo', parts: [...] }   — modifier(s) + final key
  //
  // We fire a real `keydown` (cancelable) for each effective key
  // press, then — if it wasn't `preventDefault`-ed — apply the
  // typed effect to the input value and fire `input`. `keyup`
  // closes each press. A single `change` event coalesces at the
  // end if the value moved (selenium parity: change fires after
  // the whole `send_keys` batch, not per character).
  const __KEY_NAME_MAP = {
    enter:      { key: 'Enter',     code: 'Enter',     keyCode: 13, char: '\n', inputType: 'insertLineBreak' },
    return:     { key: 'Enter',     code: 'Enter',     keyCode: 13, char: '\n', inputType: 'insertLineBreak' },
    tab:        { key: 'Tab',       code: 'Tab',       keyCode:  9, char: '\t', inputType: 'insertText'      },
    space:      { key: ' ',         code: 'Space',     keyCode: 32, char: ' ',  inputType: 'insertText'      },
    backspace:  { key: 'Backspace', code: 'Backspace', keyCode:  8, char: null, inputType: 'deleteContentBackward' },
    delete:     { key: 'Delete',    code: 'Delete',    keyCode: 46, char: null, inputType: 'deleteContentForward'  },
    escape:     { key: 'Escape',    code: 'Escape',    keyCode: 27, char: null, inputType: null },
    up:         { key: 'ArrowUp',    code: 'ArrowUp',    keyCode: 38, char: null, inputType: null },
    down:       { key: 'ArrowDown',  code: 'ArrowDown',  keyCode: 40, char: null, inputType: null },
    left:       { key: 'ArrowLeft',  code: 'ArrowLeft',  keyCode: 37, char: null, inputType: null },
    right:      { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39, char: null, inputType: null }
  };
  const __MODIFIER_NAMES = new Set([
    'control', 'ctrl', 'command', 'cmd', 'meta', 'shift', 'alt', 'option'
  ]);
  function __resolveKey(spec) {
    // Try the named-key table first so callers can pass 'enter' /
    // 'tab' / 'escape' interchangeably as strings or symbols — the
    // Ruby side stringifies symbols at the JSON boundary, so an
    // atom for `:enter` arrives here as the string 'enter' and
    // would otherwise fall into the printable-char branch and get
    // typed verbatim.
    const known = __KEY_NAME_MAP[String(spec).toLowerCase()];
    if (known) return Object.assign({}, known);
    // Printable: typically a single char from a text atom.
    if (typeof spec === 'string' && spec.length >= 1) {
      return { key: spec,
               code: spec.length === 1 ? 'Key' + spec.toUpperCase() : '',
               keyCode: spec.length === 1 ? spec.toUpperCase().charCodeAt(0) : 0,
               char: spec,
               inputType: 'insertText' };
    }
    return { key: String(spec), code: '', keyCode: 0, char: null, inputType: null };
  }
  function __modifierFlags(names) {
    const out = { ctrlKey: false, metaKey: false, shiftKey: false, altKey: false };
    for (const raw of names) {
      const n = String(raw).toLowerCase();
      if (n === 'control' || n === 'ctrl')                out.ctrlKey  = true;
      else if (n === 'command' || n === 'cmd' || n === 'meta') out.metaKey = true;
      else if (n === 'shift')                             out.shiftKey = true;
      else if (n === 'alt' || n === 'option')             out.altKey   = true;
    }
    return out;
  }
  function __appendValue(n, ch) {
    if (ch == null) return;
    const cur = n._attrs.value != null ? n._attrs.value : '';
    const next = cur + ch;
    const maxlen = parseInt(n._attrs.maxlength || '', 10);
    n._attrs.value = (maxlen > 0 && next.length > maxlen) ? next.slice(0, maxlen) : next;
    if (n._tag === 'textarea') {
      n._children = [Object.assign(new Text(n._attrs.value), { _parent: n })];
    }
    n._selectionStart = n._attrs.value.length;
    n._selectionEnd   = n._attrs.value.length;
  }
  globalThis.__csimSendKeys = function (h, atoms) {
    const n = lookup(h);
    if (!n || n.nodeType !== NODE_ELEMENT) return false;
    const typeable = (n._tag === 'input' || n._tag === 'textarea') &&
                     !(n._attrs.readonly != null || n._attrs.disabled != null);
    if (typeable) { try { n.focus(); } catch (_) {} }
    const startValue = typeable ? (n._attrs.value || '') : null;
    const pressKey = (info, modifiers) => {
      const initBase = Object.assign({ bubbles: true, cancelable: true }, modifiers || {});
      const init = Object.assign({}, initBase, { key: info.key, code: info.code, keyCode: info.keyCode, which: info.keyCode });
      const kd = new KeyboardEvent('keydown', init);
      dispatchEvent(n, kd);
      let blocked = kd.defaultPrevented;
      const wouldType =
        typeable && !blocked &&
        (info.char != null || info.inputType === 'deleteContentBackward' || info.inputType === 'deleteContentForward') &&
        (!modifiers || (!modifiers.ctrlKey && !modifiers.metaKey && !modifiers.altKey));
      if (wouldType && info.inputType) {
        // `beforeinput` fires before the value mutates, with the
        // semantic `inputType` set ('insertText' / 'insertLineBreak'
        // / 'deleteContentBackward' / etc.). Stimulus actions like
        // `data-action="beforeinput->list-autofill#handleBeforeInput"`
        // gate on `event.inputType` and call preventDefault to take
        // over (e.g. list-autofill replaces the default Enter with
        // a marker-prefixed newline). Honour the cancellation.
        const bi = new InputEvent('beforeinput', {
          bubbles: true, cancelable: true,
          data: info.char != null ? info.char : null,
          inputType: info.inputType
        });
        dispatchEvent(n, bi);
        if (bi.defaultPrevented) blocked = true;
      }
      if (!blocked && wouldType) {
        if (info.char != null) {
          __appendValue(n, info.char);
        } else if (info.inputType === 'deleteContentBackward') {
          // Backspace: drop the char before the caret.
          const cur = n._attrs.value != null ? n._attrs.value : '';
          const pos = n._selectionStart != null ? n._selectionStart : cur.length;
          if (pos > 0) {
            const next = cur.slice(0, pos - 1) + cur.slice(pos);
            n._attrs.value = next;
            if (n._tag === 'textarea') n._children = [Object.assign(new Text(next), { _parent: n })];
            n._selectionStart = pos - 1;
            n._selectionEnd   = pos - 1;
          }
        }
        dispatchEvent(n, new InputEvent('input', {
          bubbles: true, cancelable: true,
          data: info.char != null ? info.char : null,
          inputType: info.inputType
        }));
      }
      dispatchEvent(n, new KeyboardEvent('keyup', init));
    };
    const atomList = Array.isArray(atoms) ? atoms : [];
    for (const a of atomList) {
      if (!a || typeof a !== 'object') continue;
      if (a.kind === 'text') {
        const s = String(a.value || '');
        for (const ch of s) pressKey(__resolveKey(ch), null);
      } else if (a.kind === 'key') {
        pressKey(__resolveKey(a.name), null);
      } else if (a.kind === 'combo') {
        const parts = Array.isArray(a.parts) ? a.parts : [];
        // Modifiers are everything but the final atom; the final
        // atom is the key being pressed *while* the modifiers are
        // held. Some callers only pass modifiers (selecting all
        // text via Ctrl+A is the canonical "modifier + letter").
        let lastKeyIdx = -1;
        for (let i = parts.length - 1; i >= 0; i--) {
          if (!__MODIFIER_NAMES.has(String(parts[i]).toLowerCase())) { lastKeyIdx = i; break; }
        }
        const mods    = __modifierFlags(parts.slice(0, lastKeyIdx >= 0 ? lastKeyIdx : parts.length));
        const keyName = lastKeyIdx >= 0 ? parts[lastKeyIdx] : '';
        pressKey(__resolveKey(keyName), mods);
        // Clipboard paste: Ctrl+V / Cmd+V should fire a `paste` event
        // with the system clipboard's text content. Real browsers do
        // this as the default action of the keydown; Redmine's
        // `copy_*_to_clipboard` tests use it to round-trip the
        // value from a Stimulus `clipboard#copyText` call.
        const lowerKey = String(keyName).toLowerCase();
        if (typeable && (mods.ctrlKey || mods.metaKey) && lowerKey === 'v') {
          const pasted = __clipboardText;
          if (pasted) {
            const ev = new Event('paste', { bubbles: true, cancelable: true });
            ev.clipboardData = {
              types: ['text/plain'],
              getData (kind) {
                return kind === 'text' || kind === 'text/plain' ? pasted : '';
              },
              setData () {}
            };
            dispatchEvent(n, ev);
            if (!ev.defaultPrevented) {
              // Insert at current caret position, replacing any
              // selection range — same as a real browser paste.
              const cur = n._attrs.value != null ? n._attrs.value : '';
              const s = n._selectionStart != null ? n._selectionStart : cur.length;
              const e = n._selectionEnd   != null ? n._selectionEnd   : s;
              const next = cur.slice(0, s) + pasted + cur.slice(e);
              n._attrs.value = next;
              if (n._tag === 'textarea') {
                n._children = [Object.assign(new Text(next), { _parent: n })];
              }
              n._selectionStart = n._selectionEnd = s + pasted.length;
              dispatchEvent(n, new InputEvent('input', {
                bubbles: true, cancelable: true,
                data: pasted, inputType: 'insertFromPaste'
              }));
            }
          }
        }
      }
    }
    if (typeable && n._attrs.value !== startValue) {
      dispatchEvent(n, new Event('change', { bubbles: true, cancelable: false }));
    }
    return true;
  };

  globalThis.__csimAncestorForm = function (h) {
    const n = lookup(h);
    if (!n) return 0;
    const f = ancestorForm(n);
    return f ? f._id : 0;
  };

  // Called by the Ruby side after `attach_file` resolves a list of
  // paths to {name, size, type, lastModified} entries. The list is
  // attached to the input as a FileList-shaped array; `el.files`
  // exposes it to JS consumers (jQuery file widgets, Redmine's
  // attachments.js).
  globalThis.__csimSetFiles = function (h, fileInfos) {
    const n = lookup(h);
    if (!n || n.nodeType !== NODE_ELEMENT) return false;
    n._files = Array.isArray(fileInfos) ? fileInfos.slice() : [];
    return true;
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
    // Selenium implicitly focuses the field before typing into it
    // (`feedback_send_keys_focus` memory). Without that, delegated
    // focus handlers — Redmine's inline-autocomplete attachment lives
    // on `$(document).on('focus', '[data-auto-complete=true]', ...)`,
    // Trix's editor focus path, Stimulus actionable-on-focus
    // controllers — never wire up, and the `input` event we're about
    // to dispatch has no observer. Skip for elements that don't accept
    // focus (option/optgroup/select-with-no-focus); checkboxes /
    // radios get focused for parity with selenium's `.click()` path.
    if (tag === 'input' || tag === 'textarea' || isContenteditable(n)) {
      try { n.focus(); } catch (_) {}
    }
    const v = value == null ? '' : String(value);
    let kind = 'value';
    if (tag === 'textarea') {
      n._children = []; n._children.push(Object.assign(new Text(v), { _parent: n }));
      n._attrs.value = v;
      // Mirror real browsers: typing-style value updates leave the
      // caret at the end of the new content. Tribute / inline-
      // autocomplete read `selectionStart` to find the trigger
      // character before the cursor; without advancing the caret,
      // selectionStart stays at 0 and the trigger detection sees
      // an empty "text before cursor" slice.
      n._selectionStart = v.length;
      n._selectionEnd   = v.length;
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
        // Caret-at-end, same rationale as textarea above.
        n._selectionStart = n._attrs.value.length;
        n._selectionEnd   = n._attrs.value.length;
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
    // Selenium's `.send_keys(text)` fires keydown + (beforeinput) +
    // input + keyup per character; libraries like Tribute initialise
    // their per-keystroke state (`commandEvent = false`) inside the
    // keydown handler, so without keydown firing first the keyup
    // check `false === commandEvent` reads `false === undefined`
    // and the show-menu branch never enters. Fire one keydown / keyup
    // pair around the value-change for the whole `set('text')` (we
    // don't have a per-character chain to lean on); the keyCode is 0
    // because we don't simulate a specific character.
    if (tag === 'input' || tag === 'textarea' || isContenteditable(n)) {
      try { dispatchEvent(n, new KeyboardEvent('keydown', { bubbles: true, cancelable: true })); } catch (_) {}
    }
    // Fire `input` (cancellable, bubbles) then `change` (bubbles only).
    // For checkbox / radio real browsers fire `change` only on a real
    // user interaction, but Capybara's `set` mirrors what `selenium`
    // does — both events, so listeners see the update either way.
    dispatchEvent(n, new InputEvent('input',  { bubbles: true, cancelable: true }));
    dispatchEvent(n, new Event('change', { bubbles: true, cancelable: false }));
    if (tag === 'input' || tag === 'textarea' || isContenteditable(n)) {
      try { dispatchEvent(n, new KeyboardEvent('keyup', { bubbles: true, cancelable: true })); } catch (_) {}
    }
    // Capybara's `set("value\n")` on a text input means "type the
    // value, then press Enter". HTML's implicit form submission says:
    // when Enter is pressed in a form's sole text-like control, the
    // form submits. Detect the trailing newline, strip it from the
    // stored value, and queue a form-submit intent for Ruby to drain
    // (same channel as Rails-UJS data-method chains).
    if (tag === 'input' && typeof value === 'string' && value.endsWith('\n')) {
      const stripped = String(n._attrs.value || '').replace(/\n$/, '');
      n._attrs.value = stripped;
      const form = formForControl(n);
      if (form && __formImplicitSubmit(form, n)) {
        // Match the shape `__takePendingFormSubmit` reads: an object
        // with the raw form/submitter Element refs, not handle ids.
        globalThis.__csimPendingFormSubmit = { form, submitter: null };
      }
    }
    return true;
  };
  // HTML "implicit submission" eligibility: the form must have exactly
  // one text-shaped input control. Multiple text inputs disqualify
  // (browsers fall back to needing a submit button) — Capybara's
  // `should not submit single text input forms if ended with \n and
  // has multiple values` test pins that branch.
  function __formImplicitSubmit (form, control) {
    let count = 0;
    for (const el of form.querySelectorAll('input')) {
      const t = (el._attrs.type || 'text').toLowerCase();
      if (['text', 'email', 'password', 'tel', 'url', 'search', 'number'].includes(t)) count++;
      if (count > 1) return false;
    }
    return count === 1 && (control._attrs.type || 'text').toLowerCase() !== 'submit';
  }
  function selectOptionExclusive(select, opt) {
    const multi = select._attrs.multiple != null;
    const opts = select.querySelectorAll('option');
    if (!multi) for (const o of opts) delete o._attrs.selected;
    opt._attrs.selected = '';
  }
  // Real browsers (and selenium's `.select_by(...)`) fire `input`
  // and `change` on the parent `<select>` when the user picks a
  // different option. Redmine's `<select onchange=
  // "updateIssueFrom(...)">` relies on `change` to refire the form
  // AJAX; without these dispatches the form stays stale. We gate on
  // a "did the selected state change" check so a redundant
  // `select_option` against the already-selected option doesn't
  // re-fire AJAX on every Capybara call.
  function __fireSelectChange (sel) {
    try { dispatchEvent(sel, new InputEvent('input',  { bubbles: true, cancelable: true })); } catch (_) {}
    try { dispatchEvent(sel, new Event('change', { bubbles: true, cancelable: false })); } catch (_) {}
  }
  function __ancestorSelect (option) {
    let cur = option._parent;
    while (cur && cur._tag !== 'select') cur = cur._parent;
    return cur && cur._tag === 'select' ? cur : null;
  }
  globalThis.__csimSelectOption = function (h) {
    const n = lookup(h);
    if (!n || n._tag !== 'option') return false;
    const sel = __ancestorSelect(n);
    if (!sel) { n._attrs.selected = ''; return true; }
    const wasSelected = n._attrs.selected != null;
    selectOptionExclusive(sel, n);
    if (!wasSelected) __fireSelectChange(sel);
    return true;
  };
  globalThis.__csimUnselectOption = function (h) {
    const n = lookup(h);
    if (!n || n._tag !== 'option') return false;
    const wasSelected = n._attrs.selected != null;
    delete n._attrs.selected;
    if (wasSelected) {
      const sel = __ancestorSelect(n);
      if (sel) __fireSelectChange(sel);
    }
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
        // Strip the same single leading line terminator that
        // `__csimValue` strips, then re-normalize line endings.
        const raw = f._attrs.value != null
          ? f._attrs.value
          : __stripOneLeadingNewline(f.textContent);
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

  // ── XMLHttpRequest (sync-backed) ────────────────────────────────
  //
  // Rails-UJS / jQuery.ajax / many older libraries lean on the XHR
  // surface. We implement just enough of it to round-trip a Rack call
  // through the existing `__rackFetch` host fn. The actual fetch is
  // synchronous (mini_racer's attach() is blocking); we *defer* the
  // readystatechange / load events through the virtual clock so the
  // call site's "then" / .done handlers run after the current frame
  // unwinds, matching real-async semantics for the listener ordering
  // libraries assume.
  function CsimXMLHttpRequest() {
    this.readyState         = 0;   // UNSENT
    this.status             = 0;
    this.statusText         = '';
    this.responseText       = '';
    this.response           = '';
    this.responseType       = '';
    this.responseURL        = '';
    this.responseXML        = null;
    this.timeout            = 0;
    this.withCredentials    = false;
    this.upload             = { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };
    this.onreadystatechange = null;
    this.onload             = null;
    this.onloadstart        = null;
    this.onloadend          = null;
    this.onerror            = null;
    this.onabort            = null;
    this.ontimeout          = null;
    this.onprogress         = null;
    this._method            = 'GET';
    this._url               = '';
    this._async             = true;
    this._headers           = {};
    this._respHeaders       = {};
    this._listeners         = Object.create(null);
    this._aborted           = false;
  }
  CsimXMLHttpRequest.UNSENT           = 0;
  CsimXMLHttpRequest.OPENED           = 1;
  CsimXMLHttpRequest.HEADERS_RECEIVED = 2;
  CsimXMLHttpRequest.LOADING          = 3;
  CsimXMLHttpRequest.DONE             = 4;
  CsimXMLHttpRequest.prototype.UNSENT           = 0;
  CsimXMLHttpRequest.prototype.OPENED           = 1;
  CsimXMLHttpRequest.prototype.HEADERS_RECEIVED = 2;
  CsimXMLHttpRequest.prototype.LOADING          = 3;
  CsimXMLHttpRequest.prototype.DONE             = 4;
  CsimXMLHttpRequest.prototype.open = function (method, url, async) {
    this._method    = String(method || 'GET').toUpperCase();
    this._url       = String(url || '');
    this._async     = async !== false;
    this._headers   = {};
    this.readyState = 1;
    this._fireReady();
  };
  CsimXMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    this._headers[String(name)] = String(value);
  };
  CsimXMLHttpRequest.prototype.getResponseHeader = function (name) {
    const v = this._respHeaders[String(name).toLowerCase()];
    return v == null ? null : v;
  };
  CsimXMLHttpRequest.prototype.getAllResponseHeaders = function () {
    return Object.entries(this._respHeaders).map(([k, v]) => k + ': ' + v).join('\r\n');
  };
  CsimXMLHttpRequest.prototype.overrideMimeType = function () {};
  CsimXMLHttpRequest.prototype.addEventListener = function (type, handler) {
    if (typeof handler !== 'function') return;
    (this._listeners[type] = this._listeners[type] || []).push(handler);
  };
  CsimXMLHttpRequest.prototype.removeEventListener = function (type, handler) {
    const list = this._listeners[type];
    if (!list) return;
    this._listeners[type] = list.filter(h => h !== handler);
  };
  CsimXMLHttpRequest.prototype.abort = function () {
    this._aborted = true;
    this.readyState = 4;
    this.status = 0;
    this._fireReady();
    this._fireEvent('abort');
    this._fireEvent('loadend');
  };
  CsimXMLHttpRequest.prototype.send = function (body) {
    const self = this;
    const doFetch = () => {
      if (self._aborted) return;
      let resp;
      try {
        // FormData / URLSearchParams / Headers all reach here when
        // Rails-UJS submits a `data-remote="true"` form (it builds a
        // FormData from the form fields and calls `xhr.send(fd)`).
        // The default `String(fd)` returns `"[object Object]"` which
        // the Rails app treats as garbage. Serialise to
        // urlencoded — the most common no-file path — and let the
        // multipart layer handle the file case once attachments land.
        let bodyStr;
        if (body == null) {
          bodyStr = '';
        } else if (typeof body === 'string') {
          bodyStr = body;
        } else if (body instanceof globalThis.FormData) {
          const parts = [];
          body.forEach((v, k) => parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(v))));
          bodyStr = parts.join('&');
          if (!self._headers['Content-Type'] && !self._headers['content-type']) {
            self._headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
          }
        } else if (body instanceof globalThis.URLSearchParams) {
          bodyStr = body.toString();
          if (!self._headers['Content-Type'] && !self._headers['content-type']) {
            self._headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
          }
        } else {
          bodyStr = String(body);
        }
        resp = __rackFetch(self._method, self._url, bodyStr, self._headers, 'follow');
      } catch (_) { resp = null; }
      if (!resp) {
        self.readyState = 4;
        self.status     = 0;
        self._fireReady();
        self._fireEvent('error');
        self._fireEvent('loadend');
        return;
      }
      self.status       = resp.status || 200;
      self.statusText   = resp.statusText || '';
      self.responseURL  = resp.url || self._url;
      self.responseText = resp.body == null ? '' : String(resp.body);
      self.response     = self.responseText;
      // Normalise response headers to lowercase for getResponseHeader.
      const headers = resp.headers || {};
      const norm = {};
      for (const k of Object.keys(headers)) norm[k.toLowerCase()] = String(headers[k]);
      self._respHeaders = norm;
      self.readyState = 2; self._fireReady();
      self.readyState = 3; self._fireReady();
      self.readyState = 4; self._fireReady();
      self._fireEvent('load');
      self._fireEvent('loadend');
    };
    // Real async: defer through the virtual clock so the current
    // microtask completes before listeners run. Sync XHR (async=false)
    // runs the fetch inline.
    if (this._async) {
      scheduleTimer(doFetch, 0, [], null);
    } else {
      doFetch();
    }
  };
  CsimXMLHttpRequest.prototype._fireReady = function () {
    // readystatechange goes through `_fireEvent`, which itself reads
    // `this.onreadystatechange` — calling the handler here directly
    // double-fires it. Rails-UJS keys on the DONE state to invoke its
    // `done(xhr)` callback, so the second fire triggered `processResponse`
    // a second time and re-eval'd the script response (toggling the
    // visibility back to hidden). The single _fireEvent dispatch is
    // enough.
    this._fireEvent('readystatechange');
  };
  CsimXMLHttpRequest.prototype._fireEvent = function (type) {
    const handler = this['on' + type];
    if (typeof handler === 'function') {
      try { handler.call(this, { type, target: this, currentTarget: this }); } catch (_) {}
    }
    const list = this._listeners[type];
    if (list) for (const h of list.slice()) {
      try { h.call(this, { type, target: this, currentTarget: this }); } catch (_) {}
    }
  };
  globalThis.XMLHttpRequest = CsimXMLHttpRequest;

  globalThis.__virtualNow    = () => __virtualNow;
  globalThis.__hasReadyTimer = function () {
    for (const t of __timers.values()) if (t.due <= __virtualNow) return true;
    return false;
  };

  // Returns the number of timers fired during this drain. Ruby uses
  // the count to invalidate the find-result cache: any fired timer
  // could have mutated the DOM, so cached find results from before
  // the drain are no longer safe to reuse.
  globalThis.__drainTimers = function (maxMs, maxIter) {
    if (typeof maxMs   !== 'number') maxMs   = 2000;
    if (typeof maxIter !== 'number') maxIter = 10000;
    const limit = __virtualNow + maxMs;
    let iter = 0;
    let fired = 0;
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
      fired++;
    }
    // Pin clock at limit even when nothing fired, so a follow-up
    // drain reflects cumulative elapsed time.
    if (__virtualNow < limit) __virtualNow = limit;
    if (__timers.size === 0) __setTimersActive(false);
    return fired;
  };

  globalThis.__resetTimers = function () {
    const had = __timers.size > 0;
    __timers.clear();
    __virtualNow = 0;
    if (had) __setTimersActive(false);
  };

  // Ruby side calls this after the first visit completes to harvest
  // the list of external `<script src>` URLs that were evaluated +
  // their bodies. Feeds the app-warm snapshot build.
  globalThis.__csim_dumpExternalScripts = function () {
    const out = [];
    for (const [url, body] of __externalScriptsRun) out.push({ url, body });
    return out;
  };

  // Used by the warmup snapshot build script to mark a URL as already
  // evaluated — `__externalScriptsRun` is IIFE-scoped, so per-visit
  // pages that try to load the same `<script src>` need to consult
  // through this hook instead of touching the variable directly.
  globalThis.__csim_markScriptLoaded = function (url) {
    __externalScriptsRun.set(String(url), '');
  };

  // Called as the last line of the app-warm snapshot build script.
  // The snapshot freezes a Context in "library bundles evaluated but
  // no page loaded yet" state, so the per-visit side effects that
  // accumulated during warmup eval (queued timers / microtasks,
  // pending MutationObserver records, scratch handles for warmup-only
  // nodes, virtual clock advance) all need to roll back to a clean
  // baseline. What we *keep*: library globals (jQuery, Rails, …),
  // `document._listeners` (`$(document).on(...)` delegates),
  // `__externalScriptsRun` (so per-visit script lists skip already-
  // baked URLs), `__customElementRegistry`, `__hideRules`.
  globalThis.__csimEnterSnapshotState = function () {
    __resetTimers();
    __nextTimerId      = 1;
    __pendingRecords.length = 0;
    if (globalThis.document) {
      // Keep `document.readyState = 'loading'` so the first per-visit
      // `__csimLoadDocument` can flip to 'complete' and dispatch
      // DOMContentLoaded — that's the trigger jQuery-style ready cbs
      // were parked behind during warmup.
      globalThis.document.readyState = 'loading';
      // Strip body content but leave the html / head / body skeleton
      // intact. Library IIFEs captured `documentElement` references
      // that must remain valid in any Context spawned from this
      // snapshot.
      const html = globalThis.document.documentElement;
      if (html) {
        const head = html._children.find(c => c._tag === 'head');
        const body = html._children.find(c => c._tag === 'body');
        if (head) for (const c of head._children.slice()) head.removeChild(c);
        if (body) for (const c of body._children.slice()) body.removeChild(c);
      }
    }
    __handles.clear();
    if (globalThis.document) registerNode(globalThis.document);
  };

  // Vestigial: the Ruby side now rebuilds the Context from the warm
  // snapshot on every visit (and on inter-test reset), so this JS-
  // side reset is unreachable. Kept as a no-op for any latent caller.
  globalThis.__resetPage = function () {
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

})();
