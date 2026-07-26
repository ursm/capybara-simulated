// Small CSS / selector parsing primitives shared between the
// cascade resolver, @media evaluator, and selector tokenizer.

import { SUPPORTED_PROPERTY_NAMES, PROPERTY_VALUE_TYPES } from './css-property-data.js';

// Whether a normalised (lowercased) CSS property name is one browsers treat as supported: a
// standard/vendor property, or a legacy `-webkit-`-prefixed alias of one (`-webkit-box-shadow`
// → `box-shadow`, `webkitTransform` → `transform`). `-moz-`/`-ms-` names are NOT aliased (Chrome
// ignores `MozUserSelect`); only the specific ones mdn lists are in the set. Custom `--`
// properties are the caller's concern. Backs both the CSSOM supported-property gate (style-proxy:
// a named-property / setProperty write to an unsupported name is ignored) and `CSS.supports`.
export function isSupportedCssPropertyName(name) {
  if (SUPPORTED_PROPERTY_NAMES.has(name)) return true;
  const m = /^-webkit-(.+)$/.exec(name);
  return m != null && SUPPORTED_PROPERTY_NAMES.has(m[1]);
}

const CSS_WIDE_VALUE_KEYWORDS = new Set(['inherit', 'initial', 'unset', 'revert', 'revert-layer']);

// A CONSERVATIVE per-property value check (CSSOM "set a CSS declaration" ignores a value that
// doesn't parse for the property): returns FALSE only when we're CERTAIN `value` is invalid for
// `name`. Only longhands with a simple generated type (color / integer, PROPERTY_VALUE_TYPES) are
// checked; every other property — and any css-wide keyword, `var()`/`env()` substitution, or an
// allowed keyword alternative — is accepted, so a valid value is never dropped (over-rejection
// would silently discard a real declaration). `name` is the kebab longhand; `value` has no
// trailing `!important` (the caller strips it).
export function isValidDeclarationValue(name, value) {
  const type = PROPERTY_VALUE_TYPES[name];
  if (!type) return true;
  const s = String(value).trim();
  if (s === '') return true;                                    // empty is the caller's "clear" path
  // Any functional notation — a substitution (`var()`/`env()`), a math function (`calc()`/`min()`
  // /`max()`/`clamp()`), or a functional colour (`rgb()`/`oklch()`/`color()`) — is accepted without
  // further parsing: validating function internals cheaply isn't worth the over-rejection risk.
  if (s.indexOf('(') !== -1) return true;
  const low = s.toLowerCase();
  if (CSS_WIDE_VALUE_KEYWORDS.has(low)) return true;           // valid for every property
  if (type.keywords.indexOf(low) !== -1) return true;          // an allowed keyword alternative (auto, none, …)
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
  activetext: '#ff0000', buttonface: '#f0f0f0', buttontext: '#000000', buttonborder: '#767676',
  field: '#ffffff', fieldtext: '#000000', highlight: '#b3d7ff', highlighttext: '#000000',
  selecteditem: '#b3d7ff', selecteditemtext: '#000000', mark: '#ffff00', marktext: '#000000',
  graytext: '#808080', accentcolor: '#0078d4', accentcolortext: '#ffffff',
  // legacy CSS2 system colours
  activeborder: '#b4b4b4', activecaption: '#cccccc', appworkspace: '#ffffff', background: '#6363ce',
  buttonhighlight: '#dddddd', buttonshadow: '#888888', captiontext: '#000000', inactiveborder: '#f4f7fc',
  inactivecaption: '#f4f7fc', inactivecaptiontext: '#000000', infobackground: '#fbfcc5', infotext: '#000000',
  menu: '#f0f0f0', menutext: '#000000', scrollbar: '#f0f0f0', threeddarkshadow: '#696969',
  threedface: '#f0f0f0', threedhighlight: '#ffffff', threedlightshadow: '#e3e3e3', threedshadow: '#a0a0a0',
  window: '#ffffff', windowframe: '#646464', windowtext: '#000000'
};

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
  const n = Number(s);
  return Number.isFinite(n) ? String(n) : s;
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
  if (typeof value !== 'string' || value.indexOf('url(') === -1) return value;
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
export function serializeCssValue(raw) {
  let v = String(raw);
  if (!/[.'"]|url\(|-0/i.test(v)) return v;
  const bang = /\s*!\s*important\s*$/i.exec(v);
  if (bang) v = v.slice(0, bang.index);
  const CT = globalThis.__csimVendor && globalThis.__csimVendor.cssTree;
  if (!CT) return raw;
  let ast;
  try { ast = CT.parse(v, { context: 'value', positions: true }); } catch (_) { return raw; }
  const edits = [];
  CT.walk(ast, (node) => {
    const loc = node.loc;
    if (!loc) return;
    let rep = null;
    if (node.type === 'Number')          rep = normalizeCssNumber(node.value);
    else if (node.type === 'Percentage') rep = normalizeCssNumber(node.value) + '%';
    else if (node.type === 'Dimension')  rep = normalizeCssNumber(node.value) + node.unit;
    else if (node.type === 'Url')        rep = 'url("' + String(node.value).replace(/(["\\])/g, '\\$1') + '")';
    else if (node.type === 'String')     rep = serializeCssString(node.value);
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
// a custom property (`--…`) is case-sensitive and kept verbatim (see parseStyleDecls).
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

export function parseStyleDecls(css) {
  const out = {};
  let i = 0;
  const n = css.length;
  while (i < n) {
    while (i < n && (css[i] === ';' || /\s/.test(css[i]))) i++;
    if (i >= n) break;
    const nameStart = i;
    const decoded = consumeIdentName(css, i, n);
    i = decoded.i;
    if (i === nameStart) { i++; continue; }
    // Custom property names (`--…`) are case-SENSITIVE and kept verbatim; a regular
    // property name is ASCII case-insensitive, so it's lowercased.
    const name = decoded.name.indexOf('--') === 0 ? decoded.name : decoded.name.toLowerCase();
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
    if (name && v[0] !== ':') {
      // A duplicate declaration normally keeps its first position (value updated in place),
      // preserving serialization order. But the CSSOM `all` shorthand's cascade depends on
      // relative SOURCE order — a covered property re-declared after `all` (or a later `all`)
      // must win positionally — so within a block that involves `all`, a re-declared key
      // moves to the end (last occurrence wins). Gated on `all` so every other block is
      // untouched.
      if ((name === 'all' || out.all !== undefined) && out[name] !== undefined) delete out[name];
      out[name] = v;
    }
  }
  return out;
}

// Split `s` on top-level occurrences of single-char `sep`, respecting
// `[]` / `()` nesting. Used to slice comma-separated selector lists
// (`'input, textarea'`) and media-query lists without splitting on
// commas that appear inside attribute selectors or `:where(a, b)`
// pseudo-class arguments.
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
