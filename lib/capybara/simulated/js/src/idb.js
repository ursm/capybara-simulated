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

function ensureDb(name) {
  if (!_db.has(name)) _db.set(name, new Map());
  if (!_meta.has(name)) _meta.set(name, {version: 0, storeNames: new Set()});
  return _db.get(name);
}

function ensureStore(dbName, storeName) {
  const db = ensureDb(dbName);
  if (!db.has(storeName)) db.set(storeName, new Map());
  return db.get(storeName);
}

// Per IDB spec, keys are compared as a type ordering: number < date <
// string < binary < array. Our store only uses primitive keys today,
// so a simple `<`/`>` works for sort.
function cmpKey(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
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

// Schedule a microtask-deferred dispatch — matches real IDB's "success
// fires after the call site's then-chain is set up" timing.
function deliver(req, type) {
  Promise.resolve().then(() => {
    req.readyState = 'done';
    dispatchWithOnHandler(req, {type, target: req});
    if (req.transaction) req.transaction._maybeComplete();
  });
  return req;
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
    return new IDBObjectStore(this.name, name, opts || {});
  }
  deleteObjectStore(name) {
    _meta.get(this.name).storeNames.delete(name);
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
    this.keyPath    = (opts && opts.keyPath) || null;
    this.autoIncrement = !!(opts && opts.autoIncrement);
    this.transaction = null;
    this._indexes   = new Map();
  }
  _store() { return ensureStore(this._dbName, this.name); }
  _newRequest(setup) {
    const req = new IDBRequest(this);
    req.transaction = this.transaction;
    if (this.transaction) this.transaction._track();
    try { setup(req); } catch (e) { req.error = e; }
    return deliver(req, req.error ? 'error' : 'success');
  }
  get(key)    { return this._newRequest(req => { req.result = this._store().get(key); }); }
  getKey(query) {
    return this._newRequest(req => {
      const pred = asPredicate(query);
      for (const [k] of sortedEntries(this._store())) if (pred(k)) { req.result = k; return; }
      req.result = undefined;
    });
  }
  getAll(query, count) {
    return this._newRequest(req => {
      const pred = asPredicate(query);
      const max  = count == null ? Infinity : Number(count) || 0;
      const out  = [];
      for (const [k, v] of sortedEntries(this._store())) {
        if (out.length >= max) break;
        if (pred(k)) out.push(v);
      }
      req.result = out;
    });
  }
  getAllKeys(query, count) {
    return this._newRequest(req => {
      const pred = asPredicate(query);
      const max  = count == null ? Infinity : Number(count) || 0;
      const out  = [];
      for (const [k] of sortedEntries(this._store())) {
        if (out.length >= max) break;
        if (pred(k)) out.push(k);
      }
      req.result = out;
    });
  }
  count(query) {
    return this._newRequest(req => {
      const pred = asPredicate(query);
      let n = 0;
      for (const [k] of sortedEntries(this._store())) if (pred(k)) n++;
      req.result = n;
    });
  }
  put(value, key) {
    return this._newRequest(req => {
      const k = key !== undefined ? key : this._extractKey(value);
      this._store().set(k, value);
      req.result = k;
    });
  }
  add(value, key) { return this.put(value, key); }
  delete(query) {
    return this._newRequest(req => {
      const pred = asPredicate(query);
      const store = this._store();
      for (const k of Array.from(store.keys())) if (pred(k)) store.delete(k);
      req.result = undefined;
    });
  }
  clear() {
    return this._newRequest(req => { this._store().clear(); req.result = undefined; });
  }
  openCursor(query, direction) {
    return this._newCursorRequest(query, direction, false);
  }
  openKeyCursor(query, direction) {
    return this._newCursorRequest(query, direction, true);
  }
  _newCursorRequest(query, direction, keyOnly) {
    const req = new IDBRequest(this);
    req.transaction = this.transaction;
    if (this.transaction) this.transaction._track();
    const pred = asPredicate(query);
    let entries = sortedEntries(this._store()).filter(([k]) => pred(k));
    if (direction === 'prev' || direction === 'prevunique') entries = entries.reverse();
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
  createIndex(name, _keyPath, _opts) {
    this._indexes.set(name, new IDBIndex(this, name));
    return this._indexes.get(name);
  }
  index(name) { return this._indexes.get(name) || new IDBIndex(this, name); }
  deleteIndex(name) { this._indexes.delete(name); }
  _extractKey(value) {
    if (!this.keyPath) return undefined;
    if (Array.isArray(this.keyPath)) return this.keyPath.map(p => value && value[p]);
    return value && value[this.keyPath];
  }
}

// Without a real index, fall back to the object store's keys —
// matches the simplest idb library usage.
export class IDBIndex extends EventTarget {
  constructor(objectStore, name) {
    super();
    this.name        = name;
    this.objectStore = objectStore;
    this.keyPath     = null;
    this.unique      = false;
    this.multiEntry  = false;
  }
  get(query)            { return this.objectStore.get(query); }
  getKey(query)         { return this.objectStore.getKey(query); }
  getAll(q, n)          { return this.objectStore.getAll(q, n); }
  getAllKeys(q, n)      { return this.objectStore.getAllKeys(q, n); }
  count(q)              { return this.objectStore.count(q); }
  openCursor(q, dir)    { return this.objectStore.openCursor(q, dir); }
  openKeyCursor(q, dir) { return this.objectStore.openKeyCursor(q, dir); }
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
    Promise.resolve().then(() => {
      req.readyState = 'done';
      if (newVersion > oldVersion) {
        dispatchWithOnHandler(req, {
          type:            'upgradeneeded',
          target:          req,
          oldVersion,
          newVersion
        });
      }
      dispatchWithOnHandler(req, {type: 'success', target: req});
    });
    return req;
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
