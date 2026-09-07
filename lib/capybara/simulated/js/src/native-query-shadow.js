// SHADOW measurement for the DOM-in-Rust store migration.
//
// Question this answers: does the native (Rust/Servo) selector engine beat
// css-select at real app scale, once the cost of KEEPING the native arena around
// (build + rebuild) is counted against it? The native_selector_ab_spec already
// showed the raw match is faster; it did NOT go through the production find path and
// paid no arena-upkeep tax. This runs native ALONGSIDE css-select on the actual
// `__csimQuery` path — css-select stays authoritative (its result is what Capybara
// gets), native runs only to be TIMED and PARITY-CHECKED. Zero correctness risk: a
// native bug or a stale arena can only show up as a recorded mismatch, never as a
// wrong find.
//
// The arena is rebuilt lazily whenever the DOM has changed since the last build
// (`markArenaDirty`, fired from the mutation chokepoints). That is a conservative
// UPPER BOUND on upkeep: the real store migration pays NO rebuild (the nodes ARE the
// arena), so if native wins even while eating a full rebuild per change, it wins by
// more once migrated. Build time is tracked separately from query time so the two
// costs stay legible.
//
// Everything here is inert unless `globalThis.__csimNativeShadow === true` and the
// native `__dom` arena is present (V8 only — a no-op on QuickJS). Production with the
// flag off pays only a single guarded boolean write per DOM mutation.

import { NODE_ELEMENT, NODE_TEXT, NODE_CDATA, NODE_DOC, HTML_NS } from './constants.js';

const stats = {
  calls:       0,   // finds observed
  cssNs:       0,   // total css-select time
  natNs:       0,   // total native queryIds time (matched calls only)
  buildNs:     0,   // total arena (re)build time
  rebuilds:    0,   // arena rebuilds
  matched:     0,   // finds native answered (and were parity-checked)
  fallbacks:   0,   // finds deferred to css-select (state pseudo, or root not in arena)
  invalid:     0,   // finds where native reported a SyntaxError
  mismatches:  0,   // matched finds whose native set != css-select set (should stay 0)
  natResults:  0    // total elements returned across matched finds
};

// A last-seen mismatch sample, for diagnosing a non-zero `mismatches` — the selector
// plus the two set sizes, no node refs (kept cheap, overwritten each time).
let lastMismatch = null;

let dirty      = true;   // the arena needs a (re)build before the next native query
let docRootNid = -1;     // the synthetic document node the tree hangs under
let nidToNode  = [];     // nativeId -> the JS node, for mapping native results back

export function shadowEnabled() {
  return globalThis.__csimNativeShadow === true && globalThis.__dom != null;
}

// Fired from the DOM mutation chokepoints (recordChildList / recordAttrMutation). A
// single boolean write; the flag is only ever READ while shadow is enabled, so when
// it is off this is the whole cost.
export function markArenaDirty() {
  dirty = true;
}

function now() {
  return globalThis.__dom.nowNanos();
}

// Rebuild the arena from the current document. A synthetic '#document' node is the
// arena root so the documentElement is a DESCENDANT of the query root for a
// document-scoped find — matching `document.querySelectorAll`, which includes
// `<html>` in its search (a native query excludes its own root element).
function rebuildArena() {
  const t0 = now();
  globalThis.__dom.resetArena();
  nidToNode = [];
  const doc = globalThis.document;
  const docEl = doc && doc.documentElement;
  docRootNid = globalThis.__dom.importNode('#document', '#document', '', false, -1, []);
  nidToNode[docRootNid] = doc || null;
  if (docEl) importSubtree(docEl, docRootNid);
  dirty = false;
  stats.buildNs += now() - t0;
  stats.rebuilds++;
}

// Import one element and its element subtree into the arena, stamping `_nid` on each
// JS node and filling the reverse map. Reads the raw `_`-fields directly (the
// internal "door" the selector engine uses) rather than the IDL getters. The arena is
// element-only; a non-element child (text / comment) is folded into `hasText` so
// `:empty` stays correct.
function importSubtree(el, parentNid) {
  const attrsFlat = [];
  const attrs = el._attrs;
  if (attrs) for (const name in attrs) attrsFlat.push(name, attrs[name]);

  const kids = el._children;
  const elemKids = [];
  let hasText = false;
  if (kids) {
    for (let i = 0; i < kids.length; i++) {
      const c = kids[i];
      if (c.nodeType === NODE_ELEMENT) {
        elemKids.push(c);
      } else if ((c.nodeType === NODE_TEXT || c.nodeType === NODE_CDATA) && c._data !== '') {
        // Only a non-empty text / CDATA child disqualifies `:empty`, mirroring
        // css-select's LOCAL :empty patch (its getText returns '' for a comment / PI,
        // so those don't count; a whitespace text node DOES). Folding EVERY non-element
        // child into hasText would wrongly make a comment-only element non-empty and
        // spuriously diverge from css-select on comment-heavy framework output
        // (Vue / React / Turbo placeholder comments) — noise that would mask a real bug.
        hasText = true;
      }
    }
  }

  const ns = el._ns && el._ns !== HTML_NS ? el._ns : '';
  const nid = globalThis.__dom.importNode(el._tag, el._localName, ns, hasText, parentNid, attrsFlat);
  el._nid = nid;
  nidToNode[nid] = el;
  for (let i = 0; i < elemKids.length; i++) importSubtree(elemKids[i], nid);
  return nid;
}

// Run a find through BOTH engines. Returns the css-select matches (authoritative,
// an Array); records timing + parity for the native run as a side effect.
export function shadowQuery(root, selector) {
  // The static NodeList querySelectorAll builds IS the css result Capybara gets (its
  // caller maps it directly). Timing it — with no extra Array.from copy native would
  // not pay — keeps this matcher-vs-matcher, both engines paying for their own result.
  const c0 = now();
  const cssMatches = root && root.querySelectorAll ? root.querySelectorAll(selector) : [];
  stats.calls++;
  stats.cssNs += now() - c0;

  try {
    if (dirty) rebuildArena();

    let rootNid;
    if (!root || root.nodeType === NODE_DOC) {
      rootNid = docRootNid;
    } else {
      // `_nid` is only ever stamped, never cleared, so a root detached since the last
      // build carries a STALE id that now indexes a different arena node. The reverse
      // map catches it (a rebuild only re-stamps connected elements) — defer rather
      // than query the wrong subtree.
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

// Compare the native result to css-select's, IN ORDER. Native `query()` emits document
// (preorder) order — the same order css-select returns and Capybara depends on for
// first-match semantics — so an engine that replaced css-select would have to reproduce
// it. Checking order (not just set membership) is what proves that; a duplicate or a
// reordering both fail here.
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

// Read (and optionally reset) the accumulated stats — the harness dumps these.
globalThis.__csimNativeShadowStats = function (reset) {
  const snapshot = Object.assign({ lastMismatch }, stats);
  if (reset) {
    for (const k in stats) stats[k] = 0;
    lastMismatch = null;
    dirty = true;
  }
  return snapshot;
};
