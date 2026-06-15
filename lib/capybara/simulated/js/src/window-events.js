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

import { logThrew } from './console.js';
import { EventTarget, fireWindowOnHandler, removeOnceListener } from './events.js';

// Window's three EventTarget methods ARE the shared prototype methods; they
// operate on `globalThis._listeners` (the EventTarget impl uses `this._listeners`,
// and `this` is the global here). `dispatchEvent` flat-fires those listeners and
// then the window IDL on-handler (gated to the global inside EventTarget).
globalThis.addEventListener    = EventTarget.prototype.addEventListener;
globalThis.removeEventListener = EventTarget.prototype.removeEventListener;
globalThis.dispatchEvent       = EventTarget.prototype.dispatchEvent;

// Returns true iff at least one listener ran — mirrors fireListeners in
// dispatch.js so the user-action dispatch path can skip its microtask
// checkpoint when nothing fired.
export function fireWindowListeners(event, capture) {
  const list = globalThis._listeners && globalThis._listeners[event.type];
  const hasIdlHandler = !capture && typeof globalThis['on' + event.type] === 'function';
  if ((!list || !list.length) && !hasIdlHandler) return false;
  event.currentTarget = globalThis;
  let fired = false;
  if (list) {
    for (const entry of list.slice()) {
      if (!!entry.capture !== !!capture) continue;
      if (entry.removed) continue;   // removed after this dispatch's snapshot → skip
      if (event._propagationStopped) return fired;
      // `once`: remove before invoking so a re-dispatching callback won't re-enter it.
      if (entry.once) removeOnceListener(entry, globalThis._listeners[event.type]);
      event._inPassiveListener = !!entry.passive;   // passive → preventDefault is a no-op
      try {
        if (entry.isObject) {
          const cb = entry.handler.handleEvent;
          if (typeof cb === 'function') { cb.call(entry.handler, event); fired = true; }
        } else {
          entry.handler.call(globalThis, event); fired = true;
        }
      } catch (e) { logThrew('window listener', e); }
      finally { event._inPassiveListener = false; }
    }
  }
  // The event-handler IDL attribute (window.onload/body.onload) fires as a
  // bubble-phase listener — only in the non-capture pass.
  if (!capture && !event._propagationStopped && fireWindowOnHandler(event)) fired = true;
  return fired;
}

// Read-only view of window-level listeners (with their resolved passive flags),
// exposed for the WPT testdriver shim. Returns plain descriptors, never the live
// entries.
globalThis.__csimWindowListenersFor = function (type) {
  const list = globalThis._listeners && globalThis._listeners[type];
  return list ? list.map(l => ({ passive: !!l.passive, capture: !!l.capture })) : [];
};
