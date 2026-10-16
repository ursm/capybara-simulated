// A frame container's navigation as it goes (HTML §7.4 "navigate", the iframe's "process the iframe attributes" and
// its load event steps): where each one is — its element's `load` fired for it or owed, a scripted navigation's
// response awaited, the old document waiting to be unloaded as the new one's response comes in, a build parked on an
// activating service worker or under way, a reload — which navigation is the container's latest (a load a superseded
// one queued fires for nothing), and the URLs it carries: the one it started with, the session history entry it
// pushes as it commits, the document URL a reload keeps. The container's, whatever document it is in or whether it is
// in one: a frame moved keeps its navigation.

use std::collections::HashMap;

use crate::dom::{nid_arg, realm_id, utf16_arg, utf16_value, NodeId, RealmArena};

// The flags (`__dom.frameNav`) are the bindings' (`frame-nav.js`, which says what each means): a word this side keeps
// for them, a container's navigation's state where the container's other state is.

// The URLs a navigation carries (`__dom.frameNavUrl`).
const URL_SRC: i32 = 0;
const URL_HISTORY: i32 = 1;
const URL_RELOAD: i32 = 2;

#[derive(Default)]
struct FrameNavigation {
    flags: u32,
    generation: u32,
    // The URL the navigation started with — the `src` attribute's value then, none where it had none (`Some(None)`):
    // what a beforeunload handler rewriting the attribute does not change.
    src: Option<Option<Vec<u16>>>,
    history: Option<Vec<u16>>,
    reload: Option<Vec<u16>>,
    // When the element's last `load` fired, on the virtual clock: a navigation begun at that same instant waits a
    // nested-timer clamp, so a frame its load handler navigates again on every load is paced, as a network's response
    // paces it (Chrome: ~100 loads a second), rather than running without the clock moving.
    loaded_at: Option<f64>,
}

#[derive(Default)]
pub(crate) struct FrameNavigations(HashMap<NodeId, FrameNavigation>);

impl FrameNavigations {
    pub(crate) fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
    // The container freed: its navigation let go of with it.
    pub(crate) fn forget(&mut self, container: NodeId) {
        self.0.remove(&container);
    }
}

impl RealmArena {
    fn frame_navigation(&mut self, container: NodeId) -> &mut FrameNavigation {
        self.frame_navigations.0.entry(container).or_default()
    }
    // …and those of containers freed with their realm let go of (a realm's nodes are freed together, past `free_node`).
    pub(crate) fn forget_freed_frame_navigations(&mut self) {
        let freed: Vec<NodeId> = self.frame_navigations.0.keys().copied().filter(|&c| self.get(c).is_none()).collect();
        for container in freed {
            self.frame_navigations.0.remove(&container);
        }
    }
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "frameNav", frame_nav, context_id);
    crate::dom::register(scope, ns, "setFrameNav", set_frame_nav, context_id);
    crate::dom::register(scope, ns, "frameNavGeneration", frame_nav_generation, context_id);
    crate::dom::register(scope, ns, "supersedeFrameNav", supersede_frame_nav, context_id);
    crate::dom::register(scope, ns, "frameNavUrl", frame_nav_url, context_id);
    crate::dom::register(scope, ns, "setFrameNavUrl", set_frame_nav_url, context_id);
    crate::dom::register(scope, ns, "frameLoadedAt", frame_loaded_at, context_id);
    crate::dom::register(scope, ns, "setFrameLoadedAt", set_frame_loaded_at, context_id);
}

// __dom.frameLoadedAt(containerNid) -> when the element's last `load` fired, on the virtual clock: -Infinity for none.
fn frame_loaded_at(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(container) = nid_arg(scope, &args, 0) else { return rv.set_double(f64::NEG_INFINITY) };
    let cid = realm_id(scope, &args);
    let at = crate::dom::realm(scope, cid).frame_navigations.0.get(&container).and_then(|n| n.loaded_at);
    rv.set_double(at.unwrap_or(f64::NEG_INFINITY));
}

// __dom.setFrameLoadedAt(containerNid, time) — the element's `load` fires now.
fn set_frame_loaded_at(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(container) = nid_arg(scope, &args, 0) else { return };
    let Some(at) = args.get(1).number_value(scope) else { return };
    let cid = realm_id(scope, &args);
    crate::dom::realm(scope, cid).frame_navigation(container).loaded_at = Some(at);
}

// __dom.frameNav(containerNid) -> the container's navigation flags.
fn frame_nav(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(container) = nid_arg(scope, &args, 0) else { return rv.set_uint32(0) };
    let cid = realm_id(scope, &args);
    rv.set_uint32(crate::dom::realm(scope, cid).frame_navigations.0.get(&container).map_or(0, |n| n.flags));
}

// __dom.setFrameNav(containerNid, flags, on) — sets (`on`) or clears the flags.
fn set_frame_nav(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(container) = nid_arg(scope, &args, 0) else { return };
    let flags = args.get(1).uint32_value(scope).unwrap_or(0);
    let on = args.get(2).boolean_value(scope);
    let cid = realm_id(scope, &args);
    let arena = crate::dom::realm(scope, cid);
    if on {
        arena.frame_navigation(container).flags |= flags;
    } else if let Some(nav) = arena.frame_navigations.0.get_mut(&container) {
        nav.flags &= !flags;
    }
}

// __dom.frameNavGeneration(containerNid) -> which navigation of the container's is its latest.
fn frame_nav_generation(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(container) = nid_arg(scope, &args, 0) else { return rv.set_uint32(0) };
    let cid = realm_id(scope, &args);
    rv.set_uint32(crate::dom::realm(scope, cid).frame_navigations.0.get(&container).map_or(0, |n| n.generation));
}

// __dom.supersedeFrameNav(containerNid) — another navigation of the container's is its latest: the one under way
// superseded, by a navigation of its own or a host's that committed first.
fn supersede_frame_nav(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(container) = nid_arg(scope, &args, 0) else { return };
    let cid = realm_id(scope, &args);
    let nav = crate::dom::realm(scope, cid).frame_navigation(container);
    nav.generation = nav.generation.wrapping_add(1);
}

// __dom.frameNavUrl(containerNid, slot, take) -> the URL the navigation carries in the slot (0 the one it started
// with, 1 the history entry it pushes, 2 the URL a reload keeps): undefined where it carries none — and for the first
// a null where the URL it started with was none — let go of when `take`.
fn frame_nav_url(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(container) = nid_arg(scope, &args, 0) else { return };
    let slot = args.get(1).int32_value(scope).unwrap_or(-1);
    let take = args.get(2).is_true();
    let cid = realm_id(scope, &args);
    let Some(nav) = crate::dom::realm(scope, cid).frame_navigations.0.get_mut(&container) else { return };
    let url = match slot {
        URL_SRC => if take { nav.src.take() } else { nav.src.clone() },
        URL_HISTORY => (if take { nav.history.take() } else { nav.history.clone() }).map(Some),
        URL_RELOAD => (if take { nav.reload.take() } else { nav.reload.clone() }).map(Some),
        _ => None,
    };
    match url {
        None => {}
        Some(None) => rv.set_null(),
        Some(Some(units)) => {
            let value = utf16_value(scope, &units);
            rv.set(value);
        }
    }
}

// __dom.setFrameNavUrl(containerNid, slot, url) — the URL the navigation carries in the slot; undefined for none, and
// for the first a null for a navigation that started with none.
fn set_frame_nav_url(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(container) = nid_arg(scope, &args, 0) else { return };
    let slot = args.get(1).int32_value(scope).unwrap_or(-1);
    let v = args.get(2);
    let url = if v.is_undefined() { None } else if v.is_null() { Some(None) } else { Some(Some(utf16_arg(scope, v))) };
    let cid = realm_id(scope, &args);
    let arena = crate::dom::realm(scope, cid);
    // (…none carried by a container with no navigation state: nothing to make for it)
    if url.is_none() && !arena.frame_navigations.0.contains_key(&container) {
        return;
    }
    let nav = arena.frame_navigation(container);
    match slot {
        URL_SRC => nav.src = url,
        URL_HISTORY => nav.history = url.flatten(),
        URL_RELOAD => nav.reload = url.flatten(),
        _ => {}
    }
}
