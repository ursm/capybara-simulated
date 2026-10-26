// A node's HANDLE, what Ruby names it by: its arena slot — the isolate's, so it names it apart from every other realm's
// nodes too — plus one, 0 being Ruby's "none". The engine hands the node back by it (`nodeOf`) for as long as the slot
// is the node's: a handle to a node V8 collected names nothing, never the node its slot went to next (its generation),
// and whether the node is still in the document is Ruby's to ask (`__csimAlive`). An Attr, which has no slot, has none.
// A realm answers for its own nodes only — the ones of the trees it holds (`realmOf`, which adoption moves): Ruby asks
// each realm for the nodes it found there, and a frame's form is no node of its parent's.
import { FC_LOADED, FC_NAV, FN_CONTEXT_READY, FN_LOAD_FIRED, FN_LOAD_OWED, FN_NAV_PENDING, setFrameContent, setFrameNav, supersedeFrameNavigation } from './frame-nav.js';

export function handleOf(n) {
  return n != null && n._nid >= 0 ? n._nid + 1 : 0;
}
export function lookup(h) {
  if (typeof h !== 'number' || !(h > 0)) return null;
  const d = globalThis.__dom;
  return d.realmOf(h - 1) === d.realmId ? d.nodeOf(h - 1) : null;
}

// The realm a request this global makes is made as: its own — or, a worker's, the worker's, by its handle negated (the host
// names a worker so, asking no document's realm from the worker's thread).
export const requestingRealm = () => (globalThis.__csim_isWorker ? -(globalThis.__csimWorkerHandle | 0) : globalThis.__csimRealmId());

// The request a request element `el` makes — a `kind` consumer's (constants.js `J_*`) — is: the realm of its node
// document, whichever realm's code inserted it (Fetch "client"), and the engine's plan of it (subresource_plan.rs
// `plan`: its mode and credentials by its `crossorigin`; its `referrerpolicy` attribute, else the policy its document
// had as it was inserted — `noteRequestPolicy`: none set then the default, whatever a later `<meta>` sets).
export function requestPlanOf(el, kind) {
  return [globalThis.__dom.realmOf(el._nid), globalThis.__dom.subresourcePlan(kind, el._nid, el._ownerDocument?._nid)];
}
// …and what of a plan is the request's mode and credentials (subresource_plan.rs: bits 0-3), whose answer a memo of
// one is for.
export const PLAN_REQUEST = 15;
// …and a request planned as its element's fetch was planned (`request`, `requestPlanOf`'s), made as the fetch begins:
// its client and its policy as they were then, its mode and credentials by the element's `crossorigin` now.
export function requestAsItBegins([realm, plan], el, kind) {
  return [realm, (plan & ~PLAN_REQUEST) | (globalThis.__dom.subresourcePlan(kind, el._nid, el._ownerDocument?._nid) & PLAN_REQUEST)];
}
// …and a load the host makes for `el` — an image's, a video's — as the host takes it: this realm, which makes it, and
// the engine's plan of it, whose opaque bit is this realm's, told here, as the host cannot ask a frame still parsing
// the document the element is in.
export function loadPlanOf(el, kind) {
  return [globalThis.__csimRealmId(), globalThis.__dom.subresourcePlan(kind, el._nid, el._ownerDocument?._nid)];
}
// …and a style sheet owner's fetch of `url` through the asset cache (`__csimExternalAsset`, `destination` its
// request's), its request `requestPlanOf` the owner's — its response, [text, null where it failed; the facts of the
// response; its bytes] — made once for the sheet it obtains where it failed: the asset cache keeps a document's
// responses, never a failed one (Chrome's memory cache keeps no error: a link inserted again fetches it again), so the
// readers of one sheet's fetch — a `<link>`'s cascade, `.sheet` and load task — share its failure here, the response it
// was, until the owner obtains another (sheet_owners.rs `renew_sheet`: connected again, its `href` set).
const FAILED_FETCHES = new WeakMap();
export function sheetAsset(owner, url, [realm, plan], destination) {
  const request = `${globalThis.__dom.sheetGen(owner._nid)} ${destination} ${plan & PLAN_REQUEST} ${url}`;
  const failed = FAILED_FETCHES.get(owner);
  if (failed?.request === request) return failed.response;
  const response = globalThis.__csimExternalAsset(url, globalThis.__csimDocToken, realm, plan, destination);
  if (response == null || response[0] == null) FAILED_FETCHES.set(owner, { request, response });
  return response;
}

// A preload whose fetch is planned but yet to run, its entry in its document's map pending (preload_map.rs `preloadBegin`):
// `run` its fetch, which commits the response — kept by the token the entry names, for a consumer that comes first.
const pendingPreloads = new Map();
let preloadTokens = 0;
export function preloadPending(doc, url, destination, plan, integrity, run) {
  const token = ++preloadTokens;
  pendingPreloads.set(token, run);
  globalThis.__dom.preloadBegin(doc, url, destination, plan, integrity, token);
  return token;
}
// …its fetch run, by its link's task or by a consumer: the token no longer wanted.
export function preloadRan(token) {
  pendingPreloads.delete(token);
}
// …and one withdrawn before it ran, its entry with it.
export function preloadWithdrawn(doc, url, destination, plan, token) {
  if (pendingPreloads.delete(token)) globalThis.__dom.preloadWithdraw(doc, url, destination, plan, token);
}
// What a request of `doc` — `url`, its `destination`, its `plan`'s mode and credentials mode, its `integrity` — takes of
// a preload (Fetch "fetch": "consume a preloaded resource"): the response the preload had, null for a network error,
// undefined where none matches; a preload whose fetch is yet to run running it now, the response the consumer waits
// for.
export function consumePreload(doc, url, destination, plan, integrity) {
  const taken = globalThis.__dom.preloadConsume(doc, url, destination, plan, integrity);
  if (typeof taken !== 'number') return taken;
  const run = pendingPreloads.get(taken);
  pendingPreloads.delete(taken);
  run?.();
  const had = globalThis.__dom.preloadConsume(doc, url, destination, plan, integrity);
  return typeof had === 'number' ? undefined : had;
}
// …and its request's integrity metadata, as the owner obtains the sheet (`sheetGen`: its `integrity` then, whatever
// it is set to after — a change of it no trigger to fetch again), with the verdicts on its response the cascade keeps,
// by what answered, so a rebuild hashes it no more.
const SHEET_REQUESTS = new WeakMap();
export function sheetRequestOf(owner) {
  const gen = globalThis.__dom.sheetGen(owner._nid);
  let request = SHEET_REQUESTS.get(owner);
  if (request?.gen !== gen) SHEET_REQUESTS.set(owner, request = { gen, integrity: owner._attrs.integrity || '', verdicts: new Map() });
  return request;
}
// …and the preload its request takes first, its owner's (Fetch "fetch": "consume a preloaded resource", preload_map.rs):
// the response the preload had, null for a network error, undefined where none matched — taken once for the sheet it
// obtains, so its every reader has the one response, until the owner obtains another.
const SHEET_PRELOADS = new WeakMap();
export function sheetPreload(owner, url, plan) {
  const request = `${globalThis.__dom.sheetGen(owner._nid)} ${plan & PLAN_REQUEST} ${url}`;
  const kept = SHEET_PRELOADS.get(owner);
  if (kept?.request === request) return kept.response;
  const response = consumePreload(owner._ownerDocument._nid, url, 'style', plan, sheetRequestOf(owner).integrity);
  if (response !== undefined) SHEET_PRELOADS.set(owner, { request, response });
  return response;
}

// What the bindings do of the removing steps (dom-nodes.js sets it — a setter, as handles.js imports no node module): the
// style state moved where the engine's steps changed an element's (`removingSteps`: a popover hidden, a dialog modal no
// more, the focused or hovered element gone with the subtree).
let removingSteps = null;
export function setRemovingSteps(fn) { removingSteps = fn; }

// A subtree taken out of its parent outside the DOM's mutation algorithms — a declarative shadow root's template, a
// document's children as it is opened or parsed again — whose steps are the engine's within them (mutation.rs
// `removing_steps`): the browsing contexts in it discarded — their unload runs script, which may take more out — then the
// removing steps, the engine's (dialogs.rs `removingSteps`) but for what the bindings do of them. The engine names the
// frames (`leavingElements`).
export function subtreeRemoved(node) {
  if (!node || !(node._nid >= 0)) return;
  const frames = globalThis.__dom.leavingElements(node._nid, 1);
  if (frames !== undefined) for (const el of frames) discardBrowsingContext(el);
  if (globalThis.__dom.removingSteps(node._nid) && removingSteps) removingSteps();
}
// The realm the active document of a frame container's navigable is in (navigables.rs), or null — none yet, or no
// container.
export function frameRealmOf(el) {
  const realm = globalThis.__dom.frameRealm(el._nid);
  return realm < 0 ? null : realm;
}
export function discardBrowsingContext(node) {
  // A nested browsing context disconnected from the DOM is discarded — real
  // browsers halt a detached frame's event loop. Drop its realm from the parent's
  // step set and dispose the V8 realm so `drainChildRealms` stops stepping a dead
  // frame (whose self-rescheduling timer would otherwise keep the page non-idle).
  // A re-inserted frame rebuilds its realm lazily on the next contentWindow read.
  const rid = frameRealmOf(node);
  // (…one whose document is being unloaded already — a teardown handler of its own navigation removing it — is that
  // teardown's to finish, not to begin again)
  if (rid != null && !globalThis.__dom.unloading(rid)) {
    // Its documents destroyed (HTML "destroy a child navigable" → "destroy a document and its descendants"): their
    // unloading cleanup steps run and their realms go, parent first over the nested tree — and no pagehide, no unload,
    // no beforeunload, which only "unload a document" fires, on a navigation away. The spec over Chrome 151, which fires
    // the pair on `iframe.remove()` (measured 2026-08-14): insertion-removing-steps-iframe pins the spec, and the
    // keepalive WPTs whose beacon an unload handler sends after `iframe.remove()` assume Chrome's (allowlisted). One a
    // handler of a document above it removes as that one unloads — a navigation away — is one of its descendants, which
    // HTML "unload a document and its descendants" unloads before it: its pagehide and unload fire (Chrome alike).
    globalThis.__csimDisposeDiscardedFrameRealm(rid, !globalThis.__dom.ancestorUnloading(rid));
  }
  // (…its navigable destroyed after its documents: `frameElement` none from then on — and, between two documents, the
  // WindowProxies of it, kept over the last one's window, dropped with it: navigables.rs `lost`)
  if (globalThis.__dom.discardNavigable(node._nid) && globalThis.__csim_lostWindowProxies) globalThis.__csim_lostWindowProxies();
  // (…so a container inserted again gets a new one, navigated afresh — its document fetched and its `load` fired, as
  // HTML's insertion steps create a child navigable and process the iframe attributes, and Chrome does; an atomic move
  // runs no removal nor insertion steps, keeping it) — and the `load` the destroyed one's navigation queued fires for
  // nothing, and its browsing context is none until that new one's post-insertion step makes it (Chrome: a script
  // inserted before it in the same batch reads a null `contentWindow` again)
  // (…a scripted navigation's pending load too, its plan cancelled below: the new navigable's own load is to fire)
  setFrameNav(node, FN_LOAD_FIRED | FN_LOAD_OWED | FN_CONTEXT_READY | FN_NAV_PENDING, false);
  supersedeFrameNavigation(node);
  // (…a form submission it planned to navigate to dropped with it: its response lands nowhere)
  globalThis.__dom.cancelFrameNavigation(node._nid);
  // (…and the documents its navigation carried — a scripted navigation's response not yet loaded, the one loaded last
  // — gone with it: the new one loads its `src`)
  setFrameContent(node, FC_NAV, null);
  setFrameContent(node, FC_LOADED, null);
}
