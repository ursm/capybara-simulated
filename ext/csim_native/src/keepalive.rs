// Fetch "inflight keepalive bytes": each fetch group's total of the bodies its keepalive requests carry while they are in
// flight, which may not pass 64 KiB (Fetch "fetch" step 12.3: a keepalive request whose body would take it past is a
// network error). A fetch group is its environment's — a document's (each realm's of a session, the page's anew with each
// document it shows) or a worker's — so one's beacons spend none of another's quota. The host reserves a request's bytes
// as it starts it and lets them go as it ends, on whatever thread it ran.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex, MutexGuard};

// The quota of a fetch group (Fetch: 64 kibibytes).
const QUOTA: u64 = 64 * 1024;

// A fetch group's key: its session and the realm (a worker's: its handle, negated) whose environment it is.
type Key = (u64, i32);

// A fetch group: which of its realm's environments it is (`generation`, moved on as the realm shows another document) and
// its bytes in flight.
#[derive(Default)]
struct Group {
    generation: u64,
    inflight: u64,
}

#[derive(Default)]
struct Registry {
    // (…one counter for sessions, generations and tickets alike: each only needs to be unique)
    next: u64,
    // Each reservation's fetch group, the generation it was made in and its size, by the ticket it was given.
    tickets: HashMap<u64, (Key, u64, u64)>,
    groups: HashMap<Key, Group>,
}

static REGISTRY: LazyLock<Mutex<Registry>> = LazyLock::new(Default::default);
fn lock() -> MutexGuard<'static, Registry> {
    REGISTRY.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

// A keepalive request's `size` bytes reserved in the fetch group of realm `realm` of session `session`: its ticket, or
// None where they would take the group past its quota.
pub(crate) fn reserve(session: u64, realm: i32, size: u64) -> Option<u64> {
    let mut reg = lock();
    reg.next += 1;
    let ticket = reg.next;
    let group = reg.groups.entry((session, realm)).or_default();
    let total = group.inflight.checked_add(size).filter(|&t| t <= QUOTA)?;
    group.inflight = total;
    let generation = group.generation;
    reg.tickets.insert(ticket, ((session, realm), generation, size));
    Some(ticket)
}
// …let go as its request ends (a ticket let go already, cleared with its session, or of a document its realm no longer
// shows: nothing).
pub(crate) fn release(ticket: u64) {
    let mut reg = lock();
    let Some((key, generation, size)) = reg.tickets.remove(&ticket) else { return };
    if let Some(group) = reg.groups.get_mut(&key).filter(|g| g.generation == generation) {
        group.inflight = group.inflight.saturating_sub(size);
    }
}
// The fetch group of realm `realm` of `session` anew: the realm shows another document (the page on each top-level
// navigation), whose quota is its own — a request of the old one's still running lets nothing of it go as it ends.
pub(crate) fn retire(session: u64, realm: i32) {
    let mut reg = lock();
    reg.next += 1;
    let generation = reg.next;
    reg.groups.insert((session, realm), Group { generation, inflight: 0 });
}
// Every reservation of `session` let go (a test's reset, the window disposed): a request still running then spends
// nothing of the next one's quota as it ends.
pub(crate) fn clear(session: u64) {
    let mut reg = lock();
    reg.tickets.retain(|_, (key, _, _)| key.0 != session);
    reg.groups.retain(|key, _| key.0 != session);
}

// — for the host —
pub(crate) fn session_new_for_ruby() -> u64 {
    let mut reg = lock();
    reg.next += 1;
    reg.next
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fetch_group_spends_its_own_quota() {
        let session = session_new_for_ruby();
        let a = reserve(session, 0, 60 * 1024).unwrap();
        assert_eq!(reserve(session, 0, 5 * 1024), None);
        // (…another environment's group a quota of its own: a frame's, a worker's)
        assert!(reserve(session, 1, 60 * 1024).is_some());
        assert!(reserve(session, -1, 60 * 1024).is_some());
        release(a);
        release(a);
        assert!(reserve(session, 0, 64 * 1024).is_some());
        // (…a session cleared, its tickets let go: one released after spends nothing)
        clear(session);
        assert!(reserve(session, 0, 64 * 1024).is_some());
        // (…a group retired its next document's anew, the old one's ticket letting nothing of it go)
        let old = reserve(session, 2, 60 * 1024).unwrap();
        retire(session, 2);
        let new = reserve(session, 2, 60 * 1024).unwrap();
        release(old);
        assert_eq!(reserve(session, 2, 5 * 1024), None);
        release(new);
        assert!(reserve(session, 2, 5 * 1024).is_some());
        assert_eq!(reserve(session, 3, u64::MAX), None);
    }
}
