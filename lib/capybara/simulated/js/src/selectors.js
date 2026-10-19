// querySelector(All) / matches / closest, and a style sheet rule's match: selector.rs — Servo's `selectors` crate over
// the arena, the parser and matcher the style system matches with — answers every selector; one it does not parse is a
// SyntaxError. The arena hands back the nodes it found.

import { NODE_ELEMENT, NODE_DOC } from './constants.js';
import { nodeArena } from './native-query-shadow.js';
import { documentElementOf } from './document-tree.js';
import { DOMException } from './events.js';

// The document a selector is matched in, by its nid (-1 for none): the engine reads its mode — in a quirks-mode
// document a class or id selector matches ASCII case-insensitively (Selectors 4 §6.6 / §6.7), and in an XML one no type
// selector or attribute name folds case (document_state.rs `document_mode`).
function documentNidOf(node) {
  const doc = node && (node._nodeType === NODE_DOC ? node : (node._ownerDoc || globalThis.document));
  return doc ? doc._nid : -1;
}
// The selector argument (a WebIDL DOMString), its NULs U+FFFD as CSS's input preprocessing has them.
function selectorString(sel) {
  if (typeof sel !== 'string') sel = String(sel);
  return sel.indexOf('\x00') === -1 ? sel : sel.replace(/\x00/g, '�');
}
function invalidSelector(sel) {
  return new DOMException("csim: '" + sel + "' is not a valid selector", 'SyntaxError');
}
// The arena `node` is in, for asking it — an Error where none can be had.
function arenaOf(node) {
  const a = nodeArena(node);
  if (!a) throw new Error('[csim] no arena holds the node a selector is matched against');
  return a;
}


// querySelector(All) on `container` (a Document, DocumentFragment or Element): its descendant elements, `:scope` the
// container — a Document's being its root element.
function select(container, sel, firstOnly) {
  sel = selectorString(sel);
  const a = arenaOf(container);
  const scope = container._nodeType === NODE_DOC ? documentElementOf(container) : container;
  const found = a.dom.query(container._nid, sel, documentNidOf(container), firstOnly, scope ? scope._nid : undefined);
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
  if (!el || el._nodeType !== NODE_ELEMENT) return false;
  sel = selectorString(sel);
  const hit = arenaOf(el).dom.matchesId(el._nid, sel, documentNidOf(el), true);
  if (hit === null) throw invalidSelector(sel);
  return hit;
}
// `el.closest(sel)`: the nearest inclusive ancestor element matching, `:scope` the element itself.
export function closestSelector(el, sel) {
  sel = selectorString(sel);
  const hit = arenaOf(el).dom.closest(el._nid, sel, documentNidOf(el));
  if (hit === false) throw invalidSelector(sel);
  return hit === -1 ? null : hit;
}
