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
import { defaultPassiveValue } from './events.js';

const windowListeners = Object.create(null);

// Returns true iff at least one listener ran — mirrors fireListeners
// in dispatch.js so the user-action dispatch path can skip its
// microtask checkpoint when nothing fired.
export function fireWindowListeners(event, capture) {
  const list = windowListeners[event.type];
  if (!list || !list.length) return false;
  event.currentTarget = globalThis;
  let fired = false;
  for (const { handler, capture: cap, passive } of list.slice()) {
    if (!!cap !== !!capture) continue;
    if (event._propagationStopped) return fired;
    event._inPassiveListener = !!passive;   // passive → preventDefault is a no-op
    try { handler.call(globalThis, event); fired = true; }
    catch (e) { logThrew('window listener', e); }
    finally { event._inPassiveListener = false; }
  }
  return fired;
}

globalThis.addEventListener = function (type, handler, options) {
  if (typeof handler !== 'function') return;
  const capture = !!(options && (options === true || options.capture));
  const passive = (options && typeof options === 'object' && options.passive !== undefined)
    ? !!options.passive
    : defaultPassiveValue(type, globalThis);
  const list = windowListeners[type] || (windowListeners[type] = []);
  if (list.some(l => l.handler === handler && l.capture === capture)) return;
  list.push({ handler, capture, passive });
};

globalThis.removeEventListener = function (type, handler, options) {
  const list = windowListeners[type];
  if (!list) return;
  const capture = !!(options && (options === true || options.capture));
  windowListeners[type] = list.filter(l => !(l.handler === handler && l.capture === capture));
};

globalThis.dispatchEvent = function (event) {
  const list = windowListeners[event.type];
  if (!list || !list.length) return true;
  for (const { handler, passive } of list.slice()) {
    event._inPassiveListener = !!passive;   // passive → preventDefault is a no-op
    try { handler.call(globalThis, event); }
    catch (e) { logThrew('window listener', e); }
    finally { event._inPassiveListener = false; }
  }
  return !event.defaultPrevented;
};
