// Shared body serialiser for `fetch` and `XMLHttpRequest`. Both call
// sites used to roll their own; fetch's hand-rolled FormData path
// silently posted `"[object Object]"` when an entry was a File,
// because `String(blob)` is its default toString. xhr handled it.
// Centralising removes the divergence and matches WHATWG fetch's
// `Content-Type` defaults (urlencoded → `charset=UTF-8`).
//
// Returns `{body, charsetFixable}`. `body` is a string for a text body — it crosses to
// the host as a UTF-8 String, which IS its UTF-8 encoding — or a Uint8Array of the raw
// bytes for everything else, which crosses as a BINARY String; the type is the whole
// signal, so there is no side flag to keep in step. `charsetFixable === true` marks a
// UTF-8-encoded text body (string / Document / URLSearchParams) whose author
// Content-Type charset XHR forces to UTF-8 (`utf8ContentType`) — so the caller
// need not re-derive the body type. Mutates `headers` to add `Content-Type` when not
// already set (case-insensitive).

import { blobBytes, blobType, isBlob, serializeMultipart } from './blob.js';
import { latin1ToBytes }                 from './bytes.js';
import { formDataEntries }               from './form-data.js';
import { xmlSerialize }                  from './dom-nodes.js';
import { serializedHtml }                from './native-query-shadow.js';
import { isHtmlDocument }                from './mime.js';
import { interfaceCheck, isBufferOf }     from './webidl.js';

// XHR send()'s "fix the charset to UTF-8": for a UTF-8-encoded text body (string / Document / URLSearchParams), an
// author-set Content-Type `value` with a non-UTF-8 `charset` parameter has that charset forced to UTF-8 — and the type
// is re-serialized (canonicalised): the new value, or null where it stays as it is (an invalid MIME, no charset, a
// UTF-8 one). XHR's alone (fetch keeps the author's Content-Type as-is); a Blob or a FormData body never gets it.
export const utf8ContentType = (value) => globalThis.__dom.mimeCharsetUtf8(String(value));

function serializeFormData(fd) {
  // A FormData body is ALWAYS multipart/form-data — Fetch's "extract a body" has
  // no urlencoded shortcut, and real browsers send multipart even for an
  // entry-less form (the WPT default-Content-Type assertion). `serializeMultipart`
  // handles File/Blob entries (proper part Content-Type + raw bytes) and plain
  // string fields alike; without it a File becomes "[object Object]" and any
  // multipart-aware uploader (Paperclip / ActiveStorage) rejects the request.
  const ser = serializeMultipart(formDataEntries(fd));
  return { body: latin1ToBytes(ser.body), type: 'multipart/form-data; boundary=' + ser.boundary };
}

function serializeBlob(blob) {
  // ActiveStorage's `BlobUpload` PUTs the raw file to disk storage
  // via `xhr.send(file)` — its bytes, never a UTF-8 reinterpretation.
  return { body: latin1ToBytes(blobBytes(blob)), type: blobType(blob) || null };
}

// Body-type checks that work CROSS-REALM: a fetch / XHR body created in ANOTHER realm (e.g.
// `frame.contentWindow.fetch(url, {body: blobFromThisWindow})`) fails `instanceof globalThis.X`
// because each realm has its own classes. A Blob, a FormData and a URLSearchParams are told by
// their brands, an ArrayBuffer by its internal slot (`isBufferOf`: an object merely claiming the
// class string is none, nor is a SharedArrayBuffer); a ReadableStream by its class string.
export const isReadableStreamBody = body => Object.prototype.toString.call(body) === '[object ReadableStream]';
export const isFormDataBody = interfaceCheck('FormData');
export const isURLSearchParamsBody = interfaceCheck('URLSearchParams');
export const isArrayBufferBody = (body) => isBufferOf(body, 'ArrayBuffer');
export function isBlobBody(body) {
  return isBlob(body);
}

// Fetch "extract a body": `{body, type, charsetFixable}` — the body serialized, the Content-Type it implies (null for
// none), which a caller sets where its headers give none, and whether it is UTF-8-encoded text XHR's charset fix-up
// applies to. (`xhr`: XMLHttpRequest's body, whose union has a Document — fetch's BodyInit has none, and stringifies
// one.)
export function serializeRequestBody(body, xhr = false) {
  if (body == null)                                return { body: '', type: null };
  if (typeof body === 'string')                    return { body, type: 'text/plain;charset=UTF-8', charsetFixable: true };
  if (xhr && body && body._nodeType === 9) {
    // A Document body (XHR send(document)) is serialized + UTF-8 encoded. The choice
    // of serializer + default Content-Type follows the document's TYPE, not its
    // contentType MIME: an HTML document (incl. one a frame built from text/plain or
    // an image) serializes with the HTML serializer (`<img>`, no xmlns) as
    // text/html; an XML document uses XMLSerializer as application/xml.
    const html = isHtmlDocument(body);
    // (…an HTML document as HTML — its children's fragment serialization, a cross-realm one's in its own arena —
    // else as XML)
    const out = html ? serializedHtml(body, false) : xmlSerialize(body, false, false);
    return { body: out, type: html ? 'text/html;charset=UTF-8' : 'application/xml;charset=UTF-8', charsetFixable: true };
  }
  if (isFormDataBody(body))                        return serializeFormData(body);
  if (isURLSearchParamsBody(body)) {
    return { body: body.toString(), type: 'application/x-www-form-urlencoded;charset=UTF-8', charsetFixable: true };
  }
  if (isBlobBody(body))                            return serializeBlob(body);
  const isArrayBuffer = isArrayBufferBody(body);
  if (isArrayBuffer || ArrayBuffer.isView(body)) {
    // A BufferSource body (ArrayBuffer / typed-array / DataView) is sent as its raw
    // bytes with NO default Content-Type (send-data-arraybuffer / -arraybufferview).
    // COPIED, as "extract a body" does: the send is a later task, and a script that
    // reuses its buffer meanwhile must not change what was sent. A view sends only
    // its own byteOffset/byteLength window, not the whole backing buffer.
    const u8 = isArrayBuffer
      ? new Uint8Array(body)
      : new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    return { body: u8.slice(), type: null };
  }
  // A ReadableStream is a valid BodyInit with NO default Content-Type (Fetch "extract a
  // body"). The async drain happens in the caller (collectBodyStream); this fallback only
  // guards a stream that reaches here from not gaining a bogus text/plain default.
  if (isReadableStreamBody(body)) {
    return { body: String(body), type: null };
  }
  // Any other value is coerced to a USVString (ToString) and, like a string body,
  // defaults to text/plain;charset=UTF-8 (Fetch "extract a body" — the union's
  // fallback member is USVString), e.g. `{toString: () => 'hi'}` (request-init-002).
  return { body: String(body), type: 'text/plain;charset=UTF-8', charsetFixable: true };
}

// A serialized request body (see serializeRequestBody) as base64, for the service-worker
// request wire, which travels as JSON text: a string body contributes its UTF-8 bytes.
export function requestBodyBase64(body) {
  if (body == null) return '';
  return (typeof body === 'string' ? new globalThis.TextEncoder().encode(body) : body).toBase64();
}
