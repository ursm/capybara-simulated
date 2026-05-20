// Small read-only host fns Capybara calls from Ruby via
// `Context#call('__csim<Op>', args)`. Document-level reads,
// querySelector / querySelectorAll batching, XPath evaluation, and
// per-element field accessors (`node.text`, `node.tag_name`,
// `node[name]`, `node.has_attr?`). One V8 round-trip per Capybara
// DSL operation — not per internal DOM op.

import { NODE_DOC, NODE_ELEMENT } from './constants.js';
import { lookup }                 from './handles.js';

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
// IDL property. Route a few well-known IDL names off the getAttribute
// path so `node[:validationMessage]` / `node[:innerHTML]` etc.
// return what user JS sees.
globalThis.__csimAttr = function (h, name) {
  const n = lookup(h);
  if (!n) return null;
  switch (String(name)) {
    case 'validationMessage': return n.validationMessage || '';
    case 'validity':          return n.validity || null;
    case 'innerHTML':         return typeof n.innerHTML === 'string' ? n.innerHTML : null;
    case 'outerHTML':         return typeof n.outerHTML === 'string' ? n.outerHTML : null;
    case 'textContent':       return typeof n.textContent === 'string' ? n.textContent : null;
    case 'checked':           return !!n.checked;
    case 'disabled':          return !!n.disabled;
    case 'value':             return n.value != null ? n.value : '';
  }
  return n.getAttribute ? n.getAttribute(name) : null;
};

globalThis.__csimHasAttr = function (h, name) {
  const n = lookup(h);
  return !!(n && n.hasAttribute && n.hasAttribute(name));
};
