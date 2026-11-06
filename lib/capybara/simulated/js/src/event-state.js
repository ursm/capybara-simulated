// An event's state, what its interfaces' bindings (generated/bindings.js, script/gen_bindings.mjs `eventInterface`) read and
// add to and the dispatch writes: its internal slots, every interface's of it in one record — of no prototype, so no
// `Object.prototype` member a page defined meets a slot written or read. (Not `Object.create(null)`, which V8 keeps in a
// dictionary, for the reason webidl.js `Dictionary` is not: an event is made per dispatch.)
export function EventState(type, init) {
  this.type = type;
  this.bubbles = init.bubbles;
  this.cancelable = init.cancelable;
  this.composed = init.composed;
  this.canceled = false;
  this.target = null;
  this.currentTarget = null;
  this.eventPhase = 0;
  this.isTrusted = false;
  this.propagationStopped = false;
  this.immediatePropagationStopped = false;
  // DOM "initialized flag": a constructed event is initialized; one made via `document.createEvent` is NOT until
  // `initEvent` runs. `dispatchFlag` guards against re-dispatching an event that's mid-flight. Both gate
  // `dispatchEvent` (InvalidStateError).
  this.initialized = true;
  this.dispatchFlag = false;
  // (…and the microtask checkpoint to run after each callback of its dispatch, once asked: `cleanUpAfterCallback`)
  this.checkpoint = undefined;
  // (…and, through a flat dispatch — not a node's — its target and the target's parents: composedPathOf)
  this.csimFlatTarget = null;
  this.csimFlatParents = null;
  // (…and whether a listener threw, DOM's "legacy-output-did-listeners-throw flag": IndexedDB's success and error events)
  this.listenersThrew = false;
  // (…its event path through a node tree while it is dispatched there — its nodes, the window it goes on to, and each
  // node's struct where a shadow tree retargets it: dispatch.js — and whether the dispatch is in a passive listener)
  this.csimNodePath = null;
  this.csimPath = null;
  this.csimPathWindow = null;
  this.inPassiveListener = false;
  // (…whether it is a click at no point — `click()`, a key's activation — whose activation selects no coordinate:
  // dom-nodes `activationBehavior`)
  this.noPoint = false;
  // (…whether the platform, not a page's dispatchEvent, fires it: dispatchWithOnHandler)
  this.uaFired = false;
  // Capture timeStamp EAGERLY at construction (the event's time origin per spec) rather than lazily at first read — a
  // lazily-read timestamp is taken AFTER the event was created, which breaks `before <= e.timeStamp <= after` when the
  // reader brackets construction with performance.now() (WPT Event-timestamp-high-resolution).
  this.ts = globalThis.__csimPerformanceNow();
}
EventState.prototype = Object.create(null);

// DOM "initialize" an event: initialized, its flags and target cleared, its type and two attributes `type`'s.
export function initEventSteps(state, type, bubbles, cancelable) {
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
