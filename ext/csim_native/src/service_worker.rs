// Service Workers' rules for a registration (Service Workers §8): the URLs a register() names (Start Register), and
// whether a scope is one its script may control — the Update algorithm's max scope check, after the script's fetch.

use ada_url::Url;

// Start Register: a register()'s script URL and scope (none: the script's directory), parsed against `base`, their
// fragments dropped — or the error it rejects with, `[name, message]`: a TypeError for a URL that does not parse, one
// whose scheme is not HTTP(S) or whose path holds an encoded slash or backslash (checked before origins: a data: scope is
// a TypeError, not a SecurityError — registration-scope), a SecurityError for one not of the client's `origin` (which,
// opaque, no URL's is).
pub(crate) fn start_register(script: &str, scope: Option<&str>, base: &str, origin: &str) -> Result<(String, String), (&'static str, &'static str)> {
    const INVALID: &str = "Failed to register a ServiceWorker: An invalid URL was provided.";
    let parse = |input: &str, base: &str| {
        let mut url = Url::parse(input, Some(base)).map_err(|_| ("TypeError", INVALID))?;
        url.set_hash(None);
        Ok::<Url, (&'static str, &'static str)>(url)
    };
    let script_url = parse(script, base)?;
    let scope_url = parse(scope.unwrap_or("./"), if scope.is_some() { base } else { script_url.href() })?;
    for url in [&script_url, &scope_url] {
        if !matches!(url.protocol(), "http:" | "https:") {
            return Err(("TypeError", "Failed to register a ServiceWorker: The URL protocol of the current origin is not supported."));
        }
        let path = url.pathname().to_ascii_lowercase();
        if path.contains("%2f") || path.contains("%5c") {
            return Err(("TypeError", "Failed to register a ServiceWorker: The provided URL contains a URL-encoded slash or backslash."));
        }
    }
    if script_url.origin() != origin || origin == "null" {
        return Err(("SecurityError", "The origin of the provided scriptURL does not match the current origin"));
    }
    if scope_url.origin() != origin {
        return Err(("SecurityError", "The origin of the provided scope does not match the current origin"));
    }
    Ok((script_url.href().to_owned(), scope_url.href().to_owned()))
}
// …for the host: `["ok", script URL, scope]`, or `[error name, message]`.
pub(crate) fn start_register_for_ruby(script: String, scope: Option<String>, base: String, origin: String) -> Vec<String> {
    match start_register(&script, scope.as_deref(), &base, &origin) {
        Ok((script, scope)) => vec!["ok".to_owned(), script, scope],
        Err((name, message)) => vec![name.to_owned(), message.to_owned()],
    }
}

// The Update algorithm's max scope: the script's directory, or — given a `Service-Worker-Allowed` header — the path the
// header names against the script's URL, where that is of the script's origin (one of another none at all); the scope
// allowed where its path starts with it.
pub(crate) fn scope_allowed(scope: &str, script: &str, service_worker_allowed: Option<&str>) -> bool {
    let (Ok(scope), Ok(script_url)) = (Url::parse(scope, None), Url::parse(script, None)) else { return false };
    let max = match service_worker_allowed {
        None => Url::parse("./", Some(script)).ok(),
        Some(allowed) => Url::parse(allowed, Some(script)).ok().filter(|u| u.origin() == script_url.origin()),
    };
    max.is_some_and(|max| scope.pathname().starts_with(max.pathname()))
}

// Fetch "get, decode, and split" a header's combined value: its values split at commas outside a quoted string (a quote's
// backslash escaping the next character), each trimmed of HTTP tabs and spaces.
fn split_values(value: &str) -> Vec<String> {
    let (mut values, mut current, mut quoted, mut escaped) = (Vec::new(), String::new(), false, false);
    for c in value.chars() {
        match c {
            _ if escaped => escaped = false,
            '\\' if quoted => escaped = true,
            '"' => quoted = !quoted,
            ',' if !quoted => {
                values.push(std::mem::take(&mut current));
                continue;
            }
            _ => {}
        }
        current.push(c);
    }
    values.push(current);
    values.into_iter().map(|v| v.trim_matches(['\t', ' ']).to_owned()).collect()
}

// …for the host, which fetches the script: "ok", "scope" (a SecurityError) — or "network" where the header is more than
// one value ("extracting header list values" fails: a network error). `service_worker_allowed` the combined value.
pub(crate) fn max_scope_for_ruby(scope: String, script: String, service_worker_allowed: Option<String>) -> &'static str {
    let values = service_worker_allowed.as_deref().map(split_values);
    if values.as_ref().is_some_and(|v| v.len() > 1) {
        return "network";
    }
    let allowed = values.as_ref().and_then(|v| v.first()).map(String::as_str);
    if scope_allowed(&scope, &script, allowed) { "ok" } else { "scope" }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn starts_a_register_from_its_urls() {
        let base = "https://a.test/dir/page.html";
        let origin = "https://a.test";
        assert_eq!(
            start_register("sw.js#x", None, base, origin),
            Ok(("https://a.test/dir/sw.js".into(), "https://a.test/dir/".into()))
        );
        assert_eq!(start_register("sw.js", Some("/s#f"), base, origin), Ok(("https://a.test/dir/sw.js".into(), "https://a.test/s".into())));
        assert_eq!(start_register("sw.js", Some("data:,x"), base, origin).unwrap_err().0, "TypeError");
        assert_eq!(start_register("a%2Fb.js", None, base, origin).unwrap_err().0, "TypeError");
        assert_eq!(start_register("https://b.test/sw.js", None, base, origin).unwrap_err().0, "SecurityError");
        assert_eq!(start_register("sw.js", Some("https://b.test/"), base, origin).unwrap_err().0, "SecurityError");
        assert_eq!(start_register("sw.js", None, base, "null").unwrap_err().0, "SecurityError");
        assert_eq!(start_register("http://[", None, base, origin).unwrap_err().0, "TypeError");
    }

    #[test]
    fn a_scope_within_its_max_scope() {
        let script = "https://a.test/w/resources/sw.js?x";
        assert!(scope_allowed("https://a.test/w/resources/sub/", script, None));
        assert!(!scope_allowed("https://a.test/w/", script, None));
        assert!(scope_allowed("https://a.test/allowed-path", script, Some("/allowed-path")));
        assert!(!scope_allowed("https://a.test/disallowed-path", script, Some("../allowed-path")));
        assert!(scope_allowed("https://a.test/w/allowed-path-with-parent", script, Some("../allowed-path-with-parent")));
        assert!(!scope_allowed("https://a.test/w/resources/x", script, Some("https://b.test/")));
        assert_eq!(split_values("/a, \"/b,c\" ,/d"), ["/a", "\"/b,c\"", "/d"]);
        assert_eq!(max_scope_for_ruby("https://a.test/".into(), script.into(), Some("/x, /".into())), "network");
        assert_eq!(max_scope_for_ruby("https://a.test/".into(), script.into(), Some("/".into())), "ok");
        assert_eq!(max_scope_for_ruby("https://a.test/".into(), script.into(), None), "scope");
    }
}
