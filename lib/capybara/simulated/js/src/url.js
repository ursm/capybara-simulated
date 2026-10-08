// URL / URLSearchParams (URL Standard), generated from their IDL. A URL is the URL Standard's, native (url_ops.rs, the
// same parser as `__csim_parseUrl`): its parts as the parser hands them back are its internal slots', which its
// attributes read and a setter replaces, the interface's own setter steps run on the URL natively. A URLSearchParams is its list of name-value pairs, and — where it
// is a URL's `searchParams` — that URL, whose query its every change writes back and a change of which it reads again.
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
// U+FFFD, matching real browsers instead of a URIError. An ASCII one with no `%` — a URL's own query's, nearly every
// one — is its `+`s alone.
const HEX = /[0-9A-Fa-f]/;
const PLAIN = /^[\x00-\x24\x26-\x7F]*$/;
function formDecode(s) {
  if (PLAIN.test(s)) return s.replaceAll('+', ' ');
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
  // (…"UTF-8 decode without BOM" — a leading U+FEFF is data — natively, where no page's TextDecoder reaches)
  return globalThis.__dom.textDecode('UTF-8', new Uint8Array(bytes), true, false);
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
    if (parts === null) {
      // (…Chrome's message: the base's where that is no URL)
      const what = base !== undefined && parse(base) === null ? 'Invalid base URL' : 'Invalid URL';
      throw new TypeError(`Failed to construct 'URL': ${what}`);
    }
    initURL(this, parts);
  }
}
// (…a URL's slots: its parts, and its `searchParams` over its query)
function initURL(o, parts) {
  const s = makeSlots(o, 'URL', { parts, params: null });
  s.params = paramsOf(o, parts[SEARCH].slice(1));
  return o;
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
    return parts === null ? null : initURL(Object.create(URL.prototype), parts);
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

globalThis.URL             = URL;
globalThis.URLSearchParams = URLSearchParams;
