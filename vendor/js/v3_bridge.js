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

  class Node {
    constructor() {
      this._id        = __nextId++;
      this._parent    = null;
      this._children  = [];      // ordered child nodes (Element + Text)
      this.nodeType   = NODE_ELEMENT;
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
      if (child._parent) child._parent.removeChild(child);
      child._parent = this;
      this._children.push(child);
      return child;
    }
    removeChild(child) {
      const i = this._children.indexOf(child);
      if (i < 0) return null;
      this._children.splice(i, 1);
      child._parent = null;
      return child;
    }
    insertBefore(child, ref) {
      if (ref == null) return this.appendChild(child);
      if (child._parent) child._parent.removeChild(child);
      const i = this._children.indexOf(ref);
      if (i < 0) return this.appendChild(child);
      child._parent = this;
      this._children.splice(i, 0, child);
      return child;
    }
    replaceChild(neu, old) {
      const i = this._children.indexOf(old);
      if (i < 0) return null;
      if (neu._parent) neu._parent.removeChild(neu);
      neu._parent = this;
      old._parent = null;
      this._children[i] = neu;
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
    get nodeName() { return '#text'; }
    get textContent() { return this.data; }
    set textContent(v) { this.data = String(v == null ? '' : v); }
  }

  class Element extends Node {
    constructor(tagName) {
      super();
      this._tag    = String(tagName).toLowerCase();
      this._attrs  = {};   // name(lower) → value(string)
    }
    get tagName()    { return this._tag.toUpperCase(); }
    get nodeName()   { return this.tagName; }
    get localName()  { return this._tag; }
    getAttribute(name)        { const v = this._attrs[String(name).toLowerCase()]; return v == null ? null : v; }
    setAttribute(name, value) { this._attrs[String(name).toLowerCase()] = String(value); }
    removeAttribute(name)     { delete this._attrs[String(name).toLowerCase()]; }
    hasAttribute(name)        { return Object.prototype.hasOwnProperty.call(this._attrs, String(name).toLowerCase()); }
    get attributes() {
      return Object.keys(this._attrs).map(name => ({ name, value: this._attrs[name] }));
    }
    get id()        { return this._attrs.id || ''; }
    set id(v)       { this._attrs.id = String(v); }
    get className() { return this._attrs['class'] || ''; }
    set className(v){ this._attrs['class'] = String(v); }
    get classList() {
      const el = this;
      return {
        contains(c) { return classes(el).includes(c); },
        add(c)      { const cs = classes(el); if (!cs.includes(c)) { cs.push(c); el._attrs['class'] = cs.join(' '); } },
        remove(c)   { const cs = classes(el).filter(x => x !== c); el._attrs['class'] = cs.join(' '); },
        toggle(c)   { const cs = classes(el); const i = cs.indexOf(c); if (i >= 0) cs.splice(i, 1); else cs.push(c); el._attrs['class'] = cs.join(' '); }
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
    get checked()  { return this._attrs.checked != null; }
    set checked(v) { if (v) this._attrs.checked = ''; else delete this._attrs.checked; }

    get innerHTML() { return serializeChildren(this); }
    set innerHTML(html) {
      this._children = [];
      const frag = parseFragment(String(html == null ? '' : html));
      for (const c of frag) { c._parent = this; this._children.push(c); }
    }
    get outerHTML() { return serializeElement(this); }
  }

  class Document extends Node {
    constructor() {
      super();
      this.nodeType = NODE_DOC;
      this.documentElement = null;
    }
    createElement(tag)     { return new Element(tag); }
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
  }

  function classes(el) {
    const cls = el._attrs['class'];
    return cls ? cls.split(/\s+/).filter(Boolean) : [];
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
      out.push(c.split(/\s+/).map(parseSimple));
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
  // Match el against a single chain of units (joined by descendant).
  function matchChain(el, units) {
    if (!units.length) return false;
    if (!matchUnit(el, units[units.length - 1])) return false;
    let cur = el._parent;
    for (let i = units.length - 2; i >= 0; i--) {
      while (cur && cur.nodeType === NODE_ELEMENT && !matchUnit(cur, units[i])) cur = cur._parent;
      if (!cur || cur.nodeType !== NODE_ELEMENT) return false;
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
    const stack = []; // { el, children: out-or-parent's-children }
    let target = out;
    let i = 0;
    const re = /<(\/?)([a-zA-Z][\w-]*)([^>]*)>/g;
    let m, last = 0;
    while ((m = re.exec(html)) !== null) {
      if (m.index > last) {
        const text = html.slice(last, m.index);
        if (text.length) target.push(makeText(text));
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
      el._parent = stack.length ? stack[stack.length - 1].el : null;
      target.push(el);
      if (VOID.has(tag) || /\/\s*$/.test(rest)) continue;
      if (RAWTEXT.has(tag)) {
        const closeRe = new RegExp('</' + tag + '\\s*>', 'i');
        const closeIdx = html.search.call(html.slice(last), closeRe);
        const absIdx   = closeIdx < 0 ? html.length : last + closeIdx;
        const raw = html.slice(last, absIdx);
        if (raw.length) el._children.push(Object.assign(makeText(raw), { _parent: el }));
        const end = closeIdx < 0 ? html.length : (last + closeIdx + ('</' + tag + '>').length);
        last = end; re.lastIndex = end;
        continue;
      }
      stack.push({ el });
      target = el._children;
    }
    if (last < html.length) {
      const tail = html.slice(last);
      if (tail.length) target.push(makeText(tail));
    }
    // re-stitch parents for the top-level returned nodes
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
    const attrs = Object.keys(el._attrs).map(n => ' ' + n + '="' + escapeAttr(el._attrs[n]) + '"').join('');
    if (VOID.has(el._tag)) return '<' + el._tag + attrs + '>';
    return '<' + el._tag + attrs + '>' + serializeChildren(el) + '</' + el._tag + '>';
  }
  function serializeChildren(el) {
    let s = '';
    for (const c of el._children) {
      s += c.nodeType === NODE_TEXT ? escapeText(c.data) : serializeElement(c);
    }
    return s;
  }
  function escapeAttr(v) { return String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;'); }
  function escapeText(v) { return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  // ── Globals seen by Ruby side via Context#call('__csim<Op>') ────

  globalThis.document = new Document();
  globalThis.window   = globalThis;

  // Handle registry — Ruby keeps integer ids, looks up Element back
  // via `__csimGet*(handle)` accessors. Wired in `parseDocument`
  // and pushed during create / append paths once those exist.
  const __handles = new Map();
  function registerNode(n) {
    __handles.set(n._id, n);
    if (n._children) for (const c of n._children) registerNode(c);
  }
  function lookup(h) { return __handles.get(h) || null; }

  // Replace the document with a freshly-parsed one. Capybara's `visit`
  // ends up here. After parse, walk top-level `<script>` elements and
  // eval their text — that's enough to drive inline scripts that
  // populate globals tests then read via evaluate_script. External
  // `<script src>` / `defer` / `async` ordering lifts in once
  // resource fetching ports to v3.
  globalThis.__csimLoadDocument = function (html) {
    __handles.clear();
    globalThis.document = parseDocument(String(html == null ? '' : html));
    registerNode(globalThis.document);
    runInlineScripts(globalThis.document);
    return globalThis.document._id;
  };

  function runInlineScripts(doc) {
    if (!doc || !doc.documentElement) return;
    const scripts = doc.documentElement.querySelectorAll('script');
    for (const s of scripts) {
      if (s._attrs.src) continue;            // PoC: skip external — milestone 4 (b)
      const type = (s._attrs.type || '').toLowerCase();
      if (type && !SCRIPT_TYPES_CLASSIC.has(type)) continue;
      const body = scriptText(s);
      if (!body) continue;
      try { (0, eval)(body); } catch (e) {
        // Surface to the host via console (Ruby side prints). Don't
        // re-raise: real browsers continue parsing after a script throws.
        try { console.error('[csim v3] inline script threw:', e && e.message); } catch (_) {}
      }
    }
  }
  function scriptText(el) {
    let s = '';
    for (const c of el._children) if (c.nodeType === NODE_TEXT) s += c.data;
    return s;
  }
  const SCRIPT_TYPES_CLASSIC = new Set([
    '', 'text/javascript', 'application/javascript', 'application/ecmascript'
  ]);

  // Capybara's `Session#evaluate_script` reaches here. Wrap the code
  // in a function so it sees `arguments[N]` and an implicit return
  // hands back the last expression. Mirrors v2's `__evalScript`
  // contract closely enough for the smoke tests.
  globalThis.__csimEvalScript = function (code, args) {
    const fn = new Function('arguments', 'return (' + code + ')');
    return fn(args || []);
  };
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
  globalThis.__csimVisible   = function (h) {
    // PoC: every Element is "visible". Hidden-by-style and
    // hidden-attribute filtering ports in a later milestone.
    const n = lookup(h);
    return !!(n && n.nodeType === NODE_ELEMENT);
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
    if (tag === 'textarea') return n.textContent;
    if (tag === 'select') {
      // walk options in document order; return first explicitly-
      // selected (selected attr) or the first non-disabled option's
      // value as the implicit default.
      const opts = n.querySelectorAll('option');
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
    if (n._tag === 'a' && n._attrs.href != null) {
      return { kind: 'navigate', url: n._attrs.href };
    }
    if (isSubmitButton(n)) {
      const form = ancestorForm(n);
      if (form) return { kind: 'submit', formHandle: form._id, submitter: n._id };
    }
    if (n._tag === 'input') {
      const type = (n._attrs.type || '').toLowerCase();
      if (type === 'checkbox') { toggleChecked(n); return null; }
      if (type === 'radio')    { setRadio(n);     return null; }
    }
    return null;
  };
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
    const v = value == null ? '' : String(value);
    if (tag === 'textarea') { n._children = []; n._children.push(Object.assign(new Text(v), { _parent: n })); n._attrs.value = v; return true; }
    if (tag === 'input') {
      const type = (n._attrs.type || 'text').toLowerCase();
      if (type === 'checkbox' || type === 'radio') {
        if (value === true || value === 'true') n._attrs.checked = '';
        else if (value === false || value === 'false') delete n._attrs.checked;
        else n._attrs.value = v;
      } else {
        n._attrs.value = v;
      }
      return true;
    }
    if (tag === 'select') {
      // Match the first <option> whose value (or textContent fallback)
      // equals v; mark it selected, clear siblings.
      const opts = n.querySelectorAll('option');
      for (const o of opts) {
        const ov = o._attrs.value != null ? o._attrs.value : o.textContent;
        if (ov === v) { selectOptionExclusive(n, o); return true; }
      }
      return false;
    }
    n._attrs.value = v;
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
    const inputs = form.querySelectorAll('input,textarea,select,button');
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
        fields.push([name, f._attrs.value != null ? f._attrs.value : f.textContent]);
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
    return {
      action: form._attrs.action != null ? form._attrs.action : '',
      method: (form._attrs.method || 'get').toLowerCase(),
      enctype: (form._attrs.enctype || 'application/x-www-form-urlencoded').toLowerCase(),
      fields: fields
    };
  };

  // ── Virtual clock (placeholder until v2 bridge lifted in) ───────

  let __virtualNow = 0;
  globalThis.__virtualNow      = () => __virtualNow;
  globalThis.__drainTimers     = function () { /* TODO: port v2 */ };
  globalThis.__hasReadyTimer   = function () { return false; };
  globalThis.__resetTimers     = function () { __virtualNow = 0; };
  globalThis.__resetPage       = function () { globalThis.document = new Document(); __virtualNow = 0; };

})();
