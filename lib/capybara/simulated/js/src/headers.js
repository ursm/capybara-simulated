// Headers (Fetch Standard), generated from its IDL: the value type `fetch` / `Request` / `Response` consume. A Headers
// is its header list — the engine's (headers.rs): each header a field of its own, in the order appended, which a read
// of a name combines, by the name the first of its name was given (the casing it goes on the wire in), and its guard,
// which `fetch` /
// `Request` / `Response` set: what a script may write to it. The bindings convert the arguments and throw what a write
// the engine refused is.
import { convertHeadersArguments, installHeaders } from './generated/bindings.js';
import { makeSlots, registerInterface, slotsOf, createObject, objectCreate, rootInterface } from './webidl.js';
import { dom, listBuild, newList } from './engine.js';

const headersOf = (o) => slotsOf(o, 'Headers');
export const isHeaders = (o) => headersOf(o) !== undefined;
registerInterface('Headers', isHeaders);

// The guards, by the code the engine names each with (headers.rs `GUARD_*`) — and each one's code, read as a property: a
// fetch's and an XHR's every Headers asks it, never through an `indexOf` a page may have replaced.
const GUARDS = ['none', 'request', 'request-no-cors', 'response', 'immutable'];
const GUARD_CODES = { __proto__: null, 'none': 0, 'request': 1, 'request-no-cors': 2, 'response': 3, 'immutable': 4 };
// (…and the `Object.keys` and `String` the snapshot had: a network's header map read with no function a page replaced)
const objectKeys = Object.keys, toText = String;
// …how `headersCopy` copies: the list, the list filled again through the guard, the names alone.
const COPY_LIST = 0, COPY_REFILL = 1, COPY_NAMES = 2;
// …and what a write came to (headers.rs `WRITTEN` …): done — or dropped, as a guard drops a forbidden header — or
// refused, with Chrome's message.
const REFUSALS = [null, 'Invalid name', 'Invalid value', 'Headers are immutable'];
function written(outcome, prefix) {
  if (outcome !== 0) throw new TypeError(prefix + REFUSALS[outcome]);
}

export class Headers extends Object {
  constructor(init) {
    const converted = convertHeadersArguments(arguments)[0];
    const self = createObject(new.target);
    construct(self, converted, 'none', "Failed to construct 'Headers': ");
    // (…made from another Headers, whose entries its iterator gives lowercased: each name the one the source gave it)
    if (isHeaders(init)) dom.headersCopy(headersOf(init).list, headersOf(self).list, COPY_NAMES);
    return self;
  }
}
rootInterface(Headers);
// Its slots: the engine's list, and the list sorted and combined (`headerPairs`) until it next changes. A Headers of
// `init`, a HeadersInit, filled under `guard`, its messages after `prefix`.
function construct(o, init, guard, prefix) {
  const s = makeSlots(o, 'Headers');
  s.list = new dom.HeadersBase(GUARD_CODES[guard]);
  s.sorted = null;
  fill(o, init, prefix);
  return o;
}
// Fetch "fill": each pair of a sequence of exactly two, or each of a record's, appended.
function fill(o, init, prefix) {
  if (init === undefined) return;
  for (let i = 0; i < init.length; i++) {
    const pair = init[i];
    if (pair.length !== 2) throw new TypeError(prefix + 'Invalid value');
    append(o, pair[0], pair[1], prefix);
  }
}
function append(o, name, value, prefix) {
  const s = headersOf(o);
  s.sorted = null;
  written(dom.headersAppend(s.list, name, value), prefix);
}
// Fetch "sort and combine": the header list sorted by name, a `set-cookie` value each its own pair, in the order they
// were appended. An iteration reads it again at every step, so a change during one shifts what the next step yields —
// sorted again only once it has changed.
export function headerPairs(h) {
  const s = headersOf(h);
  if (s.sorted === null) {
    const flat = dom.headersPairs(s.list);
    s.sorted = listBuild((add) => {
      for (let i = 0; i < flat.length; i += 2) add([flat[i], flat[i + 1]]);
    });
  }
  return s.sorted;
}
const prefixOf = (member) => `Failed to execute '${member}' on 'Headers': `;
// (…a name that is no header name a TypeError: the engine answers undefined for one)
function named(answer, member) {
  if (answer === undefined) throw new TypeError(prefixOf(member) + 'Invalid name');
  return answer;
}
installHeaders(Headers, {
  append(h, name, value) { append(h, name, value, prefixOf('append')); },
  delete(h, name) {
    const s = headersOf(h);
    s.sorted = null;
    written(dom.headersDelete(s.list, name), prefixOf('delete'));
  },
  get: (h, name) => named(dom.headersGet(headersOf(h).list, name), 'get'),
  getSetCookie: (h) => dom.headersSetCookies(headersOf(h).list),
  has: (h, name) => named(dom.headersHas(headersOf(h).list, name), 'has'),
  set(h, name, value) {
    const s = headersOf(h);
    s.sorted = null;
    written(dom.headersSet(s.list, name, value), prefixOf('set'));
  },
  pairs: headerPairs
});

// A header's value — the values of a lowercased `key`, combined — or null: Headers' `get`, which the driver's own reads
// take here rather than through a method a page may have replaced.
export function getHeader(h, key) {
  return dom.headersGet(headersOf(h).list, key) ?? null;
}
// Fetch "append" to a Headers (its guard checked): what a Request's body adds — its Content-Type.
export function appendHeader(h, name, value) {
  append(h, name, value, '');
}

// A Headers a Request or a Response makes, its guard set before `init` (a HeadersInit its RequestInit / ResponseInit
// converted, or undefined) fills it — so the guard drops a forbidden header `init` gives too; `prefix` its caller's.
export function createHeaders(init, guard, prefix) {
  return construct(objectCreate(Headers.prototype), init, guard, prefix);
}
// A Headers made from another's header list (the Request constructor's "copy of input's header list", a Response's
// given one) — not read through an iterator a page may have replaced — filtered through `guard` where `refill` (a
// non-empty init "empties this's headers and fills it" with them).
export function copyHeaders(source, guard, refill) {
  const h = construct(objectCreate(Headers.prototype), undefined, guard, '');
  dom.headersCopy(headersOf(source).list, headersOf(h).list, refill ? COPY_REFILL : COPY_LIST);
  return h;
}
// A response's Headers from the network's header map, immutable: the values verbatim (headers.rs `from_network`), a
// filtered response's — its cookies left out (`Set-Cookie` / `Set-Cookie2`, the forbidden response-header names), as
// script never sees them (Fetch's basic and CORS filtered responses; a Response script makes cannot hold them either).
export function networkHeaders(raw) {
  const h = construct(objectCreate(Headers.prototype), undefined, 'immutable', '');
  if (raw) dom.headersFromNetwork(headersOf(h).list, networkFields(raw), true);
  return h;
}
// …a network's header map `{name: value}` as the engine takes it, `[name, value, …]`.
function networkFields(raw) {
  const names = objectKeys(raw), flat = newList();
  for (let i = 0; i < names.length; i++) {
    flat[flat.length] = names[i];
    flat[flat.length] = toText(raw[names[i]]);
  }
  return flat;
}
export const headersGuard = (h) => GUARDS[dom.headersGuard(headersOf(h).list)];
export function setHeadersGuard(h, guard) {
  dom.headersGuard(headersOf(h).list, GUARD_CODES[guard]);
}
// The header list as it goes ON THE WIRE: each header a field of its own, in the order appended, by the name the first
// of its name was given (the author's casing — request-headers-case), not the lowercased, sorted view a script reads.
export function wireEntries(h) {
  const flat = dom.headersWire(headersOf(h).list);
  return listBuild((add) => {
    for (let i = 0; i < flat.length; i += 2) add([flat[i], flat[i + 1]]);
  });
}

// A response's header list as XMLHttpRequest exposes it, from the network's header map: a basic filtered response's,
// its cookies left out — and what reads it: a name's values combined (null for none, or for a name that is no header
// name), and getAllResponseHeaders()'s text.
export function filteredHeaderList(raw) {
  const list = new dom.HeadersBase(GUARD_CODES.none);
  if (raw) dom.headersFromNetwork(list, networkFields(raw), true);
  return list;
}
export const headerListGet = (list, name) => (list && dom.headersGet(list, name)) ?? null;
export const headerListText = (list) => (list ? dom.headersForXhr(list) : '');
// …and its author request headers: a list under the "request" guard, which drops a forbidden request-header — written
// as Headers' append and set are (what they came to: `HEADER_WRITTEN` …) — which the engine describes the request it
// sends with (fetch_request.rs), as it does a Request's Headers' list (`headerListOf`).
export const HEADER_WRITTEN = 0, HEADER_BAD_NAME = 1, HEADER_BAD_VALUE = 2;
export const requestHeaderList = () => new dom.HeadersBase(GUARD_CODES.request);
export const headerListAppend = (list, name, value) => dom.headersAppend(list, name, value);
export const headerListSet = (list, name, value) => dom.headersSet(list, name, value);
export const headerListOf = (h) => headersOf(h).list;

globalThis.Headers = Headers;
