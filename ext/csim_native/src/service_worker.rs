// Service Workers' rules for a registration (Service Workers §8): whether a scope is one its script may control — the
// Update algorithm's max scope check, after the script's fetch.

use ada_url::Url;

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
