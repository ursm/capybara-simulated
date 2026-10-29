// A fetch the host makes, hop by hop (Fetch "main fetch" → "HTTP fetch" → "HTTP-network-or-cache fetch", with
// "HTTP-redirect fetch" between hops): the request as it stands — its method, URL, header list, whether its body is gone —
// and the chain's latches — whether it has been at another origin than its client's, its origin tainted, its referrer
// source and policy, the server delay its hops accumulated — and, at each hop, what comes next: an answer from the HTTP
// cache, the request to dispatch (and the CORS-preflight to send first), a network error, a redirect followed, or the
// response. The host keeps the transport — the Rack env, the dispatch, the bodies, the stored responses, the cookie
// store's writes — and asks this at each step, three times a hop at most (`begin_hop`, `preflight_answer`, `response`).

use std::cell::RefCell;

use magnus::{function, method, prelude::*, Error, IntoValue, RArray, RHash, RModule, Ruby, TryConvert, Value};

use crate::fetch_chain::{Followed, Headers, Judged, RequestChain};
use crate::fetch_hop::{ClientFacts, FetchHops};
use crate::fetch_rules::{bad_port, redirect_status};
// Request cache modes that never read the store, and those that serve a stored response however stale.
const SKIP_READ: [&str; 2] = ["no-store", "reload"];
const SERVE_STALE: [&str; 2] = ["force-cache", "only-if-cached"];
// An author's conditional header: the caller revalidates itself — an externally conditionalized request, whose validators
// and whose 304 are its own (RFC 9111 §4.3.2; Chrome's and Firefox's) — so the HTTP cache neither answers nor stores it,
// whatever its mode, and a request of the default cache mode is a no-store one (Fetch "HTTP-network-or-cache fetch";
// request-cache-default-conditional: "treated similarly to no-store").
const CONDITIONAL: [&str; 5] = ["if-none-match", "if-modified-since", "if-match", "if-unmodified-since", "if-range"];
// The statuses whose response has no body (Fetch "null body status"), and a HEAD's response has none either.
const NULL_BODY: [u32; 3] = [204, 205, 304];
// What a redirect error raises as — the message the host has always warned a `redirect: "error"` fetch with.
const REDIRECT_ERROR: &str = "[capybara-simulated] fetch: redirect blocked by redirect=error mode";
const TOO_MANY: &str = "[capybara-simulated] fetch exceeded 20 redirects";

// The request as it stands (fetch_chain.rs: its origin as its hops send it the request's, 'null' once a redirect tainted
// it, none for a mode-less load), and the chain's latches.
struct State {
    chain: RequestChain,
    crossed: bool,
    tainted: bool,
    delay_ms: i64,
    // This hop's: the Referer it sent, whether it is a CORS hop to another origin, whether it sent cookies, whether it
    // revalidates a stored response, whether it answered a challenge.
    referer: Option<String>,
    cross_origin: bool,
    send_cookies: bool,
    revalidating: bool,
    answered: bool,
}

#[magnus::wrap(class = "Capybara::Simulated::Native::FetchPlan", free_immediately)]
pub(crate) struct FetchPlan {
    hops: FetchHops,
    no_cors: bool,
    same_origin: bool,
    cors: bool,
    // The request's origin (none for a mode-less load), whatever a redirect made of how its hops send it.
    origin: Option<String>,
    doc_origin: Option<String>,
    client_origin: Option<String>,
    credentials: String,
    redirect_mode: String,
    cache_mode: String,
    conditional: bool,
    navigation: bool,
    // The credentials an XHR's `open()` brought, as an `Authorization` value, answering a Basic challenge.
    challenge: Option<String>,
    // The session's CORS-preflight cache and authentication entries (cors.rs, http_auth.rs).
    preflight_cache: u64,
    auth_entries: u64,
    st: RefCell<State>,
}

fn lower(name: &[u8]) -> String {
    String::from_utf8_lossy(name).to_ascii_lowercase()
}
fn header_pairs(value: RArray) -> Result<Headers, Error> {
    value
        .into_iter()
        .map(|pair| {
            let pair = RArray::try_convert(pair)?;
            Ok((crate::fetch_rules::ruby_bytes(pair.entry(0)?), crate::fetch_rules::ruby_bytes(pair.entry(1)?)))
        })
        .collect()
}
// (…each a UTF-8 string where its bytes are UTF-8, as the caller gave it, else a byte string)
fn pairs(ruby: &Ruby, headers: &Headers) -> RArray {
    let string = |b: &[u8]| std::str::from_utf8(b).map_or_else(|_| ruby.str_from_slice(b), |s| ruby.str_new(s));
    let out = ruby.ary_new_capa(headers.len());
    for (k, v) in headers {
        let _ = out.push((string(k), string(v)));
    }
    out
}
fn http_origin(url: &str) -> Option<String> {
    crate::referrer::http_origin(url)
}
fn port_blocked(url: &ada_url::Url) -> bool {
    url.port().parse::<u32>().is_ok_and(bad_port)
}
fn has_userinfo(url: &str) -> bool {
    ada_url::Url::parse(url, None).is_ok_and(|u| !u.username().is_empty() || !u.password().is_empty())
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

impl FetchPlan {
    // FetchPlan.new(request, sessions) -> the plan of the fetch `request` describes, or nil for a URL no fetch here goes
    // to (no HTTP(S) one; a blocked port — Fetch "port blocking": a network error before any connection). `request` is
    // the host's description, by name: `method`, `url` (resolved), `headers` (pairs), `body_empty`, `redirect`, `mode`
    // (nil a mode-less internal load's), `credentials`, `referrer_policy`, `referrer` (nil its client's URL, '' none),
    // `cache`, `initiator` (a worker re-issuing a navigation: the request's origin whatever its mode), `site_seed`,
    // `origin_null`, `client_url`, `client_origin`, `ancestors`, `cookie_cross_site`, `nav_dest`, `navigation`, `dest`,
    // `user_activated`, `top_url` (the page's document's URL), `worker` ([its site for cookies], nil for none);
    // `sessions` [preflight cache, authentication entries].
    fn new(ruby: &Ruby, request: RHash, sessions: (u64, u64)) -> Result<Option<Self>, Error> {
        let get = |key: &str| request.aref::<_, Value>(ruby.to_symbol(key));
        let text = |key: &str| -> Result<Option<String>, Error> { Option::<String>::try_convert(get(key)?) };
        let flag = |key: &str| -> Result<bool, Error> { Ok(get(key)?.to_bool()) };
        let target = text("url")?.unwrap_or_default();
        if !ada_url::Url::parse(&target, None).is_ok_and(|u| matches!(u.protocol(), "http:" | "https:") && !port_blocked(&u)) {
            return Ok(None);
        }
        let mode = text("mode")?;
        // (…a credentials, redirect and cache mode named '' its default, as none)
        let named = |key: &str| -> Result<Option<String>, Error> { Ok(text(key)?.filter(|v| !v.is_empty())) };
        let credentials = named("credentials")?.unwrap_or_else(|| "same-origin".to_owned());
        // The CLIENT: the realm that called fetch/XHR — its own document's URL, a service worker's script URL — and, where
        // that is no HTTP(S) URL (an about:blank / javascript: / data: realm's), the page's; its origin the realm's where
        // it says (a sandboxed document's opaque `null` its URL does not carry), else its URL's.
        let client_url = text("client_url")?;
        let client = client_url.clone().filter(|u| http_origin(u).is_some()).or(text("top_url")?);
        let client_origin = text("client_origin")?.filter(|o| !o.is_empty()).or_else(|| client.as_deref().and_then(http_origin));
        // The request's origin for every mode — Fetch appends an Origin to every non-GET/HEAD request whatever its mode —
        // and the document origin a mode's response type is judged by; a mode-less internal load has none. A worker's
        // re-issued navigation (`initiator`) is of its initiator's whatever its mode, a document's own navigation request
        // of its document's.
        let moded = matches!(mode.as_deref(), Some("cors" | "no-cors" | "same-origin"));
        let initiator = text("initiator")?;
        let navigation = flag("navigation")?;
        let origin = initiator.clone().or_else(|| (navigation || moded).then(|| client_origin.clone()).flatten());
        let doc_origin = moded.then(|| client_origin.clone()).flatten();
        // Its referrer: an explicit one, else its client's URL; '' none.
        let ref_source = if get("referrer")?.is_nil() { client.clone() } else { text("referrer")? };
        // The origin Sec-Fetch-Site measures from, whatever the referrer policy makes of the Referer: an explicit
        // initiator's, else the referrer's, else the client's (an about:blank document's: its creator's).
        let sec_initiator = initiator.or_else(|| ref_source.as_deref().and_then(http_origin)).or_else(|| client_origin.clone());
        let worker: Option<RArray> = Option::try_convert(get("worker")?)?;
        let worker_site = worker.map(|w| w.entry::<Option<String>>(0)).transpose()?;
        let ancestors: Option<RArray> = Option::try_convert(get("ancestors")?)?;
        let ancestors = ancestors.map_or(Ok(Vec::new()), |a| a.into_iter().map(Option::<String>::try_convert).collect::<Result<Vec<_>, _>>())?;
        let mut headers = header_pairs(RArray::try_convert(get("headers")?)?)?;
        // (…the XHR's challenge credentials, which its marker header carries: never sent until a challenge asks for them)
        let challenge = headers
            .iter()
            .position(|(k, _)| k.eq_ignore_ascii_case(b"x-csim-auth-challenge"))
            .map(|i| format!("Basic {}", String::from_utf8_lossy(&headers.remove(i).1)));
        let conditional = headers.iter().any(|(k, _)| CONDITIONAL.contains(&lower(k).as_str()));
        let mut cache_mode = named("cache")?.unwrap_or_else(|| "default".to_owned());
        if conditional && cache_mode == "default" {
            cache_mode = "no-store".to_owned();
        }
        let of_mode = |m: &str| mode.as_deref() == Some(m);
        let (cors, no_cors, same_origin) = (of_mode("cors"), of_mode("no-cors"), of_mode("same-origin"));
        let hops = FetchHops::new(ClientFacts {
            mode: mode.clone(),
            dest: text("dest")?,
            nav_dest: text("nav_dest")?,
            navigation,
            user_activated: flag("user_activated")?,
            credentials: credentials.clone(),
            origin: origin.clone(),
            doc_origin: doc_origin.clone(),
            client_origin: client_origin.clone(),
            sec_initiator,
            client_url,
            top_document: text("top_url")?,
            ancestors,
            worker_site,
            cross_site_frame: flag("cookie_cross_site")?,
        });
        hops.seed(text("site_seed")?);
        Ok(Some(FetchPlan {
            hops,
            no_cors,
            same_origin,
            cors,
            origin: origin.clone(),
            doc_origin,
            client_origin,
            credentials,
            redirect_mode: named("redirect")?.unwrap_or_else(|| "follow".to_owned()),
            cache_mode,
            conditional,
            navigation,
            challenge,
            preflight_cache: sessions.0,
            auth_entries: sessions.1,
            st: RefCell::new(State {
                chain: RequestChain {
                    method: text("method")?.unwrap_or_else(|| "GET".to_owned()),
                    target,
                    headers,
                    body_empty: flag("body_empty")?,
                    effective_origin: if flag("origin_null")? { Some("null".to_owned()) } else { origin },
                    ref_policy: text("referrer_policy")?,
                    ref_source,
                    redirected: false,
                    dispatches: 0,
                },
                crossed: false,
                tainted: false,
                delay_ms: 0,
                referer: None,
                cross_origin: false,
                send_cookies: false,
                revalidating: false,
                answered: false,
            }),
        }))
    }

    // #target / #request_method / #redirected?: the request as it stands.
    fn target(&self) -> String {
        self.st.borrow().chain.target.clone()
    }
    fn request_method(&self) -> String {
        self.st.borrow().chain.method.clone()
    }
    fn redirected(&self) -> bool {
        self.st.borrow().chain.redirected
    }
    // Whether the HTTP cache may be read for this hop: a GET, no author conditional, a mode that reads it, and the chain
    // at its client's origin still (a cross-origin hop always goes to the network, so the mode filtering runs).
    fn reads_cache(st: &State, plan: &FetchPlan) -> bool {
        st.chain.method == "GET" && !plan.conditional && !st.crossed && !SKIP_READ.contains(&plan.cache_mode.as_str())
    }
    // …and written with its response: a GET, not `no-store`, no author conditional.
    fn writes_cache(&self, method: &str) -> bool {
        method == "GET" && self.cache_mode != "no-store" && !self.conditional
    }
    // The header list a hop sends: the request's, and what its cache mode appends where the request has none of its own
    // (Fetch "HTTP-network-or-cache fetch", to the hop's copy alone — the request's own is what a CORS-preflight is
    // judged by): a no-cache request asks every cache on the way to revalidate, a no-store or reload one to step aside.
    fn sent_headers<'h>(&self, headers: &'h Headers) -> std::borrow::Cow<'h, Headers> {
        if !matches!(self.cache_mode.as_str(), "no-cache" | "no-store" | "reload") {
            return std::borrow::Cow::Borrowed(headers);
        }
        let mut sent = headers.clone();
        let mut append = |name: &[u8], value: &[u8]| {
            if !sent.iter().any(|(k, _)| k.eq_ignore_ascii_case(name)) {
                sent.push((name.to_vec(), value.to_vec()));
            }
        };
        match self.cache_mode.as_str() {
            "no-cache" => append(b"Cache-Control", b"max-age=0"),
            "no-store" | "reload" => {
                append(b"Pragma", b"no-cache");
                append(b"Cache-Control", b"no-cache");
            }
            _ => {}
        }
        std::borrow::Cow::Owned(sent)
    }
    // Whether the request is CORS-unsafe — no safelisted method, or a header no CORS-safelisted one: its CORS-preflight's
    // method and header names, None for a safe one.
    fn unsafe_request(st: &State) -> Option<Vec<String>> {
        let names = crate::cors::unsafe_header_names(&st.chain.headers);
        (!crate::fetch_rules::cors_safelisted_method(st.chain.method.to_ascii_uppercase().as_bytes()) || !names.is_empty()).then_some(names)
    }

    // #begin_hop(cache, now) -> the next step of the chain, the stored response for its URL being `cache` ([status,
    // fresh, location fields] or nil; the host keeps the store), `now` the monotonic clock the preflight cache runs on:
    // - ['error', message] — a network error (`message` one the host raises with, nil for none);
    // - ['serve_cache', tainted] — the stored response is the answer;
    // - ['cache_follow', from] — a stored redirect followed from the cache (`from` the hop it was of, for the trace);
    // - ['opaque_redirect_cached'] — a stored redirect, its request's redirect mode "manual";
    // - ['dispatch', [method, target, header pairs, drop Content-Length, Referer, send cookies, pre-emptive
    //   Authorization, Origin, Sec-Fetch [site, mode, dest, user, top-level], cookie site, Lax, revalidate],
    //   preflight] — the request to send, the CORS-preflight first where `preflight` [unsafe names, Origin] says so.
    fn begin_hop(ruby: &Ruby, rb_self: &Self, cache: Option<(u32, bool, RArray)>, now: f64) -> Result<RArray, Error> {
        let plan = rb_self;
        let mut st = plan.st.borrow_mut();
        if st.chain.dispatch().is_none() {
            return Ok(command(ruby, "error", &[TOO_MANY.into_value_with(ruby)]));
        }
        // (…cross-origin-ness for the request's mode and its response's type, latched: a tainted origin is of none)
        let target_origin = http_origin(&st.chain.target);
        let tainted_origin = st.chain.effective_origin.as_deref() == Some("null");
        st.crossed |= plan.doc_origin.as_deref().is_some_and(|d| tainted_origin || target_origin.as_deref() != Some(d));
        st.tainted |= plan.client_origin.as_deref() == Some("null") || target_origin.as_deref() != plan.client_origin.as_deref();
        if plan.same_origin && st.crossed {
            return Ok(command(ruby, "error", &[ruby.qnil().as_value()]));
        }
        let read = Self::reads_cache(&st, plan);
        let stored = cache.filter(|_| read);
        st.revalidating = stored.is_some();
        if let Some((status, fresh, locations)) = &stored {
            if SERVE_STALE.contains(&plan.cache_mode.as_str()) || (*fresh && plan.cache_mode != "no-cache") {
                if redirect_status(*status) {
                    match plan.redirect_mode.as_str() {
                        "error" => return Ok(command(ruby, "error", &[REDIRECT_ERROR.into_value_with(ruby)])),
                        "follow" => {}
                        _ => return Ok(command(ruby, "opaque_redirect_cached", &[])),
                    }
                    match plan.follow(&mut st, *status, *locations)? {
                        Followed::Answer => {}
                        Followed::Fail => return Ok(command(ruby, "error", &[ruby.qnil().as_value()])),
                        Followed::Follow(from, _) => {
                            plan.hops.cached(from.clone());
                            return Ok(command(ruby, "cache_follow", &[from.into_value_with(ruby)]));
                        }
                    }
                }
                let tainted = st.tainted && !st.crossed;
                return Ok(command(ruby, "serve_cache", &[tainted.into_value_with(ruby)]));
            }
        }
        if plan.cache_mode == "only-if-cached" {
            return Ok(command(ruby, "error", &[ruby.qnil().as_value()]));
        }
        // Fetch "fetch" step 12-13 / "HTTP-network-or-cache fetch": a bodyless request sends Content-Length: 0 only where
        // its method is POST or PUT (send-entity-body-none, request-headers custom-method).
        let upper = st.chain.method.to_ascii_uppercase();
        let drop_length = st.chain.body_empty && upper != "POST" && upper != "PUT";
        let referer = st.chain.referer();
        let (cross_origin, send_cookies, origin, sec, cookie_site, lax) = plan.hops.hop(st.chain.target.clone(), st.chain.method.clone(), st.chain.effective_origin.clone(), st.chain.ref_policy.clone());
        st.referer = referer.clone();
        st.cross_origin = cross_origin;
        st.send_cookies = send_cookies;
        st.answered = false;
        // (…an authentication entry sent ahead of a challenge, where the request includes credentials, sent no
        // Authorization of its own and brought none to answer one with)
        let sent_authorization = st.chain.headers.iter().any(|(k, _)| k.eq_ignore_ascii_case(b"authorization"));
        let preemptive = if send_cookies && !sent_authorization && plan.challenge.is_none() {
            crate::http_auth::entry(plan.auth_entries, st.chain.target.clone())
        } else {
            None
        };
        // A CORS request to a URL with credentials is a network error (access-control-and-redirects "user info").
        if cross_origin && has_userinfo(&st.chain.target) {
            return Ok(command(ruby, "error", &[ruby.qnil().as_value()]));
        }
        // The CORS-preflight, judged at every hop: a cross-origin CORS-unsafe request's, unless the cache covers it.
        let origin_sent = st.chain.effective_origin.clone().unwrap_or_default();
        let preflight = if cross_origin {
            Self::unsafe_request(&st)
                .filter(|names| !crate::cors::covers_request(plan.preflight_cache, origin_sent.clone(), st.chain.target.clone(), plan.credentials == "include", st.chain.method.clone(), names.clone(), now))
                .map(|names| (names, origin_sent))
        } else {
            None
        };
        let facts = ruby.ary_from_iter([
            st.chain.method.clone().into_value_with(ruby),
            st.chain.target.clone().into_value_with(ruby),
            pairs(ruby, &plan.sent_headers(&st.chain.headers)).as_value(),
            drop_length.into_value_with(ruby),
            referer.into_value_with(ruby),
            send_cookies.into_value_with(ruby),
            preemptive.into_value_with(ruby),
            origin.into_value_with(ruby),
            sec.into_value_with(ruby),
            cookie_site.into_value_with(ruby),
            lax.into_value_with(ruby),
            st.revalidating.into_value_with(ruby),
        ]);
        Ok(command(ruby, "dispatch", &[facts.as_value(), preflight.into_value_with(ruby)]))
    }

    // #preflight_answer(response, now) -> whether the CORS-preflight's response ([status, its Access-Control-Allow-*
    // and -Max-Age values, its server delay]) grants the request — its grant stored in the preflight cache; a refusal lets
    // the cache's entries for the request's origin and URL go (Fetch "clear cache entries").
    fn preflight_answer(&self, response: (u32, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>, i64), now: f64) -> bool {
        let mut st = self.st.borrow_mut();
        let (status, acao, acac, methods, headers, max_age, delay) = response;
        st.delay_ms += delay;
        let origin = st.chain.effective_origin.clone().unwrap_or_default();
        let names = Self::unsafe_request(&st).unwrap_or_default();
        let granted = crate::cors::grant_preflight(
            self.preflight_cache,
            (status, acao, acac, methods, headers, max_age),
            origin.clone(),
            st.chain.target.clone(),
            self.credentials == "include",
            st.chain.method.clone(),
            names,
            now,
        );
        if !granted {
            crate::cors::forget(self.preflight_cache, origin, st.chain.target.clone());
        }
        granted
    }

    // #response(status, fields, sent_authorization) -> what the hop's response makes of the chain, its `fields`
    // [WWW-Authenticate, Access-Control-Allow-Origin, -Credentials, Referrer-Policy (parsed), server delay, Location
    // fields]:
    // - ['retry_auth', authorization] — a Basic challenge answered: the host sends the request again with it, and asks
    //   again;
    // - ['revalidated', expose, tainted] — a 304 that revalidates the stored response, the host's to refresh and answer
    //   with (`expose` whether credentialed, where its headers are a CORS response's to filter; nil where not);
    // - ['error', message] — a network error;
    // - ['opaque_redirect'] — a redirect, its request's mode "manual";
    // - ['follow', store, to_get] — the next hop (`store` whether the redirect response is stored first, `to_get`
    //   whether the request's body goes);
    // - ['error', nil, store] — a redirect that fails to be followed (`store` whether it is stored all the same);
    // - ['final', type, null body, store, expose, server delay, tainted, navigation [method, Referer]] — the response.
    fn response(ruby: &Ruby, rb_self: &Self, status: u32, fields: RArray, sent_authorization: bool) -> Result<RArray, Error> {
        let plan = rb_self;
        let mut st = plan.st.borrow_mut();
        let (www, acao, acac, policy, delay, locations): (Option<String>, Option<String>, Option<String>, Option<String>, i64, RArray) = TryConvert::try_convert(fields.as_value())?;
        st.delay_ms += delay;
        // Transparent HTTP Basic authentication (http_auth.rs `answers_challenge`): answered once.
        if !st.answered && crate::http_auth::answers_challenge(status, plan.challenge.is_some(), plan.cors && st.crossed, st.send_cookies, sent_authorization, www.as_deref()) {
            st.answered = true;
            return Ok(command(ruby, "retry_auth", &[plan.challenge.clone().into_value_with(ruby)]));
        }
        // (…the credentials an answered challenge brought kept for the origin that did not refuse them again)
        if let Some(challenge) = plan.challenge.as_ref().filter(|_| st.answered && status != 401) {
            crate::http_auth::accepted(plan.auth_entries, st.chain.target.clone(), challenge.clone());
        }
        let credentialed = plan.credentials == "include";
        let expose = st.cross_origin.then_some(credentialed);
        if status == 304 && st.revalidating {
            let tainted = st.tainted && !st.crossed;
            return Ok(command(ruby, "revalidated", &[expose.into_value_with(ruby), tainted.into_value_with(ruby)]));
        }
        // Fetch "CORS check", on every cross-origin response — a redirect's too; a request that took the preflight path
        // failing it lets the preflight cache's entries for its origin and URL go.
        if st.cross_origin {
            let origin = st.chain.effective_origin.clone();
            if !crate::cors::check(acao.as_deref(), acac.as_deref(), origin.as_deref(), credentialed) {
                if Self::unsafe_request(&st).is_some() {
                    crate::cors::forget(plan.preflight_cache, origin.unwrap_or_default(), st.chain.target.clone());
                }
                return Ok(command(ruby, "error", &[ruby.qnil().as_value()]));
            }
        }
        // A redirect in a mode that does not follow it, its status alone: `error` a network error; `manual` an
        // opaque-redirect, but none of another origin for a no-cors request.
        if redirect_status(status) && plan.redirect_mode != "follow" {
            if plan.redirect_mode == "error" {
                return Ok(command(ruby, "error", &[REDIRECT_ERROR.into_value_with(ruby)]));
            }
            if plan.no_cors && st.crossed {
                return Ok(command(ruby, "error", &[ruby.qnil().as_value()]));
            }
            return Ok(command(ruby, "opaque_redirect", &[]));
        }
        let store = plan.writes_cache(&st.chain.method);
        if redirect_status(status) {
            let referer = st.referer.clone();
            match plan.follow(&mut st, status, locations)? {
                Followed::Answer => {}
                Followed::Fail => return Ok(command(ruby, "error", &[ruby.qnil().as_value(), store.into_value_with(ruby)])),
                Followed::Follow(_, to_get) => {
                    st.chain.refer_on(referer, policy);
                    return Ok(command(ruby, "follow", &[store.into_value_with(ruby), to_get.into_value_with(ruby)]));
                }
            }
        }
        let null_body = st.chain.method.eq_ignore_ascii_case("HEAD") || NULL_BODY.contains(&status);
        let kind = if plan.no_cors && st.crossed {
            "opaque"
        } else if st.crossed {
            "cors"
        } else {
            "basic"
        };
        let tainted = st.tainted && !st.crossed;
        let navigation = plan.navigation.then(|| (st.chain.method.clone(), st.referer.clone()));
        Ok(command(
            ruby,
            "final",
            &[
                kind.into_value_with(ruby),
                null_body.into_value_with(ruby),
                store.into_value_with(ruby),
                expose.into_value_with(ruby),
                st.delay_ms.into_value_with(ruby),
                tainted.into_value_with(ruby),
                navigation.into_value_with(ruby),
            ],
        ))
    }

    // Fetch "HTTP-redirect fetch" (fetch_chain.rs `follow`), the request judged as this fetch's mode has it.
    fn follow(&self, st: &mut State, status: u32, locations: RArray) -> Result<Followed, Error> {
        let locations = locations.into_iter().map(|l| magnus::RString::try_convert(l).map(crate::fetch_rules::ruby_bytes)).collect::<Result<Vec<_>, _>>()?;
        let judged = Judged { cors: self.cors, origin: self.origin.as_deref().unwrap_or(""), tainting_cors: self.cors && st.crossed };
        Ok(st.chain.follow(status, &locations, &judged))
    }
}

pub(crate) fn define(native: RModule, ruby: &Ruby) -> Result<(), Error> {
    let class = native.define_class("FetchPlan", ruby.class_object())?;
    class.define_singleton_method("new", function!(FetchPlan::new, 2))?;
    class.define_method("target", method!(FetchPlan::target, 0))?;
    class.define_method("request_method", method!(FetchPlan::request_method, 0))?;
    class.define_method("redirected?", method!(FetchPlan::redirected, 0))?;
    class.define_method("begin_hop", method!(FetchPlan::begin_hop, 2))?;
    class.define_method("preflight_answer", method!(FetchPlan::preflight_answer, 2))?;
    class.define_method("response", method!(FetchPlan::response, 3))?;
    Ok(())
}
