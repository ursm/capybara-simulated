// Small read-only host fns Capybara calls from Ruby via
// `Context#call('__csim<Op>', args)`. Document-level reads,
// querySelector / querySelectorAll batching, XPath evaluation, and
// per-element field accessors (`node.text`, `node.tag_name`,
// `node[name]`, `node.has_attr?`). One V8 round-trip per Capybara
// DSL operation — not per internal DOM op.

import { NODE_DOC, NODE_ELEMENT }       from './constants.js';
import { handles, lookup }              from './handles.js';
import { isConnected } from './walk.js';
import { serializeElement }             from './html-parser.js';
import { controlLiveValue, isNodeActuallyDisabled } from './form-helpers.js';

// HTML spec: the `document.title` getter strips and collapses ASCII
// whitespace in the title element's child text content (runs of
// `[\t\n\f\r ]+` → single space, plus leading/trailing trim). Without
// this, server-rendered titles that go through emoji-strip-with-gap
// expansions (Discourse's `gsub_emoji_to_unicode` for a denied emoji
// leaves a double space where `:name:` used to be) reach the test as
// raw textContent and assertions on `page.title` fail vs the
// real-browser-canonical normalisation.
globalThis.__csimDocumentTitle = function () {
  // Delegate to the spec-correct `document.title` getter (tree-order HTML title
  // / SVG-root title, namespace-aware, child-text-content with the same
  // whitespace strip+collapse) so `page.title` can't diverge from it.
  return globalThis.document.title;
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

// XPath evaluation via the xpathway engine (bundled into the vendor blob;
// `document.evaluate` is installed onto Document.prototype at boot — see
// js/src/xpath.js). We use ORDERED_NODE_SNAPSHOT_TYPE (7) so the result is a
// snapshot array we can iterate by index, matching Capybara's order
// expectations.
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
// Integer-typed IDL reflections per HTML spec: the IDL property
// returns a parsed Number, not the raw attribute string. Selenium
// (and therefore Capybara's selenium driver) honours this via
// `getProperty`, so a spec assertion like `find('ol')['start']`
// expects `5` not `"5"`. Reflect a small set of well-known
// integer attributes; default fallback (`getAttribute`) keeps
// returning the string for anything outside this table.
const __csimIntAttrIDLs = {
  ol:    new Set(['start']),
  li:    new Set(['value']),
  td:    new Set(['colSpan', 'colspan', 'rowSpan', 'rowspan']),
  th:    new Set(['colSpan', 'colspan', 'rowSpan', 'rowspan']),
  input: new Set(['maxLength', 'maxlength', 'minLength', 'minlength', 'size']),
  textarea: new Set(['cols', 'rows', 'maxLength', 'maxlength', 'minLength', 'minlength']),
  select:   new Set(['size']),
  img:      new Set(['width', 'height', 'naturalWidth', 'naturalHeight'])
};
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
    case 'innerText': {
      // The `Element#innerText` IDL getter returns "as rendered" text
      // (whitespace collapsed, leading/trailing trimmed) per W3C §11.
      // `__csimVisibleText` builds the per-line text with INLINE_WS_RE
      // collapsing newlines/tabs to single spaces, but real browsers
      // additionally collapse runs of regular spaces and trim the
      // result so `selected_groups & ["trust_level_4"]` style
      // assertions match the literal label rather than the
      // indented-template whitespace.
      const raw = typeof globalThis.__csimVisibleText === 'function' ? globalThis.__csimVisibleText(h)
                : typeof n.innerText === 'string' ? n.innerText
                : null;
      if (raw == null) return null;
      // Collapse runs of regular spaces (newlines/tabs already
      // collapsed to spaces upstream) and trim each line. Preserve
      // line breaks because innerText emits them at block boundaries.
      return raw.split('\n').map(line => line.replace(/ {2,}/g, ' ').trim()).join('\n').replace(/^\n+|\n+$/g, '');
    }
    case 'textContent':       return typeof n.textContent === 'string' ? n.textContent : null;
    case 'checked':           return !!n.checked;
    case 'disabled':          return !!n.disabled;
    case 'value':             return n.value != null ? n.value : '';
    case 'href':
    case 'src':
      if (typeof n[s] === 'string') return n[s];
      break;
  }
  const intSet = n._tag && __csimIntAttrIDLs[n._tag];
  if (intSet && intSet.has(s)) {
    const raw = n.getAttribute && n.getAttribute(s.toLowerCase());
    if (raw != null) {
      const parsed = parseInt(raw, 10);
      if (!isNaN(parsed)) return parsed;
    }
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
  // Selectedness is maintained eagerly by the selectedness setting
  // algorithm (custom-elements.js) on parse / insert / remove / pick, so
  // the implicit single-select default is already materialised on the
  // first non-disabled option — no per-read scan needed.
  return n._selectedness === true;
};

// `disabled?` shares the HTML "actually disabled" algorithm with the `:disabled`
// CSS pseudo (form-helpers isNodeActuallyDisabled) so the two can never disagree:
// own `[disabled]`, a control in a disabled `<fieldset>`, or an option/optgroup in
// a disabled `<select>` / optgroup.
globalThis.__csimDisabled = function (h) {
  return isNodeActuallyDisabled(lookup(h));
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

// `switch_to_frame` entry point: given an `<iframe>` / `<frame>` handle in
// THIS realm, force its nested browsing context to exist (the realm is built
// lazily on first `contentWindow` access) and return the realm's context id,
// or 0 when no per-frame realm is available (QuickJS's same-realm fallback,
// or a non-frame element). Ruby then routes the `within_frame` body's DOM ops
// into that realm via `V8Runtime#realm_call`.
globalThis.__csimEnsureFrameRealm = function (h) {
  const el = lookup(h);
  if (!el || (el._tag !== 'iframe' && el._tag !== 'frame')) return 0;
  if (typeof globalThis.__csimFrameWindow !== 'function') return 0;
  globalThis.__csimFrameWindow(el);   // builds + loads the realm if needed
  return el._frameRealmId != null ? el._frameRealmId : 0;
};

// This realm's own browsing-context URL (`window.location.href`). Read by the
// Browser to resolve a frame-relative navigation and set the request referrer.
globalThis.__csimLocationHref = function () {
  return (globalThis.location && globalThis.location.href) || '';
};

// Point an `<iframe>` element at a freshly (re)built frame realm after a
// frame-scoped navigation. Runs in the PARENT realm (where the element lives):
// updates the element's cached realm id and swaps the id in the parent's
// child-realm step set so `drainChildRealms` steps the new realm's event loop
// (and stops stepping the disposed one). Mirrors what `__csimFrameWindow` does
// on the lazy first build, which the Ruby-driven reload path bypasses.
globalThis.__csimRebindFrameRealm = function (h, oldId, newId) {
  const el = lookup(h);
  if (el) { el._frameRealmId = newId || null; el._frameWindow = null; }
  const ids = globalThis.__csimChildRealmIds;
  if (ids) {
    if (oldId) ids.delete(oldId);
    if (newId) ids.add(newId);
  }
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
    // The live value: `_value` after a `set`/typing edit (dirty value flag),
    // else the child text content as-is. HTML "first newline removal" is a
    // parse-time operation (the parser already dropped one leading line
    // terminator), so re-stripping here would double-strip.
    return controlLiveValue(n);
  }
  if (tag === 'select') {
    const opts = n.querySelectorAll('option');
    const multi = n._attrs.multiple != null;
    if (multi) {
      const out = [];
      for (const o of opts) {
        if (o._selectedness === true) out.push(o._attrs.value != null ? o._attrs.value : o.textContent);
      }
      return out;
    }
    let implicit = null;
    for (const o of opts) {
      if (o._attrs.disabled != null) continue;
      if (o._selectedness === true) return o._attrs.value != null ? o._attrs.value : o.textContent;
      if (implicit == null) implicit = o._attrs.value != null ? o._attrs.value : o.textContent;
    }
    return implicit;
  }
  if (tag === 'input') {
    const type = (n._attrs.type || 'text').toLowerCase();
    if (type === 'checkbox' || type === 'radio') return n._attrs.value != null ? n._attrs.value : 'on';
    return controlLiveValue(n);
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

// ── Cross-window remote-ref RPC (TARGET side) ──────────────────────────────
// Another window's opener holds proxies that forward every get/set/method-call
// to here, addressing the object by a ref id: a positive id is a DOM node
// handle (the `handles` registry); a negative id is a non-node object (window,
// document-adjacent objects, navigator, …) registered on demand. The window
// itself is ref id 0. Values crossing back are serialized to plain markers so
// the host marshaller can copy them: primitives pass through, a function →
// `{__csimRefFn:true}` (the caller re-invokes it via __csimRemoteRefCall on the
// owning ref), and any node/object → `{__csimRef:id}` (wrapped as a proxy).
const __remoteObjRegistry = new Map();   // negative id -> object
const __remoteObjIds      = new WeakMap();
let __remoteObjSeq = 0;
function __remoteResolveRef(id) {
  if (id === 0) return globalThis;
  if (id < 0) return __remoteObjRegistry.get(id) || null;
  return lookup(id);
}
function __remoteSerialize(v) {
  if (v == null) return null;
  const t = typeof v;
  if (t === 'string' || t === 'number' || t === 'boolean') return v;
  if (t === 'function') return { __csimRefFn: true };
  if (t !== 'object') return null;                       // symbol / bigint — unsupported
  if (v.nodeType != null && v._id != null) { handles.set(v._id, v); return { __csimRef: v._id }; }
  let id = __remoteObjIds.get(v);
  if (id == null) { id = (__remoteObjSeq -= 1); __remoteObjIds.set(v, id); __remoteObjRegistry.set(id, v); }
  return { __csimRef: id };
}
function __remoteDeserialize(v) {
  return (v && typeof v === 'object' && v.__csimRef != null) ? __remoteResolveRef(v.__csimRef) : v;
}
globalThis.__csimRemoteRefGet = function (id, prop) {
  const o = __remoteResolveRef(id);
  if (o == null) return null;
  try { return __remoteSerialize(o[prop]); } catch (_) { return null; }
};
globalThis.__csimRemoteRefSet = function (id, prop, value) {
  const o = __remoteResolveRef(id);
  if (o == null) return;
  try { o[prop] = __remoteDeserialize(value); } catch (_) {}
};
globalThis.__csimRemoteRefCall = function (id, method, args) {
  const o = __remoteResolveRef(id);
  if (o == null) return null;
  try {
    const fn = o[method];
    if (typeof fn !== 'function') return null;
    return __remoteSerialize(fn.apply(o, (args || []).map(__remoteDeserialize)));
  } catch (_) { return null; }
};
