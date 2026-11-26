// The focus model's steps (HTML §6.6.4-6.6.7) — which focusable area has the focus, and how it moves: the FOCUSING
// STEPS (`focus()`, a click, Tab, autofocus, a dialog's or a popover's focusing steps, `window.focus()`), the
// UNFOCUSING STEPS (`blur()`), and the FOCUS UPDATE STEPS both run over FOCUS CHAINS — a focusable area, its document, the
// document's container, that one's document, … up to the top-level traversable's document — blurring the old chain
// where it parts from the new and focusing the new; the rendering update's FOCUS FIXUP, and its "flush autofocus
// candidates". What is focusable, and the sequential order, are focus.rs's.
//
// The state is the engine's: each document's FOCUSED AREA (its realm's `focus`, the element carrying STATE_FOCUSED — none
// for its viewport), and which child navigable each document's focus went into and which window has system focus
// (navigables.rs `focused_child`, `system_focus`). The steps run here and call the bindings for what a script observes
// (dom-nodes.js): `focusLost` (a text control's pending `change`, then `blur` and `focusout`), `focusGained` (an editing
// host's caret, then `focus` and `focusin`) and `windowFocusEvent` (a Window's `blur` / `focus`) — each fired in the
// realm of what it is fired at — and `focusChanged`, the host told the focus chain moved (`WindowClient.focused`).

use crate::dom::{NodeId, NodeKind, RealmArena, STATE_FOCUSED};

// An entry of a focus chain: an element (a focusable area, or the container of a child navigable), a document's
// viewport (a focusable area whose DOM anchor is its document), or a document — whose events are its Window's.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Entry {
    Element(NodeId),
    Viewport(i32),
    Document(i32),
}

impl RealmArena {
    // The realm whose document `id` is in — none for a node of a document no realm shows (a DOMParser's), or of none.
    pub(crate) fn document_realm_of(&self, id: NodeId) -> Option<i32> {
        let root = self.shadow_including_root(id);
        let d = self.get(root).filter(|d| d.kind == NodeKind::Document)?;
        (self.realm_document(d.realm) == Some(root)).then_some(d.realm)
    }

    // The focus chain of `area` (HTML "focus chain"): it, its document, and on up through each child navigable's
    // container — "If currentObject is a focusable area, then set currentObject to currentObject's DOM anchor's node
    // document. Otherwise, if currentObject is a Document whose node navigable's parent is non-null, then set
    // currentObject to currentObject's node navigable's parent" (its container, the parent's focusable area of it).
    pub(crate) fn focus_chain_of(&self, area: Entry) -> Vec<Entry> {
        let mut realm = match area {
            Entry::Element(el) => match self.document_realm_of(el) {
                Some(realm) => realm,
                None => return vec![area],
            },
            Entry::Viewport(realm) | Entry::Document(realm) => realm,
        };
        let mut chain = vec![area];
        if area != Entry::Document(realm) {
            chain.push(Entry::Document(realm));
        }
        for _ in 0..crate::navigables::MAX_NESTING {
            let Some(container) = self.live_container(realm).filter(|&c| self.frame_realm(c) == Some(realm)) else { break };
            let Some(parent) = self.document_realm_of(container) else { break };
            chain.push(Entry::Element(container));
            chain.push(Entry::Document(parent));
            realm = parent;
        }
        chain
    }

    // The currently focused area of the top-level traversable whose document is realm `top`'s: none where it has not the
    // system focus ("If traversable does not have system focus, then return null"); else down each document's focused
    // area that is a child navigable's container to its document (navigables.rs `focus_chain`), that document's focused
    // area — its viewport where it has none.
    pub(crate) fn currently_focused_area(&self, top: i32) -> Option<Entry> {
        let chain = self.focus_chain();
        if chain.first() != Some(&top) {
            return None;
        }
        let realm = *chain.last()?;
        let focused = self.realm_state(realm).and_then(|st| st.focus).filter(|&f| self.document_realm_of(f) == Some(realm));
        Some(focused.map_or(Entry::Viewport(realm), Entry::Element))
    }
    // …and its focus chain (HTML "current focus chain of a top-level traversable"), empty for none.
    pub(crate) fn current_focus_chain(&self, top: i32) -> Vec<Entry> {
        self.currently_focused_area(top).map_or_else(Vec::new, |area| self.focus_chain_of(area))
    }
    // …and the area the traversable would have focused, its documents' as they stand, whether or not it has the system
    // focus (navigables.rs `window_focus_chain`).
    fn window_focused_area(&self, top: i32) -> Option<Entry> {
        let realm = *self.window_focus_chain(top).last()?;
        let focused = self.realm_state(realm).and_then(|st| st.focus).filter(|&f| self.document_realm_of(f) == Some(realm));
        Some(focused.map_or(Entry::Viewport(realm), Entry::Element))
    }

    // The area realm `realm`'s document kept as the focus left it, down a kept container to what its frame's document
    // kept, as the focus chain goes — its viewport where it kept none.
    fn kept_area(&self, realm: i32) -> Entry {
        let (mut at, mut kept) = (realm, None);
        for _ in 0..crate::navigables::MAX_NESTING {
            kept = self.realm_state(at).and_then(|st| st.focus).filter(|&f| self.document_realm_of(f) == Some(at));
            match kept.and_then(|f| crate::focus::child_document_realm(self, f)) {
                Some(child) => at = child,
                None => break,
            }
        }
        kept.map_or(Entry::Viewport(at), Entry::Element)
    }

    // The realm of the document `entry` is of.
    fn entry_realm(&self, entry: Entry) -> Option<i32> {
        match entry {
            Entry::Element(el) => self.document_realm_of(el),
            Entry::Viewport(realm) | Entry::Document(realm) => Some(realm),
        }
    }

    // Designate `area` (an element, or none: the viewport) as the focused area of realm `realm`'s document.
    fn designate(&mut self, realm: i32, area: Option<NodeId>) {
        let arena = self.enter(realm);
        let prev = arena.focus;
        if prev == area {
            return;
        }
        if let Some(p) = prev {
            let bits = arena.get(p).map_or(0, |n| n.state);
            arena.set_state(p, bits & !STATE_FOCUSED);
        }
        if let Some(a) = area {
            let bits = arena.get(a).map_or(0, |n| n.state);
            arena.set_state(a, bits | STATE_FOCUSED);
        }
    }

    // `:focus-visible` latched as `el` is focused, in its realm: shown unless the focus is a pointer's — a press that
    // focused an element, a label's control a click focused, or a script's after one (a press on what takes no focus
    // leaves none: `press_focus`) — a text entry showing its ring all the same (element_state.rs `is_focus_visible`)
    // (Chrome and Firefox, measured 2026-11-27: a script's focus after a click on a button or a text field shows none,
    // after a click on the page's background one; Selectors 4's heuristics).
    pub(crate) fn latch_focus_ring(&mut self, el: NodeId) {
        let Some(realm) = self.document_realm_of(el) else { return };
        let arena = self.enter(realm);
        let ring = if arena.pointer_modality { crate::dom::RING_POINTER } else { crate::dom::RING_SHOWN };
        arena.set_focus_ring(ring);
    }
    // …and the user's keyboard input in the realm entered: what is focused there shows its ring from now on ("If the user
    // interacts with the page via keyboard, the currently focused element should match :focus-visible"; Chrome, a Shift
    // pressed at a button a click focused) — but a key pressed with Control, Alt or Meta, or one of those, a shortcut's,
    // which shows none (WPT css/selectors focus-visible-012; Firefox shows none for a Shift either).
    pub(crate) fn keyboard_modality(&mut self) {
        self.pointer_modality = false;
        self.set_focus_ring(crate::dom::RING_SHOWN);
    }
    // …that input a key `key` pressed with `held` (keys.rs bits) at what is focused in realm `realm`: the ring shown there,
    // where it is no shortcut's.
    pub(crate) fn key_pressed(&mut self, realm: i32, key: &[u16], held: u32) {
        let shortcut = held & (crate::keys::CTRL | crate::keys::ALT | crate::keys::META) != 0
            || ["Control", "Alt", "Meta"].iter().any(|m| key.iter().copied().eq(m.encode_utf16()));
        if shortcut {
            return;
        }
        let cur = self.cur();
        self.enter(realm).keyboard_modality();
        self.enter(cur);
    }
}

// What the focusing steps take: an element (a focusable area, or one standing for one) or a document's viewport.
#[derive(Clone, Copy)]
pub(crate) enum Target {
    Element(NodeId),
    Viewport(i32),
}

// Who runs them: the user (a press, a key, the driver's own focusing) — whose focusing gives the system focus to the
// window it is in, as a window manager gives it to the window clicked or typed into — or a script (`focus()`, a dialog's
// or a popover's steps, autofocus, a fragment), which moves the focus within its window and takes no system focus from
// another (Firefox, measured 2026-11-27: an opener's `focus()` of an element of its pop-up leaves the system focus with
// the opener; HTML's window.focus() "may" raise the window, the focusing steps say nothing of it).
#[derive(Clone, Copy, PartialEq)]
pub(crate) enum By {
    User,
    Script,
}

// HTML "focusing steps" for `target`: an element that is no focusable area replaced by the one it stands for (focus.rs
// `focus_target`: a delegating shadow host's, a label's control) — nothing where there is none — a navigable container
// by its content navigable's document (its viewport), then nothing where that is already the currently focused area of
// its top-level traversable ("If new focus target is the currently focused area of a top-level traversable, then
// return"), else the focus update steps from its top-level traversable's current focus chain to the new one. The area
// focused, where the steps ran to their end (None: a script was terminated).
pub(crate) fn focusing_steps(scope: &mut v8::PinScope<'_, '_>, target: Target, by: By) -> Option<Option<Entry>> {
    let area = match target {
        Target::Element(el) => {
            let Some(found) = crate::focus::focus_target_of(scope, el)? else { return Some(None) };
            let arena = &crate::dom::dom(scope).arena;
            match crate::focus::child_document_realm(arena, found) {
                Some(child) => Entry::Viewport(child),
                None => Entry::Element(found),
            }
        },
        Target::Viewport(realm) => Entry::Viewport(realm),
    };
    let arena = &mut crate::dom::dom(scope).arena;
    let Some(realm) = arena.entry_realm(area) else { return Some(None) };
    let top = arena.top_level_realm(realm);
    // (…a script's in a window that has not the system focus — while another has it — that window's own chain)
    let system_chain = arena.focus_chain();
    let system = by == By::User || system_chain.is_empty() || system_chain.first() == Some(&top);
    let current = if system { arena.currently_focused_area(top) } else { arena.window_focused_area(top) };
    if current == Some(area) {
        // (…a keyboard's re-interaction latches its ring again: `send_keys` to the focused element)
        if let Entry::Element(el) = area {
            arena.latch_focus_ring(el);
        }
        return Some(Some(area));
    }
    let old = current.map_or_else(Vec::new, |c| arena.focus_chain_of(c));
    let new = arena.focus_chain_of(area);
    focus_update(scope, old, new, Some(area), system)?;
    Some(Some(area))
}

// HTML "unfocusing steps" for `el` (`blur()`): a shadow host delegating focus whose shadow tree holds the currently
// focused area is that area; nothing where it is inert or no entry of its top-level traversable's current focus chain;
// else the focusing steps for the top-level document's viewport — the focus out of the element, out of every navigable
// it is in, to the top: the old chain blurred up to there, each document keeping its focused area. (Chrome keeps the
// focus in a frame an element of which is blurred, on its viewport.)
pub(crate) fn unfocusing_steps(scope: &mut v8::PinScope<'_, '_>, el: NodeId) -> Option<()> {
    let arena = &crate::dom::dom(scope).arena;
    let Some(realm) = arena.document_realm_of(el) else { return Some(()) };
    let top = arena.top_level_realm(realm);
    let chain = arena.current_focus_chain(top);
    let mut target = el;
    if let Some(Entry::Element(focused)) = chain.first() {
        let root = arena.get(el).and_then(|n| n.shadow_root);
        if root.is_some_and(|r| arena.get(r).is_some_and(|r| r.shadow_is(crate::dom::SHADOW_DELEGATES_FOCUS)) && arena.shadow_including_ancestor(r, *focused)) {
            target = *focused;
        }
    }
    if arena.is_inert(target) || !chain.contains(&Entry::Element(target)) {
        return Some(());
    }
    let Some(&Entry::Document(top_doc)) = chain.last() else { return Some(()) };
    focusing_steps(scope, Target::Viewport(top_doc), By::Script).map(drop)
}

// HTML "focus update steps" from `old` to `new` (`target`: the new focus target, none where the focus leaves the
// top-level traversable for the user agent's own controls):
//
//   "If the last entry in old chain and the last entry in new chain are the same, pop the last entry from old chain and
//   the last entry from new chain and redo this step. For each entry entry in old chain, in order: … If entry is an
//   element, let blur event target be entry. If entry is a Document object, let blur event target be that Document
//   object's relevant global object. … For each entry entry in new chain, in reverse order: If entry is a focusable
//   area, and the focused area of the document is not entry: … Designate entry as the focused area of the document. If
//   entry is an element, let focus event target be entry. If entry is a Document object, let focus event target be that
//   Document object's relevant global object."
//
// An element of the old chain loses its place as its document's focused area BEFORE its blur — `document.activeElement`
// is the body, and `:focus` matches nothing, while its blur and focusout run — a document the focus leaves for another
// of its traversable's included: HTML designates the new chain's areas and says nothing of the old's, and Chrome and
// Firefox both empty them (measured 2026-11-27: an element blurred in a frame leaves the frame's `activeElement` its
// body). Only the system focus leaving the traversable altogether (no new chain) leaves each document its area, as a
// window deactivated keeps its focused element. It makes the steps re-entrant: a listener that moves the focus finds
// nothing to blur again, and its focusing steps own the result (Discourse's ProseMirror alt text: `onBlur → … →
// view.focus()`), the rest of these left unrun; likewise a `focus` listener's own move ends them before `focusin`
// (Chrome, Firefox). The focus chain moves as the first Window is told (`commit`), so `document.hasFocus()` answers for
// the new one in every Window's `blur` and `focus` (Chrome, Firefox); a window that loses the system focus to the new
// one's has its documents' Windows blurred then, deepest first (HTML's "platform-specific conventions"). A script's
// focus in a window without the system focus (`system` false) moves it in that window alone: no Window event, the
// system focus where it was.
//
// Two explicit steps are kept where Chrome and Firefox both part from them: the container in the new chain gets its
// `focus` and `focusin` (and in the old its `blur`), and a document staying on the chain fires no Window `blur` as the
// focus goes into a frame of it — both engines fire none at the `<iframe>` and blur the page's Window.
fn focus_update(scope: &mut v8::PinScope<'_, '_>, mut old: Vec<Entry>, mut new: Vec<Entry>, target: Option<Entry>, system: bool) -> Option<()> {
    let arena = &mut crate::dom::dom(scope).arena;
    arena.focus_updates = arena.focus_updates.wrapping_add(1);
    let update = arena.focus_updates;
    let new_docs: Vec<i32> = new.iter().filter_map(|e| if let Entry::Document(r) = *e { Some(r) } else { None }).collect();
    let old_docs: Vec<i32> = old.iter().filter_map(|e| if let Entry::Document(r) = *e { Some(r) } else { None }).collect();
    let system_before = arena.focus_chain();
    while !old.is_empty() && old.last() == new.last() {
        old.pop();
        new.pop();
    }
    let element = |e: Option<&Entry>| if let Some(&Entry::Element(el)) = e { Some(el) } else { None };
    let related_blur = element(old.last()).and(element(new.last()));
    let related_focus = element(new.last()).and(element(old.last()));
    let mut committed = false;
    for (k, &entry) in old.iter().enumerate() {
        match entry {
            Entry::Element(el) => {
                let arena = &mut crate::dom::dom(scope).arena;
                if let Some(realm) = arena.document_realm_of(el).filter(|_| !new_docs.is_empty()) {
                    if arena.realm_state(realm).and_then(|st| st.focus) == Some(el) {
                        arena.designate(realm, None);
                    }
                }
                let related = if k + 1 == old.len() { related_blur } else { None };
                fire_focus_event(scope, "focusLost", el, related)?;
            },
            Entry::Document(realm) => {
                if !committed {
                    committed = true;
                    commit(scope, &new_docs, &old_docs, &system_before, system)?;
                }
                if system {
                    window_focus_event(scope, realm, "blur")?;
                }
            },
            Entry::Viewport(_) => {},
        }
        // (…a listener moved the focus itself: its focusing steps own the result)
        if crate::dom::dom(scope).arena.focus_updates != update {
            return Some(());
        }
    }
    if !committed {
        commit(scope, &new_docs, &old_docs, &system_before, system)?;
        // (…a Window the system focus left, blurred there, whose listener moved the focus)
        if crate::dom::dom(scope).arena.focus_updates != update {
            return Some(());
        }
    }
    for (k, &entry) in new.iter().enumerate().rev() {
        match entry {
            Entry::Element(el) => {
                let arena = &mut crate::dom::dom(scope).arena;
                let Some(realm) = arena.document_realm_of(el) else { continue };
                arena.designate(realm, Some(el));
                if target == Some(entry) {
                    // (…a text control's `change` armed for its blur, and its ring latched)
                    arena.enter(realm).change_armed(el);
                    arena.latch_focus_ring(el);
                }
                let related = if k + 1 == new.len() { related_focus } else { None };
                fire_focus_event(scope, "focusGained", el, related)?;
                if crate::dom::dom(scope).arena.focus_updates != update {
                    return Some(());
                }
                fire_focus_event(scope, "focusIn", el, related)?;
            },
            Entry::Viewport(realm) => crate::dom::dom(scope).arena.designate(realm, None),
            Entry::Document(realm) if system => window_focus_event(scope, realm, "focus")?,
            Entry::Document(_) => {},
        }
        if crate::dom::dom(scope).arena.focus_updates != update {
            return Some(());
        }
    }
    Some(())
}

// The focus chain moved to the new one's documents (navigables.rs `set_focused_realm`; the system focus with it where
// `system`), or out of the top-level traversable (`lose_system_focus`) — the Windows of another window's documents that
// lost the system focus to it blurred — and the host told where that moved the chain.
fn commit(scope: &mut v8::PinScope<'_, '_>, new_docs: &[i32], old_docs: &[i32], system_before: &[i32], system: bool) -> Option<()> {
    let arena = &mut crate::dom::dom(scope).arena;
    let changed = match new_docs.first() {
        Some(&realm) => arena.set_focused_realm(realm, system),
        None => arena.lose_system_focus(),
    };
    if !changed {
        return Some(());
    }
    let left: Vec<i32> = system_before.iter().rev().copied().filter(|r| !old_docs.contains(r) && !new_docs.contains(r)).collect();
    for realm in left {
        window_focus_event(scope, realm, "blur")?;
    }
    crate::dom::call_host_step(scope, "focusChanged", &[]).map(drop)
}

fn fire_focus_event(scope: &mut v8::PinScope<'_, '_>, step: &str, el: NodeId, related: Option<NodeId>) -> Option<()> {
    let target = crate::dom::node_value(scope, Some(el));
    let related = crate::dom::node_value(scope, related);
    crate::dom::call_host_step(scope, step, &[target, related]).map(drop)
}
fn window_focus_event(scope: &mut v8::PinScope<'_, '_>, realm: i32, ty: &str) -> Option<()> {
    let realm = v8::Integer::new(scope, realm).into();
    let ty = v8::String::new(scope, ty)?.into();
    crate::dom::call_host_step(scope, "windowFocusEvent", &[realm, ty]).map(drop)
}

// The focus out of realm `realm`'s top-level traversable to the user agent's own controls: sequential navigation past its
// document's last focusable area (HTML §6.6.5: "the user agent should transfer focus to its own controls") — the focus
// update steps from its current focus chain to none, each document keeping its focused area.
fn lose_system_focus(scope: &mut v8::PinScope<'_, '_>, realm: i32) -> Option<()> {
    let arena = &crate::dom::dom(scope).arena;
    let old = arena.current_focus_chain(arena.top_level_realm(realm));
    if old.is_empty() {
        return Some(());
    }
    focus_update(scope, old, Vec::new(), None, true)
}

// HTML "update the rendering"'s focus fixup for realm `realm`'s document: "if the focused area of doc is not a focusable
// area, then run the focusing steps for doc's viewport" — an element hidden, made inert, disabled, given `display: none`
// or `visibility: hidden`, moved into such a subtree. Where its document is not on the focus chain — a frame's the focus
// left, a window without the system focus — that element is no focused one: its viewport takes its place silently, as
// Chrome's (measured 2026-11-27: no events, the page's focus staying where it was) — HTML's focusing steps would take the
// focus into it from wherever it is.
fn focus_fixup(scope: &mut v8::PinScope<'_, '_>, realm: i32) -> Option<()> {
    let arena = &crate::dom::dom(scope).arena;
    let Some(focused) = arena.realm_state(realm).and_then(|st| st.focus).filter(|&f| arena.document_realm_of(f) == Some(realm)) else { return Some(()) };
    if crate::focus::focusable_of(scope, focused)?.unwrap_or(true) {
        return Some(());
    }
    let arena = &mut crate::dom::dom(scope).arena;
    if arena.focus_chain().contains(&realm) {
        focusing_steps(scope, Target::Viewport(realm), By::Script).map(drop)
    } else {
        arena.designate(realm, None);
        Some(())
    }
}

// HTML "flush autofocus candidates" for realm `realm`'s document, a top-level one owed it: its next candidate whose
// document is fully active, of its traversable, with no document of a navigable up from it at a fragment, and which is
// a focusable area or stands for one (HTML "get the focusable area": a delegating shadow host's — no label's control,
// which only `focus()` forwards to), focused — its autofocus processed then; the ones before it dropped. The element
// focused (None: a script was terminated). A candidate whose document has a style sheet blocking scripts is put back,
// the flush ending ("If doc's script-blocking style sheet set is not empty, then return": the currently-best candidate,
// whose document is not ready for autofocusing, tried again next time — script_lists.rs `blocks_scripts`).
fn flush_autofocus_candidates(scope: &mut v8::PinScope<'_, '_>, realm: i32) -> Option<Option<NodeId>> {
    let arena = &mut crate::dom::dom(scope).arena;
    let Some(top) = arena.realm_document(realm) else { return Some(None) };
    if !arena.autofocus.take_pending(top) {
        return Some(None);
    }
    loop {
        let arena = &mut crate::dom::dom(scope).arena;
        let focused = arena.realm_state(realm).is_some_and(|st| st.focus.is_some());
        let Some(el) = arena.autofocus_next(top, focused) else { return Some(None) };
        let Some(own) = arena.document_realm_of(el) else { continue };
        let fully_active = arena.realm_document(own).is_some_and(|d| arena.document_fully_active(d));
        let at_fragment = std::iter::once(own).chain(arena.ancestor_realms(own)).any(|r| arena.realm_document(r).is_some_and(|d| arena.at_fragment(d)));
        if !fully_active || arena.top_level_realm(own) != realm {
            continue;
        }
        if arena.realm_state(own).is_some_and(|st| st.script_lists.blocks_scripts()) {
            arena.autofocus_put_back(top, el);
            return Some(None);
        }
        if at_fragment {
            continue;
        }
        let Some(target) = crate::focus::focusable_area_of(scope, el)? else { continue };
        crate::dom::dom(scope).arena.autofocus_processed(top);
        focusing_steps(scope, Target::Element(target), By::Script)?;
        return Some(Some(target));
    }
}

// HTML "scroll to the fragment"'s focus for realm `cid`'s document, its target element just set: "Run the focusing steps
// for target, with the Document's viewport as the fallback target. Move the sequential focus navigation starting point to
// target." — a link to a fragment taking the focus from the link (Chrome, Firefox).
pub(crate) fn fragment_focus(scope: &mut v8::PinScope<'_, '_>, cid: i32) -> Option<()> {
    let arena = &crate::dom::dom(scope).arena;
    let doc = arena.realm_document(cid)?;
    let target = arena.target_element_of(cid, doc)?;
    let area = match crate::focus::focus_target_of(scope, target)? {
        Some(_) => Target::Element(target),
        None => Target::Viewport(cid),
    };
    focusing_steps(scope, area, By::Script)?;
    crate::dom::dom(scope).arena.enter(cid).focus_start = Some(crate::focus::StartingPoint::Node(target));
    Some(())
}

// The element a press on `n` focuses (focus.rs `press_target`), or, where none can take the focus, its document's
// viewport — the focused element losing it, as Chrome's does on a click outside it (a dropdown closing on blur, an input's
// `change`) — and Tab going on from the node pressed (Chrome).
fn press_focus(scope: &mut v8::PinScope<'_, '_>, n: NodeId) -> Option<()> {
    match crate::focus::press_target_of(scope, n)? {
        Some(target) => focusing_steps(scope, Target::Element(target), By::User).map(drop),
        None => {
            let Some(realm) = crate::dom::dom(scope).arena.document_realm_of(n) else { return Some(()) };
            focusing_steps(scope, Target::Viewport(realm), By::User)?;
            // (…and no element the pointer focused: a script's focus after it shows its ring — Chrome and Firefox,
            // `latch_focus_ring`)
            let arena = crate::dom::dom(scope).arena.enter(realm);
            arena.focus_start = Some(crate::focus::StartingPoint::Node(n));
            arena.pointer_modality = false;
            Some(())
        },
    }
}

// HTML §6.6.5 sequential focus navigation from what has the focus in realm `cid`'s traversable — none where that is a
// document's viewport, or the focus is the user agent's — forwards or `reverse`, across navigables (focus.rs
// `focus_navigation`): the element it comes to focused by the focusing steps, keyboard-driven; past the top-level
// document's end the focus out to the user agent's controls, and the starting point unset, so the next Tab comes back
// in at the start (HTML step 7: "unset the sequential focus navigation starting point"; Chrome). Whether the focus moved
// to an element.
fn sequential_navigation(scope: &mut v8::PinScope<'_, '_>, cid: i32, reverse: bool) -> Option<bool> {
    let arena = &crate::dom::dom(scope).arena;
    let top = arena.top_level_realm(cid);
    let from = match arena.currently_focused_area(top) {
        Some(Entry::Element(el)) => Some((arena.document_realm_of(el)?, Some(el))),
        Some(Entry::Viewport(realm)) => Some((realm, None)),
        _ => None,
    };
    let (realm, current) = from.unwrap_or((cid, None));
    match crate::focus::focus_navigation(scope, realm, current, reverse) {
        Some((to_realm, next)) => {
            crate::dom::dom(scope).arena.enter(to_realm).keyboard_modality();
            focusing_steps(scope, Target::Element(next), By::User)?;
            Some(true)
        },
        None => {
            // (…every document's of the old chain, and the one the navigation began in: none comes back from where it left)
            let mut docs = crate::dom::dom(scope).arena.focus_chain();
            docs.push(cid);
            lose_system_focus(scope, realm)?;
            for doc in docs {
                crate::dom::dom(scope).arena.enter(doc).focus_start = None;
            }
            Some(false)
        },
    }
}

// `window.focus()` of realm `realm`'s window: HTML "run the focusing steps with current" (its navigable) — its document,
// which keeps its focused area: the focus goes back to that (a browser's window regaining the focus refocuses what had
// it), its viewport where it has none. (HTML would designate the viewport, blurring a focused input of a page that calls
// `window.focus()` on itself, which no browser does.)
fn focus_window(scope: &mut v8::PinScope<'_, '_>, realm: i32) -> Option<()> {
    let arena = &mut crate::dom::dom(scope).arena;
    if arena.realm_document(realm).is_none() || !crate::focus::allow_focus_steps(arena, realm) {
        return Some(());
    }
    // (…a document with the focus already — the focus in it, or in a frame of it — keeps it where it is)
    if arena.focus_chain().contains(&realm) {
        return Some(());
    }
    let area = arena.kept_area(realm);
    let top = arena.top_level_realm(realm);
    if arena.currently_focused_area(top) == Some(area) {
        return Some(());
    }
    let old = arena.current_focus_chain(top);
    let new = arena.focus_chain_of(area);
    focus_update(scope, old, new, Some(area), true)
}

// The system focus to the window of realm `top`, as the window manager gives it: a pop-up `window.open` made with
// transient activation, as it is made (Chrome: its document has the focus by its load; Firefox: once loaded — and one a
// script opened with none leaves it with the opener, measured 2026-11-27) — the window that had it its Windows blurred
// (`commit`) — and back to the opener's as one that had it closes (navigables.rs `discard_window`), its Windows
// their `focus` and what its document kept its own, as a browser's window regaining the focus fires them (WPT
// document-has-system-focus; headless Chrome and Firefox, measured 2026-11-27, refocus nothing as a pop-up closes: no
// window manager does it there).
pub(crate) fn window_takes_system_focus(scope: &mut v8::PinScope<'_, '_>, top: i32) -> Option<()> {
    let arena = &crate::dom::dom(scope).arena;
    let area = arena.kept_area(top);
    let new = arena.focus_chain_of(area);
    focus_update(scope, Vec::new(), new, Some(area), true)
}

// ── the ops ──────────────────────────────────────────────────────────────────────────────────────────────────────────
pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "focusingSteps", focusing_steps_op, context_id);
    crate::dom::register(scope, ns, "focusMethod", focus_method_op, context_id);
    crate::dom::register(scope, ns, "focusCentred", focus_centred_op, context_id);
    crate::dom::register(scope, ns, "unfocusingSteps", unfocusing_steps_op, context_id);
    crate::dom::register(scope, ns, "focusViewport", focus_viewport_op, context_id);
    crate::dom::register(scope, ns, "pressFocus", press_focus_op, context_id);
    crate::dom::register(scope, ns, "sequentialFocus", sequential_focus_op, context_id);
    crate::dom::register(scope, ns, "focusWindow", focus_window_op, context_id);
    crate::dom::register(scope, ns, "focusFixup", focus_fixup_op, context_id);
    crate::dom::register(scope, ns, "flushAutofocus", flush_autofocus_op, context_id);
    crate::dom::register(scope, ns, "holdsFocus", holds_focus_op, context_id);
    crate::dom::register(scope, ns, "windowOpened", window_opened_op, context_id);
    crate::dom::register(scope, ns, "systemFocusHere", system_focus_here_op, context_id);
    crate::dom::register(scope, ns, "systemFocusAway", system_focus_away_op, context_id);
}

// __dom.systemFocusHere() — the window manager's focus given to this realm's window, as the driver switches to it (a
// WebDriver "switch to window" activates it): its Windows their `focus` and what its documents kept theirs, the window
// that had the system focus in this isolate its Windows blurred (`window_takes_system_focus`) — nothing where it has it.
fn system_focus_here_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = crate::dom::realm_id(scope, &args);
    if crate::dom::dom(scope).arena.focus_chain().first() != Some(&cid) {
        window_takes_system_focus(scope, cid);
    }
}
// __dom.systemFocusAway() — …and taken from this isolate's windows for a window of another browsing context group (a
// `noopener` pop-up's isolate): what has the focus blurred, its Windows with it, each document keeping its area
// (`lose_system_focus`), so only one window's documents have focus.
fn system_focus_away_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = crate::dom::realm_id(scope, &args);
    lose_system_focus(scope, cid);
}

// __dom.windowOpened(realm, activated): a new window `window.open` made — realm `realm`'s — the system focus's where the
// script that opened it ran with transient activation (`activated`: as `open` began, before the pop-up's own steps
// consumed it), as a window manager gives it to a window a user's gesture opened (`window_takes_system_focus`).
fn window_opened_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(realm) = args.get(0).int32_value(scope) else { return };
    if args.get(1).is_true() && crate::dom::dom(scope).arena.focus_chain().first() != Some(&realm) {
        window_takes_system_focus(scope, realm);
    }
}

// Whether what the focusing steps focused (`area`) is a focusable area no more — a `:focus`-conditioned style took its
// box (`#host:focus { display: none }`): its focus is committed, `getComputedStyle` reads `none` right after `focus()`,
// and the next rendering update's fixup resets it, a frame owed for it.
fn fixup_owed(scope: &mut v8::PinScope<'_, '_>, area: Option<Entry>) -> bool {
    let Some(Entry::Element(el)) = area else { return false };
    crate::focus::document_focus(&crate::dom::dom(scope).arena, el) == Some(el) && crate::focus::focusable_of(scope, el).flatten() == Some(false)
}

// __dom.focusingSteps(nid, pointer) -> whether a rendering update is owed the focus fixup (`fixup_owed`): HTML's focusing
// steps for the element — the driver's own focusing, a label's activation (`pointer`: a pointer's click, which shows no
// ring — WPT css/selectors focus-visible-026), a reported validity problem, `select()`.
fn focusing_steps_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(el) = crate::dom::nid_arg(scope, &args, 0) else { return rv.set_bool(false) };
    if args.get(1).is_true() {
        let arena = &mut crate::dom::dom(scope).arena;
        if let Some(realm) = arena.document_realm_of(el) {
            arena.enter(realm).pointer_modality = true;
        }
    }
    let Some(area) = focusing_steps(scope, Target::Element(el), By::User) else { return };
    rv.set_bool(fixup_owed(scope, area));
}

// What `focusMethod` answers, where the allow focus steps did not refuse: the focus moved (or focused nothing), the
// fixup owed a frame for it, or the element is focused, and centred, already — what its scroll into view would leave as it
// is: nothing moved since `focus()` last scrolled it (`focusCentred`), the plan skipped.
const FOCUS_MOVED: u32 = 0;
const FOCUS_FIXUP_OWED: u32 = 1;
const FOCUS_CENTRED: u32 = 2;
// The generations a scroll into view depends on: the layout's and the tree's, the style state's, the scroll's.
fn centring_generations(arena: &RealmArena) -> [u32; 8] {
    std::array::from_fn(|i| arena.generations.get(i))
}

// __dom.focusMethod(nid, focusVisible) -> `FOCUS_*`, or undefined where the allow focus steps refused: HTMLOrSVGElement's `focus(options)` — "If the allow focus steps given this's node document return
// false, then return. Run the focusing steps for this. If options["focusVisible"] is true, or does not exist but in an
// implementation-defined way the user agent determines it would be best to do so, then indicate focus" (`focusVisible`:
// 1 true, 0 false, -1 absent, the ring then latched as the focus moved). The bindings scroll this into view after, unless
// `preventScroll`.
fn focus_method_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(el) = crate::dom::nid_arg(scope, &args, 0) else { return };
    let visible = args.get(1).int32_value(scope).unwrap_or(-1);
    let arena = &mut crate::dom::dom(scope).arena;
    let Some(realm) = arena.document_realm_of(el) else { return };
    if !crate::focus::allow_focus_steps(arena, realm) {
        return;
    }
    let before = arena.realm_state(realm).and_then(|st| st.focus);
    let Some(area) = focusing_steps(scope, Target::Element(el), By::Script) else { return };
    let Some(area) = area else { return rv.set_uint32(FOCUS_MOVED) };
    let arena = crate::dom::dom(scope).arena.enter(realm);
    if before.map(Entry::Element) == Some(area) && arena.focus_centred == Some((el, centring_generations(arena))) {
        return rv.set_uint32(FOCUS_CENTRED);
    }
    if let (Entry::Element(focused), true) = (area, visible >= 0) {
        let arena = &mut crate::dom::dom(scope).arena;
        if let Some(realm) = arena.document_realm_of(focused).filter(|_| crate::focus::document_focus(arena, focused) == Some(focused)) {
            arena.enter(realm).set_focus_ring(if visible == 0 { crate::dom::RING_HIDDEN } else { crate::dom::RING_SHOWN });
        }
    }
    rv.set_uint32(if fixup_owed(scope, Some(area)) { FOCUS_FIXUP_OWED } else { FOCUS_MOVED });
}
// __dom.focusCentred(nid) — `focus()` scrolled the element of this realm into view just now (`focusMethod`).
fn focus_centred_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(el) = crate::dom::nid_arg(scope, &args, 0) else { return };
    let cid = crate::dom::realm_id(scope, &args);
    let arena = crate::dom::realm(scope, cid);
    arena.focus_centred = Some((el, centring_generations(arena)));
}

// __dom.unfocusingSteps(nid): HTMLOrSVGElement's `blur()` (`unfocusing_steps`).
fn unfocusing_steps_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(el) = crate::dom::nid_arg(scope, &args, 0) else { return };
    unfocusing_steps(scope, el);
}

// __dom.focusViewport(nid): the focusing steps for the viewport of the document the node is in — the driver's keys sent
// to a document's body or root, which focus no element.
fn focus_viewport_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(n) = crate::dom::nid_arg(scope, &args, 0) else { return };
    let Some(realm) = crate::dom::dom(scope).arena.document_realm_of(n) else { return };
    focusing_steps(scope, Target::Viewport(realm), By::User);
}

// __dom.pressFocus(nid): what a pointer's press on the node focuses (`press_focus`) — pointer-driven, its ring hidden.
fn press_focus_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(n) = crate::dom::nid_arg(scope, &args, 0) else { return };
    let arena = &mut crate::dom::dom(scope).arena;
    let Some(realm) = arena.document_realm_of(n) else { return };
    arena.enter(realm).pointer_modality = true;
    press_focus(scope, n);
}

// __dom.sequentialFocus(reverse) -> whether Tab (Shift+Tab, `reverse`) moved the focus to an element
// (`sequential_navigation`), from this realm's traversable.
fn sequential_focus_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let reverse = args.get(0).is_true();
    let cid = crate::dom::realm_id(scope, &args);
    if let Some(moved) = sequential_navigation(scope, cid, reverse) {
        rv.set_bool(moved);
    }
}

// __dom.focusWindow(): the Window's `focus()` (`focus_window`).
fn focus_window_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = crate::dom::realm_id(scope, &args);
    focus_window(scope, cid);
}

// __dom.focusFixup(): the rendering update's focus fixup for this realm's document (`focus_fixup`).
fn focus_fixup_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = crate::dom::realm_id(scope, &args);
    focus_fixup(scope, cid);
}

// __dom.flushAutofocus() -> the element focused, or null: the rendering update's "flush autofocus candidates" for this
// realm's document, where it is a top-level one owed it (`flush_autofocus_candidates`).
fn flush_autofocus_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = crate::dom::realm_id(scope, &args);
    let focused = flush_autofocus_candidates(scope, cid).flatten();
    rv.set(crate::dom::node_value(scope, focused));
}

// __dom.holdsFocus(nid) -> whether the node is, or is a shadow-including ancestor of, the element its document has
// focused: a move of it may leave that no focusable area, and the focus fixup is owed a frame.
fn holds_focus_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(n) = crate::dom::nid_arg(scope, &args, 0) else { return rv.set_bool(false) };
    let arena = &crate::dom::dom(scope).arena;
    rv.set_bool(crate::focus::document_focus(arena, n).is_some_and(|f| f == n || arena.shadow_including_ancestor(n, f)));
}
