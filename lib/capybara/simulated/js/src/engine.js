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

// The realm's `__csim_runScript`, which the host runs a page's classic script by (v8_runtime.rb
// `install_run_script_dispatcher`): a body past the bytecode-cache threshold to the host's cache path
// (`__csim_runScriptCached`, the host fn attached as it is installed), any other run as a classic Script of the realm in
// the engine (script.rs `runClassicScript`).
hostStep('installRunScript', (threshold) => {
  const cached = globalThis.__csim_runScriptCached, runClassic = dom.runClassicScript;
  globalThis.__csim_runScript = function (label, body) {
    if (body.length >= threshold) return cached(label, body);
    runClassic(label || 'csim-eval', body);
  };
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
// retargeting, its proxy of a window — kept with its global as a private field (`hooksOf`), which no name of the
// global's answers: a page reaches none of them, nor the raw globals they take and give.
export const realmHooks = { __proto__: null };
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
