// Fetch's fixed header and method rules, the engine's (fetch_rules.rs) — one table the `Headers` class (the fetch /
// Request / Response side), XMLHttpRequest and the host's CORS checks all ask, so no two answers drift apart (XHR's own
// list once lacked `permissions-policy`, so `setRequestHeader('permissions-policy', …)` slipped through).

// Fetch "ok status": 200 to 299 — what a Response's `ok` says, and what a script's or a `<link>`'s resource must answer
// with to load (HTML "fetch a classic script", "fetch and process the linked resource"); any other is a failed load.
export const okStatus = (status) => status >= 200 && status <= 299;
// An HTTP token (RFC 9110): what a method and a header name must be.
export const isHttpToken = (s) => globalThis.__dom.httpToken(s);
// Fetch "normalize a method": DELETE, GET, HEAD, OPTIONS, POST, PUT byte-uppercased where matched case-insensitively,
// any other kept as written (`patch` stays `patch`).
export const normalizeMethod = (method) => globalThis.__dom.normalizedMethod(method) ?? method;
// Fetch "CORS-safelisted method": GET, HEAD, POST — the only methods a `no-cors` request takes.
export const isCorsSafelistedMethod = (method) => globalThis.__dom.corsSafelistedMethod(method);
// Fetch "forbidden method": XHR `open()` and a Request refuse these outright.
export const isForbiddenMethod = (method) => globalThis.__dom.forbiddenMethod(method);
