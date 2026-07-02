// CSS shorthand <-> longhand serialization for CSSOM: the "serialize a CSS declaration
// block" shorthand reconstruction (longhands collapse to `margin: 1px 2px`) plus the
// shorthand getter/setter surface (`style.overflow`). Covers the REGULAR shorthands whose
// combine rule is purely structural:
//   axis2  — [x, y]                       (overflow)
//   box4   — [top, right, bottom, left]   (margin, padding)
// Irregular shorthands (border, outline, list-style, font, background) are property-
// specific and the `all` mega-shorthand is a css-wide-keyword special case — both deferred.
//
// The reconstruction only fires when EVERY longhand of a shorthand is present with the
// SAME importance and the values are jointly representable (a css-wide keyword like
// `inherit` combines only if all longhands share it), matching CSSOM.

import { serializeCssValue } from './css-utils.js';

const CSS_WIDE = new Set(['inherit', 'initial', 'unset', 'revert', 'revert-layer']);

function anyCssWide(vals) {
  return vals.some(v => CSS_WIDE.has(v.toLowerCase()));
}

// [top, right, bottom, left] -> the 1..4-value box form (drop mirror-equal trailing
// sides). A css-wide keyword only combines when all four are identical.
function combineBox(vals) {
  const [t, r, b, l] = vals;
  if (anyCssWide(vals)) return vals.every(v => v === t) ? t : null;
  if (t === r && r === b && b === l) return t;
  if (t === b && r === l) return t + ' ' + r;
  if (r === l) return t + ' ' + r + ' ' + b;
  return t + ' ' + r + ' ' + b + ' ' + l;
}

// [x, y] -> `x` when equal, else `x y`. A css-wide keyword combines only when equal.
function combineAxis(vals) {
  const [x, y] = vals;
  if (anyCssWide(vals)) return x === y ? x : null;
  return x === y ? x : x + ' ' + y;
}

// Expand a shorthand VALUE into its longhands. `box4`: 1..4 values map to
// [t, r, b, l] with CSS's mirror defaults; `axis2`: 1..2 values to [x, y]. A css-wide
// keyword (single token) fills every longhand. Returns null when the value can't be
// split (wrong token count) so the caller leaves it as an unknown declaration.
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

const SHORTHANDS = {
  overflow: { longhands: ['overflow-x', 'overflow-y'], combine: combineAxis, expand: expandAxis },
  margin:   { longhands: ['margin-top', 'margin-right', 'margin-bottom', 'margin-left'], combine: combineBox, expand: expandBox },
  padding:  { longhands: ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'], combine: combineBox, expand: expandBox },
};

// longhand name -> the shorthand it belongs to (first/only regular shorthand).
const LONGHAND_TO_SHORTHAND = {};
for (const [name, def] of Object.entries(SHORTHANDS)) {
  for (const lh of def.longhands) LONGHAND_TO_SHORTHAND[lh] = name;
}

export function isRegularShorthand(name) {
  return Object.prototype.hasOwnProperty.call(SHORTHANDS, name);
}

export function shorthandLonghands(name) {
  return SHORTHANDS[name] ? SHORTHANDS[name].longhands : null;
}

// Return a NEW declaration map with every regular-shorthand key replaced by its
// longhands (order preserved), so the CSSOM store is uniformly longhand-based: a
// `style="overflow: hidden"` source and a `style.overflowX = …` write end up in the
// same shape, and the shorthand getter / cssText reconstruction both work. A shorthand
// whose value can't be split is left as-is (an invalid declaration that passes through).
export function expandShorthandsInMap(decls) {
  let hasShorthand = false;
  for (const k in decls) if (isRegularShorthand(k)) { hasShorthand = true; break; }
  if (!hasShorthand) return decls;
  const out = {};
  for (const [k, v] of Object.entries(decls)) {
    if (isRegularShorthand(k)) {
      const pairs = shorthandExpand(k, v);
      if (pairs) { for (const [lh, lv] of pairs) out[lh] = lv; continue; }
    }
    out[k] = v;
  }
  return out;
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
  const combined = def.combine(split.map(s => serializeCssValue(s.value)));
  if (combined == null) return '';
  return combined;
}

// Expand `name: value` (a shorthand) into a list of [longhand, value] pairs, or null
// when `name` isn't a regular shorthand or the value can't be split. Importance is
// carried onto every longhand.
export function shorthandExpand(name, value) {
  const def = SHORTHANDS[name];
  if (!def) return null;
  const { value: bare, important } = splitImp(value);
  const tokens = topLevelTokens(bare.trim());
  // A css-wide keyword (inherit/initial/…) is only valid as the SOLE token of a
  // shorthand — `margin: inherit 1px` is invalid and must be ignored, not split.
  if (tokens.length > 1 && anyCssWide(tokens)) return null;
  const sides = def.expand(tokens);
  if (!sides) return null;
  const imp = important ? ' !important' : '';
  return def.longhands.map((lh, i) => [lh, sides[i] + imp]);
}

// Serialize a canonical `name: value;` declaration (value canonicalized unless it's a
// custom property, importance preserved).
function declText(name, value) {
  if (name.startsWith('--')) return name + ': ' + value + ';';
  const { value: bare, important } = splitImp(value);
  return name + ': ' + serializeCssValue(bare) + (important ? ' !important' : '') + ';';
}

// CSSOM "serialize a CSS declaration block" with shorthand reconstruction: walk the
// declarations in order; when the current one is the first-seen longhand of a regular
// shorthand whose every longhand is present with matching importance and combinable
// values, emit the shorthand in its place; otherwise emit the declaration itself. Custom
// properties and unknown declarations pass through (value-canonicalized).
export function serializeDeclBlock(decls) {
  const done = new Set();
  const out = [];
  for (const name of Object.keys(decls)) {
    if (done.has(name)) continue;
    const shName = LONGHAND_TO_SHORTHAND[name];
    if (shName) {
      const def = SHORTHANDS[shName];
      const parts = def.longhands.map(lh => decls[lh]);
      if (parts.every(p => p != null)) {
        const split = parts.map(splitImp);
        if (split.every(s => s.important === split[0].important)) {
          const combined = def.combine(split.map(s => serializeCssValue(s.value)));
          if (combined != null) {
            out.push(shName + ': ' + combined + (split[0].important ? ' !important' : '') + ';');
            def.longhands.forEach(lh => done.add(lh));
            continue;
          }
        }
      }
    }
    out.push(declText(name, decls[name]));
    done.add(name);
  }
  return out.join(' ');
}
