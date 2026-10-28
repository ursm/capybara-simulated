// The HTTP cache's policy (RFC 9111) for the host's fetches: whether a response may be stored and for how long it is
// fresh, what a 304 that revalidates a stored one makes of it, and the conditional headers a revalidation sends. The host
// keeps the stored responses (their bodies never cross); these say what it does with them. A private cache's view — this
// is a browser's — but for `private`, which the host's cache, shared across the test sessions of a process, does not store.

// RFC 9111 §3 / §4.2.2: the statuses stored. 302 and 307 only with explicit freshness or a validator (no heuristic
// lifetime: a temporary redirect served stale is a redirect that has moved on).
const CACHEABLE: [u32; 14] = [200, 203, 204, 206, 300, 301, 302, 307, 308, 404, 405, 410, 414, 501];
const HEURISTIC: [u32; 12] = [200, 203, 204, 206, 300, 301, 308, 404, 405, 410, 414, 501];
// The heuristic lifetime: a tenth of the time since the response's Last-Modified (§4.2.2's suggestion, as browsers use
// it), at most a day.
const HEURISTIC_CAP: f64 = 24.0 * 60.0 * 60.0;
// §1.2.2: a delta-seconds too great to hold.
const DELTA_SECONDS_MAX: f64 = 2_147_483_648.0;
// `Vary` fields a stored response answers whatever the request said: none the host ever sends.
const SAFE_VARY: [&str; 1] = ["accept-encoding"];

// The fields of a response the policy reads, each its field lines combined ("a, b"), None for none.
#[derive(Default)]
pub(crate) struct Fields<'a> {
    pub(crate) cache_control: Option<&'a str>,
    pub(crate) expires: Option<&'a str>,
    pub(crate) date: Option<&'a str>,
    pub(crate) last_modified: Option<&'a str>,
    pub(crate) etag: Option<&'a str>,
    pub(crate) vary: Option<&'a str>,
    pub(crate) age: Option<&'a str>,
}

// What a stored response is kept with: the seconds it stays fresh for from the moment it was stored (`max_age`, its
// freshness lifetime less its age then — none for a response with none, revalidated each use; ≤ 0 stale already), whether
// every use revalidates it (`no-cache`), and whether it is `immutable` (kept across the host's test resets).
#[derive(Debug, PartialEq)]
pub(crate) struct Policy {
    pub(crate) max_age: Option<f64>,
    pub(crate) no_cache: bool,
    pub(crate) immutable: bool,
}

#[derive(Default)]
struct Directives {
    no_store: bool,
    no_cache: bool,
    private: bool,
    immutable: bool,
    max_age: Option<f64>,
}

// §5.2: a Cache-Control's directives, case-insensitive, a value in token or quoted-string form. A directive given more
// than once is read where it is first given (§4.2.1 lets a cache use the first). A max-age that is no delta-seconds makes
// the response stale (a lifetime of 0) rather than be ignored, so no ill-formed one lends it freshness.
fn directives(value: Option<&str>) -> Directives {
    let mut d = Directives::default();
    let mut seen_max_age = false;
    for part in value.unwrap_or("").split(',') {
        let (key, val) = match part.split_once('=') {
            Some((k, v)) => (k.trim(), Some(v.trim().trim_matches('"'))),
            None => (part.trim(), None),
        };
        match key.to_ascii_lowercase().as_str() {
            "no-store" => d.no_store = true,
            "no-cache" => d.no_cache = true,
            "private" => d.private = true,
            "immutable" => d.immutable = true,
            // (…`s-maxage` a shared cache's alone: a browser's cache ignores it)
            "max-age" if !seen_max_age => {
                seen_max_age = true;
                d.max_age = Some(val.map_or(0.0, delta_seconds));
            }
            _ => {}
        }
    }
    d
}
// §1.2.2 "delta-seconds": digits alone; one past what a cache can hold is the greatest it can; anything else 0.
fn delta_seconds(v: &str) -> f64 {
    if v.is_empty() || !v.bytes().all(|b| b.is_ascii_digit()) {
        return 0.0;
    }
    v.parse::<f64>().map_or(DELTA_SECONDS_MAX, |s| s.min(DELTA_SECONDS_MAX))
}

// §5.3 / RFC 9110 §5.6.7 "HTTP-date", as seconds since the epoch: IMF-fixdate, and the obsolete RFC 850 and asctime
// forms a recipient must accept. None for anything else.
pub(crate) fn http_date(value: &str) -> Option<f64> {
    let parts: Vec<&str> = value.split_ascii_whitespace().collect();
    let month = |m: &str| ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].iter().position(|n| n.eq_ignore_ascii_case(m)).map(|i| i as u32 + 1);
    let clock = |t: &str| -> Option<(u32, u32, u32)> {
        let mut it = t.split(':').map(|n| (n.len() == 2).then(|| n.parse::<u32>().ok()).flatten());
        let (h, m, s) = (it.next()??, it.next()??, it.next()??);
        (it.next().is_none() && h < 24 && m < 60 && s < 61).then_some((h, m, s))
    };
    let (year, mon, day, time) = match parts.as_slice() {
        // Sun, 06 Nov 1994 08:49:37 GMT
        [_, d, m, y, t, "GMT"] if y.len() == 4 => (y.parse::<i64>().ok()?, month(m)?, d.parse::<u32>().ok()?, clock(t)?),
        // Sunday, 06-Nov-94 08:49:37 GMT (a two-digit year: within 50 years ahead, else the century before)
        [_, dmy, t, "GMT"] => {
            let mut it = dmy.split('-');
            let (d, m, y) = (it.next()?, it.next()?, it.next()?);
            let y = y.parse::<i64>().ok()?;
            let y = if y < 100 { if y < 70 { 2000 + y } else { 1900 + y } } else { y };
            (y, month(m)?, d.parse::<u32>().ok()?, clock(t)?)
        }
        // Sun Nov  6 08:49:37 1994
        [_, m, d, t, y] => (y.parse::<i64>().ok()?, month(m)?, d.parse::<u32>().ok()?, clock(t)?),
        _ => return None,
    };
    if !(1..=31).contains(&day) {
        return None;
    }
    // (…days from the civil date: Howard Hinnant's algorithm)
    let (y, m) = if mon <= 2 { (year - 1, mon + 9) } else { (year, mon - 3) };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * m as i64 + 2) / 5 + day as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some((days * 86_400 + time.0 as i64 * 3600 + time.1 as i64 * 60 + time.2 as i64) as f64)
}

// §4.2.1 the freshness lifetime — max-age, else Expires less Date (an invalid Expires, "0" the common one, in the past:
// §5.3), else, for a status heuristically cacheable, a tenth of the time since Last-Modified — less §4.2.3's age the
// response had when it came (`now`): the greater of how long it was since its Date and its Age.
fn lifetime(d: &Directives, f: &Fields<'_>, heuristic: bool, now: f64) -> Option<f64> {
    let date = f.date.and_then(http_date);
    let explicit = d.max_age.or_else(|| f.expires.map(|e| http_date(e).map_or(0.0, |exp| (exp - date.unwrap_or(now)).max(0.0))));
    let lifetime = explicit.or_else(|| {
        let modified = f.last_modified.and_then(http_date)?;
        let age = date.unwrap_or(now) - modified;
        (heuristic && age > 0.0).then(|| (age * 0.1).floor().min(HEURISTIC_CAP))
    })?;
    let apparent = date.map_or(0.0, |d| (now - d).max(0.0));
    let age = f.age.map_or(0.0, |a| delta_seconds(a.trim()));
    Some(lifetime - apparent.max(age))
}

fn vary_compatible(vary: Option<&str>) -> bool {
    vary.is_none_or(|v| v.split(',').map(|f| f.trim().to_ascii_lowercase()).filter(|f| !f.is_empty()).all(|f| SAFE_VARY.contains(&f.as_str())))
}

// §3 "Storing Responses in Caches": what a response of `status` with `fields`, come at `now`, is stored with — None where
// it may not be: a status not cacheable by default, `no-store`, `private`, a Vary the host cannot honour, and nothing to
// go on (no freshness, no validator).
pub(crate) fn storable(status: u32, f: &Fields<'_>, now: f64) -> Option<Policy> {
    if !CACHEABLE.contains(&status) {
        return None;
    }
    let policy = kept(status, f, now)?;
    (policy.max_age.is_some() || f.etag.is_some() || f.last_modified.is_some()).then_some(policy)
}
// §4.3.4: what a stored response of `status` is kept with once a 304 updated its fields to `f` — None where they now
// forbid keeping it (the request is answered from it all the same).
pub(crate) fn refreshed(status: u32, f: &Fields<'_>, now: f64) -> Option<Policy> {
    kept(status, f, now)
}
fn kept(status: u32, f: &Fields<'_>, now: f64) -> Option<Policy> {
    let d = directives(f.cache_control);
    if d.no_store || d.private || !vary_compatible(f.vary) {
        return None;
    }
    Some(Policy { max_age: lifetime(&d, f, HEURISTIC.contains(&status), now), no_cache: d.no_cache, immutable: d.immutable })
}
// §4.2: whether a response stored at `stored_at` with `policy`'s fields is fresh at `now` — never one every use
// revalidates.
pub(crate) fn fresh(stored_at: f64, max_age: Option<f64>, no_cache: bool, now: f64) -> bool {
    !no_cache && max_age.is_some_and(|m| m > 0.0 && now - stored_at < m)
}
// §4.3.4: a field a 304 does not update in the stored response — one describing the content it carries none of, its
// cookies (a stored response keeps none), and the host's own `x-csim-*`.
pub(crate) fn unrefreshed(name: &str) -> bool {
    matches!(name, "content-encoding" | "content-length" | "content-range" | "transfer-encoding" | "set-cookie") || name.starts_with("x-csim-")
}

// — for the host —
// (…each field a byte string, or nil)
fn text(v: Option<magnus::RString>) -> Option<String> {
    v.map(|s| String::from_utf8_lossy(&crate::fetch_rules::ruby_bytes(s)).into_owned())
}
fn policy_value(p: Option<Policy>) -> Option<(Option<f64>, bool, bool)> {
    p.map(|p| (p.max_age, p.no_cache, p.immutable))
}
// `storable` (`refresh` false) or `refreshed` (true) over a response's Cache-Control, Expires, Date, Last-Modified, ETag,
// Vary and Age: nil, or [max_age (nil none), no_cache, immutable].
#[allow(clippy::too_many_arguments)]
pub(crate) fn policy_for_ruby(
    status: u32,
    cache_control: Option<magnus::RString>,
    expires: Option<magnus::RString>,
    date: Option<magnus::RString>,
    last_modified: Option<magnus::RString>,
    etag: Option<magnus::RString>,
    vary: Option<magnus::RString>,
    age: Option<magnus::RString>,
    now: f64,
    refresh: bool,
) -> Option<(Option<f64>, bool, bool)> {
    let [cache_control, expires, date, last_modified, etag, vary, age] = [cache_control, expires, date, last_modified, etag, vary, age].map(text);
    let f = Fields {
        cache_control: cache_control.as_deref(),
        expires: expires.as_deref(),
        date: date.as_deref(),
        last_modified: last_modified.as_deref(),
        etag: etag.as_deref(),
        vary: vary.as_deref(),
        age: age.as_deref(),
    };
    policy_value(if refresh { refreshed(status, &f, now) } else { storable(status, &f, now) })
}
pub(crate) fn fresh_for_ruby(stored_at: f64, max_age: Option<f64>, no_cache: bool, now: f64) -> bool {
    fresh(stored_at, max_age, no_cache, now)
}
pub(crate) fn unrefreshed_for_ruby(name: String) -> bool {
    unrefreshed(&name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_http_date_is_any_of_its_three_forms() {
        assert_eq!(http_date("Sun, 06 Nov 1994 08:49:37 GMT"), Some(784_111_777.0));
        assert_eq!(http_date("Sunday, 06-Nov-94 08:49:37 GMT"), Some(784_111_777.0));
        assert_eq!(http_date("Sun Nov  6 08:49:37 1994"), Some(784_111_777.0));
        assert_eq!(http_date("0"), None);
        assert_eq!(http_date("Sun, 06 Nov 1994 25:49:37 GMT"), None);
    }

    #[test]
    fn a_response_is_stored_as_its_fields_allow() {
        let now = 1_000_000.0;
        let f = |cc| Fields { cache_control: Some(cc), ..Default::default() };
        assert_eq!(storable(200, &f("public, max-age=60, immutable"), now), Some(Policy { max_age: Some(60.0), no_cache: false, immutable: true }));
        assert_eq!(storable(200, &f("no-store, max-age=60"), now), None);
        assert_eq!(storable(200, &f("private, max-age=60"), now), None);
        assert_eq!(storable(201, &f("max-age=60"), now), None);
        // (…the first max-age read, a quoted one too; an ill-formed one stale; s-maxage none of a browser's)
        assert_eq!(storable(200, &f("max-age=60, max-age=5"), now).unwrap().max_age, Some(60.0));
        assert_eq!(storable(200, &f("max-age=\"30\""), now).unwrap().max_age, Some(30.0));
        assert_eq!(storable(200, &Fields { cache_control: Some("max-age=x"), etag: Some("\"e\""), ..Default::default() }, now).unwrap().max_age, Some(0.0));
        assert_eq!(storable(200, &f("s-maxage=60"), now), None);
        // (…a Vary the host cannot honour; nothing to go on)
        assert_eq!(storable(200, &Fields { vary: Some("Accept-Encoding"), ..f("max-age=1") }, now).is_some(), true);
        assert_eq!(storable(200, &Fields { vary: Some("Cookie"), ..f("max-age=1") }, now), None);
        assert_eq!(storable(200, &Fields::default(), now), None);
    }

    #[test]
    fn its_lifetime_is_less_its_age() {
        let now = http_date("Sun, 06 Nov 1994 08:49:37 GMT").unwrap();
        let lifetime = |f: Fields<'_>| storable(200, &f, now).and_then(|p| p.max_age);
        assert_eq!(lifetime(Fields { cache_control: Some("max-age=60"), age: Some("10"), ..Default::default() }), Some(50.0));
        assert_eq!(lifetime(Fields { cache_control: Some("max-age=60"), date: Some("Sun, 06 Nov 1994 08:49:07 GMT"), ..Default::default() }), Some(30.0));
        // (…Expires less Date; an invalid one in the past)
        let expires = Fields { expires: Some("Sun, 06 Nov 1994 08:50:37 GMT"), date: Some("Sun, 06 Nov 1994 08:49:37 GMT"), ..Default::default() };
        assert_eq!(lifetime(expires), Some(60.0));
        assert_eq!(lifetime(Fields { expires: Some("0"), etag: Some("\"e\""), ..Default::default() }), Some(0.0));
        // (…heuristic: a tenth of the time since Last-Modified, at most a day; none for a temporary redirect)
        let modified = Fields { last_modified: Some("Sun, 06 Nov 1994 07:49:37 GMT"), ..Default::default() };
        assert_eq!(lifetime(modified), Some(360.0));
        let old = Fields { last_modified: Some("Sun, 06 Nov 1980 07:49:37 GMT"), ..Default::default() };
        assert_eq!(lifetime(old), Some(HEURISTIC_CAP));
        let redirect = Fields { last_modified: Some("Sun, 06 Nov 1994 07:49:37 GMT"), ..Default::default() };
        assert_eq!(storable(307, &redirect, now).map(|p| p.max_age), Some(None));
    }

    #[test]
    fn a_stored_response_is_fresh_within_its_lifetime() {
        assert!(fresh(100.0, Some(60.0), false, 159.0));
        assert!(!fresh(100.0, Some(60.0), false, 160.0));
        assert!(!fresh(100.0, Some(60.0), true, 101.0));
        assert!(!fresh(100.0, Some(0.0), false, 100.0));
        assert!(!fresh(100.0, None, false, 100.0));
        assert!(unrefreshed("content-length") && unrefreshed("x-csim-status-text") && !unrefreshed("etag"));
    }
}
