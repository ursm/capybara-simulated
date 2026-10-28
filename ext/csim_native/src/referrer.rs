// What a request tells the server of where it came from: its `Referer` (Referrer Policy §8.3 "determine request's
// referrer"), its `Origin` (Fetch "append a request `Origin` header") and its `Sec-Fetch-Site` (Fetch Metadata §2.4),
// each from its referrer source or initiator, its referrer policy and the URL it is at — and, over a redirect chain,
// the widest `Sec-Fetch-Site` any hop has had and whether its origin has become opaque (Fetch "HTTP-redirect fetch"
// step 13). The host sends what these answer.

use crate::url_ops::{potentially_trustworthy_url, DEFAULT_POLICY, POLICIES};

// A referrer URL longer than this goes as its origin (Referrer Policy §8.3 step 6).
const MAX_REFERRER_LENGTH: usize = 4096;

// `policy` where it is a referrer policy, else the default one — the policy of a request whose policy container names
// none, as the empty one is.
fn policy_or_default(policy: &str) -> &str {
    if POLICIES.contains(&policy) { policy } else { DEFAULT_POLICY }
}

// The origin of `url` where it is an http(s) one — the origins these rules compare — None for any other.
fn http_origin(url: &str) -> Option<String> {
    let url = ada_url::Url::parse(url, None).ok()?;
    matches!(url.protocol(), "http:" | "https:").then(|| url.origin())
}

// Referrer Policy §8.4 "strip url for use as a referrer": none for a URL of a local scheme (about:, blob:, data:) or no
// URL at all, else the URL with no credentials and no fragment — and, `origin_only`, no path and no query either.
fn stripped(url: &ada_url::Url, origin_only: bool) -> Option<String> {
    if matches!(url.protocol(), "about:" | "blob:" | "data:") {
        return None;
    }
    let mut url = url.clone();
    url.set_username(Some("")).ok()?;
    url.set_password(Some("")).ok()?;
    url.set_hash(None);
    if origin_only {
        url.set_pathname(Some("")).ok()?;
        url.set_search(None);
    }
    Some(url.href().to_owned())
}

// `url` as a referrer (`stripped`), none for none.
pub(crate) fn referrer_url(url: &str) -> Option<String> {
    stripped(&ada_url::Url::parse(url, None).ok()?, false)
}

// The `Referer` a request to `target` whose referrer source is `source` sends under referrer policy `policy` (an empty
// or unknown one the default) — Referrer Policy §8.3 "determine request's referrer" steps 4-8 — None for none: a
// downgrade being one from a potentially trustworthy URL to one that is not (Secure Contexts §3.2), not https to http.
pub(crate) fn request_referrer(policy: &str, source: &str, target: &str) -> Option<String> {
    let source = ada_url::Url::parse(source, None).ok()?;
    let mut full = stripped(&source, false)?;
    let origin = stripped(&source, true)?;
    if full.len() > MAX_REFERRER_LENGTH {
        full.clone_from(&origin);
    }
    let policy = policy_or_default(policy);
    match policy {
        "no-referrer" => return None,
        "origin" => return Some(origin),
        "unsafe-url" => return Some(full),
        _ => {}
    }
    let target = ada_url::Url::parse(target, None).ok()?;
    let same_origin = source.origin() == target.origin() && source.origin() != "null";
    let downgrade = potentially_trustworthy_url(source.href()) && !potentially_trustworthy_url(target.href());
    match policy {
        "strict-origin" => (!downgrade).then_some(origin),
        "strict-origin-when-cross-origin" if same_origin => Some(full),
        "strict-origin-when-cross-origin" => (!downgrade).then_some(origin),
        "same-origin" => same_origin.then_some(full),
        "origin-when-cross-origin" => Some(if same_origin { full } else { origin }),
        // (…no-referrer-when-downgrade)
        _ => (!downgrade).then_some(full),
    }
}
pub(crate) fn request_referrer_for_ruby(policy: Option<String>, source: Option<String>, target: Option<String>) -> Option<String> {
    request_referrer(policy.as_deref().unwrap_or(""), source.as_deref()?, target.as_deref().unwrap_or(""))
}
pub(crate) fn referrer_url_for_ruby(url: Option<String>) -> Option<String> {
    referrer_url(url.as_deref()?)
}

// The `Origin` a request of serialized origin `origin` ('null' an opaque one) to `target` sends: as it is in mode
// `cors` (`cors`), else 'null' where its referrer policy `policy` would withhold its origin from `target` — a downgrade
// here being https to anything else, as Fetch's step says.
pub(crate) fn origin_header<'a>(origin: &'a str, policy: &str, target: &str, cors: bool) -> &'a str {
    if cors || origin == "null" {
        return origin;
    }
    let withheld = match policy_or_default(policy) {
        "no-referrer" => true,
        "no-referrer-when-downgrade" | "strict-origin" | "strict-origin-when-cross-origin" => {
            origin.starts_with("https:") && !target.starts_with("https:")
        }
        "same-origin" => http_origin(target).as_deref() != Some(origin),
        _ => false,
    };
    if withheld { "null" } else { origin }
}
pub(crate) fn origin_header_for_ruby(origin: String, policy: Option<String>, target: Option<String>, cors: bool) -> String {
    origin_header(&origin, policy.as_deref().unwrap_or(""), target.as_deref().unwrap_or(""), cors).to_owned()
}

// `Sec-Fetch-Site` of a request its initiator `initiator` makes to `target`: 'none' with no initiator of an http(s)
// URL (a load the user made), 'same-origin', 'same-site' (realm_location.rs `site`), else 'cross-site'.
pub(crate) fn fetch_site(initiator: &str, target: &str) -> &'static str {
    let Some(from) = http_origin(initiator) else { return "none" };
    if http_origin(target).as_deref() == Some(&from) {
        return "same-origin";
    }
    match (crate::realm_location::site(initiator), crate::realm_location::site(target)) {
        (Some(a), Some(b)) if a == b => "same-site",
        _ => "cross-site",
    }
}
// …the wider of `seed`, the chain's so far (none at its first hop), and `site`, the hop's: a chain's is the most
// distant any of its URLs has been (same-origin, same-site, cross-site — 'none' as wide as cross-site).
pub(crate) fn wider_site<'a>(seed: Option<&'a str>, site: &'a str) -> &'a str {
    let rank = |s: &str| match s {
        "same-origin" => 0,
        "same-site" => 1,
        _ => 2,
    };
    match seed {
        Some(seed) if rank(seed) >= rank(site) => seed,
        _ => site,
    }
}
pub(crate) fn fetch_site_for_ruby(seed: Option<String>, initiator: Option<String>, target: Option<String>) -> String {
    wider_site(seed.as_deref(), fetch_site(initiator.as_deref().unwrap_or(""), target.as_deref().unwrap_or(""))).to_owned()
}
pub(crate) fn wider_site_for_ruby(seed: Option<String>, site: String) -> String {
    wider_site(seed.as_deref(), &site).to_owned()
}

// Whether a request whose origin is the one of `initiator` — 'null' already where `tainted` — has it opaque once it
// follows a redirect from `current` to `location` (Fetch "HTTP-redirect fetch" step 13): where the redirect crosses
// origin from a URL already off the request's origin. The first hop away keeps it.
pub(crate) fn redirect_taints(tainted: bool, initiator: &str, current: &str, location: &str) -> bool {
    tainted || (http_origin(current) != http_origin(location) && http_origin(initiator) != http_origin(current))
}
pub(crate) fn redirect_taints_for_ruby(tainted: bool, initiator: Option<String>, current: Option<String>, location: Option<String>) -> bool {
    redirect_taints(tainted, initiator.as_deref().unwrap_or(""), current.as_deref().unwrap_or(""), location.as_deref().unwrap_or(""))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_referrer_is_the_source_stripped_as_its_policy_says() {
        let page = "https://user:pw@a.test/p?q#frag";
        assert_eq!(request_referrer("unsafe-url", page, "http://b.test/").as_deref(), Some("https://a.test/p?q"));
        assert_eq!(request_referrer("origin", page, "https://a.test/").as_deref(), Some("https://a.test/"));
        assert_eq!(request_referrer("no-referrer", page, "https://a.test/"), None);
        // (…the default: the whole URL to its own origin, the origin to another, none on a downgrade)
        assert_eq!(request_referrer("", page, "https://a.test/x").as_deref(), Some("https://a.test/p?q"));
        assert_eq!(request_referrer("bogus", page, "https://b.test/").as_deref(), Some("https://a.test/"));
        assert_eq!(request_referrer("", page, "http://b.test/"), None);
        assert_eq!(request_referrer("same-origin", page, "https://b.test/"), None);
        assert_eq!(request_referrer("origin-when-cross-origin", page, "https://b.test/").as_deref(), Some("https://a.test/"));
        assert_eq!(request_referrer("no-referrer-when-downgrade", page, "https://b.test/").as_deref(), Some("https://a.test/p?q"));
        assert_eq!(request_referrer("strict-origin", page, "http://b.test/"), None);
    }

    #[test]
    fn a_downgrade_is_to_a_url_not_potentially_trustworthy() {
        // (…http://localhost is one, so https to it downgrades nothing, and from it to http elsewhere does)
        assert_eq!(request_referrer("strict-origin", "https://a.test/p", "http://localhost/").as_deref(), Some("https://a.test/"));
        assert_eq!(request_referrer("no-referrer-when-downgrade", "http://localhost/p", "http://b.test/"), None);
        assert_eq!(request_referrer("no-referrer-when-downgrade", "http://a.test/p", "http://b.test/").as_deref(), Some("http://a.test/p"));
    }

    #[test]
    fn a_local_source_refers_as_none_and_a_long_one_as_its_origin() {
        assert_eq!(request_referrer("unsafe-url", "about:blank", "https://a.test/"), None);
        assert_eq!(request_referrer("unsafe-url", "data:text/html,x", "https://a.test/"), None);
        let long = format!("https://a.test/{}", "x".repeat(MAX_REFERRER_LENGTH));
        assert_eq!(request_referrer("unsafe-url", &long, "https://a.test/").as_deref(), Some("https://a.test/"));
        assert_eq!(referrer_url("https://a.test/p#f").as_deref(), Some("https://a.test/p"));
    }

    #[test]
    fn an_origin_is_withheld_where_its_policy_would_withhold_the_referrer() {
        assert_eq!(origin_header("https://a.test", "", "http://b.test/", false), "null");
        assert_eq!(origin_header("https://a.test", "", "http://b.test/", true), "https://a.test");
        assert_eq!(origin_header("https://a.test", "same-origin", "https://a.test/x", false), "https://a.test");
        assert_eq!(origin_header("https://a.test", "same-origin", "https://b.test/x", false), "null");
        assert_eq!(origin_header("https://a.test", "no-referrer", "https://a.test/", false), "null");
        assert_eq!(origin_header("https://a.test", "unsafe-url", "http://b.test/", false), "https://a.test");
    }

    #[test]
    fn a_site_is_judged_by_origin_then_registrable_domain() {
        assert_eq!(fetch_site("", "https://a.test/"), "none");
        assert_eq!(fetch_site("about:blank", "https://a.test/"), "none");
        assert_eq!(fetch_site("https://a.test/x", "https://a.test/y"), "same-origin");
        assert_eq!(fetch_site("https://www.a.test/", "https://img.a.test/"), "same-site");
        assert_eq!(fetch_site("https://a.test/", "https://b.test/"), "cross-site");
        assert_eq!(wider_site(None, "same-origin"), "same-origin");
        assert_eq!(wider_site(Some("same-site"), "same-origin"), "same-site");
        assert_eq!(wider_site(Some("same-site"), "cross-site"), "cross-site");
    }

    #[test]
    fn an_origin_taints_on_a_cross_origin_hop_from_off_its_origin() {
        assert!(!redirect_taints(false, "https://a.test/", "https://a.test/r", "https://b.test/"));
        assert!(redirect_taints(false, "https://a.test/", "https://b.test/r", "https://c.test/"));
        assert!(!redirect_taints(false, "https://a.test/", "https://b.test/r", "https://b.test/s"));
        assert!(redirect_taints(true, "https://a.test/", "https://a.test/r", "https://a.test/s"));
    }
}
