// The clock a realm's `Date` and `performance.now()` read (High Resolution Time §4-5): its virtual clock — the time its
// event loop has reached (timers.rs `clockNow`), which only an event loop step or a host's wait moves — and, beside it,
// the real time the agent's scripts have run for, which no step moves: a script that spins until `Date.now()` has gone
// on by 50 ms sees it go on all the same, as it would in a browser.
//
// Only the time INSIDE a script turn counts. A turn opens at the first read of the clock after the agent's last
// microtask checkpoint and closes at the next one (a microtask the read queues), its length added to the agent's
// script time then. What passes between turns — the host waiting between polls, serving a request — is the virtual
// clock's to show, which the host moves for it: counted on both, a page at rest ran its `Date` at twice its timers'
// pace (a `setTimeout(…, 3000)` read 5,400 ms of `performance.now()`).
//
// The script time is the agent's — its isolate's, one event loop for every realm of it — and each realm's clock reads
// it from where it stood as the realm's time origin was taken, beside its own virtual clock.
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use crate::dom::{dom, realm_id, register};

// The agent's script time: the turns closed, in milliseconds, and the one open, from when it opened.
#[derive(Default)]
pub(crate) struct AgentTime {
    closed: f64,
    open: Option<Instant>,
}

impl AgentTime {
    fn now(&self, at: Instant) -> f64 {
        self.closed + self.open.map_or(0.0, |o| at.duration_since(o).as_secs_f64() * 1000.0)
    }
}

// A realm's time origin: what its `Date` read at its high resolution time 0 (in milliseconds since the epoch, before
// any time-travel offset its host adds), and the agent's script time then.
#[derive(Clone, Copy)]
pub(crate) struct TimeOrigin {
    epoch: f64,
    script: f64,
}

fn system_now() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0.0, |d| d.as_secs_f64() * 1000.0)
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    register(scope, ns, "hrNow", hr_now, context_id);
    register(scope, ns, "clockEpoch", clock_epoch, context_id);
    register(scope, ns, "clockEpochSet", clock_epoch_set, context_id);
    register(scope, ns, "agentWaited", agent_waited, context_id);
}

// The script time now, a turn opened where none is — with the microtask that closes it queued.
fn script_time(scope: &mut v8::PinScope<'_, '_>) -> f64 {
    let at = Instant::now();
    let time = &mut dom(scope).agent_time;
    if time.open.is_some() {
        return time.now(at);
    }
    time.open = Some(at);
    let closed = time.closed;
    if let Some(close) = v8::Function::new(scope, close_turn) {
        scope.enqueue_microtask(close);
    }
    closed
}

// The microtask checkpoint the turn ends at has come: its length is the agent's script time's.
fn close_turn(scope: &mut v8::PinScope<'_, '_>, _args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let time = &mut dom(scope).agent_time;
    time.closed = time.now(Instant::now());
    time.open = None;
}

// Realm `cid`'s time origin, taken where it has none: a realm of a window the host booted has its own (`clockEpochSet`);
// any other — a frame's, a pop-up's this isolate made — reads its `Date` on from its main realm's, as one agent's clock,
// its high resolution time beginning at its virtual clock's 0. (Neither where the main realm has none: the time now.)
fn origin_of(scope: &mut v8::PinScope<'_, '_>, cid: i32, script: f64) -> TimeOrigin {
    let arena = &mut dom(scope).arena;
    if let Some(origin) = arena.realm_state(cid).and_then(|s| s.time_origin) {
        return origin;
    }
    let clock = arena.realm_state(cid).map_or(0.0, |s| s.clock);
    let main = (cid != 0).then(|| arena.realm_state(0)).flatten().and_then(|s| s.time_origin.map(|o| (o, s.clock)));
    let now = match main {
        Some((o, main_clock)) => o.epoch + main_clock + script - o.script,
        None => system_now(),
    };
    let origin = TimeOrigin { epoch: now - clock, script };
    arena.enter(cid).time_origin = Some(origin);
    origin
}

// __dom.hrNow() -> the calling realm's high resolution time: milliseconds since its time origin, its virtual clock and
// the agent's script time since then — uncoarsened, as `Date` reads it too (performance.js coarsens its own).
fn hr_now(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    let script = script_time(scope);
    let origin = origin_of(scope, cid, script);
    let clock = dom(scope).arena.realm_state(cid).map_or(0.0, |s| s.clock);
    rv.set_double(clock + script - origin.script);
}

// __dom.clockEpoch() -> the calling realm's time origin, in milliseconds since the epoch.
fn clock_epoch(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    let script = script_time(scope);
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
    let script = script_time(scope);
    let state = dom(scope).arena.enter(cid);
    state.time_origin = Some(TimeOrigin { epoch: epoch - state.clock, script: script - since });
}

// __dom.agentWaited(ms) — a script of the agent's waited `ms` of real time inside its turn, for a synchronous request,
// which its virtual clock shows instead (`__csimClockMovedBy`): left out of its script time.
fn agent_waited(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(ms) = args.get(0).number_value(scope).filter(|t| t.is_finite() && *t > 0.0) else { return };
    let at = Instant::now();
    let time = &mut dom(scope).agent_time;
    if let Some(open) = time.open {
        let left = std::time::Duration::from_secs_f64(ms / 1000.0).min(at.duration_since(open));
        time.open = Some(open + left);
    }
}
