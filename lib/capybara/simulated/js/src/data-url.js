// Fetch's "data: URL processor": a `data:` URL's MIME type (serialized) and body bytes, the engine's (data_url.rs) — one
// answer for fetch(), XHR, a frame's and a media element's source, a script's and a style sheet's, and the host's own (a
// worker's script, a source map).

import { latin1ToBytes } from './bytes.js';
import { parseMimeType } from './mime.js';

// `{ mimeType, body }` (body a latin-1 byte string), or null for a failure — no comma, or a base64 body that is no
// base64 — which the caller turns into a network error.
export function processDataUrl(url) {
  const parsed = globalThis.__dom.dataUrl(String(url));
  return parsed === null ? null : { mimeType: parsed[0], body: parsed[1] };
}
// …and the text of one — a script's, a style sheet's — its body decoded by the Encoding Standard's "decode" with its
// MIME type's `charset` (UTF-8 where it names none, or none that is an encoding), a BOM over either: null for a failure,
// or where `essence` is given and its MIME type's is another (a `data:` style sheet that is no `text/css` is none).
export function dataUrlText(url, essence) {
  const parsed = processDataUrl(url);
  if (parsed === null) return null;
  if (essence !== undefined && parseMimeType(parsed.mimeType)?.essence !== essence) return null;
  return globalThis.__dom.decodeBytes(latin1ToBytes(parsed.body), null, parsed.mimeType);
}
