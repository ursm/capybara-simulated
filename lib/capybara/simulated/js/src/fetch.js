// Fetch (Fetch Standard): Request, Response and the Body they share, generated from their IDL, and `fetch()` — the
// Request it constructs fetched over the synchronous Rack call, a controlling service worker's `fetch` handler, the
// in-process blob registry (`blob:`) or the data: URL processor. A Request's and a Response's state are their internal
// slots — a request's or a response's, Fetch's own word for them — which the driver's other modules (the service
// worker host, Cache Storage, the respondWith wire) reach through `requestOf` / `responseOf`, never a page-visible field.

import { bytesToArrayBuffer, bytesToLatin1, latin1ToBytes, utf8DecodeBytes, utf8EncodeBytes } from './bytes.js';
import { Blob, File, resolveBlobBytes } from './blob.js';
import { processDataUrl }       from './data-url.js';
import { serializeRequestBody, findHeaderKey } from './request-body.js';
import { FORBIDDEN_METHODS } from './header-rules.js';
import { buildSwRequest } from './sw-client.js';
import { parseMimeType, extractMimeType } from './mime.js';
import { location } from './location.js';
import { anySignal, signalOf } from './abort.js';
import { addAbortAlgorithm } from './events.js';
import { interfaceCheck, makeSlots, registerInterface, slotsOf, toUSVString } from './webidl.js';
import { appendHeader, copyHeaders, createHeaders, getHeader, headersGuard, networkHeaders, setHeadersGuard, wireEntries } from './headers.js';
import { FormData, formDataEntries } from './form-data.js';
import { URL, parseQuery } from './url.js';
import { ReadableStream, TextDecoderStream } from './streams.js';
import {
  convertRequestArguments, convertResponseArguments, installRequest, installResponse, toRequestInit
} from './generated/bindings.js';

// The header guard a request's Headers carries for a given fetch mode (so forbidden /
// non-no-cors-safelisted headers are dropped).
function guardForMode(mode) { return mode === 'no-cors' ? 'request-no-cors' : 'request'; }

// Fetch "normalize a method": byte-uppercase only a case-insensitive match for one of
// these; every other method (notably `patch`, `chicken`) keeps its original case. So
// `delete` → `DELETE` but `patch` stays `patch` — which matters for the case-sensitive
// CORS Allow-Methods check (cors-preflight-star).
const METHOD_NORMALIZE = new Set(['DELETE', 'GET', 'HEAD', 'OPTIONS', 'POST', 'PUT']);
// Fetch "redirect status" — the only codes Response.redirect() accepts.
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
// Fetch "null body status": a response of one has no body.
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);
// The messages' prefixes: the constructor's, and fetch()'s, which constructs a Request — on a window's or a worker's
// global.
const CONSTRUCT_REQUEST = "Failed to construct 'Request': ";
const CONSTRUCT_RESPONSE = "Failed to construct 'Response': ";
const executeFetch = () => `Failed to execute 'fetch' on '${globalThis.__csim_isWorker ? 'WorkerGlobalScope' : 'Window'}': `;
function normalizeMethod(method) {
  const upper = method.toUpperCase();
  return METHOD_NORMALIZE.has(upper) ? upper : method;
}
// An RFC 9110 method is a `token`; CONNECT / TRACE / TRACK are forbidden methods; a no-cors request takes only a
// CORS-safelisted one.
const METHOD_TOKEN        = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const CORS_SIMPLE_METHODS = new Set(['GET', 'HEAD', 'POST']);
// A response's status text: a reason-phrase — HTAB, SP, VCHAR, obs-text.
const REASON_PHRASE       = /^[\t\x20-\x7e\x80-\xff]*$/;

// Fetch's Request-constructor referrer processing: `''` → no-referrer (''); parse any
// other value against the base URL — a failure a TypeError; a referrer that is
// `about:client` OR cross-origin to the environment collapses to `about:client` (don't
// leak a cross-origin referrer); a same-origin URL is stored as its serialized href.
function processRequestReferrer(ref, prefix) {
  if (ref === '') return '';
  let p;
  try { p = new URL(ref, apiBaseURL()); }
  catch (_) { throw new TypeError(prefix + "Referrer '" + ref + "' is not a valid URL."); }
  const origin = location.origin;
  if ((p.protocol === 'about:' && p.pathname === 'client') || (origin && origin !== 'null' && p.origin !== origin)) {
    return 'about:client';
  }
  return p.href;
}
// The current settings object's API base URL: the realm's document base URI (which honours `<base href>`), falling
// back to its location — NOT a fixed top-level URL, so `new otherRealm.Request("rel")` resolves against otherRealm's
// base (request/multi-globals url-parsing).
const apiBaseURL = () => (globalThis.document && globalThis.document.baseURI) || location.href;

// "Extract a body" → a canonical latin-1 BYTE string. Mutates `headersObj` (a plain
// object) to add the body's implied Content-Type (text/plain for a string, the blob's
// type, multipart boundary, urlencoded, …). Reuses serializeRequestBody, which returns
// the body as a Uint8Array (bytes) or a USVString (text).
function extractBodyBytes(body, headersObj) {
  if (body == null) return '';
  const { body: out } = serializeRequestBody(body, headersObj);
  return typeof out === 'string' ? utf8EncodeBytes(out) : bytesToLatin1(out);
}
// Fetch "extract a body" of a BodyInit: `{bytes, stream, type}` — a ReadableStream its stream (neither disturbed nor
// locked, a TypeError after `prefix` otherwise — `unusable` its message; never for a keepalive request), anything else
// its bytes, and the Content-Type it implies, or null.
function extractBody(object, keepalive, prefix, unusable) {
  if (isReadableStream(object)) {
    if (keepalive) throw new TypeError(prefix + 'Keepalive request cannot have a ReadableStream body.');
    if (object.locked || object._disturbed) throw new TypeError(prefix + unusable(object));
    return { bytes: '', stream: object, type: null };
  }
  const h = {};
  const bytes = extractBodyBytes(object, h);
  const key = findHeaderKey(h, 'content-type');
  return { bytes, stream: null, type: key ? h[key] : null };
}
const isReadableStream = interfaceCheck('ReadableStream');

// Body `formData()`: parse the bytes per Content-Type into a FormData — this realm's, its entries pushed onto its list
// (not through an `append` a page may have replaced). urlencoded → the form-urlencoded parser's pairs;
// multipart/form-data → each part's Content-Disposition name + value (a `filename` part a File). Any other type
// rejects (TypeError). A field value keeps a leading BOM (unlike a whole-body text() decode) — url/urlencoded-parser,
// response-consume "…with BOM".
function parseBodyToFormData(byteStr, contentType) {
  const raw = contentType || '';
  const fd = new FormData();
  const entries = formDataEntries(fd);
  if (raw.toLowerCase().indexOf('application/x-www-form-urlencoded') === 0) {
    for (const pair of parseQuery(utf8DecodeBytes(byteStr, true))) entries.push(pair);
    return Promise.resolve(fd);
  }
  // Match the type case-insensitively but capture the boundary in its ORIGINAL case —
  // a multipart boundary is case-SENSITIVE, so lowercasing it breaks the body split.
  const m = raw.match(/multipart\/form-data;.*\bboundary=("?)([^";]+)\1/i);
  if (!m) return Promise.reject(new TypeError('Body cannot be decoded as form data, mime type is not multipart/form-data or application/x-www-form-urlencoded'));
  // A malformed body (a boundary not followed by "--" or CRLF, a part with no
  // Content-Disposition name, trailing bytes after the close delimiter, …) is a parse error —
  // formData() rejects (response-form-data "Validate buggy form data").
  return parseMultipartFormData(byteStr, '--' + m[2], entries)
    ? Promise.resolve(fd)
    : Promise.reject(new TypeError('Failed to parse multipart form data.'));
}
// The WHATWG "multipart/form-data" parser. `dash` is "--" + boundary. Fills `entries` (an
// entry list) and returns true on success, false on a parse error. Transport padding
// (SP/HTAB) is allowed after a boundary and after the close delimiter; the epilogue after
// the close is ignored.
function parseMultipartFormData(s, dash, entries) {
  const isPad = (c) => c === ' ' || c === '\t';
  // Skip the preamble to the first dash-boundary (typically at position 0).
  let pos = s.indexOf(dash);
  if (pos === -1) return false;
  pos += dash.length;
  while (true) {
    if (s.substr(pos, 2) === '--') {              // closing delimiter
      pos += 2;
      while (isPad(s[pos])) pos++;
      // Only transport padding + CRLF (then an ignored epilogue) or EOF may follow.
      return pos >= s.length || s.substr(pos, 2) === '\r\n';
    }
    while (isPad(s[pos])) pos++;                   // transport padding before the CRLF
    if (s.substr(pos, 2) !== '\r\n') return false; // a boundary must be followed by "--" or CRLF
    pos += 2;
    const hend = s.indexOf('\r\n\r\n', pos);       // part headers end at a blank line
    if (hend === -1) return false;
    const head = s.slice(pos, hend);
    pos = hend + 4;
    // Anchor to the start of a header line (multiline) so a longer field name like
    // "X-Content-Disposition:" / "X-Content-Type:" isn't mistaken for the real header.
    const cd   = head.match(/^content-disposition:[^\r\n]*/im);
    const name = cd && cd[0].match(/\bname="([^"]*)"/i);
    if (!name) return false;                       // every part must name a field
    const bend = s.indexOf('\r\n' + dash, pos);    // part body ends at CRLF + dash-boundary
    if (bend === -1) return false;                 // no closing boundary
    const value = s.slice(pos, bend);
    pos = bend + 2 + dash.length;
    const file = cd[0].match(/\bfilename="([^"]*)"/i);
    if (file) {
      const fct = head.match(/^content-type:\s*([^\r\n]+)/im);
      entries.push([name[1], new File([latin1ToBytes(value)], file[1], { type: fct ? fct[1].trim() : '' })]);
    } else {
      entries.push([name[1], utf8DecodeBytes(value, true)]);
    }
  }
}

// A body's ReadableStream is a readable BYTE stream over the canonical bytes, so a consumer
// can take a BYOB reader (getReader({mode:'byob'})) and read with an offset
// (response-consume-stream). An empty body enqueues nothing — a byte controller rejects a
// zero-length chunk — and just closes.
function createBodyByteStream(latin1) {
  const u8 = latin1ToBytes(latin1);
  return new ReadableStream({
    type: 'bytes',
    start(controller) {
      if (u8.length) controller.enqueue(u8);
      controller.close();
    }
  });
}

// Coerce a body-stream chunk (BufferSource) to a Uint8Array view over its bytes.
function chunkToU8(value) {
  if (value instanceof globalThis.Uint8Array) return value;
  if (value instanceof globalThis.ArrayBuffer) return new globalThis.Uint8Array(value);
  if (globalThis.ArrayBuffer.isView(value)) return new globalThis.Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return null;
}

// Fully read a body stream into a latin-1 byte string (concatenating its BufferSource
// chunks). A stream error (a source that errors on start/pull) propagates as the promise
// rejection (response-error-from-stream). A non-BufferSource chunk — a string / number /
// null — is a TypeError for BOTH a REQUEST body drained to the wire (request-upload.h2) and a
// RESPONSE body read (response-stream-bad-chunk "non-Uint8Array chunk … causes TypeError").
// On success the reader lock is DELIBERATELY kept: a fully-consumed body's stream stays locked,
// so a later `.body.getReader()` throws (response-stream-disturbed-5). The lock is released
// only on error.
export function collectBodyStream(stream) {
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  function pump() {
    return reader.read().then(({ done, value }) => {
      if (done) return;
      const u8 = value == null ? null : chunkToU8(value);
      if (!u8) throw new TypeError('Failed to read body: a ReadableStream chunk is not a BufferSource');
      chunks.push(u8); total += u8.length;
      return pump();
    });
  }
  return pump().then(() => {
    const merged = new globalThis.Uint8Array(total);
    let off = 0;
    for (const c of chunks) { merged.set(c, off); off += c.length; }
    return bytesToLatin1(merged);
  }, err => { try { reader.releaseLock(); } catch (_) {} throw err; });
}

// Fetch "clone a body" tees the body's stream with cloneForBranch2 = true: branch 1 keeps
// the original chunk objects, branch 2 gets a structured clone of each (response-clone "use
// structureClone for teed ReadableStreams"). The public tee() clones neither branch, so we
// tee, then wrap branch 2 to structuredClone every chunk as it flows.
function teeBodyForClone(stream) {
  const [a, b] = stream.tee();
  const reader = b.getReader();
  const cloned = new ReadableStream({
    pull(controller) {
      return reader.read().then(({ done, value }) => {
        if (done) { controller.close(); return; }
        controller.enqueue(globalThis.__csimStructuredClone(value));
      });
    },
    cancel(reason) { return reader.cancel(reason); }
  });
  return [a, cloned];
}

// ── Body ──
// A request's or a response's body, in its slots: `bodyNull` (no body), `bodyStream` (the ReadableStream `.body` is —
// minted lazily from the bytes, or the stream the body was made of), `bodyIsStream` (a GENUINE stream body, which a
// fetch drains to the wire and a service worker delivers incrementally, not a byte body's lazily-exposed stream),
// `bodyUsed` (a byte body read through the fast path), and its bytes: `bodyBytes`, or — a network response's, until
// first read — `raw`'s.
const bodyOf = (o) => slotsOf(o, 'Request') ?? slotsOf(o, 'Response');
// Canonical body bytes (latin-1). A network response's `body_bytes` are its bytes; without them its `body` already IS
// the bytes — an ASCII network body (text === bytes) or a synthetic byte string (a blob: / data: handler) — or a
// Uint8Array (the data: handler's).
function bytesOf(s) {
  if (s.bodyBytes === undefined) {
    const raw = s.raw;
    const b = raw.body_bytes ? raw.body_bytes : raw.body || '';
    s.bodyBytes = typeof b === 'string' ? b : bytesToLatin1(b);
  }
  return s.bodyBytes;
}
// `.body`: null for a null body; otherwise a single ReadableStream, created lazily from the canonical bytes (or the
// stream the body was built from) and cached so `x.body === x.body`.
function bodyStreamOf(s) {
  if (s.bodyNull) return null;
  if (!s.bodyStream) {
    s.bodyStream = createBodyByteStream(bytesOf(s));
    // If the byte body was ALREADY consumed via the fast path, the exposed stream must reflect that: lock it (a
    // fully-read body keeps its reader) so `.body` is non-null but `.body.getReader()` throws and a re-read rejects
    // (response-stream-disturbed-5).
    if (s.bodyUsed) s.bodyStream.getReader();
  }
  return s.bodyStream;
}
// `.bodyUsed`: a null body is never used; a streamed body tracks the stream's disturbed bit; an as-yet-unstreamed byte
// body tracks the fast-path flag (which survives a later `.body`, a fresh stream).
function bodyUsedOf(s) {
  if (s.bodyNull) return false;
  if (s.bodyUsed) return true;
  return s.bodyStream ? s.bodyStream._disturbed === true : false;
}
// Fetch "unusable": a body that is disturbed or locked.
const bodyUnusable = (s) => bodyUsedOf(s) || (s.bodyStream !== null && s.bodyStream.locked);
// Mark a body consumed: the fast-path flag AND an already-exposed stream locked, so `bodyUsed` and read-usability stay
// in sync (a later read / construct from it then rejects). Used when a source Request's body is transferred.
function markBodyConsumed(s) {
  s.bodyUsed = true;
  const stream = s.bodyStream;
  if (stream && !stream.locked && stream._disturbed !== true) { try { stream.getReader(); } catch (_) { /* already locked */ } }
}
// The body's Content-Type — a Request's or a Response's headers'.
const contentTypeOf = (s) => getHeader(s.headers, 'content-type') || '';
// Fetch "consume body": an unusable body rejects (a disturbed or locked stream, a byte body read once) — as does a
// response whose fetch was aborted, with the abort reason (abort/general "response.<method>() rejects if already
// aborted"; a Request's own read is unaffected by its signal, abort/request); then `fn` of the bytes. A streamed body is
// read fully and chains onto that (its errors propagate — response-error-from-stream); otherwise the bytes are known at
// once and `fn` runs in ONE promise, no extra microtask hop (the reject-vs-next-microtask ordering abort/general
// measures). The choice keys off `bodyStream`, state we own — not a `.then` probe a poisoned Object.prototype.then would
// answer. A synchronous throw from `fn` (JSON.parse of a non-JSON body) rejects. Chrome's messages, after `member`'s.
function consumeBody(o, member, fn) {
  const s = bodyOf(o);
  if (s.fetchSignal && s.fetchSignal.aborted) return Promise.reject(s.fetchSignal.reason);
  const unusable = (why) => Promise.reject(new TypeError(`Failed to execute '${member}' on '${requestOf(o) ? 'Request' : 'Response'}': body stream ${why}`));
  if (s.bodyNull) {
    // (…a null body reads as empty, repeatably — request-consume-empty)
    try { return Promise.resolve(fn('')); } catch (e) { return Promise.reject(e); }
  }
  const stream = s.bodyStream;
  if (stream) {
    if (stream._disturbed) return unusable('already read');
    if (stream.locked) return unusable('is locked');
    return collectBodyStream(stream).then(fn);
  }
  if (s.bodyUsed) return unusable('already read');
  s.bodyUsed = true;
  try { return Promise.resolve(fn(bytesOf(s))); } catch (e) { return Promise.reject(e); }
}
// Fetch "create a proxy" of a body's stream: a stream of this realm reading `stream` (any realm's) — which locks it —
// its errors and its end passed on, a cancel of it the source's (so an aborted fetch cancels the source stream). A
// byte stream's proxy is one too (a BYOB reader takes it): its end also answers a read into a buffer still pending,
// which a byte controller's close() leaves unsettled.
function proxyStream(stream) {
  const bytes = stream._readableStreamController._controlledReadableByteStream === stream;
  const reader = stream.getReader();
  return new ReadableStream({
    type: bytes ? 'bytes' : undefined,
    pull: (controller) => reader.read().then(({ done, value }) => {
      if (!done) {
        controller.enqueue(value);
      } else {
        controller.close();
        if (bytes) controller.byobRequest?.respond(0);
      }
    }),
    cancel: (reason) => reader.cancel(reason)
  });
}
// Fetch "clone a body" into `c`'s slots: an exposed (or genuine) stream teed, branch 2 structure-cloning its chunks; a
// byte body not yet streamed shares the bytes, each minting its own stream.
function cloneBody(s, c) {
  c.bodyNull = s.bodyNull;
  c.bodyBytes = s.bodyBytes;
  c.bodyUsed = false;
  c.bodyStream = null;
  c.bodyIsStream = false;
  if (s.bodyStream) {
    const [a, b] = teeBodyForClone(s.bodyStream);
    s.bodyStream = a;
    c.bodyStream = b;
    c.bodyIsStream = s.bodyIsStream;
  }
}
// A Response's body read whole (Fetch "consume body") — the driver's own reads, of the bytes a respondWith, a Cache
// Storage put or a frame's navigation carries and of an event stream's text, not through an `arrayBuffer()` / `text()`
// a page may have replaced.
export const responseBytes = (resp) => consumeBody(resp, 'arrayBuffer', latin1ToBytes);
export const responseText = (resp) => consumeBody(resp, 'text', (b) => utf8DecodeBytes(b));
const body = {
  get_body: (o) => bodyStreamOf(bodyOf(o)),
  get_bodyUsed: (o) => bodyUsedOf(bodyOf(o)),
  arrayBuffer: (o) => consumeBody(o, 'arrayBuffer', bytesToArrayBuffer),
  blob: (o) => consumeBody(o, 'blob', (b) => new Blob([latin1ToBytes(b)], { type: extractMimeType(contentTypeOf(bodyOf(o))) })),
  bytes: (o) => consumeBody(o, 'bytes', latin1ToBytes),
  formData: (o) => consumeBody(o, 'formData', (b) => parseBodyToFormData(b, extractMimeType(contentTypeOf(bodyOf(o))))),
  // (…JSON.parse of an empty body throws: rejects)
  json: (o) => consumeBody(o, 'json', (b) => JSON.parse(utf8DecodeBytes(b))),
  text: (o) => consumeBody(o, 'text', (b) => utf8DecodeBytes(b)),
  // (…its stream piped through a UTF-8 TextDecoderStream, whatever its Content-Type says — a closed empty one for a
  // null body — an unusable body a TypeError thrown: Fetch §5.3)
  textStream(o) {
    const s = bodyOf(o);
    if (bodyUnusable(s)) throw new TypeError(`Failed to execute 'textStream' on '${requestOf(o) ? 'Request' : 'Response'}': body stream already read`);
    const stream = bodyStreamOf(s);
    if (stream === null) return new ReadableStream({ start(c) { c.close(); } });
    return stream.pipeThrough(new TextDecoderStream());
  }
};

// ── Request ──
export const requestOf = (o) => slotsOf(o, 'Request');
registerInterface('Request', (o) => requestOf(o) !== undefined);
export class Request {
  constructor(input, init) {
    [input, init] = convertRequestArguments(arguments);
    constructRequest(this, input, init, CONSTRUCT_REQUEST);
  }
}
// A request's slots, of one shape whoever makes them: its URL and the rest of `r`'s — a new request's, or the source
// request's (the navigation's too: the navigating frame's origin, the redirect chain's latched Sec-Fetch-Site seed
// and Origin taint, the ancestor chain's cookie verdict) — and the signal, headers and body the constructor sets.
const NEW_REQUEST = {
  method: 'GET', mode: null, credentials: 'same-origin', cache: 'default', redirect: 'follow', referrer: 'about:client',
  referrerPolicy: '', integrity: '', keepalive: false, destination: '', isReloadNavigation: false,
  isHistoryNavigation: false, initiator: undefined, siteSeed: undefined, originNull: undefined, cookieCrossSite: undefined
};
function requestFields(url, r) {
  return {
    url, method: r.method, mode: r.mode, credentials: r.credentials, cache: r.cache, redirect: r.redirect,
    referrer: r.referrer, referrerPolicy: r.referrerPolicy, integrity: r.integrity, keepalive: r.keepalive,
    destination: r.destination, isReloadNavigation: r.isReloadNavigation, isHistoryNavigation: r.isHistoryNavigation,
    initiator: r.initiator, siteSeed: r.siteSeed, originNull: r.originNull, cookieCrossSite: r.cookieCrossSite,
    signal: null, headers: null, bodyBytes: '', bodyNull: true, bodyUsed: false, bodyStream: null, bodyIsStream: false,
    blobSnapshot: null
  };
}
// Whether a RequestInit has a member (Fetch "init is not empty"): the converted dictionary holds the members given.
function initIsEmpty(init) {
  for (const _ in init) return false;
  return true;
}
// The Request constructor's steps (Fetch "new Request(input, init)", §5.4) on `o`, its arguments converted (`input` a
// string or a Request, `init` a RequestInit) — fetch()'s, which constructs one, too: `prefix` the messages'.
// (`navigation`: a navigation's request, its URL HTML's navigate algorithm's — which no Request constructor's check
// refuses.)
function constructRequest(o, input, init, prefix, navigation = false) {
  const from = typeof input === 'string' ? undefined : requestOf(input);
  let s, fallbackMode = null, sourceSignal = null;
  if (from === undefined) {
    // (…a string parsed against the API base URL — an unparseable one, or one with credentials, a TypeError)
    let parsed;
    try { parsed = new URL(input, apiBaseURL()); }
    catch (_) { throw new TypeError(prefix + 'Failed to parse URL from ' + input); }
    if (!navigation && (parsed.username !== '' || parsed.password !== '')) {
      throw new TypeError(prefix + 'Request cannot be constructed from a URL that includes credentials: ' + input);
    }
    s = makeSlots(o, 'Request', requestFields(parsed.href, NEW_REQUEST));
    fallbackMode = 'cors';
  } else {
    // (…a Request's request copied — its navigation's slots too — and its signal followed)
    s = makeSlots(o, 'Request', requestFields(from.url, from));
    sourceSignal = from.signal;
  }
  if (init.window !== undefined && init.window !== null) throw new TypeError(prefix + "'window' must be null");
  const nonEmpty = !initIsEmpty(init);
  if (nonEmpty) {
    // A NON-EMPTY init detaches the request from a source Request's navigation: mode 'navigate' → 'same-origin', the
    // reload / history flags unset, origin and referrer reset to "client", referrer policy cleared, the URL list
    // collapsed (dropping the redirect chain's seed and taint). So a service worker's `new Request(event.request,
    // {mode})` re-derives everything from its own global, while `fetch(event.request)` / clone() keep the navigation's
    // request exactly. (The origin is reset only where the source WAS a navigation — it carried an initiator.)
    if (s.mode === 'navigate') s.mode = 'same-origin';
    s.isReloadNavigation = false;
    s.isHistoryNavigation = false;
    if (s.initiator != null) {
      const here = location.origin;
      s.initiator = here && here !== 'null' ? here : null;
    }
    s.siteSeed = null;
    s.originNull = false;
    s.referrer = 'about:client';
    s.referrerPolicy = '';
  }
  if (init.referrer !== undefined) s.referrer = processRequestReferrer(init.referrer, prefix);
  if (init.referrerPolicy !== undefined) s.referrerPolicy = init.referrerPolicy;
  const mode = init.mode !== undefined ? init.mode : fallbackMode;
  if (mode === 'navigate') throw new TypeError(prefix + "Cannot construct a Request with a RequestInit whose mode member is set as 'navigate'.");
  if (mode !== null) s.mode = mode;
  if (init.credentials !== undefined) s.credentials = init.credentials;
  if (init.cache !== undefined) s.cache = init.cache;
  if (s.cache === 'only-if-cached' && s.mode !== 'same-origin') {
    throw new TypeError(prefix + "'only-if-cached' can be set only with 'same-origin' mode");
  }
  if (init.redirect !== undefined) s.redirect = init.redirect;
  if (init.integrity !== undefined) s.integrity = init.integrity;
  if (init.keepalive !== undefined) s.keepalive = init.keepalive;
  if (init.method !== undefined) {
    if (!METHOD_TOKEN.test(init.method)) throw new TypeError(prefix + "'" + init.method + "' is not a valid HTTP method.");
    if (FORBIDDEN_METHODS.has(init.method.toUpperCase())) throw new TypeError(prefix + "'" + init.method + "' HTTP method is unsupported.");
    s.method = normalizeMethod(init.method);
  }
  const signal = init.signal !== undefined ? init.signal : sourceSignal;
  // The request's signal is always a NEW AbortSignal that FOLLOWS the source — init's, else the input Request's (a
  // null init.signal removes it) — so a clone reflects the source's aborted state without aliasing it (abort/general
  // "Signal on request object").
  s.signal = anySignal(signal ? [signal] : []);
  // Its headers: a copy of the source request's header list (or none), guarded by the mode — a no-cors request takes a
  // CORS-safelisted method alone — and, for a non-empty init, emptied and filled again with init's headers or that
  // copy, through the guard (headers-forbidden-override / -no-cors).
  if (s.mode === 'no-cors' && !CORS_SIMPLE_METHODS.has(s.method)) {
    throw new TypeError(prefix + "'" + s.method + "' is unsupported in no-cors mode.");
  }
  const guard = guardForMode(s.mode);
  if (init.headers !== undefined) s.headers = createHeaders(init.headers, guard, prefix);
  else if (from !== undefined) s.headers = copyHeaders(from.headers, guard, nonEmpty);
  else s.headers = createHeaders(undefined, guard, prefix);
  // Its body: init's, extracted (its Content-Type appended where the headers give none), else the source request's —
  // else none.
  const initBody = init.body ?? null;
  const inputHasBody = from !== undefined && !from.bodyNull;
  if ((initBody !== null || inputHasBody) && (s.method === 'GET' || s.method === 'HEAD')) {
    throw new TypeError(prefix + 'Request with GET/HEAD method cannot have body.');
  }
  if (initBody !== null) {
    const { bytes, stream, type } = extractBody(initBody, s.keepalive, prefix, (stream) => `The provided ReadableStream is ${stream.locked ? 'locked' : 'disturbed'}`);
    // (…a stream body only with an explicit duplex 'half' — RequestDuplex has no other value — and in mode
    // same-origin or cors: it needs a CORS preflight)
    if (stream !== null) {
      if (init.duplex === undefined) throw new TypeError(prefix + 'The `duplex` member must be specified for a request with a streaming body');
      // (…Chrome's message, its missing space and all)
      if (s.mode !== 'same-origin' && s.mode !== 'cors') {
        throw new TypeError(prefix + 'If request is made from ReadableStream, mode should be"same-origin" or "cors"');
      }
      s.bodyStream = stream;
      s.bodyIsStream = true;
    }
    s.bodyBytes = bytes;
    s.bodyNull = false;
    if (type !== null && getHeader(s.headers, 'content-type') === null) appendHeader(s.headers, 'content-type', type);
  } else if (inputHasBody) {
    // (…the source request's own, which must be usable; its bytes carried as they are — a re-serialized FormData would
    // mint a boundary no longer matching the copied Content-Type — and a GENUINE stream proxied, which disturbs the
    // source: its body is this request's now, as Chrome's `bodyUsed` says)
    if (bodyUnusable(from)) throw new TypeError(prefix + 'Cannot construct a Request with a Request object that has already been used.');
    s.bodyBytes = from.bodyBytes;
    s.bodyNull = false;
    if (from.bodyIsStream) {
      s.bodyStream = proxyStream(from.bodyStream);
      s.bodyIsStream = true;
      from.bodyUsed = true;
    }
  }
  // A blob: URL's bytes referenced at construction (the Request "receives" the URL here), so a later
  // URL.revokeObjectURL still resolves — and carried by a copy, so a clone still fetches after it.
  s.blobSnapshot = from !== undefined ? from.blobSnapshot : s.url.startsWith('blob:') ? resolveBlobBytes(s.url) : null;
  // A source Request with a byte body is DISTURBED by the construction once it has fully succeeded — whether or not
  // init's body replaced its own (request-disturbed); one that threw above leaves it untouched.
  if (from !== undefined && !from.bodyNull && !from.bodyIsStream && !bodyUsedOf(from)) markBodyConsumed(from);
  return o;
}
installRequest(Request, {
  get_method: (r) => requestOf(r).method,
  get_url: (r) => requestOf(r).url,
  get_headers: (r) => requestOf(r).headers,
  get_destination: (r) => requestOf(r).destination,
  get_referrer: (r) => requestOf(r).referrer,
  get_referrerPolicy: (r) => requestOf(r).referrerPolicy,
  get_mode: (r) => requestOf(r).mode,
  get_credentials: (r) => requestOf(r).credentials,
  get_cache: (r) => requestOf(r).cache,
  get_redirect: (r) => requestOf(r).redirect,
  get_integrity: (r) => requestOf(r).integrity,
  get_keepalive: (r) => requestOf(r).keepalive,
  get_isReloadNavigation: (r) => requestOf(r).isReloadNavigation,
  get_isHistoryNavigation: (r) => requestOf(r).isHistoryNavigation,
  get_signal: (r) => requestOf(r).signal,
  get_duplex: () => 'half',
  // Fetch "clone a request": its request copied — its headers with their guard (a service worker's
  // `event.request.clone()` stays immutable) — its body cloned, and a signal following its own.
  clone(r) {
    const s = requestOf(r);
    if (bodyUnusable(s)) throw new TypeError("Failed to execute 'clone' on 'Request': Request body is already used");
    const c = Object.create(Request.prototype);
    const cs = makeSlots(c, 'Request', { ...s, headers: copyHeaders(s.headers, headersGuard(s.headers), false), signal: anySignal([s.signal]) });
    cloneBody(s, cs);
    return c;
  },
  ...body
});
// The request a form submission's navigation of a frame fetches (Fetch "create a navigation request"): of `url`
// (absolute), `method`, a plain header map and a BodyInit or null — in mode 'navigate', which no RequestInit may give,
// credentials 'include', destination 'iframe'.
function navigationRequest(url, method, headers, bodyInit) {
  const o = Object.create(Request.prototype);
  constructRequest(o, url, { method, headers: Object.entries(headers || {}), ...(bodyInit != null ? { body: bodyInit } : {}) }, '', true);
  Object.assign(requestOf(o), { mode: 'navigate', credentials: 'include', destination: 'iframe' });
  return o;
}

// ── Response ──
export const responseOf = (o) => slotsOf(o, 'Response');
registerInterface('Response', (o) => responseOf(o) !== undefined);
export class Response {
  constructor(body, init) {
    [body, init] = convertResponseArguments(arguments);
    initResponse(this, init, body === null ? null : extractBody(body, false, CONSTRUCT_RESPONSE, () => 'Response body object should not be disturbed or locked'), CONSTRUCT_RESPONSE);
  }
}
// A response URL with its fragment removed (Fetch serializes a response's URL with the exclude-fragment flag). Parsing
// also normalizes the URL (`host:8000#x` → `host:8000/`); an unparseable / synthetic URL falls back to a plain
// `#`-truncation.
function responseUrlNoFragment(u) {
  if (!u) return '';
  try { const p = new URL(u); p.hash = ''; return p.href; }
  catch (_) { const i = u.indexOf('#'); return i < 0 ? u : u.slice(0, i); }
}
// A response's slots: its type, URL (fragment excluded), status, status text, `redirected`, headers, body — and, for
// a network response, `raw` (what the network handed back: the body until it is first read, the opaque render, the
// redirect a navigation follows) and `fetchSignal` (its fetch's, whose abort rejects a body read).
function responseSlots(o, fields) {
  return makeSlots(o, 'Response', {
    type: 'default', url: '', status: 200, statusText: '', redirected: false, raw: null, fetchSignal: null,
    bodyBytes: '', bodyNull: true, bodyUsed: false, bodyStream: null, bodyIsStream: false, ...fields
  });
}
// Fetch "initialize a response" (§5.5) of `o`, `init` a ResponseInit converted, `body` an extracted one or null: the
// status a RangeError outside 200–599, the status text a TypeError where it is no reason-phrase, the headers filled
// through the 'response' guard (which drops set-cookie / set-cookie2 — header-setcookie), and a body a TypeError for a
// null body status, its Content-Type appended where the headers give none.
function initResponse(o, init, body, prefix) {
  if (init.status < 200 || init.status > 599) {
    throw new RangeError(prefix + 'The status provided (' + init.status + ') is outside the range [200, 599].');
  }
  if (!REASON_PHRASE.test(init.statusText)) throw new TypeError(prefix + 'Invalid statusText');
  const headers = createHeaders(init.headers, 'response', prefix);
  const s = responseSlots(o, { status: init.status, statusText: init.statusText, headers });
  if (body === null) return o;
  if (NULL_BODY_STATUSES.has(init.status)) throw new TypeError(prefix + 'Response with null body status cannot have body');
  s.bodyNull = false;
  s.bodyBytes = body.bytes;
  if (body.stream !== null) {
    s.bodyStream = body.stream;
    s.bodyIsStream = true;
  }
  if (body.type !== null && getHeader(headers, 'content-type') === null) appendHeader(headers, 'content-type', body.type);
  return o;
}
// A response from the network — or the service worker's respondWith wire, the blob: and data: handlers, a Cache
// Storage entry — `raw` (status, statusText, headers, body / body_bytes, url, type, redirected, body_null,
// bodyStream…) for the request `url`, `signal` its fetch's. Its headers are network-final, taken VERBATIM, NOT through
// append's normalization (header-value-combining), and immutable (response-headers-guard). An opaque (no-cors
// cross-origin) response has an empty URL list; otherwise the response's URL, else the request's.
export function responseFromRaw(raw, url, signal) {
  const o = Object.create(Response.prototype);
  const stream = raw.bodyStream || null;
  responseSlots(o, {
    type: raw.type || 'basic',
    url: raw.type === 'opaque' ? '' : responseUrlNoFragment(raw.url || url),
    status: raw.status,
    // (…the HTTP reason phrase, resolved Ruby-side: a custom one, else the status code's standard reason)
    statusText: raw.statusText != null ? raw.statusText : '',
    redirected: !!raw.redirected,
    headers: networkHeaders(raw.headers),
    raw,
    fetchSignal: signal || null,
    // (…its bytes read off `raw` at first read; a null body — a null body status, a HEAD — flagged Ruby-side)
    bodyBytes: undefined,
    bodyNull: !!raw.body_null,
    // (…a streaming service worker respondWith's body, delivered incrementally: the client reassembles it as a live
    // stream — sw-client.js — which reads pull from as chunks arrive)
    bodyStream: stream,
    bodyIsStream: stream !== null
  });
  // Aborting the fetch cancels such a body (Fetch "abort a fetch") — observably in the SW's source stream (readable-stream
  // abort) EVEN while the page reads it, a locked stream, whose public `cancel()` would throw: its `__csimAbort`
  // (sw-client.js) routes the cancel to the SW and errors the body with the abort reason.
  if (stream !== null && signal) {
    addAbortAlgorithm(signal, () => {
      const reason = signalOf(signal).reason;
      if (typeof stream.__csimAbort === 'function') stream.__csimAbort(reason);
      else try { stream.cancel(reason); } catch (_) {}
    });
  }
  return o;
}
installResponse(Response, {
  get_type: (r) => responseOf(r).type,
  get_url: (r) => responseOf(r).url,
  get_redirected: (r) => responseOf(r).redirected,
  get_status: (r) => responseOf(r).status,
  get_ok: (r) => { const s = responseOf(r); return s.status >= 200 && s.status < 300; },
  get_statusText: (r) => responseOf(r).statusText,
  get_headers: (r) => responseOf(r).headers,
  // Fetch "clone a response": its response copied — its headers with their guard (a script's mutable 'response' one
  // stays mutable, response-clone) — and its body cloned.
  clone(r) {
    const s = responseOf(r);
    if (bodyUnusable(s)) throw new TypeError("Failed to execute 'clone' on 'Response': Response body is already used");
    const c = Object.create(Response.prototype);
    const cs = makeSlots(c, 'Response', { ...s, headers: copyHeaders(s.headers, headersGuard(s.headers), false) });
    cloneBody(s, cs);
    return c;
  },
  // A network error: status 0, no body, immutable headers (static-error).
  error: () => {
    const o = Object.create(Response.prototype);
    responseSlots(o, { type: 'error', status: 0, headers: networkHeaders(null) });
    return o;
  },
  // A redirect to `url`, parsed against the API base URL (a TypeError where it is none), of a redirect status (a
  // RangeError otherwise): no body, its Location the URL, its headers immutable (response-static-redirect).
  redirect(self, url, status) {
    let parsed;
    try { parsed = new URL(url, apiBaseURL()); }
    catch (_) { throw new TypeError("Failed to execute 'redirect' on 'Response': Failed to parse URL from " + url); }
    if (!REDIRECT_STATUSES.has(status)) throw new RangeError("Failed to execute 'redirect' on 'Response': Invalid status code");
    const o = Object.create(Response.prototype);
    responseSlots(o, { status, headers: networkHeaders({ location: parsed.href }) });
    return o;
  },
  // `data` serialized to JSON bytes (a TypeError where it serializes to nothing — a bare Symbol / function,
  // response-static-json; a BigInt makes JSON.stringify itself throw), a response of them, application/json where the
  // headers give no Content-Type.
  static_json(self, data, init) {
    const text = JSON.stringify(data);
    if (text === undefined) throw new TypeError("Failed to execute 'json' on 'Response': The data is not JSON serializable");
    const o = Object.create(Response.prototype);
    const body = { bytes: utf8EncodeBytes(text), stream: null, type: 'application/json' };
    return initResponse(o, init, body, "Failed to execute 'json' on 'Response': ");
  },
  ...body
});
// Subresource Integrity (SRI). Per the spec, only the STRONGEST hash algorithm
// present in the metadata is enforced, and the body passes if it matches ANY of
// that algorithm's digests. Comparison is padding-insensitive and accepts both
// base64 and base64url. Returns true when valid OR when there's no usable
// metadata (an unparseable / empty integrity is not a check).
const SRI_ALGO   = { sha256: 'SHA-256', sha384: 'SHA-384', sha512: 'SHA-512' };
const SRI_RANK   = { sha256: 1, sha384: 2, sha512: 3 };
function sriNormalizeB64(s) { return String(s).replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, ''); }
function sriValidate(bodyBytes, metadata) {
  const entries = [];
  for (const tok of String(metadata).trim().split(/\s+/)) {
    const dash = tok.indexOf('-');
    if (dash <= 0) continue;
    const alg = tok.slice(0, dash).toLowerCase();
    // An entry is `hash-expression *("?" option-expression)`; the options are
    // discarded (they don't affect the digest comparison).
    let hash = tok.slice(dash + 1);
    const q = hash.indexOf('?');
    if (q >= 0) hash = hash.slice(0, q);
    if (SRI_ALGO[alg] && hash) entries.push({ alg, hash });
  }
  if (!entries.length) return true;                    // no usable metadata → no check
  let rank = 0;
  for (const e of entries) if (SRI_RANK[e.alg] > rank) rank = SRI_RANK[e.alg];
  const enforced = entries.filter(e => SRI_RANK[e.alg] === rank);
  let computed;
  try {
    const src = bodyBytes || '';
    const arr = new Array(src.length);
    for (let i = 0; i < src.length; i++) arr[i] = src.charCodeAt(i) & 0xff;
    const digest = globalThis.__csim_subtleDigest(SRI_ALGO[enforced[0].alg], arr);
    computed = sriNormalizeB64(globalThis.__csimBtoa(String.fromCharCode.apply(null, digest)));
  } catch (_) { return false; }
  return enforced.some(e => sriNormalizeB64(e.hash) === computed);
}


// ── fetch() ──
// Fetch "fetch(input, init)" (§5.6): its arguments converted, a Request constructed of them — a failure of either
// rejects (and before anything else: abort/general "constructor takes priority") — then, its signal already aborted,
// "abort the fetch": the promise rejected with the reason SYNCHRONOUSLY, before the fetch task and any pending
// microtask, a ReadableStream body cancelled with it (abort/general "Readable stream synchronously cancels …"), no
// request made. Otherwise the request fetched.
// (…the driver's own callers — Cache's addAll — this function, not the global a page may replace)
export function fetch(input) {
  const prefix = executeFetch();
  let request;
  try {
    if (arguments.length < 1) throw new TypeError(prefix + '1 argument required, but only 0 present.');
    if (typeof input !== 'string' && requestOf(input) === undefined) input = toUSVString(input, prefix);
    request = constructRequest(Object.create(Request.prototype), input, toRequestInit(arguments[1], prefix), prefix);
  } catch (e) { return Promise.reject(e); }
  const s = requestOf(request);
  if (s.signal.aborted) {
    if (s.bodyIsStream && !s.bodyStream.locked) {
      try { const p = s.bodyStream.cancel(s.signal.reason); if (p && p.catch) p.catch(() => {}); } catch (_) {}
    }
    return Promise.reject(s.signal.reason);
  }
  return fetchRequest(s, 'fetch');
}
globalThis.fetch = fetch;
// `navigator.sendBeacon`'s fetch: a keepalive, credentialed POST of `data`, its Resource Timing initiator 'beacon'.
export function beacon(url, data) {
  const request = constructRequest(Object.create(Request.prototype), url, { method: 'POST', body: data, keepalive: true, credentials: 'include' }, '');
  return fetchRequest(requestOf(request), 'beacon');
}
// A form submission's navigation of a frame (dom-nodes.js), whose mode 'navigate' routes the fetch through the
// navigation's service worker interception: the Response, or a rejection.
export function navigationFetch(url, method, headers, bodyInit) {
  try {
    return fetchRequest(requestOf(navigationRequest(url, method, headers, bodyInit)), null);
  } catch (e) { return Promise.reject(e); }
}

// Fetch the request `s` (a Request's slots): `timingInitiator` its Resource Timing entry's initiator type, or null
// (a navigation records none).
function fetchRequest(s, timingInitiator) {
  const timingStart = globalThis.__csimPerformance.now();
  const { url, method, mode, credentials, redirect, cache, referrerPolicy, keepalive } = s;
  const signal = s.signal;
  // Performing a fetch disturbs the request's body (Fetch reads it to the wire) — synchronously, before any scheme
  // branch (blob: / data: return early below), so `bodyUsed` is true the instant fetch() returns. A GENUINE stream body
  // is drained (and disturbed) by the wire read below, so it is only flagged here — locking it now would fail that
  // read.
  if (!s.bodyNull) {
    if (s.bodyIsStream) s.bodyUsed = true;
    else markBodyConsumed(s);
  }
  // Subresource-integrity metadata for the response body (validated at resolve).
  const integrityMeta = s.integrity;
  // The request's referrer, as Ruby takes the referrer source (before the policy is applied): '' no-referrer;
  // 'about:client' the current settings object's URL — the document in a window, the SCRIPT URL in a worker / service
  // worker (so a SW's `new Request(event.request, init)` re-fetch reports its own script, not the top document
  // rack_fetch's @current_url would assume); any other value as the constructor resolved it. compute_referrer then
  // applies referrerPolicy (cors-preflight-referrer).
  const referrer = s.referrer === 'about:client' ? location.href || undefined : s.referrer;
  // A SW re-issuing a navigation (`fetch(event.request)`) threads the navigating frame's origin + the redirect chain's
  // Sec-Fetch-Site seed / Origin taint to the network hop; a plain request carries none. Absent values are `null`,
  // which round-trips to Ruby `nil`. The navigation's destination ('document' / 'iframe') rack_fetch reports as
  // Sec-Fetch-Dest and gates the Lax cookie exception (top-level only) on — meaningful only while the mode stayed
  // 'navigate'.
  const navInitiator   = s.initiator || null;
  const navSiteSeed    = s.siteSeed || null;
  const navOriginNull  = s.originNull ? true : null;
  const navCookieCross = s.cookieCrossSite ? true : null;
  const navDest        = s.destination || null;
  // The header list on the wire: each name in the casing it was first given — a server / echo handler sees the
  // author's (request-headers-case) — the plain map __rackFetch wants.
  const headers = {};
  for (const [name, value] of wireEntries(s.headers)) headers[name] = value;
  // Fetch's default request headers: `Accept: */*` (NOT a document navigation's richer
  // Accept, which rack_fetch would otherwise fill in) and an `Accept-Language`, only
  // when the caller set neither. (Mirrors the XHR defaults in xhr.js.)
  if (getHeader(s.headers, 'accept') === null) headers['accept'] = '*/*';
  if (getHeader(s.headers, 'accept-language') === null) headers['accept-language'] = 'en-US,en;q=0.9';
  // NOTE: the fetch `Origin` request header (non-GET/HEAD) is deliberately NOT added
  // here — doing so changes how rack_fetch's CORS logic evaluates cross-origin
  // requests and regresses the fetch/api/cors cluster. It belongs with a holistic
  // CORS pass (aligning the Origin header with preflight/response-tainting), tracked
  // as backlog, not this narrow header change.
  if (typeof url === 'string' && url.startsWith('blob:')) {
    // A blob: URL only answers GET; any other method is a network error.
    const blobMethod = String(method || 'GET').toUpperCase();
    // The bytes the Request referenced at construction — so a `URL.revokeObjectURL(url)` issued right after (or,
    // for a Request made earlier, before) this fetch() still sees the resource.
    const snapshot = blobMethod !== 'GET' ? null : s.blobSnapshot;
    return new Promise(function (resolve, reject) {
      // Defer through the virtual clock to match the spec's fetch
      // task boundary — fetch resolves on a separate task, so awaiting
      // it yields control. Inline resolve would race ahead of any
      // intervening microtasks (Turbo Drive's render chain).
      globalThis.__csimSetTimeout(function () {
        if (signal && signal.aborted) { reject(signal.reason); return; }
        if (!snapshot) return reject(new TypeError('blob URL fetch failed: ' + url));
        // A blob's Content-Type is its type when it parses as a MIME, else empty — an
        // unparseable one ("invalid") yields "" (scheme-blob "invalid_type_blob"). The original
        // string is kept verbatim when valid (do NOT re-serialize — that would drop the space in
        // "multipart/form-data; boundary=…", response-consume "from FormData to blob").
        let ctype = snapshot.type || '';
        if (ctype && !parseMimeType(ctype)) ctype = '';
        resolve(responseFromRaw({
          status:     200,
          statusText: 'OK',
          body:       snapshot.bytes,
          headers:    { 'content-type': ctype, 'content-length': String((snapshot.bytes || '').length) },
          url
        }, url, signal));
      }, 0);
    });
  }
  if (typeof url === 'string' && url.startsWith('data:')) {
    // `data:` is resolved locally through the WHATWG data: URL processor (Discourse's PM
    // image extension fetches a pasted `data:image/png;base64,…` to wrap the bytes in a
    // File; going through Rack would fail). A malformed data: URL is a network error.
    return new Promise(function (resolve, reject) {
      globalThis.__csimSetTimeout(function () {
        if (signal && signal.aborted) { reject(signal.reason); return; }
        const parsed = processDataUrl(url);
        if (!parsed) { reject(new TypeError('Invalid data: URL: ' + url)); return; }
        // A HEAD request carries no body (status + headers only).
        const isHead = String(method || 'GET').toUpperCase() === 'HEAD';
        resolve(responseFromRaw({
          status:     200,
          statusText: 'OK',
          body:       isHead ? new globalThis.Uint8Array(0) : latin1ToBytes(parsed.body),
          headers:    { 'content-type': parsed.mimeType },
          url
        }, url, signal));
      }, 0);
    });
  }
  // The deferred rack call: queue the synchronous __rackFetch on a fetch task, carrying the
  // already-serialized body. Kept synchronous for every non-stream body so the fetch task is
  // registered in the same turn as the fetch() call (its ordering vs a synchronously-scheduled
  // timer is observable under the deterministic clock).
  const runRack = function (reqBody) {
    // keepalive: the request dispatches NOW, synchronously, onto a detached host
    // thread — the issuing realm may be mid-teardown (an unload/pagehide handler's
    // beacon) and no deferred task of its would ever run. The promise, if the realm
    // survives, resolves by polling the thread's one-shot result on normal ticks.
    // Controlled clients keep the SW-interception path (its async dispatch — a
    // keepalive THROUGH a service worker doesn't survive teardown yet; follow-up).
    if (keepalive && !(typeof globalThis.__csimSWControllerHandle === 'function' && (globalThis.__csimSWControllerHandle() | 0) > 0)) {
      return new Promise(function (resolve, reject) {
        let abs = url;
        try { abs = new URL(url, location.href || undefined).href; } catch (_) {}
        let id = -1;
        try {
          id = globalThis.__csim_keepaliveStart(normalizeMethod(method), abs, reqBody, headers, redirect, mode, credentials, referrerPolicy, referrer, cache, String(location.href || '')) | 0;
        } catch (_) { id = -1; }
        // -1 = the 64 KiB in-flight payload quota is exhausted (Fetch: "if the sum
        // of contentLength and inflightKeepaliveBytes is greater than 64 KiB, then
        // return a network error").
        if (id < 0) { reject(new TypeError('Failed to fetch: keepalive request over quota')); return; }
        const poll = function () {
          // BOUNDED DIVERGENCE: an abort rejects the promise, but the detached
          // thread still completes the transmission (a real browser aborts it);
          // abort/keepalive stays allowlisted on exactly this.
          if (signal && signal.aborted) { reject(signal.reason); return; }
          let r = null;
          try { r = globalThis.__csim_keepaliveTake(id); } catch (_) { r = null; }
          if (r && r.pending) { globalThis.__csimSetTimeout(poll, 0); return; }
          if (timingInitiator && typeof globalThis.__csimRecordResource === 'function') globalThis.__csimRecordResource({ name: url, initiatorType: timingInitiator, startTime: timingStart, resp: r });
          if (!r) { reject(new TypeError('Network request failed: ' + url)); return; }
          // Same SRI validation as the normal path — a keepalive fetch with an
          // `integrity` that mismatches must reject, not resolve.
          try {
            const kaResp = responseFromRaw(r, abs, signal);
            if (integrityMeta && (r.type === 'opaque' || !sriValidate(bytesOf(responseOf(kaResp)), integrityMeta))) {
              reject(new TypeError('Failed to fetch: integrity check failed for ' + url));
              return;
            }
            resolve(kaResp);
          } catch (e) { reject(e); }
        };
        globalThis.__csimSetTimeout(poll, 0);
      });
    }
    return new Promise(function (resolve, reject) {
      globalThis.__csimSetTimeout(function () {
        if (signal && signal.aborted) { reject(signal.reason); return; }
        const finish = function (resp) {
          if (timingInitiator && typeof globalThis.__csimRecordResource === 'function') globalThis.__csimRecordResource({ name: url, initiatorType: timingInitiator, startTime: timingStart, resp });
          if (!resp) { reject(new TypeError('Network request failed: ' + url)); return; }
          try {
            const r = responseFromRaw(resp, url, signal);
            // Subresource integrity: reject a body that doesn't match its metadata.
            // An opaque (no-cors) response has no readable body to validate, so
            // non-empty integrity on it is a network error (blocked) per the spec.
            if (integrityMeta && (resp.type === 'opaque' || !sriValidate(bytesOf(responseOf(r)), integrityMeta))) {
              reject(new TypeError('Failed to fetch: integrity check failed for ' + url));
              return;
            }
            resolve(r);
          } catch (e) { reject(e); }
        };
        const doNetwork = function () {
          try { finish(globalThis.__rackFetch(normalizeMethod(method), url, reqBody, headers, redirect, mode, credentials, referrerPolicy, referrer, cache, navInitiator, navSiteSeed, navOriginNull, String(location.href || ''), navCookieCross, navDest)); }
          catch (e) { reject(e); }
        };
        // A NAVIGATION (mode 'navigate' — a form submission to a named frame) is controlled by the
        // registration covering its TARGET url, NOT the initiating client's controller: route it
        // through the unified navigation chain (frame_navigation_fetch — per-hop SW interception
        // with network fallback and redirect re-entry, exactly like a frame load), carrying the
        // form's method + body (the SW reads a POST body via `event.request.text()`). A null
        // return is a FAILED navigation (respondWith network error / redirect loop) — the chain
        // owns the network hop, so there is no fall-through here. The gate below checks only the
        // FIRST hop against THIS realm's registrations — a target whose hop 0 is uncontrolled
        // here takes the plain network path (its redirects then follow without per-hop
        // interception; a bounded gap, matching the pre-chain behavior).
        // NOT in a worker: a service worker's passthrough `fetch(event.request)` re-fetches a
        // request that still carries mode 'navigate', but per Handle Fetch it is a PLAIN fetch —
        // its 'manual' redirect mode yields an opaqueredirect (navigation-redirect-to-http), and
        // re-entering navigation interception from the SW's own thread would deadlock on itself.
        if (mode === 'navigate' && !globalThis.__csim_isWorker) {
          let navUrl = url;
          try { navUrl = new URL(url, location.href || undefined).href; } catch (_) {}
          if (globalThis.__csimSWMayInterceptNavigation && globalThis.__csimSWMayInterceptNavigation(navUrl)) {
            const navReferrer = location.href || '';
            const navCt = headers['Content-Type'] || headers['content-type'] || '';
            const m     = normalizeMethod(method);
            const navBody = (m === 'GET' || m === 'HEAD') ? '' : reqBody;
            const swNav = globalThis.__csim_frameNavigationFetch(navUrl, false, navReferrer, globalThis.__csimSecureAncestorChain(), m, navBody, navCt);
            if (!swNav) { reject(new TypeError('Failed to fetch: ' + url)); return; }
            finish(swNav);
            return;
          }
          doNetwork();
          return;
        }
        // Service Worker interception: a controlled client's request goes to the controlling SW's
        // `fetch` handler first. `respondWith` supplies the response; a fall-through (no handler /
        // no respondWith) or a gone SW drops to the network.
        const ctrl = globalThis.__csimSWControllerHandle && globalThis.__csimSWControllerHandle();
        if (ctrl) {
          // "Main fetch" rejects a `same-origin`-mode request to a cross-origin URL BEFORE "Handle
          // Fetch" (the service worker) runs — so it must be a network error WITHOUT ever reaching
          // the controlling SW (fetch-response-taint cross-origin "should fail"). Compared against
          // THIS client realm's own origin (a controlled iframe's, not the top window's). A
          // non-controlled client gets the same rejection inside rack_fetch. data:/blob: (opaque
          // origin, http(s)-only gate) are handled by their own processors below.
          if (mode === 'same-origin') {
            let tgt = null;
            try { const u = new URL(url, location.href || undefined); if (/^https?:$/.test(u.protocol)) tgt = u.origin; } catch (_) {}
            // An opaque-origin client (sandboxed / srcdoc frame — `location.origin` empty or "null")
            // is cross-origin to every real origin, so a null `here` still rejects an http(s) target.
            const here = location.origin || null;
            if (tgt && tgt !== here) { reject(new TypeError('Failed to fetch: request mode is "same-origin" but the URL is cross-origin: ' + url)); return; }
          }
          // A controlled client's request reaches the SW's `fetch` handler with the SAME shape
          // the network hop would have carried, so `event.request.*` is faithful: redirect / mode
          // / credentials / cache / integrity pass through, and the referrer is the request's
          // referrer SOURCE (about:client → this client's document URL) — the controlling SW
          // resolves it per `referrerPolicy` exactly as the network path does (compute_referrer).
          // The SW's `event.request.url` is a RESOLVED URL, and the referrer is computed against
          // it — so resolve a relative input against THIS client's base (a controlled iframe
          // resolves against its own document, not the top window the network path assumes).
          let swUrl = url;
          try { swUrl = new URL(url, location.href || undefined).href; } catch (_) {}
          // The request's EFFECTIVE referrer policy defaults (in buildSwRequest) to the platform
          // default a fetch naming none inherits — absent a `<meta name=referrer>` / `Referrer-Policy`
          // header (not modeled). A named `referrer` (incl. '' = no-referrer) is passed through; an
          // absent one (undefined) defaults to this client's document URL.
          const swReq = buildSwRequest({
            redirect,
            mode,
            credentials,
            cache,
            keepalive,
            referrerPolicy,
            integrity:      integrityMeta,
            referrerSource: referrer
          });
          // One INTERCEPTED hop; a 3xx respondWith re-enters here per the client's
          // redirect mode (Fetch "HTTP-redirect fetch" over Handle Fetch responses —
          // the SW observes every followed hop, redirected-response's
          // expected_intercepted_urls). `hops` counts follows: the 21st rejects.
          const dispatchSwHop = function (hopUrl, hopMethod, hopHeaders, hopBody, hops) {
            globalThis.__csimSWInterceptFetch(ctrl, normalizeMethod(hopMethod), hopUrl, hopHeaders, hopBody, swReq, function (swResp) {
              // An abort mid-chain (each hop is its own async round-trip) rejects
              // with the abort reason, never resolves with a late response.
              if (signal && signal.aborted) { reject(signal.reason); return; }
              // Fall-through: the network leg for THIS hop's url; rack follows any
              // remaining redirects itself. A followed chain marks the result.
              if (swResp == null) {
                if (hops === 0) { doNetwork(); return; }
                try {
                  // Mirrors doNetwork: this client's own document URL as the origin
                  // identity (a controlled iframe's, not the top window's).
                  const r = globalThis.__rackFetch(normalizeMethod(hopMethod), hopUrl, hopBody, hopHeaders, redirect, mode, credentials, referrerPolicy, referrer, cache, null, null, null, String(location.href || ''));
                  if (r) r.redirected = true;
                  finish(r);
                } catch (e) { reject(e); }
                return;
              }
              if (swResp.__networkError) { reject(new TypeError('Failed to fetch: ' + url)); return; }
              // Response tainting (Fetch "HTTP fetch" service-worker step): a `respondWith` may hand
              // back a cross-origin-derived response the SW's own fetch produced, but the client must
              // reject one whose TYPE its request mode (same-origin ↛ cors, non-no-cors ↛ opaque) or
              // redirect mode (non-manual ↛ opaqueredirect) forbids (fetch-response-taint), and a
              // REDIRECTED response (URL list > 1) is an error for any non-'follow' redirect mode.
              const t = swResp.type || 'default';
              if ((mode === 'same-origin' && t === 'cors') ||
                  (mode !== 'no-cors'     && t === 'opaque') ||
                  (redirect !== 'manual'  && t === 'opaqueredirect') ||
                  (redirect !== 'follow'  && swResp.redirected)) {
                reject(new TypeError('Failed to fetch: the service worker response (type "' + t + '"' + (swResp.redirected ? ', redirected' : '') + ') is disallowed for request mode "' + mode + '" / redirect "' + redirect + '"'));
                return;
              }
              const st  = swResp.status | 0;
              const loc = SW_REDIRECT_STATUS[st] ? swHeaderOf(swResp.headers, 'location') : null;
              if (loc != null && t !== 'opaqueredirect') {
                // The chain owns the response now — a STREAMED 3xx's body is never
                // read, so cancel it or the SW pumps into a stream nobody drains.
                if (swResp.bodyStream) { try { swResp.bodyStream.cancel(); } catch (_) {} }
                if (redirect === 'error') { reject(new TypeError('Failed to fetch: redirect mode is "error" but the response is a redirect: ' + hopUrl)); return; }
                if (redirect === 'manual') {
                  // Filter to an opaqueredirect (status 0, no headers/body, the REQUEST url).
                  finish({ status: 0, statusText: '', headers: {}, body: '', body_null: true, url: hopUrl, type: 'opaqueredirect' });
                  return;
                }
                if (hops >= 20) { reject(new TypeError('Failed to fetch: exceeded 20 redirects: ' + url)); return; }
                // Location resolves against the RESPONSE's url — a synthetic
                // respondWith (no url) can't anchor a RELATIVE location, which is a
                // network error (Response.redirect() absolutizes at creation, so it
                // always carries one).
                let next;
                try { next = new URL(loc, swResp.url || undefined).href; } catch (_) { reject(new TypeError('Failed to fetch: invalid redirect location: ' + String(loc))); return; }
                let m2 = normalizeMethod(hopMethod), h2 = hopHeaders, b2 = hopBody;
                // HTTP-redirect fetch: 303 (and 301/302 of a POST) rewrites to a
                // bodyless GET, stripping the body's Content-* request headers.
                if (st === 303 || ((st === 301 || st === 302) && m2 === 'POST')) {
                  m2 = 'GET'; b2 = '';
                  h2 = {};
                  for (const k in hopHeaders) { if (!/^content-(?:encoding|language|location|type|length)$/i.test(k)) h2[k] = hopHeaders[k]; }
                }
                dispatchSwHop(next, m2, h2, b2, hops + 1);
                return;
              }
              // A followed chain's final response reports redirected + the FINAL
              // hop's url (an empty SW-response URL list clones the request's).
              if (hops > 0) {
                if (!swResp.redirected) swResp.redirected = true;
                if (!swResp.url) swResp.url = hopUrl;
              }
              finish(swResp);
            });
          };
          dispatchSwHop(swUrl, method, headers, reqBody, 0);
          return;
        }
        doNetwork();
      }, 0);
    });
  };
  // The request body on the wire: its bytes, captured at construction (re-serializing a FormData would mint a new
  // multipart boundary mismatching the Content-Type). A ReadableStream body is the ONLY async case: it is drained to
  // bytes first (buffered upload), so only that path defers the rack call by a microtask.
  if (s.bodyIsStream) {
    const stream = s.bodyStream;
    // getReader() (inside collectBodyStream) throws synchronously on a locked/disturbed stream;
    // surface it as a rejection so fetch() never throws synchronously.
    if (stream.locked || stream._disturbed) {
      return Promise.reject(new TypeError('Failed to fetch: Request body stream is disturbed or locked'));
    }
    return collectBodyStream(stream).then(bytes => runRack(latin1ToBytes(bytes)));
  }
  return runRack(latin1ToBytes(s.bodyBytes));
}
const SW_REDIRECT_STATUS = { 301: 1, 302: 1, 303: 1, 307: 1, 308: 1 };
function swHeaderOf(hdrs, name) {
  if (!hdrs) return null;
  for (const k in hdrs) { if (k.toLowerCase() === name) return hdrs[k]; }
  return null;
}

globalThis.Request  = Request;
globalThis.Response = Response;
