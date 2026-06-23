// `globalThis.__csim_parseUrl(input, base)` — the URL parse primitive every URL
// consumer (the `URL` class, `globalThis.location`, the ESM loader, anchor
// `href` resolution) calls. Previously a Ruby host fn backed by `URI` (RFC 3986,
// ASCII-strict, NOT WHATWG); now backed by the vendored whatwg-url state
// machine, so it's spec-correct AND stays in the VM (no V8↔Ruby boundary per
// parse).
//
// Returns the same component shape the Ruby version did, assembled from the
// parsed URL record exactly as whatwg-url's URL-impl derives each IDL property
// (href / origin / protocol / host / hostname / port / pathname / search / hash)
// — or `{ error: true }` when parsing fails (e.g. a special-scheme URL with no
// host, which a real browser rejects with a TypeError).
//
// Imported FIRST in bridge.entry.js so it's defined before location.js's
// module-load code runs.

const USM = globalThis.__csimVendor && globalThis.__csimVendor.urlEngine;

globalThis.__csim_parseUrl = function (input, base, encoding) {
  if (!USM) return { error: true };
  let parsedBase = null;
  if (base != null) {
    parsedBase = USM.basicURLParse(String(base));
    if (parsedBase === null) return { error: true };
  }
  // `encoding` (optional) is the document's character encoding — used to
  // percent-encode the query when parsing a URL in a document context (an
  // anchor's href), per the WHATWG "parse a URL" step. Default UTF-8 (the URL
  // API encoding); the fragment is always UTF-8 regardless.
  const opts = { baseURL: parsedBase };
  if (encoding) opts.encoding = String(encoding);
  const u = USM.basicURLParse(String(input), opts);
  if (u === null) return { error: true };

  const host     = u.host;
  const hostname = host === null ? '' : USM.serializeHost(host);
  const port     = u.port === null ? '' : USM.serializeInteger(u.port);
  return {
    href:     USM.serializeURL(u),
    protocol: u.scheme + ':',
    username: u.username,
    password: u.password,
    host:     host === null ? '' : (port ? hostname + ':' + port : hostname),
    hostname: hostname,
    port:     port,
    pathname: USM.serializePath(u),
    search:   (u.query === null || u.query === '') ? '' : '?' + u.query,
    hash:     (u.fragment === null || u.fragment === '') ? '' : '#' + u.fragment,
    origin:   USM.serializeURLOrigin(u),
    // Opaque-path URLs (`javascript:…`, `data:…`, `mailto:…`) serialize WITHOUT
    // a `//` authority — the `URL` class's href reassembly keys off this.
    opaque:   USM.hasAnOpaquePath(u),
    // Whether the URL has an authority (host !== null). The WHATWG serializer
    // emits `//` iff this holds, distinguishing `foo:/path` (null host, no `//`)
    // from `foo://host` / `foo://` (empty-or-set host, has `//`). Both report
    // `host === ''` via the IDL getter when empty, so href reassembly can't tell
    // them apart from `host` alone — without this, `new URL('foo:/').href` was
    // wrongly serialized `foo:///`.
    hasAuthority: u.host !== null,
    // Same null-vs-empty split for query/fragment: the `search`/`hash` IDL
    // getters return '' for both a null and an empty component, but href must
    // keep the bare `?`/`#` for an empty-but-present one (`new URL('?', base)`
    // → `…/bar?`, `new URL('#', base)` → `…/bar#`).
    hasQuery:    u.query !== null,
    hasFragment: u.fragment !== null,
  };
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
