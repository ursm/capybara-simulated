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

import { QuotaExceededError, StorageEvent } from './events.js';
import { PLATFORM, constructedBy, makeSlots, registerInterface, slotsOf, toDOMString } from './webidl.js';
import { installStorage } from './generated/bindings.js';
import { fireEvent } from './dispatch.js';

// Notify the host of a change so it can fire `storage` on the OTHER same-origin documents. `rid`
// is this realm's id (the host skips it), and `url` is the changing document's URL (the event's
// `url` attribute). No local dispatch — the spec fires nowhere in the originating document.
function notifyStorageChanged(kind, key, oldValue, newValue) {
  if (typeof globalThis.__csimStorageChanged !== 'function') return;
  const rid = globalThis.RustyRacer.contextOf(globalThis);
  const url = globalThis.location ? globalThis.location.href : '';
  // Wire-escaped like every storage host call, so a cross-document listener's
  // e.key/e.newValue round-trip lone surrogates exactly as getItem does.
  const enc = v => v == null ? v : wireEncode(String(v));
  try { globalThis.__csimStorageChanged(kind, enc(key), enc(oldValue), enc(newValue), url, rid); } catch (_) {}
}

// Fire the `storage` events the host routed to THIS document (from another realm / window).
globalThis.__csim_deliverStorageEvents = function (events) {
  if (!events || !events.length) return;
  for (const e of events) {
    try {
      const dec = v => v == null ? v : wireDecode(String(v));
      fireEvent(globalThis, new StorageEvent('storage', {
        key:         dec(e.key),
        oldValue:    dec(e.old),
        newValue:    dec(e.new),
        url:         e.url,
        // (…this realm's own area, not a window property the page may have replaced)
        storageArea: e.kind === 'local' ? localStorage : sessionStorage,
      }));
    } catch (_) {}
  }
};

// The wire to the host: Ruby↔V8 marshalling is UTF-8 (a LONE surrogate becomes U+FFFD on the way through), but Storage
// is DOMString-faithful: lone surrogates must round-trip (storage_setitem). Escape them — and any literal U+FFFF, the
// escape lead — into `U+FFFF xxxx` (4 hex) before crossing, and reverse on the way back. Well-formed strings (no lone
// surrogate, no U+FFFF) pass the test untouched.
const WIRE_ESC = /\uFFFF|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<=^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const WIRE_UNESC = /\uFFFF([0-9a-f]{4})/g;
function wireEncode(s) {
  return s.replace(WIRE_ESC, c => '\uFFFF' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}
function wireDecode(s) {
  return s.indexOf('\uFFFF') === -1 ? s : s.replace(WIRE_UNESC, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

// Storage (HTML §12.2), generated from its IDL: an area — its kind, 'local' or 'session', its slot — whose items the
// host keeps. `new Storage()` is not allowed.
const storageOf = (o) => slotsOf(o, 'Storage');
registerInterface('Storage', (o) => storageOf(o) !== undefined);
export class Storage {
  constructor(token) {
    constructedBy(PLATFORM, token, 'Storage');
  }
}
// An area's operations, by its kind — what both its members and its named properties run.
function getItem(kind, key) {
  const v = globalThis.__csim_storageGet(kind, wireEncode(key));
  return v == null ? null : wireDecode(String(v));
}
// (…a false return the area's quota exceeded: QuotaExceededError, nothing stored, no event — WHATWG "setItem"; its
// name, not just the legacy code 22, which assert_throws_quotaexceedederror checks)
function setItem(kind, key, value) {
  const old = getItem(kind, key);
  if (globalThis.__csim_storageSet(kind, wireEncode(key), wireEncode(value)) === false) {
    throw new QuotaExceededError(`Failed to execute 'setItem' on 'Storage': Setting the value of '${key}' exceeded the quota.`);
  }
  if (old !== value) notifyStorageChanged(kind, key, old, value);
}
function removeItem(kind, key) {
  const old = getItem(kind, key);
  globalThis.__csim_storageRemove(kind, wireEncode(key));
  if (old != null) notifyStorageChanged(kind, key, old, null);
}
function key(kind, index) {
  const v = globalThis.__csim_storageKey(kind, index);
  return v == null ? null : wireDecode(String(v));
}
installStorage(Storage, {
  get_length: (area) => globalThis.__csim_storageLength(storageOf(area).kind),
  key: (area, index) => key(storageOf(area).kind, index),
  getItem: (area, k) => getItem(storageOf(area).kind, k),
  setItem: (area, k, v) => setItem(storageOf(area).kind, k, v),
  removeItem: (area, k) => removeItem(storageOf(area).kind, k),
  // (…an event only where the area was not empty already; the null key a bulk clear's)
  clear(area) {
    const kind = storageOf(area).kind;
    const had = globalThis.__csim_storageLength(kind) > 0;
    globalThis.__csim_storageClear(kind);
    if (had) notifyStorageChanged(kind, null, null, null);
  }
});
globalThis.Storage = Storage;

// An area is a legacy platform object with named properties — `localStorage.foo = 'bar'`, `localStorage.foo`,
// `delete localStorage.foo` route through it as setItem / getItem / removeItem do (Discourse's `lib/key-value-store.js`
// writes `safeLocalStorage[ctx + key] = value`) — WITHOUT [LegacyOverrideBuiltIns]: an item is HIDDEN where its name is
// reachable on the prototype chain, a builtin (`getItem`) or an author's `Storage.prototype[key]` (`prop in target`
// walks it); only names off the chain are items. The Proxy runs the area's operations, not its members a page may have
// replaced; its slots are the Proxy's own.
const namedSet = (name) => `Failed to set a named property '${name}' on 'Storage': `;
function makeStorage(kind) {
  const target = Object.create(Storage.prototype);
  const area = new Proxy(target, {
    get(target, prop, receiver) {
      if (typeof prop === 'symbol' || (prop in target)) return Reflect.get(target, prop, receiver);
      return getItem(kind, prop) ?? undefined;
    },
    // (…the named property setter ALWAYS writes the item — even for a name shadowed by a prototype property, whose
    // [[Set]] must not run)
    set(target, prop, value, receiver) {
      if (typeof prop === 'symbol') return Reflect.set(target, prop, value, receiver);
      setItem(kind, prop, toDOMString(value, false, namedSet(prop)));
      return true;
    },
    deleteProperty(target, prop) {
      if (typeof prop === 'symbol') return Reflect.deleteProperty(target, prop);
      removeItem(kind, prop);
      return true;
    },
    // (…[[DefineOwnProperty]]: a data descriptor stores the item, an accessor one is refused)
    defineProperty(target, prop, desc) {
      if (typeof prop === 'symbol') return Reflect.defineProperty(target, prop, desc);
      if (desc.get !== undefined || desc.set !== undefined) return false;
      if ('value' in desc) setItem(kind, prop, toDOMString(desc.value, false, namedSet(prop)));
      return true;
    },
    has(target, prop) {
      if (typeof prop === 'symbol' || (prop in target)) return true;
      return getItem(kind, prop) != null;
    },
    ownKeys() {
      const keys = [];
      const length = globalThis.__csim_storageLength(kind);
      for (let i = 0; i < length; i++) keys.push(key(kind, i));
      return keys;
    },
    getOwnPropertyDescriptor(target, prop) {
      if (typeof prop === 'symbol' || (prop in target)) return Reflect.getOwnPropertyDescriptor(target, prop);
      const v = getItem(kind, prop);
      return v == null ? undefined : { value: v, writable: true, enumerable: true, configurable: true };
    }
  });
  makeSlots(area, 'Storage', { kind });
  return area;
}

export const localStorage   = makeStorage('local');
export const sessionStorage = makeStorage('session');
