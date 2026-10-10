// Handle ↔ Node registry. Every Node carries an integer `_id`;
// Capybara-driven host fns receive the handle from Ruby and dereference
// it through `lookup(h)` to recover the live Node. Document + the
// initial html/head/body skeleton register as the realm is made
// (`__csimInitRealm`) so `find_xpath` / `__csimVisible` lookups can
// resolve skeleton nodes.
// Subsequent inserts (appendChild / insertBefore / replaceChild /
// innerHTML setter) route through `registerSubtree` so the registry
// stays in sync; removeChild routes through `unregisterSubtree` so
// stale handles invalidate.

import { relativeOf, subtreeNodesOf, RELATIVE_SHADOW_INCLUDING_ROOT } from './native-query-shadow.js';

export const handles = new Map();

export function lookup(h) { return handles.get(h) || null; }

// These cover the whole inserted/removed subtree on every appendChild / insertBefore / removeChild, the mutation hot
// path — shadow-including (Ruby reaches into a shadow tree too), the engine naming its nodes in one call.
export function registerNode(n) {
  const nodes = subtreeNodesOf(n);
  for (let i = 0; i < nodes.length; i++) register(nodes[i]);
}

// A node's handle: its id, which names it apart from every other realm's nodes too (dom-nodes.js `Node`), so one adopted
// from a frame's document is registered under its own.
export function register(n) {
  handles.set(n._id, n);
}

// …only once it is in a document: a handle is what Ruby names a node by, and a strong one would keep a subtree a script
// builds detached, and drops, alive for as long as the page (Ruby is handed a detached node through `host-queries.js`,
// which registers it then). A detached subtree is registered whole when it is inserted into the document.
export function registerSubtree(node) {
  if (node && inDocument(node)) registerNode(node);
}
// The nodes an unregistration takes out of a document, whose element states the engine reads (`__dom.statedNodes`).
let releasing = null;

// Whether `node` is in a document with a browsing context — its shadow-including root's, the engine's. (An inert
// document — a DOMParser's, `createHTMLDocument`'s — is no page Ruby reaches into, and a sanitizer makes one a call:
// registered, its nodes were kept for the page's life.)
function inDocument(node) {
  const root = relativeOf(node, RELATIVE_SHADOW_INCLUDING_ROOT) ?? node;
  return root._nodeType === 9 && !root._noBrowsingContext;
}

// The element removing steps that change state (dom-nodes.js sets it — a setter, as handles.js imports no node module): run for
// each element of the subtree a state is on, which the engine names (`statedNodes`); and the document's own,
// for each subtree that leaves it — its focus and hover, where they were in it — whichever way it left (a removal, a
// replacement, `innerHTML`).
let removingSteps = null, subtreeLeftSteps = null;
export function setRemovingSteps(fn, left) { removingSteps = fn; subtreeLeftSteps = left; }

// A subtree leaving the document, shadow-including — its handles (a shadow root's left behind would hold its host, and
// the host its whole subtree, alive), the removing steps and the browsing contexts in it.
export function unregisterSubtree(node) {
  if (!node) return;
  // (…one hand-over for the whole subtree: the removing steps it runs — a frame's unload — may unregister more)
  if (releasing !== null) {
    unregisterNode(node);
    if (subtreeLeftSteps) subtreeLeftSteps(node);
    return;
  }
  const nodes = releasing = [];
  try {
    unregisterNode(node);
  } finally {
    releasing = null;
    const stated = globalThis.__dom.statedNodes(nodes);
    if (stated !== undefined && removingSteps) for (const el of stated) removingSteps(el);
    if (subtreeLeftSteps) subtreeLeftSteps(node);
  }
}
function unregisterNode(root) {
  const nodes = subtreeNodesOf(root);
  for (let i = 0; i < nodes.length; i++) releaseNode(nodes[i]);
}
function releaseNode(node) {
  handles.delete(node._id);
  releasing[releasing.length] = node;
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
        const w = NS.contextGlobal(id);
        if (!w) return;
        if (typeof w.__csimFireWindowUnload === 'function') w.__csimFireWindowUnload();
        // (…and its connections made to disappear, as a frame navigated away does: dom-nodes.js disposeFrameRealmForNav)
        if (typeof w.__csimDropWebSockets === 'function') w.__csimDropWebSockets();
        if (typeof w.__csimDropEventSources === 'function') w.__csimDropEventSources();
        const kids = w.__csimChildRealmIds;
        if (kids && typeof kids.forEach === 'function') Array.from(kids).forEach(fireUnloadTree);
      } catch (_) {}
    };
    const disposeTree = (id) => {
      try {
        const w    = NS.contextGlobal(id);
        const kids = w && w.__csimChildRealmIds;
        if (kids && typeof kids.forEach === 'function') Array.from(kids).forEach(disposeTree);
      } catch (_) {}
      // A reference still held to the removed frame's Window (`iframe.contentWindow`
      // captured before removal) must stay safe: its detached timers no-op rather
      // than throw once the realm is gone.
      if (globalThis.__csimNeuterDetachedWindow) globalThis.__csimNeuterDetachedWindow(id, true);
      if (globalThis.__csim_disposeFrameRealm) { try { globalThis.__csim_disposeFrameRealm(id); } catch (_) {} }
    };
    fireUnloadTree(rid);
    disposeTree(rid);
  }
}
