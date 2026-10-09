// IndexedDB (Indexed Database API 3.0), generated from its IDL: databases of object stores and their indexes, read and
// written through transactions whose requests run one after another as tasks, their results told by events.
//
// The databases are this realm's (`databases`): each a version and object stores, each store its records sorted by key
// and its indexes their records sorted by index key then primary key, every value kept as its structured clone. A
// transaction writing a store first keeps what the store was (`touch`), so an abort puts it back; an upgrade
// transaction keeps the whole database's schema. Every object a page holds is made by the platform alone (IDBKeyRange's
// statics aside), its state in slots.

import {
  CONVERTED, Event, EventTarget, IDBVersionChangeEvent, eventState, fireWithCheckpoints, installEventHandlerAttrs,
  setEventParent
} from './events.js';
import { domStringList } from './dom-string-list.js';
import {
  installIDBCursor,
  installIDBCursorWithValue,
  installIDBDatabase,
  installIDBFactory,
  installIDBIndex,
  installIDBKeyRange,
  installIDBObjectStore,
  installIDBOpenDBRequest,
  installIDBRecord,
  installIDBRequest,
  installIDBTransaction,
  toIDBGetAllOptions
} from './generated/bindings.js';
import { structuredClone } from './platform-globals.js';
import { afterMicrotaskCheckpoint, queueTask } from './timers.js';
import {
  IntrinsicPromise,
  PLATFORM,
  bufferOfSource,
  bufferSourceBytes,
  constructedBy,
  interfaceCheck,
  isArrayBuffer,
  makeSlots,
  ownRealm,
  registerInterface,
  slotsOf
} from './webidl.js';

const installEventHandlers = (proto, names, isSelf) => installEventHandlerAttrs(proto, names, null, isSelf);
// (…every event the platform fires here with the microtask checkpoint after each listener — HTML's "clean up after
// running script" — so a listener's promise continuations run while its transaction is still active)
const fire = fireWithCheckpoints;
const error = (name, message) => new DOMException(message, name);
// A database, a transaction, a store, an index and a cursor are their realm's (webidl.js `ownRealm`): an iframe's
// `IDBObjectStore.prototype.put` called on this realm's store queues its request into this realm's transaction, onto
// this realm's event loop — the iframe's may be gone.
const REALM = {};

// ── Keys (§2.7) ──────────────────────────────────────────────────────────────────────────────────────────────────────
// A key as kept here: a number, a string, a date (`{ date: ms }`), binary (`{ binary: Uint8Array }`), or an array of
// keys (an Array). INVALID is "invalid value".
const INVALID = Symbol('invalid');
const arrayBufferDetached = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'detached').get;
const isDate = (v) => {
  try { Date.prototype.getTime.call(v); return true; } catch (_) { return false; }
};
// (…an Array exotic object, which a Proxy of an array is not though `Array.isArray` says it is: told natively)
const isArray = (v) => Array.isArray(v) && globalThis.__dom.isArrayExotic(v);
// A list's next item, defined rather than set: a setter a page put on Object.prototype for that index is not called.
const append = (list, item) => {
  Object.defineProperty(list, list.length, { value: item, writable: true, enumerable: true, configurable: true });
};
// "Convert a value to a key": an Array's own items each converted, a cycle invalid; anything a Get throws thrown.
function valueToKey(input, seen = null) {
  if (typeof input === 'number') return Number.isNaN(input) ? INVALID : input;
  if (typeof input === 'string') return input;
  if (input === null || typeof input !== 'object') return INVALID;
  if (seen !== null && seen.has(input)) return INVALID;
  if (isDate(input)) {
    const ms = Date.prototype.getTime.call(input);
    return Number.isNaN(ms) ? INVALID : { date: ms };
  }
  // (…a buffer source — an ArrayBuffer, or a view of one — its bytes copied, read off its internal slots; a detached
  // one none)
  if (ArrayBuffer.isView(input) || isArrayBuffer(input)) {
    const buffer = bufferOfSource(input);
    if (!isArrayBuffer(buffer) || arrayBufferDetached.call(buffer)) return INVALID;
    return { binary: bufferSourceBytes(input) };
  }
  if (isArray(input)) {
    const length = input.length, keys = [];
    (seen ??= new Set()).add(input);
    for (let i = 0; i < length; i++) {
      if (!Object.hasOwn(input, i)) return INVALID;
      const key = valueToKey(input[i], seen);
      if (key === INVALID) return INVALID;
      append(keys, key);
    }
    seen.delete(input);
    return keys;
  }
  return INVALID;
}
// …"convert a value to a multiEntry key": an Array's items each a key, the invalid and the repeated left out.
function valueToMultiEntryKey(input) {
  if (!isArray(input)) return valueToKey(input);
  const seen = new Set([input]), keys = [];
  for (let i = 0, length = input.length; i < length; i++) {
    const key = valueToKey(input[i], seen);
    if (key !== INVALID && !keys.some((k) => compareKeys(k, key) === 0)) append(keys, key);
  }
  return keys;
}
// "Convert a key to a value": a date a new Date, binary a new ArrayBuffer, an array a new Array.
function keyToValue(key) {
  if (typeof key === 'number' || typeof key === 'string') return key;
  if (Array.isArray(key)) return key.map(keyToValue);
  if ('date' in key) return new Date(key.date);
  return key.binary.slice().buffer;
}
// "Compare two keys": by type — array > binary > string > date > number — then by value.
const typeRank = (k) => (typeof k === 'number' ? 0 : typeof k === 'string' ? 2 : Array.isArray(k) ? 4 : 'date' in k ? 1 : 3);
function compareKeys(a, b) {
  const ra = typeRank(a), rb = typeRank(b);
  if (ra !== rb) return ra > rb ? 1 : -1;
  switch (ra) {
    case 0:
    case 2: return a === b ? 0 : a < b ? -1 : 1;
    case 1: return a.date === b.date ? 0 : a.date < b.date ? -1 : 1;
    case 3: {
      const x = a.binary, y = b.binary, n = Math.min(x.length, y.length);
      for (let i = 0; i < n; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
      return x.length === y.length ? 0 : x.length < y.length ? -1 : 1;
    }
    default: {
      const n = Math.min(a.length, b.length);
      for (let i = 0; i < n; i++) {
        const c = compareKeys(a[i], b[i]);
        if (c !== 0) return c;
      }
      return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
    }
  }
}
// A key a page passed: converted, invalid a DataError.
function keyOf(value, message = 'The parameter is not a valid key.') {
  const key = valueToKey(value);
  if (key === INVALID) throw error('DataError', message);
  return key;
}

// ── Key paths (§2.5) ─────────────────────────────────────────────────────────────────────────────────────────────────
const IDENTIFIER = /^[\p{ID_Start}$_][\p{ID_Continue}$‌‍]*$/u;
const isValidKeyPath = (keyPath) => (Array.isArray(keyPath)
  ? keyPath.length > 0 && keyPath.every((p) => isValidKeyPath(p))
  : keyPath === '' || keyPath.split('.').every((part) => IDENTIFIER.test(part)));
const FAILURE = Symbol('failure');
const IS_BLOB = interfaceCheck('Blob');
const IS_FILE = interfaceCheck('File');
// "Evaluate a key path on a value": a list each item's, a string's `length`, an Array's, a Blob's `size` / `type`, a
// File's `name` / `lastModified`, and otherwise an object's own property — FAILURE where there is none.
function evaluateKeyPath(value, keyPath) {
  if (Array.isArray(keyPath)) {
    const result = [];
    for (const item of keyPath) {
      const v = evaluateKeyPath(value, item);
      if (v === FAILURE) return FAILURE;
      append(result, v);
    }
    return result;
  }
  if (keyPath === '') return value;
  for (const identifier of keyPath.split('.')) {
    if (typeof value === 'string' && identifier === 'length') value = value.length;
    else if (isArray(value) && identifier === 'length') value = value.length;
    else if (IS_BLOB(value) && identifier === 'size') value = value.size;
    else if (IS_BLOB(value) && identifier === 'type') value = value.type;
    else if (IS_FILE(value) && identifier === 'name') value = value.name;
    else if (IS_FILE(value) && identifier === 'lastModified') value = value.lastModified;
    else if (value === null || (typeof value !== 'object' && typeof value !== 'function') || !Object.hasOwn(value, identifier)) return FAILURE;
    else value = value[identifier];
  }
  return value;
}
// "Extract a key from a value using a key path": FAILURE, INVALID or the key.
function extractKey(value, keyPath, multiEntry = false) {
  const r = evaluateKeyPath(value, keyPath);
  if (r === FAILURE) return FAILURE;
  return multiEntry ? valueToMultiEntryKey(r) : valueToKey(r);
}
const isObjectOrArray = (v) => v !== null && typeof v === 'object';
// "Check that a key could be injected into a value", and "inject a key into a value".
function canInjectKey(value, keyPath) {
  const identifiers = keyPath.split('.');
  identifiers.pop();
  for (const identifier of identifiers) {
    if (!isObjectOrArray(value)) return false;
    if (!Object.hasOwn(value, identifier)) return true;
    value = value[identifier];
  }
  return isObjectOrArray(value);
}
function injectKey(value, key, keyPath) {
  const identifiers = keyPath.split('.'), last = identifiers.pop();
  for (const identifier of identifiers) {
    if (!Object.hasOwn(value, identifier)) Object.defineProperty(value, identifier, { value: {}, writable: true, enumerable: true, configurable: true });
    value = value[identifier];
  }
  Object.defineProperty(value, last, { value: keyToValue(key), writable: true, enumerable: true, configurable: true });
}
const keyPathValue = (keyPath) => (Array.isArray(keyPath) ? keyPath.slice() : keyPath);

// ── IDBKeyRange (§4.7) ───────────────────────────────────────────────────────────────────────────────────────────────
// A key range's slots: its bounds (keys, or undefined for none) and whether each is open.
const rangeOf = (o) => slotsOf(o, 'IDBKeyRange');
registerInterface('IDBKeyRange', (o) => rangeOf(o) !== undefined);
class IDBKeyRange {
  constructor(token, lower, upper, lowerOpen, upperOpen) {
    constructedBy(PLATFORM, token, 'IDBKeyRange');
    makeSlots(this, 'IDBKeyRange', { lower, upper, lowerOpen, upperOpen });
  }
}
const UNBOUNDED = { lower: undefined, upper: undefined, lowerOpen: false, upperOpen: false };
const onlyRange = (key) => ({ lower: key, upper: key, lowerOpen: false, upperOpen: false });
function inRange(range, key) {
  if (range.lower !== undefined) {
    const c = compareKeys(range.lower, key);
    if (range.lowerOpen ? c >= 0 : c > 0) return false;
  }
  if (range.upper !== undefined) {
    const c = compareKeys(range.upper, key);
    if (range.upperOpen ? c <= 0 : c < 0) return false;
  }
  return true;
}
// "Convert a value to a key range": a key range itself, nothing an unbounded one (or a DataError, `nullDisallowed`), a
// key the range of it alone.
function rangeFrom(value, nullDisallowed = false) {
  const range = rangeOf(value);
  if (range) return range;
  if (value === undefined || value === null) {
    if (nullDisallowed) throw error('DataError', 'No key or key range specified.');
    return UNBOUNDED;
  }
  return onlyRange(keyOf(value));
}
const makeRange = (r) => new IDBKeyRange(PLATFORM, r.lower, r.upper, r.lowerOpen, r.upperOpen);
installIDBKeyRange(IDBKeyRange, {
  get_lower: (r) => (rangeOf(r).lower === undefined ? undefined : keyToValue(rangeOf(r).lower)),
  get_upper: (r) => (rangeOf(r).upper === undefined ? undefined : keyToValue(rangeOf(r).upper)),
  get_lowerOpen: (r) => rangeOf(r).lowerOpen,
  get_upperOpen: (r) => rangeOf(r).upperOpen,
  only: (_, value) => makeRange(onlyRange(keyOf(value))),
  lowerBound: (_, lower, open) => makeRange({ lower: keyOf(lower), upper: undefined, lowerOpen: open, upperOpen: true }),
  upperBound: (_, upper, open) => makeRange({ lower: undefined, upper: keyOf(upper), lowerOpen: true, upperOpen: open }),
  bound(_, lower, upper, lowerOpen, upperOpen) {
    const l = keyOf(lower), u = keyOf(upper), c = compareKeys(l, u);
    if (c > 0 || (c === 0 && (lowerOpen || upperOpen))) throw error('DataError', 'The lower key is greater than the upper key.');
    return makeRange({ lower: l, upper: u, lowerOpen, upperOpen });
  },
  includes: (r, key) => inRange(rangeOf(r), keyOf(key))
});

// ── IDBRecord ────────────────────────────────────────────────────────────────────────────────────────────────────────
const recordOf = (o) => slotsOf(o, 'IDBRecord');
registerInterface('IDBRecord', (o) => recordOf(o) !== undefined);
class IDBRecord {
  constructor(token, key, primaryKey, value) {
    constructedBy(PLATFORM, token, 'IDBRecord');
    makeSlots(this, 'IDBRecord', { key: keyToValue(key), primaryKey: keyToValue(primaryKey), value });
  }
}
installIDBRecord(IDBRecord, {
  get_key: (r) => recordOf(r).key,
  get_primaryKey: (r) => recordOf(r).primaryKey,
  get_value: (r) => recordOf(r).value
});

// ── The databases (§2.1-2.4) ─────────────────────────────────────────────────────────────────────────────────────────
// A database: its name, version, object stores by name, open connections, transactions in the order they were made,
// and its connection queue. A store: its name, key path, key generator (`current`, or null), records and indexes. An
// index: its name, key path, `unique` and `multiEntry`, and records.
const databases = new Map();
const sortedSearch = (records, compare) => {
  let lo = 0, hi = records.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (compare(records[mid]) < 0) lo = mid + 1; else hi = mid;
  }
  return lo;
};
const storeIndexOf = (store, key) => sortedSearch(store.records, (r) => compareKeys(r.key, key));
const findRecord = (store, key) => {
  const i = storeIndexOf(store, key);
  return i < store.records.length && compareKeys(store.records[i].key, key) === 0 ? store.records[i] : undefined;
};
const compareIndexRecords = (a, key, primaryKey) => compareKeys(a.key, key) || compareKeys(a.primaryKey, primaryKey);
function indexInsert(index, key, primaryKey) {
  index.records.splice(sortedSearch(index.records, (r) => compareIndexRecords(r, key, primaryKey)), 0, { key, primaryKey });
}
function indexRemove(index, key, primaryKey) {
  const i = sortedSearch(index.records, (r) => compareIndexRecords(r, key, primaryKey));
  if (i < index.records.length && compareIndexRecords(index.records[i], key, primaryKey) === 0) index.records.splice(i, 1);
}
// Where a range's records lie in records sorted by key — a store's, or an index's: from its first to past its last.
function rangeSpan(records, range) {
  let lo = 0, hi = records.length;
  if (range.lower !== undefined) {
    lo = sortedSearch(records, (r) => {
      const c = compareKeys(r.key, range.lower);
      return c < 0 || (c === 0 && range.lowerOpen) ? -1 : 1;
    });
  }
  if (range.upper !== undefined) {
    hi = sortedSearch(records, (r) => {
      const c = compareKeys(r.key, range.upper);
      return c < 0 || (c === 0 && !range.upperOpen) ? -1 : 1;
    });
  }
  return [lo, Math.max(lo, hi)];
}
const spanLength = ([lo, hi]) => hi - lo;
// Whether a unique index holds `key` for a record other than the one at `primaryKey`.
function uniqueKeyTaken(index, key, primaryKey) {
  for (let i = sortedSearch(index.records, (r) => compareKeys(r.key, key)); i < index.records.length; i++) {
    const r = index.records[i];
    if (compareKeys(r.key, key) !== 0) return false;
    if (primaryKey === undefined || compareKeys(r.primaryKey, primaryKey) !== 0) return true;
  }
  return false;
}
// The keys a value is indexed under in `index`: none, one, or a multiEntry index's several.
function indexKeysOf(index, value) {
  const key = extractKey(value, index.keyPath, index.multiEntry);
  if (key === FAILURE || key === INVALID) return [];
  return index.multiEntry && Array.isArray(key) ? key : [key];
}
// (…each index's records of them found by the keys their values are indexed under, as they were when stored)
function deleteRecordsIn(store, range) {
  const [lo, hi] = rangeSpan(store.records, range);
  if (lo === hi) return;
  const removed = store.records.splice(lo, hi - lo);
  for (const index of liveIndexes(store)) {
    if (!index.populated) continue;
    for (const r of removed) for (const k of indexKeysOf(index, r.value)) indexRemove(index, k, r.key);
  }
}
// A store's indexes as its records are written: its own, and those deleted whose deletion has yet to run in its
// transaction's order (`retiring`) — a write before the deletion still kept to a unique one.
const liveIndexes = (store) => [...store.indexes.values(), ...store.retiring];
// "Store a record into an object store" — the key generated (and put into the value) or the generator moved past the key
// given, refused for an existing key with `noOverwrite` or a unique index's key another record holds — and its key.
function storeRecord(store, value, key, noOverwrite) {
  // (…its current number Infinity once past 2^53, which a double cannot tell from 2^53 itself — and moved only by a
  // record stored: one refused leaves it as it was)
  let current = store.current;
  if (current !== null) {
    if (key === undefined) {
      if (current > 2 ** 53) throw error('ConstraintError', 'The key generator has reached its maximum.');
      key = current;
      current = key >= 2 ** 53 ? Infinity : key + 1;
      if (store.keyPath !== null) injectKey(value, key, store.keyPath);
    } else if (typeof key === 'number') {
      const next = Math.floor(Math.min(key, 2 ** 53));
      if (next >= current) current = next >= 2 ** 53 ? Infinity : next + 1;
    }
  }
  const existing = findRecord(store, key);
  if (noOverwrite && existing) throw error('ConstraintError', 'A record with that key already exists.');
  const indexKeys = [];
  for (const index of liveIndexes(store)) {
    if (!index.populated) continue;
    const keys = indexKeysOf(index, value);
    if (index.unique && keys.some((k) => uniqueKeyTaken(index, k, key))) {
      throw error('ConstraintError', `Unable to add a key to the unique index '${index.name}'.`);
    }
    indexKeys.push([index, keys]);
  }
  store.current = current;
  if (existing) deleteRecordsIn(store, onlyRange(key));
  store.records.splice(storeIndexOf(store, key), 0, { key, value });
  for (const [index, keys] of indexKeys) for (const k of keys) indexInsert(index, k, key);
  return key;
}
// A store's records — or an index's, each with the store record it references — in `range`, in `direction`, at most
// `count` (0: all of them), as `type` asks: their values, keys, or records.
function retrieve(source, range, direction, count, type) {
  const isIndex = source.records !== undefined && source.store !== undefined;
  let [lo, hi] = rangeSpan(source.records, range);
  if (count && !direction.endsWith('unique')) {
    if (direction === 'next') hi = Math.min(hi, lo + count);
    else lo = Math.max(lo, hi - count);
  }
  let records = source.records.slice(lo, hi);
  if (!isIndex) records = records.map((r) => ({ key: r.key, primaryKey: r.key, value: r.value }));
  if (direction === 'prev' || direction === 'prevunique') records.reverse();
  if (direction.endsWith('unique')) {
    const kept = [];
    for (const r of records) {
      const last = kept[kept.length - 1];
      if (last && compareKeys(last.key, r.key) === 0) {
        if (direction === 'prevunique') kept[kept.length - 1] = r;
        continue;
      }
      kept.push(r);
    }
    records = kept;
  }
  if (count) records = records.slice(0, count);
  const valueOf = (r) => structuredClone(isIndex ? findRecord(source.store, r.primaryKey).value : r.value);
  if (type === 'key') return records.map((r) => keyToValue(isIndex ? r.primaryKey : r.key));
  if (type === 'value') return records.map(valueOf);
  return records.map((r) => new IDBRecord(PLATFORM, r.key, r.primaryKey, valueOf(r)));
}

// ── Requests (§4.1) ──────────────────────────────────────────────────────────────────────────────────────────────────
// A request's slots: its source, transaction, whether it is done, and its result or error.
// Its events go on to its transaction (DOM "get the parent").
const requestOf = (o) => slotsOf(o, 'IDBRequest');
registerInterface('IDBRequest', (o) => requestOf(o) !== undefined);
registerInterface('IDBOpenDBRequest', (o) => slotsOf(o, 'IDBOpenDBRequest') !== undefined);
class IDBRequest extends EventTarget {
  constructor(token, source, transaction) {
    constructedBy(PLATFORM, token, new.target.name);
    super();
    makeSlots(this, 'IDBRequest', { source, transaction, done: false, result: undefined, error: null });
    setEventParent(this, () => requestOf(this).transaction);
  }
}
installIDBRequest(IDBRequest, {
  get_result(request) {
    const r = requestOf(request);
    if (!r.done) throw error('InvalidStateError', 'The request has not finished.');
    return r.result;
  },
  get_error(request) {
    const r = requestOf(request);
    if (!r.done) throw error('InvalidStateError', 'The request has not finished.');
    return r.error;
  },
  get_source: (request) => requestOf(request).source,
  get_transaction: (request) => requestOf(request).transaction,
  get_readyState: (request) => (requestOf(request).done ? 'done' : 'pending'),
  installEventHandlers
});
class IDBOpenDBRequest extends IDBRequest {
  constructor(token) {
    super(token, null, null);
    makeSlots(this, 'IDBOpenDBRequest');
  }
}
installIDBOpenDBRequest(IDBOpenDBRequest, { installEventHandlers });

const event = (type, bubbles, cancelable) => new Event(CONVERTED, type, { bubbles, cancelable, composed: false });
const versionEvent = (type, oldVersion, newVersion) =>
  new IDBVersionChangeEvent(CONVERTED, type, { bubbles: false, cancelable: false, composed: false, oldVersion, newVersion });

// ── Transactions (§2.7, §4.9) ────────────────────────────────────────────────────────────────────────────────────────
// A transaction's slots: its connection and database, scope (store names, sorted), mode, durability, state — active,
// inactive, committing or finished — its requests not yet processed, in order, error, whether it started (no earlier
// transaction it overlaps is still running), what the stores it wrote were (`saved`), and an upgrade one's request and
// saved schema.
const transactionOf = (o) => slotsOf(o, 'IDBTransaction');
registerInterface('IDBTransaction', (o) => transactionOf(o) !== undefined);
class IDBTransaction extends EventTarget {
  constructor(token, connection, scope, mode, durability, state) {
    constructedBy(PLATFORM, token, 'IDBTransaction');
    super();
    const c = connectionOf(connection);
    makeSlots(this, 'IDBTransaction', {
      realm: REALM,
      connection,
      db: c.db,
      scope,
      mode,
      durability,
      state,
      requests: [],
      error: null,
      started: false,
      running: false,
      finishing: false,
      // (…whether it may commit by itself once inactive with every request done: an upgrade transaction only after its
      // `upgradeneeded`, whose listeners are where its requests come from)
      armed: mode !== 'versionchange',
      saved: new Map(),
      handles: new Map(),
      request: null,
      schema: null
    });
    c.transactions.add(this);
    c.db.transactions.push(this);
    setEventParent(this, () => transactionOf(this).connection);
    schedule(c.db);
  }
}
// Whether `a` and `b` may not run at once: overlapping scopes, either one writing.
const conflicts = (a, b) => (a.mode !== 'readonly' || b.mode !== 'readonly') && a.scope.some((name) => b.scope.includes(name));
// The database's transactions started as each may — a request of a started one run, a task at a time.
function schedule(db) {
  for (const tx of db.transactions) {
    const t = transactionOf(tx);
    if (t.state === 'finished' || t.started) continue;
    const earlier = db.transactions.slice(0, db.transactions.indexOf(tx));
    if (earlier.some((e) => transactionOf(e).state !== 'finished' && transactionOf(e).started && conflicts(transactionOf(e), t))) continue;
    if (earlier.some((e) => transactionOf(e).state !== 'finished' && !transactionOf(e).started && conflicts(transactionOf(e), t))) continue;
    t.started = true;
  }
  for (const tx of db.transactions.slice()) {
    runNext(tx);
    maybeCommit(tx);
    finishCommit(tx);
  }
}
// "Asynchronously execute a request": its operation run, a task later, after every earlier one of its transaction's.
function addRequest(tx, request, operation) {
  transactionOf(tx).requests.push({ request, operation });
  runNext(tx);
  return request;
}
function runNext(tx) {
  const t = transactionOf(tx);
  if (!t.started || t.running || t.state === 'finished') return;
  if (t.requests.length === 0) return;
  t.running = true;
  queueTask(() => {
    t.running = false;
    // (…none processed meanwhile but by an abort, which finished the transaction)
    if (t.state === 'finished') return;
    const entry = t.requests.shift();
    let result, failure = null;
    try { result = entry.operation(); } catch (e) { failure = e; }
    // (…an operation of the platform's own, with no request: an index populated, which failing aborts the transaction)
    if (entry.request === null) {
      if (failure !== null) abortTransaction(tx, failure);
      else {
        runNext(tx);
        maybeCommit(tx);
        finishCommit(tx);
      }
      return;
    }
    // (…one failing in a transaction `commit()` was called on aborts it, the request still unprocessed — told an
    // AbortError with the others)
    if (failure !== null && t.state === 'committing') {
      t.requests.unshift(entry);
      abortTransaction(tx, failure);
      return;
    }
    const r = requestOf(entry.request);
    r.done = true;
    if (failure === null) {
      r.result = result;
      r.error = null;
      fireSuccess(tx, entry.request);
    } else {
      r.result = undefined;
      r.error = failure;
      fireError(tx, entry.request, failure);
    }
    if (t.state !== 'finished') {
      runNext(tx);
      maybeCommit(tx);
      finishCommit(tx);
    }
  });
}
// "Fire a success event" / "fire an error event" at a request, its transaction active while its listeners run — and,
// where it still is after them, inactive again, aborted if a listener threw or, for an error no listener canceled, with
// the request's error. (A listener that committed it, or aborted it, left it so.)
function fireSuccess(tx, request) {
  const t = transactionOf(tx);
  if (t.state === 'inactive') t.state = 'active';
  const e = event('success', false, false);
  fire(request, e);
  if (t.state !== 'active') return;
  t.state = 'inactive';
  if (eventState(e).listenersThrew) abortTransaction(tx, error('AbortError', 'A listener threw.'));
}
function fireError(tx, request, failure) {
  const t = transactionOf(tx);
  if (t.state === 'inactive') t.state = 'active';
  const e = event('error', true, true);
  const notCanceled = fire(request, e);
  if (t.state !== 'active') return;
  t.state = 'inactive';
  if (eventState(e).listenersThrew) abortTransaction(tx, error('AbortError', 'A listener threw.'));
  else if (notCanceled) abortTransaction(tx, failure);
}
// A started transaction inactive with every request done commits.
function maybeCommit(tx) {
  const t = transactionOf(tx);
  if (t.state === 'inactive' && t.started && t.armed && allProcessed(t)) commitTransaction(tx);
}
const allProcessed = (t) => !t.running && t.requests.length === 0;
// "Commit a transaction": committing at once — no request made after — and, once its requests are done, `complete` a
// task later, and an upgrade's open request answered after.
function commitTransaction(tx) {
  transactionOf(tx).state = 'committing';
  finishCommit(tx);
}
function finishCommit(tx) {
  const t = transactionOf(tx);
  if (t.state !== 'committing' || !t.started || !allProcessed(t) || t.finishing) return;
  t.finishing = true;
  queueTask(() => {
    if (t.state !== 'committing') return;
    t.state = 'finished';
    t.saved.clear();
    t.schema = null;
    finished(tx);
    // (…an upgrade transaction no longer its connection's as its event fires: a schema change there is no change of it)
    if (t.request) connectionOf(t.connection).upgrade = null;
    fire(tx, event('complete', false, false));
    if (t.request) {
      requestOf(t.request).transaction = null;
      t.onFinish?.(false);
    }
  });
}
// "Abort a transaction": what it wrote put back (an upgrade's schema and version too), its unprocessed requests each
// failed with an AbortError, then `abort` — bubbling to its connection. It is finished at once, its events a task later.
function abortTransaction(tx, reason) {
  const t = transactionOf(tx);
  if (t.state === 'finished') return;
  for (const [store, saved] of t.saved) restoreStore(store, saved);
  if (t.schema !== null) restoreSchema(t);
  t.state = 'finished';
  if (reason !== null) t.error = reason;
  const unprocessed = t.requests;
  t.requests = [];
  for (const entry of unprocessed) {
    if (entry.request === null) continue;
    const request = entry.request, r = requestOf(request);
    queueTask(() => {
      r.done = true;
      r.result = undefined;
      r.error = error('AbortError', 'The transaction was aborted.');
      fire(request, event('error', true, true));
    });
  }
  queueTask(() => {
    finished(tx);
    if (t.request) connectionOf(t.connection).upgrade = null;
    fire(tx, event('abort', true, false));
    if (t.request) {
      const r = requestOf(t.request);
      r.transaction = null;
      r.result = undefined;
      t.onFinish?.(true);
    }
  });
}
// …and gone from its database's schedule, which may start the next.
function finished(tx) {
  const t = transactionOf(tx), c = connectionOf(t.connection);
  t.db.transactions.splice(t.db.transactions.indexOf(tx), 1);
  c.transactions.delete(tx);
  if (c.closePending && c.transactions.size === 0) closed(t.connection);
  schedule(t.db);
}
// A store's state before a transaction first wrote it — its records, key generator and indexes' records — which an
// abort puts back.
function touch(tx, store) {
  const saved = transactionOf(tx).saved;
  if (saved.has(store)) return;
  saved.set(store, {
    records: store.records.slice(),
    current: store.current,
    indexes: new Map([...store.indexes.values()].map((index) => [index, index.records.slice()]))
  });
}
function restoreStore(store, saved) {
  store.records = saved.records;
  store.current = saved.current;
  for (const [index, records] of saved.indexes) index.records = records;
}
// An upgrade's schema as it began: the database's version, and each store with its indexes — names, key paths and
// records — which an abort puts back (stores made since deleted, those deleted come back).
function saveSchema(db) {
  return {
    version: db.version,
    stores: new Map([...db.stores].map(([name, store]) => [name, {
      store,
      name: store.name,
      records: store.records.slice(),
      current: store.current,
      indexes: new Map([...store.indexes].map(([n, index]) => [n, { index, name: index.name, records: index.records.slice() }]))
    }]))
  };
}
function restoreSchema(t) {
  const db = t.db, schema = t.schema;
  db.version = schema.version;
  // (…every store and index as the upgrade left it deleted, a store made in it with none: those it began with come back)
  for (const store of db.stores.values()) {
    store.deleted = true;
    for (const index of store.indexes.values()) index.deleted = true;
    store.indexes = new Map();
  }
  db.stores = new Map();
  for (const [name, s] of schema.stores) {
    Object.assign(s.store, { name: s.name, records: s.records, current: s.current, deleted: false, indexes: new Map(), retiring: [] });
    for (const [n, i] of s.indexes) {
      Object.assign(i.index, { name: i.name, records: i.records, deleted: false });
      s.store.indexes.set(n, i.index);
    }
    db.stores.set(name, s.store);
  }
  const c = connectionOf(t.connection);
  c.version = schema.version;
  c.storeNames = [...db.stores.keys()].sort();
  // (…and the transaction's handles their stores' and indexes' names again)
  for (const handle of t.handles.values()) {
    const h = storeOf(handle);
    h.name = h.store.name;
    for (const indexHandle of h.indexes.values()) indexOf(indexHandle).name = indexOf(indexHandle).index.name;
  }
}

installIDBTransaction(IDBTransaction, ownRealm(REALM, 'IDBTransaction', transactionOf, {
  get_objectStoreNames(tx) {
    const t = transactionOf(tx);
    return domStringList(t.mode === 'versionchange' ? connectionOf(t.connection).storeNames.slice() : t.scope.slice());
  },
  get_mode: (tx) => transactionOf(tx).mode,
  get_durability: (tx) => transactionOf(tx).durability,
  get_db: (tx) => transactionOf(tx).connection,
  get_error: (tx) => transactionOf(tx).error,
  objectStore(tx, name) {
    const t = transactionOf(tx);
    if (t.state === 'finished') throw error('InvalidStateError', 'The transaction has finished.');
    const inScope = t.mode === 'versionchange' ? t.db.stores.has(name) : t.scope.includes(name);
    if (!inScope) throw error('NotFoundError', 'The specified object store was not found.');
    return storeHandle(tx, t.db.stores.get(name));
  },
  commit(tx) {
    const t = transactionOf(tx);
    if (t.state !== 'active') throw error('InvalidStateError', 'The transaction is not active.');
    commitTransaction(tx);
  },
  abort(tx) {
    const t = transactionOf(tx);
    if (t.state === 'committing' || t.state === 'finished') throw error('InvalidStateError', 'The transaction has finished.');
    abortTransaction(tx, null);
  },
  installEventHandlers
}));

// ── Connections: IDBDatabase (§4.4) ──────────────────────────────────────────────────────────────────────────────────
// A connection's slots: its database, version, store names (as of its last upgrade), whether it is closing or closed,
// its transactions and its upgrade transaction.
const connectionOf = (o) => slotsOf(o, 'IDBDatabase');
registerInterface('IDBDatabase', (o) => connectionOf(o) !== undefined);
class IDBDatabase extends EventTarget {
  constructor(token, db) {
    constructedBy(PLATFORM, token, 'IDBDatabase');
    super();
    makeSlots(this, 'IDBDatabase', {
      realm: REALM,
      db,
      version: db.version,
      storeNames: [...db.stores.keys()].sort(),
      closePending: false,
      closed: false,
      transactions: new Set(),
      upgrade: null
    });
    db.connections.add(this);
  }
}
// "Close a database connection": closing at once, closed once its transactions are done.
function closeConnection(connection) {
  const c = connectionOf(connection);
  c.closePending = true;
  if (c.transactions.size === 0) closed(connection);
}
function closed(connection) {
  const c = connectionOf(connection);
  if (c.closed) return;
  c.closed = true;
  c.db.connections.delete(connection);
  c.db.waiters.splice(0).forEach((resume) => resume());
}
// The upgrade transaction a schema change needs, active — an InvalidStateError or TransactionInactiveError otherwise.
function activeUpgrade(transaction, member) {
  const t = transaction && transactionOf(transaction);
  if (!t || t.mode !== 'versionchange') throw error('InvalidStateError', `Failed to execute '${member}': the database is not running a version change transaction.`);
  if (t.state !== 'active') throw error('TransactionInactiveError', `Failed to execute '${member}': the transaction is not active.`);
  return t;
}
installIDBDatabase(IDBDatabase, ownRealm(REALM, 'IDBDatabase', connectionOf, {
  get_name: (connection) => connectionOf(connection).db.name,
  get_version: (connection) => connectionOf(connection).version,
  get_objectStoreNames: (connection) => domStringList(connectionOf(connection).storeNames.slice()),
  transaction(connection, storeNames, mode, options) {
    const c = connectionOf(connection);
    if (c.upgrade && transactionOf(c.upgrade).state !== 'finished') throw error('InvalidStateError', 'A version change transaction is running.');
    if (c.closePending) throw error('InvalidStateError', 'The database connection is closing.');
    const scope = [...new Set(typeof storeNames === 'string' ? [storeNames] : storeNames)].sort();
    for (const name of scope) {
      if (!c.db.stores.has(name)) throw error('NotFoundError', 'One of the specified object stores was not found.');
    }
    if (scope.length === 0) throw error('InvalidAccessError', 'The transaction scope is empty.');
    if (mode !== 'readonly' && mode !== 'readwrite') throw new TypeError(`Failed to execute 'transaction' on 'IDBDatabase': The mode provided ('${mode}') is not one of 'readonly' or 'readwrite'.`);
    const tx = new IDBTransaction(PLATFORM, connection, scope, mode, options.durability, 'active');
    // (…inactive once this task's microtasks have run: HTML "cleanup Indexed Database transactions" — its cleanup event
    // loop this one)
    afterMicrotaskCheckpoint(() => {
      const t = transactionOf(tx);
      if (t.state === 'active') {
        t.state = 'inactive';
        maybeCommit(tx);
      }
    });
    return tx;
  },
  close: (connection) => closeConnection(connection),
  createObjectStore(connection, name, options) {
    const c = connectionOf(connection), t = activeUpgrade(c.upgrade, 'createObjectStore');
    const keyPath = options.keyPath ?? null;
    if (keyPath !== null && !isValidKeyPath(keyPath)) throw error('SyntaxError', 'The keyPath option is not a valid key path.');
    if (c.db.stores.has(name)) throw error('ConstraintError', 'An object store with the specified name already exists.');
    if (options.autoIncrement && (keyPath === '' || Array.isArray(keyPath))) {
      throw error('InvalidAccessError', 'The autoIncrement option was set but the keyPath option was empty or an array.');
    }
    const store = { name, keyPath, current: options.autoIncrement ? 1 : null, records: [], indexes: new Map(), retiring: [], deleted: false };
    c.db.stores.set(name, store);
    c.storeNames = [...c.db.stores.keys()].sort();
    return storeHandle(c.upgrade, store, t);
  },
  deleteObjectStore(connection, name) {
    const c = connectionOf(connection);
    activeUpgrade(c.upgrade, 'deleteObjectStore');
    const store = c.db.stores.get(name);
    if (!store) throw error('NotFoundError', 'The specified object store was not found.');
    store.deleted = true;
    for (const index of store.indexes.values()) index.deleted = true;
    store.indexes = new Map();
    c.db.stores.delete(name);
    c.storeNames = [...c.db.stores.keys()].sort();
  },
  installEventHandlers
}));

// ── Object stores (§4.5) and indexes (§4.6) ──────────────────────────────────────────────────────────────────────────
// A store handle's slots: its store, its name as of its making (a rename in a later transaction not its), its
// transaction, its index handles, and its key path's value ([SameObject]).
const storeOf = (o) => slotsOf(o, 'IDBObjectStore');
registerInterface('IDBObjectStore', (o) => storeOf(o) !== undefined);
class IDBObjectStore {
  constructor(token, store, transaction) {
    constructedBy(PLATFORM, token, 'IDBObjectStore');
    makeSlots(this, 'IDBObjectStore', { realm: REALM, store, name: store.name, transaction, indexes: new Map(), keyPath: keyPathValue(store.keyPath) });
  }
}
// (…the same object for a store in one transaction)
function storeHandle(tx, store) {
  const handles = transactionOf(tx).handles;
  let handle = handles.get(store);
  if (!handle) handles.set(store, handle = new IDBObjectStore(PLATFORM, store, tx));
  return handle;
}
// A handle's store and transaction, checked: a deleted store an InvalidStateError, an inactive transaction a
// TransactionInactiveError — and, for a write, a read-only one a ReadOnlyError.
function usable(handle, write = false) {
  const s = storeOf(handle), t = transactionOf(s.transaction);
  if (s.store.deleted) throw error('InvalidStateError', 'The object store has been deleted.');
  if (t.state !== 'active') throw error('TransactionInactiveError', 'The transaction is not active.');
  if (write && t.mode === 'readonly') throw error('ReadOnlyError', 'The transaction is read-only.');
  return s;
}
// A value cloned as a page's code may see it run: the transaction inactive meanwhile.
function cloneDuring(tx, value) {
  const t = transactionOf(tx), state = t.state;
  t.state = 'inactive';
  try { return structuredClone(value); } finally { t.state = state; }
}
function putOrAdd(handle, value, key, noOverwrite) {
  const s = usable(handle, true), store = s.store, tx = s.transaction;
  if (store.keyPath !== null && key !== undefined) throw error('DataError', 'The object store uses in-line keys and the key parameter was provided.');
  if (store.keyPath === null && store.current === null && key === undefined) {
    throw error('DataError', 'The object store uses out-of-line keys and has no key generator and the key parameter was not provided.');
  }
  let k = key === undefined ? undefined : keyOf(key);
  const clone = cloneDuring(tx, value);
  if (store.keyPath !== null) {
    const extracted = extractKey(clone, store.keyPath);
    if (extracted === INVALID) throw error('DataError', 'Evaluating the object store\'s key path yielded a value that is not a valid key.');
    if (extracted !== FAILURE) k = extracted;
    else if (store.current === null) throw error('DataError', 'Evaluating the object store\'s key path did not yield a value.');
    else if (!canInjectKey(clone, store.keyPath)) throw error('DataError', 'A generated key could not be inserted into the value.');
  }
  return addRequest(tx, new IDBRequest(PLATFORM, handle, tx), () => {
    touch(tx, store);
    return keyToValue(storeRecord(store, clone, k, noOverwrite));
  });
}
// "Create a request to retrieve multiple items": a key range or key first and a count — or an IDBGetAllOptions.
function isPotentiallyValidKeyRange(value) {
  return rangeOf(value) !== undefined || typeof value === 'number' || typeof value === 'string' || isDate(value) ||
    ArrayBuffer.isView(value) || isArrayBuffer(value) || isArray(value);
}
// (…getAllRecords' options converted already; getAll's and getAllKeys' an IDBGetAllOptions where they are no key range)
function getAllOptions(member, queryOrOptions, count) {
  if (queryOrOptions === undefined || queryOrOptions === null || isPotentiallyValidKeyRange(queryOrOptions)) {
    return { query: queryOrOptions, count, direction: 'next' };
  }
  return toIDBGetAllOptions(queryOrOptions, `Failed to execute '${member}': `);
}
// A request of `source`'s records in the options' range and direction, at most their count, as `type` asks.
function retrieving(source, tx, handle, type, options) {
  const range = rangeFrom(options.query);
  return addRequest(tx, new IDBRequest(PLATFORM, handle, tx), () => retrieve(source, range, options.direction, options.count, type));
}
installIDBObjectStore(IDBObjectStore, ownRealm(REALM, 'IDBObjectStore', storeOf, {
  get_name: (handle) => storeOf(handle).name,
  set_name(handle, name) {
    const s = storeOf(handle), t = transactionOf(s.transaction);
    if (t.mode !== 'versionchange') throw error('InvalidStateError', 'The object store can only be renamed in a version change transaction.');
    if (s.store.deleted) throw error('InvalidStateError', 'The object store has been deleted.');
    if (t.state !== 'active') throw error('TransactionInactiveError', 'The transaction is not active.');
    if (s.store.name === name) return;
    if (t.db.stores.has(name)) throw error('ConstraintError', 'An object store with the specified name already exists.');
    t.db.stores.delete(s.store.name);
    s.store.name = s.name = name;
    t.db.stores.set(name, s.store);
    connectionOf(t.connection).storeNames = [...t.db.stores.keys()].sort();
  },
  get_keyPath: (handle) => storeOf(handle).keyPath,
  get_indexNames: (handle) => domStringList([...storeOf(handle).store.indexes.keys()].sort()),
  get_transaction: (handle) => storeOf(handle).transaction,
  get_autoIncrement: (handle) => storeOf(handle).store.current !== null,
  put: (handle, value, key) => putOrAdd(handle, value, key, false),
  add: (handle, value, key) => putOrAdd(handle, value, key, true),
  delete(handle, query) {
    const s = usable(handle, true), range = rangeFrom(query, true);
    return addRequest(s.transaction, new IDBRequest(PLATFORM, handle, s.transaction), () => {
      touch(s.transaction, s.store);
      deleteRecordsIn(s.store, range);
    });
  },
  clear(handle) {
    const s = usable(handle, true);
    return addRequest(s.transaction, new IDBRequest(PLATFORM, handle, s.transaction), () => {
      touch(s.transaction, s.store);
      deleteRecordsIn(s.store, UNBOUNDED);
    });
  },
  get(handle, query) {
    const s = usable(handle), range = rangeFrom(query, true);
    return addRequest(s.transaction, new IDBRequest(PLATFORM, handle, s.transaction), () => retrieve(s.store, range, 'next', 1, 'value')[0]);
  },
  getKey(handle, query) {
    const s = usable(handle), range = rangeFrom(query, true);
    return addRequest(s.transaction, new IDBRequest(PLATFORM, handle, s.transaction), () => retrieve(s.store, range, 'next', 1, 'key')[0]);
  },
  getAll(handle, queryOrOptions, count) {
    const s = usable(handle);
    return retrieving(s.store, s.transaction, handle, 'value', getAllOptions('getAll', queryOrOptions, count));
  },
  getAllKeys(handle, queryOrOptions, count) {
    const s = usable(handle);
    return retrieving(s.store, s.transaction, handle, 'key', getAllOptions('getAllKeys', queryOrOptions, count));
  },
  getAllRecords(handle, options) {
    const s = usable(handle);
    return retrieving(s.store, s.transaction, handle, 'record', options);
  },
  count(handle, query) {
    const s = usable(handle), range = rangeFrom(query);
    return addRequest(s.transaction, new IDBRequest(PLATFORM, handle, s.transaction), () => spanLength(rangeSpan(s.store.records, range)));
  },
  openCursor: (handle, query, direction) => openCursor(handle, query, direction, false),
  openKeyCursor: (handle, query, direction) => openCursor(handle, query, direction, true),
  index(handle, name) {
    const s = storeOf(handle), t = transactionOf(s.transaction);
    if (s.store.deleted) throw error('InvalidStateError', 'The object store has been deleted.');
    if (t.state === 'finished') throw error('InvalidStateError', 'The transaction has finished.');
    const index = s.store.indexes.get(name);
    if (!index) throw error('NotFoundError', 'The specified index was not found.');
    let indexHandle = s.indexes.get(index);
    if (!indexHandle) s.indexes.set(index, indexHandle = new IDBIndex(PLATFORM, index, handle));
    return indexHandle;
  },
  createIndex(handle, name, keyPath, options) {
    const s = storeOf(handle), t = transactionOf(s.transaction);
    if (t.mode !== 'versionchange') throw error('InvalidStateError', 'Indexes can only be created in a version change transaction.');
    if (s.store.deleted) throw error('InvalidStateError', 'The object store has been deleted.');
    if (t.state !== 'active') throw error('TransactionInactiveError', 'The transaction is not active.');
    if (s.store.indexes.has(name)) throw error('ConstraintError', 'An index with the specified name already exists.');
    if (!isValidKeyPath(keyPath)) throw error('SyntaxError', 'The keyPath argument is not a valid key path.');
    if (Array.isArray(keyPath) && options.multiEntry) throw error('InvalidAccessError', 'The keyPath argument was an array and the multiEntry option is true.');
    const index = { name, keyPath, unique: options.unique, multiEntry: options.multiEntry, records: [], store: s.store, deleted: false, populated: false };
    s.store.indexes.set(name, index);
    // (…its records the store's as the requests before this one leave it, indexed in the transaction's order — a unique
    // index two records share a key in aborting the upgrade with a ConstraintError)
    addRequest(s.transaction, null, () => {
      for (const r of s.store.records) {
        for (const k of indexKeysOf(index, r.value)) {
          if (index.unique && uniqueKeyTaken(index, k)) {
            throw error('ConstraintError', 'Unable to create the unique index: the object store holds records that share a key in it.');
          }
          indexInsert(index, k, r.key);
        }
      }
      index.populated = true;
    });
    const indexHandle = new IDBIndex(PLATFORM, index, handle);
    s.indexes.set(index, indexHandle);
    return indexHandle;
  },
  deleteIndex(handle, name) {
    const s = storeOf(handle), t = transactionOf(s.transaction);
    if (t.mode !== 'versionchange') throw error('InvalidStateError', 'Indexes can only be deleted in a version change transaction.');
    if (s.store.deleted) throw error('InvalidStateError', 'The object store has been deleted.');
    if (t.state !== 'active') throw error('TransactionInactiveError', 'The transaction is not active.');
    const index = s.store.indexes.get(name);
    if (!index) throw error('NotFoundError', 'The specified index was not found.');
    index.deleted = true;
    s.store.indexes.delete(name);
    s.store.retiring.push(index);
    addRequest(s.transaction, null, () => { s.store.retiring.splice(s.store.retiring.indexOf(index), 1); });
  }
}));

// An index handle's slots: its index, its name as of its making, its store handle, and its key path's value.
const indexOf = (o) => slotsOf(o, 'IDBIndex');
registerInterface('IDBIndex', (o) => indexOf(o) !== undefined);
class IDBIndex {
  constructor(token, index, storeHandle) {
    constructedBy(PLATFORM, token, 'IDBIndex');
    makeSlots(this, 'IDBIndex', { realm: REALM, index, name: index.name, storeHandle, keyPath: keyPathValue(index.keyPath) });
  }
}
function usableIndex(handle) {
  const i = indexOf(handle), s = storeOf(i.storeHandle), t = transactionOf(s.transaction);
  if (i.index.deleted || s.store.deleted) throw error('InvalidStateError', 'The index or its object store has been deleted.');
  if (t.state !== 'active') throw error('TransactionInactiveError', 'The transaction is not active.');
  return { index: i.index, tx: s.transaction };
}
installIDBIndex(IDBIndex, ownRealm(REALM, 'IDBIndex', indexOf, {
  get_name: (handle) => indexOf(handle).name,
  set_name(handle, name) {
    const i = indexOf(handle), s = storeOf(i.storeHandle), t = transactionOf(s.transaction);
    if (t.mode !== 'versionchange') throw error('InvalidStateError', 'The index can only be renamed in a version change transaction.');
    if (i.index.deleted || s.store.deleted) throw error('InvalidStateError', 'The index or its object store has been deleted.');
    if (t.state !== 'active') throw error('TransactionInactiveError', 'The transaction is not active.');
    if (i.index.name === name) return;
    if (s.store.indexes.has(name)) throw error('ConstraintError', 'An index with the specified name already exists.');
    s.store.indexes.delete(i.index.name);
    i.index.name = i.name = name;
    s.store.indexes.set(name, i.index);
  },
  get_objectStore: (handle) => indexOf(handle).storeHandle,
  get_keyPath: (handle) => indexOf(handle).keyPath,
  get_multiEntry: (handle) => indexOf(handle).index.multiEntry,
  get_unique: (handle) => indexOf(handle).index.unique,
  get(handle, query) {
    const u = usableIndex(handle), range = rangeFrom(query, true);
    return addRequest(u.tx, new IDBRequest(PLATFORM, handle, u.tx), () => retrieve(u.index, range, 'next', 1, 'value')[0]);
  },
  getKey(handle, query) {
    const u = usableIndex(handle), range = rangeFrom(query, true);
    return addRequest(u.tx, new IDBRequest(PLATFORM, handle, u.tx), () => retrieve(u.index, range, 'next', 1, 'key')[0]);
  },
  getAll(handle, queryOrOptions, count) {
    const u = usableIndex(handle);
    return retrieving(u.index, u.tx, handle, 'value', getAllOptions('getAll', queryOrOptions, count));
  },
  getAllKeys(handle, queryOrOptions, count) {
    const u = usableIndex(handle);
    return retrieving(u.index, u.tx, handle, 'key', getAllOptions('getAllKeys', queryOrOptions, count));
  },
  getAllRecords(handle, options) {
    const u = usableIndex(handle);
    return retrieving(u.index, u.tx, handle, 'record', options);
  },
  count(handle, query) {
    const u = usableIndex(handle), range = rangeFrom(query);
    return addRequest(u.tx, new IDBRequest(PLATFORM, handle, u.tx), () => spanLength(rangeSpan(u.index.records, range)));
  },
  openCursor: (handle, query, direction) => openCursor(handle, query, direction, false),
  openKeyCursor: (handle, query, direction) => openCursor(handle, query, direction, true)
}));

// ── Cursors (§4.8) ───────────────────────────────────────────────────────────────────────────────────────────────────
// A cursor's slots: its source (a store or index handle) and the store or index behind it, transaction, request,
// direction, range, whether it reads keys only, its position (and an index cursor's object store position), its key,
// primary key and value — each read back as the same object until it moves — and whether it holds a value.
const cursorOf = (o) => slotsOf(o, 'IDBCursor');
registerInterface('IDBCursor', (o) => cursorOf(o) !== undefined);
registerInterface('IDBCursorWithValue', (o) => slotsOf(o, 'IDBCursorWithValue') !== undefined);
class IDBCursor {
  constructor(token, fields) {
    constructedBy(PLATFORM, token, new.target.name);
    makeSlots(this, 'IDBCursor', { realm: REALM, ...fields });
  }
}
class IDBCursorWithValue extends IDBCursor {
  constructor(token, fields) {
    super(token, fields);
    makeSlots(this, 'IDBCursorWithValue');
  }
}
function openCursor(handle, query, direction, keyOnly) {
  const isIndex = indexOf(handle) !== undefined;
  const u = isIndex ? usableIndex(handle) : (() => { const s = usable(handle); return { store: s.store, tx: s.transaction }; })();
  const range = rangeFrom(query);
  const request = new IDBRequest(PLATFORM, handle, u.tx);
  const fields = {
    source: handle,
    target: isIndex ? u.index : u.store,
    isIndex,
    transaction: u.tx,
    request,
    direction,
    range,
    keyOnly,
    position: undefined,
    objectStorePosition: undefined,
    key: undefined,
    primaryKey: undefined,
    value: undefined,
    keyValue: undefined,
    primaryKeyValue: undefined,
    gotValue: false
  };
  const cursor = keyOnly ? new IDBCursor(PLATFORM, fields) : new IDBCursorWithValue(PLATFORM, fields);
  return addRequest(u.tx, request, () => iterateCursor(cursor, undefined, undefined, 1));
}
// "Iterate a cursor" `count` times, past `key` (and, continuing an index cursor by primary key, `primaryKey`): the
// cursor moved and holding the record found, or null where there is none.
function iterateCursor(cursor, key, primaryKey, count) {
  const c = cursorOf(cursor), forward = c.direction === 'next' || c.direction === 'nextunique', unique = c.direction.endsWith('unique');
  const records = c.target.records, [lo, hi] = rangeSpan(records, c.range);
  // (…a record's place against a key and, where one is given, a primary key — an object store's records their own)
  const primaryKeyOf = c.isIndex ? (r) => r.primaryKey : (r) => r.key;
  const against = (k, p) => (r) => compareKeys(r.key, k) || (p === undefined ? 0 : compareKeys(primaryKeyOf(r), p));
  const atOrPast = (k, p) => sortedSearch(records, against(k, p));
  const past = (k, p) => { const cmp = against(k, p); return sortedSearch(records, (r) => (cmp(r) <= 0 ? -1 : 1)); };
  let position = c.position, osPosition = c.objectStorePosition, found;
  for (let n = 0; n < count; n++) {
    // (…the records that satisfy it are a run of the sorted ones: in the range, past `key`, past the position)
    const byPosition = unique || !c.isIndex ? undefined : osPosition;
    let i;
    if (forward) {
      i = lo;
      if (key !== undefined) i = Math.max(i, atOrPast(key, primaryKey));
      if (position !== undefined) i = Math.max(i, past(position, byPosition));
      found = i < hi ? records[i] : undefined;
    } else {
      i = hi;
      if (key !== undefined) i = Math.min(i, past(key, primaryKey));
      if (position !== undefined) i = Math.min(i, atOrPast(position, byPosition));
      i--;
      found = i >= lo ? records[i] : undefined;
      // (…`prevunique` the first record of the key it lands on)
      if (found && c.direction === 'prevunique') found = records[Math.max(lo, atOrPast(found.key))];
    }
    if (!found) {
      c.key = c.value = c.primaryKey = c.keyValue = c.primaryKeyValue = undefined;
      c.gotValue = false;
      return null;
    }
    position = found.key;
    osPosition = primaryKeyOf(found);
    key = primaryKey = undefined;
  }
  c.position = position;
  c.objectStorePosition = c.isIndex ? osPosition : undefined;
  c.key = found.key;
  c.primaryKey = osPosition;
  c.keyValue = keyToValue(found.key);
  c.primaryKeyValue = c.isIndex ? keyToValue(osPosition) : c.keyValue;
  if (!c.keyOnly) {
    const store = c.isIndex ? c.target.store : c.target;
    c.value = structuredClone(c.isIndex ? findRecord(store, osPosition).value : found.value);
  }
  c.gotValue = true;
  return cursor;
}
// The cursor's checks before it moves or writes: an inactive transaction, a deleted source, a cursor holding nothing.
function cursorUsable(cursor, member) {
  const c = cursorOf(cursor), t = transactionOf(c.transaction);
  if (t.state !== 'active') throw error('TransactionInactiveError', `Failed to execute '${member}' on 'IDBCursor': The transaction is not active.`);
  const store = c.isIndex ? c.target.store : c.target;
  if (c.target.deleted || store.deleted) throw error('InvalidStateError', `Failed to execute '${member}' on 'IDBCursor': The cursor's source or effective object store has been deleted.`);
  return c;
}
function moveCursor(cursor, key, primaryKey, count) {
  const c = cursorOf(cursor);
  c.gotValue = false;
  requestOf(c.request).done = false;
  addRequest(c.transaction, c.request, () => iterateCursor(cursor, key, primaryKey, count));
}
installIDBCursor(IDBCursor, ownRealm(REALM, 'IDBCursor', cursorOf, {
  get_source: (cursor) => cursorOf(cursor).source,
  get_direction: (cursor) => cursorOf(cursor).direction,
  get_key: (cursor) => cursorOf(cursor).keyValue,
  get_primaryKey: (cursor) => cursorOf(cursor).primaryKeyValue,
  get_request: (cursor) => cursorOf(cursor).request,
  advance(cursor, count) {
    if (count === 0) throw new TypeError("Failed to execute 'advance' on 'IDBCursor': A count argument with value 0 (zero) was supplied, must be greater than 0.");
    const c = cursorUsable(cursor, 'advance');
    if (!c.gotValue) throw error('InvalidStateError', "Failed to execute 'advance' on 'IDBCursor': The cursor is being iterated or has iterated past its end.");
    moveCursor(cursor, undefined, undefined, count);
  },
  continue(cursor, key) {
    const c = cursorUsable(cursor, 'continue');
    if (!c.gotValue) throw error('InvalidStateError', "Failed to execute 'continue' on 'IDBCursor': The cursor is being iterated or has iterated past its end.");
    let k;
    if (key !== undefined) {
      k = keyOf(key);
      const forward = c.direction === 'next' || c.direction === 'nextunique', cmp = compareKeys(k, c.position);
      if (forward ? cmp <= 0 : cmp >= 0) throw error('DataError', "Failed to execute 'continue' on 'IDBCursor': The parameter is less than or equal to this cursor's position.");
    }
    moveCursor(cursor, k, undefined, 1);
  },
  continuePrimaryKey(cursor, key, primaryKey) {
    const c = cursorUsable(cursor, 'continuePrimaryKey');
    if (!c.isIndex) throw error('InvalidAccessError', "Failed to execute 'continuePrimaryKey' on 'IDBCursor': The cursor's source is not an index.");
    if (c.direction !== 'next' && c.direction !== 'prev') throw error('InvalidAccessError', "Failed to execute 'continuePrimaryKey' on 'IDBCursor': The cursor's direction is not 'next' or 'prev'.");
    if (!c.gotValue) throw error('InvalidStateError', "Failed to execute 'continuePrimaryKey' on 'IDBCursor': The cursor is being iterated or has iterated past its end.");
    const k = keyOf(key), p = keyOf(primaryKey);
    const kc = compareKeys(k, c.position), pc = compareKeys(p, c.objectStorePosition);
    const before = c.direction === 'next' ? kc < 0 || (kc === 0 && pc <= 0) : kc > 0 || (kc === 0 && pc >= 0);
    if (before) throw error('DataError', "Failed to execute 'continuePrimaryKey' on 'IDBCursor': The key is not past this cursor's position.");
    moveCursor(cursor, k, p, 1);
  },
  update(cursor, value) {
    const c = cursorOf(cursor), t = transactionOf(c.transaction);
    if (t.state !== 'active') throw error('TransactionInactiveError', "Failed to execute 'update' on 'IDBCursor': The transaction is not active.");
    if (t.mode === 'readonly') throw error('ReadOnlyError', "Failed to execute 'update' on 'IDBCursor': The record may not be updated inside a read-only transaction.");
    cursorUsable(cursor, 'update');
    if (!c.gotValue || c.keyOnly) throw error('InvalidStateError', "Failed to execute 'update' on 'IDBCursor': The cursor is being iterated or has iterated past its end.");
    const store = c.isIndex ? c.target.store : c.target;
    const clone = cloneDuring(c.transaction, value);
    if (store.keyPath !== null) {
      const k = extractKey(clone, store.keyPath);
      if (k === FAILURE || k === INVALID || compareKeys(k, c.primaryKey) !== 0) {
        throw error('DataError', "Failed to execute 'update' on 'IDBCursor': The effective object store of this cursor uses in-line keys and evaluating the key path of the value parameter results in a different value than the cursor's effective key.");
      }
    }
    const key = c.primaryKey;
    return addRequest(c.transaction, new IDBRequest(PLATFORM, cursor, c.transaction), () => {
      touch(c.transaction, store);
      return keyToValue(storeRecord(store, clone, key, false));
    });
  },
  delete(cursor) {
    const c = cursorOf(cursor), t = transactionOf(c.transaction);
    if (t.state !== 'active') throw error('TransactionInactiveError', "Failed to execute 'delete' on 'IDBCursor': The transaction is not active.");
    if (t.mode === 'readonly') throw error('ReadOnlyError', "Failed to execute 'delete' on 'IDBCursor': The record may not be deleted inside a read-only transaction.");
    cursorUsable(cursor, 'delete');
    if (!c.gotValue || c.keyOnly) throw error('InvalidStateError', "Failed to execute 'delete' on 'IDBCursor': The cursor is being iterated or has iterated past its end.");
    const store = c.isIndex ? c.target.store : c.target, key = c.primaryKey;
    return addRequest(c.transaction, new IDBRequest(PLATFORM, cursor, c.transaction), () => {
      touch(c.transaction, store);
      deleteRecordsIn(store, onlyRange(key));
    });
  }
}));
installIDBCursorWithValue(IDBCursorWithValue, { get_value: (cursor) => cursorOf(cursor).value });

// ── IDBFactory (§4.3) ────────────────────────────────────────────────────────────────────────────────────────────────
// A database's connection queue (§2.1): an open or a delete request run after every earlier one for its name.
const queues = new Map();
function enqueue(name, step) {
  let queue = queues.get(name);
  if (queue === undefined) queues.set(name, queue = []);
  queue.push(step);
  if (queue.length === 1) queueTask(() => runQueue(name));
}
// (…a name's queue gone once it empties)
function runQueue(name) {
  const queue = queues.get(name);
  queue[0](() => {
    queue.shift();
    if (queue.length) queueTask(() => runQueue(name));
    else queues.delete(name);
  });
}
// The other connections an upgrade or a deletion waits for: each told `versionchange` — a `blocked` at the request
// while any stays open — and the step run once all are closed.
function waitForConnections(db, connection, request, newVersion, step) {
  const others = [...db.connections].filter((c) => c !== connection && !connectionOf(c).closed);
  for (const other of others) {
    if (!connectionOf(other).closePending) fire(other, versionEvent('versionchange', db.version, newVersion));
  }
  const open = () => others.some((c) => !connectionOf(c).closed);
  if (!open()) { step(); return; }
  // (…`blocked` decided once the listeners have run — fired a task later — and the step run a task after the last
  // connection closed)
  queueTask(() => fire(request, versionEvent('blocked', db.version, newVersion)));
  const resume = () => (open() ? db.waiters.push(resume) : queueTask(step));
  resume();
}
function settle(request, result, failure, type = 'success', oldVersion) {
  const r = requestOf(request);
  r.done = true;
  if (failure) {
    r.result = undefined;
    r.error = failure;
    fire(request, event('error', true, true));
  } else {
    r.result = result;
    r.error = null;
    fire(request, oldVersion === undefined ? event(type, false, false) : versionEvent(type, oldVersion, null));
  }
}
// "Open a database connection": the database made where there is none, and upgraded where it is older — its other
// connections waited for, a versionchange transaction run under `upgradeneeded`.
function openDatabase(request, name, version, done) {
  let db = databases.get(name);
  if (version === undefined) version = db ? db.version : 1;
  if (db && db.version > version) {
    settle(request, undefined, error('VersionError', `The requested version (${version}) is less than the existing version (${db.version}).`));
    done();
    return;
  }
  if (!db) databases.set(name, db = { name, version: 0, stores: new Map(), connections: new Set(), transactions: [], waiters: [] });
  const connection = new IDBDatabase(PLATFORM, db);
  if (db.version === version) {
    settle(request, connection, null);
    done();
    return;
  }
  waitForConnections(db, connection, request, version, () => upgrade(request, db, connection, version, done));
}
// "Upgrade a database": the version set, a versionchange transaction over every store fired `upgradeneeded`, and the
// open request answered once it finished — with the connection, or an AbortError and the connection closed.
function upgrade(request, db, connection, version, done) {
  const oldVersion = db.version, c = connectionOf(connection);
  const schema = saveSchema(db);
  db.version = c.version = version;
  const tx = new IDBTransaction(PLATFORM, connection, [...db.stores.keys()].sort(), 'versionchange', 'default', 'inactive');
  const t = transactionOf(tx);
  t.request = request;
  t.schema = schema;
  c.upgrade = tx;
  t.onFinish = (aborted) => {
    if (aborted || c.closePending) {
      closeConnection(connection);
      settle(request, undefined, error('AbortError', 'The version change transaction was aborted.'));
    } else {
      settle(request, connection, null);
    }
    done();
  };
  const r = requestOf(request);
  r.done = true;
  r.result = connection;
  r.transaction = tx;
  t.state = 'active';
  const e = versionEvent('upgradeneeded', oldVersion, version);
  fire(request, e);
  t.armed = true;
  if (t.state === 'active') {
    t.state = 'inactive';
    if (eventState(e).listenersThrew) abortTransaction(tx, error('AbortError', 'A listener threw.'));
  }
  maybeCommit(tx);
}
// "Delete a database": its connections waited for, then gone.
function deleteDatabase(request, name, done) {
  const db = databases.get(name);
  if (!db) {
    settle(request, undefined, null, 'success', 0);
    done();
    return;
  }
  waitForConnections(db, null, request, null, () => {
    const oldVersion = db.version;
    databases.delete(name);
    settle(request, undefined, null, 'success', oldVersion);
    done();
  });
}

// A database's version as its transactions have committed it: an upgrade still running set its own (“considered
// part of the transaction”), and until it commits the version it began from is the one others see.
function committedVersion(db) {
  for (const connection of db.connections) {
    const upgrade = connectionOf(connection).upgrade;
    if (upgrade) return transactionOf(upgrade).schema.version;
  }
  return db.version;
}

registerInterface('IDBFactory', (o) => slotsOf(o, 'IDBFactory') !== undefined);
class IDBFactory {
  constructor(token) {
    constructedBy(PLATFORM, token, 'IDBFactory');
    makeSlots(this, 'IDBFactory', { realm: REALM });
  }
}
// "Obtain a storage key": the origin's, the same token BroadcastChannel and CacheStorage scope to — none for an opaque
// origin (a sandboxed frame's, a data: worker's), whose every request is a SecurityError.
function storageKey() {
  const key = globalThis.__csimBcOriginKey();
  if (String(key).startsWith('opaque:')) throw error('SecurityError', 'Access to the Indexed Database API is denied in this context.');
  return key;
}
installIDBFactory(IDBFactory, ownRealm(REALM, 'IDBFactory', (o) => slotsOf(o, 'IDBFactory'), {
  open(_, name, version) {
    if (version === 0) throw new TypeError("Failed to execute 'open' on 'IDBFactory': The version provided must not be 0.");
    storageKey();
    const request = new IDBOpenDBRequest(PLATFORM);
    enqueue(name, (done) => openDatabase(request, name, version, done));
    return request;
  },
  deleteDatabase(_, name) {
    storageKey();
    const request = new IDBOpenDBRequest(PLATFORM);
    enqueue(name, (done) => deleteDatabase(request, name, done));
    return request;
  },
  databases: () => new IntrinsicPromise((resolve) => {
    storageKey();
    const result = [];
    for (const db of databases.values()) {
      const version = committedVersion(db);
      if (version > 0) result.push({ name: db.name, version });
    }
    queueTask(() => resolve(result));
  }),
  cmp: (_, first, second) => compareKeys(keyOf(first), keyOf(second))
}));

for (const iface of [IDBFactory, IDBRequest, IDBOpenDBRequest, IDBDatabase, IDBTransaction, IDBObjectStore, IDBIndex, IDBKeyRange, IDBRecord, IDBCursor, IDBCursorWithValue]) {
  globalThis[iface.name] = iface;
}

// (…the global's `indexedDB` (window.js, worker-globals.js))
export const indexedDB = new IDBFactory(PLATFORM);
