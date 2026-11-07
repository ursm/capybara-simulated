// The engine's ops for this realm — the arena, the style engine, the layout walk, every native step the bindings stand
// on (dom.rs `install`, each op carrying the realm it was installed for) — as this realm's bindings reach them: a
// module binding, no property of the global a page could read, call or replace. The engine hands them over as the
// realm is made, before any script of a page's runs (`__csimTakeEngine`, which the realm's global loses as it is
// called), and keeps them with the realm's global besides, under a private key, for another realm's code that holds
// this realm's window (`engineOf`). None while the bundle is evaluated for the snapshot: what runs at load reads none.
export let dom;

// The ops the host calls a realm's engine by (v8_runtime.rb, browser.rb): under its namespace (`RustyRacer.engine`, as
// `Context#call` reaches a function by a path from the global), these alone — a realm's identity, its sandboxing and
// its document's seed, its viewport, a window stepped or discarded, a realm's arena dropped — not every op of the
// engine's. The host's namespace is still a page's to read; that, and so these, go once the host can call a function
// a page cannot name.
const HOST_OPS = [
  'discardRealm','dropRealm', 'forgetOrigins', 'forgetRealmObjects', 'locationPart', 'realmIdentify',
  'runClassicScript', 'seedWindowDocument', 'setAgentClusterKey', 'setOriginKey', 'setSandbox', 'setSteppedWindow',
  'swGlobalInit', 'takeOpenerOrigins', 'viewportSet'
];
globalThis.__csimTakeEngine = (ops) => {
  delete globalThis.__csimTakeEngine;
  dom = ops;
  const host = Object.create(null);
  for (const name of HOST_OPS) host[name] = ops[name];
  Object.defineProperty(globalThis.RustyRacer, 'engine', { value: Object.freeze(host) });
};

// The engine of the realm whose global `global` is — this realm's own, or another's a window of which this realm's code
// holds (a frame's, an opener's, a worker's): its raw global, as a WindowProxy keeps no private key of the window's.
export const engineOf = (global) => (global === globalThis ? dom : dom.engineOf(global));
