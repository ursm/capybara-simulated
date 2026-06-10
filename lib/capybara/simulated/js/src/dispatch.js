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
import { removeOnceListener, InputEvent, Event as GlobalEvent, MouseEvent as GlobalMouseEvent } from './events.js';
import { logThrew }                                    from './console.js';
import { toggleChecked, setRadio, checkedRadioInGroup } from './form-helpers.js';
import { isConnected }                                 from './walk.js';

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
  // HTML activation behaviour for <input type=checkbox|radio>: a click
  // event toggles the control as part of dispatch, BEFORE its listeners
  // run (so they observe the new state), and fires input+change after
  // (rolled back if the click was canceled). The internal synthetic-
  // click paths (Element.click / __csimClickResolve / __csimClickFinish /
  // set()) perform this themselves and set `_csimActivationHandled` to
  // avoid a double toggle; a bare `dispatchEvent(new MouseEvent('click'))`
  // from app / test code is activated here, matching real browsers.
  // Declared out here because its post-activation step runs AFTER the
  // dispatch cleanup in `finally` (see below).
  let ckActivation = null;
  try {
    // Only a real mouse click (MouseEvent/PointerEvent) activates a control —
    // a plain `new Event('click')` of the wrong interface does not toggle.
    if (event.type === 'click' && !event._csimActivationHandled &&
        event instanceof GlobalMouseEvent) {
      // Activation target: the event target, or — only when the event BUBBLES
      // — the nearest ancestor in the path, that is a checkbox/radio. A click
      // on a descendant text node toggles the enclosing checkbox iff it
      // bubbles up to it ("look at parents when event bubbles").
      let actNode = null;
      for (let i = 0; i < path.length; i++) {
        const n = path[i];
        if (n.nodeType === NODE_ELEMENT && n._tag === 'input') {
          const it = (n._attrs.type || '').toLowerCase();
          if (it === 'checkbox' || it === 'radio') { actNode = n; break; }
        }
        if (!event.bubbles) break;   // non-bubbling: only the target counts
      }
      const itype = actNode ? (actNode._attrs.type || '').toLowerCase() : '';
      if (itype === 'checkbox') {
        ckActivation = { kind: 'checkbox', node: actNode, wasChecked: actNode._attrs.checked != null };
        toggleChecked(actNode);
      } else if (itype === 'radio') {
        // Remember the group's prior selection so a canceled click can
        // restore it (the click may even morph the type mid-dispatch).
        ckActivation = { kind: 'radio', node: actNode, prevChecked: checkedRadioInGroup(actNode) };
        setRadio(actNode);
      }
    }
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
      // At AT_TARGET the spec visits the target in BOTH the capture and the
      // bubble traversal, so its CAPTURING listeners fire before its
      // non-capturing ones (independent of registration order), and a
      // stopPropagation() in a capturing target listener suppresses the
      // non-capturing ones (the bubble-traversal `invoke` bails on the
      // stop-propagation flag).
      const a = fireListeners(target, event, true);
      const b = event._propagationStopped ? false : fireListeners(target, event, false);
      if (a || b) drain();
    }
    if (!event._propagationStopped && event.bubbles) {
      event.eventPhase = 3;
      // `submit` / `reset` events do not bubble past an ancestor <form>:
      // a nested form's submission never reaches an outer form's listeners
      // (nor anything above it, including window). The CAPTURE phase is
      // unaffected — only the upward bubble is truncated at the first
      // ancestor form. The spec is silent here; this matches Chromium /
      // Firefox (DOM Event-dispatch-single-activation-behavior, where an
      // inner form nested in an outer form must activate only the inner).
      let bubbleLimit = path.length;
      if (event.type === 'submit' || event.type === 'reset') {
        for (let i = 1; i < path.length; i++) {
          const n = path[i];
          if (n.nodeType === NODE_ELEMENT && n._tag === 'form') { bubbleLimit = i; break; }
        }
      }
      for (let i = 1; i < bubbleLimit; i++) {
        if (fireListeners(path[i], event, false)) drain();
        if (event._propagationStopped) break;
      }
      if (!event._propagationStopped && bubbleLimit === path.length) {
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
  } finally {
    // Per spec, the end of dispatch resets the event to its post-dispatch
    // state: eventPhase NONE, currentTarget null, empty path (so
    // composedPath() returns []), and the dispatch / stop-propagation /
    // stop-immediate flags unset (so the event can be re-dispatched and
    // reports cancelBubble=false afterwards). `finally` survives a
    // throwing listener.
    event.eventPhase = 0;
    event._currentTarget = null;
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
  // Checkbox/radio activation behaviour runs AFTER the dispatch cleanup
  // above (DOM spec: the activation behaviour is invoked once the event's
  // state has been reset). A post-click `change`/`input` handler therefore
  // observes the click event in its post-dispatch state — eventPhase NONE,
  // currentTarget null, dispatch flag clear, empty composedPath — and may
  // even re-dispatch that same click event (it is no longer in-flight).
  // Roll back on cancel; otherwise fire input then change, but only when
  // the control is connected (per HTML a detached control's activation
  // mutates state yet dispatches no input/change). `ckActivation.node` is
  // the activation target captured during the path walk (the real control,
  // independent of any shadow retarget done to `event.target`).
  if (ckActivation) {
    const node = ckActivation.node;
    if (event.defaultPrevented) {
      if (ckActivation.kind === 'radio') {
        // Restore the group: clear the one we set, re-check the prior selection.
        delete node._attrs.checked;
        if (ckActivation.prevChecked) ckActivation.prevChecked._attrs.checked = '';
      } else if (ckActivation.wasChecked) {
        node._attrs.checked = '';
      } else {
        delete node._attrs.checked;
      }
    } else {
      const wasChecked = ckActivation.kind === 'radio'
        ? ckActivation.prevChecked === node
        : ckActivation.wasChecked;
      if (isConnected(node) && (node._attrs.checked != null) !== wasChecked) {
        try { dispatchEvent(node, new InputEvent('input', { bubbles: true, cancelable: true })); } catch (_) {}
        try { dispatchEvent(node, new GlobalEvent('change', { bubbles: true, cancelable: false })); } catch (_) {}
      }
    }
  }
  return !event.defaultPrevented;
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
    // Per spec "inner invoke": skip a listener removed *after* this dispatch's
    // snapshot was taken — `removeEventListener` (or a `once` self-removal) sets
    // `removed` on the entry so the still-snapshotted reference isn't invoked.
    if (entry.removed) continue;
    if (event._immediatePropagationStopped) return fired;
    // A `once` listener is removed *before* its callback runs, so a callback
    // that re-dispatches the same event sees it gone and recursion stays bounded.
    if (entry.once) removeOnceListener(entry, node._listeners && node._listeners[event.type]);
    event._inPassiveListener = !!entry.passive;   // passive listener → preventDefault is a no-op
    if (entry.isObject) {
      // DOM "inner invoke": Get `handleEvent` off the object on EVERY
      // dispatch (a getter must run each time), and a non-callable value
      // is a TypeError. A throw from the Get itself or the callability
      // check is reported per HTML "report the exception" (a window
      // `error` event), NOT propagated to the dispatchEvent() caller.
      let cb;
      try {
        cb = entry.handler.handleEvent;
        if (typeof cb !== 'function') throw new TypeError("Failed to invoke event listener: the 'handleEvent' property is not callable.");
      } catch (e) {
        event._inPassiveListener = false;
        try { globalThis.reportError(e); } catch (_) {}
        continue;
      }
      try { cb.call(entry.handler, event); fired = true; }
      catch (e) { logThrew('listener (event=' + event.type + ', tag=' + (node && node._tag) + ')', e); }
      finally { event._inPassiveListener = false; }
    } else {
      try { entry.handler.call(node, event); fired = true; }
      catch (e) { logThrew('listener (event=' + event.type + ', tag=' + (node && node._tag) + ')', e); }
      finally { event._inPassiveListener = false; }
    }
  }
  return fired;
}
