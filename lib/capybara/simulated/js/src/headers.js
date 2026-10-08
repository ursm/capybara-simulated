// Headers (Fetch Standard), generated from its IDL: the value type `fetch` / `Request` / `Response` consume. A Headers
// is its header list — the values of a name combined, but `set-cookie`'s, which stay one per header — the name each
// header was first given (the casing it goes on the wire in), and its guard, which `fetch` / `Request` / `Response`
// set: what a script may write to it.
import { FORBIDDEN_RESPONSE_HEADERS, isForbiddenRequestHeader } from './header-rules.js';
import { convertHeadersArguments, installHeaders } from './generated/bindings.js';
import { makeSlots, registerInterface, slotsOf } from './webidl.js';

const headersOf = (o) => slotsOf(o, 'Headers');
registerInterface('Headers', (o) => headersOf(o) !== undefined);

// An HTTP header NAME is a non-empty token (RFC 9110 / Fetch); a VALUE has no leading or trailing HTTP whitespace (tab,
// LF, CR, space) — normalized away — and no NUL, CR or LF (a mid-value newline is a smuggling vector). Chrome's messages.
const HTTP_TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
function headerName(name, prefix) {
  if (!HTTP_TOKEN_RE.test(name)) throw new TypeError(prefix + 'Invalid name');
  return name.toLowerCase();
}
function headerValue(value, prefix) {
  const s = value.replace(/^[\t\n\r ]+|[\t\n\r ]+$/g, '');
  if (/[\0\r\n]/.test(s)) throw new TypeError(prefix + 'Invalid value');
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
// Fetch "no-cors-safelisted request-header" (name, value): the only headers a `no-cors` request's Headers (guard
// "request-no-cors") accepts.
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
// Whether the guard forbids writing `name` as `prospectiveValue`: 'immutable' throws; 'request' drops a forbidden
// request-header, 'request-no-cors' anything not no-cors-safelisted, 'response' a forbidden response-header; 'none'
// (a Headers a script made) allows all.
function guardForbids(s, name, prospectiveValue, prefix) {
  switch (s.guard) {
    case 'immutable':       throw new TypeError(prefix + 'Headers are immutable');
    case 'request':         return isForbiddenRequestHeader(name, prospectiveValue);
    case 'request-no-cors': return !isNoCorsSafelisted(name, prospectiveValue);
    case 'response':        return FORBIDDEN_RESPONSE_HEADERS.has(name);
    default:                return false;
  }
}

export class Headers {
  constructor(init) {
    construct(this, init, convertHeadersArguments(arguments)[0], 'none', "Failed to construct 'Headers': ");
  }
}
// A Headers of `init`, converted as a HeadersInit from `source`, its fill's messages after `prefix`. A Headers `source`
// carries the names its headers were first given: they are the wire's, where its entries — read through its iterator,
// as any iterable's — are lowercased. (Only names of keys `init` appends are ever read.)
function construct(o, source, init, guard, prefix) {
  // `list`: a name's combined value, by its lowercased name; `names`: the name it was first given; `setCookie`: each
  // `set-cookie` value, which are never combined (fetch's "Headers" special case).
  const s = makeSlots(o, 'Headers', { list: new Map(), names: new Map(), setCookie: [], guard });
  const from = headersOf(source);
  if (from !== undefined) for (const [key, name] of from.names) s.names.set(key, name);
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
// The guard is checked against the value AS IT WOULD BE after appending (the combined string) — a no-cors append that
// overflows 128 bytes is dropped. The first name a key is given is the one kept, by `set` too (Fetch "set" keeps the
// existing header's name).
function append(o, name, value, prefix) {
  const s = headersOf(o);
  const key = headerName(name, prefix);
  const val = headerValue(value, prefix);
  if (key === 'set-cookie') {
    if (!guardForbids(s, key, val, prefix)) s.setCookie.push(val);
    return;
  }
  const prev = s.list.get(key);
  const combined = prev === undefined ? val : prev + ', ' + val;
  if (guardForbids(s, key, combined, prefix)) return;
  s.list.set(key, combined);
  if (!s.names.has(key)) s.names.set(key, name);
}
// Fetch "sort and combine": the header list sorted by name, a `set-cookie` value each its own pair, in the order they
// were appended (the sort is stable). An iteration reads it again at every step, so a change during one shifts what
// the next step yields.
function sortedPairs(o) {
  const s = headersOf(o);
  const pairs = [...s.list];
  for (const c of s.setCookie) pairs.push(['set-cookie', c]);
  return pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}
const prefixOf = (member) => `Failed to execute '${member}' on 'Headers': `;
installHeaders(Headers, {
  append(h, name, value) { append(h, name, value, prefixOf('append')); },
  delete(h, name) {
    const s = headersOf(h);
    const prefix = prefixOf('delete');
    const key = headerName(name, prefix);
    if (key === 'set-cookie') {
      if (!guardForbids(s, key, s.setCookie[0] ?? '', prefix)) s.setCookie = [];
      return;
    }
    if (guardForbids(s, key, s.list.get(key) ?? '', prefix)) return;
    s.list.delete(key);
    s.names.delete(key);
  },
  get(h, name) {
    const s = headersOf(h);
    const key = headerName(name, prefixOf('get'));
    if (key === 'set-cookie') return s.setCookie.length ? s.setCookie.join(', ') : null;
    return s.list.get(key) ?? null;
  },
  getSetCookie: (h) => headersOf(h).setCookie.slice(),
  has(h, name) {
    const s = headersOf(h);
    const key = headerName(name, prefixOf('has'));
    return key === 'set-cookie' ? s.setCookie.length > 0 : s.list.has(key);
  },
  set(h, name, value) {
    const s = headersOf(h);
    const prefix = prefixOf('set');
    const key = headerName(name, prefix);
    const val = headerValue(value, prefix);
    if (guardForbids(s, key, val, prefix)) return;
    if (key === 'set-cookie') {
      s.setCookie = [val];
      return;
    }
    s.list.set(key, val);
    if (!s.names.has(key)) s.names.set(key, name);
  },
  pairs: sortedPairs
});

// A Headers `fetch` / `Request` makes, its guard set before `init` fills it — so the guard drops a forbidden header
// `init` gives too. (`init` is converted as the Headers constructor's argument is, until RequestInit is converted by a
// binding of its own; `prefix` is the caller's.)
export function createHeaders(init, guard, prefix) {
  return construct(Object.create(Headers.prototype), init, convertHeadersArguments([init])[0], guard, prefix);
}
// A response's Headers from the network's header map, immutable: lowercased names, the values VERBATIM. The HTTP stack
// already stripped each field's whitespace before it combined duplicates with ", ", so running the value's
// normalization again on the COMBINED string would corrupt one whose last part is empty — two empty `double-trouble`
// headers combine to ", ", which the trailing strip would cut to "," (header-value-combining).
export function networkHeaders(raw) {
  const h = construct(Object.create(Headers.prototype), undefined, undefined, 'immutable', '');
  const s = headersOf(h);
  if (raw) for (const name of Object.keys(raw)) {
    const key = name.toLowerCase();
    if (key === 'set-cookie') {
      s.setCookie.push(String(raw[name]));
    } else {
      s.list.set(key, String(raw[name]));
      if (!s.names.has(key)) s.names.set(key, name);
    }
  }
  return h;
}
export const headersGuard = (h) => headersOf(h).guard;
export function setHeadersGuard(h, guard) {
  headersOf(h).guard = guard;
}
// The header list as it goes ON THE WIRE: in the order the headers were appended, each by the name it was first given
// (the author's casing — request-headers-case), not the lowercased, sorted view a script reads.
export function wireEntries(h) {
  const s = headersOf(h);
  const out = [];
  for (const [key, value] of s.list) out.push([s.names.get(key) ?? key, value]);
  for (const c of s.setCookie) out.push(['set-cookie', c]);
  return out;
}

globalThis.Headers = Headers;
