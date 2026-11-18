import { arrayIsArray, named, objectDefineProperty, objectGetOwnPropertyDescriptor, objectHasOwn, reflectApply } from './intrinsics.js';
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
// `o` of no prototype — what V8 reads a property descriptor or a Proxy trap off: a descriptor handed to
// `defineProperty`, what a `getOwnPropertyDescriptor` trap answers, what a `defineProperty` trap is handed — so that
// nothing a page put on Object.prototype (`get`, `set`, `value`, a trap's name) is read off it. (A literal one is made
// `{ __proto__: null, … }`.)
const nullPrototypeOf = Object.setPrototypeOf;
export const protoless = (o) => (o === null || typeof o !== 'object' ? o : nullPrototypeOf(o, null));
// The steps as the host reaches them (`@steps.<step>`): each a function bound to no receiver, so that the object the
// host read it off — which rusty_racer hands a function it calls as its `this` — reaches no step's code, nor anything
// that code hands its `this` to (a page's `Function.prototype.apply` among them). A view over `hostSteps`, made as each
// is first read and again for a step registered anew: a step a worker's scope adds later is there as it is. (The
// bindings' own calls of a step are `hostSteps`'s, unbound.)
const functionBind = Function.prototype.bind;
const boundSteps = { __proto__: null };
function boundStep(name) {
  const step = typeof name === 'string' ? hostSteps[name] : undefined;
  if (typeof step !== 'function') return undefined;
  const held = boundSteps[name];
  if (held !== undefined && held[0] === step) return held[1];
  const bound = reflectApply(functionBind, step, [undefined]);
  boundSteps[name] = [step, bound];
  return bound;
}
const refuse = () => false;
const stepsView = new Proxy({ __proto__: null }, {
  __proto__: null,
  get: (_, name) => boundStep(name),
  getOwnPropertyDescriptor: (_, name) => {
    const value = boundStep(name);
    return value === undefined ? undefined : { __proto__: null, value, writable: false, enumerable: false, configurable: true };
  },
  has: (_, name) => boundStep(name) !== undefined,
  ownKeys: () => [],
  defineProperty: refuse,
  deleteProperty: refuse,
  set: refuse,
  setPrototypeOf: refuse,
  preventExtensions: refuse
});
globalThis.__csimTakeEngine = (ops, handed, exposed) => {
  delete globalThis.__csimTakeEngine;
  dom = ops;
  hostObject = realmHooks.hostObject = handed;
  hostNamespace = hostObject.RustyRacer;
  realmHooks.parent = realmHooks.top = globalThis;
  stampRealmHooks();
  for (let i = 0; i < HOST_OPS.length; i++) hostSteps[HOST_OPS[i]] = ops[HOST_OPS[i]];
  objectDefineProperty(hostObject, 'steps', { __proto__: null, value: stepsView, writable: false, enumerable: false, configurable: false });
  // (…a spec's realm, which reads the engine's own state off its page: the namespace, its steps by name (`steps`), the
  // host's procs (`host`) and the realm's hooks (`hooks`) — `Native.engine_global`, spec/support/engine_global.rb)
  if (exposed) {
    const exposedNamespace = { __proto__: null, ...hostNamespace, steps: hostSteps, host: hostObject, hooks: realmHooks };
    objectDefineProperty(globalThis, 'RustyRacer', { __proto__: null, value: exposedNamespace, writable: false, enumerable: false, configurable: true });
    objectDefineProperty(globalThis, '__dom', { __proto__: null, value: ops, writable: true, enumerable: false, configurable: true });
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
// …`value` added at the end of `list`, as `push` adds it but by no `push` of a page's: one the bindings keep, or one
// they hand on, as long as they hold it. (An index setter a page defined on `Array.prototype` is met as `push` meets it.)
export function listPush(list, value) {
  if (!arrayIsArray(list)) {
    reflectApply(list.push, list, [value]);
    return;
  }
  list[list.length] = value;
}
// (…and each element of the array `values`, in order, as `push(...values)` adds them)
export function listAppend(list, values) {
  const n = values.length;
  for (let i = 0; i < n; i++) listPush(list, values[i]);
}
// …`list` mapped by `fn(element, index, list)` into one — and the rest of what Array.prototype does with a function,
// as it does it: the length read once, as the walk begins; a hole (no element of the array's own at an index) skipped,
// told by the `hasOwn` taken as the bundle loaded — never by reading through `Array.prototype`, whose index a page may
// have defined — and kept a hole where the answer keeps its place (`listMap`). Each walks by index, hands the function
// to no method of `Array.prototype`'s a page may have replaced, and builds its answer with no species a page may have
// set (`constructor`). A `list` that is no array — an internal Map or Set, a platform object's list, a typed array —
// its own method's.
const has = objectHasOwn;
export function listMap(list, fn) {
  if (!arrayIsArray(list)) return reflectApply(list.map, list, [fn]);
  const n = list.length, out = setPrototypeOf([], null);
  out.length = n;
  for (let i = 0; i < n; i++) if (has(list, i)) out[i] = fn(list[i], i, list);
  return setPrototypeOf(out, arrayPrototype);
}
export function listEach(list, fn) {
  if (!arrayIsArray(list)) return reflectApply(list.forEach, list, [fn]);
  const n = list.length;
  for (let i = 0; i < n; i++) if (has(list, i)) fn(list[i], i, list);
  return undefined;
}
export function listFilter(list, fn) {
  if (!arrayIsArray(list)) return reflectApply(list.filter, list, [fn]);
  const n = list.length, out = setPrototypeOf([], null);
  for (let i = 0; i < n; i++) {
    if (!has(list, i)) continue;
    const v = list[i];
    if (fn(v, i, list)) out[out.length] = v;
  }
  return setPrototypeOf(out, arrayPrototype);
}
// (…flattened one level, as `flatMap` is: an array answer's own elements, its holes skipped)
export function listFlatMap(list, fn) {
  if (!arrayIsArray(list)) return reflectApply(list.flatMap, list, [fn]);
  const n = list.length, out = setPrototypeOf([], null);
  for (let i = 0; i < n; i++) {
    if (!has(list, i)) continue;
    const r = fn(list[i], i, list);
    if (arrayIsArray(r)) {
      const m = r.length;
      for (let j = 0; j < m; j++) if (has(r, j)) out[out.length] = r[j];
    } else out[out.length] = r;
  }
  return setPrototypeOf(out, arrayPrototype);
}
export function listSome(list, fn) {
  if (!arrayIsArray(list)) return reflectApply(list.some, list, [fn]);
  const n = list.length;
  for (let i = 0; i < n; i++) if (has(list, i) && fn(list[i], i, list)) return true;
  return false;
}
export function listEvery(list, fn) {
  if (!arrayIsArray(list)) return reflectApply(list.every, list, [fn]);
  const n = list.length;
  for (let i = 0; i < n; i++) if (has(list, i) && !fn(list[i], i, list)) return false;
  return true;
}
// (…`find` and `findIndex` visit a hole, as Array.prototype's do, its element undefined)
export function listFind(list, fn) {
  if (!arrayIsArray(list)) return reflectApply(list.find, list, [fn]);
  const n = list.length;
  for (let i = 0; i < n; i++) {
    const v = has(list, i) ? list[i] : undefined;
    if (fn(v, i, list)) return v;
  }
  return undefined;
}
export function listFindIndex(list, fn) {
  if (!arrayIsArray(list)) return reflectApply(list.findIndex, list, [fn]);
  const n = list.length;
  for (let i = 0; i < n; i++) if (fn(has(list, i) ? list[i] : undefined, i, list)) return i;
  return -1;
}
export function listReduce(list, fn, initial) {
  const seeded = arguments.length > 2;
  if (!arrayIsArray(list)) return reflectApply(list.reduce, list, seeded ? [fn, initial] : [fn]);
  const n = list.length;
  let i = 0, acc;
  if (seeded) acc = initial;
  else {
    while (i < n && !has(list, i)) i++;
    if (i >= n) throw new TypeError('Reduce of empty array with no initial value');
    acc = list[i++];
  }
  for (; i < n; i++) if (has(list, i)) acc = fn(acc, list[i], i, list);
  return acc;
}
// …and `list` sorted — in place, as `sort` sorts it, and stably — by `compare(a, b)` (a number below 0 putting `a`
// first), or by the strings of its elements where none is given; undefined elements after the rest, holes last of all.
export function listSort(list, compare) {
  if (!arrayIsArray(list)) return reflectApply(list.sort, list, compare === undefined ? [] : [compare]);
  const n = list.length, values = setPrototypeOf([], null);
  let undefineds = 0;
  for (let i = 0; i < n; i++) {
    if (!has(list, i)) continue;
    const v = list[i];
    if (v === undefined) undefineds++;
    else values[values.length] = v;
  }
  const order = compare !== undefined ? compare : (a, b) => {
    const x = `${a}`, y = `${b}`;
    return x < y ? -1 : x > y ? 1 : 0;
  };
  // (…a merge sort: stable, as Array.prototype.sort is, and calling nothing of a page's)
  let from = values, to = setPrototypeOf([], null);
  to.length = from.length;
  for (let width = 1; width < from.length; width *= 2) {
    for (let lo = 0; lo < from.length; lo += 2 * width) {
      const mid = lo + width < from.length ? lo + width : from.length, hi = lo + 2 * width < from.length ? lo + 2 * width : from.length;
      let i = lo, j = mid, k = lo;
      while (i < mid && j < hi) to[k++] = order(from[j], from[i]) < 0 ? from[j++] : from[i++];
      while (i < mid) to[k++] = from[i++];
      while (j < hi) to[k++] = from[j++];
    }
    const t = from;
    from = to;
    to = t;
  }
  let k = 0;
  for (; k < from.length; k++) list[k] = from[k];
  for (let u = 0; u < undefineds; u++) list[k++] = undefined;
  for (; k < n; k++) delete list[k];
  return list;
}
// …and whether `list` holds `v` (SameValueZero, as `includes`)
export function listIncludes(list, v) {
  for (let i = 0; i < list.length; i++) if (list[i] === v || (list[i] !== list[i] && v !== v)) return true;
  return false;
}

// How the realm runs a page's classic script (bridge.entry.js): a body past the bytecode-cache threshold by the host's
// cache path (`runScriptCached`, the host fn attached as the host installs it: v8_runtime.rb
// `install_run_script_dispatcher`), any other as a classic Script of the realm in the engine (script.rs
// `runClassicScript`) — the host fn and the threshold it runs by the last install's, a realm kept for a next document
// installed again.
let runCached = null, runThreshold = Infinity;
export function runScript(label, body) {
  if (body.length >= runThreshold) return runCached(label, body);
  dom.runClassicScript(label || 'csim-eval', body);
}
hostSteps.installRunScript = (threshold) => {
  runCached = hostObject.runScriptCached;
  runThreshold = threshold;
};

// The realm's `Function.prototype.toString`: `function NAME() { [native code] }` for a platform function — any the
// snapshot's script made, the bindings' every interface object, operation, accessor and step a page can come to hold, a
// frame's or a worker's alike (dom.rs `isPlatformFunction`) — as a browser answers for its own, whose source is no
// page's to read; the engine's own answer for any other function, a page's as it wrote it, a builtin's; and its
// TypeError for what is no function.
const functionToString = Function.prototype.toString;
const platformToString = named({
  toString() {
    if (dom !== undefined && dom.isPlatformFunction(this)) {
      const own = objectGetOwnPropertyDescriptor(this, 'name');
      return `function ${own !== undefined && typeof own.value === 'string' ? own.value : ''}() { [native code] }`;
    }
    return reflectApply(functionToString, this, []);
  }
}.toString, 'toString');
export function installPlatformToString() {
  objectDefineProperty(Function.prototype, 'toString', { __proto__: null, value: platformToString, writable: true, enumerable: false, configurable: true });
}

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
// The realm's HOOKS: what one module of its bindings installs for another that cannot import it (an import cycle, an
// order of initialisation), what another realm's bindings call or read of it — its WindowProxy cache's eviction and
// retargeting, its proxy of a window, its event loop's steps, its document's teardown, its window's state (`document`,
// `status`, `event`) — and its window's parent and top as the host made it (`setParentRealm`: its own until then, a
// top-level window's for good). A module binding, and kept with its global as a private field (`hooksOf`), which no name
// of the global's answers: a page reaches none of them, nor the raw globals they take and give — none of the bindings'
// own is a property of any global (spec/internal_members_hidden_spec.rb) — and no script of the frame's or of another
// window's can name another window its parent or top ([LegacyUnforgeable] `parent` / `top`, location's
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
