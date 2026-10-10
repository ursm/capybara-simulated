// Mutation observers (DOM §4.3): every node's registered observer list — transient registered observers included —
// each observer's node list and transient node set, and which observers a mutation interests ("queue a mutation
// record"). The observers themselves, their callbacks and record queues, are the bindings' (mutation-observer.js), which
// name each by the number `create` gave it; the lists live with the nodes, so the ancestor walks a record and a removal
// make are the arena's.

use std::collections::HashMap;
use std::rc::Rc;

use crate::dom::{nid_arg, realm_id, utf16_arg, NodeId, RealmArena};

// MutationObserverInit, as `observe` gives it: which kinds of change, over the subtree or the node, with old values.
const CHILD_LIST: u32 = 1;
const ATTRIBUTES: u32 = 2;
const CHARACTER_DATA: u32 = 4;
const SUBTREE: u32 = 8;
const ATTRIBUTE_OLD_VALUE: u32 = 16;
const CHARACTER_DATA_OLD_VALUE: u32 = 32;

struct Options {
    flags: u32,
    // The attribute local names an attributes record must have one of, where given.
    filter: Option<Vec<Vec<u16>>>,
}

// A registered observer: its observer, its options, and — a transient one — the node whose registered observer it was
// made from (that node's registration of the same observer: its source), whose options it shares.
struct Registered {
    observer: u32,
    options: Rc<Options>,
    source: Option<NodeId>,
}

#[derive(Default)]
pub(crate) struct Observers {
    lists: HashMap<NodeId, Vec<Registered>>,
    // Each observer's node list — where it is registered — and transient node set.
    nodes: HashMap<u32, Vec<NodeId>>,
    transient: HashMap<u32, Vec<NodeId>>,
    // Each observer's realm — the one whose bindings made it, and hold its callback and record queue — by its number,
    // the isolate's: a change one realm's script makes may interest an observer another's made.
    realms: HashMap<u32, i32>,
    next: u32,
    // The realms with records, transient registrations or signaled slots waiting to be notified — the agent's pending
    // mutation observers, by realm (which holds them): one notification, in whichever realm it runs, takes them all.
    pending: Vec<i32>,
    // What every realm's bindings read without a call (`moFlags`, a view each of the one buffer): [0] whether any node
    // has a registered observer — which a change must then ask about, whichever realm's script made it — [1] whether
    // the agent's mutation observer microtask is queued, [2] whether observers are being notified.
    flags: Option<v8::SharedRef<v8::BackingStore>>,
    // The realm whose microtask queue holds the agent's mutation observer microtask, while one does (`moQueue`).
    queued_in: Option<i32>,
}

const ANY_REGISTERED: usize = 0;
const MICROTASK_QUEUED: usize = 1;

impl Observers {
    // (…[0] kept as the lists are)
    fn sync(&self) {
        if let Some(flags) = &self.flags {
            flags[ANY_REGISTERED].set(u8::from(!self.lists.is_empty()));
        }
    }

    // "observe" past its option checks: `observer`'s registration of `target` given the options anew — the transient
    // ones made from it dropped, as they no longer say what it observes — or made.
    fn observe(&mut self, observer: u32, target: NodeId, options: Rc<Options>) {
        let list = self.lists.entry(target).or_default();
        if let Some(registered) = list.iter_mut().find(|r| r.observer == observer && r.source.is_none()) {
            registered.options = options;
            for node in self.transient.get(&observer).into_iter().flatten() {
                if let Some(list) = self.lists.get_mut(node) {
                    list.retain(|r| !(r.observer == observer && r.source == Some(target)));
                }
            }
        } else {
            list.push(Registered { observer, options, source: None });
            self.nodes.entry(observer).or_default().push(target);
        }
        self.sync();
    }

    // "disconnect": every registered observer of `observer` dropped, from its node list and its transient node set.
    fn disconnect(&mut self, observer: u32) {
        let nodes = self.nodes.remove(&observer).into_iter().flatten();
        for node in nodes.chain(self.transient.remove(&observer).into_iter().flatten()) {
            if let Some(list) = self.lists.get_mut(&node) {
                list.retain(|r| r.observer != observer);
                if list.is_empty() {
                    self.lists.remove(&node);
                }
            }
        }
        self.sync();
    }

    // "remove transient registered observers" for `observer`, as its notification begins.
    fn remove_transients(&mut self, observer: u32) {
        for node in self.transient.remove(&observer).into_iter().flatten() {
            if let Some(list) = self.lists.get_mut(&node) {
                list.retain(|r| r.observer != observer || r.source.is_none());
                if list.is_empty() {
                    self.lists.remove(&node);
                }
            }
        }
        self.sync();
    }

    // Realm `cid` is gone — a frame removed or navigated, a page left: its observers observe nothing more, as nothing
    // can notify them, and nothing of it is pending. (Its notification microtask, where it had one queued, went with it:
    // the next change queues another; one another realm queued stays.)
    pub(crate) fn drop_realm(&mut self, cid: i32) {
        let gone: Vec<u32> = self.realms.iter().filter(|&(_, &c)| c == cid).map(|(&o, _)| o).collect();
        for observer in gone {
            self.disconnect(observer);
            self.realms.remove(&observer);
        }
        self.pending.retain(|&c| c != cid);
        if self.queued_in == Some(cid) {
            self.queued_in = None;
            if let Some(flags) = &self.flags {
                flags[MICROTASK_QUEUED].set(0);
            }
        }
    }

    // A freed node's list goes with it, and its place in the node list or transient node set of each observer it named.
    pub(crate) fn forget(&mut self, id: NodeId) {
        if self.lists.is_empty() {
            return;
        }
        if let Some(list) = self.lists.remove(&id) {
            self.unlist(id, &list);
            self.sync();
        }
    }
    // …and those of nodes freed wholesale.
    pub(crate) fn retain(&mut self, live: impl Fn(&NodeId) -> bool) {
        let freed: Vec<NodeId> = self.lists.keys().copied().filter(|id| !live(id)).collect();
        for id in freed {
            self.forget(id);
        }
    }
    fn unlist(&mut self, id: NodeId, list: &[Registered]) {
        for r in list {
            let lists = if r.source.is_none() { &mut self.nodes } else { &mut self.transient };
            if let Some(nodes) = lists.get_mut(&r.observer) {
                nodes.retain(|&n| n != id);
            }
        }
    }
}

// The change a record is of: its type, and for an attribute its local name and whether it has a namespace.
pub(crate) enum Change<'a> {
    ChildList,
    Attributes(&'a [u16], bool),
    CharacterData,
}

impl RealmArena {
    // "queue a mutation record"'s interested observers: of the registered observers of `target`'s inclusive ancestors,
    // each whose options take the change — a node's that is not the target only with `subtree` — once, in the order
    // first met, with whether any of its registrations asks for the old value.
    pub(crate) fn interested_observers(&self, target: NodeId, change: &Change<'_>) -> Vec<(u32, bool)> {
        let mut out: Vec<(u32, bool)> = Vec::new();
        let lists = &self.observers.lists;
        if lists.is_empty() {
            return out;
        }
        let mut at = Some(target);
        while let Some(node) = at {
            for r in lists.get(&node).into_iter().flatten() {
                let flags = r.options.flags;
                if node != target && flags & SUBTREE == 0 {
                    continue;
                }
                let (takes, old) = match change {
                    Change::ChildList => (flags & CHILD_LIST != 0, false),
                    Change::CharacterData => (flags & CHARACTER_DATA != 0, flags & CHARACTER_DATA_OLD_VALUE != 0),
                    Change::Attributes(name, namespaced) => (
                        flags & ATTRIBUTES != 0
                            && r.options.filter.as_ref().is_none_or(|f| !namespaced && f.iter().any(|n| n == name)),
                        flags & ATTRIBUTE_OLD_VALUE != 0,
                    ),
                };
                if !takes {
                    continue;
                }
                match out.iter_mut().find(|(o, _)| *o == r.observer) {
                    Some(entry) => entry.1 |= old,
                    None => out.push((r.observer, old)),
                }
            }
            at = self.get(node).and_then(|n| n.parent);
        }
        out
    }

    // "add transient registered observers" given `node` and `parent`, as `node` is removed from `parent` or moved out of
    // it: a transient registered observer on `node` for each `subtree` one of `parent`'s inclusive ancestors — of its
    // source's, where it is one itself — but where `node` has one from that source already. The observers given one,
    // which are pending from now on.
    pub(crate) fn add_transient_observers(&mut self, node: NodeId, parent: NodeId) -> Vec<u32> {
        if self.observers.lists.is_empty() {
            return Vec::new();
        }
        let mut made: Vec<(u32, Rc<Options>, NodeId)> = Vec::new();
        let mut at = Some(parent);
        while let Some(ancestor) = at {
            for r in self.observers.lists.get(&ancestor).into_iter().flatten() {
                if r.options.flags & SUBTREE != 0 {
                    made.push((r.observer, Rc::clone(&r.options), r.source.unwrap_or(ancestor)));
                }
            }
            at = self.get(ancestor).and_then(|n| n.parent);
        }
        if made.is_empty() {
            return Vec::new();
        }
        let store = &mut self.observers;
        let mut pending = Vec::new();
        let list = store.lists.entry(node).or_default();
        for (observer, options, source) in made {
            if list.iter().any(|r| r.observer == observer && r.source == Some(source)) {
                continue;
            }
            list.push(Registered { observer, options, source: Some(source) });
            store.transient.entry(observer).or_default().push(node);
            store.flags.iter().for_each(|f| f[ANY_REGISTERED].set(1));
            if !pending.contains(&observer) {
                pending.push(observer);
            }
        }
        pending
    }
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "moCreate", create, context_id);
    crate::dom::register(scope, ns, "moObserve", observe, context_id);
    crate::dom::register(scope, ns, "moDisconnect", disconnect, context_id);
    crate::dom::register(scope, ns, "moRemoveTransients", remove_transients, context_id);
    crate::dom::register(scope, ns, "moInterested", interested, context_id);
    crate::dom::register(scope, ns, "moAddTransients", add_transients, context_id);
    crate::dom::register(scope, ns, "moAddTransientsOfChildren", add_transients_of_children, context_id);
    crate::dom::register(scope, ns, "moRealm", realm_of, context_id);
    crate::dom::register(scope, ns, "moPend", pend, context_id);
    crate::dom::register(scope, ns, "moQueue", queue, context_id);
    crate::dom::register(scope, ns, "moTakePending", take_pending, context_id);
    crate::dom::register(scope, ns, "moHasPending", has_pending, context_id);
    crate::dom::register(scope, ns, "moDropRealm", drop_realm, context_id);
    // (…and the flags, a view on the isolate's one buffer)
    let store = {
        let observers = &mut crate::dom::dom(scope).arena.observers;
        observers.flags.get_or_insert_with(|| v8::ArrayBuffer::new_backing_store_from_vec(vec![0u8; 3]).make_shared()).clone()
    };
    let buffer = v8::ArrayBuffer::with_backing_store(scope, &store);
    if let (Some(view), Some(key)) = (v8::Uint8Array::new(scope, buffer, 0, 3), v8::String::new(scope, "moFlags")) {
        ns.set(scope, key.into(), view.into());
    }
}

// __dom.moPend(): the calling realm has observers to notify (records, transient registrations) or slots signaled.
fn pend(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    let pending = &mut crate::dom::dom(scope).arena.observers.pending;
    if !pending.contains(&cid) {
        pending.push(cid);
    }
}

// __dom.moQueue(): the agent's mutation observer microtask is queued, in the calling realm's queue (flag [1]).
fn queue(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    let observers = &mut crate::dom::dom(scope).arena.observers;
    observers.queued_in = Some(cid);
    if let Some(flags) = &observers.flags {
        flags[MICROTASK_QUEUED].set(1);
    }
}

// __dom.moTakePending() -> [cid] — the realms `moPend` named since, emptied.
fn take_pending(scope: &mut v8::PinScope<'_, '_>, _args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cids = std::mem::take(&mut crate::dom::dom(scope).arena.observers.pending);
    let values: Vec<v8::Local<'_, v8::Value>> = cids.iter().map(|&c| v8::Integer::new(scope, c).into()).collect();
    rv.set(v8::Array::new_with_elements(scope, &values).into());
}

// __dom.moHasPending() -> whether any realm has observers to notify or slots signaled.
fn has_pending(scope: &mut v8::PinScope<'_, '_>, _args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    rv.set_bool(!crate::dom::dom(scope).arena.observers.pending.is_empty());
}

// __dom.moDropRealm(cid) — realm `cid` is gone (`Observers::drop_realm`).
fn drop_realm(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    if let Some(cid) = args.get(0).int32_value(scope) {
        crate::dom::dom(scope).arena.observers.drop_realm(cid);
    }
}

// The arena of the realm a binding is called in.
fn arena<'s>(scope: &'s mut v8::PinScope<'_, '_>, args: &v8::FunctionCallbackArguments<'_>) -> &'s mut RealmArena {
    let cid = realm_id(scope, args);
    crate::dom::realm(scope, cid)
}

// __dom.moCreate() -> a new observer's number, the isolate's, of the realm calling.
fn create(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    let store = &mut crate::dom::realm(scope, cid).observers;
    store.next += 1;
    store.realms.insert(store.next, cid);
    rv.set_uint32(store.next);
}

// __dom.moRealm(observer) -> the context id of the realm that made the observer, or undefined.
fn realm_of(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let observer = args.get(0).uint32_value(scope).unwrap_or(0);
    if let Some(&cid) = arena(scope, &args).observers.realms.get(&observer) {
        rv.set_int32(cid);
    }
}

// __dom.moObserve(observer, nid, flags, filter) — `filter` the attribute names given, or null.
fn observe(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let observer = args.get(0).uint32_value(scope).unwrap_or(0);
    let Some(target) = nid_arg(scope, &args, 1) else { return };
    let flags = args.get(2).uint32_value(scope).unwrap_or(0);
    let filter = v8::Local::<v8::Array>::try_from(args.get(3)).ok().map(|names| {
        let mut filter = Vec::new();
        for i in 0..names.length() {
            if let Some(name) = names.get_index(scope, i) {
                filter.push(utf16_arg(scope, name));
            }
        }
        filter
    });
    arena(scope, &args).observers.observe(observer, target, Rc::new(Options { flags, filter }));
}

// __dom.moDisconnect(observer).
fn disconnect(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let observer = args.get(0).uint32_value(scope).unwrap_or(0);
    arena(scope, &args).observers.disconnect(observer);
}

// __dom.moRemoveTransients(observer).
fn remove_transients(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let observer = args.get(0).uint32_value(scope).unwrap_or(0);
    arena(scope, &args).observers.remove_transients(observer);
}

// __dom.moInterested(nid, type, name, namespaced) -> the interested observers, each as `observer * 2 + wantsOldValue`:
// the one number where there is one, as most changes have (no array made per mutation), an array of them where there are
// more, undefined for none — `type` 0 a childList record, 1 an attributes one (of the local name `name`, with a namespace
// or not), 2 a characterData one.
fn interested(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(target) = nid_arg(scope, &args, 0) else { return };
    if arena(scope, &args).observers.lists.is_empty() {
        return;
    }
    let kind = args.get(1).uint32_value(scope).unwrap_or(0);
    let name = if kind == 1 { utf16_arg(scope, args.get(2)) } else { Vec::new() };
    let change = match kind {
        0 => Change::ChildList,
        1 => Change::Attributes(&name, args.get(3).boolean_value(scope)),
        _ => Change::CharacterData,
    };
    let found = arena(scope, &args).interested_observers(target, &change);
    let packed = |&(o, old): &(u32, bool)| f64::from(o) * 2.0 + f64::from(u8::from(old));
    match found.as_slice() {
        [] => {}
        [one] => rv.set_double(packed(one)),
        many => {
            let numbers: Vec<v8::Local<'_, v8::Value>> = many.iter().map(|o| v8::Number::new(scope, packed(o)).into()).collect();
            rv.set(v8::Array::new_with_elements(scope, &numbers).into());
        }
    }
}

// __dom.moAddTransients(nid, parentNid) -> the observers `add_transient_observers` gave a transient registered observer
// (`observer_list`) — what `removeChild` answers too, as it removes a node.
fn add_transients(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let (Some(node), Some(parent)) = (nid_arg(scope, &args, 0), nid_arg(scope, &args, 1)) else { return };
    let given = arena(scope, &args).add_transient_observers(node, parent);
    if let Some(list) = observer_list(scope, &given) {
        rv.set(list);
    }
}

// __dom.moAddTransientsOfChildren(parentNid) -> `moAddTransients` for each child of the parent, as they are all removed
// at once (the observers given one, `observer_list`).
fn add_transients_of_children(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(parent) = nid_arg(scope, &args, 0) else { return };
    let arena = arena(scope, &args);
    let mut given: Vec<u32> = Vec::new();
    if !arena.observers.lists.is_empty() {
        let children = arena.get(parent).map_or_else(Vec::new, |p| p.children.clone());
        for child in children {
            for observer in arena.add_transient_observers(child, parent) {
                if !given.contains(&observer) {
                    given.push(observer);
                }
            }
        }
    }
    if let Some(list) = observer_list(scope, &given) {
        rv.set(list);
    }
}

// Observers, as the bindings are handed them: an array of their numbers, or none for none.
pub(crate) fn observer_list<'s>(scope: &mut v8::PinScope<'s, '_>, observers: &[u32]) -> Option<v8::Local<'s, v8::Value>> {
    if observers.is_empty() {
        return None;
    }
    let numbers: Vec<v8::Local<'_, v8::Value>> = observers.iter().map(|&o| v8::Integer::new_from_unsigned(scope, o).into()).collect();
    Some(v8::Array::new_with_elements(scope, &numbers).into())
}
