// The HTTP cache (RFC 9111) of the host's fetches: its policy — whether a response may be stored and for how long it is
// fresh, and what a 304 that revalidates a stored one makes of it — and its store (`HttpCache`), the responses it keeps.
// A private cache's view — this is a browser's — but for `private`, which this cache, shared across the test sessions of
// a process, does not store.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, RwLock};

use magnus::value::Opaque;
use magnus::{gc, prelude::*, DataTypeFunctions, Error, RArray, RHash, RString, Ruby, TypedData, Value};

use crate::civil::{civil_from_days, days_from_civil};

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
// forms a recipient must accept — robustly, as the section encourages: the weekday unread, the month and zone in any case,
// the whitespace between fields any run of it. Its year four digits (RFC 850's two, read as the most recent year with
// them not more than 50 years past `now`, as the section requires); its clock two digits each. None for anything else.
pub(crate) fn http_date(value: &str, now: f64) -> Option<f64> {
    let parts: Vec<&str> = value.split_ascii_whitespace().collect();
    let digits = |s: &str, n: std::ops::RangeInclusive<usize>| (n.contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit())).then(|| s.parse::<i64>().ok()).flatten();
    let month = |m: &str| ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].iter().position(|n| n.eq_ignore_ascii_case(m)).map(|i| i as i64 + 1);
    let clock = |t: &str| -> Option<i64> {
        let mut it = t.split(':').map(|n| digits(n, 2..=2));
        let (h, m, s) = (it.next()??, it.next()??, it.next()??);
        (it.next().is_none() && h < 24 && m < 60 && s < 61).then_some(h * 3600 + m * 60 + s)
    };
    let gmt = |z: &str| z.eq_ignore_ascii_case("GMT");
    let (year, mon, day, time) = match parts.as_slice() {
        // Sun, 06 Nov 1994 08:49:37 GMT
        [_, d, m, y, t, z] if gmt(z) => (digits(y, 4..=4)?, month(m)?, digits(d, 1..=2)?, clock(t)?),
        // Sunday, 06-Nov-94 08:49:37 GMT
        [_, dmy, t, z] if gmt(z) => {
            let mut it = dmy.split('-');
            let (d, m, y) = (it.next()?, it.next()?, it.next()?);
            if it.next().is_some() {
                return None;
            }
            let (mon, day, time) = (month(m)?, digits(d, 1..=2)?, clock(t)?);
            // (…in this century, else the last: a timestamp more than 50 years ahead of now is the one 100 years before)
            let (today, secs) = ((now / 86_400.0).floor() as i64, now.rem_euclid(86_400.0) as i64);
            let (this_year, this_month, this_day) = civil_from_days(today);
            let limit = days_from_civil(this_year + 50, this_month, this_day) * 86_400 + secs;
            let year = this_year - this_year.rem_euclid(100) + digits(y, 2..=2)?;
            let year = if days_from_civil(year, mon, day) * 86_400 + time > limit { year - 100 } else { year };
            (year, mon, day, time)
        }
        // Sun Nov  6 08:49:37 1994
        [_, m, d, t, y] => (digits(y, 4..=4)?, month(m)?, digits(d, 1..=2)?, clock(t)?),
        _ => return None,
    };
    if !(1..=31).contains(&day) {
        return None;
    }
    Some((days_from_civil(year, mon, day) * 86_400 + time) as f64)
}
// §4.2.1 the freshness lifetime — max-age, else Expires less Date (an invalid Expires, "0" the common one, in the past:
// §5.3), else, for a status heuristically cacheable, a tenth of the time since Last-Modified — less §4.2.3's age the
// response had when it came (`now`): the greater of how long it was since its Date and its Age.
fn lifetime(d: &Directives, f: &Fields<'_>, heuristic: bool, now: f64) -> Option<f64> {
    let date = f.date.and_then(|d| http_date(d, now));
    let explicit = d.max_age.or_else(|| f.expires.map(|e| http_date(e, now).map_or(0.0, |exp| (exp - date.unwrap_or(now)).clamp(0.0, DELTA_SECONDS_MAX))));
    let lifetime = explicit.or_else(|| {
        let modified = f.last_modified.and_then(|m| http_date(m, now))?;
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

// — the store —

// The fields a stored response's policy reads, by name (`Fields`).
const POLICY_FIELDS: [&str; 7] = ["cache-control", "expires", "date", "last-modified", "etag", "vary", "age"];
// The responses it keeps at most: a long app suite mints fresh content-addressed URLs per example (Discourse's per-test
// themes and colour schemes), and an immutable one outlives every reset, so a full store starts again empty.
const MAX_ENTRIES: usize = 4096;

// A stored response's header fields — each name lowercased, its field lines combined as one value (`combine`) — and what
// it is kept with: when it was stored, the policy its fields give (`Policy`).
struct Kept {
    headers: Vec<(String, Vec<u8>)>,
    stored_at: f64,
    policy: Policy,
}

impl Kept {
    fn field(&self, name: &str) -> Option<&[u8]> {
        self.headers.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_slice())
    }
    // …the fields its policy reads.
    fn policy_of(headers: &[(String, Vec<u8>)], rule: impl FnOnce(&Fields<'_>) -> Option<Policy>) -> Option<Policy> {
        let [cache_control, expires, date, last_modified, etag, vary, age] =
            POLICY_FIELDS.map(|name| headers.iter().find(|(k, _)| k == name).map(|(_, v)| String::from_utf8_lossy(v).into_owned()));
        rule(&Fields {
            cache_control: cache_control.as_deref(),
            expires: expires.as_deref(),
            date: date.as_deref(),
            last_modified: last_modified.as_deref(),
            etag: etag.as_deref(),
            vary: vary.as_deref(),
            age: age.as_deref(),
        })
    }
}

// A stored response: its status, its body — decoded, as the page reads it: the String the host stored, frozen, which
// every hit is handed (a multi-MB bundle copied per hit cost the GC more than the fetch; marked by whatever holds it) —
// the size that body had on the wire (what a hit's Resource Timing entry reports as `encodedBodySize`), and what it is
// kept with, which a 304 replaces whole (`refresh`) so a thread reading it reads one of them.
struct Stored {
    status: u32,
    body: Opaque<RString>,
    encoded: Option<u64>,
    kept: RwLock<Arc<Kept>>,
}

impl Stored {
    fn kept(&self) -> Arc<Kept> {
        self.kept.read().unwrap_or_else(PoisonError::into_inner).clone()
    }
}

// A header value as one: each of its fields — a Rack 3 app may give an Array of them — without the HTTP whitespace
// around it, as an HTTP stack reads a field (Chrome and Firefox: ` 5 ` is `5`), combined with ", " as an HTTP response's
// header list combines them — as bytes, whatever encoding each is tagged with; None for none.
pub(crate) fn combine(value: Value) -> Result<Option<Vec<u8>>, Error> {
    if value.is_nil() {
        return Ok(None);
    }
    let fields: Vec<Value> = match RArray::from_value(value) {
        Some(list) => list.into_iter().collect(),
        None => vec![value],
    };
    let mut out = Vec::new();
    for (i, field) in fields.into_iter().enumerate() {
        if i > 0 {
            out.extend_from_slice(b", ");
        }
        let text: RString = field.funcall("to_s", ())?;
        let bytes = crate::fetch_rules::ruby_bytes(text);
        let start = bytes.iter().position(|b| !matches!(b, b'\t' | b' ')).unwrap_or(bytes.len());
        let end = bytes.iter().rposition(|b| !matches!(b, b'\t' | b' ')).map_or(start, |i| i + 1);
        out.extend_from_slice(&bytes[start..end]);
    }
    Ok(Some(out))
}
// Native.combined_field(value) -> `combine`'s, a binary String (nil for none).
pub(crate) fn combined_field_for_ruby(ruby: &Ruby, value: Value) -> Result<Option<RString>, Error> {
    Ok(combine(value)?.map(|v| ruby.str_from_slice(&v)))
}

// A header map's fields, by `combine`, each name lowercased (a Rack 2 app's may be mixed-case).
fn header_fields(headers: RHash) -> Result<Vec<(String, Vec<u8>)>, Error> {
    let mut out: Vec<(String, Vec<u8>)> = Vec::new();
    headers.foreach(|k: Value, v: Value| {
        if let Some(value) = combine(v)? {
            // (…a name's bytes lowercased as an HTTP token's are, ASCII alone — whatever else it holds kept)
            let name = String::from_utf8_lossy(&crate::fetch_rules::ruby_bytes(k.funcall("to_s", ())?)).to_ascii_lowercase();
            match out.iter_mut().find(|(n, _)| *n == name) {
                Some(slot) => slot.1 = value,
                None => out.push((name, value)),
            }
        }
        Ok(magnus::r_hash::ForEach::Continue)
    })?;
    Ok(out)
}

fn now() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0.0, |d| d.as_secs_f64())
}

// The host's HTTP cache: the responses `rack_fetch` stored, by URL (its bytes) — process-wide, GET-only, shared by every
// thread that fetches (an image load, a keepalive fetch, the page's own). No Ruby code runs while its lock is held, so the
// GC that marks the bodies (which runs on the thread holding the GVL) never waits on it.
#[derive(TypedData)]
#[magnus(class = "Capybara::Simulated::Native::HttpCache", free_immediately, mark)]
pub(crate) struct HttpCache {
    entries: Mutex<HashMap<Vec<u8>, Arc<Stored>>>,
}

impl DataTypeFunctions for HttpCache {
    fn mark(&self, marker: &gc::Marker) {
        for stored in self.lock().values() {
            marker.mark(stored.body);
        }
    }
}

// One of its stored responses, as the host has it from a `lookup`: the one it was then, a later `store` of its URL
// another — a `refresh` of it this one's. (…its body marked by it too, which outlives the cache's dropping it)
#[derive(TypedData)]
#[magnus(class = "Capybara::Simulated::Native::HttpCache::Entry", free_immediately, mark)]
pub(crate) struct Entry(Arc<Stored>);

impl DataTypeFunctions for Entry {
    fn mark(&self, marker: &gc::Marker) {
        marker.mark(self.0.body);
    }
}

impl HttpCache {
    fn new() -> Self {
        HttpCache { entries: Mutex::default() }
    }
    fn lock(&self) -> MutexGuard<'_, HashMap<Vec<u8>, Arc<Stored>>> {
        self.entries.lock().unwrap_or_else(PoisonError::into_inner)
    }
    // #lookup(url) -> its stored response, or nil.
    fn lookup(&self, url: RString) -> Option<Entry> {
        let url = crate::fetch_rules::ruby_bytes(url);
        self.lock().get(&url).cloned().map(Entry)
    }
    // #clear: every response gone.
    fn clear(&self) {
        self.lock().clear();
    }
    // #clear_volatile: a test's reset — the responses marked `immutable` kept (declared not to change for their
    // freshness lifetime, so a kept one cannot shadow a later test's response, as a browser keeps them across
    // navigations), every other dropped, so test-local server state reaches the app on the next visit.
    fn clear_volatile(&self) {
        self.lock().retain(|_, e| e.kept().policy.immutable);
    }
    // #store(url, status, headers, body, encoded) -> whether it was stored: the response `rack_fetch` got for `url`, its
    // cookies not kept (they were set as it came, and a replay is no response that sets them), where its fields allow it
    // (`storable`); `encoded` its body's size on the wire.
    fn store(&self, url: RString, status: u32, headers: RHash, body: RString, encoded: Option<u64>) -> Result<bool, Error> {
        let url = crate::fetch_rules::ruby_bytes(url);
        let mut headers = header_fields(headers)?;
        headers.retain(|(k, _)| k != "set-cookie");
        let stored_at = now();
        let Some(policy) = Kept::policy_of(&headers, |f| storable(status, f, stored_at)) else { return Ok(false) };
        let stored = Stored {
            status,
            body: RString::new_frozen(body).into(),
            encoded,
            kept: RwLock::new(Arc::new(Kept { headers, stored_at, policy })),
        };
        let mut entries = self.lock();
        if entries.len() >= MAX_ENTRIES && !entries.contains_key(&url) {
            entries.clear();
        }
        entries.insert(url, Arc::new(stored));
        Ok(true)
    }
    // #refresh(url, entry, headers): RFC 9111 §4.3.4 — a 304 that revalidates the response stored for `url`
    // refreshes it without replacing its body: its header fields updated with the ones the 304 carries — a rotated ETag
    // or Last-Modified what the next revalidation sends — but for those it does not update (`unrefreshed`), and its
    // freshness, no-cache and immutability read again off the fields as they now are (a bare 304 keeps the stored
    // Cache-Control, a new Date shortens an Expires). Where they now forbid storing it — `no-store`, `private`, a Vary it
    // cannot honour — it is dropped, though this request is still answered from it.
    // (…the 304's fields read before the entry is locked, so two refreshing it at once each merge into the other's)
    fn refresh(&self, url: RString, entry: &Entry, headers: RHash) -> Result<(), Error> {
        let url = crate::fetch_rules::ruby_bytes(url);
        let fresh_fields = header_fields(headers)?;
        let dropped = {
            let mut kept = entry.0.kept.write().unwrap_or_else(PoisonError::into_inner);
            let mut merged = kept.headers.clone();
            for (name, value) in fresh_fields {
                if unrefreshed(&name) {
                    continue;
                }
                match merged.iter_mut().find(|(n, _)| *n == name) {
                    Some(slot) => slot.1 = value,
                    None => merged.push((name, value)),
                }
            }
            let stored_at = now();
            let policy = Kept::policy_of(&merged, |f| refreshed(entry.0.status, f, stored_at));
            let dropped = policy.is_none();
            let policy = policy.unwrap_or(Policy { max_age: None, no_cache: false, immutable: false });
            *kept = Arc::new(Kept { headers: merged, stored_at, policy });
            dropped
        };
        if dropped {
            let mut entries = self.lock();
            if entries.get(&url).is_some_and(|e| Arc::ptr_eq(e, &entry.0)) {
                entries.remove(&url);
            }
        }
        Ok(())
    }
}

impl Entry {
    // #status / #encoded / #body: its status, its body's size on the wire (nil, its size), its body.
    fn status(&self) -> u32 {
        self.0.status
    }
    fn encoded(&self) -> Option<u64> {
        self.0.encoded
    }
    fn body(ruby: &Ruby, rb_self: &Self) -> RString {
        ruby.get_inner(rb_self.0.body)
    }
    // #headers -> its header fields as they stand, a Hash of lowercase name => binary String.
    fn headers(ruby: &Ruby, rb_self: &Self) -> Result<RHash, Error> {
        let kept = rb_self.0.kept();
        let hash = ruby.hash_new_capa(kept.headers.len());
        for (name, value) in &kept.headers {
            hash.aset(name.as_str(), ruby.str_from_slice(value))?;
        }
        Ok(hash)
    }
    // #fresh?(now = the time) -> whether it is fresh then (`fresh`): `now` a Time.
    fn is_fresh(&self, args: &[Value]) -> Result<bool, Error> {
        let args = magnus::scan_args::scan_args::<(), (Option<Value>,), (), (), (), ()>(args)?;
        let at = match args.optional.0 {
            Some(time) => time.funcall::<_, _, f64>("to_f", ())?,
            None => now(),
        };
        let kept = self.0.kept();
        Ok(fresh(kept.stored_at, kept.policy.max_age, kept.policy.no_cache, at))
    }
    // #no_cache? -> whether every use revalidates it.
    fn no_cache(&self) -> bool {
        self.0.kept().policy.no_cache
    }
    // #fresh_until -> the time (seconds since the epoch) it stays fresh until — nil for one with no lifetime, or stale.
    fn fresh_until(&self) -> Option<f64> {
        let kept = self.0.kept();
        let max_age = kept.policy.max_age?;
        fresh(kept.stored_at, Some(max_age), kept.policy.no_cache, now()).then(|| kept.stored_at + max_age)
    }
    // #revalidation_headers -> the conditional request header fields a revalidation of it sends: its validators.
    fn revalidation_headers(ruby: &Ruby, rb_self: &Self) -> Result<RHash, Error> {
        let kept = rb_self.0.kept();
        let hash = ruby.hash_new();
        for (field, header) in [("etag", "If-None-Match"), ("last-modified", "If-Modified-Since")] {
            if let Some(v) = kept.field(field) {
                hash.aset(header, ruby.str_from_slice(v))?;
            }
        }
        Ok(hash)
    }
}

pub(crate) fn define(native: magnus::RModule, ruby: &Ruby) -> Result<(), Error> {
    use magnus::{function, method, Module, Object};
    native.define_module_function("combined_field", function!(combined_field_for_ruby, 1))?;
    let class = native.define_class("HttpCache", ruby.class_object())?;
    class.define_singleton_method("new", function!(HttpCache::new, 0))?;
    class.define_method("lookup", method!(HttpCache::lookup, 1))?;
    class.define_method("clear", method!(HttpCache::clear, 0))?;
    class.define_method("clear_volatile", method!(HttpCache::clear_volatile, 0))?;
    class.define_method("store", method!(HttpCache::store, 5))?;
    class.define_method("refresh", method!(HttpCache::refresh, 3))?;
    let entry = class.define_class("Entry", ruby.class_object())?;
    entry.define_method("status", method!(Entry::status, 0))?;
    entry.define_method("encoded", method!(Entry::encoded, 0))?;
    entry.define_method("body", method!(Entry::body, 0))?;
    entry.define_method("headers", method!(Entry::headers, 0))?;
    entry.define_method("fresh?", method!(Entry::is_fresh, -1))?;
    entry.define_method("no_cache?", method!(Entry::no_cache, 0))?;
    entry.define_method("fresh_until", method!(Entry::fresh_until, 0))?;
    entry.define_method("revalidation_headers", method!(Entry::revalidation_headers, 0))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // (…2026-10-29, a "now" for the dates read against it)
    const NOW: f64 = 1_793_232_000.0;

    #[test]
    fn an_http_date_is_any_of_its_three_forms() {
        assert_eq!(http_date("Sun, 06 Nov 1994 08:49:37 GMT", NOW), Some(784_111_777.0));
        assert_eq!(http_date("Sunday, 06-Nov-94 08:49:37 GMT", NOW), Some(784_111_777.0));
        assert_eq!(http_date("Sun Nov  6 08:49:37 1994", NOW), Some(784_111_777.0));
        // (…read robustly: the zone and month in any case, a one-digit day, the weekday unread)
        assert_eq!(http_date("sun, 6 nov 1994 08:49:37 gmt", NOW), Some(784_111_777.0));
        assert_eq!(http_date("0", NOW), None);
        assert_eq!(http_date("Sun, 06 Nov 1994 25:49:37 GMT", NOW), None);
        assert_eq!(http_date("Sun, 06 Nov 1994 +8:49:37 GMT", NOW), None);
        // (…a year of four digits alone: one too great to hold no date, not a wrapped one)
        assert_eq!(http_date("Sun Nov  6 08:49:37 -99999999999999999", NOW), None);
        assert_eq!(http_date("Sun, 06 Nov 99999 08:49:37 GMT", NOW), None);
    }

    #[test]
    fn a_two_digit_year_is_the_latest_not_more_than_fifty_years_ahead() {
        let year = |date: &str| http_date(&format!("Thursday, {date} 00:00:00 GMT"), NOW).map(|t| civil_from_days((t / 86_400.0) as i64).0);
        assert_eq!(year("01-Jan-26"), Some(2026));
        assert_eq!(year("01-Jan-76"), Some(2076));
        assert_eq!(year("01-Jan-77"), Some(1977));
        assert_eq!(year("01-Jan-70"), Some(2070));
        // (…the timestamp measured, not its year: the last day of the fiftieth year ahead is past the limit)
        assert_eq!(year("29-Oct-76"), Some(2076));
        assert_eq!(year("30-Oct-76"), Some(1976));
        assert_eq!(year("31-Dec-76"), Some(1976));
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
        let now = http_date("Sun, 06 Nov 1994 08:49:37 GMT", NOW).unwrap();
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
    fn a_refreshed_response_keeps_what_its_fields_now_allow() {
        let now = 1_000_000.0;
        // (…no cacheable status or validator asked of it; no-cache kept; forbidden now, dropped)
        let no_cache = Fields { cache_control: Some("no-cache"), ..Default::default() };
        assert_eq!(refreshed(201, &no_cache, now), Some(Policy { max_age: None, no_cache: true, immutable: false }));
        assert_eq!(refreshed(200, &Fields { cache_control: Some("no-store"), ..Default::default() }, now), None);
        // (…an empty Vary varies on nothing; an Expires with no Date against the clock, at most 2^31 seconds)
        assert!(storable(200, &Fields { vary: Some(""), cache_control: Some("max-age=1"), ..Default::default() }, now).is_some());
        let until = |e, now| storable(200, &Fields { expires: Some(e), ..Default::default() }, now).and_then(|p| p.max_age);
        assert_eq!(until("Thu, 01 Jan 1970 00:16:50 GMT", 1000.0), Some(10.0));
        assert_eq!(until("Thu, 01 Jan 1970 00:16:50 GMT", 2000.0), Some(0.0));
        assert_eq!(until("Fri, 31 Dec 9999 23:59:59 GMT", 1000.0), Some(DELTA_SECONDS_MAX));
        // (…a heuristic lifetime from Date where there is one, else from the clock)
        let dated = Fields { last_modified: Some("Thu, 01 Jan 1970 00:00:00 GMT"), date: Some("Thu, 01 Jan 1970 00:16:40 GMT"), ..Default::default() };
        assert_eq!(storable(200, &dated, 1000.0).and_then(|p| p.max_age), Some(100.0));
        let undated = Fields { last_modified: Some("Thu, 01 Jan 1970 00:00:00 GMT"), ..Default::default() };
        assert_eq!(storable(200, &undated, 2000.0).and_then(|p| p.max_age), Some(200.0));
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
