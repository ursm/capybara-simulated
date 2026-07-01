// `window.fetch(url, opts)` over the synchronous Rack call.
// `blob:` URLs resolve out of the in-process blob registry without
// going through the Rack stack.

import { bytesToArrayBuffer, bytesToLatin1, latin1ToBytes, utf8DecodeBytes, utf8EncodeBytes } from './bytes.js';
import { resolveBlobBytes }     from './blob.js';
import { processDataUrl }       from './data-url.js';
import { serializeRequestBody, findHeaderKey } from './request-body.js';

// The header guard a request's Headers carries for a given fetch mode (so forbidden /
// non-no-cors-safelisted headers are dropped). Shared by Request and fetch().
function guardForMode(mode) { return mode === 'no-cors' ? 'request-no-cors' : 'request'; }

// Fetch "normalize a method": byte-uppercase only a case-insensitive match for one of
// these; every other method (notably `patch`, `chicken`) keeps its original case. So
// `delete` → `DELETE` but `patch` stays `patch` — which matters for the case-sensitive
// CORS Allow-Methods check (cors-preflight-star).
const METHOD_NORMALIZE = new Set(['DELETE', 'GET', 'HEAD', 'OPTIONS', 'POST', 'PUT']);
function normalizeMethod(method) {
  const m = String(method);
  const upper = m.toUpperCase();
  return METHOD_NORMALIZE.has(upper) ? upper : m;
}

// Valid values for the Request init enum members + method rules — the Request constructor
// rejects anything outside these with a TypeError (request-error). An RFC 7230 method is a
// `token`; CONNECT/TRACE/TRACK are forbidden methods; no-cors allows only simple methods.
const REQUEST_MODE_ENUM        = ['same-origin', 'cors', 'no-cors', 'navigate'];
const REQUEST_CREDENTIALS_ENUM = ['omit', 'same-origin', 'include'];
const REQUEST_CACHE_ENUM       = ['default', 'no-store', 'reload', 'no-cache', 'force-cache', 'only-if-cached'];
const REQUEST_REDIRECT_ENUM    = ['follow', 'error', 'manual'];
const REFERRER_POLICY_ENUM     = ['', 'no-referrer', 'no-referrer-when-downgrade', 'same-origin',
  'origin', 'strict-origin', 'origin-when-cross-origin', 'strict-origin-when-cross-origin', 'unsafe-url'];
const FORBIDDEN_METHODS        = ['CONNECT', 'TRACE', 'TRACK'];
const CORS_SIMPLE_METHODS      = ['GET', 'HEAD', 'POST'];
const METHOD_TOKEN             = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

// A WebIDL enum member: undefined/absent is fine (the default applies), any other
// non-matching value is a TypeError.
function validateEnum(value, allowed, member) {
  if (value != null && !allowed.includes(String(value))) {
    throw new TypeError("Failed to construct 'Request': '" + value + "' is not a valid " + member);
  }
}

// The init-member validation of the Request constructor (everything that depends only on
// the init dict, not the input URL or an input Request's inherited settings) — a bad member
// throws a TypeError. Shared by the Request constructor and fetch(), since `fetch(input,
// init)` begins by constructing a Request, so a bad init must reject fetch's promise too
// (abort/general "constructor takes priority").
function validateRequestInit(init) {
  if (init.window != null) throw new TypeError("Failed to construct 'Request': 'window' must be null");
  validateEnum(init.mode,           REQUEST_MODE_ENUM,        'mode');
  validateEnum(init.credentials,    REQUEST_CREDENTIALS_ENUM, 'credentials mode');
  validateEnum(init.cache,          REQUEST_CACHE_ENUM,       'cache mode');
  validateEnum(init.redirect,       REQUEST_REDIRECT_ENUM,    'redirect mode');
  validateEnum(init.referrerPolicy, REFERRER_POLICY_ENUM,     'referrer policy');
  if (init.mode === 'navigate') throw new TypeError("Failed to construct 'Request': cannot construct a Request with mode 'navigate'");
  if (init.method != null) {
    const m = String(init.method);
    if (!METHOD_TOKEN.test(m) || FORBIDDEN_METHODS.includes(m.toUpperCase())) {
      throw new TypeError("Failed to construct 'Request': '" + m + "' is not a valid or allowed method");
    }
  }
  if (init.referrer != null && init.referrer !== '' && init.referrer !== 'about:client') {
    try { new globalThis.URL(String(init.referrer), globalThis.location && globalThis.location.href); }
    catch (_) { throw new TypeError("Failed to construct 'Request': Referrer '" + init.referrer + "' is invalid"); }
  }
}

// The mode/method/cache COMBINATION checks — these must run against a request's EFFECTIVE
// values (an init override, else the value inherited from an input Request, else the
// default), so a clone like `new Request(sameOriginReq, {cache:'only-if-cached'})` is
// judged on the inherited 'same-origin' mode, not the 'cors' default (request-error).
function validateRequestCombination(mode, method, cache) {
  if (mode === 'no-cors' && !CORS_SIMPLE_METHODS.includes(method)) {
    throw new TypeError("Failed to construct 'Request': method '" + method + "' is not allowed in no-cors mode");
  }
  if (cache === 'only-if-cached' && mode !== 'same-origin') {
    throw new TypeError("Failed to construct 'Request': cache mode 'only-if-cached' can only be used with mode 'same-origin'");
  }
}

// "Extract a body" → a canonical latin-1 BYTE string. Mutates `headersObj` (a plain
// object) to add the body's implied Content-Type (text/plain for a string, the blob's
// type, multipart boundary, urlencoded, …). Reuses serializeRequestBody, which returns
// the body as base64 (binary) or a USVString (text). A ReadableStream body isn't
// sync-extractable — left to String() (stream-body consumption is a separate item).
function extractBodyBytes(body, headersObj) {
  if (body == null) return '';
  const { body: out, b64 } = serializeRequestBody(body, headersObj);
  return b64 ? globalThis.atob(out) : utf8EncodeBytes(out);
}

// Body `formData()`: parse the bytes per Content-Type into a FormData. urlencoded →
// URLSearchParams pairs; multipart/form-data → each part's Content-Disposition name +
// value (a `filename` part becomes a File). Any other type rejects (TypeError).
// UTF-8 decode that KEEPS a leading BOM — form-data field values and urlencoded
// keys/values are not BOM-stripped (a whole-body text() is; url/urlencoded-parser).
function utf8DecodeKeepBom(byteStr) {
  try { return new globalThis.TextDecoder('utf-8', { ignoreBOM: true }).decode(latin1ToBytes(byteStr)); } catch (_) { return byteStr; }
}
function parseBodyToFormData(byteStr, contentType) {
  const raw = String(contentType || '');
  const fd  = new globalThis.FormData();
  if (raw.toLowerCase().indexOf('application/x-www-form-urlencoded') === 0) {
    for (const [k, v] of new globalThis.URLSearchParams(utf8DecodeKeepBom(byteStr))) fd.append(k, v);
    return Promise.resolve(fd);
  }
  // Match the type case-insensitively but capture the boundary in its ORIGINAL case —
  // a multipart boundary is case-SENSITIVE, so lowercasing it breaks the body split.
  const m = raw.match(/multipart\/form-data;.*\bboundary=("?)([^";]+)\1/i);
  if (!m) return Promise.reject(new TypeError('Body cannot be decoded as form data, mime type is not multipart/form-data or application/x-www-form-urlencoded'));
  // A body that doesn't even contain the boundary (empty / malformed) is a parse
  // error, not an empty FormData (request-consume-empty's multipart error case).
  if (byteStr.indexOf('--' + m[2]) === -1) return Promise.reject(new TypeError('Failed to parse multipart body.'));
  for (let part of byteStr.split('--' + m[2])) {
    part = part.replace(/^\r\n/, '');
    if (part === '' || part === '--' || part.slice(0, 2) === '--') continue;   // preamble / closing
    const sep = part.indexOf('\r\n\r\n');
    if (sep === -1) continue;
    const head = part.slice(0, sep), value = part.slice(sep + 4).replace(/\r\n$/, '');
    const cd = head.match(/content-disposition:[^\r\n]*/i);
    const name = cd && cd[0].match(/\bname="([^"]*)"/i);
    if (!name) continue;
    const file = cd[0].match(/\bfilename="([^"]*)"/i);
    if (file) {
      const fct = head.match(/content-type:\s*([^\r\n]+)/i);
      fd.append(name[1], new globalThis.File([latin1ToBytes(value)], file[1], { type: fct ? fct[1].trim() : '' }));
    } else {
      // A multipart field value keeps a leading BOM (unlike a whole-body text()
      // decode) — response-consume "…with BOM".
      fd.append(name[1], utf8DecodeKeepBom(value));
    }
  }
  return Promise.resolve(fd);
}

// A body's ReadableStream is a readable BYTE stream over the canonical bytes, so a consumer
// can take a BYOB reader (getReader({mode:'byob'})) and read with an offset
// (response-consume-stream). An empty body enqueues nothing — a byte controller rejects a
// zero-length chunk — and just closes.
function createBodyByteStream(latin1) {
  const u8 = latin1ToBytes(latin1);
  return new globalThis.ReadableStream({
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
// rejection (response-error-from-stream). `strict` (a REQUEST body being drained to the wire)
// REJECTS on a non-BufferSource chunk — a string / number / null (request-upload.h2 "Streaming
// upload with body containing …"); non-strict (a RESPONSE body read) skips such a chunk. On
// success the reader lock is DELIBERATELY kept: a fully-consumed body's stream stays locked,
// so a later `.body.getReader()` throws (response-stream-disturbed-5). The lock is released
// only on error.
function collectBodyStream(stream, strict) {
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  function pump() {
    return reader.read().then(({ done, value }) => {
      if (done) return;
      const u8 = value == null ? null : chunkToU8(value);
      if (!u8) {
        if (strict) throw new TypeError('Failed to fetch: a request body ReadableStream chunk is not a BufferSource');
        return pump();
      }
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
  const cloned = new globalThis.ReadableStream({
    pull(controller) {
      return reader.read().then(({ done, value }) => {
        if (done) { controller.close(); return; }
        controller.enqueue(globalThis.structuredClone ? globalThis.structuredClone(value) : value);
      });
    },
    cancel(reason) { return reader.cancel(reason); }
  });
  return [a, cloned];
}

// `.body`: null for a null body; otherwise a single ReadableStream, created lazily from the
// canonical bytes (or the stream the body was built from) and cached so `x.body === x.body`.
function bodyStreamOf(o) {
  if (o._bodyNull) return null;
  if (!o._bodyStream) {
    o._bodyStream = createBodyByteStream(o._bodyBytesRaw());
    // If the byte body was ALREADY consumed via the fast path, the exposed stream must
    // reflect that: lock it (a fully-read body keeps its reader) so `.body` is non-null but
    // `.body.getReader()` throws and a re-read rejects (response-stream-disturbed-5).
    if (o._bodyUsed) o._bodyStream.getReader();
  }
  return o._bodyStream;
}
// `.bodyUsed`: a null body is never used; a streamed body tracks the stream's disturbed bit;
// an as-yet-unstreamed byte body tracks the fast-path flag.
function bodyUsedOf(o) {
  if (o._bodyNull) return false;
  // The fast-path flag survives a later `.body` access (which mints a fresh stream), so a
  // byte body consumed before `.body` was touched still reports used.
  if (o._bodyUsed) return true;
  return o._bodyStream ? o._bodyStream._disturbed === true : false;
}

// Shared Body interface for Request / Response: every accessor derives from the canonical
// latin-1 bytes (+ `_bodyContentType()` for blob/formData). A body is consumed exactly once:
// once its stream has been exposed, a further read rejects if that stream is disturbed or
// locked; otherwise the byte fast path is one-shot.
const BodyMixin = {
  // Synchronous "unusable body" guard: returns a rejected promise to short-circuit, or null to
  // proceed. It rejects WITHOUT an extra microtask hop, so an aborted / disturbed / already-
  // consumed body rejects in the same turn — the reject-vs-next-microtask ordering abort/general
  // "rejects if already aborted" measures.
  _bodyGuard() {
    // A body read on an aborted response rejects with the abort reason (abort/general).
    // Requests hold their signal as `_signalRef`, so this never fires for a Request (abort/request).
    if (this._signal && this._signal.aborted) return Promise.reject(this._signal.reason);
    if (this._bodyNull) return null;   // a null body reads as empty, repeatably (request-consume-empty)
    const stream = this._bodyStream;
    if (stream) {
      // "consume body": a disturbed or locked body stream is unusable (response-stream-disturbed-1..4).
      if (stream.locked || stream._disturbed) {
        return Promise.reject(new TypeError('Failed to read the body: the body stream is disturbed or locked'));
      }
      return null;
    }
    // Fast path: a byte body whose stream was never exposed is one-shot.
    if (this._bodyUsed) return Promise.reject(new TypeError('Body has already been consumed.'));
    return null;
  },
  // Guard first (a sync rejection for an unusable body), then apply `fn` to the body's latin-1
  // bytes. A streamed body is fully read and chains onto its read promise (errors propagate —
  // response-error-from-stream). Otherwise the bytes are known synchronously: the byte body is
  // marked used and `fn` runs in ONE Promise (a direct fetch consume — no extra microtask hop).
  // The sync-vs-stream choice keys off `_bodyStream` (state we own), NOT a `.then` probe on the
  // value — a probe would honour a poisoned Object.prototype.then (response "should not be
  // possible" via Object.prototype.then). A synchronous throw from `fn` (JSON.parse of a
  // non-JSON body) becomes a rejection, not a thrown error.
  _readBody(fn) {
    const g = this._bodyGuard();
    if (g) return g;
    if (this._bodyStream) return collectBodyStream(this._bodyStream, false).then(fn);
    const b = this._bodyNull ? '' : (this._bodyUsed = true, this._bodyBytesRaw());
    try { return Promise.resolve(fn(b)); } catch (e) { return Promise.reject(e); }
  },
  text()        { return this._readBody(utf8DecodeBytes); },
  // JSON.parse of an empty body throws (rejects) — no `|| 'null'` fallback.
  json()        { return this._readBody(jsonFromBytes); },
  arrayBuffer() { return this._readBody(bytesToArrayBuffer); },
  bytes()       { return this._readBody(latin1ToBytes); },
  blob()        { return this._readBody(b => new globalThis.Blob([latin1ToBytes(b)], { type: this._bodyContentType() })); },
  formData()    { return this._readBody(b => parseBodyToFormData(b, this._bodyContentType())); }
};
function jsonFromBytes(b) { return JSON.parse(utf8DecodeBytes(b)); }

// `Request(input, init)` — spec value type. Many fetch-wrapper
// libraries (jose, ofetch, ky, MSW handlers) construct a Request
// before delegating to fetch. We hold the same fields the spec
// exposes; `clone()` returns a structural copy.
class Request {
  constructor(input, init) {
    init = init || {};
    // Constructor validation (Fetch "Request(input, init)"): a non-null `window`, a bad enum
    // value, mode 'navigate', a bad method, an invalid no-cors/only-if-cached combination,
    // or an invalid referrer is a TypeError (request-error). The input-URL checks are below.
    validateRequestInit(init);
    // The header guard follows the request mode and is set BEFORE any header is added,
    // so a no-cors request drops non-safelisted headers and any request drops
    // forbidden ones at construction (headers-forbidden-override / -no-cors).
    this._mode = init.mode || (input instanceof Request ? input.mode : null) || 'cors';
    const guard = guardForMode(this._mode);
    if (input instanceof Request) {
      this._url    = input.url;
      this._method = input.method;
      this._body  = input._body;
      // init.headers, when present, REPLACES the source request's header list (Fetch
      // "Request" init) — only inherit input's headers when init gives none.
      this._headers = new globalThis.Headers(init.headers == null ? input.headers : undefined, guard);
      // Carry the blob snapshot through clone() so a cloned Request still fetches
      // after the original URL was revoked.
      this._blobSnapshot = input._blobSnapshot;
    } else {
      // Parse the input against the document base URL: an unparseable URL, or one carrying
      // credentials (`user:pass@`), is a TypeError (request-error).
      let parsed;
      try { parsed = new globalThis.URL(String(input), globalThis.location && globalThis.location.href); }
      catch (_) { throw new TypeError("Failed to construct 'Request': Failed to parse URL from " + input); }
      if (parsed.username !== '' || parsed.password !== '') {
        throw new TypeError("Failed to construct 'Request': Request cannot be constructed from a URL that includes credentials");
      }
      this._url    = parsed.href;
      this._method = 'GET';
      this._body  = null;
      this._headers = new globalThis.Headers(undefined, guard);
      // Take a reference to a blob: URL's bytes at construction (the Request
      // "receives" the URL here), so a later URL.revokeObjectURL still resolves.
      this._blobSnapshot = this._url.startsWith('blob:') ? resolveBlobBytes(this._url) : null;
    }
    if (init.method != null) this._method = normalizeMethod(String(init.method));   // validated in validateRequestInit
    if (init.body != null) this._body = init.body;
    // duplex: only 'half' is supported ('full' request streaming is not), so any other value
    // — 'full' included — is a TypeError. A ReadableStream init body additionally REQUIRES an
    // explicit duplex:'half' (request-init-stream); an inherited stream body does not.
    const initBodyIsStream = init.body != null && globalThis.ReadableStream && init.body instanceof globalThis.ReadableStream;
    if (init.duplex !== undefined && init.duplex !== 'half') {
      throw new TypeError("Failed to construct 'Request': the only supported value for duplex is 'half'.");
    }
    if (initBodyIsStream && init.duplex !== 'half') {
      throw new TypeError("Failed to construct 'Request': the `duplex` member must be specified for a request with a streaming body.");
    }
    // A GET/HEAD request cannot carry a body (Fetch "Request" — this includes a body
    // inherited from an input Request), so a body with either method is a TypeError.
    if (this._body != null && (this._method === 'GET' || this._method === 'HEAD')) {
      throw new TypeError("Failed to construct 'Request': Request with GET/HEAD method cannot have body.");
    }
    if (init.headers) {
      if (init.headers instanceof globalThis.Headers) {
        init.headers.forEach((v, k) => this._headers.append(k, v));
      } else if (Array.isArray(init.headers)) {
        for (const pair of init.headers) this._headers.append(pair[0], pair[1]);
      } else if (typeof init.headers === 'object') {
        for (const [k, v] of Object.entries(init.headers)) this._headers.append(k, v);
      }
    }
    // A Request built from another Request inherits its settings when init omits them
    // (Fetch "new Request" — same as `mode`/`referrerPolicy` above), so a cloned Request
    // keeps its credentials mode, cache/redirect policy, and referrer.
    const from = input instanceof Request ? input : null;
    this._credentials = init.credentials || (from && from.credentials) || 'same-origin';
    this._cache       = init.cache       || (from && from.cache)       || 'default';
    this._redirect    = init.redirect    || (from && from.redirect)    || 'follow';
    // Combination checks against the EFFECTIVE (possibly inherited) mode/method/cache.
    validateRequestCombination(this._mode, this._method, this._cache);
    // `referrer: ''` is the no-referrer intent — preserve it (don't coerce via `||`), so a
    // Request built with it keeps '' and fetch(request) sends no Referer. Inherit the
    // source Request's referrer (which may itself be '') when init omits it.
    this._referrer       = init.referrer != null ? init.referrer : (from ? from.referrer : 'about:client');
    this._referrerPolicy = init.referrerPolicy || (from && from.referrerPolicy) || '';
    this._integrity   = init.integrity   || '';
    // The request's signal is always a NEW AbortSignal that FOLLOWS the source — an
    // explicit init.signal, else the input Request's signal (a null init.signal removes
    // it). So a clone reflects the source's aborted state without aliasing it (abort/general
    // "Signal on request object").
    const sigSource = init.signal !== undefined ? init.signal : (from ? from.signal : null);
    // NB: stored as `_signalRef`, NOT `_signal` — the shared BodyMixin's `_signal` abort-reject
    // is a RESPONSE-only rule (a fetch's abort rejects a response body read). A Request's own
    // body read is unaffected by its signal's aborted state (abort/request).
    this._signalRef  = globalThis.AbortSignal.any(sigSource ? [sigSource] : []);
    this._bodyUsed   = false;
    // The body's ReadableStream, exposed lazily via `.body`; set eagerly only when the body
    // IS a stream (or is inherited from a request whose stream was already exposed).
    // `_bodyIsStream` marks a GENUINE stream body (vs a lazily-exposed byte body) so fetch
    // drains it to the wire instead of the (empty) captured bytes.
    this._bodyStream   = null;
    this._bodyIsStream = false;
    // Canonical body bytes (for the Body accessors), plus the body's implied
    // Content-Type set on the headers when the author gave none.
    if (input instanceof Request && init.body == null) {
      // clone / re-wrap: carry the SAME captured bytes (a re-serialized FormData would
      // mint a new multipart boundary that no longer matches the copied Content-Type).
      this._bodyBytes = input._bodyBytes;
      this._bodyNull  = input._bodyNull;
      // The source request's body must not be already used (Fetch "Request" — a disturbed /
      // used input body is a TypeError), whether it was consumed via the byte fast path
      // (`_bodyUsed`) or via an exposed, disturbed/locked stream (request-init-stream
      // "Constructing a Request with a Request on which …").
      if (bodyUsedOf(input) || (input._bodyStream && input._bodyStream.locked)) {
        throw new TypeError("Failed to construct 'Request': Cannot construct a Request with a Request object whose body is disturbed or locked");
      }
      // A body already exposed as a stream is tee'd so both requests read an independent branch.
      if (input._bodyStream) {
        const [a, b] = input._bodyStream.tee();
        input._bodyStream = a;
        this._bodyStream  = b;
        this._bodyIsStream = input._bodyIsStream;   // a genuine stream body drains at send time
      }
    } else if (initBodyIsStream) {
      // A ReadableStream body is held as the request's body stream (its bytes are read from
      // the stream at consume/send time). It must be neither disturbed nor locked, and it is
      // held by identity — `request.body === body` (request-init-stream).
      if (this._body.locked || this._body._disturbed) {
        throw new TypeError("Failed to construct 'Request': The provided ReadableStream is disturbed or locked");
      }
      this._bodyStream   = this._body;
      this._bodyIsStream = true;
      this._bodyBytes    = '';
      this._bodyNull   = false;
    } else {
      this._bodyNull = (this._body == null);
      const h = {};
      this._bodyBytes = extractBodyBytes(this._body, h);
      const ctk = findHeaderKey(h, 'content-type');
      if (ctk && !this._headers.has('content-type')) this._headers.set('content-type', h[ctk]);
    }
  }
  // Every Request member is a read-only WebIDL attribute — expose getters over the private
  // backing fields so an author write is silently ignored (request-structure). `destination`,
  // `isReloadNavigation`, `isHistoryNavigation`, and `duplex` are constants for a
  // constructor-built request (no navigation / reload / duplex-stream body modelled).
  get method()              { return this._method; }
  get url()                 { return this._url; }
  get headers()             { return this._headers; }
  get destination()         { return ''; }
  get referrer()            { return this._referrer; }
  get referrerPolicy()      { return this._referrerPolicy; }
  get mode()                { return this._mode; }
  get credentials()         { return this._credentials; }
  get cache()               { return this._cache; }
  get redirect()            { return this._redirect; }
  get integrity()           { return this._integrity; }
  get isReloadNavigation()  { return false; }
  get isHistoryNavigation() { return false; }
  get duplex()              { return 'half'; }
  get signal()              { return this._signalRef; }
  get bodyUsed()            { return bodyUsedOf(this); }
  get body()                { return bodyStreamOf(this); }
  _bodyBytesRaw()    { return this._bodyBytes || ''; }
  _bodyContentType() { return this._headers.get('content-type') || ''; }
  clone()            { return new Request(this); }
}
Object.assign(Request.prototype, BodyMixin);

// `body` carries the UTF-8 text form (legacy; fine for
// text/json/css/js). `body_b64` carries the raw bytes
// base64-encoded — Ruby always sends both. `arrayBuffer()` /
// `blob()` decode b64 to a latin-1 byte string so binary
// payloads (Tesseract.js's gzipped traineddata, image bytes)
// survive intact. Synthetic responses (blob:-URL handlers) pass
// only `body` — we fall back to `String(body)` there.
class FetchResponse {
  constructor(raw, url, signal) {
    this._raw       = raw;
    this._url       = url;
    // The fetch's abort signal — a body read after it aborts rejects with the abort reason
    // (abort/general "response.<method>() rejects if already aborted").
    this._signal    = signal || null;
    this._bodyText  = (raw && raw.body) || '';
    // Response headers are network-final (already combined by the HTTP stack) — fill
    // them verbatim, NOT through append's script-side normalization (header-value-combining).
    this.headers    = new globalThis.Headers()._fillRaw(raw && raw.headers);
    // An opaque (no-cors cross-origin) response has an empty URL list — don't fall back
    // to the request URL. Otherwise use the response URL, else the request URL.
    this.url        = (raw && raw.type === 'opaque') ? '' : ((raw && raw.url) || url);
    this.status     = raw ? raw.status : 0;
    // The HTTP reason phrase, already resolved Ruby-side (response_hash): a custom phrase, else
    // the status code's standard reason ("OK", "Not Modified", …). The public Response ctor
    // overrides this from its init after super(). (request-cache / status statusText.)
    this.statusText = (raw && raw.statusText != null) ? raw.statusText : '';
    this.ok         = this.status >= 200 && this.status < 300;
    this.redirected = !!(raw && raw.redirected);
    this.type       = raw && raw.type || 'basic';
    this._bodyUsed  = false;
    // The body's ReadableStream, created lazily on `.body` access (or set by the public
    // Response ctor when the body IS a stream).
    this._bodyStream = null;
    // A null-body status (204/205/304) or a HEAD response has no body — the Ruby side flags
    // it so response.body is null and text() is "" (response-null-body). Otherwise a fetched
    // response has a body (empty is still non-null).
    this._bodyNull  = !!(raw && raw.body_null);
  }
  // bodyUsed / body are read-only WebIDL attributes over the shared body helpers: bodyUsed
  // tracks the body stream's disturbed bit, and body is a lazily-created ReadableStream (null
  // for a null-body response).
  get bodyUsed() { return bodyUsedOf(this); }
  get body() { return bodyStreamOf(this); }
  // Canonical response body bytes (latin-1). The no-b64 path's `body` is ALREADY raw
  // bytes — either an ASCII network body (text === bytes) or a synthetic blob:/data:
  // handler's byte string — so return it verbatim (a non-ASCII network body always
  // arrives via body_b64). Coerce a Uint8Array body (the data: handler passes one).
  _bodyBytesRaw() {
    if (this._raw && typeof this._raw.body_b64 === 'string') {
      try { return globalThis.atob(this._raw.body_b64); } catch (_) { return ''; }
    }
    const b = this._bodyText;
    return (b && b.buffer && typeof b !== 'string') ? bytesToLatin1(b) : String(b || '');
  }
  _bodyContentType() { return (this.headers.get && this.headers.get('content-type')) || ''; }
  // Preserve the concrete class so a fetch()-result Response clones to a Response
  // (WASM loaders check `instanceof Response`), not a bare FetchResponse. Cloning a
  // disturbed (body-read) response is a TypeError; the clone copies the attributes that
  // live on the instance rather than in `_raw` (statusText, type) (response-clone).
  clone() {
    if (this.bodyUsed) throw new TypeError('Failed to execute clone: Response body is already used');
    const c = new this.constructor(this._raw, this._url, this._signal);
    c.statusText = this.statusText;
    c.type       = this.type;
    c._bodyNull  = this._bodyNull;   // _raw.body_null may not carry a public-Response null body
    // Fetch "clone a body": if the body stream was already exposed (or the body is itself a
    // stream), tee it so both responses read independently (branch 2 structure-clones its
    // chunks). A byte body not yet streamed clones lazily from the shared raw bytes.
    if (this._bodyStream) {
      const [a, b] = teeBodyForClone(this._bodyStream);
      this._bodyStream = a;
      c._bodyStream    = b;
    }
    return c;
  }
}
Object.assign(FetchResponse.prototype, BodyMixin);   // text/json/blob/arrayBuffer/bytes/formData

// Unified `Response` class — covers both the Fetch spec's public
// `new Response(body, init)` form and the internal `(raw, url)` form
// our fetch wrapper produces. Apps' WASM loaders check
// `module instanceof Response` (see Discourse @discourse/resize's
// `__wbg_load`), so the value `fetch()` resolves with HAS to be a
// Response instance, not a separate FetchResponse subclass.
class Response extends FetchResponse {
  constructor(bodyOrRaw, initOrUrl, signal) {
    const isInternal = bodyOrRaw && typeof bodyOrRaw === 'object' &&
                       ('status' in bodyOrRaw) && ('body' in bodyOrRaw);
    if (isInternal) {
      super(bodyOrRaw, initOrUrl, signal);
      return;
    }
    const init = initOrUrl || {};
    // status is a WebIDL `unsigned short`: coerce like the IDL layer (NaN/±∞ → 0, else
    // truncate toward zero mod 65536) so a non-integer / non-numeric value maps to a number
    // BEFORE the range check — `{status:"abc"}` → 0 → RangeError, `{status:200.5}` → 200.
    let status = init.status != null ? Number(init.status) : 200;
    status = Number.isFinite(status) ? (((Math.trunc(status) % 65536) + 65536) % 65536) : 0;
    // Response init validation (response-error): a status outside [200, 599] is a
    // RangeError; a statusText that isn't a valid HTTP reason-phrase (only HTAB, SP,
    // VCHAR, obs-text) is a TypeError; a body with a null-body status is a TypeError.
    if (status < 200 || status > 599) {
      throw new RangeError("Failed to construct 'Response': The status provided (" + status + ") is outside the range [200, 599]");
    }
    const statusText = init.statusText != null ? String(init.statusText) : '';
    if (!/^[\t\x20-\x7e\x80-\xff]*$/.test(statusText)) {
      throw new TypeError("Failed to construct 'Response': Invalid statusText");
    }
    if (bodyOrRaw != null && (status === 204 || status === 205 || status === 304)) {
      throw new TypeError("Failed to construct 'Response': Response with null body status cannot have body");
    }
    let headers = {};
    if (init.headers) {
      if (init.headers instanceof globalThis.Headers) {
        init.headers.forEach((v, k) => { headers[k] = v; });
      } else if (Array.isArray(init.headers)) {
        for (const [k, v] of init.headers) headers[k] = v;
      } else if (typeof init.headers === 'object') {
        Object.assign(headers, init.headers);
      }
    }
    // A Response's header list has the 'response' guard, which forbids the set-cookie /
    // set-cookie2 response headers — drop them from the init too (not just post-construction
    // mutations), matching browsers (header-setcookie "Set-Cookie is a forbidden response
    // header").
    for (const k of Object.keys(headers)) {
      const lk = k.toLowerCase();
      if (lk === 'set-cookie' || lk === 'set-cookie2') delete headers[k];
    }
    // "Extract a body" rather than String(body): a Blob / ArrayBuffer / typed-array /
    // FormData / URLSearchParams body becomes its real bytes (+ the body's implied
    // Content-Type, when the init set none), so the Body accessors work on it. A
    // ReadableStream body is kept as the response's body stream directly.
    const isStream = bodyOrRaw != null && globalThis.ReadableStream && bodyOrRaw instanceof globalThis.ReadableStream;
    const bytes = isStream ? '' : extractBodyBytes(bodyOrRaw, headers);
    super({status, body: utf8DecodeBytes(bytes), body_b64: globalThis.btoa(bytes), headers, url: ''}, '');
    // The guard also drops a later script set/append of those forbidden headers.
    this.headers._guard = 'response';
    this.statusText = statusText;
    this.type       = 'default';
    this._bodyNull  = (bodyOrRaw == null);   // new Response() / new Response(null) → null body
    // A stream body reads from the stream on consume; its errors propagate to the reader
    // (response-error-from-stream) and its disturbed/locked state gates re-reads.
    if (isStream) this._bodyStream = bodyOrRaw;
  }
  static json(data, init) {
    init = init || {};
    // Build through Headers (handles a Headers / array / record init — Object.assign of
    // a Headers would copy its internal fields, not its entries); default content-type
    // only when the author set none.
    const headers = new globalThis.Headers(init.headers);
    if (!headers.has('content-type')) headers.set('content-type', 'application/json');
    return new Response(JSON.stringify(data), Object.assign({}, init, {headers}));
  }
  // A network-error response has status 0 — built through the internal form so it bypasses
  // the public [200,599] status check (which would reject 0). Its header list is immutable
  // (a script set/append throws) (response-static-error).
  static error()             { const r = new Response({status: 0, body: '', headers: {}, url: '', body_null: true}, ''); r.type = 'error'; r.headers._guard = 'immutable'; return r; }
  static redirect(url, status) {
    // A redirect response has a NULL body (Fetch "Response.redirect") — response.body is null.
    const r = new Response(null, {status: status || 302, headers: {location: String(url)}});
    return r;
  }
}

globalThis.fetch = function fetch(input, init) {
  init = init || {};
  // fetch(input, init) begins by constructing a Request, so a bad init (a bad enum value,
  // an invalid/forbidden method, an invalid no-cors/only-if-cached combo, …) rejects the
  // promise with that TypeError — and does so with priority over an aborted signal
  // (abort/general "constructor takes priority"). The init is validated even for a Request
  // input, since a bad init override would fail that internal construction too. The
  // combination check runs against the EFFECTIVE mode/method/cache (init override, else the
  // input Request's value, else the default). (URL-level errors surface in the paths below.)
  const from = input instanceof Request ? input : null;
  try {
    validateRequestInit(init);
    const effMode   = init.mode  || (from && from.mode)  || 'cors';
    const effMethod = init.method != null ? normalizeMethod(String(init.method)) : (from ? from.method : 'GET');
    const effCache  = init.cache || (from && from.cache) || 'default';
    validateRequestCombination(effMode, effMethod, effCache);
  } catch (e) { return Promise.reject(e); }
  // Request construction (URL parse) also takes priority over the signal: an unparseable
  // URL or one carrying credentials rejects with TypeError before the abort check
  // (abort/general "constructor takes priority - Input URL …"). data:/blob: skip this — a
  // data: URL is validated by its own processor and parsing a huge one is costly. Only an
  // ABSOLUTE input (has a scheme) is validated here — a relative URL is left for the rack
  // path to resolve against the document base (so a relative fetch from an opaque-base
  // frame isn't wrongly rejected), and the tests that need this priority use absolute URLs.
  if (typeof input === 'string' && /^[a-z][a-z0-9+.-]*:/i.test(input) &&
      !input.startsWith('data:') && !input.startsWith('blob:')) {
    let parsedInput;
    try { parsedInput = new globalThis.URL(input); }
    catch (_) { return Promise.reject(new TypeError('Failed to execute fetch: invalid URL ' + input)); }
    if (parsedInput.username !== '' || parsedInput.password !== '') {
      return Promise.reject(new TypeError('Failed to execute fetch: URL cannot contain credentials'));
    }
  }
  // Abort: fetch observes the request's signal (init.signal, else an input Request's signal;
  // an explicit null init.signal removes it). An already-aborted signal rejects
  // SYNCHRONOUSLY with the signal's reason — before the fetch task and any pending microtask
  // — and makes no request (abort/general "already aborted signal rejects immediately"); an
  // abort that happens while the fetch task is queued is caught when that task runs.
  const signal = init.signal !== undefined ? init.signal : (from ? from.signal : null);
  if (signal && signal.aborted) {
    // A body-bearing request is still "used" even when aborted — but only when its own body
    // is consumed (no init.body override replacing it, matching the clone rule elsewhere).
    if (from && from._body != null && init.body == null) from._bodyUsed = true;
    return Promise.reject(signal.reason);
  }
  return globalThis.__csimFetch(input, init, signal);
};

// The fetch implementation WITHOUT the public init validation. The driver's form-submission
// navigation calls this directly with `mode: 'navigate'` — a mode the public Request/fetch
// API forbids (request-error), but the internal navigation model uses to signal "not a CORS
// fetch". Apps always reach fetch through the validated wrapper above.
globalThis.__csimFetch = function (input, init, signal) {
  init = init || {};
  let url, method = 'GET', body = null;
  if (typeof input === 'string') {
    url = input;
  } else if (input && input.url) {
    url = input.url;
    if (input.method) method = input.method;
    // A genuine Request exposes the RAW body init as `_body` (its `.body` is now a stream
    // getter); a duck-typed request-like object ({url, method, body}) only has `.body`.
    if (input._body !== undefined) body = input._body;
    else if (input.body != null)   body = input.body;
  } else {
    url = String(input);
  }
  if (init.method)       method = init.method;
  if (init.body != null) body   = init.body;
  // Build the request's header list through a GUARDED Headers: it validates names/
  // values (an invalid one → reject, since fetch() never throws synchronously),
  // normalizes, and drops forbidden / non-no-cors-safelisted headers BEFORE the wire
  // (request-forbidden-headers / headers-no-cors). init.headers, when present,
  // replaces the input request's headers (Fetch "Request" init). Then flatten to the
  // plain map __rackFetch wants.
  const mode  = init.mode || (input instanceof Request ? input.mode : null) || 'cors';
  const guard = guardForMode(mode);
  // credentials mode (passed to Ruby verbatim) decides cookie attachment + the
  // credentialed CORS check: `include` sends cookies everywhere and forces the strict
  // check (ACAO must echo the origin, not `*`, plus ACAC:true); `same-origin` (default)
  // sends cookies only same-origin; `omit` never does.
  const credentials = init.credentials || (input instanceof Request ? input.credentials : null) || 'same-origin';
  // redirect mode: 'follow' (default) follows 3xx; 'error' rejects on any redirect;
  // 'manual' returns an opaque-redirect response without following (redirect-mode).
  const redirect = init.redirect || (input instanceof Request ? input.redirect : null) || 'follow';
  const referrerPolicy = init.referrerPolicy || (input instanceof Request ? input.referrerPolicy : '') || '';
  // The request's referrer, resolved to what Ruby uses as the referrer source (before the
  // policy is applied). 'about:client' (the default) → undefined so Ruby uses the document
  // URL; '' → '' meaning no-referrer; any other value → resolved against the document base
  // URL. compute_referrer then applies referrerPolicy to this source (cors-preflight-referrer).
  const rawReferrer = init.referrer != null ? init.referrer
                    : (input instanceof Request ? input.referrer : 'about:client');
  let referrer;
  if (rawReferrer === '') referrer = '';
  else if (rawReferrer === 'about:client') referrer = undefined;
  else { try { referrer = new URL(rawReferrer, globalThis.location.href).href; } catch (_) { referrer = undefined; } }
  const src   = init.headers != null ? init.headers
              : (input && typeof input === 'object' && input.headers) || undefined;
  const headers = {};
  try {
    new globalThis.Headers(src, guard).forEach((v, k) => { headers[k] = v; });
  } catch (e) { return Promise.reject(e); }
  if (typeof url === 'string' && url.startsWith('blob:')) {
    // A blob: URL only answers GET; any other method is a network error.
    const blobMethod = String(method || 'GET').toUpperCase();
    // Snapshot the bytes SYNCHRONOUSLY (before the deferred resolve), so a
    // `URL.revokeObjectURL(url)` issued right after this fetch() call still sees
    // the resource — fetch took its reference when it was called. A Request input
    // carries its own construction-time snapshot (revoke may predate the fetch).
    const snapshot = blobMethod !== 'GET'
      ? null
      : ((input instanceof Request && input._blobSnapshot) ? input._blobSnapshot : resolveBlobBytes(url));
    return new Promise(function (resolve, reject) {
      // Defer through the virtual clock to match the spec's fetch
      // task boundary — fetch resolves on a separate task, so awaiting
      // it yields control. Inline resolve would race ahead of any
      // intervening microtasks (Turbo Drive's render chain).
      globalThis.setTimeout(function () {
        if (signal && signal.aborted) { reject(signal.reason); return; }
        if (!snapshot) return reject(new TypeError('blob URL fetch failed: ' + url));
        resolve(new Response({
          status:  200,
          body:    snapshot.bytes,
          headers: { 'content-type': snapshot.type },
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
      globalThis.setTimeout(function () {
        if (signal && signal.aborted) { reject(signal.reason); return; }
        const parsed = processDataUrl(url);
        if (!parsed) { reject(new TypeError('Invalid data: URL: ' + url)); return; }
        resolve(new Response({
          status:  200,
          body:    latin1ToBytes(parsed.body),
          headers: { 'content-type': parsed.mimeType },
          url
        }, url, signal));
      }, 0);
    });
  }
  // The deferred rack call: queue the synchronous __rackFetch on a fetch task, carrying the
  // already-serialized body. Kept synchronous for every non-stream body so the fetch task is
  // registered in the same turn as the fetch() call (its ordering vs a synchronously-scheduled
  // timer is observable under the deterministic clock).
  const runRack = function (bodyStr, b64) {
    if (b64) headers['X-Csim-Body-B64'] = '1';
    return new Promise(function (resolve, reject) {
      globalThis.setTimeout(function () {
        if (signal && signal.aborted) { reject(signal.reason); return; }
        try {
          const resp = globalThis.__rackFetch(normalizeMethod(method), url, bodyStr, headers, redirect, mode, credentials, referrerPolicy, referrer);
          if (!resp) { reject(new TypeError('Network request failed: ' + url)); return; }
          resolve(new Response(resp, url, signal));
        } catch (e) { reject(e); }
      }, 0);
    });
  };
  // Serialize the request body for the wire. A Request input reuses its already-captured bytes
  // (re-serializing a FormData would mint a new multipart boundary mismatching the copied
  // Content-Type). A ReadableStream body is the ONLY async case: it is drained to bytes first
  // (buffered upload), so only that path defers the rack call by a microtask.
  const reusedRequestBody = input instanceof Request && init.body == null;
  // A request whose body is already disturbed / used cannot be sent again (Fetch — fetching an
  // unusable request rejects with a TypeError).
  if (reusedRequestBody && bodyUsedOf(input)) {
    return Promise.reject(new TypeError('Failed to fetch: Request body is already used'));
  }
  const reqStream = reusedRequestBody
    ? (input._bodyIsStream ? input._bodyStream : null)
    : (body != null && globalThis.ReadableStream && body instanceof globalThis.ReadableStream ? body : null);
  if (reqStream) {
    // getReader() (inside collectBodyStream) throws synchronously on a locked/disturbed stream;
    // surface it as a rejection so fetch() never throws synchronously.
    if (reqStream.locked || reqStream._disturbed) {
      return Promise.reject(new TypeError('Failed to fetch: Request body stream is disturbed or locked'));
    }
    return collectBodyStream(reqStream, true).then(bytes => runRack(globalThis.btoa(bytes), true));
  }
  if (reusedRequestBody) return runRack(globalThis.btoa(input._bodyBytes || ''), true);
  const s = serializeRequestBody(body, headers);
  return runRack(s.body, s.b64);
};

globalThis.Request  = Request;
globalThis.Response = Response;
