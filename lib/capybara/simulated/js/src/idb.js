// IndexedDB (Indexed Database API 3.0), generated from its IDL: databases of object stores and their indexes, read and
// written through transactions whose requests run one after another as tasks, their results told by events.
//
// The databases are the engine's (idb_databases.rs, idb.rs): one registry for every realm and worker of the session,
// holding each database's version, its stores' and indexes' schema and records (each value kept serialized), its
// connections and transactions, and the queue its open and delete requests wait in. This realm is an AGENT of it: what
// the engine owes it — an event at a connection of its, an answer to a request, a transaction started — it takes
// (`deliver`) after each call of its own, and as each step of its event loop begins for what another realm's or a
// worker's call caused. Here: the handles, requests and events, a transaction's state between its events and its
// requests' order, key conversion and key paths. A transaction writing a store has the engine journal what it wrote
// (`touch`), so an abort puts it back; an upgrade's start the engine keeps whole. Every object a page holds is made by
// the platform alone (IDBKeyRange's statics aside), its state in slots.

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
import { deserializeWithTransfer, serializeWithTransfer, structuredClone } from './platform-globals.js';
import { afterMicrotaskCheckpoint, hostTask, queueTask, setIdbPoll } from './timers.js';
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
// A key as kept here: a number, a string, a date (`{ date: ms }`), binary (`{ binary: Uint8Array }`) — each holder of no
// prototype, so nothing a page puts on `Object.prototype` makes it another — or an array of keys (an Array). INVALID is
// "invalid value".
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
    return Number.isNaN(ms) ? INVALID : { __proto__: null, date: ms };
  }
  // (…a buffer source — an ArrayBuffer, or a view of one — its bytes copied, read off its internal slots; a detached
  // one none)
  if (ArrayBuffer.isView(input) || isArrayBuffer(input)) {
    const buffer = bufferOfSource(input);
    if (!isArrayBuffer(buffer) || arrayBufferDetached.call(buffer)) return INVALID;
    return { __proto__: null, binary: bufferSourceBytes(input) };
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
// "Compare two keys": by type — array > binary > string > date > number — then by value (the engine's: idb.rs `Key`).
const compareKeys = (a, b) => globalThis.__dom.idbCompare(a, b);
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
  includes: (r, key) => globalThis.__dom.idbInRange(rangeOf(r), keyOf(key))
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
// A store here is its number in the engine with what never changes of it, its key path and whether it has a key
// generator — one object per store, which its handles are kept by; an index likewise, with its store. Their names, and
// whether they are deleted, the engine's.
const stores = new Map();
function storeById(id) {
  let store = stores.get(id);
  if (store === undefined) {
    const [, keyPath, autoIncrement] = globalThis.__dom.idbStore(id);
    stores.set(id, store = { id, keyPath, autoIncrement, indexes: new Map() });
  }
  return store;
}
function indexById(store, id) {
  let index = store.indexes.get(id);
  if (index === undefined) {
    const [, keyPath, unique, multiEntry] = globalThis.__dom.idbIndex(store.id, id);
    store.indexes.set(id, index = { id, store, keyPath, unique, multiEntry });
  }
  return index;
}
// (…a store's name and index names, none for one an aborted upgrade made; an index's name)
const storeName = (store) => globalThis.__dom.idbStore(store.id)?.[0];
const indexNames = (store) => globalThis.__dom.idbStore(store.id)?.[3] ?? [];
const indexName = (index) => globalThis.__dom.idbIndex(index.store.id, index.id)?.[0];
const isDeleted = (store) => !globalThis.__dom.idbStoreLive(store.id);
const isIndexDeleted = (index) => !globalThis.__dom.idbIndexLive(index.store.id, index.id);
// A value as a record keeps it — serialized, its serialization's number the engine takes — and one read back.
const serialized = (value) => serializeWithTransfer(value, [], false).serialized;
const NO_MOVES = new Map();
const deserialized = (number) => deserializeWithTransfer({ serialized: number, list: [], moved: NO_MOVES }).data;
// The keys a value is indexed under in an index of `keyPath`: none, one, or a multiEntry index's several.
function indexKeysOf(keyPath, multiEntry, value) {
  const key = extractKey(value, keyPath, multiEntry);
  if (key === FAILURE || key === INVALID) return [];
  return multiEntry && Array.isArray(key) ? key : [key];
}
// "Store a record into an object store" — the key generated (and put into the value) or the generator moved past the key
// given, refused for an existing key with `noOverwrite` or a unique index's key another record holds — and its key: the
// engine's (`idbPut`), told the keys the value is indexed under in each index it goes into (`idbWriteIndexes`: those
// holding the store's records, a deleted one whose deletion has yet to run in the transaction's order among them — a
// write before the deletion still kept to a unique one).
const STORED = 0, KEY_EXISTS = 1;
function storeRecord(store, value, key, noOverwrite) {
  let generated = false;
  if (store.autoIncrement && key === undefined) {
    // (…its current number Infinity once past 2^53, which a double cannot tell from 2^53 itself)
    const current = globalThis.__dom.idbGenerator(store.id);
    if (current > 2 ** 53) throw error('ConstraintError', 'The key generator has reached its maximum.');
    key = current;
    generated = true;
    if (store.keyPath !== null) injectKey(value, key, store.keyPath);
  }
  const writes = globalThis.__dom.idbWriteIndexes(store.id), indexed = [];
  for (let i = 0; i < writes.length; i += 3) {
    const keys = indexKeysOf(writes[i + 1], writes[i + 2], value);
    indexed.push(writes[i], keys.length, ...keys);
  }
  const number = serialized(value);
  const answer = globalThis.__dom.idbPut(store.id, key, number, indexed, noOverwrite, generated);
  if (answer === STORED) return key;
  globalThis.__dom.structuredDiscard(number);
  if (answer === KEY_EXISTS) throw error('ConstraintError', 'A record with that key already exists.');
  throw error('ConstraintError', `Unable to add a key to the unique index '${globalThis.__dom.idbIndex(store.id, answer[1])?.[0] ?? ''}'.`);
}
const deleteRecordsIn = (store, range) => globalThis.__dom.idbDelete(store.id, range);
// What a request or a cursor reads: a store (its number, no index's) or an index (its store's and its own).
const sourceIds = (source) => (source.store !== undefined ? [source.store.id, source.id] : [source.id, -1]);
// The directions and what a request reads, by the engine's codes.
const DIRECTIONS = { next: 0, nextunique: 1, prev: 2, prevunique: 3 };
const READ_KEY = 0, READ_VALUE = 1, READ_RECORD = 2;
const READS = { key: READ_KEY, value: READ_VALUE, record: READ_RECORD };
// A store's records — or an index's, each with the store record it references — in `range`, in `direction`, at most
// `count` (0: all of them), as `type` asks: their values, keys, or records (`idbRetrieve`).
function retrieve(source, range, direction, count, type) {
  const [store, index] = sourceIds(source);
  const flat = globalThis.__dom.idbRetrieve(store, index, range, DIRECTIONS[direction], count, READS[type]);
  const out = [];
  let i = 0;
  try {
    for (; i < flat.length; i += 3) {
      if (type === 'key') out.push(keyToValue(flat[i + 1]));
      else if (type === 'value') out.push(deserialized(flat[i + 2]));
      else out.push(new IDBRecord(PLATFORM, flat[i], flat[i + 1], deserialized(flat[i + 2])));
    }
  } catch (e) {
    discardValues(flat, i + 3);
    throw e;
  }
  return out;
}
// (…the values of `flat` from `from` on let go unread: a value before them could not be read back)
function discardValues(flat, from) {
  for (let i = from; i < flat.length; i += 3) if (flat[i + 2] !== undefined) globalThis.__dom.structuredDiscard(flat[i + 2]);
}
const countIn = (source, range) => globalThis.__dom.idbCount(...sourceIds(source), range);

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
// A transaction's slots: its number in the engine, its connection, scope (store names, sorted), mode, durability,
// state — active, inactive, committing or finished — its requests not yet processed, in order, error, whether it
// started (the engine's schedule let it: no earlier transaction it overlaps still running), the stores it wrote
// (`saved`), and an upgrade one's request.
const transactions = new Map();
const transactionOf = (o) => slotsOf(o, 'IDBTransaction');
registerInterface('IDBTransaction', (o) => transactionOf(o) !== undefined);
// A transaction's slots: its number in the engine — which keeps its lifecycle (idb_databases.rs: its state, its requests
// in order, whether one runs, whether its commit finishes, what it wrote) — its connection, scope, mode and durability,
// its error, the operations of its requests by the numbers the engine orders them by, its store handles, and an upgrade
// transaction's open request.
class IDBTransaction extends EventTarget {
  constructor(token, connection, id, scope, mode, durability) {
    constructedBy(PLATFORM, token, 'IDBTransaction');
    super();
    makeSlots(this, 'IDBTransaction', {
      realm: REALM,
      id,
      connection,
      scope,
      mode,
      durability,
      error: null,
      operations: new Map(),
      handles: new Map(),
      request: null
    });
    transactions.set(id, this);
    connectionOf(connection).transactions.add(this);
    setEventParent(this, () => transactionOf(this).connection);
  }
}
const MODES = { readonly: 0, readwrite: 1, versionchange: 2 };
// A transaction's state, the engine's (`idbTxState`) — and what it asks once the transaction moved (`steps`): a task
// running its next request, the task finishing its commit.
const TX_ACTIVE = 0, TX_INACTIVE = 1, TX_COMMITTING = 2, TX_FINISHED = 3;
const RUN_NEXT = 1, FINISH_COMMIT = 2;
const stateOf = (t) => globalThis.__dom.idbTxState(t.id);
const isActive = (t) => stateOf(t) === TX_ACTIVE;
const isFinished = (t) => stateOf(t) === TX_FINISHED;
function proceed(tx, asks) {
  if (asks & RUN_NEXT) queueTask(() => runNext(tx));
  if (asks & FINISH_COMMIT) queueTask(() => finishCommit(tx));
}
const moved = (tx) => proceed(tx, globalThis.__dom.idbTxSteps(transactionOf(tx).id));
// A transaction the engine started: its requests run.
const started = moved;
// "Asynchronously execute a request": its operation run, a task later, after every earlier one of its transaction's.
let lastRequestNumber = 0;
function addRequest(tx, request, operation) {
  const t = transactionOf(tx);
  // (…one made as its transaction finished — aborted by a getter its value's clone ran — failed as an abort fails the
  // requests it finds)
  if (isFinished(t)) {
    if (request !== null) failAborted(request);
    return request;
  }
  const n = ++lastRequestNumber;
  t.operations.set(n, { request, operation });
  proceed(tx, globalThis.__dom.idbTxRequest(t.id, n));
  return request;
}
function runNext(tx) {
  const t = transactionOf(tx);
  // (…none where an abort finished it meanwhile)
  const n = globalThis.__dom.idbTxTake(t.id);
  if (n < 0) return;
  const entry = t.operations.get(n);
  t.operations.delete(n);
  let result, failure = null;
  try { result = entry.operation(); } catch (e) { failure = e; }
  // (…an operation of the platform's own, with no request: an index populated, which failing aborts the transaction)
  if (entry.request === null) {
    if (failure !== null) abortTransaction(tx, failure);
    else moved(tx);
    return;
  }
  // (…one failing in a transaction `commit()` was called on aborts it, the request still unprocessed — told an
  // AbortError with the others)
  if (failure !== null && stateOf(t) === TX_COMMITTING) {
    t.operations.set(n, entry);
    globalThis.__dom.idbTxRequeue(t.id, n);
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
  if (!isFinished(t)) moved(tx);
}
// "Fire a success event" / "fire an error event" at a request, its transaction active while its listeners run — and,
// where it still is after them, inactive again, aborted if a listener threw or, for an error no listener canceled, with
// the request's error. (A listener that committed it, or aborted it, left it so.)
function fireSuccess(tx, request) {
  const t = transactionOf(tx);
  globalThis.__dom.idbTxEnter(t.id);
  const e = event('success', false, false);
  fire(request, e);
  if (!globalThis.__dom.idbTxLeave(t.id)) return;
  if (eventState(e).listenersThrew) abortTransaction(tx, error('AbortError', 'A listener threw.'));
}
function fireError(tx, request, failure) {
  const t = transactionOf(tx);
  globalThis.__dom.idbTxEnter(t.id);
  const e = event('error', true, true);
  const notCanceled = fire(request, e);
  if (!globalThis.__dom.idbTxLeave(t.id)) return;
  if (eventState(e).listenersThrew) abortTransaction(tx, error('AbortError', 'A listener threw.'));
  else if (notCanceled) abortTransaction(tx, failure);
}
// "Commit a transaction": committing at once — no request made after — and, once its requests are done, `complete` a
// task later, and an upgrade's open request answered after.
const commitTransaction = (tx) => proceed(tx, globalThis.__dom.idbTxCommit(transactionOf(tx).id));
function finishCommit(tx) {
  const t = transactionOf(tx);
  if (!globalThis.__dom.idbTxComplete(t.id)) return;
  if (t.request) globalThis.__dom.idbUpgradeEnd(t.id, false);
  finished(tx);
  // (…an upgrade transaction no longer its connection's as its event fires: a schema change there is no change of it)
  if (t.request) connectionOf(t.connection).upgrade = null;
  fire(tx, event('complete', false, false));
  if (t.request) {
    requestOf(t.request).transaction = null;
    t.onFinish?.(false);
  }
}
// "Abort a transaction": what it wrote put back (an upgrade's schema and version too), its unprocessed requests each
// failed with an AbortError, then `abort` — bubbling to its connection. It is finished at once, its events a task later.
function abortTransaction(tx, reason) {
  const t = transactionOf(tx);
  const unprocessed = globalThis.__dom.idbTxAbort(t.id);
  if (unprocessed === null) return;
  if (t.request) restoreSchema(t);
  if (reason !== null) t.error = reason;
  for (const n of unprocessed) {
    const entry = t.operations.get(n);
    if (entry && entry.request !== null) failAborted(entry.request);
  }
  t.operations.clear();
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
// A request its transaction's abort leaves unprocessed: an AbortError, a task later.
function failAborted(request) {
  const r = requestOf(request);
  queueTask(() => {
    r.done = true;
    r.result = undefined;
    r.error = error('AbortError', 'The transaction was aborted.');
    fire(request, event('error', true, true));
  });
}
// …and gone from its database's schedule, which may start the next — and its connection closed, where that waited on it.
function finished(tx) {
  const t = transactionOf(tx);
  transactions.delete(t.id);
  connectionOf(t.connection).transactions.delete(tx);
  globalThis.__dom.idbFinished(t.id);
  deliver();
}
// The engine journaling what a transaction writes into a store, as it first does — which an abort puts back and a
// commit lets go.
const touch = (tx, store) => globalThis.__dom.idbJournal(store.id, transactionOf(tx).id);
// An aborted upgrade's schema put back — the version, the stores and their indexes as it began, the engine's — and its
// handles' names with it (a store or an index it made keeping the one it has).
function restoreSchema(t) {
  globalThis.__dom.idbUpgradeEnd(t.id, true);
  for (const handle of t.handles.values()) {
    const h = storeOf(handle);
    h.name = storeName(h.store) ?? h.name;
    for (const indexHandle of h.indexes.values()) {
      const i = indexOf(indexHandle);
      i.name = indexName(i.index) ?? i.name;
    }
  }
}

installIDBTransaction(IDBTransaction, ownRealm(REALM, 'IDBTransaction', transactionOf, {
  get_objectStoreNames(tx) {
    const t = transactionOf(tx);
    return domStringList(t.mode === 'versionchange' ? connectionNames(t.connection) : t.scope.slice());
  },
  get_mode: (tx) => transactionOf(tx).mode,
  get_durability: (tx) => transactionOf(tx).durability,
  get_db: (tx) => transactionOf(tx).connection,
  get_error: (tx) => transactionOf(tx).error,
  objectStore(tx, name) {
    const t = transactionOf(tx);
    if (isFinished(t)) throw error('InvalidStateError', 'The transaction has finished.');
    const id = t.mode === 'versionchange' || t.scope.includes(name) ? globalThis.__dom.idbStoreId(connectionOf(t.connection).id, name) : 0;
    if (id === 0) throw error('NotFoundError', 'The specified object store was not found.');
    return storeHandle(tx, storeById(id));
  },
  commit(tx) {
    const t = transactionOf(tx);
    if (!isActive(t)) throw error('InvalidStateError', 'The transaction is not active.');
    commitTransaction(tx);
  },
  abort(tx) {
    const t = transactionOf(tx);
    if (stateOf(t) >= TX_COMMITTING) throw error('InvalidStateError', 'The transaction has finished.');
    abortTransaction(tx, null);
  },
  installEventHandlers
}));

// ── Connections: IDBDatabase (§4.4) ──────────────────────────────────────────────────────────────────────────────────
// A connection's slots: its number in the engine — which keeps its database, version and store names (as of its open or
// its last upgrade) — whether its close is pending, its transactions and its upgrade transaction. This realm's
// connections whose close is not pending, by number: what the engine's `versionchange` is told at.
const connections = new Map();
const connectionOf = (o) => slotsOf(o, 'IDBDatabase');
registerInterface('IDBDatabase', (o) => connectionOf(o) !== undefined);
class IDBDatabase extends EventTarget {
  constructor(token, id) {
    constructedBy(PLATFORM, token, 'IDBDatabase');
    super();
    makeSlots(this, 'IDBDatabase', { realm: REALM, id, closePending: false, transactions: new Set(), upgrade: null });
    connections.set(id, this);
  }
}
// (…the object of the engine's connection `id`, made as this realm first hears of it)
const connectionObject = (id) => connections.get(id) ?? new IDBDatabase(PLATFORM, id);
// (…[database name, version, store names])
const connectionInfo = (connection) => globalThis.__dom.idbConnection(connectionOf(connection).id);
const connectionNames = (connection) => connectionInfo(connection)[2];
// "Close a database connection": closing at once, closed once its transactions are done (the engine's).
function closeConnection(connection) {
  const c = connectionOf(connection);
  c.closePending = true;
  connections.delete(c.id);
  globalThis.__dom.idbClose(c.id);
  deliver();
}
// The upgrade transaction a schema change needs, active — an InvalidStateError or TransactionInactiveError otherwise.
function activeUpgrade(transaction, member) {
  const t = transaction && transactionOf(transaction);
  if (!t || t.mode !== 'versionchange') throw error('InvalidStateError', `Failed to execute '${member}': the database is not running a version change transaction.`);
  if (!isActive(t)) throw error('TransactionInactiveError', `Failed to execute '${member}': the transaction is not active.`);
  return t;
}
installIDBDatabase(IDBDatabase, ownRealm(REALM, 'IDBDatabase', connectionOf, {
  get_name: (connection) => connectionInfo(connection)[0],
  get_version: (connection) => connectionInfo(connection)[1],
  get_objectStoreNames: (connection) => domStringList(connectionNames(connection)),
  transaction(connection, storeNames, mode, options) {
    const c = connectionOf(connection);
    if (c.upgrade && !isFinished(transactionOf(c.upgrade))) throw error('InvalidStateError', 'A version change transaction is running.');
    if (c.closePending) throw error('InvalidStateError', 'The database connection is closing.');
    const scope = [...new Set(typeof storeNames === 'string' ? [storeNames] : storeNames)].sort();
    for (const name of scope) {
      if (globalThis.__dom.idbStoreId(c.id, name) === 0) throw error('NotFoundError', 'One of the specified object stores was not found.');
    }
    if (scope.length === 0) throw error('InvalidAccessError', 'The transaction scope is empty.');
    if (mode !== 'readonly' && mode !== 'readwrite') throw new TypeError(`Failed to execute 'transaction' on 'IDBDatabase': The mode provided ('${mode}') is not one of 'readonly' or 'readwrite'.`);
    const id = globalThis.__dom.idbTransaction(c.id, scope, MODES[mode]);
    const tx = new IDBTransaction(PLATFORM, connection, id, scope, mode, options.durability);
    // (…inactive once this task's microtasks have run: HTML "cleanup Indexed Database transactions" — its cleanup event
    // loop this one)
    afterMicrotaskCheckpoint(() => {
      if (globalThis.__dom.idbTxLeave(id)) moved(tx);
    });
    return tx;
  },
  close: (connection) => closeConnection(connection),
  createObjectStore(connection, name, options) {
    const c = connectionOf(connection), t = activeUpgrade(c.upgrade, 'createObjectStore');
    const keyPath = options.keyPath ?? null;
    if (keyPath !== null && !isValidKeyPath(keyPath)) throw error('SyntaxError', 'The keyPath option is not a valid key path.');
    if (globalThis.__dom.idbStoreId(c.id, name) !== 0) throw error('ConstraintError', 'An object store with the specified name already exists.');
    if (options.autoIncrement && (keyPath === '' || Array.isArray(keyPath))) {
      throw error('InvalidAccessError', 'The autoIncrement option was set but the keyPath option was empty or an array.');
    }
    return storeHandle(c.upgrade, storeById(globalThis.__dom.idbStoreCreate(t.id, name, keyPath, !!options.autoIncrement)));
  },
  deleteObjectStore(connection, name) {
    const t = activeUpgrade(connectionOf(connection).upgrade, 'deleteObjectStore');
    if (globalThis.__dom.idbStoreDelete(t.id, name) === 0) throw error('NotFoundError', 'The specified object store was not found.');
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
    makeSlots(this, 'IDBObjectStore', { realm: REALM, store, name: storeName(store), transaction, indexes: new Map(), keyPath: keyPathValue(store.keyPath) });
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
  if (isDeleted(s.store)) throw error('InvalidStateError', 'The object store has been deleted.');
  if (!isActive(t)) throw error('TransactionInactiveError', 'The transaction is not active.');
  if (write && t.mode === 'readonly') throw error('ReadOnlyError', 'The transaction is read-only.');
  return s;
}
// A value cloned as a page's code may see it run: the transaction inactive meanwhile.
function cloneDuring(tx, value) {
  const t = transactionOf(tx), state = globalThis.__dom.idbTxState(t.id, TX_INACTIVE);
  try { return structuredClone(value); } finally { globalThis.__dom.idbTxState(t.id, state); }
}
function putOrAdd(handle, value, key, noOverwrite) {
  const s = usable(handle, true), store = s.store, tx = s.transaction;
  if (store.keyPath !== null && key !== undefined) throw error('DataError', 'The object store uses in-line keys and the key parameter was provided.');
  if (store.keyPath === null && !store.autoIncrement && key === undefined) {
    throw error('DataError', 'The object store uses out-of-line keys and has no key generator and the key parameter was not provided.');
  }
  let k = key === undefined ? undefined : keyOf(key);
  const clone = cloneDuring(tx, value);
  if (store.keyPath !== null) {
    const extracted = extractKey(clone, store.keyPath);
    if (extracted === INVALID) throw error('DataError', 'Evaluating the object store\'s key path yielded a value that is not a valid key.');
    if (extracted !== FAILURE) k = extracted;
    else if (!store.autoIncrement) throw error('DataError', 'Evaluating the object store\'s key path did not yield a value.');
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
    if (isDeleted(s.store)) throw error('InvalidStateError', 'The object store has been deleted.');
    if (!isActive(t)) throw error('TransactionInactiveError', 'The transaction is not active.');
    if (!globalThis.__dom.idbStoreRename(t.id, s.store.id, name)) throw error('ConstraintError', 'An object store with the specified name already exists.');
    s.name = name;
  },
  get_keyPath: (handle) => storeOf(handle).keyPath,
  get_indexNames: (handle) => domStringList(indexNames(storeOf(handle).store)),
  get_transaction: (handle) => storeOf(handle).transaction,
  get_autoIncrement: (handle) => storeOf(handle).store.autoIncrement,
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
    return addRequest(s.transaction, new IDBRequest(PLATFORM, handle, s.transaction), () => countIn(s.store, range));
  },
  openCursor: (handle, query, direction) => openCursor(handle, query, direction, false),
  openKeyCursor: (handle, query, direction) => openCursor(handle, query, direction, true),
  index(handle, name) {
    const s = storeOf(handle), t = transactionOf(s.transaction);
    if (isDeleted(s.store)) throw error('InvalidStateError', 'The object store has been deleted.');
    if (isFinished(t)) throw error('InvalidStateError', 'The transaction has finished.');
    const id = globalThis.__dom.idbIndexId(s.store.id, name);
    if (id === 0) throw error('NotFoundError', 'The specified index was not found.');
    const index = indexById(s.store, id);
    let indexHandle = s.indexes.get(index);
    if (!indexHandle) s.indexes.set(index, indexHandle = new IDBIndex(PLATFORM, index, handle));
    return indexHandle;
  },
  createIndex(handle, name, keyPath, options) {
    const s = storeOf(handle), t = transactionOf(s.transaction);
    if (t.mode !== 'versionchange') throw error('InvalidStateError', 'Indexes can only be created in a version change transaction.');
    if (isDeleted(s.store)) throw error('InvalidStateError', 'The object store has been deleted.');
    if (!isActive(t)) throw error('TransactionInactiveError', 'The transaction is not active.');
    if (globalThis.__dom.idbIndexId(s.store.id, name) !== 0) throw error('ConstraintError', 'An index with the specified name already exists.');
    if (!isValidKeyPath(keyPath)) throw error('SyntaxError', 'The keyPath argument is not a valid key path.');
    if (Array.isArray(keyPath) && options.multiEntry) throw error('InvalidAccessError', 'The keyPath argument was an array and the multiEntry option is true.');
    const index = indexById(s.store, globalThis.__dom.idbIndexCreate(s.store.id, name, keyPath, options.unique, options.multiEntry));
    // (…its records the store's as the requests before this one leave it, indexed in the transaction's order — a unique
    // index two records share a key in aborting the upgrade with a ConstraintError)
    addRequest(s.transaction, null, () => {
      const flat = globalThis.__dom.idbRetrieve(s.store.id, -1, UNBOUNDED, DIRECTIONS.next, 0, READ_VALUE), entries = [];
      for (let i = 0; i < flat.length; i += 3) {
        let keys;
        try {
          keys = indexKeysOf(index.keyPath, index.multiEntry, deserialized(flat[i + 2]));
        } catch (e) {
          discardValues(flat, i + 3);
          throw e;
        }
        entries.push(flat[i + 1], keys.length, ...keys);
      }
      if (!globalThis.__dom.idbPopulate(s.store.id, index.id, entries)) {
        throw error('ConstraintError', 'Unable to create the unique index: the object store holds records that share a key in it.');
      }
    });
    const indexHandle = new IDBIndex(PLATFORM, index, handle);
    s.indexes.set(index, indexHandle);
    return indexHandle;
  },
  deleteIndex(handle, name) {
    const s = storeOf(handle), t = transactionOf(s.transaction);
    if (t.mode !== 'versionchange') throw error('InvalidStateError', 'Indexes can only be deleted in a version change transaction.');
    if (isDeleted(s.store)) throw error('InvalidStateError', 'The object store has been deleted.');
    if (!isActive(t)) throw error('TransactionInactiveError', 'The transaction is not active.');
    const id = globalThis.__dom.idbIndexDelete(s.store.id, name);
    if (id === 0) throw error('NotFoundError', 'The specified index was not found.');
    // (…its records gone in the transaction's order: a write queued before still keeps to it)
    addRequest(s.transaction, null, () => globalThis.__dom.idbIndexRetire(s.store.id, id));
  }
}));

// An index handle's slots: its index, its name as of its making, its store handle, and its key path's value.
const indexOf = (o) => slotsOf(o, 'IDBIndex');
registerInterface('IDBIndex', (o) => indexOf(o) !== undefined);
class IDBIndex {
  constructor(token, index, storeHandle) {
    constructedBy(PLATFORM, token, 'IDBIndex');
    makeSlots(this, 'IDBIndex', { realm: REALM, index, name: indexName(index), storeHandle, keyPath: keyPathValue(index.keyPath) });
  }
}
function usableIndex(handle) {
  const i = indexOf(handle), s = storeOf(i.storeHandle), t = transactionOf(s.transaction);
  if (isIndexDeleted(i.index) || isDeleted(s.store)) throw error('InvalidStateError', 'The index or its object store has been deleted.');
  if (!isActive(t)) throw error('TransactionInactiveError', 'The transaction is not active.');
  return { index: i.index, tx: s.transaction };
}
installIDBIndex(IDBIndex, ownRealm(REALM, 'IDBIndex', indexOf, {
  get_name: (handle) => indexOf(handle).name,
  set_name(handle, name) {
    const i = indexOf(handle), s = storeOf(i.storeHandle), t = transactionOf(s.transaction);
    if (t.mode !== 'versionchange') throw error('InvalidStateError', 'The index can only be renamed in a version change transaction.');
    if (isIndexDeleted(i.index) || isDeleted(s.store)) throw error('InvalidStateError', 'The index or its object store has been deleted.');
    if (!isActive(t)) throw error('TransactionInactiveError', 'The transaction is not active.');
    if (!globalThis.__dom.idbIndexRename(s.store.id, i.index.id, name)) throw error('ConstraintError', 'An index with the specified name already exists.');
    i.name = name;
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
    return addRequest(u.tx, new IDBRequest(PLATFORM, handle, u.tx), () => countIn(u.index, range));
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
  const c = cursorOf(cursor);
  const found = globalThis.__dom.idbCursor(...sourceIds(c.target), c.range, DIRECTIONS[c.direction], c.position,
    c.isIndex ? c.objectStorePosition : undefined, key, primaryKey, count, c.keyOnly);
  if (found === null) {
    c.key = c.value = c.primaryKey = c.keyValue = c.primaryKeyValue = undefined;
    c.gotValue = false;
    return null;
  }
  const [k, p, value] = found;
  c.position = k;
  c.objectStorePosition = c.isIndex ? p : undefined;
  c.key = k;
  c.primaryKey = p;
  c.keyValue = keyToValue(k);
  c.primaryKeyValue = c.isIndex ? keyToValue(p) : c.keyValue;
  if (!c.keyOnly) c.value = deserialized(value);
  c.gotValue = true;
  return cursor;
}
// The cursor's checks before it moves or writes: an inactive transaction, a deleted source, a cursor holding nothing.
function cursorUsable(cursor, member) {
  const c = cursorOf(cursor), t = transactionOf(c.transaction);
  if (!isActive(t)) throw error('TransactionInactiveError', `Failed to execute '${member}' on 'IDBCursor': The transaction is not active.`);
  const store = c.isIndex ? c.target.store : c.target;
  if ((c.isIndex && isIndexDeleted(c.target)) || isDeleted(store)) throw error('InvalidStateError', `Failed to execute '${member}' on 'IDBCursor': The cursor's source or effective object store has been deleted.`);
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
    if (!isActive(t)) throw error('TransactionInactiveError', "Failed to execute 'update' on 'IDBCursor': The transaction is not active.");
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
    if (!isActive(t)) throw error('TransactionInactiveError', "Failed to execute 'delete' on 'IDBCursor': The transaction is not active.");
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
// This realm's open and delete requests in a database's queue (the engine's), by the number the engine knows each by.
const requests = new Map();
let lastRequest = 0;
function queued(request) {
  agent();
  requests.set(++lastRequest, request);
  return lastRequest;
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
// "Upgrade a database", which the engine began — the version set, a versionchange transaction over every store, which it
// started: `upgradeneeded` fired, and the open request answered once it finished — with the connection, or an AbortError
// and the connection closed — and then the next request's turn.
function upgrade(id, connection, txId, oldVersion) {
  const request = requests.get(id), c = connectionOf(connection);
  const [, version, names] = connectionInfo(connection);
  const tx = new IDBTransaction(PLATFORM, connection, txId, names, 'versionchange', 'default');
  const t = transactionOf(tx);
  t.request = request;
  c.upgrade = tx;
  t.onFinish = (aborted) => {
    if (aborted || c.closePending) {
      closeConnection(connection);
      settle(request, undefined, error('AbortError', 'The version change transaction was aborted.'));
    } else {
      settle(request, connection, null);
    }
    requests.delete(id);
    globalThis.__dom.idbRequestDone(id);
    deliver();
  };
  const r = requestOf(request);
  r.done = true;
  r.result = connection;
  r.transaction = tx;
  globalThis.__dom.idbTxState(t.id, TX_ACTIVE);
  const e = versionEvent('upgradeneeded', oldVersion, version);
  fire(request, e);
  globalThis.__dom.idbTxArm(t.id);
  if (globalThis.__dom.idbTxLeave(t.id) && eventState(e).listenersThrew) abortTransaction(tx, error('AbortError', 'A listener threw.'));
  moved(tx);
}

// ── What the engine tells this realm ─────────────────────────────────────────────────────────────────────────────────
// This realm an agent of the session's registry, as it first uses IndexedDB — its notices taken as each step of its
// event loop begins, too. Asked at each open, delete and listing: a realm whose page the engine began anew dropped the
// agent it was (`idbAgent` makes one only where there is none).
let agentMade = false;
function agent() {
  globalThis.__dom.idbAgent(globalThis.__csimSessionPartition?.() ?? 0);
  if (agentMade) return;
  setIdbPoll(deliver);
  agentMade = true;
}
// (…for the host: whether a realm of this isolate has notices to take, and this realm's taken — a task of its own)
globalThis.__csimIdbPending = () => globalThis.__dom.idbPending();
globalThis.__csimIdbDeliver = hostTask(() => deliver());
globalThis.__csimIdbDropAgents = () => globalThis.__dom.idbDropAgents();
// The notices taken, in order, as `idb_databases.rs` names them: each its kind, whether it is a task of its own, and
// four numbers. One taken while another's listeners run waits for them, but one that only queues a task.
const VERSION_CHANGE = 1, BLOCKED = 2, UPGRADE = 3, OPENED = 4, OPEN_REFUSED = 5, DELETED = 6, TURN = 7, STARTED = 8;
const inbox = [];
let delivering = false;
function deliver() {
  if (!agentMade) return;
  const flat = globalThis.__dom.idbTake();
  if (flat !== null) inbox.push(...flat);
  if (delivering) {
    for (let i = 0; i < inbox.length;) {
      if (inbox[i + 1]) notice(...inbox.splice(i, 6));
      else i += 6;
    }
    return;
  }
  delivering = true;
  try {
    while (inbox.length) {
      notice(...inbox.splice(0, 6));
      const more = globalThis.__dom.idbTake();
      if (more !== null) inbox.push(...more);
    }
  } finally {
    delivering = false;
  }
}
function notice(kind, later, a, b, c, d) {
  const run = (step) => (later ? queueTask(step) : step());
  switch (kind) {
    case VERSION_CHANGE: {
      // (…at a connection whose close is not pending: the other connections an upgrade or a deletion waits for)
      const connection = connections.get(a);
      if (connection) fire(connection, versionEvent('versionchange', b, c));
      globalThis.__dom.idbAck(a);
      break;
    }
    case BLOCKED: {
      const request = requests.get(a);
      if (request) run(() => fire(request, versionEvent('blocked', b, c)));
      break;
    }
    case UPGRADE:
      run(() => upgrade(a, connectionObject(b), c, d));
      break;
    case OPENED:
      settle(requests.get(a), connectionObject(b), null);
      requests.delete(a);
      break;
    case OPEN_REFUSED:
      settle(requests.get(a), undefined, error('VersionError', `The requested version (${b}) is less than the existing version (${c}).`));
      requests.delete(a);
      break;
    case DELETED: {
      const request = requests.get(a);
      requests.delete(a);
      run(() => settle(request, undefined, null, 'success', b));
      break;
    }
    case TURN:
      run(() => {
        globalThis.__dom.idbTurn(a);
        deliver();
      });
      break;
    case STARTED: {
      const tx = transactions.get(a);
      if (tx) started(tx);
      break;
    }
  }
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
    const key = storageKey();
    const request = new IDBOpenDBRequest(PLATFORM);
    globalThis.__dom.idbOpen(key, name, version, queued(request));
    deliver();
    return request;
  },
  deleteDatabase(_, name) {
    const key = storageKey();
    const request = new IDBOpenDBRequest(PLATFORM);
    globalThis.__dom.idbDeleteDatabase(key, name, queued(request));
    deliver();
    return request;
  },
  databases: () => new IntrinsicPromise((resolve) => {
    const key = storageKey();
    agent();
    const flat = globalThis.__dom.idbDatabases(key), result = [];
    for (let i = 0; i < flat.length; i += 2) result.push({ name: flat[i], version: flat[i + 1] });
    queueTask(() => resolve(result));
  }),
  cmp: (_, first, second) => compareKeys(keyOf(first), keyOf(second))
}));

for (const iface of [IDBFactory, IDBRequest, IDBOpenDBRequest, IDBDatabase, IDBTransaction, IDBObjectStore, IDBIndex, IDBKeyRange, IDBRecord, IDBCursor, IDBCursorWithValue]) {
  globalThis[iface.name] = iface;
}

// (…the global's `indexedDB` (window.js, worker-globals.js))
export const indexedDB = new IDBFactory(PLATFORM);
