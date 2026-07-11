// Wire form for crossing a Response across an isolate / Ruby boundary and back —
// shared by the service-worker fetch respondWith round-trip (workers.js) and the
// Cache Storage put/match round-trip (cache-storage.js). The body is fully
// materialized to raw latin-1 bytes and base64-encoded (streams work because the
// caller drains via `arrayBuffer()` first). `body: ''` is the marker the internal
// `new Response(raw, url)` constructor keys off — it takes the internal branch only
// when the argument carries both a `status` and a `body` own property.
import { bytesToLatin1 } from './bytes.js';

// Serialize `resp` together with its already-collected `bytes` (a Uint8Array from
// `resp.arrayBuffer()`) to the plain wire object. `bytes` is the fully-drained body, so
// reading `resp.body` here only reports its null-ness (a null-body response — any status,
// not just 204/205/304 — must reconstruct with `.body === null`). LIMITATION: `headers` is a
// combined-value object, so a response carrying duplicate header names (e.g. multiple
// Set-Cookie, which the 'response' guard drops from script-created responses anyway) keeps
// only the last across the wire.
export function serializeResponseWire(resp, bytes) {
  const headers = {};
  resp.headers.forEach((v, k) => { headers[k] = v; });
  return {
    status:     resp.status,
    statusText: resp.statusText || '',
    headers,
    body_b64:   globalThis.btoa(bytesToLatin1(bytes)),
    body:       '',
    url:        resp.url || '',
    type:       resp.type || 'default',
    redirected: !!resp.redirected,
    body_null:  resp.body === null
  };
}

// The response HEAD only (status / headers / metadata, no body) — the `start` frame of a
// streaming respondWith round-trip (workers.js), where the body is delivered incrementally as
// separate `chunk` frames rather than materialized up front. The client reconstructs a Response
// whose body is a ReadableStream fed by those chunks (sw-client.js).
export function serializeResponseMeta(resp) {
  const headers = {};
  resp.headers.forEach((v, k) => { headers[k] = v; });
  return {
    status:     resp.status,
    statusText: resp.statusText || '',
    headers,
    url:        resp.url || '',
    type:       resp.type || 'default',
    redirected: !!resp.redirected
  };
}

// Reconstruct a Response from the wire object (the internal `(raw, url)` ctor form).
export function responseFromWire(raw) {
  if (raw.body === undefined) raw.body = '';
  return new globalThis.Response(raw, raw.url);
}
