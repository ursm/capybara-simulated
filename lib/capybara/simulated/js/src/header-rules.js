// Fetch's fixed header and method rules, the engine's (fetch_rules.rs) — one table the `Headers` class (the fetch /
// Request / Response side), XMLHttpRequest and the host's CORS checks all ask, so no two answers drift apart (XHR's own
// list once lacked `permissions-policy`, so `setRequestHeader('permissions-policy', …)` slipped through).

// Fetch "ok status": 200 to 299 — what a Response's `ok` says, and what a script's or a `<link>`'s resource must answer
// with to load (HTML "fetch a classic script", "fetch and process the linked resource"); any other is a failed load.
export const okStatus = (status) => status >= 200 && status <= 299;
// …a response a resource the host loads takes: one with an ok status and its body whole — one the wire cut short
// (browser.rb `framed_response`) fails the load, as a network error does (Chrome and Firefox: a script's, a style sheet's
// `error`).
export const loadedResponse = (resp) => !!resp && okStatus(resp.status) && !resp.body_error;
// A response's header `name` (lowercase) among its headers as the host gives them — keyed by name in any case, a list
// of values joined — or null for none (fetch_rules.rs `responseHeader`).
export const responseHeader = (headers, name) => (headers ? globalThis.__dom.responseHeader(headers, name) : null);
// An HTTP token (RFC 9110): what a method and a header name must be.
export const isHttpToken = (s) => globalThis.__dom.httpToken(s);
// Fetch "normalize a method": DELETE, GET, HEAD, OPTIONS, POST, PUT byte-uppercased where matched case-insensitively,
// any other kept as written (`patch` stays `patch`).
export const normalizeMethod = (method) => globalThis.__dom.normalizedMethod(method) ?? method;
// Fetch "CORS-safelisted method": GET, HEAD, POST — the only methods a `no-cors` request takes.
export const isCorsSafelistedMethod = (method) => globalThis.__dom.corsSafelistedMethod(method);
// Fetch "forbidden method": XHR `open()` and a Request refuse these outright.
export const isForbiddenMethod = (method) => globalThis.__dom.forbiddenMethod(method);
