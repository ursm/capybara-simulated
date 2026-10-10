// The tree's edges — a node's parent, a parent's children — written in ONE place. They are the engine's alone (the
// arena's; Node's `_parent` and `_children` read them), and every module that links or unlinks a node goes through
// these. What a mutation MEANS — the mutation records, slots, adoption — stays with the callers; these change the edges
// and run the live ranges' insert and remove steps (DOM §4.2.3-4, ranges.rs) and the NodeIterators' pre-removing steps
// (DOM §6.1) with each, whatever path made it.

import {
  arenaInsert, arenaRemove, syncArenaChildList, clearArenaChildList, childAtOf, childCountOf, childNodesOf
} from './native-query-shadow.js';

// Past this many nodes at once, the arena's list is written whole (one crossing) rather than node by node — when they
// are most of it: a long list resent for every fragment appended to it costs more than the nodes' own crossings.
const RELIST_AT = 16;
function relists(count, length) { return count > RELIST_AT && count * 2 >= length; }

// The live ranges' steps: `count` nodes inserted into `parent` at `index` (an append moves no boundary: none is past the
// end); `child`, at `index` in `parent`, about to be removed; every child of `parent` about to be.
function rangesInsert(parent, index, count) {
  globalThis.__dom.rangesInsert(parent._nid, index, count);
}
function rangesRemove(parent, child, index) {
  globalThis.__dom.rangesRemove(parent._nid, parent, child._nid, index);
}
function rangesRemoveAll(parent) {
  globalThis.__dom.rangesRemoveAll(parent._nid, parent);
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
// alike: the arena's removal answers them, and a cleared parent's children are asked for at once.
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
  arenaInsert(parent, child, null);
}

// `child` the child of `parent` at `index` — the last one where `index` is past the end or negative.
export function insertEdge(parent, child, index) {
  edgeGen++;
  const ref = index < 0 ? null : childAtOf(parent, index);
  arenaInsert(parent, child, ref);
  if (ref !== null) rangesInsert(parent, index, 1);
}

// `nodes` the children of `parent` from `index` on, in order — appended where `index` is past the end or negative.
export function insertEdges(parent, nodes, index) {
  edgeGen++;
  const ref = index < 0 ? null : childAtOf(parent, index);
  if (relists(nodes.length, childCountOf(parent, false) + nodes.length)) {
    const kids = childNodesOf(parent);
    if (ref === null) kids.push(...nodes);
    else kids.splice(index, 0, ...nodes);
    syncArenaChildList(parent, kids);
  } else {
    for (let i = 0; i < nodes.length; i++) arenaInsert(parent, nodes[i], ref);
  }
  if (ref !== null) rangesInsert(parent, index, nodes.length);
}

// The child of `parent` at `index` unlinked; the child.
export function removeEdgeAt(parent, index) {
  edgeGen++;
  const child = childAtOf(parent, index);
  preRemove(child);
  rangesRemove(parent, child, index);
  const given = arenaRemove(child);
  if (given !== undefined && transients) transients(given);
  return child;
}

// `child`'s index in `parent`'s children, or -1 — the engine's, which keeps each child's position (a fast call).
export function childIndexOf(parent, child) {
  return globalThis.__dom.childIndex(parent._nid, child._nid);
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
  }
  const given = arenaRemove(child);
  if (given !== undefined && transients) transients(given);
  return index;
}

// Every child of `parent` unlinked; the children, in order.
export function clearEdges(parent) {
  const kids = childNodesOf(parent);
  if (kids.length === 0) return kids;
  edgeGen++;
  if (iterators) iterators.preRemoveAll(parent);
  rangesRemoveAll(parent);
  const given = transients ? globalThis.__dom.moAddTransientsOfChildren(parent._nid) : undefined;
  clearArenaChildList(parent);
  if (given !== undefined) transients(given);
  return kids;
}
