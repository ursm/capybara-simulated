// ES module loader. mini_racer doesn't expose V8's host-module
// callbacks, so we synthesise the loader in JS. EsmRewriter (Ruby)
// transforms each module body into a `__csim_require`/`__csim_defineExport`
// shaped factory; this module is the runtime side of that contract.
// `ingestImportmaps(doc)` is the bridge-internal entry point —
// `__csimLoadDocument` calls it after each visit to merge any
// `<script type="importmap">` tags into the resolver map.

import { scriptText } from './walk.js';

// Exposed via globalThis so test / debug code can read them. Also
// because `evaluate_script` runs in a new `Function` scope that
// can't see ESM-local constants.
globalThis.__csim_modules    = Object.create(null);
globalThis.__csim_inProgress = Object.create(null);
globalThis.__csim_importmap  = { imports: Object.create(null), scopes: Object.create(null) };
const modules    = globalThis.__csim_modules;
const inProgress = globalThis.__csim_inProgress;
const importmap  = globalThis.__csim_importmap;

// Live import binding. ES module imports are by-reference: when
// `import { x } from 'foo'` is read at the consumer, the value is
// re-fetched from foo's export slot — which itself is a live
// binding to whatever the source variable points at.
//
// Three cases:
//
// 1. Non-callable, non-null at first access (plain objects, strings,
//    numbers, booleans): snapshot directly. The function-target
//    Proxy below would lie about prototype
//    (`Object.getPrototypeOf(proxy) === Function.prototype`),
//    breaking Immutable.js's `fromJS` plain-object detection.
//
// 2. Callable at first access (functions, classes): wrap in a
//    function-target Proxy so `a(...)` / `new X(...)` re-read
//    `module[key]`. Most bundled exports fall here.
//
// 3. Undefined / null at first access: wrap in a Proxy because
//    Vite/Rolldown's CJS-interop lazy modules register the export
//    before assigning the variable — `Q` from immutable.es is
//    hoisted (`var Q`) but only assigned inside the lazy thunk
//    that `oi()` triggers. The Proxy re-reads on every access so
//    once the consumer calls `oi()` and Q is bound, subsequent
//    `a({...})` calls hit the now-assigned value.
//
// Known gap: case 3 keeps `typeof proxy === 'function'` even when
// the underlying value stays undefined forever (a config setting
// that's not enabled). React-DOM's `useState`'s `typeof a ===
// 'function' && (a = a())` lazy-init branch then triggers and
// `Reflect.apply(undefined, …)` throws "apply on null". We don't
// currently distinguish "transient undefined" from "permanent
// undefined".
globalThis.__csim_liveImport = function (module, key) {
  const current = module[key];
  if (current != null && typeof current !== 'function') {
    return current;
  }
  // Function target so `apply`/`construct` traps fire for callable
  // imports. Enumeration traps (`ownKeys` / `getOwnPropertyDescriptor`)
  // must honour the Proxy invariant that non-configurable target keys
  // (a function's `prototype`) appear in the result with their target
  // descriptor — interleave target keys with the underlying value's
  // keys so consumers that enumerate the binding
  // (`Object.getOwnPropertyNames(proxy)`, used by `Object.assign` /
  // namespace-unwrap helpers like Rolldown's `__copyProps`) see the
  // exported members.
  const target = function () {};
  return new Proxy(target, {
    apply(_, thisArg, args) {
      const fn = module[key];
      // Reflect.apply on null throws; mirror the `get` trap's
      // undefined-passthrough so a null export stays a placeholder
      // rather than becoming an uncallable trap. (React-DOM's
      // `useState` lazy-init `typeof a === 'function' && (a = a())`
      // walks straight into this when the import is permanently
      // undefined.)
      if (fn == null) return undefined;
      return Reflect.apply(fn, thisArg, args);
    },
    construct(_, args, newTarget) {
      const ctor = module[key];
      if (ctor == null) return undefined;
      return Reflect.construct(ctor, args, newTarget);
    },
    get(_, prop) {
      const v = module[key];
      if (prop === Symbol.toPrimitive) {
        return (hint) => {
          if (v == null) return v;
          const m = v[Symbol.toPrimitive];
          return typeof m === 'function' ? m.call(v, hint) : v;
        };
      }
      if (v == null) return undefined;
      // Return method references unbound so identity checks
      // (`a.match === b.match`) stay stable. Consumers calling
      // `proxy.method()` immediately bind `this = proxy` by JS
      // semantics; our apply trap forwards to `v` so the underlying
      // method still sees the real receiver.
      return v[prop];
    },
    set(_, prop, value) {
      const v = module[key];
      if (v != null) v[prop] = value;
      return true;
    },
    has(_, prop) {
      const v = module[key];
      return v != null && (prop in Object(v));
    },
    ownKeys() {
      const v = module[key];
      const valKeys = v != null ? Reflect.ownKeys(Object(v)) : [];
      // Target's own keys (`prototype` / `length` / `name`) must be
      // included to satisfy the non-configurable invariant.
      return Array.from(new Set([...Reflect.ownKeys(target), ...valKeys]));
    },
    getOwnPropertyDescriptor(_, prop) {
      // Target's `prototype` is non-configurable — invariant forces
      // us to return target's descriptor verbatim. Other keys forward
      // to the underlying value with `configurable: true` patched on
      // so the engine doesn't complain that we're reporting
      // non-configurability for keys the target doesn't own.
      if (Object.prototype.hasOwnProperty.call(target, prop)) {
        return Reflect.getOwnPropertyDescriptor(target, prop);
      }
      const v = module[key];
      if (v == null) return undefined;
      const desc = Reflect.getOwnPropertyDescriptor(Object(v), prop);
      return desc && { ...desc, configurable: true };
    }
  });
};

// Define a live export slot. EsmRewriter routes every `export { … }`
// / `export default …` through this so the getter closes over the
// source variable and re-reads it on each access. Without this,
// `__exports.X = Y` snapshots Y at export time — and modules where Y
// is assigned later (Vite lazy-init thunks) export `undefined`.
globalThis.__csim_defineExport = function (exports, name, getter) {
  Object.defineProperty(exports, name, { get: getter, enumerable: true, configurable: true });
};

// EsmRewriter collapses `import(spec)` into a regular call site —
// this is the function it points at. `baseUrl` is the URL of the
// module containing the `import(...)` call site, threaded in by
// EsmRewriter so relative specifiers (`./foo.js`) resolve against
// the importer the way real ESM does. Returns a synchronously
// resolved Promise so user code awaiting it doesn't block.
globalThis.__csim_dynamicImport = function (spec, baseUrl) {
  try {
    const base = baseUrl || (globalThis.location && globalThis.location.href) || null;
    const resolved = globalThis.__csim_resolveSpecifier(String(spec), base);
    return Promise.resolve(globalThis.__csim_require(resolved));
  } catch (e) { return Promise.reject(e); }
};

globalThis.__csim_require = function (url) {
  if (url in modules)    return modules[url];
  if (url in inProgress) return inProgress[url];
  const src = globalThis.__csim_fetchModuleSource(String(url));
  if (src == null) throw new Error('module not registered: ' + url);
  // Wrap the EsmRewriter-rewritten body in a factory expression
  // assigned to a globalThis slot, then run via Ruby so the runtime
  // can cache compiled bytecode across per-visit context rebuilds.
  // Function-scope semantics for `var`/`let`/`const` match the prior
  // `new Function('__exports', src)` shape exactly.
  const wrapped = 'globalThis.__csim_pending_factory = function (__exports) {\n' + src + '\n};';
  try { globalThis.__csim_runScript(url, wrapped); }
  catch (e) {
    throw new Error('module compile failed for ' + url + ': ' + (e && e.message ? e.message : e));
  }
  const factory = globalThis.__csim_pending_factory;
  globalThis.__csim_pending_factory = null;
  if (typeof factory !== 'function') throw new Error('module factory did not register for ' + url);
  const exports = {};
  inProgress[url] = exports;
  try {
    factory(exports);
    modules[url] = exports;
  } finally {
    delete inProgress[url];
  }
  return exports;
};

// Module specifier resolution: bare specifiers → importmap;
// anything else → URL-joined against the importer.
globalThis.__csim_resolveSpecifier = function (specifier, baseUrl) {
  const mapped = importmap.imports[specifier];
  if (mapped) return resolveAgainst(mapped, baseUrl);
  if (specifier.charAt(0) === '/' ||
      specifier.startsWith('./') || specifier.startsWith('../') ||
      /^[a-z]+:\/\//i.test(specifier)) {
    return resolveAgainst(specifier, baseUrl);
  }
  return specifier; // bare, no map — surface as-is so the loader errors usefully
};

export function resolveAgainst(url, base) {
  try {
    const u = globalThis.__csim_parseUrl(url, base || (globalThis.location && globalThis.location.href) || null);
    return u && !u.error ? u.href : url;
  } catch (_) { return url; }
}

// Ingest `<script type="importmap">` tags. Per HTML spec only the
// first map wins, but importmap-rails / Rails 8 can ship multi-pin
// output as separate tags; later maps override earlier keys.
export function ingestImportmaps(doc) {
  if (!doc || !doc.documentElement) return;
  const tags = doc.documentElement.getElementsByTagName('script');
  for (const t of tags) {
    if ((t._attrs.type || '').toLowerCase() !== 'importmap') continue;
    const src = t._attrs.src;
    let text;
    if (src) {
      try {
        const resp = globalThis.__rackFetch('GET', src, '', null, 'follow');
        text = resp && resp.status < 400 ? resp.body : null;
      } catch (_) { text = null; }
    } else {
      text = scriptText(t);
    }
    if (!text) continue;
    let parsed;
    try { parsed = JSON.parse(text); } catch (_) { continue; }
    if (parsed && typeof parsed === 'object') {
      if (parsed.imports && typeof parsed.imports === 'object') Object.assign(importmap.imports, parsed.imports);
      if (parsed.scopes  && typeof parsed.scopes  === 'object') Object.assign(importmap.scopes,  parsed.scopes);
    }
  }
  // Push the merged map to the Ruby side so `load_module`'s
  // bare-specifier resolution agrees with JS-side
  // `__csim_resolveSpecifier`. Best-effort: if Ruby hasn't wired
  // the callback (e.g. snapshot path), the stub is a no-op.
  try { globalThis.__csim_pushImportmap(JSON.stringify(importmap)); } catch (_) {}
}

// Stub overridden by Ruby-attached host fn. The snapshot needs the
// symbol bound (otherwise the `new Function('return eval(...)')`
// wrap in `evaluate_script` can't reference it).
if (typeof globalThis.__csim_fetchModuleSource !== 'function') {
  globalThis.__csim_fetchModuleSource = function () { return null; };
}
