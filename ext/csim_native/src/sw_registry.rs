// Service workers' registrations (Service Workers §2.2), one registry for the process: each driver browsing session's
// its own partition, holding its registrations and the service workers they are made of.
//
// A registration is named by a number, and the registration MAP names it by its scope: from a Register job's first
// step until an unregister takes it out of the map — which leaves the registration itself in place, its versions
// running for the clients still using it, until it is cleared. Each holds its versions (the installing, waiting and
// active worker, each a worker's handle), whether a Register job made it (one only its updateViaCache mode was set on
// is the job's, not yet a registration a client sees), its updateViaCache mode and its navigation preload state
// ({enabled, header value}, which survives an update) — and, for the host, the worker it routes a navigation to
// (`serving`: its active worker once that is activated, until it dies) and the one it parks a fetch on while it
// activates (`activating`). A worker is its script's URL, its type, its state, the registration it is a version of —
// and, once a Register or Update job made it its registration's installing worker, where its lifecycle stands
// (`Lifecycle`): which step it takes next, and what of its own phases the worker has finished.
//
// The host reads it to route a navigation to its controller and to settle claims, every realm's registration and
// ServiceWorker objects read it — one registration seen alike wherever a client looks at it.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex, MutexGuard};

#[derive(Default)]
pub(crate) struct Registration {
    id: u32,
    scope: String,
    mapped: bool,
    registered: bool,
    installing: Option<u32>,
    waiting: Option<u32>,
    active: Option<u32>,
    activating: Option<u32>,
    serving: Option<u32>,
    update_via_cache: Option<String>,
    preload_enabled: Option<bool>,
    preload_header: Option<String>,
}

impl Registration {
    fn versions(&self) -> [Option<u32>; 3] {
        [self.installing, self.waiting, self.active]
    }
    // …its workers, each once, the installing one first.
    fn workers(&self) -> Vec<u32> {
        let mut handles = Vec::new();
        for h in self.versions().into_iter().flatten() {
            if !handles.contains(&h) {
                handles.push(h);
            }
        }
        handles
    }
    fn slot(&mut self, slot: &str) -> Option<&mut Option<u32>> {
        match slot {
            "installing" => Some(&mut self.installing),
            "waiting" => Some(&mut self.waiting),
            "active" => Some(&mut self.active),
            _ => None,
        }
    }
}

struct Worker {
    script_url: String,
    script_type: String,
    state: String,
    registration: u32,
    lifecycle: Lifecycle,
    // What its isolate made known as it ran, from its own thread: whether it has a `fetch` listener (none known until
    // its initial evaluation ran), whether it added Static Routing rules (which route a request with no fetch listener),
    // and whether its thread is gone — reaped, or ended on its own (a raise).
    fetch: Option<bool>,
    router: bool,
    dead: bool,
    // …and what holds it, set as it runs: `skipWaiting()` called, an extendable message event's `waitUntil` unsettled,
    // and the messages queued to it it has not finished dispatching.
    skip_waiting: bool,
    extended: bool,
    messages: u32,
    // …and, for the host, whether its next lifecycle step is queued as a task, what a step it took waits for ("install",
    // "activation", "try_activate"), and whether its activating step retired the worker it replaces already.
    step_queued: bool,
    waits: Option<&'static str>,
    retired_outgoing: bool,
}

impl Worker {
    // Whether a request is worth routing to it: one with a `fetch` listener, or not known to have none, or with rules.
    fn intercepts(&self) -> bool {
        self.fetch != Some(false) || self.router
    }
    // Whether it has events pending that extend its lifetime — a message it has not finished, an unsettled `waitUntil` of
    // one — none for one whose thread is gone.
    fn extended(&self) -> bool {
        !self.dead && (self.extended || self.messages > 0)
    }
    // …or a lifecycle event of its own: its install event's, from its job's end until the step its outcome makes is
    // taken, or its activate event's, from its activating step until its activated one — none for one waiting at Try
    // Activate.
    fn lifecycle_pending(&self) -> bool {
        !self.dead && matches!(self.lifecycle.step, Step::UpdateFound | Step::Installed | Step::Activated)
    }
}

// A version's way from installing to activated (Service Workers §8 Install, Try Activate, Activate), one step at a
// time — each a task of its own, so an observer sees every state between. The worker's isolate runs its install and
// activate events (run_worker): a step that waits on one waits for its marker — whether every install `waitUntil`
// fulfilled, and that activation completed.
#[derive(Default)]
struct Lifecycle {
    step: Step,
    installed: Option<bool>,
    activated: bool,
}

#[derive(Default, PartialEq)]
enum Step {
    // Not yet installing (a worker spawned, its job not finished), or done.
    #[default]
    Idle,
    UpdateFound,
    Installed,
    Activating,
    Activated,
}

// A Register, Update or Unregister job (Service Workers §8 "Create Job"), queued at its scope until the jobs before it
// there have finished: what it asks — the script, the updateViaCache mode (an Update job's: a re-register's changed one,
// or none) and the worker type; an Update job's registration — and, for the host running it, who asked (a client realm,
// or a service worker: the negative of its handle) and its origin key.
pub(crate) struct Job {
    id: u32,
    kind: String,
    scope: String,
    script_url: String,
    update_via_cache: Option<String>,
    script_type: String,
    registration: u32,
    realm: i64,
    creator_key: String,
}

// A service worker client (Service Workers §2.3): a window, frame or worker of the session — its id, URL, type
// ("window", "worker", "sharedworker"), frame type, origin (its document's, which an about:blank one inherits; none for
// one the host could not tell) and the worker controlling it.
pub(crate) struct Client {
    id: String,
    url: String,
    kind: String,
    frame_type: String,
    origin: Option<String>,
    controller: Option<u32>,
}

#[derive(Default)]
struct Partition {
    registrations: Vec<Registration>,
    workers: HashMap<u32, Worker>,
    jobs: Vec<Job>,
    // (…in the order they were made: Query Service Worker Client Objects lists them so)
    clients: Vec<Client>,
    // (…the ids of the clients that count as focused: the focused context and its ancestors)
    focused: Vec<String>,
}

impl Partition {
    // Update Worker State: the worker `handle` in `state` — whether that is a change, which every realm is to be told.
    fn set_state(&mut self, handle: u32, state: &str) -> bool {
        let Some(w) = self.workers.get_mut(&handle) else { return false };
        if state == "redundant" {
            w.waits = None;
        }
        let changed = w.state != state;
        state.clone_into(&mut w.state);
        changed
    }
    // The registration `id`, which a Register job made: one made earlier only to hold its job's updateViaCache mode takes
    // its place in the registration order now, as the registration it then becomes.
    fn register(&mut self, id: u32) -> &mut Registration {
        let list = &mut self.registrations;
        let mut i = list.iter().position(|r| r.id == id).expect("a registration of the partition");
        if !list[i].registered {
            let r = list.remove(i);
            list.push(r);
            i = list.len() - 1;
            list[i].registered = true;
        }
        &mut list[i]
    }
    // The registration the map holds at `scope`.
    fn mapped(&mut self, scope: &str) -> Option<&mut Registration> {
        self.registrations.iter_mut().find(|r| r.mapped && r.scope == scope)
    }
    fn by_id(&mut self, id: u32) -> Option<&mut Registration> {
        self.registrations.iter_mut().find(|r| r.id == id)
    }
}

#[derive(Default)]
struct Registry {
    partitions: HashMap<u64, Partition>,
    next_partition: u64,
    next_registration: u32,
    next_job: u32,
}

static REGISTRY: LazyLock<Mutex<Registry>> = LazyLock::new(|| Mutex::new(Registry::default()));

fn lock() -> MutexGuard<'static, Registry> {
    REGISTRY.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

impl Registry {
    fn partition(&mut self, partition: u64) -> &mut Partition {
        self.partitions.entry(partition).or_default()
    }
    // …one already made: none for a session gone (a reap or a read after it ended makes it no partition again).
    fn existing(&mut self, partition: u64) -> Option<&mut Partition> {
        self.partitions.get_mut(&partition)
    }
    // The registration the map holds at `scope`, made (and mapped) where it holds none.
    fn at(&mut self, partition: u64, scope: &str) -> &mut Registration {
        let id = match self.partition(partition).mapped(scope).map(|r| r.id) {
            Some(id) => id,
            None => {
                self.next_registration += 1;
                let id = self.next_registration;
                let registration = Registration { id, scope: scope.to_owned(), mapped: true, ..Registration::default() };
                self.partition(partition).registrations.push(registration);
                id
            }
        };
        self.partition(partition).by_id(id).expect("just found or made")
    }
    // …which a Register job made: one made earlier only to hold its job's updateViaCache mode takes its place in the
    // registration order now, as the registration it then becomes (the job of one that failed left it behind).
    fn registered(&mut self, partition: u64, scope: &str) -> &mut Registration {
        let id = self.at(partition, scope).id;
        self.partition(partition).register(id)
    }
}

// ── For the host ──
// A new browsing session's partition.
pub(crate) fn partition_new_for_ruby() -> u64 {
    let mut reg = lock();
    reg.next_partition += 1;
    reg.next_partition
}
// A session's registrations and workers gone (its storage cleared, or the session ended).
pub(crate) fn clear_for_ruby(partition: u64) {
    lock().partitions.remove(&partition);
}
// Every registration the map of `partition` holds, in the order made: `[scope, registered, activating, serving, id]`, a
// handle nil for none.
pub(crate) fn registrations_for_ruby(partition: u64) -> Vec<(String, bool, Option<u32>, Option<u32>, u32)> {
    let mut reg = lock();
    let Some(p) = reg.existing(partition) else { return Vec::new() };
    p.registrations.iter().filter(|r| r.mapped).map(|r| (r.scope.clone(), r.registered, r.activating, r.serving, r.id)).collect()
}
// A Register job made the registration at `scope`: its number.
pub(crate) fn note_registered_for_ruby(partition: u64, scope: String) -> u32 {
    lock().registered(partition, &scope).id
}
// The registration `id`'s versions, `[installing, waiting, active]` — none for a registration gone.
pub(crate) fn versions_for_ruby(partition: u64, id: u32) -> (Option<u32>, Option<u32>, Option<u32>) {
    let [installing, waiting, active] = lock().existing(partition).and_then(|p| p.by_id(id)).map_or([None; 3], |r| r.versions());
    (installing, waiting, active)
}
// A service worker of the session, spawned: its script's URL and type, 'parsed' until a registration holds it.
pub(crate) fn worker_new_for_ruby(partition: u64, handle: u32, script_url: String, script_type: String) {
    let worker = Worker {
        script_url,
        script_type,
        state: "parsed".to_owned(),
        registration: 0,
        lifecycle: Lifecycle::default(),
        fetch: None,
        router: false,
        dead: false,
        skip_waiting: false,
        extended: false,
        messages: 0,
        step_queued: false,
        waits: None,
        retired_outgoing: false,
    };
    lock().partition(partition).workers.insert(handle, worker);
}
// The worker `handle`: `[script URL, type, state, registration]` (0 for none yet), nil for none.
pub(crate) fn worker_for_ruby(partition: u64, handle: u32) -> Option<(String, String, String, u32)> {
    let mut reg = lock();
    let w = reg.existing(partition)?.workers.get(&handle)?;
    Some((w.script_url.clone(), w.script_type.clone(), w.state.clone(), w.registration))
}
// …what its isolate made known (`flag` "fetch": it has a `fetch` listener, `on` or not; "router": it added rules; "dead":
// its thread is gone), from whichever thread.
pub(crate) fn set_worker_flag_for_ruby(partition: u64, handle: u32, flag: String, on: bool) {
    let mut reg = lock();
    let Some(w) = reg.existing(partition).and_then(|p| p.workers.get_mut(&handle)) else { return };
    match flag.as_str() {
        "fetch" => w.fetch = Some(on),
        "router" => w.router = on,
        "dead" => w.dead = on,
        _ => {}
    }
}
// …whether its thread is there to answer: none reaped it, nor did it end on its own.
pub(crate) fn worker_live_for_ruby(partition: u64, handle: u32) -> bool {
    lock().existing(partition).and_then(|p| p.workers.get(&handle)).is_some_and(|w| !w.dead)
}
// …a hold of it set or let go, from whichever thread (`what` "skip_waiting": it called `skipWaiting()`; "extended": an
// extendable message event's `waitUntil` unsettled, `on`, or not; "message": a message queued to it, `on`, or one it
// finished dispatching): whether it has none of the last two left — a release that may let a successor activate.
pub(crate) fn hold_for_ruby(partition: u64, handle: u32, what: String, on: bool) -> bool {
    let mut reg = lock();
    let Some(w) = reg.existing(partition).and_then(|p| p.workers.get_mut(&handle)) else { return true };
    match what.as_str() {
        "skip_waiting" => w.skip_waiting = on,
        "extended" => w.extended = on,
        "message" if on => w.messages += 1,
        "message" => w.messages = w.messages.saturating_sub(1),
        _ => {}
    }
    !w.extended && w.messages == 0
}
// …whether its own activation finished (`note_phase` "activated").
pub(crate) fn worker_activated_for_ruby(partition: u64, handle: u32) -> bool {
    lock().existing(partition).and_then(|p| p.workers.get(&handle)).is_some_and(|w| w.lifecycle.activated)
}
// …its state moved to `state`: whether that is a change. A redundant one waits for no step any more.
pub(crate) fn set_worker_state_for_ruby(partition: u64, handle: u32, state: String) -> bool {
    lock().existing(partition).is_some_and(|p| p.set_state(handle, &state))
}
// ── The clients ──
// A client noted: its record, made — or, one with its id, refreshed in its place (a client keeps its creation order).
pub(crate) fn note_client_for_ruby(
    partition: u64,
    id: String,
    url: String,
    kind: String,
    frame_type: String,
    origin: Option<String>,
    controller: Option<u32>,
) {
    let mut reg = lock();
    let clients = &mut reg.partition(partition).clients;
    let client = Client { id, url, kind, frame_type, origin, controller };
    match clients.iter_mut().find(|c| c.id == client.id) {
        Some(c) => *c = client,
        None => clients.push(client),
    }
}
// …its controller set (a claim, a controller its worker adopted), where it is a client: whether it is.
pub(crate) fn set_client_controller_for_ruby(partition: u64, id: String, controller: Option<u32>) -> bool {
    let mut reg = lock();
    let Some(c) = reg.existing(partition).and_then(|p| p.clients.iter_mut().find(|c| c.id == id)) else { return false };
    c.controller = controller;
    true
}
// Every client gone (no worker left to see one: the realms report themselves again to the next) — the focus, the
// browser's, stays.
pub(crate) fn forget_clients_for_ruby(partition: u64) {
    if let Some(p) = lock().existing(partition) {
        p.clients.clear();
    }
}
// …and gone (its context discarded): whether it was a client.
pub(crate) fn forget_client_for_ruby(partition: u64, id: String) -> bool {
    let mut reg = lock();
    let Some(p) = reg.existing(partition) else { return false };
    let before = p.clients.len();
    p.clients.retain(|c| c.id != id);
    p.clients.len() != before
}
// The client `id`'s `[url, controller]`, nil for none.
pub(crate) fn client_entry_for_ruby(partition: u64, id: String) -> Option<(String, Option<u32>)> {
    let mut reg = lock();
    let c = reg.existing(partition)?.clients.iter().find(|c| c.id == id)?;
    Some((c.url.clone(), c.controller))
}
// Every client, `[id, url, controller]` each, in creation order — and the ids of those that count as focused, set.
pub(crate) fn clients_for_ruby(partition: u64) -> Vec<(String, String, Option<u32>)> {
    let mut reg = lock();
    let Some(p) = reg.existing(partition) else { return Vec::new() };
    p.clients.iter().map(|c| (c.id.clone(), c.url.clone(), c.controller)).collect()
}
pub(crate) fn set_focused_for_ruby(partition: u64, ids: Vec<String>) {
    lock().partition(partition).focused = ids;
}
// The client `id` as the service worker `handle` of `origin` sees it — `[id, url, type, frame type, controlled by it,
// focused]` — nil where it is none, or of another origin: Clients are origin-scoped (Query Service Worker Client
// Objects filters on the service worker's origin; one whose origin is unknown is none of its).
#[allow(clippy::type_complexity)]
pub(crate) fn client_for_ruby(partition: u64, handle: u32, origin: String, id: String) -> Option<(String, String, String, String, bool, bool)> {
    let mut reg = lock();
    let p = reg.existing(partition)?;
    let c = p.clients.iter().find(|c| c.id == id && c.origin.as_deref() == Some(origin.as_str()))?;
    Some(client_seen(p, c, handle))
}
// …and Clients.matchAll(): every such client of the worker's origin — of `kind` ("all" for every one), controlled by it
// unless `include_uncontrolled` — the focused ones first, then the rest, each in creation order.
#[allow(clippy::type_complexity)]
pub(crate) fn match_clients_for_ruby(
    partition: u64,
    handle: u32,
    origin: String,
    include_uncontrolled: bool,
    kind: String,
) -> Vec<(String, String, String, String, bool, bool)> {
    let mut reg = lock();
    let Some(p) = reg.existing(partition) else { return Vec::new() };
    let matched = p.clients.iter().filter(|c| {
        c.origin.as_deref() == Some(origin.as_str())
            && (include_uncontrolled || c.controller == Some(handle))
            && (kind == "all" || c.kind == kind)
    });
    let (focused, rest): (Vec<&Client>, Vec<&Client>) = matched.partition(|c| p.focused.contains(&c.id));
    focused.into_iter().chain(rest).map(|c| client_seen(p, c, handle)).collect()
}
fn client_seen(p: &Partition, c: &Client, handle: u32) -> (String, String, String, String, bool, bool) {
    (c.id.clone(), c.url.clone(), c.kind.clone(), c.frame_type.clone(), c.controller == Some(handle), p.focused.contains(&c.id))
}

// ── The job queues ──
// Schedule Job: a job of `kind` ("register", "update" — of the registration `registration` — or "unregister") at `scope`
// — its number, and whether it runs now (no job before it at the scope). A Register job equivalent to the last one queued
// there (the same script, mode and type) is that job: its number, not to run again.
#[allow(clippy::too_many_arguments)]
pub(crate) fn schedule_job_for_ruby(
    partition: u64,
    kind: String,
    scope: String,
    script_url: String,
    update_via_cache: Option<String>,
    script_type: String,
    registration: u32,
    realm: i64,
    creator_key: String,
) -> (u32, bool) {
    let mut reg = lock();
    let queued = reg.partition(partition).jobs.iter().rev().find(|j| j.scope == scope);
    if let Some(last) = queued.filter(|j| {
        kind == "register" && j.kind == "register" && j.script_url == script_url && j.update_via_cache == update_via_cache && j.script_type == script_type
    }) {
        return (last.id, false);
    }
    let runs = queued.is_none();
    reg.next_job += 1;
    let id = reg.next_job;
    let job = Job { id, kind, scope, script_url, update_via_cache, script_type, registration, realm, creator_key };
    reg.partition(partition).jobs.push(job);
    (id, runs)
}
// The job `id`: `[kind, scope, script URL, mode, type, registration, who asked, creator key]`, nil for one finished.
#[allow(clippy::type_complexity)]
pub(crate) fn job_for_ruby(partition: u64, id: u32) -> Option<(String, String, String, Option<String>, String, u32, i64, String)> {
    let mut reg = lock();
    let j = reg.existing(partition)?.jobs.iter().find(|j| j.id == id)?;
    Some((j.kind.clone(), j.scope.clone(), j.script_url.clone(), j.update_via_cache.clone(), j.script_type.clone(), j.registration, j.realm, j.creator_key.clone()))
}
// Finish Job: the job `id` out of its queue — the next one there, to run now.
pub(crate) fn finish_job_for_ruby(partition: u64, id: u32) -> Option<u32> {
    let mut reg = lock();
    let jobs = &mut reg.existing(partition)?.jobs;
    let i = jobs.iter().position(|j| j.id == id)?;
    let scope = jobs.remove(i).scope;
    jobs.iter().find(|j| j.scope == scope).map(|j| j.id)
}
// The registrations a Register job made that the map holds for a client of `origin` (its storage key: an opaque one has
// none) — `[id, scope]` each, in the order made — and Match Service Worker Registration: of those, the one whose scope is
// the longest prefix of `url` (plain string starts-with on the serialized scope), nil for none.
pub(crate) fn registrations_of_origin_for_ruby(partition: u64, origin: String) -> Vec<(u32, String)> {
    let mut reg = lock();
    let Some(p) = reg.existing(partition) else { return Vec::new() };
    of_origin(p, &origin).map(|r| (r.id, r.scope.clone())).collect()
}
pub(crate) fn match_registration_for_ruby(partition: u64, origin: String, url: String) -> Option<(u32, String)> {
    let mut reg = lock();
    let p = reg.existing(partition)?;
    let matched = of_origin(p, &origin).filter(|r| url.starts_with(&r.scope));
    matched.max_by_key(|r| r.scope.len()).map(|r| (r.id, r.scope.clone()))
}
fn of_origin<'a>(p: &'a Partition, origin: &'a str) -> impl Iterator<Item = &'a Registration> {
    let same = move |scope: &str| origin != "null" && ada_url::Url::parse(scope, None).is_ok_and(|u| u.origin() == origin);
    p.registrations.iter().filter(move |r| r.mapped && r.registered && same(&r.scope))
}
// The registration a Register job made at `scope` that the map holds: its number, 0 for none.
pub(crate) fn registered_at_for_ruby(partition: u64, scope: String) -> u32 {
    lock().existing(partition).and_then(|p| p.mapped(&scope)).filter(|r| r.registered).map_or(0, |r| r.id)
}

// The worker `handle` finished a phase of its own: its install ('install', `ok` whether every `waitUntil` fulfilled) or
// its activation ('activated').
pub(crate) fn note_phase_for_ruby(partition: u64, handle: u32, phase: String, ok: bool) {
    if let Some(w) = lock().existing(partition).and_then(|p| p.workers.get_mut(&handle)) {
        match phase.as_str() {
            "install" => w.lifecycle.installed = Some(ok),
            "activated" => w.lifecycle.activated = true,
            _ => {}
        }
    }
}
impl Partition {
    // The worker `handle`'s next lifecycle step, taken: "updatefound", "installed", "install_failed", "activating" —
    // where Try Activate lets it (`may_activate`) — or "activated"; else what it waits for: "install" or "activation"
    // (its own phase), "try_activate" (the verdict), or "done" (no step left — finished, failed, redundant, or none).
    fn advance(&mut self, handle: u32) -> &'static str {
        let may_activate = may_activate(self, handle);
        let Some(w) = self.workers.get_mut(&handle) else { return "done" };
        if w.state == "redundant" {
            w.lifecycle.step = Step::Idle;
            return "done";
        }
        let lc = &mut w.lifecycle;
        let (next, taken) = match lc.step {
            Step::Idle => return "done",
            Step::UpdateFound => (Step::Installed, "updatefound"),
            Step::Installed => match lc.installed {
                None => return "install",
                Some(true) => (Step::Activating, "installed"),
                Some(false) => (Step::Idle, "install_failed"),
            },
            Step::Activating if !may_activate => return "try_activate",
            Step::Activating => (Step::Activated, "activating"),
            Step::Activated if !lc.activated => return "activation",
            Step::Activated => (Step::Idle, "activated"),
        };
        lc.step = next;
        taken
    }
}
// ── Try Activate and Try Clear Registration ──
// Whether the worker `handle` (the registration's outgoing active one) is used by a client: Try Activate's "no service
// worker client is using the registration" — one controlled by it, or one whose MATCHED registration is the one it
// serves, controlled or not: an unclaimed in-scope document holds the handover too. Matching by URL keeps the verdict
// deterministic — a client's controller is re-reported by realms and can read stale for a moment (the activation.https
// flake), its URL and the scope do not. (Try Clear's "using" is the controller alone: `clearable`.)
fn controls_clients(p: &Partition, handle: u32) -> bool {
    let scope = p.registrations.iter().find(|r| r.mapped && r.serving == Some(handle)).map(|r| r.scope.as_str());
    p.clients.iter().any(|c| c.controller == Some(handle) || scope.is_some_and(|s| scope_match(p, &c.url, false).is_some_and(|(_, m)| m == s)))
}
// Try Activate's verdict for the worker `candidate` of its registration: no outgoing active worker to displace, or one
// with no events pending — which holds an installed successor even past skipWaiting (activation.https "skipWaiting
// bypasses no controllee requirement": it bypasses only the controllee half) — and either no client using the
// registration or the candidate having skipped waiting.
fn may_activate(p: &Partition, candidate: u32) -> bool {
    let Some(w) = p.workers.get(&candidate) else { return false };
    let Some(outgoing) = p.registrations.iter().find(|r| r.id == w.registration).and_then(|r| r.active) else { return true };
    if outgoing == candidate {
        return true;
    }
    !p.workers.get(&outgoing).is_some_and(Worker::extended) && (w.skip_waiting || !controls_clients(p, outgoing))
}
// Try Clear Registration's verdict for the registration `id`: no client controlled by its active worker, and no version
// with an event pending ("Service Worker Has No Pending Events") — a message's, an extendable message event's, its
// install or activate event's.
pub(crate) fn registration_clearable_for_ruby(partition: u64, id: u32) -> bool {
    let mut reg = lock();
    let Some(p) = reg.existing(partition) else { return true };
    let Some(r) = p.registrations.iter().find(|r| r.id == id) else { return true };
    if r.active.is_some_and(|a| p.clients.iter().any(|c| c.controller == Some(a))) {
        return false;
    }
    r.workers().iter().filter_map(|h| p.workers.get(h)).all(|w| !w.extended() && !w.lifecycle_pending())
}
// The registration at `scope` unregistered — out of the map, its mode and navigation preload with it: its number, nil
// where the map held none. One with no version left is gone at once; another stays until it is cleared.
pub(crate) fn unregister_for_ruby(partition: u64, scope: String) -> Option<u32> {
    let mut reg = lock();
    let p = reg.existing(partition)?;
    let r = p.mapped(&scope)?;
    r.mapped = false;
    let id = r.id;
    if r.workers().is_empty() {
        p.registrations.retain(|r| r.id != id);
    }
    Some(id)
}
// Clear Registration: the registration `id`'s versions emptied — and it gone, where the map no longer holds it.
pub(crate) fn clear_registration_for_ruby(partition: u64, id: u32) {
    let mut reg = lock();
    let Some(p) = reg.existing(partition) else { return };
    let Some(r) = p.by_id(id) else { return };
    r.installing = None;
    r.waiting = None;
    r.active = None;
    if !r.mapped {
        p.registrations.retain(|r| r.id != id);
    }
}
// ── Matching (Service Workers "Match Service Worker Registration") ──
// The worker a request of `url` goes to and its registration's scope: of the registrations the map holds, the one whose
// scope is the longest to cover it — its worker serving it (its active one, activated), or one activating at a scope
// as long (Activate has made it the registration's active worker: an update wins the tie over the outgoing one) whose
// thread is alive and, unless `activating`, whose activation finished.
fn scope_match<'p>(p: &'p Partition, url: &str, activating: bool) -> Option<(u32, &'p str)> {
    let mut best: Option<(u32, &str)> = None;
    let longer = |best: &Option<(u32, &str)>, scope: &str, tie: bool| best.is_none_or(|(_, b)| scope.len() > b.len() || (tie && scope.len() == b.len()));
    for r in p.registrations.iter().filter(|r| r.mapped) {
        if let Some(h) = r.serving.filter(|_| url.starts_with(&r.scope) && longer(&best, &r.scope, false)) {
            best = Some((h, &r.scope));
        }
    }
    for r in p.registrations.iter().filter(|r| r.mapped) {
        let Some(h) = r.activating.filter(|_| url.starts_with(&r.scope) && longer(&best, &r.scope, true)) else { continue };
        if p.workers.get(&h).is_some_and(|w| !w.dead && (activating || w.lifecycle.activated)) {
            best = Some((h, &r.scope));
        }
    }
    best
}
// The worker that controls what `url` names, for the host: `mode` "served" — the registration matched, its worker as it
// stands; "navigation" — the worker a navigation to it goes to
// through its fetch event, one that intercepts and is alive; "client" — the controller of a client made at it, an
// activating worker's too (Handle Fetch sets a reserved client's active service worker before it asks whether that
// handles fetches at all, let alone waits for it); "activating" — the still-activating worker a request to it is to
// wait for, where its registration is the one matched, it intercepts and is alive. `[handle, intercepts, script URL,
// scope]`, nil for none.
pub(crate) fn match_worker_for_ruby(partition: u64, url: String, mode: String) -> Option<(u32, bool, String, String)> {
    let mut reg = lock();
    let p = reg.existing(partition)?;
    let (handle, scope) = match mode.as_str() {
        "served" => scope_match(p, &url, false)?,
        "navigation" => scope_match(p, &url, false).filter(|(h, _)| p.workers.get(h).is_some_and(|w| !w.dead && w.intercepts()))?,
        "client" => scope_match(p, &url, true).filter(|(h, _)| p.workers.get(h).is_some_and(|w| !w.dead))?,
        "activating" => {
            let r = p.registrations.iter().filter(|r| r.mapped && r.activating.is_some() && url.starts_with(&r.scope)).max_by_key(|r| r.scope.len())?;
            if scope_match(p, &url, false).is_some_and(|(_, s)| s.len() > r.scope.len()) {
                return None;
            }
            let h = r.activating?;
            p.workers.get(&h).filter(|w| !w.dead && !w.lifecycle.activated && w.intercepts())?;
            (h, r.scope.as_str())
        }
        _ => return None,
    };
    let (intercepts, script_url) = p.workers.get(&handle).map_or((true, String::new()), |w| (w.intercepts(), w.script_url.clone()));
    Some((handle, intercepts, script_url, scope.to_owned()))
}
// …and worker `handle` as a controller a client takes: `[handle, intercepts, script URL, the scope it serves ('' for
// none)]`, nil for none — and, `live`, for one whose thread is gone.
pub(crate) fn controller_for_ruby(partition: u64, handle: u32, live: bool) -> Option<(u32, bool, String, String)> {
    let mut reg = lock();
    let p = reg.existing(partition)?;
    let w = p.workers.get(&handle).filter(|w| !(live && w.dead))?;
    let scope = p.registrations.iter().find(|r| r.mapped && r.serving == Some(handle)).map_or_else(String::new, |r| r.scope.clone());
    Some((handle, w.intercepts(), w.script_url.clone(), scope))
}
// ── The lifecycle, as the host takes its steps (Service Workers §8 Install, Try Activate, Activate) ──
// What a step makes the host do, in order — the registry's versions committed first: move a worker to a state, telling
// every realm where that is a change ("state", handle, state — Update Worker State, at its turn: a realm that makes its
// ServiceWorker of the worker in a listener of an earlier one makes it in the state before, and sees its `statechange`),
// end a worker's isolate ("terminate"), fire a registration's `updatefound` ("update_found",
// registration), have a worker fire its activate event ("activate"), tell every realm a worker is its registration's
// active one ("activated", handle, script URL, whether it intercepts), queue a worker's next step as a task of the
// window's ("queue_step"), take the rest of a step once what came before it was done ("continue"), unregister the
// registration at a scope ("unregister", 0, scope), and try to clear the registrations unregistered ("try_clear").
pub(crate) type Cmd = (&'static str, u32, String, bool);
fn cmd(kind: &'static str, n: u32) -> Cmd {
    (kind, n, String::new(), false)
}

impl Partition {
    fn set_version(&mut self, id: u32, slot: &str, handle: Option<u32>) {
        if let Some(s) = self.by_id(id).and_then(|r| r.slot(slot)) {
            *s = handle;
        }
        if let Some(w) = handle.and_then(|h| self.workers.get_mut(&h)) {
            w.registration = id;
        }
    }
    fn mapped_scope(&self, id: u32) -> Option<String> {
        self.registrations.iter().find(|r| r.id == id && r.mapped).map(|r| r.scope.clone())
    }
    // A version retired: redundant, and its isolate ended.
    fn retire(handle: u32, out: &mut Vec<Cmd>) {
        Self::tell_state(handle, "redundant", out);
        out.push(cmd("terminate", handle));
    }
    fn tell_state(handle: u32, state: &str, out: &mut Vec<Cmd>) {
        out.push(("state", handle, state.to_owned(), false));
    }
    // The worker's next step queued, where it is not already.
    fn queue_step(&mut self, handle: u32, out: &mut Vec<Cmd>) {
        if let Some(w) = self.workers.get_mut(&handle).filter(|w| !w.step_queued) {
            w.step_queued = true;
            out.push(cmd("queue_step", handle));
        }
    }
    // Install: the job's worker `handle` evaluated, the registration `id`'s installing worker now — superseding one
    // still installing there (an update supersedes a pending worker, NOT the active one, and a WAITING worker keeps
    // waiting until the newer one is installed: skip-waiting.https) — its lifecycle begun.
    fn install(&mut self, id: u32, handle: u32, out: &mut Vec<Cmd>) {
        let (pending, active) = self.by_id(id).map_or((None, None), |r| (r.installing, r.active));
        self.set_version(id, "installing", Some(handle));
        if let Some(p) = pending.filter(|&p| Some(p) != active && p != handle) {
            Self::retire(p, out);
        }
        if let Some(w) = self.workers.get_mut(&handle) {
            w.lifecycle.step = Step::UpdateFound;
        }
        Self::tell_state(handle, "installing", out);
        self.queue_step(handle, out);
    }
    // The worker `handle`'s next step taken — the task queued for it, or a wait resumed — or, where it waits, what for.
    fn step(&mut self, handle: u32, out: &mut Vec<Cmd>) {
        let Some(w) = self.workers.get_mut(&handle) else { return };
        w.step_queued = false;
        let id = w.registration;
        let taken = self.advance(handle);
        if let Some(w) = self.workers.get_mut(&handle) {
            w.waits = matches!(taken, "install" | "activation" | "try_activate").then_some(taken);
        }
        match taken {
            "updatefound" => {
                out.push(cmd("update_found", id));
                self.queue_step(handle, out);
            }
            "installed" => self.installed(id, handle, out),
            "install_failed" => self.install_failed(id, handle, out),
            "activating" => self.activating(id, handle, out),
            "activated" => self.activated(id, handle, out),
            _ => {}
        }
    }
    // installing → installed: the waiting worker. A version already SITTING there is retired now — per Update State
    // "installed", the previous waiting worker goes redundant the moment a newer one reaches installed (skip-waiting.https:
    // url2 redundant once url3 installs) — and, its install event no longer pending, a registration unregistered
    // meanwhile cleared, where nothing else holds it (`waitUntil`'s steps).
    fn installed(&mut self, id: u32, handle: u32, out: &mut Vec<Cmd>) {
        let (installing, waiting) = self.by_id(id).map_or((None, None), |r| (r.installing, r.waiting));
        self.set_version(id, "waiting", Some(handle));
        if installing == Some(handle) {
            self.set_version(id, "installing", None);
        }
        if let Some(old) = waiting.filter(|&w| w != handle) {
            Self::retire(old, out);
        }
        Self::tell_state(handle, "installed", out);
        out.push(cmd("try_clear", 0));
        self.queue_step(handle, out);
    }
    // …or its install failed (a rejected install `waitUntil` — Install "installFailed"): redundant without ever occupying
    // the waiting or active slot, and a registration left with no version at all leaves the map (a failed install must not
    // resurrect an unregistered scope — unregister-then-register-new-script — nor leave a phantom registration a later
    // getRegistration() would find).
    fn install_failed(&mut self, id: u32, handle: u32, out: &mut Vec<Cmd>) {
        if self.by_id(id).is_some_and(|r| r.installing == Some(handle)) {
            self.set_version(id, "installing", None);
        }
        Self::retire(handle, out);
        if let Some(scope) = self.mapped_scope(id).filter(|_| self.by_id(id).is_some_and(|r| r.workers().is_empty())) {
            out.push(("unregister", 0, scope, false));
        }
        out.push(cmd("try_clear", 0));
    }
    // installed → activating, once Try Activate allows it: the one it replaces retired first (Activate's order — its
    // `statechange` seeing the registration as it was), then the rest (`continue_activating`).
    fn activating(&mut self, id: u32, handle: u32, out: &mut Vec<Cmd>) {
        let outgoing = self.by_id(id).and_then(|r| r.active).filter(|&o| o != handle);
        match outgoing {
            Some(o) => {
                if let Some(w) = self.workers.get_mut(&handle) {
                    w.retired_outgoing = true;
                }
                Self::retire(o, out);
                out.push(cmd("continue", handle));
            }
            None => self.continue_activating(id, handle, out),
        }
    }
    // …the active worker now — its activate event dispatched, on its own thread, ahead of anything a client sends it once
    // told it is activating (a `clients.claim()` asked then is an active worker's) — and the host told it EXISTS but is
    // still activating (Handle Fetch parks functional events against the scope until it is activated:
    // fetch-waits-for-activate), where the map still holds it. Every client using the registration takes it as its
    // controller now (Activate: Notify Controller Change) — a worker whose thread ended its active worker all the same.
    fn continue_activating(&mut self, id: u32, handle: u32, out: &mut Vec<Cmd>) {
        // (…none for one made redundant meanwhile, which no step revives)
        if self.workers.get(&handle).is_none_or(|w| w.state == "redundant") {
            return;
        }
        let waiting = self.by_id(id).and_then(|r| r.waiting);
        self.set_version(id, "active", Some(handle));
        if waiting == Some(handle) {
            self.set_version(id, "waiting", None);
        }
        out.push(cmd("activate", handle));
        Self::tell_state(handle, "activating", out);
        if let Some(r) = self.registrations.iter_mut().find(|r| r.id == id && r.mapped) {
            r.activating = Some(handle);
        }
        if let Some(w) = self.workers.get(&handle) {
            out.push(("activated", handle, w.script_url.clone(), w.intercepts()));
        }
        self.queue_step(handle, out);
    }
    // …→ activated, once its activation completed: the worker serving its scope — before the state flips, a synchronous
    // `statechange` listener reading `navigator.serviceWorker.controller` already seeing the claim its activate handler
    // made — while it is still its registration's active worker and the map still holds that; and a registration
    // unregistered meanwhile cleared, where nothing else holds it.
    fn activated(&mut self, id: u32, handle: u32, out: &mut Vec<Cmd>) {
        if self.registrations.iter().any(|r| r.id == id && r.mapped && r.active == Some(handle)) {
            let r = self.register(id);
            r.serving = Some(handle);
            r.activating = None;
        }
        Self::tell_state(handle, "activated", out);
        out.push(cmd("try_clear", 0));
    }
}

// The job's worker `handle` evaluated, the registration `id`'s installing worker (Install): what the host does.
pub(crate) fn install_for_ruby(partition: u64, id: u32, handle: u32) -> Vec<Cmd> {
    let mut out = Vec::new();
    if let Some(p) = lock().existing(partition) {
        p.install(id, handle, &mut out);
    }
    out
}
// The worker `handle`'s queued step taken (`__csim_swStep`): what the host does.
pub(crate) fn step_for_ruby(partition: u64, handle: u32) -> Vec<Cmd> {
    let mut out = Vec::new();
    if let Some(p) = lock().existing(partition) {
        p.step(handle, &mut out);
    }
    out
}
// …the rest of its activating step, once the worker it replaces was retired.
pub(crate) fn continue_for_ruby(partition: u64, handle: u32) -> Vec<Cmd> {
    let mut out = Vec::new();
    if let Some(p) = lock().existing(partition) {
        let id = p.workers.get_mut(&handle).and_then(|w| std::mem::take(&mut w.retired_outgoing).then_some(w.registration));
        if let Some(id) = id {
            p.continue_activating(id, handle, &mut out);
        }
    }
    out
}
// …a step that waits for `what` resumed, where the worker waits for it — its install or activation phase arrived
// ("install", "activation"), or Try Activate's holds let go ("try_activate").
pub(crate) fn resume_for_ruby(partition: u64, handle: u32, what: String) -> Vec<Cmd> {
    let mut out = Vec::new();
    if let Some(p) = lock().existing(partition).filter(|p| p.workers.get(&handle).is_some_and(|w| w.waits == Some(what.as_str()))) {
        p.step(handle, &mut out);
    }
    out
}
// The workers waiting for `what` — each resumed in turn by the host, its effects carried out before the next is asked.
pub(crate) fn waiting_for_ruby(partition: u64, what: String) -> Vec<u32> {
    let mut reg = lock();
    let Some(p) = reg.existing(partition) else { return Vec::new() };
    let mut waiting: Vec<u32> = p.workers.iter().filter(|(_, w)| w.waits == Some(what.as_str())).map(|(&h, _)| h).collect();
    waiting.sort_unstable();
    waiting
}
// The workers whose next step is queued — the outgoing page's tasks, the new page's to run.
pub(crate) fn queued_steps_for_ruby(partition: u64) -> Vec<u32> {
    let mut reg = lock();
    let Some(p) = reg.existing(partition) else { return Vec::new() };
    let mut queued: Vec<u32> = p.workers.iter().filter(|(_, w)| w.step_queued).map(|(&h, _)| h).collect();
    queued.sort_unstable();
    queued
}

// The registrations of a session made already (none for one gone).
fn registrations_mut(reg: &mut Registry, partition: u64) -> &mut [Registration] {
    reg.existing(partition).map_or(&mut [], |p| p.registrations.as_mut_slice())
}
// A worker gone: no registration routes a navigation to it any more — at once, from whichever thread reaped it. (Its
// record stays, for the session: a client it controlled is still matched to its registration by it, as Activate moves
// the client on.)
pub(crate) fn forget_worker_for_ruby(partition: u64, handle: u32) {
    for r in registrations_mut(&mut lock(), partition).iter_mut().filter(|r| r.serving == Some(handle)) {
        r.serving = None;
    }
}
// …and one that never reached activated activates no registration any more — forgotten on the main thread, after the
// reap (a claim it made in between still finds its scope).
pub(crate) fn forget_activating_for_ruby(partition: u64, handle: u32) {
    for r in registrations_mut(&mut lock(), partition).iter_mut().filter(|r| r.activating == Some(handle)) {
        r.activating = None;
    }
}
// The mapped registration's updateViaCache mode — nil where none was set — and setting it.
pub(crate) fn update_via_cache_for_ruby(partition: u64, scope: String) -> Option<String> {
    lock().existing(partition).and_then(|p| p.mapped(&scope)).and_then(|r| r.update_via_cache.clone())
}
pub(crate) fn set_update_via_cache_for_ruby(partition: u64, scope: String, mode: String) {
    lock().at(partition, &scope).update_via_cache = Some(mode);
}
// Its navigation preload state: `[enabled, header value]`, the spec's default (false, "true") where none was set — and
// setting either (a nil one left as it is).
pub(crate) fn navigation_preload_for_ruby(partition: u64, scope: String) -> (bool, String) {
    let mut reg = lock();
    let r = reg.existing(partition).and_then(|p| p.mapped(&scope));
    let r = r.as_deref();
    (r.and_then(|r| r.preload_enabled).unwrap_or(false), r.and_then(|r| r.preload_header.clone()).unwrap_or_else(|| "true".to_owned()))
}
pub(crate) fn set_navigation_preload_for_ruby(partition: u64, scope: String, enabled: Option<bool>, header: Option<String>) {
    let mut reg = lock();
    let r = reg.at(partition, &scope);
    if enabled.is_some() {
        r.preload_enabled = enabled;
    }
    if header.is_some() {
        r.preload_header = header;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // What the host's steps do to the registry, made directly.
    fn part<R>(p: u64, f: impl FnOnce(&mut Partition) -> R) -> R {
        f(lock().existing(p).expect("a partition made"))
    }
    fn set_version(p: u64, id: u32, slot: String, handle: Option<u32>) {
        part(p, |q| q.set_version(id, &slot, handle));
    }
    fn begin_lifecycle(p: u64, handle: u32) {
        part(p, |q| q.workers.get_mut(&handle).expect("a worker made").lifecycle.step = Step::UpdateFound);
    }
    fn advance(p: u64, handle: u32) -> &'static str {
        part(p, |q| q.advance(handle))
    }
    fn awaits_activation(p: u64, handle: u32) -> bool {
        part(p, |q| q.workers.get(&handle).is_some_and(|w| w.lifecycle.step == Step::Activating))
    }
    fn note_activating(p: u64, scope: String, handle: u32) {
        lock().at(p, &scope).activating = Some(handle);
    }
    fn activated(p: u64, scope: String, handle: u32) {
        let mut reg = lock();
        let r = reg.registered(p, &scope);
        r.serving = Some(handle);
        r.activating = None;
    }

    #[test]
    fn has_the_host_take_each_lifecycle_step_in_order() {
        let p = partition_new_for_ruby();
        let id = note_registered_for_ruby(p, "https://a.test/".into());
        let kinds = |cmds: Vec<Cmd>| cmds.into_iter().map(|(k, n, t, _)| format!("{k} {n} {t}").trim_end().to_owned()).collect::<Vec<_>>();
        worker_new_for_ruby(p, 1, "https://a.test/sw.js".into(), "classic".into());
        assert_eq!(kinds(install_for_ruby(p, id, 1)), ["state 1 installing", "queue_step 1"]);
        // (…one step a task: updatefound, then the install phase waited for, then installed and Try Activate)
        assert_eq!(kinds(step_for_ruby(p, 1)), [format!("update_found {id}"), "queue_step 1".into()]);
        assert!(kinds(step_for_ruby(p, 1)).is_empty());
        assert!(kinds(resume_for_ruby(p, 1, "activation".into())).is_empty());
        note_phase_for_ruby(p, 1, "install".into(), true);
        assert_eq!(kinds(resume_for_ruby(p, 1, "install".into())), ["state 1 installed", "try_clear 0", "queue_step 1"]);
        assert_eq!(kinds(step_for_ruby(p, 1)), ["activate 1", "state 1 activating", "activated 1 https://a.test/sw.js", "queue_step 1"]);
        assert!(kinds(step_for_ruby(p, 1)).is_empty());
        note_phase_for_ruby(p, 1, "activated".into(), true);
        assert_eq!(kinds(resume_for_ruby(p, 1, "activation".into())), ["state 1 activated", "try_clear 0"]);
        assert_eq!(match_worker_for_ruby(p, "https://a.test/x".into(), "navigation".into()).map(|m| m.0), Some(1));
        // (…an update replacing it: the outgoing worker retired before the versions move, the rest continued after)
        worker_new_for_ruby(p, 2, "https://a.test/sw.js".into(), "classic".into());
        install_for_ruby(p, id, 2);
        step_for_ruby(p, 2);
        note_phase_for_ruby(p, 2, "install".into(), true);
        step_for_ruby(p, 2);
        assert_eq!(kinds(step_for_ruby(p, 2)), ["state 1 redundant", "terminate 1", "continue 2"]);
        assert_eq!(versions_for_ruby(p, id), (None, Some(2), Some(1)));
        assert_eq!(kinds(continue_for_ruby(p, 2)), ["activate 2", "state 2 activating", "activated 2 https://a.test/sw.js", "queue_step 2"]);
        assert_eq!(versions_for_ruby(p, id), (None, None, Some(2)));
        assert_eq!(queued_steps_for_ruby(p), [2]);
        clear_for_ruby(p);
    }

    #[test]
    fn lets_a_worker_activate_as_try_activate_has_it() {
        let p = partition_new_for_ruby();
        let scope = || "https://a.test/".to_owned();
        let id = note_registered_for_ruby(p, scope());
        worker_new_for_ruby(p, 1, "https://a.test/sw.js".into(), "classic".into());
        worker_new_for_ruby(p, 2, "https://a.test/sw.js".into(), "classic".into());
        set_version(p, id, "active".into(), Some(1));
        activated(p, scope(), 1);
        set_version(p, id, "waiting".into(), Some(2));
        let verdict = || may_activate(lock().existing(p).expect("made"), 2);
        // (…no client using the registration: it may)
        assert!(verdict());
        // (…an in-scope client holds it, controlled or not — unless the candidate skipped waiting)
        note_client_for_ruby(p, "c".into(), "https://a.test/page".into(), "window".into(), "top-level".into(), None, None);
        assert!(!verdict());
        hold_for_ruby(p, 2, "skip_waiting".into(), true);
        assert!(verdict());
        // (…but the outgoing worker's pending events hold it even past skipWaiting, until the last is let go)
        hold_for_ruby(p, 1, "message".into(), true);
        assert!(!hold_for_ruby(p, 1, "extended".into(), true));
        assert!(!verdict());
        assert!(!hold_for_ruby(p, 1, "message".into(), false));
        assert!(hold_for_ruby(p, 1, "extended".into(), false));
        assert!(verdict());
        // (…one whose thread is gone holds nothing)
        hold_for_ruby(p, 1, "extended".into(), true);
        set_worker_flag_for_ruby(p, 1, "dead".into(), true);
        assert!(verdict());
        clear_for_ruby(p);
    }

    #[test]
    fn matches_a_request_to_the_worker_its_longest_scope_routes_to() {
        let p = partition_new_for_ruby();
        let m = |url: &str, mode: &str| match_worker_for_ruby(p, url.into(), mode.into()).map(|r| (r.0, r.3));
        worker_new_for_ruby(p, 1, "https://a.test/sw.js".into(), "classic".into());
        worker_new_for_ruby(p, 2, "https://a.test/app/sw.js".into(), "classic".into());
        activated(p, "https://a.test/".into(), 1);
        note_activating(p, "https://a.test/app/".into(), 2);
        // (…the longer scope's worker still activating: a client takes it, a navigation waits for it)
        assert_eq!(m("https://a.test/app/x", "client"), Some((2, "https://a.test/app/".into())));
        assert_eq!(m("https://a.test/app/x", "navigation"), Some((1, "https://a.test/".into())));
        assert_eq!(m("https://a.test/app/x", "activating"), Some((2, "https://a.test/app/".into())));
        // (…its activation finished: it serves, and none is waited for)
        note_phase_for_ruby(p, 2, "activated".into(), true);
        assert_eq!(m("https://a.test/app/x", "navigation"), Some((2, "https://a.test/app/".into())));
        assert_eq!(m("https://a.test/app/x", "activating"), None);
        // (…an update activating at the same scope wins the tie over the outgoing one; a dead one routes nothing)
        worker_new_for_ruby(p, 3, "https://a.test/sw.js".into(), "classic".into());
        note_activating(p, "https://a.test/".into(), 3);
        assert_eq!(m("https://a.test/y", "client"), Some((3, "https://a.test/".into())));
        set_worker_flag_for_ruby(p, 3, "dead".into(), true);
        assert_eq!(m("https://a.test/y", "client"), Some((1, "https://a.test/".into())));
        // (…one known to have no fetch listener and no rules takes no navigation; rules make it one that does)
        set_worker_flag_for_ruby(p, 1, "fetch".into(), false);
        assert_eq!(m("https://a.test/y", "navigation"), None);
        set_worker_flag_for_ruby(p, 1, "router".into(), true);
        assert_eq!(m("https://a.test/y", "navigation"), Some((1, "https://a.test/".into())));
        assert_eq!(m("https://b.test/", "client"), None);
        clear_for_ruby(p);
    }

    #[test]
    fn keeps_the_clients_a_service_worker_sees() {
        let p = partition_new_for_ruby();
        let a = || Some("https://a.test".to_owned());
        note_client_for_ruby(p, "w".into(), "https://a.test/".into(), "window".into(), "top-level".into(), a(), Some(5));
        note_client_for_ruby(p, "f".into(), "https://a.test/f".into(), "window".into(), "nested".into(), a(), None);
        note_client_for_ruby(p, "x".into(), "https://b.test/".into(), "window".into(), "nested".into(), Some("https://b.test".into()), None);
        note_client_for_ruby(p, "k".into(), "https://a.test/k.js".into(), "worker".into(), "none".into(), a(), Some(5));
        let ids = |v: Vec<(String, String, String, String, bool, bool)>| v.into_iter().map(|c| c.0).collect::<Vec<_>>();
        assert_eq!(ids(match_clients_for_ruby(p, 5, "https://a.test".into(), false, "window".into())), ["w"]);
        assert_eq!(ids(match_clients_for_ruby(p, 5, "https://a.test".into(), true, "all".into())), ["w", "f", "k"]);
        set_focused_for_ruby(p, vec!["f".into()]);
        assert_eq!(ids(match_clients_for_ruby(p, 5, "https://a.test".into(), true, "window".into())), ["f", "w"]);
        assert!(client_for_ruby(p, 5, "https://a.test".into(), "x".into()).is_none());
        assert!(set_client_controller_for_ruby(p, "f".into(), Some(5)));
        assert_eq!(client_for_ruby(p, 5, "https://a.test".into(), "f".into()).map(|c| (c.4, c.5)), Some((true, true)));
        // Refreshed in place, gone when forgotten.
        note_client_for_ruby(p, "w".into(), "https://a.test/2".into(), "window".into(), "top-level".into(), a(), Some(5));
        assert_eq!(clients_for_ruby(p)[0], ("w".into(), "https://a.test/2".into(), Some(5)));
        assert!(forget_client_for_ruby(p, "w".into()));
        assert!(!forget_client_for_ruby(p, "w".into()));
        clear_for_ruby(p);
    }

    #[test]
    fn queues_jobs_by_scope_and_joins_an_equivalent_register() {
        let p = partition_new_for_ruby();
        let (a, runs) = schedule_job_for_ruby(p, "register".into(), "s/".into(), "s/a.js".into(), Some("imports".into()), "classic".into(), 0, 0, String::new());
        assert!(runs);
        assert_eq!(schedule_job_for_ruby(p, "register".into(), "s/".into(), "s/a.js".into(), Some("imports".into()), "classic".into(), 0, 3, String::new()), (a, false));
        let (b, runs) = schedule_job_for_ruby(p, "register".into(), "s/".into(), "s/b.js".into(), Some("imports".into()), "classic".into(), 0, 0, String::new());
        assert!(!runs);
        let (c, runs) = schedule_job_for_ruby(p, "update".into(), "t/".into(), "t/a.js".into(), None, "classic".into(), 9, 0, String::new());
        assert!(runs);
        assert_eq!(job_for_ruby(p, c).map(|j| j.0), Some("update".into()));
        assert_eq!(finish_job_for_ruby(p, a), Some(b));
        assert_eq!(finish_job_for_ruby(p, b), None);
        assert!(job_for_ruby(p, b).is_none());
        assert_eq!(registered_at_for_ruby(p, "s/".into()), 0);
        note_registered_for_ruby(p, "s/".into());
        assert_ne!(registered_at_for_ruby(p, "s/".into()), 0);
        let short = note_registered_for_ruby(p, "https://a.test/".into());
        let long = note_registered_for_ruby(p, "https://a.test/x/".into());
        note_registered_for_ruby(p, "https://b.test/".into());
        let a = || "https://a.test".to_owned();
        assert_eq!(match_registration_for_ruby(p, a(), "https://a.test/x/y".into()), Some((long, "https://a.test/x/".into())));
        assert_eq!(match_registration_for_ruby(p, a(), "https://a.test/y".into()), Some((short, "https://a.test/".into())));
        assert_eq!(match_registration_for_ruby(p, "null".into(), "https://a.test/y".into()), None);
        let of_a: Vec<u32> = registrations_of_origin_for_ruby(p, "https://a.test".into()).into_iter().map(|r| r.0).collect();
        assert_eq!(of_a, [short, long]);
        clear_for_ruby(p);
    }

    #[test]
    fn steps_a_version_from_installing_to_activated() {
        let p = partition_new_for_ruby();
        worker_new_for_ruby(p, 3, "a/sw.js".into(), "classic".into());
        assert_eq!(advance(p, 3), "done");
        begin_lifecycle(p, 3);
        assert_eq!(advance(p, 3), "updatefound");
        assert_eq!(advance(p, 3), "install");
        note_phase_for_ruby(p, 3, "install".into(), true);
        assert_eq!(advance(p, 3), "installed");
        assert!(awaits_activation(p, 3));
        // (…held at Try Activate while the active worker it replaces controls a client, let go once that one goes)
        let id = note_registered_for_ruby(p, "https://a.test/".into());
        worker_new_for_ruby(p, 9, "a/sw.js".into(), "classic".into());
        set_version(p, id, "active".into(), Some(9));
        set_version(p, id, "waiting".into(), Some(3));
        note_client_for_ruby(p, "c".into(), "https://b.test/".into(), "window".into(), "top-level".into(), None, Some(9));
        assert_eq!(advance(p, 3), "try_activate");
        forget_client_for_ruby(p, "c".into());
        assert_eq!(advance(p, 3), "activating");
        assert_eq!(advance(p, 3), "activation");
        note_phase_for_ruby(p, 3, "activated".into(), true);
        assert_eq!(advance(p, 3), "activated");
        assert_eq!(advance(p, 3), "done");
        // A failed install ends it; a redundant worker takes no step.
        worker_new_for_ruby(p, 4, "a/sw.js".into(), "classic".into());
        begin_lifecycle(p, 4);
        assert_eq!(advance(p, 4), "updatefound");
        note_phase_for_ruby(p, 4, "install".into(), false);
        assert_eq!(advance(p, 4), "install_failed");
        assert_eq!(advance(p, 4), "done");
        worker_new_for_ruby(p, 5, "a/sw.js".into(), "classic".into());
        begin_lifecycle(p, 5);
        set_worker_state_for_ruby(p, 5, "redundant".into());
        assert_eq!(advance(p, 5), "done");
        clear_for_ruby(p);
    }

    #[test]
    fn keeps_a_registration_from_its_job_to_its_clear() {
        let p = partition_new_for_ruby();
        let id = note_registered_for_ruby(p, "a/".into());
        worker_new_for_ruby(p, 7, "a/sw.js".into(), "classic".into());
        set_version(p, id, "installing".into(), Some(7));
        note_activating(p, "a/".into(), 7);
        assert_eq!(registrations_for_ruby(p), [("a/".into(), true, Some(7), None, id)]);
        activated(p, "a/".into(), 7);
        activated(p, "b/".into(), 7);
        set_navigation_preload_for_ruby(p, "a/".into(), Some(true), None);
        assert_eq!(navigation_preload_for_ruby(p, "a/".into()), (true, "true".into()));
        note_activating(p, "a/".into(), 8);
        forget_worker_for_ruby(p, 7);
        forget_worker_for_ruby(p, 8);
        assert_eq!(registrations_for_ruby(p)[0], ("a/".into(), true, Some(8), None, id));
        forget_activating_for_ruby(p, 8);
        assert_eq!(registrations_for_ruby(p)[0], ("a/".into(), true, None, None, id));
        // A scope its job only set a mode on is no registration yet, and takes its place when one is made there.
        set_update_via_cache_for_ruby(p, "c/".into(), "all".into());
        note_registered_for_ruby(p, "b/".into());
        note_registered_for_ruby(p, "c/".into());
        let order: Vec<String> = registrations_for_ruby(p).into_iter().map(|r| r.0).collect();
        assert_eq!(order, ["a/", "b/", "c/"]);
        // Unregistered, it leaves the map but keeps its version until it is cleared.
        assert_eq!(unregister_for_ruby(p, "a/".into()), Some(id));
        assert_eq!(unregister_for_ruby(p, "a/".into()), None);
        assert_eq!(navigation_preload_for_ruby(p, "a/".into()), (false, "true".into()));
        assert_eq!(versions_for_ruby(p, id), (Some(7), None, None));
        let again = note_registered_for_ruby(p, "a/".into());
        assert_ne!(again, id);
        clear_registration_for_ruby(p, id);
        assert_eq!(versions_for_ruby(p, id), (None, None, None));
        assert!(set_worker_state_for_ruby(p, 7, "redundant".into()));
        assert_eq!(worker_for_ruby(p, 7), Some(("a/sw.js".into(), "classic".into(), "redundant".into(), id)));
        clear_for_ruby(p);
        forget_worker_for_ruby(p, 7);
        assert!(lock().partitions.get(&p).is_none());
    }
}
