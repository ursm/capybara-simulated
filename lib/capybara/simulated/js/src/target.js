// HTML "the target element" — what `:target` matches: a document's INDICATED PART for its fragment. The fragment is
// the document's own, set by what scrolls to one — a load, a fragment navigation, a traversal — and not by
// pushState / replaceState, which change the URL and leave the target where it was (Chrome, Firefox). The indicated
// part is looked for with the fragment as it stands, then percent-decoded: the first element of the document's tree
// (not a shadow tree) with that id, else the first HTML `<a>` with that name. A document never navigated to a URL of
// its own (a DOMParser / createHTMLDocument one) has none.
//
// The one definition the JS matcher, the invalidation hint (location.js) and the arena (`__dom.setTarget`, which
// element_state.rs resolves the same way) all read.
import { arenaNid } from './native-query-shadow.js';

// `doc`'s fragments to look for — as it stands, then decoded (the one when they say the same) — or [].
export function targetFragments(doc) {
  let hash = doc._targetHash;
  if (hash === undefined) {
    hash = '';
    if (doc._url) {
      try { hash = new URL(doc._url).hash; } catch (_) { hash = ''; }
    }
  }
  return fragmentsOfHash(hash);
}
function fragmentsOfHash(hash) {
  if (!hash || hash.length <= 1) return [];
  const raw = hash.slice(1);
  let decoded = raw;
  try { decoded = decodeURIComponent(raw); } catch (_) { /* malformed %-escape: the raw form only */ }
  return decoded === raw ? [raw] : [raw, decoded];
}
// A new target fragment for the realm document — `hash` as `location.hash` spells it — into its arena too.
export function setTargetHash(hash) {
  const doc = globalThis.document;
  if (!doc) return;
  doc._targetHash = hash;
  syncTargetFragment();
}
// The realm document's target element — the indicated part of its target fragments, the engine's
// (element_state.rs `target_element_of`) — as its arena number, -1 for none.
export function targetElementNid(doc) {
  const nid = arenaNid(doc);
  return nid < 0 ? -1 : globalThis.__dom.targetElement(nid);
}

// The realm document's fragments, into its arena: after a load and whenever the target fragment changes.
export function syncTargetFragment() {
  const d = globalThis.__dom, doc = globalThis.document;
  const nid = d && doc ? arenaNid(doc) : -1;
  if (nid < 0) return;
  d.setTarget(nid, targetFragments(doc));
}
