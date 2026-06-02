// Minimal ASCII-only replacement for the `tr46` IDNA package, aliased in for
// whatwg-url at vendor-bundle build time. The real tr46 ships a ~600KB Unicode
// IDNA mapping table (plus punycode) to handle internationalised domain names;
// in a test driver every host is ASCII, so we skip all of that and just
// ASCII-lowercase the (already percent-decoded) domain. whatwg-url's
// `domainToASCII` treats `null`/`""` as a failure and rejects forbidden domain
// code points itself, so this shim only needs to do the case fold.
'use strict';
exports.toASCII = function toASCII(domain) {
  return String(domain).toLowerCase();
};
exports.toUnicode = function toUnicode(domain) {
  return { domain: String(domain), error: false };
};
