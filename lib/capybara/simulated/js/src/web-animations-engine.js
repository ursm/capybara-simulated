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
import { NODE_DOC, NODE_ELEMENT, HTML_NS, SVG_NS, MATHML_NS } from './constants.js';
import { AnimationPlaybackEvent, EventTarget, dispatchWithOnHandler, installEventHandlerAttrs } from './events.js';
import {
  installAnimation,
  installAnimationEffect,
  installCSSAnimation,
  installCSSTransition,
  installKeyframeEffect,
  convertAnimationArguments,
  convertKeyframeEffectArguments
} from './generated/bindings.js';
import { IntrinsicPromise, PLATFORM, constructedBy, makeSlots, promiseThen, registerInterface, slotsOf } from './webidl.js';
import { bumpCascadeVersion, ensureStyleEngine, flushStyleEngine, onStyleEngineRetargeted, styleEngineValue } from './cascade.js';
import { markLayoutDirty } from './mutation-observer.js';
import { inlineStyleOf } from './style-proxy.js';
import { arenaNid, nodesByNid } from './native-query-shadow.js';
import {
  AnimationTimeline,
  DocumentTimeline,
  TIMING_DEFAULTS,
  documentTimeline,
  idlNameOf,
  normalizeKeyframes,
  normalizeTiming,
  useEngineAnimations
} from './web-animations.js';

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
// rendering update (`sweep`) — not by a FinalizationRegistry, whose callbacks run only when the browser pumps the message
// loop after a settle, later than the rendering updates that ask.
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

const targetId = (target) => (target && target._nodeType === NODE_ELEMENT ? arenaNid(target) : -1);

// Every element an animation has targeted — a script's effect, or one a style flush reported (a CSS animation's):
// what the JS side's cascade and layout ask of an element never in it is answered without asking the engine, so a
// page with no animations pays a set lookup per element (rule 3).
const TARGETED = new globalThis.WeakSet();
function targeted(target) {
  if (target && target._nodeType === NODE_ELEMENT) TARGETED.add(target);
}

// Whether an animation is held (`KEPT`), as it stands after whatever moved it.
function reconsider(anim) {
  const state = stateOf(anim);
  const effect = animationOf(anim).effect;
  const plays = state && state[0] !== 'idle' && (state[0] !== 'finished' || (effect && inEffect(effect)));
  if (plays) KEPT.add(anim);
  else KEPT.delete(anim);
}
const inEffect = (effect) => engine().animTiming(effectOf(effect).id, now())[1] !== null;

// What an element shows moved otherwise than with the clock (an animation made, sought, paused, its effect changed):
// the JS side lays it out again, and asks again what its animations set.
function invalidate(target) {
  if (!target || target._nodeType !== NODE_ELEMENT) return;
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
    if (!target || target._nodeType !== NODE_ELEMENT) continue;
    invalidate(target);
    const was = ANIMATED_PROPERTIES.get(target);
    const props = engineAnimatedProperties(target);
    if (props) ANIMATED_PROPERTIES.set(target, props);
    else ANIMATED_PROPERTIES.delete(target);
    if (props && [...props].some((p) => (!was || !was.has(p)) && (p.startsWith('--') || REKEYS_THE_CASCADE.has(p)))) bumpCascadeVersion();
  }
}

// The elements whose animations' properties changed — an effect made, let go or moved, new keyframes, a CSS animation
// or transition — as a style flush reports them, those in the document and its shadow trees (the engine's answer).
onStyleEngineRetargeted((nids) => {
  const doc = globalThis.document;
  generation++;
  if (!doc) return;
  const found = [...nodesByNid(doc, globalThis.Float64Array.from(nids)).values()];
  for (const node of found) targeted(node);
  reconcileProperties(found);
});

function throwFor(error, method) {
  if (!error) return;
  if (error === 'TypeError') throw new globalThis.TypeError(`Failed to execute '${method}' on 'Animation'`);
  throw new globalThis.DOMException(`Failed to execute '${method}' on 'Animation'`, error);
}

// ── Effects ─────────────────────────────────────────────────────────────────────────────────
// AnimationEffect and KeyframeEffect (web-animations §6.1, §6.4), generated from their IDL. An effect's slots: the id
// the engine knows it by, its target and pseudo-element, and what the page gave it — its keyframes, timing and
// composite operations, kept here to report as given — and the animation playing it. An effect the engine made (a CSS
// animation's) keeps no timing or keyframes: style keeps them up to date in the engine, and they are read from there.
const effectOf = (o) => slotsOf(o, 'AnimationEffect');
registerInterface('AnimationEffect', (o) => effectOf(o) !== undefined);
registerInterface('KeyframeEffect', (o) => slotsOf(o, 'KeyframeEffect') !== undefined);
export class AnimationEffect {
  constructor(token) {
    constructedBy(PLATFORM, token, 'AnimationEffect');
  }
}
// What an effect's timing is: as the page gave it, or the engine's for one it made.
function timingOf(e) {
  if (e.timing) return Object.assign({}, e.timing);
  const [delay, endDelay, fill, iterationStart, iterations, duration, direction, easing] = engine().animEffectTiming(e.id);
  return { delay, endDelay, fill, iterationStart, iterations, duration, direction, easing };
}
installAnimationEffect(AnimationEffect, {
  getTiming: (effect) => timingOf(effectOf(effect)),
  // (…the members given merged into its timing, which is validated whole)
  updateTiming(effect, update) {
    const e = effectOf(effect);
    const merged = timingOf(e);
    const set = [];
    for (const key of Object.keys(TIMING_DEFAULTS)) {
      if (update[key] === undefined) continue;
      merged[key] = update[key];
      set.push(key);
    }
    e.timing = normalizeTiming(merged);
    engine().animEffectSet(e.id, 'timing', timingArgs(e.timing), set);
    drain();
    invalidate(e.target);
    if (e.animation) reconsider(e.animation);
  },
  getComputedTiming(effect) {
    const e = effectOf(effect);
    const timing = timingOf(e);
    const [localTime, progress, currentIteration, activeDuration, endTime] = engine().animTiming(e.id, now());
    return Object.assign(timing, {
      duration: durationOf(timing), activeDuration, endTime, localTime, progress, currentIteration,
      fill: timing.fill === 'auto' ? 'none' : timing.fill
    });
  }
});

export class KeyframeEffect extends AnimationEffect {
  constructor() {
    super(PLATFORM);
    const e = makeSlots(this, 'AnimationEffect', {
      id: 0,
      target: null,
      pseudoElement: null,
      frames: null,
      timing: null,
      composite: 'replace',
      iterationComposite: 'replace',
      animation: null
    });
    makeSlots(this, 'KeyframeEffect');
    if (arguments[0] === ADOPT) {
      // An effect the engine made: its id, and its target and pseudo-element.
      [, e.id, [e.target, e.pseudoElement]] = arguments;
    } else {
      const [form, ...args] = convertKeyframeEffectArguments(arguments);
      if (form === 'source') {
        // The copy constructor: the same target, keyframes and timing, in an effect of its own.
        const source = effectOf(args[0]);
        e.target = source.target;
        e.frames = source.frames ? source.frames.map((f) => Object.assign({}, f)) : normalizeKeyframes(engineKeyframes(source.id));
        e.timing = timingOf(source);
        e.composite = source.composite;
        e.iterationComposite = source.iterationComposite;
        e.pseudoElement = source.pseudoElement;
      } else {
        const [target, keyframes, options] = args;
        e.target = target;
        e.frames = normalizeKeyframes(keyframes);
        e.timing = normalizeTiming(options);
        if (typeof options === 'object') {
          e.composite = options.composite;
          e.iterationComposite = options.iterationComposite;
          e.pseudoElement = options.pseudoElement;
        }
      }
      e.id = engine().animEffect(targetId(e.target), e.pseudoElement, timingArgs(e.timing), e.composite, e.iterationComposite,
                                 keyframeArgs(e.frames));
    }
    targeted(e.target);
    EFFECTS.set(e.id, new globalThis.WeakRef(this));
  }
}
installKeyframeEffect(KeyframeEffect, {
  get_target: (effect) => effectOf(effect).target,
  set_target(effect, target) {
    const e = effectOf(effect);
    invalidate(e.target);
    e.target = target;
    targeted(target);
    engine().animEffectSet(e.id, 'target', targetId(target), e.pseudoElement);
    drain();
    reconcileProperties([target]);
  },
  get_pseudoElement: (effect) => effectOf(effect).pseudoElement,
  set_pseudoElement(effect, pseudoElement) {
    const e = effectOf(effect);
    e.pseudoElement = pseudoElement;
    engine().animEffectSet(e.id, 'target', targetId(e.target), pseudoElement);
    drain();
    invalidate(e.target);
  },
  get_composite: (effect) => effectOf(effect).composite,
  set_composite(effect, composite) {
    const e = effectOf(effect);
    e.composite = composite;
    engine().animEffectSet(e.id, 'composite', composite);
    invalidate(e.target);
  },
  get_iterationComposite: (effect) => effectOf(effect).iterationComposite,
  set_iterationComposite(effect, iterationComposite) {
    const e = effectOf(effect);
    e.iterationComposite = iterationComposite;
    engine().animEffectSet(e.id, 'iterationComposite', iterationComposite);
    invalidate(e.target);
  },
  getKeyframes(effect) {
    const e = effectOf(effect);
    if (!e.frames) return engineKeyframes(e.id).map((f) => Object.assign(f, { computedOffset: f.offset }));
    return e.frames.map((f) => {
      const out = { offset: f.offset, easing: f.easing || 'linear', composite: f.composite || 'auto' };
      for (const prop of Object.keys(f.declared)) out[idlNameOf(prop)] = f.declared[prop];
      out.computedOffset = f.computedOffset;
      return out;
    });
  },
  setKeyframes(effect, keyframes) {
    const e = effectOf(effect);
    e.frames = normalizeKeyframes(keyframes);
    engine().animEffectSet(e.id, 'keyframes', keyframeArgs(e.frames));
    reconcileProperties([e.target]);
  }
});

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
// Animation (web-animations §4.4), generated from its IDL. An animation's slots: the id the engine knows it by, its
// id string, effect and timeline, the generations of its ready and finished promises the page has asked for, and —
// a CSS animation's or transition's — that style made it, which is applied first (`flushed`).
const animationOf = (o) => slotsOf(o, 'Animation');
registerInterface('Animation', (o) => animationOf(o) !== undefined);
export class Animation extends EventTarget {
  constructor() {
    super();
    const a = makeSlots(this, 'Animation', {
      id: 0,
      name: '',
      effect: null,
      timeline: documentTimeline,
      ready: null,
      finished: null,
      css: false
    });
    if (arguments[0] === ADOPT) {
      // An animation the engine made: its id, and its effect's handle made with it.
      const [, id, [effectId, target, pseudo]] = arguments;
      a.id = id;
      a.css = true;
      a.effect = effectId ? new KeyframeEffect(ADOPT, effectId, [target, pseudo]) : null;
    } else {
      const [effect, timeline] = convertAnimationArguments(arguments);
      a.effect = effect;
      if (timeline !== undefined) a.timeline = timeline;
      a.id = engine().animNew(effect ? effectOf(effect).id : 0, a.timeline !== null);
      const previous = effect && effectOf(effect).animation;
      if (previous) {
        animationOf(previous).effect = null;
        reconsider(previous);
      }
      if (effect) reconcileProperties([effectOf(effect).target]);
    }
    if (a.effect) effectOf(a.effect).animation = this;
    HANDLES.set(a.id, new globalThis.WeakRef(this));
    reconsider(this);
    drain();
  }
}

// What the engine says of an animation: [playState, currentTime, startTime, playbackRate, pending, readyGeneration,
// readySettled, finishedGeneration, finishedSettled, replaceState, finishNotificationQueued]. (A read moves the
// timeline to the page's clock, which can finish the animation: what that queued — a finish notification — is taken
// now, for the next microtask checkpoint.)
function stateOf(anim) {
  const state = engine().animState(animationOf(anim).id, now());
  drain();
  return state;
}
// …and a CSS animation's or transition's, with what style says of it — its play state above all — applied first, as
// Gecko flushes before a page's call or read takes it.
function flushedStateOf(anim) {
  if (animationOf(anim).css) flushStyleEngine();
  return stateOf(anim);
}
// The engine's `method` of an animation, with `arg`: what it moved shown, held or let go — and the error it reports
// thrown.
function call(anim, method, arg) {
  const a = animationOf(anim);
  const error = engine().animCall(a.id, method, arg, now());
  drain();
  globalThis.__csimWakeForAnimations();
  invalidate(a.effect && effectOf(a.effect).target);
  reconsider(anim);
  throwFor(error, method);
}

// The promise of an animation's slot `slot` the engine's generation `state[at]` is: made when the page first asks,
// settled at once if the engine says it is (a rejection is always followed by a new generation, so a settled current
// one is resolved).
function promiseOf(anim, slot, at) {
  const state = flushedStateOf(anim);
  const a = animationOf(anim);
  let entry = a[slot];
  if (!entry || entry.generation !== state[at]) {
    entry = { generation: state[at] };
    entry.promise = new IntrinsicPromise((resolve, reject) => {
      entry.resolve = resolve;
      entry.reject = reject;
    });
    // (A promise nobody waits on still rejects somewhere.)
    promiseThen.call(entry.promise, undefined, () => {});
    if (state[at + 1]) entry.resolve(anim);
    a[slot] = entry;
  }
  return entry.promise;
}
function settle(anim, slot, generation, rejected) {
  const entry = animationOf(anim)[slot];
  if (!entry || entry.generation !== generation) return;
  if (rejected) entry.reject(new globalThis.DOMException('The user aborted a request.', 'AbortError'));
  else entry.resolve(anim);
}

installAnimation(Animation, {
  get_id: (anim) => animationOf(anim).name,
  set_id(anim, id) {
    animationOf(anim).name = id;
  },
  get_effect: (anim) => animationOf(anim).effect,
  set_effect(anim, effect) {
    const a = animationOf(anim);
    if (effect === a.effect) return;
    if (a.effect) {
      const old = effectOf(a.effect);
      old.animation = null;
      invalidate(old.target);
    }
    const previous = effect && effectOf(effect).animation;
    if (previous) animationOf(previous).effect = null;
    a.effect = effect;
    if (effect) effectOf(effect).animation = anim;
    call(anim, 'effect', effect ? effectOf(effect).id : 0);
    if (effect) reconcileProperties([effectOf(effect).target]);
    if (previous) reconsider(previous);
  },
  get_timeline: (anim) => animationOf(anim).timeline,
  // §4.4.1 "setting the timeline of an animation": nothing where it is the same one; the engine's steps otherwise.
  set_timeline(anim, timeline) {
    const a = animationOf(anim);
    if (timeline === a.timeline) return;
    a.timeline = timeline;
    call(anim, 'timeline', timeline === null ? 0 : 1);
  },
  get_playState: (anim) => flushedStateOf(anim)[0],
  get_currentTime: (anim) => stateOf(anim)[1],
  set_currentTime(anim, time) {
    call(anim, 'currentTime', time);
  },
  get_startTime: (anim) => stateOf(anim)[2],
  set_startTime(anim, time) {
    call(anim, 'startTime', time);
  },
  get_playbackRate: (anim) => stateOf(anim)[3],
  set_playbackRate(anim, rate) {
    call(anim, 'playbackRate', rate);
  },
  get_pending: (anim) => flushedStateOf(anim)[4],
  get_replaceState: (anim) => stateOf(anim)[9],
  get_ready: (anim) => promiseOf(anim, 'ready', 5),
  get_finished: (anim) => promiseOf(anim, 'finished', 7),
  // (web-animations-2 §4.4.18: its current time over its effect's end, clamped to [0, 1] — null with no effect or no
  // current time; 0 or 1 by the sign of the time for an effect that ends at once, 0 for one that never does.)
  get_overallProgress(anim) {
    const effect = animationOf(anim).effect;
    const currentTime = stateOf(anim)[1];
    if (!effect || currentTime === null) return null;
    const end = engine().animTiming(effectOf(effect).id, now())[4];
    if (end === 0) return currentTime < 0 ? 0 : 1;
    if (end === Infinity) return 0;
    return Math.min(Math.max(currentTime / end, 0), 1);
  },
  play(anim) {
    if (animationOf(anim).css) flushStyleEngine();
    call(anim, 'play');
  },
  pause(anim) {
    if (animationOf(anim).css) flushStyleEngine();
    call(anim, 'pause');
  },
  finish: (anim) => call(anim, 'finish'),
  cancel: (anim) => call(anim, 'cancel'),
  reverse: (anim) => call(anim, 'reverse'),
  updatePlaybackRate(anim, rate) {
    call(anim, 'updatePlaybackRate', rate);
  },
  persist: (anim) => call(anim, 'persist'),
  // What the animation shows now, written into the target's own inline style (web-animations §4.4.19): its effect
  // stack up to and including it, composited over the target's own values — the engine's to compose. A target that
  // cannot have a style attribute — a pseudo-element, an element of no namespace that defines one (CSS Style
  // Attributes: HTML, SVG, MathML) — is an error, and so is one not rendered.
  commitStyles(anim) {
    const a = animationOf(anim);
    const effect = a.effect && effectOf(a.effect);
    const target = effect && effect.target;
    if (!target) return;
    if (effect.pseudoElement || !STYLE_ATTRIBUTE_NAMESPACES.has(target._ns)) {
      throw new globalThis.DOMException("Failed to execute 'commitStyles' on 'Animation': the target has no style attribute.", 'NoModificationAllowedError');
    }
    if (!target.isConnected || (globalThis.__isLaidOutNode && !globalThis.__isLaidOutNode(target))) {
      throw new globalThis.DOMException("Failed to execute 'commitStyles' on 'Animation': the target is not rendered.", 'InvalidStateError');
    }
    // (…after the pending style changes are applied: an effect made in this task has its keyframes computed then.)
    flushStyleEngine();
    let values = engine().animCommitValues(a.id, now());
    // A transform interpolated as a MATRIX between two mismatched lists is no value a declaration holds until it is
    // resolved against the target's box (csswg-drafts#2854 leaves the committed form open; Chrome commits the matrix),
    // so the engine is asked again with the border box — only then, since asking for a box lays the page out.
    if (values.some((v) => /\b(?:interpolate|accumulate)matrix\(/.test(v))) {
      const box = globalThis.__csimBorderBoxSize && globalThis.__csimBorderBoxSize(target);
      if (box) values = engine().animCommitValues(a.id, now(), box.width, box.height);
    }
    const style = inlineStyleOf(target);
    for (let i = 0; i < values.length; i += 2) style.setProperty(values[i], values[i + 1]);
  },
  installEventHandlers: (proto, names, isSelf) => installEventHandlerAttrs(proto, names, null, isSelf)
});
const STYLE_ATTRIBUTE_NAMESPACES = new globalThis.Set([HTML_NS, SVG_NS, MATHML_NS]);

// A CSS animation (css-animations-2 §3) and a CSS transition (css-transitions-2 §4), generated from their IDL: made by
// style, never by a page — the name style gave each in a slot.
registerInterface('CSSAnimation', (o) => slotsOf(o, 'CSSAnimation') !== undefined);
export class CSSAnimation extends Animation {
  constructor(token, id, info) {
    constructedBy(ADOPT, token, 'CSSAnimation');
    super(ADOPT, id, info);
    makeSlots(this, 'CSSAnimation', { animationName: info[3] });
  }
}
installCSSAnimation(CSSAnimation, { get_animationName: (anim) => slotsOf(anim, 'CSSAnimation').animationName });
registerInterface('CSSTransition', (o) => slotsOf(o, 'CSSTransition') !== undefined);
export class CSSTransition extends Animation {
  constructor(token, id, info) {
    constructedBy(ADOPT, token, 'CSSTransition');
    super(ADOPT, id, info);
    makeSlots(this, 'CSSTransition', { transitionProperty: info[3] });
  }
}
installCSSTransition(CSSTransition, { get_transitionProperty: (anim) => slotsOf(anim, 'CSSTransition').transitionProperty });

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
      case 'ready': settle(anim, 'ready', a, false); break;
      case 'readyReject': settle(anim, 'ready', a, true); break;
      case 'finished': settle(anim, 'finished', a, false); break;
      case 'finishedReject': settle(anim, 'finished', a, true); break;
      case 'finish': PENDING_EVENTS.push({ anim, type: 'finish', currentTime: a, timelineTime: b }); break;
      case 'cancel': PENDING_EVENTS.push({ anim, type: 'cancel', currentTime: null, timelineTime: b }); break;
      case 'remove': PENDING_EVENTS.push({ anim, type: 'remove', currentTime: null, timelineTime: b }); break;
      case 'finishNotification':
        if (!NOTIFICATIONS.size) globalThis.__csimQueueMicrotask(runNotifications);
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
      id: animationOf(e.anim).id,
      kind: slotsOf(e.anim, 'CSSTransition') ? 0 : slotsOf(e.anim, 'CSSAnimation') ? 1 : 2,
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

// …and of a document or a shadow root: the animations whose target is a descendant of it — in its own tree, so a shadow
// tree's are its shadow root's and not the document's.
export function engineAnimationsIn(root) {
  const doc = root._nodeType === NODE_DOC ? root : root.ownerDocument;
  if (doc !== globalThis.document) return [];
  flushStyleEngine();
  const ids = engine().animList(-1, now());
  const find = targetFinder(doc);
  return ids.map((id) => handleFor(id, null, find)).filter((a) => {
    const effect = a && animationOf(a).effect;
    const target = effect && effectOf(effect).target;
    return target && target.getRootNode() === root;
  });
}

// The element of a nid under `root` — for the targets of animations the page has no handle for yet, the engine's answer.
function targetFinder(root) {
  return (nid) => {
    const node = nodesByNid(root, globalThis.Float64Array.of(nid)).get(nid);
    return node && node._nodeType === NODE_ELEMENT ? node : undefined;
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
// (…on the options' timeline where they give one — null too — else the document's; its `id` and its play the
// animation's own, not the members a page may have put on Animation.prototype)
export function animateWithEngine(el, keyframes, options) {
  const dict = typeof options === 'object';
  const timeline = dict && options.timeline !== undefined ? options.timeline : documentTimeline;
  const anim = new Animation(new KeyframeEffect(el, keyframes, options), timeline);
  if (dict) animationOf(anim).name = options.id;
  call(anim, 'play');
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
