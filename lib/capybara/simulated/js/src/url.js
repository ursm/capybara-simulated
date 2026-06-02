// URL / URLSearchParams / Headers — the spec value types `fetch` /
// `Request` / `Response` consume. The `URL` class is backed by the vendored
// whatwg-url state machine (`__csimVendor.urlEngine`, same backend as
// `__csim_parseUrl`): it stores the parsed URL *record* and drives every
// getter / setter / serialization through the WHATWG algorithms — getters
// derive from the record, setters run `basicURLParse(value, {url, stateOverride})`
// (exactly the spec's per-component setter steps), href is `serializeURL`. So
// component mutation and serialization are spec-correct rather than hand-rolled
// (no manual `//`-authority / empty-query reassembly).
const USM = globalThis.__csimVendor && globalThis.__csimVendor.urlEngine;

// application/x-www-form-urlencoded byte serializer for one key/value.
function formEncode(s) {
  return encodeURIComponent(s)
    .replace(/%20/g, '+')
    .replace(/[!'()~]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
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
  return new globalThis.TextDecoder().decode(new Uint8Array(bytes));
}

export class URL {
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
    this.searchParams = new URLSearchParams(rec.query == null ? '' : rec.query, this);
  }
  get href() { return USM.serializeURL(this._rec); }
  set href(v) {
    const rec = USM.basicURLParse(String(v));
    if (rec === null) throw new TypeError('Invalid URL: ' + v);
    this._rec = rec;
    this.searchParams._reset(rec.query == null ? '' : rec.query);
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
    if (s === '') { this._rec.query = null; this.searchParams._reset(''); return; }
    const input = s[0] === '?' ? s.slice(1) : s;
    this._rec.query = '';
    USM.basicURLParse(input, { url: this._rec, stateOverride: 'query' });
    this.searchParams._reset(input);
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
  // `_url` (internal 2nd arg) links this params object back to the owning URL
  // so mutations propagate to `url.search`/`url.href` — the spec's two-way
  // binding. Public `new URLSearchParams(init)` callers pass no `_url` and stay
  // standalone.
  constructor(init, _url) {
    this._entries = [];
    this._url = _url || null;
    if (typeof init === 'string') {
      this._parseQuery(init);
    } else if (init && typeof init.forEach === 'function') {
      init.forEach((v, k) => this._entries.push([String(k), String(v)]));
    } else if (Array.isArray(init)) {
      for (const e of init) this._entries.push([String(e[0]), String(e[1])]);
    } else if (init && typeof init === 'object') {
      for (const k of Object.keys(init)) this._entries.push([k, String(init[k])]);
    }
  }
  // Parse a query string into entries (`+`→space, then percent-decode).
  _parseQuery(str) {
    let s = str;
    if (s.charAt(0) === '?') s = s.slice(1);
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
  delete(k)    { this._entries = this._entries.filter(e => e[0] !== String(k)); this._writeBack(); }
  get(k)       { for (const e of this._entries) if (e[0] === String(k)) return e[1]; return null; }
  getAll(k)    { return this._entries.filter(e => e[0] === String(k)).map(e => e[1]); }
  has(k)       { return this._entries.some(e => e[0] === String(k)); }
  set(k, v)    { this.delete(k); this.append(k, v); }
  // Spec stable sort by name (key) — used for canonical query strings
  // (cache keys, signed-URL building).
  sort()       { this._entries.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0); this._writeBack(); }
  get size()   { return this._entries.length; }
  entries()    { return this._entries.values(); }
  keys()       { return this._entries.map(e => e[0]).values(); }
  values()     { return this._entries.map(e => e[1]).values(); }
  forEach(fn)  { for (const e of this._entries) fn(e[1], e[0], this); }
  // application/x-www-form-urlencoded serializer: space→`+`, and percent-encode
  // the chars encodeURIComponent leaves literal but the form serializer does not
  // (`!'()~`). Matches real-browser URLSearchParams.toString().
  toString()   { return this._entries.map(e => formEncode(e[0]) + '=' + formEncode(e[1])).join('&'); }
  [Symbol.iterator]() { return this.entries(); }
}

function normHeaderName(k) { return String(k).toLowerCase(); }

export class Headers {
  constructor(init) {
    this._map = new Map();
    if (!init) return;
    if (init instanceof Headers) {
      init.forEach((v, k) => this.append(k, v));
    } else if (Array.isArray(init)) {
      for (const e of init) this.append(e[0], e[1]);
    } else if (typeof init === 'object') {
      for (const k of Object.keys(init)) this.append(k, init[k]);
    }
  }
  append(k, v) {
    const key  = normHeaderName(k);
    const prev = this._map.get(key);
    this._map.set(key, prev == null ? String(v) : prev + ', ' + String(v));
  }
  delete(k)    { this._map.delete(normHeaderName(k)); }
  get(k)       { const v = this._map.get(normHeaderName(k)); return v == null ? null : v; }
  has(k)       { return this._map.has(normHeaderName(k)); }
  set(k, v)    { this._map.set(normHeaderName(k), String(v)); }
  // Modern (2023) — Set-Cookie is special-cased: the spec keeps each
  // value separately rather than comma-joined. We don't model that
  // separation (the map combine is single-string), but return the
  // joined string split on ", " as a best-effort to apps probing this.
  getSetCookie() {
    const v = this._map.get('set-cookie');
    if (!v) return [];
    return v.split(/,\s+(?=[^=,]+=)/);
  }
  forEach(fn)  { this._map.forEach((v, k) => fn(v, k, this)); }
  entries()    { return this._map.entries(); }
  keys()       { return this._map.keys(); }
  values()     { return this._map.values(); }
  [Symbol.iterator]() { return this.entries(); }
}

globalThis.URL             = URL;
globalThis.URLSearchParams = URLSearchParams;
globalThis.Headers         = Headers;
