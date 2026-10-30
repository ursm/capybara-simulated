// What each hop of a fetch the host makes carries (Fetch "HTTP-network-or-cache fetch" over its request; RFC 6265bis's
// site for cookies): whether it is a CORS hop to another origin, its `Origin`, its `Sec-Fetch-*` (Fetch Metadata), and
// the context its cookies are sent and its response's stored in, where it includes credentials (cookie_jar.rs
// `request_context`). Sec-Fetch-Site latches across the hops, as Fetch Metadata walks the request's URL list; the
// cookies' same-site-ness is the hop's URL's alone: RFC 6265bis-14 removed the rule that "the origin of every url in the
// request's url list is same-site with the request's current url's origin" (A.14, "Remove consideration of same-site
// redirect chain", httpwg/http-extensions#2750), and the current draft's §5.2 asks only that "the request's current
// url's origin is same-site with the request's client's 'site for cookies'". A fetch's plan (fetch_plan.rs) makes one,
// with what its client is, and asks it at each hop.

use std::cell::RefCell;

use crate::referrer::{cross_site_for_cookies, fetch_site, http_origin, origin_header, wider_site};

// The request's client and mode, as one fetch is made with them, and the documents its cookies are judged against.
struct Client {
    // Its mode ("cors", "no-cors", "same-origin", "navigate"), None for a mode-less internal load.
    mode: Option<String>,
    // Its destination as an element's load names it ('' is one), None for none.
    dest: Option<String>,
    // A navigation's destination ("document", "iframe"), for a document's own navigation request or a worker's re-issue
    // of the navigation it intercepted.
    nav_dest: Option<String>,
    // Whether it is a document's own navigation request, and whether its document had transient activation.
    navigation: bool,
    user_activated: bool,
    // Its credentials mode: "include", "same-origin", "omit".
    credentials: String,
    // Its origin, and the document origin a mode's response type is judged by (None for a mode-less load).
    origin: Option<String>,
    doc_origin: Option<String>,
    // Its client's origin ("null" an opaque one's), and the origin Sec-Fetch-Site measures from.
    client_origin: Option<String>,
    sec_initiator: Option<String>,
    // What its cookies' site is judged by (RFC 6265bis "site for cookies"): its client — a document or an origin, None
    // for a load with no client — and, cross-site wherever any of them is: the top-level document a mode-less load's is
    // under, every ancestor of the frame whose document made it (its origin, None for one not known) — that document's
    // own too where the caller names it (an image's or a video's: its client the page, so a gone realm's is None) — and
    // the worker's site for cookies (Some(None): of none, cross-site to every site).
    cookie_client: Option<String>,
    top_document: Option<String>,
    ancestors: Vec<Option<String>>,
    worker_site: Option<Option<String>>,
    // A worker re-issuing the navigation it intercepted: its cookies judged as the navigation's are, by its initiator's
    // site rather than by its own client.
    reissued: bool,
    // A navigation whose cookies are cross-site whatever its initiator's site (navigation_fetch.rs `Nav::cookies`): one
    // into a frame with a cross-site ancestor, one a document of an opaque origin made, a reload through a user interface
    // element of a document reached cross-site.
    navigation_cross_site: bool,
}

// What a hop carries (`FetchHops#hop`).
pub(crate) type Hop = (bool, Option<String>, Option<(&'static str, String, String, bool)>, Option<u32>);

pub(crate) struct FetchHops {
    client: Client,
    // The chain's widest Sec-Fetch-Site so far, none before its first hop.
    sec_site: RefCell<Option<&'static str>>,
}

impl Client {
    // Whether a hop to `target` is cross-site for cookies (RFC 6265bis §5.2), by its URL alone and never by the URLs the
    // chain went through before it: where it re-issues a navigation that is whatever its initiator's site, else where
    // its judge is cross-site to the target — a re-issued navigation's its initiator, any other request's its client, a
    // request of neither same-site — or any document the request is judged by is.
    fn cross_site(&self, target: &str) -> bool {
        if self.navigation_cross_site {
            return true;
        }
        if self.reissued {
            return fetch_site(self.sec_initiator.as_deref().unwrap_or(""), target) == "cross-site";
        }
        self.cookie_client.as_deref().is_some_and(|client| {
            cross_site_for_cookies(Some(client), target)
                || (self.mode.is_none() && self.top_document.as_deref().is_some_and(|top| cross_site_for_cookies(Some(top), target)))
                || self.ancestors.iter().any(|a| cross_site_for_cookies(a.as_deref(), target))
                || self.worker_site.as_ref().is_some_and(|site| site.is_none() || crate::realm_location::site(target) != *site)
        })
    }
    // The chain's Sec-Fetch-Site moved on by a hop to `target` — Fetch Metadata's, for a mode's request and every load
    // that names its destination, None for any other: the widest of its initiator's relation to every URL so far.
    fn advance(&self, sec_site: &mut Option<&'static str>, target: &str) -> Option<&'static str> {
        (self.mode.is_some() || self.dest.is_some()).then(|| {
            // (…an opaque-origin client's request is of no site at all: cross-site, wherever it goes)
            let site = if self.client_origin.as_deref() == Some("null") {
                "cross-site"
            } else {
                wider_site(*sec_site, fetch_site(self.sec_initiator.as_deref().unwrap_or(""), target))
            };
            *sec_site = Some(site);
            site
        })
    }
    fn of_mode(&self, mode: &str) -> bool {
        self.mode.as_deref() == Some(mode)
    }
}

// What a fetch's client is (`FetchHops::new`): its request's mode, destination and a navigation's, whether it is a
// document's own navigation request and whether that document had transient activation, its credentials mode; its
// origin, the document origin a mode's response is judged by, its client's origin and the origin Sec-Fetch-Site measures
// from; its client's URL, the top-level document a mode-less load is under, its frame's ancestors' document origins (its
// own document's first where the client does not judge it: a host-pinned image's or video's, a frame's navigation), a
// dedicated worker's site for cookies (Some(None): of none); and whether it is a navigation's whose cookies are
// cross-site whatever its initiator's site (`Client::navigation_cross_site`).
pub(crate) struct ClientFacts {
    pub(crate) mode: Option<String>,
    pub(crate) dest: Option<String>,
    pub(crate) nav_dest: Option<String>,
    pub(crate) navigation: bool,
    pub(crate) user_activated: bool,
    pub(crate) credentials: String,
    pub(crate) origin: Option<String>,
    pub(crate) doc_origin: Option<String>,
    pub(crate) client_origin: Option<String>,
    pub(crate) sec_initiator: Option<String>,
    pub(crate) client_url: Option<String>,
    pub(crate) top_document: Option<String>,
    pub(crate) ancestors: Vec<Option<String>>,
    pub(crate) worker_site: Option<Option<String>>,
    pub(crate) navigation_cross_site: bool,
}

impl FetchHops {
    // (…the client's cookie judge its origin's where it is a mode's request — its document's or its initiator's — else
    // its document's URL, an opaque one's `null`)
    pub(crate) fn new(f: ClientFacts) -> Self {
        let cookie_client = match f.mode {
            Some(_) => f.doc_origin.clone().or_else(|| f.sec_initiator.clone()),
            None if f.client_origin.as_deref() == Some("null") => Some("null".to_owned()),
            None => f.client_url.or_else(|| f.sec_initiator.clone()),
        };
        let reissued = f.mode.as_deref() == Some("navigate") && f.nav_dest.as_deref().is_some_and(|d| !d.is_empty());
        let client = Client {
            mode: f.mode,
            dest: f.dest,
            nav_dest: f.nav_dest,
            navigation: f.navigation,
            user_activated: f.user_activated,
            credentials: f.credentials,
            origin: f.origin,
            doc_origin: f.doc_origin,
            client_origin: f.client_origin,
            sec_initiator: f.sec_initiator,
            cookie_client,
            top_document: f.top_document,
            ancestors: f.ancestors,
            worker_site: f.worker_site,
            reissued,
            navigation_cross_site: f.navigation_cross_site,
        };
        FetchHops { client, sec_site: RefCell::default() }
    }

    // #seed(site): the chain's Sec-Fetch-Site so far — a worker's re-fetch of a navigation its network hops widened.
    pub(crate) fn seed(&self, site: Option<String>) {
        *self.sec_site.borrow_mut() = site.as_deref().map(static_site);
    }

    // #hop(target, method, origin, policy) -> [cross-origin CORS hop, Origin (nil none), Sec-Fetch
    // ([site, mode, dest, user]; nil none), cookie context (nil where it includes no credentials: no `Cookie` sent, no
    // `Set-Cookie` stored)] for the hop to `target` of a request of `method` whose origin is `origin` ('null' tainted)
    // under referrer policy `policy`.
    pub(crate) fn hop(&self, target: String, method: String, origin: Option<String>, policy: Option<String>) -> Hop {
        let c = &self.client;
        let tainted = origin.as_deref() == Some("null");
        let target_origin = http_origin(&target);
        let cors = c.of_mode("cors");
        // (…a tainted origin is cross-origin to every target; otherwise the target's against the request's)
        let cross_origin = cors && (tainted || target_origin.as_deref() != c.origin.as_deref());
        // Fetch credentials mode: `omit` never sends cookies, `include` always, `same-origin` only to the document's
        // origin — a mode-less load, with none, keeps them.
        let hop_cross_origin = c.doc_origin.as_deref().is_some_and(|doc| tainted || target_origin.as_deref() != Some(doc));
        let send_cookies = c.credentials == "include" || (c.credentials != "omit" && !hop_cross_origin);
        // Fetch "append a request `Origin` header": a CORS hop to another origin, and any request with an origin of a
        // method that is no GET or HEAD.
        let bodied = !method.eq_ignore_ascii_case("GET") && !method.eq_ignore_ascii_case("HEAD");
        let origin_value = if cross_origin || (c.origin.is_some() && bodied) {
            origin.as_deref().map(|o| origin_header(o, policy.as_deref().unwrap_or(""), &target, cors).to_owned())
        } else {
            None
        };
        let sec = c.advance(&mut self.sec_site.borrow_mut(), &target).map(|site| {
            let dest = if c.navigation {
                c.nav_dest.clone().unwrap_or_default()
            } else {
                c.dest.clone().filter(|d| !d.is_empty()).unwrap_or_else(|| "empty".to_owned())
            };
            (site, c.mode.clone().unwrap_or_else(|| "no-cors".to_owned()), dest, c.navigation && c.user_activated)
        });
        // The cookie context, where it includes credentials (Fetch "HTTP-network-or-cache fetch": its cookies sent, and
        // its response's `Set-Cookie` stored, only then): over a secure channel where the target's origin is
        // potentially trustworthy, cross-site as the hop's URL is (`Client::cross_site`), and a top-level navigation's — a
        // re-issued one's — which may set a SameSite cookie, and by a GET retrieve a Lax one.
        let top_level = c.of_mode("navigate") && c.nav_dest.as_deref() == Some("document");
        let lax = top_level && method.eq_ignore_ascii_case("GET");
        let cookies = send_cookies.then(|| {
            let secure = target_origin.as_deref().is_some_and(crate::url_ops::potentially_trustworthy);
            crate::cookie_jar::request_context(secure, c.cross_site(&target), lax, top_level)
        });
        (cross_origin, origin_value, sec, cookies)
    }

    // #cached(target): a hop the HTTP cache answered — a redirect it followed from the cache — is in the chain all the
    // same: its URL widens the Sec-Fetch-Site latch as a network hop's does.
    pub(crate) fn cached(&self, target: String) {
        self.client.advance(&mut self.sec_site.borrow_mut(), &target);
    }
}

// (…a site value the host seeded, as one of the three it can be)
fn static_site(site: &str) -> &'static str {
    match site {
        "same-origin" => "same-origin",
        "same-site" => "same-site",
        "none" => "none",
        _ => "cross-site",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cookie_jar::{CROSS_SITE, HTTP, LAX_RETRIEVE, TOP_LEVEL_NAV};

    fn client(mode: Option<&str>) -> Client {
        let o = |s: &str| Some(s.to_owned());
        Client {
            mode: mode.map(str::to_owned),
            dest: None,
            nav_dest: None,
            navigation: false,
            user_activated: false,
            credentials: "same-origin".to_owned(),
            origin: o("http://a.test"),
            doc_origin: mode.and(o("http://a.test")),
            client_origin: o("http://a.test"),
            sec_initiator: o("http://a.test"),
            cookie_client: o("http://a.test/page"),
            top_document: None,
            ancestors: Vec::new(),
            worker_site: None,
            reissued: false,
            navigation_cross_site: false,
        }
    }
    fn hops(client: Client) -> FetchHops {
        FetchHops { client, sec_site: RefCell::default() }
    }

    // (…whether a hop's cookie context is cross-site, None for a hop that includes no credentials)
    fn cross(hop: &Hop) -> Option<bool> {
        hop.3.map(|c| c & CROSS_SITE != 0)
    }

    #[test]
    fn a_hop_carries_its_origin_cookies_and_metadata() {
        let h = hops(client(Some("cors")));
        let hop = h.hop("http://b.test/x".into(), "GET".into(), Some("http://a.test".into()), None);
        assert!(hop.0 && hop.3.is_none());
        assert_eq!(hop.1.as_deref(), Some("http://a.test"));
        assert_eq!(hop.2.map(|s| (s.0, s.1, s.2)), Some(("cross-site", "cors".to_owned(), "empty".to_owned())));
        // (…a hop back home keeps the chain's widest site, and a tainted origin is cross-origin everywhere)
        let hop = h.hop("http://a.test/y".into(), "GET".into(), Some("null".into()), None);
        assert!(hop.0 && hop.3.is_none());
        assert_eq!(hop.1.as_deref(), Some("null"));
        assert_eq!(hop.2.map(|s| s.0), Some("cross-site"));
        // (…a same-origin GET carries no Origin; a POST does)
        let home = hops(client(Some("cors")));
        assert_eq!(home.hop("http://a.test/y".into(), "GET".into(), Some("http://a.test".into()), None).1, None);
        assert_eq!(home.hop("http://a.test/y".into(), "POST".into(), Some("http://a.test".into()), None).1.as_deref(), Some("http://a.test"));
        // (…a same-site → cross-site → same-site chain cross-site for cookies at its cross-site hop alone, as RFC
        // 6265bis-14 judges a request by its current URL — while Sec-Fetch-Site stays the chain's widest; credentials
        // included for all)
        let chain = hops(Client { credentials: "include".to_owned(), ..client(Some("cors")) });
        let sites: Vec<(Option<bool>, Option<&str>)> = ["http://a.test/1", "http://b.test/2", "http://a.test/3"]
            .iter()
            .map(|t| {
                let hop = chain.hop((*t).into(), "GET".into(), Some("http://a.test".into()), None);
                (cross(&hop), hop.2.map(|s| s.0))
            })
            .collect();
        assert_eq!(sites, [(Some(false), Some("same-origin")), (Some(true), Some("cross-site")), (Some(false), Some("cross-site"))]);
    }

    #[test]
    fn a_mode_less_load_is_judged_by_every_document_above_it() {
        // (…no metadata for a load that names no destination; cookies sent, as no document origin bars them)
        let plain = hops(client(None));
        let hop = plain.hop("http://a.test/img".into(), "GET".into(), None, None);
        assert!(!hop.0 && hop.1.is_none() && hop.2.is_none());
        assert_eq!(hop.3, Some(HTTP));
        let framed = hops(Client { ancestors: vec![Some("http://top.test/".into())], ..client(None) });
        assert_eq!(cross(&framed.hop("http://a.test/img".into(), "GET".into(), None, None)), Some(true));
        let under = hops(Client { top_document: Some("http://top.test/".into()), ..client(None) });
        assert_eq!(cross(&under.hop("http://a.test/img".into(), "GET".into(), None, None)), Some(true));
        // (…a worker's by the site it was made with — of none, cross-site everywhere)
        let worker = hops(Client { worker_site: Some(Some("http://a.test".into())), ..client(None) });
        assert_eq!(cross(&worker.hop("http://a.test/w".into(), "GET".into(), None, None)), Some(false));
        let siteless = hops(Client { worker_site: Some(None), ..client(None) });
        assert_eq!(cross(&siteless.hop("http://a.test/w".into(), "GET".into(), None, None)), Some(true));
    }

    #[test]
    fn a_navigation_keeps_lax_cookies_at_the_top_level_alone() {
        // (…a navigation's credentials mode `include`, as Fetch makes one)
        let nav = Client { nav_dest: Some("document".into()), navigation: true, user_activated: true, credentials: "include".to_owned(), ..client(Some("navigate")) };
        let hop = hops(nav).hop("http://b.test/".into(), "GET".into(), Some("http://a.test".into()), None);
        assert_eq!(hop.2.map(|s| (s.2, s.3)), Some(("document".to_owned(), true)));
        assert_eq!(hop.3.map(|c| c & (LAX_RETRIEVE | TOP_LEVEL_NAV)), Some(LAX_RETRIEVE | TOP_LEVEL_NAV));
        // (…a POST's response may set a SameSite cookie, its request retrieves no Lax one)
        let post = Client { nav_dest: Some("document".into()), navigation: true, ..client(Some("navigate")) };
        let hop = hops(post).hop("http://a.test/".into(), "POST".into(), Some("http://a.test".into()), None);
        assert_eq!(hop.3.map(|c| c & (LAX_RETRIEVE | TOP_LEVEL_NAV)), Some(TOP_LEVEL_NAV));
        // (…a frame's navigation none of either; one cross-site whatever its initiator's site cross-site, a top-level
        // one's GET retrieving a Lax cookie all the same)
        let framed = Client { nav_dest: Some("iframe".into()), navigation_cross_site: true, ..client(Some("navigate")) };
        let hop = hops(framed).hop("http://a.test/".into(), "GET".into(), Some("http://a.test".into()), None);
        assert_eq!(cross(&hop), Some(true));
        assert_eq!(hop.3.map(|c| c & (LAX_RETRIEVE | TOP_LEVEL_NAV)), Some(0));
        let opaque = Client { nav_dest: Some("document".into()), navigation_cross_site: true, ..client(Some("navigate")) };
        let hop = hops(opaque).hop("http://a.test/".into(), "GET".into(), Some("http://a.test".into()), None);
        assert_eq!(cross(&hop), Some(true));
        assert_eq!(hop.3.map(|c| c & (LAX_RETRIEVE | TOP_LEVEL_NAV)), Some(LAX_RETRIEVE | TOP_LEVEL_NAV));
    }

    #[test]
    fn a_chain_seeds_reissues_and_caches_its_sec_fetch_site() {
        // (…a seed the chain's widest site so far, a cached hop in the chain too — its cookies the hop's URL's alone)
        let seeded = hops(client(Some("no-cors")));
        seeded.seed(Some("same-site".into()));
        assert_eq!(seeded.hop("http://a.test/x".into(), "GET".into(), None, None).2.map(|s| s.0), Some("same-site"));
        let cached = hops(client(Some("no-cors")));
        cached.cached("http://b.test/r".into());
        let hop = cached.hop("http://a.test/x".into(), "GET".into(), None, None);
        assert_eq!((cross(&hop), hop.2.map(|s| s.0)), (Some(false), Some("cross-site")));
        // (…a re-issued navigation's cookies its initiator's relation to the hop, not the chain's nor its client's)
        let reissued = hops(Client { reissued: true, nav_dest: Some("document".into()), ..client(Some("navigate")) });
        reissued.seed(Some("cross-site".into()));
        let hop = reissued.hop("http://a.test/x".into(), "GET".into(), None, None);
        assert_eq!((cross(&hop), hop.2.map(|s| s.0)), (Some(false), Some("cross-site")));
        let elsewhere = hops(Client { reissued: true, nav_dest: Some("document".into()), credentials: "include".to_owned(), cookie_client: Some("http://b.test/sw.js".into()),..client(Some("navigate")) });
        assert_eq!(cross(&elsewhere.hop("http://b.test/x".into(), "GET".into(), None, None)), Some(true));
        // (…an opaque-origin client's request cross-site wherever it goes)
        let opaque = hops(Client { client_origin: Some("null".into()), ..client(Some("cors")) });
        assert_eq!(opaque.hop("http://a.test/x".into(), "GET".into(), None, None).2.map(|s| s.0), Some("cross-site"));
        // (…a navigation cross-site whatever its initiator's site cross-site at every hop)
        let frame = hops(Client { navigation_cross_site: true, ..client(None) });
        assert_eq!(cross(&frame.hop("http://a.test/x".into(), "GET".into(), None, None)), Some(true));
        assert_eq!(cross(&frame.hop("http://a.test/y".into(), "GET".into(), None, None)), Some(true));
    }

    #[test]
    fn a_no_cors_post_sends_its_origin_as_its_policy_lets_it() {
        let h = hops(client(Some("no-cors")));
        let origin = |policy: &str, target: &str| h.hop(target.into(), "POST".into(), Some("https://a.test".into()), Some(policy.into())).1;
        assert_eq!(origin("", "https://a.test/x").as_deref(), Some("https://a.test"));
        assert_eq!(origin("same-origin", "https://b.test/x").as_deref(), Some("null"));
        assert_eq!(origin("", "http://a.test/x").as_deref(), Some("null"));
    }
}
