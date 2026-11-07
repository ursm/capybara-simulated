// URL / URLSearchParams (URL Standard), generated from their IDL. A URL is the URL Standard's, native (url_ops.rs, the
// same parser as `__csim_parseUrl`): its parts as the parser hands them back are its internal slots', which its
// attributes read and a setter replaces, the interface's own setter steps run on the URL natively. A URLSearchParams is its list of name-value pairs, and — where it
// is a URL's `searchParams` — that URL, whose query its every change writes back and a change of which it reads again.
import { createObjectURL, revokeObjectURL } from './blob.js';
import { defineURL, defineURLSearchParams } from './generated/bindings.js';
import { makeSlots, slotsOf, objectCreate, reflectApply } from './webidl.js';
import { dom } from './engine.js';

// A URL's parts, as url_ops.rs `parts` orders them.
const HREF = 0, PROTOCOL = 1, USERNAME = 2, PASSWORD = 3, HOST = 4, HOSTNAME = 5, PORT = 6, PATHNAME = 7, SEARCH = 8,
      HASH = 9, ORIGIN = 10;

// ── URL ──
const urlOf = (o) => slotsOf(o, 'URL');
// (…the URL's parts, or null where `url` against `base` is no URL)
const stringSlice = String.prototype.slice, ONE = [1];
const parse = (url, base) => dom.urlParse(url, base === undefined ? null : base, null);
// (…a URL's slots: its parts, and its `searchParams` over its query — made as it is first read)
function initURL(o, parts) {
  const s = makeSlots(o, 'URL');
  s.parts = parts;
  s.params = null;
  return o;
}
// Set `part` as the interface's setter does (url_ops.rs `urlSet`): false where it does not take the value (an href
// that does not parse). Its query moving updates its params — unless it is the params writing it back ('query').
function setPart(url, part, value) {
  const s = urlOf(url);
  const parts = dom.urlSet(s.parts[HREF], part, value);
  if (parts === null) return false;
  const search = s.parts[SEARCH];
  s.parts = parts;
  if (part !== 'query' && parts[SEARCH] !== search && s.params !== null) {
    const p = paramsSlots(s.params);
    p.query = parts[SEARCH].slice(1);
    p.list = null;
    p.pairs = null;
  }
  return true;
}
const url = {
  construct(slots, url, base) {
    const parts = parse(url, base);
    if (parts === null) {
      // (…Chrome's message: the base's where that is no URL)
      const what = base !== undefined && parse(base) === null ? 'Invalid base URL' : 'Invalid URL';
      throw new TypeError(`Failed to construct 'URL': ${what}`);
    }
    slots.parts = parts;
    slots.params = null;
  },
  get_href: (u) => urlOf(u).parts[HREF],
  set_href(u, v) { if (!setPart(u, 'href', v)) throw new TypeError(`Failed to set the 'href' property on 'URL': Invalid URL`); },
  get_origin: (u) => urlOf(u).parts[ORIGIN],
  get_searchParams(u) {
    const s = urlOf(u);
    return (s.params ??= paramsOf(u, s.parts[SEARCH].slice(1)));
  },
  toJSON: (u) => urlOf(u).parts[HREF],
  // (…a URL a string makes against a base, or none: Chromium 120+'s, which WHATWG fetch polyfills probe)
  canParse: (self, u, base) => parse(u, base) !== null,
  parse(self, u, base) {
    const parts = parse(u, base);
    return parts === null ? null : initURL(objectCreate(URL.prototype), parts);
  },
  createObjectURL: (self, blob) => createObjectURL(blob),
  revokeObjectURL: (self, u) => revokeObjectURL(u)
};
for (const [name, index] of Object.entries({ protocol: PROTOCOL, username: USERNAME, password: PASSWORD, host: HOST, hostname: HOSTNAME,
                                              port: PORT, pathname: PATHNAME, search: SEARCH, hash: HASH })) {
  url[`get_${name}`] = (u) => urlOf(u).parts[index];
  url[`set_${name}`] = (u, v) => { setPart(u, name, v); };
}
export const URL = defineURL(url);

// ── URLSearchParams ──
// Its list is the engine's (search_params.rs, `__dom.SearchParamsBase`), made from the query it was given as it is first
// read or changed — none for an object only made, as most a URL makes are; its slots hold that, the URL whose
// `searchParams` it is (null for none), and its pairs as an iteration reads them, taken again once a change moved them.
const paramsSlots = (o) => slotsOf(o, 'URLSearchParams');
const listOf = (s) => (s.list ??= new (dom.SearchParamsBase)(s.query));
// …its pairs serialized, as a request body extracts them (Fetch "extract a body": not its `toString`, a page's to replace).
export const serializedSearchParams = (params) => dom.searchParamsSerialize(listOf(paramsSlots(params)));
// A URL's `searchParams`: its query's pairs, and the URL.
function paramsOf(u, query) {
  const o = objectCreate(URLSearchParams.prototype);
  const slots = makeSlots(o, 'URLSearchParams');
  slots.query = query;
  slots.list = null;
  slots.url = u;
  slots.pairs = null;
  return o;
}
// The URLSearchParams update steps, after a change of its list: a URL's query the pairs serialized — none (no `?`) where
// that is empty.
function update(s) {
  s.pairs = null;
  if (s.url === null) return;
  const query = dom.searchParamsSerialize(s.list);
  setPart(s.url, 'query', query === '' ? null : query);
}
const changed = (op) => (params, ...args) => {
  const s = paramsSlots(params);
  op(listOf(s), ...args);
  update(s);
};
export const URLSearchParams = defineURLSearchParams({
  construct(s, init) {
    // (…a single leading `?` removed from a string — a URL's own query is read verbatim, where `http://x/??a=b`'s first
    // name is `?a`)
    s.query = typeof init === 'string' ? (init[0] === '?' ? reflectApply(stringSlice, init, ONE) : init) : '';
    s.list = null;
    s.url = null;
    s.pairs = null;
    if (init !== undefined && typeof init !== 'string') {
      // (…a sequence of pairs, or a record's: each pair of exactly two)
      const list = listOf(s);
      for (let i = 0; i < init.length; i++) {
        const pair = init[i];
        if (pair.length !== 2) throw new TypeError("Failed to construct 'URLSearchParams': Sequence initializer must only contain pair elements");
        dom.searchParamsAppend(list, pair[0], pair[1]);
      }
    }
  },
  get_size: (params) => dom.searchParamsSize(listOf(paramsSlots(params))),
  append: changed((list, name, value) => dom.searchParamsAppend(list, name, value)),
  // (…`value` given, only the pairs of both)
  delete: changed((list, name, value) => dom.searchParamsDelete(list, name, value)),
  get: (params, name) => dom.searchParamsGet(listOf(paramsSlots(params)), name),
  getAll: (params, name) => dom.searchParamsGetAll(listOf(paramsSlots(params)), name),
  has: (params, name, value) => dom.searchParamsHas(listOf(paramsSlots(params)), name, value),
  // (…the first pair of the name taking the value in its place, the others gone; one appended where there is none)
  set: changed((list, name, value) => dom.searchParamsSet(list, name, value)),
  // (…a stable sort by name, in code units)
  sort: changed((list) => dom.searchParamsSort(list)),
  stringify: (params) => dom.searchParamsSerialize(listOf(paramsSlots(params))),
  pairs(params) {
    const s = paramsSlots(params);
    return (s.pairs ??= dom.searchParamsPairs(listOf(s)));
  }
});

globalThis.URL             = URL;
globalThis.URLSearchParams = URLSearchParams;
