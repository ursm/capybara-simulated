// HTML serializer — turns our DOM nodes back into markup for innerHTML /
// outerHTML / document serialization. The HTML PARSER is parse5 now
// (js/src/parse5-adapter.js); the hand-rolled tag-soup parser that used to live
// here (installHtmlParser) was removed once parse5 backed every parse path.
// These are top-level exports (no DOM-ctor injection needed — pure node-shape
// traversal) so host fns (`__csimInnerHTML` / `__csimOuterHTML` /
// `__csimDocumentHtml`) import them directly.

import { NODE_TEXT, NODE_CDATA, NODE_COMMENT, HTML_NS } from './constants.js';

const VOID = new Set(['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr']);

// Serializer side does not need the DOM-ctor injection — it's pure
// node-shape traversal. Live as top-level exports so host fns
// (`__csimInnerHTML` / `__csimOuterHTML` / `__csimDocumentHtml`) can
// import directly.
// Serialize an element's attributes under their qualified NAMEs. The store key
// usually IS the qualified name; a collision-keyed namespaced attr has a
// synthetic key, so recover the qualified name from _attrNS (same as the XML
// serializer).
function serializeAttrs(el) {
  // HTML fragment serialization: an element with an is VALUE but no `is` content
  // attribute serializes that value as an `is="…"` attribute FIRST (before the
  // content attributes) — so a customized built-in created via createElement({is})
  // round-trips, even when its definition is absent. (`_isValue` is the internal
  // slot; a parsed/cloned one carries `is` in `_attrs` and takes the normal path.)
  const isAttr = el._isValue != null && el._attrs.is == null
    ? ' is="' + escapeAttr(el._isValue) + '"'
    : '';
  return isAttr + Object.keys(el._attrs).map(n => {
    const m = el._attrNS && el._attrNS[n];
    const qn = m ? (m.prefix ? m.prefix + ':' + m.localName : m.localName) : n;
    return ' ' + qn + '="' + escapeAttr(el._attrs[n]) + '"';
  }).join('');
}

export function serializeElement(el) {
  // DocumentFragment / Comment / Unknown nodeTypes lack `_attrs` and
  // `_tag` — they shouldn't be serialised as elements. Guard so a
  // foreign node grafted into the tree doesn't crash the dump path.
  if (!el || !el._tag || !el._attrs) return '';
  const attrs = serializeAttrs(el);
  if (VOID.has(el._tag)) return '<' + el._tag + attrs + '>';
  return '<' + el._tag + attrs + '>' + serializeChildren(el) + '</' + el._tag + '>';
}

// Shadow-aware serialization for `getHTML(options)`. Like serializeChildren /
// serializeElement, but when an element hosts a shadow root that `options` asks
// to serialize — `serializableShadowRoots` + the root's `serializable` flag, or
// the root being listed in `shadowRoots` — the root is emitted as a
// `<template shadowrootmode=…>` first child (HTML "serializing a shadow root").
function shouldSerializeShadow(sr, opts) {
  if (!sr) return false;
  if (opts.serializableShadowRoots && sr.serializable) return true;
  return !!(opts.shadowRoots && opts.shadowRoots.indexOf(sr) !== -1);
}
// The `<template shadowrootmode>` serialization of `el`'s own shadow root, or
// '' when there is none to serialize. Emitted as the first child of `el`.
function shadowTemplate(el, opts) {
  const sr = el && el._shadowRoot;
  if (!shouldSerializeShadow(sr, opts)) return '';
  // HTML "serializing a shadow root" attribute order: mode, delegatesfocus,
  // serializable, slotassignment (only when non-default "manual"), clonable.
  return '<template shadowrootmode="' + sr.mode + '"' +
    (sr.delegatesFocus            ? ' shadowrootdelegatesfocus=""' : '') +
    (sr.serializable              ? ' shadowrootserializable=""'   : '') +
    (sr.slotAssignment === 'manual' ? ' shadowrootslotassignment="manual"' : '') +
    (sr.clonable                  ? ' shadowrootclonable=""'       : '') +
    // The authored `shadowrootadoptedstylesheets` value round-trips verbatim
    // (present-but-empty serializes as ="", absent is omitted). `_adoptedStyleSheetsAttr`
    // is the parse-time string, not the live adoptedStyleSheets list.
    (sr._adoptedStyleSheetsAttr != null ? ' shadowrootadoptedstylesheets="' + escapeAttr(sr._adoptedStyleSheetsAttr) + '"' : '') +
    '>' + serializeChildrenWithShadow(sr, opts) + '</template>';
}
// Serialize `el`'s children INCLUDING `el`'s own shadow root (as the first
// child). This is the `getHTML(el)` body — so calling getHTML directly on a
// shadow host emits its template, and a host nested inside the serialized
// subtree gets its template via serializeElementWithShadow → here.
export function serializeChildrenWithShadow(el, opts) {
  let s = shadowTemplate(el, opts);   // el's own shadow root, if serializable (no-op for non-hosts)
  if (!el || !el._children) return s;
  const raw = el._tag && RAWTEXT_SER.has(el._tag) && (el._ns == null || el._ns === HTML_NS);
  for (const c of el._children) {
    if (c.nodeType === NODE_TEXT) s += raw ? String(c.data == null ? '' : c.data) : escapeText(c.data);
    else if (c.nodeType === NODE_COMMENT) s += '<!--' + String(c.data == null ? '' : c.data) + '-->';
    else if (c.nodeType === NODE_CDATA) s += '<![CDATA[' + String(c.data == null ? '' : c.data) + ']]>';
    else s += serializeElementWithShadow(c, opts);
  }
  return s;
}
function serializeElementWithShadow(el, opts) {
  if (!el || !el._tag || !el._attrs) return '';
  const attrs = serializeAttrs(el);
  if (VOID.has(el._tag)) return '<' + el._tag + attrs + '>';
  return '<' + el._tag + attrs + '>' + serializeChildrenWithShadow(el, opts) + '</' + el._tag + '>';
}

// HTML fragment serialization: a text node whose parent is one of these emits its
// data LITERALLY (no `&`/`<` escaping) — the parser reads these elements' content
// as raw text, so escaping would corrupt round-trips (`style.innerHTML += …` turns
// a stylesheet's `&` into `&amp;` otherwise). HTML namespace only: foreign (SVG)
// style/script content DOES process character references at parse, so it keeps the
// escaping path. `<noscript>` is deliberately absent — this driver parses with
// scriptingEnabled:false (parse5-adapter), so noscript children are real elements
// with entity-decoded text; emitting that verbatim would corrupt the round-trip
// (`&lt;img&gt;` text re-parsing as a live <img> — the mXSS shape).
const RAWTEXT_SER = new Set(['style', 'script', 'xmp', 'iframe', 'noembed', 'noframes', 'plaintext']);

export function serializeChildren(el) {
  let s = '';
  if (!el || !el._children) return s;
  const raw = el._tag && RAWTEXT_SER.has(el._tag) && (el._ns == null || el._ns === HTML_NS);
  for (const c of el._children) {
    if (c.nodeType === NODE_TEXT) s += raw ? String(c.data == null ? '' : c.data) : escapeText(c.data);
    else if (c.nodeType === NODE_COMMENT) s += '<!--' + String(c.data == null ? '' : c.data) + '-->';
    // CDATASection (XML docs only) serializes verbatim, not escaped — without
    // this it would fall to serializeElement and vanish (no _tag).
    else if (c.nodeType === NODE_CDATA) s += '<![CDATA[' + String(c.data == null ? '' : c.data) + ']]>';
    else s += serializeElement(c);
  }
  return s;
}

export function decodeEntities(s) {
  return s.replace(/&(amp|lt|gt|quot|apos|nbsp|#\d+|#x[0-9a-fA-F]+);/g, (_, e) => {
    if (e === 'amp')  return '&';
    if (e === 'lt')   return '<';
    if (e === 'gt')   return '>';
    if (e === 'quot') return '"';
    if (e === 'apos') return "'";
    if (e === 'nbsp') return ' ';
    if (e[0] === '#') {
      const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    }
    return '';
  });
}

export function escapeAttr(v) { return String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;'); }
export function escapeText(v) { return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
