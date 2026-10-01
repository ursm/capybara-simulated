// The Web Animations API's page-facing half — what `element.animate()`, `getAnimations()` and the
// constructors take as arguments, and where they go.
//
// The animations themselves are the STYLE ENGINE's (`web-animations-engine.js`): its `Animation`,
// `KeyframeEffect`, `CSSAnimation` and `CSSTransition` are handles on what it runs, on the same
// clock and in the same composite order as the CSS animations and transitions it runs beside them.
// What lives here is the processing every one of them shares — a keyframes argument reduced to one
// list, a timing dictionary validated (web-animations §Processing a keyframes argument, §The
// EffectTiming dictionaries) — and the document timeline, plus the forwarders the cascade, the
// layout and the DOM ask the engine through. Registered rather than imported (`useEngineAnimations`):
// the engine imports THIS module for the processing, so the edge has to run the other way.
import { animationNow, canonicalEasing } from './animation.js';
import { reduceMathFunctions } from './calc.js';
import { expandShorthandValue, onScriptAnimationProperties } from './cascade.js';
import { CSS_PROPERTY_BY_IDL_ATTRIBUTE, cssPropertyName, isValidDeclarationValue } from './css-utils.js';
import { LONGHANDS, ANIMATION_TYPES, SHORTHAND_LONGHANDS } from './css-property-data.js';
import { shorthandLonghands, hasSubstitution } from './shorthands.js';

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
// Whether a member NAME is a keyframe property at all, decided without touching its VALUE: the
// spec filters by animatability before reading, and the tests hold implementations to it with
// getters that count their own accesses (`{get animationDelay() { … }}` must never be called).
// A shorthand counts when anything under it animates.
// mdn calls `will-change` discrete; it is not animatable at all (css-will-change-1 §3).
const NEVER_ANIMATABLE = new globalThis.Set(['will-change']);
// A MEMBER name is an IDL attribute, so a hyphen belongs to a custom property alone (`font-size`
// is spelled `fontSize` here), and the CSS `float` is spelled `cssFloat` — under its own name it
// is not a member at all (web-animations §Processing a keyframes argument, and the WPT list of
// names that must never even be READ).
function isKeyframeMember(member) {
  if (member.startsWith('--')) return true;
  if (member.indexOf('-') >= 0 || member === 'float') return false;
  return isKeyframeProperty(cssNameOf(member));
}
function isKeyframeProperty(prop, depth = 0) {
  if (prop.startsWith('--')) return true;
  if (NEVER_ANIMATABLE.has(prop)) return false;
  if (LONGHANDS.has(prop)) return !!ANIMATION_TYPES[prop] && ANIMATION_TYPES[prop] !== 'notAnimatable';
  // Through the SHORTHAND map rather than the CSSOM registry: `background`, `inset`,
  // `text-decoration` and `font` are not in that registry — the same four the expander exists for.
  const subs = depth > 3 ? null : SHORTHAND_LONGHANDS[prop];
  return !!subs && subs.some((lh) => isKeyframeProperty(lh, depth + 1));
}

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
    // …and neither is a value the property's grammar rejects: a keyframe is a declaration, parsed
    // like any other, so `{ lineHeight: '-1' }` produces no keyframe at all in Chrome rather than
    // one holding a value no declaration could carry.
    if (!prop.startsWith('--') && !isValidDeclarationValue(prop, String(value))) return false;
    into[prop] = String(value);
    return true;
  }
  // A SHORTHAND keyframe names every longhand under it, each with ITS OWN component of the value —
  // through the CASCADE's expander, the same one a declaration goes through, so `{columns: '30px
  // 3'}` sets `column-width: 30px` and `column-count: 3` rather than handing both the whole text
  // (which is what happened before, and which only looked right for the box shorthands where every
  // longhand takes the same token).
  // A SHORTHAND keyframe names every longhand under it, each with ITS OWN component of the value —
  // through the CASCADE's expander, the same one a declaration goes through, so `{columns: '30px
  // 3'}` sets `column-width: 30px` and `column-count: 3` rather than handing both the whole text
  // (which is what happened before, and which only looked right for the box shorthands where every
  // longhand takes the same token).
  //
  // Asked FIRST, before the CSSOM registry: four shorthands — `background`, `inset`,
  // `text-decoration`, `font` — are not in that registry at all and live only in the cascade's
  // hand-written expanders, so consulting the registry first skipped exactly the ones this is for.
  //
  // …except where the value carries a SUBSTITUTION, which cannot be decomposed until it resolves:
  // the expander answers that with a pending-substitution marker, a cascade-time device that means
  // nothing in a keyframe. There each longhand takes the raw text and the endpoint resolver expands
  // the `var()` — which works for a substitution standing for one longhand's WHOLE value, not for
  // one that spans several (`--two: 5px 10px` in a `margin` keyframe still flips).
  let any = false;
  const pairs = depth > 3 || hasSubstitution(String(value))
    ? null : expandShorthandValue(prop, String(value));
  if (pairs) {
    for (const [lh, v] of pairs) any = putLonghands(into, lh, v, depth + 1) || any;
    return any;
  }
  const subs = depth > 3 ? null : shorthandLonghands(prop);
  // A member that is no CSS property at all is not a keyframe property: it is IGNORED, not stored
  // under its own name (web-animations §Processing a keyframes argument). Feeding
  // `getKeyframes()` back into the constructor — which every roundtrip test does — otherwise
  // carried `computedOffset` in as a declaration and reported it back as `computedoffset`.
  if (!subs || !subs.length) return false;
  // A shorthand no expander decomposes still fills every slot: the value is all any of them has to
  // go on.
  for (const lh of subs) any = putLonghands(into, lh, value, depth + 1) || any;
  return any;
}

// The members a keyframe-like object contributes, in ASCENDING codepoint order of the property
// name they map to — the order a page can observe through its own getters (web-animations
// §Processing a keyframe-like object step 2).
function keyframeMembers(raw) {
  return Object.keys(raw).filter((key) => !RESERVED.has(key) && isKeyframeMember(key))
                         .sort((a, b) => (a < b ? -1 : 1));
}

export function normalizeKeyframes(input) {
  if (input == null) return [];
  const frames = [];
  const iterable = typeof input[globalThis.Symbol.iterator] === 'function' && typeof input !== 'string';
  if (iterable) {
    // The whole list is ITERATED and every keyframe's properties READ before any offset / easing /
    // composite is validated: an invalid easing on the first keyframe is still reported only after
    // the last one has been read (web-animations §Processing a keyframes argument, and the WPT
    // tests that count their own getter calls).
    // …and each keyframe is read in ONE order: `composite`, `easing`, `offset`, then its
    // properties by ascending codepoint (the WPT tests pin the exact sequence).
    const read = [...input].map((raw) => {
      const k = raw == null ? {} : raw;
      return { composite: k.composite, easing: k.easing, offset: k.offset,
               declared: keyframeMembers(k).map((key) => [key, k[key]]) };
    });
    for (const r of read) {
      const frame = newFrame(r.offset, r.easing, r.composite);
      for (const [key, value] of r.declared) putDeclaration(frame, key, value);
      frames.push(frame);
    }
    requireSortedOffsets(frames);
    spaceOffsets(frames);
  } else {
    // Object form: each property carries a LIST of values, and each list is spread evenly over the
    // WHOLE animation on its own — three opacities and two flex-grows put the flex-grows at 0 and
    // 1, not at 0 and ½ (web-animations §Processing a keyframes argument, which builds
    // property-indexed keyframes per property and only then merges them by offset).
    const offsets = asList(input.offset), easings = asList(input.easing), composites = asList(input.composite);
    // Every entry is validated, INCLUDING the ones no keyframe ever reaches: `{easing: 'bogus'}`
    // with no properties at all still throws, and so does a bad easing in the unused tail of the
    // list (web-animations §Processing a keyframes argument, which validates the lists before it
    // distributes them).
    const byOffset = new globalThis.Map();
    const frameAt = (offset, index) => {
      let frame = byOffset.get(offset);
      if (!frame) {
        frame = newFrame(offsets[index] === undefined ? null : offsets[index],
                         easings.length ? easings[index % easings.length] : undefined,
                         composites.length ? composites[index % composites.length] : undefined);
        frame.computedOffset = offset;
        byOffset.set(offset, frame);
      }
      return frame;
    };
    const pending = [];
    for (const key of keyframeMembers(input)) {
      const read = input[key];   // ONCE — a member is a getter a page can count the calls to.
      const values = Array.isArray(read) ? read : [read];
      // ONE value is a to-keyframe: it animates from whatever the element already has.
      if (values.length === 1) { pending.push([1, 0, key, values[0]]); continue; }
      for (let i = 0; i < values.length; i++) pending.push([i / (values.length - 1), i, key, values[i]]);
    }
    // Every list entry is validated, INCLUDING the ones no keyframe ever reaches — `{easing:
    // 'bogus'}` with no properties at all still throws, and so does a bad easing in the unused tail
    // of the list — but only once every property has been read.
    offsets.forEach((o) => frameOffset(o));
    easings.forEach((e) => frameEasing(e));
    composites.forEach((c) => frameComposite(c));
    for (const [offset, index, key, value] of pending) putDeclaration(frameAt(offset, index), key, value);
    const built = [...byOffset.values()].sort((a, b) => a.computedOffset - b.computedOffset);
    requireSortedOffsets(built);
    frames.push(...built);
    // An explicit `offset` list still overrides the computed positions, in frame order.
    if (offsets.length) {
      // A NULL in the offset list is "space this one evenly", not zero — `[0, null, 1]` puts the
      // middle keyframe at 0.5 (Chrome-measured), where `Number(null)` put it at 0.
      frames.forEach((f, i) => {
        if (offsets[i] === undefined || offsets[i] === null) return;
        f.computedOffset = f.offset = frameOffset(offsets[i]);
      });
      frames.sort((a, b) => a.computedOffset - b.computedOffset);
      requireSortedOffsets(frames);
      spaceOffsets(frames);
    }
  }
  // …and with nothing animatable left anywhere, there are no keyframes.
  return frames.some((f) => Object.keys(f.props).length) ? frames : [];
}

// A member that is ABSENT contributes no list; an explicit `null` is a one-entry list, and a
// one-entry list of `null` is what makes `{composite: null}` a TypeError rather than a default.
const asList = (v) => (Array.isArray(v) ? v : (v === undefined ? [] : [v]));
// The three MEMBERS every keyframe may carry, each validated as it is read: Web Animations rejects
// what CSS ignores, and the rejection is a TypeError from the constructor rather than a keyframe
// that quietly does nothing (web-animations §Processing a keyframes argument).
export const COMPOSITE_OPERATIONS = new globalThis.Set(['replace', 'add', 'accumulate']);
function frameOffset(offset) {
  if (offset == null) return null;
  // An offset is CSS syntax too, so a `calc()` is one: `offset: 'calc(0.5)'` is a half
  // (Chrome-measured), and a plain string converts as a number would.
  const text = String(offset).trim();
  const n = Number(/^calc\(/i.test(text) ? reduceMathFunctions(text, () => null) : text);
  // A keyframe offset is a progress: null, or a number in [0,1]. Anything else is a TypeError.
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    throw new globalThis.TypeError(`Offsets must be null or a number in [0, 1]: ${offset}`);
  }
  return n;
}

// …and they must be LOOSELY SORTED: an offset that goes backwards is a TypeError, not a keyframe
// list a browser reorders (web-animations §Processing a keyframes argument).
function requireSortedOffsets(frames) {
  let previous = -Infinity;
  for (const frame of frames) {
    if (frame.offset == null) continue;
    if (frame.offset < previous) {
      throw new globalThis.TypeError(`Offsets must be monotonically non-decreasing: ${frame.offset}`);
    }
    previous = frame.offset;
  }
}
function frameEasing(easing) {
  // ABSENT is the effect's easing; an explicit `null` is a value, and not one of these
  // (Chrome-measured: `{easing: null}` is a TypeError).
  if (easing === undefined) return null;
  const canonical = canonicalEasing(easing);
  if (canonical === null) throw new globalThis.TypeError(`Invalid easing: ${easing}`);
  return canonical;
}
function frameComposite(composite) {
  if (composite === undefined) return null;
  const name = String(composite);
  // `auto` means "take the effect's", and is only a KEYFRAME's answer — the effect's own composite
  // has no such value.
  if (name !== 'auto' && !COMPOSITE_OPERATIONS.has(name)) {
    throw new globalThis.TypeError(`Invalid composite operation: ${name}`);
  }
  return name;
}
function newFrame(offset, easing, composite) {
  return { offset: frameOffset(offset),
           easing: frameEasing(easing),
           composite: frameComposite(composite),
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
export const TIMING_DEFAULTS = {
  delay: 0, endDelay: 0, fill: 'auto', iterationStart: 0, iterations: 1,
  duration: 'auto', direction: 'normal', easing: 'linear'
};

// An EFFECT's composite is one of the three operations — never `auto`, which is a keyframe saying
// "take the effect's" (Chrome-measured: `{composite: 'auto'}` on the options is a TypeError).
export function effectComposite(value) {
  if (value === undefined) return 'replace';
  const name = String(value);
  if (!COMPOSITE_OPERATIONS.has(name)) throw new globalThis.TypeError(`Invalid composite operation: ${name}`);
  return name;
}

const FILL_MODES = new globalThis.Set(['none', 'forwards', 'backwards', 'both', 'auto']);
const PLAYBACK_DIRECTIONS = new globalThis.Set(['normal', 'reverse', 'alternate', 'alternate-reverse']);
// `delay`, `endDelay` and `iterationStart` are IDL `double`s, so a non-finite one is a TypeError
// before the spec's own range check even runs.
function finiteTiming(name, value) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new globalThis.TypeError(`${name} must be finite: ${value}`);
  return n;
}

export function normalizeTiming(options) {
  const t = Object.assign({}, TIMING_DEFAULTS);
  if (typeof options === 'number') { t.duration = options; }
  else if (options && typeof options === 'object') {
    for (const key of Object.keys(TIMING_DEFAULTS)) if (options[key] !== undefined) t[key] = options[key];
  }
  t.delay = finiteTiming('delay', t.delay);
  t.endDelay = finiteTiming('endDelay', t.endDelay);
  t.iterationStart = finiteTiming('iterationStart', t.iterationStart);
  if (t.iterationStart < 0) throw new globalThis.TypeError(`iterationStart must be non-negative: ${t.iterationStart}`);
  const iterations = Number(t.iterations);
  if (Number.isNaN(iterations) || iterations < 0) {
    throw new globalThis.TypeError(`iterations must be non-negative: ${t.iterations}`);
  }
  t.iterations = iterations;
  // `duration` is `(unrestricted double or DOMString)`: a number that is neither negative nor NaN,
  // or the one string `auto`. A numeric STRING is a string, so `'100'` is not a duration.
  if (typeof t.duration === 'string' ? t.duration !== 'auto'
                                     : !(Number(t.duration) >= 0 || t.duration === Infinity)) {
    throw new globalThis.TypeError(`duration must be non-negative or auto: ${t.duration}`);
  }
  if (typeof t.duration !== 'string') t.duration = Number(t.duration);
  if (!FILL_MODES.has(String(t.fill))) throw new globalThis.TypeError(`Invalid fill: ${t.fill}`);
  t.fill = String(t.fill);
  if (!PLAYBACK_DIRECTIONS.has(String(t.direction))) throw new globalThis.TypeError(`Invalid direction: ${t.direction}`);
  t.direction = String(t.direction);
  // The easing is CSS syntax carried in a dictionary, and an unparsable one is a TypeError rather
  // than a silent `linear` — validated here so the constructor throws, and stored CANONICAL so
  // `getTiming()` reports what a browser reports.
  const easing = canonicalEasing(t.easing);
  if (easing === null) throw new globalThis.TypeError(`Invalid easing: ${t.easing}`);
  t.easing = easing;
  return t;
}

const IDL_BY_CSS = new globalThis.Map();
for (const idl of Object.keys(CSS_PROPERTY_BY_IDL_ATTRIBUTE)) {
  if (!IDL_BY_CSS.has(CSS_PROPERTY_BY_IDL_ATTRIBUTE[idl])) IDL_BY_CSS.set(CSS_PROPERTY_BY_IDL_ATTRIBUTE[idl], idl);
}
export function idlNameOf(prop) { return IDL_BY_CSS.get(prop) || prop; }


// ── The timeline ─────────────────────────────────────────────────────────────────────────────
// The document timeline's current time is the driver's own clock — the one the engine runs every
// animation on, so an `element.animate()` and an `@keyframes` on the same page stay in step.
export class AnimationTimeline {
  get currentTime() { return animationNow(); }
}
export class DocumentTimeline extends AnimationTimeline {}
export const documentTimeline = new DocumentTimeline();

// Each interface carries its own class string, which is how a page (and the IDL tests) tell a
// timeline from a plain object (the engine's classes do the same for theirs).
for (const ctor of [AnimationTimeline, DocumentTimeline]) {
  Object.defineProperty(ctor.prototype, globalThis.Symbol.toStringTag,
                        { value: ctor.name, configurable: true });
}

// ── The engine's animations, as the rest of the driver asks for them ────────────────────────
// Installed in a document realm (`installEngineAnimations`); a realm without a style engine — a
// worker, the snapshot's warm-up — has no animation to report.
const NO_ENGINE = {
  animate: () => null, on: () => [], in: () => [], properties: () => null, value: () => null,
  currentlyAnimates: () => false, generation: () => 0
};
let ENGINE = NO_ENGINE;
export function useEngineAnimations(engine) { ENGINE = engine; }

// A generation that moves whenever an animation starts, stops or changes its keyframes — for a memo
// that must not outlive the start of one (layout.js `stackChain`: a script animation of `opacity`
// makes a stacking context the moment it starts, and nothing else moves then).
export function scriptAnimationGeneration() { return ENGINE.generation(); }

// Every property a script animation on `el` touches, or `null`: the gate that keeps an element
// nothing animates from asking anything more (rule 3).
export function scriptAnimatedProperties(el) { return ENGINE.properties(el); }
// …as the layout gates ask it, before deciding a property is absent from the page.
export function scriptAnimationsDeclareProperty(el, prop) { return !!ENGINE.properties(el)?.has(prop); }
export function scriptAnimationsDeclareAnyOf(el, names) {
  const props = ENGINE.properties(el);
  if (props) for (const name of names) if (props.has(name)) return true;
  return false;
}
onScriptAnimationProperties(scriptAnimationsDeclareProperty, scriptAnimationsDeclareAnyOf);

// …and what they report for one property right now, or null where none is in effect (the cascade
// stands).
export function scriptAnimatedValue(el, prop, twin) { return ENGINE.value(el, prop, twin); }

// Whether a script animation on `el` that is CURRENT or IN EFFECT animates any of `props`
// (web-animations, "Side effects of animations"): such an animation makes the element a stacking
// context, as `will-change` would — while it waits out its delay too — and one that has run out, or
// waits to run backwards, makes nothing.
export function scriptAnimationCurrentlyAnimates(el, props) { return ENGINE.currentlyAnimates(el, props); }

// `element.getAnimations()` — this element's (and with `{subtree: true}` its descendants'), in
// composite order.
export function animationsForElement(el, options) { return ENGINE.on(el, !!(options && options.subtree)); }
// `document.getAnimations()` — every animation whose target is in this document.
export function animationsForDocument(doc) { return ENGINE.in(doc); }
// `element.animate(keyframes, options)`: an effect, an animation of it on the document timeline, played.
export function animateElement(el, keyframes, options) { return ENGINE.animate(el, keyframes, options); }
