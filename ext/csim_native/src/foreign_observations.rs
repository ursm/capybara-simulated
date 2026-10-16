// The realms whose ResizeObservers or IntersectionObservers observe another realm's node — a page's of a frame's
// element, a frame's of the page's, one frame's of a sibling's, a target adopted into another document since it was
// observed — whose updates a change in ANY realm may owe a report, though it moves none of their own generations. A
// realm joins as one of its observers observes such a target, or a gather finds one (an adoption since), and leaves as
// its gathers find none; it is asked once — its pending flag raised — until its update runs. Every realm's bindings
// read whether there are any with no call (`__dom.foreignObserved`), so a page with none pays a load of the word per
// change.

use crate::dom::{realm_id, NodeId, RealmArena};

// Which kind of observer holds the foreign target, a bit each.
pub(crate) const RESIZE: u8 = 1;
pub(crate) const INTERSECTION: u8 = 2;

#[derive(Default)]
pub(crate) struct ForeignObservations {
    // Each such realm, with the kinds of its observers that do.
    realms: Vec<(i32, u8)>,
    // The ones asked since their update last ran.
    asked: Vec<i32>,
}

impl RealmArena {
    // Realm `cid`'s observers of `kind` hold `target`: another realm's node makes it one of them.
    pub(crate) fn note_observed(&mut self, cid: i32, kind: u8, target: NodeId) {
        if self.get(target).is_some_and(|n| n.realm != cid) {
            self.note_foreign(cid, kind, true);
        }
    }
    // …or a gather of them found whether any of their targets is another realm's.
    pub(crate) fn note_foreign(&mut self, cid: i32, kind: u8, any: bool) {
        let realms = &mut self.foreign_observations.realms;
        match (realms.iter().position(|&(r, _)| r == cid), any) {
            (Some(at), true) => realms[at].1 |= kind,
            (None, true) => realms.push((cid, kind)),
            (Some(at), false) => {
                realms[at].1 &= !kind;
                if realms[at].1 == 0 {
                    realms.remove(at);
                }
            }
            (None, false) => {}
        }
        let any = !self.foreign_observations.realms.is_empty();
        self.foreign_observed.set(u32::from(any));
    }
    // Realm `cid` gone — its context disposed or dropped — or the page begun anew (`None`): none of its observers left.
    pub(crate) fn forget_foreign_observations(&mut self, cid: Option<i32>) {
        let fo = &mut self.foreign_observations;
        match cid {
            Some(cid) => {
                fo.realms.retain(|&(r, _)| r != cid);
                fo.asked.retain(|&r| r != cid);
            }
            None => *fo = ForeignObservations::default(),
        }
        let any = !self.foreign_observations.realms.is_empty();
        self.foreign_observed.set(u32::from(any));
    }
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    let word = crate::dom::dom(scope).arena.foreign_observed.store();
    crate::dom::view_word(scope, ns, "foreignObserved", word);
    crate::dom::register(scope, ns, "foreignObserversToAsk", foreign_observers_to_ask, context_id);
    crate::dom::register(scope, ns, "foreignObservationsRan", foreign_observations_ran, context_id);
}

// __dom.foreignObserversToAsk() -> the realms other than this one whose observers observe another realm's node and
// were not asked since their update last ran — each of them asked now.
fn foreign_observers_to_ask(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    let fo = &mut crate::dom::dom(scope).arena.foreign_observations;
    let mut ask = Vec::new();
    for &(r, _) in &fo.realms {
        if r != cid && !fo.asked.contains(&r) {
            ask.push(r);
        }
    }
    fo.asked.extend(&ask);
    let values: Vec<v8::Local<v8::Value>> = ask.iter().map(|&r| v8::Integer::new(scope, r).into()).collect();
    rv.set(v8::Array::new_with_elements(scope, &values).into());
}

// __dom.foreignObservationsRan() — this realm's update ran: a change after it asks it again.
fn foreign_observations_ran(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    crate::dom::dom(scope).arena.foreign_observations.asked.retain(|&r| r != cid);
}
