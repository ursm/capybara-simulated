// Fetch "inflight keepalive bytes": each fetch group's total of the bodies its keepalive requests carry while they are in
// flight, which may not pass 64 KiB (Fetch "fetch" step 12.3: a keepalive request whose body would take it past is a
// network error). A fetch group is its document's — each realm's of a session — so one document's beacons spend none of
// another's quota. The host reserves a request's bytes as it starts it and lets them go as it ends, on whatever thread
// it ran.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex, MutexGuard};

// The quota of a fetch group (Fetch: 64 kibibytes).
const QUOTA: u64 = 64 * 1024;

#[derive(Default)]
struct Registry {
    next: u64,
    // Each reservation's fetch group — its session and realm — and size, by the ticket it was given.
    tickets: HashMap<u64, ((u64, i32), u64)>,
    // Each fetch group's bytes in flight.
    inflight: HashMap<(u64, i32), u64>,
}

static REGISTRY: LazyLock<Mutex<Registry>> = LazyLock::new(Default::default);
fn lock() -> MutexGuard<'static, Registry> {
    REGISTRY.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

// A keepalive request's `size` bytes reserved in the fetch group of realm `realm` of session `session`: its ticket, or
// None where they would take the group past its quota.
pub(crate) fn reserve(session: u64, realm: i32, size: u64) -> Option<u64> {
    let mut reg = lock();
    let group = (session, realm);
    let inflight = reg.inflight.get(&group).copied().unwrap_or(0);
    if inflight + size > QUOTA {
        return None;
    }
    reg.next += 1;
    let ticket = reg.next;
    reg.inflight.insert(group, inflight + size);
    reg.tickets.insert(ticket, (group, size));
    Some(ticket)
}
// …let go as its request ends (a ticket let go already, or cleared with its session since, nothing).
pub(crate) fn release(ticket: u64) {
    let mut reg = lock();
    let Some((group, size)) = reg.tickets.remove(&ticket) else { return };
    if let Some(inflight) = reg.inflight.get_mut(&group) {
        *inflight = inflight.saturating_sub(size);
        if *inflight == 0 {
            reg.inflight.remove(&group);
        }
    }
}
// Every reservation of `session` let go (a test's reset, the window disposed): a request still running then spends
// nothing of the next one's quota as it ends.
pub(crate) fn clear(session: u64) {
    let mut reg = lock();
    reg.tickets.retain(|_, (group, _)| group.0 != session);
    reg.inflight.retain(|group, _| group.0 != session);
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
        // (…another document's group a quota of its own)
        assert!(reserve(session, 1, 60 * 1024).is_some());
        release(a);
        release(a);
        assert!(reserve(session, 0, 64 * 1024).is_some());
        // (…a session cleared, its tickets let go: one released after spends nothing)
        clear(session);
        assert!(reserve(session, 0, 64 * 1024).is_some());
    }
}
