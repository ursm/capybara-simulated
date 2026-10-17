// The native (Rust) arena: every node of every tree of this realm, MIRRORED from the JS DOM so the native readers see
// what a script sees (the attributes are no mirror — the arena IS their store, through the attrsView). This file
// owns the arena's lifecycle: a node joins it at construction, and a tree change is applied as it happens (see "the
// mirror" below). The arena is the isolate's — every realm's nodes, each with the slot it was made in for its life —
// and what is a realm's own (its document's focus, sheets, layout) is kept beside it per realm (dom.rs `RealmState`).
//
// Its readers: every selector match (selectors.js — querySelector, matches, closest) and the native style engine and
// layout, so the mirror must be exact: `CSIM_ARENA_VERIFY=1` checks it.

import { NODE_ELEMENT, NODE_TEXT, NODE_CDATA, NODE_COMMENT, NODE_PI, NODE_DOC, NODE_DOCTYPE, NODE_FRAGMENT, HTML_NS, SVG_NS } from './constants.js';

// The data of an element's child Text nodes (CDATA sections among them), in tree order: a `<title>`'s, a `<script>`'s —
// the engine's (element_state.rs `child_text`).
export const childTextContent = (el) => globalThis.__dom.childText(el);

// A nid names a node's slot in the isolate's arena, which keeps the realm whose tree the node is in (`__dom.realmOf`):
// that realm's arena object — its `__dom`, which the ops that read a realm's own state — its style, its layout, its
// focus — are asked through, and its answers — is the node's (`liveArenaOf`). A node another realm made, inserted
// here, is this realm's from then on (`nodeIn`).
function newArena() {
  const made = { dom: globalThis.__dom, realm: REALM };
  if (made.dom !== undefined) {
    made.dom.setArena(made);
    made.dom.setNodeFactory(REALM.nodeObject);
    made.dom.setCloneShadowRootHook(REALM.cloneShadowRoot);
  }
  return made;
}
// What this realm answers about the nodes in its arena, for a reader in ANOTHER realm holding one of them: an element
// a parent's script made and put into a frame's document lives in the frame's arena, and its style, whether it is
// shown and the shadow hosts among it are the frame's to say — while every method it is called through is the
// parent's code. Filled in by the modules that answer (cascade.js, dom-nodes.js, mutation-observer.js), which this one
// cannot import.
// (…and the realm's node factory: the object of a node the engine made, `nodeObject(nid, nodeType, localName, namespace,
// prefix)` — node_handle.rs `object_of` — and the shadow root a clone of a host attaches, `cloneShadowRoot(source, copy)`
// — cloning.rs `clone_shadow_root` — which the engine is told of with its arena; and an image of its document's "update
// the image data" that another realm's code asked for, `updateImageDataSoon(el)`)
export const REALM = {
  shadowHosted: () => {},
  ensureLayout: () => {},
  markLayoutDirty: () => {},
  sheetOf: () => null,
  nodeObject: () => undefined,
  cloneShadowRoot: () => null,
  upgradeCopies: () => {},
  updateImageDataSoon: () => {},
  refreshCascade: () => {}
};
// …the realm that answers for `node` when it is in another realm's arena, or null.
export function foreignRealmOf(node) {
  const a = liveArenaOf(node);
  return a !== null && a !== arena ? a.realm : null;
}
// The CSSStyleSheet of a style sheet owner — an HTML or SVG `<style>`, an HTML `<link>` — made by the realm whose tree it
// is in, whose style engine has its sheet (`REALM.sheetOf`, dom-nodes.js): one object whichever realm's code asks — a
// frame's `<style>` adopted into the parent's document read through the frame's `sheet`, or the parent's `styleSheets`.
export function sheetOfOwner(owner) {
  return (foreignRealmOf(owner) ?? REALM).sheetOf(owner);
}
let arena = null;
// This realm's arena, as of now.
function currentArena() {
  if (arena === null || arena.dom !== globalThis.__dom) arena = newArena();
  return arena;
}
function liveArenaOf(node) {
  const nid = node._nid, d = globalThis.__dom;
  if (!(nid >= 0)) return null;
  const realm = d.realmOf(nid);
  if (realm === d.realmId) return currentArena();
  return realm < 0 ? null : (d.arenaOf(realm) ?? null);
}
// `node`'s nid in THIS realm's arena, or -1 — for a reader that asks the arena about a node (the cascade's matcher).
export function arenaNid(node) {
  const nid = node._nid, d = globalThis.__dom;
  return nid >= 0 && d.realmOf(nid) === d.realmId ? nid : -1;
}

// ── the mirror ───────────────────────────────────────────────────────────────────────────────────────────────
// EVERY node is in an arena from its construction — elements, text, comments, doctypes, documents, fragments and
// shadow roots — and every tree is kept linked there, the document's, a detached subtree's, a template's contents',
// a DOMParser document's: a native reader sees the tree a script sees (text included), whatever it asks about.
// Three kinds of write keep it so: a node's creation (`registerNative*`), an edge written (tree.js, the one writer of
// the tree's edges: `arenaInsert` / `arenaRemove` / `arenaRemoveAll`) and a character-data change (CharacterData's `_data` setter → `__dom.setData`). A query answers
// from the arena alone — the nodes it found as themselves (dom.rs `nodes_value`); the tree's edges are the arena's own,
// and `CSIM_ARENA_VERIFY=1` holds what the bindings still keep beside it (a node's kind, the string its handle holds
// for its data, its host, and its handle's edges) against it at every layout and cascade entry; what it finds is kept by the runtime for the harness
// (`__csim_arenaVerifyFailed`) as well as thrown.
//
// A node moving into another realm's tree keeps its slot, and becomes that realm's the first time an edge write or a
// child-list sync names it there (`nodeIn`).

// The slot of a node the ENGINE made whose object its realm's factory is making (dom-nodes.js `engineNodeObject`;
// node_handle.rs `object_of`): the constructor binds the object to it — the object already wraps the node's handle
// (node_handle.rs `construct`) — where it would make a node of its own, and writes none of its state, the engine's.
let madeNode = -1;
export function makingObjectOf(nid) {
  madeNode = nid;
}
export function makingEngineObject() {
  return madeNode >= 0;
}
function takeMadeNode() {
  const nid = madeNode;
  madeNode = -1;
  return nid;
}

// An ELEMENT's arena node, created at construction (the Element ctor), for the element's life — its slot freed with its
// handle (node_handle.rs): the arena IS its attribute store (`_attrs` becomes the attrsView over it).
export function registerNativeElement(el) {
  const a = currentArena();
  // (…or the one the engine made, whose object this is: `makingObjectOf`)
  const made = takeMadeNode();
  if (made >= 0) {
    el._nid = made;
    el._attrs = a.dom.attrsView(made);
    return;
  }
  // (…in the namespace the element was made in: one in none crosses as '' — it is no HTML element, not to `:any-link`,
  // nor to a type selector's case rule)
  const nid = a.dom.importNode(el._localName, el._ns ?? '', -1, [], el._prefix ?? null, el);
  el._nid = nid;
  el._attrs = a.dom.attrsView(nid);
}

// ── element state ────────────────────────────────────────────────────────────────────────────────────────────
// What a script or the user did to an element that no attribute records — the state pseudo-classes' input (dom.rs
// `STATE_*`, read by element_state.rs): its arena node's, the engine's alone (`__dom.state` / `setState`).
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
export const STATE_USER_INTERACTED  = 1 << 14;
export const STATE_HAS_FILES        = 1 << 15;
export const STATE_SELECTED_DIRTY   = 1 << 16;
export const STATE_SELECTED_INIT    = 1 << 17;
export const STATE_UPGRADED         = 1 << 18;
export const STATE_XML_DOCUMENT     = 1 << 19;
export const STATE_DESIGN_MODE      = 1 << 20;
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
// …and its live value (`undefined`: back to its default), which is what the control shows — the engine's, whose
// element's handle holds the string it was given or made of it, so a read hands that back rather than copying the
// engine's (a 200K-character textarea's value read 5,000 times: 102 → 2 ms).
export function liveValueOf(el) {
  return globalThis.__dom.liveValue(el);
}
export function setElementValue(el, value) {
  if (globalThis.__dom.setLiveValue(el, value)) markShownText(el);
}
// …and the user typing `text` into it where `at` says (`TYPE_*`: at the caret, the value's end where no selection was
// ever set; over the whole value; at the selection a script reads, its start where none was set), the engine's to insert
// (text_selection.rs `type_text`): what that changed, `TYPED_VALUE` / `TYPED_SELECTION`, and above them how many code
// units of the text went in.
export const TYPED_VALUE = 1, TYPED_SELECTION = 2, TYPED_LENGTH_SHIFT = 2;
export const TYPE_AT_CARET = 0, TYPE_WHOLE = 1, TYPE_AT_SELECTION = 2;
export function typeIntoValue(el, text, at = TYPE_AT_CARET) {
  return valueEdited(el, globalThis.__dom.typeText(el, text, at));
}
// …or an editing key pressed in it (text_selection.rs `edit_control`, `EDIT_*`).
export const EDIT_BACKSPACE = 0, EDIT_DELETE = 1, EDIT_LEFT = 2, EDIT_RIGHT = 3, EDIT_HOME = 4, EDIT_END = 5, EDIT_TEXT_START = 6,
  EDIT_TEXT_END = 7, EDIT_WORD_LEFT = 8, EDIT_WORD_RIGHT = 9, EDIT_WORD_BACKSPACE = 10, EDIT_WORD_DELETE = 11,
  EDIT_LINE_BACKSPACE = 12, EDIT_EXTEND = 16, EDIT_AT_SELECTION = 32;
export function editValue(el, key) {
  return valueEdited(el, globalThis.__dom.editControl(el, key));
}
function valueEdited(el, changed) {
  if (changed & TYPED_VALUE) markShownText(el);
  return changed;
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
// A node's node document, and its setting (adoption, a node made for a document): its handle's — an object with none,
// an author's `Object.create(Node.prototype)`, keeps its own.
export function nodeDocumentOf(node) {
  const doc = globalThis.__dom.nodeDocument(node);
  return doc !== undefined ? doc : (node._doc ?? null);
}
export function setNodeDocumentOf(node, doc) {
  if (!globalThis.__dom.setNodeDocument(node, doc)) node._doc = doc;
}
// …and the node document of `root` and every node of its tree under it (not a shadow tree's, nor a template's
// contents): the engine's to set in one call, where it holds the tree.
export function setSubtreeDocumentOf(root, doc) {
  if (liveArenaOf(root) !== null) return globalThis.__dom.setSubtreeDocument(root._nid, doc);
  setNodeDocumentOf(root, doc);
  const kids = root._children;
  if (kids) for (let i = 0; i < kids.length; i++) setSubtreeDocumentOf(kids[i], doc);
}
// The elements of `node`'s shadow-including subtree an upgrade has been tried on, in shadow-including tree order — the
// ones a tree change owes custom element reactions (custom_elements.rs).
export function upgradedElementsIn(node) {
  const a = liveArenaOf(node);
  return a ? a.dom.upgradedElementsIn(node._nid) : [];
}
// The stylesheets' owners among `root`'s descendants (an HTML or SVG `<style>`, an HTML `<link>`), and the shadow hosts
// among its shadow-including ones, in tree order (collections.rs `elementsBy`) — none where there is no engine to ask.
export function sheetOwnersIn(root) {
  const a = liveArenaOf(root);
  return a ? a.dom.elementsBy(root._nid, 10) : [];
}
export function shadowHostsIn(root) {
  const a = liveArenaOf(root);
  return a ? a.dom.elementsBy(root._nid, 11) : [];
}
// …and every element of `root`'s shadow-including inclusive descendants, in shadow-including tree order; and of its
// inclusive descendants alone, in tree order.
export function shadowIncludingElementsIn(root) {
  const a = liveArenaOf(root);
  return a ? a.dom.elementsBy(root._nid, 14) : [];
}
// The link types a `rel` value names (HTML §4.6.7) — the engine's (token_list.rs `link_types`) — as `LINK_*` bits.
export const LINK_STYLESHEET = 1, LINK_ALTERNATE = 1 << 1, LINK_PREFETCH = 1 << 2, LINK_PRELOAD = 1 << 3,
  LINK_MODULEPRELOAD = 1 << 4, LINK_MANIFEST = 1 << 5, LINK_OPENER = 1 << 6, LINK_NOOPENER = 1 << 7, LINK_NOREFERRER = 1 << 8;
export const linkTypesOf = (rel) => (rel ? globalThis.__dom.linkTypes(String(rel)) : 0);
// The keyword a navigable target name is (navigables.rs `target_keyword`): a name, '' and `_self`, `_top`, `_parent`,
// `_blank`.
export const TARGET_NAME = 0, TARGET_SELF = 1, TARGET_TOP = 2, TARGET_PARENT = 3, TARGET_BLANK = 4;
export const targetKeywordOf = (target) => globalThis.__dom.targetKeyword(String(target ?? ''));
// What `window.open`'s features set (navigables.rs `open_features`), as `OPEN_*` bits.
export const OPEN_NOOPENER = 1, OPEN_NOREFERRER = 2;
export const openFeaturesOf = (features) => (features ? globalThis.__dom.openFeatures(features) : 0);
// …and `parent`'s children that are elements.
export function childElementsOf(parent) {
  const a = liveArenaOf(parent);
  return a ? a.dom.elementsBy(parent._nid, 15) : [];
}
export function inclusiveElementsIn(root) {
  const a = liveArenaOf(root);
  if (!a) return [];
  const found = a.dom.elementsBy(root._nid, 1, '*', '*');
  return root._nodeType === NODE_ELEMENT ? [root, ...found] : found;
}
// …and the elements of `root`, it included, that a custom element definition could be for (an HTML element with a
// hyphenated name or an `is` value), its `<script>`s (in any namespace) and its HTML `<slot>`s — in tree order, none
// where there is no engine to ask.
export function customElementCandidatesIn(root) {
  // (…a text or a childless element answered here, as most of a parse's top-level nodes are: no list call for them)
  if (childCountOf(root, false) === 0) {
    return root._nodeType === NODE_ELEMENT && root._ns === HTML_NS && (root._localName.includes('-') || isValueOf(root) != null) ? [root] : [];
  }
  const a = liveArenaOf(root);
  if (!a) return [];
  const found = a.dom.elementsBy(root._nid, 13);
  return root._nodeType === NODE_ELEMENT && root._ns === HTML_NS && (root._localName.includes('-') || isValueOf(root) != null)
    ? [root, ...found] : found;
}
export function scriptsIn(root) {
  const a = liveArenaOf(root);
  if (!a) return [];
  const found = a.dom.elementsBy(root._nid, 1, '*', 'script');
  return root._nodeType === NODE_ELEMENT && root._localName === 'script' ? [root, ...found] : found;
}
// …and the descendant elements with any of the state bits `mask`, in tree order.
export function elementsInState(root, mask) {
  const a = liveArenaOf(root);
  return a ? a.dom.elementsBy(root._nid, 12, mask) : [];
}
// …and the upgrade candidates of a definition just made (`localName`, and `is` for a customized built-in), in the same
// order — none where there is no engine to ask, before any document.
export function upgradeCandidatesIn(node, localName, is) {
  const a = liveArenaOf(node);
  return a ? a.dom.upgradeCandidates(node._nid, localName, is) : [];
}
// …and those of it with a connection step of their own (connection_steps.rs), in the same order — every element of its
// shadow-including subtree where no arena answers for it (its realm's gone: the nodes are the isolate's, which this
// realm's engine reads) — and what connecting one element runs (`CONNECT_*`: a fast call, 0 for none).
export function connectionStepElementsIn(node) {
  const a = liveArenaOf(node);
  return a ? a.dom.connectionStepElements(node._nid) : globalThis.__dom.elementsBy(node._nid, 14);
}
export const CONNECT_OPTION = 1, CONNECT_SELECT = 1 << 1, CONNECT_DIALOG = 1 << 2, CONNECT_SELECTEDCONTENT = 1 << 3;
export const CONNECT_MEDIA = 1 << 4, CONNECT_USE = 1 << 5, CONNECT_SCRIPT = 1 << 6, CONNECT_LINK = 1 << 7;
export const CONNECT_STYLE = 1 << 8, CONNECT_BACKGROUND = 1 << 9, CONNECT_SOURCE = 1 << 10, CONNECT_FRAME = 1 << 11;
export const CONNECT_DEFAULT_STYLE = 1 << 12, CONNECT_NONCE = 1 << 13, CONNECT_CUSTOM = 1 << 14;
export function connectionStepsOf(el) {
  return globalThis.__dom.connectionSteps(el._nid);
}
// The node one of DOM's tree accessors names from `node` (dom.rs `relativeNode`: `RELATIVE_*`), the engine's answer —
// none for an Attr, which is in no tree and holds no slot.
export const RELATIVE_PARENT = 0, RELATIVE_PARENT_ELEMENT = 1, RELATIVE_FIRST_CHILD = 2, RELATIVE_LAST_CHILD = 3,
  RELATIVE_PREVIOUS = 4, RELATIVE_NEXT = 5, RELATIVE_FIRST_ELEMENT = 6, RELATIVE_LAST_ELEMENT = 7,
  RELATIVE_PREVIOUS_ELEMENT = 8, RELATIVE_NEXT_ELEMENT = 9, RELATIVE_PARENT_OR_HOST = 10, RELATIVE_ROOT = 11,
  RELATIVE_SHADOW_INCLUDING_ROOT = 12, RELATIVE_HEAD = 13, RELATIVE_BODY = 14,
  RELATIVE_SHADOW_ROOT = 15, RELATIVE_HOST = 16, RELATIVE_TEMPLATE_CONTENT = 17, RELATIVE_DOCTYPE = 18;
export function relativeOf(node, kind) {
  return globalThis.__dom.relativeNode(node._nid, kind) ?? null;
}
// …its children, in a new array.
export function childNodesOf(node) {
  return globalThis.__dom.childNodes(node._nid) ?? [];
}
// …its index-th child, or null past the last (`childNodes`'s item).
export function childAtOf(node, index) {
  return globalThis.__dom.childAt(node._nid, index) ?? null;
}
// …and how many children it has (element ones alone, with `elements`).
export function childCountOf(node, elements) {
  return globalThis.__dom.childCount(node._nid, elements);
}
// A node's rare data (node_handle.rs `rareData`, Blink's): what the bindings keep for it that is script objects, not the
// engine's data — its [SameObject] collections, a file input's files — made with `make` where it has none, else
// undefined. (…an object with no handle — a generated box's holder, an author's `Object.create(Node.prototype)` —
// keeps its own.)
export function rareDataOf(node, make) {
  const held = globalThis.__dom.rareData(node, make === true);
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
  return a ? a.dom.selectedOptions(select._nid, first === true) : [];
}
export function selectedIndexOf(select) {
  const a = liveArenaOf(select);
  return a ? a.dom.selectedIndex(select._nid) : -1;
}
// …and the options whose selectedness changed as the index-th, or the first of `value`, is picked (`select_option`) —
// through the select's own realm, whose style engine restyles its options.
export function selectOptionAt(select, index) {
  const a = liveArenaOf(select);
  return a ? a.dom.selectIndex(select._nid, index) : [];
}
export function selectOptionOfValue(select, value) {
  const a = liveArenaOf(select);
  return a ? a.dom.selectValue(select._nid, value) : [];
}
// …likewise the selectedness setting algorithm's run (`selectedness`, `just` the option just selected), and a select's
// options' — or one option's — initialisation from their `selected` attributes (`initialise_options`).
export function runSelectedness(select, just) {
  const a = liveArenaOf(select);
  return a ? a.dom.selectedness(select._nid, just ? just._nid : -1) : [];
}
export function initialiseOptions(node) {
  const a = liveArenaOf(node);
  return a ? a.dom.initialiseOptions(node._nid) : [];
}
// …and the select a tree change asks for a reset (validity.rs `ask_for_reset`): `[select, changed options]`, or
// undefined where none is affected — in the parent's arena.
export function askForResetOf(parent, nodes, inserted) {
  const a = liveArenaOf(parent);
  return a ? a.dom.askForReset(parent._nid, nodes.map((n) => n._nid), inserted) : undefined;
}
// …and `node` (`inclusive`) or its nearest ancestor that is an HTML element named `name`, out of no element (validity.rs
// `html_ancestor`) — and the select whose list of options an option is in (`option_select`) — or null.
export function htmlAncestorOf(node, name, inclusive) {
  const a = liveArenaOf(node);
  return a ? a.dom.elementAncestor(node._nid, HTML_NS, name, !!inclusive) : null;
}
// …and its nearest ancestor that is an SVG `<svg>`.
export function svgAncestorOf(node) {
  const a = liveArenaOf(node);
  return a ? a.dom.elementAncestor(node._nid, SVG_NS, 'svg', false) : null;
}
export const optionSelectOf = (option) => globalThis.__dom.optionSelect(option._nid);
// Is `bit` set on `el`, and set it to `on`: the flags (indeterminate, popover open, modal, filtered).
export function hasState(el, bit) {
  return (stateOf(el) & bit) !== 0;
}
export function setStateBit(el, bit, on) {
  setElementState(el, bit, on ? bit : 0);
}
// The form the HTML parser's form element pointer gave a control, or none (the engine's): the one form owner the tree
// can't tell (`<table><form>…<input>`), which the native form owner falls back to as `formForControl` does.
export function setParserFormOwner(el, form) {
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
// The focus ring of the realm whose tree `el` — focused now — is in, latched: shown (`:focus-visible`) unless the focus
// came from a pointer onto a non-text control (`textEntry` false) — the engine's (dom.rs `latchFocusRing`), whose state
// moves the style state's generation where it changed: `:focus-visible` against `:focus` on the same focused element.
export function latchFocusRing(el, textEntry) {
  const d = globalThis.__dom;
  if (d) d.latchFocusRing(el._nid, textEntry);
}
// The realm whose tree `node` is in (its `dom` answers about it), or null for a realm gone.
export function nodeArena(node) {
  return liveArenaOf(node);
}

// `sr` is attached to `host`: its arena node learns its host, which the shadow-including state walks cross — and the
// realm whose tree it is counts the host (`REALM.shadowHosted`): the one whose sheets it feeds — attached
// here, or adopted with its host from another realm's tree (`adoptInto`), whose realm counted it where this one has
// never heard of it.
export function arenaAttachShadow(host, sr, init) {
  const a = arenaFor(host);
  const hn = nodeIn(host, a);
  if (hn >= 0) a.dom.setShadowHost(nodeIn(sr, a), hn, init);
  a.realm.shadowHosted(sr);
}
// A shadow root's init, the engine's (dom.rs `SHADOW_*`): whether it delegates focus, assigns its slots by hand, is
// closed, clonable, serializable, declarative — made by the parser, an `attachShadow` of its mode reusing it — and
// available to element internals; and a declarative one's `shadowrootadoptedstylesheets` as written.
export const SHADOW_DELEGATES_FOCUS = 1, SHADOW_MANUAL_SLOTS = 1 << 1, SHADOW_CLOSED = 1 << 2, SHADOW_CLONABLE = 1 << 3;
export const SHADOW_SERIALIZABLE = 1 << 4, SHADOW_DECLARATIVE = 1 << 5, SHADOW_INTERNALS = 1 << 6;
export const shadowIs = (sr, bit) => (globalThis.__dom.shadowInit(sr) & bit) !== 0;
export const setShadowIs = (sr, bit, on) => globalThis.__dom.setShadowInit(sr, bit, on);
export const shadowAdoptedSheets = (sr) => globalThis.__dom.shadowAdoptedSheets(sr);
export const setShadowAdoptedSheets = (sr, value) => globalThis.__dom.shadowAdoptedSheets(sr, value);

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
  if (!answer) return;
  const nodes = answer[0], counts = answer[1];
  for (let i = 0, at = 0; i < counts.length; i++) {
    const slot = nodes[at++];
    const gone = nodes.slice(at, at += counts[i]);
    changed(slot, gone);
  }
}
// The slot `node` (a host's child) is assigned to, or null.
export function assignedSlotOf(node) {
  const a = liveArenaOf(node);
  return (a && a.dom.assignedSlotOf(node._nid)[0]) ?? null;
}
// A slot's assigned nodes, or with `flatten`, its flattened ones.
// …and `assign()`: the slot's manually assigned nodes the ones given that are in its arena (slots.rs `assign_manual`) —
// the shadow roots whose assignments moved.
export function assignManual(slot, nodes) {
  const a = liveArenaOf(slot);
  if (!a) return EMPTY;
  const nids = [];
  for (const n of nodes) if (liveArenaOf(n)) nids.push(n._nid);
  return a.dom.slotAssign(slot._nid, nids);
}
export function assignedNodesOf(slot, flatten) {
  const a = liveArenaOf(slot);
  return a ? a.dom.assignedNodesOf(slot._nid, flatten) : [];
}
// Any other node's: its kind and, for character data, its data — a doctype's name and identifiers given (`doctype`:
// `[name, publicId, systemId]`), which the engine keeps.
export function registerNativeNode(node, doctype) {
  const made = takeMadeNode();
  if (made >= 0) {
    node._nid = made;
    return;
  }
  const a = currentArena();
  // (…a doctype's name its data, and its public and system identifiers beside)
  if (doctype) {
    node._nid = a.dom.createNode(NODE_DOCTYPE, doctype[0], -1, doctype[1], doctype[2], node);
    return;
  }
  const data = node._nodeType === NODE_TEXT || node._nodeType === NODE_CDATA || node._nodeType === NODE_COMMENT ||
               node._nodeType === NODE_PI ? node._data : null;
  node._nid = a.dom.createNode(node._nodeType, data == null ? '' : String(data), -1, node._target ?? '', undefined, node);
}
// A node made where its owner's tree is — `owner`'s realm, which is another than the one whose code made it when a
// frame's document holds `owner` (a template's contents, made by whichever realm's code first asked for them).
export function registerBeside(node, owner) {
  const a = liveArenaOf(owner);
  if (a && liveArenaOf(node) !== a) nodeIn(node, a);
}
// A `<template>`'s contents, linked where the arena serializes the template from (serialize.rs).
export function setTemplateContentOf(template, content) {
  arenaFor(template).dom.setTemplateContent(template._nid, content ? content._nid : -1);
}
// …a reused doctype's name and identifiers, as the parse gives them…
export function setDoctypeOf(dt, name, publicId, systemId) {
  const a = liveArenaOf(dt);
  if (a) a.dom.setDoctype(dt._nid, name, publicId, systemId);
}
// …and a doctype's name (0), public identifier (1) or system identifier (2).
export const doctypeField = (dt, field) => globalThis.__dom.doctypeField(dt._nid, field);
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
// An element's, a fragment's or a document's children as HTML — or, `outer`, the element itself (serialize.rs), the shadow roots
// `shadows` names (`[host, openingTag, …]`) written in place.
export function serializedHtml(node, outer, shadows) {
  const a = liveArenaOf(node);
  if (!a) return '';
  return a.dom.serializeHtml(node._nid, outer, shadows ? shadows.map((x, i) => (i % 2 === 0 ? x._nid : x)) : undefined);
}

// The slot of the box `el`'s `::before` or `::after` (`which`) generates — the walk's, made the first time it renders
// (dom.rs `link_generated`) — or undefined for one that never rendered.
export function generatedBoxOf(el, which) {
  const nid = liveArenaOf(el)?.dom.pseudoBox(el._nid, which === 'after' ? 1 : 0) ?? -1;
  return nid >= 0 ? nid : undefined;
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
// The open dialog a pointer press or release at client (x, y) on `target` is in (dialogs.rs `clickedDialog`) — a modal
// one's box read off its realm's layout, brought up to date first.
export function clickedDialogOf(target, x, y) {
  const a = liveArenaOf(target);
  if (!a) return null;
  if (target._nodeType === NODE_ELEMENT && hasState(target, STATE_MODAL)) a.realm.ensureLayout();
  return a.dom.clickedDialog(target, x, y);
}
// …and the geometry of the box the last layout left on a node (geometry.rs), each written to the Float64Array `out`,
// each false where there is none: its box where the page's scrolling carried it (`laidOutBox`, `[x, y, w, h]`), that box as the page measures it
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
// …its client rects (`clientRects`, `[x, y, w, h]` each).
export function clientRectsIn(el) {
  const a = laidOutArenaOf(el);
  return a ? a.dom.clientRects(el._nid) : null;
}
// …each element's in its own realm's painting (a frame's target is the frame's document's), one painting per realm.
export function observedVisibleIn(els) {
  const out = new Map(), byArena = new Map();
  for (const el of els) {
    const a = laidOutArenaOf(el);
    if (!a) { out.set(el, false); continue; }
    if (!byArena.has(a)) byArena.set(a, []);
    byArena.get(a).push(el);
  }
  for (const [a, list] of byArena) {
    const answers = a.dom.observedVisible(Float64Array.from(list, (el) => el._nid));
    list.forEach((el, i) => out.set(el, answers[i] === 1));
  }
  return out;
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
// topmost unless `all`) — each at its realm's clock, which decides what an animation makes a stacking context of.
export function clippedAwayOf(el) {
  const a = laidOutArenaOf(el);
  return a ? a.dom.clippedAway(el._nid) : false;
}
export function hitTestIn(doc, x, y, all) {
  const a = liveArenaOf(doc);
  return a ? a.dom.hitTest(x, y, all) : [];
}
// The nodes `nids` (a Float64Array) names that are in `root`'s shadow-including tree, by nid — the engine's answer
// (dom.rs `nodesUnder`), in place of a walk of the tree for them.
export function nodesByNid(root, nids) {
  const [kept, nodes] = globalThis.__dom.nodesUnder(root._nid, nids);
  const byNid = new globalThis.Map();
  for (let i = 0; i < kept.length; i++) byNid.set(kept[i], nodes[i]);
  return byNid;
}
// …and the layout a page laid out as its root box alone (`layoutRootAlone`) leaves there: that box, against viewport
// `vp`, and no other.
export function layoutRootAloneIn(root, vp) {
  const a = liveArenaOf(root);
  if (a) a.dom.layoutRootAlone(root._nid, vp.width, vp.height);
}

// `node`'s nid, as a node of a tree of the realm `a` is: every node has its slot from its construction for its life, and
// one from another realm's tree keeps it, the tree's realm becoming `a`'s (`adoptInto`).
function nodeIn(node, a) {
  if (node._nid >= 0 && liveArenaOf(node) === a) return node._nid;
  // (…any node with a live slot — one whose realm is gone, a frame navigated away from, too: its arena object went with
  // it, its slot did not)
  if (node._nid >= 0 && a.dom.realmOf(node._nid) >= 0) return adoptInto(node, a);
  throw new Error('[csim] a node with no slot in the arena joined a tree');
}
// `node`, in the slot it has, and everything it holds — its children, shadow tree and template contents — now in a tree
// of the realm `a` is: theirs to answer for and to free (the engine's, `adoptSubtree`), a shadow host among them counted
// by that realm.
function adoptInto(node, a) {
  if (a.dom.adoptSubtree(node._nid)) a.realm.shadowHosted();
  return node._nid;
}
// The realm a tree change on `parent` is kept as: the parent's own, or — its realm gone — this one's.
function arenaFor(parent) {
  return liveArenaOf(parent) || currentArena();
}
// A change of `parent`'s children, the engine's (mutation.rs `changeChildren`), in the realm it is kept as…
export function changeChildrenOf(parent, removing, nodes, child, adoptAll, steps) {
  return arenaFor(parent).dom.changeChildren(parent._nid, removing, nodes, child, adoptAll, steps, globalThis.__dom.realmId);
}
// …a move of `node` into `parent` before `child` (null: last), DOM "move" (mutation.rs `moveChild`)…
export function moveChildOf(parent, node, child) {
  return arenaFor(parent).dom.moveChild(node._nid, node._nodeType, parent._nid, parent._nodeType, child == null ? -1 : child._nid,
    globalThis.__dom.realmId);
}
// …and a shadow host joining that realm's trees with it, which the realm counts.
export function shadowHostJoined(parent) {
  arenaFor(parent).realm.shadowHosted();
}

// Flush a flat [name, value, …] attribute list into `el`'s arena node in ONE crossing (syncAttrs
// replaces the node's attributes wholesale). The parse-time attribute apply uses this instead of N
// per-attribute attrsView interceptor writes — restoring the pre-store-flip economics: the plain-object
// `{}` it replaced took zero crossings per element, a batched syncAttrs takes one. `flat` MUST be the
// element's COMPLETE final attribute set (the caller seeds it with any pre-existing attrs for the adopt
// path), since the write is wholesale.
export function syncNativeAttrs(el, flat) {
  // Nothing to flush: an attribute-less element — the common case, a large
  // fraction of any page's nodes — keeps its eager arena node's empty attribute
  // vec and pays NO crossing, just as the plain object it replaced took zero. A
  // wholesale syncAttrs([]) would only re-clear an already-empty node (every
  // path here reaches an empty `flat` only on an already-empty node: a fresh
  // ctor node, or an adopt with nothing to add — `clearNativeAttrs` empties one).
  if (flat.length === 0) return;
  arenaFor(el).dom.syncAttrs(el._nid, flat);
}
// …and every attribute of `el` gone from its arena node (the reused skeleton's, for a new page).
export function clearNativeAttrs(el) {
  arenaFor(el).dom.syncAttrs(el._nid, []);
}

// The namespace and local name of the attribute an element's tree builder appends under `key` (attributes.rs keeps its
// namespace record: what an Attr, a namespaced lookup and `:any-link` on an SVG `<a>` with an XLink href read).
export function setAttrNamespace(el, key, namespace, localName) {
  const a = liveArenaOf(el);
  if (a) a.dom.setAttrNamespace(el._nid, key, namespace, localName);
}

// A new page in this realm: its state in the arena afresh (`resetArena`). Called at the START of every in-place load
// (parseHtmlIntoLive), BEFORE the tokenizer constructs the new page's nodes. The nodes stay: the reused Document and
// `<html>`/`<head>`/`<body>` skeleton (resetReusedElement makes the skeleton's anew), a node the old page's script still
// holds; the old page's other nodes go as V8 collects them.
export function invalidateArena() {
  const d = globalThis.__dom;
  // (…the custom element reactions the backup element queue owes run first, as the old page's microtask would have
  // before it went)
  if (d.ceStack[2] !== 0) globalThis.__csimRunBackupReactions();
  d.resetArena();
}

// ── keeping it linked ──────────────────────────────────────────────────────────────────────────────────────────
// An edge written (tree.js, the one writer of the tree's edges): `node` inserted into `parent` (before `ref`, or last)
// — in the parent's arena, a node from anywhere else registered there and re-homed — …
export function arenaInsert(parent, node, ref) {
  const a = arenaFor(parent);
  const pn = nodeIn(parent, a);
  if (pn >= 0) a.dom.insertChild(pn, nodeIn(node, a), ref ? nodeIn(ref, a) : -1);
}
// …`nodes`, in order, at once…
export function arenaInsertAll(parent, nodes, ref) {
  const a = arenaFor(parent);
  const pn = nodeIn(parent, a);
  if (pn >= 0) a.dom.insertChildren(pn, nodes.map((n) => nodeIn(n, a)), ref ? nodeIn(ref, a) : -1);
}
// …`node` removed…
export function arenaRemove(node) {
  return arenaFor(node).dom.removeChild(node._nid);
}
// …and every child of `parent` removed: the children.
export function arenaRemoveAll(parent) {
  return arenaFor(parent).dom.removeChildren(parent._nid);
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
// …its validation message (`validation_message`), and its custom validity become `flags`, with `message` — whether that
// changed it (`set_custom_validity`).
export function validationMessageOf(el) {
  const a = liveArenaOf(el);
  return a ? a.dom.validationMessage(el._nid) : '';
}
export function setCustomValidityOf(el, flags, message) {
  const a = liveArenaOf(el);
  return !!a && a.dom.setCustomValidity(el._nid, flags, message);
}
export function actuallyDisabledOf(el) {
  const a = liveArenaOf(el);
  return !!a && a.dom.actuallyDisabled(el._nid);
}
// An `<input>`'s value sanitized as `type`, by its attributes (input_value.rs `sanitize`) — what a value set stores.
export function sanitizedValueOf(el, type, value) {
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
    const kids = n._children;
    for (let i = 0; i < kids.length; i++) visit(kids[i], n._nid);
    if (n._templateContent) visit(n._templateContent, undefined);
    if (n._shadowRoot) visit(n._shadowRoot, undefined);
  };
  visit(root, undefined);
}
let verifyOn;
export function arenaVerifyOn() {
  if (verifyOn === undefined) verifyOn = globalThis.__csimArenaVerify === true;
  return verifyOn;
}
export function maybeVerifyArena() {
  // (…a document with no arena copy yet — a frame's bootstrap one, styled before its page is parsed — has nothing to
  // hold its tree against)
  if (!arenaVerifyOn() || !globalThis.document || !(globalThis.document._nid >= 0)) return;
  try { verifyArena(globalThis.document); } catch (e) { arenaVerifyFailed(e.message); throw e; }
}
// A difference verify mode found, kept as well as thrown: a throw inside a rendering step or an event handler is
// swallowed by its caller, and what the runtime keeps (`__csim_arenaVerifyFailed`) is not — nor lost with the realm.
export function arenaVerifyFailed(message) {
  if (typeof globalThis.__csim_arenaVerifyFailed === 'function') globalThis.__csim_arenaVerifyFailed(String(message));
}
