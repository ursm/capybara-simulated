// The clock a realm's `Date` and `performance.now()` read (High Resolution Time §4-5): its virtual clock — the time its
// event loop has reached (timers.rs `clockNow`), which only an event loop step or a host's wait moves — and, beside it,
// the real time scripts have run for, which no step moves: a script that spins until `Date.now()` has gone on by 50 ms
// sees it go on all the same, as it would in a browser.
//
// Only the time INSIDE a script turn counts. A turn opens at an agent's first read of the clock after its last
// microtask checkpoint and closes at the next one (a microtask the read queues). What passes between turns — the host
// waiting between polls, serving a request — is the virtual clock's to show, which the host moves for it: counted on
// both, a page at rest ran its `Date` at twice its timers' pace (a `setTimeout(…, 3000)` read 5,400 ms of
// `performance.now()`). Nor does a script's wait inside a synchronous request (`agentWait`), which the virtual clock
// shows by the time the answer took, if it takes any.
//
// The script time is the process's: the real time during which ANY agent's turn was open — one shared clock, as HR-Time
// has it, whose time passes for every agent while any of them runs. A service worker spinning 2 s on `Date.now()` in
// its fetch event shows those 2 s on the page waiting for its answer; and a worker and its window read the same time.
// Each realm's clock reads it from where it stood as the realm's time origin was taken, beside its own virtual clock.
use std::sync::Mutex;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use crate::dom::{dom, realm_id, register};

// The process's script time: the time its turns were open, in milliseconds, up to the last time none was — and how many
// are open now, since when.
struct ScriptTime {
    closed: f64,
    open: u32,
    since: Option<Instant>,
}

static SCRIPT_TIME: Mutex<ScriptTime> = Mutex::new(ScriptTime { closed: 0.0, open: 0, since: None });

fn script_time_at(at: Instant) -> f64 {
    let t = SCRIPT_TIME.lock().unwrap_or_else(|e| e.into_inner());
    t.closed + t.since.map_or(0.0, |s| at.saturating_duration_since(s).as_secs_f64() * 1000.0)
}

fn turn_opens(at: Instant) {
    let mut t = SCRIPT_TIME.lock().unwrap_or_else(|e| e.into_inner());
    if t.open == 0 {
        t.since = Some(at);
    }
    t.open += 1;
}

fn turn_closes(at: Instant) {
    let mut t = SCRIPT_TIME.lock().unwrap_or_else(|e| e.into_inner());
    t.open = t.open.saturating_sub(1);
    if t.open == 0 {
        if let Some(since) = t.since.take() {
            t.closed += at.saturating_duration_since(since).as_secs_f64() * 1000.0;
        }
    }
}

// An agent's part in it (its isolate's, one event loop for every realm of it): whether it has a turn open, whether the
// microtask that closes it is queued, and whether it waits inside a synchronous request, a turn it had open put by.
#[derive(Default)]
pub(crate) struct AgentTime {
    open: bool,
    closing: bool,
    waiting: bool,
}

// …let go of with its isolate: a turn it left open — a worker terminated inside a script — open no more.
impl Drop for AgentTime {
    fn drop(&mut self) {
        if self.open {
            turn_closes(Instant::now());
        }
    }
}

// A realm's time origin: what its `Date` read at its high resolution time 0 (in milliseconds since the epoch, before
// any time-travel offset its host adds), and the script time then.
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
    register(scope, ns, "agentWait", agent_wait, context_id);
}

// The calling agent's turn opened where it has none, the microtask that closes it queued where none is.
fn open_turn(scope: &mut v8::PinScope<'_, '_>, at: Instant) {
    let time = &mut dom(scope).agent_time;
    if !time.open {
        time.open = true;
        turn_opens(at);
    }
    if !time.closing {
        time.closing = true;
        if let Some(close) = v8::Function::new(scope, close_turn) {
            scope.enqueue_microtask(close);
        }
    }
}

// The script time now, the calling agent's turn opened.
fn script_time(scope: &mut v8::PinScope<'_, '_>) -> f64 {
    let at = Instant::now();
    open_turn(scope, at);
    script_time_at(at)
}

// The microtask checkpoint the turn ends at has come.
fn close_turn(scope: &mut v8::PinScope<'_, '_>, _args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let time = &mut dom(scope).agent_time;
    time.closing = false;
    if std::mem::take(&mut time.open) {
        turn_closes(Instant::now());
    }
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
// the script time since then — uncoarsened, as `Date` reads it too (performance.js coarsens its own).
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

// __dom.agentWait(waits) — a script of the calling agent's begins to wait inside a synchronous request (true), or has
// done (false): its turn put by meanwhile, and taken up again after. The wait is the host's — a server's answer, a
// worker's — whose time the virtual clock shows (`__csimClockMovedBy`), as much as the model says it took.
fn agent_wait(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let begins = args.get(0).is_true();
    let at = Instant::now();
    let time = &mut dom(scope).agent_time;
    if begins {
        if std::mem::take(&mut time.open) {
            time.waiting = true;
            turn_closes(at);
        }
    } else if std::mem::take(&mut time.waiting) {
        open_turn(scope, at);
    }
}
