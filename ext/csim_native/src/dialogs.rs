// A document's open dialogs list (HTML §4.11.4), in the order they opened — a dialog's `open` attribute set (by
// show(), showModal(), a script's, a parser's or a clone's) adds it, closing it and its removing steps take it out — of
// which the close requests and light dismiss go to the last connected one; and the removing steps of the elements whose
// state a removal changes: a showing popover hides and a dialog is modal no more, quietly, and a dialog leaves its open
// dialogs list.

use crate::dom::{nid_arg, node_value, realm, realm_id, NodeId, NodeKind, RealmArena, STATE_FOCUSED, STATE_HOVERED, STATE_MODAL, STATE_POPOVER_OPEN};

impl RealmArena {
    // The open dialogs list of document `doc`, `dialog` its last.
    fn dialog_opened(&mut self, doc: NodeId, dialog: NodeId) {
        let list = self.open_dialogs.entry(doc).or_default();
        list.retain(|&d| d != dialog);
        list.push(dialog);
    }
    // …`dialog` taken out of whichever list has it.
    fn dialog_closed(&mut self, dialog: NodeId) {
        for list in self.open_dialogs.values_mut() {
            list.retain(|&d| d != dialog);
        }
        self.open_dialogs.retain(|_, list| !list.is_empty());
    }
    // The last of document `doc`'s open dialogs that is connected — in its tree — an entry freed, or connected in another
    // document's (one that moved there), dropped as it is met; one not connected stays, for when it comes back.
    fn topmost_dialog(&mut self, doc: NodeId) -> Option<NodeId> {
        let mut list = self.open_dialogs.remove(&doc)?;
        let mut found = None;
        let mut at = list.len();
        while at > 0 {
            at -= 1;
            let dialog = list[at];
            if self.get(dialog).is_none() || (self.is_connected(dialog) && self.root_of(dialog) != doc) {
                list.remove(at);
            } else if self.is_connected(dialog) {
                found = Some(dialog);
                break;
            }
        }
        if !list.is_empty() {
            self.open_dialogs.insert(doc, list);
        }
        found
    }
    // The removing steps (HTML §4.11.4, §6.12) of `root`'s shadow-including inclusive descendants a removal takes out of a
    // document: a showing popover hidden, a dialog modal no more and out of its open dialogs list — all quietly, with no
    // toggle — and whether they changed an element's state (bit 0), and whether one that left was focused or hovered
    // (bit 1), which the document's focus and hover follow (the bindings').
    fn removing_steps(&mut self, root: NodeId) -> u32 {
        let mut stack = vec![root];
        let (mut hide, mut dialogs, mut left) = (Vec::new(), Vec::new(), false);
        while let Some(id) = stack.pop() {
            let Some(n) = self.get(id) else { continue };
            if n.kind == NodeKind::Element {
                if n.state & (STATE_POPOVER_OPEN | STATE_MODAL) != 0 {
                    hide.push((id, n.state & !(STATE_POPOVER_OPEN | STATE_MODAL)));
                }
                if n.state & (STATE_FOCUSED | STATE_HOVERED) != 0 {
                    left = true;
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
        let changed = !hide.is_empty();
        for (id, bits) in hide {
            self.set_state(id, bits);
        }
        u32::from(changed) | (u32::from(left) << 1)
    }
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "dialogOpened", dialog_opened, context_id);
    crate::dom::register(scope, ns, "dialogClosed", dialog_closed, context_id);
    crate::dom::register(scope, ns, "topmostDialog", topmost_dialog, context_id);
    crate::dom::register(scope, ns, "removingSteps", removing_steps, context_id);
}

// __dom.dialogOpened(docNid, dialogNid) — the dialog the last of the document's open dialogs.
fn dialog_opened(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let (Some(doc), Some(dialog)) = (nid_arg(scope, &args, 0), nid_arg(scope, &args, 1)) else { return };
    let cid = realm_id(scope, &args);
    realm(scope, cid).dialog_opened(doc, dialog);
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
// __dom.removingSteps(rootNid) -> what the removing steps of the subtree did (`removing_steps`: bit 0 a state changed,
// bit 1 a focused or hovered element left).
fn removing_steps(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(root) = nid_arg(scope, &args, 0) else { return rv.set_uint32(0) };
    // (…in the realm whose tree it left, whose document's modal stack its dialogs leave, whichever realm's code removed it)
    let caller = realm_id(scope, &args);
    let cid = crate::dom::dom(scope).arena.get(root).map_or(caller, |n| n.realm);
    rv.set_uint32(realm(scope, cid).removing_steps(root));
}
