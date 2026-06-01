// Handle ↔ Node registry. Every Node carries an integer `_id`;
// Capybara-driven host fns receive the handle from Ruby and dereference
// it through `lookup(h)` to recover the live Node. Document + the
// initial html/head/body skeleton register at bridge boot so xpathway
// / `find_xpath` / `__csimVisible` lookups can resolve skeleton nodes.
// Subsequent inserts (appendChild / insertBefore / replaceChild /
// innerHTML setter) route through `registerSubtree` so the registry
// stays in sync; removeChild routes through `unregisterSubtree` so
// stale handles invalidate.

export const handles = new Map();

export function lookup(h) { return handles.get(h) || null; }

export function registerNode(n) {
  handles.set(n._id, n);
  if (n._children) for (const c of n._children) registerNode(c);
}

export function registerSubtree(node) {
  if (!node) return;
  handles.set(node._id, node);
  if (node._children) for (const c of node._children) registerSubtree(c);
}

export function unregisterSubtree(node) {
  if (!node) return;
  handles.delete(node._id);
  if (node._children) for (const c of node._children) unregisterSubtree(c);
}
