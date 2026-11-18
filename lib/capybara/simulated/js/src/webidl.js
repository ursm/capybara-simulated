// The Web IDL runtime the generated bindings (generated/bindings.js, script/gen_bindings.mjs) stand on: argument counts,
// the conversions of JS values to IDL types, the brand check an operation makes of its `this`, an interface object made
// by the platform alone, and the exotic object a legacy platform object with an indexed getter is. What an interface
// DOES is its implementation's, which the bindings hand the converted values to.

import {
  builtList, dom, hooksOf, hostNamespace, listConcat, listEach, listFilter, listIncludes, listJoin, listMap, listPush,
  newList, NO_ARGUMENTS, pageList, protoless
} from './engine.js';
import {
  arrayValues, InternalSet, InternalWeakMap, mathFloor, mathFround, mathMax, mathMin, mathTrunc, numberIsFinite,
  numberIsNaN, numberIsSafeInteger, objectDefineProperty, objectEntries, objectGetOwnPropertyDescriptor, objectGetPrototypeOf,
  objectHasOwn, reflectApply, reflectDefineProperty, reflectDeleteProperty, reflectGet,
  reflectGetOwnPropertyDescriptor, reflectHas, reflectSet, symbolFor
} from './intrinsics.js';

// An interface's brand — what tells its objects apart: one key for every realm (`Symbol.for`), so a method of one
// realm's prototype takes an object another realm made, as an internal slot would.
export function brandKey(name) {
  return symbolFor('csim.idl.' + name);
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
// (…the base a private field is stamped on any object through — native-query-shadow.js's rare data is one too)
export class Stamp { constructor(o) { return o; } }
class Slots extends Stamp {
  #record;
  constructor(o, record) {
    super(o);
    this.#record = record;
  }
  static read(o) { return #record in o ? o.#record : undefined; }
  static has(o) { return #record in o; }
}
// (…the last record read kept with its object: a member call reads it twice — its binding's brand check, then its
// implementation — and a Proxy's (a DOMTokenList's) is the slow read. One object held, and only until the event loop
// step ends (`forgetLastRecord`): a platform object outlives its last use by a lookup that long, its realm with it — a
// MediaQueryList whose listener went, a removed frame's object — and no longer.)
let lastObject = null, lastRecord;
export function forgetLastRecord() {
  lastObject = null;
  lastRecord = undefined;
}
function recordOf(obj) {
  if (obj === lastObject) return lastRecord;
  const record = Slots.read(obj);
  if (record !== undefined) {
    lastObject = obj;
    lastRecord = record;
  }
  return record;
}
// (…its state `fields` — the record itself, its shape the caller's literal's, of no prototype from then on, so no
// `Object.prototype` member a page defined meets a slot written or read (a literal's is taken off: `{ __proto__: null }` would
// make it a dictionary, as webidl.js `Dictionary` says); an object of a subclass's interface — slots of its own already —
// gaining the subclass's brand and state)
const ObjectPrototype = Object.prototype, getPrototypeOf = Object.getPrototypeOf, setPrototypeOf = Object.setPrototypeOf, assignOwn = Object.assign;
export function makeSlots(obj, key, fields) {
  const slots = recordOf(obj);
  if (slots !== undefined) {
    if (fields !== undefined) assignOwn(slots, fields);
    slots[key] = true;
    return slots;
  }
  if (fields === undefined) fields = new Dictionary();
  else if (getPrototypeOf(fields) === ObjectPrototype) setPrototypeOf(fields, null);
  return stampSlots(obj, key, fields);
}
// …and the slots of an object just constructed, none of its own yet, whose record is of no prototype already: an event's,
// made per dispatch.
export function stampSlots(obj, key, record) {
  record.owner = obj;
  record[key] = true;
  new Slots(obj, record);
  return record;
}
// Whether `obj` has slots: a platform object of an interface the bindings made — a structured clone takes none of them
// that is not [Serializable] (platform-globals.js `serializePlatformObject`).
export function hasSlots(obj) {
  return obj !== null && (typeof obj === 'object' || typeof obj === 'undefined' && obj !== undefined) && (obj === lastObject || Slots.has(obj));
}
// The slots of `obj` where it is an object of the interface `key` brands, else undefined. (…an object of HTML's
// [[IsHTMLDDA]], `document.all`, of typeof "undefined" though it is one)
export function slotsOf(obj, key) {
  if (obj === null || obj === undefined) return undefined;
  const type = typeof obj;
  if (type !== 'object' && type !== 'function' && type !== 'undefined') return undefined;
  const slots = recordOf(obj);
  return slots !== undefined && slots[key] === true ? slots : undefined;
}
// A member of any realm's binding run on an object another realm made — an iframe's handed to this realm's prototype's
// method — as that realm's own member would: what the object names (a handle into the engine's store, a database) and
// what the member makes and queues (objects, tasks) are its own realm's. Each object carries in its slots whose it is
// (`realm`): the calling module's record of its implementations, by interface, which `realm` is here. The binding's
// own plumbing (`installEventHandlers`, a shell's `init` and `construct`, handed slots) is no member.
const OWN_STEPS = new InternalSet(['installEventHandlers', 'init', 'construct']);
export function ownRealm(realm, name, slotsOfSelf, impl) {
  realm[name] = impl;
  const dispatched = {};
  for (let i = 0, list = objectEntries(impl); i < list.length; i++) {
    const member = list[i][0], step = list[i][1];
    // (…its arguments passed on as they came, no spread: a page's array iterator is no step of a member's)
    dispatched[member] = OWN_STEPS.has(member) ? step : function (self) {
      const own = slotsOfSelf(self).realm;
      return reflectApply(own === realm ? step : own[name][member], undefined, arguments);
    };
  }
  return dispatched;
}
// An operation's or accessor's `this`, checked — a TypeError for anything that is no object of the interface (Chrome's
// message) — and its slots.
export function thisOf(self, key, prefix = '') {
  const slots = slotsOf(self, key);
  if (slots === undefined) throw new TypeError(prefix + 'Illegal invocation');
  return slots;
}

// What a dictionary converts to (gen_bindings.mjs `dictionaryConverter`): an object of a constructor whose prototype has
// none — an IDL dictionary is an ordered map, and a member written to, or read off, an object of `Object.prototype`'s
// would meet a page's property of its name there (an accessor with no setter swallows the write; its getter runs as the
// member is read). Not `Object.create(null)`: V8 keeps such an object's properties in a dictionary, some 40x slower to
// make and read, and an EventInit is made per event.
export function Dictionary() {}
Dictionary.prototype = Object.create(null);
// The dictionary null or undefined converts to, of a dictionary type with no member defaulted or required: one, and
// unchangeable — what an implementation reads its members off.
export const EMPTY_DICTIONARY = Object.freeze(new Dictionary());

// A promise of the realm's own — its Promise as it began, not one a page put in its place — resolved or rejected.
export const resolvedPromise = Promise.resolve.bind(Promise);
// The realm's Promise as it began, and its `then` — called on a promise of the realm's, never the one a page put on
// Promise.prototype. A bounded gap stays: the derived promise `then` makes is the species of `constructor`, which a page
// may have redefined on Promise.prototype (core-js does), where Web IDL's "react" makes none. Every way a script reacts
// to a promise (`then`, resolving with one, `await`, V8's own Promise::Then) asks it, so the reaction still runs and
// only that derived promise is the page's — or, from a getter that throws, the reaction is refused.
export const IntrinsicPromise = Promise;
export const promiseThen = Promise.prototype.then;
// The realm's JSON and Date as they began: a page's polyfill or a fake-timer library's are no platform's (the clock a
// date of now reads is the driver's own, timers.js `platformDateNow`).
export const jsonParse = JSON.parse, jsonStringify = JSON.stringify;
export const IntrinsicDate = Date;
// (…and its `defineProperty` and `create`, what a page's replacement leaves the platform's own objects to)
export const definePropertyOwn = Object.defineProperty, objectCreate = Object.create;
// A microtask of the platform's own: `steps` run by the job resolving a promise of the realm's own with a thenable of no
// prototype — no `then`, `constructor` (the species `then` looks up) nor `Promise` of the page's in the way (a polyfill's,
// a fake-timer library's).
export const platformMicrotask = (steps) => {
  new IntrinsicPromise((resolve) => resolve({ __proto__: null, then: () => { steps(); } }));
};
// The global of the agent's main realm, which every realm of the agent — an iframe's, a popup's — keeps the agent's own
// state on: the steps after its microtask checkpoint (timers.js), the callbacks it is running.
export function agentGlobal() {
  const NS = hostNamespace;
  return NS.contextOf(globalThis) === 0 ? globalThis : NS.contextGlobal(0);
}
// Whether script runs beneath the caller — HTML's JavaScript execution context stack not empty, as "clean up after
// running script" asks after a callback: a listener or a page's timer running (`runningCallbacks`, events.js
// `invokeEntries`, timers.js: whatever it is, a bound built-in's too, whose own execution context is on the stack while
// no frame of the page's is — the agent's count, as the stack is, a listener of one realm dispatching in another's; the
// driver's own tasks, timers too, not counted), or the engine's answer (`__dom.scriptOnStack`: a microtask running, a
// frame of the page's).
let callbacks = null;
export const runningCallbacks = () => (callbacks ??= (hooksOf(agentGlobal()).runningCallbacks ??= { count: 0 }));
export const scriptOnStack = () => runningCallbacks().count > 0 || dom.scriptOnStack();
// A Uint8Array's bytes base64-encoded — `toBase64`'s answer, the engine's, whatever a page put on the prototype — and back
// (`Uint8Array.fromBase64`'s, in the realm's own Uint8Array).
export const bytesToBase64 = (bytes) => dom.bytesBase64(bytes);
// (…a text that is no base64 a SyntaxError, as `fromBase64` throws: a wire form of ours that is none is corrupt — the
// engine's own methods are no choice, being absent from the snapshot the bindings are built into)
const Uint8ArrayOwn = Uint8Array;
export function bytesFromBase64(text) {
  const buffer = dom.base64Bytes(text);
  if (buffer === null) throw new SyntaxError('The string is no base64.');
  return new Uint8ArrayOwn(buffer);
}
// `promiseThen` of a handler that may return a promise of the realm's: the result follows it by `promiseThen` too —
// never one promise resolved with another, which reads its `then` off Promise.prototype, where a page may have put its
// own.
export function promiseThenChained(p, onFulfilled) {
  return new IntrinsicPromise((resolve, reject) => {
    reflectApply(promiseThen, p, [(v) => {
      let r;
      try {
        r = onFulfilled(v);
      } catch (e) {
        reject(e);
        return;
      }
      if (r instanceof IntrinsicPromise) reflectApply(promiseThen, r, [resolve, reject]); else resolve(r);
    }, reject]);
  });
}
// A value converted to a Promise<T> (Web IDL §3.2.23): a new promise of %Promise% resolved with it — the value's own
// promise adopted, not returned as itself — and marked as handled: what the implementation reacts to later is its own
// business, and a rejection the page already handled on its own promise is no unhandled one (Chrome reports none).
export function promiseResolvedWith(v) {
  const p = new IntrinsicPromise((resolve) => resolve(v));
  reflectApply(promiseThen, p, [undefined, () => {}]);
  return p;
}
export const rejectedPromise = Promise.reject.bind(Promise);
// …and Promise.all's: a promise of every value `values` settles to — each taken as a promise, a thenable adopted (one
// of the realm's own promises as it is: resolving with it would read its `then` off the page's prototype) — in order,
// or the first rejection, by the intrinsics and none of the page's members.
export function promiseAll(values) {
  return new IntrinsicPromise((resolve, reject) => {
    const results = newList(values.length);
    let left = values.length;
    if (left === 0) resolve(builtList(results));
    for (let i = 0; i < values.length; i++) {
      const p = values[i] instanceof IntrinsicPromise ? values[i] : promiseResolvedWith(values[i]);
      reflectApply(promiseThen, p, [(v) => {
        results[i] = v;
        if (--left === 0) resolve(builtList(results));
      }, reject]);
    }
  });
}

// [CEReactions] (HTML §4.13.6): a call's element queue pushed on the custom element reactions stack as it begins, and
// popped as it returns, the reactions it enqueued run — the engine's stack (ce_reactions.rs), whose depth is a view the
// bindings write with no call (`ceStack[0]`), and whose deepest element queue holding an element `ceStack[1]` names: a
// call that enqueued nothing, nor any it made, makes no crossing as it returns. (custom-elements.js installs the run.)
let ceStack = null;
let ceRun = () => {};
export function setCEReactionsRunner(run) { ceRun = run; }
export function ceEnter() {
  const stack = (ceStack ??= dom.ceStack);
  return stack[0]++;
}
export function ceLeave(depth) {
  const stack = ceStack;
  stack[0] = depth;
  if (stack[1] > depth) ceRun(depth + 1);
}

// An installed interface's `this` (its members put on the hand-written class that makes its objects): checked by the
// test that class registered, and handed to the implementation as it is.
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

// An interface's class chained to the one it inherits by its [[Prototype]]s alone (Web IDL §3.7.1, §3.7.3), no `super`: a
// page's change of its interface object's [[Prototype]] gets nothing of what `super` would have passed — PLATFORM — and no
// call, and `new` works whatever is there. (Its object is `new.target`'s, a page's own subclass's as any class's.)
export function inheritInterface(iface, parent) {
  setPrototypeOf(iface, parent);
  setPrototypeOf(iface.prototype, parent.prototype);
}

// (…and one that inherits none, whose [[Prototype]] `extends Object` left for %Function.prototype%, Web IDL's)
const FunctionPrototype = Function.prototype;
export function rootInterface(iface) {
  setPrototypeOf(iface, FunctionPrototype);
}
// A shell's platform steps as its generator was told they are (gen_bindings.mjs `platform`): `count` arguments past its slots, or no
// `init` at all. An error as the bridge loads, so a snapshot of a mismatch is never made.
export function checkPlatformSteps(name, impl, count) {
  const steps = impl.init;
  if (count === undefined ? steps !== undefined : typeof steps !== 'function' || steps.length !== count + 1) {
    throw new Error(`${name}: its \`init\` takes ${steps === undefined ? 'nothing' : steps.length - 1} past its slots, its generator says ${count}`);
  }
}

// …and the steps a legacy platform object's special operations are (gen_bindings.mjs `legacyKind`), each a function of
// its implementation's — an error as the bridge loads where one is missing.
export function requireSteps(name, impl, steps) {
  for (let i = 0; i < steps.length; i++) {
    if (typeof impl[steps[i]] !== 'function') throw new Error(`${name}: its implementation has no \`${steps[i]}\` step`);
  }
}

// What tells an interface's objects apart, by name — a generated interface's brand, or what a hand-written one
// registers (`registerInterface('Node', isNodeObject)`) before a binding converting to it is defined.
const interfaceChecks = { __proto__: null };
export function registerInterface(name, test) {
  interfaceChecks[name] = test;
}
// (…the test itself once it is registered; before, one that looks it up when it is first asked — a binding installed
// before the module that registers an interface its operation takes: MessageEvent's MessagePort — and is then the
// test, an error still for a name nothing ever registers)
export function interfaceCheck(name) {
  const test = interfaceChecks[name];
  if (test) return test;
  let found = null;
  return (o) => {
    if (found === null) {
      found = interfaceChecks[name] || null;
      if (found === null) throw new Error(`no interface ${name} registered yet`);
    }
    return found(o);
  };
}
// …each of which some module must have registered by the time the bundle has run (bridge.entry.js asks, of the names
// the generated bindings take): a name misspelled, or of an interface nothing implements, is an error then, not when a
// page first passes one.
export function assertInterfacesRegistered(names) {
  const missing = listFilter(names, (name) => interfaceChecks[name] === undefined);
  if (missing.length) throw new Error(`interfaces a binding takes that nothing registers: ${listJoin(missing, ', ')}`);
}

// A legacy callback interface object (Web IDL §3.11.1): a function, but no constructor — `NodeFilter()` throws, and
// `new NodeFilter()` is no constructor's — with no `prototype`.
export function legacyCallbackInterfaceObject(name) {
  const f = () => { throw new TypeError('Illegal constructor'); };
  objectDefineProperty(f, 'name', { __proto__: null, value: name });
  return f;
}

// An interface's constants (Web IDL §3.7.5): on its interface object and its prototype, read-only.
export function defineConstants(target, names, values) {
  for (let i = 0; i < names.length; i++) {
    objectDefineProperty(target, names[i], { __proto__: null, value: values[i], writable: false, enumerable: true, configurable: false });
  }
}

// Web IDL "call a user object's operation": a callable object is the operation itself (called with no `this`), any
// other object's `opName` is got afresh for each call and called on it.
export function callUserObjectOperation(callback, opName, args, iface) {
  if (isCallable(callback)) return reflectApply(callback, undefined, args);
  const op = callback[opName];
  if (!isCallable(op)) throw new TypeError(`Failed to execute '${opName}' on '${iface}': The provided callback is not callable.`);
  return reflectApply(op, callback, args);
}

// ── Conversions (Web IDL §3.2) ───────────────────────────────────────────────────────────────────────────────────
// DOMString: ToString (a Symbol is a TypeError, as ToString makes it — its message after `prefix`, the member's
// "Failed to …: " as Chrome writes it); `[LegacyNullToEmptyString]` takes null as "".
// (…`realm` the global whose TypeError a Symbol's is: the operation's, where that is another realm's than this one)
export function toDOMString(v, legacyNullToEmpty, prefix = '', realm = globalThis) {
  if (legacyNullToEmpty && v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'symbol') throw new realm.TypeError(prefix + 'Cannot convert a Symbol value to a string');
  return String(v);
}
// An enumeration (Web IDL §3.2.18): a DOMString it has as a value — any other a TypeError.
export function toEnum(v, values, type, prefix) {
  const s = toDOMString(v, false, prefix);
  if (!listIncludes(values, s)) throw new TypeError(`${prefix}The provided value '${s}' is not a valid enum value of type ${type}.`);
  return s;
}
// …and the value an enumeration attribute is set to: the string, where the enumeration has it — else undefined, the
// write ignored (Web IDL §3.7.6).
export function enumValue(v, values, prefix) {
  const s = toDOMString(v, false, prefix);
  return listIncludes(values, s) ? s : undefined;
}
// USVString: a DOMString with every lone surrogate replaced by U+FFFD.
export function toUSVString(v, prefix = '', realm = globalThis) {
  return toDOMString(v, false, prefix, realm).toWellFormed();
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
export function isArrayBuffer(v) {
  try { reflectApply(arrayBufferByteLength, v, NO_ARGUMENTS); return true; } catch (_) { return false; }
}
// (…a SharedArrayBuffer told natively: a realm with no SharedArrayBuffer constructor — every one here, none being
// cross-origin isolated — has no getter to brand-check one with, and its shared buffers (a shared
// WebAssembly.Memory's) are shared all the same)
export function isSharedArrayBuffer(v) {
  return v !== null && typeof v === 'object' && dom.isSharedArrayBuffer(v);
}
// (…whether one grows: SharedArrayBuffer's own getter, off its prototype)
function sharedGrowable(buffer) {
  const getter = objectGetOwnPropertyDescriptor(objectGetPrototypeOf(buffer) || {}, 'growable')?.get;
  return getter ? reflectApply(getter, buffer, NO_ARGUMENTS) : false;
}
export function isBufferOf(v, type) {
  if (v === null || typeof v !== 'object') return false;
  if (isView(v)) {
    const name = reflectApply(typedArrayName, v, NO_ARGUMENTS);   // (…undefined for a DataView)
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
  const buffer = !view ? v : type === 'DataView' ? reflectApply(dataViewBuffer, v, NO_ARGUMENTS) : reflectApply(typedArrayBuffer, v, NO_ARGUMENTS);
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
  if (isView(v)) return checkBuffer(v, reflectApply(typedArrayName, v, NO_ARGUMENTS) ?? 'DataView', true, false, prefix);
  if (isBufferOf(v, 'ArrayBuffer')) return checkBuffer(v, 'ArrayBuffer', false, false, prefix);
  if (isBufferOf(v, 'SharedArrayBuffer')) return checkBuffer(v, 'SharedArrayBuffer', false, false, prefix);
  throw new TypeError(prefix + "The provided value is not of type 'AllowSharedBufferSource'.");
}
// "Get a copy of the bytes held by the buffer source" (Web IDL §3.2.26) — an ArrayBuffer's, or a view's range of its
// buffer — as a Uint8Array of this realm, read through the intrinsic getters, which no page's own properties stand in for;
// a detached buffer's, or a view over one's, none.
const viewByteOffset = (v) => reflectApply(reflectApply(typedArrayName, v, NO_ARGUMENTS) === undefined ? dataViewByteOffset : typedArrayByteOffset, v, NO_ARGUMENTS);
const viewByteLength = (v) => reflectApply(reflectApply(typedArrayName, v, NO_ARGUMENTS) === undefined ? dataViewByteLength : typedArrayByteLength, v, NO_ARGUMENTS);
const typedArrayByteOffset = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteOffset').get;
const typedArrayByteLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength').get;
const dataViewByteOffset = Object.getOwnPropertyDescriptor(DataView.prototype, 'byteOffset').get;
const dataViewByteLength = Object.getOwnPropertyDescriptor(DataView.prototype, 'byteLength').get;
// (…copied by the typed-array constructor, which reads nothing a page can replace — `slice` asks the receiver's species)
export function bufferSourceBytes(v) {
  const length = bufferSourceByteLength(v);
  if (length === 0) return new Uint8Array(0);
  if (!isView(v)) return new Uint8Array(new Uint8Array(v));
  const buffer = reflectApply(typedArrayName, v, NO_ARGUMENTS) === undefined ? reflectApply(dataViewBuffer, v, NO_ARGUMENTS) : reflectApply(typedArrayBuffer, v, NO_ARGUMENTS);
  return new Uint8Array(new Uint8Array(buffer, viewByteOffset(v), length));
}
// …and how many there are, without the copy (a DataView's getters throw over a detached buffer, where a typed array's
// answer 0: its buffer asked first).
export function bufferSourceByteLength(v) {
  if (!isView(v)) return reflectApply(arrayBufferByteLength, v, NO_ARGUMENTS);
  if (reflectApply(typedArrayName, v, NO_ARGUMENTS) === undefined && reflectApply(arrayBufferByteLength, reflectApply(dataViewBuffer, v, NO_ARGUMENTS), NO_ARGUMENTS) === 0) return 0;
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
  if (!numberIsFinite(n) || n === 0) return 0;
  const x = mathTrunc(n);
  return x >= 0 && numberIsSafeInteger(x) ? x : Number(BigInt.asUintN(64, BigInt(x)));
}
export function toLongLong(v, prefix = '') {
  const n = toNumber(v, prefix);
  if (!numberIsFinite(n) || n === 0) return 0;
  const x = mathTrunc(n);
  return numberIsSafeInteger(x) ? x : Number(BigInt.asIntN(64, BigInt(x)));
}
// …[EnforceRange] (Web IDL §3.2.4.9): a finite number, truncated, in the type's range — a TypeError otherwise
// (Chrome's messages).
export function toEnforcedInteger(v, type, prefix = '') {
  const n = toNumber(v, prefix);
  if (!numberIsFinite(n)) throw new TypeError(prefix + 'Value is not a finite number.');
  const x = mathTrunc(n);
  const range = INTEGER_RANGES[type], lower = range[0], upper = range[1];
  if (x < lower || x > upper) throw new TypeError(prefix + `Value is outside the '${type}' value range.`);
  return x === 0 ? 0 : x;
}
// …[Clamp] (Web IDL §3.2.4.9): NaN 0, else clamped to the type's range and rounded to the nearest integer, a tie to
// the even one.
export function toClampedInteger(v, type, prefix = '') {
  const n = toNumber(v, prefix);
  if (numberIsNaN(n)) return 0;
  const pair = INTEGER_RANGES[type], lower = pair[0], upper = pair[1];
  const x = mathMin(mathMax(n, lower), upper);
  const f = mathFloor(x), d = x - f;
  const r = d < 0.5 ? f : d > 0.5 ? f + 1 : (f % 2 === 0 ? f : f + 1);
  return r === 0 ? 0 : r;
}
// (…a 64-bit one's the safe integers, which are all a Number holds exactly — Web IDL §3.2.4.10)
const INTEGER_RANGES = {
  octet:                [0, 0xFF],
  'unsigned short':     [0, 0xFFFF],
  'unsigned long':      [0, 0xFFFFFFFF],
  long:                 [-0x80000000, 0x7FFFFFFF],
  'unsigned long long': [0, Number.MAX_SAFE_INTEGER],
  'long long':          [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]
};
// double: a finite number (a TypeError otherwise); unrestricted double: any number.
export function toDouble(v, prefix = '') {
  const n = toNumber(v, prefix);
  if (!numberIsFinite(n)) throw new TypeError(prefix + 'The provided double value is non-finite.');
  return n;
}
// float: a finite number in float's range, rounded to it (a TypeError otherwise); unrestricted float: any, rounded.
export function toFloat(v, prefix = '') {
  const n = toNumber(v, prefix);
  const f = mathFround(n);
  if (!numberIsFinite(f)) throw new TypeError(prefix + 'The provided float value is non-finite.');
  return f;
}
export function toUnrestrictedFloat(v, prefix = '') {
  return mathFround(toNumber(v, prefix));
}
export function toUnrestrictedDouble(v, prefix = '') {
  return toNumber(v, prefix);
}
// Whether `v` is an ECMAScript Object (Web IDL's "Type(V) is Object") — an [[IsHTMLDDA]] one, `document.all`, too,
// though its typeof is "undefined" — and whether it is callable (IsCallable), which that one is as well.
export const isObject = (v) => (typeof v === 'object' ? v !== null : typeof v === 'function' || typeof v === 'undefined' && v !== undefined);
export const isCallable = (v) => typeof v === 'function' || typeof v === 'undefined' && v !== undefined;
// `object`: an object as it is, anything else a TypeError (`message`).
export function toObject(v, message) {
  if (!isObject(v)) throw new TypeError(message);
  return v;
}
// `sequence<T>`: an object's values, as its @@iterator gives them, each converted (`convert`) — a TypeError after
// `prefix` for a value no object, or one with no iterator (Chrome's messages). The iterator is not closed when a
// conversion throws (Web IDL's "create a sequence from an iterable" steps its `next` alone, as Chrome does), and each
// value is defined on the list, not set: a setter a page put on Array.prototype sees none of them.
export function toSequence(v, convert, prefix = '') {
  if (!isObject(v)) throw new TypeError(prefix + 'The provided value cannot be converted to a sequence.');
  const method = v[Symbol.iterator];
  if (!isCallable(method)) throw new TypeError(prefix + 'The object must have a callable @@iterator property.');
  const iterator = reflectApply(method, v, NO_ARGUMENTS), next = iterator.next, values = newList();
  for (;;) {
    const result = reflectApply(next, iterator, NO_ARGUMENTS);
    if (!isObject(result)) throw new TypeError('Iterator result is not an object');
    if (result.done) return builtList(values);
    appendTo(values, convert(result.value));
  }
}
// A list of the platform's, out of a page's reach however it has changed Array.prototype — its setters, `push`, its
// iterator, `concat` — and on a hot path: a dispatch's listeners and event path. A value appended in place, as the list's
// own property (some 200 ns: for a list being built, of a size no blank list suits)…
// (…through one descriptor of no prototype, made once: nothing a page put on Object.prototype is read off it, and no
// descriptor is made per element)
const ELEMENT = { __proto__: null, value: undefined, writable: true, enumerable: true, configurable: true };
export function appendTo(list, value) {
  ELEMENT.value = value;
  definePropertyOwn(list, list.length, ELEMENT);
  ELEMENT.value = undefined;
}
// …a copy, a copy with a value appended, and one without its value at an index (`toSpliced`, the realm's own: no species,
// no iterator, each element the new list's own property; 20 ns)…
const arraySplicedCopy = Array.prototype.toSpliced;
export { NO_ARGUMENTS, pageList };
export const listCopy = (list) => reflectApply(arraySplicedCopy, list, NO_ARGUMENTS);
export const listAppended = (list, value) => reflectApply(arraySplicedCopy, list, [list.length, 0, value]);
export const listWithout = (list, index) => reflectApply(arraySplicedCopy, list, [index, 1]);
// …a list of `length` undefineds, each its own property, which an index then writes meeting no setter of a page's: an event
// path's, as long as its tree is deep. A copy of the one kept of each length up to a depth a page's tree seldom passes; past
// it, the head of one kept as long as the deepest yet, doubled when it falls short — so what is kept is bounded by the
// tree whatever a page dispatches at (as `toSpliced`'s own arguments, a chunk at a time: there is a limit to those)…
const BLANK_LISTS = { __proto__: null }, LONGEST_BLANK_LIST_KEPT = 64, BLANK_CHUNK = 4096;
let longBlank = [];
export function blankList(length) {
  const kept = BLANK_LISTS[length];
  if (kept !== undefined) return listCopy(kept);
  if (length <= LONGEST_BLANK_LIST_KEPT) {
    let blank = newList();
    for (let i = 0; i < length; i++) blank = listAppended(blank, undefined);
    BLANK_LISTS[length] = blank;
    return listCopy(blank);
  }
  if (longBlank.length < length) {
    let blank = longBlank.length > 0 ? longBlank : blankList(LONGEST_BLANK_LIST_KEPT);
    while (blank.length < length) {
      const chunk = blank.length < BLANK_CHUNK ? blank : reflectApply(arraySplicedCopy, blank, [BLANK_CHUNK, blank.length - BLANK_CHUNK]);
      blank = reflectApply(arraySplicedCopy, blank, reflectApply(arraySplicedCopy, chunk, [0, 0, blank.length, 0]));
    }
    longBlank = blank;
  }
  return reflectApply(arraySplicedCopy, longBlank, [length, longBlank.length - length]);
}
// …and a FrozenArray's value, by the `freeze` that was there before a page.
export const freeze = Object.freeze;
export const frozenCopy = (list) => freeze(listCopy(list));
// A record<K, V> (Web IDL §3.2.24): the object's own keys in order, each enumerable one converted (`key` — a symbol
// key a TypeError) with its value (`value`), an ordered map of them — a key two convert to taking the later value in the
// first one's place — as an array of [key, value] pairs.
export function toRecord(v, key, value, prefix = '') {
  if (!isObject(v)) throw new TypeError(prefix + "The provided value is not of type 'record'.");
  // (…the pairs in the order of their keys' first appearance; a key two own keys convert to, the last's value: `at`, its pair's place.
  // No prototype as the list grows, so no setter a page put on %Array.prototype%'s index meets a pair.)
  const keys = reflectOwnKeys(v), pairs = newList(), at = { __proto__: null };
  for (let i = 0; i < keys.length; i++) {
    const desc = reflectOwnDescriptor(v, keys[i]);
    if (desc === undefined || !desc.enumerable) continue;
    const typedKey = key(keys[i]), typedValue = value(v[keys[i]]);
    if (at[typedKey] === undefined) {
      at[typedKey] = pairs.length;
      pairs[pairs.length] = [typedKey, typedValue];
    } else {
      pairs[at[typedKey]] = [typedKey, typedValue];
    }
  }
  return setPrototypeOf(pairs, ArrayPrototype);
}
// Whether a union's sequence step takes `v` (Web IDL §3.2.25: GetMethod(V, @@iterator) — an object whose @@iterator is
// neither undefined nor callable a TypeError, which no later step may take).
export function isIterable(v, prefix = '') {
  if (!isObject(v)) return false;
  const method = v[Symbol.iterator];
  if (method === undefined || method === null) return false;
  if (!isCallable(method)) throw new TypeError(prefix + 'The object must have a callable @@iterator property.');
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
  if (!isCallable(v)) throw new TypeError(message);
  return v;
}
// A variadic argument after optional ones (`setTimeout(handler, timeout, ...arguments)`): the arguments from `index`.
// (…by the slice taken when the bindings were, which no page's replacement reaches)
const arraySlice = Array.prototype.slice;
// What a flat interface's constructor makes its object by, as its arguments are converted (Web IDL "internally create a new
// object implementing the interface"): `createObject(new.target)`, reading NewTarget's `prototype` once. The class is
// `class extends Object` so that it makes none of its own before its body, as a base class would, and it never calls `super`:
// nothing of a page's put in its [[Prototype]] chain is called. (`none`, called with no more than NewTarget, is what V8 folds:
// inlined here, an empty rest parameter makes this a plain allocation, a base class's, where a list held in a constant goes
// through a builtin that copies it, for 4-5 ns an object.)
export const reflectConstruct = Reflect.construct, PlainObject = Object;
const ArrayPrototype = Array.prototype, reflectOwnKeys = Reflect.ownKeys, reflectOwnDescriptor = Reflect.getOwnPropertyDescriptor;
export function createObject(newTarget, ...none) {
  return reflectConstruct(PlainObject, none, newTarget);
}
export function restOf(args, index) {
  return reflectApply(arraySlice, args, [index]);
}
export function toCallbackInterface(v, message) {
  if (!isObject(v)) throw new TypeError(message);
  return v;
}

// ── Legacy platform objects ──────────────────────────────────────────────────────────────────────────────────────
// The object of an interface that supports indexed or named properties (Web IDL §3.9, a legacy platform object): a Proxy
// over the object as it was made, its target, whose traps are §3.9's internal methods — [[GetOwnProperty]] (§3.9.1, and
// the [[Get]] / [[HasProperty]] that ask it), [[Set]] (§3.9.2), [[DefineOwnProperty]] (§3.9.3), [[Delete]] (§3.9.4),
// [[PreventExtensions]] (§3.9.5) and [[OwnPropertyKeys]] (§3.9.6). Its indices and names are read live, so none goes
// stale. What an interface's special operations are, and which of its extended attributes say how its names are seen,
// is its IDL's: gen_bindings.mjs `legacyKind` makes the `kind` from them, one per interface, whose handler every object of
// it shares. Its steps, each handed what the implementation takes of the object (`arg`: its slots, or the object):
//   `item(arg, i)`         the indexed property getter: the value at a supported index, null at any other (an
//                          anonymous getter's steps answer so themselves);
//   `length(arg)`          how many supported indices there are (0 … length − 1);
//   `setIndex(arg, i, v)`  the indexed property setter, `v` converted by it — none where the interface has none;
//   `named(arg, name)`     the named property getter: the value of a supported property name, null (or undefined) for
//                          any other — asked before the object's own properties where they cannot hide one
//                          ([LegacyOverrideBuiltIns]), after its prototype chain where that can;
//   `names(arg)`           the supported property names, in order, each once;
//   `setNamed` / `deleteNamed(arg, name[, v])`  the named property setter / deleter, where the interface has one — a
//                          deleter answering false where its steps say the deletion failed;
//   `overrideBuiltIns`     [LegacyOverrideBuiltIns]: a named property seen over the prototype chain's;
//   `unenumerable`         [LegacyUnenumerableNamedProperties];
//   `unforgeable`          its [LegacyUnforgeable] members' names, which no named setter defines.
// `legacyPlatformObject(kind, own)` answers the function that makes one: `(target, arg)`, `arg` the object itself (the
// Proxy) where none is given; where the target has slots, their owner is the Proxy, stamped with them too — the object
// every caller holds. `own`, where given, makes the traps its objects answer before these — handed these, to fall back
// on — for what their implementation answers faster than their prototype would (a CSS declaration's property
// attributes: style-proxy.js), and the function such a trap reads its object's state off a target by.
// Gaps a Proxy cannot close: a non-configurable property is defined through a setter but reported refused (a Proxy may not
// report one its target lacks), and an own array index of an object of named properties alone is listed first by its
// target, where [[OwnPropertyKeys]] lists the own string keys in the order they were made.
const isDataDescriptor = (desc) => 'value' in desc || 'writable' in desc;
const ownDataDescriptor = (value, writable, enumerable) => ({ __proto__: null, value, writable, enumerable, configurable: true });
// OrdinarySetWithOwnDescriptor's steps past a writable data property found on the object: `value` defined on the receiver
// — an object the legacy platform object is the prototype of — as its own, where it may be.
function setOnReceiver(receiver, prop, value) {
  if (!isObject(receiver)) return false;
  const existing = protoless(reflectGetOwnPropertyDescriptor(receiver, prop));
  if (existing === undefined) return reflectDefineProperty(receiver, prop, ownDataDescriptor(value, true, true));
  if (!isDataDescriptor(existing) || !existing.writable) return false;
  return reflectDefineProperty(receiver, prop, { __proto__: null, value });
}
const PROXY_TRAPS = ['get', 'set', 'has', 'getOwnPropertyDescriptor', 'defineProperty', 'deleteProperty', 'ownKeys', 'preventExtensions'];
export function legacyPlatformObject(kind, own) {
  // (…what its target is stamped with, a private field of a class of the interface's own: a read every trap makes, kept
  // to one interface's objects — one class for them all made each read megamorphic)
  class LegacyTarget extends Stamp {
    #object;
    #arg;
    constructor(o, object, arg) {
      super(o);
      this.#object = object;
      this.#arg = arg;
    }
    static object(t) { return t.#object; }
    static arg(t) { return t.#arg; }
  }
  const legacyObjectOf = LegacyTarget.object, legacyArgOf = LegacyTarget.arg;
  const item = kind.item ?? null, length = kind.length ?? null, setIndex = kind.setIndex ?? null;
  const named = kind.named ?? null, names = kind.names ?? null, setNamed = kind.setNamed ?? null, deleteNamed = kind.deleteNamed ?? null;
  const indexed = item !== null, overrideBuiltIns = kind.overrideBuiltIns === true, enumerableNames = kind.unenumerable !== true;
  const unforgeable = new InternalSet(kind.unforgeable ?? NO_ARGUMENTS);
  // (…an array index of an object of indexed properties, else −1: none of its names — "ignoreNamedProps")
  const indexOf = (prop) => (indexed ? arrayIndex(prop) : -1);
  // The named property visibility algorithm, for a name that is no index: the value of a supported name no own property
  // hides — and, without [LegacyOverrideBuiltIns], none of the prototype chain — else null.
  // (…[LegacyOverrideBuiltIns]: the getter asked first, the one step a name no object has costs — an own property of
  // the object's, an expando, is rare beside it)
  const visibleNamed = overrideBuiltIns
    ? (t, prop) => {
      const v = named(legacyArgOf(t), prop) ?? null;
      return v === null || objectHasOwn(t, prop) ? null : v;
    }
    : (t, prop) => (reflectHas(t, prop) ? null : named(legacyArgOf(t), prop) ?? null);
  // LegacyPlatformObjectGetOwnProperty
  const ownProperty = (t, prop, ignoreNamedProps) => {
    if (typeof prop === 'string') {
      const i = indexOf(prop);
      if (i >= 0) {
        const v = item(legacyArgOf(t), i);
        if (v !== null) return ownDataDescriptor(v, setIndex !== null, true);
      } else if (named !== null && !ignoreNamedProps) {
        const v = visibleNamed(t, prop);
        if (v !== null) return ownDataDescriptor(v, setNamed !== null, enumerableNames);
      }
    }
    return protoless(reflectGetOwnPropertyDescriptor(t, prop));
  };
  const handler = { __proto__: null,
    getOwnPropertyDescriptor: (t, prop) => ownProperty(t, prop, false),
    // ([[Get]] and [[HasProperty]], the ordinary ones over that: the object's own property, else its prototype chain's —
    // [[Get]] one of the kind's, an indexed or a named one alone asking nothing of the other: it is every read's)
    get: named === null
      ? (t, prop, receiver) => {
        const i = arrayIndex(prop);
        if (i >= 0) {
          const v = item(legacyArgOf(t), i);
          if (v !== null) return v;
        }
        return reflectGet(t, prop, receiver);
      }
      : !indexed
        ? (t, prop, receiver) => {
          if (typeof prop === 'string') {
            const v = visibleNamed(t, prop);
            if (v !== null) return v;
          }
          return reflectGet(t, prop, receiver);
        }
        : (t, prop, receiver) => {
          if (typeof prop === 'string') {
            const i = arrayIndex(prop);
            if (i >= 0) {
              const v = item(legacyArgOf(t), i);
              if (v !== null) return v;
            } else {
              const v = visibleNamed(t, prop);
              if (v !== null) return v;
            }
          }
          return reflectGet(t, prop, receiver);
        },
    has(t, prop) {
      if (typeof prop === 'string') {
        const i = indexOf(prop);
        if (i >= 0) {
          if (i < length(legacyArgOf(t))) return true;
        } else if (named !== null) {
          // (…the ordinary answer first, whether or not the interface overrides built-ins: a name the visibility algorithm
          // hides is one an own property or the prototype chain has, which answers true all the same)
          return reflectHas(t, prop) || (named(legacyArgOf(t), prop) ?? null) !== null;
        }
      }
      return reflectHas(t, prop);
    },
    set(t, prop, value, receiver) {
      if (typeof prop === 'string') {
        const i = indexOf(prop);
        if (receiver === legacyObjectOf(t)) {
          if (i >= 0 && setIndex !== null) {
            setIndex(legacyArgOf(t), i, value);
            return true;
          }
          if (i < 0 && setNamed !== null) {
            setNamed(legacyArgOf(t), prop, value);
            return true;
          }
        }
        // (…ownDesc, named properties ignored: a supported index's own property, read-only without a setter)
        if (i >= 0 && item(legacyArgOf(t), i) !== null) return setIndex !== null && setOnReceiver(receiver, prop, value);
      }
      // (…else the ordinary steps — the receiver's own property defined through its [[DefineOwnProperty]], which refuses a
      // supported name with no setter)
      return reflectSet(t, prop, value, receiver);
    },
    defineProperty(t, prop, desc) {
      desc = protoless(desc);
      if (typeof prop === 'string') {
        const i = indexOf(prop);
        if (i >= 0) {
          if (!isDataDescriptor(desc) || setIndex === null) return false;
          setIndex(legacyArgOf(t), i, desc.value);
          return desc.configurable !== false;
        }
        if (named !== null && !unforgeable.has(prop) && (overrideBuiltIns || !objectHasOwn(t, prop))) {
          if (setNamed !== null) {
            if (!isDataDescriptor(desc)) return false;
            setNamed(legacyArgOf(t), prop, desc.value);
            return desc.configurable !== false;
          }
          // (…a supported name — "creating" false — with no setter)
          if ((named(legacyArgOf(t), prop) ?? null) !== null) return false;
        }
      }
      return reflectDefineProperty(t, prop, desc);
    },
    deleteProperty(t, prop) {
      if (typeof prop === 'string') {
        const i = indexOf(prop);
        if (i >= 0) return item(legacyArgOf(t), i) === null;
        if (named !== null && visibleNamed(t, prop) !== null) {
          return deleteNamed !== null && deleteNamed(legacyArgOf(t), prop) !== false;
        }
      }
      return reflectDeleteProperty(t, prop);
    },
    // (…never made non-extensible: its indexed and named properties come and go)
    preventExtensions: () => false,
    ownKeys(t) {
      const keys = newList(), arg = legacyArgOf(t), n = indexed ? length(arg) : 0;
      for (let i = 0; i < n; i++) keys[keys.length] = `${i}`;
      if (names !== null) {
        for (let i = 0, list = names(arg); i < list.length; i++) {
          const name = list[i], index = indexOf(name);
          // (…a name that is a supported index listed once, as the index; one past the indices a name like any other —
          // the spec's list, Chrome's and Firefox's, though [[GetOwnProperty]] answers it as an index, none)
          const hidden = overrideBuiltIns ? objectHasOwn(t, name) : reflectHas(t, name);
          if ((index < 0 || index >= n) && !hidden) keys[keys.length] = name;
        }
      }
      for (let i = 0, list = reflectOwnKeys(t); i < list.length; i++) keys[keys.length] = list[i];
      return keys;
    }
  };
  if (own !== undefined) {
    const legacy = { __proto__: null }, traps = own(legacy, legacyArgOf);
    for (let i = 0; i < PROXY_TRAPS.length; i++) {
      const name = PROXY_TRAPS[i];
      legacy[name] = handler[name];
      if (objectHasOwn(traps, name)) handler[name] = traps[name];
    }
  }
  const make = (target, arg) => {
    const proxy = new Proxy(target, handler);
    new LegacyTarget(target, proxy, arg === undefined ? proxy : arg);
    const slots = recordOf(target);
    if (slots !== undefined) {
      slots.owner = proxy;
      new Slots(proxy, slots);
    }
    return proxy;
  };
  legacyHandlers.set(make, handler);
  return make;
}
// A trap of the objects `make` makes withheld until the function this answers puts it back — every object of the kind
// at once, the handler being theirs — for a kind whose implementation knows that none of their names can be supported
// yet: no document of a realm has one while no element of the realm has ever had a name its named getter finds
// (dom-nodes.js `docNamedPropsSeen`), and until then its `get` would answer each read as the ordinary [[Get]] the Proxy
// forwards to with no trap, for the cost of a call into one — every `document.body`, `getElementById`, `createElement`.
const legacyHandlers = new InternalWeakMap();
export function withheldTrap(make, name) {
  const handler = legacyHandlers.get(make), trap = handler[name];
  handler[name] = undefined;
  return () => { handler[name] = trap; };
}
// The named properties object of a [Global] interface that supports named properties (Web IDL §3.7.4: Window's,
// WindowProperties): on the global's prototype chain, above the interface prototype object, its named properties
// answered as its own — those of `global`, the realm's, that no property of the chain under it hides, each
// writable and configurable, enumerable unless [LegacyUnenumerableNamedProperties] (`kind.unenumerable`) — but none
// defined or deleted, nor the object made non-extensible, nor its prototype changed. `proto` its prototype, the
// inherited interface's prototype object; `kind.named(global, name)` the named property getter (null for a name not
// supported); `classString` its @@toStringTag. `standIn`, where given, answers what the global's WindowProxy would of an
// index first (`item(index)`, null for none, and `length()`): the realm's global is no WindowProxy of its own here (a
// bounded gap, of the top-level window alone — a frame's WindowProxy answers them itself).
export function namedPropertiesObject(proto, global, kind, classString, standIn = null) {
  const named = kind.named, enumerable = kind.unenumerable !== true;
  const target = objectCreate(proto);
  objectDefineProperty(target, Symbol.toStringTag, { __proto__: null, value: classString, configurable: true });
  // (…what the global answers below its own properties and its interface's prototype object's: the chain under this one)
  const standInIndex = (prop) => (standIn === null ? -1 : arrayIndex(prop));
  const valueOf = (t, prop) => {
    if (typeof prop !== 'string') return null;
    const i = standInIndex(prop);
    if (i >= 0) return standIn.item(i);
    if (reflectHas(t, prop)) return null;
    return named(global, prop) ?? null;
  };
  return new Proxy(target, { __proto__: null,
    // (…a name the global or its interface prototype object has of its own, above it on the chain, still its own here —
    // as named-access-on-the-window-object/prototype.html, Chrome and Firefox have it: the literal visibility algorithm
    // would hide it)
    getOwnPropertyDescriptor(t, prop) {
      const v = valueOf(t, prop);
      if (v !== null) return ownDataDescriptor(v, true, standInIndex(prop) >= 0 || enumerable);
      return protoless(reflectGetOwnPropertyDescriptor(t, prop));
    },
    get(t, prop, receiver) {
      const v = valueOf(t, prop);
      return v !== null ? v : reflectGet(t, prop, receiver);
    },
    has(t, prop) {
      if (reflectHas(t, prop)) return true;
      const i = standInIndex(prop);
      return i >= 0 ? i < standIn.length() : valueOf(t, prop) !== null;
    },
    defineProperty: () => false,
    deleteProperty: () => false,
    preventExtensions: () => false,
    // (…SetImmutablePrototype: only the prototype it has)
    setPrototypeOf: (t, v) => v === objectGetPrototypeOf(t)
  });
}
// An observable array attribute's value (Web IDL §3.10, an observable array exotic object): a Proxy over an empty Array —
// so `Array.isArray` holds and %Array.prototype%'s methods work on it — whose indices and `length` are its backing
// list's, which the implementation keeps (`ops`, handed the object whose attribute it is: `length(self)`, `valueAt(self, i)`,
// `set(self, i, value)` — the attribute's "set an indexed value" algorithm, preceded by its "delete an indexed value" of
// the value there where `i` is no new index, and the list then holding `value` at `i` — and `truncate(self, n)`, the
// "delete an indexed value" algorithm of each value from the last down to `n`, and the list cut there). `convert` the
// conversion of a value to the array's IDL type. `observableArray(convert, ops)` answers the handler one attribute's
// arrays share; `observableArrayOf(self, name, handler)` the one array of `self`'s attribute `name`, made as it is first read.
class ObservedArray extends Stamp {
  #self;
  constructor(o, self) {
    super(o);
    this.#self = self;
  }
  static self(t) { return t.#self; }
}
class ObservableArrays extends Stamp {
  #arrays = { __proto__: null };
  static of(o) {
    if (!(#arrays in o)) new ObservableArrays(o);
    return o.#arrays;
  }
}
const observedSelf = ObservedArray.self;
export function observableArray(convert, ops) {
  const isIndex = (prop) => arrayIndex(prop) >= 0;
  // (…"set the length": a length no longer than the list's, each value past it deleted)
  const setLength = (self, value) => {
    const length = value >>> 0;
    if (length !== +value) throw new RangeError('Invalid array length');
    if (length > ops.length(self)) return false;
    ops.truncate(self, length);
    return true;
  };
  // (…"set the indexed value": at an index no further than its end — the list takes no hole)
  const setIndexed = (self, prop, value) => {
    const index = arrayIndex(prop);
    if (index > ops.length(self)) return false;
    ops.set(self, index, convert(value));
    return true;
  };
  return { __proto__: null,
    defineProperty(t, prop, desc) {
      desc = protoless(desc);
      const accessor = 'get' in desc || 'set' in desc;
      if (prop === 'length') {
        if (accessor || desc.configurable === true || desc.enumerable === true || desc.writable === false) return false;
        return 'value' in desc ? setLength(observedSelf(t), desc.value) : true;
      }
      if (isIndex(prop)) {
        if (accessor || desc.configurable === false || desc.enumerable === false || desc.writable === false) return false;
        return 'value' in desc ? setIndexed(observedSelf(t), prop, desc.value) : true;
      }
      return reflectDefineProperty(t, prop, desc);
    },
    deleteProperty(t, prop) {
      if (prop === 'length') return false;
      if (!isIndex(prop)) return reflectDeleteProperty(t, prop);
      const self = observedSelf(t), length = ops.length(self);
      if (arrayIndex(prop) !== length - 1) return false;
      ops.truncate(self, length - 1);
      return true;
    },
    get(t, prop, receiver) {
      if (prop === 'length') return ops.length(observedSelf(t));
      if (!isIndex(prop)) return reflectGet(t, prop, receiver);
      const self = observedSelf(t), index = arrayIndex(prop);
      return index < ops.length(self) ? ops.valueAt(self, index) : undefined;
    },
    getOwnPropertyDescriptor(t, prop) {
      if (prop === 'length') return { __proto__: null, value: ops.length(observedSelf(t)), writable: true, enumerable: false, configurable: false };
      if (!isIndex(prop)) return protoless(reflectGetOwnPropertyDescriptor(t, prop));
      const self = observedSelf(t), index = arrayIndex(prop);
      return index < ops.length(self) ? ownDataDescriptor(ops.valueAt(self, index), true, true) : undefined;
    },
    has(t, prop) {
      if (prop === 'length') return true;
      if (isIndex(prop)) return arrayIndex(prop) < ops.length(observedSelf(t));
      return reflectHas(t, prop);
    },
    ownKeys(t) {
      const keys = newList();
      for (let i = 0, n = ops.length(observedSelf(t)); i < n; i++) keys[i] = `${i}`;
      for (let i = 0, list = reflectOwnKeys(t); i < list.length; i++) keys[keys.length] = list[i];
      return keys;
    },
    preventExtensions: () => false,
    set(t, prop, value, receiver) {
      if (prop === 'length') return setLength(observedSelf(t), value);
      if (isIndex(prop)) return setIndexed(observedSelf(t), prop, value);
      return reflectSet(t, prop, value, receiver);
    }
  };
}
// …and the attribute set (Web IDL §3.7.6, an observable array's setter steps): its values, converted, put in place of
// the list's — the list emptied, then each set at its index in turn, so a value its "set an indexed value" algorithm
// refuses leaves those before it set (as Chrome and Firefox leave them).
export function replaceObservableArray(ops, self, values) {
  ops.truncate(self, 0);
  for (let i = 0; i < values.length; i++) ops.set(self, i, values[i]);
}
export function observableArrayOf(self, name, handler) {
  const arrays = ObservableArrays.of(self);
  let array = arrays[name];
  if (array === undefined) {
    const inner = pageList();
    new ObservedArray(inner, self);
    array = arrays[name] = new Proxy(inner, handler);
  }
  return array;
}
// …or such an object made natively (legacy.rs): an object of V8's own whose interceptor answers the same, which V8's
// serializer hands to the bindings as the platform object it is — where a Proxy is no structured-clone value at all
// (clone.rs). Its slots, under `key`, are what it is made with; `item` and `length` read them.
export function nativeIndexedObject(proto, key, item, length) {
  let slots;
  const obj = dom.indexedObject(proto, (i) => item(slots, i), () => length(slots));
  slots = makeSlots(obj, key);
  return slots;
}
// A canonical array index (0 … 2^32−2, no leading zeros), or −1 — read off its characters, allocating nothing: every
// property read of a legacy platform object asks.
export function arrayIndex(prop) {
  if (typeof prop !== 'string') return -1;
  const length = prop.length;
  if (length === 0 || length > 10) return -1;
  let n = prop.charCodeAt(0) - 48;
  if (n < 0 || n > 9 || (n === 0 && length > 1)) return -1;
  for (let i = 1; i < length; i++) {
    const d = prop.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return -1;
    n = n * 10 + d;
  }
  return n < 0xFFFFFFFF ? n : -1;
}

// A value iterator over an interface with an indexed getter: its keys / values / entries / forEach / @@iterator ARE
// %Array.prototype%'s (Web IDL §3.7.9; `classList.values === Array.prototype.values`).
const ARRAY_ITERATION = {
  __proto__: null,
  entries: Array.prototype.entries,
  keys:    Array.prototype.keys,
  values:  arrayValues,
  forEach: Array.prototype.forEach
};
const ITERATION_MEMBERS = ['entries', 'keys', 'values', 'forEach'];
export function defineValueIterator(proto) {
  for (let i = 0; i < ITERATION_MEMBERS.length; i++) {
    const m = ITERATION_MEMBERS[i];
    objectDefineProperty(proto, m, { __proto__: null, value: ARRAY_ITERATION[m], writable: true, enumerable: true, configurable: true });
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
  const iteratorPrototype = objectCreate(objectGetPrototypeOf(objectGetPrototypeOf(pageList()[Symbol.iterator]())));
  const step = {
    next() {
      const s = thisOf(this, key);
      const pairs = pairsOf(s.target);
      if (s.index >= pairs.length) return { value: undefined, done: true };
      const pair = pairs[s.index++], k = pair[0], v = pair[1];
      return { value: s.kind === 'key' ? k : s.kind === 'value' ? v : [k, v], done: false };
    }
  };
  objectDefineProperty(iteratorPrototype, 'next', { __proto__: null, value: step.next, writable: true, enumerable: true, configurable: true });
  objectDefineProperty(iteratorPrototype, Symbol.toStringTag, { __proto__: null, value: `${name} Iterator`, configurable: true });
  const iterator = (target, kind) => {
    const it = objectCreate(iteratorPrototype);
    const slots = makeSlots(it, key);
    slots.target = target;
    slots.kind = kind;
    slots.index = 0;
    return it;
  };
  const members = {
    entries() { return iterator(thisIs(this ?? globalThis, isSelf), 'key+value'); },
    keys() { return iterator(thisIs(this ?? globalThis, isSelf), 'key'); },
    values() { return iterator(thisIs(this ?? globalThis, isSelf), 'value'); },
    forEach(callback) {
      const self = thisIs(this ?? globalThis, isSelf);
      required(arguments, 1, 'forEach', name);
      if (!isCallable(callback)) throw new TypeError(`Failed to execute 'forEach' on '${name}': parameter 1 is not of type 'Function'.`);
      const thisArg = arguments[1];
      for (let i = 0, pairs = pairsOf(self); i < pairs.length; i++, pairs = pairsOf(self)) {
        reflectApply(callback, thisArg, [pairs[i][1], pairs[i][0], self]);
      }
    }
  };
  for (let i = 0; i < ITERATION_MEMBERS.length; i++) {
    const m = ITERATION_MEMBERS[i];
    objectDefineProperty(proto, m, { __proto__: null, value: members[m], writable: true, enumerable: true, configurable: true });
  }
  objectDefineProperty(proto, Symbol.iterator, { __proto__: null, value: members.entries, writable: true, enumerable: false, configurable: true });
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
    const before = reflectApply(setSize, set, NO_ARGUMENTS), result = step();
    if (changed && reflectApply(setSize, set, NO_ARGUMENTS) !== before) changed(self);
    return result;
  };
  const members = {
    get size() { return reflectApply(setSize, setOf(thisIs(this ?? globalThis, isSelf)), NO_ARGUMENTS); },
    entries() { return reflectApply(setMethods.entries, backing(this, 'entries'), NO_ARGUMENTS); },
    keys() { return reflectApply(setMethods.values, backing(this, 'keys'), NO_ARGUMENTS); },
    values() { return reflectApply(setMethods.values, backing(this, 'values'), NO_ARGUMENTS); },
    forEach(callback) {
      const self = thisIs(this ?? globalThis, isSelf);
      if (!isCallable(callback)) throw new TypeError(`Failed to execute 'forEach' on '${name}': parameter 1 is not of type 'Function'.`);
      const thisArg = arguments[1];
      reflectApply(setMethods.forEach, setOf(self), [(v) => reflectApply(callback, thisArg, [v, v, self])]);
    },
    has(v) { const set = backing(this, 'has'); return reflectApply(setMethods.has, set, [value(arguments, 'has')]); },
    add(v) {
      const set = backing(this, 'add'), x = value(arguments, 'add');
      mutate(this, set, () => reflectApply(setMethods.add, set, [x]));
      return this;
    },
    delete(v) {
      const set = backing(this, 'delete'), x = value(arguments, 'delete');
      return mutate(this, set, () => reflectApply(setMethods.delete, set, [x]));
    },
    clear() { const set = backing(this, 'clear'); mutate(this, set, () => reflectApply(setMethods.clear, set, NO_ARGUMENTS)); }
  };
  listEach(listConcat(['size', 'entries', 'keys', 'values', 'forEach', 'has'], own), (m) => {
    objectDefineProperty(proto, m, { __proto__: null, ...objectGetOwnPropertyDescriptor(members, m), enumerable: true, configurable: true });
  });
  objectDefineProperty(proto, Symbol.iterator, { __proto__: null, value: proto.values, writable: true, enumerable: false, configurable: true });
}
// A maplike interface's members (Web IDL §3.7.11) over the implementation's backing map — a JS Map of JS values,
// `mapOf(self)`, read and written through %Map.prototype%'s own methods, which a page's patching of them does not reach:
// size, entries, keys, values, forEach, get and has, and — `own`, those of set / delete / clear a writable maplike has
// and the interface declares none of its own — the rest; a key converted as each member's argument (`keys[member]`),
// `set`'s value as its second (`value`).
const mapMethods = {
  entries: Map.prototype.entries, keys: Map.prototype.keys, values: Map.prototype.values, forEach: Map.prototype.forEach,
  get: Map.prototype.get, has: Map.prototype.has, set: Map.prototype.set, delete: Map.prototype.delete, clear: Map.prototype.clear
};
const mapSize = Object.getOwnPropertyDescriptor(Map.prototype, 'size').get;
export function defineMaplike(proto, name, mapOf, isSelf, own, keys, value) {
  const backing = (self, method) => mapOf(thisIs(self ?? globalThis, isSelf, `Failed to execute '${method}' on '${name}': `));
  const key = (args, method) => {
    required(args, 1, method, name);
    return keys[method](args[0]);
  };
  const members = {
    get size() { return reflectApply(mapSize, mapOf(thisIs(this ?? globalThis, isSelf)), NO_ARGUMENTS); },
    entries() { return reflectApply(mapMethods.entries, backing(this, 'entries'), NO_ARGUMENTS); },
    keys() { return reflectApply(mapMethods.keys, backing(this, 'keys'), NO_ARGUMENTS); },
    values() { return reflectApply(mapMethods.values, backing(this, 'values'), NO_ARGUMENTS); },
    forEach(callback) {
      const self = thisIs(this ?? globalThis, isSelf);
      if (!isCallable(callback)) throw new TypeError(`Failed to execute 'forEach' on '${name}': parameter 1 is not of type 'Function'.`);
      const thisArg = arguments[1];
      reflectApply(mapMethods.forEach, mapOf(self), [(v, k) => reflectApply(callback, thisArg, [v, k, self])]);
    },
    get(k) { const map = backing(this, 'get'); return reflectApply(mapMethods.get, map, [key(arguments, 'get')]); },
    has(k) { const map = backing(this, 'has'); return reflectApply(mapMethods.has, map, [key(arguments, 'has')]); },
    set(k, v) {
      const map = backing(this, 'set');
      required(arguments, 2, 'set', name);
      reflectApply(mapMethods.set, map, [keys.set(k), value(v)]);
      return this;
    },
    delete(k) { const map = backing(this, 'delete'); return reflectApply(mapMethods.delete, map, [key(arguments, 'delete')]); },
    clear() { reflectApply(mapMethods.clear, backing(this, 'clear'), NO_ARGUMENTS); }
  };
  listEach(listConcat(['size', 'entries', 'keys', 'values', 'forEach', 'get', 'has'], own), (m) => {
    objectDefineProperty(proto, m, { __proto__: null, ...objectGetOwnPropertyDescriptor(members, m), enumerable: true, configurable: true });
  });
  objectDefineProperty(proto, Symbol.iterator, { __proto__: null, value: proto.entries, writable: true, enumerable: false, configurable: true });
}
// …and one with no iterable declaration: its @@iterator alone, %Array.prototype.values% (Web IDL §3.7.10 — an indexed
// property getter and an integer-typed `length`).
export function defineIndexedIterator(proto) {
  objectDefineProperty(proto, Symbol.iterator, { __proto__: null, value: arrayValues, writable: true, enumerable: false, configurable: true });
}

// An interface's attributes and operations are enumerable (Web IDL §3.7.6-7), which a class's members are not.
export function enumerable(proto, names) {
  listEach(names, (n) => objectDefineProperty(proto, n, { __proto__: null, enumerable: true }));
}

// An installed interface's members — those of the class its binding generates them in — put on the prototype of the
// hand-written class that makes its objects, as IDL has them: enumerable.
// The prototype must own none of them: a hand-written member of the same name would be one the binding replaces, unseen.
export function installMembers(proto, members) {
  const keys = reflectOwnKeys(members);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (key === 'constructor') continue;
    if (objectHasOwn(proto, key)) throw new Error(`${proto.constructor.name}.prototype has a member ${String(key)} of its own`);
    const desc = objectGetOwnPropertyDescriptor(members, key);
    desc.enumerable = true;
    objectDefineProperty(proto, key, protoless(desc));
  }
}

// A legacy factory function (Web IDL §3.7.2, `[LegacyFactoryFunction]`) on the global: `name`, `length` its required
// arguments, its `prototype` the interface's (and fixed) — `steps` make the object, of what is passed, and only `new`
// may call it. The object is NewTarget's: a subclass's (`class Thumb extends Image`) has its prototype, a NewTarget
// whose `prototype` is no object the interface's. A Proxy's `construct`, as a function's reads that `prototype` for a
// `this` ahead of the arguments, and a class's own `prototype` can't be the interface's.
export function defineLegacyFactoryFunction(name, length, prototype, steps) {
  const target = {
    [name]: function () {
      throw new TypeError(`Failed to construct '${name}': Please use the 'new' operator, this DOM object constructor cannot be called as a function.`);
    }
  }[name];
  objectDefineProperty(target, 'length', { __proto__: null, value: length, writable: false, enumerable: false, configurable: true });
  objectDefineProperty(target, 'prototype', { __proto__: null, value: prototype, writable: false, enumerable: false, configurable: false });
  const F = new Proxy(target, { __proto__: null,
    construct(_, args, newTarget) {
      const object = reflectApply(steps, undefined, args);
      if (newTarget !== F) {
        const p = newTarget.prototype;
        setPrototypeOf(object, p !== null && (typeof p === 'object' || typeof p === 'function') ? p : prototype);
      }
      return object;
    }
  });
  objectDefineProperty(globalThis, name, { __proto__: null, value: F, writable: true, enumerable: false, configurable: true });
}

// The attributes an inherited [Default] toJSON collects (Web IDL "collect attribute values of an inheritance stack"):
// `names`, each read by the getter `proto`'s chain has for it when the interface is installed — what a page puts there
// later is none of it — into the object the toJSON returns.
export function defaultJSONOf(proto, names) {
  const getters = listMap(names, (name) => {
    for (let p = proto; p; p = objectGetPrototypeOf(p)) {
      const desc = objectGetOwnPropertyDescriptor(p, name);
      if (desc) return [name, desc.get];
    }
    throw new Error(`no ${name} to collect for toJSON`);
  });
  return (self) => {
    const json = {};
    for (let i = 0; i < getters.length; i++) {
      const name = getters[i][0], get = getters[i][1];
      json[name] = reflectApply(get, self, NO_ARGUMENTS);
    }
    return json;
  };
}

// An interface's [LegacyUnforgeable] members (Web IDL §3.4.10): what defines them on an object, as its own properties —
// enumerable, and not configurable.
// (…one `defineProperty` each, which an object made per event — its `isTrusted` — pays for: `defineProperties` is the
// slower of the two, measured in node)
export function unforgeableMembers(members) {
  const entries = newList();
  const keys = reflectOwnKeys(members);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (key === 'constructor') continue;
    // (…an operation's not writable either: Location's `assign`)
    const descriptor = { __proto__: null, ...objectGetOwnPropertyDescriptor(members, key), enumerable: true, configurable: false };
    if ('value' in descriptor) descriptor.writable = false;
    listPush(entries, [key, descriptor]);
  }
  return (object) => {
    for (let i = 0; i < entries.length; i++) definePropertyOwn(object, entries[i][0], entries[i][1]);
    return object;
  };
}

// An interface object's `length`: its constructor's required arguments, 0 without one (Web IDL §3.7.1).
export function defineLength(iface, length) {
  objectDefineProperty(iface, 'length', { __proto__: null, value: length, writable: false, enumerable: false, configurable: true });
}

// An interface prototype's @@unscopables (Web IDL §3.7.3): a null-prototype object naming its [Unscopable] members.
export function defineUnscopables(proto, names) {
  const unscopables = objectCreate(null);
  listEach(names, (n) => { unscopables[n] = true; });
  objectDefineProperty(proto, Symbol.unscopables, { __proto__: null, value: unscopables, writable: false, enumerable: false, configurable: true });
}

// An interface prototype's class string (Web IDL §3.7.3): a data property, not an accessor — and its interface object's
// `name` (§3.7.1), the identifier itself whatever the bundling named the class it is made of (a generated `class
// DOMRectList` it renamed for a module's binding of that name).
export function defineClassString(proto, name) {
  objectDefineProperty(proto, Symbol.toStringTag, { __proto__: null, value: name, writable: false, enumerable: false, configurable: true });
  objectDefineProperty(proto.constructor, 'name', { __proto__: null, value: name, writable: false, enumerable: false, configurable: true });
}
