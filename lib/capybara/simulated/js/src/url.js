// URL / URLSearchParams (URL Standard), generated from their IDL — and Headers, the value type `fetch` / `Request` /
// `Response` consume. A URL is the URL Standard's, native (url_ops.rs, the same parser as `__csim_parseUrl`): its parts
// as the parser hands them back are its internal slots', which its attributes read and a setter replaces, the
// interface's own setter steps run on the URL natively. A URLSearchParams is its list of name-value pairs, and — where it
// is a URL's `searchParams` — that URL, whose query its every change writes back and a change of which it reads again.
import { FORBIDDEN_RESPONSE_HEADERS, isForbiddenRequestHeader } from './header-rules.js';
import { createObjectURL, revokeObjectURL } from './blob.js';
import { convertURLArguments, convertURLSearchParamsArguments, installURL, installURLSearchParams } from './generated/bindings.js';
import { makeSlots, registerInterface, slotsOf } from './webidl.js';

// A URL's parts, as url_ops.rs `parts` orders them.
const HREF = 0, PROTOCOL = 1, USERNAME = 2, PASSWORD = 3, HOST = 4, HOSTNAME = 5, PORT = 6, PATHNAME = 7, SEARCH = 8,
      HASH = 9, ORIGIN = 10;

// application/x-www-form-urlencoded byte serializer for one name or value.
function formEncode(s) {
  return encodeURIComponent(s)
    .replace(/%20/g, '+')
    .replace(/[!'()~]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}
// application/x-www-form-urlencoded decode for one name or value, per the WHATWG parser: `+`→space, valid `%XX`→byte,
// every other char→its UTF-8 bytes, then UTF-8-decode the bytes (invalid sequences → U+FFFD). Unlike
// decodeURIComponent it NEVER throws — a stray `%` (`?a=%zz`) or a lone high byte (`%FF`) stays literal / becomes
// U+FFFD, matching real browsers instead of a URIError.
const HEX = /[0-9A-Fa-f]/;
function formDecode(s) {
  const bytes = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '+') {
      bytes.push(0x20);
    } else if (c === '%' && HEX.test(s[i + 1] || '') && HEX.test(s[i + 2] || '')) {
      bytes.push(parseInt(s[i + 1] + s[i + 2], 16));
      i += 2;
    } else {
      let cp = s.codePointAt(i);
      if (cp > 0xFFFF) i++;                       // surrogate pair: skip the low unit
      if (cp < 0x80) bytes.push(cp);
      else if (cp < 0x800) bytes.push(0xC0 | (cp >> 6), 0x80 | (cp & 0x3F));
      else if (cp < 0x10000) bytes.push(0xE0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F));
      else bytes.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3F), 0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F));
    }
  }
  // "UTF-8 decode without BOM" (the form-urlencoded byte-decoder): a leading U+FEFF is data, not a byte-order mark, so
  // `ignoreBOM` keeps it (the default TextDecoder would strip it, dropping a leading BOM from a name or value).
  return new globalThis.TextDecoder('utf-8', { ignoreBOM: true }).decode(new Uint8Array(bytes));
}
// The application/x-www-form-urlencoded parser: a query (past any leading `?`) as name-value pairs.
function parseQuery(query) {
  const list = [];
  for (const pair of query.split('&')) {
    if (pair === '') continue;
    const at = pair.indexOf('=');
    list.push(at < 0 ? [formDecode(pair), ''] : [formDecode(pair.slice(0, at)), formDecode(pair.slice(at + 1))]);
  }
  return list;
}
const serialize = (list) => list.map(([name, value]) => formEncode(name) + '=' + formEncode(value)).join('&');

// ── URL ──
const urlOf = (o) => slotsOf(o, 'URL');
registerInterface('URL', (o) => urlOf(o) !== undefined);
// (…the URL's parts, or null where `url` against `base` is no URL)
const parse = (url, base) => globalThis.__dom.urlParse(url, base === undefined ? null : base, null);
export class URL {
  constructor(url, base) {
    [url, base] = convertURLArguments(arguments);
    const parts = parse(url, base);
    if (parts === null) throw new TypeError(`Failed to construct 'URL': Invalid URL`);
    const s = makeSlots(this, 'URL', { parts, params: null });
    s.params = paramsOf(this, parts[SEARCH].slice(1));
  }
}
// Set `part` as the interface's setter does (url_ops.rs `urlSet`): false where it does not take the value (an href
// that does not parse). Its query moving updates its params — unless it is the params writing it back ('query').
function setPart(url, part, value) {
  const s = urlOf(url);
  const parts = globalThis.__dom.urlSet(s.parts[HREF], part, value);
  if (parts === null) return false;
  const search = s.parts[SEARCH];
  s.parts = parts;
  if (part !== 'query' && parts[SEARCH] !== search) paramsSlots(s.params).list = parseQuery(parts[SEARCH].slice(1));
  return true;
}
const url = {
  get_href: (u) => urlOf(u).parts[HREF],
  set_href(u, v) { if (!setPart(u, 'href', v)) throw new TypeError(`Failed to set the 'href' property on 'URL': Invalid URL`); },
  get_origin: (u) => urlOf(u).parts[ORIGIN],
  get_searchParams: (u) => urlOf(u).params,
  toJSON: (u) => urlOf(u).parts[HREF],
  // (…a URL a string makes against a base, or none: Chromium 120+'s, which WHATWG fetch polyfills probe)
  canParse: (self, u, base) => parse(u, base) !== null,
  parse(self, u, base) {
    const parts = parse(u, base);
    if (parts === null) return null;
    const o = Object.create(URL.prototype);
    const s = makeSlots(o, 'URL', { parts, params: null });
    s.params = paramsOf(o, parts[SEARCH].slice(1));
    return o;
  },
  createObjectURL: (self, blob) => createObjectURL(blob),
  revokeObjectURL: (self, u) => revokeObjectURL(u)
};
for (const [name, index] of Object.entries({ protocol: PROTOCOL, username: USERNAME, password: PASSWORD, host: HOST, hostname: HOSTNAME,
                                              port: PORT, pathname: PATHNAME, search: SEARCH, hash: HASH })) {
  url[`get_${name}`] = (u) => urlOf(u).parts[index];
  url[`set_${name}`] = (u, v) => { setPart(u, name, v); };
}
installURL(URL, url);

// ── URLSearchParams ──
const paramsSlots = (o) => slotsOf(o, 'URLSearchParams');
registerInterface('URLSearchParams', (o) => paramsSlots(o) !== undefined);
// A URL's `searchParams`: its query's pairs, and the URL.
function paramsOf(u, query) {
  const o = Object.create(URLSearchParams.prototype);
  makeSlots(o, 'URLSearchParams', { list: parseQuery(query), url: u });
  return o;
}
export class URLSearchParams {
  constructor(init) {
    [init] = convertURLSearchParamsArguments(arguments);
    let list;
    if (init === undefined) {
      list = [];
    } else if (typeof init === 'string') {
      // (…a single leading `?` removed — a URL's own query is read verbatim, where `http://x/??a=b`'s first name is `?a`)
      list = parseQuery(init.startsWith('?') ? init.slice(1) : init);
    } else {
      // (…a sequence of pairs, or a record's: each pair of exactly two)
      list = init.map((pair) => {
        if (pair.length !== 2) throw new TypeError("Failed to construct 'URLSearchParams': Sequence initializer must only contain pair elements");
        return [pair[0], pair[1]];
      });
    }
    makeSlots(this, 'URLSearchParams', { list, url: null });
  }
}
// The URLSearchParams update steps: a URL's query the pairs serialized — none (no `?`) where that is empty.
function update(s) {
  if (s.url === null) return;
  const query = serialize(s.list);
  setPart(s.url, 'query', query === '' ? null : query);
}
installURLSearchParams(URLSearchParams, {
  get_size: (params) => paramsSlots(params).list.length,
  append(params, name, value) {
    const s = paramsSlots(params);
    s.list.push([name, value]);
    update(s);
  },
  // (…`value` given, only the pairs of both)
  delete(params, name, value) {
    const s = paramsSlots(params);
    s.list = s.list.filter(([n, v]) => n !== name || (value !== undefined && v !== value));
    update(s);
  },
  get(params, name) {
    const pair = paramsSlots(params).list.find(([n]) => n === name);
    return pair ? pair[1] : null;
  },
  getAll: (params, name) => paramsSlots(params).list.filter(([n]) => n === name).map(([, v]) => v),
  has: (params, name, value) => paramsSlots(params).list.some(([n, v]) => n === name && (value === undefined || v === value)),
  // (…the first pair of the name taking the value in its place, the others gone; none appended)
  set(params, name, value) {
    const s = paramsSlots(params);
    let found = false;
    s.list = s.list.filter((pair) => {
      if (pair[0] !== name) return true;
      if (found) return false;
      found = true;
      pair[1] = value;
      return true;
    });
    if (!found) s.list.push([name, value]);
    update(s);
  },
  // (…a stable sort by name, in code units)
  sort(params) {
    const s = paramsSlots(params);
    s.list.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    update(s);
  },
  stringify: (params) => serialize(paramsSlots(params).list),
  pairs: (params) => paramsSlots(params).list
});

// An HTTP header NAME is a non-empty token (RFC 7230 / Fetch). A NAME or VALUE
// is also a WebIDL ByteString — a code point > 0xFF (e.g. "Ā" U+0100) can't be a
// byte, so it's a TypeError before any further check.
const HTTP_TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
function toByteString(v) {
  const s = typeof v === 'string' ? v : String(v);
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 0xFF) throw new TypeError('Headers: value is not a valid ByteString.');
  }
  return s;
}
function validHeaderName(name) {
  const s = toByteString(name);
  if (!HTTP_TOKEN_RE.test(s)) throw new TypeError(`Headers: "${s}" is not a valid header name.`);
  return s.toLowerCase();
}
function validHeaderValue(value) {
  // Normalize: strip leading + trailing HTTP whitespace (tab, LF, CR, space). What
  // remains must contain no NUL / CR / LF (a mid-value newline is a smuggling vector).
  const s = toByteString(value).replace(/^[\t\n\r ]+|[\t\n\r ]+$/g, '');
  if (/[\0\r\n]/.test(s)) throw new TypeError('Headers: header value contains a forbidden byte.');
  return s;
}

// Fetch "CORS-unsafe request-header byte": controls (except tab) + a set of separators.
function hasCorsUnsafeByte(value) {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if ((c < 0x20 && c !== 0x09) || c === 0x22 || c === 0x28 || c === 0x29 || c === 0x3A ||
        c === 0x3C || c === 0x3E || c === 0x3F || c === 0x40 || c === 0x5B || c === 0x5C ||
        c === 0x5D || c === 0x7B || c === 0x7D || c === 0x7F) return true;
  }
  return false;
}
// Fetch "no-cors-safelisted request-header" (name, value): the only headers a
// `no-cors` request's Headers (guard "request-no-cors") accepts.
function isNoCorsSafelisted(name, value) {
  if (value.length > 128) return false;
  switch (name) {
    case 'accept': case 'accept-language': case 'content-language':
      return !hasCorsUnsafeByte(value);
    case 'content-type': {
      if (hasCorsUnsafeByte(value)) return false;
      const mime = value.split(';')[0].trim().toLowerCase();
      return mime === 'application/x-www-form-urlencoded' || mime === 'multipart/form-data' || mime === 'text/plain';
    }
    case 'range':
      // a "simple range header value": bytes=<start>-<end> with start optional only
      // for a suffix range (bytes=-N) and end optional (bytes=N-); not both empty.
      return /^bytes=(\d+-\d*|-\d+)$/.test(value);
    default:
      return false;
  }
}

export class Headers {
  // `guard` (internal 2nd arg) is set BEFORE the init fill so the guard filters the
  // init headers too (a Request's forbidden headers are dropped at construction). It
  // is one of 'none' (a standalone Headers — default), 'request', 'request-no-cors',
  // 'response', or 'immutable'.
  constructor(init, guard) {
    this._map   = new Map();
    // The header list's on-the-wire NAME casing: lowercased key → the FIRST-SEEN original
    // name for that key. The JS view (get / forEach / iterator) lowercases + sorts, but a
    // real UA sends the author's first-seen casing on the wire (request-headers-case), so
    // `_wireEntries()` reads this for the fetch send path. First-seen wins for both append
    // and set (Fetch "set" keeps the existing header's name when the name already exists).
    this._names = new Map();
    // `set-cookie` is NOT combined — the header list keeps each value separately, and the
    // iterator / getSetCookie() yield them individually (fetch "Headers" set-cookie special
    // case). Stored apart from the combined `_map`. (`set-cookie2` is a normal header.)
    this._setCookie = [];
    this._guard = guard || 'none';
    // Only an ABSENT argument yields empty headers; an explicit `null` / number /
    // other non-object is an invalid HeadersInit (TypeError). A Headers — like any
    // iterable — is consumed through its OWN `[Symbol.iterator]` (so a monkey-patched
    // iterator is honoured), NOT a privileged copy path.
    if (init === undefined) return;
    if (init === null || typeof init !== 'object') throw new TypeError('Headers: invalid init.');
    if (typeof init[Symbol.iterator] === 'function') {
      // A source Headers carries its own wire-case (first-seen original names). Seed it
      // BEFORE the append loop — the loop consumes `init` through its public iterator,
      // which lowercases names, so without this seed re-wrapping a Request's headers
      // (e.g. fetch() consuming `input.headers`) would send the lowercased spelling on
      // the wire. Seeding first lets the appends' first-seen guard keep the original.
      // Purely additive: the entries themselves still come from the iterator below, so a
      // monkey-patched iterator is honoured (`_wireEntries` only reads names for keys the
      // appends actually stored).
      if (init instanceof Headers) for (const [lk, nm] of init._names) this._names.set(lk, nm);
      // sequence<sequence<ByteString>>: each entry is a [name, value] pair.
      for (const e of init) {
        const pair = Array.isArray(e) ? e : Array.from(e);
        if (pair.length !== 2) throw new TypeError('Headers: each init entry must be a name/value pair.');
        this.append(pair[0], pair[1]);
      }
    } else {
      // record<ByteString, ByteString> — follow the WebIDL "convert to record" order exactly
      // (headers-record "Correct operation ordering"): own keys, then per ENUMERABLE key its
      // descriptor, then convert the KEY to a ByteString (throws before the value is read —
      // so an invalid name stops there), then Get the value, then convert IT to a ByteString.
      for (const k of Reflect.ownKeys(init)) {
        // The descriptor is fetched for EVERY own key — including Symbols (their [[GetOwnProperty]]
        // is observable, headers-record "non-enumerable Symbol keys") — but only enumerable keys
        // are converted. An enumerable Symbol key can't become a ByteString (ToString throws), so
        // it's a TypeError (headers-record "Basic operation with Symbol keys").
        const desc = Object.getOwnPropertyDescriptor(init, k);
        if (!desc || !desc.enumerable) continue;
        if (typeof k === 'symbol') throw new TypeError('Headers: a Symbol is not a valid header name.');
        const name  = toByteString(k);
        const value = toByteString(init[k]);
        this.append(name, value);
      }
    }
  }
  // Whether the guard forbids writing (name → prospectiveValue). 'immutable' throws;
  // 'request' drops forbidden request-headers; 'request-no-cors' drops anything not
  // no-cors-safelisted; 'response' drops forbidden response-headers; 'none' allows all.
  _guardForbids(name, prospectiveValue) {
    switch (this._guard) {
      case 'immutable':       throw new TypeError('Headers are immutable.');
      case 'request':         return isForbiddenRequestHeader(name, prospectiveValue);
      case 'request-no-cors': return !isNoCorsSafelisted(name, prospectiveValue);
      case 'response':        return FORBIDDEN_RESPONSE_HEADERS.has(name);
      default:                return false;
    }
  }
  // Remember the FIRST-SEEN wire name for a (lowercased) key. The single choke point
  // for `_names` upkeep — every path that writes `_map` calls this so wire-case can't
  // silently regress when a new mutation path is added.
  _recordName(key, name) { if (!this._names.has(key)) this._names.set(key, String(name)); }
  append(k, v) {
    const key  = validHeaderName(k);
    const val  = validHeaderValue(v);
    if (key === 'set-cookie') { if (this._guardForbids(key, val)) return; this._setCookie.push(val); return; }
    const prev = this._map.get(key);
    // The guard is checked against the value AS IT WOULD BE after appending (the
    // combined string) — a no-cors append that overflows 128 bytes is dropped.
    if (this._guardForbids(key, prev == null ? val : prev + ', ' + val)) return;
    this._map.set(key, prev == null ? val : prev + ', ' + val);
    this._recordName(key, k);
  }
  delete(k)    { const key = validHeaderName(k);
                 if (key === 'set-cookie') { if (this._guardForbids(key, this._setCookie[0] || '')) return; this._setCookie = []; return; }
                 if (this._guardForbids(key, this._map.get(key) || '')) return; this._map.delete(key); this._names.delete(key); }
  get(k)       { const key = validHeaderName(k);
                 if (key === 'set-cookie') return this._setCookie.length ? this._setCookie.join(', ') : null;
                 const v = this._map.get(key); return v == null ? null : v; }
  has(k)       { const key = validHeaderName(k); return key === 'set-cookie' ? this._setCookie.length > 0 : this._map.has(key); }
  set(k, v)    { const key = validHeaderName(k), val = validHeaderValue(v); if (this._guardForbids(key, val)) return;
                 if (key === 'set-cookie') { this._setCookie = [val]; return; }
                 this._map.set(key, val);
                 this._recordName(key, k); }
  // Populate from an already-final network header map (the fetch RESPONSE path):
  // lowercased names, values taken VERBATIM. NO script-side normalization: the value
  // is what the HTTP stack delivered, where per-field OWS was already stripped before
  // duplicates were combined with ", ". Re-running validHeaderValue's trim on the
  // COMBINED string would corrupt a value whose last segment is empty — two empty
  // `double-trouble` headers combine to ", ", which the trailing-space strip would
  // truncate to "," (header-value-combining). (A single received value padded with
  // OWS is left as-delivered; Rack is the wire here and doesn't re-strip it — a minor,
  // untested divergence.) Returns `this`.
  _fillRaw(obj) {
    if (obj) for (const k of Object.keys(obj)) {
      const key = String(k).toLowerCase();
      if (key === 'set-cookie') this._setCookie.push(String(obj[k]));
      else { this._map.set(key, String(obj[k])); this._recordName(key, k); }
    }
    return this;
  }
  // The header list as it goes ON THE WIRE: each entry paired with its first-seen
  // original-case name, in insertion order (NOT the lowercased+sorted JS view). The
  // fetch send path uses this so an echo handler sees the author's casing verbatim
  // (request-headers-case). set-cookie is never a request header (forbidden), but is
  // emitted per value for completeness; its name is spec-fixed to the literal
  // "set-cookie", so it never enters `_names`.
  _wireEntries() {
    const out = [];
    for (const [key, val] of this._map) out.push([this._names.get(key) || key, val]);
    for (const c of this._setCookie) out.push(['set-cookie', c]);
    return out;
  }
  // Each set-cookie header value, individually, in insertion order (fetch getSetCookie()).
  getSetCookie() { return this._setCookie.slice(); }
  // Iteration is over the header list SORTED by name and combined, RE-EVALUATED at
  // every step (a monotonic index over a freshly-sorted snapshot) — so a delete /
  // append during iteration shifts what the next step yields, exactly as the Fetch
  // "Headers iterator" mandates (headers-basic live-mutation subtests). set-cookie is the
  // exception to "combine": each value is emitted separately (in insertion order, kept by
  // the stable sort), positioned by the sorted `set-cookie` name.
  _sortedEntries() {
    const entries = [...this._map.entries()];
    for (const c of this._setCookie) entries.push(['set-cookie', c]);
    return entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  }
  forEach(fn, thisArg) {
    for (let i = 0; ; i++) {
      const sorted = this._sortedEntries();
      if (i >= sorted.length) break;
      fn.call(thisArg, sorted[i][1], sorted[i][0], this);
    }
  }
  entries()    { return makeHeadersIterator(this, 'entry'); }
  keys()       { return makeHeadersIterator(this, 'key'); }
  values()     { return makeHeadersIterator(this, 'value'); }
  [Symbol.iterator]() { return this.entries(); }
  get [Symbol.toStringTag]() { return 'Headers'; }
}

// A spec-shaped Web IDL pair iterator: its prototype chains directly to
// %IteratorPrototype% and exposes a single enumerable/configurable/writable `next`
// (headers-basic checkIteratorProperties) — a generator fails both. `next` re-reads
// the sorted+combined list each call so live mutation during iteration is honoured.
const HEADERS_ITERATOR_PROTO = Object.create(
  Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]())),
  {
    next: {
      writable: true, enumerable: true, configurable: true,
      value: function next() {
        const sorted = this._headers._sortedEntries();
        if (this._i >= sorted.length) return { value: undefined, done: true };
        const [name, value] = sorted[this._i++];
        const k = this._kind;
        return { value: k === 'key' ? name : k === 'value' ? value : [name, value], done: false };
      }
    }
  }
);
function makeHeadersIterator(headers, kind) {
  // Internal state is NON-enumerable so the iterator object has no own enumerable
  // properties, as a real Headers iterator doesn't (Object.keys(headers.entries())
  // must be []; `{...headers.entries()}` must not spread internals).
  const it = Object.create(HEADERS_ITERATOR_PROTO);
  Object.defineProperty(it, '_headers', { value: headers });
  Object.defineProperty(it, '_kind',    { value: kind });
  Object.defineProperty(it, '_i',       { value: 0, writable: true });
  return it;
}

globalThis.URL             = URL;
globalThis.URLSearchParams = URLSearchParams;
globalThis.Headers         = Headers;
