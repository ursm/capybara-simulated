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
  try { globalThis.__csimStorageChanged(kind, key, oldValue, newValue, url, rid); } catch (_) {}
}

// Fire the `storage` events the host routed to THIS document (from another realm / window).
globalThis.__csim_deliverStorageEvents = function (events) {
  if (!events || !events.length || typeof globalThis.dispatchEvent !== 'function') return;
  for (const e of events) {
    try {
      globalThis.dispatchEvent(new StorageEvent('storage', {
        key:         e.key,
        oldValue:    e.old,
        newValue:    e.new,
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
const STORAGE_API_METHODS = new Set(['length', 'key', 'getItem', 'setItem', 'removeItem', 'clear']);

function makeStorage(kind) {
  const self = {
    get length()  { return globalThis.__csim_storageLength(kind); },
    key(i) {
      const v = globalThis.__csim_storageKey(kind, i | 0);
      return v == null ? null : String(v);
    },
    getItem(k) {
      const v = globalThis.__csim_storageGet(kind, String(k));
      return v == null ? null : String(v);
    },
    setItem(k, v) {
      const key   = String(k);
      const old   = self.getItem(key);
      const value = String(v == null ? '' : v);
      // A false return means the area's quota would be exceeded — throw QuotaExceededError and DON'T
      // store or fire an event (WHATWG "setItem"). The name (not just the legacy code 22) matters:
      // WPT's assert_throws_quotaexceedederror checks `e.name === 'QuotaExceededError'`.
      if (globalThis.__csim_storageSet(kind, key, value) === false) {
        throw new QuotaExceededError(`Failed to execute 'setItem' on 'Storage': Setting the value of '${key}' exceeded the quota.`);
      }
      if (old !== value) notifyStorageChanged(kind, key, old, value);
    },
    removeItem(k) {
      const key = String(k);
      const old = self.getItem(key);
      globalThis.__csim_storageRemove(kind, key);
      if (old != null) notifyStorageChanged(kind, key, old, null);
    },
    clear() {
      // Per spec, `clear()` only fires an event when the area WASN'T already empty; the null key
      // signals a bulk clear.
      const had = globalThis.__csim_storageLength(kind) > 0;
      globalThis.__csim_storageClear(kind);
      if (had) notifyStorageChanged(kind, null, null, null);
    }
  };
  return new Proxy(self, {
    get(target, prop) {
      if (typeof prop === 'symbol' || STORAGE_API_METHODS.has(prop)) return target[prop];
      const v = target.getItem(prop);
      return v == null ? undefined : v;
    },
    set(target, prop, value) {
      if (typeof prop === 'symbol' || STORAGE_API_METHODS.has(prop)) { target[prop] = value; return true; }
      target.setItem(prop, value);
      return true;
    },
    deleteProperty(target, prop) {
      if (typeof prop === 'symbol' || STORAGE_API_METHODS.has(prop)) { delete target[prop]; return true; }
      target.removeItem(prop);
      return true;
    },
    has(target, prop) {
      if (typeof prop === 'symbol' || STORAGE_API_METHODS.has(prop)) return prop in target;
      return target.getItem(prop) != null;
    },
    ownKeys(target) {
      const keys = [];
      const len = target.length;
      for (let i = 0; i < len; i++) keys.push(target.key(i));
      return keys;
    },
    getOwnPropertyDescriptor(target, prop) {
      if (typeof prop === 'symbol' || STORAGE_API_METHODS.has(prop)) {
        return Object.getOwnPropertyDescriptor(target, prop);
      }
      const v = target.getItem(prop);
      return v == null ? undefined : {value: v, writable: true, enumerable: true, configurable: true};
    }
  });
}

export const localStorage   = makeStorage('local');
export const sessionStorage = makeStorage('session');
