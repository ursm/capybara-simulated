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
