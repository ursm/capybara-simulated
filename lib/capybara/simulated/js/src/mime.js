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
export function normalizeDataFormat(format) {
  const f = String(format).toLowerCase();
  if (f === 'text') return 'text/plain';
  if (f === 'url')  return 'text/uri-list';
  return f;
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
