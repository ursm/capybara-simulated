// The IDL attributes that reflect a content attribute (HTML §2.6.1), as the generated bindings make them of their
// [Reflect…] extended attributes (script/gen_bindings.mjs): a DOMString's, a URL's, an enumerated one's, a boolean's,
// and a number's — the number read off the element, and the one a write sets, by the engine (reflect.rs
// `reflectNumber`, `reflectedNumberWrite`). A write sets or removes the content attribute as a page's `setAttribute`
// does, its reactions with it.

import { resolveURLValue } from './base-url.js';
import { DOMException } from './dom-exception.js';
import { attrsOf, nidOf } from './node-identity.js';
import { dom } from './engine.js';

// The content attribute written as a page's `setAttribute` and `removeAttribute` write it — dom-nodes.js's steps, which
// it hands here as it loads (`setAttributeWriters`): the generated bindings import this module, and dom-nodes.js them.
let setAttribute, removeAttribute;
export function setAttributeWriters(set, remove) {
  setAttribute = set;
  removeAttribute = remove;
}

// The number kinds, as reflect.rs knows them.
export const LONG = 0;
export const LONG_NON_NEGATIVE = 1;
export const UNSIGNED = 2;
export const UNSIGNED_POSITIVE = 3;
export const UNSIGNED_RANGE = 4;
export const DOUBLE = 5;
export const DOUBLE_POSITIVE = 6;
export const UNSIGNED_POSITIVE_FALLBACK = 7;
export const MARQUEE_LOOP = 8;

const valueOf = (el, name) => attrsOf(el)[name] ?? null;

export const reflectString = (el, name) => valueOf(el, name) ?? '';
export const reflectNullableString = (el, name) => valueOf(el, name);
export function setReflectedString(el, name, value) {
  if (value === null) removeAttribute(el, name);
  else setAttribute(el, name, value);
}

export const reflectBoolean = (el, name) => valueOf(el, name) !== null;
export function setReflectedBoolean(el, name, value) {
  if (value) setAttribute(el, name, '');
  else removeAttribute(el, name);
}

// A URL's: the content attribute parsed against the node document's base URL, serialized — the value as it is where
// it parses to no URL — or '' where there is none.
export function reflectURL(el, name) {
  const value = valueOf(el, name);
  if (value === null) return '';
  return resolveURLValue(el, value) ?? value;
}

// An enumerated one's, by its keyword table (`table`, reflect_keywords.rs), limited to only known values — the engine's
// (reflect.rs `reflectEnum`): the canonical keyword of the state the content attribute is in, its missing or invalid
// value default's where it is in none — '' (or null, for a nullable one) for a state with no keyword.
export const reflectEnum = (el, name, table) => dom.reflectEnum(el, name, table) ?? '';
export const reflectNullableEnum = (el, name, table) => dom.reflectEnum(el, name, table);

export const reflectNumber = (el, name, kind, fallback, min, max) =>
  dom.reflectNumber(nidOf(el), name, kind, fallback, min, max);
// …and its setter steps, `value` converted by its IDL type already: the content attribute written with what the engine
// says, or left — and an IndexSizeError (`failure` the operation's words) where it refuses the value.
const REFUSED = [null, 'The value provided is negative.', 'The value provided (0) is invalid.'];
export function setReflectedNumber(el, name, kind, fallback, value, failure = '') {
  const written = dom.reflectedNumberWrite(nidOf(el), name, kind, fallback, value);
  if (typeof written === 'number') throw new DOMException(failure + REFUSED[written], 'IndexSizeError');
  if (written !== null) setAttribute(el, name, written);
}
