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
  if (/;base64\s*$/i.test(meta)) { try { return globalThis.__csimAtob(m[2]); } catch (_) { return ''; } }
  try { return decodeURIComponent(m[2]); } catch (_) { return m[2]; }
}

// The active document's base URL (respecting `<base href>`), for resolving relative CSS URLs
// authored in a document `<style>` / inline style. Falls back to the raw location, then undefined.
export function documentBaseUrl() {
  return (globalThis.document && globalThis.document.baseURI) || (globalThis.location && globalThis.location.href) || undefined;
}

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

// A value's top-level components split on `sep`, never inside a function or a bracket: a separator inside a STRING is
// part of the string, and a `\`-escaped one part of the token it escapes (`font-family: "Foo, Bar"` and `A\,1` are
// each ONE component, Chrome-measured).
export function splitTopLevel(s, sep) {
  const parts = [];
  let depth = 0, start = 0, quote = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '\\') { i++; continue; }
    if (ch === '[' || ch === '(') depth++;
    else if (ch === ']' || ch === ')') depth--;
    else if (ch === sep && depth === 0) { parts.push(s.slice(start, i)); start = i + 1; }
  }
  parts.push(s.slice(start));
  return parts;
}
