// localStorage / sessionStorage: the engine's areas (storage_areas.rs) — a storage shed of the session's for
// localStorage, every window's, and one of the top-level browsing context's for sessionStorage, which the host hands
// over (`__csimStoragePartitions`); an area per storage key of each — the document's origin, and its top-level site —
// of the realm whose global's area it is. The sheds outlive the per-visit `rebuild_ctx`: apps that cache state in `localStorage` on page A
// (Forem's `browserStoreCache('set')` inside `fetchBaseData`) find it on page B.
//
// Per HTML spec, modifying a Storage area fires a `storage` event on every OTHER document whose area it is — NOT the
// one that made the change. The host (`__csimStorageChanged`) fans the change out to the sibling realms and the other
// windows and delivers it back through `__csim_deliverStorageEvents`; the changing realm is excluded, so it never sees
// its own writes, and a document of another storage key — another origin, or the same one under another top-level
// site — lets it go.

import { QuotaExceededError, StorageEvent } from './events.js';
import { PLATFORM, constructedBy, makeSlots, registerInterface, slotsOf, toDOMString } from './webidl.js';
import { installStorage } from './generated/bindings.js';
import { fireEvent } from './dispatch.js';
import { hostTask } from './timers.js';

// The sheds: [localStorage's, sessionStorage's], the host's for this realm's browser — none (0) while it has no host
// (asked again then: a snapshot's boot runs before the host's functions are there).
let partitions = null;
function shedOf(s) {
  if (partitions === null && typeof globalThis.__csimStoragePartitions === 'function') partitions = globalThis.__csimStoragePartitions();
  return partitions === null ? 0 : partitions[s.kind === 'local' ? 0 : 1];
}
// …and the realm whose document's storage key names the area: that of the global it is of.
const realmOf = (s) => (s.realm ??= s.global.RustyRacer.contextOf(s.global));

// Notify the host of a change to the area `s` so it can fire `storage` on the OTHER documents of its storage key: those
// but the area's own — its global's realm, which the host skips, whatever realm's method made the change — the event's
// `url` its document's, its `area` the key. No local dispatch — the spec fires nowhere in the originating document.
function notifyStorageChanged(s, key, oldValue, newValue) {
  const global = s.global;
  if (typeof global.__csimStorageChanged !== 'function') return;
  const url = global.location ? global.location.href : '';
  // Wire-escaped, so a cross-document listener's e.key/e.newValue round-trip lone surrogates exactly as getItem does.
  const enc = v => v == null ? v : wireEncode(String(v));
  try { global.__csimStorageChanged(s.kind, enc(key), enc(oldValue), enc(newValue), url, realmOf(s), global.__dom.storageAreaKey(realmOf(s))); } catch (_) {}
}

// Fire a `storage` event the host routed to THIS document (from another realm / window) — each its own task, a call of
// its own — where it is a document of the area's storage key.
globalThis.__csim_deliverStorageEvents = hostTask(function (e) {
  if (e.area !== globalThis.__dom.storageAreaKey()) return;
  const dec = v => v == null ? v : wireDecode(String(v));
  try {
    fireEvent(globalThis, new StorageEvent('storage', {
      key:         dec(e.key),
      oldValue:    dec(e.old),
      newValue:    dec(e.new),
      url:         e.url,
      // (…this realm's own area, not a window property the page may have replaced)
      storageArea: e.kind === 'local' ? localStorage : sessionStorage,
    }));
  } catch (_) {}
});

// The event's wire through the host: Ruby↔V8 marshalling is UTF-8 (a LONE surrogate becomes U+FFFD on the way through),
// but a `storage` event's strings are DOMStrings. Escape them — and any literal U+FFFF, the escape lead — into
// `U+FFFF xxxx` (4 hex) before crossing, and reverse on the way back. Well-formed strings (no lone surrogate, no U+FFFF)
// pass the test untouched. (The areas themselves are the engine's, in UTF-16.)
const WIRE_ESC = /\uFFFF|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<=^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const WIRE_UNESC = /\uFFFF([0-9a-f]{4})/g;
function wireEncode(s) {
  return s.replace(WIRE_ESC, c => '\uFFFF' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}
function wireDecode(s) {
  return s.indexOf('\uFFFF') === -1 ? s : s.replace(WIRE_UNESC, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

// Storage (HTML §12.2), generated from its IDL: an area — its kind, 'local' or 'session', its global and that global's
// realm, its slots — whose items the engine keeps. `new Storage()` is not allowed.
const storageOf = (o) => slotsOf(o, 'Storage');
registerInterface('Storage', (o) => storageOf(o) !== undefined);
export class Storage {
  constructor(token) {
    constructedBy(PLATFORM, token, 'Storage');
  }
}
// An area's operations, on its slots — its kind's shed, and its global's realm, whose document's storage key names the area
// (a frame's method on its parent's area reads and writes the parent's) — what both its members and its named
// properties run.
const getItem = (s, key) => globalThis.__dom.storageGet(shedOf(s), realmOf(s), key);
// (…a false return the area's quota exceeded: QuotaExceededError after `prefix`, the caller's — nothing stored, no
// event (WHATWG "setItem"); its name, not just the legacy code 22, which assert_throws_quotaexceedederror checks)
function setItem(s, key, value, prefix) {
  const [stored, old] = globalThis.__dom.storageSet(shedOf(s), realmOf(s), key, value);
  if (!stored) throw new QuotaExceededError(prefix + `Setting the value of '${key}' exceeded the quota.`);
  if (old !== value) notifyStorageChanged(s, key, old, value);
}
function removeItem(s, key) {
  const old = globalThis.__dom.storageRemove(shedOf(s), realmOf(s), key);
  if (old != null) notifyStorageChanged(s, key, old, null);
}
const length = (s) => globalThis.__dom.storageLength(shedOf(s), realmOf(s));
const key = (s, index) => globalThis.__dom.storageKey(shedOf(s), realmOf(s), index);
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
    globalThis.__dom.storageClear(shedOf(s), realmOf(s));
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
  s = makeSlots(area, 'Storage', { kind, global: globalThis, realm: undefined });
  return area;
}

export const localStorage   = makeStorage('local');
export const sessionStorage = makeStorage('session');
