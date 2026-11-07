// querySelector(All) / matches / closest, and a style sheet rule's match: selector.rs — Servo's `selectors` crate over
// the arena, the parser and matcher the style system matches with — answers every selector; one it does not parse is a
// SyntaxError. The arena hands back the nodes it found.

import { NODE_ELEMENT, NODE_DOC } from './constants.js';
import { arenaOfNid } from './native-query-shadow.js';
import { documentElementOf } from './document-tree.js';
import { DOMException } from './dom-exception.js';
import { nidOf, nodeTypeOf } from './node-identity.js';

// The document a selector is matched in, by its nid (-1 for none): the engine reads its mode — in a quirks-mode
// document a class or id selector matches ASCII case-insensitively (Selectors 4 §6.6 / §6.7), and in an XML one no type
// selector or attribute name folds case (document_state.rs `document_mode`). The engine's to name, from the node.
const documentNidOf = (node) => globalThis.__dom.nodeDocumentNid(node);
// The selector argument (a WebIDL DOMString), its NULs U+FFFD as CSS's input preprocessing has them.
function selectorString(sel) {
  if (typeof sel !== 'string') sel = String(sel);
  return sel.indexOf('\x00') === -1 ? sel : sel.replace(/\x00/g, '�');
}
function invalidSelector(sel) {
  return new DOMException("csim: '" + sel + "' is not a valid selector", 'SyntaxError');
}
// The arena the node of slot `nid` is in, for asking it — an Error where none can be had.
function arenaOf(nid) {
  const a = arenaOfNid(nid);
  if (!a) throw new Error('[csim] no arena holds the node a selector is matched against');
  return a;
}


// querySelector(All) on `container` (a Document, DocumentFragment or Element): its descendant elements, `:scope` the
// container — a Document's being its root element.
function select(container, sel, firstOnly) {
  sel = selectorString(sel);
  const nid = nidOf(container);
  const scope = nodeTypeOf(container) === NODE_DOC ? documentElementOf(container) : container;
  const found = arenaOf(nid).dom.query(nid, sel, documentNidOf(container), firstOnly, scope ? nidOf(scope) : undefined);
  if (found === null) throw invalidSelector(sel);
  return found;
}
export function selectAll(container, sel) {
  return select(container, sel, false);
}
export function selectFirst(container, sel) {
  const found = select(container, sel, true);
  return found.length ? found[0] : null;
}

// `el.matches(sel)` — `:scope` the element itself (the context object). A non-element matches nothing.
export function matchesSelector(el, sel) {
  if (!el || nodeTypeOf(el) !== NODE_ELEMENT) return false;
  sel = selectorString(sel);
  const nid = nidOf(el);
  const hit = arenaOf(nid).dom.matchesId(nid, sel, documentNidOf(el), true);
  if (hit === null) throw invalidSelector(sel);
  return hit;
}
// `el.closest(sel)`: the nearest inclusive ancestor element matching, `:scope` the element itself.
export function closestSelector(el, sel) {
  sel = selectorString(sel);
  const nid = nidOf(el);
  const hit = arenaOf(nid).dom.closest(nid, sel, documentNidOf(el));
  if (hit === false) throw invalidSelector(sel);
  return hit === -1 ? null : hit;
}
