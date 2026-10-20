// DOM4 capture / target / bubble event dispatch walk.
//
// `dispatchEvent(target, event)` walks the ancestor path, fires
// window listeners at capture + bubble, runs target listeners, and
// queues the MutationObserver microtask checkpoint at end-of-task.
// HTML event-handler IDL attributes (`el.onclick = fn`, inline
// `onclick="…"`, `document.onkeydown`) are ordinary registered
// listeners (events.js), so they fire in registration order alongside
// addEventListener listeners — this walk has no separate on-handler pass.
//
// `dispatchEventForUserAction(target, event)` shares the same walk but
// drains V8's microtask checkpoint after every listener that runs,
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
// resolving to V8's `MicrotasksScope::PerformCheckpoint`, and is the event's
// `checkpoint` for the dispatch, which events.js runs after each callback
// while `window.event` is still set (`invokeEntries`).
//
// A click's activation (dom-nodes `activationBehavior`) is this walk's, however
// the click came — a script's `click()` or `dispatchEvent`, the user's — so it
// is ONE algorithm: file-saver's `saveAs` dispatches a MouseEvent at an
// `<a download>`, whose download Ruby's drain then saves.

import { NODE_DOC, isHtml } from './constants.js';
import { hasObservers, hasQueuedRecords, deliverMutations } from './mutation-observer.js';
import { fireWindowListeners }                         from './window-events.js';
import {
  dispatchWithOnHandler, eventPathOf, eventState, invokeEntries, listenerStoresOf, nodesListenTo, nodeStoresGen,
  NO_STORES, perRealmCurrentEvent, setNodeDispatch,
  setSourceRetargeter, InputEvent, Event as GlobalEvent
} from './events.js';
import { interfaceCheck, platformMicrotask } from './webidl.js';
import { activationTargetOf } from './form-helpers.js';
import { activationBehavior, hasShadowRoots, boundaryNid, legacyCanceledActivation, legacyPreActivation } from './dom-nodes.js';
import { lightDismissOpenDialogs } from './dialog.js';
import { lightDismissOpenPopovers } from './popover.js';
import { relativeOf, RELATIVE_ROOT } from './native-query-shadow.js';
import { DOMException } from './dom-exception.js';


// Fire the activation-behaviour `input` then `change` on a checkbox/radio whose
// checkedness just changed. Both are dispatched by the UA (the activation
// behaviour) → TRUSTED, even when the triggering click was a script `.click()` /
// untrusted dispatchEvent; `input` is composed and (like `change`) NOT
// cancelable, per the UI Events / HTML contract. The caller decides WHEN to fire
// (a click's activation, dom-nodes `activationBehavior`; a key's toggle).
export function fireCheckableActivation(node) {
  try { fireEvent(node, new InputEvent('input', { bubbles: true, cancelable: false, composed: true, view: globalThis })); } catch (_) {}
  try { fireEvent(node, new GlobalEvent('change', { bubbles: true, cancelable: false })); } catch (_) {}
}

export function dispatchEvent(target, event) {
  // Internal dispatch helper. It does NOT set `isTrusted` — most internal
  // callers fire script-equivalent synthetic events (el.click(), requestSubmit,
  // …) that must stay untrusted (the event keeps its constructed default,
  // false). The few genuinely UA-fired events that must be trusted set
  // `eventState(event).isTrusted = true` at their own call site before dispatching (or use
  // dispatchEventForUserAction / __csimDispatchTrusted). The validation throw
  // mirrors the IDL method (an event already mid-dispatch or never initialized
  // → InvalidStateError); UA callers pass fresh events.
  const state = event && eventState(event);
  if (state && (state.dispatchFlag || state.initialized === false)) {
    throw new DOMException(
      "The event is already being dispatched, or has not been initialized.", "InvalidStateError");
  }
  return dispatchPath(target, event, uaCheckpoint);
}
// The checkpoint the events the UA fires as a user's click is handled take on — its activation behaviour's input and
// change, a form's submit, an option's pick, a label's click forwarded to its control: run with no script on the stack,
// a microtask checkpoint follows each of their callbacks as it does the click's own. None while any dispatch's
// listeners run, whose script is on the stack, nor where the click itself took none (the testdriver shim's).
let uaCheckpoint = null;
// (…how many dispatches are under way: a user's action dispatched inside one is a step of it, with its checkpoint)
let dispatchDepth = 0;
// `steps` — a user's action a page's script plays (the testdriver shim's) — run as a step of that script, which is on
// the stack: no checkpoint between the listeners of what they dispatch.
export function asScriptSteps(steps) {
  const outer = uaCheckpoint;
  uaCheckpoint = null;
  dispatchDepth++;
  try { return steps(); } finally { dispatchDepth--; uaCheckpoint = outer; }
}
function withUACheckpoint(checkpoint, steps) {
  const outer = uaCheckpoint;
  uaCheckpoint = checkpoint;
  try { steps(); } finally { uaCheckpoint = outer; }
}

// Public EventTarget.dispatchEvent(event) IDL method (DOM-node targets). Per
// the DOM "dispatchEvent" steps, re-dispatching sets the event's isTrusted to
// false — a previously trusted (UA-fired) event becomes untrusted once script
// redispatches it.
export function dispatchEventPublic(target, event) {
  const state = event && eventState(event);
  if (state && (state.dispatchFlag || state.initialized === false)) {
    throw new DOMException(
      "The event is already being dispatched, or has not been initialized.", "InvalidStateError");
  }
  if (state) state.isTrusted = false;
  return dispatchPath(target, event, null);
}
setNodeDispatch(dispatchEventPublic);

// HTML "fire an event": the UA's own, trusted, dispatched by the steps — never through a `dispatchEvent` a page may have
// replaced, nor reporting it untrusted as a script's dispatch does. A node's over its tree; the window's or any other
// target's flat. Returns whether it was not canceled.
export function fireEvent(target, event) {
  if (target.__csimIsNode !== true) return dispatchWithOnHandler(target, event);
  eventState(event).isTrusted = true;
  return dispatchEvent(target, event);
}

// The events of a user's action (a Ruby-driven click / key / drop): trusted, and drained of microtasks
// between listeners (this file's head). A UI event of one is the UA's for the window the user acts in — its view that window, so
// its page position reads that window's scroll once dispatched too — and composed, but for the enter / leave ones
// (UI Events' and Pointer Events' tables), so a document's listener outside a shadow tree sees a click inside it.
const ENTER_LEAVE = new Set(['mouseenter', 'mouseleave', 'pointerenter', 'pointerleave']);
// (…an event of an interface told by its brand, never `instanceof`, which a page's Symbol.hasInstance answers)
let uiEventTest = null, mouseEventTest = null;
const isUIEvent    = (event) => (uiEventTest ??= interfaceCheck('UIEvent'))(event);
const isMouseEvent = (event) => (mouseEventTest ??= interfaceCheck('MouseEvent'))(event);
export function dispatchEventForUserAction(target, event) {
  const state = eventState(event);
  state.isTrusted = true;
  // (…the activation notification steps first, where it is an activation triggering input event: user_activation.rs)
  globalThis.__dom.userInputNotify(state.type, state.key ?? '', state.pointerType ?? '');
  if (isUIEvent(event)) {
    state.view = globalThis;
    state.composed = !ENTER_LEAVE.has(state.type);
  }
  const checkpoint = dispatchDepth > 0 ? uaCheckpoint : globalThis.__csim_yield || null;
  const result = dispatchPath(target, event, checkpoint);
  // (…a user's press and release light-dismissing the popovers and the dialogs they fall outside — HTML's pointer event
  // hook)
  if (state.type === 'pointerdown' || state.type === 'pointerup') {
    lightDismissOpenPopovers(event, target);
    lightDismissOpenDialogs(event, target);
  }
  return result;
}

// (…and the driver's own grant of it, `test_driver.bless`, on whichever window it names)
globalThis.__csimActivationNotify = () => globalThis.__dom.activationNotify();

function dispatchPath(target, event, checkpoint) {
  dispatchDepth++;
  try {
    return walkPath(target, event, checkpoint);
  } finally {
    dispatchDepth--;
  }
}
function walkPath(target, event, checkpoint) {
  const state = eventState(event);
  state.target = target;
  state.dispatchFlag = true;   // re-dispatching this event mid-flight → InvalidStateError
  // `path` is the ordered list of nodes the event visits, target -> top
  // (window is fired separately below). `structMap` (shadow case only)
  // maps each path node to its DOM "event path" struct {sat, rel, flags}
  // — the per-listener shadow-adjusted target, retargeted relatedTarget,
  // and the flags composedPath() and `window.event` need.
  let path, pathStores = null, pathStoresGen = 0;   // (…the stores along it, where the engine handed them over with it)
  let structMap = null;          // node -> struct, only when a shadow exists
  let topSat = target;           // shadow-adjusted target the window listeners see
  let windowRel;                 // relatedTarget retargeted against the window
  let clearTargets = false;      // DOM "clear targets": null out target post-dispatch
  const origRelated = state.relatedTarget;
  // FAST PATH (no shadow tree on the way): the flattened tree IS the
  // node tree, no retargeting, no slot crossings: target -> root, with
  // `event.target` pinned to the real target.
  // This is the hot path on every app suite (rule 3) — one array, no
  // per-node struct allocation, no slot lookups — and the engine's: the path and the listener stores along it in one
  // call (`eventPathOf`). A shadow root met on the way — a frame's, whose realm's are
  // not this one's to count — takes the flat tree's path after all.
  let shadowed = hasShadowRoots();
  const listened = shadowed || nodesListenTo(state.type);
  if (!listened) {
    pathStores = NO_STORES;
    pathStoresGen = nodeStoresGen();
  }
  if (!shadowed) {
    const found = eventPathOf(target);
    if (found === null) {
      shadowed = true;
    } else if (found !== undefined) {
      path = found[0];
      if (listened) {
        pathStores = found[1];
        pathStoresGen = nodeStoresGen();
      }
    } else {
      // (…a node the engine holds no slot for — an Attr — is its own path)
      path = [target];
    }
  }
  if (shadowed) {
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
    // composedPath() reads these back from within a listener (the window the path goes on to, below, appended).
    state.csimPath = structs;
    state.csimStructMap = structMap;
  }
  // The Window the path goes on to (DOM "get the parent" of a Document): its browsing context's — none for an inert
  // document's, a detached node's, or a `load` (an empty path, a suppressed dispatch, reaches none either).
  const win = state.csimPathWindow = pathWindow(path, event);
  if (structMap && win) state.csimPath = state.csimPath.concat([{ node: win, flags: 0 }]);
  // Legacy `window.event` — IE-era global that handlers reach for
  // when no event parameter is in scope. Redmine's inline-autocomplete
  // `values()` callback (`event.target.type === 'text'`) and a few
  // other library entry points rely on it. It is set around each listener's
  // call on that listener's realm's global (events.js `invokeEntries`, which
  // every dispatch's listeners are called through) — not for one whose node is
  // in a shadow tree — so a CROSS-realm listener on a node
  // (`el.addEventListener('x', frames[0].fn)`) reads this event from its own
  // `window.event`, and the dispatching realm's stays what it was meanwhile.
  // Whether that realm needs finding is asked once, for the whole dispatch.
  const perRealm = perRealmCurrentEvent();
  // (…the microtask checkpoint after each callback, a user's action's: the head of this file)
  const prevCheckpoint = state.checkpoint, outerUACheckpoint = uaCheckpoint;
  if (checkpoint !== null) state.checkpoint = checkpoint;
  uaCheckpoint = null;
  // The click's activation target — the nearest element with activation behaviour on its event path (DOM dispatch; the
  // engine's, element_state.rs `activation_target`) — found before any listener runs, which may move the node clicked:
  // its activation behaviour is the one this click has, run once the dispatch is over (below), or its legacy-pre-activation
  // behaviour undone where the click was canceled. (A click that is no MouseEvent activates nothing.)
  const act = state.type === 'click' && isMouseEvent(event) && target && target._nid != null
    ? activationTargetOf(target, !!state.bubbles, !!state.composed) : null;
  let pre = null;
  try {
    if (act !== null) pre = legacyPreActivation(act);
    // Capture: window → root → target's parent. Turbo Drive's
    // FormSubmitObserver / LinkClickObserver attach to `window` with
    // `{capture: true}` and call `event.preventDefault()` to take
    // over the navigation / submission; skipping the window hop
    // means every form falls through to the Ruby-side
    // submit_form_handle without Turbo's turbo-stream Accept header,
    // and the receiving controller (e.g. Avo actions) raises
    // `ActionController::UnknownFormat`.
    state.eventPhase = 1;
    // window sits outside every shadow tree -> it sees the topmost
    // shadow-adjusted target and the fully-retargeted relatedTarget.
    if (structMap) {
      state.target = topSat;
      if (windowRel !== undefined) state.relatedTarget = windowRel;
    }
    // An empty path means the dispatch was suppressed (target is its own
    // retargeted relatedTarget) — nothing, not even window, is invoked.
    // Each node's listener store, the whole path's at once — again, where a node has gained one since.
    let stores = pathStores, storesGen = pathStoresGen;
    if (stores === null) {
      stores = listenerStoresOf(path, state.type);
      storesGen = nodeStoresGen();
    }
    const storeAt = (i) => {
      if (storesGen !== nodeStoresGen()) {
        stores = listenerStoresOf(path, state.type);
        storesGen = nodeStoresGen();
      }
      return stores[i];
    };
    fireOnWindow(win, event, true, perRealm);
    if (!state.propagationStopped) {
      for (let i = path.length - 1; i > 0; i--) {
        fireListeners(path[i], event, true, storeAt(i), perRealm);
        if (state.propagationStopped) break;
      }
    }
    if (path.length && !state.propagationStopped) {
      state.eventPhase = 2;
      // At AT_TARGET the spec visits the target in BOTH the capture and the
      // bubble traversal, so its CAPTURING listeners fire before its
      // non-capturing ones (independent of registration order), and a
      // stopPropagation() in a capturing target listener suppresses the
      // non-capturing ones (the bubble-traversal `invoke` bails on the
      // stop-propagation flag).
      fireListeners(target, event, true, storeAt(0), perRealm);
      if (!state.propagationStopped) fireListeners(target, event, false, storeAt(0), perRealm);
    }
    if (path.length && !state.propagationStopped && state.bubbles) {
      state.eventPhase = 3;
      // `submit` / `reset` events do not bubble past an ancestor <form>:
      // a nested form's submission never reaches an outer form's listeners
      // (nor anything above it, including window). The CAPTURE phase is
      // unaffected — only the upward bubble is truncated at the first
      // ancestor form. The spec is silent here; this matches Chromium /
      // Firefox (DOM Event-dispatch-single-activation-behavior, where an
      // inner form nested in an outer form must activate only the inner).
      let bubbleLimit = path.length;
      if (state.type === 'submit' || state.type === 'reset') {
        for (let i = 1; i < path.length; i++) {
          const n = path[i];
          if (isHtml(n, 'form')) { bubbleLimit = i; break; }
        }
      }
      for (let i = 1; i < bubbleLimit; i++) {
        fireListeners(path[i], event, false, storeAt(i), perRealm);
        if (state.propagationStopped) break;
      }
      if (!state.propagationStopped && bubbleLimit === path.length) {
        if (structMap) {
          state.target = topSat;
          if (windowRel !== undefined) state.relatedTarget = windowRel;
          state.eventPhase = 3;       // per-node overrides may have left it AT_TARGET
        }
        fireOnWindow(win, event, false, perRealm);
      }
    }
    // `<option>` selection: a TRUSTED click on an option in a `<select>` toggles or picks it — the customizable popup's /
    // listbox's option click — firing input and change on the select. An option has no activation behaviour: this is
    // the UA's listbox input handling, so a script's `dispatchEvent(click)` selects nothing (as in real browsers).
    if (!state.canceled && state.isTrusted && state.type === 'click' && isMouseEvent(event) &&
        target && isHtml(target, 'option') && typeof globalThis.__csimToggleOptionByClick === 'function') {
      withUACheckpoint(checkpoint, () => globalThis.__csimToggleOptionByClick(target));
    }
  } finally {
    // Per spec, the end of dispatch resets the event to its post-dispatch
    // state: eventPhase NONE, currentTarget null, empty path (so
    // composedPath() returns []), and the dispatch / stop-propagation /
    // stop-immediate flags unset (so the event can be re-dispatched and
    // reports cancelBubble=false afterwards). `finally` survives a
    // throwing listener.
    state.eventPhase = 0;
    state.currentTarget = null;
    state.dispatchFlag = false;
    state.csimPathWindow = null;
    state.propagationStopped = false;
    state.immediatePropagationStopped = false;
    // An InputEvent's target ranges end with its dispatch, as Chrome's do: a captured event read afterwards has none
    // (input-events-get-target-ranges).
    if (state.targetRanges !== undefined) state.targetRanges = [];
    // Per spec, MutationObserver delivery is the microtask checkpoint
    // — synchronous flush at end-of-dispatchEvent re-enters Trix's
    // reparse → loadHTML inside its own custom-event dispatch and
    // pegs the heap (the observer's stop()/start() bracket relies on
    // delivery happening after Trix's synchronous code finishes).
    // Schedule via microtask; settle's drain_microtasks picks it up
    // in the same iteration.
    if (hasObservers() && hasQueuedRecords()) platformMicrotask(deliverMutations);
    state.checkpoint = prevCheckpoint;
    uaCheckpoint = outerUACheckpoint;
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
          state.target = null;
          state.relatedTarget = null;
        } else {
          // Not cleared: the event keeps its topmost shadow-adjusted target
          // and fully-retargeted relatedTarget (e.g. both retargeted to their
          // respective hosts for a composed cross-tree event).
          state.target = topSat;
          if (windowRel !== undefined) state.relatedTarget = windowRel;
        }
      }
      state.csimPath = null;
      state.csimStructMap = null;
    }
  }
  // The activation behaviour runs AFTER the dispatch cleanup above (DOM: once the event's state has been reset), so a
  // listener of what it fires — a checkbox's `change` — sees the click in its post-dispatch state and may even dispatch
  // it again.
  if (act !== null) {
    withUACheckpoint(checkpoint, () => {
      if (!state.canceled) activationBehavior(act, event, target, pre);
      else if (pre) legacyCanceledActivation(act, pre);
    });
  }
  return !state.canceled;
}

// A node's listeners of one pass (`capture`) — its `store`, the listener store along the path the walk holds.
function fireListeners(node, event, capture, store, perRealm) {
  const state = eventState(event);
  let shadowed = false;
  // Shadow DOM: a listener sees `event.target` retargeted to whatever it
  // is allowed to observe (the shadow-adjusted target) and a likewise
  // retargeted `relatedTarget`. `_csimStructMap` is only set when a
  // ShadowRoot exists, so the common non-shadow case skips this branch
  // entirely (no map lookup; target stays as assigned by dispatchPath).
  if (state.csimStructMap) {
    const s = state.csimStructMap.get(node);
    if (s) {
      state.target = s.sat;
      if (s.rel !== undefined) state.relatedTarget = s.rel;
      // A node that is its own shadow-adjusted target (the host of a crossed
      // shadow tree, seen from the lighter tree) is AT_TARGET even though the
      // capture/bubble walk reaches it mid-path — not CAPTURING/BUBBLING.
      state.eventPhase = s.sat === node ? 2 : (capture ? 1 : 3);
    }
    // `window.event` hides the event from listeners inside a shadow tree — the one the node was in as the path was
    // built, wherever a listener has moved it since.
    shadowed = !!s && (s.flags & STEP_IN_SHADOW) !== 0;
  }
  // HTML event-handler IDL attributes (`el.onclick` / inline `onclick="…"` /
  // `document.onkeydown` / `shadowRoot.onslotchange`) are ordinary registered
  // listeners (see events.js installEventHandlerAttrs / syncInlineEventHandler):
  // the IDL setter and every content-attribute mutation add a wrapper listener to
  // the node's listener store, so they fire below at their true registration position — no
  // separate on-handler pass, and Text / Comment / handler-less nodes pay nothing.
  if (!store || !store[state.type]?.length) return;
  state.currentTarget = node;
  // …each called as the flat dispatch calls it (`invokeEntries`).
  invokeEntries(state, event, store, capture, node, perRealm, shadowed);
}

// ---------------------------------------------------------------------------
// Shadow-DOM event path (DOM "dispatch" algorithm). Only reached when a shadow
// tree exists on the page (see the `hasShadowRoots()` gate in dispatchPath).
// ---------------------------------------------------------------------------

// The Window `path` goes on to: the defaultView of the Document at its top, but for a `load`.
function pathWindow(path, event) {
  const top = path.length ? path[path.length - 1] : null;
  return top && top._nodeType === NODE_DOC && eventState(event).type !== 'load' ? top._window : null;
}
// Fire `win`'s listeners for a dispatch over its document — through its own realm's window phase where it is another
// realm's window.
function fireOnWindow(win, event, capture, perRealm) {
  if (!win) return;
  if (win === globalThis) fireWindowListeners(event, capture, perRealm);
  else if (typeof win.__csimFireWindowListeners === 'function') win.__csimFireWindowListeners(event, capture);
}

// A node's tree root, the engine's: a shadow root is the root of its own tree (an Attr, in none, its own).
function nodeRoot(node) {
  return relativeOf(node, RELATIVE_ROOT) ?? node;
}

// DOM "retarget" (https://dom.spec.whatwg.org/#retarget), the engine's (event_path.rs): bubble `a` up out of any shadow
// tree that `b` cannot see, so a listener on `b` observes the nearest host instead of an encapsulated node. Used for both
// the shadow-adjusted target and relatedTarget. `b` may be the Window (not a node): no node's root is its ancestor, so
// `a` retargets all the way out.
export function retarget(a, b) {
  if (!a || a._nodeType === undefined) return a;
  const answer = globalThis.__dom.retarget(boundaryNid(a), b && b._nodeType !== undefined ? boundaryNid(b) : null);
  return answer[0] || a;
}
setSourceRetargeter(retarget);

// Build the DOM event path, the engine's (event_path.rs `eventPath`): an ordered list of structs, one per visited node
// (target -> top; the Window, fired separately, is appended to composedPath() by the caller). Each
// struct carries `sat` (the shadow-adjusted target listeners on that node see), `rel` (relatedTarget retargeted against
// that node, or undefined when the event has none), and its `flags` — the closed-root / closed-slot ones composedPath()
// trims by, and `STEP_IN_SHADOW`. Empty where the event is not dispatched at all (its target is its own retargeted
// relatedTarget).
const STEP_IN_SHADOW = 4;   // (event_path.rs's: the node's root is a shadow root)
function buildFlatTreePath(origTarget, event) {
  const state = eventState(event);
  const related = state.relatedTarget != null ? state.relatedTarget : null;
  const relatedNode = related !== null && related._nodeType !== undefined;
  const [nodes, steps] = globalThis.__dom.eventPath(boundaryNid(origTarget), relatedNode ? boundaryNid(related) : null, related !== null && !relatedNode, !!state.composed);
  if (steps.length === 0) return { structs: [] };
  const structs = new Array(steps.length / 4);
  for (let i = 0, k = 0; k < steps.length; i++, k += 4) {
    const rel = steps[k + 2];
    structs[i] = {
      node: nodes[steps[k]],
      sat: nodes[steps[k + 1]],
      rel: rel === -1 ? undefined : rel === -2 ? related : nodes[rel],
      flags: steps[k + 3]
    };
  }
  return { structs };
}
