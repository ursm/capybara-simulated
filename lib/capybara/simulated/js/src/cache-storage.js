// Cache Storage API — `caches` (CacheStorage) + `Cache`, a WindowOrWorkerGlobalScope
// member so it's reachable from the main window realm AND every worker / service-worker
// isolate (all built from this same snapshot). The store lives Ruby-side (Driver-owned,
// origin-partitioned) so it survives the per-visit VM rebuild and is shared between a
// service worker and the client it controls (they share an origin key). The spec's
// request-matching algorithm (URL equality, ignoreSearch, Vary) runs here in JS over
// lightweight per-entry metadata; only a matched entry's response body crosses back.
// Same Ruby-backed shape as Web Storage (see storage.js).
import { serializeResponseWire, responseFromWire } from './response-wire.js';
import { getHeader, headerPairs, isHeaders } from './headers.js';
import { Request, fetch, requestOf, responseBytes } from './fetch.js';
import { installCache, installCacheStorage } from './generated/bindings.js';
import {
  PLATFORM,
  constructedBy,
  makeSlots,
  registerInterface,
  rejectedPromise,
  resolvedPromise,
  slotsOf
} from './webidl.js';

// The realm's own promise steps, not ones a page put in their place.
const promiseThen = Promise.prototype.then;
const promiseAll = Promise.all.bind(Promise);

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

// A Cache method's `request` — a RequestInfo, which the bindings convert: a Request (any realm's, told by its slots: the
// redirected-response tests fetch via frame.contentWindow.fetch, then cache in the top page) as it is, a URL string a
// new Request of it (a TypeError where it is none).
function toRequest(request) {
  return requestOf(request) !== undefined ? request : new Request(request);
}

// A URL with its fragment removed (Cache keys ignore fragments); ignoreSearch additionally
// drops the query. Falls back to plain truncation for an unparseable URL.
function cacheKeyURL(url, ignoreSearch) {
  try {
    const u = new globalThis.URL(url);
    u.hash = '';
    if (ignoreSearch) u.search = '';
    return u.href;
  } catch (_) {
    const noFrag = url.indexOf('#') < 0 ? url : url.slice(0, url.indexOf('#'));
    if (!ignoreSearch) return noFrag;
    const q = noFrag.indexOf('?');
    return q < 0 ? noFrag : noFrag.slice(0, q);
  }
}

// A Headers (its slots) or a plain object flattened to a lowercase-keyed plain object.
function headersObject(headers) {
  if (isHeaders(headers)) return Object.fromEntries(headerPairs(headers));
  const o = {};
  if (headers && typeof headers === 'object') for (const k of Object.keys(headers)) o[k.toLowerCase()] = headers[k];
  return o;
}

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

// Query Cache: the metadata of entries matching `req` under `options`, in stored order.
// `entries` is the list Ruby returns ([{id, url, method, headers, vary}]).
function queryCache(req, options, entries) {
  const qURL       = cacheKeyURL(req.url, options.ignoreSearch);
  const reqHeaders = headersObject(req.headers);
  const out = [];
  for (const e of entries) {
    if (cacheKeyURL(e.url, options.ignoreSearch) !== qURL) continue;
    if (options.ignoreVary || !e.vary || varyMatches(e.vary, reqHeaders, e.headers || {})) out.push(e);
  }
  return out;
}

// Reconstruct a stored request from its metadata, restoring the navigation fields the public
// Request ctor can't carry (mode 'navigate' + destination / reload / history) so a cached
// navigation request survives keys() intact (cache-keys-attributes-for-service-worker).
function requestFromMeta(e) {
  const r = new Request(e.url, {method: e.method, headers: e.headers || {}});
  const s = requestOf(r);
  if (e.mode === 'navigate') s.mode = 'navigate';
  if (e.destination)         s.destination = e.destination;
  if (e.isReloadNavigation)  s.isReloadNavigation = true;
  if (e.isHistoryNavigation) s.isHistoryNavigation = true;
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

// The entries of the cache `id` that `request` under `options` selects, in stored order. An absent request means every
// entry (matchAll / keys allow it); a non-GET request without ignoreMethod matches nothing — null, so the caller
// resolves its own empty value. Shared by match / matchAll / keys / delete.
function selectEntries(id, request, options) {
  const entries = readEntries(id) || [];
  if (request === undefined) return entries;
  const req = toRequest(request);
  if (req.method !== 'GET' && !options.ignoreMethod) return null;
  return queryCache(req, options, entries);
}

// The stored Response of the entry `entryId` of the cache `id` (null if it vanished).
function responseFor(id, entryId) {
  const json = globalThis.__csim_cacheEntryResponse(originKey(), id, entryId);
  return json == null ? null : responseFromWire(JSON.parse(json));
}

// A cache key must be an http(s) GET request; otherwise `op` is a TypeError.
function checkHttpGet(req, op) {
  let scheme = '';
  try { scheme = new globalThis.URL(req.url).protocol.replace(/:$/, ''); } catch (_) {}
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

// Store `response` for `req` in the cache `id`: the response's body materialized (streams included; put disturbs the
// response per spec), then any entry this request + Vary matches replaced (Batch Cache Operations).
function storeEntry(id, req, response, vary) {
  return promiseThen.call(responseBytes(response), (bytes) => {
    const respJson = JSON.stringify(serializeResponseWire(response, bytes));
    const meta     = {url: req.url, method: req.method, headers: headersObject(req.headers), vary};
    // A navigation request's mode / destination / reload / history flags are part of the
    // stored request and must survive keys() (only carried for navigations — an ordinary
    // cache entry stays lean).
    if (req.mode === 'navigate') {
      meta.mode                = 'navigate';
      meta.destination         = req.destination;
      meta.isReloadNavigation  = req.isReloadNavigation;
      meta.isHistoryNavigation = req.isHistoryNavigation;
    }
    const deleteIds = queryCache(req, {}, readEntries(id) || []).map(e => e.id);
    globalThis.__csim_cachePut(originKey(), id, JSON.stringify(deleteIds), JSON.stringify(meta), respJson);
  });
}

// Cache's addAll (and add, of one): every request fetched, each response checked, and the batch stored only when all
// succeed and no two collide.
function addAll(id, requests, op) {
  return promised(() => {
    const reqs = requests.map(toRequest);
    for (const r of reqs) checkHttpGet(r, op);
    const fetched = reqs.map(r => promiseThen.call(fetch(r), (resp) => {
      if (resp.status === 206) throw new TypeError("Failed to execute '" + op + "' on 'Cache': Partial response (status code 206) is unsupported");
      if (!resp.ok)           throw new TypeError("Failed to execute '" + op + "' on 'Cache': Request failed");
      if (varyHasStar(getHeader(resp.headers, 'vary'))) throw new TypeError("Failed to execute '" + op + "' on 'Cache': Vary header contains *");
      return {req: r, resp};
    }));
    return promiseThen.call(promiseAll(fetched), (pairs) => {
      // The whole batch is rejected (nothing stored) if two entries would collide.
      const meta = pairs.map(p => ({url: p.req.url, headers: headersObject(p.req.headers), vary: getHeader(p.resp.headers, 'vary') || ''}));
      if (batchHasDuplicate(meta)) throw new globalThis.DOMException('duplicate requests in addAll', 'InvalidStateError');
      return promiseThen.call(promiseAll(pairs.map((p, i) => storeEntry(id, p.req, p.resp, meta[i].vary))), () => undefined);
    });
  });
}


// Cache (Service Workers §5.4), generated from its IDL — made by the platform alone, a CacheStorage's `open`. The
// bindings convert a RequestInfo and the query options; the lists resolved are frozen (FrozenArray).
installCache(Cache, {
  // match reconstructs ONLY the first match's Response.
  match(cache, request, options) {
    return promised(() => {
      const id = cacheOf(cache).id;
      const matched = selectEntries(id, request, options);
      return matched && matched.length ? responseFor(id, matched[0].id) : undefined;
    });
  },

  matchAll(cache, request, options) {
    return promised(() => {
      const id = cacheOf(cache).id;
      return Object.freeze((selectEntries(id, request, options) || []).map(e => responseFor(id, e.id)).filter(Boolean));
    });
  },

  add: (cache, request) => addAll(cacheOf(cache).id, [request], 'add'),

  addAll: (cache, requests) => addAll(cacheOf(cache).id, requests, 'addAll'),

  put(cache, request, response) {
    return promised(() => {
      const req = toRequest(request);
      checkHttpGet(req, 'put');
      if (response.status === 206) {
        throw new TypeError("Failed to execute 'put' on 'Cache': Partial response (status code 206) is unsupported");
      }
      const vary = getHeader(response.headers, 'vary') || '';
      if (varyHasStar(vary)) throw new TypeError("Failed to execute 'put' on 'Cache': Vary header contains *");
      if (response.bodyUsed) throw new TypeError("Failed to execute 'put' on 'Cache': Response body is already used");
      return storeEntry(cacheOf(cache).id, req, response, vary);
    });
  },

  delete(cache, request, options) {
    return promised(() => {
      const id = cacheOf(cache).id;
      const ids = (selectEntries(id, request, options) || []).map(e => e.id);
      return ids.length > 0 && globalThis.__csim_cacheDeleteEntries(originKey(), id, JSON.stringify(ids)) > 0;
    });
  },

  keys(cache, request, options) {
    return promised(() => Object.freeze((selectEntries(cacheOf(cache).id, request, options) || []).map(requestFromMeta)));
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
// is a DOMString, not a USVString, and no two names are one in the store's UTF-8 — and back.
const storedName = (name) => JSON.stringify(name);
const cacheNames = (key) => Array.from(globalThis.__csim_cacheStorageKeys(key) || [], (stored) => JSON.parse(stored));

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
  // with the first match.
  match(storage, request, options) {
    return stored((key) => {
      const all = cacheNames(key);
      const names = options.cacheName !== undefined ? all.filter(n => n === options.cacheName) : all;
      const next = (i) => {
        if (i >= names.length) return undefined;
        const id = globalThis.__csim_cacheStorageOpen(key, storedName(names[i]));
        const matched = selectEntries(id, request, options);
        return matched && matched.length ? responseFor(id, matched[0].id) : next(i + 1);
      };
      return next(0);
    });
  },

  has: (storage, name) => stored((key) => !!globalThis.__csim_cacheStorageHas(key, storedName(name))),

  // The numeric cache id (the cache created if the name is unmapped), which the Cache binds to — so it survives a
  // later delete + re-open of the same name.
  open: (storage, name) => stored((key) => newCache(globalThis.__csim_cacheStorageOpen(key, storedName(name)))),

  delete: (storage, name) => stored((key) => !!globalThis.__csim_cacheStorageDelete(key, storedName(name))),

  keys: (storage) => stored(cacheNames)
});

globalThis.Cache        = Cache;
globalThis.CacheStorage = CacheStorage;
// WindowOrWorkerGlobalScope's `caches` (window.js, and a worker's scope).
export const caches = new CacheStorage(PLATFORM);
