// `HTMLCollection` / `NodeList` / `NamedNodeMap` as `class X extends
// Array`, NOT plain aliases. core-js's `web.dom-collections.iterator`
// polyfill calls `setToStringTag(globalThis[name].prototype, name)`
// for each entry in its DOM-iterables list; if all three names
// pointed at `Array` itself, every iteration would write back to
// `Array.prototype`, leaving its `@@toStringTag` as the last winner
// ("NamedNodeMap"). Then `Object.prototype.toString.call([])` returns
// `[object NamedNodeMap]` and any library branching on that string
// (Tagify's `isObject`'s `type != 'Array'` is the canonical example)
// mis-routes our plain arrays. Subclassing keeps each prototype
// chain distinct so the polyfill writes to the dedicated subclass
// prototype.

import { currentSettleGen } from './mutation-observer.js';

const HTML_NS_HC = 'http://www.w3.org/1999/xhtml';
const INDEX_RE   = /^(?:0|[1-9]\d*)$/;   // a canonical array index string

// HTMLCollection is a WebIDL legacy platform object, NOT an Array (matches real
// browsers): `Array.isArray` is false, `length` is not an own property, and the
// Array methods (map/forEach/values/entries/…) do not leak in. Every instance is
// the Proxy returned by `liveHTMLCollection` (static collections wrap a fixed
// snapshot); the Proxy synthesises `length`, indexed access and named access from
// the live backing, and `item`/`namedItem`/`Symbol.iterator` read through `this`
// (→ the Proxy). The plain target carries only `instanceof` + the prototype.
export class HTMLCollection {}
// `item` / `namedItem` live on the prototype (NOT as own properties) so they're
// shadowable by an expando (`coll.item = x`) per the WebIDL legacy-platform-
// object rules, and absent from `Object.getOwnPropertyNames(coll)`. They read
// through `this` (which, for a live collection, is the Proxy → live values).
// WebIDL interface members (regular operations and attributes) are enumerable
// on the interface prototype, so `for (p in coll)` yields item / namedItem /
// length after the indexed properties (document.forms iteration). The named
// properties stay non-enumerable ([LegacyUnenumerableNamedProperties]).
Object.defineProperty(HTMLCollection.prototype, 'item', {
  value: function (i) { i = i >>> 0; const v = this[i]; return v === undefined ? null : v; },
  writable: true, enumerable: true, configurable: true
});
Object.defineProperty(HTMLCollection.prototype, 'namedItem', {
  // Spec: first element whose `id` is `name` (any namespace), else the first
  // HTML-namespace element whose `name` is `name`.
  value: function (name) {
    if (name == null || name === '') return null;
    name = String(name);
    const len = this.length;
    for (let i = 0; i < len; i++) { const el = this[i]; if (el && el._attrs && el._attrs.id === name) return el; }
    for (let i = 0; i < len; i++) { const el = this[i]; if (el && el._ns === HTML_NS_HC && el._attrs && el._attrs.name === name) return el; }
    return null;
  },
  writable: true, enumerable: true, configurable: true
});
// `length` lives on the prototype as an enumerable WebIDL attribute (so for-in
// enumerates it) but is NOT an own property of a collection — the live-
// collection Proxy's get/has traps synthesise the value, and ownKeys omits it,
// keeping `Object.getOwnPropertyNames(coll)` to indices + named props. This
// prototype getter is only reached when a collection's value is read off the
// raw (non-proxied) prototype; it counts consecutive indexed properties.
Object.defineProperty(HTMLCollection.prototype, 'length', {
  get: function () { let i = 0; while (this[i] !== undefined) i++; return i; },
  enumerable: true, configurable: true
});
// HTMLCollection is iterable (legacy platform object with an indexed getter), but
// only via `Symbol.iterator` — NOT the named `values`/`entries`/`keys`/`forEach`
// that NodeList (a real `iterable<Node>`) exposes. Walks `this` (→ the Proxy).
Object.defineProperty(HTMLCollection.prototype, Symbol.iterator, {
  value: function () {
    const self = this;
    let i = 0;
    return {
      next: () => i < self.length ? { value: self[i++], done: false } : { value: undefined, done: true },
      [Symbol.iterator]() { return this; }
    };
  },
  writable: true, enumerable: false, configurable: true
});
Object.defineProperty(HTMLCollection.prototype, Symbol.toStringTag, { value: 'HTMLCollection', configurable: true });
export class NodeList       extends Array {
  // Spec `NodeList.item(i)` — `null` past the end (vs Array's `undefined`).
  item(i) { i = i >>> 0; return i < this.length ? this[i] : null; }
}
// A STATIC NodeList (querySelectorAll's return) is NOT an Array exotic — see
// `nodeList()` — so it has no own `length`; its element count lives here, keyed
// on the instance, and is read through this prototype `length` getter. Putting
// `length` on the PROTOTYPE (as browsers do) is what makes the spec's tampering
// cases work: `Object.defineProperty(nl, 'length', …)` adds an own accessor that
// shadows it, `Object.setPrototypeOf(nl, …)` swaps it out, and redefining
// `NodeList.prototype.length` itself takes effect (WPT
// NodeList-static-length-getter-tampered ×6). A LIVE childNodes NodeList is a
// true Array exotic (`new NodeList()`); its own non-configurable Array `length`
// shadows this getter, so the getter is dormant for it and the hot `_children`
// mutation path is unchanged.
const staticNodeListLen = new WeakMap();
Object.defineProperty(NodeList.prototype, 'length', {
  get() { const n = staticNodeListLen.get(this); return n === undefined ? 0 : n; },
  configurable: true
});
// WebIDL gives NodeList a "NodeList" class string, so `{}.toString.call(nl)`
// is "[object NodeList]" (not the Array default) — document.getElementsByName
// asserts the interface, and childNodes reports the same in real browsers.
Object.defineProperty(NodeList.prototype, Symbol.toStringTag, { value: 'NodeList', configurable: true });

// NamedNodeMap is a legacy platform object, NOT an Array. Its only OWN
// properties are the indexed entries (`0`,`1`,… — enumerable) and the supported
// named properties (the attribute qualified names — non-enumerable); `length`,
// `item`, iteration and getNamedItem/etc. live on the prototype. So
// `Object.getOwnPropertyNames(el.attributes)` is exactly the index+name list a
// browser reports — no `length`, no array methods leaking in. (HTMLCollection /
// NodeList stay `extends Array`: they're heavily array-iterated by frameworks
// and the core-js toStringTag concern above applies to them; NamedNodeMap is
// fully detached from `Array.prototype`, which sidesteps that concern instead of
// relying on the subclass trick.) Backing state (owner element + ordered Attr
// list) lives in a WeakMap, never an own property, so it can't leak into
// getOwnPropertyNames.
const nnmState = new WeakMap();
// The instance methods read through the WeakMap state's `live()` (the ordered
// Attr nodes, recomputed per settle generation) and `el` (for the named-item
// methods), so a held `el.attributes` reference reflects later mutations. State
// is keyed on the PROXY (liveNamedNodeMap sets it), which is the `this` the
// methods see when called as `map.item(…)`.
export class NamedNodeMap {
  get length()           { const s = nnmState.get(this); return s ? s.live().length : 0; }
  item(i)                { i = i >>> 0; const s = nnmState.get(this); const a = s && s.live(); return a && i < a.length ? a[i] : null; }
  getNamedItem(name)     { const s = nnmState.get(this); return s ? s.el.getAttributeNode(name) : null; }
  getNamedItemNS(ns, ln) { const s = nnmState.get(this); return s ? s.el.getAttributeNodeNS(ns, ln) : null; }
  setNamedItem(attr)     { const s = nnmState.get(this); return s ? s.el.setAttributeNode(attr) : null; }
  setNamedItemNS(attr)   { const s = nnmState.get(this); return s ? s.el.setAttributeNode(attr) : null; }
  removeNamedItem(name) {
    const s = nnmState.get(this);
    const removed = s && s.el.getAttributeNode(name);
    if (!removed) throw new globalThis.DOMException("No attribute named '" + name + "'.", "NotFoundError");
    return s.el.removeAttributeNode(removed);
  }
  removeNamedItemNS(ns, ln) {
    const s = nnmState.get(this);
    const removed = s && s.el.getAttributeNodeNS(ns, ln);
    if (!removed) throw new globalThis.DOMException("No matching attribute.", "NotFoundError");
    return s.el.removeAttributeNode(removed);
  }
  [Symbol.iterator]() {
    const s = nnmState.get(this), a = s ? s.live() : [];
    let i = 0;
    return { next: () => i < a.length ? { value: a[i++], done: false } : { value: undefined, done: true },
             [Symbol.iterator]() { return this; } };
  }
}
Object.defineProperty(NamedNodeMap.prototype, Symbol.toStringTag, { value: 'NamedNodeMap', configurable: true });

// First Attr in `arr` whose qualified name === name (the NamedNodeMap named-
// property getter).
function nnmNamedItem(arr, name) {
  for (const a of arr) if (a && a.name === name) return a;
  return null;
}

// A LIVE NamedNodeMap (`element.attributes`): a legacy platform exotic object
// reflecting the element's CURRENT attribute list, mirroring liveHTMLCollection.
// `live()` recomputes the ordered Attr nodes (memoised per settle generation);
// the Proxy synthesises length / indexed access / named access (by attribute
// qualified name) and makes indices + supported names read-only. `dropUppercase`
// applies the spec "supported property names" filter (an HTML-namespace element
// in an HTML document omits any qualified name with an ASCII upper-alpha) to
// NAMED access only — indexed access + getNamedItem still reach every attribute.
// Named access is a FALLBACK: a name that exists on the prototype (length / item /
// setNamedItem / toString / …) is NOT shadowed by an attribute of that name.
export function liveNamedNodeMap(el, dropUppercase) {
  let cacheGen = NaN, cached = null;
  const live = () => {
    const g = currentSettleGen();
    if (g !== cacheGen) { cached = Object.keys(el._attrs).map(k => el._attrNodeFor(k)); cacheGen = g; }
    return cached;
  };
  const droppable = n => dropUppercase && /[A-Z]/.test(n);
  const supportedNames = () => {
    const out = [], seen = new Set();
    for (const a of live()) { const n = a.name; if (seen.has(n) || droppable(n)) continue; seen.add(n); out.push(n); }
    return out;
  };
  const target = new NamedNodeMap();
  const isSupportedNamed = (t, prop) =>
    typeof prop === 'string' &&
    !Object.prototype.hasOwnProperty.call(t, prop) &&
    !(prop in NamedNodeMap.prototype) &&
    !droppable(prop) &&
    !!nnmNamedItem(live(), prop);
  let proxy;
  proxy = new Proxy(target, {
    get(t, prop, recv) {
      if (prop === 'length') {
        if (recv !== proxy) throw new TypeError('Illegal invocation');
        return live().length;
      }
      if (typeof prop === 'string' && INDEX_RE.test(prop)) {
        const arr = live(), i = +prop;
        return i < arr.length ? arr[i] : undefined;
      }
      if (Object.prototype.hasOwnProperty.call(t, prop)) return t[prop];   // expando shadows
      if (typeof prop === 'string' && !(prop in NamedNodeMap.prototype) && !droppable(prop)) {
        const named = nnmNamedItem(live(), prop);
        if (named) return named;
      }
      return Reflect.get(t, prop, recv);   // prototype (item / getNamedItem / …), Symbol.iterator
    },
    set(t, prop, val, recv) {
      if (recv !== proxy) return Reflect.set(t, prop, val, recv);
      if (typeof prop === 'string' && INDEX_RE.test(prop)) return false;
      if (isSupportedNamed(t, prop)) return false;
      t[prop] = val;
      return true;
    },
    has(t, prop) {
      if (prop === 'length') return true;
      if (typeof prop === 'string' && INDEX_RE.test(prop)) return (+prop) < live().length;
      if (prop in t) return true;
      if (typeof prop === 'string' && !(prop in NamedNodeMap.prototype) && !droppable(prop) && nnmNamedItem(live(), prop)) return true;
      return false;
    },
    getOwnPropertyDescriptor(t, prop) {
      if (prop === 'length') return undefined;   // length is a prototype accessor, not an own prop
      if (typeof prop === 'string' && INDEX_RE.test(prop)) {
        const arr = live(), i = +prop;
        if (i < arr.length) return { value: arr[i], writable: false, enumerable: true, configurable: true };
        return undefined;
      }
      if (Object.prototype.hasOwnProperty.call(t, prop)) return Object.getOwnPropertyDescriptor(t, prop);
      if (typeof prop === 'string' && !(prop in NamedNodeMap.prototype) && !droppable(prop)) {
        const named = nnmNamedItem(live(), prop);
        if (named) return { value: named, writable: false, enumerable: false, configurable: true };
      }
      return undefined;
    },
    ownKeys(t) {
      const arr = live(), keys = [];
      for (let i = 0; i < arr.length; i++) keys.push(String(i));
      for (const n of supportedNames()) if (!INDEX_RE.test(n) && !(n in NamedNodeMap.prototype)) keys.push(n);
      for (const k of Reflect.ownKeys(t)) if (keys.indexOf(k) === -1) keys.push(k);   // expandos
      return keys;
    },
    defineProperty(t, prop, desc) {
      if (typeof prop === 'string' && INDEX_RE.test(prop)) return false;
      if (isSupportedNamed(t, prop)) return false;
      return Reflect.defineProperty(t, prop, desc);
    },
    deleteProperty(t, prop) {
      if (typeof prop === 'string' && INDEX_RE.test(prop)) return (+prop) >= live().length;
      if (isSupportedNamed(t, prop)) return false;
      return Reflect.deleteProperty(t, prop);
    }
  });
  nnmState.set(proxy, { el, live });
  return proxy;
}

globalThis.HTMLCollection = HTMLCollection;
globalThis.NodeList       = NodeList;
globalThis.NamedNodeMap   = NamedNodeMap;

// First element exposed by `name` (HTMLCollection named-property getter /
// `namedItem`): an `id` match (any namespace), else an HTML-element `name` match.
function hcNamedItem(arr, name) {
  if (name == null || name === '') return null;
  for (const el of arr) if (el && el._attrs && el._attrs.id === name) return el;
  for (const el of arr) if (el && el._ns === HTML_NS_HC && el._attrs && el._attrs.name === name) return el;
  return null;
}
// Ordered, unique "supported property names": each element's id (any ns) and
// each HTML element's name, both non-empty.
function hcSupportedNames(arr) {
  const out = [], seen = new Set();
  for (const el of arr) {
    if (!el || !el._attrs) continue;
    const id = el._attrs.id;
    if (id && !seen.has(id)) { seen.add(id); out.push(id); }
    const nm = el._ns === HTML_NS_HC ? el._attrs.name : null;
    if (nm && !seen.has(nm)) { seen.add(nm); out.push(nm); }
  }
  return out;
}

// A LIVE `HTMLCollection` (`getElementsByTagName` / `*ClassName` / `*NS`): a
// legacy platform exotic object reflecting the current tree. `rawQuery()`
// recomputes the matching elements; we memoise it per settle generation so a
// stable DOM doesn't re-walk on every access, yet a mutation (which bumps the
// settle gen) is reflected immediately. The Proxy gives the exotic semantics:
// read-only integer indices, named-property access (id / name), `length`, and
// freely-settable expandos (which shadow the prototype's `item`/`namedItem`).
export function liveHTMLCollection(rawQuery) {
  let cacheGen = NaN, cached = null;
  const live = () => {
    const g = currentSettleGen();
    if (g !== cacheGen) { cached = rawQuery(); cacheGen = g; }
    return cached;
  };
  const target = new HTMLCollection();   // real HTMLCollection → instanceof + toStringTag + prototype
  // A supported named property (an element's id / HTML `name`) is read-only and
  // can't be shadowed/removed by an expando: it has no own expando, isn't a
  // prototype member, and currently matches an element. Used by the write traps
  // so set / defineProperty / delete reject it (WebIDL legacy platform object).
  const isSupportedNamed = (t, prop) =>
    typeof prop === 'string' &&
    !Object.prototype.hasOwnProperty.call(t, prop) &&
    !(prop in HTMLCollection.prototype) &&
    !!hcNamedItem(live(), prop);
  let proxy;
  proxy = new Proxy(target, {
    get(t, prop, recv) {
      if (prop === 'length') {
        // A page may override `length` with an own expando (defineProperty) —
        // WebIDL legacy platform objects allow it, and the array iterator then
        // reads the overridden accessor (Blob-constructor-dom "overwritten
        // 'length'"). Once `length` is a real own property the WebIDL `length`
        // getter no longer governs it, so this path precedes the brand-check:
        // an own data property must read back for ANY receiver (proxy
        // get/getOwnPropertyDescriptor invariant).
        if (Object.prototype.hasOwnProperty.call(t, 'length')) return Reflect.get(t, 'length', recv);
        // The synthesised `length` getter brand-checks its receiver: reading
        // `.length` through a derived object (`Object.create(coll).length`)
        // throws, since that object isn't the platform collection itself.
        if (recv !== proxy) throw new TypeError('Illegal invocation');
        return live().length;
      }
      if (typeof prop === 'string' && INDEX_RE.test(prop)) {
        const arr = live(), i = +prop;
        return i < arr.length ? arr[i] : undefined;
      }
      if (Object.prototype.hasOwnProperty.call(t, prop)) return t[prop];   // expando shadows the prototype
      // Named-property access is a FALLBACK: a name that exists anywhere on the
      // prototype chain (length, item, namedItem, forEach, constructor, …) is
      // NOT shadowed by an element's id/name (per the legacy-platform-object
      // named-property rules).
      if (typeof prop === 'string' && !(prop in HTMLCollection.prototype)) {
        const named = hcNamedItem(live(), prop);
        if (named) return named;
      }
      return Reflect.get(t, prop, recv);   // prototype (item/namedItem/Array methods), Symbol.iterator, …
    },
    set(t, prop, val, recv) {
      // Setting through a derived receiver (the collection used as a prototype,
      // `Object.create(coll).x = …`) is an ordinary [[Set]] that creates an own
      // data property on that receiver, not on the collection.
      if (recv !== proxy) return Reflect.set(t, prop, val, recv);
      if (typeof prop === 'string' && INDEX_RE.test(prop)) return false;   // integer indices are read-only
      if (isSupportedNamed(t, prop)) return false;   // named props are read-only
      t[prop] = val;   // expandos
      return true;
    },
    has(t, prop) {
      if (prop === 'length') return true;
      if (typeof prop === 'string' && INDEX_RE.test(prop)) return (+prop) < live().length;
      if (prop in t) return true;
      if (typeof prop === 'string' && !(prop in HTMLCollection.prototype) && hcNamedItem(live(), prop)) return true;
      return false;
    },
    getOwnPropertyDescriptor(t, prop) {
      // `length` is NOT an own property of an HTMLCollection (it's exposed by the
      // prototype, synthesised by the `get`/`has` traps) — so it never appears in
      // `Object.getOwnPropertyNames`. The non-Array target has no own `length`, so
      // reporting it absent here is invariant-safe. EXCEPTION: a page-defined
      // expando `length` (defineProperty) IS an own property and must be reported
      // (proxy invariant + ownKeys parity).
      if (prop === 'length') {
        return Object.prototype.hasOwnProperty.call(t, 'length')
          ? Object.getOwnPropertyDescriptor(t, 'length')
          : undefined;
      }
      if (typeof prop === 'string' && INDEX_RE.test(prop)) {
        const arr = live(), i = +prop;
        if (i < arr.length) return { value: arr[i], writable: false, enumerable: true, configurable: true };
        return undefined;
      }
      if (Object.prototype.hasOwnProperty.call(t, prop)) return Object.getOwnPropertyDescriptor(t, prop);
      if (typeof prop === 'string' && !(prop in HTMLCollection.prototype)) {
        const named = hcNamedItem(live(), prop);
        if (named) return { value: named, writable: false, enumerable: false, configurable: true };
      }
      return undefined;
    },
    ownKeys(t) {
      const arr = live(), keys = [];
      for (let i = 0; i < arr.length; i++) keys.push(String(i));
      // Named keys exclude any name that's already a prototype property
      // (item / namedItem / Symbol.iterator / …) — they aren't named props. The
      // non-Array target has no own `length` to emit (matching real browsers,
      // `Object.getOwnPropertyNames(coll)` is just indices + named props).
      for (const n of hcSupportedNames(arr)) if (!INDEX_RE.test(n) && !(n in HTMLCollection.prototype)) keys.push(n);
      for (const k of Reflect.ownKeys(t)) if (keys.indexOf(k) === -1) keys.push(k);   // expandos
      return keys;
    },
    defineProperty(t, prop, desc) {
      // An array-index name can never be defined as an expando (in range or
      // not), nor can a supported named property be overridden.
      if (typeof prop === 'string' && INDEX_RE.test(prop)) return false;
      if (isSupportedNamed(t, prop)) return false;
      return Reflect.defineProperty(t, prop, desc);
    },
    deleteProperty(t, prop) {
      if (typeof prop === 'string' && INDEX_RE.test(prop)) {
        // A supported (in-range) index can't be removed → false, so a strict
        // `delete` throws. An out-of-range index is not a supported property,
        // so its deletion is a no-op that succeeds → true (strict won't throw).
        return (+prop) >= live().length;
      }
      if (isSupportedNamed(t, prop)) return false;   // named props can't be removed
      return Reflect.deleteProperty(t, prop);
    }
  });
  return proxy;
}

// `querySelectorAll`'s spec return type: a STATIC NodeList. Built as a
// NON-Array-exotic object so `length` is a prototype accessor (see above) rather
// than Array's own non-configurable length — that's what lets pages tamper with
// it the way real browsers allow. Own enumerable index properties carry the
// elements; the count goes in `staticNodeListLen`. It stays `instanceof
// NodeList`, iterable, and array-like (the inherited `Array.prototype` methods —
// forEach / map / filter / indexOf / the iterator — all read `.length` + the
// index properties), but `Array.isArray` is now false, so the Ruby marshalling
// (`marshalReturn`) recognises a NodeList explicitly. Only the public
// querySelectorAll methods use this — internal getters keep the plain Array from
// `selectAll`, so `select.options` etc. don't wrongly become NodeLists and the
// Capybara find hot path (which uses `selectAll`) never pays this copy.
export function nodeList(arr) {
  const n  = arr.length;
  const nl = Object.create(NodeList.prototype);
  for (let i = 0; i < n; i++) nl[i] = arr[i];
  staticNodeListLen.set(nl, n);
  return nl;
}

// A node's `_children` IS a NodeList instance, so `get childNodes()` can return
// it directly: O(1), cached (same object), and LIVE (held refs see mutations).
// Built born (`new NodeList()` + push) rather than setPrototypeOf so the hot
// mutation path (`_children.push` in appendChild) isn't deopted.
export function newChildList(items) {
  const nl = new NodeList();
  if (items) for (const x of items) nl.push(x);
  return nl;
}

// A LIVE NodeList (`document.getElementsByName`): a true Array-exotic NodeList
// whose contents are recomputed per settle generation, so a held reference
// reflects later DOM mutations — the NodeList analogue of liveHTMLCollection.
// `rawQuery()` returns the current matching nodes; a thin Proxy resyncs the
// backing array on access (the settle-gen check keeps a stable DOM from
// re-walking on every read). The target is a real NodeList so `instanceof
// NodeList` / the "NodeList" class string hold and Array methods work.
export function liveNodeList(rawQuery) {
  const target = new NodeList();
  let cacheGen = NaN;
  const sync = () => {
    const g = currentSettleGen();
    if (g !== cacheGen) {
      const arr = rawQuery();
      target.length = 0;
      for (let i = 0; i < arr.length; i++) target[i] = arr[i];
      cacheGen = g;
    }
    return target;
  };
  return new Proxy(target, {
    get(t, p, r)                     { sync(); return Reflect.get(t, p, r); },
    has(t, p)                        { sync(); return Reflect.has(t, p); },
    ownKeys(t)                       { sync(); return Reflect.ownKeys(t); },
    getOwnPropertyDescriptor(t, p)   { sync(); return Reflect.getOwnPropertyDescriptor(t, p); }
  });
}
