// A frame container's navigation as it goes (HTML §7.4 "navigate", the iframe's "process the iframe attributes" and
// its load event steps): where each one is — its element's `load` fired for it or owed, a scripted navigation's
// response awaited, the old document waiting to be unloaded as the new one's response comes in, a build parked on an
// activating service worker or under way, a reload — which navigation is the container's latest (a load a superseded
// one queued fires for nothing), the URLs it carries — the one it started with, the session history entry it pushes as
// it commits, the document URL a reload keeps — and the documents it carries as bytes: a scripted navigation's
// response the build loads, the one it loaded last (which a reload of a revoked blob: URL loads again), and a blob:
// URL's a `location` navigation took a reference to before the page could revoke it. The container's, whatever
// document it is in or whether it is in one: a frame moved keeps its navigation.

use std::collections::HashMap;

use crate::dom::{nid_arg, realm_id, utf16_arg, utf16_value, NodeId, RealmArena};

// The flags (`__dom.frameNav`) are the bindings' (`frame-nav.js`, which says what each means): a word this side keeps
// for them, a container's navigation's state where the container's other state is.

// The URLs a navigation carries (`__dom.frameNavUrl`).
const URL_SRC: i32 = 0;
const URL_HISTORY: i32 = 1;
const URL_RELOAD: i32 = 2;

// The documents a navigation carries (`__dom.frameContent`), by slot (frame-nav.js `FC_*`): a scripted navigation's
// response, the one loaded last, a blob: URL's a `location` navigation took.
const CONTENT_SLOTS: usize = 3;

// A document as bytes: its URL, its body, its content type.
#[derive(Clone)]
struct Content {
    url: Vec<u16>,
    bytes: Vec<u8>,
    content_type: Vec<u16>,
}

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
    // The form submission the container's navigable plans to navigate to (HTML "plan to navigate": one pending
    // navigation per navigable, a later one replacing it), by the number `planFrameNavigation` gave it — 0 for none.
    planned: u32,
    contents: [Option<Content>; CONTENT_SLOTS],
}

// A scripted navigation's response awaited (frame-nav.js `FN_NAV_PENDING`): what a plan superseded clears.
const NAV_PENDING: u32 = 1 << 1;

#[derive(Default)]
pub(crate) struct FrameNavigations(HashMap<NodeId, FrameNavigation>, Plans);

// The plans' numbers, and each form's last one with the container it plans for: an interactive submission supersedes
// its form's last plan on whichever navigable it was for.
#[derive(Default)]
struct Plans {
    next: u32,
    last: HashMap<NodeId, (u32, NodeId)>,
}

impl FrameNavigations {
    pub(crate) fn is_empty(&self) -> bool {
        self.0.is_empty() && self.1.last.is_empty()
    }
    // The container — or a form — freed: its navigation let go of with it.
    pub(crate) fn forget(&mut self, container: NodeId) {
        self.0.remove(&container);
        self.1.last.remove(&container);
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
        let freed: Vec<NodeId> = self.frame_navigations.1.last.keys().copied().filter(|&f| self.get(f).is_none()).collect();
        for form in freed {
            self.frame_navigations.1.last.remove(&form);
        }
    }
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "frameBuildsEagerly", frame_builds_eagerly, context_id);
    crate::dom::register(scope, ns, "frameNav", frame_nav, context_id);
    crate::dom::register(scope, ns, "setFrameNav", set_frame_nav, context_id);
    crate::dom::register(scope, ns, "frameNavGeneration", frame_nav_generation, context_id);
    crate::dom::register(scope, ns, "supersedeFrameNav", supersede_frame_nav, context_id);
    crate::dom::register(scope, ns, "frameNavUrl", frame_nav_url, context_id);
    crate::dom::register(scope, ns, "setFrameNavUrl", set_frame_nav_url, context_id);
    crate::dom::register(scope, ns, "frameLoadedAt", frame_loaded_at, context_id);
    crate::dom::register(scope, ns, "setFrameLoadedAt", set_frame_loaded_at, context_id);
    crate::dom::register(scope, ns, "planFrameNavigation", plan_frame_navigation, context_id);
    crate::dom::register(scope, ns, "landFrameNavigation", land_frame_navigation, context_id);
    crate::dom::register(scope, ns, "cancelFrameNavigation", cancel_frame_navigation, context_id);
    crate::dom::register(scope, ns, "frameContent", frame_content, context_id);
    crate::dom::register(scope, ns, "setFrameContent", set_frame_content, context_id);
    crate::dom::register(scope, ns, "frameContentHeld", frame_content_held, context_id);
    crate::dom::register(scope, ns, "frameContentUrl", frame_content_url, context_id);
    crate::dom::register(scope, ns, "copyFrameContent", copy_frame_content, context_id);
}

// __dom.frameContentUrl(containerNid, slot) -> the URL of the document the navigation carries in `slot`, or null.
fn frame_content_url(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(container) = nid_arg(scope, &args, 0) else { return rv.set_null() };
    let slot = args.get(1).uint32_value(scope).unwrap_or(u32::MAX) as usize;
    let cid = realm_id(scope, &args);
    let url = crate::dom::realm(scope, cid).frame_navigations.0.get(&container).and_then(|nav| nav.contents.get(slot)?.as_ref()).map(|c| c.url.clone());
    match url {
        Some(url) => rv.set(utf16_value(scope, &url)),
        None => rv.set_null(),
    }
}

// __dom.copyFrameContent(containerNid, from, to, take) — the document the navigation carries in `from` carried in `to`
// too (none there where `from` holds none), its bytes copied where they lie; taken (`take`): carried in `from` no more.
fn copy_frame_content(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(container) = nid_arg(scope, &args, 0) else { return };
    let from = args.get(1).uint32_value(scope).unwrap_or(u32::MAX) as usize;
    let to = args.get(2).uint32_value(scope).unwrap_or(u32::MAX) as usize;
    let take = args.get(3).is_true();
    if from >= CONTENT_SLOTS || to >= CONTENT_SLOTS || from == to {
        return;
    }
    let cid = realm_id(scope, &args);
    let arena = crate::dom::realm(scope, cid);
    let Some(nav) = arena.frame_navigations.0.get_mut(&container) else { return };
    nav.contents[to] = if take { nav.contents[from].take() } else { nav.contents[from].clone() };
}

// __dom.frameContentHeld(containerNid, slot) -> whether the navigation carries a document in `slot` (its bytes copied
// nowhere).
fn frame_content_held(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(container) = nid_arg(scope, &args, 0) else { return rv.set_bool(false) };
    let slot = args.get(1).uint32_value(scope).unwrap_or(u32::MAX) as usize;
    let cid = realm_id(scope, &args);
    let held = crate::dom::realm(scope, cid).frame_navigations.0.get(&container).and_then(|nav| nav.contents.get(slot)).is_some_and(Option::is_some);
    rv.set_bool(held);
}

// __dom.frameContent(containerNid, slot, take) -> the document the navigation carries in `slot` — `[url,
// bytes, contentType]`, its bytes a Uint8Array — or null for none; taken (`take`): carried no more.
fn frame_content(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(container) = nid_arg(scope, &args, 0) else { return rv.set_null() };
    let slot = args.get(1).uint32_value(scope).unwrap_or(u32::MAX) as usize;
    let take = args.get(2).is_true();
    let cid = realm_id(scope, &args);
    let content = crate::dom::realm(scope, cid).frame_navigations.0.get_mut(&container).and_then(|nav| nav.contents.get_mut(slot)).and_then(|c| if take { c.take() } else { c.clone() });
    let Some(content) = content else { return rv.set_null() };
    let url = utf16_value(scope, &content.url);
    let bytes = crate::dom::u8_array(scope, content.bytes);
    let content_type = utf16_value(scope, &content.content_type);
    rv.set(v8::Array::new_with_elements(scope, &[url, bytes, content_type]).into());
}

// __dom.setFrameContent(containerNid, slot, url, bytes, contentType) — the document the navigation carries in `slot`:
// `url`, `bytes` (a Uint8Array) and `contentType`; none where no bytes are given (`setFrameContent(nid, slot)`).
fn set_frame_content(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(container) = nid_arg(scope, &args, 0) else { return };
    let slot = args.get(1).uint32_value(scope).unwrap_or(u32::MAX) as usize;
    if slot >= CONTENT_SLOTS {
        return;
    }
    let content = v8::Local::<v8::ArrayBufferView>::try_from(args.get(3)).ok().map(|view| {
        let mut bytes = vec![0u8; view.byte_length()];
        view.copy_contents(&mut bytes);
        let url = utf16_arg(scope, args.get(2));
        let content_type = utf16_arg(scope, args.get(4));
        Content { url, bytes, content_type }
    });
    let cid = realm_id(scope, &args);
    let arena = crate::dom::realm(scope, cid);
    // (…none carried by a container with no navigation state: nothing to make for it)
    if content.is_none() && !arena.frame_navigations.0.contains_key(&container) {
        return;
    }
    arena.frame_navigation(container).contents[slot] = content;
}

// __dom.planFrameNavigation(containerNid, formNid, interactive) -> the number of the navigation the form's submission
// plans for the container's navigable, replacing the one it had planned — and, for an interactive submission (a submit
// button's, an implicit one — not `form.submit()`), the form's last plan on whichever navigable it was for, whose
// awaited response it awaits no more (form-double-submit; form.submit() to several frames navigates them all).
fn plan_frame_navigation(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let (Some(container), Some(form)) = (nid_arg(scope, &args, 0), nid_arg(scope, &args, 1)) else { return rv.set_uint32(0) };
    let interactive = args.get(2).is_true();
    let cid = realm_id(scope, &args);
    let navs = &mut crate::dom::realm(scope, cid).frame_navigations;
    // (…its plan on this same navigable is replaced below, as any other is)
    if interactive {
        if let Some(&(token, other)) = navs.1.last.get(&form).filter(|&&(_, other)| other != container) {
            if let Some(nav) = navs.0.get_mut(&other).filter(|n| n.planned == token) {
                nav.planned = 0;
                nav.flags &= !NAV_PENDING;
            }
        }
    }
    navs.1.next = navs.1.next.wrapping_add(1).max(1);
    let token = navs.1.next;
    navs.0.entry(container).or_default().planned = token;
    navs.1.last.insert(form, (token, container));
    rv.set_uint32(token);
}

// __dom.landFrameNavigation(containerNid, formNid, token) -> whether the planned navigation is still the container's
// navigable's — its response then the one to load, the plan done.
fn land_frame_navigation(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let (Some(container), Some(form)) = (nid_arg(scope, &args, 0), nid_arg(scope, &args, 1)) else { return rv.set_bool(false) };
    let token = args.get(2).uint32_value(scope).unwrap_or(0);
    let cid = realm_id(scope, &args);
    let navs = &mut crate::dom::realm(scope, cid).frame_navigations;
    let Some(nav) = navs.0.get_mut(&container).filter(|n| token != 0 && n.planned == token) else { return rv.set_bool(false) };
    nav.planned = 0;
    if navs.1.last.get(&form).is_some_and(|&(t, _)| t == token) {
        navs.1.last.remove(&form);
    }
    rv.set_bool(true);
}

// __dom.cancelFrameNavigation(containerNid) — another navigation of the container's navigable replaces the one a form
// planned (its `location` set): the form's response, when it comes, loads into nothing.
fn cancel_frame_navigation(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(container) = nid_arg(scope, &args, 0) else { return };
    let cid = realm_id(scope, &args);
    if let Some(nav) = crate::dom::realm(scope, cid).frame_navigations.0.get_mut(&container) {
        nav.planned = 0;
    }
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

// The slot a scripted navigation's response is carried in (frame-nav.js `FC_NAV`).
const CONTENT_NAV: usize = 0;

// __dom.frameBuildsEagerly(container, allHostsLocal) -> whether a frame container's document is built as it connects,
// not when its `contentWindow` is first read: one a navigation carries a response for, a `srcdoc` one, and one whose URL
// — the one its navigation started with, else its `src` — is a document of its own to run: a data:, blob: or
// javascript: URL (whose script may call back into its parent unasked), or a URL of the document's own origin. An
// about: URL, an empty one and one that does not parse are an empty document, lazy. One of another origin genuinely
// loads in a browser and runs its scripts — which can post its parent a message the parent never asked for — but is
// built eagerly only where every host is served in-process (`allHostsLocal`, the WPT runner's): an app's external
// embed is not run as the app's own page in the frame.
fn frame_builds_eagerly(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    rv.set_bool(false);
    let Some(container) = crate::node_handle::nid_of(scope, args.get(0)) else { return };
    let all_hosts_local = args.get(1).is_true();
    // (…its node document, the one its URL resolves against)
    let doc = crate::node_handle::handle_of(scope, args.get(0))
        // SAFETY: the handle lives while the object, an argument, does.
        .and_then(|ptr| unsafe { ptr.as_ref() }.document(scope))
        .and_then(|d| crate::node_handle::nid_of(scope, d.into()));
    let cid = realm_id(scope, &args);
    let arena = crate::dom::realm(scope, cid);
    let nav = arena.frame_navigations.0.get(&container);
    if nav.is_some_and(|n| n.contents[CONTENT_NAV].is_some()) {
        return rv.set_bool(true);
    }
    let Some(node) = arena.get(container) else { return };
    if node.plain_attr("srcdoc").is_some() {
        return rv.set_bool(true);
    }
    let src = match nav.and_then(|n| n.src.as_ref()) {
        Some(started) => started.as_ref().map(|u| String::from_utf16_lossy(u)),
        None => node.plain_attr("src").map(str::to_owned),
    };
    let Some(src) = src else { return };
    let s = src.trim_matches(|c: char| c.is_whitespace() || c == '\u{FEFF}');
    let scheme = |prefix: &str| s.get(..prefix.len()).is_some_and(|p| p.eq_ignore_ascii_case(prefix));
    if scheme("data:") || scheme("blob:") || scheme("javascript:") {
        return rv.set_bool(true);
    }
    if s.is_empty() || scheme("about:") {
        return;
    }
    // (…a node of the realm's own document keeps none of its own: that document is its tree's root, a frame built only
    // as it is connected)
    let root = arena.root_of(container);
    let Some(doc) = doc.or_else(|| arena.get(root).is_some_and(|n| n.kind == crate::dom::NodeKind::Document).then_some(root)) else { return };
    let origin = arena.location.origin().to_owned();
    let Some(url) = arena.parse_document_url(doc, s) else { return };
    rv.set_bool(url.origin() == origin || all_hosts_local);
}
