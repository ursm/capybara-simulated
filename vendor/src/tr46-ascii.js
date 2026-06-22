// Replacement for the `tr46` IDNA package, aliased in for whatwg-url at
// vendor-bundle build time. The real tr46 ships a ~600KB Unicode IDNA mapping
// table; instead of baking that into the V8 snapshot, we keep a thin shim:
//
//   - A pure-ASCII host with NO `xn--` label needs no IDNA work beyond the UTS46
//     ASCII map (lowercase) — this is the overwhelming common case, so it stays
//     in-VM (no host round-trip; rule 3).
//   - A non-ASCII host, or one with an `xn--` (punycode) label that must be
//     validated/decoded, delegates to the Ruby host (`URI::IDNA`, the uri-idna
//     gem) via `__csim_domainToASCII` / `__csim_domainToUnicode`. The full UTS46
//     tables live once on the Ruby side.
//
// whatwg-url's `domainToASCII` treats `null`/`""` as a failure and rejects
// forbidden domain code points itself; `toASCII` returns `null` to signal an
// IDNA failure (invalid punycode / disallowed code point), which whatwg-url
// surfaces as "domain to ASCII failed".
'use strict';

function plainAsciiHost(s) {
  // No code point above 0x7F, and no `xn--` label (a punycode label must be
  // decoded + revalidated by the full UTS46 processing, so it isn't "plain").
  return /^[\x00-\x7f]*$/.test(s) && !/(^|\.)xn--/i.test(s);
}

exports.toASCII = function toASCII(domain) {
  const s = String(domain);
  if (plainAsciiHost(s)) return s.toLowerCase();
  if (typeof globalThis.__csim_domainToASCII === 'function') {
    const r = globalThis.__csim_domainToASCII(s);
    return r == null ? null : String(r);
  }
  return s.toLowerCase();
};

exports.toUnicode = function toUnicode(domain) {
  const s = String(domain);
  if (plainAsciiHost(s)) return { domain: s, error: false };
  if (typeof globalThis.__csim_domainToUnicode === 'function') {
    const r = globalThis.__csim_domainToUnicode(s);
    return { domain: r == null ? s : String(r), error: false };
  }
  return { domain: s, error: false };
};
