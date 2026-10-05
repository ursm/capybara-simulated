// The Web IDL runtime the generated bindings (generated/bindings.js, script/gen_bindings.mjs) stand on: argument counts,
// the conversions of JS values to IDL types, the brand check an operation makes of its `this`, an interface object made
// by the platform alone, and the exotic object a legacy platform object with an indexed getter is. What an interface
// DOES is its implementation's, which the bindings hand the converted values to.

// An interface's brand — the internal slot that tells its objects apart: one key for every realm (`Symbol.for`), so a
// method of one realm's prototype takes an object another realm made, as an internal slot would.
export function brandKey(name) {
  return Symbol.for('csim.idl.' + name);
}
// Mark `obj` as one of an interface's objects (non-enumerable, as an internal slot is unseen).
export function brand(obj, key) {
  Object.defineProperty(obj, key, { value: true });
  return obj;
}
// An operation's or accessor's `this`, checked: a TypeError for anything that is no object of the interface.
export function thisOf(self, key, iface, member) {
  if (self == null || self[key] !== true) {
    throw new TypeError(`Failed to execute '${member}' on '${iface}': Illegal invocation`);
  }
  return self;
}

// The argument count an operation requires (Chrome's message).
export function required(args, count, member, iface) {
  if (args.length < count) {
    throw new TypeError(`Failed to execute '${member}' on '${iface}': ${count} argument${count === 1 ? '' : 's'} required, but only ${args.length} present.`);
  }
}

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
export function interfaceCheck(name) {
  const test = interfaceChecks.get(name);
  if (!test) throw new Error(`no interface ${name} registered yet`);
  return test;
}

// A legacy callback interface object (Web IDL §3.7.2): a function, but no constructor — `NodeFilter()` throws, and
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
// DOMString: ToString (a Symbol is a TypeError, as ToString makes it); `[LegacyNullToEmptyString]` takes null as "".
export function toDOMString(v, legacyNullToEmpty) {
  if (legacyNullToEmpty && v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'symbol') throw new TypeError('Cannot convert a Symbol value to a string');
  return String(v);
}
// USVString: a DOMString with every lone surrogate replaced by U+FFFD.
export function toUSVString(v) {
  return toDOMString(v).toWellFormed();
}
// boolean: ToBoolean.
export function toBoolean(v) {
  return !!v;
}
// unsigned short / unsigned long / long: ToNumber, then modulo 2^16 or 2^32 (ToUint16 / ToUint32 / ToInt32).
export function toUnsignedShort(v) {
  return v & 0xFFFF;
}
export function toUnsignedLong(v) {
  return v >>> 0;
}
export function toLong(v) {
  return v | 0;
}
// double: a finite number (a TypeError otherwise); unrestricted double: any number.
export function toDouble(v, message) {
  const n = +v;
  if (!Number.isFinite(n)) throw new TypeError(message);
  return n;
}
export function toUnrestrictedDouble(v) {
  return +v;
}
// An interface type: one of the interface's objects (`test`), as it is — a TypeError (`message`) for any other value.
export function toInterface(v, test, message) {
  if (!test(v)) throw new TypeError(message);
  return v;
}
// A callback interface type: any object, as it is (its operation is got when it is called).
export function toCallbackInterface(v, message) {
  if (v === null || (typeof v !== 'object' && typeof v !== 'function')) throw new TypeError(message);
  return v;
}

// ── Legacy platform objects ──────────────────────────────────────────────────────────────────────────────────────
// An object with an indexed property getter (`getter T item(unsigned long index)`): its array index properties are
// supported where the getter answers one — read live, through a Proxy, so no snapshot of them goes stale.
export function withIndexedGetter(obj, item, length) {
  return new Proxy(obj, {
    get(target, prop, receiver) {
      const i = arrayIndex(prop);
      if (i >= 0) {
        const v = item(target, i);
        return v === null ? undefined : v;
      }
      return Reflect.get(target, prop, receiver);
    },
    has(target, prop) {
      const i = arrayIndex(prop);
      return i >= 0 ? i < length(target) : Reflect.has(target, prop);
    },
    getOwnPropertyDescriptor(target, prop) {
      const i = arrayIndex(prop);
      if (i >= 0) {
        const v = item(target, i);
        return v === null ? undefined : { value: v, writable: false, enumerable: true, configurable: true };
      }
      return Reflect.getOwnPropertyDescriptor(target, prop);
    },
    ownKeys(target) {
      const keys = [];
      for (let i = 0, n = length(target); i < n; i++) keys.push(String(i));
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
  Object.defineProperty(proto, Symbol.iterator, { value: Array.prototype[Symbol.iterator], writable: true, enumerable: false, configurable: true });
}

// An interface's attributes and operations are enumerable (Web IDL §3.7.6-7), which a class's members are not.
export function enumerable(proto, names) {
  for (const n of names) Object.defineProperty(proto, n, { enumerable: true });
}

// An interface prototype's class string (Web IDL §3.7.6): a data property, not an accessor.
export function defineClassString(proto, name) {
  Object.defineProperty(proto, Symbol.toStringTag, { value: name, writable: false, enumerable: false, configurable: true });
}
