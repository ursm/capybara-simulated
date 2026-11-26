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
// - "abort a document and its descendants": its descendant navigables in tree order — each document before its frames',
//   HTML's flat list — their requests cancelled at once and then its own — no network's time here to have kept them from
//   being answered first (Chrome and Firefox abort a frame's XHR with its parent's `stop()`) — and then the rest of each
//   one's abort in the same order, before the document's own: at once for a document being parsed (its parser on the
//   stack, a script of it stopping its parent: there is no next chunk of its for a task to come between, and Chrome and
//   Firefox parse none of its markup after that script), else as a task queued on its own event loop (HTML).
//   What a teardown makes of each document it unloads and then of their realms is the walk's (`Teardown`): the bindings
//   run each step it hands them (`teardownNext`) — fire a document's pagehide and unload, take its controls' state for
//   the entry it leaves, drop its connections, dispose a realm — and decide none of it.
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
    // (…the document being asked now, its counter raised by the walk, and whether a traversal applies its step; whether
    // the user has been asked — by this walk, or a check it is part of — and what the user answered (`PROMPT_*`); and the
    // container of the root's navigable as the walk began, whose removal by a handler destroys it)
    Prompt { asking: Option<i32>, traversal: bool, shown: bool, verdict: u32, container: Option<NodeId> },
    // (…what it makes of the documents, and — once every one is unloaded — the realms still to dispose, the next last,
    // each with whether its WindowProxies are kept: `teardown_next`)
    Unload { teardown: Teardown, disposing: Option<Vec<(i32, bool)>> },
    // (…its requests' phase still under way, and whether the root's rest is aborted yet)
    Abort { requests: bool, root_done: bool },
}

// A step of an abort (`abort_next`), its realm above the low bits: cancel the requests of its document, abort the rest of
// it now, or queue a task on its event loop that does.
pub(crate) const ABORT_REQUESTS: u32 = 0;
pub(crate) const ABORT_NOW: u32 = 1;
pub(crate) const ABORT_TASK: u32 = 2;
const ABORT_BITS: u32 = 2;

// What a teardown of realm `root`'s document and its descendants' is for, which says what each step does.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Teardown {
    // Its navigable goes on to a document made in another realm (a frame's navigation committing; a frame with no task
    // coming for its navigation, disconnected): the root's entry keeps its controls' state as its handlers left them;
    // every realm disposed, the WindowProxies of the root's window kept where its container still stands — the next
    // document's window is theirs (handles.js `retargetWindowProxy`).
    Navigated,
    // …to one made in the root's realm, whose Window the next document keeps (bridge.entry.js `keepsWindowFor`): the
    // root's realm left to it, its frames' disposed.
    WindowKept,
    // Its navigable destroyed, its container removed (HTML "destroy a child navigable"): its session history with it, no
    // entry to keep state for, every realm disposed — and no pagehide, no unload, which only "unload a document" fires,
    // but where (`unloaded`) a document above it is unloading, whose descendants HTML "unload a document and its
    // descendants" unloads first (Chrome alike).
    Destroyed { unloaded: bool },
    // The page's or a window's, which the host navigates or closes: its documents unloaded, their realms the host's.
    Host,
}
impl Teardown {
    // By the bindings' number (`TEARDOWN_*`, dom-nodes.js).
    fn of(code: u32) -> Option<Self> {
        Some(match code {
            0 => Self::Navigated,
            1 => Self::WindowKept,
            2 => Self::Destroyed { unloaded: false },
            3 => Self::Destroyed { unloaded: true },
            4 => Self::Host,
            _ => return None,
        })
    }
}

#[cfg(test)]
impl Kind {
    fn prompt(traversal: bool) -> Self {
        Kind::Prompt { asking: None, traversal, shown: false, verdict: PROMPT_NONE, container: None }
    }
}

// What a check whether unloading is canceled came to (`promptVerdict`): the user not asked, asked and confirming,
// declining (HTML: canceled) — or the root's container removed by a handler meanwhile, its navigable destroyed (HTML
// "destroy a child navigable"), the navigation that asked going no further.
const PROMPT_NONE: u32 = 0;
const PROMPT_SHOWN: u32 = 1;
const PROMPT_CANCELED: u32 = 2;
const PROMPT_REMOVED: u32 = 3;

// A step of a teardown (`teardown_next`), its realm above the low bits: unload its document — its pagehide and unload
// fired where `STEP_EVENTS`, its controls' state taken for its entry where `STEP_SAVE`, its connections dropped either way
// — or dispose its realm (`STEP_DISPOSE`), its WindowProxies kept where `STEP_KEEP_PROXIES`.
pub(crate) const STEP_EVENTS: u32 = 1;
pub(crate) const STEP_SAVE: u32 = 1 << 1;
pub(crate) const STEP_DISPOSE: u32 = 1 << 2;
pub(crate) const STEP_KEEP_PROXIES: u32 = 1;
const STEP_BITS: u32 = 3;

impl RealmArena {
    fn begin_walk(&mut self, root: i32, kind: Kind) -> u32 {
        let pending = match kind {
            Kind::Prompt { .. } => self.inclusive_descendant_realms(root).into_iter().rev().map(|r| (r, false, 0)).collect(),
            Kind::Unload { .. } => vec![(root, false, 0)],
            Kind::Abort { .. } => self.child_realms_in_tree_order(root).into_iter().rev().map(|r| (r, false, 1)).collect(),
        };
        let id = next_mark();
        self.navigables.walks.open.insert(id, Walk { root, kind, pending, reached: Vec::new(), raised: Vec::new(), removed: Vec::new() });
        id
    }
    // The realm of the next document walk `id` reaches, its unload counter raised — none where it is done.
    pub(crate) fn walk_next(&mut self, id: u32) -> Option<i32> {
        let mut walk = self.navigables.walks.open.remove(&id)?;
        let next = match walk.kind {
            Kind::Prompt { ref mut asking, traversal, .. } => {
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
            Kind::Unload { .. } => self.next_to_unload(&mut walk),
            Kind::Abort { .. } => None,
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
        let removed: &[i32] = if matches!(walk.kind, Kind::Unload { .. }) { &walk.removed } else { &[] };
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
    // A check whether realm `root`'s document and its descendants' may be unloaded begun, from realm `cid` (its
    // container's, a frame's) — `shown` where the user was asked by a check this one is part of (a traversal's over
    // several navigables: browser.rb `unload_traversed_frames`), who is then asked no second time.
    pub(crate) fn begin_prompt(&mut self, cid: i32, root: i32, traversal: bool, shown: bool) -> u32 {
        let container = self.frame_container(cid, root);
        self.begin_walk(root, Kind::Prompt { asking: None, traversal, shown, verdict: PROMPT_NONE, container })
    }
    // Whether the user is to be asked now, the handlers of the document being asked wanting it — the first such
    // document's alone (HTML "check if unloading is canceled": `unloadPromptShown`).
    pub(crate) fn prompt_shows(&mut self, id: u32) -> bool {
        let Some(Walk { kind: Kind::Prompt { shown, .. }, .. }) = self.navigables.walks.open.get_mut(&id) else { return false };
        !std::mem::replace(shown, true)
    }
    // …and what the user answered (the driver's dialog policy: Browser#handle_modal).
    pub(crate) fn prompt_answered(&mut self, id: u32, confirmed: bool) {
        if let Some(Walk { kind: Kind::Prompt { verdict, .. }, .. }) = self.navigables.walks.open.get_mut(&id) {
            *verdict = if confirmed { PROMPT_SHOWN } else { PROMPT_CANCELED };
        }
    }
    // What check `id` came to (`PROMPT_*`), asked before it ends.
    pub(crate) fn prompt_verdict(&self, id: u32) -> u32 {
        let Some(Walk { kind: Kind::Prompt { verdict, container, .. }, .. }) = self.navigables.walks.open.get(&id) else { return PROMPT_NONE };
        if container.is_some_and(|c| !self.is_connected(c)) { PROMPT_REMOVED } else { *verdict }
    }
    // A teardown of realm `root`'s document and its descendants' begun (`Teardown`), from realm `cid` — the one whose
    // document holds the root's container, a frame's — the walk its steps come from (`teardown_next`): the navigable of
    // a destroyed one's session history destroyed first.
    pub(crate) fn begin_teardown(&mut self, root: i32, teardown: Teardown) -> u32 {
        if matches!(teardown, Teardown::Destroyed { .. }) {
            crate::session_history::destroy_navigable_history(self, root);
        }
        self.begin_walk(root, Kind::Unload { teardown, disposing: None })
    }
    // The next step of teardown `id`, begun from realm `cid` — its realm, and what to do (`STEP_*`) — none where it is
    // done: each document unloaded in the walk's order, then, once all are, their realms disposed in the order they go
    // (`walk_dispose_order`), whatever the documents' handlers did to the tree meanwhile. The walk is the caller's to end.
    pub(crate) fn teardown_next(&mut self, cid: i32, id: u32) -> Option<(i32, u32)> {
        let walk = self.navigables.walks.open.get(&id)?;
        let Kind::Unload { teardown, ref disposing } = walk.kind else { return None };
        let root = walk.root;
        if disposing.is_none() {
            if let Some(realm) = self.walk_next(id) {
                let events = teardown != Teardown::Destroyed { unloaded: false };
                let save = realm == root && matches!(teardown, Teardown::Navigated | Teardown::WindowKept);
                return Some((realm, if events { STEP_EVENTS } else { 0 } | if save { STEP_SAVE } else { 0 }));
            }
            // (…the root's WindowProxies kept where its container still stands once its handlers have run: a frame
            // removed by one of them is destroyed with its navigable)
            let order = match teardown {
                Teardown::Host => Vec::new(),
                Teardown::WindowKept => self.walk_dispose_order(id, false),
                Teardown::Navigated | Teardown::Destroyed { .. } => self.walk_dispose_order(id, true),
            };
            let kept = teardown == Teardown::Navigated && self.frame_container(cid, root).is_some();
            let disposing = order.into_iter().rev().map(|r| (r, kept && r == root)).collect();
            if let Some(Walk { kind: Kind::Unload { disposing: slot, .. }, .. }) = self.navigables.walks.open.get_mut(&id) {
                *slot = Some(disposing);
            }
        }
        let Some(Walk { kind: Kind::Unload { disposing: Some(list), .. }, .. }) = self.navigables.walks.open.get_mut(&id) else { return None };
        let (realm, kept) = list.pop()?;
        Some((realm, STEP_DISPOSE | if kept { STEP_KEEP_PROXIES } else { 0 }))
    }
    // An abort of realm `root`'s document and its descendants' begun (HTML "abort a document and its descendants").
    pub(crate) fn begin_abort(&mut self, root: i32) -> u32 {
        self.begin_walk(root, Kind::Abort { requests: true, root_done: false })
    }
    // The next step of abort `id` — its realm and what to do (`ABORT_*`) — none where it is done: the requests of each
    // document below the root's in tree order, a document before its frames', then the root's; then, in the same order,
    // the rest of each — at once where its document is being parsed, else on a task of its own — and the root's last.
    // Each frame's children read as the walk reaches it, a realm whose document is gone meanwhile passed over.
    pub(crate) fn abort_next(&mut self, id: u32) -> Option<(i32, u32)> {
        let mut walk = self.navigables.walks.open.remove(&id)?;
        let step = self.next_to_abort(&mut walk);
        self.navigables.walks.open.insert(id, walk);
        step
    }
    fn next_to_abort(&mut self, walk: &mut Walk) -> Option<(i32, u32)> {
        let Kind::Abort { requests, root_done } = walk.kind else { return None };
        while let Some((realm, _, depth)) = walk.pending.pop() {
            let Some(doc) = self.realm_document(realm) else { continue };
            if depth < crate::navigables::MAX_NESTING {
                walk.pending.extend(self.child_realms_in_tree_order(realm).into_iter().rev().map(|r| (r, false, depth + 1)));
            }
            let step = if requests {
                ABORT_REQUESTS
            } else if self.document_states.lifecycle(doc).is_parsing() {
                ABORT_NOW
            } else {
                ABORT_TASK
            };
            return Some((realm, step));
        }
        let root = walk.root;
        if requests {
            walk.kind = Kind::Abort { requests: false, root_done: false };
            walk.pending = self.child_realms_in_tree_order(root).into_iter().rev().map(|r| (r, false, 1)).collect();
            return Some((root, ABORT_REQUESTS));
        }
        if root_done {
            return None;
        }
        walk.kind = Kind::Abort { requests: false, root_done: true };
        Some((root, ABORT_NOW))
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
// __dom.frameBuildEnd(containerNid) -> the frame's build done (`end_frame_build`): the steps of its `load` held while it
// was under way, to run again — `[run, phase, …]` (frame_navigation.rs `frameLoadNext`).
fn frame_build_end(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(container) = nid_arg(scope, &args, 0) else { return };
    let cid = realm_id(scope, &args);
    let arena = crate::dom::realm(scope, cid);
    arena.end_frame_build(container);
    let held = arena.take_after_build(container);
    if held.is_empty() {
        return;
    }
    let items: Vec<v8::Local<'_, v8::Value>> = held.iter().flat_map(|&(run, phase)| [run, phase]).map(|n| v8::Integer::new_from_unsigned(scope, n).into()).collect();
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}

pub(crate) fn define(native: magnus::RModule) -> Result<(), magnus::Error> {
    native.define_module_function("last_mark", magnus::function!(last_mark, 0))?;
    Ok(())
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "promptWalk", prompt_walk, context_id);
    crate::dom::register(scope, ns, "promptShows", prompt_shows, context_id);
    crate::dom::register(scope, ns, "promptAnswered", prompt_answered, context_id);
    crate::dom::register(scope, ns, "promptVerdict", prompt_verdict, context_id);
    crate::dom::register(scope, ns, "teardown", teardown, context_id);
    crate::dom::register(scope, ns, "abortWalk", abort_walk, context_id);
    crate::dom::register(scope, ns, "abortNext", abort_next, context_id);
    crate::dom::register(scope, ns, "teardownNext", teardown_next, context_id);
    crate::dom::register(scope, ns, "walkNext", walk_next, context_id);
    crate::dom::register(scope, ns, "walkEnd", walk_end, context_id);
    crate::dom::register(scope, ns, "endLeftOpenSince", end_left_open_since, context_id);
    crate::dom::register(scope, ns, "frameBuildBegin", frame_build_begin, context_id);
    crate::dom::register(scope, ns, "frameBuildEnd", frame_build_end, context_id);
}

// __dom.promptWalk(realm, traversal, shown) -> the walk asking realm `realm`'s document and its descendants' whether they
// may be unloaded (`begin_prompt`), `traversal` as a traversal applies its step (navigables.rs `session_history_takes`).
fn prompt_walk(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let root = args.get(0).int32_value(scope).unwrap_or(0);
    let traversal = args.get(1).is_true();
    let cid = realm_id(scope, &args);
    let shown = args.get(2).is_true();
    rv.set_uint32(crate::dom::realm(scope, cid).begin_prompt(cid, root, traversal, shown));
}
// __dom.promptShows(walk) -> whether the user is to be asked now (`prompt_shows`).
fn prompt_shows(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let id = args.get(0).uint32_value(scope).unwrap_or(0);
    let cid = realm_id(scope, &args);
    rv.set_bool(crate::dom::realm(scope, cid).prompt_shows(id));
}
// __dom.promptAnswered(walk, confirmed) — what the user answered (`prompt_answered`).
fn prompt_answered(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let id = args.get(0).uint32_value(scope).unwrap_or(0);
    let confirmed = args.get(1).is_true();
    let cid = realm_id(scope, &args);
    crate::dom::realm(scope, cid).prompt_answered(id, confirmed);
}
// __dom.promptVerdict(walk) -> what the check came to (`PROMPT_*`).
fn prompt_verdict(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let id = args.get(0).uint32_value(scope).unwrap_or(0);
    let cid = realm_id(scope, &args);
    rv.set_uint32(crate::dom::realm(scope, cid).prompt_verdict(id));
}
// __dom.abortWalk() -> the walk aborting this realm's document and its descendants' (`begin_abort`).
fn abort_walk(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    rv.set_uint32(crate::dom::realm(scope, cid).begin_abort(cid));
}
// __dom.abortNext(walk) -> the next step of the abort (`abort_next`): its realm shifted above `ABORT_BITS`, the step in
// them — -1 for none.
fn abort_next(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let id = args.get(0).uint32_value(scope).unwrap_or(0);
    let cid = realm_id(scope, &args);
    let step = crate::dom::realm(scope, cid).abort_next(id);
    rv.set_int32(step.map_or(-1, |(realm, what)| (realm << ABORT_BITS) | what as i32));
}
// __dom.teardown(realm, teardown) -> the walk tearing realm `realm`'s document and its descendants' down, for what
// `teardown` names (`Teardown::of`) — or -1 for no realm's number or a purpose number that names none.
fn teardown(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    // (…a realm's number alone: no other value is read as the page's)
    let root = args.get(0);
    let Some(root) = root.is_int32().then(|| root.int32_value(scope)).flatten().filter(|&r| r >= 0) else { return rv.set_int32(-1) };
    let Some(teardown) = Teardown::of(args.get(1).uint32_value(scope).unwrap_or(u32::MAX)) else { return rv.set_int32(-1) };
    let cid = realm_id(scope, &args);
    rv.set_uint32(crate::dom::realm(scope, cid).begin_teardown(root, teardown));
}
// __dom.teardownNext(walk) -> the next step of the teardown (`teardown_next`): its realm shifted above `STEP_BITS`, the
// step in them — -1 for none.
fn teardown_next(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let id = args.get(0).uint32_value(scope).unwrap_or(0);
    let cid = realm_id(scope, &args);
    let step = crate::dom::realm(scope, cid).teardown_next(cid, id);
    rv.set_int32(step.map_or(-1, |(realm, what)| (realm << STEP_BITS) | what as i32));
}
// __dom.walkNext(walk) -> the realm whose document's events to fire next (`walk_next`), -1 for none.
fn walk_next(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let id = args.get(0).uint32_value(scope).unwrap_or(0);
    let cid = realm_id(scope, &args);
    rv.set_int32(crate::dom::realm(scope, cid).walk_next(id).unwrap_or(-1));
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
        let id = arena.begin_walk(0, Kind::prompt(true));
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
        let id = arena.begin_walk(0, Kind::prompt(false));
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
        let id = arena.begin_walk(0, Kind::Unload { teardown: Teardown::Host, disposing: None });
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
        let id = arena.begin_walk(0, Kind::prompt(false));
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
        let id = arena.begin_walk(0, Kind::Unload { teardown: Teardown::Host, disposing: None });
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
        let id = arena.begin_walk(0, Kind::Unload { teardown: Teardown::Host, disposing: None });
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
        let running = arena.begin_walk(0, Kind::Unload { teardown: Teardown::Host, disposing: None });
        assert_eq!(arena.walk_next(running), Some(3));
        let mark = last_mark();
        let unload = arena.begin_walk(2, Kind::Unload { teardown: Teardown::Host, disposing: None });
        assert_eq!(arena.walk_next(unload), Some(3));
        let prompt = arena.begin_walk(1, Kind::prompt(false));
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
    fn a_teardown_unloads_then_disposes_as_its_purpose_says() {
        let steps = |arena: &mut RealmArena, id: u32| std::iter::from_fn(|| arena.teardown_next(0, id)).collect::<Vec<_>>();
        // (…`a` (2) navigated: its own entry's state saved, every realm disposed, its WindowProxies kept)
        let (mut arena, _) = page();
        let id = arena.begin_teardown(2, Teardown::Navigated);
        assert_eq!(steps(&mut arena, id), vec![(3, STEP_EVENTS), (2, STEP_EVENTS | STEP_SAVE), (3, STEP_DISPOSE), (2, STEP_DISPOSE | STEP_KEEP_PROXIES)]);
        assert!(arena.unloading(2) && arena.unloading(3));
        arena.end_walk(id);
        assert!(!arena.unloading(2) && !arena.unloading(3));
        // (…its Window kept: its own realm left to the next document)
        let (mut arena, _) = page();
        let id = arena.begin_teardown(2, Teardown::WindowKept);
        assert_eq!(steps(&mut arena, id), vec![(3, STEP_EVENTS), (2, STEP_EVENTS | STEP_SAVE), (3, STEP_DISPOSE)]);
        arena.end_walk(id);
        // (…destroyed: no event, no state, none kept — but fired where a document above it unloads)
        let (mut arena, _) = page();
        let id = arena.begin_teardown(2, Teardown::Destroyed { unloaded: false });
        assert_eq!(steps(&mut arena, id), vec![(3, 0), (2, 0), (3, STEP_DISPOSE), (2, STEP_DISPOSE)]);
        arena.end_walk(id);
        let (mut arena, _) = page();
        let id = arena.begin_teardown(2, Teardown::Destroyed { unloaded: true });
        assert_eq!(steps(&mut arena, id), vec![(3, STEP_EVENTS), (2, STEP_EVENTS), (3, STEP_DISPOSE), (2, STEP_DISPOSE)]);
        arena.end_walk(id);
        // (…the host's: unloaded, nothing disposed)
        let (mut arena, _) = page();
        let id = arena.begin_teardown(0, Teardown::Host);
        assert_eq!(steps(&mut arena, id), vec![(3, STEP_EVENTS), (2, STEP_EVENTS), (1, STEP_EVENTS), (0, STEP_EVENTS)]);
        arena.end_walk(id);
    }

    #[test]
    fn a_navigated_teardown_keeps_no_proxies_of_a_frame_its_handlers_removed() {
        let (mut arena, [a, ..]) = page();
        let id = arena.begin_teardown(2, Teardown::Navigated);
        assert_eq!(arena.teardown_next(0, id), Some((3, STEP_EVENTS)));
        arena.discard_navigable(a);
        assert_eq!(arena.teardown_next(0, id), Some((2, STEP_EVENTS | STEP_SAVE)));
        assert_eq!(std::iter::from_fn(|| arena.teardown_next(0, id)).collect::<Vec<_>>(), vec![(3, STEP_DISPOSE), (2, STEP_DISPOSE)]);
        arena.end_walk(id);
    }

    #[test]
    fn a_prompt_asks_the_user_once_and_says_what_came_of_it() {
        let (mut arena, [a, ..]) = page();
        let id = arena.begin_prompt(0, 2, false, false);
        assert_eq!(arena.walk_next(id), Some(2));
        assert!(arena.prompt_shows(id) && !arena.prompt_shows(id));
        arena.prompt_answered(id, false);
        assert_eq!(arena.prompt_verdict(id), PROMPT_CANCELED);
        arena.end_walk(id);
        let shown = arena.begin_prompt(0, 2, false, true);
        assert!(!arena.prompt_shows(shown));
        assert_eq!(arena.prompt_verdict(shown), PROMPT_NONE);
        arena.end_walk(shown);
        // (…its frame removed by a handler as it is asked)
        let removed = arena.begin_prompt(0, 2, false, false);
        assert_eq!(arena.walk_next(removed), Some(2));
        arena.detach(a);
        assert_eq!(arena.prompt_verdict(removed), PROMPT_REMOVED);
        arena.end_walk(removed);
    }

    #[test]
    fn an_abort_goes_down_the_descendants_in_tree_order_requests_first_a_parsing_one_at_once() {
        let (mut arena, _) = page();
        // (…`a`'s document (2) being parsed, `c`'s (3) and `b`'s (1) loaded: a{c}, b)
        let a_doc = arena.realm_document(2).expect("a's document");
        arena.document_states.lifecycle_mut(a_doc).ready = crate::document_lifecycle::READY_LOADING;
        let id = arena.begin_abort(0);
        let steps: Vec<_> = std::iter::from_fn(|| arena.abort_next(id)).collect();
        assert_eq!(
            steps,
            vec![
                (2, ABORT_REQUESTS), (3, ABORT_REQUESTS), (1, ABORT_REQUESTS), (0, ABORT_REQUESTS),
                (2, ABORT_NOW), (3, ABORT_TASK), (1, ABORT_TASK), (0, ABORT_NOW),
            ]
        );
        arena.end_walk(id);
    }

    #[test]
    fn a_walk_lowers_only_the_counters_it_raised() {
        let (mut arena, _) = page();
        let outer = arena.begin_walk(0, Kind::Unload { teardown: Teardown::Host, disposing: None });
        assert_eq!(arena.walk_next(outer), Some(3));
        let inner = arena.begin_walk(2, Kind::Unload { teardown: Teardown::Host, disposing: None });
        assert_eq!(walk(&mut arena, inner), vec![3, 2]);
        arena.end_walk(inner);
        assert!(arena.unloading(2) && arena.unloading(3));
        let prompt = arena.begin_walk(2, Kind::prompt(false));
        assert_eq!(walk(&mut arena, prompt), vec![2, 3]);
        arena.end_walk(prompt);
        assert!(arena.unloading(2) && arena.unloading(3));
        arena.end_walk(outer);
        assert!((0..4).all(|r| !arena.unloading(r)));
    }
}
