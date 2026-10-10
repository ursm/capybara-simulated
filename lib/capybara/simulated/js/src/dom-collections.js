// The DOM's and HTML's collections: HTMLCollection and its two kinds, NodeList and RadioNodeList, NamedNodeMap — each
// a legacy platform object generated from its IDL, made by the platform alone, its indices (and names) answered by a
// Proxy over what it holds.

import { currentNodesGen } from './mutation-observer.js';
import { HTML_NS } from './constants.js';
import { asciiLower } from './ascii.js';
import { getCheckedness, setRadio } from './form-helpers.js';
import { childAtOf, childCountOf, childrenOf } from './native-query-shadow.js';
import { currentEdgeGen } from './tree.js';
import { PLATFORM, arrayIndex, constructedBy, interfaceCheck, makeSlots, registerInterface, slotsOf, withIndexedGetter } from './webidl.js';
import {
  installHTMLCollection,
  installHTMLFormControlsCollection,
  installHTMLOptionsCollection,
  installNamedNodeMap,
  installNodeList,
  installRadioNodeList
} from './generated/bindings.js';


// HTMLCollection (DOM §4.2.10.2) and its two kinds, HTMLOptionsCollection and HTMLFormControlsCollection (HTML §2.6.2),
// generated from their IDL: live legacy platform objects with indexed and named properties — the Proxy
// `legacyCollection` makes, its slots the query it answers (`live()`, the elements as they stand, found again per node
// generation). Not Arrays: `length`, the operations and @@iterator (%Array.prototype.values%) are the prototype's.
const collectionOf = (o) => slotsOf(o, 'HTMLCollection');
registerInterface('HTMLCollection', (o) => collectionOf(o) !== undefined);
export class HTMLCollection {
  constructor(token) { constructedBy(PLATFORM, token, new.target.name); }
}
installHTMLCollection(HTMLCollection, {
  get_length: (c) => collectionOf(c).live().length,
  item: (c, index) => nodeAt(collectionOf(c).live(), index),
  namedItem: (c, name) => collectionOf(c).named(name) ?? null
});

// NodeList (DOM §4.2.10.1), generated from its IDL: a legacy platform object of nodes — the Proxy `withIndexedGetter`
// makes, its indices read off its slots (`at` / `count`): a node's children as they stand (childNodes, the engine's to
// answer), a query's answer found again once the tree moved (getElementsByName, labels), or a fixed list
// (querySelectorAll, a mutation record's).
// Not an Array: its `length` and `item`, and the value iterator's keys / values / entries / forEach (%Array.prototype%'s),
// are the prototype's.
const nodeListOf = (o) => slotsOf(o, 'NodeList');
registerInterface('NodeList', (o) => nodeListOf(o) !== undefined);
export class NodeList {
  constructor(token) { constructedBy(PLATFORM, token, new.target.name); }
}
installNodeList(NodeList, {
  get_length: (list) => { const s = nodeListOf(list); return s.count(s); },
  item: (list, index) => { const s = nodeListOf(list); return s.at(s, index); }
});
// (…the index-th node, or null past the end — never an index %Array.prototype% was given)
const nodeAt = (nodes, index) => (index < nodes.length ? nodes[index] : null);
// A list's nodes are `nodes()`, its index-th one `at(slots, index)` and how many `count(slots)` — read off the array
// unless the list answers them itself (a node's `childNodes`, the engine's).
const atOfNodes = (s, index) => nodeAt(s.nodes(), index);
const countOfNodes = (s) => s.nodes().length;
function makeNodeList(Interface, nodes, at = atOfNodes, count = countOfNodes) {
  const list = new Interface(PLATFORM);
  makeSlots(list, 'NodeList', { nodes, at, count });
  return withIndexedGetter(list, at, count);
}
// (…a query's answer, `rawQuery()` once per `generation()` — the node generation, unless what it asks moves with less)
function liveNodes(rawQuery, generation = currentNodesGen) {
  let cacheGen = NaN, cached = null;
  return () => {
    const g = generation();
    if (g !== cacheGen) { cached = rawQuery(); cacheGen = g; }
    return cached;
  };
}

// NamedNodeMap (DOM §4.9.1), generated from its IDL: an element's attributes, a legacy platform object with indexed and
// named properties — the Proxy `liveNamedNodeMap` makes, whose traps answer them and whose slots hold its element, the
// list of its attributes (`live()`) and the element's attribute steps (dom-nodes.js `attributeSteps`). Its only OWN
// properties are the indexed entries (enumerable) and the supported named properties (non-enumerable); `length`, the
// operations and @@iterator are the prototype's.
const nnmOf = (o) => slotsOf(o, 'NamedNodeMap');
registerInterface('NamedNodeMap', (o) => nnmOf(o) !== undefined);
export class NamedNodeMap {
  constructor(token) { constructedBy(PLATFORM, token, 'NamedNodeMap'); }
}
installNamedNodeMap(NamedNodeMap, {
  get_length: (map) => nnmOf(map).live().length,
  item(map, index) {
    const a = nnmOf(map).live();
    return index < a.length ? a[index] : null;
  },
  getNamedItem: (map, name) => { const s = nnmOf(map); return s.steps.getAttributeNode(s.el, name); },
  getNamedItemNS: (map, ns, ln) => { const s = nnmOf(map); return s.steps.getAttributeNodeNS(s.el, ns, ln); },
  setNamedItem: (map, attr) => nnmOf(map).el._setAttributeNode(attr),
  setNamedItemNS: (map, attr) => nnmOf(map).el._setAttributeNode(attr),
  // (…a NotFoundError for one there is not)
  removeNamedItem(map, name) {
    const s = nnmOf(map), attr = s.steps.getAttributeNode(s.el, name);
    if (!attr) throw new DOMException(`Failed to execute 'removeNamedItem' on 'NamedNodeMap': No item with name '${name}' was found.`, 'NotFoundError');
    return s.steps.removeAttr(s.el, attr);
  },
  removeNamedItemNS(map, ns, ln) {
    const s = nnmOf(map), attr = s.steps.getAttributeNodeNS(s.el, ns, ln);
    if (!attr) throw new DOMException("Failed to execute 'removeNamedItemNS' on 'NamedNodeMap': No item with that namespace and local name was found.", 'NotFoundError');
    return s.steps.removeAttr(s.el, attr);
  }
});

// First Attr in `arr` whose qualified name === name (the NamedNodeMap named-
// property getter).
function nnmNamedItem(arr, name) {
  for (const a of arr) if (a && qualifiedNameOf(a) === name) return a;
  return null;
}
// An attribute's qualified name, read off it as the driver keeps it (not its `name`, which a page may redefine).
function qualifiedNameOf(attr) {
  return attr._prefix ? attr._prefix + ':' + attr._localName : attr._localName;
}

// A LIVE NamedNodeMap (`element.attributes`): a legacy platform exotic object
// reflecting the element's CURRENT attribute list, mirroring liveHTMLCollection.
// `live()` recomputes the ordered Attr nodes (memoised per node generation);
// the Proxy answers indexed access and named access (by attribute qualified
// name) and makes indices + supported names read-only; `length` is the
// prototype's accessor. The "supported property names" filter (an HTML-namespace
// element in an HTML document omits any qualified name with an ASCII upper-alpha,
// `steps.dropsUppercase`) applies to NAMED access only. Named access is a
// FALLBACK: a name that exists on the prototype (length / item / setNamedItem /
// toString / …) is NOT shadowed by an attribute of that name.
export function liveNamedNodeMap(el, steps) {
  let cacheGen = NaN, cached = null;
  const live = () => {
    const g = currentNodesGen();
    if (g !== cacheGen) { cached = Object.keys(el._attrs).map(k => el._attrNodeFor(k)); cacheGen = g; }
    return cached;
  };
  const droppable = (n) => /[A-Z]/.test(n) && steps.dropsUppercase(el);
  const supportedNames = () => {
    const out = [], seen = new Set();
    for (const a of live()) { const n = qualifiedNameOf(a); if (seen.has(n) || droppable(n)) continue; seen.add(n); out.push(n); }
    return out;
  };
  const target = Object.create(NamedNodeMap.prototype);
  const isSupportedNamed = (t, prop) =>
    typeof prop === 'string' &&
    !Object.prototype.hasOwnProperty.call(t, prop) &&
    !(prop in NamedNodeMap.prototype) &&
    !droppable(prop) &&
    !!nnmNamedItem(live(), prop);
  let proxy;
  proxy = new Proxy(target, {
    get(t, prop, recv) {
      const i = arrayIndex(prop);
      if (i >= 0) {
        const arr = live();
        return i < arr.length ? arr[i] : undefined;
      }
      if (Object.prototype.hasOwnProperty.call(t, prop)) return t[prop];   // expando shadows
      if (typeof prop === 'string' && !(prop in NamedNodeMap.prototype) && !droppable(prop)) {
        const named = nnmNamedItem(live(), prop);
        if (named) return named;
      }
      return Reflect.get(t, prop, recv);   // prototype (item / getNamedItem / …), Symbol.iterator
    },
    // [[Set]] (Web IDL §3.9.2): an index or a supported name, read-only own properties, refused — whoever the receiver
    // (an object the map is the prototype of finds them read-only too), anything else the ordinary steps.
    set(t, prop, val, recv) {
      const i = arrayIndex(prop);
      if (i >= 0 && (recv === proxy || i < live().length)) return false;
      if (recv === proxy && isSupportedNamed(t, prop)) return false;
      return Reflect.set(t, prop, val, recv);
    },
    has(t, prop) {
      const i = arrayIndex(prop);
      if (i >= 0) return i < live().length;
      if (prop in t) return true;
      if (typeof prop === 'string' && !(prop in NamedNodeMap.prototype) && !droppable(prop) && nnmNamedItem(live(), prop)) return true;
      return false;
    },
    getOwnPropertyDescriptor(t, prop) {
      const i = arrayIndex(prop);
      if (i >= 0) {
        const arr = live();
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
      for (const n of supportedNames()) if (arrayIndex(n) < 0 && !(n in NamedNodeMap.prototype)) keys.push(n);
      for (const k of Reflect.ownKeys(t)) if (keys.indexOf(k) === -1) keys.push(k);   // expandos
      return keys;
    },
    defineProperty(t, prop, desc) {
      if (arrayIndex(prop) >= 0) return false;
      if (isSupportedNamed(t, prop)) return false;
      return Reflect.defineProperty(t, prop, desc);
    },
    deleteProperty(t, prop) {
      const i = arrayIndex(prop);
      if (i >= 0) return i >= live().length;
      if (isSupportedNamed(t, prop)) return false;
      return Reflect.deleteProperty(t, prop);
    },
    // (…never made non-extensible: its indexed and named properties come and go, Web IDL §3.9.4)
    preventExtensions: () => false
  });
  makeSlots(proxy, 'NamedNodeMap', { el, live, steps });
  return proxy;
}

// A STATIC NodeList of the nodes in `nodes` (querySelectorAll's, a mutation record's), which nothing changes after.
export const nodeList = (nodes) => makeNodeList(NodeList, () => nodes);
// …a node's `childNodes`: its children as they stand — the engine's to count and to name. A read in a tree generation
// the list has not been read in asks for the one child (`childAtOf`), as a loop that removes a child each time reads it
// once a generation; a second reads them all at once (`childrenOf`), which the rest of an unchanged generation's reads
// — an iteration's — index.
export function childNodeList(node) {
  let readGen = NaN, keptGen = NaN, kept = null;
  const at = (_s, index) => {
    const gen = currentEdgeGen();
    if (keptGen === gen) return nodeAt(kept, index);
    if (readGen === gen) {
      kept = childrenOf(node);
      keptGen = gen;
      return nodeAt(kept, index);
    }
    readGen = gen;
    return childAtOf(node, index);
  };
  const count = () => (keptGen === currentEdgeGen() ? kept.length : childCountOf(node, false, childListLength));
  return makeNodeList(NodeList, () => childrenOf(node), at, count);
}
const childListLength = (node) => node._children.length;
// …a LIVE one of a query's answer (`document.getElementsByName`, `labels`).
export const liveNodeList = (rawQuery) => makeNodeList(NodeList, liveNodes(rawQuery));

// A node's child list (`_children`): a plain array — what `childNodes` reads (`childNodeList`) — built as it is
// filled.
export function newChildList(items) {
  const list = [];
  if (items) for (const x of items) appendTo(list, x);
  return list;
}
// …and a node appended to one: a store one past the end, an inline-cached grow. Every child-list append goes through
// here.
export function appendTo(list, node) { list[list.length] = node; }
// …and `count` nodes taken out of one at `index`, `nodes` put in their place, moved by index: an inline-cached store
// each (when the list was a NodeList, an Array subclass, `splice` took the generic path, 182 us for a front removal from
// 20,000 children where this took 5.9).
export function spliceList(list, index, count, nodes) {
  const len = list.length, add = nodes.length, shift = add - count;
  if (shift > 0) {
    for (let i = len - 1; i >= index + count; i--) list[i + shift] = list[i];
  } else if (shift < 0) {
    for (let i = index + count; i < len; i++) list[i + shift] = list[i];
    list.length = len + shift;
  }
  for (let i = 0; i < add; i++) list[index + i] = nodes[i];
}

// RadioNodeList (HTML §2.6.2.3), generated from its IDL: the NodeList a form's or `form.elements`' named getter answers
// when more than one control shares a name — live — with the radio group's `value`: the first checked radio button's
// value (its `value` attribute, "on" without one), and a write checking the first of that value.
const isRadio = (el) => el._tag === 'input' && asciiLower(el._attrs.type || '') === 'radio';
const radioValue = (el) => el._attrs.value ?? 'on';
registerInterface('RadioNodeList', (o) => slotsOf(o, 'RadioNodeList') !== undefined);
export class RadioNodeList extends NodeList {}
installRadioNodeList(RadioNodeList, {
  get_value(list) {
    const checked = nodeListOf(list).nodes().find((el) => isRadio(el) && getCheckedness(el));
    return checked ? radioValue(checked) : '';
  },
  set_value(list, v) {
    const radio = nodeListOf(list).nodes().find((el) => isRadio(el) && radioValue(el) === v);
    if (radio) setRadio(radio);
  }
});
export function liveRadioNodeList(rawQuery) {
  const list = makeNodeList(RadioNodeList, liveNodes(rawQuery));
  makeSlots(list, 'RadioNodeList');
  return list;
}

// First element exposed by `name` (HTMLCollection named-property getter /
// `namedItem`): an `id` match (any namespace), else an HTML-element `name` match.
function hcNamedItem(arr, name) {
  if (name === '') return undefined;
  for (const el of arr) if (el._attrs.id === name) return el;
  for (const el of arr) if (el._ns === HTML_NS && el._attrs.name === name) return el;
  return undefined;
}
// Ordered, unique "supported property names": each element's id (any ns) and
// each HTML element's name, both non-empty.
function hcSupportedNames(arr) {
  const out = [], seen = new Set();
  for (const el of arr) {
    const id = el._attrs.id;
    if (id && !seen.has(id)) { seen.add(id); out.push(id); }
    const nm = el._ns === HTML_NS ? el._attrs.name : null;
    if (nm && !seen.has(nm)) { seen.add(nm); out.push(nm); }
  }
  return out;
}

// A live collection's exotic object (Web IDL §3.9, [LegacyUnenumerableNamedProperties]): a Proxy over an object of
// `Interface` whose array indices are `live()`'s elements — read-only, or, where `setIndex` is given, written through it
// (HTMLOptionsCollection's indexed setter) — and whose supported names (`hcSupportedNames`) answer `named(name)`, but for
// a name the prototype chain has or an own expando shadows; anything else is the object's own, an expando. Its slots
// (`HTMLCollection`): `live` and `named`, stamped on the Proxy every caller holds.
function legacyCollection(Interface, live, named, setIndex = null) {
  const target = new Interface(PLATFORM);
  // The supported named property `prop`'s value — an element, a RadioNodeList — or undefined: none for an array index
  // ("ignoreNamedProps", Web IDL §3.9.1), a name an own expando or the prototype chain has, or one no element has.
  const namedValue = (t, prop) => (typeof prop !== 'string' || arrayIndex(prop) >= 0 || Object.hasOwn(t, prop) || prop in t ? undefined : named(prop));
  let proxy;
  proxy = new Proxy(target, {
    get(t, prop, recv) {
      const i = arrayIndex(prop);
      if (i >= 0) {
        const el = nodeAt(live(), i);
        if (el !== null) return el;
      } else {
        const v = namedValue(t, prop);
        if (v !== undefined) return v;
      }
      return Reflect.get(t, prop, recv);
    },
    // [[Set]] (Web IDL §3.9.2): an index set through the indexed setter where there is one; a supported index or name
    // otherwise read-only, whoever the receiver — an object the collection is the prototype of finds them so too — and
    // anything else the ordinary steps, on the receiver.
    set(t, prop, value, recv) {
      const i = arrayIndex(prop);
      if (i >= 0) {
        if (recv === proxy && setIndex !== null) {
          setIndex(i, value);
          return true;
        }
        if (setIndex === null && (recv === proxy || nodeAt(live(), i) !== null)) return false;
      } else if (recv === proxy && namedValue(t, prop) !== undefined) {
        return false;
      }
      return Reflect.set(t, prop, value, recv);
    },
    has(t, prop) {
      const i = arrayIndex(prop);
      if (i >= 0 && i < live().length) return true;
      return prop in t || namedValue(t, prop) !== undefined;
    },
    getOwnPropertyDescriptor(t, prop) {
      const i = arrayIndex(prop);
      if (i >= 0) {
        const el = nodeAt(live(), i);
        if (el !== null) return { value: el, writable: setIndex !== null, enumerable: true, configurable: true };
      } else {
        const v = namedValue(t, prop);
        if (v !== undefined) return { value: v, writable: false, enumerable: false, configurable: true };
      }
      return Reflect.getOwnPropertyDescriptor(t, prop);
    },
    ownKeys(t) {
      const arr = live(), keys = [];
      for (let i = 0; i < arr.length; i++) keys.push(String(i));
      for (const name of hcSupportedNames(arr)) if (arrayIndex(name) < 0 && !(name in t)) keys.push(name);
      for (const k of Reflect.ownKeys(t)) if (!keys.includes(k)) keys.push(k);
      return keys;
    },
    // (…an index defined only through the indexed setter, by a data descriptor — not a non-configurable one, which the
    // property it then reports would contradict — and a supported name never overridden)
    defineProperty(t, prop, desc) {
      const i = arrayIndex(prop);
      if (i >= 0) {
        // (…a data descriptor: one with a value or a `writable`, IsDataDescriptor)
        if (setIndex === null || !('value' in desc || 'writable' in desc) || desc.configurable === false) return false;
        setIndex(i, desc.value);
        return true;
      }
      if (namedValue(t, prop) !== undefined) return false;
      return Reflect.defineProperty(t, prop, desc);
    },
    // (…a supported index or name never removed: false, so a strict `delete` throws; one past the end no property)
    deleteProperty(t, prop) {
      const i = arrayIndex(prop);
      if (i >= 0) return i >= live().length;
      if (namedValue(t, prop) !== undefined) return false;
      return Reflect.deleteProperty(t, prop);
    },
    // (…never made non-extensible: its indexed and named properties come and go, Web IDL §3.9.4)
    preventExtensions: () => false
  });
  makeSlots(proxy, 'HTMLCollection', { live, named });
  return proxy;
}
// A LIVE HTMLCollection (`getElementsByTagName` / `*ClassName` / `children` / a table's rows …) of `rawQuery()`'s answer.
export function liveHTMLCollection(rawQuery, generation) {
  const live = liveNodes(rawQuery, generation);
  return legacyCollection(HTMLCollection, live, (name) => hcNamedItem(live(), name));
}

// `<select>.options`: an HTMLOptionsCollection — an HTMLCollection that is also written: an option set at an index
// (HTML "setting a new indexed property value"), `length`, `add`, `remove`, `selectedIndex` — all its select's.
registerInterface('HTMLOptionsCollection', (o) => slotsOf(o, 'HTMLOptionsCollection') !== undefined);
export class HTMLOptionsCollection extends HTMLCollection {}
const selectOf = (o) => slotsOf(o, 'HTMLOptionsCollection').select;
installHTMLOptionsCollection(HTMLOptionsCollection, {
  get_length: (c) => collectionOf(c).live().length,
  set_length(c, v) { selectOf(c).length = v; },
  add(c, element, before) { selectOf(c).add(element, before); },
  // (…the index-th option removed — none out of range)
  remove(c, index) {
    const option = index >= 0 ? nodeAt(collectionOf(c).live(), index) : null;
    if (option) option._parent._removeChild(option);
  },
  get_selectedIndex: (c) => selectOf(c).selectedIndex,
  set_selectedIndex(c, v) { selectOf(c).selectedIndex = v; }
});
const IS_OPTION = interfaceCheck('HTMLOptionElement');
export function liveOptionsCollection(select, rawQuery) {
  const live = liveNodes(rawQuery);
  // HTML "setting a new indexed property value": null removes the index-th option (none out of range); an option pads
  // the list with new blank ones up to the index and is appended, or replaces the index-th one.
  const setIndex = (index, option) => {
    option ??= null;   // (…`HTMLOptionElement?`: undefined is null)
    if (option !== null && !IS_OPTION(option)) {
      throw new TypeError("Failed to set an indexed property on 'HTMLOptionsCollection': The provided value is not of type 'HTMLOptionElement'.");
    }
    const options = live(), length = options.length;
    if (option === null) {
      if (index < length) options[index]._parent._removeChild(options[index]);
      return;
    }
    const n = index - length;
    // (…a defensive cap, as the select's `length` setter's: padding to an index near 2^32 one option at a time would
    // hang; a real grow is tiny)
    if (n > 100000) return;
    if (n > 0) {
      const doc = select.ownerDocument;
      for (let k = 0; k < n; k++) select._appendChild(doc.createElementNS(HTML_NS, 'option'));
    }
    if (n >= 0) select._appendChild(option);
    else options[index]._parent._replaceChild(option, options[index]);
  };
  const collection = legacyCollection(HTMLOptionsCollection, live, (name) => hcNamedItem(live(), name), setIndex);
  makeSlots(collection, 'HTMLOptionsCollection', { select });
  return collection;
}

// `form.elements`: an HTMLFormControlsCollection — an HTMLCollection whose named getter answers a RadioNodeList (live,
// the same one for a name) where more than one control has the name, the one control where one has it.
registerInterface('HTMLFormControlsCollection', (o) => slotsOf(o, 'HTMLFormControlsCollection') !== undefined);
export class HTMLFormControlsCollection extends HTMLCollection {}
installHTMLFormControlsCollection(HTMLFormControlsCollection, {
  namedItem: (c, name) => collectionOf(c).named(name) ?? null
});
// All controls in `arr` whose id (any namespace) or HTML `name` equals `name`.
function fccMatches(arr, name) {
  if (name === '') return [];
  return arr.filter((el) => el._attrs.id === name || (el._ns === HTML_NS && el._attrs.name === name));
}
export function liveFormControlsCollection(rawQuery) {
  const live = liveNodes(rawQuery);
  const radioLists = new Map();
  const named = (name) => {
    const matches = fccMatches(live(), name);
    if (matches.length <= 1) return matches[0];
    let list = radioLists.get(name);
    if (!list) radioLists.set(name, list = liveRadioNodeList(() => fccMatches(live(), name)));
    return list;
  };
  const collection = legacyCollection(HTMLFormControlsCollection, live, named);
  makeSlots(collection, 'HTMLFormControlsCollection');
  return collection;
}

for (const iface of [HTMLCollection, HTMLOptionsCollection, HTMLFormControlsCollection, NodeList, RadioNodeList, NamedNodeMap]) {
  globalThis[iface.name] = iface;
}
