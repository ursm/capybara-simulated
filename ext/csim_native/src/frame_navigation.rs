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
    // The container's `sandbox` attribute as its attributes were processed — what the document the navigation they
    // began makes is sandboxed by (HTML "navigate": its sandboxing flags snapshot), whatever the attribute says by the
    // time its response is in; none where it had none.
    sandbox: Option<Option<String>>,
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
    // While its navigable has no realm made: the user activation the window of its initial about:blank document has
    // had (user_activation.rs) — its last activation, on the container's realm's clock, and the activation notifications
    // that reached it — which that window takes as its realm is made (navigables.rs `set_frame_realm`).
    activation: Option<(f64, u32)>,
}

// A scripted navigation's response awaited (frame-nav.js `FN_NAV_PENDING`): what a plan superseded clears.
const NAV_PENDING: u32 = 1 << 1;
// The navigation is a reload (frame-nav.js `FN_RELOAD_NAV`).
const RELOAD_NAV: u32 = 1 << 5;
// Its post-insertion step ran: its navigable exists (frame-nav.js `FN_CONTEXT_READY`).
const CONTEXT_READY: u32 = 1 << 6;
// Its `src` refused as its attributes were last processed (frame-nav.js `FN_SRC_REFUSED`, `process_src`).
const SRC_REFUSED: u32 = 1 << 7;

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
    // The frames in the documents of realms `parents` whose navigables exist but have no realm made — an `about:blank`
    // frame no script has looked into — which an activation of those documents reaches all the same.
    pub(crate) fn unbuilt_frames(&self, parents: &[i32]) -> Vec<NodeId> {
        let parents: std::collections::HashSet<i32> = parents.iter().copied().collect();
        let ready = |nav: &FrameNavigation| nav.flags & CONTEXT_READY != 0;
        let in_parents = |c: NodeId| self.get(c).is_some_and(|n| parents.contains(&n.realm));
        self.frame_navigations.0.iter().filter(|&(&c, nav)| ready(nav) && in_parents(c) && self.frame_realm(c).is_none() && self.is_connected(c)).map(|(&c, _)| c).collect()
    }
    // …one more activation notification reaching such a frame's window, its last at `at` on its container's realm's
    // clock…
    pub(crate) fn note_unbuilt_activation(&mut self, container: NodeId, at: f64) {
        let nav = self.frame_navigation(container);
        nav.activation = Some((at, nav.activation.map_or(0, |(_, n)| n) + 1));
    }
    // …its activation consumed (negative infinity), where it had one…
    pub(crate) fn consume_unbuilt_activation(&mut self, container: NodeId) {
        if let Some((at, _)) = self.frame_navigations.0.get_mut(&container).and_then(|nav| nav.activation.as_mut()) {
            *at = f64::NEG_INFINITY;
        }
    }
    // …and what it had, taken as its realm is made.
    pub(crate) fn take_unbuilt_activation(&mut self, container: NodeId) -> Option<(f64, u32)> {
        self.frame_navigations.0.get_mut(&container).and_then(|nav| nav.activation.take())
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
    crate::dom::register(scope, ns, "processFrameSrc", process_frame_src, context_id);
    crate::dom::register(scope, ns, "frameSandbox", frame_sandbox, context_id);
    crate::dom::register(scope, ns, "beginFrameNavigation", begin_frame_navigation, context_id);
    crate::dom::register(scope, ns, "frameSource", frame_source, context_id);
}

// HTML "shared attribute processing steps for iframe and frame elements" step 3, as the frame `container`'s attributes
// are processed — it is inserted, its `src` or `srcdoc` set or removed: whether its `src` names a document a navigable
// among the inclusive ancestors of its node navigable has, fragments aside (`RealmArena::ancestor_document_at`), so that
// the steps return null and it navigates nowhere — no document but the one it has, and no `load`. Not for a frame with
// a `srcdoc`, nor one a navigation already carries a document for (a form's response), nor one in no document (it has
// no navigable); and not where the URL matches about:blank — which an empty or absent `src` is too — though the step
// matches that as well: an iframe in an about:blank document would never load, where Chrome and Firefox load it. (They
// allow one level of a document framing itself, where HTML allows none.)
fn src_nested(arena: &mut crate::dom::RealmArena, container: NodeId) -> bool {
    let carried = arena.frame_navigations.0.get(&container).is_some_and(|nav| nav.contents[CONTENT_NAV].is_some());
    let Some(node) = arena.get(container).filter(|n| !carried && n.plain_attr("srcdoc").is_none()) else { return false };
    let (realm, src) = (node.realm, node.plain_attr("src").unwrap_or_default().to_owned());
    let doc = arena.shadow_including_root(container);
    if src.is_empty() || arena.get(doc).is_none_or(|n| n.kind != crate::dom::NodeKind::Document) {
        return false;
    }
    let Some(url) = arena.parse_document_url(doc, &src) else { return false };
    let about_blank = url.protocol() == "about:" && url.pathname() == "blank";
    !about_blank && arena.ancestor_document_at(realm, url.href())
}
// …as the frame's attributes are processed, which is what its `src` stays refused by until they are again, or a
// navigation of it begins (`SRC_REFUSED`): a build of it made later, on a read, loads none of it — though the ancestors'
// URLs have moved since, or the `src` was set on it while it was in no document.
pub(crate) fn process_src(arena: &mut crate::dom::RealmArena, container: NodeId) -> bool {
    let refused = src_nested(arena, container);
    begin(arena, container);
    let nav = arena.frame_navigation(container);
    if refused {
        nav.flags |= SRC_REFUSED;
    } else {
        nav.flags &= !SRC_REFUSED;
    }
    refused
}
// A navigation of the container begins — its attributes processed, a scripted navigation of it, one its document makes
// of itself: the `sandbox` attribute it has now is what the document it makes is sandboxed by (HTML "navigate", its
// sandboxing flags snapshot), whatever it says by the time the response is in.
fn begin(arena: &mut crate::dom::RealmArena, container: NodeId) {
    let sandbox = arena.get(container).and_then(|n| n.plain_attr("sandbox")).map(str::to_owned);
    arena.frame_navigation(container).sandbox = Some(sandbox);
}
impl crate::dom::RealmArena {
    // The `sandbox` attribute the document the container's navigation makes is sandboxed by: as its navigation began,
    // else as it is (none: none).
    pub(crate) fn frame_sandbox(&self, container: NodeId) -> Option<String> {
        match self.frame_navigations.0.get(&container).and_then(|nav| nav.sandbox.clone()) {
            Some(snapshot) => snapshot,
            None => self.get(container).and_then(|n| n.plain_attr("sandbox")).map(str::to_owned),
        }
    }
}
// __dom.beginFrameNavigation(containerNid) — a navigation of the container begins (`begin`): a scripted one of it, or
// the host's of one its document makes of itself.
fn begin_frame_navigation(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(container) = nid_arg(scope, &args, 0) else { return };
    let cid = realm_id(scope, &args);
    begin(crate::dom::realm(scope, cid), container);
}
// __dom.frameSandbox(containerNid) -> `RealmArena::frame_sandbox` (null: none).
fn frame_sandbox(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(container) = nid_arg(scope, &args, 0) else { return rv.set_null() };
    let cid = realm_id(scope, &args);
    let sandbox = crate::dom::realm(scope, cid).frame_sandbox(container);
    match sandbox.and_then(|s| v8::String::new(scope, &s)) {
        Some(s) => rv.set(s.into()),
        None => rv.set_null(),
    }
}
// __dom.processFrameSrc(containerNid) -> whether `process_src` refused the frame's `src`.
fn process_frame_src(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(container) = nid_arg(scope, &args, 0) else { return rv.set_bool(false) };
    let cid = realm_id(scope, &args);
    rv.set_bool(process_src(crate::dom::realm(scope, cid), container));
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
        // (…its navigable destroyed with its post-insertion step undone — the container removed — and what the window
        // of its initial about:blank document had with it: one inserted again is a new one's)
        if flags & CONTEXT_READY != 0 {
            nav.activation = None;
        }
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

// The slot a scripted navigation's response is carried in (frame-nav.js `FC_NAV`), and the one the document loaded last
// is (`FC_LOADED`).
const CONTENT_NAV: usize = 0;
const CONTENT_LOADED: usize = 1;

// What a frame's document is loaded from (`__dom.frameSource`, bridge.entry.js `FRAME_SOURCE_*`): a scripted
// navigation's response, its `srcdoc`, no URL (the initial about:blank), or a URL of a scheme: about:, data:,
// javascript:, blob:, or one fetched.
const SOURCE_NAVIGATION: i32 = 0;
const SOURCE_SRCDOC: i32 = 1;
const SOURCE_NONE: i32 = 2;
const SOURCE_ABOUT: i32 = 3;
const SOURCE_DATA: i32 = 4;
const SOURCE_JAVASCRIPT: i32 = 5;
const SOURCE_BLOB: i32 = 6;
const SOURCE_FETCH: i32 = 7;

// __dom.frameSource(container) -> where a build of the frame's document loads it from (HTML "process the iframe
// attributes"), its reload flag and the document URL a reload keeps taken as it begins — whichever branch it takes, so
// neither leaks to a later load:
// - [SOURCE_NAVIGATION, reload, url, bytes, contentType]: a scripted navigation's response (a form submitted into it),
//   taken, and kept as the document loaded last, which a reload loads again;
// - [SOURCE_SRCDOC, reload, srcdoc];
// - [kind, reload, url] for the URL it navigates to: a reload's kept URL, else the one its navigation started with, else
//   its `src` — none (SOURCE_NONE) where that is none, empty or about:blank, refused as its attributes were last
//   processed, or no URL its document parses; else by its scheme.
fn frame_source(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    // (…a node the engine holds no slot for none: the initial about:blank)
    let none = |scope: &mut v8::PinScope<'_, '_>, mut rv: v8::ReturnValue<'_, v8::Value>, reload: bool| {
        let (kind, reload, url) = (v8::Integer::new(scope, SOURCE_NONE).into(), v8::Boolean::new(scope, reload).into(), v8::String::empty(scope).into());
        rv.set(v8::Array::new_with_elements(scope, &[kind, reload, url]).into());
    };
    let Some(container) = crate::node_handle::nid_of(scope, args.get(0)) else { return none(scope, rv, false) };
    let doc = crate::node_handle::handle_of(scope, args.get(0))
        // SAFETY: the handle lives while the object, an argument, does.
        .and_then(|ptr| unsafe { ptr.as_ref() }.document(scope))
        .and_then(|d| crate::node_handle::nid_of(scope, d.into()));
    let cid = realm_id(scope, &args);
    let arena = crate::dom::realm(scope, cid);
    let nav = arena.frame_navigation(container);
    let reload = nav.flags & RELOAD_NAV != 0;
    nav.flags &= !RELOAD_NAV;
    let kept = nav.reload.take();
    let reload_url = kept.filter(|_| reload);
    if let Some(content) = nav.contents[CONTENT_NAV].take() {
        nav.contents[CONTENT_LOADED] = Some(content.clone());
        let url = utf16_value(scope, &content.url);
        let bytes = crate::dom::u8_array(scope, content.bytes);
        let content_type = utf16_value(scope, &content.content_type);
        let (kind, reload) = (v8::Integer::new(scope, SOURCE_NAVIGATION).into(), v8::Boolean::new(scope, reload).into());
        return rv.set(v8::Array::new_with_elements(scope, &[kind, reload, url, bytes, content_type]).into());
    }
    let started = nav.src.clone();
    let refused = nav.flags & SRC_REFUSED != 0;
    let Some(node) = arena.get(container) else { return none(scope, rv, reload) };
    if let Some(srcdoc) = node.plain_attr("srcdoc").map(str::to_owned) {
        let (kind, reload) = (v8::Integer::new(scope, SOURCE_SRCDOC).into(), v8::Boolean::new(scope, reload).into());
        let srcdoc = v8::String::new(scope, &srcdoc).map_or_else(|| v8::undefined(scope).into(), Into::into);
        return rv.set(v8::Array::new_with_elements(scope, &[kind, reload, srcdoc]).into());
    }
    // (…a reload's URL, else the one its navigation started with, else its `src` — that refused by its attributes'
    // processing none, but not a reload's nor that of a navigation under way, which a refused change leaves to go on)
    let src = match (&reload_url, &started) {
        (Some(url), _) => Some(String::from_utf16_lossy(url)),
        (None, Some(started)) => started.as_ref().map(|u| String::from_utf16_lossy(u)),
        (None, None) if refused => None,
        (None, None) => node.plain_attr("src").map(str::to_owned),
    };
    let root = arena.root_of(container);
    let doc = doc.or_else(|| arena.get(root).is_some_and(|n| n.kind == crate::dom::NodeKind::Document).then_some(root));
    let url = src.filter(|s| !s.is_empty() && s != "about:blank").zip(doc).and_then(|(s, doc)| arena.parse_document_url(doc, &s));
    let (kind, url) = match url {
        None => (SOURCE_NONE, String::new()),
        Some(url) => {
            let kind = match url.protocol() {
                "about:" => SOURCE_ABOUT,
                "data:" => SOURCE_DATA,
                "javascript:" => SOURCE_JAVASCRIPT,
                "blob:" => SOURCE_BLOB,
                _ => SOURCE_FETCH,
            };
            (kind, url.href().to_owned())
        }
    };
    let (kind, reload) = (v8::Integer::new(scope, kind).into(), v8::Boolean::new(scope, reload).into());
    let url = v8::String::new(scope, &url).map_or_else(|| v8::undefined(scope).into(), Into::into);
    rv.set(v8::Array::new_with_elements(scope, &[kind, reload, url]).into());
}

// __dom.frameBuildsEagerly(container, allHostsLocal) -> whether a frame container's document is built as it connects,
// not when its `contentWindow` is first read: one a navigation carries a response for, a `srcdoc` one, and one whose URL
// — the one its navigation started with, else its `src` — is a document of its own to run: a data:, blob: or
// javascript: URL (whose script may call back into its parent unasked), or a URL of the origin the document was served
// from (`served_origin` — a sandboxed document's opaque origin makes its own host no other one). An about: URL, an empty
// one and one that does not parse are an empty document, lazy. One of another origin genuinely loads in a browser and
// runs its scripts — which can post its parent a message the parent never asked for — but is built eagerly only where
// every host is served in-process (`allHostsLocal`, the WPT runner's): an app's external embed is not run as the app's
// own page in the frame.
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
    let origin = arena.served_origin(cid);
    let Some(url) = arena.parse_document_url(doc, s) else { return };
    rv.set_bool(url.origin() == origin || all_hosts_local);
}
