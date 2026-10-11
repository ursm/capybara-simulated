// The tree's edges — a node's parent, a parent's children — written in ONE place. They are the engine's alone (the
// arena's; Node's `_parent` and `_children` read them), and every module that links or unlinks a node goes through
// these. What a mutation MEANS — the mutation records, adoption — stays with the callers; these change the edges, and
// the engine runs the live ranges' insert and remove steps (DOM §4.2.3-4, ranges.rs), the NodeIterators' pre-removing
// steps (DOM §6.1, node_iterators.rs), the mutation observers' transient registrations and the slot steps (dom.rs
// `slot_steps`) with each, whatever path made it.

import { arenaInsert, arenaInsertAll, arenaRemove, arenaRemoveAll, arenaRemoveChild, childAtOf, childCountOf } from './native-query-shadow.js';

// The step after every edge write, which mutation-observer.js sets: the agent's mutation observer microtask queued where
// the write made something pending — an observer given a transient registration, a slot signaled — which the engine
// says in the flags the bindings share (a read, no call).
let written = () => {};
export function setEdgeWrittenSteps(steps) { written = steps; }

// A generation that moves with every edge written here, and with nothing else — what a collection of nodes that only
// the tree decides keys on (`children`, `getElementsByTagName`): an attribute written moves the node generation, which
// a collection that reads attributes keys on, and a loop writing one to each of `children` re-made it at every write.
let edgeGen = 0;
export function currentEdgeGen() { return edgeGen; }

// `child` the last child of `parent`.
export function appendEdge(parent, child) {
  edgeGen++;
  arenaInsert(parent, child, null);
  written();
}

// `child` the child of `parent` at `index` — the last one where `index` is past the end or negative.
export function insertEdge(parent, child, index) {
  edgeGen++;
  arenaInsert(parent, child, index < 0 ? null : childAtOf(parent, index));
  written();
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
  written();
}

// The child of `parent` at `index` unlinked; the child.
export function removeEdgeAt(parent, index) {
  edgeGen++;
  const child = childAtOf(parent, index);
  arenaRemove(child);
  written();
  return child;
}

// DOM "remove" of `child` from `parent`, the engine's: `[previousSibling, nextSibling, wasConnected]` — the siblings it
// had and whether `parent` was connected — or undefined where it is no child of `parent`.
export function removeChildEdge(parent, child) {
  const answer = child._nid >= 0 ? arenaRemoveChild(parent, child) : undefined;
  if (answer === undefined) return undefined;
  edgeGen++;
  written();
  return answer;
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
  arenaRemove(child);
  written();
  return index;
}

// Every child of `parent` unlinked; the children, in order.
export function clearEdges(parent) {
  if (childCountOf(parent, false) === 0) return [];
  edgeGen++;
  const children = arenaRemoveAll(parent);
  written();
  return children ?? [];
}
