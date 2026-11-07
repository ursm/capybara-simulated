// The engine's ops for this realm — the arena, the style engine, the layout walk, every native step the bindings stand
// on (dom.rs `install`, each op carrying the realm it was installed for) — as this realm's bindings reach them: a
// module binding, no property of the global a page could read, call or replace. The engine hands them over as the
// realm is made, before any script of a page's runs (`__csimTakeEngine`, which the realm's global loses as it is
// called), and keeps them with the realm's global besides, under a private key, for another realm's code that holds
// this realm's window (`engineOf`). None while the bundle is evaluated for the snapshot: what runs at load reads none.
export let dom;
// …and rusty_racer's host namespace — the realms of the isolate by number (`contextGlobal`, `contextOf`), the microtask
// drain, the transfer of a value between isolates — taken at the same time, its functions as they were then: the
// global's `RustyRacer` is the host's entry alone from then on (below), none of them on it.
export let hostNamespace;

// The steps the host calls a realm by (v8_runtime.rb, browser.rb `V8Runtime.engine_call`), under its namespace —
// `RustyRacer.engine.<name>(token, …)`, as `Context#call` reaches a function by a path from the global: the engine
// ops it calls by name, and the steps of the bindings' a module registers (`hostStep`). Each takes the host's token
// first (`Native.host_token`), which no script of a page's has: a page reads the namespace but makes none of these
// calls — a sandboxed frame's `setSandbox(0)` would lift its own sandbox, `dropRealm(0)` empty its page. The namespace
// goes off the global once the host can call a function a page cannot name (rusty_racer: memory `csim_hooks_plan`).
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
  'viewportSet'
];
const hostSteps = { __proto__: null };
const reflectApply = Reflect.apply;
export function hostStep(name, step) {
  hostSteps[name] = step;
}
globalThis.__csimTakeEngine = (ops, token, exposed) => {
  delete globalThis.__csimTakeEngine;
  dom = ops;
  hostNamespace = Object.freeze({ ...globalThis.RustyRacer });
  realmHooks.parent = realmHooks.top = globalThis;
  stampRealmHooks();
  const entry = { __proto__: null };
  // (…its arguments handed on as the list they came in, by `Reflect.apply` as the snapshot had it: a spread would walk
  // them by `Array.prototype[Symbol.iterator]`, which a page replaces — and would see, and could rewrite, every one)
  const gate = (step) => (given, ...args) => {
    if (given !== token) throw new TypeError('Illegal invocation');
    return reflectApply(step, undefined, args);
  };
  for (const name of HOST_OPS) entry[name] = gate(ops[name]);
  for (const name in hostSteps) entry[name] = gate(hostSteps[name]);
  // (…a spec's realm, which reads the engine's own state off its page, its ops and the whole namespace besides:
  // `Native.engine_global`, spec/support/engine_global.rb)
  const namespace = exposed ? { ...hostNamespace, engine: Object.freeze(entry) } : { engine: Object.freeze(entry) };
  Object.defineProperty(globalThis, 'RustyRacer', { value: Object.freeze(namespace), writable: false, enumerable: false, configurable: false });
  if (exposed) Object.defineProperty(globalThis, '__dom', { value: ops, writable: true, enumerable: false, configurable: true });
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

// The functions the host calls a realm by name — the bindings' `__csim…` hooks, the host's own procs it attached as
// globals (`__csim_…`), the event loop's (`__runLoopStep` and the rest below) — made read-only and non-configurable in
// the snapshot, or as the realm is ready, before any script of a page's runs (its window made: `__csimInitRealm`; its
// worker scope: the host step): no page can put its function in the place of one the host calls and trusts the
// answer of. They are still a page's to read and call (memory `csim_hooks_plan`: a call path no page can name).
const HOST_CALLED = new Set([
  '__drainTimers', '__elementHandle', '__evalAsyncScript', '__hasReadyTimer', '__nextTimerDelay', '__pollAsyncResult',
  '__runLoopStep', '__settleGenGet', '__virtualNow'
]);
// …and none of the host's own procs, which it attaches as globals once the realm is made (runtime_shared.rb
// `BROWSER_HOST_FNS`, v8_runtime.rb's `attach`es: those of `__csim_…` names, and these), over a stub of the bindings' where
// there is one — sealed in the snapshot, the stub would stay, and the attach fail without a word
// (spec/host_boundary_spec.rb holds this list to the host's)
export const HOST_PROCS = new Set([
  '__csimAssetDocumentStarted', '__csimBcSiblingsExist', '__csimBlobWindow', '__csimBroadcast', '__csimBroadcastQueued',
  '__csimClientPortEndClosed', '__csimClientPortEndGone', '__csimClientPortEndHere', '__csimClientPortPost',
  '__csimClientPortRedeliver', '__csimClientSpace', '__csimDeleteAllCookies', '__csimExternalAsset', '__csimFocusChanged',
  '__csimNoteClient', '__csimOpenAuxFromRealm', '__csimReadFilePick', '__csimSessionPartition', '__csimStorageChanged',
  '__csimStoragePartitions', '__csimSubresourceFetch', '__csimWebauthnAddCredential',
  '__csimWebauthnAddVirtualAuthenticator', '__csimWebauthnGetCredentials', '__csimWebauthnRemoveCredential',
  '__csimWebauthnRemoveVirtualAuthenticator', '__csimWebauthnSetUserVerified', '__csimWindowClose', '__csimWindowOpen',
  '__csimWindowRealmsChanged'
]);
// (…in the snapshot already, but for those the bindings define again once the realm is made — a worker's scope's, the
// style engine's — and the one that goes as it is called)
const LATE = new Set([
  '__csimTakeEngine', '__csimUpdateStyle', '__csimPortEndClosed', '__csimPortEndGone', '__csimPortEndHere',
  '__csimPortRedeliver', '__csimPortRemotePost', '__csimWorkerClosedRead', '__csim_swAddRoutes', '__csim_swClientMessage',
  '__csim_swClientNavigateResult', '__csim_swDispatchFetch', '__csim_swHasFetchListener', '__csim_swSoftUpdateLater',
  '__csim_swStreamCancel'
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
    if (!name.startsWith('__csim') && !HOST_CALLED.has(name) || name === '__csimTakeEngine' || HOST_PROCS.has(name)) continue;
    // (…none the host attaches its own procs as, or the bindings define again: `__csim_…`, LATE)
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
hostStep('sealHostHooks', () => sealHostHooks());
// The realm's `__csim_runScript`, which the host runs a page's classic script by (v8_runtime.rb
// `install_run_script_dispatcher`): a body past the bytecode-cache threshold to the host's cache path
// (`__csim_runScriptCached`, the host fn attached as it is installed), any other run as a classic Script of the realm in
// the engine (script.rs `runClassicScript`) — one function, sealed with the rest as the realm is ready; the host fn and
// the threshold it runs by the last install's, a realm kept for a next document installed again.
let runCached = null, runThreshold = Infinity;
globalThis.__csim_runScript = function (label, body) {
  if (body.length >= runThreshold) return runCached(label, body);
  dom.runClassicScript(label || 'csim-eval', body);
};
hostStep('installRunScript', (threshold) => {
  runCached = globalThis.__csim_runScriptCached;
  runThreshold = threshold;
});

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
export const realmHooks = { __proto__: null, parent: globalThis, top: globalThis };
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
