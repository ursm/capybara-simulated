// URL / URLSearchParams / Headers — the spec value types `fetch` /
// `Request` / `Response` consume. The `URL` class is backed by the vendored
// whatwg-url state machine (`__csimVendor.urlEngine`, same backend as
// `__csim_parseUrl`): it stores the parsed URL *record* and drives every
// getter / setter / serialization through the WHATWG algorithms — getters
// derive from the record, setters run `basicURLParse(value, {url, stateOverride})`
// (exactly the spec's per-component setter steps), href is `serializeURL`. So
// component mutation and serialization are spec-correct rather than hand-rolled
// (no manual `//`-authority / empty-query reassembly).
import { FORBIDDEN_RESPONSE_HEADERS, isForbiddenRequestHeader } from './header-rules.js';

const USM = globalThis.__csimVendor && globalThis.__csimVendor.urlEngine;

// application/x-www-form-urlencoded byte serializer for one key/value.
function formEncode(s) {
  return encodeURIComponent(s)
    .replace(/%20/g, '+')
    .replace(/[!'()~]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}
// DOMString → USVString: replace every lone surrogate (an unpaired high or low
// surrogate code unit) with U+FFFD, leaving valid surrogate pairs intact. Used
// when coercing URLSearchParams constructor arguments, whose IDL type is
// USVString. Hand-rolled rather than via a lookbehind regex so it runs on both
// engines (QuickJS lacks reliable lookbehind support).
function toUSV(s) {
  s = String(s);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xD800 && c <= 0xDBFF) {            // high surrogate
      const n = s.charCodeAt(i + 1);
      if (n >= 0xDC00 && n <= 0xDFFF) { out += s[i] + s[i + 1]; i++; }  // valid pair
      else out += '�';                      // lone high surrogate
    } else if (c >= 0xDC00 && c <= 0xDFFF) {     // lone low surrogate
      out += '�';
    } else {
      out += s[i];
    }
  }
  return out;
}
// application/x-www-form-urlencoded decode for one key/value, per the WHATWG
// parser: `+`→space, valid `%XX`→byte, every other char→its UTF-8 bytes, then
// UTF-8-decode the bytes (invalid sequences → U+FFFD). Unlike decodeURIComponent
// it NEVER throws — a stray `%` (`?a=%zz`) or a lone high byte (`%FF`) stays
// literal / becomes U+FFFD, matching real browsers instead of a URIError.
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
  // "UTF-8 decode without BOM" (the form-urlencoded byte-decoder): a leading
  // U+FEFF is data, not a byte-order mark, so `ignoreBOM` keeps it (the default
  // TextDecoder would strip it, dropping a leading BOM from a key/value).
  return new globalThis.TextDecoder('utf-8', {ignoreBOM: true}).decode(new Uint8Array(bytes));
}

export class URL {
  // WebIDL interface brand: `Object.prototype.toString.call(new URL(...))` is
  // "[object URL]" (real browsers), and it's the cross-realm-safe way structuredClone
  // detects a (non-serializable) URL handed over by postMessage.
  get [Symbol.toStringTag]() { return 'URL'; }
  constructor(input, base) {
    // A base is parsed first (a provided-but-invalid base is a TypeError); null
    // / omitted means "no base" (kept lenient — our prior behavior — vs the
    // spec's null→"null"; no test or app relies on `new URL(rel, null)` throwing).
    let baseRec = null;
    if (base !== undefined && base !== null) {
      baseRec = USM.basicURLParse(String(base));
      if (baseRec === null) throw new TypeError('Invalid base URL: ' + base);
    }
    const rec = USM.basicURLParse(String(input), { baseURL: baseRec || undefined });
    if (rec === null) throw new TypeError('Invalid URL: ' + input);
    this._rec = rec;
    this._searchParams = new URLSearchParams(rec.query == null ? '' : rec.query, this);
  }
  // `searchParams` is a readonly attribute (getter only), so assigning to it
  // throws in strict mode — the same live object is returned every read.
  get searchParams() { return this._searchParams; }
  get href() { return USM.serializeURL(this._rec); }
  set href(v) {
    const rec = USM.basicURLParse(String(v));
    if (rec === null) throw new TypeError('Invalid URL: ' + v);
    this._rec = rec;
    this._searchParams._reset(rec.query == null ? '' : rec.query);
  }
  get origin()   { return USM.serializeURLOrigin(this._rec); }
  get protocol() { return this._rec.scheme + ':'; }
  set protocol(v) { USM.basicURLParse(String(v) + ':', { url: this._rec, stateOverride: 'scheme start' }); }
  get username() { return this._rec.username; }
  set username(v) { if (!USM.cannotHaveAUsernamePasswordPort(this._rec)) USM.setTheUsername(this._rec, String(v)); }
  get password() { return this._rec.password; }
  set password(v) { if (!USM.cannotHaveAUsernamePasswordPort(this._rec)) USM.setThePassword(this._rec, String(v)); }
  get host() {
    const u = this._rec;
    if (u.host === null) return '';
    return u.port === null ? USM.serializeHost(u.host)
                           : USM.serializeHost(u.host) + ':' + USM.serializeInteger(u.port);
  }
  set host(v) { if (!USM.hasAnOpaquePath(this._rec)) USM.basicURLParse(String(v), { url: this._rec, stateOverride: 'host' }); }
  get hostname() { return this._rec.host === null ? '' : USM.serializeHost(this._rec.host); }
  set hostname(v) { if (!USM.hasAnOpaquePath(this._rec)) USM.basicURLParse(String(v), { url: this._rec, stateOverride: 'hostname' }); }
  get port() { return this._rec.port === null ? '' : USM.serializeInteger(this._rec.port); }
  set port(v) {
    if (USM.cannotHaveAUsernamePasswordPort(this._rec)) return;
    if (String(v) === '') this._rec.port = null;
    else USM.basicURLParse(String(v), { url: this._rec, stateOverride: 'port' });
  }
  get pathname() { return USM.serializePath(this._rec); }
  set pathname(v) {
    if (USM.hasAnOpaquePath(this._rec)) return;
    this._rec.path = [];
    USM.basicURLParse(String(v), { url: this._rec, stateOverride: 'path start' });
  }
  get search() {
    const q = this._rec.query;
    return (q === null || q === '') ? '' : '?' + q;
  }
  set search(v) {
    const s = String(v);
    if (s === '') { this._rec.query = null; this._searchParams._reset(''); return; }
    const input = s[0] === '?' ? s.slice(1) : s;
    this._rec.query = '';
    USM.basicURLParse(input, { url: this._rec, stateOverride: 'query' });
    this._searchParams._reset(input);
  }
  get hash() {
    const f = this._rec.fragment;
    return (f === null || f === '') ? '' : '#' + f;
  }
  set hash(v) {
    const s = String(v);
    if (s === '') { this._rec.fragment = null; return; }
    const input = s[0] === '#' ? s.slice(1) : s;
    this._rec.fragment = '';
    USM.basicURLParse(input, { url: this._rec, stateOverride: 'fragment' });
  }
  toString() { return USM.serializeURL(this._rec); }
  toJSON()   { return USM.serializeURL(this._rec); }
  // Static helpers — Chromium 120+; WHATWG fetch polyfills probe them.
  static canParse(input, base) {
    try { new URL(input, base); return true; } catch (_) { return false; }
  }
  static parse(input, base) {
    try { return new URL(input, base); } catch (_) { return null; }
  }
}

export class URLSearchParams {
  get [Symbol.toStringTag]() { return 'URLSearchParams'; }
  // `_url` (internal 2nd arg) links this params object back to the owning URL
  // so mutations propagate to `url.search`/`url.href` — the spec's two-way
  // binding. Public `new URLSearchParams(init)` callers pass no `_url` and stay
  // standalone.
  constructor(init, _url) {
    this._entries = [];
    this._url = _url || null;
    if (init === undefined || init === null) {
      // empty
    } else if (typeof init === 'string') {
      // The public string constructor removes a single leading '?'; the
      // URL-bound form (`_url` set, fed the URL's already-delimiter-stripped
      // query) must NOT, so a literal '?' inside the query — `http://x/??a=b`,
      // whose query component is `?a=b` — is kept as part of the first name.
      this._parseQuery(this._url || init.charAt(0) !== '?' ? init : init.slice(1));
    } else if (typeof init[Symbol.iterator] === 'function') {
      // A sequence<sequence<USVString>> — iterate `init` and treat each item as a
      // [name, value] pair. This covers arrays of pairs (incl. Turbo's
      // `new URLSearchParams(Array.from(formData))` form-submit path), FormData,
      // Map, another URLSearchParams, and any object with a custom Symbol.iterator
      // — all of which yield [name, value] entries. Each pair is itself a sequence
      // that must have exactly two elements (spec: a non-2 inner sequence is a
      // TypeError). MUST be checked before the record branch: a sequence is keyed
      // off Symbol.iterator, not off being a plain object.
      for (const pair of init) {
        if (pair == null || typeof pair[Symbol.iterator] !== 'function') {
          throw new TypeError("Failed to construct 'URLSearchParams': parameter 1 sequence's element is not iterable.");
        }
        const p = [...pair];
        if (p.length !== 2) {
          throw new TypeError("Failed to construct 'URLSearchParams': each pair must have exactly two elements.");
        }
        this._entries.push([toUSV(p[0]), toUSV(p[1])]);
      }
    } else if (typeof init === 'object' || typeof init === 'function') {
      // A record<USVString, USVString> — its own enumerable string keys, in
      // order. Per WebIDL record conversion the keys are USVString-coerced and
      // de-duplicated as an ordered map (a re-set keeps the key's original
      // position but updates the value), so two distinct JS keys that coerce to
      // the same USVString (only possible via lone surrogates) collapse to one
      // entry with the later value. `typeof === 'function'` is included so an
      // interface object like DOMException (with own enumerable static constants)
      // is read as a record.
      const m = new Map();
      for (const k of Object.keys(init)) m.set(toUSV(k), toUSV(init[k]));
      for (const [k, v] of m) this._entries.push([k, v]);
    }
  }
  // Parse a query string (already past any leading '?') into entries (`+`→space,
  // then percent-decode). The leading-'?' strip is the caller's responsibility:
  // only the public string constructor does it (see the constructor), since the
  // URL-bound path is fed the query component verbatim.
  _parseQuery(str) {
    const s = str;
    if (!s.length) return;
    for (const pair of s.split('&')) {
      if (pair === '') continue;
      const idx = pair.indexOf('=');
      const k = idx >= 0 ? pair.slice(0, idx) : pair;
      const v = idx >= 0 ? pair.slice(idx + 1) : '';
      this._entries.push([formDecode(k), formDecode(v)]);
    }
  }
  // Reload entries from a query string IN PLACE (keeps object identity + the
  // `_url` link) — the URL's `search`/`href` setters call this so a retained
  // `url.searchParams` reference stays the same live object, per spec.
  _reset(str) { this._entries = []; this._parseQuery(str || ''); }
  // Propagate a mutation to the owning URL (if any). Per the spec update
  // steps, an empty serialization sets the URL's query to null — so an emptied
  // params object drops the `?` from href.
  _writeBack() {
    if (!this._url) return;
    const s = this.toString();
    // Per the URLSearchParams update steps, an empty serialization sets the
    // URL's query to null (drops the `?`); otherwise to the serialized string.
    this._url._rec.query = s === '' ? null : s;
  }
  append(k, v) { this._entries.push([String(k), String(v)]); this._writeBack(); }
  // `delete`/`has` take an optional second `value` argument (HTML/URL "delete"
  // and "has" with a value): when given, only pairs matching BOTH name and value
  // are targeted. An explicit `undefined` second arg counts as absent (WebIDL
  // optional), so it falls back to name-only matching.
  delete(k, v) {
    const name = String(k);
    this._entries = v === undefined
      ? this._entries.filter(e => e[0] !== name)
      : this._entries.filter(e => !(e[0] === name && e[1] === String(v)));
    this._writeBack();
  }
  get(k)       { for (const e of this._entries) if (e[0] === String(k)) return e[1]; return null; }
  getAll(k)    { return this._entries.filter(e => e[0] === String(k)).map(e => e[1]); }
  has(k, v) {
    const name = String(k);
    return v === undefined
      ? this._entries.some(e => e[0] === name)
      : this._entries.some(e => e[0] === name && e[1] === String(v));
  }
  // Spec `set`: if a pair with this name exists, set the FIRST such pair's value
  // and drop the rest (preserving the first occurrence's POSITION); otherwise
  // append. delete-then-append would instead move the pair to the end.
  set(k, v) {
    const name = String(k), val = String(v);
    let found = false;
    const out = [];
    for (const e of this._entries) {
      if (e[0] === name) {
        if (!found) { out.push([name, val]); found = true; }
      } else {
        out.push(e);
      }
    }
    if (!found) out.push([name, val]);
    this._entries = out;
    this._writeBack();
  }
  // Spec stable sort by name (key) — used for canonical query strings
  // (cache keys, signed-URL building).
  sort()       { this._entries.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0); this._writeBack(); }
  get size()   { return this._entries.length; }
  // Iteration is LIVE: the URLSearchParams iterator and `forEach` re-read the
  // entry list by index each step, so pairs appended or deleted during iteration
  // are observed per spec (e.g. deleting the current/next param mid-loop, or a
  // `url.search =` reset that swaps the backing list). A cached `.values()`
  // iterator over a snapshot array would not see those mutations.
  *_iterate(project) {
    for (let i = 0; i < this._entries.length; i++) {
      const e = this._entries[i];
      yield project(e);
    }
  }
  entries()    { return this._iterate(e => [e[0], e[1]]); }
  keys()       { return this._iterate(e => e[0]); }
  values()     { return this._iterate(e => e[1]); }
  forEach(fn)  { for (let i = 0; i < this._entries.length; i++) fn(this._entries[i][1], this._entries[i][0], this); }
  // application/x-www-form-urlencoded serializer: space→`+`, and percent-encode
  // the chars encodeURIComponent leaves literal but the form serializer does not
  // (`!'()~`). Matches real-browser URLSearchParams.toString().
  toString()   { return this._entries.map(e => formEncode(e[0]) + '=' + formEncode(e[1])).join('&'); }
  [Symbol.iterator]() { return this.entries(); }
}

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
