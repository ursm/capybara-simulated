// The MIME types the parser treats as an XML document (DOM document "type" =
// "xml"): they get case-sensitive node names, XML serialization, and
// `application/xml` when sent as an XHR body. EVERYTHING else — `text/html`, but
// also `text/plain` / `application/json` / `text/css` / an image rendered in a
// frame — is an HTML document: HTML-parsed (wrapped in `<html><body>…`), keeping
// HTML semantics even though `document.contentType` still reflects the response
// MIME (a lowercase `/html` query must still match the uppercase nodeName —
// Discourse's `become.json` sign-in).
// The drag data store / clipboard key a `format` string maps to: ASCII-lowercased, with the two
// legacy shorthands normalized away (`text` → `text/plain`, `url` → `text/uri-list`). Shared by
// DataTransfer's getData / setData / clearData and the ClipboardEvent `clipboardData` views, which
// key their data the same way.
export const asciiLowercase = (s) => s.replace(/[A-Z]+/g, (c) => c.toLowerCase());
export function normalizeDataFormat(format) {
  const f = asciiLowercase(String(format));
  if (f === 'text') return 'text/plain';
  if (f === 'url')  return 'text/uri-list';
  return f;
}

// A MIME type parsed (WHATWG MIME Sniffing, mime.rs): its `essence` (type/subtype, lowercased) and its `parameters`
// (a Map, names lowercased, in order), `toString()` serializing it back — or null where `text` is no MIME type.
export function parseMimeType(text) {
  const parsed = globalThis.__dom.mimeParse(String(text));
  if (parsed === null) return null;
  const parameters = new Map();
  for (let k = 1; k + 1 < parsed.length; k += 2) parameters.set(parsed[k], parsed[k + 1]);
  return { essence: parsed[0], parameters, toString() { return globalThis.__dom.mimeSerialize(this.essence, [...this.parameters].flat()); } };
}

// …and the MIME type a `Content-Type` header's value gives (Fetch's "extract a MIME type", mime.rs `extract`),
// serialized — '' where none of its values is one.
export function extractMimeType(header) {
  return globalThis.__dom.mimeExtract(String(header)) ?? '';
}

export function isXmlMimeType(ct) {
  return ct === 'text/xml' || ct === 'application/xml' ||
         ct === 'application/xhtml+xml' || ct === 'image/svg+xml';
}

// Whether `doc` is an HTML document (vs an XML-parsed one). A document with no
// recorded content type (the boot + `<template>` owner document, whose
// `_contentType` is reset to undefined) is HTML; `new Document()`,
// `createDocument` and `createHTMLDocument` all SET `_contentType`
// (application/xml, application/xml…, and text/html respectively), so they
// classify by the MIME branch, not this default.
export function isHtmlDocument(doc) {
  return !doc || !doc._contentType || !isXmlMimeType(doc._contentType);
}
