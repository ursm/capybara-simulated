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

globalThis.__csim_parseUrl = function (input, base) {
  if (!USM) return { error: true };
  let parsedBase = null;
  if (base != null) {
    parsedBase = USM.basicURLParse(String(base));
    if (parsedBase === null) return { error: true };
  }
  const u = USM.basicURLParse(String(input), { baseURL: parsedBase });
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
