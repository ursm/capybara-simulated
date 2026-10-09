// The IDL attributes that reflect a content attribute (HTML §2.6.1), as the generated bindings make them of their
// [Reflect…] extended attributes (script/gen_bindings.mjs): a DOMString's, a URL's, an enumerated one's, a boolean's,
// and a number's — the number read off the element by the engine (reflect.rs `reflectNumber`). A write sets or
// removes the content attribute as a page's `setAttribute` does, its reactions with it.

import { asciiLower } from './ascii.js';

// The number kinds, as reflect.rs knows them.
export const LONG = 0;
export const LONG_NON_NEGATIVE = 1;
export const UNSIGNED = 2;
export const UNSIGNED_POSITIVE = 3;
export const UNSIGNED_RANGE = 4;
export const DOUBLE = 5;
export const DOUBLE_POSITIVE = 6;
export const UNSIGNED_POSITIVE_FALLBACK = 7;

const MAX_LONG = 2147483647;

// What the element's node document resolves a URL by — dom-nodes.js's, which keeps the documents.
let resolveURL = null;
export function setURLResolver(resolve) { resolveURL = resolve; }

const valueOf = (el, name) => el._attrs[name] ?? null;

export const reflectString = (el, name) => valueOf(el, name) ?? '';
export const reflectNullableString = (el, name) => valueOf(el, name);
export function setReflectedString(el, name, value) {
  if (value === null) el._removeAttribute(name);
  else el._setAttribute(name, value);
}

export const reflectBoolean = (el, name) => valueOf(el, name) !== null;
export function setReflectedBoolean(el, name, value) {
  if (value) el._setAttribute(name, '');
  else el._removeAttribute(name);
}

// A URL's: the content attribute parsed against the node document's base URL, serialized — the value as it is where
// it parses to no URL — or '' where there is none.
export function reflectURL(el, name) {
  const value = valueOf(el, name);
  if (value === null) return '';
  return resolveURL(el, value) ?? value;
}

// An enumerated one's (`keywords` the attribute's: each keyword's canonical one, by its ASCII-lowercase form, a state
// with no keyword `null`), limited to only known values: the canonical keyword of the state the content attribute is
// in, its missing or invalid value default's where it is in none — '' (or null, for a nullable one) for a state with
// no keyword.
export function reflectEnum(el, name, keywords, missing, invalid) {
  const value = valueOf(el, name);
  const state = value === null ? missing : (keywords.get(asciiLower(value)) ?? invalid);
  return state ?? '';
}
export function reflectNullableEnum(el, name, keywords, missing, invalid) {
  const value = valueOf(el, name);
  return value === null ? missing : (keywords.get(asciiLower(value)) ?? invalid);
}

export const reflectNumber = (el, name, kind, fallback, min, max) =>
  globalThis.__dom.reflectNumber(el._nid, name, kind, fallback, min, max);
// …and its setter steps, `value` converted by its IDL type already: a negative one where none may be, a zero where it
// must be positive, an IndexSizeError (`failure` the operation's words); one past a long's range the default; a double
// not positive where it must be, no change.
export function setReflectedNumber(el, name, kind, fallback, value, failure) {
  switch (kind) {
    case LONG_NON_NEGATIVE:
      if (value < 0) throw new globalThis.DOMException(failure + 'The value provided is negative.', 'IndexSizeError');
      break;
    case UNSIGNED_POSITIVE:
      if (value === 0) throw new globalThis.DOMException(failure + 'The value provided (0) is invalid.', 'IndexSizeError');
      if (value > MAX_LONG) value = fallback;
      break;
    case UNSIGNED_POSITIVE_FALLBACK:
      if (value === 0 || value > MAX_LONG) value = fallback;
      break;
    case UNSIGNED:
    case UNSIGNED_RANGE:
      if (value > MAX_LONG) value = fallback;
      break;
    case DOUBLE_POSITIVE:
      if (!(value > 0)) return;
      break;
  }
  el._setAttribute(name, String(value));
}
