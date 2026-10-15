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

#[derive(Default)]
struct Partition {
    registrations: Vec<Registration>,
    workers: HashMap<u32, Worker>,
}

impl Partition {
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
        let list = &mut self.partition(partition).registrations;
        let mut i = list.iter().position(|r| r.id == id).expect("just made");
        if !list[i].registered {
            let r = list.remove(i);
            list.push(r);
            i = list.len() - 1;
            list[i].registered = true;
        }
        &mut list[i]
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
// Its `slot` ("installing", "waiting" or "active") set to the worker `handle` — a version of it from then on — or
// emptied.
pub(crate) fn set_version_for_ruby(partition: u64, id: u32, slot: String, handle: Option<u32>) {
    let mut reg = lock();
    let Some(p) = reg.existing(partition) else { return };
    if let Some(s) = p.by_id(id).and_then(|r| r.slot(&slot)) {
        *s = handle;
    }
    if let Some(w) = handle.and_then(|h| p.workers.get_mut(&h)) {
        w.registration = id;
    }
}
// A service worker of the session, spawned: its script's URL and type, 'parsed' until a registration holds it.
pub(crate) fn worker_new_for_ruby(partition: u64, handle: u32, script_url: String, script_type: String) {
    let worker = Worker { script_url, script_type, state: "parsed".to_owned(), registration: 0, lifecycle: Lifecycle::default() };
    lock().partition(partition).workers.insert(handle, worker);
}
// The worker `handle`: `[script URL, type, state, registration]` (0 for none yet), nil for none.
pub(crate) fn worker_for_ruby(partition: u64, handle: u32) -> Option<(String, String, String, u32)> {
    let mut reg = lock();
    let w = reg.existing(partition)?.workers.get(&handle)?;
    Some((w.script_url.clone(), w.script_type.clone(), w.state.clone(), w.registration))
}
// …its state moved to `state`: whether that is a change.
pub(crate) fn set_worker_state_for_ruby(partition: u64, handle: u32, state: String) -> bool {
    let mut reg = lock();
    let Some(w) = reg.existing(partition).and_then(|p| p.workers.get_mut(&handle)) else { return false };
    let changed = w.state != state;
    w.state = state;
    changed
}
// The worker `handle` begins its lifecycle (its job made it its registration's installing worker): `updatefound` next.
pub(crate) fn begin_lifecycle_for_ruby(partition: u64, handle: u32) {
    if let Some(w) = lock().existing(partition).and_then(|p| p.workers.get_mut(&handle)) {
        w.lifecycle.step = Step::UpdateFound;
    }
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
// The worker `handle`'s next lifecycle step, taken: "updatefound", "installed", "install_failed", "activating" —
// where `may_activate` (Try Activate's verdict: the outgoing worker holds no clients and no extended work, or the worker
// skipped waiting) — or "activated"; else what it waits for: "install" or "activation" (its own phase), "try_activate"
// (the verdict), or "done" (no step left — finished, failed, redundant, or no such worker).
pub(crate) fn advance_for_ruby(partition: u64, handle: u32, may_activate: bool) -> &'static str {
    let mut reg = lock();
    let Some(w) = reg.existing(partition).and_then(|p| p.workers.get_mut(&handle)) else { return "done" };
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
// Whether the worker `handle` stands at Try Activate (installed, its activation not yet allowed).
pub(crate) fn awaits_activation_for_ruby(partition: u64, handle: u32) -> bool {
    lock().existing(partition).and_then(|p| p.workers.get(&handle)).is_some_and(|w| w.lifecycle.step == Step::Activating)
}
// The worker `handle` is activating the registration at `scope`.
pub(crate) fn note_activating_for_ruby(partition: u64, scope: String, handle: u32) {
    lock().at(partition, &scope).activating = Some(handle);
}
// …and it is activated, the worker its navigations route to: whether no other registration had it already (a worker
// new to the host's routing).
pub(crate) fn activated_for_ruby(partition: u64, scope: String, handle: u32) -> bool {
    let mut reg = lock();
    let fresh = !reg.partition(partition).registrations.iter().any(|r| r.serving == Some(handle));
    let r = reg.registered(partition, &scope);
    r.serving = Some(handle);
    r.activating = None;
    fresh
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

    #[test]
    fn steps_a_version_from_installing_to_activated() {
        let p = partition_new_for_ruby();
        worker_new_for_ruby(p, 3, "a/sw.js".into(), "classic".into());
        assert_eq!(advance_for_ruby(p, 3, true), "done");
        begin_lifecycle_for_ruby(p, 3);
        assert_eq!(advance_for_ruby(p, 3, true), "updatefound");
        assert_eq!(advance_for_ruby(p, 3, true), "install");
        note_phase_for_ruby(p, 3, "install".into(), true);
        assert_eq!(advance_for_ruby(p, 3, true), "installed");
        assert!(awaits_activation_for_ruby(p, 3));
        assert_eq!(advance_for_ruby(p, 3, false), "try_activate");
        assert_eq!(advance_for_ruby(p, 3, true), "activating");
        assert_eq!(advance_for_ruby(p, 3, true), "activation");
        note_phase_for_ruby(p, 3, "activated".into(), true);
        assert_eq!(advance_for_ruby(p, 3, true), "activated");
        assert_eq!(advance_for_ruby(p, 3, true), "done");
        // A failed install ends it; a redundant worker takes no step.
        worker_new_for_ruby(p, 4, "a/sw.js".into(), "classic".into());
        begin_lifecycle_for_ruby(p, 4);
        assert_eq!(advance_for_ruby(p, 4, true), "updatefound");
        note_phase_for_ruby(p, 4, "install".into(), false);
        assert_eq!(advance_for_ruby(p, 4, true), "install_failed");
        assert_eq!(advance_for_ruby(p, 4, true), "done");
        worker_new_for_ruby(p, 5, "a/sw.js".into(), "classic".into());
        begin_lifecycle_for_ruby(p, 5);
        set_worker_state_for_ruby(p, 5, "redundant".into());
        assert_eq!(advance_for_ruby(p, 5, true), "done");
        clear_for_ruby(p);
    }

    #[test]
    fn keeps_a_registration_from_its_job_to_its_clear() {
        let p = partition_new_for_ruby();
        let id = note_registered_for_ruby(p, "a/".into());
        worker_new_for_ruby(p, 7, "a/sw.js".into(), "classic".into());
        set_version_for_ruby(p, id, "installing".into(), Some(7));
        note_activating_for_ruby(p, "a/".into(), 7);
        assert_eq!(registrations_for_ruby(p), [("a/".into(), true, Some(7), None, id)]);
        assert!(activated_for_ruby(p, "a/".into(), 7));
        assert!(!activated_for_ruby(p, "b/".into(), 7));
        set_navigation_preload_for_ruby(p, "a/".into(), Some(true), None);
        assert_eq!(navigation_preload_for_ruby(p, "a/".into()), (true, "true".into()));
        note_activating_for_ruby(p, "a/".into(), 8);
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
