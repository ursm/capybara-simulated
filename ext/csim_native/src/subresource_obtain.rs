// The fetches the engine makes for a consumer of its own — the images a rendering update owes (rendered.rs), the
// resources connecting an element fetches for no consumer (subresources.rs `timed_resources`) — in the order of Fetch
// "fetch": the request planned (subresource_plan.rs), a preload of it taken first (preload_map.rs: no fetch then, and no
// entry of its own), a same-origin request of another origin's URL a network error, else a controlling service worker's
// answer, else the network's, and the Resource Timing entry of what answered filed. What reaches past the engine the
// bindings do, through one host function `host(step, …)` (subresource-host.js): the clock, a pending preload's fetch, a
// service worker's answer — at once, or as a `fetch` event's, later (`obtainResume`) — the network's and the filing of an
// entry.

use crate::dom::{realm, realm_id, register, NodeId};
use crate::font_files::Terminated;
use crate::subresource_plan::{destination, fields, plan_in, J_CSS_IMAGE, J_EMBED, J_TIMED};

// The host's steps (subresource-host.js `H_*`).
const H_NOW: u32 = 0;
const H_RUN_PRELOAD: u32 = 1;
const H_SW_ANSWER: u32 = 2;
const H_SW_DISPATCH: u32 = 3;
const H_NETWORK: u32 = 4;
const H_FILE: u32 = 5;
const H_BLOB: u32 = 6;

// What processing a plugin element came to (`processPlugin`): it had a resource to process, an `<object>`'s that
// failed, and its fallback content shown or no longer (constants.js `PLUGIN_*`).
const PLUGIN_FOUND: u32 = 1;
const PLUGIN_FAILED: u32 = 2;
const PLUGIN_FALLBACK_CHANGED: u32 = 4;

// A request as the engine made it — its consumer `kind` (`J_*`), its element and document, its `plan`, the realm it is
// made as (its client: its element's node document's) and the sheet that refers it — with its entry's initiator type and
// its start time; kept while a service worker's `fetch` event is to answer it (`RealmArena::obtains`), by the realm
// that made it (`cid`).
pub(crate) struct Request {
    cid: i32,
    kind: u32,
    url: String,
    el: Option<NodeId>,
    doc: NodeId,
    plan: u32,
    client: Option<i32>,
    referrer: Option<String>,
    initiator: &'static str,
    started: f64,
}
impl Request {
    // (…which the realm `cid`'s discarding, or its document's going, lets go of: it is answered by no one then)
    pub(crate) fn of_realm(&self, cid: i32) -> bool {
        self.cid == cid
    }
    pub(crate) fn doc(&self) -> NodeId {
        self.doc
    }
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    register(scope, ns, "fetchCssImages", fetch_css_images_op, context_id);
    register(scope, ns, "fetchTimedResources", fetch_timed_resources_op, context_id);
    register(scope, ns, "obtainResume", resume_op, context_id);
    register(scope, ns, "processPlugin", process_plugin_op, context_id);
}

// `host(step, …args)` on the page side: what it answers, none for null or undefined, or where it throws — Terminated
// where the script was.
fn call(scope: &mut v8::PinScope<'_, '_>, host: v8::Local<'_, v8::Function>, step: u32, args: &[v8::Local<'_, v8::Value>]) -> Result<Option<v8::Global<v8::Value>>, Terminated> {
    let mut all = Vec::with_capacity(args.len() + 1);
    all.push(v8::Integer::new_from_unsigned(scope, step).into());
    all.extend_from_slice(args);
    let undefined = v8::undefined(scope).into();
    v8::tc_scope!(let tc, scope);
    let answer = host.call(tc, undefined, &all);
    if tc.has_terminated() {
        return Err(Terminated);
    }
    Ok(answer.filter(|v| !v.is_null_or_undefined()).map(|v| v8::Global::new(tc, v)))
}
// …the clock the bindings keep.
fn now(scope: &mut v8::PinScope<'_, '_>, host: v8::Local<'_, v8::Function>) -> Result<f64, Terminated> {
    let t = call(scope, host, H_NOW, &[])?;
    Ok(t.and_then(|t| v8::Local::new(scope, t).number_value(scope)).unwrap_or(0.0))
}

fn text<'s>(scope: &mut v8::PinScope<'s, '_>, s: &str) -> v8::Local<'s, v8::Value> {
    v8::String::new(scope, s).map_or_else(|| v8::undefined(scope).into(), Into::into)
}
fn text_or_null<'s>(scope: &mut v8::PinScope<'s, '_>, s: Option<&str>) -> v8::Local<'s, v8::Value> {
    match s {
        Some(s) => text(scope, s),
        None => v8::null(scope).into(),
    }
}
fn member<'s>(scope: &mut v8::PinScope<'s, '_>, obj: v8::Local<'_, v8::Object>, k: &str) -> Option<v8::Local<'s, v8::Value>> {
    let k = v8::String::new(scope, k)?;
    obj.get(scope, k.into()).filter(|v| !v.is_undefined())
}

// "Consume a preloaded resource" for `request`: whether a preload answered it, its fetch run first where it was yet to.
fn preloaded(scope: &mut v8::PinScope<'_, '_>, host: v8::Local<'_, v8::Function>, r: &Request) -> Result<bool, Terminated> {
    let run = |scope: &mut v8::PinScope<'_, '_>, token: u32| {
        let token = v8::Integer::new_from_unsigned(scope, token).into();
        call(scope, host, H_RUN_PRELOAD, &[token]).map(drop)
    };
    Ok(crate::preload_map::consume(scope, r.cid, (r.doc, &r.url, destination(r.plan), r.plan), "", run)?.is_some())
}

// The request's `url`, `plan`, referrer and client, as the host's steps take a request.
fn request_args<'s>(scope: &mut v8::PinScope<'s, '_>, r: &Request) -> [v8::Local<'s, v8::Value>; 4] {
    let client = match r.client {
        Some(c) => v8::Integer::new(scope, c).into(),
        None => v8::undefined(scope).into(),
    };
    [text(scope, &r.url), v8::Integer::new_from_unsigned(scope, r.plan).into(), text_or_null(scope, r.referrer.as_deref()), client]
}

// What answered a request, as its entry tells it: the network's facts of its response (`resp`, none for a network
// error), or a service worker's answer (`answer`: `{bytes, status, type, headers}`, `{blocked}` for none that is a
// response).
enum Answered {
    Network(Option<v8::Global<v8::Value>>),
    Worker(v8::Global<v8::Value>),
}

// The network's answer to `request`, and its entry filed: the facts of its response, none for a network error.
fn from_network(scope: &mut v8::PinScope<'_, '_>, host: v8::Local<'_, v8::Function>, r: &Request) -> Result<Option<v8::Global<v8::Value>>, Terminated> {
    let args = request_args(scope, r);
    let resp = call(scope, host, H_NETWORK, &args)?;
    file(scope, host, r, Answered::Network(resp.clone()))?;
    Ok(resp)
}

// The entry of `request` filed (performance.js `recordResourceTiming`).
fn file(scope: &mut v8::PinScope<'_, '_>, host: v8::Local<'_, v8::Function>, r: &Request, answered: Answered) -> Result<(), Terminated> {
    let (field, value) = match answered {
        Answered::Network(Some(resp)) => ("resp", v8::Local::new(scope, resp)),
        Answered::Network(None) => ("resp", v8::null(scope).into()),
        Answered::Worker(answer) => ("answer", v8::Local::new(scope, answer)),
    };
    let nid = match r.el {
        Some(id) => v8::Number::new(scope, id.to_f64()).into(),
        None => v8::undefined(scope).into(),
    };
    let fields = [
        ("name", text(scope, &r.url)),
        ("kind", v8::Integer::new_from_unsigned(scope, r.kind).into()),
        ("nid", nid),
        ("plan", v8::Integer::new_from_unsigned(scope, r.plan).into()),
        ("initiatorType", text(scope, r.initiator)),
        ("startTime", v8::Number::new(scope, r.started).into()),
        (field, value),
    ];
    let desc = v8::Object::new(scope);
    for (k, v) in fields {
        let k = text(scope, k);
        desc.set(scope, k, v);
    }
    call(scope, host, H_FILE, &[desc.into()]).map(drop)
}

// __dom.fetchCssImages(doc, host): the images the rendering update owes (rendered.rs `take_owed_css_images`) fetched for
// `doc`, each for its `css` (or `body`) Resource Timing entry — none where `doc` is none (a document with no root now,
// the images let go all the same). A browser fetches a `background-image` / `cursor` / `list-style-image` `url()` when a
// rendered element uses it; the driver paints no background yet, so the fetch is for what a page observes of it: its
// service worker's `fetch` event (destination `image`) and its entry.
fn fetch_css_images_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let doc = crate::dom::nid_arg(scope, &args, 0);
    let owed = crate::rendered::take_owed_css_images(scope, &args);
    let (Some(doc), Ok(host)) = (doc, v8::Local::<v8::Function>::try_from(args.get(1))) else { return };
    let cid = realm_id(scope, &args);
    for (initiator, url, referrer) in owed {
        if fetch_css_image(scope, cid, doc, host, initiator, url, referrer).is_err() {
            return;
        }
    }
}

// …one of them, referred by the sheet that declared it — `referrer` its location, None its document's (CSS Values 4 "fetch
// a style resource": no-cors, credentials `include`, under that sheet's referrer policy where its response set one —
// Referrer Policy §7). Its answer is a controlling service worker's first, whose network error is no image and whose
// fall-through goes to the network; the network's is fetched for its entry alone: nothing paints it, so nothing decodes
// it.
fn fetch_css_image(scope: &mut v8::PinScope<'_, '_>, cid: i32, doc: NodeId, host: v8::Local<'_, v8::Function>, initiator: &'static str, url: String, referrer: Option<String>) -> Result<(), Terminated> {
    let started = now(scope, host)?;
    let plan = plan_in(realm(scope, cid), J_CSS_IMAGE, None, Some(doc), referrer.as_deref());
    let r = Request { cid, kind: J_CSS_IMAGE, url, el: None, doc, plan, client: None, referrer, initiator, started };
    if preloaded(scope, host, &r)? {
        return Ok(());
    }
    let args = request_args(scope, &r);
    match call(scope, host, H_SW_ANSWER, &args)? {
        Some(answer) => file(scope, host, &r, Answered::Worker(answer)),
        None => from_network(scope, host, &r).map(drop),
    }
}

// __dom.fetchTimedResources(el, doc, host): the resources connecting `el` (of document `doc`) fetches for no consumer —
// a video's poster and a media element's shown tracks, an SVG `<use>`'s external document — each once for the page
// (subresources.rs `timed_resources`), fetched for its Resource Timing entry, each its own destination's request (Fetch
// Metadata) planned by its `cors` code (subresource_plan.rs, J_TIMED). (A media element's own data is its load
// algorithm's fetch: media.rs.) A controlling service worker answers each, as any request but a plugin's (Handle
// Fetch), its `fetch` event's answer later (`obtainResume`).
fn fetch_timed_resources_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Ok(host) = v8::Local::<v8::Function>::try_from(args.get(2)) else { return };
    let (Some(el), Some(doc)) = (crate::dom::nid_arg(scope, &args, 0), crate::dom::nid_arg(scope, &args, 1)) else { return };
    let cid = realm_id(scope, &args);
    let found = crate::subresources::timed_resources(realm(scope, cid), el, doc);
    for (initiator, url, code) in found {
        if fetch_timed(scope, cid, el, doc, host, initiator, url, code).is_err() {
            return;
        }
    }
}

// …one of them: `code` its request's (`timed_resources`), a preload of it taken first, and a same-origin one of
// another origin's URL a network error before any service worker or network (Fetch "main fetch" step 12), filed as one.
#[allow(clippy::too_many_arguments)]
fn fetch_timed(scope: &mut v8::PinScope<'_, '_>, cid: i32, el: NodeId, doc: NodeId, host: v8::Local<'_, v8::Function>, initiator: &'static str, url: String, code: u32) -> Result<(), Terminated> {
    let started = now(scope, host)?;
    let kind = J_TIMED | code << 8;
    let arena = realm(scope, cid);
    let plan = plan_in(arena, kind, Some(el), Some(doc), None);
    let client = arena.get(el).map(|n| n.realm);
    let r = Request { cid, kind, url, el: Some(el), doc, plan, client, referrer: None, initiator, started };
    if preloaded(scope, host, &r)? {
        return Ok(());
    }
    if code & 15 == crate::subresources::SAME_ORIGIN_REFUSED {
        return file(scope, host, &r, Answered::Network(None));
    }
    let token = {
        let arena = realm(scope, cid);
        arena.obtain_tokens += 1;
        arena.obtain_tokens
    };
    let mut args = request_args(scope, &r).to_vec();
    args.push(v8::Integer::new_from_unsigned(scope, token).into());
    // (…kept before the event is dispatched: a worker that is gone answers at once, letting the request through)
    realm(scope, cid).obtains.insert(token, r);
    if call(scope, host, H_SW_DISPATCH, &args)?.is_some_and(|d| v8::Local::new(scope, d).is_true()) {
        return Ok(());
    }
    let Some(r) = realm(scope, cid).obtains.remove(&token) else { return Ok(()) };
    from_network(scope, host, &r).map(drop)
}

// __dom.obtainResume(token, answer, redirected, host): a service worker's `fetch` event's answer to the request `token`
// named (`fetch_timed`) — `answer` its facts as an entry reads them (sw-client.js `workerAnswerFacts`, `{blocked}` for a
// network error), `redirected` whether the response it answered with says it was — or null where it let the request
// through, which the network answers then: the request as it was made, whatever its element is now. An answer Fetch
// "HTTP fetch" step 5.5 does not let answer it is a network error.
fn resume_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Ok(host) = v8::Local::<v8::Function>::try_from(args.get(3)) else { return };
    let token = args.get(0).uint32_value(scope).unwrap_or(0);
    let cid = realm_id(scope, &args);
    let Some(r) = realm(scope, cid).obtains.remove(&token) else { return };
    let Ok(answer) = v8::Local::<v8::Object>::try_from(args.get(1)) else {
        let _ = from_network(scope, host, &r);
        return;
    };
    let kind = member(scope, answer, "type").map_or_else(|| "default".to_owned(), |t| t.to_rust_string_lossy(scope));
    let blocked = member(scope, answer, "blocked").is_some_and(|v| v.is_true());
    let answer = if blocked || crate::fetch_rules::service_worker_response_allowed(fields(r.plan).0, "follow", &kind, args.get(2).is_true()) {
        answer
    } else {
        let refused = v8::Object::new(scope);
        let (k, yes) = (text(scope, "blocked"), v8::Boolean::new(scope, true).into());
        refused.set(scope, k, yes);
        refused
    };
    let answer = v8::Global::new(scope, v8::Local::<v8::Value>::from(answer));
    let _ = file(scope, host, &r, Answered::Worker(answer));
}

// __dom.processPlugin(el, doc, host) -> what HTML's embed setup steps and object processing model came to for the
// `<embed>` or `<object>` `el` (of document `doc`) — run as it connects and as its `src` / `data` / `type` change — as
// `PLUGIN_*` bits: its resource (subresources.rs `plugin_resource`) fetched, a navigation request of its destination
// with its credentials included, which no service worker sees (Handle Fetch), its entry filed; an `<object>`'s network
// response that is no ok one a failure (`judge`), after which it shows its fallback content, as it does with no
// resource; a `data:` or `blob:` URL's none, whatever its bytes. An image the resource is — an SVG document's root's
// dimensions too — gives the element its natural size, which the layout sizes it from as an `<img>`'s (walk.rs
// `natural_intrinsic`); one with no resource to process has none.
fn process_plugin_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Ok(host) = v8::Local::<v8::Function>::try_from(args.get(2)) else { return };
    let (Some(el), Some(doc)) = (crate::dom::nid_arg(scope, &args, 0), crate::dom::nid_arg(scope, &args, 1)) else { return };
    let cid = realm_id(scope, &args);
    if let Ok(done) = process_plugin(scope, cid, el, doc, host) {
        rv.set_uint32(done);
    }
}
fn process_plugin(scope: &mut v8::PinScope<'_, '_>, cid: i32, el: NodeId, doc: NodeId, host: v8::Local<'_, v8::Function>) -> Result<u32, Terminated> {
    use crate::fetch_rules::{fetch_route, ROUTE_BLOB, ROUTE_DATA, ROUTE_NETWORK};
    use crate::subresource_judge::{judge, Consumer, J_OBJECT, SRC_NETWORK, V_OK};
    let found = crate::subresources::plugin_resource(realm(scope, cid), el, doc);
    let object = realm(scope, cid).get(el).is_some_and(|n| n.is_html_named("object"));
    let (mut failed, mut bytes) = (false, None);
    if let Some((dest, url)) = found.clone() {
        match fetch_route(&url, 0, "") {
            ROUTE_NETWORK => {
                let started = now(scope, host)?;
                let kind = if dest == "object" { J_OBJECT } else { J_EMBED };
                let arena = realm(scope, cid);
                let plan = plan_in(arena, kind, Some(el), Some(doc), None);
                let client = arena.get(el).map(|n| n.realm);
                let r = Request { cid, kind, url, el: Some(el), doc, plan, client, referrer: None, initiator: dest, started };
                let resp = from_network(scope, host, &r)?.map(|resp| v8::Local::new(scope, resp));
                let resp = resp.and_then(|resp| v8::Local::<v8::Object>::try_from(resp).ok());
                if dest == "object" {
                    let facts = crate::subresource_judge::facts_of(scope, resp, J_OBJECT, SRC_NETWORK);
                    let consumer = Consumer { kind: J_OBJECT, obtains: 0, module_destination: "", preload_destination: "", integrity: "", body: b"", mode: "navigate", quirks: false };
                    failed = judge(&consumer, SRC_NETWORK, &facts) & V_OK == 0;
                }
                if !failed {
                    let body = resp.and_then(|resp| member(scope, resp, "body"));
                    bytes = body.and_then(|b| crate::canvas::bytes_read(b, None)).map(|b| b.into_owned());
                }
            }
            ROUTE_DATA => bytes = crate::data_url::process(&url).map(|(_, body)| body),
            ROUTE_BLOB => {
                let u = text(scope, &url);
                let blob = call(scope, host, H_BLOB, &[u])?.map(|b| v8::Local::new(scope, b));
                let blob = blob.and_then(|b| v8::Local::<v8::Object>::try_from(b).ok());
                let blob = blob.and_then(|b| member(scope, b, "bytes"));
                bytes = blob.and_then(|b| crate::canvas::bytes_read(b, None)).map(|b| b.into_owned());
            }
            _ => {}
        }
    }
    let decoded = bytes.filter(|b| !b.is_empty()).map(|b| std::panic::catch_unwind(|| crate::image_decode::decode(&b, None)).unwrap_or(crate::image_decode::Decoded::Broken));
    let natural = match decoded {
        Some(crate::image_decode::Decoded::Bitmap(b)) => Some(b.natural),
        _ => None,
    };
    let arena = realm(scope, cid);
    arena.set_natural_size(el, natural);
    let mut done = if found.is_some() { PLUGIN_FOUND } else { 0 };
    if failed {
        done |= PLUGIN_FAILED;
    }
    if object && crate::subresources::set_object_fallback(arena, el, failed || found.is_none()) {
        done |= PLUGIN_FALLBACK_CHANGED;
    }
    Ok(done)
}
