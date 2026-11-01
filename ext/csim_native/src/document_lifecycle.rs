// A document's load lifecycle (HTML "the end", "update the current document readiness", "completely finish loading",
// "abort a document", the document open steps): its readiness, the DOMContentLoaded and the load "the end" queues for it,
// its page showing, its being completely loaded — kept with the document's state (document_state.rs) and decided here.
// The bindings ask what is due and fire what that says (bridge.entry.js `__csimLoadDocument`, `__csimTaskOfTheEnd`,
// `__csimFireWindowLoad`); the events are theirs, the decisions are the engine's.

use crate::dom::{nid_arg, realm_id, NodeId};
use crate::frame_navigation::LOAD_DELAYED;

pub(crate) const READY_LOADING: u32 = 0;
const READY_INTERACTIVE: u32 = 1;
pub(crate) const READY_COMPLETE: u32 = 2;

#[derive(Clone, Copy)]
pub(crate) struct Lifecycle {
    // Its readiness (HTML "current document readiness"): 0 loading, 1 interactive, 2 complete.
    pub(crate) ready: u32,
    // The number of the document loaded into the Document object — one is used again: a reload in place, the initial
    // about:blank's Window a navigation to a document of its origin keeps, a `document.open()` — what "the end"'s tasks
    // name the document they are for by, a later one's none of theirs (`DocumentStates::next_generation`).
    generation: u32,
    // …and the number it was given as it began to load, which a `document.open()` leaves: what tells whether the
    // document was there as something was done (storage_areas.rs `storage_event_targets`).
    began: u32,
    // Its DOMContentLoaded fired (HTML "the end" step 6, a task), its load fired at its window (step 9, a task once nothing
    // delays it), its page showing (step 9: true as `pageshow` fires, false as "unload a document" fires `pagehide`),
    // and its being completely loaded (HTML "completely finish loading": after `pageshow`).
    content_loaded: bool,
    load_fired: bool,
    page_showing: bool,
    completely_loaded: bool,
    // Opened (HTML document open steps) since it was loaded: what is written into it the document "the end" is owed for
    // from then on, whose load its container's follows — but where its mute iframe load flag is set: opened while its
    // container's `load` was being fired, the load its written document comes to fires none at that container.
    opened: bool,
    mute_iframe_load: bool,
    // Aborted while its parser was active (HTML "navigate" → "abort a document and its descendants" → "abort a parser"):
    // "the end" runs for it no more — no DOMContentLoaded, no load of its own, none at its container.
    aborted: bool,
}

// A document no parse loads (a `createHTMLDocument` one, a DOMParser's) is complete as it is made (DOM "create a
// document"), and nothing of "the end" is owed it.
impl Default for Lifecycle {
    fn default() -> Self {
        Lifecycle {
            ready: READY_COMPLETE,
            generation: 0,
            began: 0,
            content_loaded: false,
            load_fired: false,
            page_showing: false,
            completely_loaded: false,
            opened: false,
            mute_iframe_load: false,
            aborted: false,
        }
    }
}

impl Lifecycle {
    pub(crate) fn generation(self) -> u32 {
        self.generation
    }
    pub(crate) fn began(self) -> u32 {
        self.began
    }
    // A document begins to load into the Document object (HTML "create and initialize a Document object", the parse
    // that follows), numbered `generation`: loading, nothing of "the end" done for it.
    pub(crate) fn begin(&mut self, generation: u32) {
        *self = Lifecycle { ready: READY_LOADING, generation, began: generation, ..Lifecycle::default() };
    }
    // HTML "update the current document readiness" to `ready`: whether that changed it — what fires `readystatechange`,
    // the bindings' to fire.
    fn update_readiness(&mut self, ready: u32) -> bool {
        std::mem::replace(&mut self.ready, ready) != ready
    }
    // HTML "abort a parser", where its parser is active: whether it was.
    pub(crate) fn abort_parser(&mut self) -> bool {
        if self.ready != READY_LOADING {
            return false;
        }
        self.aborted = true;
        true
    }
    // HTML document open steps: a document of its own written into it from here, numbered `generation` — "the end" of its
    // parse owed nothing of what the last one had (a task of that one's still queued, for its number, fires nothing) —
    // its container's load muted where it was being fired as it was opened, and loading again: whether that changed its
    // readiness.
    fn open(&mut self, generation: u32, muted: bool) -> bool {
        self.generation = generation;
        self.content_loaded = false;
        self.load_fired = false;
        self.completely_loaded = false;
        self.aborted = false;
        self.opened = true;
        self.mute_iframe_load |= muted;
        self.update_readiness(READY_LOADING)
    }
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "docLoadBegin", load_begin, context_id);
    crate::dom::register(scope, ns, "docOpen", open, context_id);
    crate::dom::register(scope, ns, "docTheEnd", the_end, context_id);
    crate::dom::register(scope, ns, "docContentLoadedDue", content_loaded_due, context_id);
    crate::dom::register(scope, ns, "docLoadDue", load_due, context_id);
    crate::dom::register(scope, ns, "docLoadSteps", load_steps, context_id);
    crate::dom::register(scope, ns, "docShowPage", show_page, context_id);
    crate::dom::register(scope, ns, "docHidePage", hide_page, context_id);
    crate::dom::register(scope, ns, "docFinishLoading", finish_loading, context_id);
    crate::dom::register(scope, ns, "docCompletelyLoaded", completely_loaded, context_id);
    crate::dom::register(scope, ns, "docCompleteInitial", complete_initial, context_id);
}

fn lifecycle_of<'s>(scope: &'s mut v8::PinScope<'_, '_>, doc: NodeId) -> &'s mut Lifecycle {
    crate::dom::dom(scope).arena.document_states.lifecycle_mut(doc)
}

// __dom.docLoadBegin(docNid) -> the number of the document the calling realm's Document object begins to load (its
// `Lifecycle::begin`) — and the realm's load delay none: what delayed the last document's load is that one's.
fn load_begin(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(doc) = nid_arg(scope, &args, 0) else { return rv.set_uint32(0) };
    let cid = realm_id(scope, &args);
    let arena = crate::dom::realm(scope, cid);
    if let Some(state) = arena.realm_state_mut(cid) {
        state.load_delay = 0;
    }
    let generation = arena.document_states.next_generation();
    arena.document_states.lifecycle_mut(doc).begin(generation);
    rv.set_uint32(generation);
}

// __dom.docOpen(docNid, muted) -> whether the document's readiness changed as it is opened (`Lifecycle::open`), `muted`
// where its container's load is being fired now.
fn open(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(doc) = nid_arg(scope, &args, 0) else { return rv.set_bool(false) };
    let muted = args.get(1).is_true();
    let states = &mut crate::dom::dom(scope).arena.document_states;
    let generation = states.next_generation();
    rv.set_bool(states.lifecycle_mut(doc).open(generation, muted));
}

// __dom.docTheEnd(docNid) -> whether HTML "the end" step 3 changed the document's readiness: `interactive` from
// `loading` (none of a document past that already).
fn the_end(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(doc) = nid_arg(scope, &args, 0) else { return rv.set_bool(false) };
    let lc = lifecycle_of(scope, doc);
    rv.set_bool(lc.ready == READY_LOADING && lc.update_readiness(READY_INTERACTIVE));
}

// __dom.docContentLoadedDue(docNid, generation) -> whether "the end"'s DOMContentLoaded task for document `generation`
// fires it — taken: the document is that one still, not aborted, and none was fired for it.
fn content_loaded_due(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(doc) = nid_arg(scope, &args, 0) else { return rv.set_bool(false) };
    let generation = args.get(1).uint32_value(scope).unwrap_or(0);
    let lc = lifecycle_of(scope, doc);
    let due = lc.generation == generation && lc.ready != READY_LOADING && !lc.aborted && !lc.content_loaded;
    lc.content_loaded |= due;
    rv.set_bool(due);
}

// Whether "the end"'s load task is due (`docLoadDue`): not, for a parsed document, or for a written one — whose
// container's load follows its own, but where it was muted.
const NOT_DUE: u32 = 0;
const DUE_PARSED: u32 = 1;
const DUE_WRITTEN: u32 = 2;
const DUE_WRITTEN_MUTED: u32 = 3;

// __dom.docLoadDue(docNid, generation) -> whether "the end"'s load task for document `generation` is due, and for what
// document: the document is that one still, past its parse (interactive), and its load not fired yet.
fn load_due(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(doc) = nid_arg(scope, &args, 0) else { return rv.set_uint32(NOT_DUE) };
    let generation = args.get(1).uint32_value(scope).unwrap_or(0);
    let lc = lifecycle_of(scope, doc);
    rv.set_uint32(match () {
        _ if lc.generation != generation || lc.ready != READY_INTERACTIVE || lc.load_fired => NOT_DUE,
        _ if !lc.opened => DUE_PARSED,
        _ if lc.mute_iframe_load => DUE_WRITTEN_MUTED,
        _ => DUE_WRITTEN,
    });
}

// What the load steps of a document come to (`docLoadSteps`) — `LOAD_FIRE` with `READY_CHANGED` where its readiness
// changed to complete.
const LOAD_NONE: u32 = 0;
const LOAD_ABORTED: u32 = 1;
const LOAD_DELAYED_NOW: u32 = 2;
const LOAD_FIRE: u32 = 3;
const READY_CHANGED: u32 = 4;

// __dom.docLoadSteps(runGate) -> what HTML "the end" steps 8-9 come to for the calling realm's document as its load task
// runs: nothing where its load fired already; `LOAD_ABORTED` where a navigation aborted it as it parsed — its load
// delays its parent's no more; else its load gates run (`runGate(id)` each: load_gates.rs `flush`), then
// `LOAD_DELAYED_NOW` where something delays its load still (its images, its frames: `load_delayed_here`) — fired once
// nothing does — or `LOAD_FIRE`: its load fired from here, nothing delaying it, its readiness `complete` (step 9.1).
fn load_steps(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    rv.set_uint32(LOAD_NONE);
    let cid = realm_id(scope, &args);
    let Some(doc) = crate::dom::realm(scope, cid).realm_document(cid) else { return };
    let lc = lifecycle_of(scope, doc);
    if lc.load_fired {
        return;
    }
    if lc.aborted {
        set_load_delay(scope, cid, 0);
        return rv.set_uint32(LOAD_ABORTED);
    }
    if let Ok(run) = v8::Local::<v8::Function>::try_from(args.get(0)) {
        crate::load_gates::flush(scope, cid, run);
    }
    // (…a gate's work may have fired it: a frame built, whose build fired this one's load re-entrantly)
    let arena = crate::dom::realm(scope, cid);
    if arena.document_states.lifecycle(doc).load_fired {
        return;
    }
    if arena.load_delayed_here(cid) {
        if let Some(state) = arena.realm_state_mut(cid) {
            // (…a container's load owed stays owed)
            if state.load_delay == 0 {
                state.load_delay = LOAD_DELAYED;
            }
        }
        return rv.set_uint32(LOAD_DELAYED_NOW);
    }
    set_load_delay(scope, cid, 0);
    let lc = lifecycle_of(scope, doc);
    lc.load_fired = true;
    let changed = lc.update_readiness(READY_COMPLETE);
    rv.set_uint32(LOAD_FIRE | if changed { READY_CHANGED } else { 0 });
}
fn set_load_delay(scope: &mut v8::PinScope<'_, '_>, cid: i32, delay: u8) {
    if let Some(state) = crate::dom::realm(scope, cid).realm_state_mut(cid) {
        state.load_delay = delay;
    }
}

// __dom.docShowPage(docNid) — the document's page showing (HTML "the end" step 9, as `pageshow` fires).
fn show_page(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(doc) = nid_arg(scope, &args, 0) else { return };
    lifecycle_of(scope, doc).page_showing = true;
}

// __dom.docHidePage(docNid) -> whether the document's page was showing, which it is no more (HTML "unload a document":
// `pagehide` fired, the document hidden, where it was) — none of an initial about:blank, which no parse ends, nor of a
// document left before its load.
fn hide_page(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(doc) = nid_arg(scope, &args, 0) else { return rv.set_bool(false) };
    let lc = lifecycle_of(scope, doc);
    rv.set_bool(std::mem::take(&mut lc.page_showing));
}

// __dom.docFinishLoading(docNid) — the document completely loaded (HTML "completely finish loading").
fn finish_loading(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(doc) = nid_arg(scope, &args, 0) else { return };
    lifecycle_of(scope, doc).completely_loaded = true;
}

// __dom.docCompletelyLoaded(docNid) -> whether the document is completely loaded — before it is, a navigation it plans
// replaces its session history entry, and what waits for it waits.
fn completely_loaded(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(doc) = nid_arg(scope, &args, 0) else { return rv.set_bool(false) };
    rv.set_bool(crate::dom::dom(scope).arena.document_states.lifecycle(doc).completely_loaded);
}

// __dom.docCompleteInitial(docNid) — a new window's initial about:blank, which no parse makes (HTML "create a new
// browsing context and document"): complete and completely loaded as it is made — no DOMContentLoaded, no load, no
// `pageshow`, which only "the end" of a parse fires, nor any later.
fn complete_initial(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(doc) = nid_arg(scope, &args, 0) else { return };
    let lc = lifecycle_of(scope, doc);
    *lc = Lifecycle {
        ready: READY_COMPLETE,
        generation: lc.generation,
        content_loaded: true,
        load_fired: true,
        completely_loaded: true,
        ..Lifecycle::default()
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_document_loaded_again_owes_the_end_anew() {
        let mut lc = Lifecycle::default();
        assert_eq!(lc.ready, READY_COMPLETE);
        lc.begin(1);
        assert!(lc.update_readiness(READY_INTERACTIVE));
        lc.content_loaded = true;
        lc.load_fired = true;
        lc.page_showing = true;
        lc.begin(2);
        assert_eq!((lc.generation, lc.ready), (2, READY_LOADING));
        assert!(!lc.content_loaded && !lc.load_fired && !lc.page_showing && !lc.aborted);
    }

    #[test]
    fn a_readiness_update_says_whether_it_changed_it() {
        let mut lc = Lifecycle::default();
        assert!(!lc.update_readiness(READY_COMPLETE));
        assert!(lc.update_readiness(READY_LOADING));
    }

    #[test]
    fn only_an_active_parser_is_aborted() {
        let mut lc = Lifecycle::default();
        assert!(!lc.abort_parser());
        lc.begin(1);
        assert!(lc.abort_parser());
        assert!(lc.aborted);
        lc.begin(2);
        assert!(!lc.aborted);
    }

    #[test]
    fn an_open_document_owes_its_written_content_the_end() {
        let mut lc = Lifecycle::default();
        lc.begin(1);
        lc.update_readiness(READY_COMPLETE);
        lc.content_loaded = true;
        lc.load_fired = true;
        assert!(lc.open(2, true));
        assert_eq!((lc.generation, lc.began, lc.ready), (2, 1, READY_LOADING));
        assert!(!lc.content_loaded && !lc.load_fired && lc.opened && lc.mute_iframe_load);
        assert!(!lc.open(3, false));
        assert!(lc.mute_iframe_load);
        lc.begin(4);
        assert!(!lc.opened && !lc.mute_iframe_load);
    }
}
