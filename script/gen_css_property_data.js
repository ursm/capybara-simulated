#!/usr/bin/env node
// Regenerate lib/capybara/simulated/js/src/css-property-data.js from mdn-data (the
// property database css-tree already vendors). Emits NAMES ONLY — the longhand set and
// each shorthand's sub-longhands — which the CSSOM `all`-shorthand model and generic
// shorthand serialization need. mdn-data ships transitively via css-tree, so regenerate
// when css-tree (or its bundled mdn-data) is bumped:
//   pnpm run gen:css-property-data      (== node script/gen_css_property_data.js)
//
// mdn-data marks a shorthand by giving `computed` an ARRAY of longhand names; a longhand's
// `computed` is a string. Vendor-prefixed (`-…`) and custom (`--…`) properties are dropped.

const fs = require('fs');
const path = require('path');

const mdnPath = require.resolve('mdn-data/css/properties.json', { paths: [require.resolve('css-tree')] });
const props = JSON.parse(fs.readFileSync(mdnPath, 'utf8'));

const longhands = [];
const shorthands = {};
const vendor = [];                                    // `-webkit-…` / `-moz-…` / `-ms-…` names
for (const name of Object.keys(props).sort()) {
  if (name.startsWith('--')) continue;                // custom-property placeholder
  if (name.startsWith('-')) { vendor.push(name); continue; }   // vendor-prefixed
  const computed = props[name].computed;
  if (Array.isArray(computed)) shorthands[name] = computed.filter((c) => !c.startsWith('-'));
  else longhands.push(name);
}

// Every property name the CSSOM treats as a "supported CSS property": the standard longhands
// and shorthands plus the vendor-prefixed aliases. A named-property write (`style.X = v`) or a
// `setProperty('X', v)` whose name isn't in this set (and isn't a `--custom` property) is NOT a
// CSS declaration — the accessor becomes a plain expando, `setProperty` a no-op — matching how
// browsers reject `style.COLOR` (folds to `-c-o-l-o-r`) or `style.unknown`.
const supported = [...longhands, ...Object.keys(shorthands), ...vendor].sort();

// A CONSERVATIVE value-type classification, for rejecting invalid declaration values (CSSOM
// "set a CSS declaration" ignores a value that doesn't parse for the property). We classify a
// longhand when its mdn syntax reduces to a single validatable base type — `<color>`, `<integer>`,
// `<number>`, or a length/percentage — plus bare keyword alternatives; the runtime validator checks
// these cheaply (culori for colour, regexes for the numerics) without over-rejecting. A `[min,∞]`
// range annotation (`<length-percentage [0,∞]>`) is captured as `min`, so a negative value is
// rejected (`width: -100px`). FUNCTIONAL alternatives (`fit-content(…)`, `<calc-size()>`,
// `<anchor-size()>`) are IGNORED here — the runtime accepts any value containing `(` unchecked — so
// they don't block classification. Any OTHER non-functional type (`<image>`, `<opacity-value>`, …)
// leaves the property unclassified and accepted unchecked, so we never drop a valid value.
// `{base, keywords, min?}`.
const TYPE_BASE = {
  'color': 'color', 'integer': 'integer', 'number': 'number',
  'length': 'length', 'percentage': 'length', 'length-percentage': 'length',
};
function parseRangeBound(bound) {
  const s = bound.trim();
  if (s.indexOf('∞') !== -1) return s[0] === '-' ? -Infinity : Infinity;   // ∞ / -∞
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}
// mdn writes a LOGICAL property's grammar as a reference to the physical one it mirrors
// (`padding-block-start` is `<'padding-top'>`, `block-size` is `<'width'>`), and several properties
// take the same value one to N times (`border-block-color` is `<'border-top-color'>{1,2}`). Both
// shapes fell through the alternation loop below and left the property UNCLASSIFIED — which is to
// say unvalidated, so `block-size: none` and `padding-block-start: -10px` were kept where every
// browser drops them. 52 of the 471 longhands are a pure reference, and all of them are logical.
// Do the leading `[` and trailing `]` close each other, rather than being two separate groups?
function bracketsWrapWhole(src) {
  let depth = 0;
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '[') depth++;
    else if (src[i] === ']' && --depth === 0) return i === src.length - 1;
  }
  return false;
}

function classifyValueType(syntax, depth = 0) {
  if (!syntax || depth > 4) return null;
  let src = String(syntax).trim();
  let repeat = 1;
  // A multiplier over the WHOLE grammar — `<'border-top-color'>{1,2}`, `[ a | b ]{1,4}`. Anything
  // else (`&&`, `+`, `#`, a lone `?`) is left to fall through and bail below.
  const mult = /^(.*?)\{\s*1\s*,\s*(\d+)\s*\}$/.exec(src);
  if (mult) { src = mult[1].trim(); repeat = Number(mult[2]); }
  // …and the brackets a multiplied alternation is wrapped in — only when they are the OUTERMOST
  // pair. `[ pack | next ] || [ definite-first | ordered ]` starts and ends with a bracket without
  // being one group, and stripping those left a fragment the alternation loop below reads as
  // garbage. It bails on that today, so this is a guard rather than a fix.
  if (src.startsWith('[') && src.endsWith(']') && bracketsWrapWhole(src)) src = src.slice(1, -1).trim();
  const ref = /^<'([-a-z]+)'>$/.exec(src);
  if (ref) {
    const target = props[ref[1]];
    const t = target ? classifyValueType(target.syntax, depth + 1) : null;
    if (!t) return null;
    const n = repeat * (t.repeat || 1);
    return n > 1 ? { ...t, repeat: n } : t;
  }
  let base = null, min = null, max = null;
  const keywords = [];
  for (const raw of src.split('|')) {
    const part = raw.trim();
    if (part.indexOf('(') !== -1) continue;                // functional alternative — runtime accepts, skip
    // A type reference with an optional numeric range: `<name>` / `<name [min,max]>`.
    const m = /^<([a-z-]+)(?:\s*\[\s*([^,\]]+)\s*,\s*([^\]]*)\])?>$/.exec(part);
    if (m) {
      const t = TYPE_BASE[m[1]];
      if (!t) return null;                                 // an unknown type — can't validate
      if (base && base !== t) return null;                 // mixed base types
      base = t;
      if (m[2] != null) {
        const lo = parseRangeBound(m[2]);
        if (lo != null && Number.isFinite(lo)) min = (min == null) ? lo : Math.min(min, lo);
        const hi = m[3] == null ? null : parseRangeBound(m[3]);
        if (hi != null && Number.isFinite(hi)) max = (max == null) ? hi : Math.max(max, hi);
      }
    } else if (/^[a-z][a-z-]*$/i.test(part)) {
      keywords.push(part.toLowerCase());                   // a bare keyword alternative
    } else {
      return null;                                         // a richer non-functional alternative — bail
    }
  }
  if (!base) return null;
  // A `<color>` property with keyword alternatives (`outline-color: auto | <color>`) is NOT
  // classified: mdn-data omits legacy colour keywords (outline-color also accepts `invert`), so
  // validating one risks rejecting a valid value. Pure `<color>` props (color / background-color /
  // border-*-color) have the complete `<color>` grammar and are safe. The numeric bases carry no
  // such legacy-keyword-omission risk, so their keyword alternatives (`z-index: auto`, `width:
  // min-content`) stay classified.
  if (base === 'color' && keywords.length > 0) return null;
  const out = { base, keywords };
  if (min != null) out.min = min;
  if (max != null) out.max = max;
  // How many space-separated values the grammar takes: `border-block-width: 1px 2px` is valid where
  // `block-size: 1px 2px` is not, and the validator needs to tell them apart.
  if (repeat > 1) out.repeat = repeat;
  return out;
}
const valueTypes = {};
for (const name of longhands) {
  const t = classifyValueType(props[name].syntax);
  if (t) valueTypes[name] = t;
}

// The numeric LOWER BOUND each property's grammar imposes, gathered from the ranges
// `classifyValueType` read out of mdn's syntax and topped up with the ones mdn doesn't record.
// This is separate from the value-type map above because it answers a different question: that one
// decides whether a DECLARATION is valid, this one clamps an INTERPOLATION that extrapolates past
// the property's range (an animation seeking below a `flex-grow` of 0 reports 0, not a negative
// number). A property mdn leaves unclassified — `flex-basis`, whose grammar it writes as a
// reference to `<'width'>` — still has a bound its own spec is explicit about.
const MIN_FIXES = {
  'flex-grow':   0,     // css-flexbox §7.1.1: <number [0,∞]>
  'flex-shrink': 0,     // css-flexbox §7.1.2: <number [0,∞]>
  'flex-basis':  0,     // css-flexbox §7.1.3: <'width'>, i.e. <length-percentage [0,∞]>
  // …and the opacities, which mdn records as `<'opacity'>` / `<opacity-value>` with no range at
  // all. `opacity` itself is clamped by its own computed-value reader; these three have nobody.
  'stop-opacity':          0,
  'fill-opacity':          0,
  'stroke-opacity':        0,
  'shape-image-threshold': 0,
  // …and the two `numberOrLength` properties, whose grammar writes the bound on each branch
  // (`line-height: normal | <number [0,∞]> | <length-percentage [0,∞]>`) rather than on the value
  // as a whole, so `classifyValueType` — which classifies the UNION — never sees it. A negative end
  // is not a value either property takes: an interpolation that reaches one clamps, and one
  // DECLARED that way is dropped whole (Chrome-measured, `line-height: -1` to `2` reports `2` for
  // the entire transition).
  'line-height': 0,
  'tab-size':    0
};
// The longhands whose grammar admits NO NEGATIVE value, so a negative one is a parse error and the
// whole declaration is dropped — `padding-left: -1px` and `line-height: -1` leave the earlier
// declaration (or the initial) in place, they do not clamp. This cannot be derived for most of
// them: mdn records the bound for about a third (`width`, `padding-*`, the radii — those also carry
// `min: 0` in PROPERTY_VALUE_TYPES, and the assertion below keeps the two facts agreeing) and for
// none of the rest (`line-height: normal | <number> | <length> | <percentage>`, `outline-width:
// <line-width>`). So the list is MEASURED, by `script/measure_css_value_ranges.mjs`, which
// reproduces all three arrays below and names the properties it skipped — every longhand mdn knows,
// offered
// `-1px` / `-1` / `-1%` / `-1s` and then the same four positive, keeping the ones Chrome 151
// rejects in every form it otherwise accepts, among the ones it IMPLEMENTS — a property Chrome
// does not support rejects every value including its own keywords, which is a different fact, so
// the census asks `CSS.supports(prop, 'inherit')` first and leaves the other 44 alone (this
// driver's own initial value for `box-flex` has to survive its own validator). Not one property
// took a negative in some units and refused it in others.
//
// This is deliberately NOT `PROPERTY_MIN`: an opacity's bound is a CLAMP (`opacity: -1` is kept and
// reports 0), and the two facts must not be confused. A property can be in both.
const NEGATIVE_INVALID = [
  'animation-duration', 'animation-iteration-count', 'aspect-ratio', 'background-size',
  'block-size', 'border-block-end-width', 'border-block-start-width', 'border-block-width',
  'border-bottom-left-radius', 'border-bottom-right-radius', 'border-bottom-width',
  'border-end-end-radius', 'border-end-start-radius', 'border-image-outset',
  'border-image-slice', 'border-image-width', 'border-inline-end-width',
  'border-inline-start-width', 'border-inline-width', 'border-left-width', 'border-right-width',
  'border-spacing', 'border-start-end-radius', 'border-start-start-radius',
  'border-top-left-radius', 'border-top-right-radius', 'border-top-width', 'column-count',
  'column-gap', 'column-height', 'column-rule-width', 'column-width',
  'contain-intrinsic-block-size', 'contain-intrinsic-height', 'contain-intrinsic-inline-size',
  'contain-intrinsic-width', 'flex-basis', 'flex-grow', 'flex-shrink', 'font-size',
  'font-size-adjust', 'font-stretch', 'font-weight', 'grid-auto-columns', 'grid-auto-rows',
  'grid-column-gap', 'grid-row-gap', 'grid-template-columns', 'grid-template-rows', 'height',
  'hyphenate-limit-chars', 'initial-letter', 'inline-size', 'interest-delay-end',
  'interest-delay-start', 'line-height', 'mask-size', 'max-block-size', 'max-height',
  'max-inline-size', 'max-width', 'min-block-size', 'min-height', 'min-inline-size',
  'min-width', 'orphans', 'outline-width', 'overflow-clip-margin', 'padding-block-end',
  'padding-block-start', 'padding-bottom', 'padding-inline-end', 'padding-inline-start',
  'padding-left', 'padding-right', 'padding-top', 'perspective', 'r', 'row-gap', 'rx', 'ry',
  'scroll-padding-block-end', 'scroll-padding-block-start', 'scroll-padding-bottom',
  'scroll-padding-inline-end', 'scroll-padding-inline-start', 'scroll-padding-left',
  'scroll-padding-right', 'scroll-padding-top', 'shape-margin', 'stroke-dasharray',
  'stroke-miterlimit', 'stroke-width', 'tab-size', 'text-size-adjust', 'transition-duration',
  'widows', 'width', 'zoom'
];

// …and the ones that take no UNITLESS NUMBER at all, where CSS's "a zero needs no unit" intuition
// is wrong: a `<time>` or an `<angle>` is never bare, so `transition-duration: 0`,
// `animation-delay: 2` and `rotate: 1` are dropped whole (Chrome-measured, the same census as
// above with `0` / `1px` / `1s` / `1deg`; `overflow-clip-margin` is in the list on Chrome's say-so
// even though its grammar reads like a length). The check is per comma ENTRY — `transition-duration:
// 1s, 0` is dropped too — and only for an entry that is ONE bare number, so `rotate: 1 0 0 45deg`,
// whose axis really is unitless, still parses.
const UNITLESS_NUMBER_INVALID = [
  'animation-delay', 'animation-duration', 'interest-delay-end', 'interest-delay-start',
  'offset-rotate', 'overflow-clip-margin', 'rotate', 'transition-delay', 'transition-duration'
];

// …and the ones that take NO NUMBER AT ALL: a keyword-only grammar (`align-items`,
// `background-clip`), a colour (`accent-color` — its numbers live inside `rgb()`), an identifier
// (`animation-name`). Every numeric form the census offered — `1px` `1` `1%` `1s` `1deg` `0` and
// their negatives — is dropped by Chrome for these 303 longhands, where this driver kept all of
// them (`align-items: -1px` was a declaration here). Only the properties Chrome IMPLEMENTS, for the
// reason given above — which is why this is 259 of the 471 rather than the 303 the raw census says.
//
// Derived by MEASUREMENT rather than from the grammar for the same reason as the tables above, and
// applied only to an entry that is ONE numeric token: `font-variation-settings: "wght" 400` carries
// a bare number legitimately, and a number inside a function (`rgb(1, 2, 3)`) is not a top-level
// token at all.
const NUMERIC_INVALID = [
  'accent-color', 'align-content', 'align-items', 'align-self', 'alignment-baseline', 'all',
  'anchor-name', 'anchor-scope', 'animation-composition', 'animation-direction',
  'animation-fill-mode', 'animation-name', 'animation-play-state', 'animation-timeline',
  'animation-timing-function', 'animation-trigger', 'appearance', 'backdrop-filter',
  'backface-visibility', 'background-attachment', 'background-blend-mode', 'background-clip',
  'background-color', 'background-image', 'background-origin', 'background-repeat',
  'baseline-source', 'border-block-color', 'border-block-end-color', 'border-block-end-style',
  'border-block-start-color', 'border-block-start-style', 'border-block-style',
  'border-bottom-color', 'border-bottom-style', 'border-collapse', 'border-image-repeat',
  'border-image-source', 'border-inline-color', 'border-inline-end-color',
  'border-inline-end-style', 'border-inline-start-color', 'border-inline-start-style',
  'border-inline-style', 'border-left-color', 'border-left-style', 'border-right-color',
  'border-right-style', 'border-top-color', 'border-top-style', 'box-decoration-break',
  'box-shadow', 'box-sizing', 'break-after', 'break-before', 'break-inside', 'caption-side',
  'caret-animation', 'caret-color', 'caret-shape', 'clear', 'clip', 'clip-path', 'clip-rule',
  'color', 'color-interpolation-filters', 'color-scheme', 'column-fill', 'column-rule-color',
  'column-rule-style', 'column-span', 'column-wrap', 'contain', 'container-name',
  'container-type', 'content', 'content-visibility', 'corner-bottom-left-shape',
  'corner-bottom-right-shape', 'corner-end-end-shape', 'corner-end-start-shape',
  'corner-start-end-shape', 'corner-start-start-shape', 'corner-top-left-shape',
  'corner-top-right-shape', 'counter-increment', 'counter-reset', 'counter-set', 'cursor', 'd',
  'direction', 'display', 'dominant-baseline', 'dynamic-range-limit', 'empty-cells',
  'field-sizing', 'fill', 'fill-rule', 'filter', 'flex-direction', 'flex-wrap', 'float',
  'flood-color', 'font-family', 'font-feature-settings', 'font-kerning',
  'font-language-override', 'font-optical-sizing', 'font-palette', 'font-style',
  'font-synthesis', 'font-synthesis-small-caps', 'font-synthesis-style',
  'font-synthesis-weight', 'font-variant', 'font-variant-alternates', 'font-variant-caps',
  'font-variant-east-asian', 'font-variant-emoji', 'font-variant-ligatures',
  'font-variant-numeric', 'font-variant-position', 'font-variation-settings',
  'forced-color-adjust', 'grid-auto-flow', 'grid-template-areas', 'hyphenate-character',
  'hyphens', 'image-orientation', 'image-rendering', 'interactivity', 'interpolate-size',
  'isolation', 'justify-content', 'justify-items', 'justify-self', 'lighting-color',
  'line-break', 'list-style-image', 'list-style-position', 'list-style-type', 'marker',
  'marker-end', 'marker-mid', 'marker-start', 'mask-clip', 'mask-composite', 'mask-image',
  'mask-mode', 'mask-origin', 'mask-repeat', 'mask-type', 'math-shift', 'math-style',
  'mix-blend-mode', 'object-fit', 'object-view-box', 'offset-path', 'outline-color',
  'outline-style', 'overflow-anchor', 'overflow-block', 'overflow-inline', 'overflow-wrap',
  'overflow-x', 'overflow-y', 'overlay', 'overscroll-behavior-block',
  'overscroll-behavior-inline', 'overscroll-behavior-x', 'overscroll-behavior-y', 'page',
  'page-break-after', 'page-break-before', 'page-break-inside', 'paint-order', 'pointer-events',
  'position', 'position-anchor', 'position-area', 'position-try-fallbacks',
  'position-try-order', 'position-visibility', 'print-color-adjust', 'quotes', 'reading-flow',
  'resize', 'ruby-align', 'ruby-overhang', 'ruby-position', 'scroll-behavior',
  'scroll-initial-target', 'scroll-marker-group', 'scroll-snap-align', 'scroll-snap-stop',
  'scroll-snap-type', 'scroll-target-group', 'scroll-timeline-axis', 'scroll-timeline-name',
  'scrollbar-color', 'scrollbar-gutter', 'scrollbar-width', 'shape-outside', 'shape-rendering',
  'stop-color', 'stroke', 'stroke-linecap', 'stroke-linejoin', 'table-layout', 'text-align',
  'text-align-last', 'text-anchor', 'text-autospace', 'text-box', 'text-box-edge',
  'text-box-trim', 'text-combine-upright', 'text-decoration-color', 'text-decoration-line',
  'text-decoration-skip-ink', 'text-decoration-style', 'text-emphasis-color',
  'text-emphasis-position', 'text-emphasis-style', 'text-justify', 'text-orientation',
  'text-overflow', 'text-rendering', 'text-shadow', 'text-spacing-trim', 'text-transform',
  'text-underline-position', 'text-wrap-mode', 'text-wrap-style', 'timeline-scope',
  'timeline-trigger-name', 'timeline-trigger-source', 'touch-action', 'transform',
  'transform-box', 'transform-style', 'transition-behavior', 'transition-property',
  'transition-timing-function', 'trigger-scope', 'unicode-bidi', 'user-select', 'vector-effect',
  'view-timeline-axis', 'view-timeline-name', 'view-transition-class', 'view-transition-name',
  'visibility', 'white-space', 'white-space-collapse', 'will-change', 'word-break', 'word-wrap',
  'writing-mode'
];

// SVG's geometry properties measure in USER UNITS, so a bare number is a length for them where it
// is a parse error everywhere else (Chrome-measured: `x: 1` and `baseline-shift: 1` are kept, while
// `width: 1` is not). Recorded on the value type, which is where the length check reads it.
const UNITLESS_LENGTH = ['baseline-shift', 'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y'];
for (const name of UNITLESS_LENGTH) if (valueTypes[name]) valueTypes[name].unitless = true;

// The measured tables and mdn's own bounds describe the same properties from two directions, so
// where both speak they must agree. A mismatch means one of them moved — a re-measured census, or
// an mdn release that filled a range in — and the build stops rather than shipping two answers.
for (const name of NEGATIVE_INVALID) {
  const t = valueTypes[name];
  if (t && t.min != null && t.min !== 0) {
    throw new Error(`${name}: measured as taking no negative, but mdn gives it a minimum of ${t.min}`);
  }
}
for (const name of NUMERIC_INVALID) {
  const t = valueTypes[name];
  if (t && t.base !== 'color') {
    throw new Error(`${name}: measured as taking no number, but mdn's grammar classifies it as ${t.base}`);
  }
}

// The longhands where a bare `0` is a LENGTH, and reports as `0px`. `padding-left: 0` reads back
// as `0px` and `opacity: 0` as `0`, and which of the two a property is cannot be read off mdn's
// grammar for most of them — so this is measured with the others, by
// `script/measure_css_value_ranges.mjs`.
const ZERO_IS_LENGTH = [
  'animation-range-end', 'animation-range-start', 'background-position-x',
  'background-position-y', 'background-size', 'block-size', 'border-block-end-width',
  'border-block-start-width', 'border-block-width', 'border-bottom-left-radius',
  'border-bottom-right-radius', 'border-bottom-width', 'border-end-end-radius',
  'border-end-start-radius', 'border-inline-end-width', 'border-inline-start-width',
  'border-inline-width', 'border-left-width', 'border-right-width', 'border-spacing',
  'border-start-end-radius', 'border-start-start-radius', 'border-top-left-radius',
  'border-top-right-radius', 'border-top-width', 'bottom', 'column-gap', 'column-height',
  'column-rule-width', 'column-width', 'contain-intrinsic-block-size',
  'contain-intrinsic-height', 'contain-intrinsic-inline-size', 'contain-intrinsic-width', 'cx',
  'cy', 'flex-basis', 'font-size', 'grid-auto-columns', 'grid-auto-rows', 'grid-column-gap',
  'grid-row-gap', 'grid-template-columns', 'grid-template-rows', 'height', 'inline-size',
  'inset-block-end', 'inset-block-start', 'inset-inline-end', 'inset-inline-start', 'left',
  'letter-spacing', 'margin-block-end', 'margin-block-start', 'margin-bottom',
  'margin-inline-end', 'margin-inline-start', 'margin-left', 'margin-right', 'margin-top',
  'mask-size', 'max-block-size', 'max-height', 'max-inline-size', 'max-width', 'min-block-size',
  'min-height', 'min-inline-size', 'min-width', 'offset-distance', 'outline-offset',
  'outline-width', 'padding-block-end', 'padding-block-start', 'padding-bottom',
  'padding-inline-end', 'padding-inline-start', 'padding-left', 'padding-right', 'padding-top',
  'perspective', 'r', 'right', 'row-gap', 'rx', 'ry', 'scroll-margin-block-end',
  'scroll-margin-block-start', 'scroll-margin-bottom', 'scroll-margin-inline-end',
  'scroll-margin-inline-start', 'scroll-margin-left', 'scroll-margin-right',
  'scroll-margin-top', 'scroll-padding-block-end', 'scroll-padding-block-start',
  'scroll-padding-bottom', 'scroll-padding-inline-end', 'scroll-padding-inline-start',
  'scroll-padding-left', 'scroll-padding-right', 'scroll-padding-top', 'shape-margin',
  'text-decoration-thickness', 'text-indent', 'text-underline-offset', 'top', 'translate',
  'vertical-align', 'view-timeline-inset', 'width', 'word-spacing', 'x', 'y'
];

const propertyMin = {};
for (const name of longhands) {
  const t = valueTypes[name];
  if (t && t.min != null && Number.isFinite(t.min)) propertyMin[name] = t.min;
}
for (const [name, min] of Object.entries(MIN_FIXES)) if (longhands.includes(name)) propertyMin[name] = min;

// …and the UPPER bound, which an extrapolating easing runs into just as it runs into the lower one.
// The four opacities carry no range in mdn — it records `<'opacity'>` / `<opacity-value>` — and
// `opacity` itself is clamped by its own computed-value reader, which the others do not have
// (Chrome-measured: `stop-opacity` 0 → 1 under an overshooting easing reports 0 and 1, never
// -0.2 or 1.2).
const MAX_FIXES = {
  'stop-opacity':           1,
  'fill-opacity':           1,
  'stroke-opacity':         1,
  'shape-image-threshold':  1
};
const propertyMax = {};
for (const name of longhands) {
  const t = valueTypes[name];
  if (t && t.max != null && Number.isFinite(t.max)) propertyMax[name] = t.max;
}
for (const [name, max] of Object.entries(MAX_FIXES)) if (longhands.includes(name)) propertyMax[name] = max;

// Each longhand's INITIAL value and whether it INHERITS — what `getComputedStyle` must report
// for a property no rule sets. mdn-data records the SPECIFIED initial; a few compute to something
// else (`color: canvastext` → `rgb(0, 0, 0)`), which style-proxy overrides on top of this map.
// Two shapes are dropped: a non-string initial (mdn lists sub-property names for `marker` /
// `stroke`, which it classifies as longhands), and a camelCase prose sentinel
// (`dependsOnUserAgent`, `startOrNamelessValueIfLTRRightIfRTL`) — real initial values are
// lowercase keywords or lengths, so an uppercase letter marks prose, not a value. A property whose
// mdn initial is DAMAGED is corrected here rather than shipped: each entry is the value a browser
// actually reports, applied after the shape filters (which would otherwise drop the two
// legitimately mixed-case ones). `all` / `font-family` / `quotes` / `text-size-adjust` stay
// dropped — their initial genuinely depends on the UA, or the property has no single one.
const MDN_INITIAL_FIXES = {
  'flood-opacity': '1',                       // mdn says "black" — it is <'opacity'>, initial 1
  'stop-opacity':  '1',                       // same mdn error
  'text-align':    'start',                   // mdn: "startOrNamelessValueIfLTRRightIfRTL"
  'color-interpolation-filters': 'linearRGB', // a real value the prose filter's /[A-Z]/ catches
  'stroke': 'none',                           // mdn lists SUB-PROPERTY NAMES here, not a value
  'justify-items': 'normal',                  // mdn says `legacy`; Chrome computes `normal`
};
const BARE_NUMBER_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)$/;
// Does the property take a LENGTH and nothing bare-numeric? Then its `0` initial computes to
// `0px`. A syntax that also admits `<number>` / `<integer>` (`border-image-outset`, `math-depth`)
// keeps the bare number, which is what a browser reports for those.
function isLengthValued(syntax, depth = 0) {
  if (!syntax || depth > 3) return false;
  // mdn writes a logical property's grammar as a reference to its physical twin
  // (`margin-block-end: <'margin-left'>`); follow it.
  const ref = /^<'([a-z-]+)'>$/.exec(syntax.trim());
  if (ref) return props[ref[1]] ? isLengthValued(props[ref[1]].syntax, depth + 1) : false;
  if (/<(number|integer)/.test(syntax)) return false;
  return /<length/.test(syntax) || /<percentage/.test(syntax);
}
const initialValues = {};
const inherited = [];
for (const name of longhands) {
  const initial = props[name].initial;
  if (typeof initial === 'string' && !/[A-Z]/.test(initial)) {
    const trimmed = initial.trim();
    // A bare number is reported in canonical form (`shape-image-threshold: "0.0"` → `0`) — and
    // when the property takes a LENGTH, browsers report the unit too (`border-radius: 0` → `0px`).
    // mdn writes the specified `0`; the unit is part of the computed value.
    initialValues[name] = BARE_NUMBER_RE.test(trimmed)
      ? String(parseFloat(trimmed)) + (isLengthValued(props[name].syntax) ? 'px' : '')
      : trimmed;
  }
  // A property mdn classifies as numeric whose initial ISN'T a number is data damage; drop it
  // rather than report a keyword where a number belongs. (This is the backstop that catches the
  // next such mdn bug; the two known today are corrected by name above.)
  const type = valueTypes[name];
  if (initialValues[name] != null && type && (type.base === 'number' || type.base === 'integer') &&
      !BARE_NUMBER_RE.test(initialValues[name]) && type.keywords.indexOf(initialValues[name]) === -1) {
    delete initialValues[name];
  }
  if (props[name].inherited) inherited.push(name);
}
for (const [name, value] of Object.entries(MDN_INITIAL_FIXES)) if (longhands.includes(name)) initialValues[name] = value;

// Each longhand's ANIMATION TYPE, verbatim from mdn-data — how two values of the property are
// interpolated (`number`, `length`, `lpc`, `color`, `integer`, `discrete`, `notAnimatable`, and a
// long tail of per-property rules). Emitted RAW rather than normalised: which of the tail this
// engine can actually interpolate is the runtime's business, and a name it doesn't know yet falls
// back to discrete interpolation, exactly as the spec says an uninterpolable pair does. Only
// longhands are listed — mdn gives a shorthand its sub-property names here, which says nothing
// about interpolation.
const animationTypes = {};
for (const name of longhands) {
  const t = props[name].animationType;
  if (typeof t === 'string' && t.indexOf(',') === -1) animationTypes[name] = t;
}
// Types the property's own spec has moved on from since mdn recorded them, or that mdn records
// more narrowly — or, below, not at all — than the property's own grammar. `letter-spacing` and `word-spacing` take a
// percentage in css-text-4 and interpolate as one; `vertical-align` has taken one since CSS2, and
// interpolates `10%` against `100px` into the `calc()` holding both (Chrome-measured, all three),
// where mdn calls each of them a plain length.
const ANIMATION_TYPE_FIXES = {
  'letter-spacing': 'lpc',
  'word-spacing':   'lpc',
  'vertical-align': 'lpc',

  // …and the ones mdn calls NOT ANIMATABLE that a browser animates. Each was measured in Chrome
  // (`element.animate` between the two values, sampled either side of the half-way point): seven
  // flip discretely, and `math-depth` counts — `1` to `3` reports `2`.
  'background-blend-mode': 'discrete',
  'mix-blend-mode':        'discrete',
  'isolation':             'discrete',
  'touch-action':          'discrete',
  'scroll-behavior':       'discrete',
  'math-style':            'discrete',
  'math-shift':            'discrete',
  'math-depth':            'integer',

  // …and the two mdn calls DISCRETE that are a colour and a number: an SVG gradient stop fades
  // (Chrome-measured, `rgb(0,0,0)` to `rgb(100,100,100)` is `rgb(50, 50, 50)` half way, and its
  // opacity 0 to 1 is 0.5).
  'stop-color':   'color',
  'stop-opacity': 'number',

  // …and `stroke`, which mdn records as an ARRAY of property names rather than a type, so it had
  // none at all and its keyframes were dropped. It is a PAINT like `fill`, which mdn does type
  // (Chrome-measured: `#000` to `#0f0` is `rgb(0, 128, 0)` half way).
  'stroke': 'byComputedValueType',

  // …and `border-spacing`, which mdn calls discrete and Chrome interpolates as the pair of lengths
  // it is (measured: `2px` to `10px` reports `6px` half way, and `2px 4px` to `10px 20px` reports
  // `6px 12px`).
  'border-spacing': 'simpleListOfLpc'
};
// mdn types several properties that accept a PERCENTAGE as plain `length` — `margin-left`,
// `padding-top` and friends — and the length handler refuses a percentage pair, so a transition
// between two of them fell through to discrete where Chrome interpolates (`10%` to `50%` reports
// 30% of the containing block half way). Derived from the syntax rather than listed by hand: if the
// grammar admits a percentage, the animation type is `lpc`.
//
// The syntax is read RAW, so a logical property — whose grammar mdn writes as a reference to its
// physical twin — is deliberately left alone. Its computed value is not resolved either
// (`margin-block-start: 10%` reports `10%` where `margin-top` reports `40px`), so animating it
// would interpolate percentages into a value no browser reports. Both halves move together.
for (const name of longhands) {
  if (animationTypes[name] !== 'length') continue;
  const syntax = props[name].syntax || '';
  if (/<percentage|<length-percentage/.test(syntax)) animationTypes[name] = 'lpc';
}
// …and the mirror case: a property whose grammar admits a bare NUMBER as well as a length is
// `numberOrLength`, whichever of the two mdn happened to record. The distinction is not a nicety —
// the two forms do not interpolate INTO each other, they flip discretely (Chrome-measured:
// `tab-size: 4` to `8px` reports `8px` half way, where reading both as lengths gave `6px`), and
// two unitless ends stay unitless (`2` to `8` is `5`, not `5px`).
for (const name of longhands) {
  if (animationTypes[name] !== 'length') continue;
  const syntax = props[name].syntax || '';
  if (/<integer|<number/.test(syntax)) animationTypes[name] = 'numberOrLength';
}
for (const [name, type] of Object.entries(ANIMATION_TYPE_FIXES)) {
  // Keyed on the LONGHAND list, not on what mdn already recorded: mdn gives `stroke` an ARRAY of
  // other property names rather than a type, so the sweep above skips it and the property was not
  // animatable at all — a table that can only CORRECT an existing entry would silently do nothing
  // for the next one like it.
  if (longhands.includes(name)) animationTypes[name] = type;
}

// A property interpolated "by computed value" composes a plain NUMBER with the one underneath it
// whenever `composite: add` asks for it — but a LENGTH only where the property really is one
// value rather than a list, and mdn's data does not say which. Measured in Chrome, property by
// property: `font-size` and `stroke-width` add their lengths, `grid-auto-columns` and
// `scroll-margin-top` replace (Chrome interpolates neither of those two at all — they are
// discrete there, so nothing composes onto them). The SVG geometry properties were measured
// through `x` / `y` / `r` / `rx`; their three siblings follow them.
const ADDS_DIMENSION = [
  'baseline-shift', 'border-image-outset', 'border-image-slice', 'border-image-width',
  'column-height', 'column-width', 'contain-intrinsic-block-size', 'contain-intrinsic-height',
  'contain-intrinsic-inline-size', 'contain-intrinsic-width', 'cx', 'cy', 'font-size',
  'font-stretch', 'font-width', 'r', 'rx', 'ry', 'stroke-dashoffset', 'stroke-width',
  'text-size-adjust', 'text-underline-offset', 'x', 'y'
].filter((name) => longhands.includes(name));
const addsDimension = {};
for (const name of ADDS_DIMENSION) addsDimension[name] = true;

// Every BARE KEYWORD a property's grammar admits, followed through `<'property'>` and `<type>`
// references — the data a full grammar validator would consult, reduced to the one question the
// CSSOM actually has to answer cheaply: is this single identifier a value this property takes?
// (`width: notalength` and the `undefined` a JS setter stringifies are both rejected by it.)
//
// css-tree ships that validator, but the vendor bundle deliberately leaves its lexer out — it is
// ~60% of css-tree's minified weight, and boot time is a fifth of our wall. This table is the part
// we need. The ~190 named + system COLOUR keywords are shared by 63 properties, so they are
// emitted ONCE and referenced by name; without that factoring the table is 190kB rather than 43kB.
const syntaxesPath = require.resolve('mdn-data/css/syntaxes.json', { paths: [require.resolve('css-tree')] });
const syntaxes = JSON.parse(fs.readFileSync(syntaxesPath, 'utf8'));
function grammarKeywords(syntax, depth = 0, seen = new Set()) {
  if (!syntax || depth > 6) return [];
  const out = [];
  for (const m of syntax.matchAll(/<'([a-z-]+)'>/g)) {
    if (props[m[1]] && !seen.has(m[1])) { seen.add(m[1]); out.push(...grammarKeywords(props[m[1]].syntax, depth + 1, seen)); }
  }
  for (const m of syntax.matchAll(/<([a-z-]+)>/g)) {
    const t = syntaxes[m[1]];
    if (t && !seen.has(`<${m[1]}>`)) { seen.add(`<${m[1]}>`); out.push(...grammarKeywords(t.syntax, depth + 1, seen)); }
  }
  // A bare identifier alternative — not a `<type>`, not a `func(` name.
  for (const m of syntax.matchAll(/(^|[|[\]\s])([a-zA-Z][a-zA-Z0-9-]*)(?![(\w-])/g)) out.push(m[2].toLowerCase());
  return out;
}
// Does a property's grammar admit an ARBITRARY identifier? `list-style-type` reaches
// `<custom-ident>` through `<counter-style-name>`, `font-family` through `<family-name>` — for
// those, any identifier is a value and there is nothing to reject.
const OPEN_IDENT_TYPES = /<(custom-ident|dashed-ident|string|family-name|counter-style-name|counter-name|ident|keyframes-name|timeline-name|container-name|view-transition-name|anchor-name|feature-value-name|palette-identifier)>/;
function admitsAnyIdent(syntax, depth = 0, seen = new Set()) {
  if (!syntax || depth > 6) return false;
  if (OPEN_IDENT_TYPES.test(syntax)) return true;
  for (const m of syntax.matchAll(/<'([a-z-]+)'>/g)) {
    if (props[m[1]] && !seen.has(m[1])) { seen.add(m[1]); if (admitsAnyIdent(props[m[1]].syntax, depth + 1, seen)) return true; }
  }
  for (const m of syntax.matchAll(/<([a-z-]+)>/g)) {
    const t = syntaxes[m[1]];
    if (t && !seen.has(`<${m[1]}>`)) { seen.add(`<${m[1]}>`); if (admitsAnyIdent(t.syntax, depth + 1, seen)) return true; }
  }
  return false;
}
const openIdentProps = [];

const colorKeywords = new Set(grammarKeywords(syntaxes['color'] ? syntaxes['color'].syntax : '<named-color> | <system-color>'));
const propertyKeywords = {};
const colorValued = [];
for (const name of Object.keys(props)) {
  if (name.startsWith('--')) continue;
  if (admitsAnyIdent(props[name].syntax)) openIdentProps.push(name);
  const all = new Set(grammarKeywords(props[name].syntax));
  if (colorKeywords.size > 10 && [...colorKeywords].every(k => all.has(k))) {
    colorValued.push(name);
    for (const k of colorKeywords) all.delete(k);
  }
  if (all.size) propertyKeywords[name] = [...all].sort();
}

// Valid pseudo-class / pseudo-element base names (leading `:`/`::` and any `()` stripped),
// for validating a `selectorText` setter — an unknown pseudo makes the selector invalid.
const selPath = require.resolve('mdn-data/css/selectors.json', { paths: [require.resolve('css-tree')] });
const selectors = JSON.parse(fs.readFileSync(selPath, 'utf8'));
const pseudos = new Set();
for (const key of Object.keys(selectors)) {
  const m = /^::?([a-z-]+)/i.exec(key);               // ':active', '::before', ':has()' → base name
  if (m) pseudos.add(m[1].toLowerCase());
}

const out =
`// GENERATED by script/gen_css_property_data.js from mdn-data — DO NOT EDIT BY HAND.
// Names + a conservative value-type map: the longhand set, each shorthand's sub-longhands, the
// set of all supported property names, a color/integer value-type classification for value
// validation, and the valid pseudo-class/element base names — used by the CSSOM \`all\`-shorthand
// model, generic css-wide shorthand serialization, supported-property gating for named-property /
// \`setProperty\` writes, declaration-value validation, and \`selectorText\` pseudo validation.

// Every property-keyed map below is PROTOTYPE-LESS: these are looked up with a name that came from
// page script (\`style.constructor\`, \`getPropertyValue('valueOf')\`), and a plain object would
// answer such a lookup with an inherited Object.prototype member — a function where the caller
// expects a CSS value or a record, which reads as a hit and then blows up on the next property
// access.
const bare = (o) => Object.assign(Object.create(null), o);

// Every standard longhand property (a property whose value is a single field, not a
// shorthand). \`all\` resets all of these except \`direction\` and \`unicode-bidi\`.
export const LONGHANDS = new Set(${JSON.stringify(longhands)});

// Each standard shorthand → the longhand properties it sets, per mdn-data.
export const SHORTHAND_LONGHANDS = bare(${JSON.stringify(shorthands, null, 0)});

// Every "supported CSS property" name (standard longhands + shorthands + vendor-prefixed
// aliases). A named-property write or \`setProperty\` whose name isn't here (and isn't a
// \`--custom\` property) doesn't create a declaration — matching how browsers ignore
// \`style.COLOR\` / \`style.unknown\`.
export const SUPPORTED_PROPERTY_NAMES = new Set(${JSON.stringify(supported)});

// Conservative value-type map (longhand → \`{base, keywords, min?}\`) for rejecting invalid
// declaration values. base is one of color / integer / number / length (length covers
// <length>/<percentage>/<length-percentage>); \`min\` is a numeric lower bound from a \`[min,∞]\`
// range (so a negative value is rejected, e.g. \`width: -100px\`). Only properties that reduce to
// one such base plus bare keywords (functional alternatives ignored) are listed; everything else
// is accepted unchecked, so a real value is never dropped. Used by isValidDeclarationValue.
export const PROPERTY_VALUE_TYPES = bare(${JSON.stringify(valueTypes, null, 0)});

// Valid pseudo-class / pseudo-element base names (a \`selectorText\` with an unknown pseudo is
// invalid). Vendor-prefixed (\`-webkit-…\`) pseudos are accepted separately (forward-compat).
export const PSEUDO_NAMES = new Set(${JSON.stringify([...pseudos].sort())});

// Longhand → its INITIAL value: what a resolved-value read reports for a property nothing set.
// This is the SPECIFIED initial; where the computed value differs (\`color\`, \`font-weight\`, …)
// style-proxy overrides it. Reporting the real initial rather than '' matters beyond
// conformance: page code branches on it (Floating UI decides whether an ancestor establishes a
// containing block with \`getComputedStyle(el).transform !== 'none'\`, so '' reads as "transformed").
export const INITIAL_VALUES = bare(${JSON.stringify(initialValues, null, 0)});

// The longhands that INHERIT. With no value of its own, one of these takes the parent's computed
// value before falling back to the initial.
export const INHERITED_PROPERTIES = new Set(${JSON.stringify(inherited)});

// Longhand → its mdn-data ANIMATION TYPE: how an animation or transition interpolates two of its
// values (\`number\`, \`length\`, \`lpc\`, \`color\`, \`integer\`, \`discrete\`, \`notAnimatable\`, plus a
// tail of per-property rules). A name the interpolation engine doesn't implement interpolates
// discretely, which is what the spec says an uninterpolable pair does anyway.
export const ANIMATION_TYPES = bare(${JSON.stringify(animationTypes, null, 0)});

// The "by computed value" properties whose LENGTH or PERCENTAGE composes with the value underneath
// it under \`composite: add\`, rather than replacing it. A plain number always composes, so only
// the dimensioned ones need listing.
export const ADDS_DIMENSION = bare(${JSON.stringify(addsDimension, null, 0)});

// Longhand → the numeric LOWER BOUND its grammar imposes. An interpolation that extrapolates past
// it clamps: a \`flex-grow\` animation seeking before its start reports 0, not a negative number.
export const PROPERTY_MIN = bare(${JSON.stringify(propertyMin, null, 0)});

// …and its UPPER bound, for the same reason: an interpolation that extrapolates past it clamps.
export const PROPERTY_MAX = bare(${JSON.stringify(propertyMax, null, 0)});

// Every bare KEYWORD each property's grammar admits (colour keywords factored out below). Used to
// reject a single identifier a property doesn't take — \`width: notalength\`, or the \`undefined\` a
// JS setter stringifies — which a browser drops and we used to keep.
export const PROPERTY_KEYWORDS = bare(${JSON.stringify(propertyKeywords)});

// The ~200 named + system colour keywords, and the properties that accept them. Shared rather
// than repeated per property (43kB instead of 190kB).
export const COLOR_KEYWORDS = new Set(${JSON.stringify([...colorKeywords].sort())});
export const COLOR_VALUED_PROPERTIES = new Set(${JSON.stringify(colorValued.sort())});

// Properties whose grammar admits an ARBITRARY identifier (\`font-family\`, \`list-style-type\`,
// anything reaching \`<custom-ident>\`). There is no identifier to reject for these.
export const OPEN_IDENT_PROPERTIES = new Set(${JSON.stringify(openIdentProps.sort())});

// The longhands that reject a NEGATIVE value outright (see NEGATIVE_INVALID above). Filtered
// against the longhand set, so a name mdn drops leaves with it.
export const NEGATIVE_INVALID_PROPERTIES = new Set(${JSON.stringify(NEGATIVE_INVALID.filter((n) => longhands.includes(n)))});

// The longhands that take no bare NUMBER (see UNITLESS_NUMBER_INVALID above).
export const UNITLESS_NUMBER_INVALID_PROPERTIES = new Set(${JSON.stringify(UNITLESS_NUMBER_INVALID.filter((n) => longhands.includes(n)))});

// The longhands that take no numeric value at all (see NUMERIC_INVALID above).
export const NUMERIC_INVALID_PROPERTIES = new Set(${JSON.stringify(NUMERIC_INVALID.filter((n) => longhands.includes(n)))});

// The longhands whose bare \`0\` serializes as \`0px\` (see ZERO_IS_LENGTH above).
export const ZERO_IS_LENGTH_PROPERTIES = new Set(${JSON.stringify(ZERO_IS_LENGTH.filter((n) => longhands.includes(n)))});
`;

const dest = path.join(__dirname, '..', 'lib', 'capybara', 'simulated', 'js', 'src', 'css-property-data.js');
fs.writeFileSync(dest, out);
console.log(`wrote ${dest}: ${longhands.length} longhands, ${Object.keys(shorthands).length} shorthands`);
