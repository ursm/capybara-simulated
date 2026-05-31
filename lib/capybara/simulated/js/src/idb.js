// IndexedDB — in-memory store keyed by VM lifetime. Real persistence
// would survive page reloads; we keep enough surface to satisfy the
// "cache miss → fetch + write → fetch from cache succeeds within the
// same session" round-trips that `idb-keyval`, `idb`, Tesseract.js,
// and Discourse's MessageBus cache rely on.
//
// The earlier stub only handled `objectStore(name).get/put/delete`;
// libraries that opened a cursor (Discourse's `IndexedDbStore`
// iteration, Mastodon's emoji walk) silently no-op'd. This module
// implements the spec's basic surface: per-store sorted records,
// IDBKeyRange filter shapes, cursor iteration with continue/advance,
// transactions with oncomplete delivery, getAll / getAllKeys, and
// version-aware open (skip upgradeneeded on second open).

import { EventTarget, dispatchWithOnHandler } from './events.js';

// `db` namespace -> store name -> sorted [key, value] entries.
const _db = new Map();
const _meta = new Map();  // db name -> {version, storeNames:Set}
// `dbName\x00storeName` -> next auto-increment integer (the store's
// "current number" key generator per the IDB spec).
const _keyGen = new Map();
function nextAutoKey(dbName, storeName) {
  const id = dbName + '\x00' + storeName;
  const cur = _keyGen.get(id) || 0;
  const next = cur + 1;
  _keyGen.set(id, next);
  return next;
}
// Spec "possibly update the key generator": if an explicit/in-line
// integer key ≥ the generator's current number is written, the
// generator advances past it.
function bumpKeyGen(dbName, storeName, key) {
  if (typeof key !== 'number') return;
  const floored = Math.floor(key);
  if (floored < 1) return;
  const id = dbName + '\x00' + storeName;
  const cur = _keyGen.get(id) || 0;
  if (floored > cur) _keyGen.set(id, floored);
}

function ensureDb(name) {
  if (!_db.has(name)) _db.set(name, new Map());
  if (!_meta.has(name)) _meta.set(name, {version: 0, storeNames: new Set(), stores: new Map()});
  // Back-compat for any meta created before `stores` existed.
  const m = _meta.get(name);
  if (!m.stores) m.stores = new Map();
  return _db.get(name);
}

// Persisted per-store schema (keyPath / autoIncrement / index defs).
// A store reopened via `transaction.objectStore(name)` constructs a
// fresh IDBObjectStore with no opts, so the schema set at
// createObjectStore time must be recovered from here — otherwise
// autoIncrement / keyPath / indexes silently reset to defaults.
function storeDef(dbName, storeName) {
  ensureDb(dbName);
  const stores = _meta.get(dbName).stores;
  if (!stores.has(storeName)) {
    stores.set(storeName, {keyPath: null, autoIncrement: false, indexes: new Map()});
  }
  return stores.get(storeName);
}

function ensureStore(dbName, storeName) {
  const db = ensureDb(dbName);
  if (!db.has(storeName)) db.set(storeName, new Map());
  return db.get(storeName);
}

// Per IDB spec "compare two keys"
// (https://w3c.github.io/IndexedDB/#compare-two-keys): keys form a
// total order by type rank number < date < string < binary < array;
// within a type compare appropriately; arrays compare element-by-
// element then by length. Plain `<`/`>` mis-orders arrays, Dates and
// binary, so range bounds / cursor order were wrong for those.
function keyTypeRank(k) {
  if (typeof k === 'number')                 return 0;
  if (k instanceof Date)                     return 1;
  if (typeof k === 'string')                 return 2;
  if (k instanceof ArrayBuffer ||
      (k && ArrayBuffer.isView(k)))          return 3;
  if (Array.isArray(k))                      return 4;
  return 2; // treat unknowns as string-like for stable ordering
}
function asBytes(k) {
  if (k instanceof ArrayBuffer) return new Uint8Array(k);
  return new Uint8Array(k.buffer, k.byteOffset || 0, k.byteLength);
}
function cmpKey(a, b) {
  const ra = keyTypeRank(a), rb = keyTypeRank(b);
  if (ra !== rb) return ra < rb ? -1 : 1;
  switch (ra) {
    case 0: { // number
      if (a === b) return 0;
      return a < b ? -1 : 1;
    }
    case 1: { // date
      const ta = a.getTime(), tb = b.getTime();
      return ta === tb ? 0 : (ta < tb ? -1 : 1);
    }
    case 3: { // binary — byte-by-byte then length
      const ba = asBytes(a), bb = asBytes(b);
      const n = Math.min(ba.length, bb.length);
      for (let i = 0; i < n; i++) if (ba[i] !== bb[i]) return ba[i] < bb[i] ? -1 : 1;
      return ba.length === bb.length ? 0 : (ba.length < bb.length ? -1 : 1);
    }
    case 4: { // array — element-by-element then length
      const n = Math.min(a.length, b.length);
      for (let i = 0; i < n; i++) {
        const c = cmpKey(a[i], b[i]);
        if (c !== 0) return c;
      }
      return a.length === b.length ? 0 : (a.length < b.length ? -1 : 1);
    }
    default: { // string (and unknowns)
      if (a === b) return 0;
      return a < b ? -1 : 1;
    }
  }
}

function sortedEntries(map) {
  return Array.from(map.entries()).sort((a, b) => cmpKey(a[0], b[0]));
}

export class IDBKeyRange {
  constructor(lower, upper, lowerOpen, upperOpen) {
    this.lower = lower;
    this.upper = upper;
    this.lowerOpen = !!lowerOpen;
    this.upperOpen = !!upperOpen;
  }
  includes(key) {
    if (this.lower !== undefined) {
      const c = cmpKey(key, this.lower);
      if (c < 0 || (c === 0 && this.lowerOpen)) return false;
    }
    if (this.upper !== undefined) {
      const c = cmpKey(key, this.upper);
      if (c > 0 || (c === 0 && this.upperOpen)) return false;
    }
    return true;
  }
  static only(v)                              { return new IDBKeyRange(v, v, false, false); }
  static lowerBound(v, open)                  { return new IDBKeyRange(v, undefined, !!open, false); }
  static upperBound(v, open)                  { return new IDBKeyRange(undefined, v, false, !!open); }
  static bound(lower, upper, lOpen, uOpen)    { return new IDBKeyRange(lower, upper, !!lOpen, !!uOpen); }
}

// Extract the value at a keyPath from a record. Supports dotted paths
// ("a.b.c") and array keyPaths (["a", "b"] → [value.a, value.b]).
function extractKeyPath(record, keyPath) {
  if (record == null) return undefined;
  if (Array.isArray(keyPath)) return keyPath.map(p => extractKeyPath(record, p));
  let cur = record;
  for (const part of String(keyPath).split('.')) {
    if (cur == null) return undefined;
    cur = cur[part];
  }
  return cur;
}

// Resolve a key/range argument to a filter predicate over plain keys.
function asPredicate(query) {
  if (query == null) return () => true;
  if (query instanceof IDBKeyRange) return (k) => query.includes(k);
  return (k) => cmpKey(k, query) === 0;
}

export class IDBRequest extends EventTarget {
  constructor(source) {
    super();
    this.source         = source || null;
    this.result         = null;
    this.error          = null;
    this.readyState     = 'pending';
    this.transaction    = null;
    this.onsuccess      = null;
    this.onerror        = null;
    this.onupgradeneeded = null;
  }
}

// Microtask-deferred dispatch — matches real IDB's "success fires
// after the call site's then-chain is set up" timing.
function deliver(req, type) {
  Promise.resolve().then(() => {
    req.readyState = 'done';
    dispatchWithOnHandler(req, {type, target: req});
    if (req.transaction) req.transaction._maybeComplete();
  });
  return req;
}

function newRequest(store, setup) {
  const req = new IDBRequest(store);
  req.transaction = store.transaction;
  if (store.transaction) store.transaction._track();
  try { setup(req); } catch (e) { req.error = e; }
  return deliver(req, req.error ? 'error' : 'success');
}

export class IDBDatabase extends EventTarget {
  constructor(name) {
    super();
    this.name = name;
    this.version = (_meta.get(name) && _meta.get(name).version) || 0;
    this.onversionchange = null;
    this.onclose         = null;
  }
  get objectStoreNames() { return Array.from(_meta.get(this.name).storeNames); }
  createObjectStore(name, opts) {
    _meta.get(this.name).storeNames.add(name);
    ensureStore(this.name, name);
    // Persist the schema so it survives transaction.objectStore() reopen.
    const def = storeDef(this.name, name);
    def.keyPath       = (opts && opts.keyPath) || null;
    def.autoIncrement = !!(opts && opts.autoIncrement);
    return new IDBObjectStore(this.name, name, opts || {});
  }
  deleteObjectStore(name) {
    _meta.get(this.name).storeNames.delete(name);
    _meta.get(this.name).stores.delete(name);
    _db.get(this.name).delete(name);
  }
  transaction(storeNames, mode) {
    return new IDBTransaction(this, storeNames, mode);
  }
  close() {}
}

export class IDBTransaction extends EventTarget {
  constructor(db, storeNames, mode) {
    super();
    this.db   = db;
    this.mode = mode || 'readonly';
    this.objectStoreNames = Array.isArray(storeNames) ? storeNames : [storeNames];
    this._pendingRequests = 0;
    this._completed = false;
    this.oncomplete = null;
    this.onerror    = null;
    this.onabort    = null;
  }
  objectStore(name) {
    // Recover the persisted schema (keyPath / autoIncrement / indexes)
    // so a store reopened mid-session keeps its key generator and
    // index definitions.
    const os = new IDBObjectStore(this.db.name, name);
    os.transaction = this;
    return os;
  }
  // Spec: transaction.commit() is a hint; we treat it as marking
  // completion after pending requests settle.
  commit() { Promise.resolve().then(() => this._maybeComplete()); }
  abort()  { this._completed = true; dispatchWithOnHandler(this, {type: 'abort', target: this}); }
  _track() { this._pendingRequests++; }
  _maybeComplete() {
    if (this._completed) return;
    if (this._pendingRequests > 0) this._pendingRequests--;
    if (this._pendingRequests === 0) {
      this._completed = true;
      Promise.resolve().then(() => dispatchWithOnHandler(this, {type: 'complete', target: this}));
    }
  }
}

export class IDBObjectStore extends EventTarget {
  constructor(dbName, name, opts) {
    super();
    this.name       = name;
    this._dbName    = dbName;
    const def = storeDef(dbName, name);
    // Explicit opts (createObjectStore) win; otherwise recover the
    // persisted schema (transaction.objectStore reopen).
    this.keyPath       = opts && 'keyPath' in opts ? (opts.keyPath || null) : def.keyPath;
    this.autoIncrement = opts && 'autoIncrement' in opts ? !!opts.autoIncrement : def.autoIncrement;
    this.transaction = null;
    this._indexes   = new Map();
    // Rehydrate index instances from persisted defs.
    for (const [iname, idef] of def.indexes) {
      const idx = new IDBIndex(this, iname);
      idx.keyPath    = idef.keyPath;
      idx.unique     = idef.unique;
      idx.multiEntry = idef.multiEntry;
      this._indexes.set(iname, idx);
    }
  }
  _store() { return ensureStore(this._dbName, this.name); }
  // Point ops bypass sortedEntries — direct Map ops are O(1) and the
  // spec only requires sort order for range/cursor queries.
  get(key)        { return newRequest(this, req => { req.result = this._store().get(key); }); }
  // Resolve the effective key for a write: explicit arg wins, else an
  // in-line keyPath value, else (for autoIncrement stores) a generated
  // monotonic integer.
  _resolveWriteKey(value, key) {
    let k = key !== undefined ? key : this._extractKey(value);
    if (k === undefined || k === null) {
      if (this.autoIncrement) k = nextAutoKey(this._dbName, this.name);
    } else {
      bumpKeyGen(this._dbName, this.name, k);
    }
    return k;
  }
  put(value, key) {
    return newRequest(this, req => {
      const k = this._resolveWriteKey(value, key);
      this._store().set(k, value);
      req.result = k;
    });
  }
  // Spec: add() fails with a ConstraintError when a record with the
  // same key already exists, rather than overwriting (which put does).
  add(value, key) {
    return newRequest(this, req => {
      const k = this._resolveWriteKey(value, key);
      const store = this._store();
      if (store.has(k)) {
        const err = new Error('ConstraintError: Key already exists in the object store.');
        err.name = 'ConstraintError';
        req.error = err;
        return;
      }
      store.set(k, value);
      req.result = k;
    });
  }
  clear()         { return newRequest(this, req => { this._store().clear(); req.result = undefined; }); }
  getKey(query) {
    return newRequest(this, req => {
      const pred = asPredicate(query);
      for (const [k] of sortedEntries(this._store())) if (pred(k)) { req.result = k; return; }
      req.result = undefined;
    });
  }
  getAll(query, count)    { return newRequest(this, req => { req.result = this._scan(query, count, ([, v]) => v); }); }
  getAllKeys(query, count) { return newRequest(this, req => { req.result = this._scan(query, count, ([k]) => k); }); }
  count(query)            { return newRequest(this, req => { req.result = this._scan(query, undefined, () => 1).length; }); }
  delete(query) {
    return newRequest(this, req => {
      const pred = asPredicate(query);
      const store = this._store();
      for (const k of Array.from(store.keys())) if (pred(k)) store.delete(k);
      req.result = undefined;
    });
  }
  _scan(query, count, project) {
    const pred = asPredicate(query);
    const max  = count == null ? Infinity : Number(count) || 0;
    const out  = [];
    for (const entry of sortedEntries(this._store())) {
      if (out.length >= max) break;
      if (pred(entry[0])) out.push(project(entry));
    }
    return out;
  }
  openCursor(query, direction)    { return this._newCursorRequest(query, direction, false); }
  openKeyCursor(query, direction) { return this._newCursorRequest(query, direction, true); }
  _newCursorRequest(query, direction, keyOnly) {
    const req = new IDBRequest(this);
    req.transaction = this.transaction;
    if (this.transaction) this.transaction._track();
    const pred = asPredicate(query);
    let entries = sortedEntries(this._store()).filter(([k]) => pred(k));
    if (direction === 'prev' || direction === 'prevunique') entries.reverse();
    let i = 0;
    const step = () => {
      if (i >= entries.length) {
        req.result = null;
      } else {
        const [k, v] = entries[i++];
        req.result = new IDBCursor(req, k, keyOnly ? undefined : v, step);
      }
      Promise.resolve().then(() => dispatchWithOnHandler(req, {type: 'success', target: req}));
    };
    step();
    if (this.transaction) Promise.resolve().then(() => this.transaction._maybeComplete());
    return req;
  }
  createIndex(name, keyPath, opts) {
    const idx = new IDBIndex(this, name);
    idx.keyPath    = keyPath != null ? keyPath : null;
    idx.unique     = !!(opts && opts.unique);
    idx.multiEntry = !!(opts && opts.multiEntry);
    this._indexes.set(name, idx);
    // Persist the index def so it survives a store reopen.
    storeDef(this._dbName, this.name).indexes.set(name, {
      keyPath:    idx.keyPath,
      unique:     idx.unique,
      multiEntry: idx.multiEntry
    });
    return idx;
  }
  index(name) { return this._indexes.get(name) || new IDBIndex(this, name); }
  deleteIndex(name) {
    this._indexes.delete(name);
    storeDef(this._dbName, this.name).indexes.delete(name);
  }
  _extractKey(value) {
    // Out-of-line keys (no keyPath) supply the key explicitly; nothing
    // to extract. Otherwise delegate to the shared helper so dotted
    // ("a.b") and array keyPaths resolve identically to IDBIndex —
    // keeping primary key and index key in agreement.
    if (!this.keyPath) return undefined;
    return extractKeyPath(value, this.keyPath);
  }
}

// An index looks records up by its OWN keyPath value (not the store's
// primary key). When no keyPath is set (legacy callers) it falls back
// to the object store's primary key.
export class IDBIndex extends EventTarget {
  constructor(objectStore, name) {
    super();
    this.name        = name;
    this.objectStore = objectStore;
    this.keyPath     = null;
    this.unique      = false;
    this.multiEntry  = false;
  }
  // Records whose index-keyPath value matches `query`, sorted by that
  // index key. Without a keyPath we degrade to primary-key matching.
  _matches(query) {
    if (this.keyPath == null) {
      const pred = asPredicate(query);
      return sortedEntries(this.objectStore._store())
        .filter(([k]) => pred(k))
        .map(([k, v]) => ({indexKey: k, primaryKey: k, value: v}));
    }
    const pred = asPredicate(query);
    const out  = [];
    for (const [pk, v] of this.objectStore._store()) {
      const ik = extractKeyPath(v, this.keyPath);
      if (ik === undefined) continue;
      if (pred(ik)) out.push({indexKey: ik, primaryKey: pk, value: v});
    }
    out.sort((a, b) => cmpKey(a.indexKey, b.indexKey) || cmpKey(a.primaryKey, b.primaryKey));
    return out;
  }
  get(query)    { return newRequest(this.objectStore, req => { const m = this._matches(query); req.result = m.length ? m[0].value : undefined; }); }
  getKey(query) { return newRequest(this.objectStore, req => { const m = this._matches(query); req.result = m.length ? m[0].primaryKey : undefined; }); }
  getAll(q, n)  { return newRequest(this.objectStore, req => { const max = n == null ? Infinity : Number(n) || 0; req.result = this._matches(q).slice(0, max).map(e => e.value); }); }
  getAllKeys(q, n) { return newRequest(this.objectStore, req => { const max = n == null ? Infinity : Number(n) || 0; req.result = this._matches(q).slice(0, max).map(e => e.primaryKey); }); }
  count(q)      { return newRequest(this.objectStore, req => { req.result = this._matches(q).length; }); }
  openCursor(query, direction)    { return this._newIndexCursor(query, direction, false); }
  openKeyCursor(query, direction) { return this._newIndexCursor(query, direction, true); }
  _newIndexCursor(query, direction, keyOnly) {
    const store = this.objectStore;
    const req = new IDBRequest(store);
    req.transaction = store.transaction;
    if (store.transaction) store.transaction._track();
    let entries = this._matches(query);
    if (direction === 'prev' || direction === 'prevunique') entries.reverse();
    let i = 0;
    const step = () => {
      if (i >= entries.length) {
        req.result = null;
      } else {
        const e = entries[i++];
        const cur = new IDBCursor(req, e.indexKey, keyOnly ? undefined : e.value, step);
        cur.primaryKey = e.primaryKey;
        req.result = cur;
      }
      Promise.resolve().then(() => dispatchWithOnHandler(req, {type: 'success', target: req}));
    };
    step();
    if (store.transaction) Promise.resolve().then(() => store.transaction._maybeComplete());
    return req;
  }
}

export class IDBCursor {
  constructor(request, key, value, advanceFn) {
    this._req     = request;
    this.key      = key;
    this.primaryKey = key;
    this.value    = value;
    this.source   = request.source;
    this.direction = 'next';
    this._advance = advanceFn;
  }
  advance(count) {
    const n = Math.max(1, count | 0);
    for (let i = 0; i < n; i++) this._advance();
  }
  continue(_key) { this._advance(); }
  continuePrimaryKey() { this._advance(); }
  update(value)  {
    if (this.source && this.source._store) this.source._store().set(this.key, value);
    return this._req;
  }
  delete() {
    if (this.source && this.source._store) this.source._store().delete(this.key);
    return this._req;
  }
}

export const indexedDB = {
  open(name, version) {
    const req = new IDBRequest();
    const meta = _meta.get(String(name));
    const oldVersion = meta ? meta.version : 0;
    const newVersion = version || (oldVersion || 1);
    ensureDb(String(name));
    _meta.get(String(name)).version = newVersion;
    const db = new IDBDatabase(String(name));
    db.version = newVersion;
    req.result = db;
    if (newVersion > oldVersion) {
      Promise.resolve().then(() => {
        dispatchWithOnHandler(req, {type: 'upgradeneeded', target: req, oldVersion, newVersion});
      });
    }
    return deliver(req, 'success');
  },
  deleteDatabase(name) {
    const req = new IDBRequest();
    _db.delete(String(name));
    _meta.delete(String(name));
    return deliver(req, 'success');
  },
  databases() {
    return Promise.resolve(Array.from(_meta.keys()).map(name => ({name, version: _meta.get(name).version})));
  },
  cmp(a, b) { return cmpKey(a, b); }
};

globalThis.indexedDB      = indexedDB;
globalThis.IDBRequest     = IDBRequest;
globalThis.IDBDatabase    = IDBDatabase;
globalThis.IDBObjectStore = IDBObjectStore;
globalThis.IDBTransaction = IDBTransaction;
globalThis.IDBIndex       = IDBIndex;
globalThis.IDBCursor      = IDBCursor;
globalThis.IDBKeyRange    = IDBKeyRange;
