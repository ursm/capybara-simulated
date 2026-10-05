// A document's parts the tree says what they are (DOM §4.5, HTML §3.1.3): the document element, the body, the head —
// derived from the children, so they stay right after any insert or remove, not just the parser's. What Document's
// members answer (dom-nodes.js), and what the driver reads instead of them: a member is a page's to replace, and its
// binding's `this` test a cost every hot read paid.
import { NODE_ELEMENT, HTML_NS } from './constants.js';

// The document element: the document's (single) element child. The child list is tiny (a doctype and the root), and
// the loop allocates nothing on this hot read.
export function documentElementOf(doc) {
  const kids = doc._children;
  for (let i = 0; i < kids.length; i++) if (kids[i]._nodeType === NODE_ELEMENT) return kids[i];
  return null;
}
// The body element: the first child of the HTML `html` document element that is an HTML `body` or `frameset`.
export function bodyOf(doc) {
  const html = documentElementOf(doc);
  if (!html || html._ns !== HTML_NS || html._localName !== 'html') return null;
  for (const c of html._children) if (c._ns === HTML_NS && (c._localName === 'body' || c._localName === 'frameset')) return c;
  return null;
}
// The head element: the document element's first HTML `head` child (by namespace and local name: a prefixed
// `blah:head` counts, a foreign one does not — document.head-02).
export function headOf(doc) {
  const html = documentElementOf(doc);
  if (!html) return null;
  for (const c of html._children) if (c._ns === HTML_NS && c._localName === 'head') return c;
  return null;
}
