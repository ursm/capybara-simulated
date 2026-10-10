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
import { CSS_PROPERTY_BY_IDL_ATTRIBUTE, cssPropertyName, isAnimatableProperty, idlAttributeOf } from './css-utils.js';
import {
  convertDocumentTimelineArguments,
  installAnimationTimeline,
  installDocumentTimeline
} from './generated/bindings.js';
import { PLATFORM, constructedBy, makeSlots, registerInterface, slotsOf } from './webidl.js';

// ── Keyframes ────────────────────────────────────────────────────────────────────────────────
// The two forms a page may write, reduced to one list of `{offset, easing, composite, declared}`:
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

// Whether a member NAME is a keyframe property at all, decided without touching its VALUE: the
// spec filters by animatability before reading, and the tests hold implementations to it with
// getters that count their own accesses (`{get animationDelay() { … }}` must never be called).
// A property that cannot be animated is not a keyframe property — it is dropped when the keyframes
// are processed, so `getKeyframes()` never reports it (`{ writingMode: 'vertical-rl' }` produces NO
// keyframes, not one that does nothing) — and a shorthand counts when anything under it animates.
// A MEMBER name is an IDL attribute, so a hyphen belongs to a custom property alone (`font-size`
// is spelled `fontSize` here), and the CSS `float` is spelled `cssFloat` — under its own name it
// is not a member at all (web-animations §Processing a keyframes argument, and the WPT list of
// names that must never even be READ). An alias's attribute names its property where the alias is a
// legacy NAME (`gridColumnGap`, `wordWrap`: Chrome and Firefox both take those), and none where it is a
// vendor-prefixed one (`webkitTransform`, which Chrome ignores — the specification reads a property
// under its own attribute only); a spelling that is no attribute at all (`Opacity`) names nothing.
function isKeyframeMember(member) {
  if (member.startsWith('--')) return true;
  if (member.indexOf('-') >= 0 || member === 'float') return false;
  const prop = cssNameOf(member);
  if (idlNameOf(prop) !== member && (CSS_PROPERTY_BY_IDL_ATTRIBUTE[member] === undefined || /^webkit/i.test(member))) {
    return false;
  }
  return isAnimatableProperty(prop);
}

// A keyframe declaration goes into the frame verbatim, under the name the page wrote — `getKeyframes()` reports a
// `margin` keyframe as `margin`, not as its four sides, and the engine expands it as a declaration — as long as the
// engine parses it: a keyframe is a declaration, parsed like any other, so `{ lineHeight: '-1' }` produces no keyframe
// at all rather than one holding a value no declaration could carry.
function putDeclaration(frame, name, value) {
  const prop = cssNameOf(name);
  const text = String(value);
  if (prop.startsWith('--') || globalThis.__dom.declSupports(prop, text)) frame.declared[prop] = text;
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
    // …and with no value that animates left anywhere, there are no keyframes (where a LIST of keyframes keeps each one
    // it is given, properties or none — Chrome).
    if (!built.some((f) => Object.keys(f.declared).length)) return [];
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
  return frames;
}

// A member that is ABSENT contributes no list; an explicit `null` is a one-entry list, and a
// one-entry list of `null` is what makes `{composite: null}` a TypeError rather than a default.
const asList = (v) => (Array.isArray(v) ? v : (v === undefined ? [] : [v]));
// The three MEMBERS every keyframe may carry, each validated as it is read: Web Animations rejects
// what CSS ignores, and the rejection is a TypeError from the constructor rather than a keyframe
// that quietly does nothing (web-animations §Processing a keyframes argument).
const COMPOSITE_OPERATIONS = new globalThis.Set(['replace', 'add', 'accumulate']);
function frameOffset(offset) {
  if (offset == null) return null;
  // An offset is CSS syntax too, so a `calc()` is one: `offset: 'calc(0.5)'` is a half
  // (Chrome-measured), and a plain string converts as a number would.
  const text = String(offset).trim();
  const n = /^calc\(/i.test(text) ? globalThis.__dom.cssNumber(text) : Number(text);
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
           declared: Object.create(null) }; // as the page wrote them: what `getKeyframes` reports and the engine takes
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
// An effect's timing (EffectTiming), its members in the dictionary's order — what `getTiming()` reports them in.
export const TIMING_DEFAULTS = {
  delay: 0, direction: 'normal', duration: 'auto', easing: 'linear', endDelay: 0, fill: 'auto', iterationStart: 0,
  iterations: 1
};

// The timing `options` give — an (unrestricted double or EffectTiming) the bindings converted: the duration, or the
// members given over the defaults — checked as the spec checks what IDL leaves it (web-animations §6.5.4 "update the
// timing properties"): a negative iterationStart, a NaN or negative iteration count, a duration that is neither a
// non-negative number nor `auto`, and an easing no `<easing-function>` parses are TypeErrors. The easing is kept
// canonical, as `getTiming()` reports it.
export function normalizeTiming(options) {
  const t = Object.assign({}, TIMING_DEFAULTS);
  if (typeof options === 'number') t.duration = options;
  else for (const key of Object.keys(TIMING_DEFAULTS)) if (options[key] !== undefined) t[key] = options[key];
  if (t.iterationStart < 0) throw new globalThis.TypeError(`iterationStart must be non-negative: ${t.iterationStart}`);
  if (Number.isNaN(t.iterations) || t.iterations < 0) throw new globalThis.TypeError(`iterations must be non-negative: ${t.iterations}`);
  // (…a numeric STRING is a string, so `'100'` is not a duration)
  if (typeof t.duration === 'string' ? t.duration !== 'auto' : !(t.duration >= 0)) {
    throw new globalThis.TypeError(`duration must be non-negative or auto: ${t.duration}`);
  }
  const easing = canonicalEasing(t.easing);
  if (easing === null) throw new globalThis.TypeError(`Invalid easing: ${t.easing}`);
  t.easing = easing;
  return t;
}

// web-animations "animation property name to IDL attribute name": the property's CSSOM attribute — `cssFloat` and
// `cssOffset` for the two renamed ones — and a custom property its own name.
export function idlNameOf(prop) {
  if (prop === 'float')  return 'cssFloat';
  if (prop === 'offset') return 'cssOffset';
  return prop.startsWith('--') ? prop : idlAttributeOf(prop);
}


// ── The timeline ─────────────────────────────────────────────────────────────────────────────
// AnimationTimeline and DocumentTimeline (web-animations §4.3), generated from their IDL. A document timeline's current
// time is the driver's own clock — the one the engine runs every animation on, so an `element.animate()` and an
// `@keyframes` on the same page stay in step — less its origin time, a constructor's `originTime` (the default
// timeline's being zero), which the engine takes for each animation on it (`timelineOrigin`). It never ends: its
// duration is null.
const timelineOf = (o) => slotsOf(o, 'AnimationTimeline');
registerInterface('AnimationTimeline', (o) => timelineOf(o) !== undefined);
registerInterface('DocumentTimeline', (o) => slotsOf(o, 'DocumentTimeline') !== undefined);
export class AnimationTimeline {
  constructor(token) {
    constructedBy(PLATFORM, token, 'AnimationTimeline');
  }
}
installAnimationTimeline(AnimationTimeline, {
  get_currentTime: (timeline) => animationNow() - timelineOf(timeline).originTime,
  get_duration: () => null
});
export class DocumentTimeline extends AnimationTimeline {
  constructor() {
    super(PLATFORM);
    const [options] = convertDocumentTimelineArguments(arguments);
    makeSlots(this, 'AnimationTimeline', { originTime: options.originTime });
    makeSlots(this, 'DocumentTimeline');
  }
}
installDocumentTimeline(DocumentTimeline, {});
export const documentTimeline = new DocumentTimeline();
// …and the origin time of `timeline` (any realm's), as the engine takes an animation's: null for none.
export const timelineOrigin = (timeline) => (timeline === null ? null : timelineOf(timeline).originTime);

// ── The engine's animations, as the rest of the driver asks for them ────────────────────────
// Installed in a document realm (`installEngineAnimations`); a realm without a style engine — a
// worker — has no animation to report.
const NO_ENGINE = {
  animate: () => null, on: () => [], in: () => [], value: () => null
};
let ENGINE = NO_ENGINE;
export function useEngineAnimations(engine) {
  ENGINE = engine;
}

// `element.getAnimations()` — this element's (and with `{subtree: true}` its descendants'), in
// composite order.
export function animationsForElement(el, options) { return ENGINE.on(el, !!(options && options.subtree)); }
// `document.getAnimations()` / `shadowRoot.getAnimations()` — every animation whose target is in this tree.
export function animationsForRoot(root) { return ENGINE.in(root); }
// `element.animate(keyframes, options)`: an effect, an animation of it on the options' timeline, played.
export function animateElement(el, keyframes, options) { return ENGINE.animate(el, keyframes, options); }
