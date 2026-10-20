// `globalThis` (== window) is an EventTarget: its prototype chain reaches `EventTarget.prototype` (window.js
// `prepareWindowInterface`), so `window.addEventListener === EventTarget.prototype.addEventListener` (WPT
// dom/window-extends-event-target) and its listeners land in the store the DOM walker reads (`listenersOf`) (`this` the
// global; a bare `addEventListener(…)` too, the binding taking an undefined receiver for it). Libraries register `window.addEventListener(
// 'DOMContentLoaded' | 'load' | …)` and Turbo registers its window-capture
// `click` interceptor here.
//
// `fireWindowListeners(event, capture)` is called from the element-dispatch walk
// (dispatch.js) so window-registered listeners participate in the capture and
// bubble phases of an element dispatch — Turbo's LinkClickObserver registers at
// window with `{capture: true}` so a `link.click()` reaches it before
// document-level handlers.

import { eventState, invokeEntries, listenersOf, perRealmCurrentEvent } from './events.js';

// The window's listeners of one pass (`capture`) in an element dispatch's walk; `perRealm` the walk's
// `perRealmCurrentEvent()`, asked here where another realm's walk calls this one's.
export function fireWindowListeners(event, capture, perRealm = perRealmCurrentEvent()) {
  const state = eventState(event);
  const store = listenersOf(globalThis);
  if (!store?.[state.type]?.length) return;
  // (…none where propagation was stopped before the window's turn — DOM "invoke" step 1, a flag set before dispatch
  // included; within its turn, stopImmediatePropagation() alone ends it)
  if (state.propagationStopped) return;
  state.currentTarget = globalThis;
  // (…each called as the flat dispatch calls them: `invokeEntries`; the window is in no shadow tree)
  invokeEntries(state, event, store, !!capture, globalThis, perRealm, false);
}

// …for a dispatch another realm runs over this window's document (a node adopted into it keeps its realm's methods).
globalThis.__csimFireWindowListeners = fireWindowListeners;

// Read-only view of window-level listeners (with their resolved passive flags),
// exposed for the WPT testdriver shim. Returns plain descriptors, never the live
// entries.
globalThis.__csimWindowListenersFor = function (type) {
  const list = listenersOf(globalThis)?.[type];
  return list ? list.map(l => ({ passive: !!l.passive, capture: !!l.capture })) : [];
};
