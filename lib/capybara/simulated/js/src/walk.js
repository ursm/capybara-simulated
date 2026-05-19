import { NODE_ELEMENT } from './constants.js';

// Depth-first walk of `node`'s subtree. Calls `fn(el)` for every
// Element-typed descendant (skipping text / comment / fragment-root
// nodes). Descends through non-element nodes so a Document or
// ShadowRoot root still surfaces its element descendants.
export function walk(node, fn) {
  if (!node) return;
  if (node.nodeType === NODE_ELEMENT) fn(node);
  for (const c of node._children) walk(c, fn);
}
