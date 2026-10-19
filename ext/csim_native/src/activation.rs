// HTML's activation behaviours (§6.1-6.4, the element's own: §4.10.5.1.15-16, §4.10.6, §4.11.2, §4.6.4), for a click
// whose activation target is `act` (element_state.rs `activation_target`): its legacy-pre-activation behaviour before
// the click's listeners run — a checkbox's checkedness toggled and indeterminate cleared, a radio button checked — and
// what undoes it where a listener canceled the click; and, otherwise, which of its activation behaviours apply, which the
// bindings run (dispatch.js): a checkable's `input` and `change`, a picker's activation consumed, an image button's
// coordinate, its form submitted or reset, a summary's details toggled, an invoker's command, a label's control clicked,
// a hyperlink followed.

use crate::dom::{realm, NodeData, NodeId, RealmArena, STATE_CHECKED, STATE_CHECKED_DIRTY, STATE_INDETERMINATE};

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "preActivate", pre_activate, context_id);
    crate::dom::register(scope, ns, "cancelActivation", cancel_activation, context_id);
    crate::dom::register(scope, ns, "activation", activation, context_id);
    crate::dom::register(scope, ns, "invokerAction", invoker_action, context_id);
    crate::dom::register(scope, ns, "buttonCommand", button_command_op, context_id);
}

impl RealmArena {
    // A checkbox's or a radio button's checkedness set — dirty from now on — a radio checked unchecking the rest of its
    // group (HTML "set the checkedness"), as every writer of it does.
    pub(crate) fn set_checkedness(&mut self, id: NodeId, on: bool) {
        let Some(had) = self.get(id).map(|n| n.state) else { return };
        let was_checked = self.is_checked(id);
        let next = (had & !STATE_CHECKED) | STATE_CHECKED_DIRTY | if on { STATE_CHECKED } else { 0 };
        if next != had {
            self.set_state(id, next);
        }
        if on && !was_checked {
            self.radio_steps(id);
        }
        self.observers.note_state_changed();
    }
}

// A checkbox or a radio button — an HTML `<input>` of either type — Some(radio).
fn checkable(n: &NodeData) -> Option<bool> {
    n.is_html_named("input").then(|| n.input_type()).and_then(|t| match t {
        "checkbox" => Some(false),
        "radio" => Some(true),
        _ => None,
    })
}

// __dom.preActivate(act) -> undefined, or what undoes its legacy-pre-activation behaviour: `[radio, wasChecked,
// wasIndeterminate, checkedBefore]` — a checkbox's checkedness and indeterminate as they were, a radio button's group's
// checked one (null for none).
fn pre_activate(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(act) = crate::node_handle::nid_of(scope, args.get(0)) else { return };
    let Some(cid) = crate::dom::dom(scope).arena.get(act).map(|n| n.realm) else { return };
    let arena = realm(scope, cid);
    let Some(radio) = arena.get(act).and_then(checkable) else { return };
    let was_checked = arena.is_checked(act);
    let was_indeterminate = arena.get(act).is_some_and(|n| n.state & STATE_INDETERMINATE != 0);
    let before = if radio { arena.radio_group(act).into_iter().filter(|&r| arena.is_checked(r)).last() } else { None };
    if radio {
        arena.set_checkedness(act, true);
    } else {
        if was_indeterminate {
            let state = arena.get(act).map_or(0, |n| n.state) & !STATE_INDETERMINATE;
            arena.set_state(act, state);
        }
        arena.set_checkedness(act, !was_checked);
    }
    let before = crate::dom::node_value(scope, before);
    let values = [
        v8::Boolean::new(scope, radio).into(),
        v8::Boolean::new(scope, was_checked).into(),
        v8::Boolean::new(scope, was_indeterminate).into(),
        before
    ];
    rv.set(v8::Array::new_with_elements(scope, &values).into());
}

// __dom.cancelActivation(act, radio, wasChecked, wasIndeterminate, checkedBefore) — its legacy-canceled-activation
// behaviour: the radio button its group had checked checked again, or the checkbox's checkedness and indeterminate as
// they were (a value a listener set reverted too).
fn cancel_activation(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(act) = crate::node_handle::nid_of(scope, args.get(0)) else { return };
    let Some(cid) = crate::dom::dom(scope).arena.get(act).map(|n| n.realm) else { return };
    let (radio, was_checked, was_indeterminate) = (args.get(1).is_true(), args.get(2).is_true(), args.get(3).is_true());
    let before = crate::node_handle::nid_of(scope, args.get(4));
    let arena = realm(scope, cid);
    if radio {
        arena.set_checkedness(act, false);
        if let Some(before) = before {
            arena.set_checkedness(before, true);
        }
    } else {
        arena.set_checkedness(act, was_checked);
        let state = arena.get(act).map_or(0, |n| n.state);
        let next = (state & !STATE_INDETERMINATE) | if was_indeterminate { STATE_INDETERMINATE } else { 0 };
        if next != state {
            arena.set_state(act, next);
        }
    }
}

// What `activation` answers: the behaviours that apply.
const CHECKABLE: u32 = 1; // a checkbox or radio button: a user's click an interaction with it
const CHECKABLE_CHANGED: u32 = 1 << 1; // …its checkedness changed, connected: `input` and `change`
const PICKER: u32 = 1 << 2; // an input whose activation shows a picker: the user's transient activation consumed
const IMAGE: u32 = 1 << 3; // an image button: the coordinate its click selected
const SUBMIT: u32 = 1 << 4; // a submit button: its form owner submitted
const RESET: u32 = 1 << 5; // a reset button: its form owner reset
const SUMMARY: u32 = 1 << 6; // the summary for its details: those toggled
const INVOKER: u32 = 1 << 7; // anything else that activated no form: an invoker's command, where it is one
const LABEL: u32 = 1 << 8; // a label clicked on itself or on what of it is no interactive content: its control clicked
const HYPERLINK: u32 = 1 << 9; // a hyperlink outside an editing host: followed

// The input types whose activation shows a picker.
const PICKER_TYPES: [&str; 7] = ["color", "date", "datetime-local", "file", "month", "time", "week"];

// __dom.activation(act, target, wasChecked) -> `[steps, form, control]`: the activation behaviours of `act` for a click on
// `target` (`steps`, above), with the form a submit or reset button's acts on and the control a label's clicks;
// `wasChecked` a checkable's checkedness before its pre-activation (undefined for none).
fn activation(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(act) = crate::node_handle::nid_of(scope, args.get(0)) else { return };
    let target = crate::node_handle::nid_of(scope, args.get(1));
    let was_checked = (!args.get(2).is_undefined()).then(|| args.get(2).is_true());
    let Some(cid) = crate::dom::dom(scope).arena.get(act).map(|n| n.realm) else { return };
    let arena = realm(scope, cid);
    let Some(n) = arena.get(act) else { return };
    let connected = arena.is_connected(act);
    let mut steps = 0;
    let (mut form, mut control) = (None, None);
    if checkable(n).is_some() {
        steps |= CHECKABLE;
        if connected && was_checked.is_some_and(|was| was != arena.is_checked(act)) {
            steps |= CHECKABLE_CHANGED;
        }
    } else {
        if n.is_html_named("input") && PICKER_TYPES.contains(&n.input_type()) {
            steps |= PICKER;
        }
        if n.is_html_named("input") && n.input_type() == "image" {
            steps |= IMAGE;
        }
        let reset = if n.is_html_named("button") { arena.button_type(act) == Some("reset") } else { n.is_html_named("input") && n.input_type() == "reset" };
        if connected && !arena.is_actually_disabled(act) && (arena.is_submit_button(act) || reset) {
            form = arena.form_owner(act);
            if form.is_some() {
                steps |= if reset { RESET } else { SUBMIT };
            }
        }
        if n.is_html_named("summary") {
            if arena.is_details_summary(act) {
                steps |= SUMMARY;
            }
        } else if form.is_none() {
            steps |= INVOKER;
        }
        if n.is_html_named("label") && target.and_then(|t| arena.label_to_activate(t)) == Some(act) {
            control = arena.labeled_control(act).filter(|&c| Some(c) != target);
            if control.is_some() {
                steps |= LABEL;
            }
        }
        if n.is_hyperlink() && !arena.is_editable(act) {
            steps |= HYPERLINK;
        }
    }
    let values = [v8::Integer::new_from_unsigned(scope, steps).into(), crate::dom::node_value(scope, form), crate::dom::node_value(scope, control)];
    rv.set(v8::Array::new_with_elements(scope, &values).into());
}

// The built-in commands of a button's `command` (HTML §4.10.6), those of a popover and those of a dialog.
const POPOVER_COMMANDS: [&str; 3] = ["toggle-popover", "show-popover", "hide-popover"];
const DIALOG_COMMANDS: [&str; 3] = ["close", "request-close", "show-modal"];

// A button's command: its `command` attribute's keyword — a built-in one, ASCII case-insensitive, lowercased; a custom
// one (`--` and more) as it is written — None for a missing or unknown one.
fn button_command(n: &NodeData) -> Option<String> {
    let raw = n.plain_attr("command")?;
    if raw.starts_with("--") {
        return Some(raw.to_owned());
    }
    let keyword = raw.to_ascii_lowercase();
    (POPOVER_COMMANDS.contains(&keyword.as_str()) || DIALOG_COMMANDS.contains(&keyword.as_str())).then_some(keyword)
}
// __dom.buttonCommand(button) -> its command (`button_command`), '' for none.
fn button_command_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let command = crate::node_handle::nid_of(scope, args.get(0)).and_then(|id| crate::dom::dom(scope).arena.get(id).and_then(button_command));
    if let Some(s) = v8::String::new(scope, command.as_deref().unwrap_or("")) {
        rv.set(s.into());
    }
}

// What `invokerAction` answers an invoker does: a popover's built-in command, a dialog's, a custom one — each whose
// `command` event the bindings fire, then the steps of a built-in one where it is not canceled — and a popover
// invoker's action on its popover.
const INVOKE_POPOVER_COMMAND: u32 = 1;
const INVOKE_DIALOG_COMMAND: u32 = 2;
const INVOKE_CUSTOM_COMMAND: u32 = 3;
const INVOKE_POPOVER_TARGET: u32 = 4;

// HTML's "popover target element" of `id` — its `popovertarget`'s popover, or a `<button commandfor>`'s popover where its
// command is a popover's — for a button or a button-like input that is not disabled and no submit button with a form
// owner: what a press on it is a press of, for the popovers' light dismiss.
pub(crate) fn invoked_popover(arena: &RealmArena, id: NodeId) -> Option<NodeId> {
    let n = arena.get(id)?;
    let button = n.is_html_named("button");
    if !button && !(n.is_html_named("input") && n.input_has(crate::input_types::BUTTON)) {
        return None;
    }
    if arena.is_actually_disabled(id) || (arena.is_submit_button(id) && arena.form_owner(id).is_some()) {
        return None;
    }
    let popover = |p: NodeId| arena.get(p).is_some_and(crate::popovers::is_popover);
    if let Some(target) = button.then(|| arena.referenced_element(id, "commandfor")).flatten() {
        let command = button_command(n);
        return command.filter(|c| POPOVER_COMMANDS.contains(&c.as_str())).map(|_| target).filter(|&t| popover(t));
    }
    arena.referenced_element(id, "popovertarget").filter(|&p| popover(p))
}

// __dom.invokerAction(invoker, eventTarget) -> undefined, or `[kind, target, command, action]`: HTML's button activation
// for a command or popover invoker, which a click runs for its activation target where that submitted or reset no form —
// nothing for a disabled or disconnected one, nor for a button with a form owner unless its type is `button` (a submit,
// reset or Auto one has the form's activation), nor an input with one unless it is a `button` input. A `<button
// commandfor>` with a command its target takes: the command — a built-in one of a popover (`action` its toggle, show or
// hide) or of a dialog, or a custom one; else a popover invoker's popover and its `popovertargetaction` (toggle, show or
// hide) — but none for a click inside a popover that is the invoker's descendant.
fn invoker_action(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(invoker) = crate::node_handle::nid_of(scope, args.get(0)) else { return };
    let event_target = crate::node_handle::nid_of(scope, args.get(1));
    let Some(cid) = crate::dom::dom(scope).arena.get(invoker).map(|n| n.realm) else { return };
    let arena = realm(scope, cid);
    let Some(n) = arena.get(invoker) else { return };
    if n.plain_attr("commandfor").is_none() && n.plain_attr("popovertarget").is_none() {
        return;
    }
    let button = n.is_html_named("button");
    if !button && !(n.is_html_named("input") && n.input_has(crate::input_types::BUTTON)) {
        return;
    }
    // (…a button or button-like input whose `type` is no Button state submits its form owner, rather than invoke)
    let ty = n.plain_attr("type").unwrap_or("").to_ascii_lowercase();
    if arena.is_actually_disabled(invoker) || !arena.is_connected(invoker) || (arena.form_owner(invoker).is_some() && ty != "button") {
        return;
    }
    let popover = |id: NodeId| arena.get(id).is_some_and(crate::popovers::is_popover);
    let (kind, target, command, action) = match button.then(|| arena.referenced_element(invoker, "commandfor")).flatten() {
        Some(target) => {
            let Some(command) = button_command(n) else { return };
            if command.starts_with("--") {
                (INVOKE_CUSTOM_COMMAND, target, command, String::new())
            } else if POPOVER_COMMANDS.contains(&command.as_str()) && popover(target) {
                let action = command.trim_end_matches("-popover").to_owned();
                (INVOKE_POPOVER_COMMAND, target, command, action)
            } else if DIALOG_COMMANDS.contains(&command.as_str()) && arena.get(target).is_some_and(|t| t.is_html_named("dialog")) {
                (INVOKE_DIALOG_COMMAND, target, command.clone(), command)
            } else {
                return;
            }
        }
        None => {
            let Some(target) = arena.referenced_element(invoker, "popovertarget").filter(|&p| popover(p)) else { return };
            let inside = event_target.is_some_and(|t| arena.shadow_including_ancestor(target, t));
            if inside && target != invoker && arena.shadow_including_ancestor(invoker, target) {
                return;
            }
            let action = n.plain_attr("popovertargetaction").unwrap_or("").to_ascii_lowercase();
            let action = if matches!(action.as_str(), "show" | "hide") { action } else { "toggle".to_owned() };
            (INVOKE_POPOVER_TARGET, target, String::new(), action)
        }
    };
    let target = crate::dom::node_value(scope, Some(target));
    let (Some(command), Some(action)) = (v8::String::new(scope, &command), v8::String::new(scope, &action)) else { return };
    let values = [v8::Integer::new_from_unsigned(scope, kind).into(), target, command.into(), action.into()];
    rv.set(v8::Array::new_with_elements(scope, &values).into());
}
