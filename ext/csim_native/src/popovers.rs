// A document's showing popover lists (HTML §6.12): its showing auto popover list and its showing hint popover list,
// each in the order they were shown — the last the topmost, the hints above the autos — which showing a popover hides
// down to its topmost popover ancestor, hiding one hides those above it, showing a dialog hides, and a light dismiss
// and a close request go to. The bindings show and hide each, firing its events; this answers which.

use crate::dom::{realm, NodeData, NodeId, NodeKind, RealmArena, STATE_POPOVER_OPEN};

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "popoverShown", popover_shown, context_id);
    crate::dom::register(scope, ns, "popoverHidden", popover_hidden, context_id);
    crate::dom::register(scope, ns, "popoverTopmost", popover_topmost, context_id);
    crate::dom::register(scope, ns, "popoverAncestor", popover_ancestor, context_id);
    crate::dom::register(scope, ns, "popoverClicked", popover_clicked, context_id);
    crate::dom::register(scope, ns, "popoverKind", popover_kind_op, context_id);
    crate::dom::register(scope, ns, "closeRequestTarget", close_request_target, context_id);
}

// A `popover` attribute's state, of those the lists hold: auto (an empty value, `auto`) or hint; manual (`manual`, an
// invalid value) and none are neither.
pub(crate) const AUTO: u32 = 1;
pub(crate) const HINT: u32 = 2;
pub(crate) fn popover_kind(n: &NodeData) -> u32 {
    if n.kind != NodeKind::Element {
        return 0;
    }
    match n.plain_attr("popover") {
        Some(v) if v.is_empty() || v.eq_ignore_ascii_case("auto") => AUTO,
        Some(v) if v.eq_ignore_ascii_case("hint") => HINT,
        _ => 0,
    }
}
// …of one showing.
fn showing_kind(n: &NodeData) -> u32 {
    if n.state & STATE_POPOVER_OPEN != 0 { popover_kind(n) } else { 0 }
}

impl RealmArena {
    // A dialog opened or a popover shown now: its close watcher the newest.
    pub(crate) fn note_close_watcher(&mut self, id: NodeId) {
        self.close_watcher_count += 1;
        self.close_watcher_order.insert(id, self.close_watcher_count);
    }
    // The showing popovers of the document `id` is in, the autos then the hints, each with its kind: the entries still
    // showing in the state of their list (a popover leaving its document stops showing as it goes: dialogs.rs
    // `removing_steps`).
    fn popover_lists(&mut self, id: NodeId) -> (NodeId, Vec<(NodeId, u32)>) {
        let doc = self.shadow_including_root(id);
        let mut list = self.showing_popovers.remove(&doc).unwrap_or_default();
        list.retain(|&(p, kind)| self.get(p).is_some_and(|n| showing_kind(n) == kind));
        // (…the hints above the autos, whatever the order they were shown in)
        list.sort_by_key(|&(_, kind)| kind == HINT);
        (doc, list)
    }
    fn keep_popover_lists(&mut self, doc: NodeId, list: Vec<(NodeId, u32)>) {
        if !list.is_empty() {
            self.showing_popovers.insert(doc, list);
        }
    }
    // HTML "nearest inclusive open popover": `id` or its nearest flat tree ancestor that is a showing auto or hint
    // popover.
    fn nearest_open_popover(&self, id: NodeId) -> Option<NodeId> {
        let mut at = Some(id);
        while let Some(n) = at {
            if self.get(n).is_some_and(|d| showing_kind(d) != 0) {
                return Some(n);
            }
            at = crate::geometry::flat_parent(self, n);
        }
        None
    }
    // HTML "nearest inclusive target popover for invoker": `id` or its nearest flat tree ancestor that is an invoker of a
    // showing auto or hint popover — that popover.
    fn nearest_target_popover(&self, id: NodeId) -> Option<NodeId> {
        let mut at = Some(id);
        while let Some(n) = at {
            let target = crate::activation::invoked_popover(self, n).filter(|&p| self.get(p).is_some_and(|d| showing_kind(d) != 0));
            if target.is_some() {
                return target;
            }
            at = crate::geometry::flat_parent(self, n);
        }
        None
    }
}

// The element of a node argument, and its realm.
fn element(scope: &mut v8::PinScope<'_, '_>, value: v8::Local<'_, v8::Value>) -> Option<(NodeId, i32)> {
    let id = crate::node_handle::nid_of(scope, value)?;
    let cid = crate::dom::dom(scope).arena.get(id)?.realm;
    Some((id, cid))
}

// __dom.popoverKind(element) -> its `popover` attribute's state among those the lists hold: 1 auto, 2 hint, 0 neither.
fn popover_kind_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let kind = crate::node_handle::nid_of(scope, args.get(0)).and_then(|id| crate::dom::dom(scope).arena.get(id).map(popover_kind)).unwrap_or(0);
    rv.set_uint32(kind);
}

// __dom.popoverShown(popover) — an auto or hint popover now showing: the last of its document's list.
fn popover_shown(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some((id, cid)) = element(scope, args.get(0)) else { return };
    let arena = realm(scope, cid);
    let (doc, mut list) = arena.popover_lists(id);
    list.retain(|&(p, _)| p != id);
    let kind = arena.get(id).map_or(0, popover_kind);
    if kind != 0 {
        list.push((id, kind));
        arena.note_close_watcher(id);
    }
    arena.keep_popover_lists(doc, list);
}

// __dom.popoverHidden(popover) — a popover hidden: out of its document's lists.
fn popover_hidden(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some((id, cid)) = element(scope, args.get(0)) else { return };
    let arena = realm(scope, cid);
    arena.showing_popovers.values_mut().for_each(|list| list.retain(|&(p, _)| p != id));
    arena.showing_popovers.retain(|_, list| !list.is_empty());
}

// __dom.popoverTopmost(node, kind) -> the topmost showing popover of the node's document's `kind` list (1 auto, 2
// hint), or — 0 — of either, a hint above every auto; null for none.
fn popover_topmost(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some((id, cid)) = element(scope, args.get(0)) else { return rv.set_null() };
    let kind = args.get(1).uint32_value(scope).unwrap_or(0);
    let arena = realm(scope, cid);
    let (doc, list) = arena.popover_lists(id);
    let top = list.iter().rev().find(|&&(_, k)| kind == 0 || k == kind).map(|&(p, _)| p);
    arena.keep_popover_lists(doc, list);
    rv.set(crate::dom::node_value(scope, top));
}

// __dom.popoverAncestor(element, invoker, kind) -> HTML "topmost popover ancestor" of a popover about to show, or of a
// dialog, in its document's `kind` list (1 auto, 2 hint): of the showing popovers of that list below where it would go,
// the higher of its nearest showing flat tree ancestor and its invoker's (null for none) — the one showing it hides the
// list down to.
fn popover_ancestor(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some((id, cid)) = element(scope, args.get(0)) else { return rv.set_null() };
    let invoker = crate::node_handle::nid_of(scope, args.get(1));
    let kind = args.get(2).uint32_value(scope).unwrap_or(AUTO);
    let arena = realm(scope, cid);
    let (doc, list) = arena.popover_lists(id);
    let position = |p: NodeId| list.iter().filter(|&&(_, k)| k == kind).position(|&(q, _)| q == p);
    let mut topmost: Option<NodeId> = None;
    for candidate in [crate::geometry::flat_parent(arena, id), invoker].into_iter().flatten() {
        let Some(ancestor) = arena.nearest_open_popover(candidate).filter(|&a| a != id) else { continue };
        let Some(at) = position(ancestor) else { continue };
        if topmost.and_then(position).is_none_or(|t| t < at) {
            topmost = Some(ancestor);
        }
    }
    arena.keep_popover_lists(doc, list);
    rv.set(crate::dom::node_value(scope, topmost));
}

// __dom.popoverClicked(node) -> HTML "topmost clicked popover" for a press on `node`: of its nearest inclusive open
// popover and the popover its nearest invoker shows, the one higher in the lists (null for none) — the one a light
// dismiss hides them down to.
fn popover_clicked(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = crate::node_handle::nid_of(scope, args.get(0)) else { return rv.set_null() };
    let Some(cid) = crate::dom::dom(scope).arena.get(id).map(|n| n.realm) else { return rv.set_null() };
    let arena = realm(scope, cid);
    let (doc, list) = arena.popover_lists(id);
    let position = |p: Option<NodeId>| p.and_then(|p| list.iter().position(|&(q, _)| q == p));
    let (clicked, target) = (arena.nearest_open_popover(id), arena.nearest_target_popover(id));
    let top = if position(clicked) > position(target) { clicked } else { target.or(clicked) };
    arena.keep_popover_lists(doc, list);
    rv.set(crate::dom::node_value(scope, top));
}

// __dom.closeRequestTarget(document) -> which a close request (the Escape key) goes to first: 1 the topmost showing
// popover, 2 the open dialogs, 0 neither — of the two the one whose close watcher is the newer (HTML "close watcher
// manager": one stack for both).
fn close_request_target(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some((doc, cid)) = element(scope, args.get(0)) else { return rv.set_int32(0) };
    let arena = realm(scope, cid);
    let (root, list) = arena.popover_lists(doc);
    let popover = list.last().map(|&(p, _)| p);
    arena.keep_popover_lists(root, list);
    let dialog = arena.topmost_dialog(root);
    let order = |id: Option<NodeId>| id.and_then(|i| arena.close_watcher_order.get(&i).copied());
    rv.set_int32(match (popover, dialog) {
        (None, None) => 0,
        (Some(_), None) => 1,
        (None, Some(_)) => 2,
        (p, d) => if order(p) > order(d) { 1 } else { 2 },
    });
}
