// ASCII case and ASCII whitespace, as the DOM, HTML and Selectors specs mean them — never JS `toLowerCase()` or `\s`,
// which also fold / split on Unicode (U+212A KELVIN SIGN lowercases to `k`, U+00A0 is `\s`). Every token list (`class`,
// `rel`, `part`, a `~=` value) splits on ASCII whitespace, and every case-insensitive name or quirks-mode class / id
// compares ASCII case-insensitively; one definition here, so no two surfaces can split or fold the same text apart.

// TAB, LF, FF, CR, SPACE.
export const ASCII_WHITESPACE_RUN = /[\t\n\f\r ]+/;
export const ASCII_WHITESPACE = /[\t\n\f\r ]/;

// (…a name with nothing to fold — nearly every one a document holds — is returned as it is, without the replace's
// callback per character)
const ASCII_UPPER = /[A-Z]/;
export function asciiLower(s) { return ASCII_UPPER.test(s) ? s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32)) : s; }
export function asciiUpper(s) { return s.replace(/[a-z]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 32)); }

// The tokens of an ordered-set-style list, empties dropped (duplicates kept — a caller that needs a set dedupes).
export function asciiTokens(s) { return String(s).split(ASCII_WHITESPACE_RUN).filter(Boolean); }
