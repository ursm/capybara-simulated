// Fetch's "data: URL processor": a `data:` URL's MIME type (serialized) and body bytes, the engine's (data_url.rs) — one
// answer for fetch(), XHR, a frame's and a media element's source, a script's and a style sheet's, and the host's own (a
// worker's script, a source map).

import { utf8DecodeBytes } from './bytes.js';

// `{ mimeType, body }` (body a latin-1 byte string), or null for a failure — no comma, or a base64 body that is no
// base64 — which the caller turns into a network error.
export function processDataUrl(url) {
  const parsed = globalThis.__dom.dataUrl(String(url));
  return parsed === null ? null : { mimeType: parsed[0], body: parsed[1] };
}
// …and the text of one, its body UTF-8 decoded: a script's, a style sheet's — null for a failure, or where `essence` is
// given and its MIME type's is another (a `data:` style sheet that is no `text/css` is none).
export function dataUrlText(url, essence) {
  const parsed = processDataUrl(url);
  if (parsed === null || (essence !== undefined && parsed.mimeType.split(';')[0] !== essence)) return null;
  return utf8DecodeBytes(parsed.body);
}
