// What the engine's fetches for its own consumers (subresource_obtain.rs) ask of the bindings, by step — each through
// the host's own hooks, nothing decided here:
//   H_NOW                                      the clock
//   H_RUN_PRELOAD (token)                      a pending preload's fetch run
//   H_SW_ANSWER (url, plan, referrer)          a controlling service worker's answer `{bytes}` / `{blocked}` at once:
//                                              null where none controls the document, the URL is no http(s) one, or
//                                              the worker let the request through
//   H_SW_DISPATCH (url, plan, …, token)        the request handed to its `fetch` event (`dispatchToWorker`)
//   H_NETWORK (url, plan, referrer, client)    the network's facts of a response for its entry, null for a network
//                                              error — `client` its client realm, undefined for the calling one's
//   H_FILE (desc)                              an entry filed (performance.js `recordResourceTiming`)
//   H_BLOB (url)                               a `blob:` URL's entry's bytes `{bytes, type}`, null for none
//   H_DOCUMENT                                 the realm's document, null for none (a worker's)
//   H_FONT_BYTES (bytes)                       the font file bytes are, null where they are no font
//   H_FONT_NETWORK (url, plan, referrer)       a font downloaded `{path, meta}` (the file, its response's facts)
//   H_LOCAL_FONT (name, weightStyle)           the font installed under a `local()` name, null for none
// (`referrer` null for its client's)
import { requestingRealm, runPendingPreload } from './handles.js';
import { serviceWorkerFor, swRequestOfPlan } from './sw-client.js';
import { fileWorkerAnswer } from './fetch.js';
import { resolveBlobBytes } from './blob.js';
import { fontFileFromBytes } from './font-metrics.js';

const H_NOW = 0;
const H_RUN_PRELOAD = 1;
const H_SW_ANSWER = 2;
const H_SW_DISPATCH = 3;
const H_NETWORK = 4;
const H_FILE = 5;
const H_BLOB = 6;
const H_DOCUMENT = 7;
const H_FONT_BYTES = 8;
const H_FONT_NETWORK = 9;
const H_LOCAL_FONT = 10;

export function subresourceHost(step, a, b, c, d, e) {
  switch (step) {
    case H_NOW: return globalThis.__csimPerformanceNow();
    case H_RUN_PRELOAD: return runPendingPreload(a);
    case H_SW_ANSWER:
      try { return globalThis.__csimSwFetchDest(a, b, true, c); } catch (_) { return null; }
    case H_SW_DISPATCH: return dispatchToWorker(a, b, e);
    case H_NETWORK:
      try { return globalThis.__csim_resourceTimingFetch ? globalThis.__csim_resourceTimingFetch(a, d ?? globalThis.__csimRealmId(), b, c) : null; } catch (_) { return null; }
    case H_FILE:
      if (typeof globalThis.__csimRecordResource === 'function') globalThis.__csimRecordResource(a);
      return undefined;
    case H_BLOB: return resolveBlobBytes(a);
    case H_DOCUMENT: return globalThis.document?._nid ?? null;
    case H_FONT_BYTES: return fontFileFromBytes(a).path;
    case H_FONT_NETWORK:
      try { return globalThis.__csim_webFontFetch ? globalThis.__csim_webFontFetch(a, requestingRealm(), c, globalThis.__dom.subresourcePlanFields(b)[2]) : null; } catch (_) { return null; }
    case H_LOCAL_FONT:
      try { return globalThis.__csim_localFontFile ? globalThis.__csim_localFontFile(a, b) : null; } catch (_) { return null; }
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
