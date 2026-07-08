// Cache Storage API — `caches` (CacheStorage) + `Cache`, a WindowOrWorkerGlobalScope
// member so it's reachable from the main window realm AND every worker / service-worker
// isolate (all built from this same snapshot). The store lives Ruby-side (Driver-owned,
// origin-partitioned) so it survives the per-visit VM rebuild and is shared between a
// service worker and the client it controls (they share an origin key). The spec's
// request-matching algorithm (URL equality, ignoreSearch, Vary) runs here in JS over
// lightweight per-entry metadata; only a matched entry's response body crosses back.
// Same Ruby-backed shape as Web Storage (see storage.js).
import { serializeResponseWire, responseFromWire } from './response-wire.js';

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

// Coerce a Cache method's `request` argument (a Request or a URL string) to a Request.
function toRequest(request) {
  return request instanceof globalThis.Request ? request : new globalThis.Request(request);
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

// A Headers (or plain object) flattened to a lowercase-keyed plain object.
function headersObject(headers) {
  const o = {};
  if (headers && typeof headers.forEach === 'function') headers.forEach((v, k) => { o[k] = v; });
  else if (headers && typeof headers === 'object') for (const k of Object.keys(headers)) o[k.toLowerCase()] = headers[k];
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

class Cache {
  constructor(id) { this._id = id; }

  // Resolve `request`/`options` to the matched entry metadata (in stored order). A bare
  // `undefined` request means "every entry" (matchAll/keys allow it); a non-GET request
  // without ignoreMethod matches nothing → returns null so the caller resolves its own empty
  // value. Shared by match/matchAll/keys/delete.
  _select(request, options) {
    const entries = readEntries(this._id) || [];
    if (request === undefined) return entries;
    const req = toRequest(request);
    if (req.method !== 'GET' && !options.ignoreMethod) return null;
    return queryCache(req, options, entries);
  }

  // match requires a request (WebIDL); it reconstructs ONLY the first match's Response.
  match(request, options) {
    options = options || {};
    return new Promise((resolve, reject) => {
      if (request === undefined) { reject(new TypeError("Failed to execute 'match' on 'Cache': 1 argument required, but only 0 present.")); return; }
      try {
        const matched = this._select(request, options);
        resolve(matched && matched.length ? this._responseFor(matched[0].id) : undefined);
      } catch (e) { reject(e); }
    });
  }

  matchAll(request, options) {
    options = options || {};
    return new Promise((resolve, reject) => {
      try {
        resolve((this._select(request, options) || []).map(e => this._responseFor(e.id)).filter(Boolean));
      } catch (e) { reject(e); }
    });
  }

  add(request)      { return this.addAll([request]); }

  addAll(requests) {
    return new Promise((resolve, reject) => {
      let reqs;
      try { reqs = Array.from(requests).map(toRequest); } catch (e) { reject(e); return; }
      for (const r of reqs) {
        if (!this._isHttpGet(r, 'addAll', reject)) return;
      }
      Promise.all(reqs.map(r => globalThis.fetch(r).then(resp => {
        if (resp.status === 206) throw new TypeError("Failed to execute 'addAll' on 'Cache': Partial response (status code 206) is unsupported");
        if (!resp.ok)           throw new TypeError("Failed to execute 'addAll' on 'Cache': Request failed");
        if (varyHasStar(resp.headers.get('vary'))) throw new TypeError("Failed to execute 'addAll' on 'Cache': Vary header contains *");
        return {req: r, resp};
      })))
        .then(pairs => {
          // The whole batch is rejected (nothing stored) if two entries would collide.
          const meta = pairs.map(p => ({url: p.req.url, headers: headersObject(p.req.headers), vary: p.resp.headers.get('vary') || ''}));
          if (batchHasDuplicate(meta)) throw new globalThis.DOMException('duplicate requests in addAll', 'InvalidStateError');
          return Promise.all(pairs.map(p => this.put(p.req, p.resp)));
        })
        .then(() => resolve(undefined), reject);
    });
  }

  put(request, response) {
    return new Promise((resolve, reject) => {
      let req;
      try { req = toRequest(request); } catch (e) { reject(e); return; }
      if (!this._isHttpGet(req, 'put', reject)) return;
      if (!(response instanceof globalThis.Response)) {
        reject(new TypeError("Failed to execute 'put' on 'Cache': parameter 2 is not of type 'Response'.")); return;
      }
      if (response.status === 206) {
        reject(new TypeError("Failed to execute 'put' on 'Cache': Partial response (status code 206) is unsupported")); return;
      }
      const vary = response.headers.get('vary') || '';
      if (varyHasStar(vary)) {
        reject(new TypeError("Failed to execute 'put' on 'Cache': Vary header contains *")); return;
      }
      if (response.bodyUsed) {
        reject(new TypeError("Failed to execute 'put' on 'Cache': Response body is already used")); return;
      }
      // Materialize the response body (streams included; put disturbs the response per spec),
      // then replace any existing entry this request+Vary matches (Batch Cache Operations).
      response.arrayBuffer().then(buf => {
        const respJson  = JSON.stringify(serializeResponseWire(response, new globalThis.Uint8Array(buf)));
        const meta      = {url: req.url, method: req.method, headers: headersObject(req.headers), vary};
        const deleteIds = queryCache(req, {}, readEntries(this._id) || []).map(e => e.id);
        globalThis.__csim_cachePut(originKey(), this._id, JSON.stringify(deleteIds), JSON.stringify(meta), respJson);
        resolve(undefined);
      }, reject);
    });
  }

  delete(request, options) {
    options = options || {};
    return new Promise((resolve, reject) => {
      if (request === undefined) { reject(new TypeError("Failed to execute 'delete' on 'Cache': 1 argument required, but only 0 present.")); return; }
      try {
        const ids = (this._select(request, options) || []).map(e => e.id);
        if (!ids.length) { resolve(false); return; }
        resolve(globalThis.__csim_cacheDeleteEntries(originKey(), this._id, JSON.stringify(ids)) > 0);
      } catch (e) { reject(e); }
    });
  }

  keys(request, options) {
    options = options || {};
    return new Promise((resolve, reject) => {
      try {
        resolve((this._select(request, options) || []).map(e => new globalThis.Request(e.url, {method: e.method, headers: e.headers || {}})));
      } catch (e) { reject(e); }
    });
  }

  // Reconstruct the stored Response for a matched entry id (null if it vanished).
  _responseFor(id) {
    const json = globalThis.__csim_cacheEntryResponse(originKey(), this._id, id);
    return json == null ? null : responseFromWire(JSON.parse(json));
  }

  // A cache key must be an http(s) GET request; otherwise `op` rejects with a TypeError.
  // Returns false (and rejects) when it isn't.
  _isHttpGet(req, op, reject) {
    let scheme = '';
    try { scheme = new globalThis.URL(req.url).protocol.replace(/:$/, ''); } catch (_) {}
    if (scheme !== 'http' && scheme !== 'https') {
      reject(new TypeError("Failed to execute '" + op + "' on 'Cache': Request scheme '" + scheme + "' is unsupported"));
      return false;
    }
    if (req.method !== 'GET') {
      reject(new TypeError("Failed to execute '" + op + "' on 'Cache': Request method '" + req.method + "' is unsupported"));
      return false;
    }
    return true;
  }
}

class CacheStorage {
  open(name) {
    const d = storageDenied(); if (d) return Promise.reject(d);
    if (name === undefined) return Promise.reject(new TypeError("Failed to execute 'open' on 'CacheStorage': 1 argument required, but only 0 present."));
    // Returns the numeric cache id (creating the cache if the name is unmapped); the Cache
    // handle binds to that id, so it survives a later delete+re-open of the same name.
    return Promise.resolve(new Cache(globalThis.__csim_cacheStorageOpen(originKey(), String(name))));
  }

  has(name) {
    const d = storageDenied(); if (d) return Promise.reject(d);
    if (name === undefined) return Promise.reject(new TypeError("Failed to execute 'has' on 'CacheStorage': 1 argument required, but only 0 present."));
    return Promise.resolve(!!globalThis.__csim_cacheStorageHas(originKey(), String(name)));
  }
  delete(name) {
    const d = storageDenied(); if (d) return Promise.reject(d);
    if (name === undefined) return Promise.reject(new TypeError("Failed to execute 'delete' on 'CacheStorage': 1 argument required, but only 0 present."));
    return Promise.resolve(!!globalThis.__csim_cacheStorageDelete(originKey(), String(name)));
  }
  keys() {
    const d = storageDenied(); if (d) return Promise.reject(d);
    return Promise.resolve(Array.from(globalThis.__csim_cacheStorageKeys(originKey()) || []).map(String));
  }

  match(request, options) {
    options = options || {};
    const denied = storageDenied(); if (denied) return Promise.reject(denied);
    if (request === undefined) return Promise.reject(new TypeError("Failed to execute 'match' on 'CacheStorage': 1 argument required, but only 0 present."));
    return new Promise((resolve, reject) => {
      const key = originKey();
      const all = Array.from(globalThis.__csim_cacheStorageKeys(key) || []).map(String);
      // Search a named cache only when it exists (never create one here), else every cache in
      // creation order — resolve with the first match.
      const names = options.cacheName != null ? all.filter(n => n === String(options.cacheName)) : all;
      (function next(i) {
        if (i >= names.length) { resolve(undefined); return; }
        const cache = new Cache(globalThis.__csim_cacheStorageOpen(key, names[i]));
        cache.match(request, options).then(r => (r !== undefined ? resolve(r) : next(i + 1)), reject);
      })(0);
    });
  }
}

globalThis.Cache        = Cache;
globalThis.CacheStorage = CacheStorage;
globalThis.caches       = new CacheStorage();
