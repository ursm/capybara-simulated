// The animation clock, the rendering update that follows it, and the `<easing-function>` grammar.
//
// The animations themselves — CSS animations and transitions, and the ones script starts — are the
// STYLE ENGINE's: it runs them on this clock, and what a property reports while one is in effect is
// its answer (`web-animations-engine.js`). What lives here is what the page-facing side shares
// around that: the timeline's time, the hooks the rendering update runs once the clock has moved,
// and the validation `element.animate()` gives an easing.

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
// (An animated box follows its animation through the engine's restyle, which marks what it restyles: layout.js
// `markRestyles`.) The animation events the update owes (`css-animation-events.js`): the CSS animation and
// transition events and the Web Animations playback events, dispatched as one queue. Registered
// rather than imported: that module reaches this one through the engine, so the edge has to run
// the other way.
let ANIMATION_EVENTS = null;
export function onAnimationEvents(fn) { ANIMATION_EVENTS = fn; }
// …and the font set's: at the rendering update a browser loads the faces its rendered text needs,
// even when no script measured them. Registered rather than imported (platform-globals imports THIS
// module). Gated on a dirty flag inside, so a settled page pays nothing.
let FONT_FLUSH = null;
export function onFontFlush(fn) { FONT_FLUSH = fn; }
export function flushAnimationFrame() {
  if (FONT_FLUSH) FONT_FLUSH();
  if (ANIMATION_EVENTS) ANIMATION_EVENTS();
}

// ── Easing ───────────────────────────────────────────────────────────────────────────────────
// The CANONICAL form of an `<easing-function>`, or null when it is not one at all. Web Animations
// REJECTS what CSS merely ignores: `element.animate(…, {easing: 'bogus'})` is a TypeError, where a
// stylesheet would drop the declaration and carry on. So parsing and validating are the same pass,
// and the answer doubles as what `getTiming()` reports — Chrome-measured throughout:
//
//   'EASE-IN' → 'ease-in'          'step-start' → 'steps(1, start)'   'step-end' → 'steps(1)'
//   'cubic-bezier(0,0,1,1)' → 'cubic-bezier(0, 0, 1, 1)'              'steps(2, start)' unchanged
//   an x outside [0,1], a non-integer or non-positive step count, `steps(1, jump-none)`,
//   an empty string, a CSS-wide keyword and a trailing token are each a TypeError.
//
// An IDENTIFIER may be escaped, since this is CSS syntax carried in a string: `Ease\2d in-out` is
// `ease-in-out` (the hex escape ends at the space, which is consumed with it).
//
// It is not the style engine's parse (style.rs `easing`, which the timing runs on): a page's numbers keep their double
// precision here, as Chrome reports them (`cubic-bezier(0, 0.43333333333333335, …)`, measured), where CSS's numbers
// are f32 — the canonical text, handed on, would lose what the page wrote.
const EASING_KEYWORDS = {
  __proto__: null,
  linear: 'linear', ease: 'ease', 'ease-in': 'ease-in', 'ease-out': 'ease-out',
  'ease-in-out': 'ease-in-out', 'step-start': 'steps(1, start)', 'step-end': 'steps(1)'
};
const STEP_POSITIONS = new globalThis.Set(['jump-start', 'jump-end', 'jump-none', 'jump-both', 'start', 'end']);
function unescapeIdent(text) {
  return text.replace(/\\([0-9a-fA-F]{1,6})[ \t\n]?|\\(.)/g,
                      (_, hex, ch) => (hex ? String.fromCodePoint(parseInt(hex, 16)) : ch));
}
const numberList = (text) => text.split(',').map((t) => t.trim());
// CSS `<number>` and `<integer>` grammar — `Number()` is not it: it takes `0x1`, `Infinity` and the
// empty string, none of which a stylesheet parser would (Chrome-measured: `cubic-bezier(0x1,0,1,1)`
// and `steps(2.0)` are both TypeErrors).
const CSS_NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const CSS_INTEGER = /^[+-]?\d+$/;

// The stops of a `linear()` easing (css-easing-2), as `{v, p}` pairs with every position filled in
// — or null when the list is not one. Each stop is a number with up to TWO positions, and a stop
// written with two is two stops (`linear(0 0% 50%, 1)` is `linear(0 0%, 0 50%, 1 100%)`). The
// first position defaults to 0% and the last to 100%; a gap is spaced evenly between the two known
// positions around it; and a position never goes backwards — it takes the largest seen so far
// (Chrome-measured: `linear(1 100%, 0 0%)` reports `linear(1 100%, 0 100%)`).
function linearStops(args) {
  const stops = [];
  for (const part of numberList(args)) {
    const toks = part.split(/\s+/).filter(Boolean);
    if (!toks.length) return null;
    if (!CSS_NUMBER.test(toks[0])) return null;
    const v = Number(toks[0]);
    const positions = toks.slice(1);
    if (positions.length > 2) return null;
    if (!positions.length) { stops.push({ v, p: null }); continue; }
    for (const token of positions) {
      const m = /^([+-]?(?:\d+\.?\d*|\.\d+))%$/.exec(token);
      if (!m) return null;
      stops.push({ v, p: parseFloat(m[1]) });
    }
  }
  if (stops.length < 2) return null;
  if (stops[0].p == null) stops[0].p = 0;
  if (stops[stops.length - 1].p == null) stops[stops.length - 1].p = 100;
  let largest = stops[0].p;
  for (const stop of stops) {
    if (stop.p == null) continue;
    stop.p = Math.max(stop.p, largest);
    largest = stop.p;
  }
  for (let i = 0; i < stops.length; i++) {
    if (stops[i].p != null) continue;
    let end = i;
    while (stops[end].p == null) end++;
    const from = stops[i - 1].p, to = stops[end].p, span = end - (i - 1);
    for (let k = i; k < end; k++) stops[k].p = from + (to - from) * ((k - (i - 1)) / span);
  }
  return stops;
}
const easingNumber = (n) => String(Math.round(n * 1e6) / 1e6);

// A page builds its keyframes from a handful of literal easings, and each one is parsed twice —
// once to validate and canonicalise, once to build the function. Content-addressed on the input
// text, so nothing can go stale, and bounded (measured: parsing was 24% of `el.animate()` with an
// easing, and this puts it back where it was).
const CANONICAL_EASINGS = new globalThis.Map();
const CANONICAL_EASINGS_MAX = 512;
export function canonicalEasing(text) {
  const key = typeof text === 'string' ? text : null;
  if (key !== null) {
    const hit = CANONICAL_EASINGS.get(key);
    if (hit !== undefined) return hit;
  }
  const out = parseEasing(text);
  if (key !== null) {
    if (CANONICAL_EASINGS.size >= CANONICAL_EASINGS_MAX) CANONICAL_EASINGS.clear();
    CANONICAL_EASINGS.set(key, out);
  }
  return out;
}
function parseEasing(text) {
  // A comment is a token SEPARATOR the tokenizer discards, so `ease /**/` is `ease` (WPT
  // gEasingParsingTests measures exactly that).
  const raw = String(text == null ? '' : text).replace(/\/\*[\s\S]*?\*\//g, ' ').trim();
  if (!raw) return null;
  const fn = /^([a-zA-Z-]+)\(([\s\S]*)\)$/.exec(raw);
  if (!fn) {
    const name = unescapeIdent(raw).toLowerCase();
    return EASING_KEYWORDS[name] || null;
  }
  const name = fn[1].toLowerCase(), args = fn[2].trim();
  if (name === 'cubic-bezier') {
    const parts = numberList(args);
    if (parts.length !== 4 || !parts.every((t) => CSS_NUMBER.test(t))) return null;
    const n = parts.map(Number);
    // The two X coordinates are progress values, and a control point outside [0,1] is not one.
    if (n[0] < 0 || n[0] > 1 || n[2] < 0 || n[2] > 1) return null;
    return `cubic-bezier(${n.join(', ')})`;
  }
  if (name === 'linear') {
    const stops = linearStops(args);
    return stops && `linear(${stops.map((s) => `${easingNumber(s.v)} ${easingNumber(s.p)}%`).join(', ')})`;
  }
  if (name === 'steps') {
    const parts = numberList(args);
    if (parts.length > 2) return null;
    if (!CSS_INTEGER.test(parts[0])) return null;
    const count = Number(parts[0]);
    if (count < 1) return null;
    const position = parts.length === 2 ? parts[1].toLowerCase() : 'end';
    if (!STEP_POSITIONS.has(position)) return null;
    // …and `jump-none` needs two stops to jump between, so one step is not enough.
    if (position === 'jump-none' && count < 2) return null;
    // The default position is not reported back (Chrome: `steps(2, end)` reads as `steps(2)`).
    return position === 'end' ? `steps(${count})` : `steps(${count}, ${position})`;
  }
  return null;
}
