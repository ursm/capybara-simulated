// The DOM's event path (DOM §2.9 "dispatch", steps 5-6, and "retarget"), where a shadow tree is in it: the nodes an event
// visits from its target up — a slotted node's next its assigned slot, a shadow root's its host unless the event is not
// composed and the root is its target's — each with the target its listeners see (retargeted as the path crosses into a
// lighter tree), its relatedTarget retargeted against it, and whether it is a closed shadow root or a slot in one. The
// page side fires the listeners.

use crate::dom::{nid_arg, realm_id, NodeId, NodeKind, RealmArena};

// What an event's relatedTarget is: none, a node, or something else (a Window), which no retargeting moves.
#[derive(Clone, Copy, PartialEq)]
enum Related {
    None,
    Node(NodeId),
    Other,
}

fn host_of(arena: &RealmArena, id: NodeId) -> Option<NodeId> {
    arena.get(id)?.host
}

// Whether `x` is a shadow-including inclusive ancestor of `y`.
fn shadow_including_ancestor(arena: &RealmArena, x: NodeId, y: NodeId) -> bool {
    let mut cur = Some(y);
    while let Some(n) = cur {
        if n == x {
            return true;
        }
        cur = arena.parent_of(n).or_else(|| host_of(arena, n));
    }
    false
}

// DOM "retarget" `a` against `b`: up out of every shadow tree whose root is no shadow-including ancestor of `b`.
fn retarget(arena: &RealmArena, a: Related, b: NodeId) -> Related {
    let Related::Node(mut a) = a else { return a };
    loop {
        let root = arena.root_of(a);
        match host_of(arena, root) {
            Some(host) if !shadow_including_ancestor(arena, root, b) => a = host,
            _ => return Related::Node(a),
        }
    }
}

// The slot `id` is assigned to — a slottable (an element or text) whose parent is a shadow host.
fn assigned_slot(arena: &RealmArena, id: NodeId) -> Option<NodeId> {
    let n = arena.get(id)?;
    if !matches!(n.kind, NodeKind::Element | NodeKind::Text) {
        return None;
    }
    let parent = arena.get(arena.parent_of(id)?)?;
    parent.shadow_root?;
    n.assigned_slot.filter(|&s| arena.get(s).is_some())
}

// DOM "get the parent" of `id` for an event: its assigned slot, a shadow root's host (none for the target's own root
// where the event is not composed), else its parent.
fn event_parent(arena: &RealmArena, id: NodeId, composed: bool, target_root: NodeId) -> Option<NodeId> {
    if let Some(host) = host_of(arena, id) {
        return (composed || id != target_root).then_some(host);
    }
    assigned_slot(arena, id).or_else(|| arena.parent_of(id))
}

// One step of the path: the node, the target its listeners see, its relatedTarget, and whether it is a closed shadow
// root, or a slot in a closed shadow tree a slottable was assigned to.
struct Step {
    node: NodeId,
    target: NodeId,
    related: Related,
    root_closed: bool,
    slot_closed: bool,
}

fn closed_root(arena: &RealmArena, id: NodeId) -> bool {
    arena.get(id).is_some_and(|n| n.host.is_some() && n.closed)
}

fn path(arena: &RealmArena, target: NodeId, related: Related, composed: bool) -> Vec<Step> {
    // (…an event whose relatedTarget retargets to its target — the target an ancestor of it — is not dispatched)
    if let Related::Node(r) = related {
        if r != target && retarget(arena, related, target) == Related::Node(target) {
            return Vec::new();
        }
    }
    let target_root = arena.root_of(target);
    let mut steps = vec![Step {
        node: target,
        target,
        related: retarget(arena, related, target),
        root_closed: closed_root(arena, target),
        slot_closed: false,
    }];
    let (mut current, mut current_root) = (target, target_root);
    let mut slottable = assigned_slot(arena, target).map(|_| target);
    let mut slot_in_closed_tree = false;
    let mut parent = event_parent(arena, target, composed, target_root);
    while let Some(p) = parent {
        if slottable.take().is_some() && closed_root(arena, arena.root_of(p)) {
            slot_in_closed_tree = true;
        }
        if assigned_slot(arena, p).is_some() {
            slottable = Some(p);
        }
        let rel = retarget(arena, related, p);
        if shadow_including_ancestor(arena, current_root, p) {
            // (…still in the current target's tree: its listeners see the running target)
        } else if related != Related::None && rel == Related::Node(p) {
            // (…the relatedTarget has caught up: the rest is ancestry both share, pruned)
            break;
        } else {
            // (…into a lighter tree: the target retargets to this host)
            current = p;
            current_root = arena.root_of(p);
        }
        steps.push(Step { node: p, target: current, related: rel, root_closed: closed_root(arena, p), slot_closed: slot_in_closed_tree });
        slot_in_closed_tree = false;
        parent = event_parent(arena, p, composed, target_root);
    }
    steps
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "eventPath", event_path, context_id);
    crate::dom::register(scope, ns, "retarget", retarget_op, context_id);
}

// __dom.retarget(aNid, bNid) -> DOM "retarget" the node `aNid` against the node `bNid` (null for something else, a
// Window, which no shadow root is an ancestor of): the node, as `nodes_value` answers it from `aNid`'s shadow-including
// root.
fn retarget_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(a) = nid_arg(scope, &args, 0) else { return };
    let b = nid_arg(scope, &args, 1);
    let cid = realm_id(scope, &args);
    let arena = crate::dom::realm(scope, cid);
    let found = match b {
        Some(b) => retarget(arena, Related::Node(a), b),
        // (…against no node: out of every shadow tree)
        None => {
            let mut a = a;
            while let Some(host) = host_of(arena, arena.root_of(a)) {
                a = host;
            }
            Related::Node(a)
        }
    };
    let Related::Node(found) = found else { return };
    let anchor = arena.shadow_including_root(a);
    let answer = crate::dom::nodes_value(scope, cid, anchor, &[found]);
    rv.set(answer);
}

// __dom.eventPath(targetNid, relatedNid, relatedOther, composed) -> [nodes, steps]: the event path from the target (the
// relatedTarget a node `relatedNid`, else none, or with `relatedOther` something no retargeting moves). `nodes` are the
// nodes it names, as `nodes_value` answers them — or, where one is in no document, as paths each after which tree it is
// in (0 the target's shadow-including root's, 1 the relatedTarget's); `steps` five numbers a step: its node, the target
// its listeners see, its relatedTarget (an index into `nodes`; -1 none, -2 the event's own), whether it is a closed
// shadow root, and whether it is a slot in a closed tree. Empty, where the event is not dispatched.
fn event_path(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(target) = nid_arg(scope, &args, 0) else { return };
    let related = match nid_arg(scope, &args, 1) {
        Some(r) => Related::Node(r),
        None if args.get(2).is_true() => Related::Other,
        None => Related::None,
    };
    let composed = args.get(3).is_true();
    let cid = realm_id(scope, &args);
    let arena = crate::dom::realm(scope, cid);
    let steps = path(arena, target, related, composed);
    // (…each node named once)
    let mut nodes: Vec<NodeId> = Vec::new();
    let mut index = |n: NodeId| match nodes.iter().position(|&x| x == n) {
        Some(i) => i as f64,
        None => {
            nodes.push(n);
            (nodes.len() - 1) as f64
        }
    };
    let mut out = Vec::with_capacity(steps.len() * 5);
    for s in &steps {
        out.push(index(s.node));
        out.push(index(s.target));
        out.push(match s.related {
            Related::None => -1.0,
            Related::Other => -2.0,
            Related::Node(r) => index(r),
        });
        out.push(s.root_closed as u8 as f64);
        out.push(s.slot_closed as u8 as f64);
    }
    let anchors = [Some(arena.shadow_including_root(target)), match related {
        Related::Node(r) => Some(arena.shadow_including_root(r)),
        _ => None,
    }];
    let nodes_answer = crate::dom::nodes_value_anchored(scope, cid, &anchors, &nodes);
    let steps_answer = crate::dom::f64_array(scope, &out);
    let answer = v8::Array::new_with_elements(scope, &[nodes_answer, steps_answer.into()]);
    rv.set(answer.into());
}
