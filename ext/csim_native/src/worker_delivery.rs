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

use std::collections::VecDeque;
use std::sync::{MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use magnus::{prelude::*, r_hash::ForEach, RArray, RHash, RString, Symbol, Value};

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

// ── The outbox ──
// What the workers post their window's host — from their own threads, any time — kept as plain data until the window's
// thread takes a drain of it (`outbox_take`): each its kind and its fields as the poster gave them, a hash of symbols to
// strings, numbers, booleans, lists and hashes, nothing of Ruby's kept (no object a GC could move or free).
#[derive(Clone, PartialEq)]
pub(crate) enum Datum {
    Nil,
    Bool(bool),
    Int(i64),
    Float(f64),
    // a string, and its encoding (an index, the process's)
    Str(Vec<u8>, magnus::encoding::Index),
    Sym(String),
    List(Vec<Datum>),
    Map(Vec<(Datum, Datum)>),
}

impl Datum {
    fn read(ruby: &magnus::Ruby, v: Value) -> Result<Datum, magnus::Error> {
        if v.is_nil() {
            return Ok(Datum::Nil);
        }
        if v.is_kind_of(ruby.class_true_class()) {
            return Ok(Datum::Bool(true));
        }
        if v.is_kind_of(ruby.class_false_class()) {
            return Ok(Datum::Bool(false));
        }
        if let Some(s) = RString::from_value(v) {
            return Ok(Datum::Str(crate::fetch_rules::ruby_bytes(s), s.enc_get()));
        }
        if let Some(sym) = Symbol::from_value(v) {
            return Ok(Datum::Sym(sym.name()?.into_owned()));
        }
        if v.is_kind_of(ruby.class_integer()) {
            // (…one past 64 bits no post carries: the posting code's bug, as below)
            return magnus::TryConvert::try_convert(v).map(Datum::Int).map_err(|_| magnus::Error::new(ruby.exception_arg_error(), "a worker's post can't carry an Integer past 64 bits"));
        }
        if v.is_kind_of(ruby.class_float()) {
            return Ok(Datum::Float(magnus::TryConvert::try_convert(v)?));
        }
        if let Some(a) = RArray::from_value(v) {
            return Ok(Datum::List(a.into_iter().map(|e| Datum::read(ruby, e)).collect::<Result<_, _>>()?));
        }
        if let Some(h) = RHash::from_value(v) {
            let mut pairs = Vec::new();
            h.foreach(|k: Value, e: Value| {
                pairs.push((Datum::read(ruby, k)?, Datum::read(ruby, e)?));
                Ok(ForEach::Continue)
            })?;
            return Ok(Datum::Map(pairs));
        }
        // (…what a post may carry is plain data; anything else is the posting code's bug, raised where it posts — the post
        // made none of)
        Err(magnus::Error::new(ruby.exception_arg_error(), format!("a worker's post can't carry a {}", unsafe { v.classname() })))
    }
    fn write(&self, ruby: &magnus::Ruby) -> Value {
        match self {
            Datum::Nil => ruby.qnil().as_value(),
            Datum::Bool(b) => if *b { ruby.qtrue().as_value() } else { ruby.qfalse().as_value() },
            Datum::Int(i) => ruby.integer_from_i64(*i).as_value(),
            Datum::Float(f) => ruby.float_from_f64(*f).as_value(),
            Datum::Str(bytes, encoding) => ruby.enc_str_new(bytes, *encoding).as_value(),
            Datum::Sym(name) => ruby.to_symbol(name).as_value(),
            Datum::List(items) => {
                let a = ruby.ary_new_capa(items.len());
                for item in items {
                    let _ = a.push(item.write(ruby));
                }
                a.as_value()
            }
            Datum::Map(pairs) => {
                let h = ruby.hash_new();
                for (k, v) in pairs {
                    let _ = h.aset(k.write(ruby), v.write(ruby));
                }
                h.as_value()
            }
        }
    }
    // A posted hash's `:kind`, as a string.
    fn kind(&self) -> String {
        let Datum::Map(pairs) = self else { return String::new() };
        pairs.iter().find(|(k, _)| *k == Datum::Sym("kind".into())).map_or_else(String::new, |(_, v)| match v {
            Datum::Str(bytes, _) => String::from_utf8_lossy(bytes).into_owned(),
            Datum::Sym(s) => s.clone(),
            _ => String::new(),
        })
    }
}

#[derive(Default)]
pub(crate) struct Outbox {
    posted: VecDeque<(String, Datum)>,
}

// How many posts there are, and whether any controller change is held — read with no lock by the window's checks every
// step (`outbox_empty?`, `changes_held?`), written under their locks.
#[derive(Default)]
pub(crate) struct Counts {
    posts: std::sync::atomic::AtomicUsize,
    held: std::sync::atomic::AtomicBool,
}

impl WorkerHost {
    fn outbox(&self) -> MutexGuard<'_, Outbox> {
        self.outbox.lock().unwrap_or_else(PoisonError::into_inner)
    }
    // #outbox_post(hash) — a worker's post, from any thread: the window's thread woken where it waits for one.
    fn outbox_post(ruby: &magnus::Ruby, rb_self: &Self, hash: RHash) -> Result<(), magnus::Error> {
        let datum = Datum::read(ruby, hash.as_value())?;
        let kind = datum.kind();
        let mut outbox = rb_self.outbox();
        outbox.posted.push_back((kind, datum));
        rb_self.counts.posts.store(outbox.posted.len(), std::sync::atomic::Ordering::Release);
        drop(outbox);
        rb_self.outbox_posted.notify_all();
        Ok(())
    }
    // #outbox_empty? -> whether nothing is posted.
    fn outbox_empty(&self) -> bool {
        self.counts.posts.load(std::sync::atomic::Ordering::Acquire) == 0
    }
    // #outbox_clear — every post let go of: the session's reset.
    fn outbox_clear(&self) {
        let mut outbox = self.outbox();
        outbox.posted.clear();
        self.counts.posts.store(0, std::sync::atomic::Ordering::Release);
    }
    // #outbox_wait(seconds) -> whether something is posted, waiting for it at most `seconds` with the GVL released (an
    // interrupt of the thread ending the wait at once).
    fn outbox_wait(&self, seconds: f64) -> bool {
        if !self.outbox_empty() {
            return true;
        }
        let deadline = Instant::now() + Duration::from_secs_f64(seconds.max(0.0));
        let cancel = std::sync::atomic::AtomicBool::new(false);
        let posted = self.without_gvl_interruptibly(&cancel, || {
            let mut outbox = self.outbox();
            loop {
                if !outbox.posted.is_empty() {
                    return true;
                }
                let left = deadline.saturating_duration_since(Instant::now());
                if left.is_zero() || cancel.load(std::sync::atomic::Ordering::Acquire) {
                    return false;
                }
                outbox = self.outbox_posted.wait_timeout(outbox, left).unwrap_or_else(PoisonError::into_inner).0;
            }
        });
        posted.unwrap_or_else(|| !self.outbox_empty())
    }
    // #outbox_take -> a drain of what is posted, in the order a delivery takes it (`delivery_plan`): `[group, [[post,
    // after_claim], …]]` for each group it has — nothing posted, none.
    fn outbox_take(ruby: &magnus::Ruby, rb_self: &Self) -> RArray {
        let drained: Vec<(String, Datum)> = {
            let mut outbox = rb_self.outbox();
            rb_self.counts.posts.store(0, std::sync::atomic::Ordering::Release);
            outbox.posted.drain(..).collect()
        };
        let plan = delivery_plan(drained.iter().map(|(kind, _)| kind.clone()).collect());
        let groups = ruby.ary_new_capa(plan.len());
        for (group, picks) in plan {
            let events = ruby.ary_new_capa(picks.len());
            for (i, after_claim) in picks {
                let _ = events.push((drained[i].1.write(ruby), after_claim));
            }
            let _ = groups.push((group, events));
        }
        groups
    }
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
            self.counts.held.store(true, std::sync::atomic::Ordering::Release);
        }
        Vec::new()
    }
    // #changes_held? -> whether any is held: work pending, which a settle steps for.
    fn changes_held(&self) -> bool {
        self.counts.held.load(std::sync::atomic::Ordering::Acquire)
    }
    // #changes_take -> those held, in the order held — `[claims, phases]` each — none held after.
    fn changes_take(&self) -> Vec<(Claims, Phases)> {
        let mut held = self.held();
        self.counts.held.store(false, std::sync::atomic::Ordering::Release);
        std::mem::take(&mut held.batches)
    }
}

pub(crate) fn define(class: magnus::RClass) -> Result<(), magnus::Error> {
    use magnus::{function, method, Module, Object};
    class.define_singleton_method("delivery_plan", function!(delivery_plan, 1))?;
    class.define_method("changes_hold", method!(WorkerHost::changes_hold, 2))?;
    class.define_method("changes_held?", method!(WorkerHost::changes_held, 0))?;
    class.define_method("changes_take", method!(WorkerHost::changes_take, 0))?;
    class.define_method("outbox_post", method!(WorkerHost::outbox_post, 1))?;
    class.define_method("<<", method!(WorkerHost::outbox_post, 1))?;
    class.define_method("outbox_empty?", method!(WorkerHost::outbox_empty, 0))?;
    class.define_method("outbox_clear", method!(WorkerHost::outbox_clear, 0))?;
    class.define_method("outbox_wait", method!(WorkerHost::outbox_wait, 1))?;
    class.define_method("outbox_take", method!(WorkerHost::outbox_take, 0))?;
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
