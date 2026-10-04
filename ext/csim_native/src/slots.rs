// Slot assignment (HTML "assign slottables for a tree", DOM §4.2.2.3-4): which of a shadow host's children each `<slot>`
// of its shadow tree is assigned, kept on the slots and the slotted nodes (`assigned` / `assigned_slot`), which the style
// engine's flat tree, the layout walk, focus navigation and the event path all read. Run over a shadow tree each time
// something it depends on changes — the host's children, a `slot` or `name` attribute, a slot entering or leaving the
// tree, a manual `assign()` (dom-nodes.js's mutation hooks ask) — so what is stored is always what "find slottables"
// would compute.
//
// A shadow root in MANUAL mode assigns each slot its `assign()`ed nodes that are the host's children, in assignment
// order; the lists are the slots' (`manual_assigned`, which dom-nodes.js writes from the nodes a script handed over).

use crate::dom::{NodeId, NodeKind, RealmArena};

// Whether a node is a slottable: an element or a text node.
fn slottable(arena: &RealmArena, id: NodeId) -> bool {
    arena.get(id).is_some_and(|n| matches!(n.kind, NodeKind::Element | NodeKind::Text))
}
// A slottable's name: an element's `slot` attribute, and none (the default slot's) for a text node.
fn slottable_name(arena: &RealmArena, id: NodeId) -> &str {
    arena.get(id).and_then(|n| n.get_attr("slot")).unwrap_or("")
}
// A slot's name.
fn slot_name(arena: &RealmArena, id: NodeId) -> &str {
    arena.get(id).and_then(|n| n.get_attr("name")).unwrap_or("")
}
fn is_slot(arena: &RealmArena, id: NodeId) -> bool {
    arena.get(id).is_some_and(|n| n.is_html_named("slot"))
}

// The shadow root `id` is in (or is), if any.
pub(crate) fn enclosing_shadow_root(arena: &RealmArena, id: NodeId) -> Option<NodeId> {
    let mut cur = id;
    loop {
        let n = arena.get(cur)?;
        if n.host.is_some() {
            return Some(cur);
        }
        cur = n.parent?;
    }
}

// The `<slot>`s of a shadow tree, in tree order (not those of a shadow tree within it, nor of a template's contents).
fn slots_of(arena: &RealmArena, root: NodeId) -> Vec<NodeId> {
    let mut out = Vec::new();
    let mut stack: Vec<NodeId> = arena.get(root).map_or(Vec::new(), |n| n.children.iter().rev().copied().collect());
    while let Some(id) = stack.pop() {
        let Some(n) = arena.get(id) else { continue };
        if n.is_html_named("slot") {
            out.push(id);
        }
        stack.extend(n.children.iter().rev());
    }
    out
}

// What each slot of the shadow tree `root` is to be assigned, in tree order of the slots.
fn assignments(arena: &RealmArena, root: NodeId) -> Vec<(NodeId, Vec<NodeId>)> {
    let Some(r) = arena.get(root) else { return Vec::new() };
    let Some(host) = r.host else { return Vec::new() };
    let slots = slots_of(arena, root);
    let kids: &[NodeId] = arena.get(host).map_or(&[], |h| &h.children);
    if r.manual_slot_assignment {
        return slots
            .into_iter()
            .map(|s| {
                let list = arena.get(s).map_or(&[][..], |n| &n.manual_assigned[..]);
                (s, list.iter().copied().filter(|&n| arena.parent_of(n) == Some(host) && slottable(arena, n)).collect())
            })
            .collect();
    }
    // (…a name's slot is the first in tree order that has it)
    let mut by_name: Vec<(&str, usize)> = Vec::new();
    for (i, &s) in slots.iter().enumerate() {
        let name = slot_name(arena, s);
        if !by_name.iter().any(|&(n, _)| n == name) {
            by_name.push((name, i));
        }
    }
    let mut out: Vec<(NodeId, Vec<NodeId>)> = slots.iter().map(|&s| (s, Vec::new())).collect();
    for &c in kids {
        if !slottable(arena, c) {
            continue;
        }
        let name = slottable_name(arena, c);
        if let Some(&(_, i)) = by_name.iter().find(|&&(n, _)| n == name) {
            out[i].1.push(c);
        }
    }
    out
}

// A slot whose assigned nodes changed, and the nodes that left it (which leave the flat tree, or move to another slot,
// with nothing above them that the change marks).
pub(crate) struct Changed {
    pub(crate) slot: NodeId,
    pub(crate) left: Vec<NodeId>,
}

// Assign the slots of the shadow tree `root` — and `extra`, slots that have left it (or any other), which are assigned
// whatever their own tree gives them now: nothing, outside a shadow tree. The slots whose assigned nodes changed, in
// that order (each one's `slotchange`).
pub(crate) fn assign(arena: &mut RealmArena, root: Option<NodeId>, extra: &[NodeId], mut on_change: impl FnMut(&RealmArena, NodeId, &[NodeId], &[NodeId])) -> Vec<Changed> {
    let mut plan = root.map_or(Vec::new(), |r| assignments(arena, r));
    for &s in extra {
        if plan.iter().any(|&(p, _)| p == s) || !is_slot(arena, s) {
            continue;
        }
        let nodes = match enclosing_shadow_root(arena, s) {
            Some(r) => assignments(arena, r).into_iter().find(|&(p, _)| p == s).map_or(Vec::new(), |(_, n)| n),
            None => Vec::new(),
        };
        plan.push((s, nodes));
    }
    let mut changed = Vec::new();
    for (slot, nodes) in plan {
        if arena.get(slot).is_some_and(|s| s.assigned == nodes) {
            continue;
        }
        let old = arena.set_assigned_nodes(slot, nodes);
        let now = arena.get(slot).map_or(Vec::new(), |s| s.assigned.clone());
        on_change(arena, slot, &old, &now);
        let left = old.into_iter().filter(|n| !now.contains(n)).collect();
        changed.push(Changed { slot, left });
    }
    changed
}

// "Find flattened slottables" (DOM §4.2.2.3): a slot's assigned nodes — its own slottable children where it has none —
// with every slot among them that is in a shadow tree replaced by its own flattened slottables.
pub(crate) fn flattened(arena: &RealmArena, slot: NodeId, out: &mut Vec<NodeId>) {
    if enclosing_shadow_root(arena, slot).is_none() {
        return;
    }
    let Some(s) = arena.get(slot) else { return };
    let own: Vec<NodeId> = if s.assigned.is_empty() {
        s.children.iter().copied().filter(|&c| slottable(arena, c)).collect()
    } else {
        s.assigned.clone()
    };
    for n in own {
        if is_slot(arena, n) && enclosing_shadow_root(arena, n).is_some() {
            flattened(arena, n, out);
        } else {
            out.push(n);
        }
    }
}
