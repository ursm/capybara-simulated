// Wire form for crossing a Response across an isolate / Ruby boundary and back —
// shared by the service-worker fetch respondWith round-trip (workers.js) and the
// Cache Storage put/match round-trip (cache-storage.js). The wire travels as JSON
// TEXT, so the body is fully materialized (streams work because the caller drains
// it first) and base64-encoded as `body_b64`; `rawFromWire` turns it back into the
// in-memory raw form a rack response has — the bytes as a Uint8Array under
// `body_bytes` — which `responseFromRaw` makes a Response of. A Response is read by
// its slots, not by getters a page may have replaced.

import { headerPairs } from './headers.js';
import { responseFromRaw, responseOf } from './fetch.js';

// The response HEAD (status / headers / metadata, no body). LIMITATION: `headers` is a
// combined-value object, so a response carrying duplicate header names (e.g. multiple
// Set-Cookie, which the 'response' guard drops from script-created responses anyway) keeps
// only the last across the wire.
function responseHead(s) {
  return {
    status:     s.status,
    statusText: s.statusText,
    headers:    Object.fromEntries(headerPairs(s.headers)),
    url:        s.url,
    type:       s.type,
    redirected: s.redirected
  };
}

// Serialize `resp` together with its already-collected `bytes` (a Uint8Array) to the plain
// wire object. A null-body response — any status, not just 204/205/304 — must reconstruct
// with `.body === null`.
export function serializeResponseWire(resp, bytes) {
  const s = responseOf(resp);
  const raw = s.raw;
  return {
    ...responseHead(s),
    body_b64:   bytes.toBase64(),
    body:       '',
    body_null:  s.bodyNull,
    // An opaque response's script-hidden bytes (see response_hash) ride through so a controlled
    // client's <img> can still render it (tainted); no public body accessor reads this.
    render_b64: raw !== null && raw.opaque_render ? raw.opaque_render.toBase64() : undefined,
    // An opaque-REDIRECT's script-hidden real redirect (see opaque_redirect_hash): the Location /
    // status / content-type a navigation consuming the respondWith must process. Same private-field
    // standing as the render bytes; one name in both directions, so the cache hop needs no alias.
    redirect_loc:    (raw !== null && raw.redirect_loc)    || undefined,
    redirect_status: (raw !== null && raw.redirect_status) || undefined,
    redirect_ct:     (raw !== null && raw.redirect_ct)     || undefined
  };
}

// The response HEAD only — the `start` frame of a streaming respondWith round-trip
// (workers.js), where the body is delivered incrementally as separate `chunk` frames rather
// than materialized up front. The client reconstructs a Response whose body is a
// ReadableStream fed by those chunks (sw-client.js).
export function serializeResponseMeta(resp) {
  return responseHead(responseOf(resp));
}

// The parsed wire object as the in-memory raw form (in place): the base64 text fields become
// the bytes a rack response carries — `body_bytes`, and the private `opaque_render`.
export function rawFromWire(wire) {
  if (wire.body_b64 != null)   wire.body_bytes    = globalThis.Uint8Array.fromBase64(wire.body_b64);
  if (wire.render_b64 != null) wire.opaque_render = globalThis.Uint8Array.fromBase64(wire.render_b64);
  delete wire.body_b64;
  delete wire.render_b64;
  if (wire.body === undefined) wire.body = '';
  return wire;
}

// Reconstruct a Response from the parsed wire object (the internal `(raw, url)` ctor form).
export function responseFromWire(wire) {
  const raw = rawFromWire(wire);
  return responseFromRaw(raw, raw.url);
}
