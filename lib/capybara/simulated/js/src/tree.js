// The tree's edges — a node's parent, a parent's children — written in ONE place. They are the engine's alone (the
// arena's; Node's `_parent` and `_children` read them), and every module that links or unlinks a node goes through
// these. What a mutation MEANS — the mutation records, slots, adoption — stays with the callers; these change the edges,
// and the engine runs the live ranges' insert and remove steps (DOM §4.2.3-4, ranges.rs) and the NodeIterators'
// pre-removing steps (DOM §6.1, node_iterators.rs) with each, whatever path made it.

import { arenaInsert, arenaInsertAll, arenaRemove, arenaRemoveAll, childAtOf, childCountOf } from './native-query-shadow.js';

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
  arenaInsert(parent, child, index < 0 ? null : childAtOf(parent, index));
}

// `nodes` the children of `parent` from `index` on, in order — appended where `index` is past the end or negative.
// (…a few — a clone's children, mostly — one at a time, where handing them over at once costs more than it saves)
const AT_ONCE = 8;
export function insertEdges(parent, nodes, index) {
  if (nodes.length === 0) return;
  edgeGen++;
  const ref = index < 0 ? null : childAtOf(parent, index);
  if (nodes.length > AT_ONCE) arenaInsertAll(parent, nodes, ref);
  else for (let i = 0; i < nodes.length; i++) arenaInsert(parent, nodes[i], ref);
}

// The child of `parent` at `index` unlinked; the child.
export function removeEdgeAt(parent, index) {
  edgeGen++;
  const child = childAtOf(parent, index);
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
  const given = arenaRemove(child);
  if (given !== undefined && transients) transients(given);
  return index;
}

// Every child of `parent` unlinked; the children, in order.
export function clearEdges(parent) {
  if (childCountOf(parent, false) === 0) return [];
  edgeGen++;
  const answer = arenaRemoveAll(parent);
  if (answer === undefined) return [];
  if (answer[1] !== undefined && transients) transients(answer[1]);
  return answer[0];
}
