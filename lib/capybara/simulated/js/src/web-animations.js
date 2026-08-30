// The Web Animations API — `element.animate()`, `Animation`, `KeyframeEffect`, `getAnimations()`.
//
// This is the same value model CSS animations use (`animation.js`: at the moment a property is
// asked for, the animation's local time says where between its keyframes it is), reached through
// script instead of through a stylesheet. Every motion library drives animation through this
// surface rather than through CSS, and the driver's previous answer was a no-op stub that reported
// `playState: 'finished'` immediately — which is worse than nothing, because a library feature-
// probes `el.animate` and takes the branch that then never moves (see the
// `partial_api_worse_than_missing` note).
//
// The TIMING MODEL is web-animations §4, and its whole content is two numbers:
//
//   * `startTime` — the timeline time at which the animation's own time was zero. Set while the
//     animation is running; unresolved otherwise.
//   * `holdTime` — the animation's own time, held still. Set while it is paused, idle or finished;
//     unresolved while it runs.
//
// Exactly one of them is resolved at any moment, and the current time is read off whichever it is.
// Everything else — play, pause, finish, reverse, seeking by writing `currentTime` — is a rule for
// moving a value between those two slots.
import { NODE_ELEMENT } from './constants.js';
import { animationNow, computedTimingAt, valueAt, onRenderingUpdate } from './animation.js';
import { markLayoutDirty } from './mutation-observer.js';
import { bumpCascadeVersion } from './cascade.js';
import { AnimationPlaybackEvent, EventTarget, defineEventHandlers, dispatchWithOnHandler } from './events.js';
import { CSS_PROPERTY_BY_IDL_ATTRIBUTE, cssPropertyName } from './css-utils.js';
import { LONGHANDS, ANIMATION_TYPES } from './css-property-data.js';
import { shorthandLonghands } from './shorthands.js';

// Every animation that has been created and not yet cancelled, in creation order — the composite
// order `getAnimations()` reports and the later-wins order the cascade applies them in
// (web-animations §5.4.2: two animations with no CSS origin sort by when they were created).
const LIVE = new Set();
let nextSequence = 1;
// The CSS-owned ones are kept apart: they are reported by `getAnimations()` and they fire their own
// events, but the VALUE they represent has already been applied by the cascade layer that created
// them — applying it here as well would compose an animation with itself.
const CSS_OWNED = new Set();
// The CSS object layer's "bring yourself up to date" hook — registered rather than imported, since
// that module imports this one.
//
// `getAnimations()` runs it first, so a transition started in the same task is already one of the
// element's animations — which is what the WPT transitions harness collects the moment it adds a
// class, and then waits on each one's `transitionend`.
let SYNC_CSS = null;
export function onGetAnimationsSync(fn) { SYNC_CSS = fn; }

export function registerCssAnimation(anim) {
  // …and OUT of the scripted set, which every `Animation` joins at construction: a CSS-owned one
  // would otherwise be reported twice and apply its value on top of the cascade's.
  LIVE.delete(anim);
  CSS_OWNED.add(anim);
}
export function forgetCssAnimation(anim) { CSS_OWNED.delete(anim); }

// ── Keyframes ────────────────────────────────────────────────────────────────────────────────
// The two forms a page may write, reduced to one list of `{offset, easing, composite, props}`:
//
//   object form   { blockSize: ['0px', '100px'], easing: 'linear' }
//   array form    [{ blockSize: '0px' }, { blockSize: '100px', easing: 'ease' }]
//
// (web-animations §Processing a keyframes argument. The property names are IDL attributes, so
// `blockSize` is `block-size` and the two renamed ones — `cssOffset`, `cssFloat` — go back to the
// CSS names they had to be renamed away from.)
const RESERVED = new globalThis.Set(['offset', 'easing', 'composite']);

function cssNameOf(idl) {
  if (idl === 'cssOffset') return 'offset';
  if (idl === 'cssFloat')  return 'float';
  return CSS_PROPERTY_BY_IDL_ATTRIBUTE[idl] || cssPropertyName(idl);
}

// A keyframe's declarations, with any SHORTHAND expanded to the longhands it sets — the value model
// interpolates longhands, and `{ margin: ['0px', '10px'] }` has to reach all four of them.
// A keyframe declaration goes into the frame TWICE: expanded to the longhands the value model
// interpolates, and verbatim under the name the page wrote — `getKeyframes()` reports a `margin`
// keyframe as `margin`, not as its four sides.
function putDeclaration(frame, name, value) {
  const prop = cssNameOf(name);
  if (!putLonghands(frame.props, prop, value)) return;
  frame.declared[prop] = String(value);
}
function putLonghands(into, prop, value, depth = 0) {
  if (LONGHANDS.has(prop) || prop.startsWith('--')) {
    // A property that cannot be animated is not a keyframe property at all — it is dropped when
    // the keyframes are processed, so `getKeyframes()` never reports it (web-animations §Processing
    // a keyframes argument; `{ writingMode: 'vertical-rl' }` produces NO keyframes in Chrome, not
    // one that does nothing).
    if (!prop.startsWith('--') && (!ANIMATION_TYPES[prop] || ANIMATION_TYPES[prop] === 'notAnimatable')) return false;
    into[prop] = String(value);
    return true;
  }
  const subs = depth > 3 ? null : shorthandLonghands(prop);
  if (!subs || !subs.length) { into[prop] = String(value); return true; }
  let any = false;
  for (const lh of subs) any = putLonghands(into, lh, value, depth + 1) || any;
  return any;
}

function normalizeKeyframes(input) {
  if (input == null) return [];
  const frames = [];
  const iterable = typeof input[globalThis.Symbol.iterator] === 'function' && typeof input !== 'string';
  if (iterable) {
    for (const raw of input) {
      const frame = newFrame(raw.offset, raw.easing, raw.composite);
      for (const key of Object.keys(raw)) {
        if (RESERVED.has(key)) continue;
        putDeclaration(frame, key, raw[key]);
      }
      frames.push(frame);
    }
    spaceOffsets(frames);
  } else {
    // Object form: each property carries a LIST of values, and each list is spread evenly over the
    // WHOLE animation on its own — three opacities and two flex-grows put the flex-grows at 0 and
    // 1, not at 0 and ½ (web-animations §Processing a keyframes argument, which builds
    // property-indexed keyframes per property and only then merges them by offset).
    const offsets = asList(input.offset), easings = asList(input.easing), composites = asList(input.composite);
    const byOffset = new globalThis.Map();
    const frameAt = (offset, index) => {
      let frame = byOffset.get(offset);
      if (!frame) {
        frame = newFrame(offsets[index] === undefined ? null : Number(offsets[index]),
                         easings.length ? String(easings[index % easings.length]) : null,
                         composites.length ? String(composites[index % composites.length]) : null);
        frame.computedOffset = offset;
        byOffset.set(offset, frame);
      }
      return frame;
    };
    for (const key of Object.keys(input)) {
      if (RESERVED.has(key)) continue;
      const values = Array.isArray(input[key]) ? input[key] : [input[key]];
      // ONE value is a to-keyframe: it animates from whatever the element already has.
      if (values.length === 1) { putDeclaration(frameAt(1, 0), key, values[0]); continue; }
      for (let i = 0; i < values.length; i++) {
        putDeclaration(frameAt(i / (values.length - 1), i), key, values[i]);
      }
    }
    frames.push(...[...byOffset.values()].sort((a, b) => a.computedOffset - b.computedOffset));
    // An explicit `offset` list still overrides the computed positions, in frame order.
    if (offsets.length) {
      frames.forEach((f, i) => { if (offsets[i] !== undefined) f.computedOffset = f.offset = Number(offsets[i]); });
      frames.sort((a, b) => a.computedOffset - b.computedOffset);
    }
  }
  // …and with nothing animatable left anywhere, there are no keyframes.
  return frames.some((f) => Object.keys(f.props).length) ? frames : [];
}

const asList = (v) => (Array.isArray(v) ? v : (v == null ? [] : [v]));
function newFrame(offset, easing, composite) {
  return { offset: offset == null ? null : Number(offset),
           easing: easing == null ? null : String(easing),
           composite: composite == null ? null : String(composite),
           props: Object.create(null),      // expanded to longhands: what the value model reads
           declared: Object.create(null) }; // as the page wrote them: what `getKeyframes` reports
}

// Missing offsets are spaced evenly between the ones that are given (web-animations §Computing
// missing keyframe offsets); with none at all, the first is 0 and the last is 1.
function spaceOffsets(frames) {
  if (!frames.length) return frames;
  if (frames.length === 1) { frames[0].computedOffset = frames[0].offset == null ? 1 : frames[0].offset; return frames; }
  if (frames[0].offset == null) frames[0].computedOffset = 0; else frames[0].computedOffset = frames[0].offset;
  const last = frames.length - 1;
  frames[last].computedOffset = frames[last].offset == null ? 1 : frames[last].offset;
  let anchor = 0;
  for (let i = 1; i <= last; i++) {
    if (frames[i].offset == null && i !== last) continue;
    if (frames[i].computedOffset === undefined) frames[i].computedOffset = frames[i].offset;
    const span = i - anchor;
    for (let j = anchor + 1; j < i; j++) {
      frames[j].computedOffset = frames[anchor].computedOffset +
        (frames[i].computedOffset - frames[anchor].computedOffset) * ((j - anchor) / span);
    }
    anchor = i;
  }
  return frames;
}

// ── Timing ───────────────────────────────────────────────────────────────────────────────────
const TIMING_DEFAULTS = {
  delay: 0, endDelay: 0, fill: 'auto', iterationStart: 0, iterations: 1,
  duration: 'auto', direction: 'normal', easing: 'linear'
};

function normalizeTiming(options) {
  const t = Object.assign({}, TIMING_DEFAULTS);
  if (typeof options === 'number') { t.duration = options; return t; }
  if (options && typeof options === 'object') {
    for (const key of Object.keys(TIMING_DEFAULTS)) if (options[key] !== undefined) t[key] = options[key];
  }
  return t;
}

// A `duration: 'auto'` is zero here, as it is for an effect with no intrinsic length of its own.
const timingRecord = (t) => Object.assign({}, t, {
  duration: typeof t.duration === 'number' && Number.isFinite(t.duration) ? Math.max(0, t.duration) : 0
});

// ── KeyframeEffect ───────────────────────────────────────────────────────────────────────────
// `AnimationEffect` is the base every effect type shares — the timing half of the interface, which
// is all a page can ask of an effect it did not construct itself.
export class AnimationEffect {
  getTiming() { return Object.assign({}, this._timing); }
  updateTiming(update) {
    if (update) for (const key of Object.keys(TIMING_DEFAULTS)) {
      if (update[key] !== undefined) this._timing[key] = update[key];
    }
  }
}

export class KeyframeEffect extends AnimationEffect {
  constructor(target, keyframes, options) {
    super();
    this._target = target || null;
    this._frames = normalizeKeyframes(keyframes);
    this._timing = normalizeTiming(options);
    this._composite = (options && options.composite) || 'replace';
    // An effect may target a PSEUDO-ELEMENT of its target, and then it is not the element that
    // animates: `el.animate(…, {pseudoElement: '::before'})` leaves `el` itself alone, and `el`
    // does not list the animation. Without this the effect landed on the element — so a page
    // fading its `::before` faded the element, and Capybara stopped seeing it.
    this._pseudoElement = (options && options.pseudoElement != null) ? String(options.pseudoElement) : null;
  }
  get target() { return this._target; }
  set target(v) { this._target = v || null; }
  get pseudoElement() { return this._pseudoElement; }
  set pseudoElement(v) { this._pseudoElement = v == null ? null : String(v); }
  get composite() { return this._composite; }
  set composite(v) { this._composite = String(v); }
  getKeyframes() {
    return this._frames.map((f) => {
      const out = { offset: f.offset, computedOffset: f.computedOffset,
                    // A keyframe with no easing of its own reports `linear` — the effect's easing
                    // is the effect's, not the keyframe's (Chrome-measured).
                    easing: f.easing || 'linear', composite: f.composite || 'auto' };
      // Reported under the IDL names the page wrote them with — a keyframe is a dictionary, not a
      // declaration block, and a shorthand stays the shorthand it was written as.
      for (const prop of Object.keys(f.declared)) out[idlNameOf(prop)] = f.declared[prop];
      return out;
    });
  }
  setKeyframes(keyframes) { this._frames = normalizeKeyframes(keyframes); }
  getComputedTiming() {
    const anim = this._animation;
    const local = anim ? anim._currentTime() : null;
    const c = computedTimingAt(timingRecord(this._timing), local);
    return Object.assign(this.getTiming(), {
      duration: c.duration, activeDuration: c.activeDuration, endTime: c.endTime,
      localTime: c.localTime, progress: c.progress, currentIteration: c.currentIteration,
      fill: this._timing.fill === 'auto' ? 'none' : this._timing.fill
    });
  }
}

const IDL_BY_CSS = new globalThis.Map();
for (const idl of Object.keys(CSS_PROPERTY_BY_IDL_ATTRIBUTE)) {
  if (!IDL_BY_CSS.has(CSS_PROPERTY_BY_IDL_ATTRIBUTE[idl])) IDL_BY_CSS.set(CSS_PROPERTY_BY_IDL_ATTRIBUTE[idl], idl);
}
function idlNameOf(prop) { return IDL_BY_CSS.get(prop) || prop; }

// ── Animation ────────────────────────────────────────────────────────────────────────────────
// The document timeline's current time is the driver's own clock — the same one CSS animations
// advance on, so an `element.animate()` and an `@keyframes` on the same page stay in step.
export class AnimationTimeline {
  get currentTime() { return animationNow(); }
}
export class DocumentTimeline extends AnimationTimeline {}
export const documentTimeline = new DocumentTimeline();

export class Animation extends EventTarget {
  constructor(effect, timeline) {
    super();
    this._effect = effect || null;
    if (effect) effect._animation = this;
    this._timeline = timeline === undefined ? documentTimeline : timeline;
    this._startTime = null;      // resolved while running
    this._holdTime = null;       // resolved while paused / idle / finished
    this._playbackRate = 1;
    this._idle = true;
    this._paused = false;
    this._sequence = nextSequence++;
    this._id = '';
    this._finished = null;
    this._finishedResolve = null;
    LIVE.add(this);
  }
  get id() { return this._id; }
  set id(v) { this._id = String(v); }
  get effect() { return this._effect; }
  set effect(v) { this._effect = v || null; if (v) v._animation = this; }
  get timeline() { return this._timeline; }
  get playbackRate() { return this._playbackRate; }
  set playbackRate(v) {
    const cur = this._currentTime();
    this._playbackRate = Number(v) || 0;
    if (cur != null) this.currentTime = cur;      // seeking keeps the animation where it is
    // A rate of ZERO holds the animation still, which is a hold time rather than a start time
    // (Chrome reports a null `startTime` for one).
    if (this._playbackRate === 0 && this._startTime != null) {
      this._holdTime = cur == null ? 0 : cur;
      this._startTime = null;
    }
  }

  // The animation's own time: held where it was, or read off the timeline against the start time.
  _currentTime() {
    if (this._holdTime != null) return this._holdTime;
    if (this._startTime == null || !this._timeline) return null;
    return (this._timeline.currentTime - this._startTime) * this._playbackRate;
  }
  get currentTime() { return this._currentTime(); }
  set currentTime(v) {
    const t = v == null ? null : Number(v);
    if (t == null) { this._holdTime = null; this._startTime = null; this._invalidate(); return; }
    this._idle = false;
    if (this._paused || this._startTime == null || this._playbackRate === 0) this._holdTime = t;
    else this._startTime = this._timeline.currentTime - t / this._playbackRate;
    this._settleFinished();
    this._invalidate();
  }
  get startTime() { return this._startTime; }
  set startTime(v) {
    this._startTime = v == null ? null : Number(v);
    if (this._startTime != null) { this._holdTime = null; this._idle = false; this._paused = false; }
    this._settleFinished();
    this._invalidate();
  }

  // A state change is a STYLE change, and it has to reach BOTH memos: the layout ones, which key on
  // the mutation sequence, and the declared-value ones, which key on the cascade version. Neither
  // moves when an animation is created or seeked — so without this, an element whose height was
  // read before it was animated kept reporting the value from before (measured: 0px where Chrome
  // says 50px, but only on a page where something had already read it).
  _invalidate() {
    const target = this._effect && this._effect._target;
    if (target) markLayoutDirty(target, true);
    // The document-wide cascade re-key is paid ONCE per animation, not per seek: what it exists for
    // is the moment an element STARTS being animated, when a value read of it before then is still
    // in the declared-value memo. From then on every read of that element is already uncacheable
    // (`animatedOver` says so), so re-keying again buys nothing — and measured, doing it per seek
    // cost 33x on a page driving an animation from a frame loop (100.6 ms/frame against 3.0).
    if (!this._keyed) { this._keyed = true; bumpCascadeVersion(); }
  }

  get playState() {
    if (this._idle) return 'idle';
    const t = this._currentTime();
    if (this._paused) return 'paused';
    if (t == null) return 'idle';
    if (this._playbackRate > 0 && t >= this._endTime()) return 'finished';
    if (this._playbackRate < 0 && t <= 0) return 'finished';
    return 'running';
  }
  get pending() { return false; }   // nothing here waits for a frame to start or stop
  get replaceState() { return 'active'; }

  _endTime() { return this._effect ? computedTimingAt(timingRecord(this._effect._timing), 0).endTime : 0; }

  play() {
    // A CANCELLED animation is playable again — `cancel(); play()` is how a page restarts one — so
    // it rejoins the live set it was taken out of.
    LIVE.add(this);
    // …and it gets a NEW `finished`: the old one has already settled, and resolving off it would
    // make `anim.play(); await anim.finished` return at once (web-animations §"play an animation").
    if (this._finishedSettled) { this._finished = null; this._finishedSettled = false; }
    this._firedFinish = false;
    const end = this._endTime();
    let t = this._currentTime();
    if (t == null) t = this._playbackRate >= 0 ? 0 : end;
    // Replaying a finished animation starts it over, which is what makes a click handler that
    // calls `play()` twice animate twice.
    else if (this._playbackRate >= 0 && t >= end) t = 0;
    else if (this._playbackRate < 0 && t <= 0) t = end;
    this._idle = false;
    this._paused = false;
    this._holdTime = null;
    this._startTime = this._timeline ? this._timeline.currentTime - t / (this._playbackRate || 1) : null;
    this._settleFinished();
    this._invalidate();
  }
  pause() {
    const t = this._currentTime();
    this._paused = true;
    this._idle = false;
    this._holdTime = t == null ? (this._playbackRate >= 0 ? 0 : this._endTime()) : t;
    this._startTime = null;
    this._invalidate();
  }
  finish() {
    // …which also un-pauses it: `finish()` RESOLVES the start time (web-animations §"finish an
    // animation"), and a resolved start time is what distinguishes a finished animation from a
    // paused one.
    const t = this._playbackRate >= 0 ? this._endTime() : 0;
    this._idle = false;
    this._paused = false;
    this._holdTime = null;
    this._startTime = this._timeline ? this._timeline.currentTime - t / (this._playbackRate || 1) : null;
    if (this._startTime == null) this._holdTime = t;
    this._settleFinished();
    this._invalidate();
  }
  cancel() {
    const wasActive = !this._idle;
    this._idle = true;
    this._paused = false;
    this._holdTime = null;
    this._startTime = null;
    LIVE.delete(this);
    this._invalidate();
    // An animation that is cancelled REJECTS its `finished` promise with an AbortError, which is
    // what a `try { await anim.finished } catch {}` around a cancel is written for.
    if (this._finishedReject) {
      const reject = this._finishedReject;
      this._finishedReject = null;
      this._finishedResolve = null;
      this._finishedSettled = true;
      reject(new globalThis.DOMException('The user aborted a request.', 'AbortError'));
    }
    if (wasActive) this._fire('cancel');
  }
  reverse() { this.playbackRate = -this._playbackRate; this.play(); }
  updatePlaybackRate(rate) { this.playbackRate = rate; }
  persist() {}
  // Write what the animation is currently showing into the element's own inline style — the
  // standard way to keep an end state without `fill: forwards`, and the reason a page can cancel
  // an animation without the element jumping back.
  commitStyles() {
    const effect = this._effect;
    const target = effect && effect._target;
    if (!target || effect._pseudoElement) return;
    const computed = globalThis.getComputedStyle(target);
    const props = new globalThis.Set();
    for (const frame of effect._frames) for (const prop of Object.keys(frame.props)) props.add(prop);
    for (const prop of props) {
      const value = computed.getPropertyValue(prop);
      if (value !== '' && value != null) target.style.setProperty(prop, value);
    }
  }

  get finished() {
    if (!this._finished) {
      this._finished = new globalThis.Promise((resolve, reject) => {
        this._finishedResolve = resolve;
        this._finishedReject = reject;
      });
      // A promise nobody is waiting on still has to reject somewhere, or the rejection is
      // unhandled the moment it is created.
      this._finished.catch(() => {});
      if (this.playState === 'finished') this._settleFinished();
    }
    return this._finished;
  }
  get ready() { return globalThis.Promise.resolve(this); }

  // Called both by the methods that can finish an animation and by the RENDERING UPDATE, because
  // the commonest way to finish is neither: the clock simply carries the animation past its end.
  // Without the second caller `await anim.finished` — how every motion library waits — never
  // resolved at all, while `playState` said `finished`.
  _settleFinished() {
    if (this.playState !== 'finished') return;
    if (this._finishedResolve) {
      const resolve = this._finishedResolve;
      this._finishedResolve = null;
      this._finishedReject = null;
      this._finishedSettled = true;
      resolve(this);
    }
    if (!this._firedFinish) {
      this._firedFinish = true;
      // The event is a QUEUED TASK where the promise is a microtask, so a `finished.then` runs
      // before an `onfinish` listener — which is the order a page written with both observes.
      const ev = new AnimationPlaybackEvent('finish', {
        currentTime: this._currentTime(), timelineTime: this._timeline ? this._timeline.currentTime : null
      });
      globalThis.setTimeout(() => this._fire('finish', ev), 0);
    }
  }
  // An Animation IS an EventTarget (web-animations IDL), so `addEventListener` / `dispatchEvent` /
  // the `on*` handler slots are the platform's own rather than a private list beside them.
  _fire(type, ev) {
    dispatchWithOnHandler(this, ev || new AnimationPlaybackEvent(type, {
      currentTime: this._currentTime(), timelineTime: this._timeline ? this._timeline.currentTime : null
    }));
  }
}
defineEventHandlers(Animation.prototype, ['finish', 'cancel', 'remove']);

// ── The value these contribute ───────────────────────────────────────────────────────────────
// Which animations are in effect on an element, in composite order (creation order).
// Which animations `getAnimations()` reports for an element, in composite order: CSS transitions
// first, then CSS animations, then everything script created (web-animations §5.4.2).
export function reportedAnimationsOn(el) {
  const out = [];
  const css = el._csimCssAnims;
  if (css) for (const anim of css.values()) if (!anim._idle && anim._cssRelevant !== false) out.push(anim);
  out.sort((a, b) => rank(a) - rank(b) || a._sequence - b._sequence);
  const scripted = animationsOn(el);
  return scripted ? out.concat(scripted) : out;
}
function rank(anim) { return anim._cssName == null ? 2 : (anim.transitionProperty !== undefined ? 0 : 1); }

function animationsOn(el) {
  if (!LIVE.size) return null;
  let out = null;
  for (const anim of LIVE) {
    const effect = anim._effect;
    if (!effect || effect._target !== el || effect._pseudoElement) continue;
    if (anim._idle) continue;
    // An animation on a DETACHED element is not one the page can observe: Chrome reports none for
    // an element that has been removed from the document.
    if (el.isConnected === false) continue;
    (out || (out = [])).push(anim);
  }
  if (out) out.sort((a, b) => a._sequence - b._sequence);
  return out;
}

// Every property any animation on `el` touches, or `null` — the gate that keeps an element with no
// script-driven animation from asking anything (rule 3: `LIVE.size` answers for the whole document
// first, and a page that never calls `animate()` never gets past it).
export function scriptAnimatedProperties(el) {
  const anims = animationsOn(el);
  if (!anims) return null;
  const props = new globalThis.Set();
  for (const anim of anims) for (const frame of anim._effect._frames) {
    for (const prop of Object.keys(frame.props)) props.add(prop);
  }
  return props.size ? props : null;
}

// …and what they report for one property right now. Later animations override earlier ones on a
// property they share, which is the composite order `animationsOn` sorted them into.
export function scriptAnimatedValue(el, prop, twin, underlying, resolve) {
  const anims = animationsOn(el);
  if (!anims) return null;
  let value = null;
  for (const anim of anims) {
    const effect = anim._effect;
    const timing = computedTimingAt(timingRecord(effect._timing), anim._currentTime());
    if (timing.progress == null) continue;                 // not in effect: the cascade stands
    const stops = [];
    for (const frame of effect._frames) {
      const has = frame.props[prop] !== undefined ? prop : (twin && frame.props[twin] !== undefined ? twin : null);
      if (!has) continue;
      stops.push({ offset: frame.computedOffset, value: frame.props[has], easing: frame.easing,
                   // The keyframe's own composite, or the effect's where it names none.
                   composite: frame.composite || effect._composite });
    }
    if (!stops.length) continue;
    stops.sort((a, b) => a.offset - b.offset);
    const under = value == null ? underlying : value;
    // `composite: 'add'` ADDS what a keyframe declares to the value underneath rather than
    // replacing it (web-animations §Compositing) — `flex-grow: 5` under keyframes 1 → 3 is 7 half
    // way, not 2. It is applied to each KEYFRAME on the way in, inside `valueAt`.
    value = valueAt(el, prop, stops, timing.progress, under, resolve);
  }
  return value;
}

// The rendering update's half of the timing model: an animation the CLOCK has carried past its end
// settles then, which is when a browser queues its `finish` event too.
export function settleFinishedAnimations() {
  for (const anim of LIVE) anim._settleFinished();
}
onRenderingUpdate(settleFinishedAnimations);

// `element.getAnimations()` — this element's, in composite order. The CSS-driven animations are not
// listed yet: they have no `Animation` object of their own here, and inventing one that isn't the
// same object across two calls would be worse than the honest omission.
export function animationsForElement(el) { if (SYNC_CSS) SYNC_CSS(); return reportedAnimationsOn(el); }

// `document.getAnimations()` — every animation whose target is in this document.
export function animationsForDocument(doc) {
  if (SYNC_CSS) SYNC_CSS();
  const out = [];
  // The CSS-driven ones first — they live on their elements rather than in the live set.
  for (const anim of CSS_OWNED) {
    const target = anim._effect && anim._effect._target;
    if (!target || anim._idle || anim._cssRelevant === false || target.nodeType !== NODE_ELEMENT) continue;
    if (doc && target.ownerDocument !== doc) continue;
    out.push(anim);
  }
  out.sort((a, b) => rank(a) - rank(b) || a._sequence - b._sequence);
  const scripted = [];
  for (const anim of LIVE) {
    const effect = anim._effect;
    if (!effect || !effect._target || anim._idle) continue;
    if (effect._target.nodeType !== NODE_ELEMENT) continue;
    if (doc && effect._target.ownerDocument !== doc) continue;
    scripted.push(anim);
  }
  scripted.sort((a, b) => a._sequence - b._sequence);
  return out.concat(scripted);
}

// `element.animate(keyframes, options)`: create the effect, associate an animation, and play it.
export function animateElement(el, keyframes, options) {
  const effect = new KeyframeEffect(el, keyframes, options);
  const anim = new Animation(effect, documentTimeline);
  anim._invalidate();                              // the element is animated now; what was read of it isn't
  if (options && typeof options === 'object' && options.id != null) anim.id = String(options.id);
  anim.play();
  return anim;
}
