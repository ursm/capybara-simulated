// A document's URLs as the platform reads them (HTML §2.4.1): its fallback base URL, its document base URL — the
// engine's (url_ops.rs `document_base_url`) — and a URL parsed against that in its encoding. Internal reads all: never
// the `URL`, `baseURI`, `ownerDocument` or `characterSet` a page can redefine, nor the `URL` constructor it can replace.

import { parseURL } from './url-parse.js';
import { REALM } from './native-query-shadow.js';

// A document's URL — its address; where it keeps none of its own (a window's live document), its realm's URL: the
// engine's (document_state.rs `document_url`), this realm's for no document.
export function documentURL(doc) {
  return doc ? globalThis.__dom.docUrl(doc._nid) : REALM.realmURL?.() ?? '';
}
// …and its character encoding, which a special URL's query is encoded in.
export function documentEncoding(doc) {
  return (doc && doc._encoding) || 'UTF-8';
}

// HTML "fallback base URL": the document's URL — but an about:blank / about:srcdoc document resolves relative URLs
// against its INHERITED base URL (the creator's, stored on the document at frame build via __csimSetAboutBaseURL), not
// the opaque "about:…" URL, which can't serve as a base — the engine's too (`document_url`).
export function fallbackBaseURL(doc) {
  return doc ? globalThis.__dom.docUrl(doc._nid, true) : REALM.realmURL?.() || 'about:blank';
}
// HTML "document base URL": the frozen base URL of the first `<base href>` in tree order — anywhere, not only in
// `<head>` — resolved against the document's fallback base URL in its encoding (none of a `data:` or `javascript:`
// URL); absent any, the fallback URL itself — the engine's, which keeps it (document_state.rs `document_base_url`).
export function documentBaseURL(doc) {
  return doc ? globalThis.__dom.docBaseUrl(doc._nid) : fallbackBaseURL(null);
}
// HTML "encoding-parse-and-serialize a URL": `value` parsed against `doc`'s base URL, a special URL's query in its
// encoding, and serialized — or null where it parses to no URL (document_state.rs `parse_document_url`).
export function parseDocumentURL(doc, value) {
  return doc ? globalThis.__dom.docParseUrl(doc._nid, value, false) : parseURL(value, fallbackBaseURL(null))?.href ?? null;
}
// …relative to an element's node document: what a generated [ReflectURL] attribute resolves its value by (reflect.js),
// and what an element's resource — a script's, a style sheet's, an image's, a media element's — is fetched from.
export const resolveURLValue = (el, value) => parseDocumentURL(el._ownerDocument, value);
// …and a URL an API takes (`new Worker(url)`, `new EventSource(url)`): "encoding-parse a URL" relative to the current
// settings object — its API base URL and encoding, a window's document's, a worker's URL and UTF-8 — the URL's
// components, or null where it is no URL. (…`encoded` false for an API that applies the URL parser to it against that
// base, in UTF-8 whatever the document's encoding: the WebSocket constructor)
export function parseAPIURL(input, encoded = true) {
  const [base, encoding] = apiURLSettings();
  return parseURL(input, base, encoded ? encoding : null);
}
// …that settings object's API base URL and its URL encoding (none where it is UTF-8: a worker's), for an engine step
// that parses the URL itself.
export function apiURLSettings() {
  const doc = globalThis.document;
  return [doc ? documentBaseURL(doc) : documentURL(null) || null, doc ? documentEncoding(doc) : null];
}
