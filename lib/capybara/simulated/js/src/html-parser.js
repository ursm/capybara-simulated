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
// host (HTML "serializing a shadow root"). Which roots, and the template's attributes, are said here.
function shouldSerializeShadow(sr, opts) {
  if (!sr) return false;
  if (opts.serializableShadowRoots && sr.serializable) return true;
  return !!(opts.shadowRoots && opts.shadowRoots.indexOf(sr) !== -1);
}
// Whether a serialized declarative root declares `shadowrootcustomelementregistry`: a scoped root always does; a null
// root only when the host itself is non-null (a null host implies null roots).
function serializeRegistryAttr(sr, host) {
  let srReg, hostReg;
  try { srReg = sr.customElementRegistry; hostReg = host.customElementRegistry; } catch (_) { return false; }
  if (srReg && srReg._scoped) return true;
  return srReg === null && hostReg !== null;
}
// A host's root's opening `<template>` tag — its attributes in HTML's order: mode, delegatesfocus, serializable,
// slotassignment (only "manual"), clonable, the authored adoptedstylesheets value, customelementregistry.
function shadowTemplateTag(host) {
  const sr = host._shadowRoot;
  return '<template shadowrootmode="' + sr.mode + '"' +
    (sr.delegatesFocus ? ' shadowrootdelegatesfocus=""' : '') +
    (sr.serializable ? ' shadowrootserializable=""' : '') +
    (sr.slotAssignment === 'manual' ? ' shadowrootslotassignment="manual"' : '') +
    (sr.clonable ? ' shadowrootclonable=""' : '') +
    (sr._adoptedStyleSheetsAttr != null ? ' shadowrootadoptedstylesheets="' + escapeAttr(sr._adoptedStyleSheetsAttr) + '"' : '') +
    (serializeRegistryAttr(sr, host) ? ' shadowrootcustomelementregistry=""' : '') +
    '>';
}
export function serializeChildrenWithShadow(el, opts) {
  const shadows = [];
  // (…every host the serialization reaches: through a `<template>`'s contents, and through each root it writes)
  const visit = (n) => {
    if (n._nodeType === 1 && shouldSerializeShadow(n._shadowRoot, opts)) {
      shadows.push(n, shadowTemplateTag(n));
      visit(n._shadowRoot);
    }
    const kids = n._tag === 'template' && n._templateContent ? n._templateContent._children : n._children;
    if (kids) for (const c of kids) visit(c);
  };
  if (opts.serializableShadowRoots || (opts.shadowRoots && opts.shadowRoots.length)) visit(el);
  return serializedHtml(el, false, shadows);
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

// HTML "escaping a string": `&` and U+00A0 always; `"` in an attribute; `<` and `>` in both (the attribute arm since
// the 2025 spec change — Chrome writes `title="a&lt;b&gt;"`).
function escapeAttr(v) {
  return String(v).replace(/&/g, '&amp;').replace(/\u00A0/g, '&nbsp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

