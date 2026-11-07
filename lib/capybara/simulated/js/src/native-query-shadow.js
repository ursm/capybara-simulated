// The native (Rust) arena: every node of every tree of this realm, MIRRORED from the JS DOM so the native readers see
// what a script sees (the attributes are no mirror — the arena IS their store, through the attrsView). This file
// owns the arena's lifecycle: a node joins it at construction, and a tree change is applied as it happens (see "the
// mirror" below). The arena is the isolate's — every realm's nodes, each with the slot it was made in for its life —
// and what is a realm's own (its document's focus, sheets, layout) is kept beside it per realm (dom.rs `RealmState`).
//
// Its readers: every selector match (selectors.js — querySelector, matches, closest) and the native style engine and
// layout, so the mirror must be exact: `CSIM_ARENA_VERIFY=1` checks it.

import { NODE_ELEMENT, NODE_ATTRIBUTE, NODE_TEXT, NODE_CDATA, NODE_COMMENT, NODE_PI, NODE_DOC, NODE_DOCTYPE, NODE_FRAGMENT, HTML_NS, SVG_NS } from './constants.js';
import { IntrinsicPromise, Stamp, objectCreate } from './webidl.js';
import { DOMException } from './dom-exception.js';
import { attrOwnerOf, piTargetOf, attrsOf, localNameOf, namespaceOf, nidOf, nodeArgOf, nodeTypeOf, setAttrs, setNid, tagOf, isShadowRoot, isRealmDocument, realmStepsOf, setOwnRealmSteps } from './node-identity.js';
import { defaultViewOf, focusedElementOf, hoveredElementOf } from './document-state.js';

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
// the image data" that another realm's code asked for, `updateImageDataSoon(el)`; and its document's window, focused and
// hovered element, which only its own realm knows: document-state.js's, which reads them so — and the steps that run in
// the realm of the document they act in: focusing, unfocusing, adopting, a frame taking the focus, dom-nodes.js's)
export const REALM = {
  defaultViewOf,
  focusedElementOf,
  hoveredElementOf,
  setFocusedElement: () => {},
  setHoveredElement: () => {},
  takeFocusFromFrame: () => {},
  focusElement: () => {},
  blurElement: () => {},
  adoptNode: (doc, node) => node,
  shadowHosted: () => {},
  ensureLayout: () => {},
  markLayoutDirty: () => {},
  sheetOf: () => null,
  nodeObject: () => undefined,
  cloneShadowRoot: () => null,
  upgradeCopies: () => {},
  updateImageDataSoon: () => {},
  recordFormSubmission: () => false,
  followHyperlink: () => {}
};
setOwnRealmSteps(REALM);
// …the realm that answers for `node` when it is in another realm's arena, or null.
export function foreignRealmOf(node) {
  const a = liveArenaOf(node);
  return a !== null && a !== arena ? a.realm : null;
}
// …and the steps of the realm a node's OBJECT is of — the one whose code made it, whatever arena it was adopted into
// since — where that is another than this one: the nodes, shadow roots and Attrs a step of a node makes are of its
// relevant realm (Chrome and Firefox: a text a parent's element in a frame's document is given its `textContent` by is
// the parent's, a frame's element's the frame's, whichever realm's member is called): the steps its identity was
// stamped with (node-identity.js `realmStepsOf`), no host's to ask. (The realm whose document it is in answers for its
// focus, its events, its adoption: `foreignRealmOf`.)
export function makingRealmOf(node) {
  const steps = realmStepsOf(node);
  return steps === undefined || steps === REALM ? null : steps;
}
// …and the realm whose document `node` is in, where that is another than this one: what a step of it that acts in its
// document runs in — its markup parsed there, whose registry its custom elements upgrade by, and an event fired at it
// made there (DOM "fire an event": the relevant realm of the target).
export function documentRealmOf(node) {
  return isRealmDocument(node) ? null : foreignRealmOf(node);
}
// …and `step` run there: what it throws thrown again as this realm's — an IDL member's exceptions are its caller's
// realm's (Chrome, Firefox), where the objects it makes are the node's.
export function inRealm(realm, step, ...args) {
  try {
    return realm[step](...args);
  } catch (e) {
    throw ownError(e);
  }
}
const OWN_ERRORS = { Error, EvalError, RangeError, ReferenceError, SyntaxError, TypeError, URIError };
function ownError(e) {
  if (e === null || typeof e !== 'object' || e instanceof Error || e instanceof DOMException) return e;
  if (e.constructor?.name === 'DOMException') return new DOMException(e.message, e.name);
  const Ctor = OWN_ERRORS[e.name];
  return Ctor ? new Ctor(e.message) : e;
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
  const nid = nidOf(node), d = globalThis.__dom;
  if (!(nid >= 0)) return null;
  const realm = d.realmOf(nid);
  if (realm === d.realmId) return currentArena();
  return realm < 0 ? null : (d.arenaOf(realm) ?? null);
}
// `node`'s nid in THIS realm's arena, or -1 — for a reader that asks the arena about a node (the cascade's matcher).
export function arenaNid(node) {
  const nid = nidOf(node), d = globalThis.__dom;
  return nid >= 0 && d.realmOf(nid) === d.realmId ? nid : -1;
}

// ── the mirror ───────────────────────────────────────────────────────────────────────────────────────────────
// EVERY node is in an arena from its construction — elements, text, comments, doctypes, documents, fragments and
// shadow roots — and every tree is kept linked there, the document's, a detached subtree's, a template's contents',
// a DOMParser document's: a native reader sees the tree a script sees (text included), whatever it asks about.
// Three kinds of write keep it so: a node's creation (`registerNative*`), an edge written (tree.js, the one writer of
// the tree's edges: `arenaInsert` / `arenaRemove` / `arenaRemoveAll`) and a character-data change (dom-nodes.js `storeData` → `__dom.setData`). A query answers
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
// handle (node_handle.rs): the arena IS its attribute store (`attrsOf` the attrsView over it). Its name as its
// constructor gave it.
export function registerNativeElement(el, localName, ns, prefix) {
  const a = currentArena();
  // (…or the one the engine made, whose object this is: `makingObjectOf`)
  const made = takeMadeNode();
  if (made >= 0) {
    setNid(el, made);
    setAttrs(el, a.dom.attrsView(made));
    return;
  }
  // (…in the namespace the element was made in: one in none crosses as '' — it is no HTML element, not to `:any-link`,
  // nor to a type selector's case rule)
  const nid = a.dom.importNode(localName, ns ?? '', -1, [], prefix ?? null, el);
  setNid(el, nid);
  setAttrs(el, a.dom.attrsView(nid));
}

// ── element state ────────────────────────────────────────────────────────────────────────────────────────────
// What a script or the user did to an element that no attribute records — the state pseudo-classes' input (dom.rs
// `STATE_*`, read by element_state.rs): its arena node's, the engine's alone (`__dom.state` / `setState`).
export const STATE_FOCUSED             = 1;
export const STATE_HOVERED             = 1 << 1;
export const STATE_CHECKED_DIRTY       = 1 << 2;
export const STATE_CHECKED             = 1 << 3;
export const STATE_SELECTED            = 1 << 4;
export const STATE_INDETERMINATE       = 1 << 5;
export const STATE_POPOVER_OPEN        = 1 << 6;
export const STATE_MODAL               = 1 << 7;
export const STATE_FILTERED            = 1 << 8;
export const STATE_FORM_ASSOCIATED     = 1 << 9;
export const STATE_CUSTOM              = 1 << 10;
export const STATE_IS_VALUE            = 1 << 11;
export const STATE_DIRTY_BY_USER       = 1 << 12;
export const STATE_USER_INTERACTED     = 1 << 14;
export const STATE_HAS_FILES           = 1 << 15;
export const STATE_SELECTED_DIRTY      = 1 << 16;
export const STATE_SELECTED_INIT       = 1 << 17;
export const STATE_UPGRADED            = 1 << 18;
export const STATE_XML_DOCUMENT        = 1 << 19;
export const STATE_DESIGN_MODE         = 1 << 20;
// A document's, the bindings' alone: that it is its browsing context's initial about:blank (HTML "is initial
// about:blank"), the one a navigation to a document of its origin keeps the Window of until `document.open()` makes it
// none (noted as the document is made, `__csimCompleteInitialDocument`); and that its visibility state is "hidden"
// (HTML "update the visibility state", as "unload a document" makes it after its `pagehide`: `__csimHideDocument`,
// cleared where the document is renewed, dom-nodes.js `__csimRenewDocument`). (Its page showing is its load
// lifecycle's: document_lifecycle.rs.)
export const STATE_INITIAL_ABOUT_BLANK = 1 << 23;
export const STATE_HIDDEN              = 1 << 24;
// `el`'s bits under `mask` become `bits`.
export function setElementState(el, mask, bits) {
  const a = liveArenaOf(el);
  if (!a) return;
  const had = a.dom.setState(nidOf(el), mask, bits);
  // (…an option's selectedness is what its drop-down SHOWS, laid out in it — walk.rs `control_text`)
  if (mask & STATE_SELECTED && (had & STATE_SELECTED) !== (bits & STATE_SELECTED)) markShownText(el);
}
// …and its bits.
export function stateOf(el) {
  const a = liveArenaOf(el);
  return a ? a.dom.state(nidOf(el)) : 0;
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
// (…a control's, `undefined` while clean: form-helpers.js `controlLiveValue`)
export function setLiveValue(el, value) {
  if (value !== liveValueOf(el)) setElementValue(el, value);
}
// …and its checkedness, `undefined` while clean (the `checked` attribute stands for it) and a boolean once dirty, and its
// selectedness — which form-helpers.js and html-forms.js write with the steps that go with them.
export function checkednessOf(el) {
  const s = stateOf(el);
  return s & STATE_CHECKED_DIRTY ? (s & STATE_CHECKED) !== 0 : undefined;
}
export function storeCheckedness(el, checked) {
  setElementState(el, STATE_CHECKED_DIRTY | STATE_CHECKED, checked === undefined ? 0 : checked ? STATE_CHECKED_DIRTY | STATE_CHECKED : STATE_CHECKED_DIRTY);
}
export function selectednessOf(el) {
  return hasState(el, STATE_SELECTED);
}
export function setSelectedness(el, selected) {
  setElementState(el, STATE_SELECTED, selected ? STATE_SELECTED : 0);
}
// …and a file input's selected files, its rare data's (whether it has any is constraint validation's).
export function selectedFilesOf(el) {
  return rareDataOf(el)?.files;
}
export function setSelectedFiles(el, files) {
  rareDataOf(el, true).files = files;
  setStateBit(el, STATE_HAS_FILES, files != null && files.length > 0);
}

// ── attributes ───────────────────────────────────────────────────────────────────────────────────────────────
// An element's attribute by its qualified name or its namespace and local name — DOM's `getAttribute` /
// `getAttributeNS`, the engine's (attributes.rs): null for none. (Writes are dom-nodes.js's, which runs the attribute
// change steps: `setAttribute`, `removeAttribute` …)
export const BY_QNAME = 0, BY_NS = 1;
export function getAttribute(el, name) {
  return globalThis.__dom.attrGet(el, BY_QNAME, name);
}
export function getAttributeNS(el, namespace, localName) {
  return globalThis.__dom.attrGet(el, BY_NS, namespace, localName);
}
// …the key its store holds the first attribute of that qualified name under, null for none.
export function attrKeyOf(el, qualifiedName) {
  return globalThis.__dom.attrKey(el, BY_QNAME, qualifiedName);
}
export function hasAttribute(el, name) {
  return attrKeyOf(el, name) !== null;
}
// …and the user typing `text` into it where `at` says (`TYPE_*`: at the caret, the value's end where no selection was
// ever set; over the whole value; at the selection a script reads, its start where none was set), the engine's to insert
// (text_selection.rs `type_text`): `[what that changed — TYPED_VALUE / TYPED_SELECTION —, the text that went in]`.
export const TYPED_VALUE = 1, TYPED_SELECTION = 2;
export const TYPE_AT_CARET = 0, TYPE_WHOLE = 1, TYPE_AT_SELECTION = 2;
export function typeIntoValue(el, text, at = TYPE_AT_CARET) {
  const typed = globalThis.__dom.typeText(el, text, at) ?? [0, ''];
  valueEdited(el, typed[0]);
  return typed;
}
// …or an editing key pressed in it (text_selection.rs `edit_control`, `EDIT_*`).
export const EDIT_BACKSPACE = 0, EDIT_DELETE = 1, EDIT_LEFT = 2, EDIT_RIGHT = 3, EDIT_HOME = 4, EDIT_END = 5, EDIT_TEXT_START = 6,
  EDIT_TEXT_END = 7, EDIT_WORD_LEFT = 8, EDIT_WORD_RIGHT = 9, EDIT_WORD_BACKSPACE = 10, EDIT_WORD_DELETE = 11,
  EDIT_LINE_BACKSPACE = 12, EDIT_EXTEND = 16, EDIT_AT_SELECTION = 32;
export function editValue(el, key) {
  return valueEdited(el, globalThis.__dom.editControl(el, key));
}
export function valueEdited(el, changed) {
  if (changed & TYPED_VALUE) markShownText(el);
  return changed;
}
// What a control shows is laid out in its box, so a change to it is a layout change — through the global, as an import
// of mutation-observer.js from here would be a cycle (it imports this module).
export function markShownText(el) {
  if (globalThis.__csimMarkLayoutDirty) globalThis.__csimMarkLayoutDirty(el);
}
// A node's node document — its `ownerDocument`, but a document's, which is none — and its setting (adoption, a node made
// for a document): its handle's — none for an object with no handle, a generated box's holder — and an Attr's of an
// element its element's, which an adopt of the element moves, the attribute with it (DOM "adopt" step 3.2.2): it holds
// none of its own while it is one (`bindAttrNode`).
export function nodeDocumentOf(node) {
  const doc = globalThis.__dom.nodeDocument(node);
  if (doc) return doc;
  const el = doc === null && nodeTypeOf(node) === NODE_ATTRIBUTE ? attrOwnerOf(node) : null;
  return el ? nodeDocumentOf(el) : null;
}
export function setNodeDocumentOf(node, doc) {
  globalThis.__dom.setNodeDocument(node, doc);
}
// …and the node document of `root` and every node of its tree under it (not a shadow tree's, nor a template's
// contents): the engine's to set in one call, where it holds the tree.
export function setSubtreeDocumentOf(root, doc) {
  if (liveArenaOf(root) !== null) return globalThis.__dom.setSubtreeDocument(nidOf(root), doc);
  setNodeDocumentOf(root, doc);
  const kids = childNodesOf(root);
  if (kids) for (let i = 0; i < kids.length; i++) setSubtreeDocumentOf(kids[i], doc);
}
// The elements of `node`'s shadow-including subtree an upgrade has been tried on, in shadow-including tree order — the
// ones a tree change owes custom element reactions (custom_elements.rs).
export function upgradedElementsIn(node) {
  const a = liveArenaOf(node);
  return a ? a.dom.upgradedElementsIn(nidOf(node)) : [];
}
// The stylesheets' owners among `root`'s descendants (an HTML or SVG `<style>`, an HTML `<link>`), in tree order
// (collections.rs `elementsBy`) — none where there is no engine to ask.
export function sheetOwnersIn(root) {
  const a = liveArenaOf(root);
  return a ? a.dom.elementsBy(nidOf(root), 10) : [];
}
// …and every element of `root`'s shadow-including inclusive descendants, in shadow-including tree order; and of its
// inclusive descendants alone, in tree order.
export function shadowIncludingElementsIn(root) {
  const a = liveArenaOf(root);
  return a ? a.dom.elementsBy(nidOf(root), 14) : [];
}
// …and the image elements among them, the root too: an HTML `<img>` or `<input>`, an SVG `<image>`.
export function imageElementsIn(root) {
  const a = liveArenaOf(root);
  return a ? a.dom.elementsBy(nidOf(root), 16) : [];
}
// The link types a `rel` value names (HTML §4.6.7) — the engine's (token_list.rs `link_types`) — as `LINK_*` bits.
export const LINK_STYLESHEET = 1, LINK_ALTERNATE = 1 << 1, LINK_PREFETCH = 1 << 2, LINK_PRELOAD = 1 << 3,
  LINK_MODULEPRELOAD = 1 << 4, LINK_MANIFEST = 1 << 5, LINK_OPENER = 1 << 6, LINK_NOOPENER = 1 << 7, LINK_NOREFERRER = 1 << 8;
export const linkTypesOf = (rel) => (rel ? globalThis.__dom.linkTypes(String(rel)) : 0);
// What `window.open`'s features set (navigables.rs `open_features`), as `OPEN_*` bits.
export const OPEN_NOOPENER = 1, OPEN_NOREFERRER = 2;
export const openFeaturesOf = (features) => (features ? globalThis.__dom.openFeatures(features) : 0);
// …and `parent`'s children that are elements.
export function childElementsOf(parent) {
  const a = liveArenaOf(parent);
  return a ? a.dom.elementsBy(nidOf(parent), 15) : [];
}
export function inclusiveElementsIn(root) {
  const a = liveArenaOf(root);
  if (!a) return [];
  const found = a.dom.elementsBy(nidOf(root), 1, '*', '*');
  return nodeTypeOf(root) === NODE_ELEMENT ? [root, ...found] : found;
}
// …and the elements of `root`, it included, that a custom element definition could be for (an HTML element with a
// hyphenated name or an `is` value), its `<script>`s (in any namespace) and its HTML `<slot>`s — in tree order, none
// where there is no engine to ask.
export function customElementCandidatesIn(root) {
  // (…a text or a childless element answered here, as most of a parse's top-level nodes are: no list call for them)
  if (childCountOf(root, false) === 0) {
    return nodeTypeOf(root) === NODE_ELEMENT && namespaceOf(root) === HTML_NS && (localNameOf(root).includes('-') || isValueOf(root) != null) ? [root] : [];
  }
  const a = liveArenaOf(root);
  if (!a) return [];
  const found = a.dom.elementsBy(nidOf(root), 13);
  return nodeTypeOf(root) === NODE_ELEMENT && namespaceOf(root) === HTML_NS && (localNameOf(root).includes('-') || isValueOf(root) != null)
    ? [root, ...found] : found;
}
export function scriptsIn(root) {
  const a = liveArenaOf(root);
  if (!a) return [];
  const found = a.dom.elementsBy(nidOf(root), 1, '*', 'script');
  return nodeTypeOf(root) === NODE_ELEMENT && localNameOf(root) === 'script' ? [root, ...found] : found;
}
// …and the descendant elements with any of the state bits `mask`, in tree order.
export function elementsInState(root, mask) {
  const a = liveArenaOf(root);
  return a ? a.dom.elementsBy(nidOf(root), 12, mask) : [];
}
// …and the upgrade candidates of a definition just made (`localName`, and `is` for a customized built-in), in the same
// order — none where there is no engine to ask, before any document.
export function upgradeCandidatesIn(node, localName, is) {
  const a = liveArenaOf(node);
  return a ? a.dom.upgradeCandidates(nidOf(node), localName, is) : [];
}
// …and those of it with a connection step of their own (connection_steps.rs), in the same order — every element of its
// shadow-including subtree where no arena answers for it (its realm's gone: the nodes are the isolate's, which this
// realm's engine reads) — and what connecting one element runs (`CONNECT_*`: a fast call, 0 for none).
export function connectionStepElementsIn(node) {
  const a = liveArenaOf(node);
  return a ? a.dom.connectionStepElements(nidOf(node)) : globalThis.__dom.elementsBy(nidOf(node), 14);
}
export const CONNECT_OPTION = 1, CONNECT_SELECT = 1 << 1, CONNECT_DIALOG = 1 << 2, CONNECT_SELECTEDCONTENT = 1 << 3;
export const CONNECT_MEDIA = 1 << 4, CONNECT_USE = 1 << 5, CONNECT_SCRIPT = 1 << 6, CONNECT_LINK = 1 << 7;
export const CONNECT_STYLE = 1 << 8, CONNECT_SOURCE = 1 << 10, CONNECT_FRAME = 1 << 11;
export const CONNECT_DEFAULT_STYLE = 1 << 12, CONNECT_NONCE = 1 << 13, CONNECT_CUSTOM = 1 << 14, CONNECT_META_REFERRER = 1 << 15;
export const CONNECT_REFRESH = 1 << 16;
export function connectionStepsOf(el) {
  return globalThis.__dom.connectionSteps(nidOf(el));
}
// The node one of DOM's tree accessors names from `node` (dom.rs `relativeNode`: `RELATIVE_*`), the engine's answer —
// none for an Attr, which is in no tree and holds no slot.
export const RELATIVE_PARENT = 0, RELATIVE_PARENT_ELEMENT = 1, RELATIVE_FIRST_CHILD = 2, RELATIVE_LAST_CHILD = 3,
  RELATIVE_PREVIOUS = 4, RELATIVE_NEXT = 5, RELATIVE_FIRST_ELEMENT = 6, RELATIVE_LAST_ELEMENT = 7,
  RELATIVE_PREVIOUS_ELEMENT = 8, RELATIVE_NEXT_ELEMENT = 9, RELATIVE_PARENT_OR_HOST = 10, RELATIVE_ROOT = 11,
  RELATIVE_SHADOW_INCLUDING_ROOT = 12, RELATIVE_HEAD = 13, RELATIVE_BODY = 14,
  RELATIVE_SHADOW_ROOT = 15, RELATIVE_HOST = 16, RELATIVE_TEMPLATE_CONTENT = 17, RELATIVE_DOCTYPE = 18;
export function relativeOf(node, kind) {
  return globalThis.__dom.relativeNode(nodeArgOf(node), kind) ?? null;
}
// …the ones the bindings' own steps read by name: its parent — a shadow root's none, as DOM has it — its parent element,
// its siblings; its parent where a shadow root's is its host, which the shadow-including walks climb; a shadow root's or
// a template's contents' host, a host's shadow root.
export function parentNodeOf(node) { return relativeOf(node, RELATIVE_PARENT); }
export function parentElementOf(node) { return relativeOf(node, RELATIVE_PARENT_ELEMENT); }
export function nextSiblingOf(node) { return relativeOf(node, RELATIVE_NEXT); }
export function previousSiblingOf(node) { return relativeOf(node, RELATIVE_PREVIOUS); }
export function parentOrHostOf(node) { return relativeOf(node, RELATIVE_PARENT_OR_HOST); }
export function hostOf(fragment) { return relativeOf(fragment, RELATIVE_HOST); }
export function shadowRootOf(el) { return relativeOf(el, RELATIVE_SHADOW_ROOT); }
// …a `<template>`'s contents (the fragment `content` is), which serializing it writes (`setTemplateContentOf` links
// them) — none to ask for on any other element, which a walk over every node reads it of.
export function templateContentsOf(el) {
  return localNameOf(el) === 'template' ? relativeOf(el, RELATIVE_TEMPLATE_CONTENT) : null;
}
// …and character data's data, the arena's, as the string the node's handle holds (node_handle.rs `nodeData`).
export function dataOf(node) { return globalThis.__dom.nodeData(node); }
// …its children, in a new array.
export function childNodesOf(node) {
  return globalThis.__dom.childNodes(nidOf(node)) ?? [];
}
// …its index-th child, or null past the last (`childNodes`'s item).
export function childAtOf(node, index) {
  return globalThis.__dom.childAt(nidOf(node), index) ?? null;
}
// …and how many children it has (element ones alone, with `elements`).
export function childCountOf(node, elements) {
  return globalThis.__dom.childCount(nidOf(node), elements);
}
// An object's rare data (node_handle.rs `rareData`, Blink's): what the bindings keep for it that is script objects, not
// the engine's data — a node's [SameObject] collections, a file input's files, any event target's handlers — made with
// `make` where it has none, else undefined. A node's is its handle's; any other object's (a window, an XMLHttpRequest,
// an author's `Object.create(Node.prototype)`) a private field stamped on it (`Rare`), as an object's internal slots
// are (webidl.js `Slots`): no property a page could see or replace, the same record whichever realm asks.
class Rare extends Stamp {
  #record;
  constructor(o, record) {
    super(o);
    this.#record = record;
  }
  static read(o) { return #record in o ? o.#record : undefined; }
}
export function rareDataOf(object, make) {
  return globalThis.__dom.rareData(object, make === true) ?? stampedRareDataOf(object, make);
}
// …and an object's that is no node, which has no handle to ask (an event target's: events.js).
export function stampedRareDataOf(object, make) {
  const record = Rare.read(object);
  if (record !== undefined || make !== true) return record;
  const made = objectCreate(null);
  new Rare(object, made);
  return made;
}
// An image element's `decode()` waiting on its current request: a promise kept with it, settled as the request's load
// fires its `load` (resolved) or `error` (rejected with an EncodingError, `imageDecodeError`) — by the element's load
// steps themselves, never through a listener a page could stop or a method it could replace.
export const imageDecodeError = () => new DOMException('The source image cannot be decoded.', 'EncodingError');
export function awaitImageDecode(el) {
  return new IntrinsicPromise((resolve, reject) => { (rareDataOf(el, true).decodes ??= []).push([resolve, reject]); });
}
export function settleImageDecodes(el, loaded) {
  const rare = rareDataOf(el);
  const decodes = rare && rare.decodes;
  if (!decodes) return;
  rare.decodes = undefined;
  for (const [resolve, reject] of decodes) loaded ? resolve() : reject(imageDecodeError());
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
  return a ? a.dom.selectedOptions(nidOf(select), first === true) : [];
}
export function selectedIndexOf(select) {
  const a = liveArenaOf(select);
  return a ? a.dom.selectedIndex(nidOf(select)) : -1;
}
// …and the options whose selectedness changed as the index-th, or the first of `value`, is picked (`select_option`) —
// through the select's own realm, whose style engine restyles its options.
export function selectOptionAt(select, index) {
  const a = liveArenaOf(select);
  return a ? a.dom.selectIndex(nidOf(select), index) : [];
}
export function selectOptionOfValue(select, value) {
  const a = liveArenaOf(select);
  return a ? a.dom.selectValue(nidOf(select), value) : [];
}
// …likewise the selectedness setting algorithm's run (`selectedness`, `just` the option just selected), and a select's
// options' — or one option's — initialisation from their `selected` attributes (`initialise_options`).
export function runSelectedness(select, just) {
  const a = liveArenaOf(select);
  return a ? a.dom.selectedness(nidOf(select), just ? nidOf(just) : -1) : [];
}
export function initialiseOptions(node) {
  const a = liveArenaOf(node);
  return a ? a.dom.initialiseOptions(nidOf(node)) : [];
}
// …and the select a tree change asks for a reset (validity.rs `ask_for_reset`): `[select, changed options]`, or
// undefined where none is affected — in the parent's arena.
export function askForResetOf(parent, nodes, inserted) {
  const a = liveArenaOf(parent);
  return a ? a.dom.askForReset(nidOf(parent), nodes.map((n) => nidOf(n)), inserted) : undefined;
}
// …and `node` (`inclusive`) or its nearest ancestor that is an HTML element named `name`, out of no element (validity.rs
// `html_ancestor`) — and the select whose list of options an option is in (`option_select`) — or null.
export function htmlAncestorOf(node, name, inclusive) {
  const a = liveArenaOf(node);
  return a ? a.dom.elementAncestor(nidOf(node), HTML_NS, name, !!inclusive) : null;
}
// …and its nearest ancestor that is an SVG `<svg>`.
export function svgAncestorOf(node) {
  const a = liveArenaOf(node);
  return a ? a.dom.elementAncestor(nidOf(node), SVG_NS, 'svg', false) : null;
}
export const optionSelectOf = (option) => globalThis.__dom.optionSelect(nidOf(option));
// Is `bit` set on `el`, and set it to `on`: the flags (indeterminate, popover open, modal, filtered).
export function hasState(el, bit) {
  return (stateOf(el) & bit) !== 0;
}
export function setStateBit(el, bit, on) {
  setElementState(el, bit, on ? bit : 0);
}
// A custom element's custom states (`ElementInternals.states`, `states` their backing Set of strings), which `:state()`
// reads, mirrored whole — a handful at most.
export function syncCustomStates(el, states) {
  const a = liveArenaOf(el);
  if (!a) return;
  // (…read by the intrinsic Set iterator, which a page's Set.prototype[Symbol.iterator] is not)
  const names = [], it = setValues.call(states);
  for (let r = setIteratorNext.call(it); !r.done; r = setIteratorNext.call(it)) names.push(r.value);
  a.dom.setCustomStates(nidOf(el), names);
}
const setValues = Set.prototype.values;
const setIteratorNext = Object.getPrototypeOf(new Set().values()).next;
// The focus ring of the realm whose tree `el` — focused now — is in, latched: shown (`:focus-visible`) unless the focus
// came from a pointer onto no text entry — the engine's (dom.rs `latchFocusRing`), whose state
// moves the style state's generation where it changed: `:focus-visible` against `:focus` on the same focused element.
export function latchFocusRing(el) {
  const d = globalThis.__dom;
  if (d) d.latchFocusRing(nidOf(el));
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
export const setShadowAdoptedSheets = (sr, value) => globalThis.__dom.shadowAdoptedSheets(sr, value);

// ── slot assignment (slots.rs) ───────────────────────────────────────────────────────────────────────────────
const EMPTY = [];
// Assign the slots of the shadow root `sr` — each slot whose assigned nodes changed signaled, and what it shows marked,
// the engine's.
export function assignSlots(sr) {
  const a = liveArenaOf(sr);
  if (a) a.dom.assignSlots(nidOf(sr));
}
// The slot `node` (a host's child) is assigned to, or null.
export function assignedSlotOf(node) {
  const a = liveArenaOf(node);
  return (a && a.dom.assignedSlotOf(nidOf(node))[0]) ?? null;
}
// A slot's assigned nodes, or with `flatten`, its flattened ones.
// …and `assign()`: the slot's manually assigned nodes the ones given that are in its arena (slots.rs `assign_manual`) —
// the shadow roots whose assignments moved.
export function assignManual(slot, nodes) {
  const a = liveArenaOf(slot);
  if (!a) return EMPTY;
  const nids = [];
  for (const n of nodes) if (liveArenaOf(n)) nids.push(nidOf(n));
  return a.dom.slotAssign(nidOf(slot), nids);
}
export function assignedNodesOf(slot, flatten) {
  const a = liveArenaOf(slot);
  return a ? a.dom.assignedNodesOf(nidOf(slot), flatten) : [];
}
// Any other node's: its kind and, for character data, its data — a doctype's name and identifiers given (`doctype`:
// `[name, publicId, systemId]`), which the engine keeps.
export function registerNativeNode(node, doctype) {
  const made = takeMadeNode();
  if (made >= 0) {
    setNid(node, made);
    return;
  }
  const a = currentArena();
  // (…a doctype's name its data, and its public and system identifiers beside)
  if (doctype) {
    setNid(node, a.dom.createNode(NODE_DOCTYPE, doctype[0], -1, doctype[1], doctype[2], node));
    return;
  }
  const type = nodeTypeOf(node);
  const data = type === NODE_TEXT || type === NODE_CDATA || type === NODE_COMMENT || type === NODE_PI ? dataOf(node) : null;
  setNid(node, a.dom.createNode(type, data == null ? '' : String(data), -1, type === NODE_PI ? piTargetOf(node) : '', undefined, node));
}
// A node made where its owner's tree is — `owner`'s realm, which is another than the one whose code made it when a
// frame's document holds `owner` (a template's contents, made by whichever realm's code first asked for them).
export function registerBeside(node, owner) {
  const a = liveArenaOf(owner);
  if (a && liveArenaOf(node) !== a) nodeIn(node, a);
}
// A `<template>`'s contents, linked where the arena serializes the template from (serialize.rs).
export function setTemplateContentOf(template, content) {
  arenaFor(template).dom.setTemplateContent(nidOf(template), content ? nidOf(content) : -1);
}
// …a doctype's name (0), public identifier (1) or system identifier (2).
export const doctypeField = (dt, field) => globalThis.__dom.doctypeField(nidOf(dt), field);
// …and the `is` value an element was made with.
export function setIsValueOf(el, value) {
  const a = liveArenaOf(el);
  if (a) a.dom.setIsValue(nidOf(el), value == null ? null : String(value));
}
export function isValueOf(el) {
  const a = liveArenaOf(el);
  return a ? a.dom.isValue(nidOf(el)) : undefined;
}
// …given, which its state says it has.
export function setIsValue(el, value) {
  setElementState(el, STATE_IS_VALUE, value != null ? STATE_IS_VALUE : 0);
  setIsValueOf(el, value);
}
// A node as XML — or, `inner`, its children — requiring it well-formed where `wellFormed` (serialize.rs): a string,
// or `[message]` where it has none.
export function serializedXml(node, inner, wellFormed) {
  const a = liveArenaOf(node);
  return a ? a.dom.serializeXml(nidOf(node), inner, wellFormed) : '';
}
// An element's, a fragment's or a document's children as HTML — or, `outer`, the element itself (serialize.rs) — with the
// shadow roots `getHTML()`'s options ask for written in place: the serializable ones, and those `shadowRoots` lists.
export function serializedHtml(node, outer, serializableShadowRoots = false, shadowRoots = undefined) {
  const a = liveArenaOf(node);
  if (!a) return '';
  return a.dom.serializeHtml(nidOf(node), outer, serializableShadowRoots, shadowRoots);
}

// The scroll offset an element keeps in `axis` (0 x, 1 y) — kept in its arena beside its box, which the geometry shifts
// by it (geometry.rs) — and the write of one, each axis given as a number (`undefined` leaves it). One in no arena keeps
// none.
export function scrollOffsetOf(el, axis) {
  const a = liveArenaOf(el);
  return a ? a.dom.scrollOffset(nidOf(el), axis) : 0;
}
// …and the one it SHOWS (`scrollTop`): read once its realm is laid out, as a browser's is, so an offset whose content
// has shrunk since reads at its new end (geometry.rs `reclamp_scrolls`), and one with no box reads 0 — unless it keeps
// 0, which is in every range, so no layout can move it and the everyday read pays for none.
export function settledScrollOffsetOf(el, axis) {
  const a = liveArenaOf(el);
  if (!a || a.dom.scrollOffset(nidOf(el), axis) === 0) return 0;
  a.realm.ensureLayout();
  return a.dom.scrollOffset(nidOf(el), axis, true);
}
// …moved to (x, y) — clamped, and its scroll events queued where it moved (scroll_boxes.rs `scroll_move`): whether it
// moved.
export function scrollMoveOf(el, x, y) {
  const a = laidOutArenaOf(el);
  return a ? a.dom.scrollMove(nidOf(el), nidOf(nodeDocumentOf(el)), x, y) : false;
}
export function setScrollOffset(el, x, y) {
  const a = liveArenaOf(el);
  if (a) a.dom.setScrollOffset(nidOf(el), x, y);
}
// The open dialog a pointer press or release at client (x, y) on `target` is in (dialogs.rs `clickedDialog`) — a modal
// one's box read off its realm's layout, brought up to date first.
export function clickedDialogOf(target, x, y) {
  const a = liveArenaOf(target);
  if (!a) return null;
  if (nodeTypeOf(target) === NODE_ELEMENT && hasState(target, STATE_MODAL)) a.realm.ensureLayout();
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
  return a ? a.dom.laidOutBox(nidOf(el), out) : false;
}
// …an IntersectionObserver's observations (intersection.rs) of `nids` — all in `node`'s arena — against the root
// `rootNid` there (-1: that realm's viewport), or null where `node` has no arena.
export function observeIntersectionsIn(node, rootNid, margin, thresholds, nids) {
  const a = laidOutArenaOf(node);
  return a ? a.dom.observeIntersections(rootNid, margin, thresholds, ...nids) : null;
}
// …a ResizeObserver's observations (resize_observation.rs) of `pairs` — `nid, laidOut` each, all in `node`'s arena — at
// the display's device pixel ratio: eleven numbers a target (`resizeObservations`), or null where `node` has no arena.
export function resizeObservationsIn(node, pairs) {
  const a = laidOutArenaOf(node);
  return a ? a.dom.resizeObservations(...pairs) : null;
}
export function renderedBoxOf(el, out) {
  const a = laidOutArenaOf(el);
  return a ? a.dom.renderedBox(nidOf(el), out) : false;
}
export function scrollSizeOf(el, out) {
  const a = laidOutArenaOf(el);
  return a ? a.dom.scrollSize(nidOf(el), out) : false;
}
export function contentSizeOf(el, out) {
  const a = laidOutArenaOf(el);
  return a ? a.dom.contentSize(nidOf(el), out) : false;
}
// …the moves that bring `el` into view (scroll_into_view.rs), `[scroller nid, x, y, …]` innermost first: CSSOM's
// `scrollIntoView` with alignment codes (0 start, 1 center, 2 end, 3 nearest), or `ifNeeded` a driver's
// scroll-if-needed.
export function scrollIntoViewPlanOf(el, ifNeeded, block, inline) {
  const a = laidOutArenaOf(el);
  return a ? a.dom.scrollIntoViewPlan(nidOf(el), ifNeeded, block, inline) : null;
}
// …its client rects (`clientRects`, `[x, y, w, h]` each).
export function clientRectsIn(el) {
  const a = laidOutArenaOf(el);
  return a ? a.dom.clientRects(nidOf(el)) : null;
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
    const answers = a.dom.observedVisible(Float64Array.from(list, (el) => nidOf(el)));
    list.forEach((el, i) => out.set(el, answers[i] === 1));
  }
  return out;
}
export function firstBoxOriginIn(el, out) {
  const a = laidOutArenaOf(el);
  return a ? a.dom.firstBoxOrigin(nidOf(el), out) : false;
}
export function offsetsIn(el, out) {
  const a = laidOutArenaOf(el);
  return a ? a.dom.offsets(nidOf(el), out) : false;
}
export function scrollRangeOf(el, out) {
  const a = laidOutArenaOf(el);
  return a ? a.dom.scrollRange(nidOf(el), out) : false;
}
export function clientBoxOf(el, out) {
  const a = laidOutArenaOf(el);
  return a ? a.dom.clientBox(nidOf(el), out) : false;
}
export function frameViewportOf(el, out) {
  const a = laidOutArenaOf(el);
  return a ? a.dom.frameViewport(nidOf(el), out) : false;
}
// …and what the painting order of the last layout says (hit_test.rs): the elements a hit at a viewport point of `doc`
// lands on, topmost first (`hitTest`; only the topmost unless `all`) — each at its realm's clock, which decides what an
// animation makes a stacking context of.
export function hitTestIn(doc, x, y, all) {
  const a = liveArenaOf(doc);
  return a ? a.dom.hitTest(x, y, all) : [];
}
// The nodes `nids` (a Float64Array) names that are in `root`'s shadow-including tree, by nid — the engine's answer
// (dom.rs `nodesUnder`), in place of a walk of the tree for them.
export function nodesByNid(root, nids) {
  const [kept, nodes] = globalThis.__dom.nodesUnder(nidOf(root), nids);
  const byNid = new Map();
  for (let i = 0; i < kept.length; i++) byNid.set(kept[i], nodes[i]);
  return byNid;
}
// …and the layout a page laid out as its root box alone (`layoutRootAlone`) leaves there: that box, against its realm's
// viewport, and no other.
export function layoutRootAloneIn(root) {
  const a = liveArenaOf(root);
  if (a) a.dom.layoutRootAlone(nidOf(root));
}

// `node`'s nid, as a node of a tree of the realm `a` is: every node has its slot from its construction for its life, and
// one from another realm's tree keeps it, the tree's realm becoming `a`'s (`adoptInto`).
function nodeIn(node, a) {
  if (nidOf(node) >= 0 && liveArenaOf(node) === a) return nidOf(node);
  // (…any node with a live slot — one whose realm is gone, a frame navigated away from, too: its arena object went with
  // it, its slot did not)
  if (nidOf(node) >= 0 && a.dom.realmOf(nidOf(node)) >= 0) return adoptInto(node, a);
  throw new Error('[csim] a node with no slot in the arena joined a tree');
}
// `node`, in the slot it has, and everything it holds — its children, shadow tree and template contents — now in a tree
// of the realm `a` is: theirs to answer for and to free (the engine's, `adoptSubtree`), a shadow host among them counted
// by that realm.
function adoptInto(node, a) {
  if (a.dom.adoptSubtree(nidOf(node))) a.realm.shadowHosted();
  return nidOf(node);
}
// The realm a tree change on `parent` is kept as: the parent's own, or — its realm gone — this one's.
function arenaFor(parent) {
  return liveArenaOf(parent) || currentArena();
}
// A change of `parent`'s children, the engine's (mutation.rs `changeChildren`), in the realm it is kept as…
export function changeChildrenOf(parent, removing, nodes, child, adoptAll, steps) {
  return arenaFor(parent).dom.changeChildren(nidOf(parent), removing, nodes, child, adoptAll, steps, globalThis.__dom.realmId);
}
// …a move of `node` into `parent` before `child` (null: last), DOM "move" (mutation.rs `moveChild`)…
export function moveChildOf(parent, node, child) {
  return arenaFor(parent).dom.moveChild(nidOf(node), nodeTypeOf(node), nidOf(parent), nodeTypeOf(parent), child == null ? -1 : nidOf(child),
    globalThis.__dom.realmId);
}
// …and a shadow host joining that realm's trees with it, which the realm counts.
export function shadowHostJoined(parent) {
  arenaFor(parent).realm.shadowHosted();
}

// A new page in this realm: its state in the arena afresh (`resetArena`). Called at the START of every in-place load
// (parseHtmlIntoLive), BEFORE the tokenizer constructs the new page's nodes. The nodes stay: the reused Document and
// `<html>`/`<head>`/`<body>` skeleton (the build makes the skeleton's anew: html_parse.rs `Build::reset`), a node the
// old page's script still holds; the old page's other nodes go as V8 collects them.
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
  return arenaFor(node).dom.removeChild(nidOf(node));
}
// …and every child of `parent` removed: the children.
export function arenaRemoveAll(parent) {
  return arenaFor(parent).dom.removeChildren(nidOf(parent));
}

// What the arena says of an element's constraint validation (validity.rs: its ValidityState flags, bit 0
// `valueMissing` … bit 9 `customError`; whether it is a candidate) and whether it is actually disabled
// (element_state.rs) — the answers `:valid`, `:invalid` and `:disabled` match by too.
export function validityFlagsOf(el) {
  const a = liveArenaOf(el);
  return a ? a.dom.validityFlags(nidOf(el)) : 0;
}
export function willValidateOf(el) {
  const a = liveArenaOf(el);
  return !!a && a.dom.willValidate(nidOf(el));
}
// …its validation message (`validation_message`), and its custom validity become `flags`, with `message` — whether that
// changed it (`set_custom_validity`).
export function validationMessageOf(el) {
  const a = liveArenaOf(el);
  return a ? a.dom.validationMessage(nidOf(el)) : '';
}
export function setCustomValidityOf(el, flags, message) {
  const a = liveArenaOf(el);
  return !!a && a.dom.setCustomValidity(nidOf(el), flags, message);
}
export function actuallyDisabledOf(el) {
  const a = liveArenaOf(el);
  return !!a && a.dom.actuallyDisabled(nidOf(el));
}
// An `<input>`'s value sanitized as `type`, by its attributes (input_value.rs `sanitize`) — what a value set stores.
export function sanitizedValueOf(el, type, value) {
  const a = liveArenaOf(el);
  return (a ? a.dom : globalThis.__dom).inputSanitize(a ? nidOf(el) : -1, type, value);
}
// …and the value `stepUp(delta)` makes of `value` (`step`): null for no change, undefined where there is no step.
export function steppedValueOf(el, type, value, delta) {
  const a = liveArenaOf(el);
  return (a ? a.dom : globalThis.__dom).inputStep(a ? nidOf(el) : -1, type, value, delta);
}
// …and the URL an `<img>` fetches with the pixel density of its candidate, `[url, density]` (image_source.rs `select`), a
// `media` judged on its realm's viewport.
export function imageSourceOf(img) {
  const a = liveArenaOf(img);
  if (!a) return attrsOf(img).src == null ? undefined : [attrsOf(img).src, 1];
  return a.dom.imageSource(nidOf(img));
}
// …and whether its directionality is rtl (element_state.rs `is_rtl`, what `:dir()` matches).
export function isRtl(el) {
  const a = liveArenaOf(el);
  return !!a && a.dom.directionality(nidOf(el));
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
    const where = () => (tagOf(n) ? '<' + tagOf(n) + '>' : '#' + nodeTypeOf(n)) + (attrsOf(n) && attrsOf(n).id ? '#' + attrsOf(n).id : '');
    if (arenaNid(n) < 0) throw new Error('[csim] arena verify: unregistered ' + where() + ' via ' + (hostOf(n) ? '<' + tagOf(hostOf(n)) + '> content' : n.host ? 'shadow of <' + tagOf(n.host) + '>' : '-') + ' nid=' + nidOf(n) + ' kids=' + (childNodesOf(n) || []).length + ' hostHere=' + !!(n.host && arenaNid(n.host) >= 0) + ' chain=' + (() => { const out = []; for (let x = n.host; x; x = parentOrHostOf(x)) out.push((tagOf(x) || '#' + nodeTypeOf(x)) + (x === globalThis.document ? '(main)' : '')); return out.join('<'); })());
    const info = d.inspectNode(nidOf(n));
    if (info === null) throw new Error('[csim] arena verify: dead nid for ' + where());
    const kind = ARENA_KIND[nodeTypeOf(n)] ?? 0;
    if (info[0] !== kind) throw new Error('[csim] arena verify: kind ' + info[0] + ' for ' + where());
    if ((kind === 3 || kind === 7 || kind === 8) && info[2] !== String(dataOf(n) ?? '')) throw new Error('[csim] arena verify: stale data in ' + where() + ' under ' + (parentOrHostOf(n) ? tagOf(parentOrHostOf(n)) : '-'));
    if (kind === 7 && info[1] !== piTargetOf(n)) throw new Error('[csim] arena verify: target ' + JSON.stringify(info[1]) + ' for ' + where());
    if (parentNid !== undefined && info[3] !== parentNid) throw new Error('[csim] arena verify: wrong parent for ' + where());
    if (isShadowRoot(n) && info[5] !== nidOf(n.host)) throw new Error('[csim] arena verify: no host for the shadow root of <' + tagOf(n.host) + '>');
    const edges = d.handleEdgesMismatch(nidOf(n));
    if (edges !== undefined) throw new Error('[csim] arena verify: ' + edges + ' for ' + where());
    const kids = childNodesOf(n);
    for (let i = 0; i < kids.length; i++) visit(kids[i], nidOf(n));
    if (templateContentsOf(n)) visit(templateContentsOf(n), undefined);
    if (shadowRootOf(n)) visit(shadowRootOf(n), undefined);
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
  if (!arenaVerifyOn() || !globalThis.document || !(nidOf(globalThis.document) >= 0)) return;
  try { verifyArena(globalThis.document); } catch (e) { arenaVerifyFailed(e.message); throw e; }
}
// A difference verify mode found, kept as well as thrown: a throw inside a rendering step or an event handler is
// swallowed by its caller, and what the runtime keeps (`__csim_arenaVerifyFailed`) is not — nor lost with the realm.
export function arenaVerifyFailed(message) {
  if (typeof globalThis.__csim_arenaVerifyFailed === 'function') globalThis.__csim_arenaVerifyFailed(String(message));
}
