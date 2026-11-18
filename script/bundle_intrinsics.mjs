// The ECMAScript intrinsics a bundle the snapshot loads takes as the parameters of the function it is wrapped in, as
// they are when it loads, before any page runs (build_bridge.mjs, build_vendor.mjs): a bare `Promise` or `TypeError` in
// its code is then the realm's own, and not the global a page may have replaced by the time it runs. `Date` is not among
// them (the bindings' own is the virtual clock's, which timers.js puts in place), nor is one an engine exposes only
// behind a runtime flag or installs after the snapshot is made: it would be captured as undefined.
export const INTRINSICS = [
  'AggregateError', 'Array', 'ArrayBuffer', 'Atomics', 'BigInt', 'BigInt64Array', 'BigUint64Array', 'Boolean', 'DataView',
  'Error', 'EvalError', 'FinalizationRegistry', 'Float32Array', 'Float64Array', 'Function',
  'Int8Array', 'Int16Array', 'Int32Array', 'Intl', 'Iterator', 'JSON', 'Map', 'Math', 'Number', 'Object', 'Promise',
  'Proxy', 'RangeError', 'ReferenceError', 'Reflect', 'RegExp', 'Set', 'String', 'Symbol',
  'SyntaxError', 'TypeError', 'URIError', 'Uint8Array', 'Uint8ClampedArray', 'Uint16Array', 'Uint32Array', 'WeakMap',
  'WeakRef', 'WeakSet', 'decodeURI', 'decodeURIComponent', 'encodeURI', 'encodeURIComponent', 'escape', 'eval',
  'isFinite', 'isNaN', 'parseFloat', 'parseInt', 'unescape'
];

// …and the arguments the wrapper is called with: each one's value, undefined where the engine lacks it (a bare reference
// to it would have thrown).
export const intrinsicArguments = () => INTRINSICS.map((name) => `typeof ${name} === 'undefined' ? undefined : ${name}`).join(', ');
