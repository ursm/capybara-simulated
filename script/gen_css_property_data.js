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
function parseRangeMin(bound) {
  const s = bound.trim();
  if (s.indexOf('∞') !== -1) return s[0] === '-' ? -Infinity : Infinity;   // ∞ / -∞
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}
function classifyValueType(syntax) {
  if (!syntax) return null;
  let base = null, min = null;
  const keywords = [];
  for (const raw of syntax.split('|')) {
    const part = raw.trim();
    if (part.indexOf('(') !== -1) continue;                // functional alternative — runtime accepts, skip
    // A type reference with an optional numeric range: `<name>` / `<name [min,max]>`.
    const m = /^<([a-z-]+)(?:\s*\[\s*([^,\]]+)\s*,[^\]]*\])?>$/.exec(part);
    if (m) {
      const t = TYPE_BASE[m[1]];
      if (!t) return null;                                 // an unknown type — can't validate
      if (base && base !== t) return null;                 // mixed base types
      base = t;
      if (m[2] != null) {
        const lo = parseRangeMin(m[2]);
        if (lo != null && Number.isFinite(lo)) min = (min == null) ? lo : Math.min(min, lo);
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
  return out;
}
const valueTypes = {};
for (const name of longhands) {
  const t = classifyValueType(props[name].syntax);
  if (t) valueTypes[name] = t;
}

// Each longhand's INITIAL value and whether it INHERITS — what `getComputedStyle` must report
// for a property no rule sets. mdn-data records the SPECIFIED initial; a few compute to something
// else (`color: canvastext` → `rgb(0, 0, 0)`), which style-proxy overrides on top of this map.
// Two shapes are dropped: a non-string initial (mdn lists sub-property names for `marker` /
// `stroke`, which it classifies as longhands), and a camelCase prose sentinel
// (`dependsOnUserAgent`, `startOrNamelessValueIfLTRRightIfRTL`) — real initial values are
// lowercase keywords or lengths, so an uppercase letter marks prose, not a value.
const initialValues = {};
const inherited = [];
for (const name of longhands) {
  const initial = props[name].initial;
  if (typeof initial === 'string' && !/[A-Z]/.test(initial)) initialValues[name] = initial.trim();
  if (props[name].inherited) inherited.push(name);
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
`;

const dest = path.join(__dirname, '..', 'lib', 'capybara', 'simulated', 'js', 'src', 'css-property-data.js');
fs.writeFileSync(dest, out);
console.log(`wrote ${dest}: ${longhands.length} longhands, ${Object.keys(shorthands).length} shorthands`);
