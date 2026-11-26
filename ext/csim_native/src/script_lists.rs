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
    // The parser's scripts prepared and still to run — one at a time, but for one a script it runs writes (`scriptPrepare`).
    prepared: Vec<Prepared>,
    // "The end" under way — of the realm's document, or of one a script that "the end" runs opened and closed again.
    ends: Vec<TheEnd>,
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
    register(scope, ns, "scriptPrepare", prepare_op, context_id);
    register(scope, ns, "scriptWaitNext", wait_next_op, context_id);
    register(scope, ns, "scriptRun", run_op, context_id);
    register(scope, ns, "theEndBegin", the_end_begin_op, context_id);
    register(scope, ns, "theEndNext", the_end_next_op, context_id);
    register(scope, ns, "theEndOver", the_end_over_op, context_id);
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

// __dom.parserSheetWait() -> the mark the parser's next script waits by (script.rs `parser_waits`, one its `async` scripts
// land with) where a style sheet came to block scripts since it last asked, -1 where none did.
fn parser_sheet_wait_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    let arena = realm(scope, cid);
    let fetched = lists_of(arena, cid).is_some_and(|lists| std::mem::take(&mut lists.sheet_fetched));
    rv.set_double(if fetched { arena.parser_waits(cid, true) } else { -1.0 });
}

// The parser's script prepared (HTML "prepare the script element", by the parser at its end tag or out of "the end"'s
// lists — bridge.entry.js `prepareParserScript`): what the parser waits on before it runs it (`scriptWaitNext`) and then
// runs (`scriptRun`), the script nesting level back at zero as it waits where it is a pending parsing-blocking script.
struct Prepared {
    id: u32,
    el: NodeId,
    // The document it was prepared in — the realm's — and how many aborts had come to it, and its number, then: one aborted
    // since, or opened again (a task its wait ran wrote it), runs it no more.
    doc: NodeId,
    aborts: u32,
    generation: u32,
    // A module script, run whole once its graph's entry has landed.
    module: bool,
    // An inline one's source text as it was prepared.
    text: Option<Vec<u16>>,
    // Its fetch (script_fetch.rs, 0 for none): a parser-blocking one's begun as it was prepared, dated as its parse began
    // where a preload scanner saw it; a deferred one's what "the end" waits on (`awaited`).
    fetch: u32,
    blocking: bool,
    awaited: bool,
    // The mark of the tasks its wait runs first (script.rs `parser_waits`): a style sheet's that blocks it.
    mark: f64,
    wait: Wait,
}
// Where its wait is: to begin; spun past the tasks queued before it, its landing to await or not; over, whether it goes
// on to run asked.
#[derive(Clone, Copy, PartialEq)]
enum Wait {
    Begin,
    Spun { awaits: bool },
    Over,
}

// What preparing the parser's script came to (`scriptPrepare`): nothing; its `error` to fire on a task; its import map
// registered; a module script prepared, waited on and run whole; a classic one prepared — `what + id * 8`.
const PREPARED_NONE: u32 = 0;
const PREPARED_ERROR: u32 = 1;
const PREPARED_IMPORT_MAP: u32 = 2;
const PREPARED_MODULE: u32 = 3;
const PREPARED_CLASSIC: u32 = 4;

// __dom.scriptPrepare(el, by, awaited, mark, host) -> what preparing the parser's script `el` came to (`PREPARED_*`) and the
// number of what it prepared: HTML "prepare the script element" as far as the element decides it (script.rs
// `prepare_script`, `by` whom), scripting disabled where its node document has no browsing context — a parser-blocking
// one's fetch begun now, HTML's "fetch a classic script" in parallel, which the parser's wait spins the event loop for
// (`scriptWaitNext`), one an `async` or a deferred one's the fetch its end tag began — "the end" waiting on a deferred
// one's (`awaited`); `mark` the mark of a style sheet that blocks an inline one, which its wait runs first.
fn prepare_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    rv.set_uint32(PREPARED_NONE);
    let Some(el) = nid_arg(scope, &args, 0) else { return };
    let by = args.get(1).uint32_value(scope).unwrap_or(crate::script::BY_PARSER);
    let awaited = args.get(2).is_true();
    let mark = args.get(3).number_value(scope).unwrap_or(0.0);
    let Ok(host) = v8::Local::<v8::Function>::try_from(args.get(4)) else { return };
    let cid = realm_id(scope, &args);
    if let Ok(what) = prepare(scope, cid, el, (by, awaited, mark), host) {
        rv.set_double(f64::from(what.0) + f64::from(what.1) * 8.0);
    }
}
fn prepare(scope: &mut v8::PinScope<'_, '_>, cid: i32, el: NodeId, (by, awaited, mark): (u32, bool, f64), host: v8::Local<'_, v8::Function>) -> Result<(u32, u32), Terminated> {
    use crate::script::{BY_PARSER_LIST, PREPARE_CLASSIC, PREPARE_ERROR, PREPARE_IMPORT_MAP, PREPARE_MODULE};
    let node_doc = crate::node_handle::node_document_of(scope, el);
    let arena = realm(scope, cid);
    let scripting = node_doc.is_some_and(|d| arena.document_states.has_browsing_context(d));
    let module = match arena.prepare_script(el, scripting, by) {
        PREPARE_ERROR => return Ok((PREPARED_ERROR, 0)),
        PREPARE_IMPORT_MAP => return Ok((PREPARED_IMPORT_MAP, 0)),
        PREPARE_MODULE => true,
        PREPARE_CLASSIC => false,
        _ => return Ok((PREPARED_NONE, 0)),
    };
    let Some(doc) = arena.realm_document(cid) else { return Ok((PREPARED_NONE, 0)) };
    let lc = arena.document_states.lifecycle(doc);
    let src = arena.get(el).and_then(|n| n.plain_attr("src")).filter(|s| !s.is_empty()).map(str::to_owned);
    let mut p = Prepared { id: 0, el, doc, aborts: lc.aborts(), generation: lc.generation(), module, text: None, fetch: 0, blocking: false, awaited, mark: 0.0, wait: Wait::Begin };
    if module {
        // (…its graph's entry's fetch, begun at its end tag — an inline one's none: the tasks queued before "the end"'s wait
        // run first)
        p.fetch = crate::script_fetch::fetch_of(scope, cid, el);
        if awaited && p.fetch == 0 {
            p.mark = realm(scope, cid).parser_waits(cid, false);
        }
    } else if let Some(src) = src {
        // (…its `src` parsed against its node document's base URL as it is prepared, one that does not parse fetched as the
        // attribute is)
        let arena = realm(scope, cid);
        let url = node_doc.and_then(|d| arena.parse_document_url(d, &src)).map(|u| u.href().to_owned());
        if by == BY_PARSER_LIST {
            // (…an `async` or a deferred one's the fetch its end tag began: "prepare the script element" fetched it there —
            // none is a network error)
            p.fetch = crate::script_fetch::fetch_of(scope, cid, el);
        } else {
            // (…the parser waiting on it, its `async` scripts landing with that — the tasks queued by now run first, or, none
            // being, those a style sheet that blocks it does: script.rs `parser_waits`)
            p.mark = Some(arena.parser_waits(cid, true)).filter(|&m| m != 0.0).unwrap_or(mark);
            let scanned = crate::script_fetch::parser_input_scanned(scope, cid);
            let mut request = crate::subresource_obtain::ClassicRequest::of_element(realm(scope, cid), el, doc, url, true);
            request.blocking = true;
            p.fetch = crate::script_fetch::begin_classic(scope, cid, host, request, scanned)?;
            p.blocking = true;
        }
    } else {
        p.text = Some(realm(scope, cid).child_text(el));
        p.mark = mark;
    }
    let Some(lists) = lists_of(realm(scope, cid), cid) else { return Ok((PREPARED_NONE, 0)) };
    lists.next += 1;
    p.id = lists.next;
    let id = p.id;
    lists.prepared.push(p);
    Ok((if module { PREPARED_MODULE } else { PREPARED_CLASSIC }, id))
}

// What the parser's wait on its script comes to next (`scriptWaitNext`): spin the event loop past the tasks queued by the
// mark `arg` (bridge.entry.js `parserSpin`); run it on for the `arg` ms its server took past the clock (the host's tick,
// Browser#server_slept_ms); spin it until the fetch `arg` has landed (`awaitLanding`); the wait over, the script to run;
// the wait over, none to run — its fetch let go of.
const WAIT_SPIN: u32 = 1;
const WAIT_SERVER: u32 = 2;
const WAIT_AWAIT: u32 = 3;
const WAIT_GO: u32 = 4;
const WAIT_STOP: u32 = 5;

// __dom.scriptWaitNext(id, host) -> `[what, arg]`: what the parser's wait on its script `id` comes to next (`WAIT_*`): HTML
// "spin the event loop" until it is ready — the tasks queued before the wait first (a fetch's response a task queued as
// it began: Chrome and Firefox, a zero timer set before a parser-blocking script, or before or after a deferred one, runs
// before it — csim-bench r13 `p_t0blk_*`, `p_t0dfr_*`, `q_dfrt0_0`, `q_t0css`; none run where nothing is: the common
// page's), then a parser-blocking one's server's time past its date (one a preload scanner saw dated as its parse began:
// two parser-blocking scripts fetched alongside, Chrome and Firefox `b b2 inl a.js-ran`, rv-r13-probe `s6_dating`,
// `s6_rt_blk` — none where that has passed), a deferred one's landing, queued at its end tag — and whether it goes on to
// run it: none where an abort came to its document meanwhile (HTML "abort a document", "discarding any tasks queued"), its
// parser was aborted ("If this parser has been aborted in the meantime, return"), or a task opened its document again
// (Chrome and Firefox: a timer's `document.write`, csim-bench r13 `r_t0write`, `r_t0write_dfr`).
fn wait_next_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let id = args.get(0).uint32_value(scope).unwrap_or(0);
    let Ok(host) = v8::Local::<v8::Function>::try_from(args.get(1)) else { return };
    let cid = realm_id(scope, &args);
    let Ok((what, arg)) = wait_next(scope, cid, id, host) else { return };
    let items = [v8::Integer::new_from_unsigned(scope, what).into(), v8::Number::new(scope, arg).into()];
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}
fn wait_next(scope: &mut v8::PinScope<'_, '_>, cid: i32, id: u32, host: v8::Local<'_, v8::Function>) -> Result<(u32, f64), Terminated> {
    let arena = realm(scope, cid);
    let Some(p) = lists_of(arena, cid).and_then(|lists| lists.prepared.iter().find(|p| p.id == id)) else { return Ok((WAIT_STOP, 0.0)) };
    let (doc, fetch, wait, mark, blocking, awaited) = (p.doc, p.fetch, p.wait, p.mark, p.blocking, p.awaited);
    let (aborts, generation) = (p.aborts, p.generation);
    let lc = arena.document_states.lifecycle(doc);
    if lc.aborts() != aborts || lc.generation() != generation {
        return stop(scope, cid, id, host);
    }
    let set = |arena: &mut RealmArena, wait: Wait| {
        if let Some(p) = lists_of(arena, cid).and_then(|lists| lists.prepared.iter_mut().find(|p| p.id == id)) {
            p.wait = wait;
        }
    };
    match wait {
        Wait::Begin => {
            // (…a deferred one's the tasks queued by now, "the end" waiting on it)
            let awaits = fetch != 0 && awaited;
            let mark = if awaits { arena.parser_waits(cid, false) } else { mark };
            set(arena, Wait::Spun { awaits });
            if mark != 0.0 {
                return Ok((WAIT_SPIN, mark));
            }
            wait_next(scope, cid, id, host)
        }
        Wait::Spun { awaits: true } => {
            set(arena, Wait::Over);
            Ok((WAIT_AWAIT, f64::from(fetch)))
        }
        Wait::Spun { awaits: false } if blocking => {
            set(arena, Wait::Over);
            match crate::script_fetch::due_in(scope, cid, fetch) {
                Some(due) if due > 0.0 => Ok((WAIT_SERVER, due)),
                _ => wait_next(scope, cid, id, host),
            }
        }
        Wait::Spun { .. } | Wait::Over => {
            set(arena, Wait::Over);
            if lc.is_aborted() {
                return stop(scope, cid, id, host);
            }
            Ok((WAIT_GO, 0.0))
        }
    }
}
// …the wait over with none to run: the script prepared let go of, its fetch with it.
fn stop(scope: &mut v8::PinScope<'_, '_>, cid: i32, id: u32, host: v8::Local<'_, v8::Function>) -> Result<(u32, f64), Terminated> {
    let arena = realm(scope, cid);
    let Some(lists) = lists_of(arena, cid) else { return Ok((WAIT_STOP, 0.0)) };
    let Some(at) = lists.prepared.iter().position(|p| p.id == id) else { return Ok((WAIT_STOP, 0.0)) };
    let p = lists.prepared.remove(at);
    crate::script_fetch::drop_fetch(scope, cid, p.fetch, host)?;
    Ok((WAIT_STOP, 0.0))
}

// What running the parser's script comes to (`scriptRun`): nothing (it moved to another document as the parser waited);
// its source text run; its `load` or its `error` fired, nothing run (`arg` whether it loaded); its module script run.
const RUN_PARSER_NOTHING: u32 = 0;
const RUN_PARSER_SCRIPT: u32 = 1;
const RUN_PARSER_EVENT: u32 = 2;
const RUN_PARSER_MODULE: u32 = 3;

// __dom.scriptRun(id, host) -> `[what, el, body]`: the parser's script `id`, waited on, run — taken: its fetch landed, its
// Resource Timing entry filed; none of it, no event either, where it has moved to another document as the parser waited
// (HTML "execute the script element" step 2, "If el's preparation-time document is not equal to document, then return" —
// Chrome and Firefox, csim-bench rv-sf-probe `v_adopt`, `w_adopt_frame`, `w_dfr_adopt`; an inline one a style sheet held
// too, Firefox's, Chrome runs it: `w_inl_sheet_adopt`); its source text run where it is one that runs — an empty one's
// none, a loaded one's `load` (Chrome, Firefox), and a failed one's `error` — "already started", and run by "the end"'s
// reckoning, before its event fires: the after-parse pass does not take it again.
fn run_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let id = args.get(0).uint32_value(scope).unwrap_or(0);
    let Ok(host) = v8::Local::<v8::Function>::try_from(args.get(1)) else { return };
    let cid = realm_id(scope, &args);
    let Some(p) = lists_of(realm(scope, cid), cid).and_then(|lists| {
        let at = lists.prepared.iter().position(|p| p.id == id)?;
        Some(lists.prepared.remove(at))
    }) else {
        return rv.set_null();
    };
    let moved = |scope: &mut v8::PinScope<'_, '_>| crate::node_handle::node_document_of(scope, p.el) != Some(p.doc);
    let (what, body): (u32, v8::Local<v8::Value>) = if p.module {
        if moved(scope) {
            let _ = crate::script_fetch::drop_fetch(scope, cid, p.fetch, host);
            (RUN_PARSER_NOTHING, v8::undefined(scope).into())
        } else {
            if p.fetch != 0 && crate::script_fetch::land(scope, cid, p.fetch, host).is_err() {
                return;
            }
            (RUN_PARSER_MODULE, v8::undefined(scope).into())
        }
    } else {
        let (ok, body, inline) = match p.text {
            Some(text) => (true, v8::String::new_from_two_byte(scope, &text, v8::NewStringType::Normal).map_or_else(|| v8::undefined(scope).into(), Into::into), true),
            None => match crate::script_fetch::land(scope, cid, p.fetch, host) {
                Err(_) => return,
                Ok(Some(Fetched::Classic((ok, text, entry)))) => {
                    if let Some(entry) = entry {
                        let entry = v8::Local::new(scope, entry);
                        if call(scope, host, H_FILE, &[entry]).is_err() {
                            return;
                        }
                    }
                    let body = match text {
                        ScriptText::Host(host_text) => v8::Local::new(scope, host_text),
                        ScriptText::Decoded(decoded) => crate::subresource_obtain::text(scope, &decoded),
                    };
                    (ok, body, false)
                }
                Ok(_) => (false, v8::undefined(scope).into(), false),
            },
        };
        let empty = !body.is_string() || body.to_string(scope).is_some_and(|s| s.length() == 0);
        if moved(scope) {
            (RUN_PARSER_NOTHING, v8::undefined(scope).into())
        } else if ok && (!empty || inline) {
            (RUN_PARSER_SCRIPT, body)
        } else {
            use crate::script::{SCRIPT_ALREADY_STARTED, SCRIPT_RUN};
            if let Some(n) = realm(scope, cid).get_mut_quietly(p.el) {
                n.script_flags |= SCRIPT_ALREADY_STARTED | SCRIPT_RUN;
            }
            (RUN_PARSER_EVENT, v8::Boolean::new(scope, ok).into())
        }
    };
    let el = crate::dom::node_value(scope, Some(p.el));
    let items = [v8::Integer::new_from_unsigned(scope, what).into(), el, body];
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}

// HTML "the end" (§13.2.7) for a document its parser ended, steps 3-6: its parser's scripts no end tag decided, its
// readiness `interactive`, the `async` scripts its waits landed, its deferred scripts, each waited on in turn, those that
// fetch nothing, and its DOMContentLoaded queued — each a step the bindings take as the engine hands it over
// (bridge.entry.js `theEnd`).
struct TheEnd {
    id: u32,
    doc: NodeId,
    stage: Stage,
    // The scripts of the stage under way still to come: a parse that handed none to a handler's (the XML parser's), in
    // tree order (script.rs `parser_scripts`), or the `async` ones taken off the list.
    queue: std::collections::VecDeque<NodeId>,
    // Its document's number as its deferred scripts began: one a task their waits ran opened again runs none of them.
    generation: u32,
}
#[derive(Clone, Copy, PartialEq)]
enum Stage {
    Begin,
    EndTags,
    Ready,
    Landing,
    Landed,
    Deferred,
    Unfetched,
    Over,
}

// What it comes to next (`theEndNext`): nothing; its parser aborted — its readiness stepped on, none of it run; run the
// parser's script `el` (`arg` 1 at its end tag, `BY_PARSER`); put it on the list of scripts to execute after parsing as its
// end tag would, its fetch begun (`arg` script.rs `listParserScript`'s); its readiness `interactive`; run the listed one
// `el` (`arg` 1 where "the end" waits on it); queue the task of one that fetches nothing; deliver the mutation records
// queued; queue its DOMContentLoaded (`arg` its document's number).
const END_DONE: u32 = 0;
const END_ABORTED: u32 = 1;
const END_RUN: u32 = 2;
const END_LIST: u32 = 3;
const END_READY: u32 = 4;
const END_RUN_LISTED: u32 = 5;
const END_UNFETCHED: u32 = 6;
const END_DELIVER: u32 = 7;
const END_CONTENT_LOADED: u32 = 8;

// __dom.theEndBegin(docNid) -> the number of "the end" begun for the document.
fn the_end_begin_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    rv.set_uint32(0);
    let Some(doc) = nid_arg(scope, &args, 0) else { return };
    let cid = realm_id(scope, &args);
    let Some(lists) = lists_of(realm(scope, cid), cid) else { return };
    lists.next += 1;
    let id = lists.next;
    lists.ends.push(TheEnd { id, doc, stage: Stage::Begin, queue: Default::default(), generation: 0 });
    rv.set_uint32(id);
}
// __dom.theEndOver(id) — "the end" `id` over, however it ended.
fn the_end_over_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let id = args.get(0).uint32_value(scope).unwrap_or(0);
    let cid = realm_id(scope, &args);
    if let Some(lists) = lists_of(realm(scope, cid), cid) {
        lists.ends.retain(|e| e.id != id);
    }
}

// __dom.theEndNext(id) -> `[what, el, arg]`: what "the end" `id` comes to next (`END_*`).
fn the_end_next_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let id = args.get(0).uint32_value(scope).unwrap_or(0);
    let cid = realm_id(scope, &args);
    let (what, el, arg) = the_end_next(scope, cid, id);
    let el = crate::dom::node_value(scope, el);
    let items = [v8::Integer::new_from_unsigned(scope, what).into(), el, v8::Integer::new_from_unsigned(scope, arg).into()];
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}
fn the_end_next(scope: &mut v8::PinScope<'_, '_>, cid: i32, id: u32) -> (u32, Option<NodeId>, u32) {
    use crate::script::{BY_PARSER, SCRIPT_RUN};
    const DONE: (u32, Option<NodeId>, u32) = (END_DONE, None, 0);
    loop {
        let arena = realm(scope, cid);
        let Some(end) = lists_of(arena, cid).and_then(|lists| lists.ends.iter().find(|e| e.id == id)) else { return DONE };
        let (doc, stage, generation) = (end.doc, end.stage, end.generation);
        let set = |arena: &mut RealmArena, stage: Stage, queue: Vec<NodeId>| {
            if let Some(end) = lists_of(arena, cid).and_then(|lists| lists.ends.iter_mut().find(|e| e.id == id)) {
                end.stage = stage;
                end.queue = queue.into();
            }
        };
        let pop = |arena: &mut RealmArena| lists_of(arena, cid).and_then(|lists| lists.ends.iter_mut().find(|e| e.id == id)).and_then(|e| e.queue.pop_front());
        let lc = arena.document_states.lifecycle(doc);
        // (…a script of its document's, as it was parsed: one a script ran, or moved to another document, runs no more here
        // — "execute the script element" returns where its node document is not its preparation-time one)
        let runs = |scope: &mut v8::PinScope<'_, '_>, s: NodeId| {
            realm(scope, cid).get(s).is_some_and(|n| n.script_flags & SCRIPT_RUN == 0) && crate::node_handle::node_document_of(scope, s) == Some(doc)
        };
        match stage {
            // (…none of a document whose parser was aborted, nor what it had listed: HTML "abort a parser", "abort a
            // document" cancelling its scripts' fetches)
            Stage::Begin => {
                if lc.is_aborted() {
                    arena.forget_parser_scripts(cid);
                    set(arena, Stage::Over, Vec::new());
                    return (END_ABORTED, None, 0);
                }
                // (…"the end" of a document with no element at all too — an empty XML one, a parse error — which runs no
                // script)
                let root = arena.get(doc).and_then(|d| d.children.iter().copied().find(|&c| arena.get(c).is_some_and(|n| n.kind == crate::dom::NodeKind::Element)));
                let scripts = root.map_or_else(Vec::new, |root| arena.parser_scripts(root));
                set(arena, Stage::EndTags, scripts);
            }
            // A parse that handed NO scripts to a handler (the XML parser) leaves this pass to stand in for their end tags, in
            // tree order, while the document is still `loading`: its parser-blocking ones and its import maps run, the others
            // go on the list — each as its turn comes, where an earlier one's script may have removed it.
            Stage::EndTags => {
                let Some(s) = pop(arena) else {
                    set(arena, Stage::Ready, Vec::new());
                    continue;
                };
                let Some(n) = arena.get(s) else { continue };
                if n.script_flags & SCRIPT_RUN != 0 {
                    continue;
                }
                if crate::script::blocks_parser(n) || crate::script::script_type(n) == crate::script::IMPORT_MAP {
                    return (END_RUN, Some(s), BY_PARSER);
                }
                let scripting = arena.document_states.has_browsing_context(doc);
                return (END_LIST, Some(s), arena.list_parser_script(cid, s, scripting));
            }
            // …and then "the end": `interactive` FIRST (firing readystatechange), then the deferred scripts, then
            // DOMContentLoaded — so a `defer` or module script sees `interactive` (Chrome and Firefox). `complete` comes with
            // the window's load.
            Stage::Ready => {
                let changed = arena.document_states.lifecycle_mut(doc).the_end();
                set(arena, Stage::Landing, Vec::new());
                if changed {
                    return (END_READY, None, 0);
                }
            }
            // (…its document's number as of now, past its readystatechange: a task the deferred scripts' waits run that opens
            // it again ends this "the end")
            Stage::Landing => {
                let taken = crate::script::take_parser_async(scope, cid, true);
                let arena = realm(scope, cid);
                let generation = arena.document_states.lifecycle(doc).generation();
                set(arena, Stage::Landed, taken);
                if let Some(end) = lists_of(arena, cid).and_then(|lists| lists.ends.iter_mut().find(|e| e.id == id)) {
                    end.generation = generation;
                }
            }
            // The `async` scripts that have landed as the parser waited (script.rs `take_parser_async`), run: one whose
            // parser has waited on a fetch runs before DOMContentLoaded, and a DOMContentLoaded listener it adds hears it;
            // one whose parser has not runs after it. Chrome and Firefox agree on both families (rvfn `l_listener_sync`,
            // `d_sync_*`, `d_defer`, `e_mix*`, and `d_fast`, `z3_asy_fast`, `d_module`, 2026-11-06). Where among the parser's
            // own scripts they part, and the place here is Firefox's, at the end of the parse: a blocking script's `stop()`
            // cancels it, which both do (`h_ext_asy`).
            Stage::Landed => {
                let next = if lc.is_aborted() { None } else { pop(arena) };
                let Some(s) = next else {
                    set(arena, Stage::Deferred, Vec::new());
                    continue;
                };
                if runs(scope, s) {
                    return (END_RUN_LISTED, Some(s), 0);
                }
            }
            // The list of scripts to execute after parsing, in the order their end tags put them on it (script.rs
            // `take_parser_next`): modules, `defer` — the PARSER's scripts only (one a script inserted ran, or never runs —
            // an innerHTML fragment's, a clone of a started script — on its own terms), and each whether or not an earlier
            // one removed it since (`BY_PARSER_LIST`) — but not one moved into another document. "The end" waits on each
            // one's fetch: spins the event loop until it has landed, the `async` ones whose fetches land first running as
            // they do — none once its parser was aborted, or a task the wait ran opened its document again.
            Stage::Deferred => {
                if lc.is_aborted() || lc.generation() != generation {
                    arena.forget_parser_scripts(cid);
                    set(arena, Stage::Over, Vec::new());
                    return DONE;
                }
                let Some(s) = arena.take_parser_next(cid) else {
                    let taken = crate::script::take_parser_async(scope, cid, false);
                    set(realm(scope, cid), Stage::Unfetched, taken);
                    continue;
                };
                if runs(scope, s) {
                    return (END_RUN_LISTED, Some(s), 1);
                }
            }
            // …and those it never waited for: what DOMContentLoaded does not wait for, each a task of its own after it, ahead
            // of the load, which does — their fetches' landings; one that fetches nothing (a `nomodule` one), a task queued
            // now.
            Stage::Unfetched => {
                let Some(s) = pop(arena) else {
                    set(arena, Stage::Over, Vec::new());
                    return (END_DELIVER, None, 0);
                };
                if runs(scope, s) && crate::script_fetch::fetch_of(scope, cid, s) == 0 {
                    return (END_UNFETCHED, Some(s), 0);
                }
            }
            // …then DOMContentLoaded, as a task (HTML "the end" step 6).
            Stage::Over => {
                if let Some(lists) = lists_of(arena, cid) {
                    lists.ends.retain(|e| e.id != id);
                }
                return (END_CONTENT_LOADED, None, lc.generation());
            }
        }
    }
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
