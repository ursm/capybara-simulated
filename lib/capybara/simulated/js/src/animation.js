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
// The CANONICAL form of an `<easing-function>`, or null when it is not one at all — the engine's (easing.rs). Web
// Animations REJECTS what CSS merely ignores: `element.animate(…, {easing: 'bogus'})` is a TypeError, where a
// stylesheet would drop the declaration and carry on; and the answer doubles as what `getTiming()` reports.
export function canonicalEasing(text) {
  return globalThis.__dom.easingText(String(text));
}
