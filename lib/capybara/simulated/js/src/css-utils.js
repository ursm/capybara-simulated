// Small CSS / selector parsing primitives shared between the cascade resolver, @media evaluator,
// and selector tokenizer — and the property-NAME tables the whole engine agrees on: what counts as
// a property, what a `-webkit-…` spelling means, and which IDL attribute reads which property.

import { SUPPORTED_PROPERTY_NAMES, PROPERTY_VALUE_TYPES, PROPERTY_KEYWORDS, COLOR_KEYWORDS, COLOR_VALUED_PROPERTIES, OPEN_IDENT_PROPERTIES } from './css-property-data.js';
import { isStaticallyInvalidMath } from './calc.js';
import { hasSubstitution } from './shorthands.js';

// The `-moz-` / `-ms-` names real stylesheets still ship that mdn-data has no entry for. Chrome
// answers `CSS.supports` false for all three (measured) and drops the declaration; we accept them
// so a stylesheet that writes one keeps it — a deliberate over-acceptance, and the only one left.
// The `-webkit-` names that used to sit here are decided by the measured table below now, which
// means the two Chrome does not implement (`-webkit-overflow-scrolling`, `-webkit-touch-callout`)
// are rejected rather than carved out.
const VENDOR_EXTRAS = new Set(['-moz-osx-font-smoothing', '-moz-text-size-adjust', '-ms-text-size-adjust']);

// Chrome's `-webkit-…` surface, measured (151.0.7922.169): 151 IDL attributes, of which 42 are
// properties in their own right and 109 are ALIASES — another NAME for an unprefixed property,
// resolved the moment a declaration is parsed. `#a { -webkit-transform: scale(2) }` serializes as
// `transform: scale(2)`, `[...rule.style]` is `['transform']`, and `getPropertyValue` answers to
// either spelling. Most aliases just drop the prefix; 33 rename — `-webkit-border-after-width` is
// `border-block-end-width`, `-webkit-logical-width` is `inline-size` — which is why this is a table
// and not a rule. What it replaces WAS a rule (`-webkit-` + any supported name), and it accepted
// some 600 spellings as properties of their own: `CSS.supports('-webkit-grid-template-areas', …)`
// answered true where every browser says false, and `-webkit-transform` in a real stylesheet stored
// a declaration no layout or unprefixed reader ever saw instead of setting `transform`.
//
// Re-measure by listing `Object.getOwnPropertyNames(el.style)`, setting each `webkit…` spelling to
// `initial`, and reading back what landed — `[...el.style]`, or the leading name of `cssText` when
// a shorthand expanded.
const WEBKIT_OWN_PROPERTIES = new Set([
  '-webkit-border-horizontal-spacing', '-webkit-border-image', '-webkit-border-vertical-spacing',
  '-webkit-box-align', '-webkit-box-decoration-break', '-webkit-box-direction', '-webkit-box-flex',
  '-webkit-box-ordinal-group', '-webkit-box-orient', '-webkit-box-pack', '-webkit-box-reflect',
  '-webkit-font-smoothing', '-webkit-line-break', '-webkit-line-clamp', '-webkit-locale',
  '-webkit-mask-box-image', '-webkit-mask-box-image-outset', '-webkit-mask-box-image-repeat',
  '-webkit-mask-box-image-slice', '-webkit-mask-box-image-source', '-webkit-mask-box-image-width',
  '-webkit-mask-position-x', '-webkit-mask-position-y', '-webkit-perspective-origin-x',
  '-webkit-perspective-origin-y', '-webkit-rtl-ordering', '-webkit-ruby-position',
  '-webkit-tap-highlight-color', '-webkit-text-combine', '-webkit-text-decorations-in-effect',
  '-webkit-text-fill-color', '-webkit-text-orientation', '-webkit-text-security',
  '-webkit-text-stroke', '-webkit-text-stroke-color', '-webkit-text-stroke-width',
  '-webkit-transform-origin-x', '-webkit-transform-origin-y', '-webkit-transform-origin-z',
  '-webkit-user-drag', '-webkit-user-modify', '-webkit-writing-mode'
]);

const MEASURED_WEBKIT_ALIASES = {
  __proto__: null,
  '-webkit-align-content':             'align-content',
  '-webkit-align-items':               'align-items',
  '-webkit-align-self':                'align-self',
  '-webkit-animation':                 'animation',
  '-webkit-animation-delay':           'animation-delay',
  '-webkit-animation-direction':       'animation-direction',
  '-webkit-animation-duration':        'animation-duration',
  '-webkit-animation-fill-mode':       'animation-fill-mode',
  '-webkit-animation-iteration-count': 'animation-iteration-count',
  '-webkit-animation-name':            'animation-name',
  '-webkit-animation-play-state':      'animation-play-state',
  '-webkit-animation-timing-function': 'animation-timing-function',
  '-webkit-app-region':                'app-region',
  '-webkit-appearance':                'appearance',
  '-webkit-backface-visibility':       'backface-visibility',
  '-webkit-background-clip':           'background-clip',
  '-webkit-background-origin':         'background-origin',
  '-webkit-background-size':           'background-size',
  '-webkit-border-after':              'border-block-end',
  '-webkit-border-after-color':        'border-block-end-color',
  '-webkit-border-after-style':        'border-block-end-style',
  '-webkit-border-after-width':        'border-block-end-width',
  '-webkit-border-before':             'border-block-start',
  '-webkit-border-before-color':       'border-block-start-color',
  '-webkit-border-before-style':       'border-block-start-style',
  '-webkit-border-before-width':       'border-block-start-width',
  '-webkit-border-bottom-left-radius': 'border-bottom-left-radius',
  '-webkit-border-bottom-right-radius': 'border-bottom-right-radius',
  '-webkit-border-end':                'border-inline-end',
  '-webkit-border-end-color':          'border-inline-end-color',
  '-webkit-border-end-style':          'border-inline-end-style',
  '-webkit-border-end-width':          'border-inline-end-width',
  '-webkit-border-radius':             'border-radius',
  '-webkit-border-start':              'border-inline-start',
  '-webkit-border-start-color':        'border-inline-start-color',
  '-webkit-border-start-style':        'border-inline-start-style',
  '-webkit-border-start-width':        'border-inline-start-width',
  '-webkit-border-top-left-radius':    'border-top-left-radius',
  '-webkit-border-top-right-radius':   'border-top-right-radius',
  '-webkit-box-shadow':                'box-shadow',
  '-webkit-box-sizing':                'box-sizing',
  '-webkit-clip-path':                 'clip-path',
  '-webkit-column-break-after':        'break-after',
  '-webkit-column-break-before':       'break-before',
  '-webkit-column-break-inside':       'break-inside',
  '-webkit-column-count':              'column-count',
  '-webkit-column-gap':                'column-gap',
  '-webkit-column-rule':               'column-rule',
  '-webkit-column-rule-color':         'column-rule-color',
  '-webkit-column-rule-style':         'column-rule-style',
  '-webkit-column-rule-width':         'column-rule-width',
  '-webkit-column-span':               'column-span',
  '-webkit-column-width':              'column-width',
  '-webkit-columns':                   'columns',
  '-webkit-filter':                    'filter',
  '-webkit-flex':                      'flex',
  '-webkit-flex-basis':                'flex-basis',
  '-webkit-flex-direction':            'flex-direction',
  '-webkit-flex-flow':                 'flex-flow',
  '-webkit-flex-grow':                 'flex-grow',
  '-webkit-flex-shrink':               'flex-shrink',
  '-webkit-flex-wrap':                 'flex-wrap',
  '-webkit-font-feature-settings':     'font-feature-settings',
  '-webkit-hyphenate-character':       'hyphenate-character',
  '-webkit-justify-content':           'justify-content',
  '-webkit-logical-height':            'block-size',
  '-webkit-logical-width':             'inline-size',
  '-webkit-margin-after':              'margin-block-end',
  '-webkit-margin-before':             'margin-block-start',
  '-webkit-margin-end':                'margin-inline-end',
  '-webkit-margin-start':              'margin-inline-start',
  '-webkit-mask':                      'mask',
  '-webkit-mask-clip':                 'mask-clip',
  '-webkit-mask-composite':            'mask-composite',
  '-webkit-mask-image':                'mask-image',
  '-webkit-mask-origin':               'mask-origin',
  '-webkit-mask-position':             'mask-position',
  '-webkit-mask-repeat':               'mask-repeat',
  '-webkit-mask-size':                 'mask-size',
  '-webkit-max-logical-height':        'max-block-size',
  '-webkit-max-logical-width':         'max-inline-size',
  '-webkit-min-logical-height':        'min-block-size',
  '-webkit-min-logical-width':         'min-inline-size',
  '-webkit-opacity':                   'opacity',
  '-webkit-order':                     'order',
  '-webkit-padding-after':             'padding-block-end',
  '-webkit-padding-before':            'padding-block-start',
  '-webkit-padding-end':               'padding-inline-end',
  '-webkit-padding-start':             'padding-inline-start',
  '-webkit-perspective':               'perspective',
  '-webkit-perspective-origin':        'perspective-origin',
  '-webkit-print-color-adjust':        'print-color-adjust',
  '-webkit-shape-image-threshold':     'shape-image-threshold',
  '-webkit-shape-margin':              'shape-margin',
  '-webkit-shape-outside':             'shape-outside',
  '-webkit-text-emphasis':             'text-emphasis',
  '-webkit-text-emphasis-color':       'text-emphasis-color',
  '-webkit-text-emphasis-position':    'text-emphasis-position',
  '-webkit-text-emphasis-style':       'text-emphasis-style',
  '-webkit-text-size-adjust':          'text-size-adjust',
  '-webkit-transform':                 'transform',
  '-webkit-transform-origin':          'transform-origin',
  '-webkit-transform-style':           'transform-style',
  '-webkit-transition':                'transition',
  '-webkit-transition-delay':          'transition-delay',
  '-webkit-transition-duration':       'transition-duration',
  '-webkit-transition-property':       'transition-property',
  '-webkit-transition-timing-function': 'transition-timing-function',
  '-webkit-user-select':               'user-select'
};

// A property name as the CSSOM stores it: ASCII-lowercased (custom `--…` properties are
// case-SENSITIVE and pass through), with a `-webkit-…` alias resolved to the property it names. It
// is the ONE place that resolution happens, so a declaration is unprefixed from the moment it is
// parsed and every reader downstream — serialization, the cascade, the resolved value — sees one
// property rather than two spellings of it.
// An alias is only a name for a property we HAVE. `-webkit-app-region` points at `app-region`,
// which Chrome implements and mdn's table does not list, so advertising the alias would promise a
// declaration nothing could store. The exception is NAMED rather than derived from "is the target
// supported?": a filter phrased that way swallows a typo in the table silently, dropping an alias
// with no sign. Keeping the measured table intact also lets the alias start working on its own the
// day its target arrives.
const UNMODELLED_ALIAS_TARGETS = new Set(['app-region']);
const WEBKIT_ALIASES = (() => {
  const resolvable = { __proto__: null };
  for (const [alias, target] of Object.entries(MEASURED_WEBKIT_ALIASES)) {
    if (!UNMODELLED_ALIAS_TARGETS.has(target)) resolvable[alias] = target;
  }
  return resolvable;
})();

export function cssPropertyName(name) {
  const text = String(name);
  if (text.indexOf('--') === 0) return text;
  const lower = text.toLowerCase();
  return WEBKIT_ALIASES[lower] || lower;
}

// Whether a name is a CSS property at all — the gate behind the CSSOM write path (a named-property
// or `setProperty` write to an unsupported name is ignored), `CSS.supports`, and `@supports`.
// Custom `--` properties are the caller's concern. An ALIAS answers true under its own spelling;
// `cssPropertyName` is what turns it into the property it names.
export function isSupportedCssPropertyName(name) {
  // A VENDOR-prefixed name is decided by the measured tables alone. mdn's list carries prefixed
  // entries verbatim — 5 `-webkit-` spellings Chrome dropped years ago, and 70 `-moz-` / `-ms-`
  // ones it never had — and asking it first would let those answer true while the tables beside it
  // say false. Chrome drops such a declaration; so do we.
  if (name.charCodeAt(0) === 45) {
    return WEBKIT_OWN_PROPERTIES.has(name) || WEBKIT_ALIASES[name] !== undefined || VENDOR_EXTRAS.has(name);
  }
  return SUPPORTED_PROPERTY_NAMES.has(name);
}

// CSSOM's "CSS property to IDL attribute" algorithm: `-` sets uppercase-next, and the
// `lowercaseFirst` flag drops the leading character first — which is how a `-webkit-…` property
// gets its legacy lowercase spelling (`webkitAppearance`) beside the capitalised one
// (`WebkitAppearance`).
function cssPropertyToIdlAttribute(property, lowercaseFirst) {
  let out = '', uppercaseNext = false;
  for (const c of (lowercaseFirst ? property.slice(1) : property)) {
    if (c === '-') { uppercaseNext = true; continue; }
    out += uppercaseNext ? c.toUpperCase() : c;
    uppercaseNext = false;
  }
  return out;
}

// Every IDL attribute CSSOM exposes, mapped to the property it reads. One property is spelled up
// to three ways: the camel-cased attribute always, its own dashed name whenever it carries a `-`,
// and the webkit-cased legacy spelling for the `-webkit-…` family — plus `cssFloat`, the alias
// CSSOM minted because `float` was a reserved word when the interface was written. cssom.js turns
// this into the accessors on CSSStyleDeclaration.prototype; style-proxy reads it to resolve a
// named access back to a property.
//
// Generated in the LOSSLESS direction, and the authority for the reverse one: camel-casing drops a
// dash before a digit without leaving a case boundary to fold back on, so
// `-ms-scrollbar-3dlight-color` round-tripped by hand came back as `-ms-scrollbar3dlight-color` and
// read as an unsupported name.
//
// It covers every name `isSupportedCssPropertyName` accepts, including the whole `-webkit-` surface,
// so what a declaration reports present and what reflection can find are one list.
export const CSS_PROPERTY_BY_IDL_ATTRIBUTE = (() => {
  const attributes = { __proto__: null };
  // The same authority `isSupportedCssPropertyName` uses, and for the same reason: a name it
  // rejects must not have an IDL attribute, or reflection would offer a spelling that stores
  // nothing. mdn's list carries prefixed entries browsers dropped, so only its unprefixed half
  // counts here.
  const names = [...SUPPORTED_PROPERTY_NAMES].filter(name => name.charCodeAt(0) !== 45)
    .concat([...VENDOR_EXTRAS], [...WEBKIT_OWN_PROPERTIES], Object.keys(WEBKIT_ALIASES));
  for (const name of names) {
    // The RESOLVED property, so a reader that folds an attribute back to a name gets the one the
    // declaration is stored under: `webkitTransform` reads `transform`, as it does in a browser.
    const property = cssPropertyName(name);
    attributes[cssPropertyToIdlAttribute(name, false)] = property;
    if (name.includes('-'))          attributes[name] = property;
    if (name.startsWith('-webkit-')) attributes[cssPropertyToIdlAttribute(name, true)] = property;
  }
  attributes.cssFloat = 'float';
  return attributes;
})();

const CSS_WIDE_VALUE_KEYWORDS = new Set(['inherit', 'initial', 'unset', 'revert', 'revert-layer']);

// A CONSERVATIVE per-property value check (CSSOM "set a CSS declaration" ignores a value that
// doesn't parse for the property): returns FALSE only when we're CERTAIN `value` is invalid for
// `name`. Only longhands with a simple generated type (color / integer, PROPERTY_VALUE_TYPES) are
// checked; every other property — and any css-wide keyword, `var()`/`env()` substitution, or an
// allowed keyword alternative — is accepted, so a valid value is never dropped (over-rejection
// would silently discard a real declaration). `name` is the kebab longhand; `value` has no
// trailing `!important` (the caller strips it).
// Keywords a browser accepts that mdn's grammar data omits — the legacy ones. Measured against 25
// real-world declarations, this is the ONLY over-rejection the keyword table produces.
const LEGACY_VALUES = new Set([
  'outline-color:invert',            // a legacy keyword mdn's grammar data drops
  'appearance:base', 'appearance:base-select',   // Customizable Select, shipped and not in mdn yet
]);
// The union of every property's keywords, built once on first use — the safety net against mdn's
// per-property gaps. Lazy so a page that never sets an unusual value never pays for it.
let ALL_KEYWORDS = null;
function isKeywordAnywhere(low) {
  if (!ALL_KEYWORDS) {
    ALL_KEYWORDS = new Set(COLOR_KEYWORDS);
    for (const p in PROPERTY_KEYWORDS) for (const k of PROPERTY_KEYWORDS[p]) ALL_KEYWORDS.add(k);
  }
  return ALL_KEYWORDS.has(low);
}

// A BARE IDENTIFIER: the shape whose validity the keyword table can answer outright.
const BARE_IDENT_RE = /^-?[a-zA-Z_][\w-]*$/;

export function isValidDeclarationValue(name, value) {
  const s = String(value).trim();
  if (s === '') return true;                                    // empty is the caller's "clear" path
  // A CUSTOM property is an arbitrary token stream with no grammar to check it against, and mdn
  // carries no data for a VENDOR-prefixed property or value — `display: -webkit-box` and
  // `-webkit-font-smoothing: antialiased` are real declarations every browser keeps. Judging
  // either from an empty table drops what the page wrote.
  if (name.startsWith('--') || name.startsWith('-') || s.startsWith('-webkit-') ||
      s.startsWith('-moz-') || s.startsWith('-ms-') || s.startsWith('-o-')) return true;
  const low = s.toLowerCase();
  if (CSS_WIDE_VALUE_KEYWORDS.has(low)) return true;           // valid for every property
  // A statically-invalid math function is a PARSE error, so the assignment is IGNORED — Chrome
  // leaves `el.style.marginLeft` at '' and writes no attribute, and the cascade drops it too; the
  // two surfaces have to agree, or a page that writes a computed `calc()` and reads it back to see
  // whether it applied gets the wrong answer. Placed HERE, below the custom-property escape above:
  // a custom property's value is `<declaration-value>` — any token sequence — with no grammar to be
  // invalid against, and Chrome stores `--x: calc(1px + 1)` happily. The substitution guard is the
  // cascade's, for the same reason: `var(--w, calc(1px + 1))` has an inner `calc(` that only the
  // fallback path ever uses, so judging it now drops a declaration the stylesheet keeps.
  if (!hasSubstitution(s) && isStaticallyInvalidMath(s)) return false;
  // A SUBSTITUTION can only be judged once it resolves, which is a different time — accept it.
  if (s.indexOf('(') !== -1) return true;

  // A single IDENTIFIER is a value only if this property's grammar lists it. A browser drops the
  // rest — `width: notalength`, `display: blockish`, and the `undefined` / `[object Object]` a JS
  // setter stringifies — where we used to keep them, so `style.width = undefined` left a
  // declaration behind that no browser has.
  if (BARE_IDENT_RE.test(s)) {
    if (LEGACY_VALUES.has(`${name}:${low}`)) return true;
    // A grammar that admits an arbitrary identifier (`font-family`, `list-style-type`) has nothing
    // to reject.
    if (OPEN_IDENT_PROPERTIES.has(name)) return true;
    const kws = PROPERTY_KEYWORDS[name];
    if (kws && kws.indexOf(low) !== -1) return true;
    if (COLOR_VALUED_PROPERTIES.has(name) && COLOR_KEYWORDS.has(low)) return true;
    // Not one of THIS property's keywords — but mdn's per-property lists have gaps a browser
    // doesn't (Chrome takes `baseline-shift: top`, which mdn's syntax omits), so rejecting on that
    // alone over-rejects real CSS. Reject only an identifier that is a keyword of NO property at
    // all: that is the JS-stringification class (`undefined`, `[object Object]`) and plain typos,
    // never a value we merely failed to list.
    return isKeywordAnywhere(low);
  }

  const type = PROPERTY_VALUE_TYPES[name];
  if (!type) return true;                    // no classification to judge a multi-token value by
  if (type.keywords.indexOf(low) !== -1) return true;
  // These classifications are all SINGLE-value grammars, so a value with more than one token can't
  // be one — which is what drops the `[object Object]` a JS setter stringifies.
  if (/\s/.test(s)) return false;
  switch (type.base) {
    case 'integer': return validNumeric(s, type.min, true);
    case 'number':  return validNumeric(s, type.min, false);
    case 'length':  return validLength(s, type.min);
    case 'color':   return isValidColorValue(low);
  }
  return true;
}

// A <number> / <integer> token, optionally bounded below by `min` (a `[min,∞]` range → reject a
// value below it, e.g. a negative `<number [0,∞]>`).
function validNumeric(s, min, intOnly) {
  const re = intOnly ? /^[+-]?\d+$/ : /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;
  if (!re.test(s)) return false;
  return min == null || parseFloat(s) >= min;
}

// We validate only the DIMENSION shape of a length value — a number with a unit or `%`, where
// unitless is valid ONLY for zero (a length needs a unit) and, for a `[0,∞]` range, the sign
// (`width: -100px` / `padding-top: -5px` → invalid; `margin-top: -5px`, no range → valid). We do
// NOT verify the unit spelling (accept any letters — never over-reject a real/new unit). A value
// that is NOT a bare dimension is ACCEPTED: it may be a keyword mdn-data omits (SVG `baseline-shift:
// top`, like outline-color's legacy `invert`), and over-rejecting a valid value is worse than
// letting garbage through. Functional forms (calc()/var()/…) are already accepted upstream.
function validLength(s, min) {
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(%|[a-z]+)?$/i.exec(s);
  if (!m) return true;                                         // not a bare dimension — assume a keyword; accept
  const n = parseFloat(m[1]);
  if (!m[2] && n !== 0) return false;                          // unitless non-zero — a length needs a unit
  return min == null || n >= min;
}

// Whether a NON-functional colour token is valid: `currentcolor`/`transparent`/a system colour, or
// a named colour / hex the culori surface parses. (Functional colours are accepted upstream, before
// this is reached — culori registers only a subset of colour spaces, so parsing `oklch()`/`lab()`
// here would wrongly reject them.) With no colour parser wired (snapshot build) we accept — never
// over-reject.
function isValidColorValue(low) {
  if (low === 'currentcolor' || low === 'transparent') return true;
  if (Object.prototype.hasOwnProperty.call(SYSTEM_COLORS, low)) return true;
  const vend = globalThis.__csimVendor && globalThis.__csimVendor.color;
  if (!vend || typeof vend.computed !== 'function') return true;
  return !!vend.computed(low);
}

// Decode a `data:text/css[;base64],<data>` URL (RFC 2397) to its CSS text, or
// null when `href` is not a data: URL with an explicit `text/css` media type —
// callers fall back to a network/asset fetch. A missing media type defaults to
// text/plain (RFC 2397), which a real browser does NOT apply as a stylesheet, so
// it (and any non-CSS type like `data:image/png;base64,…`) yields null. base64
// payloads are atob-decoded; otherwise the body is percent-decoded (a malformed
// escape falls back to the raw bytes). Shared by the cascade collector and the
// CSSOM `.sheet` getters so both agree — and both handle base64, which the old
// inline `.sheet` decoders did not. (The byte-returning decoders in xhr.js /
// fetch.js are separate: they need arbitrary media types + raw bytes.)
// CSS system colors (`Menu`, `ButtonFace`, `Canvas`, …) resolve to a UA sRGB value,
// not a keyword — browsers report the resolved rgb from getComputedStyle and accept
// them as `<input type=color>` values. Mapped to light-theme sRGB hex (shared by the
// computed-style color normaliser and the color-input sanitiser so both agree).
export const SYSTEM_COLORS = {
  // CSS Color 4
  canvas: '#ffffff', canvastext: '#000000', linktext: '#0000ee', visitedtext: '#551a8b',
  activetext: '#ff0000', buttonface: '#efefef', buttontext: '#000000', buttonborder: '#767676',
  field: '#ffffff', fieldtext: '#000000', highlight: '#b3d7ff', highlighttext: '#000000',
  selecteditem: '#b3d7ff', selecteditemtext: '#000000', mark: '#ffff00', marktext: '#000000',
  graytext: '#808080', accentcolor: '#0078d4', accentcolortext: '#ffffff',
  // legacy CSS2 system colours
  activeborder: '#b4b4b4', activecaption: '#cccccc', appworkspace: '#ffffff', background: '#6363ce',
  buttonhighlight: '#dddddd', buttonshadow: '#888888', captiontext: '#000000', inactiveborder: '#f4f7fc',
  inactivecaption: '#f4f7fc', inactivecaptiontext: '#000000', infobackground: '#fbfcc5', infotext: '#000000',
  menu: '#f0f0f0', menutext: '#000000', scrollbar: '#f0f0f0', threeddarkshadow: '#696969',
  threedface: '#efefef', threedhighlight: '#ffffff', threedlightshadow: '#e3e3e3', threedshadow: '#a0a0a0',
  window: '#ffffff', windowframe: '#646464', windowtext: '#000000'
};

// HTML's "rules for parsing dimension values" (the rendering section's "maps to the dimension
// property"), which is NOT a CSS length: leading whitespace, then DIGITS — at least one, so `.5`
// is an error — an optional fraction, and an optional `%` that must follow the digits IMMEDIATELY.
// Anything after that is ignored rather than invalidating: `200abc` is 200px, `200%abc` is 200%,
// `20.25e2` is 20.25px, and `200 %` is 200px because the space ends the number. A SIGN is an error
// outright, `+200` as much as `-200`, and an error maps to nothing at all. The number is
// normalised, so `   00523   ` maps to `523px`.
//
// ONE door: the cascade applies this as a presentational hint and `uaDefault` answers with it when
// nothing else does, and the two had grown separate regexes that disagreed with each other AND
// with HTML on `200.%`, `200 %` and leading zeros.
export function htmlDimensionValue(text) {
  const m = /^\s*(\d+(?:\.\d*)?)(%?)/.exec(String(text));
  if (!m) return null;
  // Serialized as CSSOM serializes a <number>: leading zeros and trailing fraction zeros go, and
  // `1.50` reports as `1.5px` the way Chrome does. NOT via `Number()`, whose exponential form is a
  // value no consumer downstream parses — `width="0.000000001"` (`1e-9px`) fell through every
  // branch and reported an EMPTY computed value, which is worse than an imprecise one. So the
  // digits are trimmed as text, which keeps an arbitrarily small or large attribute intact.
  const num = m[1]
    .replace(/^0+(?=\d)/, '')                                   // 00523 -> 523
    .replace(/(\.\d*?)0+$/, '$1')                                // 1.50 -> 1.5, 0.000 -> 0.
    .replace(/\.$/, '');                                        // 200. -> 200, 0. -> 0
  return `${num || '0'}${m[2] || 'px'}`;
}

// HTML's "maps to the pixel length property", which is the rules for parsing NON-NEGATIVE
// INTEGERS in px: leading whitespace and a `+` are allowed, everything from the first non-digit on
// is ignored (`200in`, `200%` and `200.7` are all 200px), and a negative value is no value at all —
// except `-0`, which parses to a perfectly good zero. Distinct from `htmlDimensionValue`, which is
// the DIMENSION grammar: that one keeps the fraction and honours `%`.
export function htmlPixelLength(text) {
  const m = /^[ \t\n\f\r]*([+-]?)(\d+)/.exec(String(text));
  if (!m) return null;
  const n = parseInt(m[2], 10);
  // …and a value past the 32-bit range is no integer at all, which is why `border="99999999999"`
  // draws nothing (Chrome-measured).
  if (n > 2147483647) return null;
  if (m[1] === '-' && n !== 0) return null;
  return `${n}px`;
}

// HTML's "rules for parsing integers": leading whitespace, an optional sign, then digits — and
// everything from the first non-digit on is ignored, so `10xyz` and `10e10` are both 10.
export function htmlInteger(text) {
  if (text == null) return null;
  const m = /^[ \t\n\f\r]*([+-]?)(\d+)/.exec(String(text));
  if (!m) return null;
  const n = parseInt(m[2], 10);
  // Out of the 32-bit range is out of the grammar (`<li value="99999999999999999999">` numbers
  // nothing), which is what every browser's integer parser does.
  if (n > 2147483647) return null;
  return m[1] === '-' ? -n : n;
}

// Absolute <font-size> keywords → px. Browsers use a FIXED table (NOT the CSS spec's
// informative scaling ratios), anchored at the default `medium` = 16px — these are the
// values Chrome / Firefox actually report from getComputedStyle. Shared by the
// getComputedStyle font-size resolver and the canvas `font` shorthand parser so both agree.
export const ABSOLUTE_FONT_SIZE_PX = {
  'xx-small': 9, 'x-small': 10, 'small': 13, 'medium': 16,
  'large': 18, 'x-large': 24, 'xx-large': 32, 'xxx-large': 48,
};

export function decodeDataUrlCss(href) {
  const m = /^data:([^,]*),([\s\S]*)$/i.exec(String(href || ''));
  if (!m) return null;
  const meta = m[1];
  const mediaType = meta.replace(/;base64\s*$/i, '').split(';')[0].trim().toLowerCase();
  if (mediaType !== 'text/css') return null;
  if (/;base64\s*$/i.test(meta)) { try { return globalThis.atob(m[2]); } catch (_) { return ''; } }
  try { return decodeURIComponent(m[2]); } catch (_) { return m[2]; }
}

// CSSOM "serialize a <number>": the shortest base-ten form — a leading zero for a
// bare fraction (`.5` → `0.5`), no negative zero (`-0` → `0`), trailing fraction
// zeros dropped (`5.0` → `5`). `String(Number(s))` yields exactly this for the finite
// values CSS uses; a non-finite parse falls back to the source token untouched.
function normalizeCssNumber(s) {
  const src = String(s);
  // A number with more precision than a double can hold must be reported VERBATIM — round-tripping
  // it through `Number` silently rewrites a 25-digit integer, which is exactly what a custom
  // property is allowed to carry. Canonicalizing is only safe where it round-trips.
  const n = Number(src);
  if (!Number.isFinite(n)) return src;
  const out = String(n);
  return Number(out) === n && out.replace(/[-.]/g, '').length <= 17 ? out : src;
}

// CSSOM "serialize a string": always double-quoted, with `"` and `\` backslash-escaped
// (css-tree hands us the decoded inner text). So `'string'` → `"string"`. This is the
// generic string form; `font-family` reduces valid identifier sequences to their unquoted
// form instead (serializeFontFamily below — a property-specific rule).
function serializeCssString(value) {
  return '"' + String(value).replace(/[\\"]/g, '\\$&') + '"';
}

// A CSS-wide keyword given unquoted as the whole value passes through as the keyword; as a family
// NAME (from a <string>, or `default`) it's excluded from <custom-ident> and stays quoted. A
// <generic-family> keyword also stays quoted when it originated from a <string> (unquoted it would
// reparse as the generic value).
const CSS_WIDE_KEYWORDS = new Set(['inherit', 'initial', 'unset', 'revert', 'revert-layer']);
const FONT_FAMILY_RESERVED_TOKEN = new Set(['inherit', 'initial', 'unset', 'revert', 'revert-layer', 'default']);
const FONT_FAMILY_GENERIC = new Set([
  'serif', 'sans-serif', 'cursive', 'fantasy', 'monospace', 'system-ui', 'math',
  'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded'
]);
// A bare <ident-token> needing no escaping: optional leading `-`, then a letter / `_` / non-ASCII
// start, then ident chars. A digit start, a lone `-`, or any character requiring an escape
// disqualifies it — the family is then serialized as a <string>.
const PLAIN_IDENT = /^-?(?:[A-Za-z_]|[^\x00-\x7F])(?:[-\w]|[^\x00-\x7F])*$/;

// Decode a CSS <string> token (surrounding quotes included) to its text, resolving `\` escapes
// ("consume a string token" — hex escape + optional trailing whitespace, escaped newline removed,
// `\<char>` literal).
function decodeCssString(tok) {
  const q = tok[0];
  let out = '', i = 1;
  const n = tok.length;
  while (i < n) {
    const c = tok[i];
    if (c === q) break;
    if (c === '\\') {
      const next = tok[i + 1];
      if (next === undefined) { i++; continue; }
      if (next === '\n' || next === '\r' || next === '\f') { i += 2; continue; }
      if (/[0-9a-fA-F]/.test(next)) {
        let hex = ''; i++;
        while (i < n && hex.length < 6 && /[0-9a-fA-F]/.test(tok[i])) { hex += tok[i]; i++; }
        if (i < n && /[\t\n\f\r ]/.test(tok[i])) i++;
        const cp = parseInt(hex, 16);
        out += (cp === 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) ? '�' : String.fromCodePoint(cp);
      } else { out += next; i += 2; }
    } else { out += c; i++; }
  }
  return out;
}

// Serialize a resolved <family-name> value (the decoded name text, no surrounding quotes) the way
// browsers do: a family that is a SINGLE valid identifier — not a CSS-wide keyword / `default` and
// not a <generic-family> keyword (which unquoted would reparse as the generic) — stays UNQUOTED;
// anything else (multiple words, a digit start, a reserved word) is a double-quoted <string>. This
// matches Chrome/Firefox, which do NOT reduce multi-word names to identifier sequences (the
// aspirational csswg-drafts#5846 behavior no shipped browser implements).
function serializeFamilyName(name) {
  const low = name.toLowerCase();
  if (PLAIN_IDENT.test(name) && !FONT_FAMILY_RESERVED_TOKEN.has(low) && !FONT_FAMILY_GENERIC.has(low)) return name;
  return serializeCssString(name);
}

// Split a `font-family` list on top-level commas, respecting quoted family names (a `,` inside a
// <string> is literal). splitTopLevel tracks bracket nesting but not quotes, so it can't be used.
function splitFontFamilyList(v) {
  const parts = [];
  let start = 0, quote = '';
  for (let i = 0; i < v.length; i++) {
    const c = v[i];
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === ',') {
      parts.push(v.slice(start, i)); start = i + 1;
    }
  }
  parts.push(v.slice(start));
  return parts;
}

// CSSOM serialization of a `font-family` value (a comma-separated <family-name> list), canonicalized
// the way Chrome/Firefox do — used for both the specified (`style.fontFamily`) and computed forms,
// which browsers normalize identically. Quote style is normalized (`'x'` → `"x"`), a lone
// <generic-family> keyword given unquoted stays the keyword, and a single-identifier family name is
// unquoted; everything else is a double-quoted <string>. See serializeFamilyName.
export function serializeFontFamily(raw) {
  let v = String(raw).trim();
  // An empty value round-trips empty (matches the generic serializer's fast path; a browser drops
  // the invalid declaration and reports '').
  if (v === '') return v;
  // A substitution function (`var()`/`attr()`/`env()`) isn't a <family-name> — leave the value to
  // the generic serializer, which preserves functions (and their internal commas, which the family
  // splitter would mis-split) verbatim.
  if (v.indexOf('(') !== -1) return serializeCssValue(raw);
  const bang = /\s*!\s*important\s*$/i.exec(v);
  if (bang) v = v.slice(0, bang.index).trim();
  const parts = splitFontFamilyList(v);
  // A CSS-wide keyword is only valid as the SOLE value; there it passes through as the keyword.
  if (parts.length === 1 && CSS_WIDE_KEYWORDS.has(parts[0].trim().toLowerCase())) {
    return parts[0].trim() + (bang ? ' !important' : '');
  }
  const items = parts.map(part => {
    const item = part.trim();
    if (item[0] === '"' || item[0] === "'") return serializeFamilyName(decodeCssString(item));
    // Unquoted: a <generic-family> keyword passes through as written; anything else is an
    // identifier-sequence <family-name>. (The driver does not validate values, so a bare invalid
    // token — `10`, `default` — round-trips as a quoted string rather than dropping the declaration.)
    const collapsed = item.replace(/\s+/g, ' ');
    if (FONT_FAMILY_GENERIC.has(collapsed.toLowerCase())) return collapsed;
    return serializeFamilyName(collapsed);
  });
  return items.join(', ') + (bang ? ' !important' : '');
}

// The active document's base URL (respecting `<base href>`), for resolving relative CSS URLs
// authored in a document `<style>` / inline style. Falls back to the raw location, then undefined.
export function documentBaseUrl() {
  return (globalThis.document && globalThis.document.baseURI) || (globalThis.location && globalThis.location.href) || undefined;
}

// Resolve every `url(...)` in a CSS value to an ABSOLUTE, double-quoted URL against `base`
// (getComputedStyle reports the computed, absolute image URL). An already-absolute URL ignores
// the base; a non-url value (or one with no base) is returned unchanged. Used for
// `background-image` computed values — resolved against the originating sheet's base URL.
export function resolveCssUrls(value, base) {
  // `url(` is a FUNCTION name and so ASCII case-insensitive — the regex below already is, but the
  // early-out was not, and an author writing `URL(a.png)` got a value nobody absolutized.
  if (typeof value !== 'string' || !/url\(/i.test(value)) return value;
  return value.replace(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi, (m, _q, url) => {
    if (!url) return 'url("")';
    try { return 'url("' + new globalThis.URL(url, base || undefined).href + '")'; }
    catch (_) { return 'url("' + url + '")'; }
  });
}

// Resolve one axis of a `<bg-position>` — an optional edge keyword plus an optional
// <length-percentage> offset — to the single value getComputedStyle reports:
//   center            → 50%
//   left  / top       → 0%          left/top <off>    → <off> (offset from the near edge)
//   right / bottom    → 100%        right/bottom <P>% → (100−P)% ; right/bottom <len> → calc(100% − <len>)
//   a bare <lp>       → itself
function resolveBgAxis(edge, offset) {
  if (!edge) return offset || '0%';
  if (edge === 'center') return '50%';
  if (edge === 'left' || edge === 'top') return offset || '0%';
  // right / bottom: the offset is measured from the far edge.
  if (!offset) return '100%';
  const pct = /^([+-]?[\d.]+)%$/.exec(offset);
  // Collapse `right P%` to `(100−P)%`, trimming binary-float noise to CSS's 6-decimal precision.
  if (pct) return +(100 - parseFloat(pct[1])).toFixed(6) + '%';
  return `calc(100% - ${offset})`;
}

// Canonicalize a `background-position` value to the two-per-layer `x y` form getComputedStyle
// reports, resolving keyword+offset pairs (`right 10px bottom 20px` → `calc(100% - 10px)
// calc(100% - 20px)`). Both the shorthand and the direct longhand feed through here at read time,
// so the source (`background:` vs `background-position:`) doesn't change the result. Multi-layer
// comma lists canonicalize per layer.
// A unitless ZERO is a valid <length>, but a computed value reports it with its unit: Chrome gives
// `background-position: 15px 0` back as `15px 0px`, and likewise for `background-size` and
// `border-spacing` (measured). The single-value case is already handled per property; this covers
// the LIST-valued ones, where each component is its own length.
const BARE_ZERO_RE = /^[+-]?0(\.0+)?$/;
export function normalizeZeroLengths(value) {
  const s = String(value);
  if (s.indexOf('0') < 0) return s;
  return splitTopLevel(s, ',').map((layer) =>
    splitTopLevel(layer.trim(), ' ').map(t => t.trim()).filter(Boolean)
      .map(t => (BARE_ZERO_RE.test(t) ? '0px' : t)).join(' ')
  ).join(', ');
}

export function canonicalizeBgPosition(value) {
  if (typeof value !== 'string') return value;
  return splitTopLevel(value, ',').map((layer) => {
    const toks = splitTopLevel(layer.trim(), ' ').map(t => t.trim()).filter(Boolean);
    if (!toks.length) return layer.trim();
    // Parse into ordered (edge, offset) parts: an edge keyword may bind a following <lp> offset.
    const parts = [];
    for (let i = 0; i < toks.length; i++) {
      const l = toks[i].toLowerCase();
      if (l === 'center' || l === 'left' || l === 'right' || l === 'top' || l === 'bottom') {
        let off = null;
        if (l !== 'center' && i + 1 < toks.length && /^[+-]?[\d.]/.test(toks[i + 1])) off = toks[++i];
        parts.push({ edge: l, offset: off });
      } else {
        parts.push({ edge: null, offset: toks[i] });   // a bare <length-percentage>
      }
    }
    // Assign parts to the horizontal / vertical axes. left/right fix the x axis, top/bottom the y
    // axis; center and bare offsets fill whichever axis is still open, x first.
    let x = null, y = null;
    const loose = [];
    for (const p of parts) {
      if ((p.edge === 'left' || p.edge === 'right') && x == null) x = p;
      else if ((p.edge === 'top' || p.edge === 'bottom') && y == null) y = p;
      else loose.push(p);
    }
    for (const p of loose) { if (x == null) x = p; else if (y == null) y = p; }
    // An axis with no part of its own defaults to center (50%).
    const rx = x ? resolveBgAxis(x.edge, x.offset) : '50%';
    const ry = y ? resolveBgAxis(y.edge, y.offset) : '50%';
    return rx + ' ' + ry;
  }).join(', ');
}

// CSSOM "serialize a CSS value" — canonicalize the numeric + url tokens of a single
// declaration value while preserving all other formatting (colors, keyword lists,
// comma/space separators the compact css-tree generator would otherwise mangle). We
// walk the value AST for token OFFSETS and splice the normalized text back into the
// source, right-to-left, so untouched spans stay byte-for-byte. A leading `!important`
// priority is split off and re-appended. The fast-path gate skips the css-tree parse
// for values with no fractional/negative-zero number and no `url(` — the common case
// (`red`, `1px`, `rgb(50, 75, 100)`), keeping style reads cheap (rule 3).
// A parse per call is far too much for a resolved-value read, which happens per property per
// element: the same handful of declaration values recur across a whole page, so the result is
// memoised on the source string. Capped, and cleared wholesale when full — the values in play are
// a page's distinct declarations, not unbounded input.
const UNCACHEABLE = Symbol('serialize-fallback');
const SERIALIZED_VALUES = new Map();
const SERIALIZED_VALUES_MAX = 4096;
// Would the walk below change anything? A number that isn't already canonical carries a `.`
// (a leading `.5`, or a trailing `2.0` to trim), a leading zero (`007`), or a `-0`; a string or
// url needs requoting; an explicit `+` sign is dropped (`+2s` is `2s`); and an UPPERCASE letter
// is a unit or function name a browser folds
// (`BLUR(2PX)` → `blur(2px)`), which also catches an uppercase `URL(`. A plain `10px solid` — the
// overwhelming majority — short-circuits with no work at all.
//
// The `.` case is deliberately context-free: `-.1em` is a leading-dot number too, and requiring
// the dot to follow a space or paren missed every signed one.
const NEEDS_SERIALIZE_RE = /[.'"A-Z+]|url\(|-0|(?:^|\D)0\d/;
// The CSS functions whose canonical spelling isn't all-lowercase. Everything else folds.
const MIXED_CASE_FUNCTIONS = new Map(
  ['translateX', 'translateY', 'translateZ', 'translate3d', 'scaleX', 'scaleY', 'scaleZ', 'scale3d',
   'rotateX', 'rotateY', 'rotateZ', 'rotate3d', 'skewX', 'skewY', 'matrix3d', 'perspective']
    .map(n => [n.toLowerCase(), n]));
function canonicalFunctionName(name) {
  const low = name.toLowerCase();
  return MIXED_CASE_FUNCTIONS.get(low) || low;
}

export function serializeCssValue(raw) {
  let v = String(raw);
  if (!NEEDS_SERIALIZE_RE.test(v)) return v;
  const cached = SERIALIZED_VALUES.get(v);
  if (cached !== undefined) return cached;
  const out = serializeCssValueUncached(v, raw);
  // A FALLBACK is not a result: the walk returns the input unchanged when the vendor bundle isn't
  // up yet or the parse throws, and caching that would pin an uncanonical value for this exact
  // string for the rest of the VM's life. `serializeCssValueUncached` flags those.
  if (out === UNCACHEABLE) return raw;
  if (SERIALIZED_VALUES.size >= SERIALIZED_VALUES_MAX) SERIALIZED_VALUES.clear();
  SERIALIZED_VALUES.set(v, out);
  return out;
}

function serializeCssValueUncached(v, raw) {
  const bang = /\s*!\s*important\s*$/i.exec(v);
  if (bang) v = v.slice(0, bang.index);
  const CT = globalThis.__csimVendor && globalThis.__csimVendor.cssTree;
  if (!CT) return UNCACHEABLE;
  let ast;
  try { ast = CT.parse(v, { context: 'value', positions: true }); } catch (_) { return UNCACHEABLE; }
  const edits = [];
  CT.walk(ast, (node) => {
    const loc = node.loc;
    if (!loc) return;
    let rep = null;
    if (node.type === 'Number')          rep = normalizeCssNumber(node.value);
    else if (node.type === 'Percentage') rep = normalizeCssNumber(node.value) + '%';
    // A UNIT is ASCII case-insensitive and reported folded (`10PX` → `10px`, `1FR` → `1fr`).
    else if (node.type === 'Dimension')  rep = normalizeCssNumber(node.value) + node.unit.toLowerCase();
    else if (node.type === 'Url')        rep = 'url("' + String(node.value).replace(/(["\\])/g, '\\$1') + '")';
    else if (node.type === 'String')     rep = serializeCssString(node.value);
    // A FUNCTION name is reported in its CANONICAL spelling, which is lowercase for most but
    // camelCase for the transform family — Chrome keeps `translateX` and folds `BLUR(2PX)` to
    // `blur(2px)`. Only the name is rewritten, so a string or custom-property reference inside
    // keeps its case.
    else if (node.type === 'Function') {
      const canon = canonicalFunctionName(node.name);
      if (canon !== node.name) edits.push([loc.start.offset, loc.start.offset + node.name.length, canon]);
    }
    if (rep !== null) edits.push([loc.start.offset, loc.end.offset, rep]);
  });
  if (!edits.length) return raw;
  edits.sort((a, b) => b[0] - a[0]);
  let s = v;
  for (const [a, b, rep] of edits) s = s.slice(0, a) + rep + s.slice(b);
  return s.trim() + (bang ? ' !important' : '');
}

// Char-walking parser that tolerates inputs missing `;` between declarations. We
// scan `name: value` pairs, terminating each value at `;` *or* at a look-ahead
// `<word>:` pattern (which can only be the start of the next declaration). Existing
// CSS values never contain `:` outside of `url(...)` parens, so peeking for an
// unparenthesised `<word>:` is safe. A declaration whose value begins with a colon
// (`color:: invalid`) is dropped as malformed. A regular property name folds to lower case;
// a custom property (`--…`) is case-sensitive and kept verbatim (see parseStyleDeclList).
// A CSS ident code point: `[-_a-zA-Z0-9]` or any non-ASCII (>= U+0080). Used to consume a
// property name; the `:` / `;` / whitespace that end a declaration name are excluded.
function isIdentCodePoint(c) {
  return c === '-' || c === '_' || (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c.charCodeAt(0) >= 0x80;
}
// Consume a CSS `<ident-token>` (a property NAME) starting at `i`, UNESCAPING any escape
// sequences — a custom property may be written `--\61 b` (`--ab`) / `--a\;b` (`--a;b`).
// Returns the decoded name and the index after it. A `\` + 1-6 hex digits (+ one optional
// trailing whitespace) is that code point; `\` + any other char is that char literally;
// `\` at EOF / before a newline is U+FFFD (CSS "consume an escaped code point").
function consumeIdentName(css, i, n) {
  // Fast path (>99% of names — no escape): scan the ident extent and slice it in one shot,
  // matching the old parser's cost. Only fall to the char-by-char unescaper on a `\`.
  const start = i;
  while (i < n) { const c = css[i]; if (c === '\\') break; if (!isIdentCodePoint(c)) return { name: css.slice(start, i), i }; i++; }
  if (i >= n) return { name: css.slice(start, i), i };
  i = start;
  let name = '';
  while (i < n) {
    const c = css[i];
    if (c === '\\') {
      const next = css[i + 1];
      if (next === undefined || next === '\n' || next === '\r' || next === '\f') { name += '�'; i++; break; }
      if (/[0-9a-fA-F]/.test(next)) {
        let hex = ''; i++;
        while (i < n && hex.length < 6 && /[0-9a-fA-F]/.test(css[i])) { hex += css[i]; i++; }
        if (i < n && /[\t\n\f\r ]/.test(css[i])) i++;   // one trailing whitespace is part of the escape
        const cp = parseInt(hex, 16);
        name += (cp === 0 || (cp >= 0xD800 && cp <= 0xDFFF) || cp > 0x10FFFF) ? '�' : String.fromCodePoint(cp);
      } else { name += next; i += 2; }
    } else if (isIdentCodePoint(c)) {
      name += c; i++;
    } else break;
  }
  return { name, i };
}

// Every declaration in a block, IN SOURCE ORDER, duplicates included — `{prop, value}` with the
// value's `!important` still attached. This is the order the cascade applies: a caller that
// expands shorthands has to see `margin-left; margin; margin-left` in exactly that sequence, which
// the map form below can't express (it keeps a re-declared property at its FIRST position, because
// that is where a declaration block serializes it).
export function parseStyleDeclList(css) {
  const out = [];
  let i = 0;
  const n = css.length;
  while (i < n) {
    while (i < n && (css[i] === ';' || /\s/.test(css[i]))) i++;
    if (i >= n) break;
    const nameStart = i;
    const decoded = consumeIdentName(css, i, n);
    i = decoded.i;
    if (i === nameStart) { i++; continue; }
    const name = cssPropertyName(decoded.name);
    while (i < n && /\s/.test(css[i])) i++;
    if (css[i] !== ':') continue;
    i++;
    while (i < n && /\s/.test(css[i])) i++;
    let value = '';
    let parenDepth = 0;
    let quote = '';   // the open quote char inside a string token ('' when outside)
    while (i < n) {
      const c = css[i];
      // Inside a quoted string, `;` / `:` / whitespace are literal — a `content:
      // "a;b"` or `--x: "p:q"` value must not be truncated at them.
      if (quote) {
        if (c === quote && css[i - 1] !== '\\') quote = '';
        value += c; i++; continue;
      }
      if (c === '"' || c === "'") { quote = c; value += c; i++; continue; }
      if (c === '(') parenDepth++;
      else if (c === ')') parenDepth--;
      else if (c === ';' && parenDepth === 0) { i++; break; }
      else if (parenDepth === 0 && /\s/.test(c)) {
        let j = i + 1;
        while (j < n && /\s/.test(css[j])) j++;
        const wStart = j;
        while (j < n && /[a-zA-Z-]/.test(css[j])) j++;
        if (j > wStart) {
          let k = j;
          while (k < n && /\s/.test(css[k])) k++;
          if (css[k] === ':') break; // next declaration begins
        }
      }
      value += c;
      i++;
    }
    const v = value.trim();
    // A regular declaration with NO value is invalid and is dropped, not stored as an empty one
    // (Chrome measured: re-parsing the `margin-right: ;` it writes for an unserializable value
    // yields nothing, leaving `margin-right` at its initial). Keeping it made an empty string
    // compete in the cascade and reconstruct into shorthands as a blank component (`margin: 7px  `).
    // A CUSTOM property is exempt: the empty token sequence is a legal value for it
    // (css-variables-1 §2), and `style="--x: "` keeps the declaration in Chrome (measured).
    const custom = name.startsWith('--');
    if (name && (custom || v !== '') && v[0] !== ':') out.push({ prop: name, value: v });
  }
  return out;
}


// Split `s` on top-level occurrences of single-char `sep`, respecting
// `[]` / `()` nesting. Used to slice comma-separated selector lists
// (`'input, textarea'`) and media-query lists without splitting on
// commas that appear inside attribute selectors or `:where(a, b)`
// pseudo-class arguments.
// The same split, trimmed and with empty parts dropped — the form a VALUE list wants: the
// comma-separated layers of a `box-shadow`, the space-separated words of one layer, the functions
// of a `filter`. A `' '` separator means ANY whitespace, since a declared value may be written
// across lines.
export function splitValues(s, sep) {
  const text = sep === ' ' ? String(s).replace(/\s+/g, ' ').trim() : String(s).trim();
  return text ? splitTopLevel(text, sep).map((part) => part.trim()).filter(Boolean) : [];
}

export function splitTopLevel(s, sep) {
  const parts = [];
  let depth = 0, start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '[' || ch === '(') depth++;
    else if (ch === ']' || ch === ')') depth--;
    else if (ch === sep && depth === 0) { parts.push(s.slice(start, i)); start = i + 1; }
  }
  parts.push(s.slice(start));
  return parts;
}
