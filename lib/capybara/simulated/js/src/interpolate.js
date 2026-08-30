// Interpolation of two CSS values — what an animation or a transition reports for a property
// somewhere between its endpoints (css-values §Combining, web-animations §Interpolation).
//
// The property decides HOW: mdn-data's `animationType` (shipped as ANIMATION_TYPES) says whether a
// property's values are numbers, lengths, colours, or nothing interpolable at all. Everything this
// engine can't interpolate falls back to DISCRETE — a flip at the halfway point — which is exactly
// what the spec says an uninterpolable pair does anyway, so an unimplemented type is a coarse
// answer rather than a wrong one.
//
// Progress is NOT clamped to [0,1]: an animation with a timing function that overshoots, or a
// `-0.3` seek, extrapolates past its endpoints. What clamps instead is the PROPERTY's own range
// (`flex-grow` is never negative) — PROPERTY_MIN, which mdn's syntax ranges and the spec's own
// bounds feed.
import { ANIMATION_TYPES, PROPERTY_MIN } from './css-property-data.js';

// A number as CSS writes it: no exponent, no trailing zeros, and the tiny binary residue of an
// interpolation rounded away (0.1 + 0.2 is `0.30000000000000004` and Chrome reports `0.3`).
function formatNumber(n) {
  if (!Number.isFinite(n)) return null;
  const r = Math.round(n * 1e6) / 1e6;
  return String(Object.is(r, -0) ? 0 : r);
}

const NUMBER_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const DIMENSION_RE = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)([a-z%]+)$/i;

// A value reduced to `{n, unit}` — a bare number carries the empty unit — or null when it is not a
// single numeric token (a keyword, a list, a function).
export function numericValue(v) {
  const s = String(v).trim();
  if (NUMBER_RE.test(s)) return { n: parseFloat(s), unit: '' };
  const m = DIMENSION_RE.exec(s);
  return m ? { n: parseFloat(m[1]), unit: m[2].toLowerCase() } : null;
}

// The canonical `rgb()` / `rgba()` form `normalizeColor` produces, reduced to channels. Only that
// form is parsed here: every colour reaching interpolation has been through the computed-value
// funnel, and a value that has NOT (a colour space we keep verbatim) interpolates discretely
// rather than silently in the wrong space.
const RGB_RE = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i;
function rgbaValue(v) {
  const m = RGB_RE.exec(String(v).trim());
  if (!m) return null;
  // EIGHT BITS per channel, alpha included — that is what a legacy sRGB colour holds, and
  // interpolating from the author's decimal instead lands a step off. (Chrome-measured:
  // `rgb(0,0,0)` to `rgba(200,100,0,0.5)` half way is `rgba(67, 33, 0, 0.753)`, i.e. 192/255,
  // which is the midpoint of 255 and 128 — not of 255 and 127.5.)
  const a = m[4] === undefined ? 1 : Math.round(Math.max(0, Math.min(1, parseFloat(m[4]))) * 255) / 255;
  return { r: parseFloat(m[1]), g: parseFloat(m[2]), b: parseFloat(m[3]), a };
}
function formatRgba(c) {
  const ch = (x) => Math.max(0, Math.min(255, Math.round(x)));
  const a = ch(Math.max(0, Math.min(1, c.a)) * 255) / 255;   // …and back out at the same 8 bits
  return a >= 1 ? `rgb(${ch(c.r)}, ${ch(c.g)}, ${ch(c.b)})`
                : `rgba(${ch(c.r)}, ${ch(c.g)}, ${ch(c.b)}, ${formatNumber(Math.round(a * 1e3) / 1e3)})`;
}

const mix = (a, b, p) => a + (b - a) * p;

// Colours interpolate with their alpha PREMULTIPLIED, so fading to `transparent` doesn't drag the
// colour through black on the way (css-color-4 §12.3 — `rgba(255,0,0,1)` to `rgba(0,0,0,0)` is red
// all the way down, not a red-to-black ramp).
function interpolateColor(from, to, p) {
  const a = rgbaValue(from), b = rgbaValue(to);
  if (!a || !b) return null;
  const alpha = mix(a.a, b.a, p);
  if (alpha <= 0) return formatRgba({ r: 0, g: 0, b: 0, a: 0 });
  const chan = (k) => mix(a[k] * a.a, b[k] * b.a, p) / alpha;
  return formatRgba({ r: chan('r'), g: chan('g'), b: chan('b'), a: alpha });
}

// A length or percentage, and the mixture of the two that a browser reports as `calc()`: a `10px`
// to `50%` interpolation has no single unit to land in, so half way is
// `calc(5px + 25%)` — the same value the cascade would have accepted written out.
function interpolateLengthPercentage(from, to, p, allowPercentage) {
  const a = numericValue(from), b = numericValue(to);
  if (!a || !b) return null;
  const usable = (u) => u === '' || u === 'px' || (allowPercentage && u === '%');
  if (!usable(a.unit) || !usable(b.unit)) return null;
  // A ZERO carries no unit of its own — `0` and `0px` are the same length — so it takes whichever
  // unit the other end has rather than forcing the pair into a `calc()`.
  const au = a.unit || (a.n === 0 ? b.unit : ''), bu = b.unit || (b.n === 0 ? a.unit : '');
  if (au === bu) return formatNumber(mix(a.n, b.n, p)) + (au === '' ? 'px' : au);
  const px  = mix(au === '%' ? 0 : a.n, bu === '%' ? 0 : b.n, p);
  const pct = mix(au === '%' ? a.n : 0, bu === '%' ? b.n : 0, p);
  return `calc(${formatNumber(px)}px + ${formatNumber(pct)}%)`;
}

// The lower bound the property's own grammar imposes (`<number [0,∞]>` for `flex-grow`), applied
// AFTER interpolation: extrapolating below it is what a negative progress does, and a browser
// reports the clamped value.
function clampToRange(prop, text) {
  const min = PROPERTY_MIN[prop];
  if (min == null) return text;
  const v = numericValue(text);
  if (!v || v.n >= min) return text;
  return formatNumber(min) + v.unit;
}

// Which interpolation an mdn animation type asks for. The names this engine implements map to a
// handler; `byComputedValue`(`Type`) asks the VALUES what they are, which is what the spec means by
// "interpolated as its computed-value type"; everything else is discrete.
const TYPE_HANDLERS = {
  __proto__: null,
  number:  (f, t, p) => { const a = numericValue(f), b = numericValue(t);
                          return a && b && !a.unit && !b.unit ? formatNumber(mix(a.n, b.n, p)) : null; },
  integer: (f, t, p) => { const a = numericValue(f), b = numericValue(t);
                          // An integer stays one: it interpolates as a real number and is rounded,
                          // halves away from zero (css-values §Combining).
                          if (!a || !b || a.unit || b.unit) return null;
                          const v = mix(a.n, b.n, p);
                          return formatNumber(v < 0 ? -Math.round(-v) : Math.round(v)); },
  length:  (f, t, p) => interpolateLengthPercentage(f, t, p, false),
  lpc:     (f, t, p) => interpolateLengthPercentage(f, t, p, true),
  color:   interpolateColor
};

// The value `prop` reports at progress `p` between two COMPUTED values, or `null` when the pair is
// not interpolable at all — the caller then falls back to discrete, which needs no computation.
export function interpolateProperty(prop, from, to, p) {
  if (from == null || to == null) return null;
  const a = String(from).trim(), b = String(to).trim();
  if (a === b) return a;                       // identical endpoints need no arithmetic
  const type = ANIMATION_TYPES[prop];
  if (type === 'notAnimatable' || type === 'discrete') return null;
  const handler = TYPE_HANDLERS[type] || (type === 'byComputedValue' || type === 'byComputedValueType'
                                          ? inferHandler(a, b) : null);
  if (!handler) return null;
  const out = handler(a, b, p);
  return out == null ? null : clampToRange(prop, out);
}

// "As its computed-value type": ask the two values what they are. A pair of numbers with the same
// unit interpolates numerically, a pair of colours as colours, and anything else discretely.
function inferHandler(a, b) {
  if (rgbaValue(a) && rgbaValue(b)) return interpolateColor;
  const na = numericValue(a), nb = numericValue(b);
  if (!na || !nb) return null;
  if (!na.unit && !nb.unit) return TYPE_HANDLERS.number;
  return (f, t, p) => interpolateLengthPercentage(f, t, p, true);
}

// The DISCRETE answer, which every uninterpolable pair takes: the first value until half way, the
// second from there on (web-animations §Interpolation — and outside [0,1] the nearer end, which is
// what a progress of -0.3 or 1.5 picks).
export function discreteValue(from, to, p) { return p < 0.5 ? from : to; }
