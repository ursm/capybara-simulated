// Small read-only host fns Capybara calls from Ruby via
// `Context#call('__csim<Op>', args)`. Document-level reads,
// querySelector / querySelectorAll batching, XPath evaluation, and
// per-element field accessors (`node.text`, `node.tag_name`,
// `node[name]`, `node.has_attr?`). One V8 round-trip per Capybara
// DSL operation — not per internal DOM op.

import { NODE_DOC, NODE_ELEMENT }       from './constants.js';
import { handles, lookup }              from './handles.js';
import { isConnected, stripOneLeadingNewline } from './walk.js';
import { serializeElement }             from './html-parser.js';

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
// into vendor/js/wgxpath.js and installed at boot). `document.evaluate`
// is patched onto Document.prototype. We use ORDERED_NODE_SNAPSHOT_TYPE
// (7) so the result is a live array we can iterate by index, matching
// Capybara's order expectations.
globalThis.__csimEvaluateXPath = function (xpath, contextHandle) {
  const ctx = contextHandle ? lookup(contextHandle) : globalThis.document;
  if (!ctx) return [];
  let result;
  try {
    result = globalThis.document.evaluate(String(xpath), ctx, null, 7, null);
  } catch (e) {
    try { console.error('[csim] XPath threw:', e && e.message, 'for', xpath); } catch (_) {}
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

globalThis.__csimText = function (h) {
  const n = lookup(h);
  return n ? n.textContent : '';
};

globalThis.__csimTag = function (h) {
  const n = lookup(h);
  if (!n) return '';
  if (n._tag) return n._tag;
  if (n instanceof globalThis.ShadowRoot) return 'ShadowRoot';
  return '';
};

// Trace `description` helper: `{tag, id, cls}` for a CSS-selector-ish
// short form. Class is truncated to the first whitespace-separated
// token so a node with 10 utility classes doesn't drown the trace.
globalThis.__csimDescribeNode = function (h) {
  const n = lookup(h);
  if (!n || n.nodeType !== NODE_ELEMENT) return null;
  const cls = (n._attrs.class || '').trim().split(/\s+/)[0] || '';
  return { tag: n._tag || '', id: n._attrs.id || '', cls };
};

// Capybara's `node[name]` reads either a content attribute or an
// IDL property. Selenium / Cuprite both prefer the IDL property
// when one exists for the named attribute, so `link[:href]` returns
// the URL-resolved absolute href rather than the raw attribute.
// Mirror that here for the URL-reflecting attributes plus the
// well-known form-control IDLs.
globalThis.__csimAttr = function (h, name) {
  const n = lookup(h);
  if (!n) return null;
  const s = String(name);
  switch (s) {
    case 'validationMessage': return n.validationMessage || '';
    case 'validity':          return n.validity || null;
    case 'innerHTML':         return typeof n.innerHTML === 'string' ? n.innerHTML : null;
    case 'outerHTML':         return typeof n.outerHTML === 'string' ? n.outerHTML : null;
    case 'textContent':       return typeof n.textContent === 'string' ? n.textContent : null;
    case 'checked':           return !!n.checked;
    case 'disabled':          return !!n.disabled;
    case 'value':             return n.value != null ? n.value : '';
    case 'href':
    case 'src':
      if (typeof n[s] === 'string') return n[s];
      break;
  }
  // ARIA IDL reflection: `el.ariaExpanded` etc. map to the matching
  // `aria-*` content attribute per the ARIAMixin spec, so Selenium /
  // Cuprite's `getAttribute("ariaExpanded")` returns the content
  // attribute value via the IDL property path. Without this hop,
  // Discourse's `replies_button[:ariaExpanded]` reads `null` instead
  // of `"true"`.
  if (s.length > 4 && s.startsWith('aria') && s[4] >= 'A' && s[4] <= 'Z' && n.getAttribute) {
    return n.getAttribute('aria-' + s[4].toLowerCase() + s.slice(5));
  }
  return n.getAttribute ? n.getAttribute(s) : null;
};

globalThis.__csimHasAttr = function (h, name) {
  const n = lookup(h);
  return !!(n && n.hasAttribute && n.hasAttribute(name));
};

globalThis.__csimOptionSelected = function (h) {
  const n = lookup(h);
  if (!n || n.nodeType !== NODE_ELEMENT || n._tag !== 'option') return false;
  if (n._attrs.selected != null) return true;
  // Find the owning <select>; walk past optgroup wrappers.
  let sel = n._parent;
  while (sel && sel.nodeType === NODE_ELEMENT && sel._tag === 'optgroup') sel = sel._parent;
  if (!sel || sel._tag !== 'select') return false;
  if (sel._attrs.multiple != null) return false;
  // Walk all options. Any explicit `<option selected>` kills the
  // implicit pick. Track the first non-disabled candidate; `n` is
  // the implicit selection iff it matches.
  const opts = sel.querySelectorAll('option');
  let firstEnabled = null;
  for (const o of opts) {
    if (o._attrs.selected != null) return false;
    if (o._attrs.disabled == null && firstEnabled === null) firstEnabled = o;
  }
  return n === firstEnabled;
};

// Only form controls (+ fieldset) can be disabled; an `<option>`
// inherits from an ancestor `<select>` / `<optgroup>`; form controls
// inherit from an ancestor `<fieldset disabled>` unless they sit
// inside its first `<legend>`.
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

globalThis.__csimBaseHref = function () {
  const doc = globalThis.document;
  if (!doc || !doc.head) return '';
  for (const c of doc.head._children || []) {
    if (c.nodeType === NODE_ELEMENT && c._tag === 'base' && c._attrs.href != null) {
      return String(c._attrs.href);
    }
  }
  return '';
};

globalThis.__csimNodePath = function (h) {
  const start = handles.get(h);
  if (!start || start.nodeType !== NODE_ELEMENT) return '';
  // A node living inside a ShadowRoot doesn't have a stable
  // document-level XPath. Capybara uses the same marker string for
  // these as selenium/cuprite.
  for (let cur = start; cur; cur = cur._parent) {
    if (cur instanceof globalThis.ShadowRoot) return '(: Shadow DOM element - no XPath :)';
  }
  const segments = [];
  let cur = start;
  while (cur && cur.nodeType === NODE_ELEMENT) {
    const parent = cur._parent;
    if (!parent) break;
    const sibs = (parent._children || []).filter(c =>
      c.nodeType === NODE_ELEMENT && c._tag === cur._tag
    );
    const idx = sibs.indexOf(cur) + 1;
    segments.unshift(cur._tag + '[' + idx + ']');
    cur = parent;
  }
  return '/' + segments.join('/');
};

globalThis.__csimOptionContext = function (h) {
  const n = handles.get(h);
  if (!n || n.nodeType !== NODE_ELEMENT) return { hasSelect: false, multiple: false };
  let cur = n._parent;
  while (cur && cur._tag !== 'select') cur = cur._parent;
  if (!cur || cur._tag !== 'select') return { hasSelect: false, multiple: false };
  return { hasSelect: true, multiple: cur._attrs.multiple != null };
};

globalThis.__csimShadowRoot = function (h) {
  const el = handles.get(h);
  const sr = el && el._shadowRoot;
  return sr && sr.mode === 'open' && sr._id != null ? sr._id : 0;
};

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

// "Alive" = the node behind this handle is still attached to the
// document tree. Handles outlive their nodes (the handle map keeps a
// strong ref so JS-side ops on detached fragments stay coherent), so
// "is in handles" isn't the same as "still in the document."
// Capybara's stale-node detection depends on this: a node that's been
// removed from the DOM must report as stale on the next read.
globalThis.__csimAlive = function (h) {
  const n = handles.get(h);
  return n != null && isConnected(n);
};

// Form-field value reader. Mirrors what Capybara reads via
// Node#value: input/textarea use `.value`, select returns its
// selected option value, checkbox / radio surface their `.value`
// only when checked (rack-test parity).
globalThis.__csimValue = function (h) {
  const n = lookup(h);
  if (!n || n.nodeType !== NODE_ELEMENT) return null;
  const tag = n._tag;
  if (tag === 'textarea') {
    // HTML "first newline removal": after a `set`, `_attrs.value`
    // carries the user's intent verbatim; otherwise strip one
    // leading line terminator from the parsed textContent.
    if (n._attrs.value != null) return n._attrs.value;
    return stripOneLeadingNewline(n.textContent);
  }
  if (tag === 'select') {
    const opts = n.querySelectorAll('option');
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
  if (tag === 'input') {
    const type = (n._attrs.type || 'text').toLowerCase();
    if (type === 'checkbox' || type === 'radio') return n._attrs.value != null ? n._attrs.value : 'on';
    return n._attrs.value != null ? n._attrs.value : '';
  }
  return n._attrs.value != null ? n._attrs.value : '';
};

// Element-targeted HTML access — what tests reach for via
// `find('.x').native.inner_html` / `.outer_html`. Returns '' when
// the handle no longer resolves rather than throwing; stale handles
// are caught at the Ruby `check_stale` layer.
globalThis.__csimInnerHTML = function (h) {
  const el = lookup(h);
  return el && el.nodeType === NODE_ELEMENT ? el.innerHTML : '';
};
globalThis.__csimOuterHTML = function (h) {
  const el = lookup(h);
  return el && el.nodeType === NODE_ELEMENT ? el.outerHTML : '';
};

globalThis.__csimDocumentHtml = function () {
  return globalThis.document.documentElement
    ? serializeElement(globalThis.document.documentElement)
    : '';
};
