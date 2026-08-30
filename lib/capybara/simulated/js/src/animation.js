// CSS Animations and Transitions: the value a property reports while one is running on it.
//
// An animation is not a thing that happens over time here so much as a FUNCTION of the clock: at
// the moment a value is asked for, the animation's local time says where between its keyframes it
// is, and the property reports whatever is there (css-animations §4, web-animations §4 timing
// model). Nothing has to be pushed at each frame — a `getComputedStyle` read, a layout pass and a
// paint all ask the same question and get the same answer, which is what keeps one geometry.
//
// The cascade layers these sit in are fixed by CSS Cascade §6.1: an animation OVERRIDES normal
// declarations of any origin and loses to `!important` ones, and a TRANSITION overrides everything,
// important declarations included. `style-proxy` applies both there.
//
// WHAT THIS MODEL DOES NOT DO YET — each a bounded, deliberate gap rather than an oversight:
//
//   * `transform`, `filter`, `box-shadow` and the other list-valued types interpolate DISCRETELY
//     (`interpolate.js` implements number / integer / length / length-percentage / colour). A
//     discrete flip is what the spec says an uninterpolable pair does, so the answer is coarse
//     rather than wrong — but `transform` is the most animated property on the web and is the
//     first thing to add.
//   * A transition is started by a change in the element's OWN declared value. A change to an
//     INHERITED one — a theme switch that moves `color` on `<html>` — is resolved above this
//     layer, in the computed-value reader, so it starts nothing (Chrome interpolates).
//   * The before-change style is what the element actually REPORTED at the last style change
//     event, not every property a browser would have snapshotted. A property nobody read cannot
//     be seen transitioning — the safe direction for a driver, and pinned as such.
//   * `animation-play-state` is parsed and ignored: a paused animation keeps running.
import { keyframesNamed, documentHasKeyframes } from './cascade.js';
import { interpolateProperty, discreteValue, numericValue, addValues } from './interpolate.js';
import { ANIMATION_TYPES } from './css-property-data.js';
import { shorthandLonghands } from './shorthands.js';
import { splitTopLevel } from './css-utils.js';
import { lastMutationAt, markLayoutDirty } from './mutation-observer.js';

// ── The clock ────────────────────────────────────────────────────────────────────────────────
// The timeline is the driver's OWN clock — the virtual one the event loop advances a step at a
// time and hands to `requestAnimationFrame` — never the wall clock. Two reasons, and both are
// requirements rather than preferences:
//
//   * it is FROZEN within a task, which is what a browser's timeline is (web-animations §4.2), so
//     every value sampled while one script runs is sampled at one moment. Reading the wall clock
//     per value made `padding-inline-start` and `padding-left` — the same value under two names —
//     disagree by however many milliseconds separated the two reads;
//   * it is DETERMINISTIC. An animation timed against wall time makes geometry depend on how long
//     the Ruby side happened to take between steps, which is the flake the driver's whole
//     fixed-step clock model exists to prevent.
//
// So a CSS animation advances in lockstep with `setTimeout` and rAF, which is exactly the relation
// a page's own frame loop assumes.
export function animationNow() {
  return globalThis.__virtualNow ? globalThis.__virtualNow() : 0;
}

// ── The rendering update ─────────────────────────────────────────────────────────────────────
// Elements that reported an animated value since the last one. A browser recomputes style AND
// LAYOUT for an animated element every frame; this driver's layout memos key on the MUTATION
// sequence, which the clock moving does not touch — so an animated box would keep the geometry it
// had when something last mutated. Naming the elements here, and dirtying them at the rendering
// update, is what makes an animated box follow its animation.
const ANIMATED = new globalThis.Set();
export function noteAnimatedElement(el) { ANIMATED.add(el); }
// Every element the model has seen running an animation or a transition — which is what the object
// layer (`css-animation-objects.js`) reconciles its `CSSAnimation` / `CSSTransition` objects and
// their events against. Kept separately from `ANIMATED` because that one is cleared every frame:
// this is the standing population, and an element leaves it when nothing on it is running.
const RUNNING = new globalThis.Set();
export function noteRunningElement(el) { RUNNING.add(el); }
export function runningElements() { return RUNNING; }
export function forgetRunningElement(el) { RUNNING.delete(el); }
// …and the Web Animations half of the update, registered rather than imported: `web-animations.js`
// imports THIS module for the timing model, so the edge has to run the other way as a hook.
let SETTLE_FINISHED = null;
export function onRenderingUpdate(fn) { SETTLE_FINISHED = fn; }
// …and the CSS object layer's, which mirrors what this model is running into `CSSAnimation` /
// `CSSTransition` objects and fires their events. Registered rather than imported: that module
// imports THIS one, so the edge has to run the other way.
let RECONCILE_CSS = null;
export function onCssObjects(fn) { RECONCILE_CSS = fn; }
export function flushAnimationFrame() {
  // The clock has moved, so an animation may have run to its end since the last update — which is
  // the commonest way one finishes, and neither `finish()` nor a seek is involved in it.
  if (SETTLE_FINISHED) SETTLE_FINISHED();
  if (RECONCILE_CSS) RECONCILE_CSS();
  if (!ANIMATED.size) return;
  const els = [...ANIMATED];
  ANIMATED.clear();
  for (const el of els) markLayoutDirty(el, true);
}

// ── Easing ───────────────────────────────────────────────────────────────────────────────────
// A timing function maps linear progress to eased progress. The keywords are the cubic béziers
// css-easing §2 names them; `steps()` quantises instead.
const BEZIER_KEYWORDS = {
  __proto__: null,
  'linear':      null,
  'ease':        [0.25, 0.1, 0.25, 1],
  'ease-in':     [0.42, 0, 1, 1],
  'ease-out':    [0, 0, 0.58, 1],
  'ease-in-out': [0.42, 0, 0.58, 1]
};

// The x→y solve for a cubic bézier with its endpoints pinned at (0,0) and (1,1): Newton first (it
// converges in a couple of steps over almost the whole curve), bisection where the derivative is
// too flat for it. Same shape every engine uses.
function bezierEasing(p1x, p1y, p2x, p2y) {
  const cx = 3 * p1x, bx = 3 * (p2x - p1x) - cx, ax = 1 - cx - bx;
  const cy = 3 * p1y, by = 3 * (p2y - p1y) - cy, ay = 1 - cy - by;
  const sampleX = (t) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t) => ((ay * t + by) * t + cy) * t;
  const slopeX  = (t) => (3 * ax * t + 2 * bx) * t + cx;
  return (x) => {
    // Outside [0,1] the curve is EXTENDED along its end tangents, which is how an overshooting
    // seek (progress -0.3, 1.5) stays continuous instead of snapping to an endpoint.
    if (x < 0) return cx === 0 ? 0 : (cy / cx) * x;
    if (x > 1) {
      const endSlope = slopeX(1);
      return endSlope === 0 ? 1 : 1 + ((3 * ay + 2 * by + cy) / endSlope) * (x - 1);
    }
    let t = x;
    for (let i = 0; i < 8; i++) {
      const d = slopeX(t);
      if (Math.abs(d) < 1e-6) break;
      const err = sampleX(t) - x;
      if (Math.abs(err) < 1e-7) return sampleY(t);
      t -= err / d;
    }
    let lo = 0, hi = 1;
    t = x;
    for (let i = 0; i < 30; i++) {
      const v = sampleX(t);
      if (Math.abs(v - x) < 1e-7) break;
      if (v > x) hi = t; else lo = t;
      t = (lo + hi) / 2;
    }
    return sampleY(t);
  };
}

function stepsEasing(count, position) {
  const jumpStart = position === 'start' || position === 'jump-start' || position === 'jump-both';
  const jumpNone  = position === 'jump-none';
  const jumpBoth  = position === 'jump-both';
  const divisor = jumpNone ? count - 1 : jumpBoth ? count + 1 : count;
  return (x) => {
    let step = Math.floor(x * count) + (jumpStart ? 1 : 0);
    // The step BOUNDARY belongs to the step below it when progress is coming from before the
    // interval, which is what makes `steps(1, start)` report the end value at every t > 0.
    if (x >= 0 && step < 0) step = 0;
    if (x <= 1 && step > count) step = count;
    if (divisor <= 0) return 0;
    return step / divisor;
  };
}

// One timing-function value → a function. An unparseable one is linear, as an invalid declaration
// would have been dropped before reaching here anyway.
export function easingFunction(text) {
  const v = String(text == null ? 'linear' : text).trim().toLowerCase();
  if (v === 'step-start') return stepsEasing(1, 'start');
  if (v === 'step-end')   return stepsEasing(1, 'end');
  if (v in BEZIER_KEYWORDS) {
    const b = BEZIER_KEYWORDS[v];
    return b ? bezierEasing(b[0], b[1], b[2], b[3]) : ((x) => x);
  }
  let m = /^cubic-bezier\(([^)]*)\)$/.exec(v);
  if (m) {
    const n = m[1].split(',').map((s) => parseFloat(s));
    if (n.length === 4 && n.every((x) => Number.isFinite(x))) return bezierEasing(n[0], n[1], n[2], n[3]);
    return (x) => x;
  }
  m = /^steps\(([^)]*)\)$/.exec(v);
  if (m) {
    const parts = m[1].split(',').map((s) => s.trim());
    const count = parseInt(parts[0], 10);
    if (Number.isFinite(count) && count > 0) return stepsEasing(count, (parts[1] || 'end').toLowerCase());
  }
  return (x) => x;
}

// ── The animation list ───────────────────────────────────────────────────────────────────────
// `animation-*` are COORDINATED LISTS: `animation-name` decides how many animations there are and
// every other property cycles to fill (css-animations §4.6 — two names and one duration means both
// animations take that duration).
function listOf(text) {
  const s = String(text == null ? '' : text).trim();
  return s ? splitTopLevel(s, ',').map((part) => part.trim()) : [];
}
const cycle = (list, i, fallback) => (list.length ? list[i % list.length] : fallback);

// A `<time>` in milliseconds. Both units are exact, so a duration never drifts from the number the
// page wrote.
function timeMs(text, fallback) {
  const v = numericValue(text);
  if (!v) return fallback;
  if (v.unit === 's')  return v.n * 1000;
  if (v.unit === 'ms') return v.n;
  return fallback;
}

function iterationCount(text) {
  const s = String(text == null ? '' : text).trim().toLowerCase();
  if (s === 'infinite') return Infinity;
  const v = numericValue(s);
  return v && !v.unit && v.n >= 0 ? v.n : 1;
}

// The animations running on `el`, as timing records. `read` is the caller's declared-value reader —
// the animation properties themselves are never animated, so reading them cannot recurse.
const COMPOSITE_OPERATIONS = new Set(['replace', 'add', 'accumulate']);
function animationsFor(el, read) {
  const names = listOf(read(el, 'animation-name')).filter((n) => n && n.toLowerCase() !== 'none');
  if (!names.length) return null;
  const durations  = listOf(read(el, 'animation-duration'));
  const delays     = listOf(read(el, 'animation-delay'));
  const easings    = listOf(read(el, 'animation-timing-function'));
  const counts     = listOf(read(el, 'animation-iteration-count'));
  const directions = listOf(read(el, 'animation-direction'));
  const fills      = listOf(read(el, 'animation-fill-mode'));
  // A coordinated list is valid WHOLE or not at all: one unknown keyword drops the declaration,
  // and every animation composites the default way (Chrome-measured: `add, bogus` composites
  // nothing). Repairing the list item by item made a typo change a rendered number.
  const composites = listOf(read(el, 'animation-composition'));
  const composition = composites.every((c) => COMPOSITE_OPERATIONS.has(c.toLowerCase())) ? composites : [];
  const out = [];
  for (let i = 0; i < names.length; i++) {
    const blocks = keyframesNamed(names[i], el);
    if (!blocks) continue;                       // a name with no `@keyframes` animates nothing
    out.push({
      name: names[i],
      blocks,
      duration:  Math.max(0, timeMs(cycle(durations, i, '0s'), 0)),
      delay:     timeMs(cycle(delays, i, '0s'), 0),
      easing:    cycle(easings, i, 'ease'),
      iterations: iterationCount(cycle(counts, i, '1')),
      direction: String(cycle(directions, i, 'normal')).toLowerCase(),
      fill:      String(cycle(fills, i, 'none')).toLowerCase(),
      composite: String(cycle(composition, i, 'replace')).toLowerCase()
    });
  }
  return out.length ? out : null;
}

// ── Timing ───────────────────────────────────────────────────────────────────────────────────
// ONE timing ladder, for CSS animations and for the Web Animations API alike (web-animations §4.5).
// A `timing` record is what both sides build — the CSS one from its `animation-*` longhands, the
// script one from the options `animate()` was given — and this turns a LOCAL TIME into the phase,
// the iteration and the eased progress through it.
//
// Deliberately one function: the two started as two ladders of the same algorithm, and they had
// already drifted apart (the CSS one knew about fractional iteration counts, the script one about
// `iterationStart` and `endDelay`) before either was finished.
export function computedTimingAt(timing, localTime) {
  const dur = Math.max(0, Number(timing.duration) || 0);
  const iterations = timing.iterations === Infinity ? Infinity : Math.max(0, Number(timing.iterations) || 0);
  const iterationStart = Math.max(0, Number(timing.iterationStart) || 0);
  const delay = Number(timing.delay) || 0;
  const active = dur * iterations;
  const out = { progress: null, currentIteration: null, localTime, phase: 'idle',
                duration: dur, activeDuration: active,
                endTime: Math.max(0, delay + active + (Number(timing.endDelay) || 0)) };
  if (localTime == null) return out;
  // The PHASE is the same three-way split the branches below make, and it is what the events are
  // about — so it is answered here rather than re-derived by whoever needs it.
  const activeEnd = delay + (Number.isFinite(active) ? active : Infinity);
  out.phase = localTime < delay ? 'before' : (localTime >= activeEnd ? 'after' : 'active');
  const fill = !timing.fill || timing.fill === 'auto' ? 'none' : timing.fill;
  const fillsBackwards = fill === 'backwards' || fill === 'both';
  const fillsForwards  = fill === 'forwards'  || fill === 'both';
  const activeTime = localTime - delay;
  let progress, iteration;
  if (activeTime < 0) {
    // BEFORE it starts: nothing at all unless it fills backwards, and then at its first keyframe —
    // which `iteration-start` can put part way into an iteration.
    if (!fillsBackwards) return out;
    progress = iterationStart % 1;
    iteration = Math.floor(iterationStart);
  } else if (dur === 0) {
    // A zero-duration animation is entirely at its end from the instant it starts.
    if (activeTime > 0 && !fillsForwards) return out;
    progress = endProgress(iterationStart, iterations);
    iteration = lastIteration(iterationStart, iterations);
  } else if (activeTime >= active) {
    if (!fillsForwards) return out;
    progress = endProgress(iterationStart, iterations);
    iteration = lastIteration(iterationStart, iterations);
  } else {
    const at = iterationStart + activeTime / dur;
    iteration = Math.floor(at);
    progress = at - iteration;
  }
  // `alternate` runs every odd iteration backwards; `reverse` flips the whole thing, which is the
  // same swap applied once more.
  const dir = timing.direction;
  let reverse = dir === 'reverse' || dir === 'alternate-reverse';
  if ((dir === 'alternate' || dir === 'alternate-reverse') &&
      Number.isFinite(iteration) && Math.abs(iteration) % 2 === 1) reverse = !reverse;
  if (reverse) progress = 1 - progress;
  out.progress = easingFunction(timing.easing)(progress);
  out.currentIteration = iteration;
  return out;
}

// Where a FINISHED animation holds: at the end of its last iteration, which for a fractional
// iteration count is that fraction through it and not the end (Chrome holds `iteration-count: 2.5`
// half way, not at 100%).
function endProgress(iterationStart, iterations) {
  const frac = (iterationStart + iterations) % 1;
  return Number.isFinite(iterations) && frac !== 0 ? frac : 1;
}
function lastIteration(iterationStart, iterations) {
  if (!Number.isFinite(iterations)) return Infinity;
  return Math.max(0, Math.ceil(iterationStart + iterations) - 1);
}

// When the animations on `el` began. A page's animation starts when its style first names it, and
// the driver's clock is the page's: `performance.now()`, the same time base every other timed API
// reads. The stamp is per (element, animation-name list), so re-declaring the same animation keeps
// running where it was while a NEW name restarts from zero, as css-animations §4.4 requires.
function startTimeOf(el, key) {
  if (el._csimAnimKey !== key) {
    el._csimAnimKey = key;
    el._csimAnimStart = animationNow();
  }
  return el._csimAnimStart;
}

// ── Keyframe lookup ──────────────────────────────────────────────────────────────────────────
// The offsets at which `prop` is declared, in order — flattened from the `@keyframes` blocks,
// where one block can carry several offsets (`50%, 75% { … }`) and a later block wins at an offset
// it repeats. A FLOW-RELATIVE twin counts as the same property: `@keyframes { to { padding-inline:
// 20px } }` animates `padding-left` too, because they are one value written two ways.
function stopsFor(blocks, prop, twin, composite) {
  const byOffset = new Map();
  for (const block of blocks) {
    let value;
    let easing;
    let own;
    for (const d of block.decls) {
      // css-animations §3: an `!important` declaration inside a keyframe is IGNORED — it does not
      // win, and it does not make the offset a keyframe for that property either.
      if (d.important) continue;
      if (d.prop === prop || (twin && d.prop === twin)) value = d.value;
      // …and a keyframe may carry its OWN timing function, which governs the interval that STARTS
      // at it (css-animations §4.1), and its own composite operation (css-animations-2 §4.2),
      // which governs how ITS value combines with the one underneath.
      else if (d.prop === 'animation-timing-function') easing = d.value;
      else if (d.prop === 'animation-composition') {
        const named = String(d.value).trim().toLowerCase();
        own = COMPOSITE_OPERATIONS.has(named) ? named : undefined;
      }
    }
    if (value === undefined) continue;
    for (const off of block.offsets) byOffset.set(off, { value, easing, composite: own || composite });
  }
  if (!byOffset.size) return null;
  return [...byOffset.entries()].sort((a, b) => a[0] - b[0])
                                .map(([offset, v]) => ({ offset, value: v.value, easing: v.easing,
                                                         composite: v.composite }));
}

// Every property any of these blocks declares — the set an element's animations can affect.
function propsIn(blocks, into) {
  for (const block of blocks) for (const d of block.decls) if (!d.important) into.add(d.prop);
}

// ── The value ────────────────────────────────────────────────────────────────────────────────
// What `prop` reports on `el` right now, or `null` when no animation on it touches the property.
//
// `underlying` is the value the cascade produced — what a NEUTRAL keyframe (one that doesn't
// mention the property at 0% or 100%) contributes, which is how `animation: fade` over a value the
// page also sets stays anchored to that value. `resolve` computes a keyframe's declared text in
// this element's context (`2em`, `var(--x)`) — the caller owns that machinery.
// The CSS animations declared on an element, as timing records — the object layer's window onto
// what the cascade says is running, without it having to know how `animation-*` is read.
export function cssAnimationsOf(el, read) {
  const anims = animationsFor(el, read);
  if (!anims) return null;
  const started = startTimeOf(el, animKey(anims));
  return anims.map((a) => Object.assign({}, a, { startTime: started + a.delay }));
}

// …and the transitions actually RUNNING on it, keyed by the property each transitions.
export function cssTransitionsOf(el) {
  const store = el._csimTrans;
  if (!store || !store.runs.size) return null;
  const out = [];
  // Reported under the PHYSICAL name: that is what a `transitionend` names, whichever spelling the
  // page wrote (the run itself is keyed by whichever of the pair sorts first).
  for (const [prop, run] of store.runs) out.push({ property: run.property || prop, run });
  return out;
}

export function animatedValue(el, prop, twin, underlying, read, resolve) {
  if (!documentHasKeyframes()) return null;
  if (ANIMATION_TYPES[prop] === undefined) return null;      // not a longhand: nothing to animate
  const anims = animationsFor(el, read);
  if (!anims) return null;
  const now = animationNow();
  const started = startTimeOf(el, animKey(anims));
  noteRunningElement(el);
  let value = null;
  // Later animations in the list override earlier ones on a property they share (css-animations
  // §4.6: the animations are applied in list order, so the last one written wins).
  for (const anim of anims) {
    const stops = stopsFor(anim.blocks, prop, twin, anim.composite);
    if (!stops) continue;
    const { progress } = computedTimingAt(anim, now - started);
    if (progress == null) continue;                          // not in effect — the cascade stands
    value = valueAt(el, prop, stops, progress, underlying, resolve);
  }
  return value;
}

// The identity of the animation list — its NAMES, which is what decides whether an animation is
// the same one still running. css-animations §4.4: changing `animation-name` cancels the old
// animation and starts a new one, while changing its duration or delay leaves it running (from the
// same start time, so it jumps). Keying on the timing did exactly the opposite of both.
function animKey(anims) {
  let key = '';
  for (const a of anims) key += a.name + ';';
  return key;
}

export function valueAt(el, prop, stops, progress, underlying, resolve) {
  // Neutral ends: with no keyframe at 0% (or 100%) the property takes the UNDERLYING value there.
  const ends = stops.slice();
  if (ends[0].offset > 0 && underlying != null) ends.unshift({ offset: 0, value: underlying, computed: true });
  if (ends[ends.length - 1].offset < 1 && underlying != null) ends.push({ offset: 1, value: underlying, computed: true });
  if (ends.length === 1) return endpointValue(el, prop, ends[0], resolve, underlying);
  // Which pair of keyframes the progress lies between — and OUTSIDE their range, the first or last
  // pair EXTENDED rather than clamped: a progress of -0.3 is three tenths of the way back from the
  // first keyframe, which is what an overshooting easing or a negative seek asks for
  // (web-animations §Interpolation: the interval is chosen, then the progress is used as-is).
  let lo = ends[0], hi = ends[1];
  if (progress > ends[ends.length - 1].offset) { lo = ends[ends.length - 2]; hi = ends[ends.length - 1]; }
  else if (progress >= ends[0].offset) {
    for (let i = 0; i < ends.length - 1; i++) {
      if (progress >= ends[i].offset && progress <= ends[i + 1].offset) { lo = ends[i]; hi = ends[i + 1]; break; }
    }
  }
  const span = hi.offset - lo.offset;
  const raw = span > 0 ? (progress - lo.offset) / span : 0;
  // The interval takes the timing function declared at the keyframe it STARTS from, when there is
  // one (css-animations §4.1: `animation-timing-function` inside a keyframe applies to the segment
  // that begins there, not to the animation).
  const local = lo.easing ? easingFunction(lo.easing)(raw) : raw;
  const from = endpointValue(el, prop, lo, resolve, underlying);
  const to   = endpointValue(el, prop, hi, resolve, underlying);
  if (from == null || to == null) return from == null ? to : from;
  return interpolateProperty(prop, from, to, local) ?? discreteValue(from, to, local);
}

// A keyframe's value as the element computes it — the underlying value is already computed, a
// keyframe's declared text is not — and COMPOSITED with the value underneath the animation, which
// is a property of the KEYFRAME rather than of the effect (web-animations §The effect value of a
// keyframe animation effect). Two keyframes in one effect may differ, and compositing the
// interpolated result instead agreed only where the operation is linear: Chrome-measured, an
// effect whose first keyframe adds and whose second replaces reports 0.45 over an underlying
// `opacity: 0.5`, where compositing afterwards reports 0.7.
//
// A NEUTRAL end — the one `valueAt` synthesises where the page wrote no keyframe — is the
// underlying value already, and composites with nothing.
function endpointValue(el, prop, stop, resolve, underlying) {
  const value = stop.computed ? stop.value : resolve(el, prop, stop.value);
  if (value == null || underlying == null) return value;
  if (stop.composite !== 'add' && stop.composite !== 'accumulate') return value;
  return addValues(prop, underlying, value, stop.composite);
}

// Every property the animations on `el` declare, or `null` when it has none — the gate that keeps
// an unanimated property from asking the model anything.
export function animatedProperties(el, read) {
  if (!documentHasKeyframes()) return null;
  const anims = animationsFor(el, read);
  if (!anims) return null;
  // An element that HAS an animation is running one, whether or not the property being read is one
  // it touches: the object layer and its events are about the animation, not about this read. (The
  // layout pass reads every element's style, so this is how an animation nobody's script has looked
  // at still starts, ends, and fires its events.)
  noteRunningElement(el);
  const props = new Set();
  for (const anim of anims) propsIn(anim.blocks, props);
  return props.size ? props : null;
}

// ── Transitions ──────────────────────────────────────────────────────────────────────────────
// A transition is started by a CHANGE, not by a declaration: the property computed one value at
// the last style change event and computes another now, and `transition-property` names it
// (css-transitions §3). So the model needs one thing an animation doesn't — a memory of what the
// property was — and it keeps exactly that: the last value seen, stamped with the style epoch it
// was seen at.
//
// The style change event is a READ. A browser's is a style recalc, and a recalc is what a
// computed-value read forces; between two reads nothing can observe the difference, which is why
// the whole model can stay lazy and still start transitions where a browser starts them.

// Which properties this element transitions, as a lookup: `all` covers everything animatable,
// `none` (and an empty list) covers nothing. Each entry carries the timing that goes with it —
// `transition-*` are coordinated lists indexed by `transition-property`, like the animation ones.
function transitionSpecs(el, read) {
  const props = listOf(read(el, 'transition-property'));
  if (!props.length) return null;
  const durations = listOf(read(el, 'transition-duration'));
  const delays    = listOf(read(el, 'transition-delay'));
  const easings   = listOf(read(el, 'transition-timing-function'));
  const behaviors = listOf(read(el, 'transition-behavior'));
  const specs = new Map();
  let all = null;
  for (let i = 0; i < props.length; i++) {
    const name = props[i].trim().toLowerCase();
    if (!name || name === 'none') continue;
    const spec = {
      duration: Math.max(0, timeMs(cycle(durations, i, '0s'), 0)),
      delay:    timeMs(cycle(delays, i, '0s'), 0),
      easing:   cycle(easings, i, 'ease'),
      discrete: String(cycle(behaviors, i, 'normal')).toLowerCase() === 'allow-discrete'
    };
    // A SHORTHAND names every longhand under it — `transition-property: margin-block` transitions
    // `margin-block-start` and `-end` — and a shorthand of shorthands (`margin`, `border`) reaches
    // through to the leaves.
    if (name === 'all') all = spec;
    else for (const lh of longhandsOf(name)) specs.set(lh, spec);
  }
  if (!specs.size && !all) return null;
  return { specs, all };
}

// A property name flattened to the longhands it SETS — itself, when it is one already. Through the
// driver's own shorthand registry, never mdn's `computed` lists: those are a computed-value
// resolution, so mdn answers `border-block-end` with the four PHYSICAL widths, and a
// `transition-property: border-block-end` armed the wrong side of the box (Chrome-measured).
export function longhandsOf(name, depth = 0) {
  const subs = shorthandLonghands(name);
  if (!subs || !subs.length || depth > 3) return [name];
  const out = [];
  for (const sub of subs) for (const lh of longhandsOf(sub, depth + 1)) out.push(lh);
  return out;
}

// The transition timing for one property, or `null` when the element doesn't transition it. A
// flow-relative twin names the same value, so either spelling starts the transition.
function transitionSpecFor(el, prop, twin, read) {
  const t = transitionSpecs(el, read);
  if (!t) return null;
  return t.specs.get(prop) || (twin ? t.specs.get(twin) : undefined) || t.all;
}

// ONE run per property, whichever of its two names asked for it: `padding-left` and
// `padding-inline-start` are the same value, and two runs would drift apart by however long the
// two reads were separated by.
function runKey(prop, twin) { return twin && twin < prop ? twin : prop; }
let TRANSITION_SEQ = 0;
// Which of a flow-relative pair is the PHYSICAL name — what a `transitionend` reports, whichever
// spelling the page transitioned (Chrome: `padding-left`, never `padding-inline-start`). Every
// css-logical property name carries `block` or `inline` as a whole word; no physical one does.
const LOGICAL_NAME_RE = /(^|-)(block|inline)(-|$)/;
export function physicalName(prop, twin) {
  return LOGICAL_NAME_RE.test(prop) && twin ? twin : prop;
}

// What `prop` reports on `el` while a transition runs, or `null` when none does — and, on the way,
// the bookkeeping that STARTS one: a value that differs from what this element reported at the
// last style change event is a change, and a change is what a transition transitions.
//
// `cascaded` is the value the cascade (and any animation) produced — where the property is heading.
// `before` is what it reported at the previous style change event, or `undefined` when it has not
// reported one yet: an element being styled for the first time transitions from nothing
// (css-transitions §3 — there has to be a before-change style).
export function transitionedValue(el, prop, twin, cascaded, before, read, resolve) {
  const key = runKey(prop, twin);
  let store = el._csimTrans;
  let run = store && store.runs.get(key);
  if (run) {
    // A property since sent SOMEWHERE ELSE starts a new transition from wherever this one has got
    // to (css-transitions §3, the reversing-adjusted start value) — and one that has arrived
    // retires, leaving the cascade to report the value on its own.
    const target = resolve(el, prop, cascaded);
    if (target !== run.to) {
      // …all of it measured at the STYLE CHANGE, not at this read: where the old run had got to,
      // and how much of it was left to shorten a reversal by.
      const changedAt = styleChangeTime();
      const at = runValue(run, prop, changedAt);
      // Sending a property BACK where it came from reverses the running transition rather than
      // starting a fresh one, and the reverse is SHORTENED so it takes no longer to come back than
      // it took to get out (css-transitions §3, the reversing shortening factor). Hovering off
      // half way through a hover-on is the everyday case: Chrome-measured, a 1000ms run reversed at
      // 50% has a duration of 500ms, not 1000.
      const reversing = target === run.reverseFrom;
      const factor = reversing
                   ? Math.max(0, Math.min(1, Math.abs(clampProgress(run, changedAt) * run.factor + (1 - run.factor))))
                   : 1;
      store.runs.delete(key);
      startTransition(el, prop, twin, at, cascaded, read, resolve, store, key,
                      reversing ? { factor, reverseFrom: run.to } : null);
      run = store.runs.get(key);
    } else if (runProgress(run) >= 1) {
      store.runs.delete(key);
      run = null;
    }
  } else if (before !== undefined && before !== cascaded) {
    if (!store) store = el._csimTrans = { runs: new Map() };
    startTransition(el, prop, twin, before, cascaded, read, resolve, store, key);
    run = store.runs.get(key);
  }
  return run ? runValue(run, prop) : null;
}

// How far through its active interval a run is: below 0 while its delay holds it at the start
// value, 1 or more once it is over.
function runProgress(run, at) {
  const localTime = (at === undefined ? animationNow() : at) - run.start - run.delay;
  return run.duration <= 0 ? 1 : localTime / run.duration;
}

// The value a run reports right now — its start value through the delay, its end value once it is
// over, and the interpolation between.
function runValue(run, prop, at) {
  const t = runProgress(run, at);
  if (t <= 0) return run.from;
  if (t >= 1) return run.to;
  const progress = easingFunction(run.easing)(t);
  if (run.discreteOnly) return discreteValue(run.from, run.to, progress);
  return interpolateProperty(prop, run.from, run.to, progress) ?? discreteValue(run.from, run.to, progress);
}

// When the style change that a transition is reacting to happened. A transition starts THERE, not
// at the read that noticed it: the two are the same moment within one task and drift apart
// whenever the clock steps in between, which in a driver whose values are computed on demand is
// most of the time. Never in the future — a mutation stamped during a later step would put the run
// ahead of the clock.
function styleChangeTime() { return Math.min(animationNow(), lastMutationAt()); }

// A run's progress through its interval, clamped to the [0,1] the reversing factor is defined over.
function clampProgress(run, at) { return Math.max(0, Math.min(1, runProgress(run, at))); }

function startTransition(el, prop, twin, fromValue, toValue, read, resolve, store, key, reversal) {
  const spec = transitionSpecFor(el, prop, twin, read);
  if (!spec) return;
  // A transition with no time to run in never starts — and neither does one whose ends can't be
  // interpolated, unless the page asked for the discrete flip explicitly (css-transitions-2
  // `transition-behavior: allow-discrete`).
  if (spec.duration + spec.delay <= 0) return;
  const from = resolve(el, prop, fromValue), to = resolve(el, prop, toValue);
  if (from == null || to == null) return;
  const discreteOnly = interpolateProperty(prop, from, to, 0.5) == null;
  if (discreteOnly && !spec.discrete) return;
  const factor = reversal ? reversal.factor : 1;
  noteRunningElement(el);
  store.runs.set(key, {
    // Each run is its own transition, even where it replaces one under the same key: a reversal is
    // a NEW transition, and the object layer tells the two apart by this id so it can cancel the
    // one that was replaced.
    id: ++TRANSITION_SEQ,
    from, to, discreteOnly, property: physicalName(prop, twin),
    start: styleChangeTime(),
    // Only a NEGATIVE delay is scaled by the factor: a positive one still holds the box still for
    // as long as the page asked (css-transitions §3, "start time = … + delay × factor" applies to
    // the delay when it is negative).
    duration: spec.duration * factor,
    delay: spec.delay < 0 ? spec.delay * factor : spec.delay,
    easing: spec.easing,
    // What this run would be reversing BACK to, and by how much a reversal of it shortens.
    reverseFrom: reversal ? reversal.reverseFrom : from,
    factor
  });
}

