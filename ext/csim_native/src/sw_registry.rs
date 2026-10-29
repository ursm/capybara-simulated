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

use magnus::{IntoValue, IntoValueFromNative, Ruby, Value};

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
// there have finished: what it asks — the script (an Update job's: its registration's newest worker's, as update() found
// it), the updateViaCache mode (none for an Update job's) and the worker type — and, for the host running it, the client
// realm that asked (0: the window; a service worker's: the negative of its handle), the service workers whose own
// unregister() it answers (the equivalent jobs' included) and its origin key. As it runs: its run's place among the
// tasks queued (none where it is not queued), the registration Update found (0 for none yet), what it waits for, the
// worker its script is byte-checked against, and whether its promises settled.
pub(crate) struct Job {
    id: u32,
    kind: String,
    scope: String,
    script_url: String,
    update_via_cache: Option<String>,
    script_type: String,
    registration: u32,
    realm: i64,
    asking_workers: Vec<u32>,
    creator_key: String,
    queued: Option<u32>,
    waits: Option<JobWait>,
    against: u32,
    settled: bool,
}

// What a running job waits for: its worker's script to evaluate, then — its promises resolved — that worker's install
// to end (Install finishes the job only then, so a job behind it at the scope waits it out: update-not-allowed "from
// client succeeds while installing", register-wait-forever-in-install-worker).
#[derive(Clone, Copy, PartialEq)]
enum JobWait {
    Evaluation(u32),
    Install(u32),
}

// How a job settled: the registration a Register or Update job resolves with, the error it rejects with (its name and
// message), whether an Unregister job unregistered one.
#[derive(Default)]
struct Outcome {
    registration: u32,
    error: Option<(&'static str, String)>,
    unregistered: bool,
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
    // The registrations unregistered whose Clear Registration waits — until no client is using one and none of its
    // versions has an event pending — and whether a frame's navigation parked on an activating registration (the
    // engine keeps the frames: frame_navigation.rs `takeSwDeferredFrames`), which a settled registration replays.
    uninstalling: Vec<u32>,
    navs_deferred: bool,
    // (…the jobs' runs, numbered as they are queued)
    jobs_queued: u32,
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
    // …the one a Register job made there: its number, 0 for none.
    fn registered_at(&mut self, scope: &str) -> u32 {
        self.mapped(scope).filter(|r| r.registered).map_or(0, |r| r.id)
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

// ── The job queues (Service Workers §8 Schedule Job, Run Job, Finish Job; the Register, Update and Unregister jobs) ──
// The jobs at a scope run one at a time, in order (the scope's job queue), each as a task of the platform's on the
// window's event loop (sw-client.js __csim_swQueueJob, which runs it back), and settle the promises waiting on it in
// every realm (__csim_swJobSettled). What runs on the network or in an isolate is the host's: the script's fetch and
// byte check, and its worker's spawn — each answered back here.
impl Partition {
    fn job(&mut self, id: u32) -> Option<&mut Job> {
        self.jobs.iter_mut().find(|j| j.id == id)
    }
    // The job `id`'s run queued, where it is not already.
    fn queue_job(&mut self, id: u32, out: &mut Vec<Cmd>) {
        if !self.job(id).is_some_and(|j| j.queued.is_none()) {
            return;
        }
        self.jobs_queued += 1;
        let place = self.jobs_queued;
        if let Some(j) = self.job(id) {
            j.queued = Some(place);
        }
        out.push(Cmd::QueueJob(id));
    }
    // Resolve / Reject Job Promise: every realm's promises waiting on the job (an equivalent job's joined it) settled as
    // `outcome`, and each service worker's own unregister() among them answered — once.
    fn answer(&mut self, id: u32, outcome: Outcome, out: &mut Vec<Cmd>) {
        let Some(j) = self.job(id).filter(|j| !j.settled) else { return };
        j.settled = true;
        let Outcome { registration, error, unregistered } = outcome;
        let (name, message) = error.unzip();
        out.push(Cmd::Settled(id, registration, j.scope.clone(), name, message, unregistered));
        // (…the answer may never be read: an uncontrolled registration's uninstall clears at once, terminating that very
        // worker — the promise dies with the isolate, like a real terminated worker's)
        out.extend(j.asking_workers.iter().map(|&h| Cmd::Answer(h, unregistered)));
    }
    // Finish Job: the job `id` out of its queue — the next one there queued to run. Committed at once: a realm's
    // promise settles in a task after it (each realm runs its microtasks after the broadcast here), and a page's next
    // register() there finds this job gone from the queue.
    fn finish(&mut self, id: u32, out: &mut Vec<Cmd>) {
        let Some(i) = self.jobs.iter().position(|j| j.id == id) else { return };
        let scope = self.jobs.remove(i).scope;
        if let Some(next) = self.jobs.iter().find(|j| j.scope == scope).map(|j| j.id) {
            self.queue_job(next, out);
        }
    }
    // …settled as `outcome`, and finished: the finish committed first, the next job queued before the realms are told.
    fn conclude(&mut self, id: u32, outcome: Outcome, out: &mut Vec<Cmd>) {
        let mut answers = Vec::new();
        self.answer(id, outcome, &mut answers);
        self.finish(id, out);
        out.extend(answers);
    }
    // …rejected with an error `name`: "Failed to register a ServiceWorker: `what`" (or update, or unregister).
    fn fail(&mut self, id: u32, name: &'static str, what: &str, out: &mut Vec<Cmd>) {
        let Some(j) = self.job(id) else { return };
        let message = format!("Failed to {} a ServiceWorker: {what}", j.kind);
        self.conclude(id, Outcome { error: Some((name, message)), ..Outcome::default() }, out);
    }
    // Run Job. The Unregister job: the registration the map holds at the scope out of it — its clear waiting until no
    // client is using it — whether there was one. A Register job at a scope whose newest worker already runs ITS script,
    // under the same type, finishes at once when the updateViaCache mode is unchanged too (register() resolves with the
    // same registration, its workers untouched — multiple-register); a changed mode makes it an update with that mode,
    // whose cache decisions just changed (registration-updateviacache's X-then-Y cases). An Update job rejects where the
    // map holds no registration at its scope (an unregister got there first) or that registration's newest worker runs
    // another script than the one update() found. Then the host fetches the script and byte-checks it against the newest
    // worker — where that runs the same script under the same type — (`job_fetched`).
    fn run_job(&mut self, id: u32, out: &mut Vec<Cmd>) {
        let Some(j) = self.job(id) else { return };
        j.queued = None;
        let (kind, scope, script_url, script_type, mode) =
            (j.kind.clone(), j.scope.clone(), j.script_url.clone(), j.script_type.clone(), j.update_via_cache.clone());
        if kind == "unregister" {
            // (…Unregister's order: the promises resolved, then Try Clear Registration, then Finish Job)
            let mut clear = Vec::new();
            let unregistered = self.unregister(&scope, &mut clear);
            self.answer(id, Outcome { unregistered, ..Outcome::default() }, out);
            out.extend(clear);
            return self.finish(id, out);
        }
        let registration = self.registered_at(&scope);
        if kind == "update" && registration == 0 {
            return self.fail(id, "TypeError", "the registration has been unregistered.", out);
        }
        let newest = self.newest(registration);
        let script = newest.and_then(|h| self.workers.get(&h)).map(|w| (w.script_url.clone(), w.script_type.clone()));
        if kind == "update" && script.as_ref().is_some_and(|(url, _)| *url != script_url) {
            return self.fail(id, "TypeError", "the newest worker's script URL is not the one update() found.", out);
        }
        let same_script = script.as_ref().is_some_and(|(url, ty)| *url == script_url && *ty == script_type);
        if kind == "register" && same_script {
            let current = self.mapped(&scope).and_then(|r| r.update_via_cache.clone());
            if mode.is_some() && current.or_else(|| Some("imports".to_owned())) == mode {
                return self.conclude(id, Outcome { registration, ..Outcome::default() }, out);
            }
        }
        if let Some(j) = self.job(id) {
            j.registration = registration;
            j.against = newest.filter(|_| same_script).unwrap_or(0);
            out.push(Cmd::Fetch(id));
        }
    }
    // Get Newest Worker: the registration `id`'s installing worker, or else its waiting one, or else its active one.
    fn newest(&mut self, id: u32) -> Option<u32> {
        let [installing, waiting, active] = self.by_id(id).map_or([None; 3], |r| r.versions());
        installing.or(waiting).or(active)
    }
    // The job `id`'s worker could not be spawned (`handle` none), or was: the job waits for its script to evaluate.
    fn job_spawned(&mut self, id: u32, handle: Option<u32>, out: &mut Vec<Cmd>) {
        match handle {
            Some(h) => {
                if let Some(j) = self.job(id) {
                    j.waits = Some(JobWait::Evaluation(h));
                }
            }
            None => self.fail(id, "TypeError", "the worker could not be started.", out),
        }
    }
    // The job waiting for `wait`, where one does.
    fn job_waiting(&self, wait: JobWait) -> Option<u32> {
        self.jobs.iter().find(|j| j.waits == Some(wait)).map(|j| j.id)
    }
    // The worker `handle`'s install ended (installed, failed, or its thread gone): the job that made it finished.
    fn install_ended(&mut self, handle: u32, out: &mut Vec<Cmd>) {
        if let Some(id) = self.job_waiting(JobWait::Install(handle)) {
            self.finish(id, out);
        }
    }
}

impl Registry {
    // The job `id`'s script fetched (`error`: "mime", "scope", or another failure; `changed`: its bytes differ from the
    // newest worker's): a redirect, a non-JS MIME type or a scope past the script's max scope rejects, an unchanged one
    // resolves — committing the job's mode — and a changed one runs: the client announced first (a worker may enumerate
    // its clients while its script evaluates), then its worker spawned by the host. Whether to spawn it.
    fn job_fetched(&mut self, partition: u64, id: u32, error: Option<&str>, changed: bool, out: &mut Vec<Cmd>) -> bool {
        let Some(p) = self.existing(partition) else { return false };
        let Some(j) = p.job(id) else { return false };
        let (scope, mode, registration, realm) = (j.scope.clone(), j.update_via_cache.clone(), j.registration, j.realm);
        match error {
            Some("mime") => p.fail(id, "SecurityError", "the script has an unsupported MIME type.", out),
            Some("scope") => p.fail(id, "SecurityError", "the scope is outside the script's max scope.", out),
            Some(_) => p.fail(id, "TypeError", "the script fetch failed.", out),
            None if !changed => {
                if let Some(mode) = mode {
                    self.at(partition, &scope).update_via_cache = Some(mode);
                }
                self.partition(partition).conclude(id, Outcome { registration, ..Outcome::default() }, out);
            }
            None => {
                out.push(Cmd::ReportClient(realm));
                return true;
            }
        }
        false
    }
    // The job's worker `handle` evaluated its script ("Run Service Worker" gates the job): one whose evaluation failed
    // (an importScripts that 404s, a top-level throw, a script that does not parse) ended and the job rejected, with no
    // version ever visible and the registration's mode untouched (registration-updateviacache "not updated if register()
    // rejects"); one that ran Install: the registration's installing worker — a Register job's registration made now, as
    // the map holds it NOW (another job may have made it meanwhile), the job's mode committed — the job's promises
    // resolved, and the job waiting for the install to end.
    fn job_evaluated(&mut self, partition: u64, handle: u32, ok: bool, message: &str, out: &mut Vec<Cmd>) {
        let Some(p) = self.existing(partition) else { return };
        let Some(id) = p.job_waiting(JobWait::Evaluation(handle)) else { return };
        if !ok {
            out.push(Cmd::Terminate(handle));
            return p.fail(id, "TypeError", &format!("the script evaluation failed. {message}"), out);
        }
        let Some(j) = p.job(id) else { return };
        let (kind, scope, mode, registration) = (j.kind.clone(), j.scope.clone(), j.update_via_cache.clone(), j.registration);
        j.waits = Some(JobWait::Install(handle));
        let registration = if kind == "register" { self.registered(partition, &scope).id } else { registration };
        if let Some(mode) = mode {
            self.at(partition, &scope).update_via_cache = Some(mode);
        }
        let p = self.partition(partition);
        p.install(registration, handle, out);
        p.answer(id, Outcome { registration, ..Outcome::default() }, out);
    }
}

// Schedule Job: a job of `kind` ("register", "update" — of the registration `registration`, of its newest worker's
// script, none for a registration with no worker: update()'s InvalidStateError — or "unregister") at `scope` — its
// number, and what the host does: its run queued where no job is before it at the scope. A job equivalent to the last one
// queued there (Register and Update jobs: the same script, type and mode; Unregister jobs: the same scope) whose promises
// have not settled is that job: its number, not to run again.
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
) -> Option<(u32, Vec<Cmd>)> {
    let mut reg = lock();
    let p = reg.partition(partition);
    let (script_url, script_type) = if kind == "update" {
        let w = p.newest(registration).and_then(|h| p.workers.get(&h))?;
        (w.script_url.clone(), w.script_type.clone())
    } else {
        (script_url, script_type)
    };
    let asking_workers: Vec<u32> = (realm < 0).then(|| realm.unsigned_abs() as u32).into_iter().collect();
    let last = p.jobs.iter_mut().rev().find(|j| j.scope == scope);
    let runs = last.is_none();
    if let Some(last) = last.filter(|j| {
        !j.settled
            && j.kind == kind
            && (kind == "unregister" || (j.script_url == script_url && j.script_type == script_type && j.update_via_cache == update_via_cache))
    }) {
        last.asking_workers.extend(asking_workers);
        return Some((last.id, Vec::new()));
    }
    reg.next_job += 1;
    let id = reg.next_job;
    let job = Job {
        id,
        kind,
        scope,
        script_url,
        update_via_cache,
        script_type,
        registration: 0,
        realm,
        asking_workers,
        creator_key,
        queued: None,
        waits: None,
        against: 0,
        settled: false,
    };
    let p = reg.partition(partition);
    p.jobs.push(job);
    let mut out = Vec::new();
    if runs {
        p.queue_job(id, &mut out);
    }
    Some((id, out))
}
// The job `id` run (`__csim_swRunJob`): what the host does.
pub(crate) fn run_job_for_ruby(partition: u64, id: u32) -> Vec<Cmd> {
    let mut out = Vec::new();
    if let Some(p) = lock().existing(partition) {
        p.run_job(id, &mut out);
    }
    out
}
// What the host fetches for it: `[scope, script URL, mode, type, creator key, the worker an update fetches against (0
// for none)]`, nil for one finished.
pub(crate) fn job_for_ruby(partition: u64, id: u32) -> Option<(String, String, Option<String>, String, String, u32)> {
    let mut reg = lock();
    let j = reg.existing(partition)?.job(id)?;
    Some((j.scope.clone(), j.script_url.clone(), j.update_via_cache.clone(), j.script_type.clone(), j.creator_key.clone(), j.against))
}
// …its script fetched (`job_fetched`): [whether the host spawns its worker, what the host does].
pub(crate) fn job_fetched_for_ruby(partition: u64, id: u32, error: Option<String>, changed: bool) -> (bool, Vec<Cmd>) {
    let mut out = Vec::new();
    let spawn = lock().job_fetched(partition, id, error.as_deref(), changed, &mut out);
    (spawn, out)
}
// …its worker spawned, as `handle` (none where the host could not start it): what the host does.
pub(crate) fn job_spawned_for_ruby(partition: u64, id: u32, handle: Option<u32>) -> Vec<Cmd> {
    let mut out = Vec::new();
    if let Some(p) = lock().existing(partition) {
        p.job_spawned(id, handle, &mut out);
    }
    out
}
// The worker `handle` evaluated its script (`job_evaluated`): what the host does.
pub(crate) fn job_evaluated_for_ruby(partition: u64, handle: u32, ok: bool, message: String) -> Vec<Cmd> {
    let mut out = Vec::new();
    lock().job_evaluated(partition, handle, ok, &message, &mut out);
    out
}
// The worker `handle` reaped: a job its worker owed an evaluation outcome fails with it (its worker thread posts the
// outcome before it exits, so one still owed never comes), and a job whose install it was finishes — neither may hold its
// scope's queue for good. What the host does.
pub(crate) fn job_worker_gone_for_ruby(partition: u64, handle: u32) -> Vec<Cmd> {
    let mut out = Vec::new();
    if let Some(p) = lock().existing(partition) {
        if let Some(id) = p.job_waiting(JobWait::Evaluation(handle)) {
            p.fail(id, "TypeError", "the worker ended before its script evaluated.", &mut out);
        }
        p.install_ended(handle, &mut out);
    }
    out
}
// The jobs whose run is queued, in the order queued — the outgoing page's tasks, the new page's to run.
pub(crate) fn queued_jobs_for_ruby(partition: u64) -> Vec<u32> {
    let mut reg = lock();
    let Some(p) = reg.existing(partition) else { return Vec::new() };
    let mut queued: Vec<(u32, u32)> = p.jobs.iter().filter_map(|j| j.queued.map(|place| (place, j.id))).collect();
    queued.sort_unstable();
    queued.into_iter().map(|(_, id)| id).collect()
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
    lock().existing(partition).map_or(0, |p| p.registered_at(&scope))
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
// not still activating (whose successor's activation is delayed) with no events pending — which holds an installed
// successor even past skipWaiting (activation.https "skipWaiting bypasses no controllee requirement": it bypasses only
// the controllee half) — and either no client using the registration or the candidate having skipped waiting.
fn may_activate(p: &Partition, candidate: u32) -> bool {
    let Some(w) = p.workers.get(&candidate) else { return false };
    let Some(outgoing) = p.registrations.iter().find(|r| r.id == w.registration).and_then(|r| r.active) else { return true };
    if outgoing == candidate {
        return true;
    }
    let held = p.workers.get(&outgoing).is_some_and(|o| o.state == "activating" || o.extended());
    !held && (w.skip_waiting || !controls_clients(p, outgoing))
}
impl Partition {
    // Try Clear Registration's verdict for the registration `id`: no client controlled by its active worker, and no
    // version with an event pending ("Service Worker Has No Pending Events") — a message's, an extendable message event's,
    // its install or activate event's.
    fn clearable(&self, id: u32) -> bool {
        let Some(r) = self.registrations.iter().find(|r| r.id == id) else { return true };
        if r.active.is_some_and(|a| self.clients.iter().any(|c| c.controller == Some(a))) {
            return false;
        }
        r.workers().iter().filter_map(|h| self.workers.get(h)).all(|w| !w.extended() && !w.lifecycle_pending())
    }
    // Try Clear Registration for each registration unregistered: one no client is using and none of whose versions has
    // an event pending cleared — it gone, its versions with it, then each worker redundant in every realm (a
    // `statechange` listener already finding the registration empty, as in Chrome), then the isolates ended. The verdict
    // is the registry's, so the clear rides the same wakeups as Try Activate: every hold-clearing transition (a client
    // gone, an extension drained, a message dispatched, a worker reaped, a step taken) tries it again.
    fn try_clear(&mut self, out: &mut Vec<Cmd>) {
        let (ready, waiting): (Vec<u32>, Vec<u32>) = std::mem::take(&mut self.uninstalling).into_iter().partition(|&id| self.clearable(id));
        self.uninstalling = waiting;
        for id in ready {
            let Some(i) = self.registrations.iter().position(|r| r.id == id) else { continue };
            let handles = self.registrations.remove(i).workers();
            for &h in &handles {
                Self::tell_state(h, "redundant", out);
            }
            for &h in &handles {
                out.push(Cmd::Terminate(h));
            }
        }
    }
    // The Unregister job at `scope`: the registration out of the map (its mode and navigation preload state with it: one
    // made at the scope later is a new one), which every realm's registration object of it sees at once — one with no
    // version left gone at once, another's Clear Registration waiting (`try_clear`) — and a navigation parked on its
    // activation, which now never comes, replayed against the network. Whether the map held one.
    fn unregister(&mut self, scope: &str, out: &mut Vec<Cmd>) -> bool {
        let Some(r) = self.mapped(scope) else { return false };
        r.mapped = false;
        let id = r.id;
        if r.workers().is_empty() {
            self.registrations.retain(|r| r.id != id);
        } else {
            self.uninstalling.push(id);
        }
        self.try_clear(out);
        self.retry_navs(out);
        true
    }
    // The frame navigations parked on an activating registration replayed (`navs_deferred`).
    fn retry_navs(&mut self, out: &mut Vec<Cmd>) {
        if std::mem::take(&mut self.navs_deferred) {
            out.push(Cmd::RetryNavs);
        }
    }
}
// Try Clear Registration (`try_clear`): what the host does.
pub(crate) fn try_clear_for_ruby(partition: u64) -> Vec<Cmd> {
    let mut out = Vec::new();
    if let Some(p) = lock().existing(partition) {
        p.try_clear(&mut out);
    }
    out
}
// A frame's navigation parked on an activating registration (`navs_deferred`).
pub(crate) fn defer_navigation_for_ruby(partition: u64) {
    if let Some(p) = lock().existing(partition) {
        p.navs_deferred = true;
    }
}
// …and the ones parked replayed (`retry_navs`): what the host does.
pub(crate) fn retry_navs_for_ruby(partition: u64) -> Vec<Cmd> {
    let mut out = Vec::new();
    if let Some(p) = lock().existing(partition) {
        p.retry_navs(&mut out);
    }
    out
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
// ── What the host does ──
// What a job's or a lifecycle's step makes the host do, in order — the registry's state committed first, each a Ruby
// array `[kind, *arguments]`.
#[derive(Debug, PartialEq)]
pub(crate) enum Cmd {
    // Update Worker State, at its turn: the worker in the state, every realm told where that is a change (a realm that
    // makes its ServiceWorker of the worker in a listener of an earlier one makes it in the state before, and sees its
    // `statechange`).
    State(u32, &'static str),
    // The worker's isolate ended.
    Terminate(u32),
    // The registration's `updatefound` fired.
    UpdateFound(u32),
    // The worker's activate event fired.
    Activate(u32),
    // Every realm told the worker is its registration's active one: its script URL, whether it intercepts.
    Activated(u32, String, bool),
    // The worker's next step queued as a task of the window's.
    QueueStep(u32),
    // The rest of the worker's step taken, once what came before it was done.
    Continue(u32),
    // The registrations unregistered tried to clear, once that was.
    TryClear,
    // Try Activate taken again for every worker waiting at it, once that was.
    TryActivate,
    // The frame navigations parked on an activating registration replayed.
    RetryNavs,
    // The job's run queued as a task of the window's.
    QueueJob(u32),
    // The job's script fetched.
    Fetch(u32),
    // The realm that asked for the job (0: the window) announced as a client, before its worker evaluates.
    ReportClient(i64),
    // Every realm's promises waiting on the job settled: the registration, its scope, the error's name and message,
    // whether an Unregister job unregistered one.
    Settled(u32, u32, String, Option<&'static str>, Option<String>, bool),
    // A service worker's own unregister() answered: whether it unregistered one.
    Answer(u32, bool),
}

impl IntoValue for Cmd {
    fn into_value_with(self, ruby: &Ruby) -> Value {
        match self {
            Cmd::State(handle, state) => ("state", handle, state).into_value_with(ruby),
            Cmd::Terminate(handle) => ("terminate", handle).into_value_with(ruby),
            Cmd::UpdateFound(id) => ("update_found", id).into_value_with(ruby),
            Cmd::Activate(handle) => ("activate", handle).into_value_with(ruby),
            Cmd::Activated(handle, script_url, intercepts) => ("activated", handle, script_url, intercepts).into_value_with(ruby),
            Cmd::QueueStep(handle) => ("queue_step", handle).into_value_with(ruby),
            Cmd::Continue(handle) => ("continue", handle).into_value_with(ruby),
            Cmd::TryClear => ("try_clear",).into_value_with(ruby),
            Cmd::TryActivate => ("try_activate",).into_value_with(ruby),
            Cmd::RetryNavs => ("retry_navs",).into_value_with(ruby),
            Cmd::QueueJob(id) => ("queue_job", id).into_value_with(ruby),
            Cmd::Fetch(id) => ("fetch", id).into_value_with(ruby),
            Cmd::ReportClient(realm) => ("report_client", realm).into_value_with(ruby),
            Cmd::Settled(id, registration, scope, error, message, unregistered) => {
                ("settled", id, registration, scope, error, message, unregistered).into_value_with(ruby)
            }
            Cmd::Answer(handle, unregistered) => ("answer", handle, unregistered).into_value_with(ruby),
        }
    }
}

// SAFETY: a Cmd holds no Ruby value.
unsafe impl IntoValueFromNative for Cmd {}

// ── The lifecycle, as the host takes its steps (Service Workers §8 Install, Try Activate, Activate) ──

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
        out.push(Cmd::Terminate(handle));
    }
    fn tell_state(handle: u32, state: &'static str, out: &mut Vec<Cmd>) {
        out.push(Cmd::State(handle, state));
    }
    // The worker's next step queued, where it is not already.
    fn queue_step(&mut self, handle: u32, out: &mut Vec<Cmd>) {
        if let Some(w) = self.workers.get_mut(&handle).filter(|w| !w.step_queued) {
            w.step_queued = true;
            out.push(Cmd::QueueStep(handle));
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
                out.push(Cmd::UpdateFound(id));
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
        self.install_ended(handle, out);
        out.push(Cmd::TryClear);
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
            self.unregister(&scope, out);
        } else {
            // (…one unregistered already, which only its install's event held, cleared now)
            out.push(Cmd::TryClear);
        }
        self.install_ended(handle, out);
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
                out.push(Cmd::Continue(handle));
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
        out.push(Cmd::Activate(handle));
        Self::tell_state(handle, "activating", out);
        if let Some(r) = self.registrations.iter_mut().find(|r| r.id == id && r.mapped) {
            r.activating = Some(handle);
        }
        if let Some(w) = self.workers.get(&handle) {
            out.push(Cmd::Activated(handle, w.script_url.clone(), w.intercepts()));
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
        out.push(Cmd::TryClear);
        // (…a successor Try Activate held while this one was still activating tried again: the extend lifetime promises
        // of the active worker settled, as Install's note has it — the worker's state read as the command before set it)
        out.push(Cmd::TryActivate);
    }
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
    // (…a Register job made the registration at `scope`: its number)
    fn note_registered(p: u64, scope: String) -> u32 {
        lock().registered(p, &scope).id
    }
    // (…the registration `id`'s installing worker, its job's worker evaluated)
    fn install(p: u64, id: u32, handle: u32) -> Vec<Cmd> {
        let mut out = Vec::new();
        part(p, |q| q.install(id, handle, &mut out));
        out
    }
    // (…the Unregister job at `scope`: whether the map held one)
    fn unregister(p: u64, scope: String) -> (bool, Vec<Cmd>) {
        let mut out = Vec::new();
        let had = part(p, |q| q.unregister(&scope, &mut out));
        (had, out)
    }
    fn set_update_via_cache(p: u64, scope: String, mode: String) {
        lock().at(p, &scope).update_via_cache = Some(mode);
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
        let id = note_registered(p, "https://a.test/".into());
        worker_new_for_ruby(p, 1, "https://a.test/sw.js".into(), "classic".into());
        assert_eq!(install(p, id, 1), [Cmd::State(1, "installing"), Cmd::QueueStep(1)]);
        // (…one step a task: updatefound, then the install phase waited for, then installed and Try Activate)
        assert_eq!(step_for_ruby(p, 1), [Cmd::UpdateFound(id), Cmd::QueueStep(1)]);
        assert!(step_for_ruby(p, 1).is_empty());
        assert!(resume_for_ruby(p, 1, "activation".into()).is_empty());
        note_phase_for_ruby(p, 1, "install".into(), true);
        assert_eq!(resume_for_ruby(p, 1, "install".into()), [Cmd::State(1, "installed"), Cmd::TryClear, Cmd::QueueStep(1)]);
        assert_eq!(
            step_for_ruby(p, 1),
            [Cmd::Activate(1), Cmd::State(1, "activating"), Cmd::Activated(1, "https://a.test/sw.js".into(), true), Cmd::QueueStep(1)]
        );
        assert!(step_for_ruby(p, 1).is_empty());
        note_phase_for_ruby(p, 1, "activated".into(), true);
        assert_eq!(resume_for_ruby(p, 1, "activation".into()), [Cmd::State(1, "activated"), Cmd::TryClear, Cmd::TryActivate]);
        assert_eq!(match_worker_for_ruby(p, "https://a.test/x".into(), "navigation".into()).map(|m| m.0), Some(1));
        // (…an update replacing it: the outgoing worker retired before the versions move, the rest continued after)
        worker_new_for_ruby(p, 2, "https://a.test/sw.js".into(), "classic".into());
        install(p, id, 2);
        step_for_ruby(p, 2);
        note_phase_for_ruby(p, 2, "install".into(), true);
        step_for_ruby(p, 2);
        assert_eq!(step_for_ruby(p, 2), [Cmd::State(1, "redundant"), Cmd::Terminate(1), Cmd::Continue(2)]);
        assert_eq!(versions_for_ruby(p, id), (None, Some(2), Some(1)));
        assert_eq!(
            continue_for_ruby(p, 2),
            [Cmd::Activate(2), Cmd::State(2, "activating"), Cmd::Activated(2, "https://a.test/sw.js".into(), true), Cmd::QueueStep(2)]
        );
        assert_eq!(versions_for_ruby(p, id), (None, None, Some(2)));
        assert_eq!(queued_steps_for_ruby(p), [2]);
        clear_for_ruby(p);
    }

    #[test]
    fn clears_an_unregistered_registration_once_no_client_uses_it() {
        let p = partition_new_for_ruby();
        let scope = || "https://a.test/".to_owned();
        let id = note_registered(p, scope());
        worker_new_for_ruby(p, 1, "https://a.test/sw.js".into(), "classic".into());
        set_version(p, id, "active".into(), Some(1));
        activated(p, scope(), 1);
        note_client_for_ruby(p, "c".into(), "https://a.test/".into(), "window".into(), "top-level".into(), None, Some(1));
        defer_navigation_for_ruby(p);
        // (…out of the map at once, the parked navigation replayed, the clear waiting on the client)
        let (had, cmds) = unregister(p, scope());
        assert!(had);
        assert_eq!(cmds, [Cmd::RetryNavs]);
        assert!(registrations_for_ruby(p).is_empty());
        assert_eq!(versions_for_ruby(p, id), (None, None, Some(1)));
        assert!(try_clear_for_ruby(p).is_empty());
        // (…the client gone: the versions emptied, then the worker redundant, then ended)
        forget_client_for_ruby(p, "c".into());
        assert_eq!(try_clear_for_ruby(p), [Cmd::State(1, "redundant"), Cmd::Terminate(1)]);
        assert_eq!(versions_for_ruby(p, id), (None, None, None));
        assert!(retry_navs_for_ruby(p).is_empty());
        assert_eq!(unregister(p, scope()), (false, Vec::new()));
        clear_for_ruby(p);
    }

    #[test]
    fn lets_a_worker_activate_as_try_activate_has_it() {
        let p = partition_new_for_ruby();
        let scope = || "https://a.test/".to_owned();
        let id = note_registered(p, scope());
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
        // (…nor while the outgoing worker is still activating, skipWaiting or not)
        set_worker_state_for_ruby(p, 1, "activating".into());
        assert!(!verdict());
        set_worker_state_for_ruby(p, 1, "activated".into());
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
    fn queues_jobs_by_scope_and_joins_an_equivalent_one() {
        let p = partition_new_for_ruby();
        let schedule = |kind: &str, scope: &str, url: &str, registration: u32, realm: i64| {
            schedule_job_for_ruby(p, kind.into(), scope.into(), url.into(), Some("imports".into()), "classic".into(), registration, realm, String::new())
        };
        let (a, cmds) = schedule("register", "s/", "s/a.js", 0, 0).expect("scheduled");
        assert_eq!(cmds, [Cmd::QueueJob(a)]);
        assert_eq!(schedule("register", "s/", "s/a.js", 0, 3), Some((a, Vec::new())));
        let (b, cmds) = schedule("register", "s/", "s/b.js", 0, 0).expect("scheduled");
        assert!(cmds.is_empty());
        let (c, cmds) = schedule("unregister", "t/", "", 0, 0).expect("scheduled");
        assert_eq!(cmds, [Cmd::QueueJob(c)]);
        assert_eq!(queued_jobs_for_ruby(p), [a, c]);
        // (…update() of a registration with no worker is no job)
        assert_eq!(schedule("update", "t/", "", 9, 0), None);
        // (…an Unregister job at a scope the map holds nothing at answers false; the next job at its scope, none, queued)
        assert_eq!(run_job_for_ruby(p, c), [Cmd::Settled(c, 0, "t/".into(), None, None, false)]);
        assert!(job_for_ruby(p, c).is_none());
        // (…a Register job fetches its script, a changed one announcing its client and spawning its worker, which it waits on)
        assert_eq!(run_job_for_ruby(p, a), [Cmd::Fetch(a)]);
        assert_eq!(job_for_ruby(p, a), Some(("s/".into(), "s/a.js".into(), Some("imports".into()), "classic".into(), String::new(), 0)));
        assert_eq!(job_fetched_for_ruby(p, a, None, true), (true, vec![Cmd::ReportClient(0)]));
        worker_new_for_ruby(p, 4, "s/a.js".into(), "classic".into());
        assert!(job_spawned_for_ruby(p, a, Some(4)).is_empty());
        assert_eq!(registered_at_for_ruby(p, "s/".into()), 0);
        // (…evaluated, Install resolves its promises — and a register() now no longer joins it — and finishes it only once
        // the install ends: the next job queued then)
        let cmds = job_evaluated_for_ruby(p, 4, true, String::new());
        let id = registered_at_for_ruby(p, "s/".into());
        assert_eq!(cmds, [Cmd::State(4, "installing"), Cmd::QueueStep(4), Cmd::Settled(a, id, "s/".into(), None, None, false)]);
        let (a2, cmds) = schedule("register", "s/", "s/a.js", 0, 0).expect("scheduled");
        assert_ne!(a2, a);
        assert!(cmds.is_empty());
        assert_eq!(step_for_ruby(p, 4), [Cmd::UpdateFound(id), Cmd::QueueStep(4)]);
        assert!(step_for_ruby(p, 4).is_empty());
        note_phase_for_ruby(p, 4, "install".into(), true);
        assert_eq!(resume_for_ruby(p, 4, "install".into()), [Cmd::State(4, "installed"), Cmd::QueueJob(b), Cmd::TryClear, Cmd::QueueStep(4)]);
        // (…another script is fetched to run: its worker gone before it evaluated, it rejects)
        assert_eq!(run_job_for_ruby(p, b), [Cmd::Fetch(b)]);
        job_spawned_for_ruby(p, b, Some(5));
        let message = "Failed to register a ServiceWorker: the worker ended before its script evaluated.";
        assert_eq!(
            job_worker_gone_for_ruby(p, 5),
            [Cmd::QueueJob(a2), Cmd::Settled(b, 0, "s/".into(), Some("TypeError"), Some(message.into()), false)]
        );
        // (…the same script and mode again resolves at once)
        assert_eq!(run_job_for_ruby(p, a2), [Cmd::Settled(a2, id, "s/".into(), None, None, false)]);
        // (…update() takes the newest worker's script, and an equivalent one joins it)
        let (u, _) = schedule("update", "s/", "", id, 0).expect("scheduled");
        assert_eq!(schedule("update", "s/", "", id, 0), Some((u, Vec::new())));
        assert_eq!(run_job_for_ruby(p, u), [Cmd::Fetch(u)]);
        assert_eq!(job_for_ruby(p, u).map(|j| (j.1, j.5)), Some(("s/a.js".into(), 4)));
        assert_eq!(job_fetched_for_ruby(p, u, None, false), (false, vec![Cmd::Settled(u, id, "s/".into(), None, None, false)]));
        // (…a service worker's own unregister() is answered in its inbox, a client's joining it in its realm)
        let (r, _) = schedule("unregister", "s/", "", 0, -4).expect("scheduled");
        assert_eq!(schedule("unregister", "s/", "", 0, 0), Some((r, Vec::new())));
        // (…answered before its registration clears, as Unregister has it)
        let cmds = run_job_for_ruby(p, r);
        assert_eq!(cmds[..2], [Cmd::Settled(r, 0, "s/".into(), None, None, true), Cmd::Answer(4, true)]);
        clear_for_ruby(p);
        let p = partition_new_for_ruby();
        assert_eq!(registered_at_for_ruby(p, "s/".into()), 0);
        note_registered(p, "s/".into());
        assert_ne!(registered_at_for_ruby(p, "s/".into()), 0);
        let short = note_registered(p, "https://a.test/".into());
        let long = note_registered(p, "https://a.test/x/".into());
        note_registered(p, "https://b.test/".into());
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
        let id = note_registered(p, "https://a.test/".into());
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
        let id = note_registered(p, "a/".into());
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
        set_update_via_cache(p, "c/".into(), "all".into());
        note_registered(p, "b/".into());
        note_registered(p, "c/".into());
        let order: Vec<String> = registrations_for_ruby(p).into_iter().map(|r| r.0).collect();
        assert_eq!(order, ["a/", "b/", "c/"]);
        // Unregistered, it leaves the map — its version, which nothing holds, cleared with it.
        let (had, cmds) = unregister(p, "a/".into());
        assert!(had);
        assert_eq!(cmds, [Cmd::State(7, "redundant"), Cmd::Terminate(7)]);
        assert_eq!(unregister(p, "a/".into()), (false, Vec::new()));
        assert_eq!(navigation_preload_for_ruby(p, "a/".into()), (false, "true".into()));
        assert_eq!(versions_for_ruby(p, id), (None, None, None));
        let again = note_registered(p, "a/".into());
        assert_ne!(again, id);
        assert!(set_worker_state_for_ruby(p, 7, "redundant".into()));
        assert_eq!(worker_for_ruby(p, 7), Some(("a/sw.js".into(), "classic".into(), "redundant".into(), id)));
        clear_for_ruby(p);
        forget_worker_for_ruby(p, 7);
        assert!(lock().partitions.get(&p).is_none());
    }
}
