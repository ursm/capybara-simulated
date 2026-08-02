// CSS shorthand <-> longhand serialization for CSSOM: the "serialize a CSS declaration
// block" shorthand reconstruction (longhands collapse to `margin: 1px 2px`, `border: 1px`)
// plus the shorthand getter/setter surface (`style.overflow`, `style.border`).
//
// The store is uniformly longhand-based: every shorthand a stylesheet author writes is
// EXPANDED to its ultimate longhands on the way in (`expandDeclList`), and the block
// serializer reconstructs the most-preferred shorthand on the way out (`serializeDeclBlock`),
// following CSSOM's "serialize a CSS declaration block" algorithm.
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
import { LONGHANDS, SHORTHAND_LONGHANDS } from './css-property-data.js';

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
function flexExpand(v) {
  const trimmed = v.trim();
  if (isCssWideKeyword(trimmed)) return [trimmed, trimmed, trimmed];
  if (trimmed.toLowerCase() === 'none') return ['0', 'auto', '0'];   // [grow, basis, shrink]
  const nums = [];
  let basis;
  for (const tok of topLevelTokens(trimmed)) {
    if (FLEX_NUMBER.test(tok)) { if (nums.length === 2) return null; nums.push(tok); }
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

function isLineStyle(tok) { return LINE_STYLES.has(tok.toLowerCase()); }

// A <line-width>: the thin/medium/thick keywords or a non-negative length/number token.
function isLineWidth(tok) {
  const t = tok.toLowerCase();
  return t === 'thin' || t === 'medium' || t === 'thick' || /^[\d.]+[a-z%]*$/i.test(tok);
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

// A grammar-ordered `A || B || C` shorthand: `components` lists [longhand, initial] in
// canonical order; the value is the non-initial components joined, and an omitted
// component resolves to its initial when set as the whole shorthand.
function freeDef(components) {
  const longhands = components.map(c => c[0]);
  const initials = components.map(c => c[1]);
  return {
    longhands,
    serialize(vals) {
      if (anyCssWide(vals)) return combineCssWide(vals);
      const parts = vals.filter((v, i) => v !== initials[i]);
      return parts.length ? parts.join(' ') : initials[0];
    },
    // Best-effort round-trip: assign each token to the first component whose matcher
    // accepts it. Unmatched tokens fail the expansion (left as an unknown declaration).
    // A sole css-wide keyword fills every longhand; a css-wide keyword mixed with other
    // tokens is rejected up front by shorthandExpand's shared guard.
    expand(value) {
      const toks = topLevelTokens(value);
      if (toks.length === 1 && CSS_WIDE.has(toks[0].toLowerCase())) return longhands.map(() => toks[0]);
      const out = initials.slice();
      const filled = longhands.map(() => false);
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
    },
  };
}

const isUrlOrNone = tok => tok.toLowerCase() === 'none' || /^(url|image|linear-gradient|radial-gradient|conic-gradient)\(/i.test(tok);

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
function layerDef(components) {
  const longhands = components.map(c => c[0]);
  const initials  = components.map(c => c[1]);
  return {
    longhands,
    serialize(vals) {
      if (anyCssWide(vals)) return combineCssWide(vals);
      const layers = vals.map(v => splitTopLevel(v, ','));
      const count  = Math.max(...layers.map(l => l.length));
      const out = [];
      for (let i = 0; i < count; i++) {
        // CSS repeats a shorter list CYCLICALLY across the layers — with two durations and four
        // properties, layer 3 takes duration[1], not duration[0].
        const parts = layers.map((l, c) => (l.length ? l[i % l.length] : initials[c]).trim())
                            .filter((v, c) => v !== initials[c]);
        out.push(parts.length ? parts.join(' ') : initials[0]);
      }
      return out.join(', ');
    },
    expand(value) {
      const toks = topLevelTokens(value);
      if (toks.length === 1 && CSS_WIDE.has(toks[0].toLowerCase())) return longhands.map(() => toks[0]);
      const perLonghand = longhands.map(() => []);
      for (const layer of splitTopLevel(value, ',')) {
        const out = initials.slice();
        const filled = longhands.map(() => false);
        for (const tok of topLevelTokens(layer.trim())) {
          let placed = false;
          for (let i = 0; i < components.length; i++) {
            if (!filled[i] && components[i][2](tok)) { out[i] = tok; filled[i] = true; placed = true; break; }
          }
          if (!placed) return null;
        }
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
const TIME_VALUE  = /^-?[\d.]+m?s$/i;
const ANIM_DIR    = /^(normal|reverse|alternate|alternate-reverse)$/i;
const ANIM_FILL   = /^(none|forwards|backwards|both)$/i;
const ANIM_STATE  = /^(running|paused)$/i;
const ANIM_COUNT  = /^(infinite|[\d.]+)$/i;

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

const SHORTHANDS = {
  overflow: { longhands: ['overflow-x', 'overflow-y'], serialize: combineAxis, expand: v => expandAxis(topLevelTokens(v)) },
  margin:   { longhands: BORDER_SIDES.map(s => `margin-${s}`),  serialize: combineBox, expand: v => expandBox(topLevelTokens(v)), group: 'margin' },
  padding:  { longhands: BORDER_SIDES.map(s => `padding-${s}`), serialize: combineBox, expand: v => expandBox(topLevelTokens(v)), group: 'padding' },
  'margin-block':   logicalPairDef('margin', 'block'),
  'margin-inline':  logicalPairDef('margin', 'inline'),
  'padding-block':  logicalPairDef('padding', 'block'),
  'padding-inline': logicalPairDef('padding', 'inline'),
  'inset-block':  { longhands: ['inset-block-start', 'inset-block-end'],   serialize: combineAxis, expand: v => expandAxis(topLevelTokens(v)) },
  'inset-inline': { longhands: ['inset-inline-start', 'inset-inline-end'], serialize: combineAxis, expand: v => expandAxis(topLevelTokens(v)) },

  'border-width': borderBoxDef('width'),
  'border-style': borderBoxDef('style'),
  'border-color': borderBoxDef('color'),
  'border-top':    borderSideDef('top'),
  'border-right':  borderSideDef('right'),
  'border-bottom': borderSideDef('bottom'),
  'border-left':   borderSideDef('left'),
  border:          BORDER_DEF,

  outline: freeDef([
    ['outline-color', 'currentcolor', tok => !isLineStyle(tok) && !isLineWidth(tok)],
    ['outline-style', 'none',         isLineStyle],
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
  transition: layerDef([
    ['transition-property',        'all',  t => !TIME_VALUE.test(t) && !TIMING_FN.test(t)],
    ['transition-duration',        '0s',   t => TIME_VALUE.test(t)],
    ['transition-timing-function', 'ease', t => TIMING_FN.test(t)],
    ['transition-delay',           '0s',   t => TIME_VALUE.test(t)],
  ]),
  animation: layerDef([
    ['animation-duration',        '0s',      t => TIME_VALUE.test(t)],
    ['animation-timing-function', 'ease',    t => TIMING_FN.test(t)],
    ['animation-delay',           '0s',      t => TIME_VALUE.test(t)],
    ['animation-iteration-count', '1',       t => ANIM_COUNT.test(t)],
    ['animation-direction',       'normal',  t => ANIM_DIR.test(t)],
    ['animation-fill-mode',       'none',    t => ANIM_FILL.test(t)],
    ['animation-play-state',      'running', t => ANIM_STATE.test(t)],
    ['animation-name',            'none',    () => true],
  ]),
  'flex-flow': freeDef([
    ['flex-direction', 'row',    t => /^(row|column)(-reverse)?$/i.test(t)],
    ['flex-wrap',      'nowrap', t => /^(nowrap|wrap|wrap-reverse)$/i.test(t)],
  ]),
  gap:                  pairDef(['row-gap', 'column-gap']),
  'place-items':        pairDef(['align-items', 'justify-items']),
  'place-content':      pairDef(['align-content', 'justify-content']),
  'place-self':         pairDef(['align-self', 'justify-self']),
  'overscroll-behavior': pairDef(['overscroll-behavior-x', 'overscroll-behavior-y']),
  'border-radius': {
    longhands: ['border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius'],
    serialize: combineBox,
    expand: v => expandBox(topLevelTokens(v)),
  },
  'scroll-margin':  { longhands: BORDER_SIDES.map(s => `scroll-margin-${s}`),  serialize: combineBox, expand: v => expandBox(topLevelTokens(v)) },
  'scroll-padding': { longhands: BORDER_SIDES.map(s => `scroll-padding-${s}`), serialize: combineBox, expand: v => expandBox(topLevelTokens(v)) },
  'grid-area':   slashDef(['grid-row-start', 'grid-column-start', 'grid-row-end', 'grid-column-end'], [null, 0, 0, 1]),
  'grid-row':    slashDef(['grid-row-start', 'grid-row-end'], [null, 0]),
  'grid-column': slashDef(['grid-column-start', 'grid-column-end'], [null, 0]),
  columns: freeDef([
    ['column-width', 'auto', t => /^(auto|[\d.]+[a-z%]+)$/i.test(t)],
    ['column-count', 'auto', () => true],
  ]),
  'column-rule': freeDef([
    ['column-rule-width', 'medium',       t => /^(thin|medium|thick|[\d.]+[a-z]*)$/i.test(t)],
    ['column-rule-style', 'none',         t => /^(none|hidden|dotted|dashed|solid|double|groove|ridge|inset|outset)$/i.test(t)],
    ['column-rule-color', 'currentcolor', () => true],
  ]),
  'text-emphasis': freeDef([
    ['text-emphasis-style', 'none',         t => /^(none|filled|open|dot|circle|double-circle|triangle|sesame)$/i.test(t) || t[0] === '"' || t[0] === "'"],
    ['text-emphasis-color', 'currentcolor', () => true],
  ]),
};

// longhand name -> the shorthands it belongs to, in the block serializer's preferred order.
const PREFERRED = ['border', 'border-width', 'border-style', 'border-color',
  'border-top', 'border-right', 'border-bottom', 'border-left',
  'outline', 'list-style', 'font-variant', 'flex',
  'margin', 'margin-block', 'margin-inline', 'padding', 'padding-block', 'padding-inline',
  'overflow'];

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

// CSSOM interleaving guard: with the longhands at positions [min..max] in the block, is there
// a declaration between them that shares the shorthand's logical group but isn't one of its
// longhands? (Only grouped shorthands — margin/padding + their logical pairs — can trip this;
// ungrouped ones like border/overflow have no `group` and skip the check entirely.)
function logicallyInterleaved(def, keys, pos) {
  const lhSet = new Set(def.longhands);
  let min = Infinity, max = -Infinity;
  for (const lh of def.longhands) { const p = pos.get(lh); if (p < min) min = p; if (p > max) max = p; }
  for (let i = min + 1; i < max; i++) {
    const k = keys[i];
    if (!lhSet.has(k) && LOGICAL_GROUP[k] === def.group) return true;
  }
  return false;
}

export function isRegularShorthand(name) {
  return Object.prototype.hasOwnProperty.call(SHORTHANDS, name);
}

export function shorthandLonghands(name) {
  return SHORTHANDS[name] ? SHORTHANDS[name].longhands : null;
}

// Remove from a decl map every longhand NAMED after the non-registry shorthand `name`
// (`name-*`) — used when such a shorthand (font / background / …) is set or cleared so a
// stale sub-property doesn't outlive it (`font: menu` clears the font-variant-* longhands).
// Name-prefix is used deliberately rather than mdn's SHORTHAND_LONGHANDS, whose data is a
// computed-value resolution, not a true expansion (it lists `border-width` for
// `border-inline-start`, which would wrongly wipe all four physical sides). A shorthand whose
// longhands aren't name-prefixed (`inset` → top/right/…) leaves them, as before — we don't
// expand it, so this is a no-op there, never an over-clear. Only a KNOWN shorthand acts, so a
// plain longhand set (`font-size`) never triggers it.
export function clearNamedLonghands(decls, name) {
  if (SHORTHAND_LONGHANDS[name] === undefined) return;
  const prefix = name + '-';
  for (const k of Object.keys(decls)) if (k.startsWith(prefix)) delete decls[k];
}

// ── declaration-block plumbing ──────────────────────────────────────────────

// Return a NEW declaration map with every shorthand key replaced by its longhands (order
// preserved), so the CSSOM store is uniformly longhand-based: a `style="overflow: hidden"`
// source and a `style.overflowX = …` write end up in the same shape. A shorthand re-sets
// the longhands it names, moving them to the end (a later `border-top` after `border`
// serializes last — the observable ordering real engines produce). A shorthand whose value
// can't be split is left as-is (an invalid declaration that passes through).
// The same expansion driven by an ORDERED declaration list, so a longhand re-declared after a
// shorthand wins (`margin-left: 7px; margin: 1px; margin-left: 9px` → 9px). A map can't express
// that: it keeps a re-declared property at its first position, which is where a block serializes
// it but NOT where the cascade applies it.
export function expandDeclList(list) {
  const out = Object.create(null);
  for (const { prop, value } of list) {
    // `setDecl` is what carries the rules a raw assignment loses: a later NORMAL declaration
    // never clobbers an `!important` one within the same block, a re-declared key moves to the
    // end when its logical group needs the reorder, and — below — an `all` in the block makes
    // every subsequent property positionally last, which is how `allGet` picks the winner.
    const involvesAll = prop === 'all' || out.all !== undefined;
    if (isRegularShorthand(prop)) {
      const pairs = shorthandExpand(prop, value);
      if (pairs) { for (const [lh, v] of pairs) setDecl(out, lh, v, true); continue; }
    }
    setDecl(out, prop, value, involvesAll);
  }
  return out;
}


// The flow-relative mapping of a logical-property-group longhand: physical sides
// (margin-top) vs flow-relative edges (margin-inline-start). Only meaningful for grouped
// longhands (LOGICAL_GROUP[name] set).
function mappingLogic(prop) {
  if (/-(top|right|bottom|left)$/.test(prop)) return 'physical';
  if (/-(block|inline)-(start|end)$/.test(prop)) return 'logical';
  return null;
}

// A flow-relative (logical) longhand of a modelled group — the presence of one is what can
// trigger the group move/interleaving rules (a physical-only block never needs them).
function isLogicalLonghand(prop) {
  return LOGICAL_GROUP[prop] !== undefined && mappingLogic(prop) === 'logical';
}

// CSSOM "set a CSS declaration" for logical property groups: re-setting an EXISTING grouped
// declaration re-appends it at the end only when the group both holds a different-mapping-
// logic declaration AND a same-group declaration currently sits after it — i.e. leaving it in
// place would reorder it relative to a sibling. A physical-only group (no mapping mix) or a
// declaration already last in its group updates in place. This keeps `margin: …; margin-
// inline: …; margin-bottom: …` ordering the flow-relative sides after the physical box while
// not disturbing an unrelated re-set.
export function groupNeedsMove(out, name) {
  const g = LOGICAL_GROUP[name];
  if (!g) return false;
  const keys = Object.keys(out);
  const idx = keys.indexOf(name);
  if (idx < 0) return false;   // a brand-new declaration simply appends
  const m = mappingLogic(name);
  let differentMapping = false, sameGroupAfter = false;
  for (let i = 0; i < keys.length; i++) {
    if (i === idx || LOGICAL_GROUP[keys[i]] !== g) continue;
    if (mappingLogic(keys[i]) !== m) differentMapping = true;
    if (i > idx) sameGroupAfter = true;
  }
  return differentMapping && sameGroupAfter;
}

// Set `out[name] = value`. Within a declaration block an `!important` declaration wins
// over a normal one regardless of source order, so a later normal write never clobbers an
// existing important one. The declaration re-appends at the end when a shorthand expansion
// re-sets it (`moveToEnd`) or the logical-property-group rule demands it — reproducing the
// order browsers serialize.
function setDecl(out, name, value, moveToEnd) {
  const existing = out[name];
  if (existing !== undefined && splitImp(existing).important && !splitImp(value).important) return;
  if (groupNeedsMove(out, name)) moveToEnd = true;
  if (moveToEnd && name in out) delete out[name];
  out[name] = value;
}

// Split a stored value into its canonical value + importance flag.
function splitImp(v) {
  const m = /\s*!\s*important\s*$/i.exec(v || '');
  return m ? { value: String(v).slice(0, m.index).trim(), important: true }
           : { value: String(v || '').trim(), important: false };
}

// Split a shorthand value into top-level space-separated tokens (respecting parens),
// so `1px 2px` / `scroll hidden` become their components while `rgb(1, 2, 3)` stays whole.
function topLevelTokens(value) {
  const out = [];
  let depth = 0, start = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
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
// serialized form, or '' when a longhand is missing / the values don't combine.
export function shorthandGet(decls, name) {
  const def = SHORTHANDS[name];
  if (!def) return '';
  const parts = def.longhands.map(lh => decls[lh]);
  if (parts.some(p => p == null)) return '';
  const split = parts.map(splitImp);
  if (!split.every(s => s.important === split[0].important)) return '';
  const combined = def.serialize(split.map(s => serializeCssValue(s.value)));
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
  // A css-wide keyword (inherit/initial/…) is only valid as the SOLE token of a shorthand:
  // `margin: inherit 1px` and `border: 1px solid inherit` are invalid and must be ignored,
  // not split. (A lone css-wide keyword fills every longhand — handled by each expander.)
  const toks = topLevelTokens(trimmed);
  if (toks.length > 1 && anyCssWide(toks)) return null;
  const sides = def.expand(trimmed);
  if (!sides) return null;
  const imp = important ? ' !important' : '';
  return def.longhands.map((lh, i) => [lh, sides[i] + imp]);
}

// Serialize a canonical `name: value;` declaration (value canonicalized unless it's a
// custom property, importance preserved).
function declText(name, value) {
  // A custom property is stored UNESCAPED; serialize its name as a CSS identifier (CSSOM
  // "serialize an identifier") so a name holding `;` / `\` / a leading digit round-trips
  // (`--a;b` → `--a\;b`). The value is kept verbatim (not canonicalized).
  if (name.startsWith('--')) return (globalThis.CSS && globalThis.CSS.escape ? globalThis.CSS.escape(name) : name) + ': ' + value + ';';
  const { value: bare, important } = splitImp(value);
  return name + ': ' + serializeCssValue(bare) + (important ? ' !important' : '') + ';';
}

// CSSOM "serialize a CSS declaration block" with shorthand reconstruction: walk the
// declarations in order; for the first-unconsumed longhand of a shorthand, try each
// shorthand it belongs to in preferred order, emitting the most-preferred one whose every
// longhand is present, unconsumed, uniformly-important, and jointly representable. Custom
// properties and non-shorthand longhands pass through (value-canonicalized).
export function serializeDeclBlock(decls) {
  // When the block carries `all`, first drop the declarations it subsumes (dead covered
  // declarations before it, and covered declarations after it equal to its keyword), so
  // `all` serializes compactly — this also removes any covered longhand that came before
  // `all`, so no shorthand can straddle it in the reconstruction below.
  if (decls.all !== undefined) decls = allCollapse(decls);
  const done = new Set();
  const out = [];
  const keys = Object.keys(decls);
  // The interleaving guard only bites when a flow-relative longhand is present (a grouped
  // shorthand's non-longhand interleaver is always a logical sibling); skip its position
  // bookkeeping — the whole `pos` Map — otherwise, which is the overwhelmingly common case.
  const anyLogical = keys.some(isLogicalLonghand);
  const pos = anyLogical ? new Map(keys.map((k, i) => [k, i])) : null;
  for (const name of keys) {
    if (done.has(name)) continue;
    let emitted = false;
    for (const shName of LONGHAND_TO_SHORTHANDS[name] || []) {
      const def = SHORTHANDS[shName];
      if (!def.longhands.every(lh => decls[lh] != null && !done.has(lh))) continue;
      if (def.group && anyLogical && logicallyInterleaved(def, keys, pos)) continue;
      const split = def.longhands.map(lh => splitImp(decls[lh]));
      if (!split.every(s => s.important === split[0].important)) continue;
      const combined = def.serialize(split.map(s => serializeCssValue(s.value)));
      if (combined == null) continue;
      out.push(shName + ': ' + combined + (split[0].important ? ' !important' : '') + ';');
      def.longhands.forEach(lh => done.add(lh));
      emitted = true;
      break;
    }
    if (emitted) continue;
    out.push(declText(name, decls[name]));
    done.add(name);
  }
  return out.join(' ');
}

// CSSOM cssText serialization of a block containing `all` (cssstyledeclaration-csstext-all
// -shorthand): drop the declarations `all` subsumes so it serializes compactly. A covered
// declaration BEFORE `all` is dead (it overrides it); a covered declaration AFTER `all`
// whose value equals its keyword is redundant with it — both are removed. `direction` /
// `unicode-bidi` / custom properties (never covered) and a covered declaration that
// overrides `all` with a DIFFERENT value are kept, in place.
function allCollapse(decls) {
  const keys   = Object.keys(decls);
  const allPos = keys.indexOf('all');
  const all    = splitImp(decls.all);
  const kw     = all.value.trim().toLowerCase();
  const out = {};
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (k === 'all')          { out.all = decls.all; continue; }
    if (!isCoveredByAll(k))   { out[k] = decls[k]; continue; }
    const s = splitImp(decls[k]);
    // Does `all` win the cascade for k? importance-first, then source order — so an
    // `!important` covered declaration survives even before a normal `all` (and a normal one
    // after `all` still overrides). A declaration `all` overrides is dead; one that merely
    // restates `all` (same value AND importance) is redundant. Either way it drops.
    const allWins = s.important === all.important ? i < allPos : all.important;
    if (allWins) continue;
    if (s.value.trim().toLowerCase() === kw && s.important === all.important) continue;
    out[k] = decls[k];
  }
  return out;
}

// ── CSSOM `all` shorthand (css-cascade "all") ────────────────────────────────
// `all` resets every longhand EXCEPT `direction` / `unicode-bidi` (and custom properties).
// It only accepts a css-wide keyword. Rather than expand it to ~470 longhands (which would
// blow up `length`/`cssText`), it is stored as a single plain `all` key; a covered property
// then reads back `all`'s keyword UNLESS the property is (re)declared AFTER `all` in the
// block — which the decl map's key order captures (writes move a re-declared covered key —
// and `all` itself — to the end). Every hook below is gated by the caller on an `all` key
// being present (`decls.all !== undefined`), so the overwhelmingly common no-`all` path is
// byte-identical and pays nothing.
const ALL_EXCLUDED = new Set(['direction', 'unicode-bidi']);

// Whether `all` resets `name` (so an `all` declaration supplies its value / removeProperty
// ('all') clears it): a standard longhand or shorthand, other than the two excluded
// longhands, `all` itself, and custom properties.
export function isCoveredByAll(name) {
  return name !== 'all' && name.charCodeAt(0) !== 45 /* '-' */ && !ALL_EXCLUDED.has(name) &&
         (LONGHANDS.has(name) || SHORTHAND_LONGHANDS[name] !== undefined);
}

// The declaration that WINS for `lh` between its own declaration (if any) and `all`, as
// `{value, important}` (value bare). The cascade within one block is importance-first, then
// source order: an `!important` declaration beats a normal one regardless of position, and
// among equal importance the later one wins. Returns null when `lh` is unset and not covered.
// `all` is the pre-split `{value, important}` of the `all` declaration; `kw` its bare value.
function allWinner(decls, pos, allPos, all, kw, lh) {
  const i = pos.has(lh) ? pos.get(lh) : -1;
  const covered = isCoveredByAll(lh);
  if (i < 0) return covered ? { value: kw, important: all.important } : null;
  const own = splitImp(decls[lh]);
  if (!covered) return own;   // `all` doesn't reset it (direction / unicode-bidi / custom)
  const allWins = own.important === all.important ? i < allPos : all.important;
  return allWins ? { value: kw, important: all.important } : own;
}

// getPropertyValue for a block that contains an `all` declaration. `name` is any property.
export function allGet(decls, name) {
  const keys   = Object.keys(decls);
  const pos    = new Map(keys.map((k, i) => [k, i]));
  const allPos = pos.get('all');
  const all    = splitImp(decls.all);
  const kw     = all.value.trim().toLowerCase();
  // `all` serializes to its keyword iff no covered property OVERRIDES it (with a different
  // value or importance).
  if (name === 'all') {
    for (const k of keys) {
      if (k === 'all' || !isCoveredByAll(k)) continue;
      const w = allWinner(decls, pos, allPos, all, kw, k);
      if (w.value !== kw || w.important !== all.important) return '';
    }
    return kw;
  }
  // A shorthand we fully model: resolve each longhand, then reconstruct via its serializer.
  if (isRegularShorthand(name)) {
    const eff = {};
    for (const lh of shorthandLonghands(name)) {
      const w = allWinner(decls, pos, allPos, all, kw, lh);
      if (w == null) return '';
      eff[lh] = w.value + (w.important ? ' !important' : '');
    }
    return shorthandGet(eff, name);
  }
  const mdnLhs = SHORTHAND_LONGHANDS[name];
  if (mdnLhs) {
    // A shorthand we DON'T expand (font, background, …) is stored as a single key. If its own
    // declaration wins over `all` (and isn't merely a redundant restatement of it), it applies
    // verbatim.
    const i = pos.has(name) ? pos.get(name) : -1;
    if (i >= 0) {
      const own = splitImp(decls[name]);
      const allWins = own.important === all.important ? i < allPos : all.important;
      if (!allWins && !(own.value.trim().toLowerCase() === kw && own.important === all.important)) {
        return own.value;
      }
    }
    // Otherwise it can still serialize when every one of its longhands resolves to the SAME
    // css-wide keyword (a uniform `all` reset) — the only other case the "all" contract needs.
    const vals = mdnLhs.map(lh => allWinner(decls, pos, allPos, all, kw, lh).value.trim().toLowerCase());
    return vals.every(x => x === vals[0] && CSS_WIDE.has(x)) ? vals[0] : '';
  }
  // A longhand (or a covered plain property).
  const w = allWinner(decls, pos, allPos, all, kw, name);
  return w == null ? '' : w.value;
}

// getPropertyPriority resolved through an `all` declaration: the winning declaration's
// importance (a covered property inherits `all`'s `!important`, unless its own declaration
// out-cascades it). A shorthand is important only when every covered longhand's winner is.
export function allGetPriority(decls, name) {
  const keys   = Object.keys(decls);
  const pos    = new Map(keys.map((k, i) => [k, i]));
  const allPos = pos.get('all');
  const all    = splitImp(decls.all);
  const kw     = all.value.trim().toLowerCase();
  if (name === 'all') return all.important ? 'important' : '';
  const lhs = isRegularShorthand(name) ? shorthandLonghands(name) : SHORTHAND_LONGHANDS[name];
  if (lhs) return lhs.every(lh => allWinner(decls, pos, allPos, all, kw, lh).important) ? 'important' : '';
  const w = allWinner(decls, pos, allPos, all, kw, name);
  return w && w.important ? 'important' : '';
}
