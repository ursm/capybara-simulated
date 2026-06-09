// Make `globalThis` (== window) listenable. Libraries register
// `window.addEventListener('DOMContentLoaded', …)` /
// `window.addEventListener('load', …)` / Turbo's window-capture
// `click` interceptor — without these, every such call throws
// "addEventListener is not a function" and the listener chain dies.
//
// `fireWindowListeners(event, capture)` is also called from the
// element-dispatch walk in bridge.entry.js so window-registered
// listeners participate in the capture and bubble phases of an
// element dispatch — Turbo's LinkClickObserver registers at window
// with `{capture: true}` so a `link.click()` reaches it before
// document-level handlers.

import { logThrew } from './console.js';
import { defaultPassiveValue, removeOnceListener } from './events.js';

const windowListeners = Object.create(null);

// Invoke the Window's event-handler IDL attribute (`window.onhashchange`,
// `window.onpopstate`, `window.onload` — the last also reflected by
// `body.onload`) for this event. HTML treats it as a bubble-phase listener, so
// it runs in the non-capture pass after addEventListener listeners. Reading
// `globalThis['on' + type]` uniformly covers BOTH the body-reflected forwarded
// handlers (whose globalThis accessor reads the shared winStore) and the
// window-only handlers (hashchange / popstate / message / …) that live as plain
// properties — the latter were previously never fired on a dispatched event.
function fireWindowOnHandler(event) {
  const h = globalThis['on' + event.type];
  if (typeof h !== 'function') return false;
  try {
    // `window.onerror` is an OnErrorEventHandler: for an ErrorEvent it takes the
    // legacy 5-arg form (message, source, lineno, colno, error) — NOT the event
    // object — and a truthy return cancels (handled). Every other forwarded
    // handler is a normal EventHandler taking the event.
    if (event.type === 'error' && typeof globalThis.ErrorEvent === 'function' &&
        event instanceof globalThis.ErrorEvent) {
      const handled = h.call(globalThis, event.message, event.filename, event.lineno, event.colno, event.error);
      if (handled === true && event.cancelable) event.defaultPrevented = true;
    } else {
      h.call(globalThis, event);
    }
  } catch (e) { logThrew('window on-handler', e); }
  return true;
}

// Returns true iff at least one listener ran — mirrors fireListeners
// in dispatch.js so the user-action dispatch path can skip its
// microtask checkpoint when nothing fired.
export function fireWindowListeners(event, capture) {
  const list = windowListeners[event.type];
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
      if (entry.once) removeOnceListener(entry, windowListeners[event.type]);
      event._inPassiveListener = !!entry.passive;   // passive → preventDefault is a no-op
      try { entry.handler.call(globalThis, event); fired = true; }
      catch (e) { logThrew('window listener', e); }
      finally { event._inPassiveListener = false; }
    }
  }
  // The event-handler IDL attribute (window.onload/body.onload) fires as a
  // bubble-phase listener — only in the non-capture pass.
  if (!capture && !event._propagationStopped && fireWindowOnHandler(event)) fired = true;
  return fired;
}

globalThis.addEventListener = function (type, handler, options) {
  if (typeof handler !== 'function') return;
  const capture = !!(options && (options === true || options.capture));
  const passive = (options && typeof options === 'object' && options.passive !== undefined)
    ? !!options.passive
    : defaultPassiveValue(type, globalThis);
  const once = !!(options && typeof options === 'object' && options.once);
  const list = windowListeners[type] || (windowListeners[type] = []);
  if (list.some(l => l.handler === handler && l.capture === capture)) return;
  list.push({ handler, capture, passive, once });
};

globalThis.removeEventListener = function (type, handler, options) {
  const list = windowListeners[type];
  if (!list) return;
  const capture = !!(options && (options === true || options.capture));
  windowListeners[type] = list.filter(l => {
    const isMatch = l.handler === handler && l.capture === capture;
    if (isMatch) l.removed = true;   // in-flight dispatch snapshot must skip it
    return !isMatch;
  });
};

globalThis.dispatchEvent = function (event) {
  const list = windowListeners[event.type];
  if (list && list.length) {
    for (const entry of list.slice()) {
      if (entry.removed) continue;   // removed after this dispatch's snapshot → skip
      if (entry.once) removeOnceListener(entry, windowListeners[event.type]);
      event._inPassiveListener = !!entry.passive;   // passive → preventDefault is a no-op
      try { entry.handler.call(globalThis, event); }
      catch (e) { logThrew('window listener', e); }
      finally { event._inPassiveListener = false; }
    }
  }
  // The event-handler IDL attribute (window.onload / body.onload) fires too.
  fireWindowOnHandler(event);
  return !event.defaultPrevented;
};

// Read-only view of window-level listeners (with their resolved passive flags),
// exposed for the WPT testdriver shim. `windowListeners` is module-private, so
// page JS has no other way to (a) compute cancelable-when-passive for a gesture
// whose only listener is on the window, or (b) know a synthesized event must
// reach a window listener. Returns plain descriptors, never the live entries.
globalThis.__csimWindowListenersFor = function (type) {
  const list = windowListeners[type];
  return list ? list.map(l => ({ passive: !!l.passive, capture: !!l.capture })) : [];
};
