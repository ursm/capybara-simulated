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
    // Each nested realm's top-level realm, as it was when the realm became its container's navigable's: its document's
    // environment's top-level origin is that one's, whatever becomes of its container after (HTML "top-level origin").
    tops: HashMap<i32, i32>,
    top_names: HashMap<i32, Vec<u16>>,
    documents: HashMap<i32, NodeId>,
    // The windows `window.open` made in this isolate (auxiliary browsing contexts, top-level ones), which the page's
    // event loop — realm 0's — steps with its own, as it does its frames', in the order they were made.
    windows: Vec<i32>,
    // The realms whose contexts are disposed — or being disposed: neutered (`neuterRealm`) on the way — and not yet
    // dropped: a child navigable whose container is in the document of one, or whose active document is one's, is
    // stepped and counted no more — though it keeps its realm, so a `contentWindow` read of a frame in a discarded
    // document stays null. How many there are the bindings read with no call (`discardedRealms`): none is the common
    // page's, whose `defaultView` reads ask nothing more.
    discarded: std::collections::HashSet<i32>,
    discarded_count: crate::dom::SharedWord,
    // The realms whose documents are being unloaded now — their beforeunload / pagehide / unload firing (HTML's
    // "unload counter" above 0): a navigation of their navigable is ignored meanwhile ("navigate" step 13), so a
    // teardown handler re-navigating its own frame neither tears it down again nor wins over the navigation unloading it.
    unloading: std::collections::HashSet<i32>,
    // …and those whose documents are being asked whether they may be unloaded — their beforeunload firing, the unload
    // counter raised as well ("check if unloading is canceled"), a navigation ignored as above — but not unloaded yet:
    // a frame of one re-navigated from it is asked itself, where a frame of one being unloaded was asked with it.
    prompting: std::collections::HashSet<i32>,
    // How many realms some realm's event loop steps with its own — child navigables with a realm their active document
    // is in, and those windows — read with no call by every realm's bindings (`__dom.childFrames`): none, the common
    // page's, keeps the event loop's step of its child realms and a dispatch's multi-realm path a load of a word.
    pub(crate) linked: crate::dom::SharedWord,
}

impl Navigables {
    // Whether realm `cid` is a frame's whose NAVIGABLE is gone — its container left its document, the context discarded
    // (`discarded`), its container kept — not one a navigation of the frame replaced, whose navigable (and the
    // WindowProxy a page holds of it) goes on in another realm. (One a navigation replaces reads so between its neutering
    // and its successor's linking, where nothing of its own runs but its backup custom element reactions.)
    pub(crate) fn lost_navigable(&self, cid: i32) -> bool {
        self.discarded.contains(&cid) && self.containers.contains_key(&cid)
    }
    // …and whether its document is fully active (HTML): its context not disposed — by its frame's removal, or a
    // navigation that replaced it.
    fn fully_active(&self, cid: i32) -> bool {
        !self.discarded.contains(&cid)
    }
}

impl RealmArena {
    // The realm `child`'s navigable has its active document in, where some realm's event loop steps it: the child's
    // container in a live realm's document, its own realm live.
    fn stepped_realm(&self, container: NodeId, child: &Child) -> Option<i32> {
        let nav = &self.navigables;
        let parent = self.get(container).map(|n| n.realm)?;
        child.realm.filter(|r| !nav.discarded.contains(r) && !nav.discarded.contains(&parent))
    }
    // …and how many realms are discarded, for the bindings (`discarded_count`).
    fn note_discarded(&mut self) {
        let n = self.navigables.discarded.len();
        self.navigables.discarded_count.set(u32::try_from(n).unwrap_or(u32::MAX));
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
            let activation = self.take_unbuilt_activation(container);
            let parent = self.get(container).map(|n| n.realm).filter(|&p| p != realm);
            let top = parent.map(|p| self.top_level_realm(p));
            self.navigables.tops.insert(realm, top.unwrap_or(realm));
            if let (Some((at, count)), Some(parent)) = (activation, parent) {
                self.inherit_activation(realm, parent, at, count);
            }
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
    // Whether the document of a navigable ABOVE realm `realm`'s is being unloaded now — past being asked, its
    // descendants' documents, the realm's among them, asked with it (HTML "check if unloading is canceled" runs over the
    // descendants before any is unloaded), or being destroyed with it, which asks none.
    pub(crate) fn ancestor_unloading(&self, realm: i32) -> bool {
        let mut at = realm;
        while let Some(parent) = self.live_container(at).and_then(|c| self.get(c)).map(|n| n.realm) {
            if self.navigables.unloading.contains(&parent) {
                return true;
            }
            at = parent;
        }
        false
    }
    // HTML "shared attribute processing steps for iframe and frame elements" step 3: whether a navigable among the
    // inclusive ancestors of realm `realm`'s — its own, its container's document's, up — has a document whose URL is
    // `url` but for their fragments (frame_navigation.rs `src_nested`).
    pub(crate) fn ancestor_document_at(&self, realm: i32, url: &str) -> bool {
        let url = crate::url_ops::without_fragment(url);
        let at = |r: i32| self.realm_state(r).is_some_and(|s| crate::url_ops::without_fragment(s.location.href()) == url);
        at(realm) || self.ancestor_realms(realm).into_iter().any(at)
    }
    // …in whichever realm's document: none for a top-level navigable's realm, or a discarded one's.
    fn live_container(&self, realm: i32) -> Option<NodeId> {
        let nav = &self.navigables;
        nav.containers.get(&realm).copied().filter(|c| nav.children.contains_key(c))
    }
    // The realm of the top-level traversable realm `realm`'s document was made in: its own for a window's, else its
    // container's document's, up — kept for a removed frame, whose container is in no document now.
    pub(crate) fn top_level_realm(&self, realm: i32) -> i32 {
        self.navigables.tops.get(&realm).copied().unwrap_or(realm)
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
    // The realms of realm `realm`'s descendant navigables' active documents — its frames', theirs, … — in no order:
    // never a window `window.open` made, which is a top-level one.
    pub(crate) fn descendant_realms(&self, realm: i32) -> Vec<i32> {
        let mut by_parent: HashMap<i32, Vec<i32>> = HashMap::new();
        for (&c, child) in &self.navigables.children {
            if let (Some(parent), Some(r)) = (self.get(c).map(|n| n.realm), self.stepped_realm(c, child)) {
                by_parent.entry(parent).or_default().push(r);
            }
        }
        let (mut found, mut parents) = (Vec::new(), vec![realm]);
        while let Some(parent) = parents.pop() {
            let children = by_parent.get(&parent).map_or(&[][..], Vec::as_slice);
            found.extend_from_slice(children);
            parents.extend_from_slice(children);
        }
        found
    }
    // …and those of its ancestor navigables: its container's document's, up.
    pub(crate) fn ancestor_realms(&self, realm: i32) -> Vec<i32> {
        let mut found = Vec::new();
        let mut at = realm;
        while let Some(parent) = self.live_container(at).and_then(|c| self.get(c)).map(|n| n.realm) {
            found.push(parent);
            at = parent;
        }
        found
    }
    // The origin of the host realm `realm`'s document was served from (`RealmLocation::url_origin`) — for a document of
    // no URL of its own (an about:srcdoc one, an about:blank one that inherited no origin, a data: one), its container's
    // document's, up: whatever a sandbox made of any of their origins.
    pub(crate) fn served_origin(&self, realm: i32) -> String {
        for r in std::iter::once(realm).chain(self.ancestor_realms(realm)) {
            let Some(state) = self.realm_state(r) else { break };
            let origin = state.location.url_origin();
            if origin != "null" {
                return origin.to_owned();
            }
        }
        "null".to_owned()
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
            self.note_discarded();
            self.note_linked();
        } else {
            nav.discarded.remove(&cid);
            nav.unloading.remove(&cid);
            nav.prompting.remove(&cid);
            nav.windows.retain(|&w| w != cid);
            if let Some(container) = nav.containers.remove(&cid) {
                if let Some(child) = nav.children.get_mut(&container).filter(|c| c.realm == Some(cid)) {
                    child.realm = None;
                }
            }
            nav.top_names.remove(&cid);
            nav.tops.remove(&cid);
            self.note_discarded();
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
    // shadow-including tree order (a frame in a shadow tree is one: Chrome finds it). One of the rest a sandboxed
    // document may not navigate ("allowed by sandboxing to navigate": with the sandboxed navigation browsing context flag,
    // its own navigable and its descendants alone, and its top-level traversable where its sandboxing lets it navigate
    // that — `allow-top-navigation`, or `…-by-user-activation` with its window's transient activation) — Chrome leaves
    // it as it was.
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
            Some(Chosen::Navigable(_, None)) if self.top_navigation_allowed(current) => Chosen::Navigable(Some(top), None),
            Some(found) if !self.sandboxed(current, crate::sandbox::NAVIGATION) => found,
            Some(_) => Chosen::Blocked,
        }
    }
    // Whether realm `current`'s document may navigate its top-level traversable ("allowed by sandboxing to navigate"): as
    // its window's transient activation lets it — without one, where its sandboxing has no sandboxed top-level
    // navigation without user activation flag; with one, no such flag with user activation.
    fn top_navigation_allowed(&self, current: i32) -> bool {
        use crate::sandbox::{TOP_LEVEL_NAVIGATION, TOP_LEVEL_NAVIGATION_BY_USER_ACTIVATION};
        let flag = if self.transiently_activated(current) { TOP_LEVEL_NAVIGATION_BY_USER_ACTIVATION } else { TOP_LEVEL_NAVIGATION };
        !self.sandboxed(current, flag)
    }
    // The realm whose navigable `_top` or `_parent` (`keyword`) chooses from realm `current`'s, where its document may
    // navigate it ("allowed by sandboxing to navigate": its own and its descendants alone where its sandboxing has the
    // sandboxed navigation browsing context flag, its top-level traversable as `top_navigation_allowed` lets it) — None
    // where it may not; its own for a top-level one's, whose top and parent it is.
    pub(crate) fn keyword_navigable(&self, current: i32, keyword: u32) -> Option<i32> {
        let parent = self.live_container(current).and_then(|c| self.get(c)).map(|n| n.realm);
        let chosen = match (keyword, parent) {
            (_, None) => return Some(current),
            (TARGET_TOP, Some(_)) => self.top_level_realm(current),
            (_, Some(parent)) => parent,
        };
        let top = chosen == self.top_level_realm(current);
        let allowed = !self.sandboxed(current, crate::sandbox::NAVIGATION) || (top && self.top_navigation_allowed(current));
        allowed.then_some(chosen)
    }
    // Whether the navigable target name `target` chooses from realm `current`'s is a NEW one its document may not make
    // ("the rules for choosing a navigable": with the sandboxed auxiliary navigation browsing context flag — no
    // `allow-popups` — none is chosen): `_blank`, or a name no navigable it may find has.
    pub(crate) fn auxiliary_refused(&self, current: i32, target: &[u16]) -> bool {
        if !self.sandboxed(current, crate::sandbox::AUXILIARY_NAVIGATION) {
            return false;
        }
        match target_keyword(&String::from_utf16_lossy(target)) {
            TARGET_BLANK => true,
            TARGET_NAME => matches!(self.find_navigable(current, target), Chosen::None),
            _ => false,
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
    // Whether a service worker may control a navigation of the navigable `container` frames — realm `realm`'s own where
    // none: where the environment it makes is a secure context (HTML §8.1.3.5, its top-level creation URL's — the top-
    // level traversable's document's: `url_ops::secure_top_level`) and its document's origin is no opaque one a sandbox
    // makes it — the container's own `sandbox` attribute, or the sandboxing of the document it is in, which every frame
    // of its takes on (`RealmLocation::sandbox`: its containers' and a CSP `sandbox` too) — (Service Workers' "Match
    // Service Worker Registration" finds none for an opaque origin: a sandboxed frame without `allow-same-origin` is
    // uncontrolled).
    pub(crate) fn sw_may_control_navigation(&self, realm: i32, container: Option<NodeId>) -> bool {
        // (…the document the frame is in, for a frame's — its own realm's container's for a realm's own navigation)
        let frame = container.or_else(|| self.live_container(realm)).and_then(|c| self.get(c));
        let around = frame.map(|n| n.realm);
        let own = container.or_else(|| self.live_container(realm)).filter(|_| frame.is_some_and(|n| n.is_html_named("iframe"))).and_then(|c| self.frame_sandbox(c));
        let top = self.top_level_realm(around.unwrap_or(realm));
        if !self.realm_state(top).is_some_and(|s| crate::url_ops::secure_top_level(s.location.href())) {
            return false;
        }
        let inherited = around.and_then(|r| self.realm_state(r)).map_or(0, |s| s.location.sandbox);
        (inherited | crate::sandbox::sandboxing(None, own.as_deref())) & crate::sandbox::ORIGIN == 0
    }
}

// __dom.swMayControlNavigation(container) -> `sw_may_control_navigation` of the frame `container`, or (null) of the
// calling realm's own navigable.
fn sw_may_control_navigation_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let container = crate::node_handle::nid_of(scope, args.get(0));
    let cid = crate::dom::realm_id(scope, &args);
    rv.set_bool(crate::dom::dom(scope).arena.sw_may_control_navigation(cid, container));
}

// The keyword a navigable target name is, ASCII case-insensitively (HTML "valid navigable target name or keyword"): the
// current navigable for '' and `_self`, its top-level traversable, its parent, a new one for `_blank` — and a name, any
// other, which "the rules for choosing a navigable" find one by.
pub(crate) const TARGET_NAME: u32 = 0;
pub(crate) const TARGET_SELF: u32 = 1;
pub(crate) const TARGET_TOP: u32 = 2;
pub(crate) const TARGET_PARENT: u32 = 3;
pub(crate) const TARGET_BLANK: u32 = 4;
pub(crate) fn target_keyword(target: &str) -> u32 {
    match target {
        "" => TARGET_SELF,
        t if t.eq_ignore_ascii_case("_self") => TARGET_SELF,
        t if t.eq_ignore_ascii_case("_top") => TARGET_TOP,
        t if t.eq_ignore_ascii_case("_parent") => TARGET_PARENT,
        t if t.eq_ignore_ascii_case("_blank") => TARGET_BLANK,
        _ => TARGET_NAME,
    }
}
// …for the host.
pub(crate) fn target_keyword_for_ruby(target: String) -> u32 {
    target_keyword(&target)
}
// The window open steps' features (HTML §7.2.2.1): `features` tokenized ("tokenize the features") — a name and a value
// each, ASCII-lowercased, between feature separators (ASCII whitespace, `=` and `,`), a later one of a name replacing
// the earlier — and what it sets: OPEN_NOOPENER where `noopener` is set or `noreferrer` is, which implies it,
// OPEN_NOREFERRER where `noreferrer` is ("check if a window feature is set": its value parsed as a boolean feature).
pub(crate) const OPEN_NOOPENER: u32 = 1;
pub(crate) const OPEN_NOREFERRER: u32 = 2;
fn tokenize_features(features: &str) -> HashMap<String, String> {
    let separator = |c: char| c.is_ascii_whitespace() || c == '=' || c == ',';
    let mut tokens = HashMap::new();
    let mut rest = features;
    while !rest.is_empty() {
        rest = rest.trim_start_matches(separator);
        let end = rest.find(separator).unwrap_or(rest.len());
        let name = rest[..end].to_ascii_lowercase();
        rest = &rest[end..];
        // (…the separators up to its `=`, one that is no separator or a `,` ending its name's: a name with no value)
        let to_eq = rest.find(|c: char| c == '=' || c == ',' || !separator(c)).unwrap_or(rest.len());
        rest = &rest[to_eq..];
        let mut value = String::new();
        if rest.starts_with('=') {
            let skip = rest.find(|c: char| c == ',' || !separator(c)).unwrap_or(rest.len());
            rest = &rest[skip..];
            if !rest.starts_with(',') {
                let end = rest.find(separator).unwrap_or(rest.len());
                value = rest[..end].to_ascii_lowercase();
                rest = &rest[end..];
            }
        }
        if !name.is_empty() {
            tokens.insert(name, value);
        }
    }
    tokens
}
// ("parse a boolean feature": an empty value, `yes` or `true` set, else an integer's other than 0 — none that is no integer)
fn feature_set(tokens: &HashMap<String, String>, name: &str) -> bool {
    tokens.get(name).is_some_and(|v| v.is_empty() || v == "yes" || v == "true" || crate::validity::parse_html_integer(v).is_some_and(|n| n != 0))
}
pub(crate) fn open_features(features: &str) -> u32 {
    let tokens = tokenize_features(features);
    let noreferrer = feature_set(&tokens, "noreferrer");
    if noreferrer {
        OPEN_NOOPENER | OPEN_NOREFERRER
    } else if feature_set(&tokens, "noopener") {
        OPEN_NOOPENER
    } else {
        0
    }
}
// __dom.openFeatures(features) -> `open_features`.
fn open_features_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let features = args.get(0).to_rust_string_lossy(scope);
    rv.set_uint32(open_features(&features));
}
// __dom.targetKeyword(target) -> `target_keyword`.
fn target_keyword_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let target = args.get(0).to_rust_string_lossy(scope);
    rv.set_uint32(target_keyword(&target));
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "targetKeyword", target_keyword_op, context_id);
    crate::dom::register(scope, ns, "browsingContextDiscarded", browsing_context_discarded, context_id);
    crate::dom::register(scope, ns, "documentFullyActive", document_fully_active, context_id);
    crate::dom::register(scope, ns, "neuterRealm", neuter_realm, context_id);
    crate::dom::register(scope, ns, "openFeatures", open_features_op, context_id);
    crate::dom::register(scope, ns, "windowName", window_name, context_id);
    crate::dom::register(scope, ns, "setWindowName", set_window_name, context_id);
    crate::dom::register(scope, ns, "setFrameRealm", set_frame_realm, context_id);
    crate::dom::register(scope, ns, "frameRealm", frame_realm, context_id);
    crate::dom::register(scope, ns, "frameContainer", frame_container, context_id);
    crate::dom::register(scope, ns, "discardNavigable", discard_navigable, context_id);
    crate::dom::register(scope, ns, "setRealmDocument", set_realm_document, context_id);
    crate::dom::register(scope, ns, "findNavigable", find_navigable, context_id);
    crate::dom::register(scope, ns, "auxiliaryRefused", auxiliary_refused, context_id);
    crate::dom::register(scope, ns, "keywordNavigable", keyword_navigable, context_id);
    crate::dom::register(scope, ns, "swMayControlNavigation", sw_may_control_navigation_op, context_id);
    crate::dom::register(scope, ns, "childNavigables", child_navigables, context_id);
    crate::dom::register(scope, ns, "childRealms", child_realms, context_id);
    crate::dom::register(scope, ns, "realmInTree", realm_in_tree, context_id);
    crate::dom::register(scope, ns, "setSteppedWindow", set_stepped_window, context_id);
    crate::dom::register(scope, ns, "ownContainer", own_container, context_id);
    crate::dom::register(scope, ns, "setUnloading", set_unloading, context_id);
    crate::dom::register(scope, ns, "setPrompting", set_prompting, context_id);
    crate::dom::register(scope, ns, "unloading", unloading, context_id);
    crate::dom::register(scope, ns, "ancestorUnloading", ancestor_unloading, context_id);
    let linked = crate::dom::dom(scope).arena.navigables.linked.store();
    crate::dom::view_word(scope, ns, "childFrames", linked);
    let discarded = crate::dom::dom(scope).arena.navigables.discarded_count.store();
    crate::dom::view_word(scope, ns, "discardedRealms", discarded);
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

// __dom.auxiliaryRefused(target[, nid]) -> `RealmArena::auxiliary_refused` of the realm the element `nid` — the link,
// the form — is in, of the calling realm's for none (`open()`'s: its window's).
fn auxiliary_refused(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let target = utf16_arg(scope, args.get(0));
    let cid = realm_id(scope, &args);
    let id = crate::dom::nid_arg(scope, &args, 1);
    let arena = crate::dom::realm(scope, cid);
    let realm = id.and_then(|id| arena.get(id)).map_or(cid, |n| n.realm);
    rv.set_bool(arena.auxiliary_refused(realm, &target));
}
// __dom.keywordNavigable(keyword) -> `RealmArena::keyword_navigable` of the calling realm's (`TARGET_TOP` /
// `TARGET_PARENT`), -1 where its document may not navigate it.
fn keyword_navigable(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let keyword = args.get(0).uint32_value(scope).unwrap_or(TARGET_TOP);
    let cid = realm_id(scope, &args);
    rv.set_int32(crate::dom::realm(scope, cid).keyword_navigable(cid, keyword).unwrap_or(-1));
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

// __dom.ownContainer() -> the container whose navigable this realm's document is the active document of — its
// `frameElement`, before its origin is asked — or null: a top-level one's, or a frame's removed or navigated away from.
fn own_container(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    let arena = crate::dom::realm(scope, cid);
    let container = arena.live_container(cid).filter(|&c| arena.frame_realm(c) == Some(cid));
    rv.set(crate::dom::node_value(scope, container));
}

// __dom.setUnloading(realm, on) — the realm's document begins (`on`) or ends being unloaded (`Navigables::unloading`).
fn set_unloading(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(realm) = args.get(0).int32_value(scope) else { return };
    let on = args.get(1).is_true();
    let cid = realm_id(scope, &args);
    let unloading = &mut crate::dom::realm(scope, cid).navigables.unloading;
    if on {
        unloading.insert(realm);
    } else {
        unloading.remove(&realm);
    }
}
// __dom.setPrompting(realm, on) — the realm's document begins (`on`) or ends being asked whether it may be unloaded
// (`Navigables::prompting`).
fn set_prompting(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(realm) = args.get(0).int32_value(scope) else { return };
    let on = args.get(1).is_true();
    let cid = realm_id(scope, &args);
    let prompting = &mut crate::dom::realm(scope, cid).navigables.prompting;
    if on {
        prompting.insert(realm);
    } else {
        prompting.remove(&realm);
    }
}
// __dom.unloading(realm) -> whether the realm's document is being unloaded or asked whether it may be now — its unload
// counter above 0, a navigation of its navigable ignored.
fn unloading(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let realm = args.get(0).int32_value(scope).unwrap_or(-1);
    let cid = realm_id(scope, &args);
    let nav = &crate::dom::realm(scope, cid).navigables;
    rv.set_bool(nav.unloading.contains(&realm) || nav.prompting.contains(&realm));
}
// __dom.ancestorUnloading(realm) -> whether an ancestor navigable's document is being unloaded now
// (`RealmArena::ancestor_unloading`).
fn ancestor_unloading(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let realm = args.get(0).int32_value(scope).unwrap_or(-1);
    let cid = realm_id(scope, &args);
    rv.set_bool(crate::dom::realm(scope, cid).ancestor_unloading(realm));
}

// __dom.browsingContextDiscarded() -> whether the realm's window's browsing context is discarded — a removed frame's
// (`lost_navigable`): its `closed` true, its document's `defaultView` none, through a reference captured before.
fn browsing_context_discarded(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    rv.set_bool(crate::dom::dom(scope).arena.navigables.lost_navigable(cid));
}

// __dom.documentFullyActive() -> whether the realm's document is fully active (`fully_active`): what nothing waiting on
// it — an image's data, a lock request — goes ahead without.
fn document_fully_active(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    rv.set_bool(crate::dom::dom(scope).arena.navigables.fully_active(cid));
}

// __dom.neuterRealm(realm): realm `realm`'s context is being disposed — its frame removed, or a navigation replacing it —
// its document fully active no more from now on, before anything of its own runs again on the way (its backup custom
// element reactions; `discard_realm` marks it so too, after them).
fn neuter_realm(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(cid) = args.get(0).int32_value(scope) else { return };
    let arena = &mut crate::dom::dom(scope).arena;
    arena.navigables.discarded.insert(cid);
    arena.note_discarded();
    arena.note_linked();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_target_keyword_is_matched_ascii_case_insensitively() {
        assert_eq!(target_keyword(""), TARGET_SELF);
        assert_eq!(target_keyword("_SELF"), TARGET_SELF);
        assert_eq!(target_keyword("_Top"), TARGET_TOP);
        assert_eq!(target_keyword("_parent"), TARGET_PARENT);
        assert_eq!(target_keyword("_BLANK"), TARGET_BLANK);
        // (…a name, any other — one a Unicode case folding would make a keyword too)
        assert_eq!(target_keyword("_ſelf"), TARGET_NAME);
        assert_eq!(target_keyword("_blank "), TARGET_NAME);
        assert_eq!(target_keyword("frame"), TARGET_NAME);
    }

    #[test]
    fn the_open_features_are_tokenized_and_their_booleans_parsed() {
        assert_eq!(open_features(""), 0);
        assert_eq!(open_features("noopener"), OPEN_NOOPENER);
        assert_eq!(open_features(" NoOpener = YES "), OPEN_NOOPENER);
        assert_eq!(open_features("width=100,noopener"), OPEN_NOOPENER);
        assert_eq!(open_features("noopener=1px"), OPEN_NOOPENER);
        assert_eq!(open_features("noreferrer"), OPEN_NOOPENER | OPEN_NOREFERRER);
        // (…a value that is no boolean nor an integer, or 0, unset; a later one of a name the one it has)
        assert_eq!(open_features("noopener=no"), 0);
        assert_eq!(open_features("noopener=0"), 0);
        assert_eq!(open_features("noopener,noopener=0"), 0);
        // (…`=`, `,` and whitespace all separate: a name with no value after its `,` is set)
        assert_eq!(open_features("noopener,width=0"), OPEN_NOOPENER);
        assert_eq!(open_features("noopener=,x"), OPEN_NOOPENER);
        assert_eq!(open_features("noopener x"), OPEN_NOOPENER);
        assert_eq!(open_features("=noopener=no"), 0);
        assert_eq!(open_features("noopenerx"), 0);
    }
}

