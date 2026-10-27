// What the engine's fetches for its own consumers (subresource_obtain.rs) ask of the bindings, by step — each through
// the host's own hooks, nothing decided here:
//   H_NOW                                      the clock
//   H_SW_ANSWER (url, plan, referrer, …, binary, integrity)
//                                              a controlling service worker's answer `{bytes}` (`{body}` asked as text) /
//                                              `{blocked}` at once:
//                                              null where none controls the document, the URL is no http(s) one, or
//                                              the worker let the request through
//   H_SW_DISPATCH (url, plan, …, token, integrity, accept)
//                                              the request handed to its `fetch` event (`dispatchToWorker`), its
//                                              `Accept` the engine's (its destination's)
//   H_NETWORK (url, plan, referrer, client)    the network's facts of a response for its entry, null for a network
//                                              error — `client` its client realm, undefined for the calling one's
//   H_FILE (desc)                              an entry filed (performance.js `recordResourceTiming`)
//   H_BLOB (url)                               a `blob:` URL's entry's bytes `{bytes, type}`, null for none
//   H_DOCUMENT                                 the realm's document, null for none (a worker's)
//   H_FONT_BYTES (bytes)                       the font file bytes are, null where they are no font
//   H_FONT_NETWORK (url, plan, referrer)       a font downloaded `{path, meta}` (the file, its response's facts)
//   H_LOCAL_FONT (name, weightStyle)           the font installed under a `local()` name, null for none
//   H_FETCH (url, plan, …, client)             the network's response, its body's bytes `body_bytes` with it — null for a
//                                              network error
//   H_LINK_EVENT (nid, ok)                     a link's `load` (or `error`) fired
//   H_ASSET (url, plan, referrer, client)      the asset cache's `[body, meta, bytes]` (browser.rb `external_asset`), the
//                                              response's facts it kept beside the body
//   H_CONTROLLER                               the controlling service worker's handle, 0 for none
//   H_CHARSET                                  the realm's document's encoding, '' for none
//   H_IMAGE_START (url, plan, realm)           an image's request begun on a host thread, its id — 0 where none began
//   H_IMAGE_EVENT (nid, ok, load)              an image's load `load` applied: its `load` (or `error`) fired
//   H_VIDEO_BYTES (url, plan, …, client)       a video's resource from the network `{bytes, tainted, meta}`, null for none
//   H_MEDIA_DONE (nid, load, done)             a media element's fetch under `load` came to `done` (media.js
//                                              `mediaFetched`)
//   H_FRAME_NAVIGATION (request)               a frame's navigation's response (browser.rb `frame_navigation_fetch`, its
//                                              arguments `request`), null for a failed navigation
//   H_LOAD_BLOCKER_SETTLED                     a navigation that delayed its container's document's load is over: that
//                                              load asked about again (bridge.entry.js `__csimLoadBlockerSettled`)
//   H_SW_IMPORT (url, handle)                  a worker's import as its controlling service worker answers it, null
//                                              where none controls it or the worker let the request through
//   H_IMPORT_NETWORK (url, cache)              a worker's import from the network (a script's request, this worker its
//                                              client), null for a network error
//   H_SW_NOTE_IMPORT (url, body, handle)       a service worker's import kept on its registration's record, for the
//                                              Update algorithm's byte check
//   H_LOAD_IMAGE (url, plan, realm)            an image fetched and decoded at once, its record (`takeHostBitmaps`) —
//                                              null for a host fault
//   H_IMAGE_BLOB (nid, load, url)              an image's `blob:` load run after a stable state (`imageBlobLoad`) — none
//                                              where its document lost its browsing context meanwhile (Chrome)
// (`referrer` null for its client's)
import { docToken, requestingRealm } from './handles.js';
import { controllerHandle, serviceWorkerFor, swRequestOfPlan } from './sw-client.js';
import { fileWorkerAnswer } from './fetch.js';
import { resolveBlobBytes } from './blob.js';
import { fontFileFromBytes } from './font-metrics.js';
import { fireEvent } from './dispatch.js';
import { mediaFetched } from './media.js';
import { takeHostBitmaps } from './bytes.js';
import { containerReferrerPolicy, documentOrigin } from './document-origin.js';
import { location } from './location.js';

const H_NOW = 0;
const H_SW_ANSWER = 2;
const H_SW_DISPATCH = 3;
const H_NETWORK = 4;
const H_FILE = 5;
const H_BLOB = 6;
const H_DOCUMENT = 7;
const H_FONT_BYTES = 8;
const H_FONT_NETWORK = 9;
const H_LOCAL_FONT = 10;
const H_FETCH = 11;
const H_LINK_EVENT = 12;
const H_ASSET = 13;
const H_CONTROLLER = 14;
const H_CHARSET = 15;
const H_IMAGE_START = 16;
const H_IMAGE_EVENT = 17;
const H_VIDEO_BYTES = 18;
const H_MEDIA_DONE = 19;
const H_FRAME_NAVIGATION = 20;
const H_LOAD_BLOCKER_SETTLED = 21;
const H_SW_IMPORT = 22;
const H_IMPORT_NETWORK = 23;
const H_SW_NOTE_IMPORT = 24;
const H_LOAD_IMAGE = 25;
const H_IMAGE_BLOB = 26;

export function subresourceHost(step, a, b, c, d, e, f, g) {
  switch (step) {
    case H_NOW: return globalThis.__csimPerformanceNow();
    case H_SW_ANSWER:
      try { return globalThis.__csimSwFetchDest(a, b, e !== false, c, f || ''); } catch (_) { return null; }
    case H_SW_DISPATCH: return dispatchToWorker(a, b, e, f, g);
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
    case H_FETCH:
      try { return globalThis.__csimSubresourceFetch(a, d ?? globalThis.__csimRealmId(), b); } catch (_) { return null; }
    case H_ASSET:
      try { return globalThis.__csimExternalAsset(a, docToken(), d ?? requestingRealm(), b, c); } catch (_) { return null; }
    case H_CONTROLLER: return controllerHandle() || 0;
    case H_CHARSET: return globalThis.document?.characterSet ?? '';
    case H_LINK_EVENT: {
      // (…the link where it is now — a link moved into another realm's document as its worker answered is that realm's —
      // and the event of its realm)
      const [el, g] = nodeWhereItIs(a);
      if (el) fireEvent(el, new g.Event(b ? 'load' : 'error'));
      return undefined;
    }
    case H_IMAGE_START:
      try { return typeof globalThis.__csim_imageLoadStart === 'function' ? globalThis.__csim_imageLoadStart(a, c, b) | 0 : 0; } catch (_) { return 0; }
    case H_IMAGE_EVENT: return nodeWhereItIs(a)[0]?._fireImgEvent(b ? 'load' : 'error', c);
    case H_VIDEO_BYTES:
      try { return globalThis.__csim_videoBytes ? globalThis.__csim_videoBytes(a, d ?? globalThis.__csimRealmId(), b) : null; } catch (_) { return null; }
    case H_MEDIA_DONE: {
      const el = nodeWhereItIs(a)[0];
      if (el) mediaFetched(el, b, c);
      return undefined;
    }
    case H_FRAME_NAVIGATION:
      try { return globalThis.__csim_frameNavigationFetch(...a); } catch (_) { return null; }
    case H_LOAD_BLOCKER_SETTLED:
      globalThis.__csimLoadBlockerSettled?.();
      return undefined;
    case H_SW_IMPORT: {
      const ctrl = globalThis.__csimServiceWorkerFor(a);
      return ctrl ? globalThis.__csim_swImportFetch(ctrl, a, b) || null : null;
    }
    case H_IMPORT_NETWORK: {
      // (…a script's request — "fetch a classic worker-imported script", destination "script" — this worker its client:
      // its URL the referrer source, its origin the request's, its policy container's referrer policy)
      const here = String(location.href);
      return globalThis.__rackFetch('GET', a, '', null, 'follow', null, null, containerReferrerPolicy(), here, b, null, null, null, here,
                                    false, null, documentOrigin(), globalThis.__csimRealmId(), false, 'script');
    }
    case H_LOAD_IMAGE:
      try { return takeHostBitmaps(globalThis.__csim_loadImage(a, c, b)); } catch (_) { return null; }
    case H_IMAGE_BLOB:
      globalThis.__csimQueueMicrotask(() => {
        const el = nodeWhereItIs(a)[0];
        if (el && el._ownerDocument?._window != null) globalThis.__dom.imageBlobLoad(el, b, c, subresourceHost);
      });
      return undefined;
    case H_SW_NOTE_IMPORT:
      try { globalThis.__csim_swNoteImport(c, a, b); } catch (_) {}
      return undefined;
  }
  return undefined;
}

// The node `nid` in the realm it is in now, and that realm's global.
function nodeWhereItIs(nid) {
  const realm = globalThis.__dom.realmOf(nid);
  const g = realm === globalThis.__dom.realmId ? globalThis : globalThis.RustyRacer.contextGlobal(realm);
  return [g?.__dom.nodeOf(nid) ?? null, g];
}

// The request `token` names handed to the controlling service worker's `fetch` event — false where none controls the
// document or the URL is no http(s) one — and its answer handed to the engine as an entry reads it once its body is had
// (fetch.js `fileWorkerAnswer`; an opaque one's bytes, which an image paints, beside it), or null where the worker let
// the request through.
function dispatchToWorker(url, plan, token, integrity, accept) {
  const ctrl = serviceWorkerFor(url);
  if (!ctrl) return false;
  const resume = (answer, redirected, render) => globalThis.__dom.obtainResume(token, answer, redirected, render, subresourceHost);
  globalThis.__csimSWInterceptFetch(ctrl, 'GET', url, { Accept: accept }, null, swRequestOfPlan(plan, integrity), (resp) => {
    if (resp == null) { resume(null, false, null); return; }
    fileWorkerAnswer(resp, (answer) => resume(answer, resp.redirected === true, resp.opaque_render ?? null));
  });
  return true;
}
