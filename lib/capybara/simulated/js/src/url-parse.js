// `globalThis.__csim_parseUrl(input, base, encoding)` — the URL parse primitive every URL consumer (the `URL` class,
// `globalThis.location`, the ESM loader, anchor `href` resolution) calls: the URL Standard's parser, native
// (url_ops.rs). Returns the URL's components — the `URL` interface's attributes — or `{ error: true }` when parsing fails (e.g. a special-scheme URL with no host, which a real
// browser rejects with a TypeError). `encoding` (optional) is the document's character encoding: HTML's "encoding-parse
// a URL" percent-encodes a special URL's query in it (an anchor's href, a form's action); the fragment is UTF-8
// regardless.
//
// Imported FIRST in bridge.entry.js so it's defined before location.js's module-load code runs — which, at snapshot
// build time, finds no `__dom` yet and so no parser: it takes its literal default.
import { SANDBOXED_SCRIPTS, documentOrigin, sandboxed } from './document-origin.js';

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

// HTML "evaluate a javascript: URL" in this realm's document: the source of `href` (parsed: `__csimJavascriptUrlSource`)
// run as a classic script on a queued task — a top-level Script, its declarations the global's, its completion value
// the host's to hand back where it is a primitive (`__csim_runJavascriptURL`) — a throw reported — nothing in a document sandboxed against
// scripts, where scripting is disabled — and a STRING completion value the markup of the document that replaces it, at
// its URL (the response's URL is the active document's), unless a navigation of it began meanwhile ("if
// targetNavigable's ongoing navigation is no longer navigationId, then return") or the script planned one — a form it
// submitted, which then navigates after it and wins (jsurl-form-submit); any other result
// replaces none, the document staying. A frame's document is replaced through its container (the engine's:
// `ownContainer`), in the realm that has it (`__csimJavascriptDocumentByRealm`); a top-level one's is not modeled.
function runJavascriptURL(href) {
  if (sandboxed(SANDBOXED_SCRIPTS)) return;
  const code = globalThis.__csimJavascriptUrlSource(href);
  globalThis.__csimSetTimeout(() => {
    const el = globalThis.__dom.ownContainer();
    const navigation = el === null ? 0 : globalThis.__dom.frameNavGeneration(el._nid);
    const result = evaluateJavascriptSource(code);
    if (typeof result !== 'string' || el === null || globalThis.__dom.navigationPlanned()) return;
    const NS = globalThis.RustyRacer;
    NS.contextGlobal(NS.contextOf(el)).__csimJavascriptDocumentByRealm(globalThis.__csimRealmId(), navigation, result, globalThis.__csimLocationHref());
  }, 0);
}
// …its source run: its completion value, or undefined for a throw, which is reported as this document's.
function evaluateJavascriptSource(code) {
  const url = globalThis.__csimLocationHref();
  try { return globalThis.__csim_runJavascriptURL(url, code); }
  catch (e) {
    try { globalThis.__csimReportScriptError(e, url); } catch (_) {}
    return undefined;
  }
}
globalThis.__csimRunJavascriptURL = runJavascriptURL;
// …and the source a frame made at a javascript: URL runs in its initial about:blank document as the host builds it
// (v8_runtime.rb `create_frame_realm`): its string result, the markup of the document the host loads in its place, or
// null.
globalThis.__csimEvaluateJavascriptSource = (code) => {
  const result = evaluateJavascriptSource(String(code));
  return typeof result === 'string' ? result : null;
};
// …as another window's script navigates this one to it (a window it opened: platform-globals.js `csimWindowProxy`), of
// document origin `origin` — this document's only, an opaque one's none: a javascript: URL of another origin's ignored.
globalThis.__csimRunJavascriptURLFrom = (href, origin) => {
  if (origin !== 'null' && origin === documentOrigin()) runJavascriptURL(href);
};
// HTML "navigate to a javascript: URL", as this realm runs one: `url` parsed against `base` — where it is a javascript:
// URL, evaluated (`runJavascriptURL`), and true. False for any other URL, which navigates as one does. Every sink: a
// hyperlink's activation (dispatch.js), `window.open(…, '_self')`, a location's navigation.
globalThis.__csimNavigateJavascriptURL = function (url, base) {
  let parsed = null;
  try { parsed = globalThis.__csim_parseUrl(String(url), base || null); } catch (_) {}
  if (!parsed || parsed.error || parsed.protocol !== 'javascript:') return false;
  runJavascriptURL(parsed.href);
  return true;
};
