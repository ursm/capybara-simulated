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
    } else {
      this.url    = String(input);
      this.method = 'GET';
      this._body  = null;
      this._headers = new globalThis.Headers();
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
    this.headers    = new globalThis.Headers(raw && raw.headers || {});
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

// `new Response(body, init)` — public constructor per Fetch spec.
// MSW handlers, fetch wrappers, and runtime API stubs construct
// Response objects directly to return canned data. Static factories
// `Response.json` / `Response.error` / `Response.redirect` cover the
// canonical patterns.
class Response extends FetchResponse {
  constructor(body, init) {
    init = init || {};
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
    const bodyText = body == null ? '' : String(body);
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
    return new Promise(function (resolve, reject) {
      // Defer through the virtual clock to match the spec's fetch
      // task boundary — fetch resolves on a separate task, so awaiting
      // it yields control. Inline resolve would race ahead of any
      // intervening microtasks (Turbo Drive's render chain).
      globalThis.setTimeout(function () {
        const r = resolveBlobBytes(url);
        if (!r) return reject(new TypeError('blob URL not found: ' + url));
        resolve(new FetchResponse({
          status:  200,
          body:    r.bytes,
          headers: { 'content-type': r.type },
          url
        }, url));
      }, 0);
    });
  }
  return new Promise(function (resolve, reject) {
    globalThis.setTimeout(function () {
      try {
        const resp = globalThis.__rackFetch(method.toUpperCase(), url, bodyStr, headers, 'follow');
        if (!resp) { reject(new TypeError('Network request failed: ' + url)); return; }
        resolve(new FetchResponse(resp, url));
      } catch (e) { reject(e); }
    }, 0);
  });
};

globalThis.Request  = Request;
globalThis.Response = Response;
