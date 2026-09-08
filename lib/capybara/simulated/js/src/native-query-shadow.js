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
// Monotonic page generation, bumped every load (invalidateArena). mirrorCreate stamps `el._nidGen` with
// it as it LINKS an element into the document arena, so `el._nidGen === pageGen` is the authoritative
// "this element is mirrored + tree-linked THIS page" test. Eager construction sets `_nid` on EVERY
// element (document, shadow tree, detached) for its attrs store — but only linked document-tree elements
// are safe to match natively (shadow scoping stays on css-select; a detached / mid-parse node has no
// wired parent chain). The generation stamp draws that line without a per-match cross-module call.
let pageGen = 0;

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
// STORE FLIP (Stage A.2): eager-create THIS element's arena node at construction (registerNativeElement,
// called from the Element ctor), stamping `_nid`, filling the reverse map, and making `_attrs` the
// native-backed attrsView over that node. No JS `_attrs` object ever exists for it — the arena IS the
// store, and attribute writes flow straight through attrsView. The node starts with no attributes / no
// tree links: attrs arrive via attrsView writes, the tree is linked at the mutation seams / ensureBuilt.
// `_ns` is still the HTML default here; createElementNS / parser foreign content finalize a non-HTML
// namespace after construction and call updateNativeElementNs. No-op on QuickJS / before __dom.
export function registerNativeElement(el) {
  const d = globalThis.__dom;
  if (!d) return;
  const nid = d.importNode(el._tag, el._localName, '', false, -1, []);
  el._nid = nid;
  el._attrs = d.attrsView(nid);
  // NB: does NOT stamp `_nidGen` / nidToNode — the node exists (attrs work) but isn't linked into the
  // document arena yet. mirrorCreate does that when the tree is built / the element is inserted.
}

// Flush a flat [name, value, …] attribute list into `el`'s arena node in ONE crossing (syncAttrs
// replaces the node's attributes wholesale). The parse-time attribute apply uses this instead of N
// per-attribute attrsView interceptor writes — restoring the pre-store-flip economics: the plain-object
// `{}` it replaced took zero crossings per element, a batched syncAttrs takes one. `flat` MUST be the
// element's COMPLETE final attribute set (the caller seeds it with any pre-existing attrs for the adopt
// path), since the write is wholesale. Returns false — leaving `_attrs` untouched — on QuickJS / before
// __dom, where `_attrs` is a plain object the caller writes into directly.
export function syncNativeAttrs(el, flat) {
  const d = globalThis.__dom;
  if (!d || el._nid == null || el._nid < 0) return false;
  // Nothing to flush: an attribute-less element — the common case, a large
  // fraction of any page's nodes — keeps its eager arena node's empty attribute
  // vec and pays NO crossing, just as the plain object it replaced took zero. A
  // wholesale syncAttrs([]) would only re-clear an already-empty node (every
  // path here reaches an empty `flat` only on an already-empty node: a fresh
  // ctor node, a re-registered skeleton, or an adopt with nothing to add).
  if (flat.length === 0) return true;
  d.syncAttrs(el._nid, flat);
  return true;
}

// Update the arena node's finalized namespace + localName (setNodeMeta) — createElementNS / parser
// foreign content / cloneNode set a non-HTML `_ns` (or a case-preserved `_localName`) AFTER the ctor's
// eager create. The ctor already stamped HTML ns + localName==`_tag`, so the common HTML element needs
// no crossing — skip it.
export function updateNativeElementNs(el) {
  const d = globalThis.__dom;
  if (!d || el._nid == null || el._nid < 0) return;
  if ((el._ns == null || el._ns === HTML_NS) && el._localName === el._tag) return;
  const ns = el._ns && el._ns !== HTML_NS ? el._ns : '';
  d.setNodeMeta(el._nid, el._localName, ns);
}

function mirrorCreate(el) {
  // LINK this element into the document arena: stamp the current page generation + fill the reverse map,
  // so safeMatches trusts a native answer for it. The node itself already exists (eager-created at
  // construction); the fallback below only fires for an element built before __dom was installed, which
  // still carries a plain-object `_attrs` to seed from.
  if (el._nid != null && el._nid >= 0) {
    // node exists — just register it
  } else {
    const attrsFlat = [];
    const attrs = el._attrs;
    if (attrs) for (const name in attrs) attrsFlat.push(name, attrs[name]);
    const ns = el._ns && el._ns !== HTML_NS ? el._ns : '';
    el._nid = globalThis.__dom.importNode(el._tag, el._localName, ns, false, -1, attrsFlat);
    el._attrs = globalThis.__dom.attrsView(el._nid);
  }
  el._nidGen = pageGen;
  nidToNode[el._nid] = el;
  const kids = el._children;
  if (kids) for (let i = 0; i < kids.length; i++) {
    if (kids[i].nodeType === NODE_ELEMENT) mirrorCreate(kids[i]);
  }
  return el._nid;
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
  if (!docEl) return;
  const t0 = now();
  // Nodes are eager-created at Element construction (registerNativeElement) and this page's arena was
  // cleared at load (invalidateArena) — so DON'T reset here: that would wipe the eager nodes the parse
  // just filled (and their attrs, which now LIVE in the arena via attrsView). Create the synthetic
  // '#document' root once, then link the connected tree — mirrorSubtree reuses each eager nid and
  // syncChildren wires parent/child + child_index + has_text.
  if (docRootNid < 0 || nidToNode[docRootNid] !== (doc || null)) {
    docRootNid = globalThis.__dom.importNode('#document', '#document', '', false, -1, []);
    nidToNode[docRootNid] = doc || null;
  }
  mirrorSubtree(docEl);
  globalThis.__dom.syncChildren(docRootNid, [docEl._nid], false);
  built = true;
  stats.buildNs += now() - t0;
  stats.rebuilds++;
}

// Clear the arena for a new page. Called at the START of every in-place load (parse5ParseIntoLive),
// BEFORE the tokenizer constructs the new page's elements — so this is the ONE per-page reset in the
// store-flip model: elements eager-create their arena nodes at construction (registerNativeElement), and
// those must land in a FRESH arena, not pile onto the previous page's (the native Dom slot is
// isolate-level and survives a context reset, so realm 0 is reused across visits). Dropping `built` +
// `docRootNid` makes the first post-parse ensureBuilt relink the tree; resetting the arena frees the old
// page (the reused `<html>`/`<head>`/`<body>` skeleton's nodes included — resetReusedElement re-creates
// them as the reparse repopulates). No-op before `__dom` exists (QuickJS / bootstrap).
// The current page generation. safeMatches reads it once per pass and trusts a native match only for an
// element whose `_nidGen` equals it (mirrorCreate stamped it → linked in the document arena). Eager
// construction sets `_nid` on every element, so this generation — not `_nid` presence — is what
// separates a linked document element (native) from a shadow-tree / detached / mid-parse one (css).
export function arenaPageGen() {
  return pageGen;
}

export function invalidateArena() {
  built      = false;
  docRootNid = -1;
  nidToNode  = [];
  pageGen++;   // stale every prior `_nidGen` stamp: last page's elements must not read as linked
  const d = globalThis.__dom;
  if (d) d.resetArena();
}

// ── incremental sync hooks (called from the DOM mutation chokepoints) ──────────────
// Each returns on its first check when the arena isn't built (which includes the whole flag-off
// case), so production pays one boolean test per mutation.

// A child-list change on `parent`: mirror any newly-inserted subtree, then relink parent's element
// children (a removal is just an absence here; syncChildren drops it and nulls its subtree's chain).
export function syncArenaChildList(parent) {
  // `parent` must be LINKED into the document arena — not merely carry an eager `_nid` (every element
  // does since the store flip). `nidToNode[parent._nid] === parent` is the connectivity test the old
  // `parent._nid == null` used to be: it excludes a detached subtree and a shadow-tree parent, so a
  // mutation under either is NOT mirrored (and its children are not stamped `_nidGen`) — they stay on
  // css-select, which owns shadow scoping. When such a subtree is later attached, the document parent's
  // own syncArenaChildList mirrors it in.
  if (!built || !parent || parent.nodeType !== NODE_ELEMENT || nidToNode[parent._nid] !== parent) return;
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
  if (!parent || parent.nodeType !== NODE_ELEMENT || nidToNode[parent._nid] !== parent) return;   // document-linked only (see syncArenaChildList)
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
