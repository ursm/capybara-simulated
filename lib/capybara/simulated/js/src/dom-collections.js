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
export class NamedNodeMap   extends Array {}

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
