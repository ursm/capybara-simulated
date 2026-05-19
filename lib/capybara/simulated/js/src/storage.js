// localStorage / sessionStorage — Ruby-backed (host fns on
// `globalThis.__csim_storage*`) so entries survive the per-visit
// `rebuild_ctx`. Without that, apps that cache state in
// `localStorage` on page A (Forem's `browserStoreCache('set')` inside
// `fetchBaseData`) lose it on page B and the first-call branches that
// hinge on cached data silently skip.

function makeStorage(kind) {
  return {
    get length()  { return globalThis.__csim_storageLength(kind); },
    key(i) {
      const v = globalThis.__csim_storageKey(kind, i | 0);
      return v == null ? null : String(v);
    },
    getItem(k) {
      const v = globalThis.__csim_storageGet(kind, String(k));
      return v == null ? null : String(v);
    },
    setItem(k, v) { globalThis.__csim_storageSet(kind, String(k), String(v == null ? '' : v)); },
    removeItem(k) { globalThis.__csim_storageRemove(kind, String(k)); },
    clear()       { globalThis.__csim_storageClear(kind); }
  };
}

export const localStorage   = makeStorage('local');
export const sessionStorage = makeStorage('session');
