// Cookies (RFC 6265bis): each driver session's cookie store, one registry for the process. A cookie is what a
// `Set-Cookie` header or a `document.cookie` write made of a set-cookie-string (§5.6), stored as §5.7 says — its domain
// (a host it is that host's alone, else every host that domain-matches it), its path, its expiry, its creation time,
// and its secure-only, http-only and same-site flags — and a request's `Cookie` header, or a `document.cookie` read, is
// those it retrieves (§5.8.3): the cookies whose domain and path match the request's URL, a Secure one over a secure
// channel only, an HttpOnly one through HTTP only, a SameSite one in the contexts it allows.
//
// The host keeps the time (the app's clock, which a test may travel): every call is told "now", in ms since the epoch.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex, MutexGuard};

#[derive(Clone, Copy, Debug, PartialEq)]
enum SameSite {
    Default,
    None,
    Lax,
    Strict,
}

#[derive(Clone, Debug)]
struct Cookie {
    name: String,
    value: String,
    domain: String,
    path: String,
    expiry: Option<f64>,
    creation: u64,
    host_only: bool,
    secure: bool,
    http_only: bool,
    same_site: SameSite,
}

#[derive(Default)]
struct Jar {
    cookies: Vec<Cookie>,
    created: u64,
}

#[derive(Default)]
struct Registry {
    jars: HashMap<u64, Jar>,
    next: u64,
}

static REGISTRY: LazyLock<Mutex<Registry>> = LazyLock::new(Mutex::default);

fn lock() -> MutexGuard<'static, Registry> {
    REGISTRY.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

// The context a cookie is set or retrieved in, as the host tells it (bits).
// …through an HTTP API (a `Set-Cookie` header, a request's `Cookie`), not `document.cookie`;
const HTTP: u32 = 1;
// …over a secure channel (https, or a host the host takes as potentially trustworthy);
const SECURE: u32 = 2;
// …for a request that is cross-site ("site for cookies"), where only a SameSite=None cookie goes — but a Lax one (and
// one of none) too where it is a top-level navigation by a safe method (`LAX_OK`)…
const CROSS_SITE: u32 = 4;
const LAX_OK: u32 = 8;

// A cookie's longest life: 400 days (§5.6.1, §5.6.2).
const MAX_AGE_MS: f64 = 400.0 * 24.0 * 3600.0 * 1000.0;

// ── The cookie-date (§5.1.1) ─────────────────────────────────────────────────────────────────────────────────────────
// A date in an `Expires` attribute, as ms since the epoch: the first time, day of month, month and year its tokens
// give — a two-digit year in 1970-2069 — or None where one is missing or out of range.
fn cookie_date(value: &str) -> Option<f64> {
    let delimiter = |c: char| matches!(c, '\t' | ' '..='/' | ';'..='@' | '['..='`' | '{'..='~');
    let (mut time, mut day, mut month, mut year) = (None, None, None, None);
    for token in value.split(delimiter).filter(|t| !t.is_empty()) {
        if time.is_none() {
            if let Some(t) = time_of(token) {
                time = Some(t);
                continue;
            }
        }
        if day.is_none() {
            if let Some(d) = digits(token, 1, 2) {
                day = Some(d);
                continue;
            }
        }
        if month.is_none() {
            let lower = token.get(..3).map(str::to_ascii_lowercase);
            let months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
            if let Some(m) = lower.and_then(|l| months.iter().position(|m| *m == l)) {
                month = Some(m as u32 + 1);
                continue;
            }
        }
        if year.is_none() {
            if let Some(y) = digits(token, 2, 4) {
                year = Some(y);
                continue;
            }
        }
    }
    let (h, mi, s) = time?;
    let (day, month, mut year) = (day?, month?, year?);
    if (70..=99).contains(&year) {
        year += 1900;
    } else if year <= 69 {
        year += 2000;
    }
    if year < 1601 || h > 23 || mi > 59 || s > 59 || day < 1 || day > days_in_month(year, month) {
        return None;
    }
    let days = days_from_civil(i64::from(year), month, day);
    Some((days * 86_400 + i64::from(h) * 3600 + i64::from(mi) * 60 + i64::from(s)) as f64 * 1000.0)
}
// A token of `min`-`max` digits, perhaps followed by anything but a digit: its number.
fn digits(token: &str, min: usize, max: usize) -> Option<u32> {
    let n = token.bytes().take_while(u8::is_ascii_digit).count();
    (min..=max).contains(&n).then(|| token[..n].parse().ok()).flatten()
}
// A time token, `h:m:s` of one or two digits each, the last perhaps followed by anything but a digit.
fn time_of(token: &str) -> Option<(u32, u32, u32)> {
    let mut parts = token.splitn(3, ':');
    let h = parts.next()?;
    let m = parts.next()?;
    let s = parts.next()?;
    let whole = |p: &str| (1..=2).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_digit());
    if !whole(h) || !whole(m) {
        return None;
    }
    Some((h.parse().ok()?, m.parse().ok()?, digits(s, 1, 2)?))
}
fn days_in_month(year: u32, month: u32) -> u32 {
    match month {
        2 if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}
// Days since 1970-01-01 of a proleptic Gregorian date.
fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let m = i64::from(month);
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + i64::from(day) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

// ── Matching (§5.1.3, §5.1.4) ────────────────────────────────────────────────────────────────────────────────────────
// Whether `host` domain-matches `domain`: it is it, or a host name (no IP address) ending in it after a dot.
fn domain_match(host: &str, domain: &str) -> bool {
    host == domain || (!crate::realm_location::ip_host(host) && host.strip_suffix(domain).is_some_and(|sub| sub.ends_with('.')))
}
// A request path's default cookie path: up to its last `/` but that one — `/` where that is the first.
fn default_path(path: &str) -> String {
    if !path.starts_with('/') {
        return "/".to_owned();
    }
    match path.rfind('/') {
        Some(0) | None => "/".to_owned(),
        Some(at) => path[..at].to_owned(),
    }
}
// Whether a request path path-matches a cookie path: it is it, or begins with it where it ends in `/` or the request
// path's next character is one.
fn path_match(request: &str, cookie: &str) -> bool {
    request == cookie
        || request.strip_prefix(cookie).is_some_and(|rest| cookie.ends_with('/') || rest.starts_with('/'))
}

// ── Parsing a set-cookie-string (§5.6) ───────────────────────────────────────────────────────────────────────────────
struct Parsed {
    name: String,
    value: String,
    expires: Option<f64>,
    max_age: Option<f64>,
    domain: Option<String>,
    path: Option<String>,
    secure: bool,
    http_only: bool,
    same_site: SameSite,
}
fn parse(line: &str, now: f64) -> Option<Parsed> {
    // (…a control character but a tab in it: no cookie)
    if line.chars().any(|c| (c.is_ascii_control() && c != '\t') || c == '\u{7f}') {
        return None;
    }
    let trim = |s: &str| s.trim_matches([' ', '\t']).to_owned();
    let (pair, attributes) = line.split_once(';').map_or((line, ""), |(p, a)| (p, a));
    let (name, value) = pair.split_once('=').map_or((String::new(), trim(pair)), |(n, v)| (trim(n), trim(v)));
    if (name.is_empty() && value.is_empty()) || name.len() + value.len() > 4096 {
        return None;
    }
    let mut parsed = Parsed {
        name,
        value,
        expires: None,
        max_age: None,
        domain: None,
        path: None,
        secure: false,
        http_only: false,
        same_site: SameSite::Default,
    };
    for av in attributes.split(';') {
        let (key, value) = av.split_once('=').map_or((trim(av), String::new()), |(k, v)| (trim(k), trim(v)));
        if value.len() > 1024 {
            continue;
        }
        match key.to_ascii_lowercase().as_str() {
            "expires" => {
                if let Some(at) = cookie_date(&value) {
                    parsed.expires = Some(at.min(now + MAX_AGE_MS));
                }
            }
            "max-age" => {
                let well_formed = value.strip_prefix('-').unwrap_or(&value);
                if !well_formed.is_empty() && well_formed.bytes().all(|b| b.is_ascii_digit()) {
                    let seconds: f64 = value.parse().unwrap_or(f64::MAX);
                    parsed.max_age = Some(if seconds <= 0.0 { f64::NEG_INFINITY } else { (now + seconds * 1000.0).min(now + MAX_AGE_MS) });
                }
            }
            "domain" => {
                if !value.is_empty() {
                    parsed.domain = Some(value.strip_prefix('.').unwrap_or(&value).to_ascii_lowercase());
                }
            }
            "path" => parsed.path = value.starts_with('/').then_some(value),
            "secure" => parsed.secure = true,
            "httponly" => parsed.http_only = true,
            "samesite" => {
                parsed.same_site = match value.to_ascii_lowercase().as_str() {
                    "none" => SameSite::None,
                    "lax" => SameSite::Lax,
                    "strict" => SameSite::Strict,
                    _ => SameSite::Default,
                }
            }
            _ => {}
        }
    }
    Some(parsed)
}

// ── Storing (§5.7) ───────────────────────────────────────────────────────────────────────────────────────────────────
// A request URL's host (lowercased, as a URL's is) and path — None for one with no host.
fn host_and_path(url: &str) -> Option<(String, String)> {
    let url = ada_url::Url::parse(url, None).ok()?;
    let host = url.hostname();
    (!host.is_empty()).then(|| (host.to_owned(), url.pathname().to_owned()))
}

impl Jar {
    fn store(&mut self, url: &str, line: &str, context: u32, now: f64) {
        let Some((host, path)) = host_and_path(url) else { return };
        let Some(p) = parse(line, now) else { return };
        let (http, secure_channel) = (context & HTTP != 0, context & SECURE != 0);
        // (…a nameless cookie whose value would read as a prefixed name: none)
        let lower_value = p.value.to_ascii_lowercase();
        if p.name.is_empty() && (lower_value.starts_with("__secure-") || lower_value.starts_with("__host-")) {
            return;
        }
        let expiry = p.max_age.or(p.expires);
        // Its domain: the attribute's — a domain the request's host domain-matches, and no public suffix but the host
        // itself, which then is host-only — else the host, host-only.
        let (domain, host_only) = match p.domain {
            Some(domain) if crate::realm_location::is_public_suffix(&domain) => {
                if domain != host {
                    return;
                }
                (domain, true)
            }
            Some(domain) if domain == host => (domain, false),
            Some(domain) => {
                if !domain.is_ascii() || !domain_match(&host, &domain) {
                    return;
                }
                (domain, false)
            }
            None => (host.clone(), true),
        };
        let path = p.path.unwrap_or_else(|| default_path(&path));
        if (p.secure && !secure_channel) || (p.http_only && !http) {
            return;
        }
        // SameSite=None needs Secure (Chrome, and the draft's "SameSite=None requires Secure").
        if p.same_site == SameSite::None && !p.secure {
            return;
        }
        // A non-secure channel may not shadow a Secure cookie of the name whose domain and path are its (§5.7 step 16).
        if !p.secure && !secure_channel && self.cookies.iter().any(|c| {
            c.name == p.name && c.secure && (domain_match(&domain, &c.domain) || domain_match(&c.domain, &domain)) && path_match(&path, &c.path)
        }) {
            return;
        }
        // The prefixes: `__Secure-` Secure, `__Host-` Secure, host-only and at `/` (case-insensitively, §5.7 step 19-20).
        let lower_name = p.name.to_ascii_lowercase();
        if lower_name.starts_with("__secure-") && !p.secure {
            return;
        }
        if lower_name.starts_with("__host-") && !(p.secure && host_only && path == "/") {
            return;
        }
        let same = |c: &Cookie| c.name == p.name && c.domain == domain && c.host_only == host_only && c.path == path;
        let mut creation = None;
        if let Some(at) = self.cookies.iter().position(same) {
            // (…an HttpOnly one no non-HTTP API replaces)
            if self.cookies[at].http_only && !http {
                return;
            }
            creation = Some(self.cookies.remove(at).creation);
        }
        if expiry.is_some_and(|e| e <= now) {
            return;
        }
        let creation = creation.unwrap_or_else(|| {
            self.created += 1;
            self.created
        });
        self.cookies.push(Cookie {
            name: p.name,
            value: p.value,
            domain,
            path,
            expiry,
            creation,
            host_only,
            secure: p.secure,
            http_only: p.http_only,
            same_site: p.same_site,
        });
    }

    // ── Retrieving (§5.8.3) ──────────────────────────────────────────────────────────────────────────────────────────
    // The cookie-string a request to `url` takes in `context`: the cookies it retrieves — the longest path first, then
    // the earliest made — `name=value` each (a nameless one its value), joined by `; `.
    fn retrieve(&mut self, url: &str, context: u32, now: f64) -> String {
        self.cookies.retain(|c| c.expiry.is_none_or(|e| e > now));
        let Some((host, path)) = host_and_path(url) else { return String::new() };
        let (http, secure_channel, cross_site, lax_ok) =
            (context & HTTP != 0, context & SECURE != 0, context & CROSS_SITE != 0, context & LAX_OK != 0);
        let mut found: Vec<&Cookie> = self
            .cookies
            .iter()
            .filter(|c| if c.host_only { host == c.domain } else { domain_match(&host, &c.domain) })
            .filter(|c| path_match(&path, &c.path))
            .filter(|c| !c.secure || secure_channel)
            .filter(|c| !c.http_only || http)
            .filter(|c| !cross_site || match c.same_site {
                SameSite::None => true,
                SameSite::Strict => false,
                SameSite::Lax | SameSite::Default => lax_ok,
            })
            .collect();
        found.sort_by(|a, b| b.path.len().cmp(&a.path.len()).then(a.creation.cmp(&b.creation)));
        found.iter().map(|c| if c.name.is_empty() { c.value.clone() } else { format!("{}={}", c.name, c.value) }).collect::<Vec<_>>().join("; ")
    }
}

// ── For the host ──
// (…a set-cookie-string and a cookie-string cross as bytes, whatever their encoding: each byte the character it is, so
// what the server sent is what goes back, a UTF-8 one's bytes included; a URL as its text)
fn text(s: magnus::RString) -> String {
    // SAFETY: copied at once, before anything could run Ruby code that moves or frees it.
    unsafe { s.as_slice() }.iter().map(|&b| char::from(b)).collect()
}
fn url_text(s: magnus::RString) -> String {
    // SAFETY: as above.
    String::from_utf8_lossy(unsafe { s.as_slice() }).into_owned()
}
fn bytes(text: &str) -> magnus::RString {
    let bytes: Vec<u8> = text.chars().map(|c| u8::try_from(u32::from(c)).unwrap_or(b'?')).collect();
    magnus::RString::from_slice(&bytes)
}
// A new session's cookie store.
pub(crate) fn new_for_ruby() -> u64 {
    let mut reg = lock();
    reg.next += 1;
    let id = reg.next;
    reg.jars.insert(id, Jar::default());
    id
}
// Every cookie of the store gone.
pub(crate) fn clear_for_ruby(jar: u64) {
    if let Some(j) = lock().jars.get_mut(&jar) {
        j.cookies.clear();
    }
}
// A set-cookie-string received for `url` in `context` (bits) at `now`, stored as it says.
pub(crate) fn set_for_ruby(jar: u64, url: magnus::RString, line: magnus::RString, context: u32, now: f64) {
    let (url, line) = (url_text(url), text(line));
    if let Some(j) = lock().jars.get_mut(&jar) {
        j.store(&url, &line, context, now);
    }
}
// The cookie-string a request to `url` in `context` at `now` takes ('' for none), as bytes.
pub(crate) fn get_for_ruby(jar: u64, url: magnus::RString, context: u32, now: f64) -> magnus::RString {
    let url = url_text(url);
    let found = lock().jars.get_mut(&jar).map_or_else(String::new, |j| j.retrieve(&url, context, now));
    bytes(&found)
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: f64 = 1_700_000_000_000.0;
    const H: u32 = HTTP;

    fn jar(lines: &[(&str, &str, u32)]) -> Jar {
        let mut j = Jar::default();
        for (url, line, ctx) in lines {
            j.store(url, line, *ctx, NOW);
        }
        j
    }

    #[test]
    fn reads_a_cookie_date() {
        assert_eq!(cookie_date("Wed, 21 Oct 2015 07:28:00 GMT"), Some(1_445_412_480_000.0));
        assert_eq!(cookie_date("Thu, 01-Jan-70 00:00:01 GMT"), Some(1000.0));
        assert_eq!(cookie_date("Sun, 06 Nov 94 08:49:37 GMT"), Some(784_111_777_000.0));
        assert_eq!(cookie_date("31 Feb 2015 00:00:00"), None);
        assert_eq!(cookie_date("Wed, 21 Oct 1600 07:28:00 GMT"), None);
        assert_eq!(cookie_date("garbage"), None);
    }

    #[test]
    fn scopes_a_cookie_by_its_domain_and_path() {
        let mut j = jar(&[
            ("http://www.example.com/a/b", "host=1", H),
            ("http://www.example.com/a/b", "dom=2; Domain=example.com", H),
            ("http://www.example.com/a/b", "root=3; Path=/", H),
            ("http://www.example.com/", "other=4; Domain=other.com", H),
            ("http://www.example.com/", "suffix=5; Domain=com", H),
        ]);
        assert_eq!(j.retrieve("http://www.example.com/a/c", H, NOW), "host=1; dom=2; root=3");
        assert_eq!(j.retrieve("http://api.example.com/a/x", H, NOW), "dom=2");
        assert_eq!(j.retrieve("http://www.example.com/b", H, NOW), "root=3");
        assert_eq!(j.retrieve("http://example.com/a", H, NOW), "dom=2");
    }

    #[test]
    fn keeps_secure_http_only_and_same_site_where_they_go() {
        let mut j = jar(&[
            ("https://a.test/", "s=1; Secure", H | SECURE),
            ("http://a.test/", "insecure=1; Secure", H),
            ("https://a.test/", "h=2; HttpOnly", H | SECURE),
            ("https://a.test/", "strict=3; SameSite=Strict", H | SECURE),
            ("https://a.test/", "none=4; SameSite=None; Secure", H | SECURE),
            ("https://a.test/", "nonone=5; SameSite=None", H | SECURE),
        ]);
        assert_eq!(j.retrieve("https://a.test/", H | SECURE, NOW), "s=1; h=2; strict=3; none=4");
        assert_eq!(j.retrieve("http://a.test/", H, NOW), "h=2; strict=3");
        assert_eq!(j.retrieve("https://a.test/", SECURE, NOW), "s=1; strict=3; none=4");
        assert_eq!(j.retrieve("https://a.test/", H | SECURE | CROSS_SITE, NOW), "none=4");
        assert_eq!(j.retrieve("https://a.test/", H | SECURE | CROSS_SITE | LAX_OK, NOW), "s=1; h=2; none=4");
        // (…a document write leaves an HttpOnly one be)
        j.store("https://a.test/", "h=x", SECURE, NOW);
        assert_eq!(j.retrieve("https://a.test/", H | SECURE, NOW), "s=1; h=2; strict=3; none=4");
    }

    #[test]
    fn expires_deletes_and_orders() {
        let mut j = jar(&[
            ("http://a.test/x/y", "a=1", H),
            ("http://a.test/x/y", "b=2; Max-Age=10", H),
            ("http://a.test/x/y", "c=3; Path=/x/y", H),
            ("http://a.test/x/y", "d=4; Expires=Wed, 21 Oct 2015 07:28:00 GMT", H),
        ]);
        assert_eq!(j.retrieve("http://a.test/x/y", H, NOW), "c=3; a=1; b=2");
        assert_eq!(j.retrieve("http://a.test/x/y", H, NOW + 11_000.0), "c=3; a=1");
        j.store("http://a.test/x/y", "a=; Max-Age=0", H, NOW);
        assert_eq!(j.retrieve("http://a.test/x/y", H, NOW), "c=3");
        j.store("http://a.test/x/y", "b=new", H, NOW);
        assert_eq!(j.retrieve("http://a.test/x/y", H, NOW), "c=3; b=new");
    }

    #[test]
    fn honours_the_prefixes_and_nameless_cookies() {
        let mut j = jar(&[
            ("https://a.test/", "__Secure-a=1", H | SECURE),
            ("https://a.test/", "__Secure-b=2; Secure", H | SECURE),
            ("https://a.test/", "__Host-c=3; Secure; Path=/; Domain=a.test", H | SECURE),
            ("https://a.test/", "__Host-d=4; Secure; Path=/", H | SECURE),
            ("https://a.test/", "lone", H | SECURE),
            ("https://a.test/", "=__Host-x", H | SECURE),
        ]);
        assert_eq!(j.retrieve("https://a.test/", H | SECURE, NOW), "__Secure-b=2; __Host-d=4; lone");
    }
}
