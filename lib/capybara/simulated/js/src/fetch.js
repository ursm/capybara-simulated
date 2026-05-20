// `window.fetch(url, opts)` — Modern Stimulus controllers and
// `@rails/request.js` lean on the fetch API. The Ruby side
// (`__rackFetch`) resolves the Rack app synchronously inline; this
// module's public surface is fetch-shaped (returns a Promise;
// `Response#text/json/blob/arrayBuffer/formData` also return Promises)
// so `await fetch(...)` chains stay idiomatic. V8 microtasks drain
// after each `Context#eval` so the awaits progress without explicit
// ticking.
//
// `blob:` URLs resolve out of the in-process blob registry
// (`resolveBlobBytes`) without going through the Rack stack.

import { bytesToArrayBuffer } from './bytes.js';
import { resolveBlobBytes }   from './blob.js';

function makeFetchResponse(raw, url) {
  let consumed = false;
  const headers = new globalThis.Headers(raw && raw.headers || {});
  // `body` carries the UTF-8 text form (legacy; fine for
  // text/json/css/js). `body_b64` carries the raw bytes
  // base64-encoded — Ruby always sends both. `arrayBuffer()` /
  // `blob()` decode b64 to a latin-1 byte string so binary
  // payloads (Tesseract.js's gzipped traineddata, image bytes)
  // survive intact. Synthetic responses (blob:-URL handlers) pass
  // only `body` — we fall back to `String(body)` there.
  const bodyText = (raw && raw.body) || '';
  const decodeBytes = () => {
    if (raw && typeof raw.body_b64 === 'string') {
      try { return globalThis.atob(raw.body_b64); } catch (_) { return ''; }
    }
    return bodyText;
  };
  const status = raw ? raw.status : 0;
  return {
    url: raw && raw.url || url,
    status,
    statusText: '',
    ok: status >= 200 && status < 300,
    redirected: !!(raw && raw.redirected),
    type: raw && raw.type || 'basic',
    headers,
    bodyUsed: false,
    _raw: raw,
    text() {
      if (consumed) return Promise.reject(new TypeError('Body already consumed'));
      consumed = true; this.bodyUsed = true;
      return Promise.resolve(bodyText);
    },
    json() {
      if (consumed) return Promise.reject(new TypeError('Body already consumed'));
      consumed = true; this.bodyUsed = true;
      try { return Promise.resolve(JSON.parse(bodyText || 'null')); }
      catch (e) { return Promise.reject(e); }
    },
    blob() {
      if (consumed) return Promise.reject(new TypeError('Body already consumed'));
      consumed = true; this.bodyUsed = true;
      return Promise.resolve(new globalThis.Blob([decodeBytes()], { type: headers.get && headers.get('content-type') || '' }));
    },
    arrayBuffer() {
      if (consumed) return Promise.reject(new TypeError('Body already consumed'));
      consumed = true; this.bodyUsed = true;
      return Promise.resolve(bytesToArrayBuffer(decodeBytes()));
    },
    formData() {
      return Promise.resolve(new globalThis.FormData());
    },
    clone() { return makeFetchResponse(raw, url); }
  };
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
  let bodyStr = '';
  if (body != null) {
    if (typeof body === 'string') {
      bodyStr = body;
    } else if (body instanceof globalThis.FormData) {
      const parts = [];
      body.forEach((v, k) => parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(v))));
      bodyStr = parts.join('&');
      if (!('Content-Type' in headers) && !('content-type' in headers)) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
      }
    } else if (body instanceof globalThis.URLSearchParams) {
      bodyStr = body.toString();
      if (!('Content-Type' in headers) && !('content-type' in headers)) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
      }
    } else {
      bodyStr = String(body);
    }
  }
  if (typeof url === 'string' && url.startsWith('blob:')) {
    return new Promise(function (resolve, reject) {
      const r = resolveBlobBytes(url);
      if (!r) return reject(new TypeError('blob URL not found: ' + url));
      resolve(makeFetchResponse({
        status:  200,
        body:    r.bytes,
        headers: { 'content-type': r.type },
        url
      }, url));
    });
  }
  return new Promise(function (resolve, reject) {
    try {
      const resp = globalThis.__rackFetch(method.toUpperCase(), url, bodyStr, headers, 'follow');
      if (!resp) { reject(new TypeError('Network request failed: ' + url)); return; }
      resolve(makeFetchResponse(resp, url));
    } catch (e) { reject(e); }
  });
};
