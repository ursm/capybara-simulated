// Close requests and close watchers (HTML §6.10): each Window's close watcher manager — its groups of close watchers, the
// last the one a close request goes through, how many groups it allows and whether the next user activation lets it
// allow one more — and the watchers themselves: a modal or open dialog's, an auto or hint popover's and a script's
// `CloseWatcher`'s, each with its cancel action, close action and enabled state as its owner gives them. A request to
// close one runs its cancel action (a cancelable `cancel` where it may prevent the close), then — not prevented, and still
// active and enabled — destroys it and runs its close action (a dialog closed, a popover hidden, a `close` fired). The
// actions' events are the bindings' (`hostSteps.fireSimpleEvent`); everything they decide is here.

use std::collections::HashMap;

use crate::dom::{dom, realm_id, NodeId, RealmArena};

// Who a close watcher is of: what its actions do.
#[derive(Clone)]
pub(crate) enum Owner {
    // A dialog's (HTML "set the dialog close watcher"): cancel fires `cancel` at it, close closes it with its request close
    // return value and source; enabled while a request to close it enables it, or its computed closed-by state is not None.
    Dialog(NodeId),
    // An auto or hint popover's (HTML "show popover"): cancel goes on, close hides it; always enabled.
    Popover(NodeId),
    // A `CloseWatcher` object's: cancel fires `cancel` at it, close fires `close`; always enabled.
    Script(v8::Global<v8::Object>),
}

struct Watcher {
    owner: Owner,
    running_cancel: bool,
}

// A Window's close watcher manager, and its watchers by number (the isolate's count: `RealmArena::close_watcher_ids`).
pub(crate) struct Manager {
    groups: Vec<Vec<u64>>,
    allowed: usize,
    next_allows: bool,
    watchers: HashMap<u64, Watcher>,
}

impl Default for Manager {
    fn default() -> Self {
        Manager { groups: Vec::new(), allowed: 1, next_allows: true, watchers: HashMap::new() }
    }
}

impl Manager {
    // HTML "notify the close watcher manager about user activation": one more group allowed, where a close watcher was
    // established since the last user activation (or none came yet).
    pub(crate) fn notify_user_activation(&mut self) {
        if self.next_allows {
            self.allowed += 1;
        }
        self.next_allows = false;
    }
    // Whether watcher `id` is active: in one of its manager's groups.
    fn active(&self, id: u64) -> bool {
        self.groups.iter().any(|g| g.contains(&id))
    }
    // HTML "destroy a close watcher": out of its group, an emptied group gone.
    fn destroy(&mut self, id: u64) {
        for group in &mut self.groups {
            group.retain(|&w| w != id);
        }
        self.groups.retain(|g| !g.is_empty());
        self.watchers.remove(&id);
    }
    // Whether a request to close one of its watchers that requires history-action activation may still be prevented:
    // fewer groups than it allows, and its window has that activation.
    fn grants_prevention(&self, history_action: bool) -> bool {
        self.groups.len() < self.allowed && history_action
    }
}

impl RealmArena {
    // HTML "establish a close watcher" in realm `realm`'s Window for `owner`: a group of its own where the manager allows
    // one more, else in its last group. (The caller has seen the Window's document is fully active.)
    pub(crate) fn establish_close_watcher(&mut self, realm: i32, owner: Owner) -> Option<u64> {
        self.close_watcher_ids += 1;
        let id = self.close_watcher_ids;
        let manager = &mut self.realm_state_mut(realm)?.close_watchers;
        if manager.groups.len() < manager.allowed {
            manager.groups.push(vec![id]);
        } else if let Some(last) = manager.groups.last_mut() {
            last.push(id);
        }
        manager.next_allows = true;
        manager.watchers.insert(id, Watcher { owner, running_cancel: false });
        Some(id)
    }
    // …destroyed.
    pub(crate) fn destroy_close_watcher(&mut self, realm: i32, id: u64) {
        if let Some(state) = self.realm_state_mut(realm) {
            state.close_watchers.destroy(id);
        }
    }
    // An element's close watcher — a dialog's, a popover's — and the Window it is of, set as it is established and taken
    // as it is destroyed.
    pub(crate) fn set_element_close_watcher(&mut self, el: NodeId, realm: i32, owner: Owner) {
        if let Some(id) = self.establish_close_watcher(realm, owner) {
            self.element_watchers.insert(el, (realm, id));
        }
    }
    pub(crate) fn destroy_element_close_watcher(&mut self, el: NodeId) {
        if let Some((realm, id)) = self.element_watchers.remove(&el) {
            self.destroy_close_watcher(realm, id);
        }
    }
    // Watcher `id`'s owner, while it is active in realm `realm`'s Window.
    fn active_owner(&self, realm: i32, id: u64) -> Option<Owner> {
        let manager = &self.realm_state(realm)?.close_watchers;
        manager.active(id).then(|| manager.watchers.get(&id).map(|w| w.owner.clone())).flatten()
    }
    // A close watcher's "get enabled state".
    fn watcher_enabled(&self, owner: &Owner) -> bool {
        match *owner {
            Owner::Dialog(dialog) => self.dialog_watcher_enabled(dialog),
            Owner::Popover(_) | Owner::Script(_) => true,
        }
    }
    fn set_running_cancel(&mut self, realm: i32, id: u64, on: bool) {
        if let Some(watcher) = self.realm_state_mut(realm).and_then(|s| s.close_watchers.watchers.get_mut(&id)) {
            watcher.running_cancel = on;
        }
    }
    // HTML "consume history-action user activation" for realm `realm`'s Window: every Window of its top-level traversable's
    // tree loses it.
    fn consume_history_action(&mut self, realm: i32) {
        let top = self.top_level_realm(realm);
        let mut windows = vec![top];
        windows.extend(self.descendant_realms(top));
        for window in windows {
            if let Some(state) = self.realm_state_mut(window) {
                state.history_action = false;
            }
        }
    }
}

// The cancel action of `owner`'s watcher, `cancelable` where it may prevent the close: whether the close goes on (None: a
// script was terminated).
fn cancel_action(scope: &mut v8::PinScope<'_, '_>, owner: &Owner, cancelable: bool) -> Option<bool> {
    let target = match owner {
        Owner::Popover(_) => return Some(true),
        Owner::Dialog(dialog) => crate::dom::node_value(scope, Some(*dialog)),
        Owner::Script(object) => v8::Local::new(scope, object).into(),
    };
    fire_simple_event(scope, target, "cancel", cancelable)
}
// …and its close action.
fn close_action(scope: &mut v8::PinScope<'_, '_>, owner: &Owner) -> Option<()> {
    match owner {
        Owner::Dialog(dialog) => {
            let (return_value, source) = dom(scope).arena.dialog_request(*dialog);
            crate::dialogs::close_the_dialog(scope, *dialog, return_value, source)
        }
        Owner::Popover(popover) => crate::popovers::hide_popover(scope, *popover, true, true, false, None).or_terminated(),
        Owner::Script(object) => {
            let target = v8::Local::new(scope, object).into();
            fire_simple_event(scope, target, "close", false).map(drop)
        }
    }
}

// HTML "fire an event" named `ty` at `target` — a node, a `CloseWatcher` — with its `cancelable`: whether it was not
// canceled (None: a script was terminated).
pub(crate) fn fire_simple_event(scope: &mut v8::PinScope<'_, '_>, target: v8::Local<'_, v8::Value>, ty: &str, cancelable: bool) -> Option<bool> {
    let ty = v8::String::new(scope, ty)?.into();
    let cancelable = v8::Boolean::new(scope, cancelable).into();
    let answer = crate::dom::call_host_step(scope, "fireSimpleEvent", &[target, ty, cancelable])?;
    Some(answer.is_true())
}

// HTML "request to close" watcher `id` of realm `realm`'s Window, `require_history` where the request is a user's (a close
// request): whether it went on to close — false where its cancel action prevented it (None: a script was terminated).
pub(crate) fn request_to_close(scope: &mut v8::PinScope<'_, '_>, realm: i32, id: u64, require_history: bool) -> Option<bool> {
    let arena = &mut dom(scope).arena;
    let Some(owner) = arena.active_owner(realm, id) else { return Some(true) };
    let running = arena.realm_state(realm).is_some_and(|s| s.close_watchers.watchers.get(&id).is_some_and(|w| w.running_cancel));
    if !arena.watcher_enabled(&owner) || running || !arena.navigables.fully_active(realm) {
        return Some(true);
    }
    arena.set_running_cancel(realm, id, true);
    let state = arena.realm_state(realm);
    let cancelable = !require_history || state.is_some_and(|s| s.close_watchers.grants_prevention(s.history_action));
    let goes_on = cancel_action(scope, &owner, cancelable);
    dom(scope).arena.set_running_cancel(realm, id, false);
    if !goes_on? {
        dom(scope).arena.consume_history_action(realm);
        return Some(false);
    }
    close(scope, realm, id)?;
    Some(true)
}

// HTML "close" watcher `id`: where it is still active and enabled and its Window's document fully active, destroyed and
// its close action run.
pub(crate) fn close(scope: &mut v8::PinScope<'_, '_>, realm: i32, id: u64) -> Option<()> {
    let arena = &mut dom(scope).arena;
    let Some(owner) = arena.active_owner(realm, id) else { return Some(()) };
    if !arena.watcher_enabled(&owner) || !arena.navigables.fully_active(realm) {
        return Some(());
    }
    arena.destroy_close_watcher(realm, id);
    if let Owner::Dialog(el) | Owner::Popover(el) = owner {
        arena.element_watchers.remove(&el);
    }
    close_action(scope, &owner)
}

// HTML "process close watchers" for realm `realm`'s Window: the watchers of its last group, the newest first, each asked
// to close as a user's request — one whose cancel prevents it ending the run — and one group fewer allowed after; whether
// any of them was enabled.
pub(crate) fn process_close_watchers(scope: &mut v8::PinScope<'_, '_>, realm: i32) -> Option<bool> {
    let group = dom(scope).arena.realm_state(realm).and_then(|s| s.close_watchers.groups.last().cloned()).unwrap_or_default();
    let mut processed = false;
    for &id in group.iter().rev() {
        let arena = &dom(scope).arena;
        if arena.active_owner(realm, id).is_some_and(|owner| arena.watcher_enabled(&owner)) {
            processed = true;
        }
        if !request_to_close(scope, realm, id, true)? {
            break;
        }
    }
    if let Some(manager) = dom(scope).arena.realm_state_mut(realm).map(|s| &mut s.close_watchers) {
        if manager.allowed > 1 {
            manager.allowed -= 1;
        }
    }
    Some(processed)
}

// A step of the popovers' and dialogs' algorithms that ends early: an exception for the bindings to throw (its code,
// the module's own), or a script terminated under it — whose exception the op ends with.
pub(crate) enum Stop {
    Throw(u32),
    Terminated,
}
pub(crate) trait OrTerminated {
    fn or_terminated(self) -> Option<()>;
}
impl OrTerminated for Result<(), Stop> {
    // …where a step throws nothing (the bindings' own calls): only a termination ends the caller too.
    fn or_terminated(self) -> Option<()> {
        match self {
            Err(Stop::Terminated) => None,
            _ => Some(()),
        }
    }
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "closeWatcherNew", new_op, context_id);
    crate::dom::register(scope, ns, "closeWatcherRequestClose", request_close_op, context_id);
    crate::dom::register(scope, ns, "closeWatcherClose", close_op, context_id);
    crate::dom::register(scope, ns, "closeWatcherDestroy", destroy_op, context_id);
    crate::dom::register(scope, ns, "closeRequest", close_request_op, context_id);
}

// __dom.closeWatcherNew(watcher) -> the number of the close watcher a `CloseWatcher` is made with (its constructor's
// "establish a close watcher" in the calling realm's Window), or -1 where that Window's document is not fully active.
fn new_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Ok(object) = v8::Local::<v8::Object>::try_from(args.get(0)) else { return rv.set_double(-1.0) };
    let realm = realm_id(scope, &args);
    let owner = Owner::Script(v8::Global::new(scope, object));
    let arena = &mut dom(scope).arena;
    let id = arena.navigables.fully_active(realm).then(|| arena.establish_close_watcher(realm, owner)).flatten();
    rv.set_double(id.map_or(-1.0, |id| id as f64));
}
// The realm and number of a `CloseWatcher`'s close watcher, as its method passes them.
fn watcher_arg(scope: &mut v8::PinScope<'_, '_>, args: &v8::FunctionCallbackArguments<'_>) -> (i32, u64) {
    let realm = args.get(0).int32_value(scope).unwrap_or(-1);
    let id = args.get(1).integer_value(scope).unwrap_or(0) as u64;
    (realm, id)
}
// __dom.closeWatcherRequestClose(realm, id) — its `requestClose()`: HTML "request to close", not a user's.
fn request_close_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let (realm, id) = watcher_arg(scope, &args);
    request_to_close(scope, realm, id, false);
}
// __dom.closeWatcherClose(realm, id) — its `close()`.
fn close_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let (realm, id) = watcher_arg(scope, &args);
    close(scope, realm, id);
}
// __dom.closeWatcherDestroy(realm, id) — its `destroy()`, or its signal's abort.
fn destroy_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let (realm, id) = watcher_arg(scope, &args);
    dom(scope).arena.destroy_close_watcher(realm, id);
}
// __dom.closeRequest(document) — a user's close request (the Escape key, its keydown not canceled) to a document: HTML's
// close request steps from "If document is not fully active", processing its Window's close watchers.
fn close_request_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(doc) = crate::node_handle::nid_of(scope, args.get(0)) else { return };
    let arena = &dom(scope).arena;
    let Some(realm) = arena.get(doc).map(|d| d.realm).filter(|_| arena.document_fully_active(doc)) else { return };
    process_close_watchers(scope, realm);
}
