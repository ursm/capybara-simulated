// HTML serialization for innerHTML / outerHTML / getHTML() / a driver's page source — the arena's (serialize.rs) —
// and the entity decoding the XML parser shares. The HTML PARSER is html5ever (html_parse.rs, with
// html-tree-builder.js taking the tree it builds).

import { serializedHtml } from './native-query-shadow.js';

// Serialization is the arena's (serialize.rs): an element's or a fragment's children, or the element itself, as markup.
export function serializeElement(el) {
  return el && el._nodeType === 1 ? serializedHtml(el, true) : '';
}
export function serializeChildren(el) {
  return serializedHtml(el, false);
}

// `getHTML(options)`: the children, with each shadow root `options` asks for — `serializableShadowRoots` and the root
// `serializable`, or the root listed in `shadowRoots` — written as a `<template shadowrootmode=…>` first child of its
// host (HTML "serializing a shadow root"): the engine's (serialize.rs `serializable_shadows`).
export function serializeChildrenWithShadow(el, opts) {
  return serializedHtml(el, false, !!opts.serializableShadowRoots, opts.shadowRoots);
}
