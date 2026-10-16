// An image button's selected coordinate (HTML §4.10.5.1.20): where a click selected it — the point's offset in the
// button, truncated, as Chrome measures it — for the submission that click makes; the origin for any other (a synthetic
// click, a key's activation, a script's requestSubmit), which no entry here stands for. Kept by the button, let go of
// with it, and by the submission it is for.

use std::collections::HashMap;

use crate::dom::{nid_arg, NodeId, RealmArena};

#[derive(Default)]
pub(crate) struct SelectedCoordinates(HashMap<NodeId, (i32, i32)>);

impl SelectedCoordinates {
    pub(crate) fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
    pub(crate) fn forget(&mut self, button: NodeId) {
        self.0.remove(&button);
    }
}

impl RealmArena {
    // …and those of buttons freed with their realm.
    pub(crate) fn forget_freed_selected_coordinates(&mut self) {
        let freed: Vec<NodeId> = self.selected_coordinates.0.keys().copied().filter(|&b| self.get(b).is_none()).collect();
        for button in freed {
            self.selected_coordinates.0.remove(&button);
        }
    }
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "selectedCoordinate", selected_coordinate, context_id);
    crate::dom::register(scope, ns, "setSelectedCoordinate", set_selected_coordinate, context_id);
}

// __dom.selectedCoordinate(nid) -> the button's selected coordinate, `[x, y]` — the origin where none was selected.
fn selected_coordinate(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let at = nid_arg(scope, &args, 0).and_then(|b| crate::dom::dom(scope).arena.selected_coordinates.0.get(&b).copied());
    let (x, y) = at.unwrap_or((0, 0));
    let (x, y) = (v8::Integer::new(scope, x), v8::Integer::new(scope, y));
    rv.set(v8::Array::new_with_elements(scope, &[x.into(), y.into()]).into());
}

// __dom.setSelectedCoordinate(nid, x, y) — the button's selected coordinate, `x` and `y` truncated toward zero; with no
// numbers, none any more (the submission it was for made).
fn set_selected_coordinate(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(button) = nid_arg(scope, &args, 0) else { return };
    let truncated = |v: f64| if v.is_finite() { v.trunc().clamp(f64::from(i32::MIN), f64::from(i32::MAX)) as i32 } else { 0 };
    let at = match (args.get(1).number_value(scope), args.get(2).number_value(scope)) {
        (Some(x), Some(y)) if args.get(1).is_number() && args.get(2).is_number() => Some((truncated(x), truncated(y))),
        _ => None,
    };
    let coordinates = &mut crate::dom::dom(scope).arena.selected_coordinates.0;
    match at {
        Some(at) => {
            coordinates.insert(button, at);
        }
        None => {
            coordinates.remove(&button);
        }
    }
}
