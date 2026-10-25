// Byte helpers. Bytes are bytes in the VM — a Uint8Array, or the engine's bytes object a Blob's and a body's are
// (blob_data.rs) — and across the host boundary too, the marshaller mapping a Uint8Array to a BINARY String and back.
// Base64 is left to the wires that travel as JSON text (the service-worker request / response and the worker message
// encodings).

// `Uint8Array → latin-1 string` (one char per byte, 0–255): FileReader's `readAsBinaryString`, which the File API
// defines so. Chunked `apply` is ~2 orders of magnitude faster than a per-byte concat; the 0x8000 chunk keeps us under
// the engine's apply-arg-count ceiling.
export function bytesToLatin1(view) {
  let s = '';
  for (let i = 0; i < view.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, view.subarray(i, i + 0x8000));
  }
  return s;
}

// The ArrayBuffer of exactly a Uint8Array's bytes: its own where they are all of it, else a copy of them.
export const exactBuffer = (bytes) => bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.slice().buffer;

// The length of `s` UTF-8 encoded, counted without allocating the encoded bytes (a lone
// surrogate U+FFFD's three bytes) — a WebSocket's `bufferedAmount`, a Resource Timing
// entry's size, an XHR's progress.
export function utf8Length(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xFC00) === 0xDC00) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

// One-shot fetch from the Ruby-side transfer-buffer registry. Returns
// the buffer as a Uint8Array (the BINARY String it was stashed as), or
// null if the host fn isn't wired, the id is empty or already taken.
export function fetchTransfer(refId) {
  if (!refId || typeof globalThis.__csim_transferFetch !== 'function') return null;
  return globalThis.__csim_transferFetch(refId | 0) || null;
}

// Stash a Uint8Array into the Ruby-side registry, returning the id (or
// 0 if unavailable / the host fn refused the buffer). The typed array crosses as one BINARY
// string — no latin-1 / base64 intermediate on either side.
export function stashTransfer(view) {
  if (typeof globalThis.__csim_transferStash !== 'function') return 0;
  // A caller with nothing to stash gets the "no buffer" answer rather than a valid id for zero
  // bytes.
  if (!view || typeof view.length !== 'number') return 0;
  return globalThis.__csim_transferStash(view) | 0;
}

// The `transfer` argument to a structured-clone postMessage is overloaded: either a bare
// `sequence<object>` (the array form, `postMessage(msg, [buf])`) or a `StructuredSerializeOptions`
// dictionary (`postMessage(msg, {transfer: [buf]})`). Normalize both to the transfer array (or []
// when absent) so every consumer — the transfer set, the wire encode, and the source-detach — sees
// the same list. A caller that already extracted the array (window.postMessage) passes it through.
export function transferListFrom(arg) {
  if (Array.isArray(arg)) return arg;
  if (arg && Array.isArray(arg.transfer)) return arg.transfer;
  return [];
}

