// A text control's `change` event, fired as it loses focus (HTML §4.10.5.5: "when the user commits the change") — not on
// each edit: the value it had as it was focused, and whether the USER edited it since. It fires on blur where both hold
// — edited, and the value now another — and a script's write to the value never counts as an edit, so it cannot make the
// control fire `change`, though it moves the value. Implicit submission commits it without the blur (Enter in a field:
// `change` before `submit`, the focus kept). A focused control taken out of its document loses focus with no blur, and
// what it had armed with it (`removing_steps`).

use std::collections::HashMap;

use crate::dom::{nid_arg, NodeData, NodeId, RealmArena};

// The controls armed, by element: the value each had as it was focused, and whether the user edited it since.
pub(crate) type ChangeBaselines = HashMap<NodeId, (Vec<u16>, bool)>;

// A control whose `change` waits for the blur: a `<textarea>`, or an `<input>` in the value mode (not a button, a
// checkbox or radio, a file or hidden one — whose `change` the interaction itself fires).
fn is_change_on_blur_control(n: &NodeData) -> bool {
    n.is_html_named("textarea")
        || n.is_html_named("input")
            && !matches!(n.input_type(), "hidden" | "submit" | "image" | "reset" | "button" | "checkbox" | "radio" | "file")
}

impl RealmArena {
    // Its value as the `value` getter reads it: a `<textarea>`'s API value, an `<input>`'s sanitized for its type.
    fn change_value(&self, n: &NodeData) -> Vec<u16> {
        if n.is_html_named("input") {
            self.sanitized_value(n, n.input_type()).encode_utf16().collect()
        } else {
            self.raw_value_units(n)
        }
    }

    // The control is focused: its value now is what a blur compares against, and nothing is edited yet.
    fn change_armed(&mut self, id: NodeId) {
        let Some(n) = self.get(id).filter(|n| is_change_on_blur_control(n)) else { return };
        let value = self.change_value(n);
        self.change_baselines.insert(id, (value, false));
    }

    // Whether the user edited it since it was focused, and its value is another: what it had is forgotten, and it fires
    // `change` where so — `keep_focus` (implicit submission) arms it again with the value it has now.
    fn change_committed(&mut self, id: NodeId, keep_focus: bool) -> bool {
        let Some((baseline, edited)) = self.change_baselines.get(&id) else { return false };
        // (…a control that is no longer one — its `type` changed while focused — fires none)
        let fire = *edited && self.get(id).is_some_and(|n| is_change_on_blur_control(n) && self.change_value(n) != *baseline);
        if keep_focus {
            if fire {
                self.change_armed(id);
            }
        } else {
            self.change_baselines.remove(&id);
        }
        fire
    }
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "changeArm", arm_op, context_id);
    crate::dom::register(scope, ns, "changeEdited", edited_op, context_id);
    crate::dom::register(scope, ns, "changeCommit", commit_op, context_id);
}

// __dom.changeArm(nid): the control is focused (`change_armed`).
fn arm_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = nid_arg(scope, &args, 0) else { return };
    crate::dom::dom(scope).arena.change_armed(id);
}

// __dom.changeEdited(nid, edited): the user edited the control's value (true), or a `change` the edit fired at once —
// Capybara's `set` — committed it (false), so the blur after fires none.
fn edited_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = nid_arg(scope, &args, 0) else { return };
    let edited = args.get(1).is_true();
    if let Some(entry) = crate::dom::dom(scope).arena.change_baselines.get_mut(&id) {
        entry.1 = edited;
    }
}

// __dom.changeCommit(nid, keepFocus) -> whether the control fires `change` as it is blurred — or, `keepFocus`, as
// implicit submission commits it (`change_committed`).
fn commit_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = nid_arg(scope, &args, 0) else { return rv.set_bool(false) };
    let keep_focus = args.get(1).is_true();
    rv.set_bool(crate::dom::dom(scope).arena.change_committed(id, keep_focus));
}
