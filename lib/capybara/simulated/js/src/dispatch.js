// DOM4 capture / target / bubble event dispatch walk.
//
// `dispatchEvent(target, event)` walks the ancestor path, fires
// window listeners at capture + bubble, runs target listeners, and
// queues the MutationObserver microtask checkpoint at end-of-task.
// Inline `on<event>` attribute handlers fire alongside addEventListener
// listeners in the bubble phase, with property-assigned handlers
// (`el.onclick = fn`) winning over the attribute string.
//
// HTML-spec default action for `<a download>` synthetic clicks
// surfaces a pending-download intent that Ruby's tick-time drain
// then saves to disk — file-saver's `saveAs` calls
// `node.dispatchEvent(new MouseEvent('click'))`, not `node.click()`,
// so without this hook the synthetic click is a no-op.

import { NODE_ELEMENT }                                from './constants.js';
import { hasObservers, hasQueuedRecords, deliverMutations } from './mutation-observer.js';
import { fireWindowListeners }                         from './window-events.js';
import { logThrew }                                    from './console.js';

export function dispatchEvent(target, event) {
  event.target = target;
  const path = [];
  let cur = target;
  while (cur) { path.push(cur); cur = cur._parent; }
  // Legacy `window.event` — IE-era global that handlers reach for
  // when no event parameter is in scope. Redmine's inline-autocomplete
  // `values()` callback (`event.target.type === 'text'`) and a few
  // other library entry points rely on it. Save / restore so nested
  // dispatches don't shadow each other.
  const prevWinEvent = globalThis.event;
  globalThis.event = event;
  try {
    // Capture: window → root → target's parent. Turbo Drive's
    // FormSubmitObserver / LinkClickObserver attach to `window` with
    // `{capture: true}` and call `event.preventDefault()` to take
    // over the navigation / submission; skipping the window hop
    // means every form falls through to the Ruby-side
    // submit_form_handle without Turbo's turbo-stream Accept header,
    // and the receiving controller (e.g. Avo actions) raises
    // `ActionController::UnknownFormat`.
    event.eventPhase = 1;
    fireWindowListeners(event, true);
    if (!event._propagationStopped) {
      for (let i = path.length - 1; i > 0; i--) {
        fireListeners(path[i], event, true);
        if (event._propagationStopped) break;
      }
    }
    if (!event._propagationStopped) {
      event.eventPhase = 2;
      fireListeners(target, event, false);
      fireListeners(target, event, true);
    }
    if (!event._propagationStopped && event.bubbles) {
      event.eventPhase = 3;
      for (let i = 1; i < path.length; i++) {
        fireListeners(path[i], event, false);
        if (event._propagationStopped) break;
      }
      if (!event._propagationStopped) fireWindowListeners(event, false);
    }
    // HTML-spec default-action for click events that reach an
    // `<a download>` ancestor: queue a download intent so Ruby's
    // tick-time drain saves the file. Default-action runs regardless
    // of `bubbles` (a non-bubbling click on `<a download>` still
    // follows the link in real browsers). Non-download anchors stay
    // on the existing Element.click() / Ruby-driven click paths.
    if (!event.defaultPrevented && event.type === 'click') {
      let anchor = target;
      while (anchor && anchor.nodeType === NODE_ELEMENT && anchor._tag !== 'a') {
        anchor = anchor._parent;
      }
      if (anchor && anchor.nodeType === NODE_ELEMENT && anchor._tag === 'a' &&
          anchor._attrs.download != null && anchor._attrs.href != null) {
        globalThis.__csimPendingDownload = {
          url: String(anchor._attrs.href),
          filename: String(anchor._attrs.download || '')
        };
      }
    }
    return !event.defaultPrevented;
  } finally {
    // Per spec, MutationObserver delivery is the microtask checkpoint
    // — synchronous flush at end-of-dispatchEvent re-enters Trix's
    // reparse → loadHTML inside its own custom-event dispatch and
    // pegs the heap (the observer's stop()/start() bracket relies on
    // delivery happening after Trix's synchronous code finishes).
    // Schedule via microtask; settle's drain_microtasks picks it up
    // in the same iteration.
    if (hasObservers() && hasQueuedRecords()) Promise.resolve().then(deliverMutations);
    if (typeof globalThis.__recheckIntersectionObservers === 'function') globalThis.__recheckIntersectionObservers();
    globalThis.event = prevWinEvent;
  }
}

function fireListeners(node, event, capture) {
  // Inline `on<event>` attribute handler fires alongside the
  // addEventListener-registered listeners in the bubble phase. We
  // compile the attribute value to a function once and cache it on
  // the node so the per-click cost is one closure call. Without
  // this, Redmine's `onclick="showAndScrollTo(...); return false"`
  // never runs and the issue-notes form stays collapsed.
  if (!capture && node._attrs && !event._immediatePropagationStopped) {
    const attrName = 'on' + event.type;
    // Property assignment (`el.onclick = fn`) takes precedence over
    // any `onclick="..."` attribute per HTML spec — the setter
    // *replaces* the inline handler. jstoolbar registers its Edit /
    // Preview tab handlers via `this.previewTab.onclick = ...` and
    // the click_link 'Preview' chain depends on that running.
    const propHandler = typeof node[attrName] === 'function' ? node[attrName] : null;
    const attrVal     = propHandler ? null : node._attrs[attrName];
    let handler = propHandler;
    if (!handler && attrVal != null) {
      handler = node._onCompiled && node._onCompiled[attrName];
      if (handler === undefined) {
        try { handler = new Function('event', String(attrVal)); }
        catch (_) { handler = null; }
        (node._onCompiled = node._onCompiled || {})[attrName] = handler;
      }
    }
    if (handler) {
      event.currentTarget = node;
      try {
        const ret = handler.call(node, event);
        // Returning false from an on-attribute handler cancels the
        // event's default action (HTML spec; mirrored by jQuery's
        // own behaviour for event handlers).
        if (ret === false && event.cancelable) event.defaultPrevented = true;
      } catch (e) {
        logThrew('on-attribute handler', e);
      }
    }
  }
  const list = node._listeners && node._listeners[event.type];
  if (!list || !list.length) return;
  event.currentTarget = node;
  for (const entry of list.slice()) {
    if (entry.capture !== capture) continue;
    if (event._immediatePropagationStopped) return;
    try { entry.handler.call(node, event); } catch (e) {
      try { console.error('[csim] listener threw on event=' + event.type + ' tag=' + (node && node._tag) + ': ' + (e && e.message)); } catch (_) {}
    }
  }
}
