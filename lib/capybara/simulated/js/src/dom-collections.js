// The DOM's and HTML's collections: HTMLCollection and its two kinds, NodeList and RadioNodeList, NamedNodeMap — each
// a legacy platform object generated from its IDL (webidl.js `legacyPlatformObject`), made by the platform alone, its
// indices (and names) answered by its special operations' steps over what it holds.

import { isHtml } from './constants.js';
import { currentNodesGen } from './mutation-observer.js';
import { getCheckedness, setRadio } from './form-helpers.js';
import { childAtOf, childCountOf, childNodesOf, nodeDocumentOf } from './native-query-shadow.js';
import { currentEdgeGen } from './tree.js';
import { PLATFORM, constructedBy, makeSlots, registerInterface, slotsOf, inheritInterface, createObject, rootInterface } from './webidl.js';
import {
  installHTMLCollection,
  installHTMLFormControlsCollection,
  installHTMLOptionsCollection,
  defineNamedNodeMap,
  installNodeList,
  installRadioNodeList,
  legacyHTMLCollection,
  legacyHTMLFormControlsCollection,
  legacyHTMLOptionsCollection,
  legacyNodeList
} from './generated/bindings.js';
import { DOMException } from './dom-exception.js';
import { attrsOf, nidOf } from './node-identity.js';
import { dom, listFind, listFirst, listFrom, listMap } from './engine.js';
import { InternalMap, objectKeys } from './intrinsics.js';


// HTMLCollection (DOM §4.2.10.2) and its two kinds, HTMLOptionsCollection and HTMLFormControlsCollection (HTML §2.6.2),
// generated from their IDL: live legacy platform objects with indexed and named properties — `legacyCollection` makes
// them, its slots the query it answers (`live()`, the elements as they stand, found again per node generation). Not
// Arrays: `length`, the operations and @@iterator (%Array.prototype.values%) are the prototype's.
const collectionOf = (o) => slotsOf(o, 'HTMLCollection');
registerInterface('HTMLCollection', (o) => collectionOf(o) !== undefined);
export class HTMLCollection extends Object {
  constructor(token) {
    constructedBy(PLATFORM, token, 'HTMLCollection');
    return createObject(new.target);
  }
}
rootInterface(HTMLCollection);
installHTMLCollection(HTMLCollection, {
  get_length: (c) => collectionOf(c).live().length,
  item: (c, index) => nodeAt(collectionOf(c).live(), index),
  namedItem: (c, name) => collectionOf(c).named(name) ?? null
});

// NodeList (DOM §4.2.10.1), generated from its IDL: a legacy platform object of nodes, its indices read off its slots
// (`itemAt` / `count`): a node's children as they stand (childNodes, the engine's to answer), a query's answer found
// again once the tree moved (getElementsByName, labels), or a fixed list (querySelectorAll, a mutation record's).
// Not an Array: its `length` and `item`, and the value iterator's keys / values / entries / forEach (%Array.prototype%'s),
// are the prototype's.
const nodeListOf = (o) => slotsOf(o, 'NodeList');
registerInterface('NodeList', (o) => nodeListOf(o) !== undefined);
export class NodeList extends Object {
  constructor(token) {
    constructedBy(PLATFORM, token, 'NodeList');
    return createObject(new.target);
  }
}
rootInterface(NodeList);
installNodeList(NodeList, {
  get_length: (list) => { const s = nodeListOf(list); return s.count(s); },
  item: (list, index) => { const s = nodeListOf(list); return s.itemAt(s, index); }
});
// …its indexed properties those steps too, handed its slots
const nodeListObject = legacyNodeList({
  get_length: (s) => s.count(s),
  item: (s, index) => s.itemAt(s, index)
});
// (…the index-th node, or null past the end — never an index %Array.prototype% was given)
const nodeAt = (nodes, index) => (index < nodes.length ? nodes[index] : null);
// A list's nodes are `nodes()`, its index-th one `at(slots, index)` and how many `count(slots)` — read off the array
// unless the list answers them itself (a node's `childNodes`, the engine's).
const atOfNodes = (s, index) => nodeAt(s.nodes(), index);
const countOfNodes = (s) => s.nodes().length;
function makeNodeList(Interface, nodes, at = atOfNodes, count = countOfNodes) {
  const list = new Interface(PLATFORM);
  const s = makeSlots(list, 'NodeList');
  s.nodes = nodes;
  s.itemAt = at;
  s.count = count;
  return nodeListObject(list, s);
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
// named properties ([LegacyUnenumerableNamedProperties]), whose slots hold its element, the list of its attributes
// (`live()`, memoised per node generation) and the element's attribute steps (dom-nodes.js `attributeSteps`); `length`,
// the operations and @@iterator are the prototype's. Its supported property names are its attributes' qualified names
// but, of an HTML element in an HTML document, those with an ASCII upper alpha — the engine's (attributes.rs
// `attrMapNames`, `attrMapNamed`) — whose getNamedItem would find another attribute by them: its `namedGetter` is of
// the supported names alone.
const nnmOf = (o) => slotsOf(o, 'NamedNodeMap');
const docNidOf = (el) => nidOf(nodeDocumentOf(el)) ?? -1;
export const NamedNodeMap = defineNamedNodeMap({
  get_length: (map) => nnmOf(map).live().length,
  item(map, index) {
    const a = nnmOf(map).live();
    return index < a.length ? a[index] : null;
  },
  getNamedItem: (map, name) => { const s = nnmOf(map); return s.steps.getAttributeNode(s.el, name); },
  getNamedItemNS: (map, ns, ln) => { const s = nnmOf(map); return s.steps.getAttributeNodeNS(s.el, ns, ln); },
  setNamedItem: (map, attr) => { const s = nnmOf(map); return s.steps.setAttributeNode(s.el, attr); },
  setNamedItemNS: (map, attr) => { const s = nnmOf(map); return s.steps.setAttributeNode(s.el, attr); },
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
  },
  supportedNames: (map) => { const el = nnmOf(map).el; return dom.attrMapNames(el, docNidOf(el)); },
  // (…a named property's value, of a supported name alone: the attribute the engine says it names, in one lookup)
  namedGetter(map, name) {
    const s = nnmOf(map), key = dom.attrMapNamed(s.el, docNidOf(s.el), name);
    return key === null ? null : s.steps.attrNodeFor(s.el, key);
  }
});

// A LIVE NamedNodeMap (`element.attributes`): `el`'s attributes as they stand.
export function liveNamedNodeMap(el, steps) {
  let cacheGen = NaN, cached = null;
  const live = () => {
    const g = currentNodesGen();
    if (g !== cacheGen) { cached = listMap(objectKeys(attrsOf(el)), k => steps.attrNodeFor(el, k)); cacheGen = g; }
    return cached;
  };
  const map = new NamedNodeMap(PLATFORM);
  const slots = nnmOf(map);
  slots.el = el;
  slots.live = live;
  slots.steps = steps;
  return map;
}

// A STATIC NodeList of the nodes in `nodes` (querySelectorAll's, a mutation record's), which nothing changes after.
export const nodeList = (nodes) => makeNodeList(NodeList, () => nodes);
// …a node's `childNodes`: its children as they stand — the engine's to count and to name. A tree generation's reads
// ask for one child each (`childAtOf`) until they number an eighth of the children, and then for them all at once
// (`childNodesOf`), which the rest of the generation's reads index: an iteration pays for one list, and a loop that
// changes the list every few reads — removing a text node, appending and reading the last — pays for no list at all
// (taking the list on the second read made those quadratic).
export function childNodeList(node) {
  let gen = NaN, reads = 0, count = 0, kept = null;
  const fresh = () => {
    const now = currentEdgeGen();
    if (now !== gen) {
      gen = now;
      reads = 0;
      count = -1;
      kept = null;
    }
  };
  const at = (_s, index) => {
    fresh();
    if (kept !== null) return nodeAt(kept, index);
    if (count < 0) count = childCountOf(node, false);
    if (++reads * 8 >= count) {
      kept = childNodesOf(node);
      return nodeAt(kept, index);
    }
    return childAtOf(node, index);
  };
  const length = () => {
    fresh();
    if (kept !== null) return kept.length;
    if (count < 0) count = childCountOf(node, false);
    return count;
  };
  return makeNodeList(NodeList, () => childNodesOf(node), at, length);
}
// …a LIVE one of a query's answer (`document.getElementsByName`, `labels`).
export const liveNodeList = (rawQuery) => makeNodeList(NodeList, liveNodes(rawQuery));

// RadioNodeList (HTML §2.6.2.3), generated from its IDL: the NodeList a form's or `form.elements`' named getter answers
// when more than one control shares a name — live — with the radio group's `value`: the first checked radio button's
// value (the engine's, by its value mode: its `value` attribute, "on" without one), and a write checking the first of
// that value.
const isRadio = (el) => isHtml(el, 'input') && dom.inputType(el) === 'radio';
const radioValue = (el) => dom.inputValueOf(el);
registerInterface('RadioNodeList', (o) => slotsOf(o, 'RadioNodeList') !== undefined);
export class RadioNodeList extends Object {
  constructor(token) {
    constructedBy(PLATFORM, token, 'RadioNodeList');
    return createObject(new.target);
  }
}
inheritInterface(RadioNodeList, NodeList);
installRadioNodeList(RadioNodeList, {
  get_value(list) {
    const checked = listFind(nodeListOf(list).nodes(), (el) => isRadio(el) && getCheckedness(el));
    return checked ? radioValue(checked) : '';
  },
  set_value(list, v) {
    const radio = listFind(nodeListOf(list).nodes(), (el) => isRadio(el) && radioValue(el) === v);
    if (radio) setRadio(radio);
  }
});
export function liveRadioNodeList(rawQuery) {
  const list = makeNodeList(RadioNodeList, liveNodes(rawQuery));
  makeSlots(list, 'RadioNodeList');
  return list;
}

// The element `name` names (HTMLCollection's named-property getter / `namedItem`, DOM §4.2.10.1): the FIRST in the
// collection whose id is it, or — an HTML element — whose `name` attribute is; not an id match after an earlier name one —
// the engine's to find (collections.rs `namedIn`).
function hcNamedItem(arr, name) {
  const i = dom.namedIn(arr, name, false);
  return i < 0 ? undefined : arr[i];
}
// …and its "supported property names", in order, each once: each element's id and each HTML element's name, neither
// empty (`namesIn`).
const hcSupportedNames = (arr) => dom.namesIn(arr);

// A live collection of `Interface` — an HTMLCollection or one of its kinds, a legacy platform object of what `make`, its
// legacy platform object steps, make of it — whose array indices are `live()`'s elements and whose supported names
// (`hcSupportedNames`) answer `named(name)`. Its slots (`HTMLCollection`): `live` and `named`.
const collectionSteps = {
  get_length: (s) => s.live().length,
  item: (s, index) => nodeAt(s.live(), index),
  namedItem: (s, name) => s.named(name) ?? null,
  supportedNames: (s) => hcSupportedNames(s.live())
};
const collectionObject = legacyHTMLCollection(collectionSteps);
// (…and the elements one holds as they stand, which a form's own indices are — read off its slots, not through a member a
// page may have replaced)
export const collectionElements = (c) => collectionOf(c).live();
function legacyCollection(Interface, live, named, make = collectionObject) {
  const target = new Interface(PLATFORM);
  const slots = makeSlots(target, 'HTMLCollection');
  slots.live = live;
  slots.named = named;
  return make(target, slots);
}
// A LIVE HTMLCollection (`getElementsByTagName` / `*ClassName` / `children` / a table's rows …) of `rawQuery()`'s answer.
export function liveHTMLCollection(rawQuery, generation) {
  const live = liveNodes(rawQuery, generation);
  return legacyCollection(HTMLCollection, live, (name) => hcNamedItem(live(), name));
}

// `<select>.options`: an HTMLOptionsCollection — an HTMLCollection that is also written: an option set at an index
// (HTML "setting a new indexed property value"), `length`, `add`, `remove`, `selectedIndex` — all its select's.
registerInterface('HTMLOptionsCollection', (o) => slotsOf(o, 'HTMLOptionsCollection') !== undefined);
export class HTMLOptionsCollection extends Object {
  constructor(token) {
    constructedBy(PLATFORM, token, 'HTMLOptionsCollection');
    return createObject(new.target);
  }
}
inheritInterface(HTMLOptionsCollection, HTMLCollection);
const selectOf = (o) => slotsOf(o, 'HTMLOptionsCollection').select;
// (…the tree changes its select makes as its own members — never through those, which a page may replace)
const changesOf = (o) => slotsOf(o, 'HTMLOptionsCollection').changes;
installHTMLOptionsCollection(HTMLOptionsCollection, {
  get_length: (c) => collectionOf(c).live().length,
  set_length(c, v) { changesOf(c).setLength(selectOf(c), v); },
  add(c, element, before) { changesOf(c).add(selectOf(c), element, before); },
  // (…the index-th option removed — none out of range — as its select's `remove(index)` removes it)
  remove(c, index) { if (index >= 0) changesOf(c).remove(selectOf(c), index); },
  get_selectedIndex: (c) => changesOf(c).selectedIndex(selectOf(c)),
  set_selectedIndex(c, v) { changesOf(c).setSelectedIndex(selectOf(c), v); }
});
// HTML "setting a new indexed property value" (the anonymous setter, [CEReactions]): null removes the index-th option
// (none out of range); an option pads the list with new blank ones up to the index and is appended, or replaces the
// index-th one.
function setOptionAt(s, index, option) {
  const select = s.select, changes = s.changes, length = s.live().length;
  if (option === null) {
    changes.remove(select, index);
    return;
  }
  const n = index - length;
  // (…a padding past the engine's cap appends nothing, and then neither the option: an index near 2^32)
  if (n > 0) {
    changes.pad(select, n);
    if (s.live().length !== index) return;
  }
  if (n >= 0) changes.append(select, option);
  else changes.replace(s.live()[index], option);
}
const optionsCollectionObject = legacyHTMLOptionsCollection({ ...collectionSteps, setter: setOptionAt });
// …what a select's own namedItem answers, its options collection's
export const optionsCollectionNamedItem = (collection, name) => collectionOf(collection).named(name) ?? null;
// …what a select's own indexed setter does, its options collection's (`select[i] = option`)
export function setOptionsCollectionIndex(collection, index, option) {
  setOptionAt(slotsOf(collection, 'HTMLOptionsCollection'), index, option);
}
// (…`changes` the tree changes it makes itself: html-forms.js `optionChanges`)
export function liveOptionsCollection(select, rawQuery, changes) {
  const live = liveNodes(rawQuery);
  const collection = legacyCollection(HTMLOptionsCollection, live, (name) => hcNamedItem(live(), name), optionsCollectionObject);
  const slots = makeSlots(collection, 'HTMLOptionsCollection');
  slots.select = select;
  slots.changes = changes;
  return collection;
}

// `form.elements`: an HTMLFormControlsCollection — an HTMLCollection whose named getter answers a RadioNodeList (live,
// the same one for a name) where more than one control has the name, the one control where one has it.
registerInterface('HTMLFormControlsCollection', (o) => slotsOf(o, 'HTMLFormControlsCollection') !== undefined);
export class HTMLFormControlsCollection extends Object {
  constructor(token) {
    constructedBy(PLATFORM, token, 'HTMLFormControlsCollection');
    return createObject(new.target);
  }
}
inheritInterface(HTMLFormControlsCollection, HTMLCollection);
installHTMLFormControlsCollection(HTMLFormControlsCollection, {
  namedItem: (c, name) => collectionOf(c).named(name) ?? null
});
// …and every control in `arr` that `name` names.
function fccMatches(arr, name) {
  return listFrom(dom.namedIn(arr, name, true), (i) => arr[i]);
}
const formControlsObject = legacyHTMLFormControlsCollection(collectionSteps);
export function liveFormControlsCollection(rawQuery) {
  const live = liveNodes(rawQuery);
  const radioLists = new InternalMap();
  const named = (name) => {
    const matches = fccMatches(live(), name);
    if (matches.length <= 1) return listFirst(matches);
    let list = radioLists.get(name);
    if (!list) radioLists.set(name, list = liveRadioNodeList(() => fccMatches(live(), name)));
    return list;
  };
  const collection = legacyCollection(HTMLFormControlsCollection, live, named, formControlsObject);
  makeSlots(collection, 'HTMLFormControlsCollection');
  return collection;
}

for (const iface of [HTMLCollection, HTMLOptionsCollection, HTMLFormControlsCollection, NodeList, RadioNodeList, NamedNodeMap]) {
  globalThis[iface.name] = iface;
}
