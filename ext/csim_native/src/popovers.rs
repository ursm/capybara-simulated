// A document's showing popover lists (HTML §6.12): its showing auto popover list and its showing hint popover list,
// each in the order they were shown — the last the topmost, the hints above the autos — which showing a popover hides
// down to its topmost popover ancestor, hiding one hides those above it, showing a dialog hides, and a light dismiss
// and a close request go to. The bindings show and hide each, firing its events; this answers which.

use crate::dom::{realm, NodeData, NodeId, RealmArena, STATE_POPOVER_OPEN};

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "popoverShown", popover_shown, context_id);
    crate::dom::register(scope, ns, "popoverHidden", popover_hidden, context_id);
    crate::dom::register(scope, ns, "popoverTopmost", popover_topmost, context_id);
    crate::dom::register(scope, ns, "popoverAncestor", popover_ancestor, context_id);
    crate::dom::register(scope, ns, "popoverClicked", popover_clicked, context_id);
    crate::dom::register(scope, ns, "popoverKind", popover_kind_op, context_id);
    crate::dom::register(scope, ns, "closeRequestTarget", close_request_target, context_id);
    crate::dom::register(scope, ns, "popoverCheck", popover_check, context_id);
    crate::dom::register(scope, ns, "popoverChanging", popover_changing, context_id);
    crate::dom::register(scope, ns, "setPopoverChanging", set_popover_changing, context_id);
    crate::dom::register(scope, ns, "lightDismissPress", light_dismiss_press, context_id);
}

// A `popover` attribute's state, of its value (none: no attribute): none, auto (empty, `auto`), hint, or manual (any other
// value, `manual` an invalid one too) — ASCII case-insensitively.
pub(crate) const NONE: u32 = 0;
pub(crate) const AUTO: u32 = 1;
pub(crate) const HINT: u32 = 2;
pub(crate) const MANUAL: u32 = 3;
pub(crate) fn popover_state(value: Option<&str>) -> u32 {
    match value {
        None => NONE,
        Some(v) if v.is_empty() || v.eq_ignore_ascii_case("auto") => AUTO,
        Some(v) if v.eq_ignore_ascii_case("hint") => HINT,
        Some(_) => MANUAL,
    }
}
// …whether an element is a popover: an HTML one whose `popover` is in any state but none (the attribute an HTML
// element's: none of an SVG or MathML one makes it a popover).
pub(crate) fn is_popover(n: &NodeData) -> bool {
    n.is_html() && n.plain_attr("popover").is_some()
}
// …an element's, of those the lists hold — auto or hint; manual and none are neither (`NONE`).
pub(crate) fn popover_kind(n: &NodeData) -> u32 {
    if !n.is_html() {
        return NONE;
    }
    match popover_state(n.plain_attr("popover")) {
        kind @ (AUTO | HINT) => kind,
        _ => NONE,
    }
}
// …of one showing.
fn showing_kind(n: &NodeData) -> u32 {
    if n.state & STATE_POPOVER_OPEN != 0 { popover_kind(n) } else { NONE }
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

// HTML "check popover validity" for an element about to be shown (`expected` false: it should be hidden) or hidden: valid
// (`VALID`); not, its showing already as asked (`AS_ASKED`); or not, a NotSupportedError — it has no `popover` attribute
// (`NOT_A_POPOVER`) — or an InvalidStateError — it is not connected, or is a modal `<dialog>` (`INVALID_STATE`).
const VALID: u32 = 0;
const AS_ASKED: u32 = 1;
const NOT_A_POPOVER: u32 = 2;
const INVALID_STATE: u32 = 3;

// __dom.popoverCheck(element, expectedShowing) -> what "check popover validity" says of it (`VALID` …).
fn popover_check(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some((id, _)) = element(scope, args.get(0)) else { return rv.set_uint32(NOT_A_POPOVER) };
    let expected = args.get(1).is_true();
    let arena = &crate::dom::dom(scope).arena;
    let Some(n) = arena.get(id) else { return rv.set_uint32(NOT_A_POPOVER) };
    rv.set_uint32(if !is_popover(n) {
        NOT_A_POPOVER
    } else if (n.state & STATE_POPOVER_OPEN != 0) != expected {
        AS_ASKED
    } else if !arena.is_connected(id) || (n.is_html_named("dialog") && n.state & crate::dom::STATE_MODAL != 0) {
        INVALID_STATE
    } else {
        VALID
    });
}

// __dom.popoverChanging(element) -> whether the popover is in the middle of being shown or hidden (HTML's "popover
// showing or hiding" flag): a show or a hide of it begun from inside its own — a listener's — is nested.
fn popover_changing(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some((id, cid)) = element(scope, args.get(0)) else { return rv.set_bool(false) };
    rv.set_bool(realm(scope, cid).popovers_changing.contains(&id));
}
// __dom.setPopoverChanging(element, on) — its flag set (a show or a hide begins) or cleared (it ends).
fn set_popover_changing(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some((id, cid)) = element(scope, args.get(0)) else { return };
    let changing = &mut realm(scope, cid).popovers_changing;
    if args.get(1).is_true() {
        changing.insert(id);
    } else {
        changing.remove(&id);
    }
}

// __dom.lightDismissPress(document, kind, clicked, down) -> for a user's `pointerdown` (`down`), the document's popover
// (kind 0) or dialog (1) pointerdown target set to what it clicked — the topmost clicked popover, the nearest clicked
// dialog, or none (null) — and false; for its `pointerup`, whether it clicked the same as the target is, which is null
// again after (HTML "light dismiss open popovers" / "light dismiss open dialogs": a target null at first, and after
// every release — a release with no press recorded before it, outside every popover, the same as null; Chrome).
fn light_dismiss_press(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some((doc, cid)) = element(scope, args.get(0)) else { return rv.set_bool(false) };
    let kind = (args.get(1).uint32_value(scope).unwrap_or(0) as usize).min(1);
    let clicked = crate::node_handle::nid_of(scope, args.get(2));
    let down = args.get(3).is_true();
    let targets = realm(scope, cid).pointerdown_targets.entry(doc).or_default();
    if down {
        targets[kind] = clicked;
        return rv.set_bool(false);
    }
    rv.set_bool(targets[kind].take() == clicked);
}
