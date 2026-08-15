// localStorage / sessionStorage — Ruby-backed (host fns on
// `globalThis.__csim_storage*`) so entries survive the per-visit
// `rebuild_ctx`. Without that, apps that cache state in
// `localStorage` on page A (Forem's `browserStoreCache('set')` inside
// `fetchBaseData`) lose it on page B and the first-call branches that
// hinge on cached data silently skip.
//
// Per HTML spec, modifying a Storage area fires a `storage` event on every OTHER same-origin
// document — NOT the one that made the change. The host (`__csimStorageChanged`) fans the change
// out to the sibling realms + same-origin windows and delivers it back through
// `__csim_deliverStorageEvents`; the changing realm is excluded, so it never sees its own writes.

import { StorageEvent, QuotaExceededError } from './events.js';

// Notify the host of a change so it can fire `storage` on the OTHER same-origin documents. `rid`
// is this realm's id (the host skips it), and `url` is the changing document's URL (the event's
// `url` attribute). No local dispatch — the spec fires nowhere in the originating document.
function notifyStorageChanged(kind, key, oldValue, newValue) {
  if (typeof globalThis.__csimStorageChanged !== 'function') return;
  const NS = globalThis.RustyRacer;
  const rid = (NS && typeof NS.contextOf === 'function') ? NS.contextOf(globalThis) : 0;
  const url = globalThis.location ? globalThis.location.href : '';
  // Wire-escaped like every storage host call, so a cross-document listener's
  // e.key/e.newValue round-trip lone surrogates exactly as getItem does.
  const enc = v => v == null ? v : wireEncode(String(v));
  try { globalThis.__csimStorageChanged(kind, enc(key), enc(oldValue), enc(newValue), url, rid); } catch (_) {}
}

// Fire the `storage` events the host routed to THIS document (from another realm / window).
globalThis.__csim_deliverStorageEvents = function (events) {
  if (!events || !events.length || typeof globalThis.dispatchEvent !== 'function') return;
  for (const e of events) {
    try {
      const dec = v => v == null ? v : wireDecode(String(v));
      globalThis.dispatchEvent(new StorageEvent('storage', {
        key:         dec(e.key),
        oldValue:    dec(e.old),
        newValue:    dec(e.new),
        url:         e.url,
        storageArea: e.kind === 'local' ? globalThis.localStorage : globalThis.sessionStorage,
      }));
    } catch (_) {}
  }
};

// Storage's named-property access (`localStorage.foo = 'bar'`,
// `localStorage.foo`, `delete localStorage.foo`) is part of the HTML
// spec — real browsers route those operations through the Storage
// area exactly like `setItem` / `getItem` / `removeItem` would.
// Discourse's `lib/key-value-store.js` uses the bracket-set form
// (`safeLocalStorage[ctx + key] = value`) to write, so we have to
// honour that path too — without the Proxy the assignment would
// just add an own property to the plain JS object and `__csim_
// storage*` host fns would never see it.
// The `kind` ('local' / 'session') the storage area routes to, kept in a symbol slot
// so it can't collide with a storage key and the Proxy passes it straight through.
const STORAGE_KIND = Symbol('storageKind');

// The real `Storage` interface: the API lives on `Storage.prototype` (WPT reads
// `Storage.prototype.getItem` and authors do `Storage.prototype[key] = …`), and each
// area is an instance carrying its kind. `new Storage()` is not allowed.
// Ruby↔V8 marshalling is UTF-8 (a LONE surrogate becomes U+FFFD on the way
// through), but Storage is DOMString-faithful: lone surrogates must round-trip
// (storage_setitem). Escape them — and any literal U+FFFF, the escape lead —
// into `U+FFFF xxxx` (4 hex) before crossing, and reverse on the way back.
// Well-formed strings (no lone surrogate, no U+FFFF) pass the test untouched.
const WIRE_ESC = /￿|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<=^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const WIRE_UNESC = /￿([0-9a-f]{4})/g;
function wireEncode(s) {
  return s.replace(WIRE_ESC, c => '￿' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}
function wireDecode(s) {
  return s.indexOf('￿') === -1 ? s : s.replace(WIRE_UNESC, (_, h) => String.fromCharCode(parseInt(h, 16)));
}
class Storage {
  constructor() { throw new TypeError('Illegal constructor'); }
  get length() { return globalThis.__csim_storageLength(this[STORAGE_KIND]); }
  key(i) {
    if (arguments.length < 1) throw new TypeError("Failed to execute 'key' on 'Storage': 1 argument required, but only 0 present.");
    const v = globalThis.__csim_storageKey(this[STORAGE_KIND], i | 0);
    return v == null ? null : wireDecode(String(v));
  }
  getItem(k) {
    if (arguments.length < 1) throw new TypeError("Failed to execute 'getItem' on 'Storage': 1 argument required, but only 0 present.");
    const v = globalThis.__csim_storageGet(this[STORAGE_KIND], wireEncode(String(k)));
    return v == null ? null : wireDecode(String(v));
  }
  setItem(k, v) {
    if (arguments.length < 2) throw new TypeError(`Failed to execute 'setItem' on 'Storage': 2 arguments required, but only ${arguments.length} present.`);
    const kind    = this[STORAGE_KIND];
    const key     = String(k);
    const wireKey = wireEncode(key);
    const oldWire = globalThis.__csim_storageGet(kind, wireKey);
    const old     = oldWire == null ? null : wireDecode(String(oldWire));
    // A required DOMString value: null → "null", undefined → "undefined" (NOT "").
    const value = String(v);
    // A false return means the area's quota would be exceeded — throw QuotaExceededError and DON'T
    // store or fire an event (WHATWG "setItem"). The name (not just the legacy code 22) matters:
    // WPT's assert_throws_quotaexceedederror checks `e.name === 'QuotaExceededError'`.
    if (globalThis.__csim_storageSet(kind, wireKey, wireEncode(value)) === false) {
      throw new QuotaExceededError(`Failed to execute 'setItem' on 'Storage': Setting the value of '${key}' exceeded the quota.`);
    }
    if (old !== value) notifyStorageChanged(kind, key, old, value);
  }
  removeItem(k) {
    if (arguments.length < 1) throw new TypeError("Failed to execute 'removeItem' on 'Storage': 1 argument required, but only 0 present.");
    const kind = this[STORAGE_KIND];
    const key  = String(k);
    const old  = this.getItem(key);
    globalThis.__csim_storageRemove(kind, wireEncode(key));
    if (old != null) notifyStorageChanged(kind, key, old, null);
  }
  clear() {
    // Per spec, `clear()` only fires an event when the area WASN'T already empty; the null key
    // signals a bulk clear.
    const kind = this[STORAGE_KIND];
    const had  = globalThis.__csim_storageLength(kind) > 0;
    globalThis.__csim_storageClear(kind);
    if (had) notifyStorageChanged(kind, null, null, null);
  }
  get [Symbol.toStringTag]() { return 'Storage'; }
}
globalThis.Storage = Storage;

function makeStorage(kind) {
  const self = Object.create(Storage.prototype);
  // Configurable so the Proxy may omit this symbol from ownKeys without breaking the
  // Proxy invariant (an area's ownKeys are its string storage keys only).
  Object.defineProperty(self, STORAGE_KIND, { value: kind, configurable: true });
  // Storage is a legacy platform object WITHOUT [LegacyOverrideBuiltIns]: a named
  // property (storage item) is HIDDEN whenever the name is already reachable on the
  // prototype chain — a builtin (`getItem`) or an author-injected `Storage.prototype[key]`.
  // `prop in target` walks that chain, so the same test covers builtins and injected
  // props; only names NOT on the chain virtualize to storage items.
  return new Proxy(self, {
    get(target, prop, receiver) {
      if (typeof prop === 'symbol' || (prop in target)) return Reflect.get(target, prop, receiver);
      const v = target.getItem(prop);
      return v == null ? undefined : v;
    },
    set(target, prop, value, receiver) {
      // The named property setter ALWAYS writes the storage item — even for a name
      // shadowed by a prototype property (the prototype's [[Set]] must not run).
      if (typeof prop === 'symbol') return Reflect.set(target, prop, value, receiver);
      target.setItem(prop, value);
      return true;
    },
    deleteProperty(target, prop) {
      if (typeof prop === 'symbol') return Reflect.deleteProperty(target, prop);
      target.removeItem(prop);
      return true;
    },
    // Storage [[DefineOwnProperty]]: `Object.defineProperty(localStorage, key, {value})`
    // stores the item (a data descriptor). An accessor descriptor on a named property
    // is rejected. (Symbols keep ordinary defineProperty behavior.)
    defineProperty(target, prop, desc) {
      if (typeof prop === 'symbol') return Reflect.defineProperty(target, prop, desc);
      if (desc.get !== undefined || desc.set !== undefined) return false;
      if ('value' in desc) target.setItem(prop, desc.value);
      return true;
    },
    has(target, prop) {
      if (typeof prop === 'symbol' || (prop in target)) return true;
      return target.getItem(prop) != null;
    },
    ownKeys(target) {
      const keys = [];
      const len = target.length;
      for (let i = 0; i < len; i++) keys.push(target.key(i));
      return keys;
    },
    getOwnPropertyDescriptor(target, prop) {
      // A name reachable on the prototype chain is not an OWN named property (hidden).
      if (typeof prop === 'symbol' || (prop in target)) return Reflect.getOwnPropertyDescriptor(target, prop);
      const v = target.getItem(prop);
      return v == null ? undefined : {value: v, writable: true, enumerable: true, configurable: true};
    }
  });
}

export const localStorage   = makeStorage('local');
export const sessionStorage = makeStorage('session');
