// Fetch (Fetch Standard): Request, Response and the Body they share, generated from their IDL, and `fetch()` — the
// Request it constructs fetched over the synchronous Rack call, a controlling service worker's `fetch` handler, the
// in-process blob registry (`blob:`) or the data: URL processor. A Request's and a Response's state are their internal
// slots — a request's or a response's, Fetch's own word for them — which the driver's other modules (the service
// worker host, Cache Storage, the respondWith wire) reach through `requestOf` / `responseOf`, never a page-visible field.

import { bytesToArrayBuffer, bytesToLatin1, latin1ToBytes, utf8DecodeBytes, utf8EncodeBytes } from './bytes.js';
import { apiBaseURL, documentOrigin } from './platform-globals.js';
import { parseURL } from './url-parse.js';
import { Blob, File, blobResponse, resolveBlobBytes } from './blob.js';
import { serializeRequestBody } from './request-body.js';
import { normalizeMethod, responseHeader } from './header-rules.js';
import { buildSwRequest, swFetchChain } from './sw-client.js';
import { contentTypeEssence, extractMimeType } from './mime.js';
import { location } from './location.js';
import { anySignal, signalAborted, signalReason } from './abort.js';
import { addAbortAlgorithm } from './events.js';
import {
  IntrinsicPromise,
  interfaceCheck,
  jsonParse,
  jsonStringify,
  makeSlots,
  ownRealm,
  promiseThen,
  promiseThenChained,
  registerInterface,
  rejectedPromise,
  resolvedPromise,
  slotsOf,
  toUSVString
} from './webidl.js';
import {
  appendHeader, copyHeaders, createHeaders, getHeader, headersGuard, networkHeaders, wireEntries
} from './headers.js';
import { FormData, formDataEntries } from './form-data.js';
import { ReadableStream, TextDecoderStream } from './streams.js';
import {
  convertRequestArguments, convertResponseArguments, installRequest, installResponse, toRequestInit
} from './generated/bindings.js';

// The messages' prefixes: the constructor's, and fetch()'s, which constructs a Request — on a window's or a worker's
// global.
const CONSTRUCT_REQUEST = "Failed to construct 'Request': ";
const CONSTRUCT_RESPONSE = "Failed to construct 'Response': ";
const executeFetch = () => `Failed to execute 'fetch' on '${globalThis.__csim_isWorker ? 'WorkerGlobalScope' : 'Window'}': `;

// Fetch "extract a body" of a BodyInit: `{bytes, stream, type}` — a ReadableStream its stream (neither disturbed nor
// locked, a TypeError after `prefix` otherwise — `unusable` its message; never for a keepalive request), anything else
// its bytes — a canonical latin-1 byte string, text UTF-8 encoded — and the Content-Type it implies, or null.
function extractBody(object, keepalive, prefix, unusable) {
  if (isReadableStream(object)) {
    if (keepalive) throw new TypeError(prefix + 'Keepalive request cannot have a ReadableStream body.');
    if (object.locked || object._disturbed) throw new TypeError(prefix + unusable(object));
    return { bytes: '', stream: object, type: null };
  }
  const { body, type } = serializeRequestBody(object);
  return { bytes: typeof body === 'string' ? utf8EncodeBytes(body) : bytesToLatin1(body), stream: null, type };
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
  const essence = contentTypeEssence(raw);
  if (essence === 'application/x-www-form-urlencoded') {
    for (const pair of globalThis.__dom.urlencodedParse(utf8DecodeBytes(byteStr, true))) entries.push(pair);
    return resolvedPromise(fd);
  }
  // (…multipart/form-data, the engine's parser (multipart.rs): each part's field name and value — a part with a
  // `filename` a File of the type it gives — or a parse error, a TypeError, for a body no part of which may be wrong (a
  // boundary not followed by "--" or CRLF, a part naming no field, bytes after the close delimiter: response-form-data
  // "Validate buggy form data"), and for any other type)
  const parts = globalThis.__dom.multipartFormData(byteStr, raw);
  if (parts === null) {
    const message = essence === 'multipart/form-data' ? 'Failed to parse multipart form data.'
      : 'Body cannot be decoded as form data, mime type is not multipart/form-data or application/x-www-form-urlencoded';
    return rejectedPromise(new TypeError(message));
  }
  for (let i = 0; i < parts.length; i += 4) {
    const [name, filename, type, value] = parts.slice(i, i + 4);
    entries.push([name, filename === null ? value : new File([latin1ToBytes(value)], filename, { type })]);
  }
  return resolvedPromise(fd);
}

// A body's ReadableStream is a readable BYTE stream over the canonical bytes, so a consumer
// can take a BYOB reader (getReader({mode:'byob'})) and read with an offset
// (response-consume-stream). An empty body enqueues nothing — a byte controller rejects a
// zero-length chunk — and just closes; or, a body the network cut short, errors with `failure` once they are read.
function createBodyByteStream(latin1, failure) {
  const u8 = latin1ToBytes(latin1);
  return new ReadableStream({
    type: 'bytes',
    start(controller) {
      if (u8.length) controller.enqueue(u8);
      if (failure === undefined) controller.close();
    },
    pull: failure === undefined ? undefined : (controller) => controller.error(failure)
  });
}

// Coerce a body-stream chunk (BufferSource) to a Uint8Array view over its bytes.
function chunkToU8(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
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
    return promiseThenChained(reader.read(), ({ done, value }) => {
      if (done) return;
      const u8 = value == null ? null : chunkToU8(value);
      if (!u8) throw new TypeError('Failed to read body: a ReadableStream chunk is not a BufferSource');
      chunks.push(u8); total += u8.length;
      return pump();
    });
  }
  return promiseThen.call(pump(), () => {
    const merged = new Uint8Array(total);
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
      return promiseThen.call(reader.read(), ({ done, value }) => {
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
  if (s.bodyBytes === undefined) s.bodyBytes = rawBytes(s.raw);
  return s.bodyBytes;
}
function rawBytes(raw) {
  const b = raw.body_bytes ? raw.body_bytes : raw.body || '';
  return typeof b === 'string' ? b : bytesToLatin1(b);
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
export const bodyUnusable = (s) => bodyUsedOf(s) || (s.bodyStream !== null && s.bodyStream.locked);
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
  const refusal = bodyRefusal(o, member);
  if (refusal !== null) return rejectedPromise(refusal.reason);
  const s = bodyOf(o);
  if (s.bodyNull) {
    // (…a null body reads as empty, repeatably — request-consume-empty)
    try { return resolvedPromise(fn('')); } catch (e) { return rejectedPromise(e); }
  }
  if (s.bodyStream) return promiseThen.call(collectBodyStream(s.bodyStream), fn);
  s.bodyUsed = true;
  try { return resolvedPromise(fn(bytesOf(s))); } catch (e) { return rejectedPromise(e); }
}
// …and the TypeError a `textStream()` of an unusable body throws (Fetch §5.3), of the realm this runs in.
const textStreamRefusal = (name) => new TypeError(`Failed to execute 'textStream' on '${name}': body stream already read`);
// …refused, `{reason}` — its fetch aborted (the abort reason), its body unusable (a TypeError of the realm this runs in:
// the calling realm's, where another realm's object is read — Web IDL's current realm) — or null.
function bodyRefusal(o, member) {
  const s = bodyOf(o);
  if (s.fetchSignal && signalAborted(s.fetchSignal)) return { reason: signalReason(s.fetchSignal) };
  if (s.bodyNull) return null;
  const stream = s.bodyStream;
  const why = stream ? (stream._disturbed ? 'already read' : stream.locked ? 'is locked' : null) : s.bodyUsed ? 'already read' : null;
  if (why === null) return null;
  return { reason: new TypeError(`Failed to execute '${member}' on '${requestOf(o) ? 'Request' : 'Response'}': body stream ${why}`) };
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
    pull: (controller) => promiseThen.call(reader.read(), ({ done, value }) => {
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
  json: (o) => consumeBody(o, 'json', (b) => jsonParse(utf8DecodeBytes(b))),
  text: (o) => consumeBody(o, 'text', (b) => utf8DecodeBytes(b)),
  // (…its stream piped through a UTF-8 TextDecoderStream, whatever its Content-Type says — a closed empty one for a
  // null body — an unusable body a TypeError thrown: Fetch §5.3)
  textStream(o) {
    const s = bodyOf(o);
    if (bodyUnusable(s)) throw textStreamRefusal(requestOf(o) ? 'Request' : 'Response');
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
// A Request and a Response are their realm's (webidl.js `ownRealm`): another realm's handed to this realm's member — a
// frame's Response cloned by this realm's `clone` — is cloned, read and consumed as its own realm's member would: its
// clone and the buffers its body reads make are of its realm (Fetch: "in this's relevant realm").
const REALM = {};
// …but what REFUSES a step is the calling realm's: Web IDL makes its exception, and the promise its refusal rejects, in
// the current realm (Chrome and Firefox: a frame's used Response cloned or read by the top page's method fails with the
// top page's TypeError, its rejected promise the top page's — where the success promise is the frame's).
const BODY_READS = ['arrayBuffer', 'blob', 'bytes', 'formData', 'json', 'text'];
function ownFetchRealm(name, slotsOfSelf, impl) {
  const dispatched = ownRealm(REALM, name, slotsOfSelf, impl);
  for (const member of BODY_READS) {
    const step = dispatched[member];
    dispatched[member] = (self) => {
      const refusal = bodyRefusal(self, member);
      return refusal !== null ? rejectedPromise(refusal.reason) : step(self);
    };
  }
  const clone = dispatched.clone, textStream = dispatched.textStream;
  dispatched.clone = (self) => {
    if (bodyUnusable(slotsOfSelf(self))) throw new TypeError(`Failed to execute 'clone' on '${name}': ${name} body is already used`);
    return clone(self);
  };
  dispatched.textStream = (self) => {
    if (bodyUnusable(slotsOfSelf(self))) throw textStreamRefusal(name);
    return textStream(self);
  };
  return dispatched;
}
// A Request's slots: its request — the engine's (request_state.rs, `__dom.RequestStateBase`), what the getters below
// read — and the page's objects it goes with: its signal, its Headers object, its body, and the blob its URL named.
const FIELD_URL = 0, FIELD_METHOD = 1, FIELD_MODE = 2, FIELD_CREDENTIALS = 3, FIELD_CACHE = 4, FIELD_REDIRECT = 5,
      FIELD_REFERRER = 6, FIELD_REFERRER_POLICY = 7, FIELD_INTEGRITY = 8, FIELD_KEEPALIVE = 9, FIELD_DESTINATION = 10,
      FIELD_RELOAD_NAVIGATION = 11, FIELD_HISTORY_NAVIGATION = 12, FIELD_INITIATOR = 13, FIELD_SITE_SEED = 14,
      FIELD_ORIGIN_NULL = 15, FIELD_COOKIE_CROSS_SITE = 16, FIELD_HEADERS_GUARD = 17;
class RequestSlots {
  constructor(state) {
    this.realm = REALM;
    this.state = state;
    this.signal = null;
    this.headers = null;
    this.bodyBytes = '';
    this.bodyNull = true;
    this.bodyUsed = false;
    this.bodyStream = null;
    this.bodyIsStream = false;
    this.blobSnapshot = null;
  }
  field(k) { return globalThis.__dom.requestField(this.state, k); }
  get url() { return this.field(FIELD_URL); }
  get method() { return this.field(FIELD_METHOD); }
  get mode() { return this.field(FIELD_MODE); }
  get credentials() { return this.field(FIELD_CREDENTIALS); }
  get cache() { return this.field(FIELD_CACHE); }
  get redirect() { return this.field(FIELD_REDIRECT); }
  get referrer() { return this.field(FIELD_REFERRER); }
  get referrerPolicy() { return this.field(FIELD_REFERRER_POLICY); }
  get integrity() { return this.field(FIELD_INTEGRITY); }
  get keepalive() { return this.field(FIELD_KEEPALIVE); }
  get destination() { return this.field(FIELD_DESTINATION); }
  get isReloadNavigation() { return this.field(FIELD_RELOAD_NAVIGATION); }
  get isHistoryNavigation() { return this.field(FIELD_HISTORY_NAVIGATION); }
  get initiator() { return this.field(FIELD_INITIATOR); }
  get siteSeed() { return this.field(FIELD_SITE_SEED); }
  get originNull() { return this.field(FIELD_ORIGIN_NULL); }
  get cookieCrossSite() { return this.field(FIELD_COOKIE_CROSS_SITE); }
  // …and what a request no Request constructor makes takes of `record` (`requestAdopt`): a navigation's, a cached
  // one's, the client's request a service worker's fetch event hands it.
  adopt(record) { globalThis.__dom.requestAdopt(this.state, record); }
}
// The Request constructor's steps (Fetch "new Request(input, init)", §5.4) on `o`, its arguments converted (`input` a
// string or a Request, `init` a RequestInit) — fetch()'s, which constructs one, too: `prefix` the messages'. Its request
// is the engine's to make, refusals and all (request_state.rs); the signal, headers and body are the bindings'.
// (`navigation`: a navigation's request, its URL HTML's navigate algorithm's — which no Request constructor's check
// refuses.)
function constructRequest(o, input, init, prefix, navigation = false) {
  const from = typeof input === 'string' ? undefined : requestOf(input);
  const state = new globalThis.__dom.RequestStateBase(from === undefined ? null : from.state, from === undefined ? input : null, init,
                                                      navigation, apiBaseURL(), documentOrigin(), prefix);
  const s = makeSlots(o, 'Request', new RequestSlots(state));
  const nonEmpty = Object.keys(init).length > 0;
  const sourceSignal = from === undefined ? null : from.signal;
  const signal = init.signal !== undefined ? init.signal : sourceSignal;
  // The request's signal is always a NEW AbortSignal that FOLLOWS the source — init's, else the input Request's (a
  // null init.signal removes it) — so a clone reflects the source's aborted state without aliasing it (abort/general
  // "Signal on request object").
  s.signal = anySignal(signal ? [signal] : []);
  // Its headers: a copy of the source request's header list (or none), guarded by the mode, and, for a non-empty init,
  // emptied and filled again with init's headers or that copy, through the guard (headers-forbidden-override / -no-cors).
  const guard = s.field(FIELD_HEADERS_GUARD);
  if (init.headers !== undefined) s.headers = createHeaders(init.headers, guard, prefix);
  else if (from !== undefined) s.headers = copyHeaders(from.headers, guard, nonEmpty);
  else s.headers = createHeaders(undefined, guard, prefix);
  // Its body: init's, extracted (its Content-Type appended where the headers give none), else the source request's —
  // else none.
  const initBody = init.body ?? null;
  const inputHasBody = from !== undefined && !from.bodyNull;
  if ((initBody !== null || inputHasBody) && globalThis.__dom.requestRefusesBody(state)) {
    throw new TypeError(prefix + 'Request with GET/HEAD method cannot have body.');
  }
  if (initBody !== null) {
    const { bytes, stream, type } = extractBody(initBody, s.keepalive, prefix, (stream) => `The provided ReadableStream is ${stream.locked ? 'locked' : 'disturbed'}`);
    if (stream !== null) {
      const refusal = globalThis.__dom.requestStreamRefusal(state, init.duplex !== undefined);
      if (refusal !== null) throw new TypeError(prefix + refusal);
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
installRequest(Request, ownFetchRealm('Request', requestOf, {
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
  // Fetch "clone a request" (its usability the calling realm's to check: `ownFetchRealm`): its request copied — its headers with their guard (a service worker's
  // `event.request.clone()` stays immutable) — its body cloned, and a signal following its own.
  clone(r) {
    const s = requestOf(r);
    const c = Object.create(Request.prototype);
    const cs = makeSlots(c, 'Request', new RequestSlots(new globalThis.__dom.RequestStateBase(s.state)));
    cs.headers = copyHeaders(s.headers, headersGuard(s.headers), false);
    cs.signal = anySignal([s.signal]);
    cs.blobSnapshot = s.blobSnapshot;
    cloneBody(s, cs);
    return c;
  },
  ...body
}));
// The request a form submission's navigation of a frame fetches (Fetch "create a navigation request"): of `url`
// (absolute), `method`, a plain header map and a BodyInit or null — in mode 'navigate', which no RequestInit may give,
// credentials 'include', destination 'iframe'.
function navigationRequest(url, method, headers, bodyInit, referrerPolicy) {
  const o = Object.create(Request.prototype);
  const init = { method, headers: Object.entries(headers || {}), referrerPolicy, ...(bodyInit != null ? { body: bodyInit } : {}) };
  constructRequest(o, url, init, '', true);
  requestOf(o).adopt({ mode: 'navigate', destination: 'iframe' });
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
// A Response's slots: its response — the engine's (response_state.rs, `__dom.ResponseStateBase`), what the getters below
// read — and the page's objects it goes with: its Headers object, its body, and for a network response `raw` (what the
// network handed back: the body until it is first read, the opaque render, the redirect a navigation follows) and
// `fetchSignal` (its fetch's, whose abort rejects a body read).
const R_TYPE = 0, R_URL = 1, R_STATUS = 2, R_STATUS_TEXT = 3, R_REDIRECTED = 4, R_OK = 5, R_LOCATION = 6, R_NULL_BODY_STATUS = 7;
class ResponseSlots {
  constructor(state, headers, raw = null, fetchSignal = null) {
    this.realm = REALM;
    this.state = state;
    this.headers = headers;
    this.raw = raw;
    this.fetchSignal = fetchSignal;
    this.bodyBytes = '';
    this.bodyNull = true;
    this.bodyUsed = false;
    this.bodyStream = null;
    this.bodyIsStream = false;
  }
  field(k) { return globalThis.__dom.responseField(this.state, k); }
  get type() { return this.field(R_TYPE); }
  get url() { return this.field(R_URL); }
  get status() { return this.field(R_STATUS); }
  get statusText() { return this.field(R_STATUS_TEXT); }
  get redirected() { return this.field(R_REDIRECTED); }
  get ok() { return this.field(R_OK); }
}
// A Response object `o` of a response the engine makes (`ResponseStateBase`'s kinds), with `headers`.
function makeResponse(o, args, headers, raw, fetchSignal) {
  const state = new globalThis.__dom.ResponseStateBase(...args);
  return makeSlots(o, 'Response', new ResponseSlots(state, headers, raw, fetchSignal));
}
// Fetch "initialize a response" (§5.5) of `o`, `init` a ResponseInit converted, `body` an extracted one or null: its
// status and status message the engine's to judge (a RangeError, a TypeError), the headers filled through the
// 'response' guard (which drops set-cookie / set-cookie2 — header-setcookie), and a body a TypeError for a null body
// status, its Content-Type appended where the headers give none.
function initResponse(o, init, body, prefix) {
  const state = new globalThis.__dom.ResponseStateBase('init', init.status, init.statusText, prefix);
  const headers = createHeaders(init.headers, 'response', prefix);
  const s = makeSlots(o, 'Response', new ResponseSlots(state, headers));
  if (body === null) return o;
  if (s.field(R_NULL_BODY_STATUS)) throw new TypeError(prefix + 'Response with null body status cannot have body');
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
  // (…a body the network cut short — its Content-Length not reached: what came, and then a network error)
  const stream = raw.bodyStream || (raw.body_error ? createBodyByteStream(rawBytes(raw), new TypeError('network error')) : null);
  // (…the HTTP reason phrase resolved Ruby-side: a custom one, else the status code's standard reason)
  const s = makeResponse(o, ['network', raw.type || '', raw.url || '', raw.status, raw.statusText, !!raw.redirected, url || ''],
                         networkHeaders(raw.headers), raw, signal || null);
  // (…its bytes read off `raw` at first read; a null body — a null body status, a HEAD — flagged Ruby-side)
  s.bodyBytes = undefined;
  s.bodyNull = !!raw.body_null;
  // (…a streaming service worker respondWith's body, delivered incrementally: the client reassembles it as a live stream —
  // sw-client.js — which reads pull from as chunks arrive)
  s.bodyStream = stream;
  s.bodyIsStream = stream !== null;
  // Aborting the fetch cancels such a body (Fetch "abort a fetch") — observably in the SW's source stream (readable-stream
  // abort) EVEN while the page reads it, a locked stream, whose public `cancel()` would throw: its `__csimAbort`
  // (sw-client.js) routes the cancel to the SW and errors the body with the abort reason.
  if (stream !== null && signal) {
    addAbortAlgorithm(signal, () => {
      const reason = signalReason(signal);
      if (typeof stream.__csimAbort === 'function') stream.__csimAbort(reason);
      else try { stream.cancel(reason); } catch (_) {}
    });
  }
  return o;
}
installResponse(Response, {
  ...ownFetchRealm('Response', responseOf, {
    get_type: (r) => responseOf(r).type,
    get_url: (r) => responseOf(r).url,
    get_redirected: (r) => responseOf(r).redirected,
    get_status: (r) => responseOf(r).status,
    get_ok: (r) => responseOf(r).ok,
    get_statusText: (r) => responseOf(r).statusText,
    get_headers: (r) => responseOf(r).headers,
    // Fetch "clone a response" (its usability the calling realm's to check: `ownFetchRealm`): its response copied — its headers with their guard (a script's mutable 'response' one
    // stays mutable, response-clone) — and its body cloned.
    clone(r) {
      const s = responseOf(r);
      const c = Object.create(Response.prototype);
      const cs = makeResponse(c, ['clone', s.state], copyHeaders(s.headers, headersGuard(s.headers), false), s.raw, s.fetchSignal);
      cloneBody(s, cs);
      return c;
    },
    ...body
  }),
  // A network error: status 0, no body, immutable headers (static-error).
  error: () => {
    const o = Object.create(Response.prototype);
    makeResponse(o, ['error'], networkHeaders(null));
    return o;
  },
  // A redirect to `url` of a redirect status — refused where the engine refuses it — no body, its Location the URL as it
  // parsed, its headers immutable (response-static-redirect).
  redirect(self, url, status) {
    const state = new globalThis.__dom.ResponseStateBase('redirect', url, status, apiBaseURL(), "Failed to execute 'redirect' on 'Response': ");
    const o = Object.create(Response.prototype);
    makeSlots(o, 'Response', new ResponseSlots(state, networkHeaders({ location: globalThis.__dom.responseField(state, R_LOCATION) })));
    return o;
  },
  // `data` serialized to JSON bytes (a TypeError where it serializes to nothing — a bare Symbol / function,
  // response-static-json; a BigInt makes JSON.stringify itself throw), a response of them, application/json where the
  // headers give no Content-Type.
  static_json(self, data, init) {
    const text = jsonStringify(data);
    if (text === undefined) throw new TypeError("Failed to execute 'json' on 'Response': The data is not JSON serializable");
    const o = Object.create(Response.prototype);
    const body = { bytes: utf8EncodeBytes(text), stream: null, type: 'application/json' };
    return initResponse(o, init, body, "Failed to execute 'json' on 'Response': ");
  }
});
// Subresource Integrity: whether a body (a byte string) matches its `integrity` metadata — the engine's
// (integrity.rs: the strongest algorithm's digests, metadata with none it knows no check).
function integrityMatches(bodyBytes, metadata) {
  return globalThis.__dom.integrityMatches(latin1ToBytes(bodyBytes || ''), String(metadata));
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
  } catch (e) { return rejectedPromise(e); }
  const s = requestOf(request);
  if (signalAborted(s.signal)) {
    if (s.bodyIsStream && !s.bodyStream.locked) {
      try { promiseThen.call(s.bodyStream.cancel(signalReason(s.signal)), undefined, () => {}); } catch (_) {}
    }
    return rejectedPromise(signalReason(s.signal));
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
export function navigationFetch(url, method, headers, bodyInit, referrerPolicy = '', navigable = null) {
  try {
    return fetchRequest(requestOf(navigationRequest(url, method, headers, bodyInit, referrerPolicy)), null, navigable);
  } catch (e) { return rejectedPromise(e); }
}

// Fetch the request `s` (a Request's slots): `timingInitiator` its Resource Timing entry's initiator type, or null
// (a navigation records none), and a navigation's the frame whose navigable it navigates (`navigable`).
function fetchRequest(s, timingInitiator, navigable = null) {
  const timingStart = globalThis.__csimPerformanceNow();
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
  // Fetch's main fetch: a response the request's integrity metadata refuses — an opaque one, whose body none can read,
  // or one whose body matches none of it — is a network error, whatever scheme answered it (`raw` its record, `response`
  // the Response made of it).
  const integrityRefuses = (raw, response) => !!integrityMeta && (raw.type === 'opaque' || !integrityMatches(bytesOf(responseOf(response)), integrityMeta));
  const integrityFailure = () => new TypeError('Failed to fetch: integrity check failed for ' + url);
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
  // Fetch's default request headers, each where the caller set none of its name — the engine's (fetch_rules.rs
  // `defaultRequestHeaders`: NOT a document navigation's richer Accept, which rack_fetch would otherwise fill in).
  const defaults = globalThis.__dom.defaultRequestHeaders();
  for (let k = 0; k < defaults.length; k += 2) {
    if (getHeader(s.headers, defaults[k]) === null) headers[defaults[k].toLowerCase()] = defaults[k + 1];
  }
  // NOTE: the fetch `Origin` request header (non-GET/HEAD) is deliberately NOT added
  // here — doing so changes how rack_fetch's CORS logic evaluates cross-origin
  // requests and regresses the fetch/api/cors cluster. It belongs with a holistic
  // CORS pass (aligning the Origin header with preflight/response-tainting), tracked
  // as backlog, not this narrow header change.
  if (typeof url === 'string' && url.startsWith('blob:')) {
    // The bytes the Request referenced at construction — so a `URL.revokeObjectURL(url)` issued right after (or, for a
    // Request made earlier, before) this fetch() still sees the resource — as scheme fetch answers for them
    // (`blobResponse`: a GET alone, a byte range honoured).
    const resp = blobResponse(url, s.blobSnapshot, method, getHeader(s.headers, 'range'));
    return new IntrinsicPromise(function (resolve, reject) {
      // Defer through the virtual clock to match the spec's fetch
      // task boundary — fetch resolves on a separate task, so awaiting
      // it yields control. Inline resolve would race ahead of any
      // intervening microtasks (Turbo Drive's render chain).
      globalThis.__csimSetTimeout(function () {
        if (signal && signalAborted(signal)) { reject(signalReason(signal)); return; }
        if (!resp) return reject(new TypeError('blob URL fetch failed: ' + url));
        const response = responseFromRaw(resp, url, signal);
        if (integrityRefuses(resp, response)) { reject(integrityFailure()); return; }
        resolve(response);
      }, 0);
    });
  }
  if (typeof url === 'string' && url.startsWith('data:')) {
    // `data:` is resolved locally through the WHATWG data: URL processor (Discourse's PM
    // image extension fetches a pasted `data:image/png;base64,…` to wrap the bytes in a
    // File; going through Rack would fail). A malformed data: URL is a network error.
    return new IntrinsicPromise(function (resolve, reject) {
      globalThis.__csimSetTimeout(function () {
        if (signal && signalAborted(signal)) { reject(signalReason(signal)); return; }
        // (…the engine's scheme fetch: data_url.rs `dataUrlResponse`, a HEAD's with no body)
        const r = globalThis.__dom.dataUrlResponse(url, String(method || 'GET'));
        if (!r) { reject(new TypeError('Invalid data: URL: ' + url)); return; }
        const raw = {
          status:     200,
          statusText: 'OK',
          body:       latin1ToBytes(r[1]),
          headers:    { 'content-type': r[0] },
          url
        };
        const response = responseFromRaw(raw, url, signal);
        if (integrityRefuses(raw, response)) { reject(integrityFailure()); return; }
        resolve(response);
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
      return new IntrinsicPromise(function (resolve, reject) {
        const abs = parseURL(url, location.href || null)?.href ?? url;
        let id = -1;
        try {
          id = globalThis.__csim_keepaliveStart(normalizeMethod(method), abs, reqBody, headers, redirect, mode, credentials, referrerPolicy, referrer, cache, String(location.href || ''), globalThis.__csimRealmId()) | 0;
        } catch (_) { id = -1; }
        // -1 = the 64 KiB in-flight payload quota is exhausted (Fetch: "if the sum
        // of contentLength and inflightKeepaliveBytes is greater than 64 KiB, then
        // return a network error").
        if (id < 0) { reject(new TypeError('Failed to fetch: keepalive request over quota')); return; }
        const poll = function () {
          // BOUNDED DIVERGENCE: an abort rejects the promise, but the detached
          // thread still completes the transmission (a real browser aborts it);
          // abort/keepalive stays allowlisted on exactly this.
          if (signal && signalAborted(signal)) { reject(signalReason(signal)); return; }
          let r = null;
          try { r = globalThis.__csim_keepaliveTake(id); } catch (_) { r = null; }
          if (r && r.pending) { globalThis.__csimSetTimeout(poll, 0); return; }
          if (timingInitiator && typeof globalThis.__csimRecordResource === 'function') globalThis.__csimRecordResource({ name: url, initiatorType: timingInitiator, startTime: timingStart, resp: r });
          if (!r) { reject(new TypeError('Network request failed: ' + url)); return; }
          try {
            const kaResp = responseFromRaw(r, abs, signal);
            if (integrityRefuses(r, kaResp)) { reject(integrityFailure()); return; }
            resolve(kaResp);
          } catch (e) { reject(e); }
        };
        globalThis.__csimSetTimeout(poll, 0);
      });
    }
    return new IntrinsicPromise(function (resolve, reject) {
      globalThis.__csimSetTimeout(function () {
        if (signal && signalAborted(signal)) { reject(signalReason(signal)); return; }
        const finish = function (resp) {
          if (timingInitiator && typeof globalThis.__csimRecordResource === 'function') globalThis.__csimRecordResource({ name: url, initiatorType: timingInitiator, startTime: timingStart, resp });
          if (!resp) { reject(new TypeError('Network request failed: ' + url)); return; }
          try {
            const r = responseFromRaw(resp, url, signal);
            if (integrityRefuses(resp, r)) { reject(integrityFailure()); return; }
            resolve(r);
          } catch (e) { reject(e); }
        };
        const doNetwork = function () {
          try { finish(globalThis.__rackFetch(normalizeMethod(method), url, reqBody, headers, redirect, mode, credentials, referrerPolicy, referrer, cache, navInitiator, navSiteSeed, navOriginNull, String(location.href || ''), navCookieCross, navDest, documentOrigin(), globalThis.__csimRealmId())); }
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
          const navUrl = parseURL(url, location.href || null)?.href ?? url;
          if (globalThis.__csimSWMayInterceptNavigation && globalThis.__csimSWMayInterceptNavigation(navUrl)) {
            const navReferrer = location.href || '';
            const navCt = responseHeader(headers, 'content-type') ?? '';
            const m     = normalizeMethod(method);
            const navBody = (m === 'GET' || m === 'HEAD') ? '' : reqBody;
            const swNav = globalThis.__csim_frameNavigationFetch(navUrl, false, navReferrer, globalThis.__dom.swMayControlNavigation(navigable), m, navBody, navCt);
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
          // (…the engine's rule: fetch_rules.rs `same_origin_mode_refused` — by the client's DOCUMENT origin, which a
          // srcdoc or about:blank frame inherits whatever its location says, an opaque one cross-origin to every real one)
          if (mode === 'same-origin' && globalThis.__dom.sameOriginModeRefused(url, documentOrigin())) {
            reject(new TypeError('Failed to fetch: request mode is "same-origin" but the URL is cross-origin: ' + url));
            return;
          }
          // A controlled client's request reaches the SW's `fetch` handler with the SAME shape
          // the network hop would have carried, so `event.request.*` is faithful: redirect / mode
          // / credentials / cache / integrity pass through, and the referrer is the request's
          // referrer SOURCE (about:client → this client's document URL) — the controlling SW
          // resolves it per `referrerPolicy` exactly as the network path does (compute_referrer).
          // The SW's `event.request.url` is a RESOLVED URL, and the referrer is computed against
          // it — so resolve a relative input against THIS client's base (a controlled iframe
          // resolves against its own document, not the top window the network path assumes).
          const swUrl = parseURL(url, location.href || null)?.href ?? url;
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
          // The request hop by hop, the worker's to answer each (sw-client.js `swFetchChain`: a 3xx respondWith re-enters
          // per the client's redirect mode — the SW observes every followed hop, redirected-response's
          // expected_intercepted_urls; the 21st follow rejects). An abort mid-chain (each hop is its own async
          // round-trip) rejects with the abort reason, never resolves with a late response.
          swFetchChain(ctrl, { swReq, mode, redirect, url: swUrl, method: normalizeMethod(method), headers, body: reqBody }, {
            alive: () => {
              if (!(signal && signalAborted(signal))) return true;
              reject(signalReason(signal));
              return false;
            },
            // (…the network leg for THIS hop's url past the first: rack follows any remaining redirects itself, and a
            // followed chain marks the result)
            network: (hopUrl, hopMethod, hopHeaders, hopBody, hops, crossed) => {
              if (hops === 0) { doNetwork(); return; }
              try {
                // Mirrors doNetwork: this client's own document URL as the origin identity (a controlled iframe's, not
                // the top window's).
                const r = globalThis.__rackFetch(hopMethod, hopUrl, hopBody, hopHeaders, redirect, mode, credentials, referrerPolicy, referrer, cache, null, null, null, String(location.href || ''), false, null, documentOrigin(), globalThis.__csimRealmId());
                if (r) r.redirected = true;
                // (…a no-cors chain that has been at another origin is opaque, wherever it ends — Fetch's response
                // tainting stays: the network leg sees this hop alone)
                finish(r && mode === 'no-cors' && crossed ? { status: 0, statusText: '', headers: {}, body: '', body_null: true, url: hopUrl, type: 'opaque' } : r);
              } catch (e) { reject(e); }
            },
            fail: (reason) => reject(new TypeError('Failed to fetch: ' + (reason ?? url))),
            done: finish
          });
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
      return rejectedPromise(new TypeError('Failed to fetch: Request body stream is disturbed or locked'));
    }
    return promiseThen.call(collectBodyStream(stream), bytes => runRack(latin1ToBytes(bytes)));
  }
  return runRack(latin1ToBytes(s.bodyBytes));
}
globalThis.Request  = Request;
globalThis.Response = Response;
