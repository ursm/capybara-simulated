// The native (Rust) arena: every node of every tree of this realm, MIRRORED from the JS DOM so the native readers see
// what a script sees (the attributes are no mirror — the arena IS their store, through the attrsView). This file
// owns the arena's lifecycle: a node joins it at construction, a tree change is applied as it happens, and a
// navigation starts it afresh (see "the mirror" below). Each realm has its own arena (the `Dom` slot is keyed by the
// realm's context id), so a frame realm's nodes never meet the main one's.
//
// Its readers: every selector match (selectors.js — querySelector, matches, closest) and the native style engine and
// layout, so the mirror must be exact: `CSIM_ARENA_VERIFY=1` checks it.
//
// A no-op before `__dom` exists (the snapshot's bootstrap).

import { NODE_ELEMENT, NODE_TEXT, NODE_CDATA, NODE_COMMENT, NODE_PI, NODE_DOC, NODE_FRAGMENT, HTML_NS } from './constants.js';

// A nid names a slot in ONE arena: a realm's (each has its own, and a frame's nodes live in the frame's), as of one
// reset of it (a navigation starts a fresh one). So every registered node carries the ARENA its nid is in
// (`_nidArena`): the realm's `__dom`, and whether it has been reset since (`dead`). A node belongs to the arena of the TREE it is in — the one its parent's list is kept in
// — so a node another realm made, inserted here, or one from before the last reset (a script held it across a
// navigation), is registered afresh in the arena of the tree it joins (`nodeIn`); a write that names a node by its nid
// (a removal, a data change) goes to the node's own arena. Using a nid in any other arena would move the node that
// arena gave that slot to.
function newArena() {
  return { dom: globalThis.__dom, dead: false, realm: REALM };
}
// What this realm answers about the nodes in its arena, for a reader in ANOTHER realm holding one of them: an element
// a parent's script made and put into a frame's document lives in the frame's arena, and its style, whether it is
// shown and the shadow hosts among it are the frame's to say — while every method it is called through is the
// parent's code. Filled in by the modules that answer (cascade.js, dom-nodes.js), which this one cannot import.
export const REALM = { shadowHosted: () => {}, ensureLayout: () => {} };
// …the realm that answers for `node` when it is in another realm's arena, or null.
export function foreignRealmOf(node) {
  const a = liveArenaOf(node);
  return a !== null && a !== arena ? a.realm : null;
}
let arena = null;
// This realm's arena, as of now.
function currentArena() {
  if (arena === null || arena.dom !== globalThis.__dom) arena = newArena();
  return arena;
}
// Reclaim a node's arena slot when its JS wrapper is garbage-collected: `dropNode` bumps the slot's generation, so
// any surviving reference (a stale arena edge, a nid still held somewhere) reads absent rather than aliasing the
// reoccupant — the generational arena is what makes reclaiming + reusing a slot SAFE. The callback runs only when the
// isolate's foreground message loop is pumped (the browser does so at settle). A slot of a reset arena is never
// dropped: the callback asks whether its arena is `dead`. (Not a native weak handle: one held in the isolate's slot outlives the
// isolate handle at teardown and V8's last GC calls back into it.)
const finRegistry = (typeof FinalizationRegistry !== 'undefined')
  ? new FinalizationRegistry((held) => { if (!held.arena.dead) held.arena.dom.dropNode(held.nid); })
  : null;
// A node's FIRST registration takes no unregister token: keeping the registry's token table (an identity hash and a
// dictionary entry per node) was most of what a registration cost, and nearly every node is registered once. One
// registered AGAIN (`again`: the reused skeleton and Document on every navigation, a node moving between realms) is
// the token from then on, so its entry is replaced rather than piled up per registration; the cell its first one left
// calls back harmlessly — its nid names the slot as it was, which leaving it (`leaveSlot`) already freed, and
// dropNode's gen check declines it.
function reclaimOnCollect(node, nid, a, again) {
  if (!finRegistry) return;
  if (!again) { finRegistry.register(node, { nid, arena: a }); return; }
  finRegistry.unregister(node);
  finRegistry.register(node, { nid, arena: a }, node);
}
function liveArenaOf(node) {
  const a = node._nidArena;
  return a && !a.dead && node._nid >= 0 ? a : null;
}
// `node`'s nid in THIS realm's arena, or -1 — for a reader that asks the arena about a node (the cascade's matcher).
export function arenaNid(node) {
  return node._nidArena === arena && arena !== null && !arena.dead && node._nid >= 0 ? node._nid : -1;
}

// ── the mirror ───────────────────────────────────────────────────────────────────────────────────────────────
// EVERY node is in an arena from its construction — elements, text, comments, doctypes, documents, fragments and
// shadow roots — and every tree is kept linked there, the document's, a detached subtree's, a template's contents',
// a DOMParser document's: a native reader sees the tree a script sees (text included), whatever it asks about.
// Three kinds of write keep it so: a node's creation (`registerNative*`), a child-list change (`syncArenaChildList`
// from the mutation chokepoint, `arenaInsert` / `arenaRemove` from the parser, `syncArenaSubtree` after a bulk
// build) and a character-data change (CharacterData's `_data` setter → `syncArenaData`). `CSIM_ARENA_VERIFY=1` holds
// the whole JS tree against the arena at every layout and cascade entry and throws on the first difference.
//
// A node constructed before `__dom` exists (the snapshot's bootstrap) has no arena node; it gets one the first time
// a child-list sync names it (`nodeIn`).

// An ELEMENT's arena node, created at construction (the Element ctor) in this realm's arena — or, re-registered, in
// the arena of the tree it joins: the arena IS its attribute store (`_attrs` becomes the attrsView over it).
export function registerNativeElement(el, into = null) {
  const a = into || currentArena();
  if (!a.dom) return;
  const again = el._nidArena != null;
  leaveSlot(el);
  // (…in the namespace the element was made in: one in none crosses as '' — it is no HTML element, not to `:any-link`,
  // nor to a type selector's case rule)
  const nid = a.dom.importNode(el._localName, el._ns ?? '', -1, [], el._prefix ?? null);
  el._nid = nid;
  el._nidArena = a;
  el._attrs = a.dom.attrsView(nid);
  reclaimOnCollect(el, nid, a, again);
  if (el._csimState) a.dom.setState(nid, el._csimState);
  if (el.__value !== undefined) a.dom.setValue(nid, el.__value);
  // (…and an image's decoded size: one adopted into another realm's tree keeps the bitmap it decoded)
  if (el._naturalWidth > 0 && el._naturalHeight > 0) a.dom.setNaturalSize(nid, el._naturalWidth, el._naturalHeight);
}
// A node registered afresh leaves the slot it had: that one is freed now, as nothing names it any more (and its
// reclaim entry is replaced by the new slot's). Every slot is otherwise freed with its node's wrapper, or by a reset.
function leaveSlot(node) {
  const old = liveArenaOf(node);
  if (old) old.dom.dropNode(node._nid);
}

// ── element state ────────────────────────────────────────────────────────────────────────────────────────────
// What a script or the user did to an element that no attribute records — the state pseudo-classes' input (dom.rs
// `STATE_*`, read by element_state.rs). The element keeps the bits (`_csimState`) and its arena node a copy, written here
// and by a registration.
export const STATE_FOCUSED          = 1;
export const STATE_HOVERED          = 1 << 1;
export const STATE_CHECKED_DIRTY    = 1 << 2;
export const STATE_CHECKED          = 1 << 3;
export const STATE_SELECTED         = 1 << 4;
export const STATE_INDETERMINATE    = 1 << 5;
export const STATE_POPOVER_OPEN     = 1 << 6;
export const STATE_MODAL            = 1 << 7;
export const STATE_FILTERED         = 1 << 8;
export const STATE_FORM_ASSOCIATED  = 1 << 9;
export const STATE_CUSTOM           = 1 << 10;
export const STATE_IS_VALUE         = 1 << 11;
export const STATE_DIRTY_BY_USER    = 1 << 12;
export const STATE_CUSTOM_ERROR     = 1 << 13;
export const STATE_USER_INTERACTED  = 1 << 14;
export const STATE_HAS_FILES        = 1 << 15;
// `el`'s bits under `mask` become `bits`.
export function setElementState(el, mask, bits) {
  const next = (el._csimState & ~mask) | bits;
  if (next === el._csimState) return;
  el._csimState = next;
  const a = liveArenaOf(el);
  if (a) a.dom.setState(el._nid, next);
}
// …and its live value (`undefined`: back to its default).
export function setElementValue(el, value) {
  const a = liveArenaOf(el);
  if (a) a.dom.setValue(el._nid, value);
}
// …and an `<img>`'s decoded size (0 x 0: nothing decoded), which the layout sizes it from.
export function setElementNaturalSize(el, width, height) {
  const a = liveArenaOf(el);
  if (a) a.dom.setNaturalSize(el._nid, width, height);
}
// Is `bit` set on `el`, and set it to `on`: the flags (indeterminate, popover open, modal, filtered).
export function hasState(el, bit) {
  return (el._csimState & bit) !== 0;
}
export function setStateBit(el, bit, on) {
  setElementState(el, bit, on ? bit : 0);
}
// The form the HTML parser's form element pointer gave a control (`_formOwner`), or none: the one form owner the tree
// can't tell (`<table><form>…<input>`), which the native form owner falls back to as `formForControl` does.
export function setParserFormOwner(el, form) {
  el._formOwner = form;
  const a = liveArenaOf(el);
  if (a) a.dom.setParserFormOwner(el._nid, form ? nodeIn(form, a) : -1);
}
// A custom element's custom states (`ElementInternals.states`), which `:state()` reads, mirrored whole — a handful at most.
export function syncCustomStates(el) {
  const a = liveArenaOf(el);
  if (a) a.dom.setCustomStates(el._nid, customStateNames(el));
}
function customStateNames(el) {
  const states = el._internals && el._internals._states;
  const out = [];
  if (states) for (const s of states) out.push(String(s));
  return out;
}
// The realm's focus ring: shown (`:focus-visible`) unless the focus came from a pointer onto a non-text control.
export function setFocusVisible(visible) {
  globalThis.__csimFocusVisible = visible;
  const d = globalThis.__dom;
  if (d) d.setFocusRingHidden(!visible);
}
// `sr` is attached to `host`: its arena node learns its host, which the shadow-including state walks cross.
// The arena `node` is in — live, and the node's own realm's (its `dom` answers about it) — after registering its tree
// again where the arena it was in is gone (reset by a page load the node outlived: one a script kept, a snapshot
// cloned before the page changed). The part of its tree no live arena holds is registered under the nearest ancestor
// one does, or as a tree of its own in this realm's. Null before `__dom`.
export function nodeArena(node) {
  const live = liveArenaOf(node);
  if (live || !globalThis.__dom) return live;
  let top = node;
  while (top._parent && !liveArenaOf(top._parent)) top = top._parent;
  const parent = top._parent;
  if (!parent) nodeIn(top, currentArena());
  else if (parent._shadowRoot === top) arenaAttachShadow(parent, top);
  else syncArenaChildList(parent);
  return liveArenaOf(node);
}

// …and the realm whose arena it is counts the host (`REALM.shadowHosted`): the one whose sheets it feeds — attached
// here, or adopted with its host from another realm's arena (`nodeIn`), whose realm counted it where this one has never
// heard of it.
export function arenaAttachShadow(host, sr) {
  if (!globalThis.__dom) { REALM.shadowHosted(sr); return; }
  const a = arenaFor(host);
  const hn = nodeIn(host, a);
  if (hn >= 0) a.dom.setShadowHost(nodeIn(sr, a), hn);
  a.realm.shadowHosted(sr);
}

// A slot's assigned nodes (HTML's "assign slottables"), which the style engine's flat tree walks.
export function setArenaAssignedNodes(slot, nodes) {
  const a = liveArenaOf(slot);
  if (!a) return;
  const nids = [];
  for (const n of nodes) {
    const nid = nodeIn(n, a);
    if (nid >= 0) nids.push(nid);
  }
  a.dom.setAssignedNodes(slot._nid, nids);
}

// Any other node's: its kind and, for character data, its data.
export function registerNativeNode(node, into = null) {
  const a = into || currentArena();
  if (!a.dom) return;
  const data = node.nodeType === NODE_TEXT || node.nodeType === NODE_CDATA || node.nodeType === NODE_COMMENT ||
               node.nodeType === NODE_PI ? node._data : null;
  const again = node._nidArena != null;
  leaveSlot(node);
  node._nid = a.dom.createNode(node.nodeType, data == null ? '' : String(data), -1, node._target ?? '');
  node._nidArena = a;
  reclaimOnCollect(node, node._nid, a, again);
}

// …and one for a node that is only ever a BOX: a generated-content pseudo, which is no part of the DOM.
// It needs the arena slot — the shadow harness reads every box back by `_nid` (`boxOf`), and once native is
// the only engine that is how any box is read — but nothing else the registration carries. In particular no
// `attrsView`: a pseudo has no attributes ever (an `attr()` in its `content` resolves against the ORIGINATING
// element), while `_attrs.style` and `_attrs.align` ARE read of it per layout pass, and a view turns each of
// those misses from a 4.5 ns property read into a 98.9 ns crossing — measured, 16,076 reads and ~1.5 ms of an
// 87 ms relayout on a Tailwind-preflight page whose 1,605 elements carry 3,204 pseudos.
export function registerNativeBoxNode(node, localName) {
  const a = currentArena();
  if (!a.dom) return;
  const again = node._nidArena != null;
  leaveSlot(node);
  node._nid = a.dom.importNode(localName, HTML_NS, -1, []);
  node._nidArena = a;
  reclaimOnCollect(node, node._nid, a, again);
}

// …and the element whose `::before` / `::after` such a box is, which no tree says: the walk lays the box out as the
// element's first / last child. Linked while the box renders, so an element registered afresh (adopted) has it again.
export function linkPseudoBox(el, node, which) {
  const a = liveArenaOf(el);
  if (a && node._nidArena === a) a.dom.linkPseudoBox(el._nid, which === 'after' ? 1 : 0, node._nid);
}

// The scroll offset an element keeps in `axis` (0 x, 1 y) — kept in its arena beside its box, which the geometry shifts
// by it (geometry.rs) — and the write of one, each axis given as a number (`undefined` leaves it). One in no arena keeps
// none.
export function scrollOffsetOf(el, axis) {
  const a = liveArenaOf(el);
  return a ? a.dom.scrollOffset(el._nid, axis) : 0;
}
export function setScrollOffset(el, x, y) {
  const a = liveArenaOf(el);
  if (a) a.dom.setScrollOffset(el._nid, x, y);
}
// …and the geometry of the box the last layout left on a node (geometry.rs), each written to the Float64Array `out`:
// what the scroll offsets around it come to (`scrollShift`, `[x, y]`), and,
// each false where there is none, how far a sticky box has stuck (`stickyOffset`, `[x, y]`), its box where the page's
// scrolling carried it (`laidOutBox`, `[x, y, w, h]`), that box as the page measures it (`renderedBox`), the 4x4
// that maps it to the viewport (`transformChain`), its scrollable overflow region's size and the edges it scrolls
// from (`scrollSize`, `[w, h, fromLeft, fromTop]`) and the box itself with what the pass placed it by (`boxInfo`,
// geometry.rs `BOX_INFO`). A node in ANOTHER realm's arena — an element a frame's document
// handed to its parent's, or the other way about — is laid out by that realm, which lays its document out first
// (`REALM.ensureLayout`): this realm's layout never wrote it a box.
function laidOutArenaOf(node) {
  const a = node && liveArenaOf(node);
  if (a && a !== currentArena()) a.realm.ensureLayout();
  return a;
}
export function scrollShiftOf(el, out) {
  const a = laidOutArenaOf(el);
  if (a) a.dom.scrollShift(el._nid, out);
  else out.fill(0);
}
export function stickyOffsetOf(el, out) {
  const a = laidOutArenaOf(el);
  return a ? a.dom.stickyOffset(el._nid, out) : false;
}
export function laidOutBoxOf(el, out) {
  const a = laidOutArenaOf(el);
  return a ? a.dom.laidOutBox(el._nid, out) : false;
}
export function renderedBoxOf(el, out) {
  const a = laidOutArenaOf(el);
  return a ? a.dom.renderedBox(el._nid, out) : false;
}
export function transformChainOf(el, out) {
  const a = laidOutArenaOf(el);
  return a ? a.dom.transformChain(el._nid, out) : false;
}
export function scrollSizeOf(el, out) {
  const a = laidOutArenaOf(el);
  return a ? a.dom.scrollSize(el._nid, out) : false;
}
export function boxInfoOf(el, out) {
  const a = laidOutArenaOf(el);
  return a ? a.dom.boxInfo(el._nid, out) : false;
}
// …an inline box's fragments, `[x, y, w, h]` each (`boxFragments`), and a positioned box's insets as `getComputedStyle`
// reports them (`usedInsets`: the declared sides, then the used ones).
export function fragmentsIn(el) {
  const a = laidOutArenaOf(el);
  return a ? a.dom.boxFragments(el._nid) : [];
}
export function usedInsetsOf(el, out) {
  const a = laidOutArenaOf(el);
  return a ? a.dom.usedInsets(el._nid, out) : false;
}
// …and whether an element is its fieldset's rendered legend (`renderedLegend`) — a question of the style engine's values
// alone, asked of the arena the element is in.
export function renderedLegendOf(el) {
  const a = liveArenaOf(el);
  return a ? a.dom.renderedLegend(el._nid) : false;
}
// …and what the painting order of the last layout says (hit_test.rs): whether a box is clipped away whole by one that
// clips it (`clippedAway`), the elements a hit at a viewport point of `doc` lands on, topmost first (`hitTest`; only the
// topmost unless `all`), and the order the painter draws `layers` in (`paintOrder`: each a box, or `{contentOf}` the
// content a box owns) — each at the page's clock `now`, which decides what an animation makes a stacking context of.
export function clippedAwayOf(el) {
  const a = laidOutArenaOf(el);
  return a ? a.dom.clippedAway(el._nid) : false;
}
export function hitTestIn(doc, x, y, all, now) {
  const a = liveArenaOf(doc);
  return a ? nodesAtPaths(doc, a.dom.hitTest(x, y, all, now)) : [];
}
export function paintOrderIn(doc, layers, now) {
  const a = liveArenaOf(doc);
  if (!a) return layers;
  const nids = new Float64Array(layers.length), contents = new Float64Array(layers.length);
  for (let i = 0; i < layers.length; i++) {
    const el = layers[i].contentOf || layers[i];
    nids[i] = el._nid;
    contents[i] = layers[i].contentOf ? 1 : 0;
  }
  return Array.from(a.dom.paintOrder(nids, contents, now), (i) => layers[i]);
}
// The nodes a native answer names by their paths from the document, `[length, nid, …]` each, walked down to: each
// node's child, or the shadow root of a host, that has the next nid.
function nodesAtPaths(doc, rows) {
  const out = [];
  for (let at = 0; at < rows.length; at += rows[at] + 1) {
    const node = nodeAtPath(doc, rows, at + 1, rows[at]);
    if (node) out.push(node);
  }
  return out;
}
function nodeAtPath(doc, rows, at, length) {
  if (doc._nid !== rows[at]) return null;
  let node = doc;
  for (let k = 1; k < length; k++) {
    const nid = rows[at + k];
    const sr = node._shadowRoot;
    if (sr && sr._nid === nid) { node = sr; continue; }
    const kids = node._children;
    let next = null;
    for (let i = 0; i < kids.length; i++) if (kids[i]._nid === nid) { next = kids[i]; break; }
    if (next === null) return null;
    node = next;
  }
  return node;
}
// …and the layout a page laid out as its root box alone (`layoutRootAlone`) leaves there: that box, against viewport
// `vp`, and no other.
export function layoutRootAloneIn(root, box, vp) {
  const a = liveArenaOf(root);
  if (a) a.dom.layoutRootAlone(root._nid, box.width, box.height, vp.width, vp.height);
}

// `node`'s nid in arena `a`, registering it there when it has none in it — a node that predates `__dom` (an element
// with the plain-object attributes it was built with), one another arena holds (another realm's, or this realm's
// before a reset), which comes with its attributes, their namespaces and its subtree. -1 without `__dom`.
function nodeIn(node, a) {
  if (node._nidArena === a && node._nid >= 0) return node._nid;
  if (!a.dom) return -1;
  if (node.nodeType === NODE_ELEMENT) {
    // The attributes come along: a plain object (from before `__dom`) or another arena's attrsView reads them; a
    // reset arena's view reads nothing, which is what that element has left.
    const flat = [];
    const attrs = node._attrs;
    if (attrs) for (const name in attrs) flat.push(name, attrs[name]);
    registerNativeElement(node, a);
    if (flat.length) a.dom.syncAttrs(node._nid, flat);
    if (node._attrNS) for (const key in node._attrNS) setAttrMeta(node, key, node._attrNS[key]);
    if (node._formOwner) a.dom.setParserFormOwner(node._nid, nodeIn(node._formOwner, a));
    if (node._internals && node._internals._states.size) a.dom.setCustomStates(node._nid, customStateNames(node));
  } else {
    registerNativeNode(node, a);
  }
  // …and its subtree comes with it — a template's contents and a shadow tree too, which hang off it outside its
  // child list.
  if (node._children && node._children.length) syncChildrenIn(node, a);
  if (node._templateContent) nodeIn(node._templateContent, a);
  if (node._shadowRoot) {
    a.dom.setShadowHost(nodeIn(node._shadowRoot, a), node._nid);
    a.realm.shadowHosted(node._shadowRoot);
  }
  return node._nid;
}
// The arena a tree change on `parent` is kept in: the parent's own, or — unregistered, or its arena reset — this
// realm's.
function arenaFor(parent) {
  return liveArenaOf(parent) || currentArena();
}

// Flush a flat [name, value, …] attribute list into `el`'s arena node in ONE crossing (syncAttrs
// replaces the node's attributes wholesale). The parse-time attribute apply uses this instead of N
// per-attribute attrsView interceptor writes — restoring the pre-store-flip economics: the plain-object
// `{}` it replaced took zero crossings per element, a batched syncAttrs takes one. `flat` MUST be the
// element's COMPLETE final attribute set (the caller seeds it with any pre-existing attrs for the adopt
// path), since the write is wholesale. Returns false — leaving `_attrs` untouched — before __dom,
// where `_attrs` is a plain object the caller writes into directly.
export function syncNativeAttrs(el, flat) {
  const a = liveArenaOf(el);
  if (!a) return false;
  // Nothing to flush: an attribute-less element — the common case, a large
  // fraction of any page's nodes — keeps its eager arena node's empty attribute
  // vec and pays NO crossing, just as the plain object it replaced took zero. A
  // wholesale syncAttrs([]) would only re-clear an already-empty node (every
  // path here reaches an empty `flat` only on an already-empty node: a fresh
  // ctor node, a re-registered skeleton, or an adopt with nothing to add).
  if (flat.length === 0) return true;
  a.dom.syncAttrs(el._nid, flat);
  return true;
}

// An attribute's namespace record (`_attrNS[key]`: ns / prefix / localName), set or — `meta` null — dropped, and
// mirrored into the arena, which answers a namespaced question (`:any-link` on an SVG `<a>` with an XLink href) by it.
export function setAttrMeta(el, key, meta) {
  if (meta) (el._attrNS || (el._attrNS = {}))[key] = meta;
  else if (el._attrNS) delete el._attrNS[key];
  const a = liveArenaOf(el);
  if (a) a.dom.setAttrNamespace(el._nid, key, meta && meta.ns ? meta.ns : '', meta ? meta.localName : key);
}

// Clear this realm's arena for a new page. Called at the START of every in-place load (parseHtmlIntoLive), BEFORE
// the tokenizer constructs the new page's nodes — so this is the ONE per-page reset: nodes create their arena nodes at
// construction, and those must land in a FRESH arena, not pile onto the previous page's (the native Dom slot is
// isolate-level and survives a context reset, so realm 0 is reused across visits). The old arena is marked dead, so
// every node still holding one of its nids is registered afresh where it next joins a tree. The reused Document gets
// its node back here; the reused `<html>`/`<head>`/`<body>` skeleton in resetReusedElement. No-op before `__dom`.
export function invalidateArena() {
  const d = globalThis.__dom;
  if (!d) return;
  if (arena !== null) arena.dead = true;
  arena = newArena();
  d.resetArena();
  d.setFocusRingHidden(globalThis.__csimFocusVisible === false);
  const doc = globalThis.document;
  if (doc) registerNativeNode(doc);
}

// ── keeping it linked ──────────────────────────────────────────────────────────────────────────────────────────
// A child-list change on `parent`, from the mutation chokepoint: its children are made exactly the JS list, in the
// parent's arena (a removal is an absence; a node from anywhere else is registered there and re-homed).
export function syncArenaChildList(parent) {
  if (!globalThis.__dom || !parent) return;
  const a = arenaFor(parent);
  if (nodeIn(parent, a) < 0) return;
  syncChildrenIn(parent, a);
}
function syncChildrenIn(parent, a) {
  const kids = parent._children;
  const nids = [];
  if (kids) for (let i = 0; i < kids.length; i++) nids.push(nodeIn(kids[i], a));
  a.dom.syncChildren(parent._nid, nids);
}

// …and a tree built by direct child-list writes (a clone, a new document's skeleton): every parent in it, once.
export function syncArenaSubtree(root) {
  if (!globalThis.__dom || !root) return;
  const kids = root._children;
  if (!kids || kids.length === 0) { nodeIn(root, arenaFor(root)); return; }
  syncArenaChildList(root);
  for (let i = 0; i < kids.length; i++) syncArenaSubtree(kids[i]);
}

// A child-list change on `target` as its mutation record tells it: the `added` nodes, now before `next` (or last; a
// record that names no next sibling has them found where they are), and the `removed` ones. Applied node by node, so a loop of single appends costs O(1) each — relisting the parent
// per change made building a list quadratic; a bulk change relists it once instead. A removed node that has a parent
// again is left to the record of where it went (or to this one's additions, when it came back here).
const RELIST_AT = 16;
export function arenaChildListChanged(target, added, removed, next) {
  if (!globalThis.__dom || !target) return;
  if (added.length + removed.length > RELIST_AT) { syncArenaChildList(target); return; }
  const a = arenaFor(target);
  const pn = nodeIn(target, a);
  if (pn < 0) return;
  for (let i = 0; i < removed.length; i++) {
    const r = removed[i];
    if (r._parent == null && liveArenaOf(r) === a) a.dom.removeChild(r._nid);
  }
  if (next === undefined && added.length) {
    const kids = target._children, last = added[added.length - 1];
    const i = kids[kids.length - 1] === last ? kids.length - 1 : kids.indexOf(last);
    next = i >= 0 ? kids[i + 1] || null : null;
  }
  const ref = next ? nodeIn(next, a) : -1;
  for (let i = 0; i < added.length; i++) a.dom.insertChild(pn, nodeIn(added[i], a), ref);
}

// The parser's per-node steps: `node` inserted into `parent` (before `ref`, or last), and `node` removed.
export function arenaInsert(parent, node, ref) {
  if (!globalThis.__dom) return;
  const a = arenaFor(parent);
  const pn = nodeIn(parent, a);
  if (pn >= 0) a.dom.insertChild(pn, nodeIn(node, a), ref ? nodeIn(ref, a) : -1);
}
export function arenaRemove(node) {
  const a = liveArenaOf(node);
  if (a) a.dom.removeChild(node._nid);
}

// A character-data change (CharacterData's `_data` setter), and an append to it (`_appendData`).
export function syncArenaData(node, data) {
  const a = liveArenaOf(node);
  if (a) a.dom.setData(node._nid, data);
}
export function appendArenaData(node, data) {
  const a = liveArenaOf(node);
  if (a) a.dom.appendData(node._nid, data);
}

// ── the verify mode (CSIM_ARENA_VERIFY=1) ────────────────────────────────────────────────────────────────────────
const ARENA_KIND = { [NODE_ELEMENT]: 1, [NODE_TEXT]: 3, [NODE_CDATA]: 3, [NODE_COMMENT]: 8, [NODE_PI]: 7, [NODE_DOC]: 9, [NODE_FRAGMENT]: 11 };
// The whole tree under `root` (templates' contents and shadow roots included) against the arena: every node
// registered, of its kind, with its data, its parent and exactly its children. Throws the first difference.
export function verifyArena(root) {
  const d = globalThis.__dom;
  if (!d || !root) return;
  const seen = new Set();
  const visit = (n, parentNid) => {
    if (seen.has(n)) return;
    seen.add(n);
    const where = () => (n._tag ? '<' + n._tag + '>' : '#' + n.nodeType) + (n._attrs && n._attrs.id ? '#' + n._attrs.id : '');
    if (arenaNid(n) < 0) throw new Error('[csim] arena verify: unregistered ' + where() + ' via ' + (n._host ? '<' + n._host._tag + '> content' : n.host ? 'shadow of <' + n.host._tag + '>' : '-') + ' nid=' + n._nid + ' kids=' + (n._children || []).length + ' hostHere=' + !!(n.host && arenaNid(n.host) >= 0) + ' chain=' + (() => { const out = []; for (let x = n.host; x; x = x._parent) out.push((x._tag || '#' + x.nodeType) + (x === globalThis.document ? '(main)' : '')); return out.join('<'); })());
    const info = d.inspectNode(n._nid);
    if (info === null) throw new Error('[csim] arena verify: dead nid for ' + where());
    const kind = ARENA_KIND[n.nodeType] ?? 0;
    if (info[0] !== kind) throw new Error('[csim] arena verify: kind ' + info[0] + ' for ' + where());
    if ((kind === 3 || kind === 7 || kind === 8) && info[2] !== String(n._data ?? '')) throw new Error('[csim] arena verify: stale data in ' + where() + ' under ' + (n._parent ? n._parent._tag : '-'));
    if (kind === 7 && info[1] !== n._target) throw new Error('[csim] arena verify: target ' + JSON.stringify(info[1]) + ' for ' + where());
    if (parentNid !== undefined && info[3] !== parentNid) throw new Error('[csim] arena verify: wrong parent for ' + where());
    if (info[4] !== (n._csimState | 0)) throw new Error('[csim] arena verify: state ' + info[4] + ' for ' + where() + ', js ' + (n._csimState | 0));
    if (n._isShadowRoot && info[5] !== n.host._nid) throw new Error('[csim] arena verify: no host for the shadow root of <' + n.host._tag + '>');
    if (info[6] !== n.__value) throw new Error('[csim] arena verify: value ' + JSON.stringify(info[6]) + ' for ' + where() + ', js ' + JSON.stringify(n.__value));
    const kids = n._children || [];
    if (info.length - INSPECT_HEAD !== kids.length) {
      const js = kids.map((k) => (k._tag || '#' + k.nodeType) + ':' + k._nid).join(',');
      const na = info.slice(INSPECT_HEAD).map((id) => { const i = d.inspectNode(id); return (i ? (i[1] || '#' + i[0]) : 'dead') + ':' + id; }).join(',');
      throw new Error('[csim] arena verify: ' + kids.length + ' children, arena ' + (info.length - INSPECT_HEAD) + ' in ' + where() + ' js=[' + js + '] arena=[' + na + ']');
    }
    for (let i = 0; i < kids.length; i++) {
      if (kids[i]._nid !== info[INSPECT_HEAD + i]) throw new Error('[csim] arena verify: child ' + i + ' differs in ' + where());
      visit(kids[i], n._nid);
    }
    if (n._templateContent) visit(n._templateContent, undefined);
    if (n._shadowRoot) visit(n._shadowRoot, undefined);
  };
  visit(root, undefined);
}
// What inspectNode lists before the children: kind, local name, data, parent, state bits, host, live value.
const INSPECT_HEAD = 7;
let verifyOn;
export function maybeVerifyArena() {
  if (verifyOn === undefined) verifyOn = globalThis.__csimArenaVerify === true;
  if (verifyOn && globalThis.document) verifyArena(globalThis.document);
}
