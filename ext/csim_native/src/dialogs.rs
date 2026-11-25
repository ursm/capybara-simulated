// The dialog element (HTML §4.11.4): show() and "show a modal dialog", "close the dialog", "request to close the dialog",
// its command steps, the dialog focusing steps and light dismiss; a document's open dialogs list, in the order they opened
// — a dialog's setup steps (its `open` attribute set while it is connected in a fully active document, or it inserted
// open) add it and establish its close watcher (close_watchers.rs), its cleanup steps (`open` gone, it removed) undo both —
// its return value, its closed-by state, what a request to close it holds; and the removing steps of the elements whose
// state a removal changes. The events — `beforetoggle`, `toggle`, `cancel`, `close` — and the `open` attribute's writes are
// the bindings' to make (`hostSteps`); everything they decide is here.

use crate::close_watchers::{OrTerminated, Owner, Stop};
use crate::toggle_tasks::Tracker;
use crate::dom::{dom, nid_arg, realm_id, NodeId, NodeKind, RealmArena, STATE_ACTIVE, STATE_FOCUSED, STATE_HOVERED, STATE_MODAL, STATE_POPOVER_OPEN};

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

fn is_open(arena: &RealmArena, dialog: NodeId) -> bool {
    arena.get(dialog).is_some_and(|n| n.plain_attr("open").is_some())
}
fn is_modal(arena: &RealmArena, dialog: NodeId) -> bool {
    arena.get(dialog).is_some_and(|n| n.state & STATE_MODAL != 0)
}

impl RealmArena {
    // HTML "dialog setup steps", where they run — `dialog` open and connected in a fully active document, and not on its
    // open dialogs list yet: the last of that list, and its close watcher established in that document's Window.
    pub(crate) fn dialog_setup_steps(&mut self, dialog: NodeId) {
        let doc = self.shadow_including_root(dialog);
        if !is_open(self, dialog) || !self.is_document(doc) || !self.document_fully_active(doc) {
            return;
        }
        let list = self.open_dialogs.entry(doc).or_default();
        if list.contains(&dialog) {
            return;
        }
        list.push(dialog);
        let realm = self.get(doc).map_or(0, |d| d.realm);
        self.set_element_close_watcher(dialog, realm, Owner::Dialog(dialog));
    }
    // …and its cleanup steps: off its open dialogs list, its close watcher destroyed.
    pub(crate) fn dialog_cleanup_steps(&mut self, dialog: NodeId) {
        for list in self.open_dialogs.values_mut() {
            list.retain(|&d| d != dialog);
        }
        self.open_dialogs.retain(|_, list| !list.is_empty());
        self.destroy_element_close_watcher(dialog);
    }
    // The last of document `doc`'s open dialogs.
    fn topmost_dialog(&self, doc: NodeId) -> Option<NodeId> {
        self.open_dialogs.get(&doc).and_then(|list| list.last().copied())
    }
    // A dialog's close watcher's "get enabled state": a request to close it enables it, else its computed closed-by state
    // not None does.
    pub(crate) fn dialog_watcher_enabled(&self, dialog: NodeId) -> bool {
        self.dialog_requests.get(&dialog).is_some_and(|r| r.enabled) || closed_by(self, dialog) != "none"
    }
    // …and the return value and source element its close action closes it with.
    pub(crate) fn dialog_request(&self, dialog: NodeId) -> (Option<Vec<u16>>, Option<NodeId>) {
        self.dialog_requests.get(&dialog).map_or((None, None), |r| (r.return_value.clone(), r.source))
    }
    // The removing steps (HTML §4.11.4, §6.12, §6.6.4) of `root`'s shadow-including inclusive descendants a removal takes
    // out of a document: a showing popover hidden — HTML "hide popover" with no event and no focus moved, which hides those
    // above it in its lists alike — a dialog's cleanup steps run and it modal no more, and the document's focused and
    // hovered element, where it left, neither any more: its focus is the viewport's (the "focus fixup rule": no event, as
    // Firefox and WebKit — Chrome's `blur` on a removal is a Blink behavior its own intent is retiring) and what a focused
    // text control armed for its blur is gone (change_on_blur.rs). Whether they changed an element's state.
    // …and the hovered element, where it left `parent`, that parent: the pointer is over what is left there, and the
    // ancestors it was over stay `:hover` (Chrome, Firefox).
    pub(crate) fn removing_steps(&mut self, root: NodeId, parent: Option<NodeId>) -> bool {
        const LEAVING: u32 = STATE_MODAL | STATE_FOCUSED | STATE_HOVERED | STATE_ACTIVE;
        let mut stack = vec![root];
        let (mut leave, mut dialogs, mut popovers) = (Vec::new(), Vec::new(), Vec::new());
        while let Some(id) = stack.pop() {
            let Some(n) = self.get(id) else { continue };
            if n.kind == NodeKind::Element {
                if n.state & STATE_POPOVER_OPEN != 0 {
                    popovers.push(id);
                }
                if n.state & LEAVING != 0 {
                    leave.push(id);
                }
                if n.is_html_named("dialog") {
                    dialogs.push(id);
                }
            }
            stack.extend(n.children.iter().copied());
            stack.extend(n.shadow_root);
        }
        let changed = !leave.is_empty() || !popovers.is_empty();
        for popover in popovers {
            self.hide_popover_quietly(popover);
        }
        for dialog in dialogs {
            self.dialog_cleanup_steps(dialog);
        }
        let hovered = self.hover;
        for id in leave {
            self.change_baselines.remove(&id);
            if let Some(bits) = self.get(id).map(|n| n.state & !LEAVING) {
                self.set_state(id, bits);
            }
        }
        if let Some(parent) = parent.filter(|&p| hovered.is_some() && self.hover.is_none() && self.is_element(p) && self.is_connected(p)) {
            let bits = self.get(parent).map_or(0, |n| n.state);
            self.set_state(parent, bits | STATE_HOVERED);
        }
        changed
    }
    // A dialog's return value (HTML: a string of its own, empty until a close or a script gives it one).
    fn return_value(&self, dialog: NodeId) -> Vec<u16> {
        self.dialog_return_values.get(&dialog).cloned().unwrap_or_default()
    }
    fn set_modal(&mut self, dialog: NodeId, modal: bool) {
        let Some((realm, bits)) = self.get(dialog).map(|n| (n.realm, n.state)) else { return };
        let bits = if modal { bits | STATE_MODAL } else { bits & !STATE_MODAL };
        self.enter(realm).set_state(dialog, bits);
    }
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

// What show() and "show a modal dialog" refuse (the bindings' messages, by these codes): a dialog open as the other kind,
// not connected, showing as a popover, of a document not fully active (a modal one, those three) — InvalidStateError.
const OPEN_AS_OTHER: u32 = 1;
const NOT_CONNECTED: u32 = 2;
const SHOWING_AS_POPOVER: u32 = 3;
const NOT_FULLY_ACTIVE: u32 = 4;

// A step's host call, a terminated script stopping the algorithm.
fn alive<T>(answer: Option<T>) -> Result<T, Stop> {
    answer.ok_or(Stop::Terminated)
}
// The bindings' write of a dialog's `open` attribute — set empty, or removed — whose attribute change steps run its setup
// or cleanup steps.
fn set_open(scope: &mut v8::PinScope<'_, '_>, dialog: NodeId, open: bool) -> Option<()> {
    let target = crate::dom::node_value(scope, Some(dialog));
    let open = v8::Boolean::new(scope, open).into();
    crate::dom::call_host_step(scope, "setDialogOpen", &[target, open]).map(drop)
}

// HTML's show() (`modal` false) or "show a modal dialog" of `dialog`, by `source` (an invoker's, or none).
pub(crate) fn show(scope: &mut v8::PinScope<'_, '_>, dialog: NodeId, modal: bool, source: Option<NodeId>) -> Result<(), Stop> {
    let doc = crate::dom::node_document(scope, dialog);
    let arena = &dom(scope).arena;
    if is_open(arena, dialog) {
        return if is_modal(arena, dialog) == modal { Ok(()) } else { Err(Stop::Throw(OPEN_AS_OTHER)) };
    }
    let showing_as_popover = |arena: &RealmArena| arena.get(dialog).is_some_and(|n| n.state & STATE_POPOVER_OPEN != 0);
    if modal {
        if !doc.is_some_and(|d| arena.document_fully_active(d)) {
            return Err(Stop::Throw(NOT_FULLY_ACTIVE));
        }
        if !arena.is_connected(dialog) {
            return Err(Stop::Throw(NOT_CONNECTED));
        }
        if showing_as_popover(arena) {
            return Err(Stop::Throw(SHOWING_AS_POPOVER));
        }
    }
    if !alive(crate::toggle_tasks::fire_before_toggle(scope, dialog, true, source))? {
        return Ok(());
    }
    let arena = &dom(scope).arena;
    if is_open(arena, dialog) || (modal && (!arena.is_connected(dialog) || showing_as_popover(arena))) {
        return Ok(());
    }
    alive(crate::toggle_tasks::queue_toggle_task(scope, dialog, Tracker::Element, false, true, source))?;
    alive(set_open(scope, dialog, true))?;
    let arena = &mut dom(scope).arena;
    if modal {
        arena.set_modal(dialog, true);
    }
    crate::focus::dialog_opening(arena, dialog);
    if let Some(doc) = doc {
        let hide_until = arena.topmost_popover_ancestor(doc, dialog, None);
        crate::popovers::hide_popovers_until(scope, doc, hide_until, false, true)?;
    }
    alive(dialog_focusing_steps(scope, dialog))
}

// HTML "dialog focusing steps" of `dialog`: its control focused — itself where it carries `autofocus`, else its focus
// delegate, else itself — and its top-level document's autofocus processed, where that is of its origin.
pub(crate) fn dialog_focusing_steps(scope: &mut v8::PinScope<'_, '_>, dialog: NodeId) -> Option<()> {
    let control = crate::focus::dialog_focus_control_of(scope, dialog)?;
    crate::focus::run_focusing_steps(scope, control)?;
    crate::autofocus::processed_for(scope, control);
    Some(())
}

// HTML "close the dialog" `dialog` with `result` (none: its return value kept), by `source`: its uncancelable
// `beforetoggle`, its `toggle` queued, its `open` removed, modal no more, the result its return value, what a request to
// close it held forgotten, focus given back to the element focused as it opened — where it was modal or holds the
// focus — and its `close` queued.
pub(crate) fn close_the_dialog(scope: &mut v8::PinScope<'_, '_>, dialog: NodeId, result: Option<Vec<u16>>, source: Option<NodeId>) -> Option<()> {
    if !is_open(&dom(scope).arena, dialog) {
        return Some(());
    }
    crate::toggle_tasks::fire_before_toggle(scope, dialog, false, source)?;
    if !is_open(&dom(scope).arena, dialog) {
        return Some(());
    }
    crate::toggle_tasks::queue_toggle_task(scope, dialog, Tracker::Element, true, false, source)?;
    set_open(scope, dialog, false)?;
    let arena = &mut dom(scope).arena;
    let was_modal = is_modal(arena, dialog);
    arena.set_modal(dialog, false);
    if let Some(result) = result {
        arena.dialog_return_values.insert(dialog, result);
    }
    arena.dialog_requests.remove(&dialog);
    if let Some(previous) = crate::focus::dialog_focus_restore(arena, dialog, was_modal) {
        crate::focus::run_focusing_steps(scope, previous)?;
    }
    let target = crate::dom::node_value(scope, Some(dialog));
    let task = v8::Function::builder(fire_close).data(target).build(scope)?;
    crate::timers::queue_task(scope, task).map(drop)
}
// The task: its `close` fired.
fn fire_close(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    crate::close_watchers::fire_simple_event(scope, args.data(), "close", false);
}

// HTML "request to close the dialog" `dialog` with `return_value`, by `source`: where it is open and connected in a fully
// active document, its close watcher asked to close as a script asks — enabled for it whatever its `closedby` — with
// that return value and source for its close action. A request its `cancel` prevents forgets them too, as the spec does
// not say: a light dismiss after a cancelled `request-close` command has no source (WPT dialog-toggle-source).
fn request_close(scope: &mut v8::PinScope<'_, '_>, dialog: NodeId, return_value: Option<Vec<u16>>, source: Option<NodeId>) -> Option<()> {
    let doc = crate::dom::node_document(scope, dialog);
    let arena = &mut dom(scope).arena;
    if !is_open(arena, dialog) || !arena.is_connected(dialog) || !doc.is_some_and(|d| arena.document_fully_active(d)) {
        return Some(());
    }
    let Some(&(realm, watcher)) = arena.element_watchers.get(&dialog) else { return Some(()) };
    arena.dialog_requests.insert(dialog, RequestClose { enabled: true, return_value, source });
    let closed = crate::close_watchers::request_to_close(scope, realm, watcher, false)?;
    let arena = &mut dom(scope).arena;
    if closed {
        if let Some(request) = arena.dialog_requests.get_mut(&dialog) {
            request.enabled = false;
        }
    } else {
        arena.dialog_requests.remove(&dialog);
    }
    Some(())
}

// HTML "light dismiss open dialogs" for a user's `pointerdown` (`down`) or `pointerup` on `target` at client (x, y) in
// document `doc`: the nearest clicked dialog recorded at the press, and at the release — on the same one, not the dialog
// opened last — the dialog opened last asked to close, where its `closedby` is any.
pub(crate) fn light_dismiss_open_dialogs(scope: &mut v8::PinScope<'_, '_>, doc: NodeId, target: NodeId, (x, y): (f64, f64), down: bool) -> Option<()> {
    let arena = &mut dom(scope).arena;
    let Some(topmost) = arena.topmost_dialog(doc) else { return Some(()) };
    let clicked = arena.get(target).map(|n| n.realm).and_then(|realm| nearest_clicked_dialog(arena.enter(realm), target, x, y));
    if down {
        arena.set_pointerdown_target(doc, 1, clicked);
        return Some(());
    }
    let same = arena.pointerdown_target(doc, 1) == clicked;
    arena.set_pointerdown_target(doc, 1, None);
    if !same || clicked == Some(topmost) || closed_by(arena, topmost) != "any" {
        return Some(());
    }
    let Some(&(realm, watcher)) = arena.element_watchers.get(&topmost) else { return Some(()) };
    crate::close_watchers::request_to_close(scope, realm, watcher, false).map(drop)
}

// HTML "nearest clicked dialog" of a press at client (x, y) on `target`: none for a modal dialog's backdrop — the dialog
// itself the target, the point outside its box — else the nearest open dialog of its flat tree inclusive ancestors. The
// layout as it stands, of the realm whose tree the target is in: the bindings bring it up to date first.
fn nearest_clicked_dialog(arena: &RealmArena, target: NodeId, x: f64, y: f64) -> Option<NodeId> {
    let open_dialog = |id: NodeId| arena.get(id).is_some_and(|n| n.is_html_named("dialog") && n.plain_attr("open").is_some());
    if open_dialog(target) && is_modal(arena, target) {
        let [left, top, width, height] = crate::geometry::rendered_box(arena, target).unwrap_or([0.0; 4]);
        if x < left || x > left + width || y < top || y > top + height {
            return None;
        }
    }
    std::iter::successors(Some(target), |&n| crate::geometry::flat_parent(arena, n)).find(|&n| open_dialog(n))
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "dialogShow", show_op, context_id);
    crate::dom::register(scope, ns, "dialogClose", close_op, context_id);
    crate::dom::register(scope, ns, "dialogRequestClose", request_close_op, context_id);
    crate::dom::register(scope, ns, "dialogCommand", command_op, context_id);
    crate::dom::register(scope, ns, "dialogSetupSteps", setup_steps_op, context_id);
    crate::dom::register(scope, ns, "dialogReturnValue", dialog_return_value, context_id);
    crate::dom::register(scope, ns, "dialogClosedBy", dialog_closed_by, context_id);
    crate::dom::register(scope, ns, "removingSteps", removing_steps, context_id);
}

// A string argument, none for null or undefined.
fn optional_string(scope: &mut v8::PinScope<'_, '_>, value: v8::Local<'_, v8::Value>) -> Option<Vec<u16>> {
    (!value.is_null_or_undefined()).then(|| crate::dom::utf16_arg(scope, value))
}

// __dom.dialogShow(dialog, modal) -> show()'s or showModal()'s end (popovers.rs `answer`).
fn show_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(dialog) = crate::node_handle::nid_of(scope, args.get(0)) else { return };
    let modal = args.get(1).is_true();
    crate::popovers::answer(rv, show(scope, dialog, modal, None));
}
// __dom.dialogClose(dialog, result) — close(), and a `method=dialog` form's submission: HTML "close the dialog".
fn close_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(dialog) = crate::node_handle::nid_of(scope, args.get(0)) else { return };
    let result = optional_string(scope, args.get(1));
    close_the_dialog(scope, dialog, result, None);
}
// __dom.dialogRequestClose(dialog, returnValue) — requestClose().
fn request_close_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(dialog) = crate::node_handle::nid_of(scope, args.get(0)) else { return };
    let return_value = optional_string(scope, args.get(1));
    request_close(scope, dialog, return_value, None);
}
// __dom.dialogCommand(dialog, command, invoker) — a dialog's command steps for an invoker's built-in command: none for one
// showing as a popover; `close` and `request-close` an open one closed, its result the invoker's optional value;
// `show-modal` a closed one shown modally.
fn command_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(dialog) = crate::node_handle::nid_of(scope, args.get(0)) else { return };
    let command = args.get(1).to_rust_string_lossy(scope);
    let invoker = crate::node_handle::nid_of(scope, args.get(2));
    let arena = &dom(scope).arena;
    if arena.get(dialog).is_none_or(|n| n.state & STATE_POPOVER_OPEN != 0) {
        return;
    }
    let value = invoker.and_then(|i| arena.get(i)).and_then(|n| n.attr_units("value").map(|v| v.into_owned()));
    match (command.as_str(), is_open(arena, dialog)) {
        ("close", true) => {
            close_the_dialog(scope, dialog, value, invoker);
        }
        ("request-close", true) => {
            request_close(scope, dialog, value, invoker);
        }
        ("show-modal", false) => {
            let _ = show(scope, dialog, true, invoker).or_terminated();
        }
        _ => {}
    }
}
// __dom.dialogSetupSteps(dialog) — a dialog connected open, or given `open` as a parser or a clone made it: its setup
// steps, where they run (`dialog_setup_steps`).
fn setup_steps_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(dialog) = crate::node_handle::nid_of(scope, args.get(0)) else { return };
    dom(scope).arena.dialog_setup_steps(dialog);
}

// __dom.removingSteps(rootNid): the removing steps of the subtree (`removing_steps`).
fn removing_steps(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(root) = nid_arg(scope, &args, 0) else { return };
    // (…in the realm whose tree it left, whose document's modal stack its dialogs leave, whichever realm's code removed it)
    let caller = realm_id(scope, &args);
    let cid = dom(scope).arena.get(root).map_or(caller, |n| n.realm);
    crate::dom::realm(scope, cid).removing_steps(root, None);
}

// __dom.dialogClosedBy(dialog) -> its `closedby` state's keyword (`closed_by`).
fn dialog_closed_by(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let keyword = crate::node_handle::nid_of(scope, args.get(0)).map_or("none", |id| closed_by(&dom(scope).arena, id));
    rv.set(v8::String::new(scope, keyword).map_or_else(|| v8::undefined(scope).into(), Into::into));
}

// __dom.dialogReturnValue(dialog[, value]) -> its return value; with `value` (a second argument), that set.
fn dialog_return_value(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = crate::node_handle::nid_of(scope, args.get(0)) else { return };
    if args.length() > 1 {
        let value = crate::dom::utf16_arg(scope, args.get(1));
        dom(scope).arena.dialog_return_values.insert(id, value);
        return;
    }
    let value = dom(scope).arena.return_value(id);
    rv.set(crate::dom::utf16_value(scope, &value));
}
