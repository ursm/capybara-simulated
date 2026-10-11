// A document's open dialogs list (HTML §4.11.4), in the order they opened — a dialog's `open` attribute set (by
// show(), showModal(), a script's, a parser's or a clone's) adds it, closing it and its removing steps take it out — of
// which the close requests and light dismiss go to the last connected one; and the removing steps of the elements whose
// state a removal changes: a showing popover hides and a dialog is modal no more, quietly, and a dialog leaves its open
// dialogs list.

use crate::dom::{nid_arg, node_value, nodes_value, realm, realm_id, NodeId, NodeKind, RealmArena, STATE_FOCUSED, STATE_HOVERED, STATE_MODAL, STATE_POPOVER_OPEN};

// A document's open dialogs list: each dialog with the close watcher group its close watcher is in (HTML "close watcher
// manager": a new group where a user activation has come since the last one was made, else the last group — so a page's
// dialogs shown with no user in between are one group, which one close request goes through), and the user activations
// the window had had as its last group was made.
#[derive(Default)]
pub(crate) struct OpenDialogs {
    pub(crate) dialogs: Vec<(NodeId, u32)>,
    activations: u32,
}

impl RealmArena {
    // The open dialogs list of document `doc`, `dialog` its last — its close watcher in a group of its own where the window
    // has had a user activation since the last group was made (`activations` the window's count of them), else in the last.
    fn dialog_opened(&mut self, doc: NodeId, dialog: NodeId, activations: u32) {
        let list = self.open_dialogs.entry(doc).or_default();
        list.dialogs.retain(|&(d, _)| d != dialog);
        let last = list.dialogs.last().map(|&(_, g)| g);
        let group = match last {
            Some(g) if activations <= list.activations => g,
            Some(g) => g + 1,
            None => 0,
        };
        list.activations = activations;
        list.dialogs.push((dialog, group));
    }
    // …`dialog` taken out of whichever list has it.
    fn dialog_closed(&mut self, dialog: NodeId) {
        for list in self.open_dialogs.values_mut() {
            list.dialogs.retain(|&(d, _)| d != dialog);
        }
        self.open_dialogs.retain(|_, list| !list.dialogs.is_empty());
    }
    // Whether `dialog`, of document `doc`'s list, is one that list goes to: connected in its tree (a shadow tree's in it
    // too) — false too for one gone, or connected in another document's (one that moved there), which the list drops.
    fn dialog_of(&self, doc: NodeId, dialog: NodeId) -> Option<bool> {
        if self.get(dialog).is_none() {
            return None;
        }
        if !self.is_connected(dialog) {
            return Some(false);
        }
        (self.shadow_including_root(dialog) == doc).then_some(true)
    }
    // The dialogs of the last close watcher group of document `doc`'s list that are connected in it, the last first: those
    // a close request goes through (HTML "process close watchers"), the entries gone or moved dropped as they are met.
    fn close_watcher_group(&mut self, doc: NodeId) -> Vec<NodeId> {
        let Some(mut list) = self.open_dialogs.remove(&doc) else { return Vec::new() };
        list.dialogs.retain(|&(d, _)| self.dialog_of(doc, d).is_some());
        let mut out = Vec::new();
        if let Some(&(_, last)) = list.dialogs.iter().rev().find(|&&(d, _)| self.dialog_of(doc, d) == Some(true)) {
            out = list.dialogs.iter().rev().filter(|&&(d, g)| g == last && self.dialog_of(doc, d) == Some(true)).map(|&(d, _)| d).collect();
        }
        if !list.dialogs.is_empty() {
            self.open_dialogs.insert(doc, list);
        }
        out
    }
    // The last of document `doc`'s open dialogs that is connected in it, an entry gone or moved dropped as it is met; one
    // not connected stays, for when it comes back.
    fn topmost_dialog(&mut self, doc: NodeId) -> Option<NodeId> {
        let mut list = self.open_dialogs.remove(&doc)?;
        list.dialogs.retain(|&(d, _)| self.dialog_of(doc, d).is_some());
        let found = list.dialogs.iter().rev().map(|&(d, _)| d).find(|&d| self.dialog_of(doc, d) == Some(true));
        if !list.dialogs.is_empty() {
            self.open_dialogs.insert(doc, list);
        }
        found
    }
    // The removing steps (HTML §4.11.4, §6.12, §6.6.4) of `root`'s shadow-including inclusive descendants a removal takes
    // out of a document: a showing popover hidden, a dialog modal no more and out of its open dialogs list — all quietly,
    // with no toggle — and the document's focused and hovered element, where it left, neither any more: its focus is the
    // viewport's (the "focus fixup rule": no event, as Firefox and WebKit — Chrome's `blur` on a removal is a Blink
    // behavior its own intent is retiring) and what a focused text control armed for its blur is gone (change_on_blur.rs).
    // Whether they changed an element's state.
    fn removing_steps(&mut self, root: NodeId) -> bool {
        const LEAVING: u32 = STATE_POPOVER_OPEN | STATE_MODAL | STATE_FOCUSED | STATE_HOVERED;
        let mut stack = vec![root];
        let (mut leave, mut dialogs) = (Vec::new(), Vec::new());
        while let Some(id) = stack.pop() {
            let Some(n) = self.get(id) else { continue };
            if n.kind == NodeKind::Element {
                if n.state & LEAVING != 0 {
                    leave.push((id, n.state & !LEAVING));
                }
                if n.is_html_named("dialog") {
                    dialogs.push(id);
                }
            }
            stack.extend(n.children.iter().copied());
            stack.extend(n.shadow_root);
        }
        for dialog in dialogs {
            self.dialog_closed(dialog);
        }
        let changed = !leave.is_empty();
        for (id, bits) in leave {
            self.change_baselines.remove(&id);
            self.set_state(id, bits);
        }
        changed
    }
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "dialogOpened", dialog_opened, context_id);
    crate::dom::register(scope, ns, "dialogClosed", dialog_closed, context_id);
    crate::dom::register(scope, ns, "topmostDialog", topmost_dialog, context_id);
    crate::dom::register(scope, ns, "closeWatcherGroup", close_watcher_group, context_id);
    crate::dom::register(scope, ns, "removingSteps", removing_steps, context_id);
}

// __dom.dialogOpened(docNid, dialogNid, activations) — the dialog the last of the document's open dialogs (`activations`
// the window's count of user activations, which its close watcher's group follows).
fn dialog_opened(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let (Some(doc), Some(dialog)) = (nid_arg(scope, &args, 0), nid_arg(scope, &args, 1)) else { return };
    let activations = args.get(2).uint32_value(scope).unwrap_or(0);
    let cid = realm_id(scope, &args);
    realm(scope, cid).dialog_opened(doc, dialog, activations);
}
// __dom.closeWatcherGroup(docNid) -> the dialogs a close request goes through (`close_watcher_group`), as `nodes_value`
// answers.
fn close_watcher_group(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(doc) = nid_arg(scope, &args, 0) else { return };
    let cid = realm_id(scope, &args);
    let ids = realm(scope, cid).close_watcher_group(doc);
    rv.set(nodes_value(scope, cid, &ids));
}
// __dom.dialogClosed(dialogNid) — the dialog out of its open dialogs list.
fn dialog_closed(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(dialog) = nid_arg(scope, &args, 0) else { return };
    let cid = realm_id(scope, &args);
    realm(scope, cid).dialog_closed(dialog);
}
// __dom.topmostDialog(docNid) -> the last connected one of the document's open dialogs (`topmost_dialog`), or null.
fn topmost_dialog(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(doc) = nid_arg(scope, &args, 0) else { return rv.set_null() };
    let cid = realm_id(scope, &args);
    let found = realm(scope, cid).topmost_dialog(doc);
    rv.set(node_value(scope, found));
}
// __dom.removingSteps(rootNid) -> whether the removing steps of the subtree changed an element's state
// (`removing_steps`).
fn removing_steps(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(root) = nid_arg(scope, &args, 0) else { return rv.set_bool(false) };
    // (…in the realm whose tree it left, whose document's modal stack its dialogs leave, whichever realm's code removed it)
    let caller = realm_id(scope, &args);
    let cid = crate::dom::dom(scope).arena.get(root).map_or(caller, |n| n.realm);
    rv.set_bool(realm(scope, cid).removing_steps(root));
}
