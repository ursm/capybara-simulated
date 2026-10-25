// Small CSS / selector parsing primitives shared between the cascade resolver, @media evaluator,
// and selector tokenizer — and the property-NAME tables the whole driver agrees on, which are the style engine's
// (css-properties.js): what counts as a property, what an alias names, and which IDL attribute reads which property.

import { PROPERTIES } from './css-properties.js';
import { asciiLower } from './ascii.js';
import { processDataUrl } from './data-url.js';
import { parseMimeType } from './mime.js';
import { responseHeader } from './header-rules.js';
import { documentBaseURL } from './base-url.js';
import { blobResponse, resolveBlobBytes } from './blob.js';
import { J_CSS_MODULE, J_SHEET, ROUTE_BLOB, ROUTE_DATA, S_NO_BODY, SRC_ASSET, SRC_SCHEME, SRC_SW_SYNC, V_CROSS_ORIGIN, V_FETCHED, V_OK } from './constants.js';
import { schemeRoute } from './url-parse.js';
import { corsAssetArgs, requestClientOf, requestingRealm, sheetAsset } from './handles.js';

// Each name a page can write and the property it names: an ALIAS — the `-webkit-` spellings the Compat Standard
// defines, css-fonts-4's `font-width` — the property it is another name for, resolved the moment a declaration is
// parsed (`#a { -webkit-transform: scale(2) }` serializes as `transform: scale(2)`, and `getPropertyValue` answers to
// either spelling); any other name itself.
const PROPERTY_OF = { __proto__: null };
// The longhands.
export const LONGHANDS = new Set();
for (const [name, property, longhand] of PROPERTIES) {
  PROPERTY_OF[name] = property;
  if (name === property && longhand) LONGHANDS.add(name);
}

// A property name as the CSSOM stores it: ASCII-lowercased (custom `--…` properties are
// case-SENSITIVE and pass through), with an alias resolved to the property it names.
// It is the ONE place that resolution happens, so a declaration is under its one name from the moment it is
// parsed and every reader downstream — serialization, the cascade, the resolved value — sees one
// property rather than two spellings of it.
export function cssPropertyName(name) {
  const text = String(name);
  if (text.indexOf('--') === 0) return text;
  // (…ASCII alone: `font-\u212Aerning`, a Kelvin sign for its K, names no property — the engine's `PropertyId::parse`)
  const lower = asciiLower(text);
  return PROPERTY_OF[lower] || lower;
}

// Whether a name is a CSS property of the IDL surface — the attributes CSSStyleDeclaration carries, and the named
// writes they take. Custom `--` properties are the caller's concern. An ALIAS answers true under its own spelling;
// `cssPropertyName` is what turns it into the property it names.
export function isSupportedCssPropertyName(name) {
  return PROPERTY_OF[name] !== undefined;
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

// What a fetched style sheet's response comes to — the engine's verdict (subresource_judge.rs `judge`: a response at all,
// one that is a style sheet — `text/css`, no MIME type at all, a quirks-mode document's CORS-same-origin one of any type,
// `text/css` alone under `nosniff` — and whether it is CORS-cross-origin) — `resp` its facts as the host, a service
// worker or a scheme's processor gives them, `source` what answered (`SRC_*`), judged in the realm's document.
const judgeSheet = (resp, source) => globalThis.__dom.subresourceJudge(J_SHEET, null, resp, source, globalThis.document?._nid);
// …a controlling service worker's answer for a sheet at `url` (destination 'style'; memoized per URL in bridge.entry, so
// the cascade, `.sheet` and the link's load event share one dispatch and one body): its text, null where it refused it
// or answered no body, undefined where none answered.
export function swStyleSheetText(url) {
  let sw = null;
  try { sw = typeof globalThis.__csimSwFetchStyle === 'function' ? globalThis.__csimSwFetchStyle(url) : null; } catch (_) {}
  if (!sw) return undefined;
  return judgeSheet(sw, SRC_SW_SYNC | (sw.body == null ? S_NO_BODY : 0)) & V_OK ? sw.body : null;
}

// A style sheet's text as fetched for `url` — for the `<link>` / `<?xml-stylesheet?>` `.sheet` getters and the
// cascade's sheets and `@import`s — or null where the resource cannot be loaded (a 404, an unreachable URL), which is
// not '' (a reachable but empty sheet): a `data:` URL of CSS; else what a controlling service worker answers
// (`swStyleSheetText`); else the network's. `owner` the sheet's `<link>`, whose `charset` is its environment's
// encoding; `environment` the encoding of the sheet that imports it, for an `@import`. A `blob:` URL's is its blob's.
export function fetchStyleSheetText(url, owner = null, environment = null) {
  const route = schemeRoute(url);
  if (route === ROUTE_DATA) return dataStyleSheetText(url, owner, environment);
  if (route === ROUTE_BLOB) return blobStyleSheetText(url, owner, environment);
  return swStyleSheetText(url) ?? networkStyleSheetText(url, owner, environment);
}
// …and whether the response a sheet at `url` was made of — `text` its body, null where its load failed — is
// CORS-same-origin, which makes the sheet origin-clean (CSSOM; HTML's link "process the linked resource"): a `data:` or
// `blob:` URL's, a service worker's answer that is no opaque one, a network response of type `basic` or `cors`, an HTTP
// error's too — not one of another origin, nor a network error, which is no response at all (`judgeSheet`: a body the
// host kept no facts for a response all the same, a worker's answer with no status none).
export function styleSheetOriginClean(url, text) {
  const route = schemeRoute(url);
  if (route === ROUTE_DATA || route === ROUTE_BLOB) return true;
  let sw = null;
  try { sw = typeof globalThis.__csimSwFetchStyle === 'function' ? globalThis.__csimSwFetchStyle(url) : null; } catch (_) {}
  const verdict = sw
    ? judgeSheet(sw, SRC_SW_SYNC | (sw.body == null ? S_NO_BODY : 0))
    : judgeSheet(externalAssetMeta(url), SRC_ASSET | (text == null ? S_NO_BODY : 0));
  return (verdict & (V_FETCHED | V_CROSS_ORIGIN)) === V_FETCHED;
}
// …the host's facts of the asset it last served for `url`, null where it kept none.
function externalAssetMeta(url) {
  const meta = typeof globalThis.__csimExternalAssetMeta === 'function' ? globalThis.__csimExternalAssetMeta(url) : null;
  return meta && typeof meta === 'object' ? meta : null;
}
// …the network's: EMPTY where the response is no style sheet (`judgeSheet`) — a sheet with no rules,
// which is what the CSSOM exposes for one (Chrome, Firefox) and what the cascade keeps rather than fetch it again.
export function networkStyleSheetText(url, owner = null, environment = null) {
  if (typeof globalThis.__csimExternalAsset !== 'function') return null;
  let body = null;
  // (…requested by its `<link>`'s node document, under the referrer policy its attribute sets where it has one — a CORS
  // request where its `crossorigin` says so — and failed once for it: handles.js `sheetAsset`)
  try {
    body = owner && owner._nid != null
      ? sheetAsset(owner, url, requestClientOf(owner), 'style', corsAssetArgs(owner))
      : globalThis.__csimExternalAsset(url, globalThis.__csimDocToken, requestingRealm(), '', 'style');
  } catch (_) { return null; }
  if (body == null) return null;
  const meta = externalAssetMeta(url);
  if (!(judgeSheet(meta, SRC_ASSET) & V_OK)) return '';
  // (…its bytes, where the host kept them — none where they are the UTF-8 of its text)
  const bytes = typeof globalThis.__csimExternalAssetBytes === 'function' ? globalThis.__csimExternalAssetBytes(url) : null;
  return decodeStyleSheet(url, bytes ?? body, responseHeader(meta?.headers, 'content-type'), owner, environment) ?? body;
}
// A CSS module script's text for `url` (HTML "fetch a single module script", destination `style`, mode `cors` — the
// sheet a declarative shadow root's `shadowrootadoptedstylesheets` adopts): its response's body UTF-8-decoded whatever
// its charset or `@charset` says, where its MIME type is `text/css` exactly, quirks mode or not — a `data:` URL's, a
// `blob:`'s, a controlling service worker's answer (one dispatch per URL for the page, as the module map makes it:
// `moduleSwAnswers`), else the network's — or null where it is none: no sheet.
const moduleSwAnswers = new Map();
export function moduleStyleSheetText(url) {
  // (…its response judged as a CSS module script's: subresource_judge.rs `judge`)
  const judged = (resp, source) => (globalThis.__dom.subresourceJudge(J_CSS_MODULE, null, resp, source) & V_OK) !== 0;
  let bytes = null, text = null;
  const route = schemeRoute(url);
  if (route === ROUTE_DATA) {
    const parsed = processDataUrl(url);
    if (parsed === null || !judged({ contentType: parsed.mimeType }, SRC_SCHEME)) return null;
    bytes = parsed.body;
  } else if (route === ROUTE_BLOB) {
    const resp = blobResponse(url, resolveBlobBytes(url), 'GET', null);
    if (resp === null || !judged(resp, SRC_SCHEME)) return null;
    bytes = resp.body_bytes;
  } else {
    if (!moduleSwAnswers.has(url) && typeof globalThis.__csimSwFetchDest === 'function') {
      moduleSwAnswers.set(url, globalThis.__csimSwFetchDest(url, 'style', 'cors', 'same-origin', true));
    }
    const sw = moduleSwAnswers.get(url) ?? null;
    if (sw) {
      if (!judged(sw, SRC_SW_SYNC | (sw.bytes == null ? S_NO_BODY : 0))) return null;
      bytes = sw.bytes;
    } else {
      if (typeof globalThis.__csimExternalAsset !== 'function') return null;
      try { text = globalThis.__csimExternalAsset(url, globalThis.__csimDocToken, globalThis.__csimRealmId(), '', 'style', 'cors', 'same-origin'); } catch (_) { return null; }
      if (!judged(externalAssetMeta(url), SRC_ASSET | (text == null ? S_NO_BODY : 0))) return null;
      // (…its bytes, where the host kept them — none where they are the UTF-8 of its text)
      bytes = typeof globalThis.__csimExternalAssetBytes === 'function' ? globalThis.__csimExternalAssetBytes(url) : null;
    }
  }
  return bytes === null ? text : globalThis.__dom.decodeBytes(bytes, 'utf-8');
}
// …whether `url` is one its scheme's own processor answers (a `data:` / `blob:` one: url-parse.js `schemeRoute`), which
// no service worker nor network sees.
export const ownSchemeSheet = (url) => {
  const route = schemeRoute(url);
  return route === ROUTE_DATA || route === ROUTE_BLOB;
};
// …a `blob:` URL's: its blob's bytes, a style sheet's response as a network one is judged (`judgeSheet`:
// EMPTY where its type is none), decoded as a fetched one is; null where it names no blob. Fetched once for its owner —
// the `<link>` that loaded it, in its `charset`; an `@import`'s, by the encoding it imports in — the sheet it gave
// staying that owner's text, as a loaded one does, though the page revokes the URL from its `load` handler and every
// later rebuild of the cascade asks again; a new owner fetches anew, and finds a revoked URL gone (Chrome: `error`,
// nothing applied). `forgetFetchedSheets` lets go of them for a new page.
let blobSheetTexts = new WeakMap();
const blobImportTexts = new Map();
function blobStyleSheetText(url, owner, environment) {
  const texts = owner === null ? blobImportTexts : (blobSheetTexts.get(owner) ?? blobSheetTexts.set(owner, new Map()).get(owner));
  const key = url + '\0' + (owner === null ? environment ?? '' : owner._attrs?.charset ?? '');
  if (texts.has(key)) return texts.get(key);
  const resp = blobResponse(url, resolveBlobBytes(url), 'GET', null);
  if (resp === null) return null;
  let text = '';
  if (judgeSheet(resp, SRC_SCHEME) & V_OK) {
    const bytes = resp.body_bytes;
    text = decodeStyleSheet(url, bytes, responseHeader(resp.headers, 'content-type'), owner, environment) ?? globalThis.__dom.decodeBytes(bytes, 'utf-8');
  }
  texts.set(key, text);
  return text;
}
// …a `data:` URL's: one of `text/css`, decoded as a fetched one is (its MIME type's charset, an `@charset`, …).
function dataStyleSheetText(url, owner, environment) {
  const parsed = processDataUrl(url);
  if (parsed === null || parseMimeType(parsed.mimeType)?.essence !== 'text/css') return null;
  const bytes = parsed.body;
  return decodeStyleSheet(url, bytes, parsed.mimeType, owner, environment) ?? globalThis.__dom.decodeBytes(bytes, 'utf-8');
}
// CSS Syntax "decode" of a sheet (text_codec.rs `stylesheet_encoding`): by its Content-Type's charset, an opening
// `@charset`, its environment's encoding — its `<link>`'s `charset`, else the importing sheet's or its document's —
// else UTF-8, a BOM's over all; its text, or undefined where that is the host's as it stands. The encoding it decoded
// with is kept by URL: it is an `@import`'s environment (CSS Cascade 5 §2.2).
const sheetEncodings = new Map();
export const sheetEncodingOf = (url) => sheetEncodings.get(url);
// …forgotten for a new page, with the blob: sheets' texts (cascade.js `resetCascadeState`).
export function forgetFetchedSheets() {
  sheetEncodings.clear();
  blobSheetTexts = new WeakMap();
  blobImportTexts.clear();
  moduleSwAnswers.clear();
}
function decodeStyleSheet(url, input, contentType, owner, environment) {
  const charset = owner && owner._attrs ? owner._attrs.charset ?? '' : '';
  const [text, encoding] = globalThis.__dom.stylesheetText(input, contentType ?? '', charset, environment ?? globalThis.document?.characterSet ?? '');
  sheetEncodings.set(url, encoding);
  return text;
}
// The active document's base URL (respecting `<base href>`), for resolving relative CSS URLs authored in a document
// `<style>` / inline style. Falls back to the raw location, then undefined.
export function documentBaseUrl() {
  return (globalThis.document && documentBaseURL(globalThis.document)) || (globalThis.location && globalThis.location.href) || undefined;
}
