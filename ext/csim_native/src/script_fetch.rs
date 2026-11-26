// The fetches of scripts a document's elements began as "prepare the script element" — an inserted script's, the parser's
// `async` and `defer` ones; a classic one's (subresource_obtain.rs `classic_script_begin`), a module script's graph's entry
// (`scriptFetchBeginModule`, its graph fetched as it runs, the entry's answer kept for it) — each in parallel, its network
// leg the host's (browser.rb `script_fetch_start`), and each landing as the event loop comes to it: as a task queued as it
// began, behind the tasks due with it (timers.rs `BEHIND`), a network's time away — which is its server's: what its
// sleeps came to (the request made as it begins, in the order the fetches begin, the host answering how long its server
// took), the task coming again that much later. The
// order the lists of HTML's scripts run them in is the bindings' (bridge.entry.js), each landing as its turn comes.

use crate::dom::{realm, realm_id, register, NodeId};
use crate::font_files::Terminated;
use crate::subresource_obtain::{call, classic_script_begin, classic_script_delay, classic_script_drop, classic_script_land, next_slot, slept_ms, ClassicFetch, ClassicRequest, Landed, H_SCRIPT_FORGET, H_SCRIPT_START, H_SCRIPT_TAKE};

// A realm's script fetches (`RealmState::script_fetches`), by number.
#[derive(Default)]
pub(crate) struct ScriptFetches {
    next: u32,
    list: Vec<ScriptFetch>,
}
// One of them: its element, the event loop's clock as it began, the time its network leg took, whether its task has come
// (`scriptFetchLanded`), and the fetch.
struct ScriptFetch {
    id: u32,
    el: NodeId,
    began: f64,
    delay: f64,
    landed: bool,
    fetch: Fetch,
}
// What it fetches: a classic script, or a module graph's entry — the host's (its slot's number), or answered from memory
// as it began.
enum Fetch {
    Classic(ClassicFetch),
    Module(Option<u32>),
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    register(scope, ns, "scriptFetchBegin", begin_op, context_id);
    register(scope, ns, "scriptFetchBeginModule", begin_module_op, context_id);
    register(scope, ns, "scriptFetchOf", of_op, context_id);
    register(scope, ns, "scriptFetchDue", due_op, context_id);
    register(scope, ns, "scriptFetchLanded", landed_op, context_id);
    register(scope, ns, "parserBegins", parser_begins_op, context_id);
    register(scope, ns, "parserInputScanned", parser_input_scanned_op, context_id);
}

// __dom.parserBegins() — the calling realm's document's parser begins: the fetches it begins as it scans ahead of what it
// parses — a browser's preload scanner, which fetches a page's scripts as its bytes come, before any of its scripts runs
// — land in turn as of now (timers.rs `SPECULATIVE`), ahead of what its scripts queue as the parse goes on, and as far
// after now as their servers took: begun now, whatever the parser waits on before it reaches their end tags (Chrome and
// Firefox: a deferred script after a parser-blocking one lands with it where their servers take as long, csim-bench r13
// `e_mix6`).
fn parser_begins_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    let arena = realm(scope, cid);
    let places = arena.event_loop.reserve_speculative();
    let clock = arena.event_loop.clock;
    if let Some(state) = arena.realm_state_mut(cid) {
        state.speculative = Some(places);
        state.parse_began_at = clock;
    }
}
// When a fetch the realm `cid` begins now began: one the parser's preload scanner saw (`scanned`: markup the parse took
// from the network, none a `document.write` wrote) as its parse did (`parserBegins`), any other now.
pub(crate) fn began_at(arena: &mut crate::dom::RealmArena, cid: i32, scanned: bool) -> f64 {
    let now = arena.event_loop.clock;
    match arena.realm_state(cid) {
        Some(state) if scanned && state.speculative.is_some() => state.parse_began_at.min(now),
        _ => now,
    }
}

// …and whether a fetch the calling realm's document's parser begins now is one a preload scanner saw: of markup the
// parse took from the network, none a script wrote (html_parse.rs `Parse::written`) — none where no parser is active.
pub(crate) fn parser_input_scanned(scope: &mut v8::PinScope<'_, '_>, cid: i32) -> bool {
    let Some(doc) = realm(scope, cid).realm_document(cid) else { return false };
    let parser = crate::dom::dom(scope).arena.document_states.markup(doc).parser;
    let active = crate::html_parse::active_parser(scope, doc, parser);
    active.live && !active.written
}
// __dom.parserInputScanned() -> `parser_input_scanned` of the calling realm.
fn parser_input_scanned_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    rv.set_bool(parser_input_scanned(scope, cid));
}

fn fetches_of<'s>(scope: &'s mut v8::PinScope<'_, '_>, cid: i32) -> Option<&'s mut ScriptFetches> {
    realm(scope, cid).realm_state_mut(cid).map(|s| &mut s.script_fetches)
}
fn find(fetches: &mut ScriptFetches, id: u32) -> Option<&mut ScriptFetch> {
    fetches.list.iter_mut().find(|f| f.id == id)
}
fn take(scope: &mut v8::PinScope<'_, '_>, cid: i32, id: u32) -> Option<ScriptFetch> {
    let fetches = fetches_of(scope, cid)?;
    let at = fetches.list.iter().position(|f| f.id == id)?;
    Some(fetches.list.remove(at))
}

// __dom.scriptFetchBegin(el, doc, src, parser, host, scanned) -> the number of the fetch of the classic script `el` begun
// (`classic_script_begin`) for its preparation-time document `doc` from `src` (resolved; null where it does not resolve,
// the raw attribute its URL then), the parser's or not (`parser`), its request as the element is now
// (`ClassicRequest::of_element`), 0 where none began — one the parser's preload scanner saw, `scanned`, begun as its parse
// did (`began_at`).
fn begin_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    rv.set_uint32(0);
    let (Some(el), Some(doc)) = (crate::dom::nid_arg(scope, &args, 0), crate::dom::nid_arg(scope, &args, 1)) else { return };
    let src = args.get(2).is_string().then(|| args.get(2).to_rust_string_lossy(scope));
    let parser = args.get(3).is_true();
    let Ok(host) = v8::Local::<v8::Function>::try_from(args.get(4)) else { return };
    let cid = realm_id(scope, &args);
    let request = ClassicRequest::of_element(realm(scope, cid), el, doc, src, parser);
    rv.set_uint32(begin_classic(scope, cid, host, request, args.get(5).is_true()).unwrap_or(0));
}
// …the fetch of `request` begun, its number — dated as its parse began where a preload scanner saw it (`scanned`).
pub(crate) fn begin_classic(scope: &mut v8::PinScope<'_, '_>, cid: i32, host: v8::Local<'_, v8::Function>, mut request: ClassicRequest, scanned: bool) -> Result<u32, Terminated> {
    let el = request.el;
    let began = began_at(realm(scope, cid), cid, scanned);
    request.began = Some(began);
    let fetch = classic_script_begin(scope, cid, host, request)?;
    let delay = classic_script_delay(&fetch);
    Ok(file(scope, cid, el, (began, delay), Fetch::Classic(fetch)))
}
fn file(scope: &mut v8::PinScope<'_, '_>, cid: i32, el: NodeId, (began, delay): (f64, f64), fetch: Fetch) -> u32 {
    let Some(fetches) = fetches_of(scope, cid) else { return 0 };
    fetches.next += 1;
    let id = fetches.next;
    fetches.list.push(ScriptFetch { id, el, began, delay, landed: false, fetch });
    id
}

// __dom.scriptFetchBeginModule(el, url, host, plan, scanned) -> the number of the fetch of the module script `el`'s graph's
// entry `url` (resolved), its request the engine's `plan` of it — a CORS one — begun through the asset cache (browser.rb
// `script_fetch_start`), whose document's module map answers the graph's fetch of it as the script runs; `url` null, one
// the host makes nothing of, landing at once (a service worker's to answer as its graph runs, a scheme's, none); 0 where
// none began.
fn begin_module_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(el) = crate::dom::nid_arg(scope, &args, 0) else { return rv.set_uint32(0) };
    let Ok(host) = v8::Local::<v8::Function>::try_from(args.get(2)) else { return rv.set_uint32(0) };
    let cid = realm_id(scope, &args);
    let arena = realm(scope, cid);
    let (began, client) = (began_at(arena, cid, args.get(4).is_true()), arena.get(el).map(|n| n.realm));
    let client = match client {
        Some(realm) => v8::Integer::new(scope, realm).into(),
        None => v8::undefined(scope).into(),
    };
    let (slot, delay) = if args.get(1).is_string() {
        let id = next_slot();
        let start = [
            args.get(1),
            args.get(3),
            v8::null(scope).into(),
            client,
            v8::Integer::new(scope, 2).into(),
            v8::Number::new(scope, began).into(),
            v8::Integer::new_from_unsigned(scope, id).into()
        ];
        let Ok(started) = call(scope, host, H_SCRIPT_START, &start) else { return };
        match started.map(|s| v8::Local::new(scope, s)).filter(|s| s.is_number()) {
            Some(slept) => (Some(id), slept_ms(scope, slept)),
            None => (None, 0.0),
        }
    } else {
        (None, 0.0)
    };
    rv.set_uint32(file(scope, cid, el, (began, delay), Fetch::Module(slot)));
}

// __dom.scriptFetchOf(el) -> the number of the fetch the script `el` began and has not landed, 0 for none — the parser's
// `async` or `defer` one's, begun at its end tag, which "the end" runs.
fn of_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let el = crate::dom::nid_arg(scope, &args, 0);
    let cid = realm_id(scope, &args);
    rv.set_uint32(el.map_or(0, |el| fetch_of(scope, cid, el)));
}
pub(crate) fn fetch_of(scope: &mut v8::PinScope<'_, '_>, cid: i32, el: NodeId) -> u32 {
    fetches_of(scope, cid).and_then(|f| f.list.iter().rev().find(|f| f.el == el).map(|f| f.id)).unwrap_or(0)
}

// How long after now the fetch `id` of realm `cid` lands — its network leg's time, past the clock as it began — none for a
// fetch it has no more.
pub(crate) fn due_in(scope: &mut v8::PinScope<'_, '_>, cid: i32, id: u32) -> Option<f64> {
    let clock = realm(scope, cid).event_loop.clock;
    let f = fetches_of(scope, cid).and_then(|f| find(f, id))?;
    // (…none left of it within a nanosecond: the clock a server's time moved on to in steps, Browser#server_slept_ms)
    Some(Some(f.began + f.delay - clock).filter(|due| *due > 1e-6).unwrap_or(0.0))
}
// …whether that is now: the fetch landed by the event loop's clock, or none of the realm's (one that answered at once).
pub(crate) fn due_now(scope: &mut v8::PinScope<'_, '_>, cid: i32, el: NodeId) -> bool {
    let id = fetches_of(scope, cid).and_then(|f| f.list.iter().rev().find(|f| f.el == el).map(|f| f.id));
    id.is_none_or(|id| due_in(scope, cid, id).is_none_or(|due| due <= 0.0))
}

// __dom.scriptFetchDue(id) -> how many milliseconds after now the fetch `id` lands (`due_in`), -1 for none.
fn due_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let id = args.get(0).uint32_value(scope).unwrap_or(0);
    let cid = realm_id(scope, &args);
    rv.set_double(due_in(scope, cid, id).unwrap_or(-1.0));
}

// __dom.scriptFetchLanded(id, landed) -> whether the fetch `id`'s task has come — true for one it has no more — marked so,
// `landed`.
fn landed_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let id = args.get(0).uint32_value(scope).unwrap_or(0);
    let mark = args.get(1).is_true();
    let cid = realm_id(scope, &args);
    rv.set_bool(landed(scope, cid, id, mark));
}
pub(crate) fn landed(scope: &mut v8::PinScope<'_, '_>, cid: i32, id: u32, mark: bool) -> bool {
    let Some(f) = fetches_of(scope, cid).and_then(|f| find(f, id)) else { return true };
    f.landed |= mark;
    f.landed
}

// What a fetch landed as: a classic script's response, or a module graph's entry's, which its document's module map keeps.
pub(crate) enum Fetched {
    Classic(Landed),
    Module,
}
// The fetch `id` of realm `cid` landed — taken — none for one it has no more.
pub(crate) fn land(scope: &mut v8::PinScope<'_, '_>, cid: i32, id: u32, host: v8::Local<'_, v8::Function>) -> Result<Option<Fetched>, Terminated> {
    let Some(f) = take(scope, cid, id) else { return Ok(None) };
    Ok(Some(match f.fetch {
        Fetch::Classic(fetch) => Fetched::Classic(classic_script_land(scope, cid, host, fetch)?),
        Fetch::Module(slot) => {
            if let Some(id) = slot {
                let id = v8::Integer::new_from_unsigned(scope, id).into();
                call(scope, host, H_SCRIPT_TAKE, &[id])?;
            }
            Fetched::Module
        }
    }))
}

// The fetch `id` cancelled: its answer let go of (`classic_script_drop`).
pub(crate) fn drop_fetch(scope: &mut v8::PinScope<'_, '_>, cid: i32, id: u32, host: v8::Local<'_, v8::Function>) -> Result<(), Terminated> {
    match take(scope, cid, id).map(|f| f.fetch) {
        Some(Fetch::Classic(fetch)) => classic_script_drop(scope, host, fetch),
        Some(Fetch::Module(Some(slot))) => {
            let slot = v8::Integer::new_from_unsigned(scope, slot).into();
            call(scope, host, H_SCRIPT_FORGET, &[slot]).map(|_| ())
        }
        _ => Ok(()),
    }
}
