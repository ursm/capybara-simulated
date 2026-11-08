// The request a fetch() or an XMLHttpRequest's send() hands to Fetch, described once, by the engine, for whichever leg
// answers it: what its caller made — a Request's request, an XHR's (request_state.rs) — with what Fetch gives it before
// any leg does: its default headers where its author set none of their names ("fetch" steps 12-13 — a service worker's
// fetch event sees them: Firefox shows it `Accept-Language` too, where Chrome adds that one in its network layer), its
// referrer source its client's where it is `about:client` and its referrer policy its policy container's where it names
// none (main fetch steps 8-9), and its client: the realm, its URL, its origin, its document's ancestors' origins. And
// which leg that is: a preload its document has, a scheme's processor, a network error, the controlling service worker,
// a keepalive request's own thread, or the network (fetch_rules.rs `request_route`). The bindings keep what is a
// page's: the body, its stream, the promise or the events.

use crate::dom::{dom, realm_id, register};
use crate::request_state::Request;

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    register(scope, ns, "fetchRequest", fetch_request_op, context_id);
}

// A record of `fields`, made as an object literal makes one (CreateDataProperty: no setter of the page's runs).
fn record<'s>(scope: &mut v8::PinScope<'s, '_>, fields: &[(&str, v8::Local<'s, v8::Value>)]) -> v8::Local<'s, v8::Object> {
    let obj = v8::Object::new(scope);
    for (name, value) in fields {
        if let Some(name) = v8::String::new(scope, name) {
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

// __dom.fetchRequest(source, headers, challenge, controller, host) -> [route, request, worker, preloaded]: the request of
// `source` — a Request's state (`RequestStateBase`) or an XHR's (`XhrBase`) — its author's `headers` (a header list),
// `challenge` the credentials an XHR's open() brought (null none), `controller` the handle of the service worker
// controlling the calling realm (0 none), `host` the steps of the engine's own fetches (a preload's fetch runs through
// them): the leg that answers it (`ROUTE_*`); the host's description of it (browser.rb `rack_fetch_request`: its referrer
// the source, undefined for its client's); the service worker's fetch event's (workers.js `swDispatchFetch`: its referrer
// the source the host resolves under its policy, the platform's default where neither it nor its container names one);
// and the response a preload had where one answers it — null for a network error (preload_map.rs `preloaded`).
fn fetch_request_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
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

    let arena = &mut dom(scope).arena;
    let realm = arena.enter(cid);
    let (client_url, here) = (realm.location.href().to_owned(), realm.location.origin().to_owned());
    let container = realm.realm_document(cid).map_or("", |doc| realm.document_referrer_policy(doc));
    let policy = if request.referrer_policy.is_empty() { container } else { &request.referrer_policy }.to_owned();
    let referrer = if request.referrer == "about:client" { crate::referrer::client_referrer_source(arena, cid) } else { Some(request.referrer.clone()) };
    let ancestors = crate::referrer::request_ancestors(arena, cid);
    let preloaded = host.and_then(|host| crate::preload_map::preloaded(scope, cid, &request, authored, host));
    let route = if preloaded.is_some() {
        crate::fetch_rules::ROUTE_PRELOADED
    } else {
        crate::fetch_rules::request_route(&request.url, &request.mode, &here, controlled, request.keepalive)
    };

    let null = v8::null(scope).into();
    let header_object = v8::Object::with_prototype_and_properties(scope, null, &[], &[]);
    for (name, value) in &headers {
        let (Some(name), Some(value)) = (latin1(scope, name), latin1(scope, value)) else { continue };
        header_object.create_data_property(scope, name.into(), value.into());
    }
    let ancestors: Vec<v8::Local<v8::Value>> = ancestors.iter().map(|a| optional(scope, a.as_deref())).collect();
    let described = [
        ("method", text(scope, &request.method)),
        ("url", text(scope, &request.url)),
        ("headers", header_object.into()),
        ("mode", text(scope, &request.mode)),
        ("credentials", text(scope, &request.credentials)),
        ("redirect", text(scope, &request.redirect)),
        ("cache", text(scope, &request.cache)),
        ("referrer", match referrer.as_deref() {
            Some(r) => text(scope, r),
            None => v8::undefined(scope).into(),
        }),
        ("referrerPolicy", text(scope, &policy)),
        ("initiator", optional(scope, request.initiator.as_deref())),
        ("siteSeed", optional(scope, request.site_seed.as_deref())),
        ("originNull", flag(scope, request.origin_null)),
        ("cookieCrossSite", flag(scope, request.cookie_cross_site)),
        ("navigationCrossSite", flag(scope, request.navigation_cross_site)),
        ("navDest", optional(scope, Some(request.destination.as_str()).filter(|d| !d.is_empty()))),
        ("clientRealm", v8::Integer::new(scope, cid).into()),
        ("clientUrl", text(scope, &client_url)),
        ("clientOrigin", text(scope, &here)),
        ("ancestors", v8::Array::new_with_elements(scope, &ancestors).into()),
    ];
    let described = record(scope, &described);
    let worker_policy = if policy.is_empty() { crate::url_ops::DEFAULT_POLICY } else { &policy };
    let worker = [
        ("redirect", text(scope, &request.redirect)),
        ("mode", text(scope, &request.mode)),
        ("credentials", text(scope, &request.credentials)),
        ("cache", text(scope, &request.cache)),
        ("keepalive", flag(scope, request.keepalive)),
        ("headFirst", flag(scope, head_first)),
        ("integrity", text(scope, &request.integrity)),
        ("destination", text(scope, &request.destination)),
        ("referrerPolicy", text(scope, worker_policy)),
        ("referrerSource", text(scope, referrer.as_deref().unwrap_or_default())),
    ];
    let worker = record(scope, &worker);
    let route = v8::Integer::new_from_unsigned(scope, route).into();
    let preloaded = preloaded.unwrap_or_else(|| v8::undefined(scope).into());
    rv.set(v8::Array::new_with_elements(scope, &[route, described.into(), worker.into(), preloaded]).into());
}
