// Byte-buffer ⇄ latin-1 string helpers. Single entry points so
// FormData multipart, createImageBitmap, XHR responseType, Worker
// postMessage, and File reads all converge on the same shape.
//
// Latin-1 (one char per byte, 0–255) is the lingua franca because
// mini_racer / quickjs.rb hand binary payloads to Ruby as UTF-8
// strings — a latin-1 stringification round-trips raw bytes intact
// where a naive UTF-8 build would corrupt anything outside the
// ASCII range.

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

// Inverse: `latin-1 string → ArrayBuffer`.
export function bytesToArrayBuffer(bytes) {
  const ab = new ArrayBuffer(bytes.length);
  const v  = new Uint8Array(ab);
  for (let i = 0; i < bytes.length; i++) v[i] = bytes.charCodeAt(i) & 0xff;
  return ab;
}
