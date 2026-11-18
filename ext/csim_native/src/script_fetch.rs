// The fetches of classic scripts a document's elements began as "prepare the script element" — an inserted script's, the
// parser's `async` and `defer` ones — each in parallel, its network leg the host's (subresource_obtain.rs
// `classic_script_begin`), and each landing as the event loop comes to it: as a task queued as it began, behind the tasks
// due with it (timers.rs `BEHIND`), a network's time away — which is its server's: what its sleeps came to (browser.rb
// `script_fetch_wait`, the fetch made as the task first asks, in the event loop's order), the task coming again that much
// later. The
// order the lists of HTML's scripts run them in is the bindings' (bridge.entry.js), each landing as its turn comes.

use crate::dom::{realm, realm_id, register, NodeId};
use crate::font_files::Terminated;
use crate::subresource_obtain::{classic_request, classic_script_begin, classic_script_delay, classic_script_drop, classic_script_land, landed_value, ClassicFetch};

// A realm's script fetches (`RealmState::script_fetches`), by number.
#[derive(Default)]
pub(crate) struct ScriptFetches {
    next: u32,
    list: Vec<ScriptFetch>,
}
// One of them: its element, the event loop's clock as it began, the time its network leg took once known, whether its
// task has come (`scriptFetchLanded`), and the fetch.
struct ScriptFetch {
    id: u32,
    el: NodeId,
    began: f64,
    delay: Option<f64>,
    landed: bool,
    fetch: ClassicFetch,
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    register(scope, ns, "scriptFetchBegin", begin_op, context_id);
    register(scope, ns, "scriptFetchOf", of_op, context_id);
    register(scope, ns, "scriptFetchDue", due_op, context_id);
    register(scope, ns, "scriptFetchLanded", landed_op, context_id);
    register(scope, ns, "scriptFetchLand", land_op, context_id);
    register(scope, ns, "scriptFetchDrop", drop_op, context_id);
    register(scope, ns, "parserBegins", parser_begins_op, context_id);
}

// __dom.parserBegins() — the calling realm's document's parser begins: the fetches it begins as it scans ahead of what it
// parses — a browser's preload scanner, which fetches a page's scripts as its bytes come, before any of its scripts runs
// — land in turn as of now (timers.rs `SPECULATIVE`), ahead of what its scripts queue as the parse goes on.
fn parser_begins_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    let arena = realm(scope, cid);
    let places = arena.event_loop.reserve_speculative();
    if let Some(state) = arena.realm_state_mut(cid) {
        state.speculative = Some(places);
    }
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

// __dom.scriptFetchBegin(el, doc, src, parser, host, plan, integrity) -> the number of the fetch of the classic script `el`
// begun (`classic_script_begin`, its arguments `fetchClassicScript`'s), 0 where none began.
fn begin_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Ok(host) = v8::Local::<v8::Function>::try_from(args.get(4)) else { return rv.set_uint32(0) };
    let Some(request) = classic_request(scope, &args) else { return rv.set_uint32(0) };
    let cid = realm_id(scope, &args);
    let el = request.el;
    let began = realm(scope, cid).event_loop.clock;
    let Ok(fetch) = classic_script_begin(scope, cid, host, request, true) else { return rv.set_uint32(0) };
    let Some(fetches) = fetches_of(scope, cid) else { return rv.set_uint32(0) };
    fetches.next += 1;
    let id = fetches.next;
    fetches.list.push(ScriptFetch { id, el, began, delay: None, landed: false, fetch });
    rv.set_uint32(id);
}

// __dom.scriptFetchOf(el) -> the number of the fetch the script `el` began and has not landed, 0 for none — the parser's
// `async` or `defer` one's, begun at its end tag, which "the end" runs.
fn of_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let el = crate::dom::nid_arg(scope, &args, 0);
    let cid = realm_id(scope, &args);
    let id = el.and_then(|el| fetches_of(scope, cid).and_then(|f| f.list.iter().rev().find(|f| f.el == el).map(|f| f.id)));
    rv.set_uint32(id.unwrap_or(0));
}

// How long after now the fetch `id` of realm `cid` lands — its network leg's time, past the clock as it began, waited for
// where it is not yet known — none for a fetch it has no more.
pub(crate) fn due_in(scope: &mut v8::PinScope<'_, '_>, cid: i32, id: u32, host: v8::Local<'_, v8::Function>) -> Result<Option<f64>, Terminated> {
    let Some(mut f) = take(scope, cid, id) else { return Ok(None) };
    let delay = match f.delay {
        Some(d) => d,
        None => {
            let d = classic_script_delay(scope, host, &f.fetch);
            let d = match d {
                Ok(d) => d,
                Err(t) => {
                    put_back(scope, cid, f);
                    return Err(t);
                }
            };
            f.delay = Some(d);
            d
        }
    };
    let due = (f.began + delay - realm(scope, cid).event_loop.clock).max(0.0);
    put_back(scope, cid, f);
    Ok(Some(due))
}
fn put_back(scope: &mut v8::PinScope<'_, '_>, cid: i32, f: ScriptFetch) {
    if let Some(fetches) = fetches_of(scope, cid) {
        fetches.list.push(f);
    }
}
// …whether that is now: the fetch landed by the event loop's clock, or none of the realm's (one that answered at once).
pub(crate) fn due_now(scope: &mut v8::PinScope<'_, '_>, cid: i32, el: NodeId, host: v8::Local<'_, v8::Function>) -> Result<bool, Terminated> {
    let id = fetches_of(scope, cid).and_then(|f| f.list.iter().rev().find(|f| f.el == el).map(|f| f.id));
    let Some(id) = id else { return Ok(true) };
    Ok(due_in(scope, cid, id, host)?.is_none_or(|due| due <= 0.0))
}

// __dom.scriptFetchDue(id, host) -> how many milliseconds after now the fetch `id` lands (`due_in`), -1 for none.
fn due_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let id = args.get(0).uint32_value(scope).unwrap_or(0);
    let Ok(host) = v8::Local::<v8::Function>::try_from(args.get(1)) else { return rv.set_double(-1.0) };
    let cid = realm_id(scope, &args);
    let Ok(due) = due_in(scope, cid, id, host) else { return };
    rv.set_double(due.unwrap_or(-1.0));
}

// __dom.scriptFetchLanded(id, landed) -> whether the fetch `id`'s task has come — true for one it has no more — marked so,
// `landed`.
fn landed_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let id = args.get(0).uint32_value(scope).unwrap_or(0);
    let mark = args.get(1).is_true();
    let cid = realm_id(scope, &args);
    let Some(f) = fetches_of(scope, cid).and_then(|f| find(f, id)) else { return rv.set_bool(true) };
    f.landed |= mark;
    rv.set_bool(f.landed);
}

// __dom.scriptFetchLand(id, host) -> what the fetch `id` landed as, `[ok, body, entry]` (`classic_script_land`) — taken —
// or null for one it has no more.
fn land_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let id = args.get(0).uint32_value(scope).unwrap_or(0);
    let Ok(host) = v8::Local::<v8::Function>::try_from(args.get(1)) else { return rv.set_null() };
    let cid = realm_id(scope, &args);
    let Some(f) = take(scope, cid, id) else { return rv.set_null() };
    let Ok(landed) = classic_script_land(scope, cid, host, f.fetch) else { return };
    rv.set(landed_value(scope, landed).into());
}

// __dom.scriptFetchDrop(id, host) — the fetch `id` cancelled: its answer let go of (`classic_script_drop`).
fn drop_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let id = args.get(0).uint32_value(scope).unwrap_or(0);
    let Ok(host) = v8::Local::<v8::Function>::try_from(args.get(1)) else { return };
    let cid = realm_id(scope, &args);
    if let Some(f) = take(scope, cid, id) {
        let _ = classic_script_drop(scope, host, f.fetch);
    }
}
