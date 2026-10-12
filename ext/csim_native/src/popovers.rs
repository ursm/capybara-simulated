// A document's showing auto popover list (HTML §6.12): the popovers in the auto state (and the hint one, which this
// model keeps with them) that show, in the order they were shown — the last the topmost — which showing an auto popover
// hides down to its topmost popover ancestor, hiding one hides those above it, showing a modal dialog hides all of, and
// a light dismiss and a close request go to. The bindings show and hide each, firing its events; this answers which.

use crate::dom::{realm, NodeData, NodeId, NodeKind, RealmArena, STATE_POPOVER_OPEN};

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "popoverShown", popover_shown, context_id);
    crate::dom::register(scope, ns, "popoverHidden", popover_hidden, context_id);
    crate::dom::register(scope, ns, "popoverTopmost", popover_topmost, context_id);
    crate::dom::register(scope, ns, "popoverAncestor", popover_ancestor, context_id);
    crate::dom::register(scope, ns, "popoverClicked", popover_clicked, context_id);
    crate::dom::register(scope, ns, "popoverAuto", popover_auto, context_id);
    crate::dom::register(scope, ns, "closeRequestTarget", close_request_target, context_id);
}

// Whether `n`'s `popover` attribute is in the auto state (an empty value, `auto`) or the hint state — a popover the
// showing list holds; an invalid value is the manual state.
pub(crate) fn auto_popover(n: &NodeData) -> bool {
    n.kind == NodeKind::Element
        && n.plain_attr("popover").is_some_and(|v| v.is_empty() || v.eq_ignore_ascii_case("auto") || v.eq_ignore_ascii_case("hint"))
}

impl RealmArena {
    // A dialog opened or a popover shown now: its close watcher the newest.
    pub(crate) fn note_close_watcher(&mut self, id: NodeId) {
        self.close_watcher_count += 1;
        self.close_watcher_order.insert(id, self.close_watcher_count);
    }
    // The showing auto popover list of the document `id` is in: its entries still auto popovers showing, connected in it.
    fn popover_list(&mut self, id: NodeId) -> (NodeId, Vec<NodeId>) {
        let doc = self.shadow_including_root(id);
        let mut list = self.showing_popovers.remove(&doc).unwrap_or_default();
        list.retain(|&p| {
            self.get(p).is_some_and(|n| auto_popover(n) && n.state & STATE_POPOVER_OPEN != 0) && self.is_connected(p) && self.shadow_including_root(p) == doc
        });
        (doc, list)
    }
    fn keep_popover_list(&mut self, doc: NodeId, list: Vec<NodeId>) {
        if !list.is_empty() {
            self.showing_popovers.insert(doc, list);
        }
    }
    // HTML "nearest inclusive open popover": `id` or its nearest flat tree ancestor that is a showing auto popover.
    fn nearest_open_popover(&self, id: NodeId) -> Option<NodeId> {
        let mut at = Some(id);
        while let Some(n) = at {
            if self.get(n).is_some_and(|d| auto_popover(d) && d.state & STATE_POPOVER_OPEN != 0) {
                return Some(n);
            }
            at = crate::geometry::flat_parent(self, n);
        }
        None
    }
    // HTML "nearest inclusive target popover for invoker": `id` or its nearest flat tree ancestor that is an invoker whose
    // `popovertarget` is a showing auto popover — that popover.
    fn nearest_target_popover(&self, id: NodeId) -> Option<NodeId> {
        let mut at = Some(id);
        while let Some(n) = at {
            let target = self.referenced_element(n, "popovertarget").filter(|&p| self.get(p).is_some_and(|d| auto_popover(d) && d.state & STATE_POPOVER_OPEN != 0));
            if target.is_some() {
                return target;
            }
            at = crate::geometry::flat_parent(self, n);
        }
        None
    }
}

// The element of a node argument, with the list of its document and the positions in it.
fn element(scope: &mut v8::PinScope<'_, '_>, value: v8::Local<'_, v8::Value>) -> Option<(NodeId, i32)> {
    let id = crate::node_handle::nid_of(scope, value)?;
    let cid = crate::dom::dom(scope).arena.get(id)?.realm;
    Some((id, cid))
}

// __dom.popoverAuto(element) -> whether its `popover` attribute is in the auto (or hint) state.
fn popover_auto(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let auto = crate::node_handle::nid_of(scope, args.get(0)).is_some_and(|id| crate::dom::dom(scope).arena.get(id).is_some_and(auto_popover));
    rv.set_bool(auto);
}

// __dom.popoverShown(popover) — an auto popover now showing: the last of its document's list.
fn popover_shown(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some((id, cid)) = element(scope, args.get(0)) else { return };
    let arena = realm(scope, cid);
    let (doc, mut list) = arena.popover_list(id);
    list.retain(|&p| p != id);
    if arena.get(id).is_some_and(auto_popover) {
        list.push(id);
        arena.note_close_watcher(id);
    }
    arena.keep_popover_list(doc, list);
}

// __dom.popoverHidden(popover) — a popover hidden: out of its document's list.
fn popover_hidden(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some((id, cid)) = element(scope, args.get(0)) else { return };
    let arena = realm(scope, cid);
    arena.showing_popovers.values_mut().for_each(|list| list.retain(|&p| p != id));
    arena.showing_popovers.retain(|_, list| !list.is_empty());
}

// __dom.popoverTopmost(node) -> the topmost showing auto popover of the node's document, null for none.
fn popover_topmost(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some((id, cid)) = element(scope, args.get(0)) else { return rv.set_null() };
    let arena = realm(scope, cid);
    let (doc, list) = arena.popover_list(id);
    let top = list.last().copied();
    arena.keep_popover_list(doc, list);
    rv.set(crate::dom::node_value(scope, top));
}

// __dom.closeRequestTarget(document) -> which a close request (the Escape key) goes to first: 1 the topmost showing auto
// popover, 2 the open dialogs, 0 neither — of the two the one whose close watcher is the newer (HTML "close watcher
// manager": one stack for both).
fn close_request_target(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some((doc, cid)) = element(scope, args.get(0)) else { return rv.set_int32(0) };
    let arena = realm(scope, cid);
    let (root, list) = arena.popover_list(doc);
    let popover = list.last().copied();
    arena.keep_popover_list(root, list);
    let dialog = arena.topmost_dialog(root);
    let order = |id: Option<NodeId>| id.and_then(|i| arena.close_watcher_order.get(&i).copied());
    rv.set_int32(match (popover, dialog) {
        (None, None) => 0,
        (Some(_), None) => 1,
        (None, Some(_)) => 2,
        (p, d) => if order(p) > order(d) { 1 } else { 2 },
    });
}

// __dom.popoverAncestor(popover, invoker) -> HTML "topmost popover ancestor" of a popover about to show — of the showing
// popovers below where it would go, the last that is its nearest inclusive open flat tree ancestor's, or its invoker's
// (null for none): the one showing it hides the list down to.
fn popover_ancestor(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some((id, cid)) = element(scope, args.get(0)) else { return rv.set_null() };
    let invoker = crate::node_handle::nid_of(scope, args.get(1));
    let arena = realm(scope, cid);
    let (doc, list) = arena.popover_list(id);
    let position = |p: NodeId| list.iter().position(|&q| q == p);
    let mut topmost: Option<NodeId> = None;
    let candidates = [crate::geometry::flat_parent(arena, id), invoker];
    for candidate in candidates.into_iter().flatten() {
        let Some(ancestor) = arena.nearest_open_popover(candidate).filter(|&a| a != id) else { continue };
        let Some(at) = position(ancestor) else { continue };
        if topmost.and_then(position).is_none_or(|t| t < at) {
            topmost = Some(ancestor);
        }
    }
    arena.keep_popover_list(doc, list);
    rv.set(crate::dom::node_value(scope, topmost));
}

// __dom.popoverClicked(node) -> HTML "topmost clicked popover" for a press on `node`: of its nearest inclusive open
// popover and the popover its nearest invoker shows, the one higher in the list (null for none) — the one a light
// dismiss hides the list down to.
fn popover_clicked(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = crate::node_handle::nid_of(scope, args.get(0)) else { return rv.set_null() };
    let Some(cid) = crate::dom::dom(scope).arena.get(id).map(|n| n.realm) else { return rv.set_null() };
    let arena = realm(scope, cid);
    let (doc, list) = arena.popover_list(id);
    let position = |p: Option<NodeId>| p.and_then(|p| list.iter().position(|&q| q == p));
    let (clicked, target) = (arena.nearest_open_popover(id), arena.nearest_target_popover(id));
    let top = if position(clicked) > position(target) { clicked } else { target.or(clicked) };
    arena.keep_popover_list(doc, list);
    rv.set(crate::dom::node_value(scope, top));
}
