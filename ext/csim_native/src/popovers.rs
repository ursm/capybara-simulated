// The popover API (HTML §6.12): "show popover", "hide popover", "hide popovers until" and "hide popover stack until" over
// a document's showing auto and hint popover lists — the auto and hint popovers of its top layer, in the order they went
// in — its "showing popover" flag and "hiding popover nesting count" (no popover shown during another's show or hide), its
// hint stack parent, each popover's "popover hiding" flag, its close watcher (close_watchers.rs) and the element focused as
// the first of a stack showed, which hiding it gives focus back to; the popover focusing steps; light dismiss; the
// `popovertarget` and popover command invokers' steps. The events — `beforetoggle`, `toggle` — and the focusing steps are
// the bindings' to run (toggle_tasks.rs, `hostSteps`); everything they decide is here.

use std::collections::{HashMap, HashSet};

use crate::close_watchers::{OrTerminated, Owner, Stop};
use crate::toggle_tasks::Tracker;
use crate::dom::{dom, NodeData, NodeId, RealmArena, STATE_MODAL, STATE_POPOVER_OPEN};

// A `popover` attribute's state, of its value (none: no attribute): none, auto (empty, `auto`), hint, or manual (any other
// value, `manual` an invalid one too) — ASCII case-insensitively. A showing popover's "opened in popover mode" is AUTO or
// HINT, MANUAL standing for null.
pub(crate) const NONE: u32 = 0;
pub(crate) const AUTO: u32 = 1;
pub(crate) const HINT: u32 = 2;
pub(crate) const MANUAL: u32 = 3;
pub(crate) fn popover_state(value: Option<&str>) -> u32 {
    match value {
        None => NONE,
        Some(v) if v.is_empty() || v.eq_ignore_ascii_case("auto") => AUTO,
        Some(v) if v.eq_ignore_ascii_case("hint") => HINT,
        Some(_) => MANUAL,
    }
}
// …whether an element is a popover: an HTML one whose `popover` is in any state but none (the attribute an HTML
// element's: none of an SVG or MathML one makes it a popover).
pub(crate) fn is_popover(n: &NodeData) -> bool {
    n.is_html() && n.plain_attr("popover").is_some()
}
fn state_of(n: &NodeData) -> u32 {
    if n.is_html() { popover_state(n.plain_attr("popover")) } else { NONE }
}

// A document's popover state: its top layer's showing popovers in the order they went in, each with the mode it was
// opened in (the showing auto and hint popover lists are its AUTO and HINT entries); its "showing popover" flag and
// "hiding popover nesting count"; its hint stack parent; and its popover and dialog pointerdown targets (light dismiss).
#[derive(Default)]
pub(crate) struct PopoverDoc {
    top_layer: Vec<(NodeId, u32)>,
    showing: bool,
    hiding: u32,
    hint_parent: Option<NodeId>,
    pointerdown: [Option<NodeId>; 2],
}
impl PopoverDoc {
    fn idle(&self) -> bool {
        self.top_layer.is_empty() && !self.showing && self.hiding == 0 && self.hint_parent.is_none() && self.pointerdown == [None, None]
    }
}

// The popovers' state the arena keeps (`RealmArena::popovers`): each document's, by its slot; the document each showing
// popover is in, and its popover trigger — the invoker or source that showed it, where one did; the popovers being
// hidden ("popover hiding").
#[derive(Default)]
pub(crate) struct Popovers {
    docs: HashMap<NodeId, PopoverDoc>,
    shown_in: HashMap<NodeId, NodeId>,
    triggers: HashMap<NodeId, NodeId>,
    hiding: HashSet<NodeId>,
}
impl Popovers {
    // What of it is a node's that `live` says is gone forgotten.
    pub(crate) fn retain(&mut self, live: impl Fn(&NodeId) -> bool) {
        self.docs.retain(|doc, d| {
            d.top_layer.retain(|(p, _)| live(p));
            live(doc)
        });
        self.shown_in.retain(|p, doc| live(p) && live(doc));
        self.triggers.retain(|p, t| live(p) && live(t));
        self.hiding.retain(|p| live(p));
    }
    // …and what of it is node `id`'s, freed.
    pub(crate) fn forget(&mut self, id: NodeId) {
        if self.docs.is_empty() && self.shown_in.is_empty() && self.triggers.is_empty() {
            return;
        }
        self.docs.remove(&id);
        for d in self.docs.values_mut() {
            d.top_layer.retain(|&(p, _)| p != id);
        }
        self.shown_in.remove(&id);
        self.triggers.retain(|&p, &mut t| p != id && t != id);
        self.hiding.remove(&id);
    }
    // The showing popovers that have a popover trigger, by their trigger (HTML: each such trigger a focus navigation scope
    // owner, the popovers in its scope — focus.rs).
    pub(crate) fn triggered(&self) -> HashMap<NodeId, Vec<NodeId>> {
        let mut by_trigger: HashMap<NodeId, Vec<NodeId>> = HashMap::new();
        for (&popover, &trigger) in &self.triggers {
            by_trigger.entry(trigger).or_default().push(popover);
        }
        by_trigger
    }
}

impl RealmArena {
    fn popover_doc(&mut self, doc: NodeId) -> &mut PopoverDoc {
        self.popovers.docs.entry(doc).or_default()
    }
    fn settle_popover_doc(&mut self, doc: NodeId) {
        if self.popovers.docs.get(&doc).is_some_and(PopoverDoc::idle) {
            self.popovers.docs.remove(&doc);
        }
    }
    // Document `doc`'s showing popover list of `mode` (AUTO or HINT), bottom first.
    fn popover_list(&self, doc: NodeId, mode: u32) -> Vec<NodeId> {
        self.popovers.docs.get(&doc).map_or_else(Vec::new, |d| d.top_layer.iter().filter(|&&(_, m)| m == mode).map(|&(p, _)| p).collect())
    }
    // The mode a showing popover was opened in (NONE for one not showing, MANUAL for a manual one).
    fn opened_mode(&self, el: NodeId) -> u32 {
        let Some(doc) = self.popovers.shown_in.get(&el) else { return NONE };
        self.popovers.docs.get(doc).and_then(|d| d.top_layer.iter().find(|&&(p, _)| p == el)).map_or(NONE, |&(_, m)| m)
    }
    // HTML "topmost auto or hint popover" of document `doc`.
    fn topmost_auto_or_hint(&self, doc: NodeId) -> Option<NodeId> {
        self.popover_list(doc, HINT).last().or(self.popover_list(doc, AUTO).last()).copied()
    }
    // The popover pointerdown target or dialog pointerdown target (`kind` 0, 1) of document `doc`, set and read.
    pub(crate) fn set_pointerdown_target(&mut self, doc: NodeId, kind: usize, target: Option<NodeId>) {
        self.popover_doc(doc).pointerdown[kind] = target;
        self.settle_popover_doc(doc);
    }
    pub(crate) fn pointerdown_target(&self, doc: NodeId, kind: usize) -> Option<NodeId> {
        self.popovers.docs.get(&doc).and_then(|d| d.pointerdown[kind])
    }
    // HTML "topmost popover ancestor" of `el` — a popover about to show, or a dialog — in its document `doc`: of the auto
    // list then the hint list, the last one `el` is a flat tree descendant of, or `source` is (an invoker's), whichever is
    // later; none for neither. A source that is itself a showing popover is its own: `showPopover({source: popover})`
    // keeps that popover open (WPT imperative-invokers, popover-hint-hierarchy; Chrome, Firefox), where the spec's "flat
    // tree descendant" would not count it.
    pub(crate) fn topmost_popover_ancestor(&self, doc: NodeId, el: NodeId, source: Option<NodeId>) -> Option<NodeId> {
        let up = |from: Option<NodeId>| -> HashSet<NodeId> { std::iter::successors(from, |&n| crate::geometry::flat_parent(self, n)).collect() };
        let mut combined = self.popover_list(doc, AUTO);
        combined.extend(self.popover_list(doc, HINT));
        let last_of = |set: &HashSet<NodeId>| combined.iter().rposition(|p| set.contains(p));
        let of_el = last_of(&up(crate::geometry::flat_parent(self, el)));
        let of_source = source.and_then(|s| last_of(&up(Some(s))));
        of_el.max(of_source).map(|i| combined[i])
    }
    // HTML "nearest inclusive open popover": `id` or its nearest flat tree ancestor that is a showing auto or hint
    // popover.
    fn nearest_open_popover(&self, id: NodeId) -> Option<NodeId> {
        std::iter::successors(Some(id), |&n| crate::geometry::flat_parent(self, n)).find(|&n| matches!(self.opened_mode(n), AUTO | HINT))
    }
    // HTML "nearest inclusive target popover": `id` or its nearest flat tree ancestor whose target popover is a showing
    // auto or hint popover — that popover.
    fn nearest_target_popover(&self, id: NodeId) -> Option<NodeId> {
        std::iter::successors(Some(id), |&n| crate::geometry::flat_parent(self, n))
            .filter_map(|n| crate::activation::invoked_popover(self, n))
            .find(|&p| self.get(p).is_some_and(|d| d.state & STATE_POPOVER_OPEN != 0 && matches!(state_of(d), AUTO | HINT)))
    }
    // HTML "popover stack position" of a popover in document `doc`: past the autos for a hint, 0 for none.
    fn stack_position(&self, doc: NodeId, p: Option<NodeId>) -> usize {
        let Some(p) = p else { return 0 };
        let (autos, hints) = (self.popover_list(doc, AUTO), self.popover_list(doc, HINT));
        if let Some(i) = hints.iter().position(|&h| h == p) {
            return i + autos.len() + 1;
        }
        autos.iter().position(|&a| a == p).map_or(0, |i| i + 1)
    }
    // HTML "topmost clicked popover" for a press on `id` in document `doc`: of its nearest inclusive open popover and the
    // popover its nearest invoker shows, the one higher in the stack.
    fn topmost_clicked_popover(&self, doc: NodeId, id: NodeId) -> Option<NodeId> {
        let (clicked, target) = (self.nearest_open_popover(id), self.nearest_target_popover(id));
        if self.stack_position(doc, clicked) > self.stack_position(doc, target) { clicked } else { target }
    }

    // A popover shown in document `doc`, opened in `mode`, by `trigger`: into its top layer, `:popover-open`.
    fn popover_in(&mut self, doc: NodeId, el: NodeId, mode: u32, trigger: Option<NodeId>) {
        let d = self.popover_doc(doc);
        d.top_layer.retain(|&(p, _)| p != el);
        d.top_layer.push((el, mode));
        self.popovers.shown_in.insert(el, doc);
        if let Some(trigger) = trigger {
            self.popovers.triggers.insert(el, trigger);
        }
        self.set_popover_open(el, true);
    }
    // …and one hidden: out of its document's top layer — the hint stack parent no more where it was one, or no hint is
    // left — its close watcher destroyed, and the element its showing kept to give focus back to taken.
    fn popover_out(&mut self, el: NodeId) -> Option<NodeId> {
        self.popovers.triggers.remove(&el);
        if let Some(doc) = self.popovers.shown_in.remove(&el) {
            let d = self.popover_doc(doc);
            d.top_layer.retain(|&(p, _)| p != el);
            if d.hint_parent == Some(el) || !d.top_layer.iter().any(|&(_, m)| m == HINT) {
                d.hint_parent = None;
            }
            self.settle_popover_doc(doc);
        }
        self.set_popover_open(el, false);
        self.destroy_element_close_watcher(el);
        self.previously_focused.remove(&el)
    }
    fn set_popover_open(&mut self, el: NodeId, open: bool) {
        let Some((realm, bits)) = self.get(el).map(|n| (n.realm, n.state)) else { return };
        let bits = if open { bits | STATE_POPOVER_OPEN } else { bits & !STATE_POPOVER_OPEN };
        self.enter(realm).set_state(el, bits);
    }

    // HTML "hide popover" given `el`, false, false and false — no event fired, no focus moved — as its removing steps
    // hide a popover: the popovers above it in its lists hidden alike first (HTML "hide popover stack until"). One a hide
    // of its own is under way for — its listener removed it — is hidden all the same, that hide finding it hidden.
    pub(crate) fn hide_popover_quietly(&mut self, el: NodeId) {
        let Some(&doc) = self.popovers.shown_in.get(&el) else { return self.set_popover_open(el, false) };
        let nested = !self.popovers.hiding.insert(el);
        if matches!(self.opened_mode(el), AUTO | HINT) {
            let in_hints = self.popover_list(doc, HINT).contains(&el);
            let in_autos = self.popover_list(doc, AUTO).contains(&el);
            if in_hints {
                self.hide_stack_quietly(doc, Some(el), HINT);
            }
            if self.popovers.docs.get(&doc).and_then(|d| d.hint_parent) == Some(el) {
                self.hide_stack_quietly(doc, None, HINT);
            }
            if in_autos {
                self.hide_stack_quietly(doc, Some(el), AUTO);
            }
        }
        self.popover_out(el);
        if !nested {
            self.popovers.hiding.remove(&el);
        }
    }
    fn hide_stack_quietly(&mut self, doc: NodeId, endpoint: Option<NodeId>, mode: u32) {
        let list = self.popover_list(doc, mode);
        let at = endpoint.and_then(|e| list.iter().position(|&p| p == e)).map_or(0, |i| i + 1);
        for &p in list[at..].iter().rev() {
            self.hide_popover_quietly(p);
        }
    }
}

// What "check popover validity" refuses, and the other exceptions showing and hiding throw (the bindings' messages, by
// these codes): no `popover`, NotSupportedError; disconnected, of a document not fully active, moved to another document,
// a modal dialog, during another popover's show or hide, its `popover` changed while others were hidden —
// InvalidStateError.
const NOT_A_POPOVER: u32 = 1;
const DISCONNECTED: u32 = 2;
const NOT_FULLY_ACTIVE: u32 = 3;
const OTHER_DOCUMENT: u32 = 4;
const MODAL_DIALOG: u32 = 5;
const DURING_SHOW: u32 = 6;
const DURING_HIDE: u32 = 7;
const TYPE_CHANGED: u32 = 8;

// HTML "check popover validity" of `el`, expected to be showing or not, in `expected_doc` where given: Ok(true) where it
// may be shown or hidden, Ok(false) where it already is as asked, the exception it throws otherwise. A showing popover
// whose `popover` attribute is gone — its attribute change steps hiding it — is still one to hide, where the spec's
// check stops the hide at once and leaves it showing: whatwg/html#9367, open; Chrome and Firefox hide it, its events
// fired, as WPT popover-attribute-basic asks.
fn check_validity(scope: &mut v8::PinScope<'_, '_>, el: NodeId, expected_showing: bool, expected_doc: Option<NodeId>) -> Result<bool, u32> {
    let doc = crate::dom::node_document(scope, el);
    let arena = &dom(scope).arena;
    let n = arena.get(el).ok_or(NOT_A_POPOVER)?;
    let showing = n.state & STATE_POPOVER_OPEN != 0;
    if !is_popover(n) && !(showing && expected_showing) {
        return Err(NOT_A_POPOVER);
    }
    if showing != expected_showing {
        return Ok(false);
    }
    if !expected_showing && !arena.is_connected(el) {
        return Err(DISCONNECTED);
    }
    if !expected_showing && !doc.is_some_and(|d| arena.document_fully_active(d)) {
        return Err(NOT_FULLY_ACTIVE);
    }
    if expected_doc.is_some() && doc != expected_doc {
        return Err(OTHER_DOCUMENT);
    }
    if n.is_html_named("dialog") && n.state & STATE_MODAL != 0 {
        return Err(MODAL_DIALOG);
    }
    Ok(true)
}
// …as a step takes it: whether to go on, else where to stop — thrown, where it throws.
fn valid(scope: &mut v8::PinScope<'_, '_>, el: NodeId, expected_showing: bool, expected_doc: Option<NodeId>, throws: bool) -> Result<bool, Stop> {
    match check_validity(scope, el, expected_showing, expected_doc) {
        Ok(go) => Ok(go),
        Err(code) if throws => Err(Stop::Throw(code)),
        Err(_) => Ok(false),
    }
}
// A host step's answer, a terminated script stopping the algorithm.
fn alive<T>(answer: Option<T>) -> Result<T, Stop> {
    answer.ok_or(Stop::Terminated)
}

// HTML "show popover" of `el`, throwing where `throws` (a script's), by `source` (an invoker's, or none).
pub(crate) fn show_popover(scope: &mut v8::PinScope<'_, '_>, el: NodeId, throws: bool, source: Option<NodeId>) -> Result<(), Stop> {
    let Some(doc) = crate::dom::node_document(scope, el) else { return valid(scope, el, false, None, throws).map(drop) };
    let busy = dom(scope).arena.popovers.docs.get(&doc).map_or(0, |d| if d.showing { DURING_SHOW } else if d.hiding > 0 { DURING_HIDE } else { 0 });
    if busy != 0 {
        return if throws { Err(Stop::Throw(busy)) } else { Ok(()) };
    }
    if !valid(scope, el, false, None, throws)? {
        return Ok(());
    }
    dom(scope).arena.popover_doc(doc).showing = true;
    let shown = show_steps(scope, el, doc, throws, source);
    let arena = &mut dom(scope).arena;
    arena.popover_doc(doc).showing = false;
    arena.settle_popover_doc(doc);
    shown
}
fn show_steps(scope: &mut v8::PinScope<'_, '_>, el: NodeId, doc: NodeId, throws: bool, source: Option<NodeId>) -> Result<(), Stop> {
    if !alive(crate::toggle_tasks::fire_before_toggle(scope, el, true, source))? || !valid(scope, el, false, Some(doc), throws)? {
        return Ok(());
    }
    let mut restore_focus = false;
    let original = dom(scope).arena.get(el).map_or(NONE, state_of);
    let mut mode = MANUAL;
    let mut ancestor = None;
    if matches!(original, AUTO | HINT) {
        let arena = &dom(scope).arena;
        ancestor = arena.topmost_popover_ancestor(doc, el, source);
        // (…an auto popover whose ancestor is a hint one is "downgraded" to a hint: an auto cannot be a hint's child)
        mode = if ancestor.is_some_and(|a| arena.opened_mode(a) == HINT) { HINT } else { original };
        hide_popover_stack_until(scope, doc, ancestor, HINT, false, true)?;
        if mode == AUTO {
            hide_popover_stack_until(scope, doc, ancestor, AUTO, false, true)?;
        }
        if dom(scope).arena.get(el).map_or(NONE, state_of) != original {
            return if throws { Err(Stop::Throw(TYPE_CHANGED)) } else { Ok(()) };
        }
        if !valid(scope, el, false, Some(doc), throws)? {
            return Ok(());
        }
        restore_focus = dom(scope).arena.topmost_auto_or_hint(doc).is_none();
    }
    let arena = &mut dom(scope).arena;
    if mode != MANUAL {
        let realm = arena.get(doc).map_or(0, |d| d.realm);
        arena.set_element_close_watcher(el, realm, Owner::Popover(el));
    }
    arena.previously_focused.remove(&el);
    let originally_focused = crate::focus::document_focus(arena, el);
    arena.popover_in(doc, el, mode, source);
    if mode == HINT && ancestor.is_some_and(|a| arena.opened_mode(a) == AUTO) {
        arena.popover_doc(doc).hint_parent = ancestor;
    }
    alive(popover_focusing_steps(scope, el))?;
    let arena = &mut dom(scope).arena;
    if let Some(focused) = originally_focused.filter(|_| restore_focus && arena.get(el).is_some_and(is_popover)) {
        arena.previously_focused.insert(el, focused);
    }
    alive(crate::toggle_tasks::queue_toggle_task(scope, el, Tracker::Popover, false, true, source))
}

// HTML "hide popover" of `el`: the popovers above it hidden first, moving focus back where `focus_previous`, firing their
// events and its own where `fire_events`, throwing where `throws` (a script's), by `source` (an invoker's, or none).
pub(crate) fn hide_popover(
    scope: &mut v8::PinScope<'_, '_>,
    el: NodeId,
    focus_previous: bool,
    fire_events: bool,
    throws: bool,
    source: Option<NodeId>,
) -> Result<(), Stop> {
    if !valid(scope, el, true, None, throws)? {
        return Ok(());
    }
    let Some(doc) = crate::dom::node_document(scope, el) else { return Ok(()) };
    let arena = &mut dom(scope).arena;
    let nested = !arena.popovers.hiding.insert(el);
    arena.popover_doc(doc).hiding += 1;
    let hidden = hide_steps(scope, el, doc, focus_previous, fire_events && !nested, throws, source);
    let arena = &mut dom(scope).arena;
    if !nested {
        arena.popovers.hiding.remove(&el);
    }
    let d = arena.popover_doc(doc);
    d.hiding = d.hiding.saturating_sub(1);
    arena.settle_popover_doc(doc);
    hidden
}
fn hide_steps(
    scope: &mut v8::PinScope<'_, '_>,
    el: NodeId,
    doc: NodeId,
    focus_previous: bool,
    fire_events: bool,
    throws: bool,
    source: Option<NodeId>,
) -> Result<(), Stop> {
    let arena = &dom(scope).arena;
    if matches!(arena.opened_mode(el), AUTO | HINT) {
        let in_hints = arena.popover_list(doc, HINT).contains(&el);
        let in_autos = arena.popover_list(doc, AUTO).contains(&el);
        if in_hints {
            hide_popover_stack_until(scope, doc, Some(el), HINT, focus_previous, fire_events)?;
        }
        if dom(scope).arena.popovers.docs.get(&doc).and_then(|d| d.hint_parent) == Some(el) {
            hide_popover_stack_until(scope, doc, None, HINT, focus_previous, fire_events)?;
        }
        if in_autos {
            hide_popover_stack_until(scope, doc, Some(el), AUTO, focus_previous, fire_events)?;
        }
        if !valid(scope, el, true, Some(doc), throws)? {
            return Ok(());
        }
    }
    if fire_events {
        alive(crate::toggle_tasks::fire_before_toggle(scope, el, false, source))?;
        if !valid(scope, el, true, Some(doc), throws)? {
            return Ok(());
        }
    }
    let previous = dom(scope).arena.popover_out(el);
    if fire_events {
        alive(crate::toggle_tasks::queue_toggle_task(scope, el, Tracker::Popover, true, false, source))?;
    }
    // (…focus back to it where the focus is in the popover still: "the focused area of the document's DOM anchor is a
    // shadow-including inclusive descendant of element")
    let arena = &dom(scope).arena;
    let holds = crate::focus::document_focus(arena, el).is_some_and(|f| arena.shadow_including_ancestor(el, f));
    if let Some(previous) = previous.filter(|_| focus_previous && holds) {
        alive(crate::focus::run_focusing_steps(scope, previous))?;
    }
    Ok(())
}

// HTML "hide popovers until" `endpoint` (none: the document) in document `doc`: the hints above it, then the autos above it
// — above the hint stack parent, for a hint.
pub(crate) fn hide_popovers_until(scope: &mut v8::PinScope<'_, '_>, doc: NodeId, endpoint: Option<NodeId>, focus_previous: bool, fire_events: bool) -> Result<(), Stop> {
    let endpoint_is_hint = endpoint.is_some_and(|e| dom(scope).arena.popover_list(doc, HINT).contains(&e));
    hide_popover_stack_until(scope, doc, endpoint, HINT, focus_previous, fire_events)?;
    let auto_endpoint = if endpoint_is_hint { dom(scope).arena.popovers.docs.get(&doc).and_then(|d| d.hint_parent) } else { endpoint };
    hide_popover_stack_until(scope, doc, auto_endpoint, AUTO, focus_previous, fire_events)
}

// HTML "hide popover stack until" `endpoint` in document `doc`'s list of `mode`: those above it as it stands hidden, the
// topmost first — then, without events, any its events showed meanwhile.
fn hide_popover_stack_until(scope: &mut v8::PinScope<'_, '_>, doc: NodeId, endpoint: Option<NodeId>, mode: u32, focus_previous: bool, fire_events: bool) -> Result<(), Stop> {
    let list = dom(scope).arena.popover_list(doc, mode);
    let at = endpoint.and_then(|e| list.iter().position(|&p| p == e)).map_or(0, |i| i + 1);
    let (remain, hide) = list.split_at(at);
    for &p in hide.iter().rev() {
        hide_popover(scope, p, focus_previous, fire_events, false, None)?;
    }
    for p in dom(scope).arena.popover_list(doc, mode).into_iter().rev() {
        if !remain.contains(&p) {
            hide_popover(scope, p, focus_previous, false, false, None)?;
        }
    }
    Ok(())
}

// HTML "popover focusing steps" of `el`, just shown — none where its document may not take focus ("allow focus steps"):
// a dialog's are the dialog focusing steps; any other's focus it
// where it carries `autofocus`, else its autofocus delegate, if any — and its top-level document's autofocus is
// processed, where that is of its origin.
fn popover_focusing_steps(scope: &mut v8::PinScope<'_, '_>, el: NodeId) -> Option<()> {
    let arena = &mut dom(scope).arena;
    let Some(realm) = arena.get(el).map(|n| n.realm) else { return Some(()) };
    if !crate::focus::allow_focus_steps(arena, realm) {
        return Some(());
    }
    if arena.get(el).is_some_and(|n| n.is_html_named("dialog")) {
        return crate::dialogs::dialog_focusing_steps(scope, el);
    }
    let Some(control) = crate::focus::popover_focus_control(scope, el)? else { return Some(()) };
    crate::focus::run_focusing_steps(scope, control)?;
    crate::autofocus::processed_for(scope, control);
    Some(())
}

// HTML "light dismiss open popovers" for a user's `pointerdown` (`down`) or `pointerup` on `target` in document `doc`:
// the topmost clicked popover recorded at the press, and at the release — on the same one — the popovers above it hidden.
fn light_dismiss_open_popovers(scope: &mut v8::PinScope<'_, '_>, doc: NodeId, target: NodeId, down: bool) -> Option<()> {
    let arena = &mut dom(scope).arena;
    if arena.topmost_auto_or_hint(doc).is_none() {
        return Some(());
    }
    let clicked = if target == doc { None } else { arena.topmost_clicked_popover(doc, target) };
    if down {
        arena.set_pointerdown_target(doc, 0, clicked);
        return Some(());
    }
    let same = arena.pointerdown_target(doc, 0) == clicked;
    arena.set_pointerdown_target(doc, 0, None);
    if !same {
        return Some(());
    }
    hide_popovers_until(scope, doc, clicked, false, true).or_terminated()
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "showPopover", show_popover_op, context_id);
    crate::dom::register(scope, ns, "hidePopover", hide_popover_op, context_id);
    crate::dom::register(scope, ns, "togglePopover", toggle_popover_op, context_id);
    crate::dom::register(scope, ns, "popoverTargetSteps", popover_target_steps_op, context_id);
    crate::dom::register(scope, ns, "popoverAttributeChanged", popover_attribute_changed_op, context_id);
    crate::dom::register(scope, ns, "lightDismiss", light_dismiss_op, context_id);
}

// An algorithm's end as an op answers it: 0, or the code of the exception the bindings throw — none set where a script
// was terminated, whose exception the op ends with.
pub(crate) fn answer(mut rv: v8::ReturnValue<'_, v8::Value>, ended: Result<(), Stop>) {
    match ended {
        Ok(()) => rv.set_uint32(0),
        Err(Stop::Throw(code)) => rv.set_uint32(code),
        Err(Stop::Terminated) => {}
    }
}

// __dom.showPopover(element, source) -> `showPopover()`'s end (`answer`): HTML "show popover", a script's.
fn show_popover_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(el) = crate::node_handle::nid_of(scope, args.get(0)) else { return answer(rv, Err(Stop::Throw(NOT_A_POPOVER))) };
    let source = crate::node_handle::nid_of(scope, args.get(1));
    answer(rv, show_popover(scope, el, true, source));
}
// __dom.hidePopover(element) -> `hidePopover()`'s end: HTML "hide popover", a script's, focus moved back.
fn hide_popover_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(el) = crate::node_handle::nid_of(scope, args.get(0)) else { return answer(rv, Err(Stop::Throw(NOT_A_POPOVER))) };
    answer(rv, hide_popover(scope, el, true, true, true, None));
}
// __dom.togglePopover(element, force, source) -> `togglePopover()`'s end, `force` 1 true, 0 false, -1 none: a showing
// one hidden but where forced to show, a hidden one shown but where forced to hide — then only checked.
fn toggle_popover_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(el) = crate::node_handle::nid_of(scope, args.get(0)) else { return answer(rv, Err(Stop::Throw(NOT_A_POPOVER))) };
    let force = args.get(1).int32_value(scope).unwrap_or(-1);
    let source = crate::node_handle::nid_of(scope, args.get(2));
    let showing = dom(scope).arena.get(el).is_some_and(|n| n.state & STATE_POPOVER_OPEN != 0);
    let ended = if showing && force != 1 {
        hide_popover(scope, el, true, true, true, None)
    } else if force != 0 {
        show_popover(scope, el, true, source)
    } else {
        check_validity(scope, el, showing, None).map(drop).map_err(Stop::Throw)
    };
    answer(rv, ended);
}

// What an invoker asks of its popover: toggle it, show a hidden one, hide a showing one.
const TOGGLE: u32 = 0;
const SHOW: u32 = 1;
const HIDE: u32 = 2;

// __dom.popoverTargetSteps(popover, action, invoker) — HTML "popover target attribute activation behavior" past finding
// the popover, and a popover's command steps: a showing one hidden (focus back) unless the action is show, a hidden one
// shown where it may be unless the action is hide — the invoker the source, nothing thrown.
fn popover_target_steps_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(popover) = crate::node_handle::nid_of(scope, args.get(0)) else { return };
    let action = args.get(1).uint32_value(scope).unwrap_or(TOGGLE);
    let invoker = crate::node_handle::nid_of(scope, args.get(2));
    let showing = dom(scope).arena.get(popover).is_some_and(|n| n.state & STATE_POPOVER_OPEN != 0);
    if showing && action != SHOW {
        let _ = hide_popover(scope, popover, true, true, false, invoker);
    } else if !showing && action != HIDE && check_validity(scope, popover, false, None) == Ok(true) {
        let _ = show_popover(scope, popover, false, invoker);
    }
}

// __dom.popoverAttributeChanged(element) — HTML's `popover` attribute change steps for a showing popover whose
// attribute's state changed, its attribute gone too (`check_validity`): hidden, with its events and focus moved back.
fn popover_attribute_changed_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(el) = crate::node_handle::nid_of(scope, args.get(0)) else { return };
    let _ = hide_popover(scope, el, true, true, false, None);
}

// __dom.lightDismiss(target, down, x, y) — HTML "run light dismiss activities" for a user's `pointerdown` (`down`) or
// `pointerup` on `target` at client (x, y): the popovers', then the dialogs' (dialogs.rs) — nothing to do in a page with
// neither showing.
fn light_dismiss_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let arena = &dom(scope).arena;
    if arena.popovers.docs.is_empty() && arena.open_dialogs.is_empty() {
        return;
    }
    let Some(target) = crate::node_handle::nid_of(scope, args.get(0)) else { return };
    let down = args.get(1).is_true();
    let point = (args.get(2).number_value(scope).unwrap_or(0.0), args.get(3).number_value(scope).unwrap_or(0.0));
    let doc = if dom(scope).arena.is_document(target) { Some(target) } else { crate::dom::node_document(scope, target) };
    let Some(doc) = doc else { return };
    if light_dismiss_open_popovers(scope, doc, target, down).is_none() {
        return;
    }
    crate::dialogs::light_dismiss_open_dialogs(scope, doc, target, point, down);
}
