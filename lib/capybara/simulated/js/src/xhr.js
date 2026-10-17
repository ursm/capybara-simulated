// XMLHttpRequest (XMLHttpRequest Standard), generated from its IDL — Rails-UJS / jQuery.ajax / many older libraries lean
// on it. A request round-trips a Rack call through the `__rackFetch` host fn: the fetch itself is synchronous (the
// engine's attach() blocks), its readystatechange / load events DEFERRED through the virtual clock so a call site's
// "then" / .done handlers run after the current frame unwinds — the listener order libraries assume of an async one.
// Its state machine is the engine's (xhr_state.rs: `state` in its slots); the response's body, the objects made of it,
// its timers and the fetch's plumbing are its internal slots; its upload's and its own events fire from module
// functions, never prototype methods.

import { bytesToArrayBuffer, bytesToLatin1, latin1ToBytes, utf8DecodeBytes, utf8Length } from './bytes.js';
import { Blob, blobSize, isBlob, resolveBlobBytes } from './blob.js';
import { processDataUrl }          from './data-url.js';
import { serializeRequestBody, utf8ContentType, isArrayBufferBody } from './request-body.js';
import { DOMException, Event, ProgressEvent, EventTarget, dispatchWithOnHandler, installEventHandlerAttrs } from './events.js';
import {
  HEADER_BAD_NAME,
  filteredHeaderList,
  headerListAppend,
  headerListGet,
  headerListObject,
  headerListSet,
  headerListText,
  requestHeaderList
} from './headers.js';
import { documentOrigin } from './platform-globals.js';
import { buildSwRequest } from './sw-client.js';
import { parseMimeType } from './mime.js';
import { documentElementOf } from './document-tree.js';
import { PLATFORM, constructedBy, makeSlots, registerInterface, slotsOf } from './webidl.js';
import { installXMLHttpRequest, installXMLHttpRequestEventTarget, installXMLHttpRequestUpload } from './generated/bindings.js';
import { parseDocument } from './dom-parser.js';
import { location } from './location.js';
import { parseURL } from './url-parse.js';
import { documentBaseURL, documentEncoding } from './base-url.js';
import { hostTask } from './timers.js';

// DOMParser marks a non-well-formed XML parse with a <parsererror> root in this
// namespace; XHR responseXML maps that to null.
const PARSERERROR_NS = 'http://www.mozilla.org/newlayout/xml/parsererror.xml';

// Raw response bytes (a latin-1 byte string from `body_bytes`) decoded into responseText — the Encoding Standard's
// "decode", natively (`__dom.decodeBytes`): a leading BOM's encoding over `label` (the final charset; none, or one no
// encoding has, UTF-8), the BOM removed.
function decodeResponseBytes(byteStr, label) {
  return globalThis.__dom.decodeBytes(latin1ToBytes(byteStr), label);
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
// The fields of its state the engine keeps (xhr_state.rs `xhrGet` / `xhrSet`), and its state (UNSENT … DONE).
const X_READY = 0, X_STATUS = 1, X_STATUS_TEXT = 2, X_RESPONSE_URL = 3, X_TIMEOUT = 4, X_WITH_CREDENTIALS = 5,
  X_RESPONSE_TYPE = 6, X_GENERATION = 7, X_ASYNC = 8, X_SEND = 9, X_UPLOAD_ACTIVE = 10, X_METHOD = 11, X_URL = 12,
  X_FRAGMENT = 13, X_SEND_START = 18, X_UPLOAD_TOTAL = 19, X_TIMING_START = 20;
// (…the response types, by the index the engine keeps — xhr_state.rs `RESPONSE_TYPES`)
const RESPONSE_TYPES = ['', 'arraybuffer', 'blob', 'document', 'json', 'text'];
const OPENED = 1, HEADERS_RECEIVED = 2, LOADING = 3, DONE = 4;
const field = (x, f) => globalThis.__dom.xhrGet(x.state, f);
const setField = (x, f, v) => globalThis.__dom.xhrSet(x.state, f, v);
const readyOf = (x) => field(x, X_READY);
const responseTypeOf = (x) => RESPONSE_TYPES[field(x, X_RESPONSE_TYPE)];
registerInterface('XMLHttpRequest', (o) => xhrOf(o) !== undefined);
export class XMLHttpRequest extends XMLHttpRequestEventTarget {
  constructor() {
    super(PLATFORM);
    // Its state (XHR §3), the engine's (`state`: the state machine, the request's method, URL and credentials, its flags,
    // the timeout, when it was sent, the response type, the override MIME type, the response's status and URL, its
    // open()s counted) — and the rest: the request's author headers and the Authorization its credentials answer a
    // challenge with, the timeout's timer, a blob: URL's bytes referenced at open(), the
    // response's headers (lowercased, combined, set-cookie dropped) and body (`body`: what it is read as, below) — its
    // text, the value `response` is and the document made of it as they are first read (`text`, `response`,
    // `responseXML`: undefined until then) — and the in-flight long poll / delayed delivery.
    makeSlots(this, 'XMLHttpRequest', {
      state: new globalThis.__dom.XhrBase(), body: null, text: null, response: undefined, responseXML: undefined,
      upload: new XMLHttpRequestUpload(PLATFORM), headers: requestHeaderList(), authChallenge: null, respHeaders: null,
      timeoutId: null, deliveryTimer: null, blobSnapshot: null, asyncFetchHandle: 0
    });
  }
}
// `responseType` cannot change for a synchronous request from a document, nor once the response is LOADING / DONE;
// neither can `timeout` for the former. (Allowed in a worker.)
const inDocument = () => !globalThis.__csim_isWorker;
const XHR_PREFIX = (member) => `Failed to execute '${member}' on 'XMLHttpRequest': `;
installXMLHttpRequest(XMLHttpRequest, {
  get_readyState: (o) => readyOf(xhrOf(o)),
  // open(method, url) is open(method, url, true) (XHR §3.5.1).
  open_method_url: (o, method, url) => open(o, method, url, true, null, null),
  open_method_url_async_username_password: (o, method, url, async, username, password) => open(o, method, url, async, username, password),
  setRequestHeader(o, name, value) {
    const x = xhrOf(o);
    if (readyOf(x) !== OPENED || field(x, X_SEND)) {
      throw new DOMException(XHR_PREFIX('setRequestHeader') + "The object's state must be OPENED.", 'InvalidStateError');
    }
    // (…a non-token name or a value with NUL / CR / LF a SyntaxError — the value's leading and trailing HTTP whitespace
    // stripped; a forbidden request-header dropped; a repeated name combined with ", ": the engine's list)
    const refused = headerListAppend(x.headers, name, value);
    if (refused === HEADER_BAD_NAME) {
      throw new DOMException(XHR_PREFIX('setRequestHeader') + `'${name}' is not a valid HTTP header field name.`, 'SyntaxError');
    }
    if (refused) {
      throw new DOMException(XHR_PREFIX('setRequestHeader') + `'${value}' is not a valid HTTP header field value.`, 'SyntaxError');
    }
  },
  get_timeout: (o) => field(xhrOf(o), X_TIMEOUT),
  // A changed timeout is measured against the send again: one already elapsed fires at once, a longer one extends it
  // (xmlhttprequest-timeout-overrides*).
  set_timeout(o, v) {
    const x = xhrOf(o);
    if (!globalThis.__dom.xhrSetTimeout(x.state, v, inDocument())) {
      throw new DOMException("Failed to set the 'timeout' property on 'XMLHttpRequest': Timeouts cannot be set for synchronous requests made from a document.", 'InvalidAccessError');
    }
    armTimeout(o, x);
  },
  get_withCredentials: (o) => field(xhrOf(o), X_WITH_CREDENTIALS),
  // (…only while UNSENT or OPENED with the send flag unset — loadstart-and-state sets it during loadstart)
  set_withCredentials(o, v) {
    if (!globalThis.__dom.xhrSetWithCredentials(xhrOf(o).state, v)) {
      throw new DOMException("Failed to set the 'withCredentials' property on 'XMLHttpRequest': The value may only be set if the object's state is UNSENT or OPENED.", 'InvalidStateError');
    }
  },
  get_upload: (o) => xhrOf(o).upload,
  send: (o, body) => send(o, body),
  abort: (o) => abort(o),
  get_responseURL: (o) => field(xhrOf(o), X_RESPONSE_URL),
  get_status: (o) => field(xhrOf(o), X_STATUS),
  get_statusText: (o) => field(xhrOf(o), X_STATUS_TEXT),
  getResponseHeader: (o, name) => headerListGet(xhrOf(o).respHeaders, name),
  // (…Fetch "sort and combine", then by the names byte-uppercased, each "name: value\r\n": the engine's)
  getAllResponseHeaders: (o) => headerListText(xhrOf(o).respHeaders),
  // The override MIME type: the final MIME type (which decides responseXML) and, its charset given, the final encoding
  // — over the response's Content-Type. It survives open(); only once the response is LOADING / DONE does it throw
  // (overridemimetype-done-state).
  overrideMimeType(o, mime) {
    const { essence, charset } = parseOverrideMime(mime);
    if (!globalThis.__dom.xhrOverrideMimeType(xhrOf(o).state, essence, charset)) {
      throw new DOMException(XHR_PREFIX('overrideMimeType') + 'MimeType cannot be overridden because the state is DONE.', 'InvalidStateError');
    }
  },
  get_responseType: (o) => responseTypeOf(xhrOf(o)),
  // (…'document' ignored where the global is no Window: a worker has no document response)
  set_responseType(o, v) {
    const refused = globalThis.__dom.xhrSetResponseType(xhrOf(o).state, v, inDocument());
    if (refused === 1) {
      throw new DOMException("Failed to set the 'responseType' property on 'XMLHttpRequest': the response type cannot be set if the object's state is LOADING or DONE.", 'InvalidStateError');
    }
    if (refused === 2) {
      throw new DOMException("Failed to set the 'responseType' property on 'XMLHttpRequest': the response type cannot be changed for synchronous requests made from a document.", 'InvalidAccessError');
    }
  },
  // The `response` getter (XHR §3.6.9): the text response for responseType '' or 'text' — '' until the body arrives,
  // LOADING or DONE — else null until DONE, then the response object of the responseType it has then (which LOADING
  // fixes: the setter throws from there), made as it is first read.
  get_response(o) {
    const x = xhrOf(o);
    const responseType = responseTypeOf(x), ready = readyOf(x);
    if (responseType === '' || responseType === 'text') return ready === LOADING || ready === DONE ? textResponse(x, responseType) : '';
    if (ready !== DONE) return null;
    if (x.response === undefined) x.response = responseType === 'document' ? documentResponse(x, responseType) : responseObject(x, responseType);
    return x.response;
  },
  // (…only for responseType '' or 'text' — responsexml-non-document-types — and '' until the body arrives: LOADING or
  // DONE, responseText-status)
  get_responseText(o) {
    const x = xhrOf(o);
    const responseType = responseTypeOf(x);
    if (responseType !== '' && responseType !== 'text') {
      throw new DOMException("Failed to read the 'responseText' property from 'XMLHttpRequest': the value is only accessible if the object's 'responseType' is '' or 'text' (was '" + responseType + "').", 'InvalidStateError');
    }
    const ready = readyOf(x);
    return ready === LOADING || ready === DONE ? textResponse(x, responseType) : '';
  },
  // (…only for responseType '' or 'document', and null until DONE — abort-during-loading reads it at LOADING)
  get_responseXML(o) {
    const x = xhrOf(o);
    const responseType = responseTypeOf(x);
    if (responseType !== '' && responseType !== 'document') {
      throw new DOMException("Failed to read the 'responseXML' property from 'XMLHttpRequest': the value is only accessible if the object's 'responseType' is '' or 'document' (was '" + responseType + "').", 'InvalidStateError');
    }
    return readyOf(x) === DONE ? documentResponse(x, responseType) : null;
  },
  installEventHandlers: (proto, names, isSelf) => installEventHandlerAttrs(proto, names, null, isSelf)
});

// (Re)arm the timeout timer for what remains of it since send() — 0, the next task, where it has passed.
function armTimeout(o, x) {
  clearTimer(x, 'timeoutId');
  const timeout = field(x, X_TIMEOUT);
  if (!field(x, X_ASYNC) || timeout <= 0 || !field(x, X_SEND) || readyOf(x) === DONE) return;
  const generation = field(x, X_GENERATION);
  if (!current(x, generation)) return;
  const now = typeof globalThis.__virtualNow === 'function' ? globalThis.__virtualNow() : 0;
  const sendStart = field(x, X_SEND_START);
  const remaining = Math.max(0, timeout - (sendStart !== null ? now - sendStart : 0));
  x.timeoutId = globalThis.__csimSetTimeout(() => {
    if (readyOf(x) === DONE || !current(x, generation)) return;
    terminate(o, x, 'timeout');
  }, remaining);
}
// Whether the send of the open() counted `generation` is still this XHR's: not aborted, nor its XHR opened again — from
// a handler of its own events too, after which it fires none on the request opened anew.
const current = (x, generation) => globalThis.__dom.xhrCurrent(x.state, generation);
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

// XHR "open()" (§3.5.1), its arguments converted: its checks of the method and the URL, the request URL resolved against
// the API base URL in the document's encoding, its fragment apart, and the synchronous-from-a-document check — the
// engine's (xhr_state.rs `xhrOpen`), each before any state changes, so a bad open() leaves the object untouched.
function open(o, method, url, async, username, password) {
  const x = xhrOf(o);
  const doc = globalThis.document;
  const base = location.href || undefined;
  const apiBase = (doc && documentBaseURL(doc)) || base;
  const opened = globalThis.__dom.xhrOpen(x.state, method, url, async, inDocument(), username, password, base, apiBase, doc ? documentEncoding(doc) : null);
  if (opened < 0) {
    throw new DOMException(XHR_PREFIX('open') + 'Synchronous requests from a document must not set a responseType or a timeout.', 'InvalidAccessError');
  }
  // The fetch in flight terminated — its timers, a held long poll — and anything it still queued made stale; the request
  // and the response reset: a reused XHR does not expose the prior response while OPENED again. Its username /
  // password, given, override the URL's userinfo (send-authentication); a blob: GET's bytes are referenced NOW, so a
  // revokeObjectURL before send() leaves it working.
  clearTimer(x, 'timeoutId');
  clearTimer(x, 'deliveryTimer');
  cancelLongPoll(x);
  Object.assign(x, {
    headers: requestHeaderList(), authChallenge: null
  });
  clearResponse(x);
  x.blobSnapshot = field(x, X_METHOD) === 'GET' && url.startsWith('blob:') ? resolveBlobBytes(url) : null;
  // (…OPENED, and readystatechange, only where it was not OPENED already — open-open-send / open-send-open)
  if (opened) fire(o, 'readystatechange');
}

// XHR "abort()" (§3.5.7): the request-error steps (DONE, abort, loadend) only for a request in flight — OPENED with the
// send flag set, HEADERS_RECEIVED or LOADING; before the send flag it changes no state (send-data-unexpected-tostring:
// abort() during the body's stringification). Then a DONE request goes back to UNSENT, its response the network
// error's — unless an abort / loadend handler opened it again (open-during-abort).
function abort(o) {
  const x = xhrOf(o);
  if (globalThis.__dom.xhrInFlight(x.state)) {
    terminate(o, x, 'abort');
  } else {
    clearTimer(x, 'timeoutId');
    clearTimer(x, 'deliveryTimer');
    cancelLongPoll(x);
  }
  if (globalThis.__dom.xhrUnsend(x.state)) clearResponse(x);
}
// The network error's response: no body / headers (its status and status text the engine's to reset).
function clearResponse(x) {
  Object.assign(x, { body: null, text: null, response: undefined, responseXML: undefined, respHeaders: null });
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
  globalThis.__dom.xhrTerminate(x.state);
  clearResponse(x);
  fire(o, 'readystatechange');
  // (…an upload in progress as the readystatechange handler leaves it: one that opened and sent again has its own)
  if (globalThis.__dom.xhrTakeUpload(x.state)) {
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
  // (…open()'s, else the URL's, which leave its URL: the engine's, xhr_state.rs `xhrCredentials`)
  const [user, pass] = globalThis.__dom.xhrCredentials(x.state, location.href || null);
  if (user === null && pass === null) return;
  if (headerListGet(x.headers, 'authorization') != null) return;
  x.authChallenge = globalThis.__csimBtoa((user || '') + ':' + (pass || ''));
}

// XHR "send()" (§3.5.6), `body` converted (a Document or XMLHttpRequestBodyInit — a value of neither stringified by its
// union BEFORE these steps, so a toString() that re-enters this XHR takes effect before the state check:
// send-data-unexpected-tostring).
function send(o, body) {
  const x = xhrOf(o);
  setField(x, X_TIMING_START, globalThis.__csimPerformanceNow());
  const generation = globalThis.__dom.xhrSend(x.state);
  if (generation < 0) {
    throw new DOMException(XHR_PREFIX('send') + "The object's state must be OPENED.", 'InvalidStateError');
  }
  applyCredentials(x);
  const method = field(x, X_METHOD), async = field(x, X_ASYNC);
  // A GET / HEAD has no body: it neither reaches the wire nor fires upload progress (send-entity-body-get-head).
  if (method === 'GET' || method === 'HEAD') body = null;
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
  setField(x, X_UPLOAD_ACTIVE, hasUpload);
  if (async) {
    fire(o, 'loadstart', { loaded: 0, total: 0, lengthComputable: false });
    if (!current(x, generation)) return;
    if (hasUpload) fire(x.upload, 'loadstart', { loaded: 0, total, lengthComputable: true });
    if (!current(x, generation)) return;
  }
  const run = () => { if (current(x, generation)) doFetch(o, x, reqBody, hasUpload ? total : 0); };
  // Discourse's `cdp.with_slow_upload` CDP-throttle shim: the composer's `isUploading` flag is set synchronously before
  // send(), so parking only the response side keeps `#file-uploading` observable for the test's assertion.
  if (globalThis.__csimSlowUploadActive && body != null && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
    globalThis.__csimSlowUploadPending.push(run);
    return;
  }
  // (…the timeout counted from here, the send: a response delayed past it — X-Csim-Server-Delay-Ms — loses the race)
  setField(x, X_SEND_START, typeof globalThis.__virtualNow === 'function' ? globalThis.__virtualNow() : 0);
  if (async) {
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
  const { body: out, type, charsetFixable } = serializeRequestBody(body, true);
  const authored = headerListGet(x.headers, 'content-type');
  if (authored === null && type !== null) headerListAppend(x.headers, 'Content-Type', type);
  const utf8 = authored !== null && charsetFixable ? utf8ContentType(authored) : null;
  if (utf8 !== null) headerListSet(x.headers, 'Content-Type', utf8);
  return out;
}
// The request's headers as they go on the wire, `{name: value}` — the author's, and the private credentials marker
// (`x-csim-*`, which no author header may forge) where the URL or open() gave a user.
function wireHeaders(x) {
  const out = headerListObject(x.headers);
  if (x.authChallenge !== null) out['X-Csim-Auth-Challenge'] = x.authChallenge;
  return out;
}

// The fetch of a sent request: `reqBody` its body serialized at send() (a string, a Uint8Array or null),
// `uploadTotal` its size where an upload is in progress.
function doFetch(o, x, reqBody, uploadTotal) {
  const generation = field(x, X_GENERATION);
  const method = field(x, X_METHOD), url = field(x, X_URL), async = field(x, X_ASYNC);
  // Fetch's default `Accept: */*` and an `Accept-Language`, where the author set neither (an XHR's, not a document
  // navigation's richer Accept). The timeout armed at send() stays live, to race a delayed delivery; the request's
  // completion clears it.
  if (headerListGet(x.headers, 'accept') === null) headerListAppend(x.headers, 'Accept', '*/*');
  if (headerListGet(x.headers, 'accept-language') === null) headerListAppend(x.headers, 'Accept-Language', 'en-US,en;q=0.9');
  // The upload's completion events fire from the fetch's OUTCOME, not optimistically: the Rack call buffers the whole
  // body, but whether it succeeded (progress / load / loadend) or hit a network error (error / loadend) is known only
  // once it returns (send-network-error-async-events).
  setField(x, X_UPLOAD_TOTAL, uploadTotal);
  // A long-poll-shaped XHR goes through `rack_fetch_async`, which installs `rack.hijack` so the middleware can hold the
  // connection open until something publishes through it (Discourse MessageBus's `subscribe(channel, -1)` + push-on-
  // publish). Not every async XHR: some Discourse middleware takes a different streaming branch when `rack.hijack?` is
  // truthy even without invoking it, and the response re-renders the page in a different order — a Capybara `find`
  // then races into StaleElement. The Ruby side mirrors this URL gate so the env keys stay off other requests.
  if (async && method === 'POST' && /\/message-bus\/[^/]+\/poll(?:\?|$)/.test(url) &&
      typeof globalThis.__csim_rackFetchAsync === 'function') {
    const result = globalThis.__csim_rackFetchAsync(method, url, reqBody, JSON.stringify(wireHeaders(x)));
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
  if (/^data:/i.test(url)) {
    // A data: URL's response, synthesized — a HEAD's with its headers but no body (data-uri HEAD).
    const dr = parseDataUrl(url);
    if (dr && method === 'HEAD') {
      dr.body = '';
      dr.body_bytes = new Uint8Array(0);
    }
    completeWith(o, x, dr);
    return;
  }
  if (url.startsWith('blob:')) {
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
    const range = headerListGet(x.headers, 'range');
    const headers = { 'content-type': r.type };
    let bytes = full, status = 200, statusText = 'OK';
    if (range !== null) {
      const byteRange = globalThis.__dom.blobRange(range, full.length);
      if (!byteRange) {
        completeWith(o, x, null);
        return;
      }
      const [first, last] = byteRange;
      bytes = full.slice(first, last + 1);
      headers['content-range'] = 'bytes ' + first + '-' + last + '/' + full.length;
      status = 206;
      statusText = 'Partial Content';
    }
    headers['content-length'] = String(bytes.length);
    completeWith(o, x, { status, statusText, url, headers, body: bytes, body_bytes: latin1ToBytes(bytes) });
    return;
  }
  // XHR over a service worker: an ASYNC controlled client's request goes to the controlling worker's `fetch` event first,
  // like fetch(); a fall-through goes to the network (with upload progress), a response completes it — with no upload
  // progress (nothing went over the wire). A SYNC XHR can't await the worker round-trip, and stays on the network path.
  // The worker's `event.request.url` is resolved against this client's own base (open() may have kept it relative); an
  // XHR is mode 'cors', its credentials its withCredentials', the rest a Request's defaults.
  const ctrl = async && globalThis.__csimSWControllerHandle && globalThis.__csimSWControllerHandle();
  if (ctrl) {
    const swUrl = parseURL(url, location.href || null)?.href ?? url;
    const swReq = buildSwRequest({ credentials: field(x, X_WITH_CREDENTIALS) ? 'include' : 'same-origin' });
    globalThis.__csimSWInterceptFetch(ctrl, method, swUrl, wireHeaders(x), reqBody, swReq, (swResp) => {
      if (!current(x, generation)) return;
      if (swResp == null) {
        networkFetch(o, x, reqBody);
        return;
      }
      setField(x, X_UPLOAD_ACTIVE, false);
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
  const method = field(x, X_METHOD), url = field(x, X_URL), async = field(x, X_ASYNC);
  let resp;
  // An XHR has no `omit`: withCredentials true `include`, false `same-origin`. The client URL (argument 13) is this
  // realm's own document's, as fetch.js passes it: rack_fetch's `crossed` verdict compares hops against it, so a FRAME's
  // same-origin XHR stays same-origin rather than judged against the TOP document.
  try {
    resp = globalThis.__rackFetch(method, url, reqBody, wireHeaders(x), 'follow', 'cors', field(x, X_WITH_CREDENTIALS) ? 'include' : 'same-origin', null, null, null, null, null, null, String(location.href || ''), false, null, documentOrigin());
  } catch (_) { resp = null; }
  if (typeof globalThis.__csimRecordResource === 'function') {
    globalThis.__csimRecordResource({ name: url, initiatorType: 'xmlhttprequest', startTime: field(x, X_TIMING_START), resp });
  }
  // A handler that `time.sleep`s (delay.py / trickle.py) returns at once with a virtual `X-Csim-Server-Delay-Ms`
  // (wpt_py_handler.py): an ASYNC request's delivery is deferred that many virtual ms, so a shorter `timeout` (virtual
  // too) fires first; a SYNCHRONOUS one decides the race here — a delay at least the timeout throws TimeoutError, no
  // events (xmlhttprequest-timeout-worker-synconworker). The marker is never exposed.
  const delayMs = takeServerDelayMs(resp);
  if (delayMs > 0) {
    if (async) {
      x.deliveryTimer = globalThis.__csimSetTimeout(() => { x.deliveryTimer = null; completeWith(o, x, resp); }, delayMs);
      return;
    }
    const timeout = field(x, X_TIMEOUT);
    if (timeout > 0 && delayMs >= timeout) {
      setField(x, X_READY, DONE);
      setField(x, X_UPLOAD_ACTIVE, false);
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
  if (!globalThis.__dom.xhrTakeUpload(x.state) || !field(x, X_ASYNC)) return;
  if (success) {
    const t = field(x, X_UPLOAD_TOTAL);
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
  const generation = field(x, X_GENERATION);
  if (!current(x, generation)) return;
  const async = field(x, X_ASYNC);
  // (…the request done: the still-armed timeout cancelled, so it fires not after DONE)
  clearTimer(x, 'timeoutId');
  if (!resp) {
    setField(x, X_READY, DONE);
    setField(x, X_STATUS, 0);
    // A synchronous request's network error throws NetworkError from send(), no events; an async one's is its error
    // event — an interrupted upload's error / loadend between the DONE readystatechange and it
    // (send-network-error-async-events).
    if (!async) {
      setField(x, X_UPLOAD_ACTIVE, false);
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
  setField(x, X_STATUS, resp.status || 200);
  setField(x, X_STATUS_TEXT, resp.statusText || '');
  // (…the response's URL — a redirect's Location fragment its own, else the request's — which a document response takes;
  // `responseURL` the same without its fragment)
  const url = resp.url || field(x, X_URL);
  const at = url.indexOf('#');
  const responseURL = at < 0 ? url + field(x, X_FRAGMENT) : url;
  setField(x, X_RESPONSE_URL, at < 0 ? url : url.slice(0, at));
  // The response's header list, minus the forbidden response-header names getResponseHeader / getAllResponseHeaders
  // never reveal (getresponseheader-cookies).
  x.respHeaders = filteredHeaderList(resp.headers);
  // The body as it is read (`textResponse`, `responseObject`, `documentResponse`): its raw bytes where they came (a
  // non-UTF-8 charset / an XML response — browser.rb gates `body_bytes`) as a latin-1 byte string, so a binary payload
  // survives the engine's string boundary; else its text, already the UTF-8 decode; and the response's URL.
  x.body = {
    text:  resp.body == null ? '' : String(resp.body),
    bytes: resp.body_bytes ? resp.body_bytes : null,
    raw:   resp.body_bytes ? bytesToLatin1(resp.body_bytes) : null,
    url:   responseURL,
    final: null
  };
  // A synchronous request goes straight to DONE (abort-during-done sync: [1, 4]). LOADING is entered only as response
  // BYTES arrive — the received byte count, not the decoded chars: a binary or BOM-only body decodes to '' and still
  // enters it — so a body-less response goes HEADERS_RECEIVED → progress → DONE (send-no-response-event-order). A
  // readystatechange handler may abort() mid-sequence (abort-during-headers-received / -loading), its own DONE / abort /
  // loadend then standing.
  // (…`loaded` the body's BYTES: its raw ones', or — on the UTF-8 fast path — its text's UTF-8 length; not the decoded
  // characters)
  const total = x.body.raw !== null ? x.body.raw.length : utf8Length(x.body.text);
  if (async) {
    setField(x, X_READY, HEADERS_RECEIVED);
    fire(o, 'readystatechange');
    if (!current(x, generation)) return;
    if ((x.body.raw ?? x.body.text).length > 0) {
      setField(x, X_READY, LOADING);
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
  const cl = headerListGet(x.respHeaders, 'content-length');
  const progressTotal = cl != null && cl !== '' ? parseInt(cl, 10) || 0 : 0;
  const progress = { loaded: total, total: progressTotal, lengthComputable: progressTotal > 0 };
  if (async) fire(o, 'progress', progress);
  if (!current(x, generation)) return;
  setField(x, X_READY, DONE);
  fire(o, 'readystatechange');
  // (…a DONE handler's abort(): the sending branch's terminates, the DONE branch's resets to UNSENT)
  if (!current(x, generation) || readyOf(x) !== DONE) return;
  // (…loadend straight after load, as the end-of-body steps fire them — a load handler's open() notwithstanding)
  fire(o, 'load', progress);
  fire(o, 'loadend', progress);
}

// "Get a final MIME type" and "get a final encoding", as the body is first read — the engine's (xhr_state.rs `xhrFinal`):
// the type, whether it is an XML MIME type, the encoding's label. Made once: the response type is fixed by the time it
// is read (LOADING).
function finalOf(x) {
  const b = x.body;
  if (b.final === null) {
    const [mime, isXml, label] = globalThis.__dom.xhrFinal(x.state, headerListGet(x.respHeaders, 'content-type') || '');
    b.final = { mime, isXml, label };
  }
  return b.final;
}
// "Get a text response": the raw bytes decoded in the final encoding — its label, (the default responseType reading
// XML) its XML declaration's, UTF-8 — a BOM over all; else the body already IS the UTF-8 text. Made once: the response
// type is fixed by the time it is read (LOADING).
function textResponse(x, responseType) {
  const b = x.body;
  if (!b) return '';
  if (x.text === null) {
    const f = finalOf(x);
    x.text = b.raw === null ? b.text
      : f.label == null && responseType === '' && f.isXml ? decodeAsDocument(b.bytes, f.mime, null)[0]
      : decodeResponseBytes(b.raw, f.label);
  }
  return x.text;
}
// The response object of an arraybuffer / blob / json response type. (…json the UTF-8 decode of the raw bytes, not the
// charset-decoded text — the fast path's text already IS that; a blob's type the final MIME type — text/xml for an
// absent one, not octet-stream: overridemimetype-blob)
function responseObject(x, responseType) {
  const b = x.body;
  if (!b) return null;
  const jsonText = responseType === 'json' && b.raw !== null ? utf8DecodeBytes(b.raw) : textResponse(x, responseType);
  return responseValue(responseType, textResponse(x, responseType), b.raw ?? textResponse(x, responseType), finalOf(x).mime, jsonText);
}
// XHR "document response": built only for responseType 'document' of an HTML or XML-family final MIME type (any other
// — text/plain — a null document, responsexml-invalid-type), or the default responseType of an XML one (an HTML
// response under '' leaves responseXML null — a Turbo / AJAX HTML fetch pays no parse it won't read), as it is first
// read. A non-well-formed XML parse — a <parsererror> root, or none for an empty body — is null; its encoding the one it
// was decoded in; its URL the response's, its content type the final MIME type ("set a document response"). (DOMParser
// converts no declarative shadow root — the XHR behaviour the opt-in test asserts.)
function documentResponse(x, responseType) {
  if (x.responseXML !== undefined) return x.responseXML;
  const b = x.body, f = b && finalOf(x);
  const wanted = b && inDocument() &&
    ((responseType === 'document' && (f.mime === 'text/html' || f.isXml)) || (responseType === '' && f.isXml));
  x.responseXML = null;
  if (wanted) {
    try {
      const [text, encoding] = decodeAsDocument(b.bytes || latin1ToBytes(textResponse(x, responseType)), f.mime, f.label);
      const doc = parseDocument(text, f.isXml, f.mime, b.url, true);
      doc._encoding = encoding;
      const de = documentElementOf(doc);
      x.responseXML = f.isXml && (!de || de.namespaceURI === PARSERERROR_NS) ? null : doc;
    } catch (_) {}
  }
  return x.responseXML;
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
globalThis.__csim_deliverHijackedFetches = hostTask(function (responses) {
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
});
