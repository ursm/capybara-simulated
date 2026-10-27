// The work a document's load event waits for that is a task of its own (HTML "delay the load event"): a style sheet's
// `load`, a frame's build, a plugin's — each queued as a task, so the window's `load` could otherwise beat it. Each is a
// GATE: run at most once, whoever gets there first — its own task, or the flush that fires the window's load. The
// bindings hold what each runs (bridge.entry.js `subresourceGate`); which gate is due, and when, is decided here.

use crate::dom::{realm, realm_id, NodeId};

// A gate: its number, the element whose work it is (none for one of no element), and whether it is late on purpose — a
// resource wptserve was asked to TRICKLE (`?pipe=trickle(dN)` exists to be observed not yet loaded), which the flush
// leaves to its own timer rather than collapse the delay it demonstrates.
struct Gate {
    id: u32,
    el: Option<NodeId>,
    delayed: bool,
}

// A realm's gates (`RealmState::load_gates`).
#[derive(Default)]
pub(crate) struct LoadGates {
    gates: Vec<Gate>,
    next: u32,
}

// The flush is bounded: flushing one can queue another (a frame's document brings its own sheets), and a document that
// keeps queuing them would otherwise never load.
const FLUSH_ROUNDS: usize = 8;

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "loadGate", load_gate_op, context_id);
    crate::dom::register(scope, ns, "loadGateTake", load_gate_take_op, context_id);
    crate::dom::register(scope, ns, "flushLoadGates", flush_load_gates_op, context_id);
    crate::dom::register(scope, ns, "loadGatesForget", load_gates_forget_op, context_id);
}

fn gates_of<'s>(scope: &'s mut v8::PinScope<'_, '_>, cid: i32) -> Option<&'s mut LoadGates> {
    realm(scope, cid).realm_state_mut(cid).map(|s| &mut s.load_gates)
}

// __dom.loadGate(el, delayed) -> the number of a new gate of the calling realm's document for the element `el` (null for
// none), `delayed` one late on purpose.
fn load_gate_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let el = crate::node_handle::nid_of(scope, args.get(0));
    let delayed = args.get(1).is_true();
    let cid = realm_id(scope, &args);
    let Some(gates) = gates_of(scope, cid) else { return rv.set_uint32(0) };
    gates.next += 1;
    let id = gates.next;
    gates.gates.push(Gate { id, el, delayed });
    rv.set_uint32(id);
}

// __dom.loadGateTake(id) -> whether the gate `id` is still to run — taken: it runs now, and never again.
fn load_gate_take_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let id = args.get(0).uint32_value(scope).unwrap_or(0);
    let cid = realm_id(scope, &args);
    rv.set_bool(gates_of(scope, cid).is_some_and(|g| take(g, id)));
}
fn take(gates: &mut LoadGates, id: u32) -> bool {
    let Some(at) = gates.gates.iter().position(|g| g.id == id) else { return false };
    gates.gates.remove(at);
    true
}

// __dom.flushLoadGates(run) — the gates of the calling realm's document run, `run(id)` each, as its load is about to
// fire: those of THIS document's elements alone — an element a script built inside another document (a
// `createHTMLDocument` context, a DOMParser result) has its own load to wait for, and forcing its work here reached a
// frame a browser has not built yet — and none late on purpose; round after round while running some queued more.
// Deliberately NO microtask checkpoint between them: a subresource's own `load` event is dispatched from one, so
// draining would bring those forward too — and a frame's element `load` run inside the window's load dispatch loses a
// navigation the page had planned (WPT reparent-form-during-planned-navigation-task).
fn flush_load_gates_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Ok(run) = v8::Local::<v8::Function>::try_from(args.get(0)) else { return };
    let cid = realm_id(scope, &args);
    let document = realm(scope, cid).realm_document(cid);
    for _ in 0..FLUSH_ROUNDS {
        let candidates: Vec<(u32, Option<NodeId>)> = match gates_of(scope, cid) {
            Some(g) => g.gates.iter().filter(|g| !g.delayed).map(|g| (g.id, g.el)).collect(),
            None => return,
        };
        let due: Vec<u32> = candidates.into_iter().filter(|&(_, el)| el.is_none_or(|el| node_document(scope, el) == document)).map(|(id, _)| id).collect();
        if due.is_empty() {
            break;
        }
        for id in due {
            if !gates_of(scope, cid).is_some_and(|g| take(g, id)) {
                continue;
            }
            let id = v8::Integer::new_from_unsigned(scope, id).into();
            let undefined = v8::undefined(scope).into();
            v8::tc_scope!(let tc, scope);
            run.call(tc, undefined, &[id]);
            if tc.has_terminated() {
                return;
            }
        }
    }
}

// The document a node is in now — its node document, which its object keeps.
fn node_document(scope: &mut v8::PinScope<'_, '_>, el: NodeId) -> Option<NodeId> {
    let object = crate::dom::node_value(scope, Some(el));
    crate::node_handle::handle_of(scope, object)
        // SAFETY: the handle lives while the object, a local here, does.
        .and_then(|ptr| unsafe { ptr.as_ref() }.document(scope))
        .and_then(|d| crate::node_handle::nid_of(scope, d.into()))
}

// __dom.loadGatesForget() — the calling realm's gates let go of: a new document begins in it, and the elements the old
// one's were for belong to a document being replaced (left in, they would pile up one dead gate per navigation).
fn load_gates_forget_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    if let Some(g) = gates_of(scope, cid) {
        g.gates.clear();
    }
}
