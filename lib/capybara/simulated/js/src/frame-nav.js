import { nidOf } from './node-identity.js';
// A frame container's navigation as it goes — the engine's (frame_navigation.rs), keyed by the container: where its
// navigation is, which of them is its latest, and the URLs one carries. What each flag means:
// The element's `load` for the navigation under way is fired or queued (`maybeFireFrameLoad`): a reconnect fires no other.
export const FN_LOAD_FIRED       = 1 << 0;
// (1 << 1 free)
// The frame's old document stays its own until the new one's response is in, the build that takes it unloading it
// (`renavigateFrame`, `__csimCommitFrameNavigation`), on the navigation's task (timers.rs `BEHIND`).
export const FN_COMMIT_PENDING   = 1 << 2;
// The build is parked on a service worker still activating, no `load` owed until it runs again.
export const FN_DEFERRED_SW      = 1 << 3;
// The build is under way — set and cleared by it alone (unload_walks.rs `frameBuildBegin`).
export const FN_BUILDING         = 1 << 4;
// The navigation is a reload (`isReloadNavigation`).
export const FN_RELOAD_NAV       = 1 << 5;
// The container's post-insertion step ran: its browsing context exists, so `contentWindow` answers one even inside the
// connect walk that inserted it.
export const FN_CONTEXT_READY    = 1 << 6;
// Its `src` was refused as its attributes were last processed — a document above it (frame_navigation.rs `process_src`):
// a build of it loads its initial document, until a navigation of it begins.
export const FN_SRC_REFUSED      = 1 << 7;
// The element's `load` for the navigation under way is queued and not fired yet, its document's own load delaying it or
// not: it delays the container's document's load until it fires (frame_navigation.rs `load_delayed_here`).
export const FN_LOAD_OWED        = 1 << 8;
// The element's `load` is being dispatched (HTML "iframe load event steps": its "iframe load in progress" flag) — a
// `document.open()` of its document from a listener mutes the load the written document would fire at it.
export const FN_LOAD_IN_PROGRESS = 1 << 9;
// The navigation's document is built on a task that has not run yet (`maybeFireFrameLoad`): HTML navigates a frame in
// parallel with its container's document, so a read of its window meanwhile is answered with its initial about:blank
// document's, made then — the build commits over it (`__csimFrameWindow`).
export const FN_BUILD_QUEUED     = 1 << 10;
// (1 << 11: its window read with its navigation under way — the engine's own, frame_navigation.rs `frameWindowRead`)
// Its document is still to be asked whether it may be unloaded: HTML "navigate" asks in parallel with the task that began
// it, here the navigation's own task, before anything is fetched (`__csimFramePrompted`).
export const FN_PROMPT_OWED      = 1 << 12;
// The session history entry it pushes as it commits replaces the current one instead (`FN_URL_HISTORY`).
export const FN_HISTORY_REPLACE  = 1 << 13;

export const frameNavHas = (el, flags) => (globalThis.__dom.frameNav(nidOf(el)) & flags) !== 0;
export const setFrameNav = (el, flags, on) => globalThis.__dom.setFrameNav(nidOf(el), flags, on);

// A navigation of the container's begun — its child navigable's ongoing one (session_history.rs `begin_navigation_of`) —
// and the one under way superseded: the `load` it owed with it, and the container's document's own load, which that
// delayed, asked about again (bridge.entry.js `__csimLoadBlockerSettled`, which looks on a task: the superseding
// navigation owes its own by then).
export function supersedeFrameNavigation(el) {
  globalThis.__dom.supersedeFrameNav(nidOf(el));
  globalThis.__csimLoadBlockerSettled?.();
}

// The URLs a navigation carries: the one it started with (the `src` attribute then, null where it had none), the
// session history entry it pushes as it commits, the document URL a reload keeps — undefined where it carries none.
export const FN_URL_SRC     = 0;
export const FN_URL_HISTORY = 1;
export const FN_URL_RELOAD  = 2;
export const frameNavUrl     = (el, slot) => globalThis.__dom.frameNavUrl(nidOf(el), slot, false);
export const takeFrameNavUrl = (el, slot) => globalThis.__dom.frameNavUrl(nidOf(el), slot, true);
export const setFrameNavUrl  = (el, slot, url) => globalThis.__dom.setFrameNavUrl(nidOf(el), slot, url);

// The documents a navigation carries as bytes — `{url, bytes, contentType}`, null for none: a `javascript:` URL's the
// build loads (`FC_NAV`, taken as it does), the one it loaded last, which a reload of a revoked blob: URL
// loads again (`FC_LOADED`), and a blob: URL's a `location` navigation took a reference to before the page could revoke
// it (`FC_PENDING_BLOB`).
export const FC_NAV          = 0;
export const FC_LOADED       = 1;
export const FC_PENDING_BLOB = 2;
const contentOf = (answer) => answer === null ? null : { url: answer[0], bytes: answer[1], contentType: answer[2], referrer: answer[3] || null, policy: answer[4] || null };
export const frameContentHeld = (el, slot) => globalThis.__dom.frameContentHeld(nidOf(el), slot);
export const frameContentUrl  = (el, slot) => globalThis.__dom.frameContentUrl(nidOf(el), slot);
// (…one slot's document carried in another too — its bytes copied where they lie — or, `take`, moved there)
export const copyFrameContent = (el, from, to, take = false) => globalThis.__dom.copyFrameContent(nidOf(el), from, to, take);
export const frameContent     = (el, slot) => contentOf(globalThis.__dom.frameContent(nidOf(el), slot, false));
export const takeFrameContent = (el, slot) => contentOf(globalThis.__dom.frameContent(nidOf(el), slot, true));
export const setFrameContent  = (el, slot, content) => content === null
  ? globalThis.__dom.setFrameContent(nidOf(el), slot)
  : globalThis.__dom.setFrameContent(nidOf(el), slot, content.url, content.bytes, content.contentType, content.referrer, content.policy);

// HTML "finalize a cross-document navigation" of container `el`'s navigable — its planned navigation taken (the document
// it made delaying the load by its own from there, or none: a 204, a download, a failure), landed, or cancelled: where
// its navigable delays its document's load no more (the engine's: frame_navigation.rs `frameNavigationFinalized`), that
// document's load asked about again, in its own realm.
export function frameNavigationFinalized(el) {
  if (!el) return;
  const realm = globalThis.__dom.frameNavigationFinalized(nidOf(el));
  if (realm < 0) return;
  let g = null;
  try { g = globalThis.RustyRacer.contextGlobal(realm); } catch (_) {}
  g?.__csimLoadBlockerSettled?.();
}
globalThis.__csimFrameNavigationFinalized = frameNavigationFinalized;
