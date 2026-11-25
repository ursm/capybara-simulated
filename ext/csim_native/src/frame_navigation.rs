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
    // …and the CSP list of the policy container it is made with (a javascript: URL's result its frame's active document's:
    // HTML "evaluate a javascript: URL"), empty for none.
    pub(crate) csp: Vec<u16>,
}

#[derive(Default)]
struct FrameNavigation {
    flags: u32,
    // …the turn its build was parked in (`DEFERRED_SW`), its replay's place among the others'.
    deferred_at: u32,
    // (…which of its navigations a `load` it queued is of: one another superseded fires for nothing — the element's
    // bookkeeping of its loads, `frameLoadBegin` / `load_due`; whether a navigation is the navigable's ongoing one is
    // its traversable's record, session_history.rs `begin_navigation_of`)
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
    // …and the policy container of the document that began it, as it did — a host navigation's initiator's (a sibling
    // frame's script, a link targeting it: `HostNavigation::Navigate`); none for one its container's document began, whose
    // own it is — taken by the document it makes (`take_frame_source`, frame_response.rs).
    source: Option<(String, Option<String>)>,
    history: Option<Vec<u16>>,
    reload: Option<Vec<u16>>,
    // When the element's last `load` fired, on the virtual clock: a navigation begun at that same instant waits a
    // nested-timer clamp, so a frame its load handler navigates again on every load is paced, as a network's response
    // paces it (Chrome: ~100 loads a second), rather than running without the clock moving.
    loaded_at: Option<f64>,
    // Whether the build under way waits on the response of its navigation (frame_response.rs `navigate`): that navigation is
    // its navigable's ongoing one till the response is in, a stop cancelling it.
    awaiting_response: bool,
    // …and the response it has, held — with when its fetch began, and of which navigation — until the event loop comes to
    // the time its server took (frame_response.rs `FRAME_LATER`).
    held: Option<(u32, f64, v8::Global<v8::Value>)>,
    // …and the navigation the host plans to make of it, by the order it was planned in (`HostNavigation`).
    host: Option<(u64, HostNavigation)>,
    // …and a navigation of it begun before a form's submission planned in its place — a `location`'s, a hyperlink's:
    // its fetch under way as it was planned (HTML "navigate", in parallel after its unload check), the form's "plan to
    // navigate" task, queued after it, superseding it as it runs — its request made, nothing made of its response
    // (`take_frame_navigations`: the host fetches it as a superseded one).
    superseded: Option<(u64, HostNavigation)>,
    // Whether the navigation it plans now aborted its document, planned while that one's parser was active
    // (document_state.rs `abort_parsing`): the container's load is then none of that document's (`load_due`).
    aborted_document: bool,
    contents: [Option<Content>; CONTENT_SLOTS],
    // While its navigable has no realm made: the user activation the window of its initial about:blank document has
    // had (user_activation.rs) — its last activation, on the event loop's clock, and the activation notifications
    // that reached it — which that window takes as its realm is made (navigables.rs `set_frame_realm`).
    activation: Option<(f64, u32)>,
    // The markup of the about:srcdoc document it is at, none for a document of another URL (`document_srcdoc`) — of the
    // one the build under way loads, till it commits (`loading_srcdoc`) — and of the one a traversal goes to
    // (`traversal_srcdoc`, taken by its build), which is no attribute's by then.
    document_srcdoc: Option<String>,
    loading_srcdoc: Option<String>,
    traversal_srcdoc: Option<String>,
    // …and the fragment of the about:srcdoc URL the build under way goes to — a traversal's, a reload's (with its `#`).
    srcdoc_fragment: String,
    // …and when its initial about:blank document was made, on the event loop's clock — as its post-insertion step ran —
    // which that document's time origin is (HTML "create a new browsing context and document"), however much later its
    // realm is made: navigables.rs `set_frame_realm`.
    created: Option<f64>,
    // The steps of its element's `load` for the navigations begun of it, the latest last (`LoadRun`) — and those that came
    // to run while its build was under way, held (`BUILDING`): what a build makes is what the frame's `load` follows and
    // another build begins from (`frameBuildEnd` hands them back).
    runs: Vec<LoadRun>,
    after_build: Vec<(u32, u32)>,
}

// The steps of a container's `load` for one navigation (`frameLoadBegin`), which the bindings run as its tasks, its load gate
// and its microtask come (`frameLoadNext`): what each does next is decided here, from the run's own state.
#[derive(Clone, Copy)]
struct LoadRun {
    id: u32,
    generation: u32,
    // Its document left unloaded on its task, none built (`LOAD_COMMIT`), rather than built (`LOAD_BUILD`).
    commit: bool,
    // The frame's realm as it began, while its document is still to be asked whether it may be unloaded on its first task
    // (`PROMPT_OWED`: HTML "navigate" asks in parallel with the task that began it) — and the one being asked.
    ask: Option<i32>,
    asking: i32,
    // The load gate its build runs under (bridge.entry.js `subresourceGate`), the page's load waiting for it — and whether
    // its task has taken it.
    gate: Option<u32>,
    gate_taken: bool,
    // Its response in later, as its server took its time (frame_response.rs `FRAME_LATER`): built again then, its `load`
    // waiting for that.
    building: bool,
    load_queued: bool,
}
impl LoadRun {
    // Whether a superseded navigation's run has a step left that needs it: its document still to ask — HTML "navigate"
    // asks, and only then looks whether it is still the ongoing one — or its build's load gate still to take, which the
    // page's load waits for. Its other steps come to nothing — its build, its `load` — and come to the same without it.
    fn pending(&self) -> bool {
        self.ask.is_some() || (self.gate.is_some() && !self.gate_taken)
    }
}

// Its element's `load` fired or queued (frame-nav.js `FN_LOAD_FIRED`).
pub(crate) const LOAD_FIRED: u32 = 1 << 0;
// Its old document its own until the new one's response is in (frame-nav.js `FN_COMMIT_PENDING`).
pub(crate) const COMMIT_PENDING: u32 = 1 << 2;
// Its build parked on a still-activating service worker (frame-nav.js `FN_DEFERRED_SW`) — set until the replay that
// `takeSwDeferredFrames` hands it to runs — and (the engine's own bit) handed to one already.
pub(crate) const DEFERRED_SW: u32 = 1 << 3;
const DEFERRED_LISTED: u32 = 1 << 16;
// Its realm being built now: a read of its window the build makes is answered with none, not
// a build again — set and cleared by the build alone (unload_walks.rs `frameBuildBegin` / `frameBuildEnd`).
pub(crate) const BUILDING: u32 = 1 << 4;
// The navigation is a reload (`renavigateFrame`).
const RELOAD_NAV: u32 = 1 << 5;
// The session history entry it pushes as it commits replaces the current one (frame-nav.js `FN_HISTORY_REPLACE`).
const HISTORY_REPLACE: u32 = 1 << 13;
// Its post-insertion step ran: its navigable exists (frame-nav.js `FN_CONTEXT_READY`).
const CONTEXT_READY: u32 = 1 << 6;
// Its `src` refused as its attributes were last processed (`process_src`).
const SRC_REFUSED: u32 = 1 << 7;
// Its element's `load` for the navigation under way still to fire (frame-nav.js `FN_LOAD_OWED`).
const LOAD_OWED: u32 = 1 << 8;
// Its element's `load` being dispatched (frame-nav.js `FN_LOAD_IN_PROGRESS`, HTML's "iframe load in progress" flag): a
// `document.open()` of its document then mutes the load the written document would fire at it (document_lifecycle.rs).
pub(crate) const LOAD_IN_PROGRESS: u32 = 1 << 9;
// The navigation's document built on a task not run yet (frame-nav.js `FN_BUILD_QUEUED`): a read of the frame's window
// meanwhile is answered with its initial about:blank document's.
const BUILD_QUEUED: u32 = 1 << 10;
// Its document still to be asked whether it may be unloaded (frame-nav.js `FN_PROMPT_OWED`).
const PROMPT_OWED: u32 = 1 << 12;
// (…a navigation of its navigable to a URL its document or another made — not its attributes' processing: `frame_source`)
const URL_NAV: u32 = 1 << 14;

// A navigation the host makes of a frame's navigable, planned by the frame's own document or a hyperlink or a form that
// targets it (HTML "plan to navigate": the navigable's one, a later one replacing it): to a URL — whether it replaces the
// frame's session history entry, the realm of the document that began it and the Referer that one sends, the container's
// `sandbox` attribute as it began (what the document it makes is sandboxed by), whether that document had transient
// activation — a reload of the document it is at, or a form's submission: its request as it was submitted (form-fields.js
// `formSerialize`), the realm of the form's document and the Referer that one sends. Taken once the event loop's
// navigation turn has run (`Plans::through`), HTML's parallel steps as what is due before them has run.
pub(crate) enum HostNavigation {
    // (…`container` the policy container of the document that began it as it did, HTML's source snapshot params' — what
    // the document of a local URL it makes clones: referrer.rs `policy_container`)
    Navigate { url: String, replace: bool, initiator: i32, referrer: (String, String), sandbox: Option<String>, activated: bool, container: (String, Option<String>) },
    // (…of the URL its document was at as `reload()` was called: HTML appends its traversal steps then, and they apply to the
    // entry as it stood — a `document.open()` after it moves the document's URL, not that)
    Reload { url: String },
    // (…`held`: going on past its document, which made way for another in place)
    Submit { request: v8::Global<v8::Value>, source: i32, referrer: (String, String), held: bool },
}

// What `planFrameLocation` made of a navigation: none (the frame has no navigable), one planned, or one to a fragment of
// the frame's document, which navigates within it at once (HTML "navigate to a fragment"), the bindings' to make.
const PLANNED_NONE: u32 = 0;
const PLANNED: u32 = 1;
const PLANNED_FRAGMENT: u32 = 2;

type Hosted = HashMap<NodeId, (u64, HostNavigation)>;

#[derive(Default)]
pub(crate) struct FrameNavigations(HashMap<NodeId, FrameNavigation>, Plans);

// Each form's last plan — the order it was planned in — with the container it plans for: an interactive submission
// supersedes it on whichever navigable it was for.
#[derive(Default)]
struct Plans {
    // (…the parked builds' numbers, `FrameNavigation::deferred_at`)
    deferrals: u32,
    // (…the load runs' numbers, `LoadRun::id`)
    load_runs: u32,
    last: HashMap<NodeId, (u64, NodeId)>,
    // The host's navigations as a flush of the page's due tasks began, and those the tasks planned
    // (navigation_plan.rs `flushBegin`).
    saved: Option<Hosted>,
    flushed: Option<Hosted>,
    // The event loop's navigation turn (timers.js `queueNavigationTurn`): one task behind what is due — its key while it
    // is queued — as it runs the navigations planned so far due for the host, by the order they were planned in
    // (navigation_plan.rs `next_planned`).
    turn: Option<i64>,
    through: u64,
    // …a word the event loop's step reads after each task, set as a turn has run and until the host is told, where it ends
    // the step (timers.js `runLoopStepBody`).
    turn_due: crate::dom::SharedWord,
    // …and when it last ran, on the virtual clock: one queued at that same instant waits a nested-timer clamp, so a frame
    // its load handlers navigate again on every load is paced, as a network's response paces it, and the clock moves. The
    // agent's, as the turn is: another frame's navigation planned at that instant waits with it.
    turn_ran: Option<f64>,
}

impl FrameNavigations {
    // A form's submission into container `c`'s navigable begun: the container's `sandbox` attribute now what the document
    // it makes is sandboxed by (`frame_sandbox`) — as it is when the submission's navigation begins, not as an earlier
    // navigation that made no document (a download) began.
    pub(crate) fn begin_submission(arena: &mut crate::dom::RealmArena, c: NodeId) {
        let sandbox = arena.get(c).and_then(|n| n.plain_attr("sandbox")).map(str::to_owned);
        arena.frame_navigation(c).sandbox = Some(sandbox);
    }
    // Whether the host plans a navigation of any frame that is due now.
    pub(crate) fn hosted(&self) -> bool {
        self.0.values().any(|n| n.host.iter().chain(&n.superseded).any(|&(at, _)| at <= self.1.through))
    }
    // …and the submissions realm `source`'s document planned so far going on past it (`held`): its navigation taken now,
    // their tasks — queued before its response, its document still there for them — ahead of what it makes.
    pub(crate) fn hold_planned_of(arena: &mut crate::dom::RealmArena, source: i32) {
        arena.frame_navigations.hold_submissions_of(source);
        arena.routed_submissions.hold_of(source);
    }
    // The forms' submissions realm `source`'s document made let go: its reload (Chrome and Firefox send none, measured
    // 2026-11-07), its `stop()`. Whether it had one.
    pub(crate) fn drop_submissions_of(&mut self, source: i32) -> bool {
        let mut dropped = false;
        for nav in self.0.values_mut() {
            dropped |= nav.host.take_if(|(_, h)| matches!(h, HostNavigation::Submit { source: s, .. } if *s == source)).is_some();
        }
        dropped
    }
    // The order the first navigation the host plans of a frame that is due now was planned in — its reloads' (`reload`) or
    // its others' but the forms' — none for none (navigation_plan.rs `plannedNext`).
    pub(crate) fn first_hosted(&self, reload: bool) -> Option<u64> {
        self.0
            .values()
            .flat_map(|n| n.host.iter().chain(&n.superseded))
            .filter(|&&(at, ref h)| at <= self.1.through && !matches!(h, HostNavigation::Submit { .. }) && matches!(h, HostNavigation::Reload { .. }) == reload)
            .map(|&(at, _)| at)
            .min()
    }
    // Whether a navigation planned in order `at` is due: the navigation turn has run since.
    pub(crate) fn due(&self, at: u64) -> bool {
        at <= self.1.through
    }
    // The order the first form's submission the host plans into a frame was planned in, none for none.
    pub(crate) fn first_submission(&self) -> Option<u64> {
        self.0.values().filter_map(|n| n.host.as_ref().filter(|(_, h)| matches!(h, HostNavigation::Submit { .. })).map(|&(at, _)| at)).min()
    }
    // …and it taken, with the container it navigates.
    pub(crate) fn take_submission(&mut self, at: u64) -> Option<(NodeId, v8::Global<v8::Value>, i32, (String, String), bool)> {
        let (&c, nav) = self.0.iter_mut().find(|(_, n)| n.host.as_ref().is_some_and(|&(planned, _)| planned == at))?;
        let Some((_, HostNavigation::Submit { request, source, referrer, held })) = nav.host.take() else { return None };
        Some((c, request, source, referrer, held))
    }
    // Whether a form's submission plans to navigate container `c`'s navigable.
    pub(crate) fn submission_planned(&self, c: NodeId) -> bool {
        self.0.get(&c).and_then(|n| n.host.as_ref()).is_some_and(|(_, h)| matches!(h, HostNavigation::Submit { .. }))
    }
    // …those realm `source`'s document made going on past it (`held`).
    pub(crate) fn hold_submissions_of(&mut self, source: i32) {
        for nav in self.0.values_mut() {
            if let Some((_, HostNavigation::Submit { source: s, held, .. })) = &mut nav.host {
                *held |= *s == source;
            }
        }
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
    // …one more activation notification reaching such a frame's window, its last at `at` on the event loop's clock…
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
    // …and when its initial about:blank document was made (`FrameNavigation::created`), taken as its realm is.
    pub(crate) fn take_unbuilt_creation(&mut self, container: NodeId) -> Option<f64> {
        self.frame_navigations.0.get_mut(&container).and_then(|nav| nav.created.take())
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
    crate::dom::register(scope, ns, "frameLoadBegin", frame_load_begin, context_id);
    crate::dom::register(scope, ns, "frameLoadNext", frame_load_next, context_id);
    crate::dom::register(scope, ns, "renavigateFrame", renavigate_frame, context_id);
    crate::dom::register(scope, ns, "frameLoadGate", frame_load_gate, context_id);
    crate::dom::register(scope, ns, "frameNav", frame_nav, context_id);
    crate::dom::register(scope, ns, "frameAttributesNavigate", frame_attributes_navigate, context_id);
    crate::dom::register(scope, ns, "takeSwDeferredFrames", take_sw_deferred_frames, context_id);
    crate::dom::register(scope, ns, "swDeferredReplays", sw_deferred_replays, context_id);
    crate::dom::register(scope, ns, "setFrameNav", set_frame_nav, context_id);
    crate::dom::register(scope, ns, "loadDelay", load_delay, context_id);
    crate::dom::register(scope, ns, "oweContainerLoad", owe_container_load, context_id);
    crate::dom::register(scope, ns, "loadDelaySettled", load_delay_settled, context_id);
    crate::dom::register(scope, ns, "loadDelayedNow", load_delayed_now, context_id);
    crate::dom::register(scope, ns, "supersedeFrameNav", supersede_frame_nav, context_id);
    crate::dom::register(scope, ns, "frameNavUrl", frame_nav_url, context_id);
    crate::dom::register(scope, ns, "setFrameNavUrl", set_frame_nav_url, context_id);
    crate::dom::register(scope, ns, "frameLoadFired", frame_load_fired, context_id);
    crate::dom::register(scope, ns, "hostCommitBegins", host_commit_begins, context_id);
    crate::dom::register(scope, ns, "frameSrcdocCommits", frame_srcdoc_commits, context_id);
    crate::dom::register(scope, ns, "frameLoadingSrcdoc", frame_loading_srcdoc, context_id);
    crate::dom::register(scope, ns, "frameTraversalSrcdoc", frame_traversal_srcdoc, context_id);
    crate::dom::register(scope, ns, "frameSubmissionPlanned", frame_submission_planned, context_id);
    crate::dom::register(scope, ns, "frameDestination", frame_destination, context_id);
    crate::dom::register(scope, ns, "cancelFrameNavigation", cancel_frame_navigation, context_id);
    crate::dom::register(scope, ns, "stopFrameLoading", stop_frame_loading, context_id);
    crate::dom::register(scope, ns, "stopChildFramesLoading", stop_child_frames_loading, context_id);
    crate::dom::register(scope, ns, "cancelFrameLocation", cancel_frame_location, context_id);
    crate::dom::register(scope, ns, "planFrameLocation", plan_frame_location, context_id);
    crate::dom::register(scope, ns, "planFrameReload", plan_frame_reload, context_id);
    crate::dom::register(scope, ns, "navigationTurnQueued", navigation_turn_queued, context_id);
    crate::dom::register(scope, ns, "navigationTurnDelay", navigation_turn_delay, context_id);
    crate::dom::register(scope, ns, "navigationTurnKey", navigation_turn_key, context_id);
    crate::dom::register(scope, ns, "navigationTurnRan", navigation_turn_ran, context_id);
    let turn_due = crate::dom::dom(scope).arena.frame_navigations.1.turn_due.store();
    crate::dom::view_word(scope, ns, "navigationTurnDue", turn_due);
    crate::dom::register(scope, ns, "frameNavAsks", frame_nav_asks, context_id);
    crate::dom::register(scope, ns, "frameNavigationFinalized", frame_navigation_finalized, context_id);
    crate::dom::register(scope, ns, "takeFrameNavigations", take_frame_navigations, context_id);
    crate::dom::register(scope, ns, "frameContent", frame_content, context_id);
    crate::dom::register(scope, ns, "setFrameContent", set_frame_content, context_id);
    crate::dom::register(scope, ns, "frameContentHeld", frame_content_held, context_id);
    crate::dom::register(scope, ns, "frameContentUrl", frame_content_url, context_id);
    crate::dom::register(scope, ns, "copyFrameContent", copy_frame_content, context_id);
    crate::dom::register(scope, ns, "processFrameSrc", process_frame_src, context_id);
    crate::dom::register(scope, ns, "takeFrameSandbox", take_frame_sandbox, context_id);
    crate::dom::register(scope, ns, "releaseFrameSandbox", release_frame_sandbox, context_id);
    crate::dom::register(scope, ns, "frameSandbox", frame_sandbox_op, context_id);
}

// HTML "shared attribute processing steps for iframe and frame elements" step 3, as the frame `container`'s attributes
// are processed — it is inserted, its `src` or `srcdoc` set or removed: whether its `src` names a document a navigable
// among the inclusive ancestors of its node navigable has, fragments aside (`RealmArena::ancestor_document_at`), so that
// the steps return null and it navigates nowhere — no document but the one it has, and no `load`. Not for a frame with
// a `srcdoc`, nor one a navigation already carries a document for (a `javascript:` URL's), nor one in no document (it has
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
    !crate::url_ops::matches_about_blank(&url) && arena.ancestor_document_at(realm, url.href())
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
    nav.source = None;
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
    // …and the policy container of the document that began it, taken by the document it makes — none where its
    // container's document began it (`FrameNavigation::source`).
    pub(crate) fn take_frame_source(&mut self, container: NodeId) -> Option<(String, Option<String>)> {
        self.frame_navigations.0.get_mut(&container).and_then(|nav| nav.source.take())
    }
    // …taken by the document it makes: the next navigation's its own.
    pub(crate) fn take_frame_sandbox(&mut self, container: NodeId) -> Option<String> {
        let snapshot = self.frame_navigations.0.get_mut(&container).and_then(|nav| nav.sandbox.take());
        snapshot.unwrap_or_else(|| self.get(container).and_then(|n| n.plain_attr("sandbox")).map(str::to_owned))
    }
}
// Whether the navigation of the container under way began with its document's window activated
// (`FrameNavigation::activated`).
impl RealmArena {
    pub(crate) fn frame_navigation_activated(&self, container: NodeId) -> bool {
        self.frame_navigations.0.get(&container).is_some_and(|nav| nav.activated)
    }
    pub(crate) fn frame_srcdoc_fragment(&self, container: NodeId) -> String {
        self.frame_navigations.0.get(&container).map_or_else(String::new, |nav| nav.srcdoc_fragment.clone())
    }
    // The markup of the about:srcdoc document the container's navigable is at, none for another (`document_srcdoc`).
    pub(crate) fn frame_document_srcdoc(&self, container: NodeId) -> Option<String> {
        self.frame_navigations.0.get(&container).and_then(|nav| nav.document_srcdoc.clone())
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
// __dom.releaseFrameSandbox(realm): the navigation of frame realm `realm`'s navigable under way made no document (a 204,
// a download): its snapshot of the container's `sandbox` let go, which a later navigation that takes none of its own
// (a reload, a traversal) would otherwise be sandboxed by.
fn release_frame_sandbox(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let realm = args.get(0).int32_value(scope).unwrap_or(0);
    let arena = &mut crate::dom::dom(scope).arena;
    if let Some(nav) = arena.live_container(realm).and_then(|c| arena.frame_navigations.0.get_mut(&c)) {
        nav.sandbox = None;
        nav.source = None;
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
    let csp = utf16_value(scope, &content.csp);
    rv.set(v8::Array::new_with_elements(scope, &[url, bytes, content_type, referrer, policy, csp]).into());
}

// __dom.setFrameContent(containerNid, slot, url, bytes, contentType[, referrer[, policy[, csp]]]) — the document the
// navigation carries in `slot`: `url`, `bytes` (a Uint8Array), `contentType`, the Referer its request sent and the
// referrer policy and CSP list it is made with; none where no bytes are given (`setFrameContent(nid, slot)`).
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
        let (referrer, policy, csp) = (text(scope, args.get(5)), text(scope, args.get(6)), text(scope, args.get(7)));
        Content { url, bytes, content_type, referrer, policy, csp }
    });
    let cid = realm_id(scope, &args);
    let arena = crate::dom::realm(scope, cid);
    // (…none carried by a container with no navigation state: nothing to make for it)
    if content.is_none() && !arena.frame_navigations.0.contains_key(&container) {
        return;
    }
    arena.frame_navigation(container).contents[slot] = content;
}

// A form's submission of realm `source`'s document, its request as the bindings made it, planned for the host to navigate
// container `container`'s navigable to, replacing what that planned — and, for an interactive submission (a submit button's,
// an implicit one — not `form.submit()`), the form's last plan on whichever navigable it was for (form-double-submit;
// form.submit() to several frames navigates them all). Its parser goes on: HTML "plan to navigate" queues the navigation that
// aborts it (Chrome and Firefox run the rest of a frame's script and its markup after).
pub(crate) fn plan_frame_submission(
    scope: &mut v8::PinScope<'_, '_>,
    source: i32,
    container: NodeId,
    form: NodeId,
    request: v8::Global<v8::Value>,
    referrer: (String, String),
    interactive: bool,
) {
    let arena = &mut crate::dom::dom(scope).arena;
    arena.stop_attribute_navigation(container);
    let navs = &mut arena.frame_navigations;
    if interactive {
        if let Some(&(at, other)) = navs.1.last.get(&form).filter(|&&(_, other)| other != container) {
            if let Some(nav) = navs.0.get_mut(&other) {
                nav.host.take_if(|&mut (planned, _)| planned == at);
            }
        }
    }
    let at = crate::navigation_plan::next_planned();
    let nav = navs.0.entry(container).or_default();
    if matches!(nav.host, Some((_, HostNavigation::Navigate { .. }))) {
        nav.superseded = nav.host.take();
    }
    nav.host = Some((at, HostNavigation::Submit { request, source, referrer, held: false }));
    nav.aborted_document = false;
    navs.1.last.insert(form, (at, container));
    match arena.frame_realm(container) {
        // (…a `javascript:` URL's begun before it ended)
        Some(frame) => {
            crate::session_history::begin_navigation_of(arena, frame, None);
        }
        // (…a frame with no document yet made one at its initial about:blank, none of its `src`, which this replaces)
        None => {
            let nav = arena.frame_navigation(container);
            nav.flags |= SRC_REFUSED;
            nav.src = None;
        }
    }
}
// __dom.frameDestination(realm) -> the destination of a navigation of frame realm `realm`'s navigable: its container's (HTML
// "create navigation params by fetching": "frame" for a `<frame>`, else "iframe").
fn frame_destination(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let realm = args.get(0).int32_value(scope).unwrap_or(0);
    let arena = &crate::dom::dom(scope).arena;
    let frame = arena.live_container(realm).and_then(|c| arena.get(c)).is_some_and(|n| n.is_html_named("frame"));
    rv.set(crate::subresource_obtain::text(scope, if frame { "frame" } else { "iframe" }));
}
// __dom.frameSubmissionPlanned(containerNid) -> whether a form's submission plans to navigate the container's navigable.
fn frame_submission_planned(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(container) = nid_arg(scope, &args, 0) else { return rv.set_bool(false) };
    let cid = realm_id(scope, &args);
    rv.set_bool(crate::dom::realm(scope, cid).frame_navigations.submission_planned(container));
}

// __dom.hostCommitBegins(containerNid) -> whether a navigation its attributes began was under way: the document the host's
// navigation made about to run — one its `load` handler begins of the frame after it the frame's next.
fn host_commit_begins(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(container) = nid_arg(scope, &args, 0) else { return rv.set_bool(false) };
    let cid = realm_id(scope, &args);
    let arena = crate::dom::realm(scope, cid);
    let pending = arena.frame_nav_has(container, COMMIT_PENDING);
    let nav = arena.frame_navigation(container);
    nav.flags &= !(COMMIT_PENDING | PROMPT_OWED);
    nav.src = None;
    nav.history = None;
    nav.document_srcdoc = None;
    rv.set_bool(pending);
}
// __dom.frameSrcdocCommits(containerNid) — the document the container's build loads about to be made: the markup it loaded
// (`frame_source`) the document's from here, what its entry keeps. __dom.frameLoadingSrcdoc(containerNid) -> that markup,
// null for none. __dom.frameTraversalSrcdoc(containerNid, markup) — a traversal's: what its build loads.
fn frame_srcdoc_commits(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(container) = nid_arg(scope, &args, 0) else { return };
    let cid = realm_id(scope, &args);
    let nav = crate::dom::realm(scope, cid).frame_navigation(container);
    nav.document_srcdoc = nav.loading_srcdoc.take();
}
fn frame_loading_srcdoc(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    rv.set_null();
    let Some(container) = nid_arg(scope, &args, 0) else { return };
    let cid = realm_id(scope, &args);
    let srcdoc = crate::dom::realm(scope, cid).frame_navigations.0.get(&container).and_then(|nav| nav.loading_srcdoc.clone());
    if let Some(s) = srcdoc.and_then(|s| v8::String::new(scope, &s)) {
        rv.set(s.into());
    }
}
fn frame_traversal_srcdoc(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(container) = nid_arg(scope, &args, 0) else { return };
    let srcdoc = args.get(1).to_rust_string_lossy(scope);
    let cid = realm_id(scope, &args);
    crate::dom::realm(scope, cid).frame_navigation(container).traversal_srcdoc = Some(srcdoc);
}
// A navigation of frame realm `realm`'s navigable begun: its document aborted where its parser is active still (HTML
// "navigate" queues "abort a document and its descendants", which a parse that runs to its end here has not left yet) —
// whether it was (none for a realm with no document).
pub(crate) fn abort_document(arena: &mut crate::dom::RealmArena, realm: i32) -> bool {
    arena.realm_document(realm).is_some_and(|doc| arena.document_states.lifecycle_mut(doc).abort_parser(false))
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
    // (…none of a navigable traversing: HTML "navigate" ignores it)
    let Some(container) = arena.live_container(target).filter(|_| !crate::session_history::traversing_of(arena, target)) else {
        return rv.set_uint32(PLANNED_NONE);
    };
    let here = arena.enter_known(target).map(|a| a.location.href().to_owned());
    if here.is_some_and(|here| crate::url_ops::is_fragment_navigation(&here, &url)) {
        return rv.set_uint32(PLANNED_FRAGMENT);
    }
    let referrer = crate::referrer::navigation_referrer(arena, initiator, &policy);
    let source = crate::referrer::policy_container(arena, initiator);
    let sandbox = arena.get(container).and_then(|n| n.plain_attr("sandbox")).map(str::to_owned);
    let aborted = abort_document(arena, target);
    arena.stop_attribute_navigation(container);
    let nav = arena.frame_navigation(container);
    nav.aborted_document = aborted;
    let host = HostNavigation::Navigate { url, replace, initiator, referrer, sandbox, activated, container: source };
    nav.host = Some((crate::navigation_plan::next_planned(), host));
    rv.set_uint32(PLANNED);
}
// __dom.planFrameReload(): a reload of the calling frame realm's document planned for the host, replacing the navigation
// its navigable planned.
fn plan_frame_reload(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    let arena = &mut crate::dom::dom(scope).arena;
    let Some(container) = arena.live_container(cid) else { return };
    let aborted = abort_document(arena, cid);
    let url = arena.enter_known(cid).map(|a| a.location.href().to_owned()).unwrap_or_default();
    let nav = arena.frame_navigation(container);
    nav.aborted_document = aborted;
    nav.host = Some((crate::navigation_plan::next_planned(), HostNavigation::Reload { url }));
    arena.frame_navigations.drop_submissions_of(cid);
}
// __dom.navigationTurnQueued() -> whether the event loop's navigation turn is queued and not run yet (`Plans::turn`) — its
// task gone with the realm that queued it is none. __dom.navigationTurnDelay() -> how long one queued now waits, its pace.
// __dom.navigationTurnKey(key): the one queued now. __dom.navigationTurnRan(): it runs, what is planned so far due for the
// host.
fn navigation_turn_queued(scope: &mut v8::PinScope<'_, '_>, _args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let arena = &crate::dom::dom(scope).arena;
    rv.set_bool(arena.frame_navigations.1.turn.is_some_and(|key| arena.realm_state(0).is_some_and(|s| s.timers.holds(key))));
}
fn navigation_turn_delay(scope: &mut v8::PinScope<'_, '_>, _args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let arena = &crate::dom::dom(scope).arena;
    let now = arena.event_loop.clock;
    rv.set_double(if arena.frame_navigations.1.turn_ran == Some(now) { FRAME_NAV_PACE_MS } else { 0.0 });
}
fn navigation_turn_key(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let key = args.get(0).integer_value(scope);
    crate::dom::dom(scope).arena.frame_navigations.1.turn = key;
}
fn navigation_turn_ran(scope: &mut v8::PinScope<'_, '_>, _args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let arena = &mut crate::dom::dom(scope).arena;
    let now = arena.event_loop.clock;
    let plans = &mut arena.frame_navigations.1;
    plans.turn = None;
    plans.turn_ran = Some(now);
    plans.through = crate::navigation_plan::planned_so_far();
    plans.turn_due.set(1);
}
// __dom.takeFrameNavigations(kind) -> the navigations of the kind `kind` ("navigate", "reload") the host planned of
// frames and the navigation turn has made due, in the order they were planned, which none plans any more: `[realm, url,
// replace, initiatorRealm, referrerSource, referrerPolicy, [sandbox], activated]` each, a reload's `[realm, url]` — realm
// the frame's now, sandbox null where the container had no attribute.
fn take_frame_navigations(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let reloads = args.get(0).to_rust_string_lossy(scope) == "reload";
    let first = args.get(1).is_true();
    let arena = &mut crate::dom::dom(scope).arena;
    let through = arena.frame_navigations.1.through;
    let wanted = |&(at, ref h): &(u64, HostNavigation)| at <= through && !matches!(h, HostNavigation::Submit { .. }) && matches!(h, HostNavigation::Reload { .. }) == reloads;
    // (…in the order planned; the first alone where `first`)
    let mut due: Vec<(u64, NodeId, bool)> = Vec::new();
    for (&c, n) in &arena.frame_navigations.0 {
        due.extend(n.superseded.as_ref().filter(|h| wanted(h)).map(|&(at, _)| (at, c, true)));
        due.extend(n.host.as_ref().filter(|h| wanted(h)).map(|&(at, _)| (at, c, false)));
    }
    due.sort_by_key(|&(at, ..)| at);
    if first {
        due.truncate(1);
    }
    let mut taken: Vec<(u64, i32, HostNavigation, bool)> = Vec::new();
    for (_, c, superseded) in due {
        let realm = arena.frame_realm(c);
        let Some(nav) = arena.frame_navigations.0.get_mut(&c) else { continue };
        let Some((at, host)) = (if superseded { nav.superseded.take() } else { nav.host.take() }) else { continue };
        // (…none of a container whose navigable has no document now, nothing to navigate)
        let Some(realm) = realm else { continue };
        // (…its navigation begun now, the container's `sandbox` as it was planned what the document it makes — or a
        // download its response is — is sandboxed by: `frame_sandbox`, `take_frame_sandbox`)
        if let HostNavigation::Navigate { sandbox, container, .. } = &host {
            if !superseded {
                nav.sandbox = Some(sandbox.clone());
                nav.source = Some(container.clone());
            }
        }
        FrameNavigations::hold_planned_of(arena, realm);
        taken.push((at, realm, host, superseded));
    }
    taken.sort_by_key(|&(at, ..)| at);
    let mut items = Vec::with_capacity(taken.len());
    for (_, realm, host, superseded) in taken {
        let realm = v8::Integer::new(scope, realm).into();
        let item = match host {
            HostNavigation::Navigate { url, replace, initiator, referrer, sandbox, activated, .. } => {
                let sandbox = sandbox.map_or_else(|| v8::null(scope).into(), |s| v8::String::new(scope, &s).unwrap().into());
                let item = [
                    realm,
                    v8::String::new(scope, &url).unwrap().into(),
                    v8::Boolean::new(scope, replace).into(),
                    v8::Integer::new(scope, initiator).into(),
                    v8::String::new(scope, &referrer.0).unwrap().into(),
                    v8::String::new(scope, &referrer.1).unwrap().into(),
                    v8::Array::new_with_elements(scope, &[sandbox]).into(),
                    v8::Boolean::new(scope, activated).into(),
                    v8::Boolean::new(scope, superseded).into(),
                ];
                v8::Array::new_with_elements(scope, &item).into()
            }
            HostNavigation::Reload { url } => {
                let url = crate::subresource_obtain::text(scope, &url);
                v8::Array::new_with_elements(scope, &[realm, url]).into()
            }
            HostNavigation::Submit { .. } => unreachable!("taken one at a time: `take_submission`"),
        };
        items.push(item);
    }
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}

// __dom.cancelFrameNavigation(containerNid) — another navigation of the container's navigable replaces the one a form
// planned, the one the host planned and the one its attributes began (its `src` set — a navigation of whatever navigable it
// has then — the navigable destroyed with the container's removal, a traversal making its document again: HTML "apply the
// history step" sets its ongoing navigation to "traversal").
fn cancel_frame_navigation(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(container) = nid_arg(scope, &args, 0) else { return };
    let cid = realm_id(scope, &args);
    let arena = crate::dom::realm(scope, cid);
    arena.stop_attribute_navigation(container);
    if let Some(nav) = arena.frame_navigations.0.get_mut(&container) {
        nav.host = None;
        nav.superseded = None;
    }
}

// __dom.cancelFrameLocation(containerNid) — a `javascript:` URL's navigation of the container's navigable begun, its ongoing
// one now, HTML "navigate" setting it before it branches on the URL's scheme (url-parse.js `runJavascriptURL`, dom-nodes.js
// `_javascriptNavigation`): the navigation the host plans to make of it let go, and the one its attributes began — but not
// the form submission it plans to navigate to (`planned`), whose navigation HTML "plan to navigate" begins in a task after,
// ending that one, nor a reload, which is no ongoing navigation (navigation_plan.rs `let_go`). Chrome and Firefox go on with
// the one under way; the spec wins, ursm's ruling.
fn cancel_frame_location(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(container) = nid_arg(scope, &args, 0) else { return };
    let cid = realm_id(scope, &args);
    let arena = crate::dom::realm(scope, cid);
    arena.stop_attribute_navigation(container);
    if let Some(nav) = arena.frame_navigations.0.get_mut(&container) {
        nav.host.take_if(|(_, host)| matches!(host, HostNavigation::Navigate { .. }));
        nav.superseded = None;
    }
}

// __dom.frameLoadFired(containerNid, now, committed) — the element's `load` fires now, at `now` on the virtual clock
// (what paces the next: `frameLoadBegin`) — outside `load_due`: the load its document's delayed own reached it with,
// or (`committed`) the one of a navigation the host committed, which is the navigation it
// awaited completing and its load the once-per-navigation one.
fn frame_load_fired(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(container) = nid_arg(scope, &args, 0) else { return };
    let Some(at) = args.get(1).number_value(scope) else { return };
    let committed = args.get(2).is_true();
    let cid = realm_id(scope, &args);
    let arena = crate::dom::realm(scope, cid);
    if committed {
        arena.set_frame_nav(container, LOAD_FIRED, true);
    }
    arena.frame_navigation(container).loaded_at = Some(at);
}

// __dom.frameNavAsks(containerNid) -> the realm whose document the container's latest navigation asks now whether it may
// be unloaded (`RealmArena::frame_nav_asks`), -1 for none: the one it owes, no document above it asking already.
fn frame_nav_asks(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(container) = nid_arg(scope, &args, 0) else { return rv.set_int32(-1) };
    let cid = realm_id(scope, &args);
    rv.set_int32(crate::dom::realm(scope, cid).frame_nav_asks(container, None, -1));
}
impl RealmArena {
    // The realm whose document the navigation `generation` of the container (none: its latest) asks now whether it may be
    // unloaded, `asked` the frame's realm as that navigation began — -1 for none. A superseded one's task asks the document
    // it was to ask where it still is the frame's.
    fn frame_nav_asks(&mut self, container: NodeId, generation: Option<u32>, asked: i32) -> i32 {
        let realm = self.frame_realm(container);
        let latest = generation.is_none_or(|g| self.load_latest(container, g));
        if !latest {
            return if self.is_connected(container) && asked >= 0 && realm == Some(asked) { asked } else { -1 };
        }
        if !self.frame_nav_has(container, PROMPT_OWED) {
            return -1;
        }
        self.set_frame_nav(container, PROMPT_OWED, false);
        realm.filter(|&r| !self.ancestor_unloading(r)).unwrap_or(-1)
    }
}
// What HTML "navigate" makes of the URL the container's attributes give, as they are processed: no entry where the frame
// has no document yet (its first navigation, which its initial about:blank's entry takes), a navigation within its document
// (a fragment of it: no `load`, nothing unloaded), or one that adds an entry or replaces the current one.
const ATTR_NAV_NO_ENTRY: u32 = 0;
const ATTR_NAV_FRAGMENT: u32 = 1;
const ATTR_NAV_PUSH: u32 = 2;
const ATTR_NAV_REPLACE: u32 = 3;
// __dom.frameAttributesNavigate(container) -> `[ATTR_NAV_*, url]`, `url` what the navigation goes to, its `srcdoc`'s
// about:srcdoc, about:blank for none. Replaced where its document is not completely loaded (HTML "navigate an iframe or
// frame"), and where the URL is its document's own and of its origin (HTML "navigate", `auto`): `f.src = f.src` loads again
// and adds nothing, nor does a `srcdoc` set on one at about:srcdoc (Chrome and Firefox, `h` flat).
fn frame_attributes_navigate(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let answer = |scope: &mut v8::PinScope<'_, '_>, mut rv: v8::ReturnValue<'_, v8::Value>, code: u32, url: &str| {
        let items = [v8::Integer::new_from_unsigned(scope, code).into(), crate::subresource_obtain::text(scope, url)];
        rv.set(v8::Array::new_with_elements(scope, &items).into());
    };
    let Some(container) = crate::node_handle::nid_of(scope, args.get(0)) else { return answer(scope, rv, ATTR_NAV_NO_ENTRY, "") };
    let doc = node_document(scope, args.get(0));
    let cid = realm_id(scope, &args);
    let arena = crate::dom::realm(scope, cid);
    let Some(realm) = arena.frame_realm(container) else { return answer(scope, rv, ATTR_NAV_NO_ENTRY, "") };
    let Some(node) = arena.get(container) else { return answer(scope, rv, ATTR_NAV_NO_ENTRY, "") };
    let srcdoc = node.plain_attr("srcdoc").is_some();
    let src = node.plain_attr("src").filter(|s| !s.is_empty() && !srcdoc).map(str::to_owned);
    let root = arena.root_of(container);
    let doc = doc.or_else(|| arena.get(root).is_some_and(|n| n.kind == crate::dom::NodeKind::Document).then_some(root));
    let url = src.zip(doc).and_then(|(src, doc)| arena.parse_document_url(doc, &src));
    let origin = url.as_ref().map(|u| u.origin());
    let url = match url {
        Some(url) => url.href().to_owned(),
        None if srcdoc => "about:srcdoc".to_owned(),
        None => "about:blank".to_owned(),
    };
    let here = arena.enter_known(realm).map(|a| a.location.href().to_owned()).unwrap_or_default();
    let served = arena.served_origin(cid);
    // (…a document of the container's document's origin: another origin's, whose URL no script of this one may read, loads
    // again and fires its `load`, as Chrome and Firefox — WPT navigate-cross-origin-iframe-to-same-url-with-fragment — an
    // about: one's opaque URL origin none of its own)
    let inherits = here.starts_with("about:") || origin.as_ref().is_some_and(|o| *o == served);
    if !srcdoc && inherits && crate::url_ops::is_fragment_navigation(&here, &url) {
        return answer(scope, rv, ATTR_NAV_FRAGMENT, &url);
    }
    let loaded = arena.realm_document(realm).is_none_or(|d| arena.document_states.lifecycle(d).is_completely_loaded());
    let replace = !loaded || (here == url && origin.is_none_or(|o| o == served));
    answer(scope, rv, if replace { ATTR_NAV_REPLACE } else { ATTR_NAV_PUSH }, &url);
}

// __dom.renavigateFrame(containerNid, navFrom, isReload, historyUrl, byAttributes, src, begun, prompted, coming) -> whether
// the navigation's steps go on as a task (`coming`: the container's document queues them), its old document the frame's
// till then — false where none is coming for it, the caller unloading that document now. HTML "navigate" of the
// container's navigable, the steps it runs at once (dom-nodes.js `renavigateFrame`): the response it goes to carried in
// slot `navFrom` (-1: none, its URL fetched), the URL it starts with — `src` (null for none), whatever a beforeunload
// handler writes into the attribute after — `byAttributes` where its attributes' processing makes it (`srcdoc` read again),
// a reload (`isReload`), the session history entry it pushes as it commits (`historyUrl`, null for none), the sandboxing
// its host navigation began with (`begun`), its document asked already (`prompted`); the navigation under way superseded.
fn renavigate_frame(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    rv.set_bool(false);
    let Some(container) = nid_arg(scope, &args, 0) else { return };
    let nav_from = args.get(1).int32_value(scope).unwrap_or(-1);
    let is_reload = args.get(2).is_true();
    let history = args.get(3);
    let history = if history.is_null_or_undefined() { None } else { Some(utf16_arg(scope, history)) };
    let by_attributes = args.get(4).is_true();
    let src = args.get(5);
    let src = if src.is_null_or_undefined() { None } else { Some(utf16_arg(scope, src)) };
    let begun = v8::Local::<v8::Array>::try_from(args.get(6)).ok().map(|a| {
        let v = a.get_index(scope, 0).filter(|v| !v.is_null_or_undefined());
        v.map(|v| v.to_rust_string_lossy(scope))
    });
    let (prompted, coming) = (args.get(7).is_true(), args.get(8).is_true());
    let cid = realm_id(scope, &args);
    let arena = crate::dom::realm(scope, cid);
    if by_attributes {
        arena.set_frame_nav(container, URL_NAV, false);
    }
    let nav = arena.frame_navigation(container);
    // (…the response carried where it lies already — a javascript: URL's result — kept; a reload's the bytes of the document
    // it loaded last — a blob: URL's, revoked since — where that is the one it reloads, its fragment aside, and none where it
    // went on to another since: that one's URL loaded again)
    let unfragmented = |url: &[u16]| url.iter().position(|&c| c == u16::from(b'#')).map_or(url, |at| &url[..at]).to_vec();
    if is_reload && nav_from == CONTENT_LOADED as i32 {
        let (kept, reload) = (nav.contents[CONTENT_LOADED].as_ref().map(|c| unfragmented(&c.url)), nav.reload.as_deref().map(unfragmented));
        if kept.is_some() && reload.is_some() && kept != reload {
            nav.contents[CONTENT_LOADED] = None;
        }
    }
    match usize::try_from(nav_from).ok().filter(|&slot| slot < CONTENT_SLOTS) {
        Some(CONTENT_NAV) => {}
        Some(slot) => nav.contents[CONTENT_NAV] = nav.contents[slot].clone(),
        None => nav.contents[CONTENT_NAV] = None,
    }
    nav.flags &= !(LOAD_FIRED | SRC_REFUSED);
    nav.src = Some(src);
    match begun {
        Some(sandbox) => {
            nav.sandbox = Some(sandbox);
            nav.activated = false;
        }
        None => begin(arena, container),
    }
    let nav = arena.frame_navigation(container);
    if is_reload { nav.flags |= RELOAD_NAV } else { nav.flags &= !RELOAD_NAV }
    if history.is_none() {
        nav.flags &= !HISTORY_REPLACE;
    }
    nav.history = history;
    arena.supersede_frame_nav(container);
    crate::session_history::begin_navigation_of(arena, cid, Some(container));
    let later = coming && arena.frame_realm(container).is_some() && arena.is_connected(container);
    arena.set_frame_nav(container, COMMIT_PENDING, later);
    arena.set_frame_nav(container, PROMPT_OWED, later && !prompted);
    rv.set_bool(later);
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

// __dom.swDeferredReplays(containerNid) -> whether a build parked on a service worker still activating begins again now,
// its replay's task come (`takeSwDeferredFrames`): parked no more either way, begun again where the container is still
// connected — its whole navigation's steps, the build re-parking where another worker of its scope is activating.
fn sw_deferred_replays(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(container) = nid_arg(scope, &args, 0) else { return rv.set_bool(false) };
    let cid = realm_id(scope, &args);
    let arena = crate::dom::realm(scope, cid);
    arena.set_frame_nav(container, DEFERRED_SW, false);
    rv.set_bool(arena.is_connected(container));
}

// Whether a connected container of realm `cid`'s documents owes its element's `load`: HTML's iframe, which delays its
// document's load event until its load event steps ran.
// (…and those whose navigable is delaying load events: HTML "navigate" sets a child navigable's "is delaying load
// events" as a navigation of it begins, and "finalize a cross-document navigation" clears it — the document it makes
// delaying by its own load from then on, a navigation that makes none (a 204, a download) delaying nothing — and an
// iframe delays its document's load while its content navigable is delaying load events. Here: a navigation planned of
// it, its location's, its reload's or a form's to it, the host has not taken yet — taking it is finalizing it, the fetch
// and the document it makes run as it is taken: browser.rb `consume_pending_frame_nav`, frame-nav.js `land`.)
fn frame_loads_owed(arena: &RealmArena, cid: i32) -> bool {
    arena.frame_navigations.0.iter().any(|(&container, nav)| {
        (nav.flags & LOAD_OWED != 0 || nav.delaying_load_events())
            && arena.get(container).is_some_and(|n| n.realm == cid)
            && arena.is_connected(container)
    })
}
// __dom.frameNavigationFinalized(containerNid) -> the realm of the container's document, to ask about its load again, or
// -1: HTML "finalize a cross-document navigation" of the container's navigable — its plan taken (and the document it
// made, which delays the load by its own from here on, or none: a 204, a download, a failure), landed, or cancelled,
// which every one of those paths answers through — clearing its "is delaying load events" where no later navigation
// of it is planned meanwhile (`delaying_load_events`).
fn frame_navigation_finalized(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    rv.set_int32(-1);
    let Some(container) = nid_arg(scope, &args, 0) else { return };
    let arena = &crate::dom::dom(scope).arena;
    if arena.frame_navigations.0.get(&container).is_some_and(FrameNavigation::delaying_load_events) {
        return;
    }
    if let Some(node) = arena.get(container) {
        rv.set_int32(node.realm);
    }
}
impl FrameNavigation {
    // Whether its navigable is delaying load events: a navigation planned of it not taken yet (`frame_loads_owed`).
    fn delaying_load_events(&self) -> bool {
        self.host.is_some()
    }
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

// __dom.loadDelay() -> the calling realm's document's load delay (0 none, `LOAD_DELAYED`, `CONTAINER_LOAD_OWED`), which
// its load steps set (document_lifecycle.rs `docLoadSteps`).
fn load_delay(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    rv.set_uint32(u32::from(*load_delay_of(scope, cid)));
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

// __dom.loadDelaySettled() -> whether the calling realm's document's load was delayed and nothing delays it now
// (`load_delayed_here`): its load due.
fn load_delay_settled(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    let arena = crate::dom::realm(scope, cid);
    rv.set_bool(arena.realm_state(cid).is_some_and(|s| s.load_delay != 0) && !arena.load_delayed_here(cid));
}
// __dom.loadDelayedNow() -> whether something delays the calling realm's document's load event now: what
// `load_delayed_here` counts, or a load gate's work still to run (load_gates.rs).
fn load_delayed_now(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    let arena = crate::dom::realm(scope, cid);
    rv.set_bool(arena.load_delayed_here(cid) || arena.realm_state(cid).is_some_and(|s| s.load_gates.pending()));
}
impl RealmArena {
    // Whether something delays realm `cid`'s document's load event now: its images (image_requests.rs
    // `images_delay_load`), a load gate's work under way or one late that holds it (load_gates.rs), its containers' loads still owed
    // (`frame_loads_owed`), and its child navigables' documents
    // whose own load is delayed.
    // Whether realm `cid`'s document has a frame in it.
    pub(crate) fn has_frames(&self, cid: i32) -> bool {
        self.frame_navigations.0.keys().any(|&container| self.get(container).is_some_and(|n| n.realm == cid) && self.is_connected(container))
    }
    pub(crate) fn load_delayed_here(&self, cid: i32) -> bool {
        self.images_delay_load(cid)
            || self.realm_state(cid).is_some_and(|s| s.load_gates.running() || s.load_gates.holding())
            || frame_loads_owed(self, cid)
            || self.child_realms(cid).into_iter().any(|kid| self.realm_state(kid).is_some_and(|s| s.load_delay != 0))
    }
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
            let now = self.event_loop.clock;
            let nav = self.frame_navigation(container);
            if flags & CONTEXT_READY != 0 && nav.flags & CONTEXT_READY == 0 {
                nav.created = Some(now);
            }
            nav.flags |= flags;
        } else if let Some(nav) = self.frame_navigations.0.get_mut(&container) {
            // (…a build parked no more no replay's either)
            let flags = if flags & DEFERRED_SW != 0 { flags | DEFERRED_LISTED } else { flags };
            nav.flags &= !flags;
            // (…its navigable destroyed with its post-insertion step undone — the container removed — and what the window
            // of its initial about:blank document had with it: one inserted again is a new one's)
            if flags & CONTEXT_READY != 0 {
                nav.activation = None;
                nav.created = None;
            }
        }
    }
}

// __dom.supersedeFrameNav(containerNid) — another navigation of the container's is its latest: the one under way
// superseded, by a navigation of its own or a host's that committed first — and the element `load` it owed with it, the
// latest one owing its own as it queues it.
// (…and its child navigable's navigation begun, its ongoing one: session_history.rs `begin_navigation_of`)
fn supersede_frame_nav(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(container) = nid_arg(scope, &args, 0) else { return };
    let cid = realm_id(scope, &args);
    let arena = crate::dom::realm(scope, cid);
    arena.supersede_frame_nav(container);
    crate::session_history::begin_navigation_of(arena, cid, Some(container));
}
// What HTML "stop loading" the container's navigable cancels, where its document's unload counter is 0: for a document
// opened (dom-nodes.js `_open`), whose document open steps stop only "if ongoing navigation is a navigation ID", the
// navigation its attributes began (`stop_attribute_navigation`) and the host's to a URL — a `location`'s, a link's: HTML
// "navigate" begun as they are. Not a form's still planned, which HTML "plan to navigate" queues with no ongoing navigation
// (Firefox; Chrome cancels it), nor a reload (Firefox; Chrome cancels it too).
// `stop()` (`by_stop`) cancels those too, as Chrome and Firefox do, where the text leaves it to inference. Whether there was
// a navigation to stop.
fn stop_frame(arena: &mut RealmArena, cid: i32, container: NodeId, by_stop: bool) -> bool {
    let frame = arena.frame_realm(container);
    if frame.is_some_and(|r| arena.unloading(r)) {
        return false;
    }
    crate::session_history::begin_navigation_of(arena, cid, Some(container));
    let mut stopped = arena.stop_attribute_navigation(container);
    if arena.frame_navigations.0.get(&container).is_some_and(|nav| nav.awaiting_response) {
        arena.supersede_frame_nav(container);
        arena.take_frame_history_url(container);
        stopped = true;
    }
    if let Some(nav) = arena.frame_navigations.0.get_mut(&container) {
        if nav.host.take_if(|(_, host)| by_stop || matches!(host, HostNavigation::Navigate { .. })).is_some() | nav.superseded.take().is_some() {
            stopped = true;
        }
    }
    if let (true, Some(frame)) = (by_stop, frame) {
        stopped |= crate::navigation_plan::drop_routed(arena, frame);
    }
    // (…a frame with no document yet left at its initial about:blank, a read of its window making none of its `src`: Chrome
    // and Firefox)
    if stopped && frame.is_none() {
        let nav = arena.frame_navigation(container);
        nav.flags |= SRC_REFUSED;
        nav.src = None;
    }
    stopped
}
// __dom.stopFrameLoading(containerNid, byStop) -> `stop_frame`.
fn stop_frame_loading(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(container) = nid_arg(scope, &args, 0) else { return rv.set_bool(false) };
    let by_stop = args.get(1).is_true();
    let cid = realm_id(scope, &args);
    rv.set_bool(stop_frame(crate::dom::realm(scope, cid), cid, container, by_stop));
}
// __dom.stopChildFramesLoading() -> the containers in the calling realm's document, and in its frames' documents down, whose
// navigations `stop()` stopped: it cancels "any instances of the fetch algorithm in the context of document", of a frame's
// navigation its parent began among them (Chrome and Firefox cancel them all, by whichever document's script they began,
// their frames' not yet built too).
fn stop_child_frames_loading(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    let arena = crate::dom::realm(scope, cid);
    let mut realms = vec![cid];
    let mut next = 0;
    while next < realms.len() {
        realms.extend(arena.child_realms(realms[next]));
        next += 1;
    }
    let containers: Vec<(NodeId, i32)> = arena.frame_navigations.0.keys().filter_map(|&c| arena.get(c).filter(|n| realms.contains(&n.realm)).map(|n| (c, n.realm))).collect();
    let stopped: Vec<NodeId> = containers.into_iter().filter(|&(c, realm)| stop_frame(arena, realm, c, true)).map(|(c, _)| c).collect();
    let items: Vec<v8::Local<v8::Value>> = stopped.iter().map(|id| v8::Number::new(scope, id.to_f64()).into()).collect();
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}
impl RealmArena {
    // The navigation the container's attributes began, its build still to commit — queued (`BUILD_QUEUED`), or the frame
    // at the initial about:blank made meanwhile (`COMMIT_PENDING`) — cancelled: by another navigation of its navigable,
    // which replaces it as the ongoing one (HTML "navigate": a location's, a link's or a form's targeting it, a
    // `window.open` naming it), or by its document opened again ("stop loading"). Its build, run, then keeps the document
    // the frame is at, and the element `load` it owed is owed no more (`supersede_frame_nav`) — the navigation replacing
    // it owes its own. Whether there was one.
    pub(crate) fn stop_attribute_navigation(&mut self, container: NodeId) -> bool {
        if self.frame_nav(container) & (COMMIT_PENDING | BUILD_QUEUED) == 0 {
            return false;
        }
        self.frame_navigation(container).flags &= !(COMMIT_PENDING | BUILD_QUEUED | PROMPT_OWED);
        self.supersede_frame_nav(container);
        true
    }
    // …and every navigation of the frame of navigable `nav`, a traversal making its document again — HTML "apply the
    // history step" sets its ongoing navigation to "traversal": the one its attributes began and the one the host plans of
    // it (a `location`'s, a link's, a form's of its parent's document), each finalized as it is let go of
    // (`frameNavigationFinalized`): the realm of its container's document, whose load it delays no more — none for a
    // navigable of no live frame.
    pub(crate) fn traversal_cancels_frame(&mut self, nav: u32) -> Option<i32> {
        let container = self.navigable_realms(nav).into_iter().rev().find_map(|r| self.live_container(r))?;
        self.stop_attribute_navigation(container);
        if let Some(n) = self.frame_navigations.0.get_mut(&container) {
            n.host = None;
            n.superseded = None;
        }
        self.get(container).map(|node| node.realm)
    }
    // (…a response held for it let go of, and the build that waited on it, which its document's load waits for no more)
    pub(crate) fn supersede_frame_nav(&mut self, container: NodeId) {
        let nav = self.frame_navigation(container);
        nav.generation = nav.generation.wrapping_add(1);
        nav.flags &= !(LOAD_OWED | BUILD_QUEUED);
        if nav.held.take().is_some() {
            let realm = self.get(container).map(|n| n.realm);
            if let Some(state) = realm.and_then(|r| self.realm_state_mut(r)) {
                state.load_gates.forget_held_frame(container);
            }
        }
    }
    // The navigation of the container whose response its build goes to wait on: its number, whether another has replaced it
    // by the time the response is in — none of it to load then (HTML "abort a document": "discarding any further data
    // received from the network"; "navigate" ends the ongoing one).
    pub(crate) fn await_frame_response(&mut self, container: NodeId) -> u32 {
        let nav = self.frame_navigation(container);
        nav.awaiting_response = true;
        nav.generation
    }
    // The response of navigation `generation` held until its server's time has passed (`held`), the navigation its
    // navigable's ongoing one still — and taken back as its build comes again.
    pub(crate) fn hold_frame_response(&mut self, container: NodeId, generation: u32, started: f64, response: v8::Global<v8::Value>) {
        let nav = self.frame_navigation(container);
        nav.awaiting_response = true;
        nav.held = Some((generation, started, response));
    }
    pub(crate) fn take_held_frame_response(&mut self, container: NodeId) -> Option<(u32, f64, v8::Global<v8::Value>)> {
        // (…none of a navigation one begun since superseded)
        self.frame_navigations.0.get_mut(&container).and_then(|nav| nav.held.take().filter(|&(generation, ..)| generation == nav.generation))
    }
    pub(crate) fn frame_response_in(&mut self, container: NodeId, generation: u32) -> bool {
        let nav = self.frame_navigation(container);
        nav.awaiting_response = false;
        nav.generation == generation
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

// The slot a `javascript:` URL's document is carried in (frame-nav.js `FC_NAV`), and the one the document loaded last
// is (`FC_LOADED`).
const CONTENT_NAV: usize = 0;
const CONTENT_LOADED: usize = 1;

// What a frame's document is loaded from (frame_response.rs `frame_response`): the document a navigation carries, its
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
    // - the document a navigation carries (a `javascript:` URL's), taken, and kept as the document loaded last, which
    //   a reload loads again;
    // - its `srcdoc`;
    // - the URL it navigates to: a reload's kept URL, else the one its navigation started with, else its `src` — none
    //   where that is none, empty or about:blank, refused as its attributes were last processed, or no URL its document
    //   parses; else by its scheme.
    pub(crate) fn frame_source(&mut self, container: NodeId, doc: Option<NodeId>) -> (FrameSource, bool) {
        let nav = self.frame_navigation(container);
        let reload = nav.flags & RELOAD_NAV != 0;
        // (…a navigation of the frame's navigable to a URL — its document's own, a form's, a link's — not its attributes'
        // processing, which alone reads `srcdoc`: HTML "process the iframe attributes"; Chrome and Firefox take a srcdoc
        // frame's form to `about:blank?`)
        let navigated = nav.flags & URL_NAV != 0;
        nav.flags &= !(RELOAD_NAV | URL_NAV);
        nav.loading_srcdoc = None;
        let kept = nav.reload.take();
        let reload_url = kept.filter(|_| reload);
        // (…the fragment its URL has, where that is about:srcdoc: what it was at, or a traversal's)
        let going_to = reload_url.clone().or_else(|| nav.src.clone().flatten()).map(|url| String::from_utf16_lossy(&url)).unwrap_or_default();
        nav.srcdoc_fragment = match going_to.split_once('#') {
            Some((url, fragment)) if url.eq_ignore_ascii_case("about:srcdoc") => format!("#{fragment}"),
            _ => String::new(),
        };
        if let Some(srcdoc) = nav.traversal_srcdoc.take() {
            nav.loading_srcdoc = Some(srcdoc.clone());
            return (FrameSource::Srcdoc(srcdoc), reload);
        }
        if let Some(content) = nav.contents[CONTENT_NAV].take() {
            nav.contents[CONTENT_LOADED] = Some(content.clone());
            return (FrameSource::Navigation(content), reload);
        }
        let started = nav.src.clone();
        let refused = nav.flags & SRC_REFUSED != 0;
        // (…its `srcdoc`, but for a reload of the document it went on to since: one of another URL than about:srcdoc, its
        // fragment aside)
        let went_on = reload_url.as_ref().is_some_and(|url| {
            let url = String::from_utf16_lossy(url);
            let url = url.split('#').next().unwrap_or_default();
            !url.eq_ignore_ascii_case("about:srcdoc")
        });
        // (…a reload of a srcdoc document its own markup, its entry's, whatever the attribute says now)
        let own = self.frame_navigations.0.get(&container).and_then(|nav| nav.document_srcdoc.clone()).filter(|_| reload && !went_on);
        if let Some(srcdoc) = own {
            self.frame_navigation(container).loading_srcdoc = Some(srcdoc.clone());
            return (FrameSource::Srcdoc(srcdoc), reload);
        }
        let Some(node) = self.get(container) else { return (FrameSource::None, reload) };
        // (…refused, a `srcdoc` has only `stop()` to refuse it: `process_src` asks about a `src` where it has none)
        if let Some(srcdoc) = node.plain_attr("srcdoc").filter(|_| !went_on && !refused && !navigated).map(str::to_owned) {
            self.frame_navigation(container).loading_srcdoc = Some(srcdoc.clone());
            return (FrameSource::Srcdoc(srcdoc), reload);
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
// its load as a task — paced, where its last `load` fired this instant, by a nested-timer clamp; or, where no document is
// built as it connects and the frame has one to leave, that one unloaded on the navigation's task, then its load.
const LOAD_NONE: u32 = 0;
const LOAD_NOW: u32 = 1;
const LOAD_BUILD: u32 = 2;
const LOAD_TASK: u32 = 3;
const LOAD_COMMIT: u32 = 4;
const FRAME_NAV_PACE_MS: f64 = 4.0;
// …and as it comes to fire (`load_due`): nothing (a navigation superseded it, or its document's own delayed load
// fires it after itself), the load it owed paid with no event (its container gone), or its `load`.
const DUE_NONE: u32 = 0;
const DUE_PAID: u32 = 1;
const DUE_FIRE: u32 = 2;

// __dom.frameLoadBegin(container, initialInsertion, now, host) -> [step, delay, run]
// of the container's `load` (`LOAD_*`, its delay in virtual ms, the run of its steps: `LoadRun`): once per navigation — not on
// every connect step, nor its own build; a removal and a reassigned `src` / `srcdoc` clear the guard — owed from now until
// it fires, delaying its document's own; at once on its initial insertion where it navigates to about:blank (Chrome and
// Firefox: inside the `appendChild`, which a listener added after it never sees); else, where its document is built as
// it connects (`builds_eagerly`), that build — a `blob:` `src` snapshotted now,
// so a revoke right after the insertion still loads: the navigation took its reference here — then its load. `host`
// the bindings' (subresource-host.js), `now` the virtual clock.
fn frame_load_begin(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let answer = |scope: &mut v8::PinScope<'_, '_>, mut rv: v8::ReturnValue<'_, v8::Value>, step: u32, delay: f64, run: u32| {
        let items = [v8::Integer::new_from_unsigned(scope, step).into(), v8::Number::new(scope, delay).into(), v8::Integer::new_from_unsigned(scope, run).into()];
        rv.set(v8::Array::new_with_elements(scope, &items).into());
    };
    let Some(container) = crate::node_handle::nid_of(scope, args.get(0)) else { return answer(scope, rv, LOAD_NONE, 0.0, 0) };
    let initial = args.get(1).is_true();
    let now = args.get(2).number_value(scope).unwrap_or(0.0);
    let Ok(host) = v8::Local::<v8::Function>::try_from(args.get(3)) else { return answer(scope, rv, LOAD_NONE, 0.0, 0) };
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
        let run = arena.begin_load_run(container, generation, false);
        return answer(scope, rv, LOAD_NOW, 0.0, run);
    }
    if !arena.builds_eagerly(container, doc) {
        let commit = arena.frame_nav_has(container, COMMIT_PENDING);
        let run = arena.begin_load_run(container, generation, commit);
        return answer(scope, rv, if commit { LOAD_COMMIT } else { LOAD_TASK }, delay, run);
    }
    let held = arena.frame_navigations.0.get(&container).is_some_and(|n| n.contents[CONTENT_NAV].is_some());
    let src = arena.get(container).and_then(|n| n.plain_attr("src")).map(str::to_owned).filter(|_| !held);
    let url = src.zip(doc).and_then(|(src, doc)| arena.parse_document_url(doc, &src)).map(|u| u.href().to_owned());
    if let Some(url) = url.filter(|u| crate::fetch_rules::fetch_route(u, 0, "") == crate::fetch_rules::ROUTE_BLOB) {
        let Ok(response) = crate::subresource_obtain::scheme_response(scope, host, &url) else { return };
        if let Some((bytes, content_type)) = response {
            let content_type = if content_type.is_empty() { "text/html".to_owned() } else { content_type };
            let units = |s: &str| s.encode_utf16().collect::<Vec<u16>>();
            let content = Content { url: units(&url), bytes, content_type: units(&content_type), referrer: Vec::new(), policy: Vec::new(), csp: Vec::new() };
            crate::dom::realm(scope, cid).frame_navigation(container).contents[CONTENT_NAV] = Some(content);
        }
    }
    let arena = crate::dom::realm(scope, cid);
    arena.set_frame_nav(container, BUILD_QUEUED, true);
    let run = arena.begin_load_run(container, generation, false);
    answer(scope, rv, LOAD_BUILD, delay, run);
}
// The container's `load` for navigation `generation` as it comes to fire (`DUE_*`), at `now` on the virtual clock (kept as
// when its last `load` fired, which paces the next).
fn load_due(scope: &mut v8::PinScope<'_, '_>, cid: i32, container: NodeId, generation: u32, now: f64) -> u32 {
    let arena = crate::dom::realm(scope, cid);
    if !arena.is_connected(container) {
        return DUE_PAID;
    }
    if arena.frame_navigation(container).generation != generation {
        return DUE_NONE;
    }
    // (…none past the nesting limit, which makes it no document: navigables.rs `MAX_FRAME_DEPTH`)
    if arena.realm_tree(cid).1 >= crate::navigables::MAX_FRAME_DEPTH {
        return DUE_PAID;
    }
    // (…none, and none owed, for a document whose navigable planned another navigation while its parser was active — its
    // location set, a form submitted to it, its reload: HTML "navigate" aborts it ("abort a document and its
    // descendants" → "abort a parser"), and an aborted document completes no load. The navigation's document, where it makes one, owes
    // the container a load of its own as it begins; one that makes none — a 204, a download — leaves the container's
    // document waiting on nothing, as Chrome fires only its page's load. One planned by its load's handlers once it
    // loaded leaves its load the container's to fire: "completely finish loading" queues it as the load task ends.)
    if arena.frame_navigations.0.get(&container).is_some_and(|n| n.aborted_document && n.host.is_some()) {
        return DUE_PAID;
    }
    // (…nor in a document that has unloaded, its realm's document gone — a navigation of its navigable replaced it: Chrome
    // fires none of its frames' loads, rv-sf-probe `u_nested`. One the navigation aborted that is still active — a 204, a
    // download, a navigation stopped, which make no document — fires them still: `t_204_late`)
    if arena.realm_document(cid).is_none() {
        return DUE_PAID;
    }
    // (…nor for a document `stop()` aborted as it parsed: Chrome and Firefox fire neither its load nor this one)
    if arena.frame_realm(container).and_then(|frame| arena.realm_document(frame)).is_some_and(|doc| arena.document_states.lifecycle(doc).is_aborted()) {
        return DUE_PAID;
    }
    // (…none yet where the frame's document has its load delayed — its images fetched — which fires this one with its
    // own, after it: the container's load comes after its document's)
    if let Some(frame) = arena.frame_realm(container) {
        if owe_container_load_of(scope, frame) {
            return DUE_NONE;
        }
    }
    crate::dom::realm(scope, cid).frame_navigation(container).loaded_at = Some(now);
    DUE_FIRE
}

// The phases of a load run's steps (`frameLoadNext`): its navigation's task (`LOAD_PHASE_RUN`) — on the first, where its
// document is to be asked whether it may be unloaded, that alone; the build under its load gate, then its `load` queued
// (`LOAD_PHASE_BUILD`), or the build alone, held while another was under way (`LOAD_PHASE_BUILD_ONLY`); its `load`
// (`LOAD_PHASE_FIRE`), or at once, inside the insertion (`LOAD_PHASE_FIRE_NOW`) — those the bindings run — and those the
// bindings come back with, its answer to the step it was handed.
const LOAD_PHASE_RUN: u32 = 0;
const LOAD_PHASE_BUILD: u32 = 1;
const LOAD_PHASE_BUILD_ONLY: u32 = 2;
const LOAD_PHASE_FIRE: u32 = 3;
const LOAD_PHASE_FIRE_NOW: u32 = 4;
const LOAD_PHASE_ASKED: u32 = 5;
const LOAD_PHASE_ASK_DONE: u32 = 6;
const LOAD_PHASE_GATE_TAKEN: u32 = 7;
const LOAD_PHASE_BUILT: u32 = 8;
const LOAD_PHASE_BUILT_ONLY: u32 = 9;
const LOAD_PHASE_QUEUE_LOAD: u32 = 10;
const LOAD_PHASE_COMMITTED: u32 = 11;
const LOAD_PHASE_END: u32 = 12;
// What the bindings do next (`frameLoadNext`), then coming back with the phase it names: nothing more; ask realm `arg`'s
// document whether it may be unloaded (answer 1: it may); abort realm `arg`'s document and its descendants; end the
// navigation, declined ("finalize a cross-document navigation"); queue the run's task again; take load gate `arg`; build the
// frame (answer: the milliseconds its response is late by, `frameLater`); queue the build again under a load gate that
// holds the page's load, that late; unload the document the frame leaves (`commitFrameNavigation`); queue its `load` as a
// microtask; fire it (`arg` 1: inside the insertion); pay it with none fired.
const LOAD_DONE: u32 = 0;
const LOAD_ASK: u32 = 1;
const LOAD_ABORT: u32 = 2;
const LOAD_FINALIZE: u32 = 3;
const LOAD_QUEUE: u32 = 4;
const LOAD_TAKE_GATE: u32 = 5;
const LOAD_BUILD_NOW: u32 = 6;
const LOAD_LATER: u32 = 7;
const LOAD_UNLOAD: u32 = 8;
const LOAD_MICROTASK: u32 = 9;
const LOAD_FIRE: u32 = 10;
const LOAD_PAY: u32 = 11;

impl RealmArena {
    fn begin_load_run(&mut self, container: NodeId, generation: u32, commit: bool) -> u32 {
        self.frame_navigations.1.load_runs = self.frame_navigations.1.load_runs.wrapping_add(1);
        let id = self.frame_navigations.1.load_runs;
        let ask = self.frame_nav_has(container, PROMPT_OWED).then(|| self.frame_realm(container).unwrap_or(-1));
        let nav = self.frame_navigation(container);
        nav.runs.retain(|r| r.generation == generation || r.pending());
        nav.runs.push(LoadRun { id, generation, commit, ask, asking: -1, gate: None, gate_taken: false, building: false, load_queued: false });
        id
    }
    fn load_run(&mut self, container: NodeId, id: u32) -> Option<&mut LoadRun> {
        self.frame_navigations.0.get_mut(&container)?.runs.iter_mut().find(|r| r.id == id)
    }
    // A step of run `id` come to run while the frame's build is under way: held till it ends.
    fn hold_load_step(&mut self, container: NodeId, id: u32, phase: u32) {
        self.frame_navigation(container).after_build.push((id, phase));
    }
    // The steps held while the build was under way, which the bindings run again as it ends (`frameBuildEnd`).
    pub(crate) fn take_after_build(&mut self, container: NodeId) -> Vec<(u32, u32)> {
        self.frame_navigations.0.get_mut(&container).map(|n| std::mem::take(&mut n.after_build)).unwrap_or_default()
    }
    // Whether the frame's navigation is still navigation `generation`.
    fn load_latest(&self, container: NodeId, generation: u32) -> bool {
        self.frame_navigations.0.get(&container).is_some_and(|n| n.generation == generation)
    }
}

// The next thing run `id`'s steps do as the bindings run phase `phase` of them, `answer` theirs to the last step — `(what,
// the phase to come back with, its argument)` (`LOAD_*`): the order of HTML "navigate"'s steps for an iframe, its build
// (`frameWindow`) and the iframe load event steps.
fn load_next(scope: &mut v8::PinScope<'_, '_>, cid: i32, container: NodeId, id: u32, mut phase: u32, answer: f64, now: f64) -> (u32, u32, i32) {
    let done = (LOAD_DONE, LOAD_PHASE_RUN, 0);
    loop {
        let arena = crate::dom::realm(scope, cid);
        let Some(run) = arena.load_run(container, id).map(|r| *r) else {
            // (…a run gone — its `load` fired, or a superseded navigation's with nothing left to do: `LoadRun::pending` — whose
            // `load` is owed no more, but paid where its container is gone, as its own steps would have)
            let fire = matches!(phase, LOAD_PHASE_FIRE | LOAD_PHASE_FIRE_NOW | LOAD_PHASE_QUEUE_LOAD);
            return if fire && !arena.is_connected(container) { (LOAD_PAY, LOAD_PHASE_RUN, 0) } else { done };
        };
        let latest = arena.load_latest(container, run.generation);
        let update = |arena: &mut RealmArena, change: &dyn Fn(&mut LoadRun)| {
            if let Some(r) = arena.load_run(container, id) {
                change(r);
            }
        };
        match phase {
            LOAD_PHASE_RUN => {
                // (…its first task, where its document is to be asked: that alone, the rest on a task after it — what its
                // handlers queue, a message to the page, runs with that document still the frame's)
                if let Some(asked) = run.ask {
                    update(arena, &|r| r.ask = None);
                    let realm = arena.frame_nav_asks(container, Some(run.generation), asked);
                    if realm >= 0 {
                        update(arena, &|r| r.asking = realm);
                        return (LOAD_ASK, LOAD_PHASE_ASKED, realm);
                    }
                    return (LOAD_QUEUE, LOAD_PHASE_RUN, 0);
                }
                if run.commit {
                    if !latest {
                        return done;
                    }
                    if arena.frame_nav_has(container, COMMIT_PENDING) {
                        return (LOAD_UNLOAD, LOAD_PHASE_COMMITTED, 0);
                    }
                    phase = LOAD_PHASE_COMMITTED;
                    continue;
                }
                match run.gate {
                    Some(gate) => {
                        update(arena, &|r| r.gate_taken = true);
                        return (LOAD_TAKE_GATE, LOAD_PHASE_GATE_TAKEN, gate as i32);
                    }
                    None => phase = LOAD_PHASE_QUEUE_LOAD,
                }
            }
            // (…none going on where the user declines to unload it — HTML "navigate", aborted: the document the frame's own,
            // its container's load delayed by the navigation no more — and, going on, its document aborted with its
            // descendants where its load has yet to fire: HTML "navigate", "queue a global task … to abort a document and
            // its descendants given navigable's active document" — a parse that waits on a server's time stops there, and
            // "the end" with it (rv-sf-probe `y_frame_resrc150`, `z_frame_module_abort`), the container's load, which the
            // navigation owes now, still held)
            LOAD_PHASE_ASKED => {
                if answer == 0.0 {
                    return (LOAD_FINALIZE, LOAD_PHASE_RUN, 0);
                }
                let realm = run.asking;
                let loading = arena.realm_document(realm).is_some_and(|d| !arena.document_states.lifecycle(d).is_load_fired());
                if latest && loading {
                    return (LOAD_ABORT, LOAD_PHASE_ASK_DONE, realm);
                }
                phase = LOAD_PHASE_ASK_DONE;
            }
            LOAD_PHASE_ASK_DONE => return (LOAD_QUEUE, LOAD_PHASE_RUN, 0),
            LOAD_PHASE_COMMITTED => return (LOAD_MICROTASK, LOAD_PHASE_RUN, 0),
            LOAD_PHASE_GATE_TAKEN => phase = LOAD_PHASE_QUEUE_LOAD,
            // The build (`frameWindow`), where the navigation is still the frame's latest, the frame connected and not built
            // already — a read of its `contentWindow` as its parent parsed made it, and reaching into a frame that has a
            // document in flight is how a planned navigation got lost (reparent-form-during-planned-navigation-task).
            LOAD_PHASE_BUILD | LOAD_PHASE_BUILD_ONLY => {
                let then = if phase == LOAD_PHASE_BUILD { LOAD_PHASE_QUEUE_LOAD } else { u32::MAX };
                if arena.frame_nav_has(container, BUILDING) {
                    arena.hold_load_step(container, id, LOAD_PHASE_BUILD_ONLY);
                } else if latest {
                    arena.set_frame_nav(container, BUILD_QUEUED, false);
                    let built = arena.frame_realm(container).is_some() && !arena.frame_nav_has(container, COMMIT_PENDING);
                    if arena.is_connected(container) && !built {
                        return (LOAD_BUILD_NOW, if then == u32::MAX { LOAD_PHASE_BUILT_ONLY } else { LOAD_PHASE_BUILT }, 0);
                    }
                }
                if then == u32::MAX {
                    return done;
                }
                phase = then;
            }
            // (…its response in later: built again then, under a gate that holds the page's load, its `load` waiting)
            LOAD_PHASE_BUILT | LOAD_PHASE_BUILT_ONLY => {
                let building = answer > 0.0;
                update(arena, &|r| r.building = building);
                let then = if phase == LOAD_PHASE_BUILT { LOAD_PHASE_QUEUE_LOAD } else { u32::MAX };
                if building {
                    arena.set_frame_nav(container, BUILD_QUEUED, true);
                    return (LOAD_LATER, if then == u32::MAX { LOAD_PHASE_END } else { then }, 0);
                }
                if then == u32::MAX {
                    return done;
                }
                phase = then;
            }
            // Its `load` as a microtask, once: after the build, whoever ran it — the page's `load` flushing it ahead of the
            // task, whose handler's message to the page comes after the `load` of its frame — none while it is to be built
            // again, nor while it is parked on a service worker still activating (Handle Fetch waits for 'activated'), which
            // begins it all again as the activation settles (`takeSwDeferredFrames`).
            LOAD_PHASE_QUEUE_LOAD => {
                if run.load_queued || run.building || arena.frame_nav_has(container, DEFERRED_SW) {
                    return done;
                }
                update(arena, &|r| r.load_queued = true);
                return (LOAD_MICROTASK, LOAD_PHASE_RUN, 0);
            }
            // (…none while its build is under way: after it)
            LOAD_PHASE_FIRE | LOAD_PHASE_FIRE_NOW => {
                if arena.frame_nav_has(container, BUILDING) {
                    arena.hold_load_step(container, id, LOAD_PHASE_FIRE);
                    return done;
                }
                let due = load_due(scope, cid, container, run.generation, now);
                if let Some(nav) = crate::dom::realm(scope, cid).frame_navigations.0.get_mut(&container) {
                    nav.runs.retain(|r| r.id != id);
                }
                return match due {
                    DUE_PAID => (LOAD_PAY, LOAD_PHASE_END, 0),
                    DUE_FIRE => (LOAD_FIRE, LOAD_PHASE_END, i32::from(phase == LOAD_PHASE_FIRE_NOW)),
                    _ => done,
                };
            }
            _ => return done,
        }
    }
}
// __dom.frameLoadNext(container, run, phase, answer, now) -> the next thing the bindings do (`load_next`): `what` in the
// low 4 bits, the phase to come back with in the next 4, its argument above.
fn frame_load_next(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    rv.set_int32(0);
    let Some(container) = crate::node_handle::nid_of(scope, args.get(0)) else { return };
    let id = args.get(1).uint32_value(scope).unwrap_or(0);
    let phase = args.get(2).uint32_value(scope).unwrap_or(u32::MAX);
    let answer = args.get(3).number_value(scope).unwrap_or(0.0);
    let now = args.get(4).number_value(scope).unwrap_or(0.0);
    let cid = realm_id(scope, &args);
    let (what, next, arg) = load_next(scope, cid, container, id, phase, answer, now);
    rv.set_int32(what as i32 | (next as i32) << 4 | arg << 8);
}
// __dom.frameLoadGate(container, run, gate) — the load gate run `run`'s build runs under (`LoadRun::gate`).
fn frame_load_gate(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(container) = crate::node_handle::nid_of(scope, args.get(0)) else { return };
    let id = args.get(1).uint32_value(scope).unwrap_or(0);
    let gate = args.get(2).uint32_value(scope);
    let cid = realm_id(scope, &args);
    if let Some(run) = crate::dom::realm(scope, cid).load_run(container, id) {
        run.gate = gate;
    }
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
        self.parse_document_url(doc, &src).is_none_or(|url| crate::url_ops::matches_about_blank(&url))
    }
}

// The node document of a node object (its handle's), none for one of no handle.
fn node_document(scope: &mut v8::PinScope<'_, '_>, node: v8::Local<'_, v8::Value>) -> Option<NodeId> {
    crate::node_handle::handle_of(scope, node)
        // SAFETY: the handle lives while the object, an argument, does.
        .and_then(|ptr| unsafe { ptr.as_ref() }.document(scope))
        .and_then(|d| crate::node_handle::nid_of(scope, d.into()))
}

impl RealmArena {
    // Whether a frame container's document is built as it connects — as its document parses, whatever origin either is
    // (HTML "process the iframe attributes" navigates it then; Chrome and Firefox fetch a cross-origin frame, and the
    // frames its document holds, with the page) — not left for its `contentWindow` to make: one a navigation carries a
    // response for, a `srcdoc` one, and one whose URL — the one its navigation started with, else its `src` — is not
    // about:blank's. An about: URL, an empty one and one that does not parse are an empty document, made as its window is
    // read — but for a frame with a document to leave, which makes it on the navigation's task: `contentDocument` is that
    // one's after it.
    fn builds_eagerly(&mut self, container: NodeId, doc: Option<NodeId>) -> bool {
        if !self.get(container).is_some_and(|n| n.is_html_named("iframe") || n.is_html_named("frame")) {
            return false;
        }
        let nav = self.frame_navigations.0.get(&container);
        if nav.is_some_and(|n| n.contents[CONTENT_NAV].is_some()) {
            return true;
        }
        let Some(node) = self.get(container) else { return false };
        if node.plain_attr("srcdoc").is_some() {
            return nav.is_none_or(|n| n.flags & SRC_REFUSED == 0);
        }
        let leaving = nav.is_some_and(|n| n.flags & COMMIT_PENDING != 0);
        let Some(src) = navigated_src(nav, node) else { return leaving };
        let s = src.trim_matches(|c: char| c.is_whitespace() || c == '\u{FEFF}');
        if s.is_empty() || s.get(..6).is_some_and(|p| p.eq_ignore_ascii_case("about:")) {
            return leaving;
        }
        // (…a node of the realm's own document keeps none of its own: that document is its tree's root, a frame built
        // only as it is connected)
        let root = self.root_of(container);
        let Some(doc) = doc.or_else(|| self.get(root).is_some_and(|n| n.kind == crate::dom::NodeKind::Document).then_some(root)) else { return false };
        self.parse_document_url(doc, s).is_some()
    }
}
