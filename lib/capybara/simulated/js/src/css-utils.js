// Small CSS / selector parsing primitives shared between the
// cascade resolver, @media evaluator, and selector tokenizer.

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
// generic string form; font-family unquotes valid identifier sequences (not modelled
// here — a property-specific rule).
function serializeCssString(value) {
  return '"' + String(value).replace(/[\\"]/g, '\\$&') + '"';
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
// (`color:: invalid`) is dropped as malformed. Property names fold to lower case.
export function parseStyleDecls(css) {
  const out = {};
  let i = 0;
  const n = css.length;
  while (i < n) {
    while (i < n && (css[i] === ';' || /\s/.test(css[i]))) i++;
    if (i >= n) break;
    const nameStart = i;
    while (i < n && /[a-zA-Z-]/.test(css[i])) i++;
    if (i === nameStart) { i++; continue; }
    const name = css.slice(nameStart, i).toLowerCase();
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
    if (name && v[0] !== ':') out[name] = v;
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
