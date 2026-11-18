// The ECMAScript statics the bindings call once the realm runs a page's script — each read off its namespace or its
// constructor's prototype here, as the bundle loads into the snapshot, before any page exists. The namespaces themselves
// are the realm's own (script/build_bridge.mjs passes them in), but their members are a page's to replace: a page's
// `Reflect.get` would be handed a cross-origin window's raw global, a page's `Object.keys` a Proxy's target, a page's
// `Object.prototype.hasOwnProperty` the object asked about. So no function of the bindings reads one at call time
// (script/check_bridge_statics.mjs holds them to it): a static read inside a function is one of these.
export const reflectApply = Reflect.apply;
export const reflectConstruct = Reflect.construct;
export const reflectDefineProperty = Reflect.defineProperty;
export const reflectDeleteProperty = Reflect.deleteProperty;
export const reflectGet = Reflect.get;
export const reflectGetOwnPropertyDescriptor = Reflect.getOwnPropertyDescriptor;
export const reflectGetPrototypeOf = Reflect.getPrototypeOf;
export const reflectHas = Reflect.has;
export const reflectIsExtensible = Reflect.isExtensible;
export const reflectOwnKeys = Reflect.ownKeys;
export const reflectSet = Reflect.set;
export const reflectSetPrototypeOf = Reflect.setPrototypeOf;

export const objectAssign = Object.assign;
export const objectCreate = Object.create;
export const objectDefineProperties = Object.defineProperties;
export const objectDefineProperty = Object.defineProperty;
export const objectEntries = Object.entries;
export const objectFreeze = Object.freeze;
export const objectFromEntries = Object.fromEntries;
export const objectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
export const objectGetOwnPropertyDescriptors = Object.getOwnPropertyDescriptors;
export const objectGetOwnPropertyNames = Object.getOwnPropertyNames;
export const objectGetPrototypeOf = Object.getPrototypeOf;
export const objectHasOwn = Object.hasOwn;
export const objectKeys = Object.keys;
export const objectSetPrototypeOf = Object.setPrototypeOf;
export const objectValues = Object.values;
export const objectHasOwnProperty = Object.prototype.hasOwnProperty;
export const objectToString = Object.prototype.toString;

export const jsonParse = JSON.parse;
export const jsonStringify = JSON.stringify;

export const arrayFrom = Array.from;
export const arrayIsArray = Array.isArray;
export const arrayJoin = Array.prototype.join;
export const arrayValues = Array.prototype.values;

export const symbolFor = Symbol.for;

// The bindings' own collections — what they keep a realm's state in, which a page must not read nor be handed: a Map,
// a Set, a WeakMap or a WeakSet whose methods are the ones the bundle took as it loaded (on a prototype of its own, no
// prototype above it a page could reach but the collection's own), and whose iterators step by the `next` the bundle
// took too — none of `Map.prototype`'s, `Set.prototype`'s or `%MapIteratorPrototype%`'s a page may have replaced is
// called with the collection or its contents. Made empty, or of an array's elements, or of another collection's.
const mapProto = Map.prototype, setProto = Set.prototype, weakMapProto = WeakMap.prototype, weakSetProto = WeakSet.prototype;
const mapEntries = mapProto.entries, mapKeys = mapProto.keys, mapValues = mapProto.values, mapForEach = mapProto.forEach;
const setValues = setProto.values, setForEach = setProto.forEach, setAdd = setProto.add, mapSet = mapProto.set;
const mapIteratorNext = Object.getPrototypeOf(new Map().entries()).next;
const setIteratorNext = Object.getPrototypeOf(new Set().values()).next;
const sizeOf = (proto) => Object.getOwnPropertyDescriptor(proto, 'size').get;
const iterating = (native, next) => {
  const it = { __proto__: null, next: () => reflectApply(next, native, []) };
  it[Symbol.iterator] = () => it;
  return it;
};
// (…each method its own property, as the namespace's are, and the prototype frozen: an internal collection a page came
// to hold would still change none of them)
function ownMethods(proto, methods, size) {
  for (const name of Reflect.ownKeys(methods)) {
    Object.defineProperty(proto, name, { __proto__: null, value: methods[name], writable: false, enumerable: false, configurable: false });
  }
  if (size) Object.defineProperty(proto, 'size', { __proto__: null, get: size, enumerable: false, configurable: false });
  Object.freeze(proto);
}
// (…filled from `items`: an array's elements by index, a Map's entries or a Set's members by the `forEach` taken here —
// never by an iterator a page may have replaced — or another iterable of the bindings' own by its iterator)
function fill(collection, items, add, pairs) {
  if (items === undefined || items === null) return;
  if (arrayIsArray(items)) {
    for (let i = 0; i < items.length; i++) {
      if (pairs) reflectApply(add, collection, [items[i][0], items[i][1]]);
      else reflectApply(add, collection, [items[i]]);
    }
  } else if (items instanceof Map) {
    reflectApply(mapForEach, items, [(v, k) => { if (pairs) reflectApply(add, collection, [k, v]); else reflectApply(add, collection, [[k, v]]); }]);
  } else if (items instanceof Set) {
    reflectApply(setForEach, items, [(v) => { reflectApply(add, collection, [v]); }]);
  } else {
    // (…any other iterable, the bindings' own — an internal collection's iterator, a generator of theirs)
    for (const item of items) {
      if (pairs) reflectApply(add, collection, [item[0], item[1]]);
      else reflectApply(add, collection, [item]);
    }
  }
}
export class InternalMap extends Map {
  constructor(items) {
    super();
    fill(this, items, mapSet, true);
  }
}
ownMethods(InternalMap.prototype, {
  get: mapProto.get, set: mapSet, has: mapProto.has, delete: mapProto.delete, clear: mapProto.clear, forEach: mapForEach,
  keys() { return iterating(reflectApply(mapKeys, this, []), mapIteratorNext); },
  values() { return iterating(reflectApply(mapValues, this, []), mapIteratorNext); },
  entries() { return iterating(reflectApply(mapEntries, this, []), mapIteratorNext); },
  [Symbol.iterator]() { return iterating(reflectApply(mapEntries, this, []), mapIteratorNext); }
}, sizeOf(mapProto));
export class InternalSet extends Set {
  constructor(items) {
    super();
    fill(this, items, setAdd, false);
  }
}
ownMethods(InternalSet.prototype, {
  add: setAdd, has: setProto.has, delete: setProto.delete, clear: setProto.clear, forEach: setForEach,
  keys() { return iterating(reflectApply(setValues, this, []), setIteratorNext); },
  values() { return iterating(reflectApply(setValues, this, []), setIteratorNext); },
  [Symbol.iterator]() { return iterating(reflectApply(setValues, this, []), setIteratorNext); }
}, sizeOf(setProto));
export class InternalWeakMap extends WeakMap {
  constructor() {
    super();
  }
}
ownMethods(InternalWeakMap.prototype, { get: weakMapProto.get, set: weakMapProto.set, has: weakMapProto.has, delete: weakMapProto.delete });
export class InternalWeakSet extends WeakSet {
  constructor() {
    super();
  }
}
ownMethods(InternalWeakSet.prototype, { add: weakSetProto.add, has: weakSetProto.has, delete: weakSetProto.delete });
