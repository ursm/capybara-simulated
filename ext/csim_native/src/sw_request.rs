// What a service worker's `fetch` event is made of (Service Workers "Create Fetch Event and Dispatch"): the request — as
// the client made it, with what Fetch gives it before Handle Fetch runs — the client's id, the reserved client's, the one
// a navigation replaces, and a navigation's preload response. Made once, here, for every request a worker answers: a
// fetch()'s and an XHR's (and each hop of their chain: `SwChain`), an EventSource's, a subresource's, and those the host
// makes — a navigation's, a worker's main script's, its `importScripts()`'s and its module scripts', a classic or module
// script's the parser waits on. It crosses to the worker's isolate as JSON (workers.js `swDispatchFetch`, which builds
// `event.request` of it: request_state.rs `requestAdopt`).
//
// Fetch's own steps before Handle Fetch, decided here rather than by each maker: the `Accept` its destination gives a
// request whose header list has none ("fetch" step 12), and its referrer — Referrer Policy "determine request's referrer"
// of its referrer source under the policy it is made under (main fetch steps 7-9): `event.request.referrer` is what the
// network would have been sent, not the document URL.

use magnus::{prelude::*, r_hash::ForEach, Error, RHash, Ruby, TryConvert, Value};
use serde_json::{Map, Value as Json};

#[derive(Clone, Default)]
pub(crate) struct SwRequest {
    pub(crate) method: String,
    pub(crate) url: String,
    // (…each name as first given, its value a byte string as the code points its bytes are)
    pub(crate) headers: Vec<(String, String)>,
    pub(crate) body_b64: String,
    pub(crate) mode: String,
    pub(crate) destination: String,
    pub(crate) credentials: String,
    pub(crate) redirect: String,
    pub(crate) cache: String,
    pub(crate) integrity: String,
    pub(crate) keepalive: bool,
    // (…a fetch()'s, whose promise an opaque response's head settles)
    pub(crate) head_first: bool,
    // (…the determined referrer: '' no referrer; none where the request keeps its client's, `about:client`)
    pub(crate) referrer: Option<String>,
    pub(crate) referrer_policy: String,
    pub(crate) client_id: String,
    pub(crate) resulting_client_id: String,
    pub(crate) replaces_client_id: String,
    // A navigation's: its reload and history flags; its initiator origin, the Sec-Fetch-Site its chain latched and its
    // redirect-taint; the cookie verdicts of its target and of the hop intercepted — what a passthrough
    // `fetch(event.request)` reports as the navigation would have; and its preload response (JSON).
    pub(crate) reload_navigation: bool,
    pub(crate) history_navigation: bool,
    pub(crate) initiator: Option<String>,
    pub(crate) site_seed: Option<String>,
    pub(crate) origin_null: bool,
    pub(crate) cookie_cross_site: bool,
    pub(crate) navigation_cross_site: bool,
    pub(crate) preload: Option<Json>,
}

impl SwRequest {
    // Its referrer determined of `source` under `policy` (its own, its container's, else the default), for its URL.
    pub(crate) fn refer(&mut self, policy: &str, source: &str) {
        self.referrer = Some(crate::referrer::request_referrer(policy, source, &self.url).unwrap_or_default());
    }
    // Fetch "fetch" step 12: its destination's `Accept`, where it has none.
    pub(crate) fn accept_default(&mut self) {
        if !self.headers.iter().any(|(n, _)| n.eq_ignore_ascii_case("accept")) {
            self.headers.push(("Accept".to_owned(), crate::fetch_rules::default_accept(&self.destination).to_owned()));
        }
    }
    // As the wire carries it: what is given of it — a member absent, an empty text and a false flag alike, leave the
    // worker's request as a Request makes it (`requestAdopt`) — but its referrer, whose empty text is no referrer.
    pub(crate) fn wire(&self) -> String {
        let mut o = Map::new();
        o.insert("method".into(), Json::from(self.method.as_str()));
        o.insert("url".into(), Json::from(self.url.as_str()));
        let headers: Map<String, Json> = self.headers.iter().map(|(n, v)| (n.clone(), Json::from(v.as_str()))).collect();
        o.insert("headers".into(), Json::Object(headers));
        o.insert("body_b64".into(), Json::from(self.body_b64.as_str()));
        let texts = [
            ("mode", &self.mode),
            ("destination", &self.destination),
            ("credentials", &self.credentials),
            ("redirect", &self.redirect),
            ("cache", &self.cache),
            ("integrity", &self.integrity),
            ("referrerPolicy", &self.referrer_policy),
            ("clientId", &self.client_id),
            ("resultingClientId", &self.resulting_client_id),
            ("replacesClientId", &self.replaces_client_id),
        ];
        for (key, value) in texts {
            if !value.is_empty() {
                o.insert(key.into(), Json::from(value.as_str()));
            }
        }
        if let Some(referrer) = &self.referrer {
            o.insert("referrer".into(), Json::from(referrer.as_str()));
        }
        for (key, value) in [("initiator", &self.initiator), ("siteSeed", &self.site_seed)] {
            if let Some(value) = value {
                o.insert(key.into(), Json::from(value.as_str()));
            }
        }
        let flags = [
            ("keepalive", self.keepalive),
            ("headFirst", self.head_first),
            ("isReloadNavigation", self.reload_navigation),
            ("isHistoryNavigation", self.history_navigation),
            ("originNull", self.origin_null),
            ("cookieCrossSite", self.cookie_cross_site),
            ("navigationCrossSite", self.navigation_cross_site),
        ];
        for (key, on) in flags {
            if on {
                o.insert(key.into(), Json::Bool(true));
            }
        }
        if let Some(preload) = &self.preload {
            o.insert("preloadResponse".into(), preload.clone());
        }
        Json::Object(o).to_string()
    }
}

// Native.sw_request(params) -> the wire of the request the host hands a service worker, its `kind` the algorithm that
// makes it, which says what the request is where `params` does not:
// - "navigate": HTML "create navigation params by fetching" — mode navigate, redirect manual (a passthrough
//   `fetch(event.request)` of a redirect yields an opaque redirect, which the navigation follows), its cache mode a
//   reload's `no-cache`, its referrer policy the default where its initiator gave none;
// - "worker" / "sharedworker": "fetch a classic worker script" — a same-origin request of that destination;
// - "import": "fetch a classic worker-imported script" — no-cors, a script;
// - "module": "fetch a single module script" — cors;
// - "script": a script, a style sheet or an image the parser or a module graph waits on, as its plan made it.
// Credentials `same-origin` but where given (a navigation's none: `requestAdopt` gives it `include`).
// `params` (symbol keys): `kind`, `url`, `method` (GET), `headers` (a Hash), `body` (its bytes), `destination`, `mode`,
// `credentials`, `integrity`, `referrer_source` (nil for none; the key absent, the request's referrer its client,
// `about:client`) and the `referrer_policy` it is made under, `reload`, `history`, `initiator`, `site_seed`, `origin_null`, `cookie_cross_site`,
// `navigation_cross_site`, `client_id`, `resulting_client_id`, `replaces_client_id`, `preload` (its JSON).
pub(crate) fn sw_request_for_ruby(ruby: &Ruby, params: RHash) -> Result<String, Error> {
    let get = |key: &str| params.aref::<_, Value>(ruby.to_symbol(key));
    let text = |key: &str| -> Result<String, Error> { Ok(Option::<String>::try_convert(get(key)?)?.unwrap_or_default()) };
    let option = |key: &str| -> Result<Option<String>, Error> { Option::<String>::try_convert(get(key)?) };
    let flag = |key: &str| -> Result<bool, Error> { Ok(get(key)?.to_bool()) };
    let kind = text("kind")?;
    let mut r = SwRequest {
        method: option("method")?.filter(|m| !m.is_empty()).map_or_else(|| "GET".to_owned(), |m| m.to_ascii_uppercase()),
        url: text("url")?,
        destination: text("destination")?,
        mode: text("mode")?,
        credentials: text("credentials")?,
        integrity: text("integrity")?,
        reload_navigation: flag("reload")?,
        history_navigation: flag("history")?,
        initiator: option("initiator")?,
        site_seed: option("site_seed")?,
        origin_null: flag("origin_null")?,
        cookie_cross_site: flag("cookie_cross_site")?,
        navigation_cross_site: flag("navigation_cross_site")?,
        client_id: text("client_id")?,
        resulting_client_id: text("resulting_client_id")?,
        replaces_client_id: text("replaces_client_id")?,
        ..SwRequest::default()
    };
    if let Some(headers) = Option::<RHash>::try_convert(get("headers")?)? {
        headers.foreach(|name: String, value: String| {
            r.headers.push((name, value));
            Ok(ForEach::Continue)
        })?;
    }
    if let Some(body) = Option::<magnus::RString>::try_convert(get("body")?)? {
        // SAFETY: the bytes are copied out before any Ruby code runs.
        r.body_b64 = crate::data_url::base64_encode(unsafe { body.as_slice() });
    }
    if let Some(preload) = option("preload")? {
        r.preload = serde_json::from_str(&preload).ok();
    }
    let given = |slot: &mut String, value: &str| {
        if slot.is_empty() {
            value.clone_into(slot);
        }
    };
    match kind.as_str() {
        "navigate" => {
            given(&mut r.mode, "navigate");
            given(&mut r.redirect, "manual");
            given(&mut r.cache, if r.reload_navigation { "no-cache" } else { "default" });
        }
        "worker" | "sharedworker" => {
            given(&mut r.mode, "same-origin");
            given(&mut r.destination, &kind);
        }
        "import" => {
            given(&mut r.mode, "no-cors");
            given(&mut r.destination, "script");
        }
        "module" => given(&mut r.mode, "cors"),
        _ => {}
    }
    if kind != "navigate" {
        given(&mut r.credentials, "same-origin");
    }
    // (…a referrer source given as none — a navigation the user began — no referrer at all)
    if let Some(source) = params.get(ruby.to_symbol("referrer_source")) {
        let own = text("referrer_policy")?;
        let policy = crate::fetch_request::request_policy(&own, "");
        match Option::<String>::try_convert(source)? {
            Some(source) => r.refer(policy, &source),
            None => r.referrer = Some(String::new()),
        }
        policy.clone_into(&mut r.referrer_policy);
    }
    r.accept_default();
    if r.method == "GET" || r.method == "HEAD" {
        r.body_b64.clear();
    }
    Ok(r.wire())
}

// A controlled client's request through its service worker, hop by hop (Fetch "HTTP fetch" over Handle Fetch, then
// "HTTP-redirect fetch"): each hop's request the worker's `fetch` event's to answer, its mode and redirect mode deciding
// what the answer does (fetch_rules.rs `intercepted_hop`) — a redirect it follows is the next hop, its method, body and
// headers as "HTTP-redirect fetch" leaves them; a hop the worker falls through on goes to the network as the request
// stands at it. What the chain keeps between hops: the request at the hop (`request`), its client's origin, how many
// redirects it followed, whether it has been at another origin, its redirect-taint and the Sec-Fetch-Site it latched.
// Kept by the realm that made it (`Chains`), by number, until it ends — an answer, an opaque redirect, a network error,
// the network's — or its request is given up on.
pub(crate) struct SwChain {
    request: SwRequest,
    origin: String,
    hops: u32,
    crossed: bool,
    taint: crate::referrer::RedirectTaint,
    site: Option<String>,
}

#[derive(Default)]
pub(crate) struct Chains {
    next: u32,
    live: std::collections::HashMap<u32, SwChain>,
}
impl Chains {
    // The chain of `request`, its client of origin `origin`: its number.
    pub(crate) fn begin(&mut self, request: SwRequest, origin: String) -> u32 {
        self.next += 1;
        let chain = SwChain { request, origin, hops: 0, crossed: false, taint: Default::default(), site: None };
        self.live.insert(self.next, chain);
        self.next
    }
}

// What the worker's answer to a hop does: answers the request (its `hops` and the hop's URL, which a response with no URL
// list takes), an opaque redirect of the hop's URL, the next hop's request, or a network error, and why.
#[derive(Debug, PartialEq)]
pub(crate) enum ChainStep {
    Answer(u32, String),
    OpaqueRedirect(String),
    Follow(String),
    Fail(String),
}
impl SwChain {
    // …the worker's `response` to the hop.
    pub(crate) fn answer(&mut self, response: &crate::fetch_rules::WorkerResponse<'_>) -> ChainStep {
        use crate::fetch_rules::{intercepted_hop, request_body_header, HopOutcome, InterceptedHop};
        let r = &self.request;
        let hop = InterceptedHop {
            mode: &r.mode,
            redirect_mode: &r.redirect,
            url: &r.url,
            method: r.method.as_bytes(),
            request_origin: &self.origin,
            crossed: self.crossed,
            taint: self.taint,
            hops: self.hops,
        };
        match intercepted_hop(&hop, response) {
            HopOutcome::Answer => ChainStep::Answer(self.hops, r.url.clone()),
            HopOutcome::OpaqueRedirect => ChainStep::OpaqueRedirect(r.url.clone()),
            HopOutcome::Fail(why) => ChainStep::Fail(why),
            HopOutcome::Follow(next, crossed) => {
                // (…the Sec-Fetch-Site latch with this hop's URL in it, measured from the request's origin)
                let site = crate::referrer::wider_site(self.site.as_deref(), crate::referrer::fetch_site(&self.origin, &self.request.url));
                self.site = Some(site.to_owned());
                let r = &mut self.request;
                r.headers.retain(|(name, _)| {
                    !(next.to_get && request_body_header(name.as_bytes()) || next.drop_authorization && name.eq_ignore_ascii_case("authorization"))
                });
                if next.to_get {
                    "GET".clone_into(&mut r.method);
                    r.body_b64.clear();
                }
                r.url = next.url;
                self.hops += 1;
                self.crossed = crossed;
                self.taint = next.taint;
                ChainStep::Follow(r.wire())
            }
        }
    }
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "swChainStart", chain_start_op, context_id);
    crate::dom::register(scope, ns, "swChainAnswer", chain_answer_op, context_id);
    crate::dom::register(scope, ns, "swChainFallthrough", chain_fallthrough_op, context_id);
    crate::dom::register(scope, ns, "swChainDrop", chain_drop_op, context_id);
}

// The calling realm's chains, `f` asked of them.
fn chains<T>(scope: &mut v8::PinScope<'_, '_>, args: &v8::FunctionCallbackArguments<'_>, f: impl FnOnce(&mut Chains) -> T) -> Option<T> {
    let cid = crate::dom::realm_id(scope, args);
    crate::dom::realm(scope, cid).realm_state_mut(cid).map(|s| f(&mut s.sw_chains))
}
fn string<'s>(scope: &mut v8::PinScope<'s, '_>, s: &str) -> v8::Local<'s, v8::Value> {
    v8::String::new(scope, s).map_or_else(|| v8::undefined(scope).into(), Into::into)
}

// __dom.swChainStart(chain, bodyB64, clientId) -> the request of the chain's first hop as the worker's fetch event takes it
// (the wire), its body `bodyB64` (none for a GET or a HEAD) and its client's id `clientId`; undefined for a chain gone.
fn chain_start_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let id = args.get(0).uint32_value(scope).unwrap_or(0);
    let body = args.get(1).to_rust_string_lossy(scope);
    let client = args.get(2).to_rust_string_lossy(scope);
    let wire = chains(scope, &args, |c| {
        let r = &mut c.live.get_mut(&id)?.request;
        if r.method != "GET" && r.method != "HEAD" {
            r.body_b64 = body;
        }
        r.client_id = client;
        Some(r.wire())
    });
    if let Some(Some(wire)) = wire {
        rv.set(string(scope, &wire));
    }
}

// __dom.swChainAnswer(chain, status, type, url, redirected, location) -> what the worker's response to the chain's hop
// does (`SwChain::answer`; `location` its Location header, null for none): [0, hops, hop URL] it answers the request,
// [1, hop URL] an opaque redirect of the hop's URL answers it, [2, wire] the request of the next hop, [3, why] a network
// error. The chain ends but at a next hop; undefined for one gone.
fn chain_answer_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let id = args.get(0).uint32_value(scope).unwrap_or(0);
    let response_type = args.get(2).to_rust_string_lossy(scope);
    let url = if args.get(3).is_null_or_undefined() { String::new() } else { args.get(3).to_rust_string_lossy(scope) };
    let location = (!args.get(5).is_null_or_undefined()).then(|| args.get(5).to_rust_string_lossy(scope));
    let response = crate::fetch_rules::WorkerResponse {
        status: args.get(1).uint32_value(scope).unwrap_or(0),
        response_type: if response_type.is_empty() { "default" } else { &response_type },
        url: &url,
        redirected: args.get(4).is_true(),
        location: location.as_deref(),
    };
    let Some(Some(step)) = chains(scope, &args, |c| {
        let step = c.live.get_mut(&id)?.answer(&response);
        if !matches!(step, ChainStep::Follow(_)) {
            c.live.remove(&id);
        }
        Some(step)
    }) else {
        return;
    };
    let items: Vec<v8::Local<v8::Value>> = match step {
        ChainStep::Answer(hops, url) => vec![v8::Integer::new(scope, 0).into(), v8::Integer::new_from_unsigned(scope, hops).into(), string(scope, &url)],
        ChainStep::OpaqueRedirect(url) => vec![v8::Integer::new(scope, 1).into(), string(scope, &url)],
        ChainStep::Follow(wire) => vec![v8::Integer::new(scope, 2).into(), string(scope, &wire)],
        ChainStep::Fail(why) => vec![v8::Integer::new(scope, 3).into(), string(scope, &why)],
    };
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}

// __dom.swChainFallthrough(chain) -> the worker fell through on the chain's hop, which goes to the network: undefined at
// its first hop — the request as it was made — else the request at the hop, [method, URL, headers (a map of byte
// strings, of no prototype), its redirect-taint by name, the Sec-Fetch-Site its chain latched], which its network leg
// carries on (fetch_plan.rs: its origin "null" past "same-origin", its cookies cross-site at "cross-site"). The chain ends.
fn chain_fallthrough_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let id = args.get(0).uint32_value(scope).unwrap_or(0);
    let Some(Some(chain)) = chains(scope, &args, |c| c.live.remove(&id)) else { return };
    if chain.hops == 0 {
        return;
    }
    let r = &chain.request;
    let headers: Vec<(Vec<u8>, Vec<u8>)> = r.headers.iter().map(|(n, v)| (latin1(n), latin1(v))).collect();
    let site = match &chain.site {
        Some(site) => string(scope, site),
        None => v8::null(scope).into(),
    };
    let items = [string(scope, &r.method), string(scope, &r.url), crate::fetch_request::header_record(scope, &headers), string(scope, chain.taint.name()), site];
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}

// __dom.swChainDrop(chain): the chain's request given up on.
fn chain_drop_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let id = args.get(0).uint32_value(scope).unwrap_or(0);
    chains(scope, &args, |c| c.live.remove(&id));
}

// A byte string's bytes, its code points each one.
pub(crate) fn latin1(s: &str) -> Vec<u8> {
    s.chars().map(|c| c as u32 as u8).collect()
}
// …and the text a byte string is.
pub(crate) fn byte_text(bytes: &[u8]) -> String {
    bytes.iter().map(|&b| char::from(b)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_wire_carries_what_is_given_and_a_referrer_even_none() {
        let mut r = SwRequest { method: "GET".into(), url: "https://a.test/x".into(), destination: "image".into(), ..SwRequest::default() };
        r.accept_default();
        r.refer("no-referrer", "https://a.test/page");
        let wire: Json = serde_json::from_str(&r.wire()).unwrap();
        assert_eq!(wire["headers"]["Accept"], crate::fetch_rules::default_accept("image"));
        assert_eq!(wire["referrer"], "");
        assert!(wire.get("mode").is_none());
        assert!(wire.get("keepalive").is_none());
    }

    #[test]
    fn an_accept_given_is_kept() {
        let mut r = SwRequest { headers: vec![("accept".into(), "text/x".into())], ..SwRequest::default() };
        r.accept_default();
        assert_eq!(r.headers, [("accept".to_owned(), "text/x".to_owned())]);
    }

    #[test]
    fn a_chain_follows_a_303_as_a_bodyless_get_and_fails_a_21st() {
        let request = SwRequest {
            method: "POST".into(),
            url: "https://a.test/form".into(),
            headers: vec![("Content-Type".into(), "text/plain".into()), ("X-Kept".into(), "1".into())],
            body_b64: "Ym9keQ==".into(),
            mode: "cors".into(),
            redirect: "follow".into(),
            ..SwRequest::default()
        };
        let mut chains = Chains::default();
        let id = chains.begin(request, "https://a.test".into());
        let chain = chains.live.get_mut(&id).unwrap();
        let redirect = |location| crate::fetch_rules::WorkerResponse { status: 303, response_type: "default", url: "https://a.test/form", redirected: false, location };
        let ChainStep::Follow(wire) = chain.answer(&redirect(Some("/next"))) else { panic!() };
        let wire: Json = serde_json::from_str(&wire).unwrap();
        assert_eq!((wire["method"].as_str(), wire["url"].as_str(), wire["body_b64"].as_str()), (Some("GET"), Some("https://a.test/next"), Some("")));
        assert!(wire["headers"].get("Content-Type").is_none());
        assert_eq!(wire["headers"]["X-Kept"], "1");
        assert_eq!(chain.site.as_deref(), Some("same-origin"));
        for _ in 1..20 {
            assert!(matches!(chain.answer(&redirect(Some("/next"))), ChainStep::Follow(_)));
        }
        assert_eq!(chain.answer(&redirect(Some("/next"))), ChainStep::Fail("exceeded 20 redirects".into()));
        let ok = crate::fetch_rules::WorkerResponse { status: 200, response_type: "default", url: "", redirected: false, location: None };
        assert_eq!(chain.answer(&ok), ChainStep::Answer(20, "https://a.test/next".into()));
    }

    #[test]
    fn a_referrer_is_the_one_its_policy_sends() {
        let mut r = SwRequest { url: "https://b.test/".into(), ..SwRequest::default() };
        r.refer("strict-origin-when-cross-origin", "https://a.test/p?q");
        assert_eq!(r.referrer.as_deref(), Some("https://a.test/"));
    }
}
