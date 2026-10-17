// Small CSS / selector parsing primitives shared between the cascade resolver, @media evaluator,
// and selector tokenizer — and the property-NAME tables the whole driver agrees on, which are the style engine's
// (css-properties.js): what counts as a property, what an alias names, and which IDL attribute reads which property.

import { PROPERTIES } from './css-properties.js';
import { dataUrlText } from './data-url.js';
import { responseHeader } from './header-rules.js';
import { documentBaseURL } from './base-url.js';

// Each name a page can write and the property it names: an ALIAS — the `-webkit-` spellings the Compat Standard
// defines, css-fonts-4's `font-width` — the property it is another name for, resolved the moment a declaration is
// parsed (`#a { -webkit-transform: scale(2) }` serializes as `transform: scale(2)`, and `getPropertyValue` answers to
// either spelling); any other name itself.
const PROPERTY_OF = { __proto__: null };
// The longhands, and the properties that animate (a shorthand does when a longhand under it does).
export const LONGHANDS = new Set();
const ANIMATABLE = new Set();
for (const [name, property, animatable, longhand] of PROPERTIES) {
  PROPERTY_OF[name] = property;
  if (name !== property) continue;
  if (longhand) LONGHANDS.add(name);
  if (animatable) ANIMATABLE.add(name);
}

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

// Whether a fetched stylesheet is one — the engine's (sheet_owners.rs `sheet_response_accepted`): `text/css`, or no
// MIME type at all, or in a quirks-mode document a same-origin response. `resp` is the fetch's `{ url, headers }`, or
// null where its facts are unknown (a service worker's body, one cached before they were kept) — accepted, as every
// fetch used to be.
export function stylesheetResponseAccepted(resp, doc) {
  if (!resp) return true;
  return globalThis.__dom.sheetResponseAccepted(responseHeader(resp.headers, 'content-type') ?? '', String(resp.url ?? ''), !!(doc && doc._quirks));
}

// A style sheet's text as fetched for `url` — for the `<link>` / `<?xml-stylesheet?>` `.sheet` getters and the
// `@import` rule loader — or null where the resource cannot be loaded (a 404, an unreachable URL), which is not '' (a
// reachable but empty sheet): a `data:` URL of CSS; else what a controlling service worker answers (destination
// 'style'; memoized per URL in bridge.entry, so the cascade, `.sheet` and the link's load event share one dispatch and
// one body); else the network's.
export function fetchStyleSheetText(url) {
  if (/^data:/i.test(url)) return dataUrlText(url, 'text/css');
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

// The active document's base URL (respecting `<base href>`), for resolving relative CSS URLs authored in a document
// `<style>` / inline style. Falls back to the raw location, then undefined.
export function documentBaseUrl() {
  return (globalThis.document && documentBaseURL(globalThis.document)) || (globalThis.location && globalThis.location.href) || undefined;
}
