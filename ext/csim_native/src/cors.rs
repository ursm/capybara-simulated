// CORS (Fetch §3.2): which of a request's headers are no CORS-safelisted ones, the CORS check of a response, the
// CORS-preflight's verdict and the grant it makes, the CORS-preflight cache of each browsing session — its entries by
// origin, URL and credentials, one for each method and each header name a grant allows, each until its max-age — and
// the headers a CORS response exposes. The host sends the preflight and the requests; these say what they carry and
// what comes of them.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex, MutexGuard};

use crate::fetch_rules::{cors_safelisted_method, cors_safelisted_request_header, cors_safelisted_response_header, forbidden_response_header, is_token};

// Fetch's "CORS non-wildcard request-header name": `*` in a grant never covers it.
const NON_WILDCARD: &str = "authorization";
// The max-age of a grant whose response names none, or none valid (Fetch "CORS-preflight fetch" step 7.8).
const DEFAULT_MAX_AGE: f64 = 5.0;

// The names of a request's headers that are no CORS-safelisted request-header — its value too taken into account —
// lowercased, sorted and unique: what `Access-Control-Request-Headers` lists (Fetch "CORS-unsafe request-header names").
// The host's own markers (`x-csim-*`) and `Content-Length` are none of the author's.
pub(crate) fn unsafe_header_names(headers: &[(Vec<u8>, Vec<u8>)]) -> Vec<String> {
    let mut names: Vec<String> = headers
        .iter()
        .filter_map(|(name, value)| {
            let name = String::from_utf8_lossy(name).to_ascii_lowercase();
            let ours = name.starts_with("x-csim") || name == "content-length";
            (!ours && !cors_safelisted_request_header(name.as_bytes(), value)).then_some(name)
        })
        .collect();
    names.sort();
    names.dedup();
    names
}

// Fetch "CORS check": the response allows the request's origin `origin` — `Access-Control-Allow-Origin` `*` or that
// origin, and, `credentialed`, that origin alone and `Access-Control-Allow-Credentials` `true`, byte for byte.
pub(crate) fn check(acao: Option<&str>, acac: Option<&str>, origin: &str, credentialed: bool) -> bool {
    match acao {
        None => false,
        Some(acao) if credentialed => acao == origin && acac == Some("true"),
        Some(acao) => acao == "*" || acao == origin,
    }
}

// The methods and header names a preflight's response allows, and for how long, in seconds.
pub(crate) struct Grant {
    methods: Vec<String>,
    headers: Vec<String>,
    max_age: f64,
}

// Fetch "extract header list values": a header's comma-separated tokens — none for an absent or empty one, failure where
// one is no token.
fn token_list(value: Option<&str>) -> Option<Vec<String>> {
    let tokens: Vec<String> = value.unwrap_or("").split(',').map(|t| t.trim_matches([' ', '\t'])).filter(|t| !t.is_empty()).map(str::to_owned).collect();
    tokens.iter().all(|t| is_token(t.as_bytes())).then_some(tokens)
}

// Whether a grant's `methods` and header names `headers` cover a request of method `method` (as normalized: compared
// byte for byte) with CORS-unsafe header names `unsafe_names` — `*` none where `credentialed`, and `Authorization` only by
// name.
fn covers(methods: &[String], headers: &[String], method: &str, unsafe_names: &[String], credentialed: bool) -> bool {
    let method_ok = cors_safelisted_method(method.as_bytes()) || methods.iter().any(|m| m == method || (!credentialed && m == "*"));
    method_ok && unsafe_names.iter().all(|h| headers.iter().any(|g| g == h || (!credentialed && g == "*" && h != NON_WILDCARD)))
}

// Fetch "CORS-preflight fetch" steps 7.1-7.9 over its response (`status`, its `Access-Control-Allow-*` and
// `-Max-Age` values): the grant it makes for a request of method `method` with CORS-unsafe header names
// `unsafe_names` from `origin`, or None — a network error — where it is no ok status, fails the CORS check, names a
// method or header that is no token, or allows too little.
#[allow(clippy::too_many_arguments)]
pub(crate) fn preflight(
    status: u32,
    acao: Option<&str>,
    acac: Option<&str>,
    allow_methods: Option<&str>,
    allow_headers: Option<&str>,
    max_age: Option<&str>,
    method: &str,
    unsafe_names: &[String],
    origin: &str,
    credentialed: bool,
) -> Option<Grant> {
    if !(200..300).contains(&status) || !check(acao, acac, origin, credentialed) {
        return None;
    }
    let methods = token_list(allow_methods)?;
    let headers: Vec<String> = token_list(allow_headers)?.into_iter().map(|h| h.to_ascii_lowercase()).collect();
    if !covers(&methods, &headers, method, unsafe_names, credentialed) {
        return None;
    }
    let max_age = max_age.and_then(|v| v.trim_matches([' ', '\t']).parse::<u64>().ok()).map_or(DEFAULT_MAX_AGE, |s| s as f64);
    // (…a grant of no method its request's own, as Fetch's step 7.4 has it)
    let methods = if methods.is_empty() { vec![method.to_owned()] } else { methods };
    Some(Grant { methods, headers, max_age })
}

// The CORS-preflight cache (Fetch §4.9) of one browsing session: its entries, each for a method or a header name.
#[derive(Default)]
struct PreflightCache {
    entries: Vec<CacheEntry>,
}
struct CacheEntry {
    origin: String,
    url: String,
    credentials: bool,
    method: Option<String>,
    header: Option<String>,
    expires: f64,
}
static CACHES: LazyLock<Mutex<(u64, HashMap<u64, PreflightCache>)>> = LazyLock::new(Default::default);
fn caches() -> MutexGuard<'static, (u64, HashMap<u64, PreflightCache>)> {
    CACHES.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

impl PreflightCache {
    fn of<'a>(&'a self, origin: &'a str, url: &'a str, credentials: bool, now: f64) -> impl Iterator<Item = &'a CacheEntry> {
        self.entries.iter().filter(move |e| e.origin == origin && e.url == url && e.credentials == credentials && e.expires > now)
    }
    // Whether a request needs no preflight: a method cache entry match for its method (a safelisted one needs none) and
    // a header-name cache entry match for each of its CORS-unsafe header names (Fetch "main fetch" step 12, §4.9).
    fn covers(&self, origin: &str, url: &str, credentials: bool, method: &str, unsafe_names: &[String], now: f64) -> bool {
        let methods: Vec<String> = self.of(origin, url, credentials, now).filter_map(|e| e.method.clone()).collect();
        let headers: Vec<String> = self.of(origin, url, credentials, now).filter_map(|e| e.header.clone()).collect();
        covers(&methods, &headers, method, unsafe_names, credentials)
    }
    // A grant's entries made — an entry that matches already given its max-age (Fetch "CORS-preflight fetch" step 7.10).
    fn store(&mut self, origin: &str, url: &str, credentials: bool, grant: &Grant, now: f64) {
        let expires = now + grant.max_age;
        let made = grant.methods.iter().map(|m| (Some(m.clone()), None)).chain(grant.headers.iter().map(|h| (None, Some(h.clone()))));
        for (method, header) in made {
            let existing = self.entries.iter_mut().find(|e| {
                e.origin == origin && e.url == url && e.credentials == credentials && e.method == method && e.header == header
            });
            match existing {
                Some(e) => e.expires = expires,
                None => self.entries.push(CacheEntry { origin: origin.to_owned(), url: url.to_owned(), credentials, method, header, expires }),
            }
        }
        self.entries.retain(|e| e.expires > now);
    }
}

// (…`pairs` [[name, value], …] of byte strings)
pub(crate) fn unsafe_header_names_for_ruby(pairs: magnus::RArray) -> Result<Vec<String>, magnus::Error> {
    use magnus::TryConvert;
    let mut headers = Vec::with_capacity(pairs.len());
    for pair in pairs.into_iter() {
        let pair = magnus::RArray::try_convert(pair)?;
        let (name, value): (magnus::RString, magnus::RString) = (pair.entry(0)?, pair.entry(1)?);
        // SAFETY: the bytes are copied out before anything can run Ruby code.
        headers.push(unsafe { (name.as_slice().to_vec(), value.as_slice().to_vec()) });
    }
    Ok(unsafe_header_names(&headers))
}
pub(crate) fn check_for_ruby(acao: Option<String>, acac: Option<String>, origin: String, credentialed: bool) -> bool {
    check(acao.as_deref(), acac.as_deref(), &origin, credentialed)
}
// …a session's cache: made, emptied (the session reset), asked whether it covers a request, given a preflight's grant —
// `now` the host's monotonic seconds. Its grant (`preflight`) made and stored at once; whether one was.
pub(crate) fn cache_new_for_ruby() -> u64 {
    let mut c = caches();
    c.0 += 1;
    let id = c.0;
    c.1.insert(id, PreflightCache::default());
    id
}
pub(crate) fn cache_clear_for_ruby(id: u64) {
    if let Some(cache) = caches().1.get_mut(&id) {
        cache.entries.clear();
    }
}
pub(crate) fn cache_covers_for_ruby(id: u64, origin: String, url: String, credentials: bool, method: String, unsafe_names: Vec<String>, now: f64) -> bool {
    caches().1.get(&id).is_some_and(|c| c.covers(&origin, &url, credentials, &method, &unsafe_names, now))
}
// (…[status, acao, acac, methods, headers, max-age] of the preflight's response, [origin, url, credentials, method,
// unsafe names] of the request)
#[allow(clippy::too_many_arguments)]
pub(crate) fn preflight_for_ruby(
    id: u64,
    response: (u32, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>),
    origin: String,
    url: String,
    credentials: bool,
    method: String,
    unsafe_names: Vec<String>,
    now: f64,
) -> bool {
    let (status, acao, acac, methods, headers, max_age) = response;
    let Some(grant) = preflight(
        status,
        acao.as_deref(),
        acac.as_deref(),
        methods.as_deref(),
        headers.as_deref(),
        max_age.as_deref(),
        &method,
        &unsafe_names,
        &origin,
        credentials,
    ) else {
        return false;
    };
    if let Some(cache) = caches().1.get_mut(&id) {
        cache.store(&origin, &url, credentials, &grant, now);
    }
    true
}
// The names of a CORS response's headers it exposes (Fetch "CORS-filtered response"): the CORS-safelisted response-header
// names and those `Access-Control-Expose-Headers` names (`expose`) — every one for its `*` where not `credentialed` —
// never a forbidden response-header name; and the host's marker of the reason phrase (`x-csim-status-text`), which the
// response's `statusText` is.
pub(crate) fn exposed_names_for_ruby(names: Vec<String>, expose: Option<String>, credentialed: bool) -> Vec<String> {
    let expose: Vec<String> = token_list(expose.as_deref()).unwrap_or_default().into_iter().map(|h| h.to_ascii_lowercase()).collect();
    let all = !credentialed && expose.iter().any(|e| e == "*");
    names
        .into_iter()
        .filter(|name| {
            let lower = name.to_ascii_lowercase();
            let shown = all || cors_safelisted_response_header(lower.as_bytes()) || expose.contains(&lower) || lower == "x-csim-status-text";
            shown && !forbidden_response_header(lower.as_bytes())
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| (*x).to_owned()).collect()
    }

    #[test]
    fn a_request_names_its_unsafe_headers_sorted_and_once() {
        let headers = vec![
            (b"X-B".to_vec(), b"1".to_vec()),
            (b"accept".to_vec(), b"*/*".to_vec()),
            (b"x-a".to_vec(), b"1".to_vec()),
            (b"X-A".to_vec(), b"2".to_vec()),
            (b"content-type".to_vec(), b"application/json".to_vec()),
            (b"x-csim-auth-challenge".to_vec(), b"1".to_vec()),
        ];
        assert_eq!(unsafe_header_names(&headers), s(&["content-type", "x-a", "x-b"]));
    }

    #[test]
    fn a_cors_check_takes_credentials_byte_for_byte() {
        assert!(check(Some("*"), None, "https://a.test", false));
        assert!(!check(Some("*"), Some("true"), "https://a.test", true));
        assert!(check(Some("https://a.test"), Some("true"), "https://a.test", true));
        assert!(!check(Some("https://a.test"), Some("TRUE"), "https://a.test", true));
        assert!(!check(None, None, "https://a.test", false));
    }

    #[test]
    fn a_preflight_grants_what_it_names_until_its_max_age() {
        let unsafe_names = s(&["x-a"]);
        let g = preflight(200, Some("*"), None, Some("PUT"), Some("X-A"), None, "PUT", &unsafe_names, "o", false).unwrap();
        assert_eq!(g.max_age, DEFAULT_MAX_AGE);
        assert!(preflight(200, Some("*"), None, Some("Bad value"), None, None, "PUT", &[], "o", false).is_none());
        assert!(preflight(204, Some("*"), None, Some("put"), None, None, "PUT", &[], "o", false).is_none());
        // (…`*` none for a credentialed request, nor `Authorization` but by name)
        assert!(preflight(200, Some("o"), Some("true"), Some("*"), None, None, "PUT", &[], "o", true).is_none());
        assert!(preflight(200, Some("*"), None, None, Some("*"), None, "GET", &s(&["authorization"]), "o", false).is_none());
        let mut cache = PreflightCache::default();
        cache.store("o", "u", false, &g, 0.0);
        assert!(cache.covers("o", "u", false, "PUT", &unsafe_names, 4.0));
        assert!(!cache.covers("o", "u", false, "PUT", &unsafe_names, 5.0));
        assert!(!cache.covers("o", "u", false, "DELETE", &unsafe_names, 1.0));
        // (…a later grant adds its entries, the earlier's kept)
        let d = preflight(200, Some("*"), None, Some("DELETE"), None, Some("60"), "DELETE", &[], "o", false).unwrap();
        cache.store("o", "u", false, &d, 1.0);
        assert!(cache.covers("o", "u", false, "PUT", &unsafe_names, 2.0));
        assert!(cache.covers("o", "u", false, "DELETE", &[], 30.0));
    }

    #[test]
    fn a_cors_response_exposes_its_safelisted_and_named_headers() {
        let names = s(&["Content-Type", "X-Secret", "Set-Cookie", "X-Shown", "x-csim-status-text"]);
        assert_eq!(exposed_names_for_ruby(names.clone(), Some("x-shown".into()), false), s(&["Content-Type", "X-Shown", "x-csim-status-text"]));
        assert_eq!(exposed_names_for_ruby(names.clone(), Some("*".into()), false), s(&["Content-Type", "X-Secret", "X-Shown", "x-csim-status-text"]));
        assert_eq!(exposed_names_for_ruby(names, Some("*".into()), true), s(&["Content-Type", "x-csim-status-text"]));
    }
}
