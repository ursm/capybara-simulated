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

// Indexed loops, NOT `for...of`: `_children` is a `NodeList extends
// Array` and iterating an Array subclass allocates an iterator per
// node (see walk()). These recurse over the whole inserted/removed
// subtree on every appendChild / insertBefore / removeChild, so the
// allocation shows up on the mutation hot path.
export function registerNode(n) {
  handles.set(n._id, n);
  const ch = n._children;
  if (ch) for (let i = 0; i < ch.length; i++) registerNode(ch[i]);
}

export function registerSubtree(node) {
  if (!node) return;
  handles.set(node._id, node);
  const ch = node._children;
  if (ch) for (let i = 0; i < ch.length; i++) registerSubtree(ch[i]);
}

export function unregisterSubtree(node) {
  if (!node) return;
  handles.delete(node._id);
  const ch = node._children;
  if (ch) for (let i = 0; i < ch.length; i++) unregisterSubtree(ch[i]);
}
