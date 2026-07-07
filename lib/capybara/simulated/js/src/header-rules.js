// Shared Fetch header-policy rules, consumed by both the `Headers` class (url.js — the
// fetch / Request / Response side) and `XMLHttpRequest` (xhr.js). Each used to roll its
// own copy of these lists; they had already drifted (XHR was missing `permissions-policy`
// from its forbidden set, so `setRequestHeader('permissions-policy', …)` slipped through),
// which is exactly the divergence a single home prevents.

// Fetch "forbidden request-header" (name lowercased): UA-controlled, so both a request's
// Headers (guard "request") and XHR `setRequestHeader()` silently ignore a script attempt
// to set one — plus any `proxy-`/`sec-` prefix, and a method-override header whose value
// carries a forbidden method.
export const FORBIDDEN_REQUEST_HEADERS = new Set([
  'accept-charset', 'accept-encoding', 'access-control-request-headers',
  'access-control-request-method', 'connection', 'content-length', 'cookie',
  'cookie2', 'date', 'dnt', 'expect', 'host', 'keep-alive', 'origin',
  'permissions-policy', 'referer', 'set-cookie', 'te', 'trailer',
  'transfer-encoding', 'upgrade', 'via'
]);
export const METHOD_OVERRIDE_HEADERS = new Set(['x-http-method', 'x-http-method-override', 'x-method-override']);
// Fetch "forbidden method": XHR `open()` rejects these outright, and a method-override
// header carrying one is itself a forbidden request-header.
export const FORBIDDEN_METHODS = new Set(['CONNECT', 'TRACE', 'TRACK']);
// Fetch forbidden RESPONSE-header names: the UA filters these from the exposed response
// header list, so `getResponseHeader` / a response `Headers` never reveal them.
export const FORBIDDEN_RESPONSE_HEADERS = new Set(['set-cookie', 'set-cookie2']);

// Whether a (lowercased) request-header name/value pair is UA-controlled and must be
// dropped. The `X-HTTP-Method*` family is forbidden only when a comma-split token
// matches a forbidden method. Fetch trims each token of leading/trailing HTTP tab-or-
// space (0x09 / 0x20) ONLY — not LF/CR (a header value can't contain them anyway) and
// not the wider Unicode whitespace `String.prototype.trim` would strip.
export function isForbiddenRequestHeader(name, value) {
  if (FORBIDDEN_REQUEST_HEADERS.has(name) || name.startsWith('proxy-') || name.startsWith('sec-')) return true;
  if (METHOD_OVERRIDE_HEADERS.has(name)) {
    return String(value).split(',').some((t) => FORBIDDEN_METHODS.has(t.replace(/^[\t ]+|[\t ]+$/g, '').toUpperCase()));
  }
  return false;
}
