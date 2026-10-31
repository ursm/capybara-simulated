// What a request tells the server of where it came from: its `Referer` (Referrer Policy §8.3 "determine request's
// referrer"), its `Origin` (Fetch "append a request `Origin` header") and its `Sec-Fetch-Site` (Fetch Metadata §2.4),
// each from its referrer source or initiator, its referrer policy and the URL it is at — and, over a redirect chain,
// the widest `Sec-Fetch-Site` any hop has had and whether its origin has become opaque (Fetch "HTTP-redirect fetch"
// step 13). The host sends what these answer. And the client a document's request is made as (Fetch "client"): the URL
// its site and origin are judged by, the source and policy it refers by, and its site for cookies (RFC 6265bis) — read
// off the realms' documents and the tree of navigables they are in.

use crate::dom::{dom, register, RealmArena};
use crate::url_ops::{potentially_trustworthy_url, DEFAULT_POLICY, POLICIES};

// A referrer URL longer than this goes as its origin (Referrer Policy §8.3 step 6).
const MAX_REFERRER_LENGTH: usize = 4096;

// `policy` where it is a referrer policy, else the default one — the policy of a request whose policy container names
// none, as the empty one is.
fn policy_or_default(policy: &str) -> &str {
    if POLICIES.contains(&policy) { policy } else { DEFAULT_POLICY }
}

// The origin of `url` where it is an http(s) one — the origins these rules compare — None for any other.
pub(crate) fn http_origin(url: &str) -> Option<String> {
    let url = ada_url::Url::parse(url, None).ok()?;
    matches!(url.protocol(), "http:" | "https:").then(|| url.origin())
}

// Referrer Policy §8.4 "strip url for use as a referrer": none for a URL of a local scheme (about:, blob:, data:) or no
// URL at all, else the URL with no credentials and no fragment — and, `origin_only`, no path and no query either.
fn stripped(url: &ada_url::Url, origin_only: bool) -> Option<String> {
    if matches!(url.protocol(), "about:" | "blob:" | "data:") {
        return None;
    }
    // (…a URL that can have no credentials — `file:`, one of an opaque path — has none to drop: its setters refuse)
    let mut url = url.clone();
    let _ = url.set_username(Some(""));
    let _ = url.set_password(Some(""));
    url.set_hash(None);
    if origin_only {
        let _ = url.set_pathname(Some(""));
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
pub(crate) fn default_policy_for_ruby() -> &'static str {
    DEFAULT_POLICY
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
pub(crate) fn origin_header_for_ruby(origin: Option<String>, policy: Option<String>, target: Option<String>, cors: bool) -> Option<String> {
    Some(origin_header(&origin?, policy.as_deref().unwrap_or(""), target.as_deref().unwrap_or(""), cors).to_owned())
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

// A request's redirect-taint (Fetch "redirect-taint"), walked once as its URL list grows hop by hop: "same-site" once a
// URL "is not same origin with lastURL's origin and request's origin is not same origin with lastURL's origin" — which
// serializes its origin `null` ("serializing a request origin") — and "cross-site" once one "is not same site with
// lastURL's origin and request's origin is not same site with lastURL's origin", which "determine the same-site mode"
// reads ("If request's redirect-taint is 'cross-site', then return 'unset-or-less'"): a→b→a's hop back to a.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum RedirectTaint {
    #[default]
    SameOrigin,
    SameSite,
    CrossSite,
}
impl RedirectTaint {
    // …moved on by a hop from `last` to `url` of a request whose origin is `origin` (serialized: `null` an opaque one,
    // same origin and same site with none; '' none — a request of no origin at all, which no hop taints).
    pub(crate) fn step(self, origin: &str, last: &str, url: &str) -> Self {
        if origin.is_empty() {
            return self;
        }
        let (hop, home) = (fetch_site(last, url), fetch_site(origin, last));
        let same_site = |site: &str| matches!(site, "same-origin" | "same-site");
        let taint = if !same_site(hop) && !same_site(home) {
            RedirectTaint::CrossSite
        } else if hop != "same-origin" && home != "same-origin" {
            RedirectTaint::SameSite
        } else {
            RedirectTaint::SameOrigin
        };
        self.max(taint)
    }
    // …the level its wire name names ("same-origin", "same-site", "cross-site"; none, or any other, the first).
    pub(crate) fn named(name: Option<&str>) -> Self {
        match name {
            Some("cross-site") => RedirectTaint::CrossSite,
            Some("same-site") => RedirectTaint::SameSite,
            _ => RedirectTaint::SameOrigin,
        }
    }
    pub(crate) fn name(self) -> &'static str {
        match self {
            RedirectTaint::SameOrigin => "same-origin",
            RedirectTaint::SameSite => "same-site",
            RedirectTaint::CrossSite => "cross-site",
        }
    }
    // Whether its origin serializes `null`, and whether it is cross-site for cookies.
    pub(crate) fn origin_tainted(self) -> bool {
        self != RedirectTaint::SameOrigin
    }
    pub(crate) fn cross_site(self) -> bool {
        self == RedirectTaint::CrossSite
    }
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    register(scope, ns, "requestClient", request_client_op, context_id);
    register(scope, ns, "siteForCookies", site_for_cookies_op, context_id);
    register(scope, ns, "documentCookieContext", document_cookie_context_op, context_id);
    register(scope, ns, "ancestorDocuments", ancestor_documents_op, context_id);
}

// What a request's client knows of the document of realm `r` (0 the page's) — where the engine has the realm, the page's
// for one gone: its URL, whether its origin is opaque (a sandboxed document's), and the referrer policy its `<meta
// name="referrer">` elements and its response set (url_ops.rs `document_referrer_policy`), '' for none.
struct Document {
    realm: i32,
    url: String,
    opaque: bool,
    policy: &'static str,
}
fn document(arena: &mut RealmArena, r: i32) -> Document {
    let realm = if arena.enter_known(r).is_some() { r } else { 0 };
    let arena = arena.enter(realm);
    let policy = arena.realm_document(realm).map_or("", |doc| arena.document_referrer_policy(doc));
    Document { realm, url: arena.location.href().to_owned(), opaque: arena.location.origin() == "null", policy }
}
// The realm of the document a frame realm `r`'s container was in (navigables.rs `parent_realm`) — the page's for none: a
// window's, whose opener is no parent of it.
fn parent(arena: &RealmArena, r: i32) -> i32 {
    arena.parent_realm(r).unwrap_or(0)
}

// The referrer source and policy of a request the document of realm `r` makes (Referrer Policy "determine request's
// referrer" steps 2-3): its URL under its policy — an iframe srcdoc document's its container document's, under that
// one's unless its own sets one — and one of an opaque origin's `no-referrer`, a step before.
fn referrer_source(arena: &mut RealmArena, r: i32) -> (String, &'static str) {
    let doc = document(arena, r);
    if doc.opaque {
        return (doc.url, "no-referrer");
    }
    if doc.realm != 0 && doc.url.eq_ignore_ascii_case("about:srcdoc") {
        let (url, policy) = referrer_source(arena, parent(arena, doc.realm));
        return (url, if doc.policy.is_empty() { policy } else { doc.policy });
    }
    (doc.url, doc.policy)
}
// The URL whose site a request of realm `r`'s document is judged by (Sec-Fetch-Site, cookies) and whose origin its Origin
// carries — `url` the document's own: one of an http(s) URL its own, a `blob:` one's its blob URL's origin's, a local
// one's (about:blank, srcdoc) its container document's, up to the page's. (KNOWN LIMIT: a popup's about:blank the
// page's, not its opener's; a frame another document navigated to about:blank its parent's, not that document's.)
fn creator_url(arena: &mut RealmArena, mut r: i32, mut url: String) -> String {
    loop {
        if url.get(..5).is_some_and(|s| s.eq_ignore_ascii_case("blob:")) {
            if let Some(origin) = http_origin(&url[5..]) {
                return origin + "/";
            }
        }
        if r == 0 || http_origin(&url).is_some() {
            return url;
        }
        r = parent(arena, r);
        url = document(arena, r).url;
    }
}

// The Referer a navigation the document of realm `r` begins sends: [the URL it refers by, its policy — `policy` (a link's
// `referrerpolicy`, `no-referrer` for its `rel=noreferrer`), else its document's; `no-referrer` for one of an opaque
// origin, which no link lifts].
pub(crate) fn navigation_referrer(arena: &mut RealmArena, r: i32, policy: &str) -> (String, String) {
    let doc = document(arena, r);
    let (source, own) = referrer_source(arena, doc.realm);
    let policy = if doc.opaque { "no-referrer" } else if policy.is_empty() { own } else { policy };
    (source, policy.to_owned())
}

// __dom.requestClient(realm, elementPolicy, opaque) -> [url, policy, opaque, realm, source, crossSiteAncestor]: the client
// a subresource request of realm `realm`'s document — the calling realm's for undefined — is made as (Fetch "client"):
// the URL its site and origin are judged by (`creator_url`), the policy it refers by — the element's (`elementPolicy`),
// else its document's; `no-referrer` for one of an opaque origin, which no element lifts — whether that origin is
// opaque, the realm it is, the URL it refers by (`referrer_source`), and its "has cross-site ancestor"
// (`has_cross_site_ancestor`, which Fetch's "determine the same-site mode" reads of a request's client). A realm gone
// answers the page's URLs, and is still the realm the request is of: one of no document known, cross-site for cookies
// (its `ancestorDocuments` entry None). `opaque` a boolean where the bindings tell it (an image's load, which names the
// policy its document had as the element was inserted): the URL alone is the realm's then, and the document's policy
// only a srcdoc one's container's.
fn request_client_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let r = if args.get(0).is_undefined() { crate::dom::realm_id(scope, &args) } else { args.get(0).int32_value(scope).unwrap_or(0) };
    let element_policy = args.get(1).to_rust_string_lossy(scope);
    let told = args.get(2).is_boolean().then(|| args.get(2).is_true());
    let arena = &mut dom(scope).arena;
    let doc = document(arena, r);
    let (opaque, source, policy) = match told {
        None => {
            let (source, policy) = referrer_source(arena, doc.realm);
            (doc.opaque, source, policy)
        }
        Some(opaque) if doc.realm != 0 && doc.url.eq_ignore_ascii_case("about:srcdoc") => {
            let (source, policy) = referrer_source(arena, parent(arena, doc.realm));
            (opaque, source, policy)
        }
        Some(opaque) => (opaque, doc.url.clone(), ""),
    };
    let url = creator_url(arena, doc.realm, if told.is_none() { source.clone() } else { doc.url });
    let cross_site_ancestor = has_cross_site_ancestor(&document_chain(arena, doc.realm, true, known_origin_key));
    let policy = if opaque { "no-referrer" } else if element_policy.is_empty() { policy } else { element_policy.as_str() };
    let items = [
        v8::String::new(scope, &url).unwrap().into(),
        v8::String::new(scope, policy).unwrap().into(),
        v8::Boolean::new(scope, opaque).into(),
        v8::Integer::new(scope, r).into(),
        v8::String::new(scope, &source).unwrap().into(),
        v8::Boolean::new(scope, cross_site_ancestor).into(),
    ];
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}
// HTML "has cross-site ancestor" of a document whose origin key is the first of `documents` and its ancestors' the rest
// (`document_chain` of `known_origin_key`): one of them is not same site with the one below it — an opaque origin same
// site with itself alone (HTML "same site": two opaque origins are where they are the same origin), which a document
// that inherited it shares by its key — one not known with none.
fn has_cross_site_ancestor(documents: &[Option<String>]) -> bool {
    documents.windows(2).any(|pair| match (pair[0].as_deref(), pair[1].as_deref()) {
        (Some(child), Some(parent)) => child != parent && !matches!(fetch_site(parent, child), "same-origin" | "same-site"),
        _ => true,
    })
}

// The origin of realm `r`'s document, serialized — an about:blank or srcdoc one's its creator's, an opaque one's
// "null" — which its requests' cookies are judged by (RFC 6265bis §5.2.1: a document's origin, not its URL); None for a
// realm gone, which no request is judged by: closed rather than open. (…a sandboxed one's `null` too, of no site,
// where §5.2.1 would take its URI's origin: WPT cookies/samesite sandbox-iframe-subresource / -nested expect a
// sandboxed frame's requests cross-site, as browsers make them — the gate's reading, here)
fn known_document(arena: &mut RealmArena, r: i32) -> Option<String> {
    let arena = arena.enter_known(r)?;
    Some(arena.location.origin().to_owned())
}
// …the key realm `r`'s document's origin is matched by (realm_location.rs `origin_key`): a tuple origin's serialization,
// an opaque one's token — the same in a document that inherited it (an about:blank one's of a sandboxed creator) and in
// no other; None for a realm gone.
fn known_origin_key(arena: &mut RealmArena, r: i32) -> Option<String> {
    let arena = arena.enter_known(r)?;
    Some(arena.location.origin_key(r))
}
// Whether a request a document at `url` — its URL or its origin — makes to `target` is cross-site for cookies (RFC
// 6265bis "site for cookies"): one of none known, one of an opaque origin (a `data:` document's, a sandboxed one's
// `null`: of no site at all), one of another site.
pub(crate) fn cross_site_for_cookies(url: Option<&str>, target: &str) -> bool {
    url.is_none_or(|url| url == "null" || url.get(..5).is_some_and(|s| s.eq_ignore_ascii_case("data:")) || fetch_site(url, target) == "cross-site")
}
// …realm `r`'s document: where an ancestor's document is of another site than `target`'s, up to its top-level one (a
// window's: its opener is no ancestor).
fn frame_cross_site(arena: &mut RealmArena, mut r: i32, target: &str) -> bool {
    while let Some(p) = arena.parent_realm(r) {
        if cross_site_for_cookies(known_document(arena, p).as_deref(), target) {
            return true;
        }
        r = p;
    }
    false
}
// The site for cookies (RFC 6265bis §5.2.1) of a document whose origin is the first of `documents`, its ancestors' the
// rest up to the top-level one's (`ancestor_documents_op`'s list): the top-level document's origin's site where every
// document is of that site, None — an opaque origin, same-site with nothing — where one is not, is of an opaque origin,
// or is not known.
fn chain_site_for_cookies(documents: &[Option<String>]) -> Option<String> {
    let sites = documents.iter().map(|d| d.as_deref().and_then(crate::realm_location::site)).collect::<Option<Vec<_>>>()?;
    let top = sites.last()?;
    sites.iter().all(|s| s == top).then(|| top.clone())
}
// …of realm `r`'s document: each by its origin, an about:blank or srcdoc one's its creator's (an about:blank popup's its
// opener's) — None where one is gone.
fn site_for_cookies(arena: &mut RealmArena, r: i32) -> Option<String> {
    chain_site_for_cookies(&document_chain(arena, r, true, known_document))
}
// What `read` says of the documents of realm `r`'s ancestors (`known_document`'s origin, `known_origin_key`'s key), up
// to its top-level one, None for one not known — its own first, `own`.
fn document_chain(arena: &mut RealmArena, mut r: i32, own: bool, read: fn(&mut RealmArena, i32) -> Option<String>) -> Vec<Option<String>> {
    let mut origins = Vec::new();
    if own {
        origins.push(read(arena, r));
    }
    while let Some(p) = arena.parent_realm(r) {
        origins.push(read(arena, p));
        r = p;
    }
    origins
}
// __dom.siteForCookies(realm) -> `site_for_cookies`, undefined for none.
fn site_for_cookies_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let r = args.get(0).int32_value(scope).unwrap_or(0);
    if let Some(site) = site_for_cookies(&mut dom(scope).arena, r) {
        rv.set(v8::String::new(scope, &site).unwrap().into());
    }
}
// __dom.ancestorDocuments(realm, own) -> `document_chain` (null for one not known): what a request its document makes
// is cross-site for cookies by (fetch_hop.rs `Client::cross_site`), besides its client; by its own too where the client
// is not the document but the page the host pinned it to (an image's or a video's load), and for a navigation of a frame
// in it.
fn ancestor_documents_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let r = args.get(0).int32_value(scope).unwrap_or(0);
    let origins = document_chain(&mut dom(scope).arena, r, args.get(1).is_true(), known_document);
    let items: Vec<v8::Local<'_, v8::Value>> = origins
        .iter()
        .map(|u| u.as_deref().and_then(|u| v8::String::new(scope, u)).map_or_else(|| v8::null(scope).into(), Into::into))
        .collect();
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}

// __dom.documentCookieContext(realm, url) -> the context `document.cookie` reads and writes the cookies of `url` in, for
// the document of realm `realm` (cookie_jar.rs): through no HTTP API, over a secure channel where `url`'s origin is
// potentially trustworthy, cross-site where a document above its browsing context is (`frame_cross_site`: RFC 6265bis
// "site for cookies" — no SameSite cookie read or stored there but a None one), never a navigation's.
fn document_cookie_context_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let r = args.get(0).int32_value(scope).unwrap_or(0);
    let url = args.get(1).to_rust_string_lossy(scope);
    let cross = frame_cross_site(&mut dom(scope).arena, r, &url);
    rv.set_uint32(crate::cookie_jar::document_context(crate::cookie_jar::secure_target(&url), cross));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_document_has_a_cross_site_ancestor_where_one_above_it_is_of_another_site() {
        let chain = |origins: &[&str]| has_cross_site_ancestor(&origins.iter().map(|o| (!o.is_empty()).then(|| (*o).to_owned())).collect::<Vec<_>>());
        assert!(!chain(&["http://a.test"]));
        assert!(!chain(&["http://x.a.test", "http://a.test"]));
        assert!(chain(&["http://a.test", "http://b.test"]));
        // (…a→b→a: the middle frame is the one; an opaque origin same site with itself alone — a document that inherited
        // it shares its key — and one not known with none)
        assert!(chain(&["http://a.test", "http://b.test", "http://a.test"]));
        assert!(chain(&["opaque:realm3", "http://a.test"]));
        assert!(chain(&["opaque:realm4", "opaque:realm3"]));
        assert!(!chain(&["opaque:realm3", "opaque:realm3"]));
        assert!(chain(&["http://a.test", ""]));
    }

    #[test]
    fn a_redirect_taints_a_request_off_its_own_origin_and_site() {
        let taint = |origin: &str, urls: &[&str]| urls.windows(2).fold(RedirectTaint::SameOrigin, |t, w| t.step(origin, w[0], w[1]));
        // (…a→b untainted, a→b→a cross-site; a request of b's going b→b→a untainted; b→a of a's cross-site, its first URL
        // off its site; `null` tainted by any cross-origin step — a user's navigation's, a new opaque origin — one of no
        // origin at all never)
        assert_eq!(taint("http://a.test", &["http://a.test/1", "http://b.test/2"]), RedirectTaint::SameOrigin);
        assert_eq!(taint("http://a.test", &["http://a.test/1", "http://b.test/2", "http://a.test/3"]), RedirectTaint::CrossSite);
        assert_eq!(taint("http://b.test", &["http://b.test/1", "http://b.test/2", "http://a.test/3"]), RedirectTaint::SameOrigin);
        assert_eq!(taint("http://a.test", &["http://b.test/1", "http://a.test/2"]), RedirectTaint::CrossSite);
        assert_eq!(taint("null", &["http://a.test/1", "http://b.test/2"]), RedirectTaint::CrossSite);
        assert_eq!(taint("", &["http://a.test/1", "http://b.test/2", "http://a.test/3"]), RedirectTaint::SameOrigin);
        // (…same-site: a hop to another origin from a URL off the request's origin, its site kept; the level only rises)
        assert_eq!(taint("https://a.test", &["https://a.test/r", "https://b.test/"]), RedirectTaint::SameOrigin);
        assert_eq!(taint("https://a.test", &["https://x.a.test/r", "https://y.a.test/s"]), RedirectTaint::SameSite);
        assert_eq!(taint("https://a.test", &["https://b.test/r", "https://b.test/s"]), RedirectTaint::SameOrigin);
        assert_eq!(RedirectTaint::CrossSite.step("https://a.test", "https://a.test/r", "https://a.test/s"), RedirectTaint::CrossSite);
    }

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

}
