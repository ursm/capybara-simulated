// The native (Rust/Servo) arena for the DOM-in-Rust store migration: it MIRRORS the JS DOM so the
// native matcher can read it. This file owns the arena's lifecycle — build it once (`ensureBuilt`,
// mirroring the parsed document) and keep it current with per-mutation DELTAS (the mutation
// chokepoints call the sync hooks below: syncChildren / syncAttrs). It replaced the earlier
// rebuild-on-dirty model (350ms over 450 rebuilds on Redmine — untenable).
//
// TWO consumers read the arena, with DIFFERENT correctness models:
//   1. AUTHORITATIVE cascade matching (cascade.js, ON BY DEFAULT — imports `ensureBuilt` here): the
//      native matcher IS the answer for the rules it can compile, so the arena MUST be correct. This
//      is a live-correctness surface, not measurement — a stale arena would be a wrong style. The
//      main-realm-only invariant (below) and the parse/navigation gates in `ensureBuilt` are what
//      keep it correct.
//   2. SHADOW measurement (`globalThis.__csimNativeShadow`, opt-in, off by default): `shadowQuery`
//      runs native ALONGSIDE css-select on the `__csimQuery` find path — css stays authoritative
//      there, native only TIMED + PARITY-CHECKED. buildNs / syncNs track the upkeep cost apart.
//
// V8 only (a no-op on QuickJS, where `__dom` is absent). When neither consumer is active `built`
// never flips true, so every sync hook returns on its first (boolean) check.
//
// MAIN-REALM ONLY: `built` / `nidToNode` / `docRootNid` are per-realm module state but the `Dom`
// arena is ISOLATE-global, so only ONE realm may own it. Both consumers are seeded on the main
// context alone (v8_runtime.rb), so no frame realm builds/queries/syncs it. Partitioning the arena
// per realm is the prerequisite before native matching can run in frame realms.

import { NODE_ELEMENT, NODE_TEXT, NODE_CDATA, NODE_DOC, HTML_NS } from './constants.js';

const stats = {
  calls:       0,   // finds observed
  cssNs:       0,   // total css-select time
  natNs:       0,   // total native queryIds time (matched calls only)
  buildNs:     0,   // one-time arena mirror time (per page)
  rebuilds:    0,   // arena (re)builds — now one per page, not per mutation
  syncNs:      0,   // total incremental-sync (delta) time
  syncCalls:   0,   // incremental-sync operations
  parseNs:     0,   // page bring-up time (parse5 algo + node construction + connect + inline scripts + cascade)
  parsePages:  0,   // main-document parses timed
  constructNs: 0,   // the NODE-CONSTRUCTION subset of parse (new Element/Text/Comment + applyAttrs) — what a native store actually reclaims
  constructNodes: 0,
  matched:     0,   // finds native answered (and were parity-checked)
  fallbacks:   0,   // finds deferred to css-select (state pseudo, or root not in arena)
  invalid:     0,   // finds where native reported a SyntaxError
  mismatches:  0,   // matched finds whose native set != css-select set (should stay 0)
  natResults:  0    // total elements returned across matched finds
};

// A last-seen mismatch sample, for diagnosing a non-zero `mismatches` — the selector plus the two
// set sizes, no node refs (kept cheap, overwritten each time).
let lastMismatch = null;

let built      = false;  // has the arena been mirrored for the current page yet?
let docRootNid = -1;     // the synthetic document node the tree hangs under
let nidToNode  = [];     // nativeId -> the JS node, for mapping native results back

export function shadowEnabled() {
  return globalThis.__csimNativeShadow === true && globalThis.__dom != null;
}

function now() {
  return globalThis.__dom.nowNanos();
}

// Time the JS DOM construction for a page load (F3 thinning-ceiling probe): parse is 100% JS-side
// node creation, the biggest target a native-backed store would cut. Runs fn regardless; only the
// timing is gated. Called around the main-document parse.
export function timeParse(fn) {
  if (!shadowEnabled()) return fn();
  const t = now();
  try {
    return fn();
  } finally {
    stats.parseNs += now() - t;
    stats.parsePages++;
  }
}

// Node-construction timing (the parse subset a native store reclaims), used INLINE at the parse5
// adapter's allocation points to avoid a per-node closure on the parse path: `const t = shadowNow();
// …; recordConstruct(t);`. shadowNow returns 0 when off (a no-op recordConstruct), so production pays
// only a guarded global read per constructed node during a parse.
export function shadowNow() {
  return shadowEnabled() ? globalThis.__dom.nowNanos() : 0;
}
export function recordConstruct(t0) {
  if (t0) {
    stats.constructNs += globalThis.__dom.nowNanos() - t0;
    stats.constructNodes++;
  }
}

// Whether a non-element child makes its parent non-`:empty`: only a NON-EMPTY text / CDATA node,
// mirroring css-select's LOCAL :empty patch (getText returns '' for comment / PI, so those don't
// count; a whitespace text node does). Folding every non-element child into hasText would wrongly
// make a comment-only element non-empty and spuriously diverge on comment-heavy framework output.
function elementChildrenAndText(el) {
  const kids = el._children;
  const nids = [];
  let hasText = false;
  if (kids) {
    for (let i = 0; i < kids.length; i++) {
      const c = kids[i];
      if (c.nodeType === NODE_ELEMENT) nids.push(c._nid);
      else if ((c.nodeType === NODE_TEXT || c.nodeType === NODE_CDATA) && c._data !== '') hasText = true;
    }
  }
  return { nids, hasText };
}

// Create an arena node for `el` and its element subtree (unlinked — parent -1), stamping `_nid` and
// filling the reverse map. Reads the raw `_`-fields directly (the internal "door" the engines use).
// Idempotent: a node already mirrored (e.g. a moved subtree) is left as-is.
function mirrorCreate(el) {
  if (el._nid != null && nidToNode[el._nid] === el) return el._nid;
  const attrsFlat = [];
  const attrs = el._attrs;
  if (attrs) for (const name in attrs) attrsFlat.push(name, attrs[name]);
  const ns = el._ns && el._ns !== HTML_NS ? el._ns : '';
  const nid = globalThis.__dom.importNode(el._tag, el._localName, ns, false, -1, attrsFlat);
  el._nid = nid;
  nidToNode[nid] = el;
  // STORE FLIP (Stage A): make the arena the element's `_attrs` STORE. The JS `_attrs` object seeded
  // this node's attributes (importNode above) and is now discarded — subsequent reads AND writes go
  // through the native-backed attrsView (the arena), so there is no second copy to keep in sync (the
  // attr-mirror hook syncArenaAttrs is gone). The arena persists for the whole page (ensureBuilt only
  // rebuilds on navigation), so this view stays valid; a reused-skeleton reload un-swaps it back to a
  // JS object (parse5-adapter resetReusedElement) so the re-parse repopulates and the next cascade
  // re-swaps. `_attrNS` (namespaced-attr metadata) stays a JS sidecar keyed by the same qualified names.
  el._attrs = globalThis.__dom.attrsView(nid);
  const kids = el._children;
  if (kids) for (let i = 0; i < kids.length; i++) {
    if (kids[i].nodeType === NODE_ELEMENT) mirrorCreate(kids[i]);
  }
  return nid;
}

// Link `el`'s (already-created) element subtree into the arena: syncChildren for el and every
// descendant element, so parent/child links + child_index + has_text are all set.
function mirrorLink(el) {
  const { nids, hasText } = elementChildrenAndText(el);
  globalThis.__dom.syncChildren(el._nid, nids, hasText);
  const kids = el._children;
  if (kids) for (let i = 0; i < kids.length; i++) {
    if (kids[i].nodeType === NODE_ELEMENT) mirrorLink(kids[i]);
  }
}

function mirrorSubtree(el) {
  mirrorCreate(el);
  mirrorLink(el);
}

// Build the arena once for the current page. A synthetic '#document' node parents <html> so a
// document-scoped query includes it (a native query excludes its own root element). Clears any prior
// page's arena first — the native Dom slot is isolate-level and survives a context reset.
//
// MAIN-REALM ONLY (F2 blocker): the `Dom` arena is keyed on the ISOLATE, but `built` / `nidToNode` /
// `docRootNid` are per-realm module state, and every iframe realm shares that one arena + nid space.
// This is safe today ONLY because `__csimNativeShadow` is seeded on the main context alone — so no
// frame realm ever builds, queries, or syncs, and this resetArena can't wipe an arena another realm
// is using. Before F2 enables native matching in frame realms (or makes native authoritative), the
// arena MUST be partitioned per realm (a Dom slot per context, or per-realm nid subtrees). Until then
// the invariant is: shadow runs in the top realm only.
export function ensureBuilt() {
  // Never mirror WHILE the parser is appending into the live document: parse5-adapter's in-place
  // tokenize (and the mid-parse `<script>`s it runs synchronously) rewrite the tree OFF the mutation
  // sync seams, so an arena built now would go stale as later siblings arrive. Leaving `built` false
  // makes safeMatches take the css path (elements have no `_nid`); the arena builds at the first
  // cascade after the parse returns (the loader's final cascade on the complete tree). Precise where
  // readyState is too coarse — readyState stays 'loading' through that final post-parse cascade.
  if (globalThis.__csimParsingInPlace) return;
  const doc = globalThis.document;
  const docEl = doc && doc.documentElement;
  // Self-heal across a navigation: `built` survives a document swap (it is realm module state, the
  // document is not), so a stale `true` would leave the arena mirroring the PREVIOUS page. The
  // current root being absent from the arena (a fresh element has no `_nid`, or its `_nid` maps to a
  // different node) means the mirror is stale — drop it and rebuild from the new tree.
  if (built) {
    if (docEl == null || (docEl._nid != null && nidToNode[docEl._nid] === docEl)) return;
    built = false;
  }
  const t0 = now();
  globalThis.__dom.resetArena();
  nidToNode = [];
  docRootNid = globalThis.__dom.importNode('#document', '#document', '', false, -1, []);
  nidToNode[docRootNid] = doc || null;
  if (docEl) {
    mirrorSubtree(docEl);
    globalThis.__dom.syncChildren(docRootNid, [docEl._nid], false);
  }
  built = true;
  stats.buildNs += now() - t0;
  stats.rebuilds++;
}

// Invalidate the built arena so the next ensureBuilt does a full fresh mirror. Called when the live
// document is RE-PARSED in place (parse5ParseIntoLive): that path reuses the `<html>`/`<head>`/`<body>`
// skeleton node objects — their `_nid` survives — and rewrites their `_children` / `_attrs` DIRECTLY,
// bypassing the mutation sync seams. ensureBuilt's self-heal keys on the root's identity, which the
// reused skeleton preserves, so it would wrongly keep the previous page's arena; dropping `built` here
// forces the rebuild. (A fresh-context navigation gets a fresh root and rebuilds anyway; this covers
// the same-context reload the identity check can't see.) No-op unless an arena was built.
export function invalidateArena() {
  built = false;
}

// ── incremental sync hooks (called from the DOM mutation chokepoints) ──────────────
// Each returns on its first check when the arena isn't built (which includes the whole flag-off
// case), so production pays one boolean test per mutation.

// A child-list change on `parent`: mirror any newly-inserted subtree, then relink parent's element
// children (a removal is just an absence here; syncChildren drops it and nulls its subtree's chain).
export function syncArenaChildList(parent) {
  if (!built || !parent || parent.nodeType !== NODE_ELEMENT || parent._nid == null) return;
  const t = now();
  const kids = parent._children;
  if (kids) for (let i = 0; i < kids.length; i++) {
    const c = kids[i];
    if (c.nodeType === NODE_ELEMENT && !(c._nid != null && nidToNode[c._nid] === c)) mirrorSubtree(c);
  }
  const { nids, hasText } = elementChildrenAndText(parent);
  globalThis.__dom.syncChildren(parent._nid, nids, hasText);
  stats.syncNs += now() - t;
  stats.syncCalls++;
}

// (attribute changes need no arena hook: a mirrored element's `_attrs` IS the arena via attrsView, so
// the write already landed there — see mirrorCreate's store-flip swap.)

// A character-data change on a text node: its parent's `:empty` (has_text) may flip, so relink the
// parent's children (which recomputes has_text).
export function syncArenaCharData(textNode) {
  if (!built || !textNode) return;
  const parent = textNode._parent;
  if (!parent || parent.nodeType !== NODE_ELEMENT || parent._nid == null) return;
  const t = now();
  const { nids, hasText } = elementChildrenAndText(parent);
  globalThis.__dom.syncChildren(parent._nid, nids, hasText);
  stats.syncNs += now() - t;
  stats.syncCalls++;
}

// Run a find through BOTH engines. Returns the css-select matches (authoritative, a NodeList);
// records timing + parity for the native run as a side effect.
export function shadowQuery(root, selector) {
  // The static NodeList querySelectorAll builds IS the css result Capybara gets (its caller maps it
  // directly). Timing it — with no extra copy native would not pay — keeps this matcher-vs-matcher.
  const c0 = now();
  const cssMatches = root && root.querySelectorAll ? root.querySelectorAll(selector) : [];
  stats.calls++;
  stats.cssNs += now() - c0;

  try {
    ensureBuilt();

    let rootNid;
    if (!root || root.nodeType === NODE_DOC) {
      rootNid = docRootNid;
    } else {
      // A root detached since it was mirrored carries a STALE `_nid`; the reverse map catches it.
      rootNid = root._nid;
      if (rootNid == null || nidToNode[rootNid] !== root) { stats.fallbacks++; return cssMatches; }
    }
    if (rootNid < 0) { stats.fallbacks++; return cssMatches; }

    const n0 = now();
    const ids = globalThis.__dom.queryIds(rootNid, selector);
    const dt = now() - n0;

    if (ids === undefined) { stats.fallbacks++; return cssMatches; }   // live-state selector
    if (ids === null)      { stats.invalid++;   return cssMatches; }   // SyntaxError

    stats.natNs += dt;
    stats.matched++;
    stats.natResults += ids.length;
    checkParity(ids, cssMatches, selector);
  } catch (_) {
    // A measurement path must never perturb a find — swallow and let css-select stand.
  }
  return cssMatches;
}

// Compare the native result to css-select's, IN ORDER. Native `query()` emits document (preorder)
// order — the same order css-select returns and Capybara depends on — so an engine that replaced
// css-select would have to reproduce it. A duplicate or a reordering both fail here.
function checkParity(ids, cssMatches, selector) {
  let ok = ids.length === cssMatches.length;
  if (ok) {
    for (let i = 0; i < ids.length; i++) {
      if (nidToNode[ids[i]] !== cssMatches[i]) { ok = false; break; }
    }
  }
  if (!ok) {
    stats.mismatches++;
    lastMismatch = { selector, nat: ids.length, css: cssMatches.length };
  }
}

// Read (and optionally reset) the accumulated stats — the harness dumps these. A reset also drops
// the built arena so the next measurement window (next page) mirrors afresh.
globalThis.__csimNativeShadowStats = function (reset) {
  const snapshot = Object.assign({ lastMismatch }, stats);
  if (reset) {
    for (const k in stats) stats[k] = 0;
    lastMismatch = null;
    built = false;
  }
  return snapshot;
};
