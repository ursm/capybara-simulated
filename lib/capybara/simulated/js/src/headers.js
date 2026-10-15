// Headers (Fetch Standard), generated from its IDL: the value type `fetch` / `Request` / `Response` consume. A Headers
// is its header list — the engine's (headers.rs): the values of a name combined, but `set-cookie`'s, which stay one per
// header, the name each header was first given (the casing it goes on the wire in), and its guard, which `fetch` /
// `Request` / `Response` set: what a script may write to it. The bindings convert the arguments and throw what a write
// the engine refused is.
import { convertHeadersArguments, installHeaders } from './generated/bindings.js';
import { makeSlots, registerInterface, slotsOf } from './webidl.js';

const headersOf = (o) => slotsOf(o, 'Headers');
export const isHeaders = (o) => headersOf(o) !== undefined;
registerInterface('Headers', isHeaders);

// The guards, by the code the engine names each with (headers.rs `GUARD_*`).
const GUARDS = ['none', 'request', 'request-no-cors', 'response', 'immutable'];
// …how `headersCopy` copies: the list, the list filled again through the guard, the names alone.
const COPY_LIST = 0, COPY_REFILL = 1, COPY_NAMES = 2;
// …and what a write came to (headers.rs `WRITTEN` …): done — or dropped, as a guard drops a forbidden header — or
// refused, with Chrome's message.
const REFUSALS = [null, 'Invalid name', 'Invalid value', 'Headers are immutable'];
function written(outcome, prefix) {
  if (outcome !== 0) throw new TypeError(prefix + REFUSALS[outcome]);
}

export class Headers {
  constructor(init) {
    construct(this, convertHeadersArguments(arguments)[0], 'none', "Failed to construct 'Headers': ");
    // (…made from another Headers, whose entries its iterator gives lowercased: each name the one the source gave it)
    if (isHeaders(init)) globalThis.__dom.headersCopy(headersOf(init).list, headersOf(this).list, COPY_NAMES);
  }
}
// Its slots: the engine's list, and the list sorted and combined (`headerPairs`) until it next changes. A Headers of
// `init`, a HeadersInit, filled under `guard`, its messages after `prefix`.
function construct(o, init, guard, prefix) {
  makeSlots(o, 'Headers', { list: new globalThis.__dom.HeadersBase(GUARDS.indexOf(guard)), sorted: null });
  fill(o, init, prefix);
  return o;
}
// Fetch "fill": each pair of a sequence of exactly two, or each of a record's, appended.
function fill(o, init, prefix) {
  if (init === undefined) return;
  for (const pair of init) {
    if (pair.length !== 2) throw new TypeError(prefix + 'Invalid value');
    append(o, pair[0], pair[1], prefix);
  }
}
function append(o, name, value, prefix) {
  const s = headersOf(o);
  s.sorted = null;
  written(globalThis.__dom.headersAppend(s.list, name, value), prefix);
}
// Fetch "sort and combine": the header list sorted by name, a `set-cookie` value each its own pair, in the order they
// were appended. An iteration reads it again at every step, so a change during one shifts what the next step yields —
// sorted again only once it has changed.
export function headerPairs(h) {
  const s = headersOf(h);
  if (s.sorted === null) {
    const flat = globalThis.__dom.headersPairs(s.list);
    s.sorted = [];
    for (let i = 0; i < flat.length; i += 2) s.sorted.push([flat[i], flat[i + 1]]);
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
    written(globalThis.__dom.headersDelete(s.list, name), prefixOf('delete'));
  },
  get: (h, name) => named(globalThis.__dom.headersGet(headersOf(h).list, name), 'get'),
  getSetCookie: (h) => globalThis.__dom.headersSetCookies(headersOf(h).list),
  has: (h, name) => named(globalThis.__dom.headersHas(headersOf(h).list, name), 'has'),
  set(h, name, value) {
    const s = headersOf(h);
    s.sorted = null;
    written(globalThis.__dom.headersSet(s.list, name, value), prefixOf('set'));
  },
  pairs: headerPairs
});

// A header's value — the values of a lowercased `key`, combined — or null: Headers' `get`, which the driver's own reads
// take here rather than through a method a page may have replaced.
export function getHeader(h, key) {
  return globalThis.__dom.headersGet(headersOf(h).list, key) ?? null;
}
// Fetch "append" to a Headers (its guard checked): what a Request's body adds — its Content-Type.
export function appendHeader(h, name, value) {
  append(h, name, value, '');
}

// A Headers a Request or a Response makes, its guard set before `init` (a HeadersInit its RequestInit / ResponseInit
// converted, or undefined) fills it — so the guard drops a forbidden header `init` gives too; `prefix` its caller's.
export function createHeaders(init, guard, prefix) {
  return construct(Object.create(Headers.prototype), init, guard, prefix);
}
// A Headers made from another's header list (the Request constructor's "copy of input's header list", a Response's
// given one) — not read through an iterator a page may have replaced — filtered through `guard` where `refill` (a
// non-empty init "empties this's headers and fills it" with them).
export function copyHeaders(source, guard, refill) {
  const h = construct(Object.create(Headers.prototype), undefined, guard, '');
  globalThis.__dom.headersCopy(headersOf(source).list, headersOf(h).list, refill ? COPY_REFILL : COPY_LIST);
  return h;
}
// A response's Headers from the network's header map, immutable: the values verbatim (headers.rs `from_network`).
export function networkHeaders(raw) {
  const h = construct(Object.create(Headers.prototype), undefined, 'immutable', '');
  if (raw) {
    const flat = [];
    for (const name of Object.keys(raw)) flat.push(name, String(raw[name]));
    globalThis.__dom.headersFromNetwork(headersOf(h).list, flat, false);
  }
  return h;
}
export const headersGuard = (h) => GUARDS[globalThis.__dom.headersGuard(headersOf(h).list)];
export function setHeadersGuard(h, guard) {
  globalThis.__dom.headersGuard(headersOf(h).list, GUARDS.indexOf(guard));
}
// The header list as it goes ON THE WIRE: in the order the headers were appended, each by the name it was first given
// (the author's casing — request-headers-case), not the lowercased, sorted view a script reads.
export function wireEntries(h) {
  const flat = globalThis.__dom.headersWire(headersOf(h).list);
  const out = [];
  for (let i = 0; i < flat.length; i += 2) out.push([flat[i], flat[i + 1]]);
  return out;
}

// A response's header list as XMLHttpRequest exposes it, from the network's header map: a basic filtered response's,
// its cookies left out — and what reads it: a name's values combined (null for none, or for a name that is no header
// name), and getAllResponseHeaders()'s text.
export function filteredHeaderList(raw) {
  const list = new globalThis.__dom.HeadersBase(0);
  const flat = [];
  for (const name of Object.keys(raw || {})) flat.push(name, String(raw[name]));
  globalThis.__dom.headersFromNetwork(list, flat, true);
  return list;
}
export const headerListGet = (list, name) => (list && globalThis.__dom.headersGet(list, name)) ?? null;
export const headerListText = (list) => (list ? globalThis.__dom.headersForXhr(list) : '');
// …and its author request headers: a list under the "request" guard, which drops a forbidden request-header — written
// as Headers' append and set are (what they came to: `HEADER_WRITTEN` …) — and sent as `{name: value}`, the names as
// first given, in the order appended.
export const HEADER_WRITTEN = 0, HEADER_BAD_NAME = 1, HEADER_BAD_VALUE = 2;
export const requestHeaderList = () => new globalThis.__dom.HeadersBase(GUARDS.indexOf('request'));
export const headerListAppend = (list, name, value) => globalThis.__dom.headersAppend(list, name, value);
export const headerListSet = (list, name, value) => globalThis.__dom.headersSet(list, name, value);
export function headerListObject(list) {
  const flat = globalThis.__dom.headersWire(list);
  const out = {};
  for (let i = 0; i < flat.length; i += 2) out[flat[i]] = flat[i + 1];
  return out;
}

globalThis.Headers = Headers;
