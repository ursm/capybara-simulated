// Shared body serialiser for `fetch` and `XMLHttpRequest`. Both call
// sites used to roll their own; fetch's hand-rolled FormData path
// silently posted `"[object Object]"` when an entry was a File,
// because `String(blob)` is its default toString. xhr handled it.
// Centralising removes the divergence and matches WHATWG fetch's
// `Content-Type` defaults (urlencoded → `charset=UTF-8`).
//
// Returns `{body, b64}` where `b64 === true` means `body` is already
// base64-encoded — the caller must set `X-Csim-Body-B64: 1` so Rack
// decodes before building env input. Mutates `headers` to add
// `Content-Type` when not already set (case-insensitive).

import { blobBytes, serializeMultipart } from './blob.js';

function setContentTypeIfMissing(headers, value) {
  if (!('Content-Type' in headers) && !('content-type' in headers)) {
    headers['Content-Type'] = value;
  }
}

function serializeFormData(fd, headers) {
  // FormData carrying a File/Blob entry needs proper
  // multipart/form-data — `String(file)` becomes "[object Object]"
  // otherwise and Paperclip (or any multipart-aware uploader)
  // rejects the request. The urlencoded path is still the no-file
  // fast lane (Rails-UJS data-remote forms, JSON-API posts).
  let hasFile = false;
  fd.forEach((v) => { if (v instanceof globalThis.Blob) hasFile = true; });
  if (hasFile) {
    const ser = serializeMultipart(fd);
    setContentTypeIfMissing(headers, 'multipart/form-data; boundary=' + ser.boundary);
    return { body: globalThis.btoa(ser.body), b64: true };
  }
  setContentTypeIfMissing(headers, 'application/x-www-form-urlencoded;charset=UTF-8');
  const parts = [];
  fd.forEach((v, k) => parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(v))));
  return { body: parts.join('&'), b64: false };
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
  if (typeof body === 'string')                    return { body, b64: false };
  if (body instanceof globalThis.FormData)         return serializeFormData(body, headers);
  if (body instanceof globalThis.URLSearchParams) {
    setContentTypeIfMissing(headers, 'application/x-www-form-urlencoded;charset=UTF-8');
    return { body: body.toString(), b64: false };
  }
  if (body instanceof globalThis.Blob)             return serializeBlob(body, headers);
  return { body: String(body), b64: false };
}
