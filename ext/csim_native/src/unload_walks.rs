// The two walks HTML makes over a document's navigable tree as the document goes, which the engine keeps — the bindings
// asking it for each next document and firing that one's events (dom-nodes.js):
// - "checking if unloading is canceled": `beforeunload` at the active documents of the navigables it is given — a
//   navigable's inclusive descendant navigables, in tree order — as they were when it began ("documentsToFireBeforeunload"),
//   one destroyed since by a handler (its frame removed) skipped, as the task its event would be fired in is; each
//   document's unload counter raised while its handlers run, so a navigation one of them makes is ignored — and one
//   whose frame its own handlers removed destroyed as they are done (HTML "destroy a child navigable": its removal could
//   not dispose a realm whose script was on the stack, handles.js `discardBrowsingContext`), `end_walk`;
// - "unload a document and its descendants": each document unloaded after the documents of its child navigables — those
//   it has as its own unloading begins — its unload counter raised from then until the walk ends, after the documents
//   are destroyed (the host disposes their realms, `dispose_order`); one a handler took out of the tree since skipped —
//   and, its unloading begun (its children taken), destroyed with the rest: its removal left it to the walk, its counter
//   raised. Which of its child navigables goes first HTML leaves open ("in what order?"): tree order, the prompt's.
// A walk lives no longer than the host's entry into the isolate it began in — and so does a frame's build, whose mark
// keeps a read of the frame's window it makes from building it again (frame_navigation.rs `BUILDING`): one a
// termination left open (no `finally` of the bindings' ran) is ended as the entry returns (`end_left_open_since`), a
// walk's counters lowered, a build's mark cleared — those begun since the entry was made (`MADE`, which the host reads
// as it enters: `last_mark`), not one a script below it began, which another entry made and is under way still.

use std::collections::HashMap;

use crate::dom::{nid_arg, realm_id, NodeId, RealmArena};

#[derive(Default)]
pub(crate) struct Walks {
    open: HashMap<u32, Walk>,
    // …and the frames being built, each container with its build's number.
    builds: HashMap<NodeId, u32>,
}

// The number of the last walk or build begun — one count across the process, which the host reads without entering an
// isolate.
static MADE: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
pub(crate) fn last_mark() -> u32 {
    MADE.load(std::sync::atomic::Ordering::Acquire)
}
pub(crate) fn next_mark() -> u32 {
    MADE.fetch_add(1, std::sync::atomic::Ordering::AcqRel).wrapping_add(1)
}
// Whether `id` was begun after `mark`.
pub(crate) fn begun_after(id: u32, mark: u32) -> bool {
    id.wrapping_sub(mark) as i32 > 0
}

struct Walk {
    root: i32,
    kind: Kind,
    // The documents still to go, by realm, the last next — an unload's each whether its children were taken yet, and how
    // deep under the root it is (a walk goes no deeper than any page can nest: navigables.rs `MAX_NESTING`).
    pending: Vec<(i32, bool, usize)>,
    // …those the walk reached, in the order it did, and those whose unload counter it raised (not one raised already:
    // a document a walk under way is unloading, which a frame removed by its handler walks again).
    reached: Vec<i32>,
    raised: Vec<i32>,
    // …and, a prompt's, the documents its handlers took out of the tree as they were asked: to destroy; an unload's, those
    // whose navigable a handler destroyed after it took their children, which it destroys with the rest.
    removed: Vec<i32>,
}

enum Kind {
    // (…the document being asked now, its counter raised by the walk, and whether a traversal applies its step)
    Prompt { asking: Option<i32>, traversal: bool },
    Unload,
}

impl RealmArena {
    fn begin_walk(&mut self, root: i32, kind: Kind) -> u32 {
        let pending = match kind {
            Kind::Prompt { .. } => self.inclusive_descendant_realms(root).into_iter().rev().map(|r| (r, false, 0)).collect(),
            Kind::Unload => vec![(root, false, 0)],
        };
        let id = next_mark();
        self.navigables.walks.open.insert(id, Walk { root, kind, pending, reached: Vec::new(), raised: Vec::new(), removed: Vec::new() });
        id
    }
    // The realm of the next document walk `id` reaches, its unload counter raised — none where it is done.
    pub(crate) fn walk_next(&mut self, id: u32) -> Option<i32> {
        let mut walk = self.navigables.walks.open.remove(&id)?;
        let next = match walk.kind {
            Kind::Prompt { ref mut asking, traversal } => {
                if let Some(done) = asking.take() {
                    self.done_asking(done, walk.root, &mut walk.removed);
                }
                let next = std::iter::from_fn(|| walk.pending.pop()).map(|(r, ..)| r).find(|&r| self.realm_under(r, walk.root));
                if let Some(realm) = next.filter(|&r| !self.unloading(r)) {
                    self.navigables.prompting.insert(realm, traversal);
                    *asking = Some(realm);
                }
                next
            }
            Kind::Unload => self.next_to_unload(&mut walk),
        };
        walk.reached.extend(next);
        self.navigables.walks.open.insert(id, walk);
        next
    }
    fn next_to_unload(&mut self, walk: &mut Walk) -> Option<i32> {
        while let Some(&(realm, taken, depth)) = walk.pending.last() {
            if !self.realm_under(realm, walk.root) {
                walk.pending.pop();
                // (…its navigable destroyed by a handler of a document it holds, its own removal skipping it as one being
                // unloaded (handles.js `discardBrowsingContext`) — not one an atomic move took elsewhere, still a
                // navigable's, nor one disposed already)
                if taken && self.navigable_destroyed(realm) && self.navigables.fully_active(realm) {
                    walk.removed.push(realm);
                }
            } else if taken {
                walk.pending.pop();
                return Some(realm);
            } else {
                walk.pending.last_mut().expect("just read").1 = true;
                if self.navigables.unloading.insert(realm) {
                    walk.raised.push(realm);
                }
                if depth < crate::navigables::MAX_NESTING {
                    let children = self.child_realms_in_tree_order(realm);
                    walk.pending.extend(children.into_iter().rev().map(|r| (r, false, depth + 1)));
                }
            }
        }
        None
    }
    // The realms whose documents go with walk `id`'s, in the order they are destroyed: those of the tree under its root
    // as it is now, each after its descendants', then those it unloaded that a handler took out of it since, the last
    // reached first, and those it began to unload whose navigables a handler destroyed, with the documents still under
    // them (a frame of one, taken but not reached, whose own navigable stands) — its root's among them only where
    // `with_root`.
    pub(crate) fn walk_dispose_order(&self, id: u32, with_root: bool) -> Vec<i32> {
        let Some(walk) = self.navigables.walks.open.get(&id) else { return Vec::new() };
        let mut order = self.inclusive_descendant_realms_children_first(walk.root);
        let removed: &[i32] = if matches!(walk.kind, Kind::Unload) { &walk.removed } else { &[] };
        let removed_trees = removed.iter().flat_map(|&r| self.inclusive_descendant_realms_children_first(r));
        for realm in walk.reached.iter().rev().copied().chain(removed_trees) {
            if !order.contains(&realm) {
                order.push(realm);
            }
        }
        if !with_root {
            order.retain(|&r| r != walk.root);
        }
        order
    }
    // A prompt done asking realm `realm`'s document: its counter lowered, and the document noted to destroy where its
    // handlers took its frame out of the tree — one still fully active, which a removal by another's handler was not
    // left to.
    fn done_asking(&mut self, realm: i32, root: i32, removed: &mut Vec<i32>) {
        self.navigables.prompting.remove(&realm);
        if realm != root && self.navigable_destroyed(realm) && self.navigables.fully_active(realm) {
            removed.push(realm);
        }
    }
    // Walk `id` done: the unload counters it raised lowered. Returns the documents its handlers took out of the tree as
    // they were asked, whose realms the caller destroys.
    pub(crate) fn end_walk(&mut self, id: u32) -> Vec<i32> {
        let Some(mut walk) = self.navigables.walks.open.remove(&id) else { return Vec::new() };
        if let Kind::Prompt { asking: Some(realm), .. } = walk.kind {
            self.done_asking(realm, walk.root, &mut walk.removed);
        }
        for realm in walk.raised {
            self.navigables.unloading.remove(&realm);
        }
        walk.removed
    }
    // Every walk and build begun after number `mark` still open ended — none should be: the host's entry into the isolate
    // made as `mark` was the last, which has returned, left them (a termination). Returns how many.
    pub(crate) fn end_left_open_since(&mut self, mark: u32) -> usize {
        let ids: Vec<u32> = self.navigables.walks.open.keys().copied().filter(|&id| begun_after(id, mark)).collect();
        for &id in &ids {
            self.end_walk(id);
        }
        let builds: Vec<NodeId> = self.navigables.walks.builds.iter().filter(|&(_, &id)| begun_after(id, mark)).map(|(&c, _)| c).collect();
        for &container in &builds {
            self.end_frame_build(container);
        }
        ids.len() + builds.len()
    }
    // `container`'s frame begins to be built — false where it is being built already (a read of its window the build
    // makes, which the build answers with none).
    pub(crate) fn begin_frame_build(&mut self, container: NodeId) -> bool {
        if self.frame_nav_has(container, crate::frame_navigation::BUILDING) {
            return false;
        }
        self.set_frame_nav(container, crate::frame_navigation::BUILDING, true);
        self.navigables.walks.builds.insert(container, next_mark());
        true
    }
    pub(crate) fn end_frame_build(&mut self, container: NodeId) {
        self.navigables.walks.builds.remove(&container);
        self.set_frame_nav(container, crate::frame_navigation::BUILDING, false);
    }
}

// __dom.frameBuildBegin(containerNid) -> whether the frame's build begins (`begin_frame_build`).
fn frame_build_begin(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(container) = nid_arg(scope, &args, 0) else { return rv.set_bool(false) };
    let cid = realm_id(scope, &args);
    rv.set_bool(crate::dom::realm(scope, cid).begin_frame_build(container));
}
// __dom.frameBuildEnd(containerNid) — the frame's build done (`end_frame_build`).
fn frame_build_end(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(container) = nid_arg(scope, &args, 0) else { return };
    let cid = realm_id(scope, &args);
    crate::dom::realm(scope, cid).end_frame_build(container);
}

pub(crate) fn define(native: magnus::RModule) -> Result<(), magnus::Error> {
    use magnus::Module;
    native.define_module_function("last_mark", magnus::function!(last_mark, 0))?;
    Ok(())
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "promptWalk", prompt_walk, context_id);
    crate::dom::register(scope, ns, "unloadWalk", unload_walk, context_id);
    crate::dom::register(scope, ns, "walkNext", walk_next, context_id);
    crate::dom::register(scope, ns, "walkDisposeOrder", walk_dispose_order, context_id);
    crate::dom::register(scope, ns, "walkEnd", walk_end, context_id);
    crate::dom::register(scope, ns, "endLeftOpenSince", end_left_open_since, context_id);
    crate::dom::register(scope, ns, "frameBuildBegin", frame_build_begin, context_id);
    crate::dom::register(scope, ns, "frameBuildEnd", frame_build_end, context_id);
}

// __dom.promptWalk(realm, traversal) -> the walk asking realm `realm`'s document and its descendants' whether they may
// be unloaded (`Kind::Prompt`), `traversal` as a traversal applies its step (navigables.rs `session_history_takes`).
fn prompt_walk(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let root = args.get(0).int32_value(scope).unwrap_or(0);
    let traversal = args.get(1).is_true();
    let cid = realm_id(scope, &args);
    rv.set_uint32(crate::dom::realm(scope, cid).begin_walk(root, Kind::Prompt { asking: None, traversal }));
}
// __dom.unloadWalk(realm) -> the walk unloading realm `realm`'s document and its descendants' (`Kind::Unload`).
fn unload_walk(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let root = args.get(0).int32_value(scope).unwrap_or(0);
    let cid = realm_id(scope, &args);
    rv.set_uint32(crate::dom::realm(scope, cid).begin_walk(root, Kind::Unload));
}
// __dom.walkNext(walk) -> the realm whose document's events to fire next (`walk_next`), -1 for none.
fn walk_next(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let id = args.get(0).uint32_value(scope).unwrap_or(0);
    let cid = realm_id(scope, &args);
    rv.set_int32(crate::dom::realm(scope, cid).walk_next(id).unwrap_or(-1));
}
// __dom.walkDisposeOrder(walk, withRoot) -> the realms to dispose, in order (`walk_dispose_order`).
fn walk_dispose_order(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let id = args.get(0).uint32_value(scope).unwrap_or(0);
    let with_root = args.get(1).is_true();
    let cid = realm_id(scope, &args);
    let order = crate::dom::realm(scope, cid).walk_dispose_order(id, with_root);
    let items: Vec<v8::Local<'_, v8::Value>> = order.iter().map(|&r| v8::Integer::new(scope, r).into()).collect();
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}
// __dom.walkEnd(walk) -> the realms to destroy (`end_walk`), the walk done.
fn walk_end(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let id = args.get(0).uint32_value(scope).unwrap_or(0);
    let cid = realm_id(scope, &args);
    let removed = crate::dom::realm(scope, cid).end_walk(id);
    let items: Vec<v8::Local<'_, v8::Value>> = removed.iter().map(|&r| v8::Integer::new(scope, r).into()).collect();
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}
// __dom.endLeftOpenSince(mark) -> how many walks and builds begun after number `mark` were left open, each ended
// (`end_left_open_since`) — and the synchronous host waits of the agent's scripts begun after it too (agent_clock.rs
// `agentWait`): one left raised kept every script turn open from then on, the time between the host's polls counted
// twice.
fn end_left_open_since(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let mark = args.get(0).uint32_value(scope).unwrap_or(0);
    let cid = realm_id(scope, &args);
    let ended = crate::dom::realm(scope, cid).end_left_open_since(mark) + crate::dom::dom(scope).agent_time.end_waits_since(mark);
    rv.set_uint32(u32::try_from(ended).unwrap_or(u32::MAX));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dom::{NodeData, NodeId, NodeKind};
    use web_atoms::ns;

    fn element(arena: &mut RealmArena, parent: NodeId, name: &str) -> NodeId {
        let mut n = NodeData::of_kind(NodeKind::Element, Vec::new());
        n.local_name = name.into();
        n.ns = ns!(html);
        arena.create(n, Some(parent))
    }
    fn document(arena: &mut RealmArena, realm: i32) -> NodeId {
        arena.enter(realm);
        let doc = arena.create(NodeData::of_kind(NodeKind::Document, Vec::new()), None);
        arena.set_realm_document(realm, doc);
        element(arena, doc, "body")
    }
    // The page (0) holds frames `a` and `b`, in that tree order, whose documents were made the other way round (realms 2
    // and 1); `a`'s holds a frame `c` (realm 3).
    fn page() -> (RealmArena, [NodeId; 3]) {
        let mut arena = RealmArena::default();
        let body = document(&mut arena, 0);
        let a = element(&mut arena, body, "iframe");
        let b = element(&mut arena, body, "iframe");
        let a_body = document(&mut arena, 2);
        let c = element(&mut arena, a_body, "iframe");
        document(&mut arena, 1);
        document(&mut arena, 3);
        arena.enter(0);
        arena.set_frame_realm(b, Some(1));
        arena.set_frame_realm(a, Some(2));
        arena.set_frame_realm(c, Some(3));
        (arena, [a, b, c])
    }
    fn walk(arena: &mut RealmArena, id: u32) -> Vec<i32> {
        std::iter::from_fn(|| arena.walk_next(id)).collect()
    }

    #[test]
    fn a_prompt_asks_the_tree_in_tree_order_each_while_its_handlers_run() {
        let (mut arena, _) = page();
        assert_eq!(arena.child_realms(0), vec![1, 2]);
        let id = arena.begin_walk(0, Kind::Prompt { asking: None, traversal: true });
        assert_eq!(arena.walk_next(id), Some(0));
        assert!(arena.unloading(0) && !arena.session_history_takes(0));
        assert_eq!(arena.walk_next(id), Some(2));
        assert!(!arena.unloading(0) && arena.unloading(2));
        assert_eq!(walk(&mut arena, id), vec![3, 1]);
        arena.end_walk(id);
        assert!((0..4).all(|r| !arena.unloading(r)));
    }

    #[test]
    fn a_prompt_skips_a_document_a_handler_destroyed_and_asks_none_it_made() {
        let (mut arena, [a, b, _]) = page();
        let id = arena.begin_walk(0, Kind::Prompt { asking: None, traversal: false });
        assert_eq!(arena.walk_next(id), Some(0));
        // (…a handler removing `b`, and putting a frame `d` into `a`'s document: not in the list the prompt began with)
        arena.discard_navigable(b);
        let a_body = arena.realm_document(2).and_then(|d| arena.get(d)).map(|d| d.children[0]).expect("a's body");
        arena.enter(2);
        let d = element(&mut arena, a_body, "iframe");
        document(&mut arena, 4);
        arena.enter(0);
        arena.set_frame_realm(d, Some(4));
        assert_eq!(walk(&mut arena, id), vec![2, 3]);
        arena.end_walk(id);
        assert!(arena.realm_under(4, 0) && !arena.realm_under(1, 0) && arena.frame_realm(a) == Some(2));
    }

    #[test]
    fn an_unload_goes_children_first_its_counters_raised_until_it_ends() {
        let (mut arena, [_, b, _]) = page();
        let id = arena.begin_walk(0, Kind::Unload);
        assert_eq!(arena.walk_next(id), Some(3));
        assert!([0, 2, 3].iter().all(|&r| arena.unloading(r)) && !arena.unloading(1));
        assert_eq!(arena.walk_next(id), Some(2));
        // (…`b` removed by a handler of `a`'s: none of it unloaded here — its removal unloads it — nor destroyed with the
        // page's)
        arena.discard_navigable(b);
        assert_eq!(walk(&mut arena, id), vec![0]);
        assert_eq!(arena.walk_dispose_order(id, true), vec![3, 2, 0]);
        assert_eq!(arena.walk_dispose_order(id, false), vec![3, 2]);
        arena.end_walk(id);
        assert!((0..4).all(|r| !arena.unloading(r)));
    }

    #[test]
    fn a_prompt_destroys_a_document_whose_own_handler_removed_its_frame_once_it_is_asked() {
        let (mut arena, [_, b, c]) = page();
        let id = arena.begin_walk(0, Kind::Prompt { asking: None, traversal: false });
        assert_eq!([0, 2, 3].map(|_| arena.walk_next(id)), [Some(0), Some(2), Some(3)]);
        // (…`c`'s handler removing `c` itself: asked still, its realm not yet to go)
        arena.discard_navigable(c);
        assert!(arena.unloading(3));
        assert_eq!(arena.walk_next(id), Some(1));
        assert!(!arena.unloading(3));
        // (…`b`'s removing `b`, the last asked, as the walk ends)
        arena.discard_navigable(b);
        assert_eq!(arena.end_walk(id), vec![3, 1]);
    }

    #[test]
    fn an_unload_destroys_a_document_whose_navigable_a_handler_destroyed_after_its_children_were_taken() {
        let (mut arena, [a, ..]) = page();
        let id = arena.begin_walk(0, Kind::Unload);
        assert_eq!(arena.walk_next(id), Some(3));
        // (…`c`'s handler removing `a`, whose unloading had begun: none of its own fires, but it goes with the page's)
        arena.discard_navigable(a);
        assert_eq!(walk(&mut arena, id), vec![1, 0]);
        assert_eq!(arena.walk_dispose_order(id, true), vec![1, 0, 3, 2]);
        arena.end_walk(id);
        assert!((0..4).all(|r| !arena.unloading(r)));
    }

    #[test]
    fn an_unload_destroys_the_frames_under_a_document_whose_navigable_went_with_an_ancestor() {
        // (…the page holds `a` (2) holding `c` (3) holding `d` (4))
        let (mut arena, [a, ..]) = page();
        let c_doc = arena.realm_document(3).expect("c's document");
        arena.enter(3);
        let d = element(&mut arena, c_doc, "iframe");
        document(&mut arena, 4);
        arena.enter(0);
        arena.set_frame_realm(d, Some(4));
        let id = arena.begin_walk(0, Kind::Unload);
        assert_eq!(arena.walk_next(id), Some(4));
        // (…`d`'s handler removing `a`, its grandparent: `c`, taken, has a navigable still — of a destroyed document)
        arena.discard_navigable(a);
        assert!(!arena.navigable_destroyed(3) && arena.navigable_destroyed(2));
        assert_eq!(walk(&mut arena, id), vec![1, 0]);
        assert_eq!(arena.walk_dispose_order(id, true), vec![1, 0, 4, 3, 2]);
        arena.end_walk(id);
    }

    #[test]
    fn walks_a_call_left_open_are_ended_but_none_begun_before_it() {
        let (mut arena, _) = page();
        let running = arena.begin_walk(0, Kind::Unload);
        assert_eq!(arena.walk_next(running), Some(3));
        let mark = last_mark();
        let unload = arena.begin_walk(2, Kind::Unload);
        assert_eq!(arena.walk_next(unload), Some(3));
        let prompt = arena.begin_walk(1, Kind::Prompt { asking: None, traversal: false });
        assert_eq!(arena.walk_next(prompt), Some(1));
        assert_eq!(arena.end_left_open_since(mark), 2);
        // (…and a frame's build mark the same way: one an earlier entry's build set stands)
        let (mut builds, [a, b, _]) = page();
        assert!(builds.begin_frame_build(a));
        let mark = last_mark();
        assert!(builds.begin_frame_build(b) && !builds.begin_frame_build(b));
        assert_eq!(builds.end_left_open_since(mark), 1);
        assert!(builds.begin_frame_build(b) && !builds.begin_frame_build(a));
        builds.end_frame_build(a);
        assert!(builds.begin_frame_build(a));
        assert!(arena.unloading(0) && arena.unloading(2) && arena.unloading(3) && !arena.unloading(1));
        assert_eq!(arena.walk_next(running), Some(2));
        arena.end_walk(running);
        assert!((0..4).all(|r| !arena.unloading(r)));
    }

    #[test]
    fn a_walk_lowers_only_the_counters_it_raised() {
        let (mut arena, _) = page();
        let outer = arena.begin_walk(0, Kind::Unload);
        assert_eq!(arena.walk_next(outer), Some(3));
        let inner = arena.begin_walk(2, Kind::Unload);
        assert_eq!(walk(&mut arena, inner), vec![3, 2]);
        arena.end_walk(inner);
        assert!(arena.unloading(2) && arena.unloading(3));
        let prompt = arena.begin_walk(2, Kind::Prompt { asking: None, traversal: false });
        assert_eq!(walk(&mut arena, prompt), vec![2, 3]);
        arena.end_walk(prompt);
        assert!(arena.unloading(2) && arena.unloading(3));
        arena.end_walk(outer);
        assert!((0..4).all(|r| !arena.unloading(r)));
    }
}
