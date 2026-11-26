// HTML's lists of scripts (§4.12.1.1 "prepare the script element", §13.2.7 "the end"): each script whose fetch lands as a
// task of its own — the parser's deferred and `async` ones, an inserted one — and what becomes of it as it lands, the
// "list of scripts that will execute in order as soon as possible", and the script-blocking style sheet set the scripts
// prepared behind it wait for. Kept and ordered here; the bindings queue the tasks the steps ask for and run the scripts
// they hand over (bridge.entry.js `landingSteps`), each by its number, as a timer's handler is run by its id.

use std::collections::VecDeque;

use crate::dom::{nid_arg, realm, realm_id, register, NodeId, RealmArena};
use crate::font_files::Terminated;
use crate::script_fetch::Fetched;
use crate::subresource_obtain::{call, Landed, ScriptText, H_FILE};

// A realm's script lists (`RealmState::script_lists`).
#[derive(Default)]
pub(crate) struct ScriptLists {
    next: u32,
    landings: Vec<Landing>,
    // HTML "list of scripts that will execute in order as soon as possible": the inserted scripts of `async` false, by the
    // number of each one's landing — and whether the head of it is being run (`STEP_EXECUTE_IN_ORDER`).
    in_order: VecDeque<u32>,
    running_in_order: bool,
    // The script-blocking style sheet set (HTML "has a style sheet that is blocking scripts"): the elements contributing one,
    // each with its number — the order they came to block in — and whether its load task is queued.
    sheets: Vec<BlockingSheet>,
    sheet_seq: u32,
    // …a sheet of it came to block since the parser last asked (`parserSheetWait`), and one ended as the parser waited.
    sheet_fetched: bool,
    sheet_ended_parsing: bool,
    // The landings held behind those sheets, in the order they were held; those let go of as the parser waits, held until
    // it goes on (`sheetWaitersParsed`).
    sheet_waiters: Vec<u32>,
    waiters_parsed: Vec<u32>,
}

struct BlockingSheet {
    el: NodeId,
    seq: u32,
    queued: bool,
}

// What a landing is the landing of (`scriptLandingBegin`'s `kind`).
#[derive(Clone, Copy, PartialEq)]
enum Kind {
    // The parser's deferred script — a `defer` one, a module: "the end" waits on its fetch (bridge.entry.js `awaitLanding`).
    Deferred,
    // The parser's `async` one: HTML "set of scripts that will execute as soon as possible", run as it lands.
    Async,
    // …one of them that fetches nothing (a `nomodule` one): a task "the end" queues for it.
    Unfetched,
    // An inserted classic script, or module script.
    Inserted { module: bool },
}
pub(crate) const KIND_DEFERRED: u32 = 0;
pub(crate) const KIND_ASYNC: u32 = 1;
pub(crate) const KIND_UNFETCHED: u32 = 2;
pub(crate) const KIND_INSERTED_CLASSIC: u32 = 3;
pub(crate) const KIND_INSERTED_MODULE: u32 = 4;

// Where its landing is.
#[derive(Clone, Copy, PartialEq)]
enum State {
    // Its task queued.
    Queued,
    // …again, as late as its server takes: woken as its document aborts (`scriptLandingsWake`).
    Waiting,
    // Landed, behind the style sheets that blocked scripts as it was prepared (`sheet_waiters`, `waiters_parsed`).
    Sheets,
    // Landed, and what it runs decided: an inserted one in order waiting its turn.
    Landed,
}

// What an inserted script runs, decided as it lands: nothing (it moved to another document), its `error` (its fetch
// failed, or its document aborted it), its classic script's response, its module script.
enum Exec {
    Nothing,
    Error,
    Classic(Landed),
    Module,
}

struct Landing {
    id: u32,
    el: NodeId,
    // Its preparation-time document, and how many aborts had come to it as the script was prepared.
    doc: NodeId,
    aborts: u32,
    // The fetch it lands (script_fetch.rs), 0 for none.
    fetch: u32,
    kind: Kind,
    // In turn as of its parse's beginning, a fetch its preload scanner made (timers.rs `SPECULATIVE`).
    speculative: bool,
    // The last of the style sheets blocking scripts as it was prepared, which it waits for (0 for none).
    sheets_up_to: u32,
    in_order: bool,
    state: State,
    // An inserted one's: what the bindings handed over to run it by (its URL as prepared, a module's `[url, source]`)…
    prepared: Option<v8::Global<v8::Value>>,
    // …what it runs, and the aborts that had come to its document as it landed: one aborted since runs nothing ("discarding
    // any tasks queued").
    exec: Exec,
    landed_aborts: Option<u32>,
}

impl ScriptLists {
    // A new document's: the landings of the old one's land in no document. (…their numbers left to go on from, as a task
    // of one of them may still come)
    pub(crate) fn reset(&mut self) {
        *self = ScriptLists { next: self.next, ..ScriptLists::default() };
    }
    fn find(&mut self, id: u32) -> Option<&mut Landing> {
        self.landings.iter_mut().find(|l| l.id == id)
    }
    fn remove(&mut self, id: u32) -> Option<Landing> {
        let at = self.landings.iter().position(|l| l.id == id)?;
        Some(self.landings.remove(at))
    }
    // How many scripts the page has yet to run whose landing it waits for: its `async` ones and those it inserted — what the
    // host's boot drain runs the event loop for (browser.rb `pendingExternalScriptCount`).
    fn pending(&self) -> u32 {
        self.landings.iter().filter(|l| l.kind != Kind::Deferred).count() as u32
    }
    // The number of the last style sheet blocking scripts now (0 for none) — which a script prepared now waits for…
    fn sheets_now(&self) -> u32 {
        if self.sheets.is_empty() { 0 } else { self.sheet_seq }
    }
    // …and whether one numbered up to `up_to` blocks still.
    fn sheet_blocks_up_to(&self, up_to: u32) -> bool {
        self.sheets.first().is_some_and(|s| s.seq <= up_to)
    }
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    register(scope, ns, "scriptLandingBegin", begin_op, context_id);
    register(scope, ns, "scriptLandingNext", next_op, context_id);
    register(scope, ns, "scriptLandingTake", take_op, context_id);
    register(scope, ns, "scriptLandingsWake", wake_op, context_id);
    register(scope, ns, "scriptsPending", pending_op, context_id);
    register(scope, ns, "sheetBlockBegin", sheet_begin_op, context_id);
    register(scope, ns, "sheetBlockQueued", sheet_queued_op, context_id);
    register(scope, ns, "sheetBlockEnd", sheet_end_op, context_id);
    register(scope, ns, "sheetBlockSettle", sheet_settle_op, context_id);
    register(scope, ns, "sheetWaitersParsed", waiters_parsed_op, context_id);
    register(scope, ns, "parserSheetWait", parser_sheet_wait_op, context_id);
}

fn lists_of(arena: &mut RealmArena, cid: i32) -> Option<&mut ScriptLists> {
    arena.realm_state_mut(cid).map(|s| &mut s.script_lists)
}

// __dom.scriptLandingBegin(el, fetch, kind, speculative, prepared) -> the number of the landing of the script `el`'s fetch
// `fetch` (0 for none), what it is the landing of `kind` (`KIND_*`), in turn as of its parse's beginning (`speculative`),
// with what an inserted one runs by (`prepared`) — of its node document now, its preparation-time one — 0 for none: a
// script of no document. One inserted of `async` false joins the list of scripts that will execute in order.
fn begin_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    rv.set_uint32(0);
    let Some(el) = nid_arg(scope, &args, 0) else { return };
    let fetch = args.get(1).uint32_value(scope).unwrap_or(0);
    let kind = match args.get(2).uint32_value(scope).unwrap_or(KIND_DEFERRED) {
        KIND_ASYNC => Kind::Async,
        KIND_UNFETCHED => Kind::Unfetched,
        KIND_INSERTED_CLASSIC => Kind::Inserted { module: false },
        KIND_INSERTED_MODULE => Kind::Inserted { module: true },
        _ => Kind::Deferred,
    };
    let speculative = args.get(3).is_true();
    let prepared = (!args.get(4).is_undefined()).then(|| v8::Global::new(scope, args.get(4)));
    let cid = realm_id(scope, &args);
    let Some(doc) = crate::node_handle::node_document_of(scope, el) else { return };
    let arena = realm(scope, cid);
    let aborts = arena.document_states.lifecycle(doc).aborts();
    let in_order = matches!(kind, Kind::Inserted { .. })
        && arena.get(el).is_some_and(|n| n.script_flags & crate::script::SCRIPT_NOT_FORCE_ASYNC != 0 && n.plain_attr("async").is_none());
    let Some(lists) = lists_of(arena, cid) else { return };
    lists.next += 1;
    let id = lists.next;
    let sheets_up_to = lists.sheets_now();
    lists.landings.push(Landing { id, el, doc, aborts, fetch, kind, speculative, sheets_up_to, in_order, state: State::Queued, prepared, exec: Exec::Nothing, landed_aborts: None });
    if in_order {
        lists.in_order.push_back(id);
    }
    rv.set_uint32(id);
}

// The phase `scriptLandingNext` is asked at: the landing begun; its task run (queued as it began, again as late as its
// server took, or woken); let go of by the style sheets it waited for; the list of scripts that will execute in order
// gone on with, the one at its head run.
const PHASE_BEGUN: u32 = 0;
const PHASE_TASK: u32 = 1;
const PHASE_RELEASED: u32 = 2;
const PHASE_IN_ORDER: u32 = 3;
// What it says to do: nothing more; queue its task `arg` ms on — `QUEUE_GATED` under a load gate (late on purpose and
// holding the load, `QUEUE_LATE`), `QUEUE_SPECULATIVE` in turn as of its parse's beginning, `QUEUE_TIMER` as a timer's
// task rather than a response's; run the parser's script (bridge.entry.js `runOneScript`, "the end"'s list); fire its
// `error`, where preparing it again comes to a script, its parser aborted (`STEP_FAILED`); run the landing `arg`
// (`scriptLandingTake`), and then, one of the list of scripts that will execute in order, go on with the list.
const STEP_DONE: u32 = 0;
const STEP_QUEUE: u32 = 1;
const STEP_RUN: u32 = 2;
const STEP_FAILED: u32 = 3;
const STEP_EXECUTE: u32 = 4;
const STEP_EXECUTE_IN_ORDER: u32 = 5;
const QUEUE_GATED: u32 = 16;
const QUEUE_LATE: u32 = 32;
const QUEUE_SPECULATIVE: u32 = 64;
const QUEUE_TIMER: u32 = 128;

// __dom.scriptLandingNext(id, phase, host) -> `[what, arg]`: what the landing `id` comes to next, asked at `phase` — the
// fetch it lands, landed as it does, the host's (`host`, subresource-host.js).
fn next_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let id = args.get(0).uint32_value(scope).unwrap_or(0);
    let phase = args.get(1).uint32_value(scope).unwrap_or(PHASE_TASK);
    let Ok(host) = v8::Local::<v8::Function>::try_from(args.get(2)) else { return };
    let cid = realm_id(scope, &args);
    let Ok((what, arg)) = next(scope, cid, id, phase, host) else { return };
    let items = [v8::Integer::new_from_unsigned(scope, what).into(), v8::Number::new(scope, arg).into()];
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}
fn next(scope: &mut v8::PinScope<'_, '_>, cid: i32, id: u32, phase: u32, host: v8::Local<'_, v8::Function>) -> Result<(u32, f64), Terminated> {
    const DONE: (u32, f64) = (STEP_DONE, 0.0);
    if phase == PHASE_IN_ORDER {
        return Ok(in_order_next(realm(scope, cid), cid));
    }
    let arena = realm(scope, cid);
    let Some(l) = lists_of(arena, cid).and_then(|lists| lists.find(id)) else { return Ok(DONE) };
    let (doc, fetch, kind, state, speculative, up_to) = (l.doc, l.fetch, l.kind, l.state, l.speculative, l.sheets_up_to);
    let lc = arena.document_states.lifecycle(doc);
    // (…under a gate where its document's load is to come, which waits for it: HTML "the end" — a deferred one's not, "the
    // end" waiting for it itself)
    let gated = kind != Kind::Deferred && !lc.is_load_fired();
    let turn = if speculative { QUEUE_SPECULATIVE } else { 0 };
    match phase {
        PHASE_BEGUN if kind == Kind::Unfetched => return Ok((STEP_QUEUE | QUEUE_GATED | QUEUE_TIMER, 0.0)),
        PHASE_BEGUN => return Ok((STEP_QUEUE | if gated { QUEUE_GATED } else { 0 } | turn, 0.0)),
        PHASE_RELEASED if state == State::Sheets => return then(scope, cid, id, host),
        PHASE_TASK if matches!(state, State::Queued | State::Waiting) => {}
        _ => return Ok(DONE),
    }
    if kind == Kind::Unfetched {
        lists_of(arena, cid).and_then(|lists| lists.remove(id));
        return Ok(if lc.is_aborted() { DONE } else { (STEP_RUN, 0.0) });
    }
    // (…its server's time waited out where its script still waits on the fetch — none where its document's abort, or a
    // move, ended that: HTML "abort a document" cancels it, a network error at once)
    if fetch != 0 && waits(scope, cid, id) {
        let due = crate::script_fetch::due_in(scope, cid, fetch).unwrap_or(0.0);
        if due > 0.0 {
            if let Some(l) = lists_of(realm(scope, cid), cid).and_then(|lists| lists.find(id)) {
                l.state = State::Waiting;
            }
            return Ok((STEP_QUEUE | if gated { QUEUE_GATED | QUEUE_LATE } else { 0 } | turn, due));
        }
    }
    if fetch != 0 {
        crate::script_fetch::landed(scope, cid, fetch, true);
    }
    // (…behind the style sheets that blocked scripts as it was prepared — and, one of them ended as the parser waits, until
    // the parser has gone on: `sheetWaitersParsed`)
    let arena = realm(scope, cid);
    let parsing = arena.document_states.lifecycle(doc).is_parsing();
    let Some(lists) = lists_of(arena, cid) else { return Ok(DONE) };
    let held = if up_to == 0 {
        false
    } else if lists.sheet_blocks_up_to(up_to) {
        lists.sheet_waiters.push(id);
        true
    } else if lists.sheet_ended_parsing && parsing {
        lists.waiters_parsed.push(id);
        true
    } else {
        false
    };
    if held {
        if let Some(l) = lists.find(id) {
            l.state = State::Sheets;
        }
        return Ok(DONE);
    }
    then(scope, cid, id, host)
}

// Whether the landing `id`'s script still waits on its fetch: a deferred one's while its parser is not aborted, an `async`
// one's while no abort came to its document either, an inserted one's while none did and it is in that document still.
fn waits(scope: &mut v8::PinScope<'_, '_>, cid: i32, id: u32) -> bool {
    let arena = realm(scope, cid);
    let Some(l) = lists_of(arena, cid).and_then(|lists| lists.find(id)) else { return false };
    let (el, doc, aborts, kind) = (l.el, l.doc, l.aborts, l.kind);
    let lc = arena.document_states.lifecycle(doc);
    match kind {
        Kind::Deferred => !lc.is_aborted(),
        Kind::Async => !lc.is_aborted() && lc.aborts() == aborts,
        Kind::Inserted { .. } => lc.aborts() == aborts && crate::node_handle::node_document_of(scope, el) == Some(doc),
        Kind::Unfetched => false,
    }
}

// The landing `id` landed, held by no style sheet: what its script comes to.
fn then(scope: &mut v8::PinScope<'_, '_>, cid: i32, id: u32, host: v8::Local<'_, v8::Function>) -> Result<(u32, f64), Terminated> {
    const DONE: (u32, f64) = (STEP_DONE, 0.0);
    let arena = realm(scope, cid);
    let Some(l) = lists_of(arena, cid).and_then(|lists| lists.find(id)) else { return Ok(DONE) };
    let (el, doc, aborts, fetch, kind) = (l.el, l.doc, l.aborts, l.fetch, l.kind);
    let moved = crate::node_handle::node_document_of(scope, el) != Some(doc);
    let arena = realm(scope, cid);
    let lc = arena.document_states.lifecycle(doc);
    match kind {
        Kind::Deferred | Kind::Unfetched => {
            lists_of(arena, cid).and_then(|lists| lists.remove(id));
            Ok(DONE)
        }
        // (…an `async` one run where its document is the one it was prepared in, its parser going on — "the end"'s list
        // runs it, its fetch landed there — else none, its fetch let go of: one moved, or run already; one whose parser was
        // aborted fires its `error`, its fetch cancelled)
        Kind::Async => {
            lists_of(arena, cid).and_then(|lists| lists.remove(id));
            let run = arena.get(el).is_some_and(|n| n.script_flags & crate::script::SCRIPT_RUN != 0);
            if !moved && !run && !lc.is_aborted() && lc.aborts() == aborts {
                return Ok((STEP_RUN, 0.0));
            }
            crate::script_fetch::drop_fetch(scope, cid, fetch, host)?;
            Ok(if moved || run { DONE } else { (STEP_FAILED, 0.0) })
        }
        // (…an inserted one's response taken now, its entry filed as its load completes — unless it moved to another
        // document since, which runs none of it: "execute the script element" step 2, "If el's preparation-time document is
        // not equal to document, then return" — its `error` where its document was aborted: HTML "abort a document"
        // cancels its fetch)
        Kind::Inserted { module } => {
            let mut exec = Exec::Nothing;
            let mut landed_aborts = None;
            if !moved {
                if lc.aborts() == aborts {
                    exec = match crate::script_fetch::land(scope, cid, fetch, host)? {
                        Some(Fetched::Classic(landed)) => {
                            if let Some(entry) = &landed.2 {
                                let entry = v8::Local::new(scope, entry);
                                call(scope, host, H_FILE, &[entry])?;
                            }
                            Exec::Classic(landed)
                        }
                        _ if module => Exec::Module,
                        _ => Exec::Error,
                    };
                }
                let now = realm(scope, cid).document_states.lifecycle(doc).aborts();
                if now != aborts {
                    exec = Exec::Error;
                }
                landed_aborts = Some(now);
            }
            let arena = realm(scope, cid);
            let Some(lists) = lists_of(arena, cid) else { return Ok(DONE) };
            let Some(l) = lists.find(id) else { return Ok(DONE) };
            l.exec = exec;
            l.landed_aborts = landed_aborts;
            l.state = State::Landed;
            if !l.in_order {
                return Ok((STEP_EXECUTE, f64::from(id)));
            }
            // (…the list gone on with here, unless a run of it is under way, which goes on to it)
            if lists.running_in_order {
                return Ok(DONE);
            }
            Ok(in_order_next(arena, cid))
        }
    }
}

// The list of scripts that will execute in order, gone on with: its head run where it has landed — the list is the
// engine's to go on with as each is run (`STEP_EXECUTE_IN_ORDER`), one run of it at a time.
fn in_order_next(arena: &mut RealmArena, cid: i32) -> (u32, f64) {
    let Some(lists) = lists_of(arena, cid) else { return (STEP_DONE, 0.0) };
    let head = lists.in_order.front().copied();
    let landed = head.is_some_and(|id| lists.landings.iter().any(|l| l.id == id && l.state == State::Landed));
    match head {
        Some(id) if landed => {
            lists.in_order.pop_front();
            lists.running_in_order = true;
            (STEP_EXECUTE_IN_ORDER, f64::from(id))
        }
        _ => {
            lists.running_in_order = false;
            (STEP_DONE, 0.0)
        }
    }
}

// What a landing's script runs as it is taken (`scriptLandingTake`): nothing; its classic script's text; its `load` (an
// empty one's); its `error`; its module script.
const RUN_NOTHING: u32 = 0;
const RUN_CLASSIC: u32 = 1;
const RUN_LOADED: u32 = 2;
const RUN_ERROR: u32 = 3;
const RUN_MODULE: u32 = 4;

// __dom.scriptLandingTake(id, host) -> `[el, what, body, prepared]`: the landing `id`, run now, taken — what its script runs
// (`RUN_*`), none where it moved to another document since it landed, or its document was aborted, its source text, and
// what the bindings handed over to run it by — its fetch let go of where it has one still; null for none.
fn take_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    rv.set_null();
    let id = args.get(0).uint32_value(scope).unwrap_or(0);
    let Ok(host) = v8::Local::<v8::Function>::try_from(args.get(1)) else { return };
    let cid = realm_id(scope, &args);
    let arena = realm(scope, cid);
    let Some(l) = lists_of(arena, cid).and_then(|lists| lists.remove(id)) else { return };
    if crate::script_fetch::drop_fetch(scope, cid, l.fetch, host).is_err() {
        return;
    }
    let current = crate::node_handle::node_document_of(scope, l.el) == Some(l.doc)
        && l.landed_aborts == Some(realm(scope, cid).document_states.lifecycle(l.doc).aborts());
    let mut body: v8::Local<v8::Value> = v8::undefined(scope).into();
    let what = match l.exec {
        _ if !current => RUN_NOTHING,
        Exec::Nothing => RUN_NOTHING,
        Exec::Error => RUN_ERROR,
        Exec::Module => RUN_MODULE,
        Exec::Classic((false, _, _)) => RUN_ERROR,
        Exec::Classic((true, text, _)) => {
            body = match text {
                ScriptText::Host(host_text) => v8::Local::new(scope, host_text),
                ScriptText::Decoded(decoded) => crate::subresource_obtain::text(scope, &decoded),
            };
            if body.is_string() && body.to_string(scope).is_some_and(|s| s.length() == 0) { RUN_LOADED } else { RUN_CLASSIC }
        }
    };
    let el = crate::dom::node_value(scope, Some(l.el));
    let prepared = match l.prepared {
        Some(p) => v8::Local::new(scope, p),
        None => v8::undefined(scope).into(),
    };
    let items = [el, v8::Integer::new_from_unsigned(scope, what).into(), body, prepared];
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}

// __dom.scriptLandingsWake() -> `[el, id, …]`: the landings waiting on their servers — their task queued at once as their
// document aborts, not as late as the server would have answered (HTML "abort a document" cancels the fetch, a network
// error at once): queued again, each, by the caller.
fn wake_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    let Some(lists) = lists_of(realm(scope, cid), cid) else { return };
    let mut woken = Vec::new();
    for l in lists.landings.iter_mut().filter(|l| l.state == State::Waiting) {
        l.state = State::Queued;
        woken.push((l.el, l.id));
    }
    rv.set(pairs_value(scope, &woken));
}
// `[el, id, …]` of `pairs`.
fn pairs_value<'s>(scope: &mut v8::PinScope<'s, '_>, pairs: &[(NodeId, u32)]) -> v8::Local<'s, v8::Value> {
    let mut items = Vec::with_capacity(pairs.len() * 2);
    for &(el, id) in pairs {
        items.push(crate::dom::node_value(scope, Some(el)));
        items.push(v8::Integer::new_from_unsigned(scope, id).into());
    }
    v8::Array::new_with_elements(scope, &items).into()
}

// __dom.scriptsPending() -> how many of the calling realm's scripts it waits on the landing of (`ScriptLists::pending`).
fn pending_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    rv.set_uint32(lists_of(realm(scope, cid), cid).map_or(0, |lists| lists.pending()));
}

// __dom.sheetBlockBegin(el) — the element `el` contributes a style sheet that blocks scripts, from now until its sheet is
// in (`sheetBlockEnd`): the parser's next script waits on it (`parserSheetWait`).
fn sheet_begin_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(el) = nid_arg(scope, &args, 0) else { return };
    let cid = realm_id(scope, &args);
    let Some(lists) = lists_of(realm(scope, cid), cid) else { return };
    if lists.sheets.iter().any(|s| s.el == el) {
        return;
    }
    lists.sheet_seq += 1;
    let seq = lists.sheet_seq;
    lists.sheets.push(BlockingSheet { el, seq, queued: false });
    lists.sheet_fetched = true;
}

// __dom.sheetBlockQueued(el, queued) -> the number of the style sheet `el` blocks scripts with, 0 for none — its load task
// queued (`queued`), which ends it.
fn sheet_queued_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    rv.set_uint32(0);
    let Some(el) = nid_arg(scope, &args, 0) else { return };
    let queued = args.get(1).is_true();
    let cid = realm_id(scope, &args);
    let Some(sheet) = lists_of(realm(scope, cid), cid).and_then(|lists| lists.sheets.iter_mut().find(|s| s.el == el)) else { return };
    sheet.queued |= queued;
    rv.set_uint32(sheet.seq);
}

// __dom.sheetBlockEnd(el, seq) -> `[el, id, gated, …]`: the style sheet `seq` of the element `el` is in, and blocks scripts no
// more — the landings that waited on it alone let go of: as the parser waits, held until it goes on (`sheetWaitersParsed`),
// else each its own task to be queued by the caller, under a load gate (`gated`) where its document's load is to come.
fn sheet_end_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(el) = nid_arg(scope, &args, 0) else { return };
    let seq = args.get(1).uint32_value(scope).unwrap_or(0);
    let cid = realm_id(scope, &args);
    let mut released = Vec::new();
    end_sheet(scope, cid, el, seq, &mut released);
    rv.set(released_value(scope, &released));
}
// __dom.sheetBlockSettle(batch) -> as `sheetBlockEnd`: the elements of `batch` connected, those whose connection queued
// no load task (no fetch, disconnected) blocking nothing.
fn sheet_settle_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    let mut released = Vec::new();
    if lists_of(realm(scope, cid), cid).is_some_and(|lists| !lists.sheets.is_empty()) {
        if let Ok(batch) = v8::Local::<v8::Array>::try_from(args.get(0)) {
            for i in 0..batch.length() {
                let Some(el) = batch.get_index(scope, i).and_then(|v| crate::node_handle::nid_of(scope, v)) else { continue };
                let unqueued = lists_of(realm(scope, cid), cid).and_then(|lists| lists.sheets.iter().find(|s| s.el == el && !s.queued).map(|s| s.seq));
                if let Some(seq) = unqueued {
                    end_sheet(scope, cid, el, seq, &mut released);
                }
            }
        }
    }
    rv.set(released_value(scope, &released));
}
fn end_sheet(scope: &mut v8::PinScope<'_, '_>, cid: i32, el: NodeId, seq: u32, released: &mut Vec<(NodeId, u32, bool)>) {
    let parsing_here = crate::node_handle::node_document_of(scope, el).is_some_and(|doc| realm(scope, cid).document_states.lifecycle(doc).is_parsing());
    let arena = realm(scope, cid);
    let Some(lists) = lists_of(arena, cid) else { return };
    let Some(at) = lists.sheets.iter().position(|s| s.el == el && s.seq == seq) else { return };
    lists.sheets.remove(at);
    lists.sheet_ended_parsing |= parsing_here;
    if lists.sheet_waiters.is_empty() {
        return;
    }
    let waiting = std::mem::take(&mut lists.sheet_waiters);
    let mut facts = Vec::with_capacity(waiting.len());
    for id in waiting {
        let Some(l) = lists.landings.iter().find(|l| l.id == id) else { continue };
        facts.push((id, l.el, l.doc, l.sheets_up_to));
    }
    for (id, el, doc, up_to) in facts {
        let lc = arena.document_states.lifecycle(doc);
        let Some(lists) = lists_of(arena, cid) else { return };
        if lists.sheet_blocks_up_to(up_to) {
            lists.sheet_waiters.push(id);
        } else if lc.is_parsing() {
            lists.waiters_parsed.push(id);
        } else {
            released.push((el, id, !lc.is_load_fired()));
        }
    }
}
fn released_value<'s>(scope: &mut v8::PinScope<'s, '_>, released: &[(NodeId, u32, bool)]) -> v8::Local<'s, v8::Value> {
    let mut items = Vec::with_capacity(released.len() * 3);
    for &(el, id, gated) in released {
        items.push(crate::dom::node_value(scope, Some(el)));
        items.push(v8::Integer::new_from_unsigned(scope, id).into());
        items.push(v8::Boolean::new(scope, gated).into());
    }
    v8::Array::new_with_elements(scope, &items).into()
}

// __dom.sheetWaitersParsed() -> `[el, id, …]`: the landings let go of as the parser waited, run now that it has gone on —
// the script it waited to run first, as the parser resumes from that wait before the event loop runs the next task; or
// "the end", where it waited for none. A sheet that ended as it waited holds those that land after it no more.
fn waiters_parsed_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    let Some(lists) = lists_of(realm(scope, cid), cid) else { return };
    lists.sheet_ended_parsing = false;
    let waiting = std::mem::take(&mut lists.waiters_parsed);
    let pairs: Vec<(NodeId, u32)> = waiting.iter().filter_map(|&id| lists.landings.iter().find(|l| l.id == id).map(|l| (l.el, id))).collect();
    rv.set(pairs_value(scope, &pairs));
}

// __dom.parserSheetWait() -> the mark the parser's next script waits by (script.rs `parserWaits`, one its `async` scripts
// land with) where a style sheet came to block scripts since it last asked, -1 where none did.
fn parser_sheet_wait_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    let arena = realm(scope, cid);
    let fetched = lists_of(arena, cid).is_some_and(|lists| std::mem::take(&mut lists.sheet_fetched));
    rv.set_double(if fetched { arena.parser_waits(cid, true) } else { -1.0 });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn landing(id: u32, kind: Kind) -> Landing {
        Landing { id, el: NodeId { idx: 1, generation: 0 }, doc: NodeId { idx: 1, generation: 0 }, aborts: 0, fetch: 0, kind, speculative: false, sheets_up_to: 0, in_order: false, state: State::Queued, prepared: None, exec: Exec::Nothing, landed_aborts: None }
    }

    // The scripts the page waits on are the `async` and inserted ones' landings; a deferred one's "the end" waits on itself.
    #[test]
    fn a_page_waits_on_its_async_and_inserted_landings() {
        let mut lists = ScriptLists::default();
        lists.landings = vec![landing(1, Kind::Deferred), landing(2, Kind::Async), landing(3, Kind::Inserted { module: true }), landing(4, Kind::Unfetched)];
        assert_eq!(lists.pending(), 3);
        lists.remove(2);
        assert_eq!(lists.pending(), 2);
    }

    // A script prepared waits for the style sheets blocking scripts as it was, the earliest of which blocks until it ends.
    #[test]
    fn a_script_waits_for_the_sheets_that_blocked_as_it_was_prepared() {
        let mut lists = ScriptLists::default();
        assert_eq!(lists.sheets_now(), 0);
        for seq in 1..=2 {
            lists.sheet_seq = seq;
            lists.sheets.push(BlockingSheet { el: NodeId { idx: 1, generation: 0 }, seq, queued: false });
        }
        assert_eq!(lists.sheets_now(), 2);
        assert!(lists.sheet_blocks_up_to(1) && lists.sheet_blocks_up_to(2));
        lists.sheets.remove(0);
        assert!(!lists.sheet_blocks_up_to(1) && lists.sheet_blocks_up_to(2));
    }

    // A new document's lists begin empty, their numbers going on from the last: a task an old landing queued finds none.
    #[test]
    fn a_new_documents_lists_number_on_from_the_last() {
        let mut lists = ScriptLists { next: 7, ..ScriptLists::default() };
        lists.landings.push(landing(7, Kind::Async));
        lists.in_order.push_back(7);
        lists.reset();
        assert_eq!((lists.next, lists.landings.len(), lists.in_order.len()), (7, 0, 0));
    }
}
