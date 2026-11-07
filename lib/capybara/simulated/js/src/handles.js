// A node's HANDLE, what Ruby names it by: its arena slot — the isolate's, so it names it apart from every other realm's
// nodes too — plus one, 0 being Ruby's "none". The engine hands the node back by it (`nodeOf`) for as long as the slot
// is the node's: a handle to a node V8 collected names nothing, never the node its slot went to next (its generation),
// and whether the node is still in the document is Ruby's to ask (`__csimAlive`). An Attr, which has no slot, has none.
// A realm answers for its own nodes only — the ones of the trees it holds (`realmOf`, which adoption moves): Ruby asks
// each realm for the nodes it found there, and a frame's form is no node of its parent's.
import { FC_LOADED, FC_NAV, FN_BUILD_QUEUED, FN_COMMIT_PENDING, FN_CONTEXT_READY, FN_LOAD_FIRED, FN_LOAD_OWED, FN_PROMPT_OWED, frameNavigationFinalized, setFrameContent, setFrameNav, supersedeFrameNavigation } from './frame-nav.js';
import { nidOf } from './node-identity.js';

export function handleOf(n) {
  return n != null && nidOf(n) >= 0 ? nidOf(n) + 1 : 0;
}
export function lookup(h) {
  if (typeof h !== 'number' || !(h > 0)) return null;
  const d = globalThis.__dom;
  return d.realmOf(h - 1) === d.realmId ? d.nodeOf(h - 1) : null;
}

// The realm a request this global makes is made as: its own — or, a worker's, the worker's, by its handle negated (the host
// names a worker so, asking no document's realm from the worker's thread).
export const requestingRealm = () => (globalThis.__csim_isWorker ? -globalThis.__dom.workerHandle() : globalThis.__csimRealmId());

// The request a request element `el` makes — a `kind` consumer's (constants.js `J_*`) — is: the realm of its node
// document, whichever realm's code inserted it (Fetch "client"), and the engine's plan of it (subresource_plan.rs
// `plan`: its mode and credentials by its `crossorigin`; its `referrerpolicy` attribute, else the policy its document
// had as it was inserted — `noteRequestPolicy`: none set then the default, whatever a later `<meta>` sets).
export function requestPlanOf(el, kind) {
  return [globalThis.__dom.realmOf(nidOf(el)), globalThis.__dom.subresourcePlan(kind, nidOf(el), nidOf(el._ownerDocument))];
}
// …and what of a plan is the request's mode and credentials (subresource_plan.rs: bits 0-3), whose answer a memo of
// one is for.
export const PLAN_REQUEST = 15;
// …and a request planned as its element's fetch was planned (`request`, `requestPlanOf`'s), made as the fetch begins:
// its client and its policy as they were then, its mode and credentials by the element's `crossorigin` now.
export function requestAsItBegins([realm, plan], el, kind) {
  return [realm, (plan & ~PLAN_REQUEST) | (globalThis.__dom.subresourcePlan(kind, nidOf(el), nidOf(el._ownerDocument)) & PLAN_REQUEST)];
}
// The document the realm has loading, by the token the host's asset memo names it with (`__csimAssetDocumentStarted`):
// what a fetch through the asset cache is made for.
let documentToken = null;
export const docToken = () => documentToken;
export function setDocToken(token) { documentToken = token; }
// …and the connect walks under way (a parser batch's, an insertion's), which a frame not yet ready in one reads none of.
let connectWalks = 0;
export function connectWalkBegin() { connectWalks++; }
export function connectWalkEnd() { connectWalks--; }
export const inConnectWalk = () => connectWalks > 0;

// A subtree taken out of its parent outside the DOM's mutation algorithms — a declarative shadow root's template, a
// document's children as it is opened or parsed again — whose steps are the engine's within them (mutation.rs
// `removing_steps`): the browsing contexts in it discarded — their unload runs script, which may take more out — then the
// removing steps, the engine's (dialogs.rs `removingSteps`) but for what the bindings do of them. The engine names the
// frames (`leavingElements`).
export function subtreeRemoved(node) {
  if (!node || !(nidOf(node) >= 0)) return;
  const frames = globalThis.__dom.leavingElements(nidOf(node), 1);
  if (frames !== undefined) for (const el of frames) discardBrowsingContext(el);
  globalThis.__dom.removingSteps(nidOf(node));
}
// The realm the active document of a frame container's navigable is in (navigables.rs), or null — none yet, or no
// container.
export function frameRealmOf(el) {
  const realm = globalThis.__dom.frameRealm(nidOf(el));
  return realm < 0 ? null : realm;
}
// The focus moved into realm `rid`'s document (navigables.rs `set_focused_realm`) — reported to the host where that
// changed the focus chain, which hands it to the service worker registry (`WindowClient.focused`).
export function focusRealm(rid) {
  if (globalThis.__dom.setFocusedRealm(rid)) focusChanged();
}
export function focusChanged() {
  const note = globalThis.__csimFocusChanged;
  if (typeof note === 'function') { try { note(); } catch (_) {} }
}
export function discardBrowsingContext(node) {
  // A nested browsing context disconnected from the DOM is discarded — real
  // browsers run no task of a detached frame's document. Drop its realm from the
  // parent's child-realm set and dispose the V8 realm so the event loop runs no
  // task of a dead frame's (whose self-rescheduling timer would otherwise keep the
  // page non-idle).
  // A re-inserted frame rebuilds its realm lazily on the next contentWindow read.
  const rid = frameRealmOf(node);
  // (…one whose document is being unloaded already — a teardown handler of its own navigation removing it — is that
  // teardown's to finish, not to begin again; one being asked whether it may be, its own `beforeunload` removing it, the
  // prompt's to destroy once its handlers are done: unload_walks.rs `end_walk`)
  if (rid != null && !globalThis.__dom.unloading(rid)) {
    // Its documents destroyed (HTML "destroy a child navigable" → "destroy a document and its descendants"): their
    // unloading cleanup steps run and their realms go, deepest first over the nested tree — and no pagehide, no unload,
    // no beforeunload, which only "unload a document" fires, on a navigation away. The spec over Chrome 151, which fires
    // the pair on `iframe.remove()` (measured 2026-08-14): insertion-removing-steps-iframe pins the spec, and the
    // keepalive WPTs whose beacon an unload handler sends after `iframe.remove()` assume Chrome's (allowlisted). One a
    // handler of a document above it removes as that one unloads — a navigation away — is one of its descendants, which
    // HTML "unload a document and its descendants" unloads before it: its pagehide and unload fire (Chrome alike).
    globalThis.__csimDisposeDiscardedFrameRealm(rid, !globalThis.__dom.ancestorUnloading(rid));
  }
  // (…its navigable destroyed after its documents: `frameElement` none from then on — and, between two documents, the
  // WindowProxies of it, kept over the last one's window, dropped with it: navigables.rs `lost`)
  if (globalThis.__dom.discardNavigable(nidOf(node)) && globalThis.__csim_lostWindowProxies) globalThis.__csim_lostWindowProxies();
  // (…so a container inserted again gets a new one, navigated afresh — its document fetched and its `load` fired, as
  // HTML's insertion steps create a child navigable and process the iframe attributes, and Chrome does; an atomic move
  // runs no removal nor insertion steps, keeping it) — and the `load` the destroyed one's navigation queued fires for
  // nothing, and its browsing context is none until that new one's post-insertion step makes it (Chrome: a script
  // inserted before it in the same batch reads a null `contentWindow` again)
  // (…and the navigation's task queued, which finds it superseded: there is no document left to ask or to leave)
  setFrameNav(node, FN_LOAD_FIRED | FN_LOAD_OWED | FN_CONTEXT_READY | FN_BUILD_QUEUED | FN_COMMIT_PENDING | FN_PROMPT_OWED, false);
  supersedeFrameNavigation(node);
  // (…a navigation planned of it dropped with it)
  globalThis.__dom.cancelFrameNavigation(nidOf(node));
  frameNavigationFinalized(node);
  // (…and the documents its navigation carried — a `javascript:` URL's not yet loaded, the one loaded last
  // — gone with it: the new one loads its `src`)
  setFrameContent(node, FC_NAV, null);
  setFrameContent(node, FC_LOADED, null);
}
