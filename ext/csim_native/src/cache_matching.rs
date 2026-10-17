// The Cache API's request matching (Service Workers §5.4 "Request Matching", "Query Cache", "Batch Cache Operations"):
// a request matches a cached one by URL — its fragment dropped, its query too where `ignoreSearch` — and, unless
// `ignoreVary`, by every header the cached response's `Vary` names agreeing (`Vary: *` none) — over the entries
// cache_storage.rs stores, and the batch the bindings (cache-storage.js) are about to store.

use std::collections::HashMap;

// A request's URL as a cache key: its fragment dropped, and its query too where `ignore_search` — None for one that is
// no URL.
fn key_url(url: &str, ignore_search: bool) -> Option<String> {
    let mut u = ada_url::Url::parse(url, None).ok()?;
    u.set_hash(None);
    if ignore_search {
        u.set_search(None);
    }
    Some(u.href().to_owned())
}

// A request's and a cached request's headers (names lowercased) agreeing on every field `vary` names — none where it
// names `*`.
fn vary_matches(vary: &str, request: &HashMap<String, String>, cached: &HashMap<String, String>) -> bool {
    let empty = String::new();
    vary.split(',').map(|f| f.trim().to_ascii_lowercase()).filter(|f| !f.is_empty()).all(|f| {
        f != "*" && request.get(&f).unwrap_or(&empty) == cached.get(&f).unwrap_or(&empty)
    })
}

// A cached request: its URL, its headers (names lowercased), its response's `Vary` ('' for none).
pub(crate) struct Entry {
    url: String,
    headers: HashMap<String, String>,
    vary: String,
}
impl Entry {
    pub(crate) fn new(url: String, headers: HashMap<String, String>, vary: String) -> Self {
        Entry { url, headers, vary }
    }
    pub(crate) fn url(&self) -> &str {
        &self.url
    }
    pub(crate) fn headers(&self) -> &HashMap<String, String> {
        &self.headers
    }
}
impl AsRef<Entry> for Entry {
    fn as_ref(&self) -> &Entry {
        self
    }
}

// "Query Cache": the indices of `entries` a request of `url` and `headers` matches, in stored order.
pub(crate) fn query<E: AsRef<Entry>>(url: &str, headers: &HashMap<String, String>, ignore_search: bool, ignore_vary: bool, entries: &[E]) -> Vec<usize> {
    let Some(key) = key_url(url, ignore_search) else { return Vec::new() };
    (0..entries.len())
        .filter(|&i| {
            let e = entries[i].as_ref();
            key_url(&e.url, ignore_search).as_deref() == Some(key.as_str()) && (ignore_vary || e.vary.is_empty() || vary_matches(&e.vary, headers, &e.headers))
        })
        .collect()
}

// Batch Cache Operations' duplicate: two entries of one key URL where either one's request satisfies the other's
// response's `Vary` (each response's decides which headers are compared) — in either order.
pub(crate) fn has_duplicate<E: AsRef<Entry>>(entries: &[E]) -> bool {
    let keys: Vec<Option<String>> = entries.iter().map(|e| key_url(&e.as_ref().url, false)).collect();
    (0..entries.len()).any(|i| {
        (i + 1..entries.len()).any(|j| {
            let (a, b) = (entries[i].as_ref(), entries[j].as_ref());
            keys[i].is_some() && keys[i] == keys[j]
                && ((b.vary.is_empty() || vary_matches(&b.vary, &a.headers, &b.headers)) || (a.vary.is_empty() || vary_matches(&a.vary, &b.headers, &a.headers)))
        })
    })
}

// Whether a `Vary` names `*`: a response no cache may hold.
pub(crate) fn vary_has_star(vary: &str) -> bool {
    vary.split(',').any(|f| f.trim() == "*")
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "varyHasStar", vary_star_op, context_id);
}
fn text(scope: &mut v8::PinScope<'_, '_>, value: Option<v8::Local<'_, v8::Value>>) -> String {
    value.filter(|v| !v.is_null_or_undefined()).map(|v| v.to_rust_string_lossy(scope)).unwrap_or_default()
}
// Headers from a flat `[name, value, …]` array.
pub(crate) fn headers(scope: &mut v8::PinScope<'_, '_>, value: v8::Local<'_, v8::Value>) -> HashMap<String, String> {
    let Ok(list) = v8::Local::<v8::Array>::try_from(value) else { return HashMap::new() };
    let mut out = HashMap::new();
    let mut k = 0;
    while k + 1 < list.length() {
        let name = text(scope, list.get_index(scope, k));
        let value = text(scope, list.get_index(scope, k + 1));
        out.insert(name, value);
        k += 2;
    }
    out
}
// __dom.varyHasStar(vary) -> `vary_has_star`.
fn vary_star_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let vary = args.get(0).to_rust_string_lossy(scope);
    rv.set_bool(vary_has_star(&vary));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(url: &str, h: &[(&str, &str)], vary: &str) -> Entry {
        Entry { url: url.into(), headers: h.iter().map(|&(k, v)| (k.into(), v.into())).collect(), vary: vary.into() }
    }

    #[test]
    fn requests_match_as_the_cache_api_says() {
        let list = [entry("http://a/x?q#f", &[("accept", "a")], "Accept"), entry("http://a/x", &[], ""), entry("http://a/y", &[], "*")];
        let accept: HashMap<String, String> = [("accept".to_owned(), "a".to_owned())].into();
        assert_eq!(query("http://a/x?q", &accept, false, false, &list), [0]);
        assert_eq!(query("http://a/x", &HashMap::new(), true, false, &list), [1]);
        assert_eq!(query("http://a/x", &HashMap::new(), true, true, &list), [0, 1]);
        assert!(query("http://a/y", &HashMap::new(), false, false, &list).is_empty());
        assert!(has_duplicate(&[entry("http://a/x#1", &[], ""), entry("http://a/x#2", &[], "")]));
        assert!(!has_duplicate(&[entry("http://a/x", &[("accept", "a")], "accept"), entry("http://a/x", &[("accept", "b")], "accept")]));
        assert!(vary_has_star("Accept, *") && !vary_has_star("Accept"));
    }
}
