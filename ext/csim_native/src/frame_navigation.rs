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
pub(crate) struct Content {
    pub(crate) url: Vec<u16>,
    pub(crate) bytes: Vec<u8>,
    pub(crate) content_type: Vec<u16>,
    // The Referer the request it answered sent — the referrer of the document it makes — and the referrer policy it
    // makes it with (a javascript: URL's result its frame's active document's: HTML), each empty for none.
    pub(crate) referrer: Vec<u16>,
    pub(crate) policy: Vec<u16>,
}

#[derive(Default)]
struct FrameNavigation {
    flags: u32,
    // …the turn its build was parked in (`DEFERRED_SW`), its replay's place among the others'.
    deferred_at: u32,
    generation: u32,
    // The URL the navigation started with — the `src` attribute's value then, none where it had none (`Some(None)`):
    // what a beforeunload handler rewriting the attribute does not change.
    src: Option<Option<Vec<u16>>>,
    // The container's `sandbox` attribute as the navigation under way began (`begin`) — what the document it makes is
    // sandboxed by (HTML "navigate": its sandboxing flags snapshot), whatever the attribute says by the time its response
    // is in; none where it had none — taken by the document it makes.
    sandbox: Option<Option<String>>,
    // …and whether its container's document's window had transient activation then (`begin`): HTML's source snapshot
    // params', the navigation's request's user-activation (Fetch's `Sec-Fetch-User`).
    activated: bool,
    history: Option<Vec<u16>>,
    reload: Option<Vec<u16>>,
    // When the element's last `load` fired, on the virtual clock: a navigation begun at that same instant waits a
    // nested-timer clamp, so a frame its load handler navigates again on every load is paced, as a network's response
    // paces it (Chrome: ~100 loads a second), rather than running without the clock moving.
    loaded_at: Option<f64>,
    // The form submission the container's navigable plans to navigate to (HTML "plan to navigate": one pending
    // navigation per navigable, a later one replacing it), by the number `planFrameNavigation` gave it — 0 for none.
    planned: u32,
    // …and the navigation the host plans to make of it, by the order it was planned in (`HostNavigation`).
    host: Option<(u64, HostNavigation)>,
    contents: [Option<Content>; CONTENT_SLOTS],
    // While its navigable has no realm made: the user activation the window of its initial about:blank document has
    // had (user_activation.rs) — its last activation, on the container's realm's clock, and the activation notifications
    // that reached it — which that window takes as its realm is made (navigables.rs `set_frame_realm`).
    activation: Option<(f64, u32)>,
}

// Its element's `load` fired or queued (frame-nav.js `FN_LOAD_FIRED`).
pub(crate) const LOAD_FIRED: u32 = 1 << 0;
// A scripted navigation's response awaited (frame-nav.js `FN_NAV_PENDING`): what a plan superseded clears.
const NAV_PENDING: u32 = 1 << 1;
// Its old document its own until the new one's response is in (frame-nav.js `FN_COMMIT_PENDING`).
pub(crate) const COMMIT_PENDING: u32 = 1 << 2;
// Its build parked on a still-activating service worker (frame-nav.js `FN_DEFERRED_SW`) — set until the replay that
// `takeSwDeferredFrames` hands it to runs — and (the engine's own bit) handed to one already.
pub(crate) const DEFERRED_SW: u32 = 1 << 3;
const DEFERRED_LISTED: u32 = 1 << 16;
// The navigation is a reload (frame-nav.js `FN_RELOAD_NAV`).
const RELOAD_NAV: u32 = 1 << 5;
// Its post-insertion step ran: its navigable exists (frame-nav.js `FN_CONTEXT_READY`).
const CONTEXT_READY: u32 = 1 << 6;
// Its `src` refused as its attributes were last processed (frame-nav.js `FN_SRC_REFUSED`, `process_src`).
const SRC_REFUSED: u32 = 1 << 7;
// Its element's `load` for the navigation under way still to fire (frame-nav.js `FN_LOAD_OWED`).
const LOAD_OWED: u32 = 1 << 8;

// A navigation the host makes of a frame's navigable, planned by the frame's own document or a hyperlink that targets it
// (HTML "plan to navigate": the navigable's one, a later one replacing it — a form's of its parent's document as well):
// to a URL — whether it replaces the frame's session history entry, the realm of the document that began it and the
// Referer that one sends, the container's `sandbox` attribute as it began (what the document it makes is sandboxed by),
// whether that document had transient activation — or a reload of the document it is at.
pub(crate) enum HostNavigation {
    Navigate { url: String, replace: bool, initiator: i32, referrer: (String, String), sandbox: Option<String>, activated: bool },
    Reload,
}
// The kinds `takeFrameNavigations` answers, which its mask names.
const HOST_NAVIGATE: u32 = 1;
const HOST_RELOAD: u32 = 2;

// What `planFrameLocation` made of a navigation: none (the frame has no navigable), one planned, or one to a fragment of
// the frame's document, which navigates within it at once (HTML "navigate to a fragment"), the bindings' to make.
const PLANNED_NONE: u32 = 0;
const PLANNED: u32 = 1;
const PLANNED_FRAGMENT: u32 = 2;

type Hosted = HashMap<NodeId, (u64, HostNavigation)>;

#[derive(Default)]
pub(crate) struct FrameNavigations(HashMap<NodeId, FrameNavigation>, Plans);

// The plans' numbers, and each form's last one with the container it plans for: an interactive submission supersedes
// its form's last plan on whichever navigable it was for.
#[derive(Default)]
struct Plans {
    next: u32,
    // (…and the parked builds', `FrameNavigation::deferred_at`)
    deferrals: u32,
    last: HashMap<NodeId, (u32, NodeId)>,
    // The host's navigations as a flush of the page's due tasks began, and those the tasks planned
    // (navigation_plan.rs `flushBegin`).
    saved: Option<Hosted>,
    flushed: Option<Hosted>,
}

impl FrameNavigations {
    // The host's planned navigation of container `c`'s navigable, where the container has navigation state.
    pub(crate) fn host_mut(&mut self, c: NodeId) -> Option<&mut Option<(u64, HostNavigation)>> {
        self.0.get_mut(&c).map(|n| &mut n.host)
    }
    // …and a form's of its parent's document cancelled: its response loads into nothing, its pending `load` the
    // replacing navigation's own.
    pub(crate) fn cancel_form(&mut self, c: NodeId) {
        if let Some(nav) = self.0.get_mut(&c) {
            nav.planned = 0;
        }
    }
    // A form's submission into container `c`'s navigable begun: the container's `sandbox` attribute now what the document
    // it makes is sandboxed by (`frame_sandbox`) — as it was when the form was submitted, not as an earlier navigation
    // that made no document (a download) began.
    pub(crate) fn begin_submission(arena: &mut crate::dom::RealmArena, c: NodeId) {
        let sandbox = arena.get(c).and_then(|n| n.plain_attr("sandbox")).map(str::to_owned);
        arena.frame_navigation(c).sandbox = Some(sandbox);
    }
    // Whether the host plans a navigation of any frame.
    pub(crate) fn hosted(&self) -> bool {
        self.0.values().any(|n| n.host.is_some())
    }
    fn take_hosted(&mut self) -> Hosted {
        self.0.iter_mut().filter_map(|(&c, n)| n.host.take().map(|h| (c, h))).collect()
    }
    // The page's due tasks about to run before it navigates: the host's navigations kept apart, so they plan anew…
    pub(crate) fn flush_begin(&mut self) {
        self.1.saved = Some(self.take_hosted());
    }
    // …they ran: what they planned kept as flushed, what was planned before back…
    pub(crate) fn flush_end(&mut self) {
        self.1.flushed = Some(self.take_hosted());
        for (c, host) in self.1.saved.take().unwrap_or_default() {
            if let Some(nav) = self.0.get_mut(&c) {
                nav.host = Some(host);
            }
        }
    }
    // …and the navigation committed no document: what they planned put back where nothing was planned since — or
    // (`drop`) let go — whether any was.
    pub(crate) fn flush_restore(&mut self, drop: bool) -> bool {
        let Some(flushed) = self.1.flushed.take().filter(|_| !drop) else { return false };
        let mut restored = false;
        for (c, host) in flushed {
            if let Some(nav) = self.0.get_mut(&c).filter(|n| n.host.is_none()) {
                nav.host = Some(host);
                restored = true;
            }
        }
        restored
    }
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
    crate::dom::register(scope, ns, "frameLoadBegin", frame_load_begin, context_id);
    crate::dom::register(scope, ns, "frameLoadDue", frame_load_due, context_id);
    crate::dom::register(scope, ns, "frameNav", frame_nav, context_id);
    crate::dom::register(scope, ns, "takeSwDeferredFrames", take_sw_deferred_frames, context_id);
    crate::dom::register(scope, ns, "setFrameNav", set_frame_nav, context_id);
    crate::dom::register(scope, ns, "loadDelay", load_delay, context_id);
    crate::dom::register(scope, ns, "setLoadDelay", set_load_delay, context_id);
    crate::dom::register(scope, ns, "oweContainerLoad", owe_container_load, context_id);
    crate::dom::register(scope, ns, "loadDelayedHere", load_delayed_here, context_id);
    crate::dom::register(scope, ns, "frameNavGeneration", frame_nav_generation, context_id);
    crate::dom::register(scope, ns, "supersedeFrameNav", supersede_frame_nav, context_id);
    crate::dom::register(scope, ns, "frameNavUrl", frame_nav_url, context_id);
    crate::dom::register(scope, ns, "setFrameNavUrl", set_frame_nav_url, context_id);
    crate::dom::register(scope, ns, "frameLoadFired", frame_load_fired, context_id);
    crate::dom::register(scope, ns, "frameSubmissionResponse", frame_submission_response, context_id);
    crate::dom::register(scope, ns, "frameTakeContent", frame_take_content, context_id);
    crate::dom::register(scope, ns, "planFrameNavigation", plan_frame_navigation, context_id);
    crate::dom::register(scope, ns, "landFrameNavigation", land_frame_navigation, context_id);
    crate::dom::register(scope, ns, "frameNavigationPlanned", frame_navigation_planned, context_id);
    crate::dom::register(scope, ns, "cancelFrameNavigation", cancel_frame_navigation, context_id);
    crate::dom::register(scope, ns, "planFrameLocation", plan_frame_location, context_id);
    crate::dom::register(scope, ns, "planFrameReload", plan_frame_reload, context_id);
    crate::dom::register(scope, ns, "dropFrameNavigation", drop_frame_navigation, context_id);
    crate::dom::register(scope, ns, "takeFrameNavigations", take_frame_navigations, context_id);
    crate::dom::register(scope, ns, "frameContent", frame_content, context_id);
    crate::dom::register(scope, ns, "setFrameContent", set_frame_content, context_id);
    crate::dom::register(scope, ns, "frameContentHeld", frame_content_held, context_id);
    crate::dom::register(scope, ns, "frameContentUrl", frame_content_url, context_id);
    crate::dom::register(scope, ns, "copyFrameContent", copy_frame_content, context_id);
    crate::dom::register(scope, ns, "processFrameSrc", process_frame_src, context_id);
    crate::dom::register(scope, ns, "takeFrameSandbox", take_frame_sandbox, context_id);
    crate::dom::register(scope, ns, "frameSandbox", frame_sandbox_op, context_id);
    crate::dom::register(scope, ns, "frameNavigationActivated", frame_navigation_activated, context_id);
    crate::dom::register(scope, ns, "beginFrameNavigation", begin_frame_navigation, context_id);
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
    let activated = arena.get(container).is_some_and(|n| arena.transiently_activated(n.realm));
    let nav = arena.frame_navigation(container);
    nav.sandbox = Some(sandbox);
    nav.activated = activated;
}
impl crate::dom::RealmArena {
    // The `sandbox` attribute the document the container's navigation makes is sandboxed by: as the navigation under way
    // began, else — one whose start took none, a host's — as it is (none: none).
    pub(crate) fn frame_sandbox(&self, container: NodeId) -> Option<String> {
        match self.frame_navigations.0.get(&container).and_then(|nav| nav.sandbox.clone()) {
            Some(snapshot) => snapshot,
            None => self.get(container).and_then(|n| n.plain_attr("sandbox")).map(str::to_owned),
        }
    }
    // …taken by the document it makes: the next navigation's its own.
    pub(crate) fn take_frame_sandbox(&mut self, container: NodeId) -> Option<String> {
        let snapshot = self.frame_navigations.0.get_mut(&container).and_then(|nav| nav.sandbox.take());
        snapshot.unwrap_or_else(|| self.get(container).and_then(|n| n.plain_attr("sandbox")).map(str::to_owned))
    }
}
// __dom.beginFrameNavigation(containerNid[, begun]) — a navigation of the container begins (`begin`): a scripted one, or
// the host's, which carries the attribute it began with (`begun`, `[attribute]`: browser.rb `frame_sandbox_now`).
fn begin_frame_navigation(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(container) = nid_arg(scope, &args, 0) else { return };
    let begun = v8::Local::<v8::Array>::try_from(args.get(1)).ok().map(|a| {
        let v = a.get_index(scope, 0).filter(|v| !v.is_null_or_undefined());
        v.map(|v| v.to_rust_string_lossy(scope))
    });
    let cid = realm_id(scope, &args);
    let arena = crate::dom::realm(scope, cid);
    match begun {
        Some(sandbox) => {
            let nav = arena.frame_navigation(container);
            nav.sandbox = Some(sandbox);
            nav.activated = false;
        }
        None => begin(arena, container),
    }
}
// __dom.frameNavigationActivated(containerNid) -> whether the navigation of the container under way began with its
// document's window activated (`FrameNavigation::activated`).
fn frame_navigation_activated(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(container) = nid_arg(scope, &args, 0) else { return rv.set_bool(false) };
    let cid = realm_id(scope, &args);
    rv.set_bool(crate::dom::realm(scope, cid).frame_navigation_activated(container));
}
impl RealmArena {
    pub(crate) fn frame_navigation_activated(&self, container: NodeId) -> bool {
        self.frame_navigations.0.get(&container).is_some_and(|nav| nav.activated)
    }
}
// __dom.frameSandbox(containerNid) -> `RealmArena::frame_sandbox` (null: none), not taken: what the navigation under way
// began with, which "allowed to download" asks of a response that makes no document.
fn frame_sandbox_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(container) = nid_arg(scope, &args, 0) else { return rv.set_null() };
    let cid = realm_id(scope, &args);
    match crate::dom::realm(scope, cid).frame_sandbox(container).and_then(|s| v8::String::new(scope, &s)) {
        Some(s) => rv.set(s.into()),
        None => rv.set_null(),
    }
}
// __dom.takeFrameSandbox(containerNid) -> `RealmArena::take_frame_sandbox` (null: none): the document the navigation
// makes being made.
fn take_frame_sandbox(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(container) = nid_arg(scope, &args, 0) else { return rv.set_null() };
    let cid = realm_id(scope, &args);
    let sandbox = crate::dom::realm(scope, cid).take_frame_sandbox(container);
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
    let referrer = utf16_value(scope, &content.referrer);
    let policy = utf16_value(scope, &content.policy);
    rv.set(v8::Array::new_with_elements(scope, &[url, bytes, content_type, referrer, policy]).into());
}

// __dom.setFrameContent(containerNid, slot, url, bytes, contentType[, referrer[, policy]]) — the document the navigation
// carries in `slot`: `url`, `bytes` (a Uint8Array), `contentType`, the Referer its request sent and the referrer policy it
// is made with; none where no bytes are given (`setFrameContent(nid, slot)`).
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
        let text = |scope: &mut v8::PinScope<'_, '_>, v: v8::Local<'_, v8::Value>| if v.is_null_or_undefined() { Vec::new() } else { utf16_arg(scope, v) };
        let (referrer, policy) = (text(scope, args.get(5)), text(scope, args.get(6)));
        Content { url, bytes, content_type, referrer, policy }
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
    // (…the host's planned navigation of it replaced too)
    let nav = navs.0.entry(container).or_default();
    nav.planned = token;
    nav.host = None;
    navs.1.last.insert(form, (token, container));
    // (…and the submission of the frame's document the host routes taken out with its route: navigation_plan.rs)
    if let Some(frame) = crate::dom::dom(scope).arena.frame_realm(container) {
        crate::navigation_plan::supersede_routed(scope, frame);
    }
    rv.set_uint32(token);
}

// __dom.landFrameNavigation(containerNid, formNid, token) -> whether the planned navigation is still the container's
// navigable's — its response then the one to load, the plan done.
fn land_frame_navigation(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let (Some(container), Some(form)) = (nid_arg(scope, &args, 0), nid_arg(scope, &args, 1)) else { return rv.set_bool(false) };
    let token = args.get(2).uint32_value(scope).unwrap_or(0);
    let cid = realm_id(scope, &args);
    rv.set_bool(crate::dom::realm(scope, cid).land_frame_navigation(container, form, token));
}
impl RealmArena {
    fn land_frame_navigation(&mut self, container: NodeId, form: NodeId, token: u32) -> bool {
        let navs = &mut self.frame_navigations;
        let Some(nav) = navs.0.get_mut(&container).filter(|n| token != 0 && n.planned == token) else { return false };
        nav.planned = 0;
        if navs.1.last.get(&form).is_some_and(|&(t, _)| t == token) {
            navs.1.last.remove(&form);
        }
        true
    }
}

// What a form submission's response into a frame comes to (`frameSubmissionResponse`): nothing (a 204 / 205: HTML
// "navigate" aborted, the frame staying at the document it is at, with no `load`), or a document to land.
const SUBMISSION_NONE: u32 = 0;
const SUBMISSION_LAND: u32 = 1;
// __dom.frameSubmissionResponse(containerNid, formNid, token, status, responseUrl, requestUrl, method, redirected) ->
// `[SUBMISSION_*, url, posted]` of the response to the planned navigation `token` of the form into the container: for a
// 204 / 205 none, its navigation over where no later one superseded it; else the URL its document is at — the
// response's, which a response serializes with no fragment, with the request's carried across where it has none (HTML
// "navigate", as top-level submissions do) — and whether it is still a POST — where its last hop went as one (a 307's,
// a 308's: `method`, the network's), else where nothing redirected it (a service worker's answer).
fn frame_submission_response(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let answer = |scope: &mut v8::PinScope<'_, '_>, mut rv: v8::ReturnValue<'_, v8::Value>, code: u32, url: &str, posted: bool| {
        let items = [v8::Integer::new_from_unsigned(scope, code).into(), crate::subresource_obtain::text(scope, url), v8::Boolean::new(scope, posted).into()];
        rv.set(v8::Array::new_with_elements(scope, &items).into());
    };
    let (Some(container), Some(form)) = (nid_arg(scope, &args, 0), nid_arg(scope, &args, 1)) else { return answer(scope, rv, SUBMISSION_NONE, "", false) };
    let token = args.get(2).uint32_value(scope).unwrap_or(0);
    let status = args.get(3).uint32_value(scope).unwrap_or(0);
    let text = |scope: &mut v8::PinScope<'_, '_>, i: i32| (!args.get(i).is_null_or_undefined()).then(|| args.get(i).to_rust_string_lossy(scope)).filter(|s| !s.is_empty());
    let (response_url, request_url, method) = (text(scope, 4), text(scope, 5).unwrap_or_default(), text(scope, 6));
    let redirected = args.get(7).is_true();
    let cid = realm_id(scope, &args);
    let arena = crate::dom::realm(scope, cid);
    if status == 204 || status == 205 {
        if arena.land_frame_navigation(container, form, token) {
            arena.set_frame_nav(container, NAV_PENDING, false);
        }
        return answer(scope, rv, SUBMISSION_NONE, "", false);
    }
    let url = match (response_url, request_url.find('#')) {
        (Some(r), Some(at)) if !r.contains('#') => format!("{r}{}", &request_url[at..]),
        (Some(r), _) => r,
        (None, _) => request_url.clone(),
    };
    let posted = method.map_or(!redirected, |m| m == "POST");
    answer(scope, rv, SUBMISSION_LAND, &url, posted);
}
// __dom.frameTakeContent(containerNid, url, bytes, contentType, referrer) -> the realm the container's navigable's
// document was in (-1 for none), or -2 for none taken — an element that is no HTML iframe or frame, `bytes` no view, or
// a document whose unloading ignores the navigation: the response document of a scripted
// navigation (a form submitted into it) the navigation carries — this navigation the one that fires its `load` now, a
// `src` one waiting for its response over — and every earlier navigation of it superseded. The bindings unload the
// old document's realm and build the new one.
fn frame_take_content(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    rv.set_int32(-2);
    let Some(container) = nid_arg(scope, &args, 0) else { return };
    let Ok(view) = v8::Local::<v8::ArrayBufferView>::try_from(args.get(2)) else { return };
    let cid = realm_id(scope, &args);
    let arena = crate::dom::realm(scope, cid);
    if !arena.get(container).is_some_and(|n| n.is_html_named("iframe") || n.is_html_named("frame")) {
        return;
    }
    let old = arena.frame_realm(container);
    if old.is_some_and(|r| arena.unloading(r)) {
        return;
    }
    let mut bytes = vec![0u8; view.byte_length()];
    view.copy_contents(&mut bytes);
    let url = utf16_arg(scope, args.get(1));
    let content_type = utf16_arg(scope, args.get(3));
    let referrer = if args.get(4).is_null_or_undefined() { Vec::new() } else { utf16_arg(scope, args.get(4)) };
    let arena = crate::dom::realm(scope, cid);
    let content_type = if content_type.is_empty() { "text/html".encode_utf16().collect() } else { content_type };
    arena.frame_navigation(container).contents[CONTENT_NAV] = Some(Content { url, bytes, content_type, referrer, policy: Vec::new() });
    arena.set_frame_nav(container, LOAD_FIRED | NAV_PENDING | COMMIT_PENDING, false);
    let nav = arena.frame_navigation(container);
    nav.src = None;
    nav.history = None;
    arena.supersede_frame_nav(container);
    rv.set_int32(old.unwrap_or(-1));
}

// __dom.frameNavigationPlanned(containerNid, token) -> whether the planned navigation is the container's navigable's
// still — its request then the one to send.
fn frame_navigation_planned(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(container) = nid_arg(scope, &args, 0) else { return rv.set_bool(false) };
    let token = args.get(1).uint32_value(scope).unwrap_or(0);
    let cid = realm_id(scope, &args);
    let navs = &crate::dom::realm(scope, cid).frame_navigations;
    rv.set_bool(token != 0 && navs.0.get(&container).is_some_and(|n| n.planned == token));
}

// __dom.planFrameLocation(realm, url, replace, initiatorRealm, policy, activated) -> PLANNED_*: a navigation of frame
// realm `realm`'s navigable — the calling realm's for undefined — to `url` planned for the host (`HostNavigation`),
// replacing the one it planned (a form's of its parent's document among them), its Referer that of the document of
// `initiatorRealm` — the frame's own for undefined — under `policy` (a link's, '' that document's: referrer.rs
// `navigation_referrer`), the container's `sandbox` attribute and `activated` taken now; none for a fragment of the
// frame's document, which the bindings navigate to at once.
fn plan_frame_location(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    let target = if args.get(0).is_undefined() { cid } else { args.get(0).int32_value(scope).unwrap_or(cid) };
    let url = args.get(1).to_rust_string_lossy(scope);
    let replace = args.get(2).is_true();
    let initiator = if args.get(3).is_null_or_undefined() { target } else { args.get(3).int32_value(scope).unwrap_or(target) };
    let policy = args.get(4).to_rust_string_lossy(scope);
    let activated = args.get(5).is_true();
    let arena = &mut crate::dom::dom(scope).arena;
    let Some(container) = arena.live_container(target) else { return rv.set_uint32(PLANNED_NONE) };
    let here = arena.enter_known(target).map(|a| a.location.href().to_owned());
    if here.is_some_and(|here| crate::url_ops::is_fragment_navigation(&here, &url)) {
        return rv.set_uint32(PLANNED_FRAGMENT);
    }
    let referrer = crate::referrer::navigation_referrer(arena, initiator, &policy);
    let sandbox = arena.get(container).and_then(|n| n.plain_attr("sandbox")).map(str::to_owned);
    let nav = arena.frame_navigation(container);
    // (…a form's of its parent's document cancelled: its response loads into nothing, its pending `load` this one's)
    nav.planned = 0;
    let host = HostNavigation::Navigate { url, replace, initiator, referrer, sandbox, activated };
    nav.host = Some((crate::navigation_plan::next_planned(), host));
    // (…and the submission of the frame's document the host routes, taken out with its route: navigation_plan.rs)
    crate::navigation_plan::supersede_routed(scope, target);
    rv.set_uint32(PLANNED);
}
// __dom.planFrameReload(): a reload of the calling frame realm's document planned for the host, replacing the navigation
// its navigable planned.
fn plan_frame_reload(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    let arena = &mut crate::dom::dom(scope).arena;
    let Some(container) = arena.live_container(cid) else { return };
    arena.frame_navigation(container).host = Some((crate::navigation_plan::next_planned(), HostNavigation::Reload));
    crate::navigation_plan::supersede_routed(scope, cid);
}
// __dom.dropFrameNavigation(realm): the navigation the host planned of frame realm `realm`'s navigable let go of, and the
// submission of its document's it routes taken out with its route — a traversal making its document again.
fn drop_frame_navigation(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let realm = args.get(0).int32_value(scope).unwrap_or(0);
    let arena = &mut crate::dom::dom(scope).arena;
    if let Some(nav) = arena.live_container(realm).and_then(|c| arena.frame_navigations.0.get_mut(&c)) {
        nav.host = None;
    }
    crate::navigation_plan::supersede_routed(scope, realm);
}
// __dom.takeFrameNavigations(kinds) -> the navigations the host planned of frames, of the kinds `kinds` names
// (HOST_NAVIGATE, HOST_RELOAD), in the order they were planned, which none plans any more: `[HOST_NAVIGATE, realm, url,
// replace, initiatorRealm, referrerSource, referrerPolicy, [sandbox], activated]`, `[HOST_RELOAD, realm]` — realm the
// frame's now, sandbox null where the container had no attribute.
fn take_frame_navigations(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let kinds = args.get(0).uint32_value(scope).unwrap_or(HOST_NAVIGATE | HOST_RELOAD);
    let arena = &mut crate::dom::dom(scope).arena;
    let kind = |h: &HostNavigation| match h {
        HostNavigation::Navigate { .. } => HOST_NAVIGATE,
        HostNavigation::Reload => HOST_RELOAD,
    };
    let mut taken: Vec<(u64, i32, HostNavigation)> = Vec::new();
    let containers: Vec<NodeId> = arena.frame_navigations.0.iter().filter(|(_, n)| n.host.as_ref().is_some_and(|(_, h)| kind(h) & kinds != 0)).map(|(&c, _)| c).collect();
    for c in containers {
        let realm = arena.frame_realm(c);
        let Some(nav) = arena.frame_navigations.0.get_mut(&c) else { continue };
        let Some((at, host)) = nav.host.take() else { continue };
        // (…none of a container whose navigable has no document now, nothing to navigate)
        let Some(realm) = realm else { continue };
        // (…its navigation begun now, the container's `sandbox` as it was planned what the document it makes — or a
        // download its response is — is sandboxed by: `frame_sandbox`, `take_frame_sandbox`)
        if let HostNavigation::Navigate { sandbox, .. } = &host {
            nav.sandbox = Some(sandbox.clone());
        }
        taken.push((at, realm, host));
    }
    taken.sort_by_key(|&(at, ..)| at);
    // (…each frame's navigable navigated now: the submission of its document the host routes taken out with its route
    // first, before its realm makes way — navigation_plan.rs)
    for &(_, realm, _) in &taken {
        crate::navigation_plan::supersede_routed(scope, realm);
    }
    let mut items = Vec::with_capacity(taken.len());
    for (_, realm, host) in taken {
        let realm = v8::Integer::new(scope, realm).into();
        let item: Vec<v8::Local<v8::Value>> = match host {
            HostNavigation::Navigate { url, replace, initiator, referrer, sandbox, activated } => {
                let sandbox = sandbox.map_or_else(|| v8::null(scope).into(), |s| v8::String::new(scope, &s).unwrap().into());
                vec![
                    v8::Integer::new_from_unsigned(scope, HOST_NAVIGATE).into(),
                    realm,
                    v8::String::new(scope, &url).unwrap().into(),
                    v8::Boolean::new(scope, replace).into(),
                    v8::Integer::new(scope, initiator).into(),
                    v8::String::new(scope, &referrer.0).unwrap().into(),
                    v8::String::new(scope, &referrer.1).unwrap().into(),
                    v8::Array::new_with_elements(scope, &[sandbox]).into(),
                    v8::Boolean::new(scope, activated).into(),
                ]
            }
            HostNavigation::Reload => vec![v8::Integer::new_from_unsigned(scope, HOST_RELOAD).into(), realm],
        };
        items.push(v8::Array::new_with_elements(scope, &item).into());
    }
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}

// __dom.cancelFrameNavigation(containerNid) — another navigation of the container's navigable replaces the one a form
// planned and the one the host planned (its `src` set — a navigation of whatever navigable it has then — or the navigable
// destroyed with the container's removal): the form's response, when it comes, loads into nothing.
fn cancel_frame_navigation(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(container) = nid_arg(scope, &args, 0) else { return };
    let cid = realm_id(scope, &args);
    if let Some(nav) = crate::dom::realm(scope, cid).frame_navigations.0.get_mut(&container) {
        nav.planned = 0;
        nav.host = None;
    }
}

// __dom.frameLoadFired(containerNid, now, committed) — the element's `load` fires now, at `now` on the virtual clock
// (what paces the next: `frameLoadBegin`) — outside `frameLoadDue`: the load its document's delayed own reached it with,
// or (`committed`) the one of a navigation the host committed, a form's POST response, which is the navigation it
// awaited completing and its load the once-per-navigation one.
fn frame_load_fired(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(container) = nid_arg(scope, &args, 0) else { return };
    let Some(at) = args.get(1).number_value(scope) else { return };
    let committed = args.get(2).is_true();
    let cid = realm_id(scope, &args);
    let arena = crate::dom::realm(scope, cid);
    if committed {
        arena.set_frame_nav(container, LOAD_FIRED, true);
        arena.set_frame_nav(container, NAV_PENDING, false);
    }
    arena.frame_navigation(container).loaded_at = Some(at);
}

// __dom.frameNav(containerNid) -> the container's navigation flags.
fn frame_nav(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(container) = nid_arg(scope, &args, 0) else { return rv.set_uint32(0) };
    let cid = realm_id(scope, &args);
    rv.set_uint32(crate::dom::realm(scope, cid).frame_nav(container));
}

// __dom.takeSwDeferredFrames() -> the containers of the calling realm whose builds are parked on a service worker still
// activating (`DEFERRED_SW`) and not yet handed to a replay — handed now — in the order they were parked: what an
// activation's change replays, each parked until its replay runs (its `FN_DEFERRED_SW` cleared then, the bindings').
fn take_sw_deferred_frames(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    let arena = crate::dom::realm(scope, cid);
    let ours: Vec<NodeId> = arena.frame_navigations.0.keys().copied().filter(|&c| arena.get(c).is_some_and(|n| n.realm == cid)).collect();
    let mut parked: Vec<(u32, NodeId)> = Vec::new();
    for container in ours {
        let Some(nav) = arena.frame_navigations.0.get_mut(&container) else { continue };
        if nav.flags & (DEFERRED_SW | DEFERRED_LISTED) == DEFERRED_SW {
            nav.flags |= DEFERRED_LISTED;
            parked.push((nav.deferred_at, container));
        }
    }
    parked.sort_unstable_by_key(|&(at, _)| at);
    let items: Vec<v8::Local<v8::Value>> = parked.iter().map(|(_, id)| v8::Number::new(scope, id.to_f64()).into()).collect();
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}

// Whether a connected container of realm `cid`'s documents owes its element's `load`: HTML's iframe, which delays its
// document's load event until its load event steps ran.
fn frame_loads_owed(arena: &RealmArena, cid: i32) -> bool {
    arena.frame_navigations.0.iter().any(|(&container, nav)| {
        nav.flags & LOAD_OWED != 0 && arena.get(container).is_some_and(|n| n.realm == cid) && arena.is_connected(container)
    })
}

// A realm's document's load event: delayed, or delayed and its container's load owed to the parent after it (HTML: a
// child navigable's document delays its container's document's load until its own fired; the container's `load` comes
// after it). `RealmState::load_delay`.
pub(crate) const LOAD_DELAYED: u8 = 1;
pub(crate) const CONTAINER_LOAD_OWED: u8 = 2;

// Realm `cid`'s load delay, the realm entered for it (its state there, made where it had none).
fn load_delay_of<'s>(scope: &'s mut v8::PinScope<'_, '_>, cid: i32) -> &'s mut u8 {
    let arena = crate::dom::realm(scope, cid);
    &mut arena.realm_state_mut(cid).expect("the realm entered").load_delay
}

// __dom.loadDelay() -> the calling realm's document's load delay (0 none, `LOAD_DELAYED`, `CONTAINER_LOAD_OWED`);
// __dom.setLoadDelay(delay) sets it — `LOAD_DELAYED` only where none was (a container's load owed stays owed).
fn load_delay(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    rv.set_uint32(u32::from(*load_delay_of(scope, cid)));
}
fn set_load_delay(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let delay = args.get(0).uint32_value(scope).and_then(|d| u8::try_from(d).ok()).unwrap_or(0);
    let cid = realm_id(scope, &args);
    let held = load_delay_of(scope, cid);
    if delay != LOAD_DELAYED || *held == 0 {
        *held = delay;
    }
}

// __dom.oweContainerLoad(realm) -> whether realm `realm`'s document (the calling realm's, -1) has its load delayed, its
// container's load then owed to its parent after it: what the parent's frame load steps leave to it.
fn owe_container_load(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let realm = args.get(0).int32_value(scope).filter(|&r| r >= 0).unwrap_or_else(|| realm_id(scope, &args));
    rv.set_bool(owe_container_load_of(scope, realm));
}
fn owe_container_load_of(scope: &mut v8::PinScope<'_, '_>, realm: i32) -> bool {
    let held = load_delay_of(scope, realm);
    let delayed = *held != 0;
    if delayed {
        *held = CONTAINER_LOAD_OWED;
    }
    delayed
}

// __dom.loadDelayedHere(page) -> whether something delays the calling realm's document's load event now: its images
// (image_requests.rs `images_delay_load`; `page`, as the host asks before it fires the page's load, those whose
// arrival the host's own count does not hold), its containers' loads still owed (`frame_loads_owed`; not for the page's: the load the host
// asks for flushes their builds first), and its child navigables' documents whose own load is delayed.
fn load_delayed_here(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let page = args.get(0).is_true();
    let cid = realm_id(scope, &args);
    let arena = &crate::dom::dom(scope).arena;
    let delayed = arena.images_delay_load(cid, page)
        || (!page && frame_loads_owed(arena, cid))
        || arena.child_realms(cid).into_iter().any(|kid| arena.realm_state(kid).is_some_and(|s| s.load_delay != 0));
    rv.set_bool(delayed);
}

// __dom.setFrameNav(containerNid, flags, on) — sets (`on`) or clears the flags (`RealmArena::set_frame_nav`).
fn set_frame_nav(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(container) = nid_arg(scope, &args, 0) else { return };
    let flags = args.get(1).uint32_value(scope).unwrap_or(0);
    let on = args.get(2).boolean_value(scope);
    let cid = realm_id(scope, &args);
    crate::dom::realm(scope, cid).set_frame_nav(container, flags, on);
}
impl RealmArena {
    // The container's navigation's flags, the bindings' (none of the engine's own), and whether it has them…
    fn frame_nav(&self, container: NodeId) -> u32 {
        self.frame_navigations.0.get(&container).map_or(0, |n| n.flags & !DEFERRED_LISTED)
    }
    pub(crate) fn frame_nav_has(&self, container: NodeId, flags: u32) -> bool {
        self.frame_nav(container) & flags != 0
    }
    // …and them set (`on`) or cleared.
    pub(crate) fn set_frame_nav(&mut self, container: NodeId, flags: u32, on: bool) {
        if on {
            let parked = flags & DEFERRED_SW != 0 && self.frame_navigation(container).flags & DEFERRED_SW == 0;
            if parked {
                self.frame_navigations.1.deferrals += 1;
                let at = self.frame_navigations.1.deferrals;
                let nav = self.frame_navigation(container);
                nav.deferred_at = at;
                nav.flags &= !DEFERRED_LISTED;
            }
            self.frame_navigation(container).flags |= flags;
        } else if let Some(nav) = self.frame_navigations.0.get_mut(&container) {
            // (…a build parked no more no replay's either)
            let flags = if flags & DEFERRED_SW != 0 { flags | DEFERRED_LISTED } else { flags };
            nav.flags &= !flags;
            // (…its navigable destroyed with its post-insertion step undone — the container removed — and what the window
            // of its initial about:blank document had with it: one inserted again is a new one's)
            if flags & CONTEXT_READY != 0 {
                nav.activation = None;
            }
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
// superseded, by a navigation of its own or a host's that committed first — and the element `load` it owed with it, the
// latest one owing its own as it queues it.
fn supersede_frame_nav(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(container) = nid_arg(scope, &args, 0) else { return };
    let cid = realm_id(scope, &args);
    crate::dom::realm(scope, cid).supersede_frame_nav(container);
}
impl RealmArena {
    pub(crate) fn supersede_frame_nav(&mut self, container: NodeId) {
        let nav = self.frame_navigation(container);
        nav.generation = nav.generation.wrapping_add(1);
        nav.flags &= !LOAD_OWED;
    }
    // The history entry the navigation pushes as it commits, let go of: one that makes no document pushes none.
    pub(crate) fn take_frame_history_url(&mut self, container: NodeId) {
        if let Some(nav) = self.frame_navigations.0.get_mut(&container) {
            nav.history = None;
        }
    }
    // …and the URL it started with: the response is in.
    pub(crate) fn take_frame_src_url(&mut self, container: NodeId) {
        if let Some(nav) = self.frame_navigations.0.get_mut(&container) {
            nav.src = None;
        }
    }
    // …and the document it loaded last, which a reload loads again (a blob: URL's, revoked by then).
    pub(crate) fn keep_frame_loaded(&mut self, container: NodeId, content: Content) {
        self.frame_navigation(container).contents[CONTENT_LOADED] = Some(content);
    }
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

// What a frame's document is loaded from (frame_response.rs `frame_response`): a scripted navigation's response, its
// `srcdoc`, no URL (the initial about:blank), or a URL of a scheme — about:, data:, javascript:, blob:, or one fetched.
pub(crate) enum FrameSource {
    Navigation(Content),
    Srcdoc(String),
    None,
    About(String),
    Data(String),
    Javascript(String),
    Blob(String),
    Fetch(String),
}

impl RealmArena {
    // Where a build of the frame `container`'s document — in `doc`, none for the root of its tree — loads it from (HTML
    // "process the iframe attributes"), and its reload flag, both taken with the document URL a reload keeps as it
    // begins — whichever branch it takes, so none leaks to a later load:
    // - a scripted navigation's response (a form submitted into it), taken, and kept as the document loaded last, which
    //   a reload loads again;
    // - its `srcdoc`;
    // - the URL it navigates to: a reload's kept URL, else the one its navigation started with, else its `src` — none
    //   where that is none, empty or about:blank, refused as its attributes were last processed, or no URL its document
    //   parses; else by its scheme.
    pub(crate) fn frame_source(&mut self, container: NodeId, doc: Option<NodeId>) -> (FrameSource, bool) {
        let nav = self.frame_navigation(container);
        let reload = nav.flags & RELOAD_NAV != 0;
        nav.flags &= !RELOAD_NAV;
        let kept = nav.reload.take();
        let reload_url = kept.filter(|_| reload);
        if let Some(content) = nav.contents[CONTENT_NAV].take() {
            nav.contents[CONTENT_LOADED] = Some(content.clone());
            return (FrameSource::Navigation(content), reload);
        }
        let started = nav.src.clone();
        let refused = nav.flags & SRC_REFUSED != 0;
        let Some(node) = self.get(container) else { return (FrameSource::None, reload) };
        // (…its `srcdoc`, but for a reload of the document it went on to since: one of another URL than about:srcdoc, its
        // fragment aside)
        let went_on = reload_url.as_ref().is_some_and(|url| {
            let url = String::from_utf16_lossy(url);
            let url = url.split('#').next().unwrap_or_default();
            !url.eq_ignore_ascii_case("about:srcdoc")
        });
        if let Some(srcdoc) = node.plain_attr("srcdoc").filter(|_| !went_on) {
            return (FrameSource::Srcdoc(srcdoc.to_owned()), reload);
        }
        // (…a reload's URL, else the one its navigation started with, else its `src` — that refused by its attributes'
        // processing none, but not a reload's nor that of a navigation under way, which a refused change leaves to go on)
        let src = match (&reload_url, &started) {
            (Some(url), _) => Some(String::from_utf16_lossy(url)),
            (None, Some(started)) => started.as_ref().map(|u| String::from_utf16_lossy(u)),
            (None, None) if refused => None,
            (None, None) => node.plain_attr("src").map(str::to_owned),
        };
        let root = self.root_of(container);
        let doc = doc.or_else(|| self.get(root).is_some_and(|n| n.kind == crate::dom::NodeKind::Document).then_some(root));
        let url = src.filter(|s| !s.is_empty() && s != "about:blank").zip(doc).and_then(|(s, doc)| self.parse_document_url(doc, &s));
        let source = match url {
            None => FrameSource::None,
            Some(url) => {
                let href = url.href().to_owned();
                match url.protocol() {
                    "about:" => FrameSource::About(href),
                    "data:" => FrameSource::Data(href),
                    "javascript:" => FrameSource::Javascript(href),
                    "blob:" => FrameSource::Blob(href),
                    _ => FrameSource::Fetch(href),
                }
            }
        };
        (source, reload)
    }
}

// The container's `load` as its navigation's load event steps begin (`frameLoadBegin`): fired or queued already; at once,
// inside the insertion that navigates it to about:blank; its document built first, on a load gate's task, then its load;
// or its load as a task — paced, where its last `load` fired this instant, by a nested-timer clamp.
const LOAD_NONE: u32 = 0;
const LOAD_NOW: u32 = 1;
const LOAD_BUILD: u32 = 2;
const LOAD_TASK: u32 = 3;
const FRAME_NAV_PACE_MS: f64 = 4.0;
// …and as it comes to fire (`frameLoadDue`): nothing (a navigation superseded it, or its document's own delayed load
// fires it after itself), the load it owed paid with no event (its container gone, or a scripted navigation's response
// awaited, which fires its own), or its `load`.
const DUE_NONE: u32 = 0;
const DUE_PAID: u32 = 1;
const DUE_FIRE: u32 = 2;

// __dom.frameLoadBegin(container, initialInsertion, buildable, allHostsLocal, now, host) -> [step, delay, generation]
// of the container's `load` (`LOAD_*`, its delay in virtual ms, the navigation it is for): once per navigation — not on
// every connect step, nor its own build; a removal and a reassigned `src` / `srcdoc` clear the guard — owed from now until
// it fires, delaying its document's own; at once on its initial insertion where it navigates to about:blank (Chrome and
// Firefox: inside the `appendChild`, which a listener added after it never sees); else, where its document is built as
// it connects (`buildable`: the host makes frame realms; `builds_eagerly`), that build — a `blob:` `src` snapshotted now,
// so a revoke right after the insertion still loads: the navigation took its reference here — then its load. `host`
// the bindings' (subresource-host.js), `now` the virtual clock.
fn frame_load_begin(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let answer = |scope: &mut v8::PinScope<'_, '_>, mut rv: v8::ReturnValue<'_, v8::Value>, step: u32, delay: f64, generation: u32| {
        let items = [v8::Integer::new_from_unsigned(scope, step).into(), v8::Number::new(scope, delay).into(), v8::Integer::new_from_unsigned(scope, generation).into()];
        rv.set(v8::Array::new_with_elements(scope, &items).into());
    };
    let Some(container) = crate::node_handle::nid_of(scope, args.get(0)) else { return answer(scope, rv, LOAD_NONE, 0.0, 0) };
    let (initial, buildable, all_hosts_local) = (args.get(1).is_true(), args.get(2).is_true(), args.get(3).is_true());
    let now = args.get(4).number_value(scope).unwrap_or(0.0);
    let Ok(host) = v8::Local::<v8::Function>::try_from(args.get(5)) else { return answer(scope, rv, LOAD_NONE, 0.0, 0) };
    let doc = node_document(scope, args.get(0));
    let cid = realm_id(scope, &args);
    let arena = crate::dom::realm(scope, cid);
    if arena.frame_nav_has(container, LOAD_FIRED) {
        return answer(scope, rv, LOAD_NONE, 0.0, 0);
    }
    arena.set_frame_nav(container, LOAD_FIRED | LOAD_OWED, true);
    let nav = arena.frame_navigation(container);
    let generation = nav.generation;
    let delay = if nav.loaded_at.is_some_and(|at| now - at < FRAME_NAV_PACE_MS) { FRAME_NAV_PACE_MS } else { 0.0 };
    if initial && arena.navigates_to_blank(container, doc) {
        return answer(scope, rv, LOAD_NOW, 0.0, generation);
    }
    if !(buildable && arena.builds_eagerly(container, doc, cid, all_hosts_local)) {
        return answer(scope, rv, LOAD_TASK, delay, generation);
    }
    let held = arena.frame_navigations.0.get(&container).is_some_and(|n| n.contents[CONTENT_NAV].is_some());
    let src = arena.get(container).and_then(|n| n.plain_attr("src")).map(str::to_owned).filter(|_| !held);
    let url = src.zip(doc).and_then(|(src, doc)| arena.parse_document_url(doc, &src)).map(|u| u.href().to_owned());
    if let Some(url) = url.filter(|u| crate::fetch_rules::fetch_route(u, 0, "") == crate::fetch_rules::ROUTE_BLOB) {
        let Ok(response) = crate::subresource_obtain::scheme_response(scope, host, &url) else { return };
        if let Some((bytes, content_type)) = response {
            let content_type = if content_type.is_empty() { "text/html".to_owned() } else { content_type };
            let units = |s: &str| s.encode_utf16().collect::<Vec<u16>>();
            let content = Content { url: units(&url), bytes, content_type: units(&content_type), referrer: Vec::new(), policy: Vec::new() };
            crate::dom::realm(scope, cid).frame_navigation(container).contents[CONTENT_NAV] = Some(content);
        }
    }
    answer(scope, rv, LOAD_BUILD, delay, generation);
}
// __dom.frameLoadDue(container, generation, now) -> `DUE_*` of the container's `load` for navigation `generation` as it
// comes to fire, at `now` on the virtual clock (kept as when its last `load` fired, which paces the next).
fn frame_load_due(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    rv.set_uint32(DUE_NONE);
    let Some(container) = crate::node_handle::nid_of(scope, args.get(0)) else { return };
    let generation = args.get(1).uint32_value(scope).unwrap_or(0);
    let now = args.get(2).number_value(scope).unwrap_or(0.0);
    let cid = realm_id(scope, &args);
    let arena = crate::dom::realm(scope, cid);
    if !arena.is_connected(container) {
        return rv.set_uint32(DUE_PAID);
    }
    if arena.frame_navigation(container).generation != generation {
        return;
    }
    if arena.frame_nav_has(container, NAV_PENDING) {
        return rv.set_uint32(DUE_PAID);
    }
    // (…none yet where the frame's document has its load delayed — its images fetched — which fires this one with its
    // own, after it: the container's load comes after its document's)
    if let Some(frame) = arena.frame_realm(container) {
        if owe_container_load_of(scope, frame) {
            return;
        }
    }
    crate::dom::realm(scope, cid).frame_navigation(container).loaded_at = Some(now);
    rv.set_uint32(DUE_FIRE);
}

// The URL a container's navigation goes to, as its attributes give it: the one the navigation under way started with,
// else its `src` — none where it has none.
fn navigated_src(nav: Option<&FrameNavigation>, node: &crate::dom::NodeData) -> Option<String> {
    match nav.and_then(|n| n.src.as_ref()) {
        Some(started) => started.as_ref().map(|u| String::from_utf16_lossy(u)),
        None => node.plain_attr("src").map(str::to_owned),
    }
}

impl RealmArena {
    // Whether the frame `container`'s attributes — in `doc`, none for the root of its tree — navigate it to about:blank
    // (HTML "shared attribute processing steps for iframe and frame elements": no response a navigation carries for it, no
    // `srcdoc`, and a URL — the one its navigation started with, else its `src` — that is none, empty, failing to parse
    // against its node document's base, or one that matches about:blank): on its initial insertion, the iframe load event
    // steps run at once, not on a task ("process the iframe attributes").
    fn navigates_to_blank(&mut self, container: NodeId, doc: Option<NodeId>) -> bool {
        let nav = self.frame_navigations.0.get(&container);
        if nav.is_some_and(|n| n.contents[CONTENT_NAV].is_some()) {
            return false;
        }
        let Some(node) = self.get(container) else { return false };
        if node.plain_attr("srcdoc").is_some() {
            return false;
        }
        let src = navigated_src(nav, node).unwrap_or_default();
        if src.is_empty() {
            return true;
        }
        let root = self.root_of(container);
        let Some(doc) = doc.or_else(|| self.get(root).is_some_and(|n| n.kind == crate::dom::NodeKind::Document).then_some(root)) else { return false };
        self.parse_document_url(doc, &src).is_none_or(|url| {
            url.protocol() == "about:" && url.pathname() == "blank" && url.username().is_empty() && url.password().is_empty() && url.host().is_empty()
        })
    }
}

// The node document of a node object (its handle's), none for one of no handle.
fn node_document(scope: &mut v8::PinScope<'_, '_>, node: v8::Local<'_, v8::Value>) -> Option<NodeId> {
    crate::node_handle::handle_of(scope, node)
        // SAFETY: the handle lives while the object, an argument, does.
        .and_then(|ptr| unsafe { ptr.as_ref() }.document(scope))
        .and_then(|d| crate::node_handle::nid_of(scope, d.into()))
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
    let Some(container) = crate::node_handle::nid_of(scope, args.get(0)) else { return rv.set_bool(false) };
    let all_hosts_local = args.get(1).is_true();
    let doc = node_document(scope, args.get(0));
    let cid = realm_id(scope, &args);
    rv.set_bool(crate::dom::realm(scope, cid).builds_eagerly(container, doc, cid, all_hosts_local));
}
impl RealmArena {
    // …`frameBuildsEagerly` of `container`, in `doc` (none for the root of its tree), of realm `cid`'s document: none of
    // an element that is no HTML `<iframe>` or `<frame>`.
    fn builds_eagerly(&mut self, container: NodeId, doc: Option<NodeId>, cid: i32, all_hosts_local: bool) -> bool {
        if !self.get(container).is_some_and(|n| n.is_html_named("iframe") || n.is_html_named("frame")) {
            return false;
        }
        let nav = self.frame_navigations.0.get(&container);
        if nav.is_some_and(|n| n.contents[CONTENT_NAV].is_some()) {
            return true;
        }
        let Some(node) = self.get(container) else { return false };
        if node.plain_attr("srcdoc").is_some() {
            return true;
        }
        let Some(src) = navigated_src(nav, node) else { return false };
        let s = src.trim_matches(|c: char| c.is_whitespace() || c == '\u{FEFF}');
        let scheme = |prefix: &str| s.get(..prefix.len()).is_some_and(|p| p.eq_ignore_ascii_case(prefix));
        if scheme("data:") || scheme("blob:") || scheme("javascript:") {
            return true;
        }
        if s.is_empty() || scheme("about:") {
            return false;
        }
        // (…a node of the realm's own document keeps none of its own: that document is its tree's root, a frame built
        // only as it is connected)
        let root = self.root_of(container);
        let Some(doc) = doc.or_else(|| self.get(root).is_some_and(|n| n.kind == crate::dom::NodeKind::Document).then_some(root)) else { return false };
        let origin = self.served_origin(cid);
        let Some(url) = self.parse_document_url(doc, s) else { return false };
        url.origin() == origin || all_hosts_local
    }
}
