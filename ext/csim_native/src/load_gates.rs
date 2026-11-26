// The work a document's load event waits for that is a task of its own (HTML "delay the load event"): a style sheet's
// `load`, a frame's build, a plugin's — each queued as a task, so the window's `load` could otherwise beat it. Each is a
// GATE: run at most once, whoever gets there first — its own task, or the flush that fires the window's load. What each
// runs is the bindings' (bridge.entry.js `subresourceGate`), kept with it here — let go of with it, run or not; which gate
// is due, and when, is decided here.

use crate::dom::{realm, realm_id, NodeId};

// A gate: its number, the element whose work it is (none for one of no element), and whether it is late on purpose — a
// resource wptserve was asked to TRICKLE (`?pipe=trickle(dN)` exists to be observed not yet loaded), which the flush
// leaves to its own timer rather than collapse the delay it demonstrates.
struct Gate {
    id: u32,
    el: Option<NodeId>,
    delayed: bool,
    // Whether its work is a frame's build, none of its document's own fetches.
    frame: bool,
    // …and whether, late, it delays the load all the same: a script's fetch whose server took time (script_fetch.rs),
    // which "the end" waits for however long.
    holds: bool,
    // Its place in the event loop's sequence as it was made, its task's: what the flush runs them in the order of.
    order: u64,
    // What it runs.
    work: v8::Global<v8::Function>,
}
// (…taken, its work is under way until it ends: a server's `sleep` in a script's fetch runs the event loop inside it, whose
// `load` must not come before it, HTML "the end" spinning until the set of scripts that will execute as soon as possible
// is empty)

// A realm's gates (`RealmState::load_gates`).
#[derive(Default)]
pub(crate) struct LoadGates {
    gates: Vec<Gate>,
    next: u32,
    running: Vec<(u32, bool)>,
}

impl LoadGates {
    // Whether a gate's work is still to run.
    pub(crate) fn pending(&self) -> bool {
        !self.gates.is_empty()
    }
    // Whether a gate's work is under way (`loadGateEnd`).
    pub(crate) fn running(&self) -> bool {
        !self.running.is_empty()
    }
    // Whether a gate late on purpose delays the load still (`Gate::holds`).
    pub(crate) fn holding(&self) -> bool {
        self.gates.iter().any(|g| g.holds)
    }
    // A frame `container`'s build held for its response (frame_response.rs `FRAME_LATER`) let go of: the navigation it was
    // of superseded — another begun, a stop(), the frame removed — the load waiting for it no more.
    pub(crate) fn forget_held_frame(&mut self, container: NodeId) {
        self.gates.retain(|g| !(g.frame && g.holds && g.el == Some(container)));
    }
    // Whether a fetch of the document's own is waiting on a gate, or one's work is under way: not a frame's.
    pub(crate) fn own_fetches(&self) -> bool {
        self.gates.iter().any(|g| !g.frame) || self.running.iter().any(|&(_, frame)| !frame)
    }
}

// The flush is bounded: flushing one can queue another (a frame's document brings its own sheets, a script's `load` the next
// script of a chain, which HTML "the end" waits for however long), and a document that keeps queuing them would otherwise
// never load. As the boot's own drain of them is (browser.rb `BOOT_SCRIPT_DRAIN_MAX_ITER`).
const FLUSH_ROUNDS: usize = 300;

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "loadGate", load_gate_op, context_id);
    crate::dom::register(scope, ns, "loadGateTake", load_gate_take_op, context_id);
    crate::dom::register(scope, ns, "loadGateEnd", load_gate_end_op, context_id);
    crate::dom::register(scope, ns, "flushLoadGates", flush_load_gates_op, context_id);
    crate::dom::register(scope, ns, "loadGatesForget", load_gates_forget_op, context_id);
    crate::dom::register(scope, ns, "loadGatesPending", load_gates_pending_op, context_id);
}

fn gates_of<'s>(scope: &'s mut v8::PinScope<'_, '_>, cid: i32) -> Option<&'s mut LoadGates> {
    realm(scope, cid).realm_state_mut(cid).map(|s| &mut s.load_gates)
}

// __dom.loadGate(el, delayed, holds, speculative, work) -> the number of a new gate of the calling realm's document for
// the element `el` (null for none), running `work`, `delayed` one late on purpose — that the load waits for all the same,
// `holds` — its place in the event loop's sequence a speculative fetch's (`speculative`: timers.rs `SPECULATIVE`).
fn load_gate_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Ok(work) = v8::Local::<v8::Function>::try_from(args.get(4)) else { return rv.set_uint32(0) };
    let work = v8::Global::new(scope, work);
    let el = crate::node_handle::nid_of(scope, args.get(0));
    let delayed = args.get(1).is_true();
    let holds = delayed && args.get(2).is_true();
    let speculative = args.get(3).is_true();
    let cid = realm_id(scope, &args);
    let arena = realm(scope, cid);
    let frame = el.and_then(|el| arena.get(el)).is_some_and(|n| n.is_html_named("iframe") || n.is_html_named("frame"));
    let order = arena.task_place(cid, speculative);
    let Some(gates) = gates_of(scope, cid) else { return rv.set_uint32(0) };
    gates.next += 1;
    let id = gates.next;
    gates.gates.push(Gate { id, el, delayed, frame, holds, order, work });
    rv.set_uint32(id);
}

// __dom.loadGateTake(id) -> what the gate `id` runs, where it is still to run — taken: it runs now, and never again —
// null where not.
fn load_gate_take_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let id = args.get(0).uint32_value(scope).unwrap_or(0);
    let cid = realm_id(scope, &args);
    match gates_of(scope, cid).and_then(|g| take(g, id)) {
        Some(work) => rv.set(v8::Local::new(scope, work).into()),
        None => rv.set_null(),
    }
}
fn take(gates: &mut LoadGates, id: u32) -> Option<v8::Global<v8::Function>> {
    let at = gates.gates.iter().position(|g| g.id == id)?;
    let gate = gates.gates.remove(at);
    gates.running.push((id, gate.frame));
    Some(gate.work)
}
// __dom.loadGateEnd(id) — the work of the gate `id` over: its document's load asked about again by the bindings.
fn load_gate_end_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let id = args.get(0).uint32_value(scope).unwrap_or(0);
    let cid = realm_id(scope, &args);
    if let Some(gates) = gates_of(scope, cid) {
        gates.running.retain(|&(running, _)| running != id);
    }
}

// __dom.flushLoadGates(run) — the gates of the calling realm's document run, `run(id, work)` each, in the order their tasks would
// run in, as its load is about to fire: those of THIS document's elements alone — an element a script built inside another document (a
// `createHTMLDocument` context, a DOMParser result) has its own load to wait for, and forcing its work here reached a
// frame a browser has not built yet — and none late on purpose; round after round while running some queued more.
// Deliberately NO microtask checkpoint between them: a subresource's own `load` event is dispatched from one, so
// draining would bring those forward too — and a frame's element `load` run inside the window's load dispatch loses a
// navigation the page had planned (WPT reparent-form-during-planned-navigation-task).
fn flush_load_gates_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Ok(run) = v8::Local::<v8::Function>::try_from(args.get(0)) else { return };
    let cid = realm_id(scope, &args);
    flush(scope, cid, run);
}
pub(crate) fn flush(scope: &mut v8::PinScope<'_, '_>, cid: i32, run: v8::Local<'_, v8::Function>) {
    let document = realm(scope, cid).realm_document(cid);
    for _ in 0..FLUSH_ROUNDS {
        // (…in the order their tasks would have run in: a speculative fetch's ahead of what the parse queued meanwhile)
        let mut candidates: Vec<(u64, u32, Option<NodeId>)> = match gates_of(scope, cid) {
            Some(g) => g.gates.iter().filter(|g| !g.delayed).map(|g| (g.order, g.id, g.el)).collect(),
            None => return,
        };
        candidates.sort_unstable_by_key(|&(order, id, _)| (order, id));
        let candidates = candidates.into_iter().map(|(_, id, el)| (id, el));
        let due: Vec<u32> = candidates.into_iter().filter(|&(_, el)| el.is_none_or(|el| crate::node_handle::node_document_of(scope, el) == document)).map(|(id, _)| id).collect();
        if due.is_empty() {
            break;
        }
        for id in due {
            let Some(work) = gates_of(scope, cid).and_then(|g| take(g, id)) else { continue };
            let id = v8::Integer::new_from_unsigned(scope, id).into();
            let work = v8::Local::new(scope, work).into();
            let undefined = v8::undefined(scope).into();
            v8::tc_scope!(let tc, scope);
            run.call(tc, undefined, &[id, work]);
            if tc.has_terminated() {
                return;
            }
        }
    }
}


// __dom.loadGatesPending() -> whether a gate of the calling realm's document is still to run (`LoadGates::pending`).
fn load_gates_pending_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    rv.set_bool(gates_of(scope, cid).is_some_and(|g| g.pending()));
}

// __dom.loadGatesForget() — the calling realm's gates let go of: a new document begins in it, and the elements the old
// one's were for belong to a document being replaced (left in, they would pile up one dead gate per navigation).
fn load_gates_forget_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    if let Some(g) = gates_of(scope, cid) {
        g.gates.clear();
        g.running.clear();
    }
}
