// A node's HANDLE, what Ruby names it by: its arena slot — the isolate's, so it names it apart from every other realm's
// nodes too — plus one, 0 being Ruby's "none". The engine hands the node back by it (`nodeOf`) for as long as the slot
// is the node's: a handle to a node V8 collected names nothing, never the node its slot went to next (its generation),
// and whether the node is still in the document is Ruby's to ask (`__csimAlive`). An Attr, which has no slot, has none.
// A realm answers for its own nodes only — the ones of the trees it holds (`realmOf`, which adoption moves): Ruby asks
// each realm for the nodes it found there, and a frame's form is no node of its parent's.
export function handleOf(n) {
  return n != null && n._nid >= 0 ? n._nid + 1 : 0;
}
export function lookup(h) {
  if (typeof h !== 'number' || !(h > 0)) return null;
  const d = globalThis.__dom;
  return d.realmOf(h - 1) === d.realmId ? d.nodeOf(h - 1) : null;
}

// What the bindings do of the removing steps (dom-nodes.js sets it — a setter, as handles.js imports no node module): the
// style state moved where the engine's steps changed an element's (`removingSteps`: a popover hidden, a dialog modal no
// more, the focused or hovered element gone with the subtree).
let removingSteps = null;
export function setRemovingSteps(fn) { removingSteps = fn; }

// A subtree taken out of its parent outside the DOM's mutation algorithms — a declarative shadow root's template, a
// document's children as it is opened or parsed again — whose steps are the engine's within them (mutation.rs
// `removing_steps`): the browsing contexts in it discarded — their unload runs script, which may take more out — then the
// removing steps, the engine's (dialogs.rs `removingSteps`) but for what the bindings do of them. The engine names the
// frames (`leavingElements`).
export function subtreeRemoved(node) {
  if (!node || !(node._nid >= 0)) return;
  const frames = globalThis.__dom.leavingElements(node._nid, 1);
  if (frames !== undefined) for (const el of frames) discardBrowsingContext(el);
  if (globalThis.__dom.removingSteps(node._nid) && removingSteps) removingSteps();
}
// The realm the active document of a frame container's navigable is in (navigables.rs), or null — none yet, or no
// container.
export function frameRealmOf(el) {
  const realm = globalThis.__dom.frameRealm(el._nid);
  return realm < 0 ? null : realm;
}
export function discardBrowsingContext(node) {
  // A nested browsing context disconnected from the DOM is discarded — real
  // browsers halt a detached frame's event loop. Drop its realm from the parent's
  // step set and dispose the V8 realm so `drainChildRealms` stops stepping a dead
  // frame (whose self-rescheduling timer would otherwise keep the page non-idle).
  // A re-inserted frame rebuilds its realm lazily on the next contentWindow read.
  const rid = frameRealmOf(node);
  globalThis.__dom.discardNavigable(node._nid);
  if (rid != null) {
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
        w.__dom.childRealms().forEach(fireUnloadTree);
      } catch (_) {}
    };
    const disposeTree = (id) => {
      try {
        const w = NS.contextGlobal(id);
        if (w) w.__dom.childRealms().forEach(disposeTree);
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
