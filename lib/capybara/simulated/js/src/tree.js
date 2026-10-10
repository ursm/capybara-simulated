// The tree's edges — a node's parent, a parent's children — written in ONE place. Every module that links or unlinks a
// node goes through these, never through `_parent` / `_children` itself (but for a node's construction, which starts
// it with none): they are what moves to the engine when the tree does (the arena owning the edges, the objects reading
// them), and a write made anywhere else would be one the move cannot see. What a mutation MEANS — the mutation records,
// slots, adoption — stays with the callers; these change the edges, in the JS tree and in the arena's copy of it at once,
// so the copy cannot fall behind — and run the live ranges' insert and remove steps (DOM §4.2.3-4, ranges.rs) and the
// NodeIterators' pre-removing steps (DOM §6.1) with each, whatever path made it.

import { appendTo, spliceList } from './dom-collections.js';
import { arenaInsert, arenaRemove, syncArenaChildList, clearArenaChildList } from './native-query-shadow.js';

// Past this many nodes at once, the arena's list is written whole (one crossing) rather than node by node — when they
// are most of it: a long list resent for every fragment appended to it costs more than the nodes' own crossings.
const RELIST_AT = 16;
function relists(nodes, kids) { return nodes.length > RELIST_AT && nodes.length * 2 >= kids.length; }
const NO_NODES = [];

// The live ranges' steps: `count` nodes inserted into `parent` at `index` (an append moves no boundary: none is past the
// end); `child`, at `index` in `parent`, about to be removed; every child of `parent` about to be.
function rangesInsert(parent, index, count) {
  const d = globalThis.__dom;
  if (d) d.rangesInsert(parent._nid, index, count);
}
function rangesRemove(parent, child, index) {
  const d = globalThis.__dom;
  if (d) d.rangesRemove(parent._nid, parent, child._nid, index);
}
function rangesRemoveAll(parent) {
  const d = globalThis.__dom;
  if (d) d.rangesRemoveAll(parent._nid, parent);
}

// The NodeIterators' steps, which their documents hold (dom-nodes.js sets them): `preRemove(child)`, the pre-removing
// steps for `child`, about to be removed; `preRemoveAll(parent)`, those for every child of `parent`, one after another.
let iterators = null;
export function setIteratorSteps(steps) { iterators = steps; }
function preRemove(child) {
  if (iterators) iterators.preRemove(child);
}

// The mutation observers' step, which mutation-observer.js sets: `transients(observers)`, for the observers the arena gave
// transient registered observers ("add transient registered observers") as it unlinked a node — by a removal or a move
// alike: the arena's removal answers them, and every child of a cleared parent is asked for in turn.
let transients = null;
export function setTransientObserverSteps(steps) { transients = steps; }

// A generation that moves with every edge written here, and with nothing else — what a collection of nodes that only
// the tree decides keys on (`children`, `getElementsByTagName`): an attribute written moves the node generation, which
// a collection that reads attributes keys on, and a loop writing one to each of `children` re-made it at every write.
let edgeGen = 0;
export function currentEdgeGen() { return edgeGen; }

// `child` the last child of `parent`.
export function appendEdge(parent, child) {
  edgeGen++;
  child._parent = parent;
  appendTo(parent._children, child);
  arenaInsert(parent, child, null);
}

// `child` the child of `parent` at `index` — the last one where `index` is past the end or negative.
export function insertEdge(parent, child, index) {
  edgeGen++;
  child._parent = parent;
  const kids = parent._children;
  if (index < 0 || index >= kids.length) {
    appendTo(kids, child);
    arenaInsert(parent, child, null);
  } else {
    const ref = kids[index];
    spliceList(kids, index, 0, [child]);
    arenaInsert(parent, child, ref);
    rangesInsert(parent, index, 1);
  }
}

// `nodes` the children of `parent` from `index` on, in order — appended where `index` is past the end or negative.
export function insertEdges(parent, nodes, index) {
  edgeGen++;
  const kids = parent._children;
  for (let i = 0; i < nodes.length; i++) nodes[i]._parent = parent;
  const ref = index < 0 || index >= kids.length ? null : kids[index];
  if (ref === null) for (let i = 0; i < nodes.length; i++) appendTo(kids, nodes[i]);
  else spliceList(kids, index, 0, nodes);
  if (relists(nodes, kids)) syncArenaChildList(parent);
  else for (let i = 0; i < nodes.length; i++) arenaInsert(parent, nodes[i], ref);
  if (ref !== null) rangesInsert(parent, index, nodes.length);
}

// The child of `parent` at `index` unlinked; the child.
export function removeEdgeAt(parent, index) {
  edgeGen++;
  const child = parent._children[index];
  preRemove(child);
  rangesRemove(parent, child, index);
  spliceList(parent._children, index, 1, NO_NODES);
  child._parent = null;
  const given = arenaRemove(child);
  if (given !== undefined && transients) transients(given);
  return child;
}

// `child`'s index in `parent`'s children, or -1 — the last one tried first, so the ends of the list (appending after
// it, removing it, removing the first) are O(1).
export function childIndexOf(parent, child) {
  const kids = parent._children, last = kids.length - 1;
  return last >= 0 && kids[last] === child ? last : kids.indexOf(child);
}

// `child` unlinked from its parent, where it has one; its index there, or -1.
export function removeEdge(child) {
  const parent = child._parent;
  if (!parent) return -1;
  edgeGen++;
  const index = childIndexOf(parent, child);
  if (index >= 0) {
    preRemove(child);
    rangesRemove(parent, child, index);
    spliceList(parent._children, index, 1, NO_NODES);
  }
  child._parent = null;
  const given = arenaRemove(child);
  if (given !== undefined && transients) transients(given);
  return index;
}

// Every child of `parent` unlinked; the children, in order (a copy: the list is the parent's own, `childNodes`, which
// stays the same live list).
export function clearEdges(parent) {
  const kids = parent._children.slice();
  if (kids.length === 0) return kids;
  edgeGen++;
  if (iterators) iterators.preRemoveAll(parent);
  rangesRemoveAll(parent);
  for (let i = 0; i < kids.length; i++) kids[i]._parent = null;
  parent._children.length = 0;
  clearArenaChildList(parent);
  if (transients) {
    const d = globalThis.__dom;
    for (let i = 0; i < kids.length; i++) {
      const given = d.moAddTransients(kids[i]._nid, parent._nid);
      if (given !== undefined) transients(given);
    }
  }
  return kids;
}

// A shadow root's edge to its host (its `_parent`, which the shadow-including walks climb; the arena's own link is
// `arenaAttachShadow`'s).
export function hostEdge(root, host) {
  root._parent = host;
}
