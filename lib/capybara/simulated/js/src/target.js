// HTML "the target element" — what `:target` matches: a document's INDICATED PART for its URL's fragment, the first
// element in the document's tree (not a shadow tree) whose id is the decoded fragment, else the first `<a>` whose
// `name` is. A document that was never navigated to a URL of its own (a DOMParser / createHTMLDocument one) has none.
// The one definition the JS matcher, the invalidation hint (location.js) and the arena (`__dom.setTarget`, which
// element_state.rs resolves the same way) all read.
//
// The tree generation comes through its global, so this sits beneath selectors / location without importing them.
import { HTML_NS } from './constants.js';
import { arenaNid } from './native-query-shadow.js';

// `doc`'s URL fragment, percent-decoded (as typed when it does not decode), or null when it has none to indicate.
export function documentFragment(doc) {
  let hash = '';
  if (doc._url) {
    try { hash = new URL(doc._url).hash; } catch (_) { hash = ''; }
  } else if (doc === globalThis.document) {
    hash = (globalThis.location && globalThis.location.hash) || '';
  }
  if (hash.length <= 1) return null;
  let frag = hash.slice(1);
  try { frag = decodeURIComponent(frag); } catch (_) { /* malformed %-escape: compare raw */ }
  return frag;
}

// The indicated part of `doc` for `fragment`, or null.
export function indicatedPart(doc, fragment) {
  if (fragment === null) return null;
  const byId = doc.getElementById(fragment);
  if (byId) return byId;
  let named = null;
  const visit = (n) => {
    if (named) return;
    if (n.nodeType === 1 && n._ns === HTML_NS && n._localName === 'a' && n._attrs.name === fragment) { named = n; return; }
    const ch = n._children;
    if (ch) for (let i = 0; i < ch.length && !named; i++) visit(ch[i]);
  };
  visit(doc);
  return named;
}

// `doc`'s target element, kept until the tree or the fragment moves (every element asks during a match).
const memo = new WeakMap();
export function targetElementOf(doc) {
  const fragment = documentFragment(doc);
  const gen = globalThis.__csimTreeGen ? globalThis.__csimTreeGen() : 0;
  const m = memo.get(doc);
  if (m !== undefined && m.gen === gen && m.fragment === fragment) return m.element;
  const element = indicatedPart(doc, fragment);
  memo.set(doc, { gen, fragment, element });
  return element;
}

// The realm document's fragment, into its arena: after a load and whenever the fragment changes.
export function syncTargetFragment() {
  const d = globalThis.__dom, doc = globalThis.document;
  const nid = d && doc ? arenaNid(doc) : -1;
  if (nid < 0) return;
  const fragment = documentFragment(doc);
  d.setTarget(nid, fragment === null ? undefined : fragment);
}
