// HTML "the target element" — what `:target` matches: a document's INDICATED PART for its fragment. The fragment is
// the document's own, set by what scrolls to one — a load, a fragment navigation, a traversal — and not by
// pushState / replaceState, which change the URL and leave the target where it was (Chrome, Firefox). The indicated
// part is looked for with the fragment as it stands, then percent-decoded: the first element of the document's tree
// (not a shadow tree) with that id, else the first HTML `<a>` with that name. A document never navigated to a URL of
// its own (a DOMParser / createHTMLDocument one) has none.
//
// The fragment is the engine's, kept with the realm's URL (realm_location.rs), which resolves the element as
// element_state.rs does for `:target` — the one definition the matcher and the invalidation hint (location.js) read.
import { arenaNid } from './native-query-shadow.js';

// A new target fragment for the realm document — `hash` as `location.hash` spells it.
export function setTargetHash(hash) {
  if (globalThis.__dom) globalThis.__dom.setTargetHash(realmDocumentNid(), hash);
}
// The realm document's target element — the indicated part of its target fragments, the engine's
// (element_state.rs `target_element_of`) — as its arena number, -1 for none.
export function targetElementNid(doc) {
  const nid = arenaNid(doc);
  return nid < 0 ? -1 : globalThis.__dom.targetElement(nid);
}

// The realm document's target, as its fragment resolves: after a load, which starts the arena afresh.
export function syncTargetFragment() {
  const nid = realmDocumentNid();
  if (nid >= 0) globalThis.__dom.setTargetHash(nid);
}
function realmDocumentNid() {
  const doc = globalThis.document;
  return globalThis.__dom && doc ? arenaNid(doc) : -1;
}
