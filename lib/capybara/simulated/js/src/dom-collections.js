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
export class NodeList       extends Array {}
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
