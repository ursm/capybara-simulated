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

// Notify the host of a change to the area `s` so it can fire `storage` on the OTHER same-origin documents: those but the
// area's own — its global's realm, which the host skips, whatever realm's method made the change — the event's `url` its
// document's. No local dispatch — the spec fires nowhere in the originating document.
function notifyStorageChanged(s, key, oldValue, newValue) {
  const global = s.global;
  if (typeof global.__csimStorageChanged !== 'function') return;
  const rid = global.RustyRacer.contextOf(global);
  const url = global.location ? global.location.href : '';
  // Wire-escaped like every storage host call, so a cross-document listener's
  // e.key/e.newValue round-trip lone surrogates exactly as getItem does.
  const enc = v => v == null ? v : wireEncode(String(v));
  try { global.__csimStorageChanged(s.kind, enc(key), enc(oldValue), enc(newValue), url, rid); } catch (_) {}
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

// Storage (HTML §12.2), generated from its IDL: an area — its kind, 'local' or 'session', and its global, its slots —
// whose items the host keeps. `new Storage()` is not allowed.
const storageOf = (o) => slotsOf(o, 'Storage');
registerInterface('Storage', (o) => storageOf(o) !== undefined);
export class Storage {
  constructor(token) {
    constructedBy(PLATFORM, token, 'Storage');
  }
}
// An area's operations, on its slots — its kind, and its global, whose host functions keep its origin's items (a frame's
// method on its parent's area reads and writes the parent's) — what both its members and its named properties run.
function getItem(s, key) {
  const v = s.global.__csim_storageGet(s.kind, wireEncode(key));
  return v == null ? null : wireDecode(String(v));
}
// (…a false return the area's quota exceeded: QuotaExceededError after `prefix`, the caller's — nothing stored, no
// event (WHATWG "setItem"); its name, not just the legacy code 22, which assert_throws_quotaexceedederror checks)
function setItem(s, key, value, prefix) {
  const old = getItem(s, key);
  if (s.global.__csim_storageSet(s.kind, wireEncode(key), wireEncode(value)) === false) {
    throw new QuotaExceededError(prefix + `Setting the value of '${key}' exceeded the quota.`);
  }
  if (old !== value) notifyStorageChanged(s, key, old, value);
}
function removeItem(s, key) {
  const old = getItem(s, key);
  s.global.__csim_storageRemove(s.kind, wireEncode(key));
  if (old != null) notifyStorageChanged(s, key, old, null);
}
const length = (s) => s.global.__csim_storageLength(s.kind);
function key(s, index) {
  const v = s.global.__csim_storageKey(s.kind, index);
  return v == null ? null : wireDecode(String(v));
}
installStorage(Storage, {
  get_length: (area) => length(storageOf(area)),
  key: (area, index) => key(storageOf(area), index),
  getItem: (area, k) => getItem(storageOf(area), k),
  setItem: (area, k, v) => setItem(storageOf(area), k, v, "Failed to execute 'setItem' on 'Storage': "),
  removeItem: (area, k) => removeItem(storageOf(area), k),
  // (…an event only where the area was not empty already; the null key a bulk clear's)
  clear(area) {
    const s = storageOf(area);
    const had = length(s) > 0;
    s.global.__csim_storageClear(s.kind);
    if (had) notifyStorageChanged(s, null, null, null);
  }
});
globalThis.Storage = Storage;

// An area is a legacy platform object with named properties — `localStorage.foo = 'bar'`, `localStorage.foo`,
// `delete localStorage.foo` route through it as setItem / getItem / removeItem do (Discourse's `lib/key-value-store.js`
// writes `safeLocalStorage[ctx + key] = value`) — WITHOUT [LegacyOverrideBuiltIns]: an item is HIDDEN where its name is
// reachable on the prototype chain, a builtin (`getItem`) or an author's `Storage.prototype[key]` (`prop in target`
// walks it); only names off the chain are its named properties (Web IDL §3.9). The Proxy runs the area's operations,
// not its members a page may have replaced; its slots are the Proxy's own.
const namedSet = (name) => `Failed to set a named property '${name}' on 'Storage': `;
const visible = (target, prop) => typeof prop === 'string' && !(prop in target);
function makeStorage(kind) {
  const target = Object.create(Storage.prototype);
  let s;
  const area = new Proxy(target, {
    get(target, prop, receiver) {
      if (!visible(target, prop)) return Reflect.get(target, prop, receiver);
      return getItem(s, prop) ?? undefined;
    },
    // ([[Set]]: the named setter ALWAYS writes the item where the area is the receiver — even for a name shadowed by a
    // prototype property, whose [[Set]] must not run — and for another receiver, an object inheriting from the area,
    // the ordinary steps)
    set(target, prop, value, receiver) {
      if (typeof prop === 'symbol' || receiver !== area) return Reflect.set(target, prop, value, receiver);
      setItem(s, prop, toDOMString(value, false, namedSet(prop)), namedSet(prop));
      return true;
    },
    // ([[Delete]]: a visible name's item removed — a hidden one's not, nor any item of a name the chain has)
    deleteProperty(target, prop) {
      if (!visible(target, prop)) return Reflect.deleteProperty(target, prop);
      removeItem(s, prop);
      return true;
    },
    // ([[DefineOwnProperty]]: a data descriptor stores the item — its [[Value]], undefined where absent; an accessor
    // one, or one neither, refused. A non-configurable one is refused too, where the spec stores it: a Proxy cannot
    // report a property the target lacks as non-configurable — a bounded gap.)
    defineProperty(target, prop, desc) {
      if (typeof prop === 'symbol') return Reflect.defineProperty(target, prop, desc);
      if (!('value' in desc) && !('writable' in desc)) return false;
      if (desc.configurable === false) return false;
      setItem(s, prop, toDOMString(desc.value, false, namedSet(prop)), namedSet(prop));
      return true;
    },
    has(target, prop) {
      if (!visible(target, prop)) return Reflect.has(target, prop);
      return getItem(s, prop) != null;
    },
    // ([[OwnPropertyKeys]]: the visible names, in the items' order, then the target's own keys — strings, symbols)
    ownKeys(target) {
      const keys = [];
      for (let i = 0, n = length(s); i < n; i++) {
        const name = key(s, i);
        if (!(name in target)) keys.push(name);
      }
      return keys.concat(Reflect.ownKeys(target));
    },
    getOwnPropertyDescriptor(target, prop) {
      if (!visible(target, prop)) return Reflect.getOwnPropertyDescriptor(target, prop);
      const v = getItem(s, prop);
      return v == null ? undefined : { value: v, writable: true, enumerable: true, configurable: true };
    },
    // ([[PreventExtensions]]: false — a legacy platform object stays extensible)
    preventExtensions: () => false
  });
  s = makeSlots(area, 'Storage', { kind, global: globalThis });
  return area;
}

export const localStorage   = makeStorage('local');
export const sessionStorage = makeStorage('session');
