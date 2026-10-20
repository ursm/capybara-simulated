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

// …for `input` against `base` (none: `input` an absolute URL), a special URL's query in `encoding` (none: UTF-8) — or
// null where it is no URL: what every internal reader parses by, never the `URL` class a page can replace (nor an
// object made per parse).
export function parseURL(input, base = null, encoding = null) {
  const dom = globalThis.__dom;
  if (!dom) return null;
  const parts = dom.urlParse(String(input), base == null ? null : String(base), encoding ? String(encoding) : null);
  return parts === null ? null : urlComponents(parts);
}
globalThis.__csim_parseUrl = (input, base, encoding) => parseURL(input, base, encoding) ?? { error: true };

// The script source a `javascript:` URL runs, given its PARSED href (the WHATWG serialization): the engine's
// (url_ops.rs `javascript_url_source` — percent-decoded bytes, UTF-8 decoded, an escape that is no UTF-8 U+FFFD).
// Shared by both javascript:-URL sinks: a navigation to one (`__csimNavigateJavascriptURL`) and an
// `<iframe src="javascript:…">` (bridge.entry.js).
globalThis.__csimJavascriptUrlSource = (parsedHref) => globalThis.__dom.javascriptUrlSource(String(parsedHref));

// HTML "navigate to a javascript: URL", as this realm runs one: `url` parsed against `base` — where it is a javascript:
// URL, its source (`__csimJavascriptUrlSource`) run in global scope on a queued task, as navigating to it is, a throw
// reported; and true. False for any other URL, which navigates as one does. (What the script evaluates to replaces no
// document.) Every sink: a hyperlink's activation (dispatch.js), `window.open(…, '_self')`, a location's navigation.
globalThis.__csimNavigateJavascriptURL = function (url, base) {
  let parsed = null;
  try { parsed = globalThis.__csim_parseUrl(String(url), base || null); } catch (_) {}
  if (!parsed || parsed.error || parsed.protocol !== 'javascript:') return false;
  const code = globalThis.__csimJavascriptUrlSource(parsed.href);
  globalThis.__csimSetTimeout(() => {
    try { (new Function(code))(); } catch (e) { try { globalThis.__csimReportError(e); } catch (_) {} }
  }, 0);
  return true;
};
