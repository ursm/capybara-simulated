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

use crate::dom::{member, realm, realm_id, register, NodeId};
use crate::font_files::Terminated;
use crate::subresource_plan::{destination, fields, plan_in, J_CSS_IMAGE, J_EMBED, J_TIMED};

// The host's steps (subresource-host.js `H_*`).
pub(crate) const H_NOW: u32 = 0;
pub(crate) const H_SW_ANSWER: u32 = 2;
const H_SW_DISPATCH: u32 = 3;
pub(crate) const H_NETWORK: u32 = 4;
pub(crate) const H_FILE: u32 = 5;
pub(crate) const H_BLOB: u32 = 6;
pub(crate) const H_DOCUMENT: u32 = 7;
const H_FONT_BYTES: u32 = 8;
const H_FONT_NETWORK: u32 = 9;
pub(crate) const H_LOCAL_FONT: u32 = 10;
pub(crate) const H_FETCH: u32 = 11;
const H_LINK_EVENT: u32 = 12;
pub(crate) const H_ASSET: u32 = 13;
pub(crate) const H_CONTROLLER: u32 = 14;
pub(crate) const H_CHARSET: u32 = 15;
const H_IMAGE_START: u32 = 16;
const H_IMAGE_EVENT: u32 = 17;
const H_VIDEO_BYTES: u32 = 18;
const H_MEDIA_DONE: u32 = 19;
pub(crate) const H_FRAME_NAVIGATION: u32 = 20;
pub(crate) const H_LOAD_BLOCKER_SETTLED: u32 = 21;
pub(crate) const H_SW_IMPORT: u32 = 22;
pub(crate) const H_IMPORT_NETWORK: u32 = 23;
pub(crate) const H_SW_NOTE_IMPORT: u32 = 24;
const H_LOAD_IMAGE: u32 = 25;
const H_IMAGE_BLOB: u32 = 26;

// What a link's fetch came to (`linkObtain`, `linkPreloadRun`): its resource loads or not — or it has no preload planned
// (`linkPreloadRun`), or it is a controlling service worker's to answer, the engine's then to fire its event
// (constants.js `LINK_*`).
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
    // (…an image's, the load of its element's it is for: image_requests.rs, 0 for none)
    load: u32,
    // (…its element's object, held while a service worker is to answer: an element with a fetch under way and its
    // listeners is no garbage, its answer's events owed to it)
    holds: Option<v8::Global<v8::Value>>,
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
    register(scope, ns, "fetchClassicScript", fetch_classic_script_op, context_id);
    register(scope, ns, "imageObtain", image_obtain_op, context_id);
    register(scope, ns, "mediaFetchResource", media_fetch_resource_op, context_id);
    register(scope, ns, "linkObtain", link_obtain_op, context_id);
    register(scope, ns, "linkPreloadPlan", link_preload_plan_op, context_id);
    register(scope, ns, "linkPreloadId", link_preload_id_op, context_id);
    register(scope, ns, "linkPreloadRun", link_preload_run_op, context_id);
    register(scope, ns, "imageBlobLoad", image_blob_load_op, context_id);
    register(scope, ns, "imageArrive", image_arrive_op, context_id);
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
pub(crate) fn now(scope: &mut v8::PinScope<'_, '_>, host: v8::Local<'_, v8::Function>) -> Result<f64, Terminated> {
    let t = call(scope, host, H_NOW, &[])?;
    Ok(t.and_then(|t| v8::Local::new(scope, t).number_value(scope)).unwrap_or(0.0))
}

// The bytes a body's view is — an empty one's no bytes missing — none for anything but a view.
pub(crate) fn view_bytes(scope: &mut v8::PinScope<'_, '_>, v: v8::Local<'_, v8::Value>) -> Option<Vec<u8>> {
    v.is_array_buffer_view().then(|| crate::blob_data::bytes_arg(scope, v))
}

pub(crate) fn text<'s>(scope: &mut v8::PinScope<'s, '_>, s: &str) -> v8::Local<'s, v8::Value> {
    v8::String::new(scope, s).map_or_else(|| v8::undefined(scope).into(), Into::into)
}
pub(crate) fn text_or_null<'s>(scope: &mut v8::PinScope<'s, '_>, s: Option<&str>) -> v8::Local<'s, v8::Value> {
    match s {
        Some(s) => text(scope, s),
        None => v8::null(scope).into(),
    }
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
// error), a service worker's answer (`answer`: `{bytes, status, type, headers}`, `{blocked}` for none that is a
// response), or a body the asset cache kept no facts of (its text sizing the entry: an ok status's, none for none).
enum Answered {
    Network(Option<v8::Global<v8::Value>>),
    Worker(v8::Global<v8::Value>),
    Text(Option<String>),
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
    let desc = entry_desc(scope, r, answered);
    let desc = v8::Local::new(scope, desc);
    call(scope, host, H_FILE, &[desc]).map(drop)
}
// …its description, for the bindings to file where they file it later (a classic script's, as its load completes).
fn entry_desc(scope: &mut v8::PinScope<'_, '_>, r: &Request, answered: Answered) -> v8::Global<v8::Value> {
    let (field, value) = match answered {
        Answered::Network(Some(resp)) => ("resp", v8::Local::new(scope, resp)),
        Answered::Network(None) => ("resp", v8::null(scope).into()),
        Answered::Worker(answer) => ("answer", v8::Local::new(scope, answer)),
        Answered::Text(Some(body)) => ("body", text(scope, &body)),
        Answered::Text(None) => ("body", v8::undefined(scope).into()),
    };
    let status: v8::Local<v8::Value> = match field {
        "body" if !value.is_undefined() => v8::Integer::new(scope, 200).into(),
        _ => v8::undefined(scope).into(),
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
        ("status", status),
    ];
    let desc = v8::Object::new(scope);
    for (k, v) in fields {
        if !v.is_undefined() {
            let k = text(scope, k);
            desc.set(scope, k, v);
        }
    }
    v8::Global::new(scope, v8::Local::<v8::Value>::from(desc))
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
    let r = Request { cid, kind: J_CSS_IMAGE, url, el: None, doc: Some(doc), plan, client: None, referrer, integrity: String::new(), preload: None, load: 0, holds: None, initiator, started };
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
    let r = Request { cid, kind, url, el: Some(el), doc: Some(doc), plan, client, referrer: None, integrity: String::new(), preload: None, load: 0, holds: None, initiator, started };
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
fn dispatch(scope: &mut v8::PinScope<'_, '_>, host: v8::Local<'_, v8::Function>, mut r: Request) -> Result<Option<Request>, Terminated> {
    let cid = r.cid;
    if let Some(el) = r.el {
        let object = crate::dom::node_value(scope, Some(el));
        r.holds = (!object.is_null()).then(|| v8::Global::new(scope, object));
    }
    let token = {
        let arena = realm(scope, cid);
        arena.obtain_tokens += 1;
        arena.obtain_tokens
    };
    let mut args = request_args(scope, &r).to_vec();
    args.push(v8::Integer::new_from_unsigned(scope, token).into());
    let integrity = text(scope, &r.integrity);
    args.push(integrity);
    // (…its `Accept` the one Fetch gives a request of none, its plan's: what a worker negotiating a format reads)
    let accept = text(scope, crate::subresource_plan::accept(r.plan));
    args.push(accept);
    // (…kept before the event is dispatched: a worker that is gone answers at once, letting the request through)
    realm(scope, cid).obtains.insert(token, r);
    if call(scope, host, H_SW_DISPATCH, &args)?.is_some_and(|d| v8::Local::new(scope, d).is_true()) {
        return Ok(None);
    }
    Ok(realm(scope, cid).obtains.remove(&token))
}

// __dom.obtainResume(token, answer, redirected, render, host): a service worker's `fetch` event's answer to the request
// `token` named (`fetch_timed`'s, a link's, an image's) — `answer` its facts as an entry reads them (sw-client.js
// `workerAnswerFacts`, `{blocked}` for a network error), `redirected` whether the response it answered with says it was,
// `render` an opaque one's bytes, which an image paints though no script reads them — or null where it let the request
// through, which the network answers then: the request as it was made, whatever its element is now. An answer Fetch
// "HTTP fetch" step 5.5 does not let answer it is a network error.
fn resume_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Ok(host) = v8::Local::<v8::Function>::try_from(args.get(4)) else { return };
    let token = args.get(0).uint32_value(scope).unwrap_or(0);
    let cid = realm_id(scope, &args);
    let Some(r) = realm(scope, cid).obtains.remove(&token) else { return };
    if r.kind & 0xff == crate::subresource_judge::J_AUDIO {
        let render = view_bytes(scope, args.get(3));
        let _ = audio_answered(scope, host, &r, v8::Local::<v8::Object>::try_from(args.get(1)).ok(), args.get(2).is_true(), render);
        return;
    }
    if r.kind & 0xff == crate::subresource_judge::J_IMAGE {
        let render = view_bytes(scope, args.get(3));
        let _ = image_answered(scope, host, &r, v8::Local::<v8::Object>::try_from(args.get(1)).ok(), args.get(2).is_true(), render);
        return;
    }
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
                let r = Request { cid, kind, url, el: Some(el), doc: Some(doc), plan, client, referrer: None, integrity: String::new(), preload: None, load: 0, holds: None, initiator: dest, started };
                let resp = from_network(scope, host, &r)?.map(|resp| v8::Local::new(scope, resp));
                let resp = resp.and_then(|resp| v8::Local::<v8::Object>::try_from(resp).ok());
                if dest == "object" {
                    let facts = crate::subresource_judge::facts_of(scope, resp, J_OBJECT, SRC_NETWORK);
                    let consumer = Consumer { kind: J_OBJECT, obtains: 0, module_destination: "", preload_destination: "", integrity: "", body: b"", mode: "navigate", quirks: false };
                    failed = judge(&consumer, SRC_NETWORK, &facts) & V_OK == 0;
                }
                if !failed {
                    let body = resp.and_then(|resp| member(scope, resp, "body"));
                    bytes = body.and_then(|b| view_bytes(scope, b));
                }
            }
            ROUTE_DATA | ROUTE_BLOB => bytes = scheme_response(scope, host, &url)?.map(|(body, _)| body),
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
    let r = Request { cid, kind: J_FONT, url: url.to_owned(), el: None, doc, plan, client: None, referrer: referrer.map(str::to_owned), integrity: String::new(), preload: None, load: 0, holds: None, initiator: "css", started };
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
        let bytes = answer_obj.and_then(|a| member(scope, a, "bytes")).and_then(|b| view_bytes(scope, b));
        let facts = facts_of(scope, answer_obj, J_FONT, SRC_SW_SYNC);
        let ok = judge(&consumer, SRC_SW_SYNC | bytes.as_deref().map_or(S_EMPTY, empty), &facts) & V_OK != 0;
        file(scope, host, &r, Answered::Worker(answer))?;
        return match bytes.filter(|_| ok) {
            Some(bytes) => file_of_bytes(scope, host, bytes),
            None => Ok(None),
        };
    }
    if crate::fetch_rules::fetch_route(url, 0, "") == crate::fetch_rules::ROUTE_BLOB {
        return match scheme_response(scope, host, url)? {
            Some((bytes, _)) => file_of_bytes(scope, host, bytes),
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
// no `integrity` attribute its import map's), `moduleDestination` a modulepreload's `as` destination:
//   - a style sheet: the one its owner obtains, which the cascade and `.sheet` read too (`link_sheet`, sheet_fetch.rs);
//   - a preload of no plan (its URL none the network answers): run as it is obtained, and committed (`run_preload`);
//   - a modulepreload: a controlling service worker's answer, else the asset cache's that the module loader shares
//     (HTML "fetch a modulepreload module script graph": a CORS request), else — a URL the cache does not take — the
//     network's;
//   - a prefetch: a controlling service worker's `fetch` event's, whose answer the engine takes later and fires the
//     link's event for (`LINK_PENDING`), else the network's;
//   - any other (a manifest's): the network's;
// a `data:` or `blob:` URL carries its own body, judged by its MIME type — a style sheet's `text/css` — one that does not
// parse, or names no blob, a network error (Fetch), the link's load an `error` whatever it obtains;
// its verdict the engine's (`judge`: what the link obtains, its integrity) and its entry filed.
fn link_obtain_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    use crate::link_resource::{OBTAINS_MODULEPRELOAD, OBTAINS_PREFETCH, OBTAINS_PRELOAD, OBTAINS_STYLESHEET};
    rv.set_uint32(LINK_ERROR);
    let kind = args.get(3).uint32_value(scope).unwrap_or(0);
    let obtains = kind >> 8;
    let Ok(host) = v8::Local::<v8::Function>::try_from(args.get(7)) else { return };
    let (Some(el), Some(doc)) = (crate::dom::nid_arg(scope, &args, 0), crate::dom::nid_arg(scope, &args, 1)) else { return };
    let url = args.get(2).to_rust_string_lossy(scope);
    let plan = args.get(4).uint32_value(scope).unwrap_or(0);
    let integrity = args.get(5).to_rust_string_lossy(scope);
    let module_destination = if args.get(6).is_string() { args.get(6).to_rust_string_lossy(scope) } else { String::new() };
    let cid = realm_id(scope, &args);
    let Ok(started) = now(scope, host) else { return };
    let client = realm(scope, cid).get(el).map(|n| n.realm);
    let r = Request { cid, kind, url, el: Some(el), doc: Some(doc), plan, client, referrer: None, integrity, preload: None, load: 0, holds: None, initiator: "link", started };
    let route = crate::fetch_rules::fetch_route(&r.url, 0, "");
    let done = if matches!(route, crate::fetch_rules::ROUTE_DATA | crate::fetch_rules::ROUTE_BLOB) {
        let preload_destination = if obtains & OBTAINS_PRELOAD != 0 { crate::script::preload_destination(&preload_as(scope, el, cid)).unwrap_or("") } else { "" };
        let integrity = if obtains & OBTAINS_STYLESHEET != 0 { crate::sheet_fetch::owner_integrity(realm(scope, cid), el) } else { r.integrity.clone() };
        link_scheme(scope, host, &Request { integrity, ..r }, (&module_destination, preload_destination)).map(link_done)
    } else if obtains & OBTAINS_STYLESHEET != 0 {
        let integrity = crate::sheet_fetch::owner_integrity(realm(scope, cid), el);
        link_sheet(scope, host, &Request { integrity, ..r }).map(link_done)
    } else if obtains & OBTAINS_PRELOAD != 0 {
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
fn link_verdict(scope: &mut v8::PinScope<'_, '_>, r: &Request, facts: &crate::subresource_judge::Facts, source: u32, bytes: Option<v8::Local<'_, v8::Value>>, mode: &str, destinations: (&str, &str)) -> bool {
    let body = match bytes.filter(|_| !r.integrity.is_empty()) {
        Some(b) if b.is_string() => b.to_rust_string_lossy(scope).into_bytes(),
        Some(b) => view_bytes(scope, b).unwrap_or_default(),
        None => Vec::new(),
    };
    link_verdict_of(scope, r, facts, source, &body, mode, destinations)
}
// …its body's bytes `body` (none asked for where the request has no integrity).
fn link_verdict_of(scope: &mut v8::PinScope<'_, '_>, r: &Request, facts: &crate::subresource_judge::Facts, source: u32, body: &[u8], mode: &str, (module_destination, preload_destination): (&str, &str)) -> bool {
    use crate::subresource_judge::{judge, Consumer, V_OK};
    let quirks = realm(scope, r.cid).document_mode(r.doc).0;
    let consumer = Consumer { kind: r.kind & 0xff, obtains: r.kind >> 8, module_destination, preload_destination, integrity: &r.integrity, body, mode, quirks };
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
// its first `href`'s fetched too). A URL the network does not answer (`data:`, `blob:`) is planned none — its task
// obtains it as any link's — and lets the plan before it go.
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
    let network = crate::fetch_rules::fetch_route(&url, 0, "") == crate::fetch_rules::ROUTE_NETWORK;
    if !network {
        if let Some(p) = realm(scope, cid).link_preloads.remove(&el) {
            let id = p.id;
            realm(scope, cid).preload_take_pending(&p.key, |r| r.preload.is_some_and(|(_, i)| i == id));
        }
        return;
    }
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
    let request = Request { cid, kind, url, el: Some(el), doc: Some(doc), plan, client, referrer: None, integrity: integrity.clone(), preload: Some((destination, id)), load: 0, holds: None, initiator: "link", started };
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
            (Some(b), _) => view_bytes(scope, b),
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
    let response = response.filter(|resp| !crate::integrity::integrity_refuses(resp.body(), &r.integrity, resp.opaque()));
    let arena = realm(scope, r.cid);
    if let Some(doc) = r.doc {
        arena.preload_commit(crate::preload_map::Key::new(doc, &r.url, destination, r.plan), r.integrity.clone(), response);
    }
    if let Some(plan) = r.el.and_then(|el| arena.link_preloads.get_mut(&el)).filter(|p| p.id == id && id != 0) {
        plan.got = Some(ok);
    }
    Ok(ok)
}

// …a style sheet's (`linkObtain`): the one its owner obtains — the preload its request takes, the controlling service
// worker's answer, the asset cache's (sheet_fetch.rs, the cascade's and `.sheet`'s readers sharing each), else the
// network's — judged as the link's (`link_verdict`: a style sheet's type), its entry filed but a preload's (the
// preload's alone).
fn link_sheet(scope: &mut v8::PinScope<'_, '_>, host: v8::Local<'_, v8::Function>, r: &Request) -> Result<bool, Terminated> {
    use crate::subresource_judge::{facts_of, SRC_ASSET, SRC_NETWORK, SRC_SW_SYNC, S_NO_BODY};
    let (Some(el), cid) = (r.el, r.cid) else { return Ok(false) };
    let owner = crate::sheet_fetch::Owner { id: el, doc: r.doc };
    if let Some(preloaded) = crate::sheet_fetch::owner_preload(scope, cid, host, owner, &r.url, r.plan)? {
        let Some(resp) = preloaded else { return Ok(false) };
        let body = if r.integrity.is_empty() { Vec::new() } else { resp.body().to_vec() };
        return Ok(link_verdict_of(scope, r, &resp.facts(), SRC_NETWORK, &body, "no-cors", ("", "")));
    }
    if let Some(answer) = crate::sheet_fetch::worker_answer(scope, cid, host, &r.url, r.plan, &r.integrity, None, Some(owner))? {
        let local = v8::Local::new(scope, &answer);
        let obj = v8::Local::<v8::Object>::try_from(local).ok();
        let no_body = if obj.and_then(|a| member(scope, a, "body")).is_none() { S_NO_BODY } else { 0 };
        let bytes = obj.and_then(|a| member(scope, a, "body_bytes").or_else(|| member(scope, a, "body")));
        let facts = facts_of(scope, obj, r.kind & 0xff, SRC_SW_SYNC);
        let ok = link_verdict(scope, r, &facts, SRC_SW_SYNC | no_body, bytes, "no-cors", ("", ""));
        file(scope, host, r, Answered::Worker(answer))?;
        return Ok(ok);
    }
    if crate::fetch_rules::fetch_route(&r.url, 0, "") != crate::fetch_rules::ROUTE_NETWORK {
        return link_from_network(scope, host, r, "");
    }
    let Some(response) = crate::sheet_fetch::asset(scope, cid, host, &r.url, r.plan, Some(owner), None)? else {
        file(scope, host, r, Answered::Network(None))?;
        return Ok(false);
    };
    let local = v8::Local::new(scope, &response);
    let array = v8::Local::<v8::Array>::try_from(local).ok();
    let mut at = [None; 3];
    if let Some(g) = array {
        for (k, slot) in at.iter_mut().enumerate() {
            *slot = g.get_index(scope, k as u32).filter(|v| !v.is_null_or_undefined());
        }
    }
    let [body, meta, bytes] = at;
    let meta = meta.and_then(|m| v8::Local::<v8::Object>::try_from(m).ok());
    let facts = facts_of(scope, meta, r.kind & 0xff, SRC_ASSET);
    let no_body = if body.is_none() { S_NO_BODY } else { 0 };
    let ok = link_verdict(scope, r, &facts, SRC_ASSET | no_body, bytes.or(body), "no-cors", ("", ""));
    file(scope, host, r, Answered::Network(meta.map(|m| v8::Global::new(scope, v8::Local::<v8::Value>::from(m)))))?;
    Ok(ok)
}

// …a `data:` or a `blob:` URL's: its body, as its MIME type makes it what the link obtains (`link_verdict`) — no entry,
// as no network scheme files one.
fn link_scheme(scope: &mut v8::PinScope<'_, '_>, host: v8::Local<'_, v8::Function>, r: &Request, destinations: (&str, &str)) -> Result<bool, Terminated> {
    let Some((body, content_type)) = scheme_response(scope, host, &r.url)? else { return Ok(false) };
    let stylesheet = (r.kind >> 8) & crate::link_resource::OBTAINS_STYLESHEET != 0;
    if stylesheet && crate::fetch_rules::fetch_route(&r.url, 0, "") == crate::fetch_rules::ROUTE_DATA && crate::mime::parse(&content_type).is_none_or(|m| m.essence != "text/css") {
        return Ok(false);
    }
    let body = if r.integrity.is_empty() { Vec::new() } else { body };
    Ok(link_verdict_of(scope, r, &scheme_facts(content_type), crate::subresource_judge::SRC_SCHEME, &body, "no-cors", destinations))
}

// __dom.fetchClassicScript(el, doc, src, parser, host) -> `[ok, body, entry]`: HTML "fetch a classic script" for the
// script element `el` (of document `doc`) whose src is `src` (resolved; null where it does not resolve, the raw
// attribute its URL then): whether its response is one to run (`judge`: none for a network error, a status not ok, a
// refused response, a body its `integrity` does not match), its source text — decoded as its Content-Type's charset or
// else the document's says (script.rs `classic_script_encoding`), the host's own text where that is its UTF-8 — and the
// description of its Resource Timing entry for the bindings to file once the load completes, null where it files none
// (a scheme URL's, an element's second). A `data:` or `blob:` URL's is its scheme's; else the preload its request takes
// (no entry of its own), else a controlling service worker's answer, else — `parser` the parser's — the cross-visit
// asset cache's, or the network's. Its errors are muted where its response is of another origin (the report of an
// exception thrown in it reads its URL's).
fn fetch_classic_script_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Ok(host) = v8::Local::<v8::Function>::try_from(args.get(4)) else { return };
    let (Some(el), Some(doc)) = (crate::dom::nid_arg(scope, &args, 0), crate::dom::nid_arg(scope, &args, 1)) else { return };
    let src = args.get(2).is_string().then(|| args.get(2).to_rust_string_lossy(scope));
    let parser = args.get(3).is_true();
    let cid = realm_id(scope, &args);
    let Ok((ok, body, entry)) = classic_script(scope, cid, host, el, doc, src, parser) else { return };
    let body = match body {
        ScriptText::Host(host_text) => v8::Local::new(scope, host_text),
        ScriptText::Decoded(decoded) => text(scope, &decoded),
    };
    let entry = match entry {
        Some(e) => v8::Local::new(scope, e),
        None => v8::null(scope).into(),
    };
    let items = [v8::Boolean::new(scope, ok).into(), body, entry];
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}

// A classic script's source text: the host's own (its response read as UTF-8, which it is), or decoded.
enum ScriptText {
    Host(v8::Global<v8::Value>),
    Decoded(String),
}

// What a `data:` or a `blob:` URL's scheme fetch makes (Fetch "scheme fetch"): its body and its Content-Type — a data:
// URL's MIME type, a blob's type as it was given — None for a network error (no comma, a body that is no base64, a
// blob: URL that names none).
pub(crate) fn scheme_response(scope: &mut v8::PinScope<'_, '_>, host: v8::Local<'_, v8::Function>, url: &str) -> Result<Option<(Vec<u8>, String)>, Terminated> {
    if crate::fetch_rules::fetch_route(url, 0, "") == crate::fetch_rules::ROUTE_DATA {
        return Ok(crate::data_url::process(url).map(|(mime, body)| (body, mime)));
    }
    let u = text(scope, url);
    let blob = call(scope, host, H_BLOB, &[u])?.map(|b| v8::Local::new(scope, b));
    let blob = blob.and_then(|b| v8::Local::<v8::Object>::try_from(b).ok());
    let Some(bytes) = blob.and_then(|b| member(scope, b, "bytes")).and_then(|b| view_bytes(scope, b)) else { return Ok(None) };
    let content_type = blob.and_then(|b| member(scope, b, "type")).map_or_else(String::new, |t| t.to_rust_string_lossy(scope));
    Ok(Some((bytes, content_type)))
}
// …and the facts its verdict is made of: a basic 200 response of that Content-Type.
pub(crate) fn scheme_facts(content_type: String) -> crate::subresource_judge::Facts {
    crate::subresource_judge::Facts { response_type: "basic".to_owned(), status: Some(200), content_type, ..Default::default() }
}

#[allow(clippy::type_complexity)]
fn classic_script(scope: &mut v8::PinScope<'_, '_>, cid: i32, host: v8::Local<'_, v8::Function>, el: NodeId, doc: NodeId, src: Option<String>, parser: bool) -> Result<(bool, ScriptText, Option<v8::Global<v8::Value>>), Terminated> {
    use crate::fetch_rules::{fetch_route, ROUTE_BLOB, ROUTE_DATA};
    use crate::subresource_judge::{facts_of, judge, Consumer, Facts, J_CLASSIC_SCRIPT, SRC_ASSET, SRC_NETWORK, SRC_SCHEME, SRC_SW_SYNC, S_NO_BODY, V_CROSS_ORIGIN, V_OK};
    let none = || ScriptText::Decoded(String::new());
    let integrity = realm(scope, cid).get(el).and_then(|n| n.plain_attr("integrity")).unwrap_or("").to_owned();
    let charset = call(scope, host, H_CHARSET, &[])?;
    let charset = text_of(scope, charset).unwrap_or_default();
    // (…`bytes` its body's, asked for where it has integrity metadata alone)
    let verdict = |scope: &mut v8::PinScope<'_, '_>, facts: &Facts, source: u32, bytes: &dyn Fn(&mut v8::PinScope<'_, '_>) -> Vec<u8>| {
        let bytes = if integrity.is_empty() { Vec::new() } else { bytes(scope) };
        let quirks = realm(scope, cid).document_mode(Some(doc)).0;
        let consumer = Consumer { kind: J_CLASSIC_SCRIPT, obtains: 0, module_destination: "", preload_destination: "", integrity: &integrity, body: &bytes, mode: "no-cors", quirks };
        judge(&consumer, source, facts)
    };
    let decode = |bytes: &[u8], content_type: &str| {
        let encoding = crate::script::classic_script_encoding(content_type, &charset);
        let e = encoding_rs::Encoding::for_label(encoding.as_bytes()).unwrap_or(encoding_rs::UTF_8);
        e.decode(bytes).0.into_owned()
    };
    // (…a scheme URL's: its response scheme fetch makes, none where that is a network error, or refused)
    if let Some(url) = src.as_deref().filter(|u| matches!(fetch_route(u, 0, ""), ROUTE_DATA | ROUTE_BLOB)) {
        let Some((bytes, content_type)) = scheme_response(scope, host, url)? else { return Ok((false, none(), None)) };
        let facts = scheme_facts(content_type.clone());
        if verdict(scope, &facts, SRC_SCHEME, &|_| bytes.clone()) & V_OK == 0 {
            return Ok((false, none(), None));
        }
        return Ok((true, ScriptText::Decoded(decode(&bytes, &content_type)), None));
    }
    let url = match src {
        Some(u) => u,
        None => realm(scope, cid).get(el).and_then(|n| n.plain_attr("src")).unwrap_or("").to_owned(),
    };
    let started = now(scope, host)?;
    let arena = realm(scope, cid);
    let plan = plan_in(arena, J_CLASSIC_SCRIPT, Some(el), Some(doc), None);
    let client = arena.get(el).map(|n| n.realm);
    let r = Request { cid, kind: J_CLASSIC_SCRIPT, url, el: Some(el), doc: Some(doc), plan, client, referrer: None, integrity: integrity.clone(), preload: None, load: 0, holds: None, initiator: "script", started };
    // What answered: its verdict, its Content-Type, its entry's facts, and its body — served bytes (a preload's, a
    // worker's), else the host's text with the bytes it kept where they are not its text's UTF-8.
    let (v, content_type, answered, served, raw, host_text): (u32, String, Option<Answered>, bool, Option<Vec<u8>>, Option<v8::Global<v8::Value>>);
    if let Some(preloaded) = crate::preload_map::consume(scope, cid, (doc, &r.url, "script", plan), &integrity, host)? {
        answered = None;
        host_text = None;
        match preloaded {
            Some(resp) => {
                v = verdict(scope, &resp.facts(), SRC_NETWORK, &|_| resp.body().to_vec());
                content_type = resp.header("content-type").unwrap_or("").to_owned();
                (served, raw) = (true, Some(resp.into_body()));
            }
            None => (v, content_type, served, raw) = (0, String::new(), false, None),
        }
    } else {
        let mut sw_args = request_args(scope, &r).to_vec();
        let (binary, integrity_value) = (v8::Boolean::new(scope, true).into(), text(scope, &integrity));
        sw_args.extend([binary, integrity_value]);
        let sw = call(scope, host, H_SW_ANSWER, &sw_args)?;
        let sw_obj = sw.as_ref().map(|g| v8::Local::new(scope, g)).and_then(|l| v8::Local::<v8::Object>::try_from(l).ok());
        let blocked = sw_obj.and_then(|o| member(scope, o, "blocked")).is_some_and(|b| b.is_true());
        let sw_bytes = sw_obj.and_then(|o| member(scope, o, "bytes")).and_then(|b| view_bytes(scope, b));
        if let (Some(answer), true) = (sw.clone(), blocked) {
            // (…an answer that is no ok one is still a response, whose status its entry reports; a network error has none)
            (v, content_type, served, raw, host_text) = (0, String::new(), false, None, None);
            answered = Some(Answered::Worker(answer));
        } else if let (Some(answer), Some(bytes)) = (sw, sw_bytes) {
            let facts = facts_of(scope, sw_obj, J_CLASSIC_SCRIPT, SRC_SW_SYNC);
            v = verdict(scope, &facts, SRC_SW_SYNC, &|_| bytes.clone());
            content_type = header_of(scope, sw_obj, "content-type");
            (served, raw, host_text) = (true, Some(bytes), None);
            answered = Some(Answered::Worker(answer));
        } else {
            // (…the parser's from the cross-visit asset cache — `[text, facts, bytes]`, its entry sized by its text where
            // the cache kept no facts — an inserted one's from the network)
            let args = request_args(scope, &r);
            let (body, meta, kept, source) = if parser {
                let got = call(scope, host, H_ASSET, &args)?.map(|g| v8::Local::new(scope, g));
                let got = got.and_then(|g| v8::Local::<v8::Array>::try_from(g).ok());
                let mut at = [None; 3];
                if let Some(g) = got {
                    for (k, slot) in at.iter_mut().enumerate() {
                        *slot = g.get_index(scope, k as u32).filter(|v| !v.is_null_or_undefined());
                    }
                }
                let [body, meta, kept] = at;
                (body, meta.and_then(|m| v8::Local::<v8::Object>::try_from(m).ok()), kept, SRC_ASSET)
            } else {
                let resp = call(scope, host, H_FETCH, &args)?.map(|g| v8::Local::new(scope, g));
                let resp = resp.and_then(|g| v8::Local::<v8::Object>::try_from(g).ok());
                let body = resp.map(|o| member(scope, o, "body").unwrap_or_else(|| text(scope, "")));
                let kept = resp.and_then(|o| member(scope, o, "body_bytes"));
                (body, resp, kept, SRC_NETWORK)
            };
            let facts = facts_of(scope, meta, J_CLASSIC_SCRIPT, source);
            let no_body = if body.is_none() { S_NO_BODY } else { 0 };
            let kept = kept.and_then(|b| view_bytes(scope, b));
            v = verdict(scope, &facts, source | no_body, &|scope| kept.clone().unwrap_or_else(|| body.map_or_else(Vec::new, |b| b.to_rust_string_lossy(scope).into_bytes())));
            content_type = header_of(scope, meta, "content-type");
            answered = Some(match (source, meta) {
                (SRC_ASSET, None) => Answered::Text(body.map(|b| b.to_rust_string_lossy(scope))),
                (_, meta) => Answered::Network(meta.map(|m| v8::Global::new(scope, v8::Local::<v8::Value>::from(m)))),
            });
            (served, raw, host_text) = (false, kept, body.map(|b| v8::Global::new(scope, b)));
        }
    }
    let ok = v & V_OK != 0;
    let body = if !ok {
        none()
    } else {
        // (…served bytes decoded, and the host's text where its UTF-8 is not their encoding)
        let utf8 = crate::script::classic_script_encoding(&content_type, &charset) == "UTF-8";
        match (served || !utf8, raw, host_text) {
            (false, _, Some(text)) => ScriptText::Host(text),
            (_, Some(bytes), _) => ScriptText::Decoded(decode(&bytes, &content_type)),
            (_, None, Some(text)) => {
                let text = v8::Local::new(scope, text).to_rust_string_lossy(scope);
                ScriptText::Decoded(decode(text.as_bytes(), &content_type))
            }
            (_, None, None) => none(),
        }
    };
    if ok {
        crate::script::note_muted(realm(scope, cid), &r.url, v & V_CROSS_ORIGIN != 0);
    }
    // (Once per element: a script appended while the parser is still running is fetched by both.)
    let Some(answered) = answered else { return Ok((ok, body, None)) };
    let arena = realm(scope, cid);
    if arena.get(el).is_none_or(|n| n.element_flags & crate::element_flags::SCRIPT_TIMING_FILED != 0) {
        return Ok((ok, body, None));
    }
    if let Some(n) = arena.get_mut_quietly(el) {
        n.element_flags |= crate::element_flags::SCRIPT_TIMING_FILED;
    }
    Ok((ok, body, Some(entry_desc(scope, &r, answered))))
}
// …a response object's header `name`, '' for none.
fn header_of(scope: &mut v8::PinScope<'_, '_>, obj: Option<v8::Local<'_, v8::Object>>, name: &str) -> String {
    let headers = obj.and_then(|o| member(scope, o, "headers")).and_then(|h| v8::Local::<v8::Object>::try_from(h).ok());
    headers.and_then(|h| crate::fetch_rules::response_header(scope, h, name)).unwrap_or_default()
}

// What an image's fetch came to (`imageObtain`): its response applied — its `load` (or `error`) to fire — or pending: a
// controlling service worker's, a host thread's or a `blob:` URL's store's to answer, the engine's then to apply and
// fire — or a later load's (constants.js `IMAGE_FETCH_*`).
const IMAGE_FETCH_LOADED: u32 = 1;
const IMAGE_FETCH_BROKEN: u32 = 2;
const IMAGE_FETCH_PENDING: u32 = 3;

// __dom.imageObtain(img, doc, url, load, host) -> what load `load` of the image element `img` (of document `doc`) takes
// of `url` first (`IMAGE_FETCH_*`): the preload of it (Fetch "fetch": "consume a preloaded resource", no worker, no network and
// no entry of its own) — its response judged (`judge`, J_IMAGE by its request's mode: an opaque one a cors request may
// not use) and decoded here — else a controlling service worker's `fetch` event (destination `image`), the request
// pending until it answers; else the network's (`image_from_network`).
fn image_obtain_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    use crate::subresource_judge::{judge, Consumer, J_IMAGE, SRC_NETWORK, V_CROSS_ORIGIN, V_OK};
    rv.set_uint32(IMAGE_FETCH_PENDING);
    let Ok(host) = v8::Local::<v8::Function>::try_from(args.get(4)) else { return };
    let (Some(el), Some(doc)) = (crate::dom::nid_arg(scope, &args, 0), crate::dom::nid_arg(scope, &args, 1)) else { return };
    let url = args.get(2).to_rust_string_lossy(scope);
    let load = args.get(3).uint32_value(scope).unwrap_or(0);
    let cid = realm_id(scope, &args);
    let arena = realm(scope, cid);
    let plan = plan_in(arena, J_IMAGE, Some(el), Some(doc), None);
    let client = arena.get(el).map(|n| n.realm);
    let Ok(preloaded) = crate::preload_map::consume(scope, cid, (doc, &url, "image", plan), "", host) else { return };
    if let Some(resp) = preloaded {
        let consumer = Consumer { kind: J_IMAGE, obtains: 0, module_destination: "", preload_destination: "", integrity: "", body: b"", mode: fields(plan).0, quirks: false };
        let verdict = resp.as_ref().map_or(0, |r| judge(&consumer, SRC_NETWORK, &r.facts()));
        let decoded = resp.filter(|_| verdict & V_OK != 0).and_then(|r| decode_image(r.body()));
        let broken = decoded.is_none();
        crate::image_requests::apply_decoded(scope, el, load, decoded, verdict & V_CROSS_ORIGIN != 0);
        return rv.set_uint32(if broken { IMAGE_FETCH_BROKEN } else { IMAGE_FETCH_LOADED });
    }
    let Ok(ctrl) = call(scope, host, H_CONTROLLER, &[]) else { return };
    let ctrl = ctrl.and_then(|c| v8::Local::new(scope, c).uint32_value(scope)).unwrap_or(0);
    if ctrl == 0 || crate::fetch_rules::fetch_route(&url, crate::fetch_rules::FETCH_CONTROLLED, "") != crate::fetch_rules::ROUTE_SERVICE_WORKER {
        if let Ok(done) = image_from_network(scope, host, cid, el, &url, load, plan) {
            rv.set_uint32(done);
        }
        return;
    }
    let Ok(started) = now(scope, host) else { return };
    let r = Request { cid, kind: J_IMAGE, url, el: Some(el), doc: Some(doc), plan, client, referrer: None, integrity: String::new(), preload: None, load, holds: None, initiator: "img", started };
    // (…the request pending: the image data discarded until the worker answers — an observable window, as a browser's)
    let arena = realm(scope, cid);
    arena.set_image_pending(el);
    match dispatch(scope, host, r) {
        Ok(None) => rv.set_uint32(IMAGE_FETCH_PENDING),
        // (…none answered at once: the network's)
        Ok(Some(r)) => {
            if let Ok(done) = image_from_network(scope, host, cid, el, &r.url, load, plan) {
                rv.set_uint32(done);
            }
        }
        Err(_) => rv.set_uint32(IMAGE_FETCH_PENDING),
    }
}
// The network's answer to the `<img>` `el`'s load `load` of `url`, its request `plan`'s — what it comes to: pending, an
// http(s) one fetched and decoded on a host thread and applied as the result is delivered (`imageFetchTake`) — a real
// browser never blocks the parser on an image, and an in-process request behind an ActiveStorage URL overlaps script
// instead of serializing with the parse — the request pending until then: `complete` false, its image data DISCARDED
// (a reload draws nothing until the new data arrives); a `blob:` one its blob, read from this VM's blob URL store (the
// host has none of its bytes) as "update the image data" parses the URL, after a stable state — one revoked in the same
// task is gone (Chrome: `error`), its request pending until then (`imageBlobLoad`); else — a data: one (host-local
// decode, no fetch), a host thread that would not start — fetched and decoded at once, its entry filed (sized by the
// encoded bytes the host decoded; a broken load a network error), applied (`imageApply`), and loaded or broken — or
// pending, a later load having superseded it.
fn image_from_network(scope: &mut v8::PinScope<'_, '_>, host: v8::Local<'_, v8::Function>, cid: i32, el: NodeId, url: &str, load: u32, plan: u32) -> Result<u32, Terminated> {
    use crate::fetch_rules::{fetch_route, ROUTE_BLOB, ROUTE_NETWORK};
    let route = fetch_route(url, 0, "");
    fn request<'s>(scope: &mut v8::PinScope<'s, '_>, url: &str, plan: u32, cid: i32) -> [v8::Local<'s, v8::Value>; 3] {
        [text(scope, url), v8::Integer::new_from_unsigned(scope, plan).into(), v8::Integer::new(scope, cid).into()]
    }
    if route == ROUTE_NETWORK {
        let args = request(scope, url, plan, cid);
        let id = call(scope, host, H_IMAGE_START, &args)?.and_then(|id| v8::Local::new(scope, id).uint32_value(scope)).unwrap_or(0);
        if id > 0 {
            realm(scope, cid).set_image_pending(el);
            let started = now(scope, host)?;
            crate::image_requests::begin_host_fetch(scope, cid, id, el, load, url, started);
            return Ok(IMAGE_FETCH_PENDING);
        }
    }
    if route == ROUTE_BLOB {
        realm(scope, cid).set_image_pending(el);
        let (nid, n, u) = (v8::Number::new(scope, el.to_f64()).into(), v8::Integer::new_from_unsigned(scope, load).into(), text(scope, url));
        call(scope, host, H_IMAGE_BLOB, &[nid, n, u])?;
        return Ok(IMAGE_FETCH_PENDING);
    }
    let started = now(scope, host)?;
    let args = request(scope, url, plan, cid);
    let result = call(scope, host, H_LOAD_IMAGE, &args)?.map(|r| v8::Local::new(scope, r));
    let result = result.and_then(|r| v8::Local::<v8::Object>::try_from(r).ok());
    file_image(scope, host, el, url, started, result)?;
    Ok(match crate::image_requests::apply_record(scope, el, load, result) {
        crate::image_requests::APPLIED_LOAD => IMAGE_FETCH_LOADED,
        crate::image_requests::APPLIED_ERROR => IMAGE_FETCH_BROKEN,
        _ => IMAGE_FETCH_PENDING,
    })
}
// …and its entry filed (performance.js `recordResourceTiming`): its initiator, its no-cors-ness and whether it is filed
// at all the engine's (resource_timing.rs, J_IMAGE); the response's facts the host kept — its Server-Timing, its content
// encoding, whether its cache served it — else, a response it kept none of, its size alone; a broken load a network
// error, a response that arrived but decoded to no image one that did arrive.
fn file_image(scope: &mut v8::PinScope<'_, '_>, host: v8::Local<'_, v8::Function>, el: NodeId, url: &str, started: f64, result: Option<v8::Local<'_, v8::Object>>) -> Result<(), Terminated> {
    let flag = |scope: &mut v8::PinScope<'_, '_>, k: &str| result.and_then(|r| member(scope, r, k)).is_some_and(|v| v.boolean_value(scope));
    let fetched = result.is_some() && !flag(scope, "unsupported");
    let entry = v8::Object::new(scope);
    let set = |scope: &mut v8::PinScope<'_, '_>, k: &str, v: v8::Local<'_, v8::Value>| {
        let k = text(scope, k);
        entry.set(scope, k, v);
    };
    let (name, kind) = (text(scope, url), v8::Integer::new_from_unsigned(scope, crate::subresource_judge::J_IMAGE).into());
    set(scope, "name", name);
    set(scope, "kind", kind);
    let nid = v8::Number::new(scope, el.to_f64()).into();
    set(scope, "nid", nid);
    let broken = fetched && flag(scope, "broken");
    let broken = v8::Boolean::new(scope, broken).into();
    set(scope, "broken", broken);
    let start = v8::Number::new(scope, started).into();
    set(scope, "startTime", start);
    if let Some(result) = result.filter(|_| fetched) {
        match member(scope, result, "meta") {
            Some(meta) => set(scope, "resp", meta),
            None => {
                let encoded = member(scope, result, "encoded").and_then(|e| e.int32_value(scope)).unwrap_or(0);
                let encoded = v8::Integer::new(scope, encoded).into();
                set(scope, "encoded", encoded);
                set(scope, "decoded", encoded);
                let ok = v8::Integer::new(scope, 200).into();
                set(scope, "status", ok);
            }
        }
    }
    call(scope, host, H_FILE, &[entry.into()]).map(drop)
}
// __dom.imageArrive(img, load, src, start, r, host) -> `imageApply`'s answer for what the host thread fetched and decoded
// for the `<img>`'s load `load` of `src`, begun at `start` (image_requests.rs `imageFetchTake`) — its entry filed and its
// record applied — none where a later load superseded it, which files nothing either.
fn image_arrive_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    rv.set_uint32(crate::image_requests::APPLIED_NONE);
    let Ok(host) = v8::Local::<v8::Function>::try_from(args.get(5)) else { return };
    let Some(el) = crate::node_handle::nid_of(scope, args.get(0)) else { return };
    let load = args.get(1).uint32_value(scope).unwrap_or(0);
    if crate::dom::dom(scope).arena.image_load_of(el) != load {
        return;
    }
    let src = args.get(2).to_rust_string_lossy(scope);
    let started = args.get(3).number_value(scope).unwrap_or(0.0);
    let result = v8::Local::<v8::Object>::try_from(args.get(4)).ok();
    if file_image(scope, host, el, &src, started, result).is_ok() {
        rv.set_uint32(crate::image_requests::apply_record(scope, el, load, result));
    }
}
// __dom.imageBlobLoad(img, load, url, host) — the `<img>`'s load `load` of the `blob:` URL `url` (`image_from_network`)
// takes the blob's bytes now — none for a URL revoked or unknown, a network error — decoded and applied, its `load` or
// `error` fired; nothing where a later load superseded it.
fn image_blob_load_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Ok(host) = v8::Local::<v8::Function>::try_from(args.get(3)) else { return };
    let Some(el) = crate::node_handle::nid_of(scope, args.get(0)) else { return };
    let load = args.get(1).uint32_value(scope).unwrap_or(0);
    if crate::dom::dom(scope).arena.image_load_of(el) != load {
        return;
    }
    let Ok(blob) = call(scope, host, H_BLOB, &[args.get(2)]) else { return };
    let blob = blob.map(|b| v8::Local::new(scope, b)).and_then(|b| v8::Local::<v8::Object>::try_from(b).ok());
    let bytes = blob.and_then(|b| member(scope, b, "bytes")).and_then(|b| view_bytes(scope, b));
    let decoded = bytes.as_deref().and_then(decode_image);
    let broken = decoded.is_none();
    if !crate::image_requests::apply_decoded(scope, el, load, decoded, false) {
        return;
    }
    let (nid, ok, n) = (v8::Number::new(scope, el.to_f64()).into(), v8::Boolean::new(scope, !broken).into(), v8::Integer::new_from_unsigned(scope, load).into());
    let _ = call(scope, host, H_IMAGE_EVENT, &[nid, ok, n]);
}

// …an image's bytes decoded (image_decode.rs `decode`): none where they are no image, or none at all.
fn decode_image(bytes: &[u8]) -> Option<crate::image_decode::Bitmap> {
    if bytes.is_empty() {
        return None;
    }
    match std::panic::catch_unwind(|| crate::image_decode::decode(bytes, None)) {
        Ok(crate::image_decode::Decoded::Bitmap(b)) => Some(b),
        _ => None,
    }
}

// A controlled image's answer (`obtainResume`), for a load no later one superseded: none — the request let through —
// the network's (`image_from_network`); else judged as the request's mode makes it, its entry the answer's (a network error's
// one of its times), its body decoded — an opaque one's `render` — and applied, its element's `load` or `error` fired.
fn image_answered(scope: &mut v8::PinScope<'_, '_>, host: v8::Local<'_, v8::Function>, r: &Request, answer: Option<v8::Local<'_, v8::Object>>, redirected: bool, render: Option<Vec<u8>>) -> Result<(), Terminated> {
    use crate::subresource_judge::{facts_of, judge, Consumer, J_IMAGE, SRC_SW_EVENT, V_CROSS_ORIGIN, V_OK};
    let Some(el) = r.el else { return Ok(()) };
    if realm(scope, r.cid).image_load_of(el) != r.load {
        return Ok(());
    }
    let nid = v8::Number::new(scope, el.to_f64()).into();
    let load = v8::Integer::new_from_unsigned(scope, r.load).into();
    let Some(answer) = answer else {
        let done = image_from_network(scope, host, r.cid, el, &r.url, r.load, r.plan)?;
        if done == IMAGE_FETCH_PENDING {
            return Ok(());
        }
        let ok = v8::Boolean::new(scope, done == IMAGE_FETCH_LOADED).into();
        return call(scope, host, H_IMAGE_EVENT, &[nid, ok, load]).map(drop);
    };
    let mut facts = facts_of(scope, Some(answer), J_IMAGE, SRC_SW_EVENT);
    facts.redirected = redirected;
    let consumer = Consumer { kind: J_IMAGE, obtains: 0, module_destination: "", preload_destination: "", integrity: "", body: b"", mode: fields(r.plan).0, quirks: false };
    let verdict = judge(&consumer, SRC_SW_EVENT, &facts);
    let bytes = if verdict & V_OK != 0 { render.filter(|b| !b.is_empty()).or_else(|| member(scope, answer, "bytes").and_then(|b| view_bytes(scope, b))) } else { None };
    let answered = if bytes.is_some() {
        answer
    } else {
        let refused = v8::Object::new(scope);
        let (k, yes) = (text(scope, "blocked"), v8::Boolean::new(scope, true).into());
        refused.set(scope, k, yes);
        refused
    };
    file(scope, host, r, Answered::Worker(v8::Global::new(scope, v8::Local::<v8::Value>::from(answered))))?;
    let decoded = bytes.as_deref().and_then(decode_image);
    let broken = decoded.is_none();
    if !crate::image_requests::apply_decoded(scope, el, r.load, decoded, verdict & V_CROSS_ORIGIN != 0) {
        return Ok(());
    }
    let ok = v8::Boolean::new(scope, !broken).into();
    call(scope, host, H_IMAGE_EVENT, &[nid, ok, load]).map(drop)
}

// __dom.mediaFetchResource(media, doc, url, load, host) -> what fetching the selected resource `url` of the media element
// `media` (of document `doc`) under its load `load` came to: the events its resource owes (media.rs `resource_loaded`),
// false for a failure (the bindings' to go on from: the next candidate, the element's error), true where a controlling
// service worker's `fetch` event is to answer it — the engine's then (`obtainResume`), handing the outcome back
// (`H_MEDIA_DONE`).
//   - a video's: a controlling service worker's answer (destination `video`), whose empty body is a failed decode, never
//     the network's; else the network's (the host's, as an image's: its CORS verdict and taint); else a scheme's; its
//     first frame decoded (video.rs `decode`);
//   - an audio's, fetched but not decoded: a controlling service worker's `fetch` event (the fetch IS the observable),
//     else the network's, else a scheme's — its verdict (`judge`: one Fetch allows its mode, no HTTP 4xx / 5xx, and one
//     with no media data at all errs too) its readiness, to `canplaythrough`;
// its entry the answer's or the response's.
fn media_fetch_resource_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    rv.set_bool(false);
    let Ok(host) = v8::Local::<v8::Function>::try_from(args.get(4)) else { return };
    let (Some(el), Some(doc)) = (crate::dom::nid_arg(scope, &args, 0), crate::dom::nid_arg(scope, &args, 1)) else { return };
    let url = args.get(2).to_rust_string_lossy(scope);
    let load = args.get(3).uint32_value(scope).unwrap_or(0);
    let cid = realm_id(scope, &args);
    let video = realm(scope, cid).get(el).is_some_and(|n| n.is_html_named("video"));
    let kind = if video { crate::subresource_judge::J_VIDEO } else { crate::subresource_judge::J_AUDIO };
    let Ok(started) = now(scope, host) else { return };
    let plan = plan_in(realm(scope, cid), kind, Some(el), Some(doc), None);
    let r = Request { cid, kind, url, el: Some(el), doc: Some(doc), plan, client: None, referrer: None, integrity: String::new(), preload: None, load, holds: None, initiator: if video { "video" } else { "audio" }, started };
    let done = if video { fetch_video(scope, host, &r).map(MediaFetched::Done) } else { fetch_audio(scope, host, r) };
    match done {
        Ok(MediaFetched::Done(Some(events))) => rv.set(crate::media::events_value(scope, &events)),
        Ok(MediaFetched::Pending) => rv.set_bool(true),
        Ok(MediaFetched::Done(None)) | Err(_) => {}
    }
}

// What fetching a media element's resource came to: its events, or a failure (None) — or a worker's to answer.
enum MediaFetched {
    Done(Option<Vec<&'static str>>),
    Pending,
}

fn fetch_video(scope: &mut v8::PinScope<'_, '_>, host: v8::Local<'_, v8::Function>, r: &Request) -> Result<Option<Vec<&'static str>>, Terminated> {
    use crate::subresource_judge::{facts_of, judge, Consumer, J_VIDEO, SRC_SW_SYNC, S_EMPTY, V_CROSS_ORIGIN, V_OK};
    let Some(el) = r.el else { return Ok(None) };
    let mut args = request_args(scope, r).to_vec();
    let (binary, integrity) = (v8::Boolean::new(scope, true).into(), text(scope, ""));
    args.extend([binary, integrity]);
    let (bytes, tainted) = if let Some(answer) = call(scope, host, H_SW_ANSWER, &args)? {
        let local = v8::Local::new(scope, &answer);
        let obj = v8::Local::<v8::Object>::try_from(local).ok();
        file(scope, host, r, Answered::Worker(answer))?;
        // (…an intercepted response with an empty body a failed decode — never the network's for bytes the worker
        // answered — as a refused one is)
        let bytes = obj.and_then(|o| member(scope, o, "bytes")).and_then(|b| view_bytes(scope, b));
        let empty = bytes.as_ref().is_none_or(Vec::is_empty);
        let facts = facts_of(scope, obj, J_VIDEO, SRC_SW_SYNC);
        let consumer = Consumer { kind: J_VIDEO, obtains: 0, module_destination: "", preload_destination: "", integrity: "", body: b"", mode: fields(r.plan).0, quirks: false };
        let verdict = judge(&consumer, SRC_SW_SYNC | if empty { S_EMPTY } else { 0 }, &facts);
        if verdict & V_OK == 0 {
            return Ok(None);
        }
        (bytes, verdict & V_CROSS_ORIGIN != 0)
    } else if crate::fetch_rules::fetch_route(&r.url, 0, "") == crate::fetch_rules::ROUTE_NETWORK {
        // (…the network's, with the CORS verdict and taint the host's image loader makes: `{bytes, tainted, meta}`, none
        // for a failed load)
        let args = request_args(scope, r);
        let got = call(scope, host, H_VIDEO_BYTES, &args)?.map(|g| v8::Local::new(scope, g));
        let got = got.and_then(|g| v8::Local::<v8::Object>::try_from(g).ok());
        let meta = got.and_then(|g| member(scope, g, "meta")).map(|m| v8::Global::new(scope, m));
        file(scope, host, r, Answered::Network(meta))?;
        let bytes = got.and_then(|g| member(scope, g, "bytes")).and_then(|b| view_bytes(scope, b));
        (bytes, got.and_then(|g| member(scope, g, "tainted")).is_some_and(|t| t.is_true()))
    } else {
        // (…a scheme's, which never taints)
        (scheme_response(scope, host, &r.url)?.map(|(body, _)| body), false)
    };
    let Some(bytes) = bytes.filter(|b| !b.is_empty()) else { return Ok(None) };
    let Some(video) = std::panic::catch_unwind(|| crate::video::decode(&bytes)).ok().flatten() else { return Ok(None) };
    let frame = crate::dom::u8_clamped_array(scope, video.rgba);
    let frame = crate::image_requests::Pixels::of(scope, frame);
    let resource = crate::media::MediaResource::Video { width: f64::from(video.width), height: f64::from(video.height), duration: video.duration, tainted, frame };
    Ok(Some(crate::media::resource_loaded(scope, el, resource)))
}

fn fetch_audio(scope: &mut v8::PinScope<'_, '_>, host: v8::Local<'_, v8::Function>, r: Request) -> Result<MediaFetched, Terminated> {
    let ctrl = call(scope, host, H_CONTROLLER, &[])?.and_then(|c| v8::Local::new(scope, c).uint32_value(scope)).unwrap_or(0);
    let r = if ctrl != 0 && crate::fetch_rules::fetch_route(&r.url, crate::fetch_rules::FETCH_CONTROLLED, "") == crate::fetch_rules::ROUTE_SERVICE_WORKER {
        match dispatch(scope, host, r)? {
            None => return Ok(MediaFetched::Pending),
            Some(r) => r,
        }
    } else {
        r
    };
    audio_from_network(scope, host, &r).map(MediaFetched::Done)
}
// …from the network (or a scheme): its readiness, or a failure.
fn audio_from_network(scope: &mut v8::PinScope<'_, '_>, host: v8::Local<'_, v8::Function>, r: &Request) -> Result<Option<Vec<&'static str>>, Terminated> {
    use crate::fetch_rules::{fetch_route, ROUTE_BLOB, ROUTE_DATA, ROUTE_NETWORK};
    use crate::subresource_judge::{facts_of, Facts, SRC_NETWORK, SRC_SCHEME};
    let blocked = || Facts { network_error: true, ..Default::default() };
    match fetch_route(&r.url, 0, "") {
        ROUTE_DATA | ROUTE_BLOB => {
            let bytes = scheme_response(scope, host, &r.url)?.map(|(b, _)| b);
            let empty = bytes.as_ref().is_none_or(Vec::is_empty);
            let facts = if bytes.is_some() { Facts { status: Some(200), ..Default::default() } } else { blocked() };
            Ok(audio_settled(scope, r, &facts, SRC_SCHEME, empty))
        }
        ROUTE_NETWORK => {
            let args = request_args(scope, r);
            let meta = call(scope, host, H_NETWORK, &args)?;
            file(scope, host, r, Answered::Network(meta.clone()))?;
            let local = meta.map(|m| v8::Local::new(scope, m)).and_then(|m| v8::Local::<v8::Object>::try_from(m).ok());
            let empty = local.is_some_and(|m| member(scope, m, "bytes").is_none_or(|b| b.integer_value(scope).unwrap_or(0) == 0));
            let facts = if local.is_some() { facts_of(scope, local, r.kind & 0xff, SRC_NETWORK) } else { blocked() };
            Ok(audio_settled(scope, r, &facts, SRC_NETWORK, empty))
        }
        _ => Ok(audio_settled(scope, r, &blocked(), SRC_NETWORK, true)),
    }
}
// …its verdict: a usable one's readiness ladder, a refused one a failure — for the load no later one superseded.
fn audio_settled(scope: &mut v8::PinScope<'_, '_>, r: &Request, facts: &crate::subresource_judge::Facts, source: u32, empty: bool) -> Option<Vec<&'static str>> {
    use crate::subresource_judge::{judge, Consumer, J_AUDIO, S_EMPTY, V_OK};
    let el = r.el?;
    if !crate::media::is_current(realm(scope, r.cid), el, r.load) {
        return Some(Vec::new());
    }
    let consumer = Consumer { kind: J_AUDIO, obtains: 0, module_destination: "", preload_destination: "", integrity: "", body: b"", mode: fields(r.plan).0, quirks: false };
    if judge(&consumer, source | if empty { S_EMPTY } else { 0 }, facts) & V_OK == 0 {
        return None;
    }
    Some(crate::media::resource_loaded(scope, el, crate::media::MediaResource::Audio))
}
// A controlled audio's answer (`obtainResume`): none — the request let through — the network's; else the answer's
// verdict (an empty one's no media data), its entry filed; the outcome handed back to the bindings.
fn audio_answered(scope: &mut v8::PinScope<'_, '_>, host: v8::Local<'_, v8::Function>, r: &Request, answer: Option<v8::Local<'_, v8::Object>>, redirected: bool, render: Option<Vec<u8>>) -> Result<(), Terminated> {
    use crate::subresource_judge::{facts_of, SRC_SW_EVENT};
    let done = match answer {
        None => audio_from_network(scope, host, r)?,
        Some(answer) => {
            file(scope, host, r, Answered::Worker(v8::Global::new(scope, v8::Local::<v8::Value>::from(answer))))?;
            let bytes = render.filter(|b| !b.is_empty()).or_else(|| member(scope, answer, "bytes").and_then(|b| view_bytes(scope, b)));
            let mut facts = facts_of(scope, Some(answer), r.kind & 0xff, SRC_SW_EVENT);
            facts.redirected = redirected;
            audio_settled(scope, r, &facts, SRC_SW_EVENT, bytes.as_ref().is_none_or(Vec::is_empty))
        }
    };
    let Some(el) = r.el else { return Ok(()) };
    let nid = v8::Number::new(scope, el.to_f64()).into();
    let load = v8::Integer::new_from_unsigned(scope, r.load).into();
    let done = match done {
        Some(events) => crate::media::events_value(scope, &events),
        None => v8::Boolean::new(scope, false).into(),
    };
    call(scope, host, H_MEDIA_DONE, &[nid, load, done]).map(drop)
}
