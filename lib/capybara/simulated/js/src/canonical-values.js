// The canonical form a `calc()` of lengths and percentages is written in — summed into one pair, the percentage first —
// for the values a reader here resolves itself out of the style engine's text (an origin, a size with no used box).
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
