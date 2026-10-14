// Fetch's fixed header and method rules, the engine's (fetch_rules.rs) — one table the `Headers` class (the fetch /
// Request / Response side), XMLHttpRequest and the host's CORS checks all ask, so no two answers drift apart (XHR's own
// list once lacked `permissions-policy`, so `setRequestHeader('permissions-policy', …)` slipped through).

// An HTTP token (RFC 9110): what a method and a header name must be.
export const isHttpToken = (s) => globalThis.__dom.httpToken(s);
// Fetch "normalize a method": DELETE, GET, HEAD, OPTIONS, POST, PUT byte-uppercased where matched case-insensitively,
// any other kept as written (`patch` stays `patch`).
export const normalizeMethod = (method) => globalThis.__dom.normalizedMethod(method) ?? method;
// Fetch "CORS-safelisted method": GET, HEAD, POST — the only methods a `no-cors` request takes.
export const isCorsSafelistedMethod = (method) => globalThis.__dom.corsSafelistedMethod(method);
// Fetch "forbidden method": XHR `open()` and a Request refuse these outright.
export const isForbiddenMethod = (method) => globalThis.__dom.forbiddenMethod(method);
// Fetch "forbidden request-header" (name, value): one the user agent controls — a `proxy-` / `sec-` one, a
// method-override header naming a forbidden method, and the driver's private `x-csim-` markers — which a request's
// Headers (guard "request") and `setRequestHeader()` silently ignore.
export const isForbiddenRequestHeader = (name, value) => globalThis.__dom.headerRule(0, name, value);
// Fetch "forbidden response-header name": never exposed to script.
export const isForbiddenResponseHeader = (name) => globalThis.__dom.headerRule(1, name, '');
// Fetch "no-CORS-safelisted request-header": the only headers a `no-cors` request's Headers (guard "request-no-cors")
// accepts.
export const isNoCorsSafelisted = (name, value) => globalThis.__dom.headerRule(2, name, value);
