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
import { getEncoding }             from './encodings.js';
import { Event, ProgressEvent, EventTarget, dispatchWithOnHandler } from './events.js';

// The `charset` parameter of a MIME type (`text/plain; charset="iso-2022-cn"` →
// `iso-2022-cn`), or null when absent. Mirrors the charset regex used elsewhere
// (dom-nodes.js / file-reader.js), accepting a quoted or bare value.
function charsetOf(mime) {
  const m = /;\s*charset\s*=\s*("?)([^";]+)\1/i.exec(String(mime || ''));
  return m ? m[2].trim() : null;
}

// An HTTP `token` (RFC 7230 / Fetch "header name" + "method"): one or more
// `tchar`. Used to validate XHR open() methods and setRequestHeader() names —
// a non-token (empty, or containing a separator / space / control) is a
// SyntaxError, not a silently-accepted header.
const HTTP_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
// The XMLHttpRequestResponseType IDL enum — any other value assigned to
// responseType is ignored.
const RESPONSE_TYPES = ['', 'arraybuffer', 'blob', 'document', 'json', 'text'];
// DOMParser marks a non-well-formed XML parse with a <parsererror> root in this
// namespace; XHR responseXML maps that to null.
const PARSERERROR_NS = 'http://www.mozilla.org/newlayout/xml/parsererror.xml';
// Methods normalized to uppercase by open() when matched case-insensitively
// (Fetch "normalize a method"). PATCH is deliberately NOT here, so `open('patCH')`
// keeps its case — open-method-case-sensitive asserts exactly that.
const NORMALIZED_METHODS = ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'POST', 'PUT'];
// Methods open() must reject with a SecurityError (Fetch "forbidden method").
const FORBIDDEN_METHODS = ['CONNECT', 'TRACE', 'TRACK'];
// Header names setRequestHeader() silently drops (Fetch "forbidden request-header"):
// the UA controls these. Names are compared lowercased; `proxy-`/`sec-` are prefixes.
const FORBIDDEN_HEADERS = new Set([
  'accept-charset', 'accept-encoding', 'access-control-request-headers',
  'access-control-request-method', 'connection', 'content-length', 'cookie',
  'cookie2', 'date', 'dnt', 'expect', 'host', 'keep-alive', 'origin', 'referer',
  'set-cookie', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'via'
]);
function isForbiddenHeader(lower) {
  return FORBIDDEN_HEADERS.has(lower) || lower.startsWith('proxy-') || lower.startsWith('sec-');
}

// Re-decode `responseText` for the request's final encoding (XHR "get a final
// encoding": the overrideMimeType charset wins over the Content-Type charset).
// We only model the WHATWG `replacement` encoding here (labels csiso2022kr /
// hz-gb-2312 / iso-2022-cn[-ext] / iso-2022-kr / `replacement`): its decoder
// maps ANY non-empty byte stream to a single U+FFFD and an empty one to '' —
// the encoding exists precisely to neutralise these unsafe charsets, so only
// emptiness matters, no transcode table. An unknown / other label is a no-op
// (the body was already UTF-8-decoded), so this never disturbs normal requests.
function applyResponseCharset(text, charsetLabel) {
  if (text == null || text === '') return text == null ? '' : text;
  if (charsetLabel && getEncoding(charsetLabel) === 'replacement') return '�';
  return text;
}

// Build `xhr.response` for any `responseType`. `text` is the UTF-8
// string form (what `responseText` carries); `bytes` is the latin-1
// byte string (raw bytes preserved across the engine
// string boundary). The two coincide for synthetic blob: responses
// and diverge for binary HTTP bodies, where `bytes` comes from
// base64-decoding the response's `body_b64`.
// Decode a `data:[<mediatype>][;base64],<data>` URL (RFC 2397) into a synthetic
// Rack-shaped response. Returns null for a malformed data: URL (→ XHR error).
function parseDataUrl(url) {
  const m = /^data:([^,]*),([\s\S]*)$/i.exec(String(url));
  if (!m) return null;
  const meta = m[1];
  const base64 = /;base64\s*$/i.test(meta);
  const ct = (meta.replace(/;base64\s*$/i, '') || 'text/plain;charset=US-ASCII');
  let body;
  if (base64) { try { body = globalThis.atob(m[2]); } catch (_) { body = ''; } }
  else { try { body = decodeURIComponent(m[2]); } catch (_) { body = m[2]; } }  // malformed %-escape → raw
  return { status: 200, statusText: 'OK', url: String(url), body, headers: { 'content-type': ct } };
}

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
    this._responseText      = '';
    this.response           = '';
    this._responseType      = '';   // exposed via the responseType getter/setter (enum-validated)
    this.responseURL        = '';
    this._responseXML       = null; // exposed via the responseXML getter (throws for non-document types)
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
    this._username          = null;
    this._password          = null;
    this._headers           = {};
    this._respHeaders       = {};
    this._aborted           = false;
    this._sendFlag          = false;
    this._timeoutId         = null;
    this._overrideCharset   = null;
  }

  // Instance copies of the readyState constants so `xhr.DONE` works.
  // Static constants on the class itself (`XMLHttpRequest.DONE`)
  // come from the static fields above.
  get UNSENT()           { return 0; }
  get OPENED()           { return 1; }
  get HEADERS_RECEIVED() { return 2; }
  get LOADING()          { return 3; }
  get DONE()             { return 4; }

  // `responseType` is an IDL enumeration: an invalid value is ignored (the attribute
  // keeps its prior value), and setting it once the response is LOADING/DONE is an
  // InvalidStateError (response-invalid-responsetype).
  get responseType() { return this._responseType; }
  set responseType(v) {
    if (this.readyState === 3 || this.readyState === 4) {
      throw new globalThis.DOMException("Failed to set the 'responseType' property on 'XMLHttpRequest': the response type cannot be set if the object's state is LOADING or DONE.", 'InvalidStateError');
    }
    v = String(v);
    if (RESPONSE_TYPES.includes(v)) this._responseType = v;
  }
  // `responseText` is only accessible for responseType '' or 'text'; any other type
  // makes the getter throw InvalidStateError (responsexml-non-document-types).
  get responseText() {
    if (this._responseType !== '' && this._responseType !== 'text') {
      throw new globalThis.DOMException("Failed to read the 'responseText' property from 'XMLHttpRequest': the value is only accessible if the object's 'responseType' is '' or 'text' (was '" + this._responseType + "').", 'InvalidStateError');
    }
    return this._responseText;
  }
  // `responseXML` is only meaningful for responseType '' or 'document'; any other
  // type makes the getter throw InvalidStateError (responsexml-non-document-types).
  get responseXML() {
    if (this._responseType !== '' && this._responseType !== 'document') {
      throw new globalThis.DOMException("Failed to read the 'responseXML' property from 'XMLHttpRequest': the value is only accessible if the object's 'responseType' is '' or 'document' (was '" + this._responseType + "').", 'InvalidStateError');
    }
    return this._responseXML;
  }

  open(method, url, async, username, password) {
    // Spec § "open()" runs the method checks FIRST (steps 2-3), then parses the URL
    // (steps 5-6): a non-token method is a SyntaxError, a forbidden method
    // (CONNECT/TRACE/TRACK) a SecurityError — both BEFORE any URL parse or state
    // reset, so a bad open() leaves the object untouched. The method is then
    // normalized to uppercase only when it case-insensitively matches one of the
    // six known methods (so e.g. `chiCKEN` / `patCH` keep their case).
    const rawMethod = String(method == null ? '' : method);
    if (!HTTP_TOKEN.test(rawMethod)) {
      throw new globalThis.DOMException(`Failed to execute 'open' on 'XMLHttpRequest': '${rawMethod}' is not a valid HTTP method.`, 'SyntaxError');
    }
    if (FORBIDDEN_METHODS.includes(rawMethod.toUpperCase())) {
      throw new globalThis.DOMException(`Failed to execute 'open' on 'XMLHttpRequest': '${rawMethod}' HTTP method is unsupported.`, 'SecurityError');
    }
    const u = String(url == null ? '' : url);
    // Parse `url` against the document base; a parse FAILURE throws a SyntaxError
    // DOMException synchronously (before any send/fetch) — so a malformed URL never
    // reaches the network path (url/failure.html).
    const base = (globalThis.location && globalThis.location.href) || undefined;
    if (globalThis.__csim_urlIsMalformed(u, base)) {
      throw new globalThis.DOMException("Failed to execute 'open' on 'XMLHttpRequest': Invalid URL", 'SyntaxError');
    }
    // Reset request *and* response state per spec § "open()": a reused
    // xhr must not expose the prior response while back in OPENED.
    this._method      = NORMALIZED_METHODS.includes(rawMethod.toUpperCase()) ? rawMethod.toUpperCase() : rawMethod;
    this._url         = u;
    this._async       = async !== false;
    // open()'s username/password (steps 9-10): when given (non-null), they override
    // the URL's userinfo for the request's credentials (send-authentication).
    this._username    = username == null ? null : String(username);
    this._password    = password == null ? null : String(password);
    this._headers     = {};
    this._aborted     = false;
    this._sendFlag    = false;
    this.status       = 0;
    this.statusText   = '';
    this._responseText = '';
    this.response     = '';
    this.responseURL  = '';
    this._responseXML = null;
    this._respHeaders = {};
    // Snapshot a blob: GET target NOW (at open), so the request keeps working
    // even if `URL.revokeObjectURL` runs before send() — the reference is taken
    // when the URL is received, per spec.
    this._blobSnapshot = (this._method === 'GET' && u.startsWith('blob:')) ? resolveBlobBytes(u) : null;
    this.readyState   = 1;
    this._fireReady();
  }
  // Spec § "setRequestHeader()": only valid in OPENED with the send flag unset; the
  // name must be a token and the (whitespace-normalized) value a valid header value,
  // else SyntaxError. A forbidden request-header is silently dropped; a repeated
  // name is combined with `, `.
  setRequestHeader(name, value) {
    // `name`/`value` are WebIDL ByteStrings: a code unit > 0xFF can't be one, so the
    // argument coercion throws a TypeError (before any state / token check).
    if (/[^\x00-\xff]/.test(String(name)) || /[^\x00-\xff]/.test(String(value))) {
      throw new TypeError("Failed to execute 'setRequestHeader' on 'XMLHttpRequest': argument is not a valid ByteString.");
    }
    if (this.readyState !== 1 || this._sendFlag) {
      throw new globalThis.DOMException("Failed to execute 'setRequestHeader' on 'XMLHttpRequest': The object's state must be OPENED.", 'InvalidStateError');
    }
    const n = String(name);
    const v = String(value).replace(/^[\t\n\r ]+/, '').replace(/[\t\n\r ]+$/, '');   // normalize: strip leading/trailing HTTP whitespace
    if (!HTTP_TOKEN.test(n)) {
      throw new globalThis.DOMException(`Failed to execute 'setRequestHeader' on 'XMLHttpRequest': '${n}' is not a valid HTTP header field name.`, 'SyntaxError');
    }
    if (/[\0\n\r]/.test(v)) {
      throw new globalThis.DOMException(`Failed to execute 'setRequestHeader' on 'XMLHttpRequest': '${value}' is not a valid HTTP header field value.`, 'SyntaxError');
    }
    const lower = n.toLowerCase();
    if (isForbiddenHeader(lower)) return;
    const existing = Object.keys(this._headers).find(k => k.toLowerCase() === lower);
    if (existing != null) this._headers[existing] += ', ' + v;
    else this._headers[n] = v;
  }
  getResponseHeader(name) {
    const v = this._respHeaders[String(name).toLowerCase()];
    return v == null ? null : v;
  }
  getAllResponseHeaders() {
    return Object.entries(this._respHeaders).map(([k, v]) => k + ': ' + v).join('\r\n');
  }
  // Spec § "overrideMimeType()": record the override; its charset then wins over
  // the response Content-Type's in the response text-decode step. (Persists across
  // open() per spec — only a fresh object resets it.)
  overrideMimeType(mime) { this._overrideCharset = charsetOf(mime); }
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
  // Preemptive HTTP Basic auth: if the request has credentials (open()'s
  // username/password, which override the URL's userinfo, else the URL's userinfo),
  // set an `Authorization: Basic` header — unless the author already set one via
  // setRequestHeader (send-authentication-basic-setrequestheader). Real browsers do
  // the 401-challenge dance; sending preemptively is observably equivalent for the
  // vendored authentication.py (it echoes whatever credentials it receives).
  _applyCredentials() {
    let urlUser = null, urlPass = null;
    try {
      const base = (globalThis.location && globalThis.location.href) || undefined;
      const pu = new globalThis.URL(this._url, base);
      if (pu.username) urlUser = decodeURIComponent(pu.username);
      if (pu.password) urlPass = decodeURIComponent(pu.password);
      if (pu.username || pu.password) {   // strip userinfo from the request URL (it rides Authorization instead)
        pu.username = ''; pu.password = '';
        this._url = pu.href;
      }
    } catch (_) {}
    const user = this._username != null ? this._username : urlUser;
    const pass = this._password != null ? this._password : urlPass;
    if (user == null && pass == null) return;
    if (Object.keys(this._headers).some(k => k.toLowerCase() === 'authorization')) return;
    this._headers['Authorization'] = 'Basic ' + globalThis.btoa((user || '') + ':' + (pass || ''));
  }
  send(body) {
    // Spec § "send()": only valid in OPENED with the send flag unset. Set the flag
    // so a later setRequestHeader() (or a second send()) throws InvalidStateError.
    if (this.readyState !== 1 || this._sendFlag) {
      throw new globalThis.DOMException("Failed to execute 'send' on 'XMLHttpRequest': The object's state must be OPENED.", 'InvalidStateError');
    }
    this._sendFlag = true;
    this._applyCredentials();
    // Spec § "send()": a GET/HEAD request has no body — drop the argument so it
    // neither reaches the wire nor fires upload progress (send-entity-body-get-head).
    if (this._method === 'GET' || this._method === 'HEAD') body = null;
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
    if (typeof this._url === 'string' && /^data:/i.test(this._url)) {
      // `data:[<mediatype>][;base64],<data>` (RFC 2397) — synthesize a 200 so an
      // XHR GET to a data: URL works (declarative-shadow-dom-opt-in's XHR subtest).
      this._completeWith(parseDataUrl(this._url));
      return;
    }
    if (typeof this._url === 'string' && this._url.startsWith('blob:')) {
      // A blob: URL only answers GET (the snapshot is only taken for GET in
      // open()); any other method, a revoked URL, or an appended query/path is a
      // network error: status 0 and an `error` event, per the fetch spec.
      const r = this._blobSnapshot;
      if (!r) {
        this.status       = 0;
        this.statusText   = '';
        this.responseURL  = this._url;
        this.readyState   = 4;
        this._fireReady();
        this._fireEvent('error');
        this._fireEvent('loadend');
        return;
      }
      const bytes       = r.bytes;
      const contentType = r.type;
      this.status       = 200;
      this.statusText   = 'OK';
      this.responseURL  = this._url;
      this._responseText = bytes;
      this.response     = responseValue(this.responseType, bytes, bytes, contentType);
      this._respHeaders = {'content-type': contentType};
      this.readyState   = 4;
      this._fireReady();
      this._fireEvent('load');
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
    this._responseText = resp.body == null ? '' : String(resp.body);
    // For arraybuffer/blob responseType, decode `body_b64` to a
    // latin-1 byte string so binary payloads survive the engine's
    // UTF-8 string boundary intact. Text/json types keep using the
    // already-decoded `responseText`.
    const needsBytes  = this.responseType === 'arraybuffer' || this.responseType === 'blob';
    let bytes         = this._responseText;
    if (needsBytes && typeof resp.body_b64 === 'string') {
      try { bytes = globalThis.atob(resp.body_b64); } catch (_) {}
    }
    const headers     = resp.headers || {};
    const contentType = headers['content-type'] || headers['Content-Type'] || '';
    // XHR "get a final encoding": an overrideMimeType() charset wins over the
    // Content-Type's; re-decode responseText accordingly (only the `replacement`
    // encoding family is modelled — see applyResponseCharset). Done before
    // `response` is built so text/json responseTypes see the corrected text.
    this._responseText = applyResponseCharset(this._responseText, this._overrideCharset || charsetOf(contentType));
    this.response     = responseValue(this.responseType, this._responseText, bytes, contentType);
    // `responseXML` (and `response` for responseType 'document'): parse the body
    // into a Document, per the XHR "document response" steps. responseType
    // 'document' parses HTML or XML; the DEFAULT responseType ('') parses ONLY
    // XML-family MIME types (an HTML response leaves responseXML null under '' —
    // so a normal Turbo/AJAX HTML fetch never pays a parse it won't read).
    // DOMParser does NOT convert declarative shadow roots (only setHTMLUnsafe
    // does), which is exactly the XHR behaviour the opt-in test asserts.
    let ctMime    = String(contentType).split(';')[0].trim().toLowerCase();
    // "Get a final MIME type": an absent or unparseable Content-Type (no type/subtype,
    // e.g. '', 'bogus', 'application') defaults to text/xml — so it parses as XML
    // (responsexml-media-type), whereas a valid non-XML type (text/plain, text/xsl)
    // does not.
    if (!/^[^\s/]+\/[^\s/]+$/.test(ctMime)) ctMime = 'text/xml';
    const isXml   = /(\+xml|\/xml)$/.test(ctMime) || ctMime === 'image/svg+xml';
    const wantsDoc = this.responseType === 'document' || (this.responseType === '' && isXml);
    if (wantsDoc && typeof globalThis.DOMParser === 'function') {
      const mime = ctMime === 'application/xhtml+xml' ? 'application/xhtml+xml'
                 : (ctMime === 'image/svg+xml' ? 'image/svg+xml'
                 : (isXml ? 'application/xml' : 'text/html'));   // non-XML under 'document' → HTML
      try {
        const doc = new globalThis.DOMParser().parseFromString(this._responseText, mime);
        // XHR "document response": a non-well-formed XML parse yields null. DOMParser
        // surfaces the failure as a <parsererror> root in the Mozilla parsererror
        // namespace; an empty body has no root element at all. (HTML parsing never
        // fails, so text/html always keeps its document.)
        const de = doc && doc.documentElement;
        const xmlFailed = mime !== 'text/html' && (!de || de.namespaceURI === PARSERERROR_NS);
        this._responseXML = xmlFailed ? null : doc;
      } catch (_) { this._responseXML = null; }
      if (this._responseType === 'document') this.response = this._responseXML;
    }
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
    const total = this._responseText.length;
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
