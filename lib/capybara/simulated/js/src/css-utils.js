// Small CSS / selector parsing primitives shared between the cascade resolver, @media evaluator,
// and selector tokenizer — and the property-NAME tables the whole engine agrees on: what counts as
// a property, what a `-webkit-…` spelling means, and which IDL attribute reads which property.

import { SUPPORTED_PROPERTY_NAMES, PROPERTY_VALUE_TYPES, PROPERTY_KEYWORDS, COLOR_KEYWORDS, COLOR_VALUED_PROPERTIES, OPEN_IDENT_PROPERTIES, NEGATIVE_INVALID_PROPERTIES, UNITLESS_NUMBER_INVALID_PROPERTIES, NUMERIC_INVALID_PROPERTIES, ZERO_IS_LENGTH_PROPERTIES } from './css-property-data.js';
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
  // …and the keywords mdn-data 2.27.1 has yet to record, which Chrome takes (each measured on this
  // machine). A CLASSIFIED property's keyword list is treated as complete, so these have to be
  // named: without them `width: stretch` — the standard replacement for `-webkit-fill-available` —
  // is dropped from every sizing property.
  ...['width', 'height', 'min-width', 'max-width', 'min-height', 'max-height',
      'block-size', 'inline-size', 'min-block-size', 'max-block-size',
      'min-inline-size', 'max-inline-size'].map(p => `${p}:stretch`),
  'grid-column-gap:normal', 'grid-row-gap:normal',   // the legacy gap aliases inherit `normal`
  'rx:auto', 'ry:auto',                              // SVG 2's initial value for both
  // css-text-4's `text-autospace`, which mdn records as `auto | normal` — the wrong pair: Chrome
  // takes `normal` and `no-autospace` and refuses `auto` (measured). Only the keyword mdn is
  // MISSING is named here; the one it invents is a harmless over-acceptance.
  'text-autospace:no-autospace',
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
// The four colour functions whose grammar is settled and whose arguments the vendored parser
// checks — the only functional values we judge (see `isValidDeclarationValue`), and only when
// those arguments are LITERAL. A `var()` / `env()` / `calc()` inside them, the relative-colour
// `from` keyword, or a comment all put the value past what the parser reads, and it answers "not a
// colour" for every one of them: judging those dropped `rgb(255 255 255 / var(--tw-bg-opacity, 1))`
// — the whole Tailwind colour system — and `rgb(from red r g b)` with it (241 declarations across
// the five app suites' CSS, all of which Chrome keeps).
const CLASSIC_COLOR_FN_RE = /^(?:rgba?|hsla?)\(/i;
function isLiteralColorFunction(s) {
  if (!CLASSIC_COLOR_FN_RE.test(s)) return false;
  const args = s.slice(s.indexOf('(') + 1, s.lastIndexOf(')'));
  return !/[()]/.test(args) && args.indexOf('/*') === -1 && !/^\s*from\b/i.test(args);
}

// A COMMENT is stripped at tokenization, before any grammar sees the value: `padding-left: 10px
// /*c*/` is `10px` in Chrome, on the specified surface as well as the computed one, and counting the
// comment as a component dropped the declaration (22 of them in the vendored app suites' real CSS).
// Not applied inside a string, where `/*` is just text.
export function stripCssComments(value) {
  if (value.indexOf('/*') === -1) return value;
  let out = '', quote = '', i = 0;
  while (i < value.length) {
    const c = value[i];
    if (quote) {
      if (c === '\\') { out += c + (value[i + 1] || ''); i += 2; continue; }
      if (c === quote) quote = '';
      out += c; i++; continue;
    }
    if (c === '"' || c === "'") { quote = c; out += c; i++; continue; }
    if (c === '/' && value[i + 1] === '*') {
      const end = value.indexOf('*/', i + 2);
      i = end === -1 ? value.length : end + 2;
      // A comment separates tokens, so what it leaves behind is one space. When a real space
      // already sits on either side of it — which is how one is usually written — that space is
      // the separator, and the run must not double.
      if (out && !/\s$/.test(out)) out += ' ';
      else while (i < value.length && /\s/.test(value[i])) i++;
      continue;
    }
    out += c; i++;
  }
  return out.trim();
}

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
  // Everything from here to the substitution escape below judges the value's COMPONENTS, which a
  // `var()` has yet to supply: how many there are, and what each one is. Chrome keeps `width:
  // var(--a) -1px` and `background-position-x: var(--x) var(--y)` for exactly that reason —
  // invalid-at-computed-value-time is a different time — so a substituted value goes no further.
  // One split serves all four rules; they used to take one each.
  const substituted = hasSubstitution(s);
  if (!substituted) {
    const entries = splitTopLevel(s, ',');
    // A stray comma leaves an EMPTY list entry, and no property takes one: `background-position-x:
    // 10px,`, `font-family: Arial,` and `transition-property: color,` are dropped whole by every
    // browser (measured across eleven comma-list properties).
    if (s.indexOf(',') !== -1 && entries.some((entry) => entry.trim() === '')) return false;
    // A property whose grammar admits no negative value drops the declaration when it sees one — it
    // does NOT clamp. Only a literal at the TOP level counts: `width: calc(-5px)` and
    // `min(-1px, 10px)` are valid declarations, their negative resolved (and clamped) later.
    if (NEGATIVE_INVALID_PROPERTIES.has(name) && hasTopLevelNegative(entries)) return false;
    // …a `<time>` / `<angle>` property takes no bare number at all, not even a zero…
    if (UNITLESS_NUMBER_INVALID_PROPERTIES.has(name) &&
        entries.some((entry) => BARE_NUMBER_RE.test(entry.trim()))) return false;
    // …and a keyword-, colour- or identifier-valued property takes no number in any form. Only an
    // entry that IS one numeric token counts, so a number that belongs to something larger — a
    // `<string>`-and-number pair, an argument inside a function — is left alone.
    if (NUMERIC_INVALID_PROPERTIES.has(name) &&
        entries.some((entry) => NUMERIC_TOKEN_RE.test(entry.trim()))) return false;
    // …and the `<position>` family has a grammar keywords alone can violate: an axis longhand takes
    // one part and only its OWN axis's keywords, and a pair takes at most one part per axis.
    if (POSITION_AXIS[name] !== undefined && !validPositionValue(entries, POSITION_AXIS[name])) return false;
  }
  // A SUBSTITUTION can only be judged once it resolves, which is a different time — accept it. How
  // MANY values it is, though, is already decided: `padding-inline-start: 20% calc(10px - 0.5em)`
  // is two components where the grammar takes one, whatever the second resolves to. Counted at the
  // TOP level, so the space inside a `calc()` doesn't count as a separator.
  if (s.indexOf('(') !== -1) {
    if (substituted) return true;                       // …for the reason given above
    const t = PROPERTY_VALUE_TYPES[name];
    if (!t) return true;
    const parts = splitTopLevelWhitespace(s);
    if (parts.length > (t.repeat || 1)) return false;
    // …except the CLASSIC colour functions, whose arguments are fully specified and which the
    // vendored colour parser already reads: `rgb(1)`, `rgb(1,2,3,4,5)`, `hsla(1,2,3,4,5)` and
    // `rgb(10%, 20, 30%)` are all dropped by browsers and were all kept here. PER COMPONENT, so a
    // `{1,2}` grammar's second colour is judged on its own. Only these four — a modern function the
    // parser doesn't know yet (`color-mix()`, `light-dark()`) must not be rejected for being
    // unknown, and neither must a `var()` that has yet to resolve.
    if (t.base === 'color') {
      for (const part of parts) {
        if (isLiteralColorFunction(part) && !isValidColorValue(part.toLowerCase())) return false;
      }
    }
    return true;
  }

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
    // A property whose grammar we CLASSIFIED is a different matter: that classification came out of
    // mdn's full syntax for it, so its keyword list is the whole list and an identifier outside it
    // is invalid however common the word is elsewhere (`block-size: none`, `border-block-start-color:
    // auto` — both dropped by every browser, both kept here while the fall-through below was the
    // only answer).
    const classified = PROPERTY_VALUE_TYPES[name];
    if (classified) {
      if (classified.keywords.indexOf(low) !== -1) return true;
      // A `<color>` grammar's keywords live in the colour table rather than in mdn's alternation.
      return classified.base === 'color' ? isValidColorValue(low) : false;
    }
    // Otherwise mdn's per-property lists have gaps a browser doesn't, so rejecting on that alone
    // over-rejects real CSS. (The example this comment used to give — `baseline-shift: top` — is
    // not one: Chrome 151 drops it, css-inline-3 defines no such keyword, and the property is
    // classified anyway so the branch above decides it. The gaps that ARE real are named in
    // `LEGACY_VALUES`.) Reject only an identifier that is a keyword of NO property at all: that is the
    // JS-stringification class (`undefined`, `[object Object]`) and plain typos, never a value we
    // merely failed to list.
    return isKeywordAnywhere(low);
  }

  const type = PROPERTY_VALUE_TYPES[name];
  if (!type) return true;                    // no classification to judge a multi-token value by
  if (type.keywords.indexOf(low) !== -1) return true;
  // None of the classified grammars is comma-separated — they are one value, or N of the same one
  // separated by spaces — so a comma is a parse error wherever it falls (`padding-block: 20%,
  // calc(10px - 0.5em)`, which we expanded into two sides and kept).
  if (s.indexOf(',') !== -1) return false;
  // Most of these grammars take ONE value, so a second token can't be one — which is what drops the
  // `[object Object]` a JS setter stringifies. Some take up to N of them (`border-block-color:
  // <'border-top-color'>{1,2}`), and then each is checked on its own.
  const parts = splitTopLevelWhitespace(s);
  if (parts.length > (type.repeat || 1)) return false;
  for (const part of parts) if (!matchesValueType(part, type)) return false;
  return true;
}

// A value's top-level components, split on ANY whitespace — a stylesheet is free to put a newline
// or a tab between two of them — and never inside a FUNCTION. Parentheses only: a bracket is not a
// grouping in any of the grammars that reach here (grid's `[line-name]` lists are unclassified),
// and counting it as one made `width: [object Object]` — the JS stringification this exists to
// drop — read as a single component.
export function splitTopLevelWhitespace(s) {
  const parts = [];
  let depth = 0, start = 0, quote = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    // A separator inside a STRING is part of the string, and a `\`-escaped one is part of the token
    // it escapes: `font-family: "Foo, Bar"` and `A\,1` are each ONE component (Chrome-measured).
    if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '\\') { i++; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (depth === 0 && (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f')) {
      if (i > start) parts.push(s.slice(start, i));
      start = i + 1;
    }
  }
  if (s.length > start) parts.push(s.slice(start));
  return parts;
}

// One component of a classified value.
function matchesValueType(s, type) {
  const low = s.toLowerCase();
  if (type.keywords.indexOf(low) !== -1) return true;
  switch (type.base) {
    case 'integer': return validNumeric(s, type.min, true);
    case 'number':  return validNumeric(s, type.min, false);
    case 'length':  return validLength(s, type.min, type.unitless);
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
function validLength(s, min, unitlessOk) {
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(%|[a-z]+)?$/i.exec(s);
  if (!m) return true;                                         // not a bare dimension — assume a keyword; accept
  const n = parseFloat(m[1]);
  // A unitless non-zero is not a length — except in SVG's geometry properties, where a bare number
  // IS one: `<rect x="1">`'s presentation attribute and `x: 1` in CSS are the same user units, and
  // Chrome keeps both (measured on `x` / `y` / `cx` / `cy` / `r` / `rx` / `ry` / `baseline-shift`).
  if (!m[2] && n !== 0 && !unitlessOk) return false;
  return min == null || n >= min;
}

// Whether a NON-functional colour token is valid: `currentcolor`/`transparent`/a system colour, or
// a named colour / hex the culori surface parses. (Functional colours are accepted upstream, before
// this is reached — culori registers only a subset of colour spaces, so parsing `oklch()`/`lab()`
// here would wrongly reject them.) With no colour parser wired (snapshot build) we accept — never
// over-reject.
function isValidColorValue(low) {
  if (low === 'currentcolor' || low === 'transparent') return true;
  // A colour is an identifier, a hex triple or a function — never a bare number. The vendored
  // parser reads `123` as one (a hex-ish fallback), which kept `border-block-end-color: 123`.
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(low)) return false;
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
  // …and a NEGATIVE offset from the far edge ADDS, because `100% - -10px` is not a form any
  // reader of a computed length-percentage parses (Chrome-measured: `right -10px` is
  // `calc(100% + 10px)`).
  const neg = /^-\s*(.+)$/.exec(offset);
  return neg ? `calc(100% + ${neg[1]})` : `calc(100% - ${offset})`;
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

// `stroke-dasharray` as the computed value reports it: a comma-separated list of LENGTHS. Its
// entries may be written separated by whitespace, commas or both, and an entry may be a bare
// number — SVG user units, which are px (Chrome-measured: `stroke-dasharray: 4 2` reports
// `4px, 2px`, and so does `4,2`). `none` is a keyword and stays one.
const BARE_NUMBER_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;
export function canonicalizeDashArray(value) {
  if (typeof value !== 'string') return value;
  const parts = [];
  for (const layer of splitTopLevel(value, ',')) {
    const toks = splitTopLevelWhitespace(layer.trim()).filter(Boolean);
    // An EMPTY entry — a stray comma — makes the whole list invalid. Dropping it here would repair
    // a declaration the reader downstream is meant to reject, so the value is handed back exactly
    // as it came instead.
    if (!toks.length) return value;
    for (const tok of toks) {
      // …and a number is REWRITTEN, not just suffixed: `1e1` is `10px` and `.5` is `0.5px`.
      parts.push(BARE_NUMBER_RE.test(tok) ? +parseFloat(tok).toFixed(6) + 'px' : tok);
    }
  }
  return parts.length ? parts.join(', ') : value;
}

// A `<line-width>` is USED at whole-px granularity: Chrome floors it, and a width the author asked
// for never disappears — it floors to a minimum of 1px. Measured on `outline-width`,
// `border-*-width` and `column-rule-width` alike, both in `getComputedStyle` and in the box layout
// measures: `0.1px` and `1.9px` are `1px`, `2.5px` is `2px`, `10pt` (13.3333px) is `13px` — and a
// 10pt border makes a 100px box 126px wide, not 126.67. A zero stays zero.
export function usedLineWidthPx(px) {
  return px > 0 ? Math.max(1, Math.floor(px)) : 0;
}

// One numeric token, with or without a unit: `1`, `-.5`, `10px`, `1e1%`.
const NUMERIC_TOKEN_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?[a-z%]*$/i;

// A NEGATIVE numeric literal among the value's top-level tokens — `-1px`, `-.5`, `1px -2px`. A `-`
// inside an identifier (`grid-area: foo-1`) is not a numeric token, a number inside a function is
// not top level, and a NEGATIVE ZERO is not negative: `line-height: -0` is a value every browser
// keeps (WPT `css/cssom/serialize-values`).
function hasTopLevelNegative(entries) {
  for (const entry of entries) {
    for (const token of splitTopLevelWhitespace(entry.trim())) {
      if (NUMERIC_TOKEN_RE.test(token) && parseFloat(token) < 0) return true;
    }
  }
  return false;
}

// The `<position>`-valued properties, by the axis each one takes: an axis longhand takes ONE part
// and only its own axis's edge keywords, a pair takes at most one part per axis. Chrome-measured,
// all of them dropped: `background-position-x: bottom`, `background-position-y: right 10px`,
// `background-position-x: center 10px` (`center` binds no offset), `background-position: left left`,
// `object-position: top top`, `object-position: 1px 2px 3px`.
const POSITION_AXIS = Object.assign(Object.create(null), {
  'background-position-x': 'x',
  'background-position-y': 'y',
  'background-position':   'xy',
  'object-position':       'xy',
  'mask-position':         'xy'
});
const X_EDGES = new globalThis.Set(['left', 'right']);
const Y_EDGES = new globalThis.Set(['top', 'bottom']);
function validPositionValue(entries, axis) {
  for (const layer of entries) {
    const parts = positionParts(layer);
    if (!parts.length) return false;
    if (axis !== 'xy') {
      // One part, and an edge from this axis or none at all (`center` and a bare offset fit both).
      if (parts.length !== 1) return false;
      const edge = parts[0].edge;
      if (edge && edge !== 'center' && !(axis === 'x' ? X_EDGES : Y_EDGES).has(edge)) return false;
      continue;
    }
    if (parts.length > 2) return false;
    let x = null, y = null;
    const loose = [];
    for (const part of parts) {
      if (X_EDGES.has(part.edge) && x == null) x = part;
      else if (Y_EDGES.has(part.edge) && y == null) y = part;
      else loose.push(part);
    }
    // …and whatever is left fills the open axis, x first — but an edge keyword can only fill the
    // axis it names, which is what makes `left left` and `top top` parse errors.
    for (const part of loose) {
      if (x == null && !Y_EDGES.has(part.edge)) x = part;
      else if (y == null && !X_EDGES.has(part.edge)) y = part;
      else return false;
    }
  }
  return true;
}

// One layer of a `<position>`, as the ordered (edge, offset) parts it is written in: an edge
// keyword may bind a following `<length-percentage>` offset, and a bare offset has no edge. Shared
// by the pair and the single-axis canonicalizers so the two cannot disagree about what a layer is.
const POSITION_EDGE_RE = /^(?:center|left|right|top|bottom)$/;
// An offset an edge keyword can bind: a length / percentage, or a function that resolves to one.
// A `calc()` offset is the common authoring form — Discourse writes `background-position: center
// right var(--space-2)` — and reading it as a part of its own made `right calc(10px)` look like two
// x-axis parts, which both the canonicalizer (a wrong serialization) and the validator (a DROPPED
// declaration) got wrong.
const POSITION_OFFSET_RE = /^([+-]?[\d.]|[a-z-]+\()/i;
function positionParts(layer) {
  const toks = splitTopLevelWhitespace(layer.trim()).filter((t) => t && !t.startsWith('/*'));
  const parts = [];
  for (let i = 0; i < toks.length; i++) {
    const l = toks[i].toLowerCase();
    if (POSITION_EDGE_RE.test(l)) {
      let off = null;
      if (l !== 'center' && i + 1 < toks.length && POSITION_OFFSET_RE.test(toks[i + 1])) off = toks[++i];
      parts.push({ edge: l, offset: off });
    } else {
      parts.push({ edge: null, offset: toks[i] });   // a bare <length-percentage>
    }
  }
  return parts;
}

// The single-axis half of the same canonicalization, for the `background-position-x` /
// `background-position-y` longhands: `left`/`top` is `0%`, `right`/`bottom` `100%`, `center` `50%`
// and an edge-relative offset the `calc()` measuring from the near edge (Chrome-measured:
// `background-position-x: right 10px` reports `calc(100% - 10px)`). Without it the longhand read
// back the keyword the author wrote, which is not a value any interpolation can use — `left` to
// `right` flipped discretely where Chrome reports `50%` half way.
export function canonicalizeBgAxis(value) {
  if (typeof value !== 'string') return value;
  return splitTopLevel(value, ',').map((layer) => {
    const parts = positionParts(layer);
    if (parts.length !== 1) return layer.trim();     // an axis takes exactly one part
    return resolveBgAxis(parts[0].edge, parts[0].offset);
  }).join(', ');
}

export function canonicalizeBgPosition(value) {
  if (typeof value !== 'string') return value;
  return splitTopLevel(value, ',').map((layer) => {
    const parts = positionParts(layer);
    if (!parts.length) return layer.trim();
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

// Snapshot-build fallback: a CSS named-color subset mapped to canonical
// `rgb(...)` strings, used only when the culori-backed `__csimVendor.color`
// surface isn't available (e.g. during the V8 snapshot build). At runtime
// culori handles the full named-colour set; expand this on demand.
const NAMED_COLORS = {
  transparent: 'rgba(0, 0, 0, 0)',
  black: 'rgb(0, 0, 0)',
  white: 'rgb(255, 255, 255)',
  red: 'rgb(255, 0, 0)',
  green: 'rgb(0, 128, 0)',
  blue: 'rgb(0, 0, 255)',
  yellow: 'rgb(255, 255, 0)',
  cyan: 'rgb(0, 255, 255)',
  magenta: 'rgb(255, 0, 255)',
  gray: 'rgb(128, 128, 128)',
  grey: 'rgb(128, 128, 128)',
  silver: 'rgb(192, 192, 192)',
  maroon: 'rgb(128, 0, 0)',
  olive: 'rgb(128, 128, 0)',
  lime: 'rgb(0, 255, 0)',
  aqua: 'rgb(0, 255, 255)',
  teal: 'rgb(0, 128, 128)',
  navy: 'rgb(0, 0, 128)',
  fuchsia: 'rgb(255, 0, 255)',
  purple: 'rgb(128, 0, 128)',
  orange: 'rgb(255, 165, 0)'
};

// Canonicalise color values to the `rgb(...)` / `rgba(...)` form real browsers
// return from `getComputedStyle(...).color`. culori (the vendored CSS Color 4
// parser) does the heavy lifting — named colours, `rgb()`/`hsl()` in every
// legacy/modern syntax, percentages, etc. all fold to the canonical sRGB
// serialization. An explicit non-sRGB colour space (`color(display-p3 …)`,
// `lab()`, `oklch()`, …) is PRESERVED verbatim, matching browsers; an
// unparseable value also passes through unchanged.
//
// The `#rrggbb`-family hex fast-paths stay ahead of culori: they're cheap and,
// more importantly, keep this function working during the V8 snapshot build
// (when `__csimVendor` isn't wired yet) — likewise the small `NAMED_COLORS`
// fallback below.
// An ALPHA is stored as one byte and reported as the SHORTEST decimal that rounds back to it —
// `#ffffff80` is `0.5` (not the 0.502 the division gives), `#ffffffc0` is `0.753` because `0.75`
// would land on the neighbouring byte, and `#ffffff01` is `0.004`. Chrome-measured across the
// range; a hex alpha reported to a flat 3 decimals disagreed with it on half of them.
function serializeAlpha(byte) {
  for (let places = 1; places <= 3; places++) {
    const candidate = +(byte / 255).toFixed(places);
    if (Math.round(candidate * 255) === byte) return candidate;
  }
  return +(byte / 255).toFixed(3);
}

export function normalizeColor(value) {
  if (typeof value !== 'string') return value;
  const v = value.trim();
  let m = v.match(/^#([0-9a-fA-F]{8})$/);
  if (m) {
    const r = parseInt(m[1].slice(0, 2), 16);
    const g = parseInt(m[1].slice(2, 4), 16);
    const b = parseInt(m[1].slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${serializeAlpha(parseInt(m[1].slice(6, 8), 16))})`;
  }
  m = v.match(/^#([0-9a-fA-F]{6})$/);
  if (m) {
    const n = parseInt(m[1], 16);
    return `rgb(${(n >> 16) & 0xff}, ${(n >> 8) & 0xff}, ${n & 0xff})`;
  }
  m = v.match(/^#([0-9a-fA-F]{4})$/);
  if (m) {
    const c = m[1];
    const r = parseInt(c[0] + c[0], 16);
    const g = parseInt(c[1] + c[1], 16);
    const b = parseInt(c[2] + c[2], 16);
    return `rgba(${r}, ${g}, ${b}, ${serializeAlpha(parseInt(c[3] + c[3], 16))})`;
  }
  m = v.match(/^#([0-9a-fA-F]{3})$/);
  if (m) {
    const c = m[1];
    const r = parseInt(c[0] + c[0], 16);
    const g = parseInt(c[1] + c[1], 16);
    const b = parseInt(c[2] + c[2], 16);
    return `rgb(${r}, ${g}, ${b})`;
  }
  const vend = globalThis.__csimVendor && globalThis.__csimVendor.color;
  if (vend && typeof vend.computed === 'function') {
    try {
      const c = vend.computed(v);
      if (c) return c;
    } catch (_) { /* fall through to the static fallback */ }
  }
  const named = NAMED_COLORS[v.toLowerCase()];
  if (named) return named;
  // CSS system colors (Menu / ButtonFace / Canvas …) resolve to a UA sRGB value the
  // color libs don't know — map to hex, then reuse the hex→rgb path above.
  const sys = SYSTEM_COLORS[v.toLowerCase()];
  if (sys) return normalizeColor(sys);
  return v;
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
//
// A number in SCIENTIFIC notation is here too — `5e1px` is `50px` and `1e-2px` is `0.01px`, and
// neither carries a `.`, an uppercase letter or a `+`, so the old test let both through untouched.
// It is spelled `digit e digit` rather than a bare `e`, which would send every `none` and `red`
// through the parser.
//
// …and so is the SPACING inside a function: `rgb(1,2,3)` reports `rgb(1, 2, 3)` and `translateX(
// 10px )` reports `translateX(10px)`. Only the shapes that actually need fixing are matched — a
// comma with no space after it, whitespace against a paren, or whitespace before a comma.
// …a HEX colour (`#fff`), and the LEGACY colour functions, which fold into `rgb()` / `rgba()`
// however they are spelled — `rgb(1 2 3)` carries none of the other marks.
const NEEDS_SERIALIZE_RE =
  /[.'"A-Z+#]|url\(|-0|(?:^|\D)0\d|\d[eE][+-]?\d|,[^ ]|,  |\(\s|\s\)|\s,|[^ ]\/|\/[^ ]|\b(?:rgba?|hsla?|hwb)\(/;
const applySpecifiedForm = (prop, value) => {
  const form = SPECIFIED_FORM[prop];
  // A CSS-WIDE keyword is a value of its own, not a value of the property's grammar: `background-
  // position: initial` reports `initial`, and giving it the shape of a position made it
  // `initial center`.
  if (!form || CSS_WIDE_VALUE_KEYWORDS.has(value.trim().toLowerCase())) return value.trim();
  return form(value.trim());
};

// The handful of properties whose specified value has a canonical SHAPE beyond its tokens. Each is
// Chrome-measured; the rest of the value model needs no such entry.
const SPECIFIED_FORM = Object.assign(Object.create(null), {
  // A dasharray's entries are comma-separated however they were written (`4 2` is `4, 2`) — but
  // NOT re-united: a bare number stays bare here, where the computed value makes it px.
  'stroke-dasharray': (v) => {
    const parts = [];
    for (const entry of splitTopLevel(v, ',')) {
      for (const tok of splitTopLevelWhitespace(entry.trim())) if (tok) parts.push(tok);
    }
    return parts.length ? parts.join(', ') : v;
  },
  // A pair whose halves are equal collapses to one (`border-spacing: 2px 2px` is `2px`), the same
  // rule the box shorthands serialize by.
  'border-spacing': (v) => {
    const parts = splitTopLevelWhitespace(v);
    return parts.length === 2 && parts[0] === parts[1] ? parts[0] : v;
  },
  // A ratio always reports BOTH halves: `aspect-ratio: 1` is `1 / 1`. Only a value that IS one
  // number gains the second — testing the first character alone turned `1 2`, which every browser
  // drops, into the ratio-shaped `1 2 / 1`. (css-tree does not read a `<ratio>` in a value, so this
  // is also where the `/` gets its spaces: the general spacing pass never sees this value.)
  'aspect-ratio': (v) => (BARE_NUMBER_RE.test(v) ? v + ' / 1'
                        : v.indexOf('/') !== -1 ? splitTopLevel(v, '/').map((h) => h.trim()).join(' / ') : v),
});
// …and every `<position>`-valued property, which always reports BOTH axes. Chrome-measured over
// all 471 longhands: these seven are exactly the ones whose bare `0` reports as `0px center`.
// `transform-origin` is among them and takes a third, z-axis length — a value that already names
// both axes passes through untouched, so its three-part form is safe.
//
// Only `background-position` and `mask-position` take one position per LAYER; for the other five a
// comma is not a separator at all (Chrome drops `object-position: top, left`).
const LAYERED_POSITIONS = new Set(['background-position', 'mask-position']);
for (const prop of ['background-position', 'object-position', 'mask-position', 'offset-anchor',
                    'offset-position', 'perspective-origin', 'transform-origin']) {
  SPECIFIED_FORM[prop] = (v) => (LAYERED_POSITIONS.has(prop) ? splitTopLevel(v, ',') : [v]).map((layer) => {
    // Every number in a `<position>` is a LENGTH — the grammar takes nothing else — so a bare zero
    // reports as `0px` here just as it does for a length-valued longhand.
    const parts = splitTopLevelWhitespace(layer.trim()).map((tok) => (isZeroToken(tok) ? '0px' : tok));
    // The missing half is the axis the given one does NOT name: `background-position: top` is
    // `center top`, not `top center`.
    if (parts.length === 1) {
      if (Y_EDGES.has(parts[0].toLowerCase())) parts.unshift('center');
      else parts.push('center');
    }
    return parts.join(' ');
  }).join(', ');
}

// `attr()` is here beside `var()` / `env()`: it substitutes too, and its argument is an attribute
// name this driver does not resolve at parse time.
const PENDING_SUBSTITUTION_RE = /\b(?:var|env|attr)\(/i;

// A value's own whitespace is not reported back: a browser serializes the token sequence, so a
// comma is followed by exactly one space and never preceded by one, and a paren hugs what is
// inside it (`rgb(1,2,3)` is `rgb(1, 2, 3)`; `translateX( 10px )` is `translateX(10px)`). Inside a
// STRING or a `url()` the same characters are content and are left alone.
function normalizeValueSpacing(s) {
  if (s.indexOf(',') === -1 && s.indexOf('(') === -1 && s.indexOf('/') === -1) return s;
  let out = '', quote = '', url = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) { out += c; if (c === '\\') { out += s[++i] || ''; } else if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'") { quote = c; out += c; continue; }
    if (url) { out += c; if (c === '(') url++; else if (c === ')') url--; continue; }
    if (c === '(' && /(?:^|[\s,(])url$/i.test(out)) { url = 1; out += c; continue; }
    if (c === '(') { out += c; while (i + 1 < s.length && /\s/.test(s[i + 1])) i++; continue; }
    if (c === ')') { out = out.replace(/\s+$/, ''); out += c; continue; }
    if (c === ',') { out = out.replace(/\s+$/, '') + ', '; while (i + 1 < s.length && /\s/.test(s[i + 1])) i++; continue; }
    // …and a `/` — the separator between a ratio's two halves, a font's size and line-height, a
    // border-radius' two axes — reports with a space on EACH side (`1/2` is `1 / 2`).
    if (c === '/') { out = out.replace(/\s+$/, '') + ' / '; while (i + 1 < s.length && /\s/.test(s[i + 1])) i++; continue; }
    out += c;
  }
  return out;
}

// The colour functions that fold into the sRGB `rgb()` / `rgba()` serialization. A modern colour
// space (`lab()`, `oklch()`, `color()`) reports itself and is deliberately absent.
const LEGACY_COLOR_FUNCTIONS = new Set(['rgb', 'rgba', 'hsl', 'hsla', 'hwb']);
// A value that is one bare zero, with or without a sign or fraction — the form a length-valued
// property reports as `0px`.
const BARE_ZERO_TOKEN_RE = /(?:^|[\s,(])[+-]?0(?:\.0*)?(?:[\s,)]|$)/;
// …and one TOKEN that is a zero, whatever its spelling.
const isZeroToken = (tok) => BARE_NUMBER_RE.test(tok) && Number(tok) === 0;
// Is the identifier at `loc` the whole comma ENTRY it sits in? `font-family: serif` is; the `Serif`
// of `font-family: PT Serif, serif` is not.
function isWholeEntry(value, loc) {
  return !value.slice(0, loc.start.offset).trim().replace(/,$/, '') &&
         !value.slice(loc.end.offset).trim().replace(/^,[\s\S]*$/, '');
}
// Is `ident` one of the values `prop` takes? A property's own keyword list, the colour keywords
// where it takes a colour, and the css-wide keywords every property takes.
function isKeywordOf(prop, ident) {
  const low = ident.toLowerCase();
  if (CSS_WIDE_VALUE_KEYWORDS.has(low)) return true;
  const kws = PROPERTY_KEYWORDS[prop];
  if (kws && kws.indexOf(low) !== -1) return true;
  const t = PROPERTY_VALUE_TYPES[prop];
  if (t && t.keywords.indexOf(low) !== -1) return true;
  return COLOR_VALUED_PROPERTIES.has(prop) && (COLOR_KEYWORDS.has(low) || low === 'currentcolor');
}

// The CSS functions whose canonical spelling isn't all-lowercase. Everything else folds.
const MIXED_CASE_FUNCTIONS = new Map(
  ['translateX', 'translateY', 'translateZ', 'translate3d', 'scaleX', 'scaleY', 'scaleZ', 'scale3d',
   'rotateX', 'rotateY', 'rotateZ', 'rotate3d', 'skewX', 'skewY', 'matrix3d', 'perspective']
    .map(n => [n.toLowerCase(), n]));
function canonicalFunctionName(name) {
  const low = name.toLowerCase();
  return MIXED_CASE_FUNCTIONS.get(low) || low;
}

export function serializeCssValue(raw, prop) {
  let v = String(raw);
  // A value whose text is still waiting on a SUBSTITUTION is stored exactly as it was written —
  // Chrome canonicalizes `counter( x )` to `counter(x)` but hands `var( --x , 1px )`, `env( safe-
  // area-inset-top )` and `attr( foo , "x" )` back with every space intact, because none of them
  // is a value yet. The validator draws the same line, for the same reason.
  if (PENDING_SUBSTITUTION_RE.test(v)) return v;
  // The property decides three of the rewrites — which identifiers are KEYWORDS of it, whether a
  // bare `0` is a length, and whether the value has a canonical SHAPE of its own — so a value that
  // carries no mark of its own still short-circuits on the cheap test, but only for a property
  // with none of the three to apply.
  if (!NEEDS_SERIALIZE_RE.test(v) &&
      !(prop && (SPECIFIED_FORM[prop] ||
                 (ZERO_IS_LENGTH_PROPERTIES.has(prop) && BARE_ZERO_TOKEN_RE.test(v))))) return v;
  const key = prop ? prop + '|' + v : v;
  const cached = SERIALIZED_VALUES.get(key);
  if (cached !== undefined) return cached;
  const out = serializeCssValueUncached(v, raw, prop);
  // A FALLBACK is not a result: the walk returns the input unchanged when the vendor bundle isn't
  // up yet or the parse throws, and caching that would pin an uncanonical value for this exact
  // string for the rest of the VM's life. `serializeCssValueUncached` flags those.
  if (out === UNCACHEABLE) return raw;
  if (SERIALIZED_VALUES.size >= SERIALIZED_VALUES_MAX) SERIALIZED_VALUES.clear();
  SERIALIZED_VALUES.set(key, out);
  return out;
}

function serializeCssValueUncached(v, raw, prop) {
  const bang = /\s*!\s*important\s*$/i.exec(v);
  if (bang) v = v.slice(0, bang.index);
  // The whitespace rewrite is pure string work and does not depend on the parser — so it happens
  // FIRST, and survives a value the parser cannot read (`aspect-ratio: 1/2` is a `Ratio`, which
  // css-tree does not accept in a value, and the old order threw the spacing away with it).
  const beforeSpacing = v;
  v = normalizeValueSpacing(v);
  const CT = globalThis.__csimVendor && globalThis.__csimVendor.cssTree;
  if (!CT) return UNCACHEABLE;
  let ast;
  try { ast = CT.parse(v, { context: 'value', positions: true }); }
  // A value the parser cannot read goes back EXACTLY as it came. Chrome drops such a declaration
  // outright, so inventing a canonical form for a grammar we failed to parse is the one direction
  // that can lose what the page wrote (`filter: progid:DXImageTransform…`, `width: expression(a,b)`).
  // The ratio `aspect-ratio: 1/2` — the one shape this used to be here for — has its own entry in
  // SPECIFIED_FORM instead.
  catch (_) { return raw; }
  const edits = [];
  let fnDepth = 0;
  CT.walk(ast, { leave(node) { if (node.type === 'Function') fnDepth--; }, enter(node) {
    if (node.type === 'Function') fnDepth++;
    const loc = node.loc;
    if (!loc) return;
    let rep = null;
    // A bare `0` is a LENGTH for a length-valued property, and that is what it serializes as: a
    // measured table, because the alternative — a number-valued property like `opacity` or
    // `flex-grow`, where `0` stays `0` — is not decidable from mdn's grammar for most of them.
    // …at the TOP level only. Inside a function the slot decides the type, and a `repeat()` count
    // or a `scale()` factor is a NUMBER: rewriting `repeat(0, 100px)` to `repeat(0px, 100px)`
    // turned an invalid track list into one this driver then laid out.
    if (node.type === 'Number' && fnDepth === 0 && prop &&
        ZERO_IS_LENGTH_PROPERTIES.has(prop) && Number(node.value) === 0) {
      rep = '0px';
    }
    else if (node.type === 'Number')     rep = normalizeCssNumber(node.value);
    else if (node.type === 'Percentage') rep = normalizeCssNumber(node.value) + '%';
    // A UNIT is ASCII case-insensitive and reported folded (`10PX` → `10px`, `1FR` → `1fr`).
    else if (node.type === 'Dimension')  rep = normalizeCssNumber(node.value) + node.unit.toLowerCase();
    else if (node.type === 'Url')        rep = 'url("' + String(node.value).replace(/(["\\])/g, '\\$1') + '")';
    else if (node.type === 'String')     rep = serializeCssString(node.value);
    // A HEX colour is a colour wherever it stands — in a declaration of its own or inside a
    // gradient — and it reports in the canonical `rgb()` / `rgba()` form, on the specified surface
    // as well as the computed one (`#fff` is `rgb(255, 255, 255)` in `el.style.color`).
    else if (node.type === 'Hash')       rep = normalizeColor('#' + node.value);
    // …and so do the two LEGACY colour functions, which fold into that same form (`hsl(120, 50%,
    // 50%)` is `rgb(64, 191, 64)`, `rgb(1, 2, 3, 0.5)` is `rgba(1, 2, 3, 0.5)`). A modern colour
    // space is left alone — `lab()` and `color()` report themselves — which is what `normalizeColor`
    // already does with them.
    // An IDENTIFIER that is one of this property's KEYWORDS is ASCII case-insensitive and reports
    // folded (`color: RED` is `red`, `animation: 1s LINEAR x` is `linear`). One that is not — a
    // font family, a custom-ident, an animation name — keeps the author's case.
    // …and in a property whose grammar also admits an arbitrary identifier, a keyword is only a
    // keyword when it IS the whole entry: `font-family: serif` is the generic family and folds,
    // while the `Serif` of `font-family: PT Serif` is one word of a family NAME and must not
    // (Chrome keeps `PT Serif`, and the folded spelling is what would reach font resolution).
    else if (node.type === 'Identifier' && prop && isKeywordOf(prop, node.name) &&
             (!OPEN_IDENT_PROPERTIES.has(prop) || isWholeEntry(v, loc))) {
      rep = node.name.toLowerCase();
      if (rep === node.name) rep = null;
    }
    // A FUNCTION name is reported in its CANONICAL spelling, which is lowercase for most but
    // camelCase for the transform family — Chrome keeps `translateX` and folds `BLUR(2PX)` to
    // `blur(2px)`. Only the name is rewritten, so a string or custom-property reference inside
    // keeps its case.
    else if (node.type === 'Function') {
      // A legacy colour function folds WHOLE, into the `rgb()` / `rgba()` form (`hsl(120, 50%, 50%)`
      // is `rgb(64, 191, 64)`) — unless it comes back unchanged, which is what `normalizeColor` does
      // with a colour it cannot read (`rgba(black, .1)`). Then it is just a function like any other,
      // and its NAME still folds: recording the no-op edit instead left `Rgb(1, 2, 3)` uncanonical,
      // because a whole-node edit swallows every edit inside it.
      const text = LEGACY_COLOR_FUNCTIONS.has(node.name.toLowerCase())
        ? v.slice(loc.start.offset, loc.end.offset) : null;
      const canonColor = text === null ? null : normalizeColor(text);
      if (canonColor !== null && canonColor !== text) {
        rep = canonColor;
      } else {
        const canon = canonicalFunctionName(node.name);
        if (canon !== node.name) edits.push([loc.start.offset, loc.start.offset + node.name.length, canon]);
      }
    }
    if (rep !== null) edits.push([loc.start.offset, loc.end.offset, rep]);
  } });
  // A node rewritten WHOLE — a colour function, whose canonical form is computed from the function
  // and not from its parts — swallows the edits its own children queued. Applying both rewrote the
  // arguments and then the whole function over a string those rewrites had already moved, which
  // left the tail of the original behind (`rgba(0, 0, 0, 0.5));`). Contained edits are dropped
  // FIRST, walking outwards-in, and only then is what survives applied back to front.
  edits.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const kept = [];
  let end = -1;
  for (const e of edits) {
    if (e[1] <= end) continue;                       // inside an edit already kept
    kept.push(e);
    end = e[1];
  }
  let s = v;
  for (let i = kept.length - 1; i >= 0; i--) {
    const [a, b, rep] = kept[i];
    s = s.slice(0, a) + rep + s.slice(b);
  }
  s = applySpecifiedForm(prop, s);
  // …against what came IN, not against the already-respaced copy: returning `raw` for a value the
  // spacing pass rewrote handed the caller back the unspaced original.
  if (!kept.length && s === beforeSpacing) return raw;
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
  let depth = 0, start = 0, quote = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = ''; continue; }   // see above
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '\\') { i++; continue; }
    if (ch === '[' || ch === '(') depth++;
    else if (ch === ']' || ch === ')') depth--;
    else if (ch === sep && depth === 0) { parts.push(s.slice(start, i)); start = i + 1; }
  }
  parts.push(s.slice(start));
  return parts;
}
