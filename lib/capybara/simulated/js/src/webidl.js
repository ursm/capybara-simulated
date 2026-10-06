// The Web IDL runtime the generated bindings (generated/bindings.js, script/gen_bindings.mjs) stand on: argument counts,
// the conversions of JS values to IDL types, the brand check an operation makes of its `this`, an interface object made
// by the platform alone, and the exotic object a legacy platform object with an indexed getter is. What an interface
// DOES is its implementation's, which the bindings hand the converted values to.

// An interface's brand — what tells its objects apart: one key for every realm (`Symbol.for`), so a method of one
// realm's prototype takes an object another realm made, as an internal slot would.
export function brandKey(name) {
  return Symbol.for('csim.idl.' + name);
}
// An object's internal slots: one object under one symbol of the agent's registry, every realm's — a store of one
// property, no name any enumeration of names sees (a copy that takes it is no owner of it) — holding the brands of the
// interfaces the object implements, the object itself (`owner` — an object whose prototype is a platform object
// inherits its slots, but is not their owner), and its implementation's state. It is what the implementation is
// handed: one identity, whatever the object is (a legacy platform object is the Proxy around the one constructed).
const SLOTS = Symbol.for('csim.idl.slots');
// (…its state `fields` — the record itself, its shape the caller's literal's; an object of a subclass's interface —
// slots of its own already — gaining the subclass's brand and state)
export function makeSlots(obj, key, fields = {}) {
  if (Object.hasOwn(obj, SLOTS)) return Object.assign(obj[SLOTS], fields, { [key]: true });
  fields.owner = obj;
  fields[key] = true;
  obj[SLOTS] = fields;
  return fields;
}
// Whether `obj` has slots of its own: a platform object of an interface the bindings made — a structured clone takes
// none of them that is not [Serializable] (platform-globals.js `cloneInto`).
export function hasSlots(obj) {
  return obj !== null && typeof obj === 'object' && Object.hasOwn(obj, SLOTS) && obj[SLOTS].owner === obj;
}
// The slots of `obj` where it is an object of the interface `key` brands, else undefined.
export function slotsOf(obj, key) {
  const slots = obj == null ? undefined : obj[SLOTS];
  return slots !== undefined && slots.owner === obj && slots[key] === true ? slots : undefined;
}
// An operation's or accessor's `this`, checked — a TypeError for anything that is no object of the interface (Chrome's
// message) — and its slots.
export function thisOf(self, key, prefix = '') {
  const slots = slotsOf(self, key);
  if (slots === undefined) throw new TypeError(prefix + 'Illegal invocation');
  return slots;
}

// …an installed interface's `this` (its members put on the hand-written class that makes its objects): checked by the
// test that class registered, and handed to the implementation as it is.
// The dictionary null or undefined converts to, of a dictionary type with no member defaulted or required: one, and
// unchangeable — what an implementation reads its members off.
export const EMPTY_DICTIONARY = Object.freeze({});

// A promise of the realm's own — its Promise as it began, not one a page put in its place — resolved or rejected.
export const resolvedPromise = Promise.resolve.bind(Promise);
export const rejectedPromise = Promise.reject.bind(Promise);

export function thisIs(self, test, prefix = '') {
  if (!test(self)) throw new TypeError(prefix + 'Illegal invocation');
  return self;
}

// The argument count an operation requires (Chrome's message).
export function required(args, count, member, iface) {
  if (args.length < count) {
    throw new TypeError(`Failed to execute '${member}' on '${iface}': ${count} argument${count === 1 ? '' : 's'} required, but only ${args.length} present.`);
  }
}

// What the platform passes its own constructions of an interface with no constructor — a generated one's, a
// hand-written node class's (`new DocumentType(PLATFORM, …)`) — which a script's `new` cannot.
export const PLATFORM = Symbol('platform');

// An interface with no constructor: `new X()` throws — but for the platform, which makes its objects with `token`.
export function constructedBy(token, given, iface) {
  if (given !== token) throw new TypeError(`Failed to construct '${iface}': Illegal constructor`);
}

// What tells an interface's objects apart, by name — a generated interface's brand, or what a hand-written one
// registers (`registerInterface('Node', isNodeArg)`) before a binding converting to it is defined.
const interfaceChecks = new Map();
export function registerInterface(name, test) {
  interfaceChecks.set(name, test);
}
// The brand an interface's prototype carries, every realm's alike, for a test that a frame's object passes too: a
// symbol of the agent's registry, so no enumeration of names nor `in` with a string sees it. (Any object the
// prototype is behind passes — `Object.create(EventTarget.prototype)` too, which a browser refuses: the cost of
// testing across realms without a stamp on each object.)
export function brandPrototype(iface, name) {
  const brand = Symbol.for('csim.' + name);
  Object.defineProperty(iface.prototype, brand, { value: true });
  return brand;
}
// (…the test itself once it is registered; before, one that looks it up when it is first asked — a binding installed
// before the module that registers an interface its operation takes: MessageEvent's MessagePort — and is then the
// test, an error still for a name nothing ever registers)
export function interfaceCheck(name) {
  const test = interfaceChecks.get(name);
  if (test) return test;
  let found = null;
  return (o) => {
    if (found === null) {
      found = interfaceChecks.get(name) || null;
      if (found === null) throw new Error(`no interface ${name} registered yet`);
    }
    return found(o);
  };
}
// …each of which some module must have registered by the time the bundle has run (bridge.entry.js asks, of the names
// the generated bindings take): a name misspelled, or of an interface nothing implements, is an error then, not when a
// page first passes one.
export function assertInterfacesRegistered(names) {
  const missing = names.filter((name) => !interfaceChecks.has(name));
  if (missing.length) throw new Error(`interfaces a binding takes that nothing registers: ${missing.join(', ')}`);
}

// A legacy callback interface object (Web IDL §3.11.1): a function, but no constructor — `NodeFilter()` throws, and
// `new NodeFilter()` is no constructor's — with no `prototype`.
export function legacyCallbackInterfaceObject(name) {
  const f = () => { throw new TypeError('Illegal constructor'); };
  Object.defineProperty(f, 'name', { value: name });
  return f;
}

// An interface's constants (Web IDL §3.7.5): on its interface object and its prototype, read-only.
export function defineConstants(target, names, values) {
  for (let i = 0; i < names.length; i++) {
    Object.defineProperty(target, names[i], { value: values[i], writable: false, enumerable: true, configurable: false });
  }
}

// Web IDL "call a user object's operation": a callable object is the operation itself (called with no `this`), any
// other object's `opName` is got afresh for each call and called on it.
export function callUserObjectOperation(callback, opName, args, iface) {
  if (typeof callback === 'function') return Reflect.apply(callback, undefined, args);
  const op = callback[opName];
  if (typeof op !== 'function') throw new TypeError(`Failed to execute '${opName}' on '${iface}': The provided callback is not callable.`);
  return Reflect.apply(op, callback, args);
}

// ── Conversions (Web IDL §3.2) ───────────────────────────────────────────────────────────────────────────────────
// DOMString: ToString (a Symbol is a TypeError, as ToString makes it — its message after `prefix`, the member's
// "Failed to …: " as Chrome writes it); `[LegacyNullToEmptyString]` takes null as "".
export function toDOMString(v, legacyNullToEmpty, prefix = '') {
  if (legacyNullToEmpty && v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'symbol') throw new TypeError(prefix + 'Cannot convert a Symbol value to a string');
  return String(v);
}
// An enumeration (Web IDL §3.2.18): a DOMString it has as a value — any other a TypeError.
export function toEnum(v, values, type, prefix) {
  const s = toDOMString(v, false, prefix);
  if (!values.includes(s)) throw new TypeError(`${prefix}The provided value '${s}' is not a valid enum value of type ${type}.`);
  return s;
}
// …and the value an enumeration attribute is set to: the string, where the enumeration has it — else undefined, the
// write ignored (Web IDL §3.7.6).
export function enumValue(v, values, prefix) {
  const s = toDOMString(v, false, prefix);
  return values.includes(s) ? s : undefined;
}
// USVString: a DOMString with every lone surrogate replaced by U+FFFD.
export function toUSVString(v, prefix = '') {
  return toDOMString(v, false, prefix).toWellFormed();
}
// boolean: ToBoolean.
export function toBoolean(v) {
  return !!v;
}
// ToNumber — a Symbol or a BigInt is no number, a TypeError after `prefix` (the member's: Chrome's message).
function toNumber(v, prefix) {
  if (typeof v === 'symbol') throw new TypeError(prefix + 'Cannot convert a Symbol value to a number');
  if (typeof v === 'bigint') throw new TypeError(prefix + 'Cannot convert a BigInt value to a number');
  return +v;
}
// unsigned short / unsigned long / long: ToNumber, then modulo 2^16 or 2^32 (ToUint16 / ToUint32 / ToInt32).
// Whether `v` is a buffer source of the type `type` names (Web IDL §3.2.25's union steps, ArrayBuffer / DataView /
// a typed array): by its internal slots, which the intrinsic getters read — any realm's object has them, and no class
// string a page sets gives them (a SharedArrayBuffer is no ArrayBuffer: its getter throws there too).
const arrayBufferByteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get;
const dataViewBuffer = Object.getOwnPropertyDescriptor(DataView.prototype, 'buffer').get;
const typedArrayName = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), Symbol.toStringTag).get;
export function isBufferOf(v, type) {
  if (v === null || typeof v !== 'object') return false;
  try {
    if (type === 'ArrayBuffer') { arrayBufferByteLength.call(v); return true; }
    if (type === 'DataView') { dataViewBuffer.call(v); return true; }
  } catch (_) { return false; }
  return typedArrayName.call(v) === type;
}
export function toUnsignedShort(v, prefix = '') {
  return toNumber(v, prefix) & 0xFFFF;
}
export function toUnsignedLong(v, prefix = '') {
  return toNumber(v, prefix) >>> 0;
}
export function toShort(v, prefix = '') {
  return (toNumber(v, prefix) << 16) >> 16;
}
export function toLong(v, prefix = '') {
  return toNumber(v, prefix) | 0;
}
// The 64-bit integers (Web IDL §3.2.4.8, §3.2.4.9): the number truncated and taken modulo 2^64 — not one a double
// holds exactly past 2^53, which is the language's own limit — an unsigned one in [0, 2^64), a signed one in
// [-2^63, 2^63).
// (…a 64-bit one taken modulo 2^64 — a safe integer as it is, which needs no wrapping and loses nothing to it)
export function toUnsignedLongLong(v, prefix = '') {
  const n = toNumber(v, prefix);
  if (!Number.isFinite(n) || n === 0) return 0;
  const x = Math.trunc(n);
  return x >= 0 && Number.isSafeInteger(x) ? x : Number(BigInt.asUintN(64, BigInt(x)));
}
export function toLongLong(v, prefix = '') {
  const n = toNumber(v, prefix);
  if (!Number.isFinite(n) || n === 0) return 0;
  const x = Math.trunc(n);
  return Number.isSafeInteger(x) ? x : Number(BigInt.asIntN(64, BigInt(x)));
}
// …[EnforceRange] (Web IDL §3.2.4.9): a finite number, truncated, in the type's range — a TypeError otherwise
// (Chrome's messages).
export function toEnforcedInteger(v, type, prefix = '') {
  const n = toNumber(v, prefix);
  if (!Number.isFinite(n)) throw new TypeError(prefix + 'Value is not a finite number.');
  const x = Math.trunc(n);
  const [lower, upper] = INTEGER_RANGES[type];
  if (x < lower || x > upper) throw new TypeError(prefix + `Value is outside the '${type}' value range.`);
  return x === 0 ? 0 : x;
}
// …[Clamp] (Web IDL §3.2.4.9): NaN 0, else clamped to the type's range and rounded to the nearest integer, a tie to
// the even one.
export function toClampedInteger(v, type, prefix = '') {
  const n = toNumber(v, prefix);
  if (Number.isNaN(n)) return 0;
  const [lower, upper] = INTEGER_RANGES[type];
  const x = Math.min(Math.max(n, lower), upper);
  const f = Math.floor(x), d = x - f;
  const r = d < 0.5 ? f : d > 0.5 ? f + 1 : (f % 2 === 0 ? f : f + 1);
  return r === 0 ? 0 : r;
}
// (…a 64-bit one's the safe integers, which are all a Number holds exactly — Web IDL §3.2.4.10)
const INTEGER_RANGES = {
  'unsigned short':     [0, 0xFFFF],
  'unsigned long':      [0, 0xFFFFFFFF],
  long:                 [-0x80000000, 0x7FFFFFFF],
  'unsigned long long': [0, Number.MAX_SAFE_INTEGER],
  'long long':          [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]
};
// double: a finite number (a TypeError otherwise); unrestricted double: any number.
export function toDouble(v, prefix = '') {
  const n = toNumber(v, prefix);
  if (!Number.isFinite(n)) throw new TypeError(prefix + 'The provided double value is non-finite.');
  return n;
}
// float: a finite number in float's range, rounded to it (a TypeError otherwise); unrestricted float: any, rounded.
export function toFloat(v, prefix = '') {
  const n = toNumber(v, prefix);
  const f = Math.fround(n);
  if (!Number.isFinite(f)) throw new TypeError(prefix + 'The provided float value is non-finite.');
  return f;
}
export function toUnrestrictedFloat(v, prefix = '') {
  return Math.fround(toNumber(v, prefix));
}
export function toUnrestrictedDouble(v, prefix = '') {
  return toNumber(v, prefix);
}
// `object`: an object as it is, anything else a TypeError (`message`).
export function toObject(v, message) {
  if (v === null || (typeof v !== 'object' && typeof v !== 'function')) throw new TypeError(message);
  return v;
}
// `sequence<T>`: an object's values, as its @@iterator gives them, each converted (`convert`) — a TypeError after
// `prefix` for a value no object, or one with no iterator (Chrome's messages). The iterator is not closed when a
// conversion throws (Web IDL's "create a sequence from an iterable" steps its `next` alone, as Chrome does), and each
// value is defined on the list, not set: a setter a page put on Array.prototype sees none of them.
export function toSequence(v, convert, prefix = '') {
  if (v === null || (typeof v !== 'object' && typeof v !== 'function')) throw new TypeError(prefix + 'The provided value cannot be converted to a sequence.');
  const method = v[Symbol.iterator];
  if (typeof method !== 'function') throw new TypeError(prefix + 'The object must have a callable @@iterator property.');
  const iterator = method.call(v), next = iterator.next, values = [];
  for (;;) {
    const result = next.call(iterator);
    if (result === null || (typeof result !== 'object' && typeof result !== 'function')) throw new TypeError('Iterator result is not an object');
    if (result.done) return values;
    Object.defineProperty(values, values.length, { value: convert(result.value), writable: true, enumerable: true, configurable: true });
  }
}
// An interface type: one of the interface's objects (`test`), as it is — a TypeError (`message`) for any other value.
export function toInterface(v, test, message) {
  if (!test(v)) throw new TypeError(message);
  return v;
}
// A callback interface type: any object, as it is (its operation is got when it is called).
// A callback function type's value (Web IDL §3.2.20): a callable object.
export function toCallbackFunction(v, message) {
  if (typeof v !== 'function') throw new TypeError(message);
  return v;
}
// A variadic argument after optional ones (`setTimeout(handler, timeout, ...arguments)`): the arguments from `index`.
// (…by the slice taken when the bindings were, which no page's replacement reaches)
const arraySlice = Array.prototype.slice, reflectApply = Reflect.apply;
export function restOf(args, index) {
  return reflectApply(arraySlice, args, [index]);
}
export function toCallbackInterface(v, message) {
  if (v === null || (typeof v !== 'object' && typeof v !== 'function')) throw new TypeError(message);
  return v;
}

// ── Legacy platform objects ──────────────────────────────────────────────────────────────────────────────────────
// An object with an indexed property getter (`getter T item(unsigned long index)`) and no setter (Web IDL §3.9): its
// array index properties are supported where the getter answers one — read live, through a Proxy, so no snapshot of
// them goes stale — and none of them can be defined, set or (while supported) deleted; nor can the object be made
// non-extensible. `item(slots, i)` / `length(slots)` are the implementation's; the slots' owner becomes the Proxy.
export function withIndexedGetter(obj, item, length) {
  const slots = obj[SLOTS];
  return slots.owner = new Proxy(obj, {
    get(target, prop, receiver) {
      const i = arrayIndex(prop);
      if (i >= 0) {
        const v = item(slots, i);
        return v === null ? undefined : v;
      }
      return Reflect.get(target, prop, receiver);
    },
    has(target, prop) {
      const i = arrayIndex(prop);
      return i >= 0 ? i < length(slots) : Reflect.has(target, prop);
    },
    getOwnPropertyDescriptor(target, prop) {
      const i = arrayIndex(prop);
      if (i >= 0) {
        const v = item(slots, i);
        return v === null ? undefined : { value: v, writable: false, enumerable: true, configurable: true };
      }
      return Reflect.getOwnPropertyDescriptor(target, prop);
    },
    defineProperty(target, prop, desc) {
      return arrayIndex(prop) < 0 && Reflect.defineProperty(target, prop, desc);
    },
    set(target, prop, value, receiver) {
      return arrayIndex(prop) < 0 && Reflect.set(target, prop, value, receiver);
    },
    deleteProperty(target, prop) {
      const i = arrayIndex(prop);
      return i >= 0 ? i >= length(slots) : Reflect.deleteProperty(target, prop);
    },
    preventExtensions() {
      return false;
    },
    ownKeys(target) {
      const keys = [];
      for (let i = 0, n = length(slots); i < n; i++) keys.push(String(i));
      return keys.concat(Reflect.ownKeys(target));
    }
  });
}
// A canonical array index (0 … 2^32−2, no leading zeros), or −1.
function arrayIndex(prop) {
  if (typeof prop !== 'string') return -1;
  const n = prop >>> 0;
  return String(n) === prop && n < 0xFFFFFFFF ? n : -1;
}

// A value iterator over an interface with an indexed getter: its keys / values / entries / forEach / @@iterator ARE
// %Array.prototype%'s (Web IDL §3.7.9; `classList.values === Array.prototype.values`).
export function defineValueIterator(proto) {
  for (const m of ['entries', 'keys', 'values', 'forEach']) {
    Object.defineProperty(proto, m, { value: Array.prototype[m], writable: true, enumerable: true, configurable: true });
  }
  defineIndexedIterator(proto);
}
// …and one with no iterable declaration: its @@iterator alone, %Array.prototype.values% (Web IDL §3.7.10 — an indexed
// property getter and an integer-typed `length`).
export function defineIndexedIterator(proto) {
  Object.defineProperty(proto, Symbol.iterator, { value: Array.prototype.values, writable: true, enumerable: false, configurable: true });
}

// An interface's attributes and operations are enumerable (Web IDL §3.7.6-7), which a class's members are not.
export function enumerable(proto, names) {
  for (const n of names) Object.defineProperty(proto, n, { enumerable: true });
}

// An installed interface's members — those of the class its binding generates them in — put on the prototype of the
// hand-written class that makes its objects, as IDL has them: enumerable.
// The prototype must own none of them: a hand-written member of the same name would be one the binding replaces, unseen.
export function installMembers(proto, members) {
  for (const key of Reflect.ownKeys(members)) {
    if (key === 'constructor') continue;
    if (Object.hasOwn(proto, key)) throw new Error(`${proto.constructor.name}.prototype has a member ${String(key)} of its own`);
    const desc = Object.getOwnPropertyDescriptor(members, key);
    desc.enumerable = true;
    Object.defineProperty(proto, key, desc);
  }
}

// A legacy factory function (Web IDL §3.7.2, `[LegacyFactoryFunction]`) on the global: `name`, `length` its required
// arguments, its `prototype` the interface's (and fixed) — `steps` make the object, of what is passed, and only `new`
// may call it. The object is NewTarget's: a subclass's (`class Thumb extends Image`) has its prototype, a NewTarget
// whose `prototype` is no object the interface's.
export function defineLegacyFactoryFunction(name, length, prototype, steps) {
  const F = {
    [name]: function (...args) {
      if (new.target === undefined) throw new TypeError(`Failed to construct '${name}': Please use the 'new' operator, this DOM object constructor cannot be called as a function.`);
      const object = steps(...args);
      if (new.target !== F) {
        const p = new.target.prototype;
        Object.setPrototypeOf(object, p !== null && (typeof p === 'object' || typeof p === 'function') ? p : prototype);
      }
      return object;
    }
  }[name];
  Object.defineProperty(F, 'length', { value: length, writable: false, enumerable: false, configurable: true });
  Object.defineProperty(F, 'prototype', { value: prototype, writable: false, enumerable: false, configurable: false });
  Object.defineProperty(globalThis, name, { value: F, writable: true, enumerable: false, configurable: true });
}

// An interface's [LegacyUnforgeable] members (Web IDL §3.4.10): what defines them on an object, as its own properties —
// enumerable, and not configurable.
// (…one `defineProperty` each, which an object made per event — its `isTrusted` — pays for: `defineProperties` is the
// slower of the two, measured in node)
export function unforgeableMembers(members) {
  const entries = [];
  for (const key of Reflect.ownKeys(members)) {
    if (key === 'constructor') continue;
    entries.push([key, { ...Object.getOwnPropertyDescriptor(members, key), enumerable: true, configurable: false }]);
  }
  return (object) => {
    for (let i = 0; i < entries.length; i++) Object.defineProperty(object, entries[i][0], entries[i][1]);
    return object;
  };
}

// An interface object's `length`: its constructor's required arguments, 0 without one (Web IDL §3.7.1).
export function defineLength(iface, length) {
  Object.defineProperty(iface, 'length', { value: length, writable: false, enumerable: false, configurable: true });
}

// An interface prototype's @@unscopables (Web IDL §3.7.3): a null-prototype object naming its [Unscopable] members.
export function defineUnscopables(proto, names) {
  const unscopables = Object.create(null);
  for (const n of names) unscopables[n] = true;
  Object.defineProperty(proto, Symbol.unscopables, { value: unscopables, writable: false, enumerable: false, configurable: true });
}

// An interface prototype's class string (Web IDL §3.7.3): a data property, not an accessor.
export function defineClassString(proto, name) {
  Object.defineProperty(proto, Symbol.toStringTag, { value: name, writable: false, enumerable: false, configurable: true });
}
