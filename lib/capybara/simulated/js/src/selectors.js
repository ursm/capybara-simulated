// querySelector(All) / matches / closest, and a style sheet rule's match: selector.rs — Servo's `selectors` crate over
// the arena, the parser and matcher the style system matches with — answers every selector; one it does not parse is a
// SyntaxError. The arena hands back ids, which are mapped onto the JS tree here.

import { NODE_ELEMENT, NODE_DOC } from './constants.js';
import { isHtmlDocument } from './mime.js';
import { nodeArena, syncArenaSubtree } from './native-query-shadow.js';

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

// The elements of `container`'s subtree whose arena ids `ids` lists, in the document order native returned them in —
// a preorder walk that keeps one (list, index) frame per level rather than every sibling, so an early hit costs its
// depth. `undefined` where an id is not in the JS tree: the arena is out of step with it.
function elementsOfIds(container, ids) {
  const out = [];
  if (ids.length === 0) return out;
  const lists = [container._children], at = [0];
  while (lists.length) {
    const top = lists.length - 1, list = lists[top], i = at[top];
    if (i === list.length) { lists.pop(); at.pop(); continue; }
    at[top] = i + 1;
    const node = list[i];
    if (node.nodeType !== NODE_ELEMENT) continue;
    if (node._nid === ids[out.length]) {
      out.push(node);
      if (out.length === ids.length) return out;
    }
    if (node._children.length) { lists.push(node._children); at.push(0); }
  }
  return undefined;
}
// A tree whose arena copy disagreed with it, made to agree — the one retry a mismatch gets before it is an error.
function resync(node) {
  let root = node;
  while (root._parent) root = root._parent;
  syncArenaSubtree(root);
}

// querySelector(All) on `container` (a Document, DocumentFragment or Element): its descendant elements, `:scope` the
// container — a Document's being its root element.
function select(container, sel, firstOnly) {
  sel = selectorString(sel);
  const mode = modeOf(container);
  for (let attempt = 0; ; attempt++) {
    const a = arenaOf(container);
    const scope = container.nodeType === NODE_DOC ? container.documentElement : container;
    const ids = a.dom.queryIds(
      container._nid,
      sel,
      (mode & MODE_QUIRKS) !== 0,
      firstOnly,
      scope ? scope._nid : undefined,
      (mode & MODE_XML) !== 0
    );
    if (ids === null) throw invalidSelector(sel);
    const found = elementsOfIds(container, ids);
    if (found !== undefined) return found;
    if (attempt > 0) throw new Error('[csim] the arena is out of step with the tree a selector is matched against');
    resync(container);
  }
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
  for (let attempt = 0; ; attempt++) {
    const hit = arenaOf(el).dom.closestId(el._nid, sel, (mode & MODE_QUIRKS) !== 0, (mode & MODE_XML) !== 0);
    if (hit === null) throw invalidSelector(sel);
    if (hit === -1) return null;
    for (let cur = el; cur; cur = cur._parent) if (cur._nid === hit) return cur;
    if (attempt > 0) throw new Error('[csim] the arena is out of step with the tree a selector is matched against');
    resync(el);
  }
}
