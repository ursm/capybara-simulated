// The custom element reactions (HTML §4.13.6): each custom element's reaction queue — the callbacks it is owed, each
// with its arguments, in the order they were enqueued — and the agent's custom element reactions stack, whose element
// queues name the elements whose queues a [CEReactions] call has to run as it returns, and its backup element queue,
// which the microtask the bindings queue for it runs. The isolate's, as the agent is.
//
// The stack's depth is the bindings': a [CEReactions] call adds one as it begins and takes it away as it returns
// (`ceStack[0]`, a view each realm's bindings write with no call), so a call that enqueues nothing costs no crossing.
// An element enqueued while a call runs goes on the queue of the depth it runs at; and the deepest depth with an
// element is `ceStack[1]`, which the returning call reads to tell whether it has reactions to run (`ceTakeQueue`).
// Whether the backup element queue holds an element is `ceStack[2]`, which every microtask checkpoint reads: the
// microtask queued for it is one realm's, which a page left or a frame removed takes with it.
//
// What a reaction calls is its element's custom element definition's: the callbacks the definition captured as it was
// defined (HTML "define" step 14, a later write to the prototype changing nothing it calls) and the attributes it
// observes, which a custom element is given as it becomes one (`ceSetDefinition`). So a tree change enqueues what it
// owes the custom elements it moved with no walk of the bindings' (`ceSubtreeHook`).

use std::collections::{HashMap, HashSet, VecDeque};

use crate::dom::{dom, nid_arg, realm, realm_id, register, utf16_arg, NodeId};

// A definition's callbacks, by what they are called for — the bindings' order (custom-elements.js `CALLBACKS`), of which
// these the engine names.
const CONNECTED: usize = 0;
const DISCONNECTED: usize = 1;
const CONNECTED_MOVE: usize = 2;
const ATTRIBUTE_CHANGED: usize = 4;
const CALLBACKS: usize = 9;

// A custom element definition, as the engine needs it: the callbacks it captured, and the attributes it observes by
// local name, in code units as a DOMString compares — the realm that defined it, which takes it when it goes.
struct Definition {
    realm: i32,
    callbacks: Vec<Option<v8::Global<v8::Value>>>,
    observed: HashSet<Vec<u16>>,
}

// One callback a custom element is owed: the callback, and its arguments.
struct Reaction {
    callback: v8::Global<v8::Value>,
    args: Vec<v8::Global<v8::Value>>,
}

#[derive(Default)]
pub(crate) struct Reactions {
    view: Option<v8::SharedRef<v8::BackingStore>>,
    // The element queue of each depth of the stack (index 0 unused: depth 0 is no call running, whose elements go on
    // the backup element queue), each element held, as it may be no tree's.
    levels: Vec<Vec<(NodeId, v8::Global<v8::Value>)>>,
    backup: Vec<(NodeId, v8::Global<v8::Value>)>,
    // Whether the backup element queue's microtask is queued (HTML "processing the backup element queue" flag).
    backup_queued: bool,
    queues: HashMap<NodeId, VecDeque<Reaction>>,
    // Every definition made (an index is its id), and the definition of each custom element.
    definitions: Vec<Option<Definition>>,
    custom: HashMap<NodeId, u32>,
}

const DEPTH: usize = 0;
const DEEPEST: usize = 1;
const BACKUP: usize = 2;

impl Reactions {
    fn get(&self, at: usize) -> i32 {
        self.view.as_ref().map_or(0, |v| {
            let bytes: [u8; 4] = std::array::from_fn(|i| v[at * 4 + i].get());
            i32::from_ne_bytes(bytes)
        })
    }
    fn set(&self, at: usize, value: i32) {
        if let Some(v) = &self.view {
            for (i, b) in value.to_ne_bytes().into_iter().enumerate() {
                v[at * 4 + i].set(b);
            }
        }
    }
    // A page of the main realm's begins: no call runs (a terminated one left its depth), so the elements its element
    // queues held are the backup element queue's — whose microtask, too, may have gone with the call.
    pub(crate) fn unwind(&mut self) {
        for level in self.levels.drain(..) {
            self.backup.extend(level);
        }
        self.set(DEPTH, 0);
        self.set(DEEPEST, 0);
        self.microtask_lost();
    }
    // The backup element queue's microtask taken as lost: a checkpoint runs the queue where it holds an element
    // (`ceStack[2]`).
    fn microtask_lost(&mut self) {
        self.backup_queued = false;
        self.set(BACKUP, i32::from(!self.backup.is_empty()));
    }
    // The reactions owed to the elements `gone` names — a dropped realm's — let go of, with their definitions and those
    // realm `cid` made; and the backup element queue's microtask taken as lost, which a realm leaving may take with it (a
    // checkpoint runs the queue then: `ceStack[2]`).
    pub(crate) fn forget(&mut self, cid: i32, gone: impl Fn(NodeId) -> bool) {
        for def in &mut self.definitions {
            if def.as_ref().is_some_and(|d| d.realm == cid) {
                *def = None;
            }
        }
        self.custom.retain(|&id, _| !gone(id));
        self.queues.retain(|&id, _| !gone(id));
        self.backup.retain(|&(id, _)| !gone(id));
        for level in &mut self.levels {
            level.retain(|&(id, _)| !gone(id));
        }
        self.microtask_lost();
    }
    // The elements of the backup element queue `of` names, taken — all of them its microtask no longer queued.
    pub(crate) fn take_backup(&mut self, of: impl Fn(NodeId) -> bool) -> Vec<(NodeId, v8::Global<v8::Value>)> {
        let (taken, kept): (Vec<_>, Vec<_>) = std::mem::take(&mut self.backup).into_iter().partition(|&(id, _)| of(id));
        self.backup = kept;
        if self.backup.is_empty() {
            self.backup_queued = false;
        }
        self.set(BACKUP, i32::from(!self.backup.is_empty()));
        taken
    }
    // …and those of a node freed (a queue nothing drained: its element went with its realm's script mid-call).
    pub(crate) fn forget_node(&mut self, id: NodeId) {
        self.custom.remove(&id);
        if self.queues.remove(&id).is_some() {
            self.backup.retain(|&(n, _)| n != id);
            for level in &mut self.levels {
                level.retain(|&(n, _)| n != id);
            }
        }
    }
    // HTML "enqueue a custom element callback reaction" of `callback` with `args` for the element `id` (`element`, its
    // object), and "enqueue an element on the appropriate element queue" — the current call's, or the backup one: whether
    // the backup element queue's microtask is to be queued.
    fn enqueue(&mut self, id: NodeId, element: v8::Global<v8::Value>, callback: v8::Global<v8::Value>, args: Vec<v8::Global<v8::Value>>) -> bool {
        self.queues.entry(id).or_default().push_back(Reaction { callback, args });
        let depth = self.get(DEPTH).max(0) as usize;
        if depth == 0 {
            self.backup.push((id, element));
            self.set(BACKUP, 1);
            return !std::mem::replace(&mut self.backup_queued, true);
        }
        if self.levels.len() <= depth {
            self.levels.resize_with(depth + 1, Vec::new);
        }
        self.levels[depth].push((id, element));
        if self.get(DEEPEST) < depth as i32 {
            self.set(DEEPEST, depth as i32);
        }
        false
    }
    // The definition of custom element `id`.
    fn definition_of(&self, id: NodeId) -> Option<&Definition> {
        self.custom.get(&id).and_then(|&d| self.definitions.get(d as usize)).and_then(Option::as_ref)
    }
    // Its definition's `which` callback, where it has one.
    fn callback_of(&self, id: NodeId, which: usize) -> Option<&v8::Global<v8::Value>> {
        self.definition_of(id).and_then(|d| d.callbacks.get(which)).and_then(Option::as_ref)
    }
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    register(scope, ns, "ceTakeQueue", ce_take_queue, context_id);
    register(scope, ns, "ceTakeBackup", ce_take_backup, context_id);
    register(scope, ns, "ceTakeReaction", ce_take_reaction, context_id);
    register(scope, ns, "ceClear", ce_clear, context_id);
    register(scope, ns, "ceDefine", ce_define, context_id);
    register(scope, ns, "ceSetDefinition", ce_set_definition, context_id);
    register(scope, ns, "ceHasCallback", ce_has_callback, context_id);
    register(scope, ns, "ceHook", ce_hook, context_id);
    register(scope, ns, "ceEnqueueUpgrade", ce_enqueue_upgrade, context_id);
    register(scope, ns, "ceSubtreeHook", ce_subtree_hook, context_id);
    register(scope, ns, "ceAttributeChanged", ce_attribute_changed, context_id);
    // (…and the stack's depth and deepest queue, a view on the isolate's one buffer)
    let store = {
        let reactions = &mut dom(scope).arena.ce_reactions;
        reactions.view.get_or_insert_with(|| v8::ArrayBuffer::new_backing_store_from_vec(vec![0u8; 12]).make_shared()).clone()
    };
    let buffer = v8::ArrayBuffer::with_backing_store(scope, &store);
    if let (Some(view), Some(key)) = (v8::Int32Array::new(scope, buffer, 0, 3), v8::String::new(scope, "ceStack")) {
        ns.set(scope, key.into(), view.into());
    }
}

// The elements a queue named, as an array of their objects, in the order enqueued.
fn elements<'s>(scope: &mut v8::PinScope<'s, '_>, queue: Vec<(NodeId, v8::Global<v8::Value>)>) -> v8::Local<'s, v8::Value> {
    let objects: Vec<v8::Local<'s, v8::Value>> = queue.into_iter().map(|(_, o)| v8::Local::new(scope, o)).collect();
    v8::Array::new_with_elements(scope, &objects).into()
}

// __dom.ceTakeQueue(depth) -> the element queue of the call at `depth` that returns (HTML "pop the element queue"),
// taken — the elements whose reactions it runs — and the deepest queue with an element moved to the one below it.
fn ce_take_queue(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let depth = args.get(0).int32_value(scope).unwrap_or(0).max(0) as usize;
    let reactions = &mut dom(scope).arena.ce_reactions;
    let queue = reactions.levels.get_mut(depth).map(std::mem::take).unwrap_or_default();
    let deepest = reactions.levels[..depth.min(reactions.levels.len())].iter().rposition(|q| !q.is_empty()).unwrap_or(0);
    reactions.set(DEEPEST, deepest as i32);
    rv.set(elements(scope, queue));
}

// __dom.ceTakeBackup() -> the backup element queue, taken, its microtask no longer queued. __dom.ceTakeBackup(cid) ->
// only the elements realm `cid` made, which goes before the microtask can run (a frame navigated, synchronously here).
fn ce_take_backup(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let realm = if args.length() > 0 { args.get(0).int32_value(scope) } else { None };
    let arena = &mut dom(scope).arena;
    let queue = match realm {
        None => arena.ce_reactions.take_backup(|_| true),
        Some(cid) => arena.take_backup_of(cid),
    };
    rv.set(elements(scope, queue));
}

// __dom.ceTakeReaction(nid) -> `[callback, args]`: the first of the element's reactions, taken from its queue —
// undefined once it is empty (HTML "invoke custom element reactions": an element's reactions run until none is left,
// those its callbacks enqueue included). One at a time, as the rest stay the queue's: a callback's own [CEReactions]
// call runs them, before what it enqueued itself.
fn ce_take_reaction(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = nid_arg(scope, &args, 0) else { return };
    let queues = &mut dom(scope).arena.ce_reactions.queues;
    let Some(queue) = queues.get_mut(&id) else { return };
    let Some(reaction) = queue.pop_front() else { return };
    if queue.is_empty() {
        queues.remove(&id);
    }
    let callback = v8::Local::new(scope, reaction.callback);
    let list: Vec<v8::Local<'_, v8::Value>> = reaction.args.into_iter().map(|a| v8::Local::new(scope, a)).collect();
    let list = v8::Array::new_with_elements(scope, &list);
    rv.set(v8::Array::new_with_elements(scope, &[callback, list.into()]).into());
}

// __dom.ceClear(nid) — the element's reaction queue emptied (HTML "upgrade an element": a constructor that failed leaves
// it none of the reactions its upgrade enqueued).
fn ce_clear(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    if let Some(id) = nid_arg(scope, &args, 0) {
        dom(scope).arena.ce_reactions.queues.remove(&id);
    }
}

// The values of an array argument, held.
fn held_list(scope: &mut v8::PinScope<'_, '_>, value: v8::Local<'_, v8::Value>) -> Vec<v8::Global<v8::Value>> {
    match v8::Local::<v8::Array>::try_from(value) {
        Ok(a) => (0..a.length()).filter_map(|i| a.get_index(scope, i)).map(|v| v8::Global::new(scope, v)).collect(),
        Err(_) => Vec::new(),
    }
}

// __dom.ceDefine(callbacks, observed) -> the definition's id: a custom element definition made in the calling realm —
// `callbacks` its callbacks in `CALLBACKS` order (undefined for one it has not), `observed` the local names of the
// attributes it observes.
fn ce_define(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let realm = realm_id(scope, &args);
    let mut callbacks: Vec<Option<v8::Global<v8::Value>>> = held_list(scope, args.get(0))
        .into_iter()
        .map(|g| {
            let local = v8::Local::new(scope, &g);
            local.is_function().then_some(g)
        })
        .collect();
    callbacks.resize_with(CALLBACKS, || None);
    let observed = match v8::Local::<v8::Array>::try_from(args.get(1)) {
        Ok(a) => {
            let names: Vec<v8::Local<'_, v8::Value>> = (0..a.length()).filter_map(|i| a.get_index(scope, i)).collect();
            names.into_iter().map(|v| utf16_arg(scope, v)).collect()
        }
        Err(_) => HashSet::new(),
    };
    let definitions = &mut dom(scope).arena.ce_reactions.definitions;
    definitions.push(Some(Definition { realm, callbacks, observed }));
    rv.set_int32(definitions.len() as i32 - 1);
}

// __dom.ceSetDefinition(nid, id) — the element custom by definition `id` (HTML "upgrade an element" step 3, an element
// constructed custom); a negative `id` none (a failed upgrade takes it back).
fn ce_set_definition(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = nid_arg(scope, &args, 0) else { return };
    let def = args.get(1).int32_value(scope).unwrap_or(-1);
    let custom = &mut dom(scope).arena.ce_reactions.custom;
    if def < 0 {
        custom.remove(&id);
    } else {
        custom.insert(id, def as u32);
    }
}

// __dom.ceHasCallback(nid, which) -> whether the element's definition has its `which` callback.
fn ce_has_callback(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = nid_arg(scope, &args, 0) else { return rv.set_bool(false) };
    let which = args.get(1).int32_value(scope).unwrap_or(-1).max(0) as usize;
    rv.set_bool(dom(scope).arena.ce_reactions.callback_of(id, which).is_some());
}

// __dom.ceHook(nid, element, which, args) -> whether the backup element queue's microtask is to be queued: the element's
// definition's `which` callback, where it has one, enqueued with `args` (an array, or none).
fn ce_hook(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = nid_arg(scope, &args, 0) else { return rv.set_bool(false) };
    let which = args.get(2).int32_value(scope).unwrap_or(-1).max(0) as usize;
    let Some(callback) = dom(scope).arena.ce_reactions.callback_of(id, which).cloned() else { return rv.set_bool(false) };
    let element = v8::Global::new(scope, args.get(1));
    let list = held_list(scope, args.get(3));
    rv.set_bool(dom(scope).arena.ce_reactions.enqueue(id, element, callback, list));
}

// __dom.ceEnqueueUpgrade(nid, element, upgrade, args) -> whether the backup element queue's microtask is to be queued: HTML
// "enqueue a custom element upgrade reaction" — `upgrade`, the bindings' steps that upgrade the element, called on it with
// `args` (its definition's constructor) as its reactions run.
fn ce_enqueue_upgrade(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = nid_arg(scope, &args, 0) else { return rv.set_bool(false) };
    let element = v8::Global::new(scope, args.get(1));
    let upgrade = v8::Global::new(scope, args.get(2));
    let list = held_list(scope, args.get(3));
    rv.set_bool(dom(scope).arena.ce_reactions.enqueue(id, element, upgrade, list));
}

// __dom.ceSubtreeHook(rootNid, which, args) -> whether the backup element queue's microtask is to be queued: `which`
// enqueued with `args` for every custom element of the root's shadow-including inclusive descendants whose definition
// has it, in shadow-including tree order — the connected, disconnected and adopted callbacks a tree change owes. With
// `which` CONNECTED_MOVE, an element whose definition has no connectedMoveCallback is owed its disconnected and connected
// callbacks instead (HTML "Reactions to atomic move are called in order of element").
fn ce_subtree_hook(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(root) = nid_arg(scope, &args, 0) else { return rv.set_bool(false) };
    let which = args.get(1).int32_value(scope).unwrap_or(-1).max(0) as usize;
    let cid = realm_id(scope, &args);
    let upgraded = realm(scope, cid).upgraded_elements_in(root);
    let custom = &dom(scope).arena.ce_reactions.custom;
    let elements: Vec<NodeId> = upgraded.into_iter().filter(|id| custom.contains_key(id)).collect();
    if elements.is_empty() {
        return rv.set_bool(false);
    }
    let list = held_list(scope, args.get(2));
    let mut queue = false;
    for id in elements {
        let callbacks: Vec<v8::Global<v8::Value>> = {
            let reactions = &dom(scope).arena.ce_reactions;
            let mv = which == CONNECTED_MOVE && reactions.callback_of(id, CONNECTED_MOVE).is_none();
            let order: &[usize] = if mv { &[DISCONNECTED, CONNECTED] } else { std::slice::from_ref(&which) };
            order.iter().filter_map(|&w| reactions.callback_of(id, w).cloned()).collect()
        };
        if callbacks.is_empty() {
            continue;
        }
        let element = crate::dom::node_value(scope, Some(id));
        let element = v8::Global::new(scope, element);
        for callback in callbacks {
            queue |= dom(scope).arena.ce_reactions.enqueue(id, element.clone(), callback, list.clone());
        }
    }
    rv.set_bool(queue);
}

// __dom.ceAttributeChanged(nid, element, localName, oldValue, value, namespace) -> whether the backup element queue's
// microtask is to be queued: the element's attributeChangedCallback enqueued with the change, where its definition
// observes the attribute (HTML "handle attribute changes" step 2).
fn ce_attribute_changed(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = nid_arg(scope, &args, 0) else { return rv.set_bool(false) };
    let name = utf16_arg(scope, args.get(2));
    let callback = {
        let reactions = &dom(scope).arena.ce_reactions;
        reactions
            .definition_of(id)
            .filter(|d| d.observed.contains(&name))
            .and_then(|d| d.callbacks[ATTRIBUTE_CHANGED].clone())
    };
    let Some(callback) = callback else { return rv.set_bool(false) };
    let element = v8::Global::new(scope, args.get(1));
    let list = [args.get(2), args.get(3), args.get(4), args.get(5)].map(|v| v8::Global::new(scope, v)).to_vec();
    rv.set_bool(dom(scope).arena.ce_reactions.enqueue(id, element, callback, list));
}
