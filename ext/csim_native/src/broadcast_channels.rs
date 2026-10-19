// BroadcastChannels (HTML §9.5): every channel of the isolate, every realm's — its realm, its name, the origin it is
// scoped to (its KEY: a tuple origin's serialization, an opaque one's token), whether it is closed — in the order the
// channels were made, which is the order a post reaches them in ("sorted by creation"). The isolate's (its `Dom`): a
// post in a frame reaches the page's channels as its own, and an inbound one, another window's or a worker's, reaches
// every realm's.
//
// A channel's object is held weakly: one nothing holds receives nothing, and is let go of as the registry grows. What
// stays with the bindings (broadcast-channel.js) is what is a call or a value — the serialized message, the task each
// delivery is, the event — and with the host the queue a post across realms of the isolate is delivered from, in this
// order, and the windows and workers beyond the isolate.

use std::collections::{BTreeMap, HashMap};

use crate::dom::{dom, realm_id, register};

struct Channel {
    realm: i32,
    closed: bool,
    object: v8::Weak<v8::Value>,
}

#[derive(Default)]
pub(crate) struct BroadcastChannels {
    next: u64,
    // (…in creation order, which its numbers are)
    of: BTreeMap<u64, Channel>,
    // The channels of each name and origin key, in creation order: what a post looks up.
    by_key: HashMap<(String, String), Vec<u64>>,
    // The size at which the next sweep lets go of the channels nothing holds: twice what the last one left.
    sweep_at: usize,
}

impl BroadcastChannels {
    // The channels a post to `name` of `origin_key` reaches, in creation order: every open one but the poster — and,
    // where `except_id` is 0, but every channel of `except_realm` (a realm another window's or a worker's post came
    // through); -1 a realm none is of.
    // (…the poster by its number, unique in the isolate, whichever realm's method posted)
    fn targets(&self, name: &str, origin_key: &str, except_realm: i32, except_id: u64) -> Vec<(i32, u64)> {
        let Some(ids) = self.by_key.get(&(name.to_owned(), origin_key.to_owned())) else { return Vec::new() };
        ids.iter()
            .filter_map(|id| Some((*id, self.of.get(id)?)))
            .filter(|(id, c)| {
                !c.closed && !c.object.is_empty() && *id != except_id && !(except_id == 0 && c.realm == except_realm)
            })
            .map(|(id, c)| (c.realm, id))
            .collect()
    }
    // Keep the channels `keep` says, the others let go of.
    fn retain(&mut self, keep: impl Fn(&Channel) -> bool) {
        self.of.retain(|_, c| keep(c));
        let of = &self.of;
        self.by_key.retain(|_, ids| {
            ids.retain(|id| of.contains_key(id));
            !ids.is_empty()
        });
    }
    // A realm's channels, gone with it — its page left, the session reset, its frame removed: a page that reuses its
    // realm (the main one's) never reaches a channel of the one before.
    pub(crate) fn drop_realm(&mut self, cid: i32) {
        self.retain(|c| c.realm != cid);
    }
    // The isolate's slots go after V8 has disposed it, and a weak handle's drop resets its node, freed memory by then:
    // let go of whole (as the Dom's other weak handles are).
    pub(crate) fn leak_weak_handles(&mut self) {
        std::mem::forget(std::mem::take(&mut self.of));
        self.by_key.clear();
    }
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    register(scope, ns, "bcNew", new_op, context_id);
    register(scope, ns, "bcClose", close_op, context_id);
    register(scope, ns, "bcTargets", targets_op, context_id);
    register(scope, ns, "bcChannel", channel_op, context_id);
    register(scope, ns, "bcState", state_op, context_id);
}

fn id_arg(scope: &mut v8::PinScope<'_, '_>, v: v8::Local<'_, v8::Value>) -> u64 {
    v.number_value(scope).map_or(0, |n| n as u64)
}

// __dom.bcNew(channel, name, originKey) -> the number of `channel`, a new open one of the calling realm's, of that name and
// origin.
fn new_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let object = v8::Weak::new(scope, args.get(0));
    let realm = realm_id(scope, &args);
    let name = args.get(1).to_rust_string_lossy(scope);
    let origin_key = args.get(2).to_rust_string_lossy(scope);
    let channels = &mut dom(scope).broadcast_channels;
    if channels.of.len() >= channels.sweep_at.max(64) {
        channels.retain(|c| !c.closed && !c.object.is_empty());
        channels.sweep_at = channels.of.len() * 2;
    }
    channels.next += 1;
    let id = channels.next;
    channels.by_key.entry((name, origin_key)).or_default().push(id);
    channels.of.insert(id, Channel { realm, closed: false, object });
    rv.set_double(id as f64);
}
// __dom.bcClose(id): the channel closed — it receives nothing, a delivery queued for it before included.
fn close_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let id = id_arg(scope, args.get(0));
    if let Some(c) = dom(scope).broadcast_channels.of.get_mut(&id) {
        c.closed = true;
    }
}
// __dom.bcTargets(name, originKey, exceptRealm, exceptId) -> the channels a post reaches, in creation order, each its
// realm and its number: [realm, id, realm, id, …].
fn targets_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let name = args.get(0).to_rust_string_lossy(scope);
    let origin_key = args.get(1).to_rust_string_lossy(scope);
    let except_realm = args.get(2).int32_value(scope).unwrap_or(-1);
    let except_id = id_arg(scope, args.get(3));
    let targets = dom(scope).broadcast_channels.targets(&name, &origin_key, except_realm, except_id);
    let flat: Vec<f64> = targets.into_iter().flat_map(|(realm, id)| [f64::from(realm), id as f64]).collect();
    rv.set(crate::dom::f64_array(scope, &flat).into());
}
// __dom.bcState(id) -> 1 for an open channel, 2 for a closed one, 0 for one its realm took with it (a detached frame's,
// whose posts reach no one and throw nothing).
fn state_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let id = id_arg(scope, args.get(0));
    rv.set_int32(dom(scope).broadcast_channels.of.get(&id).map_or(0, |c| if c.closed { 2 } else { 1 }));
}
// __dom.bcChannel(id) -> the channel a delivery is for, or null where it is closed or gone since the post.
fn channel_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let id = id_arg(scope, args.get(0));
    let channels = std::mem::take(&mut dom(scope).broadcast_channels);
    let object = channels.of.get(&id).filter(|c| !c.closed).and_then(|c| c.object.to_local(scope));
    dom(scope).broadcast_channels = channels;
    match object {
        Some(o) => rv.set(o),
        None => rv.set_null(),
    }
}
