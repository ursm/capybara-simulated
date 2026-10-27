// The fetches the engine makes for a consumer of its own — the images a rendering update owes (rendered.rs), the
// resources connecting an element fetches for no consumer (subresources.rs `timed_resources`), an `<embed>`'s or an
// `<object>`'s resource, a face's `url()` source (font_files.rs) — in the order of Fetch "fetch": the request planned
// (subresource_plan.rs), a preload of it taken first (preload_map.rs: no fetch then, and no entry of its own), a
// same-origin request of another origin's URL a network error, else a controlling service worker's answer, else a
// scheme's or the network's, and the Resource Timing entry of what answered filed. What reaches past the engine the
// bindings do, through one host function `host(step, …)` (subresource-host.js, which lists its steps): the clock, the
// realm's document, a pending preload's fetch, a service worker's answer — at once, or as a `fetch` event's, later
// (`obtainResume`) — a `blob:` URL's bytes, the network's answer, a font file made of bytes or named by `local()`, and
// the filing of an entry.

use crate::dom::{realm, realm_id, register, NodeId};
use crate::font_files::Terminated;
use crate::subresource_plan::{destination, fields, plan_in, J_CSS_IMAGE, J_EMBED, J_TIMED};

// The host's steps (subresource-host.js `H_*`).
const H_NOW: u32 = 0;
const H_SW_ANSWER: u32 = 2;
const H_SW_DISPATCH: u32 = 3;
const H_NETWORK: u32 = 4;
const H_FILE: u32 = 5;
const H_BLOB: u32 = 6;
const H_DOCUMENT: u32 = 7;
const H_FONT_BYTES: u32 = 8;
const H_FONT_NETWORK: u32 = 9;
pub(crate) const H_LOCAL_FONT: u32 = 10;
const H_FETCH: u32 = 11;
const H_LINK_EVENT: u32 = 12;
const H_ASSET: u32 = 13;

// What a link's fetch came to (`linkObtain`): its resource loads or not — or it is the bindings' to fetch (a style sheet's,
// a preload's), or a controlling service worker's to answer, the engine's then to fire its event (constants.js
// `LINK_*`).
const LINK_ERROR: u32 = 0;
const LINK_LOAD: u32 = 1;
const LINK_LEGACY: u32 = 2;
const LINK_PENDING: u32 = 3;
const fn link_done(ok: bool) -> u32 {
    if ok { LINK_LOAD } else { LINK_ERROR }
}

// What processing a plugin element came to (`processPlugin`): it had a resource to process, an `<object>`'s that
// failed, and its fallback content shown or no longer (constants.js `PLUGIN_*`).
const PLUGIN_FOUND: u32 = 1;
const PLUGIN_FAILED: u32 = 2;
const PLUGIN_FALLBACK_CHANGED: u32 = 4;

// A request as the engine made it — its consumer `kind` (`J_*`), its element and document, its `plan`, the realm it is
// made as (its client: its element's node document's) and the sheet that refers it — with its entry's initiator type and
// its start time; kept while a service worker's `fetch` event is to answer it (`RealmArena::obtains`), by the realm
// that made it (`cid`).
#[derive(Clone)]
pub(crate) struct Request {
    cid: i32,
    kind: u32,
    url: String,
    el: Option<NodeId>,
    doc: Option<NodeId>,
    plan: u32,
    client: Option<i32>,
    referrer: Option<String>,
    // (…its `integrity` metadata, as it was made: a link's)
    integrity: String,
    // (…a preload's, its destination and its link's plan of it: `LinkPreload::id`, 0 for one of no plan)
    preload: Option<(&'static str, u32)>,
    initiator: &'static str,
    started: f64,
}
impl Request {
    // (…which the realm `cid`'s discarding, or its document's going, lets go of: it is answered by no one then — one of
    // no document's only the realm's)
    pub(crate) fn of_realm(&self, cid: i32) -> bool {
        self.cid == cid
    }
    pub(crate) fn doc(&self) -> Option<NodeId> {
        self.doc
    }
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    register(scope, ns, "fetchCssImages", fetch_css_images_op, context_id);
    register(scope, ns, "fetchTimedResources", fetch_timed_resources_op, context_id);
    register(scope, ns, "obtainResume", resume_op, context_id);
    register(scope, ns, "processPlugin", process_plugin_op, context_id);
    register(scope, ns, "linkObtain", link_obtain_op, context_id);
    register(scope, ns, "linkPreloadPlan", link_preload_plan_op, context_id);
    register(scope, ns, "linkPreloadId", link_preload_id_op, context_id);
    register(scope, ns, "linkPreloadRun", link_preload_run_op, context_id);
}

// `host(step, …args)` on the page side: what it answers, none for null or undefined, or where it throws — Terminated
// where the script was.
pub(crate) fn call(scope: &mut v8::PinScope<'_, '_>, host: v8::Local<'_, v8::Function>, step: u32, args: &[v8::Local<'_, v8::Value>]) -> Result<Option<v8::Global<v8::Value>>, Terminated> {
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
    obj.get(scope, k.into()).filter(|v| !v.is_null_or_undefined())
}

// "Consume a preloaded resource" for `request`: the response the preload of it had, None for a network error — its
// fetch run first where it was yet to — or None where none answers it, as none does a request of no document's (a
// worker's).
fn preloaded(scope: &mut v8::PinScope<'_, '_>, host: v8::Local<'_, v8::Function>, r: &Request) -> Result<Option<Option<crate::preload_map::Response>>, Terminated> {
    let Some(doc) = r.doc else { return Ok(None) };
    crate::preload_map::consume(scope, r.cid, (doc, &r.url, destination(r.plan), r.plan), "", host)
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
    let r = Request { cid, kind: J_CSS_IMAGE, url, el: None, doc: Some(doc), plan, client: None, referrer, integrity: String::new(), preload: None, initiator, started };
    if preloaded(scope, host, &r)?.is_some() {
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
    let r = Request { cid, kind, url, el: Some(el), doc: Some(doc), plan, client, referrer: None, integrity: String::new(), preload: None, initiator, started };
    if preloaded(scope, host, &r)?.is_some() {
        return Ok(());
    }
    if code & 15 == crate::subresources::SAME_ORIGIN_REFUSED {
        return file(scope, host, &r, Answered::Network(None));
    }
    let Some(r) = dispatch(scope, host, r)? else { return Ok(()) };
    from_network(scope, host, &r).map(drop)
}

// `request` handed to the controlling service worker's `fetch` event, its answer the engine's later (`obtainResume`) —
// or, where no worker controls the document (or the URL is no http(s) one), handed back.
fn dispatch(scope: &mut v8::PinScope<'_, '_>, host: v8::Local<'_, v8::Function>, r: Request) -> Result<Option<Request>, Terminated> {
    let cid = r.cid;
    let token = {
        let arena = realm(scope, cid);
        arena.obtain_tokens += 1;
        arena.obtain_tokens
    };
    let mut args = request_args(scope, &r).to_vec();
    args.push(v8::Integer::new_from_unsigned(scope, token).into());
    let integrity = text(scope, &r.integrity);
    args.push(integrity);
    // (…kept before the event is dispatched: a worker that is gone answers at once, letting the request through)
    realm(scope, cid).obtains.insert(token, r);
    if call(scope, host, H_SW_DISPATCH, &args)?.is_some_and(|d| v8::Local::new(scope, d).is_true()) {
        return Ok(None);
    }
    Ok(realm(scope, cid).obtains.remove(&token))
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
    if r.kind & 0xff == crate::subresource_judge::J_LINK {
        let _ = prefetch_answered(scope, host, &r, v8::Local::<v8::Object>::try_from(args.get(1)).ok(), args.get(2).is_true());
        return;
    }
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
                let r = Request { cid, kind, url, el: Some(el), doc: Some(doc), plan, client, referrer: None, integrity: String::new(), preload: None, initiator: dest, started };
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

// The font file a face's `url()` source gives (font_files.rs `source_file`), referred by `referrer` — its rule's sheet's
// location, None its document's — the request of a font (cors, credentials same-origin): a preload of it taken first,
// else a controlling service worker's answer, else a `blob:` URL's bytes, else the network's; the answer's bytes the
// file where they are a font's (`judge`: a network error, an empty body none) — the host's decoding of them — and the
// entry of what answered filed, initiator `css`, as Chrome files a font a stylesheet pulled in (none for a preload's).
pub(crate) fn font_file(scope: &mut v8::PinScope<'_, '_>, cid: i32, url: &str, referrer: Option<&str>, host: v8::Local<'_, v8::Function>) -> Result<Option<String>, Terminated> {
    use crate::subresource_judge::{facts_of, judge, Consumer, J_FONT, SRC_NETWORK, SRC_SW_SYNC, S_EMPTY, V_OK};
    let consumer = Consumer { kind: J_FONT, obtains: 0, module_destination: "", preload_destination: "", integrity: "", body: b"", mode: "cors", quirks: false };
    let empty = |bytes: &[u8]| if bytes.is_empty() { S_EMPTY } else { 0 };
    let started = now(scope, host)?;
    let plan = plan_in(realm(scope, cid), J_FONT, None, None, referrer);
    let doc = call(scope, host, H_DOCUMENT, &[])?.and_then(|d| v8::Local::new(scope, d).integer_value(scope)).and_then(NodeId::from_i64);
    let r = Request { cid, kind: J_FONT, url: url.to_owned(), el: None, doc, plan, client: None, referrer: referrer.map(str::to_owned), integrity: String::new(), preload: None, initiator: "css", started };
    if let Some(preloaded) = preloaded(scope, host, &r)? {
        let Some(response) = preloaded else { return Ok(None) };
        let facts = response.facts();
        let body = response.into_body();
        if judge(&consumer, SRC_NETWORK | empty(&body), &facts) & V_OK == 0 {
            return Ok(None);
        }
        return file_of_bytes(scope, host, body);
    }
    let args = request_args(scope, &r);
    if let Some(answer) = call(scope, host, H_SW_ANSWER, &args)? {
        let local = v8::Local::new(scope, &answer);
        let answer_obj = v8::Local::<v8::Object>::try_from(local).ok();
        let bytes = answer_obj.and_then(|a| member(scope, a, "bytes")).and_then(|b| crate::canvas::bytes_read(b, None)).map(|b| b.into_owned());
        let facts = facts_of(scope, answer_obj, J_FONT, SRC_SW_SYNC);
        let ok = judge(&consumer, SRC_SW_SYNC | bytes.as_deref().map_or(S_EMPTY, empty), &facts) & V_OK != 0;
        file(scope, host, &r, Answered::Worker(answer))?;
        return match bytes.filter(|_| ok) {
            Some(bytes) => file_of_bytes(scope, host, bytes),
            None => Ok(None),
        };
    }
    if crate::fetch_rules::fetch_route(url, 0, "") == crate::fetch_rules::ROUTE_BLOB {
        let u = text(scope, url);
        let blob = call(scope, host, H_BLOB, &[u])?.map(|b| v8::Local::new(scope, b));
        let bytes = blob.and_then(|b| v8::Local::<v8::Object>::try_from(b).ok()).and_then(|b| member(scope, b, "bytes"));
        let bytes = bytes.and_then(|b| crate::canvas::bytes_read(b, None)).map(|b| b.into_owned());
        return match bytes {
            Some(bytes) => file_of_bytes(scope, host, bytes),
            None => Ok(None),
        };
    }
    // (…the network's: the host decodes the file it fetched — `{path, meta}` — and gives its response's facts for the
    // entry)
    let got = call(scope, host, H_FONT_NETWORK, &args)?.map(|g| v8::Local::new(scope, g));
    let got = got.and_then(|g| v8::Local::<v8::Object>::try_from(g).ok());
    let path = got.and_then(|g| member(scope, g, "path")).filter(|p| p.is_string()).map(|p| p.to_rust_string_lossy(scope));
    let meta = got.and_then(|g| member(scope, g, "meta")).filter(|m| !m.is_null()).map(|m| v8::Global::new(scope, m));
    file(scope, host, &r, Answered::Network(meta))?;
    Ok(path)
}
// …the file a font's bytes are, as the host decodes them: none where they are no font.
fn file_of_bytes(scope: &mut v8::PinScope<'_, '_>, host: v8::Local<'_, v8::Function>, bytes: Vec<u8>) -> Result<Option<String>, Terminated> {
    let bytes = crate::blob_data::byte_array(scope, bytes);
    let path = call(scope, host, H_FONT_BYTES, &[bytes])?;
    Ok(text_of(scope, path))
}
// The text a host step answered, none where it answered no string.
pub(crate) fn text_of(scope: &mut v8::PinScope<'_, '_>, answer: Option<v8::Global<v8::Value>>) -> Option<String> {
    answer.map(|a| v8::Local::new(scope, a)).filter(|a| a.is_string()).map(|a| a.to_rust_string_lossy(scope))
}

// __dom.linkObtain(el, doc, url, kind, plan, integrity, moduleDestination, host) -> what the `<link>` `el`'s fetch of
// `url` (of document `doc`) comes to, `LINK_*`: `kind` its consumer's (J_LINK, what it obtains in the high bits),
// `plan` and `integrity` its request's as its fetch began (bridge.entry.js `requestAsItBegins`; a modulepreload's of
// no `integrity` attribute its import map's), `moduleDestination` a modulepreload's `as` destination. A style sheet's
// and a preload's are the bindings' still (`LINK_LEGACY`), whose memos the cascade and a preload's consumers share.
//   - a modulepreload: a controlling service worker's answer, else the asset cache's that the module loader shares
//     (HTML "fetch a modulepreload module script graph": a CORS request), else — a URL the cache does not take — the
//     network's;
//   - a prefetch: a controlling service worker's `fetch` event's, whose answer the engine takes later and fires the
//     link's event for (`LINK_PENDING`), else the network's;
//   - any other (a manifest's): the network's;
// its verdict the engine's (`judge`: what the link obtains, its integrity) and its entry filed.
fn link_obtain_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    use crate::link_resource::{OBTAINS_MODULEPRELOAD, OBTAINS_PREFETCH, OBTAINS_PRELOAD, OBTAINS_STYLESHEET};
    rv.set_uint32(LINK_LEGACY);
    let kind = args.get(3).uint32_value(scope).unwrap_or(0);
    let obtains = kind >> 8;
    if obtains & OBTAINS_STYLESHEET != 0 {
        return;
    }
    let Ok(host) = v8::Local::<v8::Function>::try_from(args.get(7)) else { return };
    let (Some(el), Some(doc)) = (crate::dom::nid_arg(scope, &args, 0), crate::dom::nid_arg(scope, &args, 1)) else { return };
    let url = args.get(2).to_rust_string_lossy(scope);
    let plan = args.get(4).uint32_value(scope).unwrap_or(0);
    let integrity = args.get(5).to_rust_string_lossy(scope);
    let module_destination = if args.get(6).is_string() { args.get(6).to_rust_string_lossy(scope) } else { String::new() };
    let cid = realm_id(scope, &args);
    let Ok(started) = now(scope, host) else { return };
    let client = realm(scope, cid).get(el).map(|n| n.realm);
    let r = Request { cid, kind, url, el: Some(el), doc: Some(doc), plan, client, referrer: None, integrity, preload: None, initiator: "link", started };
    let done = if obtains & OBTAINS_PRELOAD != 0 {
        // (…a preload of no plan — its URL none the network answers — run as it is obtained, and committed)
        let destination = crate::script::preload_destination(&preload_as(scope, el, cid)).unwrap_or("");
        let r = Request { preload: Some((destination, 0)), ..r };
        run_preload(scope, host, r).map(link_done)
    } else if obtains & OBTAINS_MODULEPRELOAD != 0 {
        modulepreload(scope, host, &r, &module_destination).map(link_done)
    } else if obtains & OBTAINS_PREFETCH != 0 {
        match dispatch(scope, host, r) {
            Ok(None) => Ok(LINK_PENDING),
            Ok(Some(r)) => prefetch_verdict(scope, host, &r, None, false).map(link_done),
            Err(t) => Err(t),
        }
    } else {
        link_from_network(scope, host, &r, "").map(link_done)
    };
    if let Ok(done) = done {
        rv.set_uint32(done);
    }
}

// The verdict on what answered a link's request (`judge`), from `source` — `bytes` its body's (none asked for where the
// request has no integrity), `destinations` a modulepreload's and a preload's.
fn link_verdict(scope: &mut v8::PinScope<'_, '_>, r: &Request, facts: &crate::subresource_judge::Facts, source: u32, bytes: Option<v8::Local<'_, v8::Value>>, mode: &str, (module_destination, preload_destination): (&str, &str)) -> bool {
    use crate::subresource_judge::{judge, Consumer, V_OK};
    let body = if r.integrity.is_empty() {
        Vec::new()
    } else {
        match bytes {
            Some(b) if b.is_string() => b.to_rust_string_lossy(scope).into_bytes(),
            Some(b) => crate::canvas::bytes_read(b, None).map(|b| b.into_owned()).unwrap_or_default(),
            None => Vec::new(),
        }
    };
    let quirks = realm(scope, r.cid).document_mode(r.doc).0;
    let consumer = Consumer { kind: r.kind & 0xff, obtains: r.kind >> 8, module_destination, preload_destination, integrity: &r.integrity, body: &body, mode, quirks };
    judge(&consumer, source, facts) & V_OK != 0
}

// …a link's request answered by the network (its response's body's bytes with it): whether it loads, its entry filed.
fn link_from_network(scope: &mut v8::PinScope<'_, '_>, host: v8::Local<'_, v8::Function>, r: &Request, module_destination: &str) -> Result<bool, Terminated> {
    use crate::subresource_judge::{facts_of, SRC_NETWORK};
    let args = request_args(scope, r);
    let resp = call(scope, host, H_FETCH, &args)?.map(|resp| v8::Local::new(scope, resp));
    let resp = resp.and_then(|resp| v8::Local::<v8::Object>::try_from(resp).ok());
    let facts = facts_of(scope, resp, r.kind & 0xff, SRC_NETWORK);
    let bytes = resp.and_then(|resp| member(scope, resp, "body_bytes"));
    let ok = link_verdict(scope, r, &facts, SRC_NETWORK, bytes, "no-cors", (module_destination, ""));
    file(scope, host, r, Answered::Network(resp.map(|resp| v8::Global::new(scope, v8::Local::<v8::Value>::from(resp)))))?;
    Ok(ok)
}

// …a modulepreload's: a controlling service worker's answer (a script's request: `event.request.integrity` its
// metadata), else the asset cache's (`[body, meta, bytes]`, judged by the response facts it kept — none for one cached
// before they were — its body none of a response it refused), else the network's.
fn modulepreload(scope: &mut v8::PinScope<'_, '_>, host: v8::Local<'_, v8::Function>, r: &Request, module_destination: &str) -> Result<bool, Terminated> {
    use crate::subresource_judge::{facts_of, SRC_ASSET, SRC_SW_SYNC, S_NO_BODY};
    let mut args = request_args(scope, r).to_vec();
    let (binary, integrity) = (v8::Boolean::new(scope, false).into(), text(scope, &r.integrity));
    args.extend([binary, integrity]);
    if let Some(answer) = call(scope, host, H_SW_ANSWER, &args)? {
        let local = v8::Local::new(scope, &answer);
        let obj = v8::Local::<v8::Object>::try_from(local).ok();
        let body = obj.and_then(|a| member(scope, a, "body_bytes").or_else(|| member(scope, a, "body")));
        let no_body = if obj.and_then(|a| member(scope, a, "body")).is_none() { S_NO_BODY } else { 0 };
        let facts = facts_of(scope, obj, r.kind & 0xff, SRC_SW_SYNC);
        let ok = link_verdict(scope, r, &facts, SRC_SW_SYNC | no_body, body, "no-cors", (module_destination, ""));
        file(scope, host, r, Answered::Worker(answer))?;
        return Ok(ok);
    }
    if crate::fetch_rules::fetch_route(&r.url, 0, "") != crate::fetch_rules::ROUTE_NETWORK {
        return link_from_network(scope, host, r, module_destination);
    }
    let args = request_args(scope, r);
    let got = call(scope, host, H_ASSET, &args)?.map(|g| v8::Local::new(scope, g));
    let got = got.and_then(|g| v8::Local::<v8::Array>::try_from(g).ok());
    let mut at = [None; 3];
    if let Some(g) = got {
        for (k, slot) in at.iter_mut().enumerate() {
            *slot = g.get_index(scope, k as u32).filter(|v| !v.is_null_or_undefined());
        }
    }
    let [body, meta, bytes] = at;
    let meta = meta.and_then(|m| v8::Local::<v8::Object>::try_from(m).ok());
    let facts = facts_of(scope, meta, r.kind & 0xff, SRC_ASSET);
    let no_body = if body.is_none() { S_NO_BODY } else { 0 };
    let ok = link_verdict(scope, r, &facts, SRC_ASSET | no_body, bytes.or(body), "no-cors", (module_destination, ""));
    file(scope, host, r, Answered::Network(meta.map(|m| v8::Global::new(scope, v8::Local::<v8::Value>::from(m)))))?;
    Ok(ok)
}

// A controlled prefetch's answer (`obtainResume`): its verdict and entry (`prefetch_verdict`), and its element's `load`
// or `error` fired.
fn prefetch_answered(scope: &mut v8::PinScope<'_, '_>, host: v8::Local<'_, v8::Function>, r: &Request, answer: Option<v8::Local<'_, v8::Object>>, redirected: bool) -> Result<(), Terminated> {
    let ok = prefetch_verdict(scope, host, r, answer, redirected)?;
    let Some(el) = r.el else { return Ok(()) };
    let (nid, ok) = (v8::Number::new(scope, el.to_f64()).into(), v8::Boolean::new(scope, ok).into());
    call(scope, host, H_LINK_EVENT, &[nid, ok]).map(drop)
}
// …whether a prefetch loads: its answer — the worker's, as an entry reads it (`redirected` whether the response it
// answered with says it was), or none where it let the request through, which the network answers then, the request as
// it was made — a response Fetch lets answer it, whatever its status (HTML's prefetch "process the linked resource"),
// whose bytes match its integrity; its entry what answered, a refused answer's a network error.
fn prefetch_verdict(scope: &mut v8::PinScope<'_, '_>, host: v8::Local<'_, v8::Function>, r: &Request, answer: Option<v8::Local<'_, v8::Object>>, redirected: bool) -> Result<bool, Terminated> {
    use crate::subresource_judge::{facts_of, SRC_SW_EVENT};
    let Some(answer) = answer else { return link_from_network(scope, host, r, "") };
    let mut facts = facts_of(scope, Some(answer), r.kind & 0xff, SRC_SW_EVENT);
    facts.redirected = redirected;
    let bytes = member(scope, answer, "bytes");
    let ok = link_verdict(scope, r, &facts, SRC_SW_EVENT, bytes, fields(r.plan).0, ("", ""));
    let answered = if ok {
        answer
    } else {
        let refused = v8::Object::new(scope);
        let (k, yes) = (text(scope, "blocked"), v8::Boolean::new(scope, true).into());
        refused.set(scope, k, yes);
        refused
    };
    file(scope, host, r, Answered::Worker(v8::Global::new(scope, v8::Local::<v8::Value>::from(answered))))?;
    Ok(ok)
}

// A `<link rel=preload>`'s plan of its fetch (HTML `preload`): its preload key — its document, URL, destination and
// request — the request it made, a number of its own, whether its fetch ran and what it came to, whether its load task
// ran, and whether the parser planned it as it inserted the link (`early`). Kept by the link (`RealmArena::link_preloads`)
// until it plans another, its document loads anew (`preloadsForget`) or it goes.
pub(crate) struct LinkPreload {
    key: crate::preload_map::Key,
    request: Request,
    id: u32,
    got: Option<bool>,
    loaded: bool,
    early: bool,
}
impl LinkPreload {
    pub(crate) fn doc(&self) -> NodeId {
        self.key.doc()
    }
}

// The `as` of a link, for the destination of a preload of it.
fn preload_as(scope: &mut v8::PinScope<'_, '_>, el: NodeId, cid: i32) -> String {
    realm(scope, cid).get(el).and_then(|n| n.plain_attr("as")).unwrap_or("").to_owned()
}

// __dom.linkPreloadPlan(el, doc, url, kind, plan, integrity, early, host) -> the number of the plan the
// `<link rel=preload>` `el` (of document `doc`) has of its fetch of `url` — its request's `plan` and `integrity` as its
// fetch begins, its destination its `as`'s — made now where it has none of this key, or its load task ran: the entry
// put in its document's map, pending (preload_map.rs), which a consumer that comes first runs. A later plan of another
// key withdraws the one before it, which no consumer took — but the parser's (`early`) had begun, and runs (Chrome:
// its first `href`'s fetched too).
fn link_preload_plan_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Ok(host) = v8::Local::<v8::Function>::try_from(args.get(7)) else { return };
    let (Some(el), Some(doc)) = (crate::dom::nid_arg(scope, &args, 0), crate::dom::nid_arg(scope, &args, 1)) else { return };
    let url = args.get(2).to_rust_string_lossy(scope);
    let kind = args.get(3).uint32_value(scope).unwrap_or(0);
    let plan = args.get(4).uint32_value(scope).unwrap_or(0);
    let integrity = args.get(5).to_rust_string_lossy(scope);
    let early = args.get(6).is_true();
    let cid = realm_id(scope, &args);
    let Some(destination) = crate::script::preload_destination(&preload_as(scope, el, cid)) else { return };
    let key = crate::preload_map::Key::new(doc, &url, destination, plan);
    let before = realm(scope, cid).link_preloads.get(&el).map(|p| (p.key == key && !p.loaded, p.id, p.got.is_none(), p.early, p.key.clone()));
    if let Some((same, id, unrun, was_early, before_key)) = before {
        if same {
            return rv.set_uint32(id);
        }
        if unrun {
            let pending = realm(scope, cid).preload_take_pending(&before_key, |r| r.preload.is_some_and(|(_, i)| i == id));
            if was_early {
                let request = match pending {
                    Some(r) => r,
                    None => realm(scope, cid).link_preloads[&el].request.clone(),
                };
                if run_preload(scope, host, request).is_err() {
                    return;
                }
            }
        }
    }
    let Ok(started) = now(scope, host) else { return };
    let arena = realm(scope, cid);
    arena.obtain_tokens += 1;
    let id = arena.obtain_tokens;
    let client = arena.get(el).map(|n| n.realm);
    let request = Request { cid, kind, url, el: Some(el), doc: Some(doc), plan, client, referrer: None, integrity: integrity.clone(), preload: Some((destination, id)), initiator: "link", started };
    arena.preload_begin(key.clone(), integrity, request.clone());
    arena.link_preloads.insert(el, LinkPreload { key, request, id, got: None, loaded: false, early });
    rv.set_uint32(id);
}

// __dom.linkPreloadId(el) -> the number of the link's latest plan of a preload, undefined for none: a load task of an
// earlier one fires nothing.
fn link_preload_id_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(el) = crate::dom::nid_arg(scope, &args, 0) else { return };
    let cid = realm_id(scope, &args);
    if let Some(p) = realm(scope, cid).link_preloads.get(&el) {
        rv.set_uint32(p.id);
    }
}

// __dom.linkPreloadRun(el, host) -> what the link's planned preload came to (`LINK_LOAD` / `LINK_ERROR`) as its load task
// runs: its fetch run now where no consumer ran it first — once, the plan's — or `LINK_LEGACY` where it planned none.
fn link_preload_run_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    rv.set_uint32(LINK_LEGACY);
    let Ok(host) = v8::Local::<v8::Function>::try_from(args.get(1)) else { return };
    let Some(el) = crate::dom::nid_arg(scope, &args, 0) else { return };
    let cid = realm_id(scope, &args);
    let Some(p) = realm(scope, cid).link_preloads.get_mut(&el) else { return };
    p.loaded = true;
    let (got, id, key) = (p.got, p.id, p.key.clone());
    let ok = match got {
        Some(ok) => ok,
        None => {
            let pending = realm(scope, cid).preload_take_pending(&key, |r| r.preload.is_some_and(|(_, i)| i == id));
            let request = match pending {
                Some(r) => r,
                None => realm(scope, cid).link_preloads[&el].request.clone(),
            };
            let Ok(ok) = run_preload(scope, host, request) else { return };
            ok
        }
    };
    rv.set_uint32(link_done(ok));
}

// A preload's fetch run (`linkPreloadRun`, or a consumer that came first: preload_map.rs `consume`): a controlling
// service worker's answer (any destination's: Handle Fetch), else — a style sheet's or a classic script's, which their
// consumers fetch through the asset cache — the asset cache's, else the network's; its verdict for the link
// (`link_verdict`: its `nosniff`, its integrity), its entry filed, and the response committed to its document's map —
// a network error's included, as one that fails its integrity is (Fetch "main fetch") — for the first fetch that
// matches it. Its link's plan, where it is still the one, learns what it came to.
pub(crate) fn run_preload(scope: &mut v8::PinScope<'_, '_>, host: v8::Local<'_, v8::Function>, r: Request) -> Result<bool, Terminated> {
    use crate::subresource_judge::{facts_of, SRC_ASSET, SRC_NETWORK, SRC_SW_SYNC, S_NO_BODY};
    let (destination, id) = r.preload.unwrap_or(("", 0));
    let kind = r.kind & 0xff;
    let mut args = request_args(scope, &r).to_vec();
    let (binary, integrity) = (v8::Boolean::new(scope, true).into(), text(scope, &r.integrity));
    args.extend([binary, integrity]);
    let (ok, answered, response) = if let Some(answer) = call(scope, host, H_SW_ANSWER, &args)? {
        let local = v8::Local::new(scope, &answer);
        let obj = v8::Local::<v8::Object>::try_from(local).ok();
        let bytes = obj.and_then(|a| member(scope, a, "bytes"));
        let no_body = if bytes.is_none() { S_NO_BODY } else { 0 };
        let facts = facts_of(scope, obj, kind, SRC_SW_SYNC);
        let ok = link_verdict(scope, &r, &facts, SRC_SW_SYNC | no_body, bytes, "no-cors", ("", destination));
        let response = crate::preload_map::response_of(scope, obj);
        (ok, Answered::Worker(answer), response)
    } else if matches!(destination, "style" | "script") && crate::fetch_rules::fetch_route(&r.url, 0, "") == crate::fetch_rules::ROUTE_NETWORK {
        let args = request_args(scope, &r);
        let got = call(scope, host, H_ASSET, &args)?.map(|g| v8::Local::new(scope, g));
        let got = got.and_then(|g| v8::Local::<v8::Array>::try_from(g).ok());
        let mut at = [None; 3];
        if let Some(g) = got {
            for (k, slot) in at.iter_mut().enumerate() {
                *slot = g.get_index(scope, k as u32).filter(|v| !v.is_null_or_undefined());
            }
        }
        let [body, meta, bytes] = at;
        let meta = meta.and_then(|m| v8::Local::<v8::Object>::try_from(m).ok());
        let facts = facts_of(scope, meta, kind, SRC_ASSET);
        let no_body = if body.is_none() { S_NO_BODY } else { 0 };
        let ok = link_verdict(scope, &r, &facts, SRC_ASSET | no_body, bytes.or(body), "no-cors", ("", destination));
        // (…the body the cache holds: its bytes, where they are not its text's UTF-8)
        let held = match (bytes, body) {
            (Some(b), _) => crate::canvas::bytes_read(b, None).map(|b| b.into_owned()),
            (None, Some(t)) => Some(t.to_rust_string_lossy(scope).into_bytes()),
            (None, None) => None,
        };
        let response = match (crate::preload_map::response_of(scope, meta), held) {
            (Some(resp), Some(held)) => Some(resp.with_body(held)),
            (None, Some(held)) => Some(crate::preload_map::Response::of_body(held)),
            (resp, None) => resp,
        };
        (ok, Answered::Network(meta.map(|m| v8::Global::new(scope, v8::Local::<v8::Value>::from(m)))), response)
    } else {
        let args = request_args(scope, &r);
        let resp = call(scope, host, H_FETCH, &args)?.map(|resp| v8::Local::new(scope, resp));
        let resp = resp.and_then(|resp| v8::Local::<v8::Object>::try_from(resp).ok());
        let facts = facts_of(scope, resp, kind, SRC_NETWORK);
        let bytes = resp.and_then(|resp| member(scope, resp, "body_bytes"));
        let ok = link_verdict(scope, &r, &facts, SRC_NETWORK, bytes, "no-cors", ("", destination));
        let response = crate::preload_map::response_of(scope, resp);
        (ok, Answered::Network(resp.map(|resp| v8::Global::new(scope, v8::Local::<v8::Value>::from(resp)))), response)
    };
    file(scope, host, &r, answered)?;
    let response = response.filter(|resp| r.integrity.is_empty() || crate::integrity::response_matches(resp.body(), &r.integrity, !resp.opaque()));
    let arena = realm(scope, r.cid);
    if let Some(doc) = r.doc {
        arena.preload_commit(crate::preload_map::Key::new(doc, &r.url, destination, r.plan), r.integrity.clone(), response);
    }
    if let Some(plan) = r.el.and_then(|el| arena.link_preloads.get_mut(&el)).filter(|p| p.id == id && id != 0) {
        plan.got = Some(ok);
    }
    Ok(ok)
}
