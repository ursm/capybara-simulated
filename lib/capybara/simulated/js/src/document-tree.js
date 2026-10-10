// A document's parts the tree says what they are (DOM §4.5, HTML §3.1.3): the document element, the body, the head —
// derived from the children, so they stay right after any insert or remove, not just the parser's. What Document's
// members answer (dom-nodes.js), and what the driver reads instead of them: a member is a page's to replace, and its
// binding's `this` test a cost every hot read paid.
import { relativeOf, RELATIVE_FIRST_ELEMENT, RELATIVE_HEAD, RELATIVE_BODY } from './native-query-shadow.js';

// The document element: the document's (single) element child, the engine's — one call on this hot read.
export function documentElementOf(doc) {
  return relativeOf(doc, RELATIVE_FIRST_ELEMENT);
}
// The body element: the first child of the HTML `html` document element that is an HTML `body` or `frameset` — the
// engine's.
export function bodyOf(doc) {
  return relativeOf(doc, RELATIVE_BODY);
}
// The head element: the document element's first HTML `head` child (by namespace and local name: a prefixed
// `blah:head` counts, a foreign one does not — document.head-02) — the engine's.
export function headOf(doc) {
  return relativeOf(doc, RELATIVE_HEAD);
}
