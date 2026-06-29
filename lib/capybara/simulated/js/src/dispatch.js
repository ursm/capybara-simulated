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

import { NODE_ELEMENT, NODE_DOC }                      from './constants.js';
import { hasObservers, hasQueuedRecords, deliverMutations } from './mutation-observer.js';
import { fireWindowListeners }                         from './window-events.js';
import { removeOnceListener, InputEvent, Event as GlobalEvent, MouseEvent as GlobalMouseEvent } from './events.js';
import { logThrew }                                    from './console.js';
import { toggleChecked, setRadio, checkedRadioInGroup, getCheckedness, setCheckedness, labelToActivateFor, labeledControlFor, isSubmitButton, isClickActivatable, formForControl } from './form-helpers.js';
import { isConnected }                                 from './walk.js';
import { hasShadowRoots, flatTreeAssignedSlot, isSlottableNode, isActuallyDisabled } from './dom-nodes.js';

const NOOP = () => {};

// Fire the activation-behaviour `input` then `change` on a checkbox/radio whose
// checkedness just changed. Both are dispatched by the UA (the activation
// behaviour) → TRUSTED, even when the triggering click was a script `.click()` /
// untrusted dispatchEvent; `input` is composed and (like `change`) NOT
// cancelable, per the UI Events / HTML contract. Shared by the three activation
// entry points — the dispatchEvent activation path (below), IDL Element.click()
// (dom-nodes), and the Ruby UA-click resolver (bridge.entry) — so the event
// shape stays identical and can't drift. The caller decides WHEN to fire (only
// on a real checkedness change, and only for a connected control).
export function fireCheckableActivation(node) {
  try { const ie = new InputEvent('input', { bubbles: true, cancelable: false, composed: true }); ie.isTrusted = true; dispatchEvent(node, ie); } catch (_) {}
  try { const ce = new GlobalEvent('change', { bubbles: true, cancelable: false }); ce.isTrusted = true; dispatchEvent(node, ce); } catch (_) {}
}

export function dispatchEvent(target, event) {
  // Internal dispatch helper. It does NOT set `isTrusted` — most internal
  // callers fire script-equivalent synthetic events (el.click(), requestSubmit,
  // …) that must stay untrusted (the event keeps its constructed default,
  // false). The few genuinely UA-fired events that must be trusted set
  // `event.isTrusted = true` at their own call site before dispatching (or use
  // dispatchEventForUserAction / __csimDispatchTrusted). The validation throw
  // mirrors the IDL method (an event already mid-dispatch or never initialized
  // → InvalidStateError); UA callers pass fresh events.
  if (event && (event._dispatchFlag || event._initialized === false)) {
    throw new globalThis.DOMException(
      "The event is already being dispatched, or has not been initialized.", "InvalidStateError");
  }
  return dispatchPath(target, event, NOOP);
}

// Public EventTarget.dispatchEvent(event) IDL method (DOM-node targets). Per
// the DOM "dispatchEvent" steps, re-dispatching sets the event's isTrusted to
// false — a previously trusted (UA-fired) event becomes untrusted once script
// redispatches it.
export function dispatchEventPublic(target, event) {
  if (event && (event._dispatchFlag || event._initialized === false)) {
    throw new globalThis.DOMException(
      "The event is already being dispatched, or has not been initialized.", "InvalidStateError");
  }
  if (event) event.isTrusted = false;
  // `fromPublic`: a scripted `el.dispatchEvent(clickEvent)` runs hyperlink
  // activation (navigation) like a real click — see the anchor block below. The
  // IDL Element.click() and UA-click paths use the internal entry points and run
  // their own navigation, so only THIS path triggers the dispatch-side navigation
  // (no double-navigation).
  return dispatchPath(target, event, NOOP, true);
}

export function dispatchEventForUserAction(target, event) {
  // Simulates a real user/UA action (Ruby-driven click / key / etc.) → trusted.
  if (event) event.isTrusted = true;
  return dispatchPath(target, event, globalThis.__csim_yield || NOOP);
}

function dispatchPath(target, event, drain, fromPublic = false) {
  event.target = target;
  event._dispatchFlag = true;   // re-dispatching this event mid-flight → InvalidStateError
  // `path` is the ordered list of nodes the event visits, target -> top
  // (window is fired separately below). `structMap` (shadow case only)
  // maps each path node to its DOM "event path" struct {sat, rel,
  // rootClosed, slotClosed} — the per-listener shadow-adjusted target,
  // retargeted relatedTarget, and the two flags composedPath() needs.
  let path;
  let structMap = null;          // node -> struct, only when a shadow exists
  let topSat = target;           // shadow-adjusted target the window listeners see
  let windowRel;                 // relatedTarget retargeted against the window
  let clearTargets = false;      // DOM "clear targets": null out target post-dispatch
  const origRelated = event.relatedTarget;
  if (!hasShadowRoots()) {
    // FAST PATH (no shadow trees on the page): the flattened tree IS the
    // node tree, no retargeting, no slot crossings. Walk target -> root via
    // `_parent` and fire with `event.target` pinned to the real target.
    // This is the hot path on every app suite (rule 3) — one array, no
    // per-node struct allocation, no slot lookups.
    path = [];
    for (let cur = target; cur; cur = cur._parent) path.push(cur);
  } else {
    // A shadow tree exists: compute the real DOM event path. The event-parent
    // of a slotted node is its assigned slot (the flattened tree), `target`
    // is retargeted as propagation crosses into lighter trees, and
    // relatedTarget is retargeted per node (and prunes the path when it
    // coincides with the retargeted target).
    const built = buildFlatTreePath(target, event);
    const structs = built.structs;
    path = new Array(structs.length);
    structMap = new Map();
    for (let i = 0; i < structs.length; i++) { path[i] = structs[i].node; structMap.set(structs[i].node, structs[i]); }
    // structs is empty when the dispatch was suppressed (target is its own
    // retargeted relatedTarget) — nothing fires, so the topSat / windowRel the
    // window phase would use are never read.
    if (structs.length) {
      const topStruct = structs[structs.length - 1];
      topSat = topStruct.sat;
      if (origRelated != null) windowRel = retarget(origRelated, globalThis);
      // DOM "clear targets": after dispatch, target/relatedTarget are reset to
      // null when the topmost shadow-adjusted target (or its relatedTarget)
      // still lives inside a shadow tree — i.e. a non-composed event never
      // escaped its tree, so exposing the internal node post-dispatch would
      // leak encapsulation. A composed event whose target reached the light
      // tree keeps that (host) target.
      clearTargets = nodeRoot(topSat)._isShadowRoot ||
        (topStruct.rel != null && nodeRoot(topStruct.rel)._isShadowRoot);
    }
    // composedPath() reads these back from within a listener.
    event._csimPath = built.reachesWindow
      ? structs.concat([{ node: globalThis, rootClosed: false, slotClosed: false }])
      : structs;
    event._csimStructMap = structMap;
  }
  // Legacy `window.event` — IE-era global that handlers reach for
  // when no event parameter is in scope. Redmine's inline-autocomplete
  // `values()` callback (`event.target.type === 'text'`) and a few
  // other library entry points rely on it. Save / restore so nested
  // dispatches don't shadow each other.
  //
  // This Node tree-walk dispatch (and the window's participation in it via
  // window-events.js fireWindowListeners) keeps the per-DISPATCH model — set the
  // dispatch realm's `globalThis.event` once — and does NOT do the per-LISTENER-
  // realm current-event of the base EventTarget/window dispatch (events.js
  // invokeWithCurrentEvent / perRealmCurrentEvent). Bounded gap: a CROSS-realm
  // listener attached to a Node (`el.addEventListener('x', frames[0].fn)`) — or a
  // cross-realm window listener reached by bubbling — reads its own realm's stale
  // `window.event` instead of this event. (fireWindowListeners likewise still
  // swallows a throwing window listener via logThrew rather than HTML "report the
  // exception", unlike the events.js base path.) Deliberate scoping: this is the
  // hot DOM path (rule 3 — a per-listener `contextOf` here would tax every element
  // click/input on multi-realm pages) and it interleaves with the shadow-tree
  // `window.event` hiding below. The cross-realm window.event tests in the GATE
  // (Event-dispatch-throwing-multiple-globals, event-global-is-still-set-*) all
  // dispatch on the Window / a plain EventTarget, which the events.js path covers;
  // the node-listener contract is dom/events/event-global-extra.window.js, which
  // is in the deliberately-excluded dom/ .window.js tree (wpt_runner.rb JS_TREES).
  // Generalizing the per-realm model across this whole node-walk subsystem is a
  // dedicated, perf-validated follow-up — see [[window_event_cluster]].
  const prevWinEvent = globalThis.event;
  globalThis.event = event;
  // Legacy `window.event` is NOT updated while a listener whose node lives in a
  // shadow tree runs (DOM "invoke": only when invocation-target-in-shadow-tree
  // is false) — encapsulation hides the event from `window.event` too. The
  // shadow path toggles it per node (fireListeners); stash the pre-dispatch
  // value so an in-shadow listener sees it instead of this event.
  if (structMap) event._csimPrevWinEvent = prevWinEvent;
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
        // Pre-activation steps (run BEFORE the click event dispatches, so an
        // onclick handler sees the toggled state): clear indeterminate and toggle
        // checkedness. The prior values are kept for the canceled-activation undo.
        ckActivation = { kind: 'checkbox', node: actNode, wasChecked: getCheckedness(actNode), wasIndeterminate: actNode._indeterminate };
        actNode._indeterminate = false;
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
    // window sits outside every shadow tree -> it sees the topmost
    // shadow-adjusted target and the fully-retargeted relatedTarget.
    if (structMap) {
      event.target = topSat;
      if (windowRel !== undefined) event.relatedTarget = windowRel;
      globalThis.event = event;   // window is outside every shadow tree
    }
    // An empty path means the dispatch was suppressed (target is its own
    // retargeted relatedTarget) — nothing, not even window, is invoked.
    if (path.length && fireWindowListeners(event, true)) drain();
    if (!event._propagationStopped) {
      for (let i = path.length - 1; i > 0; i--) {
        if (fireListeners(path[i], event, true)) drain();
        if (event._propagationStopped) break;
      }
    }
    if (path.length && !event._propagationStopped) {
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
    if (path.length && !event._propagationStopped && event.bubbles) {
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
        if (structMap) {
          event.target = topSat;
          if (windowRel !== undefined) event.relatedTarget = windowRel;
          event.eventPhase = 3;       // per-node overrides may have left it AT_TARGET
          globalThis.event = event;   // window is outside every shadow tree
        }
        if (fireWindowListeners(event, false)) drain();
      }
    }
    // `<label>` activation behaviour (HTML "click in a label"): a click ON a
    // label, or on a NON-interactive descendant of it, runs a synthetic click on
    // the label's labeled control; `labelToActivateFor` encodes that rule (a
    // click on interactive content runs its OWN activation instead). This is the
    // dispatchEvent-path twin of the hop in Element.click() (dom-nodes) and the
    // Ruby UA-click resolver (bridge.entry), all sharing that one helper —
    // `_csimActivationHandled` is set by those paths, so gating on it here keeps
    // a single activation per click (no double hop). A bare `dispatchEvent(new
    // MouseEvent('click'))` from app / test code has the flag clear and hops
    // here, matching real browsers.
    if (!event.defaultPrevented && !event._csimActivationHandled &&
        event.type === 'click' && event instanceof GlobalMouseEvent &&
        target && target.nodeType === NODE_ELEMENT) {
      const label = labelToActivateFor(target);
      if (label) {
        const labeled = labeledControlFor(label);
        if (labeled && labeled !== target && typeof labeled.click === 'function') labeled.click();
      }
      // `<option>` activation: a TRUSTED click on an option in a `<select>`
      // toggles/picks it — the customizable popup / listbox option-click — firing
      // input/change on the select. Unlike checkbox/radio, an `<option>` has no
      // activation behavior: selection is UA listbox input handling, so an untrusted
      // synthetic `dispatchEvent(click)` must NOT change the selection (real browsers
      // don't). `__csimToggleOptionByClick` no-ops unless the option is in a select.
      if (target._tag === 'option' && event.isTrusted && typeof globalThis.__csimToggleOptionByClick === 'function') {
        globalThis.__csimToggleOptionByClick(target);
      }
    }
    // Submit-button activation for a bare `dispatchEvent(click)` (the click /
    // UA paths set `_csimActivationHandled` and run their own submit, so the gate
    // keeps it single). Per single-activation the activation target is the NEAREST
    // activatable element in the event path — the click target itself, or, when the
    // event BUBBLES, an ancestor (so a click on a `<span>` inside a `<button>`
    // submits, but a click on a closer activatable — a link / summary / label —
    // activates THAT, not an enclosing submit button). We submit only when that
    // nearest activatable is itself a (connected, enabled) submit button.
    if (!event.defaultPrevented && !event._csimActivationHandled &&
        event.type === 'click' && event instanceof GlobalMouseEvent) {
      let nearest = null;
      for (let i = 0; i < path.length; i++) {
        const n = path[i];
        if (n.nodeType === NODE_ELEMENT && isClickActivatable(n)) { nearest = n; break; }
        if (!event.bubbles) break;   // non-bubbling: only the target activates
      }
      if (nearest && isSubmitButton(nearest) && isConnected(nearest) && !isActuallyDisabled(nearest)) {
        const form = formForControl(nearest);
        if (form && typeof form._submitForm === 'function') form._submitForm(nearest, true);
      }
    }
    // HTML-spec default action for a click that reaches the nearest
    // activating hyperlink. `<area>` activates itself; otherwise we walk
    // to the nearest `<a>` ancestor (a click on inner content — Avo's
    // `<a><svg/></a>` — activates the enclosing link). The activation
    // runs regardless of `bubbles` (a non-bubbling click on a link still
    // follows it in real browsers).
    if (!event.defaultPrevented && event.type === 'click') {
      let anchor = target;
      if (anchor && anchor.nodeType === NODE_ELEMENT && anchor._tag !== 'area') {
        while (anchor && anchor.nodeType === NODE_ELEMENT && anchor._tag !== 'a') {
          anchor = anchor._parent;
        }
      }
      // A hyperlink inside an editing host (contenteditable) has NO navigation
      // activation behaviour — clicking it edits/places the caret instead (HTML:
      // the activation behaviour is skipped when the element is editable).
      if (anchor && anchor.nodeType === NODE_ELEMENT &&
          (anchor._tag === 'a' || anchor._tag === 'area') && anchor._attrs.href != null &&
          !anchor.isContentEditable) {
        if (event instanceof GlobalMouseEvent &&
            /^\s*javascript:/i.test(String(anchor._attrs.href).replace(/[\t\n\r]/g, ''))) {
          // A `javascript:` hyperlink's activation behaviour is to run the
          // embedded script in global scope. Per HTML, navigating to a
          // javascript: URL is a QUEUED task, not synchronous (real
          // browsers run it in a later task) — so schedule it; the WPT
          // drain / settle then runs it. Only the nearest activating link
          // runs (single activation), and only a genuine mouse click
          // activates (a plain `new Event('click')` does not). A javascript:
          // URL is never a download (its scheme isn't fetchable), so this is
          // checked before the `download` branch. Real (non-javascript)
          // navigation stays on the Element.click() / Ruby-driven paths,
          // which own the Context-rebuild deferral.
          //
          // The executed source is derived from the PARSED URL (the WHATWG
          // serialization, percent-decoded), NOT the raw attribute: the parser
          // strips interspersed tab/newline/CR (so `java\nscript:…` counts),
          // collapses `/..` segments, and %-encodes — so what runs matches a
          // real browser. A parse error or a non-javascript result is a no-op.
          let code = null;
          try {
            const parsed = globalThis.__csim_parseUrl(
              String(anchor._attrs.href),
              anchor.baseURI || (globalThis.location && globalThis.location.href) || null);
            if (parsed && !parsed.error && parsed.protocol === 'javascript:') {
              // Shared with the `<iframe src="javascript:…">` sink (bridge.entry.js):
              // the script source is the parsed href after the scheme, byte-wise
              // lenient percent-decoded (maximal %XX runs decoded, a lone `%` left
              // literal — so `f('%41','%')` runs as `f('A','%')`).
              code = globalThis.__csimJavascriptUrlSource(parsed.href);
            }
          } catch (_) { code = null; }
          if (code != null && typeof globalThis.setTimeout === 'function') {
            globalThis.setTimeout(() => {
              try { (new Function(code))(); }
              catch (e) {
                if (typeof globalThis.reportError === 'function') {
                  try { globalThis.reportError(e); } catch (_) {}
                }
              }
            }, 0);
          }
        } else if (anchor._tag === 'a' && anchor._attrs.download != null) {
          // `<a download>`: queue a download intent so Ruby's tick-time
          // drain saves the file.
          globalThis.__csimPendingDownload = {
            url: String(anchor._attrs.href),
            filename: String(anchor._attrs.download || '')
          };
        } else if (fromPublic && typeof globalThis.__csimAnchorActivateNav === 'function') {
          // A scripted `el.dispatchEvent(new MouseEvent('click'))` runs the
          // hyperlink's activation behaviour (navigation) just like Element.click()
          // — real browsers navigate regardless of isTrusted. Only the PUBLIC
          // dispatch path does this (the IDL click() + UA-click paths run their own
          // navigation), so there is no double-navigation. Same shared helper as
          // Element.click(): fragment hop / frame-realm new-window / pending intent.
          globalThis.__csimAnchorActivateNav(anchor);
        }
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
    // Drop the per-dispatch path state (so composedPath() returns [] — the
    // dispatch flag is also clear) and apply the spec post-dispatch target
    // state. Unlike a flat dispatch, the shadow path does NOT restore the
    // original target: per DOM dispatch the event keeps its last
    // shadow-adjusted target (e.g. the host for a composed event), or null
    // when "clear targets" holds. A suppressed (empty-path) dispatch left
    // target untouched, so leave it alone there.
    if (structMap) {
      if (path.length) {
        if (clearTargets) {
          event.target = null;
          event.relatedTarget = null;
        } else {
          // Not cleared: the event keeps its topmost shadow-adjusted target
          // and fully-retargeted relatedTarget (e.g. both retargeted to their
          // respective hosts for a composed cross-tree event).
          event.target = topSat;
          if (windowRel !== undefined) event.relatedTarget = windowRel;
        }
      }
      event._csimPath = null;
      event._csimStructMap = null;
      event._csimPrevWinEvent = undefined;
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
        setCheckedness(node, false);
        if (ckActivation.prevChecked) setCheckedness(ckActivation.prevChecked, true);
      } else {
        // Canceled activation steps: undo the pre-activation toggle AND the
        // indeterminate clear (a value the onclick handler set is also reverted).
        setCheckedness(node, ckActivation.wasChecked);
        node._indeterminate = ckActivation.wasIndeterminate;
      }
    } else {
      const wasChecked = ckActivation.kind === 'radio'
        ? ckActivation.prevChecked === node
        : ckActivation.wasChecked;
      if (isConnected(node) && getCheckedness(node) !== wasChecked) {
        fireCheckableActivation(node);
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
  // Shadow DOM: a listener sees `event.target` retargeted to whatever it
  // is allowed to observe (the shadow-adjusted target) and a likewise
  // retargeted `relatedTarget`. `_csimStructMap` is only set when a
  // ShadowRoot exists, so the common non-shadow case skips this branch
  // entirely (no map lookup; target stays as assigned by dispatchPath).
  if (event._csimStructMap) {
    const s = event._csimStructMap.get(node);
    if (s) {
      event.target = s.sat;
      if (s.rel !== undefined) event.relatedTarget = s.rel;
      // A node that is its own shadow-adjusted target (the host of a crossed
      // shadow tree, seen from the lighter tree) is AT_TARGET even though the
      // capture/bubble walk reaches it mid-path — not CAPTURING/BUBBLING.
      event.eventPhase = s.sat === node ? 2 : (capture ? 1 : 3);
    }
    // `window.event` hides the event from listeners inside a shadow tree.
    globalThis.event = nodeRoot(node)._isShadowRoot ? event._csimPrevWinEvent : event;
  }
  // Inline `on<event>` attribute handler fires alongside the
  // addEventListener-registered listeners in the bubble phase. We
  // compile the attribute value to a function once and cache it on
  // the node so the per-click cost is one closure call. Without
  // this, Redmine's `onclick="showAndScrollTo(...); return false"`
  // never runs and the issue-notes form stays collapsed.
  // A Document is included even though it has no `_attrs`: it carries IDL
  // on-handlers (`document.onclick` / `onkeydown` / …, set as properties) that
  // must fire on a bubbled event reaching it (handler-count ?document). The
  // `_attrs` / shadow-root / document gate keeps attribute-less, handler-less
  // Text / Comment nodes off this hot path.
  if (!capture && !event._immediatePropagationStopped &&
      (node._attrs || node._isShadowRoot || node.nodeType === NODE_DOC)) {
    // IDL on-handler attribute names are lowercase; an event type can be mixed
    // case (e.g. `webkitAnimationEnd` → `onwebkitanimationend`), so lower-case
    // the type for the property/attribute lookup. No-op for the standard
    // already-lowercase event types.
    const attrName = 'on' + event.type.toLowerCase();
    // Property assignment (`el.onclick = fn`) takes precedence over
    // any `onclick="..."` attribute per HTML spec — the setter
    // *replaces* the inline handler. jstoolbar registers its Edit /
    // Preview tab handlers via `this.previewTab.onclick = ...` and
    // the click_link 'Preview' chain depends on that running. The block also
    // runs for a ShadowRoot (no `_attrs`) so a property-assigned
    // `shadowRoot.onslotchange` fires; the gate above keeps attribute-less,
    // handler-less nodes (Text / Comment) off the hot path. The attribute
    // lookup (not the property one) is what's additionally gated on `_attrs`.
    const propHandler = typeof node[attrName] === 'function' ? node[attrName] : null;
    const attrVal     = (propHandler || !node._attrs) ? null : node._attrs[attrName];
    let handler = propHandler;
    if (!handler && attrVal != null) {
      // Compile the inline handler source lazily, and re-compile when the
      // attribute VALUE changes — a `setAttribute('onwheel', newSrc)` that
      // replaces an existing `onwheel` must run the new source, not the old.
      // Keying the cache on the source string self-invalidates across EVERY
      // mutation path (setAttribute / Attr#value / setAttributeNode / parser),
      // so no per-writer cache-busting hook is needed.
      let cached = node._onCompiled && node._onCompiled[attrName];
      if (!cached || cached.src !== attrVal) {
        let fn = null;
        try { fn = new Function('event', String(attrVal)); } catch (_) { fn = null; }
        cached = { src: attrVal, fn };
        (node._onCompiled = node._onCompiled || {})[attrName] = cached;
      }
      handler = cached.fn;
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
  // Active-listener-realm tracking (for a cross-realm composedPath() retarget) is
  // only meaningful on multi-realm pages — gate it so single-realm dispatch (the
  // hot common case) pays zero native crossings (rule 3). `root` cached once.
  const trackAL = !!(globalThis.__csimMultiRealm && globalThis.__csimMultiRealm());
  const alRoot  = trackAL ? (globalThis.top || globalThis) : null;
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
        // Report on the LISTENER object's realm as that realm's TypeError
        // (WebIDL "invoke a callback" runs with the callback realm current).
        try { globalThis.__csimReportListenerError(entry.handler, e); } catch (_) {}
        continue;
      }
      // A callback throw is REPORTED (HTML "report the exception" — a window
      // `error` event + legacy `onerror`), NOT propagated to dispatchEvent's
      // caller, and dispatch continues to the next listener. Report on the
      // LISTENER's realm (not `cb`'s — handleEvent may be a foreign-realm Proxy).
      // Record the listener's realm so a composedPath() it calls retargets the
      // window entry to that realm's WindowProxy (cross-realm shadow dispatch).
      const prevAL = trackAL ? alRoot.__csimActiveListenerRealmId : undefined;
      if (trackAL) globalThis.__csimSetActiveListenerRealm(entry.handler);
      try { cb.call(entry.handler, event); fired = true; }
      catch (e) { try { globalThis.__csimReportListenerError(entry.handler, e); } catch (_) {} }
      finally { event._inPassiveListener = false; if (trackAL) alRoot.__csimActiveListenerRealmId = prevAL; }
    } else {
      const prevAL = trackAL ? alRoot.__csimActiveListenerRealmId : undefined;
      if (trackAL) globalThis.__csimSetActiveListenerRealm(entry.handler);
      try { entry.handler.call(node, event); fired = true; }
      catch (e) { try { globalThis.__csimReportListenerError(entry.handler, e); } catch (_) {} }
      finally { event._inPassiveListener = false; if (trackAL) alRoot.__csimActiveListenerRealmId = prevAL; }
    }
  }
  return fired;
}

// ---------------------------------------------------------------------------
// Shadow-DOM event path (DOM "dispatch" algorithm). Only reached when a shadow
// tree exists on the page (see the `hasShadowRoots()` gate in dispatchPath).
// ---------------------------------------------------------------------------

// A node's tree root, stopping AT a shadow root (a shadow root is the root of
// its own tree; we do NOT cross to its host here, unlike the `_parent` walk
// which models shadowRoot._parent === host for the dispatch ascent).
function nodeRoot(node) {
  let n = node;
  while (n) {
    if (n._isShadowRoot) return n;
    if (!n._parent) return n;
    n = n._parent;
  }
  return n;
}

// X is a shadow-including inclusive ancestor of Y iff X is on Y's `_parent`
// chain (inclusive). `_parent` crosses shadow boundaries (shadowRoot._parent
// === host), so this is the shadow-INCLUDING relation.
function isShadowIncludingInclusiveAncestor(x, y) {
  for (let n = y; n; n = n._parent) {
    if (n === x) return true;
  }
  return false;
}

// DOM "retarget" (https://dom.spec.whatwg.org/#retarget): bubble `a` up out of
// any shadow tree that `b` cannot see, so a listener on `b` observes the
// nearest host instead of an encapsulated node. Used for both the
// shadow-adjusted target and relatedTarget. `b` may be the Window (not a node):
// no node's root is its ancestor, so `a` retargets all the way out.
function retarget(a, b) {
  while (a && a.nodeType !== undefined) {
    const root = nodeRoot(a);
    if (!root._isShadowRoot) return a;
    if (isShadowIncludingInclusiveAncestor(root, b)) return a;
    a = root.host || null;
  }
  return a;
}

// A node's event-parent (DOM "get the parent"): a slotted node ascends into its
// assigned slot (the flattened tree); a shadow root ascends to its host, except
// a non-composed event stops at the root of its own target's tree (encapsulation
// — the event never escapes the shadow tree it was fired in). Everything else
// ascends to its `_parent`.
function eventParent(node, event, targetRoot) {
  if (node._isShadowRoot) {
    if (!event.composed && node === targetRoot) return null;
    return node.host || null;
  }
  const slot = flatTreeAssignedSlot(node);
  if (slot) return slot;
  return node._parent || null;
}

// Build the DOM event path: an ordered list of structs, one per visited node
// (target -> top; the Window is fired separately but flagged via reachesWindow
// so composedPath() can append it). Each struct carries `sat` (the
// shadow-adjusted target listeners on that node see), `rel` (relatedTarget
// retargeted against that node, or undefined when the event has none), and the
// `rootClosed` / `slotClosed` flags composedPath() uses to trim per
// encapsulation. Mirrors the spec dispatch loop, including the relatedTarget
// path-pruning (stop once the retargeted relatedTarget reaches the node we
// would enter — e.g. a mouseover whose relatedTarget is the host).
function buildFlatTreePath(origTarget, event) {
  const related = event.relatedTarget != null ? event.relatedTarget : null;
  const targetRoot = nodeRoot(origTarget);
  // DOM dispatch step: build a path (and dispatch at all) only if target is not
  // its own retargeted relatedTarget — unless they are literally identical. So
  // an event whose relatedTarget retargets up to the target itself (target is a
  // shadow-including ancestor of relatedTarget) is never dispatched.
  if (related && origTarget === retarget(related, origTarget) && origTarget !== related) {
    return { structs: [], reachesWindow: false };
  }
  const structs = [{
    node: origTarget,
    sat: origTarget,
    rel: related ? retarget(related, origTarget) : undefined,
    rootClosed: !!(origTarget._isShadowRoot && origTarget.mode === 'closed'),
    slotClosed: false
  }];
  let curTarget = origTarget;
  let curTargetRoot = targetRoot;
  // A slottable that is assigned has its assigned slot as the next event-parent;
  // remember it so the slot's struct can be flagged slot-in-closed-tree.
  let slottable = (isSlottableNode(origTarget) && flatTreeAssignedSlot(origTarget)) ? origTarget : null;
  let slotInClosedTree = false;
  let parent = eventParent(origTarget, event, targetRoot);
  while (parent) {
    if (slottable !== null) {
      slottable = null;
      const sr = nodeRoot(parent);   // `parent` is the slot
      if (sr._isShadowRoot && sr.mode === 'closed') slotInClosedTree = true;
    }
    if (isSlottableNode(parent) && flatTreeAssignedSlot(parent)) slottable = parent;
    const rel = related ? retarget(related, parent) : undefined;
    const rootClosed = !!(parent._isShadowRoot && parent.mode === 'closed');
    if (isShadowIncludingInclusiveAncestor(curTargetRoot, parent)) {
      // Still inside the current target's tree: listeners see the running target.
      structs.push({ node: parent, sat: curTarget, rel, rootClosed, slotClosed: slotInClosedTree });
    } else if (related && parent === rel) {
      // relatedTarget has caught up with the path: the rest is shared ancestry
      // both sides see as the same node, so it is pruned.
      break;
    } else {
      // Crossing into a lighter tree: the target retargets to this host.
      curTarget = parent;
      curTargetRoot = nodeRoot(parent);
      structs.push({ node: parent, sat: curTarget, rel, rootClosed, slotClosed: slotInClosedTree });
    }
    slotInClosedTree = false;
    parent = eventParent(parent, event, targetRoot);
  }
  const top = structs[structs.length - 1].node;
  return { structs, reachesWindow: !!(top && top.nodeType === NODE_DOC) };
}
