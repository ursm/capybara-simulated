// Intersection observers (Intersection Observer §3): a realm's IntersectionObservers that observe anything, in creation
// order, each with its delay and its targets' registrations (§3.2.7 IntersectionObserverRegistration: the previous
// threshold index, whether it was intersecting and visible, when it was last updated) — which targets an update finds
// due, past the observer's delay, and which of them moved, their entries owed. The observers themselves — their
// callbacks, roots, margins and thresholds, the entries queued for them — are the bindings' (observers.js), which name
// each by the number `ioCreate` gave it and measure the targets (`observeIntersections`: intersection.rs).

use crate::dom::{nid_arg, realm_id, NodeId, RealmArena};
use crate::observation_list::ObservationList;

struct Registration {
    // The target, held — a root, which the realm's context going lets go of (`discard_intersection_observers`).
    held: v8::Global<v8::Value>,
    // -1 at first, which differs from every index an update computes, so the first update reports.
    previous_index: f64,
    previous_intersecting: bool,
    previous_visible: bool,
    last_update: f64,
}

struct Observer {
    id: u32,
    delay: f64,
    // In the order observed: a target observed again keeps its place and its registration.
    targets: ObservationList<Registration>,
}

#[derive(Default)]
pub(crate) struct IntersectionObservers {
    // In creation order: ids only grow, and an observer joins as it first observes something, so it is kept sorted.
    observing: Vec<Observer>,
    next: u32,
    // Whether the last update skipped a target for its observer's delay: one more update is owed once it is over.
    skipped: bool,
}

impl IntersectionObservers {
    fn observer(&mut self, id: u32) -> Option<&mut Observer> {
        self.observing.iter_mut().find(|o| o.id == id)
    }
}

impl RealmArena {
    // Whether any of realm `cid`'s registrations' targets is another realm's node, as they now stand — an update finds
    // an adoption since, an unobserve or a disconnect may leave none.
    pub(crate) fn note_intersection_foreign(&mut self, cid: i32) {
        let foreign = self.intersection_observers.observing.iter().any(|o| o.targets.iter().any(|(_, t, _)| self.get(t).is_some_and(|n| n.realm != cid)));
        self.note_foreign(cid, crate::foreign_observations::INTERSECTION, foreign);
    }
    // Realm `cid`'s context disposed: its registrations' targets held no more, nor what they reach of its heap.
    pub(crate) fn discard_intersection_observers(&mut self, cid: i32) {
        let observers = if cid == self.cur() { Some(&mut self.intersection_observers) } else { self.parked_state(cid).map(|s| &mut s.intersection_observers) };
        if let Some(observers) = observers {
            observers.observing.clear();
        }
    }
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "ioCreate", io_create, context_id);
    crate::dom::register(scope, ns, "ioObserve", io_observe, context_id);
    crate::dom::register(scope, ns, "ioUnobserve", io_unobserve, context_id);
    crate::dom::register(scope, ns, "ioDisconnect", io_disconnect, context_id);
    crate::dom::register(scope, ns, "ioObserving", io_observing, context_id);
    crate::dom::register(scope, ns, "ioDue", io_due, context_id);
    crate::dom::register(scope, ns, "ioSkipped", io_skipped, context_id);
    crate::dom::register(scope, ns, "ioRecord", io_record, context_id);
}

// __dom.ioCreate() -> a new IntersectionObserver's number, which orders it among the realm's.
fn io_create(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    let observers = &mut crate::dom::realm(scope, cid).intersection_observers;
    let id = observers.next;
    observers.next += 1;
    rv.set_uint32(id);
}

// __dom.ioObserve(id, delay, targetNid, target) -> whether the observer observes the target anew — not where it does
// already, nor where the realm's context is gone (its target would root it).
fn io_observe(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = args.get(0).uint32_value(scope) else { return rv.set_bool(false) };
    let delay = args.get(1).number_value(scope).unwrap_or(0.0);
    let Some(target) = nid_arg(scope, &args, 2) else { return rv.set_bool(false) };
    let node = args.get(3);
    let cid = realm_id(scope, &args);
    if !node.is_object() || crate::dom::realm(scope, cid).context_gone(cid) {
        return rv.set_bool(false);
    }
    let held = v8::Global::new(scope, node);
    let arena = crate::dom::realm(scope, cid);
    arena.note_observed(cid, crate::foreign_observations::INTERSECTION, target);
    let observers = &mut arena.intersection_observers;
    if observers.observer(id).is_none() {
        let at = observers.observing.partition_point(|o| o.id < id);
        observers.observing.insert(at, Observer { id, delay, targets: ObservationList::default() });
    }
    let observer = observers.observer(id).expect("inserted above");
    if observer.targets.contains(target) {
        return rv.set_bool(false);
    }
    observer.targets.push(target, Registration {
        held,
        previous_index: -1.0,
        previous_intersecting: false,
        previous_visible: false,
        last_update: f64::NEG_INFINITY
    });
    rv.set_bool(true);
}

// __dom.ioUnobserve(id, target) -> whether the realm still holds the observer: one left observing nothing is no longer
// the realm's to visit.
fn io_unobserve(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = args.get(0).uint32_value(scope) else { return rv.set_bool(false) };
    let target = nid_arg(scope, &args, 1);
    let cid = realm_id(scope, &args);
    let observers = &mut crate::dom::realm(scope, cid).intersection_observers;
    let Some(observer) = observers.observer(id) else { return rv.set_bool(false) };
    if let Some(target) = target {
        observer.targets.remove(target);
    }
    let held = !observer.targets.is_empty();
    if !held {
        observers.observing.retain(|o| o.id != id);
    }
    crate::dom::realm(scope, cid).note_intersection_foreign(cid);
    rv.set_bool(held);
}

// __dom.ioDisconnect(id) — the observer observes nothing.
fn io_disconnect(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = args.get(0).uint32_value(scope) else { return };
    let cid = realm_id(scope, &args);
    let arena = crate::dom::realm(scope, cid);
    arena.intersection_observers.observing.retain(|o| o.id != id);
    arena.note_intersection_foreign(cid);
}

// __dom.ioObserving() -> whether any of the realm's IntersectionObservers observes anything.
fn io_observing(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    rv.set_bool(!crate::dom::realm(scope, cid).intersection_observers.observing.is_empty());
}

// __dom.ioDue(time) -> for each observer in creation order with any target due — not updated within its delay — its
// number and those targets, `[id, targets]`, each of them updated at `time` now; whether any was skipped for its
// delay is `ioSkipped`'s.
fn io_due(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let time = args.get(0).number_value(scope).unwrap_or(0.0);
    let cid = realm_id(scope, &args);
    let observers = &mut crate::dom::realm(scope, cid).intersection_observers;
    let mut skipped = false;
    let mut due: Vec<(u32, Vec<v8::Global<v8::Value>>)> = Vec::new();
    for observer in &mut observers.observing {
        let mut targets = Vec::new();
        for (_, _, r) in observer.targets.iter_mut() {
            if time - r.last_update < observer.delay {
                skipped = true;
                continue;
            }
            r.last_update = time;
            targets.push(r.held.clone());
        }
        if !targets.is_empty() {
            due.push((observer.id, targets));
        }
    }
    observers.skipped = skipped;
    // (…and whether any target is another realm's node, whose changes its realm's then ask this one's update for)
    crate::dom::realm(scope, cid).note_intersection_foreign(cid);
    let rows: Vec<v8::Local<v8::Value>> = due
        .iter()
        .map(|(id, targets)| {
            let targets: Vec<v8::Local<v8::Value>> = targets.iter().map(|g| v8::Local::new(scope, g)).collect();
            let targets = v8::Array::new_with_elements(scope, &targets);
            let id = v8::Integer::new_from_unsigned(scope, *id);
            v8::Array::new_with_elements(scope, &[id.into(), targets.into()]).into()
        })
        .collect();
    rv.set(v8::Array::new_with_elements(scope, &rows).into());
}

// __dom.ioSkipped() -> whether the last update skipped a target for its observer's delay.
fn io_skipped(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    rv.set_bool(crate::dom::realm(scope, cid).intersection_observers.skipped);
}

// __dom.ioRecord(id, measured) -> which of the targets an update measured moved — `measured` four numbers a target,
// its nid, its threshold index, whether it is intersecting and whether it is visible (1 or 0) — each 1 where its
// threshold index, its intersecting or its visible state differs from its registration's, its entry owed; the
// registrations take them as their previous ones.
fn io_record(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = args.get(0).uint32_value(scope) else { return };
    let measured = crate::dom::f64_arg(args.get(1)).to_vec();
    let cid = realm_id(scope, &args);
    let observers = &mut crate::dom::realm(scope, cid).intersection_observers;
    let mut moved = Vec::with_capacity(measured.len() / 4);
    let mut registrations = observers.observer(id).map(|o| &mut o.targets);
    for m in measured.chunks_exact(4) {
        let target = NodeId::from_i64(m[0] as i64);
        let (index, intersecting, visible) = (m[1], m[2] != 0.0, m[3] != 0.0);
        // (…none for one unobserved since it was measured — no page script runs between the two)
        let Some(r) = registrations.as_mut().zip(target).and_then(|(rs, t)| rs.get_mut(t)) else {
            moved.push(0.0);
            continue;
        };
        let changed = index != r.previous_index || intersecting != r.previous_intersecting || visible != r.previous_visible;
        moved.push(if changed { 1.0 } else { 0.0 });
        r.previous_index = index;
        r.previous_intersecting = intersecting;
        r.previous_visible = visible;
    }
    rv.set(crate::dom::f64_array(scope, &moved).into());
}
