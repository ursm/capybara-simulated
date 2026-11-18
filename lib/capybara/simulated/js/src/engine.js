// The engine's ops for this realm — the arena, the style engine, the layout walk, every native step the bindings stand
// on (dom.rs `install`, each op carrying the realm it was installed for) — as this realm's bindings reach them: a
// module binding, no property of the global a page could read, call or replace. The engine hands them over as the
// realm is made, before any script of a page's runs (`__csimTakeEngine`, which the realm's global loses as it is
// called), and keeps them with the realm's global besides, under a private key, for another realm's code that holds
// this realm's window (`engineOf`). None while the bundle is evaluated for the snapshot: what runs at load reads none.
export let dom;
// …the realm's HOST OBJECT (rusty_racer `host_object`), handed over with them: an object no global holds, which the
// host and these bindings share — rusty_racer's namespace on it (`RustyRacer`: the realms of the isolate by number,
// the microtask drain, the transfer of a value between isolates), the host's procs it attaches (`@…`), and the steps
// the host calls (`steps`, below) — so a page reads, calls and replaces none of them. None while the bundle is
// evaluated for the snapshot either.
export let hostObject;
// …and rusty_racer's namespace, off it
export let hostNamespace;

// The steps the host calls a realm by name — every request of the host's into a realm (v8_runtime.rb
// `V8Runtime.engine_call`, which `V8Runtime#call`, `#realm_call` and browser.rb `dom_call` go through): the engine ops it
// calls (HOST_OPS), and the bindings' own, each module's registered as it loads (`hostSteps.query = …`). The host
// reaches them on the realm's host object, `@steps.<step>`, which no script of a page's can name; it resolves each
// step's path once a realm, as it first calls it — a step registered late, a worker's scope's, as well — and calls the
// function it found from then on (v8_runtime.rb `V8Runtime.step_of`). Another realm's bindings reach a realm's steps
// through its hooks (`stepsOf(win)`).
const HOST_OPS = [
  'discardRealm',
  'dropRealm',
  'forgetOrigins',
  'forgetRealmObjects',
  'locationPart',
  'realmIdentify',
  'seedWindowDocument',
  'setAgentClusterKey',
  'setOriginKey',
  'setSandbox',
  'setSteppedWindow',
  'swGlobalInit',
  'takeOpenerOrigins',
  'takesPlanned',
  'viewportSet',
  'windowOpener'
];
export const hostSteps = { __proto__: null };
export const reflectApply = Reflect.apply;
globalThis.__csimTakeEngine = (ops, handed, exposed) => {
  delete globalThis.__csimTakeEngine;
  dom = ops;
  hostObject = realmHooks.hostObject = handed;
  hostNamespace = hostObject.RustyRacer;
  realmHooks.parent = realmHooks.top = globalThis;
  stampRealmHooks();
  for (let i = 0; i < HOST_OPS.length; i++) hostSteps[HOST_OPS[i]] = ops[HOST_OPS[i]];
  Object.defineProperty(hostObject, 'steps', { __proto__: null, value: hostSteps, writable: false, enumerable: false, configurable: false });
  // (…a spec's realm, which reads the engine's own state off its page: the namespace, its steps by name (`steps`) and
  // the host's procs — `Native.engine_global`, spec/support/engine_global.rb)
  if (exposed) {
    Object.defineProperty(globalThis, 'RustyRacer', { value: { __proto__: null, ...hostNamespace, steps: hostSteps, host: hostObject }, writable: false, enumerable: false, configurable: true });
    Object.defineProperty(globalThis, '__dom', { value: ops, writable: true, enumerable: false, configurable: true });
  }
};

// A list — an engine op's answer, the host's argument — walked by index, for a for…of, a spread or a destructuring that
// would otherwise walk it by `Array.prototype[Symbol.iterator]` and `%ArrayIteratorPrototype%.next`, which a page
// replaces, and which would see — and could change — every element: what the host calls and every security decision
// reads its lists so. (`membersOf` / `entriesOf` a Set's or a Map's, by the `forEach` the snapshot had, into a list of
// its own: a Map's entries each `[key, value]`, read by index too.)
const setForEach = Set.prototype.forEach, mapForEach = Map.prototype.forEach, codePointAt = String.prototype.codePointAt;
const fromCodePoint = String.fromCodePoint;
export function listOf(list, from = 0) {
  let i = from;
  const it = {
    __proto__: null,
    next: () => (i < list.length ? { value: list[i++], done: false } : { value: undefined, done: true })
  };
  it[Symbol.iterator] = () => it;
  return it;
}
// …and a string's code points, each a string, as a for…of over it gives them (by `String.prototype[Symbol.iterator]`,
// a page's to replace)
export function charsOf(str) {
  const out = setPrototypeOf([], null);
  for (let i = 0; i < str.length;) {
    const c = reflectApply(codePointAt, str, [i]);
    out[out.length] = fromCodePoint(c);
    i += c > 0xffff ? 2 : 1;
  }
  return listOf(out);
}
// (…grown with no prototype, so no index setter a page defined on `Array.prototype` meets an element written)
const setPrototypeOf = Object.setPrototypeOf;
export function membersOf(set) {
  const out = setPrototypeOf([], null);
  reflectApply(setForEach, set, [(v) => { out[out.length] = v; }]);
  return listOf(out);
}
export function entriesOf(map) {
  const out = setPrototypeOf([], null);
  reflectApply(mapForEach, map, [(v, k) => { out[out.length] = setPrototypeOf([k, v], null); }]);
  return listOf(out);
}
// A list a step builds — the host's answer, or one the bindings keep — by index, with no prototype as it grows: no method
// of `Array.prototype` (`map`, `push`, a page's to replace) builds it, and no index setter a page defined there meets an
// element written; an Array's again once filled, as every other list of the bindings'. `fill(add)` adds each element.
const arrayPrototype = Array.prototype;
// (…one the bindings grow themselves, of no prototype for good: its own `length` and indices alone)
export const newList = () => setPrototypeOf([], null);
export function listBuild(fill) {
  const out = setPrototypeOf([], null);
  fill((v) => { out[out.length] = v; });
  return setPrototypeOf(out, arrayPrototype);
}
// …`list` mapped by `fn(element, index)` into one
export function listMap(list, fn) {
  const out = setPrototypeOf([], null);
  for (let i = 0; i < list.length; i++) out[i] = fn(list[i], i);
  return setPrototypeOf(out, arrayPrototype);
}
// …and whether `list` holds `v` (SameValueZero, as `includes`)
export function listIncludes(list, v) {
  for (let i = 0; i < list.length; i++) if (list[i] === v || (list[i] !== list[i] && v !== v)) return true;
  return false;
}

// The functions the bindings — and the engine — still reach by a name of the global's: the bindings' `__csim…` hooks
// one module installs for another, or for another realm's — made read-only and non-configurable in the snapshot, or as the realm is ready, before any script of a
// page's runs (its window made: `initRealm`; its worker scope: the host step): no page can put its function in the
// place of one the bindings call and trust the answer of. They are still a page's to read and call (memory
// `csim_hooks_plan`: module bindings, the realm's hooks, a call path no page can name).
// (…in the snapshot already, but for those the bindings define again once the realm is made — a worker's scope's, the
// style engine's — and the one that goes as it is called)
const LATE = new Set([
  '__csimTakeEngine', '__csimUpdateStyle', '__csimPortEndClosed', '__csimPortEndGone', '__csimPortEndHere',
  '__csimPortRedeliver', '__csimPortRemotePost', '__csim_swAddRoutes'
]);
// (…the snapshot's walk of the global keeping the names it left for each realm — the hooks of `__csim_…` names and
// LATE's — which the realm seals by name: no walk of the global as a realm is made)
const deferred = setPrototypeOf([], null);
function seal(name) {
  const d = Reflect.getOwnPropertyDescriptor(globalThis, name);
  if (d === undefined || !d.configurable || typeof d.value !== 'function') return;
  Object.defineProperty(globalThis, name, { __proto__: null, value: d.value, writable: false, enumerable: false, configurable: false });
}
export function sealHostHooks(inSnapshot = false) {
  if (!inSnapshot) {
    for (let i = 0; i < deferred.length; i++) seal(deferred[i]);
    return;
  }
  const names = Object.getOwnPropertyNames(globalThis);
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    if (!name.startsWith('__csim') || name === '__csimTakeEngine') continue;
    // (…none the bindings define again: `__csim_…`, LATE)
    if (name.startsWith('__csim_') || LATE.has(name)) {
      deferred[deferred.length] = name;
      continue;
    }
    seal(name);
  }
  for (const name of membersOf(LATE)) if (!names.includes(name)) deferred[deferred.length] = name;
}

// (…and, as a document loads, those defined since — no time to walk the global, which the snapshot and the realm's
// readiness have)
export function sealLateHooks() {
  for (const name of membersOf(LATE)) seal(name);
}
hostSteps.sealHostHooks = () => sealHostHooks();
// The realm's `__csim_runScript`, which the host runs a page's classic script by (v8_runtime.rb
// `install_run_script_dispatcher`): a body past the bytecode-cache threshold to the host's cache path
// (`runScriptCached`, the host fn attached as it is installed), any other run as a classic Script of the realm in
// the engine (script.rs `runClassicScript`) — one function, sealed with the rest as the realm is ready; the host fn and
// the threshold it runs by the last install's, a realm kept for a next document installed again.
let runCached = null, runThreshold = Infinity;
globalThis.__csim_runScript = function (label, body) {
  if (body.length >= runThreshold) return runCached(label, body);
  dom.runClassicScript(label || 'csim-eval', body);
};
hostSteps.installRunScript = (threshold) => {
  runCached = hostObject.runScriptCached;
  runThreshold = threshold;
};

// The engine of the realm whose global `global` is — this realm's own, or another's a window of which this realm's code
// holds (a frame's, an opener's, a worker's): its raw global, as a WindowProxy keeps no private key of the window's.
export const engineOf = (global) => (global === globalThis ? dom : dom.engineOf(global));

// The window a WindowProxy is of — any realm's proxy (platform-globals.js `frameWindowProxyFor`), unwrapped by the step
// it was stamped with, a private field of the proxy: no trap of its runs, no name a page could define answers (every
// realm is made from the one snapshot, which shares the class's private names between them) — or `o` itself: a raw
// window, or anything else, told apart by a brand check as cheap as the property miss it replaced.
export let markWindowProxy, isWindowProxy, rawWindowOf;
class Stamp {
  constructor(o) {
    return o;
  }
}
class WindowProxyUnwrap extends Stamp {
  #unwrap;
  constructor(proxy, unwrap) {
    super(proxy);
    this.#unwrap = unwrap;
  }
  static {
    markWindowProxy = (proxy, unwrap) => new WindowProxyUnwrap(proxy, unwrap);
    isWindowProxy = (o) => typeof o === 'object' && o !== null && #unwrap in o;
    rawWindowOf = (o) => (typeof o === 'object' && o !== null && #unwrap in o ? o.#unwrap() : o);
  }
}
// The bindings' own steps of a realm that another realm's bindings call — its WindowProxy cache's eviction and
// retargeting, its proxy of a window — and its window's parent and top as the host made it (`setParentRealm`: its own
// until then, a top-level window's for good), kept with its global as a private field (`hooksOf`), which no name of the
// global's answers: a page reaches none of them, nor the raw globals they take and give, and no script of the frame's or
// of another window's can name another window its parent or top ([LegacyUnforgeable] `parent` / `top`, location's
// `ancestorOrigins`).
export const realmHooks = { __proto__: null, parent: globalThis, top: globalThis, steps: hostSteps };
export let hooksOf;
let stampRealmHooks;
class RealmHooks extends Stamp {
  #hooks;
  constructor(global, hooks) {
    super(global);
    this.#hooks = hooks;
  }
  static {
    hooksOf = (g) => {
      if (g === globalThis) return realmHooks;
      try { return g.#hooks; } catch { return undefined; }
    };
    stampRealmHooks = () => new RealmHooks(globalThis, realmHooks);
  }
}
// …the parent and the top of the window whose raw global `win` is (WindowProxies, where another realm's): undefined for
// what is no realm's global.
export const parentOf = (win) => hooksOf(win)?.parent;
export const topOf = (win) => hooksOf(win)?.top;
// …and the host's steps of that realm (`hostSteps`), which its bindings call one another's by as the host does — a
// frame's resize steps, a traversal applied in another window — undefined for what is no realm's global
export const stepsOf = (win) => hooksOf(win)?.steps;
// Each child realm's global — the realms the event loop steps beside this one (`steppedRealms`): `cb(global)` until
// one answers anything but undefined, which is the answer (the blob-store and worker-delivery searches).
export function eachChildRealm(cb) {
  if (dom.childFrames[0] === 0) return undefined;
  const ids = dom.steppedRealms();
  for (let i = 0; i < ids.length; i++) {
    const g = realmGlobalOf(ids[i]);
    if (!g) continue;
    let r;
    try { r = cb(g); } catch (_) { r = undefined; }
    if (r !== undefined) return r;
  }
  return undefined;
}
// The global of realm `id` of this isolate — raw, whatever its origin: the bindings' alone to hold — or null.
export function realmGlobalOf(id) {
  if (id == null) return null;
  try { return hostNamespace.contextGlobal(id) || null; } catch { return null; }
}
// The realm whose global `o` is — a raw global, not a WindowProxy (a JS Proxy is its creator's, the observer's) — by
// the realm the engine stamped it with, as of now (a realm reset away has another global): null for anything else.
export function realmOfGlobal(o) {
  if (o === globalThis) return dom.realmId;
  if (o === null || typeof o !== 'object') return null;
  const id = dom.realmOfGlobal(o);
  return id !== undefined && hostNamespace.contextGlobal(id) === o ? id : null;
}
// Same origin iff the realm of the raw window `raw` has THIS realm's document origin — by their keys, the engine's
// (realm_location.rs `sameOriginRealm`): an opaque origin same with the windows that share it alone (a child that
// inherited it), never with another opaque one. Fail CLOSED (cross-origin) for what is no raw window, and for a realm
// dropped. Module functions, as every security decision is: no global a page could replace.
export function isSameOriginWindow(raw) {
  const realm = realmOfGlobal(raw);
  return realm !== null && dom.sameOriginRealm(realm);
}
// …and same origin-domain, which a `document.domain` write moves (realm_location.rs `sameOriginDomainRealm`): what HTML
// asks of a script reaching another window's members (IsPlatformObjectSameOrigin), a frame's `contentDocument` and a
// window's `frameElement`.
export function isSameOriginDomainWindow(raw) {
  const realm = realmOfGlobal(raw);
  return realm !== null && dom.sameOriginDomainRealm(realm);
}
