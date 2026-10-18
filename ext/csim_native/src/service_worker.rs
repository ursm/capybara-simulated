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

// …for the host, which fetches the script: "ok", "scope" (a SecurityError) — or "network" where the header is more than
// one value ("extracting header list values" fails: a network error). `service_worker_allowed` the combined value.
pub(crate) fn max_scope_for_ruby(scope: String, script: String, service_worker_allowed: Option<String>) -> &'static str {
    let values = service_worker_allowed.as_deref().map(crate::headers::decode_split);
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
        assert_eq!(crate::headers::decode_split("/a, \"/b,c\" ,/d"), ["/a", "\"/b,c\"", "/d"]);
        assert_eq!(max_scope_for_ruby("https://a.test/".into(), script.into(), Some("/x, /".into())), "network");
        assert_eq!(max_scope_for_ruby("https://a.test/".into(), script.into(), Some("/".into())), "ok");
        assert_eq!(max_scope_for_ruby("https://a.test/".into(), script.into(), None), "scope");
    }
}

// Whether `clients.claim()` of the registration at `scope` claims a client whose URL is `href` (Service Workers §4.3.4):
// the client's in that scope — its URL starts with it — and that is its LONGEST matching registration: where a strictly
// longer one of `scopes`, the origin's registrations, covers it too, a more specific worker controls it, not the claiming
// one (claim-not-using-registration).
pub(crate) fn claims(href: &str, scope: &str, scopes: &[String]) -> bool {
    !scope.is_empty() && href.starts_with(scope) && !scopes.iter().any(|s| s.len() > scope.len() && href.starts_with(s.as_str()))
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "swClaims", claims_op, context_id);
}

// __dom.swClaims(href, scope, scopes) -> `claims`.
fn claims_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let href = args.get(0).to_rust_string_lossy(scope);
    let claiming = args.get(1).to_rust_string_lossy(scope);
    let mut scopes = Vec::new();
    if let Ok(list) = v8::Local::<v8::Array>::try_from(args.get(2)) {
        for i in 0..list.length() {
            if let Some(s) = list.get_index(scope, i) {
                scopes.push(s.to_rust_string_lossy(scope));
            }
        }
    }
    rv.set_bool(claims(&href, &claiming, &scopes));
}
