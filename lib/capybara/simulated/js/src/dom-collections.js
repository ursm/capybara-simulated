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

export class HTMLCollection extends Array {}
// `item` / `namedItem` live on the prototype (NOT as own properties) so they're
// shadowable by an expando (`coll.item = x`) per the WebIDL legacy-platform-
// object rules, and absent from `Object.getOwnPropertyNames(coll)`. They read
// through `this` (which, for a live collection, is the Proxy → live values).
Object.defineProperty(HTMLCollection.prototype, 'item', {
  value: function (i) { i = i >>> 0; const v = this[i]; return v === undefined ? null : v; },
  writable: true, enumerable: false, configurable: true
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
  writable: true, enumerable: false, configurable: true
});
export class NodeList       extends Array {
  // Spec `NodeList.item(i)` — `null` past the end (vs Array's `undefined`).
  item(i) { i = i >>> 0; return i < this.length ? this[i] : null; }
}

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
export class NamedNodeMap {
  get length()           { const s = nnmState.get(this); return s ? s.items.length : 0; }
  item(i)                { i = i >>> 0; const s = nnmState.get(this); return s && i < s.items.length ? s.items[i] : null; }
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
  [Symbol.iterator]() { const s = nnmState.get(this); return (s ? s.items.slice() : [])[Symbol.iterator](); }
}
Object.defineProperty(NamedNodeMap.prototype, Symbol.toStringTag, { value: 'NamedNodeMap', configurable: true });

// Build a NamedNodeMap for `el` from its ordered Attr `items`. `dropUppercase`
// applies the spec "supported property names" filter (an HTML-namespace element
// in an HTML document omits any qualified name containing an ASCII upper alpha).
export function makeNamedNodeMap(el, items, dropUppercase) {
  const map = new NamedNodeMap();
  nnmState.set(map, { el, items });
  // Indexed own properties (enumerable) — integer keys sort first in
  // getOwnPropertyNames regardless of definition order.
  items.forEach((attr, i) => {
    Object.defineProperty(map, i, { value: attr, enumerable: true, configurable: true });
  });
  // Named own properties (the supported property names; non-enumerable), unique
  // qualified names in attribute order.
  const seen = new Set();
  for (const attr of items) {
    const name = attr.name;
    if (seen.has(name)) continue;
    seen.add(name);
    if (dropUppercase && /[A-Z]/.test(name)) continue;
    if (Object.prototype.hasOwnProperty.call(map, name)) continue;   // don't clobber an index-shaped name
    Object.defineProperty(map, name, { value: attr, enumerable: false, configurable: true });
  }
  return map;
}

globalThis.HTMLCollection = HTMLCollection;
globalThis.NodeList       = NodeList;
globalThis.NamedNodeMap   = NamedNodeMap;

// Tag a plain Array as a (static) HTMLCollection snapshot — `item` / `namedItem`
// come from the prototype. Used where a non-live snapshot is acceptable.
export function htmlCollection(arr) {
  return HTMLCollection.from(arr);
}

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
        // The WebIDL `length` getter brand-checks its receiver: reading
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
      // `length` is the Array target's own non-configurable, writable property —
      // the returned descriptor must match those flags (a Proxy invariant), only
      // the live value differs.
      if (prop === 'length') return { value: live().length, writable: true, enumerable: false, configurable: false };
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
      // (length / item / namedItem / forEach / …) — they aren't named props,
      // and emitting 'length' here too would be a duplicate-key TypeError.
      for (const n of hcSupportedNames(arr)) if (!INDEX_RE.test(n) && !(n in HTMLCollection.prototype)) keys.push(n);
      keys.push('length');
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

// Re-tag an array as a (static) NodeList in place — `querySelectorAll`'s spec
// return type. setPrototypeOf is O(1) (no copy); NodeList.from would re-iterate
// (costly on the find hot path for large result sets). Only the public
// querySelectorAll methods use this — internal getters keep the plain Array
// from `selectAll`, so `select.options` etc. don't wrongly become NodeLists.
export function nodeList(arr) {
  Object.setPrototypeOf(arr, NodeList.prototype);
  return arr;
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
