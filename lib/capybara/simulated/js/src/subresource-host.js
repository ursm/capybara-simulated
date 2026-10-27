// What the engine's fetches for its own consumers (subresource_obtain.rs) ask of the bindings, by step: the clock, a
// pending preload's fetch run, a controlling service worker's answer to a request — at once, or a `fetch` event
// dispatched whose answer the engine is handed later — the network's and an entry filed: each through the host's own
// hooks, nothing decided here.
import { runPendingPreload } from './handles.js';
import { serviceWorkerFor, swRequestOfPlan } from './sw-client.js';
import { fileWorkerAnswer } from './fetch.js';
import { resolveBlobBytes } from './blob.js';

const H_NOW = 0;
const H_RUN_PRELOAD = 1;
const H_SW_ANSWER = 2;
const H_SW_DISPATCH = 3;
const H_NETWORK = 4;
const H_FILE = 5;
const H_BLOB = 6;

// (…a request is its URL `a`, its `plan`, its `referrer` — null for its client's — and its client realm, undefined
// for the calling one's; `a` is a pending preload's token for H_RUN_PRELOAD, an entry's description for H_FILE, a
// `blob:` URL for H_BLOB, whose entry's bytes it answers `{bytes, type}`, null for none: a
// service worker's answer `{bytes}` / `{blocked}`, null where none controls the document, the URL
// is no http(s) one, or the worker let the request through; the network's facts of a response for its entry, null for a
// network error)
export function subresourceHost(step, a, plan, referrer, client, token) {
  switch (step) {
    case H_NOW: return globalThis.__csimPerformanceNow();
    case H_RUN_PRELOAD: return runPendingPreload(a);
    case H_SW_ANSWER:
      try { return globalThis.__csimSwFetchDest(a, plan, true, referrer); } catch (_) { return null; }
    case H_SW_DISPATCH: return dispatchToWorker(a, plan, token);
    case H_NETWORK:
      try { return globalThis.__csim_resourceTimingFetch ? globalThis.__csim_resourceTimingFetch(a, client ?? globalThis.__csimRealmId(), plan, referrer) : null; } catch (_) { return null; }
    case H_FILE:
      if (typeof globalThis.__csimRecordResource === 'function') globalThis.__csimRecordResource(a);
      return undefined;
    case H_BLOB: return resolveBlobBytes(a);
  }
  return undefined;
}

// The request `token` names handed to the controlling service worker's `fetch` event — false where none controls the
// document or the URL is no http(s) one — and its answer handed to the engine as an entry reads it once its body is had
// (fetch.js `fileWorkerAnswer`), or null where the worker let the request through.
function dispatchToWorker(url, plan, token) {
  const ctrl = serviceWorkerFor(url);
  if (!ctrl) return false;
  const resume = (answer, redirected) => globalThis.__dom.obtainResume(token, answer, redirected, subresourceHost);
  globalThis.__csimSWInterceptFetch(ctrl, 'GET', url, {}, null, swRequestOfPlan(plan), (resp) => {
    if (resp == null) { resume(null, false); return; }
    fileWorkerAnswer(resp, (answer) => resume(answer, resp.redirected === true));
  });
  return true;
}
