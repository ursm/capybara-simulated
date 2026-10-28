// CORS (Fetch §3.2): which of a request's headers are no CORS-safelisted ones, the CORS check of a response, the
// CORS-preflight's verdict and the grant it makes, the CORS-preflight cache of each browsing session — its entries by
// origin, URL and credentials, one for each method and each header name a grant allows, each until its max-age — and
// the headers a CORS response exposes. The host sends the preflight and the requests; these say what they carry and
// what comes of them.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex, MutexGuard};

use magnus::TryConvert;

use crate::fetch_rules::{cors_safelisted_method, cors_safelisted_request_header, cors_safelisted_response_header, forbidden_response_header, is_token, ruby_bytes};

// Fetch's "CORS non-wildcard request-header name": `*` in a grant never covers it.
const NON_WILDCARD: &str = "authorization";
// The max-age of a grant whose response names none, or none valid (Fetch "CORS-preflight fetch" step 7.8) — and the
// most one may have, the limit Fetch lets a user agent impose (Chrome's: two hours).
const DEFAULT_MAX_AGE: f64 = 5.0;
const MAX_MAX_AGE: f64 = 7200.0;

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
pub(crate) fn check(acao: Option<&str>, acac: Option<&str>, origin: Option<&str>, credentialed: bool) -> bool {
    match (acao, origin) {
        (None, _) => false,
        (Some(acao), _) if !credentialed && acao == "*" => true,
        (_, None) => false,
        (Some(acao), Some(origin)) if credentialed => acao == origin && acac == Some("true"),
        (Some(acao), Some(origin)) => acao == origin,
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
    if !(200..300).contains(&status) || !check(acao, acac, Some(origin), credentialed) {
        return None;
    }
    let methods = token_list(allow_methods)?;
    let headers: Vec<String> = token_list(allow_headers)?.into_iter().map(|h| h.to_ascii_lowercase()).collect();
    if !covers(&methods, &headers, method, unsafe_names, credentialed) {
        return None;
    }
    // (…a missing `Access-Control-Allow-Methods` no grant of the request's method: Fetch's step 7.4 makes it one only for a
    // request whose use-CORS-preflight flag is set, which no request here has. Its max-age `delta-seconds`, digits alone,
    // and one past the limit the limit.)
    let max_age = max_age
        .map(|v| v.trim_matches([' ', '\t']))
        .filter(|v| !v.is_empty() && v.bytes().all(|b| b.is_ascii_digit()))
        .map_or(DEFAULT_MAX_AGE, |v| v.parse::<f64>().map_or(MAX_MAX_AGE, |s| s.min(MAX_MAX_AGE)));
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

// Fetch "cache entry match": an entry of `origin` and `url` serves a request of credentials `credentials` where it is a
// credentialed one's, or the request is not credentialed either.
fn matches(e: &CacheEntry, origin: &str, url: &str, credentials: bool) -> bool {
    e.origin == origin && e.url == url && (e.credentials || !credentials)
}

impl PreflightCache {
    fn of<'a>(&'a self, origin: &'a str, url: &'a str, credentials: bool, now: f64) -> impl Iterator<Item = &'a CacheEntry> {
        self.entries.iter().filter(move |e| matches(e, origin, url, credentials) && e.expires > now)
    }
    // Fetch "clear cache entries": a request of `origin` to `url` whose CORS-preflight — or the request after it — failed
    // lets every entry of theirs go.
    fn clear_for(&mut self, origin: &str, url: &str) {
        self.entries.retain(|e| !(e.origin == origin && e.url == url));
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
            let existing = self.entries.iter_mut().find(|e| matches(e, origin, url, credentials) && e.method == method && e.header == header);
            match existing {
                Some(e) => e.expires = expires,
                None => self.entries.push(CacheEntry { origin: origin.to_owned(), url: url.to_owned(), credentials, method, header, expires }),
            }
        }
        self.entries.retain(|e| e.expires > now);
    }
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
// …let go of with the window it was made for…
pub(crate) fn cache_drop_for_ruby(id: u64) {
    caches().1.remove(&id);
}
// …its entries of a request of `origin` to `url` whose preflight or response failed let go (`clear_for`)…
pub(crate) fn forget(id: u64, origin: String, url: String) {
    if let Some(cache) = caches().1.get_mut(&id) {
        cache.clear_for(&origin, &url);
    }
}
// …whether its entries cover a request of `origin` to `url` (`PreflightCache::covers`)…
pub(crate) fn covers_request(id: u64, origin: String, url: String, credentials: bool, method: String, unsafe_names: Vec<String>, now: f64) -> bool {
    caches().1.get(&id).is_some_and(|c| c.covers(&origin, &url, credentials, &method, &unsafe_names, now))
}
// (…[status, acao, acac, methods, headers, max-age] of the preflight's response, [origin, url, credentials, method,
// unsafe names] of the request)
#[allow(clippy::too_many_arguments)]
pub(crate) fn grant_preflight(
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
pub(crate) fn exposed<'a>(names: impl IntoIterator<Item = &'a [u8]>, expose: Option<&str>, credentialed: bool) -> Vec<usize> {
    let expose: Vec<Vec<u8>> = token_list(expose).unwrap_or_default().into_iter().map(|h| h.to_ascii_lowercase().into_bytes()).collect();
    let all = !credentialed && expose.iter().any(|e| e == b"*");
    names
        .into_iter()
        .enumerate()
        .filter(|(_, name)| {
            let lower = name.to_ascii_lowercase();
            let shown = all || cors_safelisted_response_header(&lower) || expose.contains(&lower) || lower == b"x-csim-status-text";
            shown && !forbidden_response_header(&lower)
        })
        .map(|(i, _)| i)
        .collect()
}
// (…`names` byte strings: the indices of those it exposes)
pub(crate) fn exposed_names_for_ruby(names: magnus::RArray, expose: Option<String>, credentialed: bool) -> Result<Vec<usize>, magnus::Error> {
    let names: Vec<Vec<u8>> = names.into_iter().map(|n| magnus::RString::try_convert(n).map(ruby_bytes)).collect::<Result<_, _>>()?;
    Ok(exposed(names.iter().map(Vec::as_slice), expose.as_deref(), credentialed))
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
        let o = Some("https://a.test");
        assert!(check(Some("*"), None, o, false));
        assert!(!check(Some("*"), Some("true"), o, true));
        assert!(check(Some("https://a.test"), Some("true"), o, true));
        assert!(!check(Some("https://a.test"), Some("TRUE"), o, true));
        assert!(!check(None, None, o, false));
        // (…a request of no origin allowed by `*` alone)
        assert!(check(Some("*"), None, None, false));
        assert!(!check(Some(""), None, None, false));
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
        // (…a credentialed request's entries serve an uncredentialed one, not the other way round)
        let c = preflight(200, Some("o"), Some("true"), Some("PATCH"), None, None, "PATCH", &[], "o", true).unwrap();
        cache.store("o", "u", true, &c, 1.0);
        assert!(cache.covers("o", "u", false, "PATCH", &[], 2.0));
        assert!(!cache.covers("o", "u", true, "PUT", &unsafe_names, 2.0));
        cache.clear_for("o", "u");
        assert!(!cache.covers("o", "u", false, "DELETE", &[], 2.0));
    }

    #[test]
    fn a_max_age_is_delta_seconds_up_to_two_hours() {
        let age = |v: &str| preflight(200, Some("*"), None, None, None, Some(v), "GET", &[], "o", false).unwrap().max_age;
        assert_eq!(age(" 60 "), 60.0);
        assert_eq!(age("+60"), DEFAULT_MAX_AGE);
        assert_eq!(age("6e1"), DEFAULT_MAX_AGE);
        assert_eq!(age("86400"), MAX_MAX_AGE);
        assert_eq!(age("99999999999999999999999999"), MAX_MAX_AGE);
        // (…no grant of an unsafe method the response does not name)
        assert!(preflight(200, Some("*"), None, None, None, None, "PUT", &[], "o", false).is_none());
    }

    #[test]
    fn a_cors_response_exposes_its_safelisted_and_named_headers() {
        let names: [&[u8]; 5] = [b"Content-Type", b"X-Secret", b"Set-Cookie", b"X-Shown", b"x-csim-status-text"];
        assert_eq!(exposed(names, Some("x-shown"), false), [0, 3, 4]);
        assert_eq!(exposed(names, Some("*"), false), [0, 1, 3, 4]);
        assert_eq!(exposed(names, Some("*"), true), [0, 4]);
        // (…a list naming a non-token none of them)
        assert_eq!(exposed(names, Some("x-shown, a b"), false), [0, 4]);
    }
}
