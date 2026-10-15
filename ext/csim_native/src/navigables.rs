// Navigables (HTML §7.3): each frame container's child navigable — the realm its active document is in, and its target
// name — each top-level one's target name, and each realm's document; and the navigable a target name chooses ("the
// rules for choosing a navigable"). A child navigable is its CONTAINER's: its target name is made from the container's
// `name` when the navigable is first given a document, and stays the navigable's whatever its documents and the
// attribute do after (Chrome: a name set by `window.name` outlives the frame's navigation; a changed `name` attribute
// changes no window's name); it goes with the container leaving its document (`discard`). The container's node document
// is the realm the container node is in — the one it was adopted into. The realms themselves are the host's, which
// tells this side which realm a container's navigable is in (`setFrameRealm`).

use std::collections::HashMap;

use crate::dom::{nid_arg, realm_id, utf16_arg, NodeId, RealmArena};

struct Child {
    // The realm the navigable's active document is in — none while it has none yet (an `about:blank` frame no script
    // has looked into) or is between two of them.
    realm: Option<i32>,
    name: Vec<u16>,
}

#[derive(Default)]
pub(crate) struct Navigables {
    children: HashMap<NodeId, Child>,
    // Each nested realm's container — kept once the container's navigable is gone (its container left its document): a
    // window whose browsing context is discarded is no top-level one, its name '' and not to be set.
    containers: HashMap<i32, NodeId>,
    top_names: HashMap<i32, Vec<u16>>,
    documents: HashMap<i32, NodeId>,
    // The windows `window.open` made in this isolate (auxiliary browsing contexts, top-level ones), which the page's
    // event loop — realm 0's — steps with its own, as it does its frames', in the order they were made.
    windows: Vec<i32>,
    // The realms whose contexts are disposed and not yet dropped: a child navigable whose container is in the document
    // of one, or whose active document is one's, is stepped and counted no more — though it keeps its realm, so a
    // `contentWindow` read of a frame in a discarded document stays null.
    discarded: std::collections::HashSet<i32>,
    // How many realms some realm's event loop steps with its own — child navigables with a realm their active document
    // is in, and those windows — read with no call by every realm's bindings (`__dom.childFrames`): none, the common
    // page's, keeps the event loop's step of its child realms and a dispatch's multi-realm path a load of a word.
    pub(crate) linked: crate::dom::SharedWord,
}

impl RealmArena {
    // The realm `child`'s navigable has its active document in, where some realm's event loop steps it: the child's
    // container in a live realm's document, its own realm live.
    fn stepped_realm(&self, container: NodeId, child: &Child) -> Option<i32> {
        let nav = &self.navigables;
        let parent = self.get(container).map(|n| n.realm)?;
        child.realm.filter(|r| !nav.discarded.contains(r) && !nav.discarded.contains(&parent))
    }
    fn note_linked(&mut self) {
        let frames = self.navigables.children.iter().filter(|&(&c, child)| self.stepped_realm(c, child).is_some()).count();
        let linked = frames + self.navigables.windows.len();
        self.navigables.linked.set(u32::try_from(linked).unwrap_or(u32::MAX));
    }
}

// What a target name chooses (HTML "the rules for choosing a navigable"): no navigable; one the current navigable is not
// allowed by sandboxing to navigate — which nothing is done for; or a navigable — the realm its active document is in
// (none yet: an `about:blank` frame no script has looked into) and its container with the realm its node document is
// in (none: a top-level one).
pub(crate) enum Chosen {
    None,
    Blocked,
    Navigable(Option<i32>, Option<(i32, NodeId)>),
}

impl RealmArena {
    // The target name of the navigable realm `cid`'s document is the active document of.
    // A frame's window whose document is no longer its navigable's active one — the frame removed, or navigated since —
    // has none: no name, and none to set.
    pub(crate) fn window_name(&self, cid: i32) -> &[u16] {
        let nav = &self.navigables;
        match nav.containers.get(&cid) {
            Some(container) => nav.children.get(container).filter(|c| c.realm == Some(cid)).map_or(&[], |c| &c.name),
            None => nav.top_names.get(&cid).map_or(&[], Vec::as_slice),
        }
    }
    pub(crate) fn set_window_name(&mut self, cid: i32, name: Vec<u16>) {
        let nav = &mut self.navigables;
        match nav.containers.get(&cid) {
            Some(container) => {
                if let Some(child) = nav.children.get_mut(container).filter(|c| c.realm == Some(cid)) {
                    child.name = name;
                }
            }
            None => {
                nav.top_names.insert(cid, name);
            }
        }
    }
    // Realm `realm`'s document is the active document of `container`'s navigable now, or (None) none is; the navigable
    // made the first time it is given one, its target name the container's `name`.
    pub(crate) fn set_frame_realm(&mut self, container: NodeId, realm: Option<i32>) {
        if !self.navigables.children.contains_key(&container) {
            if realm.is_none() {
                return;
            }
            let name = self.get(container).and_then(|n| n.plain_attr_units("name")).unwrap_or_default();
            self.navigables.children.insert(container, Child { realm: None, name });
        }
        let nav = &mut self.navigables;
        let Some(child) = nav.children.get_mut(&container) else { return };
        if let Some(old) = child.realm.take() {
            nav.containers.remove(&old);
        }
        child.realm = realm;
        if let Some(realm) = realm {
            nav.containers.insert(realm, container);
        }
        self.note_linked();
    }
    // Whether `container`'s navigable's target name is `name` — its container's `name` while it has no navigable yet.
    pub(crate) fn target_name_is(&self, container: NodeId, node: &crate::dom::NodeData, name: &[u16]) -> bool {
        match self.navigables.children.get(&container) {
            Some(child) => child.name == name,
            None => node.plain_attr_is("name", name),
        }
    }
    pub(crate) fn frame_realm(&self, container: NodeId) -> Option<i32> {
        self.navigables.children.get(&container).and_then(|c| c.realm)
    }
    // The container, in realm `parent`'s document, of the navigable realm `realm`'s document is the active document of.
    pub(crate) fn frame_container(&self, parent: i32, realm: i32) -> Option<NodeId> {
        self.live_container(realm).filter(|&c| self.get(c).is_some_and(|n| n.realm == parent))
    }
    // …in whichever realm's document: none for a top-level navigable's realm, or a discarded one's.
    fn live_container(&self, realm: i32) -> Option<NodeId> {
        let nav = &self.navigables;
        nav.containers.get(&realm).copied().filter(|c| nav.children.contains_key(c))
    }
    // `container`'s navigable destroyed — its container left its document.
    pub(crate) fn discard_navigable(&mut self, container: NodeId) {
        self.navigables.children.remove(&container);
        self.note_linked();
    }
    // The realms whose documents are the active documents of the child navigables of realm `cid`'s document — the
    // containers in it — and, the page's, the windows its script opened: in the order they were made (realm ids only
    // grow), what its event loop steps with its own.
    pub(crate) fn child_realms(&self, cid: i32) -> Vec<i32> {
        let mut realms: Vec<i32> = self
            .navigables
            .children
            .iter()
            .filter_map(|(&c, child)| self.stepped_realm(c, child).filter(|_| self.get(c).is_some_and(|n| n.realm == cid)))
            .collect();
        if cid == 0 {
            realms.extend(&self.navigables.windows);
        }
        realms.sort_unstable();
        realms
    }
    // A window `window.open` made in this isolate (realm `realm`) the page's event loop steps now (`on`), or no more.
    pub(crate) fn set_stepped_window(&mut self, realm: i32, on: bool) {
        let nav = &mut self.navigables;
        nav.windows.retain(|&w| w != realm);
        if on {
            nav.windows.push(realm);
        }
        self.note_linked();
    }
    // Whether realm `realm`'s document is in the page's browsing-context tree: the page's own (realm 0), or the active
    // document of a child navigable whose container's document is, up to it — a frame removed takes the realms below it
    // out with its own.
    pub(crate) fn realm_in_tree(&self, mut realm: i32) -> bool {
        loop {
            // (…the page's, or a window `window.open` made in this isolate, which the page's event loop steps)
            if realm == 0 || self.navigables.windows.contains(&realm) {
                return true;
            }
            let Some(container) = self.live_container(realm).filter(|&c| self.frame_realm(c) == Some(realm)) else { return false };
            let Some(parent) = self.get(container).map(|n| n.realm) else { return false };
            realm = parent;
        }
    }
    pub(crate) fn set_realm_document(&mut self, cid: i32, doc: NodeId) {
        self.navigables.documents.insert(cid, doc);
    }
    // Realm `cid`'s context disposed: its document has no descendants to search any more (a navigable whose active
    // document it still is keeps it: the realm's window, which no frame builds again, answers none — a frame in a
    // discarded document stays without a browsing context); or (`dropped`) gone with its nodes: what is kept for it goes,
    // and the navigables of the containers among its nodes.
    pub(crate) fn forget_navigables_of(&mut self, cid: i32, dropped: bool) {
        let nav = &mut self.navigables;
        nav.documents.remove(&cid);
        if !dropped {
            nav.discarded.insert(cid);
            self.note_linked();
        } else {
            nav.discarded.remove(&cid);
            nav.windows.retain(|&w| w != cid);
            if let Some(container) = nav.containers.remove(&cid) {
                if let Some(child) = nav.children.get_mut(&container).filter(|c| c.realm == Some(cid)) {
                    child.realm = None;
                }
            }
            nav.top_names.remove(&cid);
            let dead: Vec<NodeId> = self.navigables.children.keys().copied().filter(|&c| self.get(c).is_none()).collect();
            for container in dead {
                self.navigables.children.remove(&container);
            }
            self.note_linked();
            let gone: Vec<i32> = self.navigables.containers.iter().filter(|&(_, &c)| self.get(c).is_none()).map(|(&r, _)| r).collect();
            for realm in gone {
                self.navigables.containers.remove(&realm);
            }
        }
    }

    // A document's document-tree child navigables' containers (HTML §7.3.1): its HTML `<iframe>`s and `<frame>`s in its
    // own tree — none in a shadow tree, which `window[n]`, `window.length` and `window.frames` do not count — in tree
    // order; up to `limit` of them.
    pub(crate) fn child_navigable_containers(&self, doc: NodeId, limit: usize) -> Vec<NodeId> {
        let mut found = Vec::new();
        let mut stack: Vec<NodeId> = self.get(doc).map_or(Vec::new(), |n| n.children.iter().rev().copied().collect());
        while let Some(id) = stack.pop() {
            if found.len() >= limit {
                break;
            }
            let Some(n) = self.get(id) else { continue };
            if n.is_html_named("iframe") || n.is_html_named("frame") {
                found.push(id);
            }
            stack.extend(n.children.iter().rev());
        }
        found
    }

    // The navigable a target name chooses from realm `current`'s (HTML "find a navigable by target name", its order the
    // UA's — Chrome's, FrameTree::FindFrameForNavigation): the current navigable and its descendants first, then the rest
    // of its top-level traversable's, each in tree order — the containers of a document's child navigables in
    // shadow-including tree order (a frame in a shadow tree is one: Chrome finds it). One of the rest a document under a
    // `sandbox` may not navigate ("allowed by sandboxing to navigate": its own navigable and its descendants alone, and
    // its top-level traversable where every sandbox around it grants `allow-top-navigation`) — Chrome leaves it as it
    // was.
    pub(crate) fn find_navigable(&self, current: i32, name: &[u16]) -> Chosen {
        if name.is_empty() {
            return Chosen::None;
        }
        let own = self.live_container(current).and_then(|c| self.get(c).map(|n| (n.realm, c)));
        if let Some(found) = self.find_in(current, own, name) {
            return found;
        }
        let mut top = current;
        while let Some(parent) = self.live_container(top).and_then(|c| self.get(c)).map(|n| n.realm) {
            top = parent;
        }
        if top == current {
            return Chosen::None;
        }
        match self.find_in(top, None, name) {
            None => Chosen::None,
            Some(Chosen::Navigable(_, None)) if self.sandboxes_around(current).all(|s| allows_top_navigation(&s)) => {
                Chosen::Navigable(Some(top), None)
            }
            Some(found) if self.sandboxes_around(current).next().is_none() => found,
            Some(_) => Chosen::Blocked,
        }
    }
    // …among `realm`'s navigable (`container`'s, or a top-level one) and its descendants.
    fn find_in(&self, realm: i32, container: Option<(i32, NodeId)>, name: &[u16]) -> Option<Chosen> {
        if self.window_name(realm) == name {
            return Some(Chosen::Navigable(Some(realm), container));
        }
        let doc = *self.navigables.documents.get(&realm)?;
        for frame in self.leaving_elements(doc, true) {
            let found = match self.frame_realm(frame) {
                Some(r) => self.find_in(r, Some((realm, frame)), name),
                None => self.get(frame).is_some_and(|n| self.target_name_is(frame, n, name)).then_some(Chosen::Navigable(None, Some((realm, frame)))),
            };
            if found.is_some() {
                return found;
            }
        }
        None
    }
    // The `sandbox` attributes of the containers realm `realm`'s document and its ancestors' sit in, innermost first —
    // each sets the sandboxed navigation browsing context flag of every document in its frame (HTML §7.6.5, "iframe
    // sandboxing flag set", which a nested document's active sandboxing flag set takes on from its container's document).
    fn sandboxes_around(&self, realm: i32) -> impl Iterator<Item = String> + '_ {
        std::iter::successors(self.live_container(realm), |&c| self.get(c).and_then(|n| self.live_container(n.realm)))
            .filter_map(|c| self.get(c).and_then(|n| n.is_html_named("iframe").then(|| n.plain_attr("sandbox").map(str::to_owned)).flatten()))
    }
}

// Whether a `sandbox` attribute grants its documents navigating their top-level traversable (`allow-top-navigation`, or
// `allow-top-navigation-by-user-activation`: the activation it asks for is not modelled here).
fn allows_top_navigation(tokens: &str) -> bool {
    tokens
        .split(['\t', '\n', '\x0c', '\r', ' '])
        .any(|t| t.eq_ignore_ascii_case("allow-top-navigation") || t.eq_ignore_ascii_case("allow-top-navigation-by-user-activation"))
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "windowName", window_name, context_id);
    crate::dom::register(scope, ns, "setWindowName", set_window_name, context_id);
    crate::dom::register(scope, ns, "setFrameRealm", set_frame_realm, context_id);
    crate::dom::register(scope, ns, "frameRealm", frame_realm, context_id);
    crate::dom::register(scope, ns, "frameContainer", frame_container, context_id);
    crate::dom::register(scope, ns, "discardNavigable", discard_navigable, context_id);
    crate::dom::register(scope, ns, "setRealmDocument", set_realm_document, context_id);
    crate::dom::register(scope, ns, "findNavigable", find_navigable, context_id);
    crate::dom::register(scope, ns, "childNavigables", child_navigables, context_id);
    crate::dom::register(scope, ns, "childRealms", child_realms, context_id);
    crate::dom::register(scope, ns, "realmInTree", realm_in_tree, context_id);
    crate::dom::register(scope, ns, "setSteppedWindow", set_stepped_window, context_id);
    let linked = crate::dom::dom(scope).arena.navigables.linked.store();
    crate::dom::view_word(scope, ns, "childFrames", linked);
}

// __dom.windowName() -> this realm's navigable's target name (`window.name`).
fn window_name(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    let name = crate::dom::realm(scope, cid).window_name(cid).to_vec();
    if let Some(s) = v8::String::new_from_two_byte(scope, &name, v8::NewStringType::Normal) {
        rv.set(s.into());
    }
}

// __dom.setWindowName(name) — `window.name = name`, or the host naming a new top-level window.
fn set_window_name(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let name = utf16_arg(scope, args.get(0));
    let cid = realm_id(scope, &args);
    crate::dom::realm(scope, cid).set_window_name(cid, name);
}

// __dom.setFrameRealm(containerNid, realm) — realm `realm`'s document (-1: none) is the active document of the
// container's navigable, the container this realm's.
fn set_frame_realm(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(container) = nid_arg(scope, &args, 0) else { return };
    let realm = args.get(1).int32_value(scope).filter(|&r| r >= 0);
    let cid = realm_id(scope, &args);
    crate::dom::realm(scope, cid).set_frame_realm(container, realm);
}

// __dom.frameRealm(containerNid) -> the realm the container's navigable's active document is in, or -1.
fn frame_realm(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(container) = nid_arg(scope, &args, 0) else { return rv.set_int32(-1) };
    let cid = realm_id(scope, &args);
    rv.set_int32(crate::dom::realm(scope, cid).frame_realm(container).unwrap_or(-1));
}

// __dom.frameContainer(realm) -> the container in this realm's document whose navigable realm `realm`'s document is the
// active document of, or null (another realm's frame, or a top-level one).
fn frame_container(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let realm = args.get(0).int32_value(scope).unwrap_or(-1);
    let cid = realm_id(scope, &args);
    let container = crate::dom::realm(scope, cid).frame_container(cid, realm);
    rv.set(crate::dom::node_value(scope, container));
}

// __dom.discardNavigable(containerNid) — the container's navigable destroyed: it left its document.
fn discard_navigable(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(container) = nid_arg(scope, &args, 0) else { return };
    let cid = realm_id(scope, &args);
    crate::dom::realm(scope, cid).discard_navigable(container);
}

// __dom.setRealmDocument(docNid) — this realm's window's document.
fn set_realm_document(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(doc) = nid_arg(scope, &args, 0) else { return };
    let cid = realm_id(scope, &args);
    crate::dom::realm(scope, cid).set_realm_document(cid, doc);
}

// __dom.findNavigable(name) -> null, false, or [realm, container, containerRealm]: the navigable the target name chooses
// from this realm's (`RealmArena::find_navigable`) — none; one this realm's document may not navigate; or the realm its
// active document is in (-1: none yet), its container (null: a top-level one) and the realm the container's node
// document is in (-1: none).
fn find_navigable(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let name = utf16_arg(scope, args.get(0));
    let cid = realm_id(scope, &args);
    let (realm, container) = match crate::dom::realm(scope, cid).find_navigable(cid, &name) {
        Chosen::None => return rv.set_null(),
        Chosen::Blocked => return rv.set_bool(false),
        Chosen::Navigable(realm, container) => (realm, container),
    };
    let parent = v8::Integer::new(scope, container.map_or(-1, |(parent, _)| parent)).into();
    let container = crate::dom::node_value(scope, container.map(|(_, c)| c));
    if crate::dom::factory_threw(scope) {
        return;
    }
    let realm = v8::Integer::new(scope, realm.unwrap_or(-1)).into();
    rv.set(v8::Array::new_with_elements(scope, &[realm, container, parent]).into());
}

// __dom.childNavigables(docNid, limit) -> the containers of the document's document-tree child navigables, in tree order —
// the first `limit` of them, where it is given (`window[n]` asks for n + 1) — as `nodes_value` answers.
fn child_navigables(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(doc) = nid_arg(scope, &args, 0) else { return };
    let limit = if args.get(1).is_undefined() { usize::MAX } else { args.get(1).uint32_value(scope).unwrap_or(0) as usize };
    let cid = realm_id(scope, &args);
    let found = crate::dom::realm(scope, cid).child_navigable_containers(doc, limit);
    rv.set(crate::dom::nodes_value(scope, cid, &found));
}

// __dom.childRealms() -> this realm's child realms (`RealmArena::child_realms`), ids ascending.
fn child_realms(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    let realms = crate::dom::realm(scope, cid).child_realms(cid);
    let values: Vec<v8::Local<'_, v8::Value>> = realms.into_iter().map(|r| v8::Integer::new(scope, r).into()).collect();
    rv.set(v8::Array::new_with_elements(scope, &values).into());
}

// __dom.realmInTree(realm) -> whether the realm's document is in the page's browsing-context tree (`realm_in_tree`).
fn realm_in_tree(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let realm = args.get(0).int32_value(scope).unwrap_or(-1);
    let cid = realm_id(scope, &args);
    rv.set_bool(crate::dom::realm(scope, cid).realm_in_tree(realm));
}

// __dom.setSteppedWindow(realm, on) — a window `window.open` made in this isolate stepped by the page's event loop
// (`on`), or no more (`RealmArena::set_stepped_window`).
fn set_stepped_window(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(realm) = args.get(0).int32_value(scope) else { return };
    let on = args.get(1).is_true();
    let cid = realm_id(scope, &args);
    crate::dom::realm(scope, cid).set_stepped_window(realm, on);
}
