// CSS shorthand <-> longhand on this side of the style engine: a shorthand's longhands, a shorthand's value split
// into them (`shorthandExpand`, for the keyframes a script hands `animate()`), and a shorthand reconstructed from the
// values of its longhands (`shorthandGet`, for a resolved value whose longhands are layout's). CSSOM's declaration
// blocks are the engine's (cssom_decl.rs); this is what is left beside them.
//
// Shorthand families modelled here:
//   box4    — [top, right, bottom, left]   (margin, padding, border-width/style/color)
//   axis2   — [x, y]                        (overflow)
//   border  — the border megashorthand + its per-side (border-top …) shorthands, over the
//             12 border-<side>-<width|style|color> longhands plus an atomic `border-image`
//   free    — grammar-ordered `A || B || C` shorthands (outline, list-style) whose value is
//             the non-initial components joined in canonical order
//
// A shorthand is reconstructed only when EVERY one of its longhands is present, none has
// already been consumed by a more-preferred shorthand, they share the same importance, and
// their values are jointly representable — matching CSSOM. `border-image` is treated as a
// single atomic longhand (its own 5-longhand expansion is a separate backlog item); no test
// depends on its sub-longhands, and every border case only reads it at its `none` initial.
//
// EXPANSION of the free/border families (`border: 1px solid red` → longhands) classifies
// each token structurally (a <line-style> keyword, a length-ish <line-width>, else a color)
// and does NOT validate the component against a property-value grammar — the driver keeps no
// CSS property-value database, so an invalid component (`border: 50% solid notacolor`) is
// round-tripped rather than dropped, where a real engine rejects the whole declaration. This
// is a bounded limitation of the setter surface, not the block SERIALIZATION the CSSOM gate
// measures (that only reconstructs already-valid longhands).

import { serializeCssValue, splitTopLevel } from './css-utils.js';
import { isStaticallyInvalidMath } from './calc.js';

const CSS_WIDE = new Set(['inherit', 'initial', 'unset', 'revert', 'revert-layer']);
export function isCssWideKeyword(v) { return CSS_WIDE.has(String(v).trim().toLowerCase()); }

function anyCssWide(vals) {
  return vals.some(v => CSS_WIDE.has(v.toLowerCase()));
}

// A css-wide keyword only combines into a shorthand when every longhand carries the SAME
// one (`border: inherit`); a mix (`inherit` alongside a real value, or two different
// css-wide keywords) isn't representable, so the shorthand bails to its longhands.
function combineCssWide(vals) {
  return vals.every(v => v === vals[0]) ? vals[0] : null;
}

// ── box4 / axis2 structural combine + expand ────────────────────────────────

// [top, right, bottom, left] -> the 1..4-value box form (drop mirror-equal trailing
// sides). A css-wide keyword only combines when all four are identical.
export function combineBox(vals) {
  const [t, r, b, l] = vals;
  if (anyCssWide(vals)) return combineCssWide(vals);
  if (t === r && r === b && b === l) return t;
  if (t === b && r === l) return t + ' ' + r;
  if (r === l) return t + ' ' + r + ' ' + b;
  return t + ' ' + r + ' ' + b + ' ' + l;
}

// [x, y] -> `x` when equal, else `x y`. A css-wide keyword combines only when equal.
function combineAxis(vals) {
  const [x, y] = vals;
  if (anyCssWide(vals)) return combineCssWide(vals);
  return x === y ? x : x + ' ' + y;
}

// Expand a box value into [t, r, b, l] with CSS's mirror defaults; an axis value into
// [x, y]. Returns null when the token count is wrong so the caller leaves it as an
// unknown declaration. A css-wide keyword (single token) fills every longhand.
function expandBox(parts) {
  const [a, b, c, d] = parts;
  switch (parts.length) {
    case 1: return [a, a, a, a];
    case 2: return [a, b, a, b];
    case 3: return [a, b, c, b];
    case 4: return [a, b, c, d];
    default: return null;
  }
}

function expandAxis(parts) {
  if (parts.length === 1) return [parts[0], parts[0]];
  if (parts.length === 2) return parts;
  return null;
}

// ── flex shorthand ──────────────────────────────────────────────────────────
// The `flex` longhands are stored / serialized as [flex-grow, flex-basis, flex-shrink] —
// the order Chrome emits them in when they can't be recombined (NOT the flex VALUE order,
// which is `grow shrink basis`). Expansion (matches Chrome): `none` → 0 0 auto, `auto` →
// 1 1 auto, a lone <number> → `n 1 0%`, `<number> <number>` → `g s 0%`, a <flex-basis> →
// `1 1 basis`; a lone css-wide keyword fills every longhand. A flex-basis is any non-number
// token (auto / content / a <length-percentage>).
const FLEX_NUMBER = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i;
// A math function with no DIMENSION anywhere in it — a number, whatever it comes to.
const NUMBER_MATH = /^(?:calc|min|max|clamp)\((?![^]*(?:\d\s*[a-z%]|\.\d*[a-z%]))[^]*\)$/i;
function flexExpand(v) {
  const trimmed = v.trim();
  if (isCssWideKeyword(trimmed)) return [trimmed, trimmed, trimmed];
  if (trimmed.toLowerCase() === 'none') return ['0', 'auto', '0'];   // [grow, basis, shrink]
  const nums = [];
  let basis;
  for (const tok of topLevelTokens(trimmed)) {
    // A number is a flex FACTOR until both are taken; the third one is the BASIS, where a unitless
    // zero is the length CSS lets you write bare. `flex: 1 1 0` is the commonest form of it —
    // Discourse writes it 53 times — and reading the third number as a fourth factor dropped the
    // whole declaration (Chrome: `flex: 1 1 0px`; `flex: 1 1 1`, whose basis is NOT a length, is
    // dropped by Chrome too, and the longhand validator answers for that).
    // (…a math function over plain NUMBERS is one too — `calc(3 - 3)` is the number 0, never a length, so in the
    // BASIS slot it is dropped even where it comes to zero: Chrome drops `flex: 1 2 calc(0)`. It was dropped here only
    // because the specified-value simplifier used to wrap the plain `1 2` beside it in `calc()` as well.)
    if ((FLEX_NUMBER.test(tok) || NUMBER_MATH.test(tok)) && nums.length < 2) nums.push(tok);
    else if (NUMBER_MATH.test(tok)) return null;
    // …and a bare number in the BASIS slot is a length only when it is zero (`flex: 1 1 1` is
    // dropped by Chrome, `flex: 1 1 0` is not).
    else if (FLEX_NUMBER.test(tok) && parseFloat(tok) !== 0) return null;
    else if (basis === undefined) basis = tok;
    else return null;   // a second non-number token → not a valid flex value
  }
  if (nums.length === 0 && basis === undefined) return null;
  const grow   = nums[0] !== undefined ? nums[0] : '1';
  const shrink = nums[1] !== undefined ? nums[1] : '1';
  return [grow, basis !== undefined ? basis : '0%', shrink];
}
// Recombine [flex-grow, flex-basis, flex-shrink] into a flex VALUE (`grow shrink basis`);
// a css-wide keyword only combines when all three are the SAME one (else the block bails to
// its longhands — flex-serialization's mixed-keyword cases).
function flexCombine(vals) {
  if (anyCssWide(vals)) return combineCssWide(vals);
  return vals[0] + ' ' + vals[2] + ' ' + vals[1];
}

// ── border / outline / list-style component classification ──────────────────

const LINE_STYLES = new Set(['none', 'hidden', 'dotted', 'dashed', 'solid', 'double',
  'groove', 'ridge', 'inset', 'outset']);

export function isLineStyle(tok) { return LINE_STYLES.has(tok.toLowerCase()); }
// `auto` is a line style for an OUTLINE only (css-ui: the UA's own focus ring). Sharing `border`'s
// list left it in the colour slot, where it collided with the real colour and dropped the whole
// declaration — `outline: 1px auto -webkit-focus-ring-color`, which is in every focus reset.
const isOutlineStyle = (tok) => isLineStyle(tok) || tok.toLowerCase() === 'auto';

// A <line-width>: the thin/medium/thick keywords, a non-negative length/number token, or a MATH
// function — `calc(2px)` is a length wherever a length is allowed, and reading it as anything else
// puts it in the colour slot, where it collides with the real colour and invalidates the whole
// shorthand. That is not cosmetic: an unparseable shorthand is DROPPED, so `border: calc(2px)
// solid red` painted no border at all. Scientific notation (`1e2px`) is a length too, and the
// bare-token regex refused it for the same reason.
const MATH_FUNCTION_RE = /^(calc|min|max|clamp|round|mod|rem|abs|sign)\(/i;
export function isLineWidth(tok) {
  const t = tok.toLowerCase();
  if (t === 'thin' || t === 'medium' || t === 'thick') return true;
  if (MATH_FUNCTION_RE.test(t)) return !isStaticallyInvalidMath(tok);
  return /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?[a-z%]*$/i.test(tok);
}

// Split `border: 1px solid red` into its <line-width> || <line-style> || <color>
// components (order-independent), each falling back to its initial. Returns null when a
// token fits no slot or a slot is filled twice (an invalid shorthand — left unexpanded).
function parseLineComponents(value, initials) {
  const out = { width: null, style: null, color: null };
  for (const tok of topLevelTokens(value)) {
    let slot;
    if (isLineStyle(tok)) slot = 'style';
    else if (isLineWidth(tok)) slot = 'width';
    else slot = 'color';
    if (out[slot] != null) return null;
    out[slot] = tok;
  }
  return {
    width: out.width == null ? initials.width : out.width,
    style: out.style == null ? initials.style : out.style,
    color: out.color == null ? initials.color : out.color,
  };
}

// ── shorthand registry ──────────────────────────────────────────────────────
//
// Each entry: { longhands, serialize, expand }. `serialize(vals)` maps the aligned bare
// longhand values to the shorthand value string, or null when they don't jointly combine
// (side values differ, a border-image override is present, …). `expand(value)` maps a
// shorthand value to the aligned longhand values, or null when unrepresentable.

const BORDER_SIDES = ['top', 'right', 'bottom', 'left'];
const BORDER_PARTS = ['width', 'style', 'color'];
const BORDER_INITIAL = { width: 'medium', style: 'none', color: 'currentcolor' };
const BORDER_IMAGE_INITIAL = 'none';

// The 12 physical border longhands in property-major order (all widths, all styles, all
// colors), plus the atomic border-image — the canonical longhand order the `border`
// shorthand expands into.
const BORDER_LONGHANDS = [
  ...BORDER_PARTS.flatMap(part => BORDER_SIDES.map(side => `border-${side}-${part}`)),
  'border-image',
];

// Join the non-initial members of `[width, style, color]` in grammar order, or the width
// initial when every component is initial (a bare all-initial border/outline).
function serializeLine(width, style, color, initials) {
  const parts = [];
  if (width !== initials.width) parts.push(width);
  if (style !== initials.style) parts.push(style);
  if (color !== initials.color) parts.push(color);
  return parts.length ? parts.join(' ') : initials.width;
}

// `side` is a physical edge (`top`) or a flow-relative one (`block-start`) — the longhand names
// are built the same way for both, and so is the `width || style || color` serialization.
function borderSideDef(side) {
  const longhands = BORDER_PARTS.map(part => `border-${side}-${part}`);
  return {
    longhands,
    serialize(vals) {
      if (anyCssWide(vals)) return combineCssWide(vals);
      return serializeLine(vals[0], vals[1], vals[2], BORDER_INITIAL);
    },
    expand(value) {
      if (CSS_WIDE.has(value.toLowerCase())) return [value, value, value];
      const c = parseLineComponents(value, BORDER_INITIAL);
      return c && [c.width, c.style, c.color];
    },
  };
}

function borderBoxDef(part) {
  const longhands = BORDER_SIDES.map(side => `border-${side}-${part}`);
  return {
    longhands,
    serialize(vals) { return combineBox(vals); },
    expand(value) { return expandBox(topLevelTokens(value)); },
  };
}

const BORDER_DEF = {
  longhands: BORDER_LONGHANDS,
  serialize(vals) {
    if (anyCssWide(vals)) return combineCssWide(vals);
    const byName = {};
    BORDER_LONGHANDS.forEach((lh, i) => { byName[lh] = vals[i]; });
    if (byName['border-image'] !== BORDER_IMAGE_INITIAL) return null;
    // Every side must agree per component for the four-way `border` to be representable.
    const pick = {};
    for (const part of BORDER_PARTS) {
      const vs = BORDER_SIDES.map(side => byName[`border-${side}-${part}`]);
      if (!vs.every(v => v === vs[0])) return null;
      pick[part] = vs[0];
    }
    // A css-wide component was already handled above (it makes the 13 values non-uniform,
    // so `border` isn't representable and we returned null there).
    return serializeLine(pick.width, pick.style, pick.color, BORDER_INITIAL);
  },
  expand(value) {
    if (CSS_WIDE.has(value.toLowerCase())) return BORDER_LONGHANDS.map(() => value);
    const c = parseLineComponents(value, BORDER_INITIAL);
    if (!c) return null;
    // Every side gets the same component; border-image resets to its initial.
    return BORDER_LONGHANDS.map(lh => (lh === 'border-image'
      ? BORDER_IMAGE_INITIAL
      : c[lh.slice(lh.lastIndexOf('-') + 1)]));
  },
};

// A shorthand serializes into two surfaces — the SPECIFIED one (`.style.animation` and the style
// attribute) and the COMPUTED one (`getComputedStyle`) — and which of them lists EVERY component,
// including those still at their initial, differs per shorthand, in opposite directions: Firefox
// reads `column-rule` as `3px none rgb(0, 0, 0)` but writes the shortest form, while `animation` reads back
// `2s linear infinite spin` and writes `animation: 2s linear 0s infinite normal none running spin`.
// One `serialize` feeds both surfaces, so each def names its exhaustive one.
const showsAll = (opts, specified) => !!opts && opts.showAll === (specified ? 'specified' : 'computed');

// A value carrying a SUBSTITUTION can only be decomposed once it RESOLVES, and that happens per
// element (a custom property inherits) — so it is never decomposed structurally. See
// `pendingSubstitution` below for what stands in for it until then.
const SUBSTITUTION_RE = /\b(var|env)\(/i;
export function hasSubstitution(value) { return SUBSTITUTION_RE.test(String(value)); }

// ── pending substitution (css-variables-1 §3) ────────────────────────────────
// The stand-in a shorthand's longhand holds while its value still carries a substitution. The
// shorthand can't be decomposed yet, but it must still OCCUPY its longhands' slots: Chrome measured
// `margin-top: 9px; margin: var(--m)` computing the top from `--m`, so the shorthand wins the slots
// it would have won with a literal value — keeping the declaration whole under its own name instead
// let the earlier `margin-top` survive. Each slot therefore records its SOURCE shorthand and that
// shorthand's original text, which is enough for the two things the platform asks of it:
//   * serialize as the empty string on its own, and as the original text via the shorthand;
//   * re-expand per element at resolved-value time (`declaredValue` in style-proxy).
// The marker is a control character, which no CSS value can contain, so a pending value can never
// be mistaken for a real one — and being a PREFIX it survives the `!important` split unchanged.
// It also passes through `serializeCssValue` untouched (that canonicaliser rewrites by offset and
// its trigger regex never matches a control char), which is load-bearing: a pending value is
// canonicalised on several paths before anything looks at whether it is pending.
const PENDING = '\u0001';
export function pendingSubstitution(shorthand, value) {
  return PENDING + shorthand + PENDING + String(value).trim();
}
// → { shorthand, value } for a pending substitution, else null. Importance must already be split
// off (every caller reads the bare value).
export function pendingSource(v) {
  if (typeof v !== 'string' || v.charCodeAt(0) !== 1) return null;
  const end = v.indexOf(PENDING, 1);
  return end < 0 ? null : { shorthand: v.slice(1, end), value: v.slice(end + 1) };
}

// Best-effort round-trip of a free-order group: assign each token to the first component whose
// matcher accepts it and that nothing has filled yet. A token no component claims fails the whole
// expansion (the declaration is left unexpanded). Returns the per-longhand values, or null.
// A substitution never reaches here — `shorthandExpand` turns it into pending slots first.
function placeTokens(components, initials, toks) {
  const out = initials.slice();
  const filled = components.map(() => false);
  for (const tok of toks) {
    let placed = false;
    for (let i = 0; i < components.length; i++) {
      if (!filled[i] && components[i][2](tok)) { out[i] = tok; filled[i] = true; placed = true; break; }
    }
    if (!placed) return null;
  }
  // A component may claim a token that ALSO belongs to a later one (`list-style: none` sets
  // both the image and the type); each declares the extra slots it fills.
  for (let i = 0; i < components.length; i++) {
    const also = filled[i] && components[i][3];
    if (also) for (const [j, v] of also(out[i]) || []) if (!filled[j]) { out[j] = v; filled[j] = true; }
  }
  return out;
}

// A grammar-ordered `A || B || C` shorthand: `components` lists [longhand, initial] in
// canonical order; the value is the non-initial components joined, and an omitted
// component resolves to its initial when set as the whole shorthand.
function freeDef(components, opts) {
  const longhands = components.map(c => c[0]);
  const initials = components.map(c => c[1]);
  return {
    longhands,
    serialize(vals, specified) {
      if (anyCssWide(vals)) return combineCssWide(vals);
      if (showsAll(opts, specified)) return vals.join(' ');
      const parts = vals.filter((v, i) => v !== initials[i]);
      return parts.length ? parts.join(' ') : initials[0];
    },
    // A sole css-wide keyword fills every longhand; a css-wide keyword mixed with other
    // tokens is rejected up front by shorthandExpand's shared guard.
    expand(value) {
      const toks = topLevelTokens(value);
      if (toks.length === 1 && CSS_WIDE.has(toks[0].toLowerCase())) return longhands.map(() => toks[0]);
      return placeTokens(components, initials, toks);
    },
  };
}

const isUrlOrNone = tok => tok.toLowerCase() === 'none' || /^(url|image|linear-gradient|radial-gradient|conic-gradient)\(/i.test(tok);

// `text-emphasis`: [style, color]. The style is `none`, a string, or a FILL and / or a SHAPE keyword (either order,
// each at most once); anything else is the one colour.
const TE_FILL = /^(filled|open)$/i, TE_SHAPE = /^(dot|circle|double-circle|triangle|sesame)$/i;
function textEmphasisExpand(value) {
  const toks = topLevelTokens(value);
  if (toks.length === 1 && CSS_WIDE.has(toks[0].toLowerCase())) return [toks[0], toks[0]];
  let fill = null, shape = null, other = null, color = null;
  for (const t of toks) {
    const free = fill == null && shape == null && other == null;
    if (TE_FILL.test(t) && fill == null && other == null) fill = t;
    else if (TE_SHAPE.test(t) && shape == null && other == null) shape = t;
    else if (free && (/^none$/i.test(t) || t[0] === '"' || t[0] === "'")) other = t;
    else if (color == null) color = t;
    else return null;
  }
  const style = other ?? ([fill, shape].filter(Boolean).join(' ') || 'none');
  return [style, color ?? 'currentcolor'];
}

// ── font-variant (7 constituent longhands, CSS Fonts 4) ──────────────────────
// Order is the shorthand's canonical serialization order (ligatures … emoji). Each
// longhand's initial is `normal`; the shorthand's own `none` sets ligatures `none` and the
// rest `normal`.
const FV_LIG = 'font-variant-ligatures', FV_CAPS = 'font-variant-caps', FV_ALT = 'font-variant-alternates',
      FV_NUM = 'font-variant-numeric', FV_EA = 'font-variant-east-asian', FV_POS = 'font-variant-position',
      FV_EMOJI = 'font-variant-emoji';
const FONT_VARIANT_LONGHANDS = [FV_LIG, FV_CAPS, FV_ALT, FV_NUM, FV_EA, FV_POS, FV_EMOJI];
// Each shorthand keyword → the longhand it belongs to (for expanding a value list). The
// alternates functions (stylistic()/styleset()/…) are matched separately.
const FONT_VARIANT_KEYWORDS = {};
const fvKw = (sub, ...ks) => ks.forEach(k => { FONT_VARIANT_KEYWORDS[k] = sub; });
fvKw(FV_LIG, 'common-ligatures', 'no-common-ligatures', 'discretionary-ligatures', 'no-discretionary-ligatures',
     'historical-ligatures', 'no-historical-ligatures', 'contextual', 'no-contextual');
fvKw(FV_CAPS, 'small-caps', 'all-small-caps', 'petite-caps', 'all-petite-caps', 'unicase', 'titling-caps');
fvKw(FV_ALT, 'historical-forms');
fvKw(FV_NUM, 'lining-nums', 'oldstyle-nums', 'proportional-nums', 'tabular-nums', 'diagonal-fractions',
     'stacked-fractions', 'ordinal', 'slashed-zero');
fvKw(FV_EA, 'jis78', 'jis83', 'jis90', 'jis04', 'simplified', 'traditional', 'full-width', 'proportional-width', 'ruby');
fvKw(FV_POS, 'sub', 'super');
fvKw(FV_EMOJI, 'text', 'emoji', 'unicode');
const FONT_VARIANT_ALT_FN = /^(?:stylistic|styleset|character-variant|swash|ornaments|annotation)\(/i;

// [lig, caps, alt, num, ea, pos, emoji] → the shorthand value, or null when not representable
// (CSSOM "serialize a CSS value"): all-same css-wide keyword → that keyword; a mixed css-wide
// → null; ligatures `none` with the rest `normal` → `none` (else null); otherwise the
// non-`normal` longhand values joined in canonical order (`normal` when every longhand is).
function fontVariantSerialize(vals) {
  const low = vals.map(v => v.trim().toLowerCase());
  if (low.some(v => CSS_WIDE.has(v))) return low.every(v => v === low[0]) ? low[0] : null;
  if (low[0] === 'none') return low.slice(1).every(v => v === 'normal') ? 'none' : null;
  const parts = [];
  for (let i = 0; i < low.length; i++) if (low[i] !== 'normal') parts.push(vals[i]);
  return parts.length ? parts.join(' ') : 'normal';
}

function fontVariantExpand(value) {
  const v = value.trim().toLowerCase();
  if (v === 'normal')     return FONT_VARIANT_LONGHANDS.map(() => 'normal');
  if (CSS_WIDE.has(v))    return FONT_VARIANT_LONGHANDS.map(() => v);
  if (v === 'none')       return FONT_VARIANT_LONGHANDS.map(lh => (lh === FV_LIG ? 'none' : 'normal'));
  // A value list: bucket each token onto its longhand (an unknown token is invalid → null).
  const buckets = {};
  for (const tok of topLevelTokens(value)) {
    const sub = FONT_VARIANT_ALT_FN.test(tok) ? FV_ALT : FONT_VARIANT_KEYWORDS[tok.toLowerCase()];
    if (!sub) return null;
    (buckets[sub] || (buckets[sub] = [])).push(tok);
  }
  return FONT_VARIANT_LONGHANDS.map(lh => (buckets[lh] ? buckets[lh].join(' ') : 'normal'));
}

// A logical (flow-relative) 2-value shorthand — `margin-block` = [<block-start>, <block-end>].
// `border-<axis>-<component>` over its two flow sides — same axis2 shape as `logicalPairDef`, but
// the component sits AFTER the side in each longhand name.
function borderAxisDef(axis, component) {
  return {
    longhands: [`border-${axis}-start-${component}`, `border-${axis}-end-${component}`],
    serialize: combineAxis,
    expand: v => expandAxis(topLevelTokens(v)),
    group: `border-${component}`,
  };
}

// `border-block` / `border-inline`: the `width || style || color` triple applied to BOTH sides of
// one axis. Six longhands, and it is representable only when the two sides agree on each part —
// the same rule the physical `border` follows across its four.
function borderFlowAxisDef(axis) {
  const sides = [`${axis}-start`, `${axis}-end`];
  const longhands = sides.flatMap(side => BORDER_PARTS.map(part => `border-${side}-${part}`));
  return {
    longhands,
    serialize(vals) {
      if (anyCssWide(vals)) return combineCssWide(vals);
      const start = vals.slice(0, BORDER_PARTS.length);
      const end   = vals.slice(BORDER_PARTS.length);
      if (!start.every((v, i) => v === end[i])) return null;
      return serializeLine(start[0], start[1], start[2], BORDER_INITIAL);
    },
    expand(value) {
      if (CSS_WIDE.has(value.toLowerCase())) return longhands.map(() => value);
      const c = parseLineComponents(value, BORDER_INITIAL);
      return c && [c.width, c.style, c.color, c.width, c.style, c.color];
    },
  };
}

function logicalPairDef(group, axis) {
  return {
    longhands: [`${group}-${axis}-start`, `${group}-${axis}-end`],
    serialize: combineAxis,
    expand: v => expandAxis(topLevelTokens(v)),
    group,
  };
}


// ── Shorthands whose longhands nothing else in the CSSOM model reaches ───────────────────────
// Each was previously invisible: the cascade saw `transition: opacity 1s` and no
// `transition-duration`, so a resolved-value read of the longhand had to answer "unknowable".
// Every serialization below is Chrome measured.

// A comma-separated LAYER list (`transition`, `animation`): each layer is a free-order group,
// and each longhand becomes the comma-joined list of its per-layer values. A layer that fails
// to parse invalidates the whole declaration, as it does in a browser.
function layerDef(components, emptyToken, opts) {
  const longhands = components.map(c => c[0]);
  const initials  = components.map(c => c[1]);
  return {
    longhands,
    serialize(vals, specified) {
      if (anyCssWide(vals)) return combineCssWide(vals);
      const layers = vals.map(v => splitTopLevel(v, ','));
      const count  = Math.max(...layers.map(l => l.length));
      const out = [];
      for (let i = 0; i < count; i++) {
        // CSS repeats a shorter list CYCLICALLY across the layers — with two durations and four
        // properties, layer 3 takes duration[1], not duration[0].
        const all = layers.map((l, c) => (l.length ? l[i % l.length] : initials[c]).trim());
        // (…and a component the shorthand reads by POSITION stays where a later one is written: of two times, the
        // first is the duration — `transition: opacity 0s 0.2s` is a delay, and `opacity 0.2s` a duration, so the
        // 0s cannot be left out. Chrome leaves it out, and its own serialization reads back as something else.)
        const kept = all.map((v, c) => v !== initials[c]);
        for (const [later, earlier] of (opts && opts.keeps) || []) if (kept[later]) kept[earlier] = true;
        const set = all.filter((v, c) => kept[c]);
        // Nothing set in this layer at all → the shorthand's own "nothing" token: `none` for
        // `animation`, `all` for `transition`, not whichever component happens to be listed first.
        // Otherwise, whichever form this shorthand spells out in full.
        const parts = set.length === 0 ? [] : (showsAll(opts, specified) ? all : set);
        out.push(parts.length ? parts.join(' ') : emptyToken);
      }
      return out.join(', ');
    },
    expand(value) {
      const toks = topLevelTokens(value);
      if (toks.length === 1 && CSS_WIDE.has(toks[0].toLowerCase())) return longhands.map(() => toks[0]);
      const perLonghand = longhands.map(() => []);
      for (const layer of splitTopLevel(value, ',')) {
        const layerToks = topLevelTokens(layer.trim());
        // An EMPTY layer means a malformed list — a trailing or doubled comma. A browser drops
        // the whole declaration; inventing an all-initials layer instead made
        // `transition: opacity 1s,` report two layers.
        if (!layerToks.length) return null;
        const out = placeTokens(components, initials, layerToks);
        if (!out) return null;
        out.forEach((v, i) => perLonghand[i].push(v));
      }
      return perLonghand.map(vs => vs.join(', '));
    },
  };
}

// A SLASH-separated positional shorthand (`grid-area: 1 / 2 / 3 / 4`). An omitted trailing
// component repeats the one it mirrors, per the grid-placement grammar.
const CUSTOM_IDENT_RE = /^-?[a-zA-Z_][\w-]*$/;
function slashDef(longhands, mirror) {
  // The omitted END of a grid placement is `auto` — UNLESS the start is a custom ident (a line
  // name), which it then repeats. Chrome measured: `grid-column: 2` ends `auto`, `grid-column:
  // myline` ends `myline`, and `grid-area: span 2 / 3` leaves both ends `auto`.
  const omitted = (start) => (start !== undefined && CUSTOM_IDENT_RE.test(start) &&
                              !/^(auto|span)$/i.test(start)) ? start : 'auto';
  return {
    longhands,
    serialize(vals) {
      if (anyCssWide(vals)) return combineCssWide(vals);
      const parts = vals.slice();
      while (parts.length > 1 && parts[parts.length - 1] === omitted(parts[mirror[parts.length - 1]])) parts.pop();
      return parts.join(' / ');
    },
    expand(value) {
      const parts = splitTopLevel(value, '/').map(t => t.trim()).filter(Boolean);
      if (!parts.length || parts.length > longhands.length) return null;
      // Resolve left to right and mirror off the RESOLVED value: `grid-area: myarea` fills all
      // four, because each end mirrors a start that was itself filled in by this loop.
      const out = [];
      for (let i = 0; i < longhands.length; i++) {
        out[i] = parts[i] !== undefined ? parts[i] : omitted(out[mirror[i]]);
      }
      return out;
    },
  };
}

// A positional 1-or-2-value shorthand where the second defaults to the first (`gap`,
// `place-items`, `overscroll-behavior`).
// A modifier binds to the alignment keyword that FOLLOWS it, so `safe center` is one value, not
// two (Chrome measured: `place-content: safe center` gives both longhands `safe center`).
const ALIGN_MODIFIER_RE = /^(safe|unsafe|first|last)$/i;
function pairDef(longhands) {
  return {
    longhands,
    serialize(vals) {
      if (anyCssWide(vals)) return combineCssWide(vals);
      return vals[0] === vals[1] ? vals[0] : vals.join(' ');
    },
    expand(value) {
      const toks = topLevelTokens(value);
      if (!toks.length) return null;
      // Group into VALUES first: a modifier binds to the keyword that follows it, so
      // `safe center safe start` is two values, not four tokens. `first baseline` reduces to
      // `baseline` — the modifier is the default and a browser drops it (Chrome measured).
      const values = [];
      for (let i = 0; i < toks.length; i++) {
        if (ALIGN_MODIFIER_RE.test(toks[i]) && i + 1 < toks.length) {
          values.push(/^first$/i.test(toks[i]) && /^baseline$/i.test(toks[i + 1])
            ? toks[i + 1] : `${toks[i]} ${toks[i + 1]}`);
          i++;
        } else {
          values.push(toks[i]);
        }
      }
      if (values.length === 1) return [values[0], values[0]];
      if (values.length === 2) return [values[0], values[1]];
      return null;
    },
  };
}

const TIMING_FN   = /^(linear|ease(-in)?(-out)?|ease-in-out|step-(start|end)|steps\(|cubic-bezier\(|linear\()/i;
const TIME_VALUE  = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?m?s$/i;
// …or a MATH FUNCTION of times (`calc(1s + 100ms)`, `min(0.3s, 200ms)`), which is a `<time>` the same slot takes: read
// as neither, it fell to `transition-property`'s catch-all beside the real property name, and the layer — the whole
// declaration with it — was dropped where Chrome keeps `transition: opacity calc(1s + 100ms) ease`.
const TIME_MATH = /^(?:calc|min|max|clamp)\([^]*\d(?:m?s)\b/i;
const isTime = (t) => TIME_VALUE.test(t) || TIME_MATH.test(t);
// …and the DURATION slot takes only a non-negative one: a negative time in an `animation` or
// `transition` shorthand can only be the DELAY (Chrome-measured: `transition: -1s` is a −1s delay
// with the initial 0s duration, and `animation: -1s` likewise). Taking it as the duration wrote an
// invalid `animation-duration: -1s`, which the longhand grammar then dropped — taking the whole
// declaration with it.
// (A math one's sign is its computed value's business: at parse time it is a `<time>`, and the first is the duration.)
const DURATION_VALUE = (t) => (TIME_VALUE.test(t) && parseFloat(t) >= 0) || TIME_MATH.test(t);
const ANIM_DIR    = /^(normal|reverse|alternate|alternate-reverse)$/i;
const ANIM_FILL   = /^(none|forwards|backwards|both)$/i;
const ANIM_STATE  = /^(running|paused)$/i;
const ANIM_COUNT  = /^(?:infinite|[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)$/i;
const TRANS_BEHAVIOR = /^(normal|allow-discrete)$/i;

// `font` is the odd one: it RESETS every font longhand it doesn't mention (Chrome — `font: bold
// 16px serif` gives `font-style: normal`), and its size may carry a `/line-height`.
const FONT_STYLE_RE   = /^(normal|italic|oblique)$/i;
const FONT_WEIGHT_RE  = /^(normal|bold|bolder|lighter|[1-9]00|1000)$/i;
const FONT_STRETCH_RE = /^(normal|(ultra|extra|semi)-(condensed|expanded)|condensed|expanded)$/i;
// Exported for the CASCADE only — `font` is deliberately absent from the registry below, because
// the CSSOM block model has a tested serialization contract for it (system-font keywords like
// `font: menu`, and resetting every font-variant longhand) that this parse doesn't model. What the
// cascade needs is narrower and safe: the size / family / style / weight / line-height a page
// actually wrote, so a resolved-value read of those longhands stops answering "unknowable".
export const FONT_SHORTHAND = {
  longhands: ['font-style', 'font-variant', 'font-weight', 'font-stretch', 'font-size', 'line-height', 'font-family'],
  serialize(vals) {
    if (anyCssWide(vals)) return combineCssWide(vals);
    const [style, variant, weight, stretch, size, lineHeight, family] = vals;
    if (!size || !family) return '';
    const head = [style, variant, weight, stretch].filter(v => v && v !== 'normal' && v !== '400');
    const sizePart = (lineHeight && lineHeight !== 'normal') ? `${size} / ${lineHeight}` : size;
    return [...head, sizePart, family].join(' ');
  },
  expand(value) {
    const toks = topLevelTokens(value);
    if (toks.length === 1 && CSS_WIDE.has(toks[0].toLowerCase())) return FONT_SHORTHAND.longhands.map(() => toks[0]);
    // A SYSTEM font keyword (`font: menu`) takes its values from the platform; we have none to
    // give, so the declaration is left whole rather than expanded into invented ones.
    if (toks.length === 1 && /^(caption|icon|menu|message-box|small-caption|status-bar)$/i.test(toks[0])) return null;
    // Everything before the SIZE is the free-order head; the size (with an optional
    // `/line-height`) is followed by the family list, which runs to the end.
    let style = 'normal', variant = 'normal', weight = 'normal', stretch = 'normal';
    let i = 0;
    for (; i < toks.length; i++) {
      const t = toks[i];
      if (FONT_STYLE_RE.test(t) && style === 'normal' && !/^normal$/i.test(t)) { style = t; continue; }
      if (FONT_WEIGHT_RE.test(t) && weight === 'normal' && !/^normal$/i.test(t)) { weight = t; continue; }
      if (FONT_STRETCH_RE.test(t) && stretch === 'normal' && !/^normal$/i.test(t)) { stretch = t; continue; }
      if (/^(normal|small-caps)$/i.test(t)) { if (/^small-caps$/i.test(t)) variant = t; continue; }
      break;                                                   // the size token
    }
    if (i >= toks.length) return null;
    const sizeTok = toks[i++];
    const slash = splitTopLevel(sizeTok, '/').map(t => t.trim()).filter(Boolean);
    let size = slash[0], lineHeight = slash[1] || 'normal';
    // `12px / 2` can also arrive as three tokens.
    if (lineHeight === 'normal' && toks[i] === '/') { lineHeight = toks[i + 1]; i += 2; }
    else if (lineHeight === 'normal' && toks[i] && toks[i].startsWith('/')) { lineHeight = toks[i].slice(1); i += 1; }
    const family = toks.slice(i).join(' ');
    if (!size || !family) return null;
    return [style, variant, weight, stretch, size, lineHeight, family];
  },
};

// `border-radius` is the one box shorthand with an ELLIPTICAL form: `50% / 20%` gives every corner
// a horizontal AND a vertical radius, and each corner longhand carries both (Chrome measured:
// `border-top-left-radius` is `50% 20%`, the shorthand `50% / 20%`). Running it through the plain
// 4-value expander wrote a literal `/` into a declaration.
const BORDER_RADIUS_DEF = {
  longhands: ['border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius'],
  serialize(vals) {
    if (anyCssWide(vals)) return combineCssWide(vals);
    // TOP-LEVEL tokens: a corner radius can be a function whose arguments contain spaces
    // (`calc(10px + 5px)`), and splitting on whitespace turned one value into three.
    const axis = (i) => vals.map(v => {
      const parts = topLevelTokens(String(v).trim());
      return parts[i] !== undefined ? parts[i] : parts[0];
    });
    const h = combineBox(axis(0)), v = combineBox(axis(1));
    return h === v ? h : `${h} / ${v}`;
  },
  expand(value) {
    const sides = splitTopLevel(value, '/').map(t => t.trim()).filter(Boolean);
    if (!sides.length || sides.length > 2) return null;
    const h = expandBox(topLevelTokens(sides[0]));
    if (!h) return null;
    const v = sides[1] ? expandBox(topLevelTokens(sides[1])) : h;
    if (!v) return null;
    return h.map((hv, i) => (hv === v[i] ? hv : `${hv} ${v[i]}`));
  },
};

const SHORTHANDS = {
  overflow: { longhands: ['overflow-x', 'overflow-y'], serialize: combineAxis, expand: v => expandAxis(topLevelTokens(v)) },
  margin:   { longhands: BORDER_SIDES.map(s => `margin-${s}`),  serialize: combineBox, expand: v => expandBox(topLevelTokens(v)), group: 'margin' },
  padding:  { longhands: BORDER_SIDES.map(s => `padding-${s}`), serialize: combineBox, expand: v => expandBox(topLevelTokens(v)), group: 'padding' },
  // `inset` is the box shorthand over the four PHYSICAL inset longhands, whose names are not
  // `inset-<side>` but the bare `top` / `right` / `bottom` / `left` (css-logical §3.1) — which is
  // why it could not be spelled with the `<prefix>-<side>` families above and was missing
  // entirely: `el.style.inset = '1px 2px 3px 4px'` set nothing at all.
  inset:    { longhands: BORDER_SIDES, serialize: combineBox, expand: v => expandBox(topLevelTokens(v)), group: 'inset' },
  'inset-block':    logicalPairDef('inset', 'block'),
  'inset-inline':   logicalPairDef('inset', 'inline'),
  'margin-block':   logicalPairDef('margin', 'block'),
  'margin-inline':  logicalPairDef('margin', 'inline'),
  'padding-block':  logicalPairDef('padding', 'block'),
  'padding-inline': logicalPairDef('padding', 'inline'),
  'scroll-margin-block':   logicalPairDef('scroll-margin', 'block'),
  'scroll-margin-inline':  logicalPairDef('scroll-margin', 'inline'),
  // The BORDER axis shorthands are `border-<axis>-<component>` over the two flow sides, so their
  // longhand names interleave differently from the box families above (`border-block-start-width`,
  // not `border-width-block-start`). Registering them is what lets a read reconstruct one from the
  // two sides — `border-block-start-width: 2px; border-block-end-width: 2px` reports
  // `border-block-width: 2px`, and differing sides report `2px 4px` (Chrome measured); before this
  // the axis name resolved to its initial `medium`.
  'border-block-width':   borderAxisDef('block', 'width'),
  'border-block-style':   borderAxisDef('block', 'style'),
  'border-block-color':   borderAxisDef('block', 'color'),
  'border-inline-width':  borderAxisDef('inline', 'width'),
  'border-inline-style':  borderAxisDef('inline', 'style'),
  'border-inline-color':  borderAxisDef('inline', 'color'),
  'scroll-padding-block':  logicalPairDef('scroll-padding', 'block'),
  'scroll-padding-inline': logicalPairDef('scroll-padding', 'inline'),

  'border-width': borderBoxDef('width'),
  'border-style': borderBoxDef('style'),
  'border-color': borderBoxDef('color'),
  'border-top':    borderSideDef('top'),
  'border-right':  borderSideDef('right'),
  'border-bottom': borderSideDef('bottom'),
  'border-left':   borderSideDef('left'),
  // The FLOW-RELATIVE side shorthands, which the CSSOM had no idea about: `border-inline-start`
  // was stored as an unknown property, so it round-tripped verbatim while setting none of its
  // longhands and never being composed from them. (The CASCADE understood it, which is why the
  // computed value looked right and only the declaration was empty — one property, two layers,
  // and only one of them had been told.)
  'border-block-start':  borderSideDef('block-start'),
  'border-block-end':    borderSideDef('block-end'),
  'border-inline-start': borderSideDef('inline-start'),
  'border-inline-end':   borderSideDef('inline-end'),
  // …and the two AXIS shorthands over them: `border-inline: 1px solid red` is both inline sides,
  // and it serializes only when the two agree on every component.
  'border-block':  borderFlowAxisDef('block'),
  'border-inline': borderFlowAxisDef('inline'),
  border:          BORDER_DEF,

  outline: freeDef([
    ['outline-color', 'currentcolor', tok => !isOutlineStyle(tok) && !isLineWidth(tok)],
    ['outline-style', 'none',         isOutlineStyle],
    ['outline-width', 'medium',       isLineWidth],
  ]),
  // `list-style: none` is the one grammar-ordered shorthand where a token feeds TWO components:
  // CSS Lists says a lone `none` sets both the type and the image, so placing it in the image slot
  // alone (first matcher wins) left `list-style-type` at `disc` — and at inline precedence that
  // then beat an author `ul { list-style-type: none }`.
  'list-style': freeDef([
    ['list-style-position', 'outside', tok => /^(inside|outside)$/i.test(tok)],
    ['list-style-image',    'none',    isUrlOrNone, v => /^none$/i.test(v) ? [[2, 'none']] : null],
    ['list-style-type',     'disc',    () => true],
  ]),
  'font-variant': { longhands: FONT_VARIANT_LONGHANDS, serialize: fontVariantSerialize, expand: fontVariantExpand },
  flex: { longhands: ['flex-grow', 'flex-basis', 'flex-shrink'], serialize: flexCombine, expand: flexExpand },
  // `transition-property` is a catch-all — anything that isn't a time or an easing is a property
  // name — so every OTHER keyword component has to be excluded from it by hand. `transition:
  // display .3s allow-discrete` (the popover / `display` idiom) otherwise matched nothing at all
  // and the whole declaration was dropped. Chrome measured: the behavior serializes LAST, and
  // `transition: normal` sets the behavior, not a property named `normal`.
  transition: layerDef([
    ['transition-property',        'all',    t => !isTime(t) && !TIMING_FN.test(t) && !TRANS_BEHAVIOR.test(t)],
    ['transition-duration',        '0s',     DURATION_VALUE],
    ['transition-timing-function', 'ease',   t => TIMING_FN.test(t)],
    ['transition-delay',           '0s',     isTime],
    ['transition-behavior',        'normal', t => TRANS_BEHAVIOR.test(t)],
  ], 'all', { keeps: [[3, 1]] }),
  animation: layerDef([
    ['animation-duration',        '0s',      DURATION_VALUE],
    ['animation-timing-function', 'ease',    t => TIMING_FN.test(t)],
    ['animation-delay',           '0s',      isTime],
    ['animation-iteration-count', '1',       t => ANIM_COUNT.test(t)],
    ['animation-direction',       'normal',  t => ANIM_DIR.test(t)],
    ['animation-fill-mode',       'none',    t => ANIM_FILL.test(t)],
    ['animation-play-state',      'running', t => ANIM_STATE.test(t)],
    ['animation-name',            'none',    () => true],
  ], 'none', { showAll: 'specified' }),
  // (…a computed one the shortest form too, as Firefox gives it — `row`, where Chrome lists `row nowrap`)
  'flex-flow': freeDef([
    ['flex-direction', 'row',    t => /^(row|column)(-reverse)?$/i.test(t)],
    ['flex-wrap',      'nowrap', t => /^(nowrap|wrap|wrap-reverse)$/i.test(t)],
  ]),
  gap:                  pairDef(['row-gap', 'column-gap']),
  'place-items':        pairDef(['align-items', 'justify-items']),
  'place-content':      pairDef(['align-content', 'justify-content']),
  'place-self':         pairDef(['align-self', 'justify-self']),
  'overscroll-behavior': pairDef(['overscroll-behavior-x', 'overscroll-behavior-y']),
  'border-radius': BORDER_RADIUS_DEF,
  // `group` is what puts these sides into LOGICAL_GROUP alongside their `-block` / `-inline`
  // twins, so the CSSOM logical-property-group move and the interleaving guard see them — the
  // same treatment `margin` / `padding` get. Without it the group was half-registered and
  // `scroll-margin-block-start; scroll-margin-top; scroll-margin-block-start` didn't reorder.
  'scroll-margin':  { longhands: BORDER_SIDES.map(s => `scroll-margin-${s}`),  serialize: combineBox, expand: v => expandBox(topLevelTokens(v)), group: 'scroll-margin' },
  'scroll-padding': { longhands: BORDER_SIDES.map(s => `scroll-padding-${s}`), serialize: combineBox, expand: v => expandBox(topLevelTokens(v)), group: 'scroll-padding' },
  'grid-area':   slashDef(['grid-row-start', 'grid-column-start', 'grid-row-end', 'grid-column-end'], [null, 0, 0, 1]),
  'grid-row':    slashDef(['grid-row-start', 'grid-row-end'], [null, 0]),
  'grid-column': slashDef(['grid-column-start', 'grid-column-end'], [null, 0]),
  columns: freeDef([
    ['column-width', 'auto', t => /^(auto|[\d.]+[a-z%]+)$/i.test(t)],
    ['column-count', 'auto', () => true],
  ]),
  // (…whose computed form lists every component, as Firefox gives it — `3px none rgb(0, 0, 0)`, where Chrome drops the
  // `none`)
  'column-rule': freeDef([
    ['column-rule-width', 'medium',       t => /^(thin|medium|thick|[\d.]+[a-z]*)$/i.test(t)],
    ['column-rule-style', 'none',         t => /^(none|hidden|dotted|dashed|solid|double|groove|ridge|inset|outset)$/i.test(t)],
    ['column-rule-color', 'currentcolor', () => true],
  ], { showAll: 'computed' }),
  // …whose STYLE is one or TWO tokens — a fill beside a shape, `filled circle` — so it cannot be a one-token-per-
  // longhand `freeDef`: that placed `circle` as a second style and returned no expansion, which since the validator
  // drops an undecomposable shorthand dropped `text-emphasis: filled circle red` everywhere Chrome keeps it.
  'text-emphasis': { ...freeDef([
    ['text-emphasis-style', 'none',         () => false],
    ['text-emphasis-color', 'currentcolor', () => true],
  ], { showAll: 'computed' }), expand: textEmphasisExpand },
};

// longhand name -> the shorthands it belongs to, in the block serializer's preferred order.
// Every registered shorthand the block serializer should reconstruct, most-preferred first. A
// shorthand missing here isn't a cosmetic gap: `writeStoreProp` re-serializes the whole block on
// every write, so an element already carrying `transition: opacity 1s` has its style attribute
// exploded into four longhands the first time any property is set on it.
const PREFERRED = ['border', 'border-width', 'border-style', 'border-color',
  'border-top', 'border-right', 'border-bottom', 'border-left',
  // The flow-relative border family. ORDER matters here as it does above: the wider `border-block`
  // is tried before the two sides it covers, so a declaration that names both collapses to it
  // rather than to two side shorthands.
  'border-block', 'border-inline',
  // The per-component axis shorthands were REGISTERED but never listed here, and both
  // `LONGHAND_TO_SHORTHANDS` and `LOGICAL_GROUP` are built from this list alone — so they were
  // never reconstructed and their `group` field was dead. Chrome prefers them over two side
  // shorthands (measured), which is why they sit above the sides.
  'border-block-width', 'border-block-style', 'border-block-color',
  'border-inline-width', 'border-inline-style', 'border-inline-color',
  'border-block-start', 'border-block-end', 'border-inline-start', 'border-inline-end',
  'outline', 'list-style', 'font-variant', 'flex',
  'margin', 'margin-block', 'margin-inline', 'padding', 'padding-block', 'padding-inline',
  'overflow', 'border-radius', 'transition', 'animation', 'flex-flow', 'gap',
  'place-items', 'place-content', 'place-self', 'overscroll-behavior',
  'scroll-margin', 'scroll-margin-block', 'scroll-margin-inline',
  'scroll-padding', 'scroll-padding-block', 'scroll-padding-inline',
  'grid-area', 'grid-row', 'grid-column',
  'columns', 'column-rule', 'text-emphasis',
  // …and the inset family, widest first, exactly as the border one is ordered above. The two axis
  // names were listed here before there was anything registered to reconstruct them.
  'inset', 'inset-block', 'inset-inline'];

const LONGHAND_TO_SHORTHANDS = {};
for (const name of PREFERRED) {
  for (const lh of SHORTHANDS[name].longhands) {
    (LONGHAND_TO_SHORTHANDS[lh] || (LONGHAND_TO_SHORTHANDS[lh] = [])).push(name);
  }
}

// longhand name -> its logical property group id, for CSSOM's interleaving rule: a shorthand
// isn't serialized when a declaration from the SAME logical property group but a different
// mapping (physical vs flow-relative) sits between its longhands. Built from every grouped
// shorthand's longhands (margin's physical sides + margin-block/inline's flow-relative edges
// all share the `margin` group).
const LOGICAL_GROUP = {};
for (const name of PREFERRED) {
  const def = SHORTHANDS[name];
  if (def.group) for (const lh of def.longhands) LOGICAL_GROUP[lh] = def.group;
}

export function isRegularShorthand(name) {
  return Object.prototype.hasOwnProperty.call(SHORTHANDS, name);
}

export function shorthandLonghands(name) {
  return SHORTHANDS[name] ? SHORTHANDS[name].longhands : null;
}

// Split a stored value into its canonical value + importance flag.
function splitImp(v) {
  const m = /\s*!\s*important\s*$/i.exec(v || '');
  return m ? { value: String(v).slice(0, m.index).trim(), important: true }
           : { value: String(v || '').trim(), important: false };
}

// Split a shorthand value into top-level space-separated tokens (respecting parens),
// so `1px 2px` / `scroll hidden` become their components while `rgb(1, 2, 3)` stays whole.
// (…a STRING is one token whatever it holds: `list-style: "+ " inside` split its marker string at the space into two
// halves, neither a valid `list-style-type`, and dropped the declaration Chrome keeps.)
function topLevelTokens(value) {
  const out = [];
  let depth = 0, start = 0, quote = '';
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '\\') { i++; continue; }
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (depth === 0 && /\s/.test(c)) {
      if (i > start) out.push(value.slice(start, i));
      start = i + 1;
    }
  }
  if (value.length > start) out.push(value.slice(start));
  return out;
}

// The shorthand getter: combine the current longhand values into the shorthand's
// serialized form, or '' when a longhand is missing / the values don't combine. `specified` picks
// the SPECIFIED-value surface (`.style.animation`, the style attribute) over the computed one.
export function shorthandGet(decls, name, specified) {
  const def = SHORTHANDS[name];
  if (!def) return '';
  const parts = def.longhands.map(lh => decls[lh]);
  if (parts.some(p => p == null)) return '';
  const split = parts.map(splitImp);
  if (!split.every(s => s.important === split[0].important)) return '';
  // Every slot still pending on THIS shorthand → its original text, which is what a browser reports
  // for `el.style.margin` after `margin: var(--m)` (measured). Any other mix — some slots pending,
  // or pending on a different shorthand — isn't representable as this shorthand.
  const pending = split.map(s => pendingSource(s.value));
  if (pending.some(Boolean)) {
    return pending.every(p => p && p.shorthand === name && p.value === pending[0].value) ? pending[0].value : '';
  }
  const combined = def.serialize(split.map((s, i) => serializeCssValue(s.value, def.longhands[i])), specified);
  return combined == null ? '' : combined;
}

// Expand `name: value` (a shorthand) into a list of [longhand, value] pairs, or null when
// `name` isn't a shorthand or the value can't be split. Importance is carried onto every
// longhand.
export function shorthandExpand(name, value) {
  const def = SHORTHANDS[name];
  if (!def) return null;
  const { value: bare, important } = splitImp(value);
  const trimmed = bare.trim();
  const imp = important ? ' !important' : '';
  // A SUBSTITUTION can't be decomposed until it resolves, but the shorthand still fills every slot
  // it names — each longhand takes a pending substitution until the resolved-value read expands it.
  if (hasSubstitution(trimmed)) return def.longhands.map(lh => [lh, pendingSubstitution(name, trimmed) + imp]);
  // A css-wide keyword (inherit/initial/…) is only valid as the SOLE token of a shorthand:
  // `margin: inherit 1px` and `border: 1px solid inherit` are invalid and must be ignored,
  // not split. (A lone css-wide keyword fills every longhand — handled by each expander.)
  const toks = topLevelTokens(trimmed);
  if (toks.length > 1 && anyCssWide(toks)) return null;
  const sides = def.expand(trimmed);
  if (!sides) return null;
  return def.longhands.map((lh, i) => [lh, sides[i] + imp]);
}
