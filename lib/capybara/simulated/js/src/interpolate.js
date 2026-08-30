// Interpolation of two CSS values — what an animation or a transition reports for a property
// somewhere between its endpoints (css-values §Combining, web-animations §Interpolation) — and the
// two other ways a value can be COMBINED with the one underneath it: `composite: add` and
// `composite: accumulate`.
//
// The property decides HOW: mdn-data's `animationType` (shipped as ANIMATION_TYPES) says whether a
// property's values are numbers, lengths, colours, lists of shadows or of functions, or nothing
// interpolable at all. Everything this engine can't interpolate falls back to DISCRETE — a flip at
// the halfway point — which is exactly what the spec says an uninterpolable pair does anyway, so an
// unimplemented type is a coarse answer rather than a wrong one.
//
// Progress is NOT clamped to [0,1]: an animation with a timing function that overshoots, or a
// `-0.3` seek, extrapolates past its endpoints. What clamps instead is the VALUE's own range — the
// property's (`flex-grow` is never negative: PROPERTY_MIN) and, inside a list, each function's
// (a `blur()` is never negative, a `grayscale()` never above 1).
//
// Named gaps, all measured against Chrome and all backlog rather than exclusions:
//   * two transform lists naming DIFFERENT functions flip discretely — the spec decomposes each
//     into translate / rotate / scale / skew, and `transformMatrix` composes the matrix already,
//     so what is missing is the DECOMPOSITION;
//   * `translate` / `rotate` / `scale` (the independent properties) and `font-variation-settings`
//     are typed `transform` by mdn but are no function list — Chrome interpolates and composes
//     each componentwise (`scale` multiplicatively), which wants a type of their own;
//   * `numberOrLength` (`line-height`), `repeatableList` (`background-position-x`,
//     `background-size`, `object-position`), `simpleListOfLpc` (`transform-origin`) and
//     `basicShapeOtherwiseNo` (`clip-path`) have no handler yet, so they flip discretely — the
//     first three are this same list engine over a simpler entry.
import { ANIMATION_TYPES, PROPERTY_MIN, ADDS_DIMENSION } from './css-property-data.js';
import { splitValues } from './css-utils.js';

// A number as CSS writes it: SIX SIGNIFICANT digits, which is what a browser reports — a third of
// `100px` is `33.3333px` and `Math.sqrt(2)` is `1.41421` — with the tiny binary residue of an
// interpolation rounded away (0.1 + 0.2 is `0.30000000000000004` and Chrome reports `0.3`).
// Beyond those six digits it switches to exponential form, two digits of exponent wide
// (Chrome-measured: `1234567.891px` reports as `1.23457e+06px`, and `5e-08px` stays that).
function formatNumber(n) {
  if (!Number.isFinite(n)) return null;
  // A whole number is already written the way CSS wants it, which is most of what an interpolation
  // produces — the rounding below costs a `toPrecision` and a logarithm per number, on a path that
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
// Alpha lives in those same eight bits, and serializes as the SHORTEST decimal that rounds back to
// its byte: 128 is `0.5`, 160 is `0.627`, 192 is `0.753` (Chrome-measured, all three).
function formatAlpha(a) {
  const byte = Math.round(a * 255);
  for (let places = 1; places <= 3; places++) {
    const rounded = parseFloat((byte / 255).toFixed(places));
    if (Math.round(rounded * 255) === byte) return String(rounded);
  }
  return String(byte / 255);
}
function formatRgba(c) {
  const ch = (x) => Math.max(0, Math.min(255, Math.round(x)));
  const alpha = Math.max(0, Math.min(1, c.a));
  return Math.round(alpha * 255) >= 255
    ? `rgb(${ch(c.r)}, ${ch(c.g)}, ${ch(c.b)})`
    : `rgba(${ch(c.r)}, ${ch(c.g)}, ${ch(c.b)}, ${formatAlpha(alpha)})`;
}

const mix = (a, b, p) => a + (b - a) * p;

// Colours interpolate with their alpha PREMULTIPLIED, so fading to `transparent` doesn't drag the
// colour through black on the way (css-color-4 §12.3 — `rgba(255,0,0,1)` to `rgba(0,0,0,0)` is red
// all the way down, not a red-to-black ramp). The alpha CLAMPS before it un-premultiplies: past an
// opaque endpoint the channels go on climbing (Chrome-measured: transparent green to `rgb(0,128,0)`
// at 1.25 is `rgb(0, 160, 0)`), which dividing by an alpha above 1 would undo.
function interpolateColor(from, to, p) {
  const a = rgbaValue(from), b = rgbaValue(to);
  if (!a || !b) return null;
  const alpha = Math.min(1, mix(a.a, b.a, p));
  if (alpha <= 0) return formatRgba({ r: 0, g: 0, b: 0, a: 0 });
  const chan = (k) => mix(a[k] * a.a, b[k] * b.a, p) / alpha;
  return formatRgba({ r: chan('r'), g: chan('g'), b: chan('b'), a: alpha });
}

// Two colours ADDED. Chrome-measured, and it takes two shapes: colours whose alphas MATCH add
// channel by channel and keep that alpha (`rgba(10,20,30,0.5)` + `rgba(40,50,60,0.5)` is
// `rgba(50, 70, 90, 0.5)`, and two opaque colours are that case), while colours whose alphas
// differ add PREMULTIPLIED and take the summed alpha (`rgba(0,0,255,0.2)` + `rgba(255,0,0,0.3)`
// is `rgba(153, 0, 102, 0.5)`).
function addColors(from, to) {
  const x = rgbaValue(from), y = rgbaValue(to);
  if (!x || !y) return null;
  if (x.a === y.a) return formatRgba({ r: x.r + y.r, g: x.g + y.g, b: x.b + y.b, a: x.a });
  const alpha = Math.min(1, x.a + y.a);
  if (alpha <= 0) return formatRgba({ r: 0, g: 0, b: 0, a: 0 });
  const chan = (k) => (x[k] * x.a + y[k] * y.a) / alpha;
  return formatRgba({ r: chan('r'), g: chan('g'), b: chan('b'), a: alpha });
}

// A length or percentage, and the mixture of the two that a browser reports as `calc()`: a `10px`
// to `50%` interpolation has no single unit to land in, so half way is `calc(25% + 5px)` — the
// same value the cascade would have accepted written out.
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
  // The PERCENTAGE comes first, a length that has reached ZERO is absorbed altogether, and a
  // negative one is SUBTRACTED rather than added — which is how a browser writes the mixture
  // (Chrome-measured: `calc(25% + 5px)`, `calc(25% - 5px)`, and plain `25%`).
  if (px === 0) return formatNumber(pct) + '%';
  return `calc(${formatNumber(pct)}% ${px < 0 ? '-' : '+'} ${formatNumber(Math.abs(px))}px)`;
}

// `letter-spacing: normal` IS a zero spacing and interpolates as one (Chrome-measured: `normal` to
// `10px` is `5px` half way), where for most properties `normal` is a keyword with no value behind
// it. `word-spacing` is the same. Two `normal`s stay `normal` — an identical pair never reaches an
// interpolation at all.
const NORMAL_IS_ZERO = { __proto__: null, 'letter-spacing': true, 'word-spacing': true };
const zeroForNormal = (prop, text) =>
  (NORMAL_IS_ZERO[prop] && /^normal$/i.test(text) ? '0px' : text);

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

// ── List-valued types ────────────────────────────────────────────────────────────────────────
// A shadow list, a filter list and a transform list are all ONE shape: a sequence of entries
// combined ENTRY BY ENTRY, with the shorter list padded by each missing entry's IDENTITY — which
// is what makes `none` combine at all: it is a list of zero entries, and every pair is then like
// against like (Chrome-measured: `none` to `blur(10px) brightness(0.5)` half way is
// `blur(5px) brightness(0.75)`, each function against its OWN neutral value, not against zero).
//
// The same loop serves both operations. They differ only in the scalar rule and in what happens
// when a pair cannot be combined: an interpolation gives up and the caller flips discretely, while
// an accumulation takes the effect's value alone.

// Interpolation MIXES two numbers; accumulation ADDS them — and adding two values of a type whose
// neutral value is not zero has to subtract that neutral once, or `brightness(2)` accumulated onto
// `brightness(3)` reports 5 where Chrome reports 4.
const combineNumber = (x, y, op, identity) => (op.accumulate ? x + y - identity : mix(x, y, op.p));

// ── shadows ──
// One shadow: a colour, two to four lengths, and `inset`. The identity is a transparent shadow with
// every length at zero — and with the OTHER side's `inset`, since a list padded with the opposite
// flag would be a pair that disagrees about it.
export const SHADOW_LENGTHS = { __proto__: null, 'text-shadow': 3, 'box-shadow': 4, 'drop-shadow': 3 };
function parseShadow(text) {
  const parts = splitValues(text, ' ');
  const lengths = [];
  let color = null, inset = false;
  for (const part of parts) {
    if (/^inset$/i.test(part)) { inset = true; continue; }
    const n = numericValue(part);
    if (n && (n.unit === 'px' || n.unit === '')) { lengths.push(n.n); continue; }
    if (rgbaValue(part) || /^[a-z]/i.test(part) || part[0] === '#') { color = part; continue; }
    return null;                                   // a unit we don't resolve — not interpolable
  }
  if (lengths.length < 2 || lengths.length > 4) return null;
  while (lengths.length < 4) lengths.push(0);
  return { color: color || 'rgba(0, 0, 0, 0)', lengths, inset };
}
const shadowIdentity = (other) => ({ color: 'rgba(0, 0, 0, 0)', lengths: [0, 0, 0, 0], inset: other.inset });
function combineShadow(x, y, op, count) {
  if (!x) x = shadowIdentity(y);
  if (!y) y = shadowIdentity(x);
  // `inset` is not interpolable: a pair that disagrees about it cannot be combined at all.
  if (x.inset !== y.inset) return null;
  const color = op.accumulate ? addColors(x.color, y.color) : interpolateColor(x.color, y.color, op.p);
  if (color == null) return null;
  const lengths = [];
  for (let i = 0; i < count; i++) {
    // Only the BLUR has a floor: an offset and a spread go negative under an overshooting easing
    // (Chrome-measured: `rgb(0, 0, 0) -10px -10px 0px -10px`).
    const n = combineNumber(x.lengths[i], y.lengths[i], op, 0);
    lengths.push(formatNumber(i === 2 ? Math.max(0, n) : n) + 'px');
  }
  return `${color} ${lengths.join(' ')}${x.inset ? ' inset' : ''}`;
}

// ── filters ──
// Each filter function has its OWN identity — the value that leaves the image alone: 0 for a blur,
// 1 for a brightness — and its own range, which an overshooting easing runs into (Chrome-measured:
// every function floors at 0, the four that are proportions cap at 1, and the three gain functions
// have no ceiling — `brightness(1.25)` is a real value).
const FILTER_IDENTITY = {
  __proto__: null,
  blur: 0, grayscale: 0, sepia: 0, invert: 0, opacity: 1, brightness: 1,
  contrast: 1, saturate: 1, 'hue-rotate': 0
};
const FILTER_MAX = { __proto__: null, grayscale: 1, sepia: 1, invert: 1, opacity: 1 };
const FILTER_UNIT = { __proto__: null, blur: 'px', 'hue-rotate': 'deg' };
function parseFilter(text) {
  const m = /^([a-z-]+)\(([\s\S]*)\)$/i.exec(String(text).trim());
  if (!m) return null;
  const name = m[1].toLowerCase();
  const arg = m[2].trim();
  // `drop-shadow()` takes a SHADOW, and interpolates as one (Chrome-measured: `none` to
  // `drop-shadow(rgb(100,100,100) 10px 10px 10px)` half way is that shadow at half strength).
  if (name === 'drop-shadow') {
    const shadow = arg ? parseShadow(arg) : null;
    return shadow ? { name, shadow } : null;
  }
  if (FILTER_IDENTITY[name] === undefined) return null;      // url() — not a shape we combine
  if (!arg) return { name, n: FILTER_IDENTITY[name], unit: FILTER_UNIT[name] || '' };
  const v = numericValue(arg);
  if (!v) return null;
  // A percentage argument is the same number over a hundred, and reports back as a plain number.
  return { name, n: v.unit === '%' ? v.n / 100 : v.n, unit: v.unit === '%' ? '' : v.unit };
}
const formatFilter = (f) => `${f.name}(${formatNumber(f.n)}${f.unit})`;
function combineFilter(x, y, op) {
  // Two lists that disagree about WHICH function sits at a position cannot be combined
  // componentwise (the spec's fallback is a cross-fade, which needs a rasteriser).
  if (x && y && x.name !== y.name) return null;
  const name = (x || y).name;
  if (name === 'drop-shadow') {
    const shadow = combineShadow(x && x.shadow, y && y.shadow, op, SHADOW_LENGTHS['drop-shadow']);
    return shadow == null ? null : `drop-shadow(${shadow})`;
  }
  const identity = FILTER_IDENTITY[name];
  const n = combineNumber(x ? x.n : identity, y ? y.n : identity, op, identity);
  const max = FILTER_MAX[name];
  return formatFilter({
    name,
    n: name === 'hue-rotate' ? n : Math.min(max === undefined ? Infinity : max, Math.max(0, n)),
    unit: (x && x.unit) || (y && y.unit) || FILTER_UNIT[name] || ''
  });
}

// ── transforms ──
// A transform list combines the same way, with `none` standing for each function's identity
// (Chrome-measured: `none` to `translateX(100px)` is `translateX(50px)` half way, not a discrete
// flip). The result is a function list, and the computed-value reader turns it into the matrix a
// page reads back.
//
// `fillFromFirst` is how a browser reads an OMITTED argument: `scale(2)` means `scale(2, 2)`,
// where `translate(10px)` means `translate(10px, 0)` — so a pair with different argument counts
// still lines up (Chrome-measured: `scale(2)` to `scale(4, 6)` half way is `scale(3, 4)`).
// `literalArgs` are the ones that do NOT combine: `rotate3d`'s axis is carried through, and two
// different axes want a quaternion this engine doesn't have.
// A `perspective()` interpolates its RECIPROCAL — half way from `none` to `perspective(100px)` is
// `perspective(200px)`, not 50 (Chrome-measured), and two accumulated add as reciprocals.
const TRANSFORM_FNS = {
  __proto__: null,
  translate: { identity: 0 }, translatex: { identity: 0 }, translatey: { identity: 0 },
  translatez: { identity: 0 }, translate3d: { identity: 0 },
  scale: { identity: 1, fillFromFirst: true }, scalex: { identity: 1 }, scaley: { identity: 1 },
  scalez: { identity: 1 }, scale3d: { identity: 1 },
  rotate: { identity: 0 }, rotatex: { identity: 0 }, rotatey: { identity: 0 },
  rotatez: { identity: 0 }, rotate3d: { identity: 0, literalArgs: 3 },
  skew: { identity: 0 }, skewx: { identity: 0 }, skewy: { identity: 0 },
  perspective: { identity: 0, reciprocal: true },
  // A matrix is a list ENTRY like any other — it concatenates when a transform is added — but it
  // has no componentwise interpolation: the spec decomposes a matrix into translate / rotate /
  // scale / skew, which is the decomposition this engine does not have.
  matrix: { opaque: true }, matrix3d: { opaque: true }
};
function parseTransformFn(text) {
  const m = /^([a-z0-9]+)\(\s*([^)]*)\)$/i.exec(String(text).trim());
  if (!m) return null;
  const name = m[1].toLowerCase();
  const spec = TRANSFORM_FNS[name];
  if (!spec) return null;
  const args = m[2].split(',').map((a) => a.trim()).filter(Boolean).map(numericValue);
  if (args.some((a) => !a)) return null;
  return { name, args, spec };
}
// The arguments a function really has once the omitted ones are filled in, padded to `count`.
function filledArgs(fn, count) {
  const args = fn.args.slice();
  while (args.length < count) {
    args.push(fn.spec.fillFromFirst ? { ...args[0] } : { n: fn.spec.identity, unit: '' });
  }
  return args;
}
function combineTransform(x, y, op) {
  if (x && y && x.name !== y.name) return null;
  const spec = (x || y).spec;
  if (spec.opaque) return null;
  const count = Math.max(x ? x.args.length : 0, y ? y.args.length : 0);
  // A missing side is the function's identity, argument for argument — except for the arguments
  // that don't combine, which are the other side's as written.
  const identityOf = (other) => ({
    name: other.name,
    spec,
    args: filledArgs(other, count).map((a, i) => (i < (spec.literalArgs || 0) ? a : { n: spec.identity, unit: a.unit }))
  });
  const a = filledArgs(x || identityOf(y), count), b = filledArgs(y || identityOf(x), count);
  const args = [];
  for (let i = 0; i < count; i++) {
    if (i < (spec.literalArgs || 0)) {
      // The axis has to MATCH, or there is nothing to carry through.
      if (a[i].n !== b[i].n || a[i].unit !== b[i].unit) return null;
      args.push(formatNumber(a[i].n) + a[i].unit);
      continue;
    }
    // A ZERO carries no unit of its own, so it takes the other end's.
    if (a[i].unit !== b[i].unit && a[i].n !== 0 && b[i].n !== 0) return null;
    if (spec.reciprocal) {
      const n = combineNumber(a[i].n ? 1 / a[i].n : 0, b[i].n ? 1 / b[i].n : 0, op, spec.identity);
      if (n <= 0) return null;                     // an infinite depth is not a `perspective()`
      args.push(formatNumber(1 / n) + (a[i].unit || b[i].unit));
      continue;
    }
    args.push(formatNumber(combineNumber(a[i].n, b[i].n, op, spec.identity)) + (a[i].unit || b[i].unit));
  }
  return `${(x || y).name}(${args.join(', ')})`;
}

// The three list types, as the shared loop sees them.
const LIST_TYPES = {
  __proto__: null,
  shadowList: {
    separator: ',',
    join: ', ',
    parse: parseShadow,
    combine: (x, y, op, prop) => combineShadow(x, y, op, SHADOW_LENGTHS[prop] || 4)
  },
  filterList: { separator: ' ', join: ' ', parse: parseFilter, combine: combineFilter },
  transform:  { separator: ' ', join: ' ', parse: parseTransformFn, combine: combineTransform }
};

// A running animation asks for the SAME two texts on every read of the property, and on every
// element the animation covers — so each distinct list is parsed once. Content-addressed, so
// nothing in it can go stale, and bounded, because a page may animate through many values (an
// element's own `style` written per frame is a fresh string every time).
const PARSED_LISTS = new Map();
const PARSED_LISTS_MAX = 512;
function parseList(type, text) {
  const s = String(text).trim();
  if (!s || s.toLowerCase() === 'none') return [];
  const key = `${type}|${s}`;
  const hit = PARSED_LISTS.get(key);
  if (hit !== undefined) return hit;
  const list = LIST_TYPES[type];
  const out = [];
  let parsed = out;
  for (const entry of splitValues(s, list.separator)) {
    const one = list.parse(entry);
    if (!one) { parsed = null; break; }
    out.push(one);
  }
  // The parsed entries are read-only to every caller — `combineList` builds its own arrays rather
  // than writing through them.
  if (PARSED_LISTS.size >= PARSED_LISTS_MAX) PARSED_LISTS.clear();
  PARSED_LISTS.set(key, parsed);
  return parsed;
}

// Two lists combined entry by entry, or null when any pair refuses.
function combineList(type, from, to, op, prop) {
  const list = LIST_TYPES[type];
  const a = parseList(type, from), b = parseList(type, to);
  if (!a || !b) return null;
  const n = Math.max(a.length, b.length);
  if (!n) return 'none';
  const out = [];
  for (let i = 0; i < n; i++) {
    const entry = list.combine(a[i], b[i], op, prop);
    if (entry == null) return null;
    out.push(entry);
  }
  return out.join(list.join);
}

// Whether a value is actually the list its animation type says it is — mdn's type names are a
// classification, not a parse, and two properties it gives the same name to can hold quite
// different things (`font-variation-settings` is typed `transform`, and a `"wdth" 5` is no
// transform function).
const isListOfType = (type, text) => !!parseList(type, text);

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
  length:  (f, t, p, prop) => interpolateLengthPercentage(zeroForNormal(prop, f), zeroForNormal(prop, t), p, false),
  lpc:     (f, t, p, prop) => interpolateLengthPercentage(zeroForNormal(prop, f), zeroForNormal(prop, t), p, true),
  color:   (f, t, p) => interpolateColor(f, t, p),
  shadowList: (f, t, p, prop) => combineList('shadowList', f, t, { p }, prop),
  filterList: (f, t, p, prop) => combineList('filterList', f, t, { p }, prop),
  transform:  (f, t, p, prop) => combineList('transform', f, t, { p }, prop)
};

const isInferredType = (type) => type === 'byComputedValue' || type === 'byComputedValueType';

// The value `prop` reports at progress `p` between two COMPUTED values, or `null` when the pair is
// not interpolable at all — the caller then falls back to discrete, which needs no computation.
export function interpolateProperty(prop, from, to, p) {
  if (from == null || to == null) return null;
  const a = String(from).trim(), b = String(to).trim();
  if (a === b) return a;                       // identical endpoints need no arithmetic
  const type = ANIMATION_TYPES[prop];
  if (type === 'notAnimatable' || type === 'discrete') return null;
  const handler = TYPE_HANDLERS[type] || (isInferredType(type) ? inferHandler(a, b) : null);
  if (!handler) return null;
  const out = handler(a, b, p, prop);
  return out == null ? null : clampToRange(prop, out);
}

// "As its computed-value type": ask the two values what they are. A pair of numbers with the same
// unit interpolates numerically, a pair of colours as colours, and anything else discretely.
function inferHandler(a, b) {
  if (rgbaValue(a) && rgbaValue(b)) return TYPE_HANDLERS.color;
  const na = numericValue(a), nb = numericValue(b);
  if (!na || !nb) return null;
  return na.unit || nb.unit ? TYPE_HANDLERS.lpc : TYPE_HANDLERS.number;
}

const isPlainNumber = (v) => { const n = numericValue(v); return !!n && !n.unit; };

// Two values COMBINED with the one underneath them, for `composite: 'add'` and `'accumulate'` —
// the numeric types compose, and anything else takes the effect's own value (the spec's fallback
// when the operation is not defined for a type).
export function addValues(prop, under, value, mode) {
  if (under == null) return value;
  if (value == null) return under;
  const type = ANIMATION_TYPES[prop];
  const a = String(under).trim(), b = String(value).trim();
  if (LIST_TYPES[type]) {
    if (a === 'none' || !a) return b;
    if (b === 'none' || !b) return a;
    // …only when both sides really ARE the list the type promises, which is what makes a
    // `font-variation-settings` typed `transform` fall through to replacement rather than being
    // joined into nonsense.
    if (!isListOfType(type, a) || !isListOfType(type, b)) return value;
    // ADDITION and ACCUMULATION part company on lists: adding CONCATENATES the two, while
    // accumulating combines them entry by entry (Chrome-measured: `blur(1px)` accumulated with
    // `blur(5px)` is `blur(6px)`, but ADDED it is `blur(1px) blur(5px)`).
    if (mode !== 'accumulate') return type === 'shadowList' ? `${a}, ${b}` : `${a} ${b}`;
    const out = combineList(type, a, b, { accumulate: true }, prop);
    return out == null ? value : out;
  }
  // A COLOUR adds channel by channel — `rgb(10,20,30)` under `rgb(50,50,50)` is `rgb(60, 70, 80)`.
  if (type === 'color' || (isInferredType(type) && rgbaValue(a) && rgbaValue(b))) {
    return addColors(a, b) || value;
  }
  // A NUMERIC type composes with what is underneath it. Where mdn names the type outright that is
  // the whole test; where it defers to the values ("byComputedValueType", which `opacity` and its
  // kind take), a plain NUMBER always composes but a LENGTH or percentage only does where the
  // property really is one value rather than a list — ADDS_DIMENSION, measured property by
  // property (`font-size` and `stroke-width` compose, `grid-auto-columns` replaces).
  const declared = TYPE_HANDLERS[type];
  const composes = declared === TYPE_HANDLERS.number || declared === TYPE_HANDLERS.integer ||
                   declared === TYPE_HANDLERS.length || declared === TYPE_HANDLERS.lpc ||
                   (isInferredType(type) && (ADDS_DIMENSION[prop] || (isPlainNumber(a) && isPlainNumber(b))));
  if (!composes) return value;
  const x = numericValue(zeroForNormal(prop, a)), y = numericValue(zeroForNormal(prop, b));
  if (!x || !y) return value;
  if (x.unit !== y.unit && x.n !== 0 && y.n !== 0) return value;   // no common unit to add in
  const sum = formatNumber(x.n + y.n);
  return sum == null ? value : clampToRange(prop, sum + (x.unit || y.unit));
}

// The DISCRETE answer, which every uninterpolable pair takes: the first value until half way, the
// second from there on (web-animations §Interpolation — and outside [0,1] the nearer end, which is
// what a progress of -0.3 or 1.5 picks).
export function discreteValue(from, to, p) { return p < 0.5 ? from : to; }
