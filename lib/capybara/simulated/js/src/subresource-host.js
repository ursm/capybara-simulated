// What the engine's fetches for its own consumers (subresource_obtain.rs) ask of the bindings, by step: the clock, a
// pending preload's fetch run, a controlling service worker's answer to a request, the network's and an entry filed —
// each through the host's own hooks, nothing decided here.
import { runPendingPreload } from './handles.js';

const H_NOW = 0;
const H_RUN_PRELOAD = 1;
const H_SW_ANSWER = 2;
const H_NETWORK = 3;
const H_FILE = 4;

// (…a service worker's answer `{bytes}` / `{blocked}`, null where none controls the document, the URL is no http(s)
// one, or the worker let the request through; the network's facts of a response for its entry, null for a network
// error — the request `url` of `plan`, referred by `referrer`, null for its client's)
export function subresourceHost(step, a, b, c) {
  switch (step) {
    case H_NOW: return globalThis.__csimPerformanceNow();
    case H_RUN_PRELOAD: return runPendingPreload(a);
    case H_SW_ANSWER:
      try { return globalThis.__csimSwFetchDest(a, b, true, c); } catch (_) { return null; }
    case H_NETWORK:
      try { return globalThis.__csim_resourceTimingFetch ? globalThis.__csim_resourceTimingFetch(a, globalThis.__csimRealmId(), b, c) : null; } catch (_) { return null; }
    case H_FILE:
      if (typeof globalThis.__csimRecordResource === 'function') globalThis.__csimRecordResource(a);
      return undefined;
  }
  return undefined;
}
