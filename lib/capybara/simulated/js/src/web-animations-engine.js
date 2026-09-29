// The Web Animations API as handles on the style engine's model (CSIM_STYLO; ext/csim_native/src/animations.rs).
//
// An `Animation` / `KeyframeEffect` here holds the id the engine knows it by, and everything else — its timing, its
// state, the values it composites into the target's style — is the engine's. What stays on this side is what a
// binding is for: turning the page's arguments into the engine's (the keyframes and timing are processed as
// web-animations.js processes them, the same WebIDL rules), and turning the engine's signals back into the page's
// objects — a promise settled, an event dispatched.
//
// (The JS model in web-animations.js stays the answer while the JS cascade is: the two are the same API over two
// value models, and this one replaces that one when the engine does.)
import { NODE_ELEMENT } from './constants.js';
import { AnimationPlaybackEvent, EventTarget, defineEventHandlers, dispatchWithOnHandler } from './events.js';
import { bumpCascadeVersion, ensureStyleEngine, flushStyleEngine, styleEngineValue } from './cascade.js';
import { markLayoutDirty } from './mutation-observer.js';
import { arenaNid } from './native-query-shadow.js';
import { Animation as ScriptModelAnimation, AnimationEffect as ScriptModelEffect,
         KeyframeEffect as ScriptModelKeyframeEffect, COMPOSITE_OPERATIONS,
         TIMING_DEFAULTS, documentTimeline, effectComposite, idlNameOf, normalizeKeyframes, normalizeTiming,
         useEngineAnimations } from './web-animations.js';

// The realm's style engine, made (fed the document's sheets) if nothing has asked it anything yet.
const engine = () => {
  ensureStyleEngine();
  return globalThis.__dom;
};
// …and the page's clock, which the engine's timeline reads at every question (`animState`, `animCall`, `animTiming`).
const now = () => globalThis.__virtualNow();

// Every animation by the engine's id, for its signals to find — weakly…
const HANDLES = new globalThis.Map();
// …but one that plays (not idle, and not over without a fill) is held: the timeline holds it, so a page that let go
// of its handle still finds it in `getAnimations()`, and its promises and events still reach their listeners.
const KEPT = new globalThis.Set();
// Each element's held animations (whose effect targets it), for what is asked per element — held ones only, so an
// animation let go of by the page and over is not kept alive by its target's entry.
const BY_TARGET = new globalThis.WeakMap();
// …and every effect by its id, as weakly. A handle collected (an animation idle or over, so not kept) lets the engine
// let go of what it held: swept at each rendering update (`sweep`) — a FinalizationRegistry's callbacks never run
// in this runtime.
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
// Composite order among these (§5.4.2): the order they were made in.
let nextSequence = 0;
// Bumped by anything that can change which elements these animate and what: a memo keyed on it (the JS side's
// `scriptAnimationGeneration`) is thrown away then.
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

// What an element shows moved otherwise than with the clock (an animation made, sought, paused, its effect changed):
// the JS side's memos of it — its layout, and (the first time it animates) the declared values the cascade version
// keys — are thrown away, as the JS model's `_invalidate` does, while the JS side lays it out. An element an
// animation LEAVES (canceled, its effect taken away or moved) is cacheable again meanwhile, so the next animation of
// it throws those away once more (`released`).
const KEYED = new globalThis.WeakSet();
function released(target) {
  if (target) KEYED.delete(target);
}
// (…under the target it has now, which it remembers: its effect can be gone by the time it leaves.)
function index(anim) {
  const target = anim._effect && anim._effect._target;
  if (!target || !KEPT.has(anim)) return;
  let set = BY_TARGET.get(target);
  if (!set) BY_TARGET.set(target, set = new globalThis.Set());
  set.add(anim);
  anim._indexedAt = target;
}
function unindex(anim) {
  const target = anim._indexedAt;
  if (!target) return;
  BY_TARGET.get(target)?.delete(anim);
  anim._indexedAt = null;
}
// Whether an animation is held (`KEPT`), as it stands after whatever moved it.
function reconsider(anim) {
  const state = anim._state();
  const plays = state && state[0] !== 'idle' && (state[0] !== 'finished' || (anim._effect && inEffect(anim)));
  if (plays === KEPT.has(anim)) return;
  if (plays) {
    KEPT.add(anim);
    index(anim);
  } else {
    unindex(anim);
    KEPT.delete(anim);
  }
}
const inEffect = (anim) => engine().animTiming(anim._effect._id, now())[1] !== null;

function invalidate(target) {
  if (!target || target.nodeType !== NODE_ELEMENT) return;
  generation++;
  markLayoutDirty(target, true);
  if (KEYED.has(target)) return;
  KEYED.add(target);
  const cached = globalThis.__csimHasCachedDeclaredValues;
  if (!cached || cached(target)) bumpCascadeVersion();
}

function throwFor(error, method) {
  if (!error) return;
  if (error === 'TypeError') throw new globalThis.TypeError(`Failed to execute '${method}' on 'Animation'`);
  throw new globalThis.DOMException(`Failed to execute '${method}' on 'Animation'`, error);
}

// ── Effects ─────────────────────────────────────────────────────────────────────────────────
export class AnimationEffect {
  getTiming() { return Object.assign({}, this._timing); }
  updateTiming(update) {
    if (!update) return;
    const merged = Object.assign({}, this._timing);
    for (const key of Object.keys(TIMING_DEFAULTS)) if (update[key] !== undefined) merged[key] = update[key];
    this._timing = normalizeTiming(merged);
    engine().animEffectSet(this._id, 'timing', timingArgs(this._timing));
    drain();
    invalidate(this._target);
    if (this._animation) reconsider(this._animation);
  }
  getComputedTiming() {
    const [localTime, progress, currentIteration, activeDuration, endTime] = engine().animTiming(this._id, now());
    return Object.assign(this.getTiming(), {
      duration: durationOf(this._timing), activeDuration, endTime, localTime, progress, currentIteration,
      fill: this._timing.fill === 'auto' ? 'none' : this._timing.fill
    });
  }
}

export class KeyframeEffect extends AnimationEffect {
  constructor(target, keyframes, options) {
    super();
    if (arguments.length === 1 && target instanceof KeyframeEffect) {
      // The copy constructor: the same target, keyframes and timing, in an effect of its own.
      const source = target;
      this._target = source._target;
      this._frames = source._frames.map((f) => Object.assign({}, f));
      this._timing = Object.assign({}, source._timing);
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
    this._animation = null;
    this._id = engine().animEffect(targetId(this._target), this._pseudoElement, timingArgs(this._timing),
                                   this._composite, this._iterationComposite, keyframeArgs(this._frames));
    EFFECTS.set(this._id, new globalThis.WeakRef(this));
  }
  get target() { return this._target; }
  set target(v) {
    invalidate(this._target);
    released(this._target);
    if (this._animation) unindex(this._animation);
    this._target = v || null;
    if (this._animation) index(this._animation);
    engine().animEffectSet(this._id, 'target', targetId(this._target), this._pseudoElement);
    drain();
    invalidate(this._target);
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
    invalidate(this._target);
  }
}

// ── Animations ──────────────────────────────────────────────────────────────────────────────
export class Animation extends EventTarget {
  constructor(effect, timeline) {
    super();
    // (A CSS animation's effect is still the JS model's: an animation of it plays a copy the engine knows.)
    if (effect && effect._id === undefined) effect = new KeyframeEffect(effect);
    this._effect = effect || null;
    this._timeline = timeline === undefined ? documentTimeline : timeline;
    this._id = engine().animNew(this._effect ? this._effect._id : 0, this._timeline !== null);
    this._name = '';
    this._sequence = nextSequence++;
    this._ready = null;
    this._finished = null;
    if (this._effect) {
      const previous = this._effect._animation;
      if (previous) {
        unindex(previous);
        previous._effect = null;
      }
      this._effect._animation = this;
      if (previous) reconsider(previous);
    }
    HANDLES.set(this._id, new globalThis.WeakRef(this));

    index(this);
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
    const target = this._effect && this._effect._target;
    invalidate(target);
    if (method === 'cancel') released(target);
    reconsider(this);
    throwFor(error, method);
  }

  get id() { return this._name; }
  set id(v) { this._name = String(v); }
  get effect() { return this._effect; }
  set effect(v) {
    const effect = v || null;
    if (effect === this._effect) return;
    unindex(this);
    if (this._effect) {
      this._effect._animation = null;
      invalidate(this._effect._target);
      released(this._effect._target);
    }
    const previous = effect && effect._animation;
    if (previous) {
      unindex(previous);
      previous._effect = null;
    }
    this._effect = effect;
    if (effect) effect._animation = this;
    index(this);
    this._call('effect', effect ? effect._id : 0);
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
  // stack up to and including it, composited over the target's own values — the engine's to compose. A target with
  // no style attribute of its own (a pseudo-element) is an error, and so is one not rendered.
  commitStyles() {
    const effect = this._effect;
    const target = effect && effect._target;
    if (!target) return;
    if (effect._pseudoElement || !target.style) {
      throw new globalThis.DOMException("Failed to execute 'commitStyles' on 'Animation': the target has no style attribute.", 'NoModificationAllowedError');
    }
    if (!target.isConnected || (globalThis.__isLaidOutNode && !globalThis.__isLaidOutNode(target))) {
      throw new globalThis.DOMException("Failed to execute 'commitStyles' on 'Animation': the target is not rendered.", 'InvalidStateError');
    }
    // (…after the pending style changes are applied: an effect made in this task has its keyframes computed then.)
    flushStyleEngine();
    const values = engine().animCommitValues(this._id, now());
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

// The CSS animations' objects are still the JS model's (css-animation-objects.js) until those animations are the
// engine's too; they are Animations and KeyframeEffects all the same, and `instanceof` says so.
for (const [ctor, model] of [[Animation, ScriptModelAnimation], [AnimationEffect, ScriptModelEffect],
                             [KeyframeEffect, ScriptModelKeyframeEffect]]) {
  Object.defineProperty(ctor, globalThis.Symbol.hasInstance, {
    value(v) { return globalThis.Function.prototype[globalThis.Symbol.hasInstance].call(this, v) || (this === ctor && v instanceof model); },
    configurable: true
  });
}

for (const ctor of [AnimationEffect, KeyframeEffect, Animation]) {
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
// timeline (`__dom.styleTick`), and the events due are dispatched in the order they fell due.
export function dispatchEngineAnimationEvents() {
  drain();
  runNotifications();
  // (…and that checkpoint's microtasks — the promises those settled — run before the events are dispatched.)
  const checkpoint = globalThis.__csim_yield;
  if (checkpoint) checkpoint();
  // (…and what ran out since the last frame, or was canceled, is no longer held; what nothing holds any more goes.)
  for (const anim of [...KEPT]) reconsider(anim);
  sweep();
  if (!PENDING_EVENTS.length) return;
  // (…those due together in composite order, §4.4.19: the order the animations were made in.)
  const due = PENDING_EVENTS.splice(0).sort((x, y) =>
    ((x.timelineTime ?? -Infinity) - (y.timelineTime ?? -Infinity)) || (x.anim._sequence - y.anim._sequence));
  for (const e of due) {
    dispatchWithOnHandler(e.anim, new AnimationPlaybackEvent(e.type, { currentTime: e.currentTime, timelineTime: e.timelineTime }));
  }
}

// ── What a page asks of an element / the document ───────────────────────────────────────────
// The animations it is to be told about (§5.3 "relevant"): current, or in effect — and not idle (every one of which
// is held).
function relevant(anim) {
  const effect = anim._effect;
  if (!effect || anim.playState === 'idle') return false;
  const [, progress, , , , phase] = engine().animTiming(effect._id, now());
  const backwards = anim.playbackRate < 0;
  return progress !== null || phase === 'active' || (phase === 'before' && !backwards) || (phase === 'after' && backwards);
}

// The held animations of `el` (whose effect targets it).
function keptOn(el) {
  const set = BY_TARGET.get(el);
  return set && set.size ? [...set] : [];
}

export function engineAnimationsOn(el) {
  return keptOn(el).filter(relevant).sort((x, y) => x._sequence - y._sequence);
}

export function engineAnimationsIn(doc) {
  return [...KEPT].filter((a) => {
    const target = a._effect && a._effect._target;
    return target && target.nodeType === NODE_ELEMENT && (!doc || target.ownerDocument === doc) && relevant(a);
  }).sort((x, y) => x._sequence - y._sequence);
}

// ── What the JS side's cascade and layout read (until the layout reads the engine's styles itself) ──
// The animations on `el` itself, not idle — what the JS side's `scriptAnimatedProperties` / `…Value` stood for.
function animatingOn(el) {
  return keptOn(el).filter((a) => a._effect && !a._effect._pseudoElement);
}
const propsOf = (anim) => anim._effect._frames.flatMap((f) => Object.keys(f.props));

function engineAnimatedProperties(el) {
  const props = new globalThis.Set();
  for (const anim of animatingOn(el)) for (const prop of propsOf(anim)) props.add(prop);
  return props.size ? props : null;
}

// What `prop` is on `el` with its animations applied — the engine's computed value — where one of them is in effect
// on it; null where none is (the cascade stands).
function engineAnimatedValue(el, prop, twin) {
  const inEffect = animatingOn(el).some((anim) => {
    const props = propsOf(anim);
    return (props.includes(prop) || (twin && props.includes(twin))) && engine().animTiming(anim._effect._id, now())[1] !== null;
  });
  return inEffect ? (styleEngineValue(el, prop) ?? null) : null;
}

function engineCurrentlyAnimates(el, props) {
  return animatingOn(el).some((a) => relevant(a) && propsOf(a).some((p) => props.includes(p)));
}

// `element.animate(keyframes, options)`: an effect, an animation of it on the document timeline, played.
export function animateWithEngine(el, keyframes, options) {
  const anim = new Animation(new KeyframeEffect(el, keyframes, options), documentTimeline);
  if (options && typeof options === 'object' && options.id != null) anim.id = String(options.id);
  anim.play();
  return anim;
}

// The engine takes the page's animations over (CSIM_STYLO): these are the constructors a page sees, and what
// `element.animate` / `getAnimations` answer with.
export function installEngineAnimations() {
  globalThis.Animation = Animation;
  globalThis.AnimationEffect = AnimationEffect;
  globalThis.KeyframeEffect = KeyframeEffect;
  useEngineAnimations({
    animate: animateWithEngine, on: engineAnimationsOn, in: engineAnimationsIn,
    properties: engineAnimatedProperties, value: engineAnimatedValue,
    currentlyAnimates: engineCurrentlyAnimates, generation: () => generation
  });
}
