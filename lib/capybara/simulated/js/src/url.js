// URL / URLSearchParams / Headers — the spec value types `fetch` /
// `Request` / `Response` consume. Parsing routes to the
// `__csim_parseUrl` host fn (Ruby `UrlShape.parse_for_js`) since
// matching the WHATWG URL parser by hand is more code than it's
// worth.

function buildHref(u) {
  const search = u._search && u._search[0] !== '?' && u._search.length ? '?' + u._search : (u._search || '');
  const hash   = u._hash   && u._hash[0]   !== '#' && u._hash.length   ? '#' + u._hash   : (u._hash   || '');
  // Opaque-path URLs (`javascript:`, `data:`, `mailto:`) have no `//` authority.
  if (u._opaque) {
    return u._protocol + u._pathname + search + hash;
  }
  return u._protocol + '//' +
         (u._username ? (u._username + (u._password ? ':' + u._password : '') + '@') : '') +
         u._host +
         u._pathname +
         search +
         hash;
}
function normSearch(val) {
  const s = String(val == null ? '' : val);
  if (!s.length) return '';
  return s[0] === '?' ? s : '?' + s;
}
function normHash(val) {
  const s = String(val == null ? '' : val);
  if (!s.length) return '';
  return s[0] === '#' ? s : '#' + s;
}

export class URL {
  constructor(input, base) {
    const u = globalThis.__csim_parseUrl(String(input), base != null ? String(base) : null);
    if (!u || u.error) throw new TypeError('Invalid URL: ' + input);
    this._protocol = u.protocol;
    this._username = u.username;
    this._password = u.password;
    this._host     = u.host;
    this._hostname = u.hostname;
    this._port     = u.port;
    this._pathname = u.pathname;
    this._search   = u.search;
    this._hash     = u.hash;
    this._origin   = u.origin;
    this._opaque   = u.opaque;
    this.searchParams = new URLSearchParams(this._search);
  }
  // `href`'s setter parses a fresh URL — Forem's followButtons.js
  // builds the bulk-status URL via `url.search = sp` and reads
  // `url.toString()` afterward; the search setter then propagates.
  get href() { return buildHref(this); }
  set href(v) {
    const u = globalThis.__csim_parseUrl(String(v), null);
    if (!u || u.error) throw new TypeError('Invalid URL: ' + v);
    this._protocol = u.protocol; this._username = u.username; this._password = u.password;
    this._host = u.host; this._hostname = u.hostname; this._port = u.port;
    this._pathname = u.pathname; this._search = u.search; this._hash = u.hash; this._origin = u.origin;
    this._opaque = u.opaque;
    this.searchParams = new URLSearchParams(this._search);
  }
  get protocol() { return this._protocol; } set protocol(v) { this._protocol = String(v); }
  get username() { return this._username; } set username(v) { this._username = String(v); }
  get password() { return this._password; } set password(v) { this._password = String(v); }
  get host()     { return this._host; }     set host(v)     { this._host     = String(v); }
  get hostname() { return this._hostname; } set hostname(v) { this._hostname = String(v); }
  get port()     { return this._port; }     set port(v)     { this._port     = String(v); }
  get pathname() { return this._pathname; } set pathname(v) { this._pathname = String(v); }
  get search()   { return this._search; }
  set search(v)  { this._search = normSearch(v); this.searchParams = new URLSearchParams(this._search); }
  get hash()     { return this._hash; }    set hash(v)     { this._hash = normHash(v); }
  get origin()   { return this._origin; }
  toString() { return buildHref(this); }
  toJSON()   { return buildHref(this); }
  // Static helpers — Chromium 120+; WHATWG fetch polyfills probe them.
  static canParse(input, base) {
    try { new URL(input, base); return true; } catch (_) { return false; }
  }
  static parse(input, base) {
    try { return new URL(input, base); } catch (_) { return null; }
  }
}

export class URLSearchParams {
  constructor(init) {
    this._entries = [];
    if (typeof init === 'string') {
      let s = init;
      if (s.charAt(0) === '?') s = s.slice(1);
      if (s.length) {
        for (const pair of s.split('&')) {
          const idx = pair.indexOf('=');
          const k = idx >= 0 ? pair.slice(0, idx)     : pair;
          const v = idx >= 0 ? pair.slice(idx + 1)    : '';
          this._entries.push([decodeURIComponent(k.replace(/\+/g, ' ')), decodeURIComponent(v.replace(/\+/g, ' '))]);
        }
      }
    } else if (init && typeof init.forEach === 'function') {
      init.forEach((v, k) => this._entries.push([String(k), String(v)]));
    } else if (Array.isArray(init)) {
      for (const e of init) this._entries.push([String(e[0]), String(e[1])]);
    } else if (init && typeof init === 'object') {
      for (const k of Object.keys(init)) this._entries.push([k, String(init[k])]);
    }
  }
  append(k, v) { this._entries.push([String(k), String(v)]); }
  delete(k)    { this._entries = this._entries.filter(e => e[0] !== String(k)); }
  get(k)       { for (const e of this._entries) if (e[0] === String(k)) return e[1]; return null; }
  getAll(k)    { return this._entries.filter(e => e[0] === String(k)).map(e => e[1]); }
  has(k)       { return this._entries.some(e => e[0] === String(k)); }
  set(k, v)    { this.delete(k); this.append(k, v); }
  // Spec stable sort by name (key) — used for canonical query strings
  // (cache keys, signed-URL building).
  sort()       { this._entries.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0); }
  get size()   { return this._entries.length; }
  entries()    { return this._entries.values(); }
  keys()       { return this._entries.map(e => e[0]).values(); }
  values()     { return this._entries.map(e => e[1]).values(); }
  forEach(fn)  { for (const e of this._entries) fn(e[1], e[0], this); }
  toString()   { return this._entries.map(e => encodeURIComponent(e[0]) + '=' + encodeURIComponent(e[1])).join('&'); }
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
