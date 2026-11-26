// A style sheet as fetched for a URL — a `<link>`'s and an `<?xml-stylesheet?>`'s, the cascade's sheets and `@import`s —
// and a `<link rel=stylesheet>`'s load: the engine's ladder (subresource_obtain.rs's host steps reach past it).
//   - a `data:` URL of CSS, a `blob:` URL's blob;
//   - the preload its request takes (preload_map.rs), its owner's once for the sheet it obtains;
//   - a controlling service worker's answer (destination `style`), one dispatch per request for the sheet its owner
//     obtains — the cascade, `.sheet` and the link's load share it — an `@import`'s per document and controller;
//   - the network's, through the asset cache the host keeps per document, a failure its owner's for the sheet it obtains
//     (the cache keeps none: Chrome's memory cache keeps no error).
// Judged by the engine (subresource_judge.rs `judge`, J_SHEET: a style sheet's type, its integrity against its owner's
// request's metadata, kept per what answered for the sheet), and decoded as CSS Syntax "decode" has it (text_codec.rs
// `stylesheet_encoding`), the encoding it decoded in kept by URL — an `@import`'s environment.
//
// A sheet owner's request (`SheetRequest`) is the one of the sheet it obtains (`NodeData::sheet_gen`): its integrity as it
// obtained it — a change of it after is no trigger to fetch again — and what its readers share. Kept by the owner
// (`RealmArena::sheet_requests`) until it goes; a realm's own (`RealmSheets`) until its page goes (`sheetsForget`).

use std::collections::HashMap;
use std::rc::Rc;

use crate::dom::{realm, realm_id, register, NodeId};
use crate::font_files::Terminated;
use crate::subresource_judge::{facts_of, judge, Consumer, Facts, J_SHEET, SRC_ASSET, SRC_NETWORK, SRC_SCHEME, SRC_SW_SYNC, S_NO_BODY, V_CROSS_ORIGIN, V_FETCHED, V_OK};
use crate::subresource_obtain::{call, now, H_ASSET, H_CHARSET, H_CONTROLLER, H_DOCUMENT, H_FILE, H_SW_ANSWER};
use crate::subresource_plan::{plan_in, PLAN_REQUEST};

// A sheet's owner, and its node document (its request's client's).
#[derive(Clone, Copy)]
pub(crate) struct Owner {
    pub(crate) id: NodeId,
    pub(crate) doc: Option<NodeId>,
}

#[derive(Default)]
pub(crate) struct SheetRequest {
    sheet_gen: u32,
    integrity: String,
    verdicts: HashMap<u32, u32>,
    // (…the preload it took, by request — `"{plan & PLAN_REQUEST} {url}"` — None for a network error)
    preload: Option<(String, Option<Rc<crate::preload_map::Response>>)>,
    // (…a controlling service worker's answers, by request: none where it let the request through)
    answers: HashMap<String, Option<v8::Global<v8::Value>>>,
    // (…a fetch through the asset cache that failed, and what it answered)
    failed: Option<(String, Option<v8::Global<v8::Value>>)>,
    // (…and what the fetch its link began as it was connected answered — the cache's at once, or its slot's as its load task
    // took it: `sheetFetchBegin` — which its readers take rather than ask the cache again)
    answered: Option<(String, v8::Global<v8::Value>)>,
    // (…a `blob:` URL's sheet texts, by URL, `charset` and integrity)
    blob_texts: HashMap<String, Option<String>>,
    // (…and whether it made none — its fetch failed — which asking again would only fetch again)
    pub(crate) made_none: bool,
}

// A realm's own: the encodings its sheets decoded in, by URL; an `@import`'s service worker answers, by controller and
// request; an `@import`'s `blob:` sheets' texts.
#[derive(Default)]
pub(crate) struct RealmSheets {
    // A `<link>`'s fetch of its sheet under way, begun as it was connected (`sheetFetchBegin`): the host's slot, by owner —
    // and the owners whose fetch its document's abort cancelled (`sheetFetchesAbort`).
    // (…each its slot, its request — `"{plan & PLAN_REQUEST} {url}"` — and when its response comes in on the clock)
    flights: HashMap<NodeId, (u32, String, f64)>,
    cancelled: std::collections::HashSet<NodeId>,
    // …and the `@import`s of an owner's sheet under way, begun as it came to have them (`sheetImportsBegin`): each its slot
    // and its URL, the level of the tree being waited for.
    imports: HashMap<NodeId, Vec<(u32, String)>>,
    // …and the flights the cascade began for an `@import`'s sheet it read before its owner's load came to that level of
    // its tree, by request — each its slot and when its response comes in — which that level then waits for
    // (`begin_imports`).
    cascade_flights: HashMap<String, (u32, f64)>,
    // …and how deep in its `@import` tree an owner's load has gone.
    import_depths: HashMap<NodeId, usize>,
    encodings: HashMap<String, &'static str>,
    answers: HashMap<String, Option<v8::Global<v8::Value>>>,
    blob_texts: HashMap<String, Option<String>>,
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    register(scope, ns, "sheetIntegrity", sheet_integrity_op, context_id);
    register(scope, ns, "sheetEncodingOf", sheet_encoding_of_op, context_id);
    register(scope, ns, "sheetsForget", sheets_forget_op, context_id);
    register(scope, ns, "styleResolveImports", resolve_imports_op, context_id);
    register(scope, ns, "sheetFetchBegin", fetch_begin_op, context_id);
    register(scope, ns, "sheetFetchLand", fetch_land_op, context_id);
    register(scope, ns, "sheetFetchesAbort", fetches_abort_op, context_id);
    register(scope, ns, "sheetImportsBegin", imports_begin_op, context_id);
    register(scope, ns, "sheetImportsOf", imports_of_op, context_id);
    register(scope, ns, "sheetImportsLand", imports_land_op, context_id);
}

// __dom.sheetFetchBegin(owner, url, plan, scanned, host) -> how many ms after now the response of the `<link>` `owner`'s
// style sheet at `url` comes in, its request `plan`: HTML "fetch and process the linked resource" begun as the link is
// connected, in parallel — the host's slot (browser.rb `script_fetch_start`, the asset cache's flight for its document,
// which the cascade's fetch of the sheet joins: `asset_request`), its server's sleeps counted as the request is made — one
// a preload scanner saw dated as its parse began (`scanned`) — and its load task queued that much later
// (bridge.entry.js `maybeFireLinkLoad`). 0 for none begun: a scheme's, a preload's, a controlling worker's, one the
// cache answers at once.
fn fetch_begin_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    rv.set_double(0.0);
    let Some(el) = crate::dom::nid_arg(scope, &args, 0) else { return };
    let url = args.get(1).to_rust_string_lossy(scope);
    let plan = args.get(2).uint32_value(scope).unwrap_or(0);
    let scanned = args.get(3).is_true();
    let Ok(host) = v8::Local::<v8::Function>::try_from(args.get(4)) else { return };
    let cid = realm_id(scope, &args);
    if let Ok(due) = fetch_begin(scope, cid, host, el, &url, plan, scanned) {
        rv.set_double(due);
    }
}
fn fetch_begin(scope: &mut v8::PinScope<'_, '_>, cid: i32, host: v8::Local<'_, v8::Function>, el: NodeId, url: &str, plan: u32, scanned: bool) -> Result<f64, Terminated> {
    let key = format!("{} {url}", plan & PLAN_REQUEST);
    // (…the flight already under way where the cascade read its sheet first as the parser connected it: that fetch is its
    // fetch, landing as it does)
    let arena = realm(scope, cid);
    let clock = arena.event_loop.clock;
    if let Some((_, k, due_at)) = arena.realm_state(cid).and_then(|s| s.sheet_fetches.flights.get(&el)) {
        if *k == key {
            return Ok((due_at - clock).max(0.0));
        }
    }
    forget_flight(scope, cid, host, el)?;
    if crate::fetch_rules::fetch_route(url, 0, "") != crate::fetch_rules::ROUTE_NETWORK {
        return Ok(0.0);
    }
    // (…none where its sheet's answer is in already: the one the cascade's read took at once)
    if realm(scope, cid).sheet_requests.get(&el).and_then(|r| r.answered.as_ref()).is_some_and(|(k, _)| *k == key) {
        return Ok(0.0);
    }
    let doc = crate::node_handle::node_document_of(scope, el);
    if owner_preload(scope, cid, host, Owner { id: el, doc }, url, plan)?.is_some() {
        return Ok(0.0);
    }
    if call(scope, host, H_CONTROLLER, &[])?.is_some_and(|c| v8::Local::new(scope, c).uint32_value(scope).unwrap_or(0) != 0) {
        return Ok(0.0);
    }
    match begin_flight(scope, cid, host, Some(el), url, plan, scanned)? {
        Flight::Slot(id, due) => {
            let arena = realm(scope, cid);
            let clock = arena.event_loop.clock;
            if let Some(s) = arena.realm_state_mut(cid) {
                s.sheet_fetches.flights.insert(el, (id, key, clock + due));
            }
            Ok(due)
        }
        Flight::Answered(answer) => {
            let answer = v8::Local::new(scope, answer);
            keep_answer(scope, cid, el, url, plan, answer);
            Ok(0.0)
        }
        Flight::None => Ok(0.0),
    }
}
// A style resource's fetch begun in parallel (`begin_flight`): the host's slot and how many ms after now its response
// comes in; the asset cache's answer at once; or none.
enum Flight {
    Slot(u32, f64),
    Answered(v8::Global<v8::Value>),
    None,
}
// …the host's slot (browser.rb `script_fetch_start`, the asset cache's flight for the document, which a fetch of the
// request made later joins: `asset_request`), the request of the client of `el` (none: the document's), its server's sleeps
// counted as it is made — one a preload scanner saw dated as its parse began (`scanned`).
fn begin_flight(scope: &mut v8::PinScope<'_, '_>, cid: i32, host: v8::Local<'_, v8::Function>, el: Option<NodeId>, url: &str, plan: u32, scanned: bool) -> Result<Flight, Terminated> {
    use crate::subresource_obtain::{next_slot, slept_ms, H_SCRIPT_START};
    let arena = realm(scope, cid);
    let began = crate::script_fetch::began_at(arena, cid, scanned);
    let clock = arena.event_loop.clock;
    let client = match el.and_then(|el| arena.get(el)).map(|n| n.realm) {
        Some(c) => v8::Integer::new(scope, c).into(),
        None => v8::undefined(scope).into(),
    };
    let id = next_slot();
    let args = [
        text_value(scope, url),
        v8::Integer::new_from_unsigned(scope, plan).into(),
        v8::null(scope).into(),
        client,
        v8::Boolean::new(scope, true).into(),
        v8::Number::new(scope, began).into(),
        v8::Integer::new_from_unsigned(scope, id).into(),
    ];
    let Some(started) = call(scope, host, H_SCRIPT_START, &args)? else { return Ok(Flight::None) };
    if !v8::Local::new(scope, &started).is_number() {
        return Ok(Flight::Answered(started));
    }
    let slept = slept_ms(scope, v8::Local::new(scope, started));
    Ok(Flight::Slot(id, (began + slept - clock).max(0.0)))
}

// __dom.sheetImportsBegin(owner, urls, referrer, host) -> how many ms after now the last of the `@import`s `urls` of the
// sheet of `owner` (a `<style>`, a `<link>`) — imported from `referrer` (its location; null its document's) — comes in:
// CSS Values 4 "fetch a style resource" in parallel, each its own flight the cascade's fetch of it joins, its server's
// sleeps counted as it is made; the owner's load task, which "update a style block" / the link's "process the linked
// resource" fire once its critical subresources are in, queued that much later (bridge.entry.js). 0 for none begun.
fn imports_begin_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    rv.set_double(0.0);
    let Some(el) = crate::dom::nid_arg(scope, &args, 0) else { return };
    let urls: Vec<String> = match v8::Local::<v8::Array>::try_from(args.get(1)) {
        Ok(list) => (0..list.length()).filter_map(|i| list.get_index(scope, i)).map(|v| v.to_rust_string_lossy(scope)).collect(),
        Err(_) => return,
    };
    let referrer = args.get(2).is_string().then(|| args.get(2).to_rust_string_lossy(scope));
    let Ok(host) = v8::Local::<v8::Function>::try_from(args.get(3)) else { return };
    let cid = realm_id(scope, &args);
    if let Ok(due) = imports_begin(scope, cid, host, el, &urls, referrer.as_deref()) {
        rv.set_double(due);
    }
}
fn imports_begin(scope: &mut v8::PinScope<'_, '_>, cid: i32, host: v8::Local<'_, v8::Function>, el: NodeId, urls: &[String], referrer: Option<&str>) -> Result<f64, Terminated> {
    imports_land(scope, cid, host, el)?;
    if let Some(s) = realm(scope, cid).realm_state_mut(cid) {
        s.sheet_fetches.import_depths.remove(&el);
    }
    if urls.is_empty() || call(scope, host, H_CONTROLLER, &[])?.is_some_and(|c| v8::Local::new(scope, c).uint32_value(scope).unwrap_or(0) != 0) {
        return Ok(0.0);
    }
    let plan = sheet_plan(scope, cid, None, referrer);
    let scanned = crate::script_fetch::parser_input_scanned(scope, cid);
    begin_imports(scope, cid, host, el, urls, plan, scanned)
}
// …the level of the tree its load waits for: each `@import` of `urls` a flight of its own — one the cascade began, or
// another owner's, joined: what is left of its time — the longest the owner's load waits.
fn begin_imports(scope: &mut v8::PinScope<'_, '_>, cid: i32, host: v8::Local<'_, v8::Function>, el: NodeId, urls: &[String], plan: u32, scanned: bool) -> Result<f64, Terminated> {
    let (mut slots, mut due) = (Vec::new(), 0.0f64);
    for url in urls {
        if crate::fetch_rules::fetch_route(url, 0, "") != crate::fetch_rules::ROUTE_NETWORK {
            continue;
        }
        let arena = realm(scope, cid);
        let clock = arena.event_loop.clock;
        let key = format!("{} {url}", plan & PLAN_REQUEST);
        if let Some((id, due_at)) = arena.realm_state_mut(cid).and_then(|s| s.sheet_fetches.cascade_flights.remove(&key)) {
            slots.push((id, url.clone()));
            due = due.max(due_at - clock);
            continue;
        }
        if let Flight::Slot(id, d) = begin_flight(scope, cid, host, None, url, plan, scanned)? {
            slots.push((id, url.clone()));
            due = due.max(d);
        }
    }
    if !slots.is_empty() {
        if let Some(s) = realm(scope, cid).realm_state_mut(cid) {
            s.sheet_fetches.imports.insert(el, slots);
        }
    }
    Ok(due)
}
// __dom.sheetImportsOf(owner) -> `[urls, location]`: the `@import`s of the `<link>` `owner`'s sheet as it was answered
// (`SheetRequest::answered`), resolved against the URL it came from, and that URL — null where it kept none.
fn imports_of_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    rv.set_null();
    let Some(el) = crate::dom::nid_arg(scope, &args, 0) else { return };
    let cid = realm_id(scope, &args);
    let Some((key, answer)) = realm(scope, cid).sheet_requests.get(&el).and_then(|r| r.answered.clone()) else { return };
    let answer = v8::Local::new(scope, answer);
    let Ok(array) = v8::Local::<v8::Array>::try_from(answer) else { return };
    let Some(text) = array.get_index(scope, 0).filter(|t| t.is_string()).map(|t| t.to_rust_string_lossy(scope)) else { return };
    let meta = array.get_index(scope, 1).and_then(|m| v8::Local::<v8::Object>::try_from(m).ok());
    let requested = key.split_once(' ').map_or(key.as_str(), |(_, u)| u).to_owned();
    let location = string_member(scope, meta, "url").filter(|u| !u.is_empty()).unwrap_or(requested);
    let doc = crate::node_handle::node_document_of(scope, el);
    let quirks = realm(scope, cid).document_mode(doc).0;
    let urls: Vec<v8::Local<v8::Value>> = crate::sheets::import_urls(&text, &location, quirks).iter().map(|u| text_value(scope, u)).collect();
    let urls = v8::Array::new_with_elements(scope, &urls).into();
    let items = [urls, text_value(scope, &location)];
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}
// __dom.sheetImportsLand(owner, host) -> how many ms after now the next level of the owner's `@import` tree comes in, -1 for
// none: the level it waited for landed as its load task runs — their slots taken (the document's asset memo, their
// cookies) — and their own `@import`s, resolved against where each came from, begun as the next (`begin_imports`), which
// its load waits for in turn: the whole tree its critical subresources.
fn imports_land_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    rv.set_double(-1.0);
    let Some(el) = crate::dom::nid_arg(scope, &args, 0) else { return };
    let Ok(host) = v8::Local::<v8::Function>::try_from(args.get(1)) else { return };
    let cid = realm_id(scope, &args);
    let Ok(next) = imports_land(scope, cid, host, el) else { return };
    if next.is_empty() {
        return;
    }
    let plan = sheet_plan(scope, cid, None, None);
    let Ok(due) = begin_imports(scope, cid, host, el, &next, plan, false) else { return };
    // (…a level of none begun — each answered at once — none to wait for)
    if realm(scope, cid).realm_state(cid).is_some_and(|s| s.sheet_fetches.imports.contains_key(&el)) {
        rv.set_double(due);
    }
}
// …the level landed, the `@import`s of its sheets — none past the depth an import cycle would go on to (`IMPORT_DEPTH_LIMIT`).
fn imports_land(scope: &mut v8::PinScope<'_, '_>, cid: i32, host: v8::Local<'_, v8::Function>, el: NodeId) -> Result<Vec<String>, Terminated> {
    let Some(slots) = realm(scope, cid).realm_state_mut(cid).and_then(|s| s.sheet_fetches.imports.remove(&el)) else { return Ok(Vec::new()) };
    let doc = crate::node_handle::node_document_of(scope, el);
    let quirks = realm(scope, cid).document_mode(doc).0;
    let Some(state) = realm(scope, cid).realm_state_mut(cid) else { return Ok(Vec::new()) };
    let depths = &mut state.sheet_fetches.import_depths;
    let depth = depths.get(&el).copied().unwrap_or(0) + 1;
    depths.insert(el, depth);
    let mut next = Vec::new();
    for (id, url) in slots {
        let slot = v8::Integer::new_from_unsigned(scope, id).into();
        let Some(answer) = call(scope, host, crate::subresource_obtain::H_SCRIPT_TAKE, &[slot])? else { continue };
        let answer = v8::Local::new(scope, answer);
        let Ok(array) = v8::Local::<v8::Array>::try_from(answer) else { continue };
        let Some(text) = array.get_index(scope, 0).filter(|t| t.is_string()).map(|t| t.to_rust_string_lossy(scope)) else { continue };
        let meta = array.get_index(scope, 1).and_then(|m| v8::Local::<v8::Object>::try_from(m).ok());
        let location = string_member(scope, meta, "url").filter(|u| !u.is_empty()).unwrap_or(url);
        if depth < IMPORT_DEPTH_LIMIT {
            next.extend(crate::sheets::import_urls(&text, &location, quirks));
        }
    }
    Ok(next)
}
// What became of a `<link>`'s fetch as its load task runs (`sheetFetchLand`): none was begun (its load obtains its sheet as
// it is); it landed; its document's abort cancelled it — a network error.
const FLIGHT_NONE: u32 = 0;
const FLIGHT_LANDED: u32 = 1;
const FLIGHT_CANCELLED: u32 = 2;
// __dom.sheetFetchLand(owner, host, url, plan) -> what became of the `<link>` `owner`'s fetch begun as it was connected
// (`FLIGHT_*`): its slot taken as its load task runs — its response the document's asset memo's, its cookies stored.
fn fetch_land_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    rv.set_uint32(FLIGHT_NONE);
    let Some(el) = crate::dom::nid_arg(scope, &args, 0) else { return };
    let Ok(host) = v8::Local::<v8::Function>::try_from(args.get(1)) else { return };
    let cid = realm_id(scope, &args);
    let Some(state) = realm(scope, cid).realm_state_mut(cid) else { return };
    if state.sheet_fetches.cancelled.remove(&el) {
        return rv.set_uint32(FLIGHT_CANCELLED);
    }
    let Some((id, _, _)) = state.sheet_fetches.flights.remove(&el) else { return };
    let url = args.get(2).to_rust_string_lossy(scope);
    let plan = args.get(3).uint32_value(scope).unwrap_or(0);
    let id = v8::Integer::new_from_unsigned(scope, id).into();
    let Ok(answer) = call(scope, host, crate::subresource_obtain::H_SCRIPT_TAKE, &[id]) else { return };
    if let Some(answer) = answer {
        let answer = v8::Local::new(scope, answer);
        keep_answer(scope, cid, el, &url, plan, answer);
    }
    rv.set_uint32(FLIGHT_LANDED);
}
// …what answered the fetch, kept for the sheet its owner obtains: an answer of the asset cache's shape alone.
fn keep_answer(scope: &mut v8::PinScope<'_, '_>, cid: i32, el: NodeId, url: &str, plan: u32, answer: v8::Local<'_, v8::Value>) {
    if !answer.is_array() {
        return;
    }
    let answer = v8::Global::new(scope, answer);
    request_of(realm(scope, cid), el).answered = Some((format!("{} {url}", plan & PLAN_REQUEST), answer));
}
// __dom.sheetFetchesAbort(host) -> the `<link>`s whose fetch the calling realm's document's abort cancels (HTML "abort a
// document": "cancel any instances of the fetch algorithm"), their slots let go of — each a network error, its load task
// to run at once (bridge.entry.js `wakeLinkLoads`).
fn fetches_abort_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Ok(host) = v8::Local::<v8::Function>::try_from(args.get(0)) else { return };
    let cid = realm_id(scope, &args);
    let Some(state) = realm(scope, cid).realm_state_mut(cid) else { return };
    let flights: Vec<(NodeId, u32)> = state.sheet_fetches.flights.drain().map(|(el, (id, _, _))| (el, id)).collect();
    state.sheet_fetches.cancelled.extend(flights.iter().map(|&(el, _)| el));
    let imports: Vec<u32> = state.sheet_fetches.cascade_flights.drain().map(|(_, (id, _))| id).collect();
    for id in flights.iter().map(|&(_, id)| id).chain(imports) {
        let id = v8::Integer::new_from_unsigned(scope, id).into();
        if call(scope, host, crate::subresource_obtain::H_SCRIPT_FORGET, &[id]).is_err() {
            return;
        }
    }
    let owners: Vec<NodeId> = flights.into_iter().map(|(el, _)| el).collect();
    rv.set(crate::dom::nodes_value(scope, cid, &owners));
}
// …and one a later fetch of the link's superseded (its `href` changed): let go of.
fn forget_flight(scope: &mut v8::PinScope<'_, '_>, cid: i32, host: v8::Local<'_, v8::Function>, el: NodeId) -> Result<(), Terminated> {
    let Some(state) = realm(scope, cid).realm_state_mut(cid) else { return Ok(()) };
    state.sheet_fetches.cancelled.remove(&el);
    let Some((id, _, _)) = state.sheet_fetches.flights.remove(&el) else { return Ok(()) };
    let id = v8::Integer::new_from_unsigned(scope, id).into();
    call(scope, host, crate::subresource_obtain::H_SCRIPT_FORGET, &[id]).map(drop)
}

// A sheet as a response of it makes it: its text — None where it failed (none, none to use, or one that is no style
// sheet: a status not ok, a type not text/css outside quirks mode — HTML "process the linked resource", CSSOM "fetch a CSS
// style sheet": no sheet) — whether it is CORS-same-origin, which makes the sheet origin-clean (CSSOM; HTML's link "process the
// linked resource": a response of type `basic` or `cors`, an HTTP error's too, none of another origin nor a network
// error), its location (the URL its response came from — a redirect's last, a worker's answer's — `url` for a
// scheme's), its `Referrer-Policy`, the host's facts of the response (`meta`) and the worker's answer (`answer`), and
// whether the network answered.
pub(crate) struct Sheet {
    pub(crate) text: Option<String>,
    pub(crate) clean: bool,
    pub(crate) location: String,
    policy: Option<String>,
    meta: Option<v8::Global<v8::Value>>,
    answer: Option<v8::Global<v8::Value>>,
    network: bool,
}
impl Sheet {
    fn none(url: &str) -> Sheet {
        Sheet { text: None, clean: false, location: url.to_owned(), policy: None, meta: None, answer: None, network: false }
    }
    // …of `verdict` on a response whose text is `text`.
    fn of_verdict(verdict: u32, text: Option<String>, location: String) -> Sheet {
        let text = text.filter(|_| verdict & V_OK != 0);
        Sheet { text, clean: verdict & (V_FETCHED | V_CROSS_ORIGIN) == V_FETCHED, location, policy: None, meta: None, answer: None, network: false }
    }
}

fn text_value<'s>(scope: &mut v8::PinScope<'s, '_>, s: &str) -> v8::Local<'s, v8::Value> {
    v8::String::new(scope, s).map_or_else(|| v8::undefined(scope).into(), Into::into)
}
fn member<'s>(scope: &mut v8::PinScope<'s, '_>, obj: v8::Local<'_, v8::Object>, k: &str) -> Option<v8::Local<'s, v8::Value>> {
    let k = v8::String::new(scope, k)?;
    obj.get(scope, k.into()).filter(|v| !v.is_null_or_undefined())
}
fn string_member(scope: &mut v8::PinScope<'_, '_>, obj: Option<v8::Local<'_, v8::Object>>, k: &str) -> Option<String> {
    obj.and_then(|o| member(scope, o, k)).map(|v| v.to_rust_string_lossy(scope))
}
// …a body's bytes: a view's, or a text's UTF-8.
fn bytes_of(scope: &mut v8::PinScope<'_, '_>, v: Option<v8::Local<'_, v8::Value>>) -> Option<Vec<u8>> {
    let v = v?;
    if v.is_string() {
        return Some(v.to_rust_string_lossy(scope).into_bytes());
    }
    crate::subresource_obtain::view_bytes(scope, v)
}
// …a response object's header `name` (its `headers`, a plain object).
fn header(scope: &mut v8::PinScope<'_, '_>, obj: Option<v8::Local<'_, v8::Object>>, name: &str) -> Option<String> {
    let headers = obj.and_then(|o| member(scope, o, "headers")).and_then(|h| v8::Local::<v8::Object>::try_from(h).ok())?;
    crate::fetch_rules::response_header(scope, headers, name)
}

// The owner `id`'s request of the sheet it obtains now, made where it has none of its sheet's count.
pub(crate) fn request_of(arena: &mut crate::dom::RealmArena, id: NodeId) -> &mut SheetRequest {
    let (sheet_gen, integrity) = arena.get(id).map_or((0, String::new()), |n| (n.sheet_gen, n.plain_attr("integrity").unwrap_or("").to_owned()));
    if arena.sheet_requests.get(&id).is_none_or(|r| r.sheet_gen != sheet_gen) {
        arena.sheet_requests.insert(id, SheetRequest { sheet_gen, integrity, ..Default::default() });
    }
    arena.sheet_requests.get_mut(&id).expect("just made")
}

// What the realm's sheets are judged and decoded in: its document (its mode a quirks one's), and the encoding it is in.
struct Env {
    doc: Option<NodeId>,
    charset: String,
}
fn env(scope: &mut v8::PinScope<'_, '_>, host: v8::Local<'_, v8::Function>) -> Result<Env, Terminated> {
    let doc = call(scope, host, H_DOCUMENT, &[])?.and_then(|d| v8::Local::new(scope, d).integer_value(scope)).and_then(NodeId::from_i64);
    let charset = call(scope, host, H_CHARSET, &[])?;
    let charset = crate::subresource_obtain::text_of(scope, charset).unwrap_or_default();
    Ok(Env { doc, charset })
}

// The verdict on a sheet's response (`judge`, J_SHEET) from `source` — `body` its bytes, hashed where its owner's request
// has integrity metadata — kept per source for the sheet its owner obtains.
fn judge_sheet(scope: &mut v8::PinScope<'_, '_>, cid: i32, env: &Env, owner: Option<Owner>, facts: &Facts, source: u32, body: &dyn Fn() -> Vec<u8>) -> u32 {
    let quirks = realm(scope, cid).document_mode(env.doc).0;
    let verdict = |integrity: &str| {
        let bytes = if integrity.is_empty() { Vec::new() } else { body() };
        let consumer = Consumer { kind: J_SHEET, obtains: 0, module_destination: "", preload_destination: "", integrity, body: &bytes, mode: "no-cors", quirks };
        judge(&consumer, source, facts)
    };
    let Some(owner) = owner else { return verdict("") };
    let request = request_of(realm(scope, cid), owner.id);
    if request.integrity.is_empty() {
        return verdict("");
    }
    if let Some(&v) = request.verdicts.get(&source) {
        return v;
    }
    let integrity = request.integrity.clone();
    let v = verdict(&integrity);
    request_of(realm(scope, cid), owner.id).verdicts.insert(source, v);
    v
}

// CSS Syntax "decode" of a sheet's bytes (text_codec.rs `stylesheet_encoding`): by its Content-Type's charset, an opening
// `@charset`, its environment's encoding — its owner's `charset`, else the importing sheet's or its document's — else
// UTF-8, a BOM's over all; the encoding it decoded with kept by `url`.
fn decode(scope: &mut v8::PinScope<'_, '_>, cid: i32, env: &Env, url: &str, bytes: &[u8], content_type: &str, owner: Option<Owner>, environment: Option<&str>) -> String {
    let charset = owner.and_then(|o| realm(scope, cid).get(o.id).and_then(|n| n.plain_attr("charset")).map(str::to_owned)).unwrap_or_default();
    let (text, encoding) = crate::text_codec::decode_stylesheet(bytes, content_type, &charset, environment.unwrap_or(&env.charset));
    if let Some(s) = realm(scope, cid).realm_state_mut(cid) {
        s.sheet_fetches.encodings.insert(url.to_owned(), encoding);
    }
    text
}

// The sheet at `url`: `owner` its `<link>`, whose request it is — none for an `@import`'s, an `<?xml-stylesheet?>`'s;
// `environment` the encoding of the sheet importing it, `referrer` that sheet's location. Its referrer policy noted at
// its location, which the requests it is responsible for are made under (url_ops.rs `note_sheet_policy`).
pub(crate) fn fetch(scope: &mut v8::PinScope<'_, '_>, cid: i32, host: v8::Local<'_, v8::Function>, owner: Option<Owner>, url: &str, environment: Option<&str>, referrer: Option<&str>) -> Result<Sheet, Terminated> {
    let sheet = style_sheet(scope, cid, host, owner, url, environment, referrer)?;
    realm(scope, cid).note_sheet_policy(&sheet.location, sheet.policy.as_deref());
    Ok(sheet)
}
fn style_sheet(scope: &mut v8::PinScope<'_, '_>, cid: i32, host: v8::Local<'_, v8::Function>, owner: Option<Owner>, url: &str, environment: Option<&str>, referrer: Option<&str>) -> Result<Sheet, Terminated> {
    use crate::fetch_rules::{fetch_route, ROUTE_BLOB, ROUTE_DATA};
    let env = env(scope, host)?;
    match fetch_route(url, 0, "") {
        ROUTE_DATA => return Ok(Sheet { text: data_sheet_text(scope, cid, &env, url, owner, environment), clean: true, ..Sheet::none(url) }),
        ROUTE_BLOB => return Ok(Sheet { text: blob_sheet_text(scope, cid, host, &env, url, owner, environment)?, clean: true, ..Sheet::none(url) }),
        _ => {}
    }
    if let Some(sheet) = preloaded_sheet(scope, cid, host, &env, url, owner, environment, referrer)? {
        return Ok(sheet);
    }
    if let Some(sheet) = worker_sheet(scope, cid, host, &env, url, owner, referrer)? {
        return Ok(sheet);
    }
    Ok(Sheet { network: true, ..network_sheet(scope, cid, host, &env, url, owner, environment, referrer)? })
}

// The plan of a sheet's request: its owner's (its `crossorigin`, its `referrerpolicy`), else the importing sheet's policy.
fn sheet_plan(scope: &mut v8::PinScope<'_, '_>, cid: i32, owner: Option<Owner>, referrer: Option<&str>) -> u32 {
    plan_in(realm(scope, cid), J_SHEET, owner.map(|o| o.id), owner.and_then(|o| o.doc), referrer)
}

// …a `data:` URL's: its body where its MIME type is `text/css` — none where it fails its owner's integrity (a network
// error) — decoded.
fn data_sheet_text(scope: &mut v8::PinScope<'_, '_>, cid: i32, env: &Env, url: &str, owner: Option<Owner>, environment: Option<&str>) -> Option<String> {
    let (mime, body) = crate::data_url::process(url)?;
    if crate::mime::parse(&mime).is_none_or(|m| m.essence != "text/css") {
        return None;
    }
    if owner.is_some() {
        let facts = Facts { response_type: "default".to_owned(), content_type: mime.clone(), ..Default::default() };
        if judge_sheet(scope, cid, env, owner, &facts, SRC_SCHEME, &|| body.clone()) == 0 {
            return None;
        }
    }
    Some(decode(scope, cid, env, url, &body, &mime, owner, environment))
}

// …a `blob:` URL's: its blob's bytes, as their type makes them a sheet (`judge`), decoded — once per URL, `charset` and
// integrity for its owner, per URL and environment for an `@import`.
#[allow(clippy::too_many_arguments)]
fn blob_sheet_text(scope: &mut v8::PinScope<'_, '_>, cid: i32, host: v8::Local<'_, v8::Function>, env: &Env, url: &str, owner: Option<Owner>, environment: Option<&str>) -> Result<Option<String>, Terminated> {
    let key = match owner {
        Some(o) => {
            let charset = realm(scope, cid).get(o.id).and_then(|n| n.plain_attr("charset")).unwrap_or("").to_owned();
            let integrity = request_of(realm(scope, cid), o.id).integrity.clone();
            format!("{url}\0{charset}\0{integrity}")
        }
        None => format!("{url}\0{}\0", environment.unwrap_or("")),
    };
    let known = match owner {
        Some(o) => request_of(realm(scope, cid), o.id).blob_texts.get(&key).cloned(),
        None => realm(scope, cid).realm_state_mut(cid).and_then(|s| s.sheet_fetches.blob_texts.get(&key).cloned()),
    };
    if let Some(text) = known {
        return Ok(text);
    }
    let Some((bytes, content_type)) = crate::subresource_obtain::scheme_response(scope, host, url)? else { return Ok(None) };
    let facts = crate::subresource_obtain::scheme_facts(content_type.clone());
    let verdict = judge_sheet(scope, cid, env, owner, &facts, SRC_SCHEME, &|| bytes.clone());
    let text = (verdict & V_OK != 0).then(|| decode(scope, cid, env, url, &bytes, &content_type, owner, environment));
    match owner {
        Some(o) => {
            request_of(realm(scope, cid), o.id).blob_texts.insert(key, text.clone());
        }
        None => {
            if let Some(s) = realm(scope, cid).realm_state_mut(cid) {
                s.sheet_fetches.blob_texts.insert(key, text.clone());
            }
        }
    }
    Ok(text)
}

// …the preload its request takes (Fetch "fetch": "consume a preloaded resource") — its owner's taken once for the sheet
// it obtains, so its every reader has the one response — judged and decoded as the network's is: None where none
// matched.
#[allow(clippy::too_many_arguments)]
fn preloaded_sheet(scope: &mut v8::PinScope<'_, '_>, cid: i32, host: v8::Local<'_, v8::Function>, env: &Env, url: &str, owner: Option<Owner>, environment: Option<&str>, referrer: Option<&str>) -> Result<Option<Sheet>, Terminated> {
    let Some(response) = sheet_preload(scope, cid, host, env, url, owner, referrer)? else { return Ok(None) };
    let Some(resp) = response else { return Ok(Some(Sheet::none(url))) };
    let facts = resp.facts();
    let verdict = judge_sheet(scope, cid, env, owner, &facts, SRC_NETWORK, &|| resp.body().to_vec());
    let text = (verdict & V_OK != 0).then(|| decode(scope, cid, env, url, resp.body(), resp.header("content-type").unwrap_or(""), owner, environment));
    let location = if resp.url().is_empty() { url.to_owned() } else { resp.url().to_owned() };
    let mut sheet = Sheet::of_verdict(verdict, text, location);
    sheet.policy = resp.header("referrer-policy").map(str::to_owned);
    Ok(Some(sheet))
}
// …the response itself: Some(None) for a network error, None where none matched.
fn sheet_preload(scope: &mut v8::PinScope<'_, '_>, cid: i32, host: v8::Local<'_, v8::Function>, env: &Env, url: &str, owner: Option<Owner>, referrer: Option<&str>) -> Result<Option<Option<Rc<crate::preload_map::Response>>>, Terminated> {
    let plan = sheet_plan(scope, cid, owner, referrer);
    let Some(owner) = owner else {
        let Some(doc) = env.doc else { return Ok(None) };
        return Ok(crate::preload_map::consume(scope, cid, (doc, url, "style", plan), "", host)?.map(|r| r.map(Rc::new)));
    };
    owner_preload(scope, cid, host, owner, url, plan)
}
// …an owner's, taken once for the sheet it obtains (by its request, `plan`) — kept where one matched.
pub(crate) fn owner_preload(scope: &mut v8::PinScope<'_, '_>, cid: i32, host: v8::Local<'_, v8::Function>, owner: Owner, url: &str, plan: u32) -> Result<Option<Option<Rc<crate::preload_map::Response>>>, Terminated> {
    let key = format!("{} {url}", plan & PLAN_REQUEST);
    let request = request_of(realm(scope, cid), owner.id);
    if let Some((k, resp)) = &request.preload {
        if *k == key {
            return Ok(Some(resp.clone()));
        }
    }
    let integrity = request.integrity.clone();
    let Some(doc) = owner.doc else { return Ok(None) };
    let taken = crate::preload_map::consume(scope, cid, (doc, url, "style", plan), &integrity, host)?.map(|r| r.map(Rc::new));
    if let Some(resp) = &taken {
        request_of(realm(scope, cid), owner.id).preload = Some((key, resp.clone()));
    }
    Ok(taken)
}

// …a controlling service worker's answer — its sheet at the URL of the response it answered with, its text as it
// answered it — None where none controls the document, or none answered.
fn worker_sheet(scope: &mut v8::PinScope<'_, '_>, cid: i32, host: v8::Local<'_, v8::Function>, env: &Env, url: &str, owner: Option<Owner>, referrer: Option<&str>) -> Result<Option<Sheet>, Terminated> {
    let plan = sheet_plan(scope, cid, owner, referrer);
    let integrity = owner.map(|o| request_of(realm(scope, cid), o.id).integrity.clone()).unwrap_or_default();
    let Some(answer) = worker_answer(scope, cid, host, url, plan, &integrity, referrer, owner)? else { return Ok(None) };
    let local = v8::Local::new(scope, &answer);
    let obj = v8::Local::<v8::Object>::try_from(local).ok();
    let body = string_member(scope, obj, "body");
    let raw = obj.and_then(|o| member(scope, o, "body_bytes").or_else(|| member(scope, o, "body")));
    let bytes = bytes_of(scope, raw).unwrap_or_default();
    let facts = facts_of(scope, obj, J_SHEET, SRC_SW_SYNC);
    let no_body = if body.is_none() { S_NO_BODY } else { 0 };
    let verdict = judge_sheet(scope, cid, env, owner, &facts, SRC_SW_SYNC | no_body, &|| bytes.clone());
    let location = string_member(scope, obj, "url").filter(|u| !u.is_empty()).unwrap_or_else(|| url.to_owned());
    let mut sheet = Sheet::of_verdict(verdict, body, location);
    sheet.policy = string_member(scope, obj, "referrerPolicy");
    sheet.answer = Some(answer);
    Ok(Some(sheet))
}
// …the answer itself, asked once per request: for the sheet its owner obtains, or (an `@import`'s) per controller,
// integrity and referrer in the realm — none asked of an uncontrolled document (a claim since may make it controlled:
// none kept then).
#[allow(clippy::too_many_arguments)]
pub(crate) fn worker_answer(scope: &mut v8::PinScope<'_, '_>, cid: i32, host: v8::Local<'_, v8::Function>, url: &str, plan: u32, integrity: &str, referrer: Option<&str>, owner: Option<Owner>) -> Result<Option<v8::Global<v8::Value>>, Terminated> {
    let ctrl = call(scope, host, H_CONTROLLER, &[])?.and_then(|c| v8::Local::new(scope, c).uint32_value(scope)).unwrap_or(0);
    if ctrl == 0 {
        return Ok(None);
    }
    let key = match owner {
        Some(_) => format!("{} {url}", plan & PLAN_REQUEST),
        None => format!("{ctrl} {} {integrity} {} {url}", plan & PLAN_REQUEST, referrer.unwrap_or("")),
    };
    let known = match owner {
        Some(o) => request_of(realm(scope, cid), o.id).answers.get(&key).cloned(),
        None => realm(scope, cid).realm_state_mut(cid).and_then(|s| s.sheet_fetches.answers.get(&key).cloned()),
    };
    if let Some(answer) = known {
        return Ok(answer);
    }
    let r = match referrer {
        Some(r) => text_value(scope, r),
        None => v8::null(scope).into(),
    };
    let args = [text_value(scope, url), v8::Integer::new_from_unsigned(scope, plan).into(), r, v8::undefined(scope).into(), v8::Boolean::new(scope, false).into(), text_value(scope, integrity)];
    let answer = call(scope, host, H_SW_ANSWER, &args)?;
    match owner {
        Some(o) => {
            request_of(realm(scope, cid), o.id).answers.insert(key, answer.clone());
        }
        None => {
            if let Some(s) = realm(scope, cid).realm_state_mut(cid) {
                s.sheet_fetches.answers.insert(key, answer.clone());
            }
        }
    }
    Ok(answer)
}

// …the network's, through the asset cache (its body, its facts, its bytes where they are not its text's UTF-8),
// judged on the facts of the response it got — a body the host kept no facts for a response all the same — decoded;
// its location the URL its response came from, which the encoding it decoded in is kept by too.
#[allow(clippy::too_many_arguments)]
fn network_sheet(scope: &mut v8::PinScope<'_, '_>, cid: i32, host: v8::Local<'_, v8::Function>, env: &Env, url: &str, owner: Option<Owner>, environment: Option<&str>, referrer: Option<&str>) -> Result<Sheet, Terminated> {
    let plan = sheet_plan(scope, cid, owner, referrer);
    let Some(response) = asset(scope, cid, host, url, plan, owner, referrer)? else { return Ok(Sheet::none(url)) };
    let local = v8::Local::new(scope, &response);
    let Ok(array) = v8::Local::<v8::Array>::try_from(local) else { return Ok(Sheet::none(url)) };
    let mut at = [None; 3];
    for (k, slot) in at.iter_mut().enumerate() {
        *slot = array.get_index(scope, k as u32).filter(|v| !v.is_null_or_undefined());
    }
    let [body, meta, bytes] = at;
    let facts_obj = meta.and_then(|m| v8::Local::<v8::Object>::try_from(m).ok());
    let facts = facts_of(scope, facts_obj, J_SHEET, SRC_ASSET);
    let raw = bytes_of(scope, bytes.or(body)).unwrap_or_default();
    let no_body = if body.is_none() { S_NO_BODY } else { 0 };
    let verdict = judge_sheet(scope, cid, env, owner, &facts, SRC_ASSET | no_body, &|| raw.clone());
    let body_text = body.map(|b| b.to_rust_string_lossy(scope));
    let location = string_member(scope, facts_obj, "url").filter(|u| !u.is_empty()).unwrap_or_else(|| url.to_owned());
    let mut sheet = Sheet::of_verdict(verdict, body_text, location.clone());
    if sheet.text.is_some() {
        let content_type = header(scope, facts_obj, "content-type").unwrap_or_default();
        sheet.text = Some(decode(scope, cid, env, url, &raw, &content_type, owner, environment));
    }
    if location != url {
        if let Some(s) = realm(scope, cid).realm_state_mut(cid) {
            if let Some(&e) = s.sheet_fetches.encodings.get(url) {
                s.sheet_fetches.encodings.insert(location, e);
            }
        }
    }
    sheet.policy = header(scope, facts_obj, "referrer-policy");
    sheet.meta = facts_obj.map(|m| v8::Global::new(scope, v8::Local::<v8::Value>::from(m)));
    Ok(sheet)
}
// …the asset cache's response itself — an owner's fetch made once for the sheet it obtains where it failed (the cache
// keeps none: the readers of one sheet's fetch share its failure) — none where there is no cache.
pub(crate) fn asset(scope: &mut v8::PinScope<'_, '_>, cid: i32, host: v8::Local<'_, v8::Function>, url: &str, plan: u32, owner: Option<Owner>, referrer: Option<&str>) -> Result<Option<v8::Global<v8::Value>>, Terminated> {
    let key = format!("{} {url}", plan & PLAN_REQUEST);
    if let Some(o) = owner {
        let request = request_of(realm(scope, cid), o.id);
        if let Some((k, answered)) = &request.answered {
            if *k == key {
                return Ok(Some(answered.clone()));
            }
        }
        if let Some((k, failed)) = &request.failed {
            if *k == key {
                return Ok(failed.clone());
            }
        }
    }
    // (…its fetch begun in parallel where none is under way — a flight the cascade's reading joins rather than waits on: a
    // server's time is its owner's load's to wait out, not the cascade's, which a sleep run on the event loop would let
    // any task in under — Chrome and Firefox `inl dcl a.js-ran t50 st load`, rv-r13-probe `s5_stylemedia`, and
    // `inl dcl a.js-ran css load`, `s4_media`)
    let begun = cascade_flight(scope, cid, host, url, plan, owner, &key)?;
    let client = match owner.and_then(|o| realm(scope, cid).get(o.id).map(|n| n.realm)) {
        Some(c) => v8::Integer::new(scope, c).into(),
        None => v8::undefined(scope).into(),
    };
    let r = match referrer {
        Some(r) => text_value(scope, r),
        None => v8::null(scope).into(),
    };
    let (module, since, joins) = (v8::Boolean::new(scope, false).into(), v8::undefined(scope).into(), v8::Boolean::new(scope, false).into());
    let args = [text_value(scope, url), v8::Integer::new_from_unsigned(scope, plan).into(), r, client, module, since, joins];
    let response = match begun {
        Some(answer) => Some(answer),
        None => call(scope, host, H_ASSET, &args)?,
    };
    if let Some(o) = owner {
        let failed = response.as_ref().map(|r| v8::Local::new(scope, r)).and_then(|r| v8::Local::<v8::Array>::try_from(r).ok()).is_none_or(|a| a.get_index(scope, 0).is_none_or(|b| b.is_null_or_undefined()));
        let request = request_of(realm(scope, cid), o.id);
        match (failed, &response) {
            (true, _) => request.failed = Some((key, response.clone())),
            // (…kept for its other readers: its load, the fetch its connection would begin — one the cascade made first)
            (false, Some(answer)) => request.answered = Some((key, answer.clone())),
            _ => {}
        }
    }
    Ok(response)
}

// …the flight of a sheet the cascade reads before anything fetched it, begun as the request is: an owner's (a link's,
// which its fetch as the parser connects it then finds: `fetch_begin`), or the realm's one per request of an `@import`'s,
// which the level of its owner's tree it is on then waits for (`begin_imports`) — none where one is under way — the answer,
// where it came at once.
fn cascade_flight(scope: &mut v8::PinScope<'_, '_>, cid: i32, host: v8::Local<'_, v8::Function>, url: &str, plan: u32, owner: Option<Owner>, key: &str) -> Result<Option<v8::Global<v8::Value>>, Terminated> {
    if crate::fetch_rules::fetch_route(url, 0, "") != crate::fetch_rules::ROUTE_NETWORK {
        return Ok(None);
    }
    let Some(state) = realm(scope, cid).realm_state(cid) else { return Ok(None) };
    let under_way = match owner {
        Some(o) => state.sheet_fetches.flights.get(&o.id).is_some_and(|(_, k, _)| k == key),
        None => state.sheet_fetches.cascade_flights.contains_key(key),
    };
    if under_way {
        return Ok(None);
    }
    let scanned = crate::script_fetch::parser_input_scanned(scope, cid);
    match begin_flight(scope, cid, host, owner.map(|o| o.id), url, plan, scanned)? {
        // (…one its server answered at once taken as it is: no time of it left to join)
        Flight::Slot(id, due) if due <= 0.0 => {
            let slot = v8::Integer::new_from_unsigned(scope, id).into();
            call(scope, host, crate::subresource_obtain::H_SCRIPT_TAKE, &[slot])
        }
        Flight::Slot(id, due) => {
            let arena = realm(scope, cid);
            let due_at = arena.event_loop.clock + due;
            if let Some(s) = arena.realm_state_mut(cid) {
                if let Some(o) = owner {
                    s.sheet_fetches.flights.insert(o.id, (id, key.to_owned(), due_at));
                } else {
                    s.sheet_fetches.cascade_flights.insert(key.to_owned(), (id, due_at));
                }
            }
            Ok(None)
        }
        Flight::Answered(answer) => Ok(Some(answer)),
        Flight::None => Ok(None),
    }
}

// The integrity metadata of the owner `id`'s request of the sheet it obtains now (a `<link>`'s load takes it too).
pub(crate) fn owner_integrity(arena: &mut crate::dom::RealmArena, id: NodeId) -> String {
    request_of(arena, id).integrity.clone()
}

// __dom.sheetIntegrity(owner) -> the integrity metadata of the owner's request of the sheet it obtains now.
fn sheet_integrity_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(owner) = crate::dom::nid_arg(scope, &args, 0) else { return };
    let cid = realm_id(scope, &args);
    let integrity = request_of(realm(scope, cid), owner).integrity.clone();
    rv.set(text_value(scope, &integrity));
}

// __dom.sheetEncodingOf(url) -> the encoding the realm's sheet at `url` decoded in, undefined for none.
fn sheet_encoding_of_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let url = args.get(0).to_rust_string_lossy(scope);
    let cid = realm_id(scope, &args);
    let Some(e) = encoding_of(realm(scope, cid), cid, &url) else { return };
    rv.set(text_value(scope, e));
}
// …that encoding (an `@import`'s environment: CSS Cascade 5 §2.2).
pub(crate) fn encoding_of(arena: &mut crate::dom::RealmArena, cid: i32, url: &str) -> Option<&'static str> {
    arena.realm_state_mut(cid).and_then(|s| s.sheet_fetches.encodings.get(url).copied())
}

// __dom.styleResolveImports([url, referrer, …], docNid, environment, host): the sheets the style engine's `@import`s
// wait for (`resolve_imports`).
fn resolve_imports_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Ok(host) = v8::Local::<v8::Function>::try_from(args.get(3)) else { return };
    let waiting = match v8::Local::<v8::Array>::try_from(args.get(0)) {
        Ok(list) => {
            let items: Vec<String> = (0..list.length()).filter_map(|i| list.get_index(scope, i)).map(|v| v.to_rust_string_lossy(scope)).collect();
            items.chunks_exact(2).map(|p| (p[0].clone(), Some(p[1].clone()).filter(|r| !r.is_empty()))).collect()
        },
        Err(_) => Vec::new(),
    };
    let doc = crate::dom::nid_arg(scope, &args, 1);
    let environment = args.get(2).is_string().then(|| args.get(2).to_rust_string_lossy(scope));
    let cid = realm_id(scope, &args);
    let _ = resolve_imports(scope, cid, host, waiting, doc, environment);
}
// The sheets the style engine's `@import`s wait for — `waiting` (url, referrer), each referred by the location of the
// sheet importing it (none its document's: a `<style>`'s, CSS Values 4 "fetch a style resource") — fetched and handed
// over until none is: each request fetched once however many sheets make it, its entry filed (`file_import`), decoded in
// the encoding of the sheet that imports it (CSS Cascade 5 §2.2: `environment` the first ones'), handed to the engine
// (dom.rs `style_import_in`). An import CYCLE would ask for ever, so a chain deeper than any real page nests is answered
// with nothing.
const IMPORT_DEPTH_LIMIT: usize = 16;
pub(crate) fn resolve_imports(
    scope: &mut v8::PinScope<'_, '_>,
    cid: i32,
    host: v8::Local<'_, v8::Function>,
    waiting: Vec<(String, Option<String>)>,
    doc: Option<NodeId>,
    environment: Option<String>,
) -> Result<(), Terminated> {
    type Request = (String, Option<String>);
    let quirks = crate::dom::dom(scope).arena.document_mode(doc).0;
    let mut fetched: HashMap<Request, (Option<String>, bool, String)> = HashMap::new();
    let push = |list: &mut Vec<(Request, Option<String>)>, request: Request, env: Option<String>| {
        if !list.iter().any(|(r, _)| *r == request) {
            list.push((request, env));
        }
    };
    let mut pending = Vec::new();
    for request in waiting {
        push(&mut pending, request, environment.clone());
    }
    for depth in 0.. {
        if pending.is_empty() {
            break;
        }
        let mut next = Vec::new();
        for ((url, referrer), env) in pending {
            let request = (url.clone(), referrer.clone());
            if !fetched.contains_key(&request) {
                let started = now(scope, host)?;
                let sheet = fetch(scope, cid, host, None, &url, env.as_deref(), referrer.as_deref())?;
                file_import(scope, host, &url, started, &sheet)?;
                fetched.insert(request.clone(), (sheet.text, sheet.clean, sheet.location));
            }
            let (text, clean, location) = &fetched[&request];
            let text = text.as_deref().filter(|_| depth < IMPORT_DEPTH_LIMIT);
            // (…none further where the engine's hand-over panicked: its exception what the op ends with)
            let mut children = None;
            crate::dom::style_op(scope, cid, |scope| children = Some(crate::dom::style_import_in(scope, cid, &url, referrer.as_deref(), text, quirks, *clean, location)));
            let Some(children) = children else { return Ok(()) };
            let encoding = encoding_of(realm(scope, cid), cid, &url);
            for child in children {
                push(&mut next, child, encoding.map(str::to_owned).or_else(|| env.clone()));
            }
        }
        pending = next;
    }
    Ok(())
}
// …an `@import`'s entry filed (performance.js `recordResourceTiming`): one fetch to the page however many rebuilds ask,
// as the memory cache makes it (resource_timing.rs `filed_once`) — none for a sheet no network, service worker or
// scheme's own processor answered (a preload's) — its facts the response's, a worker's answer's, or a body the asset
// cache kept no facts of.
fn file_import(scope: &mut v8::PinScope<'_, '_>, host: v8::Local<'_, v8::Function>, url: &str, started: f64, sheet: &Sheet) -> Result<(), Terminated> {
    use crate::fetch_rules::{fetch_route, ROUTE_BLOB, ROUTE_DATA};
    if !sheet.network && sheet.answer.is_none() && !matches!(fetch_route(url, 0, ""), ROUTE_DATA | ROUTE_BLOB) {
        return Ok(());
    }
    let entry = v8::Object::new(scope);
    let set = |scope: &mut v8::PinScope<'_, '_>, k: &str, v: v8::Local<'_, v8::Value>| {
        let k = text_value(scope, k);
        entry.set(scope, k, v);
    };
    let name = text_value(scope, url);
    set(scope, "name", name);
    let kind = v8::Integer::new_from_unsigned(scope, J_SHEET).into();
    set(scope, "kind", kind);
    let start = v8::Number::new(scope, started).into();
    set(scope, "startTime", start);
    match (&sheet.answer, &sheet.meta) {
        (Some(answer), _) => {
            let answer = v8::Local::new(scope, answer);
            set(scope, "answer", answer);
        },
        (None, Some(meta)) if v8::Local::new(scope, meta).is_object() => {
            let meta = v8::Local::new(scope, meta);
            set(scope, "resp", meta);
        },
        _ => {
            if let Some(text) = &sheet.text {
                let body = text_value(scope, text);
                set(scope, "body", body);
                let status = v8::Integer::new(scope, 200).into();
                set(scope, "status", status);
            }
        },
    }
    call(scope, host, H_FILE, &[entry.into()]).map(drop)
}

// __dom.sheetsForget(): the realm's own let go of as its page goes (cascade.js `resetCascadeState`) — its owners' go with
// them, a new page's owners new nodes.
fn sheets_forget_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    if let Some(s) = realm(scope, cid).realm_state_mut(cid) {
        s.sheet_fetches = RealmSheets::default();
    }
}
