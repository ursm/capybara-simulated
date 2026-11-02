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

use crate::dom::{dom, realm_id, register, register_fast, Dom, RealmArena, RealmState};

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
    // The agent's `Date` scale (`EventLoop::agent_epoch`), the first origin taken in the agent's: its `Date` at clock 0,
    // no script time.
    fn agent_epoch(&self) -> f64 {
        self.epoch - self.clock - self.script
    }
    // …and how far it stands ahead of this origin's `Date` at any time: none for the first document's, and for one made
    // after a fast-forward — a next page's, whose `Date` began again at the wall clock — the distance the virtual clock ran
    // ahead of real time.
    fn agent_shift(&self, agent_epoch: f64) -> f64 {
        agent_epoch - self.agent_epoch()
    }
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

// What a realm's clock reads beside its agent's (`RealmState::clock`): where it is held, its host's offset, and a
// worker's catching up with its window.
#[derive(Default)]
pub(crate) struct RealmClock {
    // The high resolution time last read, which no read goes back from — across a time origin taken again too.
    last_hr: f64,
    // The time another agent's message, or a timer, brought the realm's clock on to (`clockAtLeast`): its high resolution
    // time reads no earlier until its own passes it.
    held_until: f64,
    // The host's clock's offset from the real one: Ruby specs that `freeze_time(...)` / `travel_to(...)` shift
    // `Time.now` server-side, and the in-process app's rendering, model factories and trend computations all observe the
    // frozen value — so client-side date math (Discourse's `moment()` calls in admin-dashboard-tab.js → `last 30 days`
    // window, freshly-typed `created_at`) would diverge from what the server just sent. Ruby pushes `Time.now -
    // real_wall_clock_now` on each VM rebuild, which `Date` and the time origin `performance.timeOrigin` reads add
    // (`timeTravelSet`).
    travel: f64,
    // Whether the realm is a worker's (`clockWorkerRealm`), and the worker's catching up with its window.
    worker: bool,
    window: WorkerClock,
}

// A worker's clock is its window's (Browser#run_worker): the window's time as it last caught up with it — its `Date`,
// virtual clock and scripts' time together — and the worker's own time since, its virtual moves and its scripts' (its
// agent's high resolution time), from its creation until it first catches up. Not its own scripts' time from before
// then on top: that the window's clock went on through as well, as the host stepped it — a worker spinning 20 ms of
// every 50 read its page's `Date` 1.2 s ahead after 6 s, and one whose start took 25 ms of real time read that far ahead
// for good. Never back: where the worker's own time since ran ahead of the window's (its scripts longer than the
// window's step), it holds there until the window's passes it. The window's own time, that is, its virtual clock's and
// its scripts': where the window's clock is held the worker's is held with it, `held`, its own time beneath running on
// with the window's virtual clock as the window's does — a worker caught up with a held window's time ran on from there
// by every step of the window's virtual clock beneath it, its `Date` 30 ms ahead of the page's after a busy answer.
#[derive(Default)]
struct WorkerClock {
    // The window's `Date` it last caught up with, and its own high resolution time and virtual clock then (`caughtUp`).
    caught_up: Option<(f64, f64, f64)>,
    // The time it has read beneath the window's hold, never back; and where the window's clock is held.
    last: f64,
    held: f64,
    // How far the agent's `Date` scale — the time every message's wire carries (`agentShift`) — stood ahead of its
    // maker's document's `Date` as it began (`clockEpochSet`): the worker's `Date` stands that far behind it, whatever
    // documents come after. A next page's `Date` begins again at the wall clock; on the agent's scale, a service worker's
    // tick count after a 20 s page landed at the next page's own time, not 18.8 s on — and a pop-up's worker, whose opener
    // navigated, read its pop-up's messages at their own time, not that much ahead.
    anchor_shift: f64,
}

impl WorkerClock {
    // Its own time beneath the window's hold: the window's time it caught up with and its own high resolution time `hr`
    // since — or, before it first caught up, its `Date` from its time origin `epoch` on.
    fn own(&mut self, epoch: f64, hr: f64) -> f64 {
        let raw = match self.caught_up {
            None => epoch + hr,
            Some((date, at_hr, _)) => date + (hr - at_hr),
        };
        if raw > self.last {
            self.last = raw;
        }
        self.last
    }
}

// A read of a realm's clock: its time origin's `Date`, its high resolution time on its agent's clock, never back, and its
// clock's state.
struct Read<'a> {
    epoch: f64,
    hr: f64,
    clock: &'a mut RealmClock,
}

impl Read<'_> {
    // The realm's own time, in milliseconds since the epoch before any offset: its agent's, a worker's on its window's
    // clock — what a message's time is judged against (timers.js `atItsTime`), no lift of a message's in it.
    fn own(&mut self) -> f64 {
        if !self.clock.worker {
            return self.epoch + self.hr;
        }
        let own = self.clock.window.own(self.epoch, self.hr);
        if own > self.clock.window.held { own } else { self.clock.window.held }
    }
    // …and held where a message or a timer brought it on (`clockAtLeast`): its high resolution time.
    fn hr_now(&mut self) -> f64 {
        let own = self.own();
        (if own > self.clock.held_until { own } else { self.clock.held_until }) - self.epoch
    }
    // How far the time another agent's message brought the realm to stands ahead of its own (a worker's, where it brought
    // its window's: `WorkerClock::held`) — which a timer set now falls due that much later on the virtual clock (timers.rs
    // `timerAdd`), its timeout counted from the time its `Date` reads. Due on the virtual clock alone, it ran with its
    // clock lifted to that time, and so did every timer set from it: a page that took a service worker's 1 s answer read
    // its `Date` 1 s ahead of its own time for good, and of its workers'. In whole milliseconds, the virtual clock's
    // steps. Not a worker's own scripts' lead over its window, nor a window's message's lift of a worker: the script time
    // of the driver's own work — a `fetch` event's construction, the turn a message was posted in — would move its timers
    // by however fast the machine ran (a service worker's 100 ms timer fell due at 152 against 112); those run lifted.
    fn lead(&mut self) -> f64 {
        let (own, held) = if self.clock.worker {
            (self.clock.window.own(self.epoch, self.hr), self.clock.window.held)
        } else {
            (self.epoch + self.hr, self.clock.held_until)
        };
        if held > own { (held - own).floor() } else { 0.0 }
    }
}

// Realm `cid`'s clock read now: a page's read, which opens the agent's turn (`open`) — or the host's, which opens none and
// leaves the time last read where it was.
fn read(d: &mut Dom, cid: i32, open: bool) -> Read<'_> {
    let at = Instant::now();
    let time = &mut d.agent_time;
    if open {
        time.open.get_or_insert(at);
    }
    let script = time.now(at);
    let clock = d.arena.event_loop.clock;
    let state = state_of(&mut d.arena, cid, script);
    let origin = state.time_origin.expect("state_of takes one");
    let t = origin.hr(clock, script);
    let realm = &mut state.clock;
    let hr = if t > realm.last_hr { t } else { realm.last_hr };
    if open {
        realm.last_hr = hr;
    }
    Read { epoch: origin.epoch, hr, clock: realm }
}

// Realm `cid`'s state, its time origin taken where it has none: a realm of a window the host booted has its own
// (`clockEpochSet`); any other — a frame's, a pop-up's this isolate made — reads its `Date` on from its main realm's, as
// one agent's clock, its high resolution time beginning now. (Neither where the main realm has none: the time now.)
fn state_of(arena: &mut RealmArena, cid: i32, script: f64) -> &mut RealmState {
    if arena.realm_state(cid).and_then(|s| s.time_origin).is_none() {
        let clock = arena.event_loop.clock;
        let main = (cid != 0).then(|| arena.realm_state(0)).flatten().and_then(|s| s.time_origin);
        let now = match main {
            Some(o) => o.epoch + o.hr(clock, script),
            None => system_now(),
        };
        let origin = TimeOrigin { epoch: now, clock, script };
        arena.event_loop.agent_epoch.get_or_insert(origin.agent_epoch());
        arena.enter(cid).time_origin = Some(origin);
    }
    arena.realm_state_mut(cid).expect("a realm with a time origin has state")
}

// How far the agent's `Date` scale stands ahead of realm `cid`'s `Date` (`TimeOrigin::agent_shift`): a window's messages
// leave on the agent's scale and come in from it (timers.js `atItsTime`), so a worker that outlives the document it was
// made by — or one a pop-up made, whose opener navigates — reads them all on one scale, the agent's, whatever document
// posted them. A worker's, its maker's as it began (`WorkerClock::anchor_shift`).
pub(crate) fn agent_shift_of(d: &mut Dom, cid: i32) -> f64 {
    let script = d.agent_time.now(Instant::now());
    let state = state_of(&mut d.arena, cid, script);
    if state.clock.worker {
        return state.clock.window.anchor_shift;
    }
    let origin = state.time_origin.expect("state_of takes one");
    let agent_epoch = d.arena.event_loop.agent_epoch.unwrap_or_else(|| origin.agent_epoch());
    origin.agent_shift(agent_epoch)
}

// (…and, of a realm a window's agent makes — a frame's, a pop-up's — its time origin taken as it begins: HTML's "create a
// new browsing context and document" sets it there, not at its first read of the clock)
pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32, context: v8::Local<'_, v8::Context>) {
    register_fast(scope, ns, "hrNow", hr_now, HR_NOW_FAST, context_id);
    register_fast(scope, ns, "dateNow", date_now, DATE_NOW_FAST, context_id);
    register(scope, ns, "realmTime", realm_time, context_id);
    register(scope, ns, "ownNow", own_now_op, context_id);
    register(scope, ns, "wireNow", wire_now, context_id);
    register(scope, ns, "windowTimeHere", window_time_here, context_id);
    register(scope, ns, "spentSince", spent_since, context_id);
    register(scope, ns, "timeOrigin", time_origin, context_id);
    register(scope, ns, "clockAtLeast", clock_at_least, context_id);
    register(scope, ns, "caughtUp", caught_up, context_id);
    register(scope, ns, "stepDate", step_date, context_id);
    register(scope, ns, "clockEpochSet", clock_epoch_set, context_id);
    register(scope, ns, "clockWorkerRealm", clock_worker_realm, context_id);
    register(scope, ns, "timeTravelSet", time_travel_set, context_id);
    register(scope, ns, "agentWait", agent_wait, context_id);
    register(scope, ns, "agentIdle", agent_idle, context_id);
    register(scope, ns, "agentShift", agent_shift, context_id);
    // SAFETY: a live context's handle, which the shim reads its microtask queue from.
    unsafe { csim_watch_checkpoints(scope.as_raw_isolate_ptr(), &*context) };
    if context_id != 0 {
        let d = dom(scope);
        let script = d.agent_time.now(Instant::now());
        state_of(&mut d.arena, context_id, script);
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
    if let Some(dom) = isolate.get_slot_mut::<Dom>() {
        let time = &mut dom.agent_time;
        if time.waits == 0 && time.open.is_some() {
            time.close(Instant::now());
        }
    }
}

// The engine's state and the calling realm, for a fast path: its function data is the realm's id (`register_fast`).
fn fast_realm<'a>(options: *mut v8::fast_api::FastApiCallbackOptions<'a>) -> Option<(&'a mut Dom, i32)> {
    // SAFETY: V8 hands a fast call its options, whose isolate is the one calling, on its thread, with no borrow of the
    // engine's state held across the call.
    let options = unsafe { &mut *options };
    let cid = v8::Local::<v8::Int32>::try_from(options.data).map_or(0, |i| i.value());
    let isolate: *mut v8::Isolate = unsafe { options.isolate_unchecked_mut() };
    unsafe { &mut *isolate }.get_slot_mut::<Dom>().map(|d| (d, cid))
}
const NUMBER_FAST: v8::fast_api::CFunctionInfo = v8::fast_api::CFunctionInfo::new(
    v8::fast_api::Type::Float64.as_info(),
    &[v8::fast_api::Type::V8Value.as_info(), v8::fast_api::Type::CallbackOptions.as_info()],
    v8::fast_api::Int64Representation::Number,
);

// __dom.hrNow() -> the calling realm's high resolution time: milliseconds since its time origin, on its agent's clock —
// its virtual clock and the script time since then — held where a message or a timer brought it on; a worker's on its
// window's clock. Uncoarsened, as `Date` reads it too (performance.js coarsens its own). (…a fast call:
// `performance.now()`)
fn hr_now(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    rv.set_double(read(dom(scope), cid, true).hr_now());
}
fn hr_now_fast(_receiver: v8::Local<v8::Value>, options: *mut v8::fast_api::FastApiCallbackOptions) -> f64 {
    fast_realm(options).map_or(0.0, |(d, cid)| read(d, cid, true).hr_now())
}
const HR_NOW_FAST: &[v8::fast_api::CFunction] = &[v8::fast_api::CFunction::new(hr_now_fast as _, &NUMBER_FAST)];

// __dom.dateNow() -> what the calling realm's `Date.now()` reads: its time origin's `Date`, its host's offset and its high
// resolution time, in whole milliseconds — a time value, as ECMA-262's is. (…a fast call: `Date.now()`, `new Date()`)
fn date_now(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    rv.set_double(date_of(read(dom(scope), cid, true)));
}
fn date_now_fast(_receiver: v8::Local<v8::Value>, options: *mut v8::fast_api::FastApiCallbackOptions) -> f64 {
    fast_realm(options).map_or(0.0, |(d, cid)| date_of(read(d, cid, true)))
}
const DATE_NOW_FAST: &[v8::fast_api::CFunction] = &[v8::fast_api::CFunction::new(date_now_fast as _, &NUMBER_FAST)];
fn date_of(mut read: Read<'_>) -> f64 {
    let origin = read.epoch + read.clock.travel;
    (origin + read.hr_now()).floor()
}

// __dom.realmTime() -> the calling realm's time, in milliseconds since the epoch, before its host's offset: its `Date`'s —
// a worker's time origin as a window makes it (workers.js).
fn realm_time(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    let mut read = read(dom(scope), cid, true);
    rv.set_double(read.epoch + read.hr_now());
}

// __dom.ownNow() -> the calling realm's own time, no hold of a message's in it (`Read::own`).
fn own_now_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    rv.set_double(own_now(dom(scope), cid));
}
pub(crate) fn own_now(d: &mut Dom, cid: i32) -> f64 {
    read(d, cid, true).own()
}

// __dom.wireNow() -> the time a message the calling realm posts carries, which it lands no earlier than (workers.js
// `encodeMessage`): its `Date`'s, before any offset — a worker's on its window's clock, as its `Date` is — on the agent's
// scale (`agent_shift_of`).
fn wire_now(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    let d = dom(scope);
    let mut read = read(d, cid, true);
    let now = read.epoch + read.hr_now();
    rv.set_double(now + agent_shift_of(d, cid));
}

// __dom.windowTimeHere() -> the window's time a worker stands at: the time it caught up with and the virtual time since,
// none of its scripts' (a window's own, its `Date`'s on its virtual clock) — what `spentSince` counts from.
fn window_time_here(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    let d = dom(scope);
    let virtual_now = d.arena.event_loop.clock;
    let read = read(d, cid, false);
    rv.set_double(match read.clock.window.caught_up {
        None => read.epoch + virtual_now,
        Some((date, _, at_virtual)) => date + (virtual_now - at_virtual),
    });
}

// __dom.spentSince(base) -> how long a worker has been on its own since the window's time `base`: the time it reads — its
// scripts' among it, and where its timers held it, not its window's hold — past it. A length of time, on no window's
// `Date`: what a service worker's answer took, from when its request was due to be taken — its scripts' time on an
// earlier event among it — which lands on its client's clock from the client's own ask, whichever window's clock the
// worker runs on (sw-client.js).
fn spent_since(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let base = args.get(0).number_value(scope).unwrap_or(0.0);
    let cid = realm_id(scope, &args);
    let read = read(dom(scope), cid, true);
    let own = read.clock.window.own(read.epoch, read.hr);
    rv.set_double((if own > read.clock.held_until { own } else { read.clock.held_until }) - base);
}

// __dom.timeOrigin() -> the calling realm's time origin, in milliseconds since the epoch, with its host's offset: what
// `performance.timeOrigin` reads. (A read of the origin, which opens no turn.)
fn time_origin(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    let read = read(dom(scope), cid, false);
    rv.set_double(read.epoch + read.clock.travel);
}

// __dom.clockAtLeast(ms) — the calling realm's clock on to `ms` at least, where it stands before it — the time a message
// from another agent was sent at, which it arrives no earlier than; the time a timer was set at and its timeout, which it
// runs no earlier than — HELD there, its virtual clock and its timers as they stand, until its own time passes it: the
// virtual clock's moves take up the lead, which is no lasting offset of its `Date` — the time a busy worker's answer
// brought was not then added to every later timer's reading.
fn clock_at_least(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(ms) = args.get(0).number_value(scope) else { return };
    let cid = realm_id(scope, &args);
    hold(dom(scope), cid, ms);
}
pub(crate) fn hold(d: &mut Dom, cid: i32, ms: f64) {
    let script = d.agent_time.now(Instant::now());
    let clock = &mut state_of(&mut d.arena, cid, script).clock;
    if ms > clock.held_until {
        clock.held_until = ms;
    }
}

// A timer of `timeout` ms set now in realm `cid` (timers.rs `timerAdd`): the time on the realm's clock it runs no earlier
// than — its `Date` now and its timeout — and how much later on the virtual clock it falls due (`Read::lead`).
pub(crate) fn timer_times(d: &mut Dom, cid: i32, timeout: f64) -> (f64, f64) {
    let mut read = read(d, cid, true);
    let at = read.epoch + read.hr_now() + timeout;
    (at, read.lead())
}

// __dom.caughtUp(date, ahead, held) — a worker caught up with its window's own time `date`, `ahead` the virtual time its
// step is still to move it by, which `date` already stands for; and with where the window's clock is held, `held`. Both
// on the agent's `Date` scale, which the worker's own `Date` stands its anchor shift behind. Caught up before the move,
// which `date` stands for: moved first, the move ran on from the last catch-up's time, and a worker whose scripts had run
// past its window's held there a step further on for good — every answer of a service worker's after its 1 s one 100 ms
// late.
fn caught_up(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let date = args.get(0).number_value(scope).unwrap_or(0.0);
    let ahead = args.get(1).number_value(scope).unwrap_or(0.0);
    let held = args.get(2).number_value(scope).unwrap_or(0.0);
    let cid = realm_id(scope, &args);
    let d = dom(scope);
    let script = d.agent_time.now(Instant::now());
    let window = &mut state_of(&mut d.arena, cid, script).clock.window;
    if held > 0.0 && held - window.anchor_shift > window.held {
        window.held = held - window.anchor_shift;
    }
    if !(date > 0.0) {
        return;
    }
    let virtual_now = d.arena.event_loop.clock;
    let read = read(d, cid, true);
    let window = &mut read.clock.window;
    window.own(read.epoch, read.hr);
    window.caught_up = Some((date - window.anchor_shift, read.hr + ahead, virtual_now + ahead));
}

// __dom.stepDate() -> `[date, held]`: the calling realm's own time as an event loop step leaves it, and where it is held
// (0 for nowhere ahead of it), on the agent's `Date` scale — what the time a worker reads runs on from, and what it is
// held at with it (`caughtUp`). Read by the host, which opens no turn: what runs next in the realm, if anything, is the
// next document's.
fn step_date(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    let d = dom(scope);
    let read = read(d, cid, false);
    let own = read.epoch + read.hr;
    let held_until = read.clock.held_until;
    let shift = agent_shift_of(d, cid);
    let date = v8::Number::new(scope, own + shift).into();
    let held = v8::Number::new(scope, if held_until > own { held_until + shift } else { 0.0 }).into();
    rv.set(v8::Array::new_with_elements(scope, &[date, held]).into());
}

// __dom.clockEpochSet(ms, since, shift) — the calling realm's time origin, which its `Date` reads as `ms`, was `since` ms
// of real time ago: a window's as the host boots its document (now), a worker's at the time it was made, its start since
// then — the script fetched, the isolate made — the first of its high resolution time, as a browser's worker reads a time
// past its origin from its first statement. Its clock begins again there, held nowhere; `shift`, a worker's, how far the
// agent's `Date` scale stood ahead of its maker's `Date` (`WorkerClock::anchor_shift`).
fn clock_epoch_set(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let epoch = args.get(0).number_value(scope).filter(|t| t.is_finite());
    let since = args.get(1).number_value(scope).filter(|t| t.is_finite() && *t > 0.0).unwrap_or(0.0);
    let shift = args.get(2).number_value(scope).filter(|t| t.is_finite()).unwrap_or(0.0);
    let cid = realm_id(scope, &args);
    let d = dom(scope);
    let script = d.agent_time.now(Instant::now());
    let clock = d.arena.event_loop.clock;
    let arena = &mut d.arena;
    if let Some(epoch) = epoch {
        let origin = TimeOrigin { epoch, clock, script: script - since };
        arena.event_loop.agent_epoch.get_or_insert(origin.agent_epoch());
        arena.enter(cid).time_origin = Some(origin);
    }
    let realm = &mut state_of(arena, cid, script).clock;
    let RealmClock { travel, worker, .. } = *realm;
    *realm = RealmClock { travel, worker, window: WorkerClock { anchor_shift: shift, ..WorkerClock::default() }, ..RealmClock::default() };
}

// __dom.clockWorkerRealm() — the calling realm is a worker's, its scope installed (workers.js): its clock reads its
// window's (`WorkerClock`).
fn clock_worker_realm(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    let d = dom(scope);
    let script = d.agent_time.now(Instant::now());
    state_of(&mut d.arena, cid, script).clock.worker = true;
}

// __dom.timeTravelSet(ms) — the host's clock stands `ms` off the real one (`RealmClock::travel`).
fn time_travel_set(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let ms = args.get(0).number_value(scope).filter(|t| t.is_finite()).unwrap_or(0.0);
    let cid = realm_id(scope, &args);
    let d = dom(scope);
    let script = d.agent_time.now(Instant::now());
    state_of(&mut d.arena, cid, script).clock.travel = ms;
}

// __dom.agentShift() -> how far the agent's `Date` scale stands ahead of the calling realm's `Date` (`agent_shift_of`).
fn agent_shift(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    rv.set_double(agent_shift_of(dom(scope), cid));
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

