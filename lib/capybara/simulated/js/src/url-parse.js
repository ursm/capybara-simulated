// `globalThis.__csim_parseUrl(input, base, encoding)` — the URL parse primitive every URL consumer (the `URL` class,
// `globalThis.location`, the ESM loader, anchor `href` resolution) calls: the URL Standard's parser, native
// (url_ops.rs). Returns the URL's components — the `URL` interface's attributes — or `{ error: true }` when parsing fails (e.g. a special-scheme URL with no host, which a real
// browser rejects with a TypeError). `encoding` (optional) is the document's character encoding: HTML's "encoding-parse
// a URL" percent-encodes a special URL's query in it (an anchor's href, a form's action); the fragment is UTF-8
// regardless.
//
// Imported FIRST in bridge.entry.js so it's defined before location.js's module-load code runs — which, at snapshot
// build time, finds no `__dom` yet and so no parser: it takes its literal default.

// A URL's components from `__dom.urlParse` / `urlSet`'s parts (url_ops.rs `parts`, in that order).
export function urlComponents(parts) {
  return {
    href:     parts[0],
    protocol: parts[1],
    username: parts[2],
    password: parts[3],
    host:     parts[4],
    hostname: parts[5],
    port:     parts[6],
    pathname: parts[7],
    search:   parts[8],
    hash:     parts[9],
    origin:   parts[10]
  };
}

globalThis.__csim_parseUrl = function (input, base, encoding) {
  const dom = globalThis.__dom;
  if (!dom) return { error: true };
  const parts = dom.urlParse(String(input), base == null ? null : String(base), encoding ? String(encoding) : null);
  return parts === null ? { error: true } : urlComponents(parts);
};

// True iff `input` is a malformed URL — used by the navigation / fetch sinks
// (location / XMLHttpRequest.open / window.open / sendBeacon) to throw
// synchronously on a parse failure (instead of attempting a doomed fetch).
//
// A RELATIVE input that fails ONLY because `base` is opaque (about:blank /
// data: / blob:) is NOT malformed: a real document at about:blank inherits a
// usable base from its opener/parent, which we don't fully model — so re-test
// against a guaranteed-valid base. A genuinely-bad ABSOLUTE URL (bad port,
// non-ASCII host, …) fails against both; a valid relative URL passes the second.
globalThis.__csim_urlIsMalformed = function (input, base) {
  if (!globalThis.__csim_parseUrl(input, base).error) return false;
  return !!globalThis.__csim_parseUrl(input, 'http://csim-fallback.invalid/').error;
};

// The script source a `javascript:` URL runs, given its PARSED href (the WHATWG
// serialization, so interspersed tab/newline/CR are already stripped, `/..`
// segments collapsed, and reserved bytes %-encoded). Returns the text after the
// `javascript:` scheme, percent-decoded the way HTML "javascript: URL" runs the
// decoded bytes as UTF-8: each maximal run of `%XX` escapes is decoded and a
// lone / invalid `%` is left literal — so `f('%41','%')` → `f('A','%')`, not the
// all-or-nothing failure a bare `decodeURIComponent` of the whole string forces.
// Shared by both javascript:-URL sinks: anchor-activation (dispatch.js) and an
// `<iframe src="javascript:…">` (bridge.entry.js). Caller has already confirmed
// the scheme (a non-javascript href is returned unchanged after the slice no-op).
globalThis.__csimJavascriptUrlSource = function (parsedHref) {
  const afterScheme = String(parsedHref).slice('javascript:'.length);
  return afterScheme.replace(/(?:%[0-9A-Fa-f]{2})+/g, (m) => {
    try { return decodeURIComponent(m); } catch (_) { return m; }
  });
};
