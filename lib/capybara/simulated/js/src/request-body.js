// Shared body serialiser for `fetch` and `XMLHttpRequest`. Both call
// sites used to roll their own; fetch's hand-rolled FormData path
// silently posted `"[object Object]"` when an entry was a File,
// because `String(blob)` is its default toString. xhr handled it.
// Centralising removes the divergence and matches WHATWG fetch's
// `Content-Type` defaults (urlencoded → `charset=UTF-8`).
//
// Returns `{body, b64, charsetFixable}`. `b64 === true` means `body` is already
// base64-encoded — the caller must set `X-Csim-Body-B64: 1` so Rack decodes before
// building env input. `charsetFixable === true` marks a UTF-8-encoded text body
// (string / Document / URLSearchParams) whose author Content-Type charset XHR forces
// to UTF-8 (see fixContentTypeCharset) — so the caller need not re-derive the body
// type. Mutates `headers` to add `Content-Type` when not already set (case-insensitive).

import { blobBytes, serializeMultipart } from './blob.js';
import { bytesToLatin1 }                 from './bytes.js';

// The single notion of "find an existing header key by its lowercased name" —
// header maps preserve an author's arbitrary casing (XHR setRequestHeader keeps
// `Content-type`), so every membership/lookup is case-insensitive. Returns the
// actual stored key (to read/overwrite it) or null.
export function findHeaderKey(headers, name) {
  for (const k in headers) { if (k.toLowerCase() === name) return k; }
  return null;
}

function setContentTypeIfMissing(headers, value) {
  // Case-insensitive: an exact-key check would miss an author's `Content-type` and
  // add a SECOND, conflicting Content-Type when a body also supplies a default.
  if (findHeaderKey(headers, 'content-type') == null) headers['Content-Type'] = value;
}

// XHR send()'s "fix the charset to UTF-8": for a UTF-8-encoded text body (string /
// Document / URLSearchParams), an author-set Content-Type with a non-UTF-8 `charset`
// parameter has
// that charset forced to UTF-8 — and the type is re-serialized (canonicalised). An
// invalid MIME, an absent charset, or an already-UTF-8 charset is left verbatim. This
// is XHR-specific (fetch keeps the author's Content-Type as-is), so callers invoke it
// explicitly rather than folding it into serializeRequestBody. Blob/FormData bodies
// (opaque / their own charset) never get this treatment.
export function fixContentTypeCharset(headers) {
  const vendor = globalThis.__csimVendor && globalThis.__csimVendor.mimeType;
  if (!vendor) return;
  const key = findHeaderKey(headers, 'content-type');
  if (key == null) return;
  const mime = vendor.MIMEType.parse(headers[key]);
  if (!mime) return;
  const charset = mime.parameters.get('charset');
  if (charset === undefined || charset.toLowerCase() === 'utf-8') return;
  mime.parameters.set('charset', 'UTF-8');
  headers[key] = mime.toString();
}

function serializeFormData(fd, headers) {
  // A FormData body is ALWAYS multipart/form-data — Fetch's "extract a body" has
  // no urlencoded shortcut, and real browsers send multipart even for an
  // entry-less form (the WPT default-Content-Type assertion). `serializeMultipart`
  // handles File/Blob entries (proper part Content-Type + raw bytes) and plain
  // string fields alike; without it a File becomes "[object Object]" and any
  // multipart-aware uploader (Paperclip / ActiveStorage) rejects the request.
  const ser = serializeMultipart(fd);
  setContentTypeIfMissing(headers, 'multipart/form-data; boundary=' + ser.boundary);
  return { body: globalThis.btoa(ser.body), b64: true };
}

function serializeBlob(blob, headers) {
  // ActiveStorage's `BlobUpload` PUTs the raw file to disk storage
  // via `xhr.send(file)`. The bytes need to cross the engine
  // boundary without UTF-8 reinterpretation, so we base64 them.
  if (blob.type) setContentTypeIfMissing(headers, blob.type);
  const raw = blobBytes(blob);
  return { body: raw ? globalThis.btoa(raw) : '', b64: true };
}

export function serializeRequestBody(body, headers) {
  if (body == null)                                return { body: '', b64: false };
  if (typeof body === 'string') {
    // A string (USVString) body defaults to text/plain;charset=UTF-8 (Fetch
    // "extract a body" / XHR send()) unless the caller already set a type.
    setContentTypeIfMissing(headers, 'text/plain;charset=UTF-8');
    return { body, b64: false, charsetFixable: true };
  }
  if (body && body.nodeType === 9) {
    // A Document body (XHR send(document)) is serialized + UTF-8 encoded; its default
    // Content-Type is text/html or application/xml by the document's own type.
    const isHtml = (body.contentType || 'text/html') === 'text/html';
    setContentTypeIfMissing(headers, isHtml ? 'text/html;charset=UTF-8' : 'application/xml;charset=UTF-8');
    return { body: new globalThis.XMLSerializer().serializeToString(body), b64: false, charsetFixable: true };
  }
  if (body instanceof globalThis.FormData)         return serializeFormData(body, headers);
  if (body instanceof globalThis.URLSearchParams) {
    setContentTypeIfMissing(headers, 'application/x-www-form-urlencoded;charset=UTF-8');
    return { body: body.toString(), b64: false, charsetFixable: true };
  }
  if (body instanceof globalThis.Blob)             return serializeBlob(body, headers);
  const isArrayBuffer = Object.prototype.toString.call(body) === '[object ArrayBuffer]';
  if (isArrayBuffer || (globalThis.ArrayBuffer.isView && globalThis.ArrayBuffer.isView(body))) {
    // A BufferSource body (ArrayBuffer / typed-array / DataView) is sent as its raw
    // bytes with NO default Content-Type (send-data-arraybuffer / -arraybufferview).
    // Base64 so the bytes survive the engine's UTF-8 string boundary; a view sends
    // only its own byteOffset/byteLength window, not the whole backing buffer. Brand
    // -check the buffer (not `instanceof`) so a cross-realm ArrayBuffer is caught too.
    const u8 = isArrayBuffer
      ? new Uint8Array(body)
      : new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    return { body: globalThis.btoa(bytesToLatin1(u8)), b64: true };
  }
  return { body: String(body), b64: false };
}
