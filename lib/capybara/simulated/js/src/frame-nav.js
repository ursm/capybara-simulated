// A frame container's navigation as it goes — the engine's (frame_navigation.rs), keyed by the container: where its
// navigation is, which of them is its latest, and the URLs one carries. What each flag means:
// The element's `load` for the navigation under way is fired or queued (`maybeFireFrameLoad`): a reconnect fires no other.
export const FN_LOAD_FIRED       = 1 << 0;
// A scripted navigation's response is awaited (a form submitted into the frame): the initial load it supersedes fires
// no `load`.
export const FN_NAV_PENDING      = 1 << 1;
// The frame's old document stays its own until the new one's response is in, the build that takes it unloading it
// (`_renavigateFrameDocument`, `__csimCommitFrameNavigation`).
export const FN_COMMIT_PENDING   = 1 << 2;
// The build is parked on a service worker still activating, no `load` owed until it runs again.
export const FN_DEFERRED_SW      = 1 << 3;
// The build is under way: a read of the frame's window it makes is answered with none.
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
// not: it delays the container's document's load until it fires (`__dom.frameLoadsOwed`).
export const FN_LOAD_OWED        = 1 << 8;

export const frameNavHas = (el, flags) => (globalThis.__dom.frameNav(el._nid) & flags) !== 0;
export const setFrameNav = (el, flags, on) => globalThis.__dom.setFrameNav(el._nid, flags, on);

// Which navigation of the container's is its latest — a load another one queued fires for nothing — and the one under
// way superseded: the `load` it owed with it, and the container's document's own load, which that delayed, asked about
// again (bridge.entry.js `__csimLoadBlockerSettled`, which looks on a task: the superseding navigation owes its own by
// then).
export const frameNavGeneration = (el) => globalThis.__dom.frameNavGeneration(el._nid);
export function supersedeFrameNavigation(el) {
  globalThis.__dom.supersedeFrameNav(el._nid);
  globalThis.__csimLoadBlockerSettled?.();
}

// The navigable a target name chooses from a realm's browsing context, as `__csimFindNamedFrame` answers it
// (navigables.rs `findNavigable`): a frame's realm, or NO_NAVIGABLE (none has the name), NAVIGATION_BLOCKED (one the
// document's sandbox does not let it navigate) or TOP_NAVIGABLE (its top-level traversable).
export const NO_NAVIGABLE = 0, NAVIGATION_BLOCKED = -1, TOP_NAVIGABLE = -2;

// The URLs a navigation carries: the one it started with (the `src` attribute then, null where it had none), the
// session history entry it pushes as it commits, the document URL a reload keeps — undefined where it carries none.
export const FN_URL_SRC     = 0;
export const FN_URL_HISTORY = 1;
export const FN_URL_RELOAD  = 2;
export const frameNavUrl     = (el, slot) => globalThis.__dom.frameNavUrl(el._nid, slot, false);
export const takeFrameNavUrl = (el, slot) => globalThis.__dom.frameNavUrl(el._nid, slot, true);
export const setFrameNavUrl  = (el, slot, url) => globalThis.__dom.setFrameNavUrl(el._nid, slot, url);

// When the element's last `load` fired, on the virtual clock (-Infinity for none): a navigation begun at that same
// instant waits a nested-timer clamp (`FRAME_NAV_PACE_MS`), so a frame its load handler navigates again on every load —
// re-inserted, moved, re-pointed from a task — is paced as a network's response paces it (Chrome: ~100 loads a second)
// instead of running without the clock moving, a realm built for every turn.
export const FRAME_NAV_PACE_MS = 4;
export const frameLoadedAt = (el) => globalThis.__dom.frameLoadedAt(el._nid);
export const setFrameLoadedAt = (el, time) => globalThis.__dom.setFrameLoadedAt(el._nid, time);

// The documents a navigation carries as bytes — `{url, bytes, contentType}`, null for none: a scripted navigation's
// response the build loads (`FC_NAV`, taken as it does), the one it loaded last, which a reload of a revoked blob: URL
// loads again (`FC_LOADED`), and a blob: URL's a `location` navigation took a reference to before the page could revoke
// it (`FC_PENDING_BLOB`).
export const FC_NAV          = 0;
export const FC_LOADED       = 1;
export const FC_PENDING_BLOB = 2;
const contentOf = (answer) => answer === null ? null : { url: answer[0], bytes: answer[1], contentType: answer[2] };
export const frameContentHeld = (el, slot) => globalThis.__dom.frameContentHeld(el._nid, slot);
export const frameContentUrl  = (el, slot) => globalThis.__dom.frameContentUrl(el._nid, slot);
// (…one slot's document carried in another too — its bytes copied where they lie — or, `take`, moved there)
export const copyFrameContent = (el, from, to, take = false) => globalThis.__dom.copyFrameContent(el._nid, from, to, take);
export const frameContent     = (el, slot) => contentOf(globalThis.__dom.frameContent(el._nid, slot, false));
export const takeFrameContent = (el, slot) => contentOf(globalThis.__dom.frameContent(el._nid, slot, true));
export const setFrameContent  = (el, slot, content) => content === null
  ? globalThis.__dom.setFrameContent(el._nid, slot)
  : globalThis.__dom.setFrameContent(el._nid, slot, content.url, content.bytes, content.contentType);
