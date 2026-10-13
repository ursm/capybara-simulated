// Fetch's "data: URL processor": a `data:` URL's MIME type (serialized) and body bytes, the engine's (data_url.rs) — one
// answer for fetch(), XHR, a frame's and a media element's source, and the host's own (a worker's script, a source map).

// `{ mimeType, body }` (body a latin-1 byte string), or null for a failure — no comma, or a base64 body that is no
// base64 — which the caller turns into a network error.
export function processDataUrl(url) {
  const parsed = globalThis.__dom.dataUrl(String(url));
  return parsed === null ? null : { mimeType: parsed[0], body: parsed[1] };
}
