// `window.fetch(url, opts)` over the synchronous Rack call.
// `blob:` URLs resolve out of the in-process blob registry without
// going through the Rack stack.

import { bytesToArrayBuffer, bytesToLatin1, latin1ToBytes, utf8DecodeBytes, utf8EncodeBytes } from './bytes.js';
import { resolveBlobBytes }     from './blob.js';
import { serializeRequestBody, findHeaderKey } from './request-body.js';

// The header guard a request's Headers carries for a given fetch mode (so forbidden /
// non-no-cors-safelisted headers are dropped). Shared by Request and fetch().
function guardForMode(mode) { return mode === 'no-cors' ? 'request-no-cors' : 'request'; }

// Fetch "normalize a method": byte-uppercase only a case-insensitive match for one of
// these; every other method (notably `patch`, `chicken`) keeps its original case. So
// `delete` → `DELETE` but `patch` stays `patch` — which matters for the case-sensitive
// CORS Allow-Methods check (cors-preflight-star).
const METHOD_NORMALIZE = new Set(['DELETE', 'GET', 'HEAD', 'OPTIONS', 'POST', 'PUT']);
function normalizeMethod(method) {
  const m = String(method);
  const upper = m.toUpperCase();
  return METHOD_NORMALIZE.has(upper) ? upper : m;
}

// "Extract a body" → a canonical latin-1 BYTE string. Mutates `headersObj` (a plain
// object) to add the body's implied Content-Type (text/plain for a string, the blob's
// type, multipart boundary, urlencoded, …). Reuses serializeRequestBody, which returns
// the body as base64 (binary) or a USVString (text). A ReadableStream body isn't
// sync-extractable — left to String() (stream-body consumption is a separate item).
function extractBodyBytes(body, headersObj) {
  if (body == null) return '';
  const { body: out, b64 } = serializeRequestBody(body, headersObj);
  return b64 ? globalThis.atob(out) : utf8EncodeBytes(out);
}

// Body `formData()`: parse the bytes per Content-Type into a FormData. urlencoded →
// URLSearchParams pairs; multipart/form-data → each part's Content-Disposition name +
// value (a `filename` part becomes a File). Any other type rejects (TypeError).
// UTF-8 decode that KEEPS a leading BOM — form-data field values and urlencoded
// keys/values are not BOM-stripped (a whole-body text() is; url/urlencoded-parser).
function utf8DecodeKeepBom(byteStr) {
  try { return new globalThis.TextDecoder('utf-8', { ignoreBOM: true }).decode(latin1ToBytes(byteStr)); } catch (_) { return byteStr; }
}
function parseBodyToFormData(byteStr, contentType) {
  const raw = String(contentType || '');
  const fd  = new globalThis.FormData();
  if (raw.toLowerCase().indexOf('application/x-www-form-urlencoded') === 0) {
    for (const [k, v] of new globalThis.URLSearchParams(utf8DecodeKeepBom(byteStr))) fd.append(k, v);
    return Promise.resolve(fd);
  }
  // Match the type case-insensitively but capture the boundary in its ORIGINAL case —
  // a multipart boundary is case-SENSITIVE, so lowercasing it breaks the body split.
  const m = raw.match(/multipart\/form-data;.*\bboundary=("?)([^";]+)\1/i);
  if (!m) return Promise.reject(new TypeError('Body cannot be decoded as form data, mime type is not multipart/form-data or application/x-www-form-urlencoded'));
  // A body that doesn't even contain the boundary (empty / malformed) is a parse
  // error, not an empty FormData (request-consume-empty's multipart error case).
  if (byteStr.indexOf('--' + m[2]) === -1) return Promise.reject(new TypeError('Failed to parse multipart body.'));
  for (let part of byteStr.split('--' + m[2])) {
    part = part.replace(/^\r\n/, '');
    if (part === '' || part === '--' || part.slice(0, 2) === '--') continue;   // preamble / closing
    const sep = part.indexOf('\r\n\r\n');
    if (sep === -1) continue;
    const head = part.slice(0, sep), value = part.slice(sep + 4).replace(/\r\n$/, '');
    const cd = head.match(/content-disposition:[^\r\n]*/i);
    const name = cd && cd[0].match(/\bname="([^"]*)"/i);
    if (!name) continue;
    const file = cd[0].match(/\bfilename="([^"]*)"/i);
    if (file) {
      const fct = head.match(/content-type:\s*([^\r\n]+)/i);
      fd.append(name[1], new globalThis.File([latin1ToBytes(value)], file[1], { type: fct ? fct[1].trim() : '' }));
    } else {
      // A multipart field value keeps a leading BOM (unlike a whole-body text()
      // decode) — response-consume "…with BOM".
      fd.append(name[1], utf8DecodeKeepBom(value));
    }
  }
  return Promise.resolve(fd);
}

// Shared Body interface for Request / Response: every accessor derives from the
// canonical latin-1 bytes `_bodyBytesRaw()` (+ `_bodyContentType()` for blob/formData),
// and consumes the one-shot body (a second read rejects — bodyUsed).
const BodyMixin = {
  _bodyConsume() {
    // A NULL body (no body set) is not a stream — consuming it neither disturbs it
    // nor sets bodyUsed, and it can be read repeatedly (request-consume-empty). A
    // non-null body is one-shot: a second read rejects.
    if (this._bodyNull) return null;
    if (this.bodyUsed) return Promise.reject(new TypeError('Body has already been consumed.'));
    this.bodyUsed = true;
    return null;
  },
  text()        { return this._bodyConsume() || Promise.resolve(utf8DecodeBytes(this._bodyBytesRaw())); },
  json()        { const g = this._bodyConsume(); if (g) return g;
                  // JSON.parse of an empty body throws (rejects) — no `|| 'null'` fallback.
                  try { return Promise.resolve(JSON.parse(utf8DecodeBytes(this._bodyBytesRaw()))); } catch (e) { return Promise.reject(e); } },
  arrayBuffer() { return this._bodyConsume() || Promise.resolve(bytesToArrayBuffer(this._bodyBytesRaw())); },
  bytes()       { return this._bodyConsume() || Promise.resolve(latin1ToBytes(this._bodyBytesRaw())); },
  blob()        { return this._bodyConsume() || Promise.resolve(new globalThis.Blob([latin1ToBytes(this._bodyBytesRaw())], { type: this._bodyContentType() })); },
  formData()    { const g = this._bodyConsume(); if (g) return g; return parseBodyToFormData(this._bodyBytesRaw(), this._bodyContentType()); }
};

// `Request(input, init)` — spec value type. Many fetch-wrapper
// libraries (jose, ofetch, ky, MSW handlers) construct a Request
// before delegating to fetch. We hold the same fields the spec
// exposes; `clone()` returns a structural copy.
class Request {
  constructor(input, init) {
    init = init || {};
    // The header guard follows the request mode and is set BEFORE any header is added,
    // so a no-cors request drops non-safelisted headers and any request drops
    // forbidden ones at construction (headers-forbidden-override / -no-cors).
    this.mode = init.mode || (input instanceof Request ? input.mode : null) || 'cors';
    const guard = guardForMode(this.mode);
    if (input instanceof Request) {
      this.url    = input.url;
      this.method = input.method;
      this._body  = input._body;
      // init.headers, when present, REPLACES the source request's header list (Fetch
      // "Request" init) — only inherit input's headers when init gives none.
      this._headers = new globalThis.Headers(init.headers == null ? input.headers : undefined, guard);
      // Carry the blob snapshot through clone() so a cloned Request still fetches
      // after the original URL was revoked.
      this._blobSnapshot = input._blobSnapshot;
    } else {
      this.url    = String(input);
      this.method = 'GET';
      this._body  = null;
      this._headers = new globalThis.Headers(undefined, guard);
      // Take a reference to a blob: URL's bytes at construction (the Request
      // "receives" the URL here), so a later URL.revokeObjectURL still resolves.
      this._blobSnapshot = this.url.startsWith('blob:') ? resolveBlobBytes(this.url) : null;
    }
    if (init.method)  this.method  = normalizeMethod(init.method);
    if (init.body != null) this._body = init.body;
    if (init.headers) {
      if (init.headers instanceof globalThis.Headers) {
        init.headers.forEach((v, k) => this._headers.append(k, v));
      } else if (Array.isArray(init.headers)) {
        for (const pair of init.headers) this._headers.append(pair[0], pair[1]);
      } else if (typeof init.headers === 'object') {
        for (const [k, v] of Object.entries(init.headers)) this._headers.append(k, v);
      }
    }
    // A Request built from another Request inherits its settings when init omits them
    // (Fetch "new Request" — same as `mode`/`referrerPolicy` above), so a cloned Request
    // keeps its credentials mode, cache/redirect policy, and referrer.
    const from = input instanceof Request ? input : null;
    this.credentials = init.credentials || (from && from.credentials) || 'same-origin';
    this.cache       = init.cache       || (from && from.cache)       || 'default';
    this.redirect    = init.redirect    || (from && from.redirect)    || 'follow';
    this.referrer       = init.referrer       || (from && from.referrer)       || 'about:client';
    this.referrerPolicy = init.referrerPolicy || (from && from.referrerPolicy) || '';
    this.integrity   = init.integrity   || '';
    this.signal      = init.signal      || null;
    this.bodyUsed    = false;
    // Canonical body bytes (for the Body accessors), plus the body's implied
    // Content-Type set on the headers when the author gave none.
    if (input instanceof Request && init.body == null) {
      // clone / re-wrap: carry the SAME captured bytes (a re-serialized FormData would
      // mint a new multipart boundary that no longer matches the copied Content-Type).
      this._bodyBytes = input._bodyBytes;
      this._bodyNull  = input._bodyNull;
    } else {
      this._bodyNull = (this._body == null);
      const h = {};
      this._bodyBytes = extractBodyBytes(this._body, h);
      const ctk = findHeaderKey(h, 'content-type');
      if (ctk && !this._headers.has('content-type')) this._headers.set('content-type', h[ctk]);
    }
  }
  get headers() { return this._headers; }
  get body()    { return this._body; }
  _bodyBytesRaw()    { return this._bodyBytes || ''; }
  _bodyContentType() { return this._headers.get('content-type') || ''; }
  clone()            { return new Request(this); }
}
Object.assign(Request.prototype, BodyMixin);

// `body` carries the UTF-8 text form (legacy; fine for
// text/json/css/js). `body_b64` carries the raw bytes
// base64-encoded — Ruby always sends both. `arrayBuffer()` /
// `blob()` decode b64 to a latin-1 byte string so binary
// payloads (Tesseract.js's gzipped traineddata, image bytes)
// survive intact. Synthetic responses (blob:-URL handlers) pass
// only `body` — we fall back to `String(body)` there.
class FetchResponse {
  constructor(raw, url) {
    this._raw       = raw;
    this._url       = url;
    this._consumed  = false;
    this._bodyText  = (raw && raw.body) || '';
    // Response headers are network-final (already combined by the HTTP stack) — fill
    // them verbatim, NOT through append's script-side normalization (header-value-combining).
    this.headers    = new globalThis.Headers()._fillRaw(raw && raw.headers);
    // An opaque (no-cors cross-origin) response has an empty URL list — don't fall back
    // to the request URL. Otherwise use the response URL, else the request URL.
    this.url        = (raw && raw.type === 'opaque') ? '' : ((raw && raw.url) || url);
    this.status     = raw ? raw.status : 0;
    this.statusText = '';
    this.ok         = this.status >= 200 && this.status < 300;
    this.redirected = !!(raw && raw.redirected);
    this.type       = raw && raw.type || 'basic';
    this.bodyUsed   = false;
    this._bodyNull  = false;   // a fetched response has a body (empty is still non-null)
  }
  // Canonical response body bytes (latin-1). The no-b64 path's `body` is ALREADY raw
  // bytes — either an ASCII network body (text === bytes) or a synthetic blob:/data:
  // handler's byte string — so return it verbatim (a non-ASCII network body always
  // arrives via body_b64). Coerce a Uint8Array body (the data: handler passes one).
  _bodyBytesRaw() {
    if (this._raw && typeof this._raw.body_b64 === 'string') {
      try { return globalThis.atob(this._raw.body_b64); } catch (_) { return ''; }
    }
    const b = this._bodyText;
    return (b && b.buffer && typeof b !== 'string') ? bytesToLatin1(b) : String(b || '');
  }
  _bodyContentType() { return (this.headers.get && this.headers.get('content-type')) || ''; }
  // Preserve the concrete class so a fetch()-result Response clones to a Response
  // (WASM loaders check `instanceof Response`), not a bare FetchResponse.
  clone()            { return new this.constructor(this._raw, this._url); }
}
Object.assign(FetchResponse.prototype, BodyMixin);   // text/json/blob/arrayBuffer/bytes/formData

// Unified `Response` class — covers both the Fetch spec's public
// `new Response(body, init)` form and the internal `(raw, url)` form
// our fetch wrapper produces. Apps' WASM loaders check
// `module instanceof Response` (see Discourse @discourse/resize's
// `__wbg_load`), so the value `fetch()` resolves with HAS to be a
// Response instance, not a separate FetchResponse subclass.
class Response extends FetchResponse {
  constructor(bodyOrRaw, initOrUrl) {
    const isInternal = bodyOrRaw && typeof bodyOrRaw === 'object' &&
                       ('status' in bodyOrRaw) && ('body' in bodyOrRaw);
    if (isInternal) {
      super(bodyOrRaw, initOrUrl);
      return;
    }
    const init = initOrUrl || {};
    const status = init.status != null ? Number(init.status) : 200;
    const statusText = init.statusText != null ? String(init.statusText) : '';
    let headers = {};
    if (init.headers) {
      if (init.headers instanceof globalThis.Headers) {
        init.headers.forEach((v, k) => { headers[k] = v; });
      } else if (Array.isArray(init.headers)) {
        for (const [k, v] of init.headers) headers[k] = v;
      } else if (typeof init.headers === 'object') {
        Object.assign(headers, init.headers);
      }
    }
    // "Extract a body" rather than String(body): a Blob / ArrayBuffer / typed-array /
    // FormData / URLSearchParams body becomes its real bytes (+ the body's implied
    // Content-Type, when the init set none), so the Body accessors work on it.
    const bytes = extractBodyBytes(bodyOrRaw, headers);
    super({status, body: utf8DecodeBytes(bytes), body_b64: globalThis.btoa(bytes), headers, url: ''}, '');
    this.statusText = statusText;
    this.type       = 'default';
    this._bodyNull  = (bodyOrRaw == null);   // new Response() / new Response(null) → null body
  }
  static json(data, init) {
    init = init || {};
    // Build through Headers (handles a Headers / array / record init — Object.assign of
    // a Headers would copy its internal fields, not its entries); default content-type
    // only when the author set none.
    const headers = new globalThis.Headers(init.headers);
    if (!headers.has('content-type')) headers.set('content-type', 'application/json');
    return new Response(JSON.stringify(data), Object.assign({}, init, {headers}));
  }
  static error()             { const r = new Response('', {status: 0}); r.type = 'error'; return r; }
  static redirect(url, status) {
    const r = new Response('', {status: status || 302, headers: {location: String(url)}});
    return r;
  }
}

globalThis.fetch = function fetch(input, init) {
  init = init || {};
  let url, method = 'GET', body = null;
  if (typeof input === 'string') {
    url = input;
  } else if (input && input.url) {
    url = input.url;
    if (input.method)       method = input.method;
    if (input.body != null) body   = input.body;
  } else {
    url = String(input);
  }
  if (init.method)       method = init.method;
  if (init.body != null) body   = init.body;
  // Build the request's header list through a GUARDED Headers: it validates names/
  // values (an invalid one → reject, since fetch() never throws synchronously),
  // normalizes, and drops forbidden / non-no-cors-safelisted headers BEFORE the wire
  // (request-forbidden-headers / headers-no-cors). init.headers, when present,
  // replaces the input request's headers (Fetch "Request" init). Then flatten to the
  // plain map __rackFetch wants.
  const mode  = init.mode || (input instanceof Request ? input.mode : null) || 'cors';
  const guard = guardForMode(mode);
  // credentials mode (passed to Ruby verbatim) decides cookie attachment + the
  // credentialed CORS check: `include` sends cookies everywhere and forces the strict
  // check (ACAO must echo the origin, not `*`, plus ACAC:true); `same-origin` (default)
  // sends cookies only same-origin; `omit` never does.
  const credentials = init.credentials || (input instanceof Request ? input.credentials : null) || 'same-origin';
  const referrerPolicy = init.referrerPolicy || (input instanceof Request ? input.referrerPolicy : '') || '';
  const src   = init.headers != null ? init.headers
              : (input && typeof input === 'object' && input.headers) || undefined;
  const headers = {};
  try {
    new globalThis.Headers(src, guard).forEach((v, k) => { headers[k] = v; });
  } catch (e) { return Promise.reject(e); }
  let bodyStr, b64;
  if (input instanceof Request && init.body == null) {
    // Reuse the Request's already-captured body bytes — re-serializing a FormData here
    // would mint a NEW multipart boundary that mismatches the Content-Type the Request
    // set (which is already in `headers` via input.headers). Also avoids double work.
    bodyStr = globalThis.btoa(input._bodyBytes || '');
    b64 = true;
  } else {
    ({ body: bodyStr, b64 } = serializeRequestBody(body, headers));
  }
  if (b64) headers['X-Csim-Body-B64'] = '1';
  if (typeof url === 'string' && url.startsWith('blob:')) {
    // A blob: URL only answers GET; any other method is a network error.
    const blobMethod = String(method || 'GET').toUpperCase();
    // Snapshot the bytes SYNCHRONOUSLY (before the deferred resolve), so a
    // `URL.revokeObjectURL(url)` issued right after this fetch() call still sees
    // the resource — fetch took its reference when it was called. A Request input
    // carries its own construction-time snapshot (revoke may predate the fetch).
    const snapshot = blobMethod !== 'GET'
      ? null
      : ((input instanceof Request && input._blobSnapshot) ? input._blobSnapshot : resolveBlobBytes(url));
    return new Promise(function (resolve, reject) {
      // Defer through the virtual clock to match the spec's fetch
      // task boundary — fetch resolves on a separate task, so awaiting
      // it yields control. Inline resolve would race ahead of any
      // intervening microtasks (Turbo Drive's render chain).
      globalThis.setTimeout(function () {
        if (!snapshot) return reject(new TypeError('blob URL fetch failed: ' + url));
        resolve(new Response({
          status:  200,
          body:    snapshot.bytes,
          headers: { 'content-type': snapshot.type },
          url
        }, url));
      }, 0);
    });
  }
  if (typeof url === 'string' && url.startsWith('data:')) {
    // Per RFC 2397, `data:[<mediatype>][;base64],<data>`. Discourse's
    // PM image extension fetches the pasted `data:image/png;base64,…`
    // URI to wrap the bytes in a `File` for the upload pipeline; without
    // local decoding we'd round-trip through Rack and fail.
    return new Promise(function (resolve, reject) {
      globalThis.setTimeout(function () {
        try {
          const comma = url.indexOf(',');
          if (comma < 0) return reject(new TypeError('malformed data URL'));
          const meta = url.slice(5, comma);
          const payload = url.slice(comma + 1);
          const isBase64 = /;base64$/i.test(meta);
          const mediaType = meta.replace(/;base64$/i, '') || 'text/plain;charset=US-ASCII';
          let bytes;
          if (isBase64) {
            const bin = globalThis.atob(payload);
            bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          } else {
            bytes = new TextEncoder().encode(decodeURIComponent(payload));
          }
          resolve(new Response({
            status:  200,
            body:    bytes,
            headers: { 'content-type': mediaType },
            url
          }, url));
        } catch (e) { reject(e); }
      }, 0);
    });
  }
  return new Promise(function (resolve, reject) {
    globalThis.setTimeout(function () {
      try {
        const resp = globalThis.__rackFetch(normalizeMethod(method), url, bodyStr, headers, 'follow', mode, credentials, referrerPolicy);
        if (!resp) { reject(new TypeError('Network request failed: ' + url)); return; }
        resolve(new Response(resp, url));
      } catch (e) { reject(e); }
    }, 0);
  });
};

globalThis.Request  = Request;
globalThis.Response = Response;
