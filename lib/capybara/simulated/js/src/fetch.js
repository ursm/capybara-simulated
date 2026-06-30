// `window.fetch(url, opts)` over the synchronous Rack call.
// `blob:` URLs resolve out of the in-process blob registry without
// going through the Rack stack.

import { bytesToArrayBuffer }   from './bytes.js';
import { resolveBlobBytes }     from './blob.js';
import { serializeRequestBody } from './request-body.js';

// `Request(input, init)` — spec value type. Many fetch-wrapper
// libraries (jose, ofetch, ky, MSW handlers) construct a Request
// before delegating to fetch. We hold the same fields the spec
// exposes; `clone()` returns a structural copy.
class Request {
  constructor(input, init) {
    init = init || {};
    if (input instanceof Request) {
      this.url    = input.url;
      this.method = input.method;
      this._body  = input._body;
      this._headers = new globalThis.Headers(input.headers);
      // Carry the blob snapshot through clone() so a cloned Request still fetches
      // after the original URL was revoked.
      this._blobSnapshot = input._blobSnapshot;
    } else {
      this.url    = String(input);
      this.method = 'GET';
      this._body  = null;
      this._headers = new globalThis.Headers();
      // Take a reference to a blob: URL's bytes at construction (the Request
      // "receives" the URL here), so a later URL.revokeObjectURL still resolves.
      this._blobSnapshot = this.url.startsWith('blob:') ? resolveBlobBytes(this.url) : null;
    }
    if (init.method)  this.method  = String(init.method).toUpperCase();
    if (init.body != null) this._body = init.body;
    if (init.headers) {
      if (init.headers instanceof globalThis.Headers) {
        init.headers.forEach((v, k) => this._headers.append(k, v));
      } else if (typeof init.headers === 'object') {
        for (const [k, v] of Object.entries(init.headers)) this._headers.append(k, v);
      }
    }
    this.mode        = init.mode        || 'cors';
    this.credentials = init.credentials || 'same-origin';
    this.cache       = init.cache       || 'default';
    this.redirect    = init.redirect    || 'follow';
    this.referrer    = init.referrer    || 'about:client';
    this.integrity   = init.integrity   || '';
    this.signal      = init.signal      || null;
    this.bodyUsed    = false;
  }
  get headers() { return this._headers; }
  get body()    { return this._body; }
  _consume() {
    if (this.bodyUsed) return Promise.reject(new TypeError('Body already consumed'));
    this.bodyUsed = true;
    return null;
  }
  text() {
    return this._consume() || Promise.resolve(this._body == null ? '' : String(this._body));
  }
  json() {
    const g = this._consume();
    if (g) return g;
    try { return Promise.resolve(JSON.parse(this._body || 'null')); } catch (e) { return Promise.reject(e); }
  }
  blob() {
    return this._consume() || Promise.resolve(new globalThis.Blob([this._body == null ? '' : String(this._body)]));
  }
  arrayBuffer() {
    return this._consume() || Promise.resolve(bytesToArrayBuffer(this._body == null ? '' : String(this._body)));
  }
  formData() { return Promise.resolve(new globalThis.FormData()); }
  clone()    { return new Request(this); }
}

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
    this.url        = raw && raw.url || url;
    this.status     = raw ? raw.status : 0;
    this.statusText = '';
    this.ok         = this.status >= 200 && this.status < 300;
    this.redirected = !!(raw && raw.redirected);
    this.type       = raw && raw.type || 'basic';
    this.bodyUsed   = false;
  }
  _decodeBytes() {
    if (this._raw && typeof this._raw.body_b64 === 'string') {
      try { return globalThis.atob(this._raw.body_b64); } catch (_) { return ''; }
    }
    return this._bodyText;
  }
  _consume() {
    if (this._consumed) return Promise.reject(new TypeError('Body already consumed'));
    this._consumed = true;
    this.bodyUsed  = true;
    return null;
  }
  text()        { return this._consume() || Promise.resolve(this._bodyText); }
  json() {
    const guard = this._consume();
    if (guard) return guard;
    try { return Promise.resolve(JSON.parse(this._bodyText || 'null')); }
    catch (e) { return Promise.reject(e); }
  }
  blob() {
    return this._consume() || Promise.resolve(
      new globalThis.Blob([this._decodeBytes()], { type: this.headers.get && this.headers.get('content-type') || '' })
    );
  }
  arrayBuffer() {
    return this._consume() || Promise.resolve(bytesToArrayBuffer(this._decodeBytes()));
  }
  formData() { return Promise.resolve(new globalThis.FormData()); }
  clone()    { return new FetchResponse(this._raw, this._url); }
}

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
    const bodyText = bodyOrRaw == null ? '' : String(bodyOrRaw);
    super({status, body: bodyText, headers, url: ''}, '');
    this.statusText = statusText;
    this.type       = 'default';
  }
  static json(data, init) {
    init = init || {};
    const headers = Object.assign({'content-type': 'application/json'}, init.headers || {});
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
  // Building the request can throw (an invalid header name/value — header-values'
  // "needs to throw"): validate init.headers up front and surface it as a rejected
  // promise, since fetch() never throws synchronously.
  if (init.headers != null) {
    try { new globalThis.Headers(init.headers); } catch (e) { return Promise.reject(e); }
  }
  let url, method = 'GET', body = null, headers = {};
  if (typeof input === 'string') {
    url = input;
  } else if (input && input.url) {
    url = input.url;
    if (input.method)       method  = input.method;
    if (input.body != null) body    = input.body;
    if (input.headers)      headers = input.headers;
  } else {
    url = String(input);
  }
  if (init.method)       method = init.method;
  if (init.body != null) body   = init.body;
  if (init.headers) {
    if (init.headers instanceof globalThis.Headers) {
      init.headers.forEach((v, k) => { headers[k] = v; });
    } else if (typeof init.headers === 'object') {
      Object.assign(headers, init.headers);
    }
  }
  const { body: bodyStr, b64 } = serializeRequestBody(body, headers);
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
        const resp = globalThis.__rackFetch(method.toUpperCase(), url, bodyStr, headers, 'follow');
        if (!resp) { reject(new TypeError('Network request failed: ' + url)); return; }
        resolve(new Response(resp, url));
      } catch (e) { reject(e); }
    }, 0);
  });
};

globalThis.Request  = Request;
globalThis.Response = Response;
