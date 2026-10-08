// XMLHttpRequest (XMLHttpRequest Standard), generated from its IDL — Rails-UJS / jQuery.ajax / many older libraries lean
// on it. A request round-trips a Rack call through the `__rackFetch` host fn: the fetch itself is synchronous (the
// engine's attach() blocks), its readystatechange / load events DEFERRED through the virtual clock so a call site's
// "then" / .done handlers run after the current frame unwinds — the listener order libraries assume of an async one.
// Its state is its internal slots; its upload's and its own events fire from module functions, never prototype methods.

import { bytesToArrayBuffer, bytesToLatin1, latin1ToBytes, utf8DecodeBytes, utf8Length } from './bytes.js';
import { Blob, blobSize, isBlob, resolveBlobBytes } from './blob.js';
import { processDataUrl }          from './data-url.js';
import { serializeRequestBody, fixContentTypeCharset, findHeaderKey, isArrayBufferBody } from './request-body.js';
import { getEncoding } from './encodings.js';
import { DOMException, Event, ProgressEvent, EventTarget, dispatchWithOnHandler, installEventHandlerAttrs } from './events.js';
import { FORBIDDEN_METHODS, FORBIDDEN_RESPONSE_HEADERS, isForbiddenRequestHeader } from './header-rules.js';
import { buildSwRequest } from './sw-client.js';
import { parseMimeType } from './mime.js';
import { documentElementOf } from './document-tree.js';
import { PLATFORM, constructedBy, makeSlots, registerInterface, slotsOf } from './webidl.js';
import { installXMLHttpRequest, installXMLHttpRequestEventTarget, installXMLHttpRequestUpload } from './generated/bindings.js';
import { URL } from './url.js';
import { parseDocument } from './dom-parser.js';
import { location } from './location.js';

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
// DOMParser marks a non-well-formed XML parse with a <parsererror> root in this
// namespace; XHR responseXML maps that to null.
const PARSERERROR_NS = 'http://www.mozilla.org/newlayout/xml/parsererror.xml';
// Methods normalized to uppercase by open() when matched case-insensitively
// (Fetch "normalize a method"). PATCH is deliberately NOT here, so `open('patCH')`
// keeps its case — open-method-case-sensitive asserts exactly that.
const NORMALIZED_METHODS = ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'POST', 'PUT'];

// Decode raw response bytes (a latin-1 byte string from `body_bytes`) into responseText
// per the WHATWG "decode" algorithm: a leading BOM (UTF-8 / UTF-16BE / UTF-16LE)
// overrides `label` and is removed; otherwise `label` (the final encoding) is used,
// defaulting to UTF-8. The native decoder (TextDecoder's own — not a TextDecoder a page
// may have replaced) is the WHATWG decoder, so every Encoding-standard label is handled
// exactly — windows-1252, UTF-16, the `replacement` family (any bytes → one U+FFFD) —
// including the BOM strip. An unknown / invalid label (`charset=bogus`) is a decode
// failure → UTF-8 fallback.
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
  return globalThis.__dom.textDecode(enc || 'utf-8', arr, false, false) ?? globalThis.__dom.textDecode('utf-8', arr, false, false);
}


// A response read as a document would be (XHR "document response", natively — `__dom.decodeDocument`): a BOM, else
// the `charset` (the override MIME type's, else the Content-Type's), else — an HTML one — a `<meta charset>` in the
// first 1024 bytes, an XML one its XML declaration's `encoding`, else UTF-8. → [text, encoding name].
function decodeAsDocument(bytes, finalMime, label) {
  return globalThis.__dom.decodeDocument(bytes, label == null ? finalMime : finalMime + ';charset=' + label, null, true);
}

// XHR overrideMimeType: parse `mime`; on parse failure the override MIME type is
// application/octet-stream with NO charset (a `;charset=…` on an otherwise-invalid
// type is discarded). Returns { essence, charset|null }.
function parseOverrideMime(mime) {
  const parsed = parseMimeType(mime);
  if (!parsed) return { essence: 'application/octet-stream', charset: null };
  const cs = parsed.parameters.get('charset');
  return { essence: parsed.essence, charset: cs == null ? null : cs };
}

// Decode a data: URL into a synthetic Rack-shaped response via the shared WHATWG data:
// URL processor. Returns null for a malformed data: URL (→ XHR error). The raw bytes ride
// `body_bytes` so completeWith decodes them with the final encoding (an overrideMimeType()
// charset / the media-type charset).
function parseDataUrl(url) {
  const parsed = processDataUrl(url);
  if (!parsed) return null;
  return { status: 200, statusText: 'OK', url: String(url), body: parsed.body, body_bytes: latin1ToBytes(parsed.body), headers: { 'content-type': parsed.mimeType } };
}

// Build `xhr.response` for any `responseType`. `text` is the UTF-8
// string form (what `responseText` carries); `bytes` is the latin-1
// byte string (raw bytes preserved across the engine
// string boundary). The two coincide for synthetic blob: responses
// and diverge for binary HTTP bodies, where `bytes` comes from the
// response's `body_bytes`.
// `blobType` is the Blob response's MIME — the caller passes the "final MIME type"
// (the rack path) or the data:/blob: URL's own type, both already the right "final"
// value; only the `blob` branch reads it.
function responseValue(responseType, text, bytes, blobType, jsonText) {
  switch (responseType) {
    case 'arraybuffer': return bytesToArrayBuffer(bytes);
    // `bytes` is a latin-1 BYTE string (raw response bytes). A string Blob part is
    // UTF-8-encoded per spec, which would inflate a binary payload (0x89 → 0xC2 0x89),
    // so hand the Blob the bytes as an ArrayBuffer to preserve them verbatim.
    case 'blob':        return new Blob([bytesToArrayBuffer(bytes)], {type: blobType || 'application/octet-stream'});
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

// ── XMLHttpRequestEventTarget / XMLHttpRequestUpload ──
// The event target both an XHR and its `upload` are: no constructor of its own (Illegal constructor), its seven
// progress event handlers.
export class XMLHttpRequestEventTarget extends EventTarget {
  constructor(token) {
    constructedBy(PLATFORM, token, 'XMLHttpRequestEventTarget');
    super();
  }
}
registerInterface('XMLHttpRequestEventTarget', (o) => slotsOf(o, 'XMLHttpRequest') !== undefined || slotsOf(o, 'XMLHttpRequestUpload') !== undefined);
installXMLHttpRequestEventTarget(XMLHttpRequestEventTarget, {
  installEventHandlers: (proto, names, isSelf) => installEventHandlerAttrs(proto, names, null, isSelf)
});
// `xhr.upload`: Uppy's XHRUpload wrapper, jQuery 1.x's `xhr.upload.onprogress = …`, axios read its byte counts — it
// fires loadstart / progress / load / loadend with the request body's total length around the Rack call.
export class XMLHttpRequestUpload extends XMLHttpRequestEventTarget {
  constructor(token) {
    constructedBy(PLATFORM, token, 'XMLHttpRequestUpload');
    super(PLATFORM);
    makeSlots(this, 'XMLHttpRequestUpload', {});
  }
}
registerInterface('XMLHttpRequestUpload', (o) => slotsOf(o, 'XMLHttpRequestUpload') !== undefined);
installXMLHttpRequestUpload(XMLHttpRequestUpload, {});

// Every XHR event but readystatechange is a ProgressEvent (loadstart / progress / load / loadend / error / abort /
// timeout) — `e instanceof ProgressEvent` holds even with no byte counts (event-load / -loadend / -error / -abort / …).
// It goes through dispatchWithOnHandler, which the `on<type>` attribute reads through once — so it fires once (a double
// fire re-evaluated Rails-UJS's script response and toggled visibility back to hidden).
function fire(target, type, extra) {
  dispatchWithOnHandler(target, type === 'readystatechange' ? new Event(type) : new ProgressEvent(type, extra || {}));
}

// ── XMLHttpRequest ──
const xhrOf = (o) => slotsOf(o, 'XMLHttpRequest');
registerInterface('XMLHttpRequest', (o) => xhrOf(o) !== undefined);
export class XMLHttpRequest extends XMLHttpRequestEventTarget {
  constructor() {
    super(PLATFORM);
    // Its state (XHR §3): the request — method, URL, its credentials, author headers, the async / send / upload-active
    // flags, the timeout and its timer, a blob: URL's bytes referenced at open() — and the response: its state, status,
    // URL, headers (lowercased, combined, set-cookie dropped), text, the value `response` is, the document, the
    // override MIME type, and the in-flight long poll / delayed delivery. `generation` counts its open()s: a fetch, a
    // delivery or a worker's answer of an earlier one is stale.
    makeSlots(this, 'XMLHttpRequest', {
      readyState: 0, status: 0, statusText: '', responseText: '', response: '', responseType: '', responseURL: '',
      responseXML: null, timeout: 0, withCredentials: false, upload: new XMLHttpRequestUpload(PLATFORM),
      method: 'GET', url: '', async: true, username: null, password: null, headers: {}, respHeaders: {},
      aborted: false, sendFlag: false, uploadActive: false, uploadTotal: 0, timeoutId: null, sendStart: null,
      deliveryTimer: null, overrideMime: null, blobSnapshot: null, asyncFetchHandle: 0, timingStart: 0, generation: 0,
      fragment: ''
    });
  }
}
// `responseType` cannot change for a synchronous request from a document, nor once the response is LOADING / DONE;
// neither can `timeout` for the former. (Allowed in a worker.)
const inDocument = () => !globalThis.__csim_isWorker;
const XHR_PREFIX = (member) => `Failed to execute '${member}' on 'XMLHttpRequest': `;
installXMLHttpRequest(XMLHttpRequest, {
  get_readyState: (o) => xhrOf(o).readyState,
  // open(method, url) is open(method, url, true) (XHR §3.5.1).
  open_method_url: (o, method, url) => open(o, method, url, true, null, null),
  open_method_url_async_username_password: (o, method, url, async, username, password) => open(o, method, url, async, username, password),
  setRequestHeader(o, name, value) {
    const x = xhrOf(o);
    if (x.readyState !== 1 || x.sendFlag) {
      throw new DOMException(XHR_PREFIX('setRequestHeader') + "The object's state must be OPENED.", 'InvalidStateError');
    }
    // (…the value normalized: leading and trailing HTTP whitespace stripped; a non-token name or a value with NUL / CR /
    // LF a SyntaxError; a forbidden request-header dropped; a repeated name combined with ", ")
    const v = value.replace(/^[\t\n\r ]+/, '').replace(/[\t\n\r ]+$/, '');
    if (!HTTP_TOKEN.test(name)) {
      throw new DOMException(XHR_PREFIX('setRequestHeader') + `'${name}' is not a valid HTTP header field name.`, 'SyntaxError');
    }
    if (/[\0\n\r]/.test(v)) {
      throw new DOMException(XHR_PREFIX('setRequestHeader') + `'${value}' is not a valid HTTP header field value.`, 'SyntaxError');
    }
    const lower = name.toLowerCase();
    if (isForbiddenRequestHeader(lower, v)) return;
    const existing = findHeaderKey(x.headers, lower);
    if (existing != null) x.headers[existing] += ', ' + v;
    else x.headers[name] = v;
  },
  get_timeout: (o) => xhrOf(o).timeout,
  // A changed timeout is measured against the send again: one already elapsed fires at once, a longer one extends it
  // (xmlhttprequest-timeout-overrides*).
  set_timeout(o, v) {
    const x = xhrOf(o);
    if (!x.async && inDocument() && x.readyState !== 0) {
      throw new DOMException("Failed to set the 'timeout' property on 'XMLHttpRequest': Timeouts cannot be set for synchronous requests made from a document.", 'InvalidAccessError');
    }
    x.timeout = v;
    armTimeout(o, x);
  },
  get_withCredentials: (o) => xhrOf(o).withCredentials,
  // (…only while UNSENT or OPENED with the send flag unset — loadstart-and-state sets it during loadstart)
  set_withCredentials(o, v) {
    const x = xhrOf(o);
    if ((x.readyState !== 0 && x.readyState !== 1) || x.sendFlag) {
      throw new DOMException("Failed to set the 'withCredentials' property on 'XMLHttpRequest': The value may only be set if the object's state is UNSENT or OPENED.", 'InvalidStateError');
    }
    x.withCredentials = v;
  },
  get_upload: (o) => xhrOf(o).upload,
  send: (o, body) => send(o, body),
  abort: (o) => abort(o),
  get_responseURL: (o) => xhrOf(o).responseURL,
  get_status: (o) => xhrOf(o).status,
  get_statusText: (o) => xhrOf(o).statusText,
  getResponseHeader(o, name) {
    const v = xhrOf(o).respHeaders[name.toLowerCase()];
    return v == null ? null : v;
  },
  // Fetch "sort and combine": the header names sorted by their UPPERCASED form — what browsers compare, which (unlike
  // lowercasing) ranks `_` / `~` AFTER the letters, so `__custom` sorts last (getallresponseheaders) — each
  // "name: value\r\n".
  getAllResponseHeaders(o) {
    const headers = xhrOf(o).respHeaders;
    return Object.keys(headers)
      .sort((a, b) => { const A = a.toUpperCase(), B = b.toUpperCase(); return A < B ? -1 : A > B ? 1 : 0; })
      .map((k) => k + ': ' + headers[k] + '\r\n')
      .join('');
  },
  // The override MIME type: the final MIME type (which decides responseXML) and, its charset given, the final encoding
  // — over the response's Content-Type. It survives open(); only once the response is LOADING / DONE does it throw
  // (overridemimetype-done-state).
  overrideMimeType(o, mime) {
    const x = xhrOf(o);
    if (x.readyState === 3 || x.readyState === 4) {
      throw new DOMException(XHR_PREFIX('overrideMimeType') + 'MimeType cannot be overridden because the state is DONE.', 'InvalidStateError');
    }
    x.overrideMime = parseOverrideMime(mime);
  },
  get_responseType: (o) => xhrOf(o).responseType,
  // (…'document' ignored where the global is no Window: a worker has no document response)
  set_responseType(o, v) {
    const x = xhrOf(o);
    if (v === 'document' && !inDocument()) return;
    if (x.readyState === 3 || x.readyState === 4) {
      throw new DOMException("Failed to set the 'responseType' property on 'XMLHttpRequest': the response type cannot be set if the object's state is LOADING or DONE.", 'InvalidStateError');
    }
    if (inDocument() && !x.async) {
      throw new DOMException("Failed to set the 'responseType' property on 'XMLHttpRequest': the response type cannot be changed for synchronous requests made from a document.", 'InvalidAccessError');
    }
    x.responseType = v;
  },
  get_response: (o) => xhrOf(o).response,
  // (…only for responseType '' or 'text' — responsexml-non-document-types — and '' until the body arrives: LOADING or
  // DONE, responseText-status)
  get_responseText(o) {
    const x = xhrOf(o);
    if (x.responseType !== '' && x.responseType !== 'text') {
      throw new DOMException("Failed to read the 'responseText' property from 'XMLHttpRequest': the value is only accessible if the object's 'responseType' is '' or 'text' (was '" + x.responseType + "').", 'InvalidStateError');
    }
    return x.readyState === 3 || x.readyState === 4 ? x.responseText : '';
  },
  // (…only for responseType '' or 'document', and null until DONE — abort-during-loading reads it at LOADING)
  get_responseXML(o) {
    const x = xhrOf(o);
    if (x.responseType !== '' && x.responseType !== 'document') {
      throw new DOMException("Failed to read the 'responseXML' property from 'XMLHttpRequest': the value is only accessible if the object's 'responseType' is '' or 'document' (was '" + x.responseType + "').", 'InvalidStateError');
    }
    return x.readyState === 4 ? x.responseXML : null;
  },
  installEventHandlers: (proto, names, isSelf) => installEventHandlerAttrs(proto, names, null, isSelf)
});

// (Re)arm the timeout timer for what remains of it since send() — 0, the next task, where it has passed.
function armTimeout(o, x) {
  clearTimer(x, 'timeoutId');
  if (!x.async || x.timeout <= 0 || x.aborted || x.readyState === 4 || !x.sendFlag) return;
  const now = typeof globalThis.__virtualNow === 'function' ? globalThis.__virtualNow() : 0;
  const remaining = Math.max(0, x.timeout - (x.sendStart != null ? now - x.sendStart : 0));
  x.timeoutId = globalThis.__csimSetTimeout(() => {
    if (x.readyState === 4 || x.aborted) return;
    terminate(o, x, 'timeout');
  }, remaining);
}
// Whether the send whose generation is `generation` is still this XHR's: not aborted, nor its XHR opened again — from a
// handler of its own events too, after which it fires none on the request opened anew.
const current = (x, generation) => !x.aborted && x.generation === generation;
function clearTimer(x, key) {
  if (x[key] != null) {
    try { globalThis.__csimClearTimeout(x[key]); } catch (_) {}
    x[key] = null;
  }
}
// A held long poll (`rack_fetch_async`) cancelled.
function cancelLongPoll(x) {
  if (x.asyncFetchHandle && typeof globalThis.__csim_rackFetchAsyncAbort === 'function') {
    try { globalThis.__csim_rackFetchAsyncAbort(x.asyncFetchHandle); } catch (_) {}
    longPolls.delete(x.asyncFetchHandle);
    x.asyncFetchHandle = 0;
  }
}

// XHR "open()" (§3.5.1), its arguments converted: the method checks FIRST (a non-token a SyntaxError, a forbidden one a
// SecurityError), then the URL parsed, then the synchronous-from-a-document check — each before any state changes, so a
// bad open() leaves the object untouched. The method is uppercased only where it case-insensitively matches one of the
// six (`patCH` keeps its case — open-method-case-sensitive).
function open(o, method, url, async, username, password) {
  const x = xhrOf(o);
  if (!HTTP_TOKEN.test(method)) {
    throw new DOMException(XHR_PREFIX('open') + `'${method}' is not a valid HTTP method.`, 'SyntaxError');
  }
  if (FORBIDDEN_METHODS.has(method.toUpperCase())) {
    throw new DOMException(XHR_PREFIX('open') + `'${method}' HTTP method is unsupported.`, 'SecurityError');
  }
  // (…a malformed URL never reaches the network — url/failure.html)
  const base = location.href || undefined;
  if (globalThis.__csim_urlIsMalformed(url, base)) {
    throw new DOMException(XHR_PREFIX('open') + 'Invalid URL', 'SyntaxError');
  }
  if (!async && inDocument() && (x.responseType !== '' || x.timeout !== 0)) {
    throw new DOMException(XHR_PREFIX('open') + 'Synchronous requests from a document must not set a responseType or a timeout.', 'InvalidAccessError');
  }
  // The request URL is resolved against the API base URL AT OPEN TIME, to an absolute URL — capturing the base as it is
  // then (a `<base>` inserted after open() does not apply: open-url-base-inserted-after-open), its query percent-encoded
  // in the DOCUMENT's encoding (open-url-encoding: `?ß` → `%DF` under windows-1252), the fragment dropped (never sent;
  // responseURL has none). Only an http(s) base resolves here: an about:blank / srcdoc frame's base is opaque, so its
  // path stays RELATIVE for the fetch layer to resolve against the inherited base, the query alone re-encoded.
  const doc = globalThis.document;
  const apiBase = (doc && doc.baseURI) || base;
  // (…the fragment kept apart: a document response's URL has it — XHR "set a document response" takes the response's URL,
  // which a redirect gives the request's fragment — where responseURL does not)
  let requestUrl = url, fragment = '';
  const parsed = /^https?:/i.test(apiBase) && globalThis.__csim_parseUrl(url, apiBase, doc && doc.characterSet);
  if (parsed && !parsed.error && parsed.href) {
    const at = parsed.href.indexOf('#');
    requestUrl = at < 0 ? parsed.href : parsed.href.slice(0, at);
    fragment = at < 0 ? '' : parsed.href.slice(at);
  } else {
    const q = url.indexOf('?');
    if (q !== -1) {
      const parsedUrl = globalThis.__csim_parseUrl(url, base, doc && doc.characterSet);
      // (…a '?' kept for an empty query: `/x?` stays `/x?`)
      if (parsedUrl && !parsedUrl.error) requestUrl = url.slice(0, q) + (parsedUrl.search || '?');
    }
  }
  // The fetch in flight terminated — its timers, a held long poll — and anything it still queued made stale; the request
  // and the response reset: a reused XHR does not expose the prior response while OPENED again. Its username /
  // password, given, override the URL's userinfo (send-authentication); a blob: GET's bytes are referenced NOW, so a
  // revokeObjectURL before send() leaves it working.
  clearTimer(x, 'timeoutId');
  clearTimer(x, 'deliveryTimer');
  cancelLongPoll(x);
  x.generation++;
  Object.assign(x, {
    method: NORMALIZED_METHODS.includes(method.toUpperCase()) ? method.toUpperCase() : method,
    url: requestUrl, fragment, async, username, password, headers: {}, aborted: false, sendFlag: false, status: 0,
    statusText: '', responseText: '', response: '', responseURL: '', responseXML: null, respHeaders: {}
  });
  x.blobSnapshot = x.method === 'GET' && url.startsWith('blob:') ? resolveBlobBytes(url) : null;
  // (…OPENED, and readystatechange, only where it was not OPENED already — open-open-send / open-send-open)
  const wasOpened = x.readyState === 1;
  x.readyState = 1;
  if (!wasOpened) fire(o, 'readystatechange');
}

// XHR "abort()" (§3.5.7): the request-error steps (DONE, abort, loadend) only for a request in flight — OPENED with the
// send flag set, HEADERS_RECEIVED or LOADING; before the send flag it changes no state (send-data-unexpected-tostring:
// abort() during the body's stringification). Then a DONE request goes back to UNSENT, its response the network
// error's — unless an abort / loadend handler opened it again (open-during-abort).
function abort(o) {
  const x = xhrOf(o);
  if ((x.readyState === 1 && x.sendFlag) || x.readyState === 2 || x.readyState === 3) {
    terminate(o, x, 'abort');
  } else {
    clearTimer(x, 'timeoutId');
    clearTimer(x, 'deliveryTimer');
    cancelLongPoll(x);
  }
  if (x.readyState === 4) {
    x.readyState = 0;
    clearResponse(x);
  }
}
// The network error's response: status 0, no status text / body / headers. (`uploadActive` stays: terminate reads it
// after.)
function clearResponse(x) {
  Object.assign(x, { status: 0, statusText: '', responseText: '', response: '', responseXML: null, respHeaders: {} });
}
// XHR "request error steps" for `reason` ('abort' | 'timeout' | 'error'): the timers and a held long poll cancelled,
// DONE with the network error's response — reset BEFORE the DONE readystatechange, whose handler must see it
// (abort-during-loading) — then the upload's `reason` and loadend FIRST, only while an upload is still in progress (a
// body-less GET fires none, abort-after-send; an interrupted upload's precede the request's own, abort-during-upload),
// then the request's.
function terminate(o, x, reason) {
  clearTimer(x, 'timeoutId');
  clearTimer(x, 'deliveryTimer');
  cancelLongPoll(x);
  x.aborted = true;
  x.readyState = 4;
  clearResponse(x);
  fire(o, 'readystatechange');
  if (x.uploadActive) {
    x.uploadActive = false;
    fire(x.upload, reason);
    fire(x.upload, 'loadend');
  }
  fire(o, reason);
  fire(o, 'loadend');
}
// Open()'s credentials (which override the URL's userinfo), else the URL's userinfo, answer the server's 401 "Basic"
// challenge (transparent HTTP auth — the 401 is never exposed to script, the credentials cached for the protection
// space): the request goes out WITHOUT Authorization, the userinfo stripped from its URL, the credentials riding an
// author-unforgeable `x-csim-*` marker. A setRequestHeader('Authorization') is sent as it is, and wins.
function applyCredentials(x) {
  let urlUser = null, urlPass = null;
  try {
    const pu = new URL(x.url, location.href || undefined);
    // (…a malformed percent-escape kept as it is, rather than skipping both the credentials and the stripping)
    const decode = (s) => { try { return decodeURIComponent(s); } catch (_) { return s; } };
    if (pu.username) urlUser = decode(pu.username);
    if (pu.password) urlPass = decode(pu.password);
    if (pu.username || pu.password) {
      pu.username = '';
      pu.password = '';
      x.url = pu.href;
    }
  } catch (_) {}
  const user = x.username != null ? x.username : urlUser;
  const pass = x.password != null ? x.password : urlPass;
  if (user == null && pass == null) return;
  if (findHeaderKey(x.headers, 'authorization') != null) return;
  x.headers['X-Csim-Auth-Challenge'] = globalThis.__csimBtoa((user || '') + ':' + (pass || ''));
}

// XHR "send()" (§3.5.6), `body` converted (a Document or XMLHttpRequestBodyInit — a value of neither stringified by its
// union BEFORE these steps, so a toString() that re-enters this XHR takes effect before the state check:
// send-data-unexpected-tostring).
function send(o, body) {
  const x = xhrOf(o);
  x.timingStart = globalThis.__csimPerformance.now();
  if (x.readyState !== 1 || x.sendFlag) {
    throw new DOMException(XHR_PREFIX('send') + "The object's state must be OPENED.", 'InvalidStateError');
  }
  x.sendFlag = true;
  const generation = x.generation;
  applyCredentials(x);
  // A GET / HEAD has no body: it neither reaches the wire nor fires upload progress (send-entity-body-get-head).
  if (x.method === 'GET' || x.method === 'HEAD') body = null;
  // The body extracted NOW (send's "extract a body"): a Document / FormData / URLSearchParams serialized and its
  // Content-Type / charset settled at send(), so a later mutation of the live object can't change what is sent
  // (send-entity-body-document-bogus mutates the same Document between async sends).
  const reqBody = body != null ? serializeBody(x, body) : null;
  // Upload events fire for a NON-EMPTY body alone: send(null) / send('') / a dropped GET body fire none
  // (send-entity-body-none / -empty / -get-head). A FormData / URLSearchParams / Document's size is its serialized one.
  const total = body != null ? (bodyLength(body) || (reqBody ? reqBody.length : 0)) : 0;
  const hasUpload = total > 0;
  // An upload is in progress (upload-complete flag unset) from send() until the body is transmitted — until the fetch
  // runs; a same-tick abort() before then fires the upload's error events. An async send fires the XHR's loadstart
  // (0/0) SYNCHRONOUSLY — before a same-tick abort()'s events (abort-after-send) and the upload's loadstart
  // (loadstart-and-state, send-redirect-post-upload); a loadstart handler may abort() between them. A synchronous send
  // fires neither (it goes straight to DONE → load → loadend; send-sync-no-response-event-order).
  x.uploadActive = hasUpload;
  if (x.async) {
    fire(o, 'loadstart', { loaded: 0, total: 0, lengthComputable: false });
    if (!current(x, generation)) return;
    if (hasUpload) fire(x.upload, 'loadstart', { loaded: 0, total, lengthComputable: true });
    if (!current(x, generation)) return;
  }
  const run = () => { if (current(x, generation)) doFetch(o, x, reqBody, hasUpload ? total : 0); };
  // Discourse's `cdp.with_slow_upload` CDP-throttle shim: the composer's `isUploading` flag is set synchronously before
  // send(), so parking only the response side keeps `#file-uploading` observable for the test's assertion.
  if (globalThis.__csimSlowUploadActive && body != null && (x.method === 'POST' || x.method === 'PUT' || x.method === 'PATCH')) {
    globalThis.__csimSlowUploadPending.push(run);
    return;
  }
  // (…the timeout counted from here, the send: a response delayed past it — X-Csim-Server-Delay-Ms — loses the race)
  x.sendStart = typeof globalThis.__virtualNow === 'function' ? globalThis.__virtualNow() : 0;
  if (x.async) {
    globalThis.__csimSetTimeout(run, 0);
    armTimeout(o, x);
  } else {
    run();
  }
}
// A body's length for upload progress — the serialized string's: browsers count the bytes on the wire.
function bodyLength(body) {
  if (typeof body === 'string') return body.length;
  if (isBlob(body)) return blobSize(body);
  if (isArrayBufferBody(body) || ArrayBuffer.isView(body)) return body.byteLength;
  return 0;
}
// The body serialized, and the author Content-Type's charset forced to UTF-8 for a UTF-8-encoded text body (a string,
// a Document, a URLSearchParams) — a Blob's opaque bytes and a FormData's multipart keep the author type as it is.
function serializeBody(x, body) {
  const { body: out, charsetFixable } = serializeRequestBody(body, x.headers, true);
  if (charsetFixable) fixContentTypeCharset(x.headers);
  return out;
}

// The fetch of a sent request: `reqBody` its body serialized at send() (a string, a Uint8Array or null),
// `uploadTotal` its size where an upload is in progress.
function doFetch(o, x, reqBody, uploadTotal) {
  const generation = x.generation;
  // Fetch's default `Accept: */*` and an `Accept-Language`, where the author set neither (an XHR's, not a document
  // navigation's richer Accept). The timeout armed at send() stays live, to race a delayed delivery; the request's
  // completion clears it.
  if (findHeaderKey(x.headers, 'accept') == null) x.headers['Accept'] = '*/*';
  if (findHeaderKey(x.headers, 'accept-language') == null) x.headers['Accept-Language'] = 'en-US,en;q=0.9';
  // The upload's completion events fire from the fetch's OUTCOME, not optimistically: the Rack call buffers the whole
  // body, but whether it succeeded (progress / load / loadend) or hit a network error (error / loadend) is known only
  // once it returns (send-network-error-async-events).
  x.uploadTotal = uploadTotal;
  // A long-poll-shaped XHR goes through `rack_fetch_async`, which installs `rack.hijack` so the middleware can hold the
  // connection open until something publishes through it (Discourse MessageBus's `subscribe(channel, -1)` + push-on-
  // publish). Not every async XHR: some Discourse middleware takes a different streaming branch when `rack.hijack?` is
  // truthy even without invoking it, and the response re-renders the page in a different order — a Capybara `find`
  // then races into StaleElement. The Ruby side mirrors this URL gate so the env keys stay off other requests.
  if (x.async && x.method === 'POST' && /\/message-bus\/[^/]+\/poll(?:\?|$)/.test(x.url) &&
      typeof globalThis.__csim_rackFetchAsync === 'function') {
    const result = globalThis.__csim_rackFetchAsync(x.method, x.url, reqBody, JSON.stringify(x.headers));
    if (result && typeof result === 'object') {
      if (typeof result.handle === 'number' && result.handle > 0) {
        x.asyncFetchHandle = result.handle;
        longPolls.set(result.handle, o);
        // (…the body sent once the connection is parked: the upload complete now, so an abort during the held response
        // fires no upload error)
        fireUploadComplete(x, true);
        return;
      }
      completeWith(o, x, result);
      return;
    }
  }
  if (/^data:/i.test(x.url)) {
    // A data: URL's response, synthesized — a HEAD's with its headers but no body (data-uri HEAD).
    const dr = parseDataUrl(x.url);
    if (dr && x.method === 'HEAD') {
      dr.body = '';
      dr.body_bytes = new Uint8Array(0);
    }
    completeWith(o, x, dr);
    return;
  }
  if (x.url.startsWith('blob:')) {
    // A blob: URL answers GET alone (open() referenced its bytes for one): another method, a revoked URL or one with an
    // appended query / path is a network error — the async request's error event, the sync one's NetworkError.
    const r = x.blobSnapshot;
    if (!r) {
      completeWith(o, x, null);
      return;
    }
    // A single byte range honoured (blob-range): a satisfiable Range a 206 of the slice with Content-Range; a malformed
    // or unsatisfiable one a network error (a blob URL answers no 416); none a 200. Content-Type is the blob's own,
    // possibly empty, beside Content-Length (request-content-length) — a response like any other, its bytes decoded and
    // its events fired as a network response's. (A blob: request never has an upload in progress: its GET body was
    // dropped.)
    const full = r.bytes;
    const rangeKey = findHeaderKey(x.headers, 'range');
    const headers = { 'content-type': r.type };
    let bytes = full, status = 200, statusText = 'OK';
    if (rangeKey) {
      const range = parseByteRange(x.headers[rangeKey], full.length);
      if (!range) {
        completeWith(o, x, null);
        return;
      }
      bytes = full.slice(range.start, range.end + 1);
      headers['content-range'] = 'bytes ' + range.start + '-' + range.end + '/' + full.length;
      status = 206;
      statusText = 'Partial Content';
    }
    headers['content-length'] = String(bytes.length);
    completeWith(o, x, { status, statusText, url: x.url, headers, body: bytes, body_bytes: latin1ToBytes(bytes) });
    return;
  }
  // XHR over a service worker: an ASYNC controlled client's request goes to the controlling worker's `fetch` event first,
  // like fetch(); a fall-through goes to the network (with upload progress), a response completes it — with no upload
  // progress (nothing went over the wire). A SYNC XHR can't await the worker round-trip, and stays on the network path.
  // The worker's `event.request.url` is resolved against this client's own base (open() may have kept it relative); an
  // XHR is mode 'cors', its credentials its withCredentials', the rest a Request's defaults.
  const ctrl = x.async && globalThis.__csimSWControllerHandle && globalThis.__csimSWControllerHandle();
  if (ctrl) {
    let swUrl = x.url;
    try { swUrl = new URL(x.url, location.href || undefined).href; } catch (_) {}
    const swReq = buildSwRequest({ credentials: x.withCredentials ? 'include' : 'same-origin' });
    globalThis.__csimSWInterceptFetch(ctrl, x.method, swUrl, x.headers, reqBody, swReq, (swResp) => {
      if (!current(x, generation)) return;
      if (swResp == null) {
        networkFetch(o, x, reqBody);
        return;
      }
      x.uploadActive = false;
      // (…an opaque or opaqueredirect respondWith a network error: an XHR is mode 'cors', redirect 'follow' — as
      // fetch.js's filtered-type gate)
      const t = swResp.type;
      completeWith(o, x, swResp.__networkError || t === 'opaque' || t === 'opaqueredirect' ? null : swResp);
    });
    return;
  }
  networkFetch(o, x, reqBody);
}
function networkFetch(o, x, reqBody) {
  let resp;
  // An XHR has no `omit`: withCredentials true `include`, false `same-origin`. The client URL (argument 13) is this
  // realm's own document's, as fetch.js passes it: rack_fetch's `crossed` verdict compares hops against it, so a FRAME's
  // same-origin XHR stays same-origin rather than judged against the TOP document.
  try {
    resp = globalThis.__rackFetch(x.method, x.url, reqBody, x.headers, 'follow', 'cors', x.withCredentials ? 'include' : 'same-origin', null, null, null, null, null, null, String(location.href || ''));
  } catch (_) { resp = null; }
  if (typeof globalThis.__csimRecordResource === 'function') {
    globalThis.__csimRecordResource({ name: x.url, initiatorType: 'xmlhttprequest', startTime: x.timingStart, resp });
  }
  // A handler that `time.sleep`s (delay.py / trickle.py) returns at once with a virtual `X-Csim-Server-Delay-Ms`
  // (wpt_py_handler.py): an ASYNC request's delivery is deferred that many virtual ms, so a shorter `timeout` (virtual
  // too) fires first; a SYNCHRONOUS one decides the race here — a delay at least the timeout throws TimeoutError, no
  // events (xmlhttprequest-timeout-worker-synconworker). The marker is never exposed.
  const delayMs = takeServerDelayMs(resp);
  if (delayMs > 0) {
    if (x.async) {
      x.deliveryTimer = globalThis.__csimSetTimeout(() => { x.deliveryTimer = null; completeWith(o, x, resp); }, delayMs);
      return;
    }
    if (x.timeout > 0 && delayMs >= x.timeout) {
      x.readyState = 4;
      x.uploadActive = false;
      throw new DOMException(XHR_PREFIX('send') + 'The request timed out.', 'TimeoutError');
    }
  }
  completeWith(o, x, resp);
}
function takeServerDelayMs(resp) {
  if (!resp || !resp.headers) return 0;
  for (const k in resp.headers) {
    if (k.toLowerCase() === 'x-csim-server-delay-ms') {
      const v = parseInt(resp.headers[k], 10) || 0;
      delete resp.headers[k];
      return v;
    }
  }
  return 0;
}
// The upload's terminal events, once the fetch's outcome is known: on success progress → load → loadend (the buffered
// body fully sent), on a network error error → loadend with 0 and 0. None for a body-less request (no upload in
// progress) nor a synchronous one; the flag cleared, so a later abort / timeout fires none (abort-during-loading).
function fireUploadComplete(x, success) {
  if (!x.uploadActive) return;
  x.uploadActive = false;
  if (!x.async) return;
  if (success) {
    const t = x.uploadTotal;
    const ev = { loaded: t, total: t, lengthComputable: t > 0 };
    fire(x.upload, 'progress', ev);
    fire(x.upload, 'load', ev);
    fire(x.upload, 'loadend', ev);
  } else {
    fire(x.upload, 'error');
    fire(x.upload, 'loadend');
  }
}
// The response `resp` (a rack response hash, or null: a network error) delivered — XHR "process response" and the
// events after it.
function completeWith(o, x, resp) {
  if (x.aborted) return;
  const generation = x.generation;
  // (…the request done: the still-armed timeout cancelled, so it fires not after DONE)
  clearTimer(x, 'timeoutId');
  if (!resp) {
    x.readyState = 4;
    x.status = 0;
    // A synchronous request's network error throws NetworkError from send(), no events; an async one's is its error
    // event — an interrupted upload's error / loadend between the DONE readystatechange and it
    // (send-network-error-async-events).
    if (!x.async) {
      x.uploadActive = false;
      throw new DOMException(XHR_PREFIX('send') + 'Failed to load.', 'NetworkError');
    }
    fire(o, 'readystatechange');
    if (!current(x, generation)) return;
    fireUploadComplete(x, false);
    if (!current(x, generation)) return;
    // (…loadend straight after error, as the request-error steps fire them)
    fire(o, 'error');
    fire(o, 'loadend');
    return;
  }
  // The body is fully sent the moment the fetch succeeds: the upload's progress / load / loadend before the response's
  // readystatechange sequence (loadstart-and-state, send-redirect-post-upload) — a handler of which may abort() (the
  // cancel-on-upload-complete pattern), whose events then stand.
  fireUploadComplete(x, true);
  if (!current(x, generation)) return;
  x.status = resp.status || 200;
  x.statusText = resp.statusText || '';
  x.responseURL = resp.url || x.url;
  x.responseText = resp.body == null ? '' : String(resp.body);
  // The response's headers: lowercased (every lookup case-insensitive), minus the forbidden response-header names
  // getResponseHeader / getAllResponseHeaders never reveal (getresponseheader-cookies).
  const norm = {};
  for (const k of Object.keys(resp.headers || {})) {
    const lower = k.toLowerCase();
    if (!FORBIDDEN_RESPONSE_HEADERS.has(lower)) norm[lower] = String(resp.headers[k]);
  }
  x.respHeaders = norm;
  const contentType = norm['content-type'] || '';
  // "Get a final MIME type": the override's type over the response's; an absent / unparseable one (no type/subtype:
  // '', 'bogus', 'application') text/xml — so it parses as XML (responsexml-media-type), a valid non-XML one does not.
  let ctMime = contentType.split(';')[0].trim().toLowerCase();
  if (!/^[^\s/]+\/[^\s/]+$/.test(ctMime)) ctMime = 'text/xml';
  const finalMime = x.overrideMime ? x.overrideMime.essence : ctMime;
  const isXml = /(\+xml|\/xml)$/.test(finalMime) || finalMime === 'image/svg+xml';
  // `bytes`: the raw latin-1 byte string for an arraybuffer / blob response, so a binary payload survives the engine's
  // string boundary; the decoded text otherwise. "Get a text response": where the raw bytes came (a non-UTF-8 charset
  // / an XML response — browser.rb gates `body_bytes`), decoded in the final encoding — the override's charset, the
  // Content-Type's, (the default responseType reading XML) its XML declaration's, UTF-8 — a BOM over all; else the body
  // already IS the UTF-8 text. Before `response` / `responseXML`, which both read it.
  let bytes = x.responseText;
  let rawBytes = null;
  const label = (x.overrideMime && x.overrideMime.charset) || charsetOf(contentType);
  if (resp.body_bytes) {
    rawBytes = bytesToLatin1(resp.body_bytes);
    bytes = rawBytes;
    x.responseText = label == null && x.responseType === '' && isXml
      ? decodeAsDocument(resp.body_bytes, finalMime, null)[0]
      : decodeResponseBytes(rawBytes, label);
  }
  // (…json the UTF-8 decode of the raw bytes, not the charset-decoded text — the fast path's text already IS that; only
  // computed for json)
  const jsonText = x.responseType === 'json' && rawBytes != null ? utf8DecodeBytes(rawBytes) : x.responseText;
  // (…a blob's type the final MIME type — text/xml for an absent one, not octet-stream: overridemimetype-blob)
  x.response = responseValue(x.responseType, x.responseText, bytes, finalMime, jsonText);
  // XHR "document response": built only for responseType 'document' of an HTML or XML-family final MIME type (any other
  // — text/plain — a null document, responsexml-invalid-type), or the default responseType of an XML one (an HTML
  // response under '' leaves responseXML null — a Turbo / AJAX HTML fetch pays no parse it won't read). A non-well-
  // formed XML parse — a <parsererror> root, or none for an empty body — is null; its encoding the one it was decoded
  // in. (DOMParser converts no declarative shadow root — the XHR behaviour the opt-in test asserts.)
  const wantsDoc = inDocument() &&
    ((x.responseType === 'document' && (finalMime === 'text/html' || isXml)) || (x.responseType === '' && isXml));
  if (wantsDoc) {
    // (…XHR "set a document response": its URL the response's, its content type the final MIME type)
    try {
      const [text, encoding] = decodeAsDocument(resp.body_bytes || latin1ToBytes(x.responseText), finalMime, label);
      const doc = parseDocument(text, isXml, finalMime, x.responseURL.includes('#') ? x.responseURL : x.responseURL + x.fragment);
      doc._encoding = encoding;
      const de = documentElementOf(doc);
      x.responseXML = isXml && (!de || de.namespaceURI === PARSERERROR_NS) ? null : doc;
    } catch (_) { x.responseXML = null; }
  }
  // (…a document response's `response` IS the document, the null one too)
  if (x.responseType === 'document') x.response = x.responseXML;
  // A synchronous request goes straight to DONE (abort-during-done sync: [1, 4]). LOADING is entered only as response
  // BYTES arrive — the received byte count, not the decoded chars: a binary or BOM-only body decodes to '' and still
  // enters it — so a body-less response goes HEADERS_RECEIVED → progress → DONE (send-no-response-event-order). A
  // readystatechange handler may abort() mid-sequence (abort-during-headers-received / -loading), its own DONE / abort /
  // loadend then standing.
  // (…`loaded` the body's BYTES: its raw ones', or — on the UTF-8 fast path — its text's UTF-8 length; not the decoded
  // characters)
  const total = rawBytes !== null ? rawBytes.length : utf8Length(x.responseText);
  if (x.async) {
    x.readyState = 2;
    fire(o, 'readystatechange');
    if (!current(x, generation)) return;
    if (bytes.length > 0) {
      x.readyState = 3;
      fire(o, 'readystatechange');
      if (!current(x, generation)) return;
    }
  }
  // `progress` between HEADERS_RECEIVED and DONE, so a caller reading `responseText` as it streams (Discourse
  // MessageBus's chunked-frame parser, EventSource-shaped polyfills) sees the data first — one, of the whole buffered
  // body, as a browser emits for a non-chunked response; none for a synchronous request (sync-no-progress). Its `total`
  // the response's Content-Length (0 where absent), `lengthComputable` total !== 0 — a chunked body without one
  // (firing-events-http-no-content-length) and an explicit `Content-Length: 0` (send-no-response-event-order) neither
  // computable — `loaded` what arrived.
  const cl = x.respHeaders['content-length'];
  const progressTotal = cl != null && cl !== '' ? parseInt(cl, 10) || 0 : 0;
  const progress = { loaded: total, total: progressTotal, lengthComputable: progressTotal > 0 };
  if (x.async) fire(o, 'progress', progress);
  if (!current(x, generation)) return;
  x.readyState = 4;
  fire(o, 'readystatechange');
  // (…a DONE handler's abort(): the sending branch's sets `aborted`, the DONE branch's resets to UNSENT)
  if (!current(x, generation) || x.readyState !== 4) return;
  // (…loadend straight after load, as the end-of-body steps fire them — a load handler's open() notwithstanding)
  fire(o, 'load', progress);
  fire(o, 'loadend', progress);
}

globalThis.XMLHttpRequest = XMLHttpRequest;
globalThis.XMLHttpRequestUpload = XMLHttpRequestUpload;
globalThis.XMLHttpRequestEventTarget = XMLHttpRequestEventTarget;

globalThis.__csimSlowUploadPending = [];
globalThis.__csimDrainSlowUploads = function () {
  const q = globalThis.__csimSlowUploadPending;
  globalThis.__csimSlowUploadPending = [];
  for (const fn of q) fn();
};

// The held long polls, by their `rack_fetch_async` handle: Browser#settle drains the Ruby-side queue (immediate and
// background-read hijack responses alike) and hands the batch here, each delivered as any response is — the same
// readystatechange 2 / 3 / 4, progress, load and loadend.
const longPolls = new Map();
globalThis.__csim_deliverHijackedFetches = function (responses) {
  if (!responses || !responses.length) return 0;
  let delivered = 0;
  for (const r of responses) {
    const handle = r && r.handle | 0;
    const o = longPolls.get(handle);
    if (o === undefined) continue;
    longPolls.delete(handle);
    const x = xhrOf(o);
    x.asyncFetchHandle = 0;
    completeWith(o, x, r);
    delivered++;
  }
  return delivered;
};
