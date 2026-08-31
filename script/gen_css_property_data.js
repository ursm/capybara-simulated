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
function classifyValueType(syntax) {
  if (!syntax) return null;
  let base = null, min = null, max = null;
  const keywords = [];
  for (const raw of syntax.split('|')) {
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
  'shape-image-threshold': 0
};
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
  'stroke': 'byComputedValueType'
};
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
`;

const dest = path.join(__dirname, '..', 'lib', 'capybara', 'simulated', 'js', 'src', 'css-property-data.js');
fs.writeFileSync(dest, out);
console.log(`wrote ${dest}: ${longhands.length} longhands, ${Object.keys(shorthands).length} shorthands`);
