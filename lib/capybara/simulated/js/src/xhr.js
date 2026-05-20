// XMLHttpRequest (sync-backed) — Rails-UJS / jQuery.ajax / many
// older libraries lean on the XHR surface. We implement just enough
// of it to round-trip a Rack call through the existing `__rackFetch`
// host fn. The actual fetch is synchronous (mini_racer's attach() is
// blocking); we *defer* the readystatechange / load events through
// the virtual clock so the call site's "then" / .done handlers run
// after the current frame unwinds, matching real-async semantics for
// the listener ordering libraries assume.

import { bytesToArrayBuffer }      from './bytes.js';
import { resolveBlobBytes }        from './blob.js';
import { serializeRequestBody }    from './request-body.js';

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

export class XMLHttpRequest {
  static UNSENT           = 0;
  static OPENED           = 1;
  static HEADERS_RECEIVED = 2;
  static LOADING          = 3;
  static DONE             = 4;

  constructor() {
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

  // Instance copies of the readyState constants so `xhr.DONE` works.
  // Static constants on the class itself (`XMLHttpRequest.DONE`)
  // come from the static fields above.
  get UNSENT()           { return 0; }
  get OPENED()           { return 1; }
  get HEADERS_RECEIVED() { return 2; }
  get LOADING()          { return 3; }
  get DONE()             { return 4; }

  open(method, url, async) {
    this._method    = String(method || 'GET').toUpperCase();
    this._url       = String(url || '');
    this._async     = async !== false;
    this._headers   = {};
    this.readyState = 1;
    this._fireReady();
  }
  setRequestHeader(name, value) { this._headers[String(name)] = String(value); }
  getResponseHeader(name) {
    const v = this._respHeaders[String(name).toLowerCase()];
    return v == null ? null : v;
  }
  getAllResponseHeaders() {
    return Object.entries(this._respHeaders).map(([k, v]) => k + ': ' + v).join('\r\n');
  }
  overrideMimeType() {}
  addEventListener(type, handler) {
    if (typeof handler !== 'function') return;
    (this._listeners[type] = this._listeners[type] || []).push(handler);
  }
  removeEventListener(type, handler) {
    const list = this._listeners[type];
    if (!list) return;
    this._listeners[type] = list.filter(h => h !== handler);
  }
  abort() {
    this._aborted   = true;
    this.readyState = 4;
    this.status     = 0;
    this._fireReady();
    this._fireEvent('abort');
    this._fireEvent('loadend');
  }
  send(body) {
    const doFetch = () => this._doFetch(body);
    // Real async: defer through the virtual clock so the current
    // microtask completes before listeners run. Sync XHR (async=false)
    // runs the fetch inline.
    if (this._async) globalThis.setTimeout(doFetch, 0);
    else             doFetch();
  }
  _doFetch(body) {
    if (this._aborted) return;
    if (typeof this._url === 'string' && this._url.startsWith('blob:')) {
      const r           = resolveBlobBytes(this._url);
      const bytes       = r ? r.bytes : '';
      const contentType = r ? r.type  : '';
      this.status       = r ? 200 : 404;
      this.statusText   = r ? 'OK' : 'Not Found';
      this.responseURL  = this._url;
      this.responseText = bytes;
      this.response     = responseValue(this.responseType, bytes, bytes, contentType);
      this._respHeaders = r ? {'content-type': contentType} : {};
      this.readyState   = 4;
      this._fireReady();
      this._fireEvent(r ? 'load' : 'error');
      this._fireEvent('loadend');
      return;
    }
    let resp;
    try {
      const bodyStr = this._serializeBody(body);
      resp = globalThis.__rackFetch(this._method, this._url, bodyStr, this._headers, 'follow');
    } catch (_) { resp = null; }
    if (!resp) {
      this.readyState = 4;
      this.status     = 0;
      this._fireReady();
      this._fireEvent('error');
      this._fireEvent('loadend');
      return;
    }
    this.status       = resp.status || 200;
    this.statusText   = resp.statusText || '';
    this.responseURL  = resp.url || this._url;
    this.responseText = resp.body == null ? '' : String(resp.body);
    // For arraybuffer/blob responseType, decode `body_b64` to a
    // latin-1 byte string so binary payloads survive the engine's
    // UTF-8 string boundary intact. Text/json types keep using the
    // already-decoded `responseText`.
    const needsBytes  = this.responseType === 'arraybuffer' || this.responseType === 'blob';
    let bytes         = this.responseText;
    if (needsBytes && typeof resp.body_b64 === 'string') {
      try { bytes = globalThis.atob(resp.body_b64); } catch (_) {}
    }
    const headers     = resp.headers || {};
    const contentType = headers['content-type'] || headers['Content-Type'] || '';
    this.response     = responseValue(this.responseType, this.responseText, bytes, contentType);
    const norm = {};
    for (const k of Object.keys(headers)) norm[k.toLowerCase()] = String(headers[k]);
    this._respHeaders = norm;
    this.readyState = 2; this._fireReady();
    this.readyState = 3; this._fireReady();
    this.readyState = 4; this._fireReady();
    this._fireEvent('load');
    this._fireEvent('loadend');
  }
  _serializeBody(body) {
    const { body: out, b64 } = serializeRequestBody(body, this._headers);
    if (b64) this._headers['X-Csim-Body-B64'] = '1';
    return out;
  }
  // `readystatechange` goes through `_fireEvent`, which itself reads
  // `this.onreadystatechange` — calling the handler here directly
  // double-fires it. Rails-UJS keys on the DONE state to invoke its
  // `done(xhr)` callback, so the second fire triggered
  // `processResponse` a second time and re-eval'd the script
  // response (toggling visibility back to hidden). The single
  // `_fireEvent` dispatch is enough.
  _fireReady() { this._fireEvent('readystatechange'); }
  _fireEvent(type) {
    const evt = {type, target: this, currentTarget: this};
    const handler = this['on' + type];
    if (typeof handler === 'function') {
      try { handler.call(this, evt); } catch (_) {}
    }
    const list = this._listeners[type];
    if (list) for (const h of list.slice()) {
      try { h.call(this, evt); } catch (_) {}
    }
  }
}

globalThis.XMLHttpRequest = XMLHttpRequest;
