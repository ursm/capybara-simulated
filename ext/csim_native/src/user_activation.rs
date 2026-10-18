// User activation (HTML §6.4.3): each Window's last activation timestamp, which an activation-triggering input event
// sets — on its window, its ancestors' and its same-origin descendants' ("activation notification") — and from which
// its window is stickily activated (one was ever set), transiently activated (one was set less than the transient
// activation duration ago) and has it consumed (every window of its top-level traversable's tree set to negative
// infinity). The timestamps are on each window's own clock; the input events, and what an activation-gated API does,
// are the bindings'.

use crate::dom::{realm, realm_id, RealmArena};

// The transient activation duration: Chrome's and Firefox's five seconds.
const TRANSIENT_DURATION: f64 = 5000.0;

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "activationNotify", activation_notify, context_id);
    crate::dom::register(scope, ns, "userActivation", user_activation, context_id);
    crate::dom::register(scope, ns, "consumeActivation", consume_activation, context_id);
}

impl RealmArena {
    // HTML "activation notification steps" for realm `realm`'s document: its window, its ancestor navigables' windows
    // and those of its descendant navigables whose documents are of its origin, each activated now on its clock, and
    // each window's close watcher manager notified (`activations`) — the initial about:blank window of a frame no script
    // has looked into, whose realm is not made yet, among them (frame_navigation.rs `note_unbuilt_activation`): it is of
    // its container's document's origin, unless a sandbox makes it opaque.
    pub(crate) fn activation_notify(&mut self, realm: i32) {
        let mut windows = vec![realm];
        windows.extend(self.ancestor_realms(realm));
        let descendants = self.descendant_realms(realm);
        let same: Vec<i32> = if descendants.is_empty() {
            descendants
        } else {
            let origin = self.origin_key_of(realm);
            descendants.into_iter().filter(|&d| self.origin_key_of(d) == origin).collect()
        };
        let parents: Vec<i32> = std::iter::once(realm).chain(same.iter().copied()).collect();
        for container in self.unbuilt_frames(&parents) {
            if !self.sandboxes_origin(container) {
                let at = self.get(container).and_then(|n| self.realm_state(n.realm)).map_or(0.0, |s| s.clock);
                self.note_unbuilt_activation(container, at);
            }
        }
        windows.extend(same);
        for window in windows {
            if let Some(state) = self.realm_state_mut(window) {
                state.last_activation = Some(state.clock);
                state.activations += 1;
            }
        }
    }
    // …and what the initial about:blank window of a frame takes as its realm `realm` is made, of what it had while its
    // realm was not: the activation notifications, its last activation `at` on its container's realm `parent`'s clock —
    // as long before now on its own.
    pub(crate) fn inherit_activation(&mut self, realm: i32, parent: i32, at: f64, count: u32) {
        let elapsed = self.realm_state(parent).map_or(0.0, |s| s.clock - at);
        let initial = self.realm_state(realm).is_some_and(|s| s.location.href() == "about:blank");
        if let Some(state) = self.realm_state_mut(realm).filter(|_| initial) {
            state.last_activation = Some(state.clock - elapsed);
            state.activations = count;
        }
    }
    fn origin_key_of(&mut self, realm: i32) -> Option<String> {
        self.realm_state_mut(realm).map(|s| s.location.origin_key(realm))
    }
    // Whether the frame `container`'s `sandbox` attribute makes its document's origin opaque (sandbox.rs).
    fn sandboxes_origin(&self, container: crate::dom::NodeId) -> bool {
        crate::sandbox::opaque_origin(None, self.get(container).and_then(|n| n.plain_attr("sandbox")))
    }
    // Whether realm `realm`'s window has transient activation: its last activation timestamp at or before now, less
    // than the transient activation duration ago.
    pub(crate) fn transiently_activated(&self, realm: i32) -> bool {
        self.realm_state(realm).is_some_and(|s| matches!(s.last_activation, Some(t) if s.clock >= t && s.clock < t + TRANSIENT_DURATION))
    }
    // HTML "consume user activation" of realm `realm`'s window: every window of its top-level traversable's inclusive
    // descendant navigables that was ever activated, consumed (negative infinity) — what its having transient activation
    // was, too.
    pub(crate) fn consume_activation(&mut self, realm: i32) -> bool {
        let had = self.transiently_activated(realm);
        let top = std::iter::once(realm).chain(self.ancestor_realms(realm)).last().unwrap_or(realm);
        let mut windows = vec![top];
        windows.extend(self.descendant_realms(top));
        for window in windows {
            if let Some(state) = self.realm_state_mut(window).filter(|s| s.last_activation.is_some()) {
                state.last_activation = Some(f64::NEG_INFINITY);
            }
        }
        had
    }
}

// __dom.activationNotify() — the activation notification steps for the calling realm's document.
fn activation_notify(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    realm(scope, cid).activation_notify(cid);
}

// What `userActivation` asks of a window (navigator.js): whether it has sticky activation, or transient activation.
const STICKY: u32 = 0;
const TRANSIENT: u32 = 1;

// __dom.userActivation(kind) -> whether the calling realm's window has the activation `kind` names.
fn user_activation(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let kind = args.get(0).uint32_value(scope).unwrap_or(u32::MAX);
    let cid = realm_id(scope, &args);
    let arena = realm(scope, cid);
    let active = match kind {
        STICKY => arena.realm_state(cid).is_some_and(|s| s.last_activation.is_some()),
        TRANSIENT => arena.transiently_activated(cid),
        _ => false,
    };
    rv.set_bool(active);
}

// __dom.consumeActivation() -> whether the calling realm's window had transient activation, which is consumed
// (`RealmArena::consume_activation`).
fn consume_activation(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    rv.set_bool(realm(scope, cid).consume_activation(cid));
}
