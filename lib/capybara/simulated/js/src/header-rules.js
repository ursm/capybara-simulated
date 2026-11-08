// Fetch's fixed header rules, the engine's (fetch_rules.rs) — one table the `Headers` class (the fetch / Request /
// Response side), XMLHttpRequest and the host's CORS checks all ask, so no two answers drift apart (XHR's own list once
// lacked `permissions-policy`, so `setRequestHeader('permissions-policy', …)` slipped through).

import { dom } from './engine.js';

// A response's header `name` (lowercase) among its headers as the host gives them — keyed by name in any case, a list
// of values joined — or null for none (fetch_rules.rs `responseHeader`).
export const responseHeader = (headers, name) => (headers ? dom.responseHeader(headers, name) : null);
