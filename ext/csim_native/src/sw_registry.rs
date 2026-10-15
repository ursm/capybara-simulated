// Service workers' registrations (Service Workers §2.2), one registry for the process: each driver browsing session's
// its own partition, in which a registration is named by its scope — whether a Register job made it (a registration
// object exists, its first worker maybe still installing), the worker that is activating it and the one that is
// active (each a worker's handle), its updateViaCache mode and its navigation preload state ({enabled, header value},
// which survives an update). The host reads it to route a navigation to its controller and to settle claims, the
// clients' registration objects read it, each in the order the registrations were made.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex, MutexGuard};

#[derive(Default)]
pub(crate) struct Registration {
    scope: String,
    registered: bool,
    activating: Option<u32>,
    active: Option<u32>,
    update_via_cache: Option<String>,
    preload_enabled: Option<bool>,
    preload_header: Option<String>,
}

#[derive(Default)]
struct Registry {
    partitions: HashMap<u64, Vec<Registration>>,
    next_partition: u64,
}

static REGISTRY: LazyLock<Mutex<Registry>> = LazyLock::new(|| Mutex::new(Registry::default()));

fn lock() -> MutexGuard<'static, Registry> {
    REGISTRY.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

impl Registry {
    // The registrations of `partition` — none for one gone (a reap or a read after its session ended makes it no
    // entry).
    fn list(&self, partition: u64) -> &[Registration] {
        self.partitions.get(&partition).map_or(&[], Vec::as_slice)
    }
    fn list_mut(&mut self, partition: u64) -> &mut [Registration] {
        self.partitions.get_mut(&partition).map_or(&mut [], Vec::as_mut_slice)
    }
    // The registration at `scope`, made where there is none.
    fn at(&mut self, partition: u64, scope: &str) -> &mut Registration {
        let list = self.partitions.entry(partition).or_default();
        let i = match list.iter().position(|r| r.scope == scope) {
            Some(i) => i,
            None => {
                list.push(Registration { scope: scope.to_owned(), ..Registration::default() });
                list.len() - 1
            }
        };
        &mut list[i]
    }
    // …which a Register job made: one made earlier only to hold its job's updateViaCache mode takes its place in the
    // registration order now, as the registration it then becomes (the job of one that failed left it behind).
    fn registered(&mut self, partition: u64, scope: &str) -> &mut Registration {
        self.at(partition, scope);
        let list = self.partitions.get_mut(&partition).expect("just made");
        let mut i = list.iter().position(|r| r.scope == scope).expect("just made");
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
// A session's registrations gone (its storage cleared, or the session ended).
pub(crate) fn clear_for_ruby(partition: u64) {
    lock().partitions.remove(&partition);
}
// Every registration of `partition`, in the order made: `[scope, registered, activating, active]`, a handle nil for none.
pub(crate) fn registrations_for_ruby(partition: u64) -> Vec<(String, bool, Option<u32>, Option<u32>)> {
    lock().list(partition).iter().map(|r| (r.scope.clone(), r.registered, r.activating, r.active)).collect()
}
// A Register job made the registration at `scope`.
pub(crate) fn note_registered_for_ruby(partition: u64, scope: String) {
    lock().registered(partition, &scope);
}
// The worker `handle` is activating the registration at `scope`.
pub(crate) fn note_activating_for_ruby(partition: u64, scope: String, handle: u32) {
    lock().at(partition, &scope).activating = Some(handle);
}
// …and it is active: whether no other registration had it active already (a worker new to the registry).
pub(crate) fn activated_for_ruby(partition: u64, scope: String, handle: u32) -> bool {
    let mut reg = lock();
    let fresh = !reg.list(partition).iter().any(|r| r.active == Some(handle));
    let r = reg.registered(partition, &scope);
    r.active = Some(handle);
    r.activating = None;
    fresh
}
// The registration at `scope` unregistered — gone from the map, its mode and navigation preload with it: whether there
// was one.
pub(crate) fn unregister_for_ruby(partition: u64, scope: String) -> bool {
    let mut reg = lock();
    let Some(list) = reg.partitions.get_mut(&partition) else { return false };
    let before = list.len();
    list.retain(|r| r.scope != scope);
    list.len() != before
}
// A worker gone: no registration has it active any more — at once, from whichever thread reaped it, so a navigation is
// routed to it no more.
pub(crate) fn forget_worker_for_ruby(partition: u64, handle: u32) {
    for r in lock().list_mut(partition).iter_mut().filter(|r| r.active == Some(handle)) {
        r.active = None;
    }
}
// …and one that never reached activated activates no registration any more — forgotten on the main thread, after the
// reap (a claim it made in between still finds its scope).
pub(crate) fn forget_activating_for_ruby(partition: u64, handle: u32) {
    for r in lock().list_mut(partition).iter_mut().filter(|r| r.activating == Some(handle)) {
        r.activating = None;
    }
}
// The registration's updateViaCache mode — nil where none was set — and setting it.
pub(crate) fn update_via_cache_for_ruby(partition: u64, scope: String) -> Option<String> {
    lock().list(partition).iter().find(|r| r.scope == scope).and_then(|r| r.update_via_cache.clone())
}
pub(crate) fn set_update_via_cache_for_ruby(partition: u64, scope: String, mode: String) {
    lock().at(partition, &scope).update_via_cache = Some(mode);
}
// Its navigation preload state: `[enabled, header value]`, the spec's default (false, "true") where none was set — and
// setting either (a nil one left as it is).
pub(crate) fn navigation_preload_for_ruby(partition: u64, scope: String) -> (bool, String) {
    let reg = lock();
    let r = reg.list(partition).iter().find(|r| r.scope == scope);
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
    fn keeps_a_registration_from_its_job_to_its_unregister() {
        let p = partition_new_for_ruby();
        note_registered_for_ruby(p, "a/".into());
        note_activating_for_ruby(p, "a/".into(), 7);
        assert_eq!(registrations_for_ruby(p), [("a/".into(), true, Some(7), None)]);
        assert!(activated_for_ruby(p, "a/".into(), 7));
        assert!(!activated_for_ruby(p, "b/".into(), 7));
        set_navigation_preload_for_ruby(p, "a/".into(), Some(true), None);
        assert_eq!(navigation_preload_for_ruby(p, "a/".into()), (true, "true".into()));
        forget_worker_for_ruby(p, 7);
        assert_eq!(registrations_for_ruby(p)[0], ("a/".into(), true, None, None));
        // A scope its job only set a mode on is no registration yet, and takes its place when one is made there.
        set_update_via_cache_for_ruby(p, "c/".into(), "all".into());
        note_registered_for_ruby(p, "b/".into());
        note_registered_for_ruby(p, "c/".into());
        let order: Vec<String> = registrations_for_ruby(p).into_iter().map(|r| r.0).collect();
        assert_eq!(order, ["a/", "b/", "c/"]);
        assert!(unregister_for_ruby(p, "a/".into()));
        assert!(!unregister_for_ruby(p, "a/".into()));
        assert_eq!(navigation_preload_for_ruby(p, "a/".into()), (false, "true".into()));
        clear_for_ruby(p);
        forget_worker_for_ruby(p, 7);
        assert!(lock().partitions.get(&p).is_none());
    }
}
