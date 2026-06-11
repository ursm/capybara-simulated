// XMLHttpRequest (sync-backed) — Rails-UJS / jQuery.ajax / many
// older libraries lean on the XHR surface. We implement just enough
// of it to round-trip a Rack call through the existing `__rackFetch`
// host fn. The actual fetch is synchronous (the engine's attach() is
// blocking); we *defer* the readystatechange / load events through
// the virtual clock so the call site's "then" / .done handlers run
// after the current frame unwinds, matching real-async semantics for
// the listener ordering libraries assume.

import { bytesToArrayBuffer }      from './bytes.js';
import { resolveBlobBytes }        from './blob.js';
import { serializeRequestBody }    from './request-body.js';
import { Event, ProgressEvent, EventTarget, dispatchWithOnHandler } from './events.js';

// Build `xhr.response` for any `responseType`. `text` is the UTF-8
// string form (what `responseText` carries); `bytes` is the latin-1
// byte string (raw bytes preserved across the engine
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

// `XMLHttpRequestUpload` — the spec object on `xhr.upload`. Apps that
// drive upload progress (Uppy's XHRUpload wrapper, jQuery 1.x's
// `xhr.upload.onprogress = …`, axios) read this for byte counts.
// We fire loadstart / progress / load / loadend with the request
// body's total length around the underlying Rack call.
export class XMLHttpRequestUpload extends EventTarget {
  constructor() {
    super();
    this.onloadstart = null;
    this.onprogress  = null;
    this.onload      = null;
    this.onloadend   = null;
    this.onerror     = null;
    this.onabort     = null;
    this.ontimeout   = null;
  }
  _fire(type, extra) {
    const evt = new ProgressEvent(type, extra || {});
    dispatchWithOnHandler(this, evt);
  }
}

export class XMLHttpRequest extends EventTarget {
  static UNSENT           = 0;
  static OPENED           = 1;
  static HEADERS_RECEIVED = 2;
  static LOADING          = 3;
  static DONE             = 4;

  constructor() {
    super();
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
    this.upload             = new XMLHttpRequestUpload();
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
    this._aborted           = false;
    this._timeoutId         = null;
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
    // Reset request *and* response state per spec § "open()": a reused
    // xhr must not expose the prior response while back in OPENED.
    this._method      = String(method || 'GET').toUpperCase();
    this._url         = String(url || '');
    this._async       = async !== false;
    this._headers     = {};
    this._aborted     = false;
    this.status       = 0;
    this.statusText   = '';
    this.responseText = '';
    this.response     = '';
    this.responseURL  = '';
    this.responseXML  = null;
    this._respHeaders = {};
    this.readyState   = 1;
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
  abort()  { this._terminate('abort'); }
  // Mark the request done with `reason` ('abort' | 'timeout' | 'error')
  // and fan out the corresponding event pair on both the request and
  // the upload object per XHR spec § "request error steps".
  _terminate(reason) {
    if (this._timeoutId != null) { try { globalThis.clearTimeout(this._timeoutId); } catch (_) {} this._timeoutId = null; }
    if (this._asyncFetchHandle && typeof globalThis.__csim_rackFetchAsyncAbort === 'function') {
      try { globalThis.__csim_rackFetchAsyncAbort(this._asyncFetchHandle); } catch (_) {}
      if (globalThis.__csim_asyncFetchPending) delete globalThis.__csim_asyncFetchPending[this._asyncFetchHandle];
      this._asyncFetchHandle = 0;
    }
    this._aborted   = true;
    this.readyState = 4;
    this.status     = 0;
    this._fireReady();
    this._fireEvent(reason);
    this._fireEvent('loadend');
    this.upload._fire(reason);
    this.upload._fire('loadend');
  }
  send(body) {
    // `xhr.upload` loadstart fires once per request before the wire
    // exchange; even a zero-byte body gets it. Defer one task so the
    // listener (typically attached just before send()) actually
    // catches it.
    const hasBody = body != null;
    const total   = hasBody ? this._approxBodyLength(body) : 0;
    const fire = () => {
      if (this._aborted) return;
      this.upload._fire('loadstart', {loaded: 0, total, lengthComputable: total > 0});
      this._doFetch(body, total);
    };
    // CDP-throttle shim for Discourse `cdp.with_slow_upload`: the
    // composer's `isUploading` flag is set synchronously before
    // `send()` runs, so parking only the response side keeps
    // `#file-uploading` observable for the test assertion.
    const isWrite = hasBody && (this._method === 'POST' || this._method === 'PUT' || this._method === 'PATCH');
    if (globalThis.__csimSlowUploadActive && isWrite) {
      globalThis.__csimSlowUploadPending.push(fire);
      return;
    }
    if (this._async) {
      globalThis.setTimeout(fire, 0);
    } else {
      fire();
    }
    if (this._async && this.timeout > 0) {
      this._timeoutId = globalThis.setTimeout(() => {
        if (this.readyState === 4 || this._aborted) return;
        this._terminate('timeout');
      }, this.timeout);
    }
  }
  // Approximate body length for upload progress reporting. Real
  // browsers count the on-the-wire bytes; we count the serialised
  // string. FormData / Blob counts come from the serialiser.
  _approxBodyLength(body) {
    if (body == null) return 0;
    if (typeof body === 'string') return body.length;
    if (typeof body.size === 'number') return body.size; // Blob / File
    if (body instanceof ArrayBuffer)   return body.byteLength;
    if (ArrayBuffer.isView && ArrayBuffer.isView(body)) return body.byteLength;
    return 0;
  }
  _doFetch(body, uploadTotal) {
    if (this._aborted) return;
    if (this._timeoutId != null) { try { globalThis.clearTimeout(this._timeoutId); } catch (_) {} this._timeoutId = null; }
    // Upload progress: our Rack call buffers the body so we ship it
    // in one go. Fire progress(loaded=total) + load + loadend on the
    // upload object before processing the response.
    if (uploadTotal != null) {
      const t = uploadTotal | 0;
      this.upload._fire('progress', {loaded: t, total: t, lengthComputable: t > 0});
      this.upload._fire('load',     {loaded: t, total: t, lengthComputable: t > 0});
      this.upload._fire('loadend',  {loaded: t, total: t, lengthComputable: t > 0});
    }
    // Long-poll-shaped XHRs go through `rack_fetch_async` which
    // installs `rack.hijack` so the middleware can hold the
    // connection open until something publishes through it
    // (Discourse MessageBus's `subscribe(channel, -1)` + push-on-
    // publish flow). We can't extend this to every async XHR: some
    // Discourse middleware paths take a different streaming branch
    // when `rack.hijack?` is truthy, even without ever invoking
    // the lambda, and the response re-renders the page in a
    // slightly different order — Capybara `find`s after that race
    // into StaleElement. The Ruby side mirrors this URL gate so
    // the env keys stay off non-long-poll requests.
    if (this._async && this._method === 'POST' && typeof this._url === 'string' &&
        /\/message-bus\/[^/]+\/poll(?:\?|$)/.test(this._url) &&
        typeof globalThis.__csim_rackFetchAsync === 'function') {
      const bodyStr = typeof body === 'string' ? body : this._serializeBody(body);
      const headersJson = JSON.stringify(this._headers || {});
      const result = globalThis.__csim_rackFetchAsync(this._method, this._url, bodyStr, headersJson);
      if (result && typeof result === 'object') {
        if (typeof result.handle === 'number' && result.handle > 0) {
          this._asyncFetchHandle = result.handle;
          if (!globalThis.__csim_asyncFetchPending) globalThis.__csim_asyncFetchPending = {};
          globalThis.__csim_asyncFetchPending[result.handle] = this;
          return;
        }
        this._completeWith(result);
        return;
      }
    }
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
    this._completeWith(resp);
  }
  _completeWith(resp) {
    if (this._aborted) return;
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
    // Fire `progress` between HEADERS_RECEIVED and DONE so callers
    // that key off `onprogress` to read `responseText` as it streams
    // (Discourse's MessageBus chunked-frame parser, EventSource-shape
    // polyfills) see the data before the response transitions to
    // DONE. Our Rack-call buffers the body, so a single full-body
    // progress matches what real browsers emit for non-chunked
    // responses anyway (the spec only mandates "at least once").
    const total = this.responseText.length;
    this._fireEvent('progress', {loaded: total, total, lengthComputable: total > 0});
    this.readyState = 4; this._fireReady();
    this._fireEvent('load');
    this._fireEvent('loadend');
  }
  _serializeBody(body) {
    const { body: out, b64 } = serializeRequestBody(body, this._headers);
    if (b64) this._headers['X-Csim-Body-B64'] = '1';
    return out;
  }
  // `readystatechange` flows through dispatchWithOnHandler too — the
  // `onreadystatechange` IDL slot reads through it once, so we don't
  // double-fire (which used to re-eval Rails-UJS's script response and
  // toggle visibility back to hidden).
  _fireReady() { this._fireEvent('readystatechange'); }
  _fireEvent(type, extra) {
    const evt = extra ? new ProgressEvent(type, extra) : new Event(type);
    dispatchWithOnHandler(this, evt);
  }
}

globalThis.XMLHttpRequest = XMLHttpRequest;

globalThis.__csimSlowUploadPending = [];
globalThis.__csimDrainSlowUploads = function () {
  const q = globalThis.__csimSlowUploadPending;
  globalThis.__csimSlowUploadPending = [];
  for (const fn of q) fn();
};

// Async XHR completion. Browser#settle drains the Ruby-side queue
// (where both immediate sync responses and the background-read
// hijack responses end up) and hands the batch here. Look up each
// deferred XHR by handle and run the existing response-processing
// path so all the usual event sequencing (readystatechange 2/3/4 +
// progress + load + loadend) fires identically to a sync XHR.
globalThis.__csim_deliverHijackedFetches = function (responses) {
  if (!responses || !responses.length) return 0;
  const pending = globalThis.__csim_asyncFetchPending || {};
  let delivered = 0;
  for (const r of responses) {
    const handle = r && r.handle | 0;
    const xhr = pending[handle];
    if (!xhr) continue;
    delete pending[handle];
    xhr._asyncFetchHandle = 0;
    // `r` is whatever `rack_fetch` returns (full `response_hash` —
    // status, headers, body, body_b64, url, redirected) plus the
    // `handle`; `_completeWith` already reads those keys.
    xhr._completeWith(r);
    delivered++;
  }
  return delivered;
};
