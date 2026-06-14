// Byte-buffer ⇄ latin-1 string helpers. Single entry points so
// FormData multipart, createImageBitmap, XHR responseType, Worker
// postMessage, and File reads all converge on the same shape.
//
// Latin-1 (one char per byte, 0–255) is the lingua franca because
// quickjs.rb hands binary payloads to Ruby as UTF-8 strings — a
// latin-1 stringification round-trips raw bytes intact where a naive
// UTF-8 build would corrupt anything outside the ASCII range. (V8
// marshals tag-driven — Uint8Array ↔ BINARY string — and the
// transfer-buffer registry rides that; these helpers remain for the
// QuickJS path and the call sites not yet migrated to raw bytes.)

// `Uint8Array → latin-1 string`. Chunked `apply` is ~2 orders of
// magnitude faster than a per-byte concat for the 16 KB image
// payloads Tesseract posts; the 0x8000 chunk keeps us under both
// engines' apply-arg-count ceiling.
export function bytesToLatin1(view) {
  let s = '';
  for (let i = 0; i < view.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, view.subarray(i, i + 0x8000));
  }
  return s;
}

// Inverse: `latin-1 string → Uint8Array`.
export function latin1ToBytes(bytes) {
  const v = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) v[i] = bytes.charCodeAt(i) & 0xff;
  return v;
}

// `latin-1 string → ArrayBuffer`. Thin wrapper for callers that want
// the raw buffer rather than the typed-array view.
export function bytesToArrayBuffer(bytes) {
  return latin1ToBytes(bytes).buffer;
}

// Normalise whatever a host fn returned (V8's tag-driven marshalling
// delivers a real Uint8Array; the QuickJS fallback path returns a base64
// string because QuickJS reinterprets bytes ≥ 0x80 as UTF-8 and corrupts
// them) into a Uint8Array.
export function fetchedToBytes(fetched) {
  if (fetched instanceof Uint8Array)  return fetched;
  if (fetched instanceof ArrayBuffer) return new Uint8Array(fetched);
  if (typeof fetched === 'string')    return latin1ToBytes(globalThis.atob(fetched));
  return null;
}

// One-shot fetch from the Ruby-side transfer-buffer registry. Returns
// the buffer as a Uint8Array, or null if the host fn isn't wired or
// the id is empty.
export function fetchTransfer(refId) {
  if (!refId || typeof globalThis.__csim_transferFetch !== 'function') return null;
  return fetchedToBytes(globalThis.__csim_transferFetch(refId | 0));
}

// Stash a Uint8Array into the Ruby-side registry, returning the id (or
// 0 if unavailable / the host fn refused the buffer).
export function stashTransfer(view) {
  if (typeof globalThis.__csim_transferStash !== 'function') return 0;
  return globalThis.__csim_transferStash(view) | 0;
}

// The observable half of postMessage `transfer` semantics: after the message
// data has been COPIED across the isolate boundary, DETACH each ArrayBuffer
// named in the transfer list on the SENDER (byteLength → 0, `.detached` true).
// A real browser neuters a transferred buffer and apps assert on that. The
// bytes themselves are still copied — true zero-copy needs a shared backing
// store across isolates, which neither engine binding here exposes — so this
// only neuters the source. V8 has `ArrayBuffer.prototype.transfer` (ES2024);
// QuickJS has no JS-level detach, so it's a best-effort no-op there.
//
// Call AFTER the copy is made, and ONLY for cross-isolate transports: a
// same-realm MessagePort passes `data` by reference (no clone), so detaching
// its source would corrupt the message the peer is about to receive.
export function detachTransferables(transferList) {
  if (!Array.isArray(transferList)) return;
  for (const t of transferList) {
    if (t instanceof ArrayBuffer && typeof t.transfer === 'function') {
      try { t.transfer(); } catch (_) { /* already detached / unsupported */ }
    }
  }
}
