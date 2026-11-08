// Fetch (Fetch Standard): Request, Response and the Body they share, generated from their IDL, and `fetch()` — the
// Request it constructs fetched over the synchronous Rack call, a controlling service worker's `fetch` handler, the
// in-process blob registry (`blob:`) or the data: URL processor. A Request's and a Response's state are their internal
// slots — a request's or a response's, Fetch's own word for them — which the driver's other modules (the service
// worker host, Cache Storage, the respondWith wire) reach through `requestOf` / `responseOf`, never a page-visible field.

import { apiBaseURL } from './platform-globals.js';
import { documentOrigin } from './document-origin.js';
import { schemeRoute } from './url-parse.js';
import { Blob, File, blobOfBytes, resolveBlobBytes } from './blob.js';
import { serializeRequestBody } from './request-body.js';
import { swFetchChain, workerAnswerFacts } from './sw-client.js';
import { describeRequest, schemeResponse } from './fetch-request.js';
import {
  FETCH_BEACON, J_FETCH, ROUTE_BLOB, ROUTE_DATA, ROUTE_KEEPALIVE, ROUTE_PRELOADED, ROUTE_REFUSED, ROUTE_SERVICE_WORKER
} from './constants.js';
import { contentTypeEssence, extractMimeType } from './mime.js';
import { anySignal, signalAborted, signalMayAbort, signalReason } from './abort.js';
import { addAbortAlgorithm, removeAbortAlgorithm } from './events.js';
import {
  IntrinsicPromise,
  interfaceCheck,
  jsonParse,
  jsonStringify,
  makeSlots,
  ownRealm,
  promiseThen,
  promiseThenChained,
  reflectConstruct,
  registerInterface,
  rejectedPromise,
  resolvedPromise,
  slotsOf,
  toUSVString,
  createObject,
  objectCreate,
  rootInterface
} from './webidl.js';
import {
  appendHeader, copyHeaders, createHeaders, getHeader, headerListOf, headersGuard, networkHeaders
} from './headers.js';
import { FormData, formDataEntries } from './form-data.js';
import { ReadableStream, TextDecoderStream } from './streams.js';
import {
  convertRequestArguments, convertResponseArguments, installRequest, installResponse, toRequestInit
} from './generated/bindings.js';
import { dom, newList } from './engine.js';

// The messages' prefixes: the constructor's, and fetch()'s, which constructs a Request — on a window's or a worker's
// global.
const objectKeys = Object.keys;
const CONSTRUCT_REQUEST = "Failed to construct 'Request': ";
const CONSTRUCT_RESPONSE = "Failed to construct 'Response': ";
const executeFetch = () => `Failed to execute 'fetch' on '${globalThis.__csim_isWorker ? 'WorkerGlobalScope' : 'Window'}': `;

// A body's bytes — the engine's (blob_data.rs): an immutable run of them, a Blob's bytes are made of, of a string's
// UTF-8 or a copy of a view's; shared by a clone, copied out (`blobBytes`) or decoded (`textDecode`) as a reader asks.
const bodyData = (part) => dom.blobMake([part], false);
const utf8Text = (data, keepBOM = false) => dom.textDecode('UTF-8', data, keepBOM, false);
// Fetch "extract a body" of a BodyInit: `{bytes, stream, type}` — a ReadableStream its stream (neither disturbed nor
// locked, a TypeError after `prefix` otherwise — `unusable` its message; never for a keepalive request), anything else
// its bytes — text UTF-8 encoded — and the Content-Type it implies, or null.
function extractBody(object, keepalive, prefix, unusable) {
  if (isReadableStream(object)) {
    if (keepalive) throw new TypeError(prefix + 'Keepalive request cannot have a ReadableStream body.');
    if (object.locked || object._disturbed) throw new TypeError(prefix + unusable(object));
    return { bytes: bodyData(''), stream: object, type: null };
  }
  const { body, type } = serializeRequestBody(object);
  return { bytes: bodyData(body), stream: null, type };
}
const isReadableStream = interfaceCheck('ReadableStream');

// Body `formData()`: parse the bytes per Content-Type into a FormData — this realm's, its entries pushed onto its list
// (not through an `append` a page may have replaced). urlencoded → the form-urlencoded parser's pairs;
// multipart/form-data → each part's Content-Disposition name + value (a `filename` part a File). Any other type
// rejects (TypeError). A field value keeps a leading BOM (unlike a whole-body text() decode) — url/urlencoded-parser,
// response-consume "…with BOM".
function parseBodyToFormData(data, contentType) {
  const raw = contentType || '';
  const fd = new FormData();
  const entries = formDataEntries(fd);
  const essence = contentTypeEssence(raw);
  if (essence === 'application/x-www-form-urlencoded') {
    const pairs = dom.urlencodedParse(utf8Text(data, true));
    for (let i = 0; i < pairs.length; i++) entries[entries.length] = pairs[i];
    return resolvedPromise(fd);
  }
  // (…multipart/form-data, the engine's parser (multipart.rs): each part's field name and value — a part with a
  // `filename` a File of the type it gives — or a parse error, a TypeError, for a body no part of which may be wrong (a
  // boundary not followed by "--" or CRLF, a part naming no field, bytes after the close delimiter: response-form-data
  // "Validate buggy form data"), and for any other type)
  const parts = dom.multipartFormData(data, raw);
  if (parts === null) {
    const message = essence === 'multipart/form-data' ? 'Failed to parse multipart form data.'
      : 'Body cannot be decoded as form data, mime type is not multipart/form-data or application/x-www-form-urlencoded';
    return rejectedPromise(new TypeError(message));
  }
  for (let i = 0; i < parts.length; i += 4) {
    const name = parts[i], filename = parts[i + 1], type = parts[i + 2], value = parts[i + 3];
    entries[entries.length] = [name, filename === null ? value : new File([value], filename, { type })];
  }
  return resolvedPromise(fd);
}

// A body's ReadableStream is a readable BYTE stream over its bytes, so a consumer
// can take a BYOB reader (getReader({mode:'byob'})) and read with an offset
// (response-consume-stream). An empty body enqueues nothing — a byte controller rejects a
// zero-length chunk — and just closes; or, a body the network cut short, errors with `failure` once they are read.
function createBodyByteStream(data, failure) {
  const u8 = dom.blobBytes(data);
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

// Fully read a body stream into its bytes, a Uint8Array (concatenating its BufferSource
// chunks). A stream error (a source that errors on start/pull) propagates as the promise
// rejection (response-error-from-stream). A non-BufferSource chunk — a string / number /
// null — is a TypeError for BOTH a REQUEST body drained to the wire (request-upload.h2) and a
// RESPONSE body read (response-stream-bad-chunk "non-Uint8Array chunk … causes TypeError").
// On success the reader lock is DELIBERATELY kept: a fully-consumed body's stream stays locked,
// so a later `.body.getReader()` throws (response-stream-disturbed-5). The lock is released
// only on error. (…`held`, given, holding the reader as `held.reader`: what cancels the read under way)
export function collectBodyStream(stream, held = null) {
  const reader = stream.getReader();
  if (held !== null) held.reader = reader;
  const chunks = newList();
  let total = 0;
  function pump() {
    return promiseThenChained(reader.read(), ({ done, value }) => {
      if (done) return;
      const u8 = value == null ? null : chunkToU8(value);
      if (!u8) throw new TypeError('Failed to read body: a ReadableStream chunk is not a BufferSource');
      chunks[chunks.length] = u8;
      total += u8.length;
      return pump();
    });
  }
  return promiseThen.call(pump(), () => {
    const merged = new Uint8Array(total);
    let off = 0;
    for (let i = 0; i < chunks.length; i++) { merged.set(chunks[i], off); off += chunks[i].length; }
    return merged;
  }, err => { try { reader.releaseLock(); } catch (_) {} throw err; });
}
// A service worker's answer to a subresource's request, filed as its Resource Timing entry once its body is had — a
// streamed one's once read; a network error, or a stream that errors, as a blocked one.
export function fileWorkerAnswer(resp, file) {
  if (resp.__networkError) { file({ blocked: true }); return; }
  const answered = (bytes) => file(workerAnswerFacts(resp, bytes));
  if (!resp.bodyStream) { answered(resp.body_bytes); return; }
  promiseThen.call(collectBodyStream(resp.bodyStream), answered, () => file({ blocked: true }));
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
// Its bytes (`bodyData`). A network response's `body_bytes` are its bytes; without them its `body`, the text the host
// decoded, is ASCII — the bytes and the text alike (browser.rb `response_hash`): read as it is where a reader asks for
// text (`bodyText`), made bytes where one asks for them.
function bytesOf(s) {
  if (s.bodyBytes === undefined) s.bodyBytes = rawBytes(s.raw);
  return s.bodyBytes;
}
const rawBytes = (raw) => bodyData(raw.body_bytes ?? raw.body ?? '');
function bodyText(s) {
  if (s.bodyBytes === undefined && !s.raw.body_bytes && typeof s.raw.body === 'string') return s.raw.body;
  return utf8Text(bytesOf(s));
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
// (…`fn` of its bytes; `text`, where given, of its text instead — a network body's as the host decoded it, where it is
// ASCII: no bytes made of it to decode back)
// (…but a response whose fetch may still abort a microtask on: its body is read in parallel, and an abort before it is
// read errors it — Fetch "abort the fetch() call" step 4 — `r.text(); c.abort()` rejects with the abort's reason in
// Chrome and Firefox)
function consumeBody(o, member, fn, text = null) {
  const refusal = bodyRefusal(o, member);
  if (refusal !== null) return rejectedPromise(refusal.reason);
  const s = bodyOf(o);
  if (s.bodyNull) {
    // (…a null body reads as empty, repeatably — request-consume-empty)
    try { return resolvedPromise(text !== null ? text('') : fn(bodyData(''))); } catch (e) { return rejectedPromise(e); }
  }
  if (s.bodyStream) return promiseThen.call(collectBodyStream(s.bodyStream), (bytes) => (text !== null ? text(utf8Text(bytes)) : fn(bodyData(bytes))));
  s.bodyUsed = true;
  const read = () => (text !== null ? text(bodyText(s)) : fn(bytesOf(s)));
  const signal = s.fetchSignal;
  if (signal && signalMayAbort(signal)) {
    return promiseThen.call(resolvedPromise(), () => {
      if (signalAborted(signal)) throw signalReason(signal);
      return read();
    });
  }
  try { return resolvedPromise(read()); } catch (e) { return rejectedPromise(e); }
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
export const responseBytes = (resp) => consumeBody(resp, 'arrayBuffer', (data) => dom.blobBytes(data));
export const responseText = (resp) => consumeBody(resp, 'text', null, (t) => t);
const body = {
  get_body: (o) => bodyStreamOf(bodyOf(o)),
  get_bodyUsed: (o) => bodyUsedOf(bodyOf(o)),
  arrayBuffer: (o) => consumeBody(o, 'arrayBuffer', (data) => dom.blobBytes(data).buffer),
  // (…a Blob of the bytes themselves, no copy of them: blob.js `blobOfBytes`)
  blob: (o) => consumeBody(o, 'blob', (data) => blobOfBytes(data, extractMimeType(contentTypeOf(bodyOf(o))))),
  bytes: (o) => consumeBody(o, 'bytes', (data) => dom.blobBytes(data)),
  formData: (o) => consumeBody(o, 'formData', (data) => parseBodyToFormData(data, extractMimeType(contentTypeOf(bodyOf(o))))),
  // (…JSON.parse of an empty body throws: rejects)
  json: (o) => consumeBody(o, 'json', null, jsonParse),
  text: (o) => consumeBody(o, 'text', null, (t) => t),
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
export class Request extends Object {
  constructor(input, init) {
    const converted = convertRequestArguments(arguments);
    input = converted[0];
    init = converted[1];
    const self = createObject(new.target);
    constructRequest(self, input, init, CONSTRUCT_REQUEST);
    return self;
  }
}
rootInterface(Request);
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
      FIELD_ORIGIN_NULL = 15, FIELD_COOKIE_CROSS_SITE = 16, FIELD_HEADERS_GUARD = 17, FIELD_NAVIGATION_CROSS_SITE = 18;
class RequestSlots {
  constructor(state) {
    this.realm = REALM;
    this.state = state;
    this.signal = null;
    this.headers = null;
    this.bodyBytes = null;
    this.bodyNull = true;
    this.bodyUsed = false;
    this.bodyStream = null;
    this.bodyIsStream = false;
    this.blobSnapshot = null;
  }
  field(k) { return dom.requestField(this.state, k); }
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
  get navigationCrossSite() { return this.field(FIELD_NAVIGATION_CROSS_SITE); }
  // …and what a request no Request constructor makes takes of `record` (`requestAdopt`): a cached one's, the client's request a service worker's fetch event hands it.
  adopt(record) { dom.requestAdopt(this.state, record); }
}
Object.setPrototypeOf(RequestSlots.prototype, null);   // (…a record of no prototype: webidl.js `makeSlots`)
// The Request constructor's steps (Fetch "new Request(input, init)", §5.4) on `o`, its arguments converted (`input` a
// string or a Request, `init` a RequestInit) — fetch()'s, which constructs one, too: `prefix` the messages'. Its request
// is the engine's to make, refusals and all (request_state.rs); the signal, headers and body are the bindings'.
function constructRequest(o, input, init, prefix) {
  const from = typeof input === 'string' ? undefined : requestOf(input);
  const state = new dom.RequestStateBase(from === undefined ? null : from.state, from === undefined ? input : null, init,
                                                      apiBaseURL(), documentOrigin(), prefix);
  const s = makeSlots(o, 'Request', new RequestSlots(state));
  const nonEmpty = objectKeys(init).length > 0;
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
  if ((initBody !== null || inputHasBody) && dom.requestRefusesBody(state)) {
    throw new TypeError(prefix + 'Request with GET/HEAD method cannot have body.');
  }
  if (initBody !== null) {
    const { bytes, stream, type } = extractBody(initBody, s.keepalive, prefix, (stream) => `The provided ReadableStream is ${stream.locked ? 'locked' : 'disturbed'}`);
    if (stream !== null) {
      const refusal = dom.requestStreamRefusal(state, init.duplex !== undefined);
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
    // (…a stream body as init's is one — in mode "same-origin" or "cors" alone, which its CORS preflight needs: Fetch
    // "new Request" asks it of inputOrInitBody, the duplex of init's alone, before it asks whether the input is usable)
    const refusal = from.bodyIsStream ? dom.requestStreamRefusal(state, true) : null;
    if (refusal !== null) throw new TypeError(prefix + refusal);
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
  s.blobSnapshot = from !== undefined ? from.blobSnapshot : schemeRoute(s.url) === ROUTE_BLOB ? resolveBlobBytes(s.url) : null;
  // A source Request with a byte body is DISTURBED by the construction once it has fully succeeded — whether or not
  // init's body replaced its own (request-disturbed); one that threw above leaves it untouched.
  if (from !== undefined && !from.bodyNull && !from.bodyIsStream && !bodyUsedOf(from)) markBodyConsumed(from);
  return o;
}
installRequest(Request, ownFetchRealm('Request', requestOf, {
  get_duplex: () => 'half',
  // Fetch "clone a request" (its usability the calling realm's to check: `ownFetchRealm`): its request copied — its headers with their guard (a service worker's
  // `event.request.clone()` stays immutable) — its body cloned, and a signal following its own.
  clone(r) {
    const s = requestOf(r);
    const c = objectCreate(Request.prototype);
    const cs = makeSlots(c, 'Request', new RequestSlots(new dom.RequestStateBase(s.state)));
    cs.headers = copyHeaders(s.headers, headersGuard(s.headers), false);
    cs.signal = anySignal([s.signal]);
    cs.blobSnapshot = s.blobSnapshot;
    cloneBody(s, cs);
    return c;
  },
  ...body
}));
// ── Response ──
export const responseOf = (o) => slotsOf(o, 'Response');
registerInterface('Response', (o) => responseOf(o) !== undefined);
export class Response extends Object {
  constructor(body, init) {
    const converted = convertResponseArguments(arguments);
    body = converted[0];
    init = converted[1];
    const self = createObject(new.target);
    initResponse(self, init, body === null ? null : extractBody(body, false, CONSTRUCT_RESPONSE, () => 'Response body object should not be disturbed or locked'), CONSTRUCT_RESPONSE);
    return self;
  }
}
rootInterface(Response);
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
    this.bodyBytes = null;
    this.bodyNull = true;
    this.bodyUsed = false;
    this.bodyStream = null;
    this.bodyIsStream = false;
  }
  field(k) { return dom.responseField(this.state, k); }
  get type() { return this.field(R_TYPE); }
  get url() { return this.field(R_URL); }
  get status() { return this.field(R_STATUS); }
  get statusText() { return this.field(R_STATUS_TEXT); }
  get redirected() { return this.field(R_REDIRECTED); }
  get ok() { return this.field(R_OK); }
}
Object.setPrototypeOf(ResponseSlots.prototype, null);   // (…a record of no prototype: webidl.js `makeSlots`)
// A Response object `o` of a response the engine makes (`ResponseStateBase`'s kinds), with `headers`.
function makeResponse(o, args, headers, raw, fetchSignal) {
  const state = reflectConstruct(dom.ResponseStateBase, args);
  return makeSlots(o, 'Response', new ResponseSlots(state, headers, raw, fetchSignal));
}
// Fetch "initialize a response" (§5.5) of `o`, `init` a ResponseInit converted, `body` an extracted one or null: its
// status and status message the engine's to judge (a RangeError, a TypeError), the headers filled through the
// 'response' guard (which drops set-cookie / set-cookie2 — header-setcookie), and a body a TypeError for a null body
// status, its Content-Type appended where the headers give none.
function initResponse(o, init, body, prefix) {
  const state = new dom.ResponseStateBase('init', init.status, init.statusText, prefix);
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
  const o = objectCreate(Response.prototype);
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
  if (raw.opaque_abort && signal) addAbortAlgorithm(signal, raw.opaque_abort);
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
    // Fetch "clone a response" (its usability the calling realm's to check: `ownFetchRealm`): its response copied — its headers with their guard (a script's mutable 'response' one
    // stays mutable, response-clone) — and its body cloned.
    clone(r) {
      const s = responseOf(r);
      const c = objectCreate(Response.prototype);
      const cs = makeResponse(c, ['clone', s.state], copyHeaders(s.headers, headersGuard(s.headers), false), s.raw, s.fetchSignal);
      cloneBody(s, cs);
      return c;
    },
    ...body
  }),
  // A network error: status 0, no body, immutable headers (static-error).
  error: () => {
    const o = objectCreate(Response.prototype);
    makeResponse(o, ['error'], networkHeaders(null));
    return o;
  },
  // A redirect to `url` of a redirect status — refused where the engine refuses it — no body, its Location the URL as it
  // parsed, its headers immutable (response-static-redirect).
  redirect(self, url, status) {
    const state = new dom.ResponseStateBase('redirect', url, status, apiBaseURL(), "Failed to execute 'redirect' on 'Response': ");
    const o = objectCreate(Response.prototype);
    makeSlots(o, 'Response', new ResponseSlots(state, networkHeaders({ location: dom.responseField(state, R_LOCATION) })));
    return o;
  },
  // `data` serialized to JSON bytes (a TypeError where it serializes to nothing — a bare Symbol / function,
  // response-static-json; a BigInt makes JSON.stringify itself throw), a response of them, application/json where the
  // headers give no Content-Type.
  static_json(self, data, init) {
    const text = jsonStringify(data);
    if (text === undefined) throw new TypeError("Failed to execute 'json' on 'Response': The data is not JSON serializable");
    const o = objectCreate(Response.prototype);
    const body = { bytes: bodyData(text), stream: null, type: 'application/json' };
    return initResponse(o, init, body, "Failed to execute 'json' on 'Response': ");
  }
});


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
    request = constructRequest(objectCreate(Request.prototype), input, toRequestInit(arguments[1], prefix), prefix);
  } catch (e) { return rejectedPromise(e); }
  const s = requestOf(request);
  if (signalAborted(s.signal)) {
    if (s.bodyIsStream && !s.bodyStream.locked) {
      try { promiseThen.call(s.bodyStream.cancel(signalReason(s.signal)), undefined, () => {}); } catch (_) {}
    }
    return rejectedPromise(signalReason(s.signal));
  }
  return fetchRequest(s, J_FETCH);
}
globalThis.fetch = fetch;
// `navigator.sendBeacon`'s fetch: a keepalive, credentialed POST of `data`, its Resource Timing initiator 'beacon' — of
// mode "no-cors" unless its body's Content-Type is no CORS-safelisted one (Beacon "sendBeacon": the engine's,
// fetch_rules.rs `beacon_cors`; only a Blob's is a type of its own, any other BodyInit's a safelisted one or none).
// Whether it was queued: false where it would exceed the keepalive quota.
export function beacon(url, data) {
  const mode = isBlob(data) && dom.beaconCors(data.type) ? 'cors' : 'no-cors';
  const request = constructRequest(objectCreate(Request.prototype), url, { method: 'POST', body: data, keepalive: true, credentials: 'include', mode }, '');
  let queued = true;
  promiseThen.call(fetchRequest(requestOf(request), J_FETCH | (FETCH_BEACON << 8), () => { queued = false; }), undefined, () => {});
  return queued;
}
const isBlob = interfaceCheck('Blob');
// Fetch the request `s` (a Request's slots) — Fetch "fetch(input, init)" from its step 10: `timingKind` the kind of its
// Resource Timing entry (constants.js J_FETCH, a beacon's detailed) — a keepalive one's `overQuota` called, as it is
// refused, where its body would exceed the keepalive quota.
function fetchRequest(s, timingKind, overQuota = null) {
  // (…none of a document no longer fully active — a removed frame's: its fetch group terminated, a network error, a
  // TypeError in Chrome and Firefox — whose tasks would never run to answer it)
  if (!dom.documentFullyActive()) return rejectedPromise(new TypeError('Failed to fetch'));
  const timingStart = globalThis.__csimPerformanceNow();
  const signal = s.signal;
  // (…a signal that follows none — a request's of no signal given — never aborts: no abort steps to add)
  const abortable = signalMayAbort(signal);
  // Performing a fetch disturbs the request's body (Fetch reads it to the wire) — synchronously, before any scheme
  // branch (blob: / data: return early below), so `bodyUsed` is true the instant fetch() returns. A GENUINE stream body
  // is drained (and disturbed) by the wire read below, so it is only flagged here — locking it now would fail that
  // read.
  if (!s.bodyNull) {
    if (s.bodyIsStream) s.bodyUsed = true;
    else markBodyConsumed(s);
  }
  // The request as Fetch takes it — the engine's (fetch-request.js `describeRequest`: its default headers, its referrer
  // source and policy, its client) — and the leg that answers it: a preload its document has, a scheme's processor, a
  // network error (main fetch's `same-origin` refusal), the controlling service worker, a keepalive request's own
  // thread, or the network.
  const { route, request, worker, preloaded, controller } = describeRequest(s.state, headerListOf(s.headers));
  const url = request.url;
  // Fetch's main fetch: a response the request's integrity metadata refuses — the engine's (integrity.rs
  // `integrity_refuses`: an opaque one, whose body is null, by any; else by SRI's matching, the strongest algorithm's
  // digests, metadata with none it knows no check) — is a network error, whatever leg answered it (`raw` its record,
  // `response` the Response made of it).
  const integrityMeta = s.integrity;
  const integrityRefuses = (raw, response) => !!integrityMeta &&
    dom.integrityRefuses(bytesOf(responseOf(response)), String(integrityMeta), raw.type === 'opaque');
  const integrityFailure = () => new TypeError('Failed to fetch: integrity check failed for ' + url);
  return new IntrinsicPromise(function (resolve, reject) {
    // The promise settles once: with the response, with a network error, or by the abort steps the request's signal runs
    // as it aborts (Fetch "fetch(input, init)" step 12, "abort the fetch() call") — rejected with its reason then,
    // whichever leg is answering it, and what that leg answers after it dropped; a stream body still being read to the
    // wire cancelled with it (`drain`'s reader).
    let settled = false;
    const drain = { reader: null };
    const inFlight = ++fetchSerial;
    const settle = () => {
      if (settled) return false;
      settled = true;
      if (abortable) removeAbortAlgorithm(signal, abortSteps);
      delete fetchesInFlight[inFlight];
      return true;
    };
    const answer = (response) => { if (settle()) resolve(response); };
    const fail = (error) => { if (settle()) reject(error); };
    const terminate = (error) => {
      fail(error);
      if (drain.reader !== null) promiseThen.call(drain.reader.cancel(error), undefined, () => {});
    };
    const abortSteps = () => terminate(signalReason(signal));
    if (abortable) addAbortAlgorithm(signal, abortSteps);
    // (…as its document aborts too — HTML "abort a document" — but a keepalive request, which outlives it)
    if (route !== ROUTE_KEEPALIVE) fetchesInFlight[inFlight] = terminate;
    // (…`raw` the record a leg answered with, made a Response — a network error where its integrity refuses it)
    const deliver = (raw) => {
      try {
        const response = responseFromRaw(raw, url, signal);
        if (integrityRefuses(raw, response)) fail(integrityFailure());
        else answer(response);
      } catch (e) { fail(e); }
    };
    // Each answered on a task of its own, as Fetch answers in parallel: awaiting the fetch yields to the tasks queued
    // before its answer — Turbo Drive's render chain runs ahead of none of it.
    const later = (step) => globalThis.__csimSetTimeout(step, 0);
    if (route === ROUTE_PRELOADED) {
      later(() => (preloaded === null ? fail(new TypeError('Failed to fetch')) : deliver(preloaded)));
      return;
    }
    if (route === ROUTE_DATA || route === ROUTE_BLOB) {
      // (…a blob: URL's of the bytes the Request referenced at construction, so a `URL.revokeObjectURL(url)` issued
      // after it still finds the resource; a data: URL's of the WHATWG data: URL processor's — Discourse's PM image
      // extension fetches a pasted `data:image/png;base64,…` to wrap the bytes in a File)
      const raw = schemeResponse(route, request, s.blobSnapshot, getHeader(s.headers, 'range'));
      later(() => (raw ? deliver(raw) : fail(new TypeError('Failed to fetch: ' + url))));
      return;
    }
    // The request on the wire with its body, captured at construction (re-serializing a FormData would mint a new
    // multipart boundary mismatching the Content-Type): a ReadableStream body is the ONLY async case, drained to bytes
    // first (buffered upload) — every other body's network task is queued in the same turn as the fetch() call, as its
    // ordering against a timer that turn sets is observable under the deterministic clock.
    const send = (body) => (route === ROUTE_KEEPALIVE ? sendKeepalive(body) : later(() => { if (!settled) sendNow(body); }));
    // (…`timing(bytes)` its entry's facts: the response's, or a worker's answer's, sized by `bytes` where they are had)
    const record = (timing) => {
      if (timingKind && typeof globalThis.__csimRecordResource === 'function') globalThis.__csimRecordResource({ name: url, kind: timingKind, startTime: timingStart, ...timing });
    };
    const finish = function (resp, timing = () => ({ resp })) {
      if (!resp) { record(timing()); fail(new TypeError('Network request failed: ' + url)); return; }
      // (…a streamed body — a worker's answer — read whole first where the request carries integrity metadata: Fetch's
      // main fetch checks the full body against it before handing the response over; its entry sized by it then)
      if (integrityMeta && resp.bodyStream) {
        promiseThen.call(collectBodyStream(resp.bodyStream), (bytes) => {
          record(timing(bytes));
          deliver({ ...resp, bodyStream: null, body_bytes: bytes });
        }, () => { record(timing()); fail(integrityFailure()); });
        return;
      }
      record(timing());
      deliver(resp);
    };
    const network = (hop, body) => {
      try { finish(globalThis.__rackFetch(hop, body)); } catch (e) { fail(e); }
    };
    function sendNow(body) {
      // (…a `same-origin` request to another origin a network error before Handle Fetch, which never reaches the
      // controlling worker — fetch-response-taint cross-origin "should fail")
      if (route === ROUTE_REFUSED) { finish(null); return; }
      if (route !== ROUTE_SERVICE_WORKER) { network(request, body); return; }
      // A controlled client's request goes to its service worker's `fetch` event first, hop by hop (sw-client.js
      // `swFetchChain`: a 3xx respondWith re-enters per the client's redirect mode — the worker observes every followed
      // hop, redirected-response's expected_intercepted_urls; the 21st follow rejects); a fall-through, or a worker gone,
      // to the network for its hop.
      swFetchChain(controller, request, worker, body, {
        alive: () => !settled,
        network,
        fail: (reason) => fail(new TypeError('Failed to fetch: ' + (reason ?? url))),
        done: (resp, hops, hopUrl) => finish(resp, (bytes) => ({ answer: workerAnswerFacts(resp, bytes, hops, hopUrl) }))
      });
    }
    // keepalive: the request dispatches NOW, synchronously, onto a detached host thread — the issuing realm may be
    // mid-teardown (an unload/pagehide handler's beacon) and no deferred task of its would ever run. The promise, if the
    // realm survives, resolves by polling the thread's one-shot result on normal ticks. (A controlled client's goes to
    // its service worker as any other — a keepalive THROUGH a service worker doesn't survive teardown yet.)
    function sendKeepalive(body) {
      let id = -1;
      try { id = globalThis.__csim_keepaliveStart(request, body) | 0; } catch (_) { id = -1; }
      // -1 = the 64 KiB in-flight payload quota is exhausted (Fetch: "if the sum of contentLength and
      // inflightKeepaliveBytes is greater than 64 KiB, then return a network error").
      if (id < 0) {
        if (overQuota) overQuota();
        fail(new TypeError('Failed to fetch: keepalive request over quota'));
        return;
      }
      const poll = function () {
        let r = null;
        try { r = globalThis.__csim_keepaliveTake(id); } catch (_) { r = null; }
        if (r && r.pending) { later(poll); return; }
        // BOUNDED DIVERGENCE: an abort rejected the promise as it aborted, but the detached thread completed the
        // transmission all the same (a real browser aborts it); abort/keepalive stays allowlisted on exactly this.
        if (settled) return;
        record({ resp: r });
        if (r) deliver(r);
        else fail(new TypeError('Network request failed: ' + url));
      };
      later(poll);
    }
    if (!s.bodyIsStream) {
      send(dom.blobBytes(s.bodyBytes ?? bodyData('')));
      return;
    }
    const stream = s.bodyStream;
    // (…getReader() — inside collectBodyStream — throws on a locked or disturbed stream: a rejection, never a throw)
    if (stream.locked || stream._disturbed) { fail(new TypeError('Failed to fetch: Request body stream is disturbed or locked')); return; }
    promiseThen.call(collectBodyStream(stream, drain), (bytes) => { drain.reader = null; if (!settled) send(bytes); }, fail);
  });
}
// The realm's `fetch()`es not yet answered, by the step that terminates each: what its document aborted cancels (HTML
// "abort a document"), each a network error, a TypeError (Chrome and Firefox), a stream body still being read cancelled
// with it. (A keepalive request's outlives its document; a service worker's answer under way goes on, dropped as it
// comes: KNOWN GAP — the worker is not told.)
// (…by a serial of each, a record of no prototype: no `add` or `delete` of a page's on every fetch's path)
let fetchesInFlight = { __proto__: null }, fetchSerial = 0;
globalThis.__csimAbortFetchRequests = () => {
  const aborted = fetchesInFlight;
  fetchesInFlight = { __proto__: null };
  for (const serial in aborted) aborted[serial](new TypeError('Failed to fetch'));
};
globalThis.Request  = Request;
globalThis.Response = Response;
