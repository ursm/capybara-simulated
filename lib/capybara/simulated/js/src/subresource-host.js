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
//   H_ASSET (url, plan, referrer, client, module, since, waits)
//                                              the asset cache's `[body, meta, bytes]` (browser.rb `external_asset`), the
//                                              response's facts it kept beside the body — a module's (a modulepreload's)
//                                              its document's module map's
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
//                                              load asked about again (bridge.entry.js `realmHooks.loadBlockerSettled`)
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
//   H_SCRIPT_START (url, plan, referrer, client, kind, began, id)
//                                              a script's fetch begun at `began` (the event loop's clock), its request
//                                              made now, filed as slot `id`: the time its server took — the asset
//                                              cache's answer at once where it has it: the parser's classic one's (`kind`
//                                              true, a parser-blocking one's 3, `H_ASSET`'s shape) or a module graph's
//                                              entry's (`kind` 2, kept for the graph's fetch of it, its answer true)
//   H_SCRIPT_TAKE (id)                         its answer, as `H_FETCH` or (the parser's) `H_ASSET` answers, as it
//                                              lands now (the page's clock: a module's Resource Timing entry ends then)
//   H_SCRIPT_FORGET (id)                       its answer let go of
// (`referrer` null for its client's)
import { docToken, requestingRealm } from './handles.js';
import { controllerHandle, serviceWorkerFor, swFetchChain } from './sw-client.js';
import { fileWorkerAnswer } from './fetch.js';
import { resolveBlobBytes } from './blob.js';
import { fontFileFromBytes } from './font-metrics.js';
import { fireEvent } from './dispatch.js';
import { mediaFetched } from './media.js';
import { takeHostBitmaps } from './bytes.js';
import { hostWait, virtualNow } from './timers.js';
import { nidOf } from './node-identity.js';
import { nodeDocumentOf } from './native-query-shadow.js';
import { fireImgEvent } from './dom-nodes.js';
import { defaultViewOf } from './document-state.js';
import { dom, engineOf, hostNamespace, hostObject, realmHooks } from './engine.js';
import { reflectApply } from './intrinsics.js';

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
const H_SCRIPT_START = 27;
const H_SCRIPT_TAKE = 29;
const H_SCRIPT_FORGET = 30;
const H_MODULE_GRAPH = 2, H_SCRIPT_BLOCKING = 3;

// (…a fetch of the host's the realm's script waits inside — a parser-blocking script's, an import's, a sheet's — the host's
// time, which the virtual clock shows by what the model says it took, and none of the script's: `hostWait`)
export function subresourceHost(step, a, b, c, d, e, f, g) {
  switch (step) {
    case H_SW_DISPATCH:
    case H_NETWORK:
    case H_FONT_NETWORK:
    case H_FETCH:
    case H_ASSET:
    case H_SW_IMPORT:
    case H_IMPORT_NETWORK:
      return hostWait(() => obtain(step, a, b, c, d, e, f, g));
    // (…a script's fetch, made as it begins, whose time is the network's, which the event loop shows by when it lands it:
    // none of it the script's — but a parser-blocking one's, the parser waiting inside it, `H_SCRIPT_BLOCKING`: the work of
    // its request the page's time, the server's sleeps it counted none of it, the virtual clock's to show)
    case H_SCRIPT_START:
      return hostWait(() => obtain(step, a, b, c, d, e, f, g), e !== H_SCRIPT_BLOCKING);
    default:
      return obtain(step, a, b, c, d, e, f, g);
  }
}
function obtain(step, a, b, c, d, e, f, g) {
  switch (step) {
    case H_NOW: return realmHooks.performanceNow();
    case H_SW_ANSWER:
      try { return realmHooks.swFetchDest(a, b, e !== false, c, f || ''); } catch (_) { return null; }
    case H_SW_DISPATCH: return dispatchToWorker(a, b, e, f, g);
    case H_NETWORK:
      try { return hostObject.resourceTimingFetch ? hostObject.resourceTimingFetch(a, d ?? realmHooks.realmId(), b, c) : null; } catch (_) { return null; }
    case H_FILE:
      if (typeof realmHooks.recordResource === 'function') realmHooks.recordResource(a);
      return undefined;
    case H_BLOB: return resolveBlobBytes(a);
    case H_DOCUMENT: return nidOf(globalThis.document) ?? null;
    case H_FONT_BYTES: return fontFileFromBytes(a).path;
    case H_FONT_NETWORK:
      try { return hostObject.webFontFetch ? hostObject.webFontFetch(a, requestingRealm(), c, dom.subresourcePlanFields(b)[2]) : null; } catch (_) { return null; }
    case H_LOCAL_FONT:
      try { return hostObject.localFontFile ? hostObject.localFontFile(a, b) : null; } catch (_) { return null; }
    case H_FETCH:
      try { return hostObject.subresourceFetch(a, d ?? realmHooks.realmId(), b); } catch (_) { return null; }
    case H_ASSET:
      try { return hostObject.externalAsset(a, docToken(), d ?? requestingRealm(), b, c, e === true, f, g !== false); } catch (_) { return null; }
    case H_CONTROLLER: return controllerHandle() || 0;
    case H_CHARSET: return globalThis.document?.characterSet ?? '';
    case H_LINK_EVENT: {
      // (…the link where it is now — a link moved into another realm's document as its worker answered is that realm's —
      // and the event of its realm)
      const pair = nodeWhereItIs(a), el = pair[0], g = pair[1];
      if (el) fireEvent(el, new g.Event(b ? 'load' : 'error'));
      return undefined;
    }
    case H_IMAGE_START:
      try { return typeof hostObject.imageLoadStart === 'function' ? hostObject.imageLoadStart(a, c, b) | 0 : 0; } catch (_) { return 0; }
    case H_IMAGE_EVENT: {
      const el = nodeWhereItIs(a)[0];
      return el ? fireImgEvent(el, b ? 'load' : 'error', c) : undefined;
    }
    case H_VIDEO_BYTES:
      try { return hostObject.videoBytes ? hostObject.videoBytes(a, d ?? realmHooks.realmId(), b) : null; } catch (_) { return null; }
    case H_MEDIA_DONE: {
      const el = nodeWhereItIs(a)[0];
      if (el) mediaFetched(el, b, c);
      return undefined;
    }
    case H_FRAME_NAVIGATION:
      try { return reflectApply(hostObject.frameNavigationFetch, hostObject, a); } catch (_) { return null; }
    case H_LOAD_BLOCKER_SETTLED:
      realmHooks.loadBlockerSettled?.();
      return undefined;
    case H_SW_IMPORT: {
      const ctrl = realmHooks.serviceWorkerFor(a);
      return ctrl ? hostObject.swImportFetch(ctrl, a, b) || null : null;
    }
    case H_IMPORT_NETWORK:
      // (…a script's request — "fetch a classic worker-imported script" — this worker its client: fetch_request.rs
      // `importScriptRequest`)
      return hostObject.rackFetch(dom.importScriptRequest(a, b)[1], '');
    case H_LOAD_IMAGE:
      try { return takeHostBitmaps(hostObject.loadImage(a, c, b)); } catch (_) { return null; }
    case H_IMAGE_BLOB:
      realmHooks.queueMicrotask(() => {
        const el = nodeWhereItIs(a)[0];
        const doc = el && nodeDocumentOf(el);
        if (doc && defaultViewOf(doc) !== null) dom.imageBlobLoad(el, b, c, subresourceHost);
      });
      return undefined;
    case H_SW_NOTE_IMPORT:
      try { hostObject.swNoteImport(c, a, b); } catch (_) {}
      return undefined;
    case H_SCRIPT_START:
      // (…and when it began on the page's clock, as a classic script's Resource Timing entry is timed: a module graph's
      // entry's, which its graph files as it runs — Browser#take_module_rt)
      try {
        const started = realmHooks.performanceNow() - (virtualNow() - f);
        return hostObject.scriptFetchStart(a, d ?? (e ? requestingRealm() : realmHooks.realmId()), b, e ? docToken() : null, c, e === H_MODULE_GRAPH, f, g, started, e === H_SCRIPT_BLOCKING);
      } catch (_) { return null; }
    case H_SCRIPT_TAKE:
      try { return hostObject.scriptFetchTake(a, realmHooks.performanceNow()); } catch (_) { return null; }
    case H_SCRIPT_FORGET:
      try { hostObject.scriptFetchForget(a); } catch (_) {}
      return undefined;
  }
  return undefined;
}

// The node `nid` in the realm it is in now, and that realm's global.
function nodeWhereItIs(nid) {
  const realm = dom.realmOf(nid);
  const g = realm === dom.realmId ? globalThis : hostNamespace.contextGlobal(realm);
  return [engineOf(g)?.nodeOf(nid) ?? null, g];
}

// The request `token` names handed to the controlling service worker's `fetch` event — false where none controls the
// document or the URL is no http(s) one — and its answer handed to the engine as an entry reads it once its body is had
// (fetch.js `fileWorkerAnswer`; an opaque one's bytes, which an image paints, beside it), or null where the worker let
// the request through.
function dispatchToWorker(url, plan, token, integrity, accept) {
  const ctrl = serviceWorkerFor(url);
  if (!ctrl) return false;
  const resume = (answer, redirected, render) => dom.obtainResume(token, answer, redirected, render, subresourceHost);
  const answered = (resp) => fileWorkerAnswer(resp, (answer) => resume(answer, resp.redirected === true, resp.opaque_render ?? null));
  // (…hop by hop, as a fetch()'s: a redirect the worker answers with followed, the worker's again at its next hop; one it
  // lets through the network's — the request as it was made at its first, which the engine's own fetch makes, else the
  // request at the hop it let through, whose response, redirected, answers the request as a worker's answer does: its
  // entry the request's, by its first URL)
  swFetchChain(ctrl, null, dom.subresourceWorkerRequest(plan, integrity, url, accept), null, {
    network: (hop) => {
      if (hop === null) { resume(null, false, null); return; }
      let raw = null;
      try { raw = hostObject.rackFetch(hop, ''); } catch (_) {}
      if (raw) answered({ ...raw, redirected: true });
      else resume({ blocked: true }, false, null);
    },
    fail: () => resume({ blocked: true }, false, null),
    done: answered
  });
  return true;
}
