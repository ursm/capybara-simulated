// The request a fetch() or an XMLHttpRequest's send() hands to Fetch, described once, by the engine, for whichever leg
// answers it — and likewise those an EventSource's connection, a WebSocket's opening handshake, a worker's
// `importScripts()` and a subresource's service worker leg make: what its caller made — a Request's request, an XHR's
// (request_state.rs) — with what Fetch gives it before any leg does: its default headers where its author set none of
// their names ("fetch" steps 12-13 — a service worker's fetch event sees them: Firefox shows it `Accept-Language` too,
// where Chrome adds that one in its network layer), its referrer source its client's where it is `about:client` and its
// referrer policy its policy container's where it names none (main fetch steps 8-9), and its client: the realm, its URL,
// its origin, its document's ancestors' origins. And which leg that is: a preload its document has, a scheme's
// processor, a network error, the controlling service worker, a keepalive request's own thread, or the network
// (fetch_rules.rs `request_route`). The bindings keep what is a page's: the body, its stream, the promise or the events.

use crate::dom::{dom, realm_id, register, RealmArena};
use crate::fetch_rules::{ROUTE_NETWORK, ROUTE_SERVICE_WORKER};
use crate::request_state::Request;
use crate::sw_request::{byte_text, SwRequest};

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    register(scope, ns, "fetchRequest", fetch_request_op, context_id);
    register(scope, ns, "eventSourceRequest", event_source_request_op, context_id);
    register(scope, ns, "webSocketRequest", web_socket_request_op, context_id);
    register(scope, ns, "importScriptRequest", import_script_request_op, context_id);
    register(scope, ns, "subresourceWorkerRequest", subresource_worker_request_op, context_id);
}

// A record of `fields`, made as an object literal makes one (CreateDataProperty: no setter of the page's runs), its
// names internalized, as a literal's are: no string of a name made anew per request.
fn record<'s>(scope: &mut v8::PinScope<'s, '_>, fields: &[(&str, v8::Local<'s, v8::Value>)]) -> v8::Local<'s, v8::Object> {
    let obj = v8::Object::new(scope);
    for (name, value) in fields {
        if let Some(name) = v8::String::new_from_one_byte(scope, name.as_bytes(), v8::NewStringType::Internalized) {
            obj.create_data_property(scope, name.into(), *value);
        }
    }
    obj
}
fn text<'s>(scope: &mut v8::PinScope<'s, '_>, s: &str) -> v8::Local<'s, v8::Value> {
    v8::String::new(scope, s).map_or_else(|| v8::undefined(scope).into(), Into::into)
}
fn optional<'s>(scope: &mut v8::PinScope<'s, '_>, s: Option<&str>) -> v8::Local<'s, v8::Value> {
    match s {
        Some(s) => text(scope, s),
        None => v8::null(scope).into(),
    }
}
fn flag<'s>(scope: &mut v8::PinScope<'s, '_>, b: bool) -> v8::Local<'s, v8::Value> {
    v8::Boolean::new(scope, b).into()
}
// (…a byte string as the code points its bytes are)
fn latin1<'s>(scope: &mut v8::PinScope<'s, '_>, bytes: &[u8]) -> Option<v8::Local<'s, v8::String>> {
    v8::String::new_from_one_byte(scope, bytes, v8::NewStringType::Normal)
}

// The header list as it goes on the wire — the author's, each name as first given, a name's fields combined with ", "
// (the host takes a map) — and the defaults (`default_request_headers`) where it has none of their names, and the
// credentials an XHR's open() brought, under the host's marker no author header may forge (fetch_plan.rs reads it).
fn wire_headers(list: &crate::headers::HeaderList, destination: &str, challenge: Option<&[u8]>) -> Vec<(Vec<u8>, Vec<u8>)> {
    let mut headers: Vec<(Vec<u8>, Vec<u8>)> = Vec::new();
    for (name, value) in list.wire() {
        match headers.iter_mut().find(|(n, _)| n == name) {
            Some((_, combined)) => {
                combined.extend_from_slice(b", ");
                combined.extend_from_slice(value);
            }
            None => headers.push((name.to_vec(), value.to_vec())),
        }
    }
    for (name, value) in crate::fetch_rules::default_request_headers(destination) {
        if !headers.iter().any(|(n, _)| n.eq_ignore_ascii_case(name.as_bytes())) {
            headers.push((name.into(), value.into()));
        }
    }
    if let Some(challenge) = challenge {
        headers.push((b"X-Csim-Auth-Challenge".to_vec(), challenge.to_vec()));
    }
    headers
}

// The client a request realm `cid` makes is of (Fetch "request client"): the realm, its URL, its origin, its policy
// container's referrer policy ('' for none: a worker's is not modeled), the referrer source a request whose referrer is
// `about:client` refers by (referrer.rs `client_referrer_source`), and its document's ancestors' document origins, which
// its cookies are judged by (`request_ancestors`; none in a worker, which has no document).
struct Client {
    realm: i32,
    url: String,
    origin: String,
    policy: &'static str,
    referrer: Option<String>,
    ancestors: Vec<Option<String>>,
}
impl Client {
    fn of(arena: &mut RealmArena, cid: i32) -> Client {
        let realm = arena.enter(cid);
        let (url, origin) = (realm.location.href().to_owned(), realm.location.origin().to_owned());
        let policy = realm.realm_document(cid).map_or("", |doc| realm.document_referrer_policy(doc));
        let referrer = crate::referrer::client_referrer_source(arena, cid);
        let ancestors = crate::referrer::request_ancestors(arena, cid);
        Client { realm: cid, url, origin, policy, referrer, ancestors }
    }
}
// The referrer policy a request is made under (Fetch "main fetch" step 8, Referrer Policy §3): its own, else its
// policy container's, else the default.
pub(crate) fn request_policy<'p>(own: &'p str, container: &'p str) -> &'p str {
    [own, container].into_iter().find(|p| !p.is_empty()).unwrap_or(crate::url_ops::DEFAULT_POLICY)
}

// The host's description of a request (browser.rb `rack_fetch_request`): `fields`, and its client's facts after them.
fn host_record<'s>(scope: &mut v8::PinScope<'s, '_>, mut fields: Vec<(&str, v8::Local<'s, v8::Value>)>, client: &Client) -> v8::Local<'s, v8::Object> {
    let ancestors: Vec<v8::Local<v8::Value>> = client.ancestors.iter().map(|a| optional(scope, a.as_deref())).collect();
    fields.push(("clientRealm", v8::Integer::new(scope, client.realm).into()));
    fields.push(("clientUrl", text(scope, &client.url)));
    fields.push(("clientOrigin", text(scope, &client.origin)));
    fields.push(("ancestors", v8::Array::new_with_elements(scope, &ancestors).into()));
    record(scope, &fields)
}
// …its header list as the host takes it: a map of each name to its value, made on no prototype (no name of the page's
// `Object.prototype` reads through) — each a byte string, as the code points its bytes are.
pub(crate) fn header_record<'s>(scope: &mut v8::PinScope<'s, '_>, headers: &[(Vec<u8>, Vec<u8>)]) -> v8::Local<'s, v8::Value> {
    let fields: Vec<(v8::Local<v8::String>, v8::Local<v8::String>)> =
        headers.iter().filter_map(|(name, value)| Some((latin1(scope, name)?, latin1(scope, value)?))).collect();
    null_proto_record(scope, &fields)
}
// …or each a text the host sends as its UTF-8 bytes (an EventSource's `Last-Event-ID`: HTML "the last event ID string,
// encoded as UTF-8").
fn text_header_record<'s>(scope: &mut v8::PinScope<'s, '_>, headers: &[(&str, &str)]) -> v8::Local<'s, v8::Value> {
    let fields: Vec<(v8::Local<v8::String>, v8::Local<v8::String>)> =
        headers.iter().filter_map(|(name, value)| Some((v8::String::new(scope, name)?, v8::String::new(scope, value)?))).collect();
    null_proto_record(scope, &fields)
}
fn null_proto_record<'s>(scope: &mut v8::PinScope<'s, '_>, fields: &[(v8::Local<'s, v8::String>, v8::Local<'s, v8::String>)]) -> v8::Local<'s, v8::Value> {
    let null = v8::null(scope).into();
    let object = v8::Object::with_prototype_and_properties(scope, null, &[], &[]);
    for (name, value) in fields {
        object.create_data_property(scope, (*name).into(), (*value).into());
    }
    object.into()
}
// …a text, or undefined for none (a referrer: its client's).
fn or_undefined<'s>(scope: &mut v8::PinScope<'s, '_>, referrer: Option<&str>) -> v8::Local<'s, v8::Value> {
    match referrer {
        Some(r) => text(scope, r),
        None => v8::undefined(scope).into(),
    }
}

// What a service worker's fetch event is given of a request (sw_request.rs `SwRequest`): its referrer the one the
// network would be sent — of `source` under the policy it is made under, its own, its container's or the default
// (`request_policy`), none where `source` is none — its `Accept` its destination's where it has none.
// (…its client `client`'s)
fn worker_request(url: &str, headers: Vec<(String, String)>, destination: &str, policy: &str, client: &Client) -> SwRequest {
    worker_request_referred(url, headers, destination, policy, client.referrer.as_deref(), client)
}
fn worker_request_referred(url: &str, headers: Vec<(String, String)>, destination: &str, policy: &str, source: Option<&str>, client: &Client) -> SwRequest {
    let policy = request_policy(policy, "");
    let mut r = SwRequest { url: url.to_owned(), headers, destination: destination.to_owned(), referrer_policy: policy.to_owned(), ..SwRequest::default() };
    match source {
        Some(source) => r.refer(policy, source),
        None => r.referrer = Some(String::new()),
    }
    r.client = Some((client.url.clone(), client.origin.clone(), client.ancestors.clone()));
    r.accept_default();
    r
}
// The answer of a request op: `[route, request, worker, …more]`, the worker's undefined where none answers it.
fn answer(scope: &mut v8::PinScope<'_, '_>, mut rv: v8::ReturnValue<'_, v8::Value>, route: u32, request: v8::Local<'_, v8::Object>, worker: Option<v8::Local<'_, v8::Value>>, more: &[v8::Local<'_, v8::Value>]) {
    let route = v8::Integer::new_from_unsigned(scope, route).into();
    let worker = worker.unwrap_or_else(|| v8::undefined(scope).into());
    let mut items = vec![route, request.into(), worker];
    items.extend_from_slice(more);
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}

// __dom.fetchRequest(source, headers, challenge, controller, host) -> [route, request, worker, preloaded]: the request of
// `source` — a Request's state (`RequestStateBase`) or an XHR's (`XhrBase`) — its author's `headers` (a header list),
// `challenge` the credentials an XHR's open() brought (null none), `controller` the handle of the service worker
// controlling the calling realm (0 none), `host` the steps of the engine's own fetches (a preload's fetch runs through
// them): the leg that answers it (`ROUTE_*`); the host's description of it (browser.rb `rack_fetch_request`: its referrer
// the source, undefined for its client's); the number of its chain of hops through the controlling service worker, which
// the calling realm keeps (sw_request.rs `SwChain`: each hop's fetch event's request, its referrer the one its policy
// sends; undefined but for a request a service worker answers);
// and the response a preload had where one answers it — null for a network error (preload_map.rs `preloaded`).
fn fetch_request_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    // (…a Request's promise settles at an opaque response's head, which an XHR's events never wait on: workers.js)
    let (request, head_first): (Request, bool) = if let Some(r) = crate::request_state::request(scope, args.get(0)) {
        (r.borrow().clone(), true)
    } else if let Some(r) = crate::xhr_state::request_of(scope, args.get(0)) {
        (r, false)
    } else {
        return;
    };
    let Some(list) = crate::headers::list(scope, args.get(1)) else { return };
    let challenge = (!args.get(2).is_null_or_undefined()).then(|| crate::fetch_rules::byte_string(scope, args.get(2)));
    let authored = challenge.is_some() || !list.borrow().wire().is_empty();
    let headers = wire_headers(&list.borrow(), &request.destination, challenge.as_deref());
    let controlled = args.get(3).int32_value(scope).unwrap_or(0) != 0;
    let host = v8::Local::<v8::Function>::try_from(args.get(4)).ok();

    let client = Client::of(&mut dom(scope).arena, cid);
    let policy = if request.referrer_policy.is_empty() { client.policy } else { &request.referrer_policy };
    let referrer = if request.referrer == "about:client" { client.referrer.clone() } else { Some(request.referrer.clone()) };
    let preloaded = host.and_then(|host| crate::preload_map::preloaded(scope, cid, &request, authored, host));
    let route = if preloaded.is_some() {
        crate::fetch_rules::ROUTE_PRELOADED
    } else {
        crate::fetch_rules::request_route(&request.url, &request.mode, &client.origin, controlled, request.keepalive)
    };

    let fields = vec![
        ("method", text(scope, &request.method)),
        ("url", text(scope, &request.url)),
        ("headers", header_record(scope, &headers)),
        ("mode", text(scope, &request.mode)),
        ("credentials", text(scope, &request.credentials)),
        ("redirect", text(scope, &request.redirect)),
        ("cache", text(scope, &request.cache)),
        ("referrer", or_undefined(scope, referrer.as_deref())),
        ("referrerPolicy", text(scope, policy)),
        ("initiator", optional(scope, request.initiator.as_deref())),
        ("siteSeed", optional(scope, request.site_seed.as_deref())),
        ("originNull", flag(scope, request.origin_null)),
        ("cookieCrossSite", flag(scope, request.cookie_cross_site)),
        ("navigationCrossSite", flag(scope, request.navigation_cross_site)),
        ("corsPreflight", flag(scope, request.use_cors_preflight)),
        ("navDest", optional(scope, Some(request.destination.as_str()).filter(|d| !d.is_empty()))),
    ];
    let described = host_record(scope, fields, &client);
    // (…the chain of hops through the worker where one answers it: sw_request.rs `SwChain`)
    let worker = (route == ROUTE_SERVICE_WORKER).then(|| {
        let headers = headers.iter().map(|(n, v)| (byte_text(n), byte_text(v))).collect();
        let mut w = worker_request_referred(&request.url, headers, &request.destination, policy, referrer.as_deref(), &client);
        request.method.clone_into(&mut w.method);
        (w.mode, w.credentials, w.redirect, w.cache, w.integrity) =
            (request.mode.clone(), request.credentials.clone(), request.redirect.clone(), request.cache.clone(), request.integrity.clone());
        (w.keepalive, w.head_first) = (request.keepalive, head_first);
        chain(scope, cid, w, &client)
    });
    let preloaded = preloaded.unwrap_or_else(|| v8::undefined(scope).into());
    answer(scope, rv, route, described, worker, &[preloaded]);
}

// __dom.eventSourceRequest(state, controller) -> [route, request, worker]: the request an EventSource's connection makes
// (HTML "establish the connection", at construction and at each reconnection) of the source `state` wraps (event_source_
// state.rs) — a GET of its URL, `Accept: text/event-stream` and, on a reconnection, the last event ID string its stream
// left where that is not empty (`Last-Event-ID`, a header the user agent sets, which asks no CORS-preflight: fetch_plan.rs
// `ua_headers`), its mode `cors`, its credentials mode as `withCredentials` says, the HTTP cache bypassed (`no-store`),
// its referrer its client — and the leg that answers it: the service worker controlling the calling realm
// (`controller`, 0 none) for an http(s) URL — its chain of hops through the worker then (sw_request.rs `SwChain`) — else
// the network.
fn event_source_request_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    let Some((url, with_credentials, last_event_id)) = crate::event_source_state::request_facts(scope, args.get(0)) else { return };
    let controlled = args.get(1).int32_value(scope).unwrap_or(0) != 0;
    let client = Client::of(&mut dom(scope).arena, cid);
    let credentials = if with_credentials { "include" } else { "same-origin" };
    let mut headers = vec![("Accept", "text/event-stream")];
    if !last_event_id.is_empty() {
        headers.push(("Last-Event-ID", &last_event_id));
    }
    let route = match crate::fetch_rules::request_route(&url, "cors", &client.origin, controlled, false) {
        ROUTE_SERVICE_WORKER => ROUTE_SERVICE_WORKER,
        _ => ROUTE_NETWORK,
    };
    let ua_headers = [text(scope, "Last-Event-ID")];
    let fields = vec![
        ("method", text(scope, "GET")),
        ("url", text(scope, &url)),
        ("headers", text_header_record(scope, &headers)),
        ("mode", text(scope, "cors")),
        ("credentials", text(scope, credentials)),
        ("redirect", text(scope, "follow")),
        ("cache", text(scope, "no-store")),
        ("referrer", or_undefined(scope, client.referrer.as_deref())),
        ("referrerPolicy", text(scope, client.policy)),
        ("dest", text(scope, "")),
        ("uaHeaders", v8::Array::new_with_elements(scope, &ua_headers).into()),
    ];
    let described = host_record(scope, fields, &client);
    let worker = (route == ROUTE_SERVICE_WORKER).then(|| {
        let headers = headers.iter().map(|(n, v)| ((*n).to_owned(), (*v).to_owned())).collect();
        let mut w = worker_request(&url, headers, "", client.policy, &client);
        (w.method, w.mode, w.credentials, w.redirect, w.cache) = ("GET".into(), "cors".into(), credentials.into(), "follow".into(), "no-store".into());
        chain(scope, cid, w, &client)
    });
    answer(scope, rv, route, described, worker, &[]);
}

// __dom.webSocketRequest(state) -> [route, request]: the request a WebSocket's opening handshake makes (WebSockets
// "establish a WebSocket connection") of the socket `state` wraps (ws_state.rs) — a GET of its URL, its scheme `ws` made
// `http` and `wss` `https`, the subprotocols it offers in `Sec-WebSocket-Protocol`, its mode `websocket`, its
// credentials mode `include`, its cache mode `no-store`, its redirect mode `error`, and its referrer `no-referrer` (''):
// no `Referer` (Chrome and Firefox send none either, even under `unsafe-url`). The host fetches it as every request is
// (fetch_plan.rs `FetchPlan`: its cookies, its Origin, its cache mode's headers, its Fetch Metadata), over the socket it
// then speaks the protocol on. No service worker answers it (its service-workers mode is `none`): the network does.
fn web_socket_request_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    let Some((url, protocols)) = crate::ws_state::request_facts(scope, args.get(0)) else { return };
    let url = match url.split_once(':') {
        Some(("ws", rest)) => format!("http:{rest}"),
        Some(("wss", rest)) => format!("https:{rest}"),
        _ => url,
    };
    let client = Client::of(&mut dom(scope).arena, cid);
    let offered = protocols.join(", ");
    let headers = if offered.is_empty() { vec![] } else { vec![("Sec-WebSocket-Protocol", offered.as_str())] };
    let fields = vec![
        ("method", text(scope, "GET")),
        ("url", text(scope, &url)),
        ("headers", text_header_record(scope, &headers)),
        ("mode", text(scope, "websocket")),
        ("credentials", text(scope, "include")),
        ("redirect", text(scope, "error")),
        ("cache", text(scope, "no-store")),
        ("referrer", text(scope, "")),
        ("dest", text(scope, "")),
    ];
    let described = host_record(scope, fields, &client);
    answer(scope, rv, ROUTE_NETWORK, described, None, &[]);
}

// __dom.importScriptRequest(url, cache) -> [route, request]: the request a worker's `importScripts(url)` makes of the
// network, where no service worker answered it (HTML "fetch a classic worker-imported script"): a GET of `url`, its
// destination `script`, its cache mode `cache`, its referrer its client — the worker, whose script's URL refers.
fn import_script_request_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    let url = args.get(0).to_rust_string_lossy(scope);
    let cache = if args.get(1).is_string() { args.get(1).to_rust_string_lossy(scope) } else { "default".to_owned() };
    let client = Client::of(&mut dom(scope).arena, cid);
    let fields = vec![
        ("method", text(scope, "GET")),
        ("url", text(scope, &url)),
        ("redirect", text(scope, "follow")),
        ("cache", text(scope, &cache)),
        ("referrer", or_undefined(scope, client.referrer.as_deref())),
        ("referrerPolicy", text(scope, client.policy)),
        ("dest", text(scope, "script")),
    ];
    let described = host_record(scope, fields, &client);
    answer(scope, rv, ROUTE_NETWORK, described, None, &[]);
}

// __dom.subresourceWorkerRequest(plan, integrity, url, accept) -> the chain of hops through the controlling service worker
// (sw_request.rs `SwChain`) of the request a subresource of `plan` makes of `url` (subresource_plan.rs `plan`: its mode
// and credentials, the referrer policy it is made under — its element's `referrerpolicy` among them — and its
// destination), of `integrity` metadata, its `Accept` `accept`: referred by the calling realm.
fn subresource_worker_request_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    let plan = args.get(0).uint32_value(scope).unwrap_or(0);
    let integrity = if args.get(1).is_string() { args.get(1).to_rust_string_lossy(scope) } else { String::new() };
    let [url, accept] = [2, 3].map(|k| args.get(k).to_rust_string_lossy(scope));
    let (mode, credentials, own, _) = crate::subresource_plan::fields(plan);
    let client = Client::of(&mut dom(scope).arena, cid);
    let headers = vec![("Accept".to_owned(), accept)];
    let mut w = worker_request(&url, headers, crate::subresource_plan::destination(plan), request_policy(own, client.policy), &client);
    (w.method, w.mode, w.credentials, w.redirect, w.cache, w.integrity) =
        ("GET".into(), mode.into(), credentials.into(), "follow".into(), "default".into(), integrity);
    rv.set(chain(scope, cid, w, &client));
}
// The chain of `request`'s hops through the worker, kept by the realm `cid` that made it, its client `client`: its number.
fn chain<'s>(scope: &mut v8::PinScope<'s, '_>, cid: i32, request: SwRequest, client: &Client) -> v8::Local<'s, v8::Value> {
    let chain = crate::dom::realm(scope, cid).realm_state_mut(cid).map_or(0, |s| s.sw_chains.begin(request, client.origin.clone()));
    v8::Integer::new_from_unsigned(scope, chain).into()
}
