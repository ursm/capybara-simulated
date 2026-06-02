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

export class HTMLCollection extends Array {}
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

// Tag a plain Array as HTMLCollection-shaped (Array + `.item(i)` +
// `.namedItem(name)`). DOM spec returns HTMLCollection; lots of
// Redmine code paths (updateSVGIcon, etc.) do `collection.item(0)`.
export function htmlCollection(arr) {
  const hc = HTMLCollection.from(arr);
  hc.item = function (i) { return this[i] || null; };
  hc.namedItem = function (n) {
    for (const el of this) if (el && el._attrs && (el._attrs.id === n || el._attrs.name === n)) return el;
    return null;
  };
  return hc;
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
