// Make `globalThis` (== window) a real EventTarget. Window uses the SHARED
// `EventTarget` listener implementation (events.js) — its `addEventListener` /
// `removeEventListener` / `dispatchEvent` ARE `EventTarget.prototype`'s methods,
// so `window.addEventListener === EventTarget.prototype.addEventListener` (WPT
// dom/window-extends-event-target) and listeners land in the same `_listeners`
// store the DOM walker reads. Libraries register `window.addEventListener(
// 'DOMContentLoaded' | 'load' | …)` and Turbo registers its window-capture
// `click` interceptor here.
//
// `fireWindowListeners(event, capture)` is called from the element-dispatch walk
// (dispatch.js) so window-registered listeners participate in the capture and
// bubble phases of an element dispatch — Turbo's LinkClickObserver registers at
// window with `{capture: true}` so a `link.click()` reaches it before
// document-level handlers.

import { EventTarget, invokeWithCurrentEvent, perRealmCurrentEvent, removeOnceListener, eventState } from './events.js';

// Window's three EventTarget methods ARE the shared prototype methods; they
// operate on `globalThis._listeners` (the EventTarget impl uses `this._listeners`,
// and `this` is the global here). `dispatchEvent` flat-fires those listeners and
// its event handlers among them (window.js), registered listeners as an element's are.
globalThis.addEventListener    = EventTarget.prototype.addEventListener;
globalThis.removeEventListener = EventTarget.prototype.removeEventListener;
globalThis.dispatchEvent       = EventTarget.prototype.dispatchEvent;

// Returns true iff at least one listener ran — mirrors fireListeners in
// dispatch.js so the user-action dispatch path can skip its microtask
// checkpoint when nothing fired.
export function fireWindowListeners(event, capture) {
  const state = eventState(event);
  const list = globalThis._listeners && globalThis._listeners[state.type];
  if (!list || !list.length) return false;
  state.currentTarget = globalThis;
  // (…each called as the flat dispatch calls them: a throw reported, `window.event` the listener's realm's on a page of
  // several realms — an event handler's its function's)
  const perRealm = perRealmCurrentEvent();
  let fired = false;
  for (const entry of list.slice()) {
    if (!!entry.capture !== !!capture) continue;
    if (entry.removed) continue;   // removed after this dispatch's snapshot → skip
    if (state.propagationStopped) return fired;
    // `once`: remove before invoking so a re-dispatching callback won't re-enter it.
    if (entry.once) removeOnceListener(entry, globalThis._listeners[state.type]);
    state.inPassiveListener = !!entry.passive;   // passive → preventDefault is a no-op
    invokeWithCurrentEvent(perRealm, entry.handler, entry.isObject, entry.isObject ? entry.handler : globalThis, event);
    state.inPassiveListener = false;
    fired = true;
  }
  return fired;
}

// …for a dispatch another realm runs over this window's document (a node adopted into it keeps its realm's methods).
globalThis.__csimFireWindowListeners = fireWindowListeners;

// Read-only view of window-level listeners (with their resolved passive flags),
// exposed for the WPT testdriver shim. Returns plain descriptors, never the live
// entries.
globalThis.__csimWindowListenersFor = function (type) {
  const list = globalThis._listeners && globalThis._listeners[type];
  return list ? list.map(l => ({ passive: !!l.passive, capture: !!l.capture })) : [];
};
