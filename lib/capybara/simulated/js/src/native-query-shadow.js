// The native (Rust) arena: every node of every tree of this realm, MIRRORED from the JS DOM so the native readers see
// what a script sees (the attributes are no mirror — the arena IS their store, through the attrsView). This file
// owns the arena's lifecycle: a node joins it at construction, and a tree change is applied as it happens (see "the
// mirror" below). The arena is the isolate's — every realm's nodes, each with the slot it was made in for its life —
// and what is a realm's own (its document's focus, sheets, layout) is kept beside it per realm (dom.rs `RealmState`).
//
// Its readers: every selector match (selectors.js — querySelector, matches, closest) and the native style engine and
// layout, so the mirror must be exact: `CSIM_ARENA_VERIFY=1` checks it.
//
// A no-op before `__dom` exists (the snapshot's bootstrap).

import { NODE_ELEMENT, NODE_TEXT, NODE_CDATA, NODE_COMMENT, NODE_PI, NODE_DOC, NODE_DOCTYPE, NODE_FRAGMENT, HTML_NS } from './constants.js';

// A nid names a node's slot in the isolate's arena. Every registered node carries the realm whose tree it is in
// (`_nidArena`: that realm's `__dom`, which the ops that read a realm's own state — its style, its layout, its focus —
// are asked through): a node another realm made, inserted here, is this realm's from then on (`nodeIn`).
function newArena() {
  return { dom: globalThis.__dom, realm: REALM };
}
// What this realm answers about the nodes in its arena, for a reader in ANOTHER realm holding one of them: an element
// a parent's script made and put into a frame's document lives in the frame's arena, and its style, whether it is
// shown and the shadow hosts among it are the frame's to say — while every method it is called through is the
// parent's code. Filled in by the modules that answer (cascade.js, dom-nodes.js, mutation-observer.js), which this one
// cannot import.
export const REALM = { shadowHosted: () => {}, ensureLayout: () => {}, markLayoutDirty: () => {} };
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
function liveArenaOf(node) {
  const a = node._nidArena;
  return a && node._nid >= 0 ? a : null;
}
// `node`'s nid in THIS realm's arena, or -1 — for a reader that asks the arena about a node (the cascade's matcher).
export function arenaNid(node) {
  return node._nidArena === arena && arena !== null && node._nid >= 0 ? node._nid : -1;
}

// ── the mirror ───────────────────────────────────────────────────────────────────────────────────────────────
// EVERY node is in an arena from its construction — elements, text, comments, doctypes, documents, fragments and
// shadow roots — and every tree is kept linked there, the document's, a detached subtree's, a template's contents',
// a DOMParser document's: a native reader sees the tree a script sees (text included), whatever it asks about.
// Three kinds of write keep it so: a node's creation (`registerNative*`), an edge written (tree.js, the one writer of
// the tree's edges, which writes the arena's with them: `arenaInsert` / `arenaRemove` / `syncArenaChildList` /
// `clearArenaChildList`) and a character-data change (CharacterData's `_data` setter → `syncArenaData`). A query answers
// from the arena alone — the nodes it found as themselves, or by their paths in the JS tree (`nodesAtPaths`) — so
// `CSIM_ARENA_VERIFY=1` holds the whole JS tree against it at every layout and cascade entry; what it finds is kept by
// the runtime for the harness (`__csim_arenaVerifyFailed`) as well as thrown.
//
// A node moving into another realm's tree keeps its slot, and becomes that realm's the first time an edge write or a
// child-list sync names it there (`nodeIn`).

// An ELEMENT's arena node, created at construction (the Element ctor), for the element's life — its slot freed with its
// handle (node_handle.rs): the arena IS its attribute store (`_attrs` becomes the attrsView over it).
export function registerNativeElement(el) {
  const a = currentArena();
  if (!a.dom) return;
  // (…in the namespace the element was made in: one in none crosses as '' — it is no HTML element, not to `:any-link`,
  // nor to a type selector's case rule)
  const nid = a.dom.importNode(el._localName, el._ns ?? '', -1, [], el._prefix ?? null, el);
  el._nid = nid;
  el._nidArena = a;
  el._attrs = a.dom.attrsView(nid);
}

// ── element state ────────────────────────────────────────────────────────────────────────────────────────────
// What a script or the user did to an element that no attribute records — the state pseudo-classes' input (dom.rs
// `STATE_*`, read by element_state.rs): its arena node's, the engine's alone (`__dom.state` / `setState`). An element
// with no arena node — the snapshot's warm-up's — has none.
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
export const STATE_SELECTED_DIRTY   = 1 << 16;
export const STATE_SELECTED_INIT    = 1 << 17;
export const STATE_UPGRADED         = 1 << 18;
// `el`'s bits under `mask` become `bits`.
export function setElementState(el, mask, bits) {
  const a = liveArenaOf(el);
  if (!a) return;
  const had = a.dom.setState(el._nid, mask, bits);
  // (…an option's selectedness is what its drop-down SHOWS, laid out in it — walk.rs `control_text`)
  if (mask & STATE_SELECTED && (had & STATE_SELECTED) !== (bits & STATE_SELECTED)) markShownText(el);
}
// …and its bits.
export function stateOf(el) {
  const a = liveArenaOf(el);
  return a ? a.dom.state(el._nid) : 0;
}
// …and its live value (`undefined`: back to its default), which is what the control shows — the engine's alone.
export function liveValueOf(el) {
  const a = liveArenaOf(el);
  return a ? a.dom.value(el._nid) : undefined;
}
export function setElementValue(el, value) {
  const a = liveArenaOf(el);
  if (!a) return;
  a.dom.setValue(el._nid, value);
  markShownText(el);
}
// What a control shows is laid out in its box, so a change to it is a layout change — through the global, as an import
// of mutation-observer.js from here would be a cycle (it imports this module).
export function markShownText(el) {
  if (globalThis.__csimMarkLayoutDirty) globalThis.__csimMarkLayoutDirty(el);
}
// …and an `<img>`'s decoded image's natural size (`[width, height, viewBoxWidth, viewBoxHeight]`, NaN for one it has
// not; null: nothing decoded), which the layout sizes it from.
export function setElementNaturalSize(el, natural) {
  const a = liveArenaOf(el);
  if (!a) return;
  if (natural) a.dom.setNaturalSize(el._nid, natural[0], natural[1], natural[2], natural[3]);
  else a.dom.setNaturalSize(el._nid);
}
// The elements of `node`'s shadow-including subtree an upgrade has been tried on, in shadow-including tree order — the
// ones a tree change owes custom element reactions (custom_elements.rs).
export function upgradedElementsIn(node) {
  const a = liveArenaOf(node);
  return a ? nodesAtPaths(node, a.dom.upgradedElementsIn(node._nid)) : [];
}
// A node's rare data (node_handle.rs `rareData`, Blink's): what the bindings keep for it that is script objects, not the
// engine's data — its [SameObject] collections, a file input's files — made with `make` where it has none, else
// undefined. (…a node with no handle — the snapshot's warm-up's, a plain object made before the engine is, or a
// generated box's holder — keeps its own.)
export function rareDataOf(node, make) {
  const d = globalThis.__dom;
  const held = d === undefined ? undefined : d.rareData(node, make === true);
  if (held !== undefined) return held;
  if (node._rare === undefined && make === true) node._rare = Object.create(null);
  return node._rare;
}
// …and one of its members, made by `create` where it has none — a [SameObject] attribute's object.
export function sameObject(node, key, create) {
  const rare = rareDataOf(node, true);
  return rare[key] ?? (rare[key] = create(node));
}
// A select's selected options, in its list of options' order (the first alone, with `first`), and the index of the
// first there, -1 with none (validity.rs `selected_options`)…
export function selectedOptionsOf(select, first) {
  const a = liveArenaOf(select);
  return a ? nodesAtPaths(select, a.dom.selectedOptions(select._nid, first === true)) : [];
}
export function selectedIndexOf(select) {
  const a = liveArenaOf(select);
  return a ? a.dom.selectedIndex(select._nid) : -1;
}
// …and the options whose selectedness changed as the index-th, or the first of `value`, is picked (`select_option`) —
// through the select's own realm, whose style engine restyles its options.
export function selectOptionAt(select, index) {
  const a = liveArenaOf(select);
  return a ? nodesAtPaths(select, a.dom.selectIndex(select._nid, index)) : [];
}
export function selectOptionOfValue(select, value) {
  const a = liveArenaOf(select);
  return a ? nodesAtPaths(select, a.dom.selectValue(select._nid, value)) : [];
}
// Is `bit` set on `el`, and set it to `on`: the flags (indeterminate, popover open, modal, filtered).
export function hasState(el, bit) {
  return (stateOf(el) & bit) !== 0;
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
// A custom element's custom states (`ElementInternals.states`, `states` their backing Set of strings), which `:state()`
// reads, mirrored whole — a handful at most.
export function syncCustomStates(el, states) {
  const a = liveArenaOf(el);
  if (!a) return;
  // (…read by the intrinsic Set iterator, which a page's Set.prototype[Symbol.iterator] is not)
  const names = [], it = setValues.call(states);
  for (let r = setIteratorNext.call(it); !r.done; r = setIteratorNext.call(it)) names.push(r.value);
  a.dom.setCustomStates(el._nid, names);
}
const setValues = Set.prototype.values;
const setIteratorNext = Object.getPrototypeOf(new Set().values()).next;
// The realm's focus ring: shown (`:focus-visible`) unless the focus came from a pointer onto a non-text control.
export function setFocusVisible(visible) {
  globalThis.__csimFocusVisible = visible;
  const d = globalThis.__dom;
  if (d) d.setFocusRingHidden(!visible);
}
// `sr` is attached to `host`: its arena node learns its host, which the shadow-including state walks cross.
// The realm whose tree `node` is in (its `dom` answers about it). Null before `__dom`.
export function nodeArena(node) {
  return liveArenaOf(node);
}

// …and the realm whose tree it is counts the host (`REALM.shadowHosted`): the one whose sheets it feeds — attached
// here, or adopted with its host from another realm's tree (`adoptInto`), whose realm counted it where this one has
// never heard of it.
export function arenaAttachShadow(host, sr) {
  if (!globalThis.__dom) { REALM.shadowHosted(sr); return; }
  const a = arenaFor(host);
  const hn = nodeIn(host, a);
  if (hn >= 0) linkShadow(a, sr, hn);
  a.realm.shadowHosted(sr);
}
// The shadow root `sr` of the host `hostNid`, in the arena `a` — and whether it delegates focus, assigns its slots by
// hand and is closed, which only this link carries there.
function linkShadow(a, sr, hostNid) {
  a.dom.setShadowHost(nodeIn(sr, a), hostNid, !!sr._delegatesFocus, sr._slotAssignment === 'manual', sr.mode === 'closed');
}

// ── slot assignment (slots.rs) ───────────────────────────────────────────────────────────────────────────────
const EMPTY = [];
// Assign the slots of the shadow root `sr` (or none) and of `left`, slots that have left a shadow tree, and hand
// `changed(slot, left)` each slot whose assigned nodes changed, with the nodes that left it.
export function assignSlots(sr, left, changed) {
  const a = (sr && liveArenaOf(sr)) || (left && left.length && liveArenaOf(left[0]));
  if (!a) return;
  const nids = [];
  if (left) for (const s of left) if (liveArenaOf(s)) nids.push(s._nid);
  const root = sr && liveArenaOf(sr) ? sr : null;
  const answer = a.dom.assignSlots(root ? root._nid : -1, nids);
  if (!answer || answer.length === 0) return;
  // (…a slot listed by its index in `nids`, any other by its path; every path from the tree's shadow-including root, or
  // without one the slot's)
  const tree = root && shadowIncludingRoot(root);
  for (let at = 0; at < answer.length;) {
    let slot;
    if (answer[at] >= 0) {
      slot = left.find((s) => s._nid === nids[answer[at]]);
      at += 1;
    } else {
      slot = nodeAtPath(tree, answer, at + 1);
      at = pathEnd;
    }
    const anchor = tree || shadowIncludingRoot(slot);
    const count = answer[at++];
    const gone = [];
    for (let i = 0; i < count; i++) {
      const n = nodeAtPath(anchor, answer, at);
      if (n) gone.push(n);
      at = pathEnd;
    }
    if (slot) changed(slot, gone);
  }
}
// The slot `node` (a host's child) is assigned to, or null — found from the host.
export function assignedSlotOf(node) {
  const a = liveArenaOf(node);
  const host = node._parent;
  const answer = a && host && a.dom.assignedSlotOf(node._nid, host._nid);
  return answer ? nodesAtPaths(host, answer)[0] || null : null;
}
// A slot's assigned nodes — its host's children, their paths from the host — or with `flatten`, its flattened ones,
// which may be any host's: their paths from the slot's shadow-including root.
export function assignedNodesOf(slot, flatten) {
  const a = liveArenaOf(slot);
  if (!a) return [];
  let anchor = slot;
  if (flatten) anchor = shadowIncludingRoot(slot);
  else {
    while (anchor._parent && !anchor._isShadowRoot) anchor = anchor._parent;
    if (anchor._isShadowRoot) anchor = anchor._host;
  }
  return nodesAtPaths(anchor, a.dom.assignedNodesOf(slot._nid, flatten, anchor._nid));
}
// A slot's `assign()`ed nodes, for the engine.
export function syncManualAssigned(slot) {
  const a = liveArenaOf(slot);
  if (!a) return;
  const nids = [];
  for (const n of slot._manualAssignedNodes || EMPTY) if (liveArenaOf(n)) nids.push(n._nid);
  a.dom.setManualAssigned(slot._nid, nids);
}

// Any other node's: its kind and, for character data, its data.
export function registerNativeNode(node) {
  const a = currentArena();
  if (!a.dom) return;
  const doctype = node._nodeType === NODE_DOCTYPE;
  const data = node._nodeType === NODE_TEXT || node._nodeType === NODE_CDATA || node._nodeType === NODE_COMMENT ||
               node._nodeType === NODE_PI ? node._data : doctype ? node._name : null;
  // (…a doctype's name its data, and its public and system identifiers beside)
  node._nid = doctype ? a.dom.createNode(node._nodeType, String(data), -1, node._publicId, node._systemId, node)
    : a.dom.createNode(node._nodeType, data == null ? '' : String(data), -1, node._target ?? '', undefined, node);
  node._nidArena = a;
}
// A node made where its owner's tree is — `owner`'s realm, which is another than the one whose code made it when a
// frame's document holds `owner` (a template's contents, made by whichever realm's code first asked for them).
export function registerBeside(node, owner) {
  const a = liveArenaOf(owner);
  if (a && liveArenaOf(node) !== a) nodeIn(node, a);
}
// A `<template>`'s contents, linked where the arena serializes the template from (serialize.rs).
export function linkTemplateContent(template, content) {
  const a = liveArenaOf(template);
  if (a) a.dom.setTemplateContent(template._nid, content && liveArenaOf(content) ? content._nid : -1);
}
// …and a reused doctype's name and identifiers.
export function syncDoctype(dt) {
  const a = liveArenaOf(dt);
  if (a) a.dom.setDoctype(dt._nid, dt._name, dt._publicId, dt._systemId);
}
// …and the `is` value an element was made with.
export function setIsValueOf(el, value) {
  const a = liveArenaOf(el);
  if (a) a.dom.setIsValue(el._nid, value == null ? null : String(value));
}
export function isValueOf(el) {
  const a = liveArenaOf(el);
  return a ? a.dom.isValue(el._nid) : undefined;
}
// A node as XML — or, `inner`, its children — requiring it well-formed where `wellFormed` (serialize.rs): a string,
// or `[message]` where it has none.
export function serializedXml(node, inner, wellFormed) {
  const a = liveArenaOf(node);
  return a ? a.dom.serializeXml(node._nid, inner, wellFormed) : '';
}
// An element's or a fragment's children as HTML — or, `outer`, the element itself (serialize.rs), the shadow roots
// `shadows` names (`[host, openingTag, …]`) written in place.
export function serializedHtml(node, outer, shadows) {
  const a = liveArenaOf(node);
  if (!a) return '';
  return a.dom.serializeHtml(node._nid, outer, shadows ? shadows.map((x, i) => (i % 2 === 0 ? x._nid : x)) : undefined);
}

// …and one for a node that is only ever a BOX: a generated-content pseudo `node` (`localName`, `::before` or `::after`)
// of `el`, which is no part of the DOM — in the arena of its element, whose slot holds its slot (freed with it).
// It needs the arena slot — the shadow harness reads every box back by `_nid` (`boxOf`), and once native is
// the only engine that is how any box is read — but nothing else the registration carries. In particular no
// `attrsView`: a pseudo has no attributes ever (an `attr()` in its `content` resolves against the ORIGINATING
// element), while `_attrs.style` and `_attrs.align` ARE read of it per layout pass, and a view turns each of
// those misses from a 4.5 ns property read into a 98.9 ns crossing — measured, 16,076 reads and ~1.5 ms of an
// 87 ms relayout on a Tailwind-preflight page whose 1,605 elements carry 3,204 pseudos.
export function registerPseudoBox(el, node, localName, which) {
  const a = liveArenaOf(el);
  if (!a) return;
  if (node._nid == null) node._nid = a.dom.importNode(localName, HTML_NS, -1, [], null, node);
  node._nidArena = a;   // (…the realm its element's tree is, which its slot follows: `RealmArena::adopt`)
  // …and linked to its element, which no tree says: the walk lays the box out as the element's first / last child.
  // Linked while the box renders.
  a.dom.linkPseudoBox(el._nid, which === 'after' ? 1 : 0, node._nid);
}

// The scroll offset an element keeps in `axis` (0 x, 1 y) — kept in its arena beside its box, which the geometry shifts
// by it (geometry.rs) — and the write of one, each axis given as a number (`undefined` leaves it). One in no arena keeps
// none.
export function scrollOffsetOf(el, axis) {
  const a = liveArenaOf(el);
  return a ? a.dom.scrollOffset(el._nid, axis) : 0;
}
// …and the one it SHOWS (`scrollTop`): read once its realm is laid out, as a browser's is, so an offset whose content
// has shrunk since reads at its new end (geometry.rs `reclamp_scrolls`), and one with no box reads 0 — unless it keeps
// 0, which is in every range, so no layout can move it and the everyday read pays for none.
export function settledScrollOffsetOf(el, axis) {
  const a = liveArenaOf(el);
  if (!a || a.dom.scrollOffset(el._nid, axis) === 0) return 0;
  a.realm.ensureLayout();
  return a.dom.scrollOffset(el._nid, axis, true);
}
export function setScrollOffset(el, x, y) {
  const a = liveArenaOf(el);
  if (a) a.dom.setScrollOffset(el._nid, x, y);
}
// …and the geometry of the box the last layout left on a node (geometry.rs), each written to the Float64Array `out`:
// what the scroll offsets around it come to (`scrollShift`, `[x, y]`), and, each false where there is none, its box
// where the page's scrolling carried it (`laidOutBox`, `[x, y, w, h]`), that box as the page measures it
// (`renderedBox`), its scrollable overflow region's size (`scrollSize`, `[w, h]`), the range its offsets may take
// (`scrollRange`, `[min x, max x, min y, max y]`), its client box (`clientBox`, `[left, top, width, height]`) and the
// viewport a frame element gives its document (`frameViewport`, `[x, y, w, h]`).
// A node in ANOTHER realm's arena — an element a frame's document
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
export function laidOutBoxOf(el, out) {
  const a = laidOutArenaOf(el);
  return a ? a.dom.laidOutBox(el._nid, out) : false;
}
// …an IntersectionObserver's observations (intersection.rs) of `nids` — all in `node`'s arena — against the root
// `rootNid` there (-1: that realm's viewport), or null where `node` has no arena.
export function observeIntersectionsIn(node, rootNid, margin, thresholds, nids) {
  const a = laidOutArenaOf(node);
  return a ? a.dom.observeIntersections(rootNid, margin, thresholds, ...nids) : null;
}
// …a ResizeObserver's observations (resize_observation.rs) of `pairs` — `nid, laidOut` each, all in `node`'s arena —
// at `ratio` device pixels: eleven numbers a target (`resizeObservations`), or null where `node` has no arena.
export function resizeObservationsIn(node, ratio, pairs) {
  const a = laidOutArenaOf(node);
  return a ? a.dom.resizeObservations(ratio, ...pairs) : null;
}
export function renderedBoxOf(el, out) {
  const a = laidOutArenaOf(el);
  return a ? a.dom.renderedBox(el._nid, out) : false;
}
export function scrollSizeOf(el, out) {
  const a = laidOutArenaOf(el);
  return a ? a.dom.scrollSize(el._nid, out) : false;
}
// …the moves that bring `el` into view (scroll_into_view.rs), `[scroller nid, x, y, …]` innermost first: CSSOM's
// `scrollIntoView` with alignment codes (0 start, 1 center, 2 end, 3 nearest), or `ifNeeded` a driver's
// scroll-if-needed.
export function scrollIntoViewPlanOf(el, ifNeeded, block, inline) {
  const a = laidOutArenaOf(el);
  return a ? a.dom.scrollIntoViewPlan(el._nid, ifNeeded, block, inline) : null;
}
// …its client rects (`clientRects`, `[x, y, w, h]` each), and the map the painter draws it under (`paintTransform`: 0
// none, 1 the affine written to `out`, 2 one it cannot express) with the quad it clips that to (`paintQuad`).
export function clientRectsIn(el) {
  const a = laidOutArenaOf(el);
  return a ? a.dom.clientRects(el._nid) : null;
}
export function paintTransformOf(el, out) {
  const a = laidOutArenaOf(el);
  return a ? a.dom.paintTransform(el._nid, out) : 0;
}
export function paintQuadOf(el, out) {
  const a = laidOutArenaOf(el);
  return a ? a.dom.paintQuad(el._nid, out) : false;
}
// …each element's in its own realm's painting (a frame's target is the frame's document's), one painting per realm.
export function observedVisibleIn(els, now) {
  const out = new Map(), byArena = new Map();
  for (const el of els) {
    const a = laidOutArenaOf(el);
    if (!a) { out.set(el, false); continue; }
    if (!byArena.has(a)) byArena.set(a, []);
    byArena.get(a).push(el);
  }
  for (const [a, list] of byArena) {
    const answers = a.dom.observedVisible(Float64Array.from(list, (el) => el._nid), now);
    list.forEach((el, i) => out.set(el, answers[i] === 1));
  }
  return out;
}
export function clipBoxesIn(el, own) {
  const a = laidOutArenaOf(el);
  return a ? a.dom.clipBoxes(el._nid, own) : null;
}
export function offsetsIn(el, out) {
  const a = laidOutArenaOf(el);
  return a ? a.dom.offsets(el._nid, out) : false;
}
export function scrollRangeOf(el, out) {
  const a = laidOutArenaOf(el);
  return a ? a.dom.scrollRange(el._nid, out) : false;
}
export function clientBoxOf(el, out) {
  const a = laidOutArenaOf(el);
  return a ? a.dom.clientBox(el._nid, out) : false;
}
export function frameViewportOf(el, out) {
  const a = laidOutArenaOf(el);
  return a ? a.dom.frameViewport(el._nid, out) : false;
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
// The nodes `nids` (a Float64Array) names that are in `root`'s shadow-including tree, by nid — the engine's answer
// (dom.rs `nodesUnder`), in place of a walk of the tree for them.
export function nodesByNid(root, nids) {
  const [kept, answer] = globalThis.__dom.nodesUnder(root._nid, nids);
  const nodes = nodesAtPaths(root, answer);
  const byNid = new globalThis.Map();
  for (let i = 0; i < kept.length; i++) byNid.set(kept[i], nodes[i]);
  return byNid;
}
// The nodes a native answer names (dom.rs `nodes_value`): the objects themselves, where all are in a document (their
// handles hold them, node_handle.rs) — else each one's path from `anchor` (`RealmArena::push_path`): its length, then its
// steps down — a child's index, -1 a host's shadow root, -2 a template's contents — or a length of -1 for none.
export function nodesAtPaths(anchor, paths) {
  if (Array.isArray(paths)) return paths;
  const out = [];
  for (let at = 0; at < paths.length; at = pathEnd) {
    const node = nodeAtPath(anchor, paths, at);
    if (node) out.push(node);
  }
  return out;
}
// …one of them, the path starting at `paths[at]`; `endOfPath()` is where it ends.
export function nodeAtPath(anchor, paths, at) {
  const length = paths[at++];
  if (length < 0) { pathEnd = at; return null; }
  let node = anchor;
  for (const end = at + length; at < end; at++) {
    const step = paths[at];
    node = step >= 0 ? node._children[step] : step === -1 ? node._shadowRoot : node._templateContent;
  }
  pathEnd = at;
  return node;
}
let pathEnd = 0;
export function endOfPath() { return pathEnd; }
// The root of `node`'s tree, shadow-including: a shadow root's parent is its host (`RealmArena::shadow_including_root`).
function shadowIncludingRoot(node) {
  while (node._parent) node = node._parent;
  return node;
}
// …and the layout a page laid out as its root box alone (`layoutRootAlone`) leaves there: that box, against viewport
// `vp`, and no other.
export function layoutRootAloneIn(root, vp) {
  const a = liveArenaOf(root);
  if (a) a.dom.layoutRootAlone(root._nid, vp.width, vp.height);
}

// `node`'s nid, as a node of a tree of the realm `a` is: every node has its slot from its construction for its life, and
// one from another realm's tree keeps it, the tree's realm becoming `a`'s (`adoptInto`). -1 without `__dom`.
function nodeIn(node, a) {
  if (node._nidArena === a && node._nid >= 0) return node._nid;
  if (!a.dom) return -1;
  if (liveArenaOf(node)) return adoptInto(node, a);
  throw new Error('[csim] a node with no slot in the arena joined a tree');
}
// `node`, in the slot it has, and everything it holds — its children, shadow tree and template contents — now in a tree
// of the realm `a` is: theirs to answer for and to free. A parser form owner left outside goes (a pointer void once the
// control moved: following it would drag the form out of its own tree).
function adoptInto(node, a) {
  const owned = [];
  const walk = (n) => {
    n._nidArena = a;
    if (n._formOwner) owned.push(n);
    const p = n._pseudoNodes;   // (…its generated boxes, which the arena moves with it)
    if (p) for (const box of [p.before, p.after]) if (box && box._nidArena) box._nidArena = a;
    const kids = n._children;
    if (kids) for (let i = 0; i < kids.length; i++) walk(kids[i]);
    if (n._templateContent) walk(n._templateContent);
    if (n._shadowRoot) {
      walk(n._shadowRoot);
      a.realm.shadowHosted(n._shadowRoot);
    }
  };
  walk(node);
  a.dom.adoptSubtree(node._nid);
  for (const n of owned) if (liveArenaOf(n._formOwner) !== a) setParserFormOwner(n, null);
  return node._nid;
}
// The realm a tree change on `parent` is kept as: the parent's own, or — before `__dom` registered it — this one's.
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
  // ctor node, or an adopt with nothing to add — `clearNativeAttrs` empties one).
  if (flat.length === 0) return true;
  a.dom.syncAttrs(el._nid, flat);
  return true;
}
// …and every attribute of `el` gone from its arena node (the reused skeleton's, for a new page). False before __dom.
export function clearNativeAttrs(el) {
  const a = liveArenaOf(el);
  if (!a) return false;
  a.dom.syncAttrs(el._nid, []);
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

// A new page in this realm: its state in the arena afresh (`resetArena`). Called at the START of every in-place load
// (parseHtmlIntoLive), BEFORE the tokenizer constructs the new page's nodes. The nodes stay: the reused Document and
// `<html>`/`<head>`/`<body>` skeleton (resetReusedElement makes the skeleton's anew), a node the old page's script still
// holds; the old page's other nodes go as V8 collects them. No-op before `__dom`.
export function invalidateArena() {
  const d = globalThis.__dom;
  if (!d) return;
  d.resetArena();
  d.setFocusRingHidden(globalThis.__csimFocusVisible === false);
}

// ── keeping it linked ──────────────────────────────────────────────────────────────────────────────────────────
// A parent's list emptied (none before `__dom`).
export function clearArenaChildList(parent) {
  const a = liveArenaOf(parent);
  if (a) a.dom.syncChildren(parent._nid, []);
}
// …and made exactly the JS list, in the parent's arena (a removal is an absence; a node from anywhere else is registered
// there and re-homed) — a bulk edge change, and a query's re-sync.
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

// An edge written (tree.js, the one writer of the tree's edges): `node` inserted into `parent` (before `ref`, or last),
// and `node` removed.
export function arenaInsert(parent, node, ref) {
  if (!globalThis.__dom) return;
  const a = arenaFor(parent);
  const pn = nodeIn(parent, a);
  if (pn >= 0) a.dom.insertChild(pn, nodeIn(node, a), ref ? nodeIn(ref, a) : -1);
}
// (…answering the mutation observers the arena gave transient registered observers of the node — an array — or undefined)
export function arenaRemove(node) {
  const a = liveArenaOf(node);
  return a ? a.dom.removeChild(node._nid) : undefined;
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

// What the arena says of an element's constraint validation (validity.rs: its ValidityState flags, bit 0
// `valueMissing` … bit 9 `customError`; whether it is a candidate) and whether it is actually disabled
// (element_state.rs) — the answers `:valid`, `:invalid` and `:disabled` match by too.
export function validityFlagsOf(el) {
  const a = liveArenaOf(el);
  return a ? a.dom.validityFlags(el._nid) : 0;
}
export function willValidateOf(el) {
  const a = liveArenaOf(el);
  return !!a && a.dom.willValidate(el._nid);
}
export function actuallyDisabledOf(el) {
  const a = liveArenaOf(el);
  return !!a && a.dom.actuallyDisabled(el._nid);
}
// An `<input>`'s value sanitized as `type`, by its attributes (input_value.rs `sanitize`) — read on every `.value`,
// so a type with no sanitization keeps its value here, and so does a line of text with no newline in it, without the
// crossing (a hidden input's JSON blob is read on every form serialization)…
const UNSANITIZED_TYPES = new Set(['hidden', 'checkbox', 'radio', 'file', 'submit', 'image', 'reset', 'button']);
const LINE_TYPES = new Set(['text', 'search', 'tel', 'password']);
const NEWLINE = /[\r\n]/;
// …and an e-mail address that is already as sanitization leaves one: no newline, no whitespace at either end, an
// ASCII domain (one of several is left to native).
const PLAIN_EMAIL = /^[^\t\n\f\r ,](?:[^\r\n,]*[^\t\n\f\r ,])?$/;
function plainEmail(value) {
  if (!PLAIN_EMAIL.test(value)) return false;
  const domain = value.slice(value.lastIndexOf('@') + 1);
  for (let i = 0; i < domain.length; i++) if (domain.charCodeAt(i) > 0x7F) return false;
  return true;
}
export function sanitizedValueOf(el, type, value) {
  if (UNSANITIZED_TYPES.has(type) || (LINE_TYPES.has(type) && !NEWLINE.test(value))) return value;
  if (type === 'email' && el._attrs.multiple == null && plainEmail(value)) return value;
  const a = liveArenaOf(el);
  return (a ? a.dom : globalThis.__dom).inputSanitize(a ? el._nid : -1, type, value);
}
// …and the value `stepUp(delta)` makes of `value` (`step`): null for no change, undefined where there is no step.
export function steppedValueOf(el, type, value, delta) {
  const a = liveArenaOf(el);
  return (a ? a.dom : globalThis.__dom).inputStep(a ? el._nid : -1, type, value, delta);
}
// …and the URL an `<img>` fetches (image_source.rs `select`), a `media` judged on a viewport of that size.
export function imageSourceOf(img, width, height) {
  const a = liveArenaOf(img);
  return a ? a.dom.imageSource(img._nid, width, height) : img._attrs.src;
}
// …and whether its directionality is rtl (element_state.rs `is_rtl`, what `:dir()` matches).
export function isRtl(el) {
  const a = liveArenaOf(el);
  return !!a && a.dom.directionality(el._nid);
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
    const where = () => (n._tag ? '<' + n._tag + '>' : '#' + n._nodeType) + (n._attrs && n._attrs.id ? '#' + n._attrs.id : '');
    if (arenaNid(n) < 0) throw new Error('[csim] arena verify: unregistered ' + where() + ' via ' + (n._host ? '<' + n._host._tag + '> content' : n.host ? 'shadow of <' + n.host._tag + '>' : '-') + ' nid=' + n._nid + ' kids=' + (n._children || []).length + ' hostHere=' + !!(n.host && arenaNid(n.host) >= 0) + ' chain=' + (() => { const out = []; for (let x = n.host; x; x = x._parent) out.push((x._tag || '#' + x._nodeType) + (x === globalThis.document ? '(main)' : '')); return out.join('<'); })());
    const info = d.inspectNode(n._nid);
    if (info === null) throw new Error('[csim] arena verify: dead nid for ' + where());
    const kind = ARENA_KIND[n._nodeType] ?? 0;
    if (info[0] !== kind) throw new Error('[csim] arena verify: kind ' + info[0] + ' for ' + where());
    if ((kind === 3 || kind === 7 || kind === 8) && info[2] !== String(n._data ?? '')) throw new Error('[csim] arena verify: stale data in ' + where() + ' under ' + (n._parent ? n._parent._tag : '-'));
    if (kind === 7 && info[1] !== n._target) throw new Error('[csim] arena verify: target ' + JSON.stringify(info[1]) + ' for ' + where());
    if (parentNid !== undefined && info[3] !== parentNid) throw new Error('[csim] arena verify: wrong parent for ' + where());
    if (n._isShadowRoot && info[5] !== n.host._nid) throw new Error('[csim] arena verify: no host for the shadow root of <' + n.host._tag + '>');
    const edges = d.handleEdgesMismatch(n._nid);
    if (edges !== undefined) throw new Error('[csim] arena verify: ' + edges + ' for ' + where());
    const kids = n._children || [];
    if (info.length - INSPECT_HEAD !== kids.length) {
      const js = kids.map((k) => (k._tag || '#' + k._nodeType) + ':' + k._nid).join(',');
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
export function arenaVerifyOn() {
  if (verifyOn === undefined) verifyOn = globalThis.__csimArenaVerify === true;
  return verifyOn;
}
export function maybeVerifyArena() {
  // (…a document with no arena copy yet — a frame's bootstrap one, styled before its page is parsed — has nothing to
  // hold its tree against)
  if (!arenaVerifyOn() || !globalThis.document || globalThis.document._nidArena == null) return;
  try { verifyArena(globalThis.document); } catch (e) { arenaVerifyFailed(e.message); throw e; }
}
// A difference verify mode found, kept as well as thrown: a throw inside a rendering step or an event handler is
// swallowed by its caller, and what the runtime keeps (`__csim_arenaVerifyFailed`) is not — nor lost with the realm.
export function arenaVerifyFailed(message) {
  if (typeof globalThis.__csim_arenaVerifyFailed === 'function') globalThis.__csim_arenaVerifyFailed(String(message));
}
