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

    // `:focus-visible` latched as `el` is focused, in its realm: shown unless the user's last input there was a pointer's
    // and `el` is no TEXT ENTRY — a textarea, a textual `<input>`, an editable element — whose ring a browser shows
    // however focus came to it (Chrome; Selectors 4's heuristics: "If the active element matches :focus-visible, and a
    // script causes focus to move elsewhere, the newly focused element should match :focus-visible", and a script's focus
    // after a click that showed none shows none).
    pub(crate) fn latch_focus_ring(&mut self, el: NodeId) {
        let Some(realm) = self.document_realm_of(el) else { return };
        let arena = self.enter(realm);
        let text_entry = arena.get(el).filter(|n| n.kind == NodeKind::Element).is_some_and(|n| {
            n.is_html_named("textarea") || (n.is_html_named("input") && n.input_has(crate::input_types::TEXTUAL)) || arena.is_editable(el)
        });
        let hidden = arena.pointer_modality && !text_entry;
        arena.set_focus_ring_hidden(hidden);
    }
    // …and the user's keyboard input in the realm entered: what is focused there shows its ring from now on ("If the user
    // interacts with the page via keyboard, the currently focused element should match :focus-visible"; Chrome, a Shift
    // pressed at a button a click focused).
    pub(crate) fn keyboard_modality(&mut self) {
        self.pointer_modality = false;
        self.set_focus_ring_hidden(false);
    }
}

// What the focusing steps take: an element (a focusable area, or one standing for one) or a document's viewport.
#[derive(Clone, Copy)]
pub(crate) enum Target {
    Element(NodeId),
    Viewport(i32),
}

// HTML "focusing steps" for `target`: an element that is no focusable area replaced by the one it stands for (focus.rs
// `focus_target`: a delegating shadow host's, a label's control) — nothing where there is none — a navigable container
// by its content navigable's document (its viewport), then nothing where that is already the currently focused area of
// its top-level traversable ("If new focus target is the currently focused area of a top-level traversable, then
// return"), else the focus update steps from its top-level traversable's current focus chain to the new one. The area
// focused, where the steps ran to their end (None: a script was terminated).
pub(crate) fn focusing_steps(scope: &mut v8::PinScope<'_, '_>, target: Target) -> Option<Option<Entry>> {
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
    if arena.currently_focused_area(top) == Some(area) {
        // (…a keyboard's re-interaction latches its ring again: `send_keys` to the focused element)
        if let Entry::Element(el) = area {
            arena.latch_focus_ring(el);
        }
        return Some(Some(area));
    }
    let old = arena.current_focus_chain(top);
    let new = arena.focus_chain_of(area);
    focus_update(scope, old, new, Some(area))?;
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
    focusing_steps(scope, Target::Viewport(top_doc)).map(drop)
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
// An element of the old chain whose document the new chain designates an area of loses its place as that document's
// focused area BEFORE its blur — `document.activeElement` is the body, and `:focus` matches nothing, while its blur and
// focusout run (Chrome) — which makes the steps re-entrant: a listener that moves the focus finds nothing to blur
// again, and its focusing steps own the result (Discourse's ProseMirror alt text: `onBlur → … → view.focus()`), the rest
// of these left unrun. A document the new chain leaves keeps its focused area, as HTML designates only the new chain's.
// The focus chain moves as the first Window is told (`commit`), so `document.hasFocus()` answers for the new one in
// every Window's `blur` and `focus` (Chrome); a window that loses the system focus to the new one's has its documents'
// Windows blurred then, deepest first (HTML's "platform-specific conventions").
fn focus_update(scope: &mut v8::PinScope<'_, '_>, mut old: Vec<Entry>, mut new: Vec<Entry>, target: Option<Entry>) -> Option<()> {
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
                if let Some(realm) = arena.document_realm_of(el).filter(|r| new_docs.contains(r)) {
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
                    commit(scope, &new_docs, &old_docs, &system_before)?;
                }
                window_focus_event(scope, realm, "blur")?;
            },
            Entry::Viewport(_) => {},
        }
        // (…a listener moved the focus itself: its focusing steps own the result)
        if crate::dom::dom(scope).arena.focus_updates != update {
            return Some(());
        }
    }
    if !committed {
        commit(scope, &new_docs, &old_docs, &system_before)?;
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
            },
            Entry::Viewport(realm) => crate::dom::dom(scope).arena.designate(realm, None),
            Entry::Document(realm) => window_focus_event(scope, realm, "focus")?,
        }
        if crate::dom::dom(scope).arena.focus_updates != update {
            return Some(());
        }
    }
    Some(())
}

// The focus chain moved to the new one's documents (navigables.rs `set_focused_realm`), or out of the top-level
// traversable (`lose_system_focus`) — the Windows of another window's documents that lost the system focus to it
// blurred — and the host told where that moved the chain.
fn commit(scope: &mut v8::PinScope<'_, '_>, new_docs: &[i32], old_docs: &[i32], system_before: &[i32]) -> Option<()> {
    let arena = &mut crate::dom::dom(scope).arena;
    let changed = match new_docs.first() {
        Some(&realm) => arena.set_focused_realm(realm),
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
    focus_update(scope, old, Vec::new(), None)
}

// HTML "update the rendering"'s focus fixup for realm `realm`'s document: "if the focused area of doc is not a focusable
// area, then run the focusing steps for doc's viewport" — an element hidden, made inert, disabled, given `display: none`
// or `visibility: hidden`, moved into such a subtree. Where its document is not on the focus chain, that element is no
// focused one: its viewport takes its place silently, as Chrome's (measured 2026-11-27: no events, the page's focus
// staying where it was) — HTML's focusing steps would take the focus into the frame from wherever it is.
fn focus_fixup(scope: &mut v8::PinScope<'_, '_>, realm: i32) -> Option<()> {
    let arena = &crate::dom::dom(scope).arena;
    let Some(focused) = arena.realm_state(realm).and_then(|st| st.focus).filter(|&f| arena.document_realm_of(f) == Some(realm)) else { return Some(()) };
    if crate::focus::focusable_of(scope, focused)?.unwrap_or(true) {
        return Some(());
    }
    let arena = &mut crate::dom::dom(scope).arena;
    if arena.on_focus_chain(realm) {
        focusing_steps(scope, Target::Viewport(realm)).map(drop)
    } else {
        arena.designate(realm, None);
        Some(())
    }
}

// HTML "flush autofocus candidates" for realm `realm`'s document, a top-level one owed it: its next candidate whose
// document is fully active, of its traversable, with no document of a navigable up from it at a fragment, and which is
// (or stands for) a focusable area, focused — its autofocus processed then; the ones before it dropped. The element
// focused (None: a script was terminated).
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
        if !fully_active || arena.top_level_realm(own) != realm || at_fragment {
            continue;
        }
        let Some(target) = crate::focus::focus_target_of(scope, el)? else { continue };
        crate::dom::dom(scope).arena.autofocus_processed(top);
        focusing_steps(scope, Target::Element(target))?;
        return Some(Some(target));
    }
}

// The element a press on `n` focuses (focus.rs `press_target`), or, where none can take the focus, its document's
// viewport — the focused element losing it, as Chrome's does on a click outside it (a dropdown closing on blur, an input's
// `change`) — and Tab going on from the node pressed (Chrome).
fn press_focus(scope: &mut v8::PinScope<'_, '_>, n: NodeId) -> Option<()> {
    match crate::focus::press_target_of(scope, n)? {
        Some(target) => focusing_steps(scope, Target::Element(target)).map(drop),
        None => {
            let Some(realm) = crate::dom::dom(scope).arena.document_realm_of(n) else { return Some(()) };
            focusing_steps(scope, Target::Viewport(realm))?;
            crate::dom::dom(scope).arena.enter(realm).focus_start = Some(n);
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
            focusing_steps(scope, Target::Element(next))?;
            Some(true)
        },
        None => {
            lose_system_focus(scope, realm)?;
            crate::dom::dom(scope).arena.enter(realm).focus_start = None;
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
    let kept = arena.realm_state(realm).and_then(|st| st.focus).filter(|&f| arena.document_realm_of(f) == Some(realm));
    let area = kept.map_or(Entry::Viewport(realm), Entry::Element);
    let top = arena.top_level_realm(realm);
    if arena.currently_focused_area(top) == Some(area) {
        return Some(());
    }
    let old = arena.current_focus_chain(top);
    let new = arena.focus_chain_of(area);
    focus_update(scope, old, new, Some(area))
}

// ── the ops ──────────────────────────────────────────────────────────────────────────────────────────────────────────
pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "focusingSteps", focusing_steps_op, context_id);
    crate::dom::register(scope, ns, "focusMethod", focus_method_op, context_id);
    crate::dom::register(scope, ns, "unfocusingSteps", unfocusing_steps_op, context_id);
    crate::dom::register(scope, ns, "focusViewport", focus_viewport_op, context_id);
    crate::dom::register(scope, ns, "pressFocus", press_focus_op, context_id);
    crate::dom::register(scope, ns, "sequentialFocus", sequential_focus_op, context_id);
    crate::dom::register(scope, ns, "focusWindow", focus_window_op, context_id);
    crate::dom::register(scope, ns, "focusFixup", focus_fixup_op, context_id);
    crate::dom::register(scope, ns, "flushAutofocus", flush_autofocus_op, context_id);
    crate::dom::register(scope, ns, "holdsFocus", holds_focus_op, context_id);
}

// Whether what the focusing steps focused (`area`) is a focusable area no more — a `:focus`-conditioned style took its
// box (`#host:focus { display: none }`): its focus is committed, `getComputedStyle` reads `none` right after `focus()`,
// and the next rendering update's fixup resets it, a frame owed for it.
fn fixup_owed(scope: &mut v8::PinScope<'_, '_>, area: Option<Entry>) -> bool {
    let Some(Entry::Element(el)) = area else { return false };
    crate::focus::document_focus(&crate::dom::dom(scope).arena, el) == Some(el) && crate::focus::focusable_of(scope, el).flatten() == Some(false)
}

// __dom.focusingSteps(nid) -> whether a rendering update is owed the focus fixup (`fixup_owed`): HTML's focusing steps
// for the element — the driver's own focusing, a label's activation, a reported validity problem, `select()`.
fn focusing_steps_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(el) = crate::dom::nid_arg(scope, &args, 0) else { return rv.set_bool(false) };
    let Some(area) = focusing_steps(scope, Target::Element(el)) else { return };
    rv.set_bool(fixup_owed(scope, area));
}

// __dom.focusMethod(nid, focusVisible) -> [the element focused, or null; whether a rendering update is owed the focus
// fixup], or undefined where nothing was focused: HTMLOrSVGElement's `focus(options)` — "If the allow focus steps given
// this's node document return false, then return. Run the focusing steps for this. If options["focusVisible"] is true, or
// does not exist but in an implementation-defined way the user agent determines it would be best to do so, then indicate
// focus" (`focusVisible`: 1 true, 0 false, -1 absent, the ring then latched as the focus moved). The bindings scroll the
// element into view after, unless `preventScroll`.
fn focus_method_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(el) = crate::dom::nid_arg(scope, &args, 0) else { return };
    let visible = args.get(1).int32_value(scope).unwrap_or(-1);
    let arena = &mut crate::dom::dom(scope).arena;
    let Some(realm) = arena.document_realm_of(el) else { return };
    if !crate::focus::allow_focus_steps(arena, realm) {
        return;
    }
    let Some(Some(Entry::Element(focused))) = focusing_steps(scope, Target::Element(el)) else { return };
    let arena = &mut crate::dom::dom(scope).arena;
    let holds = arena.document_realm_of(focused).and_then(|r| arena.realm_state(r)).and_then(|st| st.focus) == Some(focused);
    if !holds {
        return;
    }
    if visible >= 0 {
        let Some(realm) = arena.document_realm_of(focused) else { return };
        arena.enter(realm).set_focus_ring_hidden(visible == 0);
    }
    let owed = fixup_owed(scope, Some(Entry::Element(focused)));
    let focused = crate::dom::node_value(scope, Some(focused));
    let owed = v8::Boolean::new(scope, owed).into();
    rv.set(v8::Array::new_with_elements(scope, &[focused, owed]).into());
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
    focusing_steps(scope, Target::Viewport(realm));
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
