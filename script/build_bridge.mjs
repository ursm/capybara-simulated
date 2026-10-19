// Bundles the bindings (bridge.entry.js) into bridge.bundle.js — esbuild's IIFE, inside one more function whose
// parameters are the ECMAScript intrinsics as they are when the bundle loads, before any page runs. A bare `TypeError`,
// `Map` or `Uint8Array` in the platform's code is then the realm's own, as the specs' algorithms mean it, and not the
// global a page may have replaced by the time it runs (a polyfill's, a test double's) — a string timer handler, a
// worker's script and `importScripts` run by the realm's own `eval`, as Chrome compiles them without calling the page's. What a page reaches through
// `globalThis` it still reaches there. `Date` is not among them: the platform's own is the virtual clock's (timers.js
// puts it in place), which a bare `Date` has to keep meaning. Nor is one an engine exposes only behind a runtime flag
// (`Float16Array`) or installs after the snapshot the bundle is built into (`SharedArrayBuffer`, `WebAssembly`): it
// would be captured as undefined.
import * as esbuild from 'esbuild';

const INTRINSICS = [
  'AggregateError', 'Array', 'ArrayBuffer', 'Atomics', 'BigInt', 'BigInt64Array', 'BigUint64Array', 'Boolean', 'DataView',
  'Error', 'EvalError', 'FinalizationRegistry', 'Float32Array', 'Float64Array', 'Function',
  'Int8Array', 'Int16Array', 'Int32Array', 'Intl', 'Iterator', 'JSON', 'Map', 'Math', 'Number', 'Object', 'Promise',
  'Proxy', 'RangeError', 'ReferenceError', 'Reflect', 'RegExp', 'Set', 'String', 'Symbol',
  'SyntaxError', 'TypeError', 'URIError', 'Uint8Array', 'Uint8ClampedArray', 'Uint16Array', 'Uint32Array', 'WeakMap',
  'WeakRef', 'WeakSet', 'decodeURI', 'decodeURIComponent', 'encodeURI', 'encodeURIComponent', 'escape', 'eval',
  'isFinite', 'isNaN', 'parseFloat', 'parseInt', 'unescape'
];

await esbuild.build({
  entryPoints: ['lib/capybara/simulated/js/src/bridge.entry.js'],
  bundle:      true,
  format:      'iife',
  keepNames:   true,
  outfile:     'lib/capybara/simulated/js/bridge.bundle.js',
  logLevel:    'warning',
  // (…one an engine lacks passed as undefined, as a bare reference to it would have thrown)
  banner: {js: `((${INTRINSICS.join(', ')}) => {`},
  footer: {js: `})(${INTRINSICS.map((name) => `typeof ${name} === 'undefined' ? undefined : ${name}`).join(', ')});`}
});
