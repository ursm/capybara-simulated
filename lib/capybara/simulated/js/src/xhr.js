// XMLHttpRequest (sync-backed) — Rails-UJS / jQuery.ajax / many
// older libraries lean on the XHR surface. We implement just enough
// of it to round-trip a Rack call through the existing `__rackFetch`
// host fn. The actual fetch is synchronous (the engine's attach() is
// blocking); we *defer* the readystatechange / load events through
// the virtual clock so the call site's "then" / .done handlers run
// after the current frame unwinds, matching real-async semantics for
// the listener ordering libraries assume.

import { bytesToArrayBuffer, utf8DecodeBytes } from './bytes.js';
import { resolveBlobBytes }        from './blob.js';
import { processDataUrl }          from './data-url.js';
import { serializeRequestBody, fixContentTypeCharset, findHeaderKey } from './request-body.js';
import { getEncoding } from './encodings.js';
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
// The `X-HTTP-Method*` family is forbidden only when its value parses to a
// forbidden method (Fetch "forbidden request-header"): split on commas, strip
// each token's HTTP whitespace, and match CONNECT / TRACE / TRACK.
const METHOD_OVERRIDE_HEADERS = new Set(['x-http-method', 'x-http-method-override', 'x-method-override']);
function isForbiddenHeader(lower, value) {
  if (FORBIDDEN_HEADERS.has(lower) || lower.startsWith('proxy-') || lower.startsWith('sec-')) return true;
  if (METHOD_OVERRIDE_HEADERS.has(lower) && value != null) {
    for (const tok of String(value).split(',')) {
      if (FORBIDDEN_METHODS.includes(tok.replace(/^[\t\n\r ]+/, '').replace(/[\t\n\r ]+$/, '').toUpperCase())) return true;
    }
  }
  return false;
}
// Forbidden response-header names (Fetch): the UA filters these from the response
// header list it exposes, so getResponseHeader / getAllResponseHeaders never see them.
const FORBIDDEN_RESPONSE_HEADERS = new Set(['set-cookie', 'set-cookie2']);

// Decode raw response bytes (a latin-1 byte string from `body_b64`) into responseText
// per the WHATWG "decode" algorithm: a leading BOM (UTF-8 / UTF-16BE / UTF-16LE)
// overrides `label` and is removed; otherwise `label` (the final encoding) is used,
// defaulting to UTF-8. TextDecoder IS the WHATWG decoder, so every Encoding-standard
// label is handled exactly — windows-1252, UTF-16, the `replacement` family (any
// bytes → one U+FFFD) — including the BOM strip (ignoreBOM defaults to false). An
// unknown / invalid label (`charset=bogus`) is a decode failure → UTF-8 fallback.
function decodeResponseBytes(byteStr, label) {
  const n   = byteStr.length;
  const arr = new Uint8Array(n);
  for (let i = 0; i < n; i++) arr[i] = byteStr.charCodeAt(i) & 0xff;
  let enc = label;
  if (arr[0] === 0xEF && arr[1] === 0xBB && arr[2] === 0xBF)      enc = 'utf-8';
  else if (arr[0] === 0xFE && arr[1] === 0xFF)                    enc = 'utf-16be';
  else if (arr[0] === 0xFF && arr[1] === 0xFE)                    enc = 'utf-16le';
  else if (label && getEncoding(label) === 'replacement') {
    // The `replacement` encoding (csiso2022kr / hz-gb-2312 / iso-2022-cn[-ext] /
    // iso-2022-kr / replacement) maps ANY non-empty input to a single U+FFFD — and
    // the TextDecoder constructor rejects the label, so it's handled directly.
    return n ? '�' : '';
  }
  try { return new globalThis.TextDecoder(enc || 'utf-8').decode(arr); }
  catch (_) {
    try { return new globalThis.TextDecoder('utf-8').decode(arr); }
    catch (_) { return byteStr; }
  }
}


// The encoding declared in an XML prolog (`<?xml … encoding="…"?>`) — used for the
// DEFAULT responseType when an XML response carries no Content-Type charset (XHR "get
// a text response" step 3). The prolog is ASCII, so it reads from the head bytes.
function sniffXmlEncoding(byteStr) {
  const m = /<\?xml[^>]*\sencoding\s*=\s*["']([^"']+)["']/i.exec(byteStr.slice(0, 256));
  return m ? m[1] : null;
}

// The encoding declared by an HTML `<meta charset>` / `<meta http-equiv=content-type>`
// in the prescan window (first 1024 bytes) — used when parsing an HTML DOCUMENT
// response (responseType 'document') that carries no Content-Type charset, mirroring
// the HTML parser's own encoding sniff.
function sniffHtmlMetaEncoding(byteStr) {
  const head = byteStr.slice(0, 1024);
  let m = /<meta[^>]*\scharset\s*=\s*["']?\s*([^"'\s>;]+)/i.exec(head);
  if (m) return m[1];
  m = /<meta[^>]*http-equiv\s*=\s*["']?content-type["']?[^>]*content\s*=\s*["'][^"']*charset\s*=\s*([^"'\s;]+)/i.exec(head);
  return m ? m[1] : null;
}

// XHR overrideMimeType: parse `mime`; on parse failure the override MIME type is
// application/octet-stream with NO charset (a `;charset=…` on an otherwise-invalid
// type is discarded). Returns { essence, charset|null }.
// Is `body` a recognized XMLHttpRequestBodyInit (or Document)? Anything else passed to
// send() is converted to a USVString by the WebIDL union — see send().
function isBodyInit(body) {
  return typeof body === 'string'
      || (body != null && body.nodeType === 9)                                 // Document
      || body instanceof globalThis.Blob
      || body instanceof globalThis.FormData
      || body instanceof globalThis.URLSearchParams
      || body instanceof globalThis.ArrayBuffer
      || (globalThis.ArrayBuffer.isView && globalThis.ArrayBuffer.isView(body));
}

function parseOverrideMime(mime) {
  const vendor = globalThis.__csimVendor && globalThis.__csimVendor.mimeType;
  let parsed = null;
  if (vendor) { try { parsed = vendor.MIMEType.parse(String(mime)); } catch (_) {} }
  if (!parsed) return { essence: 'application/octet-stream', charset: null };
  const cs = parsed.parameters.get('charset');
  return { essence: parsed.essence, charset: cs == null ? null : cs };
}

// Build `xhr.response` for any `responseType`. `text` is the UTF-8
// string form (what `responseText` carries); `bytes` is the latin-1
// byte string (raw bytes preserved across the engine
// string boundary). The two coincide for synthetic blob: responses
// and diverge for binary HTTP bodies, where `bytes` comes from
// base64-decoding the response's `body_b64`.
// Decode a data: URL into a synthetic Rack-shaped response via the shared WHATWG data:
// URL processor. Returns null for a malformed data: URL (→ XHR error). The raw bytes ride
// `body_b64` so _completeWith decodes them with the final encoding (an overrideMimeType()
// charset / the media-type charset).
function parseDataUrl(url) {
  const parsed = processDataUrl(url);
  if (!parsed) return null;
  let body_b64 = '';
  try { body_b64 = globalThis.btoa(parsed.body); } catch (_) {}
  return { status: 200, statusText: 'OK', url: String(url), body: parsed.body, body_b64, headers: { 'content-type': parsed.mimeType } };
}

// `blobType` is the Blob response's MIME — the caller passes the "final MIME type"
// (the rack path) or the data:/blob: URL's own type, both already the right "final"
// value; only the `blob` branch reads it.
function responseValue(responseType, text, bytes, blobType, jsonText) {
  switch (responseType) {
    case 'arraybuffer': return bytesToArrayBuffer(bytes);
    // `bytes` is a latin-1 BYTE string (raw response bytes). A string Blob part is
    // UTF-8-encoded per spec, which would inflate a binary payload (0x89 → 0xC2 0x89),
    // so hand the Blob the bytes as an ArrayBuffer to preserve them verbatim.
    case 'blob':        return new globalThis.Blob([bytesToArrayBuffer(bytes)], {type: blobType || 'application/octet-stream'});
    case 'json': {
      // "parse JSON from bytes": the body is decoded as UTF-8 regardless of the response
      // charset, so e.g. a UTF-16 body fails to parse → null (json: UTF-16 → error).
      const s = jsonText != null ? jsonText : text;
      try { return s ? JSON.parse(s) : null; }
      catch (_) { return null; }
    }
    default: return text;
  }
}

// Parse a single HTTP byte-range request for a blob: response (Fetch "blob URL" range
// support): `bytes=START-END` / `bytes=START-` / `bytes=-SUFFIX`, OWS allowed. Returns
// {start, end} (inclusive, clamped to the body) for a satisfiable range, else null — a
// malformed OR unsatisfiable range is a network error for a blob URL (NOT a 416). Only a
// single range is supported (a comma list → null). `total` is the blob's byte length.
function parseByteRange(header, total) {
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/.exec(String(header));
  if (!m || (m[1] === '' && m[2] === '')) return null;
  if (m[1] === '') {
    const suffix = parseInt(m[2], 10);
    // A zero suffix, or any suffix against an empty body, is unsatisfiable (else end = -1).
    return (suffix && total > 0) ? {start: Math.max(0, total - suffix), end: total - 1} : null;
  }
  const start = parseInt(m[1], 10);
  if (start >= total) return null;   // start beyond the body → unsatisfiable
  const end = m[2] === '' ? total - 1 : Math.min(parseInt(m[2], 10), total - 1);
  return end < start ? null : {start, end};
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

  // WebIDL interface brand: `String(new XMLHttpRequest())` is "[object XMLHttpRequest]"
  // (send-data-es-object stringifies an XHR passed as a body), not "[object Object]".
  get [Symbol.toStringTag]() { return 'XMLHttpRequest'; }

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
    this._timeout           = 0;   // exposed via the timeout getter/setter
    this._withCredentials   = false;   // exposed via the withCredentials getter/setter
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
    this._uploadActive      = false;   // an upload is in progress (upload-complete flag unset)
    this._username          = null;
    this._password          = null;
    this._headers           = {};
    this._respHeaders       = {};
    this._aborted           = false;
    this._sendFlag          = false;
    this._timeoutId         = null;
    this._overrideMime      = null;
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
  // `timeout` (ms): setting it on a SYNCHRONOUS request whose global is a Window is
  // InvalidAccessError (timeout is async-only) — the post-open counterpart of the
  // open() check. The synchronous flag is set by a sync open(), so guard on an opened
  // request with the async flag clear. Allowed in a worker.
  get timeout() { return this._timeout; }
  set timeout(v) {
    if (!this._async && !globalThis.__csim_isWorker && this.readyState !== 0) {
      throw new globalThis.DOMException("Failed to set the 'timeout' property on 'XMLHttpRequest': Timeouts cannot be set for synchronous requests made from a document.", 'InvalidAccessError');
    }
    this._timeout = Number(v) || 0;
  }
  // `withCredentials`: settable only while the request is UNSENT or OPENED and the send
  // flag is unset — otherwise InvalidStateError (loadstart-and-state sets it during the
  // loadstart event, when the send flag is already set).
  get withCredentials() { return this._withCredentials; }
  set withCredentials(v) {
    if ((this.readyState !== 0 && this.readyState !== 1) || this._sendFlag) {
      throw new globalThis.DOMException("Failed to set the 'withCredentials' property on 'XMLHttpRequest': The value may only be set if the object's state is UNSENT or OPENED.", 'InvalidStateError');
    }
    this._withCredentials = !!v;
  }
  get responseType() { return this._responseType; }
  set responseType(v) {
    // WebIDL converts the value to the enumeration FIRST: an invalid value is silently
    // ignored (no setter steps run, so no state/sync error either — responsetype's
    // "nosuchtype" cases must not throw in LOADING / DONE / sync).
    v = String(v);
    if (!RESPONSE_TYPES.includes(v)) return;
    if (this.readyState === 3 || this.readyState === 4) {
      throw new globalThis.DOMException("Failed to set the 'responseType' property on 'XMLHttpRequest': the response type cannot be set if the object's state is LOADING or DONE.", 'InvalidStateError');
    }
    // In a Window, a synchronous request has no async response to type — setting
    // responseType throws InvalidAccessError (responsetype: sync-flag cases).
    if (!globalThis.__csim_isWorker && !this._async) {
      throw new globalThis.DOMException("Failed to set the 'responseType' property on 'XMLHttpRequest': the response type cannot be changed for synchronous requests made from a document.", 'InvalidAccessError');
    }
    this._responseType = v;
  }
  // `responseText` is only accessible for responseType '' or 'text'; any other type
  // makes the getter throw InvalidStateError (responsexml-non-document-types).
  get responseText() {
    if (this._responseType !== '' && this._responseType !== 'text') {
      throw new globalThis.DOMException("Failed to read the 'responseText' property from 'XMLHttpRequest': the value is only accessible if the object's 'responseType' is '' or 'text' (was '" + this._responseType + "').", 'InvalidStateError');
    }
    // The text response is the empty string until the body starts arriving:
    // responseText returns '' unless the state is LOADING or DONE (responseText-status).
    if (this.readyState !== 3 && this.readyState !== 4) return '';
    return this._responseText;
  }
  // `responseXML` is only meaningful for responseType '' or 'document'; any other
  // type makes the getter throw InvalidStateError (responsexml-non-document-types).
  get responseXML() {
    if (this._responseType !== '' && this._responseType !== 'document') {
      throw new globalThis.DOMException("Failed to read the 'responseXML' property from 'XMLHttpRequest': the value is only accessible if the object's 'responseType' is '' or 'document' (was '" + this._responseType + "').", 'InvalidStateError');
    }
    // responseXML is the document response only once the response is fully received —
    // null until state is DONE (abort-during-loading reads it at LOADING, expecting null).
    if (this.readyState !== 4) return null;
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
    // `url` is a WebIDL USVString: a lone surrogate becomes U+FFFD BEFORE the URL
    // parser runs, so it later percent-encodes as the document charset's unmappable
    // reference (`&#65533;`), not the raw surrogate code unit (open-url-encoding).
    const u = url == null ? '' : (globalThis.__csimToUSVString ? globalThis.__csimToUSVString(url) : String(url));
    // Parse `url` against the document base; a parse FAILURE throws a SyntaxError
    // DOMException synchronously (before any send/fetch) — so a malformed URL never
    // reaches the network path (url/failure.html).
    const base = (globalThis.location && globalThis.location.href) || undefined;
    if (globalThis.__csim_urlIsMalformed(u, base)) {
      throw new globalThis.DOMException("Failed to execute 'open' on 'XMLHttpRequest': Invalid URL", 'SyntaxError');
    }
    // The query is percent-encoded in the DOCUMENT's character encoding (open-url
    // -encoding: a `?ß` query → `%DF` under windows-1252; a lone surrogate, already
    // U+FFFD above, → the HTML `&#65533;` reference) — the URL parser's encoding
    // override applies to the query only. Re-encode just the query and leave the path
    // RELATIVE: path resolution stays deferred to the fetch layer, which resolves an
    // about:blank iframe's relative URL against its inherited parent base (the realm's
    // own location is only the origin root). The fragment is not part of the request.
    const isAsync = async !== false;
    // open() step: a SYNCHRONOUS request whose current global is a Window must have
    // neither a responseType nor a timeout set (both are async-only) — InvalidAccessError,
    // thrown BEFORE any state change so no events fire. Allowed in a worker.
    if (!isAsync && !globalThis.__csim_isWorker && (this._responseType !== '' || this.timeout !== 0)) {
      throw new globalThis.DOMException("Failed to execute 'open' on 'XMLHttpRequest': Synchronous requests from a document must not set a responseType or a timeout.", 'InvalidAccessError');
    }
    const doc = globalThis.document;
    let requestUrl = u;
    // The request URL is resolved against the API base URL AT OPEN TIME. When a
    // `<base href>` is in effect (the document's base URL differs from its own URL),
    // resolve a relative URL against it NOW, to an absolute URL — capturing the base
    // as it is at open() (a `<base>` inserted after open() must not apply:
    // open-url-base-inserted-after-open), and because the fetch layer resolves only
    // against the document URL. Without an explicit `<base>` the path stays RELATIVE
    // so the fetch layer resolves it against the correct inherited base (an
    // about:blank frame's parent base, which the JS realm location doesn't carry).
    const apiBase = (doc && doc.baseURI) || base;
    if (doc && doc.URL && apiBase !== doc.URL) {
      const parsed = globalThis.__csim_parseUrl(u, apiBase, doc.characterSet);
      // The request URL excludes the fragment (the fetch never sends it, and
      // responseURL is fragment-less) — drop anything past the first '#'.
      if (parsed && !parsed.error && parsed.href) requestUrl = parsed.href.split('#')[0];
    } else {
      const qIdx = u.indexOf('?');
      if (qIdx !== -1) {
        const parsedUrl = globalThis.__csim_parseUrl(u, base, doc && doc.characterSet);
        // `u` has a '?', so the request URL keeps one even for an empty query (`/x?` →
        // `/x?`, not `/x`) — parsedUrl.search is '' for an empty query.
        if (parsedUrl && !parsedUrl.error) requestUrl = u.slice(0, qIdx) + (parsedUrl.search || '?');
      }
    }
    // Reset request *and* response state per spec § "open()": a reused
    // xhr must not expose the prior response while back in OPENED.
    this._method      = NORMALIZED_METHODS.includes(rawMethod.toUpperCase()) ? rawMethod.toUpperCase() : rawMethod;
    this._url         = requestUrl;
    this._async       = isAsync;
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
    // Spec open() final step: change the state to OPENED and fire readystatechange
    // ONLY when it wasn't already OPENED — a re-open() of an already-opened request
    // (open-open-send / open-send-open) sets no new state, so fires no event.
    const wasOpened = this.readyState === 1;
    this.readyState   = 1;
    if (!wasOpened) this._fireReady();
  }
  // Spec § "setRequestHeader()": only valid in OPENED with the send flag unset; the
  // name must be a token and the (whitespace-normalized) value a valid header value,
  // else SyntaxError. A forbidden request-header is silently dropped; a repeated
  // name is combined with `, `.
  setRequestHeader(name, value) {
    // Both arguments are required (WebIDL): calling with fewer throws a TypeError
    // before any state / token check.
    if (arguments.length < 2) {
      throw new TypeError(`Failed to execute 'setRequestHeader' on 'XMLHttpRequest': 2 arguments required, but only ${arguments.length} present.`);
    }
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
    if (isForbiddenHeader(lower, v)) return;
    const existing = findHeaderKey(this._headers, lower);
    if (existing != null) this._headers[existing] += ', ' + v;
    else this._headers[n] = v;
  }
  getResponseHeader(name) {
    const v = this._respHeaders[String(name).toLowerCase()];
    return v == null ? null : v;
  }
  getAllResponseHeaders() {
    // Fetch "sort and combine": _respHeaders already holds lowercased names with
    // duplicate values combined and Set-Cookie filtered (see _completeWith). Sort the
    // names and emit "name: value\r\n" per entry (trailing CRLF on each, including the
    // last). The sort key is the UPPERCASED name — what real browsers compare, which
    // (unlike lowercasing) ranks `_`/`~` AFTER the letters, so `__custom` sorts last
    // (getallresponseheaders). A bare byte sort of the lowercased name would wrongly
    // rank it first.
    return Object.keys(this._respHeaders)
      .sort((a, b) => { const A = a.toUpperCase(), B = b.toUpperCase(); return A < B ? -1 : A > B ? 1 : 0; })
      .map(k => k + ': ' + this._respHeaders[k] + '\r\n')
      .join('');
  }
  // Spec § "overrideMimeType()": parse + record the override MIME type. Its type then
  // becomes the final MIME type (driving the responseXML decision) and its charset, if
  // any, the final encoding — both winning over the response's Content-Type. (Persists
  // across open() per spec — only a fresh object resets it.)
  overrideMimeType(mime) {
    // Spec § "overrideMimeType()": throws InvalidStateError once the response is being
    // delivered — state LOADING or DONE (overridemimetype-done-state).
    if (this.readyState === 3 || this.readyState === 4) {
      throw new globalThis.DOMException("Failed to execute 'overrideMimeType' on 'XMLHttpRequest': MimeType cannot be overridden because the state is DONE.", 'InvalidStateError');
    }
    this._overrideMime = parseOverrideMime(mime);
  }
  abort() {
    // Spec § "abort()": the request-error steps (readyState→DONE, abort + loadend
    // events) fire ONLY for an in-flight request — OPENED with the send flag set,
    // HEADERS_RECEIVED, or LOADING. On a fresh / just-opened (no send flag) request
    // abort() is a no-op (send-data-unexpected-tostring: abort() during body
    // stringification, before the send flag, must not change state); a DONE request
    // resets silently to UNSENT. Any ongoing fetch / timeout is cancelled either way.
    // abort() step 3 (DONE → UNSENT, response → network error): runs after the request
    // -error steps too, so the END state of an aborted request is UNSENT (0), not DONE —
    // a read after abort() must not expose the completed response (loadstart-and-state).
    const resetToUnsent = () => { this.readyState = 0; this._clearResponse(); };
    const sending = (this.readyState === 1 && this._sendFlag) || this.readyState === 2 || this.readyState === 3;
    if (sending) {
      this._terminate('abort');
      // Step 3 runs only "if state is DONE": an abort/loadend handler that re-open()ed
      // (readyState back to 1) must NOT be clobbered back to UNSENT (open-during-abort).
      if (this.readyState === 4) resetToUnsent();
      return;
    }
    if (this._timeoutId != null) { try { globalThis.clearTimeout(this._timeoutId); } catch (_) {} this._timeoutId = null; }
    if (this._asyncFetchHandle && typeof globalThis.__csim_rackFetchAsyncAbort === 'function') {
      try { globalThis.__csim_rackFetchAsyncAbort(this._asyncFetchHandle); } catch (_) {}
      if (globalThis.__csim_asyncFetchPending) delete globalThis.__csim_asyncFetchPending[this._asyncFetchHandle];
      this._asyncFetchHandle = 0;
    }
    if (this.readyState === 4) resetToUnsent();
  }
  // Reset the response to the network-error state (status 0, empty status text / body /
  // headers). The caller owns readyState — abort() → UNSENT(0), _terminate → DONE(4).
  // (_uploadActive is deliberately NOT touched here: _terminate reads it AFTER this to
  // decide whether to fire the upload error events.)
  _clearResponse() {
    this.status        = 0;
    this.statusText    = '';
    this._responseText = '';
    this.response      = '';
    this._responseXML  = null;
    this._respHeaders  = {};
  }
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
    // Reset to the network-error response (status 0, empty statusText / body / headers)
    // BEFORE firing the DONE readystatechange — a handler reading statusText / response
    // during that event must see the cleared values (abort-during-loading).
    this._aborted   = true;
    this.readyState = 4;
    this._clearResponse();
    this._fireReady();
    // Request-error steps: the upload object's error+loadend fire FIRST and only when an
    // upload is still in progress (the upload-complete flag is unset) — a body-less GET
    // fires none (abort-after-send), an interrupted upload fires them before the request's
    // own events (abort-during-upload: upload.abort/loadend precede abort/loadend).
    if (this._uploadActive) {
      this._uploadActive = false;
      this.upload._fire(reason);
      this.upload._fire('loadend');
    }
    this._fireEvent(reason);
    this._fireEvent('loadend');
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
      // A malformed percent-escape in the userinfo (the URL parser keeps `%` verbatim)
      // makes decodeURIComponent throw — fall back to the raw value rather than letting
      // the throw skip BOTH the credentials and the userinfo-stripping below.
      const decode = (s) => { try { return decodeURIComponent(s); } catch (_) { return s; } };
      if (pu.username) urlUser = decode(pu.username);
      if (pu.password) urlPass = decode(pu.password);
      if (pu.username || pu.password) {   // strip userinfo from the request URL (it rides Authorization instead)
        pu.username = ''; pu.password = '';
        this._url = pu.href;
      }
    } catch (_) {}
    const user = this._username != null ? this._username : urlUser;
    const pass = this._password != null ? this._password : urlPass;
    if (user == null && pass == null) return;
    if (findHeaderKey(this._headers, 'authorization') != null) return;
    this._headers['Authorization'] = 'Basic ' + globalThis.btoa((user || '') + ':' + (pass || ''));
  }
  send(body) {
    // The XMLHttpRequestBodyInit BufferSource is NOT [AllowShared]: a SharedArrayBuffer
    // (or a view backed by one) fails WebIDL conversion → TypeError, before anything else
    // (send-data-sharedarraybuffer). A SharedArrayBuffer is not an ArrayBuffer, so the
    // isBodyInit() coercion below would otherwise stringify it instead of rejecting. The
    // `SharedArrayBuffer` global isn't exposed (no cross-origin isolation), so brand-check
    // via the toStringTag rather than `instanceof`.
    const isShared = (b) => Object.prototype.toString.call(b) === '[object SharedArrayBuffer]';
    if (isShared(body) || (globalThis.ArrayBuffer.isView && globalThis.ArrayBuffer.isView(body) && isShared(body.buffer)))
      throw new TypeError("Failed to execute 'send' on 'XMLHttpRequest': The provided value must not be backed by a SharedArrayBuffer.");
    // WebIDL union conversion happens BEFORE the send() algorithm: a body that is not a
    // recognized BodyInit (Document / Blob / FormData / URLSearchParams / ArrayBuffer
    // [View] / string / null) is coerced to a USVString now. Its toString() may re-enter
    // this XHR (abort / open / send) — and that must take effect before the send flag is
    // set and before the state check (send-data-unexpected-tostring).
    if (body != null && !isBodyInit(body)) body = String(body);
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
    // The upload events fire only when the request has a NON-EMPTY body: send(null)
    // and send("") (and a GET/HEAD whose body was just dropped) fire none of them
    // (send-entity-body-none / -empty / -get-head). When they do fire, the one
    // `xhr.upload` loadstart precedes the wire exchange; defer one task so a listener
    // attached just before send() catches it.
    const hasBody = body != null;
    // Extract the request body NOW, synchronously (send() "extract a body"): serialize
    // a Document / FormData / URLSearchParams at send() time — and settle the
    // Content-Type / charset headers it implies — so a later mutation of the live
    // object can't change what is sent (send-entity-body-document-bogus mutates the
    // same Document between async sends; a deferred serialize captured the final state).
    const bodyStr = hasBody ? this._serializeBody(body) : null;
    // Upload events fire only for a NON-EMPTY body. _approxBodyLength knows the size of
    // a string / Blob / ArrayBuffer; for a FormData / URLSearchParams / Document (which
    // it can't measure) fall back to the serialized length, so a non-empty multipart /
    // urlencoded / document body still reports upload progress instead of none.
    const total   = hasBody ? (this._approxBodyLength(body) || (bodyStr ? bodyStr.length : 0)) : 0;
    const hasUpload = total > 0;
    // send() fires `loadstart` on the XHR (0/0) SYNCHRONOUSLY — it must precede a same-tick
    // abort() (abort-after-send: loadstart comes before abort), and the upload object's
    // loadstart (loadstart-and-state / send-redirect-post-upload order). A synchronous send
    // fires neither (it goes straight to DONE → load → loadend; send-sync-no-response-event
    // -order). A loadstart handler may abort() mid-way → bail before the upload loadstart.
    // An upload is "in progress" (upload-complete flag unset) from send() until the body
    // has been transmitted — i.e. until _doFetch runs. A same-tick abort() before then
    // fires the upload error events; a body-less request never has an active upload.
    // (A timeout can't interrupt the upload here — the buffered _doFetch sends the whole
    // body at t=0, before any timeout > 0 fires.)
    this._uploadActive = hasUpload;
    if (this._async) {
      this._fireEvent('loadstart', {loaded: 0, total: 0, lengthComputable: false});
      if (this._aborted) return;
      if (hasUpload) this.upload._fire('loadstart', {loaded: 0, total, lengthComputable: true});
      if (this._aborted) return;
    }
    // The fetch is deferred (async) / parked (Discourse slow-upload shim) / run now (sync);
    // a same-tick abort() leaves _aborted set, so the deferred fetch no-ops.
    const doFetch = () => { if (!this._aborted) this._doFetch(bodyStr, hasUpload ? total : null); };
    // CDP-throttle shim for Discourse `cdp.with_slow_upload`: the composer's `isUploading`
    // flag is set synchronously before `send()`, so parking only the response side keeps
    // `#file-uploading` observable for the test assertion.
    const isWrite = hasBody && (this._method === 'POST' || this._method === 'PUT' || this._method === 'PATCH');
    if (globalThis.__csimSlowUploadActive && isWrite) {
      globalThis.__csimSlowUploadPending.push(doFetch);
      return;
    }
    if (this._async) {
      globalThis.setTimeout(doFetch, 0);
    } else {
      doFetch();
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
  _doFetch(bodyStr, uploadTotal) {
    // `bodyStr` is the body already serialized in send() (a string, or null) — NOT the
    // live object; serialization is never deferred to here.
    if (this._aborted) return;
    // Fetch appends a default `Accept: */*` and an `Accept-Language` when the
    // author set neither (XHR's defaults differ from a document navigation's
    // richer Accept). Author-set values are left untouched.
    if (findHeaderKey(this._headers, 'accept') == null) this._headers['Accept'] = '*/*';
    if (findHeaderKey(this._headers, 'accept-language') == null) this._headers['Accept-Language'] = 'en-US,en;q=0.9';
    if (this._timeoutId != null) { try { globalThis.clearTimeout(this._timeoutId); } catch (_) {} this._timeoutId = null; }
    // The upload's completion events are fired from the fetch OUTCOME (see
    // _fireUploadComplete), not optimistically here: our Rack call buffers the whole
    // body, but whether the upload "succeeded" (progress/load/loadend) or hit a network
    // error (error/loadend) isn't known until the fetch returns — a request to an
    // unreachable host must fire upload.error, not upload.load
    // (send-network-error-async-events). Remember the body size for those events.
    this._uploadTotal = uploadTotal | 0;
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
      const headersJson = JSON.stringify(this._headers || {});
      const result = globalThis.__csim_rackFetchAsync(this._method, this._url, bodyStr, headersJson);
      if (result && typeof result === 'object') {
        if (typeof result.handle === 'number' && result.handle > 0) {
          this._asyncFetchHandle = result.handle;
          if (!globalThis.__csim_asyncFetchPending) globalThis.__csim_asyncFetchPending = {};
          globalThis.__csim_asyncFetchPending[result.handle] = this;
          // The body is sent once the long-poll connection is parked; complete the
          // upload now so a later abort during the held response fires no upload error.
          this._fireUploadComplete(true);
          return;
        }
        this._completeWith(result);
        return;
      }
    }
    if (typeof this._url === 'string' && /^data:/i.test(this._url)) {
      // `data:[<mediatype>][;base64],<data>` (RFC 2397) — synthesize a 200 so an
      // XHR GET to a data: URL works (declarative-shadow-dom-opt-in's XHR subtest).
      // A HEAD response carries the headers but no body (data-uri HEAD subtest).
      const dr = parseDataUrl(this._url);
      if (dr && this._method === 'HEAD') { dr.body = ''; dr.body_b64 = ''; }
      this._completeWith(dr);
      return;
    }
    if (typeof this._url === 'string' && this._url.startsWith('blob:')) {
      // A blob: URL only answers GET (the snapshot is only taken for GET in
      // open()); any other method, a revoked URL, or an appended query/path is a
      // network error: status 0 and an `error` event, per the fetch spec.
      const r = this._blobSnapshot;
      if (!r) {
        // Route through the shared terminal-error path: an async request fires
        // error/loadend, a SYNCHRONOUS one throws NetworkError (rather than firing
        // events) — the same rule every other failed fetch obeys.
        this._completeWith(null);
        return;
      }
      const full        = r.bytes;
      const contentType = r.type;
      // A blob: GET honours a single byte-range (blob-range): a satisfiable Range → 206 +
      // the sliced body + Content-Range; a Range header that's present but malformed OR
      // unsatisfiable is a network error (blob URLs don't 416); no Range → 200.
      const rangeKey    = findHeaderKey(this._headers, 'range');
      let bytes = full, contentRange = null;
      if (rangeKey) {
        const range = parseByteRange(this._headers[rangeKey], full.length);
        if (!range) { this._completeWith(null); return; }
        bytes = full.slice(range.start, range.end + 1);
        contentRange = 'bytes ' + range.start + '-' + range.end + '/' + full.length;
        this.status = 206; this.statusText = 'Partial Content';
      } else {
        this.status = 200; this.statusText = 'OK';
      }
      this.responseURL  = this._url;
      this._responseText = bytes;
      // json parses the UTF-8 decode of the raw bytes (a blob: URL holding UTF-8 JSON
      // with multibyte chars), consistent with the rack path — not the latin-1 byteStr.
      const jsonText = this.responseType === 'json' ? utf8DecodeBytes(bytes) : undefined;
      this.response     = responseValue(this.responseType, bytes, bytes, contentType, jsonText);
      // A fetched blob: URL exposes Content-Type (the blob's own type, possibly empty) +
      // Content-Length (request-content-length); a ranged response also has Content-Range.
      this._respHeaders = {'content-type': contentType, 'content-length': String(bytes.length)};
      if (contentRange) this._respHeaders['content-range'] = contentRange;
      // (No upload completion here: a blob: URL only answers GET, whose body send()
      // drops, so a blob: request never has an active upload.)
      this.readyState   = 4;
      this._fireReady();
      const progress = {loaded: bytes.length, total: bytes.length, lengthComputable: true};
      this._fireEvent('load', progress);
      this._fireEvent('loadend', progress);
      return;
    }
    let resp;
    try {
      // XHR has no `omit`: withCredentials true → `include`, false → `same-origin`
      // (send same-origin cookies, none cross-origin) — the credentials mode rack_fetch wants.
      resp = globalThis.__rackFetch(this._method, this._url, bodyStr, this._headers, 'follow', 'cors', this._withCredentials ? 'include' : 'same-origin');
    } catch (_) { resp = null; }
    this._completeWith(resp);
  }
  // Fire the upload object's terminal events once the fetch outcome is known: on
  // success progress→load→loadend (the buffered body is fully sent), on a network
  // error error→loadend. No-op for a body-less request (the upload was never active)
  // and for a synchronous request (which fires no upload events at all). Clears
  // _uploadActive so a later abort/timeout during the response fires none
  // (abort-during-loading).
  _fireUploadComplete(success) {
    if (!this._uploadActive) return;
    this._uploadActive = false;
    if (!this._async) return;
    if (success) {
      const t = this._uploadTotal | 0;
      const ev = {loaded: t, total: t, lengthComputable: t > 0};
      this.upload._fire('progress', ev);
      this.upload._fire('load',     ev);
      this.upload._fire('loadend',  ev);
    } else {
      // Request-error steps fire the upload error/loadend "with 0 and 0" (loaded=0,
      // total=0, lengthComputable=false) — same shape as _terminate's abort/timeout.
      this.upload._fire('error');
      this.upload._fire('loadend');
    }
  }
  _completeWith(resp) {
    if (this._aborted) return;
    if (!resp) {
      this.readyState = 4;
      this.status     = 0;
      // A synchronous request that hits a network error throws NetworkError from
      // send() (no events fire); an async one reports it via the error event.
      if (!this._async) {
        this._uploadActive = false;   // sync fires no upload events, but clear the flag
        throw new globalThis.DOMException("Failed to execute 'send' on 'XMLHttpRequest': Failed to load.", 'NetworkError');
      }
      this._fireReady();
      // An interrupted upload reports error/loadend AFTER the DONE readystatechange
      // and BEFORE the request's own error (send-network-error-async-events).
      this._fireUploadComplete(false);
      this._fireEvent('error');
      this._fireEvent('loadend');
      return;
    }
    // The body is fully sent the moment the fetch succeeds — fire the upload's
    // progress/load/loadend before the response's readystatechange sequence
    // (loadstart-and-state / send-redirect-post-upload order). A handler here may
    // abort() (the cancel-on-upload-complete pattern) → _terminate already fired
    // DONE/abort/loadend, so bail before resuming the response.
    this._fireUploadComplete(true);
    if (this._aborted) return;
    this.status       = resp.status || 200;
    this.statusText   = resp.statusText || '';
    this.responseURL  = resp.url || this._url;
    this._responseText = resp.body == null ? '' : String(resp.body);
    const headers     = resp.headers || {};
    // The exposed response header map FIRST: lowercased names (so every lookup is
    // case-insensitive — a `CONTENT-TYPE` / `Content-type` is found too), minus the
    // forbidden response-header names (`Set-Cookie` / `Set-Cookie2`) that
    // getResponseHeader / getAllResponseHeaders never reveal (getresponseheader-cookies).
    const norm = {};
    for (const k of Object.keys(headers)) {
      const lower = k.toLowerCase();
      if (FORBIDDEN_RESPONSE_HEADERS.has(lower)) continue;
      norm[lower] = String(headers[k]);
    }
    this._respHeaders = norm;
    const contentType = norm['content-type'] || '';
    // "Get a final MIME type": an overrideMimeType() type wins over the response's; an
    // absent / unparseable type (no type/subtype, e.g. '', 'bogus', 'application')
    // defaults to text/xml — so it parses as XML (responsexml-media-type), whereas a
    // valid non-XML type (text/plain, text/xsl) does not.
    let ctMime = String(contentType).split(';')[0].trim().toLowerCase();
    if (!/^[^\s/]+\/[^\s/]+$/.test(ctMime)) ctMime = 'text/xml';
    const finalMime = this._overrideMime ? this._overrideMime.essence : ctMime;
    const isXml     = /(\+xml|\/xml)$/.test(finalMime) || finalMime === 'image/svg+xml';
    // For arraybuffer/blob responseType, `bytes` is the raw latin-1 byte string so
    // binary payloads survive the engine's UTF-8 string boundary; text/json keep the
    // decoded string.
    const needsBytes = this.responseType === 'arraybuffer' || this.responseType === 'blob';
    let bytes        = this._responseText;
    let rawBytes     = null;
    // "Get a text response": when the raw bytes are provided (a non-UTF-8 charset / XML
    // response — browser.rb gates `body_b64`), decode them with the final encoding:
    // override charset → Content-Type charset → (default responseType + XML) the XML
    // prolog's encoding → UTF-8; a BOM overrides. Otherwise the body is already the
    // UTF-8 fast-path text. Done before `response`/`responseXML` so both see it.
    if (typeof resp.body_b64 === 'string') {
      rawBytes = '';
      try { rawBytes = globalThis.atob(resp.body_b64); } catch (_) {}
      bytes = rawBytes;
      let label = (this._overrideMime && this._overrideMime.charset) || charsetOf(contentType);
      if (label == null) {
        // No explicit charset: the default responseType sniffs only an XML prolog (XHR
        // "get a text response" step 3); a 'document' response sniffs the content the
        // way its parser would — an XML prolog, or an HTML <meta charset>.
        if (this.responseType === '' && isXml) label = sniffXmlEncoding(rawBytes);
        else if (this.responseType === 'document') {
          label = isXml ? sniffXmlEncoding(rawBytes) : sniffHtmlMetaEncoding(rawBytes);
        }
      }
      this._responseText = decodeResponseBytes(rawBytes, label);
    }
    // json decodes the raw bytes as UTF-8 (not the charset-decoded text); on the UTF-8
    // fast path (no body_b64) the text already IS that decode. Only computed for json —
    // a non-json response must not pay a redundant full-body decode.
    const jsonText = (this.responseType === 'json' && rawBytes != null) ? utf8DecodeBytes(rawBytes) : this._responseText;
    // A `blob` response's type is the "final MIME type" (the same one decoding/parsing
    // use) — so an absent/unparseable Content-Type defaults to text/xml, NOT octet
    // -stream (overridemimetype-blob). finalMime is the only thing the blob case reads.
    this.response     = responseValue(this.responseType, this._responseText, bytes, finalMime, jsonText);
    // `responseXML` (and `response` for responseType 'document'): parse the body into a
    // Document per the XHR "document response" steps. responseType 'document' parses
    // HTML or XML; the DEFAULT responseType ('') parses ONLY XML-family MIME types (an
    // HTML response leaves responseXML null under '' — so a normal Turbo/AJAX HTML
    // fetch never pays a parse it won't read). DOMParser does NOT convert declarative
    // shadow roots (only setHTMLUnsafe does), which is the XHR behaviour the opt-in
    // test asserts.
    // XHR "document response": the document is built only when the final MIME is
    // HTML or an XML family type. responseType 'document' with any OTHER MIME (e.g.
    // text/plain) yields a null document, NOT an HTML-parsed one (responsexml
    // -invalid-type). The DEFAULT type ('') only ever parses XML.
    const isHtmlMime = finalMime === 'text/html';
    const wantsDoc = (this.responseType === 'document' && (isHtmlMime || isXml)) ||
                     (this.responseType === '' && isXml);
    if (wantsDoc && typeof globalThis.DOMParser === 'function') {
      const mime = finalMime === 'application/xhtml+xml' ? 'application/xhtml+xml'
                 : (finalMime === 'image/svg+xml' ? 'image/svg+xml'
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
    }
    // For responseType 'document' the `response` value IS the document — including
    // the null left when the MIME wasn't HTML/XML or the parse failed (so a
    // text/plain document response is null, not the decoded text).
    if (this._responseType === 'document') this.response = this._responseXML;
    // A synchronous request transitions straight to DONE — it fires no HEADERS_RECEIVED
    // / LOADING readystatechange (abort-during-done sync expects [1, 4], not [1,2,3,4]).
    // A readystatechange handler may abort() mid-sequence (abort-during-headers-received
    // / -loading): _terminate already fired its own DONE/abort/loadend, so bail rather
    // than resume and re-fire DONE + load with the stale response.
    const total = this._responseText.length;
    if (this._async) {
      this.readyState = 2; this._fireReady();
      if (this._aborted) return;
      // LOADING is entered only as response BYTES arrive; a response with no entity
      // body goes HEADERS_RECEIVED → (end-of-body progress) → DONE, skipping LOADING
      // (send-no-response-event-order expects [2, progress, 4], not [2, 3, progress, 4]).
      // The signal is the received byte count, NOT the decoded char count — a binary /
      // arraybuffer or BOM-only body has bytes but decodes to '' (which still entered
      // LOADING in a real browser).
      if (bytes.length > 0) {
        this.readyState = 3; this._fireReady();
        if (this._aborted) return;
      }
    }
    // Fire `progress` between HEADERS_RECEIVED and DONE so callers
    // that key off `onprogress` to read `responseText` as it streams
    // (Discourse's MessageBus chunked-frame parser, EventSource-shape
    // polyfills) see the data before the response transitions to
    // DONE. Our Rack-call buffers the body, so a single full-body
    // progress matches what real browsers emit for non-chunked
    // responses anyway (the spec only mandates "at least once").
    // A synchronous request fires no progress events (sync-no-progress) — progress is for
    // async consumers reading responseText as it streams.
    const progress = {loaded: total, total, lengthComputable: total > 0};
    if (this._async) this._fireEvent('progress', progress);
    if (this._aborted) return;   // a progress handler may have abort()ed (fires its own DONE/abort/loadend)
    this.readyState = 4; this._fireReady();
    // A DONE readystatechange handler may abort() — the sending-branch abort sets _aborted,
    // the DONE-branch one resets readyState to 0 — either way bail before load/loadend.
    if (this._aborted || this.readyState !== 4) return;
    this._fireEvent('load', progress);
    this._fireEvent('loadend', progress);
  }
  _serializeBody(body) {
    // serializeRequestBody flags the UTF-8-encoded text bodies (string / Document /
    // URLSearchParams) whose author Content-Type charset XHR forces to UTF-8; Blob
    // (opaque bytes) and FormData (multipart, no charset) keep the author type
    // verbatim. We consume that flag rather than re-deriving the body type here.
    const { body: out, b64, charsetFixable } = serializeRequestBody(body, this._headers);
    if (b64) this._headers['X-Csim-Body-B64'] = '1';
    if (charsetFixable) fixContentTypeCharset(this._headers);
    return out;
  }
  // `readystatechange` flows through dispatchWithOnHandler too — the
  // `onreadystatechange` IDL slot reads through it once, so we don't
  // double-fire (which used to re-eval Rails-UJS's script response and
  // toggle visibility back to hidden).
  _fireReady() { this._fireEvent('readystatechange'); }
  _fireEvent(type, extra) {
    // Every XHR event EXCEPT readystatechange is a ProgressEvent (loadstart / progress /
    // load / loadend / error / abort / timeout) — `e instanceof ProgressEvent` must hold
    // even when no byte counts are supplied (event-load / -loadend / -error / -abort / …).
    const evt = type === 'readystatechange' ? new Event(type) : new ProgressEvent(type, extra || {});
    dispatchWithOnHandler(this, evt);
  }
}

globalThis.XMLHttpRequest = XMLHttpRequest;
// XMLHttpRequestUpload is a global interface too — code branches on
// `e.target instanceof XMLHttpRequestUpload` to label upload events (the WPT
// xmlhttprequest-event-order recorder does exactly this), which throws if the
// constructor isn't exposed.
globalThis.XMLHttpRequestUpload = XMLHttpRequestUpload;

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
