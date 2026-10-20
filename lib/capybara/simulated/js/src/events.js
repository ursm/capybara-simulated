// DOM event constructors. Capture / target / bubble dispatch lives
// in bridge.entry.js; this module just defines the value types.

import { bodyOf, documentElementOf } from './document-tree.js';
import {
  brandPrototype, interfaceCheck, makeSlots, registerInterface, resolvedPromise, slotsOf, thisIs, toDOMString, toFloat
} from './webidl.js';
import {
  FORWARDED_EVENT_HANDLERS, LEGACY_HANDLER_EVENT_TYPES, convertAnimationEventArguments,
  convertAnimationPlaybackEventArguments,
  convertClipboardEventArguments, convertCloseEventArguments, convertCompositionEventArguments,
  convertCustomEventArguments, convertDeviceMotionEventArguments, convertDeviceOrientationEventArguments,
  convertDragEventArguments, convertErrorEventArguments, convertEventArguments, convertFocusEventArguments,
  convertFontFaceSetLoadEventArguments, convertFormDataEventArguments, convertGamepadEventArguments,
  convertHashChangeEventArguments, convertIDBVersionChangeEventArguments, convertInputEventArguments,
  convertKeyboardEventArguments, convertMediaQueryListEventArguments, convertMessageEventArguments,
  convertMouseEventArguments, convertPageTransitionEventArguments, convertPointerEventArguments,
  convertPopStateEventArguments, convertProgressEventArguments, convertPromiseRejectionEventArguments,
  convertCommandEventArguments, convertStorageEventArguments, convertSubmitEventArguments, convertToggleEventArguments, convertTouchArguments,
  convertTouchEventArguments, convertTransitionEventArguments, convertUIEventArguments, convertWheelEventArguments,
  defineDeviceMotionEventAcceleration, defineDeviceMotionEventRotationRate, defineTouchList, installAnimationEvent,
  installAnimationPlaybackEvent, installBeforeUnloadEvent, installClipboardEvent, installCloseEvent,
  installCommandEvent, installCompositionEvent, installCustomEvent, installDeviceMotionEvent, installDeviceOrientationEvent,
  installDragEvent, installErrorEvent, installEvent, installEventTarget, installFocusEvent,
  installFontFaceSetLoadEvent, installFormDataEvent, installGamepadEvent, installHashChangeEvent,
  installIDBVersionChangeEvent, installInputEvent, installKeyboardEvent, installMediaQueryListEvent,
  installMessageEvent, installMouseEvent, installPageTransitionEvent, installPointerEvent, installPopStateEvent,
  installProgressEvent, installPromiseRejectionEvent, installStorageEvent, installSubmitEvent, installTextEvent,
  installToggleEvent, installTouch, installTouchEvent, installTransitionEvent, installUIEvent, installWheelEvent
} from './generated/bindings.js';
import { DOMException } from './dom-exception.js';
import { rareDataOf, stampedRareDataOf } from './native-query-shadow.js';

// Unwrap a cross-realm WindowProxy to its raw global (no-op for everything else),
// so EventTarget methods invoked through a proxy operate on the real window.
function unwrapWin(o) {
  return globalThis.__csimUnwrapWindow ? globalThis.__csimUnwrapWindow(o) : o;
}
// Map any window global in a composedPath result to the active-listener realm's
// WindowProxy, so a cross-realm listener sees `composedPath()` entries === its own
// `contentWindow`/`parent` (shadow event-dispatch/test-003).
function retargetWindowsInPath(path) {
  // Single-realm pages can't have a cross-realm window to retarget — skip the
  // per-element native-crossing scan entirely (rule 3).
  if (!globalThis.__csimMultiRealm || !globalThis.__csimMultiRealm()) return path;
  if (!globalThis.__csimRetargetWindow || !globalThis.__csimIsWindowGlobal) return path;
  for (let i = 0; i < path.length; i++) {
    if (globalThis.__csimIsWindowGlobal(path[i])) path[i] = globalThis.__csimRetargetWindow(path[i]);
  }
  return path;
}

// https://dom.spec.whatwg.org/#default-passive-value — a listener for one of
// these event types defaults to passive (preventDefault becomes a no-op) when
// registered on the Window, a Document, or its node document's document element or body element (not any element
// named body: one a script made, or one nested in another) and the `passive` option is omitted. Explicit
// `{passive: …}` always wins.
export const PASSIVE_DEFAULT_EVENTS = new Set(['touchstart', 'touchmove', 'wheel', 'mousewheel']);
export function defaultPassiveValue(type, target) {
  if (!PASSIVE_DEFAULT_EVENTS.has(type)) return false;
  if (windowOf(target) !== null) return true;                   // a Window, this realm's or another's
  const nt = target && target._nodeType;
  if (nt === 9) return true;                                    // Document
  if (nt === 1 && target._ownerDocument) {                      // documentElement / body
    const doc = target._ownerDocument;
    if (target === documentElementOf(doc) || target === bodyOf(doc)) return true;
  }
  return false;
}

// Spec "inner invoke": a `once` listener is removed *before* its callback runs.
// Set `removed` so an in-flight dispatch's `list.slice()` snapshot skips the
// still-referenced entry (keeping a self-re-dispatching `once` callback from
// re-entering itself), and splice it out of the live array so the stored list
// doesn't accumulate fired one-shots. Shared by the Node and window dispatch
// loops so the removal semantics can't drift between them.
export function removeOnceListener(entry, listArr) {
  entry.removed = true;
  if (listArr) {
    const i = listArr.indexOf(entry);
    if (i !== -1) listArr.splice(i, 1);
  }
}

// The Event interface (DOM §2.2): its state its internal slots (`eventState`), which the dispatch writes — and each
// subclass adds its own to — its members generated from its IDL (`installEvent`, after the class), `isTrusted` —
// [LegacyUnforgeable] — each event's own.
// (…a subclass of ours hands its converted arguments over with CONVERTED, as its own constructor converted them; a
// page's subclass, or `new Event(…)`, has them converted here)
export const CONVERTED = Symbol('converted');
export class Event {
  constructor(type, init) {
    if (type !== CONVERTED) [type, init] = convertEventArguments(arguments);
    else [type, init] = [init, arguments[2]];
    makeSlots(this, 'Event', {
      type,
      bubbles:    init.bubbles,
      cancelable: init.cancelable,
      composed:   init.composed,
      canceled:   false,
      target:     null,
      currentTarget: null,
      eventPhase: 0,
      isTrusted:  false,
      propagationStopped:          false,
      immediatePropagationStopped: false,
      // DOM "initialized flag": a constructed event is initialized; one made via `document.createEvent` is NOT until
      // `initEvent` runs. `dispatchFlag` guards against re-dispatching an event that's mid-flight. Both gate
      // `dispatchEvent` (InvalidStateError).
      initialized:  true,
      dispatchFlag: false,
      // (…and the microtask checkpoint to run after each listener, where a dispatch asks for one: fireWithCheckpoints)
      checkpoint: null,
      // (…and, through a flat dispatch — not a node's — its target and the target's parents: composedPathOf)
      csimFlatTarget:  null,
      csimFlatParents: null,
      // (…and whether a listener threw, DOM's "legacy-output-did-listeners-throw flag": IndexedDB's success and error
      // events)
      listenersThrew: false,
      // (…its event path through a node tree while it is dispatched there — its nodes, the window it goes on to, and
      // each node's struct where a shadow tree retargets it: dispatch.js — and whether the dispatch is in a passive
      // listener)
      csimNodePath:      null,
      csimPath:          null,
      csimPathWindow:    null,
      csimStructMap:     null,
      inPassiveListener: false,
      // (…whether it is a click at no point — `click()`, a key's activation — whose activation selects no coordinate:
      // dom-nodes `activationBehavior`)
      noPoint: false,
      // (…whether the platform, not a page's dispatchEvent, fires it: dispatchWithOnHandler)
      uaFired: false,
      // Capture timeStamp EAGERLY at construction (the event's time origin per spec) rather than lazily at first read —
      // a lazily-read timestamp is taken AFTER the event was created, which breaks `before <= e.timeStamp <= after`
      // when the reader brackets construction with performance.now() (WPT Event-timestamp-high-resolution).
      ts: globalThis.__csimPerformanceNow()
    });
    defineEventUnforgeables(this);
  }
}
function composedPathOf(ev) {
  const state = eventState(ev);
  // Outside dispatch the event's path is empty, so composedPath() is the
  // empty list (the dispatch algorithm empties it on cleanup). Library
  // probes read it from within a listener, where the flag is set.
  if (!state.dispatchFlag) return [];
  // (…a flat dispatch's path its one invocation target — the window's for its `load`, whose target is the document)
  if (state.csimFlatTarget) return retargetWindowsInPath([state.csimFlatTarget, ...state.csimFlatParents]);
  const structs = state.csimPath;
  if (!structs) {
    // FAST PATH (no shadow trees): the flattened tree is the node tree, so
    // composedPath is the path the dispatch took, target to root, as it took it
    // — wherever a listener has moved a node since — plus the window it went on
    // to (none for an inert document's or a `load`). No retargeting, no
    // per-listener trimming.
    const full = state.csimNodePath.slice();
    if (state.csimPathWindow) full.push(state.csimPathWindow);
    return retargetWindowsInPath(full);
  }
  // Shadow case: the precomputed event path trimmed to what `currentTarget` may observe — none of a closed shadow tree
  // it is outside of — by the root-of-closed-tree / slot-in-closed-tree flags each step carries (event_path.rs).
  const ct = state.currentTarget;
  const current = structs.findLastIndex((s) => s.node === ct);
  // currentTarget isn't on the recorded path (e.g. a window listener whose
  // window was never appended because the event didn't reach the document, or
  // a delegated handler that reassigned currentTarget). Per the dispatch model
  // such a listener sees the whole path it observed — return every node
  // untrimmed rather than emit a malformed (window-led) list.
  if (current === -1) return retargetWindowsInPath(structs.map((s) => s.node));
  const flags = structs.map((s) => s.flags);
  return retargetWindowsInPath(Array.from(globalThis.__dom.composedPath(flags, current), (i) => structs[i].node));
}
// What tells an event of an interface apart (`dispatchEvent`'s argument, its members' `this`): the interface's
// prototype behind it — any realm's, which brands itself: an iframe's event dispatched here is one — and the fields an
// Event constructor gave it, which the prototype itself, branded too, has none of (Chrome's "Illegal invocation" on
// `MouseEvent.prototype.clientX`).
export const eventTest = (name) => (o) => slotsOf(o, name) !== undefined;
registerInterface('Event', eventTest('Event'));
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
  const raw = o.__csimRawWindow || o;
  return (raw === globalThis && realmIsWindow) || (raw !== globalThis && globalThis.__csimIsWindowGlobal(raw)) ? raw : null;
}
registerInterface('Window', (o) => windowOf(o) !== null);

// Event's members (generated/bindings.js): its state's — `currentTarget` a prototype getter a page may shadow on an
// event (selector-set / Rails-UJS-style delegation: `Object.defineProperty(event, 'currentTarget', {get: …})`, which
// Mastodon's `data-method` handler reads) — and its steps.
// (…its class string a data property, so each subclass of ours has its own: a page's subclass reports `Event`)
const defineEventUnforgeables = installEvent(Event, {
  get_type: (ev) => eventState(ev).type,
  get_target: (ev) => eventState(ev).target,
  get_srcElement: (ev) => eventState(ev).target,
  get_currentTarget: (ev) => eventState(ev).currentTarget,
  composedPath: (ev) => composedPathOf(ev),
  get_eventPhase: (ev) => eventState(ev).eventPhase,
  stopPropagation(ev) { eventState(ev).propagationStopped = true; },
  // Legacy `cancelBubble`: the stop-propagation flag; setting it true stops propagation, false does nothing.
  get_cancelBubble: (ev) => eventState(ev).propagationStopped,
  set_cancelBubble(ev, value) { if (value) eventState(ev).propagationStopped = true; },
  stopImmediatePropagation(ev) {
    const state = eventState(ev);
    state.propagationStopped = true;
    state.immediatePropagationStopped = true;
  },
  get_bubbles: (ev) => eventState(ev).bubbles,
  get_cancelable: (ev) => eventState(ev).cancelable,
  // Legacy `returnValue`: whether the default action is still allowed; false cancels it, true does nothing.
  get_returnValue: (ev) => !eventState(ev).canceled,
  set_returnValue(ev, value) { if (!value) cancelEvent(ev); },
  preventDefault(ev) { cancelEvent(ev); },
  get_defaultPrevented: (ev) => eventState(ev).canceled,
  get_composed: (ev) => eventState(ev).composed,
  get_timeStamp: (ev) => eventState(ev).ts,
  // Legacy `initEvent` (for an event `document.createEvent` made): nothing mid-dispatch; else initialized, its flags,
  // its target cleared, and the three attributes.
  initEvent(ev, type, bubbles, cancelable) {
    if (!eventState(ev).dispatchFlag) initEventSteps(ev, type, bubbles, cancelable);
  },
  get_isTrusted: (ev) => eventState(ev).isTrusted
});
// DOM "initialize" an event: initialized, its flags and target cleared, its type and two attributes `type`'s.
export function initEventSteps(ev, type, bubbles, cancelable) {
  const state = eventState(ev);
  state.initialized = true;
  state.propagationStopped = false;
  state.immediatePropagationStopped = false;
  state.canceled = false;
  state.isTrusted = false;
  state.target = null;
  state.type = type;
  state.bubbles = bubbles;
  state.cancelable = cancelable;
}
// DOM "set the canceled flag": a cancelable event's, unless a passive listener is the one asking.
export function cancelEvent(ev) {
  const state = eventState(ev);
  if (state.cancelable && !state.inPassiveListener) state.canceled = true;
}

// CustomEvent (DOM §2.4): its `detail`, and the legacy `initCustomEvent` (Trix's `document.createEvent('CustomEvent')`).
export class CustomEvent extends Event {
  constructor(type, init) {
    if (type !== CONVERTED) [type, init] = convertCustomEventArguments(arguments);
    else [type, init] = [init, arguments[2]];
    super(CONVERTED, type, init);
    makeSlots(this, 'CustomEvent', { detail: init.detail });
  }
}
registerInterface('CustomEvent', eventTest('CustomEvent'));
installCustomEvent(CustomEvent, {
  get_detail: (ev) => eventState(ev).detail,
  // (…nothing mid-dispatch; else the event's initialisation, then its detail)
  initCustomEvent(ev, type, bubbles, cancelable, detail) {
    if (eventState(ev).dispatchFlag) return;
    initEventSteps(ev, type, bubbles, cancelable);
    eventState(ev).detail = detail;
  }
});

// UIEvent — base for any event with a `view` (window) + `detail`
// (click count, wheel delta). Spec parent of MouseEvent / KeyboardEvent /
// FocusEvent / WheelEvent / CompositionEvent / InputEvent.
export class UIEvent extends Event {
  constructor(type, init) {
    if (type !== CONVERTED) [type, init] = convertUIEventArguments(arguments);
    else [type, init] = [init, arguments[2]];
    super(CONVERTED, type, init);
    makeSlots(this, 'UIEvent', {
      view:   init.view,
      detail: init.detail
    });
  }
}

export class FocusEvent extends UIEvent {
  constructor(type, init) {
    if (type !== CONVERTED) [type, init] = convertFocusEventArguments(arguments);
    else [type, init] = [init, arguments[2]];
    super(CONVERTED, type, init);
    makeSlots(this, 'FocusEvent', { relatedTarget: init.relatedTarget });
  }
}

export class CompositionEvent extends UIEvent {
  constructor(type, init) {
    if (type !== CONVERTED) [type, init] = convertCompositionEventArguments(arguments);
    else [type, init] = [init, arguments[2]];
    super(CONVERTED, type, init);
    makeSlots(this, 'CompositionEvent', { data: init.data });
  }
}

// Legacy `TextEvent` (UIEvent subtype) — kept distinct from CompositionEvent so
// `document.createEvent("TextEvent")` reports the right interface.
export class TextEvent extends UIEvent {
  // (…no constructor of its IDL's: `document.createEvent('TextEvent')` makes one, `createTextEvent`)
  constructor(token) {
    if (token !== CONVERTED) throw new TypeError("Failed to construct 'TextEvent': Illegal constructor");
    super(CONVERTED, '', { bubbles: false, cancelable: false, composed: false, view: null, detail: 0, which: 0 });
    makeSlots(this, 'TextEvent', { data: '' });
  }
}
export const createTextEvent = () => new TextEvent(CONVERTED);

// Device sensor events (DeviceOrientation Event): a page feature-detects them and constructs them; no sensor here
// fires one. A motion's acceleration and rotation rate are objects of their own interfaces, made from the init's.
export class DeviceMotionEvent extends Event {
  constructor(type, init) {
    if (type !== CONVERTED) [type, init] = convertDeviceMotionEventArguments(arguments);
    else [type, init] = [init, arguments[2]];
    super(CONVERTED, type, init);
    makeSlots(this, 'DeviceMotionEvent', {
      acceleration:                 motionVector(DeviceMotionEventAcceleration, init.acceleration),
      accelerationIncludingGravity: motionVector(DeviceMotionEventAcceleration, init.accelerationIncludingGravity),
      rotationRate:                 motionVector(DeviceMotionEventRotationRate, init.rotationRate),
      interval:                     init.interval
    });
  }
}
// (…none where the init gives none, an object of its interface wherever it gives one, empty too: Chrome's)
function motionVector(binding, init) {
  return init ? binding.create(init) : null;
}
const DeviceMotionEventAcceleration = defineDeviceMotionEventAcceleration({
  init(slots, init) { slots.x = init.x; slots.y = init.y; slots.z = init.z; },
  get_x: (slots) => slots.x,
  get_y: (slots) => slots.y,
  get_z: (slots) => slots.z
});
const DeviceMotionEventRotationRate = defineDeviceMotionEventRotationRate({
  init(slots, init) { slots.alpha = init.alpha; slots.beta = init.beta; slots.gamma = init.gamma; },
  get_alpha: (slots) => slots.alpha,
  get_beta: (slots) => slots.beta,
  get_gamma: (slots) => slots.gamma
});
export const DeviceMotionEventAccelerationInterface = DeviceMotionEventAcceleration.interface;
export const DeviceMotionEventRotationRateInterface = DeviceMotionEventRotationRate.interface;

export class DeviceOrientationEvent extends Event {
  constructor(type, init) {
    if (type !== CONVERTED) [type, init] = convertDeviceOrientationEventArguments(arguments);
    else [type, init] = [init, arguments[2]];
    super(CONVERTED, type, init);
    makeSlots(this, 'DeviceOrientationEvent', {
      alpha:    init.alpha,
      beta:     init.beta,
      gamma:    init.gamma,
      absolute: init.absolute
    });
  }
}


// Touch Events: a touch point (Touch, its init's members in its slots), a list of them (TouchList, made by the platform
// alone), and the event carrying three such lists. No touchscreen input is modelled — a page's own constructions are all
// there are — but the interfaces are the IDL's, so a library feature-detecting or synthesizing them gets real ones.
const touchOf = (o) => slotsOf(o, 'Touch');
registerInterface('Touch', (o) => touchOf(o) !== undefined);
export class Touch {
  constructor(touchInitDict) {
    [touchInitDict] = convertTouchArguments(arguments);
    // (TouchInit gives the two angles as `double`, Touch answers them as `float` — the spec's own mismatch: each is
    // converted to its attribute's type here, as a float member of the init already is)
    for (const name of ['altitudeAngle', 'azimuthAngle']) {
      touchInitDict[name] = toFloat(touchInitDict[name], `Failed to construct 'Touch': Failed to read the '${name}' property from 'TouchInit': `);
    }
    // (…and its unadjusted target, none until an event it is in is dispatched: Touch Events' retargeting steps)
    touchInitDict.unadjustedTarget = null;
    makeSlots(this, 'Touch', touchInitDict);
  }
}
installTouch(Touch, Object.fromEntries([
  'identifier', 'target', 'screenX', 'screenY', 'clientX', 'clientY', 'pageX', 'pageY', 'radiusX', 'radiusY',
  'rotationAngle', 'force', 'altitudeAngle', 'azimuthAngle', 'touchType'
].map((name) => [`get_${name}`, (t) => touchOf(t)[name]])));
const touchList = defineTouchList({
  init(s, touches) { s.touches = touches; },
  item: (s, index) => (index < s.touches.length ? s.touches[index] : null),
  get_length: (s) => s.touches.length
});
export const TouchListInterface = touchList.interface;

export class TouchEvent extends UIEvent {
  constructor(type, init) {
    if (type !== CONVERTED) [type, init] = convertTouchEventArguments(arguments);
    else [type, init] = [init, arguments[2]];
    super(CONVERTED, type, init);
    makeSlots(this, 'TouchEvent', {
      modifiers:      modifierBits(init),
      touches:        touchList.create(init.touches),
      targetTouches:  touchList.create(init.targetTouches),
      changedTouches: touchList.create(init.changedTouches),
      touchPoints:    [...new Set([...init.touches, ...init.targetTouches, ...init.changedTouches])],
      ctrlKey:        init.ctrlKey,
      shiftKey:       init.shiftKey,
      altKey:         init.altKey,
      metaKey:        init.metaKey
    });
  }
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
    if (target != null && target._nodeType !== undefined) nodes.push(target);
  }
  return nodes;
}

// A request's progress (XHR's ProgressEvent): whether its length is known, how much of it has loaded, of how much.
export class ProgressEvent extends Event {
  constructor(type, init) {
    if (type !== CONVERTED) [type, init] = convertProgressEventArguments(arguments);
    else [type, init] = [init, arguments[2]];
    super(CONVERTED, type, init);
    makeSlots(this, 'ProgressEvent', {
      lengthComputable: init.lengthComputable,
      loaded:           init.loaded,
      total:            init.total
    });
  }
}

// HTML's navigation events: a history traversal's `popstate` (its state), a fragment navigation's `hashchange` (the two
// URLs), a document's `pageshow` / `pagehide` (whether it is kept in the back/forward cache, which no document here
// is). Turbo and history-API polyfills construct the first two.
export class PopStateEvent extends Event {
  constructor(type, init) {
    if (type !== CONVERTED) [type, init] = convertPopStateEventArguments(arguments);
    else [type, init] = [init, arguments[2]];
    super(CONVERTED, type, init);
    makeSlots(this, 'PopStateEvent', {
      state:                 init.state,
      hasUAVisualTransition: init.hasUAVisualTransition
    });
  }
}

export class HashChangeEvent extends Event {
  constructor(type, init) {
    if (type !== CONVERTED) [type, init] = convertHashChangeEventArguments(arguments);
    else [type, init] = [init, arguments[2]];
    super(CONVERTED, type, init);
    makeSlots(this, 'HashChangeEvent', {
      oldURL: init.oldURL,
      newURL: init.newURL
    });
  }
}

export class PageTransitionEvent extends Event {
  constructor(type, init) {
    if (type !== CONVERTED) [type, init] = convertPageTransitionEventArguments(arguments);
    else [type, init] = [init, arguments[2]];
    super(CONVERTED, type, init);
    makeSlots(this, 'PageTransitionEvent', { persisted: init.persisted });
  }
}

// A storage area's change, fired at another same-origin document (storage.js, which installs its members: they take
// a Storage).
export class StorageEvent extends Event {
  constructor(type, init) {
    if (type !== CONVERTED) [type, init] = convertStorageEventArguments(arguments);
    else [type, init] = [init, arguments[2]];
    super(CONVERTED, type, init);
    makeSlots(this, 'StorageEvent', {
      key:         init.key,
      oldValue:    init.oldValue,
      newValue:    init.newValue,
      url:         init.url,
      storageArea: init.storageArea
    });
  }
}

// A script's error, reported at its global (`error` — whose handler the event handler processing algorithm calls with
// its five values, so an event of any realm: its brand), and a promise's rejection no handler took (`unhandledrejection`,
// `rejectionhandled`). An ErrorEvent's `error` is `any`, undefined where it was not given.
export class ErrorEvent extends Event {
  constructor(type, init) {
    if (type !== CONVERTED) [type, init] = convertErrorEventArguments(arguments);
    else [type, init] = [init, arguments[2]];
    super(CONVERTED, type, init);
    makeSlots(this, 'ErrorEvent', {
      message:  init.message,
      filename: init.filename,
      lineno:   init.lineno,
      colno:    init.colno,
      error:    init.error
    });
  }
}

export class PromiseRejectionEvent extends Event {
  constructor(type, init) {
    if (type !== CONVERTED) [type, init] = convertPromiseRejectionEventArguments(arguments);
    else [type, init] = [init, arguments[2]];
    super(CONVERTED, type, init);
    makeSlots(this, 'PromiseRejectionEvent', {
      promise: init.promise,
      reason:  init.reason
    });
  }
}

// A media query list's `change` (CSSOM View): whether it matches now, and its query. A database's version change
// (IndexedDB's `upgradeneeded`): its old version and its new. A font set's load (CSS Font Loading's `loadingdone`,
// `loadingerror`): the faces it loaded, a frozen array.
export class MediaQueryListEvent extends Event {
  constructor(type, init) {
    if (type !== CONVERTED) [type, init] = convertMediaQueryListEventArguments(arguments);
    else [type, init] = [init, arguments[2]];
    super(CONVERTED, type, init);
    makeSlots(this, 'MediaQueryListEvent', {
      media:   init.media,
      matches: init.matches
    });
  }
}

export class IDBVersionChangeEvent extends Event {
  constructor(type, init) {
    if (type !== CONVERTED) [type, init] = convertIDBVersionChangeEventArguments(arguments);
    else [type, init] = [init, arguments[2]];
    super(CONVERTED, type, init);
    makeSlots(this, 'IDBVersionChangeEvent', {
      oldVersion: init.oldVersion,
      newVersion: init.newVersion
    });
  }
}

export class FontFaceSetLoadEvent extends Event {
  constructor(type, init) {
    if (type !== CONVERTED) [type, init] = convertFontFaceSetLoadEventArguments(arguments);
    else [type, init] = [init, arguments[2]];
    super(CONVERTED, type, init);
    makeSlots(this, 'FontFaceSetLoadEvent', { fontfaces: Object.freeze(init.fontfaces.slice()) });
  }
}

// A WebSocket's closing (`close`): whether it closed cleanly, its code and its reason.
export class CloseEvent extends Event {
  constructor(type, init) {
    if (type !== CONVERTED) [type, init] = convertCloseEventArguments(arguments);
    else [type, init] = [init, arguments[2]];
    super(CONVERTED, type, init);
    makeSlots(this, 'CloseEvent', {
      wasClean: init.wasClean,
      code:     init.code,
      reason:   init.reason
    });
  }
}

// A CSS animation's and a CSS transition's events (css-animations, css-transitions: their name or property, the time
// elapsed, the pseudo-element — and, of their level 2, the CSSAnimation / CSSTransition itself), and a Web Animation's
// `finish` / `cancel` (its current time and its timeline's).
export class AnimationEvent extends Event {
  constructor(type, init) {
    if (type !== CONVERTED) [type, init] = convertAnimationEventArguments(arguments);
    else [type, init] = [init, arguments[2]];
    super(CONVERTED, type, init);
    makeSlots(this, 'AnimationEvent', {
      animationName: init.animationName,
      elapsedTime:   init.elapsedTime,
      pseudoElement: init.pseudoElement,
      animation:     init.animation
    });
  }
}

export class TransitionEvent extends Event {
  constructor(type, init) {
    if (type !== CONVERTED) [type, init] = convertTransitionEventArguments(arguments);
    else [type, init] = [init, arguments[2]];
    super(CONVERTED, type, init);
    makeSlots(this, 'TransitionEvent', {
      propertyName:  init.propertyName,
      elapsedTime:   init.elapsedTime,
      pseudoElement: init.pseudoElement,
      animation:     init.animation
    });
  }
}

export class AnimationPlaybackEvent extends Event {
  constructor(type, init) {
    if (type !== CONVERTED) [type, init] = convertAnimationPlaybackEventArguments(arguments);
    else [type, init] = [init, arguments[2]];
    super(CONVERTED, type, init);
    makeSlots(this, 'AnimationPlaybackEvent', {
      currentTime:  init.currentTime,
      timelineTime: init.timelineTime
    });
  }
}

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
export class FormDataEvent extends Event {
  constructor(type, init) {
    if (type !== CONVERTED) [type, init] = convertFormDataEventArguments(arguments);
    else [type, init] = [init, arguments[2]];
    super(CONVERTED, type, init);
    makeSlots(this, 'FormDataEvent', { formData: init.formData });
  }
}

export class SubmitEvent extends Event {
  constructor(type, init) {
    if (type !== CONVERTED) [type, init] = convertSubmitEventArguments(arguments);
    else [type, init] = [init, arguments[2]];
    super(CONVERTED, type, init);
    makeSlots(this, 'SubmitEvent', { submitter: init.submitter });
  }
}

export class ToggleEvent extends Event {
  constructor(type, init) {
    if (type !== CONVERTED) [type, init] = convertToggleEventArguments(arguments);
    else [type, init] = [init, arguments[2]];
    super(CONVERTED, type, init);
    makeSlots(this, 'ToggleEvent', {
      oldState: init.oldState,
      newState: init.newState,
      source:   init.source
    });
  }
}

// A command invoker's (HTML §4.10.6): fired at its target, its invoker the source and the command its `command`.
export class CommandEvent extends Event {
  constructor(type, init) {
    if (type !== CONVERTED) [type, init] = convertCommandEventArguments(arguments);
    else [type, init] = [init, arguments[2]];
    super(CONVERTED, type, init);
    makeSlots(this, 'CommandEvent', {
      source:  init.source ?? null,
      command: init.command ?? ''
    });
  }
}

// A document's unloading (`beforeunload`): no constructor of its IDL's — `document.createEvent('BeforeUnloadEvent')` and
// the UA make one (createBeforeUnloadEvent) — its returnValue the legacy prompt text, a DOMString of its own.
export class BeforeUnloadEvent extends Event {
  constructor(token, type, init) {
    if (token !== CONVERTED) throw new TypeError("Failed to construct 'BeforeUnloadEvent': Illegal constructor");
    super(CONVERTED, type, init);
    makeSlots(this, 'BeforeUnloadEvent', { returnValue: '' });
  }
}
export const createBeforeUnloadEvent = (type = '', cancelable = false) => (
  new BeforeUnloadEvent(CONVERTED, type, { bubbles: false, cancelable, composed: false })
);

// A gamepad's connection or disconnection: no gamepad is ever connected here, so no Gamepad exists to give one.
export class GamepadEvent extends Event {
  constructor(type, init) {
    if (type !== CONVERTED) [type, init] = convertGamepadEventArguments(arguments);
    else [type, init] = [init, arguments[2]];
    super(CONVERTED, type, init);
    makeSlots(this, 'GamepadEvent', { gamepad: init.gamepad });
  }
}
registerInterface('Gamepad', () => false);

// EventModifierInit's other modifiers (UI Events), held as the bits of one field.
const MODIFIER_KEYS = ['AltGraph', 'CapsLock', 'Fn', 'FnLock', 'Hyper', 'NumLock', 'ScrollLock', 'Super', 'Symbol', 'SymbolLock'];
const MODIFIER_MEMBERS = MODIFIER_KEYS.map((key) => 'modifier' + key);
function modifierBits(init) {
  let bits = 0;
  for (let i = 0; i < MODIFIER_MEMBERS.length; i++) if (init[MODIFIER_MEMBERS[i]]) bits |= 1 << i;
  return bits;
}

export class MouseEvent extends UIEvent {
  constructor(type, init) {
    if (type !== CONVERTED) [type, init] = convertMouseEventArguments(arguments);
    else [type, init] = [init, arguments[2]];
    super(CONVERTED, type, init);
    makeSlots(this, 'MouseEvent', {
      modifiers:     modifierBits(init),
      screenX:       init.screenX,
      screenY:       init.screenY,
      clientX:       init.clientX,
      clientY:       init.clientY,
      ctrlKey:       init.ctrlKey,
      shiftKey:      init.shiftKey,
      altKey:        init.altKey,
      metaKey:       init.metaKey,
      button:        init.button,
      buttons:       init.buttons,
      relatedTarget: init.relatedTarget,
      movementX:     init.movementX,
      movementY:     init.movementY
    });
  }
}

// WheelEvent extends MouseEvent per the UI Events spec (so a wheel event
// satisfies `instanceof MouseEvent` and carries the pointer-position /
// modifier fields). Defined after MouseEvent for the class reference.
export class WheelEvent extends MouseEvent {
  constructor(type, init) {
    if (type !== CONVERTED) [type, init] = convertWheelEventArguments(arguments);
    else [type, init] = [init, arguments[2]];
    super(CONVERTED, type, init);
    makeSlots(this, 'WheelEvent', {
      deltaX:    init.deltaX,
      deltaY:    init.deltaY,
      deltaZ:    init.deltaZ,
      deltaMode: init.deltaMode
    });
  }
}

// Pointer Events level 3 — extends MouseEvent so `pointerdown`
// dispatched as PointerEvent still satisfies `instanceof MouseEvent`
// (Stimulus / selector-set delegation expects either).
export class PointerEvent extends MouseEvent {
  constructor(type, init) {
    if (type !== CONVERTED) [type, init] = convertPointerEventArguments(arguments);
    else [type, init] = [init, arguments[2]];
    super(CONVERTED, type, init);
    makeSlots(this, 'PointerEvent', {
      pointerId:          init.pointerId,
      width:              init.width,
      height:             init.height,
      pressure:           init.pressure,
      tangentialPressure: init.tangentialPressure,
      twist:              init.twist,
      pointerType:        init.pointerType,
      isPrimary:          init.isPrimary,
      persistentDeviceId: init.persistentDeviceId,
      coalescedEvents:    init.coalescedEvents,
      predictedEvents:    init.predictedEvents
    });
    pointerOrientation(this, init);
  }
}

// Pointer Events' orientation of a pointer, given either way (its tilts in degrees, or its altitude and azimuth in
// radians): the init's own, the other pair converted from it — the engine's (pointer.rs `orientation`).
function pointerOrientation(ev, init) {
  const state = eventState(ev);
  const o = globalThis.__dom.pointerOrientation(init.tiltX, init.tiltY, init.altitudeAngle, init.azimuthAngle);
  state.tiltX = o[0];
  state.tiltY = o[1];
  state.altitudeAngle = o[2];
  state.azimuthAngle = o[3];
}

// Whether a gesture's compatibility mouse event is withheld — the engine's PREVENT MOUSE EVENT flag of the page's mouse
// pointer (pointer.rs `mouse_prevented`): set at the press where its `pointerdown` was canceled, read while pressed,
// and read and cleared at the release. Every gesture the driver plays asks it: a click, a right click, a drag.
export const POINTER_PRESS = 0, POINTER_MOVE = 1, POINTER_RELEASE = 2;
export const mousePrevented = (step, canceled = false) => globalThis.__dom.mousePrevented(step, canceled);

// A UA-fired mouse gesture also fires its Pointer Event twin: same coordinates and modifiers, plus
// the pointer identity fields a library branches on to prefer the pointer path. One helper so every
// synthetic gesture (the click path, drag.js) produces the same shape. `pressure` is 0.5 while a
// button is held and 0 once released, per Pointer Events.
export function pointerEventInit(mouseInit, pressure) {
  return Object.assign(
    { pointerId: 1, pointerType: 'mouse', isPrimary: true, pressure: pressure == null ? 0.5 : pressure },
    mouseInit
  );
}

// A `pointermove` the UA fires at `target`: trusted, its coalesced events the one move it is — a trusted move's list
// is never empty (Pointer Events) — trusted too, neither bubbling nor cancelable, at the same target, in the window
// (its page position that window's, as the move's is: dispatch.js dispatchEventForUserAction).
export function trustedPointerMove(target, init) {
  const coalesced = new PointerEvent('pointermove', Object.assign({}, init, { bubbles: false, cancelable: false, composed: true, view: globalThis }));
  eventState(coalesced).isTrusted = true;
  eventState(coalesced).target = target;
  return new PointerEvent('pointermove', Object.assign({}, init, { coalescedEvents: [coalesced] }));
}

export class DragEvent extends MouseEvent {
  constructor(type, init) {
    if (type !== CONVERTED) [type, init] = convertDragEventArguments(arguments);
    else [type, init] = [init, arguments[2]];
    super(CONVERTED, type, init);
    makeSlots(this, 'DragEvent', { dataTransfer: init.dataTransfer });
  }
}

export class KeyboardEvent extends UIEvent {
  constructor(type, init) {
    if (type !== CONVERTED) [type, init] = convertKeyboardEventArguments(arguments);
    else [type, init] = [init, arguments[2]];
    super(CONVERTED, type, init);
    makeSlots(this, 'KeyboardEvent', {
      modifiers:   modifierBits(init),
      key:         init.key,
      code:        init.code,
      location:    init.location,
      ctrlKey:     init.ctrlKey,
      shiftKey:    init.shiftKey,
      altKey:      init.altKey,
      metaKey:     init.metaKey,
      repeat:      init.repeat,
      isComposing: init.isComposing,
      charCode:    init.charCode,
      keyCode:     init.keyCode
    });
  }
}

export class InputEvent extends UIEvent {
  constructor(type, init) {
    if (type !== CONVERTED) [type, init] = convertInputEventArguments(arguments);
    else [type, init] = [init, arguments[2]];
    super(CONVERTED, type, init);
    makeSlots(this, 'InputEvent', {
      data:         init.data,
      inputType:    init.inputType,
      isComposing:  init.isComposing,
      dataTransfer: init.dataTransfer,
      targetRanges: init.targetRanges
    });
  }
}

// A clipboard action's event (`cut`, `copy`, `paste`): its clipboard data, a DataTransfer (dom-nodes
// performClipboardGesture). Trix and Avo's image-cropper read `event.clipboardData.getData(...)`.
export class ClipboardEvent extends Event {
  constructor(type, init) {
    if (type !== CONVERTED) [type, init] = convertClipboardEventArguments(arguments);
    else [type, init] = [init, arguments[2]];
    super(CONVERTED, type, init);
    makeSlots(this, 'ClipboardEvent', { clipboardData: init.clipboardData });
  }
}

// A message (HTML): its data — `any`, null where the init leaves it out — the origin and last event id, the window,
// port or service worker that sent it, and the ports it carries, a frozen array.
export class MessageEvent extends Event {
  constructor(type, init) {
    if (type !== CONVERTED) [type, init] = convertMessageEventArguments(arguments);
    else [type, init] = [init, arguments[2]];
    super(CONVERTED, type, init);
    makeSlots(this, 'MessageEvent', {
      data:        init.data,
      origin:      init.origin,
      lastEventId: init.lastEventId,
      source:      init.source,
      ports:       Object.freeze(init.ports.slice())
    });
  }
}
// The UA's message: its fields as the sender's steps give them, never converted — `postMessage(undefined)` delivers
// undefined, which an init's conversion would make its default null.
export function createMessageEvent(type, fields) {
  return new MessageEvent(CONVERTED, type, {
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

// …and with HTML's "clean up after running script" after each listener: the microtask checkpoint between them, while
// the event is still being dispatched (a service worker's extendable events, whose `waitUntil` a handler's microtasks
// may call however deep they chain).
export function fireWithCheckpoints(target, evt) {
  eventState(evt).checkpoint = globalThis.__csim_yield || null;
  try { return dispatchWithOnHandler(target, evt); } finally { eventState(evt).checkpoint = null; }
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
  return globalThis.__dom.childFrames[0] !== 0 || !!(globalThis.__csimTop && globalThis.__csimTop !== globalThis);
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
// slots), from a snapshot of its list taken as the pass begins: those of the pass (`capture`) a removal since has not
// marked, until stopImmediatePropagation(); a `once` one removed before it runs (a MediaQueryList told when its last
// `change` one goes); `this` the object of an object listener, `thisArg` else; passive as it says. The node walk
// (dispatch.js), the window's part in it (window-events.js) and the flat dispatch below share it.
//
// Each is called with the legacy current event set on its realm's global — but for a target inside a shadow tree
// (`hidden`), whose global's is left as it was (DOM "inner invoke" 8.2) — and restored after, a throw REPORTED there
// (HTML "report the exception"), never propagated. `perRealm` is `perRealmCurrentEvent()`, asked once a dispatch: on a
// page of several realms that realm is found (one `contextOf`, and `contextGlobal` for another realm's), and recorded as
// the active listener's for the call, so a composedPath() it calls retargets the window to that realm's WindowProxy.
// HTML's "clean up after running script" follows the callback where the dispatch asks for it (`state.checkpoint`): the
// microtask checkpoint, run while the current event is still set, so a microtask the listener queued sees it.
let selfRealmId;
export function invokeEntries(state, event, store, capture, thisArg, perRealm, hidden) {
  const list = store && store[state.type];
  if (!list || !list.length) return;
  const checkpoint = state.checkpoint;
  for (const entry of list.slice()) {
    if (entry.removed || entry.capture !== capture) continue;
    if (state.immediatePropagationStopped) break;
    if (entry.once) {
      removeOnceListener(entry, store[state.type]);
      if (state.type === 'change') noteChangeListeners(thisArg);
    }
    const handler = entry.handler, isObject = entry.isObject;
    let g = globalThis, root = null, prevActive;
    if (perRealm) {
      let id;
      try { id = globalThis.RustyRacer.contextOf(realmAnchorOf(handler)); } catch (_) {}
      if (selfRealmId === undefined) { try { selfRealmId = globalThis.RustyRacer.contextOf(globalThis); } catch (_) {} }
      if (id != null && id !== selfRealmId) {
        try { g = globalThis.RustyRacer.contextGlobal(id) || globalThis; } catch (_) {}
      }
      root = globalThis.__csimTop || globalThis;
      prevActive = root.__csimActiveListenerRealmId;
      root.__csimActiveListenerRealmId = id;
      // WindowProxy retargeting: when the event target is a WINDOW and this listener
      // belongs to ANOTHER realm, present `event.target` as that realm's WindowProxy
      // for the window — so a cross-realm listener (and a post-dispatch reader in its
      // realm) sees the same object `contentWindow`/`parent` yields (Event-dispatch-
      // throwing-multiple-globals: `errorEvent.target === iframe.contentWindow`). Not
      // restored afterward: like a real browser, `event.target` stays the WindowProxy.
      if (g !== globalThis && g.__csimFrameWindowProxyFor &&
          globalThis.__csimIsWindowGlobal && globalThis.__csimIsWindowGlobal(state.target)) {
        try {
          const proxied = g.__csimFrameWindowProxyFor(globalThis.RustyRacer.contextOf(state.target));
          if (proxied && proxied !== state.target) {
            if (state.currentTarget === state.target) state.currentTarget = proxied;
            state.target = proxied;
          }
        } catch (_) {}
      }
    }
    const prev = g.__csimCurrentEvent;
    if (!hidden) g.__csimCurrentEvent = event;
    state.inPassiveListener = !!entry.passive;   // passive → preventDefault no-op
    try {
      try {
        // (…`handleEvent` got on every call, a getter's throw and a non-callable one reported as the callback's would be)
        const cb = isObject ? handler.handleEvent : handler;
        if (typeof cb !== 'function') throw new TypeError("Failed to invoke event listener: the 'handleEvent' property is not callable.");
        cb.call(isObject ? handler : thisArg, event);
      } catch (e) {
        // (…and the dispatch's "legacy-output-did-listeners-throw flag" set, which IndexedDB asks)
        state.listenersThrew = true;
        try { globalThis.__csimReportListenerError(realmAnchorOf(handler), e); } catch (_) {}
      }
      // (…inside the call, as inner invoke runs it: the listener's microtasks still passive where it is)
      if (checkpoint) checkpoint();
    } finally {
      state.inPassiveListener = false;
      g.__csimCurrentEvent = prev;
      if (root !== null) root.__csimActiveListenerRealmId = prevActive;
    }
  }
}

// The dispatch of an event at a node — over its tree, with its event path (dispatch.js `dispatchEventPublic`, which
// registers it: dispatch.js imports this module, not this one it).
let nodeDispatch = null;
export function setNodeDispatch(dispatch) {
  nodeDispatch = dispatch;
}

// The target a member acts on: the object itself, or for a window, its global — a WindowProxy (a frame's, whichever
// realm made it, answers its global as `__csimRawWindow`) unwrapped, as the listeners live where events fire.
function targetOf(o) {
  // (…the window and the document first: on the hottest targets, an inherited miss — a Proxy's trap, on the
  // document — costs more than the call it guards)
  if (o === globalThis || o === globalThis.document || o[EVENT_TARGET] === true) return o;
  return o.__csimRawWindow || unwrapWin(o);
}
// What tells an EventTarget apart, for its members' `this` and a conversion to one: an object EventTarget.prototype is
// behind — any realm's, which brands itself — or a window, whose global none is (`window instanceof EventTarget` is the
// Window's own test).
function isEventTarget(o) {
  if (o === null || (typeof o !== 'object' && typeof o !== 'function')) return false;
  if (o === globalThis || o === globalThis.document) return true;
  if (o[EVENT_TARGET] === true) return true;
  const raw = targetOf(o);
  return raw === globalThis || globalThis.__csimIsWindowGlobal(raw);
}

export class EventTarget {}
const EVENT_TARGET = brandPrototype(EventTarget, 'EventTarget');

// A target's listener store (type → list), or none: a node's is its handle's (node_handle.rs `listenerStore`), any
// other target's in its rare data — none a property a page could see or replace.
// (…this realm's window's kept as well, made once and never replaced — every dispatch that reaches the window asks)
const isNodeTarget = (self) => typeof self._nodeType === 'number';
let windowListeners;
export function listenersOf(self) {
  if (self === globalThis) return windowListeners ??= stampedRareDataOf(globalThis)?.listeners;
  return isNodeTarget(self) ? globalThis.__dom.listenerStore(self) : stampedRareDataOf(proxiedWindow(self))?.listeners;
}
// …the object a target's rare data is kept with: itself, or for a WindowProxy of a window — another realm's view of a
// frame, which is no JS Proxy of it — that window, as the WindowProxy is its window to every member (`proxiedWindow`,
// asked of a target that is no node: a document's or a form's named getter would answer an element named
// `__csimRawWindow`).
const proxiedWindow = (o) => o.__csimRawWindow || o;
function heldBy(o) {
  return o === globalThis || isNodeTarget(o) ? o : proxiedWindow(o);
}
// The event types a node has ever had a listener of — a dispatch of any other asks for no store at all — and how often
// a node has gained a store or a type one (`nodeStoresGen`): a dispatch whose stores are older asks again, as a listener
// added from a listener, to a node of the path no listener had been on, fires there all the same (DOM "invoke" reads
// the node's listeners as it reaches it). Both the engine's (node_handle.rs `ListenerTypes`), whichever realm's script
// adds the listener; this realm keeps the types it knows a node has, and those it knew none had as of a count.
const nodeListenerTypes = new Set(), noNodeListenerAt = new Map();
export const nodeStoresGen = () => globalThis.__dom.listenersGen[0];
export function nodesListenTo(type) {
  if (nodeListenerTypes.has(type)) return true;
  const gen = nodeStoresGen();
  if (noNodeListenerAt.get(type) === gen) return false;
  if (globalThis.__dom.listenerTypeKnown(type)) {
    nodeListenerTypes.add(type);
    noNodeListenerAt.delete(type);
    return true;
  }
  noNodeListenerAt.set(type, gen);
  return false;
}
// …each node's of a dispatch's `path`, at its index, in one call — none, where no node has ever had a listener of
// `type`.
const NO_STORES = [];
export function listenerStoresOf(path, type) {
  return nodesListenTo(type) ? globalThis.__dom.listenerStores(path) : NO_STORES;
}
// …and a dispatch's whole path, target to root, with each node's store beside it, in one call (node_handle.rs
// `dispatchPath`): `[path, stores, bubbleEnd, toWindow]` (`formStop` a `submit` or `reset`, `relatedNid` the event's
// relatedTarget's where it is a node); undefined for a node the engine holds no slot for (an Attr); null for a path
// the flat tree's event path takes — across a shadow root, or with a relatedTarget in a shadow tree.
export function eventPathOf(target, formStop, relatedNid) {
  return globalThis.__dom.dispatchPath(target._nid, formStop, relatedNid);
}
export { NO_STORES };
// …and the listeners of `type` on `target`, a node or not, for the WPT testdriver shim: plain descriptors, never the
// live entries (window-events.js `__csimWindowListenersFor`, the window's).
globalThis.__csimListenersFor = function (target, type) {
  const store = listenersOf(target), list = store && store[type];
  return list ? list.map((l) => ({ passive: !!l.passive, capture: !!l.capture })) : [];
};

// DOM "erase all event listeners and handlers" (HTML's document open steps 9-10): every listener of `target` removed —
// one a dispatch in flight would reach skipped (`removed`) — and each of its event handlers deactivated, its value null
// (its wrapper listener with the rest: a value set again adds it anew).
export function eraseListenersAndHandlers(target) {
  const store = listenersOf(target);
  if (store) {
    for (const type of Object.keys(store)) {
      for (const l of store[type]) l.removed = true;
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
  if (signal !== undefined && globalThis.__dom.abortSignalAborted(slotsOf(signal, 'AbortSignal').id)) return;
  let store = listenersOf(self);
  if (!store) {
    store = Object.create(null);
    if (isNodeTarget(self)) globalThis.__dom.listenerStore(self, store);
    else stampedRareDataOf(proxiedWindow(self), true).listeners = store;
  }
  if (isNodeTarget(self) && !nodeListenerTypes.has(type)) {
    nodeListenerTypes.add(type);
    globalThis.__dom.noteListenerType(type);
  }
  const list = store[type] || (store[type] = []);
  // Dedup on {type, callback, capture} with original callback identity.
  if (list.some(l => l.handler === handler && l.capture === capture)) return;
  list.push({ handler, isObject: typeof handler !== 'function', capture, passive, once });
  if (type === 'abort') pinDependentSignal(self);
  else if (type === 'change') noteChangeListeners(self);
  // Only after the listener is actually added (not deduped): the signal's abort removes it, before the `abort` event —
  // which a listener could stop, or redispatch — fires.
  if (signal !== undefined) addAbortAlgorithm(signal, () => removeListener(self, type, handler, capture));
}
// "Add an algorithm" to an AbortSignal (abort.js), which its abort runs before its `abort` event — a listener of which
// could stop or redispatch it; none for a signal aborted already. Here, where a listener's removal adds one, as the
// signal's interface extends this module's EventTarget.
export function addAbortAlgorithm(signal, algorithm) {
  const s = slotsOf(signal, 'AbortSignal');
  if (globalThis.__dom.abortSignalAborted(s.id)) return;
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
  if (s === undefined || globalThis.__dom.abortSignalAborted(s.id)) return;
  for (const root of globalThis.__dom.abortSignalRoots(s.id)) {
    const r = slotsOf(root, 'AbortSignal');
    (r.pinnedDependents || (r.pinnedDependents = new Set())).add(signal);
  }
}
function unpinDependentSignal(signal) {
  const s = slotsOf(signal, 'AbortSignal');
  if (s === undefined || s.abortAlgorithms?.length || listenersOf(signal)?.abort?.length) return;
  for (const root of globalThis.__dom.abortSignalRoots(s.id)) slotsOf(root, 'AbortSignal').pinnedDependents?.delete(signal);
}
// DOM "remove an event listener": `options` the converted `(EventListenerOptions or boolean)`, or the capture alone.
export function removeListener(self, type, handler, options) {
  const capture = !!(typeof options === 'object' ? options.capture : options);
  const store = listenersOf(self);
  if (!store || !store[type]) return;
  store[type] = store[type].filter(l => {
    const isMatch = l.capture === capture && l.handler === handler;
    if (isMatch) l.removed = true;   // in-flight dispatch snapshot must skip it
    return !isMatch;
  });
  if (type === 'abort') unpinDependentSignal(self);
  else if (type === 'change') noteChangeListeners(self);
}
// A MediaQueryList, which the engine holds weakly, held while it has a `change` listener (media_query_lists.rs): one a
// page keeps only through its listener is still told of a flip, as browsers keep it.
function noteChangeListeners(self) {
  const s = slotsOf(self, 'MediaQueryList');
  if (s !== undefined) globalThis.__dom.mqlListened(s.id, listenersOf(self).change.length > 0);
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
    parents.push(t);
  }
  return parents;
}

function dispatchAt(self, event) {
  const state = eventState(event);
  // (…a node's is over its tree: dispatch.js's)
  if (self.__csimIsNode === true) return nodeDispatch(self, event);
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
// script", where the dispatch asks for one), none where none ran.
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
    if (self === globalThis && fireWindowOnHandler(event) && state.checkpoint) state.checkpoint();
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
  addEventListener: (target, type, callback, options) => addListener(targetOf(target), type, callback, options),
  removeEventListener: (target, type, callback, options) => removeListener(targetOf(target), type, callback, options),
  dispatchEvent: (target, event) => dispatchAt(targetOf(target), event)
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
    // `window.onerror` is an OnErrorEventHandler: for an ErrorEvent it takes the
    // legacy 5-arg form (message, source, lineno, colno, error), not the event.
    if (state.type === 'error' && interfaceCheck('ErrorEvent')(event)) {
      const handled = h.call(globalThis, state.message, state.filename, state.lineno, state.colno, state.error);
      if (handled === true && state.cancelable) state.canceled = true;
    } else {
      h.call(globalThis, event);
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

// The `on<type>` EventHandler IDL attributes of a plain EventTarget's `proto` (XMLHttpRequest / MessagePort /
// BroadcastChannel / Worker / IDB* — surfaces with no content attributes, their interfaces not yet
// generated): the same handlers Element's, Document's and ShadowRoot's are (installEventHandlerAttrs below), without a
// content attribute to reflect — `this` one of the interface's objects (`isSelf`; by default, an object any realm's
// prototype of its class brands, which the prototype itself is not).
export function defineEventHandlers(proto, types, isSelf = brandedBy(proto)) {
  installEventHandlerAttrs(proto, types.map((t) => 'on' + t), isSelf);
}
function brandedBy(proto) {
  const brand = brandPrototype(proto.constructor, proto.constructor.name);
  return (o) => o !== null && typeof o === 'object' && o[brand] === true && !Object.hasOwn(o, brand);
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
  const doc = node._ownerDocument || globalThis.document;
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
      // DOMParser's, a template's contents' — and compiled once it is in one with: HTML "getting the current value of
      // the event handler" 1.1, which asks of an uncompiled one alone; one compiled stays, wherever its element goes)
      if (this.node !== null && this.node._ownerDocument?._window === null) return null;
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
  return self.__csimIsNode === true && globalThis.__dom.handlerForwarded(self._nid, attr);
}
function forwardingWindowOf(node) {
  const doc = node._ownerDocument;
  if (doc === globalThis.document) return globalThis;
  const view = doc && doc._window;
  return view ? (view.__csimRawWindow || view) : null;
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
  if (v == null) return null;
  if (v instanceof RawHandler) return v.compile();
  return v;
}
// The callable actually invoked on dispatch: a RawHandler's compiled function
// (compiled lazily here on first fire), a function verbatim, else null (a
// non-callable object never fires).
function handlerCallable(v) {
  if (v instanceof RawHandler) return v.compile();
  return typeof v === 'function' ? v : null;
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
  const handlers = rare.handlers ??= Object.create(null);
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
        if (state.type === 'error' && isGlobal(node) && interfaceCheck('ErrorEvent')(ev)) {
          const ret = cb.call(node, state.message, state.filename, state.lineno, state.colno, state.error);
          if (ret === true && state.cancelable) state.canceled = true;
          return;
        }
        const ret = cb.call(node, ev);
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
  return o === globalThis || globalThis.__csimIsWindowGlobal(o);
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
        const stored = (v !== null && (typeof v === 'object' || typeof v === 'function')) ? v : null;
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
  const handler = globalThis.__dom.inlineHandler(node._nid, attrName);
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

// The UI Events' members (generated/bindings.js), each event's state its fields — installed after EventTarget's brand
// (`initMouseEvent`'s relatedTarget takes one).
// (…`which` the legacy alias Chrome and Firefox answer: a mouse event's button + 1, a keyboard event's key code, 0 for
// any other — the init's own `which` neither reads)
for (const iface of [UIEvent, FocusEvent, MouseEvent, WheelEvent, PointerEvent, DragEvent, KeyboardEvent, InputEvent, CompositionEvent, TextEvent, TouchEvent]) {
  registerInterface(iface.name, eventTest(iface.name));
}
installUIEvent(UIEvent, {
  get_view: (ev) => eventState(ev).view,
  get_detail: (ev) => eventState(ev).detail,
  // (…nothing mid-dispatch; else the event's initialisation, then its view and detail)
  initUIEvent(ev, type, bubbles, cancelable, view, detail) {
    const state = eventState(ev);
    if (state.dispatchFlag) return;
    initEventSteps(ev, type, bubbles, cancelable);
    state.view = view;
    state.detail = detail;
  },
  get_which(ev) {
    const state = eventState(ev);
    return state.button !== undefined ? state.button + 1 : state.keyCode !== undefined ? state.keyCode : 0;
  }
});
installFocusEvent(FocusEvent, { get_relatedTarget: (ev) => eventState(ev).relatedTarget });
// UI Events' getModifierState: whether the given key was held — the four the init's flags name, the others its
// `modifier*` members (and 'Accel' the Control key, as Chrome and Firefox answer on Linux).
function modifierState(ev, key) {
  const state = eventState(ev);
  switch (key) {
    case 'Alt':     return state.altKey;
    case 'Accel':
    case 'Control': return state.ctrlKey;
    case 'Meta':    return state.metaKey;
    case 'Shift':   return state.shiftKey;
  }
  const i = MODIFIER_KEYS.indexOf(key);
  return i !== -1 && (state.modifiers & (1 << i)) !== 0;
}
// CSSOM View's coordinates of a mouse event: its page position the client one and its window's scroll — the scroll
// when it was dispatched at the target (a dispatching event's), else its view's, none without one — and its offset
// from the target's padding edge while it is dispatched, its page position otherwise. (`layerX` / `layerY`, which no
// spec defines beyond "the current layer", the page position: no layer is modelled, and a page with no positioned
// ancestor is Chrome's.)
function pageXOf(ev) {
  const state = eventState(ev);
  const view = state.dispatchFlag ? globalThis : state.view && (state.view.__csimRawWindow || state.view);
  return state.clientX + (view ? view.__csimWindowSteps.get_scrollX(view) : 0);
}
function pageYOf(ev) {
  const state = eventState(ev);
  const view = state.dispatchFlag ? globalThis : state.view && (state.view.__csimRawWindow || state.view);
  return state.clientY + (view ? view.__csimWindowSteps.get_scrollY(view) : 0);
}
function offsetOf(ev, axis) {
  const state = eventState(ev);
  const target = state.target;
  if (!state.dispatchFlag || !target || target._nodeType !== 1) return axis === 'x' ? pageXOf(ev) : pageYOf(ev);
  const origin = globalThis.__csimPaddingEdgeOrigin(target);
  return axis === 'x' ? state.clientX - origin.x : state.clientY - origin.y;
}
installTouchEvent(TouchEvent, {
  get_touches: (ev) => eventState(ev).touches,
  get_targetTouches: (ev) => eventState(ev).targetTouches,
  get_changedTouches: (ev) => eventState(ev).changedTouches,
  get_altKey: (ev) => eventState(ev).altKey,
  get_metaKey: (ev) => eventState(ev).metaKey,
  get_ctrlKey: (ev) => eventState(ev).ctrlKey,
  get_shiftKey: (ev) => eventState(ev).shiftKey,
  getModifierState: (ev, key) => modifierState(ev, key)
});
installMouseEvent(MouseEvent, {
  get_screenX: (ev) => eventState(ev).screenX,
  get_screenY: (ev) => eventState(ev).screenY,
  get_clientX: (ev) => eventState(ev).clientX,
  get_clientY: (ev) => eventState(ev).clientY,
  get_layerX: (ev) => pageXOf(ev),
  get_layerY: (ev) => pageYOf(ev),
  get_ctrlKey: (ev) => eventState(ev).ctrlKey,
  get_shiftKey: (ev) => eventState(ev).shiftKey,
  get_altKey: (ev) => eventState(ev).altKey,
  get_metaKey: (ev) => eventState(ev).metaKey,
  get_button: (ev) => eventState(ev).button,
  get_buttons: (ev) => eventState(ev).buttons,
  get_relatedTarget: (ev) => eventState(ev).relatedTarget,
  getModifierState: (ev, key) => modifierState(ev, key),
  // (…nothing mid-dispatch; else the event's initialisation, then the rest of the arguments)
  initMouseEvent(ev, type, bubbles, cancelable, view, detail, screenX, screenY, clientX, clientY, ctrlKey, altKey, shiftKey, metaKey, button, relatedTarget) {
    if (eventState(ev).dispatchFlag) return;
    initEventSteps(ev, type, bubbles, cancelable);
    Object.assign(eventState(ev), {
      view, detail, screenX, screenY, clientX, clientY, ctrlKey, altKey, shiftKey, metaKey, button, relatedTarget
    });
  },
  get_pageX: (ev) => pageXOf(ev),
  get_pageY: (ev) => pageYOf(ev),
  get_x: (ev) => eventState(ev).clientX,
  get_y: (ev) => eventState(ev).clientY,
  get_offsetX: (ev) => offsetOf(ev, 'x'),
  get_offsetY: (ev) => offsetOf(ev, 'y'),
  get_movementX: (ev) => eventState(ev).movementX,
  get_movementY: (ev) => eventState(ev).movementY
});
installWheelEvent(WheelEvent, {
  get_deltaX: (ev) => eventState(ev).deltaX,
  get_deltaY: (ev) => eventState(ev).deltaY,
  get_deltaZ: (ev) => eventState(ev).deltaZ,
  get_deltaMode: (ev) => eventState(ev).deltaMode
});
// (…its coalesced and predicted events the init's: a trusted `pointermove`'s, trustedPointerMove)
installPointerEvent(PointerEvent, {
  get_pointerId: (ev) => eventState(ev).pointerId,
  get_width: (ev) => eventState(ev).width,
  get_height: (ev) => eventState(ev).height,
  get_pressure: (ev) => eventState(ev).pressure,
  get_tangentialPressure: (ev) => eventState(ev).tangentialPressure,
  get_tiltX: (ev) => eventState(ev).tiltX,
  get_tiltY: (ev) => eventState(ev).tiltY,
  get_twist: (ev) => eventState(ev).twist,
  get_altitudeAngle: (ev) => eventState(ev).altitudeAngle,
  get_azimuthAngle: (ev) => eventState(ev).azimuthAngle,
  get_pointerType: (ev) => eventState(ev).pointerType,
  get_isPrimary: (ev) => eventState(ev).isPrimary,
  get_persistentDeviceId: (ev) => eventState(ev).persistentDeviceId,
  getCoalescedEvents: (ev) => eventState(ev).coalescedEvents.slice(),
  getPredictedEvents: (ev) => eventState(ev).predictedEvents.slice()
});
installDragEvent(DragEvent, { get_dataTransfer: (ev) => eventState(ev).dataTransfer });

// The other specs' events (generated/bindings.js), each event's state its fields.
for (const iface of [
  PopStateEvent, HashChangeEvent, PageTransitionEvent, BeforeUnloadEvent, ErrorEvent, PromiseRejectionEvent, FormDataEvent,
  SubmitEvent, ToggleEvent, CommandEvent, StorageEvent, MessageEvent, ProgressEvent, CloseEvent, AnimationEvent, TransitionEvent,
  AnimationPlaybackEvent, ClipboardEvent, GamepadEvent, DeviceMotionEvent, DeviceOrientationEvent, MediaQueryListEvent,
  IDBVersionChangeEvent, FontFaceSetLoadEvent
]) {
  registerInterface(iface.name, eventTest(iface.name));
}
installPopStateEvent(PopStateEvent, {
  get_state: (ev) => eventState(ev).state,
  get_hasUAVisualTransition: (ev) => eventState(ev).hasUAVisualTransition
});
installHashChangeEvent(HashChangeEvent, {
  get_oldURL: (ev) => eventState(ev).oldURL,
  get_newURL: (ev) => eventState(ev).newURL
});
installPageTransitionEvent(PageTransitionEvent, { get_persisted: (ev) => eventState(ev).persisted });
installBeforeUnloadEvent(BeforeUnloadEvent, {
  get_returnValue: (ev) => eventState(ev).returnValue,
  set_returnValue(ev, v) { eventState(ev).returnValue = v; }
});
installErrorEvent(ErrorEvent, {
  get_message: (ev) => eventState(ev).message,
  get_filename: (ev) => eventState(ev).filename,
  get_lineno: (ev) => eventState(ev).lineno,
  get_colno: (ev) => eventState(ev).colno,
  get_error: (ev) => eventState(ev).error
});
installPromiseRejectionEvent(PromiseRejectionEvent, {
  get_promise: (ev) => eventState(ev).promise,
  get_reason: (ev) => eventState(ev).reason
});
installFormDataEvent(FormDataEvent, { get_formData: (ev) => eventState(ev).formData });
installSubmitEvent(SubmitEvent, { get_submitter: (ev) => eventState(ev).submitter });
// DOM "retarget", dispatch.js's, which it hands this module: a ToggleEvent's and a CommandEvent's source against the
// event's current target (HTML) — a shadow tree's invoker reads as its host outside the tree — and a flat dispatch's
// relatedTarget against its target.
let retarget = (source) => source;
export function setRetargeter(fn) { retarget = fn; }
function sourceOf(ev) {
  const state = eventState(ev);
  return state.source == null ? null : retarget(state.source, state.currentTarget);
}
installToggleEvent(ToggleEvent, {
  get_oldState: (ev) => eventState(ev).oldState,
  get_newState: (ev) => eventState(ev).newState,
  get_source: sourceOf
});
installCommandEvent(CommandEvent, { get_source: sourceOf, get_command: (ev) => eventState(ev).command });
installStorageEvent(StorageEvent, {
  get_key: (ev) => eventState(ev).key,
  get_oldValue: (ev) => eventState(ev).oldValue,
  get_newValue: (ev) => eventState(ev).newValue,
  get_url: (ev) => eventState(ev).url,
  get_storageArea: (ev) => eventState(ev).storageArea,
  // (…nothing mid-dispatch; else the event's initialisation, then the rest of the arguments)
  initStorageEvent(ev, type, bubbles, cancelable, key, oldValue, newValue, url, storageArea) {
    if (eventState(ev).dispatchFlag) return;
    initEventSteps(ev, type, bubbles, cancelable);
    Object.assign(eventState(ev), { key, oldValue, newValue, url, storageArea });
  }
});
installMessageEvent(MessageEvent, {
  get_data: (ev) => eventState(ev).data,
  get_origin: (ev) => eventState(ev).origin,
  get_lastEventId: (ev) => eventState(ev).lastEventId,
  get_source: (ev) => eventState(ev).source,
  get_ports: (ev) => eventState(ev).ports,
  // (…nothing mid-dispatch; else the event's initialisation, then the rest of the arguments)
  initMessageEvent(ev, type, bubbles, cancelable, data, origin, lastEventId, source, ports) {
    if (eventState(ev).dispatchFlag) return;
    initEventSteps(ev, type, bubbles, cancelable);
    Object.assign(eventState(ev), { data, origin, lastEventId, source, ports: Object.freeze(ports.slice()) });
  }
});
installProgressEvent(ProgressEvent, {
  get_lengthComputable: (ev) => eventState(ev).lengthComputable,
  get_loaded: (ev) => eventState(ev).loaded,
  get_total: (ev) => eventState(ev).total
});
installCloseEvent(CloseEvent, {
  get_wasClean: (ev) => eventState(ev).wasClean,
  get_code: (ev) => eventState(ev).code,
  get_reason: (ev) => eventState(ev).reason
});
installAnimationEvent(AnimationEvent, {
  get_animationName: (ev) => eventState(ev).animationName,
  get_elapsedTime: (ev) => eventState(ev).elapsedTime,
  get_pseudoElement: (ev) => eventState(ev).pseudoElement,
  get_animation: (ev) => eventState(ev).animation
});
installTransitionEvent(TransitionEvent, {
  get_propertyName: (ev) => eventState(ev).propertyName,
  get_elapsedTime: (ev) => eventState(ev).elapsedTime,
  get_pseudoElement: (ev) => eventState(ev).pseudoElement,
  get_animation: (ev) => eventState(ev).animation
});
installAnimationPlaybackEvent(AnimationPlaybackEvent, {
  get_currentTime: (ev) => eventState(ev).currentTime,
  get_timelineTime: (ev) => eventState(ev).timelineTime
});
installClipboardEvent(ClipboardEvent, { get_clipboardData: (ev) => eventState(ev).clipboardData });
installMediaQueryListEvent(MediaQueryListEvent, {
  get_media: (ev) => eventState(ev).media,
  get_matches: (ev) => eventState(ev).matches
});
installIDBVersionChangeEvent(IDBVersionChangeEvent, {
  get_oldVersion: (ev) => eventState(ev).oldVersion,
  get_newVersion: (ev) => eventState(ev).newVersion
});
installFontFaceSetLoadEvent(FontFaceSetLoadEvent, { get_fontfaces: (ev) => eventState(ev).fontfaces });
installGamepadEvent(GamepadEvent, { get_gamepad: (ev) => eventState(ev).gamepad });
// (…no sensor to ask a permission of: denied, as a desktop's browser without one answers)
installDeviceMotionEvent(DeviceMotionEvent, {
  get_acceleration: (ev) => eventState(ev).acceleration,
  get_accelerationIncludingGravity: (ev) => eventState(ev).accelerationIncludingGravity,
  get_rotationRate: (ev) => eventState(ev).rotationRate,
  get_interval: (ev) => eventState(ev).interval,
  requestPermission: () => resolvedPromise('denied')
});
installDeviceOrientationEvent(DeviceOrientationEvent, {
  get_alpha: (ev) => eventState(ev).alpha,
  get_beta: (ev) => eventState(ev).beta,
  get_gamma: (ev) => eventState(ev).gamma,
  get_absolute: (ev) => eventState(ev).absolute,
  requestPermission: () => resolvedPromise('denied')
});
installKeyboardEvent(KeyboardEvent, {
  get_key: (ev) => eventState(ev).key,
  get_code: (ev) => eventState(ev).code,
  get_location: (ev) => eventState(ev).location,
  get_ctrlKey: (ev) => eventState(ev).ctrlKey,
  get_shiftKey: (ev) => eventState(ev).shiftKey,
  get_altKey: (ev) => eventState(ev).altKey,
  get_metaKey: (ev) => eventState(ev).metaKey,
  get_repeat: (ev) => eventState(ev).repeat,
  get_isComposing: (ev) => eventState(ev).isComposing,
  getModifierState: (ev, key) => modifierState(ev, key),
  // (…nothing mid-dispatch; else the event's initialisation, then its view, key, location and modifiers)
  initKeyboardEvent(ev, type, bubbles, cancelable, view, key, location, ctrlKey, altKey, shiftKey, metaKey) {
    if (eventState(ev).dispatchFlag) return;
    initEventSteps(ev, type, bubbles, cancelable);
    Object.assign(eventState(ev), { view, key, location, ctrlKey, altKey, shiftKey, metaKey });
  },
  get_charCode: (ev) => eventState(ev).charCode,
  get_keyCode: (ev) => eventState(ev).keyCode
});
// (…its target ranges until its dispatch ends: dispatch.js)
installInputEvent(InputEvent, {
  get_data: (ev) => eventState(ev).data,
  get_isComposing: (ev) => eventState(ev).isComposing,
  get_inputType: (ev) => eventState(ev).inputType,
  get_dataTransfer: (ev) => eventState(ev).dataTransfer,
  getTargetRanges: (ev) => eventState(ev).targetRanges.slice()
});
installCompositionEvent(CompositionEvent, {
  get_data: (ev) => eventState(ev).data,
  initCompositionEvent(ev, type, bubbles, cancelable, view, data) {
    const state = eventState(ev);
    if (state.dispatchFlag) return;
    initEventSteps(ev, type, bubbles, cancelable);
    state.view = view;
    state.data = data;
  }
});
installTextEvent(TextEvent, {
  get_data: (ev) => eventState(ev).data,
  initTextEvent(ev, type, bubbles, cancelable, view, data) {
    const state = eventState(ev);
    if (state.dispatchFlag) return;
    initEventSteps(ev, type, bubbles, cancelable);
    state.view = view;
    state.data = data;
  }
});
