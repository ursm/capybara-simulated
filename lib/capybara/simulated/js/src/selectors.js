// querySelector(All) / matches / closest, and a style sheet rule's match: selector.rs — Servo's `selectors` crate over
// the arena, the parser and matcher the style system matches with — answers every selector; one it does not parse is a
// SyntaxError. The arena hands back the nodes it found. Each op is handed the node itself, and reads from it what it
// matches by — its slot, the realm whose tree it is in, and its document's mode: in a quirks-mode document a class or id
// selector matches ASCII case-insensitively (Selectors 4 §6.6 / §6.7), and in an XML one no type selector or attribute
// name folds case (document_state.rs `document_mode`) — in the one call.

import { NODE_DOC } from './constants.js';
import { documentElementOf } from './document-tree.js';
import { DOMException } from './dom-exception.js';
import { nodeArgOf, nodeTypeOf } from './node-identity.js';
// The selector argument (a WebIDL DOMString), its NULs U+FFFD as CSS's input preprocessing has them.
function selectorString(sel) {
  if (typeof sel !== 'string') sel = String(sel);
  return sel.indexOf('\x00') === -1 ? sel : sel.replace(/\x00/g, '�');
}
function invalidSelector(sel) {
  return new DOMException("csim: '" + sel + "' is not a valid selector", 'SyntaxError');
}
// (…an Error where no live realm's tree holds the node)
const noArena = () => new Error('[csim] no arena holds the node a selector is matched against');


// querySelector(All) on `container` (a Document, DocumentFragment or Element): its descendant elements, `:scope` the
// container — a Document's being its root element.
function select(container, sel, firstOnly) {
  sel = selectorString(sel);
  const scope = nodeTypeOf(container) === NODE_DOC ? documentElementOf(container) : container;
  const found = globalThis.__dom.query(nodeArgOf(container), sel, firstOnly, scope);
  if (found === null) throw invalidSelector(sel);
  if (found === undefined) throw noArena();
  return found;
}
export function selectAll(container, sel) {
  return select(container, sel, false);
}
export function selectFirst(container, sel) {
  const found = select(container, sel, true);
  return found.length ? found[0] : null;
}

// `el.matches(sel)` — `:scope` the element itself (the context object). A non-element matches nothing, nor does a node
// no live realm's tree holds.
export function matchesSelector(el, sel) {
  sel = selectorString(sel);
  const hit = globalThis.__dom.matches(el, sel);
  if (hit === null) throw invalidSelector(sel);
  return hit === true;
}
// `el.closest(sel)`: the nearest inclusive ancestor element matching, `:scope` the element itself.
export function closestSelector(el, sel) {
  sel = selectorString(sel);
  const hit = globalThis.__dom.closest(el, sel);
  if (hit === false) throw invalidSelector(sel);
  if (hit === undefined) throw noArena();
  return hit === -1 ? null : hit;
}
