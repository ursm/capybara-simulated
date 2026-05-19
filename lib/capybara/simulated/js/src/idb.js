// Stub IndexedDB — Mastodon's emoji cache + service-worker probe
// reach for `indexedDB`; Tesseract.js's `idb-keyval` walks
// `req instanceof IDBRequest`. Real persistence isn't available;
// we keep entries in an in-memory Map that clears on VM rebuild —
// good enough for "cache miss → fetch + write → fetch from cache
// succeeds within the same session" round-trips, and the `idb`
// wrapper's request shapes (success / upgradeneeded ordering,
// on<type> callback firing) match what consumers feature-detect.
//
// Cursor prototype methods (`advance` / `continue` /
// `continuePrimaryKey`) are stubbed because the `idb` wrapper
// captures their references at module-init for proxy installation.

import { EventTarget } from './events.js';

// The `idb` wrapper calls `req.addEventListener('success', …)` and
// also reads `req.onsuccess`/`onerror`. Reuse EventTarget for the
// listener machinery; only the `on<type>` callback firing is unique
// to the IDB IDL.
class IDBEventTarget extends EventTarget {
  dispatchEvent(evt) {
    const ret = super.dispatchEvent(evt);
    const h   = this['on' + evt.type];
    if (typeof h === 'function') { try { h.call(this, evt); } catch (_) {} }
    return ret;
  }
}

class IDBRequest extends IDBEventTarget {
  constructor() {
    super();
    this.result          = null;
    this.error           = null;
    this.readyState      = 'pending';
    this.onsuccess       = null;
    this.onerror         = null;
    this.onupgradeneeded = null;
  }
}

const store = new Map();

// Schedule `target.dispatchEvent({type, target})` on the microtask
// queue, matching real IDB's "success fires after the call site's
// then-chain has been set up" timing.
function deliverAsync(target, type) {
  Promise.resolve().then(() => target.dispatchEvent({type, target}));
  return target;
}

class IDBDatabase extends IDBEventTarget {
  constructor() { super(); this._stores = new Set(); }
  createObjectStore(name)         { this._stores.add(name); return new IDBObjectStore(name); }
  transaction(_storeNames, _mode) { return new IDBTransaction(); }
  close() {}
}
class IDBTransaction extends IDBEventTarget {
  objectStore(name) { return new IDBObjectStore(name); }
}
class IDBObjectStore extends IDBEventTarget {
  constructor(name) { super(); this._name = name; }
  get(key) {
    const req = new IDBRequest();
    req.result = store.get(this._name + ' ' + String(key));
    return deliverAsync(req, 'success');
  }
  put(value, key) {
    const req = new IDBRequest();
    store.set(this._name + ' ' + String(key), value);
    req.result = key;
    return deliverAsync(req, 'success');
  }
  delete(key) {
    const req = new IDBRequest();
    store.delete(this._name + ' ' + String(key));
    return deliverAsync(req, 'success');
  }
  clear() {
    const req = new IDBRequest();
    for (const k of Array.from(store.keys())) {
      if (k.startsWith(this._name + ' ')) store.delete(k);
    }
    return deliverAsync(req, 'success');
  }
}
class IDBIndex extends IDBEventTarget {}
class IDBCursor {
  advance()            {}
  continue()           {}
  continuePrimaryKey() {}
}

export {IDBRequest, IDBDatabase, IDBObjectStore, IDBTransaction, IDBIndex, IDBCursor};

export const indexedDB = {
  open(_name, _version) {
    const req = new IDBRequest();
    req.result = new IDBDatabase();
    // Fire `upgradeneeded` first so callers can `createObjectStore`,
    // then `success`. Real browsers do this same ordering.
    Promise.resolve().then(() => {
      req.dispatchEvent({type: 'upgradeneeded', target: req});
      req.dispatchEvent({type: 'success', target: req});
    });
    return req;
  },
  deleteDatabase() {
    return deliverAsync(new IDBRequest(), 'success');
  }
};
