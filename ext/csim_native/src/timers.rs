// A realm's timers (HTML "map of active timers", §8.6) and the tasks the platform queues on the same list: each its
// handler — a function, or a string run as a script — with its arguments, when it falls due on the realm's virtual
// clock, and the period it repeats at. They run in the order they fall due, and those due at once in the order they
// were scheduled — an interval keeps its place among them as it repeats. The bindings run each as its turn comes
// (timers.js `runLoopStepLocal`), moving the realm's clock (`RealmState::clock`) to when it falls due.
//
// And its animation frame callbacks (`frames`), which the rendering update runs (timers.js `runRenderPhase`): each a
// function, run in the order requested, a frame's taken as it begins. And its idle request callbacks (`idle`), which
// an idle period runs (timers.js `runIdlePeriod`), as the event loop has nothing due.
//
// A page's timer is named by a positive id, its realm's own, as `setTimeout` returns one; a task the platform queues by
// a negative key, the isolate's (`TaskKeys`) — no page clearing every id it can count to clears the platform's work,
// and a task cancelled from another realm's code (a toggle task a frame's prototype cancels) is the one it names.

use std::collections::{BTreeSet, HashMap};

use crate::dom::{dom, realm_id, register, RealmArena};

struct Timer {
    due: f64,
    seq: u64,
    handler: v8::Global<v8::Value>,
    args: Option<v8::Global<v8::Value>>,
    // The timeout a repeating timer is scheduled again with (HTML: the timer initialization steps run again).
    period: Option<f64>,
    // Its task's timer nesting level (HTML §8.6): one more than that of the timer task it was scheduled in, 0 outside one.
    nesting: u32,
}

// HTML §8.6 timer initialization steps 5-7: a timer scheduled in a timer task whose nesting level is past 5, with a
// timeout under 4 ms, falls due in 4.
const NESTING_CLAMP_LEVEL: u32 = 5;
const NESTING_CLAMP_MS: f64 = 4.0;
fn clamped(timeout: f64, nesting: u32) -> f64 {
    if nesting > NESTING_CLAMP_LEVEL && timeout < NESTING_CLAMP_MS { NESTING_CLAMP_MS } else { timeout }
}

#[derive(Default)]
pub(crate) struct Timers {
    by_key: HashMap<i64, Timer>,
    // The keys in the order they run: by when they are due, then by when they were scheduled.
    order: BTreeSet<(Due, u64, i64)>,
    last_id: i64,
    seq: u64,
    // Its animation frame callbacks (HTML "map of animation frame callbacks"), by the id `requestAnimationFrame` gave
    // each, in the order they were requested — and those of the frame being run, taken as it began (one requested by
    // a callback of it runs in the next), each as its turn comes, which a cancel by an earlier one still reaches.
    frames: std::collections::VecDeque<(u32, v8::Global<v8::Value>)>,
    running: std::collections::VecDeque<(u32, v8::Global<v8::Value>)>,
    last_frame: u32,
    // The nesting level of the timer task running now — none where the task running is none of a timer's (a platform
    // task, an animation frame, a script the host runs) — which a timer it schedules nests in (`timerNext`,
    // `timerTaskEnd`).
    task_nesting: Option<u32>,
    // …and the repeating timer whose task that is, with when it ran: scheduled again as its task ends (`rearm`), after
    // whatever its handler scheduled.
    repeating: Option<(i64, f64)>,
    // Its idle request callbacks (requestIdleCallback §5.2), by the handle each was given: those requested since the last
    // idle period began (its "list of idle request callbacks"), those an idle period made runnable and has yet to run
    // ("list of runnable idle callbacks"), each in order — and when the idle period running began.
    idle: std::collections::VecDeque<IdleRequest>,
    runnable: std::collections::VecDeque<IdleRequest>,
    last_idle: u32,
    idle_began: f64,
    // How many of the realm's event loop steps are running (`timerStep`): a step goes on with what is due in it though
    // the realm's context is disposed during it — a frame's script removing its own iframe, mid-step, still has the
    // request it sent fail as the step runs on — and the list goes as it ends.
    stepping: u32,
}

// The isolate's task keys: the last one handed out, and the realm each live one is of; and the realms whose contexts
// are disposed, which take no timer from then on but in a step still running (code of theirs a page still calls — a
// `setTimeout` it kept, a frame's function after its iframe is removed — would pin their global for good).
#[derive(Default)]
pub(crate) struct TaskKeys {
    last: i64,
    realms: HashMap<i64, i32>,
    pub(crate) discarded: std::collections::HashSet<i32>,
}

// A due time, ordered as the number it is — `total_cmp`, which every comparison of it goes through.
#[derive(Clone, Copy)]
struct Due(f64);
impl PartialEq for Due {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other).is_eq()
    }
}
impl Eq for Due {}
impl PartialOrd for Due {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for Due {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.0.total_cmp(&other.0)
    }
}

impl Timers {
    fn add(&mut self, key: i64, timer: (v8::Global<v8::Value>, Option<v8::Global<v8::Value>>), due: f64, period: Option<f64>, nesting: u32) {
        self.seq += 1;
        self.order.insert((Due(due), self.seq, key));
        self.by_key.insert(key, Timer { due, seq: self.seq, handler: timer.0, args: timer.1, period, nesting });
    }
    fn clear(&mut self, key: i64) -> bool {
        let Some(t) = self.by_key.remove(&key) else { return false };
        self.order.remove(&(Due(t.due), t.seq, key));
        true
    }
    // HTML §8.6 timer task step 7: a repeating timer, its handler run, runs the timer initialization steps again — due
    // its timeout after it ran, clamped at its nesting level and a level deeper, ordered after every timer scheduled
    // before now, its handler's own — unless the handler cleared it. Its task over, what runs next is no timer task.
    fn end_task(&mut self) {
        self.task_nesting = None;
        let Some((key, run)) = self.repeating.take() else { return };
        self.seq += 1;
        let seq = self.seq;
        let Some(t) = self.by_key.get_mut(&key) else { return };
        let Some(timeout) = t.period else { return };
        t.due = run + clamped(timeout, t.nesting);
        t.nesting += 1;
        t.seq = seq;
        self.order.insert((Due(t.due), seq, key));
    }
}

// An idle request callback: its handle, the callback, and the task its `timeout` queued (§5.2 step 6) — cleared as the
// callback runs or is cancelled, so a long timeout keeps no event loop stepping for nothing.
struct IdleRequest {
    handle: u32,
    callback: v8::Global<v8::Value>,
    timeout: Option<i64>,
}

// requestIdleCallback §5.3 "start an idle period": its deadline 50 ms on at the most, and a frame's interval where an
// animation frame callback is waiting for the rendering update to come.
const IDLE_PERIOD_MAX_MS: f64 = 50.0;
const FRAME_INTERVAL_MS: f64 = 1000.0 / 60.0;

impl Timers {
    // §5.3 "start an idle period", at `now`: every callback requested since the last one runnable after those still
    // waiting; whether there is one to run.
    fn begin_idle(&mut self, now: f64) -> bool {
        self.runnable.extend(self.idle.drain(..));
        self.idle_began = now;
        !self.runnable.is_empty()
    }
    // §5.4 what is left at `now` of the idle period, as it stands — HTML's "computeDeadline", which reads the event
    // loop's LAST idle period start time each time it is called, so a deadline kept into a later period reads that one
    // (Chrome holds each to its own; spec over Blink): 50 ms from its start at the most, a frame's interval where an
    // animation frame callback waits for the rendering update — one requested during it too — and never past the timer
    // due first. (Each a span less what has gone of it, so a period just begun has its cap exactly.)
    fn idle_remaining(&self, now: f64) -> f64 {
        let gone = now - self.idle_began;
        let cap = if self.frames.is_empty() { IDLE_PERIOD_MAX_MS } else { FRAME_INTERVAL_MS };
        let timer = self.order.first().map_or(f64::INFINITY, |&(Due(due), _, _)| due - now);
        (cap - gone).min(timer).max(0.0)
    }
    // An idle request callback out of both lists: cancelled, or timed out.
    fn take_idle(&mut self, handle: u32) -> Option<IdleRequest> {
        for list in [&mut self.idle, &mut self.runnable] {
            if let Some(at) = list.iter().position(|r| r.handle == handle) {
                return list.remove(at);
            }
        }
        None
    }
}

impl RealmArena {
    // Realm `cid`'s timers — the one entered, or one parked — none for a realm it has no state of.
    fn timers_of(&mut self, cid: i32) -> Option<&mut Timers> {
        if cid == self.cur() {
            Some(&mut self.timers)
        } else {
            self.parked_state(cid).map(|s| &mut s.timers)
        }
    }
    // Realm `cid`'s timers gone — its context begun anew or dropped — and its tasks' keys with them: their handlers held
    // its global, which nothing else does once its frame or window is gone.
    pub(crate) fn drop_timers(&mut self, cid: i32) {
        if let Some(timers) = self.timers_of(cid) {
            *timers = Timers::default();
        }
        self.task_keys.realms.retain(|_, &mut c| c != cid);
    }
    // …or its context disposed: gone now, or as the step running in it ends (`stepping`) — and none taken after.
    pub(crate) fn discard_timers(&mut self, cid: i32) {
        self.task_keys.discarded.insert(cid);
        if !self.timers_of(cid).is_some_and(|t| t.stepping > 0) {
            self.drop_timers(cid);
        }
    }
    // …or begun anew, in a new context: it takes timers again.
    pub(crate) fn timers_begin(&mut self, cid: i32) {
        self.task_keys.discarded.remove(&cid);
        self.drop_timers(cid);
    }
    // Whether realm `cid`'s context is gone — dropped, or disposed — where nothing it holds may root it again.
    pub(crate) fn context_gone(&self, cid: i32) -> bool {
        self.is_dropped(cid) || self.task_keys.discarded.contains(&cid)
    }
    // Whether realm `cid` takes a timer: not one dropped, nor one disposed, but in a step still running in it.
    fn takes_timers(&mut self, cid: i32) -> bool {
        if self.is_dropped(cid) {
            return false;
        }
        !self.task_keys.discarded.contains(&cid) || self.timers_of(cid).is_some_and(|t| t.stepping > 0)
    }
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    register(scope, ns, "clockNow", clock_now, context_id);
    register(scope, ns, "clockTo", clock_to, context_id);
    register(scope, ns, "timerAdd", timer_add, context_id);
    register(scope, ns, "timerClear", timer_clear, context_id);
    register(scope, ns, "timerNext", timer_next, context_id);
    register(scope, ns, "realmPending", realm_pending, context_id);
    register(scope, ns, "timerNextDue", timer_next_due, context_id);
    register(scope, ns, "nextTimerDelay", next_timer_delay, context_id);
    register(scope, ns, "timerStep", timer_step, context_id);
    register(scope, ns, "timerTaskEnd", timer_task_end, context_id);
    register(scope, ns, "frameAdd", frame_add, context_id);
    register(scope, ns, "frameCancel", frame_cancel, context_id);
    register(scope, ns, "frameBegin", frame_begin, context_id);
    register(scope, ns, "frameNext", frame_next, context_id);
    register(scope, ns, "frameEnd", frame_end, context_id);
    register(scope, ns, "frameCount", frame_count, context_id);
    register(scope, ns, "idleAdd", idle_add, context_id);
    register(scope, ns, "idleTake", idle_take, context_id);
    register(scope, ns, "idleBegin", idle_begin, context_id);
    register(scope, ns, "idleNext", idle_next, context_id);
    register(scope, ns, "idleRemaining", idle_remaining, context_id);
}

// __dom.frameAdd(callback) -> its id: an animation frame callback of the calling realm's — none kept for a realm that
// takes no timers (`takes_timers`), which answers with an id all the same.
fn frame_add(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let callback = v8::Global::new(scope, args.get(0));
    let cid = realm_id(scope, &args);
    let arena = &mut dom(scope).arena;
    let takes = arena.takes_timers(cid);
    let timers = &mut arena.enter(cid).timers;
    timers.last_frame += 1;
    if takes {
        timers.frames.push_back((timers.last_frame, callback));
    }
    rv.set_uint32(timers.last_frame);
}

// __dom.frameCancel(id) — the calling realm's callback of that id cancelled, whether still to be run in this frame or
// in the next.
fn frame_cancel(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = args.get(0).uint32_value(scope) else { return };
    let cid = realm_id(scope, &args);
    let timers = &mut dom(scope).arena.enter(cid).timers;
    // (…both in the order of their ids, which only grow: the frame's leftovers, then those requested after it began)
    if let Ok(at) = timers.frames.binary_search_by_key(&id, |&(f, _)| f) {
        timers.frames.remove(at);
    } else if let Ok(at) = timers.running.binary_search_by_key(&id, |&(f, _)| f) {
        timers.running.remove(at);
    }
}

// __dom.frameBegin() -> how many callbacks the frame now beginning runs: those requested so far, taken — none where a
// frame is still running its own (a step a callback of it runs, nested), whose callbacks are its to run.
fn frame_begin(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    let timers = &mut dom(scope).arena.enter(cid).timers;
    if !timers.running.is_empty() {
        return rv.set_uint32(0);
    }
    let frame = std::mem::take(&mut timers.frames);
    timers.running.extend(frame);
    rv.set_uint32(timers.running.len() as u32);
}

// __dom.frameNext() -> the frame's next callback not cancelled, taken, or undefined once it has run them all.
fn frame_next(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    let Some((_, callback)) = dom(scope).arena.enter(cid).timers.running.pop_front() else { return };
    let callback = v8::Local::new(scope, callback);
    rv.set(callback);
}

// __dom.frameEnd() — the frame begun has ended: any of its callbacks not run — where something left its loop — go back
// before those requested since, to run in the next.
fn frame_end(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    let timers = &mut dom(scope).arena.enter(cid).timers;
    while let Some(left) = timers.running.pop_back() {
        timers.frames.push_front(left);
    }
}

// __dom.frameCount() -> how many callbacks the calling realm has requested for a frame to come.
fn frame_count(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    rv.set_uint32(dom(scope).arena.enter(cid).timers.frames.len() as u32);
}

// __dom.idleAdd(callback, timeout, timedOut) -> its handle: an idle request callback of the calling realm's
// (requestIdleCallback §5.2) — and, for a timeout, a task queued to run `timedOut(handle)` that long after — none kept
// for a realm that takes no timers (a removed frame's), which answers with a handle all the same.
fn idle_add(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let callback = v8::Global::new(scope, args.get(0));
    let timeout = args.get(1).number_value(scope).unwrap_or(0.0);
    let timed_out = v8::Global::new(scope, args.get(2));
    let cid = realm_id(scope, &args);
    let handle = {
        let timers = &mut dom(scope).arena.enter(cid).timers;
        timers.last_idle += 1;
        timers.last_idle
    };
    let handle_value: v8::Local<v8::Value> = v8::Integer::new_from_unsigned(scope, handle).into();
    let list: v8::Local<v8::Value> = v8::Array::new_with_elements(scope, &[handle_value]).into();
    let list = v8::Global::new(scope, list);
    let arena = &mut dom(scope).arena;
    if arena.takes_timers(cid) {
        let timeout = (timeout > 0.0).then(|| {
            arena.task_keys.last -= 1;
            let key = arena.task_keys.last;
            arena.task_keys.realms.insert(key, cid);
            let state = arena.enter(cid);
            let due = state.clock + timeout;
            state.timers.add(key, (timed_out, Some(list)), due, None, 0);
            key
        });
        arena.enter(cid).timers.idle.push_back(IdleRequest { handle, callback, timeout });
    }
    rv.set_uint32(handle);
}
// An idle request callback taken from its list — run, cancelled or timed out — its timeout's task gone with it.
fn taken_idle(arena: &mut RealmArena, cid: i32, request: IdleRequest) -> v8::Global<v8::Value> {
    if let Some(key) = request.timeout {
        arena.task_keys.realms.remove(&key);
        arena.enter(cid).timers.clear(key);
    }
    request.callback
}
// __dom.idleTake(handle) -> the calling realm's idle request callback of that handle, out of whichever list it is in
// (cancelled, or timed out), or undefined for one that ran or never was.
fn idle_take(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(handle) = args.get(0).uint32_value(scope) else { return };
    let cid = realm_id(scope, &args);
    let arena = &mut dom(scope).arena;
    let Some(request) = arena.enter(cid).timers.take_idle(handle) else { return };
    let callback = taken_idle(arena, cid, request);
    let callback = v8::Local::new(scope, callback);
    rv.set(callback);
}
// __dom.idleBegin() -> whether the idle period the calling realm's event loop begins now has a callback to run
// (`Timers::begin_idle`).
fn idle_begin(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    let state = dom(scope).arena.enter(cid);
    let now = state.clock;
    rv.set_bool(state.timers.begin_idle(now));
}
// __dom.idleNext() -> [handle, callback]: the idle period's next runnable callback, taken — undefined once there is none,
// or its deadline has passed (§5.5 "invoke idle callbacks": the rest wait for the next).
fn idle_next(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    let arena = &mut dom(scope).arena;
    let state = arena.enter(cid);
    if state.timers.idle_remaining(state.clock) <= 0.0 {
        return;
    }
    let Some(request) = state.timers.runnable.pop_front() else { return };
    let handle = request.handle;
    let callback = taken_idle(arena, cid, request);
    let handle = v8::Integer::new_from_unsigned(scope, handle).into();
    let callback = v8::Local::new(scope, callback);
    rv.set(v8::Array::new_with_elements(scope, &[handle, callback]).into());
}
// __dom.idleRemaining() -> what is left of the calling realm's idle period, as it stands (`Timers::idle_remaining`).
fn idle_remaining(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    let state = dom(scope).arena.enter(cid);
    let now = state.clock;
    rv.set_double(state.timers.idle_remaining(now));
}

// __dom.timerStep(begins) — an event loop step of the calling realm's begins, or ends: one ending in a realm whose
// context was disposed takes its timers with it (`discard_timers`).
fn timer_step(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let begins = args.get(0).is_true();
    let cid = realm_id(scope, &args);
    let arena = &mut dom(scope).arena;
    let Some(timers) = arena.timers_of(cid) else { return };
    if begins {
        timers.stepping += 1;
        return;
    }
    timers.stepping = timers.stepping.saturating_sub(1);
    if timers.stepping == 0 && arena.task_keys.discarded.contains(&cid) {
        arena.drop_timers(cid);
    }
}

// __dom.clockNow() -> the time the calling realm's clock reads.
fn clock_now(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    rv.set_double(dom(scope).arena.realm_state(cid).map_or(0.0, |s| s.clock));
}

// __dom.clockTo(time) — the calling realm's clock reads `time`: its event loop has reached it.
fn clock_to(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(time) = args.get(0).number_value(scope).filter(|t| t.is_finite()) else { return };
    let cid = realm_id(scope, &args);
    dom(scope).arena.enter(cid).clock = time;
}

// __dom.timerAdd(handler, args, timeout, repeats, task) -> its key: a timer of the calling realm's, falling due
// `timeout` ms after now on its clock — never, for one that is no finite time — and, `repeats`, again that long after
// each run: a page's (`task` false: a positive id), nested in the timer task running and clamped by its nesting
// level, or one the platform queues (`task` true: a negative key), which neither nests nor is clamped.
fn timer_add(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let handler = v8::Global::new(scope, args.get(0));
    let list = args.get(1);
    let list = (!list.is_null_or_undefined()).then(|| v8::Global::new(scope, list));
    let timeout = args.get(2).number_value(scope).unwrap_or(0.0);
    let repeats = args.get(3).is_true();
    let task = args.get(4).is_true();
    let cid = realm_id(scope, &args);
    let arena = &mut dom(scope).arena;
    let now = arena.enter(cid).clock;
    let takes = arena.takes_timers(cid);
    let nesting = if task { 0 } else { arena.timers_of(cid).and_then(|t| t.task_nesting).unwrap_or(0) };
    let timeout = if task { timeout } else { clamped(timeout, nesting) };
    let due = Some(now + timeout).filter(|d| d.is_finite()).unwrap_or(f64::MAX);
    let period = repeats.then_some(timeout);
    let key = if task {
        arena.task_keys.last -= 1;
        if takes {
            arena.task_keys.realms.insert(arena.task_keys.last, cid);
        }
        arena.task_keys.last
    } else {
        let timers = &mut arena.enter(cid).timers;
        timers.last_id += 1;
        timers.last_id
    };
    // (…a realm that takes none answers with a key all the same, which names nothing)
    if takes {
        arena.enter(cid).timers.add(key, (handler, list), due, period, if task { 0 } else { nesting + 1 });
    }
    rv.set_double(key as f64);
}

// __dom.timerClear(key) -> whether a timer was cleared: a page's of the calling realm's, or a task of whichever realm
// queued it.
fn timer_clear(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(key) = args.get(0).integer_value(scope) else { return rv.set_bool(false) };
    let caller = realm_id(scope, &args);
    let arena = &mut dom(scope).arena;
    let cid = if key < 0 { arena.task_keys.realms.remove(&key) } else { Some(caller) };
    let cleared = cid.and_then(|cid| arena.timers_of(cid)).is_some_and(|timers| timers.clear(key));
    rv.set_bool(cleared);
}

// __dom.timerTaskEnd() — the task the calling realm's last `timerNext` took has run: what runs next — its microtasks,
// each the running task of its own — is no timer task until another is taken.
fn timer_task_end(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    if let Some(timers) = dom(scope).arena.timers_of(cid) {
        timers.end_task();
    }
}

// __dom.timerNext(limit) -> `[due, handler, args]`: the calling realm's next timer, where it falls due by `limit` —
// taken from the list, one that repeats to be scheduled again as its task ends (`timerTaskEnd`); undefined for none. A
// page's is the timer task running from here, a platform task none. (A task a terminated handler never ended is ended
// here first.)
fn timer_next(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let limit = args.get(0).number_value(scope).unwrap_or(f64::INFINITY);
    let cid = realm_id(scope, &args);
    let arena = &mut dom(scope).arena;
    let now = arena.enter(cid).clock;
    let timers = &mut arena.enter(cid).timers;
    timers.end_task();
    let Some(&(Due(due), seq, key)) = timers.order.first().filter(|&&(Due(due), _, _)| due <= limit) else { return };
    timers.order.remove(&(Due(due), seq, key));
    let run = due.max(now);
    let repeats = timers.by_key.get(&key).and_then(|t| t.period);
    let (handler, list) = match repeats {
        Some(_) => {
            let Some(t) = timers.by_key.get(&key) else { return };
            timers.task_nesting = Some(t.nesting);
            timers.repeating = Some((key, run));
            (t.handler.clone(), t.args.clone())
        }
        None => {
            let Some(t) = timers.by_key.remove(&key) else { return };
            timers.task_nesting = (key > 0).then_some(t.nesting);
            arena.task_keys.realms.remove(&key);
            (t.handler, t.args)
        }
    };
    let due = v8::Number::new(scope, due).into();
    let handler = v8::Local::new(scope, handler);
    let list = list.map_or_else(|| v8::undefined(scope).into(), |l| v8::Local::new(scope, l));
    rv.set(v8::Array::new_with_elements(scope, &[due, handler, list]).into());
}

// __dom.realmPending(realm, subtree) -> whether realm `realm` (the calling one, for null) has work its event loop is to
// run — a timer, an animation frame or idle callback, an observation owed at its next rendering update
// (`GEN_OBSERVATIONS`), an autofocus candidate a flush is owed for, an animation that needs frames (`frames_due`) — and,
// with `subtree`, any realm of its child navigables does, theirs too: what keeps the driver stepping the page.
fn realm_pending(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let realm = if args.get(0).is_int32() { args.get(0).int32_value(scope).unwrap_or(0) } else { realm_id(scope, &args) };
    let subtree = args.get(1).is_true();
    rv.set_bool(pending(scope, realm, subtree));
}
fn pending(scope: &mut v8::PinScope<'_, '_>, realm: i32, subtree: bool) -> bool {
    let arena = &dom(scope).arena;
    if arena.is_dropped(realm) {
        return false;
    }
    let own = arena.realm_state(realm).is_some_and(|st| {
        !st.timers.frames.is_empty()
            || !st.timers.by_key.is_empty()
            || !st.timers.idle.is_empty()
            || !st.timers.runnable.is_empty()
            || st.generations.get(crate::dom::GEN_OBSERVATIONS) != 0
    });
    if own || arena.autofocus.pending_in(arena, realm) || crate::animation_ops::frames_due(scope, realm) {
        return true;
    }
    subtree && dom(scope).arena.child_realms(realm).into_iter().any(|child| pending(scope, child, true))
}

// __dom.nextTimerDelay() -> the time, on its clock, to the next work the calling realm's event loop has due — 0 for an
// animation frame callback requested, else its earliest timer's, or a frame an animation its style engine runs is due —
// and its frames', whose steps its own run (`drainChildRealms`), the earliest of them; -1 for none. What the host's
// fast-forward goes as far as, a far-future timer left parked.
fn next_timer_delay(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    let mut pending = vec![cid];
    let mut min = f64::INFINITY;
    while let Some(realm) = pending.pop() {
        let arena = &dom(scope).arena;
        if arena.is_dropped(realm) {
            continue;
        }
        let Some(state) = arena.realm_state(realm) else { continue };
        if !state.timers.frames.is_empty() {
            return rv.set_double(0.0);
        }
        if let Some(&(Due(due), _, _)) = state.timers.order.first() {
            min = min.min(due - state.clock);
        }
        pending.extend(arena.child_realms(realm));
        if let Some(delay) = crate::animation_ops::next_frame_delay_of(scope, realm) {
            min = min.min(delay);
        }
    }
    rv.set_double(if min == f64::INFINITY { -1.0 } else { min.max(0.0) });
}

// __dom.timerNextDue() -> when the calling realm's next timer falls due, or undefined for none.
fn timer_next_due(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    if let Some(&(Due(due), _, _)) = dom(scope).arena.enter(cid).timers.order.first() {
        rv.set_double(due);
    }
}
