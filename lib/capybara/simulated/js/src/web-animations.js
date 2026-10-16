// The Web Animations API's page-facing half — what `element.animate()`, `getAnimations()` and the
// constructors take as arguments, and where they go.
//
// The animations themselves are the STYLE ENGINE's (`web-animations-engine.js`): its `Animation`,
// `KeyframeEffect`, `CSSAnimation` and `CSSTransition` are handles on what it runs, on the same
// clock and in the same composite order as the CSS animations and transitions it runs beside them.
// What lives here is what every one of them shares — a keyframes argument read for the engine to process (keyframes.rs),
// a timing dictionary validated (web-animations §Processing a keyframes argument, §The EffectTiming dictionaries) —
// and the document timeline, plus the forwarders the cascade, the
// layout and the DOM ask the engine through. Registered rather than imported (`useEngineAnimations`):
// the engine imports THIS module for the processing, so the edge has to run the other way.
import { animationNow } from './animation.js';
import { CSS_PROPERTY_BY_IDL_ATTRIBUTE, cssPropertyName, isAnimatableProperty, idlAttributeOf } from './css-utils.js';
import {
  convertDocumentTimelineArguments,
  installAnimationTimeline,
  installDocumentTimeline
} from './generated/bindings.js';
import { PLATFORM, constructedBy, makeSlots, registerInterface, slotsOf } from './webidl.js';

// ── Keyframes ────────────────────────────────────────────────────────────────────────────────
// The two forms a page may write, read for the engine, which processes them (keyframes.rs: validated, sorted, spaced,
// merged by offset, each declaration parsed):
//
//   object form   { blockSize: ['0px', '100px'], easing: 'linear' }
//   array form    [{ blockSize: '0px' }, { blockSize: '100px', easing: 'ease' }]
//
// The reading is the bindings' — the order a page observes through its getters (web-animations §Processing a
// keyframes argument, and the WPT tests that count their getter calls). The property names are IDL attributes, so
// `blockSize` is `block-size` and the two renamed ones — `cssOffset`, `cssFloat` — go back to the CSS names they had
// to be renamed away from.
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

// The members a keyframe-like object contributes, in ASCENDING codepoint order of the property
// name they map to — the order a page can observe through its own getters (web-animations
// §Processing a keyframe-like object step 2).
function keyframeMembers(raw) {
  return Object.keys(raw).filter((key) => !RESERVED.has(key) && isKeyframeMember(key))
                         .sort((a, b) => (a < b ? -1 : 1));
}

// The keyframes argument as the engine takes it: [0, count, then per keyframe: offset, easing, composite, declaration
// count, (property, value)…] for a list of keyframes — [1, then the offset, easing and composite lists, each its count
// and entries, then the property count and per property: its name, value count, values…] for a property-indexed one —
// each member converted as it is read: an offset a number (a `calc()` one the engine's) or null, an easing a string or,
// absent, null, a composite one of its enumeration's or null; a property under its CSS name, its values strings.
export function readKeyframes(input) {
  if (input == null) return [0, 0];
  const iterable = typeof input[globalThis.Symbol.iterator] === 'function' && typeof input !== 'string';
  if (iterable) {
    // Each keyframe converted as it is read (a BaseKeyframe: `composite`, `easing`, `offset`, in the dictionary's
    // order), then its properties by ascending codepoint — the list's validity the engine's to say once all are read.
    const out = [0, 0];
    for (const raw of input) {
      const k = raw == null ? {} : raw;
      const composite = compositeText(k.composite), easing = memberText(k.easing), offset = offsetNumber(k.offset);
      const declared = keyframeMembers(k).map((key) => [cssNameOf(key), String(k[key])]);
      out.push(offset, easing, composite, declared.length);
      for (const [name, value] of declared) out.push(name, value);
      out[1]++;
    }
    return out;
  }
  // Object form (a BasePropertyIndexedKeyframe): its `composite`, `easing` and `offset` — each a value or a list of
  // them — converted as read, then every property (ONCE — a member is a getter a page can count the calls to), whose
  // list the engine spreads over the whole effect on its own.
  const composites = asList(input.composite).map(compositeText);
  const easings = asList(input.easing).map(memberText);
  const offsets = asList(input.offset).map(offsetNumber);
  const values = keyframeMembers(input).map((key) => {
    const read = input[key];
    return [cssNameOf(key), (Array.isArray(read) ? read : [read]).map(String)];
  });
  const out = [1, offsets.length, ...offsets, easings.length, ...easings, composites.length, ...composites, values.length];
  for (const [name, list] of values) out.push(name, list.length, ...list);
  return out;
}

// A member that is ABSENT contributes no list; an explicit `null` is a one-entry list, and a
// one-entry list of `null` is what makes `{composite: null}` a TypeError rather than a default.
const asList = (v) => (Array.isArray(v) ? v : (v === undefined ? [] : [v]));
// An offset as a number — CSS syntax too, so a `calc()` is one (`offset: 'calc(0.5)'` is a half, Chrome-measured), and
// a plain string converts as a number would — or null for none; the engine refuses one outside [0, 1].
function offsetNumber(offset) {
  if (offset == null) return null;
  const text = String(offset).trim();
  return /^calc\(/i.test(text) ? globalThis.__dom.cssNumber(text) : Number(text);
}
// An easing as a string, or null where it is absent — an explicit `null` is a value (`{easing: null}` is a TypeError,
// Chrome-measured)…
const memberText = (value) => (value === undefined ? null : String(value));
// …and a composite, a CompositeOperationOrAuto: one that is none a TypeError as it is converted (WebIDL enumeration).
const COMPOSITES = new globalThis.Set(['replace', 'add', 'accumulate', 'auto']);
function compositeText(value) {
  if (value === undefined) return null;
  const text = String(value);
  if (!COMPOSITES.has(text)) {
    throw new globalThis.TypeError(`The provided value '${text}' is not a valid enum value of type CompositeOperationOrAuto.`);
  }
  return text;
}

// ── Timing ───────────────────────────────────────────────────────────────────────────────────
// An effect's timing (EffectTiming), its members in the dictionary's order — what `getTiming()` reports them in.
export const TIMING_DEFAULTS = {
  delay: 0, direction: 'normal', duration: 'auto', easing: 'linear', endDelay: 0, fill: 'auto', iterationStart: 0,
  iterations: 1
};

// The timing `options` give — an (unrestricted double or EffectTiming) the bindings converted: the duration, or the
// members given over the defaults — as the engine takes it, which checks it (animation_ops.rs `timing_arg`):
// [delay, endDelay, fill, iterationStart, iterations, duration, direction, easing].
export function readTiming(options) {
  const t = Object.assign({}, TIMING_DEFAULTS);
  if (typeof options === 'number') t.duration = options;
  else for (const key of Object.keys(TIMING_DEFAULTS)) if (options[key] !== undefined) t[key] = options[key];
  return [t.delay, t.endDelay, t.fill, t.iterationStart, t.iterations, t.duration, t.direction, t.easing];
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
const NO_ENGINE = { animate: () => null, on: () => [], in: () => [] };
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
