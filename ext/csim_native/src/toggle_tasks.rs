// An element's toggle task tracker (HTML "queue a details toggle event task", "queue a popover toggle event task"): the
// task queued to fire its `toggle` — by its key on the realm's task list — and the old state that task carries, which a
// change made while it is queued keeps, the task queued again behind what was queued since (open-then-close fires
// closed → closed). Kept by the element, let go of with it.

use std::collections::HashMap;

use crate::dom::{nid_arg, NodeId, RealmArena};

#[derive(Default)]
pub(crate) struct ToggleTasks(HashMap<NodeId, (i64, bool)>);

impl ToggleTasks {
    pub(crate) fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
    pub(crate) fn forget(&mut self, el: NodeId) {
        self.0.remove(&el);
    }
}

impl RealmArena {
    // …and those of elements freed with their realm.
    pub(crate) fn forget_freed_toggle_tasks(&mut self) {
        let freed: Vec<NodeId> = self.toggle_tasks.0.keys().copied().filter(|&e| self.get(e).is_none()).collect();
        for el in freed {
            self.toggle_tasks.0.remove(&el);
        }
    }
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "toggleTask", toggle_task, context_id);
    crate::dom::register(scope, ns, "setToggleTask", set_toggle_task, context_id);
}

// __dom.toggleTask(nid) -> `[key, oldStateOpen]` of the element's toggle task queued, or null for none.
fn toggle_task(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(el) = nid_arg(scope, &args, 0) else { return rv.set_null() };
    let Some(&(key, open)) = crate::dom::dom(scope).arena.toggle_tasks.0.get(&el) else { return rv.set_null() };
    let key = v8::Number::new(scope, key as f64);
    let open = v8::Boolean::new(scope, open);
    rv.set(v8::Array::new_with_elements(scope, &[key.into(), open.into()]).into());
}

// __dom.setToggleTask(nid, key, oldStateOpen) — the element's toggle task queued under `key`, carrying the old state;
// with no key (`null`), none queued any more.
fn set_toggle_task(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(el) = nid_arg(scope, &args, 0) else { return };
    let key = args.get(1).integer_value(scope).filter(|_| args.get(1).is_number());
    let open = args.get(2).is_true();
    let tasks = &mut crate::dom::dom(scope).arena.toggle_tasks.0;
    match key {
        Some(key) => {
            tasks.insert(el, (key, open));
        }
        None => {
            tasks.remove(&el);
        }
    }
}
