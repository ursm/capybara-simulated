import { NODE_ELEMENT, NODE_TEXT, NODE_DOC } from './constants.js';

// Depth-first walk of `node`'s subtree. Calls `fn(el)` for every
// Element-typed descendant (skipping text / comment / fragment-root
// nodes). Descends through non-element nodes so a Document or
// ShadowRoot root still surfaces its element descendants.
export function walk(node, fn) {
  if (!node) return;
  if (node.nodeType === NODE_ELEMENT) fn(node);
  for (const c of node._children) walk(c, fn);
}

// Like `walk` but invokes `fn` on every node — text, comment,
// fragment-root, document — not just elements. The CE upgrade /
// connect / disconnect paths use this because a `<turbo-frame>`
// containing text needs every descendant visited for handle
// registration even though only elements upgrade.
export function walkSubtree(node, fn) {
  if (!node) return;
  fn(node);
  if (node._children) for (const c of node._children) walkSubtree(c, fn);
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

// HTML spec "first newline removal" — when a `<textarea>` is
// initialised from parsed text, one leading line terminator
// (`\r\n` / `\r` / `\n`) is stripped. Callers that read the textarea's
// post-parse value via `.textContent` (rather than the IDL `value`
// after user input) apply this to mirror what the parser would.
export function stripOneLeadingNewline(s) {
  if (typeof s !== 'string' || s.length === 0) return s;
  if (s.length >= 2 && s.charCodeAt(0) === 13 && s.charCodeAt(1) === 10) return s.slice(2);
  if (s.charCodeAt(0) === 13 || s.charCodeAt(0) === 10) return s.slice(1);
  return s;
}

// Concatenate the text-node children of an element (the body of a
// `<script>` / `<style>` / `<template>`, or any text-containing
// element where we want only its direct text). Skips nested
// elements — for full subtree text use the DOM `textContent` getter
// instead.
export function scriptText(el) {
  let s = '';
  for (const c of el._children) if (c.nodeType === NODE_TEXT) s += c.data;
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
