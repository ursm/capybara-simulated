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
    // (…and whether its link's load task has processed it yet — HTML "process the linked resource" makes its sheet, which
    // nothing reads before: `sheetFetchLand` — and whether the cascade was handed none for it as it waited, which it is to be
    // handed again)
    pub(crate) processed: bool,
    pub(crate) read_unprocessed: bool,
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
    // …and an `@import`'s fetch under way, by request — `"{plan & PLAN_REQUEST} {url}"` — whoever's sheet asked for it
    // first (`resolve_imports`): its slot, and when its response comes in on the clock.
    import_flights: HashMap<String, (u32, f64)>,
    // …and the `@import` tree of an owner's sheet as it was last made, which its load waits for (`sheetImportsDue`).
    trees: HashMap<NodeId, ImportTree>,
    encodings: HashMap<String, &'static str>,
    answers: HashMap<String, Option<v8::Global<v8::Value>>>,
    blob_texts: HashMap<String, Option<String>>,
}

// The `@import`s a sheet owner's sheet `made` (its id and rev, sheet_feed.rs `make`) asked for, its whole tree as far as
// it is known: those still under way, handed to the style engine — their rules applied — only as its owner's load task
// lands them (`sheetImportsLand`), each level's own then asked for in turn; when the last of them comes in, at the latest
// of their wptserve `trickle`s; whether one failed. In a document of mode `quirks`; none `made`, a CSSOM rule's or an
// `<?xml-stylesheet?>`'s, handed over at once.
pub(crate) struct ImportTree {
    made: Option<(u32, u32)>,
    quirks: bool,
    under_way: Vec<Import>,
    due_at: f64,
    trickle: f64,
    failed: bool,
}
// …one of them: its request (url, referrer) — its key, where its fetch is a flight of its own — the environment it is
// decoded in, how deep in the tree it is, and when the sheet importing it came in, which its fetch is dated by.
struct Import {
    url: String,
    referrer: Option<String>,
    key: Option<String>,
    env: Option<String>,
    depth: usize,
    since: f64,
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    register(scope, ns, "sheetIntegrity", sheet_integrity_op, context_id);
    register(scope, ns, "sheetEncodingOf", sheet_encoding_of_op, context_id);
    register(scope, ns, "sheetsForget", sheets_forget_op, context_id);
    register(scope, ns, "styleResolveImports", resolve_imports_op, context_id);
    register(scope, ns, "sheetFetchBegin", fetch_begin_op, context_id);
    register(scope, ns, "sheetFetchLand", fetch_land_op, context_id);
    register(scope, ns, "sheetFetchesAbort", fetches_abort_op, context_id);
    register(scope, ns, "sheetImportsLand", imports_land_op, context_id);
    register(scope, ns, "sheetImportsForget", imports_forget_op, context_id);
}

// __dom.sheetFetchBegin(owner, url, plan, scanned, host) -> how many ms after now the response of the `<link>` `owner`'s
// style sheet at `url` comes in, its request `plan`: HTML "fetch and process the linked resource" begun as the link is
// connected, in parallel — the host's slot (browser.rb `script_fetch_start`, the asset cache's flight for its document,
// which its load task takes: `sheetFetchLand`), its server's sleeps counted as the request is made — one
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
    // (…the one under way, where its link asks again for the request it made: what is left of it)
    let key = format!("{} {url}", plan & PLAN_REQUEST);
    let arena = realm(scope, cid);
    let clock = arena.event_loop.clock;
    if let Some((_, k, due_at)) = arena.realm_state(cid).and_then(|s| s.sheet_fetches.flights.get(&el)) {
        if *k == key {
            return Ok((due_at - clock).max(0.0));
        }
    }
    forget_flight(scope, cid, host, el)?;
    // (…none where its response is in at once — a scheme's (sheet_feed.rs `fetched_sheet` reads one at once), its sheet's
    // answer kept, a preload's, the asset cache's: its sheet processed as it begins, its `load` its task's still — as
    // Chrome and Firefox expose a sheet the memory cache holds before the script after it runs (WPT
    // css/cssom/HTMLLinkElement-load-event.html))
    if crate::fetch_rules::fetch_route(url, 0, "") != crate::fetch_rules::ROUTE_NETWORK {
        return Ok(0.0);
    }
    if realm(scope, cid).sheet_requests.get(&el).and_then(|r| r.answered.as_ref()).is_some_and(|(k, _)| *k == key) {
        return Ok(processed_now(realm(scope, cid), cid, el));
    }
    let doc = crate::node_handle::node_document_of(scope, el);
    if owner_preload(scope, cid, host, Owner { id: el, doc }, url, plan)?.is_some() {
        return Ok(processed_now(realm(scope, cid), cid, el));
    }
    if call(scope, host, H_CONTROLLER, &[])?.is_some_and(|c| v8::Local::new(scope, c).uint32_value(scope).unwrap_or(0) != 0) {
        return Ok(0.0);
    }
    let began = crate::script_fetch::began_at(realm(scope, cid), cid, scanned);
    match begin_flight(scope, cid, host, Some(el), url, plan, None, began)? {
        Flight::Slot(id, due) => {
            if let Some(s) = realm(scope, cid).realm_state_mut(cid) {
                s.sheet_fetches.flights.insert(el, (id, key, clock + due));
            }
            Ok(due)
        }
        Flight::Answered(answer) => {
            let answer = v8::Local::new(scope, answer);
            keep_answer(scope, cid, el, url, plan, answer);
            Ok(processed_now(realm(scope, cid), cid, el))
        }
        Flight::None => Ok(0.0),
    }
}
// …the owner's sheet processed from now (sheet_feed.rs `fetched_sheet`) — the cascade made stale for it where it was
// handed without it, its key the same (one never handed it since it was connected is stale already, its key moved).
fn processed_now(arena: &mut crate::dom::RealmArena, cid: i32, el: NodeId) -> f64 {
    let request = request_of(arena, el);
    request.processed = true;
    if std::mem::take(&mut request.read_unprocessed) {
        arena.stale_cascade(cid, true);
    }
    0.0
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
// counted as it is made, dated as it `began` on the clock — a preload scanner's as its parse began, an `@import`'s as the
// sheet that imports it came in — referred by `referrer` where it names one of its own (an `@import`'s, the location of
// the sheet importing it).
#[allow(clippy::too_many_arguments)]
fn begin_flight(scope: &mut v8::PinScope<'_, '_>, cid: i32, host: v8::Local<'_, v8::Function>, el: Option<NodeId>, url: &str, plan: u32, referrer: Option<&str>, began: f64) -> Result<Flight, Terminated> {
    use crate::subresource_obtain::{next_slot, slept_ms, H_SCRIPT_START};
    let arena = realm(scope, cid);
    let clock = arena.event_loop.clock;
    let client = match el.and_then(|el| arena.get(el)).map(|n| n.realm) {
        Some(c) => v8::Integer::new(scope, c).into(),
        None => v8::undefined(scope).into(),
    };
    let id = next_slot();
    let referrer = match referrer {
        Some(r) => text_value(scope, r),
        None => v8::null(scope).into(),
    };
    let args = [
        text_value(scope, url),
        v8::Integer::new_from_unsigned(scope, plan).into(),
        referrer,
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

// What became of an owner's `@import` tree as its load task runs (`sheetImportsLand`), where all of it is in: it loaded;
// one failed — a network error, a status not ok, a type not text/css — its owner's `error` (HTML "update a style block"
// and the link's "process the linked resource": its critical subresources failed to obtain, Chrome and Firefox `serr`,
// rv-sh-probe `q11_import_fail`); its document's abort cancelled what was under way.
const IMPORTS_LOADED: f64 = -1.0;
const IMPORTS_FAILED: f64 = -2.0;
const IMPORTS_CANCELLED: f64 = -3.0;
// __dom.sheetImportsLand(owner, host) -> how many ms after now the owner's load task is to run again, for the next level of
// its `@import` tree — or, all of it in, what became of it (`IMPORTS_*`): the ones under way landed as it runs — their
// slots taken (the document's asset memo, their cookies) — and handed to the style engine, their own `@import`s asked for
// and fetched in parallel, dated as their sheets came in (`hand_over`).
fn imports_land_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    rv.set_double(IMPORTS_LOADED);
    let Some(el) = crate::dom::nid_arg(scope, &args, 0) else { return };
    let Ok(host) = v8::Local::<v8::Function>::try_from(args.get(1)) else { return };
    let cid = realm_id(scope, &args);
    let Some(state) = realm(scope, cid).realm_state_mut(cid) else { return };
    if state.sheet_fetches.cancelled.remove(&el) {
        state.sheet_fetches.trees.remove(&el);
        return rv.set_double(IMPORTS_CANCELLED);
    }
    let Some(mut tree) = state.sheet_fetches.trees.remove(&el) else { return };
    let landed = std::mem::take(&mut tree.under_way);
    if hand_over(scope, cid, host, landed, true, &mut tree).is_err() {
        return;
    }
    let arena = realm(scope, cid);
    let clock = arena.event_loop.clock;
    let (next, failed) = (!tree.under_way.is_empty()).then(|| (tree.due_at - clock).max(0.0)).map_or((None, tree.failed), |d| (Some(d), false));
    if next.is_some() {
        if let Some(s) = arena.realm_state_mut(cid) {
            s.sheet_fetches.trees.insert(el, tree);
        }
    }
    rv.set_double(next.unwrap_or(if failed { IMPORTS_FAILED } else { IMPORTS_LOADED }));
}
// __dom.sheetImportsForget(owner) — the `@import` tree of the owner's sheet let go of: its sheet was made again of a block
// that imports nothing, which its connection asks nothing of (bridge.entry.js `maybeFireStyleLoad`).
fn imports_forget_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(el) = crate::dom::nid_arg(scope, &args, 0) else { return };
    let cid = realm_id(scope, &args);
    if let Some(s) = realm(scope, cid).realm_state_mut(cid) {
        s.sheet_fetches.trees.remove(&el);
        s.sheet_fetches.cancelled.remove(&el);
    }
}
// …how many ms after now the owner's load task is to run for its `@import` tree — the sheet `made` — -1 where it has none
// (sheet_feed.rs `sheetImportsDue`).
pub(crate) fn imports_due(arena: &mut crate::dom::RealmArena, cid: i32, el: NodeId, made: (u32, u32)) -> f64 {
    let clock = arena.event_loop.clock;
    let Some(tree) = arena.realm_state(cid).and_then(|s| s.sheet_fetches.trees.get(&el)).filter(|t| t.made == Some(made)) else { return -1.0 };
    (tree.due_at - clock).max(tree.trickle).max(0.0)
}
// What became of a `<link>`'s fetch as its load task runs (`sheetFetchLand`): none was begun (its load obtains its sheet as
// it is); it landed; its document's abort cancelled it — a network error.
const FLIGHT_NONE: u32 = 0;
const FLIGHT_LANDED: u32 = 1;
const FLIGHT_CANCELLED: u32 = 2;
// __dom.sheetFetchLand(owner, host, url, plan) -> what became of the `<link>` `owner`'s fetch begun as it was connected
// (`FLIGHT_*`): its slot taken as its load task runs — its response the document's asset memo's, its cookies stored —
// and its sheet processed from here, the cascade's and `.sheet`'s to read (sheet_feed.rs `fetched_sheet`).
fn fetch_land_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    rv.set_uint32(FLIGHT_NONE);
    let Some(el) = crate::dom::nid_arg(scope, &args, 0) else { return };
    let Ok(host) = v8::Local::<v8::Function>::try_from(args.get(1)) else { return };
    let cid = realm_id(scope, &args);
    let arena = realm(scope, cid);
    let cancelled = arena.realm_state_mut(cid).is_some_and(|s| s.sheet_fetches.cancelled.remove(&el));
    processed_now(arena, cid, el);
    request_of(arena, el).made_none |= cancelled;
    if cancelled {
        return rv.set_uint32(FLIGHT_CANCELLED);
    }
    let Some((id, _, _)) = arena.realm_state_mut(cid).and_then(|s| s.sheet_fetches.flights.remove(&el)) else { return };
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
// __dom.sheetFetchesAbort(host) -> the sheet owners whose fetches the calling realm's document's abort cancels (HTML "abort
// a document": "cancel any instances of the fetch algorithm") — a `<link>`'s own, a `<style>`'s or a `<link>`'s
// `@import`s — their slots let go of: each a network error, its load task to run at once (bridge.entry.js
// `wakeSheetLoads`).
fn fetches_abort_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Ok(host) = v8::Local::<v8::Function>::try_from(args.get(0)) else { return };
    let cid = realm_id(scope, &args);
    let Some(state) = realm(scope, cid).realm_state_mut(cid) else { return };
    let fetches = &mut state.sheet_fetches;
    let mut owners: Vec<NodeId> = fetches.flights.keys().copied().collect();
    let mut slots: Vec<u32> = fetches.flights.drain().map(|(_, (id, _, _))| id).collect();
    // (…and the owners whose `@import` tree has a fetch under way: their load tasks' to fire `error`, rv-sh-probe
    // `q16_stop_style_import`, Firefox `stopped serr lerr`)
    owners.extend(fetches.trees.iter().filter(|(_, t)| t.under_way.iter().any(|i| i.key.as_ref().is_some_and(|k| fetches.import_flights.contains_key(k)))).map(|(&el, _)| el));
    slots.extend(fetches.import_flights.drain().map(|(_, (id, _))| id));
    fetches.cancelled.extend(owners.iter().copied());
    for id in slots {
        let id = v8::Integer::new_from_unsigned(scope, id).into();
        if call(scope, host, crate::subresource_obtain::H_SCRIPT_FORGET, &[id]).is_err() {
            return;
        }
    }
    // (…in tree order, the order their errors come in)
    let arena = realm(scope, cid);
    owners.sort_by(|&a, &b| arena.tree_order(a, b).unwrap_or(std::cmp::Ordering::Equal));
    owners.dedup();
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
    let client = match owner.and_then(|o| realm(scope, cid).get(o.id).map(|n| n.realm)) {
        Some(c) => v8::Integer::new(scope, c).into(),
        None => v8::undefined(scope).into(),
    };
    let r = match referrer {
        Some(r) => text_value(scope, r),
        None => v8::null(scope).into(),
    };
    // (…a fetch of it under way joined for its answer, none of what is left of its server's time waited out: that is its
    // owner's load's to wait for, never the cascade's, which a sleep run on the event loop would let any task in under —
    // Chrome and Firefox `inl dcl a.js-ran t50 st load`, rv-r13-probe `s5_stylemedia`)
    let (module, since, waits) = (v8::Boolean::new(scope, false).into(), v8::undefined(scope).into(), v8::Boolean::new(scope, false).into());
    let args = [text_value(scope, url), v8::Integer::new_from_unsigned(scope, plan).into(), r, client, module, since, waits];
    let response = call(scope, host, H_ASSET, &args)?;
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
    let _ = resolve_imports(scope, cid, host, waiting, doc, environment, None);
}
// The sheets the style engine's `@import`s wait for — `waiting` (url, referrer), each referred by the location of the
// sheet importing it (none its document's: a `<style>`'s, CSS Values 4 "fetch a style resource") — fetched and handed
// over until none is: each request fetched once however many sheets make it, its entry filed (`file_import`), decoded in
// the encoding of the sheet that imports it (CSS Cascade 5 §2.2: `environment` the first ones'), handed to the engine
// (dom.rs `style_import_in`). An import CYCLE would ask for ever, so a chain deeper than any real page nests is answered
// with nothing.
// Each is fetched in parallel (`begin_import`), dated as the sheet importing it came in; one of the sheet `made` of
// `owner`, a `<style>`'s or a `<link>`'s, is handed over as its owner's load task lands it — its rules none before, nor
// its Resource Timing entry — however soon its response came in (`ImportTree`, `sheetImportsLand`): Chrome and Firefox,
// rv-sh-probe `q12_link_import_gcs`, `q14_nested_import`. A CSSOM rule's, an `<?xml-stylesheet?>`'s, have no load task:
// theirs at once.
const IMPORT_DEPTH_LIMIT: usize = 16;
#[allow(clippy::too_many_arguments)]
pub(crate) fn resolve_imports(
    scope: &mut v8::PinScope<'_, '_>,
    cid: i32,
    host: v8::Local<'_, v8::Function>,
    waiting: Vec<(String, Option<String>)>,
    doc: Option<NodeId>,
    environment: Option<String>,
    owner: Option<(NodeId, (u32, u32))>,
) -> Result<(), Terminated> {
    if waiting.is_empty() {
        if let (Some((el, _)), Some(s)) = (owner, realm(scope, cid).realm_state_mut(cid)) {
            s.sheet_fetches.trees.remove(&el);
        }
        return Ok(());
    }
    let arena = realm(scope, cid);
    let quirks = arena.document_mode(doc).0;
    let now_at = crate::script_fetch::began_at(arena, cid, false);
    let mut tree = ImportTree { made: owner.map(|(_, made)| made), quirks, under_way: Vec::new(), due_at: now_at, trickle: 0.0, failed: false };
    let imports = waiting.into_iter().map(|(url, referrer)| Import { url, referrer, key: None, env: environment.clone(), depth: 0, since: now_at }).collect();
    let Some((el, _)) = owner else {
        return hand_over(scope, cid, host, imports, false, &mut tree);
    };
    hand_over(scope, cid, host, imports, false, &mut tree)?;
    if let Some(s) = realm(scope, cid).realm_state_mut(cid) {
        s.sheet_fetches.trees.insert(el, tree);
    }
    Ok(())
}
// …`imports` fetched and handed over, level by level — or, where the tree is an owner's sheet's (`made`), begun and left
// in `tree`'s `under_way` for its load task: the ones it lands (`landing`) handed over, their own begun and left.
fn hand_over(scope: &mut v8::PinScope<'_, '_>, cid: i32, host: v8::Local<'_, v8::Function>, imports: Vec<Import>, landing: bool, tree: &mut ImportTree) -> Result<(), Terminated> {
    type Request = (String, Option<String>);
    let owned = tree.made.is_some();
    let controlled = call(scope, host, H_CONTROLLER, &[])?.is_some_and(|c| v8::Local::new(scope, c).uint32_value(scope).unwrap_or(0) != 0);
    let mut fetched: HashMap<Request, (Option<String>, bool, String, f64)> = HashMap::new();
    let mut pending = imports;
    let mut defer = owned && !landing;
    while !pending.is_empty() {
        let mut next: Vec<Import> = Vec::new();
        for mut import in pending {
            let request = (import.url.clone(), import.referrer.clone());
            if !fetched.contains_key(&request) {
                let arrives = if controlled { import.since } else { begin_import(scope, cid, host, &mut import)? };
                tree.due_at = tree.due_at.max(arrives);
                tree.trickle = tree.trickle.max(crate::url_ops::trickle_delay_ms(&import.url));
                if defer {
                    tree.under_way.push(import);
                    continue;
                }
                let started = now(scope, host)?;
                let sheet = fetch(scope, cid, host, None, &import.url, import.env.as_deref(), import.referrer.as_deref())?;
                file_import(scope, host, &import.url, started, &sheet)?;
                tree.failed |= sheet.text.is_none();
                fetched.insert(request.clone(), (sheet.text, sheet.clean, sheet.location, arrives));
            }
            let (text, clean, location, arrives) = &fetched[&request];
            let text = text.as_deref().filter(|_| import.depth < IMPORT_DEPTH_LIMIT);
            // (…none further where the engine's hand-over panicked: its exception what the op ends with)
            let mut children = None;
            let (url, referrer) = (&import.url, import.referrer.as_deref());
            crate::dom::style_op(scope, cid, |scope| children = Some(crate::dom::style_import_in(scope, cid, url, referrer, text, tree.quirks, *clean, location)));
            let Some(children) = children else { return Ok(()) };
            let encoding = encoding_of(realm(scope, cid), cid, url).map(str::to_owned).or_else(|| import.env.clone());
            for (url, referrer) in children {
                if !next.iter().any(|i| i.url == url && i.referrer == referrer) {
                    next.push(Import { url, referrer, key: None, env: encoding.clone(), depth: import.depth + 1, since: *arrives });
                }
            }
        }
        pending = next;
        defer = owned;
    }
    Ok(())
}
// …an `@import`'s fetch begun in parallel where none of its request is under way — the host's slot, dated as the sheet
// importing it came in — or joined: when its response comes in on the clock. One whose response is in is taken as it is
// (its slot's answer the document's asset memo's, which its fetch then reads), nothing left of it to wait for.
fn begin_import(scope: &mut v8::PinScope<'_, '_>, cid: i32, host: v8::Local<'_, v8::Function>, import: &mut Import) -> Result<f64, Terminated> {
    let clock = realm(scope, cid).event_loop.clock;
    if crate::fetch_rules::fetch_route(&import.url, 0, "") != crate::fetch_rules::ROUTE_NETWORK {
        return Ok(clock);
    }
    let plan = sheet_plan(scope, cid, None, import.referrer.as_deref());
    let key = format!("{} {}", plan & PLAN_REQUEST, import.url);
    let flight = realm(scope, cid).realm_state(cid).and_then(|s| s.sheet_fetches.import_flights.get(&key)).copied();
    let (id, due_at) = match flight {
        Some(flight) => flight,
        None => match begin_flight(scope, cid, host, None, &import.url, plan, import.referrer.as_deref(), import.since)? {
            Flight::Slot(id, due) => (id, clock + due),
            Flight::Answered(_) | Flight::None => return Ok(clock),
        },
    };
    if due_at > clock {
        if let Some(s) = realm(scope, cid).realm_state_mut(cid) {
            s.sheet_fetches.import_flights.insert(key.clone(), (id, due_at));
        }
        import.key = Some(key);
        return Ok(due_at);
    }
    if let Some(s) = realm(scope, cid).realm_state_mut(cid) {
        s.sheet_fetches.import_flights.remove(&key);
    }
    let id = v8::Integer::new_from_unsigned(scope, id).into();
    call(scope, host, crate::subresource_obtain::H_SCRIPT_TAKE, &[id])?;
    Ok(clock)
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
