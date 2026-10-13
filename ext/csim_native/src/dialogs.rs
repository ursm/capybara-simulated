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
        self.note_close_watcher(dialog);
    }
    // …`dialog` taken out of whichever list has it — closed, or removed — and what a request to close it held forgotten
    // (HTML "close the dialog": its request close return value and source element null).
    fn dialog_closed(&mut self, dialog: NodeId) {
        self.dialog_requests.remove(&dialog);
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
    pub(crate) fn topmost_dialog(&mut self, doc: NodeId) -> Option<NodeId> {
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
    pub(crate) fn removing_steps(&mut self, root: NodeId) -> bool {
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
    crate::dom::register(scope, ns, "dialogClosedBy", dialog_closed_by, context_id);
    crate::dom::register(scope, ns, "dialogShowCheck", dialog_show_check, context_id);
    crate::dom::register(scope, ns, "dialogReturnValue", dialog_return_value, context_id);
    crate::dom::register(scope, ns, "closeWatcherOf", close_watcher_of, context_id);
    crate::dom::register(scope, ns, "dialogRequestClose", dialog_request_close, context_id);
    crate::dom::register(scope, ns, "dialogCancelled", dialog_cancelled, context_id);
    crate::dom::register(scope, ns, "clickedDialog", clicked_dialog, context_id);
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

// A dialog's `closedby` attribute's state (HTML §4.11.4): `any`, `closerequest` or `none`, ASCII case-insensitively; a
// missing or invalid one the Auto state, whose keyword is the one it computes — a modal dialog closes on a close
// request, any other on none.
fn closed_by(arena: &RealmArena, dialog: NodeId) -> &'static str {
    let Some(n) = arena.get(dialog) else { return "none" };
    match n.plain_attr("closedby") {
        Some(v) if v.eq_ignore_ascii_case("any") => "any",
        Some(v) if v.eq_ignore_ascii_case("closerequest") => "closerequest",
        Some(v) if v.eq_ignore_ascii_case("none") => "none",
        _ if n.state & STATE_MODAL != 0 => "closerequest",
        _ => "none",
    }
}

// __dom.dialogClosedBy(dialog) -> its `closedby` state's keyword (`closed_by`).
fn dialog_closed_by(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let keyword = crate::node_handle::nid_of(scope, args.get(0)).map_or("none", |id| closed_by(&crate::dom::dom(scope).arena, id));
    rv.set(v8::String::new(scope, keyword).map_or_else(|| v8::undefined(scope).into(), Into::into));
}

// What `show()` / `showModal()` may do with a dialog (`dialogShowCheck`): show it; nothing, open already as it would be
// shown; or refuse it — an InvalidStateError — open as the other kind, not connected (a modal one), showing as a popover
// (a modal one).
const SHOW: u32 = 0;
const SHOWN: u32 = 1;
const OPEN_AS_OTHER: u32 = 2;
const NOT_CONNECTED: u32 = 3;
const SHOWING_AS_POPOVER: u32 = 4;

// __dom.dialogShowCheck(dialog, modal) -> what HTML's show() (`modal` false) or "show a modal dialog" may do with the
// dialog as it stands — asked again after its `beforetoggle`, whose listeners may have changed it (`SHOW` …).
fn dialog_show_check(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = crate::node_handle::nid_of(scope, args.get(0)) else { return rv.set_uint32(SHOWN) };
    let modal = args.get(1).is_true();
    let arena = &crate::dom::dom(scope).arena;
    let Some(n) = arena.get(id) else { return rv.set_uint32(SHOWN) };
    let (open, is_modal) = (n.plain_attr("open").is_some(), n.state & STATE_MODAL != 0);
    rv.set_uint32(match (open, modal) {
        (true, _) if is_modal == modal => SHOWN,
        (true, _) => OPEN_AS_OTHER,
        (false, true) if !arena.is_connected(id) => NOT_CONNECTED,
        (false, true) if n.state & STATE_POPOVER_OPEN != 0 => SHOWING_AS_POPOVER,
        _ => SHOW,
    });
}

impl RealmArena {
    // A dialog's return value (HTML: a string of its own, empty until a close or a script gives it one).
    fn return_value(&self, dialog: NodeId) -> Vec<u16> {
        self.dialog_return_values.get(&dialog).cloned().unwrap_or_default()
    }
}

// __dom.dialogReturnValue(dialog[, value]) -> its return value; with `value` (a second argument), that set.
fn dialog_return_value(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = crate::node_handle::nid_of(scope, args.get(0)) else { return };
    if args.length() > 1 {
        let value = crate::dom::utf16_arg(scope, args.get(1));
        crate::dom::dom(scope).arena.dialog_return_values.insert(id, value);
        return;
    }
    let value = crate::dom::dom(scope).arena.return_value(id);
    rv.set(crate::dom::utf16_value(scope, &value));
}

// __dom.closeWatcherOf(element) -> which close watcher an open dialog or a showing popover has — a number each one made
// as it opened gets, a re-insertion's a new one — or 0 for none: a request to close goes on only while its dialog keeps
// the watcher it began with (HTML "request to close": a watcher destroyed is no longer active).
fn close_watcher_of(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let watcher = crate::node_handle::nid_of(scope, args.get(0)).and_then(|id| crate::dom::dom(scope).arena.close_watcher_order.get(&id).copied());
    rv.set_double(watcher.unwrap_or(0) as f64);
}

// What a request to close a dialog holds until its close watcher closes it (HTML "request to close the dialog"): whether
// it enables the watcher, whatever the dialog's `closedby` ("enable close watcher for request close"), and the return
// value and source element its close action closes the dialog with — which a request made meanwhile, a `cancel`
// listener's, overwrites.
#[derive(Default)]
pub(crate) struct RequestClose {
    enabled: bool,
    return_value: Option<Vec<u16>>,
    source: Option<NodeId>,
}

// Which request it is: a script's or an invoker's (`requestClose()`, a `request-close` command: HTML "request to close
// the dialog", which enables the watcher and gives the return value), or the user's (a close request or light dismiss:
// the watcher's own, which does neither).
const REQUESTED: u32 = 0;

impl RealmArena {
    // Whether `watcher`, the one a request to close `dialog` began with, is still active and enabled: the dialog
    // connected and keeping it (a listener that took it out of its document destroyed it, its removing steps, and a
    // re-insertion or a reopening made a new one), and its `closedby` takes a close request or a request enables it.
    fn watcher_enabled(&self, dialog: NodeId, watcher: u64) -> bool {
        self.is_connected(dialog)
            && self.close_watcher_order.get(&dialog) == Some(&watcher)
            && (self.dialog_requests.get(&dialog).is_some_and(|r| r.enabled) || closed_by(self, dialog) != "none")
    }
}

// __dom.dialogRequestClose(dialog, returnValue|null, sourceNid|null, kind) -> the close watcher whose cancel action runs
// now — the bindings fire `cancel`, then `dialogCancelled` — or 0 where the request ends here: the dialog not open, not
// connected, with no watcher, or its watcher running its cancel action already (HTML "request to close" step 2: a
// `cancel` listener's request returns at once, Chrome firing one `cancel`). A script's request (`REQUESTED`) enables the
// watcher and gives the return value and source first (steps 4-6), and one that ends here disables it again (step 8).
fn dialog_request_close(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(dialog) = crate::node_handle::nid_of(scope, args.get(0)) else { return rv.set_double(0.0) };
    let return_value = (!args.get(1).is_null_or_undefined()).then(|| crate::dom::utf16_arg(scope, args.get(1)));
    let source = nid_arg(scope, &args, 2);
    let requested = args.get(3).uint32_value(scope) == Some(REQUESTED);
    let arena = &mut crate::dom::dom(scope).arena;
    let open = arena.get(dialog).is_some_and(|n| n.plain_attr("open").is_some());
    let Some(&watcher) = arena.close_watcher_order.get(&dialog).filter(|_| open && arena.is_connected(dialog)) else { return rv.set_double(0.0) };
    if requested {
        *arena.dialog_requests.entry(dialog).or_default() = RequestClose { enabled: true, return_value, source };
    }
    if !arena.watcher_enabled(dialog, watcher) || !arena.running_cancel.insert(watcher) {
        if let Some(r) = arena.dialog_requests.get_mut(&dialog).filter(|_| requested) {
            r.enabled = false;
        }
        return rv.set_double(0.0);
    }
    rv.set_double(watcher as f64);
}

// __dom.dialogCancelled(dialog, watcher, prevented) -> [returnValue|null, source|null] to close the dialog with, or null
// to leave it: the watcher's cancel action over (`prevented` a listener cancelled it), and the close action its due —
// where the watcher is still active and enabled — with the return value and source the last request gave; the request's
// enabling ended (step 8). One that leaves the dialog open forgets them too, as the spec does not say: a light dismiss
// after a cancelled `request-close` command has no source (WPT dialog-toggle-source).
fn dialog_cancelled(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(dialog) = crate::node_handle::nid_of(scope, args.get(0)) else { return rv.set_null() };
    let watcher = args.get(1).integer_value(scope).unwrap_or(0) as u64;
    let prevented = args.get(2).boolean_value(scope);
    let arena = &mut crate::dom::dom(scope).arena;
    arena.running_cancel.remove(&watcher);
    let closes = !prevented && arena.watcher_enabled(dialog, watcher);
    if !closes {
        arena.dialog_requests.remove(&dialog);
        return rv.set_null();
    }
    let (return_value, source) = arena.dialog_requests.get_mut(&dialog).map_or((None, None), |r| {
        r.enabled = false;
        (r.return_value.clone(), r.source)
    });
    let return_value = match return_value {
        Some(v) => crate::dom::utf16_value(scope, &v),
        None => v8::null(scope).into(),
    };
    let source = node_value(scope, source);
    rv.set(v8::Array::new_with_elements(scope, &[return_value, source]).into());
}

// __dom.clickedDialog(target, x, y) -> the open dialog a pointer press or release at client (x, y) on `target` is in
// (HTML "light dismiss open dialogs": the nearest clicked dialog), or null: a modal dialog itself only where the point
// is within its box — else its backdrop's, no dialog's — and otherwise the nearest open dialog the target is in, up the
// flat tree. The layout as it stands: the bindings bring it up to date first.
fn clicked_dialog(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(target) = crate::node_handle::nid_of(scope, args.get(0)) else { return rv.set_null() };
    let [x, y] = [1, 2].map(|i| args.get(i).number_value(scope).unwrap_or(0.0));
    // (…in the realm whose tree the target is in, whose layout the box is of — whichever realm's code asked)
    let caller = realm_id(scope, &args);
    let cid = crate::dom::dom(scope).arena.get(target).map_or(caller, |n| n.realm);
    let arena: &RealmArena = realm(scope, cid);
    let open_dialog = |id: NodeId| arena.get(id).is_some_and(|n| n.is_html_named("dialog") && n.plain_attr("open").is_some());
    if open_dialog(target) && arena.get(target).is_some_and(|n| n.state & STATE_MODAL != 0) {
        let [left, top, width, height] = crate::geometry::rendered_box(arena, target).unwrap_or([0.0; 4]);
        if x < left || x > left + width || y < top || y > top + height {
            return rv.set_null();
        }
    }
    let mut node = Some(target);
    while let Some(id) = node {
        if open_dialog(id) {
            return rv.set(node_value(scope, Some(id)));
        }
        node = crate::geometry::flat_parent(arena, id);
    }
    rv.set_null();
}
