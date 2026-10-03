// Small CSS / selector parsing primitives shared between the cascade resolver, @media evaluator,
// and selector tokenizer — and the property-NAME tables the whole driver agrees on, which are the style engine's
// (css-properties.js): what counts as a property, what an alias names, and which IDL attribute reads which property.

import { PROPERTIES } from './css-properties.js';

// Each name a page can write and the property it names: an ALIAS — the `-webkit-` spellings the Compat Standard
// defines, css-fonts-4's `font-width` — the property it is another name for, resolved the moment a declaration is
// parsed (`#a { -webkit-transform: scale(2) }` serializes as `transform: scale(2)`, and `getPropertyValue` answers to
// either spelling); any other name itself.
const PROPERTY_OF = { __proto__: null };
// The longhands, each with its initial value as a computed style serializes it; each shorthand with its longhands; and
// the properties that animate (a shorthand does when a longhand under it does).
export const INITIAL_VALUES = { __proto__: null };
export const SHORTHAND_LONGHANDS = { __proto__: null };
const ANIMATABLE = new Set();
for (const [name, property, animatable, longhands, initial] of PROPERTIES) {
  PROPERTY_OF[name] = property;
  if (name !== property) continue;
  if (initial === null) SHORTHAND_LONGHANDS[name] = longhands;
  else INITIAL_VALUES[name] = initial;
  if (animatable) ANIMATABLE.add(name);
}
export const LONGHANDS = new Set(Object.keys(INITIAL_VALUES));

// A property name as the CSSOM stores it: ASCII-lowercased (custom `--…` properties are
// case-SENSITIVE and pass through), with an alias resolved to the property it names.
// It is the ONE place that resolution happens, so a declaration is under its one name from the moment it is
// parsed and every reader downstream — serialization, the cascade, the resolved value — sees one
// property rather than two spellings of it.
export function cssPropertyName(name) {
  const text = String(name);
  if (text.indexOf('--') === 0) return text;
  const lower = text.toLowerCase();
  return PROPERTY_OF[lower] || lower;
}

// Whether a name is a CSS property of the IDL surface — the attributes CSSStyleDeclaration carries, and the named
// writes they take. Custom `--` properties are the caller's concern. An ALIAS answers true under its own spelling;
// `cssPropertyName` is what turns it into the property it names.
export function isSupportedCssPropertyName(name) {
  return PROPERTY_OF[name] !== undefined;
}

// Whether a property animates: a keyframe of one that does not is no keyframe at all (web-animations §Processing a
// keyframes argument). Custom properties are the caller's concern.
export function isAnimatableProperty(property) {
  return ANIMATABLE.has(property);
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

// …the camel-cased attribute of a property: the one CSSOM names it by first.
export function idlAttributeOf(property) {
  return cssPropertyToIdlAttribute(property, false);
}

// Every IDL attribute CSSOM exposes, mapped to the property it reads. One property is spelled up
// to three ways: the camel-cased attribute always, its own dashed name whenever it carries a `-`,
// and the webkit-cased legacy spelling for the `-webkit-…` family — plus `cssFloat`, the alias
// CSSOM minted because `float` was a reserved word when the interface was written. cssom.js turns
// this into the accessors on CSSStyleDeclaration.prototype; style-proxy reads it to resolve a
// named access back to a property.
//
// Generated in the LOSSLESS direction, and the authority for the reverse one: camel-casing drops a
// dash before a digit without leaving a case boundary to fold back on, so a name round-tripped by
// hand would not come back.
export const CSS_PROPERTY_BY_IDL_ATTRIBUTE = (() => {
  const attributes = { __proto__: null };
  for (const name in PROPERTY_OF) {
    // The RESOLVED property, so a reader that folds an attribute back to a name gets the one the
    // declaration is stored under: `webkitTransform` reads `transform`, as it does in a browser.
    const property = PROPERTY_OF[name];
    attributes[cssPropertyToIdlAttribute(name, false)] = property;
    if (name.includes('-'))          attributes[name] = property;
    if (name.startsWith('-webkit-')) attributes[cssPropertyToIdlAttribute(name, true)] = property;
  }
  attributes.cssFloat = 'float';
  return attributes;
})();
// One `<length>` token: a number and a length unit (a bare zero is the caller's to allow).
export const CSS_LENGTH_RE = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?(?:px|cm|mm|q|in|pc|pt|em|rem|ex|rex|ch|rch|cap|rcap|ic|ric|lh|rlh|vw|vh|vi|vb|vmin|vmax|svw|svh|svi|svb|svmin|svmax|lvw|lvh|lvi|lvb|lvmin|lvmax|dvw|dvh|dvi|dvb|dvmin|dvmax|cqw|cqh|cqi|cqb|cqmin|cqmax)$/i;
const PERCENT_TOKEN_RE = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?%$/i;

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

// Absolute <font-size> keywords → px. Browsers use a FIXED table (NOT the CSS spec's
// informative scaling ratios), anchored at the default `medium` = 16px — these are the
// values Chrome / Firefox actually report from getComputedStyle. Shared by the
// getComputedStyle font-size resolver and the canvas `font` shorthand parser so both agree.
export const ABSOLUTE_FONT_SIZE_PX = {
  'xx-small': 9, 'x-small': 10, 'small': 13, 'medium': 16,
  'large': 18, 'x-large': 24, 'xx-large': 32, 'xxx-large': 48,
};

// Whether a fetched stylesheet is one (HTML "process the linked resource" for `rel=stylesheet`, and CSS Cascade's
// `@import`): a response whose Content-Type is not `text/css` is not — unless the document is in quirks mode and the
// response is same-origin, where the type is ignored. Chrome and Firefox both refuse one ("not a supported stylesheet
// MIME type"); applied, a page's `@import` answered with an HTML page cascaded that page's text as thousands of rules.
// A response that names no type at all is one, though — both apply it (Blink's `CanUseSheet` takes an empty type and
// `application/x-unknown-content-type`, what a missing header is sniffed as). `resp` is the fetch's `{ url, headers }`,
// or null where its facts are unknown (a service worker's body, one cached before they were kept) — accepted, as every
// fetch used to be.
const SHEET_TYPES = new Set(['', 'text/css', 'application/x-unknown-content-type']);
export function stylesheetResponseAccepted(resp, doc) {
  if (!resp) return true;
  const headers = resp.headers || {};
  let type = '';
  for (const k in headers) if (k.toLowerCase() === 'content-type' && headers[k] != null) type = String(headers[k]);
  if (SHEET_TYPES.has(type.split(';')[0].trim().toLowerCase())) return true;
  if (!(doc && doc._quirks)) return false;
  try { return new globalThis.URL(String(resp.url)).origin === globalThis.location.origin; } catch (_) { return false; }
}

// A style sheet's text as fetched for `url` — for the `<link>` / `<?xml-stylesheet?>` `.sheet` getters and the
// `@import` rule loader — or null where the resource cannot be loaded (a 404, an unreachable URL), which is not '' (a
// reachable but empty sheet): a `data:` URL of CSS; else what a controlling service worker answers (destination
// 'style'; memoized per URL in bridge.entry, so the cascade, `.sheet` and the link's load event share one dispatch and
// one body); else the network's.
export function fetchStyleSheetText(url) {
  if (/^data:/i.test(url)) return decodeDataUrlCss(url);
  if (typeof globalThis.__csimSwFetchStyle === 'function') {
    try {
      const sw = globalThis.__csimSwFetchStyle(url);
      if (sw) return (sw.blocked || sw.body == null) ? null : sw.body;
    } catch (_) {}
  }
  return networkStyleSheetText(url);
}
// …the network's: EMPTY where the response is no style sheet (`stylesheetResponseAccepted`) — a sheet with no rules,
// which is what the CSSOM exposes for one (Chrome, Firefox) and what the cascade keeps rather than fetch it again.
export function networkStyleSheetText(url) {
  if (typeof globalThis.__csimExternalAsset !== 'function') return null;
  let body = null;
  try { body = globalThis.__csimExternalAsset(url, globalThis.__csimDocToken); } catch (_) { return null; }
  if (body == null) return null;
  const meta = typeof globalThis.__csimExternalAssetMeta === 'function' ? globalThis.__csimExternalAssetMeta(url) : null;
  return stylesheetResponseAccepted(meta && typeof meta === 'object' ? meta : null, globalThis.document) ? body : '';
}

export function decodeDataUrlCss(href) {
  const m = /^data:([^,]*),([\s\S]*)$/i.exec(String(href || ''));
  if (!m) return null;
  const meta = m[1];
  const mediaType = meta.replace(/;base64\s*$/i, '').split(';')[0].trim().toLowerCase();
  if (mediaType !== 'text/css') return null;
  if (/;base64\s*$/i.test(meta)) { try { return globalThis.atob(m[2]); } catch (_) { return ''; } }
  try { return decodeURIComponent(m[2]); } catch (_) { return m[2]; }
}

// The active document's base URL (respecting `<base href>`), for resolving relative CSS URLs
// authored in a document `<style>` / inline style. Falls back to the raw location, then undefined.
export function documentBaseUrl() {
  return (globalThis.document && globalThis.document.baseURI) || (globalThis.location && globalThis.location.href) || undefined;
}


// `stroke-dasharray` as the computed value reports it: a comma-separated list of LENGTHS. Its
// entries may be written separated by whitespace, commas or both, and an entry may be a bare
// number — SVG user units, which are px (Chrome-measured: `stroke-dasharray: 4 2` reports
// `4px, 2px`, and so does `4,2`). `none` is a keyword and stays one.
const BARE_NUMBER_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;


// One numeric token, with or without a unit: `1`, `-.5`, `10px`, `1e1%`.
const NUMERIC_TOKEN_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?[a-z%]*$/i;
const Y_EDGES = new globalThis.Set(['top', 'bottom']);



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
// An ALPHA is reported as the shortest decimal — to two places — that lands on the same BYTE, else to three: `#ffffff80`
// is `0.5` (not the 0.502 the division gives), `#ffffffc0` is `0.753` because `0.75` would land on the neighbouring
// byte, `#ffffff01` is `0.004`, `rgba(…, 0.123456)` is `0.12`. It is the NUMBER that is rounded, not the byte: `0.7777`
// is `0.778` (Firefox; Chrome keeps the byte, 198, and writes `0.776`), and `0.999` rounds to `1` in an `rgba()` still.
export function serializeAlpha(a) {
  const byte = Math.round(a * 255);
  for (let places = 1; places <= 2; places++) {
    const candidate = +a.toFixed(places);
    if (Math.round(candidate * 255) === byte) return candidate;
  }
  return +a.toFixed(3);
}
// The computed value of an sRGB colour, `{ r, g, b }` bytes and its alpha `a`: `rgb()` when opaque, else `rgba()`.
export const formatSrgb = (c) => (c.a >= 1 ? `rgb(${c.r}, ${c.g}, ${c.b})` : `rgba(${c.r}, ${c.g}, ${c.b}, ${serializeAlpha(c.a)})`);

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
  // The individual transform properties report their SHORTEST form, units as written (Chrome and Firefox alike). A
  // rotation's angle goes last, and an axis along X, Y or Z is its keyword — Z no axis at all, and one pointing the
  // other way turns the angle round (`45deg x` is `x 45deg`, `0 0 -1 30deg` is `-30deg`, `2 0 0 1rad` is `x 1rad`)…
  rotate(v) {
    const parts = splitTopLevelWhitespace(v);
    if (parts.length < 2) return v;
    const angleFirst = parts.length === 2 ? /^[xyz]$/i.test(parts[1]) : !BARE_NUMBER_RE.test(parts[0]) && BARE_NUMBER_RE.test(parts[3]);
    let angle = angleFirst ? parts[0] : parts[parts.length - 1];
    const axisText = angleFirst ? parts.slice(1) : parts.slice(0, -1);
    const axis = axisText.length === 1 ? ROTATE_AXES[axisText[0].toLowerCase()] : axisText.map(Number);
    if (!axis || axis.some(Number.isNaN)) return v;
    const along = axis.findIndex((c) => c !== 0);
    if (along < 0 || axis.some((c, i) => i !== along && c !== 0) || (axis[along] < 0 && !NUMERIC_TOKEN_RE.test(angle))) {
      return `${axisText.join(' ')} ${angle}`;
    }
    if (axis[along] < 0) angle = angle[0] === '-' ? angle.slice(1) : angle[0] === '+' ? `-${angle.slice(1)}` : `-${angle}`;
    return ['x ', 'y ', ''][along] + angle;
  },
  // …a translation's zero Z is not written, nor then a zero Y (a zero PERCENTAGE is not a zero length, and stays)…
  translate(v) {
    const parts = splitTopLevelWhitespace(v);
    const zero = (tok) => isZeroToken(tok) || (CSS_LENGTH_RE.test(tok) && parseFloat(tok) === 0);
    if (parts.length === 3 && zero(parts[2])) parts.pop();
    if (parts.length === 2 && zero(parts[1])) parts.pop();
    return parts.join(' ');
  },
  // …and a scale's percentages are the numbers they stand for, a Z of 1 is not written, nor then a Y equal to X.
  scale(v) {
    const parts = splitTopLevelWhitespace(v).map((tok) => (
      PERCENT_TOKEN_RE.test(tok) ? String(parseFloat((parseFloat(tok) / 100).toPrecision(12))) : tok
    ));
    if (parts.length === 3 && parts[2] === '1') parts.pop();
    if (parts.length === 2 && parts[0] === parts[1]) parts.pop();
    return parts.join(' ');
  }
});
const ROTATE_AXES = { __proto__: null, x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
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
// …and one TOKEN that is a zero, whatever its spelling.
const isZeroToken = (tok) => BARE_NUMBER_RE.test(tok) && Number(tok) === 0;

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
