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
import { INTRINSICS, intrinsicArguments } from './bundle_intrinsics.mjs';

await esbuild.build({
  entryPoints: ['lib/capybara/simulated/js/src/bridge.entry.js'],
  bundle:      true,
  format:      'iife',
  // (…no `keepNames`: what it keeps is the name of a function the bundling renamed, and each is the bindings' own — a
  // platform object's interface and members take their names from their declarations, a `var X = class extends …`'s
  // and the generated bindings' — while the `__name` it calls for every function made, at every call that makes one
  // (`listOf`'s on each walk), defined a property through the page's `Object.prototype`: a page's `get` or `set` there
  // made every one of them throw)
  outfile:     'lib/capybara/simulated/js/bridge.bundle.js',
  logLevel:    'warning',
  // (…one an engine lacks passed as undefined, as a bare reference to it would have thrown)
  // Strict, as the ES modules it is made of are: in sloppy code a page's `Error.prepareStackTrace` reads each frame's
  // function and `this` (`CallSite#getFunction` / `getThis`) whenever a binding calls something a page can replace —
  // and so holds the bindings' own functions, which a strict frame answers undefined for. (…in a function of its own:
  // the parameters' `eval` is no name a strict function may bind)
  banner: {js: `((${INTRINSICS.join(', ')}) => (() => {\n'use strict';`},
  footer: {js: `})())(${intrinsicArguments()});`}
});
