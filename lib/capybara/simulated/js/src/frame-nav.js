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
// A navigation made from the frame's own `load` dispatch waits for a task, which is queued.
export const FN_NAV_TASK         = 1 << 6;
// The frame's element `load` is being dispatched.
export const FN_LOAD_DISPATCHING = 1 << 7;

export const frameNavHas = (el, flags) => (globalThis.__dom.frameNav(el._nid) & flags) !== 0;
export const setFrameNav = (el, flags, on) => globalThis.__dom.setFrameNav(el._nid, flags, on);

// Which navigation of the container's is its latest — a load another one queued fires for nothing — and the one under
// way superseded.
export const frameNavGeneration = (el) => globalThis.__dom.frameNavGeneration(el._nid);
export const supersedeFrameNavigation = (el) => globalThis.__dom.supersedeFrameNav(el._nid);

// The URLs a navigation carries: the one it started with (the `src` attribute then, null where it had none), the
// session history entry it pushes as it commits, the document URL a reload keeps — undefined where it carries none.
export const FN_URL_SRC     = 0;
export const FN_URL_HISTORY = 1;
export const FN_URL_RELOAD  = 2;
export const frameNavUrl     = (el, slot) => globalThis.__dom.frameNavUrl(el._nid, slot, false);
export const takeFrameNavUrl = (el, slot) => globalThis.__dom.frameNavUrl(el._nid, slot, true);
export const setFrameNavUrl  = (el, slot, url) => globalThis.__dom.setFrameNavUrl(el._nid, slot, url);
