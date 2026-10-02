// The canonical form a COMPUTED value is written in, for the values whose author text a browser
// rewrites: a `calc()` of lengths and percentages summed into one pair, and the individual transform
// properties (`translate` / `rotate` / `scale`) in their shortest form.
//
// (What the style engine computes it writes itself; these are the JS cascade's — the reads of a node no
// engine styles.)
import { splitTopLevelWhitespace, shortestIndividualTransform, unwrapCalc } from './css-utils.js';
import { reduceMathFunctions, absoluteToPx } from './calc.js';

// A number as CSS writes it: SIX SIGNIFICANT digits, which is what a browser reports — a third of
// `100px` is `33.3333px` and `Math.sqrt(2)` is `1.41421` — with the tiny binary residue of the
// arithmetic rounded away (0.1 + 0.2 is `0.30000000000000004` and Chrome reports `0.3`).
// Beyond those six digits it switches to exponential form, two digits of exponent wide
// (Chrome-measured: `1234567.891px` reports as `1.23457e+06px`, and `5e-08px` stays that).
function formatNumber(n) {
  if (!Number.isFinite(n)) return null;
  // A whole number is already written the way CSS wants it, which is most of what reaches here —
  // the rounding below costs a `toPrecision` and a logarithm per number, on a path that
  // runs per length per read.
  if (Number.isInteger(n) && n > -1e6 && n < 1e6) return n === 0 ? '0' : String(n);
  const r = Number(n.toPrecision(6));
  if (r === 0) return '0';
  const exp = Math.floor(Math.log10(Math.abs(r)));
  return exp >= 6 || exp < -4 ? r.toExponential().replace(/e([+-])(\d)$/, 'e$10$2') : String(r);
}

const NUMBER_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const DIMENSION_RE = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)([a-z%]+)$/i;

// A value reduced to `{n, unit}` — a bare number carries the empty unit — or null when it is not a
// single numeric token (a keyword, a list, a function).
function numericValue(v) {
  const s = String(v).trim();
  if (NUMBER_RE.test(s)) return { n: parseFloat(s), unit: '' };
  const m = DIMENSION_RE.exec(s);
  return m ? { n: parseFloat(m[1]), unit: m[2].toLowerCase() } : null;
}

// A percentage is PRESENT or absent, never merely zero: `calc(0% + 10px)` is not `10px`, and a
// `0%` end reports `0%` rather than `0px` — the percentage is part of the value's type, and a
// browser keeps it (Chrome-measured, both). A zero LENGTH is absorbed, though: `calc(25% + 0px)`
// is `25%`.
const CALC_LP_RE = /^calc\(\s*([+-]?(?:\d+\.?\d*|\.\d+))%\s*([+-])\s*((?:\d+\.?\d*|\.\d+))px\s*\)$/i;
function lengthPercentage(text, allowPercentage) {
  const v = numericValue(text);
  // A ZERO carries no unit of its own — `0` and `0px` are the same length — and a bare number is
  // a length for the properties that take one.
  if (v) {
    if (v.unit === '' || v.unit === 'px') return { px: v.n, pct: null };
    return v.unit === '%' && allowPercentage ? { px: 0, pct: v.n } : null;
  }
  if (!allowPercentage) return null;
  const m = CALC_LP_RE.exec(String(text).trim());
  return m ? { pct: parseFloat(m[1]), px: parseFloat(m[3]) * (m[2] === '-' ? -1 : 1) } : null;
}
// …and back out. The percentage comes FIRST, and a negative length is SUBTRACTED rather than added
// — which is how a browser writes the mixture (Chrome-measured: `calc(25% + 5px)`, `calc(25% -
// 5px)`, and plain `25%`).
function formatLengthPercentage(v) {
  if (v.pct === null) return formatNumber(v.px) + 'px';
  if (v.px === 0) return formatNumber(v.pct) + '%';
  return `calc(${formatNumber(v.pct)}% ${v.px < 0 ? '-' : '+'} ${formatNumber(Math.abs(v.px))}px)`;
}
// The canonical form of a `calc()` that is a flat SUM of px and percentage terms holding both, whichever order they
// were written in: a computed value reports the percentage first and the lengths summed, whether an animation
// produced it or the author (or the UA sheet) wrote it (Chrome-measured: `calc(130px + 4%)` computes to
// `calc(4% + 130px)`, `calc(25% + 0px)` to `25%`, and a modal `<dialog>`'s `calc(100% - 6px - 2em)` to
// `calc(100% - 38px)`, its `em` absolutized first). Null for any other shape — a product, a nested function, one unit.
// (…a term's own sign included, which a substitution leaves behind: `calc(100% - var(--x))` with `--x: -10px` is
// `calc(100% - -10px)`, and computes to `calc(100% + 10px)` in both browsers.)
const CALC_SUM_RE = /^calc\(\s*([+-]?\s*(?:\d+\.?\d*|\.\d+)(?:%|px)(?:\s*[+-]\s*[+-]?(?:\d+\.?\d*|\.\d+)(?:%|px))+)\s*\)$/i;
const CALC_TERM_RE = /([+-]?)\s*([+-]?)(\d+\.?\d*|\.\d+)(%|px)/gi;
export function canonicalLengthPercentage(text) {
  const m = CALC_SUM_RE.exec(String(text).trim());
  if (!m) return canonicalLinearCalc(String(text).trim());
  const sum = { pct: 0, px: 0 };
  let units = 0;
  for (const [, sign, own, n, unit] of m[1].matchAll(CALC_TERM_RE)) {
    const pct = unit === '%';
    sum[pct ? 'pct' : 'px'] += parseFloat(n) * (sign === '-' ? -1 : 1) * (own === '-' ? -1 : 1);
    units |= pct ? 1 : 2;
  }
  return units & 1 ? formatLengthPercentage(sum) : null;
}
// …and any other `calc()` of absolute lengths and percentages that is LINEAR in the percentage's basis — nested sums,
// a product by a number, a percentage cancelled out (Chrome: `calc(100% - (10px + 5px))` is `calc(100% - 15px)`,
// `calc(2 * 10% + 5px)` `calc(20% + 5px)`, `calc(50% - 50%)` `0%`): evaluated at three bases, and the pair read off the
// line through them. A percentage stays one even where it comes to zero — it is part of the value's type. Only a
// value built of sums, products and nested `calc()` is: a `min()`, `max()`, `clamp()` or any other function inside is
// piecewise, and can be linear at the three bases without being linear (`calc(max(10%, 20px))` computes to
// `max(10%, 20px)`).
function canonicalLinearCalc(text) {
  if (!/^calc\(/i.test(text) || text.indexOf('%') < 0 || /[a-z-]\(/i.test(text.replace(/calc\(/gi, '('))) return null;
  const at = (basis) => {
    const out = reduceMathFunctions(text, (n, unit) => (unit === '%' ? n * basis / 100 : absoluteToPx(n, unit)));
    const px = /^(-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)px$/i.exec(String(out).trim());
    return px ? parseFloat(px[1]) : null;
  };
  const a = at(0), b = at(100), c = at(200);
  if (a == null || b == null || c == null || Math.abs((c - a) - 2 * (b - a)) > 1e-9) return null;
  return formatLengthPercentage({ px: Math.abs(a) < 1e-12 ? 0 : a, pct: b - a });
}

// How many lengths a shadow carries: the two offsets and the blur, and for a box shadow the spread.
export const SHADOW_LENGTHS = { __proto__: null, 'text-shadow': 3, 'box-shadow': 4, 'drop-shadow': 3 };

// The individual transform properties (css-transforms-2 §"Individual Transform Properties"): each is one value — a
// translation, a rotation, a scale — not a function list. Each entry reads a computed value (undefined where it
// cannot) and writes it back as a computed value is written.
const ANGLE_DEGREES = { __proto__: null, deg: 1, rad: 180 / Math.PI, grad: 0.9, turn: 360 };
const ZERO_LENGTH = { px: 0, pct: null };
const INDIVIDUAL_TRANSFORMS = {
  __proto__: null,
  // Three length-percentages; a zero Z is not written, nor then a zero Y.
  translate: {
    read(text) {
      const parts = splitTopLevelWhitespace(text);
      if (parts.length > 3) return undefined;
      const v = parts.map((part) => lengthPercentage(canonicalLengthPercentage(part) ?? part, true));
      if (v.some((x) => !x)) return undefined;
      while (v.length < 3) v.push(ZERO_LENGTH);
      return v;
    },
    write: (v) => shortestIndividualTransform('translate', v.map(formatLengthPercentage).join(' '))
  },
  // Three factors. A Z of 1 is not written, nor then a Y equal to X.
  scale: {
    read(text) {
      const parts = splitTopLevelWhitespace(text);
      if (parts.length > 3) return undefined;
      const v = parts.map((part) => {
        // A `calc()` of numbers and percentages is the number it comes to (`calc(50%)` is 0.5).
        if (/^calc\(/i.test(part)) part = reduceMathFunctions(part.replace(/(\d)%/g, '$1*0.01'), () => null);
        const n = numericValue(part);
        return !n ? NaN : n.unit === '%' ? n.n / 100 : n.unit ? NaN : n.n;
      });
      if (v.some(Number.isNaN)) return undefined;
      return [v[0], v.length > 1 ? v[1] : v[0], v.length > 2 ? v[2] : 1];
    },
    write(v) {
      const parts = v.map(formatNumber);
      return parts.includes(null) ? null : shortestIndividualTransform('scale', parts.join(' '));
    }
  },
  // An axis and an angle.
  rotate: {
    // (The angle may be written first, as the grammar allows: `45deg x`.)
    read(text) {
      const parts = splitTopLevelWhitespace(text);
      const angleOf = (tok) => /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(deg|rad|grad|turn)$/i.exec(tok || '');
      const first = parts.length > 1 && angleOf(parts[0]);
      const angle = first || angleOf(parts[parts.length - 1]);
      if (!angle) return undefined;
      const deg = parseFloat(angle[1]) * ANGLE_DEGREES[angle[2].toLowerCase()];
      const axisText = first ? parts.slice(1) : parts.slice(0, -1);
      let axis;
      if (!axisText.length) axis = [0, 0, 1];
      else if (axisText.length === 1) axis = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }[axisText[0].toLowerCase()];
      else if (axisText.length === 3) axis = axisText.map((part) => (NUMBER_RE.test(part) ? parseFloat(part) : NaN));
      return axis && !axis.some(Number.isNaN) ? { axis, deg } : undefined;
    },
    write({ axis, deg }) {
      const parts = axis.map((c) => (Math.abs(c) < 1e-12 ? 0 : c)).concat(deg).map(formatNumber);
      return parts.includes(null) ? null : shortestIndividualTransform('rotate', `${parts.slice(0, 3).join(' ')} ${parts[3]}deg`);
    }
  }
};

// The computed value of one of these properties as a browser writes it — `rotate: 0 0 1 0.5turn` is `180deg`,
// `translate: 10px 0px` is `10px`, `scale: 50% 50%` is `0.5` — or the text as it came where it is not one this reads.
// A value this cannot read — a component still a `min()` or a `clamp()`, which only layout resolves — keeps its
// components, a `calc()` around one of those unwrapped as the math simplification does (`translate: calc(min(10%,
// 50px))` computes to `min(10%, 50px)` in Chrome and Firefox).
// (Memoised on the text, which is all it depends on: it is asked on every `getComputedStyle` read of one of these.)
const CANONICAL_TRANSFORMS = new Map();
export function canonicalIndividualTransform(prop, text) {
  const s = String(text).trim();
  if (/^none$/i.test(s)) return s;
  const key = prop + '|' + s;
  let out = CANONICAL_TRANSFORMS.get(key);
  if (out !== undefined) return out;
  const own = INDIVIDUAL_TRANSFORMS[prop], value = own.read(s);
  out = (value === undefined ? null : own.write(value)) ??
        shortestIndividualTransform(prop, splitTopLevelWhitespace(s).map(unwrapCalc).join(' '));
  if (CANONICAL_TRANSFORMS.size >= 512) CANONICAL_TRANSFORMS.clear();
  CANONICAL_TRANSFORMS.set(key, out);
  return out;
}
export const isIndividualTransform = (prop) => !!INDIVIDUAL_TRANSFORMS[prop];
