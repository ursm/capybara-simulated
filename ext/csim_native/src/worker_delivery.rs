// What a window's host does with what its workers posted it (browser.rb `deliver_worker_messages`), the engine's:
//
// - the ORDER a delivery takes a drain of the outbox in — by kind, a fixed order, each kind's in the order the workers
//   posted them: what changes routing first (a port's end taken or given up, so a port message in the same drain routes;
//   a client navigation only queued), then what changes a client's control (a claim, a lifecycle phase — held for the
//   window's next step), the lifecycle's wakeups, and then what reaches script: port and client messages, fetch answers,
//   stream frames, the replies that let go of what was owed, and the messages to the workers' owners;
// - which of those messages to a client come causally AFTER a claim — posted behind one in the outbox, or behind one held
//   from an earlier drain: `clients.claim()` sets each client's active worker before its promise resolves, so a message
//   sent after `await clients.claim()` finds its client controlled — the claims taken effect before it is delivered;
// - the controller changes held for the window's next step (a claim, a phase), in the order the workers made them, which
//   a step boundary of the window's event loop applies (V8Runtime#run_loop_step) — never a read or a command of the host's
//   that merely drained the outbox: a worker runs on its own thread, so when its claim reaches the outbox is a matter of
//   real time, not of the window's.

use std::sync::{MutexGuard, PoisonError};

use crate::worker_host::WorkerHost;

// The groups a delivery takes, in its order, and the kinds of each. A kind no group names is a message to a worker's owner
// (`message`, `__error`, `__scripterror`), the last group; `sw_job_event` is the job queue's, taken before (none here).
const GROUPS: &[(&str, &[&str])] = &[
    ("broadcast", &["broadcast"]),
    ("port_end", &["port_here", "port_gone", "port_closed", "port_redeliver"]),
    ("client_navigate", &["sw_client_navigate"]),
    ("claim", &["sw_claim"]),
    ("phase", &["sw_phase"]),
    ("reaped", &["sw_reaped"]),
    ("skip_waiting", &["sw_skip_waiting"]),
    ("try_activate", &["sw_try_activate"]),
    ("port_message", &["port_msg"]),
    ("client_message", &["sw_client_msg"]),
    ("fetch_response", &["fetch_response"]),
    ("stream_frame", &["fr_start", "fr_chunk", "fr_close", "fr_error"]),
    ("swack", &["swack"]),
    ("bcack", &["bcack"]),
];
const OWNER: &str = "message";
const SKIPPED: &str = "sw_job_event";
// The groups a claim comes causally before where it was posted first.
const AFTER_CLAIMS: [&str; 2] = ["port_message", "client_message"];

fn group_of(kind: &str) -> &'static str {
    GROUPS.iter().find(|(_, kinds)| kinds.contains(&kind)).map_or(OWNER, |(group, _)| group)
}

// WorkerHost.delivery_plan(kinds) -> `[group, [[index, after_claim], …]]` for each group a drain of the outbox whose kinds
// are `kinds` (in the order posted) has, in the order a delivery takes them: each one's events by their index in the
// drain, and — a port or client message — whether a claim was posted before it in the drain.
pub(crate) fn delivery_plan(kinds: Vec<String>) -> Vec<(&'static str, Vec<(usize, bool)>)> {
    let first_claim = kinds.iter().position(|k| k == "sw_claim");
    let order = GROUPS.iter().map(|(group, _)| *group).chain(std::iter::once(OWNER));
    let mut plan: Vec<(&'static str, Vec<(usize, bool)>)> = order.map(|g| (g, Vec::new())).collect();
    for (i, kind) in kinds.iter().enumerate() {
        if kind == SKIPPED {
            continue;
        }
        let group = group_of(kind);
        let after_claim = AFTER_CLAIMS.contains(&group) && first_claim.is_some_and(|c| i > c);
        if let Some((_, events)) = plan.iter_mut().find(|(g, _)| *g == group) {
            events.push((i, after_claim));
        }
    }
    plan.retain(|(_, events)| !events.is_empty());
    plan
}

// A claim held — its worker and whether it handles fetches — and a lifecycle phase — its worker, the phase, and its outcome.
type Claims = Vec<(u32, bool)>;
type Phases = Vec<(u32, String, bool)>;

#[derive(Default)]
pub(crate) struct HeldChanges {
    batches: Vec<(Claims, Phases)>,
}

impl WorkerHost {
    fn held(&self) -> MutexGuard<'_, HeldChanges> {
        self.held_changes.lock().unwrap_or_else(PoisonError::into_inner)
    }
    // #changes_hold(claims, phases) -> the phases to apply at once: a drain's claims and phases held for the window's next
    // step, in order, where it has a claim or something is held already — the phases ride with the claims, so a claim is
    // in place before the 'activated' after it is observable — else its phases, which nothing of the window's orders.
    fn changes_hold(&self, claims: Claims, phases: Phases) -> Phases {
        let mut held = self.held();
        if claims.is_empty() && held.batches.is_empty() {
            return phases;
        }
        if !(claims.is_empty() && phases.is_empty()) {
            held.batches.push((claims, phases));
        }
        Vec::new()
    }
    // #changes_held? -> whether any is held: work pending, which a settle steps for.
    fn changes_held(&self) -> bool {
        !self.held().batches.is_empty()
    }
    // #changes_take -> those held, in the order held — `[claims, phases]` each — none held after.
    fn changes_take(&self) -> Vec<(Claims, Phases)> {
        std::mem::take(&mut self.held().batches)
    }
}

pub(crate) fn define(class: magnus::RClass) -> Result<(), magnus::Error> {
    use magnus::{function, method, Module, Object};
    class.define_singleton_method("delivery_plan", function!(delivery_plan, 1))?;
    class.define_method("changes_hold", method!(WorkerHost::changes_hold, 2))?;
    class.define_method("changes_held?", method!(WorkerHost::changes_held, 0))?;
    class.define_method("changes_take", method!(WorkerHost::changes_take, 0))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan(kinds: &[&str]) -> Vec<(&'static str, Vec<(usize, bool)>)> {
        delivery_plan(kinds.iter().map(|k| (*k).to_owned()).collect())
    }

    #[test]
    fn a_drain_is_taken_in_the_order_of_its_groups_each_in_posted_order() {
        let p = plan(&["message", "fetch_response", "port_here", "sw_job_event", "broadcast", "fr_start", "fr_close", "__error", "bcack"]);
        assert_eq!(
            p,
            vec![
                ("broadcast", vec![(4, false)]),
                ("port_end", vec![(2, false)]),
                ("fetch_response", vec![(1, false)]),
                ("stream_frame", vec![(5, false), (6, false)]),
                ("bcack", vec![(8, false)]),
                ("message", vec![(0, false), (7, false)]),
            ]
        );
    }

    #[test]
    fn a_client_message_posted_after_a_claim_comes_after_it() {
        let p = plan(&["sw_client_msg", "sw_claim", "sw_client_msg", "port_msg", "sw_phase"]);
        assert_eq!(
            p,
            vec![
                ("claim", vec![(1, false)]),
                ("phase", vec![(4, false)]),
                ("port_message", vec![(3, true)]),
                ("client_message", vec![(0, false), (2, true)]),
            ]
        );
    }

    #[test]
    fn a_phase_is_held_behind_a_claim_and_applied_at_once_with_none() {
        let host = WorkerHost::new();
        assert_eq!(host.changes_hold(vec![], vec![(1, "install".into(), true)]), vec![(1, "install".to_owned(), true)]);
        assert!(!host.changes_held());
        assert!(host.changes_hold(vec![(1, true)], vec![]).is_empty());
        // (…a phase after a claim held rides behind it, though it came in a drain of its own)
        assert!(host.changes_hold(vec![], vec![(1, "activated".into(), true)]).is_empty());
        assert!(host.changes_held());
        assert_eq!(host.changes_take(), vec![(vec![(1, true)], vec![]), (vec![], vec![(1, "activated".to_owned(), true)])]);
        assert!(!host.changes_held());
    }
}
