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
//
// A node's custom element registry (HTML: an element's, a shadow root's, a document's) is its handle's, coded: none set
// (`UNSET`: it tracks its node document's), the template contents' null (`TRACKING`: its tree's document has none, but
// the node takes its new tree's as it goes into one that is no template's contents), the null registry (`NULL`, which
// stays) or a registry (`FIRST_REGISTRY` on, an index into `registries`). An insertion carries the tracking null in and
// out of template contents with no walk of the bindings' (`registry_insertion_steps`).

use std::collections::{HashMap, HashSet, VecDeque};

use crate::dom::{dom, nid_arg, realm, realm_id, register, utf16_arg, NodeId};

// A definition's callbacks, by what they are called for — the bindings' order (custom-elements.js `CALLBACKS`), of which
// these the engine names.
const CONNECTED: usize = 0;
const DISCONNECTED: usize = 1;
const CONNECTED_MOVE: usize = 2;
const ATTRIBUTE_CHANGED: usize = 4;
const FORM_ASSOCIATED: usize = 5;
const FORM_DISABLED: usize = 7;
const CALLBACKS: usize = 9;

// A custom element definition, as the engine needs it: the bindings' object for it (its name, local name and constructor,
// what a lookup answers with), the callbacks it captured, and the attributes it observes by local name, in code units as
// a DOMString compares. The object and the callbacks are held weakly — the bindings' object holds the callbacks, and its
// registry holds it — so nothing of the engine's keeps a realm alive; and a definition goes with the realm that made it
// (`forget_definitions_of`), its callbacks never run once its realm's page is left (Web IDL "check if we can run script").
struct Definition {
    // (…the realm that made it, which takes it with it: its callbacks run in no realm a page left)
    realm: i32,
    object: v8::Weak<v8::Value>,
    // (…an autonomous custom element's: its local name its name, where a customized built-in's extends another)
    autonomous: bool,
    callbacks: Vec<Option<v8::Weak<v8::Value>>>,
    observed: HashSet<Vec<u16>>,
}

// The codes of a node's registry association.
pub(crate) const UNSET: u32 = 0;
pub(crate) const TRACKING: u32 = 1;
pub(crate) const NULL: u32 = 2;
pub(crate) const FIRST_REGISTRY: u32 = 3;

// A CustomElementRegistry: its object — held weakly: it lives while a script holds it or a node is associated with it
// (node_handle.rs) — and whether it is scoped (every one a page constructs, not a window's), and its definitions, by name
// and, for a customized built-in, by the local name it extends and its name (HTML "look up a custom element definition").
struct Registry {
    object: v8::Weak<v8::Value>,
    scoped: bool,
    named: HashMap<String, u32>,
    builtins: HashMap<String, HashMap<String, u32>>,
    // (…keyed by `name_key`)
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
    registries: Vec<Option<Registry>>,
    // Each form-associated custom element's form owner and disabled state as its callbacks were last told them (none
    // before the first: no owner, enabled) — what a reset compares the element's new ones with.
    form_states: HashMap<NodeId, (Option<NodeId>, bool)>,
    // …and each id such an element's `form` attribute has named in a document, with the element the document's id
    // lookup gave it last: what an id's change there compares, so that one moving none of them resets nothing.
    form_ids: HashMap<(NodeId, String), Option<NodeId>>,
    // Each realm's window registry (its `customElements`, the latest context's of a realm id): the registry of a node with
    // neither a registry set nor a node document.
    window_registries: HashMap<i32, u32>,
}

impl Reactions {
    // Whether realm `realm`'s window registry defines an autonomous custom element named `name` — one the parser
    // constructs as it makes it.
    pub(crate) fn defines(&self, realm: i32, name: &str) -> bool {
        let Some(&code) = self.window_registries.get(&realm) else { return false };
        code.checked_sub(FIRST_REGISTRY)
            .and_then(|i| self.registries.get(i as usize))
            .and_then(Option::as_ref)
            .is_some_and(|r| r.named.contains_key(name))
    }
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
    // The reactions owed to the elements `gone` names — a dropped realm's — let go of, with their definitions; and the
    // backup element queue's microtask taken as lost, which a realm leaving may take with it (a checkpoint runs the queue
    // then: `ceStack[2]`).
    pub(crate) fn forget(&mut self, gone: impl Fn(NodeId) -> bool) {
        self.custom.retain(|&id, _| !gone(id));
        self.form_states.retain(|&id, _| !gone(id));
        self.form_ids.retain(|(doc, _), _| !gone(*doc));
        for found in self.form_ids.values_mut().filter(|f| f.is_some_and(&gone)) {
            *found = None;
        }
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
    // The definitions realm `cid` made, let go of as it goes or a page of it begins — out of their registries too — and the
    // registries no script holds nor node is associated with any more: a weak table's entries, swept.
    pub(crate) fn forget_definitions_of(&mut self, cid: i32) {
        let mut gone = HashSet::new();
        for (id, def) in self.definitions.iter_mut().enumerate() {
            if def.as_ref().is_some_and(|d| d.realm == cid || d.object.is_empty()) {
                gone.insert(id as u32);
                *def = None;
            }
        }
        // (…an element custom by one names it no more: its slot is another's next)
        if !gone.is_empty() {
            self.custom.retain(|_, d| !gone.contains(d));
        }
        for registry in &mut self.registries {
            if registry.as_ref().is_some_and(|r| r.object.is_empty()) {
                *registry = None;
            }
            if let Some(r) = registry.as_mut().filter(|_| !gone.is_empty()) {
                r.named.retain(|_, id| !gone.contains(id));
                r.builtins.retain(|_, m| {
                    m.retain(|_, id| !gone.contains(id));
                    !m.is_empty()
                });
            }
        }
        self.window_registries.retain(|_, &mut code| code.checked_sub(FIRST_REGISTRY).and_then(|i| self.registries.get(i as usize)).is_some_and(Option::is_some));
    }
    // The weak handles the definitions and registries hold, let go of with no reset: the isolate is gone (`Dom`'s drop).
    pub(crate) fn leak_weak_handles(&mut self) {
        std::mem::forget(std::mem::take(&mut self.definitions));
        std::mem::forget(std::mem::take(&mut self.registries));
    }
    // …and those of a node freed (a queue nothing drained: its element went with its realm's script mid-call).
    pub(crate) fn forget_node(&mut self, id: NodeId) {
        self.custom.remove(&id);
        self.form_states.remove(&id);
        if !self.form_ids.is_empty() {
            self.form_ids.retain(|(doc, _), _| *doc != id);
            for found in self.form_ids.values_mut().filter(|f| **f == Some(id)) {
                *found = None;
            }
        }
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
    // Whether `code` is a SCOPED registry — one a page constructed, not a window's.
    pub(crate) fn is_scoped_registry(&self, code: u32) -> bool {
        self.registry(code).is_some_and(|r| r.scoped)
    }
    // Whether `code` is a registry that is not scoped — a window's, which an insertion into template contents takes away.
    pub(crate) fn is_window_registry(&self, code: u32) -> bool {
        self.registry(code).is_some_and(|r| !r.scoped)
    }
    // The registry `code` names, where it is one its realm has not taken with it.
    fn registry(&self, code: u32) -> Option<&Registry> {
        code.checked_sub(FIRST_REGISTRY).and_then(|i| self.registries.get(i as usize)).and_then(Option::as_ref)
    }
    // The object of definition `id` — as a pointer, which `weak_local` makes the scope's object of: its `to_local` needs
    // the scope a borrow of the engine's state holds, and cloning the handle to get out of the borrow made one per lookup.
    fn definition_object(&self, id: u32) -> Option<*const v8::Weak<v8::Value>> {
        self.definitions.get(id as usize).and_then(Option::as_ref).map(|d| &d.object as *const _)
    }
    // HTML "look up a custom element definition" in registry `code`: an autonomous one named `local_name` whose local name
    // is its name, else a customized built-in extending `local_name` named `is`.
    // (`local_name` and `is` as `name_key` keys them)
    fn look_up(&self, code: u32, local_name: &str, is: Option<&str>) -> Option<u32> {
        let registry = self.registry(code)?;
        let autonomous = |id: &&u32| self.definitions.get(**id as usize).and_then(Option::as_ref).is_some_and(|d| d.autonomous);
        if let Some(&id) = registry.named.get(local_name).filter(autonomous) {
            return Some(id);
        }
        registry.builtins.get(local_name).and_then(|m| m.get(is?)).copied()
    }
    // The definition of custom element `id`.
    fn definition_of(&self, id: NodeId) -> Option<&Definition> {
        self.custom.get(&id).and_then(|&d| self.definitions.get(d as usize)).and_then(Option::as_ref)
    }
    // Its definition's `which` callback, where it has one.
    fn callback_of(&self, id: NodeId, which: usize) -> Option<*const v8::Weak<v8::Value>> {
        self.definition_of(id).and_then(|d| d.callbacks.get(which)).and_then(Option::as_ref).map(|w| w as *const _)
    }
}

impl crate::dom::RealmArena {
    // The registry association of node `id` (`UNSET` for one with no handle).
    fn registry_of(&self, id: NodeId) -> u32 {
        self.get(id).and_then(|n| n.link.handle()).map_or(UNSET, |h| h.registry())
    }
    // The insertion steps of the registry associations (DOM "insert" step 7.1's adopt, HTML's template contents owner
    // document): a node going into a tree that is no template's contents out of one that is leaves the tracking null —
    // its subtree's tracking nodes take their new tree's document's — and one going into template contents takes it,
    // every node of its subtree with none set or a window's registry (a scoped one, or the null one, stays).
    // The handles whose registry it took away, which the caller lets go of their registry objects (`release_registries`).
    pub(crate) fn registry_insertion_steps(&self, nodes: &[NodeId]) -> Vec<*const crate::node_handle::NodeHandle> {
        let mut released = Vec::new();
        for &node in nodes {
            let Some(parent) = self.parent_of(node) else { continue };
            let (into, code) = (self.registry_of(parent), self.registry_of(node));
            if code == TRACKING && into != TRACKING {
                self.set_registries(node, |c| (c == TRACKING).then_some(UNSET), &mut released);
            } else if into == TRACKING && code != TRACKING {
                self.set_registries(node, |c| (c == UNSET || self.ce_reactions.is_window_registry(c)).then_some(TRACKING), &mut released);
            }
        }
        released
    }
    // The registry association of `root` and each node of its tree under it (not a shadow tree's, nor a template's
    // contents), where `change` gives it another.
    // (…`released` gets the handles whose registry that took away)
    fn set_registries(&self, root: NodeId, change: impl Fn(u32) -> Option<u32>, released: &mut Vec<*const crate::node_handle::NodeHandle>) {
        let mut stack = vec![root];
        while let Some(id) = stack.pop() {
            let Some(n) = self.get(id) else { continue };
            if let Some(h) = n.link.handle() {
                if let Some(code) = change(h.registry()) {
                    if h.registry() >= FIRST_REGISTRY {
                        released.push(h as *const _);
                    }
                    h.set_registry_state(code);
                }
            }
            stack.extend(n.children.iter().copied());
        }
    }
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    register(scope, ns, "ceTakeQueue", ce_take_queue, context_id);
    register(scope, ns, "ceTakeBackup", ce_take_backup, context_id);
    register(scope, ns, "ceTakeReaction", ce_take_reaction, context_id);
    register(scope, ns, "ceClear", ce_clear, context_id);
    register(scope, ns, "ceDefine", ce_define, context_id);
    register(scope, ns, "ceSetDefinition", ce_set_definition, context_id);
    register(scope, ns, "ceDefinitionLive", ce_definition_live, context_id);
    register(scope, ns, "ceHasCallback", ce_has_callback, context_id);
    register(scope, ns, "ceHook", ce_hook, context_id);
    register(scope, ns, "ceEnqueueUpgrade", ce_enqueue_upgrade, context_id);
    register(scope, ns, "ceSubtreeHook", ce_subtree_hook, context_id);
    register(scope, ns, "ceAttributeChanged", ce_attribute_changed, context_id);
    register(scope, ns, "ceMakeRegistry", ce_make_registry, context_id);
    register(scope, ns, "ceNamed", ce_named, context_id);
    register(scope, ns, "ceLookUp", ce_look_up, context_id);
    register(scope, ns, "ceSetWindowRegistry", ce_set_window_registry, context_id);
    register(scope, ns, "ceWindowRegistry", ce_window_registry, context_id);
    register(scope, ns, "ceRegistryFor", ce_registry_for, context_id);
    register(scope, ns, "ceDefinitionFor", ce_definition_for, context_id);
    register(scope, ns, "ceRegistryOf", ce_registry_of, context_id);
    register(scope, ns, "ceSetRegistry", ce_set_registry, context_id);
    register(scope, ns, "ceKeepNull", ce_keep_null, context_id);
    register(scope, ns, "ceRestamp", ce_restamp, context_id);
    register(scope, ns, "ceFormStateReset", ce_form_state_reset, context_id);
    register(scope, ns, "ceFormOwnersReset", ce_form_owners_reset, context_id);
    register(scope, ns, "ceSetKeepNull", ce_set_keep_null, context_id);
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

// The scope's object of a weak handle in the engine's tables (`definition_object`, `callback_of`), where it is alive.
fn weak_local<'s>(scope: &mut v8::PinScope<'s, '_>, weak: Option<*const v8::Weak<v8::Value>>) -> Option<v8::Local<'s, v8::Value>> {
    // SAFETY: the tables are the isolate's, which `to_local` reads nothing of, and the entry outlives this call (nothing in
    // between frees one: an entry is let go of only as a realm goes or a page begins).
    weak.and_then(|w| unsafe { (*w).to_local(scope) })
}
// …held.
fn weak_global(scope: &mut v8::PinScope<'_, '_>, weak: Option<*const v8::Weak<v8::Value>>) -> Option<v8::Global<v8::Value>> {
    weak_local(scope, weak).map(|l| v8::Global::new(scope, l))
}

// A custom element name as a definition is keyed by: its code units, a lone surrogate among them kept apart from the
// U+FFFD a string makes of it (no valid custom element name has either, but one compares as the other).
pub(crate) fn name_key(units: &[u16]) -> String {
    let mut key = String::with_capacity(units.len());
    for unit in char::decode_utf16(units.iter().copied()) {
        match unit {
            Ok(c) => key.push(c),
            Err(e) => key.push_str(&format!("\0{:04x}", e.unpaired_surrogate())),
        }
    }
    key
}
// …of an argument: a one-byte string — any name a page writes in ASCII — straight, as it holds no surrogate.
fn name_key_arg(scope: &mut v8::PinScope<'_, '_>, value: v8::Local<'_, v8::Value>) -> String {
    match v8::Local::<v8::String>::try_from(value) {
        Ok(string) if string.is_onebyte() => string.to_rust_string_lossy(scope),
        _ => name_key(&utf16_arg(scope, value)),
    }
}

// The values of an array argument, held.
fn held_list(scope: &mut v8::PinScope<'_, '_>, value: v8::Local<'_, v8::Value>) -> Vec<v8::Global<v8::Value>> {
    match v8::Local::<v8::Array>::try_from(value) {
        Ok(a) => (0..a.length()).filter_map(|i| a.get_index(scope, i)).map(|v| v8::Global::new(scope, v)).collect(),
        Err(_) => Vec::new(),
    }
}

// __dom.ceDefine(registry, name, localName, definition, callbacks, observed) -> the definition's id: a custom element
// definition made in the calling realm, in registry `registry` (its code) — `definition` the bindings' object for it,
// `callbacks` its callbacks in `CALLBACKS` order (undefined for one it has not), `observed` the local names of the
// attributes it observes.
fn ce_define(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let code = args.get(0).uint32_value(scope).unwrap_or(UNSET);
    let realm = realm_id(scope, &args);
    let name = name_key_arg(scope, args.get(1));
    let local_name = name_key_arg(scope, args.get(2));
    let object = v8::Weak::new(scope, args.get(3));
    let given: Vec<v8::Local<'_, v8::Value>> = match v8::Local::<v8::Array>::try_from(args.get(4)) {
        Ok(a) => (0..a.length()).filter_map(|i| a.get_index(scope, i)).collect(),
        Err(_) => Vec::new(),
    };
    let mut callbacks: Vec<Option<v8::Weak<v8::Value>>> =
        given.into_iter().map(|f| f.is_function().then(|| v8::Weak::new(scope, f))).collect();
    callbacks.resize_with(CALLBACKS, || None);
    let observed = match v8::Local::<v8::Array>::try_from(args.get(5)) {
        Ok(a) => {
            let names: Vec<v8::Local<'_, v8::Value>> = (0..a.length()).filter_map(|i| a.get_index(scope, i)).collect();
            names.into_iter().map(|v| utf16_arg(scope, v)).collect()
        }
        Err(_) => HashSet::new(),
    };
    let reactions = &mut dom(scope).arena.ce_reactions;
    let autonomous = local_name == name;
    let definition = Some(Definition { realm, object, autonomous, callbacks, observed });
    // (…in a slot one a realm took left, which nothing names any more: `forget_definitions_of`)
    let id = match reactions.definitions.iter().position(Option::is_none) {
        Some(free) => {
            reactions.definitions[free] = definition;
            free as u32
        }
        None => {
            reactions.definitions.push(definition);
            reactions.definitions.len() as u32 - 1
        }
    };
    if let Some(registry) = code.checked_sub(FIRST_REGISTRY).and_then(|i| reactions.registries.get_mut(i as usize)).and_then(Option::as_mut) {
        if !autonomous {
            registry.builtins.entry(local_name).or_default().insert(name.clone(), id);
        }
        registry.named.insert(name, id);
    }
    rv.set_uint32(id);
}

// __dom.ceNamed(registry, name) -> the bindings' object for registry `registry`'s definition named `name`, or undefined.
fn ce_named(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let code = args.get(0).uint32_value(scope).unwrap_or(UNSET);
    let name = name_key_arg(scope, args.get(1));
    let reactions = &dom(scope).arena.ce_reactions;
    let found = reactions.registry(code).and_then(|r| r.named.get(&name)).and_then(|&id| reactions.definition_object(id));
    if let Some(object) = weak_local(scope, found) {
        rv.set(object);
    }
}

// __dom.ceLookUp(registry, localName, isValue) -> the bindings' object for the definition HTML "look up a custom element
// definition" finds in registry `registry` (`look_up`; `isValue` undefined for none), or undefined.
fn ce_look_up(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let code = args.get(0).uint32_value(scope).unwrap_or(UNSET);
    let local_name = name_key_arg(scope, args.get(1));
    let is = (!args.get(2).is_null_or_undefined()).then(|| name_key_arg(scope, args.get(2)));
    let reactions = &dom(scope).arena.ce_reactions;
    let found = reactions.look_up(code, &local_name, is.as_deref()).and_then(|id| reactions.definition_object(id));
    if let Some(object) = weak_local(scope, found) {
        rv.set(object);
    }
}

// __dom.ceSetDefinition(nid, id, definition) — the element custom by `definition` (the bindings' object for it, `id` its: HTML
// "upgrade an element" step 3, an element constructed custom), where it is still the engine's — its realm not gone, its
// slot not another's since; none for null (a failed upgrade takes it back).
fn ce_set_definition(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = nid_arg(scope, &args, 0) else { return };
    let def = definition_id(scope, args.get(1), args.get(2));
    let custom = &mut dom(scope).arena.ce_reactions.custom;
    match def {
        Some(def) => custom.insert(id, def),
        None => custom.remove(&id),
    };
}

// __dom.ceDefinitionLive(id, definition) -> whether the bindings' object `definition` is still definition `id` of the engine's:
// one whose realm went is no more (HTML's element constructor finds none for its NewTarget then).
fn ce_definition_live(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    rv.set_bool(definition_id(scope, args.get(0), args.get(1)).is_some());
}

// `id`, where that slot still holds the bindings' object `value` (a definition object keeps the id it was given, which a
// slot a realm freed may be another's by now).
fn definition_id(scope: &mut v8::PinScope<'_, '_>, id: v8::Local<'_, v8::Value>, value: v8::Local<'_, v8::Value>) -> Option<u32> {
    let id = id.uint32_value(scope).filter(|_| id.is_number())?;
    let held = dom(scope).arena.ce_reactions.definition_object(id)?;
    // SAFETY: as `weak_local`'s.
    (unsafe { &*held } == &value).then_some(id)
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
    let weak = dom(scope).arena.ce_reactions.callback_of(id, which);
    let Some(callback) = weak_global(scope, weak) else { return rv.set_bool(false) };
    let element = v8::Global::new(scope, args.get(1));
    let list = held_list(scope, args.get(3));
    rv.set_bool(dom(scope).arena.ce_reactions.enqueue(id, element, callback, list));
}

// __dom.ceEnqueueUpgrade(nid, element, upgrade, args) -> whether the backup element queue's microtask is to be queued: HTML
// "enqueue a custom element upgrade reaction" — `upgrade`, the bindings' steps that upgrade the element, called on it with
// `args` (its definition's constructor) as its reactions run — however often it is enqueued: the element joins the
// element queue of the call that enqueued it each time, and an upgrade it no longer owes returns at once ("upgrade an
// element" step 1), so a constructor that moves a later element of its own fragment upgrades it before it goes on
// (Chrome, Firefox).
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
        let weak: Vec<*const v8::Weak<v8::Value>> = {
            let reactions = &dom(scope).arena.ce_reactions;
            let mv = which == CONNECTED_MOVE && reactions.callback_of(id, CONNECTED_MOVE).is_none();
            let order: &[usize] = if mv { &[DISCONNECTED, CONNECTED] } else { std::slice::from_ref(&which) };
            order.iter().filter_map(|&w| reactions.callback_of(id, w)).collect()
        };
        let callbacks: Vec<v8::Global<v8::Value>> = weak.into_iter().filter_map(|w| weak_global(scope, Some(w))).collect();
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
    rv.set_bool(enqueue_attribute_changed(scope, id, args.get(1), &name, [args.get(3), args.get(4), args.get(5)]));
}
// …the engine's: the change of the attribute `name` of `id` (`element`), `[oldValue, value, namespace]`.
pub(crate) fn enqueue_attribute_changed(scope: &mut v8::PinScope<'_, '_>, id: NodeId, element: v8::Local<'_, v8::Value>, name: &[u16], change: [v8::Local<'_, v8::Value>; 3]) -> bool {
    let callback = {
        let reactions = &dom(scope).arena.ce_reactions;
        reactions
            .definition_of(id)
            .filter(|d| d.observed.iter().any(|o| o[..] == *name))
            .and_then(|d| d.callbacks[ATTRIBUTE_CHANGED].as_ref())
            .map(|w| w as *const _)
    };
    let Some(callback) = weak_global(scope, callback) else { return false };
    let element = v8::Global::new(scope, element);
    let name = crate::dom::utf16_value(scope, name);
    let list = [name, change[0], change[1], change[2]].map(|v| v8::Global::new(scope, v)).to_vec();
    dom(scope).arena.ce_reactions.enqueue(id, element, callback, list)
}

// __dom.ceMakeRegistry(registry, scoped) -> its code: a CustomElementRegistry made in the calling realm, which a node's
// association names it by.
fn ce_make_registry(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let realm = realm_id(scope, &args);
    let object = v8::Weak::new(scope, args.get(0));
    let scoped = args.get(1).is_true();
    let registries = &mut dom(scope).arena.ce_reactions.registries;
    registries.push(Some(Registry { object, scoped, named: HashMap::new(), builtins: HashMap::new() }));
    let code = FIRST_REGISTRY + registries.len() as u32 - 1;
    if !scoped {
        dom(scope).arena.ce_reactions.window_registries.insert(realm, code);
    }
    rv.set_uint32(code);
}

// __dom.ceRegistryOf(node, trackingNull) -> the node's registry association: undefined for none set, `trackingNull` (the
// bindings' sentinel) for the template contents' tracking null, null for the null registry, else the registry — undefined
// too for one its realm took with it.
fn ce_registry_of(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(handle) = crate::node_handle::handle_of(scope, args.get(0)) else { return };
    // SAFETY: the handle lives while its object, an argument, does.
    let code = unsafe { handle.as_ref() }.registry();
    match code {
        UNSET => {}
        TRACKING => rv.set(args.get(1)),
        NULL => rv.set_null(),
        _ => rv.set(registry_value(scope, code)),
    }
}

// __dom.ceSetRegistry(node, code, registry) — the node's registry association becomes `code` (`UNSET`, `TRACKING`,
// `NULL`, or `registry`'s from `ceMakeRegistry`), which the node then holds.
fn ce_set_registry(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(handle) = crate::node_handle::handle_of(scope, args.get(0)) else { return };
    let code = args.get(1).uint32_value(scope).unwrap_or(UNSET);
    let object = v8::Local::<v8::Object>::try_from(args.get(2)).ok().filter(|_| code >= FIRST_REGISTRY);
    // SAFETY: as above.
    unsafe { handle.as_ref() }.set_registry(scope, code, object);
}

// DOM "clone a node": the copy's registry association the node's — a registry (not one its realm took with it), the
// null registry or the tracking null; none set stays none.
pub(crate) fn copy_registry(scope: &mut v8::PinScope<'_, '_>, from: &crate::node_handle::NodeHandle, to: &crate::node_handle::NodeHandle) {
    let code = from.registry();
    if code == UNSET {
        return;
    }
    let object = (code >= FIRST_REGISTRY).then(|| registry_value(scope, code)).and_then(|v| v8::Local::<v8::Object>::try_from(v).ok());
    if code >= FIRST_REGISTRY && object.is_none() {
        return;
    }
    to.set_registry(scope, code, object);
}

// The value a registry code is to the bindings: null for none (`UNSET` or `NULL` — a window's of a document without a
// browsing context), else the registry, undefined for one its realm took with it.
fn registry_value<'s>(scope: &mut v8::PinScope<'s, '_>, code: u32) -> v8::Local<'s, v8::Value> {
    if code < FIRST_REGISTRY {
        return v8::null(scope).into();
    }
    let object = dom(scope).arena.ce_reactions.registry(code).map(|r| r.object.clone());
    object.and_then(|w| w.to_local(scope)).map_or_else(|| v8::undefined(scope).into(), Into::into)
}

// The registry of the node `value` is the object of, as HTML resolves it (an element's, a shadow root's, a document's):
// its own where one is set — none for the null registry or the template contents' null — else its node document's window
// registry (a document's own), or, for a node with no document, the calling realm's window registry.
pub(crate) fn registry_for(scope: &mut v8::PinScope<'_, '_>, cid: i32, value: v8::Local<'_, v8::Value>) -> Option<u32> {
    let handle = crate::node_handle::handle_of(scope, value)?;
    // SAFETY: the handle lives while its object, an argument, does.
    let handle = unsafe { handle.as_ref() };
    match handle.registry() {
        UNSET => {}
        TRACKING | NULL => return Some(NULL),
        code => return Some(code),
    }
    if let Some(doc) = handle.document(scope) {
        let doc = crate::node_handle::handle_of(scope, doc.into())?;
        // SAFETY: as above — the document is held by the node's handle.
        return Some(unsafe { doc.as_ref() }.window_registry());
    }
    let is_document = handle.nid().and_then(|id| dom(scope).arena.get(id)).is_some_and(|n| n.kind == crate::dom::NodeKind::Document);
    if is_document {
        return Some(handle.window_registry());
    }
    dom(scope).arena.ce_reactions.window_registries.get(&cid).copied()
}

// __dom.ceSetWindowRegistry(document, code, registry) — the document's window registry: `code` (`registry`'s) for one
// with a browsing context, `UNSET` for one without.
fn ce_set_window_registry(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(handle) = crate::node_handle::handle_of(scope, args.get(0)) else { return };
    let code = args.get(1).uint32_value(scope).unwrap_or(UNSET);
    let object = v8::Local::<v8::Object>::try_from(args.get(2)).ok().filter(|_| code >= FIRST_REGISTRY);
    // SAFETY: the handle lives while its object, an argument, does.
    unsafe { handle.as_ref() }.set_window_registry(scope, code, object);
}

// __dom.ceWindowRegistry(document) -> the document's window registry, null for a document without a browsing context.
fn ce_window_registry(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(handle) = crate::node_handle::handle_of(scope, args.get(0)) else { return rv.set_null() };
    // SAFETY: as above.
    let code = unsafe { handle.as_ref() }.window_registry();
    rv.set(registry_value(scope, code));
}

// __dom.ceRegistryFor(node) -> the node's registry, as `registry_for` resolves it: null for the null registry.
fn ce_registry_for(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    let code = registry_for(scope, cid, args.get(0)).unwrap_or(NULL);
    rv.set(registry_value(scope, code));
}

// __dom.ceDefinitionFor(element, isValue) -> the bindings' object for the definition HTML "look up a custom element
// definition" finds for the element in its registry — an HTML element, by its local name and is value — or undefined.
fn ce_definition_for(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    let Some(handle) = crate::node_handle::handle_of(scope, args.get(0)) else { return };
    // SAFETY: as above.
    let Some(id) = unsafe { handle.as_ref() }.nid() else { return };
    let Some(code) = registry_for(scope, cid, args.get(0)) else { return };
    let is = (!args.get(1).is_null_or_undefined()).then(|| name_key_arg(scope, args.get(1)));
    let d = dom(scope);
    let Some(n) = d.arena.get(id).filter(|n| n.kind == crate::dom::NodeKind::Element && n.is_html()) else { return };
    // (…its local name as the arena has it, with no copy — but exactly where it carries a lone surrogate)
    let exact = n.name_u16.as_ref().map(|e| name_key(&e.local));
    let reactions = &d.arena.ce_reactions;
    let found = reactions.look_up(code, exact.as_deref().unwrap_or(&n.local_name), is.as_deref()).and_then(|d| reactions.definition_object(d));
    if let Some(object) = weak_local(scope, found) {
        rv.set(object);
    }
}

// The registry objects the handles `registry_insertion_steps` took a registry away from held no longer — a node pinned to
// a frame's window registry, moved into template contents, kept that realm alive.
pub(crate) fn release_registries(scope: &mut v8::PinScope<'_, '_>, released: Vec<*const crate::node_handle::NodeHandle>) {
    for h in released {
        // SAFETY: the handles of nodes the insertion just moved, which the arena holds while they are in its trees.
        let h = unsafe { &*h };
        h.set_registry(scope, h.registry(), None);
    }
}

// __dom.ceKeepNull(shadowRoot) / ceSetKeepNull(shadowRoot, keep) — whether the shadow root keeps its null registry as it
// is adopted (HTML "keep custom element registry null": a declarative `shadowrootcustomelementregistry` root's).
fn ce_keep_null(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(handle) = crate::node_handle::handle_of(scope, args.get(0)) else { return rv.set_bool(false) };
    // SAFETY: the handle lives while its object, an argument, does.
    rv.set_bool(unsafe { handle.as_ref() }.keep_null());
}
fn ce_set_keep_null(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(handle) = crate::node_handle::handle_of(scope, args.get(0)) else { return };
    // SAFETY: as above.
    unsafe { handle.as_ref() }.set_keep_null(args.get(1).is_true());
}

// __dom.ceRestamp(rootNid, match, code, registry, elementsOnly) — the registry association of the root and of each node of
// its tree under it (not a shadow tree's, nor a template's contents; elements only where `elementsOnly`) whose association
// `match` names — a bit per code, `1 << UNSET` and on — becomes `code` (`registry`'s, where it is one): what a parse or a
// declarative shadow root stamps on the nodes it made.
fn ce_restamp(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(root) = nid_arg(scope, &args, 0) else { return };
    let matching = args.get(1).uint32_value(scope).unwrap_or(0);
    let code = args.get(2).uint32_value(scope).unwrap_or(UNSET);
    let object = v8::Local::<v8::Object>::try_from(args.get(3)).ok().filter(|_| code >= FIRST_REGISTRY);
    let elements_only = args.get(4).is_true();
    let cid = realm_id(scope, &args);
    let handles: Vec<*const crate::node_handle::NodeHandle> = {
        let arena = realm(scope, cid);
        let mut out = Vec::new();
        let mut stack = vec![root];
        while let Some(id) = stack.pop() {
            let Some(n) = arena.get(id) else { continue };
            if let Some(h) = n.link.handle().filter(|_| !elements_only || n.kind == crate::dom::NodeKind::Element) {
                if h.registry() < FIRST_REGISTRY && matching & (1 << h.registry()) != 0 {
                    out.push(h as *const _);
                }
            }
            stack.extend(n.children.iter().copied());
        }
        out
    };
    for h in handles {
        // SAFETY: the handles of the root's tree, which the arena holds; nothing in between runs script.
        unsafe { &*h }.set_registry(scope, code, object);
    }
}

// What a form-associated custom element's reset re-derives (`ceFormStateReset`): its form owner, its disabled state.
const FORM_OWNER: u32 = 1;
const FORM_DISABLED_STATE: u32 = 2;

// __dom.ceFormStateReset(nid, element, which) -> whether its form owner changed (bit 0) and whether the backup element
// queue's microtask is to be queued (bit 1): a form-associated custom element's form owner (HTML "reset the form owner",
// `which` & 1) and disabled state (`which` & 2) re-derived, and where either is another than its callbacks were last
// told, its formAssociatedCallback (the new owner) or formDisabledCallback (whether it is disabled) enqueued.
fn ce_form_state_reset(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = nid_arg(scope, &args, 0) else { return rv.set_uint32(0) };
    let which = args.get(2).uint32_value(scope).unwrap_or(0);
    let cid = realm_id(scope, &args);
    rv.set_uint32(reset_form_state(scope, cid, id, args.get(1), which));
}
// __dom.ceFormOwnersReset(rootNid) -> the same bits for the form-associated custom elements of the root's tree whose
// `form` attribute names their owner (HTML: "an element with an ID is inserted into or removed from the Document, or
// its ID changes" — each resets its form owner, its formAssociatedCallback enqueued where it is another now): bit 0 any
// owner changed, bit 1 the backup element queue's microtask to be queued. In a document only those naming an id whose
// element is another than the id lookup last gave (`form_ids`) — a change there asks those few ids, and walks the tree
// only where one moved; in any other tree (a shadow tree's) every one.
fn ce_form_owners_reset(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(root) = nid_arg(scope, &args, 0) else { return rv.set_uint32(0) };
    let cid = realm_id(scope, &args);
    let moved = if realm(scope, cid).get(root).is_some_and(|n| n.kind == crate::dom::NodeKind::Document) {
        let named: Vec<String> = dom(scope).arena.ce_reactions.form_ids.keys().filter(|(doc, _)| *doc == root).map(|(_, id)| id.clone()).collect();
        let mut moved = Vec::new();
        for id in named {
            let now = realm(scope, cid).element_by_id(root, &id.encode_utf16().collect::<Vec<u16>>());
            if let Some(had) = dom(scope).arena.ce_reactions.form_ids.get_mut(&(root, id.clone())).filter(|had| **had != now) {
                *had = now;
                moved.push(id);
            }
        }
        if moved.is_empty() {
            return rv.set_uint32(0);
        }
        Some(moved)
    } else {
        None
    };
    let naming = crate::collections::form_naming_customs(realm(scope, cid), root, moved.as_deref());
    let mut answer = 0;
    for id in naming {
        let element = crate::dom::node_value(scope, Some(id));
        answer |= reset_form_state(scope, cid, id, element, FORM_OWNER);
    }
    rv.set_uint32(answer);
}
// (…the id its `form` attribute names noted, in its document, with the element the id lookup gives it now)
fn note_form_id(scope: &mut v8::PinScope<'_, '_>, cid: i32, id: NodeId) {
    let arena = realm(scope, cid);
    let Some(named) = arena.get(id).and_then(|n| n.plain_attr("form")).map(str::to_owned) else { return };
    let root = arena.root_of(id);
    if arena.get(root).is_none_or(|n| n.kind != crate::dom::NodeKind::Document) || dom(scope).arena.ce_reactions.form_ids.contains_key(&(root, named.clone())) {
        return;
    }
    let found = realm(scope, cid).element_by_id(root, &named.encode_utf16().collect::<Vec<u16>>());
    dom(scope).arena.ce_reactions.form_ids.insert((root, named), found);
}
// (…one element's reset: its `element` object the receiver of the callbacks enqueued)
fn reset_form_state(scope: &mut v8::PinScope<'_, '_>, cid: i32, id: NodeId, element: v8::Local<'_, v8::Value>, which: u32) -> u32 {
    let (owner, disabled) = {
        let arena = realm(scope, cid);
        if arena.get(id).is_none_or(|n| n.state & crate::dom::STATE_FORM_ASSOCIATED == 0) {
            return 0;
        }
        (arena.form_owner(id), arena.is_actually_disabled(id))
    };
    let (told_owner, told_disabled) = dom(scope).arena.ce_reactions.form_states.get(&id).copied().unwrap_or((None, false));
    if which & FORM_OWNER != 0 {
        note_form_id(scope, cid, id);
    }
    let owner_changed = which & FORM_OWNER != 0 && owner != told_owner;
    let disabled_changed = which & FORM_DISABLED_STATE != 0 && disabled != told_disabled;
    if !owner_changed && !disabled_changed {
        return 0;
    }
    let next = (if owner_changed { owner } else { told_owner }, if disabled_changed { disabled } else { told_disabled });
    dom(scope).arena.ce_reactions.form_states.insert(id, next);
    let element = v8::Global::new(scope, element);
    let mut queue = false;
    if owner_changed {
        let weak = dom(scope).arena.ce_reactions.callback_of(id, FORM_ASSOCIATED);
        if let Some(callback) = weak_global(scope, weak) {
            let owner = crate::dom::node_value(scope, owner);
            let owner = v8::Global::new(scope, owner);
            queue |= dom(scope).arena.ce_reactions.enqueue(id, element.clone(), callback, vec![owner]);
        }
    }
    if disabled_changed {
        let weak = dom(scope).arena.ce_reactions.callback_of(id, FORM_DISABLED);
        if let Some(callback) = weak_global(scope, weak) {
            let flag: v8::Local<'_, v8::Value> = v8::Boolean::new(scope, disabled).into();
            let flag = v8::Global::new(scope, flag);
            queue |= dom(scope).arena.ce_reactions.enqueue(id, element, callback, vec![flag]);
        }
    }
    u32::from(owner_changed) | (u32::from(queue) << 1)
}
