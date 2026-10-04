// The tree's edges — a node's parent, a parent's children — written in ONE place. Every module that links or unlinks a
// node goes through these, never through `_parent` / `_children` itself (but for a node's construction, which starts
// it with none): they are what moves to the engine when the tree does (the arena owning the edges, the objects reading
// them), and a write made anywhere else would be one the move cannot see. What a mutation MEANS — the mutation records,
// ranges, slots, adoption — stays with the callers; these change the edges, in the JS tree and in the arena's copy of it
// at once, so the copy cannot fall behind.

import { appendTo } from './dom-collections.js';
import { arenaInsert, arenaRemove, syncArenaChildList } from './native-query-shadow.js';

// Past this many nodes at once, the arena's list is written whole (one crossing) rather than node by node.
const RELIST_AT = 16;

// `child` the last child of `parent`.
export function appendEdge(parent, child) {
  child._parent = parent;
  appendTo(parent._children, child);
  arenaInsert(parent, child, null);
}

// `child` the child of `parent` at `index` — the last one where `index` is past the end or negative.
export function insertEdge(parent, child, index) {
  child._parent = parent;
  const kids = parent._children;
  if (index < 0 || index >= kids.length) {
    appendTo(kids, child);
    arenaInsert(parent, child, null);
  } else {
    const ref = kids[index];
    kids.splice(index, 0, child);
    arenaInsert(parent, child, ref);
  }
}

// `nodes` the children of `parent` from `index` on, in order — appended where `index` is past the end or negative.
export function insertEdges(parent, nodes, index) {
  const kids = parent._children;
  for (let i = 0; i < nodes.length; i++) nodes[i]._parent = parent;
  const ref = index < 0 || index >= kids.length ? null : kids[index];
  if (ref === null) for (let i = 0; i < nodes.length; i++) appendTo(kids, nodes[i]);
  else kids.splice(index, 0, ...nodes);
  if (nodes.length > RELIST_AT) syncArenaChildList(parent);
  else for (let i = 0; i < nodes.length; i++) arenaInsert(parent, nodes[i], ref);
}

// The child of `parent` at `index` replaced by `nodes`, in order; the child it was, unlinked.
export function replaceEdgeAt(parent, index, nodes) {
  const old = parent._children[index];
  const ref = parent._children[index + 1] || null;
  for (let i = 0; i < nodes.length; i++) nodes[i]._parent = parent;
  parent._children.splice(index, 1, ...nodes);
  old._parent = null;
  arenaRemove(old);
  if (nodes.length > RELIST_AT) syncArenaChildList(parent);
  else for (let i = 0; i < nodes.length; i++) arenaInsert(parent, nodes[i], ref);
  return old;
}

// The child of `parent` at `index` unlinked; the child.
export function removeEdgeAt(parent, index) {
  const child = parent._children[index];
  parent._children.splice(index, 1);
  child._parent = null;
  arenaRemove(child);
  return child;
}

// `child` unlinked from its parent, where it has one; its index there, or -1.
export function removeEdge(child) {
  const parent = child._parent;
  if (!parent) return -1;
  const index = parent._children.indexOf(child);
  if (index >= 0) parent._children.splice(index, 1);
  child._parent = null;
  arenaRemove(child);
  return index;
}

// Every child of `parent` unlinked; the children, in order (a copy: the list is the parent's own, `childNodes`, which
// stays the same live list).
export function clearEdges(parent) {
  const kids = parent._children.slice();
  if (kids.length === 0) return kids;
  for (let i = 0; i < kids.length; i++) kids[i]._parent = null;
  parent._children.length = 0;
  syncArenaChildList(parent);
  return kids;
}

// A shadow root's edge to its host (its `_parent`, which the shadow-including walks climb; the arena's own link is
// `arenaAttachShadow`'s).
export function hostEdge(root, host) {
  root._parent = host;
}
