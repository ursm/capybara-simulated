// A navigation's fetch, hop by hop (HTML "create navigation params by fetching": the request the navigation makes, its
// redirects followed as Fetch "HTTP-redirect fetch" follows them): the request as it stands (fetch_chain.rs — its method
// and body, its URL, its origin tainted by a redirect, its referrer source narrowed by the Referer each hop sent and the
// policy a redirect's `Referrer-Policy` sets), the site Sec-Fetch-Site latches across the chain, and whether a hop to
// another origin wants the navigation's reserved client made anew (one is origin-bound) — and the context its cookies
// are sent and its responses' stored in (cookie_jar.rs `request_context`), by Fetch's "determine the same-site mode"
// (`Nav::cookies`) — and what each response makes of the navigation (`response`): a redirect followed, a network error,
// a hand-off, no document (a 204 / 205, a download) or the document, a top-level traversable's opener policy enforced
// on every one. The host keeps the transport, a service worker's round-trip, the document, the session history; it
// asks this twice a hop (`begin_hop`, `response`).

use std::cell::RefCell;

use magnus::{function, method, prelude::*, Error, IntoValue, RArray, RHash, RModule, Ruby, TryConvert, Value};

use crate::cookie_jar::request_context;
use crate::coop::Value as Coop;
use crate::fetch_chain::{Followed, Judged, RequestChain, MAX_REDIRECTS};
use crate::response_headers::ResponseFields;
use crate::referrer::{cross_site_for_cookies, fetch_site, http_origin, wider_site, RedirectTaint};

struct Nav {
    chain: RequestChain,
    // The URL Sec-Fetch-Site and its cookies' site measure from (its initiating document's — an about:blank one's
    // creator's), none for one no document began (a user's); whether that document's origin is opaque — of no site,
    // cross-site to every URL — and whether it has a cross-site ancestor (HTML "has cross-site ancestor": the request's
    // client's, Fetch's step 4 reads); the Sec-Fetch-Site latched over the hops so far.
    initiator: Option<String>,
    initiator_opaque: bool,
    initiator_cross_site_ancestor: bool,
    site: Option<&'static str>,
    // A traversal's top-level navigation initiator origin (Fetch's step 2): the origin of the document that began the
    // navigation its entry was made by, which HTML keeps in the entry's document state — serialized, `null` an opaque
    // one's; none for one no document began, or for any other navigation, whose initiator is the one above.
    traversed_initiator: Option<String>,
    // The documents above the navigable it navigates — the one its container is in, and that one's up to the top — by
    // which its cookies are cross-site; none for a navigation no such document's site judges.
    ancestors: Option<Vec<Option<String>>>,
    // Whether it navigates a top-level navigable, whose request may retrieve a Lax cookie by a safe method and whose
    // response may set a SameSite one however cross-site.
    top_level: bool,
    // A reload through a user interface element's: whether the request the document it reloads was reached by was
    // cross-site, which its every hop is then (RFC 6265bis §5.2) — none for any other navigation.
    reloaded_cross: Option<bool>,
    // Whether its last hop's cookies were cross-site, which the document its response makes was reached by; and that
    // hop's cookie context (cookie_jar.rs `request_context`), its response's Set-Cookie stored in.
    cross: bool,
    cookies: u32,
}

impl Nav {
    // The hop's cookie context, and whether a document above the navigable is cross-site to its URL — by Fetch's
    // "determine the same-site mode": cross-site where the hop's URL is cross-site to the initiator's origin (step 2,
    // `initiator_cross_site`), where "request's client's has cross-site ancestor is true" (step 4: the
    // INITIATOR's, as the client of a navigation is its initiating document's environment), or where the chain's
    // redirect-taint is "cross-site" (step 5).
    // - Step 2, "If request's top-level navigation initiator origin is non-null and is not same site with request's URL's
    //   origin, then return 'unset-or-less'", is not applied to a top-level GET: read as it stands it would
    //   withhold the Lax cookie from every cross-site top-level GET — a link from another site's page — which no browser
    //   does, and which is the very request a Lax cookie is for. Such a GET is cross-site and Lax
    //   (`LAX_RETRIEVE`), as step 3 below would make it; any other request takes step 2 as it stands. So step 3 is not
    //   the only step whose text is not applied as written.
    // - Step 3, "If request's method is 'GET' and request's destination is 'document', then return 'lax-or-less'", read as
    //   it stands would withhold the Strict cookie from every top-level GET, a same-site one's too, which no browser does
    //   (Chrome and Firefox both send it): a top-level GET keeps Strict where steps 2 and 5 leave it same-site, and is Lax
    //   (`LAX_RETRIEVE`) where they do not — so a→b→a's top-level GET back to a is Lax, as Firefox 159 makes it (Chrome
    //   156 sends Strict; measured 2026-10-31) — and step 4, which it returns before, it never reads.
    // - Step 4 makes a top-level POST from a frame of a's under b's page cross-site, its Strict and Lax cookies withheld,
    //   though Chrome 156 and Firefox 159 both send them (measured 2026-10-31: a form's POST into a new window); Fetch's
    //   text is explicit, and the spec wins.
    // - A frame's navigation is cross-site where a document above the frame it navigates is (`frame_cross`): not Fetch's
    //   step 4, which reads the initiator's, but the cookie layer's — the Lax exception is a top-level navigation's alone,
    //   and the WPT double-nested-frame tests expect a frame under a cross-site one judged so whoever navigates it.
    // A reload through a user interface element's where the request it reloads was, never otherwise (RFC 6265bis §5.2).
    // Its response stores a SameSite cookie however cross-site where it is a top-level navigation's (`TOP_LEVEL_NAV`: RFC
    // 6265bis §5.7, as browsers do) — Fetch's "parse and store response `Set-Cookie` headers" would allow one only at
    // "strict-or-less", which step 3 makes no top-level GET's.
    fn cookies(&self) -> (bool, u32) {
        let target = &self.chain.target;
        let frame_cross = self.ancestors.as_ref().is_some_and(|a| a.iter().any(|u| cross_site_for_cookies(u.as_deref(), target)));
        let safe = self.chain.method == "GET";
        let top_level_get = self.top_level && safe;
        let cross = self.reloaded_cross.unwrap_or_else(|| {
            frame_cross
                || self.initiator_cross_site(target)
                || (!top_level_get && self.initiator_cross_site_ancestor)
                || self.chain.taint.cross_site()
        });
        let secure = http_origin(target).as_deref().is_some_and(crate::url_ops::potentially_trustworthy);
        (frame_cross, request_context(secure, cross, top_level_get, self.top_level))
    }
    // Whether `target` is cross-site to the initiator: by its origin — an opaque one's to every URL — not by the site for
    // cookies of the documents above it (RFC 6265bis §5.2.1), as Fetch's "determine the same-site mode" judges a
    // top-level navigation by its "top-level navigation initiator origin", and as Chrome 156 and Firefox 159 do (measured
    // 2026-10-31: a popup a's frame under b's page opens to a gets the Strict cookie in both); same-site for a navigation
    // no document began (a request of no client). A frame's navigation is cross-site by the documents above the frame
    // as well (`Nav::cookies`).
    // A traversal's, begun by no document, by the initiator origin its entry's document state keeps (HTML "create
    // navigation params by fetching": "set request's top-level navigation initiator origin to entry's document state's
    // initiator origin").
    fn initiator_cross_site(&self, target: &str) -> bool {
        self.initiator_opaque
            || fetch_site(self.initiator.as_deref().unwrap_or(""), target) == "cross-site"
            || self.traversed_initiator.as_deref().is_some_and(|origin| cross_site_for_cookies(Some(origin), target))
    }
}

#[magnus::wrap(class = "Capybara::Simulated::Native::NavigationFetch", free_immediately)]
pub(crate) struct NavigationFetch {
    // The origin a redirect judges its request by and walks its redirect-taint with (fetch_chain.rs): a traversal's its
    // client's (`client_origin`), else its request's origin — its initiator's, `null` an opaque one's — else a new opaque
    // one's, `null`: a navigation of the user's, of no client (HTML "create navigation params by fetching": "If request's
    // client is null … Set request's origin to a new opaque origin").
    origin: String,
    // What its network requests say of it beside the chain's state: its destination (`document`, `iframe`), whether its
    // source snapshot had transient activation (`Sec-Fetch-User`), whether it has an origin to send (a navigation some
    // document began, or a re-post of one), and the cookie jar its cookies come from and go to (cookie_jar.rs; none, 0).
    dest: String,
    user_activated: bool,
    has_origin: bool,
    jar: u64,
    // Whether a service worker may answer its hops: none where no registration could (the session has none), else
    // whether its navigable may be controlled at an HTTPS URL — a client is controlled only where every ancestor is a
    // secure context (secure-context.https) — and the top-level site its registration is matched in, a frame's its
    // container's top-level traversable's (none: each hop's own URL's, a top-level navigable's).
    sw: Option<(bool, Option<String>)>,
    st: RefCell<Nav>,
    // A top-level traversable's navigation's opener policy enforcement, none for a frame's.
    coop: RefCell<Option<CoopEnforcement>>,
}

// HTML's opener policy enforcement result as a navigation's responses come ("enforce a response's opener policy"): the
// policy and origin the next response is judged against — the navigable's document's before the first (its origin none
// until it is asked for), the previous response's after — and whether a browsing context group switch is needed, once
// needed needed whatever comes after. The facts of the document it leaves are the host's to give, asked once and only
// where a policy but "unsafe-none" is in play: its origin serialized, whether it is its initial about:blank, and its
// navigable's popup sandboxing flag set.
struct CoopEnforcement {
    coop: Coop,
    origin: Option<String>,
    facts: Option<(String, bool, u32)>,
    switch: bool,
}

impl CoopEnforcement {
    // The response at `url` of opener policy `response` and Content-Security-Policy `csp`, enforced: false — a network
    // error — for one of a policy but "unsafe-none" to a navigable sandboxed, by its popup sandboxing flags or that
    // policy's `sandbox` (HTML "create navigation params by fetching" step 12.3, finalSandboxFlags); else the switch
    // judged against what it follows by coop.rs `switch_needed` (HTML "check if COOP values require a browsing context
    // group switch", the popup check where the document is its initial about:blank), and the next judged against this
    // one. (…the host asked nothing where both are "unsafe-none", which match: every hop of a page that sets none)
    fn enforce<E>(&mut self, response: Coop, csp: Option<&str>, url: &str, facts: impl FnOnce() -> Result<(String, bool, u32), E>) -> Result<bool, E> {
        let origin = http_origin(url).unwrap_or_default();
        if self.coop != Coop::UnsafeNone || response != Coop::UnsafeNone {
            if self.facts.is_none() {
                self.facts = Some(facts()?);
            }
            let (document_origin, initial, popup) = self.facts.clone().unwrap_or_default();
            if response != Coop::UnsafeNone && popup | crate::sandbox::sandboxing(csp, None) != 0 {
                return Ok(false);
            }
            let from = self.origin.get_or_insert(document_origin);
            self.switch |= crate::coop::switch_needed(initial, from, self.coop, &origin, response);
        }
        self.coop = response;
        self.origin = Some(origin);
        Ok(true)
    }
}

// (…a command and its payload, as the host reads it: `[name, *payload]`)
fn command(ruby: &Ruby, name: &str, payload: &[Value]) -> RArray {
    let out = ruby.ary_new_capa(payload.len() + 1);
    let _ = out.push(name);
    for v in payload {
        let _ = out.push(*v);
    }
    out
}

// `NavigationFetch#start`'s answer for a navigation to `url` by `method` — and, `refuses_data`, a document's navigation
// of a top-level traversable, `refused` for a `data:` URL it would render, or none at all (`data_navigation`), before
// anything of the navigation begins. Native.navigation_start(url, method, refuses_data) -> it, for a navigation the host
// asks before it makes its NavigationFetch (a top-level traversable's: its document is asked whether it may be unloaded
// only for one that goes on).
pub(crate) fn start(url: &str, method: &str, refuses_data: bool) -> &'static str {
    let parsed = ada_url::Url::parse(url, None).ok();
    let protocol = parsed.as_ref().map_or("", |u| u.protocol());
    if parsed.as_ref().is_some_and(crate::url_ops::matches_about_blank) {
        "about_blank"
    } else if method == "GET" && protocol == "blob:" {
        "blob"
    } else if protocol == "data:" {
        if refuses_data && data_navigation(url).0 != "download" { "refused" } else { "data" }
    } else if protocol == "about:" || (method != "GET" && !matches!(protocol, "http:" | "https:")) {
        "fail"
    } else {
        "fetch"
    }
}
pub(crate) fn start_for_ruby(url: String, method: String, refuses_data: bool) -> &'static str {
    start(&url, &method.to_ascii_uppercase(), refuses_data)
}

// What a navigation to the `data:` URL `url` comes to, Fetch's scheme fetch its response: `fail` where it is no data:
// URL's (a network error); `download` where its MIME type makes no document (mime.rs `makes_document`) — handed off,
// whoever navigates; else `document`, of a new opaque origin. A document's navigation of a top-level traversable to one
// that is no download is refused before it begins (`start`, `refuses_data`): HTML has no such rule; Chrome and Firefox
// refuse a link's, a form's, `location`'s, a refresh's, `open(url, '_self')`'s, leave a new window one opens at
// about:blank, and let the user's — the address bar, the driver's `visit` — and a download through (measured
// 2026-10-30 and 2026-11-01).
pub(crate) fn data_navigation(url: &str) -> (&'static str, Option<(String, Vec<u8>)>) {
    let is_data = url.get(..5).is_some_and(|s| s.eq_ignore_ascii_case("data:"));
    match is_data.then(|| crate::data_url::process(url)).flatten() {
        None => ("fail", None),
        Some(r) if !crate::mime::makes_document(Some(&r.0)) => ("download", Some(r)),
        Some(r) => ("document", Some(r)),
    }
}
// Native.data_navigation(url) -> [verdict, MIME type, body] (`data_navigation`; nil each but the verdict for one of no
// response).
pub(crate) fn data_navigation_for_ruby(ruby: &Ruby, url: String) -> (&'static str, Option<String>, Option<magnus::RString>) {
    let (verdict, response) = data_navigation(&url);
    let (mime, body) = response.map_or((None, None), |(m, b)| (Some(m), Some(ruby.str_from_slice(&b))));
    (verdict, mime, body)
}

// The schemes a fetch goes to (Fetch "fetch scheme"): a navigation redirected to any other is handed off.
const FETCH_SCHEMES: [&str; 6] = ["about:", "blob:", "data:", "file:", "http:", "https:"];

impl NavigationFetch {
    // NavigationFetch.new(request) -> the fetch `request` describes, by name: `method`, `url`, `body_empty`, `referrer`
    // (the referrer source, nil none), `referrer_policy`, `initiator` (the URL Sec-Fetch-Site and the request's origin are
    // of, nil none), `origin` (the request's origin serialized, where it is not its initiator's — a re-post's, the one it
    // was first sent with: the document state's initiator origin — nil none), `origin_null` (an opaque initiator's: its
    // origin `null`, its site cross-site), `initiator_cross_site_ancestor` (whether the initiating document has a
    // cross-site ancestor: referrer.rs `requestClient`), `ancestors` (the document origins above the navigable its cookies
    // are judged by — nil none, each nil for one not known), `dest` (its destination: `document` a top-level navigable's,
    // whose request may retrieve a Lax cookie by a safe method and whose response may set a SameSite one; `iframe` a
    // frame's), `user_activated` (whether its source snapshot had transient activation), `jar` (the session's cookie jar,
    // nil none), `sw` (nil where no service worker can answer it — no registration — else [whether its navigable may be
    // controlled at an HTTPS URL, the top-level site a registration is matched in: nil each hop's URL's]),
    // `reloaded_cross_site` (a reload through a user interface element's: whether the request the document it reloads was
    // reached by was cross-site, `#cross_site?` that one's — nil for any other navigation), `client_origin` (a traversal's
    // or a user's reload's, of no initiator: its request's client's origin serialized — its navigable's active
    // document's, as HTML "apply the history step" snapshots that document's source snapshot params where none is given,
    // "as if navigable navigated itself" — which its redirect-taint is walked with in place of `origin`: its Origin, a
    // re-post's the one it was first sent with, and its Sec-Fetch-Site still a user's; nil none), `traversed_initiator`
    // (a top-level traversal's, of no initiator: its entry's document state's initiator origin, serialized — which its
    // cookies are judged by alone, Fetch's step 2; nil none), `coop` (a top-level traversable's: the opener policy of its
    // document, by its name — coop.rs — which its responses' are enforced against: `response`; nil a frame's, none).
    fn new(ruby: &Ruby, request: RHash) -> Result<Self, Error> {
        let get = |key: &str| request.aref::<_, Value>(ruby.to_symbol(key));
        let text = |key: &str| -> Result<Option<String>, Error> { Option::<String>::try_convert(get(key)?) };
        let initiator = text("initiator")?.filter(|u| !u.is_empty());
        let given_origin = text("origin")?.filter(|o| !o.is_empty());
        let has_origin = initiator.is_some() || given_origin.is_some();
        let origin = given_origin.or_else(|| initiator.as_deref().and_then(http_origin));
        let dest = text("dest")?.filter(|d| !d.is_empty()).unwrap_or_else(|| "iframe".to_owned());
        let initiator_opaque = get("origin_null")?.to_bool();
        let opaque = initiator_opaque || origin.as_deref() == Some("null");
        let judged_origin = match text("client_origin")?.filter(|o| !o.is_empty()) {
            Some(client) => client,
            None if initiator_opaque => "null".to_owned(),
            None => origin.clone().unwrap_or_else(|| "null".to_owned()),
        };
        let ancestors: Option<RArray> = Option::try_convert(get("ancestors")?)?;
        let ancestors = ancestors.map(|a| a.into_iter().map(Option::<String>::try_convert).collect::<Result<Vec<_>, _>>()).transpose()?;
        let coop = text("coop")?.map(|name| CoopEnforcement { coop: Coop::named(&name), origin: None, facts: None, switch: false });
        Ok(NavigationFetch {
            origin: judged_origin,
            user_activated: get("user_activated")?.to_bool(),
            has_origin,
            jar: Option::<u64>::try_convert(get("jar")?)?.unwrap_or(0),
            sw: Option::<(bool, Option<String>)>::try_convert(get("sw")?)?,
            coop: RefCell::new(coop),
            st: RefCell::new(Nav {
                chain: RequestChain {
                    method: text("method")?.filter(|m| !m.is_empty()).map_or_else(|| "GET".to_owned(), |m| m.to_ascii_uppercase()),
                    target: text("url")?.unwrap_or_default(),
                    headers: Vec::new(),
                    body_empty: get("body_empty")?.to_bool(),
                    effective_origin: if opaque { Some("null".to_owned()) } else { origin },
                    taint: RedirectTaint::default(),
                    ref_policy: text("referrer_policy")?,
                    ref_source: text("referrer")?.filter(|u| !u.is_empty()),
                    passed: Vec::new(),
                    dispatches: 0,
                },
                initiator,
                initiator_opaque,
                initiator_cross_site_ancestor: get("initiator_cross_site_ancestor")?.to_bool(),
                site: initiator_opaque.then_some("cross-site"),
                traversed_initiator: text("traversed_initiator")?.filter(|o| !o.is_empty()),
                ancestors,
                top_level: dest == "document",
                reloaded_cross: Option::<bool>::try_convert(get("reloaded_cross_site")?)?,
                cross: false,
                cookies: 0,
            }),
            dest,
        })
    }

    // #begin_hop(now) -> [method, URL, network headers, referrer source, referrer policy, site seed, origin tainted, frame
    // cross-site, cookie context, worker site]: the hop to make — through a service worker that controls it, where one may
    // (`worker site` the top-level site its registration is matched in, nil where none may: `sw_site`; its request of the
    // site seed so far, of whether the documents above the navigable are cross-site to it, and of whether its cookies
    // are cross-site: `#cross_site?`) or the network, whose request carries `network headers` (`request_headers`: its
    // Rack env's `HTTP_*` pairs, its cookies from the jar at `now`). (…never a 22nd: `redirect` fails the 21st's redirect
    // as it is reached)
    fn begin_hop(ruby: &Ruby, rb_self: &Self, now: f64) -> RArray {
        let mut st = rb_self.st.borrow_mut();
        st.chain.dispatch();
        let target = st.chain.target.clone();
        let (frame_cross, cookies) = st.cookies();
        st.cross = cookies & crate::cookie_jar::CROSS_SITE != 0;
        st.cookies = cookies;
        let headers = ruby.ary_new_capa(8);
        for (name, value) in rb_self.request_headers(&st, now) {
            let _ = headers.push((name, ruby.str_from_slice(&value)));
        }
        ruby.ary_from_iter([
            st.chain.method.clone().into_value_with(ruby),
            target.into_value_with(ruby),
            headers.as_value(),
            st.chain.ref_source.clone().into_value_with(ruby),
            st.chain.ref_policy.clone().into_value_with(ruby),
            st.site.into_value_with(ruby),
            (st.chain.effective_origin.as_deref() == Some("null")).into_value_with(ruby),
            frame_cross.into_value_with(ruby),
            cookies.into_value_with(ruby),
            rb_self.sw_site(&st.chain.target).into_value_with(ruby),
        ])
    }

    // The top-level site a service worker registration that may answer a hop to `target` is matched in — none where no
    // worker may: no registration, or an HTTPS URL its navigable may not be controlled at (an insecure ancestor). (…an
    // http one is let through whatever the ancestors: a scope prefix-matches its client URL, so an https registration
    // never controls it, and the driver's plain-http world — the app suites' http://www.example.com — is secure by fiat)
    fn sw_site(&self, target: &str) -> Option<String> {
        let (secure, site) = self.sw.as_ref()?;
        if !*secure && target.get(..8).is_some_and(|s| s.eq_ignore_ascii_case("https://")) {
            return None;
        }
        Some(site.clone().unwrap_or_else(|| crate::realm_location::site(target).unwrap_or_default()))
    }

    // The headers a hop's network request carries of the navigation (its Rack env keys): its Fetch metadata (Fetch
    // "append the Fetch metadata headers for a request": Sec-Fetch-Site the initiator's relation to the hop widened across
    // the chain — `none` a user's, an opaque initiator's cross-site — Sec-Fetch-Mode `navigate`, its destination, and
    // Sec-Fetch-User where its source snapshot had transient activation); its Referer (the chain's: its policy over the
    // source the previous hop left, as a URL is sent: referrer.rs `referrer_url`); its Origin, an unsafe method's alone
    // (Fetch "append a request `Origin` header": `null` once a redirect tainted it or its initiator is opaque, and where
    // its referrer policy withholds it); and its cookies, the jar's for its URL in the hop's context — none where a service
    // worker may answer the hop first: Fetch reads them as the network request is made, after the worker's leg (and its
    // preload), which may set some, so the host attaches them then.
    fn request_headers(&self, st: &Nav, now: f64) -> Vec<(&'static str, Vec<u8>)> {
        let target = &st.chain.target;
        let site = wider_site(st.site, fetch_site(st.initiator.as_deref().unwrap_or(""), target));
        let mut out: Vec<(&'static str, Vec<u8>)> = vec![
            ("HTTP_SEC_FETCH_SITE", site.as_bytes().to_vec()),
            ("HTTP_SEC_FETCH_MODE", b"navigate".to_vec()),
            ("HTTP_SEC_FETCH_DEST", self.dest.as_bytes().to_vec()),
        ];
        if self.user_activated {
            out.push(("HTTP_SEC_FETCH_USER", b"?1".to_vec()));
        }
        if let Some(referer) = st.chain.referer().as_deref().and_then(crate::referrer::referrer_url) {
            out.push(("HTTP_REFERER", referer.into_bytes()));
        }
        if self.has_origin && !matches!(st.chain.method.as_str(), "GET" | "HEAD") {
            let origin = st.chain.effective_origin.as_deref().unwrap_or("null");
            let policy = st.chain.ref_policy.as_deref().unwrap_or("");
            out.push(("HTTP_ORIGIN", crate::referrer::origin_header(origin, policy, target, false).as_bytes().to_vec()));
        }
        if self.jar != 0 && self.sw_site(target).is_none() {
            let cookies = crate::cookie_jar::retrieve(self.jar, target, st.cookies, now);
            if !cookies.is_empty() {
                out.push(("HTTP_COOKIE", cookies));
            }
        }
        out
    }

    // #response(status, headers, now) { facts } -> what the hop's response — of status `status`, its header map `headers`
    // (response_headers.rs; nil none) — makes of the navigation, HTML "create navigation params by fetching" and
    // "navigate", its Set-Cookie stored first in the hop's cookie context at `now` (nil for a response no network made: a
    // service worker's, whose own fetches store theirs):
    // - ['fail'] — a network error, its error document at `#target`: a response whose opener policy is enforced against a
    //   navigable sandboxed (by its popup sandboxing flags or the response's Content-Security-Policy: HTML's
    //   finalSandboxFlags, step 12.3), or a redirect that is not followed (`redirect`);
    // - ['redirect', body gone, new client] — the next hop (`redirect`);
    // - ['hand_off'] — a redirect to a URL of no fetch scheme, the navigable keeping its document;
    // - ['no_content'] — a 204 / 205: the navigation aborted, the navigable at the document it is at, no `load` and no
    //   session history entry (HTML "populate a session history entry's document"; Chrome, measured 2026-10-24: the
    //   page's link and form, a frame's form, link, `location` and `src` alike);
    // - ['download'] — a response that downloads (its Content-Disposition): handed off to be saved, no document made;
    // - ['document'] — the document it makes.
    // A top-level traversable's opener policy is enforced on each, a redirect's too (`enforce_coop`); the block gives the
    // facts of the document the navigation leaves, `[origin, initial about:blank, popup sandboxing flags]`, where they
    // are needed — asked once.
    fn response(ruby: &Ruby, rb_self: &Self, status: u32, headers: Option<Value>, now: Option<f64>) -> Result<RArray, Error> {
        let fields = ResponseFields::read(headers)?;
        if let Some(now) = now.filter(|_| rb_self.jar != 0) {
            let st = rb_self.st.borrow();
            crate::cookie_jar::store_lines(rb_self.jar, &st.chain.target, &fields.set_cookie, st.cookies, now);
        }
        if !rb_self.enforce_coop(ruby, &fields)? {
            return Ok(command(ruby, "fail", &[]));
        }
        if let Some(locations) = fields.redirect_locations(status) {
            return rb_self.redirect(ruby, status, &locations, fields.referrer_policy);
        }
        let outcome = if matches!(status, 204 | 205) {
            "no_content"
        } else if fields.downloads() {
            "download"
        } else {
            "document"
        };
        Ok(command(ruby, outcome, &[]))
    }

    // HTML "enforce a response's opener policy" (`CoopEnforcement::enforce`), true where the navigation goes on.
    fn enforce_coop(&self, ruby: &Ruby, fields: &ResponseFields) -> Result<bool, Error> {
        let mut slot = self.coop.borrow_mut();
        let Some(result) = slot.as_mut() else { return Ok(true) };
        let target = self.st.borrow().chain.target.clone();
        result.enforce(fields.opener_policy(), fields.csp.as_deref(), &target, || ruby.yield_value(ruby.qnil()))
    }

    // What a redirect response of the hop makes of the navigation, its Location fields `locations`, its
    // `Referrer-Policy` (parsed) `policy`: ['redirect', body gone, new client] — the next hop, its request a GET where the
    // redirect makes one, a hop to another origin wanting the reserved client made anew — ['hand_off'] — a URL of no
    // fetch scheme (`mailto:`, an app's own), handed off to external software, the navigable keeping its document (HTML
    // "create navigation params by fetching": non-fetch-scheme navigation params) — or ['fail']: a network error (a
    // Location no URL, one given more than once differently, a fetch scheme no HTTP(S) one, a port blocked, the 21st hop).
    fn redirect(&self, ruby: &Ruby, status: u32, locations: &[Vec<u8>], policy: Option<&str>) -> Result<RArray, Error> {
        let mut st = self.st.borrow_mut();
        // (…the 21st hop's redirect a network error as it is reached — Fetch "HTTP-redirect fetch": a request redirected 20
        // times already — not a hop of its own)
        if st.chain.dispatches > MAX_REDIRECTS {
            return Ok(command(ruby, "fail", &[]));
        }
        let target = st.chain.target.clone();
        // (…the Referer it sent: the next hop's referrer source; the site it was at, latched)
        let sent = st.chain.referer();
        st.site = Some(wider_site(st.site, fetch_site(st.initiator.as_deref().unwrap_or(""), &target)));
        let judged = Judged { cors: false, origin: &self.origin, tainting_cors: false };
        match st.chain.follow(status, locations, &judged) {
            Followed::Follow(from, to_get) => {
                st.chain.refer_on(sent, policy.map(str::to_owned));
                let new_client = http_origin(&from) != http_origin(&st.chain.target);
                Ok(command(ruby, "redirect", &[to_get.into_value_with(ruby), new_client.into_value_with(ruby)]))
            }
            Followed::Answer | Followed::Fail => {
                let handed_off = match locations {
                    [one] => ada_url::Url::parse(&String::from_utf8_lossy(one), Some(&target)).is_ok_and(|u| !FETCH_SCHEMES.contains(&u.protocol())),
                    _ => false,
                };
                Ok(command(ruby, if handed_off { "hand_off" } else { "fail" }, &[]))
            }
        }
    }

    // #start -> what the navigation's URL makes of it before any request (HTML "navigate", Fetch "scheme fetch"): 'about_blank'
    // — a URL that matches about:blank (url_ops.rs `matches_about_blank`), a document made of none, whatever its method —
    // 'blob' — a GET of a `blob:` URL, its blob's document — 'fail' — a network error: any other `about:` URL (`about:BLANK`
    // too: Fetch "scheme fetch" answers about:blank alone), any request but a GET to a URL no HTTP(S) one (a `blob:` URL is
    // fetched by a GET alone) — 'data' — a `data:` URL, its own response (`data_navigation`; one a document refuses refused
    // before: `start`) — or 'fetch', its hops to make (`begin_hop`).
    fn start(&self) -> &'static str {
        let st = self.st.borrow();
        start(&st.chain.target, &st.chain.method, false)
    }

    // #coop_switch? -> whether the navigation's responses need a browsing context group switch (`enforce_coop`).
    fn coop_switch(&self) -> bool {
        self.coop.borrow().as_ref().is_some_and(|c| c.switch)
    }

    // #target / #request_method / #redirected? / #referrer / #cross_site?: the request as it stands, the Referer its last
    // hop sent — the referrer of the document its response makes — and whether that hop's cookies were cross-site: the
    // request the document was reached by, which a reload of it through a user interface element is judged by.
    fn target(&self) -> String {
        self.st.borrow().chain.target.clone()
    }
    fn request_method(&self) -> String {
        self.st.borrow().chain.method.clone()
    }
    fn redirected(&self) -> bool {
        self.st.borrow().chain.redirected()
    }
    fn referrer(&self) -> Option<String> {
        self.st.borrow().chain.referer()
    }
    fn cross_site(&self) -> bool {
        self.st.borrow().cross
    }
}

pub(crate) fn define(native: RModule, ruby: &Ruby) -> Result<(), Error> {
    let class = native.define_class("NavigationFetch", ruby.class_object())?;
    class.define_singleton_method("new", function!(NavigationFetch::new, 1))?;
    class.define_method("begin_hop", method!(NavigationFetch::begin_hop, 1))?;
    class.define_method("response", method!(NavigationFetch::response, 3))?;
    class.define_method("coop_switch?", method!(NavigationFetch::coop_switch, 0))?;
    class.define_method("start", method!(NavigationFetch::start, 0))?;
    class.define_method("target", method!(NavigationFetch::target, 0))?;
    class.define_method("request_method", method!(NavigationFetch::request_method, 0))?;
    class.define_method("redirected?", method!(NavigationFetch::redirected, 0))?;
    class.define_method("cross_site?", method!(NavigationFetch::cross_site, 0))?;
    class.define_method("referrer", method!(NavigationFetch::referrer, 0))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_top_level_data_navigation_is_the_users_or_a_download() {
        assert_eq!(start("data:,x", "GET", false), "data");
        assert_eq!(start("DATA:,x", "POST", false), "data");
        assert_eq!(start("Data:,x", "GET", true), "refused");
        assert_eq!(start("data:text/plain;base64,%", "GET", true), "refused");
        assert_eq!(start("data:application/zip,x", "GET", true), "data");
        assert_eq!(start("http://a.test/", "GET", true), "fetch");
        assert_eq!(data_navigation("data:text/html,<p>x").0, "document");
        let (verdict, response) = data_navigation("data:application/octet-stream;base64,YWJj");
        assert_eq!((verdict, response), ("download", Some(("application/octet-stream".to_owned(), b"abc".to_vec()))));
        assert_eq!(data_navigation("data:text/plain;base64,%").0, "fail");
    }

    fn nav(method: &str, url: &str, initiator: &str) -> Nav {
        Nav {
            chain: RequestChain {
                method: method.to_owned(),
                target: url.to_owned(),
                headers: Vec::new(),
                body_empty: false,
                effective_origin: http_origin(initiator),
                taint: RedirectTaint::default(),
                ref_policy: None,
                ref_source: Some(initiator.to_owned()),
                passed: Vec::new(),
                dispatches: 0,
            },
            initiator: Some(initiator.to_owned()),
            initiator_opaque: false,
            initiator_cross_site_ancestor: false,
            site: None,
            traversed_initiator: None,
            ancestors: Some(vec![Some("http://a.test/top".to_owned())]),
            top_level: false,
            reloaded_cross: None,
            cross: false,
            cookies: 0,
        }
    }

    #[test]
    fn a_network_hop_carries_its_fetch_metadata_referer_and_origin() {
        let fetch = |st: Nav, has_origin: bool| NavigationFetch {
            origin: "http://a.test".to_owned(),
            dest: "iframe".to_owned(),
            user_activated: true,
            has_origin,
            jar: 0,
            sw: None,
            st: RefCell::new(st),
            coop: RefCell::new(None),
        };
        let header = |headers: &[(&str, Vec<u8>)], name: &str| headers.iter().find(|(n, _)| *n == name).map(|(_, v)| String::from_utf8_lossy(v).into_owned());
        let mut st = nav("POST", "http://a.test/form#frag", "http://a.test/page#x");
        st.chain.ref_policy = Some("unsafe-url".to_owned());
        let post = fetch(st, true);
        let headers = post.request_headers(&post.st.borrow(), 0.0);
        assert_eq!(header(&headers, "HTTP_SEC_FETCH_SITE").as_deref(), Some("same-origin"));
        assert_eq!(header(&headers, "HTTP_SEC_FETCH_MODE").as_deref(), Some("navigate"));
        assert_eq!(header(&headers, "HTTP_SEC_FETCH_DEST").as_deref(), Some("iframe"));
        assert_eq!(header(&headers, "HTTP_SEC_FETCH_USER").as_deref(), Some("?1"));
        assert_eq!(header(&headers, "HTTP_REFERER").as_deref(), Some("http://a.test/page"));
        assert_eq!(header(&headers, "HTTP_ORIGIN").as_deref(), Some("http://a.test"));
        // (…tainted by a redirect to another origin and back: Origin `null`, Sec-Fetch-Site the chain's widest)
        {
            let mut st = post.st.borrow_mut();
            let judged = Judged { cors: false, origin: "http://a.test", tainting_cors: false };
            st.site = Some(wider_site(st.site, fetch_site("http://a.test/page", "http://a.test/form")));
            assert!(matches!(st.chain.follow(307, &[b"http://b.test/x".to_vec()], &judged), Followed::Follow(..)));
            st.site = Some(wider_site(st.site, fetch_site("http://a.test/page", "http://b.test/x")));
            assert!(matches!(st.chain.follow(307, &[b"http://a.test/back".to_vec()], &judged), Followed::Follow(..)));
        }
        let headers = post.request_headers(&post.st.borrow(), 0.0);
        assert_eq!(header(&headers, "HTTP_ORIGIN").as_deref(), Some("null"));
        assert_eq!(header(&headers, "HTTP_SEC_FETCH_SITE").as_deref(), Some("cross-site"));
        // (…a GET's none; a navigation no document began none either)
        let get = fetch(nav("GET", "http://a.test/x", "http://a.test/page"), true);
        assert_eq!(header(&get.request_headers(&get.st.borrow(), 0.0), "HTTP_ORIGIN"), None);
        let users = fetch(Nav { initiator: None, ..nav("POST", "http://a.test/x", "http://a.test/page") }, false);
        let headers = users.request_headers(&users.st.borrow(), 0.0);
        assert_eq!(header(&headers, "HTTP_ORIGIN"), None);
        assert_eq!(header(&headers, "HTTP_SEC_FETCH_SITE").as_deref(), Some("none"));
    }

    #[test]
    fn a_worker_may_answer_a_hop_where_one_is_registered_and_the_navigable_may_be_controlled() {
        let fetch = |sw: Option<(bool, Option<String>)>| NavigationFetch {
            origin: "null".to_owned(),
            dest: "iframe".to_owned(),
            user_activated: false,
            has_origin: false,
            jar: 0,
            sw,
            st: RefCell::new(nav("GET", "http://a.test/", "")),
            coop: RefCell::new(None),
        };
        assert_eq!(fetch(None).sw_site("http://a.test/x"), None);
        // (…a top-level navigable's matched in each hop URL's site; a frame's in its top-level site)
        assert_eq!(fetch(Some((true, None))).sw_site("https://www.a.test/x").as_deref(), Some("https://a.test"));
        assert_eq!(fetch(Some((true, Some("http://top.test".into())))).sw_site("http://a.test/x").as_deref(), Some("http://top.test"));
        // (…an https hop under an insecure ancestor none; an http one all the same)
        let insecure = fetch(Some((false, Some("http://top.test".into()))));
        assert_eq!(insecure.sw_site("HTTPS://a.test/x"), None);
        assert_eq!(insecure.sw_site("http://a.test/x").as_deref(), Some("http://top.test"));
    }

    #[test]
    fn each_response_s_opener_policy_is_enforced_against_the_one_before_it() {
        let fresh = |coop: Coop| CoopEnforcement { coop, origin: None, facts: None, switch: false };
        let facts = |sandbox: u32| move || Ok::<_, ()>(("http://a.test".to_owned(), false, sandbox));
        // (…none asked of the document where every policy is "unsafe-none")
        let mut none = fresh(Coop::UnsafeNone);
        assert_eq!(none.enforce(Coop::UnsafeNone, None, "http://b.test/", || Err(())), Ok(true));
        assert!(!none.switch && none.facts.is_none());
        // (…a redirect of "same-origin" switches whatever comes after)
        let mut chain = fresh(Coop::UnsafeNone);
        assert_eq!(chain.enforce(Coop::SameOrigin, None, "http://a.test/r", facts(0)), Ok(true));
        assert!(chain.switch);
        assert_eq!(chain.enforce(Coop::UnsafeNone, None, "http://a.test/x", facts(0)), Ok(true));
        assert!(chain.switch);
        // (…the same policy of the same origin, no switch; another origin's, one)
        let mut same = fresh(Coop::SameOrigin);
        assert_eq!(same.enforce(Coop::SameOrigin, None, "http://a.test/y", facts(0)), Ok(true));
        assert!(!same.switch);
        assert_eq!(same.enforce(Coop::SameOrigin, None, "http://b.test/y", facts(0)), Ok(true));
        assert!(same.switch);
        // (…a policy to a navigable sandboxed — by its popup flags or the response's CSP — a network error)
        assert_eq!(fresh(Coop::UnsafeNone).enforce(Coop::SameOrigin, None, "http://a.test/", facts(crate::sandbox::SCRIPTS)), Ok(false));
        assert_eq!(fresh(Coop::UnsafeNone).enforce(Coop::SameOrigin, Some("sandbox"), "http://a.test/", facts(0)), Ok(false));
        assert_eq!(fresh(Coop::UnsafeNone).enforce(Coop::UnsafeNone, Some("sandbox"), "http://a.test/", facts(0)), Ok(true));
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
        use crate::cookie_jar::{CROSS_SITE, HTTP, LAX_RETRIEVE, TOP_LEVEL_NAV};
        // (…a frame's by the documents above it: cross-site to them, no Lax exception, no top-level one)
        let frame = nav("GET", "http://b.test/f", "http://a.test/page");
        let (frame_cross, ctx) = frame.cookies();
        assert!(frame_cross);
        assert_eq!(ctx & (CROSS_SITE | LAX_RETRIEVE | TOP_LEVEL_NAV), CROSS_SITE);
        // (…a top-level navigation's by its initiator's site: a cross-site GET's request may retrieve a Lax cookie, a
        // POST's not, and either's response may set a SameSite one)
        let top = Nav { ancestors: None, top_level: true, ..nav("GET", "http://b.test/", "http://a.test/page") };
        assert_eq!(top.cookies(), (false, HTTP | CROSS_SITE | LAX_RETRIEVE | TOP_LEVEL_NAV));
        let post = Nav { ancestors: None, top_level: true, ..nav("POST", "http://a.test/", "http://a.test/page") };
        assert_eq!(post.cookies().1 & (CROSS_SITE | LAX_RETRIEVE | TOP_LEVEL_NAV), TOP_LEVEL_NAV);
        // (…an opaque initiator's cross-site wherever it goes)
        let opaque = Nav { initiator_opaque: true, ..post };
        assert_eq!(opaque.cookies(), (false, HTTP | CROSS_SITE | TOP_LEVEL_NAV));
        // (…a reload through a user interface element's by the request it reloads, whatever its own site)
        let reload = Nav { reloaded_cross: Some(true), ..nav("GET", "http://a.test/", "") };
        assert_eq!(reload.cookies(), (false, HTTP | CROSS_SITE));
        let reload = Nav { reloaded_cross: Some(false), initiator: Some("http://b.test/page".into()), ..reload };
        assert_eq!(reload.cookies().1 & CROSS_SITE, 0);
    }

    #[test]
    fn a_hop_back_home_through_another_site_is_tainted_cross_site() {
        use crate::cookie_jar::{CROSS_SITE, LAX_RETRIEVE};
        // (…a → b → a, top-level: its redirect-taint "cross-site" at home — Fetch's "determine the same-site mode", the
        // Lax cookie alone, as Firefox 159 sends it (measured 2026-10-31) — and Sec-Fetch-Site the chain's widest)
        let mut st = Nav { ancestors: None, top_level: true, ..nav("GET", "http://b.test/r", "http://a.test/page") };
        assert_eq!(st.cookies().1 & (CROSS_SITE | LAX_RETRIEVE), CROSS_SITE | LAX_RETRIEVE);
        let judged = Judged { cors: false, origin: "http://a.test", tainting_cors: false };
        st.site = Some(wider_site(st.site, fetch_site("http://a.test/page", &st.chain.target)));
        assert!(matches!(st.chain.follow(302, &[b"http://a.test/home".to_vec()], &judged), Followed::Follow(..)));
        assert_eq!(st.chain.taint, RedirectTaint::CrossSite);
        assert_eq!(st.cookies().1 & (CROSS_SITE | LAX_RETRIEVE), CROSS_SITE | LAX_RETRIEVE);
        assert_eq!(wider_site(st.site, fetch_site("http://a.test/page", &st.chain.target)), "cross-site");
        // (…a → a: no taint, the Strict cookie kept by a top-level GET, step 3 notwithstanding)
        let home = Nav { ancestors: None, top_level: true, ..nav("GET", "http://a.test/x", "http://a.test/page") };
        assert_eq!(home.cookies().1 & (CROSS_SITE | LAX_RETRIEVE), LAX_RETRIEVE);
    }

    #[test]
    fn a_traversal_is_judged_by_its_entrys_initiator_origin() {
        use crate::cookie_jar::{CROSS_SITE, LAX_RETRIEVE};
        let context = |entry: Option<&str>| {
            let st = Nav { ancestors: None, top_level: true, initiator: None, traversed_initiator: entry.map(str::to_owned), ..nav("GET", "http://a.test/home", "") };
            st.cookies().1 & (CROSS_SITE | LAX_RETRIEVE)
        };
        // (…an entry another site's link made: Lax, no Strict; an opaque one's alike; its own site's, or a user's, Strict)
        assert_eq!(context(Some("http://b.test")), CROSS_SITE | LAX_RETRIEVE);
        assert_eq!(context(Some("null")), CROSS_SITE | LAX_RETRIEVE);
        assert_eq!(context(Some("http://sub.a.test")), LAX_RETRIEVE);
        assert_eq!(context(None), LAX_RETRIEVE);
    }

    #[test]
    fn a_top_level_navigation_is_judged_by_its_initiators_origin() {
        use crate::cookie_jar::CROSS_SITE;
        let cross = |initiator: &str, opaque: bool, target: &str| {
            let st = Nav { ancestors: None, top_level: true, initiator_opaque: opaque, ..nav("GET", target, initiator) };
            st.cookies().1 & CROSS_SITE != 0
        };
        // (…same-site by its origin, whatever documents are above it; an opaque one cross-site to every URL)
        assert!(!cross("http://a.test/page", false, "http://a.test/x"));
        assert!(!cross("http://sub.a.test/page", false, "http://a.test/x"));
        assert!(cross("http://b.test/page", false, "http://a.test/x"));
        assert!(cross("http://a.test/page", true, "http://a.test/x"));
        // (…an initiator with a cross-site ancestor: a top-level POST cross-site, a top-level GET not — step 3 first)
        let post = Nav { ancestors: None, top_level: true, initiator_cross_site_ancestor: true, ..nav("POST", "http://a.test/x", "http://a.test/page") };
        assert_eq!(post.cookies().1 & CROSS_SITE, CROSS_SITE);
        let get = Nav { ancestors: None, top_level: true, initiator_cross_site_ancestor: true, ..nav("GET", "http://a.test/x", "http://a.test/page") };
        assert_eq!(get.cookies().1 & CROSS_SITE, 0);
        // (…a frame's navigation cross-site by the documents above the frame, however same-site its initiator)
        assert_eq!(nav("GET", "http://b.test/f", "http://b.test/page").cookies().1 & CROSS_SITE, CROSS_SITE);
    }
}
