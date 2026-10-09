// Cache Storage API — `caches` (CacheStorage) + `Cache`, a WindowOrWorkerGlobalScope
// member so it's reachable from the main window realm AND every worker / service-worker
// isolate (all built from this same snapshot). The store lives Ruby-side (Driver-owned,
// origin-partitioned) so it survives the per-visit VM rebuild and is shared between a
// service worker and the client it controls (they share an origin key). The spec's
// request-matching algorithm (URL equality, ignoreSearch, Vary) runs here in JS over
// lightweight per-entry metadata; only a matched entry's response body crosses back.
// Same Ruby-backed shape as Web Storage (see storage.js).
import { serializeResponseWire, responseFromWire } from './response-wire.js';
import { getHeader, headerPairs, setHeadersGuard } from './headers.js';
import { Request, bodyUnusable, fetch, requestOf, responseBytes, responseOf } from './fetch.js';
import { URL } from './url.js';
import { installCache, installCacheStorage } from './generated/bindings.js';
import {
  IntrinsicPromise,
  PLATFORM,
  constructedBy,
  makeSlots,
  promiseThen,
  registerInterface,
  rejectedPromise,
  resolvedPromise,
  slotsOf
} from './webidl.js';

// A promise of every value `promises` settle to, in order, or the first rejection — Promise.all's, by the intrinsics.
function whenAll(promises) {
  return new IntrinsicPromise((resolve, reject) => {
    const values = new Array(promises.length);
    let left = promises.length;
    if (left === 0) resolve(values);
    promises.forEach((p, i) => {
      promiseThen.call(p, (v) => {
        values[i] = v;
        if (--left === 0) resolve(values);
      }, reject);
    });
  });
}

// The origin key partitioning the store — the same token BroadcastChannel scopes to (a
// tuple origin string, or a stable per-realm opaque token, so `storageDenied` can tell an
// opaque origin apart). Unconditionally installed by platform-globals.js in this snapshot;
// a worker inherits its spawner's key, so a service worker and its client share a partition.
function originKey() {
  return globalThis.__csimBcOriginKey();
}

// An opaque origin (a sandboxed-without-allow-same-origin iframe, a data: context) has no
// storage key, so every CacheStorage operation is denied with a SecurityError. Returns the
// error to reject with, or null when storage is allowed.
function storageDenied() {
  return String(originKey()).startsWith('opaque:')
    ? new globalThis.DOMException('The operation is insecure.', 'SecurityError')
    : null;
}

// A Cache method's `request` — a RequestInfo, which the bindings convert — as the request the algorithms read: a
// Request's own (any realm's, by its slots: the redirected-response tests fetch via frame.contentWindow.fetch, then
// cache in the top page), never what a page's own property on the object says; a URL string's a new Request's (a
// TypeError where it is none).
const requestSlots = (request) => requestOf(typeof request === 'string' ? new Request(request) : request);

// A URL with its fragment removed (Cache keys ignore fragments); ignoreSearch additionally drops the query. A request's
// URL, which always parses.
function cacheKeyURL(url, ignoreSearch) {
  const u = new URL(url);
  u.hash = '';
  if (ignoreSearch) u.search = '';
  return u.href;
}

// A header list flattened to a lowercase-keyed plain object.
const headersObject = (headers) => Object.fromEntries(headerPairs(headers));

// Vary matching (Cache "Query Cache"): for each field named in the cached response's Vary
// header, the query request and the cached request must agree; `Vary: *` never matches.
function varyMatches(vary, reqHeaders, cachedHeaders) {
  const fields = String(vary).split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  for (const f of fields) {
    if (f === '*') return false;
    if ((reqHeaders[f] || '') !== (cachedHeaders[f] || '')) return false;
  }
  return true;
}

// Query Cache: the metadata of entries matching a request of `url` and `reqHeaders` (lowercase-keyed) under `options`,
// in stored order. `entries` is the list Ruby returns ([{id, url, method, headers, vary}]).
function queryCache(url, reqHeaders, options, entries) {
  const qURL = cacheKeyURL(url, options.ignoreSearch);
  const out = [];
  for (const e of entries) {
    if (cacheKeyURL(e.url, options.ignoreSearch) !== qURL) continue;
    if (options.ignoreVary || !e.vary || varyMatches(e.vary, reqHeaders, e.headers || {})) out.push(e);
  }
  return out;
}

// Reconstruct a stored request from its metadata, restoring the navigation fields the public
// Request ctor can't carry (mode 'navigate' + destination / reload / history) so a cached
// navigation request survives keys() intact (cache-keys-attributes-for-service-worker). Its
// headers are immutable (§5.4.7: "a new associated Headers object whose guard is 'immutable'").
function requestFromMeta(e) {
  const r = new Request(e.url, {method: e.method, headers: e.headers || {}});
  const s = requestOf(r);
  if (e.mode === 'navigate') s.mode = 'navigate';
  if (e.destination)         s.destination = e.destination;
  if (e.isReloadNavigation)  s.isReloadNavigation = true;
  if (e.isHistoryNavigation) s.isHistoryNavigation = true;
  setHeadersGuard(s.headers, 'immutable');
  return r;
}

// The metadata list for a cache (parsed), or null if the cache is gone. Keyed by the
// numeric cache id a Cache handle carries (not its name — a name can be re-mapped, but a
// handle stays bound to the storage it opened).
function readEntries(cacheId) {
  const json = globalThis.__csim_cacheEntries(originKey(), cacheId);
  return json == null ? null : JSON.parse(json);
}

// Whether a Vary header value names the `*` field (uncacheable).
function varyHasStar(vary) {
  return !!vary && vary.split(',').some(s => s.trim() === '*');
}

// Batch Cache Operations duplicate detection for addAll: two entries collide when they share
// a cache-key URL and either one's request satisfies the OTHER's response Vary (the match is
// asymmetric — each response's Vary decides which request headers are compared). `entries` is
// [{url, headers, vary}]. Order-independent, matching the spec's reject-in-either-order.
function batchHasDuplicate(entries) {
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i], b = entries[j];
      if (cacheKeyURL(a.url, false) !== cacheKeyURL(b.url, false)) continue;
      const aMatchesB = !b.vary || varyMatches(b.vary, a.headers, b.headers);
      const bMatchesA = !a.vary || varyMatches(a.vary, b.headers, a.headers);
      if (aMatchesB || bMatchesA) return true;
    }
  }
  return false;
}

// A cache's slots: the numeric id of the storage it opened (not its name — a name can be re-mapped, but a handle stays
// bound to the storage it opened).
const cacheOf = (o) => slotsOf(o, 'Cache');
registerInterface('Cache', (o) => cacheOf(o) !== undefined);
class Cache {
  constructor(token, id) {
    constructedBy(PLATFORM, token, 'Cache');
    makeSlots(this, 'Cache', { id });
  }
}
const newCache = (id) => new Cache(PLATFORM, id);

// The entries of the cache `id` that the request `req` (its slots) under `options` selects, in stored order. No request
// means every entry (matchAll / keys allow it); a non-GET request without ignoreMethod matches nothing — null, so the
// caller resolves its own empty value. Shared by match / matchAll / keys / delete, and CacheStorage's match.
function selectEntries(id, req, options) {
  const entries = readEntries(id) || [];
  if (req === undefined) return entries;
  if (req.method !== 'GET' && !options.ignoreMethod) return null;
  return queryCache(req.url, headersObject(req.headers), options, entries);
}

// The first entry of the cache `id` the request selects, as a Response — undefined where none is.
function firstMatch(id, req, options) {
  const matched = selectEntries(id, req, options);
  return matched && matched.length ? responseFor(id, matched[0].id) : undefined;
}

// The stored Response of the entry `entryId` of the cache `id` (null if it vanished).
function responseFor(id, entryId) {
  const json = globalThis.__csim_cacheEntryResponse(originKey(), id, entryId);
  return json == null ? null : responseFromWire(JSON.parse(json));
}

// A cache key must be an http(s) GET request (its slots); otherwise `op` is a TypeError.
function checkHttpGet(req, op) {
  const scheme = new URL(req.url).protocol.slice(0, -1);
  if (scheme !== 'http' && scheme !== 'https') {
    throw new TypeError("Failed to execute '" + op + "' on 'Cache': Request scheme '" + scheme + "' is unsupported");
  }
  if (req.method !== 'GET') {
    throw new TypeError("Failed to execute '" + op + "' on 'Cache': Request method '" + req.method + "' is unsupported");
  }
}

// An operation's promise: what `fn` returns, or its error a rejection — a promise of the realm's own.
function promised(fn) {
  try {
    return resolvedPromise(fn());
  } catch (e) {
    return rejectedPromise(e);
  }
}

// An entry to store: the request `req` (its slots) and the Response `response` whose body is `bytes`, with its Vary.
// A navigation request's mode / destination / reload / history flags are part of the stored request and must survive
// keys() (only carried for navigations — an ordinary cache entry stays lean).
function entryOf(req, response, bytes, vary) {
  const meta = {url: req.url, method: req.method, headers: headersObject(req.headers), vary};
  if (req.mode === 'navigate') {
    meta.mode                = 'navigate';
    meta.destination         = req.destination;
    meta.isReloadNavigation  = req.isReloadNavigation;
    meta.isHistoryNavigation = req.isHistoryNavigation;
  }
  return {meta, response: JSON.stringify(serializeResponseWire(response, bytes))};
}

// Batch Cache Operations' "put" of each entry into the cache `id`, at once — every body already read, so none of them
// is stored where one fails: each replaces the entries its request + Vary matches.
function storeEntries(id, entries) {
  for (const {meta, response} of entries) {
    const deleteIds = queryCache(meta.url, meta.headers, {}, readEntries(id) || []).map(e => e.id);
    globalThis.__csim_cachePut(originKey(), id, JSON.stringify(deleteIds), JSON.stringify(meta), response);
  }
}

// What `response` (its slots) may not be to be cached: a partial one, or one whose Vary names `*` — a TypeError of `op`.
// Its Vary otherwise.
function cacheableVary(rs, op) {
  if (rs.status === 206) throw new TypeError("Failed to execute '" + op + "' on 'Cache': Partial response (status code 206) is unsupported");
  const vary = getHeader(rs.headers, 'vary') || '';
  if (varyHasStar(vary)) throw new TypeError("Failed to execute '" + op + "' on 'Cache': Vary header contains *");
  return vary;
}

// Cache's addAll (and add, of one), §5.4.4: every Request given an http(s) GET one, then each a new Request fetched,
// each response an ok, non-partial one with no `Vary: *`, every body read — and the batch stored only once all are,
// with no two entries colliding (an InvalidStateError, nothing stored).
function addAll(id, requests, op) {
  return promised(() => {
    for (const r of requests) if (typeof r !== 'string') checkHttpGet(requestOf(r), op);
    const reqs = requests.map((r) => new Request(r));
    for (const r of reqs) checkHttpGet(requestOf(r), op);
    const fetched = reqs.map((r) => promiseThen.call(fetch(r), (resp) => {
      const rs = responseOf(resp);
      if (rs.type === 'error' || rs.status < 200 || rs.status > 299) {
        throw new TypeError("Failed to execute '" + op + "' on 'Cache': Request failed");
      }
      const vary = cacheableVary(rs, op);
      return promiseThen.call(responseBytes(resp), (bytes) => entryOf(requestOf(r), resp, bytes, vary));
    }));
    return promiseThen.call(whenAll(fetched), (entries) => {
      if (batchHasDuplicate(entries.map((e) => e.meta))) {
        throw new globalThis.DOMException('duplicate requests in addAll', 'InvalidStateError');
      }
      storeEntries(id, entries);
    });
  });
}

// Cache (Service Workers §5.4), generated from its IDL — made by the platform alone, a CacheStorage's `open`. The
// bindings convert a RequestInfo and the query options; every step reads a Request's and a Response's own state (their
// slots); the lists resolved are frozen (FrozenArray — Chrome resolves unfrozen ones).
installCache(Cache, {
  match: (cache, request, options) => promised(() => firstMatch(cacheOf(cache).id, requestSlots(request), options)),

  matchAll(cache, request, options) {
    return promised(() => {
      const id = cacheOf(cache).id;
      const req = request === undefined ? undefined : requestSlots(request);
      return Object.freeze((selectEntries(id, req, options) || []).map(e => responseFor(id, e.id)).filter(Boolean));
    });
  },

  add: (cache, request) => addAll(cacheOf(cache).id, [request], 'add'),

  addAll: (cache, requests) => addAll(cacheOf(cache).id, requests, 'addAll'),

  // §5.4.5: an http(s) GET request, a cacheable response whose body is neither disturbed nor locked — its body read,
  // then stored.
  put(cache, request, response) {
    return promised(() => {
      const req = requestSlots(request);
      checkHttpGet(req, 'put');
      const rs = responseOf(response);
      const vary = cacheableVary(rs, 'put');
      if (bodyUnusable(rs)) throw new TypeError("Failed to execute 'put' on 'Cache': Response body is already used");
      const id = cacheOf(cache).id;
      return promiseThen.call(responseBytes(response), (bytes) => storeEntries(id, [entryOf(req, response, bytes, vary)]));
    });
  },

  delete(cache, request, options) {
    return promised(() => {
      const id = cacheOf(cache).id;
      const ids = (selectEntries(id, requestSlots(request), options) || []).map(e => e.id);
      return ids.length > 0 && globalThis.__csim_cacheDeleteEntries(originKey(), id, JSON.stringify(ids)) > 0;
    });
  },

  keys(cache, request, options) {
    return promised(() => {
      const req = request === undefined ? undefined : requestSlots(request);
      return Object.freeze((selectEntries(cacheOf(cache).id, req, options) || []).map(requestFromMeta));
    });
  }
});

// CacheStorage (Service Workers §5.5), generated from its IDL — made by the platform alone, a global's `caches`. An
// opaque origin's every operation is a SecurityError (`storageDenied`).
registerInterface('CacheStorage', (o) => slotsOf(o, 'CacheStorage') !== undefined);
class CacheStorage {
  constructor(token) {
    constructedBy(PLATFORM, token, 'CacheStorage');
    makeSlots(this, 'CacheStorage');
  }
}
// A cache's name as the store keeps it: its JSON string, which holds a DOMString's lone surrogate as an escape — a name
// is a DOMString, not a USVString, and no two names are one in the store's UTF-8.
const storedName = (name) => JSON.stringify(name);
const storedNames = (key) => Array.from(globalThis.__csim_cacheStorageKeys(key) || []);

// (…what an operation answers once storage is allowed)
function stored(fn) {
  return promised(() => {
    const denied = storageDenied();
    if (denied) throw denied;
    return fn(originKey());
  });
}
installCacheStorage(CacheStorage, {
  // Search a named cache only when it exists (never create one here), else every cache in creation order — resolve
  // with the first match. The request is converted once, at the first cache searched.
  match(storage, request, options) {
    return stored((key) => {
      const all = storedNames(key);
      const names = options.cacheName !== undefined ? all.filter(n => n === storedName(options.cacheName)) : all;
      let req;
      for (const name of names) {
        req ??= requestSlots(request);
        const found = firstMatch(globalThis.__csim_cacheStorageOpen(key, name), req, options);
        if (found !== undefined) return found;
      }
      return undefined;
    });
  },

  has: (storage, name) => stored((key) => !!globalThis.__csim_cacheStorageHas(key, storedName(name))),

  // The numeric cache id (the cache created if the name is unmapped), which the Cache binds to — so it survives a
  // later delete + re-open of the same name.
  open: (storage, name) => stored((key) => newCache(globalThis.__csim_cacheStorageOpen(key, storedName(name)))),

  delete: (storage, name) => stored((key) => !!globalThis.__csim_cacheStorageDelete(key, storedName(name))),

  keys: (storage) => stored((key) => storedNames(key).map((name) => JSON.parse(name)))
});

globalThis.Cache        = Cache;
globalThis.CacheStorage = CacheStorage;
// WindowOrWorkerGlobalScope's `caches` (window.js, and a worker's scope).
export const caches = new CacheStorage(PLATFORM);
