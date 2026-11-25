// The agent record of each worker a window runs (HTML §10.2 "run a worker": its agent, its event loop, its global's
// owner set): what the window's event loop and the workers' own threads decide by, the engine's, behind one lock any of
// those threads takes —
//
// - what the worker IS: dedicated, shared or service, the worker that made it (a nested one's parent), the realm that
//   made it, its URL (its script's, after the redirects its main script's fetch followed);
// - its CLOCK, which follows the window's (one virtual time per agent cluster): where on the window's clock it stands,
//   moved on as the window's is and never back but with its window's (a refused context reset), its time origin, and
//   its next timer — so the window's event loop steps to the time a worker's timer falls due (`lockstep_next_at`);
// - the LOCKSTEP: each window step a worker's timer falls within ticks the worker and waits for its answer, a round
//   trip's budget at most — one that leaves a tick unanswered that long runs on its own until it answers one again
//   (`lagging`); a worker asked something by a sender whose step waits (`asked`) is due at once; one blocked waiting on
//   another worker's answer (`blocked`) is waited on no more, and one that answer let go on (`resuming`) is waited for
//   until it waits again;
// - Handle Fetch's waits IN PLACE: the requests a thread waits on a service worker's answer to (`took`, `answered`, the
//   worker's time at each), the waits that hold a window's event loop (`answering`, `awaited`), whether its `activate`
//   ran out, and whether its thread waits on the network — no hang, however long;
// - what it owes: the plain messages posted to it it may still answer (`in_flight`), and the BroadcastChannel names it
//   listens on.
//
// The host keeps the rest — the worker's thread, its inbox, its isolate — which are host I/O. A record goes as the
// worker leaves the window's registry (`worker_drop`): its thread, still running a moment, reads it gone as asked to
// stop, and what it writes after lands nowhere.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Condvar, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use crate::worker_host::WorkerHost;

// The real time a step of the window's waits for a worker running its script to answer its tick (and a request awaited
// in place, a reply the host holds the clock for): one that takes longer is left to run on its own.
pub(crate) const ROUND_TRIP_BUDGET: f64 = 1.0;
// …and a worker still BOOTING — its isolate built, its main script fetched — is waited for: no code of its own runs yet
// that could keep it, so only a hang reaches this.
pub(crate) const BOOT_GUARD: f64 = 10.0;
// The real time a worker at its inbox waits for a message before it catches its clock up to the window's.
pub(crate) const POLL_INTERVAL: f64 = 0.05;
// How far, in the worker's own time, a window waiting on it in place lets it run on.
pub(crate) const ANSWER_VIRTUAL_MS: f64 = 300_000.0;
// …and how far a sync request waiting for an activating worker to activate lets it run on (Handle Fetch's wait).
pub(crate) const ACTIVATION_IN_PLACE_MS: f64 = 1000.0;
// The slice a wait for a worker sleeps at most before it looks again: every change it waits on is told it, so this is a
// guard alone.
const WAIT_SLICE: Duration = Duration::from_millis(10);
// The `answering` key of a wait for the worker's activation (Handle Fetch), beside the fetch ids of the requests waited on.
const ACTIVATION: i64 = i64::MIN;

#[derive(Clone, Copy, PartialEq, Debug)]
enum Kind {
    Dedicated,
    Shared,
    Service,
}

impl Kind {
    fn parse(kind: &str) -> Kind {
        match kind {
            "shared" => Kind::Shared,
            "service" => Kind::Service,
            _ => Kind::Dedicated,
        }
    }
    fn name(self) -> &'static str {
        match self {
            Kind::Dedicated => "dedicated",
            Kind::Shared => "shared",
            Kind::Service => "service",
        }
    }
}

// Its thread: running from the moment it is made (its thread's first statement may come later, but a window's step waits
// for a booting worker, and a SharedWorker constructor finds one made in the same task), or ended (on its own, or
// terminated).
#[derive(Clone, Copy, PartialEq, Debug)]
enum Life {
    Running,
    Ended,
}

#[derive(Debug)]
pub(crate) struct Record {
    kind: Kind,
    parent: Option<i64>,
    realm: i64,
    url: String,
    life: Life,
    stopping: bool,
    // ── Its clock, on the window's ──
    // where it stands, and the window's clock as it last looked — the window's going back (a refused context reset's new
    // isolate) taking it back too
    now: f64,
    window_was: f64,
    // its time origin as it was made — its maker's `Date` then (none where the window had none), the agent `Date` scale's
    // shift its maker's, and the host's clock offset its maker's (agent_clock.rs)
    epoch: Option<f64>,
    shift: f64,
    travel: f64,
    // the ms from its clock to its next timer, as it last said (negative for none; none said yet), and when that is on the
    // window's clock
    next_timer: Option<f64>,
    next_timer_at: Option<f64>,
    // ── The lockstep ──
    asked: bool,
    lagging: bool,
    ticked: bool,
    blocked: u32,
    resuming: bool,
    awaiting: Option<i64>,
    running_since: Option<Instant>,
    // ── Handle Fetch's waits in place ──
    took: HashMap<i64, f64>,
    answered: HashMap<i64, f64>,
    answering: HashSet<i64>,
    awaited: u32,
    answer_until: Option<f64>,
    activate_done: bool,
    on_network: bool,
    // its inbox: the messages in it, and whether its thread waits on it now
    queued: usize,
    at_inbox: bool,
    // the requests of controlled clients it was sent while activating, parked until it activates: each `[request, fetch
    // id, realm]`
    parked: Vec<(String, i64, i64)>,
    // ── What it owes ──
    in_flight: usize,
    channels: HashMap<String, i64>,
}

impl Record {
    fn alive(&self) -> bool {
        self.life == Life::Running
    }
    // In the lockstep: alive, not blocked on another worker's answer, and not left lagging — but one whose answer came in
    // since, back in it.
    fn lockstep(&mut self) -> bool {
        if !self.alive() || self.blocked > 0 {
            return false;
        }
        if self.lagging && self.ticked {
            self.lagging = false;
        }
        !self.lagging
    }
    // The time, on the window's clock (`window` now), it is due at in the lockstep: its next timer's — or now, where it was
    // asked something whose sender's step waits on it, which no tick has followed yet: taken at the time it was asked.
    fn due_at(&mut self, window: f64) -> Option<f64> {
        if !self.lockstep() {
            return None;
        }
        if self.asked {
            return Some(window);
        }
        self.next_timer_at
    }
    fn timers_due(&self) -> bool {
        !self.stopping && self.next_timer.is_some_and(|t| t >= 0.0)
    }
    // A step of the window's waits for its answer to a tick sent at `start` until: one running its script a round trip's
    // budget from `start` — or from when it began to run, where that came later; one still booting BOOT_GUARD from it.
    fn deadline(&self, start: Instant) -> Instant {
        match self.running_since {
            Some(since) => start.max(since) + Duration::from_secs_f64(ROUND_TRIP_BUDGET),
            None => start + Duration::from_secs_f64(BOOT_GUARD),
        }
    }
    // Waiting on its inbox, which holds nothing.
    fn idle(&self) -> bool {
        self.at_inbox && self.queued == 0
    }
    // …with no timer set nor a socket or event stream it reads (`reading`): it can answer nothing more of its own accord.
    fn stalled(&self, reading: bool) -> bool {
        self.idle() && self.next_timer.is_some_and(|t| t < 0.0) && !reading
    }
    // Where a quiet poll of its inbox moves its clock to, the window's at `window`: on to its next timer at once while a
    // window waits on it inside its script (`answering`) — no further than such a wait lets it run — a poll interval of
    // real time on while one waits with its loop stopped (`awaited`), else the window's now.
    fn idle_to(&self, window: f64) -> f64 {
        if !self.answering.is_empty() {
            let next = self.now + self.next_timer.unwrap_or(0.0).max(0.0);
            return next.min(self.answer_until.unwrap_or(f64::INFINITY));
        }
        if self.awaited > 0 {
            return self.now + POLL_INTERVAL * 1000.0;
        }
        window
    }
}

#[derive(Default)]
pub(crate) struct Records {
    map: HashMap<i64, Record>,
}

impl WorkerHost {
    fn records(&self) -> MutexGuard<'_, Records> {
        self.records.lock().unwrap_or_else(PoisonError::into_inner)
    }
    // `f` of worker `handle`'s record, `none` where it has none.
    fn with<R>(&self, handle: i64, none: R, f: impl FnOnce(&mut Record) -> R) -> R {
        match self.records().map.get_mut(&handle) {
            Some(r) => f(r),
            None => none,
        }
    }
    // …and every thread waiting on a change of the records told one came.
    fn stir<R>(&self, handle: i64, none: R, f: impl FnOnce(&mut Record) -> R) -> R {
        let r = self.with(handle, none, f);
        self.stirred.notify_all();
        r
    }

    // ── What it is ──
    // #worker_new(handle, kind, parent, realm, url, at, window, epoch, shift, travel) — a worker made: `kind` "dedicated",
    // "shared" or "service", its parent worker (nil for none) and making realm, its URL, the window's time it was made at
    // (its clock starts there, and it is due then: a booting worker runs its script before the window steps past it) and
    // the window's clock as its last step left it (which `at`, a task's time, may be ahead of: no going back), and its time
    // origin's epoch (nil for none), shift and travel.
    #[allow(clippy::too_many_arguments)]
    fn worker_new(&self, handle: i64, kind: String, parent: Option<i64>, realm: i64, url: String, at: f64, window: f64, epoch: Option<f64>, shift: f64, travel: f64) {
        let record = Record {
            kind: Kind::parse(&kind),
            parent,
            realm,
            url,
            life: Life::Running,
            stopping: false,
            now: at,
            window_was: window,
            epoch,
            shift,
            travel,
            next_timer: None,
            next_timer_at: Some(at),
            asked: false,
            lagging: false,
            ticked: false,
            blocked: 0,
            resuming: false,
            awaiting: None,
            running_since: None,
            took: HashMap::new(),
            answered: HashMap::new(),
            answering: HashSet::new(),
            awaited: 0,
            answer_until: None,
            activate_done: false,
            on_network: false,
            queued: 0,
            at_inbox: false,
            parked: Vec::new(),
            in_flight: 0,
            channels: HashMap::new(),
        };
        self.records().map.insert(handle, record);
    }
    // #worker_drop(handle) -> `[kind, posts, parked]`: what it was, the plain messages posted to it it never answered,
    // which the host lets go of, and the requests parked on its activation, which the network answers now — its record
    // gone; nil for none.
    #[allow(clippy::type_complexity)]
    fn worker_drop(&self, handle: i64) -> Option<(&'static str, usize, Vec<(String, i64, i64)>)> {
        let gone = self.records().map.remove(&handle);
        self.stirred.notify_all();
        gone.map(|r| (r.kind.name(), r.in_flight, r.parked))
    }
    // #workers_clear — every record gone: the session's reset.
    fn workers_clear(&self) {
        self.records().map.clear();
        self.stirred.notify_all();
    }
    // #worker_kind(handle) -> "dedicated", "shared" or "service"; nil for none.
    fn worker_kind(&self, handle: i64) -> Option<&'static str> {
        self.with(handle, None, |r| Some(r.kind.name()))
    }
    // #worker_parent(handle) -> the worker that made it, nil for none.
    fn worker_parent(&self, handle: i64) -> Option<i64> {
        self.with(handle, None, |r| r.parent)
    }
    // #worker_realm(handle) -> the realm that made it (0 for a nested one's).
    fn worker_realm(&self, handle: i64) -> i64 {
        self.with(handle, 0, |r| r.realm)
    }
    // #worker_children(handle) -> the workers it made.
    fn worker_children(&self, handle: i64) -> Vec<i64> {
        self.records().map.iter().filter(|(_, r)| r.parent == Some(handle)).map(|(h, _)| *h).collect()
    }
    // #worker_url(handle) / #worker_url_set(handle, url) — its URL: its script's, after the redirects its fetch followed.
    fn worker_url(&self, handle: i64) -> Option<String> {
        self.with(handle, None, |r| Some(r.url.clone()))
    }
    fn worker_url_set(&self, handle: i64, url: String) {
        self.with(handle, (), |r| r.url = url);
    }
    // #worker_epoch(handle) -> its time origin as it was made, `[epoch, shift, travel]`; nil for one with no epoch.
    fn worker_epoch(&self, handle: i64) -> Option<(f64, f64, f64)> {
        self.with(handle, None, |r| r.epoch.map(|e| (e, r.shift, r.travel)))
    }

    // ── Its thread ──
    // #worker_ended(handle) — its thread ended, on its own or terminated; its timers none.
    fn worker_ended(&self, handle: i64) {
        self.stir(handle, (), |r| {
            r.life = Life::Ended;
            r.next_timer = Some(-1.0);
            r.next_timer_at = None;
        });
    }
    // #worker_script_began(handle) — booted: its script runs from now, what a window's wait on it is counted against.
    fn worker_script_began(&self, handle: i64) {
        self.stir(handle, (), |r| r.running_since = Some(Instant::now()));
    }
    // #worker_ran_for(handle) -> the real seconds since its script began to run; nil while it boots.
    fn worker_ran_for(&self, handle: i64) -> Option<f64> {
        self.with(handle, None, |r| r.running_since.map(|s| s.elapsed().as_secs_f64()))
    }
    // #worker_alive?(handle) -> whether its thread runs.
    fn worker_alive(&self, handle: i64) -> bool {
        self.with(handle, false, |r| r.alive())
    }
    // #worker_gone?(handle) -> whether its thread ended, or it left the window's registry: it answers nothing more.
    fn worker_gone(&self, handle: i64) -> bool {
        self.with(handle, true, |r| r.life == Life::Ended)
    }
    // #worker_stop(handle) — the session boundary asked it to stop; #worker_stopping?(handle) — whether it was, or it is
    // gone from the window's registry.
    fn worker_stop(&self, handle: i64) {
        self.stir(handle, (), |r| r.stopping = true);
    }
    fn worker_stopping(&self, handle: i64) -> bool {
        self.with(handle, true, |r| r.stopping)
    }

    // ── Its clock ──
    // #worker_clock_step(handle, to, window) -> the ms its clock moved on to `to`, never back — but back to the window's
    // where the window's (now `window`) went back.
    fn worker_clock_step(&self, handle: i64, to: f64, window: f64) -> f64 {
        self.with(handle, 0.0, |r| {
            if window < r.window_was {
                r.now = window;
            }
            r.window_was = window;
            let to = to.max(r.now);
            let moved = to - r.now;
            r.now = to;
            moved
        })
    }
    // #worker_now(handle) -> where on the window's clock it stands; nil for none.
    fn worker_now(&self, handle: i64) -> Option<f64> {
        self.with(handle, None, |r| Some(r.now))
    }
    // #worker_timers_left(handle, next_timer, ticked) — its loop came round: the ms to its next timer (negative for none),
    // and whether the tick it just ran answers the window's — which a step waits on.
    fn worker_timers_left(&self, handle: i64, next_timer: f64, ticked: bool) {
        self.stir(handle, (), |r| {
            r.next_timer = Some(next_timer);
            r.next_timer_at = (next_timer >= 0.0).then(|| r.now + next_timer);
            if ticked {
                r.ticked = true;
            }
        });
    }
    // #worker_at_inbox(handle) -> the real seconds it waits on its inbox for: none at all while a window waits inside its
    // script on its answer and it has a timer to run — its time going as fast as its own work — else a poll interval. Waiting
    // there, it is no worker a window's step waits for (`resuming`).
    fn worker_at_inbox(&self, handle: i64) -> f64 {
        self.stir(handle, POLL_INTERVAL, |r| {
            r.resuming = false;
            r.at_inbox = true;
            if !r.answering.is_empty() && r.timers_due() { 0.0 } else { POLL_INTERVAL }
        })
    }
    // #worker_off_inbox(handle, took) — its thread back from its inbox, a message taken (`took`) or none.
    fn worker_off_inbox(&self, handle: i64, took: bool) {
        self.with(handle, (), |r| {
            r.at_inbox = false;
            if took {
                r.queued = r.queued.saturating_sub(1);
            }
        });
    }
    // #inbox_queued(handle) — a message put in its inbox (before it is: the count never short of what is in it).
    fn inbox_queued(&self, handle: i64) {
        self.with(handle, (), |r| r.queued += 1);
    }
    // #worker_idle?(handle) -> whether it waits on its inbox, which holds nothing.
    fn worker_idle(&self, handle: i64) -> bool {
        self.with(handle, false, |r| r.idle())
    }
    // #inbox_pending? -> whether a live worker has a message in its inbox it has not taken.
    fn inbox_pending(&self) -> bool {
        self.records().map.values().any(|r| r.alive() && r.queued > 0)
    }
    // #sw_parked?(reading) -> whether every live service worker waits on its inbox, which holds nothing, with nothing read
    // for it off its thread — none of `reading`, the workers a socket's or an event stream's reader pushes into.
    fn sw_parked(&self, reading: Vec<i64>) -> bool {
        self.records().map.iter().all(|(h, r)| r.kind != Kind::Service || !r.alive() || (r.idle() && !reading.contains(h)))
    }
    // #worker_idle_to(handle, window) -> where a quiet poll of its inbox moves its clock to (`Record::idle_to`).
    fn worker_idle_to(&self, handle: i64, window: f64) -> f64 {
        self.with(handle, window, |r| r.idle_to(window))
    }
    // #worker_timers_pending? -> whether a worker not asked to stop has a timer set.
    fn worker_timers_pending(&self) -> bool {
        self.records().map.values().any(Record::timers_due)
    }
    // #worker_next_timer -> the ms until the soonest of them, -1 for none.
    fn worker_next_timer(&self) -> f64 {
        self.records().map.values().filter(|r| r.timers_due()).filter_map(|r| r.next_timer).reduce(f64::min).unwrap_or(-1.0)
    }
    // #sw_next_timer_at -> the soonest time, on the window's clock, a live service worker has a timer set for; nil for none.
    fn sw_next_timer_at(&self) -> Option<f64> {
        self.records().map.values().filter(|r| r.kind == Kind::Service && r.alive()).filter_map(|r| r.next_timer_at).reduce(f64::min)
    }

    // ── The lockstep ──
    // #worker_asked(handle) — asked something whose sender's step waits on it: due at once, taken at the time it was asked.
    fn worker_asked(&self, handle: i64) {
        self.with(handle, (), |r| r.asked = true);
    }
    // #lockstep_next_at(window) -> the soonest time, on the window's clock (now `window`), a worker in the lockstep is due at;
    // nil for none.
    fn lockstep_next_at(&self, window: f64) -> Option<f64> {
        self.records().map.values_mut().filter_map(|r| r.due_at(window)).reduce(f64::min)
    }
    // #lockstep_due(now) -> the workers due by `now`, each to be ticked — behind what it was asked, which the tick's answer
    // covers.
    fn lockstep_due(&self, now: f64) -> Vec<i64> {
        let mut records = self.records();
        let mut due = Vec::new();
        for (handle, r) in &mut records.map {
            if r.due_at(now).is_some_and(|at| at <= now) {
                r.ticked = false;
                r.asked = false;
                due.push(*handle);
            }
        }
        due
    }
    // #lockstep_await(handles, ago) — the ticks those were sent, at a pass of the window's that began `ago` seconds ago,
    // waited for: each one that does not answer in time (`Record::deadline`) left lagging — but one blocked meanwhile on
    // another worker's answer, which waits on the window, counted as answered — then every worker an answer let go on
    // (`resuming`) waited for, until it waits again. With the GVL released: the workers' threads run meanwhile.
    // An interrupt of the waiting thread (Thread#raise, Timeout, a signal) ends the wait at once: Ruby's unblocking function
    // flags it and wakes the condition variable (`without_gvl_interruptibly`), the ticks not answered by then left as they
    // are.
    fn lockstep_await(&self, handles: Vec<i64>, ago: f64) {
        let start = Instant::now().checked_sub(Duration::from_secs_f64(ago.max(0.0))).unwrap_or_else(Instant::now);
        let cancel = AtomicBool::new(false);
        self.without_gvl_interruptibly(&cancel, || self.lockstep_wait(handles, start, &cancel));
    }
    // `f` run with the GVL released, `cancel` set and every wait on the records woken where Ruby interrupts the thread.
    pub(crate) fn without_gvl_interruptibly<F: FnOnce() -> R, R>(&self, cancel: &AtomicBool, f: F) -> R {
        struct Job<'a, F, R> {
            f: Option<F>,
            r: Option<R>,
            host: &'a WorkerHost,
            cancel: &'a AtomicBool,
        }
        unsafe extern "C" fn run<F: FnOnce() -> R, R>(data: *mut std::ffi::c_void) -> *mut std::ffi::c_void {
            // SAFETY: `data` is the `Job` below, alive for the call.
            let job = unsafe { &mut *data.cast::<Job<'_, F, R>>() };
            job.r = Some((job.f.take().expect("run once"))());
            std::ptr::null_mut()
        }
        unsafe extern "C" fn unblock<F, R>(data: *mut std::ffi::c_void) {
            // SAFETY: the same `Job`, alive while the call it unblocks runs; only its shared parts are touched.
            let job = unsafe { &*data.cast::<Job<'_, F, R>>() };
            job.cancel.store(true, Ordering::Release);
            // (…under each lock, so a waiter between its check and its wait cannot miss the wakeup)
            drop(job.host.records());
            job.host.stirred.notify_all();
            drop(job.host.outbox.lock());
            job.host.outbox_posted.notify_all();
        }
        let mut job = Job { f: Some(f), r: None, host: self, cancel };
        let data = (&raw mut job).cast();
        // SAFETY: `run` and `unblock` are handed their own `Job`, and touch no Ruby object.
        unsafe {
            rb_sys::rb_thread_call_without_gvl(Some(run::<F, R>), data, Some(unblock::<F, R>), data);
        }
        job.r.expect("the job ran")
    }
    fn lockstep_wait(&self, handles: Vec<i64>, start: Instant, cancel: &AtomicBool) {
        let cancelled = || cancel.load(Ordering::Acquire);
        {
            let mut records = self.records();
            for handle in handles {
                if cancelled() {
                    return;
                }
                let answered = loop {
                    if cancelled() {
                        return;
                    }
                    let Some(r) = records.map.get_mut(&handle) else { break false };
                    if !r.alive() {
                        break false;
                    }
                    if r.blocked > 0 {
                        break true;
                    }
                    if r.ticked {
                        r.ticked = false;
                        break true;
                    }
                    let left = r.deadline(start).saturating_duration_since(Instant::now());
                    if left.is_zero() {
                        break false;
                    }
                    records = self.stirred.wait_timeout(records, left.min(WAIT_SLICE)).unwrap_or_else(PoisonError::into_inner).0;
                };
                if let Some(r) = records.map.get_mut(&handle) {
                    r.lagging = !answered;
                }
            }
            loop {
                if cancelled() {
                    return;
                }
                let now = Instant::now();
                let waiting = records.map.values().filter(|r| r.resuming && !r.lagging && r.alive()).map(|r| r.deadline(start)).filter(|d| *d > now).min();
                let Some(deadline) = waiting else { break };
                records = self.stirred.wait_timeout(records, (deadline - now).min(WAIT_SLICE)).unwrap_or_else(PoisonError::into_inner).0;
            }
        }
    }
    // #resuming? -> whether a worker an answer let go on is still at work on it, in the lockstep.
    fn is_resuming(&self) -> bool {
        self.records().map.values().any(|r| r.resuming && !r.lagging && r.alive())
    }
    // #awaits_worker? -> whether a worker waits in place on another worker's answer — one the window's steps bring.
    fn awaits_worker(&self) -> bool {
        self.records().map.values().any(|r| r.blocked > 0)
    }

    // ── Handle Fetch's waits in place ──
    // #worker_blocked(handle, fetch_id) — worker `handle`'s thread waits in place for another worker's answer to
    // `fetch_id` (a main script, a sync XHR): blocked meanwhile, its timers unable to run, no worker the window's steps
    // wait on; #worker_unblocked(handle) — …no more.
    fn worker_blocked(&self, handle: i64, fetch_id: i64) {
        self.stir(handle, (), |r| {
            r.blocked += 1;
            r.resuming = false;
            r.awaiting = Some(fetch_id);
        });
    }
    fn worker_unblocked(&self, handle: i64) {
        self.stir(handle, (), |r| {
            r.awaiting = None;
            r.blocked = r.blocked.saturating_sub(1);
        });
    }
    // #resume_awaiting(fetch_id) — the answer to `fetch_id` is out: the worker waiting on it let go on (`resuming`), which a
    // step of the window's waits for.
    fn resume_awaiting(&self, fetch_id: i64) {
        let mut records = self.records();
        for r in records.map.values_mut() {
            if r.awaiting == Some(fetch_id) {
                r.resuming = true;
            }
        }
        drop(records);
        self.stirred.notify_all();
    }
    // #wait_begin(worker, fetch_id, stops_window, by_window) — a thread waits in place for `worker`'s answer to
    // `fetch_id`: a window's (`by_window`) — whose event loop, where the wait holds it up (`stops_window`), runs nothing
    // meanwhile: the worker's time runs on for it, to its next timer at once, until its answer is out — or a worker's.
    fn wait_begin(&self, worker: i64, fetch_id: i64, stops_window: bool, by_window: bool) {
        if !by_window {
            return;
        }
        self.stir(worker, (), |r| {
            r.awaited += 1;
            if stops_window {
                r.answering.insert(fetch_id);
            }
        });
    }
    // #wait_spent(worker, fetch_id, answered) -> the worker's time spent on it so far, from when it took the request — to its
    // answer where that is out (`answered`); nil before it took it.
    fn wait_spent(&self, worker: i64, fetch_id: i64, answered: bool) -> Option<f64> {
        self.with(worker, None, |r| {
            let took = *r.took.get(&fetch_id)?;
            let at = if answered { r.answered.get(&fetch_id).copied().unwrap_or(r.now) } else { r.now };
            Some(at - took)
        })
    }
    // #wait_end(worker, fetch_id, limit, by_window) -> `[moved, follow]`: the wait over, the worker's time it took (no more
    // than `limit`) — and, a window's wait the worker's last, the time on the window's clock its window follows it to.
    fn wait_end(&self, worker: i64, fetch_id: i64, limit: f64, by_window: bool) -> (f64, Option<f64>) {
        self.stir(worker, (0.0, None), |r| {
            let took = r.took.remove(&fetch_id);
            let answered = r.answered.remove(&fetch_id);
            let moved = took.map_or(0.0, |t| (answered.unwrap_or(r.now) - t).clamp(0.0, limit));
            r.answering.remove(&fetch_id);
            let mut follow = None;
            if by_window {
                r.awaited = r.awaited.saturating_sub(1);
                follow = (r.awaited == 0).then_some(r.now);
            }
            (moved, follow)
        })
    }
    // #worker_stalled?(handle, reading) -> `Record::stalled`.
    fn worker_stalled(&self, handle: i64, reading: bool) -> bool {
        self.with(handle, false, |r| r.stalled(reading))
    }
    // #on_network(handle, on) / #on_network?(handle) — its thread waits on the network, its own fetch's: no hang.
    fn on_network(&self, handle: i64, on: bool) {
        self.with(handle, (), |r| r.on_network = on);
    }
    fn is_on_network(&self, handle: i64) -> bool {
        self.with(handle, false, |r| r.on_network)
    }
    // #fetch_taken(handle, fetch_id) — it took a request a thread waits on in place, at its time now: what the wait counts
    // from.
    fn fetch_taken(&self, handle: i64, fetch_id: i64) {
        self.with(handle, (), |r| {
            r.took.insert(fetch_id, r.now);
        });
    }
    // #answered_in_place(handle, fetch_id) — it answered one: its own time back on the window's; the answer's time what its
    // waiter counts to.
    fn answered_in_place(&self, handle: i64, fetch_id: i64) {
        self.stir(handle, (), |r| {
            r.answering.remove(&fetch_id);
            if r.took.contains_key(&fetch_id) {
                r.answered.insert(fetch_id, r.now);
            }
        });
    }
    // #activation_wait_begin(handle) -> its time now: a sync request waits in place for its activation (Handle Fetch), its
    // time running on for it to its next timer at once, no further than ACTIVATION_IN_PLACE_MS.
    fn activation_wait_begin(&self, handle: i64) -> f64 {
        self.with(handle, 0.0, |r| {
            r.answer_until = Some(r.now + ACTIVATION_IN_PLACE_MS);
            r.awaited += 1;
            r.answering.insert(ACTIVATION);
            r.now
        })
    }
    // #activation_wait(handle, began, reading) -> what the wait comes to at a poll: "activated", "wait",
    // "stalled" (it can do nothing more of its own), or "give up" — its thread gone, or ACTIVATION_IN_PLACE_MS of its time
    // gone since `began`.
    fn activation_wait(&self, handle: i64, began: f64, reading: bool) -> &'static str {
        self.with(handle, "give up", |r| {
            if r.activate_done {
                "activated"
            } else if !r.alive() || r.now - began >= ACTIVATION_IN_PLACE_MS {
                "give up"
            } else if r.stalled(reading) {
                "stalled"
            } else {
                "wait"
            }
        })
    }
    // #activation_wait_end(handle, began) -> [activated, the worker's time the wait took].
    fn activation_wait_end(&self, handle: i64, began: f64) -> (bool, f64) {
        self.stir(handle, (false, 0.0), |r| {
            r.answering.remove(&ACTIVATION);
            r.answer_until = None;
            r.awaited = r.awaited.saturating_sub(1);
            (r.activate_done, r.now - began)
        })
    }
    // #fetch_parked(handle, partition, request, fetch_id, realm) -> whether a controlled client's request to it is parked
    // until it activates (Handle Fetch: "If activeWorker's state is activating, wait for activeWorker's state to become
    // activated") — not where the registry of `partition` has it activated already. Decided under the records' lock, which
    // taking what is parked takes too: the activation's flush (`fetches_unparked`) comes after the registry notes it, so a
    // request is either parked before the flush takes the list, or sees the worker activated.
    fn fetch_parked(&self, handle: i64, partition: u64, request: String, fetch_id: i64, realm: i64) -> bool {
        let mut records = self.records();
        let Some(r) = records.map.get_mut(&handle) else { return false };
        if crate::sw_registry::worker_activated_for_ruby(partition, handle as u32) {
            return false;
        }
        r.parked.push((request, fetch_id, realm));
        true
    }
    // #fetches_unparked(handle) -> the requests parked on its activation, `[request, fetch id, realm]` each, taken.
    fn fetches_unparked(&self, handle: i64) -> Vec<(String, i64, i64)> {
        self.with(handle, Vec::new(), |r| std::mem::take(&mut r.parked))
    }
    // #worker_activate_done(handle) — its `activate` event's lifetime promises settled, at its time.
    fn worker_activate_done(&self, handle: i64) {
        self.stir(handle, (), |r| r.activate_done = true);
    }

    // ── What it owes ──
    // #worker_posted(handle) — a plain message posted to it, which it may answer; #worker_posts_answered(handles) — one
    // answered by each.
    fn worker_posted(&self, handle: i64) {
        self.with(handle, (), |r| r.in_flight += 1);
    }
    fn worker_posts_answered(&self, handles: Vec<i64>) {
        let mut records = self.records();
        for handle in handles {
            if let Some(r) = records.map.get_mut(&handle) {
                r.in_flight = r.in_flight.saturating_sub(1);
            }
        }
    }
    // #bc_listen(handle, name, delta) — its BroadcastChannels of `name`, `delta` more of them; #bc_listening?(handle, name)
    // -> whether it has one.
    fn bc_listen(&self, handle: i64, name: String, delta: i64) {
        self.with(handle, (), |r| *r.channels.entry(name).or_default() += delta);
    }
    fn bc_listening(&self, handle: i64, name: String) -> bool {
        self.with(handle, false, |r| r.channels.get(&name).is_some_and(|n| *n > 0))
    }
}

pub(crate) fn new_records() -> (std::sync::Mutex<Records>, Condvar) {
    (std::sync::Mutex::new(Records::default()), Condvar::new())
}

pub(crate) fn define(class: magnus::RClass) -> Result<(), magnus::Error> {
    use magnus::{method, Module};
    class.const_set("ROUND_TRIP_BUDGET", ROUND_TRIP_BUDGET)?;
    class.const_set("BOOT_GUARD", BOOT_GUARD)?;
    class.const_set("POLL_INTERVAL", POLL_INTERVAL)?;
    class.const_set("ANSWER_VIRTUAL_MS", ANSWER_VIRTUAL_MS)?;
    class.define_method("worker_new", method!(WorkerHost::worker_new, 10))?;
    class.define_method("worker_drop", method!(WorkerHost::worker_drop, 1))?;
    class.define_method("workers_clear", method!(WorkerHost::workers_clear, 0))?;
    class.define_method("worker_kind", method!(WorkerHost::worker_kind, 1))?;
    class.define_method("worker_parent", method!(WorkerHost::worker_parent, 1))?;
    class.define_method("worker_realm", method!(WorkerHost::worker_realm, 1))?;
    class.define_method("worker_children", method!(WorkerHost::worker_children, 1))?;
    class.define_method("worker_url", method!(WorkerHost::worker_url, 1))?;
    class.define_method("worker_url_set", method!(WorkerHost::worker_url_set, 2))?;
    class.define_method("worker_epoch", method!(WorkerHost::worker_epoch, 1))?;
    class.define_method("worker_ended", method!(WorkerHost::worker_ended, 1))?;
    class.define_method("worker_script_began", method!(WorkerHost::worker_script_began, 1))?;
    class.define_method("worker_ran_for", method!(WorkerHost::worker_ran_for, 1))?;
    class.define_method("worker_alive?", method!(WorkerHost::worker_alive, 1))?;
    class.define_method("worker_gone?", method!(WorkerHost::worker_gone, 1))?;
    class.define_method("worker_stop", method!(WorkerHost::worker_stop, 1))?;
    class.define_method("worker_stopping?", method!(WorkerHost::worker_stopping, 1))?;
    class.define_method("worker_clock_step", method!(WorkerHost::worker_clock_step, 3))?;
    class.define_method("worker_now", method!(WorkerHost::worker_now, 1))?;
    class.define_method("worker_timers_left", method!(WorkerHost::worker_timers_left, 3))?;
    class.define_method("worker_at_inbox", method!(WorkerHost::worker_at_inbox, 1))?;
    class.define_method("worker_idle_to", method!(WorkerHost::worker_idle_to, 2))?;
    class.define_method("worker_off_inbox", method!(WorkerHost::worker_off_inbox, 2))?;
    class.define_method("inbox_queued", method!(WorkerHost::inbox_queued, 1))?;
    class.define_method("worker_idle?", method!(WorkerHost::worker_idle, 1))?;
    class.define_method("inbox_pending?", method!(WorkerHost::inbox_pending, 0))?;
    class.define_method("sw_parked?", method!(WorkerHost::sw_parked, 1))?;
    class.define_method("worker_timers_pending?", method!(WorkerHost::worker_timers_pending, 0))?;
    class.define_method("worker_next_timer", method!(WorkerHost::worker_next_timer, 0))?;
    class.define_method("sw_next_timer_at", method!(WorkerHost::sw_next_timer_at, 0))?;
    class.define_method("worker_asked", method!(WorkerHost::worker_asked, 1))?;
    class.define_method("lockstep_next_at", method!(WorkerHost::lockstep_next_at, 1))?;
    class.define_method("lockstep_due", method!(WorkerHost::lockstep_due, 1))?;
    class.define_method("lockstep_await", method!(WorkerHost::lockstep_await, 2))?;
    class.define_method("resuming?", method!(WorkerHost::is_resuming, 0))?;
    class.define_method("awaits_worker?", method!(WorkerHost::awaits_worker, 0))?;
    class.define_method("worker_blocked", method!(WorkerHost::worker_blocked, 2))?;
    class.define_method("worker_unblocked", method!(WorkerHost::worker_unblocked, 1))?;
    class.define_method("resume_awaiting", method!(WorkerHost::resume_awaiting, 1))?;
    class.define_method("wait_begin", method!(WorkerHost::wait_begin, 4))?;
    class.define_method("wait_spent", method!(WorkerHost::wait_spent, 3))?;
    class.define_method("wait_end", method!(WorkerHost::wait_end, 4))?;
    class.define_method("worker_stalled?", method!(WorkerHost::worker_stalled, 2))?;
    class.define_method("on_network", method!(WorkerHost::on_network, 2))?;
    class.define_method("on_network?", method!(WorkerHost::is_on_network, 1))?;
    class.define_method("fetch_taken", method!(WorkerHost::fetch_taken, 2))?;
    class.define_method("answered_in_place", method!(WorkerHost::answered_in_place, 2))?;
    class.define_method("activation_wait_begin", method!(WorkerHost::activation_wait_begin, 1))?;
    class.define_method("activation_wait", method!(WorkerHost::activation_wait, 3))?;
    class.define_method("activation_wait_end", method!(WorkerHost::activation_wait_end, 2))?;
    class.define_method("fetch_parked", method!(WorkerHost::fetch_parked, 5))?;
    class.define_method("fetches_unparked", method!(WorkerHost::fetches_unparked, 1))?;
    class.define_method("worker_activate_done", method!(WorkerHost::worker_activate_done, 1))?;
    class.define_method("worker_posted", method!(WorkerHost::worker_posted, 1))?;
    class.define_method("worker_posts_answered", method!(WorkerHost::worker_posts_answered, 1))?;
    class.define_method("bc_listen", method!(WorkerHost::bc_listen, 3))?;
    class.define_method("bc_listening?", method!(WorkerHost::bc_listening, 2))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn host_with(kind: &str) -> WorkerHost {
        let host = WorkerHost::new();
        host.worker_new(1, kind.into(), None, 0, "https://a.test/w.js".into(), 100.0, 100.0, None, 0.0, 0.0);
        host
    }

    #[test]
    fn a_worker_s_clock_follows_the_window_s_and_goes_back_only_with_it() {
        let host = host_with("dedicated");
        // (…made at a task's time ahead of the window's last step: no going back to that step)
        host.worker_new(2, "dedicated".into(), None, 0, "u".into(), 120.0, 100.0, None, 0.0, 0.0);
        assert_eq!(host.worker_clock_step(2, 100.0, 100.0), 0.0);
        assert_eq!(host.worker_now(2), Some(120.0));
        assert_eq!(host.worker_clock_step(1, 150.0, 150.0), 50.0);
        assert_eq!(host.worker_clock_step(1, 120.0, 150.0), 0.0);
        assert_eq!(host.worker_now(1), Some(150.0));
        // (…the window's clock back — a refused context reset's new isolate — takes it back)
        assert_eq!(host.worker_clock_step(1, 10.0, 10.0), 0.0);
        assert_eq!(host.worker_now(1), Some(10.0));
        assert_eq!(host.worker_clock_step(9, 10.0, 10.0), 0.0);
    }

    #[test]
    fn a_worker_is_due_in_the_lockstep_at_its_timer_or_at_once_where_asked() {
        let host = host_with("dedicated");
        // (…booting, due at the time it was made)
        assert_eq!(host.lockstep_next_at(100.0), Some(100.0));
        host.worker_timers_left(1, 30.0, false);
        assert_eq!(host.lockstep_next_at(100.0), Some(130.0));
        assert!(host.lockstep_due(120.0).is_empty());
        host.worker_asked(1);
        assert_eq!(host.lockstep_next_at(120.0), Some(120.0));
        assert_eq!(host.lockstep_due(120.0), vec![1]);
        // (…the tick covers what it was asked)
        assert_eq!(host.lockstep_next_at(120.0), Some(130.0));
        host.worker_timers_left(1, -1.0, true);
        assert_eq!(host.lockstep_next_at(120.0), None);
    }

    #[test]
    fn a_lagging_worker_is_back_in_the_lockstep_once_it_answers() {
        let host = host_with("dedicated");
        host.worker_timers_left(1, 0.0, false);
        host.with(1, (), |r| r.lagging = true);
        assert_eq!(host.lockstep_next_at(100.0), None);
        host.worker_timers_left(1, 0.0, true);
        assert_eq!(host.lockstep_next_at(100.0), Some(100.0));
    }

    #[test]
    fn a_blocked_worker_is_no_worker_the_lockstep_waits_on() {
        let host = host_with("dedicated");
        host.worker_blocked(1, 5);
        assert!(host.awaits_worker());
        assert_eq!(host.lockstep_next_at(100.0), None);
        host.resume_awaiting(5);
        assert!(host.is_resuming());
        host.worker_unblocked(1);
        assert!(!host.awaits_worker());
        host.worker_at_inbox(1);
        assert!(!host.is_resuming());
    }

    #[test]
    fn a_wait_in_place_counts_the_worker_s_time_from_its_take_to_its_answer() {
        let host = host_with("service");
        host.wait_begin(1, 7, true, true);
        assert_eq!(host.wait_spent(1, 7, false), None);
        host.fetch_taken(1, 7);
        host.worker_timers_left(1, 40.0, false);
        // (…its time runs on to its next timer at once while the window waits inside its script)
        assert_eq!(host.worker_at_inbox(1), 0.0);
        assert_eq!(host.worker_idle_to(1, 100.0), 140.0);
        host.worker_clock_step(1, 140.0, 100.0);
        host.answered_in_place(1, 7);
        host.worker_clock_step(1, 200.0, 200.0);
        assert_eq!(host.wait_spent(1, 7, true), Some(40.0));
        assert_eq!(host.wait_end(1, 7, 30.0, true), (30.0, Some(200.0)));
        assert_eq!(host.worker_idle_to(1, 250.0), 250.0);
    }

    #[test]
    fn an_activation_wait_runs_the_worker_on_no_further_than_it_lets_it() {
        let host = host_with("service");
        let began = host.activation_wait_begin(1);
        host.worker_timers_left(1, 5000.0, false);
        assert_eq!(host.worker_idle_to(1, 100.0), 100.0 + ACTIVATION_IN_PLACE_MS);
        assert_eq!(host.activation_wait(1, began, false), "wait");
        host.worker_clock_step(1, 100.0 + ACTIVATION_IN_PLACE_MS, 100.0);
        assert_eq!(host.activation_wait(1, began, false), "give up");
        host.worker_activate_done(1);
        assert_eq!(host.activation_wait(1, began, false), "activated");
        assert_eq!(host.activation_wait_end(1, began), (true, ACTIVATION_IN_PLACE_MS));
        assert_eq!(host.with(1, 0, |r| r.awaited), 0);
    }

    #[test]
    fn a_stalled_worker_has_no_timer_and_nothing_to_read() {
        let host = host_with("service");
        host.worker_at_inbox(1);
        assert!(!host.worker_stalled(1, false));
        host.worker_timers_left(1, -1.0, false);
        assert!(host.worker_stalled(1, false));
        assert!(host.sw_parked(vec![]));
        assert!(!host.worker_stalled(1, true));
        assert!(!host.sw_parked(vec![1]));
        // (…a message in its inbox, or its thread off it, is work)
        host.inbox_queued(1);
        assert!(!host.worker_stalled(1, false) && host.inbox_pending() && !host.sw_parked(vec![]));
        host.worker_off_inbox(1, true);
        assert!(!host.inbox_pending());
        assert!(!host.worker_stalled(1, false));
    }

    #[test]
    fn a_dropped_worker_hands_back_what_it_owes_and_reads_as_stopping() {
        let host = host_with("dedicated");
        host.worker_posted(1);
        host.worker_posted(1);
        host.worker_posts_answered(vec![1, 3]);
        assert!(!host.worker_stopping(1));
        assert!(host.fetch_parked(1, u64::MAX, "{}".into(), 4, 0));
        assert_eq!(host.worker_drop(1), Some(("dedicated", 1, vec![("{}".to_owned(), 4, 0)])));
        assert!(host.worker_stopping(1));
        assert_eq!(host.worker_drop(1), None);
        assert!(!host.fetch_parked(1, u64::MAX, "{}".into(), 5, 0));
    }

    #[test]
    fn a_lockstep_wait_gives_up_on_a_worker_ended() {
        let host = host_with("dedicated");
        // (…its thread ended: no tick of it answered, the wait over at once)
        host.worker_ended(1);
        let began = Instant::now();
        host.lockstep_wait(vec![1], began, &AtomicBool::new(false));
        assert!(began.elapsed() < Duration::from_secs(1));
        assert!(host.with(1, false, |r| r.lagging));
    }

    #[test]
    fn a_lockstep_wait_ends_as_the_worker_answers_its_tick() {
        let host = std::sync::Arc::new(host_with("dedicated"));
        host.worker_script_began(1);
        assert_eq!(host.lockstep_due(100.0), vec![1]);
        let worker = std::sync::Arc::clone(&host);
        let answering = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(20));
            worker.worker_timers_left(1, -1.0, true);
        });
        let began = Instant::now();
        host.lockstep_wait(vec![1], began, &AtomicBool::new(false));
        answering.join().unwrap();
        assert!(began.elapsed() < Duration::from_millis(ROUND_TRIP_BUDGET as u64 * 1000));
        assert!(!host.with(1, true, |r| r.lagging));
    }

    #[test]
    fn a_lockstep_wait_ends_as_it_is_cancelled() {
        let host = std::sync::Arc::new(host_with("dedicated"));
        host.worker_script_began(1);
        let cancel = std::sync::Arc::new(AtomicBool::new(false));
        let (h, c) = (std::sync::Arc::clone(&host), std::sync::Arc::clone(&cancel));
        let interrupting = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(20));
            c.store(true, Ordering::Release);
            drop(h.records());
            h.stirred.notify_all();
        });
        let began = Instant::now();
        host.lockstep_wait(vec![1], began, &cancel);
        interrupting.join().unwrap();
        assert!(began.elapsed() < Duration::from_millis(500));
    }

    #[test]
    fn the_soonest_timer_is_of_the_workers_not_stopping() {
        let host = host_with("service");
        host.worker_new(2, "dedicated".into(), Some(1), 0, "u".into(), 0.0, 0.0, None, 0.0, 0.0);
        host.worker_timers_left(1, 20.0, false);
        host.worker_timers_left(2, 10.0, false);
        assert_eq!(host.worker_next_timer(), 10.0);
        assert_eq!(host.sw_next_timer_at(), Some(120.0));
        assert_eq!(host.worker_children(1), vec![2]);
        host.worker_stop(2);
        assert_eq!(host.worker_next_timer(), 20.0);
        host.worker_ended(1);
        assert!(!host.worker_timers_pending());
        assert_eq!(host.sw_next_timer_at(), None);
    }
}
