// DOM events: what their generated bindings (generated/bindings.js) leave to an implementation, and EventTarget: its
// listeners, a flat dispatch and event handlers. A node's capture / target / bubble dispatch lives in dispatch.js.

import { bodyOf, documentElementOf } from './document-tree.js';
import { SANDBOXED_SCRIPTS, sandboxed } from './document-origin.js';
import {
  PLATFORM,
  appendTo,
  blankList,
  interfaceCheck,
  isCallable,
  isObject,
  listAppended,
  listCopy,
  hasSlots,
  makeSlots,
  listWithout,
  reflectApply,
  registerInterface,
  resolvedPromise,
  runningCallbacks,
  scriptOnStack,
  slotsOf,
  thisIs,
  toDOMString,
  toFloat,
  objectCreate
} from './webidl.js';
import {
  FORWARDED_EVENT_HANDLERS,
  LEGACY_HANDLER_EVENT_TYPES,
  defineAnimationEvent,
  defineAnimationPlaybackEvent,
  defineBeforeUnloadEvent,
  defineClipboardEvent,
  defineCloseEvent,
  defineCommandEvent,
  defineCompositionEvent,
  defineCustomEvent,
  defineDeviceMotionEvent,
  defineDeviceMotionEventAcceleration,
  defineDeviceMotionEventRotationRate,
  defineDeviceOrientationEvent,
  defineDragEvent,
  defineErrorEvent,
  defineEvent,
  defineFocusEvent,
  defineFontFaceSetLoadEvent,
  defineFormDataEvent,
  defineGamepadEvent,
  defineHashChangeEvent,
  defineIDBVersionChangeEvent,
  defineInputEvent,
  defineKeyboardEvent,
  defineMediaQueryListEvent,
  defineMessageEvent,
  defineMouseEvent,
  definePageTransitionEvent,
  definePointerEvent,
  definePopStateEvent,
  defineProgressEvent,
  definePromiseRejectionEvent,
  defineStorageEvent,
  defineSubmitEvent,
  defineTextEvent,
  defineToggleEvent,
  defineTouchEvent,
  defineTouchList,
  defineTransitionEvent,
  defineUIEvent,
  defineWheelEvent,
  installEventTarget,
  defineTouch
} from './generated/bindings.js';
import { DOMException } from './dom-exception.js';
import { rareDataOf, stampedRareDataOf, nodeDocumentOf } from './native-query-shadow.js';
import { realmNested } from './realm-nesting.js';
import { EVENT_TARGET_BEHIND, isNode, markEventTargetPrototype, nidOf, nodeTypeOf, prototypeVerdictOf } from './node-identity.js';
import { defaultViewOf } from './document-state.js';
import { dom, hooksOf, hostNamespace, hostSteps, isSameOriginDomainWindow, isWindowProxy, listMap, listOf, rawWindowOf, realmOfGlobal } from './engine.js';

// Map any window global in a composedPath result to the active-listener realm's
// WindowProxy, so a cross-realm listener sees `composedPath()` entries === its own
// `contentWindow`/`parent` (shadow event-dispatch/test-003).
function retargetWindowsInPath(path) {
  // Single-realm pages can't have a cross-realm window to retarget — skip the
  // per-element native-crossing scan entirely (rule 3).
  if (!globalThis.__csimMultiRealm || !globalThis.__csimMultiRealm()) return path;
  if (!globalThis.__csimRetargetWindow) return path;
  for (let i = 0; i < path.length; i++) {
    if (realmOfGlobal(path[i]) !== null) path[i] = globalThis.__csimRetargetWindow(path[i]);
  }
  return path;
}

// https://dom.spec.whatwg.org/#default-passive-value — a listener for one of
// these event types defaults to passive (preventDefault becomes a no-op) when
// registered on the Window, a Document, or its node document's document element or body element (not any element
// named body: one a script made, or one nested in another) and the `passive` option is omitted. Explicit
// `{passive: …}` always wins.
const PASSIVE_DEFAULT_EVENTS = { __proto__: null, touchstart: true, touchmove: true, wheel: true, mousewheel: true };
export function defaultPassiveValue(type, target) {
  if (PASSIVE_DEFAULT_EVENTS[type] !== true) return false;
  if (windowOf(target) !== null) return true;                   // a Window, this realm's or another's
  const nt = target && nodeTypeOf(target);
  if (nt === 9) return true;                                    // Document
  if (nt === 1 && nodeDocumentOf(target)) {                      // documentElement / body
    const doc = nodeDocumentOf(target);
    if (target === documentElementOf(doc) || target === bodyOf(doc)) return true;
  }
  return false;
}

// Spec "inner invoke": a `once` listener is removed *before* its callback runs.
// Set `removed` so an in-flight dispatch's list skips the
// still-referenced entry (keeping a self-re-dispatching `once` callback from
// re-entering itself), and take it out of the live array so the stored list
// doesn't accumulate fired one-shots.
// (…a listener list a page's script never holds nor its Array.prototype reaches: each element by position, and written as
// webidl.js's list helpers do — a dispatch walks none by an iterator a page may have replaced)
function removeOnceListener(entry, store, type) {
  entry.removed = true;
  const list = store[type];
  for (let i = 0; i < list.length; i++) {
    if (list[i] === entry) {
      store[type] = list.length === 1 ? [] : listWithout(list, i);
      return;
    }
  }
}

// The event interfaces' classes and members are generated from their IDL (script/gen_bindings.mjs `eventInterface`): what
// follows is what the IDL does not say — each `impl`, the steps of the members no slot answers, handed the event's state.
// (…`new X(PLATFORM, type, init)` the engine's own making of one, its init as its steps give it, never converted)

// The Event interface (DOM §2.2): its state its internal slots (`eventState`, made in event-state.js), which the dispatch
// writes, `currentTarget` a prototype getter a page may shadow on an event (selector-set / Rails-UJS-style delegation:
// `Object.defineProperty(event, 'currentTarget', {get: …})`, which Mastodon's `data-method` handler reads).
export const Event = defineEvent({
  composedPath: composedPathOf,
  stopPropagation(state) { state.propagationStopped = true; },
  // Legacy `cancelBubble`: the stop-propagation flag; setting it true stops propagation, false does nothing.
  get_cancelBubble: (state) => state.propagationStopped,
  set_cancelBubble(state, value) { if (value) state.propagationStopped = true; },
  stopImmediatePropagation(state) {
    state.propagationStopped = true;
    state.immediatePropagationStopped = true;
  },
  // Legacy `returnValue`: whether the default action is still allowed; false cancels it, true does nothing.
  get_returnValue: (state) => !state.canceled,
  set_returnValue(state, value) { if (!value) cancelEvent(state); },
  preventDefault: cancelEvent
});
function composedPathOf(state) {
  // Outside dispatch the event's path is empty, so composedPath() is the
  // empty list (the dispatch algorithm empties it on cleanup). Library
  // probes read it from within a listener, where the flag is set.
  if (!state.dispatchFlag) return [];
  // (…a flat dispatch's path its one invocation target — the window's for its `load`, whose target is the document)
  if (state.csimFlatTarget) {
    const flat = [state.csimFlatTarget], parents = state.csimFlatParents;
    for (let i = 0; i < parents.length; i++) appendTo(flat, parents[i]);
    return retargetWindowsInPath(flat);
  }
  const structs = state.csimPath;
  if (!structs) {
    // FAST PATH (no shadow trees): the flattened tree is the node tree, so
    // composedPath is the path the dispatch took, target to root, as it took it
    // — wherever a listener has moved a node since — plus the window it went on
    // to (none for an inert document's or a `load`). No retargeting, no
    // per-listener trimming.
    return retargetWindowsInPath(state.csimPathWindow ? listAppended(state.csimNodePath, state.csimPathWindow) : listCopy(state.csimNodePath));
  }
  // Shadow case: the precomputed event path trimmed to what `currentTarget` may observe — none of a closed shadow tree
  // it is outside of — by the root-of-closed-tree / slot-in-closed-tree flags each step carries (event_path.rs).
  const ct = state.currentTarget;
  let current = structs.length - 1;
  while (current >= 0 && structs[current].node !== ct) current--;
  // currentTarget isn't on the recorded path (e.g. a window listener whose
  // window was never appended because the event didn't reach the document, or
  // a delegated handler that reassigned currentTarget). Per the dispatch model
  // such a listener sees the whole path it observed — return every node
  // untrimmed rather than emit a malformed (window-led) list.
  const nodes = blankList(structs.length), flags = blankList(structs.length);
  for (let i = 0; i < structs.length; i++) {
    nodes[i] = structs[i].node;
    flags[i] = structs[i].flags;
  }
  if (current === -1) return retargetWindowsInPath(nodes);
  const steps = dom.composedPath(flags, current), path = blankList(steps.length);
  for (let i = 0; i < steps.length; i++) path[i] = nodes[steps[i]];
  return retargetWindowsInPath(path);
}
// An event's state — any realm's event's: its internal slots, every interface's of it in one record.
export const eventState = (ev) => slotsOf(ev, 'Event');
// The window `o` is: this realm's global, another realm's (a WindowProxy unwrapped), or none — what tells a Window
// apart (window.js's members' `this`; a UIEvent's `view`), registered here, before the event interfaces taking one.
// (…a worker's global none: worker-globals.js makes this realm's one a worker's)
let realmIsWindow = true;
export function markWorkerRealm() { realmIsWindow = false; }
function windowOf(o) {
  if (o === globalThis) return realmIsWindow ? o : null;
  if (o === null || (typeof o !== 'object' && typeof o !== 'function')) return null;
  const raw = rawWindowOf(o);
  return (raw === globalThis && realmIsWindow) || (raw !== globalThis && realmOfGlobal(raw) !== null) ? raw : null;
}
registerInterface('Window', (o) => windowOf(o) !== null);

// DOM "set the canceled flag": a cancelable event's, unless a passive listener is the one asking.
function cancelEvent(state) {
  if (state.cancelable && !state.inPassiveListener) state.canceled = true;
}

// DOM "retarget", dispatch.js's, which it hands this module: a ToggleEvent's and a CommandEvent's source against the
// event's current target (HTML) — a shadow tree's invoker reads as its host outside the tree — and a flat dispatch's
// relatedTarget against its target.
let retarget = (source) => source;
export function setRetargeter(fn) { retarget = fn; }
const sourceSteps = {
  init(state, init) { state.source = init.source; },
  get_source: (state) => (state.source == null ? null : retarget(state.source, state.currentTarget))
};

// CustomEvent (DOM §2.4): its `detail`, and the legacy `initCustomEvent` (Trix's `document.createEvent('CustomEvent')`).
export const CustomEvent = defineCustomEvent(Event);

// UIEvent — base for any event with a `view` (window) + `detail`
// (click count, wheel delta). Spec parent of MouseEvent / KeyboardEvent /
// FocusEvent / WheelEvent / CompositionEvent / InputEvent.
// (…`which` the legacy alias Chrome and Firefox answer: a mouse event's button + 1, a keyboard event's key code, 0 for
// any other — the init's own `which` neither reads)
export const UIEvent = defineUIEvent(Event, {
  get_which: (state) => (state.button !== undefined ? state.button + 1 : state.keyCode !== undefined ? state.keyCode : 0)
});
export const FocusEvent = defineFocusEvent(UIEvent);
// (…its legacy initialisation, which takes no `detail`, resets it: Chrome's and Firefox's)
export const CompositionEvent = defineCompositionEvent(UIEvent, {
  initialized(state) { state.detail = 0; }
});

// Legacy `TextEvent` (UIEvent subtype) — kept distinct from CompositionEvent so
// `document.createEvent("TextEvent")` reports the right interface: which makes one, its IDL having no constructor.
// (…its legacy initialisation, which takes no `detail`, resets it: Chrome's and Firefox's)
export const TextEvent = defineTextEvent(UIEvent, {
  initialized(state) { state.detail = 0; }
});
export const createTextEvent = () => new TextEvent(PLATFORM, '', { bubbles: false, cancelable: false, composed: false, view: null, detail: 0, data: '' });

// Device sensor events (DeviceOrientation Event): a page feature-detects them and constructs them; no sensor here
// fires one. A motion's acceleration and rotation rate are objects of their own interfaces, made from the init's.
// (…no sensor to ask a permission of: denied, as a desktop's browser without one answers)
export const DeviceMotionEvent = defineDeviceMotionEvent(Event, {
  init(state, init) {
    state.acceleration                 = motionVector(DeviceMotionEventAcceleration, init.acceleration);
    state.accelerationIncludingGravity = motionVector(DeviceMotionEventAcceleration, init.accelerationIncludingGravity);
    state.rotationRate                 = motionVector(DeviceMotionEventRotationRate, init.rotationRate);
  },
  requestPermission: () => resolvedPromise('denied')
});
// (…none where the init gives none, an object of its interface wherever it gives one, empty too: Chrome's)
function motionVector(binding, init) {
  return init ? binding.create(init) : null;
}
const DeviceMotionEventAcceleration = defineDeviceMotionEventAcceleration({
  init(slots, init) { slots.x = init.x; slots.y = init.y; slots.z = init.z; }
});
const DeviceMotionEventRotationRate = defineDeviceMotionEventRotationRate({
  init(slots, init) { slots.alpha = init.alpha; slots.beta = init.beta; slots.gamma = init.gamma; }
});
export const DeviceMotionEventAccelerationInterface = DeviceMotionEventAcceleration.interface;
export const DeviceMotionEventRotationRateInterface = DeviceMotionEventRotationRate.interface;

export const DeviceOrientationEvent = defineDeviceOrientationEvent(Event, {
  requestPermission: () => resolvedPromise('denied')
});


// Touch Events: a touch point (Touch, its init's members in its slots), a list of them (TouchList, made by the platform
// alone), and the event carrying three such lists. No touchscreen input is modelled — a page's own constructions are all
// there are — but the interfaces are the IDL's, so a library feature-detecting or synthesizing them gets real ones.
const touchOf = (o) => slotsOf(o, 'Touch');
export const Touch = defineTouch({
  construct(s, init) {
    makeSlots(s.owner, 'Touch', init);
    // (TouchInit gives the two angles as `double`, Touch answers them as `float` — the spec's own mismatch: each is
    // converted to its attribute's type here, as a float member of the init already is)
    for (const name of ['altitudeAngle', 'azimuthAngle']) {
      s[name] = toFloat(init[name], `Failed to construct 'Touch': Failed to read the '${name}' property from 'TouchInit': `);
    }
    // (…and its unadjusted target, none until an event it is in is dispatched: Touch Events' retargeting steps)
    s.unadjustedTarget = null;
  }
});
const touchList = defineTouchList({
  init(s, touches) { s.touches = touches; },
  item: (s, index) => (index < s.touches.length ? s.touches[index] : null),
  get_length: (s) => s.touches.length
});
export const TouchListInterface = touchList.interface;

export const TouchEvent = defineTouchEvent(UIEvent, {
  init(state, init) {
    state.modifiers      = modifierBits(init);
    state.touches        = touchList.create(init.touches);
    state.targetTouches  = touchList.create(init.targetTouches);
    state.changedTouches = touchList.create(init.changedTouches);
    state.touchPoints    = touchPointsOf(init);
  },
  getModifierState: modifierState
});
// …and each distinct touch of the three lists, which its dispatch retargets.
function touchPointsOf(init) {
  const points = [], lists = [init.touches, init.targetTouches, init.changedTouches];
  for (let i = 0; i < lists.length; i++) {
    const list = lists[i];
    for (let j = 0; j < list.length; j++) {
      let k = 0;
      while (k < points.length && points[k] !== list[j]) k++;
      if (k === points.length) appendTo(points, list[j]);
    }
  }
  return points;
}


// DOM dispatch's touch target list, a TouchEvent's touches' targets (Touch Events' retargeting steps, which keep the
// target each Touch was made with as its unadjusted target): each retargeted against the object whose listeners run
// (`against`, DOM's path item — a node in a closed shadow tree seen from outside it as its host; none for the Window,
// which no tree holds), or none where the dispatch cleared its targets. (The Touch itself carries it, as Touch Events
// has it: a dispatch nested in a listener that shares a Touch leaves it the nested one's until the next item.)
export function retargetTouches(state, against, cleared = false) {
  const points = state.touchPoints;
  if (points === undefined) return;
  for (let i = 0; i < points.length; i++) {
    const t = touchOf(points[i]);
    if (t.unadjustedTarget === null) t.unadjustedTarget = t.target;
    t.target = cleared ? null : retarget(t.unadjustedTarget, against);
  }
}

// …and the nodes a TouchEvent's touches were made at (their unadjusted targets), for the dispatch's clearTargets: none
// for any other event.
export function touchTargetNodes(state) {
  const points = state.touchPoints;
  if (points === undefined) return undefined;
  const nodes = [];
  for (let i = 0; i < points.length; i++) {
    const t = touchOf(points[i]);
    const target = t.unadjustedTarget ?? t.target;
    if (target != null && nodeTypeOf(target) !== undefined) appendTo(nodes, target);
  }
  return nodes;
}

// A request's progress (XHR's ProgressEvent): whether its length is known, how much of it has loaded, of how much.
export const ProgressEvent = defineProgressEvent(Event);

// HTML's navigation events: a history traversal's `popstate` (its state), a fragment navigation's `hashchange` (the two
// URLs), a document's `pageshow` / `pagehide` (whether it is kept in the back/forward cache, which no document here
// is). Turbo and history-API polyfills construct the first two.
export const PopStateEvent = definePopStateEvent(Event);
export const HashChangeEvent = defineHashChangeEvent(Event);
export const PageTransitionEvent = definePageTransitionEvent(Event);

// A storage area's change, fired at another same-origin document (storage.js, whose members take a Storage).
export const StorageEvent = defineStorageEvent(Event);

// A script's error, reported at its global (`error` — whose handler the event handler processing algorithm calls with
// its five values, so an event of any realm: its brand), and a promise's rejection no handler took (`unhandledrejection`,
// `rejectionhandled`). An ErrorEvent's `error` is `any`, undefined where it was not given.
export const ErrorEvent = defineErrorEvent(Event);
export const PromiseRejectionEvent = definePromiseRejectionEvent(Event);

// A media query list's `change` (CSSOM View): whether it matches now, and its query. A database's version change
// (IndexedDB's `upgradeneeded`): its old version and its new. A font set's load (CSS Font Loading's `loadingdone`,
// `loadingerror`): the faces it loaded, a frozen array.
export const MediaQueryListEvent = defineMediaQueryListEvent(Event);
export const IDBVersionChangeEvent = defineIDBVersionChangeEvent(Event);
export const FontFaceSetLoadEvent = defineFontFaceSetLoadEvent(Event);

// A WebSocket's closing (`close`): whether it closed cleanly, its code and its reason.
export const CloseEvent = defineCloseEvent(Event);

// A CSS animation's and a CSS transition's events (css-animations, css-transitions: their name or property, the time
// elapsed, the pseudo-element — and, of their level 2, the CSSAnimation / CSSTransition itself), and a Web Animation's
// `finish` / `cancel` (its current time and its timeline's).
export const AnimationEvent = defineAnimationEvent(Event);
export const TransitionEvent = defineTransitionEvent(Event);
export const AnimationPlaybackEvent = defineAnimationPlaybackEvent(Event);

// Whether anything could hear a CSS animation or transition event of `type` at an element of this realm's document: a
// node ever had a listener of it, whichever realm's script added it, or the window — where the event bubbles to — has
// one (an event handler attribute or property among them, which registers one). One nothing could hear carries no
// object, and making one for each of a thousand transitions a page starts at once is what it would cost.
export function listensForAnimationEvent(type) {
  const store = listenersOf(globalThis), list = store && store[type];
  return (list !== undefined && list.length > 0) || nodesListenTo(type);
}

// A form's entry list as it is constructed (`formdata`), and its submission (`submit`, whose submitter is the button
// that submitted it, if one did); a popover's, a dialog's or a details element's change of state (`beforetoggle`,
// `toggle`: from and to "open" / "closed", and the element that asked for it).
export const FormDataEvent = defineFormDataEvent(Event);
export const SubmitEvent = defineSubmitEvent(Event);
export const ToggleEvent = defineToggleEvent(Event, sourceSteps);

// A command invoker's (HTML §4.10.6): fired at its target, its invoker the source and the command its `command`.
export const CommandEvent = defineCommandEvent(Event, sourceSteps);

// A document's unloading (`beforeunload`): no constructor of its IDL's — `document.createEvent('BeforeUnloadEvent')` and
// the UA make one — its returnValue the legacy prompt text, a DOMString of its own.
export const BeforeUnloadEvent = defineBeforeUnloadEvent(Event);
export const createBeforeUnloadEvent = (type = '', cancelable = false) => (
  new BeforeUnloadEvent(PLATFORM, type, { bubbles: false, cancelable, composed: false, returnValue: '' })
);

// A gamepad's connection or disconnection: no gamepad is ever connected here, so no Gamepad exists to give one.
export const GamepadEvent = defineGamepadEvent(Event);
registerInterface('Gamepad', () => false);

// EventModifierInit's other modifiers (UI Events), held as the bits of one field — which `getModifierState` reads, per
// mouse event made: no call into the engine for a table this short.
const floor = Math.floor;
const MODIFIER_KEYS = ['AltGraph', 'CapsLock', 'Fn', 'FnLock', 'Hyper', 'NumLock', 'ScrollLock', 'Super', 'Symbol', 'SymbolLock'];
const MODIFIER_MEMBERS = MODIFIER_KEYS.map((key) => 'modifier' + key);
const MODIFIER_BITS = { __proto__: null };
for (let i = 0; i < MODIFIER_KEYS.length; i++) MODIFIER_BITS[MODIFIER_KEYS[i]] = 1 << i;
function modifierBits(init) {
  let bits = 0;
  for (let i = 0; i < MODIFIER_MEMBERS.length; i++) if (init[MODIFIER_MEMBERS[i]]) bits |= 1 << i;
  return bits;
}
// UI Events' getModifierState: whether the given key was held — the four the init's flags name, the others its
// `modifier*` members (and 'Accel' the Control key, as Chrome and Firefox answer on Linux).
function modifierState(state, key) {
  switch (key) {
    case 'Alt':     return state.altKey;
    case 'Accel':
    case 'Control': return state.ctrlKey;
    case 'Meta':    return state.metaKey;
    case 'Shift':   return state.shiftKey;
  }
  return (state.modifiers & MODIFIER_BITS[key]) !== 0;
}

// CSSOM View's coordinates of a mouse event: its page position the client one and its window's scroll — the scroll
// when it was dispatched at the target (a dispatching event's), else its view's, none without one — and its offset
// from the target's padding edge while it is dispatched, its page position otherwise. (`layerX` / `layerY`, which no
// spec defines beyond "the current layer", the page position: no layer is modelled, and a page with no positioned
// ancestor is Chrome's.) Here, as they read the window's hand-written steps and the layout's origin.
function pageXOf(state) {
  const view = state.dispatchFlag ? globalThis : state.view && rawWindowOf(state.view);
  return state.clientX + (view ? view.__csimWindowSteps.get_scrollX(view) : 0);
}
function pageYOf(state) {
  const view = state.dispatchFlag ? globalThis : state.view && rawWindowOf(state.view);
  return state.clientY + (view ? view.__csimWindowSteps.get_scrollY(view) : 0);
}
function offsetOf(state, axis) {
  const target = state.target;
  if (!state.dispatchFlag || !target || nodeTypeOf(target) !== 1) return axis === 'x' ? pageXOf(state) : pageYOf(state);
  const origin = globalThis.__csimPaddingEdgeOrigin(target);
  return axis === 'x' ? state.clientX - origin.x : state.clientY - origin.y;
}
// (…its coordinates floored, however its init's `double`s give them: Chrome's and Firefox's, where CSSOM View's draft and
// Pointer Events' disagree on the members' type — but a PointerEvent's, below)
export const MouseEvent = defineMouseEvent(UIEvent, {
  init(state, init) {
    state.screenX = floor(init.screenX);
    state.screenY = floor(init.screenY);
    state.clientX = floor(init.clientX);
    state.clientY = floor(init.clientY);
    state.modifiers = modifierBits(init);
  },
  // (…its legacy initialisation, whose arguments name none of the other modifiers, clears them: Chrome's and Firefox's)
  initialized(state) { state.modifiers = 0; },
  get_layerX: pageXOf,
  get_layerY: pageYOf,
  getModifierState: modifierState,
  get_pageX: pageXOf,
  get_pageY: pageYOf,
  get_offsetX: (state) => offsetOf(state, 'x'),
  get_offsetY: (state) => offsetOf(state, 'y')
});

// WheelEvent extends MouseEvent per the UI Events spec (so a wheel event
// satisfies `instanceof MouseEvent` and carries the pointer-position /
// modifier fields). Defined after MouseEvent for the class reference.
export const WheelEvent = defineWheelEvent(MouseEvent);

// Pointer Events level 3 — extends MouseEvent so `pointerdown`
// dispatched as PointerEvent still satisfies `instanceof MouseEvent`
// (Stimulus / selector-set delegation expects either).
// Its orientation given either way (its tilts in degrees, or its altitude and azimuth in radians): the init's own, the
// other pair converted from it — the engine's (pointer.rs `orientation`). Its coalesced and predicted events the init's:
// a trusted `pointermove`'s, trustedPointerMove. Its coordinates kept fractional, CSSOM View's proposal as Chrome and
// Firefox ship it for this interface alone — but for the three types Pointer Events says proved incompatible with it,
// which keep MouseEvent's floor.
export const PointerEvent = definePointerEvent(MouseEvent, {
  init(state, init) {
    const type = state.type;
    if (type !== 'click' && type !== 'auxclick' && type !== 'contextmenu') {
      state.screenX = init.screenX;
      state.screenY = init.screenY;
      state.clientX = init.clientX;
      state.clientY = init.clientY;
    }
    const o = dom.pointerOrientation(init.tiltX, init.tiltY, init.altitudeAngle, init.azimuthAngle);
    state.tiltX = o[0];
    state.tiltY = o[1];
    state.altitudeAngle = o[2];
    state.azimuthAngle = o[3];
    state.coalescedEvents = init.coalescedEvents;
    state.predictedEvents = init.predictedEvents;
  },
  getCoalescedEvents: (state) => listCopy(state.coalescedEvents),
  getPredictedEvents: (state) => listCopy(state.predictedEvents)
});

// The phases of a gesture of the mouse pointer the driver plays (pointer.rs `MousePointer`, bridge.entry.js
// `playPointer`): a move, a press, a release — none clicking where the press became a drag (NO_CLICK) — and what its end
// answers: whether its press's default action was prevented.
export const POINTER_MOVE = 1, POINTER_PRESS = 2, POINTER_RELEASE = 4, POINTER_NO_CLICK = 8, POINTER_PRESS_PREVENTED = 1;

// A UA-fired mouse gesture also fires its Pointer Event twin: same coordinates and modifiers, plus
// the pointer identity fields a library branches on to prefer the pointer path. One helper so every
// synthetic gesture (the click path, drag.js) produces the same shape. `pressure` is 0.5 while a
// button is held and 0 once released, per Pointer Events.
export function pointerEventInit(mouseInit, pressure) {
  return { __proto__: null, pointerId: 1, pointerType: 'mouse', isPrimary: true, pressure: pressure == null ? 0.5 : pressure, ...mouseInit };
}

// A `pointermove` the UA fires at `target`: trusted, its coalesced events the one move it is — a trusted move's list
// is never empty (Pointer Events) — trusted too, neither bubbling nor cancelable, at the same target, in the window
// (its page position that window's, as the move's is: dispatch.js dispatchEventForUserAction).
export function trustedPointerMove(target, init) {
  const coalesced = new PointerEvent('pointermove', { __proto__: null, ...init, bubbles: false, cancelable: false, composed: true, view: globalThis });
  eventState(coalesced).isTrusted = true;
  eventState(coalesced).target = target;
  return new PointerEvent('pointermove', { __proto__: null, ...init, coalescedEvents: listOf([coalesced]) });
}

export const DragEvent = defineDragEvent(MouseEvent);

export const KeyboardEvent = defineKeyboardEvent(UIEvent, {
  init(state, init) { state.modifiers = modifierBits(init); },
  // (…its legacy initialisation, which takes neither, clears the other modifiers and `detail`: Chrome's and Firefox's)
  initialized(state) {
    state.modifiers = 0;
    state.detail = 0;
  },
  getModifierState: modifierState
});

// (…its target ranges until its dispatch ends: dispatch.js)
export const InputEvent = defineInputEvent(UIEvent, {
  init(state, init) { state.targetRanges = init.targetRanges; },
  getTargetRanges: (state) => listCopy(state.targetRanges)
});

// A clipboard action's event (`cut`, `copy`, `paste`): its clipboard data, a DataTransfer (dom-nodes
// `clipboardAction`). Trix and Avo's image-cropper read `event.clipboardData.getData(...)`.
export const ClipboardEvent = defineClipboardEvent(Event);

// A message (HTML): its data — `any`, null where the init leaves it out — the origin and last event id, the window,
// port or service worker that sent it, and the ports it carries, a frozen array.
export const MessageEvent = defineMessageEvent(Event);
// The UA's message: its fields as the sender's steps give them, never converted — `postMessage(undefined)` delivers
// undefined, which an init's conversion would make its default null.
export function createMessageEvent(type, fields) {
  return new MessageEvent(PLATFORM, type, {
    bubbles: false,
    cancelable: false,
    composed: false,
    data: 'data' in fields ? fields.data : null,
    origin: fields.origin ?? '',
    lastEventId: fields.lastEventId ?? '',
    source: fields.source ?? null,
    ports: fields.ports ?? []
  });
}


// Dispatch + fire the matching `on<type>` IDL handler if present.
// WebIDL says event handler IDL attributes (`xhr.onload = …`,
// `req.onsuccess = …`) get invoked after addEventListener-registered
// handlers; combining both lets stub classes (FileReader / IDBRequest
// / EventSource / Worker) reuse `EventTarget` without each
// reinventing the on<type> half.
// Historically this fired the target's `on<type>` AFTER dispatchEvent; that is
// now done inside EventTarget.dispatchEvent itself (on-handlers are listeners),
// so this is a thin wrapper kept for its callers. The on-handler still fires
// (via dispatchEvent) even though the per-listener errors are swallowed there.
export function dispatchWithOnHandler(target, evt) {
  // This is the UA-internal "fire an event" path for plain EventTargets / the Window
  // (XHR / WebSocket / EventSource / FileReader / IDB / MessagePort / BroadcastChannel /
  // Worker / window postMessage) — every caller fires a genuinely UA-dispatched event, so
  // the event is TRUSTED. Mark it so the base dispatchEvent below keeps `isTrusted = true`
  // instead of clearing it to false (which is the contract only for a scripted dispatchEvent).
  // (…dispatched by the steps, not through a `dispatchEvent` the page may have replaced; the marker left behind by none
  // that refuses the event)
  eventState(evt).uaFired = true;
  try { return dispatchAt(targetOf(target), evt); } catch (_) { return true; } finally { eventState(evt).uaFired = false; }
}


// `EventTarget` is the ONE listener implementation for the whole platform:
// plain EventTargets (`class Foo extends EventTarget` — XHR / FileReader / IDB /
// Worker / AbortSignal / Avo's date-picker …), DOM nodes (Node extends it), and
// the Window (window-events.js points `globalThis.{add,remove,dispatch}EventListener`
// at its members). Sharing one implementation makes `window.addEventListener ===
// EventTarget.prototype.addEventListener` (WPT window-extends-event-target) and
// lets a member invoked with a different `this` operate on that target.
//
// Listeners live in a target's listener store (`listenersOf`: type → [{handler,isObject,capture,passive,
// once,removed}]) — the same store the DOM tree walker (dispatch.js
// fireListeners) and the Window walker (window-events.js fireWindowListeners)
// read, so registering through any of the three surfaces is mutually visible.
// A node's dispatch is the capture/bubble tree walk (dispatch.js); any other's
// the flat AT_TARGET fire (`dispatchAt`).

// DOM "inner invoke" sets the legacy `window.event` (current event) on EACH
// listener callback's RELEVANT GLOBAL, then restores it — not once per dispatch.
// `perRealmCurrentEvent()` is the cheap gate (property reads only), asked once a
// dispatch, telling whether that global needs finding:
//   - SINGLE-realm page (the common case — top frame, no iframes): false → it is
//     `globalThis`, no native crossing (rule 3).
//   - MULTI-realm page (top frame owns iframe realms, OR this dispatch runs
//     INSIDE a child realm — its `top` points at the parent): true → the
//     callback's own realm, one `contextOf` crossing a listener (a second,
//     `contextGlobal`, only for another realm's).
export function perRealmCurrentEvent() {
  return dom.childFrames[0] !== 0 || realmNested();
}

// A listener's realm — the global `invokeEntries` sets the legacy current event
// on, and reports its throw in — is its own: a function's, or an object
// listener's object's — never `handleEvent`'s, which can be a foreign-realm
// Proxy in a DIFFERENT realm than the object. So the in-handler `window.event`
// and the reported `error` event always target the one realm the spec calls the
// listener's relevant global.
// (…an event handler's realm its function's, not its listener's, which is this module's: `window.onerror = new
// frames[0].Function(…)` sets `frames[0].event` and reports its throw there)
// (…looked up, not read off it: a listener may be a revoked Proxy, which no property read survives)
const HANDLER_OF_LISTENER = new WeakMap();   // an event handler's listener → the handler it calls, read live
function realmAnchorOf(handler) {
  const handlerOf = HANDLER_OF_LISTENER.get(handler);
  return (handlerOf && handlerOf()) || handler;
}
// DOM "inner invoke" of a target's listeners of the event's type (`store` the target's store, `state` the event's
// slots), from its list as the pass begins, which a listener added or removed since replaces, not changes: those of the pass (`capture`) a removal since has not
// marked, until stopImmediatePropagation(); a `once` one removed before it runs (a MediaQueryList told when its last
// `change` one goes); `this` the object of an object listener, `thisArg` else; passive as it says. The node walk
// (dispatch.js), the window's part in it (window-events.js) and the flat dispatch below share it.
//
// Each is called with the legacy current event set on its realm's global — but for a target inside a shadow tree
// (`hidden`), whose global's is left as it was (DOM "inner invoke" 8.2) — and restored after, a throw REPORTED there
// (HTML "report the exception"), never propagated. `perRealm` is `perRealmCurrentEvent()`, asked once a dispatch: on a
// page of several realms that realm is found (one `contextOf`, and `contextGlobal` for another realm's), and entered for
// the call (navigables.rs `entryRealm`), so a composedPath() it calls retargets the window to that realm's WindowProxy.
// HTML's "clean up after running script" follows the callback (`cleanUpAfterCallback`), run while the current event is
// still set, so a microtask the listener queued sees it.
let selfRealmId;
export function invokeEntries(state, event, store, capture, thisArg, perRealm, hidden) {
  const entries = store && store[state.type];
  if (!entries || !entries.length) return;
  // (…the target whose listeners these are, and `this` of each — another realm's WindowProxy for a window, below)
  const current = state.currentTarget;
  let callThis = thisArg;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.removed || entry.capture !== capture) continue;
    if (state.immediatePropagationStopped) break;
    if (entry.once) {
      removeOnceListener(entry, store, state.type);
      if (state.type === 'change') noteChangeListeners(thisArg);
    }
    const handler = entry.handler, isObject = entry.isObject;
    let g = globalThis, entered = false, prevEntry;
    if (perRealm) {
      let id;
      try { id = hostNamespace.contextOf(realmAnchorOf(handler)); } catch (_) {}
      if (selfRealmId === undefined) { try { selfRealmId = globalThis.__csimRealmId(); } catch (_) {} }
      if (id != null && id !== selfRealmId) {
        try { g = hostNamespace.contextGlobal(id) || globalThis; } catch (_) {}
      }
      // (…its realm the entry realm while it runs: HTML "call a user object's operation" prepares to run script in it)
      if (id != null) {
        prevEntry = dom.enterRealm(id);
        entered = true;
      }
      // WindowProxy retargeting: where the event's target, or the target whose listeners these are, is a WINDOW and this
      // listener belongs to ANOTHER realm, present it as that realm's WindowProxy for the window — so a cross-realm
      // listener (and a post-dispatch reader in its realm) sees the same object `contentWindow` / `parent` / `open()`
      // yields (Event-dispatch-throwing-multiple-globals: `errorEvent.target === iframe.contentWindow`), and is called
      // with it as `this`: a pop-up's `load`, its opener's `w.onload`, `this === w`. `event.target` is not restored
      // afterward: like a real browser, it stays the WindowProxy; `currentTarget` is the window's own again for a
      // listener of its realm.
      callThis = thisArg;
      state.currentTarget = current;
      const proxyFor = g !== globalThis && hooksOf(g)?.frameWindowProxyFor;
      if (proxyFor) {
        const proxyOf = (o) => {
          if (realmOfGlobal(o) === null) return null;
          try {
            const proxied = proxyFor(hostNamespace.contextOf(o));
            return proxied && proxied !== o ? proxied : null;
          } catch (_) { return null; }
        };
        const target = proxyOf(state.target);
        if (target) state.target = target;
        const currentProxy = proxyOf(current);
        if (currentProxy) {
          state.currentTarget = currentProxy;
          if (thisArg === current) callThis = currentProxy;
        }
      }
    }
    const prev = g.__csimCurrentEvent;
    if (!hidden) g.__csimCurrentEvent = event;
    state.inPassiveListener = !!entry.passive;   // passive → preventDefault no-op
    try {
      let cb = null;
      try {
        // (…`handleEvent` got on every call, a getter's throw and a non-callable one reported as the callback's would be)
        cb = isObject ? handler.handleEvent : handler;
        if (!isCallable(cb)) throw new TypeError("Failed to invoke event listener: the 'handleEvent' property is not callable.");
        // (…on the stack while it runs, whatever it is: webidl.js `scriptOnStack`)
        const running = runningCallbacks();
        running.count++;
        try { reflectApply(cb, isObject ? handler : callThis, [event]); } finally { running.count--; }
      } catch (e) {
        // (…and the dispatch's "legacy-output-did-listeners-throw flag" set, which IndexedDB asks)
        state.listenersThrew = true;
        try { globalThis.__csimReportListenerError(realmAnchorOf(handler), e, cb); } catch (_) {}
      }
      // (…inside the call, as inner invoke runs it: the listener's microtasks still passive where it is)
      cleanUpAfterCallback(state);
    } finally {
      state.inPassiveListener = false;
      g.__csimCurrentEvent = prev;
      if (entered) dom.exitRealm(prevEntry);
    }
  }
}
// HTML "clean up after running script", after a callback of the dispatch of the event `state` is: a microtask checkpoint
// where the JavaScript execution context stack is then empty — no script beneath the dispatch (webidl.js
// `scriptOnStack`): an event the UA fires from a task (a message, a load, a request's progress, a user's click), not one
// a page's script dispatches, whose listeners run inside it. Asked once a dispatch, after its first callback, when the
// stack is the dispatch's own; a dispatch with no callback asks nothing, and one a script asks for by `dispatchEvent`
// begins answered (`dispatchAt`'s `checkpoint`).
export function cleanUpAfterCallback(state) {
  let checkpoint = state.checkpoint;
  if (checkpoint === undefined) {
    const drain = hostSteps.yield;   // (…none while the snapshot is made)
    checkpoint = state.checkpoint = drain && !scriptOnStack() ? drain : null;
  }
  // (…with no realm entered by name while its microtasks run: each job's entry the realm of its handler, V8's microtask
  // context — navigables.rs `enteredGlobal` — not the realm of the listener that queued it)
  // (…asked of a page of several realms alone, as it stands then: on one of a single realm the realm entered by name is
  // the realm V8 entered, which answers for it where none is)
  if (checkpoint === null) return;
  if (dom.childFrames[0] === 0) {
    checkpoint();
    return;
  }
  const entry = dom.enterRealm(-1);
  try { checkpoint(); } finally { dom.exitRealm(entry); }
}

// The dispatch of an event at a node — over its tree, with its event path (dispatch.js `dispatchEventPublic`, which
// registers it: dispatch.js imports this module, not this one it).
let nodeDispatch = null;
export function setNodeDispatch(dispatch) {
  nodeDispatch = dispatch;
}

// The target a member acts on: the object itself, or for a WindowProxy, any realm's, the window it is of
// (engine.js `rawWindowOf`, through no trap and by no name a page could define), as the listeners live where events fire.
// (…the window and the document first, then what `isEventTarget` last found an object EventTarget.prototype is behind —
// a member's binding has just asked of its `this`; never a Proxy — and a node: the hottest targets, none a WindowProxy)
function targetOf(o) {
  if (o === globalThis || o === globalThis.document || o === lastEventTarget || isNode(o)) return o;
  return rawWindowOf(o);
}
// …and of a member's `this`, after Web IDL's security check: a WindowProxy of a window not same origin-domain
// (IsPlatformObjectSameOrigin) is no `this` of a member that is none of HTML's CrossOriginProperties — a SecurityError,
// as Chrome and Firefox throw (2026-11-08) — though it is an EventTarget, which the binding's brand check said. (The
// check the engine's, a module function: no global a page could replace.)
function thisTargetOf(o) {
  const target = targetOf(o);
  if (target !== o && target !== globalThis && !isSameOriginDomainWindow(target)) {
    throw new DOMException('Blocked a frame from accessing a cross-origin frame.', 'SecurityError');
  }
  return target;
}
// What tells an EventTarget apart, for its members' `this` and a conversion to one: a node, a window — a realm's
// global, or a WindowProxy of one, any realm's (`window instanceof EventTarget` is the Window's own test; a cross-origin
// one's prototype is null) — or a platform object, of slots the bindings made (webidl.js `makeSlots`: every interface's
// object, and an EventTarget's own constructor's, a page's subclass's through it), that EventTarget.prototype is behind,
// any realm's, each marked privately as it loads (`markEventTargetPrototype`). An object of no slots — a page's Proxy,
// whatever its traps answer, none of which runs; `Object.create(EventTarget.prototype)` — is none, as Chrome and Firefox
// have it: Web IDL's brand is the object's, not its prototype's.
// (…a node, any realm's, by its identity: an object inheriting from one — or from Node.prototype — is none, and no
// other EventTarget either; and the last object of another interface found one kept with it, until the event loop step
// ends — an add and a remove of a listener, a dispatch, ask of the same object in turn, and its answer is a lookup by
// its prototype: node-identity.js `prototypeVerdictOf`)
let lastEventTarget = null;
export function forgetLastEventTarget() {
  lastEventTarget = null;
}
function isEventTarget(o) {
  if (o === lastEventTarget || o === globalThis || o === globalThis.document) return true;
  if (o === null || (typeof o !== 'object' && typeof o !== 'function')) return false;
  if (isNode(o)) return true;
  if (hasSlots(o)) {
    if (prototypeVerdictOf(Object.getPrototypeOf(o)) !== EVENT_TARGET_BEHIND) return false;
    lastEventTarget = o;
    return true;
  }
  if (realmOfGlobal(o) !== null) {
    lastEventTarget = o;
    return true;
  }
  return isWindowProxy(o);
}

// (…its object given slots of its own, its brand: a page's `class extends EventTarget` too, by `super()`)
export class EventTarget {
  constructor() {
    makeSlots(this, 'EventTarget');
  }
}
markEventTargetPrototype(EventTarget.prototype);

// A target's listener store (type → list), or none: a node's is its handle's (node_handle.rs `listenerStore`), any
// other target's in its rare data — none a property a page could see or replace.
// (…this realm's window's kept as well, made once and never replaced — every dispatch that reaches the window asks)
// (…a node, any realm's, by its identity — asked so as not to throw: an EventTarget of another interface, a window or
// an XMLHttpRequest, has none to read)
export const isNodeTarget = isNode;
let windowListeners;
export function listenersOf(self) {
  if (self === globalThis) return windowListeners ??= stampedRareDataOf(globalThis)?.listeners;
  return isNodeTarget(self) ? dom.listenerStore(self) : stampedRareDataOf(proxiedWindow(self))?.listeners;
}
// …the object a target's rare data is kept with: itself, or for a WindowProxy of a window — another realm's view of a
// frame, which is no JS Proxy of it — that window, as the WindowProxy is its window to every member (`proxiedWindow`,
// asked of a target that is no node — first whether it is what `isEventTarget` last found an object EventTarget.prototype
// is behind, never a WindowProxy: a member's `this`, which spares the hot add / remove / dispatch the brand check).
const proxiedWindow = (o) => (o === lastEventTarget ? o : rawWindowOf(o));
function heldBy(o) {
  return o === globalThis || isNodeTarget(o) ? o : proxiedWindow(o);
}
// The event types a node has ever had a listener of — a dispatch of any other asks for no store at all — and how often
// a node has gained a store or a type one (`nodeStoresGen`): a dispatch whose stores are older asks again, as a listener
// added from a listener, to a node of the path no listener had been on, fires there all the same (DOM "invoke" reads
// the node's listeners as it reaches it). Both the engine's (node_handle.rs `ListenerTypes`), whichever realm's script
// adds the listener; this realm keeps the types it knows a node has, and those it knew none had as of a count.
// (…records of no prototype, which no page's `Set.prototype.has` is asked in place of)
const nodeListenerTypes = { __proto__: null }, noNodeListenerAt = { __proto__: null };
export const nodeStoresGen = () => dom.listenersGen[0];
export function nodesListenTo(type) {
  if (nodeListenerTypes[type] === true) return true;
  const gen = nodeStoresGen();
  if (noNodeListenerAt[type] === gen) return false;
  if (dom.listenerTypeKnown(type)) {
    nodeListenerTypes[type] = true;
    return true;
  }
  noNodeListenerAt[type] = gen;
  return false;
}
// …each node's of a dispatch's `path`, at its index, in one call — none, where no node has ever had a listener of
// `type`.
const NO_STORES = [];
export function listenerStoresOf(path, type) {
  return nodesListenTo(type) ? dom.listenerStores(path) : NO_STORES;
}
// …and a dispatch's whole path, target to root, with each node's store beside it, in one call (node_handle.rs
// `dispatchPath`): `[path, stores, bubbleEnd, toWindow]` (`formStop` a `submit` or `reset`, `relatedNid` the event's
// relatedTarget's where it is a node); undefined for a node the engine holds no slot for (an Attr); null for a path
// the flat tree's event path takes — across a shadow root, or with a relatedTarget in a shadow tree.
export function eventPathOf(target, formStop, relatedNid) {
  return dom.dispatchPath(nidOf(target), formStop, relatedNid);
}
export { NO_STORES };
// …and the listeners of `type` on `target`, a node or not, for the WPT testdriver shim: plain descriptors, never the
// live entries (window-events.js `windowListenersFor`, the window's).
hostSteps.listenersFor = function (target, type) {
  const store = listenersOf(target), list = store && store[type];
  return list ? listMap(list, (l) => ({ passive: !!l.passive, capture: !!l.capture })) : [];
};

// DOM "erase all event listeners and handlers" (HTML's document open steps 9-10): every listener of `target` removed —
// one a dispatch in flight would reach skipped (`removed`) — and each of its event handlers deactivated, its value null
// (its wrapper listener with the rest: a value set again adds it anew).
export function eraseListenersAndHandlers(target) {
  const store = listenersOf(target);
  if (store) {
    for (const type of Object.keys(store)) {
      const list = store[type];
      for (let i = 0; i < list.length; i++) list[i].removed = true;
      delete store[type];
    }
  }
  const handlers = handlersOf(target);
  if (handlers) {
    for (const type in handlers) handlers[type].value = null;
  }
}

// DOM "add an event listener" (§2.7): `options` the converted `(AddEventListenerOptions or boolean)` — a boolean its
// `capture` — read whatever the callback (its `signal` converted too, so `{signal: null}` is a TypeError even with no
// callback); a null callback, or a signal already aborted, adds nothing. `passive` unsaid is the target's default
// (`defaultPassiveValue`: a touch or wheel listener on the window, the document or its root is passive).
export function addListener(self, type, handler, options) {
  const dict = typeof options === 'object';
  const capture = !!(dict ? options.capture : options);
  const passive = dict && options.passive !== undefined ? options.passive : defaultPassiveValue(type, self);
  const once = dict && options.once;
  const signal = dict ? options.signal : undefined;
  if (handler === null) return;
  if (signal !== undefined && dom.abortSignalAborted(slotsOf(signal, 'AbortSignal').id)) return;
  let store = listenersOf(self);
  if (!store) {
    store = objectCreate(null);
    if (isNodeTarget(self)) dom.listenerStore(self, store);
    else stampedRareDataOf(proxiedWindow(self), true).listeners = store;
  }
  if (isNodeTarget(self) && nodeListenerTypes[type] !== true) {
    nodeListenerTypes[type] = true;
    dom.noteListenerType(type);
  }
  const entry = { handler, isObject: !isCallable(handler), capture, passive, once, removed: false };
  const list = store[type];
  if (list === undefined) {
    store[type] = [entry];
  } else {
    // Dedup on {type, callback, capture} with original callback identity.
    for (let i = 0; i < list.length; i++) if (list[i].handler === handler && list[i].capture === capture) return;
    store[type] = list.length === 0 ? [entry] : listAppended(list, entry);
  }
  if (type === 'abort') pinDependentSignal(self);
  else if (type === 'change') noteChangeListeners(self);
  else if (type === 'message' || type === 'messageerror') noteMessageListeners(self);
  // Only after the listener is actually added (not deduped): the signal's abort removes it, before the `abort` event —
  // which a listener could stop, or redispatch — fires.
  // (…that listener, not one with its callback and capture added since it was removed: DOM "remove an event listener")
  if (signal !== undefined) addAbortAlgorithm(signal, () => removeSignalListener(self, type, entry));
}
// "Add an algorithm" to an AbortSignal (abort.js), which its abort runs before its `abort` event — a listener of which
// could stop or redispatch it; none for a signal aborted already. Here, where a listener's removal adds one, as the
// signal's interface extends this module's EventTarget.
export function addAbortAlgorithm(signal, algorithm) {
  const s = slotsOf(signal, 'AbortSignal');
  if (dom.abortSignalAborted(s.id)) return;
  (s.abortAlgorithms || (s.abortAlgorithms = [])).push(algorithm);
  pinDependentSignal(signal);
}
// …and "remove an algorithm": what no longer follows the signal — a lock request granted (Web Locks §4.4) — let go, so a
// long-lived signal holds none of them.
export function removeAbortAlgorithm(signal, algorithm) {
  const s = slotsOf(signal, 'AbortSignal');
  const at = s.abortAlgorithms ? s.abortAlgorithms.indexOf(algorithm) : -1;
  if (at < 0) return;
  s.abortAlgorithms.splice(at, 1);
  unpinDependentSignal(signal);
}
// A dependent signal (AbortSignal.any's), which its sources hold weakly, held by each of them while it is not aborted
// and has an `abort` listener or algorithm — DOM §3.2: it "must not be garbage collected" then — so a listener of a
// composite nothing else references still fires; let go once it has neither.
function pinDependentSignal(signal) {
  const s = slotsOf(signal, 'AbortSignal');
  if (s === undefined || dom.abortSignalAborted(s.id)) return;
  for (const root of dom.abortSignalRoots(s.id)) {
    const r = slotsOf(root, 'AbortSignal');
    (r.pinnedDependents || (r.pinnedDependents = new Set())).add(signal);
  }
}
function unpinDependentSignal(signal) {
  const s = slotsOf(signal, 'AbortSignal');
  if (s === undefined || s.abortAlgorithms?.length || listenersOf(signal)?.abort?.length) return;
  for (const root of dom.abortSignalRoots(s.id)) slotsOf(root, 'AbortSignal').pinnedDependents?.delete(signal);
}
// DOM "remove an event listener": `options` the converted `(EventListenerOptions or boolean)`, or the capture alone.
export function removeListener(self, type, handler, options) {
  const capture = !!(typeof options === 'object' ? options.capture : options);
  const store = listenersOf(self);
  const list = store && store[type];
  if (!list) return;
  for (let i = 0; i < list.length; i++) {
    if (list[i].capture === capture && list[i].handler === handler) {
      list[i].removed = true;   // in-flight dispatch's list must skip it
      store[type] = list.length === 1 ? [] : listWithout(list, i);
      break;
    }
  }
  noteListenersChanged(self, type);
}
// …of one listener, whatever has since been added like it: an aborted signal's (DOM "add an event listener").
function removeSignalListener(self, type, entry) {
  entry.removed = true;
  const store = listenersOf(self), list = store && store[type];
  for (let i = 0; list && i < list.length; i++) {
    if (list[i] === entry) {
      store[type] = listWithout(list, i);
      break;
    }
  }
  noteListenersChanged(self, type);
}
function noteListenersChanged(self, type) {
  if (type === 'abort') unpinDependentSignal(self);
  else if (type === 'change') noteChangeListeners(self);
  else if (type === 'message' || type === 'messageerror') noteMessageListeners(self);
}
// A MediaQueryList, which the engine holds weakly, held while it has a `change` listener (media_query_lists.rs): one a
// page keeps only through its listener is still told of a flip, as browsers keep it. A PermissionStatus likewise
// (Permissions §6.3.5 "MUST NOT be garbage collected if it has an event listener whose type is change": its slots'
// `listened`, geolocation.js).
function noteChangeListeners(self) {
  const listened = listenersOf(self).change.length > 0;
  const s = slotsOf(self, 'MediaQueryList');
  if (s !== undefined) dom.mqlListened(s.id, listened);
  else slotsOf(self, 'PermissionStatus')?.listened(self, listened);
}
// A BroadcastChannel, which the engine holds weakly, held while it has a `message` or `messageerror` listener (HTML
// §9.5: one with none may be collected) — its slots' `listened`, broadcast-channel.js.
function noteMessageListeners(self) {
  const s = slotsOf(self, 'BroadcastChannel');
  if (s === undefined) return;
  const store = listenersOf(self);
  s.listened(self, store.message?.length > 0 || store.messageerror?.length > 0);
}
// DOM "dispatch": a node's over its tree (dispatch.js), any other target's — a plain EventTarget's, the window's — flat,
// at the target.
// DOM "get the parent" of a plain EventTarget: an IDBRequest's its transaction, a transaction's its database
// (IndexedDB §4.6, §4.8) — what its implementation registered (`setEventParent`), none for every other.
const EVENT_PARENTS = new WeakMap();
export function setEventParent(target, parentOf) { EVENT_PARENTS.set(target, parentOf); }
const NO_PARENTS = Object.freeze([]);
function eventParentsOf(self, event) {
  if (!EVENT_PARENTS.has(self)) return NO_PARENTS;
  const parents = [];
  for (let t = self, parentOf; (parentOf = EVENT_PARENTS.get(t)) !== undefined;) {
    t = parentOf(event);
    if (!t) break;
    appendTo(parents, t);
  }
  return parents;
}

function dispatchAt(self, event, checkpoint = undefined) {
  const state = eventState(event);
  // (…a node's is over its tree: dispatch.js's)
  if (isNodeTarget(self)) return nodeDispatch(self, event, checkpoint);
  if (state.dispatchFlag || state.initialized === false) {
    throw new DOMException(
      "The event is already being dispatched, or has not been initialized.", "InvalidStateError");
  }
  // A scripted `dispatchEvent()` produces an UNTRUSTED event (DOM "dispatchEvent" sets
  // isTrusted to false); UA-internal firing (dispatchWithOnHandler) marks `_uaFired` so the
  // event stays TRUSTED. The marker is single-use — cleared here so a later scripted
  // re-dispatch of the same object is correctly untrusted.
  state.isTrusted = state.uaFired === true;
  state.uaFired = false;
  // (…its target the window's document under the "legacy target override flag", which only the window's `load` sets)
  state.target = state.legacyTargetOverride === true ? self.document : self;
  state.legacyTargetOverride = false;
  // (…its relatedTarget retargeted against the target, as DOM dispatch's every path item's is — a node in a shadow tree
  // read as its host, by a target in none)
  if (state.relatedTarget != null) state.relatedTarget = retarget(state.relatedTarget, self);
  retargetTouches(state, self);
  state.csimFlatTarget = self; // (…its path the target and its parents: composedPath() is [self, …parents])
  const parents = state.csimFlatParents = eventParentsOf(self, event);
  state.dispatchFlag = true;   // re-dispatching it mid-flight → InvalidStateError
  state.checkpoint = checkpoint;
  try {
    // (…its parents' capture listeners first, the outermost first; then the target's; then, for an event that bubbles,
    // its parents' others — a plain EventTarget with no parent, or the Window, the target of its own flat dispatch)
    for (let i = parents.length - 1; i >= 0 && !state.propagationStopped; i--) dispatchAtTarget(parents[i], event, 1);
    if (!state.propagationStopped) dispatchAtTarget(self, event, 2);
    if (state.bubbles) for (let i = 0; i < parents.length && !state.propagationStopped; i++) dispatchAtTarget(parents[i], event, 3);
    return !state.canceled;
  } finally {
    // The end of dispatch, as a node's (dispatch.js): phase NONE, no current target, and the dispatch and stop flags
    // unset — `finally`, past a throwing `on*` handler.
    state.eventPhase = 0;
    state.currentTarget = null;
    state.dispatchFlag = false;
    state.csimFlatTarget = null;
    state.csimFlatParents = null;
    state.propagationStopped = false;
    state.immediatePropagationStopped = false;
  }
}
// …one target's listeners at `phase` — CAPTURING (1: its capture listeners alone), AT_TARGET (2: its capture listeners,
// then — unless one stopped propagation — its others and its handler, as DOM "invoke"s the target twice) or BUBBLING
// (3: its other listeners, and its handler). A microtask checkpoint follows each callback run ("clean up after running
// script", where no script is beneath the dispatch), none where none ran.
function dispatchAtTarget(self, event, phase) {
  const state = eventState(event);
  state.currentTarget = self;
  state.eventPhase = phase;
  const perRealm = perRealmCurrentEvent();
  if (phase !== 3) invokeListeners(self, event, perRealm, true);
  if (phase !== 1 && !state.propagationStopped) {
    invokeListeners(self, event, perRealm, false);
    // Event-handler IDL attributes (`onload` / `onerror` / …) ARE event
    // listeners per HTML (installEventHandlerAttrs), among the listeners above —
    // a window's too; a worker scope's plain `on<type>` property fires through
    // fireWindowOnHandler, after the addEventListener listeners. A throw is
    // reported (HTML "report the exception"), like the listeners above. Any other
    // object's `on<type>` is no handler: a method of an EventTarget subclass named
    // so is not called.
    if (self === globalThis && fireWindowOnHandler(event)) cleanUpAfterCallback(state);
  }
  return !state.canceled;
}
// …its capture listeners, or its others (`invokeEntries`).
function invokeListeners(self, event, perRealm, capture) {
  invokeEntries(eventState(event), event, listenersOf(self), capture, self, perRealm, false);
}

// EventTarget's members (generated/bindings.js): Observables' `when` none of them — no implementation answers it.
registerInterface('EventTarget', isEventTarget);
installEventTarget(EventTarget, {
  addEventListener: (target, type, callback, options) => addListener(thisTargetOf(target), type, callback, options),
  removeEventListener: (target, type, callback, options) => removeListener(thisTargetOf(target), type, callback, options),
  // (…a script's, which it runs inside: no checkpoint after its listeners — the driver's own dispatches are never this)
  dispatchEvent: (target, event) => dispatchAt(thisTargetOf(target), event, null)
});

// A worker scope's plain `on<type>` handler property, run as a bubble-phase listener (a worker has no `window.event`
// to set around it).
function fireWindowOnHandler(event) {
  const state = eventState(event);
  // (…a worker's global's alone, and only a handler no accessor of its holds: a window's handlers and a worker's
  // WorkerGlobalScope ones are its listeners, which the dispatch has called — a window's `onfoo = f` no handler at all)
  if (!globalThis.__csim_isWorker || handlersOf(globalThis)?.[state.type]?.wrap != null) return false;
  const h = globalThis['on' + state.type];
  if (typeof h !== 'function') return false;
  try {
    // (…on the stack while it runs, as a listener is: webidl.js `scriptOnStack`)
    const running = runningCallbacks();
    running.count++;
    try {
      // `window.onerror` is an OnErrorEventHandler: for an ErrorEvent it takes the
      // legacy 5-arg form (message, source, lineno, colno, error), not the event.
      if (state.type === 'error' && interfaceCheck('ErrorEvent')(event)) {
        const handled = h.call(globalThis, state.message, state.filename, state.lineno, state.colno, state.error);
        if (handled === true && state.cancelable) state.canceled = true;
      } else {
        h.call(globalThis, event);
      }
    } finally {
      running.count--;
    }
  } catch (e) {
    // HTML "report the exception": a throwing window on-handler is REPORTED on
    // the handler's own realm — a cross-realm `window.onerror` that throws fires
    // THAT realm's `error` event (→ its own onerror) in turn — not swallowed.
    // reportError's re-entrancy guard bounds the recursion.
    try { globalThis.__csimReportListenerError(h, e); } catch (_) {}
  }
  return true;
}

// ── GlobalEventHandlers IDL attributes on Element / Document / ShadowRoot ──
//
// A single HTML "event handler" is identified by (node, type). Per spec it has a
// VALUE — null, a callback (assigned via the IDL attribute), or an internal raw
// uncompiled handler (a `RawHandler`, assigned via a content attribute and
// compiled lazily on first use) — and ONE associated event listener, added the
// first time the value becomes callable (at that DOM position) and removed when it
// returns to null. The listener reads the value LIVE, so the IDL property,
// setAttribute and removeAttribute all drive the SAME listener — matching HTML
// reflection and making the handler fire INTERLEAVED with addEventListener
// listeners in registration order (the old dispatch-walk fired it always-first).
//
// `<body>` / `<frameset>` reflect the six window-reflecting handlers
// (onblur/onerror/onfocus/onload/onscroll/onresize) to the WINDOW instead of the
// element; every other element treats them as ordinary handlers (so `<img
// onerror>` / `<script onload>` register a real listener).

// HTML "compile a handler": build the handler function from an inline source. Per
// spec the function is NAMED after the handler (`function onclick(event) {…}`), the
// OnErrorEventHandler (window / body-reflected `onerror`) takes the legacy 5-arg
// signature, and the body runs in the element's lexical scope chain (element → form
// owner → document; the Window is the realm the function is created in), so
// `onclick="cellIndex"` resolves against the element, `"domain"` against the
// document, `"print"` against the window. The scopes are injected with `with`
// (which honours `Symbol.unscopables` natively), and the named function is CREATED
// INSIDE the `with` blocks — so it captures them by closure while its OWN source is
// just `function <name>(<args>) { <src> }`, giving the clean spec-required
// `toString()` with no `with` wrapper. `scopeChain` is outermost-first (document …
// element); empty for a Window handler (global scope only). A syntax error → null,
// and (when `report`) HTML "report the exception" fires the window `error` event.
function compileHandler(src, name, fiveArg, scopeChain, report) {
  const args   = fiveArg ? 'event, source, lineno, colno, error' : 'event';
  const params = scopeChain.map((_, i) => '$scope' + i);
  let withHead = '';
  for (const p of params) withHead += 'with (' + p + ') ';
  const factorySrc = withHead + '{ return function ' + name + '(' + args + ') {\n' + String(src) + '\n}; }';
  try {
    return new Function(params.join(','), factorySrc).apply(undefined, scopeChain);
  } catch (e) {
    if (report) { try { globalThis.__csimReportError(e); } catch (_) {} }
    return null;
  }
}

// The form owner added to a form-associated element's inline-handler scope chain.
// The resolver (which needs formForControl + the custom-element registry + the
// form-associated tag set — all owned by dom-nodes) is injected there, both to keep
// that knowledge in one place and to avoid an events↔form-helpers import cycle. It
// returns the form owner, or null for a non-form-associated element.
let resolveScopeFormOwner = null;
export function setScopeFormOwnerResolver(fn) { resolveScopeFormOwner = fn; }

// The element's inline-handler lexical scope chain, outermost-first: the node
// document, the form owner (only for a form-associated element that has one), then
// the element itself (innermost, shadows the rest).
function elementHandlerScopeChain(node) {
  const chain = [];
  const doc = nodeDocumentOf(node);
  if (doc) chain.push(doc);
  const form = resolveScopeFormOwner ? resolveScopeFormOwner(node) : null;
  if (form) chain.push(form);
  chain.push(node);
  return chain;
}

// An uncompiled inline-handler source bound to its owning element + handler name,
// compiled LAZILY on first use (getter read or first dispatch) and memoized — a
// never-triggered inline handler is never compiled (matching the old lazy-compile
// perf), and a syntax error is reported exactly ONCE. A distinct type so an
// IDL-assigned plain object (`el.onclick = {}`, which round-trips but never fires) is
// never mistaken for one.
// (…a Window's — a body's or frameset's forwarded one — with no element: the global scope, and `onerror` the legacy
// five arguments, OnErrorEventHandler's)
class RawHandler {
  constructor(src, node, name) { this.src = src; this.node = node; this.name = name; this.fn = undefined; }
  compile() {
    if (this.fn === undefined) {
      // (…none while its element's document is one scripting is disabled for, one with no browsing context — a
      // DOMParser's, a template's contents' — or one sandboxed against scripts (realm_location.rs `sandboxed`), and
      // compiled once it is in one with: HTML "getting the current value of the event handler" 1.1, which asks of an
      // uncompiled one alone; one compiled stays, wherever its element goes)
      const doc = this.node !== null ? nodeDocumentOf(this.node) : null;
      if (doc !== null && defaultViewOf(doc) === null) return null;
      if (sandboxed(SANDBOXED_SCRIPTS, this.node)) return null;
      // Memoize to null BEFORE compiling: compileHandler reports a syntax error
      // synchronously (a window `error` event), and a handler reacting to it that
      // reads this same `el.onX` would otherwise re-enter with `fn` still undefined —
      // recompiling and re-reporting without bound. With `fn` already null, the
      // re-entrant read short-circuits (compiled once, reported once).
      this.fn = null;
      this.fn = this.node === null
        ? compileHandler(this.src, this.name, this.name === 'onerror', [], true)
        : compileHandler(this.src, this.name, false, elementHandlerScopeChain(this.node), true);
    }
    return this.fn;
  }
}

// `<body>`/`<frameset>` forward some handlers to the Window (HTML §8.1.8.2; which, the engine's: event_handlers.rs) —
// `<body onload>` / `body.onpopstate = f` are their node document's window's handler, and the element has none of its
// own. (A document with no window: no handler, read null, set nothing.)
function forwardsHandler(self, attr) {
  return isNodeTarget(self) && dom.handlerForwarded(nidOf(self), attr);
}
function forwardingWindowOf(node) {
  const doc = nodeDocumentOf(node);
  if (doc === globalThis.document) return globalThis;
  const view = doc && defaultViewOf(doc);
  return view ? rawWindowOf(view) : null;
}
// …whose handlers that window's own realm reads and sets — another realm's for a body adopted from or into a frame's
// document — its value reflected, compiled in its global scope (`RawHandler` a realm's own): this realm's directly,
// another's through what it publishes.
const windowHandler = {
  get: (type) => reflectHandler(handlerValue(globalThis, type)),
  set: (type, stored) => setHandler(globalThis, type, stored),
  setSource: (type, raw, name) => setHandler(globalThis, type, raw == null ? null : new RawHandler(raw, null, name))
};
globalThis.__csimWindowHandler = windowHandler;
const windowHandlerOf = (win) => (win === globalThis ? windowHandler : win.__csimWindowHandler);

// The IDL getter's reflected value: a RawHandler compiles to its function (or
// null); a function or non-callable object is returned verbatim (WebIDL
// [LegacyTreatNonObjectAsNull] lets `onclick = {}` round-trip); else null.
function reflectHandler(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof RawHandler) return v.compile();
  return v;
}
// The callable actually invoked on dispatch: a RawHandler's compiled function
// (compiled lazily here on first fire), a function verbatim, else null (a
// non-callable object never fires).
function handlerCallable(v) {
  if (v instanceof RawHandler) return v.compile();
  return isCallable(v) ? v : null;
}
// Whether a stored value gets a registered listener. Per HTML "activate an event
// handler", the listener is added the first time the value becomes NON-NULL — a
// function, a RawHandler (inline source, registered WITHOUT compiling — a syntax error
// still registers a listener that no-ops), OR a non-callable object (`el.onclick = {}`).
// A non-callable object's listener never fires (the wrapper's `handlerCallable` no-ops),
// but it MUST be registered so its DOM position is claimed: a later assignment of a
// callable reuses that first position instead of appending after intervening
// addEventListener listeners (event-handler-spec-example). `stored` is pre-normalised to
// null-or-object/function/RawHandler, so any non-null value is registrable. Decided
// without compiling, so a never-triggered inline handler is never parsed.
function isRegistrableHandler(v) {
  return v != null;
}

// A target's event handlers (type → `{ value, wrap }`: the handler's value and the one listener that calls it), kept in
// its rare data — none a property a page could see or replace — or none.
function handlersOf(target) {
  return rareDataOf(heldBy(target))?.handlers;
}
// …the value of `target`'s handler of `type`, or undefined for one never set.
function handlerValue(target, type) {
  return handlersOf(target)?.[type]?.value;
}
// The shared EventHandler primitive (used by defineEventHandlers for plain
// EventTargets and by installEventHandlerAttrs / syncInlineEventHandler for
// Element / Document / ShadowRoot): set a target's handler of `type` to `stored`
// (null | function | non-callable object | RawHandler) and add/remove its single
// wrapper listener as the registrability transitions. The wrapper reads the value
// LIVE, so a later value change (IDL re-assign, setAttribute) keeps the SAME
// listener position, and returning false from a cancelable event's handler cancels it.
function setHandler(node, type, stored) {
  const rare = rareDataOf(heldBy(node), true);
  const handlers = rare.handlers ??= objectCreate(null);
  const handler = handlers[type] ??= { value: null, wrap: null };
  const wasActive = isRegistrableHandler(handler.value);
  handler.value = stored;
  const nowActive = isRegistrableHandler(stored);
  if (nowActive && !wasActive) {
    let wrap = handler.wrap;
    if (!wrap) {
      // HTML "the event handler processing algorithm": a global's `error` handler called with an ErrorEvent's five
      // values, whose true cancels it; a `beforeunload` handler's non-null value cancelling it, and its returnValue
      // that value where none was set (coerced to a string while the event is the current one); any other returning
      // false cancelling the event (an inline `onclick="…; return false"`).
      wrap = (ev) => {
        const cb = handlerCallable(handler.value);
        if (!cb) return;
        const state = eventState(ev);
        // (…`this` the event's currentTarget, HTML's callback this value: another realm's WindowProxy of a window — invokeEntries)
        const self = state.currentTarget || node;
        if (state.type === 'error' && isGlobal(node) && interfaceCheck('ErrorEvent')(ev)) {
          const ret = reflectApply(cb, self, [state.message, state.filename, state.lineno, state.colno, state.error]);
          if (ret === true && state.cancelable) state.canceled = true;
          return;
        }
        const ret = reflectApply(cb, self, [ev]);
        if (state.type === 'beforeunload' && interfaceCheck('BeforeUnloadEvent')(ev)) {
          if (ret != null) {
            if (state.cancelable) state.canceled = true;
            if (state.returnValue === '') state.returnValue = toDOMString(ret);
          }
          return;
        }
        if (ret === false && state.cancelable) state.canceled = true;
      };
      HANDLER_OF_LISTENER.set(wrap, () => handlerCallable(handler.value));
      handler.wrap = wrap;
    }
    addListener(node, type, wrap, false);
  } else if (!nowActive && wasActive && handler.wrap) {
    removeListener(node, type, handler.wrap, false);
  }
}
function isGlobal(o) {
  return o === globalThis || realmOfGlobal(o) !== null;
}

// Install the event handler IDL attributes (`onclick` / `onload` / …) as
// spec-faithful EventHandler accessors on `proto`; each becomes an accessor that
// registers a listener. The accessors are enumerable to match the plain `null`
// slots they replace (so React-DOM's `'oninput' in element` probe still answers
// true). Which of an element's are also its event handler CONTENT attributes is
// the engine's (event_handlers.rs, `syncInlineEventHandler`).
export function installEventHandlerAttrs(proto, attrNames, isSelf = null) {
  for (const attr of attrNames) {
    // (…its "event handler event type": its name past `on`, but the legacy WebKit-prefixed four's camel-case one)
    const type = LEGACY_HANDLER_EVENT_TYPES[attr] || attr.slice(2);
    // (…one a body or frameset may forward to its Window asked of the engine, any other never)
    const forwardable = FORWARDED_EVENT_HANDLERS.has(attr);
    // (…named as the IDL's accessors are: `get onclick` / `set onclick`)
    const accessors = Object.getOwnPropertyDescriptor({
      get [attr]() {
        const self = isSelf ? thisIs(this ?? globalThis, isSelf) : this;
        if (forwardable && forwardsHandler(self, attr)) {
          const win = forwardingWindowOf(self);
          return win ? windowHandlerOf(win).get(type) : null;
        }
        return reflectHandler(handlerValue(self, type));
      },
      set [attr](v) {
        const self = isSelf ? thisIs(this ?? globalThis, isSelf) : this;
        // WebIDL EventHandler [LegacyTreatNonObjectAsNull]: a non-object primitive
        // → null; an object (callable or not) is stored verbatim.
        const stored = isObject(v) ? v : null;
        if (forwardable && forwardsHandler(self, attr)) {
          const win = forwardingWindowOf(self);
          if (win) windowHandlerOf(win).set(type, stored);
          return;
        }
        setHandler(self, type, stored);
      }
    }, attr);
    Object.defineProperty(proto, attr, { get: accessors.get, set: accessors.set, configurable: true, enumerable: true });
  }
}

// Activate / update / clear a node's inline (content-attribute) event handler from
// an attribute mutation (setAttribute / setAttributeNS / removeAttribute /
// setAttributeNode / Attr#value / parser / clone). `attrName` is the attribute's
// key (an HTML element's lowercase, a foreign one's as written); a fast `on` prefix
// gate keeps every other attribute off this path, and only one
// the engine knows for the element's handler activates (event_handlers.rs: its
// event type, and whether a body's or frameset's is its Window's). `raw` null
// clears it. A forwarded one drives the Window's handler instead of the
// element's — except when re-activating a detached clone (`fromClone`), which must
// not touch the live window handler.
export function syncInlineEventHandler(node, attrName, raw, fromClone) {
  if (attrName.charCodeAt(0) !== 111 || attrName.charCodeAt(1) !== 110) return;   // not "on…"
  const handler = dom.inlineHandler(nidOf(node), attrName);
  if (handler === null) return;
  const [type, forwarded] = handler;
  if (forwarded) {
    // (…the window's handler, compiled in its global scope — though not again from a clone's copy of the attributes,
    // which would replace the window's live one)
    const win = !fromClone && forwardingWindowOf(node);
    if (win) windowHandlerOf(win).setSource(type, raw, attrName);
    return;
  }
  setHandler(node, type, raw == null ? null : new RawHandler(raw, node, attrName));
}
