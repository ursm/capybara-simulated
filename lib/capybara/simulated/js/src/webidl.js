// The Web IDL runtime the generated bindings (generated/bindings.js, script/gen_bindings.mjs) stand on: argument counts,
// the conversions of JS values to IDL types, the brand check an operation makes of its `this`, an interface object made
// by the platform alone, and the exotic object a legacy platform object with an indexed getter is. What an interface
// DOES is its implementation's, which the bindings hand the converted values to.

// An interface's brand — what tells its objects apart: one key for every realm (`Symbol.for`), so a method of one
// realm's prototype takes an object another realm made, as an internal slot would.
export function brandKey(name) {
  return Symbol.for('csim.idl.' + name);
}
// An object's internal slots: a record held for it out of the page's reach — a private field of the object, stamped on
// it (a constructor that returns the object it is handed lets a class's private field go on any object): no property, so
// no enumeration of its keys sees one and no copy of it takes one (Chrome's `Reflect.ownKeys(new DOMRect)` is empty),
// read as fast as one — holding the brands of the interfaces the object implements, the object itself (`owner`), and its
// implementation's state. It is what the implementation is handed: one identity, whatever the object is (a legacy
// platform object is the Proxy around the one constructed, stamped too).
// Every realm of the isolate is made from the one snapshot, which shares the class's private name between them: a
// method of one realm's prototype reads a record another realm's class stamped, as an internal slot would be read
// (`spec/idl_bindings_spec.rb` holds it). A worker is an isolate, an agent of its own.
class Stamp { constructor(o) { return o; } }
class Slots extends Stamp {
  #record;
  constructor(o, record) {
    super(o);
    this.#record = record;
  }
  static read(o) { return #record in o ? o.#record : undefined; }
}
// (…the last record read kept with its object: a member call reads it twice — its binding's brand check, then its
// implementation — and a Proxy's (a DOMTokenList's) is the slow read. One object held: at most one platform object
// outlives its last use by a lookup, its realm with it.)
let lastObject = null, lastRecord;
function recordOf(obj) {
  if (obj === lastObject) return lastRecord;
  const record = Slots.read(obj);
  if (record !== undefined) {
    lastObject = obj;
    lastRecord = record;
  }
  return record;
}
// (…its state `fields` — the record itself, its shape the caller's literal's; an object of a subclass's interface —
// slots of its own already — gaining the subclass's brand and state)
export function makeSlots(obj, key, fields = {}) {
  const slots = recordOf(obj);
  if (slots !== undefined) return Object.assign(slots, fields, { [key]: true });
  fields.owner = obj;
  fields[key] = true;
  new Slots(obj, fields);
  return fields;
}
// Whether `obj` has slots: a platform object of an interface the bindings made — a structured clone takes none of them
// that is not [Serializable] (platform-globals.js `cloneInto`).
export function hasSlots(obj) {
  return obj !== null && typeof obj === 'object' && recordOf(obj) !== undefined;
}
// The slots of `obj` where it is an object of the interface `key` brands, else undefined.
export function slotsOf(obj, key) {
  if (obj === null || (typeof obj !== 'object' && typeof obj !== 'function')) return undefined;
  const slots = recordOf(obj);
  return slots !== undefined && slots[key] === true ? slots : undefined;
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
// A value converted to a Promise<T> (Web IDL §3.2.23): a new promise of %Promise% resolved with it — the value's own
// promise adopted, not returned as itself — and marked as handled: what the implementation reacts to later is its own
// business, and a rejection the page already handled on its own promise is no unhandled one (Chrome reports none).
const IntrinsicPromise = Promise;
const promiseThen = Promise.prototype.then;
export function promiseResolvedWith(v) {
  const p = new IntrinsicPromise((resolve) => resolve(v));
  promiseThen.call(p, undefined, () => {});
  return p;
}
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
// ByteString: a DOMString none of whose code units is above 0xFF — a TypeError for one that is (Chrome's message).
const NOT_BYTES = /[^\x00-\xFF]/;
export function toByteString(v, prefix = '') {
  const s = toDOMString(v, false, prefix);
  if (NOT_BYTES.test(s)) throw new TypeError(prefix + 'String contains non ISO-8859-1 code point.');
  return s;
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
// Whether `v` is a buffer source of the type `type` names (Web IDL §3.2.25's union steps — an ArrayBuffer, a
// SharedArrayBuffer, a DataView, a typed array): by its internal slots, which the intrinsic getters read — any realm's
// object has them, and no class string a page sets gives them. Without an exception on the common path (a view, a
// view's ArrayBuffer): the decoders and Blob parts are per-call hot.
const isView = ArrayBuffer.isView;
const arrayBufferByteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get;
const dataViewBuffer = Object.getOwnPropertyDescriptor(DataView.prototype, 'buffer').get;
const typedArrayName = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), Symbol.toStringTag).get;
const typedArrayBuffer = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'buffer').get;
// (…what the engine has of resizable and growable buffers — none of either, where it has not)
const arrayBufferResizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get;
function isArrayBuffer(v) {
  try { arrayBufferByteLength.call(v); return true; } catch (_) { return false; }
}
// (…a SharedArrayBuffer told natively: a realm with no SharedArrayBuffer constructor — every one here, none being
// cross-origin isolated — has no getter to brand-check one with, and its shared buffers (a shared
// WebAssembly.Memory's) are shared all the same)
export function isSharedArrayBuffer(v) {
  return v !== null && typeof v === 'object' && globalThis.__dom.isSharedArrayBuffer(v);
}
// (…whether one grows: SharedArrayBuffer's own getter, off its prototype)
function sharedGrowable(buffer) {
  const getter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(buffer) || {}, 'growable')?.get;
  return getter ? getter.call(buffer) : false;
}
export function isBufferOf(v, type) {
  if (v === null || typeof v !== 'object') return false;
  if (isView(v)) {
    const name = typedArrayName.call(v);   // (…undefined for a DataView)
    return type === 'DataView' ? name === undefined : name === type;
  }
  if (type === 'ArrayBuffer') return isArrayBuffer(v);
  if (type === 'SharedArrayBuffer') return isSharedArrayBuffer(v);
  return false;
}
// …converted to it (Web IDL §3.2.26): an object of the type, or a TypeError (`notOfType`); and one whose buffer is shared
// (a view's, where not [AllowShared]) or resizable (where not [AllowResizable]) a TypeError after `prefix`.
export function toBuffer(v, type, allowShared, allowResizable, notOfType, prefix) {
  if (!isBufferOf(v, type)) throw new TypeError(notOfType);
  return checkBuffer(v, type, allowShared, allowResizable, prefix);
}
// (…of one a union's step has found of the type already)
export function checkBuffer(v, type, allowShared, allowResizable, prefix) {
  const view = isView(v);
  const buffer = !view ? v : type === 'DataView' ? dataViewBuffer.call(v) : typedArrayBuffer.call(v);
  // (…a view's buffer an ArrayBuffer, or shared)
  const shared = view ? !isArrayBuffer(buffer) : type === 'SharedArrayBuffer';
  const what = view ? 'ArrayBufferView' : type;
  if (shared && view && !allowShared) throw new TypeError(prefix + `The provided ${what} value must not be shared.`);
  const resizable = shared ? sharedGrowable(buffer) : arrayBufferResizable?.call(buffer);
  if (resizable && !allowResizable) throw new TypeError(prefix + `The provided ${what} value must not be resizable.`);
  return v;
}
// `AllowSharedBufferSource` (Web IDL §2.13.32's typedef, for a value no generated union converts — a stream's chunk): an
// ArrayBuffer, a SharedArrayBuffer, or a view on either, none resizable — a TypeError after `prefix` otherwise.
export function toAllowSharedBufferSource(v, prefix) {
  if (isView(v)) return checkBuffer(v, typedArrayName.call(v) ?? 'DataView', true, false, prefix);
  if (isBufferOf(v, 'ArrayBuffer')) return checkBuffer(v, 'ArrayBuffer', false, false, prefix);
  if (isBufferOf(v, 'SharedArrayBuffer')) return checkBuffer(v, 'SharedArrayBuffer', false, false, prefix);
  throw new TypeError(prefix + "The provided value is not of type 'AllowSharedBufferSource'.");
}
// "Get a copy of the bytes held by the buffer source" (Web IDL §3.2.26) — an ArrayBuffer's, or a view's range of its
// buffer — as a Uint8Array of this realm, read through the intrinsic getters, which no page's own properties stand in for;
// a detached buffer's, or a view over one's, none.
const viewByteOffset = (v) => (typedArrayName.call(v) === undefined ? dataViewByteOffset : typedArrayByteOffset).call(v);
const viewByteLength = (v) => (typedArrayName.call(v) === undefined ? dataViewByteLength : typedArrayByteLength).call(v);
const typedArrayByteOffset = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteOffset').get;
const typedArrayByteLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength').get;
const dataViewByteOffset = Object.getOwnPropertyDescriptor(DataView.prototype, 'byteOffset').get;
const dataViewByteLength = Object.getOwnPropertyDescriptor(DataView.prototype, 'byteLength').get;
// (…copied by the typed-array constructor, which reads nothing a page can replace — `slice` asks the receiver's species)
export function bufferSourceBytes(v) {
  const length = bufferSourceByteLength(v);
  if (length === 0) return new Uint8Array(0);
  if (!isView(v)) return new Uint8Array(new Uint8Array(v));
  const buffer = typedArrayName.call(v) === undefined ? dataViewBuffer.call(v) : typedArrayBuffer.call(v);
  return new Uint8Array(new Uint8Array(buffer, viewByteOffset(v), length));
}
// …and how many there are, without the copy (a DataView's getters throw over a detached buffer, where a typed array's
// answer 0: its buffer asked first).
export function bufferSourceByteLength(v) {
  if (!isView(v)) return arrayBufferByteLength.call(v);
  if (typedArrayName.call(v) === undefined && arrayBufferByteLength.call(dataViewBuffer.call(v)) === 0) return 0;
  return viewByteLength(v);
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
// A record<K, V> (Web IDL §3.2.24): the object's own keys in order, each enumerable one converted (`key` — a symbol
// key a TypeError) with its value (`value`), an ordered map of them — a key two convert to taking the later value in the
// first one's place — as an array of [key, value] pairs.
export function toRecord(v, key, value, prefix = '') {
  if (v === null || (typeof v !== 'object' && typeof v !== 'function')) throw new TypeError(prefix + "The provided value is not of type 'record'.");
  const map = new Map();
  for (const k of Reflect.ownKeys(v)) {
    const desc = Reflect.getOwnPropertyDescriptor(v, k);
    if (desc === undefined || !desc.enumerable) continue;
    map.set(key(k), value(v[k]));
  }
  return [...map];
}
// Whether a union's sequence step takes `v` (Web IDL §3.2.25: GetMethod(V, @@iterator) — an object whose @@iterator is
// neither undefined nor callable a TypeError, which no later step may take).
export function isIterable(v, prefix = '') {
  if (v === null || (typeof v !== 'object' && typeof v !== 'function')) return false;
  const method = v[Symbol.iterator];
  if (method == null) return false;
  if (typeof method !== 'function') throw new TypeError(prefix + 'The object must have a callable @@iterator property.');
  return true;
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
  const slots = recordOf(obj);
  const proxy = slots.owner = new Proxy(obj, {
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
  // (…the Proxy stamped too, which is the object every caller holds)
  new Slots(proxy, slots);
  return proxy;
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
// A pair iterator (`iterable<K, V>`, Web IDL §3.7.10): `entries` / `keys` / `values` / `forEach`, and @@iterator
// `entries` itself — each iterator a default iterator object of the interface's own iterator prototype ("<name>
// Iterator", over %IteratorPrototype%), its target, kind and index its internal slots. The pairs are the
// implementation's, read again at every step (`pairsOf`): a pair added or removed while iterating is seen, as the
// spec's "value pairs to iterate over" are.
export function definePairIterator(proto, name, pairsOf, isSelf) {
  const key = brandKey(name + ' Iterator');
  const iteratorPrototype = Object.create(Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]())));
  const step = {
    next() {
      const s = thisOf(this, key);
      const pairs = pairsOf(s.target);
      if (s.index >= pairs.length) return { value: undefined, done: true };
      const [k, v] = pairs[s.index++];
      return { value: s.kind === 'key' ? k : s.kind === 'value' ? v : [k, v], done: false };
    }
  };
  Object.defineProperty(iteratorPrototype, 'next', { value: step.next, writable: true, enumerable: true, configurable: true });
  Object.defineProperty(iteratorPrototype, Symbol.toStringTag, { value: `${name} Iterator`, configurable: true });
  const iterator = (target, kind) => {
    const it = Object.create(iteratorPrototype);
    makeSlots(it, key, { target, kind, index: 0 });
    return it;
  };
  const members = {
    entries() { return iterator(thisIs(this ?? globalThis, isSelf), 'key+value'); },
    keys() { return iterator(thisIs(this ?? globalThis, isSelf), 'key'); },
    values() { return iterator(thisIs(this ?? globalThis, isSelf), 'value'); },
    forEach(callback) {
      const self = thisIs(this ?? globalThis, isSelf);
      required(arguments, 1, 'forEach', name);
      if (typeof callback !== 'function') throw new TypeError(`Failed to execute 'forEach' on '${name}': parameter 1 is not of type 'Function'.`);
      const thisArg = arguments[1];
      for (let i = 0, pairs = pairsOf(self); i < pairs.length; i++, pairs = pairsOf(self)) {
        callback.call(thisArg, pairs[i][1], pairs[i][0], self);
      }
    }
  };
  for (const m of ['entries', 'keys', 'values', 'forEach']) {
    Object.defineProperty(proto, m, { value: members[m], writable: true, enumerable: true, configurable: true });
  }
  Object.defineProperty(proto, Symbol.iterator, { value: members.entries, writable: true, enumerable: false, configurable: true });
}
// A setlike declaration's members (Web IDL §3.7.12) over the backing set `setOf(self)` answers — a JS Set, its
// iterators the Set's own (%SetIteratorPrototype%): `size`, `entries` / `keys` / `values` / @@iterator, `forEach`
// (each value given as value and key, and the object), `has`; and `own`, the add / delete / clear the interface leaves
// to the declaration, where it is not readonly — their argument converted to the value type (`convert(v, prefix)`),
// and `changed(self)`, where the implementation gives one, told of each that changed the set.
const setMethods = { entries: Set.prototype.entries, values: Set.prototype.values, has: Set.prototype.has, forEach: Set.prototype.forEach,
  add: Set.prototype.add, delete: Set.prototype.delete, clear: Set.prototype.clear };
const setSize = Object.getOwnPropertyDescriptor(Set.prototype, 'size').get;
export function defineSetlike(proto, name, setOf, isSelf, own, convert, changed) {
  const backing = (self, method) => setOf(thisIs(self ?? globalThis, isSelf, `Failed to execute '${method}' on '${name}': `));
  const value = (args, method) => {
    required(args, 1, method, name);
    return convert(args[0], `Failed to execute '${method}' on '${name}': `);
  };
  // (…a mutation that changed the set's size told to the implementation)
  const mutate = (self, set, step) => {
    const before = setSize.call(set), result = step();
    if (changed && setSize.call(set) !== before) changed(self);
    return result;
  };
  const members = {
    get size() { return setSize.call(setOf(thisIs(this ?? globalThis, isSelf))); },
    entries() { return setMethods.entries.call(backing(this, 'entries')); },
    keys() { return setMethods.values.call(backing(this, 'keys')); },
    values() { return setMethods.values.call(backing(this, 'values')); },
    forEach(callback) {
      const self = thisIs(this ?? globalThis, isSelf);
      if (typeof callback !== 'function') throw new TypeError(`Failed to execute 'forEach' on '${name}': parameter 1 is not of type 'Function'.`);
      const thisArg = arguments[1];
      setMethods.forEach.call(setOf(self), (v) => callback.call(thisArg, v, v, self));
    },
    has(v) { const set = backing(this, 'has'); return setMethods.has.call(set, value(arguments, 'has')); },
    add(v) {
      const set = backing(this, 'add'), x = value(arguments, 'add');
      mutate(this, set, () => setMethods.add.call(set, x));
      return this;
    },
    delete(v) {
      const set = backing(this, 'delete'), x = value(arguments, 'delete');
      return mutate(this, set, () => setMethods.delete.call(set, x));
    },
    clear() { const set = backing(this, 'clear'); mutate(this, set, () => setMethods.clear.call(set)); }
  };
  for (const m of ['size', 'entries', 'keys', 'values', 'forEach', 'has', ...own]) {
    Object.defineProperty(proto, m, { ...Object.getOwnPropertyDescriptor(members, m), enumerable: true, configurable: true });
  }
  Object.defineProperty(proto, Symbol.iterator, { value: proto.values, writable: true, enumerable: false, configurable: true });
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

// The attributes an inherited [Default] toJSON collects (Web IDL "collect attribute values of an inheritance stack"):
// `names`, each read by the getter `proto`'s chain has for it when the interface is installed — what a page puts there
// later is none of it — into the object the toJSON returns.
export function defaultJSONOf(proto, names) {
  const getters = names.map((name) => {
    for (let p = proto; p; p = Object.getPrototypeOf(p)) {
      const desc = Object.getOwnPropertyDescriptor(p, name);
      if (desc) return [name, desc.get];
    }
    throw new Error(`no ${name} to collect for toJSON`);
  });
  return (self) => {
    const json = {};
    for (const [name, get] of getters) json[name] = get.call(self);
    return json;
  };
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
