// The MIME types the parser treats as an XML document (DOM document "type" =
// "xml"): they get case-sensitive node names, XML serialization, and
// `application/xml` when sent as an XHR body. EVERYTHING else — `text/html`, but
// also `text/plain` / `application/json` / `text/css` / an image rendered in a
// frame — is an HTML document: HTML-parsed (wrapped in `<html><body>…`), keeping
// HTML semantics even though `document.contentType` still reflects the response
// MIME (a lowercase `/html` query must still match the uppercase nodeName —
// Discourse's `become.json` sign-in).
export function isXmlMimeType(ct) {
  return ct === 'text/xml' || ct === 'application/xml' ||
         ct === 'application/xhtml+xml' || ct === 'image/svg+xml';
}

// Whether `doc` is an HTML document (vs an XML-parsed one). A document with no
// recorded content type (a bare `new Document()` / the boot + `<template>` owner
// document) is HTML; note `createDocument` and `createHTMLDocument` DO set
// `_contentType` (application/xml… and text/html respectively), so they classify
// by the MIME branch, not this default.
export function isHtmlDocument(doc) {
  return !doc || !doc._contentType || !isXmlMimeType(doc._contentType);
}
