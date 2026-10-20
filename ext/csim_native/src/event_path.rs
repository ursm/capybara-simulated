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

// DOM "retarget" `a` against `b`: up out of every shadow tree whose root is no shadow-including ancestor of `b` — what
// is no node (a Window) as it is.
fn retarget(arena: &RealmArena, a: Related, b: NodeId) -> Related {
    match a {
        Related::Node(a) => Related::Node(retarget_node(arena, a, b)),
        other => other,
    }
}
// …and against no node (a Window): out of every shadow tree.
fn retarget_out(arena: &RealmArena, mut a: NodeId) -> NodeId {
    while let Some(host) = host_of(arena, arena.root_of(a)) {
        a = host;
    }
    a
}
pub(crate) fn retarget_node(arena: &RealmArena, mut a: NodeId, b: NodeId) -> NodeId {
    loop {
        let root = arena.root_of(a);
        match host_of(arena, root) {
            Some(host) if !arena.shadow_including_ancestor(root, b) => a = host,
            _ => return a,
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

// One step of the path: the node, the target its listeners see, its relatedTarget, and its `STEP_*` flags.
struct Step {
    node: NodeId,
    target: NodeId,
    related: Related,
    flags: u8,
}

// A step's flags: a closed shadow root; a slot in a closed shadow tree a slottable was assigned to; a node whose root
// is a shadow root (DOM "invocation-target-in-shadow-tree", taken as the path is built); a node that is its own
// shadow-adjusted target, whose listeners run AT_TARGET in either pass.
const STEP_ROOT_CLOSED: u8 = 1;
const STEP_SLOT_CLOSED: u8 = 2;
const STEP_IN_SHADOW: u8 = 4;
const STEP_AT_TARGET: u8 = 8;

fn closed_root(arena: &RealmArena, id: NodeId) -> bool {
    arena.get(id).is_some_and(|n| n.host.is_some() && n.shadow_is(crate::dom::SHADOW_CLOSED))
}

// (…`root` the node's root, which the path builder follows as it goes rather than walking up to it a step)
fn step_flags(arena: &RealmArena, id: NodeId, root: NodeId, slot_closed: bool) -> u8 {
    let in_shadow = arena.get(root).is_some_and(|n| n.host.is_some());
    (closed_root(arena, id) as u8 * STEP_ROOT_CLOSED) | (slot_closed as u8 * STEP_SLOT_CLOSED) | (in_shadow as u8 * STEP_IN_SHADOW)
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
        flags: step_flags(arena, target, target_root, false) | STEP_AT_TARGET,
    }];
    let (mut current, mut current_root) = (target, target_root);
    let mut slottable = assigned_slot(arena, target).map(|_| target);
    let mut slot_in_closed_tree = false;
    let mut parent = event_parent(arena, target, composed, target_root);
    // (…the root of the step before: a parent shares it, a shadow root's host or a slottable's slot is in another tree)
    let (mut prev, mut root) = (target, target_root);
    while let Some(p) = parent {
        if host_of(arena, prev) == Some(p) || assigned_slot(arena, prev) == Some(p) {
            root = arena.root_of(p);
        }
        prev = p;
        if slottable.take().is_some() && closed_root(arena, arena.root_of(p)) {
            slot_in_closed_tree = true;
        }
        if assigned_slot(arena, p).is_some() {
            slottable = Some(p);
        }
        let rel = retarget(arena, related, p);
        if arena.shadow_including_ancestor(current_root, p) {
            // (…still in the current target's tree: its listeners see the running target)
        } else if related != Related::None && rel == Related::Node(p) {
            // (…the relatedTarget has caught up: the rest is ancestry both share, pruned)
            break;
        } else {
            // (…into a lighter tree: the target retargets to this host)
            current = p;
            current_root = arena.root_of(p);
        }
        let at_target = if current == p { STEP_AT_TARGET } else { 0 };
        steps.push(Step { node: p, target: current, related: rel, flags: step_flags(arena, p, root, slot_in_closed_tree) | at_target });
        slot_in_closed_tree = false;
        parent = event_parent(arena, p, composed, target_root);
    }
    steps
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "eventPath", event_path, context_id);
    crate::dom::register(scope, ns, "activationTarget", activation_target_op, context_id);
    crate::dom::register(scope, ns, "retarget", retarget_op, context_id);
    crate::dom::register(scope, ns, "hoverChains", hover_chains_op, context_id);
    crate::dom::register(scope, ns, "composedPath", composed_path_op, context_id);
}

// DOM `composedPath()` (§2.2): of an event path's steps — each whether it is a closed shadow root and whether it is a slot
// in a closed shadow tree — those the listener at step `current` may see, in order: none inside a closed shadow tree
// the current target is outside of.
pub(crate) fn composed_steps(flags: &[(bool, bool)], current: usize) -> Vec<usize> {
    // (…how deep in closed trees the current target is, counted from the path's end)
    let mut level = 0i32;
    for i in (current..flags.len()).rev() {
        let (root_closed, slot_closed) = flags[i];
        if root_closed {
            level += 1;
        }
        if i == current {
            break;
        }
        if slot_closed {
            level -= 1;
        }
    }
    let mut kept = Vec::new();
    let (mut depth, mut max) = (level, level);
    for i in (0..current).rev() {
        let (root_closed, slot_closed) = flags[i];
        if root_closed {
            depth += 1;
        }
        if depth <= max {
            kept.push(i);
        }
        if slot_closed {
            depth -= 1;
            max = max.min(depth);
        }
    }
    kept.reverse();
    kept.push(current);
    let (mut depth, mut max) = (level, level);
    for (i, &(root_closed, slot_closed)) in flags.iter().enumerate().skip(current + 1) {
        if slot_closed {
            depth += 1;
        }
        if depth <= max {
            kept.push(i);
        }
        if root_closed {
            depth -= 1;
            max = max.min(depth);
        }
    }
    kept
}
// __dom.composedPath(flags, current) -> the indices of the steps `composed_steps` keeps: `flags` a step's `STEP_*`
// flags, as `eventPath` answers them, `current` the current target's step.
fn composed_path_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Ok(list) = v8::Local::<v8::Array>::try_from(args.get(0)) else { return };
    let flags: Vec<(bool, bool)> = (0..list.length())
        .map(|i| list.get_index(scope, i).and_then(|v| v.uint32_value(scope)).unwrap_or(0))
        .map(|f| (f & STEP_ROOT_CLOSED as u32 != 0, f & STEP_SLOT_CLOSED as u32 != 0))
        .collect();
    let current = args.get(1).uint32_value(scope).unwrap_or(0) as usize;
    if current >= flags.len() {
        return;
    }
    let kept: Vec<f64> = composed_steps(&flags, current).into_iter().map(|i| i as f64).collect();
    rv.set(crate::dom::f64_array(scope, &kept).into());
}

// __dom.retarget(aNid, bNid) -> DOM "retarget" the node `aNid` against the node `bNid` (null for something else, a
// Window, which no shadow root is an ancestor of): the node, as `nodes_value` answers it.
fn retarget_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(a) = nid_arg(scope, &args, 0) else { return };
    let b = nid_arg(scope, &args, 1);
    let cid = realm_id(scope, &args);
    let arena = crate::dom::realm(scope, cid);
    let found = match b {
        Some(b) => retarget(arena, Related::Node(a), b),
        None => Related::Node(retarget_out(arena, a)),
    };
    let Related::Node(found) = found else { return };
    rv.set(crate::dom::nodes_value(scope, cid, &[found]));
}

// A relatedTarget as `eventPath` answers it: -1 none, -2 the event's own (no node), else its index into the nodes.
fn related_slot(r: Related, index: &mut impl FnMut(NodeId) -> f64) -> f64 {
    match r {
        Related::None => -1.0,
        Related::Other => -2.0,
        Related::Node(r) => index(r),
    }
}

// A click's activation target (DOM dispatch): along the path it is dispatched on — none where it is not dispatched at
// all, nor past where the path is pruned (element_state.rs `activation_target_along`).
fn activation_target(arena: &RealmArena, target: NodeId, related: Related, bubbles: bool, composed: bool) -> Option<NodeId> {
    let steps = path(arena, target, related, composed);
    arena.activation_target_along(steps.iter().map(|s| (s.node, s.flags & STEP_AT_TARGET != 0)), bubbles)
}

// __dom.activationTarget(targetNid, relatedNid, relatedOther, bubbles, composed) -> the activation target of a click at
// the node (its relatedTarget as `eventPath` takes it), as `node_value` answers it — null for none.
fn activation_target_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(target) = nid_arg(scope, &args, 0) else { return rv.set_null() };
    let related = related_arg(scope, &args, 1);
    let (bubbles, composed) = (args.get(3).is_true(), args.get(4).is_true());
    let cid = realm_id(scope, &args);
    let found = activation_target(crate::dom::realm(scope, cid), target, related, bubbles, composed);
    rv.set(crate::dom::node_value(scope, found));
}

// The relatedTarget arguments at `at` and `at + 1`: a node's nid, else whether there is something else (a Window).
fn related_arg(scope: &mut v8::PinScope<'_, '_>, args: &v8::FunctionCallbackArguments<'_>, at: i32) -> Related {
    match nid_arg(scope, args, at) {
        Some(r) => Related::Node(r),
        None if args.get(at + 1).is_true() => Related::Other,
        None => Related::None,
    }
}

// The rest of a dispatch's plan, of a path's nodes `path` (target first): where its bubbling ends — at the first
// ancestor `<form>` for a `submit` or `reset` (`form_stop`), which neither Blink nor Gecko lets one bubble past (no
// spec text says so: dispatch.js) — and whether it goes on to a Window, its top a document.
pub(crate) fn path_plan(arena: &RealmArena, path: impl IntoIterator<Item = NodeId>, form_stop: bool) -> (usize, bool) {
    let (mut len, mut end, mut last) = (0, None, None);
    for id in path {
        if form_stop && len > 0 && end.is_none() && arena.get(id).is_some_and(|n| n.is_html_named("form")) {
            end = Some(len);
        }
        len += 1;
        last = Some(id);
    }
    (end.unwrap_or(len), last.is_some_and(|id| arena.is_document(id)))
}

// __dom.eventPath(targetNid, relatedNid, relatedOther, composed, formStop) -> [nodes, steps, plan]: the event path from
// the target (the relatedTarget a node `relatedNid`, else none, or with `relatedOther` something no retargeting moves).
// `nodes` are the nodes it names, as `nodes_value` answers them; `steps` four numbers a step: its node, the target its
// listeners see, its relatedTarget (an index into `nodes`; -1 none, -2 the event's own), and its `STEP_*` flags. `plan`
// four numbers: `path_plan`'s bubbling end and Window (1 or 0); DOM "clearTargets" (1 or 0) — the last step its own
// target, that target or its relatedTarget in a shadow tree; and the relatedTarget the Window sees, retargeted out of
// every shadow tree (as a step's). Steps empty, where the event is not dispatched.
fn event_path(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(target) = nid_arg(scope, &args, 0) else { return };
    let related = related_arg(scope, &args, 1);
    let composed = args.get(3).is_true();
    let form_stop = args.get(4).is_true();
    let cid = realm_id(scope, &args);
    let arena = crate::dom::realm(scope, cid);
    let steps = path(arena, target, related, composed);
    let in_shadow = |id: NodeId| arena.get(arena.root_of(id)).is_some_and(|n| n.host.is_some());
    let clear_targets = steps.iter().rev().find(|s| s.flags & STEP_AT_TARGET != 0).is_some_and(|s| {
        in_shadow(s.target) || matches!(s.related, Related::Node(r) if in_shadow(r))
    });
    let (end, window) = path_plan(arena, steps.iter().map(|s| s.node), form_stop);
    let window_related = match related {
        Related::Node(r) => Related::Node(retarget_out(arena, r)),
        other => other,
    };
    // (…each node named once)
    let mut nodes: Vec<NodeId> = Vec::new();
    let mut index = |n: NodeId| match nodes.iter().position(|&x| x == n) {
        Some(i) => i as f64,
        None => {
            nodes.push(n);
            (nodes.len() - 1) as f64
        }
    };
    let mut out = Vec::with_capacity(steps.len() * 4);
    for s in &steps {
        out.push(index(s.node));
        out.push(index(s.target));
        out.push(related_slot(s.related, &mut index));
        out.push(s.flags as f64);
    }
    let plan = [end as f64, window as u8 as f64, clear_targets as u8 as f64, related_slot(window_related, &mut index)];
    let nodes_answer = crate::dom::nodes_value(scope, cid, &nodes);
    let steps_answer = crate::dom::f64_array(scope, &out);
    let plan_answer = crate::dom::f64_array(scope, &plan);
    let answer = v8::Array::new_with_elements(scope, &[nodes_answer, steps_answer.into(), plan_answer.into()]);
    rv.set(answer.into());
}

// UI Events' boundary events, as a pointer goes from `from` to `to`: the elements it leaves — `from` and its ancestors,
// innermost first — and those it enters — `to`'s, outermost first — up to the one they share; an element's ancestors
// the flat tree's (a slotted node's next its slot, a shadow tree's top its host), elements alone (no shadow root, which
// Chrome fires none at).
fn hover_chains(arena: &RealmArena, from: Option<NodeId>, to: Option<NodeId>) -> (Vec<NodeId>, Vec<NodeId>) {
    let chain = |start: Option<NodeId>| -> Vec<NodeId> {
        std::iter::successors(start, |&n| crate::geometry::flat_parent(arena, n)).filter(|&n| arena.is_element(n)).collect()
    };
    let (mut leave, mut enter) = (chain(from), chain(to));
    // (…the one they share, and above, in neither)
    while let (Some(a), Some(b)) = (leave.last(), enter.last()) {
        if a != b {
            break;
        }
        leave.pop();
        enter.pop();
    }
    enter.reverse();
    (leave, enter)
}

// __dom.hoverChains(fromNid, toNid) -> [[left…], [entered…]] (`hover_chains`; -1 for no node).
fn hover_chains_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let from = nid_arg(scope, &args, 0);
    let to = nid_arg(scope, &args, 1);
    let cid = realm_id(scope, &args);
    let (leave, enter) = hover_chains(crate::dom::realm(scope, cid), from, to);
    // (…none past a node factory that threw: its exception is what the op ends with)
    let leave = crate::dom::nodes_value(scope, cid, &leave);
    if crate::dom::factory_threw(scope) {
        return;
    }
    let enter = crate::dom::nodes_value(scope, cid, &enter);
    if crate::dom::factory_threw(scope) {
        return;
    }
    rv.set(v8::Array::new_with_elements(scope, &[leave, enter]).into());
}

#[cfg(test)]
mod tests {
    use super::composed_steps;

    // A listener outside a closed shadow tree sees none of it; one inside sees the whole path out.
    #[test]
    fn a_closed_tree_is_hidden_from_outside() {
        // target, closed shadow root, host, document
        let flags = [(false, false), (true, false), (false, false), (false, false)];
        assert_eq!(composed_steps(&flags, 2), vec![2, 3]);
        assert_eq!(composed_steps(&flags, 0), vec![0, 1, 2, 3]);
        assert_eq!(composed_steps(&flags, 3), vec![2, 3]);
        // a slotted target: target, slot in a closed tree, closed root, host, document
        let slotted = [(false, false), (false, true), (true, false), (false, false), (false, false)];
        assert_eq!(composed_steps(&slotted, 0), vec![0, 3, 4]);
        assert_eq!(composed_steps(&slotted, 1), vec![0, 1, 2, 3, 4]);
    }
}
