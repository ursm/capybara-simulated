// DOM4 capture / target / bubble event dispatch walk.
//
// `dispatchEvent(target, event)` walks the ancestor path, fires
// window listeners at capture + bubble, runs target listeners, and
// queues the MutationObserver microtask checkpoint at end-of-task.
// Inline `on<event>` attribute handlers fire alongside addEventListener
// listeners in the bubble phase, with property-assigned handlers
// (`el.onclick = fn`) winning over the attribute string.
//
// `dispatchEventForUserAction(target, event)` shares the same walk but
// drains V8's microtask checkpoint between every listener that fires,
// matching CDP-driven UA-click semantics. Per HTML spec "clean up
// after running script", the checkpoint runs when the JS execution
// context stack is empty after a callback returns — for UA-dispatched
// events the engine-native dispatcher leaves the stack empty between
// listeners, so the checkpoint fires; for JS-side `dispatchEvent` the
// caller's frame stays on the stack and the checkpoint is suppressed.
// Glimmer/Ember's Backburner autorun is a `Promise.resolve().then`
// microtask — without the explicit drain its `OnModifier` destructor
// can't remove an ancestor's listener before bubble reaches it, and
// `updateIndex(...)` leaks into the parent click handler (the
// Discourse `admin_editing_objects_typed_theme_setting_spec.rb:100`
// chain). The drain is supplied by the host as `__csim_yield`,
// resolving to `MicrotasksScope::PerformCheckpoint` on V8 and
// `JS_ExecutePendingJob` on QuickJS.
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

const NOOP = () => {};

export function dispatchEvent(target, event) {
  // EventTarget.dispatchEvent (the IDL method) throws if the event is already
  // being dispatched or was never initialized. UA-synthesized dispatches go
  // through dispatchEventForUserAction and skip this check.
  if (event && (event._dispatchFlag || event._initialized === false)) {
    throw new globalThis.DOMException(
      "The event is already being dispatched, or has not been initialized.", "InvalidStateError");
  }
  return dispatchPath(target, event, NOOP);
}

export function dispatchEventForUserAction(target, event) {
  return dispatchPath(target, event, globalThis.__csim_yield || NOOP);
}

function dispatchPath(target, event, drain) {
  event.target = target;
  event._dispatchFlag = true;   // re-dispatching this event mid-flight → InvalidStateError
  const path = [];
  // Walk target -> root via `_parent` (a ShadowRoot's `_parent` is its
  // host, so the chain climbs across the boundary for free). A
  // ShadowRoot is a boundary: a `composed:false` event (the default)
  // stops there and never reaches the host's light-tree ancestors; a
  // composed event (UA click / input / key / pointer events all set
  // composed:true) keeps climbing across the host.
  let cur = target;
  let sawShadow = false;
  while (cur) {
    path.push(cur);
    if (cur._isShadowRoot) {
      sawShadow = true;
      if (!event.composed) break;
    }
    cur = cur._parent;
  }
  // Shadow DOM retargeting: as propagation crosses a boundary upward,
  // the perceived `target` for listeners outside the shadow tree
  // becomes the shadow host, so they never observe the encapsulated
  // internal node. Build the retarget map only when a shadow was
  // actually on the path — the common (non-shadow) dispatch keeps its
  // previous allocations and stays on the original fast path.
  let retargets = null;
  let topRetarget = target;
  if (sawShadow) {
    retargets = new Map();
    let curTarget = target;
    for (const n of path) {
      retargets.set(n, curTarget);
      // After a ShadowRoot, every further node lives in the host's
      // (lighter) tree and must see the host as the target.
      if (n._isShadowRoot && n.host) curTarget = n.host;
    }
    topRetarget = curTarget;
  }
  event._csimRetargets = retargets;
  event._csimTopRetarget = topRetarget;
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
    // window sits outside every shadow tree -> it sees the topmost host.
    if (retargets) event.target = topRetarget;
    if (fireWindowListeners(event, true)) drain();
    if (!event._propagationStopped) {
      for (let i = path.length - 1; i > 0; i--) {
        if (fireListeners(path[i], event, true)) drain();
        if (event._propagationStopped) break;
      }
    }
    if (!event._propagationStopped) {
      event.eventPhase = 2;
      const a = fireListeners(target, event, false);
      const b = fireListeners(target, event, true);
      if (a || b) drain();
    }
    if (!event._propagationStopped && event.bubbles) {
      event.eventPhase = 3;
      for (let i = 1; i < path.length; i++) {
        if (fireListeners(path[i], event, false)) drain();
        if (event._propagationStopped) break;
      }
      if (!event._propagationStopped) {
        if (retargets) event.target = topRetarget;
        if (fireWindowListeners(event, false)) drain();
      }
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
    // Per spec, the end of dispatch unsets the dispatch / stop-propagation /
    // stop-immediate flags (so the event can be re-dispatched and reports
    // cancelBubble=false afterwards). `finally` survives a throwing listener.
    event._dispatchFlag = false;
    event._propagationStopped = false;
    event._immediatePropagationStopped = false;
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
    // Restore the real target and drop the per-dispatch retarget state
    // so a handler that retained the event later sees its true target.
    if (retargets) {
      event.target = target;
      event._csimRetargets = null;
      event._csimTopRetarget = null;
    }
  }
}

// Returns true iff at least one handler ran. The user-action dispatch
// path uses the return value to skip its microtask checkpoint when
// nothing fired — most ancestors in a deep DOM walk have no listener,
// and skipping there avoids a host-call round trip per node.
function fireListeners(node, event, capture) {
  let fired = false;
  // Shadow DOM: a listener on a node outside a crossed shadow tree must
  // see `event.target` retargeted to the host. `_csimRetargets` is only
  // set when a ShadowRoot was on the dispatch path, so the common
  // non-shadow case skips this branch entirely (no map lookup; the
  // target stays exactly as assigned by dispatchPath).
  if (event._csimRetargets) {
    event.target = event._csimRetargets.has(node)
      ? event._csimRetargets.get(node)
      : event._csimTopRetarget;
  }
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
        fired = true;
      } catch (e) {
        logThrew('on-attribute handler', e);
      }
    }
  }
  const list = node._listeners && node._listeners[event.type];
  if (!list || !list.length) return fired;
  event.currentTarget = node;
  for (const entry of list.slice()) {
    if (entry.capture !== capture) continue;
    if (event._immediatePropagationStopped) return fired;
    event._inPassiveListener = !!entry.passive;   // passive listener → preventDefault is a no-op
    try { entry.handler.call(node, event); fired = true; }
    catch (e) { logThrew('listener (event=' + event.type + ', tag=' + (node && node._tag) + ')', e); }
    finally { event._inPassiveListener = false; }
  }
  return fired;
}
