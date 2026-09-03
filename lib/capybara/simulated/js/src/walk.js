import { NODE_ELEMENT, NODE_TEXT, NODE_CDATA, NODE_DOC } from './constants.js';

// dom-nodes.js installs the MODE-AGNOSTIC slot lookup here at module init (a direct import would
// be circular — walk.js is one of its own imports). The public `assignedSlot` is open-only, and
// which boxes lay a node out cannot depend on a shadow root's mode.
let slotForStyling = () => null;
export function setSlotResolver(fn) { slotForStyling = fn; }

// The FLAT-TREE parent — the element whose box actually contains `el`'s: a slotted node's is the
// SLOT it is assigned to, and a shadow-tree top-level element's is the HOST (a shadow root is a
// fragment, not a box, so a plain `_parent` walk stops dead at the boundary). `null` above the
// root, and for a node whose parent is not an element.
//
// It lives here, in the module both the layout pass and the mutation recorder can reach, because
// the two have to AGREE: layout descends the flat tree, so a dirty walk up the node tree marked
// the light-DOM ancestors of a slotted box and missed the shadow-side boxes that actually lay it
// out — which then reused their stale boxes forever (a slotted child's height write never moved
// anything until something on the shadow side was touched).
//
// `_parent` is read FIRST, and the slot lookup asked only where a node can actually be slotted —
// under a shadow HOST. Reading `assignedSlot` up front instead cost an accessor dispatch on every
// step of every dirty walk, +22 % on a page with no shadow root anywhere (rule 3).
export function flatTreeParent(el) {
  // A generated-content box (`::before` / `::after`, style-proxy.js `pseudoNodeFor`) is inside its
  // originating element whatever that element is — a shadow host's `::before` is not slotted.
  if (el._pseudo) return el._parent;
  const p = el._parent;
  if (!p) return null;
  if (p._shadowRoot) {
    const slot = slotForStyling(el);
    if (slot) return slot;                   // …else an UNASSIGNED light child: not rendered at
  } else if (p._isShadowRoot) {              //    all, and the host is what the old walk reported
    return p._parent;
  }
  return p.nodeType === NODE_ELEMENT ? p : null;
}

// Depth-first walk of `node`'s subtree. Calls `fn(el)` for every
// Element-typed descendant (skipping text / comment / fragment-root
// nodes). Descends through non-element nodes so a Document or
// ShadowRoot root still surfaces its element descendants.
export function walk(node, fn) {
  if (!node) return;
  if (node.nodeType === NODE_ELEMENT) fn(node);
  // Indexed loop, NOT `for...of`: `_children` is a `NodeList extends
  // Array`, and iterating an Array *subclass* allocates an iterator
  // object per node (V8 can't take the fast-array-iterator path on a
  // subclass) — paid even for the ~half of nodes that are childless
  // leaves. On a find-heavy workload this traversal is ~22% of JS
  // time; the indexed form is ~4× cheaper per node.
  const ch = node._children;
  for (let i = 0; i < ch.length; i++) walk(ch[i], fn);
}

// Pre-order (= document-order) search: returns the first Element
// descendant (or `node` itself) for which `pred(el)` is truthy, and
// stops descending the moment it's found. `walk` has no early-exit —
// its visitor keeps running to the last node — so `findOne` /
// `getElementById`-style "first match" callers must use this instead,
// or they pay a full-tree traversal even when the match is the first
// element. Same indexed-loop rationale as `walk`.
export function walkFind(node, pred) {
  if (!node) return null;
  if (node.nodeType === NODE_ELEMENT && pred(node)) return node;
  const ch = node._children;
  for (let i = 0; i < ch.length; i++) {
    const hit = walkFind(ch[i], pred);
    if (hit) return hit;
  }
  return null;
}

// Like `walk` but invokes `fn` on every node — text, comment,
// fragment-root, document — not just elements. The CE upgrade /
// connect / disconnect paths use this because a `<turbo-frame>`
// containing text needs every descendant visited for handle
// registration even though only elements upgrade.
export function walkSubtree(node, fn) {
  if (!node) return;
  fn(node);
  const ch = node._children;          // indexed, not `for...of` — see walk()
  if (ch) for (let i = 0; i < ch.length; i++) walkSubtree(ch[i], fn);
}

// Set `_ownerDoc` across a subtree INCLUDING each `<template>`'s content
// DocumentFragment and its descendants — which `walkSubtree`'s plain `_children`
// descent skips. Used when a freshly parsed tree is adopted into its document so
// an XML-parsed template's content nodes report the right `ownerDocument` (the
// HTML/parse5 path sets this on the fragment directly; the XML parser can't, as
// the document doesn't exist until adoption).
export function assignOwnerDoc(root, doc) {
  if (!root) return;
  root._ownerDoc = doc;
  if (root._templateContent) {
    // Template content belongs to `doc`'s ASSOCIATED INERT TEMPLATE DOCUMENT,
    // not `doc` itself. The resolver is installed by dom-nodes.js at boot
    // (this module can't create Documents); until then it degrades to `doc`.
    root._templateContent._host = root;
    assignOwnerDoc(root._templateContent, templateDocOf(doc));
  }
  const ch = root._children;
  if (ch) for (let i = 0; i < ch.length; i++) assignOwnerDoc(ch[i], doc);
}

// dom-nodes.js installs `inertTemplateDocFor` here at module init (a direct
// import would be circular — walk.js is one of its own imports).
let templateDocOf = doc => doc;
export function setTemplateDocResolver(fn) { templateDocOf = fn; }

// Like `walkSubtree`, but ALSO descends a host's shadow root, in shadow-
// including tree order (the host, then its shadow tree, then its light
// children). Connecting / disconnecting a subtree connects / disconnects its
// shadow-INCLUDING descendants, so the CE connect / disconnect / move walks use
// this to give a shadow-resident custom element a BALANCED lifecycle and to run
// a shadow-tree <script>'s connection steps (Document-prototype-currentScript).
// The shadow root is read BEFORE visiting the node: a shadow built or extended
// inside the node's own connect/disconnect callback connects its (already-
// connected) children through their own insertion steps, so re-descending it
// here would double-fire the callback. Plain `walk` / `walkSubtree` stay
// light-tree-only — they back ownerDoc / cleanup passes that must NOT cross a
// shadow boundary. The `_shadowRoot` test is O(1) and unset on virtually every
// element, so non-host nodes pay nothing.
export function walkInclShadow(node, fn) {
  if (!node) return;
  const sr = node._shadowRoot;
  fn(node);
  if (sr) {
    const sch = sr._children;
    if (sch) for (let i = 0; i < sch.length; i++) walkInclShadow(sch[i], fn);
  }
  const ch = node._children;          // indexed, not `for...of` — see walk()
  if (ch) for (let i = 0; i < ch.length; i++) walkInclShadow(ch[i], fn);
}

// True iff `node` is in a Document subtree. Walks the parent chain
// looking for a NODE_DOC; cheaper than `getRootNode() instanceof
// Document` and matches the spec's "connected" predicate.
export function isConnected(node) {
  let cur = node;
  while (cur) {
    if (cur.nodeType === NODE_DOC) return true;
    cur = cur._parent;
  }
  return false;
}

// Concatenate the text-node children of an element (the body of a
// `<script>` / `<style>` / `<template>`, or any text-containing
// element where we want only its direct text). Skips nested
// elements — for full subtree text use the DOM `textContent` getter
// instead.
export function scriptText(el) {
  let s = '';
  // Text + CDATASection (XHTML wraps inline script in `<![CDATA[ … ]]>`).
  for (const c of el._children) if (c.nodeType === NODE_TEXT || c.nodeType === NODE_CDATA) s += c.data;
  return s;
}

// `classList.contains` is a per-find hot path under any CSS engine
// that walks the tree and tests each candidate. Cache the parsed
// class list against the raw `class` attribute string so repeat
// reads skip the split. The cache invalidates whenever the
// attribute changes (different string identity).
export function classes(el) {
  const cls = el._attrs['class'];
  if (!cls) return [];
  if (el._classesCacheKey === cls) return el._classesCache;
  const arr = cls.split(/\s+/).filter(Boolean);
  el._classesCacheKey = cls;
  el._classesCache    = arr;
  return arr;
}

// `getElementById` — direct id-attribute search, bypassing CSS selector
// parsing. The CSS path (`querySelector('#' + id)`) throws on ids with
// non-identifier chars (slashes, colons, brackets) but the DOM spec accepts any
// string verbatim. Avo names index components with slashes
// (`avo/index/grid_item_component_<param>`), so Turbo's stream-replace
// targeting these would otherwise throw and silently no-op. `walkFind` stops at
// the first tree-order match (getElementById's contract).
export function findById(root, id) {
  if (!root) return null;
  // `getElementById`'s argument is a DOMString: `null` → "null", `undefined`
  // → "undefined" (WebIDL coercion), NOT an early no-match. An element whose
  // id is literally "null"/"undefined" must be found.
  const target = String(id);
  if (target.length === 0) return null;
  return walkFind(root, el => el._attrs && el._attrs.id === target);
}

// The `<source>` an `<img>` inside a `<picture>` takes from. HTML picks the source whose `media` /
// `type` match and whose `srcset` yields a candidate; ours is the MINIMAL selection — the first
// `<source>` carrying a candidate — because real density / width choice needs a DPR and layout we
// don't model, and a single-source `<picture>` is the common authoring and every vendored test.
//
// ONE rule, because it answers two questions that must agree: which URL the image loads
// (`_imageResourceSrc`) and which element's `width` / `height` attributes map onto the img
// (the cascade's presentational hint). Returns null when the img is not in a picture, or when no
// source offers a candidate.
export function pictureSourceFor (img, mediaMatches) {
  const parent = img && img._parent;
  if (!parent || parent._tag !== 'picture') return null;
  for (const child of parent._children || []) {
    // "Update the image data" walks the picture's children UNTIL IT REACHES THE IMG, so a source
    // written after it is never a candidate (Chrome-verified: the img keeps its own dimensions).
    if (child === img) return null;
    if (child.nodeType !== 1 || child._tag !== 'source') continue;
    const attrs = child._attrs || {};
    // `media` and `type` are how art direction picks between sources, so a source whose media
    // query doesn't match — or whose type nothing can decode — is skipped, not selected. `type` is
    // judged by whether it names an image format at all: we decode what libvips decodes, and the
    // useful distinction is a real format vs the `image/bogus` a test uses to force the fallback.
    if (attrs.media && mediaMatches && !mediaMatches(String(attrs.media))) continue;
    if (attrs.type && !DECODABLE_IMAGE_TYPE.test(String(attrs.type).trim())) continue;
    const first = String(attrs.srcset || '').trim().split(',')[0];
    if (first && first.trim().split(/\s+/)[0]) return child;
  }
  return null;
}
const DECODABLE_IMAGE_TYPE = /^image\/(png|jpe?g|gif|webp|avif|svg\+xml|bmp|x-icon|vnd\.microsoft\.icon|tiff|heic|heif)$/i;
