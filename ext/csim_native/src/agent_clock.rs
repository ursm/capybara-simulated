// The clock a realm's `Date` and `performance.now()` read (High Resolution Time §4-5): its virtual clock — the time its
// event loop has reached (timers.rs `clockNow`), which only an event loop step or a host's wait moves — and, beside it,
// the real time its agent's scripts have run for, which no step moves: a script that spins until `Date.now()` has gone
// on by 50 ms sees it go on all the same, as it would in a browser.
//
// Only the time INSIDE a script turn counts. A turn opens at the agent's first read of the clock after its last
// microtask checkpoint and closes as the next one completes (V8's microtasks-completed callback on every queue of the
// agent: `csim_agent_checkpoint_done`) — the end of the task, its microtasks run, not the first microtask after the read
// — or at the end of the event loop step it is in (`agentIdle`), whichever comes first. What passes between turns — the host waiting between polls, serving a
// request — is the virtual clock's to show, which the host moves for it: counted on both, a page at rest ran its `Date`
// at twice its timers' pace (a `setTimeout(…, 3000)` read 5,400 ms of `performance.now()`). Nor does the part of a
// script's wait inside a synchronous host call (`agentWait`) that the virtual clock shows: a server's sleep the host
// moved it by, a worker's answer — the rest of the wait real time the script spent, as a network's would be.
//
// The script time is the agent's — its isolate's, one event loop for every realm of it. Another agent's work is none of
// it: what crosses from one agent to another — a message, a worker's answer — carries its sender's time, and lands no
// earlier (timers.js `atItsTime`): a service worker spinning 2 s in its fetch event answers 2 s on, on the page's clock.
// Each realm's clock reads the script time from where it stood as the realm's time origin was taken, beside the virtual
// clock — its agent's: the window realms of one agent, one event loop, read and schedule on one clock (timers.rs
// `EventLoop`).
//
// A document's `Date` begins at the wall clock (the host's `clockEpochMs`), as its server's `Time.now` does — so after a
// long fast-forward the next document's `Date` falls back to the wall clock, behind where the last one's had gone: a
// page's `Date` minutes ahead of its server misreads every "x minutes ago" and every expiry. Its `performance.now()`
// begins at 0, and neither goes back within it.
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use crate::dom::{dom, realm_id, register};

// An agent's script time: the turns closed, in milliseconds; the turn open, from when
// it opened; and the synchronous host calls it waits inside, how many and since when the outermost began.
#[derive(Default)]
pub(crate) struct AgentTime {
    closed: f64,
    open: Option<Instant>,
    waits: u32,
    wait_began: Option<Instant>,
}

impl AgentTime {
    fn now(&self, at: Instant) -> f64 {
        self.closed + self.open.map_or(0.0, |o| at.saturating_duration_since(o).as_secs_f64() * 1000.0)
    }
    fn close(&mut self, at: Instant) {
        self.closed = self.now(at);
        self.open = None;
    }
}

// A realm's time origin: what its `Date` read at its high resolution time 0 (in milliseconds since the epoch, before
// any time-travel offset its host adds), and its virtual clock and the script time then (less the real time its start
// took, which its clock begins with).
#[derive(Clone, Copy)]
pub(crate) struct TimeOrigin {
    epoch: f64,
    clock: f64,
    script: f64,
}

impl TimeOrigin {
    // The event loop's clock as the origin was taken.
    pub(crate) fn clock(&self) -> f64 {
        self.clock
    }
    // …taken at the clock's earlier `at` instead: its `Date` as much earlier (the script time since, the realm's none).
    pub(crate) fn backdate(&mut self, at: f64) {
        if at < self.clock {
            self.epoch -= self.clock - at;
            self.clock = at;
        }
    }
    fn hr(&self, clock: f64, script: f64) -> f64 {
        clock - self.clock + script - self.script
    }
}

fn system_now() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0.0, |d| d.as_secs_f64() * 1000.0)
}

unsafe extern "C" {
    fn csim_watch_checkpoints(isolate: v8::UnsafeRawIsolatePtr, context: *const v8::Context);
}

// (…and, of a realm a window's agent makes — a frame's, a pop-up's — its time origin taken as it begins: HTML's "create a
// new browsing context and document" sets it there, not at its first read of the clock)
pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32, context: v8::Local<'_, v8::Context>) {
    register(scope, ns, "hrNow", hr_now, context_id);
    register(scope, ns, "hrPeek", hr_peek, context_id);
    register(scope, ns, "clockEpoch", clock_epoch, context_id);
    register(scope, ns, "clockEpochSet", clock_epoch_set, context_id);
    register(scope, ns, "agentWait", agent_wait, context_id);
    register(scope, ns, "agentIdle", agent_idle, context_id);
    // SAFETY: a live context's handle, which the shim reads its microtask queue from.
    unsafe { csim_watch_checkpoints(scope.as_raw_isolate_ptr(), &*context) };
    if context_id != 0 {
        let script = dom(scope).agent_time.now(Instant::now());
        origin_of(scope, context_id, script);
    }
}

// A microtask checkpoint of one of the isolate's queues has completed (v8_shim.cc `csim_watch_checkpoints`): the agent's
// turn over — unless it is one inside a synchronous wait (a step the host runs in it), whose end closes the turn's
// account first: `agentWait`.
#[unsafe(no_mangle)]
extern "C" fn csim_agent_checkpoint_done(isolate: v8::UnsafeRawIsolatePtr) {
    let mut ptr = isolate;
    // SAFETY: V8 calls this on the isolate's own thread, with no borrow of the engine's state held across the checkpoint.
    let isolate = unsafe { v8::Isolate::ref_from_raw_isolate_ptr_mut(&mut ptr) };
    if let Some(dom) = isolate.get_slot_mut::<crate::dom::Dom>() {
        let time = &mut dom.agent_time;
        if time.waits == 0 && time.open.is_some() {
            time.close(Instant::now());
        }
    }
}

// The script time now, the calling agent's turn opened where it has none.
fn script_time(scope: &mut v8::PinScope<'_, '_>) -> f64 {
    let at = Instant::now();
    let time = &mut dom(scope).agent_time;
    time.open.get_or_insert(at);
    time.now(at)
}


// Realm `cid`'s time origin, taken where it has none: a realm of a window the host booted has its own (`clockEpochSet`);
// any other — a frame's, a pop-up's this isolate made — reads its `Date` on from its main realm's, as one agent's clock,
// its high resolution time beginning now. (Neither where the main realm has none: the time now.)
fn origin_of(scope: &mut v8::PinScope<'_, '_>, cid: i32, script: f64) -> TimeOrigin {
    let arena = &mut dom(scope).arena;
    if let Some(origin) = arena.realm_state(cid).and_then(|s| s.time_origin) {
        return origin;
    }
    let clock = arena.event_loop.clock;
    let main = (cid != 0).then(|| arena.realm_state(0)).flatten().and_then(|s| s.time_origin);
    let now = match main {
        Some(o) => o.epoch + o.hr(clock, script),
        None => system_now(),
    };
    let origin = TimeOrigin { epoch: now, clock, script };
    arena.enter(cid).time_origin = Some(origin);
    origin
}

// __dom.hrNow() -> the calling realm's high resolution time: milliseconds since its time origin, its virtual clock and
// the script time since then — uncoarsened, as `Date` reads it too (performance.js coarsens its own).
fn hr_now(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    let script = script_time(scope);
    let origin = origin_of(scope, cid, script);
    rv.set_double(origin.hr(dom(scope).arena.event_loop.clock, script));
}

// __dom.hrPeek() -> the same, read by the host — as a navigation leaves the page — which opens no turn: what runs next
// in the realm, if anything, is the next document's.
fn hr_peek(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    let script = dom(scope).agent_time.now(Instant::now());
    let origin = origin_of(scope, cid, script);
    rv.set_double(origin.hr(dom(scope).arena.event_loop.clock, script));
}

// __dom.clockEpoch() -> the calling realm's time origin, in milliseconds since the epoch. (A read of the origin, which
// opens no turn: the host's, as it boots a document, whose load waits on fetches the virtual clock shows.)
fn clock_epoch(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    let script = dom(scope).agent_time.now(Instant::now());
    rv.set_double(origin_of(scope, cid, script).epoch);
}

// __dom.clockEpochSet(ms, since) — the calling realm's time origin, which its `Date` reads as `ms`, was `since` ms of real
// time ago: a window's as the host boots its document (now), a worker's at the time it was made, its start since then —
// the script fetched, the isolate made — the first of its high resolution time, as a browser's worker reads a time past
// its origin from its first statement.
fn clock_epoch_set(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(epoch) = args.get(0).number_value(scope).filter(|t| t.is_finite()) else { return };
    let since = args.get(1).number_value(scope).filter(|t| t.is_finite() && *t > 0.0).unwrap_or(0.0);
    let cid = realm_id(scope, &args);
    let script = dom(scope).agent_time.now(Instant::now());
    let clock = dom(scope).arena.event_loop.clock;
    dom(scope).arena.enter(cid).time_origin = Some(TimeOrigin { epoch, clock, script: script - since });
}

// __dom.agentWait(begins, moved) — a script of the calling agent's begins to wait inside a synchronous host call (true),
// or has done (false), the event loop's virtual clock `moved` ms on meanwhile — a server's sleep the host moved it by, a
// worker's answer: as much of the wait's real time as that is none of the script time, the virtual clock showing it (all
// of it, a `moved` past the wait's length: a wait on a worker, whose answer brings the time it took — sw-client.js).
fn agent_wait(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let begins = args.get(0).is_true();
    let moved = args.get(1).number_value(scope).filter(|t| t.is_finite() && *t > 0.0).unwrap_or(0.0);
    let at = Instant::now();
    let time = &mut dom(scope).agent_time;
    if begins {
        time.waits += 1;
        if time.waits == 1 {
            time.wait_began = Some(at);
        }
        return;
    }
    time.waits = time.waits.saturating_sub(1);
    if time.waits > 0 {
        return;
    }
    let (Some(began), Some(open)) = (time.wait_began.take(), time.open) else { return };
    let waited = at.saturating_duration_since(began.max(open));
    let cut = std::time::Duration::from_secs_f64((moved / 1000.0).min(waited.as_secs_f64()));
    time.open = Some(open + cut);
}

// __dom.agentIdle() — the calling agent's event loop step is over: a turn still open closes, whether or not a checkpoint
// completed after it (a realm's queue let go of undrained, a context reset). (Not a step the host runs inside a script's
// synchronous wait — a server's sleep it moves the clock by — whose turn the wait's end takes what the clock showed out
// of: `agentWait`.)
fn agent_idle(scope: &mut v8::PinScope<'_, '_>, _args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let time = &mut dom(scope).agent_time;
    if time.waits == 0 {
        time.close(Instant::now());
    }
}
