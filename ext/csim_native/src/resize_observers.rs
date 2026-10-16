// Resize observers (Resize Observer §3): a realm's ResizeObservers that observe anything, each with its observations —
// the target, the box observed, and the size of it last reported — in creation order, as "gather active observations
// at depth" visits them; which observations each round found active, or skipped; and whether a round left one
// skipped. The observers themselves, their callbacks and the entries they are handed are the bindings' (observers.js),
// which name each by the number `roCreate` gave it, and which measure the targets (`resizeObservations`: the layout's
// sizes, resize_observation.rs) for the gather to compare.

use crate::dom::{nid_arg, realm_id, NodeId, RealmArena};

struct Observation {
    // Which observation it is: a target observed again is observed by a new one (§3.1 `observe`), which a broadcast of
    // the old one's active entry leaves owing its first report.
    serial: u32,
    target: NodeId,
    // The target, held — a root, which the realm's context going lets go of (`discard_resize_observers`).
    held: v8::Global<v8::Value>,
    // Where the observed box's `[inline, block]` sits among the sizes (resize_observation.rs `Sizes`): 0 the border
    // box, 2 the content box, 4 the device-pixel content box.
    box_at: usize,
    // The size of the box last reported — (-1, -1) before the first, which differs from every size, so the first
    // update reports it.
    last: [f64; 2],
}

// One the gather found active: its target, its sizes and depth as the gather measured them, for the entry its
// broadcast makes.
struct Active {
    serial: u32,
    held: v8::Global<v8::Value>,
    sizes: [f64; 10],
    depth: f64,
}

struct Observer {
    id: u32,
    observations: Vec<Observation>,
    active: Vec<Active>,
    skipped: bool,
}

#[derive(Default)]
pub(crate) struct ResizeObservers {
    // In creation order: ids only grow, and an observer joins as it first observes something, so it is kept sorted.
    observing: Vec<Observer>,
    next: u32,
    next_serial: u32,
}

impl RealmArena {
    // Realm `cid`'s context disposed — a frame removed or navigated: its observations' targets held no more, nor what
    // they reach of its heap (the context with them), as a new context's realm state starts without them.
    pub(crate) fn discard_resize_observers(&mut self, cid: i32) {
        let observers = if cid == self.cur() { Some(&mut self.resize_observers) } else { self.parked_state(cid).map(|s| &mut s.resize_observers) };
        if let Some(observers) = observers {
            observers.observing.clear();
        }
    }
}

impl ResizeObservers {
    fn observer(&mut self, id: u32) -> Option<&mut Observer> {
        self.observing.iter_mut().find(|o| o.id == id)
    }
    // Every observation, in the order the gather visits them — the targets the bindings measure.
    fn targets(&self) -> impl Iterator<Item = &Observation> {
        self.observing.iter().flat_map(|o| o.observations.iter())
    }
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "roCreate", ro_create, context_id);
    crate::dom::register(scope, ns, "roObserve", ro_observe, context_id);
    crate::dom::register(scope, ns, "roUnobserve", ro_unobserve, context_id);
    crate::dom::register(scope, ns, "roDisconnect", ro_disconnect, context_id);
    crate::dom::register(scope, ns, "roObserving", ro_observing, context_id);
    crate::dom::register(scope, ns, "roTargets", ro_targets, context_id);
    crate::dom::register(scope, ns, "roGather", ro_gather, context_id);
    crate::dom::register(scope, ns, "roTakeActive", ro_take_active, context_id);
    crate::dom::register(scope, ns, "roSkipped", ro_skipped, context_id);
    crate::dom::register(scope, ns, "roHolds", ro_holds, context_id);
}

// __dom.roHolds(id) -> whether the realm holds the observer still: it observes something, or has an observation this
// round found active not yet broadcast.
fn ro_holds(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = args.get(0).uint32_value(scope) else { return rv.set_bool(false) };
    let cid = realm_id(scope, &args);
    rv.set_bool(crate::dom::realm(scope, cid).resize_observers.observer(id).is_some());
}

// __dom.roCreate() -> a new ResizeObserver's number, which orders it among the realm's.
fn ro_create(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    let observers = &mut crate::dom::realm(scope, cid).resize_observers;
    let id = observers.next;
    observers.next += 1;
    rv.set_uint32(id);
}

// __dom.roObserve(id, targetNid, boxAt, target) — the observer observes the target's box anew (`boxAt`, its place
// among the sizes), at the end of its list: a target observed again is observed with the box it is given now.
fn ro_observe(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = args.get(0).uint32_value(scope) else { return };
    let Some(target) = nid_arg(scope, &args, 1) else { return };
    let box_at = (args.get(2).uint32_value(scope).unwrap_or(0) as usize).min(4) & !1;
    let node = args.get(3);
    if !node.is_object() {
        return;
    }
    let cid = realm_id(scope, &args);
    // (…none by a realm whose context is gone — a frame its own callback removed, observing on: its target would root
    // the context it is in, which nothing lets go of again before the next visit)
    if crate::dom::realm(scope, cid).context_gone(cid) {
        return;
    }
    let held = v8::Global::new(scope, node);
    let observers = &mut crate::dom::realm(scope, cid).resize_observers;
    let serial = observers.next_serial;
    observers.next_serial = serial.wrapping_add(1);
    if observers.observer(id).is_none() {
        let at = observers.observing.partition_point(|o| o.id < id);
        observers.observing.insert(at, Observer { id, observations: Vec::new(), active: Vec::new(), skipped: false });
    }
    let observer = observers.observer(id).expect("inserted above");
    observer.observations.retain(|o| o.target != target);
    observer.observations.push(Observation { serial, target, held, box_at, last: [-1.0, -1.0] });
}

// __dom.roUnobserve(id, target) -> whether the realm still holds the observer: one left observing nothing is no longer
// the realm's to visit (§3.5: it lives no longer than its references) — once what this round found active of it is
// broadcast, which an unobserve in an earlier callback leaves, as a disconnect does not.
fn ro_unobserve(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = args.get(0).uint32_value(scope) else { return rv.set_bool(false) };
    let target = nid_arg(scope, &args, 1);
    let cid = realm_id(scope, &args);
    let observers = &mut crate::dom::realm(scope, cid).resize_observers;
    let Some(observer) = observers.observer(id) else { return rv.set_bool(false) };
    observer.observations.retain(|o| Some(o.target) != target);
    let held = !observer.observations.is_empty() || !observer.active.is_empty();
    if !held {
        observers.observing.retain(|o| o.id != id);
    }
    rv.set_bool(held);
}

// __dom.roDisconnect(id) — the observer observes nothing, and what this round found active of it is not broadcast.
fn ro_disconnect(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = args.get(0).uint32_value(scope) else { return };
    let cid = realm_id(scope, &args);
    crate::dom::realm(scope, cid).resize_observers.observing.retain(|o| o.id != id);
}

// __dom.roObserving() -> whether any of the realm's ResizeObservers observes anything.
fn ro_observing(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    rv.set_bool(!crate::dom::realm(scope, cid).resize_observers.observing.is_empty());
}

// __dom.roTargets() -> every observation's target, in the order the gather visits them: what the bindings measure.
fn ro_targets(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    let held: Vec<v8::Global<v8::Value>> = crate::dom::realm(scope, cid).resize_observers.targets().map(|o| o.held.clone()).collect();
    let locals: Vec<v8::Local<v8::Value>> = held.iter().map(|g| v8::Local::new(scope, g)).collect();
    rv.set(v8::Array::new_with_elements(scope, &locals).into());
}

// __dom.roGather(depth, measured) -> "gather active observations at depth": each observation whose box's size differs
// from the one it last reported — `measured` the bindings' measure of every target in `roTargets` order, eleven numbers
// each (its sizes, then its depth) — active where its target is deeper than `depth`, else skipped; the observers with
// any active, in creation order, for the broadcast to visit.
fn ro_gather(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let depth = args.get(0).number_value(scope).unwrap_or(0.0);
    let measured = crate::dom::f64_arg(args.get(1)).to_vec();
    let cid = realm_id(scope, &args);
    let observers = &mut crate::dom::realm(scope, cid).resize_observers;
    let mut at = 0;
    let mut with_active = Vec::new();
    for observer in &mut observers.observing {
        observer.active.clear();
        observer.skipped = false;
        for ob in &observer.observations {
            let Some(m) = measured.get(at * 11..at * 11 + 11) else { break };
            at += 1;
            let sizes: [f64; 10] = m[..10].try_into().expect("ten sizes");
            if sizes[ob.box_at] == ob.last[0] && sizes[ob.box_at + 1] == ob.last[1] {
                continue;
            }
            if m[10] > depth {
                observer.active.push(Active { serial: ob.serial, held: ob.held.clone(), sizes, depth: m[10] });
            } else {
                observer.skipped = true;
            }
        }
        if !observer.active.is_empty() {
            with_active.push(observer.id);
        }
    }
    let ids: Vec<v8::Local<v8::Value>> = with_active.iter().map(|&id| v8::Integer::new_from_unsigned(scope, id).into()).collect();
    rv.set(v8::Array::new_with_elements(scope, &ids).into());
}

// __dom.roTakeActive(id) -> null where the gather found nothing active of the observer (or it was disconnected since),
// else `[targets, sizes, shallowest]`: the active observations' targets, their sizes (ten numbers each, as the gather
// measured them), and the shallowest of their depths — each of them taken as reported, its size the one it last
// reported.
fn ro_take_active(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = args.get(0).uint32_value(scope) else { return rv.set_null() };
    let cid = realm_id(scope, &args);
    let observers = &mut crate::dom::realm(scope, cid).resize_observers;
    let Some(observer) = observers.observer(id) else { return rv.set_null() };
    let active = std::mem::take(&mut observer.active);
    if active.is_empty() {
        return rv.set_null();
    }
    let mut shallowest = f64::INFINITY;
    for a in &active {
        if let Some(ob) = observer.observations.iter_mut().find(|o| o.serial == a.serial) {
            ob.last = [a.sizes[ob.box_at], a.sizes[ob.box_at + 1]];
        }
        shallowest = shallowest.min(a.depth);
    }
    if observer.observations.is_empty() {
        observers.observing.retain(|o| o.id != id);
    }
    let sizes: Vec<f64> = active.iter().flat_map(|a| a.sizes).collect();
    let targets: Vec<v8::Local<v8::Value>> = active.iter().map(|a| v8::Local::new(scope, &a.held)).collect();
    let targets = v8::Array::new_with_elements(scope, &targets);
    let sizes = crate::dom::f64_array(scope, &sizes);
    let shallowest = v8::Number::new(scope, shallowest);
    rv.set(v8::Array::new_with_elements(scope, &[targets.into(), sizes.into(), shallowest.into()]).into());
}

// __dom.roSkipped() -> whether the last gather left an observation skipped: the loop error, and one more update owed.
fn ro_skipped(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    rv.set_bool(crate::dom::realm(scope, cid).resize_observers.observing.iter().any(|o| o.skipped));
}
