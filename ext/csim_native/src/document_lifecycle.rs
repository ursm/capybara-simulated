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
    pub(crate) completely_loaded: bool,
    // Opened (HTML document open steps) since it was loaded: what is written into it the document "the end" is owed for
    // from then on, whose load its container's follows — but where its mute iframe load flag is set: opened while its
    // container's `load` was being fired, the load its written document comes to fires none at that container.
    opened: bool,
    mute_iframe_load: bool,
    // Its DOMContentLoaded's task over: "the end" has only its load left to do.
    content_loaded_over: bool,
    // How many aborts have come to it: what a fetch of its begun before the last of them finds cancelled (`docAborts`) — and
    // that count as the module graph being fetched began, none for no graph (`docModuleFetches`).
    aborts: u32,
    module_fetches: Option<u32>,
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
            content_loaded_over: false,
            aborts: 0,
            module_fetches: None,
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
    // HTML "abort a parser", where its parser is active: whether it was. A navigation of its document's aborts the parse
    // alone (as it is planned, from a script the parse runs); `stop()` also what "the end" has left of it, up to its load
    // (Chrome and Firefox: none after a `stop()` in a DOMContentLoaded handler, nor with an image of its own pending) — the
    // caller's to spare one left waiting on its frames alone (`abort_parser_op`). Its readiness is the bindings' to step on,
    // firing `readystatechange` (`docAbortStep`): as the abort itself for `stop()`, as the parse leaves off for a navigation.
    pub(crate) fn abort_parser(&mut self, to_its_load: bool) -> bool {
        if self.aborted || self.load_fired || !(self.ready == READY_LOADING || (to_its_load && self.ready == READY_INTERACTIVE)) {
            return false;
        }
        self.aborted = true;
        true
    }
    // Whether it is completely loaded: a navigation of its frame's attributes replaces its entry until then.
    pub(crate) fn is_completely_loaded(&self) -> bool {
        self.completely_loaded
    }
    // Whether its parser was aborted: its load never fires.
    pub(crate) fn is_aborted(&self) -> bool {
        self.aborted
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
        self.content_loaded_over = false;
        self.mute_iframe_load |= muted;
        self.update_readiness(READY_LOADING)
    }
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "docLoadBegin", load_begin, context_id);
    crate::dom::register(scope, ns, "docOpen", open, context_id);
    crate::dom::register(scope, ns, "docMarkupGate", markup_gate_op, context_id);
    crate::dom::register(scope, ns, "docTheEnd", the_end, context_id);
    crate::dom::register(scope, ns, "docContentLoadedDue", content_loaded_due, context_id);
    crate::dom::register(scope, ns, "docContentLoadedEnd", content_loaded_end, context_id);
    crate::dom::register(scope, ns, "docLoadDue", load_due, context_id);
    crate::dom::register(scope, ns, "docLoadSteps", load_steps, context_id);
    crate::dom::register(scope, ns, "docShowPage", show_page, context_id);
    crate::dom::register(scope, ns, "docHidePage", hide_page, context_id);
    crate::dom::register(scope, ns, "docFinishLoading", finish_loading, context_id);
    crate::dom::register(scope, ns, "docCompletelyLoaded", completely_loaded, context_id);
    crate::dom::register(scope, ns, "docLoadFired", load_fired, context_id);
    crate::dom::register(scope, ns, "docAbortParser", abort_parser_op, context_id);
    crate::dom::register(scope, ns, "docLoadAborted", load_aborted, context_id);
    crate::dom::register(scope, ns, "docAborts", aborts, context_id);
    crate::dom::register(scope, ns, "docModuleFetches", module_fetches, context_id);
    crate::dom::register(scope, ns, "docModuleCancelled", module_cancelled, context_id);
    crate::dom::register(scope, ns, "docParserAborted", parser_aborted, context_id);
    crate::dom::register(scope, ns, "docAbortStep", abort_step, context_id);
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

// Which steps of dynamic markup insertion ask (HTML §8.4): the document open steps; the document write steps at their head,
// and where no insertion point lets them write, as they are to open it; the document close steps.
const STEPS_OPEN: u32 = 0;
const STEPS_WRITE: u32 = 1;
const STEPS_WRITE_OPENING: u32 = 2;
const STEPS_CLOSE: u32 = 3;
// What they do first: go on; return, nothing done; or throw — an InvalidStateError of an XML document or a raised
// throw-on-dynamic-markup-insertion counter, a SecurityError of a document of another origin than the entry document's.
const MARKUP_GO: u32 = 0;
const MARKUP_RETURN: u32 = 1;
const MARKUP_THROW_XML: u32 = 2;
const MARKUP_THROW_COUNTER: u32 = 3;
const MARKUP_THROW_ORIGIN: u32 = 4;
#[derive(Default)]
struct MarkupFacts {
    xml: bool,
    counter_raised: bool,
    other_origin: bool,
    parser_nested: bool,
    unloading: bool,
    parser_aborted: bool,
    destructive_ignored: bool,
}
// The spec's order is the contract (bailout-exception-vs-return-origin): the throws first, an XML document's before the
// counter's before the origin's; then what returns.
fn markup_gate(steps: u32, facts: &MarkupFacts) -> u32 {
    if steps == STEPS_WRITE_OPENING {
        return if facts.unloading || facts.destructive_ignored { MARKUP_RETURN } else { MARKUP_GO };
    }
    if facts.xml {
        return MARKUP_THROW_XML;
    }
    if facts.counter_raised {
        return MARKUP_THROW_COUNTER;
    }
    match steps {
        STEPS_OPEN if facts.other_origin => MARKUP_THROW_ORIGIN,
        STEPS_OPEN if facts.parser_nested || facts.unloading || facts.parser_aborted => MARKUP_RETURN,
        STEPS_WRITE if facts.parser_aborted => MARKUP_RETURN,
        _ => MARKUP_GO,
    }
}
// __dom.docMarkupGate(docNid, steps, entryRealm, parserNested) -> `markup_gate` of the document as it is — `entryRealm` the
// entry settings object's (-1: no script's), `parserNested` whether its active parser has a script nesting level above
// zero, which the bindings' parse knows.
fn markup_gate_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(doc) = nid_arg(scope, &args, 0) else { return rv.set_uint32(MARKUP_GO) };
    let steps = args.get(1).uint32_value(scope).unwrap_or(STEPS_OPEN);
    let entry = args.get(2).int32_value(scope).unwrap_or(-1);
    let parser_nested = args.get(3).is_true();
    let Some(cid) = crate::dom::dom(scope).arena.get(doc).map(|n| n.realm) else { return rv.set_uint32(MARKUP_GO) };
    let other_origin = entry >= 0 && entry != cid && !crate::realm_location::realms_same_origin(scope, entry, cid);
    let parser_aborted = lifecycle_of(scope, doc).aborted;
    let arena = &crate::dom::dom(scope).arena;
    let state = arena.document_states.markup_state(doc);
    let facts = MarkupFacts {
        xml: !crate::document_state::is_html(arena, Some(doc)),
        counter_raised: state.0 > 0,
        other_origin,
        parser_nested,
        unloading: arena.realm_document(cid) == Some(doc) && arena.unloading(cid),
        parser_aborted,
        destructive_ignored: state.1 > 0,
    };
    rv.set_uint32(markup_gate(steps, &facts));
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

// __dom.docContentLoadedEnd(docNid) — "the end"'s DOMContentLoaded task for the document over.
fn content_loaded_end(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(doc) = nid_arg(scope, &args, 0) else { return };
    lifecycle_of(scope, doc).content_loaded_over = true;
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
    // (…a gate's work may have fired it: a frame built, whose build fired this one's load re-entrantly — or aborted it: a
    // `stop()` in an `async` script, or as a frame's server took its time)
    let arena = crate::dom::realm(scope, cid);
    let lc = arena.document_states.lifecycle(doc);
    if lc.load_fired {
        return;
    }
    if lc.is_aborted() {
        set_load_delay(scope, cid, 0);
        return rv.set_uint32(LOAD_ABORTED);
    }
    // (…none where a `javascript:` URL's task, a gate above, planned the document that replaces it: Chrome and Firefox fire no
    // `load` for a document that set `location` to one as it parsed)
    if arena.navigation_plan.javascript_document_planned() {
        return;
    }
    // (…none of a frame's whose navigable a form's submission plans to navigate, its navigation due first, which aborts it:
    // its parser ran on, there being no parallel here for it to run in — Firefox; Chrome fires it)
    if arena.live_container(cid).is_some_and(|c| arena.frame_navigations.submission_planned(c)) {
        lifecycle_of(scope, doc).aborted = true;
        set_load_delay(scope, cid, 0);
        return rv.set_uint32(LOAD_ABORTED);
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

// __dom.docAbortParser(docNid, imagesCancelled) -> whether the document's parser was active, aborted now
// (`Lifecycle::abort_parser`): HTML "abort a document", `stop()`'s, `imagesCancelled` whether it cancelled an image of the
// document's. Past its DOMContentLoaded, a fetch of its own cancelled means no load, a frame's does not: one with frames
// and none of its own has its load fire all the same. This follows Chrome and Firefox, as measured (rvfn
// `a_*`, `kk_pstop`, `k_pstop_t0`, `h_t0_img`, 2026-11-06), and is not derived from the text, which leaves a parse that is
// over no active parser to abort.
fn abort_parser_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(doc) = crate::dom::nid_arg(scope, &args, 0) else { return rv.set_bool(false) };
    let images = args.get(1).is_true();
    let cid = realm_id(scope, &args);
    let arena = crate::dom::realm(scope, cid);
    let own = images || arena.realm_state(cid).is_some_and(|s| s.load_gates.own_fetches());
    let frames_only = !own && arena.document_states.lifecycle(doc).content_loaded_over && arena.has_frames(cid);
    let lc = lifecycle_of(scope, doc);
    lc.aborts = lc.aborts.wrapping_add(1);
    rv.set_bool(!frames_only && lc.abort_parser(true));
}
// __dom.docAborts(docNid) -> how many aborts have come to the document.
fn aborts(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(doc) = crate::dom::nid_arg(scope, &args, 0) else { return rv.set_uint32(0) };
    rv.set_uint32(lifecycle_of(scope, doc).aborts);
}
// __dom.docModuleFetches(docNid, since) -> the count the module graph being fetched began at (null for none), `since` that
// of the graph fetched from now on (null for none): a nested one's in place of the one it ran inside, that one's again after.
fn module_fetches(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(doc) = crate::dom::nid_arg(scope, &args, 0) else { return };
    let since = args.get(1).uint32_value(scope).filter(|_| !args.get(1).is_null_or_undefined());
    match std::mem::replace(&mut lifecycle_of(scope, doc).module_fetches, since) {
        Some(outer) => rv.set_uint32(outer),
        None => rv.set_null(),
    }
}
// __dom.docModuleCancelled(docNid) -> whether an abort has come to the document since the module graph being fetched began.
fn module_cancelled(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(doc) = crate::dom::nid_arg(scope, &args, 0) else { return rv.set_bool(false) };
    let lc = lifecycle_of(scope, doc);
    rv.set_bool(lc.module_fetches.is_some_and(|since| since != lc.aborts));
}
// __dom.docLoadAborted() — the calling realm's document aborted: nothing of it delays its parent's load any more.
fn load_aborted(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    set_load_delay(scope, cid, 0);
}
// __dom.docParserAborted(docNid) -> whether the document's active parser was aborted: HTML's flag, which the document open
// and write steps return at, and what the parse leaves off at, "the end" none.
fn parser_aborted(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(doc) = crate::dom::nid_arg(scope, &args, 0) else { return rv.set_bool(false) };
    rv.set_bool(lifecycle_of(scope, doc).aborted);
}
// __dom.docAbortStep(docNid) -> whether HTML "abort a parser" moved the aborted document's readiness on, to `interactive`
// and then to `complete` (each time a `readystatechange` to fire), false where it is there.
fn abort_step(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(doc) = crate::dom::nid_arg(scope, &args, 0) else { return rv.set_bool(false) };
    let lc = lifecycle_of(scope, doc);
    let next = if lc.ready == READY_LOADING { READY_INTERACTIVE } else { READY_COMPLETE };
    rv.set_bool(lc.aborted && lc.update_readiness(next));
}
// __dom.docCompletelyLoaded(docNid) -> whether the document is completely loaded — before it is, a navigation it plans
// replaces its session history entry, and what waits for it waits.
fn completely_loaded(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(doc) = nid_arg(scope, &args, 0) else { return rv.set_bool(false) };
    rv.set_bool(crate::dom::dom(scope).arena.document_states.lifecycle(doc).completely_loaded);
}

// __dom.docLoadFired(docNid) -> whether its load has fired, or begun to: nothing more delays it.
fn load_fired(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(doc) = nid_arg(scope, &args, 0) else { return rv.set_bool(false) };
    rv.set_bool(crate::dom::dom(scope).arena.document_states.lifecycle(doc).load_fired);
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
        assert!(!lc.abort_parser(false));
        lc.begin(1);
        assert!(lc.abort_parser(false));
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

#[cfg(test)]
mod markup_tests {
    use super::*;

    #[test]
    fn the_steps_throw_before_they_return_in_their_order() {
        let every = MarkupFacts { xml: true, counter_raised: true, other_origin: true, parser_nested: true, unloading: true, parser_aborted: true, destructive_ignored: true };
        assert_eq!(markup_gate(STEPS_OPEN, &every), MARKUP_THROW_XML);
        assert_eq!(markup_gate(STEPS_OPEN, &MarkupFacts { xml: false, ..every }), MARKUP_THROW_COUNTER);
        let foreign = MarkupFacts { other_origin: true, parser_nested: true, unloading: true, parser_aborted: true, ..Default::default() };
        assert_eq!(markup_gate(STEPS_OPEN, &foreign), MARKUP_THROW_ORIGIN);
        for returns in [
            MarkupFacts { parser_nested: true, ..Default::default() },
            MarkupFacts { unloading: true, ..Default::default() },
            MarkupFacts { parser_aborted: true, ..Default::default() }
        ] {
            assert_eq!(markup_gate(STEPS_OPEN, &returns), MARKUP_RETURN);
        }
        assert_eq!(markup_gate(STEPS_OPEN, &MarkupFacts::default()), MARKUP_GO);
    }

    #[test]
    fn write_and_close_ask_what_is_theirs() {
        // (…no origin check of write's own: its open's; an aborted parser its one return, its unload and
        // ignore-destructive-writes counters only where it is to open)
        let foreign = MarkupFacts { other_origin: true, parser_nested: true, unloading: true, destructive_ignored: true, ..Default::default() };
        assert_eq!(markup_gate(STEPS_WRITE, &foreign), MARKUP_GO);
        assert_eq!(markup_gate(STEPS_WRITE, &MarkupFacts { parser_aborted: true, ..Default::default() }), MARKUP_RETURN);
        assert_eq!(markup_gate(STEPS_WRITE_OPENING, &MarkupFacts { destructive_ignored: true, ..Default::default() }), MARKUP_RETURN);
        assert_eq!(markup_gate(STEPS_WRITE_OPENING, &MarkupFacts { unloading: true, ..Default::default() }), MARKUP_RETURN);
        assert_eq!(markup_gate(STEPS_WRITE_OPENING, &MarkupFacts::default()), MARKUP_GO);
        assert_eq!(markup_gate(STEPS_CLOSE, &MarkupFacts { xml: true, ..Default::default() }), MARKUP_THROW_XML);
        assert_eq!(markup_gate(STEPS_CLOSE, &MarkupFacts { counter_raised: true, ..Default::default() }), MARKUP_THROW_COUNTER);
        assert_eq!(markup_gate(STEPS_CLOSE, &foreign), MARKUP_GO);
    }
}
