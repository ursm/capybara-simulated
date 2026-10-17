import { NODE_ELEMENT, HTML_NS, SVG_NS } from './constants.js';
import { childCountOf } from './native-query-shadow.js';

// Set `_ownerDoc` across a subtree INCLUDING each `<template>`'s content
// DocumentFragment and its descendants — which a plain `_children` descent
// skips. Used when a freshly parsed tree is adopted into its document so
// an XML-parsed template's content nodes report the right `ownerDocument` (the
// HTML parser path sets this on the fragment directly; the XML parser can't, as
// the document doesn't exist until adoption).
export function assignOwnerDoc(root, doc) {
  if (!root) return;
  root._ownerDoc = doc;
  if (root._templateContent) {
    // Template content belongs to `doc`'s ASSOCIATED INERT TEMPLATE DOCUMENT,
    // not `doc` itself. The resolver is installed by dom-nodes.js at boot
    // (this module can't create Documents); until then it degrades to `doc`.
    assignOwnerDoc(root._templateContent, templateDocOf(doc));
  }
  if (childCountOf(root, false) === 0) return;
  const ch = root._children;
  for (let i = 0; i < ch.length; i++) assignOwnerDoc(ch[i], doc);
}

// dom-nodes.js installs `inertTemplateDocFor` here at module init (a direct
// import would be circular — walk.js is one of its own imports).
let templateDocOf = doc => doc;
export function setTemplateDocResolver(fn) { templateDocOf = fn; }

// Every node of `node`'s subtree, as a `_children` descent visits them — and ALSO a host's shadow root, in shadow-
// including tree order (the host, then its shadow tree, then its light
// children). Connecting / disconnecting a subtree connects / disconnects its
// shadow-INCLUDING descendants, so the CE connect / disconnect / move walks use
// this to give a shadow-resident custom element a BALANCED lifecycle and to run
// a shadow-tree <script>'s connection steps (Document-prototype-currentScript).
// The shadow root is read BEFORE visiting the node: a shadow built or extended
// inside the node's own connect/disconnect callback connects its (already-
// connected) children through their own insertion steps, so re-descending it
// here would double-fire the callback. (`assignOwnerDoc` stays light-tree-only:
// it must NOT cross a shadow boundary.) The `_shadowRoot` test is one engine call a node.
export function walkInclShadow(node, fn) {
  if (!node) return;
  const sr = node._shadowRoot;
  fn(node);
  if (sr) {
    const sch = sr._children;
    for (let i = 0; i < sch.length; i++) walkInclShadow(sch[i], fn);
  }
  if (childCountOf(node, false) === 0) return;   // (…a leaf, told by its child count, a fast call, with no list made for it)
  const ch = node._children;
  for (let i = 0; i < ch.length; i++) walkInclShadow(ch[i], fn);
}

// The elements `walkInclShadow` visits, collected BEFORE any of them is acted on: a reaction walk (connected /
// disconnected / adopted callbacks) runs page code that may replace the very children it is walking, and the spec queues
// every reaction during the tree operation, before any of them runs.
export function inclShadowElements(node) {
  const out = [];
  walkInclShadow(node, n => { if (n._nodeType === NODE_ELEMENT) out.push(n); });
  return out;
}

// True iff `node` is in a Document subtree (shadow-including): the engine's answer (a fast call, element_state.rs
// `is_connected`) — a generated box's holder answering as its element.
export function isConnected(node) {
  if (node == null) return false;
  if (node._pseudo !== undefined) node = node._parent;
  return globalThis.__dom.isConnected(node._nid);
}

// Whether `el` is a script element — an HTML or SVG one, `script` its local name: what runs, and what a parser starts.
// (Not its lowercased tag name: `createElementNS(XHTML, 'SCRIPT')` is an HTMLUnknownElement, which Chrome runs no
// script of.)
export function isScriptElement(el) {
  return el._localName === 'script' && (el._ns === HTML_NS || el._ns === SVG_NS);
}
// …and what it is, by its `type` and `language` (HTML "prepare the script element" steps 8-12) — the engine's (script.rs):
// a data block, which runs as nothing, a classic script, a module, an import map, speculation rules.
export const SCRIPT_DATA_BLOCK = 0, SCRIPT_CLASSIC = 1, SCRIPT_MODULE = 2, SCRIPT_IMPORT_MAP = 3;
// …and what preparing one (`__dom.prepareScript`) found it is to do: nothing, fire `error`, run as a classic script, as a
// module, register its import map.
export const PREPARE_NONE = 0, PREPARE_ERROR = 1, PREPARE_CLASSIC = 2, PREPARE_MODULE = 3, PREPARE_IMPORT_MAP = 4;
export function scriptTypeOf(el) {
  return globalThis.__dom.scriptType(el._nid);
}
// …and its flags (HTML §4.12.1.1), the engine's too: "already started", parser-inserted (its parser document), whether it
// is NOT "force async" — which it is made with — and whether the after-parse pass has run it.
export const SCRIPT_ALREADY_STARTED = 1, SCRIPT_PARSER_INSERTED = 2, SCRIPT_NOT_FORCE_ASYNC = 4, SCRIPT_RUN = 8;
export function scriptFlag(el, flag) {
  return (globalThis.__dom.scriptFlags(el._nid) & flag) !== 0;
}
export function setScriptFlag(el, flag, on) {
  globalThis.__dom.setScriptFlags(el._nid, flag, on ? flag : 0);
}

// `getElementById` — the engine's id search (collections.rs `elementById`), the first tree-order match under `root`
// (itself included), bypassing CSS selector parsing: the DOM spec takes any string verbatim, where a `#id` selector
// throws on non-identifier chars (Avo names index components with slashes, `avo/index/grid_item_component_<param>`,
// which Turbo's stream-replace targets).
export function findById(root, id) {
  if (!root) return null;
  // `getElementById`'s argument is a DOMString: `null` → "null", `undefined`
  // → "undefined" (WebIDL coercion), NOT an early no-match. An element whose
  // id is literally "null"/"undefined" must be found.
  const target = String(id);
  if (target.length === 0) return null;
  return globalThis.__dom.elementById(root._nid, target)[0] || null;
}

