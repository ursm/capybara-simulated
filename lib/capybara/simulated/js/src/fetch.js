// `window.fetch(url, opts)` over the synchronous Rack call.
// `blob:` URLs resolve out of the in-process blob registry without
// going through the Rack stack.

import { bytesToArrayBuffer, bytesToLatin1, latin1ToBytes, utf8DecodeBytes, utf8EncodeBytes } from './bytes.js';
import { resolveBlobBytes }     from './blob.js';
import { processDataUrl }       from './data-url.js';
import { serializeRequestBody, findHeaderKey } from './request-body.js';
import { FORBIDDEN_METHODS } from './header-rules.js';

// The header guard a request's Headers carries for a given fetch mode (so forbidden /
// non-no-cors-safelisted headers are dropped). Shared by Request and fetch().
function guardForMode(mode) { return mode === 'no-cors' ? 'request-no-cors' : 'request'; }

// Fetch "normalize a method": byte-uppercase only a case-insensitive match for one of
// these; every other method (notably `patch`, `chicken`) keeps its original case. So
// `delete` → `DELETE` but `patch` stays `patch` — which matters for the case-sensitive
// CORS Allow-Methods check (cors-preflight-star).
const METHOD_NORMALIZE = new Set(['DELETE', 'GET', 'HEAD', 'OPTIONS', 'POST', 'PUT']);
// Fetch "redirect status" — the only codes Response.redirect() accepts.
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
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
const REQUEST_PRIORITY_ENUM    = ['high', 'low', 'auto'];
const REFERRER_POLICY_ENUM     = ['', 'no-referrer', 'no-referrer-when-downgrade', 'same-origin',
  'origin', 'strict-origin', 'origin-when-cross-origin', 'strict-origin-when-cross-origin', 'unsafe-url'];
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
  validateEnum(init.priority,       REQUEST_PRIORITY_ENUM,    'priority');
  if (init.mode === 'navigate') throw new TypeError("Failed to construct 'Request': cannot construct a Request with mode 'navigate'");
  if (init.method != null) {
    const m = String(init.method);
    if (!METHOD_TOKEN.test(m) || FORBIDDEN_METHODS.has(m.toUpperCase())) {
      throw new TypeError("Failed to construct 'Request': '" + m + "' is not a valid or allowed method");
    }
  }
  if (init.referrer != null && init.referrer !== '' && init.referrer !== 'about:client') {
    try { new globalThis.URL(String(init.referrer), globalThis.location && globalThis.location.href); }
    catch (_) { throw new TypeError("Failed to construct 'Request': Referrer '" + init.referrer + "' is invalid"); }
  }
}

// Fetch's Request-constructor referrer processing: `''` → no-referrer (''); parse any
// other value against the base URL; a referrer that is `about:client` OR cross-origin
// to the environment collapses to `about:client` (don't leak a cross-origin referrer);
// a same-origin URL is stored as its serialized href.
function processRequestReferrer(ref) {
  if (ref === '' || ref === 'about:client') return ref === '' ? '' : 'about:client';
  let p;
  try { p = new globalThis.URL(ref, globalThis.location && globalThis.location.href); }
  catch (_) { return 'about:client'; }
  const origin = globalThis.location && globalThis.location.origin;
  if ((p.protocol === 'about:' && p.pathname === 'client') || (origin && origin !== 'null' && p.origin !== origin)) {
    return 'about:client';
  }
  return p.href;
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
  const result = parseMultipartFormData(byteStr, '--' + m[2], fd);
  // A malformed body (a boundary not followed by "--" or CRLF, a part with no
  // Content-Disposition name, trailing bytes after the close delimiter, …) is a parse error —
  // formData() rejects (response-form-data "Validate buggy form data").
  return result ? Promise.resolve(fd) : Promise.reject(new TypeError('Failed to parse multipart form data.'));
}
// The WHATWG "multipart/form-data" parser. `dash` is "--" + boundary. Fills `fd` and returns
// true on success, false on a parse error. Transport padding (SP/HTAB) is allowed after a
// boundary and after the close delimiter; the epilogue after the close is ignored.
function parseMultipartFormData(s, dash, fd) {
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
      fd.append(name[1], new globalThis.File([latin1ToBytes(value)], file[1], { type: fct ? fct[1].trim() : '' }));
    } else {
      // A multipart field value keeps a leading BOM (unlike a whole-body text() decode) —
      // response-consume "…with BOM".
      fd.append(name[1], utf8DecodeKeepBom(value));
    }
  }
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
// rejection (response-error-from-stream). A non-BufferSource chunk — a string / number /
// null — is a TypeError for BOTH a REQUEST body drained to the wire (request-upload.h2) and a
// RESPONSE body read (response-stream-bad-chunk "non-Uint8Array chunk … causes TypeError").
// On success the reader lock is DELIBERATELY kept: a fully-consumed body's stream stays locked,
// so a later `.body.getReader()` throws (response-stream-disturbed-5). The lock is released
// only on error.
function collectBodyStream(stream) {
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
// Mark a body-bearing object as consumed: set the fast-path used flag AND lock an already-
// exposed stream, so `bodyUsed` and read-usability stay in sync (a later read / construct
// from it then rejects). Used when a source Request's body is transferred at construction.
function markBodyConsumed(o) {
  o._bodyUsed = true;
  const s = o._bodyStream;
  if (s && !s.locked && s._disturbed !== true) { try { s.getReader(); } catch (_) { /* already locked */ } }
}
// A ReadableStream used as a Request/Response body must be neither disturbed nor locked
// (Fetch "extract a body"): a construction TypeError naming `iface` otherwise.
function assertStreamUsable(stream, iface) {
  if (stream.locked || stream._disturbed) {
    throw new TypeError("Failed to construct '" + iface + "': The provided ReadableStream is disturbed or locked");
  }
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
    if (this._bodyStream) return collectBodyStream(this._bodyStream).then(fn);
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
// clone() reuses the constructor but must NOT disturb the source (it yields two independently
// usable requests), unlike `new Request(sourceRequest)` which transfers the source's body.
const REQUEST_CLONE = Symbol('request-clone');

class Request {
  constructor(input, init, _internal) {
    init = init || {};
    const isClone = _internal === REQUEST_CLONE;
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
      // Parse the input against the current settings object's API base URL: the realm's
      // document base URI (which honours `<base href>`), falling back to its location — NOT
      // a fixed top-level URL, so `new otherRealm.Request("rel")` resolves against
      // otherRealm's base (request/multi-globals url-parsing). An unparseable URL, or one
      // carrying credentials (`user:pass@`), is a TypeError (request-error).
      let parsed;
      const base = (globalThis.document && globalThis.document.baseURI) || (globalThis.location && globalThis.location.href);
      try { parsed = new globalThis.URL(String(input), base); }
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
    // Referrer processing (Fetch "Request" constructor): `''` is the no-referrer intent
    // (kept as ''); any other value parses against the base URL, and a referrer that is
    // `about:client` OR cross-origin to the environment collapses to `about:client` (a
    // page must not leak a cross-origin referrer). A same-origin URL is stored resolved.
    // Init omitted → inherit the source Request's already-processed referrer.
    if (init.referrer != null) {
      this._referrer = processRequestReferrer(String(init.referrer));
    } else {
      this._referrer = from ? from._referrer : 'about:client';
    }
    this._referrerPolicy = init.referrerPolicy || (from && from.referrerPolicy) || '';
    // A navigation request's destination / reload / history flags are carried from the source
    // (clone / `new Request(navReq)`) so a SW handler that clones `event.request` before
    // caches.match / fetch keeps `.destination === 'document'` and the navigation-type flags.
    if (from) {
      this._destination         = from._destination;
      this._isReloadNavigation  = from._isReloadNavigation;
      this._isHistoryNavigation = from._isHistoryNavigation;
    }
    // integrity is inherited from the source Request when the init omits it (so a clone
    // keeps it), else the init value, else ''.
    this._integrity   = init.integrity != null ? String(init.integrity) : (from ? from._integrity : '') || '';
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
      // A GENUINE stream body can't be copied as bytes, so tee it: the source keeps one
      // branch, this request reads the other (a genuine stream body drains at send time).
      // A byte body needs no tee — this request lazily mints its own stream from the copied
      // bytes, leaving the source's `.body` stream identity intact (request-disturbed).
      if (input._bodyIsStream && input._bodyStream) {
        const [a, b] = input._bodyStream.tee();
        input._bodyStream = a;
        this._bodyStream  = b;
        this._bodyIsStream = true;
      }
    } else if (initBodyIsStream) {
      // A ReadableStream body is held as the request's body stream (its bytes are read from
      // the stream at consume/send time). It must be neither disturbed nor locked, and it is
      // held by identity — `request.body === body` (request-init-stream).
      assertStreamUsable(this._body, 'Request');
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
    // Constructing a Request from a source Request that carries a (byte) body TRANSFERS that
    // body: the source becomes disturbed (bodyUsed → true) once construction has fully
    // succeeded — whether or not init.body replaced it (request-disturbed). This runs last, so
    // a construction that threw above (GET/HEAD-with-body, forbidden method, …) leaves the
    // source untouched. clone() opts out (it yields two usable copies); a genuine stream body
    // is already transferred by the tee above.
    if (from && !isClone && !from._bodyNull && !from._bodyIsStream && !bodyUsedOf(from)) markBodyConsumed(from);
  }
  // Every Request member is a read-only WebIDL attribute — expose getters over the private
  // backing fields so an author write is silently ignored (request-structure). `destination`,
  // `isReloadNavigation`, `isHistoryNavigation`, and `duplex` are constants for a
  // constructor-built request (no navigation / reload / duplex-stream body modelled).
  get method()              { return this._method; }
  get url()                 { return this._url; }
  get headers()             { return this._headers; }
  // destination / isReloadNavigation / isHistoryNavigation are constants for a script-built
  // request (''/false), but a NAVIGATION request the service-worker fetch path constructs
  // internally sets the backing fields (a public Request can't carry mode 'navigate').
  get destination()         { return this._destination || ''; }
  get referrer()            { return this._referrer; }
  get referrerPolicy()      { return this._referrerPolicy; }
  get mode()                { return this._mode; }
  get credentials()         { return this._credentials; }
  get cache()               { return this._cache; }
  get redirect()            { return this._redirect; }
  get integrity()           { return this._integrity; }
  get isReloadNavigation()  { return this._isReloadNavigation || false; }
  get isHistoryNavigation() { return this._isHistoryNavigation || false; }
  get duplex()              { return 'half'; }
  get signal()              { return this._signalRef; }
  get bodyUsed()            { return bodyUsedOf(this); }
  get body()                { return bodyStreamOf(this); }
  _bodyBytesRaw()    { return this._bodyBytes || ''; }
  _bodyContentType() { return this._headers.get('content-type') || ''; }
  clone()            { return new Request(this, undefined, REQUEST_CLONE); }
  get [Symbol.toStringTag]() { return 'Request'; }
}
Object.assign(Request.prototype, BodyMixin);

// `body` carries the UTF-8 text form (legacy; fine for
// text/json/css/js). `body_b64` carries the raw bytes
// base64-encoded — Ruby always sends both. `arrayBuffer()` /
// `blob()` decode b64 to a latin-1 byte string so binary
// payloads (Tesseract.js's gzipped traineddata, image bytes)
// survive intact. Synthetic responses (blob:-URL handlers) pass
// only `body` — we fall back to `String(body)` there.
// A response URL with its fragment removed (Fetch serializes a response's URL with
// the exclude-fragment flag). Parsing also normalizes the URL (`host:8000#x` →
// `host:8000/`); an unparseable / synthetic URL falls back to a plain `#`-truncation.
function responseUrlNoFragment(u) {
  if (!u) return u;
  try { const p = new URL(u); p.hash = ''; return p.href; }
  catch (_) { const i = u.indexOf('#'); return i < 0 ? u : u.slice(0, i); }
}

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
    // A fetched response's header list is immutable: a script append/set/delete throws
    // (response-headers-guard). The public `new Response()` ctor overrides this to the
    // mutable 'response' guard after super().
    this.headers._guard = 'immutable';
    // An opaque (no-cors cross-origin) response has an empty URL list — don't fall back
    // to the request URL. Otherwise use the response URL, else the request URL, with the
    // fragment excluded (Fetch: a response URL is the request's URL sans fragment; the
    // parse also normalizes e.g. `host:8000#x` → `host:8000/`).
    this.url        = (raw && raw.type === 'opaque') ? '' : responseUrlNoFragment((raw && raw.url) || url);
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
    // Preserve the source's header guard: cloning via the internal `_raw` form always yields
    // an 'immutable' guard, but "clone a response" copies the source's guard, so a clone of a
    // script-created (mutable 'response') Response must stay mutable (response-clone).
    c.headers._guard = this.headers._guard;
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
  get [Symbol.toStringTag]() { return 'Response'; }
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
    // A ReadableStream body must be neither disturbed nor locked (response-from-stream) — the
    // same rule the Request constructor enforces.
    if (isStream) assertStreamUsable(bodyOrRaw, 'Response');
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
    // "Serialize a JavaScript value to JSON bytes" throws a TypeError when the value isn't
    // encodable — a bare Symbol / function stringifies to `undefined` (response-static-json).
    // (A BigInt makes JSON.stringify itself throw, which propagates.)
    const body = JSON.stringify(data);
    if (body === undefined) {
      throw new TypeError("Failed to execute 'json' on 'Response': The data is not JSON-serializable");
    }
    // Build through Headers (handles a Headers / array / record init — Object.assign of
    // a Headers would copy its internal fields, not its entries); default content-type
    // only when the author set none.
    const headers = new globalThis.Headers(init.headers);
    if (!headers.has('content-type')) headers.set('content-type', 'application/json');
    return new Response(body, Object.assign({}, init, {headers}));
  }
  // A network-error response has status 0 — built through the internal form so it bypasses
  // the public [200,599] status check (which would reject 0). The internal form's header list
  // is already immutable (FetchResponse ctor), which is what static-error requires.
  static error()             { const r = new Response({status: 0, body: '', headers: {}, url: '', body_null: true}, ''); r.type = 'error'; return r; }
  static redirect(url, status) {
    // Parse the URL against the document base — an unparseable one is a TypeError
    // (response-static-redirect). The status defaults to 302 and MUST be a redirect status
    // (301/302/303/307/308), else a RangeError.
    const parsed = new globalThis.URL(String(url), globalThis.location && globalThis.location.href);
    status = status === undefined ? 302 : Number(status);
    if (!REDIRECT_STATUSES.has(status)) {
      throw new RangeError("Failed to execute 'redirect' on 'Response': Invalid status code");
    }
    // A redirect response has a NULL body (Fetch "Response.redirect") — response.body is null —
    // and, like Response.error, its header list is immutable (created with the immutable guard;
    // the Location was appended before we lock it).
    const r = new Response(null, {status, headers: {location: parsed.href}});
    r.headers._guard = 'immutable';
    return r;
  }
}

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
    computed = sriNormalizeB64(globalThis.btoa(String.fromCharCode.apply(null, digest)));
  } catch (_) { return false; }
  return enforced.some(e => sriNormalizeB64(e.hash) === computed);
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
    // Constructing the internal Request with a GET/HEAD method and a body is a
    // TypeError (Fetch "Request" init) → the fetch promise rejects.
    if ((effMethod === 'GET' || effMethod === 'HEAD') && init.body != null) {
      throw new TypeError("Failed to execute 'fetch': Request with GET/HEAD method cannot have body.");
    }
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
    // A ReadableStream request body is CANCELLED with the abort reason, synchronously (Fetch
    // "abort a fetch" cancels the request body stream — abort/general "Readable stream
    // synchronously cancels …"). The clone rule applies: only the request's own stream body,
    // not one replaced by init.body.
    const bodyStream = init.body != null
      ? (globalThis.ReadableStream && init.body instanceof globalThis.ReadableStream ? init.body : null)
      : (from && from._bodyIsStream ? from._bodyStream : null);
    if (bodyStream && !bodyStream.locked) { try { const p = bodyStream.cancel(signal.reason); if (p && p.catch) p.catch(() => {}); } catch (_) {} }
    return Promise.reject(signal.reason);
  }
  // Performing the fetch consumes the request's body (Fetch reads it to the wire), so a
  // later `request.text()` etc. rejects with "already consumed" — even for a byte body that
  // never exposed a stream (abort/request "aborted consumed nonempty request"). Only the
  // request's OWN non-null body (an init.body override replaces it, matching the abort/clone
  // rules above); a null/empty-stream body isn't disturbed.
  if (from && from._body != null && init.body == null) from._bodyUsed = true;
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
  // cache mode (passed to Ruby verbatim): drives the HTTP cache — default / no-store / reload /
  // no-cache / force-cache / only-if-cached (request-cache).
  const cache = init.cache || (input instanceof Request ? input.cache : null) || 'default';
  const referrerPolicy = init.referrerPolicy || (input instanceof Request ? input.referrerPolicy : '') || '';
  // Subresource-integrity metadata for the response body (validated at resolve).
  const integrityMeta = (init.integrity != null ? String(init.integrity) : (input instanceof Request ? input._integrity : '')) || '';
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
  let hdrs;
  try {
    hdrs = new globalThis.Headers(src, guard);
  } catch (e) { return Promise.reject(e); }
  // Send the header names in their on-the-wire casing (the author's first-seen case),
  // not the lowercased JS view — a server / echo handler sees the names verbatim
  // (request-headers-case). Names still combine case-insensitively, so two spellings of
  // one name land as a single first-cased entry with the combined value.
  for (const [name, value] of hdrs._wireEntries()) headers[name] = value;
  // Fetch's default request headers: `Accept: */*` (NOT a document navigation's richer
  // Accept, which rack_fetch would otherwise fill in) and an `Accept-Language`, only
  // when the caller set neither. The presence check is case-insensitive via `has`.
  // (Mirrors the XHR defaults in xhr.js.)
  if (!hdrs.has('accept')) headers['accept'] = '*/*';
  if (!hdrs.has('accept-language')) headers['accept-language'] = 'en-US,en;q=0.9';
  // NOTE: the fetch `Origin` request header (non-GET/HEAD) is deliberately NOT added
  // here — doing so changes how rack_fetch's CORS logic evaluates cross-origin
  // requests and regresses the fetch/api/cors cluster. It belongs with a holistic
  // CORS pass (aligning the Origin header with preflight/response-tainting), tracked
  // as backlog, not this narrow header change.
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
        // A blob's Content-Type is its type when it parses as a MIME, else empty — an
        // unparseable one ("invalid") yields "" (scheme-blob "invalid_type_blob"). The original
        // string is kept verbatim when valid (do NOT re-serialize — that would drop the space in
        // "multipart/form-data; boundary=…", response-consume "from FormData to blob").
        const vendor = globalThis.__csimVendor && globalThis.__csimVendor.mimeType;
        let ctype = snapshot.type || '';
        if (ctype && vendor) {
          let ok = false;
          try { ok = !!vendor.MIMEType.parse(ctype); } catch (_) { ok = false; }
          if (!ok) ctype = '';
        }
        resolve(new Response({
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
      globalThis.setTimeout(function () {
        if (signal && signal.aborted) { reject(signal.reason); return; }
        const parsed = processDataUrl(url);
        if (!parsed) { reject(new TypeError('Invalid data: URL: ' + url)); return; }
        // A HEAD request carries no body (status + headers only).
        const isHead = String(method || 'GET').toUpperCase() === 'HEAD';
        resolve(new Response({
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
  const runRack = function (bodyStr, b64) {
    return new Promise(function (resolve, reject) {
      globalThis.setTimeout(function () {
        if (signal && signal.aborted) { reject(signal.reason); return; }
        const finish = function (resp) {
          if (!resp) { reject(new TypeError('Network request failed: ' + url)); return; }
          try {
            const r = new Response(resp, url, signal);
            // Subresource integrity: reject a body that doesn't match its metadata.
            // An opaque (no-cors) response has no readable body to validate, so
            // non-empty integrity on it is a network error (blocked) per the spec.
            if (integrityMeta && (r.type === 'opaque' || !sriValidate(r._bodyBytesRaw(), integrityMeta))) {
              reject(new TypeError('Failed to fetch: integrity check failed for ' + url));
              return;
            }
            resolve(r);
          } catch (e) { reject(e); }
        };
        const doNetwork = function () {
          // The b64 marker is wire-private (it tells the Rack side to base64-decode the body):
          // set it only for the network hop, so a controlling SW never sees it in the
          // intercepted request's headers.
          if (b64) headers['X-Csim-Body-B64'] = '1';
          try { finish(globalThis.__rackFetch(normalizeMethod(method), url, bodyStr, headers, redirect, mode, credentials, referrerPolicy, referrer, cache)); }
          catch (e) { reject(e); }
        };
        // Service Worker interception: a controlled client's request goes to the controlling SW's
        // `fetch` handler first. `respondWith` supplies the response; a fall-through (no handler /
        // no respondWith) or a gone SW drops to the network. A navigate/no-cors nuance and
        // subresource/navigation interception beyond fetch() are later work.
        const ctrl = globalThis.__csimSWControllerHandle && globalThis.__csimSWControllerHandle();
        if (ctrl) {
          globalThis.__csimSWInterceptFetch(ctrl, normalizeMethod(method), url, headers, bodyStr, b64, function (swResp) {
            if (swResp == null) { doNetwork(); return; }
            if (swResp.__networkError) { reject(new TypeError('Failed to fetch: ' + url)); return; }
            finish(swResp);
          });
          return;
        }
        doNetwork();
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
    return collectBodyStream(reqStream).then(bytes => runRack(globalThis.btoa(bytes), true));
  }
  if (reusedRequestBody) return runRack(globalThis.btoa(input._bodyBytes || ''), true);
  const s = serializeRequestBody(body, headers);
  return runRack(s.body, s.b64);
};

globalThis.Request  = Request;
globalThis.Response = Response;
