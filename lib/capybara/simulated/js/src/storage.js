// localStorage / sessionStorage — Ruby-backed (host fns on
// `globalThis.__csim_storage*`) so entries survive the per-visit
// `rebuild_ctx`. Without that, apps that cache state in
// `localStorage` on page A (Forem's `browserStoreCache('set')` inside
// `fetchBaseData`) lose it on page B and the first-call branches that
// hinge on cached data silently skip.
//
// Per HTML spec, modifications to a Storage area fire a `storage`
// event on the *other* same-origin windows. Single-isolate runtime
// means only one window observes its own writes (silently); but
// listeners that read `event.key` / `oldValue` / `newValue` shouldn't
// crash, so we fire the event locally on `globalThis` too — handlers
// just see their own writes echoed (real browsers don't, but it's
// harmless and lets multi-tab sync polyfills feature-probe).

import { StorageEvent } from './events.js';

function dispatchStorageEvent(kind, key, oldValue, newValue) {
  if (typeof globalThis.dispatchEvent !== 'function') return;
  try {
    globalThis.dispatchEvent(new StorageEvent('storage', {
      key, oldValue, newValue,
      url:         globalThis.location ? globalThis.location.href : '',
      storageArea: kind === 'local' ? globalThis.localStorage : globalThis.sessionStorage
    }));
  } catch (_) {}
}

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
      globalThis.__csim_storageSet(kind, key, value);
      if (old !== value) dispatchStorageEvent(kind, key, old, value);
    },
    removeItem(k) {
      const key = String(k);
      const old = self.getItem(key);
      globalThis.__csim_storageRemove(kind, key);
      if (old != null) dispatchStorageEvent(kind, key, old, null);
    },
    clear() {
      globalThis.__csim_storageClear(kind);
      dispatchStorageEvent(kind, null, null, null);
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
