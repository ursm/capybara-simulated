// The custom element reactions (HTML §4.13.6): each custom element's reaction queue — the callbacks it is owed, each
// with its arguments, in the order they were enqueued — and the agent's custom element reactions stack, whose element
// queues name the elements whose queues a [CEReactions] call has to run as it returns, and its backup element queue,
// which the microtask the bindings queue for it runs. The isolate's, as the agent is.
//
// The stack's depth is the bindings': a [CEReactions] call adds one as it begins and takes it away as it returns
// (`ceStack[0]`, a view each realm's bindings write with no call), so a call that enqueues nothing costs no crossing.
// An element enqueued while a call runs goes on the queue of the depth it runs at; and the deepest depth with an
// element is `ceStack[1]`, which the returning call reads to tell whether it has reactions to run (`ceTakeQueue`).

use std::collections::{HashMap, VecDeque};

use crate::dom::{dom, nid_arg, register, NodeId};

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
}

const DEPTH: usize = 0;
const DEEPEST: usize = 1;

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
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    register(scope, ns, "ceEnqueue", ce_enqueue, context_id);
    register(scope, ns, "ceTakeQueue", ce_take_queue, context_id);
    register(scope, ns, "ceTakeBackup", ce_take_backup, context_id);
    register(scope, ns, "ceNextReaction", ce_next_reaction, context_id);
    // (…and the stack's depth and deepest queue, a view on the isolate's one buffer)
    let store = {
        let reactions = &mut dom(scope).arena.ce_reactions;
        reactions.view.get_or_insert_with(|| v8::ArrayBuffer::new_backing_store_from_vec(vec![0u8; 8]).make_shared()).clone()
    };
    let buffer = v8::ArrayBuffer::with_backing_store(scope, &store);
    if let (Some(view), Some(key)) = (v8::Int32Array::new(scope, buffer, 0, 2), v8::String::new(scope, "ceStack")) {
        ns.set(scope, key.into(), view.into());
    }
}

// __dom.ceEnqueue(nid, element, callback, args) -> whether the backup element queue's microtask is to be queued: HTML
// "enqueue a custom element callback reaction" of `callback` with `args` (an array) for the element, and "enqueue an
// element on the appropriate element queue" — the current call's, or the backup one.
fn ce_enqueue(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = nid_arg(scope, &args, 0) else { return rv.set_bool(false) };
    let element = v8::Global::new(scope, args.get(1));
    let callback = v8::Global::new(scope, args.get(2));
    let list: Vec<v8::Global<v8::Value>> = match v8::Local::<v8::Array>::try_from(args.get(3)) {
        Ok(a) => (0..a.length()).filter_map(|i| a.get_index(scope, i)).map(|v| v8::Global::new(scope, v)).collect(),
        Err(_) => Vec::new(),
    };
    let reactions = &mut dom(scope).arena.ce_reactions;
    reactions.queues.entry(id).or_default().push_back(Reaction { callback, args: list });
    let depth = reactions.get(DEPTH).max(0) as usize;
    if depth == 0 {
        reactions.backup.push((id, element));
        let queue = !reactions.backup_queued;
        reactions.backup_queued = true;
        return rv.set_bool(queue);
    }
    if reactions.levels.len() <= depth {
        reactions.levels.resize_with(depth + 1, Vec::new);
    }
    reactions.levels[depth].push((id, element));
    if reactions.get(DEEPEST) < depth as i32 {
        reactions.set(DEEPEST, depth as i32);
    }
    rv.set_bool(false);
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

// __dom.ceTakeBackup() -> the backup element queue, taken, its microtask no longer queued.
fn ce_take_backup(scope: &mut v8::PinScope<'_, '_>, _args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let reactions = &mut dom(scope).arena.ce_reactions;
    let queue = std::mem::take(&mut reactions.backup);
    reactions.backup_queued = false;
    rv.set(elements(scope, queue));
}

// __dom.ceNextReaction(nid) -> `[callback, args]`: the element's next reaction, taken from its queue — undefined once it
// is empty (HTML "invoke custom element reactions": an element's reactions run until none is left).
fn ce_next_reaction(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = nid_arg(scope, &args, 0) else { return };
    let reactions = &mut dom(scope).arena.ce_reactions;
    let Some(queue) = reactions.queues.get_mut(&id) else { return };
    let Some(reaction) = queue.pop_front() else { return };
    if queue.is_empty() {
        reactions.queues.remove(&id);
    }
    let callback = v8::Local::new(scope, reaction.callback);
    let list: Vec<v8::Local<'_, v8::Value>> = reaction.args.into_iter().map(|a| v8::Local::new(scope, a)).collect();
    let list = v8::Array::new_with_elements(scope, &list);
    rv.set(v8::Array::new_with_elements(scope, &[callback, list.into()]).into());
}
