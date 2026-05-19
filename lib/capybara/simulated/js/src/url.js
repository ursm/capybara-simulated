// URL / URLSearchParams / Headers — the spec value types `fetch` /
// `Request` / `Response` consume. Parsing routes to the
// `__csim_parseUrl` host fn (Ruby `UrlShape.parse_for_js`) since
// matching the WHATWG URL parser by hand is more code than it's
// worth.

function buildHref(u) {
  const search = u._search && u._search[0] !== '?' && u._search.length ? '?' + u._search : (u._search || '');
  const hash   = u._hash   && u._hash[0]   !== '#' && u._hash.length   ? '#' + u._hash   : (u._hash   || '');
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

export function URL(input, base) {
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
  this.searchParams = new URLSearchParams(this._search);
}
// Recompute `href` from the parts so mutations to `search` / `pathname`
// / `hash` (Forem's followButtons.js builds the bulk-status URL via
// `url.search = sp`) propagate through `toString()` / `fetch(url)`.
Object.defineProperties(URL.prototype, {
  href:     {get() { return buildHref(this); },
             set(v) {
               const u = globalThis.__csim_parseUrl(String(v), null);
               if (!u || u.error) throw new TypeError('Invalid URL: ' + v);
               this._protocol = u.protocol; this._username = u.username; this._password = u.password;
               this._host = u.host; this._hostname = u.hostname; this._port = u.port;
               this._pathname = u.pathname; this._search = u.search; this._hash = u.hash; this._origin = u.origin;
               this.searchParams = new URLSearchParams(this._search);
             }},
  protocol: {get() { return this._protocol; }, set(v) { this._protocol = String(v); }},
  username: {get() { return this._username; }, set(v) { this._username = String(v); }},
  password: {get() { return this._password; }, set(v) { this._password = String(v); }},
  host:     {get() { return this._host; },     set(v) { this._host     = String(v); }},
  hostname: {get() { return this._hostname; }, set(v) { this._hostname = String(v); }},
  port:     {get() { return this._port; },     set(v) { this._port     = String(v); }},
  pathname: {get() { return this._pathname; }, set(v) { this._pathname = String(v); }},
  search:   {get() { return this._search; },
             set(v) { this._search = normSearch(v); this.searchParams = new URLSearchParams(this._search); }},
  hash:     {get() { return this._hash; }, set(v) { this._hash = normHash(v); }},
  origin:   {get() { return this._origin; }}
});
URL.prototype.toString = function () { return buildHref(this); };
URL.prototype.toJSON   = function () { return buildHref(this); };

export function URLSearchParams(init) {
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
Object.defineProperties(URLSearchParams.prototype, {
  append:   {value: function (k, v) { this._entries.push([String(k), String(v)]); }, writable: true, configurable: true},
  delete:   {value: function (k)    { this._entries = this._entries.filter(e => e[0] !== String(k)); }, writable: true, configurable: true},
  get:      {value: function (k)    { for (const e of this._entries) if (e[0] === String(k)) return e[1]; return null; }, writable: true, configurable: true},
  getAll:   {value: function (k)    { return this._entries.filter(e => e[0] === String(k)).map(e => e[1]); }, writable: true, configurable: true},
  has:      {value: function (k)    { return this._entries.some(e => e[0] === String(k)); }, writable: true, configurable: true},
  set:      {value: function (k, v) { this.delete(k); this.append(k, v); }, writable: true, configurable: true},
  entries:  {value: function ()     { return this._entries[Symbol.iterator] ? this._entries[Symbol.iterator]() : this._entries.values(); }, writable: true, configurable: true},
  keys:     {value: function ()     { return this._entries.map(e => e[0])[Symbol.iterator](); }, writable: true, configurable: true},
  values:   {value: function ()     { return this._entries.map(e => e[1])[Symbol.iterator](); }, writable: true, configurable: true},
  forEach:  {value: function (fn)   { for (const e of this._entries) fn(e[1], e[0], this); }, writable: true, configurable: true},
  toString: {value: function ()     { return this._entries.map(e => encodeURIComponent(e[0]) + '=' + encodeURIComponent(e[1])).join('&'); }, writable: true, configurable: true},
  [Symbol.iterator]: {value: function () { return this.entries(); }, writable: true, configurable: true}
});

function normHeaderName(k) { return String(k).toLowerCase(); }

export function Headers(init) {
  this._map = new Map();
  if (init) {
    if (init instanceof Headers) {
      init.forEach((v, k) => this.append(k, v));
    } else if (Array.isArray(init)) {
      for (const e of init) this.append(e[0], e[1]);
    } else if (typeof init === 'object') {
      for (const k of Object.keys(init)) this.append(k, init[k]);
    }
  }
}
Object.defineProperties(Headers.prototype, {
  append:  {value: function (k, v) {
    const key  = normHeaderName(k);
    const prev = this._map.get(key);
    this._map.set(key, prev == null ? String(v) : prev + ', ' + String(v));
  }, writable: true, configurable: true},
  delete:  {value: function (k)    { this._map.delete(normHeaderName(k)); }, writable: true, configurable: true},
  get:     {value: function (k)    { const v = this._map.get(normHeaderName(k)); return v == null ? null : v; }, writable: true, configurable: true},
  has:     {value: function (k)    { return this._map.has(normHeaderName(k)); }, writable: true, configurable: true},
  set:     {value: function (k, v) { this._map.set(normHeaderName(k), String(v)); }, writable: true, configurable: true},
  forEach: {value: function (fn)   { this._map.forEach((v, k) => fn(v, k, this)); }, writable: true, configurable: true},
  entries: {value: function ()     { return this._map.entries(); }, writable: true, configurable: true},
  keys:    {value: function ()     { return this._map.keys(); },    writable: true, configurable: true},
  values:  {value: function ()     { return this._map.values(); },  writable: true, configurable: true},
  [Symbol.iterator]: {value: function () { return this.entries(); }, writable: true, configurable: true}
});
