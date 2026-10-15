// Navigables (HTML §7.3): each frame container's child navigable — the realm its active document is in, and its target
// name — each top-level one's target name, and each realm's document; and the navigable a target name chooses ("find a
// navigable by target name"). A child navigable is its CONTAINER's: its target name is made from the container's `name`
// when the navigable is first given a document, and stays the navigable's whatever its documents and the attribute do
// after (Chrome: a name set by `window.name` outlives the frame's navigation; a changed `name` attribute changes no
// window's name); it goes with the container leaving its document (`discard`). The realms themselves are the host's,
// which tells this side which realm a container's navigable is in (`setFrameRealm`).

use std::collections::HashMap;

use crate::dom::{nid_arg, realm_id, utf16_arg, NodeId, RealmArena};

struct Child {
    // The realm the container's node document is in, and the realm the navigable's active document is in — none while
    // the navigable has none yet (an `about:blank` frame no script has looked into) or is between two of them.
    parent: i32,
    realm: Option<i32>,
    name: Vec<u16>,
}

#[derive(Default)]
pub(crate) struct Navigables {
    children: HashMap<NodeId, Child>,
    containers: HashMap<i32, NodeId>,
    top_names: HashMap<i32, Vec<u16>>,
    documents: HashMap<i32, NodeId>,
}

impl Navigables {
    pub(crate) fn drop_realm(&mut self, cid: i32) {
        if let Some(container) = self.containers.remove(&cid) {
            if let Some(child) = self.children.get_mut(&container).filter(|c| c.realm == Some(cid)) {
                child.realm = None;
            }
        }
        // (…and the navigables its containers had, which go with its document)
        self.children.retain(|_, c| c.parent != cid);
        self.top_names.remove(&cid);
        self.documents.remove(&cid);
    }
}

impl RealmArena {
    // The target name of the navigable realm `cid`'s document is the active document of.
    pub(crate) fn window_name(&self, cid: i32) -> &[u16] {
        let nav = &self.navigables;
        match nav.containers.get(&cid) {
            Some(container) => nav.children.get(container).map_or(&[], |c| &c.name),
            None => nav.top_names.get(&cid).map_or(&[], Vec::as_slice),
        }
    }
    pub(crate) fn set_window_name(&mut self, cid: i32, name: Vec<u16>) {
        let nav = &mut self.navigables;
        match nav.containers.get(&cid).and_then(|container| nav.children.get_mut(container)) {
            Some(child) => child.name = name,
            None => {
                nav.top_names.insert(cid, name);
            }
        }
    }
    // Realm `realm`'s document is the active document of `container`'s navigable (in realm `parent`'s document) now, or
    // (None) none is; the navigable made the first time it is given one, its target name the container's `name`.
    pub(crate) fn set_frame_realm(&mut self, parent: i32, container: NodeId, realm: Option<i32>) {
        if !self.navigables.children.contains_key(&container) {
            if realm.is_none() {
                return;
            }
            let name = self.get(container).and_then(|n| n.plain_attr_units("name")).unwrap_or_default();
            self.navigables.children.insert(container, Child { parent, realm: None, name });
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
        let nav = &self.navigables;
        nav.containers.get(&realm).copied().filter(|c| nav.children.get(c).is_some_and(|child| child.parent == parent))
    }
    // `container`'s navigable destroyed — its container left its document.
    pub(crate) fn discard_navigable(&mut self, container: NodeId) {
        let nav = &mut self.navigables;
        if let Some(child) = nav.children.remove(&container) {
            if let Some(realm) = child.realm {
                nav.containers.remove(&realm);
            }
        }
    }
    pub(crate) fn set_realm_document(&mut self, cid: i32, doc: NodeId) {
        self.navigables.documents.insert(cid, doc);
    }

    // The navigable whose target name `name` is, chosen from realm `current`'s (HTML "find a navigable by target name",
    // its order the UA's — Chrome's, FrameTree::FindFrameForNavigation): the current navigable and its descendants
    // first, then the rest of its top-level traversable's, each in tree order — the containers of a document's child
    // navigables in shadow-including tree order (a frame in a shadow tree is one: Chrome finds it). A navigable is
    // (realm, container): a top-level one no container, a child one with no document yet no realm — its container with
    // the realm its node document is in.
    pub(crate) fn find_navigable(&self, current: i32, name: &[u16]) -> Option<(Option<i32>, Option<(i32, NodeId)>)> {
        if name.is_empty() {
            return None;
        }
        let nav = &self.navigables;
        let container = nav.containers.get(&current).and_then(|&c| nav.children.get(&c).map(|child| (child.parent, c)));
        if let Some(found) = self.find_in(current, container, name) {
            return Some(found);
        }
        let mut top = current;
        while let Some(parent) = nav.containers.get(&top).and_then(|c| nav.children.get(c)).map(|c| c.parent) {
            top = parent;
        }
        if top == current {
            return None;
        }
        self.find_in(top, None, name)
    }
    // …among `realm`'s navigable (`container`'s, or a top-level one) and its descendants.
    fn find_in(&self, realm: i32, container: Option<(i32, NodeId)>, name: &[u16]) -> Option<(Option<i32>, Option<(i32, NodeId)>)> {
        if self.window_name(realm) == name {
            return Some((Some(realm), container));
        }
        let doc = *self.navigables.documents.get(&realm)?;
        for frame in self.leaving_elements(doc, true) {
            let found = match self.navigables.children.get(&frame).and_then(|c| c.realm) {
                Some(r) => self.find_in(r, Some((realm, frame)), name),
                None => self.get(frame).is_some_and(|n| self.target_name_is(frame, n, name)).then_some((None, Some((realm, frame)))),
            };
            if found.is_some() {
                return found;
            }
        }
        None
    }
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
    crate::dom::realm(scope, cid).set_frame_realm(cid, container, realm);
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

// __dom.findNavigable(name) -> null, or [realm, container, containerRealm]: the navigable the target name chooses from
// this realm's (`RealmArena::find_navigable`) — the realm its active document is in (-1: none yet), its container (null:
// a top-level one) and the realm the container's node document is in (-1: none).
fn find_navigable(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let name = utf16_arg(scope, args.get(0));
    let cid = realm_id(scope, &args);
    let Some((realm, container)) = crate::dom::realm(scope, cid).find_navigable(cid, &name) else {
        return rv.set_null();
    };
    let parent = v8::Integer::new(scope, container.map_or(-1, |(parent, _)| parent)).into();
    let container = crate::dom::node_value(scope, container.map(|(_, c)| c));
    if crate::dom::factory_threw(scope) {
        return;
    }
    let realm = v8::Integer::new(scope, realm.unwrap_or(-1)).into();
    rv.set(v8::Array::new_with_elements(scope, &[realm, container, parent]).into());
}
