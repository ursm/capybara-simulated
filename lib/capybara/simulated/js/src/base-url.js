// A document's URLs as the platform reads them (HTML §2.4.1): its fallback base URL, its document base URL — the
// engine's (url_ops.rs `document_base_url`) — and a URL parsed against that in its encoding. Internal reads all: never
// the `URL`, `baseURI`, `ownerDocument` or `characterSet` a page can redefine, nor the `URL` constructor it can replace.

import { documentElementOf } from './document-tree.js';
import { parseURL } from './url-parse.js';
import { REALM, documentBaseUrlOf } from './native-query-shadow.js';

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
// URL); absent any, the fallback URL itself — the engine's (url_ops.rs `document_base_url`). Cached per document.
export function documentBaseURL(doc) {
  const fallback = fallbackBaseURL(doc);
  if (!doc || !documentElementOf(doc)) return fallback;
  // (…kept against the engine's base epoch, which only a `<base>` linked, unlinked or freed, or its `href` written,
  // moves — the parser's included — not every write a page makes)
  const gen = globalThis.__dom.baseEpoch();
  const cache = doc.__baseUrlCache;
  // Key on the fallback URL too: a navigation can swap the document URL without
  // the epoch having moved (the live document is reused across visits), and the
  // resolved base depends on that fallback.
  if (cache && cache.gen === gen && cache.fallback === fallback) return cache.href;
  const href = documentBaseUrlOf(doc, fallback, documentEncoding(doc));
  doc.__baseUrlCache = { gen, fallback, href };
  return href;
}
// HTML "encoding-parse-and-serialize a URL": `value` parsed against `doc`'s base URL, a special URL's query in its
// encoding, and serialized — or null where it parses to no URL.
export function parseDocumentURL(doc, value) {
  return parseURL(value, documentBaseURL(doc), documentEncoding(doc))?.href ?? null;
}
// …relative to an element's node document: what a generated [ReflectURL] attribute resolves its value by (reflect.js),
// and what an element's resource — a script's, a style sheet's, an image's, a media element's — is fetched from.
export const resolveURLValue = (el, value) => parseDocumentURL(el._ownerDocument, value);
// …and a URL an API takes (`new Worker(url)`, `new EventSource(url)`): "encoding-parse a URL" relative to the current
// settings object — its API base URL and encoding, a window's document's, a worker's URL and UTF-8 — the URL's
// components, or null where it is no URL. (…`encoded` false for an API that applies the URL parser to it against that
// base, in UTF-8 whatever the document's encoding: the WebSocket constructor)
export function parseAPIURL(input, encoded = true) {
  const doc = globalThis.document;
  const base = doc ? documentBaseURL(doc) : documentURL(null) || null;
  return parseURL(input, base, encoded && doc ? documentEncoding(doc) : null);
}
