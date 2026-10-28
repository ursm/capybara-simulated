// What each hop of a fetch the host makes carries (Fetch "HTTP-network-or-cache fetch" over its request; RFC 6265bis's
// site for cookies): whether it is a CORS hop to another origin, whether it sends cookies, its `Origin`, its
// `Sec-Fetch-*` (Fetch Metadata), and the site its cookies are judged by — the chain's widest so far, latched across
// the hops as the Sec-Fetch-Site one is. The host makes one `FetchHops` per fetch, with what its client is, and asks it
// at each hop; it sends the request and keeps what comes back.

use std::cell::RefCell;

use magnus::{function, method, prelude::*, Error, RArray, RModule, Ruby};

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
    // under, every ancestor of the frame whose document made it (a URL, None for one not known), and the worker's site
    // for cookies (Some(None): of none, cross-site to every site).
    cookie_client: Option<String>,
    top_document: Option<String>,
    ancestors: Vec<Option<String>>,
    worker_site: Option<Option<String>>,
    // A worker re-issuing the navigation it intercepted: its cookies the chain's verdict (Sec-Fetch-Site's), not its own.
    reissued: bool,
    // A navigation into a frame with a cross-site ancestor: cross-site whoever issues it.
    cross_site_frame: bool,
}

// What a hop carries (`FetchHops#hop`).
type Hop = (bool, bool, Option<String>, Option<(&'static str, String, String, bool, bool)>, Option<&'static str>, bool);

// The chain's latches: the widest Sec-Fetch-Site and cookie site so far.
#[derive(Default)]
struct Latches {
    sec_site: Option<&'static str>,
    cookie_site: Option<&'static str>,
}

#[magnus::wrap(class = "Capybara::Simulated::Native::FetchHops", free_immediately)]
pub(crate) struct FetchHops {
    client: Client,
    latches: RefCell<Latches>,
}

impl Client {
    // The cookie site of a hop to `target` given the chain's so far: cross-site where the target is to any document the
    // request is judged by, else the wider of the chain's and the client's site relation to it.
    fn cookie_site(&self, seed: Option<&'static str>, target: &str) -> Option<&'static str> {
        let client = self.cookie_client.as_deref()?;
        let cross = cross_site_for_cookies(Some(client), target)
            || (self.mode.is_none() && self.top_document.as_deref().is_some_and(|top| cross_site_for_cookies(Some(top), target)))
            || self.ancestors.iter().any(|a| cross_site_for_cookies(a.as_deref(), target))
            || self.worker_site.as_ref().is_some_and(|site| site.is_none() || crate::realm_location::site(target) != *site);
        Some(if cross { "cross-site" } else { wider_site(seed, fetch_site(client, target)) })
    }
    // The chain's latches moved on by a hop to `target`: its Sec-Fetch-Site — Fetch Metadata's, for a mode's request and
    // every load that names its destination: None for any other — and the site its cookies are judged by, which a
    // worker's re-issued navigation takes from the chain's verdict and any other from its client, a navigation into a
    // frame with a cross-site ancestor cross-site whoever issues it.
    fn advance(&self, latches: &mut Latches, target: &str) -> Option<&'static str> {
        let sec = (self.mode.is_some() || self.dest.is_some()).then(|| {
            // (…an opaque-origin client's request is of no site at all: cross-site, wherever it goes)
            let site = if self.client_origin.as_deref() == Some("null") {
                "cross-site"
            } else {
                wider_site(latches.sec_site, fetch_site(self.sec_initiator.as_deref().unwrap_or(""), target))
            };
            latches.sec_site = Some(site);
            site
        });
        latches.cookie_site = if self.reissued { latches.sec_site } else { self.cookie_site(latches.cookie_site, target).or(latches.cookie_site) };
        if self.cross_site_frame && latches.cookie_site.is_some() {
            latches.cookie_site = Some("cross-site");
        }
        sec
    }
    fn of_mode(&self, mode: &str) -> bool {
        self.mode.as_deref() == Some(mode)
    }
}

impl FetchHops {
    // (…the client's cookie judge its origin's where it is a mode's request — its document's or its initiator's — else
    // its document's URL, an opaque one's `null`)
    #[allow(clippy::too_many_arguments)]
    fn new(
        mode: Option<String>,
        dest: Option<String>,
        nav_dest: Option<String>,
        flags: u32,
        credentials: String,
        origins: RArray,
        cookie_documents: RArray,
        ancestors: RArray,
        worker_site: Option<String>,
    ) -> Result<Self, Error> {
        let origin_at = |i: isize| -> Result<Option<String>, Error> { origins.entry::<Option<String>>(i) };
        let (origin, doc_origin, client_origin, sec_initiator) = (origin_at(0)?, origin_at(1)?, origin_at(2)?, origin_at(3)?);
        let (client_url, top_document): (Option<String>, Option<String>) = (cookie_documents.entry(0)?, cookie_documents.entry(1)?);
        let cookie_client = match mode {
            Some(_) => doc_origin.clone().or_else(|| sec_initiator.clone()),
            None if client_origin.as_deref() == Some("null") => Some("null".to_owned()),
            None => client_url.or_else(|| sec_initiator.clone()),
        };
        let reissued = mode.as_deref() == Some("navigate") && nav_dest.as_deref().is_some_and(|d| !d.is_empty());
        let client = Client {
            mode,
            dest,
            nav_dest,
            navigation: flags & NAVIGATION != 0,
            user_activated: flags & USER_ACTIVATED != 0,
            credentials,
            origin,
            doc_origin,
            client_origin,
            sec_initiator,
            cookie_client,
            top_document,
            ancestors: ancestors.into_iter().map(Option::<String>::try_convert).collect::<Result<_, _>>()?,
            worker_site: (flags & WORKER != 0).then_some(worker_site),
            reissued,
            cross_site_frame: flags & CROSS_SITE_FRAME != 0,
        };
        Ok(FetchHops { client, latches: RefCell::default() })
    }

    // #seed(site): the chain's Sec-Fetch-Site so far — a worker's re-fetch of a navigation its network hops widened.
    fn seed(&self, site: Option<String>) {
        self.latches.borrow_mut().sec_site = site.as_deref().map(static_site);
    }

    // #hop(target, method, origin, policy) -> [cross-origin CORS hop, sends cookies, Origin (nil none), Sec-Fetch
    // ([site, mode, dest, user, top-level]; nil none), cookie site (nil none), Lax exception] for the hop to `target` of
    // a request of `method` whose origin is `origin` ('null' tainted) under referrer policy `policy`.
    fn hop(&self, target: String, method: String, origin: Option<String>, policy: Option<String>) -> Hop {
        let c = &self.client;
        let mut latches = self.latches.borrow_mut();
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
        let sec = c.advance(&mut latches, &target).map(|site| {
            let dest = if c.navigation {
                c.nav_dest.clone().unwrap_or_default()
            } else {
                c.dest.clone().filter(|d| !d.is_empty()).unwrap_or_else(|| "empty".to_owned())
            };
            let top_level = c.of_mode("navigate") && c.nav_dest.as_deref() == Some("document");
            (site, c.mode.clone().unwrap_or_else(|| "no-cors".to_owned()), dest, c.navigation && c.user_activated, top_level)
        });
        // (…the Lax exception a top-level navigation's GET alone)
        let lax = c.of_mode("navigate") && method.eq_ignore_ascii_case("GET") && c.nav_dest.as_deref() == Some("document") && !c.cross_site_frame;
        (cross_origin, send_cookies, origin_value, sec, latches.cookie_site, lax)
    }

    // #cached(target): a hop the HTTP cache answered — a redirect it followed from the cache — is in the chain all the
    // same: its URL widens the Sec-Fetch-Site and cookie site latches as a network hop's does.
    fn cached(&self, target: String) {
        self.client.advance(&mut self.latches.borrow_mut(), &target);
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

const NAVIGATION: u32 = 1;
const USER_ACTIVATED: u32 = 2;
const CROSS_SITE_FRAME: u32 = 4;
const WORKER: u32 = 8;

pub(crate) fn define(native: RModule, ruby: &Ruby) -> Result<(), Error> {
    let class = native.define_class("FetchHops", ruby.class_object())?;
    class.define_singleton_method("new", function!(FetchHops::new, 9))?;
    class.define_method("seed", method!(FetchHops::seed, 1))?;
    class.define_method("hop", method!(FetchHops::hop, 4))?;
    class.define_method("cached", method!(FetchHops::cached, 1))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

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
            cross_site_frame: false,
        }
    }
    fn hops(client: Client) -> FetchHops {
        FetchHops { client, latches: RefCell::new(Latches::default()) }
    }

    #[test]
    fn a_hop_carries_its_origin_cookies_and_metadata() {
        let h = hops(client(Some("cors")));
        let (cross, cookies, origin, sec, site, _) = h.hop("http://b.test/x".into(), "GET".into(), Some("http://a.test".into()), None);
        assert!(cross && !cookies);
        assert_eq!(origin.as_deref(), Some("http://a.test"));
        assert_eq!(sec.map(|s| (s.0, s.1, s.2)), Some(("cross-site", "cors".to_owned(), "empty".to_owned())));
        assert_eq!(site, Some("cross-site"));
        // (…a hop back home keeps the chain's widest site, and a tainted origin is cross-origin everywhere)
        let (cross, cookies, origin, sec, site, _) = h.hop("http://a.test/y".into(), "GET".into(), Some("null".into()), None);
        assert!(cross && !cookies);
        assert_eq!(origin.as_deref(), Some("null"));
        assert_eq!((sec.map(|s| s.0), site), (Some("cross-site"), Some("cross-site")));
        // (…a same-origin GET carries no Origin; a POST does)
        let home = hops(client(Some("cors")));
        assert_eq!(home.hop("http://a.test/y".into(), "GET".into(), Some("http://a.test".into()), None).2, None);
        assert_eq!(home.hop("http://a.test/y".into(), "POST".into(), Some("http://a.test".into()), None).2.as_deref(), Some("http://a.test"));
    }

    #[test]
    fn a_mode_less_load_is_judged_by_every_document_above_it() {
        // (…no metadata for a load that names no destination; cookies sent, as no document origin bars them)
        let plain = hops(client(None));
        let (cross, cookies, origin, sec, site, _) = plain.hop("http://a.test/img".into(), "GET".into(), None, None);
        assert!(!cross && cookies && origin.is_none() && sec.is_none());
        assert_eq!(site, Some("same-origin"));
        let framed = hops(Client { ancestors: vec![Some("http://top.test/".into())], ..client(None) });
        assert_eq!(framed.hop("http://a.test/img".into(), "GET".into(), None, None).4, Some("cross-site"));
        let under = hops(Client { top_document: Some("http://top.test/".into()), ..client(None) });
        assert_eq!(under.hop("http://a.test/img".into(), "GET".into(), None, None).4, Some("cross-site"));
        // (…a worker's by the site it was made with — of none, cross-site everywhere)
        let worker = hops(Client { worker_site: Some(Some("http://a.test".into())), ..client(None) });
        assert_eq!(worker.hop("http://a.test/w".into(), "GET".into(), None, None).4, Some("same-origin"));
        let siteless = hops(Client { worker_site: Some(None), ..client(None) });
        assert_eq!(siteless.hop("http://a.test/w".into(), "GET".into(), None, None).4, Some("cross-site"));
    }

    #[test]
    fn a_navigation_keeps_lax_cookies_at_the_top_level_alone() {
        let nav = Client { nav_dest: Some("document".into()), navigation: true, user_activated: true, ..client(Some("navigate")) };
        let (_, _, _, sec, _, lax) = hops(nav).hop("http://b.test/".into(), "GET".into(), Some("http://a.test".into()), None);
        assert_eq!(sec.map(|s| (s.2, s.3, s.4)), Some(("document".to_owned(), true, true)));
        assert!(lax);
        let framed = Client { nav_dest: Some("document".into()), cross_site_frame: true, ..client(Some("navigate")) };
        let (_, _, _, _, site, lax) = hops(framed).hop("http://a.test/".into(), "GET".into(), Some("http://a.test".into()), None);
        assert_eq!(site, Some("cross-site"));
        assert!(!lax);
    }

    #[test]
    fn a_chain_seeds_reissues_and_caches_its_latches() {
        // (…a seed the chain's widest site so far, a cached hop in the chain too)
        let seeded = hops(client(Some("no-cors")));
        seeded.seed(Some("same-site".into()));
        assert_eq!(seeded.hop("http://a.test/x".into(), "GET".into(), None, None).3.map(|s| s.0), Some("same-site"));
        let cached = hops(client(Some("no-cors")));
        cached.cached("http://b.test/r".into());
        let (_, _, _, sec, site, _) = cached.hop("http://a.test/x".into(), "GET".into(), None, None);
        assert_eq!((sec.map(|s| s.0), site), (Some("cross-site"), Some("cross-site")));
        // (…a re-issued navigation's cookies the chain's verdict, not its client's)
        let reissued = hops(Client { reissued: true, nav_dest: Some("document".into()), ..client(Some("navigate")) });
        reissued.seed(Some("cross-site".into()));
        assert_eq!(reissued.hop("http://a.test/x".into(), "GET".into(), None, None).4, Some("cross-site"));
        // (…an opaque-origin client's request cross-site wherever it goes)
        let opaque = hops(Client { client_origin: Some("null".into()), ..client(Some("cors")) });
        assert_eq!(opaque.hop("http://a.test/x".into(), "GET".into(), None, None).3.map(|s| s.0), Some("cross-site"));
        // (…a frame with a cross-site ancestor cross-site, and so on the next hop)
        let frame = hops(Client { cross_site_frame: true, ..client(None) });
        assert_eq!(frame.hop("http://a.test/x".into(), "GET".into(), None, None).4, Some("cross-site"));
        assert_eq!(frame.hop("http://a.test/y".into(), "GET".into(), None, None).4, Some("cross-site"));
    }

    #[test]
    fn a_no_cors_post_sends_its_origin_as_its_policy_lets_it() {
        let h = hops(client(Some("no-cors")));
        let origin = |policy: &str, target: &str| h.hop(target.into(), "POST".into(), Some("https://a.test".into()), Some(policy.into())).2;
        assert_eq!(origin("", "https://a.test/x").as_deref(), Some("https://a.test"));
        assert_eq!(origin("same-origin", "https://b.test/x").as_deref(), Some("null"));
        assert_eq!(origin("", "http://a.test/x").as_deref(), Some("null"));
    }
}
