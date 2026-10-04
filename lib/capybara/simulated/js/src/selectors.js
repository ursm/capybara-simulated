// querySelector(All) / matches / closest, and a style sheet rule's match: selector.rs — Servo's `selectors` crate over
// the arena, the parser and matcher the style system matches with — answers every selector; one it does not parse is a
// SyntaxError. The arena hands back where in the tree the nodes it found are (their paths).

import { NODE_ELEMENT, NODE_DOC } from './constants.js';
import { isHtmlDocument } from './mime.js';
import { nodeArena, nodesAtPaths } from './native-query-shadow.js';

// The document mode a selector is matched in: in a quirks-mode document a class or id selector matches ASCII
// case-insensitively (Selectors 4 §6.6 / §6.7), and in an XML one no type selector or attribute name folds case.
const MODE_QUIRKS = 1, MODE_XML = 2;
function modeOf(node) {
  const doc = node && (node.nodeType === NODE_DOC ? node : (node._ownerDoc || globalThis.document));
  if (!doc) return 0;
  return (doc._quirks ? MODE_QUIRKS : 0) | (isHtmlDocument(doc) ? 0 : MODE_XML);
}
// The selector argument (a WebIDL DOMString), its NULs U+FFFD as CSS's input preprocessing has them.
function selectorString(sel) {
  if (typeof sel !== 'string') sel = String(sel);
  return sel.indexOf('\x00') === -1 ? sel : sel.replace(/\x00/g, '�');
}
function invalidSelector(sel) {
  return new globalThis.DOMException("csim: '" + sel + "' is not a valid selector", 'SyntaxError');
}
// The arena `node` is in, for asking it — an Error where none can be had (before `__dom`, which no page script runs).
function arenaOf(node) {
  const a = nodeArena(node);
  if (!a) throw new Error('[csim] no arena holds the node a selector is matched against');
  return a;
}


// querySelector(All) on `container` (a Document, DocumentFragment or Element): its descendant elements, `:scope` the
// container — a Document's being its root element.
function select(container, sel, firstOnly) {
  sel = selectorString(sel);
  const mode = modeOf(container);
  const a = arenaOf(container);
  const scope = container.nodeType === NODE_DOC ? container.documentElement : container;
  const paths = a.dom.query(
    container._nid,
    sel,
    (mode & MODE_QUIRKS) !== 0,
    firstOnly,
    scope ? scope._nid : undefined,
    (mode & MODE_XML) !== 0
  );
  if (paths === null) throw invalidSelector(sel);
  return nodesAtPaths(container, paths);
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
  if (!el || el.nodeType !== NODE_ELEMENT) return false;
  sel = selectorString(sel);
  const mode = modeOf(el);
  const hit = arenaOf(el).dom.matchesId(el._nid, sel, (mode & MODE_QUIRKS) !== 0, true, (mode & MODE_XML) !== 0);
  if (hit === null) throw invalidSelector(sel);
  return hit;
}
// `el.closest(sel)`: the nearest inclusive ancestor element matching, `:scope` the element itself.
export function closestSelector(el, sel) {
  sel = selectorString(sel);
  const mode = modeOf(el);
  const hit = arenaOf(el).dom.closestId(el._nid, sel, (mode & MODE_QUIRKS) !== 0, (mode & MODE_XML) !== 0);
  if (hit === null) throw invalidSelector(sel);
  if (hit !== -1) for (let cur = el; cur; cur = cur._parent) if (cur._nid === hit) return cur;
  return null;
}
