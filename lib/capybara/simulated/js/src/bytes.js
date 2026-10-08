// Byte-buffer ⇄ latin-1 string helpers. Single entry points so
// FormData multipart, createImageBitmap, XHR responseType, Worker
// postMessage, and File reads all converge on the same shape.
//
// Latin-1 (one char per byte, 0–255) is the lingua franca for bytes
// held as a JS string — a latin-1 stringification round-trips raw
// bytes intact where a naive UTF-8 build would corrupt anything
// outside the ASCII range. That is the IN-VM form (Blob parts, body
// bytes); across the host boundary bytes travel as bytes — the
// marshaller maps a Uint8Array to a BINARY String and back — so these
// helpers convert at that edge. Base64 is left to the wires that
// travel as JSON text (the service-worker request / response and the
// worker message encodings).

// `Uint8Array → latin-1 string`. Chunked `apply` is ~2 orders of
// magnitude faster than a per-byte concat for the 16 KB image
// payloads Tesseract posts; the 0x8000 chunk keeps us under the
// engine's apply-arg-count ceiling.
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

// "UTF-8 decode" a latin-1 BYTE string to a JS string — NO charset sniffing
// (decodeResponseBytes does that), a leading BOM removed unless `keepBOM`. Used by body
// `text()` / "parse JSON from bytes": a UTF-16 body's BOM bytes are invalid UTF-8 →
// U+FFFD, so JSON.parse then fails. Native, as TextDecoder's own decode is — not
// through a TextDecoder a page may have replaced.
export function utf8DecodeBytes(byteStr, keepBOM = false) {
  return globalThis.__dom.textDecode('UTF-8', latin1ToBytes(byteStr), keepBOM, false);
}

// "UTF-8 encode" a JS string to a latin-1 BYTE string (each char 0–255 = one byte) —
// the canonical body bytes for a USVString / URLSearchParams body.
export function utf8EncodeBytes(str) {
  return bytesToLatin1(globalThis.__dom.utf8Encode(str));
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

// The observable half of postMessage `transfer` semantics: after the message
// data has been COPIED across the isolate boundary, DETACH each ArrayBuffer
// named in the transfer list on the SENDER (byteLength → 0, `.detached` true).
// A real browser neuters a transferred buffer and apps assert on that. The
// bytes themselves are still copied — true zero-copy needs a shared backing
// store across isolates, which the engine binding here does not expose — so this
// only neuters the source, via `ArrayBuffer.prototype.transfer` (ES2024).
//
// Call AFTER the copy is made, and ONLY for cross-isolate transports: a
// same-realm MessagePort with a TRANSFER list passes `data` by reference (the
// no-transfer path structure-clones), so detaching its source would corrupt the
// message the peer is about to receive. Accepts both transfer overload forms.
export function detachTransferables(transferList) {
  for (const t of transferListFrom(transferList)) {
    // Brand tag, not `instanceof ArrayBuffer`: window.postMessage can carry a
    // transfer list of CROSS-REALM (iframe) buffers, for which a realm-relative
    // `instanceof` is false and the source would never be neutered.
    if (t && Object.prototype.toString.call(t) === '[object ArrayBuffer]' && typeof t.transfer === 'function') {
      try { t.transfer(); } catch (_) { /* already detached / unsupported */ }
    }
  }
}
