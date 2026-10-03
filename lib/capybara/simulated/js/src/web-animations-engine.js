// The Web Animations API as handles on the style engine's model (ext/csim_native/src/animations.rs).
//
// An `Animation` / `KeyframeEffect` here holds the id the engine knows it by, and everything else — its timing, its
// state, the values it composites into the target's style — is the engine's. What stays on this side is what a
// binding is for: turning the page's arguments into the engine's (the keyframes and timing are processed as
// web-animations.js processes them, the same WebIDL rules), and turning the engine's signals back into the page's
// objects — a promise settled, an event dispatched.
//
// The engine makes animations of its own too: a CSS animation or transition is one style made (css_animations.rs,
// css_transitions.rs). Its handle — a `CSSAnimation` / `CSSTransition`, and a `KeyframeEffect` for its effect — is
// made when a page first meets it (`getAnimations()`, an event), and reads what style keeps up to date from the engine.
import { NODE_ELEMENT, HTML_NS, SVG_NS, MATHML_NS } from './constants.js';
import { AnimationPlaybackEvent, EventTarget, defineEventHandlers, dispatchWithOnHandler } from './events.js';
import { bumpCascadeVersion, ensureStyleEngine, flushStyleEngine, onStyleEngineRetargeted, styleEngineValue } from './cascade.js';
import { markLayoutDirty } from './mutation-observer.js';
import { arenaNid } from './native-query-shadow.js';
import { walkInclShadow } from './walk.js';
import { AnimationTimeline, COMPOSITE_OPERATIONS, DocumentTimeline, TIMING_DEFAULTS, documentTimeline, effectComposite, idlNameOf, normalizeKeyframes,
         normalizeTiming, useEngineAnimations } from './web-animations.js';

// The realm's style engine, made (fed the document's sheets) if nothing has asked it anything yet.
const engine = () => {
  ensureStyleEngine();
  return globalThis.__dom;
};
// …and the page's clock, which the engine's timeline reads at every question (`animState`, `animCall`, `animTiming`).
const now = () => globalThis.__virtualNow();

// What makes a handle for an animation or effect the engine made, rather than one the page asks for.
const ADOPT = globalThis.Symbol('adopt');

// Every animation by the engine's id, for its signals to find — weakly…
const HANDLES = new globalThis.Map();
// …but one that plays (not idle, and not over without a fill) is held: the timeline holds it, so a page that let go
// of its handle still finds it in `getAnimations()`, and its promises and events still reach their listeners.
const KEPT = new globalThis.Set();
// …and every effect by its id, as weakly. A handle collected (an animation idle or over, so not kept) lets the engine
// let go of what it held — or, a CSS animation's that style still owns, keeps it for a handle made anew: swept at each
// rendering update (`sweep`) — a FinalizationRegistry's callbacks never run in this runtime.
const EFFECTS = new globalThis.Map();
function sweep() {
  for (const [map, kind] of [[HANDLES, 'animation'], [EFFECTS, 'effect']]) {
    for (const [id, ref] of map) {
      if (ref.deref()) continue;
      map.delete(id);
      globalThis.__dom.animDrop(kind, id);
    }
  }
}
// The events due at the next rendering update (web-animations §4.4.2 / §4.4.13: an animation's `finish` and
// `cancel` join the document's pending animation event queue), in the order they fell due.
const PENDING_EVENTS = [];
// Bumped by anything that can change which elements these animate and what: what `engineAnimatedProperties` keeps per
// element is thrown away then.
let generation = 0;

// The engine's timing arguments: [delay, endDelay, fill, iterationStart, iterations, duration, direction, easing],
// `duration: auto` being 0 for a keyframe effect.
function timingArgs(t) {
  return [t.delay, t.endDelay, t.fill, t.iterationStart, t.iterations, durationOf(t), t.direction, t.easing];
}
// (An infinite duration is one; only `auto` is 0.)
const durationOf = (timing) => (timing.duration === 'auto' ? 0 : Number(timing.duration));

// A time or rate a page writes (WebIDL `double`): a TypeError where it is not a finite number.
function finite(value, what) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new globalThis.TypeError(`Failed to set '${what}' on 'Animation': the value is not finite.`);
  return n;
}

// …and its keyframe arguments: [count, then per keyframe: computed offset, easing | null, composite | null,
// declaration count, (property, value)…] — the declarations as the page wrote them (a shorthand is the engine's to
// expand).
function keyframeArgs(frames) {
  const out = [frames.length];
  for (const frame of frames) {
    const names = Object.keys(frame.declared);
    out.push(frame.computedOffset, frame.easing, frame.composite === 'auto' ? null : frame.composite, names.length);
    for (const name of names) out.push(name, frame.declared[name]);
  }
  return out;
}

const targetId = (target) => (target && target.nodeType === NODE_ELEMENT ? arenaNid(target) : -1);

// Every element an animation has targeted — a script's effect, or one a style flush reported (a CSS animation's):
// what the JS side's cascade and layout ask of an element never in it is answered without asking the engine, so a
// page with no animations pays a set lookup per element (rule 3).
const TARGETED = new globalThis.WeakSet();
function targeted(target) {
  if (target && target.nodeType === NODE_ELEMENT) TARGETED.add(target);
}

// Whether an animation is held (`KEPT`), as it stands after whatever moved it.
function reconsider(anim) {
  const state = anim._state();
  const plays = state && state[0] !== 'idle' && (state[0] !== 'finished' || (anim._effect && inEffect(anim)));
  if (plays) KEPT.add(anim);
  else KEPT.delete(anim);
}
const inEffect = (anim) => engine().animTiming(anim._effect._id, now())[1] !== null;

// What an element shows moved otherwise than with the clock (an animation made, sought, paused, its effect changed):
// the JS side lays it out again, and asks again what its animations set.
function invalidate(target) {
  if (!target || target.nodeType !== NODE_ELEMENT) return;
  generation++;
  markLayoutDirty(target, true);
}

// What each element's animations set as of the last look (`reconcileProperties`). A custom property, `display` or
// `visibility` it newly animates reach memos keyed on the whole cascade (a `var()` a descendant reads; the rendered
// text), which it re-keys whole.
const ANIMATED_PROPERTIES = new globalThis.WeakMap();
const REKEYS_THE_CASCADE = new globalThis.Set(['display', 'visibility']);
function reconcileProperties(targets) {
  for (const target of targets) {
    if (!target || target.nodeType !== NODE_ELEMENT) continue;
    invalidate(target);
    const was = ANIMATED_PROPERTIES.get(target);
    const props = engineAnimatedProperties(target);
    if (props) ANIMATED_PROPERTIES.set(target, props);
    else ANIMATED_PROPERTIES.delete(target);
    if (props && [...props].some((p) => (!was || !was.has(p)) && (p.startsWith('--') || REKEYS_THE_CASCADE.has(p)))) bumpCascadeVersion();
  }
}

// The elements whose animations' properties changed — an effect made, let go or moved, new keyframes, a CSS animation
// or transition — as a style flush reports them, found by one walk of the document and its shadow trees.
onStyleEngineRetargeted((nids) => {
  const doc = globalThis.document;
  generation++;
  if (!doc) return;
  const wanted = new globalThis.Set(nids);
  const found = [];
  walkInclShadow(doc, (node) => {
    if (!wanted.has(node._nid)) return;
    targeted(node);
    found.push(node);
  });
  reconcileProperties(found);
});

function throwFor(error, method) {
  if (!error) return;
  if (error === 'TypeError') throw new globalThis.TypeError(`Failed to execute '${method}' on 'Animation'`);
  throw new globalThis.DOMException(`Failed to execute '${method}' on 'Animation'`, error);
}

// ── Effects ─────────────────────────────────────────────────────────────────────────────────
// An effect the engine made (a CSS animation's) keeps no timing or keyframes here: style keeps them up to date in
// the engine, and they are read from there.
export class AnimationEffect {
  getTiming() {
    if (this._timing) return Object.assign({}, this._timing);
    const [delay, endDelay, fill, iterationStart, iterations, duration, direction, easing] = engine().animEffectTiming(this._id);
    return { delay, endDelay, fill, iterationStart, iterations, duration, direction, easing };
  }
  updateTiming(update) {
    if (!update) return;
    const merged = this.getTiming();
    const set = [];
    for (const key of Object.keys(TIMING_DEFAULTS)) {
      if (update[key] === undefined) continue;
      merged[key] = update[key];
      set.push(key);
    }
    this._timing = normalizeTiming(merged);
    engine().animEffectSet(this._id, 'timing', timingArgs(this._timing), set);
    drain();
    invalidate(this._target);
    if (this._animation) reconsider(this._animation);
  }
  getComputedTiming() {
    const timing = this.getTiming();
    const [localTime, progress, currentIteration, activeDuration, endTime] = engine().animTiming(this._id, now());
    return Object.assign(timing, {
      duration: durationOf(timing), activeDuration, endTime, localTime, progress, currentIteration,
      fill: timing.fill === 'auto' ? 'none' : timing.fill
    });
  }
}

export class KeyframeEffect extends AnimationEffect {
  constructor(target, keyframes, options) {
    super();
    if (target === ADOPT) {
      // An effect the engine made: `keyframes` is its id, `options` its target and pseudo-element.
      this._id = keyframes;
      [this._target, this._pseudoElement] = options;
      this._frames = null;
      this._timing = null;
      this._composite = 'replace';
      this._iterationComposite = 'replace';
    } else {
      if (arguments.length === 1 && target instanceof KeyframeEffect) {
        // The copy constructor: the same target, keyframes and timing, in an effect of its own.
        const source = target;
        this._target = source._target;
        this._frames = source._frames ? source._frames.map((f) => Object.assign({}, f)) : normalizeKeyframes(engineKeyframes(source._id));
        this._timing = source.getTiming();
        this._composite = source._composite;
        this._iterationComposite = source._iterationComposite || 'replace';
        this._pseudoElement = source._pseudoElement;
      } else {
        this._target = target || null;
        this._frames = normalizeKeyframes(keyframes);
        this._timing = normalizeTiming(options);
        this._composite = effectComposite(options && options.composite);
        this._iterationComposite = options && options.iterationComposite === 'accumulate' ? 'accumulate' : 'replace';
        this._pseudoElement = options && options.pseudoElement != null ? String(options.pseudoElement) : null;
      }
      this._id = engine().animEffect(targetId(this._target), this._pseudoElement, timingArgs(this._timing),
                                     this._composite, this._iterationComposite, keyframeArgs(this._frames));
    }
    targeted(this._target);
    this._animation = null;
    EFFECTS.set(this._id, new globalThis.WeakRef(this));
  }
  get target() { return this._target; }
  set target(v) {
    invalidate(this._target);
    this._target = v || null;
    targeted(this._target);
    engine().animEffectSet(this._id, 'target', targetId(this._target), this._pseudoElement);
    drain();
    reconcileProperties([this._target]);
  }
  get pseudoElement() { return this._pseudoElement; }
  set pseudoElement(v) {
    this._pseudoElement = v == null ? null : String(v);
    engine().animEffectSet(this._id, 'target', targetId(this._target), this._pseudoElement);
    drain();
    invalidate(this._target);
  }
  get composite() { return this._composite; }
  // (An IDL enumeration attribute ignores a value outside the enum.)
  set composite(v) {
    const name = String(v);
    if (!COMPOSITE_OPERATIONS.has(name)) return;
    this._composite = name;
    engine().animEffectSet(this._id, 'composite', name);
    invalidate(this._target);
  }
  get iterationComposite() { return this._iterationComposite; }
  set iterationComposite(v) {
    const name = String(v);
    if (name !== 'replace' && name !== 'accumulate') return;
    this._iterationComposite = name;
    engine().animEffectSet(this._id, 'iterationComposite', name);
    invalidate(this._target);
  }
  getKeyframes() {
    if (!this._frames) return engineKeyframes(this._id).map((f) => Object.assign(f, { computedOffset: f.offset }));
    return this._frames.map((f) => {
      const out = { offset: f.offset, easing: f.easing || 'linear', composite: f.composite || 'auto' };
      for (const prop of Object.keys(f.declared)) out[idlNameOf(prop)] = f.declared[prop];
      out.computedOffset = f.computedOffset;
      return out;
    });
  }
  setKeyframes(keyframes) {
    this._frames = normalizeKeyframes(keyframes);
    engine().animEffectSet(this._id, 'keyframes', keyframeArgs(this._frames));
    reconcileProperties([this._target]);
  }
}

// The keyframes of an effect the engine made, as a page would give them (offset, easing, composite, then each
// declaration under its IDL name): a CSS animation's, as its `@keyframes` rule declares them.
function engineKeyframes(effect) {
  const flat = engine().animKeyframes(effect);
  const out = [];
  for (let i = 1, n = 0; n < flat[0]; n++) {
    const frame = { offset: flat[i], easing: flat[i + 1], composite: flat[i + 2] || 'auto' };
    const count = flat[i + 3];
    i += 4;
    for (let d = 0; d < count; d++, i += 2) frame[idlNameOf(flat[i])] = flat[i + 1];
    out.push(frame);
  }
  return out;
}

// ── Animations ──────────────────────────────────────────────────────────────────────────────
export class Animation extends EventTarget {
  constructor(effect, timeline) {
    super();
    if (effect === ADOPT) {
      // An animation the engine made: `timeline` is its id, and its effect's handle is made with it.
      const [effectId, target, pseudo] = arguments[2];
      this._id = timeline;
      this._timeline = documentTimeline;
      this._effect = effectId ? new KeyframeEffect(ADOPT, effectId, [target, pseudo]) : null;
    } else {
      this._effect = effect || null;
      this._timeline = timeline === undefined ? documentTimeline : timeline;
      this._id = engine().animNew(this._effect ? this._effect._id : 0, this._timeline !== null);
      const previous = this._effect && this._effect._animation;
      if (previous) previous._effect = null;
      if (previous) reconsider(previous);
      if (this._effect) reconcileProperties([this._effect._target]);
    }
    if (this._effect) this._effect._animation = this;
    this._name = '';
    this._ready = null;
    this._finished = null;
    HANDLES.set(this._id, new globalThis.WeakRef(this));
    reconsider(this);
    drain();
  }
  // [playState, currentTime, startTime, playbackRate, pending, readyGeneration, readySettled, finishedGeneration,
  //  finishedSettled, replaceState, finishNotificationQueued]
  // (A read moves the timeline to the page's clock, which can finish the animation: what that queued — a finish
  // notification — is taken now, for the next microtask checkpoint.)
  _state() {
    const state = engine().animState(this._id, now());
    drain();
    return state;
  }
  _call(method, arg) {
    const error = engine().animCall(this._id, method, arg, now());
    drain();
    globalThis.__csimWakeForAnimations();
    const target = this._effect && this._effect._target;
    invalidate(target);
    reconsider(this);
    throwFor(error, method);
  }

  get id() { return this._name; }
  set id(v) { this._name = String(v); }
  get effect() { return this._effect; }
  set effect(v) {
    const effect = v || null;
    if (effect === this._effect) return;
    if (this._effect) {
      this._effect._animation = null;
      invalidate(this._effect._target);
    }
    const previous = effect && effect._animation;
    if (previous) previous._effect = null;
    this._effect = effect;
    if (effect) effect._animation = this;
    this._call('effect', effect ? effect._id : 0);
    if (effect) reconcileProperties([effect._target]);
    if (previous) reconsider(previous);
  }
  get timeline() { return this._timeline; }
  get playState() { return this._state()[0]; }
  get currentTime() { return this._state()[1]; }
  set currentTime(v) { this._call('currentTime', v == null ? null : finite(v, 'currentTime')); }
  get startTime() { return this._state()[2]; }
  set startTime(v) { this._call('startTime', v == null ? null : finite(v, 'startTime')); }
  get playbackRate() { return this._state()[3]; }
  set playbackRate(v) { this._call('playbackRate', finite(v, 'playbackRate')); }
  get pending() { return this._state()[4]; }
  get replaceState() { return this._state()[9]; }
  get ready() { return this._promise('_ready', 5); }
  get finished() { return this._promise('_finished', 7); }

  play() { this._call('play'); }
  pause() { this._call('pause'); }
  finish() { this._call('finish'); }
  cancel() { this._call('cancel'); }
  reverse() { this._call('reverse'); }
  updatePlaybackRate(rate) { this._call('updatePlaybackRate', finite(rate, 'playbackRate')); }
  persist() { this._call('persist'); }
  // What the animation shows now, written into the target's own inline style (web-animations §4.4.19): its effect
  // stack up to and including it, composited over the target's own values — the engine's to compose. A target that
  // cannot have a style attribute — a pseudo-element, an element of no namespace that defines one (CSS Style
  // Attributes: HTML, SVG, MathML) — is an error, and so is one not rendered.
  commitStyles() {
    const effect = this._effect;
    const target = effect && effect._target;
    if (!target) return;
    if (effect._pseudoElement || !target.style || !STYLE_ATTRIBUTE_NAMESPACES.has(target._ns)) {
      throw new globalThis.DOMException("Failed to execute 'commitStyles' on 'Animation': the target has no style attribute.", 'NoModificationAllowedError');
    }
    if (!target.isConnected || (globalThis.__isLaidOutNode && !globalThis.__isLaidOutNode(target))) {
      throw new globalThis.DOMException("Failed to execute 'commitStyles' on 'Animation': the target is not rendered.", 'InvalidStateError');
    }
    // (…after the pending style changes are applied: an effect made in this task has its keyframes computed then.)
    flushStyleEngine();
    let values = engine().animCommitValues(this._id, now());
    // A transform interpolated as a MATRIX between two mismatched lists is no value a declaration holds until it is
    // resolved against the target's box (csswg-drafts#2854 leaves the committed form open; Chrome commits the matrix),
    // so the engine is asked again with the border box — only then, since asking for a box lays the page out.
    if (values.some((v) => /\b(?:interpolate|accumulate)matrix\(/.test(v))) {
      const box = globalThis.__csimBorderBoxSize && globalThis.__csimBorderBoxSize(target);
      if (box) values = engine().animCommitValues(this._id, now(), box.width, box.height);
    }
    for (let i = 0; i < values.length; i += 2) target.style.setProperty(values[i], values[i + 1]);
  }

  // The promise the engine's generation `generation` of it is: made when the page first asks, settled at once if
  // the engine says it is (a rejection is always followed by a new generation, so a settled current one is resolved).
  _promise(slot, at) {
    const state = this._state();
    let entry = this[slot];
    if (!entry || entry.generation !== state[at]) {
      entry = { generation: state[at] };
      entry.promise = new globalThis.Promise((resolve, reject) => { entry.resolve = resolve; entry.reject = reject; });
      // (A promise nobody waits on still rejects somewhere.)
      entry.promise.catch(() => {});
      if (state[at + 1]) entry.resolve(this);
      this[slot] = entry;
    }
    return entry.promise;
  }
  _settle(slot, generation, rejected) {
    const entry = this[slot];
    if (!entry || entry.generation !== generation) return;
    if (rejected) entry.reject(new globalThis.DOMException('The user aborted a request.', 'AbortError'));
    else entry.resolve(this);
  }
}
defineEventHandlers(Animation.prototype, ['finish', 'cancel', 'remove']);
const STYLE_ATTRIBUTE_NAMESPACES = new globalThis.Set([HTML_NS, SVG_NS, MATHML_NS]);

// A CSS animation (css-animations-2 §3) and a CSS transition (css-transitions-2 §4): made by style, never by a page.
export class CSSAnimation extends Animation {
  constructor(token, id, info) {
    if (token !== ADOPT) throw new globalThis.TypeError('Illegal constructor');
    super(ADOPT, id, info);
    this._animationName = info[3];
  }
  get animationName() { return this._animationName; }
}
export class CSSTransition extends Animation {
  constructor(token, id, info) {
    if (token !== ADOPT) throw new globalThis.TypeError('Illegal constructor');
    super(ADOPT, id, info);
    this._transitionProperty = info[3];
  }
  get transitionProperty() { return this._transitionProperty; }
}
// What style says of one — its play state above all — is applied before a page's call or read takes it, as Gecko
// flushes first. (Onto each prototype itself: IDL makes `Animation.prototype` the next in either's chain.)
for (const ctor of [CSSAnimation, CSSTransition]) {
  for (const name of ['playState', 'pending', 'ready']) {
    const { get } = Object.getOwnPropertyDescriptor(Animation.prototype, name);
    Object.defineProperty(ctor.prototype, name, {
      get() {
        flushStyleEngine();
        return get.call(this);
      },
      configurable: true
    });
  }
  for (const name of ['play', 'pause']) {
    const method = Animation.prototype[name];
    Object.defineProperty(ctor.prototype, name, {
      value() {
        flushStyleEngine();
        return method.call(this);
      },
      writable: true,
      configurable: true
    });
  }
}

// The handle of engine animation `id`, made if the page has none yet — its effect's target `element` where the
// caller has it, else found by `resolve` (a nid to its element).
function handleFor(id, element, resolve) {
  const held = HANDLES.get(id)?.deref();
  if (held) return held;
  const info = engine().animAdopt(id);
  if (!info) return null;
  const target = element || (info[1] >= 0 ? resolve(info[1]) : null);
  const ctor = info[5] === 'transition' ? CSSTransition : CSSAnimation;
  return new ctor(ADOPT, id, [info[0], target || null, info[2], info[3]]);
}

for (const ctor of [AnimationEffect, KeyframeEffect, Animation, CSSAnimation, CSSTransition]) {
  Object.defineProperty(ctor.prototype, globalThis.Symbol.toStringTag, { value: ctor.name, configurable: true });
}

// ── Signals ─────────────────────────────────────────────────────────────────────────────────
// What the engine told the handles to do since the last look: settle a promise (microtasks, at once), queue an
// event for the next rendering update, or run a finish notification at the next microtask checkpoint.
function drain() {
  const signals = engine().animSignals();
  if (!signals || !signals.length) return;
  for (let i = 0; i < signals.length; i += 4) {
    const kind = signals[i], id = signals[i + 1], a = signals[i + 2], b = signals[i + 3];
    const handle = HANDLES.get(id);
    const anim = handle && handle.deref();
    if (!anim) continue;
    switch (kind) {
      case 'ready': anim._settle('_ready', a, false); break;
      case 'readyReject': anim._settle('_ready', a, true); break;
      case 'finished': anim._settle('_finished', a, false); break;
      case 'finishedReject': anim._settle('_finished', a, true); break;
      case 'finish': PENDING_EVENTS.push({ anim, type: 'finish', currentTime: a, timelineTime: b }); break;
      case 'cancel': PENDING_EVENTS.push({ anim, type: 'cancel', currentTime: null, timelineTime: b }); break;
      case 'remove': PENDING_EVENTS.push({ anim, type: 'remove', currentTime: null, timelineTime: b }); break;
      case 'finishNotification':
        if (!NOTIFICATIONS.size) globalThis.queueMicrotask(runNotifications);
        NOTIFICATIONS.set(id, anim);
        break;
    }
  }
}

// The finish notifications queued for the next microtask checkpoint (web-animations §4.4.2) — and run by the
// rendering update before it dispatches, which is the checkpoint "update animations and send events" has there.
const NOTIFICATIONS = new globalThis.Map();
function runNotifications() {
  if (!NOTIFICATIONS.size) return;
  const ids = [...NOTIFICATIONS.keys()];
  NOTIFICATIONS.clear();
  for (const id of ids) engine().animCall(id, 'finishNotification', null, now());
  drain();
}

// The rendering update's half (web-animations §4.2 "update animations and send events"): the engine has moved the
// timeline (`__dom.styleTick`), the microtask checkpoint runs, and then the pending events — the Web Animations'
// playback events and the CSS animation and transition events, `cssEvents`, in ONE queue — are dispatched in the order
// they were scheduled. What that checkpoint queued is due now too (step 4 takes the queue after it: a `finish()` or
// `cancel()` in a `ready` reaction fires before this frame's animation frame callbacks), taken again — the playback
// events by `drain`, the CSS ones by `takeCssEvents`. What a listener queues while they are dispatched is the next
// update's.
export function dispatchEngineAnimationEvents(cssEvents = [], takeCssEvents = null) {
  drain();
  runNotifications();
  // (…and that checkpoint's microtasks — the promises those settled — run before the events are dispatched.)
  const checkpoint = globalThis.__csim_yield;
  if (checkpoint) checkpoint();
  drain();
  runNotifications();
  const later = takeCssEvents ? takeCssEvents() : [];
  // (…and what ran out since the last frame, or was canceled, is no longer held; what nothing holds any more goes.)
  for (const anim of [...KEPT]) reconsider(anim);
  sweep();
  if (!PENDING_EVENTS.length && !cssEvents.length && !later.length) return;
  // The queue in the order it was queued — the tick's CSS events, the playback events, then the CSS events the
  // checkpoint queued — STABLY sorted by scheduled event time (to the microsecond, as the engine sorts its own, so
  // float noise in a time computed two ways cannot split events due together), and those due together by their
  // animations' composite order (§4.2 step 5): CSS transitions, then CSS animations, by owner in tree order, then the
  // rest as they were made — the engine's, for every animation it still has. One it has not — a completed transition
  // nothing holds, gone in the tick that queued its `transitionend` — is placed by the class it had when the event was
  // queued, ahead of the ranked ones of that class. So a script animation's `finish` follows the `transitionend` and
  // `animationend` due with it, as in Chrome, and each animation's `cancel` goes out with its own CSS cancel event —
  // the playback one first, whichever was queued first (a style change cancels in the tick, before the playback event
  // is drained): what the composite order leaves open, the WPT's stated intention and Chrome decide.
  const playback = PENDING_EVENTS.splice(0);
  const due = [
    ...cssEvents,
    ...playback.map((e) => ({
      scheduled: e.timelineTime ?? -Infinity,
      id: e.anim._id,
      kind: e.anim instanceof CSSTransition ? 0 : e.anim instanceof CSSAnimation ? 1 : 2,
      playback: true,
      dispatch: () => dispatchWithOnHandler(e.anim, new AnimationPlaybackEvent(e.type, { currentTime: e.currentTime, timelineTime: e.timelineTime }))
    })),
    ...later
  ];
  if (due.length > 1) {
    const ids = engine().animCompositeOrder([...new globalThis.Set(due.map((e) => e.id))]);
    const rank = new globalThis.Map(ids.map((id, i) => [id, i]));
    const at = (e) => (Number.isFinite(e.scheduled) ? Math.round(e.scheduled * 1000) : e.scheduled);
    for (const e of due) e.order = rank.get(e.id) ?? -1;
    due.sort((x, y) => (at(x) - at(y)) || (x.kind - y.kind) || (x.order - y.order) || ((y.playback ? 1 : 0) - (x.playback ? 1 : 0)));
  }
  // (…each followed by the microtask checkpoint its listeners' "clean up after running script" performs — what a
  // listener's promise resolved runs before the next event, and before this frame's animation frame callbacks.)
  for (const e of due) {
    e.dispatch();
    if (checkpoint) checkpoint();
  }
}

// The handle a CSS animation's event carries — made now if the page has none yet, for the element the event is fired
// at (the animation's owner, the originating element of a pseudo-element's).
export function engineAnimationHandle(id, element) {
  return (id && handleFor(id, element)) || null;
}

// ── What a page asks of an element / the document ───────────────────────────────────────────
// The relevant animations (§5.3), in composite order — the engine's answer, after the style changes pending are
// applied (a CSS animation declared in this task is one). With `subtree`, its pseudo-elements' and its descendants'
// too, whose targets are found as the document's are.
export function engineAnimationsOn(el, subtree) {
  const nid = arenaNid(el);
  if (nid < 0) return [];
  flushStyleEngine();
  const ids = engine().animList(nid, now(), subtree);
  if (!subtree) return ids.map((id) => handleFor(id, el)).filter(Boolean);
  return ids.map((id) => handleFor(id, null, targetFinder(el))).filter(Boolean);
}

export function engineAnimationsIn(doc) {
  if (doc && doc !== globalThis.document) return [];
  flushStyleEngine();
  const ids = engine().animList(-1, now());
  return ids.map((id) => handleFor(id, null, targetFinder(globalThis.document))).filter(Boolean);
}

// The element of a nid under `root` — for the targets of animations the page has no handle for yet, found by one walk
// the first time one is asked for.
function targetFinder(root) {
  let byNid = null;
  return (nid) => {
    if (!byNid) {
      byNid = new globalThis.Map();
      walkInclShadow(root, (node) => { if (node.nodeType === NODE_ELEMENT) byNid.set(node._nid, node); });
    }
    return byNid.get(nid);
  };
}

// ── What the JS side's cascade and layout read (until the layout reads the engine's styles itself) ──
// The properties the animations on `el` itself set, whatever their state — per element until anything could have
// changed them (`generation`).
const PROPERTIES = new globalThis.WeakMap();
function engineAnimatedProperties(el) {
  if (!TARGETED.has(el)) return null;
  const memo = PROPERTIES.get(el);
  if (memo && memo.generation === generation) return memo.props;
  const nid = arenaNid(el);
  const names = nid < 0 ? null : engine().animProperties(nid);
  const props = names && names.length ? new globalThis.Set(names) : null;
  PROPERTIES.set(el, { generation, props });
  return props;
}

// What `prop` is on `el` with its animations applied — the engine's computed value — where one of them is in effect
// on it; null where none is (the cascade stands).
function engineAnimatedValue(el, prop, twin) {
  const props = engineAnimatedProperties(el);
  if (!props || !(props.has(prop) || (twin && props.has(twin)))) return null;
  const inEffect = engine().animActivity(arenaNid(el), twin ? [prop, twin] : [prop], now()) & 2;
  return inEffect ? (styleEngineValue(el, prop) ?? null) : null;
}


// `element.animate(keyframes, options)`: an effect, an animation of it on the document timeline, played.
export function animateWithEngine(el, keyframes, options) {
  const anim = new Animation(new KeyframeEffect(el, keyframes, options), documentTimeline);
  if (options && typeof options === 'object' && options.id != null) anim.id = String(options.id);
  anim.play();
  return anim;
}

// The page's animations are the engine's (in a document realm, `__csimEnableStylo`): these are the constructors a page
// sees, and what `element.animate` / `getAnimations` answer with.
export function installEngineAnimations() {
  globalThis.__csimUpdateStyle = flushStyleEngine;
  // Each an interface object, so a global with the attributes WebIDL gives one: writable and configurable, and NOT
  // enumerable — `for (p in window)` lists none of them. (Installed after the boot pass in bridge.entry.js that gives
  // the others those attributes, so a plain assignment here made all seven enumerable.)
  const interfaces = {
    Animation, AnimationEffect, KeyframeEffect, CSSAnimation, CSSTransition, AnimationTimeline, DocumentTimeline
  };
  for (const [name, value] of Object.entries(interfaces)) {
    Object.defineProperty(globalThis, name, { value, writable: true, enumerable: false, configurable: true });
  }
  useEngineAnimations({
    animate: animateWithEngine, on: engineAnimationsOn, in: engineAnimationsIn,
    value: engineAnimatedValue
  });
}
