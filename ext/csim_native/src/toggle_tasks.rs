// An element's toggle task trackers (HTML "queue a details toggle event task", "queue a popover toggle event task", "queue
// a dialog toggle event task"): the task queued to fire its `toggle` — by its key on the event loop — and the old state
// that task carries, which a change made while it is queued keeps, the task queued again behind what was queued since
// (open-then-close fires closed → closed). A popover's is one tracker, a details element's or a dialog's another: a dialog
// shown as a popover and as a dialog at once fires both toggles. Kept by the element, let go of with it. The task is
// queued and its event fired through the bindings' steps (`setTimeout`, `fireToggleEvent`); which task and which states
// are the engine's.

use std::collections::HashMap;

use crate::dom::{dom, NodeId, RealmArena};

#[derive(Default)]
pub(crate) struct ToggleTasks(HashMap<(NodeId, Tracker), (i64, bool)>);

// Which of an element's trackers a toggle task is on.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum Tracker {
    Popover,
    Element,
}

impl ToggleTasks {
    pub(crate) fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
    pub(crate) fn forget(&mut self, el: NodeId) {
        self.0.retain(|&(e, _), _| e != el);
    }
}

impl RealmArena {
    // …and those of elements freed with their realm.
    pub(crate) fn forget_freed_toggle_tasks(&mut self) {
        let freed: Vec<(NodeId, Tracker)> = self.toggle_tasks.0.keys().copied().filter(|&(e, _)| self.get(e).is_none()).collect();
        for key in freed {
            self.toggle_tasks.0.remove(&key);
        }
    }
}

// HTML "queue a … toggle event task" for `el` on its `tracker`, from `old_open` to `new_open`, by `source` (an invoker's,
// or none): a task already queued on it removed, its old state kept, and one queued that fires a `toggle` ToggleEvent of
// the two states (None: a script was terminated). "If element's popover toggle task tracker is not null: Set oldState
// to element's popover toggle task tracker's old state. Remove element's popover toggle task tracker's task from its
// task queue" — so a popover hidden during its own show's focusing steps (its `popover` removed by a focus listener)
// fires ONE `toggle`, open → open, where Chrome fires two (WPT popover-events, popover-remove-attribute-during-focusing-
// steps); no whatwg issue revisits the coalescing.
pub(crate) fn queue_toggle_task(scope: &mut v8::PinScope<'_, '_>, el: NodeId, tracker: Tracker, old_open: bool, new_open: bool, source: Option<NodeId>) -> Option<()> {
    let old_open = match dom(scope).arena.toggle_tasks.0.remove(&(el, tracker)) {
        Some((key, old)) => {
            crate::timers::cancel_task(scope, key)?;
            old
        }
        None => old_open,
    };
    let target = crate::dom::node_value(scope, Some(el));
    let source = crate::dom::node_value(scope, source);
    let (old, new) = (v8::Boolean::new(scope, old_open).into(), v8::Boolean::new(scope, new_open).into());
    let popover = v8::Boolean::new(scope, tracker == Tracker::Popover).into();
    let data = v8::Array::new_with_elements(scope, &[target, old, new, source, popover]);
    let task = v8::Function::builder(run_toggle_task).data(data.into()).build(scope)?;
    let key = crate::timers::queue_task(scope, task)?;
    dom(scope).arena.toggle_tasks.0.insert((el, tracker), (key, old_open));
    Some(())
}

// The task: the tracker emptied, and its `toggle` fired.
fn run_toggle_task(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Ok(data) = v8::Local::<v8::Array>::try_from(args.data()) else { return };
    let [target, old, new, source, popover] = [0, 1, 2, 3, 4].map(|i| data.get_index(scope, i).unwrap_or_else(|| v8::null(scope).into()));
    let tracker = if popover.is_true() { Tracker::Popover } else { Tracker::Element };
    if let Some(el) = crate::node_handle::nid_of(scope, target) {
        dom(scope).arena.toggle_tasks.0.remove(&(el, tracker));
    }
    fire_toggle_event(scope, target, "toggle", old.is_true(), new.is_true(), source, false);
}

// A ToggleEvent named `ty` fired at `target` — `toggle`, or the `beforetoggle` before a popover's or a dialog's change,
// cancelable where it opens — from one state to the other, its source `source`: whether it was not canceled (None: a
// script was terminated).
pub(crate) fn fire_toggle_event(
    scope: &mut v8::PinScope<'_, '_>,
    target: v8::Local<'_, v8::Value>,
    ty: &str,
    old_open: bool,
    new_open: bool,
    source: v8::Local<'_, v8::Value>,
    cancelable: bool,
) -> Option<bool> {
    let ty = v8::String::new(scope, ty)?.into();
    let [old, new, cancelable] = [old_open, new_open, cancelable].map(|b| v8::Boolean::new(scope, b).into());
    let answer = crate::dom::call_host_step(scope, "fireToggleEvent", &[target, ty, old, new, source, cancelable])?;
    Some(answer.is_true())
}
// …the `beforetoggle` of `el`'s change, opening it (`opening`) or closing it.
pub(crate) fn fire_before_toggle(scope: &mut v8::PinScope<'_, '_>, el: NodeId, opening: bool, source: Option<NodeId>) -> Option<bool> {
    let target = crate::dom::node_value(scope, Some(el));
    let source = crate::dom::node_value(scope, source);
    fire_toggle_event(scope, target, "beforetoggle", !opening, opening, source, opening)
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "queueToggleTask", queue_toggle_task_op, context_id);
}

// __dom.queueToggleTask(element, oldOpen, newOpen) — a details element's toggle task queued (`queue_toggle_task`), its
// `open` attribute come or gone, or an open-ui combobox's datalist shown or hidden as its popover.
fn queue_toggle_task_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(el) = crate::node_handle::nid_of(scope, args.get(0)) else { return };
    let (old_open, new_open) = (args.get(1).is_true(), args.get(2).is_true());
    queue_toggle_task(scope, el, Tracker::Element, old_open, new_open, None);
}
