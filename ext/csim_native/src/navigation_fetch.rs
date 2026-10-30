// A navigation's fetch, hop by hop (HTML "create navigation params by fetching": the request the navigation makes, its
// redirects followed as Fetch "HTTP-redirect fetch" follows them): the request as it stands (fetch_chain.rs — its method
// and body, its URL, its origin tainted by a redirect, its referrer source narrowed by the Referer each hop sent and the
// policy a redirect's `Referrer-Policy` sets), the site Sec-Fetch-Site latches across the chain, whether its cookies are
// cross-site by the documents above the navigable it navigates, and whether a hop to another origin wants the
// navigation's reserved client made anew (one is origin-bound) — and the context its cookies are sent and its responses'
// stored in (cookie_jar.rs `request_context`). The host keeps the transport, a service worker's round-trip, the
// document, the session history; it asks this twice a hop (`begin_hop`, `response`).

use std::cell::RefCell;

use magnus::{function, method, prelude::*, Error, IntoValue, RArray, RHash, RModule, Ruby, TryConvert, Value};

use crate::cookie_jar::request_context;
use crate::fetch_chain::{Followed, Judged, RequestChain, MAX_REDIRECTS};
use crate::referrer::{cross_site_for_cookies, fetch_site, http_origin, wider_site};

struct Nav {
    chain: RequestChain,
    // The URL Sec-Fetch-Site measures from (its initiating document's — an about:blank one's creator's), none for one no
    // document began (a user's); the site latched over the hops so far.
    initiator: Option<String>,
    site: Option<&'static str>,
    // The documents above the navigable it navigates — the one its container is in, and that one's up to the top — by
    // which its cookies are cross-site; none for a navigation no such document's site judges.
    ancestors: Option<Vec<Option<String>>>,
    // Whether it navigates a top-level navigable, whose request may retrieve a Lax cookie by a safe method and whose
    // response may set a SameSite one however cross-site.
    top_level: bool,
}

impl Nav {
    // The hop's cookie context, and whether the documents above the navigable are cross-site to its URL: cross-site where
    // they are, or where the site Sec-Fetch-Site latched so far (`hop_site`) is.
    fn cookies(&self, hop_site: &str) -> (bool, u32) {
        let target = &self.chain.target;
        let frame_cross = self.ancestors.as_ref().is_some_and(|a| a.iter().any(|u| cross_site_for_cookies(u.as_deref(), target)));
        let secure = http_origin(target).as_deref().is_some_and(crate::url_ops::potentially_trustworthy);
        let safe = self.chain.method == "GET";
        (frame_cross, request_context(secure, hop_site == "cross-site" || frame_cross, self.top_level && safe, self.top_level))
    }
}

#[magnus::wrap(class = "Capybara::Simulated::Native::NavigationFetch", free_immediately)]
pub(crate) struct NavigationFetch {
    // The origin its request is of (its initiator's), which a redirect is judged against.
    origin: String,
    st: RefCell<Nav>,
}

// The schemes a fetch goes to (Fetch "fetch scheme"): a navigation redirected to any other is handed off.
const FETCH_SCHEMES: [&str; 6] = ["about:", "blob:", "data:", "file:", "http:", "https:"];

fn static_site(site: &str) -> &'static str {
    match site {
        "same-origin" => "same-origin",
        "same-site" => "same-site",
        "none" => "none",
        _ => "cross-site",
    }
}

impl NavigationFetch {
    // NavigationFetch.new(request) -> the fetch `request` describes, by name: `method`, `url`, `body_empty`, `referrer`
    // (the referrer source, nil none), `referrer_policy`, `initiator` (the URL Sec-Fetch-Site and the request's origin are
    // of, nil none), `origin` (the request's origin serialized, where it is not its initiator's — a re-post's, the one it
    // was first sent with: the document state's initiator origin — nil none), `origin_null` (an opaque initiator's: its
    // origin `null`, its site cross-site), `site_seed` (a latch carried in, nil none), `ancestors` (the document URLs its
    // cookies are judged by — nil none, each nil for one not known), `top_level` (whether it navigates a top-level
    // navigable).
    fn new(ruby: &Ruby, request: RHash) -> Result<Self, Error> {
        let get = |key: &str| request.aref::<_, Value>(ruby.to_symbol(key));
        let text = |key: &str| -> Result<Option<String>, Error> { Option::<String>::try_convert(get(key)?) };
        let initiator = text("initiator")?.filter(|u| !u.is_empty());
        let origin = text("origin")?.filter(|o| !o.is_empty()).or_else(|| initiator.as_deref().and_then(http_origin));
        let opaque = get("origin_null")?.to_bool() || origin.as_deref() == Some("null");
        let ancestors: Option<RArray> = Option::try_convert(get("ancestors")?)?;
        let ancestors = ancestors.map(|a| a.into_iter().map(Option::<String>::try_convert).collect::<Result<Vec<_>, _>>()).transpose()?;
        Ok(NavigationFetch {
            origin: origin.clone().unwrap_or_default(),
            st: RefCell::new(Nav {
                chain: RequestChain {
                    method: text("method")?.filter(|m| !m.is_empty()).map_or_else(|| "GET".to_owned(), |m| m.to_ascii_uppercase()),
                    target: text("url")?.unwrap_or_default(),
                    headers: Vec::new(),
                    body_empty: get("body_empty")?.to_bool(),
                    effective_origin: if opaque { Some("null".to_owned()) } else { origin },
                    ref_policy: text("referrer_policy")?,
                    ref_source: text("referrer")?.filter(|u| !u.is_empty()),
                    redirected: false,
                    dispatches: 0,
                },
                initiator,
                site: text("site_seed")?.as_deref().map(static_site),
                ancestors,
                top_level: get("top_level")?.to_bool(),
            }),
        })
    }

    // #begin_hop -> [method, URL, body gone, referrer source, referrer policy, site seed, Sec-Fetch-Site, origin tainted,
    // frame cross-site, cookie context]: the hop to make — through a service worker that controls it (its request of the
    // site seed so far, and of whether the documents above the navigable are cross-site to it) or the network (its
    // Sec-Fetch-Site this hop's, its cookies sent and its response's stored in the context: `Nav::cookies`). (…never a
    // 22nd: `redirect` fails the 21st's redirect as it is reached)
    fn begin_hop(ruby: &Ruby, rb_self: &Self) -> RArray {
        let mut st = rb_self.st.borrow_mut();
        st.chain.dispatch();
        let target = st.chain.target.clone();
        let hop_site = wider_site(st.site, fetch_site(st.initiator.as_deref().unwrap_or(""), &target));
        let (frame_cross, cookies) = st.cookies(hop_site);
        ruby.ary_from_iter([
            st.chain.method.clone().into_value_with(ruby),
            target.into_value_with(ruby),
            st.chain.body_empty.into_value_with(ruby),
            st.chain.ref_source.clone().into_value_with(ruby),
            st.chain.ref_policy.clone().into_value_with(ruby),
            st.site.into_value_with(ruby),
            hop_site.into_value_with(ruby),
            (st.chain.effective_origin.as_deref() == Some("null")).into_value_with(ruby),
            frame_cross.into_value_with(ruby),
            cookies.into_value_with(ruby),
        ])
    }

    // #redirect(status, location, policy) -> what a redirect response of the hop makes of the navigation, its Location
    // `location`, its `Referrer-Policy` (parsed) `policy`: ['follow', body gone, new client] — the next hop, its request
    // a GET where the redirect makes one, a hop to another origin wanting the reserved client made anew — ['hand_off'] —
    // a URL of no fetch scheme (`mailto:`, an app's own), handed off to external software, the navigable keeping its
    // document (HTML "create navigation params by fetching": non-fetch-scheme navigation params) — or ['fail']: a
    // network error (a Location no URL, a fetch scheme no HTTP(S) one, a port blocked, the 21st hop).
    fn redirect(ruby: &Ruby, rb_self: &Self, status: u32, location: magnus::RString, policy: Option<String>) -> Result<RArray, Error> {
        let mut st = rb_self.st.borrow_mut();
        let out = ruby.ary_new();
        // (…the 21st hop's redirect a network error as it is reached — Fetch "HTTP-redirect fetch": a request redirected 20
        // times already — not a hop of its own)
        if st.chain.dispatches > MAX_REDIRECTS {
            let _ = out.push("fail");
            return Ok(out);
        }
        let target = st.chain.target.clone();
        // (…the Referer it sent: the next hop's referrer source; the site it was at, latched)
        let sent = st.chain.referer();
        st.site = Some(wider_site(st.site, fetch_site(st.initiator.as_deref().unwrap_or(""), &target)));
        let judged = Judged { cors: false, origin: &rb_self.origin, tainting_cors: false };
        let location = crate::fetch_rules::ruby_bytes(location);
        let location_text = String::from_utf8_lossy(&location).into_owned();
        match st.chain.follow(status, &[location], &judged) {
            Followed::Follow(from, to_get) => {
                st.chain.refer_on(sent, policy);
                let new_client = http_origin(&from) != http_origin(&st.chain.target);
                let _ = out.push("follow");
                let _ = out.push(to_get);
                let _ = out.push(new_client);
            }
            Followed::Answer | Followed::Fail => {
                let handed_off = ada_url::Url::parse(&location_text, Some(&target)).is_ok_and(|u| !FETCH_SCHEMES.contains(&u.protocol()));
                let _ = out.push(if handed_off { "hand_off" } else { "fail" });
            }
        }
        Ok(out)
    }

    // #target / #request_method / #redirected? / #referrer: the request as it stands, and the Referer its last hop sent
    // — the referrer of the document its response makes.
    fn target(&self) -> String {
        self.st.borrow().chain.target.clone()
    }
    fn request_method(&self) -> String {
        self.st.borrow().chain.method.clone()
    }
    fn redirected(&self) -> bool {
        self.st.borrow().chain.redirected
    }
    fn referrer(&self) -> Option<String> {
        self.st.borrow().chain.referer()
    }
}

pub(crate) fn define(native: RModule, ruby: &Ruby) -> Result<(), Error> {
    let class = native.define_class("NavigationFetch", ruby.class_object())?;
    class.define_singleton_method("new", function!(NavigationFetch::new, 1))?;
    class.define_method("begin_hop", method!(NavigationFetch::begin_hop, 0))?;
    class.define_method("redirect", method!(NavigationFetch::redirect, 3))?;
    class.define_method("target", method!(NavigationFetch::target, 0))?;
    class.define_method("request_method", method!(NavigationFetch::request_method, 0))?;
    class.define_method("redirected?", method!(NavigationFetch::redirected, 0))?;
    class.define_method("referrer", method!(NavigationFetch::referrer, 0))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn nav(method: &str, url: &str, initiator: &str) -> Nav {
        Nav {
            chain: RequestChain {
                method: method.to_owned(),
                target: url.to_owned(),
                headers: Vec::new(),
                body_empty: false,
                effective_origin: http_origin(initiator),
                ref_policy: None,
                ref_source: Some(initiator.to_owned()),
                redirected: false,
                dispatches: 0,
            },
            initiator: Some(initiator.to_owned()),
            site: None,
            ancestors: Some(vec![Some("http://a.test/top".to_owned())]),
            top_level: false,
        }
    }

    #[test]
    fn a_redirect_latches_the_site_and_narrows_the_referrer_by_its_policy() {
        let mut st = nav("POST", "http://a.test/form", "http://a.test/page");
        let judged = Judged { cors: false, origin: "http://a.test", tainting_cors: false };
        let sent = st.chain.referer();
        st.site = Some(wider_site(st.site, fetch_site("http://a.test/page", "http://a.test/form")));
        assert!(matches!(st.chain.follow(307, &[b"http://b.test/x".to_vec()], &judged), Followed::Follow(_, false)));
        st.chain.refer_on(sent, Some("origin".to_owned()));
        assert_eq!(st.chain.referer().as_deref(), Some("http://a.test/"));
        assert_eq!(wider_site(st.site, fetch_site("http://a.test/page", &st.chain.target)), "cross-site");
        assert!(cross_site_for_cookies(Some("http://a.test/top"), &st.chain.target));
    }

    #[test]
    fn a_hop_sends_its_cookies_as_its_navigable_and_its_site_judge_them() {
        use crate::cookie_jar::{CROSS_SITE, LAX_RETRIEVE, TOP_LEVEL_NAV};
        // (…a frame's by the documents above it: cross-site to them, no Lax exception, no top-level one)
        let frame = nav("GET", "http://b.test/f", "http://a.test/page");
        let (frame_cross, ctx) = frame.cookies("cross-site");
        assert!(frame_cross);
        assert_eq!(ctx & (CROSS_SITE | LAX_RETRIEVE | TOP_LEVEL_NAV), CROSS_SITE);
        // (…a top-level navigation's by its site: a cross-site GET's request may retrieve a Lax cookie, a POST's not,
        // and either's response may set a SameSite one)
        let top = Nav { ancestors: None, top_level: true, ..nav("GET", "http://b.test/", "http://a.test/page") };
        assert_eq!(top.cookies("cross-site").1 & (CROSS_SITE | LAX_RETRIEVE | TOP_LEVEL_NAV), CROSS_SITE | LAX_RETRIEVE | TOP_LEVEL_NAV);
        let post = Nav { ancestors: None, top_level: true, ..nav("POST", "http://a.test/", "http://a.test/page") };
        assert_eq!(post.cookies("same-origin").1 & (CROSS_SITE | LAX_RETRIEVE | TOP_LEVEL_NAV), TOP_LEVEL_NAV);
    }
}
