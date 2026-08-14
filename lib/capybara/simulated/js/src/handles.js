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
  // A nested browsing context disconnected from the DOM is discarded — real
  // browsers halt a detached frame's event loop. Drop its realm from the parent's
  // step set and dispose the V8 realm so `drainChildRealms` stops stepping a dead
  // frame (whose self-rescheduling timer would otherwise keep the page non-idle).
  // A re-inserted frame rebuilds its realm lazily on the next contentWindow read.
  if (node._frameRealmId != null) {
    const rid = node._frameRealmId;
    node._frameRealmId = null;
    if (globalThis.__csimChildRealmIds) globalThis.__csimChildRealmIds.delete(rid);
    // The document-teardown events (pagehide, then unload) fire IN the dying
    // realm, synchronously, while it still works — MEASURED in Chrome 151
    // (2026-08-14, Playwright probe): `iframe.remove()` fires both, synchronously
    // during the removal, same as navigation-away. The CURRENT HTML spec's
    // "destroy a child navigable" says neither fires on removal, and the vendored
    // insertion-removing-steps-iframe.window.js pins that aspirational behavior —
    // Chrome fails those subtests today, and so do we (allowlisted): per rule 2,
    // observable Chrome behavior wins, and the keepalive WPT family (an unload
    // handler's `fetch(…, {keepalive})` beacon after `iframe.remove()`) depends
    // on it. Self-gated on a handler existing, so plain removals pay a property
    // read.
    // Parent-first over the whole nested tree (measured: removing an iframe with a
    // nested one fires mid-pagehide/unload THEN grandchild-pagehide/unload), and
    // NO beforeunload (Chrome fires it on navigation-away only — the asymmetry vs
    // disposeFrameRealmForNav is deliberate). The recursion also disposes each
    // descendant realm — previously only the direct realm was disposed and
    // grandchild isolates leaked per removal.
    const NS = globalThis.RustyRacer;
    const fireUnloadTree = (id) => {
      try {
        const w = NS && typeof NS.contextGlobal === 'function' ? NS.contextGlobal(id) : null;
        if (!w) return;
        if (typeof w.__csimFireWindowUnload === 'function') w.__csimFireWindowUnload();
        const kids = w.__csimChildRealmIds;
        if (kids && typeof kids.forEach === 'function') Array.from(kids).forEach(fireUnloadTree);
      } catch (_) {}
    };
    const disposeTree = (id) => {
      try {
        const w    = NS && typeof NS.contextGlobal === 'function' ? NS.contextGlobal(id) : null;
        const kids = w && w.__csimChildRealmIds;
        if (kids && typeof kids.forEach === 'function') Array.from(kids).forEach(disposeTree);
      } catch (_) {}
      // A reference still held to the removed frame's Window (`iframe.contentWindow`
      // captured before removal) must stay safe: its detached timers no-op rather
      // than throw once the realm is gone.
      if (globalThis.__csimNeuterDetachedWindow) globalThis.__csimNeuterDetachedWindow(id);
      if (globalThis.__csim_disposeFrameRealm) { try { globalThis.__csim_disposeFrameRealm(id); } catch (_) {} }
    };
    fireUnloadTree(rid);
    disposeTree(rid);
  }
  const ch = node._children;
  if (ch) for (let i = 0; i < ch.length; i++) unregisterSubtree(ch[i]);
}
