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
  return self;
}

export const localStorage   = makeStorage('local');
export const sessionStorage = makeStorage('session');
