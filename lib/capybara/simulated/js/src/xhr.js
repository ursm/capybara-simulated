// XMLHttpRequest (sync-backed) — Rails-UJS / jQuery.ajax / many
// older libraries lean on the XHR surface. We implement just enough
// of it to round-trip a Rack call through the existing `__rackFetch`
// host fn. The actual fetch is synchronous (mini_racer's attach() is
// blocking); we *defer* the readystatechange / load events through
// the virtual clock so the call site's "then" / .done handlers run
// after the current frame unwinds, matching real-async semantics for
// the listener ordering libraries assume.

import { bytesToArrayBuffer } from './bytes.js';

// Build `xhr.response` for any `responseType`. `text` is the UTF-8
// string form (what `responseText` carries); `bytes` is the latin-1
// byte string (raw bytes preserved across the mini_racer / quickjs
// string boundary). The two coincide for synthetic blob: responses
// and diverge for binary HTTP bodies, where `bytes` comes from
// base64-decoding the response's `body_b64`.
function responseValue(responseType, text, bytes, contentType) {
  switch (responseType) {
    case 'arraybuffer': return bytesToArrayBuffer(bytes);
    case 'blob':        return new globalThis.Blob([bytes], {type: contentType || 'application/octet-stream'});
    case 'json':
      try { return text ? JSON.parse(text) : null; }
      catch (_) { return null; }
    default: return text;
  }
}

export function XMLHttpRequest() {
  this.readyState         = 0;   // UNSENT
  this.status             = 0;
  this.statusText         = '';
  this.responseText       = '';
  this.response           = '';
  this.responseType       = '';
  this.responseURL        = '';
  this.responseXML        = null;
  this.timeout            = 0;
  this.withCredentials    = false;
  this.upload             = {addEventListener() {}, removeEventListener() {}, dispatchEvent() {}};
  this.onreadystatechange = null;
  this.onload             = null;
  this.onloadstart        = null;
  this.onloadend          = null;
  this.onerror            = null;
  this.onabort            = null;
  this.ontimeout          = null;
  this.onprogress         = null;
  this._method            = 'GET';
  this._url               = '';
  this._async             = true;
  this._headers           = {};
  this._respHeaders       = {};
  this._listeners         = Object.create(null);
  this._aborted           = false;
}
XMLHttpRequest.UNSENT           = 0;
XMLHttpRequest.OPENED           = 1;
XMLHttpRequest.HEADERS_RECEIVED = 2;
XMLHttpRequest.LOADING          = 3;
XMLHttpRequest.DONE             = 4;
XMLHttpRequest.prototype.UNSENT           = 0;
XMLHttpRequest.prototype.OPENED           = 1;
XMLHttpRequest.prototype.HEADERS_RECEIVED = 2;
XMLHttpRequest.prototype.LOADING          = 3;
XMLHttpRequest.prototype.DONE             = 4;
XMLHttpRequest.prototype.open = function (method, url, async) {
  this._method    = String(method || 'GET').toUpperCase();
  this._url       = String(url || '');
  this._async     = async !== false;
  this._headers   = {};
  this.readyState = 1;
  this._fireReady();
};
XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
  this._headers[String(name)] = String(value);
};
XMLHttpRequest.prototype.getResponseHeader = function (name) {
  const v = this._respHeaders[String(name).toLowerCase()];
  return v == null ? null : v;
};
XMLHttpRequest.prototype.getAllResponseHeaders = function () {
  return Object.entries(this._respHeaders).map(([k, v]) => k + ': ' + v).join('\r\n');
};
XMLHttpRequest.prototype.overrideMimeType = function () {};
XMLHttpRequest.prototype.addEventListener = function (type, handler) {
  if (typeof handler !== 'function') return;
  (this._listeners[type] = this._listeners[type] || []).push(handler);
};
XMLHttpRequest.prototype.removeEventListener = function (type, handler) {
  const list = this._listeners[type];
  if (!list) return;
  this._listeners[type] = list.filter(h => h !== handler);
};
XMLHttpRequest.prototype.abort = function () {
  this._aborted   = true;
  this.readyState = 4;
  this.status     = 0;
  this._fireReady();
  this._fireEvent('abort');
  this._fireEvent('loadend');
};
XMLHttpRequest.prototype.send = function (body) {
  const self = this;
  const doFetch = () => {
    if (self._aborted) return;
    if (typeof self._url === 'string' && self._url.startsWith('blob:')) {
      const r           = globalThis.__csimResolveBlobBytes(self._url);
      const bytes       = r ? r.bytes : '';
      const contentType = r ? r.type  : '';
      self.status       = r ? 200 : 404;
      self.statusText   = r ? 'OK' : 'Not Found';
      self.responseURL  = self._url;
      self.responseText = bytes;
      self.response     = responseValue(self.responseType, bytes, bytes, contentType);
      self._respHeaders = r ? {'content-type': contentType} : {};
      self.readyState   = 4;
      self._fireReady();
      self._fireEvent(r ? 'load' : 'error');
      self._fireEvent('loadend');
      return;
    }
    let resp;
    try {
      // FormData / URLSearchParams / Headers all reach here when
      // Rails-UJS submits a `data-remote="true"` form. The default
      // `String(fd)` returns `"[object Object]"` which Rails treats
      // as garbage. Serialise to urlencoded — the most common no-file
      // path — and let the multipart layer handle attachments.
      let bodyStr;
      if (body == null) {
        bodyStr = '';
      } else if (typeof body === 'string') {
        bodyStr = body;
      } else if (body instanceof globalThis.FormData) {
        // FormData carrying a File/Blob entry needs proper
        // multipart/form-data — `String(file)` becomes
        // "[object Object]" otherwise and Paperclip (or any
        // multipart-aware uploader) rejects the request. The
        // urlencoded path is still the no-file fast lane (Rails-UJS
        // data-remote forms, JSON-API posts).
        let hasFile = false;
        body.forEach((v) => { if (v instanceof globalThis.Blob) hasFile = true; });
        if (hasFile) {
          const ser = globalThis.__csimSerializeMultipart(body);
          bodyStr = globalThis.btoa(ser.body);
          self._headers['X-Csim-Body-B64'] = '1';
          if (!self._headers['Content-Type'] && !self._headers['content-type']) {
            self._headers['Content-Type'] = 'multipart/form-data; boundary=' + ser.boundary;
          }
        } else {
          const parts = [];
          body.forEach((v, k) => parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(v))));
          bodyStr = parts.join('&');
          if (!self._headers['Content-Type'] && !self._headers['content-type']) {
            self._headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
          }
        }
      } else if (body instanceof globalThis.URLSearchParams) {
        bodyStr = body.toString();
        if (!self._headers['Content-Type'] && !self._headers['content-type']) {
          self._headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
        }
      } else if (body instanceof globalThis.Blob) {
        // ActiveStorage's `BlobUpload` PUTs the raw file to disk
        // storage via `xhr.send(file)`. The bytes need to cross the
        // mini_racer boundary without UTF-8 reinterpretation, so we
        // base64 them and signal to Rack via a custom header. The
        // Ruby side decodes before building the env input.
        const raw = globalThis.__csimBlobBytes(body);
        bodyStr = raw ? globalThis.btoa(raw) : '';
        self._headers['X-Csim-Body-B64'] = '1';
        if (!self._headers['Content-Type'] && !self._headers['content-type'] && body.type) {
          self._headers['Content-Type'] = body.type;
        }
      } else {
        bodyStr = String(body);
      }
      resp = globalThis.__rackFetch(self._method, self._url, bodyStr, self._headers, 'follow');
    } catch (_) { resp = null; }
    if (!resp) {
      self.readyState = 4;
      self.status     = 0;
      self._fireReady();
      self._fireEvent('error');
      self._fireEvent('loadend');
      return;
    }
    self.status       = resp.status || 200;
    self.statusText   = resp.statusText || '';
    self.responseURL  = resp.url || self._url;
    self.responseText = resp.body == null ? '' : String(resp.body);
    // For arraybuffer/blob responseType, decode `body_b64` to a
    // latin-1 byte string so binary payloads survive the engine's
    // UTF-8 string boundary intact. Text/json types keep using the
    // already-decoded `responseText`.
    const needsBytes  = self.responseType === 'arraybuffer' || self.responseType === 'blob';
    let bytes         = self.responseText;
    if (needsBytes && typeof resp.body_b64 === 'string') {
      try { bytes = globalThis.atob(resp.body_b64); } catch (_) {}
    }
    const headers     = resp.headers || {};
    const contentType = headers['content-type'] || headers['Content-Type'] || '';
    self.response     = responseValue(self.responseType, self.responseText, bytes, contentType);
    const norm = {};
    for (const k of Object.keys(headers)) norm[k.toLowerCase()] = String(headers[k]);
    self._respHeaders = norm;
    self.readyState = 2; self._fireReady();
    self.readyState = 3; self._fireReady();
    self.readyState = 4; self._fireReady();
    self._fireEvent('load');
    self._fireEvent('loadend');
  };
  // Real async: defer through the virtual clock so the current
  // microtask completes before listeners run. Sync XHR (async=false)
  // runs the fetch inline.
  if (this._async) {
    globalThis.setTimeout(doFetch, 0);
  } else {
    doFetch();
  }
};
XMLHttpRequest.prototype._fireReady = function () {
  // readystatechange goes through `_fireEvent`, which itself reads
  // `this.onreadystatechange` — calling the handler here directly
  // double-fires it. Rails-UJS keys on the DONE state to invoke its
  // `done(xhr)` callback, so the second fire triggered `processResponse`
  // a second time and re-eval'd the script response (toggling the
  // visibility back to hidden). The single _fireEvent dispatch is
  // enough.
  this._fireEvent('readystatechange');
};
XMLHttpRequest.prototype._fireEvent = function (type) {
  const handler = this['on' + type];
  if (typeof handler === 'function') {
    try { handler.call(this, {type, target: this, currentTarget: this}); } catch (_) {}
  }
  const list = this._listeners[type];
  if (list) for (const h of list.slice()) {
    try { h.call(this, {type, target: this, currentTarget: this}); } catch (_) {}
  }
};
