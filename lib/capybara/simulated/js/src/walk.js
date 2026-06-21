import { NODE_ELEMENT, NODE_TEXT, NODE_CDATA, NODE_DOC } from './constants.js';

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
